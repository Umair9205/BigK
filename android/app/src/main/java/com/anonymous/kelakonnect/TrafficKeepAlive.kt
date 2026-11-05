package com.anonymous.kelakonnect

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.NetworkCapabilities
import android.net.TrafficStats
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.PortUnreachableException
import java.net.SocketTimeoutException
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

/**
 * Feeds Transsion's freezer a non-zero `isTrafficActive speed` so a listening
 * phone is not frozen ~5s after backgrounding.
 *
 * Round 19: battery exemption granted (unrestricted=true), frozen 13 s after
 * Home anyway, right after `isTrafficActive uid:<us> speed :0`.
 * Round 20 (v1): 1 Hz, one DNS query + one 1 KiB pad, Wi-Fi only. It started
 * and sent — `starting` 02:12:30, first send 02:12:31, Home 02:12:32 — and
 * the freezer still read `speed :0` at the decision (02:12:37) and froze.
 * Across the whole capture the metric only ever logs 0 or 1 for any uid: it
 * is quantised with a threshold of 1, and it did not count v1's ~6 KiB ramp
 * inside the 5 s it had.
 *
 * v2 answers all three surviving explanations at once:
 *  - **Long window / coarse unit**: BURST_PADS (16 KiB + 16 packets per
 *    second) for the first BURST_MS, so any window up to ~80 s already reads
 *    >=1 at the 5 s decision; SUSTAIN_PADS (2/s) holds >=1 for every later
 *    evaluation (screen-off pass, bump-end pass).
 *  - **RX-only counter**: TLS handshakes to anycast resolvers — the server's
 *    first flight is KBs of RX per attempt — during the burst, then one per
 *    SUSTAIN_TLS_EVERY ticks; DNS queries go to every resolver on the link
 *    plus 8.8.8.8/1.1.1.1 so a reply exists whenever any resolver answers.
 *  - **Silent send failure** (v1 announced only its first send): counters are
 *    logged every COUNTER_LOG_EVERY ticks with TrafficStats uid totals, so
 *    logcat shows exactly what left the phone and what came back, plus
 *    wifi=false when there was no interface to send on at all.
 *
 * Honest limits:
 *  - Wi-Fi only (TRANSPORT_WIFI; P2P groups report it too — there is no
 *    separate P2P transport constant). Metered cellular must not carry
 *    background junk.
 *  - No Wi-Fi interface up -> nothing to send on -> freeze proceeds (the
 *    walk-away case beyond AP range with no P2P group).
 *  - Sustain-phase handshakes cost a few MB per backgrounded hour. Fine for
 *    test builds; re-price before shipping if the counter proves RX-only.
 */
object TrafficKeepAlive {
    private const val TAG = "KeepAlive"
    /** Must beat the freezer's decision window (~5 s after backgrounding). */
    const val INTERVAL_MS = 1_000L
    /** >=1 KiB per pad so even an integer-KB/s reader cannot round us to 0. */
    private const val PAD_BYTES = 1024

    /** Phase 1: max volume for the first decision after the service starts. */
    private const val BURST_MS = 60_000L
    private const val BURST_PADS = 16
    private const val BURST_TLS = 5
    /** Phase 2: hold >=1 on any plausible unit for the rest of the session. */
    private const val SUSTAIN_PADS = 2
    private const val SUSTAIN_TLS_EVERY = 2
    private const val COUNTER_LOG_EVERY = 10L
    private const val TLS_CONNECT_TIMEOUT_MS = 400
    private const val TLS_READ_TIMEOUT_MS = 750
    private val TLS_TARGETS = arrayOf("1.1.1.1", "8.8.8.8")
    private val PUBLIC_DNS = arrayOf("8.8.8.8", "1.1.1.1")

    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    /** Separate thread: a TLS probe that times out must never stall the pads. */
    private val tlsExecutor = Executors.newSingleThreadExecutor()
    private val inFlight = AtomicBoolean(false)
    private val tlsInFlight = AtomicBoolean(false)
    private val tlsOk = AtomicLong()
    private val tlsFail = AtomicLong()

    @Volatile private var running = false
    @Volatile private var appContext: Context? = null
    @Volatile private var announced = false
    /** Process-lifetime socket: closing it races with an in-flight ping for
     *  no benefit — an idle UDP socket keeps nothing awake. */
    private var socket: DatagramSocket? = null

    private var startedAt = 0L
    private var ticks = 0L
    private var sent = 0L
    private var sendErr = 0L
    private var rxPkt = 0L
    private var tlsRotation = 0

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            submit()
            handler.postDelayed(this, INTERVAL_MS)
        }
    }

    fun start(context: Context) {
        appContext = context.applicationContext
        if (running) { handler.removeCallbacks(tick); handler.postDelayed(tick, INTERVAL_MS); return }
        running = true
        announced = false
        startedAt = SystemClock.elapsedRealtime()
        ticks = 0; sent = 0; sendErr = 0; rxPkt = 0
        tlsOk.set(0); tlsFail.set(0)
        android.util.Log.i(TAG, "starting; 1 Hz keep-alive over Wi-Fi only")
        handler.removeCallbacks(tick)
        handler.postDelayed(tick, INTERVAL_MS)
    }

    fun stop() {
        running = false
        handler.removeCallbacks(tick)
        android.util.Log.i(TAG, "stopped")
    }

    /** At most one ping queued: a stalled send (ARP on a sleeping AP) must
     *  not build a backlog behind the 1 Hz ticker. */
    private fun submit() {
        if (!inFlight.compareAndSet(false, true)) return
        executor.execute {
            try { ping() } finally { inFlight.set(false) }
        }
    }

    private fun submitTls(n: Int) {
        if (!tlsInFlight.compareAndSet(false, true)) return
        tlsExecutor.execute {
            try {
                for (i in 0 until n) {
                    if (!running) break
                    if (tlsProbe()) tlsOk.incrementAndGet() else tlsFail.incrementAndGet()
                }
            } finally { tlsInFlight.set(false) }
        }
    }

    /** The active network, but only when it is Wi-Fi. P2P groups report
     *  TRANSPORT_WIFI too; cellular stays excluded. */
    private fun activeWifi(): LinkProperties? {
        val context = appContext ?: return null
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return null
        val network = cm.activeNetwork ?: return null
        val caps = cm.getNetworkCapabilities(network) ?: return null
        if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return null
        return cm.getLinkProperties(network)
    }

    /** On-link gateway first (answers with the WAN down, and DNS usually *is*
     *  the router), then every non-loopback resolver on the link, then the
     *  public pair — a reply from any of them is RX for this UID. Loopback
     *  DNS (local resolver) would send on `lo`, which the radio never sees. */
    private fun dnsTargets(props: LinkProperties): List<InetAddress> {
        val out = LinkedHashSet<InetAddress>()
        props.routes.firstOrNull { it.destination.prefixLength == 0 }?.gateway?.let { out.add(it) }
        props.dnsServers.forEach { if (!it.isLoopbackAddress) out.add(it) }
        PUBLIC_DNS.forEach { out.add(InetAddress.getByName(it)) }
        return out.take(6)
    }

    private fun ping() {
        if (appContext == null) return
        if (!running) return
        ticks++
        var wifi = false
        try {
            val props = activeWifi()
            if (props != null) {
                wifi = true
                val targets = dnsTargets(props)
                val primary = targets.first()
                val s = socket ?: DatagramSocket().also {
                    it.soTimeout = 1
                    socket = it
                }
                val query = dnsQuery()
                var ok = false
                for (t in targets) {
                    try { s.send(DatagramPacket(query, query.size, t, 53)); sent++; ok = true } catch (_: Exception) { sendErr++ }
                }
                val burst = SystemClock.elapsedRealtime() - startedAt < BURST_MS
                val pads = if (burst) BURST_PADS else SUSTAIN_PADS
                for (i in 0 until pads) {
                    try { s.send(DatagramPacket(ByteArray(PAD_BYTES), PAD_BYTES, primary, 9)); sent++; ok = true } catch (_: Exception) { sendErr++ }
                }
                // A delivered reply already counted as RX for this UID at
                // delivery time; draining only keeps the buffer from filling.
                // ICMP unreachable from a closed pad port must not abort the
                // drain before the DNS replies behind it are read.
                try {
                    val buf = ByteArray(2048)
                    repeat(8) {
                        try { s.receive(DatagramPacket(buf, buf.size)); rxPkt++ } catch (_: PortUnreachableException) { }
                    }
                } catch (_: SocketTimeoutException) { } catch (_: Exception) { }
                if (ok && !announced) {
                    announced = true
                    android.util.Log.i(TAG, "sending to $primary over Wi-Fi")
                }
                val tls = if (burst) BURST_TLS else if (ticks % SUSTAIN_TLS_EVERY == 0L) 1 else 0
                if (tls > 0) submitTls(tls)
            }
        } catch (_: Exception) { /* no route: nothing to keep alive against */ }
        if (ticks % COUNTER_LOG_EVERY == 0L) {
            val uid = android.os.Process.myUid()
            val phase = if (SystemClock.elapsedRealtime() - startedAt < BURST_MS) "burst" else "sustain"
            android.util.Log.i(
                TAG, "n=$ticks sent=$sent err=$sendErr rxPkt=$rxPkt " +
                    "tlsOk=${tlsOk.get()} tlsFail=${tlsFail.get()} " +
                    "txB=${TrafficStats.getUidTxBytes(uid)} rxB=${TrafficStats.getUidRxBytes(uid)} " +
                    "phase=$phase wifi=$wifi"
            )
        }
    }

    /** Trust-all handshake: we want the server's flight (RX bytes), never the
     *  data. Fail fast — 400 ms connect, 750 ms read — so an offline LAN
     *  degrades to counted failures instead of a stalled ticker. */
    private fun tlsProbe(): Boolean = try {
        val s = sslFactory.createSocket() as SSLSocket
        s.use {
            tlsRotation = (tlsRotation + 1) % TLS_TARGETS.size
            it.connect(InetSocketAddress(TLS_TARGETS[tlsRotation], 443), TLS_CONNECT_TIMEOUT_MS)
            it.soTimeout = TLS_READ_TIMEOUT_MS
            it.startHandshake()
        }
        true
    } catch (_: Exception) { false }

    private val sslFactory by lazy {
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }), null)
        ctx.socketFactory
    }

    /** Minimal valid A/IN query for a unique label — any resolver answers. */
    private fun dnsQuery(): ByteArray {
        val label = UUID.randomUUID().toString().replace("-", "").take(16)
        val qname = ByteArray(label.length + 2)
        qname[0] = label.length.toByte()
        label.toByteArray(Charsets.US_ASCII).copyInto(qname, 1)
        val packet = ByteArray(12 + qname.size + 4)
        packet[0] = 0x6B; packet[1] = 0x37  // arbitrary ID
        packet[2] = 0x01                    // flags: recursion desired
        packet[5] = 0x01                    // QDCOUNT = 1
        qname.copyInto(packet, 12)
        val tail = 12 + qname.size
        packet[tail + 1] = 0x01             // QTYPE A
        packet[tail + 3] = 0x01             // QCLASS IN
        return packet
    }
}

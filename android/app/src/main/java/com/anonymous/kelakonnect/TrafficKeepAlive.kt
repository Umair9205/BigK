package com.anonymous.kelakonnect

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.SocketTimeoutException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Feeds Transsion's freezer a non-zero `isTrafficActive speed` so a listening
 * phone is not frozen ~5s after backgrounding.
 *
 * Round 19: the standard battery exemption was granted (unrestricted=true)
 * and the app was frozen 13 s after Home anyway, immediately after the
 * freezer logged `isTrafficActive uid:<us> speed :0`. Traffic — not the
 * exemption — is the lever that decides. This sends a 1 Hz keep-alive while
 * the availability service runs: one small valid DNS query (invites a reply,
 * so the UID sees RX as well as TX) plus one padded datagram (so any B/s or
 * KB/s reading of a 1 s window is non-zero).
 *
 * Honest limits:
 *  - Wi-Fi only (TRANSPORT_WIFI; P2P groups report it too). Metered
 *    cellular keeps the freezer's own rules and must not carry background
 *    junk.
 *  - With no Wi-Fi interface up (walking beyond AP range, no P2P group)
 *    there is nothing to send on; the freeze proceeds. The AP-connected
 *    case — which is where calls are answered — is the case this covers.
 *  - If the next log still shows `speed :0` with `KeepAlive` lines present,
 *    the counter wants a different unit or RX-only; tune from that evidence.
 */
object TrafficKeepAlive {
    private const val TAG = "KeepAlive"
    /** Must beat the freezer's decision window (~5 s after backgrounding). */
    const val INTERVAL_MS = 1_000L
    /** ≥1 KiB per tick so even an integer-KB/s reader cannot round us to 0. */
    private const val PAD_BYTES = 1024

    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private val inFlight = AtomicBoolean(false)

    @Volatile private var running = false
    @Volatile private var appContext: Context? = null
    @Volatile private var announced = false
    /** Process-lifetime socket: closing it races with an in-flight ping for
     *  no benefit — an idle UDP socket keeps nothing awake. */
    private var socket: DatagramSocket? = null

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

    private fun ping() {
        val context = appContext ?: return
        if (!running) return
        try {
            val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
            val network = cm.activeNetwork ?: return
            val caps = cm.getNetworkCapabilities(network) ?: return
            // Wi-Fi Direct groups also report TRANSPORT_WIFI (there is no
            // separate P2P transport constant); cellular stays excluded.
            if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return
            val props = cm.getLinkProperties(network) ?: return
            // On-link first: the gateway answers even with the WAN down, and
            // DNS usually *is* the router. Loopback DNS (local resolver) would
            // send on lo, which the radio never sees.
            val target = props.routes.firstOrNull { it.destination.prefixLength == 0 }?.gateway
                ?: props.dnsServers.firstOrNull { !it.isLoopbackAddress }
                ?: return
            val s = socket ?: DatagramSocket().also {
                it.soTimeout = 1
                socket = it
            }
            val query = dnsQuery()
            var sent = false
            try { s.send(DatagramPacket(query, query.size, target, 53)); sent = true } catch (_: Exception) {}
            try { s.send(DatagramPacket(ByteArray(PAD_BYTES), PAD_BYTES, target, 9)); sent = true } catch (_: Exception) {}
            // A delivered reply already counted as RX for this UID at delivery
            // time; draining only keeps the receive buffer from filling.
            try {
                val buf = ByteArray(2048)
                repeat(8) { s.receive(DatagramPacket(buf, buf.size)) }
            } catch (_: SocketTimeoutException) { } catch (_: Exception) { }
            if (sent && !announced) {
                announced = true
                android.util.Log.i(TAG, "sending to $target over Wi-Fi")
            }
        } catch (_: Exception) { /* no route: nothing to keep alive against */ }
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

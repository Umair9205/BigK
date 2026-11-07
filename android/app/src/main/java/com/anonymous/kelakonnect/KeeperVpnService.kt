package com.anonymous.kelakonnect

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Keeper tunnel (Nov 6) and local call relay (Nov 8).
 *
 * XOS's Usf_Hiber exempts the package that owns the active VPN
 * ("importantScene: VPN") in every screen state — the only freeze exemption
 * measured to survive screen-off and the lock screen. Android allows exactly
 * one VPN owner, so this service deliberately defers to any other active VPN
 * (e.g. Cloudflare WARP) instead of replacing it: stealing the tunnel would
 * break the user's VPN, and the freezer follows the owner anyway.
 *
 * The tunnel is not a shim. Its virtual subnet is the call relay endpoint:
 * [DirectControlSocket] binds/connects inside [VIRTUAL_LOCAL]/[VIRTUAL_PEER],
 * this service terminates that connection and forwards the bytes to the real
 * Wi-Fi Direct peer over a `protect()`ed socket (and the reverse for the
 * callee). Signalling therefore traverses the VPN service on every call that
 * starts while the keeper tunnel is established. Audio stays peer-to-peer on
 * the Wi-Fi Direct link (WebRTC host candidates are filtered on the real P2P
 * address in DirectCallAudio).
 *
 * No DNS and no default route are added; only [VIRTUAL_ROUTE] is routed, so
 * traffic that is not part of the relay is untouched. When another VPN owns
 * the slot this service stays down and [DirectWifiModule] falls back to the
 * real P2P addresses.
 */
class KeeperVpnService : VpnService() {
    companion object {
        /** Tun address the app binds as the source of a relayed client call. */
        const val VIRTUAL_LOCAL = "10.111.222.1"
        /** Virtual peer the app connects to / listens on inside the relay. */
        const val VIRTUAL_PEER = "10.111.222.2"
        private const val VIRTUAL_ROUTE = "10.111.222.0"
        /** Port the app uses inside the virtual subnet. */
        const val APP_PORT = 9876
        /** Real port the other phone's app listens on. */
        const val PEER_PORT = 9875

        @Volatile private var fd: ParcelFileDescriptor? = null
        @Volatile private var instance: KeeperVpnService? = null
        @Volatile private var relay: RelayJob? = null
        @Volatile var established = false
            private set
        @Volatile private var lastOtherVpn: Boolean? = null
        @Volatile private var lastRevokeMs: Long = 0L
        /** After the system revokes the keeper tunnel (another VPN took over,
         *  e.g. Cloudflare WARP) the retry window backs off so a racing
         *  reconnect cannot immediately kick the new owner back. */
        private const val REVOKE_COOLDOWN_MS = 30_000L

        /** True when a VPN we do not own is connected. */
        fun anotherVpnActive(context: Context): Boolean {
            if (fd != null) return false // the active VPN is ours
            return try {
                val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
                cm.allNetworks.any { network ->
                    val caps = cm.getNetworkCapabilities(network) ?: return@any false
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                }
            } catch (e: Exception) {
                false
            }
        }

        /** Called from the availability watchdog every 5 s. */
        fun sync(context: Context) {
            if (android.os.SystemClock.elapsedRealtime() - lastRevokeMs < REVOKE_COOLDOWN_MS) return
            if (anotherVpnActive(context)) {
                if (lastOtherVpn != true) {
                    lastOtherVpn = true
                    android.util.Log.i("KeeperVpn", "Another VPN owns the tunnel; keeper idle (will not override)")
                }
                return
            }
            if (lastOtherVpn == true) {
                lastOtherVpn = false
                android.util.Log.i("KeeperVpn", "No other VPN active; keeper tunnel may start")
            }
            if (fd != null) return
            try {
                context.startService(Intent(context, KeeperVpnService::class.java))
            } catch (e: Exception) {
                android.util.Log.w("KeeperVpn", "startService failed", e)
            }
        }

        /**
         * Point the relay at the current call. Returns true when the virtual
         * endpoint is live, in which case the caller must use
         * [VIRTUAL_LOCAL]/[VIRTUAL_PEER]: [APP_PORT] instead of the real P2P
         * address and [PEER_PORT]. Returns false when the keeper tunnel is not
         * ours (another VPN, consent pending) so the call can use the direct
         * path unchanged.
         *
         * @param caller true for the dialing phone (app connects, relay dials
         *               the peer); false for the callee (relay listens on the
         *               real P2P address, app listens on the virtual peer).
         */
        fun configureRelay(caller: Boolean, localIp: String, peerIp: String): Boolean {
            val service = instance ?: return false
            if (!established) return false
            relay?.stop(hard = true)
            relay = null
            val job = RelayJob(service, caller, localIp, peerIp)
            if (!job.start()) {
                job.stop(hard = true)
                return false
            }
            relay = job
            return true
        }

        /** Stop accepting new relayed connections. In-flight bytes drain; the
         *  job force-closes its sockets after a short grace so a call that
         *  never closes its side cannot hold the endpoint forever. */
        fun clearRelay() {
            relay?.stop(hard = false)
            relay = null
        }

        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, KeeperVpnService::class.java))
            } catch (_: Exception) {
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (fd != null) return START_STICKY
        if (android.os.SystemClock.elapsedRealtime() - lastRevokeMs < REVOKE_COOLDOWN_MS) return START_NOT_STICKY
        if (anotherVpnActive(this)) {
            android.util.Log.i("KeeperVpn", "Another VPN owns the tunnel; not establishing")
            return START_NOT_STICKY
        }
        try {
            if (prepare(this) != null) {
                android.util.Log.i("KeeperVpn", "Waiting for one-time VPN consent (dialog in the app)")
                return START_NOT_STICKY // the availability watchdog retries every 5 s
            }
            val tunnel = Builder()
                .setSession("BigK local call relay")
                .setMtu(1400)
                .addAddress(VIRTUAL_LOCAL, 32)
                .addAddress(VIRTUAL_PEER, 32)
                .addRoute(VIRTUAL_ROUTE, 24)
                .addAllowedApplication(packageName)
                .establish()
            fd = tunnel
            established = tunnel != null
            android.util.Log.i(
                "KeeperVpn",
                if (tunnel != null) "Keeper relay tunnel established ($VIRTUAL_LOCAL/$VIRTUAL_PEER, route $VIRTUAL_ROUTE/24, app=$packageName)"
                else "establish() returned null"
            )
            if (tunnel != null) return START_STICKY
        } catch (e: Exception) {
            android.util.Log.w("KeeperVpn", "establish failed", e)
        }
        return START_NOT_STICKY
    }

    override fun onRevoke() {
        android.util.Log.i("KeeperVpn", "Tunnel revoked by the system or another VPN")
        lastRevokeMs = android.os.SystemClock.elapsedRealtime()
        close()
        super.onRevoke()
    }

    override fun onDestroy() {
        android.util.Log.i("KeeperVpn", "Service destroyed (established=$established)")
        close()
        if (instance === this) instance = null
        super.onDestroy()
    }

    private fun close() {
        relay?.stop(hard = true)
        relay = null
        val current = fd ?: return
        fd = null
        established = false
        try {
            current.close()
        } catch (_: Exception) {
        }
    }

    /**
     * One bridge generation. A new call replaces the previous job; the old
     * listener is closed first so a stale port can never swallow the next
     * call's connection.
     */
    private class RelayJob(
        private val service: KeeperVpnService,
        private val caller: Boolean,
        private val localIp: String,
        private val peerIp: String,
    ) {
        @Volatile private var running = true
        @Volatile private var server: ServerSocket? = null
        private val sockets: MutableSet<Socket> =
            Collections.newSetFromMap(ConcurrentHashMap<Socket, Boolean>())
        private val bytes = AtomicLong()

        fun start(): Boolean {
            val bind = try {
                InetAddress.getByName(if (caller) VIRTUAL_PEER else localIp)
            } catch (e: Exception) {
                android.util.Log.w("KeeperVpn", "relay address invalid: ${if (caller) VIRTUAL_PEER else localIp}", e)
                return false
            }
            val port = if (caller) APP_PORT else PEER_PORT
            return try {
                val listener = ServerSocket()
                listener.reuseAddress = true
                listener.bind(InetSocketAddress(bind, port))
                server = listener
                Thread({ acceptLoop(listener) }, "bigk-relay-listen").start()
                Thread({ logLoop() }, "bigk-relay-log").start()
                android.util.Log.i(
                    "KeeperVpn",
                    if (caller) "relay ready: app $VIRTUAL_LOCAL -> $VIRTUAL_PEER:$APP_PORT => peer $peerIp:$PEER_PORT"
                    else "relay ready: peer $localIp:$PEER_PORT => app $VIRTUAL_PEER:$APP_PORT"
                )
                true
            } catch (e: Exception) {
                android.util.Log.w("KeeperVpn", "relay bind failed on $bind:$port", e)
                false
            }
        }

        fun stop(hard: Boolean) {
            running = false
            closeQuietly(server)
            server = null
            if (hard) {
                closeAll()
            } else {
                // The app closes its side on hangup; give those bytes time to
                // reach the peer before force-closing the bridge.
                val snapshot = sockets.toList()
                Thread({
                    try { Thread.sleep(3_000) } catch (_: InterruptedException) {}
                    snapshot.forEach { closeQuietly(it) }
                }, "bigk-relay-drain").start()
            }
        }

        private fun acceptLoop(listener: ServerSocket) {
            while (running) {
                val inbound = try {
                    listener.accept()
                } catch (e: Exception) {
                    if (running) android.util.Log.w("KeeperVpn", "relay accept failed: ${e.javaClass.simpleName}")
                    break
                }
                sockets.add(inbound)
                Thread({ bridge(inbound) }, "bigk-relay-bridge").start()
            }
        }

        private fun bridge(inbound: Socket) {
            var outbound: Socket? = null
            try {
                outbound = if (caller) connectPeer() else connectApp()
                sockets.add(outbound)
                android.util.Log.i("KeeperVpn", "relay bridged (caller=$caller peer=$peerIp)")
                val up = Thread({ copy(inbound, outbound) }, "bigk-relay-up")
                val down = Thread({ copy(outbound, inbound) }, "bigk-relay-down")
                up.start(); down.start(); up.join(); down.join()
            } catch (e: Exception) {
                android.util.Log.w("KeeperVpn", "relay bridge failed (caller=$caller peer=$peerIp): ${e.message}")
            } finally {
                closeQuietly(inbound)
                closeQuietly(outbound)
                sockets.remove(inbound)
                if (outbound != null) sockets.remove(outbound)
            }
        }

        /** Client role: dial the real phone. protect() keeps this socket out
         *  of our own tunnel; the destination is on the P2P link, so routing
         *  never falls back to the mobile default network. */
        private fun connectPeer(): Socket {
            val deadline = SystemClock.elapsedRealtime() + 8_000
            var last: Exception? = null
            while (running && SystemClock.elapsedRealtime() < deadline) {
                val socket = Socket()
                try {
                    if (!service.protect(socket)) android.util.Log.w("KeeperVpn", "protect() failed for relay peer socket")
                    socket.bind(InetSocketAddress(InetAddress.getByName(localIp), 0))
                    socket.connect(InetSocketAddress(InetAddress.getByName(peerIp), PEER_PORT), 1_500)
                    return socket
                } catch (e: Exception) {
                    last = e
                    closeQuietly(socket)
                    pause()
                }
            }
            throw IOException("peer $peerIp:$PEER_PORT unreachable", last)
        }

        /** Callee role: connect to the app's listener inside the virtual
         *  subnet. The app may still be binding, so retry briefly. */
        private fun connectApp(): Socket {
            val deadline = SystemClock.elapsedRealtime() + 8_000
            var last: Exception? = null
            while (running && SystemClock.elapsedRealtime() < deadline) {
                val socket = Socket()
                try {
                    socket.connect(InetSocketAddress(InetAddress.getByName(VIRTUAL_PEER), APP_PORT), 1_500)
                    return socket
                } catch (e: Exception) {
                    last = e
                    closeQuietly(socket)
                    pause()
                }
            }
            throw IOException("app listener $VIRTUAL_PEER:$APP_PORT unreachable", last)
        }

        private fun copy(from: Socket, to: Socket) {
            val buffer = ByteArray(16 * 1024)
            try {
                val input = from.getInputStream()
                val output = to.getOutputStream()
                while (running) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    output.write(buffer, 0, n)
                    output.flush()
                    bytes.addAndGet(n.toLong())
                }
            } catch (_: Exception) {
            } finally {
                try { to.shutdownOutput() } catch (_: Exception) {}
            }
        }

        private fun logLoop() {
            var last = -1L
            while (running) {
                try { Thread.sleep(5_000) } catch (_: InterruptedException) { break }
                val now = bytes.get()
                if (now != last) {
                    android.util.Log.i("KeeperVpn", "relay carried $now bytes (caller=$caller peer=$peerIp)")
                    last = now
                }
            }
        }

        private fun pause() {
            try { Thread.sleep(120) } catch (_: InterruptedException) {}
        }

        private fun closeAll() {
            val snapshot = sockets.toList()
            sockets.clear()
            snapshot.forEach { closeQuietly(it) }
        }

        private fun closeQuietly(socket: Socket?) {
            try { socket?.close() } catch (_: Exception) {}
        }

        private fun closeQuietly(listener: ServerSocket?) {
            try { listener?.close() } catch (_: Exception) {}
        }
    }
}

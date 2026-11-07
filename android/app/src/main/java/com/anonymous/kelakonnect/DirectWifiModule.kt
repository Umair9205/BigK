package com.anonymous.kelakonnect

import android.content.*
import android.content.pm.PackageManager
import android.media.*
import android.net.MacAddress
import android.net.wifi.WifiManager
import android.net.wifi.WpsInfo
import android.net.wifi.p2p.*
import android.os.*
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.*
import java.net.*
import java.security.SecureRandom
import java.util.concurrent.Executors

/** Owns one app-created P2P group. TCP is authenticated control only; WebRTC carries audio. */
class DirectWifiModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    companion object {
        @Volatile var radioReleased = true
            private set
        // Two-sided negotiate connect: both phones call connect() with
        // complementary GO intents, so the callee deterministically hosts the
        // group. The framework owns find/negotiation/credentials internally.
        private const val CALLER_GO_INTENT = 0
        private const val CALLEE_GO_INTENT = 15
        // The placeholder that can never be a real device address; it must
        // never travel in a signal or reach connect(), which would mean
        // "connect to anyone". Today's only source is the peer list, so this is
        // a belt-and-braces guard rather than a value anyone produces.
        private const val MAC_ANY_ADDRESS = "02:00:00:00:00:00"
        // The peer read is the app's first P2P operation of the process, so it
        // must stand alone: Wi-Fi is brought up first (ensureWifi), discovery
        // is kicked, then the peer list is polled long enough for a cold stack
        // to surface the other phone. Neither side ever reads its own address —
        // requestDeviceInfo answers the placeholder forever and p2p0 never
        // becomes readable — but requestPeers() returns the peer's on both
        // test devices, and that is exactly what connect() needs.
        private const val ADDRESS_WAIT_MS = 12000L
        private const val ADDRESS_POLL_MS = 250L
        private const val ADDRESS_ATTEMPTS = 48
        // Some OEM stacks accept connect() but never re-drive their own find
        // when the peer's group appears later. Re-issue while unformed; a
        // stack mid-formation answers BUSY (absorbed in retryBusy).
        private const val CONNECT_REFRESH_MS = 3000L
        private const val MAX_CONNECT_REFRESHES = 8
        // Android 10+ refuses the silent Wi-Fi enable for targetSdk >= 29, so the
        // system panel gets this long to be toggled before the call gives up.
        private const val WIFI_ENABLE_WAIT_MS = 12000L
        // A closing link releases its group over ~12s worst case (grace + poll).
        // Wait that out instead of bouncing the user back to retry by hand.
        private const val BUSY_WAIT_ATTEMPTS = 300
        // Group release polls at 250ms. The 1500ms "stably gone" confirmation
        // needs ~6 polls AFTER the group already died, so the budget has to cover
        // both the wait-for-death and the confirmation. At 28 a group dying on
        // poll 23 was rejected at poll 28 while still 250ms short of confirming.
        private const val GROUP_RELEASE_ATTEMPTS = 36
        /** The STA band in use right now. P2P discovery and our 2.4GHz group
         *  both have to share the radio with whatever this is, so it is the one
         *  number that explains a residual "no peers seen" tail. */
        private fun bandOf(freq: Int) = when {
            freq <= 0 -> "unknown"
            freq < 3000 -> "2.4GHz"
            freq < 5925 -> "5GHz"
            else -> "6GHz"
        }
        /** A standalone Wi-Fi Direct discovery read, used to measure the radio
         *  rather than to drive a call. Its own manager and channel so it can
         *  never disturb the call path, and skipped entirely while a call's
         *  group is up — discovery kicks during teardown reset peer state the
         *  cleanup depends on. */
        fun probePeerRadio(context: Context, tag: String) {
            if (!radioReleased) return
            try {
                val app = context.applicationContext
                val p2p = app.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager ?: return
                val wifi = app.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                val freq = try { wifi?.connectionInfo?.frequency ?: -1 } catch (_: Exception) { -1 }
                Log.i("P2PProbe", "[$tag] staFreq=$freq band=${bandOf(freq)}")
                val channel = p2p.initialize(app, Looper.getMainLooper(), null) ?: return
                p2p.discoverPeers(channel, null)
                p2p.requestPeers(channel) { list ->
                    val peers = (list?.deviceList ?: emptyList()).toList()
                    Log.i("P2PProbe", "[$tag] peers=${peers.size}" +
                        (if (peers.isEmpty()) "" else " " + peers.joinToString("; ") { "${it.deviceName}|${it.deviceAddress}|${it.status}" }))
                }
            } catch (e: Exception) { Log.w("P2PProbe", "[$tag] probe failed", e) }
        }
    }
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newCachedThreadPool()
    private val writes = Executors.newSingleThreadExecutor()
    private val manager get() = context.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
    private var channel: WifiP2pManager.Channel? = null
    private val wifiState get() = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    // Main-thread only: waiters queue behind the system Wi-Fi panel.
    private val wifiWaits = mutableListOf<WifiEnableWait>()
    private var wifiPanelOpen = false
    @Volatile private var run: Run? = null
    private var stopping = false
    private var lifecycleEpoch = 0
    private var focus: AudioFocusRequest? = null
    private val audio get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private class Run(val id: String, val caller: Boolean, val token: String, val promise: Promise) {
        @Volatile var live = true
        @Volatile var socket: Socket? = null
        @Volatile var server: ServerSocket? = null
        @Volatile var writer: BufferedWriter? = null
        var requested = false
        var operationPending = false
        var cancelSettled = false
        var absentSince = 0L
        var socketStarted = false
        var settled = false
        var group: WifiP2pGroup? = null
        // Intent split expects the callee to host; the framework's own
        // readback (requestConnectionInfo) assigns the real role before use.
        @Volatile var owner = !caller
        var config: WifiP2pConfig? = null
        var peerAddress: String = ""
        var networkName: String? = null
        var lastConnectAt = 0L
        var connectRefreshes = 0
        val createdAt = SystemClock.elapsedRealtime()
        var stopStartedAt = 0L
        val health = DirectLinkHealth()
        var queryPending = false
        var queryScheduled = false
        @Volatile var phase = "releasing-nearby"
    }
    override fun getName() = "DirectWifiModule"
    private fun current(r: Run) = r.live && run === r
    private fun randomHex(size: Int): String {
        val bytes = ByteArray(size); SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    }
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            if (intent.action == WifiManager.WIFI_STATE_CHANGED_ACTION &&
                intent.getIntExtra(WifiManager.EXTRA_WIFI_STATE, WifiManager.WIFI_STATE_UNKNOWN) == WifiManager.WIFI_STATE_ENABLED) {
                // The silent enable or the system panel landed: every queued
                // call resumes from here with no further user interaction.
                val waits = wifiWaits.toList(); wifiWaits.clear()
                waits.forEach { it.finish(true) }
                return
            }
            if (intent.action == WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION &&
                intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1) == WifiP2pManager.WIFI_P2P_STATE_DISABLED) {
                radioReleased = true
            }
            if (intent.action == WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION &&
                intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1) == WifiP2pManager.WIFI_P2P_STATE_ENABLED &&
                run == null && !stopping && radioReleased) NearbyTransport.get(context).recoverAfterRadioReset()
            val r = run ?: return
            if (intent.action == WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION) queryGroup(r)
            if (intent.action == WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION &&
                intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1) == WifiP2pManager.WIFI_P2P_STATE_DISABLED)
                fail(r, "Wi-Fi was turned off")
        }
    }
    /** One queued "enable Wi-Fi, then continue" continuation. Settled exactly
     *  once: by the WIFI_STATE_ENABLED broadcast, or by the deadline. */
    private inner class WifiEnableWait(private val then: (Boolean) -> Unit) {
        private var settled = false
        private val deadline = Runnable { finish(false) }
        fun await(openPanel: Boolean) {
            main.postDelayed(deadline, WIFI_ENABLE_WAIT_MS)
            wifiWaits.add(this)
            if (!openPanel || wifiPanelOpen) return
            // Google's sanctioned replacement for the blocked setWifiEnabled():
            // the system Wi-Fi panel. One OS toggle lands, the broadcast resumes.
            try {
                context.startActivity(Intent(Settings.Panel.ACTION_WIFI).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                wifiPanelOpen = true
                android.util.Log.i("DirectWifi", "Wi-Fi is off; opened the system Wi-Fi panel so the call can continue")
            } catch (e: Exception) {
                android.util.Log.i("DirectWifi", "system Wi-Fi panel unavailable: ${e.message}")
            }
        }
        fun finish(ok: Boolean) {
            if (settled) return
            settled = true
            main.removeCallbacks(deadline)
            wifiWaits.remove(this)
            if (wifiWaits.isEmpty()) wifiPanelOpen = false
            android.util.Log.i("DirectWifi", if (ok) "Wi-Fi is on; resuming call setup" else "Wi-Fi stayed off through the enable wait")
            then(ok)
        }
    }
    /** Wi-Fi must be up before the P2P stack answers. Try the silent enable
     *  (works pre-Android 10), then fall back to the system panel and resume
     *  from its broadcast — no error ever tells the user to toggle settings. */
    private fun ensureWifi(then: (Boolean) -> Unit) {
        val wm = wifiState
        if (wm == null) { then(false); return }
        if (wm.isWifiEnabled) { then(true); return }
        try { wm.isWifiEnabled = true } catch (_: Exception) {}
        if (wm.isWifiEnabled) { then(true); return }
        if (Build.VERSION.SDK_INT < 29) { then(false); return }
        // ENABLING means someone already started it; the broadcast will land
        // without asking anyone to touch the panel again.
        val enabling = wm.wifiState == WifiManager.WIFI_STATE_ENABLING
        main.post {
            if (wm.isWifiEnabled) then(true)
            else WifiEnableWait(then).await(openPanel = !enabling)
        }
    }
    override fun initialize() {
        super.initialize()
        ensureChannel()
        context.registerReceiver(receiver, IntentFilter().apply {
            addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
            addAction(WifiManager.WIFI_STATE_CHANGED_ACTION)
        })
    }
    /** The service drops its channel when Wi-Fi cycles (including our own
     *  enable). Reopen it here instead of demanding an app restart. Only the
     *  channel this call created may be cleared — a late callback from an old
     *  channel never nulls a newer one. */
    private fun ensureChannel(): WifiP2pManager.Channel? {
        channel?.let { return it }
        val m = manager ?: return null
        var opened: WifiP2pManager.Channel? = null
        opened = m.initialize(context, Looper.getMainLooper()) {
            run?.let { fail(it, "Wi-Fi Direct service disconnected") }
            if (channel === opened) channel = null
        }
        channel = opened
        return opened
    }
    private fun begin(id: String, caller: Boolean, token: String, promise: Promise, attempt: Int = 0, epoch: Int = lifecycleEpoch, action: (Run) -> Unit) {
        main.post {
            try {
                check(epoch == lifecycleEpoch) { "Call cancelled while the previous link was closing" }
                // Wait out a link that is still closing (or a run that is still
                // live) instead of bouncing the user back to retry by hand.
                if (attempt < BUSY_WAIT_ATTEMPTS && (stopping || run != null)) {
                    main.postDelayed({ begin(id, caller, token, promise, attempt + 1, epoch, action) }, 50)
                    return@post
                }
                check(Build.VERSION.SDK_INT >= 29) { "Automatic direct calling requires Android 10 or newer" }
                check(context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)) { "Wi-Fi Direct is unsupported" }
                check(run == null) { "Another Wi-Fi Direct call is still active" }
                check(!stopping) { "The previous Wi-Fi link is still closing" }
                check(ensureChannel() != null) { "Wi-Fi Direct is unavailable" }
                require(id.matches(Regex("[a-zA-Z0-9-]{1,100}")) && token.matches(Regex("[a-f0-9]{64}")))
                // Wi-Fi may have been switched off since the address was read;
                // bring it back up before the run starts.
                ensureWifi { enabled ->
                    if (!enabled) { promise.reject("WIFI_SETUP", "Wi-Fi is off"); return@ensureWifi }
                    main.post {
                        try {
                            check(epoch == lifecycleEpoch) { "Call cancelled while the previous link was closing" }
                            check(run == null && !stopping) { "The previous Wi-Fi link is still closing" }
                            check(ensureChannel() != null) { "Wi-Fi Direct is unavailable" }
                            val r = Run(id, caller, token, promise); run = r
                            waitForBootstrapRelease(r, action = action)
                            main.postDelayed({ if (current(r) && r.writer == null) fail(r, "Direct Wi-Fi setup timed out at ${r.phase}") }, 30000)
                        } catch (e: Exception) { promise.reject("WIFI_SETUP", e.message) }
                    }
                }
            } catch (e: Exception) { promise.reject("WIFI_SETUP", e.message) }
        }
    }
    /** The gate before connect(). requestGroupInfo only ever answers for a group
     *  THIS phone is already a member of, and the call path forms no group
     *  before connect() — so anything it finds is a leftover. Our own old
     *  address path called createGroup() and no run ever removed the result:
     *  log_bigk_SM_10 has escalate()'s own stack trace opening the owner group
     *  DIRECT-lN-SM-A105F at 18:39:19 with no P2P-GROUP-REMOVED after it, and
     *  MdxKitService still reading that same group back at 20:48. Round 7 then
     *  died waiting 7s for something nobody was ever coming to delete. Nearby's
     *  release IS asynchronous, so it keeps a short grace; after that an IDLE
     *  group is cleared by us — clients==0, which a link carrying another app's
     *  traffic never is — because a phone still inside a group cannot take the
     *  call the user just pressed. If it still will not go, start anyway: an
     *  unremovable group gives connect() a real reason to report, which is far
     *  more use than a silent timeout, and a call must never dead-end here. */
    private fun waitForBootstrapRelease(r: Run, attempt: Int = 0, action: (Run) -> Unit) {
        if (!current(r)) return
        try {
            manager!!.requestGroupInfo(channel) { group ->
                if (!current(r)) return@requestGroupInfo
                if (group == null) {
                    android.util.Log.i("NearbyHandoff", "session=${r.id} P2P released; starting app-owned link")
                    try { action(r) } catch (e: Exception) { fail(r, e.message ?: "Wi-Fi setup failed") }
                } else if (attempt < 20) {
                    val clients = group.clientList?.size ?: 0
                    if (attempt == 0) android.util.Log.i(
                        "NearbyHandoff",
                        "session=${r.id} waiting for previous P2P link to release " +
                            "owner=${group.owner?.deviceAddress ?: "unknown"} " +
                            "role=${if (group.isGroupOwner) "owner" else "client"} " +
                            "network=${group.networkName ?: "unknown"} clients=$clients"
                    )
                    // ONLY a group this phone OWNS may ever be removed. `clients == 0`
                    // on its own is worthless on a phone that is a CLIENT: requestGroupInfo
                    // cannot see the owner's member list from there, so clientList is
                    // empty and the test is always true. It protected nothing - and the
                    // group a client sees at this gate is usually the one the CURRENT
                    // call just formed: the callee (CALLEE_GO_INTENT=15) creates it and
                    // the caller's own connect() has already joined it, so the caller was
                    // deleting the call in progress. Round 9: log_bigk_SM_13 logged
                    // role=client clients=0 -> clearing at 23:36:32.837, and 5s later
                    // log_bigk_infinix_13 saw P2P-GROUP-REMOVED p2p0 GO reason=REQUESTED,
                    // which killed the callee's bound listener (SocketException, then
                    // BindException because 192.168.49.1 was gone) and ended the call.
                    // The round-6 leftover was role=owner clients=0, which this still clears.
                    if (attempt == 3 || attempt == 10) {
                        if (group.isGroupOwner && clients == 0) {
                            android.util.Log.i("NearbyHandoff", "session=${r.id} clearing the idle leftover P2P group this phone owns")
                            try { manager?.removeGroup(channel, null) } catch (_: Exception) {}
                        } else android.util.Log.w("NearbyHandoff", "session=${r.id} leaving the previous P2P link alone (role=${if (group.isGroupOwner) "owner" else "client"} clients=$clients)")
                    }
                    main.postDelayed({ waitForBootstrapRelease(r, attempt + 1, action) }, 100L)
                } else {
                    android.util.Log.w("NearbyHandoff", "session=${r.id} previous P2P link never released; starting app-owned link anyway")
                    try { action(r) } catch (e: Exception) { fail(r, e.message ?: "Wi-Fi setup failed") }
                }
            }
        } catch (e: Exception) { fail(r, e.message ?: "Could not check the previous Wi-Fi link") }
    }
    @ReactMethod fun prepareCallGroup(promise: Promise) {
        // Only the control-socket token is planned here. The group credentials
        // themselves are negotiated by the framework. Never log this value.
        promise.resolve(Arguments.createMap().apply { putString("token", randomHex(32)) })
    }
    /** The PEER's P2P device address, read from Wi-Fi Direct discovery.
     *  Neither phone can read its OWN address on this hardware:
     *  requestDeviceInfo answers 02:00:00:00:00:00 forever, p2p0 never becomes
     *  readable, and createGroup is refused P2P_UNSUPPORTED at every timing and
     *  with discovery running. requestPeers() returns the OTHER phone's address,
     *  and both sides need exactly that — so no local read happens at all. */
    @ReactMethod fun getPeerP2pAddress(expected: ReadableArray, promise: Promise) {
        main.post {
            try {
                // First Wi-Fi touch of the handoff: discovery cannot run while
                // Wi-Fi is off, and the user only ever presses Call.
                ensureWifi { enabled ->
                    if (!enabled) { promise.reject("P2P_PEER_ADDRESS", "Wi-Fi is off"); return@ensureWifi }
                    main.post { pollPeerAddress(expected, promise) }
                }
            } catch (e: Exception) { promise.reject("P2P_PEER_ADDRESS", e.message) }
        }
    }
    /** Opportunistic head start. Discovery needs seconds to surface the peer —
     *  1.4s on one test phone, 3.9s on the other, and one session missed
     *  entirely inside 6.4s — and the ring already spends those seconds for
     *  free. Fires only when Wi-Fi is already on: this must never open the
     *  panel at ring time, never block, and never reject — the handoff repeats
     *  the kick and owns the Wi-Fi turn. */
    @ReactMethod fun warmUpPeerDiscovery(promise: Promise) {
        main.post {
            val activeManager = manager
            val activeChannel = ensureChannel()
            if (wifiState?.isWifiEnabled != true) {
                android.util.Log.i("DirectWifi", "peer discovery warmup skipped; Wi-Fi is off")
                promise.resolve(null); return@post
            }
            if (activeManager == null || activeChannel == null) {
                android.util.Log.i("DirectWifi", "peer discovery warmup skipped; no channel")
                promise.resolve(null); return@post
            }
            try {
                activeManager.discoverPeers(activeChannel, object : WifiP2pManager.ActionListener {
                    override fun onSuccess() { android.util.Log.i("DirectWifi", "peer discovery warmed up") }
                    override fun onFailure(reason: Int) { android.util.Log.i("DirectWifi", "peer discovery warmup failed reason=$reason") }
                })
            } catch (_: Exception) {}
            promise.resolve(null)
        }
    }
    private fun pollPeerAddress(expected: ReadableArray, promise: Promise) {
        try {
            val activeManager = manager ?: throw IllegalStateException("Wi-Fi Direct is unavailable")
            val activeChannel = ensureChannel() ?: throw IllegalStateException("Wi-Fi Direct is unavailable")
            val names = (0 until expected.size()).mapNotNull { expected.getString(it) }
                .map { it.trim() }.filter { it.isNotEmpty() }
            android.util.Log.i("DirectWifi", "peer read start sdk=${Build.VERSION.SDK_INT} wifi=${wifiState?.isWifiEnabled} location=${locationEnabled()} p2pFeature=${context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)} expected=$names")
            var settled = false
            var lastSeen = "no peers seen"
            fun end(found: String?, how: String?) {
                if (settled) return
                settled = true
                if (found != null) {
                    android.util.Log.i("DirectWifi", "peer read resolved $found by=$how")
                    promise.resolve(found)
                } else {
                    try { activeManager.stopPeerDiscovery(activeChannel, null) } catch (_: Exception) {}
                    android.util.Log.i("DirectWifi", "peer read exhausted peers=$lastSeen")
                    promise.reject("P2P_PEER_ADDRESS", "Wi-Fi Direct peer not discovered ($lastSeen)")
                }
            }
            val deadline = Runnable { end(null, null) }
            main.postDelayed(deadline, ADDRESS_WAIT_MS)
            fun kick() {
                try {
                    activeManager.discoverPeers(activeChannel, object : WifiP2pManager.ActionListener {
                        override fun onSuccess() {}
                        override fun onFailure(reason: Int) {
                            android.util.Log.i("DirectWifi", "peer discovery kick failed reason=$reason")
                        }
                    })
                } catch (_: Exception) {}
            }
            fun attempt(triesLeft: Int) {
                activeManager.requestPeers(activeChannel) { list ->
                    if (settled) return@requestPeers
                    val peers = (list?.deviceList ?: emptyList()).toList()
                    lastSeen = if (peers.isEmpty()) "no peers seen"
                               else peers.joinToString("; ") { p -> p.deviceName + "|" + p.deviceAddress + "|" + p.status }
                    // Named match first: the contact is identified, never guessed.
                    val named = peers.firstOrNull { p ->
                        val dn = p.deviceName.trim()
                        dn.isNotEmpty() && names.any { n -> dn.equals(n, true) }
                    }
                    if (named != null) {
                        main.removeCallbacks(deadline)
                        Log.i("MacMap", "contact=$names device=${named.deviceName} mac=${named.deviceAddress} by=name")
                        end(named.deviceAddress, "name=${named.deviceName}")
                        return@requestPeers
                    }
                    // Exactly one phone offering itself: unambiguous today on both
                    // test devices. A wrong pick cannot reach audio — the control
                    // token handshake rejects a stranger before any media flows.
                    val available = peers.filter { p -> p.status == WifiP2pDevice.AVAILABLE }
                    if (available.size == 1) {
                        main.removeCallbacks(deadline)
                        Log.i("MacMap", "contact=$names device=${available[0].deviceName} mac=${available[0].deviceAddress} by=single-available")
                        end(available[0].deviceAddress, "single-available=${available[0].deviceName}")
                        return@requestPeers
                    }
                    if (peers.isNotEmpty() || triesLeft % 8 == 0)
                        android.util.Log.i("DirectWifi", "peer read left=$triesLeft peers=$lastSeen")
                    if (triesLeft <= 0) { main.removeCallbacks(deadline); end(null, null); return@requestPeers }
                    main.postDelayed({ attempt(triesLeft - 1) }, ADDRESS_POLL_MS)
                }
            }
            kick()
            attempt(ADDRESS_ATTEMPTS)
        } catch (e: Exception) { promise.reject("P2P_PEER_ADDRESS", e.message) }
    }
    /** Location is a standing precondition for P2P discovery and group
     *  formation; without it the framework refuses both. */
    private fun locationEnabled(): Boolean = try {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? android.location.LocationManager
        if (Build.VERSION.SDK_INT >= 30) lm?.isLocationEnabled ?: false
        else lm?.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER) ?: false
    } catch (_: Exception) { false }
    @ReactMethod fun connectCallPeer(id: String, peerAddress: String, isCaller: Boolean, token: String, promise: Promise) {
        // The STA band at the moment the user pressed Call. Our group is pinned
        // to 2.4GHz, so a 5GHz internet link means the radio has to time-share.
        probePeerRadio(context, "call-start role=${if (isCaller) "caller" else "callee"}")
        begin(id, isCaller, token, promise) { r ->
            val mac = try { MacAddress.fromString(peerAddress) }
                catch (e: Exception) { throw IllegalArgumentException("Invalid peer Wi-Fi Direct address") }
            // A placeholder address would silently become "connect to anyone";
            // fail with the message that tells the user what to fix instead.
            if (mac.toString() == MAC_ANY_ADDRESS) throw IllegalStateException(
                "The other phone's Wi-Fi Direct address was unavailable (02:00:00:00:00:00)")
            // Two-sided connect: both phones address each other directly, so the
            // framework runs find/GO-negotiation/credentials as one internal
            // handshake. There is no pre-existing SSID for a stack to miss.
            // The Builder (API 29) takes address + 2.4 GHz band but has NO
            // groupOwnerIntent setter; the built config still exposes the public
            // intent field the framework negotiates from, so set it after build().
            // Older stacks (seen on an Android 11/12-era device) validate
            // build() with "network name must be non-empty." — an address-only
            // config can never build there, so fall back to the legacy config
            // every framework accepts: same address, same GO intent, auto band.
            val intent = if (isCaller) CALLER_GO_INTENT else CALLEE_GO_INTENT
            val config = try {
                WifiP2pConfig.Builder()
                    .setDeviceAddress(mac)
                    .setGroupOperatingBand(WifiP2pConfig.GROUP_OWNER_BAND_2GHZ)
                    .build()
                    .also {
                        it.groupOwnerIntent = intent
                        it.wps.setup = WpsInfo.PBC
                    }
            } catch (e: IllegalStateException) {
                WifiP2pConfig().apply {
                    deviceAddress = mac.toString()
                    groupOwnerIntent = intent
                    wps.setup = WpsInfo.PBC
                }
            }
            r.peerAddress = mac.toString()
            r.config = config
            r.requested = true
            stage(r, "connecting-peer")
            radioReleased = false
            issueConnect(r)
        }
    }
    private fun issueConnect(r: Run) {
        r.lastConnectAt = SystemClock.elapsedRealtime()
        // Ensure discovery is actively maintaining mPeers so Android's WifiP2pServiceImpl
        // does not drop connect() with isConfigInvalid (mPeers.get(address) == null).
        try { manager?.discoverPeers(channel, null) } catch (_: Exception) {}
        retryBusy(r, "connect to the other phone") { listener -> manager!!.connect(channel, r.config!!, listener) }
    }
    private fun retryBusy(r: Run, operation: String, attempt: Int = 0, action: (WifiP2pManager.ActionListener) -> Unit) {
        if (!current(r)) return
        try {
            r.operationPending = true
            action(object : WifiP2pManager.ActionListener {
                override fun onSuccess() {
                    r.operationPending = false
                    if (current(r)) queryGroup(r)
                }
                override fun onFailure(reason: Int) {
                    r.operationPending = false
                    if (!current(r)) return
                    // P2P_UNSUPPORTED is permanent. BUSY and ERROR are transient
                    // radio contention; the observed "(2)" group failure was ERROR.
                    if (reason != WifiP2pManager.P2P_UNSUPPORTED && attempt < 8) {
                        android.util.Log.i("DirectWifi", "session=${r.id} $operation failed ($reason); retry=${attempt + 1}")
                        try { manager?.discoverPeers(channel, null) } catch (_: Exception) {}
                        main.postDelayed({ retryBusy(r, operation, attempt + 1, action) }, minOf(250L * (attempt + 1), 1500L))
                    } else fail(r, "Could not $operation ($reason)")
                }
            })
        } catch (e: Exception) { r.operationPending = false; fail(r, e.message ?: "Wi-Fi setup failed") }
    }
    private fun pollGroup(r: Run, delay: Long = 150) {
        if (!current(r) || r.queryScheduled) return
        r.queryScheduled = true
        main.postDelayed({ r.queryScheduled = false; queryGroup(r) }, delay)
    }
    private fun queryGroup(r: Run) {
        if (!current(r) || !r.requested || r.queryPending) return
        r.queryPending = true
        try {
            manager?.requestConnectionInfo(channel) { info ->
                r.queryPending = false
                if (!current(r)) return@requestConnectionInfo
                if (!info.groupFormed) {
                    if (r.writer != null && r.health.absent(SystemClock.elapsedRealtime()))
                        fail(r, "Direct Wi-Fi connection lost (confirmed by repeated checks)")
                    else {
                        // Refresh a stalled formation instead of passively waiting
                        // for the watchdog (XOS never re-drives its own find).
                        if (r.writer == null && !r.operationPending && r.config != null &&
                            SystemClock.elapsedRealtime() - r.lastConnectAt >= CONNECT_REFRESH_MS &&
                            r.connectRefreshes < MAX_CONNECT_REFRESHES) {
                            r.connectRefreshes++
                            android.util.Log.i("DirectWifi", "session=${r.id} peer group not formed; refreshing connect ${r.connectRefreshes}")
                            issueConnect(r)
                        }
                        pollGroup(r)
                    }
                    return@requestConnectionInfo
                }
                r.health.present()
                // The framework negotiated the roles; assign from its readback.
                r.owner = info.isGroupOwner
                val ip = info.groupOwnerAddress?.hostAddress
                if (ip == null) { pollGroup(r); return@requestConnectionInfo }
                if (r.socketStarted) return@requestConnectionInfo
                r.queryPending = true
                manager?.requestGroupInfo(channel) { group ->
                    r.queryPending = false
                    if (!current(r) || r.socketStarted) return@requestGroupInfo
                    if (group == null) { pollGroup(r); return@requestGroupInfo }
                    // The client must be talking to the exact device addressed
                    // during signaling. The host's control socket authenticates
                    // the session token, so a stranger cannot pass the handshake.
                    if (!r.owner && group.owner?.deviceAddress?.lowercase() != r.peerAddress) {
                        val ownerAddress = group.owner?.deviceAddress?.lowercase()
                        // XOS publishes a placeholder owner address
                        // (02:00:00:00:00:00) that can never equal the real
                        // peer; only a genuine mismatch fails.
                        if (ownerAddress != "02:00:00:00:00:00" && ownerAddress != "00:00:00:00:00:00") {
                            fail(r, "Connected to an unexpected Wi-Fi Direct device"); return@requestGroupInfo
                        }
                        android.util.Log.w("DirectWifi", "session=${r.id} owner address $ownerAddress is a placeholder; authenticating on the session token only")
                    }
                    if (r.networkName != group.networkName) {
                        r.networkName = group.networkName
                        android.util.Log.i("DirectWifi", "session=${r.id} group=${group.networkName} owner=${group.owner?.deviceAddress}")
                    }
                    // groupFormed can precede DHCP/interface address assignment.
                    // Do not begin a socket on Android's default network meanwhile.
                    val local = try {
                        NetworkInterface.getByName(group.getInterface())?.inetAddresses?.toList()
                            ?.filterIsInstance<Inet4Address>()?.firstOrNull { !it.isLoopbackAddress && !it.isAnyLocalAddress }
                    } catch (_: SocketException) { null }
                    if (local == null || (r.owner && local.hostAddress != ip)) {
                        stage(r, "waiting-for-direct-address"); pollGroup(r); return@requestGroupInfo
                    }
                    r.socketStarted = true
                    r.group = group
                    android.util.Log.i("DirectWifi", "session=${r.id} owner=${r.owner} interface=${group.getInterface()} frequency=${group.frequency}")
                    if (r.owner) startServer(r, local) else startClient(r, local, ip)
                }
            }
        } catch (e: Exception) { r.queryPending = false; fail(r, e.message ?: "Wi-Fi state error") }
    }
    private fun stage(r: Run, phase: String) {
        if (!current(r) || r.phase == phase) return
        r.phase = phase
        android.util.Log.i("DirectWifi", "session=${r.id} phase=$phase elapsedMs=${SystemClock.elapsedRealtime() - r.createdAt}")
    }
    private fun startServer(r: Run, local: InetAddress) {
        io.execute {
            try {
                // Settle only at control-ready (like the client). A deadline
                // miss now rejects the same promise JS already awaits.
                //
                // When the keeper tunnel is ours the host listens on the
                // virtual peer instead of the P2P address; KeeperVpnService
                // accepts on the real address and bridges to this listener.
                // Any failure falls back to the direct path unchanged.
                val localIp = local.hostAddress
                if (localIp == null) { fail(r, "Direct control host: local P2P address unavailable"); return@execute }
                val relayed = KeeperVpnService.configureRelay(false, localIp, localIp)
                val bind = if (relayed) InetAddress.getByName(KeeperVpnService.VIRTUAL_PEER) else local
                val port = if (relayed) KeeperVpnService.APP_PORT else KeeperVpnService.PEER_PORT
                if (relayed) Log.i("DirectWifi", "session=${r.id} control host via keeper relay (app $bind:$port, peer $localIp:${KeeperVpnService.PEER_PORT})")
                val connection = DirectControlSocket.accept(bind, port, "${r.id}|${r.token}",
                    DirectControlSocket.now() + 25000, { current(r) }, { r.server = it }, { r.socket = it }, { stage(r, it) })
                // Outside the accept/authentication retry block: a failure here
                // must never be masked by a second accept on a closed listener.
                ready(r, connection.socket, connection.writer, connection.reader, localIp)
            } catch (e: Exception) { if (current(r)) fail(r, "Direct control host (${r.phase}): ${e.message}") }
        }
    }
    private fun startClient(r: Run, local: InetAddress, ip: String) {
        io.execute {
            try {
                stage(r, "connecting-control")
                // Client dials the virtual peer; the keeper relay dials the
                // real group owner with a protect()ed socket. The reported
                // local IP stays the real P2P address because DirectCallAudio
                // filters WebRTC host candidates against it.
                val localIp = local.hostAddress
                if (localIp == null) { fail(r, "Direct control client: local P2P address unavailable"); return@execute }
                val relayed = KeeperVpnService.configureRelay(true, localIp, ip)
                val bind = if (relayed) InetAddress.getByName(KeeperVpnService.VIRTUAL_LOCAL) else local
                val target = if (relayed) InetAddress.getByName(KeeperVpnService.VIRTUAL_PEER) else InetAddress.getByName(ip)
                val port = if (relayed) KeeperVpnService.APP_PORT else KeeperVpnService.PEER_PORT
                if (relayed) Log.i("DirectWifi", "session=${r.id} control client via keeper relay (app $bind -> $target:$port, peer $ip:${KeeperVpnService.PEER_PORT})")
                val connection = DirectControlSocket.connect(bind, target, port, "${r.id}|${r.token}",
                    DirectControlSocket.now() + 20000, { current(r) }, { r.socket = it }, { stage(r, it) })
                ready(r, connection.socket, connection.writer, connection.reader, localIp)
            } catch (e: Exception) { if (current(r)) fail(r, "Direct control client (${r.phase}): ${e.message}") }
        }
    }
    private fun ready(r: Run, socket: Socket, writer: BufferedWriter, reader: BufferedReader, advertisedIp: String) {
        if (!current(r)) { socket.close(); return }
        r.socket = socket; r.writer = writer; socket.soTimeout = 0
        stage(r, "control-ready")
        main.post {
            if (current(r)) {
                if (!r.settled) { r.settled = true; r.promise.resolve(true) }
                // advertisedIp is the real P2P interface address even when the
                // control socket itself lives inside the relay's virtual
                // subnet. Media candidates must keep using the P2P address.
                emit("onDirectReady", r, Arguments.createMap().apply { putString("localIp", advertisedIp) })
            }
        }
        var closedReason = "peer closed the control connection"
        try {
            while (current(r)) {
                val data = DirectControlSocket.readLine(reader, 65536) ?: break
                // Keep ready, signal and error events ordered on one thread.
                main.post { if (current(r)) emit("onDirectSignal", r, Arguments.createMap().apply { putString("data", data) }) }
            }
        } catch (e: Exception) { closedReason = e.javaClass.simpleName }
        // Let a preceding peer-end message reach JS before reporting EOF.
        main.postDelayed({ if (current(r)) fail(r, "Direct signaling connection lost: $closedReason") }, 1000)
    }
    @ReactMethod fun sendCallSignal(id: String, data: String, promise: Promise) {
        val r = run
        if (r == null || r.id != id || !current(r) || data.length > 65536 || data.contains('\n')) {
            promise.reject("NO_SESSION", "Direct signaling unavailable"); return
        }
        writes.execute {
            try {
                check(current(r)); val writer = r.writer ?: error("Direct signaling not ready")
                writer.write(data); writer.newLine(); writer.flush(); promise.resolve(true)
            } catch (e: Exception) { promise.reject("SIGNAL_FAILED", e.message) }
        }
    }
    @ReactMethod fun startAudio(id: String, promise: Promise) {
        main.post {
            try {
                check(run?.id == id && run?.writer != null) { "Direct link not ready" }
                val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
                audio.mode = AudioManager.MODE_IN_COMMUNICATION
                val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attrs)
                    .setOnAudioFocusChangeListener { change -> if (change == AudioManager.AUDIOFOCUS_LOSS) run?.let { fail(it, "Audio focus lost") } }.build()
                focus = request
                check(audio.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { "Audio focus unavailable" }
                audio.isSpeakerphoneOn = false
                ContextCompat.startForegroundService(context, Intent(context, CallForegroundService::class.java)); promise.resolve(true)
            } catch (e: Exception) { promise.reject("AUDIO_SETUP", e.message) }
        }
    }
    @ReactMethod fun setSpeaker(id: String, enabled: Boolean) { main.post { if (run?.id == id) audio.isSpeakerphoneOn = enabled } }
    private fun fail(r: Run, message: String) {
        main.post {
            if (!current(r)) return@post
            if (!r.settled) { r.settled = true; r.promise.reject("DIRECT_FAILED", message) }
            emit("onDirectError", r, Arguments.createMap().apply { putString("error", message) }); stop(r, null)
        }
    }
    @ReactMethod fun stopCall(id: String, promise: Promise) {
        main.post {
            val r = run
            if (r == null || r.id == id) lifecycleEpoch++
            if (r == null || r.id != id) {
                awaitStopped(promise)
            } else stop(r, promise)
        }
    }
    private fun awaitStopped(promise: Promise, attempt: Int = 0) {
        if (!stopping) {
            if (radioReleased) promise.resolve(true)
            else promise.reject("WIFI_CLOSING", "The previous Wi-Fi link has not been released")
            return
        }
        if (attempt >= 300) { promise.reject("WIFI_CLOSING", "The previous Wi-Fi call is still closing"); return }
        main.postDelayed({ awaitStopped(promise, attempt + 1) }, 50)
    }
    private fun stop(r: Run, promise: Promise?) {
        val stopAt = SystemClock.elapsedRealtime()
        r.stopStartedAt = stopAt
        Log.i("DirectWifi", "teardown begin session=${r.id} requested=${r.requested} live=${r.live} runCleared=true")
        r.live = false; if (run === r) run = null
        if (!r.settled) { r.settled = true; r.promise.reject("CANCELLED", "Call cancelled") }
        try { r.socket?.close() } catch (_: Exception) {}; try { r.server?.close() } catch (_: Exception) {}; r.writer = null
        focus?.let { audio.abandonAudioFocusRequest(it) }; focus = null
        audio.isSpeakerphoneOn = false; audio.mode = AudioManager.MODE_NORMAL
        context.stopService(Intent(context, CallForegroundService::class.java))
        if (!r.requested || manager == null || channel == null) {
            Log.i("DirectWifi", "teardown exit session=${r.id} reason=no-requested-link elapsedMs=0")
            radioReleased = true
            KeeperVpnService.clearRelay()
            promise?.resolve(true); return
        }
        stopping = true
        // Nearby's own endpoints were stopped before P2P was ever touched, so it
        // may resume the moment this run closes. Gating that resume on the full
        // group teardown held the phone deaf for 13-22s after every call, and
        // latched permanently whenever the teardown rejected (radioReleased was
        // only ever set true by a successful awaitGroupReleased). begin() still
        // waits on `stopping`, so a new call cannot start into a dying group.
        radioReleased = true
        promise?.resolve(true)
        // The hangup/EOF bytes already on air reach the peer during this grace,
        // so it reads a clean end instead of a mid-call SocketException when
        // the group's radio link dies.
        main.postDelayed({ cancelAndRelease(r, null) }, 400)
    }
    private fun elapsed(r: Run) = if (r.stopStartedAt == 0L) -1L else SystemClock.elapsedRealtime() - r.stopStartedAt
    private fun cancelAndRelease(r: Run, promise: Promise?) {
        Log.i("DirectWifi", "teardown cancel session=${r.id} elapsedMs=${elapsed(r)}")
        // The app-side socket is already closed; stop accepting relay
        // connections and let the bridge drain the hangup bytes.
        KeeperVpnService.clearRelay()
        if (manager == null || channel == null) {
            Log.i("DirectWifi", "teardown exit session=${r.id} reason=no-manager elapsedMs=${elapsed(r)}")
            stopping = false; radioReleased = true; promise?.resolve(true); return
        }
        try { manager?.stopPeerDiscovery(channel, null) } catch (_: Exception) {}
        manager?.cancelConnect(channel, object : WifiP2pManager.ActionListener {
            override fun onSuccess() { r.cancelSettled = true }
            override fun onFailure(reason: Int) { r.cancelSettled = true }
        })
        releaseOwnedGroup(r, promise)
    }
    private fun releaseOwnedGroup(r: Run, promise: Promise?, attempt: Int = 0) {
        if ((r.operationPending || !r.cancelSettled) && attempt < 100) {
            main.postDelayed({ releaseOwnedGroup(r, promise, attempt + 1) }, 50); return
        }
        if (r.operationPending || !r.cancelSettled) {
            Log.w("DirectWifi", "teardown exit session=${r.id} reason=cancel-never-acknowledged " +
                "opPending=${r.operationPending} cancelSettled=${r.cancelSettled} waitMs=${attempt * 50L} elapsedMs=${elapsed(r)}")
            stopping = false; radioReleased = true
            promise?.reject("WIFI_CLOSING", "Wi-Fi Direct did not acknowledge cancellation"); return
        }
        try {
            manager?.requestGroupInfo(channel) { group ->
                Log.i("DirectWifi", "teardown group session=${r.id} result=${group?.let { "${it.networkName}|owner=${it.isGroupOwner}|clients=${it.clientList?.size}" } ?: "null"} " +
                    "ours=${r.networkName} elapsedMs=${elapsed(r)}")
                if (group == null) { awaitGroupReleased(promise, r = r) }
                else if (r.networkName != null && group.networkName != r.networkName) {
                    // begin() proved no group existed before this run's connect,
                    // so an unobserved group here is this run's late formation;
                    // only a DIFFERENT name is a foreign link. Nearby stays down
                    // here on purpose: resuming it could collide with that link.
                    Log.w("DirectWifi", "teardown exit session=${r.id} reason=foreign-group name=${group.networkName} elapsedMs=${elapsed(r)}")
                    stopping = false
                    promise?.reject("WIFI_CLOSING", "Another Wi-Fi Direct link is in use; it was not disconnected")
                } else {
                    Log.i("DirectWifi", "teardown removeGroup session=${r.id} elapsedMs=${elapsed(r)}")
                    manager?.removeGroup(channel, object : WifiP2pManager.ActionListener {
                        override fun onSuccess() { awaitGroupReleased(promise, r = r) }
                        override fun onFailure(reason: Int) {
                            Log.w("DirectWifi", "teardown removeGroup failed session=${r.id} reason=$reason")
                            awaitGroupReleased(promise, r = r)
                        }
                    })
                }
            }
        } catch (e: Exception) {
            Log.w("DirectWifi", "teardown exit session=${r.id} reason=groupinfo-threw elapsedMs=${elapsed(r)}", e)
            stopping = false; radioReleased = true; promise?.reject("WIFI_CLOSING", e)
        }
    }
    private fun awaitGroupReleased(promise: Promise?, attempt: Int = 0, r: Run) {
        try {
            manager?.requestGroupInfo(channel) { group ->
                val now = SystemClock.elapsedRealtime()
                if (group == null && r.absentSince == 0L) {
                    r.absentSince = now
                    Log.i("DirectWifi", "teardown group gone session=${r.id} atPoll=$attempt elapsedMs=${elapsed(r)}")
                }
                if (group != null) {
                    r.absentSince = 0L
                    // A connect accepted before cancel can still form the group.
                    // Remove only this run's group; begin()'s null-gate proves
                    // no group existed before the connect was issued.
                    if ((group.networkName == r.networkName || (r.networkName == null && r.requested)) && attempt < 20)
                        manager?.removeGroup(channel, null)
                }
                if (group == null && now - r.absentSince >= 1500) {
                    Log.i("DirectWifi", "teardown exit session=${r.id} reason=released " +
                        "confirmMs=${now - r.absentSince} polls=$attempt elapsedMs=${elapsed(r)}")
                    stopping = false; radioReleased = true; promise?.resolve(true)
                } else if (attempt < GROUP_RELEASE_ATTEMPTS) main.postDelayed({ awaitGroupReleased(promise, attempt + 1, r) }, 250)
                else {
                    // Exhausted. RadioReleased must still be true: the group may
                    // be in a state requestGroupInfo never reports as null, and
                    // holding Nearby down forever is strictly worse than resuming
                    // it — the worst case there is a visible conflicting-link
                    // error on the NEXT call, not a phone that cannot receive.
                    Log.w("DirectWifi", "teardown exit session=${r.id} reason=group-never-confirmed " +
                        "polls=$attempt groupNull=${group == null} elapsedMs=${elapsed(r)}")
                    stopping = false; radioReleased = true
                    promise?.reject("WIFI_CLOSING", "The previous Wi-Fi link did not finish closing")
                }
            }
        } catch (e: Exception) {
            Log.w("DirectWifi", "teardown exit session=${r.id} reason=groupinfo-threw elapsedMs=${elapsed(r)}", e)
            stopping = false; radioReleased = true; promise?.reject("WIFI_CLOSING", e)
        }
    }
    private fun emit(event: String, r: Run, data: WritableMap) {
        data.putString("sessionId", r.id)
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(event, data)
    }
    @ReactMethod fun addListener(name: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
    override fun invalidate() {
        main.post {
            lifecycleEpoch++
            run?.let { stop(it, null) }
            KeeperVpnService.clearRelay()
            try { context.unregisterReceiver(receiver) } catch (_: Exception) {}
        }
        io.shutdownNow(); writes.shutdownNow(); super.invalidate()
    }
}

package com.anonymous.kelakonnect

import android.content.Context
import org.json.JSONObject
import org.json.JSONArray
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.*

class NearbyTransport private constructor(private val context: Context) {
    companion object {
        // Isolate the acknowledged handoff protocol from older APKs.
        private const val SERVICE_ID = "com.kelakonnect.nearby.control.v2"
        /** How long an idle advertisement is left running before it is cycled.
         *  See advertisingStartedAt: this bounds how long a silently dropped
         *  advertisement can go unobserved, since this SDK gives us no callback
         *  for the drop. */
        private const val IDLE_ADVERTISING_REFRESH_MS = 180_000L
        /** Minimum spacing between advertisement refreshes triggered by an
         *  endpoint closing. clearEndpoint fires on every flap, so without this
         *  the advertisement is torn down and rebuilt on each one: measured at
         *  23 cycles in ~2.5 minutes, 1.5-7s per cycle, some with under a
         *  second of actual uptime before being torn down again. The churn
         *  amplified the very instability that triggered it. A refresh repairs
         *  a stale advertisement — it is never urgent, so a quiet window is
         *  the point. The scheduled staleness cycle is not throttled. */
        private const val CLOSURE_REFRESH_MIN_INTERVAL_MS = 30_000L
        @Volatile private var singleton: NearbyTransport? = null
        fun get(context: Context): NearbyTransport = singleton ?: synchronized(this) {
            singleton ?: NearbyTransport(context.applicationContext).also { singleton = it }
        }
    }
    var sink: ((String, WritableMap) -> Unit)? = null
    private val prefs = context.getSharedPreferences("availability", 0)
    private var incoming: Pair<String, String>? = null
    private var session: String? = null
    private var sessionEndpoint: String? = null
    private var handoffReadySession: String? = null
    private var directSession: String? = null
    private val confirmedTransfers = mutableMapOf<Long, Pair<String, Promise>>()
    private val attempts = mutableMapOf<String, Any>()
    private val leases = mutableMapOf<String, Runnable>()
    private var restoring = false
    private var advertisingEpoch = 0
    private var discoveryEpoch = 0
    private var startingDiscovery = false
    @Volatile private var advertising = false
    @Volatile private var discovering = false
    val isAdvertising: Boolean get() = advertising
    val isDiscovering: Boolean get() = discovering
    private val discoveredPeers = linkedMapOf<String, DiscoveredEndpointInfo>()
    private var advertisingRefresh: Runnable? = null
    // When a closure-triggered refresh was last scheduled. Throttles the
    // flap feedback loop; see CLOSURE_REFRESH_MIN_INTERVAL_MS.
    private var lastClosureRefreshAt = 0L
    // When startAdvertising last succeeded. The SDK exposes no
    // AdvertisingLifecycleCallback, so nothing tells us if the OS later drops
    // the advertisement — our cached flag stays true and the watchdog at
    // healthWatchdog only reads that same flag. Cycling the advertisement on a
    // timer bounds the staleness instead of trying to observe the drop.
    private var advertisingStartedAt = 0L
    private val peerIdentities = mutableMapOf<String, String>()
    fun configure(uuid: String, name: String, contacts: String, audible: Boolean) {
        prefs.edit().putString("uuid", uuid).putString("name", name)
            .putString("contacts", contacts).putBoolean("audible", audible).apply()
    }
    private fun contactName(uuid: String): String? = try {
        val contacts = JSONArray(prefs.getString("contacts", "[]"))
        (0 until contacts.length()).map { contacts.getJSONObject(it) }
            .firstOrNull { it.optString("uuid") == uuid }?.optString("name")
    } catch (_: Exception) { null }

    fun restore() { main.post {
        if (prefs.getBoolean("paused", true) || directSession != null || advertising || restoring) return@post
        val uuid = prefs.getString("uuid", "") ?: ""
        if (uuid.isBlank()) return@post
        identity = "$uuid|${prefs.getString("name", "BigK")}"
        restoring = true
        val epoch = advertisingEpoch
        try {
            client.startAdvertising(identity, SERVICE_ID, lifecycle, advertisingOptions())
                .addOnSuccessListener {
                    restoring = false
                    advertising = epoch == advertisingEpoch && !prefs.getBoolean("paused", true)
                    if (!advertising) client.stopAdvertising()
                    else advertisingStartedAt = SystemClock.elapsedRealtime()
                    Log.i("Availability", "Native advertising ready=$advertising")
                }.addOnFailureListener { error ->
                    restoring = false; Log.w("Availability", "Advertising recovery failed", error)
                    if (AvailabilityService.running && !prefs.getBoolean("paused", true)) main.postDelayed({ restore() }, 10000)
                }
        } catch (e: Exception) { restoring = false; Log.w("Availability", "Advertising unavailable", e) }
    } }
    fun pause() { main.post {
        prefs.edit().putBoolean("paused", true).apply()
        advertisingEpoch++
        session?.let { IncomingCallNotification.dismiss(context, it) }
        session = null; sessionEndpoint = null; incoming = null; handoffReadySession = null
        leases.values.forEach { main.removeCallbacks(it) }; leases.clear()
        client.stopAdvertising(); advertising = false
        stopDiscoveryInternal()
        client.stopAllEndpoints(); connected.clear(); peerIdentities.clear()
        attempts.clear()
        confirmedTransfers.values.forEach { it.second.reject("CANCELLED", "Local calling paused") }; confirmedTransfers.clear()
        pending.values.forEach { it.reject("CANCELLED", "Local calling paused") }; pending.clear()
        emit("onAvailabilityPaused", Arguments.createMap())
    } }
    fun pendingIncoming(promise: Promise) { main.post {
        promise.resolve(incoming?.let { item -> Arguments.createMap().apply {
            putString("connectionId", item.first); putString("data", item.second)
        } })
    } }
    fun retainConnection(id: String, expectedSession: String? = session) { main.post {
        if (sessionEndpoint == id && session != expectedSession) return@post
        if (sessionEndpoint == id) { session = null; sessionEndpoint = null; incoming = null; handoffReadySession = null }
        leases.remove(id)?.let { main.removeCallbacks(it) }
        if (!connected.contains(id) || directSession != null) return@post
        val expiry = Runnable {
            leases.remove(id)
            if (sessionEndpoint != id) {
                closeEndpoint(id, "idle lease expired")
            }
        }
        leases[id] = expiry; main.postDelayed(expiry, 30000)
    } }
    // Nearby is a bootstrap transport only. Stop it on BOTH phones after the
    // planned group credentials have been acknowledged, before touching P2P.
    fun releaseForDirectCall(id: String, promise: Promise) { main.post {
        if (directSession == id) { promise.resolve(true); return@post }
        if (directSession != null || session != id || handoffReadySession != id || prefs.getBoolean("paused", true)) {
            promise.reject("HANDOFF_STATE", "The direct-call handoff was not acknowledged"); return@post
        }
        directSession = id; advertisingEpoch++
        stopDiscoveryInternal()
        client.stopAdvertising(); advertising = false
        val endpoints = (connected + pending.keys + peerIdentities.keys).toSet()
        client.stopAllEndpoints()
        endpoints.forEach { clearEndpoint(it, "direct-call handoff") }
        Log.i("NearbyHandoff", "session=$id bootstrap released; direct Wi-Fi may start")
        promise.resolve(true)
    } }
    fun resumeAfterDirectCall(id: String, promise: Promise) { main.post {
        if (directSession == id) {
            if (!DirectWifiModule.radioReleased) {
                promise.reject("WIFI_CLOSING", "Wi-Fi Direct cleanup did not finish; nearby calling remains paused to avoid a conflicting link")
                return@post
            }
            directSession = null
            if (session == id) { session = null; sessionEndpoint = null; incoming = null }
            if (handoffReadySession == id) handoffReadySession = null
            Log.i("NearbyHandoff", "session=$id direct cleanup finished; bootstrap available")
            restore()
        } else if (directSession == null && session == id) {
            // A failed ready transfer may already have disconnected the endpoint.
            // Clear the matching abandoned session, even if call-end cannot arrive.
            IncomingCallNotification.dismiss(context, id)
            val endpoint = sessionEndpoint
            session = null; sessionEndpoint = null; incoming = null
            if (handoffReadySession == id) handoffReadySession = null
            endpoint?.let { closeEndpoint(it, "abandoned direct setup") }
        }
        promise.resolve(true)
    } }
    private fun advertisingOptions() = AdvertisingOptions.Builder()
        .setStrategy(Strategy.P2P_POINT_TO_POINT).setLowPower(false)
        .setConnectionType(ConnectionType.NON_DISRUPTIVE).build()
    fun recoverAfterRadioReset() { main.post {
        val id = directSession ?: return@post
        if (!DirectWifiModule.radioReleased) return@post
        directSession = null
        if (session == id) { session = null; sessionEndpoint = null; incoming = null }
        if (handoffReadySession == id) handoffReadySession = null
        restore()
        emit("onDirectCleanupRecovered", Arguments.createMap())
    } }
    /** Periodic self-heal owned by AvailabilityService, independent of React Native.
     *  A stuck handoff or stale call session suspends Nearby forever, and a silently
     *  dropped advertisement makes the phone unreachable — neither may depend on JS
     *  being alive to repair. Called every minute while the service runs. */
    fun healthWatchdog() { main.post {
        if (prefs.getBoolean("paused", true)) return@post
        val direct = directSession
        if (direct != null) {
            // A handoff whose cleanup never confirmed keeps Nearby suspended.
            // recoverAfterRadioReset is a safe no-op until the radio has released.
            if (DirectWifiModule.radioReleased) {
                Log.w("Availability", "Watchdog: stuck direct session $direct; recovering")
                recoverAfterRadioReset()
            }
            return@post
        }
        val stuck = session
        val endpoint = sessionEndpoint
        if (stuck != null && (endpoint == null || !connected.contains(endpoint))) {
            // The endpoint closed while the session guard held (handoff abandoned
            // mid-setup). startDiscovery refuses while session is set, so scanning
            // stays dead until this is cleared.
            Log.w("Availability", "Watchdog: stale call session $stuck has no endpoint; clearing")
            IncomingCallNotification.dismiss(context, stuck)
            session = null; sessionEndpoint = null; incoming = null; handoffReadySession = null
            refreshIdleAdvertising()
        }
        if (!advertising && !restoring) {
            Log.w("Availability", "Watchdog: advertising missing; restoring")
            restore()
            return@post
        }
        // Nothing is in flight, so an advertisement that has stood this long is
        // cycled. If the OS had silently dropped it, our flag would still read
        // true and this is the only thing that can find out — a failed restart
        // logs here instead of leaving the phone unreachable with a green
        // watchdog. Idle-only, so a live call's radio is never touched.
        val idle = connected.isEmpty() && pending.isEmpty() &&
            !prefs.getBoolean("paused", true) && DirectWifiModule.radioReleased
        if (advertising && idle && !restoring &&
            SystemClock.elapsedRealtime() - advertisingStartedAt > IDLE_ADVERTISING_REFRESH_MS) {
            Log.i("Availability", "Watchdog: cycling idle advertisement " +
                "(this SDK has no AdvertisingLifecycleCallback, so staleness is bounded, not observed)")
            refreshIdleAdvertising(force = true)
        }
    } }
    /** One-line Nearby state read, paired with DirectWifiModule.probePeerRadio so
     *  a walk-away test shows where each path dies at the same timestamps.
     *  Read-only: never starts or stops anything. */
    fun probeNearbySnapshot(tag: String) { main.post {
        Log.i("NearbyProbe", "[$tag] advertising=$advertising discovering=$discovering " +
            "discovered=${discoveredPeers.size} connected=${connected.size} pending=${pending.size} " +
            "paused=${prefs.getBoolean("paused", true)} directSession=$directSession session=$session")
    } }
    private fun reply(endpoint: String, original: JSONObject, type: String) {
        val uuid = prefs.getString("uuid", "") ?: ""
        val now = System.currentTimeMillis()
        val signal = JSONObject().put("type", type).put("version", 1)
            .put("sessionId", original.optString("sessionId")).put("from", uuid)
            .put("to", original.optString("from")).put("timestamp", now).put("signature", "$uuid:$now")
        client.sendPayload(endpoint, Payload.fromBytes(signal.toString().toByteArray(Charsets.UTF_8)))
    }
    private fun observeSignal(endpoint: String, data: String, received: Boolean): Boolean {
        try {
            val signal = JSONObject(data); val id = signal.optString("sessionId"); val type = signal.optString("type")
            if (received) {
                // Version 2 is carried ONLY by the direct-handoff pair (address +
                // token instead of group credentials); the rest of the protocol
                // stays at 1. Anything else is foreign noise or another build.
                val version = signal.optInt("version")
                val versionOk = version == 1 ||
                    (version == 2 && (type == "direct-config" || type == "direct-ready"))
                if (!versionOk || signal.optString("to") != prefs.getString("uuid", "") ||
                    signal.optString("from") != peerIdentities[endpoint]) {
                    Log.w("NearbyModule", "dropped signal type=$type version=$version by receive gate")
                    return false
                }
            }
            if (type == "call-request") {
                if (id.isBlank() || id.length > 100) return false
                if (session != null && session != id) {
                    if (received) reply(endpoint, signal, "call-reject")
                    return false
                }
                if (received) {
                    if (prefs.getBoolean("paused", true) || signal.optString("to") != prefs.getString("uuid", "") ||
                        signal.optJSONObject("data")?.optString("mediaEngine") != "webrtc-direct-v2") return false
                    val name = contactName(signal.optString("from")) ?: return false
                    if (session == id) return false
                    incoming = endpoint to data
                    IncomingCallNotification.show(context, id, name, prefs.getBoolean("audible", true))
                }
                leases.remove(endpoint)?.let { main.removeCallbacks(it) }
                session = id; sessionEndpoint = endpoint
                main.postDelayed({
                    if (session == id && incoming != null) {
                        reply(endpoint, signal, "call-reject")
                        IncomingCallNotification.dismiss(context, id)
                        retainConnection(endpoint)
                    }
                }, 45000)
            } else if (type == "direct-ready") {
                if (session != id || sessionEndpoint != endpoint ||
                    signal.optJSONObject("data")?.optString("mediaEngine") != "webrtc-direct-v2") return false
                handoffReadySession = id
            } else if ((type == "call-end" || type == "call-reject") && session == id && sessionEndpoint == endpoint) {
                IncomingCallNotification.dismiss(context, id); incoming = null
                retainConnection(endpoint)
            } else if (type == "call-accept" && session == id && sessionEndpoint == endpoint) incoming = null
        } catch (e: Exception) { Log.w("NearbyModule", "Invalid control payload", e); return false }
        return true
    }
    private val client by lazy { Nearby.getConnectionsClient(context) }
    private val main = Handler(Looper.getMainLooper())
    private var identity = ""
    private val connected = mutableSetOf<String>()
    private val pending = mutableMapOf<String, Promise>()
    private val audioTransfers = mutableMapOf<Long, String>()
    private var audioTransferDrops = 0L
    private var targets = emptySet<String>()

    fun startAdvertising(uuid: String, name: String, promise: Promise) {
        main.post {
            identity = "$uuid|$name"
            if (directSession != null) {
                promise.reject("WIFI_CLOSING", "The previous call link is still closing. If this persists, turn Wi-Fi off and on, then reopen BigK.")
                return@post
            }
            if (advertising) { promise.resolve(true); return@post }
            if (restoring) { main.postDelayed({ startAdvertising(uuid, name, promise) }, 100); return@post }
            restoring = true
            val epoch = advertisingEpoch
            try {
                client.startAdvertising(identity, SERVICE_ID, lifecycle, advertisingOptions())
                    .addOnSuccessListener {
                        restoring = false
                        if (epoch != advertisingEpoch) {
                            client.stopAdvertising(); promise.reject("CANCELLED", "Advertising was stopped")
                        } else { advertising = true; promise.resolve(true) }
                    }
                    .addOnFailureListener { restoring = false; promise.reject("ADVERTISING_FAILED", it) }
            } catch (e: Exception) { restoring = false; promise.reject("ADVERTISING_FAILED", e) }
        }
    }
    fun startDiscovery(uuids: ReadableArray, promise: Promise) {
        val requested = (0 until uuids.size()).mapNotNull { uuids.getString(it) }.toSet()
        main.post {
            targets = requested
            if (directSession != null || session != null) { promise.resolve(false); return@post }
            if (discovering) {
                // JS may have started listening later, or added a contact since
                // the SDK's single onEndpointFound notification. Replay live peers.
                discoveredPeers.forEach { (id, info) -> emitDiscovered(id, info) }
                promise.resolve(true); return@post
            }
            if (startingDiscovery) { main.postDelayed({ startDiscovery(uuids, promise) }, 100); return@post }
            startingDiscovery = true
            val epoch = discoveryEpoch
            try {
                client.startDiscovery(SERVICE_ID, discoveryCallback(epoch),
                    DiscoveryOptions.Builder().setStrategy(Strategy.P2P_POINT_TO_POINT)
                        .setLowPower(false).build())
                    .addOnSuccessListener {
                        startingDiscovery = false
                        if (epoch != discoveryEpoch || directSession != null || session != null) {
                            client.stopDiscovery(); promise.resolve(false)
                        } else {
                            discovering = true
                            discoveredPeers.forEach { (id, info) -> emitDiscovered(id, info) }
                            promise.resolve(true)
                        }
                    }
                    .addOnFailureListener { startingDiscovery = false; promise.reject("DISCOVERY_FAILED", it) }
            } catch (e: Exception) { startingDiscovery = false; promise.reject("DISCOVERY_FAILED", e) }
        }
    }
    // Discovery is not a connection. Connect only to the selected peer.
    fun connect(id: String, promise: Promise) {
        main.post {
            if (directSession != null) { promise.reject("BUSY", "A direct call is in progress"); return@post }
            leases.remove(id)?.let { main.removeCallbacks(it) }
            if (connected.contains(id)) { promise.resolve(true); return@post }
            if (session == null) connected.toList().forEach { old ->
                closeEndpoint(old, "switching contact")
            }
            if (pending.isNotEmpty() || connected.isNotEmpty()) {
                promise.reject("BUSY", "A one-to-one connection is already in use"); return@post
            }
            pending[id] = promise
            val attempt = Any(); attempts[id] = attempt
            try {
                // Small control payloads only. Low power is a preference, NOT an
                // ownership guarantee; the explicit handoff below is required.
                client.requestConnection(identity, id, guardedLifecycle(id, attempt),
                    ConnectionOptions.Builder().setLowPower(true).setConnectionType(ConnectionType.NON_DISRUPTIVE).build())
                    .addOnFailureListener {
                        if (attempts[id] === attempt) {
                            pending.remove(id)?.reject("CONNECT_FAILED", it); closeEndpoint(id, "connection failed")
                        }
                    }
                main.postDelayed({
                    if (pending[id] === promise) {
                        pending.remove(id); closeEndpoint(id, "connection timed out")
                        promise.reject("CONNECT_TIMEOUT", "Peer did not connect within 15 seconds")
                    }
                }, 15000)
            } catch (e: Exception) { pending.remove(id)?.reject("CONNECT_FAILED", e); closeEndpoint(id, "connection failed") }
        }
    }
    fun stopAdvertising(promise: Promise) {
        main.post { advertisingEpoch++; client.stopAdvertising(); advertising = false; promise.resolve(true) }
    }
    fun isConnected(id: String, promise: Promise) {
        main.post { promise.resolve(connected.contains(id)) }
    }
    fun stopDiscovery(promise: Promise) {
        main.post { stopDiscoveryInternal(); promise.resolve(true) }
    }
    private fun stopDiscoveryInternal() {
        discoveryEpoch++; client.stopDiscovery(); discovering = false; discoveredPeers.clear()
    }
    fun sendData(id: String, data: String, promise: Promise, confirmed: Boolean = false) {
        main.post {
            if (!connected.contains(id)) {
                promise.reject("NOT_CONNECTED", "Nearby endpoint is not connected"); return@post
            }
            var transferId: Long? = null
            try {
                if (!observeSignal(id, data, false)) { promise.reject("INVALID_SIGNAL", "Call control rejected"); return@post }
                val audio = data.startsWith("{\"type\":\"audio-frame\"")
                if (audio && audioTransfers.size >= 3) {
                    audioTransferDrops++
                    promise.resolve(false); return@post
                }
                val payload = Payload.fromBytes(data.toByteArray(Charsets.UTF_8))
                transferId = payload.id
                if (confirmed) {
                    confirmedTransfers[payload.id] = id to promise
                    main.postDelayed({
                        confirmedTransfers.remove(payload.id)?.let {
                            client.cancelPayload(payload.id)
                            it.second.reject("SEND_TIMEOUT", "The other phone did not acknowledge the handoff")
                        }
                    }, 5000)
                }
                if (audio) {
                    audioTransfers[payload.id] = id
                    main.postDelayed({
                        if (audioTransfers.remove(payload.id) != null) {
                            audioTransferDrops++
                            client.cancelPayload(payload.id)
                        }
                    }, 150)
                }
                client.sendPayload(id, payload)
                    .addOnSuccessListener { if (!confirmed) promise.resolve(true) }
                    .addOnFailureListener {
                        audioTransfers.remove(payload.id)
                        if (!confirmed || confirmedTransfers.remove(payload.id) != null) promise.reject("SEND_FAILED", it)
                    }
            } catch (e: Exception) {
                transferId?.let { confirmedTransfers.remove(it); audioTransfers.remove(it) }
                promise.reject("SEND_FAILED", e)
            }
        }
    }
    fun closeConnection(id: String, promise: Promise) {
        main.post {
            Log.i("CallMetrics", "endpoint=$id nearbyAudioDrops=$audioTransferDrops")
            closeEndpoint(id, "connection cancelled")
            // API has no disconnect completion task. Drain queued callbacks before
            // a fresh discovery attempt; do not claim the radio has acknowledged it.
            main.postDelayed({ promise.resolve(true) }, 300)
        }
    }
    private fun closeEndpoint(id: String, reason: String) {
        try { client.disconnectFromEndpoint(id) }
        finally { clearEndpoint(id, reason) }
    }
    private fun clearEndpoint(id: String, reason: String) {
        leases.remove(id)?.let { main.removeCallbacks(it) }
        attempts.remove(id); connected.remove(id); peerIdentities.remove(id)
        pending.remove(id)?.reject("DISCONNECTED", reason)
        confirmedTransfers.filterValues { it.first == id }.keys.toList().forEach { payload ->
            confirmedTransfers.remove(payload)?.second?.reject("DISCONNECTED", reason)
        }
        if (sessionEndpoint == id && handoffReadySession != session && directSession != session) {
            session?.let { IncomingCallNotification.dismiss(context, it) }
            session = null; sessionEndpoint = null; incoming = null
        }
        event("onConnectionClosed", id, reason)
        refreshIdleAdvertising()
    }
    private fun refreshIdleAdvertising(force: Boolean = false) {
        if (!force) {
            val since = SystemClock.elapsedRealtime() - lastClosureRefreshAt
            if (since < CLOSURE_REFRESH_MIN_INTERVAL_MS) {
                Log.i("Availability", "Debounced idle advertising refresh (last ${since}ms ago, min ${CLOSURE_REFRESH_MIN_INTERVAL_MS}ms)")
                return
            }
        }
        lastClosureRefreshAt = SystemClock.elapsedRealtime()
        advertisingRefresh?.let { main.removeCallbacks(it) }
        val refresh = Runnable {
            advertisingRefresh = null
            if (session != null || directSession != null || connected.isNotEmpty() || pending.isNotEmpty() ||
                prefs.getBoolean("paused", true) || (!force && !DirectWifiModule.radioReleased)) return@Runnable
            // A failed/expired P2P_POINT_TO_POINT bootstrap can leave the SDK's
            // radio advertisement stale even though our cached flag is still true.
            advertisingEpoch++; client.stopAdvertising(); advertising = false
            Log.i("Availability", "Refreshing idle advertising${if (force) " (scheduled cycle)" else " after endpoint closure"}")
            restore()
        }
        advertisingRefresh = refresh; main.postDelayed(refresh, 500)
    }
    private fun guardedLifecycle(endpoint: String, attempt: Any) = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(id: String, info: ConnectionInfo) {
            if (id == endpoint && attempts[id] === attempt) lifecycle.onConnectionInitiated(id, info)
        }
        override fun onConnectionResult(id: String, result: ConnectionResolution) {
            if (id == endpoint && attempts[id] === attempt) lifecycle.onConnectionResult(id, result)
        }
        override fun onDisconnected(id: String) {
            if (id == endpoint && attempts[id] === attempt) lifecycle.onDisconnected(id)
        }
        override fun onBandwidthChanged(id: String, info: BandwidthInfo) {
            if (id == endpoint && attempts[id] === attempt) lifecycle.onBandwidthChanged(id, info)
        }
    }
    private val lifecycle = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(id: String, info: ConnectionInfo) {
            val peer = info.endpointName.substringBefore("|")
            if (directSession != null || prefs.getBoolean("paused", true) || contactName(peer) == null ||
                (sessionEndpoint != null && sessionEndpoint != id)) {
                Log.i("NearbyModule", "accept gate rejected endpoint=$id peer=$peer directSession=${directSession != null} paused=${prefs.getBoolean("paused", true)} unsavedContact=${contactName(peer) == null} otherEndpointBusy=${sessionEndpoint != null && sessionEndpoint != id}")
                client.rejectConnection(id); return
            }
            // UUID filtering is not cryptographic authentication; preserve the existing trust model.
            peerIdentities[id] = peer
            val attempt = attempts.getOrPut(id) { Any() }
            client.acceptConnection(id, payloads).addOnFailureListener {
                if (attempts[id] === attempt) {
                    pending.remove(id)?.reject("ACCEPT_FAILED", it); closeEndpoint(id, "accept failed")
                }
            }
        }
        override fun onConnectionResult(id: String, result: ConnectionResolution) {
            if (result.status.isSuccess) {
                if (directSession != null || !peerIdentities.containsKey(id) || prefs.getBoolean("paused", true)) {
                    closeEndpoint(id, "stale connection result"); return
                }
                connected.add(id); pending.remove(id)?.resolve(true)
                Log.i("NearbyModule", "Connected: $id strategy=P2P_POINT_TO_POINT")
                event("onConnectionEstablished", id)
            } else {
                pending.remove(id)?.reject("CONNECT_FAILED", result.status.toString())
                closeEndpoint(id, "failed: ${result.status.statusCode}")
            }
        }
        override fun onDisconnected(id: String) {
            Log.i("CallMetrics", "endpoint=$id nearbyAudioDrops=$audioTransferDrops")
            clearEndpoint(id, "disconnected")
        }
        override fun onBandwidthChanged(id: String, info: BandwidthInfo) {
            // Quality is NOT a Wi-Fi/Bluetooth medium identifier.
            Log.i("NearbyModule", "Bandwidth changed: endpoint=$id quality=${info.quality}")
            emit("onBandwidthChanged", Arguments.createMap().apply {
                putString("connectionId", id); putInt("quality", info.quality)
            })
        }
    }
    private fun emitDiscovered(id: String, info: DiscoveredEndpointInfo) {
        val parts = info.endpointName.split("|", limit = 2)
        if (parts.size != 2 || (targets.isNotEmpty() && !targets.contains(parts[0]))) return
        emit("onPeerDiscovered", Arguments.createMap().apply {
            putString("connectionId", id); putString("peerUUID", parts[0]); putString("peerName", parts[1])
        })
    }
    private fun discoveryCallback(epoch: Int) = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(id: String, info: DiscoveredEndpointInfo) {
            if (epoch != discoveryEpoch || (!discovering && !startingDiscovery) || directSession != null) return
            if (discoveredPeers.size >= 128 && !discoveredPeers.containsKey(id))
                discoveredPeers.remove(discoveredPeers.keys.first())
            discoveredPeers[id] = info
            // Found can arrive before the startDiscovery Task succeeds. Keep it
            // and replay after success, rather than silently losing that phone.
            if (discovering) emitDiscovered(id, info)
        }
        override fun onEndpointLost(id: String) {
            if (epoch != discoveryEpoch) return
            discoveredPeers.remove(id); event("onPeerLost", id)
        }
    }
    private val payloads = object : PayloadCallback() {
        override fun onPayloadReceived(id: String, payload: Payload) {
            if (payload.type != Payload.Type.BYTES) return
            val bytes = payload.asBytes() ?: return
            if (bytes.size > 65536) return
            val data = String(bytes, Charsets.UTF_8)
            if (!observeSignal(id, data, true)) return
            emit("onDataReceived", Arguments.createMap().apply {
                putString("connectionId", id); putString("data", data)
            })
        }
        override fun onPayloadTransferUpdate(id: String, update: PayloadTransferUpdate) {
            if (update.status != PayloadTransferUpdate.Status.IN_PROGRESS) {
                confirmedTransfers.remove(update.payloadId)?.second?.let { promise ->
                    if (update.status == PayloadTransferUpdate.Status.SUCCESS) promise.resolve(true)
                    else promise.reject("SEND_FAILED", "The handoff acknowledgement could not be delivered")
                }
            }
            if (update.status != PayloadTransferUpdate.Status.IN_PROGRESS)
                audioTransfers.remove(update.payloadId)
            if (update.status == PayloadTransferUpdate.Status.FAILURE)
                Log.w("NearbyModule", "Payload transfer failed: endpoint=$id id=${update.payloadId}")
        }
    }
    private fun event(name: String, id: String, reason: String? = null) {
        emit(name, Arguments.createMap().apply {
            putString("connectionId", id); if (reason != null) putString("reason", reason)
        })
    }
    private fun emit(name: String, data: WritableMap) {
        try { sink?.invoke(name, data) } catch (e: Exception) { Log.w("NearbyModule", "UI event unavailable", e) }
    }
}

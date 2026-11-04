package com.anonymous.kelakonnect

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.NetworkInfo
import android.net.wifi.p2p.*
import android.os.Build
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.*
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class WifiDirectModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "WifiDirectModule"
        private const val SIGNAL_PORT = 9875
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val RETRY_DELAY_MS = 500L
        private const val MAX_RETRIES = 24
    }

    private val manager: WifiP2pManager? by lazy {
        reactApplicationContext.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
    }
    private var channel: WifiP2pManager.Channel? = null
    private val executor = Executors.newCachedThreadPool()
    private val isRunning = AtomicBoolean(true)
    private var signalingServer: ServerSocket? = null
    private var signalingSocket: Socket? = null
    private var signalingWriter: PrintWriter? = null
    private var isGroupOwner = false
    private var groupOwnerAddress: String? = null

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            when (intent.action) {
                WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION -> {
                    val enabled = intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1) == WifiP2pManager.WIFI_P2P_STATE_ENABLED
                    sendEvent("onWifiDirectStateChanged", Arguments.createMap().apply { putBoolean("enabled", enabled) })
                }
                WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> {
                    manager?.requestPeers(channel) { peerList ->
                        val arr = Arguments.createArray()
                        peerList.deviceList.forEach { d ->
                            arr.pushMap(Arguments.createMap().apply {
                                putString("name", d.deviceName); putString("address", d.deviceAddress); putInt("status", d.status)
                            })
                        }
                        sendEvent("onPeersFound", Arguments.createMap().apply { putArray("peers", arr) })
                    }
                }
                WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION -> {
                    val networkInfo: NetworkInfo? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        intent.getParcelableExtra(WifiP2pManager.EXTRA_NETWORK_INFO, NetworkInfo::class.java)
                    } else { @Suppress("DEPRECATION") intent.getParcelableExtra(WifiP2pManager.EXTRA_NETWORK_INFO) }
                    if (networkInfo?.isConnected == true) {
                        manager?.requestConnectionInfo(channel) { info ->
                            if (info.groupFormed) {
                                isGroupOwner = info.isGroupOwner
                                groupOwnerAddress = info.groupOwnerAddress?.hostAddress
                                Log.d(TAG, "Group formed | owner=$isGroupOwner | GO=$groupOwnerAddress")
                                sendEvent("onGroupFormed", Arguments.createMap().apply {
                                    putBoolean("isGroupOwner", isGroupOwner)
                                    putString("groupOwnerAddress", groupOwnerAddress ?: "")
                                })
                                if (isGroupOwner) startSignalingServer()
                                else groupOwnerAddress?.let { connectSignalingClient(it) }
                            }
                        }
                    } else {
                        sendEvent("onGroupRemoved", Arguments.createMap())
                        cleanupSockets()
                    }
                }
            }
        }
    }

    private val intentFilter = IntentFilter().apply {
        addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
        addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
        addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
        addAction(WifiP2pManager.WIFI_P2P_THIS_DEVICE_CHANGED_ACTION)
    }

    override fun getName() = "WifiDirectModule"

    override fun initialize() {
        super.initialize()
        channel = manager?.initialize(reactApplicationContext, Looper.getMainLooper(), null)
        reactApplicationContext.registerReceiver(receiver, intentFilter)
    }

    override fun invalidate() {
        super.invalidate()
        isRunning.set(false)
        try { reactApplicationContext.unregisterReceiver(receiver) } catch (_: Exception) {}
        cleanupSockets(); removeGroupInternal(); executor.shutdownNow()
    }

    @ReactMethod fun discoverPeers(promise: Promise) {
        val mgr = manager ?: return promise.reject("NO_MANAGER","unavailable")
        val ch = channel ?: return promise.reject("NO_CHANNEL","not init")
        mgr.discoverPeers(ch, object : WifiP2pManager.ActionListener {
            override fun onSuccess() { promise.resolve(true) }
            override fun onFailure(r: Int) { promise.reject("FAILED","reason=$r") }
        })
    }

    @ReactMethod fun stopDiscovery(promise: Promise) {
        val mgr = manager ?: return promise.resolve(false)
        val ch = channel ?: return promise.resolve(false)
        mgr.stopPeerDiscovery(ch, object : WifiP2pManager.ActionListener {
            override fun onSuccess() { promise.resolve(true) }
            override fun onFailure(r: Int) { promise.resolve(false) }
        })
    }

    @ReactMethod fun createGroup(promise: Promise) {
        val mgr = manager ?: return promise.reject("NO_MANAGER","unavailable")
        val ch = channel ?: return promise.reject("NO_CHANNEL","not init")
        mgr.removeGroup(ch, object : WifiP2pManager.ActionListener {
            override fun onSuccess() { doCreateGroup(mgr, ch, promise) }
            override fun onFailure(r: Int) { doCreateGroup(mgr, ch, promise) }
        })
    }

    private fun doCreateGroup(mgr: WifiP2pManager, ch: WifiP2pManager.Channel, promise: Promise) {
        val listener = object : WifiP2pManager.ActionListener {
            override fun onSuccess() {
                mgr.requestGroupInfo(ch) { group ->
                    promise.resolve(Arguments.createMap().apply {
                        putString("ssid", group?.networkName ?: "")
                        putString("passphrase", group?.passphrase ?: "")
                        putString("ownerAddress", group?.owner?.deviceAddress ?: "")
                    })
                }
            }
            override fun onFailure(r: Int) { promise.reject("CREATE_FAILED","reason=$r") }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            mgr.createGroup(ch, WifiP2pConfig.Builder()
                .setNetworkName("DIRECT-KK-${(1000..9999).random()}")
                .setPassphrase(genPassphrase()).build(), listener)
        } else { mgr.createGroup(ch, listener) }
    }

    @ReactMethod fun connectToPeer(deviceAddress: String, promise: Promise) {
        val mgr = manager ?: return promise.reject("NO_MANAGER","unavailable")
        val ch = channel ?: return promise.reject("NO_CHANNEL","not init")
        mgr.connect(ch, WifiP2pConfig().apply { this.deviceAddress = deviceAddress; wps.setup = android.net.wifi.WpsInfo.PBC },
            object : WifiP2pManager.ActionListener {
                override fun onSuccess() { promise.resolve(true) }
                override fun onFailure(r: Int) { promise.reject("CONNECT_FAILED","reason=$r") }
            })
    }

    @ReactMethod fun removeGroup(promise: Promise) { removeGroupInternal(); promise.resolve(true) }

    @ReactMethod fun sendSignal(message: String, promise: Promise) {
        val writer = signalingWriter ?: return promise.reject("NO_SOCKET","Signaling not ready")
        executor.execute {
            try { writer.println(message); writer.flush()
                if (writer.checkError()) promise.reject("WRITE_ERROR","stream error") else promise.resolve(true)
            } catch (e: Exception) { promise.reject("SEND_ERROR", e.message) }
        }
    }

    @ReactMethod fun addListener(e: String) {}
    @ReactMethod fun removeListeners(n: Int) {}

    private fun startSignalingServer() {
        executor.execute {
            try {
                try { signalingServer?.close() } catch (_: Exception) {}
                signalingServer = ServerSocket(SIGNAL_PORT)
                val sock = signalingServer!!.accept()
                signalingSocket = sock
                signalingWriter = PrintWriter(BufferedWriter(OutputStreamWriter(sock.getOutputStream())), true)
                Log.d(TAG, "Signaling client connected: ${sock.inetAddress.hostAddress}")
                sendEvent("onSignalingSocketReady", Arguments.createMap().apply { putBoolean("isServer", true) })
                readSignals(sock)
            } catch (e: Exception) {
                if (isRunning.get()) sendEvent("onConnectionFailed", Arguments.createMap().apply { putString("error","Signaling server: ${e.message}") })
            }
        }
    }

    private fun connectSignalingClient(ownerIp: String) {
        executor.execute {
            repeat(MAX_RETRIES) { attempt ->
                if (!isRunning.get()) return@execute
                try {
                    val sock = Socket(); sock.connect(InetSocketAddress(ownerIp, SIGNAL_PORT), CONNECT_TIMEOUT_MS)
                    signalingSocket = sock
                    signalingWriter = PrintWriter(BufferedWriter(OutputStreamWriter(sock.getOutputStream())), true)
                    Log.d(TAG, "Signaling connected to server")
                    sendEvent("onSignalingSocketReady", Arguments.createMap().apply { putBoolean("isServer", false) })
                    readSignals(sock); return@execute
                } catch (e: Exception) {
                    if (attempt < MAX_RETRIES - 1) Thread.sleep(RETRY_DELAY_MS)
                    else sendEvent("onConnectionFailed", Arguments.createMap().apply { putString("error","Could not reach peer signaling server") })
                }
            }
        }
    }

    private fun readSignals(sock: Socket) {
        executor.execute {
            try {
                val reader = BufferedReader(InputStreamReader(sock.getInputStream()))
                var line: String?
                while (reader.readLine().also { line = it } != null)
                    sendEvent("onSignalReceived", Arguments.createMap().apply { putString("data", line!!) })
            } catch (e: Exception) { if (isRunning.get()) Log.d(TAG,"Signal read ended: ${e.message}") }
            if (isRunning.get()) sendEvent("onPeerDisconnected", Arguments.createMap())
        }
    }

    private fun removeGroupInternal() {
        manager?.removeGroup(channel, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {} override fun onFailure(r: Int) {}
        })
    }

    private fun cleanupSockets() {
        try { signalingWriter?.close() } catch (_: Exception) {}
        try { signalingSocket?.close() } catch (_: Exception) {}
        try { signalingServer?.close() } catch (_: Exception) {}
        signalingWriter=null; signalingSocket=null; signalingServer=null
    }

    private fun sendEvent(name: String, params: WritableMap?) {
        reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, params)
    }

    private fun genPassphrase() = (1..12).map { "abcdefghijklmnopqrstuvwxyz0123456789".random() }.joinToString("")
}

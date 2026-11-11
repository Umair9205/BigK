package com.anonymous.kelakonnect
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.location.LocationManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

/** Thin UI bridge; the application-scoped transport survives React invalidation. */
class NearbyModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val transport = NearbyTransport.get(context)
    // Nearby is unplugged for the Wi-Fi Direct call path (step 4): the JS bridge
    // flips this off and the transport refuses to touch advertising/discovery
    // while it is false, so Bluetooth is never switched on for a call.
    @Volatile private var nearbyEnabled = true
        private set
    @ReactMethod fun setNearbyEnabled(enabled: Boolean, promise: Promise) {
        if (enabled) { nearbyEnabled = true; transport.setEnabled(true) } else { nearbyEnabled = false; transport.setEnabled(false) }
        promise.resolve(enabled)
    }
    private val emitter: (String, WritableMap) -> Unit = { name, data ->
        if (context.hasActiveReactInstance()) context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, data)
    }
    override fun getName() = "NearbyModule"
    private fun locationEnabled() = (context.getSystemService(Context.LOCATION_SERVICE) as LocationManager).isLocationEnabled
    private val locationReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            emitter("onLocationStateChanged", Arguments.createMap().apply { putBoolean("enabled", locationEnabled()) })
        }
    }
    override fun initialize() {
        super.initialize(); transport.sink = emitter
        ContextCompat.registerReceiver(context, locationReceiver, IntentFilter(LocationManager.MODE_CHANGED_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED)
    }
    @ReactMethod fun isLocationEnabled(promise: Promise) {
        try { promise.resolve(locationEnabled()) } catch (e: Exception) { promise.reject("LOCATION_CHECK", e) }
    }
    @ReactMethod fun openLocationSettings(promise: Promise) {
        try { context.startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); promise.resolve(true) }
        catch (e: Exception) { promise.reject("LOCATION_SETTINGS", e) }
    }
    @ReactMethod fun configureAvailability(uuid: String, name: String, contacts: String, audible: Boolean, promise: Promise) {
        if (!nearbyEnabled) { promise.resolve(true); return }
        transport.configure(uuid, name, contacts, audible); promise.resolve(true)
    }
    @ReactMethod fun pendingIncoming(promise: Promise) = transport.pendingIncoming(promise)
    @ReactMethod fun retainConnection(id: String) = transport.retainConnection(id)
    @ReactMethod fun releaseForDirectCall(id: String, promise: Promise) = transport.releaseForDirectCall(id, promise)
    @ReactMethod fun resumeAfterDirectCall(id: String, promise: Promise) = transport.resumeAfterDirectCall(id, promise)
    @ReactMethod fun startAdvertising(uuid: String, name: String, promise: Promise) {
        if (!nearbyEnabled) { promise.resolve(false); return }
        transport.startAdvertising(uuid, name, promise)
    }
    @ReactMethod fun startDiscovery(uuids: ReadableArray, promise: Promise) {
        if (!nearbyEnabled) { promise.resolve(false); return }
        transport.startDiscovery(uuids, promise)
    }
    @ReactMethod fun connect(id: String, promise: Promise) = transport.connect(id, promise)
    @ReactMethod fun stopAdvertising(promise: Promise) = transport.stopAdvertising(promise)
    @ReactMethod fun isConnected(id: String, promise: Promise) = transport.isConnected(id, promise)
    @ReactMethod fun stopDiscovery(promise: Promise) = transport.stopDiscovery(promise)
    @ReactMethod fun sendData(id: String, data: String, promise: Promise) = transport.sendData(id, data, promise)
    @ReactMethod fun sendDataConfirmed(id: String, data: String, promise: Promise) = transport.sendData(id, data, promise, true)
    @ReactMethod fun closeConnection(id: String, promise: Promise) = transport.closeConnection(id, promise)
    @ReactMethod fun addListener(name: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
    override fun invalidate() {
        try { context.unregisterReceiver(locationReceiver) } catch (_: Exception) {}
        if (transport.sink === emitter) transport.sink = null
        if (!AvailabilityService.running) transport.pause()
        super.invalidate()
    }
}

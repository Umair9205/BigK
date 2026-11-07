package com.anonymous.kelakonnect

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationManagerCompat
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

class CallForegroundServiceModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "CallForegroundServiceModule"
    }

    override fun getName() = "CallForegroundServiceModule"

    private fun awaitForeground(promise: Promise, ready: () -> Boolean) {
        val handler = Handler(Looper.getMainLooper())
        fun check(attempt: Int) {
            if (ready()) promise.resolve(true)
            else if (attempt >= 100) promise.reject("SERVICE_START_FAILED", "Android did not start the foreground service")
            else handler.postDelayed({ check(attempt + 1) }, 50)
        }
        handler.post { check(0) }
    }

    @ReactMethod fun startAvailability(resume: Boolean, promise: Promise) {
        val prefs = reactContext.getSharedPreferences("availability", 0)
        if (resume || !prefs.contains("paused")) prefs.edit().putBoolean("paused", false).apply()
        if (prefs.getBoolean("paused", false)) { promise.reject("PAUSED", "Local availability is paused"); return }
        try {
            ContextCompat.startForegroundService(reactContext, Intent(reactContext, AvailabilityService::class.java))
            awaitForeground(promise) { AvailabilityService.running }
        } catch (e: Exception) { promise.reject("UNAVAILABLE", e) }
    }
    @ReactMethod fun stopAvailability(promise: Promise) {
        reactContext.getSharedPreferences("availability", 0).edit().putBoolean("paused", true).apply()
        NearbyTransport.get(reactContext).pause()
        reactContext.stopService(Intent(reactContext, AvailabilityService::class.java))
        promise.resolve(true)
    }
    @ReactMethod fun availabilityStatus(promise: Promise) {
        promise.resolve(Arguments.createMap().apply {
            putBoolean("running", AvailabilityService.running)
            putBoolean("paused", reactContext.getSharedPreferences("availability", 0).getBoolean("paused", false))
            putBoolean("notifications", NotificationManagerCompat.from(reactContext).areNotificationsEnabled())
            putBoolean("scanning", NearbyTransport.get(reactContext).isDiscovering)
            putBoolean("advertising", NearbyTransport.get(reactContext).isAdvertising)
            val vpn = vpnStatusMap()
            putBoolean("vpnEnabled", vpn.getBoolean("enabled"))
            putBoolean("vpnActive", vpn.getBoolean("active"))
            putBoolean("otherVpn", vpn.getBoolean("otherVpn"))
        })
    }

    @ReactMethod fun vpnStatus(promise: Promise) {
        promise.resolve(vpnStatusMap())
    }

    /** Release or reclaim the VPN slot without changing call availability.
     *  Off is the escape hatch for banking apps and a user's own VPN. */
    @ReactMethod fun setVpnEnabled(enabled: Boolean, promise: Promise) {
        try {
            KeeperVpnService.setEnabled(reactContext, enabled)
            promise.resolve(vpnStatusMap())
        } catch (e: Exception) {
            promise.reject("VPN_TOGGLE", "Could not change VPN protection", e)
        }
    }

    private fun vpnStatusMap(): WritableMap = Arguments.createMap().apply {
        val enabled = KeeperVpnService.isEnabled(reactContext)
        putBoolean("enabled", enabled)
        // Teardown is asynchronous; report the user's intent immediately.
        putBoolean("active", enabled && KeeperVpnService.established)
        putBoolean("otherVpn", KeeperVpnService.anotherVpnActive(reactContext))
    }
    @ReactMethod fun showIncoming(id: String, name: String, audible: Boolean, promise: Promise) {
        try { IncomingCallNotification.show(reactContext, id, name, audible); promise.resolve(true) }
        catch (e: Exception) { promise.reject("NOTIFICATION", e) }
    }
    @ReactMethod fun dismissIncoming(id: String) { IncomingCallNotification.dismiss(reactContext, id) }
    @ReactMethod fun consumeCallAction(id: String, promise: Promise) {
        val intent = currentActivity?.intent
        if (intent?.getStringExtra("localCallSession") != id || !IncomingCallNotification.permits(id, intent.getStringExtra("localCallToken"))) { promise.resolve(null); return }
        val action = intent.getStringExtra("localCallAction")
        intent.removeExtra("localCallAction"); intent.removeExtra("localCallSession"); intent.removeExtra("localCallToken")
        promise.resolve(action)
    }
    @ReactMethod fun openBatterySettings(promise: Promise) {
        try {
            reactContext.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("BATTERY_SETTINGS", "Could not open Android battery settings", e)
        }
    }

    /** Is the app already on Android's battery-optimization exemption list? */
    @ReactMethod fun isBatteryUnrestricted(promise: Promise) {
        try {
            val pm = reactContext.getSystemService(PowerManager::class.java)
            promise.resolve(pm?.isIgnoringBatteryOptimizations(reactContext.packageName) == true)
        } catch (e: Exception) {
            promise.reject("BATTERY_STATE", "Could not read battery optimization state", e)
        }
    }

    /**
     * Launch Android's own "let this app run in the background?" dialog for this
     * package. Round 18: without this exemption Transsion's Usf_Hiber froze the
     * running foreground service 5 s after Home and background receive died with
     * it. Some OEMs refuse the direct dialog — fall back to the settings page.
     */
    @ReactMethod fun requestBatteryExemption(promise: Promise) {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${reactContext.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            reactContext.startActivity(direct)
            Log.i(TAG, "Battery exemption dialog requested")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.w(TAG, "Direct battery exemption dialog refused (${e.message}); opening battery settings")
            try {
                reactContext.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                promise.resolve(true)
            } catch (e2: Exception) {
                promise.reject("BATTERY_EXEMPT", "Could not open Android battery settings", e2)
            }
        }
    }

    @ReactMethod fun openRingtoneSettings(promise: Promise) {
        try {
            val channel = IncomingCallNotification.ensureChannel(reactContext)
            val intent = Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, reactContext.packageName)
                .putExtra(Settings.EXTRA_CHANNEL_ID, channel.id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) { promise.reject("RINGTONE_SETTINGS", "Could not open Android call sound settings", e) }
    }

    @ReactMethod fun getRingtoneSettings(promise: Promise) {
        try {
            val channel = IncomingCallNotification.ensureChannel(reactContext)
            val sound = channel.sound
            val title = if (sound == null) "Silent" else try {
                android.media.RingtoneManager.getRingtone(reactContext, sound)?.getTitle(reactContext) ?: "Selected Android sound"
            } catch (_: Exception) { "Selected Android sound" }
            promise.resolve(Arguments.createMap().apply {
                putString("name", title)
                putBoolean("notificationsEnabled", NotificationManagerCompat.from(reactContext).areNotificationsEnabled())
                putBoolean("channelEnabled", channel.importance != android.app.NotificationManager.IMPORTANCE_NONE)
                putBoolean("soundAllowed", sound != null && channel.importance >= android.app.NotificationManager.IMPORTANCE_DEFAULT)
                putBoolean("vibration", channel.shouldVibrate())
            })
        } catch (e: Exception) { promise.reject("RINGTONE_SETTINGS", "Could not read Android call sound settings", e) }
    }

    @ReactMethod
    fun startCallService(peerName: String, promise: Promise) {
        try {
            val intent = Intent(reactContext, CallForegroundService::class.java).apply {
                putExtra("peerName", peerName)
                action = "START_CALL"
            }

            // Start foreground service
            ContextCompat.startForegroundService(reactContext, intent)

            Log.d(TAG, "Call foreground service started for: $peerName")
            awaitForeground(promise) { CallForegroundService.running }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start service: ${e.message}")
            promise.reject("START_SERVICE_FAILED", e.message)
        }
    }

    @ReactMethod
    fun stopCallService(promise: Promise) {
        try {
            // Apply the window flags on the UI thread and wait until they have
            // been applied before resolving. JS navigates away (router.back())
            // once this promise resolves; without the wait,
            // setShowWhenLocked(false) has not run yet and the home screen can
            // flash over the lockscreen after a call ends while the phone is
            // locked.
            val latch = java.util.concurrent.CountDownLatch(1)
            Handler(Looper.getMainLooper()).post {
                try {
                    if (Build.VERSION.SDK_INT >= 27) {
                        currentActivity?.setShowWhenLocked(false)
                        currentActivity?.setTurnScreenOn(false)
                    }
                } finally {
                    latch.countDown()
                }
            }
            if (!latch.await(2, java.util.concurrent.TimeUnit.SECONDS)) {
                android.util.Log.w(TAG, "stopCallService: UI thread did not apply window flags in time")
            }
            val intent = Intent(reactContext, CallForegroundService::class.java)

            // Stop foreground service
            reactContext.stopService(intent)

            Log.d(TAG, "Call foreground service stopped")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to stop service: ${e.message}")
            promise.reject("STOP_SERVICE_FAILED", e.message)
        }
    }

    @ReactMethod
    fun addListener(e: String) {}

    @ReactMethod
    fun removeListeners(n: Int) {}
}

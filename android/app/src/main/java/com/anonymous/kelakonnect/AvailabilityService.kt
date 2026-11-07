package com.anonymous.kelakonnect

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat

/** Idle connectivity only. Never declares microphone use or claims immunity to process death. */
class AvailabilityService : Service() {
    companion object {
        @Volatile var running = false
            private set
        const val CHANNEL = "local_availability"
        /** Paired P2P + Nearby probes. 5s: a 20s tick brackets a walk-away
         *  death point to 20-28m of walking, which is wider than the range we
         *  are trying to measure — unusable. 5s gives 5-7m brackets. The probe
         *  is one discoverPeers kick plus one requestPeers read; skipped
         *  entirely mid-call (probePeerRadio gates on radioReleased), so the
         *  rate only applies while idle. Faster ticks also keep mPeers warm
         *  between calls, which the round-13 MAC-keyed path needs. */
        private const val WATCHDOG_INTERVAL_MS = 5_000L
    }
    private val mainHandler = Handler(Looper.getMainLooper())
    // No partial wakelock (round 25). The VPN exemption is the freeze fix; the
    // CPU is allowed to sleep between packets. The old permanent
    // PARTIAL_WAKE_LOCK was only a workaround for the pre-VPN freezes and cost
    // battery for the whole session. If a screen-off call cannot wake the
    // process, the fix is packet-driven (Wi-Fi Direct / Nearby), not a
    // permanent lock.
    // Foreground-service stickiness covers process death only. A stuck call session
    // or a silently dropped advertisement must also self-heal without React Native.
    private val watchdog = object : Runnable {
        override fun run() {
            if (!running) return
            NearbyTransport.get(this@AvailabilityService).healthWatchdog()
            // Independent read of the Wi-Fi Direct radio. Nearby's bootstrap on
            // this hardware is BLE, so a phone that Nearby cannot reach may
            // still be reachable here — and only a separate probe can say so.
            DirectWifiModule.probePeerRadio(this@AvailabilityService, "watchdog")
            // Paired Nearby read so the two paths can be compared at one timestamp.
            NearbyTransport.get(this@AvailabilityService).probeNearbySnapshot("watchdog")
            ensureKeepAliveSurface()
            // Separate service: the system destroys a VpnService when its
            // tunnel is revoked, and availability must outlive that.
            KeeperVpnService.sync(this@AvailabilityService)
            mainHandler.postDelayed(this, WATCHDOG_INTERVAL_MS)
        }
    }
    override fun onBind(intent: Intent?) = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "PAUSE") {
            android.util.Log.i("Availability", "Stopping: PAUSE action requested")
            getSharedPreferences("availability", MODE_PRIVATE).edit().putBoolean("paused", true).apply()
            NearbyTransport.get(this).pause()
            mainHandler.removeCallbacks(watchdog)
            TrafficKeepAlive.stop()
            KeeperOverlay.hide(this)
            KeeperVpnService.stop(this)
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == "TOGGLE_VPN") {
            val enable = !KeeperVpnService.isEnabled(this)
            android.util.Log.i("Availability", "VPN protection toggle requested: ${if (enable) "on" else "off"}")
            KeeperVpnService.setEnabled(this, enable)
            // The notification is the only surface that can flip the switch while
            // the app is backgrounded. Rebuild it in place so the action label
            // follows the new state. If the service was not actually running,
            // fall through to a normal start.
            if (running) {
                try { showNotification() } catch (e: Exception) {
                    android.util.Log.w("Availability", "VPN toggle notification refresh failed", e)
                }
                return START_STICKY
            }
        }
        if (getSharedPreferences("availability", MODE_PRIVATE).getBoolean("paused", true)) {
            android.util.Log.i("Availability", "Stopping: availability is paused")
            stopSelf(); return START_NOT_STICKY
        }
        try {
            showNotification()
            running = true
            NearbyTransport.get(this).restore()
            mainHandler.removeCallbacks(watchdog)
            mainHandler.postDelayed(watchdog, WATCHDOG_INTERVAL_MS)
            TrafficKeepAlive.start(this)
            KeeperVpnService.sync(this)
        } catch (e: Exception) {
            running = false
            android.util.Log.e("Availability", "Foreground startup failed", e)
            stopSelf()
        }
        // Android may restart this service after process death. Restore the actual listener,
        // not just the notification. Force stop and vendor restrictions remain authoritative.
        return if (running) START_STICKY else START_NOT_STICKY
    }
    /** The availability notification carries both controls: pause everything,
     *  or release only the VPN slot (banking apps and another VPN need it).
     *  Rebuilt after a toggle so the action label follows the state. */
    private fun buildNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Local calling availability", NotificationManager.IMPORTANCE_LOW))
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val open = PendingIntent.getActivity(this, 300, Intent(this, MainActivity::class.java), flags)
        val pause = PendingIntent.getService(this, 301, Intent(this, AvailabilityService::class.java).setAction("PAUSE"), flags)
        val vpn = PendingIntent.getService(this, 302, Intent(this, AvailabilityService::class.java).setAction("TOGGLE_VPN"), flags)
        val vpnOn = KeeperVpnService.isEnabled(this)
        val vpnState = when {
            !vpnOn -> "VPN off"
            KeeperVpnService.established -> "VPN on"
            else -> "VPN starting"
        }
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.sym_action_call).setContentTitle("BigK local calling enabled")
            .setContentText("Listening for nearby calls · $vpnState")
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(0, "Pause availability", pause)
            .addAction(0, if (vpnOn) "Turn off VPN" else "Turn on VPN", vpn)
            .build()
    }

    private fun showNotification() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) startForeground(43, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        else startForeground(43, notification)
    }

    /** Nov 6 experiment, step 2. Every observed freeze left the uid with no
     *  visible window, and the system itself refused the keeper activity start
     *  while none existed ("callingUidHasNonAppVisibleWindow: false"). A window
     *  can be added from a service at any time, so it is attached as soon as
     *  the app is backgrounded and removed the moment the UI is back. */
    private fun ensureKeepAliveSurface() {
        try {
            val info = ActivityManager.RunningAppProcessInfo()
            ActivityManager.getMyMemoryState(info)
            if (info.importance > ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) {
                KeeperOverlay.show(this)
            } else {
                KeeperOverlay.hide(this)
            }
        } catch (e: Exception) {
            android.util.Log.w("Availability", "Keep-alive surface check failed", e)
        }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        android.util.Log.i("Availability", "Recent task removed; native listener remains enabled")
        NearbyTransport.get(this).restore()
        super.onTaskRemoved(rootIntent)
    }
    override fun onDestroy() {
        // Round 17 lost its watchdog here with no trace — three silent stopSelf
        // paths made it impossible to say which one fired. Name the state so the
        // next occurrence is attributable.
        val paused = getSharedPreferences("availability", MODE_PRIVATE).getBoolean("paused", true)
        android.util.Log.i("Availability", "Service destroyed; watchdog cancelled (paused=$paused wasRunning=$running)")
        running = false
        KeeperOverlay.hide(this)
        KeeperVpnService.stop(this)
        mainHandler.removeCallbacks(watchdog)
        TrafficKeepAlive.stop()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}

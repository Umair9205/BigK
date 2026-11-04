package com.anonymous.kelakonnect

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
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
    private var wakeLock: PowerManager.WakeLock? = null
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
            releaseWakeLock()
            stopSelf()
            return START_NOT_STICKY
        }
        if (getSharedPreferences("availability", MODE_PRIVATE).getBoolean("paused", true)) {
            android.util.Log.i("Availability", "Stopping: availability is paused")
            stopSelf(); return START_NOT_STICKY
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Local calling availability", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 300, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val pause = PendingIntent.getService(this, 301, Intent(this, AvailabilityService::class.java).setAction("PAUSE"), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.sym_action_call).setContentTitle("BigK local calling enabled")
            .setContentText("Listening for nearby calls · Tap to open")
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(0, "Pause availability", pause).build()
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(43, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
            else startForeground(43, notification)
            running = true
            holdWakeLock()
            NearbyTransport.get(this).restore()
            mainHandler.removeCallbacks(watchdog)
            mainHandler.postDelayed(watchdog, WATCHDOG_INTERVAL_MS)
            TrafficKeepAlive.start(this)
        } catch (e: Exception) {
            running = false
            android.util.Log.e("Availability", "Foreground startup failed", e)
            stopSelf()
        }
        // Android may restart this service after process death. Restore the actual listener,
        // not just the notification. Force stop and vendor restrictions remain authoritative.
        return if (running) START_STICKY else START_NOT_STICKY
    }
    /** A phone that is asleep can still be rung, but only if the process is
     *  running when the request arrives. The accept itself is never slow — on
     *  hardware it completes in 0.04-0.07s every single time — so the loss is
     *  entirely in delivery, and a screen-off callee is the one failure mode
     *  with no protection at all. Partial keeps the CPU up and leaves the
     *  display alone. */
    private fun holdWakeLock() {
        try {
            // onStartCommand runs repeatedly (START_STICKY restarts, repeated
            // starts) and each call used to allocate a fresh WakeLock over the
            // old reference without releasing it — the orphaned objects were
            // then finalized while still held (7 holds, 7 finalizations in one
            // session). Non-refcounted with a fixed tag, so an already-held
            // lock needs nothing further; only a null or system-reclaimed
            // reference is worth a new allocation.
            if (wakeLock?.isHeld == true) return
            val power = getSystemService(PowerManager::class.java)
            wakeLock = power?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kelakonnect:availability")
            wakeLock?.setReferenceCounted(false)
            wakeLock?.acquire()
            android.util.Log.i("Availability", "Holding partial wakelock; screen stays off")
        } catch (e: Exception) { android.util.Log.w("Availability", "Wakelock unavailable", e) }
    }
    private fun releaseWakeLock() {
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) {}
        wakeLock = null
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
        mainHandler.removeCallbacks(watchdog)
        TrafficKeepAlive.stop()
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}

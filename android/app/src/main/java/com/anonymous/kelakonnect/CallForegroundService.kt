package com.anonymous.kelakonnect

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat

class CallForegroundService : Service() {

    companion object {
        @Volatile var running = false
            private set
        private const val TAG = "CallForegroundService"
        private const val NOTIFICATION_ID = 42
        private const val CHANNEL_ID = "kela_konnect_call"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "Call foreground service started")

        val notification = buildNotification()
        try {
            startForeground(NOTIFICATION_ID, notification)
            running = true
            Log.d(TAG, "✅ Foreground service started successfully")
        } catch (e: SecurityException) {
            Log.e(TAG, "❌ Failed to start foreground service: ${e.message}")
            stopSelf()
        } catch (e: Exception) {
            Log.e(TAG, "❌ Unexpected error starting foreground: ${e.message}")
            stopSelf()
        }

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
        Log.d(TAG, "Call foreground service destroyed")
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    override fun onBind(intent: Intent?) = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "BigK calls",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Call in progress notification"
            }
            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification() = NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle("BigK voice call")
        .setContentText("Tap to return to call")
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setAutoCancel(false)
        .setOngoing(true)
        .setContentIntent(getPendingIntent())
        .build()

    private fun getPendingIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
        )
    }
}

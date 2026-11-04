package com.anonymous.kelakonnect

import android.app.*
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.Person

object IncomingCallNotification {
    private const val ID = 44
    private const val CHANNEL = "local_incoming_calls"
    private var session: String? = null
    private var actionToken: String? = null
    private val handler = Handler(Looper.getMainLooper())
    fun dismiss(context: Context, id: String) {
        if (session != id) return
        session = null
        actionToken = null
        context.getSystemService(NotificationManager::class.java).cancel(ID)
    }
    fun matches(id: String) = session == id
    fun permits(id: String, token: String?) = matches(id) && token != null && actionToken == token
    /** Keep a stable channel. Android persists the user's sound/vibration choices. */
    fun ensureChannel(context: Context, audible: Boolean = true): NotificationChannel {
        val manager = context.getSystemService(NotificationManager::class.java)
        val id = if (audible) CHANNEL else CHANNEL + "_silent"
        manager.getNotificationChannel(id)?.let { return it }
        val channel = NotificationChannel(id, "Incoming local calls" + if (audible) "" else " (silent)", NotificationManager.IMPORTANCE_HIGH).apply {
            enableVibration(audible)
            setSound(if (audible) RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE) else null,
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build())
        }
        manager.createNotificationChannel(channel)
        return manager.getNotificationChannel(id) ?: channel
    }
    fun show(context: Context, id: String, name: String, audible: Boolean) {
        if (session == id) return
        session = id
        actionToken = java.util.UUID.randomUUID().toString()
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = ensureChannel(context, audible).id
        fun action(action: String, code: Int): PendingIntent = PendingIntent.getActivity(context, code,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra("localCallSession", id); putExtra("localCallAction", action)
                putExtra("localCallToken", actionToken)
            }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val open = action("open", 310)
        val builder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentTitle(name.take(80)).setContentText("Incoming local voice call")
            .setCategory(NotificationCompat.CATEGORY_CALL).setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setOngoing(true)
            .setContentIntent(open).setTimeoutAfter(45000)
            .setSilent(!audible)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(
                Person.Builder().setName(name.take(80).ifBlank { "Contact" }).build(),
                action("decline", 311), action("answer", 312)))
        if (Build.VERSION.SDK_INT < 34 || manager.canUseFullScreenIntent()) builder.setFullScreenIntent(open, true)
        val notification = builder.build()
        if (audible) notification.flags = notification.flags or Notification.FLAG_INSISTENT
        manager.notify(ID, notification)
        handler.postDelayed({ dismiss(context, id) }, 45000)
    }
}

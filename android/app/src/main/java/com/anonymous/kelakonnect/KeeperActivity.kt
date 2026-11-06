package com.anonymous.kelakonnect

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.WindowManager
import java.lang.ref.WeakReference

/**
 * 1x1 keep-alive surface — experiment, Nov 6 2026.
 *
 * Why: XOS's Usf_Hiber freezes a backgrounded uid ~5s after Home even with a
 * foreground service + wakelock (round 21) and even with a system-held
 * notification-listener binding in BFGS state (Nov 6 controlled experiment).
 * Every freeze observed so far ends with the app having no visible window.
 * Visible-activity state is the one signal not yet disproven, so this activity
 * keeps one attached while the app is backgrounded: 1x1, translucent,
 * non-touchable and non-focusable, so it cannot cover content or steal input.
 *
 * Kept intentionally single-call-site: MainActivity onStart/onStop and the
 * AvailabilityService watchdog. Deleting this file plus that wiring reverts
 * the experiment.
 */
class KeeperActivity : Activity() {

    companion object {
        private const val TAG = "Keeper"
        private const val START_DEBOUNCE_MS = 2_000L

        @Volatile
        var showing = false
            private set

        @Volatile
        private var lastStartAt = 0L

        private var instance: WeakReference<KeeperActivity>? = null

        fun show(context: Context) {
            if (showing) return
            val now = SystemClock.elapsedRealtime()
            if (now - lastStartAt < START_DEBOUNCE_MS) return
            lastStartAt = now
            try {
                context.startActivity(
                    Intent(context, KeeperActivity::class.java)
                        .addFlags(
                            Intent.FLAG_ACTIVITY_NEW_TASK
                                or Intent.FLAG_ACTIVITY_NO_ANIMATION
                                or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                        )
                )
                Log.i(TAG, "show requested")
            } catch (e: Exception) {
                // Background activity launch restrictions surface here.
                Log.w(TAG, "show failed", e)
            }
        }

        fun hide(context: Context) {
            val activity = instance?.get() ?: return
            try {
                Log.i(TAG, "hide requested")
                activity.finishAndRemoveTask()
            } catch (e: Exception) {
                Log.w(TAG, "hide failed", e)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showing = true
        instance = WeakReference(this)
        window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        window.addFlags(
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
        )
        window.setDimAmount(0f)
        try {
            window.setLayout(1, 1)
        } catch (_: Exception) {
        }
        setContentView(View(this).apply { setBackgroundColor(Color.TRANSPARENT) })
        Log.i(TAG, "activity created; keep-alive surface attached")
    }

    override fun onStop() {
        // Covered by another task: nothing is being kept visible any more, so
        // allow the watchdog to attach a fresh surface next time it matters.
        showing = false
        super.onStop()
    }

    override fun onDestroy() {
        showing = false
        instance = null
        Log.i(TAG, "activity destroyed")
        super.onDestroy()
    }
}

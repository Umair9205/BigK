package com.anonymous.kelakonnect

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager

/**
 * 1x1 invisible overlay window — experiment, Nov 6 2026 (step 2).
 *
 * A plain SAW grant does not exempt background activity starts: the system
 * wants a *visible window* before it will honour one
 * ("Background activity launch blocked ... callingUidHasNonAppVisibleWindow:
 * false"). A window, unlike an activity, can be added from a service at any
 * time, so this is attached first. Two independent things are being measured:
 *   1. does a visible window by itself keep Usf_Hiber away, and
 *   2. if not, does it at least unlock the KeeperActivity start.
 *
 * Deliberately 1x1, transparent, non-focusable and non-touchable: it must not
 * affect what the user sees or taps.
 */
object KeeperOverlay {
    private const val TAG = "Keeper"

    @Volatile
    var attached = false
        private set

    private var view: View? = null
    private var params: WindowManager.LayoutParams? = null

    private fun windowManager(context: Context): WindowManager? =
        context.getSystemService(WindowManager::class.java)

    fun show(context: Context) {
        if (attached) return
        val wm = windowManager(context) ?: return
        try {
            val v = View(context).apply { setBackgroundColor(Color.TRANSPARENT) }
            val lp = WindowManager.LayoutParams(
                1,
                1,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                    or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                    or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                    or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT
            ).apply {
                gravity = Gravity.TOP or Gravity.START
                x = 0
                y = 0
            }
            wm.addView(v, lp)
            view = v
            params = lp
            attached = true
            Log.i(TAG, "overlay attached (1x1, invisible, non-touchable)")
        } catch (e: Exception) {
            Log.w(TAG, "overlay attach failed", e)
        }
    }

    fun hide(context: Context) {
        if (!attached) return
        val v = view
        attached = false
        view = null
        params = null
        if (v != null) {
            try {
                windowManager(context)?.removeView(v)
                Log.i(TAG, "overlay removed")
            } catch (e: Exception) {
                Log.w(TAG, "overlay remove failed", e)
            }
        }
    }
}

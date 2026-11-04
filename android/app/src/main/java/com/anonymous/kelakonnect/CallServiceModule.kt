package com.anonymous.kelakonnect

import android.content.Intent
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.*

class CallServiceModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "CallServiceModule"
    }

    override fun getName() = "CallServiceModule"

    @ReactMethod
    fun startCallService(promise: Promise) {
        try {
            val intent = Intent(reactContext, CallForegroundService::class.java)
            // On Android O+ a service that will promote itself to the
            // foreground (via startForeground()) must itself be started with
            // startForegroundService(), not startService(). Using the wrong
            // call here doesn't throw synchronously, but on modern Android
            // (this app targets API 34) it can prevent the service from ever
            // being allowed to call startForeground(), meaning the call's
            // persistent notification silently never appears and the
            // service — and the call audio pipeline riding on it — becomes
            // eligible for the OS to kill as soon as the app backgrounds.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactContext.startForegroundService(intent)
            } else {
                reactContext.startService(intent)
            }
            Log.d(TAG, "Call foreground service started")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start service: ${e.message}")
            promise.reject("START_SERVICE_FAILED", e.message)
        }
    }

    @ReactMethod
    fun stopCallService(promise: Promise) {
        try {
            val intent = Intent(reactContext, CallForegroundService::class.java)
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
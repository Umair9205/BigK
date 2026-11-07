package com.anonymous.kelakonnect

import android.os.Build
import android.os.Bundle
import android.content.Intent

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  private companion object {
    const val VPN_REQUEST = 1001
  }
  private var vpnPrompted = false
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    updateCallWindow(intent)
    reactInstanceManager.currentReactContext?.getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      ?.emit("onCallNotificationAction", null)
  }
  private fun updateCallWindow(intent: Intent?) {
    if (Build.VERSION.SDK_INT >= 27) {
      val ringing = intent?.getStringExtra("localCallSession")?.let { IncomingCallNotification.permits(it, intent.getStringExtra("localCallToken")) } == true
      setShowWhenLocked(ringing)
      setTurnScreenOn(ringing)
    }
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    super.onCreate(null)
    updateCallWindow(intent)
  }

  override fun onStart() {
    super.onStart()
    // Back in the app: the keep-alive surface must never sit on top of the UI.
    KeeperOverlay.hide(this)
    requestVpnConsentIfNeeded()
  }

  /** One-time system consent so the availability service can own the keeper VPN
   *  tunnel (Nov 6 freeze experiment). Declining is harmless: everything keeps
   *  working, only the freeze exemption is missing. */
  private fun requestVpnConsentIfNeeded() {
    if (vpnPrompted) return
    // The user can release the VPN slot for a banking app or another VPN.
    // Never re-prompt behind their back.
    if (!KeeperVpnService.isEnabled(this)) {
      android.util.Log.i("MainActivity", "VPN protection is off; consent not requested")
      return
    }
    // One VPN owner at a time: never fight (or interrupt) another VPN such as
    // Cloudflare WARP. The keeper stays idle until that VPN disconnects.
    if (KeeperVpnService.anotherVpnActive(this)) {
      android.util.Log.i("MainActivity", "Another VPN is active; keeper consent not requested")
      return
    }
    try {
      val intent = android.net.VpnService.prepare(this)
      if (intent != null) {
        vpnPrompted = true
        android.util.Log.i("MainActivity", "Requesting VPN consent for background receive")
        startActivityForResult(intent, VPN_REQUEST)
      }
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "VPN consent request failed", e)
    }
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == VPN_REQUEST) {
      android.util.Log.i("MainActivity", "VPN consent result=$resultCode")
      if (resultCode == RESULT_OK) startService(Intent(this, AvailabilityService::class.java))
      vpnPrompted = false
    }
  }

  override fun onStop() {
    super.onStop()
    // Leaving the app while availability is on: attach the 1x1 window so the
    // process still owns a visible window while XOS would otherwise freeze it.
    if (AvailabilityService.running) KeeperOverlay.show(this)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}

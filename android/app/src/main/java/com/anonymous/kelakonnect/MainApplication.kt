package com.anonymous.kelakonnect

import android.app.Application
import android.content.res.Configuration
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper
import org.webrtc.NetworkMonitorAutoDetect

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
    ReactNativeHostWrapper(this, object : DefaultReactNativeHost(this) {
      override fun getPackages(): List<ReactPackage> {
        val packages = PackageList(this).packages
        packages.add(NearbyPackage())
        packages.add(WifiDirectPackage())
        packages.add(AudioStreamPackage())
        packages.add(OpusPackage())
        packages.add(CallServicePackage())
        packages.add(CallForegroundServicePackage())
        return packages
      }

      override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

      override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

      override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
      override val isHermesEnabled: Boolean  = BuildConfig.IS_HERMES_ENABLED
    })

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    // WebRTC excludes P2P interfaces by default. Enable its built-in P2P monitor
    // before React Native creates the WebRTC factory or any peer connections.
    NetworkMonitorAutoDetect.setIncludeWifiDirect(true)
    android.util.Log.i("DirectCall", "WebRTC Wi-Fi Direct network discovery enabled")
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) load()
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}

package com.anonymous.kelakonnect
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class AudioStreamPackage : ReactPackage {
    override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(AudioStreamModule(ctx))
    override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

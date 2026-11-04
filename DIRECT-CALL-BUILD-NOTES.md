# Direct WebRTC calling build

This change uses Nearby Connections for discovery and the initial call invitation,
then app-managed Wi-Fi Direct for full WebRTC audio. The old JavaScript audio-frame
pipeline remains in the source tree but is not used by the call screens.

## Requirements

- Install the same new APK on both phones.
- Automatic group creation/join requires Android 10+ and Wi-Fi Direct support.
- Keep Bluetooth, Wi-Fi and Location enabled and grant requested permissions.
- Keep both apps open for initial testing. The receiver does not need to scan.
- No router or internet is required for media; only direct-interface UDP host
  candidates are signaled. Accept an Android connection prompt if shown.
- Disconnect an existing manually created Wi-Fi Direct group before testing.

## Build

Run in your normal Windows PowerShell:

```powershell
& "C:\Users\umair\OneDrive\Documents\kela-konnect\scripts\build-offline-call.ps1"
```

Only install after the script reports success. A failed build can leave an old APK
at `android/app/build/outputs/apk/release/app-release.apk`.

## Verification status

The 15 connection/WebRTC checks (including a source-level Android startup guard), nine existing audio tests,
and TypeScript check pass. These tests do not exercise physical radios, native
WebRTC audio, Android Wi-Fi Direct interoperability or end-to-end latency.
The release build succeeded on September 9, 2026 after fixing the nullable
Wi-Fi Direct channel passed to createGroup. The generated APK is version
1.1.0-direct-webrtc. Physical tests of that version established the Wi-Fi Direct
group and exchanged offers/answers but timed out before ICE connected.

## 1.1.1-direct-ice change

Enable `NetworkMonitorAutoDetect.setIncludeWifiDirect(true)` in Android application
startup, before the WebRTC factory is created. This API exists in the bundled
Jitsi WebRTC 118.0.0 library; its P2P delegate queries the existing group and
reports its interface addresses. It was not enabled in 1.1.0.

Keep the direct-interface UDP candidate restriction so a router connection cannot
silently substitute for offline calling. Added `[DirectICE]` logs show the control
IP, accepted/rejected candidate addresses, remote candidate receipt/application,
ICE states, and the selected route when available in WebRTC stats. No SDP,
passwords or group tokens are logged by these diagnostics.

Version 1.1.1-direct-ice built successfully with :app:assembleRelease on September
9, 2026; all 24 automated checks and TypeScript validation passed.

This change needs a new APK on both phones and physical retesting. Passing mocked
tests and compiling do not prove audio connectivity or quality.

## Required two-phone checks

Version 1.1.2-direct-2ghz also restricts group creation and joining to 2.4 GHz.
The no-router test showed the Infinix choosing 5765 MHz (5 GHz), which the
Galaxy A10 SM-A105F cannot use. Its join failed before WebRTC startup.
This build retains the 1.1.1 P2P-monitor fix and adds a native `[DirectWifi]`
group frequency/interface log. Test this version on both phones, not 1.1.0.

1. Disable mobile data and disconnect from router Wi-Fi, leaving Wi-Fi on.
2. Open both apps. Call from only one phone without pressing Scan on the receiver.
3. Accept, speak in both directions, and check mute, speaker and hangup.
4. Repeat in the opposite direction and make five consecutive calls.
5. Test ten minutes of conversation, screen off, and the intended hallway range.
6. Check both logs for `[DirectCall]`, `[WebRTCMetrics]` and direct setup failures.

Do not treat a successful connection or a passing mocked test as proof of audio
quality. Cross-vendor connection and audio still require physical testing.

Source backup before this migration:
`.codex-backups/before-webrtc-direct-20260909.zip`.

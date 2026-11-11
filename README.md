# BigK (Kela-Konnect)

**Local, offline voice calling between two Android phones.** No phone number, no account, no mobile data, no server. Press **Call** and the other phone rings — even with the screen off.

BigK uses **Wi-Fi Direct** for discovery and transport, and **WebRTC** for the audio path. The current build is validated for two-way calling between a Samsung Galaxy A10 (Android 10) and an Infinix Hot 60 Pro (Android 15).

> **Status (Nov 2026):** two-way direct calls work on the test pair. Discovery latency still grows with distance, and the DNS-SD discovery layer is being hardened. See [Known limitations](#known-limitations).

---

## What works today

- **One-time setup** — choose a name, grant permissions, add a friend by QR.
- **Call with one button** — no manual Wi-Fi Direct pairing, no toggles, no IP addresses.
- **Incoming calls** — full-screen incoming call UI plus a notification with Answer / Decline.
- **Two-way audio** — WebRTC/Opus over the Wi-Fi Direct link; no router, hotspot, or internet required.
- **Screen off / background** — a foreground service, a 5-second watchdog, and a local VPN keep the callee reachable. No permanent wakelock.
- **VPN coexistence** — BigK uses one VPN slot for its own keep-alive relay and **defers to another VPN** (for example Cloudflare WARP). The VPN toggle can be turned off for banking apps or when another VPN must own the slot.
- **Call history, ringtone, speaker, audio quality** — basic call preferences are in Settings.
- **QR contacts** — one scan adds one direction; both phones scan each other to call in either direction.

## What is not in this build

- The **shared-LAN / NSD fallback route** is designed but not wired end-to-end. The live call path is Wi-Fi Direct only.
- **Pinned public keys, a non-exportable Android Keystore key, and encrypted local storage** are planned hardening, not implemented yet. See [Security status](#security-status).
- **Group calls, video calls, iOS, and emergency calling** are out of scope.
- **Google Nearby Connections** remains compiled for the legacy path and its test suites, but it is **not** in the live call UI. Bluetooth/NFC permissions are removed from the manifest.

---

## How a call works

1. **Identity.** Each phone has a local UUID and a display name. The UUID is hashed to a stable Wi-Fi Direct tag: `BK-` + the first 12 hex characters of `SHA-256(uuid)`.
2. **Discovery.** The tag is advertised over DNS-SD as a `_bigk._tcp` service instance (`BK-<tag>`, with `-CALL` appended by the caller). The TXT record carries `{tag, sid}`. A cached peer MAC is treated as a hint, never as a bypass.
3. **Group formation.** The caller asks Wi-Fi Direct to connect to the peer. The framework creates or reuses a P2P group. By default the caller requests GO intent `0` and the callee `15`, but the framework can invert the roles — especially with a persistent group.
4. **Control socket.** Whichever side is the P2P **client** dials the other side's listener on **port 9875**. This "client dials" rule is what makes both group roles work.
5. **Authentication.** The caller sends a pair token derived from the two sorted UUIDs and the session id:
   `SHA-256(sorted(uuidA, uuidB) + ":" + sessionId)`.
   The callee compares it in constant time and only accepts the call if the caller's UUID is in its friend list.
6. **Media.** WebRTC negotiates host candidates on the Wi-Fi Direct interface and carries Opus audio directly. There is no STUN/TURN server and no internet dependency.

```
┌──────────────┐      DNS-SD `_bigk._tcp`       ┌──────────────┐
│    Caller    │ ◄──── BK-<hash>[-CALL] ──────► │    Callee    │
│              │                                │              │
│  WifiP2pMgr  │ ────── group formation ──────► │  WifiP2pMgr  │
│              │                                │              │
│ control :9875│ ◄──── JSON + pair token ─────► │ control :9875│
│              │                                │              │
│    WebRTC    │ ◄──────── Opus audio ────────► │    WebRTC    │
└──────────────┘   over the P2P subnet (e.g.    └──────────────┘
                    192.168.49.0/24; no router)
```

### Roles and the persistent-group gotcha

Wi-Fi Direct group owners and clients behave differently, and a persistent group can reverse the roles that the caller requested. BigK does not assume the caller is the client or the group owner. Instead:

- the P2P **client** always initiates the TCP control connection;
- both sides run a listener on `:9875`;
- both caller-as-client and callee-as-client paths are implemented and tested.

### Background availability

Android and OEM power managers will freeze a backgrounded app. BigK combines three mechanisms:

- a **foreground service** with an ongoing notification;
- a **5-second watchdog** that re-arms the discovery listener if it dies;
- a **local VPN service**. On Infinix/XOS, `com.transsion.usf` exempts the package that owns the active VPN (`importantScene: VPN`).

On the tested Infinix, owning the VPN slot is the exemption that survives the XOS freezer; the foreground service and watchdog cover the rest. The VPN is a **real per-app local relay**, not a privacy tunnel: tun addresses `10.111.222.1/32` and `10.111.222.2/32`, route `10.111.222.0/24`, virtual peer `10.111.222.2`, app port `9876`, real P2P control port `9875`. The control socket bypasses the relay; WebRTC is told the real P2P IP so media stays direct.

Android allows only **one active VPN**. If WARP or another VPN is running, BigK waits rather than fighting for the slot. In that state, screen-off protection is reduced. The Settings toggle turns the VPN off for banking apps or when another VPN must run.

---

## Security status

BigK is designed to be local-only: there is no account server, no cloud relay, and no call metadata leaving the two phones.

| Area | Implemented today | Planned hardening |
|---|---|---|
| Identity | Local UUID + display name; QR payload `{uuid, name}` | Pinned public keys in the QR payload |
| Call authorization | Caller UUID must be in the callee's friend list | Challenge-response with pinned keys |
| Session authentication | Pair token derived from sorted UUIDs + session id; constant-time compare | Keystore-backed signing key |
| Local storage | `AsyncStorage` | Encrypted storage / Android Keystore |
| Transport | Wi-Fi Direct + local control socket; no server | Same, with authenticated key exchange |
| Logs | Routing metadata only | Audit pass |

**Important:** UUIDs are identifiers, not cryptographic identity. The pair token stops a random third party from completing a call, but it is **not** a substitute for the planned pinned-key challenge-response. Treat the current build as a trusted-pair prototype, not a hardened messenger.

The QR code currently contains `{uuid, name}`. It does **not** contain a public key yet. Adding a friend is deliberately one-way per scan; both people scan each other to enable calls in both directions.

---

## Requirements

- Two Android phones, **Android 8.0+** (`minSdk 26`), with Wi-Fi Direct support.
- The **same APK** on both phones.
- Permissions: microphone, location, notifications, and camera (for the QR scanner). Location is an Android requirement for Wi-Fi Direct peer discovery, not for tracking.
- No SIM, mobile data, router, or internet connection is needed for the call itself.

**Validated on:**

| Device | Android | Role in testing |
|---|---|---|
| Samsung Galaxy A10 | 10 | Caller and callee |
| Infinix Hot 60 Pro | 15 | Caller and callee |

---

## Getting started (development)

Prerequisites: Node.js, a JDK 17, the Android SDK, and a connected Android device (or an emulator with Wi-Fi Direct support — a physical phone is strongly recommended).

```bash
npm install
npx expo run:android
```

The app is an Expo project with a custom Android native module. Use a development build, not Expo Go: Wi-Fi Direct, the foreground service, the VPN service, and WebRTC are native code.

### Build the release APK

The full gate runs every Node test suite, the TypeScript check, and Gradle `assembleRelease`:

```powershell
.\scripts\build-offline-call.ps1
```

The script defaults to the author's SDK and JDK paths. Override them if yours differ:

```powershell
.\scripts\build-offline-call.ps1 `
  -AndroidSdk "C:\path\to\Android\Sdk" `
  -JavaPath "C:\path\to\jdk-17"
```

Output:

```
android\app\build\outputs\apk\release\app-release.apk
```

The script prints the APK's SHA-256. Install the **same** APK on both phones:

```powershell
adb devices -l
adb -s <phone-serial> install -r android\app\build\outputs\apk\release\app-release.apk
```

### Re-grant permissions after every `adb install -r`

`adb install -r` can reset runtime grants. On each phone:

```powershell
adb -s <phone-serial> shell pm grant com.anonymous.kelakonnect android.permission.ACCESS_FINE_LOCATION
adb -s <phone-serial> shell pm grant com.anonymous.kelakonnect android.permission.ACCESS_COARSE_LOCATION
adb -s <phone-serial> shell pm grant com.anonymous.kelakonnect android.permission.RECORD_AUDIO
adb -s <phone-serial> shell pm grant com.anonymous.kelakonnect android.permission.POST_NOTIFICATIONS
```

On Samsung (and other One UI devices), allow the incoming-call overlay:

```powershell
adb -s <phone-serial> shell appops set com.anonymous.kelakonnect SYSTEM_ALERT_WINDOW allow
```

`POST_NOTIFICATIONS` only exists on Android 13+. On Android 10 the `pm grant` for it may fail harmlessly.

### First-run checklist

1. Install the same APK on both phones.
2. Open BigK, enter a name, and allow microphone, location, and notifications.
3. Accept the battery-optimization exemption prompt. This is required for reliable background ringing.
4. On phone A, open **My contact code**; on phone B, scan it. Then repeat in the opposite direction. Both scans are needed for two-way calling.
5. Turn on **Local calling**; leave **VPN protection** on unless a banking app or another VPN needs the slot.
6. Keep Wi-Fi and Location on. You can go to Home and turn the screen off — the foreground service and watchdog keep the callee reachable.
7. Press **Call** from the friend's row. The callee gets the incoming-call screen or notification.

---

## Testing

The build gate is the source of truth:

```powershell
.\scripts\build-offline-call.ps1
```

It runs:

| Suite | Covers |
|---|---|
| `scripts/test-direct-native.cjs` | Native control-socket handshake and timeouts (compiles and runs `DirectControlSocketTest.java`) |
| `scripts/test-ringtone-settings.cjs` | Ringtone preference handling |
| `scripts/test-background-availability.cjs` | Foreground service, VPN state, availability re-arm |
| `scripts/test-availability-watchdog.cjs` | 5-second watchdog behavior |
| `scripts/test-call-connections.cjs` | Connection state transitions |
| `scripts/test-discovery-presence.cjs` | Presence / discovery state |
| `scripts/test-direct-call.cjs` | Direct call lifecycle |
| `scripts/test-p2p-identity.cjs` | UUID → tag hashing, MAC validation, friend matching |
| `scripts/test-direct-flow.cjs` | Call bootstrap / dial / accept flow |
| `scripts/test-direct-call-lifecycle.cjs` | Handoff and teardown |
| `scripts/test-offline-audio.cjs` | Offline audio path |
| `npx tsc --noEmit` | TypeScript |
| `gradlew :app:assembleRelease` | Android release APK |

You can run a single suite directly, for example:

```bash
node scripts/test-p2p-identity.cjs
```

---

## Project structure

```
app/                      Expo Router screens (setup, tabs, call, incoming-call, QR, history)
components/               Calling home, voice-call screen, shared UI
services/                 DirectCallFlow, DirectCallAudio, P2pIdentity,
                          BackgroundAvailability, CallStateManager, WebRTC, ringtone
modules/                  JS wrappers for the native modules (DirectWifi, Nearby, …)
store/                    Zustand app store (identity, friends, history, settings)
android/app/src/main/java/com/anonymous/kelakonnect/
                          DirectWifiModule.kt, DirectControlSocket.java,
                          AvailabilityService.kt, KeeperVpnService.kt,
                          CallForegroundService.kt, NearbyTransport.kt, Opus JNI
android/app/src/main/cpp/ Opus 1.6.1 native sources
scripts/                  Node test suites + build-offline-call.ps1
__tests__/                Jest tests (Opus module)
```

### Ports and addresses

| Item | Value |
|---|---|
| P2P control socket | TCP `9875` |
| VPN relay app port | TCP `9876` |
| VPN tun addresses | `10.111.222.1/32`, `10.111.222.2/32` |
| VPN route | `10.111.222.0/24` |
| Typical P2P subnet | `192.168.49.0/24` (group owner usually `192.168.49.1`) |
| DNS-SD service | `_bigk._tcp`, instance `BK-<hash>` / `BK-<hash>-CALL` |

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| "Install the new APK on both phones" | The JS bundle and native module are out of sync. Install the same freshly built APK on both phones. |
| Friend never appears / call stays on "discovering" | Both phones on the same APK; Wi-Fi and Location on; both on the Home screen; try toggling Wi-Fi off/on. Discovery range is the limiting factor at distance. |
| Call connects but there is no audio | Microphone permission; media volume; speaker route; try ending and redialing. |
| Callee does not ring with the screen off | Battery exemption granted; BigK's foreground notification present; VPN protection on; OEM freezer not force-stopping the app. |
| "VPN protection: waiting for the other VPN" | Android has one VPN slot. Disconnect WARP/other VPN, or accept reduced screen-off protection. Turn BigK's VPN off for banking apps. |
| Incoming call overlay does not show on Samsung | `appops set com.anonymous.kelakonnect SYSTEM_ALERT_WINDOW allow`. |
| Discovery worked, then stalled after ~40 s | Known DNS-SD channel staleness (`reason=0` on `discoverServices`). Reopen the app or toggle Wi-Fi to rebuild the channel. |
| Both phones connect but the control socket deadlocks | The client-dials rule handles both group roles. If it recurs, capture logcat from both phones and check for `callee is the group client; dialling the caller`. |

For a live capture from both phones at once (Windows PowerShell):

```powershell
$t0 = Get-Date
$dir = (Get-Location).Path
$targets = @(
  @{ Serial = '<serial-A>'; Out = "$dir\cap_A.log" },
  @{ Serial = '<serial-B>'; Out = "$dir\cap_B.log" }
)
$jobs = foreach ($t in $targets) {
  Start-Job -ScriptBlock {
    param($serial, $out)
    adb -s $serial logcat -v time | Out-File -Encoding utf8 $out
  } -ArgumentList $t.Serial, $t.Out
}
Start-Sleep -Seconds 100
$jobs | Stop-Job
$jobs | Remove-Job
Get-Process adb -ErrorAction SilentlyContinue |
  Where-Object { $_.StartTime -ge $t0 } |
  Stop-Process -Force
```

`adb logcat` without `-d` streams until stopped. Capture first, filter afterwards; do not pre-filter the live capture.

---

## Known limitations

- **Discovery latency grows with distance.** Wi-Fi Direct discovery and group formation are the slow stages; the first call is slower than a warm call. Current work targets the discovery and address-wait stages, not the audio path.
- **DNS-SD can go stale.** The service-discovery channel can stop returning results after a while. A stale channel may require reopening the app or toggling Wi-Fi; automatic self-healing is planned.
- **Persistent groups and OEM roles vary.** The client-dials rule covers the role inversion, but different Android versions and OEM Wi-Fi stacks still behave differently.
- **One VPN slot.** BigK defers to any other active VPN. In that state the XOS freezer exemption is weaker.
- **No group calls, video, iOS, or emergency calling.** BigK is a two-party, Android-to-Android, local-range app.
- **No shared-LAN route yet.** The live path is Wi-Fi Direct. A shared-LAN/NSD fallback is planned but not implemented.
- **Security hardening is incomplete.** Pinned keys, Keystore-backed identity, and encrypted storage are on the roadmap; the current build uses UUID allowlisting plus a derived pair token.
- **The test matrix is small.** Two physical phones (Android 10 and 15). More OEMs and Android versions need testing.

---

## Documentation

The root-level notes record the investigation and the on-device evidence behind the current design:

- [ALWAYS-ON-AVAILABILITY-2026-10-09.md](ALWAYS-ON-AVAILABILITY-2026-10-09.md) — foreground service, watchdog, VPN keep-alive.
- [BACKGROUND-CALLING-STATUS.md](BACKGROUND-CALLING-STATUS.md) — what survives backgrounding and what does not.
- [CALL-RELIABILITY-FIX-2026-10-02.md](CALL-RELIABILITY-FIX-2026-10-02.md) — connection handoff and reliability fixes.
- [CALL-SETUP-LATENCY-2026-10-09.md](CALL-SETUP-LATENCY-2026-10-09.md) — where setup time goes and the fast-path plan.
- [CONNECTION-HANDOFF-FIX-2026-10-02.md](CONNECTION-HANDOFF-FIX-2026-10-02.md) — handoff details.
- [DIRECT-CALL-BUILD-NOTES.md](DIRECT-CALL-BUILD-NOTES.md) — native build and APK notes.
- [DISCOVERY-PRESENCE-2026-10-08.md](DISCOVERY-PRESENCE-2026-10-08.md) — discovery/presence behavior.
- [LOG-REVIEW-2026-10-02.md](LOG-REVIEW-2026-10-02.md) — log review, including why location is required and the status of a shared-LAN fallback.
- [P2P-NEGOTIATE-CONNECT-2026-10-09.md](P2P-NEGOTIATE-CONNECT-2026-10-09.md) — negotiation, group roles, expected log markers.
- [ROUTE1-RELIABILITY-2026-11-03.md](ROUTE1-RELIABILITY-2026-11-03.md) — route-1 reliability findings, name-matching dead ends, and test evidence.

Logcat captures (`*.log`) are development evidence and are intentionally git-ignored.

---

## License

No license file is present in this repository. Add one before distributing or publishing the app.

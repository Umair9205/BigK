# BigK: third test-log review and changes

Date: 2 October 2026. These logs describe the APK BEFORE the changes listed below.

## Scope and caveats

Reviewed `log_bigk_SM_3.log` (90,111,658 bytes) and `log_bigk_infinix_3.log` (10,108,748 bytes). Both are UTF-16LE logcat captures. Samsung has substantially more preceding history than Infinix. Their clock readings differ by approximately 33 seconds for matched later sessions; raw cross-device timestamp subtraction is not a valid latency measurement. Timing below uses events on the same device.

This review distinguishes successful media setup, explicit control-message endings, radio setup failure and operating-system process kills. Audible clarity, user button presses, and actual loudspeaker volume cannot be proved from these logs alone.

## 1. Discovery does work in this capture

Infinix finds its saved contact at 00:46:17.053 (line 13221), connects at 00:46:27.363 (14137), and sends the invitation at 00:46:27.491 (14165). Subsequent discoveries are visible at 00:47:54.840 and 00:49:03.089 after process restarts.

Samsung also records repeated saved-contact discoveries, invitations, accepts, rejects and media setup. This does NOT establish that discovery always works, but the prior blanket symptom “both phones cannot discover” is not true for the entirety of these new logs.

No `Location mode is disabled` warning was found in these two new files. That warning was in the previous `Documents/log.log`; it must not be attributed to this test. Absence of the warning is not proof of every permission or toggle state.

## 2. Six Samsung sessions reached WebRTC connected

| Session prefix | Samsung accept sent | Samsung WebRTC connected | Accept-to-connected |
| --- | --- | --- | --- |
| mupxqqo5 | 00:37:32.804 | 00:37:39.353 | 6.549 s |
| mupxrck4 | 00:37:54.380 | 00:37:57.071 | 2.691 s |
| mupxrvxq | 00:38:21.102 | 00:38:27.148 | 6.046 s |
| mupxsmnu | 00:38:55.183 | 00:38:58.957 | 3.774 s |
| mupy34je | 00:47:07.887 | 00:47:14.655 | 6.768 s |
| mupy3wb7 | 00:47:41.900 | 00:47:45.056 | 3.156 s |

These are observed setup times, not guarantees, and exclude user time before answering. Warm-group reuse was logged for several repeat calls. It helps avoid fresh group creation, but did not make all calls equally fast.

The later two sessions appear in BOTH captures and have inbound audio-packet counters on BOTH devices. Their selected media route is UDP between 192.168.49.1 and 192.168.49.200, with `matchesDirectIp=true`. Router addresses 192.168.100.x were rejected as media candidates. Evidence: Samsung lines 255030 and 261561; Infinix line 15036 and the later selected-route record. Thus the observed voice transport used Wi-Fi Direct, not a router fallback or Bluetooth audio frames.

## 3. Media was flowing, but audio perfection is not established

Final sampled inbound counters for the two overlapping calls:

| Session | Receiver | Received packets | Reported lost packets | Concealed samples | Average jitter-buffer residence |
| --- | --- | ---: | ---: | ---: | ---: |
| mupy34je | Infinix | 133 | 0 | 105120 | approximately 133 ms |
| mupy34je | Samsung | 186 | 0 | 66960 | approximately 138 ms |
| mupy3wb7 | Infinix | 68 | 0 | 42385 | approximately 96 ms |
| mupy3wb7 | Samsung | 106 | 0 | 44640 | approximately 193 ms |

Evidence: Infinix lines 15529 and 17470; Samsung lines 255204 and 261691. These are cumulative snapshots before the call ended, not complete end-of-call totals. Concealment can include startup/missing/late audio; zero reported packet loss does not prove glitch-free playback. The calls are short and startup dominates some counters.

Buffer residence is `1000 * jitterBufferDelay / jitterBufferEmittedCount`, NOT mouth-to-ear latency. Earlier Samsung samples are approximately 211–262 ms. No assertion of “zero delay” or “zero cracks” follows from these numbers. Metric definitions: https://www.w3.org/TR/webrtc-stats/

## 4. A real setup failure occurs before WebRTC

Samsung 00:42:44.018, line 235093:
`Could not create Wi-Fi Direct group (2)`

The session has no local IP and zero gathered/accepted/remote ICE candidates. This is a native Wi-Fi Direct setup failure, not an Opus decoder error. Android's WifiP2pManager ActionListener reason 2 is BUSY: https://developer.android.com/reference/android/net/wifi/p2p/WifiP2pManager#BUSY

There is surrounding P2P interface/state activity, and other NearbyMediums records show group-operation BUSY errors. The logs suggest radio-state contention, but do not uniquely prove which operation owns every conflict. The previous app code failed immediately on BUSY; a bounded retry has now been added. This is mitigation, not proof the ownership/contention issue is fully solved.

Another Samsung session (mupxuz7r) creates a group at 00:40:55.223 but never reaches WebRTC connected before call-end at 00:41:29.723. The matching earlier Infinix app trace is not present in the supplied application logs, so its exact peer-side failure cannot be reconstructed confidently.

## 5. Not every end/reject is a crash

Several sessions have explicit call-end/call-reject signals. For mupy34je, Infinix sends call-end and Samsung logs `Peer ended the call`. That message is currently logged under the generic `[DirectICE] failure` label even for a normal peer end. It does not prove spontaneous transport failure or a crash.

The logs cannot distinguish every actual Decline tap from every programmatic rejection. Do not label all short rejected attempts as radio failures.

No new BigK fatal exception or ANR was identified in the 2 October test. Infinix's crash buffer includes an OLD 1 October 15:38 BigK native-module crash and unrelated older app crashes. Those are not new regressions in this test. No repeated custom-Opus decoder errors or `streaming -> streaming` invalid transitions were found in these files.

## 6. Background behavior differs by phone

Samsung: task removal is logged, followed by later Nearby invitations while the native listener remains alive. For example, task removal at 00:48:31.562 (267982), connection at 00:48:34.679, invitation at 00:48:36.761, and UI restoration at 00:48:46.883 (270253). Earlier, task removal at 00:38:48.627 is followed by an accepted connected call. This is evidence of working reception after some task removals, not an overnight/Doze guarantee.

Infinix: XOS explicitly kills BigK with `rms_SwipeUpCleanPolicy`, then blocks AvailabilityService restart. Examples:
- 00:47:22.828 kill (18884), 00:47:22.885 restart skipped (18902).
- 00:48:37.494 kill (24588), 00:48:37.552 restart skipped (24609).
- 00:49:40.282 kill (33439), 00:49:40.337 restart skipped (33452).

This remains an actual background-reliability failure on Infinix. A sticky service cannot be represented as an already-proven solution to an OEM that explicitly refuses restart. User-controlled background/auto-start/swipe-clean settings and a fresh device test are still required. These events do not invalidate the successful foreground calls recorded separately.

## 7. Ringtone evidence

Infinix has ringtone-player activity for later incoming invitations. At 00:49:34.827 the System UI AudioTrack starts with ringtone usage, and at 00:49:35.857 RingtonePlayer releases it because the notification was canceled (around lines 31772–32348). Similar activity occurs for the preceding invitation.

This is stronger than “notification posted,” but still does not prove what the user heard or establish Samsung ringtone behavior. Volume, speaker routing and DND must be verified on device. No extra ringtone playback engine was added here.

## 8. Changes made during this review

### QR and scanner screens

- Replaced the old banana/yellow interface with BigK's green-and-white styling.
- Safe-area layout, scrollable content, clear back buttons, profile/QR card and code-exchange shortcuts.
- Original `{uuid,name}` contact QR payload preserved.
- Scanner has camera-permission/settings and camera-error states, flashlight control and camera unmount on background/blur.
- Rejects malformed/oversized payloads and self-scans, retains confirmation, handles save failure.
- UI is not yet visually/device verified.

### Setup improvements

- Caller can create/send the WebRTC offer as soon as its media is ready, instead of waiting for a separate peer-ready signal. The receiver already buffers setup messages. Duplicate and canceled-session checks remain.
- Native create/join retries BUSY at most three times with 250/500/750 ms delays. It does not retry other errors indefinitely or auto-accept calls.
- Existing 30-second idle connection/group reuse is retained, not extended to permanent radio ownership.
- Actual speedup requires another two-phone timing test. This is not a guarantee of instant calls.

### Location UX

- A native check distinguishes Location switch state from runtime permission.
- Before discovery, Location-off produces a specific warning and Open settings action.
- Changes to the Location switch update JS availability; checks also run on resume. No dialog is opened from the background.
- Existing calls are not deliberately torn down just because Location changes; new discovery is marked unavailable.
- The UI must not say the app will be killed by Location-off. The app remains open; discovery/new calls can fail.

This is a conservative requirement for the current cross-version direct-call path, not a claim that every networking API on every Android version needs Location. An already-connected shared LAN with known-address/QR signaling is a possible future alternate path; it is NOT implemented in this change. Wi-Fi Direct discovery alone is not a guaranteed workaround: https://developer.android.com/develop/connectivity/wifi/wifip2p

## 9. Verification and next tests

TypeScript and 49 automated checks passed. These include mocked behavior and structural source checks, not real-radio integration tests. Metro bundled the updated interface, but release packaging FAILED because the Windows sandbox could not launch `node_modules/react-native/sdks/hermesc/win64-bin/hermesc.exe` (permission denied). Additional compiler-directory permission was not granted. A separate native compile excluding bundling was also blocked by Gradle's generated-resource dependency on the bundle task. Consequently this pass's Kotlin changes have NOT been compile-verified and NO new APK has been delivered. The existing APK in the output folder must not be mistaken for this update.

Build from the user's normal PowerShell with the established JDK 17 configuration, then install only after BUILD SUCCESSFUL:

```powershell
# from the repository root
npx expo run:android --variant release --device
```

Backup of the two original QR screens and primary media/native setup files: `.codex-backups/qr-call-setup-20261002`.

Next device test:
1. Install the newly built APK on BOTH phones; confirm QR/scanner designs changed.
2. Turn Location off: confirm a specific warning/settings action rather than silent discovery timeout. Re-enable and verify recovery.
3. Make a fresh call and a repeat call in both directions; record Answer-to-audio time, not just ringtone duration.
4. Test cancellation during setup and quick redial, including after the 30-second group expiry.
5. Check audio, ringing and microphone release separately.
6. Test Samsung and Infinix swipe-away separately; Infinix's OEM kill remains unresolved by this patch.

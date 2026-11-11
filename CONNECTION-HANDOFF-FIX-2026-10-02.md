# BigK connection handoff fix — 2 October 2026

## Problem and correction

The Infinix `_4` log shows Nearby upgrading its bootstrap connection to Wi-Fi Direct. The old call flow then tried to create a separate Wi-Fi Direct group. The existing-group guard rejected that request. Disabling disruptive upgrades was not a guarantee against this conflict.

This patch makes ownership sequential:

1. Nearby discovers/connects the two contacts and carries the invitation/acceptance.
2. The receiver prepares the future group's random name, password and session token **without creating a group**.
3. It sends those details over Nearby. The caller sends `direct-ready` and waits for Nearby's payload-transfer `SUCCESS`, not just enqueue success.
4. The caller stops Nearby advertising, discovery and endpoints. The receiver waits for that endpoint disconnect, then stops its own Nearby operations. This is not a fixed-delay guess.
5. Each phone waits for any previous P2P group to disappear. The receiver creates the planned 2.4 GHz group; the caller joins it. Unidentified groups are not automatically removed.
6. The existing token-checked direct control socket carries WebRTC negotiation. WebRTC audio still uses direct-interface UDP candidates, not Nearby audio frames or an internet server.
7. Ending a call stops media immediately, cancels pending Wi-Fi operations, removes only the session's planned group, and checks that the group remains absent before restoring Nearby. The call remains busy during cleanup.

The previous 30-second warm **Wi-Fi Direct group** retention is removed. This trades some repeat-call setup speed for explicit ownership and cleanup. A short idle Nearby lease may still exist for calls rejected before direct handoff.

## Other fixes

- One fresh-discovery retry for Nearby errors 8007/8012, before an invitation is sent. No automatic redial of an accepted/ringing call.
- Failed endpoint mappings are cleared without deleting a replacement mapping or interrupting an incoming call that takes over.
- Outgoing native callbacks are attempt-bound; cancelled attempts cannot resolve a replacement request.
- Discovery startup callbacks are epoch-checked so a late callback cannot resurrect a stopped scan.
- Abandoned pre-release handshakes clear native session state; they cannot leave the app permanently marked busy.
- Initial WebRTC offer is one-shot even when the first peer-ready arrives after the answer. Explicit ICE recovery remains available.
- Call-state reset notifies idle listeners after cleanup, allowing automatic discovery to restart.
- UI distinguishes recently detected contacts, connecting/retrying, and enabled local calling. Enabled does not promise reachability.
- If Android does not confirm direct-link cleanup, Nearby stays suspended rather than starting a conflicting link. The UI reports recovery instructions. A Wi-Fi off/on cycle can clear this exceptional blocked state; it is not part of normal call setup.

## Compatibility

Install the newly built APK on **both phones**. The bootstrap service ID is now `com.<redacted>.nearby.control.v2`, and media negotiation uses `webrtc-direct-v2`. Old and new builds intentionally do not discover each other. Contacts are not erased and the application/package ID is unchanged.

Normal-power advertising/discovery remain enabled. Outgoing bootstrap connections request low power and `NON_DISRUPTIVE`; these are preferences, not the ownership guarantee. The acknowledged handoff is the actual conflict fix.

## Main changed files

- `android/app/src/main/java/<package>/NearbyTransport.kt`
- `android/app/src/main/java/<package>/NearbyModule.kt`
- `android/app/src/main/java/<package>/DirectWifiModule.kt`
- `modules/Nearby.ts`, `modules/DirectWifi.ts`
- `services/DirectCallAudio.ts`, `services/CallSignaling.ts`
- `services/OutgoingCall.ts`, `services/NearbyDiscoveryService.ts`
- `services/CallStateManager.ts`, `services/BackgroundAvailability.ts`
- `hooks/useNearbyCall.ts`, `app/_layout.tsx`, `components/CallingHome.tsx`
- Connection/background/direct-call regression tests; new `scripts/test-direct-call-lifecycle.cjs`
- `scripts/build-offline-call.ps1` runs the lifecycle suite and uses non-reusable Gradle/in-process Kotlin compilation.

Selected original native/UI/build-script files were copied to `.codex-backups/connection-ownership-20261002`. This is a partial backup, not a full-project snapshot.

## Verification

- TypeScript `--noEmit`: passed.
- Six Node regression suites: **79 passed, 0 failed**.
- Tests exercise handshake ordering, missing/wrong acknowledgements, premature/unrelated disconnects, cancellation, next-call cleanup ordering, stale callbacks and duplicate initial offers. Native-specific source assertions are checks of code structure, **not Android instrumentation tests**.
- Native debug compilation attempted. Missing debug dependencies were downloaded with permission, but dependency compilation stopped with `AccessDeniedException` on a Gradle-cache Kotlin standard-library JAR. The app's Kotlin compile therefore remains **unverified**.
- Release compilation remains unavailable inside this agent session because `hermesc.exe` execution is denied. No new release APK was produced or installed during this change.
- No physical-phone tests performed. This patch is not a claim that all vendor-specific radio, notification or background-kill failures are resolved.

## Build and two-phone test

In a normal PowerShell window:

```powershell
# from the repository root
& .\scripts\build-offline-call.ps1
```

Only install the APK if that command completes successfully. An older APK can remain in the output directory after a failed build. The usual Expo command also remains supported:

```powershell
npx expo run:android --variant release --device
```

Install the same new build on both devices. Keep Wi-Fi, Bluetooth and Location on. For a genuinely offline direct test, disconnect from routers and disable mobile data; Wi-Fi itself must remain enabled.

Test:

1. Call/answer with both apps open, in both directions. Confirm audio both ways.
2. End and immediately call again, several times, including reversed caller/receiver roles.
3. Cancel while ringing, during direct handoff, and while the direct group is connecting. Retry after the closing screen completes.
4. Reject a call and call back.
5. Move one phone out of range during setup, then return and retry.
6. After foreground tests pass, test background/locked-screen reception and the OEM battery restrictions separately.

Capture both phones' logs from before discovery through the end of the second call. Useful tags are `NearbyHandoff`, `NearbyModule`, `DirectWifi`, `DirectICE`, `ReactNativeJS` and `AndroidRuntime`. Expected ownership progression is `bootstrap released` -> `P2P released` -> direct control ready -> WebRTC connected -> `direct cleanup finished`. Do not infer successful audio solely from a connected screen.

## References used

- [Google Nearby connection options](https://developers.google.com/android/reference/com/google/android/gms/nearby/connection/ConnectionOptions.Builder)
- [Google Nearby advertising options](https://developers.google.com/android/reference/com/google/android/gms/nearby/connection/AdvertisingOptions.Builder)
- [Google maintainer explanation of low-power/non-disruptive preferences](https://github.com/google/nearby/discussions/2872)

# Always-On Availability — background scan continuity (2026-10-09)

Follow-up to `DISCOVERY-PRESENCE-2026-10-08.md`. P1 fixed dial latency and
presence; it did **not** address "the app sometimes stops scanning" or
always-on call receive. This change closes that gap.

## What was already native (receive path = already WhatsApp-like)

Receiving a call does not need the UI process or JS at all:

| Layer | Owner | Survives app background / swipe-away / JS death |
|---|---|---|
| `AvailabilityService` (foreground service, `connectedDevice` type) | native | yes — `stopWithTask=false`, `START_STICKY`, `onTaskRemoved` restores |
| Nearby advertising (what makes you receivable) | `NearbyTransport.restore()` | yes — native-owned, 10s retry on failure |
| Incoming `call-request` validation + ringing | `NearbyTransport.observeSignal` + `IncomingCallNotification` (45s auto-reject) | yes |
| Cold-start pickup of a ringing call | JS `Nearby.pendingIncoming()` in `app/_layout.tsx` | on next app launch |

BigK's equivalent of WhatsApp's FCM trick (Play Services holds a system-owned
connection so "closed" apps still ring) is this sticky foreground service +
native advertising. Android's rules are identical for both apps: after a
**force-stop** or an aggressive vendor kill, *nothing* runs until the user
opens the app again.

## Why scanning "sometimes stopped" (root causes, now fixed)

1. **Stuck native session killed discovery forever.** `NearbyTransport.startDiscovery`
   resolves `false` while `session != null || directSession != null`. The
   cleanup guards (`clearEndpoint`'s `handoffReadySession != session` check,
   an abandoned handoff whose cleanup never confirmed) could leave `session`
   or `directSession` set with no live endpoint. JS then marked itself not
   scanning and wiped the presence cache — and *nothing* ever repaired it.
2. **No health re-check anywhere.** If the foreground service died, advertising
   silently dropped (JS failure paths call `stopAdvertising()`), or scanning
   failed while the app stayed backgrounded, recovery only happened on an
   app-foreground event. That is the "app sometimes stops scanning" symptom.

## Changes

### Native (Kotlin)

- **`NearbyTransport.healthWatchdog()`** — periodic self-heal, runs on the main
  thread with no React dependency:
  - no-op while `paused` (never fights a user pause);
  - stuck `directSession`: recover only once `DirectWifiModule.radioReleased`
    (same safe rule as `recoverAfterRadioReset`);
  - `session` whose `sessionEndpoint` is gone from `connected`: dismiss the
    notification and clear the session so `startDiscovery` unblocks, then
    `refreshIdleAdvertising()`;
  - advertising flag false: `restore()`.
- **`AvailabilityService`** — schedules the watchdog every 60s while running
  (`WATCHDOG_INTERVAL_MS`); cancelled on the PAUSE action, on service restart
  (dedupe), and in `onDestroy`.
- **`availabilityStatus`** now reports `scanning` and `advertising`
  (`@Volatile` flags + `isDiscovering`/`isAdvertising` accessors), so the JS
  side can see a dead scan instead of assuming.

### TypeScript

- **`BackgroundAvailability.availabilityHealthCheck()`** (exported, testable):
  every 60s while availability is wanted and no call is active, one cheap
  `availabilityStatus` call. Healthy → no-op. `paused` → honored as user
  intent (`markPaused()`). Service dead or `scanning === false` (absent on old
  APKs → treated healthy) → `resumeAvailability(false)`, which works in
  background (foreground-service *restarts* from background are blocked on
  Android 12+, so the scan-only recovery still works; full service recovery
  happens on the next foreground transition).
- `startAvailabilityLifecycle` wires the interval (unref'd for Node tests) and
  clears it on dispose.
- Extracted `markPaused()` so the paused-branch of `resumeAvailability` and the
  `onAvailabilityPaused` listener cannot drift.

## Limits (identical to WhatsApp)

- **Force-stop / "restricted" battery setting on some OEMs**: Android blocks
  everything, including FCM for WhatsApp. Mitigation already in-app:
  `openBatterySettings` + the availability row tap-to-enable.
- **Presence scanning is inherently JS-driven** (it feeds the UI); receiving
  calls is native and does not need it.

## Verification (2026-10-09)

- `npx tsc --noEmit` — PASS.
- 9/9 suites PASS (plain `node`), including the new
  `scripts/test-availability-watchdog.cjs` (11 tests: 8 behavioural against the
  real transpiled `BackgroundAvailability.ts`, 3 native source-structure
  assertions). Registered in `scripts/build-offline-call.ps1`.
- Native Kotlin is source-verified only in this session (compilation happens in
  the release build). Run `scripts/build-offline-call.ps1` to produce the APK.

## Physical checklist (two phones)

1. Phone B enables availability, then press Home (app backgrounded). Phone A
   calls → B rings via the native notification. ✅ baseline.
2. Repeat with B swiped from recents → still rings (`onTaskRemoved` restore).
3. Kill the JS process (developer option "Kill background activities" or an
   OEM cleaner) → within ≤60s the native watchdog restores advertising if it
   dropped; a call from A still rings B.
4. During an abnormal call teardown (walk out of range mid-connect), watch logcat
   for `Watchdog: stale call session … clearing`; opening BigK on B must show
   scanning recovering within ≤2 minutes without a restart.
5. Tap "Pause availability" in the notification → JS must NOT fight the pause
   (health check logs no recovery, row shows paused, tap-to-enable resumes).

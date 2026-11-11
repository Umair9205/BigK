# Route 1 reliability: teardown, background survival, and range

**Covers round 11 through round 18 (Oct 29 – Nov 3, 2026).**
Rounds 1–10 live in `P2P-NEGOTIATE-CONNECT-2026-10-09.md`.

Goal for this whole stretch: **the caller presses Call and nothing else happens.**
No Wi-Fi toggling, no manual preconditions, no error string that tells the user
to go fix something. Background receive behaves like WhatsApp. Setup latency
stays comfortable.

> Log excerpts below redact the application package and wakelock tag as `<app>`.

---

## Environment these rounds ran on

| | Samsung (walker / callee) | Infinix (stationary / GO) |
|---|---|---|
| Model | Galaxy A10, SM-A105F | HOT 60 Pro (MTK, Wi-Fi 7) |
| OS | Android 11 / API 30 | Android 16 / API 36 |
| Role in P2P | client, `p2p-wlan0-0` | GO, `p2p0` |
| P2P MAC | `f6:7d:ef:97:da:68` | `0a:77:88:51:c6:da` |

- **Clocks differ ≈38 s (Samsung ahead).** Pair sessions by content, never by
  timestamp. Anchor: Infinix `00:49:03.801 Connected: 6XSP` ↔ Samsung
  `00:49:41.751 Connected: FP52`.
- Build: `targetSdk 34`, `minSdk 26`, `compileSdk 37`, `play-services-nearby:18.7.0`.
- Gate: 9 Node suites + `npx tsc --noEmit` + `assembleRelease`. Suites are
  listed in `scripts/build-offline-call.ps1`.
- Both phones are locally-administered (randomised) MACs — but stable, see
  "MAC as identity" below.

---

## Round 11 (build Oct 29 22:38) — P3 teardown + P1 background fixes

### Why

Round 10 ended 4/4 connected but teardown took **13–23 s**, Nearby stayed down
for that whole window, and the callee-side `CONNECT_TIMEOUT` fired 6 times when
the callee's screen was off. Three separate defects, all in the "after the call
ends" and "callee is asleep" buckets.

### What shipped

**P3.0 – P3.3 — teardown instrumentation and latch removal** (`DirectWifiModule.kt`)

- Every stage now logs: `teardown begin / cancel / group / removeGroup /
  group gone / exit session=… reason=… elapsedMs=…`
- `stop()` resolves **as soon as the run closes and teardown is launched**.
  Cleanup is detached, so JS no longer waits on it.
- `radioReleased = true` on every teardown exit path — `no-manager`,
  `cancel-never-acknowledged`, `groupinfo-threw`, `group-never-confirmed` —
  **except** foreign-group. This is the latch that was blocking the repair path.
- Poll budget `GROUP_RELEASE_ATTEMPTS` 28 → 36, fixing an off-by-one where the
  1500 ms confirmation consumed the same 28 attempts spent waiting for death.

**P1.4 — retryable connect timeout** (`services/OutgoingCall.ts`)

- `CONNECT_TIMEOUT` added to `transientConnectionError`.
- `connectionErrorMessage` reordered so "did not respond in time" survives when
  both attempts fail.

**P1.5 — background wake lock** (`AvailabilityService.kt`)

- `PARTIAL_WAKE_LOCK` via `holdWakeLock()` / `releaseWakeLock()`. Acquired when
  `running` becomes true; released in `onDestroy` and the `PAUSE` branch.
- `WAKE_LOCK` now **explicitly** declared in the source manifest (was
  merger-only, and nothing had previously called `acquire()`).

**P1.3 substitute — bounded advertisement staleness** (`NearbyTransport.kt`)

- `IDLE_ADVERTISING_REFRESH_MS = 180_000L`. The idle advertisement is cycled
  every 3 minutes from `healthWatchdog`, gated on idle **and** `radioReleased`,
  via `refreshIdleAdvertising(force = true)`. `advertisingStartedAt` is set on
  `startAdvertising` success.
- **Why a substitute:** `play-services-nearby:18.7.0` has **no**
  `AdvertisingLifecycleCallback` / `DiscoveryLifecycleCallback`. Verified with
  `javap` against the actual AAR (66 classes in the `connection` package;
  neither present; only the 4-arg `startAdvertising` and 3-arg `startDiscovery`).
  So the drop cannot be *observed*, only *bounded*.

**P2 — independent radio probe** (`DirectWifiModule.probePeerRadio(context, tag)`)

- Standalone manager + channel so it can never disturb the call path. Guarded by
  `radioReleased` (skipped entirely mid-call). Logs `staFreq` / `band` and the
  full peer list.
- Called from the `AvailabilityService` watchdog as `[watchdog]`, and from
  `connectCallPeer` as `[call-start role=…]`.

**Fix:** `Unresolved reference: Log` in `DirectWifiModule.kt` — added
`import android.util.Log` (the file used fully-qualified calls throughout).

### Round 11 result (Oct 30) — P3 total success, one new failure mode

| Metric | Round 10 | Round 11 |
|---|---|---|
| Teardown exits | 13–22 s | **17/17 `reason=released`, 2.0–3.3 s** |
| Nearby resume after call | 13–22 s | **6–472 ms** typical |
| `CONNECT_TIMEOUT` | 6 | **0** |
| Worst `control-ready` | 12.6 s | **6.5 s** |
| Calls reaching WebRTC audio | 4/4 | 6–7 of 9 |

- Zero `group-never-confirmed`, zero `cancel-never-acknowledged`, zero
  `foreign-group`. The latch is gone.
- The 3 slow resumes (2.0–3.3 s) were exactly the **failed** calls — they gate
  on the in-flight handoff promise at `DirectCallAudio.ts:390`, not on teardown.
- **Band:** STA *and* group both `2412` (channel 1) on every call this round.
  No band switch ever occurred, so the 5 GHz time-sharing concern was moot here.
  (Round 18 later showed `2462` — it varies by environment, neither is a problem.)
- **Range signal:** `P2PProbe` saw the peer **18/18**. Twelve of those are
  biased (`call-start` probes only run after the Nearby handoff succeeded), but
  the single unbiased watchdog probe is decisive:

  ```
  23:00:45  Infinix [watchdog]  peers=1 Galaxy A10|f6:7d:ef:97:da:68|3   ← AVAILABLE
  23:01:06  Samsung            Could not connect: Peer did not connect within 15 seconds
  ```

  While Nearby's bootstrap was failing outright, Wi-Fi Direct had the contact
  sitting in its peer list, available.

**Remaining failure mode — GO listener timeout (identical signature twice):**

```
Infinix (GO)   phase=listening elapsedMs=4326
Infinix (GO)   phase=listener-retry:SocketException elapsedMs=19153
Infinix (GO)   phase=listener-retry:BindException   elapsedMs=19215
Samsung        connect to the other phone failed (2); retry=1…8
```

The group forms fine; the GO binds and waits; **the client never arrives**
because the callee is still fighting the BLE handshake. The listener sits
through its 15 s accept timeout, retries, hits the port still in use, gives up.

**Churn feedback loop discovered:** `refreshIdleAdvertising` fires on *every*
endpoint closure. During a BLE flap, 23 refreshes in ~2.5 min on the Samsung,
1.5–7 s each, some with **under a second of uptime** before being torn down
again. Pre-existing, not a regression from this build — but it plausibly
amplifies the instability that triggers it.

**Minor:** `removeGroup failed reason=0` on the Samsung ×4 — a client cannot
remove a group it does not own. Harmless, wasteful.

---

## Round 12 (build Oct 30 22:47) — churn debounce, walk instrumentation, MAC log

### What shipped

**1. Advertisement-churn debounce** (`NearbyTransport.kt`)

- `CLOSURE_REFRESH_MIN_INTERVAL_MS = 30_000L`. Closure-triggered refreshes are
  throttled to at most one per 30 s. The scheduled staleness cycle uses
  `force = true` and is **not** throttled, so a skipped closure-refresh can never
  leave an advertisement stale beyond 3 minutes.

**2. Paired range instrumentation**

- New `NearbyProbe` snapshot: `probeNearbySnapshot(tag)` logs
  `advertising / discovering / discovered / connected / pending / paused /
  directSession / session` in one read-only line.
- Watchdog now runs the P2P probe **and** the Nearby probe together so both
  paths report at the same timestamps.

**3. MAC logging** (`MacMap` tag)

- Both resolution points in `pollPeerAddress` log
  `contact=… device=… mac=… by=name|single-available`.

**Watchdog interval** 60 s → 20 s (later → 5 s, see round 18 build).
`test-availability-watchdog.cjs` pins the literal value, so the assertion was
updated alongside each change — it is a regression guard, not a constraint.

### Round 17 log (`log_bigk_infinix_17.log`) — inconclusive, one bug found

The walk test did **not** produce a range number:

- Calls during the walk gated the P2P probe (`probePeerRadio` returns while
  `!radioReleased`). Four call attempts between 22:06:37 and 22:08:35.
- The app was opened on the stationary phone at 22:09:00; probes stopped
  entirely after 22:08:56 with zero app output for the remaining 100 s.
- Only one phone's log was captured.

**What it did teach us:**

- **Nearby's connection is more fragile than its discovery.**

  ```
  22:08:54.032  [NearbyDiscovery] Connection closed: '5MND'
  22:08:55.946  NearbyProbe: discovered=1 connected=0   ← discovery still alive
  22:08:55.963  P2PProbe:    peers=1 Galaxy A10|…|3     ← P2P still alive
  ```

  The connection died while *discovery* on both radios kept working.

- Three call-requests reached the stationary phone while the Samsung was walking
  (`22:07:29`, `22:07:40`, `22:08:12`) — Nearby signaling worked at those
  moments. Nobody answered: the callee only shows the incoming-call UI.
- Band this round: `2462` (channel 11) for both STA and group.

**Bug found — WakeLock leak:**

```
holdWakeLock calls:              7
"finalized while still held":    7
```

Every `onStartCommand` allocated a **fresh** WakeLock over the old reference
without releasing it; the orphaned objects were then finalised while still held.
Fixed with an `isHeld` guard so a repeated start reuses the existing lock.

---

## Round 18 builds (Nov 3) — 5 s probes, stop diagnostics

### "Is 20 s not too long?" — yes

| Walking pace | 20 s per probe | 5 s per probe |
|---|---|---|
| Normal (1.4 m/s) | 28 m | **7 m** |
| Slow (1 m/s) | 20 m | **5 m** |

At 20 s a 20–50 m range yields 1–3 data points — unusable. `WATCHDOG_INTERVAL_MS`
set to **5_000L**. Cost: 12 scans/min instead of 3, **but only while idle** —
the probe is skipped entirely mid-call. Faster ticks also keep `mPeers` warm,
which the round-13 MAC-keyed path needs.

### Silent stop paths made audible

Round 17 lost its watchdog with no trace. Three `stopSelf()` paths existed and
none of them logged:

```
Availability: Stopping: PAUSE action requested
Availability: Stopping: availability is paused
Availability: Service destroyed; watchdog cancelled (paused=… wasRunning=…)
```

Behaviour unchanged — instrumentation only.

### Gate status after every build in this stretch

| Build | Suites | tsc | gradle | APK |
|---|---|---|---|---|
| Round 11 | 9/9 | 0 | success | 57.6 MB, Oct 29 22:38 |
| Round 12 | 9/9 | 0 | success | 57.6 MB, Oct 30 22:47 |
| WakeLock fix | 9/9 | 0 | success | 57.6 MB, Nov 3 22:23 |
| 5 s watchdog | 9/9 | 0 | success | 57.6 MB, Nov 3 22:42 |
| Stop diagnostics | 9/9 | 0 | success | 57.6 MB, Nov 3 22:50 |

---

## Round 18 logs (Nov 3) — the freeze

Files: `log_bigk_infinix_18.log` (stationary) + `log_bigk_SM_17.log` (walker).
Clean test: **zero calls on both sides.** No range number — but a much bigger
problem surfaced.

### Timeline (Infinix)

```
22:53:20  new APK installed (deletePackageX)
22:55:02  process 6666 started
22:55:15  Background started FGS: Allowed [uidState: TOP; code:PROC_STATE_TOP;
          startForegroundCount:0]        ← system confirms the service started
22:58:08  measurement running — both phones see each other
22:58:13  … still fine
22:58:18  … still fine
22:58:23  … still fine
22:58:28  … still fine
22:58:33  … still fine
22:58:38  … still fine                  ← 7th and last measurement
22:58:35  user presses Home (APP_SWITCH → XOSLauncher)
22:58:40  Usf_Hiber: enter FrozenState → freeze uid 10388   ← 5 s later
          proxyWakeLock: add … '<app>:availability LONG
          proxyManager: p_service / p_alarm / p_sensor / p_job
22:59:00  proxyWakeLock: drop … '<app>:availability
          (process never runs again)
```

### Diagnosis

**Our code did everything right.** The system explicitly approved the foreground
service; `Foreground startup failed` never appears; the manifest declares
`FOREGROUND_SERVICE`, `WAKE_LOCK`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`, the
service carries `foregroundServiceType="connectedDevice"` and `stopWithTask="false"`.

**Transsion's power manager froze it anyway.** Its rule, as logged:
*backgrounded + no network traffic (`isTrafficActive … speed :0`) = freeze after
5 seconds.* Our app was already on its list —
`Usf_Hiber/config: pkgName: com.anonymous.<app> add to third app list` —
and it neutralised **everything**: wake lock, service, alarms, jobs, sensors.

None of the new stop diagnostics fired, because `onDestroy` never runs on a
frozen process — the process is alive but cannot execute. That is exactly why
the instrumentation was added and exactly why it was insufficient: **freezing is
not a stop.**

### Why both sides of the range data are invalid

- **Stationary phone:** measured 30 s, then froze.
- **Walking phone:** `peers=0` for the entire 5-minute walk. Not a range result
  — the Infinix had already been frozen at 22:58:40, 51 s before the Samsung's
  first probe at 22:59:31, so it had stopped running `discoverPeers()` and was
  no longer answering probe requests.

### The one genuinely interesting signal

```
Infinix frozen at 22:58:40
Samsung Nearby:  discovered=1 until 23:01:37   ← +3 minutes
Samsung P2P:     peers=0 from the first probe  ← instant
```

**Bluetooth presence outlived our process by ~3 minutes**, because GMS Nearby
holds the advertisement in a *separate* process. Wi-Fi Direct discovery died
instantly, because it runs inside our own.

This is the first concrete evidence for the architecture decision: **keep Nearby
as the presence layer, move the call path to Wi-Fi.** The bootstrap should never
be weaker than the data plane — and presence, at least, survives us.

---

## Round 19 log (Nov 5) — the exemption does NOT stop the freeze

`log_bigk_infinix_19.log` — single-phone test on the Infinix only (no second
phone, no calls). Purpose: verify whether the app survives backgrounding after
the battery-optimization exemption was granted. Log window 00:14:57–00:21:29,
uid now **10391** (reinstalled; round 18 was 10388), app pid **21836**.

### What happened (timeline)

| Time | Event |
|---|---|
| 00:14:57 | old build force-stopped by `deletePackageX`, new APK installed |
| 00:17:25 | `Usf_Hiber/config: … add to third app list` — the freezer registers us |
| 00:17:54 | `Background started FGS: Allowed … uidState: TOP` — manifest still correct |
| 00:18:15 | **freeze #1** (before the exemption) — user backgrounded the app |
| 00:18:25 | `reason=13 OTHER KILLS … subreason=101 Swipe-up clean … manual_swipUpClean` — **user swiped the app from recents**; process 9255 killed cleanly |
| 00:18:55 | `Start proc 21836` — user reopened the app |
| 00:18:57 | `Availability: Holding partial wakelock; screen stays off` |
| 00:18:59 | `[BatteryExemption] system dialog requested` → system dialog shown |
| 00:19:01 | **`[BatteryExemption] after prompt: unrestricted=true`** — exemption GRANTED |
| 00:19:06, 00:19:11 | two clean probe cycles, 5 s apart (watchdog healthy) |
| 00:19:09 | Home pressed (`APP_SWITCH … prevPkgName:com.anonymous.<app>`) |
| 00:19:14.08 | `PowerManagerService: Going to sleep` (screen off) |
| 00:19:14.49 | **`Usf_Hiber/appStateMachine: uid:10391 enter FrozenState`** — frozen 13 s after the grant |
| 00:19:14.49 | `proxyWakeLock: add/drop … '<app>:availability'`; `p_service`, `p_alarm`, `p_sensor`, `p_job` all proxied |
| 00:19:17 | `netd: socketDestroy([10391])` — our sockets torn down |
| 00:19:14 → end | **pid 21836 produces ZERO log lines** for 2 min 15 s until capture ends |

### Verdict

1. **The battery-optimization exemption is granted but does not stop Transsion's
   freezer.** This is a clean A/B inside one log: granted at 00:19:01,
   `isIgnoringBatteryOptimizations == true`, Home at 00:19:09, frozen at
   00:19:14. The honest caveat in the round-18 write-up is now settled the
   negative way: **`Usf_Hiber` is its own layer and ignores the standard
   whitelist.** (It also froze WhatsApp ×3, ChatGPT, Claude in the same window —
   it freezes *everything* third-party. GMS: 0 freezes.)
2. **Not a kill — a freeze.** The only real kill in the log was the user's own
   swipe-up clean at 00:18:25 (round-18 stop diagnostics never fired because
   `onDestroy` doesn't run on a frozen process; same signature as round 18).
3. **The freeze is background-triggered, not screen-off-triggered** — freeze #1
   at 00:18:15 happened with the screen still on.
4. **GMS-side presence survived again**: `NearbyMediums: Current Tracked Scanning
   Clients … com.<app>.nearby.control.v2` kept printing every ~8 s from
   00:19:17 to 00:21:21 — the second consecutive confirmation that GMS holds our
   advertisement/scanner while we are frozen (round-18 finding: +3 min).
5. `Usf_Hiber/config: … add to third app list` — we are explicitly classified
   as a third-party app by the freezer; `isTrafficActive uid:10391 speed :0`
   immediately before each freeze shows its trigger is *no traffic*, not
   battery level.

### Consequences

- The one-time dialog stays (it is required for stock Android Doze and costs
  nothing), but **on the Infinix it is not the fix**. Next candidates, in order:
  - **CDM presence observation** — only path where the *system* wakes us when
    the friend appears; unproven against `Usf_Hiber` (it proxies `p_service`).
  - **XOS one-time setup** (manual, conflicts with no-precondition rule):
    Settings → App management → BigK → Battery → Unrestricted / allow
    background activity; Auto-start management; Phone Master → Protected apps;
    lock the card in Recents. Reported by owners to be flaky after XOS 15.1.2
    updates (items renamed/removed).
  - **Keep the app doing something the freezer counts as traffic** —
    `isTrafficActive speed :0` is the freeze trigger; a cheap keep-alive that
    registers non-zero traffic *might* defer it. Unproven, speculative.
- The swipe-up clean at 00:18:25 killed an FGS-declared service with no
  restart until the user reopened the app — swiping from Recents is a real
  kill on XOS; the retest checklist's "Home, not swipe-away" rule stands.

---

## Round 20 build (Nov 5, 01:53) — traffic keep-alive + both P0s

Chosen after the round-19 verdict: attack the freezer's logged trigger
directly, and ship the two deferred zero-risk fixes in the same APK. Gate:
9/9 suites PASS, `tsc --noEmit` exit 0, `assembleRelease` BUILD SUCCESSFUL,
APK 57.6 MB (Nov 5 01:53).

### Traffic keep-alive (`TrafficKeepAlive.kt`, new)

The trigger logged immediately before every freeze is
`isTrafficActive uid:<us> speed :0` — traffic, not battery level. The object
sends, at **1 Hz while the availability service runs**:

1. one small **valid DNS A/IN query** for a unique label to the network's DNS
   server (any resolver answers, so the UID sees RX as well as TX), and
2. one **1024-byte padded datagram** to port 9 on the same target, so even an
   integer-KB/s reading of a 1 s window cannot round us to 0.

Design notes:

- **Wi-Fi only** (`TRANSPORT_WIFI`; P2P groups report it too — there is no
  separate P2P transport constant, which the first compile caught).
  Metered cellular must not carry background junk, and cellular is not the
  environment we are defending anyway.
- **Gateway first, non-loopback DNS second.** The gateway answers even with
  the WAN down; a loopback DNS entry (local resolver) would send on `lo`,
  which the radio never sees.
- Single-thread executor with an `inFlight` guard: a stalled send (ARP on a
  sleeping AP) must not build a backlog behind the 1 Hz ticker. Sockets are
  process-lifetime — closing them races an in-flight ping for no benefit.
- Replies are drained (8 max/tick, 1 ms timeout) only so the receive buffer
  cannot fill; a delivered reply already counts as RX at delivery time.
- Wired at all three service lifecycle points: start in `onStartCommand`,
  `stop()` on the PAUSE action and in `onDestroy` (2 stop sites, pinned).

Honest limits: with **no Wi-Fi interface up** (beyond AP range, no P2P group)
there is nothing to send on and the freeze proceeds — that is the walk-away
case, and it is exactly what the next log will tell us. If `KeepAlive:
sending to …` lines are present and `isTrafficActive` still reports
`speed :0`, the counter wants a different unit or RX-only traffic; tune from
that evidence rather than guessing.

### P0 #1 — owner-address guard (`DirectWifiModule.kt`, queryGroup)

XOS reports `group.owner.deviceAddress = 02:00:00:00:00:00` (placeholder).
The old guard failed any mismatch outright, so the client role would die
with "Connected to an unexpected Wi-Fi Direct device" on every call —
harmless only while the Infinix is always `owner=true`. Now the placeholder
(`02:00:00:00:00:00` / `00:00:00:00:00:00`) proceeds with a warning — the
control socket's token handshake is the real authentication — while a
genuine mismatched MAC still fails. Null owner still fails (unchanged).

### P0 #2 — accept-gate rejection logging (`NearbyTransport.kt`)

The incoming-connection gate rejected silently. It now logs, at `Log.i`
tag `NearbyModule`:

```
accept gate rejected endpoint=… peer=… directSession=… paused=… unsavedContact=… otherEndpointBusy=…
```

No behavioural change — the gate itself is pinned by the one-way-add test
and is untouched.

### Test pins added

- `test-direct-call.cjs`: placeholder bypass must exist in `queryGroup`.
- `test-background-availability.cjs`: the gate must log its reason.
- `test-availability-watchdog.cjs`: new test — `INTERVAL_MS = 1_000L`,
  Wi-Fi-only, no-loopback, datagram send, `TrafficKeepAlive.start(this)` and
  exactly 2 `stop()` sites in the service.

---

## Round 20 log (Nov 5) — the keep-alive did not move the metric

`log_bigk_infinix_20.log` (3.6 MB, 02:11:34 → 02:16:20). Reinstall → new
uid 10392, process 8112.

### Timeline

| Time | Event |
|---|---|
| 02:12:28.137 | app opened (`Start proc 8112`); `[BatteryExemption] already unrestricted` — the grant survives reinstall |
| 02:12:30.753 | `KeepAlive: starting; 1 Hz keep-alive over Wi-Fi only` |
| 02:12:31.764 | `KeepAlive: sending to /192.168.100.1 over Wi-Fi` (announce-once — the only send line v1 ever logs) |
| 02:12:32.081 | **Home** (APP_SWITCH → XOSLauncher) |
| 02:12:35.765 | watchdog probe still running post-Home ✓ |
| 02:12:37.087 | `isTrafficActive uid:10392 speed :0` → `enter FrozenState` → **freeze, 5 s after Home** |
| 02:12:37.097 | `<app>:availability` wakelock force-released; `p_service/p_alarm/p_sensor/p_job` proxied |
| 02:12:40.104 | `netd socketDestroy(UidRange{10392})` — all sockets killed 3 s after the freeze |
| 02:14:32 | screen off (timeout) |
| 02:16:04.670 | LcdOn pass re-evaluates `uid:10392 speed :0` — **no unfreeze** (weather app 10266 unfroze with `reason:LcdOn` in the same pass) |
| 02:16:20 | capture ends; process never woke |

### Verdict

**Keep-alive v1 failed.** The discriminator branch `speed :0` with
`KeepAlive` lines present fired: the freezer did not count v1's ~5–6 KiB of
TX (RX unknown) in the 5 s it had. Same freeze shape as round 19 — 5 s after
Home — with the exemption already granted and the keep-alive demonstrably
running before the decision.

### What the log taught

1. **The metric is quantised.** Across 22 `isTrafficActive` samples of 9 uids
   the only values ever logged are `:0` and `:1`. uid 10354 reads `:1` at both
   LcdOn passes and is never frozen; every `:0` uid is frozen. Threshold = 1.
2. **Three freeze triggers, all consulting `isTrafficActive`:**
   - TOP → background **+5 s** (our freeze — screen still ON);
   - bump/sync end **+3–14 s** (weather: `bumpService` unfreeze → frozen 3 s
     later; `syncBinder` unfreeze → frozen 14 s later);
   - screen-off **+~23 s** (weather: off 02:14:32 → frozen 02:14:55).
   LcdOn never freezes — it only unfreezes — and it did not unfreeze *us*
   (unresolved; the FGS + proxied state is the obvious difference).
3. **Screen-on does not rescue a frozen Infinix app.** Frozen = dead until
   the user reopens it.
4. **No cellular activity anywhere in the capture** (zero ServiceState/rmnet/
   SignalStrength lines) while uid 10354 still reads `:1` — the metric reads
   Wi-Fi/total traffic, a cellular-only counter is ruled out, and the
   keep-alive is in the right arena.
5. Exemption re-confirmed irrelevant (`already unrestricted`, 02:12:28).

### What v1 could not tell us

- Whether sends continued after the first (announce-once hides them). The
  tick chain reviews clean, but there was no evidence either way.
- Whether the router ever answered the DNS query (RX unknown).
- The window/unit behind `speed`: `:0` at t+5 s fits a ≥~7 s window in KB/s
  or packets/s, *or* an RX-only counter that saw nothing.

## Round 21 build (Nov 5, 21:34) — keep-alive v2: burst, RX probes, counters

Answers all three unknowns in one APK. Gate: 9/9 suites PASS, `tsc --noEmit`
exit 0, `assembleRelease` BUILD SUCCESSFUL, APK 57.6 MB (Nov 5 21:34).

### What changed in `TrafficKeepAlive.kt`

- **Burst phase (first 60 s):** 16 × 1 KiB pads/tick = 16 KB/s *and*
  16 pkt/s — at the 5 s decision any window ≤ ~80 s in any plausible unit
  already reads ≥1 — plus 5 TLS handshakes/tick.
- **Sustain phase:** 2 pads/tick (holds ≥1 for the screen-off and bump-end
  passes once the ramp is complete) plus 1 handshake every 2 ticks
  (~1.3 KB/s RX in case the counter is receive-only).
- **RX probes:** trust-all TLS handshake to 1.1.1.1/8.8.8.8 :443 — the
  server's first flight is KBs of RX per attempt. Own executor with
  400 ms connect / 750 ms read timeouts: a probe that times out must never
  stall the pads; an offline LAN degrades to counted failures.
- **DNS to every resolver:** gateway + all non-loopback LinkProperties DNS +
  8.8.8.8/1.1.1.1 (cap 6 targets) — a reply from any of them is RX for this
  UID; ICMP unreachable from the pad port no longer aborts the drain.
- **Counters every 10 ticks** — the round-21 discriminator:

  ```
  KeepAlive: n= sent= err= rxPkt= tlsOk= tlsFail= txB= rxB= phase=burst|sustain wifi=true|false
  ```

  `txB/rxB` are `TrafficStats` uid totals — the same class of counter a
  vendor metric would read. If `txB` climbs ~16 KB/s while the freezer still
  logs `speed :0`, the freezer is not reading uid stats at all, the
  keep-alive lever is dead, and the answer is the XOS pass → CDM.

### Honest limits

- Wi-Fi only; with no interface up the counter line logs `wifi=false` and
  the freeze proceeds (walk-away case).
- Sustain handshakes cost a few MB per backgrounded hour — fine for test
  builds; re-price before shipping if the counter proves RX-only.

---

## Round 21 log (Nov 5) — traffic registered, and the freeze happened anyway

`log_bigk_infinix_21.log` (1.7 MB, 21:46:42 → 21:49:04). Reinstall → uid
10393, pid 16098. logcat was cleared at 21:46:42, ~15 s after the keep-alive
started, so the `starting`/`sending` lines predate the capture — the n=20
counter line proves the ticker had been running 20 s.

### Timeline

| Time | Event |
|---|---|
| ~21:46:27 | keep-alive started (`n=20` at 21:46:47.726 ⇒ first tick ~21:46:28) |
| 21:46:42.7 | watchdog probe running, 5 s cadence ✓ |
| 21:46:44.226 | **Home** (APP_SWITCH → XOSLauncher) |
| 21:46:47.726 | `KeepAlive: n=20 sent=380 err=0 rxPkt=54 tlsOk=10 tlsFail=22 txB=351036 rxB=56626 phase=burst wifi=true` |
| 21:46:49.245 | `isTrafficActive uid:10393 speed :8` → `enter FrozenState` → **freeze, Home +5.0 s** |
| 21:46:49.252 | `<app>:availability` wakelock force-released; `p_service/p_alarm/p_sensor/p_job` proxied |
| 21:46:52.262 | `netd socketDestroy(10393)` |
| after | pid 16098 total silence (own last line 21:46:47.728), no n=30 line, no `stopped`; capture ends 21:49:04 with the process still frozen |

### Verdict

**v2's machinery worked, the metric MOVED (`speed :0` → `speed :8`), and the
freezer froze us anyway — Home +5.0 s, exactly as rounds 19 and 20.**

- Sends: 380/380 succeeded (`err=0`); txB = 351 KB over 20 s ≈ **17.5 KB/s**
  — the burst rate landed.
- RX: 54 replies drained, 10 TLS handshakes completed (22 failed fast);
  rxB = 56 KB ≈ **2.8 KB/s** — the RX path works too.
- The metric is therefore **numeric, not binary** (round-20's 0/1 observation
  was just low traffic everywhere) and it does read this phone's Wi-Fi uid
  traffic. `:8` ≈ total bytes over a multi-tens-of-seconds window in KB/s —
  ramp-limited: full burst rate would read ~17 once the window is saturated.

**Discriminator branch fired: `speed :N` with N > 0 and a freeze anyway →
traffic is not the (only) lever.** Either the sparing threshold sits above 8
— and any volume that might beat it (tens of KB/s at every background
transition) is not shippable as an always-on burner — or the background+5 s
decision does not consult the metric for sparing at all. Round 19's note
that XOS froze WhatsApp/ChatGPT/Claude too now reads as the standard XOS
model: **third-party apps are frozen +5 s after backgrounding unless
whitelisted by XOS's own toggles; `isTrafficActive` is telemetry or gates
something subtler.**

Keep-alive is demoted: retained for observability (the counter line is now
the instrument), stock-Android Doze, and borderline devices — not as the
Infinix fix.

### The wake mechanism XOS does allow (two more findings from this log)

1. **WhatsApp survives by being *woken*, not by being *spared*.** Twice in
   this capture: `unfreeze uid: 10302 com.whatsapp … reason:asyncBinderWhiteList
   cpninfo:TRANSACTION_2 … last freeze 0s ago` → `transition from Frozen to
   Running, reason=asyncBinderWhiteList` (21:46:47.9 and 21:47:23.9), then
   re-frozen. XOS unfreezes a frozen app when an async binder transaction
   from a whitelisted source arrives — for WhatsApp that source is its GMS
   push channel (its 14× freeze/unfreeze churn in this capture is that
   heartbeat). We have no push channel (and no server to originate one), but
   the *mechanism* is reachable from any whitelisted source — GMS and
   `system_server` above all.
2. **GMS kept OUR Nearby discovery alive through the whole freeze.**
   `NearbyMediums: Current Tracked Scanning Clients are : {…,
   com.<app>.nearby.control.v2}` printed every ~8 s from 21:46:42 to
   21:48:59 — that is our own `SERVICE_ID` (`NearbyTransport.kt`), so GMS
   kept scanning **on our behalf for 2+ minutes after the freeze at
   21:46:49** (pre-freeze probes also showed `advertising=true`; same
   registration family). When a friend's phone advertises, GMS will find it
   and must deliver `onEndpointFound`/connection callbacks into our frozen
   process — *the exact class of transaction that unfroze WhatsApp*.
3. Post-freeze, the only mentions of our package are proxy lines (wakelock
   force-release, `idleUids`, `p_job`/`p_alarm`/`p_sensor`) — nothing
   attempted delivery, because nobody was advertising near us during this
   test. **Every freeze test so far had no caller: the wake path has never
   been exercised.**

### Round 22 = does a real call wake the frozen callee? (no build)

The user confirms all four XOS toggles were already in place before round
21 — so that freeze is a *provisional* negative for the settings pass. One
caveat worth a 10-second look: the reinstall changed our uid (10392 →
10393) and XOS's auto-start/protected lists sometimes reset on reinstall —
if BigK dropped out of any list, re-add it (restores one clean measurement).
If all four still list BigK, the pass is dead and stays dead.

What matters more: the existing Nearby path may *already* receive in
background through the GMS-wake mechanism above. Test it directly —
**Infinix = callee (USB attached), Samsung = caller:**

1. `adb logcat -G 8M` → `adb logcat -c`.
2. Sanity first: one call with the callee in the foreground (must work
   before the background test means anything).
3. Open BigK once on the Infinix → press Home → wait 60 s (frozen by then —
   same pattern as rounds 19–21).
4. On the Samsung: press Call on the Infinix contact. Watch the Infinix
   screen for ~60 s — does it ring (UI or notification)? Caller showing
   "did not respond" while the callee stays silent = the negative result.
5. `adb logcat -d -v threadtime > log_bigk_infinix_22.log` and send it.

Greps: `unfreeze uid: 10393` (any reason), `asyncBinderWhiteList`,
`onEndpointFound|onIncoming|onConnectionResult`, `KeepAlive:`,
`NearbyProbe:`, `enter FrozenState`, plus the Nearby lines in the call
window (did GMS see the caller at all?).

Discriminator:

- **Unfreeze + ring** → background receive works through the existing path
  → answer it, then straight to the walk-away range test (next small build
  then = callee auto-answer so it can pick up unattended).
- **Caller "did not respond", callee log shows GMS saw/notified us but no
  unfreeze** → GMS delivery does not wake us (whitelist is target-based)
  → CDM presence observation build — same wake class, `system_server`
  source.
- **Caller "did not respond", GMS never saw the caller** → advertising or
  discovery died with the freeze — a different bug; fix that first.
- **No freeze this round** (the reinstall had reset the toggles and they
  are now fixed) → range test directly.

---

## Decisions that shaped this stretch

- **`play-services-nearby:18.7.0` has no lifecycle callbacks** — verified with
  `javap` against the AAR. Staleness is *bounded*, never *observed*.
- **UUID→MAC cache dropped** — the framework's own peer list already retains
  peers between runs (warm resolutions 17/29/18 ms); a second cache would
  duplicate it.
- **`radioReleased` gates only Nearby resumption, never starting a P2P call** —
  `begin()` checks `stopping || run != null`. This is what makes the
  P3.1/P3.2 decoupling safe.
- **Wi-Fi Aware is dead for this fleet** — Infinix reports `usable channels []`;
  both phones log `WifiAwareManagerHelper … never started`. Not carried forward.
- **Wi-Fi Direct discovery is the only remaining range lever** — Nearby's
  bootstrap on this pair is BLE/GATT with `reason=22` (Connection Terminated by
  Local Host) churn, 22× on the Infinix in one round. Wi-Fi Direct degrades to
  "slow"; Nearby degrades to "flaky".
- **Name-matching for P2P peers is dead code in practice** — every
  `pollPeer_address` resolution was `by=single-available`, never `by=name=`.
  The contact name and the system P2P device name are different namespaces
  (`expected=[Test]` vs device `Infinix HOT 60 Pro`).
- **SSID/passphrase path: rejected** — depends on `createGroup()`, refused
  `P2P_UNSUPPORTED` on this hardware.
- **IP fixing: rejected** — no public API for a static P2P address; the GO is
  always `192.168.49.1` by spec and the client's address is never read.
- **Negotiated-medium log not implementable** — no medium accessor on the public
  `ConnectionsClient`. STA frequency/band is logged instead
  (`medium: 'not exposed by API'` in `CallMetrics`).

### MAC as identity — the fact round 13 depends on

| Device | MAC | Rounds seen |
|---|---|---|
| Galaxy A10 | `f6:7d:ef:97:da:68` | 9, 10, 11, 17 (Oct 15 → Nov 3) |
| Infinix | `0a:77:88:51:c6:da` | 10, 11, 17 |

Both are locally-administered (so *can* rotate on factory reset or OEM
schedule), but they have not in 19 days across four rounds. That is what makes a
MAC-keyed call path viable: record the friend's P2P MAC at QR pairing, then
`discoverPeers()` → `connect(friendMac)` → group → TCP → token, with **Nearby
out of the call path entirely**.

### The design flaw this stretch kept rediscovering

**The bootstrap runs on a weaker radio than the data plane.** Discovery and
control over BLE (5–15 m, a GATT handshake that must succeed *and survive*);
audio over Wi-Fi Direct (30–100 m, fire-and-forget). The bootstrap is therefore
*structurally guaranteed* to be the limiting link — which is precisely the shape
of every round-11 GO-listener timeout: Wi-Fi side fine, group already formed,
client never arrives because the callee is still fighting BLE.

BLE cannot be improved: Android exposes no usable TX-power control to apps, and
`PHY_LE_CODED` would need our own BLE layer to replace Nearby anyway — more work
than moving to Wi-Fi for *less* range. Wi-Fi TX runs at +16 to +20 dBm, roughly
16–20 dB over BLE.

---

## Open items

### Immediate — the blocker

**Status after Nov 6 (round 23): FIXED on hardware — 1x1 overlay window plus a
keeper VPN. Both are in the tree; details and measurements in the next
section.**

**The app does not survive being backgrounded on the Infinix.** Press Home, put
the phone in a pocket, and it stops listening for calls. Nothing else is worth
doing until this is fixed; a range number is useless if the phone kills the
listener before you walk ten metres.

**Status after round 19 (Nov 5): the battery-optimization exemption is built,
granted, and DOES NOT stop the freeze.** The dialog works end-to-end
(`[BatteryExemption] after prompt: unrestricted=true`, granted 00:19:01) and
`Usf_Hiber` still froze the app at 00:19:14 — 13 s after Home, with
`isIgnoringBatteryOptimizations == true`. The round-18 caveat is now settled:
**Transsion's freezer ignores the standard whitelist entirely** (it froze
WhatsApp, ChatGPT, Claude in the same window; GMS never freezes).

**Status after round 20 (Nov 5): the 1 Hz traffic keep-alive (v1) does NOT
stop the freeze either.** It demonstrably ran — `starting` 02:12:30, first
send 02:12:31, Home 02:12:32 — and the freezer still logged
`isTrafficActive uid:10392 speed :0` at the decision (02:12:37) and froze.
v2 (burst volume + RX probes + logcat counters) is built; see the round-20
log and round-21 build sections above.

**Status after round 21 (Nov 5): v2 kept the traffic flowing — 380/380
sends, 17.5 KB/s TX, 2.8 KB/s RX — moved the metric from `speed :0` to
`speed :8`, and the freezer froze the app anyway, Home +5.0 s.** Traffic is
not the sparing lever on this phone (threshold above 8, or not consulted at
all). The XOS settings pass was already applied before this test —
provisionally negative (verify the reinstall didn't reset the lists). The
round-22 experiment: does an incoming Nearby connection wake us via the GMS
`asyncBinderWhiteList` mechanism (GMS kept our discovery registered through
the freeze)? CDM presence observation remains the structural fallback.

What the exemption is still good for: stock Android Doze on non-Transsion
phones. It stays — it cost nothing and is required there. It is not the
Infinix fix.

Built anyway (Nov 4, APK 10:40 PM), kept as the stock-Android path:

- `CallForegroundServiceModule.isBatteryUnrestricted()` /
  `requestBatteryExemption()` — reads `PowerManager.isIgnoringBatteryOptimizations`
  and fires `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` for this package,
  falling back to the battery-settings page if an OEM refuses the direct dialog.
- `services/BatteryExemption.ts` — `ensureBatteryExemption()` asks **once per
  install** (flag in AsyncStorage), only while foregrounded and never mid-call,
  and never blocks setup or a call. Declining is remembered; the Settings row
  remains as the manual path.
- Called from the identity-ready effect in `app/_layout.tsx`, so it covers both
  first launch and phones that already completed setup.

### Freeze-layer probes + controlled listener experiment (Nov 6, no build)

Direct reverse-engineering of the XOS freezer over USB (Infinix, installed
build `1.1.3-control-recovery`; BigK uid is now **10395** — reinstall changed
it again from 10393, and it appears in the freeze list as expected).

**What the engine is.** `Usf_Hiber` runs in its own process (pid 3409, tags
`Usf_Hiber/*` + `UsfSystemServer/*`); the `hiber` service is a raw BBinder
that refuses `dumpsys` (`FAILED_TRANSACTION`); stock AOSP `app_hibernation`
is irrelevant (everything `hibernated=false`); settings expose `usf_*` /
`tran_usf_*` keys but no readable whitelist, and `getAppListMode: mode=1,
appModeList=[]` shows an empty per-app mode list. Notably the freeze engine
**itself runs as a notification listener**
(`com.transsion.usf/.scene.app.TranAppStateManager` in the live-listener
list) — it classifies notifications into "important scenes".

**`importantScene` census** (what it watches, logged every ~30 s): `VPN`
(88 checks), `widget` (46), traffic/uid speed checks (291 + 62 + 5),
`input`, `bg`.

- **Round-20 mystery SOLVED:** `widget: packageName=com.rlk.weathers` →
  `uid:10266 … transsion F to R because of LCD on, importantcase is :
  widget`. Weather thawed on LcdOn because it has a home-screen widget; we
  have none, so LcdOn never touched us. A widget buys a **screen-on wake
  only** (weather still spent most of the day frozen) — not prevention.
- **VPN is an explicit scene:** `VPN: packageName=com.cloudflare...` logs
  every 30 s while WARP's tunnel is up. WARP (uid 10396) was frozen at
  00:10 and 11:08 (tunnel presumably down) but **not into `FrozenState` once
  since 19:27 while the VPN lines run** (it still appears in transient
  `fastFreeze reason=cpuboost` lists, thawed 3 s later). The carve-out names
  the **VPN owner package**, so only a BigK-run `VpnService` would exempt
  *us* — somebody else's tunnel buys us nothing.

**Unfreeze-reason census** (whole buffer, 1,093 freeze events): `packet` 93
(all WhatsApp), `asyncBinderWhiteList` 16 (WhatsApp `TRANSACTION_2` = GMS
push, Cloudflare `TRANSACTION_3`), `broadcast` 12, `wakeup` 9, `LcdOn` 5,
`bindService` 1 (WhatsApp, `cpninfo:… # 1000` — a system_server bind thawed
it), `bumpService` 2, `alarm` 1. At freeze, `netd: Destroyed N sockets for
uids{…}` — so the `packet` wake class is unavailable to us (our listening
sockets die with the freeze), and WhatsApp's 113 freezes / constant churn
show how selective `asyncBinderWhiteList` is in practice.

**Controlled listener experiment (hayloufun, Nov 6).** The earlier
correlation — zero freezes for the five enabled notification listeners in
1,093 events — was confounded (smartpanel/kolun run as system uid;
atomicbrain is a priv-app on XOS's critical list, LRU `BFGS`,
launcher-bound). Clean subject: `com.yingsheng.hayloufun`, third-party
(`/data/app`), listener enabled, no other privilege, not running before the
test.

| Time (Nov 6) | Event |
|---|---|
| 20:41:01.821 | user taps it; process starts |
| 20:41:01.9–03.1 | all four ServiceRecords created — NMS binds `MsgNotifyService` with `flags=0x5000101` (`BIND_AUTO_CREATE \| BIND_NOT_PERCEPTIBLE \| BIND_FOREGROUND_SERVICE \| BIND_ALLOW_WHITELIST_MANAGEMENT`), `ConnectionRecord … FGS`, LRU `BFGS`; listener connected during app init |
| ~20:41:11 | user presses Home |
| **20:41:15.957** | **`freeze uid: 10351` anyway — Home +5 s, `speed :0`, binding live for 13 s** |
| 20:41:18.969 | `netd: Destroyed 7 sockets for uids{10351}` |
| 20:59:02 | wake test: `cmd notification post bigk-wake-probe …` → kolun's listener received it (20:59:32) → **no thaw** |
| 21:10 | still frozen — **0 unfreeze lines in 29 min** (control: WhatsApp froze every 5 s throughout) |

**Verdict — notification-listener path DEAD, no build:**

- **Bet 1 (system bind prevents freeze): FAILED.** Exactly BigK's scenario
  (grant listener while foreground → background → freeze at +5 s): a
  system-held, FGS-flagged, `BFGS`-state listener connection did not stop
  `Usf_Hiber`. XOS ignores self-declared FGS (round 21) *and* system-held
  BFGS (now).
- **Bet 2 (notification thaws): FAILED.** The oneway
  `INotificationListener` dispatch from system_server did not thaw a frozen
  arbitrary uid. `asyncBinderWhiteList` is selective (WhatsApp/Cloudflare
  class), not "any system→app oneway binder".

Remaining options for the Infinix, in the order they should be tried:

1. **Does an incoming Nearby connection wake the frozen callee?** (round-22
   experiment, no build — protocol in the round-21 log section above.) GMS
   kept our discovery client registered through the freeze, and
   GMS-originated async binder transactions are **the only wake class with
   direct positive evidence on this device** (WhatsApp thawed 16× via
   `reason:asyncBinderWhiteList`, Cloudflare 3×). The Nov-6 probes killed
   the notification-listener wake, so round 22 now gates *the entire
   wake-side strategy*: every freeze test so far had nobody calling.
2. **XOS one-time setup pass — ALREADY APPLIED before round 21 →
   provisionally NEGATIVE.** All four toggles (Battery → Unrestricted,
   Auto-start management, Phone Master → Protected apps, Recents lock) were
   in place and the freeze still fired at Home +5 s. Caveat: the reinstall
   changed uid (10393) and XOS lists sometimes reset on reinstall — verify
   BigK is still listed in all four; if anything dropped, re-add it for one
   clean measurement. Manual and conflicting with the no-precondition rule
   either way — never the shipped answer.
3. **Traffic keep-alive — v1 FAILED (round 20 log), v2 FAILED (round 21
   log).** v2 moved the metric (`speed :8`, 17.5 KB/s TX / 2.8 KB/s RX,
   `err=0`) and the freeze happened anyway at Home +5 s. Demoted to
   observability + stock-Android niceness; not the Infinix fix. The counter
   line (`KeepAlive: n= … txB= …`) stays as the instrument.
4. **VPN own-tunnel build — BUILT AND PASSING (Nov 6, round 23).** See the
   round-23 section below. The strongest *prevention* evidence on the device
   (the `importantScene: VPN` finding above) held up: with our own `VpnService`
   tunnel up, the engine logs `importantScene: VPN: packageName=com.anonymous.<app>`
   every 30 s and `fastState: uid=10397 is pending`, with zero
   freezes across screen-on, screen-off and the lock screen. One-time consent
   dialog, status-bar key icon, defers to any other active VPN, and (round 24)
   a real local call relay on `10.111.222.0/24` instead of a dummy route; Play
   VPN disclosure.
5. **Overlay / chat-head bubble — BUILT, screen-on only (Nov 6, round 23).**
   Prevention via a *visible window* works while the screen is on and unlocked
   (`importantScene: float_window`), verified for 3+ minutes; the keyguard and
   screen-off hide the window, so the engine's next 30 s cycle freezes. Kept in
   the build as the screen-on layer and as the visible window that unblocks
   background activity starts. Costs the "display over other apps" consent;
   could ship as a genuine PTT incoming-call chat-head, so it doubles as a
   feature.
6. **CDM presence observation** — the only path where the *system* wakes us
   when the friend's phone appears, surviving a frozen or even dead process.
   Unproven against `Usf_Hiber` (which proxies `p_service`), API 31+ only
   (Infinix ✅, Samsung ✗ but doesn't freeze anyway), costs one consent dialog
   during QR pairing. Wake-side reserve — the alternative to prevention
   (4/5) if round 22 is negative.
7. ~~**Notification listener (both bets)**~~ — **DEAD, tested Nov 6:** see
   the controlled experiment above. Prevention and notification-wake both
   failed on a clean third-party subject; no build.

### Round 23 builds (Nov 6) — 1x1 window + keeper VPN: the blocker is FIXED

Two small builds tested the last two prevention ideas the census pointed at.
Both mechanisms are in the tree (`KeeperOverlay.kt` and the separate
`KeeperVpnService`); the gate stayed green for each (9 suites + `tsc` +
`assembleRelease`). BigK uid is **10397** in this round.

**Build A — 1x1 overlay window (`KeeperOverlay`).** A 1x1, transparent,
non-focusable, non-touchable `TYPE_APPLICATION_OVERLAY` window, added by the
watchdog whenever the app is backgrounded (importance worse than `FOREGROUND`)
and removed the moment the UI is back. It needs the "display over other apps"
grant; note a reinstall resets that op to `default` (`cmd appops get …` showed
`rejectTime` right after install, and the first attempt died with
`BadTokenException: permission denied for window type 2038`), so
`appops set … SYSTEM_ALERT_WINDOW allow` was applied for the test.

- **Screen on, at Home: no freeze for 3+ minutes** (previous death: Home
  +4–5 s). Watchdog/P2P lines kept ticking every 5 s and the engine logged
  `importantScene: float_window: packageName=com.anonymous.<app>`
  every 30 s.
- **Screen off / locked: still freezes.** With `KEYCODE_SLEEP` the window's
  surface hides (`isVisible=false`), the scene disappears, and the engine's
  next 30 s cycle froze the uid. Waking to the keyguard did not restore it
  (`isKeyguardShowing=true`, window still `isVisible=false`). So the overlay
  buys screen-on/unlocked time only — not the always-on case.
- Bonus finding: a SAW grant alone does **not** permit a background activity
  start on this build —
  `Background activity launch blocked! … callingUidProcState: FOREGROUND_SERVICE;
  callingUidHasNonAppVisibleWindow: false … BAL_BLOCK` (result code 102).
  The overlay window is what satisfies `callingUidHasNonAppVisibleWindow`, so
  it is the prerequisite for the 1x1-*activity* variant if that is ever
  revisited. `KeeperActivity` (a translucent 1x1 activity) was kept in the
  tree for that experiment but was never started; it and the other dead probes
  were removed in round 24.

**Build B — keeper VPN (`KeeperVpnService`).** A separate service owns a dummy
tunnel: `tun0`, `192.0.2.1/32`, route `192.0.2.0/24`, no DNS, no default route,
so no real app traffic is captured. (Round 24 replaced the dummy route with a
real call relay.) The tunnel comes up with availability; the watchdog retries
`establish()` every 5 s until the system consent dialog has been accepted.
Consent was already prepared on this install, so no prompt appeared.

Measured on the same install (logcat cleared at start, screen states in
sequence):

| Phase | Duration | Result |
|---|---|---|
| Home, screen on | 65 s | no freeze; `importantScene: float_window` + `VPN` |
| screen off (`KEYCODE_SLEEP`) | 150 s | **no freeze**; `VPN: packageName=com.anonymous.<app>` every 30 s |
| wake to keyguard | 60 s | **no freeze** |

Evidence excerpts:

```
22:08:34.558 W Usf_Hiber/fastState: uid=10397 is pending
22:09:47.394 I Usf_Hiber/importantScene: isTrafficActive uid:10397 speed :2
22:09:47.395 I Usf_Hiber/importantScene: uid:10397 speed :2
22:09:47.395 I Usf_Hiber/importantScene: VPN: packageName=com.anonymous.<app>
```

192 log lines from the app pid in the same window (`P2PProbe` every 5 s,
`KeepAlive` every 10 s) and **zero `freeze uid: 10397`** events. The engine
logs `is pending` instead of freezing; the earlier `stateManager: freeze uid`
path never fires. System confirmation of the tunnel:

```
NetworkAgentInfo{network{570} … ni{VPN CONNECTED extra: VPN:com.anonymous.<app>}
  … InterfaceName: tun0 … OwnerUid: 10397 … sessionId=BigK background receive}
Usf_Hiber/networkDetectorService: changedNetwork: netType=17, net=VPN
```

**Verdict.** The blocker is fixed on the Infinix: background receive now
survives screen-on, screen-off and the lock screen. Both mechanisms stay
(overlay = screen-on defence and BAL enabler, VPN = the exemption that survives
sleep); either alone has a gap. Side effects to own: the VPN key icon, the
"display over other apps" grant, a one-time consent dialog on a fresh install,
and the usual always-on battery cost. A 15+ minute soak is running as the
long-form confirmation; its result is appended below when it lands.

### Round 24 build (Nov 8) — the relay is real, dead probes removed

Build `2BE2FB30E1955D516A051FE1A8DEEB90934AD4EBE3C44620DB241EC0BF2B1678`
(package `1.1.3-control-recovery`; BigK uid **10399** on the Infinix). Gate
green: 9 Node suites + `npx tsc --noEmit` + `assembleRelease`.

**Dead probes deleted.** `KeeperActivity`, `KeeperAccessibilityService`,
`KeeperDeviceAdminReceiver`, their manifest entries, `res/xml` configs and the
unused string are gone. `aapt2` confirms none of them are in the APK; the
keeper is now only the overlay (screen-on) and the VPN (screen-off).

**The VPN carries the call control channel.** The dummy `192.0.2.0/24` route is
replaced by a real local relay:

| | |
|---|---|
| tun addresses | `10.111.222.1/32` (app source) and `10.111.222.2/32` (virtual peer) |
| route | `10.111.222.0/24` only; no DNS, no default route |
| allowed apps | this package only (`addAllowedApplication`) |
| app port | `9876` inside the virtual subnet |
| real port | `9875` on the P2P link, unchanged |

- **Caller**: the app connects from `10.111.222.1` to `10.111.222.2:9876`;
  `KeeperVpnService` accepts and dials the group owner at `<owner>:9875` with a
  `protect()`ed socket.
- **Callee**: the app listens on `10.111.222.2:9876`; the service listens on
  its real P2P address `:9875`, accepts the peer, and bridges to the app.
- **Mixed mode works**: the real link always stays on `9875`, so one phone
  with the VPN and one without still connect (the relayed side bridges to the
  other phone's ordinary listener).
- `onDirectReady` still reports the **real P2P address**, not the virtual one,
  because `DirectCallAudio` filters WebRTC host candidates against it; media
  therefore stays peer-to-peer on the P2P interface and is not tunnelled.
- The relay is a per-call job: it starts after the group forms, replaces any
  previous job, logs `relay carried <n> bytes` every 5 s while bytes move, and
  stops accepting on teardown (the bridge drains the hangup bytes, then force
  closes after 3 s). If the keeper tunnel is not ours (WARP owns the slot,
  consent pending), `configureRelay` returns false and the call uses the real
  P2P addresses unchanged.

**Soak result (Nov 8).** 15 minutes with `mWakefulness=Dozing`, captured from
`-b main,system` (120,115 lines, 00:48–01:06): **zero `freeze uid: 10399`**
(the only textual matches were adbd echoes of the grep command itself),
**36 `importantScene: VPN: packageName=com.anonymous.<app>`** lines (one
per 30 s engine cycle), and `P2PProbe` ticks through 01:06:45. Representative
cycle:

```
01:05:48.437  3409  3537 I Usf_Hiber/importantScene: isTrafficActive uid:10399 speed :4
01:05:48.438  3409  3537 I Usf_Hiber/importantScene: uid:10399 speed :4
01:05:48.438  3409  3537 I Usf_Hiber/importantScene: VPN: packageName=com.anonymous.<app>
01:06:45.806  1719  1719 I P2PProbe: [watchdog] peers=0
```

The app was never frozen and the tunnel stayed up for the whole soak; this is
the round-23 exemption re-confirmed with the real relay configuration in place.
The relay itself only starts when a call forms, so its end-to-end proof is the
two-phone call test (grep `KeeperVpn: relay bridged` and `relay carried <n>
bytes`).

**Limit to own.** The relay transports signalling/control; audio is the
WebRTC media path and remains direct. The VPN is still single-slot: it defers
to WARP, and in that state the relay is unavailable (the call falls back to
the direct path, but the freezer exemption is WARP's, not ours).

### Round 25 build (Nov 8) - VPN protection toggle + no permanent wakelock

**What shipped.**

- **Wakelock removed.** `AvailabilityService` no longer holds `PARTIAL_WAKE_LOCK`;
  the VPN exemption is the freeze fix and the CPU is allowed to sleep between
  packets. The old tag `<app>:availability` should no longer appear in
  `dumpsys power`. `TrafficKeepAlive` still feeds `isTrafficActive` while the
  CPU is awake.
- **VPN protection toggle.** A user-facing switch (Settings row `VPN protection`
  plus a `Turn off VPN` / `Turn on VPN` action on the availability
  notification) releases *only* the VPN slot. Call availability, the overlay and
  the foreground service keep running. Use it before opening a banking app or
  another VPN (e.g. Cloudflare WARP). When off, the freezer exemption is gone
  and the app may freeze in the background - that is the accepted trade-off.
- **Persistence.** The choice lives in `keeper` prefs (`vpn_enabled`, default
  true). `KeeperVpnService.sync()` and `onStartCommand` honor it, so a toggle
  off survives the 5 s watchdog and process restarts. `MainActivity` no longer
  requests VPN consent while it is off.
- **Teardown.** `stop()` now closes the tunnel fd directly via `closeTunnel()`
  before `stopSelf()`; `stopService()` alone did not release the interface on
  this hardware.
- **JS state.** `useAvailability` carries `vpnEnabled`/`vpnActive`/`otherVpn`;
  `availabilityStatus` and a new `setVpnEnabled` native method feed them, and
  the 60 s health check refreshes them so a notification-action toggle shows up
  when the app returns to the foreground.
- **Build gate.** `scripts/build-offline-call.ps1` no longer treats native
  stderr as a terminating error (every command is already guarded by
  `$LASTEXITCODE`); the gate now runs to completion. Green: 9 Node suites +
  `tsc` + `assembleRelease`, APK SHA-256
  `B559A47ED3DF41C9D8A925FA6603A5FAF8333BEA9D5093E9F9644BE8BB606B8D`.

**On-device results (Nov 8).**

- **No-wakelock soak.** 16.5 min screen-off (`mWakefulness=Dozing`), `main,system`
  buffer, 40,407 lines (01:48-02:04): **0 real `freeze uid: 10399`**,
  **72 `importantScene: VPN: packageName=com.anonymous.<app>`** lines, and
  `P2PProbe` ticks through 02:04:40. `dumpsys power` shows no new
  `<app>:availability` ACQ line (last one is 00:48, from the old build).
  The VPN exemption alone keeps the app alive with the CPU allowed to sleep.
- **VPN toggle.** Off: `tun0` gone within ~1 s, `VPN protection disabled by
  user`, service destroyed. On: `VPN protection enabled by user`, tunnel
  re-established. The choice persisted across the APK reinstall.
- **WARP coexistence.** WARP connected: BigK logged `Tunnel revoked by the
  system or another VPN` then `Another VPN owns the tunnel; keeper idle (will
  not override)`; `tun0` stayed WARP's (172.16.0.2); BigK never stole the slot.
  WARP disconnected (`Until I turn it back on`): BigK logged `No other VPN
  active; keeper tunnel may start` and re-established within ~30 s.

**Log vocabulary (round 25).**

```
KeeperVpn:  VPN protection enabled/disabled by user
KeeperVpn:  VPN protection is off; not establishing
Availability: VPN toggle requested: on|off
```

### Deferred / not built

- ~~**P0 owner-address guard / accept-gate logging**~~ — **both built in
  round 20 (Nov 5).** See the round-20 section above: placeholder owner
  addresses now pass with a warning, and every accept-gate rejection logs
  its reason.
- **Per-attempt connection deadline (15 s × 2 attempts)** — user: "will answer
  later". Still open.
- **`autoAccept` per-friend flag is dead code** — present in `store/appStore.ts`
  (`addedDate; lastSeen?; autoAccept?`) and settable, but `hooks/useNearbyCall.ts`
  never reads it; an older backup did (`setTimeout(() => acceptCall(), 500)`).
  The callee only shows the incoming-call UI. Worth deciding whether auto-answer
  is wanted, since "the user only presses call" arguably implies the callee
  should not need to tap either.
- **Client-side `removeGroup`** — should only run when `group.isGroupOwner`;
  today the client calls it and gets `reason=0` (round 11, 4×).

### Next after the freeze fix

1. Re-run the walk-away test with a phone that survives backgrounding.
2. Build the MAC-keyed call path (record P2P MAC at QR pairing; Nearby demoted
   to presence + stale-MAC fallback), informed by that range number.
3. Then P2 security → P4 cleanup → Route 2.

---

## Retest checklist (background survival)

1. Install on both phones. First launch shows the **"Keep calls coming in"**
   dialog — tap **Allow**, then **Allow** again on Android's own prompt. (Tap
   `Not now` and the ask is remembered; re-enable via Settings → Battery
   optimization settings.) Then Android shows the **VPN consent** dialog
   ("Connection request … BigK") — tap **OK**. That one-time grant is the
   fix that survives screen-off: it makes XOS's freezer see the app as an
   active VPN (`importantScene: VPN`). Declining costs background survival
   only; calls still work while the app is open. Then confirm availability is
   on, open each phone **once**, press **Home** — not swipe-away, not
   force-stop. Screen may go off.
   *Optional extra:* allow **Display over other apps** for the screen-on
   `float_window` layer. If it is not granted the log shows
   `Keeper: overlay attach failed … permission denied for window type 2038`
   and nothing else changes; the VPN carries the fix.
2. On the Infinix, confirm the log keeps printing
   `P2PProbe: [watchdog] …` **at 5-second intervals for at least 2 minutes
   after Home** — now including with the screen off and on the lock screen.
   Grep `Availability: VPN keeper tunnel established` once at startup,
   `importantScene: VPN: packageName=com.anonymous.<app>` every 30 s,
   and `fastState: uid=<ours> is pending`. The pass condition is **no**
   `stateManager: freeze uid: <ours>` line at all.
   Also grep `[BatteryExemption]` for `after prompt: unrestricted=true` and
   `KeepAlive:` counters every 10 s (if they stop, the ticker died; if they
   never appear, the keep-alive never started).
3. If probes stop, grep for the new stop lines first —
   `Availability: Stopping:` / `Service destroyed; watchdog cancelled` — and
   then for the OEM freezer:
   `Usf_Hiber.*<our-uid>` / `proxyWakeLock.*<app>`. If the VPN is the
   suspect, check `dumpsys connectivity | grep 'VPN CONNECTED'` and
   `Availability: VPN keeper (tunnel established|revoked|waiting for user
   consent)`.
   A freeze with **no** stop line is the round-18 bug reproducing.
   **Round-22 = the background call wake experiment** (XOS toggles were
   already applied before round 21 — provisionally negative; full protocol
   in the round-21 log section): callee Infinix frozen ≥60 s on USB, caller
   Samsung presses Call, capture with `logcat -d` afterwards. Greps:
   `unfreeze uid: <our-uid>` (any reason), `asyncBinderWhiteList`,
   `onEndpointFound|onIncoming|onConnectionResult`, `KeepAlive:`,
   `NearbyProbe:`, `enter FrozenState`.
   - Unfreeze + ring → background receive works → **walk-away range test**
     (callee auto-answer build next so it can pick up unattended).
   - Silence while GMS saw the caller → GMS delivery doesn't wake us →
     prevention build next (VPN own-tunnel, evidence-first; overlay bubble
     as the feature-shaped alternative), CDM presence observation as the
     wake-side reserve. The notification-listener path is dead (Nov-6
     experiment above).
   - GMS never saw the caller → advertising/discovery died with the freeze —
     fix that first.
4. Only once (2) passes is the walk-away test worth running: no calls during
   the walk, don't open either app, walk 30 s past the point you are sure both
   are dead, capture **both** logs, and note your paces (≈0.7 m each).

### Log tags added in this stretch

```
DirectWifi:   teardown begin|cancel|group|removeGroup|group gone|exit session=… reason=… elapsedMs=…
DirectWifi:   peer read start|resolved|exhausted
NearbyProbe:  [watchdog] advertising=… discovering=… discovered=… connected=… pending=…
P2PProbe:     [watchdog] staFreq=… band=… / peers=…
P2PProbe:     [call-start role=…] …
MacMap:       contact=… device=… mac=… by=name|single-available
Availability: Holding partial wakelock; screen stays off
Availability: Debounced idle advertising refresh (last …ms ago, min 30000ms)
Availability: Watchdog: cycling idle advertisement
Availability: Stopping: PAUSE action requested | availability is paused
Availability: Service destroyed; watchdog cancelled (paused=… wasRunning=…)
BatteryExemption: [BatteryExemption] already unrestricted | system dialog requested | after prompt: unrestricted=…
KeepAlive:      starting; 1 Hz keep-alive over Wi-Fi only | sending to <ip> over Wi-Fi | stopped
KeepAlive:      n=<ticks> sent=<n> err=<n> rxPkt=<n> tlsOk=<n> tlsFail=<n> txB=<bytes> rxB=<bytes> phase=burst|sustain wifi=true|false   (every 10 s)
DirectWifi:     owner address <mac> is a placeholder; authenticating on the session token only
NearbyModule:   accept gate rejected endpoint=… peer=… directSession=… paused=… unsavedContact=… otherEndpointBusy=…
Keeper:         overlay attached (1x1, invisible, non-touchable) | overlay removed | overlay attach failed | show requested | activity created; keep-alive surface attached
KeeperVpn:      Keeper relay tunnel established (10.111.222.1/10.111.222.2, route 10.111.222.0/24, app=…) | relay ready: app 10.111.222.1 -> 10.111.222.2:9876 => peer <ip>:9875 | relay ready: peer <ip>:9875 => app 10.111.222.2:9876 | relay bridged (caller=… peer=…) | relay carried <n> bytes | relay bind/accept/bridge failed: …
Availability:   VPN keeper waiting for user consent (one-time dialog) | VPN keeper revoked by user/system | other VPN active; keeper idle
```

### Known noise to ignore when grepping

```
[OutgoingCall] Could not connect
Peer did not connect within 15 seconds
[Error: 13: ERROR]
8011: STATUS_ENDPOINT_UNKNOWN
Hermes bundler "variable was not declared" spam during gradle
```

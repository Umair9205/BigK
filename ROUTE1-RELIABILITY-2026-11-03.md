# Route 1 reliability: teardown, background survival, and range

**Covers round 11 through round 18 (Oct 29 – Nov 3, 2026).**
Rounds 1–10 live in `P2P-NEGOTIATE-CONNECT-2026-10-09.md`.

Goal for this whole stretch: **the caller presses Call and nothing else happens.**
No Wi-Fi toggling, no manual preconditions, no error string that tells the user
to go fix something. Background receive behaves like WhatsApp. Setup latency
stays comfortable.

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
          proxyWakeLock: add … 'kelakonnect:availability LONG
          proxyManager: p_service / p_alarm / p_sensor / p_job
22:59:00  proxyWakeLock: drop … 'kelakonnect:availability
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
`Usf_Hiber/config: pkgName: com.anonymous.kelakonnect add to third app list` —
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
| 00:19:09 | Home pressed (`APP_SWITCH … prevPkgName:com.anonymous.kelakonnect`) |
| 00:19:14.08 | `PowerManagerService: Going to sleep` (screen off) |
| 00:19:14.49 | **`Usf_Hiber/appStateMachine: uid:10391 enter FrozenState`** — frozen 13 s after the grant |
| 00:19:14.49 | `proxyWakeLock: add/drop … 'kelakonnect:availability'`; `p_service`, `p_alarm`, `p_sensor`, `p_job` all proxied |
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
   Clients … com.kelakonnect.nearby.control.v2` kept printing every ~8 s from
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
| 02:12:37.097 | `kelakonnect:availability` wakelock force-released; `p_service/p_alarm/p_sensor/p_job` proxied |
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
| 21:46:49.252 | `kelakonnect:availability` wakelock force-released; `p_service/p_alarm/p_sensor/p_job` proxied |
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

Also in this capture: uid 10302 was bump-frozen 14× in two minutes (each at
`speed :0`, ~10 s apart) — XOS push-bump churn: GCM bumps an app, it
handles, it is re-frozen. We have no push channel (and no server to originate
one), so that cycle is not available to us.

### Round 22 = the XOS settings pass (free, same APK)

If XOS's own toggles stop the freeze, the walk-away range test unblocks
immediately. The shipped answer still cannot be the toggles (no-precondition
rule) — that remains CDM presence observation — but both the range number and
the whitelist-model confirmation are worth a 5-minute measurement.

Toggles (XOS names drift between versions; note anything missing):

1. Settings → App management → BigK → Battery → **Unrestricted**.
2. Settings → App management → **Auto-start management** → allow BigK.
3. Phone Master → **Protected apps** (or Auto-start) → enable BigK.
4. Recents → lock BigK's card (XOS lock — swipe-*down* on the card; never
   swipe-up, that is a real kill).

Then repeat the background-survival checklist on this same APK: open once →
Home → 2 min → capture → same greps.

- **No `enter FrozenState` for our uid, probes to the end** → whitelist
  model confirmed → walk-away range test immediately.
- **Freeze persists despite the toggles** → XOS ignores its own whitelist
  for us → CDM presence observation next (build).

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
all). Remaining candidates: the XOS settings pass (round 22, free,
measurement) and CDM presence observation (structural, shipped path).

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

Remaining options for the Infinix, in the order they should be tried:

1. **XOS one-time setup pass** (user-side, free, do first as a *measurement*):
   manual, conflicts with the no-precondition rule, and XOS 15.1.2 owners
   report the toggles get renamed/removed by updates: Settings → App
   management → BigK → Battery → Unrestricted; enable in Auto-start
   management; Phone Master → Protected apps; lock the card in Recents. Worth
   knowing whether it stops the freeze at all, even if it can never be the
   shipped answer.
2. **Traffic keep-alive — v1 FAILED (round 20 log), v2 FAILED (round 21
   log).** v2 moved the metric (`speed :8`, 17.5 KB/s TX / 2.8 KB/s RX,
   `err=0`) and the freeze happened anyway at Home +5 s. Demoted to
   observability + stock-Android niceness; not the Infinix fix. The counter
   line (`KeepAlive: n= … txB= …`) stays as the instrument.
3. **CDM presence observation** — the only path where the *system* wakes us
   when the friend's phone appears, surviving a frozen or even dead process.
   Unproven against `Usf_Hiber` (which proxies `p_service`), API 31+ only
   (Infinix ✅, Samsung ✗ but doesn't freeze anyway), costs one consent dialog
   during QR pairing. Reserve decision already on file; next if 1 and 2 fail.

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
   optimization settings.) Then confirm availability is on, open each phone
   **once**, press **Home** — not swipe-away, not force-stop. Screen may go off.
2. On the Infinix, confirm the log keeps printing
   `P2PProbe: [watchdog] …` **at 5-second intervals for at least 2 minutes
   after Home.** This is the whole test. Grep `[BatteryExemption]` for
   `after prompt: unrestricted=true` to confirm the grant landed, and grep
   `KeepAlive:` for `starting; 1 Hz keep-alive` + `sending to <ip> over
   Wi-Fi` (before Home) **and `KeepAlive: n= …` counter lines every 10 s
   after it** — if the counters stop, the ticker died; if they never appear,
   the keep-alive never started.
3. If probes stop, grep for the new stop lines first —
   `Availability: Stopping:` / `Service destroyed; watchdog cancelled` — and
   then for the OEM freezer:
   `Usf_Hiber.*<our-uid>` / `proxyWakeLock.*kelakonnect`.
   A freeze with **no** stop line is the round-18 bug reproducing.
   **Round-22 = the XOS settings pass** (round-21 log settled the traffic
   question: `speed :8` and a freeze anyway). Apply the four toggles from
   the round-21 log section — Battery → Unrestricted, Auto-start management,
   Phone Master → Protected apps, Recents lock — then repeat this checklist
   on the same APK:
   - No `enter FrozenState` for our uid and probes to the end → whitelist
     model confirmed → **walk-away range test immediately** on this APK.
   - Freeze persists despite the toggles → XOS ignores its own whitelist
     for us → CDM presence observation is next (build).
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
```

### Known noise to ignore when grepping

```
[OutgoingCall] Could not connect
Peer did not connect within 15 seconds
[Error: 13: ERROR]
8011: STATUS_ENDPOINT_UNKNOWN
Hermes bundler "variable was not declared" spam during gradle
```

# Route 1 v2: two-sided Wi-Fi Direct negotiate-connect

Date: 9 October 2026. Replaces the SSID/passphrase group handoff with the
framework-negotiated connect chain (the model Viddy Talkie proved works on the
exact Infinix HOT 60 Pro + Samsung pair).

## Why (root cause, from `log_bigk_SM_5.log` / `log_bigk_infinix_5.log`)

Score on the previous APK: 3 calls connected, 4 failed — **all 4 failures were
the Infinix as joiner** (0/4), all Samsung joins succeeded (3/3).

1. The protocol had the caller issue `WifiP2pManager.connect()` with a
   pre-shared SSID/passphrase **2–5 s before the callee's group existed on
   air** (the callee must release Nearby first, observed 3.3 s).
2. Samsung's framework patiently searches for the not-yet-existing SSID
   (~9 s) and joins. **XOS accepts the request and never re-drives its own
   find** — zero `wpa_supplicant` P2P activity after the request in logcat,
   `groupFormed` never becomes true, our 30 s watchdog kills the call.
3. The old retry only matched `BUSY(1)`; the observed `create group (2)`
   failure was `ERROR(2)` — never retried.

Two-sided negotiate-connect removes the failure entirely: both phones call
`connect()` with each other's **P2P device address** and complementary GO
intents; the framework runs find → GO negotiation → credentials as one
internal handshake. There is no pre-existing SSID to miss.

## What changed

### Native — `DirectWifiModule.kt`
- `createCallGroup`/`joinCallGroup` collapsed into
  **`connectCallPeer(id, peerAddress, isCaller, token)`**:
  `WifiP2pConfig.Builder().setDeviceAddress(mac).setGroupOperatingBand(GROUP_OWNER_BAND_2GHZ).build()`,
  then the built config's **public `groupOwnerIntent` field** is set
  (caller=0 / callee=15 — the Builder has no intent setter, and there is no
  public band field, hence the split). Callee hosts the group
  deterministically.
- New **`getP2pAddress()`** exposes `requestDeviceInfo().deviceAddress`.
- **Role from readback**: `r.owner = info.isGroupOwner` (no assumed role, no
  "Unexpected Wi-Fi Direct group role" failure). The client verifies
  `group.owner.deviceAddress == peerAddress`; the host is protected by the
  control-socket token auth.
- **Connect refresh loop**: while the group is unformed and no framework
  operation is pending, re-issue `connect()` every 3 s
  (`CONNECT_REFRESH_MS`, capped at `MAX_CONNECT_REFRESHES = 8`). A stack
  mid-formation answers BUSY (absorbed by retryBusy); a stalled stack gets a
  fresh search. The 30 s watchdog remains the outer bound.
- **Retry policy**: `BUSY(1)` *and* `ERROR(2)` retried (up to 8 attempts,
  backoff `min(250·n, 1500) ms`); `P2P_UNSUPPORTED` stays fatal.
- **Deadlines**: control listener accept 20 s → **25 s**; client connect
  15 s → **20 s** (slow-joiner margin inside the 30 s watchdog). The host now
  settles its promise only at control-ready, like the client.
- **Teardown ordering**: `stop()` closes sockets, then waits **400 ms** before
  `cancelConnect`/`removeGroup` so in-flight hangup/EOF bytes reach the peer —
  normal hangups read "Peer ended the call" instead of mid-call
  `SocketException`.
- **Group ownership**: the planned `expectedSsid` is replaced by the
  *observed* `r.networkName`; teardown removes only this run's group. A
  differently named group is foreign and survives (the begin() null-gate
  proves any unobserved group at teardown is this run's late formation).

### Signaling — `CallSignaling.ts`
- `direct-config` (v2): `{ direct: { peerP2pAddress, token } }` — the
  **callee's own** P2P address + control token. No SSID/passphrase anywhere.
- `direct-ready` (v2): `{ peerP2pAddress }` — the **caller's own** address.
- `Signal.data.group` removed; `direct`/`peerP2pAddress` added.

### Call flow — `modules/DirectWifi.ts`, `services/DirectCallAudio.ts`, `hooks/useNearbyCall.ts`
- `GroupCredentials {ssid,passphrase,token}` → `DirectCredentials
  {token, peerP2pAddress}`; wrapper exposes `getP2pAddress()`/`connectPeer()`.
- `DirectCallAudio.handoff()`: each side reads its own address
  (`getP2pAddress`) → callee sends it in `direct-config`, caller in
  `direct-ready` → `Nearby.releaseForDirectCall` (unchanged) → **both sides**
  `wifi.connectPeer(sessionId, peerAddress, isCaller, token)`.
- `useNearbyCall` direct-config listener validates `direct.peerP2pAddress` +
  `direct.token` (mismatch → "Install the same new APK on both phones").

### Zero-interaction automation (round 2b — the user only presses Call)

- **`ensureWifi`** (run by `getP2pAddress` at first Wi-Fi touch, and again by
  `begin`): try the silent `setWifiEnabled(true)` first (works below Android 10);
  when the OS refuses — targetSdk ≥ 29 on Android 10+ is a hard platform block —
  open the sanctioned **`Settings.Panel.ACTION_WIFI`** and resume every queued
  continuation from the `WIFI_STATE_CHANGED` broadcast. With Wi-Fi already on
  this is a no-op (zero interaction); with Wi-Fi off it costs **one OS toggle**
  and the call continues by itself. Wait: `WIFI_ENABLE_WAIT_MS = 12 s`; if Wi-Fi
  is still off the call fails with the factual "Wi-Fi is off", never an
  instruction. A stack already `ENABLING` just waits for its broadcast.
- **Channel auto-reinit (`ensureChannel`)**: a channel dropped by the service
  (our own Wi-Fi cycle included) is reopened on the spot — "Reopen the app" is
  gone. A late disconnect callback from an old channel never nulls a newer one.
- **Closing-link auto-wait**: `begin` waits out `stopping`/a live run for up to
  15 s (`BUSY_WAIT_ATTEMPTS = 300 × 50 ms`, covering the ~12 s worst-case group
  release) instead of failing with "Try again shortly."
- **`requestP2pState` kick** (API 30+; older stacks fall through) before the
  address poll, so a stack that has just come up initializes before the first
  `requestDeviceInfo`; poll widened to 20 × 300 ms under an 8 s deadline.
- **Peer-confirm window 8 s → 25 s** in `DirectCallAudio.waitForPeerRelease`:
  the peer may be spending its own panel wait + address read before it acks.
- **No instruction-style errors remain** in `DirectWifiModule.kt` ("Turn Wi-Fi
  on", "Try again shortly", "Reopen the app", "toggle Wi-Fi off and on", "End
  any other Wi-Fi Direct session and retry", "…retry the call") — locked by a
  suite assertion that scans the whole module.
- **Direct-setup JS backstops 45 s → 60 s** (`DirectCallAudio.start` and both
  `'Direct call setup timed out'` sites in `useNearbyCall`). The old 45 s
  spanned a chain that is sequential when Wi-Fi starts off: panel wait 12 s +
  address poll 8 s + native `begin` watchdog 30 s = **50 s before media even
  starts**, so the outer timer could fire first with a generic message while
  native was still working. 60 s covers the stack with margin; every phase that
  can fail still has its own earlier, specific deadline, so this only changes
  when a genuinely wedged run is reported. The pre-accept ring timeout
  (`'Call setup timed out'`, `useNearbyCall`) stays **45 s** — it bounds a human
  answering, not the Wi-Fi stack.

Unchanged: Nearby BLE discovery + always-on receive, presence grace,
dual watchdogs, release-before-P2P sequencing, control socket + token auth,
WebRTC audio (AEC), 45 s presence grace, the 45 s pre-accept ring timeout.

## Retest round 1 (18:20–18:22, v2 APK): 0/8 — native receive-gate bug

Every fresh-round session failed the same way: the callee sent `direct-config`
and the caller never logged its receipt; 8.0 s later the callee died with
"The other phone did not confirm direct setup". Transport proved innocent —
GMS logged `onPayloadReceived … DETAIL_SUCCESS` for the payload, but no JS line
ever appeared (no parse error either).

**Root cause (my v2 regression):** `NearbyTransport.observeSignal` gates every
*received* signal with `signal.optInt("version") != 1 → drop`. The v2 change
bumped `direct-config`/`direct-ready` to `version: 2`, so both were silently
swallowed in Kotlin before the JS emit — on both phones, both roles. The send
path (`received=false`) skips the gate, which is why "Signal sent: direct-config"
still logged. Blocking `direct-ready` also left `handoffReadySession` unset, so
even a forced release would have rejected at `releaseForDirectCall`.

**Fix:** the gate now admits version 2 **only** for `direct-config` and
`direct-ready` (everything else must stay v1) and logs every drop
(`dropped signal type=… version=… by receive gate`). Cross-version behavior:
old phone → new phone hits the JS "Install the same new APK on both phones"
hint; new → old is dropped cleanly by the old gate. Locked by the
"native receive gate" test in `test-background-availability.cjs`.

Secondary noise in round 1 (watch on retest): three `[OutgoingCall] Could not
connect` / `Peer did not connect within 15 seconds` failures *between* sessions
— likely teardown churn while the previous session was unwinding; the v2
`connectCallPeer` native path (`phase=connecting-peer`) never once executed, so
it remains unverified on-device.

Also noted: the Infinix ran in airplane mode during round 1; the user confirmed
identical results with airplane mode off — ruled out as a variable.

## Retest round 2 (18:50–18:52, gate fix): signaling ✓, 0/8 — config-build on two framework generations

The receive-gate fix is **verified**: `direct-config`/`direct-ready` now reach JS on
both phones, `NearbyHandoff bootstrap released` → `P2P released` fires — but no
session logged `phase=connecting-peer`: every attempt died inside
`connectCallPeer`'s config construction, with **two different framework
rejections**:

- **Infinix (modern framework)** — `peer address must be set if network name and
  passphrase are not set.` = `build()` rejecting `deviceAddress == MAC_ANY`.
  The address it received over signaling was `02:00:00:00:00:00` ⇒ **Samsung's
  `requestDeviceInfo` returned the placeholder** and it was shipped as-is.
- **Samsung (Android 11/12-era framework)** — `network name must be non-empty.`:
  android-30's `build()` *requires* a non-empty network name (verified against
  AOSP `prebuilts/fullsdk/sources/android-30`), so an address-only Builder config
  can **never** build there. It threw before `stage()`, which is why round 2 has
  zero `phase=` lines. (The same phone happily ran v1's legacy
  `WifiP2pConfig().apply { … }` connect at 14:59.)
- One attempt also hit `Turn Wi-Fi on (no router or internet needed)` — Wi-Fi was
  off on the Samsung at 18:50:32. Superseded by round 2b below: the app now
  brings Wi-Fi up itself; airplane mode stays ruled out.

**Fixes (round 2a):**

1. `getP2pAddress` **polls** `requestDeviceInfo` until it yields a usable address
   (rejects the placeholder; 10 × 300 ms + 5 s deadline) and fails with an
   actionable message instead of shipping `02:00:00:00:00:00`.
2. `connectCallPeer` **guards `MacAddress.NONE`** with a clear error, then builds
   **Builder-first with a legacy fallback**: if `build()` throws
   `IllegalStateException` (old stacks' network-name validation), it uses the
   legacy `WifiP2pConfig().apply { deviceAddress; groupOwnerIntent; wps }` form
   every framework accepts — same GO-intent split, band AUTO on that path.
3. `DirectCallAudio` rejects placeholder peer addresses **before releasing
   Nearby**, on both roles, so garbage never reaches `connectPeer`.

Locked by updated native asserts in `test-direct-call.cjs` (both config paths +
address-poll) and a new lifecycle test (placeholder-address ack fails without
releasing Nearby).

**Still unverified on-device:** `phase=connecting-peer` → `group=… owner=…` →
`control-ready` — rounds 1–2 never reached it; round 2a is the first true test
of the two-sided connect.

## Verification

- `npx tsc --noEmit` PASS.
- 9/9 suites PASS (plain `node`), including new locks:
  - connect splits GO intent, keeps 2.4 GHz, no `setNetworkName`/`setPassphrase`
    remains in the module;
  - refresh loop constants + re-issue in the unformed branch;
  - role from `isGroupOwner` readback + client owner-device guard;
  - host/client deadlines (25 s/20 s) inside the 30 s watchdog;
  - retry on non-`P2P_UNSUPPORTED` reasons, bounded, `current(r)`-guarded;
  - ack without the peer's P2P address never releases Nearby;
  - teardown foreign-group preservation via observed `networkName`;
  - address read enables Wi-Fi itself + kicks `requestP2pState` + polls past
    the placeholder (no "toggle Wi-Fi" text anywhere in the read);
  - `ensureWifi` silent-then-panel path, `ensureChannel` reopen, closing-link
    auto-wait, and the whole-module ban on instruction-style messages;
  - ack/release timers shortened by the `ackTimeout` hook (8 s and 25 s);
  - JS setup backstops (`DirectCallAudio.start` + both
    `'Direct call setup timed out'` sites) strictly exceed the composed
    Wi-Fi-off stack read out of the Kotlin source, and the pre-accept ring
    timeout stays 45 s.
- Kotlin compiled: `:app:compileReleaseKotlin` BUILD SUCCESSFUL.

## Retest round 3 (Oct 14): both phones — "Wi-Fi Direct address not ready (read 02:00:00:00:00:00)"

Both phones rang, accepted, and then both failed at the very first Wi-Fi touch
with the placeholder MAC. That is the same value that round 2 shipped inside
`direct-config`; the round-2a guard simply stopped it travelling and turned it
into an honest failure.

**Root cause.** `pollP2pAddress` reads the local P2P address with
`WifiP2pManager.requestDeviceInfo()` (API 29, so it exists on both phones).
That call reads from the **P2P device interface**, which the stack has not
created yet — this read *is* the app's first P2P operation of the process.
With no interface to read, `getP2pDeviceAddress()` returns
`MacAddress.MAC_ANY_ADDRESS`, so the listener answered with the placeholder on
all 20 attempts. **Wi-Fi was already on on both phones**, so this is not a
stack still warming up after the panel — the device interface is not created
until a P2P operation runs, and nothing in the app had run one yet.
`requestP2pState` did not help: it only *reports* whether P2P is enabled, it
does not create the interface. The 8 s deadline was never the binding
constraint — the answer was wrong from the first attempt, not late.

**Fix** (`DirectWifiModule.kt`):

- `discoverPeers()` runs before the first poll. It is the operation that makes
  the stack create the device interface (and it is what the later `connect()`
  does anyway). Stopped again as soon as the address settles.
- `p2pInterfaceAddress()` reads `p2p0` directly through `NetworkInterface` —
  the same device address, straight from the interface, bypassing the
  framework's placeholder. Only the exact name `p2p0` is accepted: group
  interfaces are named `p2p-wlanN-M` and carry the group BSSID, which is a
  different address and would break `connect()`.
- **Escalation after ~4 s of polling**: form a temporary group and read the
  address from `group.owner.deviceAddress`, then `removeGroup()` before
  `connect()` runs. This is the source that does not depend on the device
  interface existing at all, and the round-2 log proves this hardware populates
  `group.owner` (`phase=creating-group … owner=true interface=p2p-wlan0-0`,
  ~200 ms). It only runs when the ordinary sources have had their chance, so it
  costs nothing on a healthy stack.
- `firstUsable()` rejects the placeholder on **every** source, so a bad value
  can never travel either way.
- Budget 8 s → `ADDRESS_WAIT_MS = 12 s` (250 ms × 48), because the read now
  waits for an interface that has to be created, not just polled.
- Every poll logs `deviceInfo=… p2p0=…` and the exhaustion line logs the SDK
  level, so the next logcat is conclusive if this recurs: `p2p0=absent` means
  the stack never created the interface; `p2p0=<mac>` means the direct read
  works and the framework's copy is simply stale.

JS backstops moved 60 s → **90 s** to keep covering the composed chain
(panel 12 s + address 12 s + native watchdog 30 s = 54 s before media starts),
so a native phase error is still the first thing reported.

## Retest round 4 (Oct 15): 0 connects — escalation read the group too early

No call reached `phase=connecting-peer` on either phone. The diagnostics did
exactly their job and isolated it:

| Observation | Phone | Meaning |
|---|---|---|
| `deviceInfo=02:00:00:00:00:00` on all polls | both | `requestDeviceInfo` is a permanent dead end |
| `p2p0=absent` on all polls | both | `NetworkInterface` cannot read the device interface either |
| `EthernetTracker: iface: p2p0, up: false` | Samsung | the interface *exists* in the kernel — it is just down and unreadable to us |
| `address escalation after 32 polls` → 4 s wasted | both | the ordinary sources were given far too long |
| **`createGroup` succeeded, `P2P-GROUP-STARTED p2p-wlan0-0 GO … go_dev_addr=f6:7d:ef:97:da:68`** | Samsung | the group source works, and contains the real address |
| our `removeGroup` logged **18 ms before** `P2P-GROUP-STARTED` | Samsung | we read the owner before it existed, then destroyed the group |
| `createGroup failed reason=2` (`P2P_UNSUPPORTED`) ×5 | Infinix | group never formed at all — a different blocker |

**Root cause of the round-4 failure.** `createGroup`'s `onSuccess` fires when
the *framework accepts* the request, not when the group has started. The owner
device — the whole reason for the escalation — is only populated with
`P2P-GROUP-STARTED`. Reading `group.owner` in that window returned nothing, so
the code called `removeGroup` and killed a group that had just given up its
address 18 ms later, then retried into `P2P_UNSUPPORTED`.

**Fix:**

- `pollOwner()` now polls `requestGroupInfo()` (150 ms × 20, up to 3 s) until
  `firstUsable(group.owner.deviceAddress)` is real, and **only then** drops the
  group. The read and the drop can no longer be reversed — locked by a suite
  assertion on their relative order.
- Escalation triggers on **6 consecutive empty polls (~1.5 s)** instead of a
  fixed 32 attempts (4 s), since tiers 1 and 2 are now known dead ends here.
  With discovery stopped first, the whole read should settle around ~1.6 s.
- `discoverPeers` is stopped before `createGroup` — discovery and group
  formation contend for the same radio, a plausible cause of the Infinix
  `reason=2` storm.
- Failures now carry their own detail: `… direct group createGroup failed
  reason=2`, so a screenshot alone is diagnostic.
- The read logs `wifi=… location=… p2pFeature=…` at start. That settles the
  Samsung/Infinix asymmetry on the next round: group formation needs Location
  enabled, and the Infinix is the one phone where it never worked.

## Retest round 5 (Oct 15): 0/6 — `createGroup` refused, and it was my own change

Six attempts, three per phone, all failing identically. The escalation timing
worked exactly as designed (`escalation after 6 empty polls` at +1.30 s,
`address read exhausted` at +2.35 s) and the new failure detail named itself:
`Wi-Fi Direct address not ready (read 02:00:00:00:00:00; direct group
createGroup failed reason=2)`.

**`pollOwner` was never reached** — `createGroup` refuses before `onSuccess`, so
round 4's ordering fix is correct but still unexercised on hardware.

| Evidence | Phone | What it rules out / in |
|---|---|---|
| `address read start … wifi=true location=true p2pFeature=true` ×6 | both | **Location hypothesis disproven**; "Wi-Fi Direct off in Settings" disproven too |
| `SemWifiP2pService … DISCOVERY_STATE_CHANGE` + `MdxKitService … state: 2` (started) at +28 ms after our `discoverPeers` | Samsung | the stack **accepted** our command — P2P is enabled |
| `wpa_supplicant: P2P-FIND-STOPPED` at **+4 ms** after our `stopPeerDiscovery` | Infinix | the stack **executed** our command — supplicant is live |
| `createGroup … reason=2` (`P2P_UNSUPPORTED`) | both | refused at the gate; framework logged **zero** activity for it |
| Round 4 accepted `createGroup` on the Samsung with discovery running for 4.1 s | Samsung | discovery was never the blocker |

**Root cause.** Between "stack demonstrably working" and "createGroup refused",
the only P2P operation was **our own `stopPeerDiscovery`** — added this round as
a radio-contention theory, with no supporting evidence. Round 4's success ran
with discovery *active* the whole time. I inverted a working precondition and
broke the one path that had been proven.

The Infinix is a **separate, pre-existing** blocker: it refused `createGroup` in
round 4 too, under round-4 conditions with no stop involved. It is also the only
phone where `discoverPeers`/`stopPeerDiscovery` are proven to work and
`createGroup` never has.

**Fix for round 6:**

- **Revert the stop.** `escalate()` now re-arms `discoverPeers` and leaves it
  running into `createGroup` — restoring round-4's proven-good state. Locked by
  a suite assertion that `stopPeerDiscovery` must not appear between
  `fun escalate(` and `createGroup(`.
- **Log `discoverPeers` failures** (`discovery kick failed reason=…`). It had a
  `null` listener for four rounds, so a refused kick was invisible.
- **Log `requestPeers()` on every attempt** — count, name, address, status.
  This is the deciding evidence for the peer-discovery alternative: if the list
  fills, the local-address read can be dropped entirely for a mechanism with
  positive evidence on *both* phones (`discoverPeers` works everywhere;
  `createGroup` has worked on neither phone more than once).
- **Backoff instead of hammering**: 0/300/700/1500/2500 ms (5.0 s total).
  Attempt #1 is immediate, so a reverted stop cannot be masked by the wait; the
  backoff only engages if that first attempt already fails, covering the
  "stack settles a few seconds in" hypothesis alongside it.

## Retest round 12 (Oct 15): Peer read in 12 ms, connect() dropped by AOSP isConfigInvalid

Evidence from log_bigk_SM_12 and log_bigk_infinix_12:
- Peer discovery worked flawlessly on both devices in under 25 ms (Infinix found Galaxy A10 in 11 ms; Samsung found Infinix in 20 ms).
- Both phones reached `phase=connecting-peer`, then failed at `connect to the other phone failed (0)`.
- Android logcat on Samsung showed:
  `SupplicantP2pIfaceHal: getGroupCapability(0a:77:88:51:c6:da) failed: 1 ()`
  `WifiP2pService: Dropping connect request`
- Root cause identified from AOSP `WifiP2pServiceImpl.java`:
  `boolean isConfigInvalid(WifiP2pConfig config) { return mPeers.get(config.deviceAddress) == null; }`
  Calling `stopPeerDiscovery()` immediately after peer resolution purged the peer from `mPeers` in the Android framework before `connect()` was dispatched, causing Android's internal state machine to drop the connect request with `ERROR (0)`.
- Fix applied:
  1. Discovery is kept active on successful address resolution (only stopped on timeout/exhaustion).
  2. `issueConnect()` and `retryBusy()` re-verify discovery is active before issuing `connect()`.
  3. Discovery is cleanly cancelled in `cancelAndRelease()` on call teardown.

## Physical retest checklist (round 6 — executed; round 7 below is the current one)

The point of this round: **no preconditions to set up**. Bluetooth and Location
stay on (that is the always-on availability setting, not a per-call step);
Wi-Fi may be **off** — the app must handle it.

1. `scripts\build-offline-call.ps1` → install the new APK on **both** phones
   (v2 signaling is not compatible with older APKs — the guard shows
   "Install the same new APK on both phones").
2. Each phone calls the other **5×** → expect **10/10 connects**. Keep at least
   2 of the 10 with Wi-Fi switched off beforehand on both phones, to prove the
   panel automation (expect one OS toggle per phone, then the call continues
   by itself).
3. Success logcat markers (both sides):
   - `DirectWifi … phase=connecting-peer elapsedMs=…`
   - `DirectWifi … group=DIRECT-… owner=<peer mac>` (role readback)
   - `DirectWifi … owner=… interface=p2p-wlan0-0 frequency=…`
   - `[DirectICE] control-ready` → `[DirectCall] WebRTC state 'connected'`
     (~0.8 s later) → `[WebRTCMetrics] received` climbing.
4. When Wi-Fi starts off, also expect:
   `opened the system Wi-Fi panel so the call can continue` →
   `Wi-Fi is on; resuming call setup`, then the markers in (3).
5. When Wi-Fi starts off, expect setup to be **slow but not dead**: the panel
   wait (12 s) + direct address read (12 s) + native connect watchdog (30 s)
   run in sequence, so media may start up to ~54 s after Call. Nothing should
   fail before that with a generic "setup timed out" — the first failure must
   name its phase (`Wi-Fi is off`, `Wi-Fi Direct address not ready`,
   `Direct Wi-Fi setup timed out at <phase>`). With Wi-Fi already on, expect
   the usual few seconds.
6. The address read logs everything decisive now. Round 5 already answered two
   of these — `location=true p2pFeature=true` on all six attempts, so neither
   Location nor a missing feature is in play. What round 6 must show:
   - `address read start sdk=… wifi=true location=true …` (unchanged);
   - `discovery kick failed reason=…` — **must not appear**. Its absence
     confirms `discoverPeers` was accepted, as in round 5;
   - `address peer list size=N attempt=… peers=Name|mac|status` — the new line.
     `size=0` on every attempt means peer discovery cannot carry the address and
     the group path is the only route. **Any nonzero size is the green light to
     drop the local-address read entirely** — capture that log if you see it;
   - `address escalation after 6 empty polls …` at +1.3 s, then either
     `address read from group owner=<real mac>` (success, ~1.6 s) or a
     `createGroup failed reason=2` at attempt 1 **without** a
     `discovery kick failed` line in between — that pattern would mean the stop
     was not the whole story;
   - failures still name themselves: `Wi-Fi Direct address not ready (read …;
     direct group createGroup failed reason=2)` — screenshot alone is conclusive.
7. If a join stalls on XOS, the log must now show
   `peer group not formed; refreshing connect N` every ~3 s (the old silent
   `joining-group` stall is gone). Capture a fresh logcat if 10/10 is not
   reached.
8. Hangups should read "Peer ended the call"; a `SocketException` ending is
   now a genuine radio drop.

Watch item: this is the first round where Wi-Fi cycles off→on during an
established Nearby signaling connection — if a session dies right at the
enable, capture the logcat around `Wi-Fi is on; resuming call setup`.

## Retest round 6 (Oct 15): the green light — both phones found each other

Round 6 re-ran round 5's experiment with the stop reverted, discovery re-armed,
a logging kick listener, and `requestPeers()` logged on every attempt. Four
sessions, two per phone, and the deciding line appeared:

| Phone | Session | Result |
|---|---|---|
| Samsung | 1 | `address peer list size=1 attempt=4 peers=Infinix HOT 60 Pro\|0a:77:88:51:c6:da\|3` — size=1 on **all five** attempts |
| Samsung | 2 | same peer, size=1 on all five |
| Infinix | 1 | `size=0` on all five — the Samsung had not surfaced within 6.4 s |
| Infinix | 2 | `size=0,0,0` then **`size=1 attempt=1 peers=Galaxy A10\|f6:7d:ef:97:da:68\|3`** at +3.9 s |

**The green light defined in round 5 is met: nonzero peer-list size on both
phones, carrying real addresses.** `f6:7d:ef:97:da:68` is exactly the
`go_dev_addr` this same stack reported in round 4, so these are correct,
usable addresses — not artifacts. Status `3` is `WifiP2pDevice.AVAILABLE`.

What this settles:

- **`discovery kick failed reason=` never appeared** in any of the four
  sessions → `discoverPeers` was accepted every time.
- **`createGroup` still refused `reason=2` with discovery running and backoff
  spanning 6.4 s** (Infinix gaps 314/714/1515/2514 ms — exactly the configured
  backoff). Round 5's `stopPeerDiscovery` theory **and** the placement-timing
  theory are therefore **both disproven**: the stop was not the cause, and
  neither was when the call was placed.
- **All three local sources of *this* phone's own address are now closed on
  evidence, not on theory:** `requestDeviceInfo` → `02:00:00:00:00:00`
  permanently; `p2p0` → never readable even though the framework logs that it
  exists; `createGroup` → refused across ~30 attempts in four rounds. None can
  ever produce a value `connect()` could use.
- **Neither side needs to read its own address at all.** Each phone needs the
  *other's*, and each phone's own `requestPeers()` returns exactly that —
  Samsung → Infinix's mac, Infinix → Samsung's mac, both observed directly.

### What changed for round 7

The local-address read is **deleted, not bypassed**:

- `DirectWifiModule.kt`: `getP2pAddress`, `pollP2pAddress`, `p2pInterfaceAddress`,
  `firstUsable`, `escalate`, `pollOwner`, `retryDelay` and their constants are
  gone (~150 lines of a path that never worked). Replaced by
  `getPeerP2pAddress(expected)` → `ensureWifi` → `discoverPeers` (logged
  listener) → `requestPeers` polled every 250 ms inside a 12 s deadline.
- **Identity is never guessed from a crowd:** an exact, case-insensitive match
  on a known device name wins first; otherwise exactly **one** `AVAILABLE` phone
  is accepted; otherwise the read fails loudly with the full observed list. A
  wrong pick cannot reach audio — the control token rejects a stranger before
  any media flows.
- `DirectCallAudio.handoff()` now calls `getPeerP2pAddress([peerDeviceName])`
  **instead of** `getP2pAddress()` and dials that. The address carried in
  `direct-config`/`direct-ready` is now only a cross-check; each side discovers
  independently, so a bad value can never be the one connected to.
- Wi-Fi still brings itself up (`ensureWifi`), so there is still nothing to set
  up by hand: the user only presses Call.

Timing is budget-neutral — discovery sits in the same position in `handoff()`
the old read occupied, with the same `ADDRESS_WAIT_MS` = 12 s, so the JS backstop
math (panel 12 + read 12 + watchdog 30 = 54 s < 90 s) is unchanged.

**Discovery latency — addressed in the same change.** Samsung surfaced the peer
at +1.36 s; Infinix took +3.9 s in one session and missed entirely within 6.4 s
in another. The read now has 12 s rather than 6.4 s, **and** discovery is
warmed up at call placement (caller) and at incoming call (callee) — new
`warmUpPeerDiscovery` — so it runs for the whole ring instead of only during
setup. The warmup never opens the Wi-Fi panel and never rejects; the handoff
still owns the Wi-Fi turn and kicks discovery again. Watch
`peer discovery warmed up` / `peer discovery warmup failed reason=` /
`peer discovery warmup skipped; Wi-Fi is off` to see it engage. If round 7
still shows `peer read exhausted … no peers seen` despite those, the ring time
was not the limiting factor and the next lever is a periodic re-kick inside the
read.

## Physical retest checklist (round 7 — peer discovery replaces the local read)

Same rule as every round: **no preconditions to set up**. Bluetooth and Location
stay on (that is the always-on availability setting, not a per-call step);
Wi-Fi may be **off** — the app must handle it.

1. `scripts\build-offline-call.ps1` → install the new APK on **both** phones
   (v2 signaling is not compatible with older APKs — the guard shows
   "Install the same new APK on both phones").
2. Each phone calls the other **5×** → expect **10/10 connects**. Keep at least
   2 of the 10 with Wi-Fi switched off beforehand on both phones, to prove the
   panel automation (expect one OS toggle per phone, then the call continues
   by itself).
3. **Read this first — did discovery find the peer?** It replaces every
   round 3–6 address error:
   - `peer read start sdk=… wifi=true location=true p2pFeature=true expected=[…]`
   - `peer discovery warmed up` at placement/answer time (or
     `… warmup skipped; Wi-Fi is off` when Wi-Fi is off — correct: the warmup
     never opens the panel, `ensureWifi` does that later in the handoff);
   - `peer read left=N peers=<name>|<mac>|<status>` when the list is non-empty
     (and on every 8th empty attempt);
   - **success:** `peer read resolved <mac> by=name=<device>` or
     `by=single-available=<device>`;
   - **failure:** `peer read exhausted peers=…` — screenshot it. The text says
     whether it was `no peers seen` (discovery too slow) or a crowd (identity
     not resolvable), which points at the next fix directly;
   - `discovery kick failed reason=` **must not appear**.
4. The rest of the success chain is unchanged:
   - `DirectWifi … phase=connecting-peer elapsedMs=…`
   - `DirectWifi … group=DIRECT-… owner=<peer mac>` (role readback),
     `owner=… interface=p2p-wlan0-0 frequency=…`
   - `[DirectICE] control-ready` → `[DirectCall] WebRTC state 'connected'`
     (~0.8 s later) → `[WebRTCMetrics] received` climbing.
5. When Wi-Fi starts off: `opened the system Wi-Fi panel so the call can
   continue` → `Wi-Fi is on; resuming call setup`, then (3) and (4). Slow is
   fine — panel (12 s) + peer read (12 s) + watchdog (30 s) run in sequence, so
   media may start up to ~54 s after Call. Nothing should fail before that with
   a generic "setup timed out": the first failure must name its phase.
6. If a join stalls on XOS, the log must show
   `peer group not formed; refreshing connect N` every ~3 s.
7. Hangups should read "Peer ended the call"; a `SocketException` ending is now
   a genuine radio drop.

Failure messages this round are deliberately narrow: an address failure reads
`The other phone was not discovered over Wi-Fi Direct` or
`Wi-Fi Direct peer not discovered (<observed list>)`. Either message plus the
logcat is conclusive on its own, because everything the read saw is already
printed.

---

## Retest round 7 (Oct 15): peer read solved; a leftover group of our own blocked the call

Round 7 is the first time `connect(deviceAddress)` was ever reached with a
correct address. The address problem is **closed**.

| Phone | Reads resolved | Latency |
|---|---|---|
| Infinix | **4/4** � `f6:7d:ef:97:da:68 by=single-available=Galaxy A10` | 22 ms, 1.5 s, 11 ms, 20 ms |
| Samsung | **4/5** � `0a:77:88:51:c6:da by=single-available=Infinix HOT 60 Pro` | 0.8 s, 20 ms, 11 ms, 24 ms |

`peer discovery warmed up` printed on both phones; `discovery kick failed` is
absent everywhere. The warm-up worked: once warm, the list is populated in tens
of milliseconds, not seconds.

The one failing Samsung read (`21:00:34` ? `21:00:46`) exhausted with
**`no peers seen`** � and that is not an independent latency problem. It is a
cascade: the Infinix's *own* attempt had already failed a second earlier, its
handoff stopped discovery, and the Samsung then had nobody left to see. One
root cause, both symptoms.

### The round-7 blocker: 7.3�7.5 s, on every attempt, on both phones

Every attempt resolved the address in under 1.5 s and then failed **7.3�7.5 s
later**, with `The previous Wi-Fi Direct link did not close`. That is
`waitForBootstrapRelease` spending its whole budget: 40 polls (20 � 100 ms +
20 � 250 ms = 7.0 s) of `requestGroupInfo`, then failing hard. The arithmetic
matches the observed gap exactly on both phones and on every attempt, so this
is not a race � it is a fixed timeout firing.

`requestGroupInfo` returns non-null only for a group **this phone belongs to**.
For 40 consecutive polls on both phones, both phones believed they were still
in a P2P group.

### The group is ours, and we are the ones who left it there

`log_bigk_SM_10.log:72789` decides it:

```
P2P-GROUP-STARTED p2p-wlan0-0 GO ssid="DIRECT-lN-SM-A105F" freq=2462 go_dev_addr=f6:7d:ef:97:da:68 [PERSISTENT]
```

at 18:39:19, immediately preceded by

```
DirectWifiModule$pollP2pAddress$escalate$1.onSuccess$lambda$1(DirectWifiModule.kt:303)
```

� the stack frame of our own deleted `escalate()`. The `[PERSISTENT]` flag and
`group_capab=0xab` (bit 0 = GROUP_OWNER, bit 1 = PERSISTENT) that the Galaxy A10
advertises in its P2P discovery responses confirm the OS re-created and retained
it. There is **no `P2P-GROUP-REMOVED` in any round-6 or round-7 Samsung log**,
and `MdxKitService: requestGroupInfo() group: network: DIRECT-lN-SM-A105F` reads
it back at 19:23 and 20:48 � an hour later.

The Infinix shows the same shape with less evidence: its main buffer starts at
20:53, so the group's creation is outside capture, but `requestGroupInfo`
answered non-null on all 40 polls of every attempt, which only happens to a
group member.

Round 7 deleted `escalate()` � but a group it created years of retries earlier
was still holding the door, and the code we replaced it with refused to walk
through.

### What changed for round 8

`waitForBootstrapRelease` no longer dead-ends. It was, in order:

- **never delete an unidentified group.** That rule survives � but it is now
  enforced by *identity and idle state*, not by never calling `removeGroup`.
  `requestGroupInfo` only ever reports a group this phone belongs to, the
  observed leftover was provably ours, and a group with a connected client is
  carrying somebody's traffic, so it is left alone and reported by `connect()`.
- attempt **0** logs the whole group � `owner=� role=� network=� clients=�` �
  so the next round identifies the leftover from one line;
- **3 polls of grace** for Nearby's asynchronous release after
  `releaseForDirectCall()`, which does legitimately tear a group down;
- `removeGroup()` at attempts **3 and 10**, and **only when `clients == 0`**;
- polls every **100 ms**, deadline `attempt < 20` (**2.0 s**, was 7.0 s);
- on timeout **proceed anyway** � `previous P2P link never released; starting
  app-owned link anyway` � instead of failing. This is safe because
  `releaseOwnedGroup`/`awaitGroupReleased` are already guarded by an
  `r.networkName` comparison, so teardown still refuses to delete a
  differently-named foreign group.

Net effect on the call budget: the worst case drops from a 7.0 s failure to a
2.0 s pause, and the failure branch is gone.

Two suite locks encoded the disproven design and were rewritten with it:
`test-background-availability.cjs` (now locks `attempt < 20`, the `clients == 0`
idle guard, the `attempt == 3 || attempt == 10` triggers, the proceed-anyway
line, and asserts `did not close` is gone) and `test-direct-call.cjs` (the
100 ms poll schedule).

## Physical retest checklist (round 8 � clear the leftover group)

Same rule as every round: **no preconditions to set up**. Bluetooth and Location
stay on (that is the always-on availability setting, not a per-call step);
Wi-Fi may be **off** � the app must handle it.

The leftover group is **OS-level and it persists across app restarts and
reboots**. Do not clear it by hand � round 8 exists to prove the app clears it
by itself. Installing the new APK over the old one will not remove it either;
that is the point.

1. Build, install on **both** phones. Each phone calls the other **5�** ?
   expect **10/10**. Keep at least 2 with Wi-Fi off beforehand.
2. **Read these three lines first** � they are the whole round:
   - `waiting for previous P2P link to release owner=� role=� network=� clients=�`
     on attempt 0. `clients=` is the deciding number: `0` means an idle leftover
     (which gets cleared), non-zero means a link carrying real traffic (which is
     deliberately left alone and will be reported by `connect()`).
   - `clearing the idle leftover P2P group` at +0.3 s or +1.0 s � the removal
     fired.
   - `P2P released; starting app-owned link` � the handoff proceeded.
   If instead `previous P2P link never released; starting app-owned link anyway`
   prints, that is now a **pause, not a failure** � the call continues. Screenshot
   the `owner=� clients=�` line from step 2 so the next fix can see why
   `removeGroup` did not take.
3. **The call must now reach `phase=connecting-peer`.** That is the line
   round 7 never printed. After it:
   `group=DIRECT-� owner=�` ? `[DirectICE] control-ready` ?
   `[DirectCall] WebRTC state 'connected'` ? `[WebRTCMetrics] received` climbing.
4. Round 7's address read is unchanged and already proven � it may simply say
   `peer read resolved <mac> by=single-available=<device>` in milliseconds. A
   second run of `peer read exhausted peers=� no peers seen` on the Samsung is
   expected only on the attempt where the Infinix failed first; if it appears
   **first**, screenshot it.
5. Error strings this round carry no setup instructions. If something fails it
   names its phase; report the phase name plus logcat.

---

## Retest round 9 (Oct 15, 23:31–23:37): **first connected calls**, and the guard that killed the rest

**Route 1 connected audio for the first time.** Three calls in the final block
ran the complete chain on both phones:

```
phase=connecting-peer → group=DIRECT-WD-Infinix HOT 60 Pro → phase=listening
→ phase=authenticating → phase=control-ready → [DirectICE] control-ready
→ [DirectCall] WebRTC state 'connected'
```

Sessions `mv9vnl79-u9rpgxts577`, `mv9vojhz-cjxqvua06yl`, `mv9vrqqr-217w7i9lnuy`.
Callee `localIp 192.168.49.1` (GO), caller `localIp 192.168.49.128` — exactly the
two-sided negotiate-connect design working as intended.

**The round-8 fix also proved itself on hardware.** At 22:08:15.073 the Galaxy
A10 found the round-6 leftover itself:

```
waiting for previous P2P link to release owner=02:00:00:00:00:00 role=owner
    network=DIRECT-lN-SM-A105F clients=0
clearing the idle leftover P2P group
P2P released; starting app-owned link        ← 0.33 s later
```

The 7 s dead-end is gone, and the group that caused rounds 7–8 was cleared by
the app with nobody touching the settings panel.

### Round-9 blocker: the idle guard was inverted on the client side

`clients == 0` is **always true for a phone that is a client**. `requestGroupInfo`
cannot see the group owner's member list from a client — `clientList` comes back
empty — so the guard protected nothing there. Worse, the group a client sees at
this gate is usually **the group the current call just formed**: the callee has
`CALLEE_GO_INTENT = 15` so it nearly always wins ownership and creates the group,
and the caller's own `connect()` has already joined it by the time the caller's
gate runs. The caller was deleting the call in progress.

The correlation is absolute — every one of the eight calls in the block:

| Session | Caller's gate | Result |
|---|---|---|
| `mv9vlm8n` | `P2P released` (nothing to delete) | fail — callee `connect failed (2)` ×8 |
| `mv9vlkiq` | **`role=client clients=0` → clearing** | fail |
| `mv9vm792` | **clearing** | fail |
| `mv9vnl79` | `P2P released` | **connected** |
| `mv9vnc1y` | **clearing** | fail |
| `mv9vojhz` | `P2P released` | **connected** |
| `mv9vq298` | **clearing** | fail |
| `mv9vrqqr` | `P2P released` | **connected** |

4/4 calls where the caller deleted a group failed; 3/3 where it found nothing
connected. The one outlier found nothing to delete and failed for a separate
reason (below).

The kill, on the callee, for `mv9vq298` (the two phones' clocks differ by ≈38 s —
Samsung ahead; anchored on the group-start pairing and both `control-ready`
timestamps, which agree to 0.6 s):

```
23:35:52.055 P2P-GROUP-STARTED p2p0 GO ssid="DIRECT-WD-Infinix HOT 60 Pro" [PERSISTENT]
23:35:52.167 phase=listening                          ← bound to 192.168.49.1:9875
      (caller joins, then its gate runs role=client clients=0 → removeGroup)
23:36:00.072 P2P-GROUP-REMOVED p2p0 GO reason=REQUESTED
23:36:00.157 phase=listener-retry:SocketException     ← the bound socket died
23:36:00.218 phase=listener-retry:BindException       ← 192.168.49.1 is gone
23:36:00.405 [DirectICE] failure "Direct control host (listener-retry:BindException):
             Direct control listener could not authenticate a peer before its deadline"
```

`reason=REQUESTED` is an explicit `removeGroup()`, not an idle or formation
failure — and the caller's own log shows it:

```
23:36:32.837 (caller) clearing the idle leftover P2P group
23:36:33.396 (caller) P2P-GROUP-REMOVED p2p-wlan0-0 client reason=REQUESTED
```

All four failing calls died with the identical `BindException` message; both
successful-with-a-leftover calls logged `leaving the previous P2P link alone`.

### What changed for round 10

`waitForBootstrapRelease` may now remove a group **only if it owns it and it has
no clients** — `group.isGroupOwner && clients == 0`. A group where this phone is
a client is somebody else's group, and is left alone with its role and client
count logged. The proceed-anyway branch is unchanged, so a group we refuse to
touch costs at most the 2 s deadline and then the call continues.

This keeps both previously-proven cases correct:

- round-6 leftover `role=owner clients=0` → still cleared ✓
- Infinix's live group `role=owner clients=1` → still left alone ✓

and closes the new one: `role=client` → never deleted ✓.

### Also in these logs

- **Friend requests worked end to end.** Samsung: `Accepted new endpoint for a
  friend request: 92b31889…` (the accept-gate change firing on a phone that had
  never saved the sender), `[CallSignaling] Signal received: friend-request`,
  then `friend-accept` back. Two `[FriendRequests] No live connection to answer
  over` warnings appear on the **decline** path — the documented limitation,
  where a decline cannot be delivered once the originating connection has gone
  and the sender is not (and never becomes) a contact.
- **The one remaining independent failure** is `mv9vlm8n`: the callee logged
  `connect to the other phone failed (2)` eight times over 7 s, then
  `Could not connect to the other phone (2)`. In the public API `2` is
  `P2P_UNSUPPORTED`, which is permanent — so the 7 s of retries were wasted, and
  the `reason != P2P_UNSUPPORTED` guard now added to `retryBusy` fails fast on it.
  Worth watching: if that stack really returns `2`, the message should say
  plainly that Wi-Fi Direct is unavailable rather than implying a transient
  error.

## Physical retest checklist (round 10)

Same rule: **no preconditions**. Bluetooth and Location stay on (that is the
always-on availability setting); Wi-Fi may be off — the app must handle it.

**Restart BigK on both phones after installing.** Round 9's Infinix process was
still the previous build at 23:31 (its `retry=1..8` on `(2)` is code that had
already been removed), which makes half a log impossible to read.

1. Install on both, 5 calls each way → target **10/10**. Keep ≥2 with Wi-Fi off.
2. **The deciding pair of lines.** The caller may now legitimately see a group:
   - `leaving the previous P2P link alone (role=client clients=…)` — correct, and
     the call must continue from here;
   - `clearing the idle leftover P2P group this phone owns` — only ever printed
     when this phone is the owner with nobody attached.
   A `clearing …` line followed by a failure is the round-9 bug; screenshot it.
3. The callee's listener must survive: `phase=listening` should be followed by
   `phase=authenticating`, **not** `phase=listener-retry:SocketException`. If
   `SocketException` → `BindException` appears again, grep the same instant for
   `P2P-GROUP-REMOVED … reason=REQUESTED` and say which phone printed it.
4. Success is unchanged: `phase=control-ready` → `[DirectICE] control-ready` →
   `[DirectCall] WebRTC state 'connected'` within ~1 s.
5. `connect failed (2)` should now fail **immediately** with `Could not connect
   to the other phone (2)` rather than after 8 retries. If it still retries, the
   installed build is not this one.

---

## Between round 9 and round 10: the QR add is one-way again

The friend-request half built for round 9 was removed before this build. The
`friend-request` / `friend-accept` / `friend-decline` signals, the native
pending queue and its notification, `services/FriendRequests.ts`, the Requests
section on Contacts, and the `openFriends` deep link are all gone; the accept
gate in `NearbyTransport` is back to refusing any endpoint that is not already
in `contacts`.

So the only "Also in these logs" item above that no longer applies is the
friend-request round trip — it did happen on hardware, but there is nothing
left to retest. The call-path findings are unaffected: scanning still adds the
contact on the spot and sends nothing to the other phone.

`test-background-availability.cjs` now locks the strict gate instead of the
open one, so an accidental reintroduction fails the suite.

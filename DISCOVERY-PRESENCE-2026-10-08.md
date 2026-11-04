# Discovery presence & staged dial feedback — 8 October 2026

## Problem

Dialing was a *cold* path in practical use:

1. **Endpoints vanished on every pause.** `NearbyDiscoveryService` deleted a
   contact on the first `onPeerLost` (Nearby fires this on transient signal
   dips) and wiped the whole cache on every fresh `startContinuousDiscovery`.
   Because scanning stops around every dial (`connectPeer` stops discovery
   before `Nearby.connect`, and availability restarts afterwards), each call
   after the first paid for a full radio scan — 2–15 s of "Finding contact…"
   before the other phone even rang.
2. **The radio was warmed behind the tap.** `CallingHome.call()` silently
   stacked a permission check, foreground-service start, advertising start and
   scan on top of the dial, with the same generic status text.
3. **One blind 15-second timer.** `findEndpoint` produced no feedback until
   the deadline, then a single generic failure.

## Changes

### `services/NearbyDiscoveryService.ts` — presence grace model
- Entries gained `discovered` (live scanner visibility) and `lastSeen`.
- `onPeerLost` / `onConnectionClosed` now drop the **endpoint id immediately**
  (a dead address is never handed to a dialer) but keep the **contact** for a
  45 s grace window; re-discovery cancels the expiry.
- `stopDiscovery()` flips `discovered` off **without** deleting entries or
  emitting events (stopping is routine around every dial; subscribers replay
  current state on attach).
- Fresh `startContinuousDiscovery` **no longer wipes** the cache; it sweeps
  only entries older than the grace window. Native-refusal paths still clear
  the cache (a cached peer must not be shown as reachable when scanning is
  off).
- `isDiscovered()` now reflects live visibility, not mere cache presence.

### `services/OutgoingCall.ts` — staged, actionable dial feedback
`findEndpoint` reports phases through the existing `onStatus` channel:
- `Finding {name}…` (or `Looking for {name} — not seen recently` when the
  contact was last seen > 15 min ago)
- `Scanning for {name} nearby…` at 3 s
- `{name} may be out of range — keep BigK open on their phone` at 8 s
- the existing actionable failure at 15 s
- the bounded 6 s radio refresh is unchanged; all stage timers are cleared on
  success or failure.

### `store/appStore.ts` — persisted presence
- New `lastSeen: Record<uuid, epoch-ms>` field with `touchLastSeen()`
  (60 s throttle per contact, unknown contacts ignored, persisted under
  `@kela_last_seen`, loaded in `loadData`).
- Deliberately **not** stored on `friends`: every friends write re-configures
  Nearby availability and may restart discovery, which presence updates must
  not trigger.

### `components/CallingHome.tsx` — honest status, pre-warm affordance
- Contact rows show `Nearby now · tap to call` / `Last seen {relative}` /
  `Tap to find and call` instead of "Recently detected · connection not yet
  checked"; the presence set now filters on live `discovered` only.
- The availability status row is tappable when local calling is off
  (one-tap repair before dialing, with a refresh affordance).
- `call()` shows `Enabling local calling…` while warming the radio and raises
  an alert with the concrete availability error if it could not be enabled
  (previously a silent no-op).

### Tests / pipeline
- New `scripts/test-discovery-presence.cjs` — 9 tests: grace expiry, endpoint
  invalidation on lost/close, re-discovery cancels expiry, **warm cache
  survives the stop/start cycle** (regression for the old wipe), stale sweep,
  staged status progression, warm-cache fast path (no stage timers), timeout
  with guidance, `touchLastSeen` throttle.
- Registered in `scripts/build-offline-call.ps1` after the connection suite.

## Verification

- TypeScript `--noEmit`: **passed**.
- All **8** Node suites: **passed** (plain `node`, matching the build script).
- Existing behavioural contracts preserved: native-refusal cache clearing,
  immediate endpoint invalidation on close, one bounded scan refresh, retry
  semantics (`Retrying connection once…`).

## Deliberately unchanged

- **Stop-discovery-before-connect** in `connectPeer` is kept: the native
  transport and the regression suites are designed around that ordering, and
  the cache wipe (the actual latency source) is gone.
- No change to Nearby/Wi-Fi Direct native code — this release is TS/JS only,
  so no new APK-side radio behaviour is introduced beyond what the current APK
  already does.

## Physical two-phone checks still required

Mocked tests do not prove radio behaviour. On hardware, verify:
1. Call, hang up, call again quickly — second dial should show the contact
   instantly (no long "Finding contact…" when both phones are near).
2. Contact row states: `Nearby now`, `Last seen …` after one phone goes away.
3. Airplane the other phone mid-scan → staged messages at 3 s / 8 s and the
   15 s failure text.
4. Toggle "Receive local calls" off → status row tap re-enables it; dial while
   off shows the enable status then the concrete error.

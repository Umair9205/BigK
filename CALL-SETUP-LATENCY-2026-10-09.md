# Call-Setup Latency — critical-path optimization (2026-10-09)

Follow-up to `ALWAYS-ON-AVAILABILITY-2026-10-09.md`. Timing was audited
stage-by-stage, then the app-controlled serial waits were removed. All bounds
(watchdogs, deadlines) are unchanged; only unnecessary serialization was.

## Optimizations

1. **Caller: call service primed beside the radio connect** (`OutgoingCall.placeCall`).
   The microphone-eligible `CallForegroundService` used to start *serially*
   inside the call screen, between Nearby connect and the ring request. It now
   starts the moment the user taps Call, overlapping the 1–3s connect. The
   failure path stops it; an incoming call that takes over owns it and it is
   never stopped out from under that call. Ring latency drops by the full
   service-start time (~0.3–1s).
2. **Callee: accept signal no longer waits behind the service**
   (`useNearbyCall.acceptCall`). `startCallService` now runs *beside*
   `sendCallAccept`. The peer's direct setup (config/ready/release) starts
   ~0.3–1s earlier on every answered call.
3. **Microphone + WebRTC overlap the Wi-Fi Direct formation**
   (`DirectCallAudio`). `getUserMedia` + `RTCPeerConnection` construction now
   begin when the run starts, overlapping group creation, DHCP and the control
   handshake (~2–5s) instead of running serially after the control link is up
   (~0.2–0.5s saved on both phones). Failures surface at the same point as
   before (first await in `initializeMedia`); a stop-guard owns late tracks so
   a cancelled call can never leak capture.
4. **Faster native formation polling** (`DirectWifiModule`).
   - Nearby-group release check: 100ms polls for the first 2s, then 250ms
     (both phones wait on this after `releaseForDirectCall`).
   - Group/DHCP poll: 200ms → 150ms.
5. **Control-socket retry tightened** (`DirectControlSocket`). Retry sleep
   150ms → 60ms (client connect races the listener coming up). `tcpNoDelay`
   was already set; Nagle adds nothing to SDP/ICE exchange.

## Resulting budget (typical / bounded-worst)

| Milestone | Before | After |
|---|---|---|
| Tap → callee rings | 1.5–4s / 30s+retry | **1–2.5s** / unchanged |
| Answer → control link ready | 2–5s | 1.5–4s |
| Answer → WebRTC audio flowing | 4–7s / 45s | **3–5.5s** / 45s |
| Tap → two-way audio | 5–12s | **4–8s** |

Everything past answer is bounded by the same watchdogs (30s native phase
watchdog with named stages, 45s JS setup timeout, 8s handshake acks, 15s
control deadline).

## Verification (2026-10-09)

- `npx tsc --noEmit` — PASS. 9/9 suites PASS (plain `node`).
- New coverage:
  - `test-call-connections`: dial primes the service beside connect, stops on
    failure, and never stops it when an incoming call took over.
  - `test-direct-call`: microphone capture starts before control-ready and is
    requested exactly once; native poll/retry constants asserted.
  - `test-direct-call-lifecycle`: answering sends the accept signal while the
    service start is still pending (gated-mock ordering proof).
- Existing handoff-protocol suites (19 lifecycle tests, ordering deep-equals)
  pass unchanged: early capture adds no protocol events.

## Physical verification markers

Same logcat flow as `ALWAYS-ON-AVAILABILITY-2026-10-09.md`. The new parallel
stages show as: `[DirectICE] control-ready` arriving while `[WebRTCMetrics]`
capture is already live, and `phase=… elapsedMs=…` values in `DirectWifi`
dropping by the amounts above on identical hardware.

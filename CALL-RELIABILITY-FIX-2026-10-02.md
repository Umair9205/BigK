# BigK connection reliability patch — 2 October 2026

Build label: `1.1.3-control-recovery`.

The design is unchanged: Nearby finds the contact and carries the invitation;
the acknowledged v2 handoff releases Nearby; Wi-Fi Direct carries WebRTC audio.
No new transport, internet fallback, or audio codec was introduced.

## Changes

- Wait for the actual Wi-Fi Direct interface's IPv4 address before opening control
  sockets. Explicitly bind the client socket to that address.
- Separate authentication/listener retries from an established control connection.
  An unexpectedly closed listener can be reopened with a bounded retry; errors
  after authentication cannot fall through to `accept()` on a closed listener.
- Track accepted sockets during authentication so cancellation closes them too.
- Confirm repeated missing-group reports over 1.5 seconds before terminating an
  established call. A recovered group resets that window; real failures still end.
- Keep ready, control-message and error delivery ordered on Android's main thread.
- Preserve early discovery callbacks, replay live discovered endpoints when a
  listener/contact list changes, and discard callbacks from a retired scan.
- Refresh idle advertising after endpoint closure, and refresh a stalled outgoing
  scan once within its existing 15-second deadline. Never refresh an active call.
- Retry Nearby's generic connection ERROR once; do not retry permission denials.
- Do not send hangup through the intentionally disconnected Nearby bootstrap.
- Fix PowerShell quoting in the existing build script.

## Verification

- 83 Node checks passed; TypeScript check passed.
- 7 JVM tests of the production control-socket helpers passed, using real loopback
  TCP sockets. These cover authentication, bidirectional control messages, listener
  reopening, cancellation, deadlines, bounded frames and transient group loss.
- APK build was blocked by Windows denying execution of `hermesc.exe`.
- Android compilation could not be verified here. The separate debug native
  check failed in Expo's dependency compilation with `AccessDeniedException` for
  a Gradle cached `jetified-core-ktx-1.12.0-api.jar`, before compiling BigK's changed
  Kotlin sources. The release-only attempt also requires the blocked Hermes task.
- No new APK was produced. The existing release APK is from before this patch.
- These tests do not establish real-phone call success, latency, radio range or
  audio quality. The other device's log was unavailable; the exact cause of its
  failure to join is not proven by this phone's log alone.

## Rebuild and test

Build from the repository root using:

```powershell
npx expo run:android --variant release --device
```

Install the new build on both phones. Test calls in both directions, hang up,
then immediately call again. Do not install an older APK left in the output
directory after a failed build.

Original versions of the existing edited files were copied before editing to
`.codex-backups/call-reliability-20261002`. New helper/test files are not in that
backup; the backup is not a full project snapshot.

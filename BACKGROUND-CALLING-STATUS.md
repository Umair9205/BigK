# Background calling and calling interface

Updated 1 October 2026.

## Method

Separate user-enabled local availability from microphone capture. Android owns a connected-device foreground service with a visible notification. React Native owns the contact/call interface. Nearby advertises and discovers automatically while idle; discovery stops during call setup/audio and resumes after cleanup. Incoming calls use Android CallStyle notifications with session-bound Answer and Decline actions. Start the microphone foreground service from the visible outgoing-call or answer flow, before asynchronous Wi-Fi setup can leave the app in the background.

No periodic WorkManager polling, overlay permission workaround, permanent wake lock, silent microphone activation, or unconditional battery-optimization exemption is used. The app provides access to Android battery settings and respects notification/availability choices.

## Implemented in this pass

- Calls, Contacts and Settings interface with search, recent calls, QR contact actions and one-tap calling.
- Automatic app-lifetime discovery; the legacy discovery route now opens Contacts.
- Separate connected-device availability service and microphone call service.
- Native incoming call notifications, conditional full-screen intent support and Answer/Decline actions.
- Notification actions bound to the current session and an unpredictable native token; an arbitrary activity intent must not answer a call.
- Native availability notification includes Pause; the app respects that choice when reopened.
- Explicit answer required. Legacy auto-answer preferences are not used.
- Service startup failure and notification-permission warnings are surfaced in the interface.
- Backup of the original app/hooks/modules/services/native source is under `.codex-backups/background-calling-20261001-142505`.

## Not complete

Background reception is a release requirement, but is NOT yet phone-verified. The application-scoped NearbyTransport now owns advertising, connection callbacks, saved-contact filtering, the pending invitation, expiry and notification delivery independently of the React screen. AvailabilityService uses START_STICKY and restores advertising from saved configuration when Android restarts it; task removal does not stop the service. Opening the app retrieves the current invitation. Microphone capture is never restored automatically. A killed process loses the current connection/invitation; recovery enables subsequent calls, not seamless restoration of an interrupted call. Force-stop and OEM restrictions cannot be bypassed by this design.

Nearby requests now use normal power with disruptive upgrades disabled. This does not force Wi-Fi Direct discovery. Completed-call Nearby connections and app-owned Wi-Fi Direct groups may be retained for 30 seconds to reduce immediate-redial setup; audio, microphone and call sockets are stopped immediately. Queued direct starts are invalidated on cancellation. These transport changes require both-device regression testing.

The source backup for this pass is `.codex-backups/connection-background-20261001`. No independent Wi-Fi Direct discovery, boot auto-start, shared-LAN fallback, or additional ringtone playback engine was added in this pass.

Doze, OEM battery managers, radio disable/re-enable, task removal, reboot, long screen-off periods and device-specific notification policies are NOT validated by the automated tests. Force-stop must be respected; the user must reopen the app afterward. Nearby reception and advertising depend on radio conditions and permissions, not just physical proximity. No guarantee of immediate delivery or all-day battery use is made.

Shared-router calling, cryptographic peer authentication and the rest of the proposal remain separate unfinished work. QR contact identifiers are not verified public-key identities yet.

## Verification

The current TypeScript check, all 45 script checks and full offline release build pass. Application-logic checks and source assertions cover availability startup/pause, native registration, transport ownership, invitation restoration, and cancellation. Source assertions are structural checks, not executed Android lifecycle tests. Real-device background reception and audible ringing remain unverified.

Fresh APK: `C:\Users\umair\OneDrive\Documents\kela-konnect\android\app\build\outputs\apk\release\app-release.apk`, built 1 October 2026 at 16:53 local time. SHA-256: `A50AB2CD489DD778E454CF88332158F6FD444FC9588C33B5DAF1D0D5B70FEC1A`. Install the same APK on both phones; no installation was performed by this task.

Run TypeScript checking and all five calling scripts under `scripts/test-*.cjs`. These are mocked application-logic checks plus source assertions, not Android lifecycle instrumentation or evidence that background phone calls work. A complete release build and inspection on both devices are required before treating background behaviour as verified.

## Device acceptance checklist

Install the same freshly built APK on both phones; open once and grant permissions. Verify Bluetooth, Wi-Fi and required location settings. Pair both contacts.

1. Without opening Discover, call in both directions from Contacts.
2. Put the recipient on the home screen. Call; answer and decline from the notification separately.
3. Lock the recipient. Check incoming notification, permitted full-screen presentation, answering and declining.
4. Cancel from the caller while ringing. The other notification and ringing screen must disappear.
5. End an accepted call from each side. Confirm microphone indication clears while idle availability remains enabled.
6. Repeat calls without restarting either app. Check discovery recovers after failures and hangup.
7. Pause availability from its notification. Confirm no automatic restart on returning to the app. Resume explicitly.
8. Block notification permission and verify the app warns rather than reporting unrestricted readiness.
9. Test extended screen-off/Doze, task removal, process death, radio toggles and reboot separately. Record failures; do not group these together as simply 'background'.
10. Force-stop: expected unreachable until explicitly reopened. Do not attempt to bypass this user control.

Release gate: repeat incoming calls in BOTH directions with the receiving app swiped from Recents, first after one minute and then after five minutes with its screen locked. Confirm the availability notification remains, the incoming notification rings, Answer establishes two-way audio, and Decline/caller cancellation clears the invitation. Repeat after a longer idle period and after an OS process restart separately. A foreground-service notification alone is not a passing result. For defense, claim only the conditions and devices actually tested; do not claim 'always reachable'.

Record device model/Android version, battery settings, time idle, whether a notification appeared, whether Answer worked, whether both audio directions worked, and whether resources were released. Battery consumption must be measured before selecting continuous versus duty-cycled scanning for a final product.

## Android references

### Ringtone settings addition

Settings now includes Call ringtone. It opens Android's settings for the audible incoming-call channel; the user selects Sound there. Android stores the choice, and the app rereads its title when returning to the foreground. The channel is not recreated or deleted to override user choices. Turning Incoming call alerts off explicitly silences notifications while retaining the chosen sound for later. Android notification permission, channel importance, silent mode and Do Not Disturb still govern alerts. Six additional ringtone label/source checks were added; native picker navigation and actual playback are not phone-verified.

- https://developer.android.com/develop/background-work/services/fgs/service-types
- https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
- https://developer.android.com/develop/ui/compose/notifications/call-style
- https://developer.android.com/training/monitoring-device-state/doze-standby

Preserve the native Android project. Do not run a clean Expo prebuild that replaces these custom native files.

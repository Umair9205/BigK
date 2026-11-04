import { Alert } from 'react-native';
import { router } from 'expo-router';
import Nearby from '../modules/Nearby';
import { ensureNearbyAvailable } from './NearbyAvailability';
import { callNotifications } from './BackgroundAvailability';
import { nearbyDiscoveryService as discovery } from './NearbyDiscoveryService';
import { signalingManager as signals } from './CallSignaling';
import { callStateManager as calls } from './CallStateManager';
import { useAppStore } from '../store/appStore';

let placing = false;
type ConnectionStatus = (status: string) => void;

function transientConnectionError(error: unknown): boolean {
  const detail = error as { code?: unknown; message?: unknown; statusCode?: unknown } | null;
  // CONNECT_TIMEOUT is the SDK's own give-up, not a verdict on the peer. Every
  // one observed on hardware was followed one to two seconds later by Nearby's
  // own onConnectionResult(ERROR) — and every one recovered on the very next
  // attempt (round 9 at 23:35, round 10 at 00:49:46 and 00:51:27). It belongs in
  // the same bucket as the radio errors, not on its own path straight to the user.
  if (detail?.code === 'CONNECT_TIMEOUT') return true;
  return /\b(?:8007|8012)\b|STATUS_RADIO_ERROR|STATUS_ENDPOINT_IO_ERROR/.test(
    `${detail?.code || ''} ${detail?.statusCode || ''} ${detail?.message || error}`,
  ) || (detail?.code === 'CONNECT_FAILED' && /statusCode=ERROR\b|\b13:/.test(String(detail?.message || '')));
}

export function connectionErrorMessage(error: unknown): string {
  const detail = error as { code?: string; message?: string } | null;
  const message = detail?.message || String(error);
  // Deliberately before the transient branch: CONNECT_TIMEOUT is retryable now,
  // but once both attempts have failed the specific wording is the accurate one.
  if (detail?.code === 'CONNECT_TIMEOUT')
    return 'The other phone did not respond in time. Check that local calling is enabled on it, then try again.';
  if (transientConnectionError(error))
    return 'The wireless connection between the phones could not be established. Keep both phones nearby with Bluetooth, Wi-Fi and Location on, then try again.';
  if (detail?.code === 'BUSY')
    return 'Another connection is still in use. Wait for it to finish, then try again.';
  return message;
}

function requireIdle() {
  if (calls.getState() !== 'idle') throw new Error('Another call is already in progress.');
}

async function findEndpoint(uuid: string, fresh = false, onStatus?: ConnectionStatus): Promise<string> {
  // A delayed discovery event may have repopulated the failed endpoint while
  // its close was pending. A retry must still perform a fresh scan.
  if (fresh) discovery.forget(uuid);
  const cached = fresh ? null : discovery.getConnectionId(uuid);
  if (cached) return cached;
  return new Promise<string>((resolve, reject) => {
      let unsubscribe = () => {};
      let found = false;
      let settled = false;
      let refresh: ReturnType<typeof setTimeout> | undefined;
      let stage: ReturnType<typeof setTimeout> | undefined;
      let stageWide: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown, endpoint?: string) => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(refresh); clearTimeout(stage); clearTimeout(stageWide); unsubscribe();
        if (endpoint) resolve(endpoint); else reject(error);
      };
      // Staged, honest feedback instead of one blind 15-second wait: cache →
      // scan → "may be out of range" → actionable failure.
      const friend = useAppStore.getState().friends.find(f => f.uuid === uuid);
      const label = friend?.name || 'contact';
      const seen = friend?.lastSeen ? new Date(friend.lastSeen).getTime() : 0;
      const stale = seen > 0 && Date.now() - seen > 15 * 60_000;
      const timer = setTimeout(() => finish(new Error('Phone not found. Check that local calling, Bluetooth, Wi-Fi and Location are enabled on the other phone, then try again nearby.')), 15000);
      stage = setTimeout(() => { if (!settled) onStatus?.(`Scanning for ${label} nearby…`); }, 3000);
      stageWide = setTimeout(() => { if (!settled) onStatus?.(`${label} may be out of range — keep BigK open on their phone`); }, 8000);
      onStatus?.(stale ? `Looking for ${label} — not seen recently` : `Finding ${label}…`);
      unsubscribe = discovery.onFriendDiscovered(friend => {
        if (friend.uuid === uuid && friend.discovered) {
          found = true;
          finish(undefined, friend.connectionId);
        }
      });
      if (found) { unsubscribe(); return; }
      void discovery.startContinuousDiscovery(useAppStore.getState().friends).catch(error => finish(error));
      if (settled) return;
      // One bounded refresh within the existing deadline. Do not reset an
      // incoming/active call or repeatedly cycle the radios while idle.
      refresh = setTimeout(() => {
        void (async () => {
          if (settled) return;
          requireIdle();
          await discovery.stopDiscovery();
          if (settled) return;
          requireIdle();
          await discovery.startContinuousDiscovery(useAppStore.getState().friends);
        })().catch(error => finish(error));
      }, 6000);
  });
}

export async function connectPeer(uuid: string, onStatus?: ConnectionStatus): Promise<string> {
  requireIdle();
  await ensureNearbyAvailable();
  requireIdle();
  const existing = signals.getActiveConnection(uuid);
  if (existing) {
    const connected = await Nearby.isConnected(existing);
    requireIdle();
    if (connected) return existing;
    signals.clearActiveConnection(uuid, existing);
    discovery.forget(uuid, existing);
  }
  // Only retry transport setup, before a call-request is sent. Never redial a
  // ringing/accepted call or reset all endpoints to recover one failed peer.
  for (let attempt = 0; attempt < 2; attempt++) {
    requireIdle();
    onStatus?.(attempt ? 'Connection interrupted · finding contact again…' : 'Finding contact…');
    const endpoint = await findEndpoint(uuid, attempt > 0, onStatus);
    requireIdle();
    await discovery.stopDiscovery();
    requireIdle();
    onStatus?.(attempt ? 'Retrying connection once…' : 'Connecting…');
    try {
      if (!(await Nearby.connect(endpoint))) throw new Error('Connection was not established');
      requireIdle();
      signals.setActiveConnection(uuid, endpoint);
      return endpoint;
    } catch (error) {
      // An incoming call may have taken over while the outgoing request was
      // pending. Do not disconnect that call to service an outgoing retry.
      if (calls.getState() !== 'idle') throw error;
      signals.clearActiveConnection(uuid, endpoint);
      discovery.forget(uuid, endpoint);
      await discovery.stopDiscovery();
      requireIdle();
      // Await the scoped native close before starting a fresh scan. Android
      // radio teardown is asynchronous; this does not claim to reset hardware.
      try { await Nearby.closeConnection(endpoint); }
      catch (cleanupError) {
        console.warn('[OutgoingCall] Endpoint cleanup failed; not retrying', cleanupError);
        throw error;
      }
      requireIdle();
      if (attempt || !transientConnectionError(error)) throw error;
      console.warn('[OutgoingCall] Transient setup failure; retrying once', error);
    }
  }
  throw new Error('Connection was not established');
}

export async function placeCall(uuid: string, name: string, onStatus?: ConnectionStatus) {
  if (placing || calls.getState() !== 'idle') return;
  placing = true;
  // Overlap the microphone-eligible call service with the radio connect. The
  // call screen must not pay its foreground-service start latency between the
  // connect and the ring request; useNearbyCall still owns the final start
  // (near-instant once running) and every stop.
  void callNotifications?.startCallService?.(name)?.catch?.(() => {});
  try {
    const connectionId = await connectPeer(uuid, onStatus);
    if (calls.getState() !== 'idle') return;
    router.push({ pathname: '/call', params: { friendUUID: uuid, friendName: name, connectionId } });
  } catch (error: any) {
    console.warn('[OutgoingCall] Could not connect', error);
    if (calls.getState() === 'idle') {
      void callNotifications?.stopCallService?.()?.catch?.(() => {});
      Alert.alert('Could not connect', connectionErrorMessage(error));
    }
  } finally { placing = false; }
}

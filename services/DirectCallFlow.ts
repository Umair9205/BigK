/**
 * DirectCallFlow — the Nearby-free call bootstrap.
 *
 * Discovery: the friend's hashed DNS-SD tag resolves to a Wi-Fi Direct MAC.
 * Signaling: an authenticated JSON line protocol over the app-owned P2P control
 * socket (port 9875). Authentication: a symmetric token derived from the sorted
 * UUID pair plus the session id, so neither phone needs an out-of-band exchange.
 *
 * The legacy Nearby path (OutgoingCall.placeCall / CallSignaling / useNearbyCall)
 * stays compiled but is no longer called by the live call UI.
 */
import { Alert } from 'react-native';
import { router } from 'expo-router';
import wifi from '../modules/DirectWifi';
import { pairToken } from './P2pIdentity';
import { callStateManager as calls } from './CallStateManager';
import { callNotifications } from './BackgroundAvailability';
import { useAppStore } from '../store/appStore';

export type IncomingCall = {
  sessionId: string;
  from: string;
  callerName: string;
  localIp: string;
};

export type DialResult = { sessionId: string; localIp: string };

let placing = false;
let pending: IncomingCall | null = null;

export function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function setPendingIncoming(call: IncomingCall) { pending = call; }
export function peekPendingIncoming(): IncomingCall | null { return pending; }
export function clearPendingIncoming(sessionId?: string) {
  if (!sessionId || pending?.sessionId === sessionId) pending = null;
}

function callSignal(
  type: string, sessionId: string, from: string, to: string, data: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type, version: 2, sessionId, from, to, timestamp: Date.now(),
    data: { mediaEngine: 'webrtc-direct-v2', ...data },
  });
}

/** Wait for the native control socket to report its real P2P address. */
function waitForReady(sessionId: string, budgetMs = 45000) {
  let sub: { remove(): void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const promise = new Promise<string>((resolve, reject) => {
    const done = (error?: Error, ip?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub?.remove();
      if (error) reject(error); else resolve(ip || '');
    };
    sub = wifi.onReady(e => { if (e.sessionId === sessionId) done(undefined, e.localIp); });
    timer = setTimeout(() => done(new Error('The direct Wi-Fi link did not become ready')), budgetMs);
  });
  return {
    promise,
    cancel: () => { settled = true; clearTimeout(timer); sub?.remove(); },
  };
}

/**
 * Dial a saved friend over Wi-Fi Direct only: resolve the MAC, form the group,
 * open the authenticated socket, then announce the call on it.
 */
export async function dial(
  peerUuid: string, peerName: string, onStatus?: (status: string) => void,
): Promise<DialResult> {
  if (placing) throw new Error('Another call is already starting.');
  placing = true;
  try {
    const me = useAppStore.getState().myUUID;
    if (!me) throw new Error('Your identity is not ready yet. Open BigK once, then try again.');
    const sessionId = newSessionId();
    onStatus?.('Finding contact over Wi-Fi Direct…');
    const address = await wifi.getPeerP2pAddress(peerUuid, peerName);
    if (!address || address === '02:00:00:00:00:00') {
      throw new Error('The other phone was not found over Wi-Fi Direct. Keep both phones nearby with Wi-Fi on.');
    }
    onStatus?.('Connecting directly…');
    const ready = waitForReady(sessionId);
    try {
      await wifi.dialCall(sessionId, address, peerUuid);
      const localIp = await ready.promise;
      const token = pairToken(me, peerUuid, sessionId);
      const callerName = useAppStore.getState().myDeviceName || 'Contact';
      const sent = await wifi.send(sessionId, callSignal('call-request', sessionId, me, peerUuid, { callerName, token }));
      if (!sent) throw new Error('Could not announce the call on the direct link.');
      return { sessionId, localIp };
    } finally { ready.cancel(); }
  } finally { placing = false; }
}

/** The caller's Call button entry point. */
export async function placeDirectCall(uuid: string, name: string, onStatus?: (status: string) => void) {
  if (calls.getState() !== 'idle') return;
  void callNotifications?.startCallService?.(name)?.catch?.(() => {});
  try {
    const result = await dial(uuid, name, onStatus);
    if (calls.getState() !== 'idle') return;
    router.push({
      pathname: '/call',
      params: { friendUUID: uuid, friendName: name, sessionId: result.sessionId, localIp: result.localIp },
    });
  } catch (error: any) {
    console.warn('[DirectCallFlow] Could not dial', error?.message);
    if (calls.getState() === 'idle') {
      void callNotifications?.stopCallService?.()?.catch?.(() => {});
      Alert.alert('Could not connect', error?.message || 'The other phone could not be reached.');
    }
  }
}

/** Answer an incoming direct call over the already-open control socket. */
export async function accept(sessionId: string, callerUuid: string) {
  const me = useAppStore.getState().myUUID || '';
  const accepterName = useAppStore.getState().myDeviceName || 'Contact';
  clearPendingIncoming(sessionId);
  return wifi.send(sessionId, callSignal('call-accept', sessionId, me, callerUuid, { accepterName }));
}

export async function reject(sessionId: string, callerUuid: string) {
  const me = useAppStore.getState().myUUID || '';
  clearPendingIncoming(sessionId);
  try {
    await wifi.send(sessionId, callSignal('call-reject', sessionId, me, callerUuid));
  } catch { /* socket may already be gone */ }
  await wifi.stop(sessionId).catch(() => {});
}

export async function end(sessionId: string, peerUuid: string) {
  const me = useAppStore.getState().myUUID || '';
  clearPendingIncoming(sessionId);
  try {
    await wifi.send(sessionId, callSignal('call-end', sessionId, me, peerUuid));
  } catch { /* socket may already be gone */ }
  await wifi.stop(sessionId).catch(() => {});
}

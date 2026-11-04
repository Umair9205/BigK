import { NativeEventEmitter, NativeModules } from 'react-native';
const native = NativeModules.DirectWifiModule;
const events = native ? new NativeEventEmitter(native) : null;
/** token authenticates the control socket; peerP2pAddress is this phone's own Wi-Fi Direct discovery result for the peer. */
export interface DirectCredentials { token: string; peerP2pAddress: string }
function module() { if (!native) throw new Error('Install the new APK on both phones'); return native; }
export default {
  prepareGroup: (): Promise<{ token: string }> => module().prepareCallGroup(),
  // The peer's address, from Wi-Fi Direct discovery. This phone cannot read
  // its own — every local source answers 02:00:00:00:00:00 — but
  // requestPeers() returns the OTHER phone's, which is what connect() needs.
  getPeerP2pAddress: (expected: string[]): Promise<string> => module().getPeerP2pAddress(expected),
  // Ring-time head start for that discovery. Purely opportunistic: never opens
  // the Wi-Fi panel, never rejects, and the handoff kicks again anyway.
  warmUpPeerDiscovery: (): Promise<void> =>
    native ? native.warmUpPeerDiscovery().catch(() => {}) : Promise.resolve(),
  // Two-sided framework connect: both phones address each other with
  // complementary GO intents; roles are assigned from the framework readback.
  connectPeer: (id: string, peerAddress: string, isCaller: boolean, token: string): Promise<boolean> =>
    module().connectCallPeer(id, peerAddress, isCaller, token),
  send: (id: string, data: string): Promise<boolean> => module().sendCallSignal(id, data),
  stop: (id: string): Promise<boolean> => module().stopCall(id),
  startAudio: (id: string): Promise<boolean> => module().startAudio(id),
  speaker: (id: string, on: boolean) => module().setSpeaker(id, on),
  onReady: (fn: (e: {sessionId: string; localIp: string}) => void) => events!.addListener('onDirectReady', fn),
  onSignal: (fn: (e: {sessionId: string; data: string}) => void) => events!.addListener('onDirectSignal', fn),
  onError: (fn: (e: {sessionId: string; error: string}) => void) => events!.addListener('onDirectError', fn),
};

import { NativeEventEmitter, NativeModules } from 'react-native';
import { useAppStore } from '../store/appStore';
import { expectedPeerNames, p2pTag, validP2pMac } from '../services/P2pIdentity';
const native = NativeModules.DirectWifiModule;
const events = native ? new NativeEventEmitter(native) : null;
/** token authenticates the control socket; peerP2pAddress is this phone's own Wi-Fi Direct discovery result for the peer. */
export interface DirectCredentials { token: string; peerP2pAddress: string }
function module() { if (!native) throw new Error('Install the new APK on both phones'); return native; }
export default {
  prepareGroup: (): Promise<{ token: string }> => module().prepareCallGroup(),
  // Publish this phone's stable P2P name so the other side can identify us by
  // tag instead of guessing "the single available device". Safe to call before
  // Wi-Fi is up: native remembers the tag and applies it once the radio is on.
  setDeviceTag: (uuid: string): Promise<boolean> =>
    native ? native.setDeviceTag(p2pTag(uuid)).catch(() => false) : Promise.resolve(false),
  // The peer's address, from Wi-Fi Direct discovery. This phone cannot read
  // its own — every local source answers 02:00:00:00:00:00 — but
  // requestPeers() returns the OTHER phone's, which is what connect() needs.
  //
  // MAC-keyed path (step 4): the friend's last resolved P2P MAC is persisted
  // and offered as a hint, so a repeat call can recognise the peer immediately
  // instead of waiting for a cold scan. The resolved address is written back
  // for the next call; the nearby bootstrap remains the stale-MAC fallback.
  getPeerP2pAddress: async (uuid: string, deviceName?: string): Promise<string> => {
    const store = useAppStore.getState();
    const cached = validP2pMac(store.getCurrentMac(uuid));
    const address = await module().getPeerP2pAddress(expectedPeerNames(uuid, deviceName), cached);
    const valid = validP2pMac(address);
    if (valid) store.updateFriendMac(uuid, valid);
    return address;
  },
  // Ring-time head start for that discovery. Purely opportunistic: never opens
  // the Wi-Fi panel, never rejects, and the handoff kicks again anyway.
  warmUpPeerDiscovery: (): Promise<void> =>
    native ? native.warmUpPeerDiscovery().catch(() => {}) : Promise.resolve(),
  // Two-sided framework connect: both phones address each other with
  // complementary GO intents; roles are assigned from the framework readback.
  connectPeer: (id: string, peerAddress: string, isCaller: boolean, token: string): Promise<boolean> =>
    module().connectCallPeer(id, peerAddress, isCaller, token),
  // Always-on callee side: publish the identity tag, watch for a saved friend's
  // "-CALL" beacon, and accept the authenticated control socket. No Nearby.
  startCallListener: (uuid: string, friendUuids: string[]): Promise<boolean> =>
    module().startCallListener(uuid, friendUuids.join(',')),
  stopCallListener: (): Promise<boolean> => (native ? native.stopCallListener() : Promise.resolve(false)),
  // Caller side of the Nearby-free bootstrap: discover the peer's MAC first
  // (getPeerP2pAddress), then form the group and open the authenticated socket.
  dialCall: (id: string, peerAddress: string, peerUuid: string): Promise<boolean> =>
    module().dialCall(id, peerAddress, peerUuid),
  send: (id: string, data: string): Promise<boolean> => module().sendCallSignal(id, data),
  stop: (id: string): Promise<boolean> => module().stopCall(id),
  startAudio: (id: string): Promise<boolean> => module().startAudio(id),
  speaker: (id: string, on: boolean) => module().setSpeaker(id, on),
  onReady: (fn: (e: {sessionId: string; localIp: string}) => void) => events!.addListener('onDirectReady', fn),
  onSignal: (fn: (e: {sessionId: string; data: string}) => void) => events!.addListener('onDirectSignal', fn),
  onError: (fn: (e: {sessionId: string; error: string}) => void) => events!.addListener('onDirectError', fn),
  onIncomingCall: (fn: (e: {sessionId: string; from: string; callerName: string; localIp: string}) => void) =>
    events!.addListener('onIncomingCall', fn),
};

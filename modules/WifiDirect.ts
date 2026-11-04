import { NativeEventEmitter, NativeModules } from 'react-native';

const Native = NativeModules.WifiDirectModule ?? new Proxy({}, {
  get() { throw new Error('WifiDirectModule not linked. Run: expo run:android'); }
});
const emitter = new NativeEventEmitter(Native);

export interface WifiDirectPeer { name: string; address: string; status: number; }
export interface GroupCredentials { ssid: string; passphrase: string; ownerAddress: string; }
export interface GroupFormedEvent { isGroupOwner: boolean; groupOwnerAddress: string; }

const WifiDirect = {
  discoverPeers:   (): Promise<boolean>           => Native.discoverPeers(),
  stopDiscovery:   (): Promise<boolean>           => Native.stopDiscovery(),
  createGroup:     (): Promise<GroupCredentials>  => Native.createGroup(),
  connectToPeer:   (addr: string): Promise<boolean> => Native.connectToPeer(addr),
  removeGroup:     (): Promise<boolean>           => Native.removeGroup(),
  sendSignal:      (msg: string): Promise<boolean> => Native.sendSignal(msg),

  onStateChanged:     (cb: (e:{enabled:boolean})=>void)         => emitter.addListener('onWifiDirectStateChanged', cb),
  onPeersFound:       (cb: (e:{peers:WifiDirectPeer[]})=>void)  => emitter.addListener('onPeersFound', cb),
  onGroupFormed:      (cb: (e:GroupFormedEvent)=>void)          => emitter.addListener('onGroupFormed', cb),
  onGroupRemoved:     (cb: (e:any)=>void)                       => emitter.addListener('onGroupRemoved', cb),
  onPeerDisconnected: (cb: (e:any)=>void)                       => emitter.addListener('onPeerDisconnected', cb),
  onConnectionFailed: (cb: (e:{error:string})=>void)            => emitter.addListener('onConnectionFailed', cb),
  onSignalingReady:   (cb: (e:{isServer:boolean})=>void)        => emitter.addListener('onSignalingSocketReady', cb),
  onSignalReceived:   (cb: (e:{data:string})=>void)             => emitter.addListener('onSignalReceived', cb),

  removeAllListeners: () => {
    ['onWifiDirectStateChanged','onPeersFound','onGroupFormed','onGroupRemoved',
     'onPeerDisconnected','onConnectionFailed','onSignalingSocketReady','onSignalReceived']
      .forEach(e => emitter.removeAllListeners(e));
  },
};

export default WifiDirect;
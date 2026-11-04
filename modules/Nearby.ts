import { NativeEventEmitter, NativeModules } from 'react-native';

const NearbyModule = NativeModules.NearbyModule;

if (!NearbyModule) {
  throw new Error('NearbyModule is not available');
}

const nearbyEmitter = new NativeEventEmitter(NearbyModule);

export interface NearbyPeer {
  connectionId: string;
  peerName: string;
  peerUUID?: string;
}

export interface NearbyConnection {
  connectionId: string;
  peerName: string;
}

type Subscription = { remove: () => void };

const Nearby = {
  isLocationEnabled: (): Promise<boolean> => NearbyModule.isLocationEnabled(),
  openLocationSettings: (): Promise<boolean> => NearbyModule.openLocationSettings(),
  configureAvailability: (uuid: string, name: string, contacts: {uuid: string; name: string}[], audible: boolean): Promise<boolean> =>
    NearbyModule.configureAvailability(uuid, name, JSON.stringify(contacts), audible),
  pendingIncoming: (): Promise<{connectionId: string; data: string} | null> => NearbyModule.pendingIncoming(),
  retainConnection: (id: string): void => NearbyModule.retainConnection(id),
  releaseForDirectCall: (id: string): Promise<boolean> => NearbyModule.releaseForDirectCall(id),
  resumeAfterDirectCall: (id: string): Promise<boolean> => NearbyModule.resumeAfterDirectCall(id),
  isConnected: (id: string): Promise<boolean> => NearbyModule.isConnected(id),
  connect: (connectionId: string): Promise<boolean> => NearbyModule.connect(connectionId),
  onBandwidthChanged: (callback: (event: { connectionId: string; quality: number }) => void): Subscription =>
    nearbyEmitter.addListener('onBandwidthChanged', callback),
  /**
   * Start advertising this device on Nearby Connections
   */
  startAdvertising: (myUUID: string, myName: string): Promise<boolean> => {
    return NearbyModule.startAdvertising(myUUID, myName);
  },

  /**
   * Stop advertising
   */
  stopAdvertising: (): Promise<boolean> => {
    return NearbyModule.stopAdvertising();
  },

  /**
   * Start discovering peers with target UIDs
   */
  startDiscovery: (targetUIDs: string[]): Promise<boolean> => {
    return NearbyModule.startDiscovery(targetUIDs);
  },

  /**
   * Stop discovery
   */
  stopDiscovery: (): Promise<boolean> => {
    return NearbyModule.stopDiscovery();
  },

  /**
   * Send data to a peer
   */
  sendData: (connectionId: string, data: string): Promise<boolean> => {
    return NearbyModule.sendData(connectionId, data);
  },
  // Resolves only after Nearby reports SUCCESS for this payload, not just enqueueing.
  sendDataConfirmed: (connectionId: string, data: string): Promise<boolean> =>
    NearbyModule.sendDataConfirmed(connectionId, data),

  /**
   * Close connection to a peer
   */
  closeConnection: (connectionId: string): Promise<boolean> => {
    return NearbyModule.closeConnection(connectionId);
  },

  // ============= Events =============

  /**
   * Listen for peer discovery
   */
  onPeerDiscovered: (callback: (peer: NearbyPeer) => void): Subscription => {
    return {
      remove: nearbyEmitter.addListener('onPeerDiscovered', callback).remove,
    };
  },

  /**
   * Listen for peer lost
   */
  onPeerLost: (callback: (event: { connectionId: string }) => void): Subscription => {
    return {
      remove: nearbyEmitter.addListener('onPeerLost', callback).remove,
    };
  },

  /**
   * Listen for connection established
   */
  onConnectionEstablished: (callback: (event: { connectionId: string }) => void): Subscription => {
    return {
      remove: nearbyEmitter.addListener('onConnectionEstablished', callback).remove,
    };
  },

  /**
   * Listen for data received
   */
  onDataReceived: (callback: (event: { connectionId: string; data: string }) => void): Subscription => {
    return {
      remove: nearbyEmitter.addListener('onDataReceived', callback).remove,
    };
  },

  /**
   * Listen for connection closed
   */
  onConnectionClosed: (callback: (event: { connectionId: string; reason: string }) => void): Subscription => {
    return {
      remove: nearbyEmitter.addListener('onConnectionClosed', callback).remove,
    };
  },

  /**
   * Listen for discovery errors
   */
  onDiscoveryError: (callback: (event: { error: string }) => void): Subscription => {
    return {
      remove: nearbyEmitter.addListener('onDiscoveryError', callback).remove,
    };
  },
};

export default Nearby;

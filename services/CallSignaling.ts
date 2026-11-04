/**
 * CallSignaling — call-level signals over Nearby Connections
 * Nearby bootstraps calls and the coordinated direct-network handoff.
 * Current call audio uses WebRTC over the app-owned direct network;
 * legacy handshake/audio-frame methods remain for compatibility with tests.
 */
import Nearby from '../modules/Nearby';

export type SignalType =
  | 'call-request'
  | 'direct-config'
  | 'direct-ready'
  | 'call-accept'
  | 'call-reject'
  | 'call-end'
  | 'handshake'
  | 'handshake-ack'
  | 'audio-frame'
  | 'error'
  | 'keep-alive'
  | 'sdp-offer'
  | 'sdp-answer'
  | 'ice-candidate';

export interface Signal {
  type: SignalType;
  version: number;
  sessionId: string;
  from: string;
  to: string;
  timestamp: number;
  data?: {
    audioCodec?: string;
    sampleRate?: number;
    frameSize?: number;
    jitterBufferMs?: number;
    keyMaterial?: string;
    errorCode?: number;
    errorMessage?: string;
    callerName?: string;
    sdp?: any;
    candidate?: any;
    mediaEngine?: string;
    /**
     * direct-config: control token + the address THIS side discovered for the
     * peer over Wi-Fi Direct. Each phone discovers independently and dials what
     * it found; the carried value is a cross-check, never the one connected to
     * (neither phone can read its own address — see DirectWifiModule.getPeerP2pAddress).
     */
    direct?: { peerP2pAddress: string; token: string };
    /** direct-ready: the address THIS side discovered for the peer (cross-check). */
    peerP2pAddress?: string;
  };
  signature: string; // HMAC-SHA256
}

type Handler = (payload: { signal: Signal; connectionId?: string }) => void;

class CallSignalingManager {
  private myUUID = '';
  private listeners = new Map<string, Set<Handler>>();
  private nearbySubscriptions: { remove: () => void }[] = [];
  private activeConnections = new Map<string, string>(); // peerUUID -> connectionId

  constructor() {
    this.setupNearbyListeners();
  }

  setMyUUID(uuid: string) {
    this.myUUID = uuid;
  }

  /**
   * Store active connection for a peer
   */
  setActiveConnection(peerUUID: string, connectionId: string) {
    this.activeConnections.set(peerUUID, connectionId);
  }

  /**
   * Get active connection for a peer
   */
  getActiveConnection(peerUUID: string): string | undefined {
    return this.activeConnections.get(peerUUID);
  }

  /** Forget only the failed connection, not a replacement learned meanwhile. */
  clearActiveConnection(peerUUID: string, expectedConnectionId?: string) {
    if (expectedConnectionId && this.activeConnections.get(peerUUID) !== expectedConnectionId) return;
    this.activeConnections.delete(peerUUID);
  }

  /**
   * Event subscription
   */
  on(event: string, handler: Handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: Handler) {
    this.listeners.get(event)?.delete(handler);
  }

  /**
   * Send signal over active connection
   */
  async send(signal: Signal): Promise<boolean> {
    const peerUUID = signal.to;
    const connectionId = this.activeConnections.get(peerUUID);

    if (!connectionId) {
      console.error('No active connection for peer:', peerUUID);
      return false;
    }

    try {
      // Simple timestamp-based validation
      signal.signature = `${signal.from}:${signal.timestamp}`;

      const json = JSON.stringify(signal);
      // Handoff acknowledgements must reach the peer before the sender
      // releases Nearby, not merely be queued locally for transmission.
      const sent = signal.type === 'direct-ready'
        ? await Nearby.sendDataConfirmed(connectionId, json)
        : await Nearby.sendData(connectionId, json);
      if (!sent) return false;

      console.log(`Signal sent: ${signal.type} to ${peerUUID}`);
      return true;
    } catch (e) {
      console.error('Send failed:', e);
      return false;
    }
  }

  // ============= Call Methods =============

  sendCallRequest(peerUUID: string, sessionId: string, callerName: string) {
    return this.send({
      type: 'call-request',
      version: 1,
      sessionId,
      from: this.myUUID,
      to: peerUUID,
      timestamp: Date.now(),
      data: { callerName, mediaEngine: 'webrtc-direct-v2' },
      signature: '', // Will be set in send()
    });
  }

  sendCallAccept(peerUUID: string, sessionId: string, myName: string) {
    return this.send({
      type: 'call-accept',
      version: 1,
      sessionId,
      from: this.myUUID,
      to: peerUUID,
      timestamp: Date.now(),
      data: { callerName: myName, mediaEngine: 'webrtc-direct-v2' },
      signature: '',
    });
  }

  sendCallReject(peerUUID: string, sessionId: string) {
    return this.send({
      type: 'call-reject',
      version: 1,
      sessionId,
      from: this.myUUID,
      to: peerUUID,
      timestamp: Date.now(),
      signature: '',
    });
  }
  sendDirectConfig(peerUUID: string, sessionId: string, direct: {peerP2pAddress: string; token: string}) {
    return this.send({ type: 'direct-config', version: 2, sessionId, from: this.myUUID,
      to: peerUUID, timestamp: Date.now(), data: {direct, mediaEngine: 'webrtc-direct-v2'}, signature: '' });
  }

  sendDirectReady(peerUUID: string, sessionId: string, peerP2pAddress: string) {
    return this.send({ type: 'direct-ready', version: 2, sessionId, from: this.myUUID,
      to: peerUUID, timestamp: Date.now(), data: {peerP2pAddress, mediaEngine: 'webrtc-direct-v2'}, signature: '' });
  }

  sendCallEnd(peerUUID: string, sessionId: string) {
    return this.send({
      type: 'call-end',
      version: 1,
      sessionId,
      from: this.myUUID,
      to: peerUUID,
      timestamp: Date.now(),
      signature: '',
    });
  }

  // ============= Handshake Methods =============

  sendHandshake(peerUUID: string, sessionId: string, codec: string = 'opus') {
    return this.send({
      type: 'handshake',
      version: 1,
      sessionId,
      from: this.myUUID,
      to: peerUUID,
      timestamp: Date.now(),
      data: {
        audioCodec: codec,
        sampleRate: 16000,
        frameSize: 320,
        jitterBufferMs: 60,
      },
      signature: '',
    });
  }

  sendHandshakeAck(peerUUID: string, sessionId: string) {
    return this.send({
      type: 'handshake-ack',
      version: 1,
      sessionId,
      from: this.myUUID,
      to: peerUUID,
      timestamp: Date.now(),
      data: { audioCodec: 'opus' },
      signature: '',
    });
  }

  sendError(peerUUID: string, sessionId: string, errorCode: number, errorMessage: string) {
    return this.send({
      type: 'error',
      version: 1,
      sessionId,
      from: this.myUUID,
      to: peerUUID,
      timestamp: Date.now(),
      data: { errorCode, errorMessage },
      signature: '',
    });
  }

  /**
   * Send WebRTC signals (SDP, ICE) directly through active connection
   */
  async sendWebRTCSignal(peerUUID: string, signal: Signal): Promise<boolean> {
    // ⚠️ DEPRECATED: WebRTC no longer used
    // Audio streams directly via Nearby using Opus-compressed frames
    console.warn('[CallSignaling] ❌ WebRTC signals deprecated - use audioStreamingService instead');
    return false;
  }

  // ============= Audio Frame Pass-Through =============

  /**
   * Send Opus-encoded audio frame directly through active connection
   */
  async sendAudioFrame(peerUUID: string, frameData: string): Promise<boolean> {
    const connectionId = this.activeConnections.get(peerUUID);
    if (!connectionId) {
      console.error('[CallSignaling] No active connection for audio frame:', peerUUID);
      return false;
    }

    try {
      return await Nearby.sendData(connectionId, frameData);
    } catch (e) {
      // Count failures in the periodic audio metrics, not once per packet.
      return false;
    }
  }

  // ============= Cleanup =============

  destroy() {
    this.nearbySubscriptions.forEach((sub) => sub.remove());
    this.nearbySubscriptions = [];
    this.listeners.clear();
    this.activeConnections.clear();
  }

  // ============= Private =============

  private setupNearbyListeners() {
    this.nearbySubscriptions.push(
      Nearby.onConnectionClosed(({ connectionId }) => {
        this.activeConnections.forEach((endpoint, peer) => {
          if (endpoint === connectionId) this.activeConnections.delete(peer);
        });
      }),
      Nearby.onBandwidthChanged(({ connectionId, quality }) => {
        console.log('[CallMetrics] Nearby bandwidth', { connectionId, quality, medium: 'not exposed by API' });
      }),
    );
    this.nearbySubscriptions.push(
      Nearby.onDataReceived((event) => {
        try {
          const signal: Signal = JSON.parse(event.data);
          if (!signal.type) return;

          // Auto-register incoming connection for peer (enables bidirectional send)
          if (signal.type !== 'audio-frame' && signal.from && event.connectionId) {
            this.activeConnections.set(signal.from, event.connectionId);
            console.log(`[CallSignaling] ✅ Auto-registered connection for ${signal.from}: ${event.connectionId}`);
          }

          if (signal.type !== 'audio-frame')
            console.log(`[CallSignaling] Signal received: ${signal.type}`);
          this.emit(signal.type, { signal, connectionId: event.connectionId });
        } catch (e) {
          console.error('[CallSignaling] ❌ Signal parse error:', e);
        }
      })
    );
  }

  private emit(event: string, payload: { signal: Signal; connectionId?: string }) {
    this.listeners.get(event)?.forEach((h) => {
      try {
        h(payload);
      } catch (e) {
        console.error('Listener error:', e);
      }
    });
  }
}

export const signalingManager = new CallSignalingManager();
export default signalingManager;

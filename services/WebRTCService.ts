/**
 * ❌ DEPRECATED: WebRTCService is no longer used
 *
 * Audio now streams directly via Nearby Connections using Opus-compressed PCM frames.
 * This file is kept for reference only and should NOT be imported.
 *
 * Migration:
 * - Audio capture: see AudioStreamingService.ts
 * - Audio playback: see AudioPlaybackService.ts
 * - Call flow: see app/call.tsx and app/incoming-call.tsx
 *
 * DO NOT USE - This entire module is deprecated.
 */
import { MediaStream, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription, mediaDevices } from 'react-native-webrtc';
import AudioStream from '../modules/AudioStream';
import { signalingManager } from './CallSignaling';

export type CallRole = 'caller' | 'callee';
export interface WebRTCCallbacks {
  onConnected:    () => void;
  onDisconnected: () => void;
  onError:        (err: string) => void;
}

// react-native-webrtc has broken TS types for addEventListener due to event-target-shim
// module resolution with RN 0.73+ bundler mode. Cast to any — works fine at runtime.
type AnyPC = any;

class WebRTCService {
  private pc:           RTCPeerConnection | null = null;
  private localStream:  MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private signalSub:    any = null;
  private callbacks:    WebRTCCallbacks | null = null;
  private speakerOn:    boolean = false;
  private peerUUID:     string = ''; // Track peer for signal routing
  private sessionId:    string = '';
  private isCallActive: boolean = false; // Prevent simultaneous calls
  private sdpOfferHandler:   ((p: any) => void) | null = null; // Track handlers for cleanup
  private sdpAnswerHandler:  ((p: any) => void) | null = null;
  private iceCandidateHandler: ((p: any) => void) | null = null;

  // Audio quality bitrate map
  private readonly bitrateMap = { low: 8000, medium: 16000, high: 32000 };

  setCallContext(peerUUID: string, sessionId: string) {
    this.peerUUID = peerUUID;
    this.sessionId = sessionId;
    console.log('[WebRTC] Call context set:', peerUUID, sessionId);
  }

  async startCall(role: CallRole, callbacks: WebRTCCallbacks, speakerDefault = false, quality: 'low'|'medium'|'high' = 'high') {
    console.log('[WebRTC] Starting call as', role, 'with peer:', this.peerUUID);

    if (!this.peerUUID) {
      callbacks.onError('Peer UUID not set - call setCallContext first');
      return;
    }

    if (this.isCallActive) {
      console.warn('[WebRTC] Call already active, ignoring duplicate startCall');
      return;
    }

    this.isCallActive = true;
    this.callbacks = callbacks;
    this.speakerOn = speakerDefault;

    try {
      await this.initPC();
      await this.addLocalAudio(quality);

      // Remove old listeners if they exist
      if (this.sdpOfferHandler) signalingManager.off('sdp-offer', this.sdpOfferHandler);
      if (this.sdpAnswerHandler) signalingManager.off('sdp-answer', this.sdpAnswerHandler);
      if (this.iceCandidateHandler) signalingManager.off('ice-candidate', this.iceCandidateHandler);

      // Listen for WebRTC signals from peer (with session filtering)
      this.sdpOfferHandler = ({ signal }: any) => {
        console.log('[WebRTC] SDP offer signal received', {
          from: signal.from,
          expectedPeer: this.peerUUID,
          sessionId: signal.sessionId,
          expectedSessionId: this.sessionId,
          matches: signal.from === this.peerUUID && signal.sessionId === this.sessionId,
        });
        if (signal.from === this.peerUUID && signal.sessionId === this.sessionId) {
          console.log('[WebRTC] Received SDP offer from', signal.from);
          this.handleOffer(signal.data?.sdp);
        }
      };

      this.sdpAnswerHandler = ({ signal }: any) => {
        if (signal.from === this.peerUUID && signal.sessionId === this.sessionId) {
          console.log('[WebRTC] Received SDP answer from', signal.from);
          this.handleAnswer(signal.data?.sdp);
        }
      };

      this.iceCandidateHandler = ({ signal }: any) => {
        console.log('[WebRTC] ICE candidate signal received', {
          from: signal.from,
          expectedPeer: this.peerUUID,
          sessionId: signal.sessionId,
          expectedSessionId: this.sessionId,
          matches: signal.from === this.peerUUID && signal.sessionId === this.sessionId,
          hasCandidate: !!signal.data?.candidate,
        });
        if (signal.from === this.peerUUID && signal.sessionId === this.sessionId && signal.data?.candidate) {
          console.log('[WebRTC] Adding ICE candidate');
          this.handleIce(signal.data.candidate);
        }
      };

      signalingManager.on('sdp-offer', this.sdpOfferHandler);
      signalingManager.on('sdp-answer', this.sdpAnswerHandler);
      signalingManager.on('ice-candidate', this.iceCandidateHandler);

      if (role === 'caller') {
        await this.sendOffer();
      }

      // No timeout - connection state changes handled by listener
    } catch (e: any) {
      console.error('[WebRTC] Start failed:', e);
      this.isCallActive = false;
      callbacks.onError(`WebRTC startCall failed: ${e?.message ?? e}`);
    }
  }

  setMuted(muted: boolean) {
    this.localStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
  }

  setSpeaker(on: boolean) {
    this.speakerOn = on;
    AudioStream.setSpeakerOn(on);
  }


  async stop() {
    // Remove signal handlers
    if (this.sdpOfferHandler) signalingManager.off('sdp-offer', this.sdpOfferHandler);
    if (this.sdpAnswerHandler) signalingManager.off('sdp-answer', this.sdpAnswerHandler);
    if (this.iceCandidateHandler) signalingManager.off('ice-candidate', this.iceCandidateHandler);

    this.signalSub?.remove();
    this.signalSub = null;
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.remoteStream = null;


    this.pc?.close();
    this.pc = null;
    this.callbacks = null;
    this.peerUUID = '';
    this.sessionId = '';
    this.isCallActive = false;
    this.sdpOfferHandler = null;
    this.sdpAnswerHandler = null;
    this.iceCandidateHandler = null;
    AudioStream.setSpeakerOn(false); // restore earpiece on call end
  }

  private async initPC() {
    this.pc = new RTCPeerConnection({ iceServers: [] });
    const pc = this.pc as AnyPC;

    pc.addEventListener('icecandidate', (e: any) => {
      if (!e.candidate) {
        console.log('[WebRTC] ICE gathering complete (null candidate received)');
        return;
      }
      console.log('[WebRTC] ICE candidate generated:', {
        candidate: e.candidate.candidate.substring(0, 60),
        ip: e.candidate.candidate.match(/[\d.]+|[\da-f:]+/)?.[0] || 'unknown',
      });
      signalingManager.sendWebRTCSignal(this.peerUUID, {
        type: 'ice-candidate',
        version: 1,
        sessionId: this.sessionId,
        from: '', // Will be set by signaling manager
        to: this.peerUUID,
        timestamp: Date.now(),
        data: { candidate: e.candidate.toJSON() },
        signature: '',
      }).catch(err => console.warn('[WebRTC] ICE send failed:', err));
    });

    pc.addEventListener('connectionstatechange', () => {
      const state = (this.pc as AnyPC)?.connectionState;
      console.log('[WebRTC] Connection state:', state);
      if (state === 'connected') {
        AudioStream.setSpeakerOn(this.speakerOn);
        this.callbacks?.onConnected();
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.callbacks?.onDisconnected();
      }
    });

    pc.addEventListener('icegatheringstatechange', () => {
      const gatherState = (this.pc as AnyPC)?.iceGatheringState;
      console.log('[WebRTC] ICE gathering state:', gatherState);
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      const iceState = (this.pc as AnyPC)?.iceConnectionState;
      console.log('[WebRTC] ICE connection state changed:', iceState);
      if (iceState === 'failed') {
        console.error('[WebRTC] ⚠️ ICE FAILED - no working candidate pair found');
        this.callbacks?.onError('ICE connection failed - unable to establish peer connection');
      }
    });

    // Remote audio track arrives here — react-native-webrtc plays it automatically
    pc.addEventListener('track', (e: any) => {
      console.log('Remote track received');
      if (!this.remoteStream) this.remoteStream = new MediaStream();
      this.remoteStream!.addTrack(e.track);
    });
  }

  private async addLocalAudio(quality: 'low'|'medium'|'high') {
    try {
      this.localStream = await mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: this.bitrateMap[quality],
        } as any,
        video: false,
      } as any);
      this.localStream.getTracks().forEach(t => (this.pc as AnyPC).addTrack(t, this.localStream!));
      console.log('[WebRTC] Local audio added');
    } catch (e: any) {
      console.error('[WebRTC] getUserMedia failed:', e);
      throw new Error(`Audio capture failed: ${e?.message}`);
    }
  }

  private async sendOffer() {
    if (!this.pc) return;
    try {
      const offer = await this.pc.createOffer({ offerToReceiveAudio: true } as any);
      await this.pc.setLocalDescription(offer);
      console.log('[WebRTC] Sending SDP offer to', this.peerUUID, 'sessionId:', this.sessionId);
      const success = await signalingManager.sendWebRTCSignal(this.peerUUID, {
        type: 'sdp-offer',
        version: 1,
        sessionId: this.sessionId,
        from: '',
        to: this.peerUUID,
        timestamp: Date.now(),
        data: { sdp: offer },
        signature: '',
      });
      if (!success) {
        console.error('[WebRTC] Failed to send SDP offer - no active connection for peer');
        this.callbacks?.onError('Failed to send offer to peer');
      }
    } catch (e: any) {
      console.error('[WebRTC] sendOffer failed:', e);
      this.callbacks?.onError(`Offer creation failed: ${e?.message}`);
    }
  }

  private async handleOffer(sdp: any) {
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      console.log('[WebRTC] Sending SDP answer');
      await signalingManager.sendWebRTCSignal(this.peerUUID, {
        type: 'sdp-answer',
        version: 1,
        sessionId: this.sessionId,
        from: '',
        to: this.peerUUID,
        timestamp: Date.now(),
        data: { sdp: answer },
        signature: '',
      });
      // DataChannel will be received via ondatachannel event
    } catch (e: any) {
      console.error('[WebRTC] handleOffer failed:', e);
      this.callbacks?.onError(`Answer creation failed: ${e?.message}`);
    }
  }

  private async handleAnswer(sdp: any) {
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      console.log('[WebRTC] Remote SDP set - audio tracks will flow automatically');
    } catch (e: any) {
      console.error('[WebRTC] handleAnswer failed:', e);
      this.callbacks?.onError(`Answer handling failed: ${e?.message}`);
    }
  }

  private async handleIce(candidate: any) {
    if (!this.pc) {
      console.warn('[WebRTC] No PeerConnection for ICE candidate');
      return;
    }
    try {
      console.log('[WebRTC] Adding ICE candidate to PC:', candidate.candidate.substring(0, 50));
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('[WebRTC] ✅ ICE candidate added successfully');
    } catch (e: any) {
      console.warn('[WebRTC] ⚠️ addIceCandidate failed:', e?.message);
      // Don't fail hard - ICE is resilient, connection can still work
    }
  }

  private handleSignal(raw: string) {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'sdp-offer':     this.handleOffer(msg.sdp); break;
        case 'sdp-answer':    this.handleAnswer(msg.sdp); break;
        case 'ice-candidate': this.handleIce(msg.candidate); break;
      }
    } catch { /* non-WebRTC signal, ignore */ }
  }

}

export const webRTCService = new WebRTCService();
export default webRTCService;
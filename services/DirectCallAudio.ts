import { mediaDevices, RTCPeerConnection, MediaStream } from 'react-native-webrtc';
import wifi, { DirectCredentials } from '../modules/DirectWifi';
import Nearby from '../modules/Nearby';
import { signalingManager } from './CallSignaling';
import { nearbyDiscoveryService } from './NearbyDiscoveryService';

type Callbacks = { onError: (message: string) => void; onStatus: (message: string) => void };
type Run = {
  id: string; peer: string; peerDeviceName?: string; role: 'caller' | 'callee'; active: boolean; connected: boolean;
  socketReady: boolean; mediaReady: boolean; peerReady: boolean; offering: boolean; initialOfferStarted: boolean; localIp: string;
  pc?: RTCPeerConnection; stream?: MediaStream; media?: Promise<MediaStream>; pending: any[]; ice: any[];
  chain: Promise<void>; subscriptions: {remove(): void}[]; callbacks: Callbacks;
  resolve: () => void; reject: (error: Error) => void; started: Promise<void>;
  timeout?: ReturnType<typeof setTimeout>; recovery?: ReturnType<typeof setTimeout>;
  stats?: ReturnType<typeof setInterval>; sampling: boolean; received: number; lastReceived: number;
  restarts: number; peerMuted: boolean;
  gathered: number; accepted: number; remoteIce: number; appliedIce: number; lastRoute: string;
  handoff?: Promise<DirectCredentials>; cancelSetup?: () => void;
};

// Host candidates are restricted to the interface used by the authenticated P2P socket.
// A campus/router Wi-Fi connection must not accidentally make an offline test pass.
export function directCandidate(candidate: string, localIp: string) {
  const fields = candidate.trim().split(/\s+/);
  return fields[2]?.toLowerCase() === 'udp' && fields[4] === localIp && fields[7] === 'host';
}
export function directSdp(sdp: string, localIp: string) {
  return sdp.split('\r\n').filter(line => !line.startsWith('a=candidate:') || directCandidate(line.slice(2), localIp)).join('\r\n');
}

// Log only routing metadata, never SDP, ICE passwords or Wi-Fi credentials.
export function selectedRoute(stats: Map<string, any>) {
  let pair: any;
  stats.forEach(s => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
  });
  if (!pair) stats.forEach(s => { if (s.type === 'candidate-pair' && s.selected === true) pair = s; });
  if (!pair) return null;
  const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
  return { pairId: pair.id, state: pair.state, localIp: local?.address || local?.ip,
    remoteIp: remote?.address || remote?.ip, protocol: local?.protocol,
    localType: local?.candidateType, remoteType: remote?.candidateType };
}

export class DirectCallAudio {
  private run: Run | null = null;
  private closing: Promise<unknown> = Promise.resolve();
  isStartingOrActive(id: string) { return this.run?.id === id && this.run.active; }

  start(role: 'caller' | 'callee', peer: string, id: string, callbacks: Callbacks, credentials?: DirectCredentials, peerDeviceName?: string, direct?: { localIp: string }): Promise<void> {
    if (this.run) return this.run.id === id ? this.run.started : Promise.reject(new Error('Another call is active'));
    let resolve!: () => void, reject!: (error: Error) => void;
    const started = new Promise<void>((ok, no) => { resolve = ok; reject = no; });
    const r: Run = { id, peer, peerDeviceName, role, active: true, connected: false, socketReady: false,
      mediaReady: false, peerReady: false, offering: false, initialOfferStarted: false, localIp: '', pending: [], ice: [],
      chain: Promise.resolve(), subscriptions: [], callbacks, resolve, reject, started,
      sampling: false, received: 0, lastReceived: Date.now(), restarts: 0, peerMuted: false,
      gathered: 0, accepted: 0, remoteIce: 0, appliedIce: 0, lastRoute: '' };
    this.run = r;
    // Backstop for the whole setup chain, which runs sequentially when Wi-Fi
    // starts off: panel wait 12s + direct address read 12s + native begin
    // watchdog 30s = 54s before media even starts, plus signaling and ICE.
    // Every phase that can fail has its own earlier deadline with a specific
    // message, so this only catches a genuinely wedged run — it must never be
    // the first timer to fire and mask that message.
    r.timeout = setTimeout(() => {
      const detail = !r.socketReady ? 'Direct Wi-Fi control link was not ready.' :
        !r.accepted ? 'WebRTC found no usable direct Wi-Fi address.' :
        !r.remoteIce ? 'No direct audio address received from the other phone.' : 'Direct audio connectivity checks did not complete.';
      this.fail(r, `Audio setup timed out. ${detail}`);
    }, 90000);
    void this.prepare(r, credentials, direct).catch(error => this.fail(r, error.message || String(error)));
    return started;
  }
  private async startMediaCapture(r: Run) {
    // Open the microphone while the direct link is still forming. Group
    // creation, DHCP and the control handshake take seconds that must not be
    // spent serially behind a mic open. A failure here surfaces when media is
    // first awaited (initializeMedia), never earlier.
    r.media = mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    } as any, video: false });
    r.media.then(stream => { if (!r.active) stream.getTracks().forEach(track => track.stop()); }).catch(() => {});
    r.subscriptions.push(
      wifi.onReady(e => { if (r.active && e.sessionId === r.id && !r.socketReady) {
        r.socketReady = true; r.localIp = e.localIp;
        console.log('[DirectICE] control-ready', JSON.stringify({ sessionId: r.id, role: r.role, localIp: r.localIp }));
        void this.initializeMedia(r).catch(error => this.fail(r, error.message));
      } }),
      wifi.onSignal(e => {
        if (!r.active || e.sessionId !== r.id) return;
        try {
          const msg = JSON.parse(e.data);
          if (msg.sessionId !== r.id) return;
          // Call-level messages belong to DirectCallFlow/useDirectCall.
          if (msg.type === 'call-request' || msg.type === 'call-accept'
              || msg.type === 'call-reject' || msg.type === 'call-end') return;
          if (msg.type === 'end') { this.fail(r, 'Peer ended the call'); return; }
          if (!r.mediaReady) { if (r.pending.length >= 128) throw new Error('Too many setup messages'); r.pending.push(msg); }
          else this.enqueue(r, msg);
        } catch (error: any) { this.fail(r, error.message || 'Invalid peer signal'); }
      }),
      wifi.onError(e => { if (r.active && e.sessionId === r.id) this.fail(r, e.error); }),
    );
  }
  private async prepare(r: Run, credentials?: DirectCredentials, direct?: { localIp: string }) {
    // Nearby-free bootstrap: the native dial/listener already owns an
    // authenticated control socket, so skip discovery, token exchange and
    // connect(), and go straight to WebRTC over that socket.
    if (direct) {
      r.socketReady = true;
      r.localIp = direct.localIp;
      await this.closing;
      if (!r.active) return;
      // A legacy presence scan running on the shared radio starves the P2P
      // link. Call-state subscription restarts it when the call returns idle.
      await nearbyDiscoveryService.stopDiscovery().catch(() => {});
      if (!r.active) return;
      await this.startMediaCapture(r);
      if (!r.active) return;
      r.callbacks.onStatus('Starting WebRTC audio…');
      await this.initializeMedia(r);
      return;
    }
    await this.closing;
    if (!r.active) return;
    await nearbyDiscoveryService.stopDiscovery();
    if (!r.active) return;
    await this.startMediaCapture(r);
    if (!r.active) return;
    r.callbacks.onStatus('Preparing direct connection…');
    r.handoff = this.handoff(r, credentials);
    const directLink = await r.handoff;
    if (!r.active) return;
    r.callbacks.onStatus('Establishing direct Wi-Fi…');
    // Both sides run the same two-sided framework connect; the GO intent
    // split makes the callee the host deterministically.
    await wifi.connectPeer(r.id, directLink.peerP2pAddress, r.role === 'caller', directLink.token);
  }
  private async handoff(r: Run, credentials?: DirectCredentials): Promise<DirectCredentials> {
    // The address connect() needs is the PEER's, and discovery is the only
    // source that works on this hardware: neither phone can read its own —
    // requestDeviceInfo answers 02:00:00:00:00:00 forever, p2p0 never becomes
    // readable, and createGroup is refused P2P_UNSUPPORTED at every timing and
    // with discovery already running — while requestPeers() returns the other
    // phone's address on both test devices. So both sides discover and the
    // address in the signal is only a cross-check, never the one we dial.
    //
    // MAC-keyed path: the wrapper resolves the peer by its hashed P2P tag,
    // reuses the friend's last known MAC as a hint, and persists the result.
    const peerP2pAddress = await wifi.getPeerP2pAddress(r.peer, r.peerDeviceName);
    if (!r.active) throw new Error('Call stopped');
    if (!peerP2pAddress || peerP2pAddress === '02:00:00:00:00:00') {
      throw new Error('The other phone was not discovered over Wi-Fi Direct');
    }
    let direct: DirectCredentials;
    if (r.role === 'callee') {
      // Plan the token without touching Wi-Fi Direct while Nearby owns it.
      const planned = await wifi.prepareGroup();
      if (!r.active) throw new Error('Call stopped');
      const endpoint = signalingManager.getActiveConnection(r.peer);
      if (!endpoint) throw new Error('The nearby connection was lost before direct setup');
      // Subscribe before config: a fast peer can acknowledge and disconnect in
      // the same event turn. The caller alone releases first after confirmed send.
      const ready = this.waitForPeerRelease(r, endpoint);
      void ready.catch(() => {});
      if (!(await signalingManager.sendDirectConfig(r.peer, r.id, { peerP2pAddress, token: planned.token }))) {
        r.cancelSetup?.();
        throw new Error('Could not send direct connection details');
      }
      const callerConfirmed = await ready;
      if (!callerConfirmed || callerConfirmed === '02:00:00:00:00:00') {
        throw new Error('The other phone did not confirm direct setup');
      }
      direct = { token: planned.token, peerP2pAddress };
    } else {
      if (!credentials) throw new Error('Missing direct connection details');
      if (!(await signalingManager.sendDirectReady(r.peer, r.id, peerP2pAddress)))
        throw new Error('Could not confirm direct connection details');
      direct = { token: credentials.token, peerP2pAddress };
    }
    if (!r.active) throw new Error('Call stopped');
    if (!(await Nearby.releaseForDirectCall(r.id))) throw new Error('Could not release the nearby connection for direct calling');
    if (!r.active) throw new Error('Call stopped');
    return direct;
  }
  private waitForPeerRelease(r: Run, endpoint: string): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      let acknowledged = false, settled = false, peerAddress: string | undefined;
      let disconnected: { remove(): void } | undefined;
      let timer: ReturnType<typeof setTimeout>;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signalingManager.off('direct-ready', listener);
        disconnected?.remove();
        if (r.cancelSetup === cancel) r.cancelSetup = undefined;
        if (error) reject(error); else resolve(peerAddress);
      };
      const cancel = () => done(new Error('Call stopped'));
      const listener = ({ signal, connectionId }: any) => {
        if (r.active && connectionId === endpoint && signal.from === r.peer && signal.sessionId === r.id
            && signal.data?.mediaEngine === 'webrtc-direct-v2' && !acknowledged) {
          acknowledged = true;
          peerAddress = typeof signal.data?.peerP2pAddress === 'string' ? signal.data.peerP2pAddress : undefined;
          clearTimeout(timer);
          timer = setTimeout(() => done(new Error('The other phone did not release its nearby connection')), 8000);
        }
      };
      // The peer may still be waiting on the system Wi-Fi panel at this point;
      // 25s leaves room for that one OS toggle plus its address read.
      timer = setTimeout(() => done(new Error('The other phone did not confirm direct setup')), 25000);
      r.cancelSetup = cancel;
      signalingManager.on('direct-ready', listener);
      disconnected = Nearby.onConnectionClosed(event => {
        if (!r.active || event.connectionId !== endpoint) return;
        if (!acknowledged) done(new Error('The nearby connection closed before direct setup was confirmed'));
        else done();
      });
    });
  }
  private async initializeMedia(r: Run) {
    await wifi.startAudio(r.id);
    if (!r.active) return;
    // Capture was requested when the run started; late tracks after a stop
    // are stopped by the guard installed in prepare.
    const stream = await r.media!;
    if (!r.active) return;
    r.stream = stream;
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    r.pc = pc;
    const events = pc as any;
    events.addEventListener('icecandidate', (e: any) => {
      if (!r.active || !e.candidate) return;
      const fields = e.candidate.candidate.trim().split(/\s+/);
      const accepted = directCandidate(e.candidate.candidate, r.localIp);
      r.gathered++; if (accepted) r.accepted++;
      console.log('[DirectICE] candidate', JSON.stringify({ sessionId: r.id, address: fields[4], port: fields[5],
        protocol: fields[2], type: fields[7], expectedIp: r.localIp, accepted,
        reason: accepted ? 'direct-udp-host' : 'not-direct-udp-host' }));
      if (accepted)
        void this.send(r, 'ice', { candidate: e.candidate.toJSON() }).catch(error => this.fail(r, error.message));
    });
    events.addEventListener('icegatheringstatechange', () => {
      if (r.active) console.log('[DirectICE] gathering', JSON.stringify({ sessionId: r.id,
        state: pc.iceGatheringState, gathered: r.gathered, accepted: r.accepted }));
    });
    events.addEventListener('iceconnectionstatechange', () => {
      if (r.active) console.log('[DirectICE] connectivity', JSON.stringify({ sessionId: r.id, state: pc.iceConnectionState }));
    });
    events.addEventListener('connectionstatechange', () => {
      if (!r.active) return;
      const state = pc.connectionState;
      console.log('[DirectCall] WebRTC state', state);
      if (state === 'connected') {
        clearTimeout(r.timeout); clearTimeout(r.recovery); r.recovery = undefined;
        r.callbacks.onStatus(''); r.lastReceived = Date.now();
        if (!r.connected) {
          r.connected = true; r.resolve();
          void this.sample(r);
          r.stats = setInterval(() => { void this.sample(r); }, 2000);
        }
      } else if ((state === 'disconnected' || state === 'failed') && !r.recovery) {
        r.callbacks.onStatus('Connection interrupted — reconnecting…');
        r.recovery = setTimeout(() => this.fail(r, 'Direct audio connection could not recover'), 12000);
        void this.requestRestart(r).catch(error => this.fail(r, error.message));
      }
    });
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    r.mediaReady = true;
    r.callbacks.onStatus('Starting WebRTC audio…');
    await this.send(r, 'ready');
    if (!r.active) return;
    r.pending.splice(0).forEach(msg => this.enqueue(r, msg));
    // The receiver already buffers control messages until its media is ready.
    // Start the offer now instead of waiting an extra peer-ready round trip.
    if (r.role === 'caller') {
      r.chain = r.chain.then(() => this.offer(r, false));
      await r.chain;
    }
  }
  /**
   * Replay a control message captured before this run subscribed (the direct
   * socket is opened before the callee taps Answer). Public only so
   * useDirectCall can hand over its pre-audio buffer.
   */
  inject(id: string, data: string) {
    const r = this.run;
    if (!r || !r.active || r.id !== id) return;
    try {
      const msg = JSON.parse(data);
      if (msg.sessionId !== r.id) return;
      if (msg.type === 'call-request' || msg.type === 'call-accept'
          || msg.type === 'call-reject' || msg.type === 'call-end') return;
      if (msg.type === 'end') { this.fail(r, 'Peer ended the call'); return; }
      if (!r.mediaReady) {
        if (r.pending.length >= 128) throw new Error('Too many setup messages');
        r.pending.push(msg);
      } else this.enqueue(r, msg);
    } catch { /* malformed or superseded */ }
  }
  private enqueue(r: Run, message: any) {
    r.chain = r.chain.then(async () => {
      if (!r.active || !r.pc) return;
      const pc = r.pc;
      switch (message.type) {
        case 'ready':
          if (r.peerReady) break;
          r.peerReady = true;
          if (r.role === 'caller' && !r.offering) await this.offer(r, false);
          break;
        case 'offer':
          if (r.role !== 'callee' || !message.sdp) return;
          await pc.setRemoteDescription(message.sdp);
          if (!r.active) return;
          await this.flushIce(r);
          const answer = await pc.createAnswer();
          if (!r.active) return;
          await pc.setLocalDescription(answer);
          if (r.active) await this.send(r, 'answer', { sdp: { type: 'answer', sdp: directSdp(answer.sdp, r.localIp) } });
          break;
        case 'answer':
          if (r.role !== 'caller' || pc.signalingState !== 'have-local-offer') return;
          await pc.setRemoteDescription(message.sdp);
          if (r.active) { await this.flushIce(r); r.offering = false; }
          break;
        case 'ice':
          if (!message.candidate?.candidate || typeof message.candidate.candidate !== 'string') return;
          r.remoteIce++;
          console.log('[DirectICE] received', JSON.stringify({ sessionId: r.id, count: r.remoteIce, queued: !pc.remoteDescription }));
          if (!pc.remoteDescription) {
            if (r.ice.length >= 64) throw new Error('Too many ICE candidates');
            r.ice.push(message.candidate);
          } else await this.applyIce(r, message.candidate);
          break;
        case 'restart':
          if (r.role === 'caller' && !r.offering) await this.offer(r, true);
          break;
        case 'mute': r.peerMuted = message.muted === true; r.lastReceived = Date.now(); break;
      }
    }).catch(error => { if (r.active) this.fail(r, `Audio negotiation failed: ${error.message}`); });
  }
  private async flushIce(r: Run) {
    for (const candidate of r.ice.splice(0)) { if (!r.active) return; await this.applyIce(r, candidate); }
  }
  private async applyIce(r: Run, candidate: any) {
    await r.pc!.addIceCandidate(candidate);
    if (r.active) console.log('[DirectICE] applied', JSON.stringify({ sessionId: r.id, count: ++r.appliedIce }));
  }
  private async offer(r: Run, restart: boolean) {
    if (!r.active || !r.pc || r.offering) return;
    // `offering` clears after the answer, but a delayed peer-ready can arrive
    // afterward. Only explicit ICE recovery may negotiate another offer.
    if (!restart && r.initialOfferStarted) return;
    r.initialOfferStarted = true;
    r.offering = true;
    const offer = await r.pc.createOffer({ offerToReceiveAudio: true, iceRestart: restart });
    if (!r.active) return;
    await r.pc.setLocalDescription(offer);
    if (r.active) await this.send(r, 'offer', { sdp: { type: 'offer', sdp: directSdp(offer.sdp, r.localIp) } });
  }
  private send(r: Run, type: string, data: any = {}) {
    if (!r.active) return Promise.resolve(false);
    return wifi.send(r.id, JSON.stringify({ sessionId: r.id, type, ...data }));
  }
  private async requestRestart(r: Run) {
    if (++r.restarts > 2) { this.fail(r, 'Audio connection repeatedly interrupted'); return; }
    if (r.role === 'caller') {
      r.chain = r.chain.then(() => this.offer(r, true)); await r.chain;
    } else await this.send(r, 'restart');
  }
  private async sample(r: Run) {
    if (!r.active || !r.pc || r.sampling) return;
    r.sampling = true;
    try {
      const stats = await r.pc.getStats();
      if (!r.active) return;
      const route = selectedRoute(stats);
      if (route && JSON.stringify(route) !== r.lastRoute) {
        r.lastRoute = JSON.stringify(route);
        console.log('[DirectICE] selected-route', JSON.stringify({ sessionId: r.id, expectedIp: r.localIp,
          matchesDirectIp: route.localIp === r.localIp, ...route }));
      }
      let received = 0;
      stats.forEach((s: any) => {
        if (s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) {
          received += s.packetsReceived || 0;
          console.log('[WebRTCMetrics]', JSON.stringify({ received: s.packetsReceived, lost: s.packetsLost,
            jitter: s.jitter, concealed: s.concealedSamples, jitterBufferDelay: s.jitterBufferDelay,
            jitterBufferEmittedCount: s.jitterBufferEmittedCount }));
        }
      });
      if (received > r.received || r.peerMuted) { r.received = received; r.lastReceived = Date.now(); }
      if (Date.now() - r.lastReceived > 15000 && !r.recovery) {
        r.callbacks.onStatus('Audio interrupted — reconnecting…');
        r.recovery = setTimeout(() => this.fail(r, 'No audio received from the peer'), 12000);
        await this.requestRestart(r);
      }
      if (received > 0 && Date.now() - r.lastReceived < 3000 && r.pc.connectionState === 'connected' && r.recovery) {
        clearTimeout(r.recovery); r.recovery = undefined; r.callbacks.onStatus('');
      }
    } catch (error) { console.warn('[WebRTCMetrics] Unavailable', String(error)); }
    finally { r.sampling = false; }
  }
  setMuted(value: boolean) {
    const r = this.run; if (!r) return;
    r.stream?.getAudioTracks().forEach(track => { track.enabled = !value; });
    void this.send(r, 'mute', { muted: value }).catch(error => this.fail(r, error.message));
  }
  setSpeaker(value: boolean) { const r = this.run; if (r) wifi.speaker(r.id, value); }
  async end() {
    const r = this.run;
    if (r?.socketReady) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.send(r, 'end').catch(() => false), new Promise(resolve => { timer = setTimeout(resolve, 400); })]);
      clearTimeout(timer);
    }
  }
  private fail(r: Run, message: string) {
    if (!r.active) return;
    console.warn('[DirectICE] failure', JSON.stringify({ sessionId: r.id, message, localIp: r.localIp,
      gathered: r.gathered, accepted: r.accepted, remote: r.remoteIce, applied: r.appliedIce }));
    r.reject(new Error(message)); this.stop(); r.callbacks.onError(message);
  }
  stop(): Promise<unknown> {
    const r = this.run; if (!r) return this.closing;
    r.active = false; this.run = null;
    r.cancelSetup?.(); r.cancelSetup = undefined;
    clearTimeout(r.timeout); clearTimeout(r.recovery); clearInterval(r.stats);
    r.subscriptions.forEach(sub => sub.remove()); r.pending = []; r.ice = [];
    r.stream?.getTracks().forEach(track => track.stop()); r.pc?.close();
    r.reject(new Error('Call stopped'));
    this.closing = this.closing.then(async () => {
      // A release already in flight must finish before we resume Nearby. Do not
      // wait for create/join: native stop is what cancels those pending operations.
      await r.handoff?.catch(() => {});
      try { await wifi.stop(r.id); }
      finally { if (r.handoff) await Nearby.resumeAfterDirectCall(r.id); }
    }).catch(error => console.warn('[DirectCall] Cleanup', String(error)));
    return this.closing;
  }
  stopStreaming() { return this.stop(); }
}
export default new DirectCallAudio();

import { NativeModules, NativeEventEmitter, PermissionsAndroid, Platform } from 'react-native';
import { signalingManager } from './CallSignaling';
import Nearby from '../modules/Nearby';
import opusCodec from '../modules/OpusCodec';
import { AudioJitterBuffer, VoiceFrame } from './AudioJitterBuffer';

const Native = NativeModules.AudioStreamModule;
const emitter = Native ? new NativeEventEmitter(Native) : null;
export interface AudioStreamCallbacks { onError: (err: string) => void }
type Run = {
  id: string; peer: string; endpoint: string; active: boolean; ready: boolean;
  sending: boolean; playing: boolean; jitter: AudioJitterBuffer;
  pending?: { data: string; frameNumber: number; arrived: number };
  subscriptions: { remove(): void }[];
  listener?: (payload: any) => void;
  timer?: ReturnType<typeof setInterval>; statsTimer?: ReturnType<typeof setInterval>;
  callbacks: AudioStreamCallbacks;
  stats: { captured: number; sent: number; sendDropped: number; sendErrors: number; decoded: number; decodeErrors: number };
};

class AudioStreamingService {
  private run: Run | null = null;
  private starting: Promise<void> | null = null;

  async startStreaming(peer: string, id: string, callbacks: AudioStreamCallbacks,
    quality: 'low' | 'medium' | 'high' = 'medium'): Promise<void> {
    if (this.run) {
      if (this.run.id !== id) throw new Error('Another call is already using audio');
      return this.starting ?? Promise.resolve();
    }
    const endpoint = signalingManager.getActiveConnection(peer);
    if (!endpoint) throw new Error('No connected Nearby endpoint');
    const run: Run = {
      id, peer, endpoint, active: true, ready: false, sending: false, playing: false,
      jitter: new AudioJitterBuffer(), subscriptions: [], callbacks,
      stats: { captured: 0, sent: 0, sendDropped: 0, sendErrors: 0, decoded: 0, decodeErrors: 0 },
    };
    this.run = run;
    const start = this.start(run, quality);
    this.starting = start;
    try { await start; } catch (e) {
      if (this.run === run) this.stopStreaming();
      throw e; // Never mark the call active after a failed startup.
    } finally { if (this.starting === start) this.starting = null; }
  }

  private async start(run: Run, quality: 'low' | 'medium' | 'high') {
    if (!Native || !emitter) throw new Error('Native audio module missing; install the new APK');
    if (Platform.OS === 'android' &&
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO) !== PermissionsAndroid.RESULTS.GRANTED)
      throw new Error('Microphone permission is required');
    if (!run.active) throw new Error('Call cancelled');
    await opusCodec.initialize({ low: 8000, medium: 16000, high: 32000 }[quality]);
    if (!run.active) throw new Error('Call cancelled');
    // Do not silently fall back to high-bandwidth PCM.
    run.listener = ({ signal, connectionId }: any) => {
      if (!run.active || connectionId !== run.endpoint || signal.sessionId !== run.id ||
          signal.codec !== 'opus' || !Number.isSafeInteger(signal.frameNumber) ||
          signal.frameNumber < 0 || typeof signal.data !== 'string' ||
          signal.data.length === 0 || signal.data.length > 2048) return;
      run.jitter.push(signal as VoiceFrame, performance.now());
    };
    signalingManager.on('audio-frame', run.listener);
    run.subscriptions.push(
      emitter.addListener('onAudioCaptured', (event: any) => {
        if (!run.active || event.sessionId !== run.id || !Number.isSafeInteger(event.frameNumber)) return;
        run.stats.captured++;
        if (run.pending) run.stats.sendDropped++;
        run.pending = { data: event.data, frameNumber: event.frameNumber, arrived: performance.now() };
        void this.sendNext(run);
      }),
      emitter.addListener('onCaptureError', (e: any) => {
        if (run.active && e.sessionId === run.id) this.fail(run, e.error);
      }),
      Nearby.onConnectionClosed((e) => {
        if (e.connectionId === run.endpoint) this.fail(run, 'Nearby connection lost');
      }),
    );
    await Native.startCapture(run.id);
    if (!run.active) throw new Error('Call cancelled');
    run.ready = true;
    run.timer = setInterval(() => { void this.playNext(run); }, 20);
    run.statsTimer = setInterval(() => {
      if (run.active) {
        console.log('[CallMetrics]', JSON.stringify({ sessionId: run.id, ...run.stats,
          jitter: run.jitter.stats, queueMs: run.jitter.queueMs }));
        Native.logStats(run.id);
      }
    }, 5000);
  }

  private async sendNext(run: Run): Promise<void> {
    if (!run.active || run.sending || !run.pending) return;
    run.sending = true;
    try {
      while (run.active && run.pending) {
        const frame = run.pending;
        run.pending = undefined;
        if (performance.now() - frame.arrived > 60) { run.stats.sendDropped++; continue; }
        const data = await NativeModules.OpusModule.encodeBase64(frame.data);
        if (!run.active) return;
        if (performance.now() - frame.arrived > 100) { run.stats.sendDropped++; continue; }
        const ok = await signalingManager.sendAudioFrame(run.peer, JSON.stringify({
          type: 'audio-frame', codec: 'opus', sessionId: run.id,
          frameNumber: frame.frameNumber, sampleRate: 16000, data,
        }));
        if (ok) run.stats.sent++; else run.stats.sendErrors++;
      }
    } catch { run.stats.sendErrors++; }
    finally { run.sending = false; }
  }

  private async playNext(run: Run) {
    if (!run.active || !run.ready || run.playing) return;
    const frame = run.jitter.pop(performance.now());
    if (frame === undefined) return;
    run.playing = true;
    try {
      // Empty Opus packet requests decoder packet-loss concealment.
      const pcm = await NativeModules.OpusModule.decodeBase64(frame?.data ?? '');
      if (run.active) { await Native.playback(run.id, pcm); run.stats.decoded++; }
    } catch {
      run.stats.decodeErrors++;
      // A corrupt packet is not a reason to tear down a working call.
    } finally { run.playing = false; }
  }

  private fail(run: Run, message: string) {
    if (!run.active) return;
    this.stopStreaming();
    run.callbacks.onError(message);
  }

  stopStreaming() {
    const run = this.run;
    if (!run) return;
    run.active = false; run.pending = undefined;
    if (run.timer) clearInterval(run.timer);
    if (run.statsTimer) clearInterval(run.statsTimer);
    run.subscriptions.forEach(s => s.remove());
    if (run.listener) signalingManager.off('audio-frame', run.listener);
    Native?.stopCapture();
    opusCodec.reset();
    console.log('[CallMetrics] stopped', JSON.stringify({ sessionId: run.id, ...run.stats, jitter: run.jitter.stats }));
    this.run = null;
  }
}
export default new AudioStreamingService();

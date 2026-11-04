import { NativeEventEmitter, NativeModules } from 'react-native';

const Native = NativeModules.AudioStreamModule ?? new Proxy({}, {
  get() { throw new Error('AudioStreamModule not linked. Run: expo run:android'); }
});
const emitter = new NativeEventEmitter(Native);

const AudioStream = {
  async startCapture(sessionId: string, onData: (b64: string) => void) {
    const sub = emitter.addListener('onAudioCaptured', (e: { sessionId: string; data: string }) => {
      if (e.sessionId === sessionId) onData(e.data);
    });
    try { await Native.startCapture(sessionId); return sub; }
    catch (error) { sub.remove(); throw error; }
  },
  stopCapture:  ()                    => Native.stopCapture(),
  playback:     (sessionId: string, b64: string) => Native.playback(sessionId, b64),
  setMuted:     (m: boolean)          => Native.setMuted(m),
  isMuted:      (): Promise<boolean>  => Native.isMuted(),
  setSpeakerOn: (on: boolean)         => Native.setSpeakerOn(on),
  isSpeakerOn:  (): Promise<boolean>  => Native.isSpeakerOn(),
};

export default AudioStream;

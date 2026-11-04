/**
 * AudioPlaybackService — Receive Opus frames, decode, and play audio
 *
 * Flow:
 * 1. Receive Opus-encoded frames via Nearby
 * 2. Decode to PCM
 * 3. Play via AudioTrack (native Android)
 */
import { NativeModules } from 'react-native';
import opusCodec from '../modules/OpusCodec';

const AudioTrackModule = NativeModules.AudioTrackModule;

export interface PlaybackCallbacks {
  onError: (err: string) => void;
  onPlaybackStarted: () => void;
}

class AudioPlaybackService {
  private isPlaying = false;
  private callbacks: PlaybackCallbacks | null = null;
  private frameBuffer: string[] = []; // Hex-encoded Opus frames
  private isProcessing = false;

  // Opus parameters (must match sender)
  private readonly SAMPLE_RATE = 16000;
  private readonly CHANNELS = 1;
  private readonly FRAME_SIZE = 320; // 20ms

  startPlayback(callbacks: PlaybackCallbacks) {
    console.log('[AudioPlayback] Starting playback');

    try {
      if (!AudioTrackModule) {
        throw new Error('AudioTrackModule not available');
      }

      this.callbacks = callbacks;
      this.isPlaying = true;
      this.frameBuffer = [];

      // Initialize AudioTrack on native side
      AudioTrackModule.initAudioTrack(this.SAMPLE_RATE, this.CHANNELS, (err: any) => {
        if (err) {
          console.error('[AudioPlayback] Init error:', err);
          this.callbacks?.onError(err);
        } else {
          console.log('[AudioPlayback] ✅ AudioTrack initialized');
          this.callbacks?.onPlaybackStarted();
        }
      });
    } catch (e: any) {
      console.error('[AudioPlayback] Start failed:', e);
      this.callbacks?.onError(e?.message);
    }
  }

  onRemoteAudioFrame(opusFrameHex: string) {
    if (!this.isPlaying) return;

    try {
      // Add to buffer
      this.frameBuffer.push(opusFrameHex);

      console.log('[AudioPlayback] Buffered frame, queue size:', this.frameBuffer.length);

      // Start processing if not already
      if (!this.isProcessing) {
        this.processBuffer();
      }
    } catch (e: any) {
      console.error('[AudioPlayback] Buffer error:', e);
    }
  }

  private async processBuffer() {
    this.isProcessing = true;

    while (this.isPlaying && this.frameBuffer.length > 0) {
      try {
        const opusFrameHex = this.frameBuffer.shift();
        if (!opusFrameHex) break;

        // Decode Opus to PCM
        const pcmSamples = await opusCodec.decode(opusFrameHex);

        // Play PCM
        if (AudioTrackModule) {
          await new Promise((resolve, reject) => {
            AudioTrackModule.playAudio(
              pcmSamples,
              (err: any) => {
                if (err) reject(err);
                else resolve(null);
              }
            );
          });
        }

        // Sleep 20ms to match frame rate
        await new Promise(r => setTimeout(r, 20));
      } catch (e: any) {
        console.error('[AudioPlayback] Process error:', e);
      }
    }

    this.isProcessing = false;
  }

  stopPlayback() {
    console.log('[AudioPlayback] Stopping');
    this.isPlaying = false;
    this.frameBuffer = [];

    if (AudioTrackModule) {
      AudioTrackModule.stopAudioTrack(() => {
        console.log('[AudioPlayback] ✅ Stopped');
      });
    }
  }
}

export default new AudioPlaybackService();

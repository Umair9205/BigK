/**
 * OpusCodec — TypeScript wrapper for native Opus encoding/decoding
 * Uses native Android Opus library (libopus) via React Native bridge
 */
import { NativeModules } from 'react-native';

const OpusModule = NativeModules.OpusModule;

if (!OpusModule) {
  console.warn('[OpusCodec] OpusModule is not registered; native Opus codec is unavailable on this build.');
}

class OpusCodec {
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private generation = 0;

  /**
   * Initializes the native Opus encoder/decoder.
   *
   * The native layer (opus_jni.c) holds a single process-global encoder and
   * decoder instance. Calling initEncoder/initDecoder again while a call is
   * already streaming destroys and recreates that global state mid-stream,
   * which corrupts the decoder and makes every subsequent opus_decode() call
   * fail. This method is therefore idempotent: concurrent or repeated calls
   * (e.g. from a duplicated accept/handshake-ack event) reuse the same
   * initialization instead of re-running it.
   */
  async initialize(bitrate: number = 16000): Promise<void> {
    if (this.initialized) {
      console.log('[OpusCodec] Already initialized, skipping re-init');
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      return this.initialize(bitrate);
    }

    if (!OpusModule || typeof OpusModule.initEncoder !== 'function' || typeof OpusModule.initDecoder !== 'function') {
      const message = 'Native Opus module unavailable on this device/build';
      console.warn('[OpusCodec] ' + message);
      throw new Error(message);
    }

    const generation = this.generation;
    this.initPromise = (async () => {
      try {
        await OpusModule.initEncoder(bitrate);
        if (generation !== this.generation) return;
        await OpusModule.initDecoder();
        if (generation !== this.generation) return;
        this.initialized = true;
        console.log('[OpusCodec] ✅ Encoder & Decoder initialized');
      } catch (e: any) {
        console.error('[OpusCodec] Init failed:', e);
        throw e;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  /**
   * Resets initialization state so the next call's initialize() actually
   * re-creates the native codec. Call this when a call session fully ends.
   */
  reset(): void {
    this.generation++;
    this.initialized = false;
    // Let any in-flight initialization settle before the next one starts.
  }

  /**
   * Encode PCM samples (Int16) to Opus
   * @param pcmSamples - Array of 16-bit PCM samples @ 16kHz
   * @returns Hex-encoded Opus frame
   */
  async encode(pcmSamples: number[]): Promise<string> {
    if (!this.initialized) {
      throw new Error('OpusCodec not initialized - call initialize() first');
    }

    if (!OpusModule || typeof OpusModule.encode !== 'function') {
      throw new Error('Native Opus encoder unavailable on this device/build');
    }

    try {
      return await OpusModule.encode(pcmSamples);
    } catch (e: any) {
      console.error('[OpusCodec] Encode failed:', e);
      throw e;
    }
  }

  /**
   * Decode Opus frame to PCM samples
   * @param hexFrame - Hex-encoded Opus frame
   * @returns Array of 16-bit PCM samples
   */
  async decode(hexFrame: string): Promise<number[]> {
    if (!this.initialized) {
      throw new Error('OpusCodec not initialized - call initialize() first');
    }

    if (!OpusModule || typeof OpusModule.decode !== 'function') {
      throw new Error('Native Opus decoder unavailable on this device/build');
    }

    try {
      const result = await OpusModule.decode(hexFrame);
      // Convert ReadableArray to regular array
      return Array.isArray(result) ? result : result._array || [];
    } catch (e: any) {
      console.error('[OpusCodec] Decode failed:', e);
      throw e;
    }
  }
}

export default new OpusCodec();

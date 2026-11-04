package com.anonymous.kelakonnect

import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.*

class OpusModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "OpusModule"
        private const val FRAME_SIZE = 320  // 20ms @ 16kHz
        private const val SAMPLE_RATE = 16000
        private const val CHANNELS = 1
        private const val BITRATE = 16000  // bits per second

        private val nativeLibraryAvailable: Boolean = try {
            System.loadLibrary("opus_jni")
            Log.d(TAG, "✅ Native libopus library loaded")
            true
        } catch (e: UnsatisfiedLinkError) {
            Log.w(TAG, "⚠️ Native libopus library unavailable: ${e.message}")
            false
        }
    }

    override fun getName() = "OpusModule"

    // Keep PCM conversion native: avoid 320-element JS arrays for every frame.
    @ReactMethod fun encodeBase64(base64: String, promise: Promise) {
        if (!nativeLibraryAvailable) { promise.reject("OPUS_UNAVAILABLE", "Native Opus unavailable"); return }
        try {
            val bytes = Base64.decode(base64, Base64.NO_WRAP)
            require(bytes.size == FRAME_SIZE * 2) { "Expected exactly 320 PCM samples" }
            val shorts = ShortArray(FRAME_SIZE)
            java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts)
            val encoded = encodeOpus(shorts, FRAME_SIZE)
            check(encoded.isNotEmpty()) { "Opus encode failed" }
            promise.resolve(Base64.encodeToString(encoded, Base64.NO_WRAP))
        } catch (e: Exception) { promise.reject("ENCODE_FAILED", e) }
    }

    @ReactMethod fun decodeBase64(base64: String, promise: Promise) {
        if (!nativeLibraryAvailable) { promise.reject("OPUS_UNAVAILABLE", "Native Opus unavailable"); return }
        try {
            val bytes = Base64.decode(base64, Base64.NO_WRAP)
            val pcm = decodeOpus(bytes, bytes.size, FRAME_SIZE)
            check(pcm.size == FRAME_SIZE) { "Expected exactly 320 decoded samples" }
            val buffer = java.nio.ByteBuffer.allocate(FRAME_SIZE * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            buffer.asShortBuffer().put(pcm)
            promise.resolve(Base64.encodeToString(buffer.array(), Base64.NO_WRAP))
        } catch (e: Exception) { promise.reject("DECODE_FAILED", e) }
    }

    @ReactMethod
    fun initEncoder(bitrate: Int, promise: Promise) {
        if (!nativeLibraryAvailable) {
            val message = "Native Opus library unavailable on this device"
            Log.w(TAG, message)
            promise.reject("OPUS_UNAVAILABLE", message)
            return
        }

        try {
            val result = _initEncoder(SAMPLE_RATE, CHANNELS, bitrate)
            if (result == 0) {
                Log.d(TAG, "✅ Opus encoder initialized: bitrate=$bitrate, sample_rate=$SAMPLE_RATE")
                promise.resolve(true)
            } else {
                throw Exception("Failed to initialize encoder: error code $result")
            }
        } catch (e: Exception) {
            Log.e(TAG, "❌ Failed to init encoder: ${e.message}")
            promise.reject("ENCODER_INIT_FAILED", e.message)
        }
    }

    @ReactMethod
    fun initDecoder(promise: Promise) {
        if (!nativeLibraryAvailable) {
            val message = "Native Opus library unavailable on this device"
            Log.w(TAG, message)
            promise.reject("OPUS_UNAVAILABLE", message)
            return
        }

        try {
            val result = _initDecoder(SAMPLE_RATE, CHANNELS)
            if (result == 0) {
                Log.d(TAG, "✅ Opus decoder initialized: sample_rate=$SAMPLE_RATE")
                promise.resolve(true)
            } else {
                throw Exception("Failed to initialize decoder: error code $result")
            }
        } catch (e: Exception) {
            Log.e(TAG, "❌ Failed to init decoder: ${e.message}")
            promise.reject("DECODER_INIT_FAILED", e.message)
        }
    }

    /**
     * Encode PCM samples to Base64-encoded Opus
     * Input: pcmSamples as Int16Array
     * Output: Base64-encoded Opus bitstream
     * Expected compression: ~20:1 (640 bytes PCM → ~32 bytes Opus)
     */
    @ReactMethod
    fun encode(pcmSamplesArray: ReadableArray, promise: Promise) {
        if (!nativeLibraryAvailable) {
            val message = "Native Opus library unavailable on this device"
            Log.w(TAG, message)
            promise.reject("OPUS_UNAVAILABLE", message)
            return
        }

        try {
            // Convert ReadableArray to ShortArray
            val pcmSamples = ShortArray(pcmSamplesArray.size()) { i ->
                pcmSamplesArray.getInt(i).toShort()
            }

            if (pcmSamples.isEmpty()) {
                throw Exception("PCM samples array is empty")
            }

            // Call native encode
            val opusBytes = encodeOpus(pcmSamples, pcmSamples.size)

            if (opusBytes == null || opusBytes.isEmpty()) {
                throw Exception("Failed to encode: opus_encode returned null or empty")
            }

            // Return Base64-encoded Opus bytes
            val base64Encoded = Base64.encodeToString(opusBytes, Base64.NO_WRAP)
            val compressionRatio = (pcmSamples.size * 2).toFloat() / opusBytes.size

            Log.d(TAG, "✅ Encoded ${pcmSamples.size} samples → ${opusBytes.size} bytes (ratio: ${String.format("%.1f", compressionRatio)}x)")
            promise.resolve(base64Encoded)
        } catch (e: Exception) {
            Log.e(TAG, "❌ Encode failed: ${e.message}")
            promise.reject("ENCODE_FAILED", e.message)
        }
    }

    /**
     * Decode Base64-encoded Opus to PCM samples
     * Input: Base64-encoded Opus bitstream
     * Output: Array of Int16 PCM samples
     */
    @ReactMethod
    fun decode(base64String: String, promise: Promise) {
        if (!nativeLibraryAvailable) {
            val message = "Native Opus library unavailable on this device"
            Log.w(TAG, message)
            promise.reject("OPUS_UNAVAILABLE", message)
            return
        }

        try {
            if (base64String.isEmpty()) {
                throw Exception("Base64 string is empty")
            }

            // Decode Base64 to opus bytes
            val opusBytes = Base64.decode(base64String, Base64.NO_WRAP)

            if (opusBytes.isEmpty()) {
                throw Exception("Decoded opus bytes are empty")
            }

            // Call native decode
            val pcmSamples = decodeOpus(opusBytes, opusBytes.size, FRAME_SIZE)

            if (pcmSamples == null || pcmSamples.isEmpty()) {
                throw Exception("Failed to decode: opus_decode returned null or empty")
            }

            // Convert to ReadableArray
            val result = Arguments.createArray()
            for (sample in pcmSamples) {
                result.pushInt(sample.toInt())
            }

            Log.d(TAG, "✅ Decoded ${opusBytes.size} bytes → ${pcmSamples.size} samples")
            promise.resolve(result)
        } catch (e: Exception) {
            Log.e(TAG, "❌ Decode failed: ${e.message}")
            promise.reject("DECODE_FAILED", e.message)
        }
    }

    @ReactMethod
    fun addListener(e: String) {}

    @ReactMethod
    fun removeListeners(n: Int) {}

    // Native methods (JNI bindings to libopus C functions)
    private external fun _initEncoder(sampleRate: Int, channels: Int, bitrate: Int): Int
    private external fun _initDecoder(sampleRate: Int, channels: Int): Int
    private external fun encodeOpus(pcmSamples: ShortArray, sampleCount: Int): ByteArray
    private external fun decodeOpus(opusBytes: ByteArray, dataLength: Int, frameSize: Int): ShortArray
}

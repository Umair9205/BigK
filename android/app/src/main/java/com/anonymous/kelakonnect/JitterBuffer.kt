package com.anonymous.kelakonnect

import android.util.Log
import java.util.*

/**
 * JitterBuffer — Manages audio frame reordering, loss concealment, and timing
 * Handles out-of-order packets and provides smooth playback
 */
class JitterBuffer(private val maxDelayMs: Int = 120) {
    companion object {
        private const val TAG = "JitterBuffer"
        private const val FRAME_SIZE = 320 // 20ms at 16kHz
        private const val SAMPLE_RATE = 16000
    }

    private data class AudioFrame(
        val sequenceNumber: Int,
        val timestamp: Long,
        val data: ByteArray
    )

    private val buffer = TreeMap<Int, AudioFrame>()
    private var nextSequenceNumber = 0
    private var lastPlayedSequence = -1
    private var initialized = false

    // Metrics
    private var totalFramesReceived = 0
    private var totalFramesLost = 0
    private var currentBufferDepth = 0

    /**
     * Add incoming audio frame to buffer
     */
    fun addFrame(sequenceNumber: Int, data: ByteArray) {
        synchronized(buffer) {
            totalFramesReceived++

            if (!initialized) {
                nextSequenceNumber = sequenceNumber
                initialized = true
                Log.d(TAG, "JitterBuffer initialized with sequence: $sequenceNumber")
            }

            // Check for gaps (packet loss)
            val expectedSeq = nextSequenceNumber
            if (sequenceNumber < expectedSeq) {
                Log.w(TAG, "Out-of-order frame: $sequenceNumber (expected $expectedSeq or later)")
                return // Discard old frames
            }

            if (sequenceNumber > expectedSeq) {
                val loss = sequenceNumber - expectedSeq
                totalFramesLost += loss
                Log.w(TAG, "Packet loss detected: $loss frames lost (seq $expectedSeq → $sequenceNumber)")
            }

            // Add frame to buffer
            buffer[sequenceNumber] = AudioFrame(sequenceNumber, System.currentTimeMillis(), data)
            currentBufferDepth = buffer.size

            // Trim old frames outside jitter window
            val keysToRemove = buffer.keys.filter { key ->
                val frame = buffer[key]
                frame != null && (System.currentTimeMillis() - frame.timestamp) > maxDelayMs
            }
            keysToRemove.forEach { buffer.remove(it) }

            Log.d(TAG, "Frame added: seq=$sequenceNumber, bufferSize=${buffer.size}, totalLost=$totalFramesLost")
        }
    }

    /**
     * Get next frame for playback (in order)
     */
    fun getNextFrame(): ByteArray? {
        synchronized(buffer) {
            if (buffer.isEmpty()) {
                Log.d(TAG, "Buffer empty, returning null")
                return null
            }

            // Get the first available frame
            val firstEntry = buffer.entries.firstOrNull() ?: return null
            val frame = firstEntry.value

            // Check for gap - if gap exists, fill with silence (loss concealment)
            if (lastPlayedSequence >= 0 && frame.sequenceNumber > lastPlayedSequence + 1) {
                val gap = frame.sequenceNumber - lastPlayedSequence - 1
                Log.w(TAG, "Gap detected: $gap frames, using silence concealment")
                totalFramesLost += gap
                lastPlayedSequence++
                return ByteArray(FRAME_SIZE) // Return silence frame
            }

            // Return frame and remove from buffer
            buffer.remove(frame.sequenceNumber)
            lastPlayedSequence = frame.sequenceNumber
            currentBufferDepth = buffer.size

            Log.d(TAG, "Frame returned: seq=${frame.sequenceNumber}, bufferSize=${buffer.size}")
            return frame.data
        }
    }

    /**
     * Get buffer metrics
     */
    fun getMetrics(): Map<String, Any> {
        synchronized(buffer) {
            val lossPercentage = if (totalFramesReceived > 0) {
                ((totalFramesLost.toFloat() / totalFramesReceived) * 100).toInt()
            } else {
                0
            }

            return mapOf(
                "bufferDepth" to currentBufferDepth,
                "totalFramesReceived" to totalFramesReceived,
                "totalFramesLost" to totalFramesLost,
                "lossPercentage" to lossPercentage,
                "latencyMs" to estimateLatency()
            )
        }
    }

    /**
     * Estimate current latency in buffer
     */
    private fun estimateLatency(): Int {
        synchronized(buffer) {
            if (buffer.isEmpty()) return 0
            val firstFrame = buffer.values.firstOrNull() ?: return 0
            val ageMs = (System.currentTimeMillis() - firstFrame.timestamp).toInt()
            return ageMs
        }
    }

    /**
     * Reset buffer (e.g., on call end)
     */
    fun reset() {
        synchronized(buffer) {
            buffer.clear()
            nextSequenceNumber = 0
            lastPlayedSequence = -1
            initialized = false
            totalFramesReceived = 0
            totalFramesLost = 0
            currentBufferDepth = 0
            Log.d(TAG, "JitterBuffer reset")
        }
    }

    /**
     * Check if buffer has frames ready
     */
    fun hasFrames(): Boolean {
        synchronized(buffer) {
            return buffer.isNotEmpty()
        }
    }
}

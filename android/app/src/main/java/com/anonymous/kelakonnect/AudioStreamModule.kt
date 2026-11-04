package com.anonymous.kelakonnect

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.*
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

class AudioStreamModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val manager get() = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val muted = AtomicBoolean(false)
    @Volatile private var session: Session? = null
    private var focus: AudioFocusRequest? = null
    private data class Packet(val bytes: ByteArray, val queuedAt: Long = SystemClock.elapsedRealtime())
    private class Session(val id: String, val record: AudioRecord, val track: AudioTrack) {
        val active = AtomicBoolean(true)
        val queue = LinkedBlockingDeque<Packet>(3) // at most 60ms outside AudioTrack
        val captured = AtomicLong()
        val played = AtomicLong()
        val dropped = AtomicLong()
        var captureThread: Thread? = null
        var playbackThread: Thread? = null
    }
    override fun getName() = "AudioStreamModule"

    @ReactMethod fun startCapture(id: String, promise: Promise) {
        if (session != null) {
            if (session?.id == id) promise.resolve(true)
            else promise.reject("BUSY", "Another audio session is active")
            return
        }
        if (ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            promise.reject("MIC_PERMISSION", "Microphone permission is required"); return
        }
        var record: AudioRecord? = null
        var track: AudioTrack? = null
        try {
            muted.set(false)
            manager.mode = AudioManager.MODE_IN_COMMUNICATION
            manager.isSpeakerphoneOn = false
            val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attrs).setOnAudioFocusChangeListener { change ->
                    if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
                        session?.let { fail(it, "Audio focus lost") }
                }.build()
            focus = request
            check(manager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { "Audio focus denied" }
            val inputMin = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            check(inputMin > 0) { "16kHz recording unsupported" }
            for (source in listOf(MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                    MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC)) {
                val candidate = try {
                    AudioRecord(source, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(inputMin, 1280))
                } catch (_: Exception) { continue }
                if (candidate.state == AudioRecord.STATE_INITIALIZED) { record = candidate; break }
                candidate.release()
            }
            val input = record ?: error("AudioRecord initialization failed")
            val outputMin = AudioTrack.getMinBufferSize(16000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            check(outputMin > 0) { "16kHz playback unsupported" }
            val output = AudioTrack(attrs, AudioFormat.Builder().setSampleRate(16000)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build(),
                maxOf(outputMin, 1280), AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE)
            track = output
            check(output.state == AudioTrack.STATE_INITIALIZED) { "AudioTrack initialization failed" }
            output.setBufferSizeInFrames(640)
            // Microphone foreground service starts only after permission was granted in a visible activity.
            ContextCompat.startForegroundService(reactApplicationContext, Intent(reactApplicationContext, CallForegroundService::class.java))
            input.startRecording()
            check(input.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Microphone did not start" }
            output.play()
            val current = Session(id, input, output)
            session = current
            current.captureThread = Thread({ capture(current) }, "CallCapture").apply { start() }
            current.playbackThread = Thread({ play(current) }, "CallPlayback").apply { start() }
            Log.i("AudioStreamModule", "Ready session=$id frameMs=20 trackBufferFrames=${output.bufferSizeInFrames}")
            promise.resolve(true)
        } catch (e: Exception) {
            try { record?.release() } catch (_: Exception) {}
            try { track?.release() } catch (_: Exception) {}
            releaseFocus()
            reactApplicationContext.stopService(Intent(reactApplicationContext, CallForegroundService::class.java))
            promise.reject("AUDIO_START_FAILED", e)
        }
    }
    private fun capture(s: Session) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
        val bytes = ByteArray(640)
        var offset = 0
        try {
            while (s.active.get()) {
                val count = s.record.read(bytes, offset, bytes.size - offset, AudioRecord.READ_BLOCKING)
                check(count > 0) { "AudioRecord read returned $count" }
                offset += count
                if (offset != bytes.size) continue
                offset = 0
                if (muted.get()) bytes.fill(0) // preserve sequence/timing while muted
                val number = s.captured.getAndIncrement()
                emit("onAudioCaptured", Arguments.createMap().apply {
                    putString("sessionId", s.id); putDouble("frameNumber", number.toDouble())
                    putString("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                })
            }
        } catch (e: Exception) { if (s.active.get()) fail(s, e.message ?: "Capture failed") }
        finally { try { s.record.release() } catch (_: Exception) {} }
    }
    private fun play(s: Session) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
        try {
            while (s.active.get()) {
                val packet = s.queue.poll(100, TimeUnit.MILLISECONDS) ?: continue
                if (SystemClock.elapsedRealtime() - packet.queuedAt > 80) { s.dropped.incrementAndGet(); continue }
                var offset = 0
                while (s.active.get() && offset < packet.bytes.size) {
                    val n = s.track.write(packet.bytes, offset, packet.bytes.size - offset, AudioTrack.WRITE_BLOCKING)
                    check(n > 0) { "AudioTrack write returned $n" }
                    offset += n
                }
                s.played.incrementAndGet()
            }
        } catch (e: Exception) { if (s.active.get()) fail(s, e.message ?: "Playback failed") }
        finally { try { s.track.release() } catch (_: Exception) {} }
    }
    @ReactMethod fun playback(id: String, base64: String, promise: Promise) {
        val s = session
        if (s == null || s.id != id || !s.active.get()) { promise.resolve(false); return }
        try {
            val bytes = Base64.decode(base64, Base64.NO_WRAP)
            require(bytes.size == 640) { "Expected one 20ms PCM frame" }
            val packet = Packet(bytes)
            if (!s.queue.offer(packet)) {
                s.queue.poll(); s.dropped.incrementAndGet(); s.queue.offer(packet)
            }
            promise.resolve(true) // queued, not a claim of audible playback
        } catch (e: Exception) { promise.reject("PLAYBACK_FAILED", e) }
    }
    private fun fail(s: Session, message: String) {
        if (!s.active.getAndSet(false)) return
        emit("onCaptureError", Arguments.createMap().apply {
            putString("sessionId", s.id); putString("error", message)
        })
    }
    @ReactMethod fun logStats(id: String) {
        val s = session ?: return
        if (s.id == id && s.active.get()) {
            try {
                Log.i("CallMetrics", "session=$id captured=${s.captured.get()} played=${s.played.get()} nativeDropped=${s.dropped.get()} nativeQueueMs=${s.queue.size * 20} underruns=${s.track.underrunCount}")
            } catch (_: IllegalStateException) { /* session is stopping */ }
        }
    }
    @ReactMethod fun stopCapture() {
        val s = session
        session = null
        if (s != null) {
            s.active.set(false); s.queue.clear()
            try { s.record.stop() } catch (_: Exception) {}
            try { s.track.pause(); s.track.flush() } catch (_: Exception) {}
            s.playbackThread?.interrupt()
        }
        releaseFocus()
        reactApplicationContext.stopService(Intent(reactApplicationContext, CallForegroundService::class.java))
    }
    private fun releaseFocus() {
        focus?.let { manager.abandonAudioFocusRequest(it) }; focus = null
        manager.isSpeakerphoneOn = false
        manager.mode = AudioManager.MODE_NORMAL
    }
    @ReactMethod fun setMuted(value: Boolean) { muted.set(value) }
    @ReactMethod fun isMuted(promise: Promise) = promise.resolve(muted.get())
    @ReactMethod fun setSpeakerOn(value: Boolean) { manager.isSpeakerphoneOn = value }
    @ReactMethod fun isSpeakerOn(promise: Promise) = promise.resolve(manager.isSpeakerphoneOn)
    @ReactMethod fun addListener(name: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
    private fun emit(name: String, data: WritableMap) {
        reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, data)
    }
    override fun invalidate() { stopCapture(); super.invalidate() }
}

package fun.upup.musicfree.mpvplayer;

import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter
import dev.jdtech.mpv.MPVLib
import com.facebook.react.bridge.UiThreadUtil
import java.util.*
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class MpvPlayerModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext), dev.jdtech.mpv.MPVLib.EventObserver {

    private var player: MPVLib? = null
    private var progressScheduler: ScheduledExecutorService? = null
    private val isPlaying = AtomicBoolean(false)
    private val isInitialized = AtomicBoolean(false)

    companion object {
        private const val TAG = "MpvPlayerModule"
        // Event Names
        private const val ON_MPV_PLAY_STATE_CHANGED = "onMpvPlayStateChanged"
        private const val ON_MPV_PROGRESS = "onMpvProgress"
        private const val ON_MPV_ENDED = "onMpvEnded"
        private const val ON_MPV_ERROR = "onMpvError"
        private const val ON_MPV_BUFFER = "onMpvBuffer"
        private const val ON_MPV_VOLUME_CHANGED = "onMpvVolumeChanged"
        private const val ON_MPV_RATE_CHANGED = "onMpvRateChanged"
    }

    override fun getName() = "MpvPlayer"

    private fun sendEvent(eventName: String, params: WritableMap?) {
        reactContext
            .getJSModule(RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    @ReactMethod
    fun initialize(options: ReadableMap, promise: Promise) {
        if (isInitialized.get()) {
            promise.resolve("Already initialized")
            return
        }
        
        UiThreadUtil.runOnUiThread {
            try {
                player = MPVLib.create(reactContext.applicationContext).apply {
                    init()
                    addObserver(this@MpvPlayerModule)

                    // Set options
                    options.getString("ao")?.let { setOptionString("ao", it) }
                    options.getString("vo")?.let { setOptionString("vo", it) }
                    options.getBoolean("cache")?.let { setOptionString("cache", if(it) "yes" else "no") }
                    options.getInt("demuxer-max-bytes")?.let { setOptionString("demuxer-max-bytes", (it * 1024 * 1024).toString()) }
                    options.getInt("demuxer-readahead-secs")?.let { setOptionString("demuxer-readahead-secs", it.toString()) }
                    options.getInt("network-timeout")?.let { setOptionString("network-timeout", it.toString()) }
                    options.getString("msg-level")?.let { setOptionString("msg-level", it) }
                    options.getString("hwdec")?.let { setOptionString("hwdec", it) }
                    options.getString("userAgent")?.let { setOptionString("user-agent", it) }
                }

                // Observe properties
                player?.observeProperty("pause", MPVLib.MPV_FORMAT_FLAG)
                player?.observeProperty("time-pos", MPVLib.MPV_FORMAT_INT64)
                player?.observeProperty("duration", MPVLib.MPV_FORMAT_INT64)
                player?.observeProperty("idle-active", MPVLib.MPV_FORMAT_FLAG)
                player?.observeProperty("volume", MPVLib.MPV_FORMAT_INT64)
                player?.observeProperty("speed", MPVLib.MPV_FORMAT_DOUBLE)
                player?.observeProperty("seeking", MPVLib.MPV_FORMAT_FLAG)
                player?.observeProperty("paused-for-cache", MPVLib.MPV_FORMAT_FLAG)
                player?.observeProperty("playback-error", MPVLib.MPV_FORMAT_STRING)
                player?.observeProperty("demuxer-cache-duration", MPVLib.MPV_FORMAT_INT64)
                
                isInitialized.set(true)
                promise.resolve("Initialization successful")
            } catch (e: Exception) {
                Log.e(TAG, "Initialization failed", e)
                promise.reject("E_INIT_FAILED", e)
            }
        }
    }

    @ReactMethod
    fun destroy(promise: Promise) {
        if (!isInitialized.get()) {
            promise.resolve("Already destroyed or not initialized")
            return
        }
        UiThreadUtil.runOnUiThread {
            stopProgressTimer()
            player?.removeObserver(this)
            player?.destroy()
            player = null
            isInitialized.set(false)
            isPlaying.set(false)
            promise.resolve("Destroyed successfully")
        }
    }

    private fun headersToString(headers: ReadableMap?): String {
        if (headers == null) return ""
        val stringBuilder = StringBuilder()
        val iterator = headers.keySetIterator()
        while (iterator.hasNextKey()) {
            val key = iterator.nextKey()
            stringBuilder.append("$key: ${headers.getString(key)}\r\n")
        }
        return stringBuilder.toString()
    }

    @ReactMethod
    fun loadAndPlay(params: ReadableMap, promise: Promise) {
        if (!isInitialized.get()) {
            promise.reject("E_NOT_INITIALIZED", "Player not initialized")
            return
        }
        val url = params.getString("url")
        if (url.isNullOrEmpty()) {
            promise.reject("E_INVALID_URL", "URL is null or empty")
            return
        }

        UiThreadUtil.runOnUiThread {
            try {
                // Set headers if available
                val headers = params.getMap("headers")
                if (headers != null) {
                    val headersString = headersToString(headers)
                    if (headersString.isNotEmpty()) {
                        player?.setOptionString("http-header-fields", headersString)
                    }
                }
                
                // Set metadata
                params.getString("title")?.let { player?.setPropertyString("media-title", it) }
                params.getString("artist")?.let { player?.setPropertyString("artist", it) }
                params.getString("album")?.let { player?.setPropertyString("album", it) }

                player?.command(arrayOf("loadfile", url))
                promise.resolve("Load command sent")
            } catch (e: Exception) {
                promise.reject("E_LOAD_FAILED", e)
            }
        }
    }

    @ReactMethod
    fun pause(promise: Promise) {
        if (!isInitialized.get()) {
            promise.reject("E_NOT_INITIALIZED", "Player not initialized")
            return
        }
        UiThreadUtil.runOnUiThread {
            player?.setPropertyBoolean("pause", true)
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun resume(promise: Promise) {
        if (!isInitialized.get()) {
            promise.reject("E_NOT_INITIALIZED", "Player not initialized")
            return
        }
        UiThreadUtil.runOnUiThread {
            player?.setPropertyBoolean("pause", false)
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        if (!isInitialized.get()) {
            promise.reject("E_NOT_INITIALIZED", "Player not initialized")
            return
        }
        UiThreadUtil.runOnUiThread {
            player?.command(arrayOf("stop"))
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun seekTo(seconds: Double, promise: Promise) {
        if (!isInitialized.get()) {
            promise.reject("E_NOT_INITIALIZED", "Player not initialized")
            return
        }
        UiThreadUtil.runOnUiThread {
            player?.command(arrayOf("seek", seconds.toString(), "absolute"))
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun setVolume(volume: Double, promise: Promise) {
        if (!isInitialized.get()) {
            promise.reject("E_NOT_INITIALIZED", "Player not initialized")
            return
        }
        UiThreadUtil.runOnUiThread {
            // Convert from 0-1 to 0-100 for MPV
            val mpvVolume = (volume * 100).toInt().coerceIn(0, 100)
            player?.setPropertyInt("volume", mpvVolume)
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun setRate(rate: Double, promise: Promise) {
        if (!isInitialized.get()) {
            promise.reject("E_NOT_INITIALIZED", "Player not initialized")
            return
        }
        UiThreadUtil.runOnUiThread {
            player?.setPropertyDouble("speed", rate)
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun getIsPlaying(promise: Promise) {
        promise.resolve(isPlaying.get())
    }

    @ReactMethod
    fun getPosition(promise: Promise) {
        if (!isInitialized.get()) {
            promise.reject("E_NOT_INITIALIZED", "Player not initialized")
            return
        }
        UiThreadUtil.runOnUiThread {
            try {
                val position = player?.getPropertyInt("time-pos") ?: 0
                promise.resolve(position)
            } catch (e: Exception) {
                promise.reject("E_GET_POS", e)
            }
        }
    }

    @ReactMethod
    fun getDuration(promise: Promise) {
        if (!isInitialized.get()) {
            promise.reject("E_NOT_INITIALIZED", "Player not initialized")
            return
        }
        UiThreadUtil.runOnUiThread {
            try {
                val duration = player?.getPropertyInt("duration") ?: 0
                promise.resolve(duration)
            } catch (e: Exception) {
                promise.reject("E_GET_DUR", e)
            }
        }
    }

    // MPVLib.EventObserver Implementation
    override fun eventProperty(property: String, value: Long) {
        val params = Arguments.createMap()
        when (property) {
            "volume" -> {
                params.putDouble("volume", value.toDouble() / 100.0)
                sendEvent(ON_MPV_VOLUME_CHANGED, params)
            }
            "time-pos" -> { /* Handled by timer */ }
            "duration" -> { /* Handled by timer */ }
            "demuxer-cache-duration" -> { /* Handled by timer */ }
        }
    }

    override fun eventProperty(property: String, value: Boolean) {
        val params = Arguments.createMap()
        when (property) {
            "pause" -> {
                val isIdle = player?.getPropertyBoolean("idle-active") ?: true
                val currentlyPlaying = !value && !isIdle
                isPlaying.set(currentlyPlaying)
                if (currentlyPlaying) {
                    startProgressTimer()
                } else {
                    stopProgressTimer()
                }
                params.putBoolean("isPlaying", isPlaying.get())
                sendEvent(ON_MPV_PLAY_STATE_CHANGED, params)
            }
            "idle-active" -> {
                val isIdle = value
                if (isIdle) {
                    isPlaying.set(false)
                    stopProgressTimer()
                    params.putBoolean("isPlaying", false)
                    sendEvent(ON_MPV_PLAY_STATE_CHANGED, params)
                }
            }
            "seeking" -> {
                // Optional: handle seeking state if needed
            }
            "paused-for-cache" -> {
                params.putBoolean("isBuffering", value)
                sendEvent(ON_MPV_BUFFER, params)
            }
        }
    }

    override fun eventProperty(property: String, value: Double) {
        val params = Arguments.createMap()
        when (property) {
            "speed" -> {
                params.putDouble("rate", value)
                sendEvent(ON_MPV_RATE_CHANGED, params)
            }
        }
    }

    override fun eventProperty(property: String, value: String) {
        val params = Arguments.createMap()
        when (property) {
            "playback-error" -> {
                Log.e(TAG, "MPV Playback Error: $value")
                params.putString("error", value)
                sendEvent(ON_MPV_ERROR, params)
                stopProgressTimer()
                isPlaying.set(false)
            }
        }
    }

    override fun event(eventId: Int) {
        when (eventId) {
            MPVLib.MPV_EVENT_END_FILE -> {
                Log.d(TAG, "Playback ended")
                isPlaying.set(false)
                stopProgressTimer()
                sendEvent(ON_MPV_ENDED, null)
            }
            MPVLib.MPV_EVENT_ERROR -> {
                val error = player?.getPropertyString("error") ?: "Unknown error"
                Log.e(TAG, "MPV Event Error: $error")
                val params = Arguments.createMap()
                params.putString("error", error)
                sendEvent(ON_MPV_ERROR, params)
                stopProgressTimer()
                isPlaying.set(false)
            }
        }
    }

    private fun startProgressTimer() {
        if (progressScheduler != null && !progressScheduler!!.isShutdown) {
            return // Timer already running
        }
        progressScheduler = Executors.newSingleThreadScheduledExecutor()
        progressScheduler?.scheduleAtFixedRate({
            try {
                if (!isPlaying.get() || player == null) return@scheduleAtFixedRate

                val position = player?.getPropertyInt("time-pos") ?: 0
                val duration = player?.getPropertyInt("duration") ?: 0
                val buffer = player?.getPropertyInt("demuxer-cache-duration") ?: 0
                
                val params = Arguments.createMap().apply {
                    putDouble("position", position.toDouble())
                    putDouble("duration", duration.toDouble())
                    putDouble("buffer", buffer.toDouble())
                }
                sendEvent(ON_MPV_PROGRESS, params)
            } catch (e: Exception) {
                Log.e(TAG, "Progress timer exception", e)
            }
        }, 0, 500, TimeUnit.MILLISECONDS)
    }

    private fun stopProgressTimer() {
        progressScheduler?.shutdown()
        progressScheduler = null
    }
}
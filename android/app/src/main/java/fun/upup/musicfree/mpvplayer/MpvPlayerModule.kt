package `fun`.upup.musicfree.mpvplayer
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter
import dev.jdtech.mpv.MPVLib
import java.util.*
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

class MpvPlayerModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext), dev.jdtech.mpv.MPVLib.EventObserver {

    private val isPlaying = AtomicBoolean(false)
    private val isInitialized = AtomicBoolean(false)
    private val position = AtomicLong(0)
    private val duration = AtomicLong(0)

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
                MPVLib.create(reactContext.applicationContext)

                // Set options with safety checks
                if (options.hasKey("ao")) options.getString("ao")?.let { MPVLib.setOptionString("ao", it) }
                if (options.hasKey("vo")) options.getString("vo")?.let { MPVLib.setOptionString("vo", it) }
                if (options.hasKey("cache")) MPVLib.setOptionString("cache", if(options.getBoolean("cache")) "yes" else "no")
                if (options.hasKey("demuxer-max-bytes")) MPVLib.setOptionString("demuxer-max-bytes", (options.getInt("demuxer-max-bytes") * 1024 * 1024).toString())
                if (options.hasKey("demuxer-readahead-secs")) MPVLib.setOptionString("demuxer-readahead-secs", options.getInt("demuxer-readahead-secs").toString())
                if (options.hasKey("network-timeout")) MPVLib.setOptionString("network-timeout", options.getInt("network-timeout").toString())
                if (options.hasKey("msg-level")) options.getString("msg-level")?.let { MPVLib.setOptionString("msg-level", it) }
                if (options.hasKey("hwdec")) options.getString("hwdec")?.let { MPVLib.setOptionString("hwdec", it) }
                if (options.hasKey("userAgent")) options.getString("userAgent")?.let { MPVLib.setOptionString("user-agent", it) }
                MPVLib.setOptionString("keep-open", "always")

                MPVLib.init()

                MPVLib.addObserver(this@MpvPlayerModule)

                // Observe properties
                MPVLib.observeProperty("pause", MPVLib.MPV_FORMAT_FLAG)
                MPVLib.observeProperty("time-pos", MPVLib.MPV_FORMAT_INT64)
                MPVLib.observeProperty("duration", MPVLib.MPV_FORMAT_INT64)
                MPVLib.observeProperty("idle-active", MPVLib.MPV_FORMAT_FLAG)
                MPVLib.observeProperty("volume", MPVLib.MPV_FORMAT_INT64)
                MPVLib.observeProperty("speed", MPVLib.MPV_FORMAT_DOUBLE)
                MPVLib.observeProperty("seeking", MPVLib.MPV_FORMAT_FLAG)
                MPVLib.observeProperty("paused-for-cache", MPVLib.MPV_FORMAT_FLAG)
                MPVLib.observeProperty("playback-error", MPVLib.MPV_FORMAT_STRING)
                MPVLib.observeProperty("demuxer-cache-duration", MPVLib.MPV_FORMAT_INT64)

                isInitialized.set(true)
                promise.resolve("Initialization successful")
            } catch (e: Exception) {
                Log.e(TAG, "MPV player initialization failed", e)
                // Attempt to clean up resources, simplified to avoid Promise implementation issues.
                try {
                    MPVLib.destroy()
                } catch (cleanupException: Exception) {
                    Log.e(TAG, "Error during resource cleanup after initialization failure", cleanupException)
                } finally {
                    isInitialized.set(false)
                    isPlaying.set(false)
                }
                promise.reject("E_MPV_INIT", "MPV player initialization failed", e)
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
            try {
                MPVLib.removeObserver(this)
                MPVLib.command(arrayOf("stop"))
                MPVLib.destroy()
            } catch (e: Exception) {
                Log.e(TAG, "Error during MPV destroy", e)
            } finally {
                isInitialized.set(false)
                isPlaying.set(false)
                promise.resolve("Destroyed successfully")
            }
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
    fun loadAndPlay(track: ReadableMap) {
        val path = track.getString("url")
        if (path.isNullOrEmpty()) {
            Log.e(TAG, "loadAndPlay: received track with null or empty url")
            return
        }
        Log.d(TAG, "loadAndPlay: $path")
        UiThreadUtil.runOnUiThread {
            MPVLib.command(arrayOf("loadfile", path))
            MPVLib.setPropertyBoolean("pause", false)
        }
    }

    @ReactMethod
    fun pause(promise: Promise) {
        if (!isInitialized.get()) {
            promise.reject("E_NOT_INITIALIZED", "Player not initialized")
            return
        }
        UiThreadUtil.runOnUiThread {
            MPVLib.setPropertyBoolean("pause", true)
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
            MPVLib.setPropertyBoolean("pause", false)
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
            MPVLib.command(arrayOf("stop"))
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
            MPVLib.command(arrayOf("seek", seconds.toString(), "absolute"))
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
            MPVLib.setPropertyInt("volume", mpvVolume)
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
            MPVLib.setPropertyDouble("speed", rate)
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
                val position = MPVLib.getPropertyInt("time-pos") ?: 0
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
                val duration = MPVLib.getPropertyInt("duration") ?: 0
                promise.resolve(duration)
            } catch (e: Exception) {
                promise.reject("E_GET_DUR", e)
            }
        }
    }

    // MPVLib.EventObserver Implementation
    override fun eventProperty(property: String) {
        Log.d(TAG, "Received eventProperty (String only): $property")
    }

    override fun eventProperty(property: String, value: Long) {
        when (property) {
            "time-pos" -> position.set(value)
            "duration" -> duration.set(value)
            "volume" -> {
                val params = Arguments.createMap()
                params.putDouble("volume", value.toDouble() / 100.0)
                sendEvent(ON_MPV_VOLUME_CHANGED, params)
                // Return early to prevent sending a progress event on volume change
                return
            }
            "demuxer-cache-duration" -> {
                // This can be used to update buffer progress if needed
                return
            }
        }

        // For time-pos or duration updates, send a progress event
        if (property == "time-pos" || property == "duration") {
            val progressMap = Arguments.createMap()
            progressMap.putInt("position", position.get().toInt())
            progressMap.putInt("duration", duration.get().toInt())
            sendEvent(ON_MPV_PROGRESS, progressMap)
        }
    }

    override fun eventProperty(property: String, value: Boolean) {
        val params = Arguments.createMap()
        when (property) {
            "pause" -> {
                val isIdle = MPVLib.getPropertyBoolean("idle-active") ?: true
                val currentlyPlaying = !value && !isIdle
                isPlaying.set(currentlyPlaying)
                params.putBoolean("isPlaying", isPlaying.get())
                sendEvent(ON_MPV_PLAY_STATE_CHANGED, params)
            }
            "idle-active" -> {
                val isIdle = value
                if (isIdle) {
                    isPlaying.set(false)
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
                isPlaying.set(false)
            }
        }
    }

    override fun event(eventId: Int) {
        when (eventId) {
            MPVLib.MPV_EVENT_END_FILE -> {
                Log.d(TAG, "event: MPV_EVENT_END_FILE")
                isPlaying.set(false)
                sendEvent(ON_MPV_ENDED, null)
            }
            MPVLib.MPV_EVENT_SHUTDOWN -> {
                Log.e(TAG, "MPV Shutdown Event (eventId: $eventId)")
                val errorProperty = MPVLib.getPropertyString("error")
                val playbackErrorProperty = MPVLib.getPropertyString("playback-error")
                val errorMsg = errorProperty ?: playbackErrorProperty ?: "MPV Shutdown or Unknown Error"

                if (errorProperty != null || playbackErrorProperty != null) {
                    Log.e(TAG, "MPV Error associated with Shutdown: $errorMsg")
                    val params = Arguments.createMap()
                    params.putString("error", errorMsg)
                    sendEvent(ON_MPV_ERROR, params)
                } else {
                    Log.w(TAG, "MPV Shutdown without explicit error property, treating as potential error or end.")
                    val params = Arguments.createMap()
                    params.putString("error", "MPV Shutdown")
                    sendEvent(ON_MPV_ERROR, params)
                }
                isPlaying.set(false)
            }
        }
    }

}
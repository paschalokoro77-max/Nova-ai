package ai.novatrade.companion.capture

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import ai.novatrade.companion.R
import ai.novatrade.companion.accessibility.TradingAccessibilityService
import ai.novatrade.companion.apps.TradingAppDetector
import ai.novatrade.companion.network.NovaTradeApiClient
import ai.novatrade.companion.security.SecureTokenStore
import ai.novatrade.companion.state.CompanionRuntimeState
import ai.novatrade.companion.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream

/**
 * Foreground service managing user-authorized MediaProjection capture and secure upload
 * to NovaTrade AI's existing /api/android/screen/analyze and /api/android/device/poll routes.
 */
class ScreenCaptureService : Service() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var tokenStore: SecureTokenStore
    private val apiClient = NovaTradeApiClient()

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var captureWidth = 720
    private var captureHeight = 1280
    private var autoLoopJob: Job? = null

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            stopCaptureInternal("MediaProjection stopped by Android OS.")
        }
    }

    override fun onCreate() {
        super.onCreate()
        tokenStore = SecureTokenStore(this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START_PROJECTION -> {
                if (tokenStore.emergencyStopEngaged) {
                    CompanionRuntimeState.setStatusMessage("Emergency stop is engaged. Clear stop before starting capture.")
                    stopSelf()
                    return START_NOT_STICKY
                }
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
                val resultData: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(EXTRA_RESULT_DATA)
                }
                if (resultCode != Activity.RESULT_OK || resultData == null) {
                    CompanionRuntimeState.setStatusMessage("Screen capture permission was not granted.")
                    stopSelf()
                    return START_NOT_STICKY
                }
                promoteToForeground()
                startProjection(resultCode, resultData)
            }

            ACTION_CAPTURE_ONCE -> {
                val notes = intent.getStringExtra(EXTRA_NOTES)
                serviceScope.launch { captureAndAnalyze(notes) }
            }

            ACTION_SET_AUTO_INTERVAL -> {
                val enabled = intent.getBooleanExtra(EXTRA_AUTO_INTERVAL, false)
                setAutoCaptureLoop(enabled)
            }

            ACTION_STOP -> {
                stopCaptureInternal("Screen capture stopped.")
            }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopCaptureInternal(null)
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun promoteToForeground() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun startProjection(resultCode: Int, resultData: Intent) {
        releaseProjectionResources()
        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val projection = mgr.getMediaProjection(resultCode, resultData)
        if (projection == null) {
            CompanionRuntimeState.setStatusMessage("Unable to initialize MediaProjection session.")
            stopSelf()
            return
        }

        val (width, height, dpi) = resolveDisplayMetrics()
        captureWidth = width
        captureHeight = height

        projection.registerCallback(projectionCallback, Handler(Looper.getMainLooper()))
        val reader = ImageReader.newInstance(captureWidth, captureHeight, PixelFormat.RGBA_8888, 2)
        val display = projection.createVirtualDisplay(
            "NovaTradeScreenBridge",
            captureWidth,
            captureHeight,
            dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface,
            null,
            null
        )

        mediaProjection = projection
        imageReader = reader
        virtualDisplay = display
        CompanionRuntimeState.setCaptureRunning(true)
        CompanionRuntimeState.setStatusMessage("Screen capture active. Ready to analyze MT5 / IQ Option.")

        serviceScope.launch { sendHeartbeat() }
    }

    private fun setAutoCaptureLoop(enabled: Boolean) {
        autoLoopJob?.cancel()
        CompanionRuntimeState.setAutoIntervalEnabled(enabled)
        if (!enabled) return
        autoLoopJob = serviceScope.launch {
            while (isActive && CompanionRuntimeState.captureRunning.value && !tokenStore.emergencyStopEngaged) {
                val fgPkg = CompanionRuntimeState.accessibilitySnapshot.value.foregroundPackage
                val shouldAnalyze = fgPkg == null || TradingAppDetector.isTargetTradingPackage(fgPkg)
                if (shouldAnalyze) {
                    captureAndAnalyze("Scheduled 15s mobile screen check")
                }
                delay(15_000L)
            }
        }
    }

    private suspend fun captureAndAnalyze(notes: String?) {
        if (tokenStore.emergencyStopEngaged || CompanionRuntimeState.emergencyStop.value) {
            stopCaptureInternal("Emergency stop engaged.")
            return
        }
        val token = tokenStore.deviceToken
        val baseUrl = tokenStore.serverBaseUrl
        if (token.isNullOrBlank() || baseUrl.isBlank()) {
            CompanionRuntimeState.setStatusMessage("Pair this phone with NovaTrade AI before analyzing screens.")
            return
        }

        val jpegBase64 = captureFrameAsJpegBase64()
        if (jpegBase64 == null) {
            CompanionRuntimeState.setStatusMessage("No screen frame ready yet. Switch briefly or retry capture.")
            return
        }

        CompanionRuntimeState.setStatusMessage("Uploading screen frame for Gemini + Quant analysis...")

        val a11y = CompanionRuntimeState.accessibilitySnapshot.value
        val appHint = if (TradingAppDetector.isTargetTradingPackage(a11y.foregroundPackage)) {
            a11y.foregroundPackage
        } else {
            tokenStore.selectedAppPackage
        }

        val hb = apiClient.sendHeartbeat(
            baseUrl = baseUrl,
            token = token,
            appPackage = appHint,
            mediaProjection = CompanionRuntimeState.captureRunning.value,
            accessibility = TradingAccessibilityService.isServiceEnabled(this)
        )
        hb.onSuccess { status ->
            if (status.emergencyStop) {
                tokenStore.emergencyStopEngaged = true
                CompanionRuntimeState.setEmergencyStop(true)
                stopCaptureInternal("Server emergency stop is active.")
                return
            }
        }

        val result = apiClient.analyzeScreen(
            baseUrl = baseUrl,
            token = token,
            imageBase64 = jpegBase64,
            mimeType = "image/jpeg",
            appPackageHint = appHint,
            accessibilityText = a11y.visibleNodes,
            notes = notes
        )

        result.onSuccess { analysis ->
            CompanionRuntimeState.updateLatestAnalysis(analysis)
            CompanionRuntimeState.setStatusMessage(
                "Analyzed ${analysis.appName}: ${analysis.normalizedSymbol ?: analysis.detectedSymbol ?: "?"} -> ${analysis.recommendedAction} (${analysis.confidenceScore}/100)"
            )
            val poll = apiClient.pollAuthorizedActions(baseUrl, token)
            poll.onSuccess { pollRes ->
                if (pollRes.emergencyStop) {
                    tokenStore.emergencyStopEngaged = true
                    CompanionRuntimeState.setEmergencyStop(true)
                } else {
                    CompanionRuntimeState.updateAuthorizedActions(pollRes.actions)
                }
            }
        }.onFailure { err ->
            CompanionRuntimeState.setStatusMessage("Analysis error: ${err.message ?: "Request failed"}")
        }
    }

    private suspend fun sendHeartbeat() {
        val token = tokenStore.deviceToken ?: return
        val baseUrl = tokenStore.serverBaseUrl
        if (baseUrl.isBlank()) return
        apiClient.sendHeartbeat(
            baseUrl = baseUrl,
            token = token,
            appPackage = tokenStore.selectedAppPackage,
            mediaProjection = CompanionRuntimeState.captureRunning.value,
            accessibility = TradingAccessibilityService.isServiceEnabled(this)
        )
    }

    private suspend fun captureFrameAsJpegBase64(): String? {
        val reader = imageReader ?: return null
        var image = reader.acquireLatestImage()
        var attempts = 0
        while (image == null && attempts < 6) {
            delay(80L)
            image = reader.acquireLatestImage()
            attempts++
        }
        val activeImage = image ?: return null

        return try {
            val plane = activeImage.planes[0]
            val buffer = plane.buffer
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val rowPadding = rowStride - pixelStride * activeImage.width
            val rawBitmap = Bitmap.createBitmap(
                activeImage.width + rowPadding / pixelStride,
                activeImage.height,
                Bitmap.Config.ARGB_8888
            )
            rawBitmap.copyPixelsFromBuffer(buffer)
            val cropped = Bitmap.createBitmap(rawBitmap, 0, 0, activeImage.width, activeImage.height)
            if (cropped !== rawBitmap) rawBitmap.recycle()

            val out = ByteArrayOutputStream()
            cropped.compress(Bitmap.CompressFormat.JPEG, 82, out)
            cropped.recycle()
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } catch (_: Exception) {
            null
        } finally {
            activeImage.close()
        }
    }

    private fun resolveDisplayMetrics(): Triple<Int, Int, Int> {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val dm = resources.displayMetrics
        val rawWidth = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            wm.currentWindowMetrics.bounds.width()
        } else {
            dm.widthPixels
        }
        val rawHeight = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            wm.currentWindowMetrics.bounds.height()
        } else {
            dm.heightPixels
        }
        val scale = if (rawWidth > 1080) 1080f / rawWidth else 0.75f
        val w = (rawWidth * scale).toInt().coerceIn(540, 1080)
        val h = (rawHeight * scale).toInt().coerceIn(900, 1920)
        return Triple(w, h, dm.densityDpi)
    }

    private fun stopCaptureInternal(statusMsg: String?) {
        autoLoopJob?.cancel()
        autoLoopJob = null
        releaseProjectionResources()
        CompanionRuntimeState.setCaptureRunning(false)
        CompanionRuntimeState.setAutoIntervalEnabled(false)
        if (statusMsg != null) CompanionRuntimeState.setStatusMessage(statusMsg)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun releaseProjectionResources() {
        try {
            virtualDisplay?.release()
        } catch (_: Exception) {
        }
        virtualDisplay = null
        try {
            imageReader?.close()
        } catch (_: Exception) {
        }
        imageReader = null
        try {
            mediaProjection?.unregisterCallback(projectionCallback)
            mediaProjection?.stop()
        } catch (_: Exception) {
        }
        mediaProjection = null
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.capture_notification_channel),
            NotificationManager.IMPORTANCE_LOW
        )
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_companion_shield)
            .setContentTitle(getString(R.string.capture_notification_title))
            .setContentText(getString(R.string.capture_notification_text))
            .setContentIntent(openIntent)
            .setOngoing(true)
            .build()
    }

    companion object {
        const val ACTION_START_PROJECTION = "ai.novatrade.companion.ACTION_START_PROJECTION"
        const val ACTION_CAPTURE_ONCE = "ai.novatrade.companion.ACTION_CAPTURE_ONCE"
        const val ACTION_SET_AUTO_INTERVAL = "ai.novatrade.companion.ACTION_SET_AUTO_INTERVAL"
        const val ACTION_STOP = "ai.novatrade.companion.ACTION_STOP"

        const val EXTRA_RESULT_CODE = "extra_result_code"
        const val EXTRA_RESULT_DATA = "extra_result_data"
        const val EXTRA_NOTES = "extra_notes"
        const val EXTRA_AUTO_INTERVAL = "extra_auto_interval"

        private const val CHANNEL_ID = "novatrade_screen_capture"
        private const val NOTIFICATION_ID = 4101
    }
}

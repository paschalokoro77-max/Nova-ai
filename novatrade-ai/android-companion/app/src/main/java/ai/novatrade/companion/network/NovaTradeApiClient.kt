package ai.novatrade.companion.network

import android.os.Build
import ai.novatrade.companion.state.AuthorizedActionUiModel
import ai.novatrade.companion.state.ScreenAnalysisUiModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class PairingResult(
    val deviceId: String,
    val deviceName: String,
    val deviceToken: String
)

data class HeartbeatResult(
    val operatingMode: String,
    val emergencyStop: Boolean
)

data class PollActionsResult(
    val actions: List<AuthorizedActionUiModel>,
    val emergencyStop: Boolean
)

/**
 * HTTPS JSON client talking directly to the existing NovaTrade AI Node.js/Express backend.
 */
class NovaTradeApiClient {

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(45, TimeUnit.SECONDS)
        .build()

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    suspend fun registerWithPairingCode(
        baseUrl: String,
        pairingCode: String,
        deviceName: String,
        mediaProjectionGranted: Boolean,
        accessibilityGranted: Boolean
    ): Result<PairingResult> = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            put("pairingCode", pairingCode.trim().uppercase())
            put("deviceName", deviceName.trim().ifEmpty { Build.MODEL ?: "Android Phone" })
            put("deviceModel", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
            put("osVersion", "Android ${Build.VERSION.RELEASE}")
            put("mediaProjectionGranted", mediaProjectionGranted)
            put("accessibilityGranted", accessibilityGranted)
        }
        executeJsonRequest(
            url = "${normalizeBase(baseUrl)}/api/android/devices/register",
            method = "POST",
            token = null,
            payload = body
        ).mapCatching { json ->
            val dev = json.getJSONObject("device")
            PairingResult(
                deviceId = dev.getString("id"),
                deviceName = dev.optString("deviceName", deviceName),
                deviceToken = json.getString("deviceToken")
            )
        }
    }

    suspend fun sendHeartbeat(
        baseUrl: String,
        token: String,
        appPackage: String?,
        mediaProjection: Boolean,
        accessibility: Boolean
    ): Result<HeartbeatResult> = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            if (appPackage != null) put("appPackage", appPackage)
            put("mediaProjection", mediaProjection)
            put("accessibility", accessibility)
        }
        executeJsonRequest(
            url = "${normalizeBase(baseUrl)}/api/android/device/heartbeat",
            method = "POST",
            token = token,
            payload = body
        ).mapCatching { json ->
            HeartbeatResult(
                operatingMode = json.optString("operatingMode", "signals"),
                emergencyStop = json.optBoolean("emergencyStop", false)
            )
        }
    }

    suspend fun analyzeScreen(
        baseUrl: String,
        token: String,
        imageBase64: String,
        mimeType: String,
        appPackageHint: String?,
        accessibilityText: List<String>,
        notes: String?
    ): Result<ScreenAnalysisUiModel> = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            put("imageBase64", imageBase64)
            put("mimeType", mimeType)
            if (!appPackageHint.isNullOrBlank()) put("appPackageHint", appPackageHint)
            if (accessibilityText.isNotEmpty()) {
                put("accessibilityText", JSONArray(accessibilityText.take(40)))
            }
            if (!notes.isNullOrBlank()) put("notes", notes.take(240))
            put("createAssistedProposal", true)
        }
        executeJsonRequest(
            url = "${normalizeBase(baseUrl)}/api/android/screen/analyze",
            method = "POST",
            token = token,
            payload = body
        ).mapCatching { json ->
            val a = json.getJSONObject("analysis")
            ScreenAnalysisUiModel(
                id = a.getString("id"),
                appName = a.optString("appName", "UNKNOWN"),
                appPackage = a.optString("appPackage", "unknown"),
                detectedSymbol = a.optNullableString("detectedSymbol"),
                normalizedSymbol = a.optNullableString("normalizedSymbol"),
                detectedTimeframe = a.optNullableString("detectedTimeframe"),
                detectedPrice = if (a.isNull("detectedPrice")) null else a.optDouble("detectedPrice"),
                detectedAccountMode = a.optString("detectedAccountMode", "UNKNOWN"),
                chartTrend = a.optString("chartTrend", "UNCLEAR"),
                recommendedAction = a.optString("recommendedAction", "WAIT"),
                confidenceScore = a.optInt("confidenceScore", 0),
                alignmentStatus = a.optString("alignmentStatus", "VISION_ONLY"),
                visionSummary = a.optString("visionSummary", ""),
                riskWarning = a.optNullableString("riskWarning")
            )
        }
    }

    suspend fun pollAuthorizedActions(
        baseUrl: String,
        token: String
    ): Result<PollActionsResult> = withContext(Dispatchers.IO) {
        executeJsonRequest(
            url = "${normalizeBase(baseUrl)}/api/android/device/poll",
            method = "GET",
            token = token,
            payload = null
        ).mapCatching { json ->
            val arr = json.optJSONArray("actions") ?: JSONArray()
            val list = buildList {
                for (i in 0 until arr.length()) {
                    val item = arr.getJSONObject(i)
                    add(
                        AuthorizedActionUiModel(
                            id = item.getString("id"),
                            appName = item.optString("appName", "UNKNOWN"),
                            symbol = item.optString("symbol", "UNKNOWN"),
                            direction = item.optString("direction", "CALL"),
                            stakeOrVolume = item.optDouble("stakeOrVolume", 0.0),
                            expirySeconds = item.optInt("expirySeconds", 180),
                            accountModeVerified = item.optString("accountModeVerified", "UNKNOWN"),
                            status = item.optString("status", "DISPATCHED_TO_DEVICE"),
                            reason = item.optString("reason", "")
                        )
                    )
                }
            }
            PollActionsResult(
                actions = list,
                emergencyStop = json.optBoolean("emergencyStop", false)
            )
        }
    }

    suspend fun acknowledgeAction(
        baseUrl: String,
        token: String,
        actionId: String,
        outcome: String,
        note: String? = null
    ): Result<Unit> = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            put("actionId", actionId)
            put("outcome", outcome)
            if (!note.isNullOrBlank()) put("note", note.take(240))
        }
        executeJsonRequest(
            url = "${normalizeBase(baseUrl)}/api/android/device/ack",
            method = "POST",
            token = token,
            payload = body
        ).map { }
    }

    suspend fun triggerEmergencyStop(
        baseUrl: String,
        token: String,
        engaged: Boolean = true
    ): Result<Boolean> = withContext(Dispatchers.IO) {
        val body = JSONObject().apply { put("engaged", engaged) }
        executeJsonRequest(
            url = "${normalizeBase(baseUrl)}/api/android/device/emergency-stop",
            method = "POST",
            token = token,
            payload = body
        ).mapCatching { json -> json.optBoolean("emergencyStop", engaged) }
    }

    suspend fun disconnectDevice(
        baseUrl: String,
        token: String
    ): Result<Unit> = withContext(Dispatchers.IO) {
        executeJsonRequest(
            url = "${normalizeBase(baseUrl)}/api/android/device/disconnect",
            method = "POST",
            token = token,
            payload = JSONObject()
        ).map { }
    }

    private fun executeJsonRequest(
        url: String,
        method: String,
        token: String?,
        payload: JSONObject?
    ): Result<JSONObject> {
        return try {
            val builder = Request.Builder().url(url)
            if (!token.isNullOrBlank()) {
                builder.addHeader("Authorization", "Bearer $token")
            }
            builder.addHeader("Accept", "application/json")
            if (method == "POST") {
                val raw = (payload ?: JSONObject()).toString()
                builder.post(raw.toRequestBody(jsonMediaType))
            } else {
                builder.get()
            }

            client.newCall(builder.build()).execute().use { response ->
                val rawBody = response.body?.string().orEmpty()
                val contentType = response.header("Content-Type").orEmpty()
                if (!contentType.contains("application/json", ignoreCase = true) && rawBody.trimStart().startsWith("<")) {
                    return Result.failure(IllegalStateException("Server returned HTML instead of JSON (HTTP ${response.code}). Verify the NovaTrade URL."))
                }
                val parsed = if (rawBody.isNotBlank()) JSONObject(rawBody) else JSONObject()
                if (!response.isSuccessful) {
                    val errMsg = parsed.optString("error").ifBlank { "Request failed (HTTP ${response.code})" }
                    return Result.failure(IllegalStateException(errMsg))
                }
                Result.success(parsed)
            }
        } catch (err: Exception) {
            Result.failure(err)
        }
    }

    private fun normalizeBase(baseUrl: String): String = baseUrl.trim().trimEnd('/')

    private fun JSONObject.optNullableString(key: String): String? {
        if (isNull(key)) return null
        val v = optString(key, "")
        return v.ifBlank { null }
    }
}

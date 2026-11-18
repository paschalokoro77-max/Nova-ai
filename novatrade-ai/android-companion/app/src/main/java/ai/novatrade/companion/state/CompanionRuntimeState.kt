package ai.novatrade.companion.state

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class ScreenAnalysisUiModel(
    val id: String,
    val appName: String,
    val appPackage: String,
    val detectedSymbol: String?,
    val normalizedSymbol: String?,
    val detectedTimeframe: String?,
    val detectedPrice: Double?,
    val detectedAccountMode: String,
    val chartTrend: String,
    val recommendedAction: String,
    val confidenceScore: Int,
    val alignmentStatus: String,
    val visionSummary: String,
    val riskWarning: String?
)

data class AuthorizedActionUiModel(
    val id: String,
    val appName: String,
    val symbol: String,
    val direction: String,
    val stakeOrVolume: Double,
    val expirySeconds: Int,
    val accountModeVerified: String,
    val status: String,
    val reason: String
)

data class AccessibilitySnapshot(
    val enabled: Boolean = false,
    val foregroundPackage: String? = null,
    val visibleNodes: List<String> = emptyList(),
    val updatedAtMs: Long = 0L
)

/**
 * Thread-safe shared state connecting MainActivity, ScreenCaptureService, and TradingAccessibilityService.
 */
object CompanionRuntimeState {
    private val _captureRunning = MutableStateFlow(false)
    val captureRunning: StateFlow<Boolean> = _captureRunning.asStateFlow()

    private val _autoIntervalEnabled = MutableStateFlow(false)
    val autoIntervalEnabled: StateFlow<Boolean> = _autoIntervalEnabled.asStateFlow()

    private val _mt5AutoEnabled = MutableStateFlow(false)
    val mt5AutoEnabled: StateFlow<Boolean> = _mt5AutoEnabled.asStateFlow()

    private val _iqAutoEnabled = MutableStateFlow(false)
    val iqAutoEnabled: StateFlow<Boolean> = _iqAutoEnabled.asStateFlow()

    private val _emergencyStop = MutableStateFlow(false)
    val emergencyStop: StateFlow<Boolean> = _emergencyStop.asStateFlow()

    private val _accessibilitySnapshot = MutableStateFlow(AccessibilitySnapshot())
    val accessibilitySnapshot: StateFlow<AccessibilitySnapshot> = _accessibilitySnapshot.asStateFlow()

    private val _latestAnalysis = MutableStateFlow<ScreenAnalysisUiModel?>(null)
    val latestAnalysis: StateFlow<ScreenAnalysisUiModel?> = _latestAnalysis.asStateFlow()

    private val _authorizedActions = MutableStateFlow<List<AuthorizedActionUiModel>>(emptyList())
    val authorizedActions: StateFlow<List<AuthorizedActionUiModel>> = _authorizedActions.asStateFlow()

    private val _statusMessage = MutableStateFlow<String?>(null)
    val statusMessage: StateFlow<String?> = _statusMessage.asStateFlow()

    fun setCaptureRunning(running: Boolean) {
        _captureRunning.value = running
    }

    fun setAutoIntervalEnabled(enabled: Boolean) {
        _autoIntervalEnabled.value = enabled
    }

    fun setMt5AutoEnabled(enabled: Boolean) {
        _mt5AutoEnabled.value = enabled
    }

    fun setIqAutoEnabled(enabled: Boolean) {
        _iqAutoEnabled.value = enabled
    }

    fun setEmergencyStop(engaged: Boolean) {
        _emergencyStop.value = engaged
        if (engaged) {
            _autoIntervalEnabled.value = false
            _authorizedActions.value = emptyList()
        }
    }

    fun updateAccessibility(snapshot: AccessibilitySnapshot) {
        _accessibilitySnapshot.value = snapshot
    }

    fun updateLatestAnalysis(model: ScreenAnalysisUiModel?) {
        _latestAnalysis.value = model
    }

    fun updateAuthorizedActions(list: List<AuthorizedActionUiModel>) {
        _authorizedActions.value = list
    }

    fun setStatusMessage(msg: String?) {
        _statusMessage.value = msg
    }
}

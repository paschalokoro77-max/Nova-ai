package ai.novatrade.companion.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import ai.novatrade.companion.R
import ai.novatrade.companion.accessibility.TradingAccessibilityService
import ai.novatrade.companion.apps.TradingAppDetector
import ai.novatrade.companion.capture.ScreenCaptureService
import ai.novatrade.companion.databinding.ActivityMainBinding
import ai.novatrade.companion.network.NovaTradeApiClient
import ai.novatrade.companion.security.SecureTokenStore
import ai.novatrade.companion.state.CompanionRuntimeState
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var tokenStore: SecureTokenStore
    private val apiClient = NovaTradeApiClient()

    private var pendingProjectionRequest = false

    private val capturePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            val svcIntent = Intent(this, ScreenCaptureService::class.java).apply {
                action = ScreenCaptureService.ACTION_START_PROJECTION
                putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.resultCode)
                putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, result.data)
            }
            ContextCompat.startForegroundService(this, svcIntent)
        } else {
            CompanionRuntimeState.setStatusMessage("Screen capture permission declined by user.")
        }
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        if (pendingProjectionRequest) {
            pendingProjectionRequest = false
            launchMediaProjectionPrompt()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        tokenStore = SecureTokenStore(this)
        CompanionRuntimeState.setEmergencyStop(tokenStore.emergencyStopEngaged)

        setupInitialInputs()
        setupListeners()
        refreshInstalledApps()
        refreshPermissionLabels()
        observeRuntimeState()
    }

    override fun onResume() {
        super.onResume()
        refreshInstalledApps()
        refreshPermissionLabels()
        syncPairingUi()
    }

    private fun setupInitialInputs() {
        if (tokenStore.serverBaseUrl.isNotBlank()) {
            binding.inputServerUrl.setText(tokenStore.serverBaseUrl)
        }
        binding.inputDeviceName.setText(tokenStore.deviceName)
        if (tokenStore.selectedAppPackage == TradingAppDetector.PACKAGE_IQ_OPTION) {
            binding.radioTargetIq.isChecked = true
        } else {
            binding.radioTargetMt5.isChecked = true
        }
        syncPairingUi()
    }

    private fun setupListeners() {
        binding.btnPairDevice.setOnClickListener {
            val serverUrl = binding.inputServerUrl.text?.toString()?.trim().orEmpty()
            val pairingCode = binding.inputPairingCode.text?.toString()?.trim().orEmpty()
            val deviceName = binding.inputDeviceName.text?.toString()?.trim().orEmpty()

            if (!serverUrl.startsWith("http://") && !serverUrl.startsWith("https://")) {
                CompanionRuntimeState.setStatusMessage("Enter a valid NovaTrade server URL (https://...).")
                return@setOnClickListener
            }
            if (pairingCode.length < 4) {
                CompanionRuntimeState.setStatusMessage("Enter the 6-character pairing code from NovaTrade AI.")
                return@setOnClickListener
            }

            binding.btnPairDevice.isEnabled = false
            lifecycleScope.launch {
                val res = apiClient.registerWithPairingCode(
                    baseUrl = serverUrl,
                    pairingCode = pairingCode,
                    deviceName = deviceName,
                    mediaProjectionGranted = CompanionRuntimeState.captureRunning.value,
                    accessibilityGranted = TradingAccessibilityService.isServiceEnabled(this@MainActivity)
                )
                binding.btnPairDevice.isEnabled = true
                res.onSuccess { paired ->
                    tokenStore.savePairedSession(
                        baseUrl = serverUrl,
                        token = paired.deviceToken,
                        id = paired.deviceId,
                        name = paired.deviceName
                    )
                    CompanionRuntimeState.setEmergencyStop(false)
                    binding.inputPairingCode.setText("")
                    syncPairingUi()
                    CompanionRuntimeState.setStatusMessage("Paired successfully as ${paired.deviceName}.")
                }.onFailure { err ->
                    CompanionRuntimeState.setStatusMessage("Pairing failed: ${err.message}")
                }
            }
        }

        binding.btnDisconnectDevice.setOnClickListener {
            stopService(Intent(this, ScreenCaptureService::class.java).apply {
                action = ScreenCaptureService.ACTION_STOP
            })
            val token = tokenStore.deviceToken
            val baseUrl = tokenStore.serverBaseUrl
            lifecycleScope.launch {
                if (!token.isNullOrBlank() && baseUrl.isNotBlank()) {
                    apiClient.disconnectDevice(baseUrl, token)
                }
                tokenStore.clearSession()
                CompanionRuntimeState.updateAuthorizedActions(emptyList())
                CompanionRuntimeState.updateLatestAnalysis(null)
                syncPairingUi()
                CompanionRuntimeState.setStatusMessage("Disconnected and cleared encrypted device token.")
            }
        }

        binding.btnRefreshApps.setOnClickListener { refreshInstalledApps() }

        binding.radioTargetApp.setOnCheckedChangeListener { _, checkedId ->
            tokenStore.selectedAppPackage = if (checkedId == R.id.radioTargetIq) {
                TradingAppDetector.PACKAGE_IQ_OPTION
            } else {
                TradingAppDetector.PACKAGE_MT5
            }
        }

        binding.btnLaunchSelectedApp.setOnClickListener {
            val pkg = tokenStore.selectedAppPackage
            val launchIntent = TradingAppDetector.buildLaunchIntent(this, pkg)
            if (launchIntent == null) {
                CompanionRuntimeState.setStatusMessage("Selected app ($pkg) is not installed on this Android phone.")
            } else {
                startActivity(launchIntent)
            }
        }

        binding.btnToggleScreenCapture.setOnClickListener {
            if (CompanionRuntimeState.captureRunning.value) {
                startService(Intent(this, ScreenCaptureService::class.java).apply {
                    action = ScreenCaptureService.ACTION_STOP
                })
            } else {
                if (tokenStore.emergencyStopEngaged) {
                    CompanionRuntimeState.setStatusMessage("Reset Emergency Stop before authorizing capture.")
                    return@setOnClickListener
                }
                requestScreenCaptureWithPermissions()
            }
        }

        binding.btnOpenAccessibilitySettings.setOnClickListener {
            MaterialAlertDialogBuilder(this)
                .setTitle("Accessibility Permission Disclosure")
                .setMessage(getString(R.string.accessibility_service_description))
                .setPositiveButton("Open Settings") { _, _ ->
                    startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                }
                .setNegativeButton("Cancel", null)
                .show()
        }

        binding.switchAutoInterval.setOnCheckedChangeListener { _, isChecked ->
            if (!CompanionRuntimeState.captureRunning.value && isChecked) {
                binding.switchAutoInterval.isChecked = false
                CompanionRuntimeState.setStatusMessage("Authorize Screen Capture before enabling auto-interval.")
                return@setOnCheckedChangeListener
            }
            startService(Intent(this, ScreenCaptureService::class.java).apply {
                action = ScreenCaptureService.ACTION_SET_AUTO_INTERVAL
                putExtra(ScreenCaptureService.EXTRA_AUTO_INTERVAL, isChecked)
            })
        }

        binding.btnCaptureAnalyzeNow.setOnClickListener {
            if (!tokenStore.isPaired()) {
                CompanionRuntimeState.setStatusMessage("Pair with NovaTrade AI first.")
                return@setOnClickListener
            }
            if (!CompanionRuntimeState.captureRunning.value) {
                CompanionRuntimeState.setStatusMessage("Tap 'Authorize Screen Capture' first so Android can read the screen.")
                return@setOnClickListener
            }
            startService(Intent(this, ScreenCaptureService::class.java).apply {
                action = ScreenCaptureService.ACTION_CAPTURE_ONCE
                putExtra(ScreenCaptureService.EXTRA_NOTES, binding.inputAnalysisNotes.text?.toString()?.trim())
            })
        }

        binding.btnPollActions.setOnClickListener { pollActionsNow() }

        binding.btnAckLatestAction.setOnClickListener { acknowledgeTopAction("EXECUTED_REPORTED") }
        binding.btnRejectLatestAction.setOnClickListener { acknowledgeTopAction("REJECTED") }

        binding.btnEmergencyStop.setOnClickListener { triggerEmergencyStop() }
    }

    private fun requestScreenCaptureWithPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                pendingProjectionRequest = true
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                return
            }
        }
        launchMediaProjectionPrompt()
    }

    private fun launchMediaProjectionPrompt() {
        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        capturePermissionLauncher.launch(mgr.createScreenCaptureIntent())
    }

    private fun refreshInstalledApps() {
        val apps = TradingAppDetector.detectInstalledApps(this)
        val mt5 = apps.firstOrNull { it.packageName == TradingAppDetector.PACKAGE_MT5 }
        val iq = apps.firstOrNull { it.packageName == TradingAppDetector.PACKAGE_IQ_OPTION }

        binding.textMt5Status.text = if (mt5?.installed == true) {
            "MetaTrader 5 (${mt5.packageName}): INSTALLED v${mt5.versionName ?: "?"}"
        } else {
            "MetaTrader 5 (${TradingAppDetector.PACKAGE_MT5}): Not installed"
        }

        binding.textIqStatus.text = if (iq?.installed == true) {
            "IQ Option (${iq.packageName}): INSTALLED v${iq.versionName ?: "?"}"
        } else {
            "IQ Option (${TradingAppDetector.PACKAGE_IQ_OPTION}): Not installed"
        }
    }

    private fun refreshPermissionLabels() {
        val a11yEnabled = TradingAccessibilityService.isServiceEnabled(this)
        binding.textAccessibilityStatus.text = if (a11yEnabled) {
            "Accessibility Context Reader: ENABLED (MT5 & IQ Option)"
        } else {
            "Accessibility Context Reader: Disabled (optional — grant explicitly in Settings)"
        }
    }

    private fun syncPairingUi() {
        val paired = tokenStore.isPaired()
        binding.btnDisconnectDevice.isEnabled = paired
        binding.btnEmergencyStop.isEnabled = true

        if (paired) {
            binding.statusBadge.text = if (tokenStore.emergencyStopEngaged) "STOPPED" else "PAIRED"
            binding.statusBadge.setTextColor(
                ContextCompat.getColor(
                    this,
                    if (tokenStore.emergencyStopEngaged) R.color.nt_red else R.color.nt_emerald
                )
            )
            binding.textPairingStatus.text =
                "Paired as \"${tokenStore.deviceName}\" · Token ${tokenStore.getMaskedTokenPrefix()} (Encrypted Keystore)"
        } else {
            binding.statusBadge.text = "UNPAIRED"
            binding.statusBadge.setTextColor(ContextCompat.getColor(this, R.color.nt_amber))
            binding.textPairingStatus.text =
                "Enter your NovaTrade backend URL and the 6-digit pairing code generated in Broker Connections."
        }
    }

    private fun pollActionsNow() {
        val token = tokenStore.deviceToken
        val baseUrl = tokenStore.serverBaseUrl
        if (token.isNullOrBlank() || baseUrl.isBlank()) {
            CompanionRuntimeState.setStatusMessage("Pair device before syncing authorized actions.")
            return
        }
        lifecycleScope.launch {
            val res = apiClient.pollAuthorizedActions(baseUrl, token)
            res.onSuccess { poll ->
                tokenStore.emergencyStopEngaged = poll.emergencyStop
                CompanionRuntimeState.setEmergencyStop(poll.emergencyStop)
                if (!poll.emergencyStop) {
                    CompanionRuntimeState.updateAuthorizedActions(poll.actions)
                    CompanionRuntimeState.setStatusMessage("Synced ${poll.actions.size} authorized action(s).")
                } else {
                    CompanionRuntimeState.setStatusMessage("Server emergency stop engaged. Pending actions blocked.")
                }
                syncPairingUi()
            }.onFailure { err ->
                CompanionRuntimeState.setStatusMessage("Sync failed: ${err.message}")
            }
        }
    }

    private fun acknowledgeTopAction(outcome: String) {
        val top = CompanionRuntimeState.authorizedActions.value.firstOrNull() ?: return
        val token = tokenStore.deviceToken ?: return
        val baseUrl = tokenStore.serverBaseUrl
        lifecycleScope.launch {
            val res = apiClient.acknowledgeAction(
                baseUrl = baseUrl,
                token = token,
                actionId = top.id,
                outcome = outcome,
                note = "Acknowledged from Android Companion (${top.appName})"
            )
            res.onSuccess {
                val remaining = CompanionRuntimeState.authorizedActions.value.filterNot { it.id == top.id }
                CompanionRuntimeState.updateAuthorizedActions(remaining)
                CompanionRuntimeState.setStatusMessage("Action ${top.symbol} marked $outcome.")
            }.onFailure { err ->
                CompanionRuntimeState.setStatusMessage("Ack failed: ${err.message}")
            }
        }
    }

    private fun triggerEmergencyStop() {
        val engaging = !tokenStore.emergencyStopEngaged
        tokenStore.emergencyStopEngaged = engaging
        CompanionRuntimeState.setEmergencyStop(engaging)
        if (engaging) {
            stopService(Intent(this, ScreenCaptureService::class.java).apply {
                action = ScreenCaptureService.ACTION_STOP
            })
        }
        syncPairingUi()

        val token = tokenStore.deviceToken
        val baseUrl = tokenStore.serverBaseUrl
        if (!token.isNullOrBlank() && baseUrl.isNotBlank()) {
            lifecycleScope.launch {
                val res = apiClient.triggerEmergencyStop(baseUrl, token, engaged = engaging)
                res.onSuccess { serverState ->
                    tokenStore.emergencyStopEngaged = serverState
                    CompanionRuntimeState.setEmergencyStop(serverState)
                    syncPairingUi()
                    CompanionRuntimeState.setStatusMessage(
                        if (serverState) "EMERGENCY STOP engaged locally and on NovaTrade backend."
                        else "Emergency stop cleared."
                    )
                }.onFailure { err ->
                    CompanionRuntimeState.setStatusMessage(
                        "Local stop set; backend sync error: ${err.message}"
                    )
                }
            }
        }
    }

    private fun observeRuntimeState() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    CompanionRuntimeState.captureRunning.collect { running ->
                        binding.textCaptureStatus.text = if (running) {
                            "Screen Capture (MediaProjection): ACTIVE"
                        } else {
                            "Screen Capture (MediaProjection): Not authorized"
                        }
                        binding.btnToggleScreenCapture.text = if (running) {
                            "Stop Screen Capture"
                        } else {
                            "Authorize Screen Capture"
                        }
                    }
                }
                launch {
                    CompanionRuntimeState.emergencyStop.collect { stopped ->
                        binding.emergencyStopBanner.visibility = if (stopped) View.VISIBLE else View.GONE
                        binding.btnEmergencyStop.text = if (stopped) "CLEAR EMERGENCY STOP" else "EMERGENCY STOP"
                    }
                }
                launch {
                    CompanionRuntimeState.latestAnalysis.collect { a ->
                        if (a == null) {
                            binding.textLastAnalysisHeader.text = "No screen analyzed yet."
                            binding.textLastAnalysisMetrics.text = ""
                            binding.textLastAnalysisSummary.text = ""
                        } else {
                            binding.textLastAnalysisHeader.text =
                                "${a.appName} · ${a.normalizedSymbol ?: a.detectedSymbol ?: "Unknown"} · Mode: ${a.detectedAccountMode}"
                            binding.textLastAnalysisMetrics.text =
                                "TF: ${a.detectedTimeframe ?: "—"} | Price: ${a.detectedPrice ?: "—"} | ${a.recommendedAction} (${a.confidenceScore}/100, ${a.alignmentStatus})"
                            binding.textLastAnalysisSummary.text =
                                listOfNotNull(a.visionSummary, a.riskWarning).joinToString("\n")
                        }
                    }
                }
                launch {
                    CompanionRuntimeState.authorizedActions.collect { list ->
                        val top = list.firstOrNull()
                        binding.btnAckLatestAction.isEnabled = top != null
                        binding.btnRejectLatestAction.isEnabled = top != null
                        binding.textAuthorizedActions.text = if (list.isEmpty()) {
                            "Authorized Action Queue: None pending."
                        } else {
                            list.joinToString("\n") { act ->
                                "${act.direction} ${act.symbol} (${act.appName}, ${act.accountModeVerified}) · $${act.stakeOrVolume} · ${act.status}"
                            }
                        }
                    }
                }
                launch {
                    CompanionRuntimeState.statusMessage.collect { msg ->
                        if (!msg.isNullOrBlank()) {
                            binding.textPairingStatus.text = msg
                        }
                    }
                }
            }
        }
    }
}

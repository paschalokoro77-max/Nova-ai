package ai.novatrade.companion.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import ai.novatrade.companion.apps.TradingAppDetector
import ai.novatrade.companion.state.AccessibilitySnapshot
import ai.novatrade.companion.state.CompanionRuntimeState

/**
 * User-authorized AccessibilityService strictly scoped to MetaTrader 5 and IQ Option windows.
 * Collects visible chart/symbol/timeframe/account labels as auxiliary hints for Gemini Vision.
 */
class TradingAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        CompanionRuntimeState.updateAccessibility(
            CompanionRuntimeState.accessibilitySnapshot.value.copy(
                enabled = true,
                updatedAtMs = System.currentTimeMillis()
            )
        )
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val pkg = event?.packageName?.toString() ?: return
        if (!TradingAppDetector.isTargetTradingPackage(pkg)) return

        val root = rootInActiveWindow ?: return
        val collected = LinkedHashSet<String>()
        collectReadableText(root, collected, depth = 0, maxDepth = 8, maxItems = 40)

        CompanionRuntimeState.updateAccessibility(
            AccessibilitySnapshot(
                enabled = true,
                foregroundPackage = pkg,
                visibleNodes = collected.toList(),
                updatedAtMs = System.currentTimeMillis()
            )
        )
    }

    override fun onInterrupt() {
        CompanionRuntimeState.updateAccessibility(
            CompanionRuntimeState.accessibilitySnapshot.value.copy(enabled = false)
        )
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        CompanionRuntimeState.updateAccessibility(
            AccessibilitySnapshot(enabled = false)
        )
        return super.onUnbind(intent)
    }

    private fun collectReadableText(
        node: AccessibilityNodeInfo?,
        out: MutableSet<String>,
        depth: Int,
        maxDepth: Int,
        maxItems: Int
    ) {
        if (node == null || depth > maxDepth || out.size >= maxItems) return

        val text = node.text?.toString()?.trim()
        if (!text.isNullOrBlank() && text.length in 2..80) {
            out.add(text)
        }
        val desc = node.contentDescription?.toString()?.trim()
        if (!desc.isNullOrBlank() && desc.length in 2..80 && out.size < maxItems) {
            out.add(desc)
        }

        val count = node.childCount
        for (i in 0 until count) {
            if (out.size >= maxItems) break
            collectReadableText(node.getChild(i), out, depth + 1, maxDepth, maxItems)
        }
    }

    companion object {
        fun isServiceEnabled(context: Context): Boolean {
            val am = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager
                ?: return false
            val target = ComponentName(context, TradingAccessibilityService::class.java)
            val enabledList = am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            return enabledList.any { info ->
                val svcInfo = info.resolveInfo?.serviceInfo ?: return@any false
                svcInfo.packageName == target.packageName && svcInfo.name == target.className
            }
        }
    }
}

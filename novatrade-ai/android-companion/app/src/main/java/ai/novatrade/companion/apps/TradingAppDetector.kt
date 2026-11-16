package ai.novatrade.companion.apps

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

data class InstalledTradingApp(
    val packageName: String,
    val displayName: String,
    val installed: Boolean,
    val versionName: String?
)

/**
 * Queries Android PackageManager for genuinely installed MT5 and IQ Option apps.
 * Never fabricates app installation status.
 */
object TradingAppDetector {

    const val PACKAGE_MT5 = "net.metaquotes.metatrader5"
    const val PACKAGE_IQ_OPTION = "com.iqoption"

    val TARGET_PACKAGES = listOf(PACKAGE_MT5, PACKAGE_IQ_OPTION)

    fun detectInstalledApps(context: Context): List<InstalledTradingApp> {
        val pm = context.packageManager
        return listOf(
            inspectPackage(pm, PACKAGE_MT5, "MetaTrader 5"),
            inspectPackage(pm, PACKAGE_IQ_OPTION, "IQ Option")
        )
    }

    fun isTargetTradingPackage(packageName: String?): Boolean {
        if (packageName.isNullOrBlank()) return false
        return packageName == PACKAGE_MT5 || packageName == PACKAGE_IQ_OPTION
    }

    fun buildLaunchIntent(context: Context, packageName: String): Intent? {
        if (!isTargetTradingPackage(packageName)) return null
        val intent = context.packageManager.getLaunchIntentForPackage(packageName) ?: return null
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return intent
    }

    private fun inspectPackage(
        pm: PackageManager,
        packageName: String,
        displayName: String
    ): InstalledTradingApp {
        return try {
            val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(packageName, 0)
            }
            InstalledTradingApp(
                packageName = packageName,
                displayName = displayName,
                installed = true,
                versionName = info.versionName
            )
        } catch (_: PackageManager.NameNotFoundException) {
            InstalledTradingApp(
                packageName = packageName,
                displayName = displayName,
                installed = false,
                versionName = null
            )
        }
    }
}

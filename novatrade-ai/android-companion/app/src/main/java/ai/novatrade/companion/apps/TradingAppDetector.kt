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
 * Supports primary and variant package names (net.metaquotes.metatrader5, com.meta.trader5, com.iqoption, com.iqoption.x).
 * Never fabricates app installation status.
 */
object TradingAppDetector {

    const val PACKAGE_MT5_PRIMARY = "net.metaquotes.metatrader5"
    const val PACKAGE_MT5_VARIANT = "com.meta.trader5"
    const val PACKAGE_IQ_PRIMARY = "com.iqoption"
    const val PACKAGE_IQ_VARIANT = "com.iqoption.x"

    val TARGET_PACKAGES = listOf(PACKAGE_MT5_PRIMARY, PACKAGE_MT5_VARIANT, PACKAGE_IQ_PRIMARY, PACKAGE_IQ_VARIANT)

    fun detectInstalledApps(context: Context): List<InstalledTradingApp> {
        val pm = context.packageManager
        val mt5Installed = isPackageInstalled(pm, PACKAGE_MT5_PRIMARY) || isPackageInstalled(pm, PACKAGE_MT5_VARIANT)
        val iqInstalled = isPackageInstalled(pm, PACKAGE_IQ_PRIMARY) || isPackageInstalled(pm, PACKAGE_IQ_VARIANT)

        return listOf(
            inspectPackage(pm, PACKAGE_MT5_PRIMARY, "MetaTrader 5"),
            inspectPackage(pm, PACKAGE_IQ_PRIMARY, "IQ Option")
        )
    }

    fun isTargetTradingPackage(packageName: String?): Boolean {
        if (packageName.isNullOrBlank()) return false
        return TARGET_PACKAGES.contains(packageName)
    }

    fun buildLaunchIntent(context: Context, packageName: String): Intent? {
        if (!isTargetTradingPackage(packageName)) return null
        val intent = context.packageManager.getLaunchIntentForPackage(packageName) ?: return null
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return intent
    }

    private fun isPackageInstalled(pm: PackageManager, packageName: String): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(packageName, 0)
            }
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
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

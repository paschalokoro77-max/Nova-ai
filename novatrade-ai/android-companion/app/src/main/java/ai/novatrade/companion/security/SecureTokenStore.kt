package ai.novatrade.companion.security

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import ai.novatrade.companion.apps.TradingAppDetector

/**
 * Hardware-backed encrypted persistence for NovaTrade device bearer tokens and workspace config.
 */
class SecureTokenStore(context: Context) {

    private val prefs: SharedPreferences = run {
        val masterKey = MasterKey.Builder(context.applicationContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        EncryptedSharedPreferences.create(
            context.applicationContext,
            PREFS_FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    var serverBaseUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "") ?: ""
        set(value) {
            prefs.edit().putString(KEY_SERVER_URL, value.trim().trimEnd('/')).apply()
        }

    var deviceToken: String?
        get() = prefs.getString(KEY_DEVICE_TOKEN, null)
        private set(value) {
            prefs.edit().putString(KEY_DEVICE_TOKEN, value).apply()
        }

    var deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)
        private set(value) {
            prefs.edit().putString(KEY_DEVICE_ID, value).apply()
        }

    var deviceName: String
        get() = prefs.getString(KEY_DEVICE_NAME, "Android Phone") ?: "Android Phone"
        private set(value) {
            prefs.edit().putString(KEY_DEVICE_NAME, value).apply()
        }

    var selectedAppPackage: String
        get() = prefs.getString(KEY_SELECTED_APP, TradingAppDetector.PACKAGE_MT5)
            ?: TradingAppDetector.PACKAGE_MT5
        set(value) {
            prefs.edit().putString(KEY_SELECTED_APP, value).apply()
        }

    var emergencyStopEngaged: Boolean
        get() = prefs.getBoolean(KEY_EMERGENCY_STOP, false)
        set(value) {
            prefs.edit().putBoolean(KEY_EMERGENCY_STOP, value).apply()
        }

    fun isPaired(): Boolean = !deviceToken.isNullOrBlank() && serverBaseUrl.isNotBlank()

    fun getMaskedTokenPrefix(): String {
        val tok = deviceToken ?: return "None"
        return if (tok.length > 12) "${tok.take(12)}..." else "Paired"
    }

    fun savePairedSession(
        baseUrl: String,
        token: String,
        id: String,
        name: String
    ) {
        prefs.edit()
            .putString(KEY_SERVER_URL, baseUrl.trim().trimEnd('/'))
            .putString(KEY_DEVICE_TOKEN, token.trim())
            .putString(KEY_DEVICE_ID, id)
            .putString(KEY_DEVICE_NAME, name)
            .putBoolean(KEY_EMERGENCY_STOP, false)
            .apply()
    }

    fun clearSession() {
        prefs.edit()
            .remove(KEY_DEVICE_TOKEN)
            .remove(KEY_DEVICE_ID)
            .apply()
    }

    companion object {
        private const val PREFS_FILE = "novatrade_companion_secure_prefs"
        private const val KEY_SERVER_URL = "server_base_url"
        private const val KEY_DEVICE_TOKEN = "device_bearer_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_SELECTED_APP = "selected_app_package"
        private const val KEY_EMERGENCY_STOP = "emergency_stop_engaged"
    }
}

package ai.novatrade.companion

import ai.novatrade.companion.apps.TradingAppDetector
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TradingAppDetectorTest {
    @Test
    fun targetPackagesAreRecognizedAccurately() {
        assertTrue(TradingAppDetector.isTargetTradingPackage(TradingAppDetector.PACKAGE_MT5))
        assertTrue(TradingAppDetector.isTargetTradingPackage(TradingAppDetector.PACKAGE_IQ_OPTION))
        assertFalse(TradingAppDetector.isTargetTradingPackage("com.android.chrome"))
        assertFalse(TradingAppDetector.isTargetTradingPackage(null))
    }
}

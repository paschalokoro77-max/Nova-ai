package ai.novatrade.companion

import ai.novatrade.companion.accessibility.IqOptionExecutionEngine
import ai.novatrade.companion.accessibility.Mt5ExecutionEngine
import ai.novatrade.companion.accessibility.ExecutionResultStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExecutionEngineTest {

    @Test
    fun testMt5ParameterValidation() {
        assertTrue(Mt5ExecutionEngine.validateParameters("BUY", 0.1, "EURUSD", "EURUSD"))
        assertTrue(Mt5ExecutionEngine.validateParameters("SELL", 1.0, "GBPUSD", "GBPUSD - Sterling"))
        assertFalse(Mt5ExecutionEngine.validateParameters("INVALID_DIR", 0.1, "EURUSD", "EURUSD"))
        assertFalse(Mt5ExecutionEngine.validateParameters("BUY", 0.001, "EURUSD", "EURUSD")) // below min volume
        assertFalse(Mt5ExecutionEngine.validateParameters("BUY", 150.0, "EURUSD", "EURUSD")) // above max volume
        assertFalse(Mt5ExecutionEngine.validateParameters("BUY", 0.1, "EURUSD", "USDJPY")) // symbol mismatch
    }

    @Test
    fun testIqOptionParameterValidation() {
        assertTrue(IqOptionExecutionEngine.validateParameters("CALL", 10.0))
        assertTrue(IqOptionExecutionEngine.validateParameters("PUT", 50.0))
        assertTrue(IqOptionExecutionEngine.validateParameters("BUY", 25.0))
        assertFalse(IqOptionExecutionEngine.validateParameters("INVALID", 10.0))
        assertFalse(IqOptionExecutionEngine.validateParameters("CALL", 0.5)) // below min stake ($1)
        assertFalse(IqOptionExecutionEngine.validateParameters("CALL", 20000.0)) // above max stake ($10,000)
    }

    @Test
    fun testExecutionStatusesDefined() {
        assertEquals(ExecutionResultStatus.ACTION_ATTEMPTED, ExecutionResultStatus.valueOf("ACTION_ATTEMPTED"))
        assertEquals(ExecutionResultStatus.ACTION_ACCEPTED, ExecutionResultStatus.valueOf("ACTION_ACCEPTED"))
        assertEquals(ExecutionResultStatus.ORDER_CONFIRMED, ExecutionResultStatus.valueOf("ORDER_CONFIRMED"))
        assertEquals(ExecutionResultStatus.EXECUTION_FAILED, ExecutionResultStatus.valueOf("EXECUTION_FAILED"))
        assertEquals(ExecutionResultStatus.ACCOUNT_UNVERIFIED, ExecutionResultStatus.valueOf("ACCOUNT_UNVERIFIED"))
    }
}

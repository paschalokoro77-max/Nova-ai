import assert from 'assert';
import { parseIqConnectorConfig, IQOptionAdapter } from './novatrade-ai/server/src/brokers/iqOption.ts';
import { MetaTrader5Adapter } from './novatrade-ai/server/src/brokers/mt5.ts';

console.log('========================================================================');
console.log('🧪 NOVATRADE AI — BROKER CONNECTOR CONFIGURATION & HEALTH REGRESSION SUITE');
console.log('========================================================================');

async function runBrokerConfigTests() {
  // Test 1: IQ_CONNECTOR_URL parsing and validation
  process.env.IQ_CONNECTOR_URL = '';
  const unconfigured = parseIqConnectorConfig();
  assert.equal(unconfigured.configured, false);
  console.log('  ✅ [PASS] Unconfigured IQ_CONNECTOR_URL detected correctly');

  process.env.IQ_CONNECTOR_URL = 'https://my-iq-connector.onrender.com';
  const configured = parseIqConnectorConfig();
  assert.equal(configured.configured, true);
  assert.equal(configured.urlValid, true);
  assert.equal(configured.url, 'https://my-iq-connector.onrender.com');
  console.log('  ✅ [PASS] Valid production IQ_CONNECTOR_URL parsed successfully');

  // Test 2: Stripping accidental "IQ_CONNECTOR_URL=" prefix (robustness check)
  process.env.IQ_CONNECTOR_URL = 'IQ_CONNECTOR_URL=https://my-iq-connector.onrender.com';
  const prefixed = parseIqConnectorConfig();
  assert.equal(prefixed.configured, true);
  assert.equal(prefixed.url, 'https://my-iq-connector.onrender.com');
  console.log('  ✅ [PASS] Accidental variable name prefix stripped successfully');

  // Test 3: MT5 and IQ Option separation (MT5 does not call IQ Option connector)
  const iqAdapter = new IQOptionAdapter();
  const mt5Adapter = new MetaTrader5Adapter();
  assert.notEqual(iqAdapter.brokerId, mt5Adapter.brokerId);
  assert.equal(iqAdapter.brokerId, 'iq_option');
  assert.equal(mt5Adapter.brokerId, 'mt5');
  console.log('  ✅ [PASS] MT5 and IQ Option broker adapters are strictly separate');

  // Test 4: Order execution lockdown verification
  const iqCaps = await iqAdapter.getCapabilities();
  const mt5Caps = await mt5Adapter.getCapabilities();
  assert.equal(iqCaps.orderExecutionSupported, false);
  assert.equal(iqCaps.liveOrderPlacementSupported, false);
  assert.equal(mt5Caps.liveOrderPlacementSupported, false);
  console.log('  ✅ [PASS] Order execution locks and safety constraints verified across all adapters');

  console.log('\n========================================================================');
  console.log('🎉 ALL BROKER CONNECTOR CONFIGURATION TESTS PASSED SUCCESSFULLY!');
  console.log('========================================================================\n');
}

runBrokerConfigTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Broker config test failed:', err);
    process.exit(1);
  });

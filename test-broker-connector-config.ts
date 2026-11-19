import http from 'node:http';
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

  // Test 5: Price & Candles HTTP 502 HTML retry recovery + non-transient 401 fast-fail
  let priceAttempts = 0;
  let candlesAttempts = 0;
  const mockServer = http.createServer((req, res) => {
    if (req.url === '/price/EURUSD') {
      priceAttempts++;
      if (priceAttempts === 1) {
        res.writeHead(502, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>502 Bad Gateway</h1></body></html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          symbol: 'EURUSD',
          bid: null,
          ask: null,
          last: 1.0865,
          spread: null,
          time: 1700000060,
          source: 'IQ_OPTION_UNOFFICIAL',
        })
      );
      return;
    }

    if (req.url === '/candles') {
      candlesAttempts++;
      if (req.headers['x-connector-token'] !== 'valid-secret') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Invalid connector token.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          symbol: 'EURUSD',
          interval: 60,
          candles: [
            { time: 1700000000, open: 1.085, high: 1.086, low: 1.084, close: 1.0855, volume: 10 },
            { time: 1700000060, open: 1.0855, high: 1.087, low: 1.085, close: 1.0865, volume: 14 },
          ],
          source: 'IQ_OPTION_UNOFFICIAL',
        })
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Not found' }));
  });

  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  try {
    const port = (mockServer.address() as { port: number }).port;
    process.env.IQ_CONNECTOR_URL = `http://127.0.0.1:${port}`;
    process.env.IQ_CONNECTOR_TOKEN = 'valid-secret';

    // Transient 502 HTML on first /price attempt recovers on second attempt
    const quote = await iqAdapter.getQuote('EUR/USD');
    assert.equal(quote.symbol, 'EURUSD');
    assert.equal(quote.last, 1.0865);
    assert.equal(priceAttempts, 2);
    console.log('  ✅ [PASS] Price endpoint recovers cleanly after transient 502 HTML gateway response');

    // Candles endpoint returns normalized bars with valid token
    const candles = await iqAdapter.getCandles('EUR/USD', 60, 2);
    assert.equal(candles.candles.length, 2);
    assert.equal(candles.candles[1].close, 1.0865);
    console.log('  ✅ [PASS] Candles endpoint normalizes symbol and returns historical bars');

    // Non-transient 401 token failure fails fast on 1 attempt without timeout wrapping
    candlesAttempts = 0;
    process.env.IQ_CONNECTOR_TOKEN = 'wrong-secret';
    let authErr = '';
    try {
      await iqAdapter.getCandles('EURUSD', 60, 2);
    } catch (err) {
      authErr = err instanceof Error ? err.message : String(err);
    }
    assert.equal(candlesAttempts, 1);
    assert.ok(authErr.includes('Invalid connector token'));
    console.log('  ✅ [PASS] Non-transient HTTP 401 fails fast without bogus retries or timeout masking');
  } finally {
    mockServer.close();
  }

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

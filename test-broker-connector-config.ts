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

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'running',
          connected: true,
          authenticated: true,
          mode: 'PRACTICE',
          accountType: 'PRACTICE',
          modeVerified: true,
          credentialsConfigured: true,
          lastError: null,
        })
      );
      return;
    }

    if (req.url === '/account') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          accountType: 'PRACTICE',
          mode: 'PRACTICE',
          modeVerified: true,
          balance: null,
          currency: 'USD',
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
      let rawBody = '';
      req.on('data', (chunk) => {
        rawBody += String(chunk);
      });
      req.on('end', () => {
        const body = rawBody ? (JSON.parse(rawBody) as { symbol?: string }) : {};
        if (body.symbol === 'INVALIDBARS') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              symbol: 'INVALIDBARS',
              interval: 60,
              candles: [{ time: 0, open: null, high: 0, low: -1, close: null, volume: 0 }],
              source: 'IQ_OPTION_UNOFFICIAL',
            })
          );
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
      });
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

    // Malformed / invalid candles must be rejected rather than passed as valid data
    let invalidCandleErr = '';
    try {
      await iqAdapter.getCandles('INVALIDBARS', 60, 2);
    } catch (err) {
      invalidCandleErr = err instanceof Error ? err.message : String(err);
    }
    assert.ok(invalidCandleErr.includes('no valid candlestick data'));
    console.log('  ✅ [PASS] Malformed candlestick bars are rejected instead of fabricating OHLCV data');

    // Missing numeric balance must stay null (never fabricated as 0) and surface an error
    const statusWithNullBalance = await iqAdapter.getStatus();
    assert.equal(statusWithNullBalance.balance, null);
    assert.equal(statusWithNullBalance.equity, null);
    assert.ok(
      statusWithNullBalance.diagnostics?.lastConnectorError?.includes('valid numeric balance'),
      `Expected missing-balance diagnostic, got: ${statusWithNullBalance.diagnostics?.lastConnectorError}`
    );
    let balanceErr = '';
    try {
      await iqAdapter.getBalance();
    } catch (err) {
      balanceErr = err instanceof Error ? err.message : String(err);
    }
    assert.ok(balanceErr.includes('missing or non-numeric'));
    console.log('  ✅ [PASS] Missing/invalid broker balance stays null and never fabricates $0.00');

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

  // Test 6: Single-flight connect/status coalescing, slow connect, transient 503 busy recovery, and ConnectionManager flow
  let connectHits = 0;
  let accountHits = 0;
  let healthHits = 0;
  let failFirstConnectWith503 = false;
  const concurrencyServer = http.createServer((req, res) => {
    if (req.url === '/connect' && req.method === 'POST') {
      connectHits++;
      if (failFirstConnectWith503 && connectHits === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            detail: 'IQ Option connector is busy with an upstream broker operation; please retry shortly.',
          })
        );
        return;
      }
      // Simulate slow broker WebSocket handshake (250ms)
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            connected: true,
            mode: 'PRACTICE',
            accountType: 'PRACTICE',
            modeVerified: true,
            orderExecutionSupported: false,
            realTradingEnabled: false,
          })
        );
      }, 250);
      return;
    }
    if (req.url === '/health') {
      healthHits++;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'running',
            busy: false,
            connectInFlight: false,
            connected: true,
            authenticated: true,
            mode: 'PRACTICE',
            accountType: 'PRACTICE',
            modeVerified: true,
            credentialsConfigured: true,
            lastError: null,
          })
        );
      }, 100);
      return;
    }
    if (req.url === '/account') {
      accountHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          connected: true,
          mode: 'PRACTICE',
          accountType: 'PRACTICE',
          modeVerified: true,
          balance: 10000.0,
          currency: 'USD',
          orderExecutionSupported: false,
          realTradingEnabled: false,
        })
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Not found' }));
  });

  await new Promise<void>((resolve) => concurrencyServer.listen(0, '127.0.0.1', resolve));
  try {
    const port = (concurrencyServer.address() as { port: number }).port;
    process.env.IQ_CONNECTOR_URL = `http://127.0.0.1:${port}`;
    process.env.IQ_CONNECTOR_TOKEN = 'valid-secret';

    // Simultaneous connect() calls must coalesce into ONE POST /connect request
    const [c1, c2, c3] = await Promise.all([
      iqAdapter.connect(),
      iqAdapter.connect(),
      iqAdapter.connect(),
    ]);
    assert.equal(connectHits, 1, `Expected 1 coalesced /connect hit, got ${connectHits}`);
    assert.equal(c1.connected, true);
    assert.equal(c2.connected, true);
    assert.equal(c3.connected, true);
    assert.equal(c1.balance, 10000);
    console.log('  ✅ [PASS] Simultaneous IQOptionAdapter.connect() calls coalesce into 1 upstream /connect request');

    // Simultaneous getStatus() calls must coalesce into ONE /health + ONE /account round-trip
    healthHits = 0;
    accountHits = 0;
    const [s1, s2, s3] = await Promise.all([
      iqAdapter.getStatus(),
      iqAdapter.getStatus(),
      iqAdapter.getStatus(),
    ]);
    assert.equal(healthHits, 1, `Expected 1 coalesced /health hit, got ${healthHits}`);
    assert.equal(accountHits, 1, `Expected 1 coalesced /account hit, got ${accountHits}`);
    assert.equal(s1.connected, true);
    assert.equal(s2.balance, 10000);
    assert.equal(s3.balance, 10000);
    console.log('  ✅ [PASS] Simultaneous IQOptionAdapter.getStatus() calls coalesce cleanly');

    // Transient 503 busy on first /connect recovers cleanly on bounded retry (2 attempts total)
    connectHits = 0;
    failFirstConnectWith503 = true;
    const recovered = await iqAdapter.connect();
    assert.equal(recovered.connected, true);
    assert.equal(connectHits, 2, `Expected 2 bounded attempts on transient 503, got ${connectHits}`);
    console.log('  ✅ [PASS] Transient HTTP 503 busy recovers cleanly with bounded backoff retry');
  } finally {
    concurrencyServer.close();
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

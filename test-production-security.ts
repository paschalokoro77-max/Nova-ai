import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createStandaloneApp } from './novatrade-ai/server/src/app.ts';
import { validateProductionEnvironment } from './novatrade-ai/server/src/supabaseAdmin.ts';

async function startMockMt5Bridge() {
  let activeTradeMode: 'DEMO' | 'REAL' = 'DEMO';
  const placedOrders: Array<{ symbol: string; side: string; environment: string; volume: number }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyRaw = Buffer.concat(chunks).toString('utf8');
      const body = bodyRaw ? (JSON.parse(bodyRaw) as Record<string, unknown>) : {};
      res.setHeader('Content-Type', 'application/json');

      const sendAccount = (mode: 'DEMO' | 'REAL') => ({
        login: 50241890,
        server: mode === 'REAL' ? 'Broker-Live' : 'MetaQuotes-Demo',
        name: `Trader ${mode}`,
        currency: 'USD',
        tradeMode: mode,
        balance: mode === 'REAL' ? 4200 : 10000,
        equity: mode === 'REAL' ? 4200 : 10000,
        margin: 0,
        marginFree: mode === 'REAL' ? 4200 : 10000,
        leverage: 100,
        tradeAllowed: true,
      });

      if (req.url === '/health') {
        const acct = sendAccount(activeTradeMode);
        res.end(
          JSON.stringify({
            status: 'ok',
            connected: true,
            credentialsConfigured: true,
            tokenConfigured: true,
            tradeMode: acct.tradeMode,
            accountLogin: acct.login,
            server: acct.server,
            account: acct,
          })
        );
        return;
      }
      if (req.url === '/account') {
        res.end(JSON.stringify(sendAccount(activeTradeMode)));
        return;
      }
      if (req.url === '/connect') {
        const reqEnv = String(body.environment || 'DEMO').toUpperCase() === 'REAL' ? 'REAL' : 'DEMO';
        activeTradeMode = reqEnv;
        const acct = sendAccount(activeTradeMode);
        res.end(JSON.stringify({ connected: true, ...acct }));
        return;
      }
      if (req.url === '/disconnect') {
        res.end(JSON.stringify({ connected: false }));
        return;
      }
      if (req.url === '/order/validate') {
        const reqEnv = String(body.environment || activeTradeMode).toUpperCase();
        if (reqEnv !== activeTradeMode) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: `Account mode mismatch: requested ${reqEnv}, terminal is ${activeTradeMode}` }));
          return;
        }
        res.end(
          JSON.stringify({
            valid: true,
            compatible: true,
            retcode: 0,
            comment: 'Done',
            mappedSymbol: body.symbol || 'EURUSD',
            volume: 0.01,
            estimatedMargin: 11.25,
            freeMargin: activeTradeMode === 'REAL' ? 4188.75 : 9988.75,
            side: body.side || 'BUY',
            orderType: body.orderType || 'MARKET',
            source: 'MT5_OFFICIAL_ORDER_CHECK',
          })
        );
        return;
      }
      if (req.url === '/order') {
        const reqEnv = String(body.environment || activeTradeMode).toUpperCase();
        if (reqEnv !== activeTradeMode) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: `Account mode mismatch: requested ${reqEnv}, terminal is ${activeTradeMode}` }));
          return;
        }
        placedOrders.push({
          symbol: String(body.symbol || 'EURUSD'),
          side: String(body.side || 'BUY'),
          environment: reqEnv,
          volume: Number(body.volume || 0.01),
        });
        res.end(
          JSON.stringify({
            accepted: true,
            status: 'FILLED',
            orderId: `mt5-${reqEnv.toLowerCase()}-${placedOrders.length}`,
            symbol: body.symbol || 'EURUSD',
            filledPrice: 1.10125,
            volume: 0.01,
            environment: reqEnv,
            message: `MT5 ${reqEnv} order filled`,
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}`, placedOrders };
}

async function run() {
  const savedEnv = { ...process.env };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-sec-test-'));

  let sbMockServer: http.Server | null = null;
  try {
    console.log('=== 1. Production Environment Validation ===');
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.VITE_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ANDROID_BRIDGE_SECRET;
    delete process.env.BROKER_VAULT_SECRET;

    assert.throws(
      () => validateProductionEnvironment(),
      /Production environment validation failed/,
      'Expected validateProductionEnvironment() to fail when credentials are missing'
    );

    process.env.ANDROID_BRIDGE_SECRET = 'short-secret';
    process.env.BROKER_VAULT_SECRET = 'short-vault';
    assert.throws(
      () => validateProductionEnvironment(),
      /ANDROID_BRIDGE_SECRET.*BROKER_VAULT_SECRET/,
      'Expected short secrets (<32 bytes) to fail validation'
    );

    sbMockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = req.method === 'POST' ? 201 : 200;
        res.end(JSON.stringify(req.method === 'GET' ? [] : {}));
      });
    });
    await new Promise<void>((resolve) => sbMockServer!.listen(0, '127.0.0.1', () => resolve()));
    const sbMockPort = (sbMockServer.address() as { port: number }).port;

    process.env.NODE_ENV = 'production';
    process.env.SUPABASE_URL = `http://127.0.0.1:${sbMockPort}`;
    process.env.SUPABASE_ANON_KEY = 'anon-key-valid-test-value';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-valid-test-value';
    process.env.ANDROID_BRIDGE_SECRET = 'prod-android-bridge-secret-at-least-32-chars!!';
    process.env.BROKER_VAULT_SECRET = 'prod-broker-vault-secret-at-least-32-chars!!!!';

    assert.doesNotThrow(() => validateProductionEnvironment(), 'Valid production environment should pass');
    console.log('PASS: Production environment validation rejects missing/weak secrets and passes with valid secrets.');

    console.log('=== 2. Production Mode: JSON Fallback Disabled, Auth Gating, HTTPS Enforcement & Rate Limiting ===');
    const validToken = 'valid-user-jwt-token';
    const prodApp = createStandaloneApp({
      persistPath: path.join(tmpDir, 'should-not-write.json'),
      enableScheduler: false,
      autoRestore: false,
      requireAuth: true,
      verifyToken: async (h) => (h === `Bearer ${validToken}` ? { userId: 'user-prod-1', email: 'trader@novatrade.ai' } : null),
      rateLimits: {
        windowMs: 60_000,
        pairingMax: 2,
        authMax: 3,
        tradingMax: 3,
      },
    });
    const prodSrv = await new Promise<ReturnType<typeof prodApp.app.listen>>((resolve) => {
      const s = prodApp.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const prodPort = (prodSrv.address() as { port: number }).port;
    const prodBase = `http://127.0.0.1:${prodPort}/api`;

    try {
      const authHeaders = {
        'content-type': 'application/json',
        authorization: `Bearer ${validToken}`,
      };
      const httpsHeaders = {
        ...authHeaders,
        'x-forwarded-proto': 'https',
      };

      // Verify unauthenticated gating on dashboard / Nova AI endpoints
      for (const [method, endpoint] of [
        ['POST', '/signals/analyse'],
        ['POST', '/scanner/run'],
        ['GET', '/brokers/accounts'],
        ['POST', '/brokers/orders'],
        ['POST', '/broker/iq/connect'],
        ['GET', '/market/assets'],
        ['GET', '/supabase/diagnostics'],
      ] as const) {
        const res = await fetch(`${prodBase}${endpoint}`, { method, headers: { 'content-type': 'application/json' } });
        assert.equal(res.status, 401, `Unauthenticated ${method} ${endpoint} must return 401`);
      }

      // Verify /health hides sensitive balance & scheduler when unauthenticated
      const healthAnon = (await (await fetch(`${prodBase}/health`)).json()) as Record<string, unknown>;
      assert.equal(healthAnon.authRequired, true);
      assert.equal(healthAnon.virtualBalance, undefined, 'Unauthenticated /health must omit virtualBalance');
      assert.equal(healthAnon.scheduler, undefined, 'Unauthenticated /health must omit scheduler');

      const healthAuthed = (await (await fetch(`${prodBase}/health`, { headers: authHeaders })).json()) as Record<string, unknown>;
      assert.ok(healthAuthed.virtualBalance, 'Authenticated /health should include virtualBalance');

      // Verify Android HTTPS enforcement in production (HTTP rejected with 426, HTTPS allowed)
      const androidHttpRes = await fetch(`${prodBase}/android/devices/pair`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ deviceName: 'Pixel 9' }),
      });
      assert.equal(androidHttpRes.status, 426, 'Plain HTTP to /api/android/* in production must return 426');

      const pair1 = await fetch(`${prodBase}/android/devices/pair`, {
        method: 'POST',
        headers: httpsHeaders,
        body: JSON.stringify({ deviceName: 'Pixel 9' }),
      });
      assert.equal(pair1.status, 201, 'HTTPS request to /api/android/devices/pair should succeed');
      const pair2 = await fetch(`${prodBase}/android/devices/pair`, {
        method: 'POST',
        headers: httpsHeaders,
        body: JSON.stringify({ deviceName: 'Pixel 9b' }),
      });
      assert.equal(pair2.status, 201);
      const pair3 = await fetch(`${prodBase}/android/devices/pair`, {
        method: 'POST',
        headers: httpsHeaders,
        body: JSON.stringify({ deviceName: 'Pixel 9c' }),
      });
      assert.equal(pair3.status, 429, '3rd Android pairing attempt should hit rate limit 429');

      // Verify Auth/Workspace limiter triggers 429
      const hyd1 = await fetch(`${prodBase}/state/hydrate`, { method: 'POST', headers: authHeaders, body: '{}' });
      assert.equal(hyd1.status, 200);
      const hyd2 = await fetch(`${prodBase}/state/hydrate`, { method: 'POST', headers: authHeaders, body: '{}' });
      assert.equal(hyd2.status, 200);
      const hyd3 = await fetch(`${prodBase}/state/hydrate`, { method: 'POST', headers: authHeaders, body: '{}' });
      assert.equal(hyd3.status, 429, '3rd /state/hydrate request should hit auth rate limit 429');

      // Verify Trading execution limiter triggers 429 AND Emergency Stop stays exempt!
      const pt1 = await fetch(`${prodBase}/paper-trades`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ symbol: 'EURUSD', direction: 'CALL', amount: 10, entryPrice: 1.085 }),
      });
      assert.equal(pt1.status, 201);
      const pt2 = await fetch(`${prodBase}/paper-trades`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ symbol: 'BTCUSD', direction: 'CALL', amount: 10, entryPrice: 68000 }),
      });
      assert.equal(pt2.status, 201);
      const pt3 = await fetch(`${prodBase}/paper-trades`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ symbol: 'XAUUSD', direction: 'CALL', amount: 10, entryPrice: 2350 }),
      });
      assert.equal(pt3.status, 429, '3rd trading request should hit trading rate limit 429');

      // Emergency Stop must NEVER return 429 even when trading rate limit is exhausted
      const estopRes = await fetch(`${prodBase}/risk/emergency-stop`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ engaged: true }),
      });
      assert.equal(estopRes.status, 200, 'Emergency Stop must remain exempt from trading rate limiting');

      // Verify zero local JSON fallback files or .broker-vault.key were created in production mode
      assert.equal(fs.existsSync(path.join(tmpDir, 'should-not-write.json')), false, 'No state.json in production');
      assert.equal(fs.existsSync(path.join(tmpDir, 'brokers')), false, 'No brokers JSON dir in production');
      assert.equal(fs.existsSync(path.join(tmpDir, '.broker-vault.key')), false, 'No .broker-vault.key file in production');

      console.log('PASS: Auth gating (401), sanitized /health, Android HTTPS (426), rate limiting (429), Emergency Stop exemption, and zero local JSON fallback verified.');
    } finally {
      prodSrv.close();
      prodApp.stopScheduler();
    }

    console.log('=== 3. MT5 Demo & Real Preservation + IQ Option Practice Read-Only Inspection ===');
    const mockMt5 = await startMockMt5Bridge();
    process.env.MT5_BRIDGE_URL = mockMt5.url;
    process.env.MT5_BRIDGE_TOKEN = 'test-bridge-token';

    const mt5App = createStandaloneApp({
      persistPath: null,
      enableScheduler: false,
      autoRestore: false,
      requireAuth: true,
      verifyToken: async (h) => (h === `Bearer ${validToken}` ? { userId: 'user-mt5-1', email: 'mt5@novatrade.ai' } : null),
    });
    const mt5Srv = await new Promise<ReturnType<typeof mt5App.app.listen>>((resolve) => {
      const s = mt5App.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const mt5Port = (mt5Srv.address() as { port: number }).port;
    const mt5Base = `http://127.0.0.1:${mt5Port}/api`;

    try {
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${validToken}` };

      // 3a. IQ Option must preserve both Demo & Real account modes without silent switching, while never falsely claiming order execution
      const iqRealRes = await fetch(`${mt5Base}/brokers/accounts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          brokerId: 'iq_option',
          label: 'IQ Real Account',
          environment: 'real',
          credentials: { email: 'user@iq.test', apiSecret: 'pw123' },
        }),
      });
      assert.equal(iqRealRes.status, 201, 'IQ Option real account creation must be preserved');
      const iqRealBody = (await iqRealRes.json()) as { account: { environment: string; brokerId: string } };
      assert.equal(iqRealBody.account.brokerId, 'iq_option');
      assert.equal(iqRealBody.account.environment, 'real', 'IQ Option real account must not be silently switched to demo');

      const catalogJson = (await (await fetch(`${mt5Base}/brokers/catalog`, { headers })).json()) as {
        brokers: Array<{ id: string; realExecutionEnabled: boolean; capabilities: Record<string, unknown> }>;
      };
      const iqCatalog = catalogJson.brokers.find((b) => b.id === 'iq_option')!;
      const mt5Catalog = catalogJson.brokers.find((b) => b.id === 'mt5')!;
      assert.equal(iqCatalog.realExecutionEnabled, false);
      assert.equal(iqCatalog.capabilities.orderExecutionSupported, false);
      assert.equal(iqCatalog.capabilities.demoOrderPlacementSupported, false);
      assert.equal(iqCatalog.capabilities.liveOrderPlacementSupported, false);
      assert.equal(mt5Catalog.realExecutionEnabled, true);
      assert.equal(mt5Catalog.capabilities.realAccountSupported, true);
      assert.equal(mt5Catalog.capabilities.liveOrderPlacementSupported, true);

      // 3b. Save & connect MT5 Demo account + execute Demo order
      const demoSave = await (
        await fetch(`${mt5Base}/brokers/accounts`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            brokerId: 'mt5',
            label: 'MT5 Demo Account',
            environment: 'demo',
            credentials: { accountNumber: '50241890', apiSecret: 'demo-pw', serverName: 'MetaQuotes-Demo' },
          }),
        })
      ).json() as { account: { id: string; environment: string } };
      assert.equal(demoSave.account.environment, 'demo');

      const demoConn = await fetch(`${mt5Base}/brokers/accounts/${demoSave.account.id}/connect`, { method: 'POST', headers, body: '{}' });
      assert.equal(demoConn.status, 200);

      const demoOrder = await fetch(`${mt5Base}/brokers/orders`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          accountId: demoSave.account.id,
          environment: 'demo',
          symbol: 'EURUSD',
          direction: 'CALL',
          orderType: 'MARKET',
          amount: 25,
        }),
      });
      assert.equal(demoOrder.status, 201, 'MT5 Demo order should succeed');

      // 3c. Save & connect MT5 Real account + validate + execute Real order
      const realSave = await (
        await fetch(`${mt5Base}/brokers/accounts`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            brokerId: 'mt5',
            label: 'MT5 Real Account',
            environment: 'real',
            credentials: { accountNumber: '50241890', apiSecret: 'real-pw', serverName: 'Broker-Live' },
          }),
        })
      ).json() as { account: { id: string; environment: string } };
      assert.equal(realSave.account.environment, 'real', 'MT5 Real account creation must be preserved');

      const realConn = await fetch(`${mt5Base}/brokers/accounts/${realSave.account.id}/connect`, { method: 'POST', headers, body: '{}' });
      assert.equal(realConn.status, 200);
      const realConnJson = (await realConn.json()) as { account: { environment: string; accountType: string; capabilities: Record<string, unknown> } };
      assert.ok(realConnJson.account.accountType?.startsWith('REAL'), `Expected REAL accountType, got ${realConnJson.account.accountType}`);
      assert.equal(realConnJson.account.capabilities.liveOrderPlacementSupported, true);

      // Verify mismatch is blocked
      const mismatchOrder = await fetch(`${mt5Base}/brokers/orders`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          accountId: realSave.account.id,
          environment: 'demo',
          symbol: 'EURUSD',
          direction: 'CALL',
          orderType: 'MARKET',
          amount: 25,
        }),
      });
      assert.equal(mismatchOrder.status, 409, 'Mismatched environment on Real account must be blocked');

      // Verify pre-flight validate & Real execution work cleanly
      const realValidate = await fetch(`${mt5Base}/brokers/orders/validate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          accountId: realSave.account.id,
          environment: 'real',
          symbol: 'EURUSD',
          direction: 'PUT',
          orderType: 'MARKET',
          amount: 25,
        }),
      });
      assert.equal(realValidate.status, 200);
      const realValJson = (await realValidate.json()) as { validation: { valid: boolean } };
      assert.equal(realValJson.validation.valid, true);

      const realOrder = await fetch(`${mt5Base}/brokers/orders`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          accountId: realSave.account.id,
          environment: 'real',
          symbol: 'EURUSD',
          direction: 'PUT',
          orderType: 'MARKET',
          amount: 25,
        }),
      });
      assert.equal(realOrder.status, 201, 'MT5 Real order should succeed when Real MT5 account is connected');
      const realOrderJson = (await realOrder.json()) as { order: { environment: string; status: string } };
      assert.equal(realOrderJson.order.environment, 'real');
      assert.equal(realOrderJson.order.status, 'FILLED');

      // 3d. Emergency Stop immediately blocks subsequent MT5 Real orders
      await fetch(`${mt5Base}/risk/emergency-stop`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ engaged: true }),
      });
      const haltedRealOrder = await fetch(`${mt5Base}/brokers/orders`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          accountId: realSave.account.id,
          environment: 'real',
          symbol: 'EURUSD',
          direction: 'CALL',
          orderType: 'MARKET',
          amount: 25,
        }),
      });
      assert.equal(haltedRealOrder.status, 409, 'Emergency Stop must block MT5 Real orders immediately');

      assert.deepEqual(
        mockMt5.placedOrders.map((o) => o.environment),
        ['DEMO', 'REAL'],
        'Mock MT5 bridge must receive exactly 1 DEMO and 1 REAL order'
      );

      console.log('PASS: MT5 Demo & Real selection, validation, execution, Emergency Stop blocking, and IQ Option read-only limits verified.');
    } finally {
      mt5Srv.close();
      mt5App.stopScheduler();
      mockMt5.server.close();
    }

    console.log('\nALL PRODUCTION SECURITY & MT5/IQ TESTS PASSED.');
  } finally {
    sbMockServer?.close();
    process.env = savedEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('SECURITY TEST FAILED:', err);
  process.exit(1);
});

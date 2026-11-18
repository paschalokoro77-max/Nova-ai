import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createFullStackApp } from './server.ts';
import { createStandaloneApp } from './novatrade-ai/server/src/app.ts';

interface VaultRow {
  user_id: string;
  active_account_id: string | null;
  auto_execute_broker_demo: boolean;
  accounts_json: unknown[];
  orders_json: unknown[];
  idempotency_keys_json: Record<string, string>;
  updated_at: string;
}

const ALLOWED_VAULT_COLUMNS = new Set([
  'user_id',
  'active_account_id',
  'auto_execute_broker_demo',
  'accounts_json',
  'orders_json',
  'idempotency_keys_json',
  'updated_at',
]);

async function startStatefulSupabaseMock() {
  const vaultRows = new Map<string, VaultRow>();
  let failNextVaultWrite = false;
  let failNextVaultRead = false;
  let rawWriteBodies: string[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');

      if (urlObj.pathname.includes('/rest/v1/broker_vault_state')) {
        if (req.method === 'POST' || req.method === 'PATCH') {
          rawWriteBodies.push(bodyStr);
          if (failNextVaultWrite) {
            failNextVaultWrite = false;
            res.statusCode = 500;
            res.end(JSON.stringify({ message: 'Simulated Supabase outage during vault write' }));
            return;
          }
          const parsed = JSON.parse(bodyStr) as VaultRow | VaultRow[];
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          for (const row of rows) {
            // Enforce exact 007_broker_vault_state.sql column & type contract
            for (const key of Object.keys(row)) {
              if (!ALLOWED_VAULT_COLUMNS.has(key)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ code: 'PGRST204', message: `Unknown column '${key}' in broker_vault_state` }));
                return;
              }
            }
            if (typeof row.user_id !== 'string' || !row.user_id) {
              res.statusCode = 400;
              res.end(JSON.stringify({ code: '23502', message: 'null value in column user_id' }));
              return;
            }
            if (typeof row.auto_execute_broker_demo !== 'boolean') {
              res.statusCode = 400;
              res.end(JSON.stringify({ code: '22P02', message: 'invalid boolean for auto_execute_broker_demo' }));
              return;
            }
            if (!Array.isArray(row.accounts_json) || !Array.isArray(row.orders_json)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ code: '22P02', message: 'accounts_json and orders_json must be JSON arrays' }));
              return;
            }
            if (!row.idempotency_keys_json || typeof row.idempotency_keys_json !== 'object' || Array.isArray(row.idempotency_keys_json)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ code: '22P02', message: 'idempotency_keys_json must be a JSON object' }));
              return;
            }
            vaultRows.set(row.user_id, row);
          }
          res.statusCode = 201;
          res.end(JSON.stringify(rows));
          return;
        }
        if (req.method === 'GET') {
          if (failNextVaultRead) {
            failNextVaultRead = false;
            res.statusCode = 500;
            res.end(JSON.stringify({ message: 'Simulated Supabase outage during vault read' }));
            return;
          }
          const selectCols = (urlObj.searchParams.get('select') || '')
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean);
          for (const col of selectCols) {
            if (col !== '*' && !ALLOWED_VAULT_COLUMNS.has(col)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ code: '42703', message: `column broker_vault_state.${col} does not exist` }));
              return;
            }
          }
          const userFilter = urlObj.searchParams.get('user_id') || '';
          const userId = userFilter.replace(/^eq\./, '');
          const row = vaultRows.get(userId);
          const accept = String(req.headers.accept || '');
          if (accept.includes('application/vnd.pgrst.object+json')) {
            if (!row) {
              res.statusCode = 406;
              res.end(JSON.stringify({ code: 'PGRST116', message: '0 rows' }));
              return;
            }
            res.statusCode = 200;
            res.end(JSON.stringify(row));
            return;
          }
          res.statusCode = 200;
          res.end(JSON.stringify(row ? [row] : []));
          return;
        }
      }

      res.statusCode = req.method === 'POST' ? 201 : 200;
      res.end(JSON.stringify(req.method === 'GET' ? [] : {}));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    vaultRows,
    getRawWriteBodies: () => rawWriteBodies,
    setFailNextVaultWrite: (val: boolean) => {
      failNextVaultWrite = val;
    },
    setFailNextVaultRead: (val: boolean) => {
      failNextVaultRead = val;
    },
  };
}

async function startMockMt5Bridge() {
  let activeTradeMode: 'DEMO' | 'REAL' = 'DEMO';
  const placedOrders: Array<{ symbol: string; side: string; environment: string; comment: string }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyRaw = Buffer.concat(chunks).toString('utf8');
      const body = bodyRaw ? (JSON.parse(bodyRaw) as Record<string, unknown>) : {};
      res.setHeader('Content-Type', 'application/json');

      const acct = {
        login: 50241890,
        server: activeTradeMode === 'REAL' ? 'Broker-Live' : 'MetaQuotes-Demo',
        currency: 'USD',
        tradeMode: activeTradeMode,
        balance: activeTradeMode === 'REAL' ? 5000 : 10000,
        equity: activeTradeMode === 'REAL' ? 5000 : 10000,
        margin: 0,
        marginFree: activeTradeMode === 'REAL' ? 5000 : 10000,
      };

      if (req.url === '/health') {
        res.end(JSON.stringify({ status: 'ok', connected: true, ...acct }));
        return;
      }
      if (req.url === '/account') {
        res.end(JSON.stringify(acct));
        return;
      }
      if (req.url === '/connect') {
        activeTradeMode = String(body.environment || 'demo').toUpperCase() === 'REAL' ? 'REAL' : 'DEMO';
        const nextAcct = { ...acct, tradeMode: activeTradeMode, server: activeTradeMode === 'REAL' ? 'Broker-Live' : 'MetaQuotes-Demo' };
        res.end(JSON.stringify({ connected: true, ...nextAcct }));
        return;
      }
      if (req.url === '/order/validate') {
        res.end(
          JSON.stringify({
            valid: true,
            compatible: true,
            retcode: 0,
            comment: 'Done',
            mappedSymbol: body.symbol || 'EURUSD',
            volume: 0.01,
            estimatedMargin: 12,
            freeMargin: 4988,
            source: 'MT5_OFFICIAL_ORDER_CHECK',
          })
        );
        return;
      }
      if (req.url === '/order') {
        const reqEnv = String(body.environment || activeTradeMode).toUpperCase();
        placedOrders.push({
          symbol: String(body.symbol || 'EURUSD'),
          side: String(body.side || 'BUY'),
          environment: reqEnv,
          comment: String(body.comment || ''),
        });
        res.end(
          JSON.stringify({
            accepted: true,
            status: 'FILLED',
            orderId: `mt5-ord-${placedOrders.length}`,
            symbol: body.symbol || 'EURUSD',
            filledPrice: 1.1025,
            volume: 0.01,
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
  const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-dist-'));
  fs.mkdirSync(path.join(tmpDist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(tmpDist, 'index.html'), '<!doctype html><html><body>NovaTrade AI SPA</body></html>');
  fs.writeFileSync(path.join(tmpDist, 'assets', 'app.js'), 'console.log("ok");');

  const sbMock = await startStatefulSupabaseMock();
  const mt5Mock = await startMockMt5Bridge();

  try {
    process.env.NODE_ENV = 'production';
    process.env.SUPABASE_URL = sbMock.url;
    process.env.SUPABASE_ANON_KEY = 'anon-key-valid-test-value';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-valid-test-value';
    process.env.ANDROID_BRIDGE_SECRET = 'prod-android-bridge-secret-at-least-32-chars!!';
    process.env.BROKER_VAULT_SECRET = 'prod-broker-vault-secret-at-least-32-chars!!!!';
    process.env.MT5_BRIDGE_URL = mt5Mock.url;
    process.env.MT5_BRIDGE_TOKEN = 'test-mt5-token';

    const validToken = 'valid-p0-jwt';
    const userId = '11111111-2222-3333-4444-555555555555';
    const verifyToken = async (h?: string) => (h === `Bearer ${validToken}` ? { userId, email: 'trader@novatrade.ai' } : null);

    console.log('=== BUG 1: Express 4 Production SPA Routing Verification ===');
    const fullStack = await createFullStackApp({
      isProduction: true,
      distDir: tmpDist,
      routerOptions: { enableScheduler: false, autoRestore: false, requireAuth: true, verifyToken },
    });
    const fsServer = await new Promise<ReturnType<typeof fullStack.app.listen>>((resolve) => {
      const s = fullStack.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const fsPort = (fsServer.address() as { port: number }).port;
    const fsBase = `http://127.0.0.1:${fsPort}`;

    try {
      const homeRes = await fetch(`${fsBase}/`);
      assert.equal(homeRes.status, 200, 'Homepage / must return 200');
      assert.ok((await homeRes.text()).includes('NovaTrade AI SPA'));

      const deepLink1 = await fetch(`${fsBase}/dashboard`);
      assert.equal(deepLink1.status, 200, 'Deep link /dashboard must return 200');
      assert.ok((await deepLink1.text()).includes('NovaTrade AI SPA'));

      const deepLink2 = await fetch(`${fsBase}/brokers/mt5/settings`);
      assert.equal(deepLink2.status, 200, 'Nested deep link /brokers/mt5/settings must return 200');
      assert.ok((await deepLink2.text()).includes('NovaTrade AI SPA'));

      const existingAsset = await fetch(`${fsBase}/assets/app.js`);
      assert.equal(existingAsset.status, 200, 'Existing static asset must return 200');

      const missingAsset = await fetch(`${fsBase}/assets/does-not-exist.js`);
      assert.equal(missingAsset.status, 404, 'Missing static asset must return 404, not index.html');

      const apiHealth = await fetch(`${fsBase}/api/health`);
      assert.equal(apiHealth.status, 200, '/api/health must return 200 JSON');
      const healthJson = (await apiHealth.json()) as { status?: string };
      assert.equal(healthJson.status, 'ok');

      const unknownApi = await fetch(`${fsBase}/api/does-not-exist`);
      assert.equal(unknownApi.status, 404, 'Unknown /api/* route must return 404 JSON, never index.html');
      const unknownApiJson = (await unknownApi.json()) as { error?: string };
      assert.match(unknownApiJson.error || '', /API (endpoint|route) not found/);

      console.log('PASS: Homepage (/), SPA deep links (/dashboard, /brokers/mt5/settings), static assets, missing asset 404, /api/health, and unknown /api/* 404 all verified on Express 4.');
    } finally {
      fsServer.close();
      fullStack.stopScheduler();
    }

    console.log('\n=== BUG 2: Encrypted Broker Vault Supabase Persistence & Restart Recovery ===');
    const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${validToken}` };
    const secretDemoPassword = 'SuperSecret-Demo-Password-987!';
    const secretRealPassword = 'SuperSecret-Real-Password-654!';
    const orderIdempotencyKey = 'idem-order-persist-across-restart-001';

    let savedDemoId = '';
    let savedRealId = '';
    let savedOrderId = '';

    // Instance 1: Create MT5 Demo & MT5 Real accounts, connect, execute order with idempotencyKey
    const app1 = createStandaloneApp({
      persistPath: null,
      enableScheduler: false,
      autoRestore: false,
      requireAuth: true,
      verifyToken,
    });
    const srv1 = await new Promise<ReturnType<typeof app1.app.listen>>((resolve) => {
      const s = app1.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base1 = `http://127.0.0.1:${(srv1.address() as { port: number }).port}/api`;

    try {
      const demoSave = (await (
        await fetch(`${base1}/brokers/accounts`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            brokerId: 'mt5',
            label: 'Persisted MT5 Demo',
            environment: 'demo',
            credentials: { accountNumber: '50241890', apiSecret: secretDemoPassword, serverName: 'MetaQuotes-Demo' },
          }),
        })
      ).json()) as { account: { id: string; environment: string } };
      savedDemoId = demoSave.account.id;
      assert.equal(demoSave.account.environment, 'demo');

      const realSave = (await (
        await fetch(`${base1}/brokers/accounts`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            brokerId: 'mt5',
            label: 'Persisted MT5 Real',
            environment: 'real',
            credentials: { accountNumber: '50241890', apiSecret: secretRealPassword, serverName: 'Broker-Live' },
          }),
        })
      ).json()) as { account: { id: string; environment: string } };
      savedRealId = realSave.account.id;
      assert.equal(realSave.account.environment, 'real');

      // Connect Real account and place an order with explicit idempotency key
      const connReal = await fetch(`${base1}/brokers/accounts/${savedRealId}/connect`, { method: 'POST', headers: authHeaders, body: '{}' });
      assert.equal(connReal.status, 200);

      const activeRes = await fetch(`${base1}/brokers/active`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ accountId: savedRealId }),
      });
      assert.equal(activeRes.status, 200);

      const orderRes = await fetch(`${base1}/brokers/orders`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          accountId: savedRealId,
          environment: 'real',
          symbol: 'EURUSD',
          direction: 'CALL',
          orderType: 'MARKET',
          amount: 25,
          idempotencyKey: orderIdempotencyKey,
        }),
      });
      assert.equal(orderRes.status, 201);
      const orderJson = (await orderRes.json()) as { order: { id: string; environment: string; status: string } };
      savedOrderId = orderJson.order.id;
      assert.equal(orderJson.order.environment, 'real');
      assert.equal(orderJson.order.status, 'FILLED');

      // Verify zero plaintext passwords were EVER sent to Supabase
      const allWrites = sbMock.getRawWriteBodies().join('\n');
      assert.ok(allWrites.length > 0, 'Expected vault state writes to Supabase');
      assert.equal(allWrites.includes(secretDemoPassword), false, 'Plaintext demo password MUST NEVER be written to Supabase');
      assert.equal(allWrites.includes(secretRealPassword), false, 'Plaintext real password MUST NEVER be written to Supabase');

      // Verify failed DB write does NOT crash or lose in-memory accounts
      sbMock.setFailNextVaultWrite(true);
      const safeWriteRes = await fetch(`${base1}/brokers/accounts`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          brokerId: 'mt5',
          label: 'MT5 During Transient DB Error',
          environment: 'demo',
          credentials: { accountNumber: '50999999', apiSecret: 'Transient-Pass-123!', serverName: 'MetaQuotes-Demo' },
        }),
      });
      assert.equal(safeWriteRes.status, 201, 'Transient Supabase write failure must be handled safely without crashing');
      const listAfterErr = (await (await fetch(`${base1}/brokers/accounts`, { headers: authHeaders })).json()) as {
        accounts: Array<{ label: string }>;
      };
      assert.ok(
        listAfterErr.accounts.some((a) => a.label === 'Persisted MT5 Real'),
        'Existing connections must remain intact after failed DB write'
      );
    } finally {
      srv1.close();
      app1.stopScheduler();
    }

    // Instance 2 (fresh server process simulation): Verify full recovery from Supabase
    const app2 = createStandaloneApp({
      persistPath: null,
      enableScheduler: false,
      autoRestore: false,
      requireAuth: true,
      verifyToken,
    });
    const srv2 = await new Promise<ReturnType<typeof app2.app.listen>>((resolve) => {
      const s = app2.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base2 = `http://127.0.0.1:${(srv2.address() as { port: number }).port}/api`;

    try {
      // Simulate transient Supabase READ failure on first request after restart:
      // must NOT crash, must NOT poison hydration cache, and must recover on next request.
      sbMock.setFailNextVaultRead(true);
      const degradedRes = await fetch(`${base2}/brokers/accounts`, { headers: authHeaders });
      assert.equal(degradedRes.status, 200, 'Transient Supabase read failure must degrade safely without 500');

      const restoredAccountsRes = (await (await fetch(`${base2}/brokers/accounts`, { headers: authHeaders })).json()) as {
        activeAccountId: string | null;
        accounts: Array<{ id: string; label: string; environment: string; hasCredentials: boolean; connected: boolean }>;
      };
      assert.equal(restoredAccountsRes.activeAccountId, savedRealId, 'Active execution account must be restored after restart');
      const restoredDemo = restoredAccountsRes.accounts.find((a) => a.id === savedDemoId);
      const restoredReal = restoredAccountsRes.accounts.find((a) => a.id === savedRealId);
      assert.ok(restoredDemo, 'Saved MT5 Demo account must be restored after restart');
      assert.ok(restoredReal, 'Saved MT5 Real account must be restored after restart');
      assert.equal(restoredDemo!.hasCredentials, true, 'Encrypted MT5 Demo credentials must be restored');
      assert.equal(restoredReal!.hasCredentials, true, 'Encrypted MT5 Real credentials must be restored');
      assert.equal(restoredReal!.environment, 'real', 'MT5 Real environment must be preserved after restart');

      // Verify order history restored after restart
      const restoredOrdersRes = (await (await fetch(`${base2}/brokers/orders`, { headers: authHeaders })).json()) as {
        orders: Array<{ id: string; idempotencyKey: string }>;
      };
      assert.ok(
        restoredOrdersRes.orders.some((o) => o.id === savedOrderId),
        'Order history must be restored after restart'
      );

      // Verify duplicate-order protection via restored idempotency key after restart
      const dupOrderRes = await fetch(`${base2}/brokers/orders`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          accountId: savedRealId,
          environment: 'real',
          symbol: 'EURUSD',
          direction: 'CALL',
          orderType: 'MARKET',
          amount: 25,
          idempotencyKey: orderIdempotencyKey,
        }),
      });
      assert.equal(dupOrderRes.status, 200, 'Replayed idempotencyKey after restart must return 200 duplicatePrevented');
      const dupOrderJson = (await dupOrderRes.json()) as { duplicatePrevented?: boolean; order: { id: string } };
      assert.equal(dupOrderJson.duplicatePrevented, true);
      assert.equal(dupOrderJson.order.id, savedOrderId);
      assert.equal(mt5Mock.placedOrders.length, 1, 'Duplicate order after restart must NOT re-submit to MT5 bridge');

      // Verify IQ Option Real account mode is preserved without silently switching to demo
      const iqRealRes = await fetch(`${base2}/brokers/accounts`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          brokerId: 'iq_option',
          label: 'IQ Real Preserved',
          environment: 'real',
          credentials: { email: 'trader@iq.test', apiSecret: 'iq-real-secret-999' },
        }),
      });
      assert.equal(iqRealRes.status, 201, 'IQ Option real account must be preserved (no forced demo-only lock)');
      const iqRealJson = (await iqRealRes.json()) as { account: { id: string; environment: string; brokerId: string } };
      assert.equal(iqRealJson.account.brokerId, 'iq_option');
      assert.equal(iqRealJson.account.environment, 'real', 'IQ Option real account must NEVER silently switch to demo');

      console.log('PASS: Encrypted credentials persisted (zero plaintext), MT5 Demo & Real and IQ Option Real preserved after restart, order history & duplicate-order idempotency preserved, and failed DB writes handled safely.');
    } finally {
      srv2.close();
      app2.stopScheduler();
    }

    console.log('\nALL P0 BLOCKER VERIFICATION TESTS PASSED.');
  } finally {
    sbMock.server.close();
    mt5Mock.server.close();
    process.env = savedEnv;
    fs.rmSync(tmpDist, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('P0 BLOCKER TEST FAILED:', err);
  process.exit(1);
});

import assert from 'node:assert/strict';
import http from 'node:http';
import { createStandaloneApp } from './novatrade-ai/server/src/app.ts';
import type { Candle } from './novatrade-ai/server/src/quantEngine.ts';
import { getAssetDefinition } from './novatrade-ai/server/src/marketData.ts';

function buildUptrendCandles(count = 160, base = 58000, _stepSize = 26): Candle[] {
  const out: Candle[] = [];
  const start = Math.floor(Date.now() / 1000) - count * 300;
  let price = base;
  for (let i = 0; i < count; i++) {
    const phase = i % 16;
    let step = phase >= 13 ? -32 : 24;
    if (i === count - 4 || i === count - 3 || i === count - 2) step = -48;
    if (i === count - 1) step = 52;
    const open = Number(price.toFixed(2));
    const close = Number((price + step).toFixed(2));
    out.push({
      time: start + i * 300,
      open,
      high: Number((Math.max(open, close) + 34).toFixed(2)),
      low: Number((Math.min(open, close) - 30).toFixed(2)),
      close,
      volume: 350,
    });
    price = close;
  }
  return out;
}

async function startMockSupabaseWithLearningTables() {
  const vaultRows = new Map<string, Record<string, unknown>>();
  const paperTrades = new Map<string, Record<string, unknown>>();
  const userSettings = new Map<string, Record<string, unknown>>();
  const paperTradeInserts: Array<Record<string, unknown>> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');
      const accept = String(req.headers.accept || '');

      const sendRowOrArray = (row: Record<string, unknown> | undefined) => {
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
      };

      if (urlObj.pathname.includes('/rest/v1/broker_vault_state')) {
        if (req.method === 'POST' || req.method === 'PATCH') {
          const parsed = JSON.parse(bodyStr) as Record<string, unknown> | Array<Record<string, unknown>>;
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          for (const row of rows) {
            vaultRows.set(String(row.user_id), row);
          }
          res.statusCode = 201;
          res.end(JSON.stringify(rows));
          return;
        }
        if (req.method === 'GET') {
          const userId = (urlObj.searchParams.get('user_id') || '').replace(/^eq\./, '');
          sendRowOrArray(vaultRows.get(userId));
          return;
        }
      }

      if (urlObj.pathname.includes('/rest/v1/paper_trades')) {
        if (req.method === 'POST') {
          const parsed = JSON.parse(bodyStr) as Record<string, unknown> | Array<Record<string, unknown>>;
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          for (const row of rows) {
            paperTradeInserts.push(row);
            paperTrades.set(String(row.id), row);
          }
          res.statusCode = 201;
          res.end(JSON.stringify(rows));
          return;
        }
        if (req.method === 'PATCH') {
          const patch = JSON.parse(bodyStr) as Record<string, unknown>;
          const id = (urlObj.searchParams.get('id') || '').replace(/^eq\./, '');
          const prev = paperTrades.get(id) || { id };
          paperTrades.set(id, { ...prev, ...patch });
          res.statusCode = 200;
          res.end(JSON.stringify([paperTrades.get(id)]));
          return;
        }
        if (req.method === 'GET') {
          const userId = (urlObj.searchParams.get('user_id') || '').replace(/^eq\./, '');
          const rows = Array.from(paperTrades.values()).filter((r) => !userId || r.user_id === userId);
          res.statusCode = 200;
          res.end(JSON.stringify(rows));
          return;
        }
      }

      if (urlObj.pathname.includes('/rest/v1/user_settings')) {
        if (req.method === 'POST' || req.method === 'PATCH') {
          const parsed = JSON.parse(bodyStr) as Record<string, unknown> | Array<Record<string, unknown>>;
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          for (const row of rows) {
            userSettings.set(String(row.user_id), row);
          }
          res.statusCode = 201;
          res.end(JSON.stringify(rows));
          return;
        }
        if (req.method === 'GET') {
          const userId = (urlObj.searchParams.get('user_id') || '').replace(/^eq\./, '');
          const eqAuto = urlObj.searchParams.get('auto_paper_armed');
          let rows = Array.from(userSettings.values());
          if (userId) rows = rows.filter((r) => r.user_id === userId);
          if (eqAuto === 'eq.true') rows = rows.filter((r) => r.auto_paper_armed === true);
          if (accept.includes('application/vnd.pgrst.object+json')) {
            sendRowOrArray(rows[0]);
            return;
          }
          res.statusCode = 200;
          res.end(JSON.stringify(rows));
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
    paperTrades,
    paperTradeInserts,
    userSettings,
  };
}

async function startMockMt5AndIqConnectors() {
  const placedOrders: Array<{ symbol: string; side: string; environment: string; orderId: string }> = [];
  let activeTradeMode: 'DEMO' | 'REAL' = 'DEMO';
  const orderReconcileState = new Map<string, { status: string; pnl: number; filledPrice: number }>();

  const mt5Server = http.createServer((req, res) => {
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
        res.end(JSON.stringify({ connected: true, ...acct, tradeMode: activeTradeMode }));
        return;
      }
      if (req.url === '/order/validate') {
        res.end(
          JSON.stringify({
            valid: true,
            compatible: true,
            retcode: 0,
            comment: 'Done',
            mappedSymbol: body.symbol || 'BTCUSD',
            volume: 0.05,
            estimatedMargin: 25,
            freeMargin: 4975,
          })
        );
        return;
      }
      if (req.url === '/order') {
        const reqEnv = String(body.environment || activeTradeMode).toUpperCase();
        const orderId = `mt5-ord-${placedOrders.length + 1}`;
        placedOrders.push({
          symbol: String(body.symbol || 'BTCUSD'),
          side: String(body.side || 'BUY'),
          environment: reqEnv,
          orderId,
        });
        orderReconcileState.set(orderId, {
          status: 'CLOSED',
          pnl: reqEnv === 'REAL' ? 85 : 42,
          filledPrice: 62100,
        });
        res.end(
          JSON.stringify({
            accepted: true,
            status: 'SUBMITTED',
            orderId,
            symbol: body.symbol || 'BTCUSD',
            filledPrice: 62000,
            volume: 0.05,
            message: `MT5 ${reqEnv} order accepted`,
          })
        );
        return;
      }
      if (req.url?.startsWith('/orders/')) {
        const orderId = decodeURIComponent(req.url.slice('/orders/'.length));
        const rec = orderReconcileState.get(orderId);
        if (!rec) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        res.end(JSON.stringify({ status: rec.status, filledPrice: rec.filledPrice, pnl: rec.pnl, note: 'Closed in MT5' }));
        return;
      }
      if (req.url === '/history') {
        res.end(
          JSON.stringify({
            trades: [
              {
                ticket: `hist-${activeTradeMode.toLowerCase()}-9001`,
                symbol: 'EURUSD',
                direction: 'CALL',
                amount: 100,
                pnl: activeTradeMode === 'REAL' ? 75 : -35,
                entryPrice: 1.091,
                exitPrice: activeTradeMode === 'REAL' ? 1.0925 : 1.09,
                closedAt: new Date().toISOString(),
              },
            ],
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  });

  let lastIqMode = 'PRACTICE';
  const iqServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyRaw = Buffer.concat(chunks).toString('utf8');
      const body = bodyRaw ? (JSON.parse(bodyRaw) as Record<string, unknown>) : {};
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/health') {
        res.end(JSON.stringify({ connected: true, mode: lastIqMode, credentialsConfigured: true }));
        return;
      }
      if (req.url === '/account') {
        res.end(JSON.stringify({ balance: lastIqMode === 'REAL' ? 1200 : 10000, accountType: lastIqMode, currency: 'USD' }));
        return;
      }
      if (req.url === '/connect') {
        lastIqMode =
          body.password === 'iq-real-pass'
            ? 'REAL'
            : String(body.mode || (body.password === 'iq-demo-pass' ? 'PRACTICE' : lastIqMode)).toUpperCase();
        res.end(JSON.stringify({ connected: true, accountType: lastIqMode, mode: lastIqMode }));
        return;
      }
      if (req.url === '/history') {
        res.end(
          JSON.stringify({
            supported: true,
            trades: [
              {
                orderId: `iq-${lastIqMode.toLowerCase()}-701`,
                symbol: 'EURUSD',
                direction: lastIqMode === 'REAL' ? 'PUT' : 'CALL',
                amount: 50,
                pnl: lastIqMode === 'REAL' ? -50 : 40,
                entryPrice: 1.095,
                exitPrice: lastIqMode === 'REAL' ? 1.096 : 1.0962,
                closedAt: new Date().toISOString(),
              },
            ],
            note: `IQ ${lastIqMode} history synced`,
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  });

  await Promise.all([
    new Promise<void>((resolve) => mt5Server.listen(0, '127.0.0.1', () => resolve())),
    new Promise<void>((resolve) => iqServer.listen(0, '127.0.0.1', () => resolve())),
  ]);
  const mt5Port = (mt5Server.address() as { port: number }).port;
  const iqPort = (iqServer.address() as { port: number }).port;
  return {
    mt5Server,
    iqServer,
    mt5Url: `http://127.0.0.1:${mt5Port}`,
    iqUrl: `http://127.0.0.1:${iqPort}`,
    placedOrders,
  };
}

async function run() {
  const savedEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  let currentBasePrice = 58000;
  let currentStep = 26;
  // Deterministic mock Binance kline responder so BTCUSD 5m/15m live feeds run offline in <1s
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.startsWith('https://api.binance.com/api/v3/klines')) {
      const candles = buildUptrendCandles(160, currentBasePrice, currentStep);
      const rows = candles.map((c) => [
        c.time * 1000,
        String(c.open),
        String(c.high),
        String(c.low),
        String(c.close),
        String(c.volume),
      ]);
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const sbMock = await startMockSupabaseWithLearningTables();
  const connectors = await startMockMt5AndIqConnectors();

  try {
    // Allow BTCUSD to resolve via Binance mock & verify asset definition
    assert.equal(getAssetDefinition('BTCUSD').binanceSymbol, 'BTCUSDT');

    process.env.NODE_ENV = 'production';
    process.env.SUPABASE_URL = sbMock.url;
    process.env.SUPABASE_ANON_KEY = 'anon-key-valid-test-value';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-valid-test-value';
    process.env.ANDROID_BRIDGE_SECRET = 'prod-android-bridge-secret-at-least-32-chars!!';
    process.env.BROKER_VAULT_SECRET = 'prod-broker-vault-secret-at-least-32-chars!!!!';
    process.env.MT5_BRIDGE_URL = connectors.mt5Url;
    process.env.MT5_BRIDGE_TOKEN = 'test-mt5-token';
    process.env.IQ_CONNECTOR_URL = connectors.iqUrl;

    const validToken = 'runtime-repair-jwt';
    const userId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const verifyToken = async (h?: string) => (h === `Bearer ${validToken}` ? { userId, email: 'qa@novatrade.ai' } : null);
    const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${validToken}` };

    const appInst1 = createStandaloneApp({
      persistPath: null,
      enableScheduler: false,
      autoRestore: false,
      requireAuth: true,
      verifyToken,
    });
    const srv1 = await new Promise<ReturnType<typeof appInst1.app.listen>>((resolve) => {
      const s = appInst1.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base1 = `http://127.0.0.1:${(srv1.address() as { port: number }).port}/api`;

    try {
      console.log('=== 1. GET /api/learning/insights Auth & Payload Contract ===');
      const unauthInsights = await fetch(`${base1}/learning/insights`);
      assert.equal(unauthInsights.status, 401, 'GET /api/learning/insights MUST reject unauthenticated requests');

      const authInsights = await fetch(`${base1}/learning/insights`, { headers: authHeaders });
      assert.equal(authInsights.status, 200, 'GET /api/learning/insights must return 200 for authenticated session');
      const initialInsights = (await authInsights.json()) as Record<string, unknown>;
      for (const field of [
        'strategyProtection',
        'pausedStrategies',
        'byAccountBucket',
        'byInstrument',
        'byTimeframe',
        'byStrategy',
        'auditLog',
      ]) {
        assert.ok(field in initialInsights, `Insights payload must expose ${field}`);
      }
      console.log('PASS: GET /api/learning/insights enforces auth (401) and exposes complete learning/protection contract.');

      console.log('\n=== 2. Strategy Pause Enforcement Across ALL Automatic Routes & Shadow Recovery During Cooldown ===');
      const eng = appInst1.getEngineForUser(userId);
      eng.aiSettings.enabledAssets = ['BTCUSD'];
      eng.aiSettings.defaultTimeframe = '5m';
      eng.aiSettings.minSignalScore = 60;
      eng.aiSettings.expirySeconds = 60;
      eng.aiSettings.scanIntervalSeconds = 15;
      eng.riskSettings.maxConsecutiveLosses = 6; // Allow cooldown trigger after 3 losses without hard daily lockout
      eng.riskSettings.lossCooldownSeconds = 0;
      eng.riskSettings.maxSimultaneousTrades = 5;

      // Force 3 consecutive losses on TREND_CONTINUATION in automatic mode -> pauses TREND_CONTINUATION AND triggers lossCooldownUntilMs on 3rd loss
      for (let i = 0; i < 3; i++) {
        if (i === 2) eng.riskSettings.lossCooldownSeconds = 120;
        const opened = eng.openPaperTrade({
          symbol: i === 0 ? 'BTCUSD' : i === 1 ? 'ETHUSD' : 'SOLUSD',
          timeframe: '5m',
          direction: 'CALL',
          amount: 25,
          mode: 'automatic',
          entryPrice: 60000,
          atr: 150,
          expirySeconds: 60,
          signalScore: 76,
          strategyName: 'TREND_CONTINUATION',
          accountBucket: 'PAPER_SIMULATOR',
          userId,
        });
        assert.equal(opened.ok, true);
        eng.settlePaperTrade(opened.trade!.id, 'loss', 25, 59800, 'stop-loss-triggered');
      }

      assert.equal(eng.learner.isStrategyPaused('TREND_CONTINUATION').paused, true, 'TREND_CONTINUATION must be paused after 3 losses');
      const riskWhileCooldown = eng.getRiskStatus();
      assert.equal(riskWhileCooldown.allowed, false, 'Post-loss cooldown must be active');
      assert.ok(riskWhileCooldown.reasons.some((r) => r.includes('cooldown')));

      // Verify Supabase paper_trades received account_bucket and strategy_name
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(
        sbMock.paperTradeInserts.some((r) => r.account_bucket === 'PAPER_SIMULATOR' && r.strategy_name === 'TREND_CONTINUATION'),
        'paper_trades Supabase insert must include account_bucket and strategy_name'
      );

      // Arm Automatic Mode (clear temporary cooldown briefly to allow arming, then re-engage cooldown via 2nd loss or simulate armed state during cooldown)
      eng.autoPaperArmed = true;
      eng.mode = 'automatic';

      // Verify POST /api/auto-paper/evaluate during cooldown + paused strategy:
      // 1) MUST keep autoPaperArmed === true (temporary cooldown wait)
      // 2) MUST NOT bypass isStrategyPaused()
      // 3) MUST record a shadow validation signal
      const evalPausedRes = await fetch(`${base1}/auto-paper/evaluate`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ symbol: 'BTCUSD', timeframe: '5m' }),
      });
      assert.equal(evalPausedRes.status, 200);
      const evalPausedJson = (await evalPausedRes.json()) as {
        entered: boolean;
        armed: boolean;
        shadowRecorded?: boolean;
        analysis: { activeStrategy: string; direction: string };
      };
      assert.equal(evalPausedJson.entered, false, 'Paused strategy MUST NOT open a live/paper trade on /auto-paper/evaluate');
      assert.equal(evalPausedJson.armed, true, 'Temporary post-loss cooldown MUST NOT disarm Automatic Mode');
      assert.equal(evalPausedJson.shadowRecorded, true, 'Paused strategy must record shadow validation signal');
      assert.equal(eng.getPendingShadowSignalsCount(), 1, 'Pending shadow signal count must increment to 1');

      // Verify runAutonomousCycle() ALSO checks isStrategyPaused() and records shadow (not bypass)
      eng.lastScanAt = null;
      const cyclePaused = await eng.runAutonomousCycle(true);
      assert.equal(cyclePaused.opened.length, 0, 'runAutonomousCycle MUST NOT bypass isStrategyPaused()');
      assert.equal(eng.autoPaperArmed, true, 'runAutonomousCycle MUST keep autoPaperArmed true during temporary wait');

      // Simulate shadow expiry #1 while cooldown is STILL active + feed price moves higher (WIN)
      const internalShadowList = (eng as unknown as {
        pendingShadowSignals: Array<{ expiresAtMs: number; entryPrice: number }>;
      }).pendingShadowSignals;
      assert.equal(internalShadowList.length, 1);
      internalShadowList[0].entryPrice = 60000;
      internalShadowList[0].expiresAtMs = Date.now() - 1000;
      currentBasePrice = 61000; // higher than 60000 -> CALL shadow wins!

      // Settle shadow #1 via POST /api/auto-paper/evaluate during active cooldown
      const evalShadow1 = await fetch(`${base1}/auto-paper/evaluate`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ symbol: 'BTCUSD', timeframe: '5m' }),
      });
      const evalShadow1Json = (await evalShadow1.json()) as { entered: boolean; armed: boolean; shadowRecorded?: boolean };
      assert.equal(evalShadow1Json.entered, false);
      assert.equal(eng.learner.isStrategyPaused('TREND_CONTINUATION').paused, true, '1 shadow win must keep strategy paused until 2nd win');
      assert.equal(evalShadow1Json.shadowRecorded, true, 'Should record 2nd shadow setup for continued validation');

      // Expire shadow #2 while cooldown is still active and trigger settlement via runAutonomousCycle()
      assert.equal(internalShadowList.length, 1);
      internalShadowList[0].entryPrice = 60000;
      internalShadowList[0].expiresAtMs = Date.now() - 1000;
      currentBasePrice = 62000; // 2nd consecutive shadow win!

      // Even BEFORE risk cooldown expires, runAutonomousCycle MUST run settlePendingShadowSignals() and resume strategy
      await eng.runAutonomousCycle(false);
      assert.equal(
        eng.learner.isStrategyPaused('TREND_CONTINUATION').paused,
        false,
        '2 consecutive validated shadow wins MUST auto-resume strategy EVEN while risk cooldown is active'
      );
      assert.ok(
        eng.activityLog.some((e) => e.eventType === 'STRATEGY_AUTO_RESUMED'),
        'Auto-resume must record STRATEGY_AUTO_RESUMED activity event'
      );

      // Clear temporary cooldown cleanly and verify unified execution on both routes & ATR SL/TP + MT5 routing
      eng.resetDailyRiskCounters(userId);
      console.log('PASS: Both /auto-paper/evaluate and runAutonomousCycle enforce isStrategyPaused(), keep autoPaperArmed during cooldowns, and auto-resume via settlePendingShadowSignals().');

      console.log('\n=== 3. Emergency Stop Isolation Check ===');
      eng.setEmergencyStop(true, userId);
      internalShadowList.push({
        symbol: 'BTCUSD',
        timeframe: '5m',
        direction: 'CALL',
        strategy: 'TREND_CONTINUATION',
        entryPrice: 60000,
        expiresAtMs: Date.now() - 1000,
      } as never);
      const settledUnderEstop = await eng.settlePendingShadowSignals();
      assert.equal(settledUnderEstop, 0, 'Emergency Stop MUST block settlePendingShadowSignals()');
      const estopEval = await fetch(`${base1}/auto-paper/evaluate`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ symbol: 'BTCUSD', timeframe: '5m' }),
      });
      assert.equal(estopEval.status, 409, 'Emergency Stop MUST block /auto-paper/evaluate');
      internalShadowList.length = 0;
      eng.setEmergencyStop(false, userId);
      console.log('PASS: Emergency Stop blocks shadow settlement, autonomous evaluation, and trade entry.');

      console.log('\n=== 4. Independent 4-Account Tracking (MT5_DEMO, MT5_REAL, IQ_OPTION_DEMO, IQ_OPTION_REAL) & Verified Broker Outcomes ===');
      // Create & use MT5 DEMO, MT5 REAL, IQ OPTION DEMO, IQ OPTION REAL
      const createAcct = async (payload: Record<string, unknown>) => {
        const r = await fetch(`${base1}/brokers/accounts`, { method: 'POST', headers: authHeaders, body: JSON.stringify(payload) });
        assert.equal(r.status, 201);
        return ((await r.json()) as { account: { id: string; environment: string; brokerId: string } }).account;
      };

      const mt5Demo = await createAcct({
        brokerId: 'mt5',
        label: 'QA MT5 Demo',
        environment: 'demo',
        credentials: { accountNumber: '50241890', apiSecret: 'demo-pass', serverName: 'MetaQuotes-Demo', bridgeUrl: connectors.mt5Url },
      });
      const mt5Real = await createAcct({
        brokerId: 'mt5',
        label: 'QA MT5 Real',
        environment: 'real',
        credentials: { accountNumber: '50241890', apiSecret: 'real-pass', serverName: 'Broker-Live', bridgeUrl: connectors.mt5Url },
      });
      const iqDemo = await createAcct({
        brokerId: 'iq_option',
        label: 'QA IQ Demo',
        environment: 'demo',
        credentials: { email: 'qa@iq.test', apiSecret: 'iq-demo-pass', bridgeUrl: connectors.iqUrl },
      });
      const iqReal = await createAcct({
        brokerId: 'iq_option',
        label: 'QA IQ Real',
        environment: 'real',
        credentials: { email: 'qa@iq.test', apiSecret: 'iq-real-pass', bridgeUrl: connectors.iqUrl },
      });

      assert.equal(mt5Real.environment, 'real', 'MT5 Real must preserve real environment');
      assert.equal(iqReal.environment, 'real', 'IQ Option Real must preserve real environment');

      // Age prior test trades >10s so 10-second duplicate-order window has elapsed between distinct cycles
      for (const t of eng.paperTrades) {
        t.createdAt = new Date(Date.now() - 15_000).toISOString();
      }

      // Enable auto-broker routing + connect & select MT5 DEMO -> run unified /auto-paper/evaluate
      const connDemo = await fetch(`${base1}/brokers/accounts/${mt5Demo.id}/connect`, { method: 'POST', headers: authHeaders, body: '{}' });
      assert.equal(connDemo.status, 200);
      await fetch(`${base1}/brokers/active`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ accountId: mt5Demo.id }) });
      await fetch(`${base1}/brokers/auto-execution`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ enabled: true }) });
      await fetch(`${base1}/auto-paper/arm`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ enabled: true }) });

      const autoDemoRes = await fetch(`${base1}/auto-paper/evaluate`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ symbol: 'BTCUSD', timeframe: '5m' }),
      });
      const autoDemoJson = (await autoDemoRes.json()) as {
        reason?: string;
        trade: { id: string; accountBucket: string; strategyName: string; stopLoss: number; takeProfit: number; entryPrice?: number };
      };
      assert.equal(autoDemoRes.status, 201, `Expected 201 from /auto-paper/evaluate, got ${autoDemoRes.status}: ${JSON.stringify(autoDemoJson)}`);
      assert.equal(autoDemoJson.trade.accountBucket, 'MT5_DEMO', 'Active MT5 Demo trade MUST be attributed to MT5_DEMO');
      assert.equal(autoDemoJson.trade.strategyName, 'TREND_CONTINUATION');
      assert.ok(autoDemoJson.trade.stopLoss > 0 && autoDemoJson.trade.takeProfit > autoDemoJson.trade.entryPrice!);
      assert.equal(connectors.placedOrders.length, 1);
      assert.equal(connectors.placedOrders[0].environment, 'DEMO');

      // Connect MT5 REAL, settle synthetic paper trade & switch to MT5 REAL -> execute order -> reconcile -> sync history
      const connReal = await fetch(`${base1}/brokers/accounts/${mt5Real.id}/connect`, { method: 'POST', headers: authHeaders, body: '{}' });
      assert.equal(connReal.status, 200);
      await fetch(`${base1}/brokers/active`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ accountId: mt5Real.id }) });
      await fetch(`${base1}/brokers/auto-execution`, { method: 'PUT', headers: authHeaders, body: JSON.stringify({ enabled: true }) });
      // Verify paper simulation entry via runAutonomousCycle attributes MT5_REAL when MT5_REAL is active
      eng.settlePaperTrade(autoDemoJson.trade.id, 'win', 40, 62500, 'take-profit-triggered');
      for (const t of eng.paperTrades) {
        t.createdAt = new Date(Date.now() - 15_000).toISOString();
      }
      eng.lastScanAt = null;
      const realCycle = await fetch(`${base1}/auto-paper/cycle`, { method: 'POST', headers: authHeaders, body: '{}' });
      assert.equal(realCycle.status, 200);
      const realCycleJson = (await realCycle.json()) as { opened: Array<{ accountBucket: string; strategyName: string }> };
      assert.equal(realCycleJson.opened.length, 1);
      assert.equal(realCycleJson.opened[0].accountBucket, 'MT5_REAL', 'Cycle with active MT5 Real MUST attribute MT5_REAL (not PAPER_SIMULATOR)');
      assert.equal(connectors.placedOrders.length, 2);
      assert.equal(connectors.placedOrders[1].environment, 'REAL', 'onAutonomousSignalTriggered must preserve REAL environment');

      // Reconcile both MT5 Demo & Real orders + verify dedup on repeated reconcile
      const recRes1 = await fetch(`${base1}/brokers/orders/reconcile`, { method: 'POST', headers: authHeaders, body: '{}' });
      assert.equal(recRes1.status, 200);
      const insightsAfterRec1 = (await (await fetch(`${base1}/learning/insights`, { headers: authHeaders })).json()) as {
        validTradesAnalyzed: number;
        byAccountBucket: Record<string, { trades: number; wins: number; losses: number; netPnl: number }>;
      };

      // Reconcile AGAIN -> must NOT duplicate learning records
      await fetch(`${base1}/brokers/orders/reconcile`, { method: 'POST', headers: authHeaders, body: '{}' });
      const insightsAfterRec2 = (await (await fetch(`${base1}/learning/insights`, { headers: authHeaders })).json()) as typeof insightsAfterRec1;
      assert.equal(
        insightsAfterRec2.validTradesAnalyzed,
        insightsAfterRec1.validTradesAnalyzed,
        'Repeated reconciliation MUST NOT create duplicate learning records'
      );

      // Sync trade history on MT5 Demo, MT5 Real, IQ Demo, IQ Real
      await fetch(`${base1}/brokers/accounts/${mt5Demo.id}/connect`, { method: 'POST', headers: authHeaders, body: '{}' });
      await fetch(`${base1}/brokers/accounts/${mt5Demo.id}/history`, { headers: authHeaders });
      await fetch(`${base1}/brokers/accounts/${mt5Real.id}/connect`, { method: 'POST', headers: authHeaders, body: '{}' });
      await fetch(`${base1}/brokers/accounts/${mt5Real.id}/history`, { headers: authHeaders });
      await fetch(`${base1}/brokers/accounts/${iqDemo.id}/connect`, { method: 'POST', headers: authHeaders, body: '{}' });
      await fetch(`${base1}/brokers/accounts/${iqDemo.id}/history`, { headers: authHeaders });
      await fetch(`${base1}/brokers/accounts/${iqReal.id}/connect`, { method: 'POST', headers: authHeaders, body: '{}' });
      await fetch(`${base1}/brokers/accounts/${iqReal.id}/history`, { headers: authHeaders });

      // IQ Option order execution safety guard (blocked with 409 mode mismatch when broker mode is PRACTICE, or 423 if locked)
      const iqBlocked = await fetch(`${base1}/brokers/orders`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          accountId: iqReal.id,
          environment: 'real',
          symbol: 'EURUSD',
          direction: 'CALL',
          orderType: 'BINARY_FIXED_EXPIRY',
          amount: 25,
        }),
      });
      assert.ok(
        iqBlocked.status === 409 || iqBlocked.status === 423,
        `IQ Option real order safely blocked against mode mismatch or lock (got ${iqBlocked.status})`
      );

      // Verify duplicate history sync does NOT duplicate IQ/MT5 counts
      const insightsBeforeDupSync = (await (await fetch(`${base1}/learning/insights`, { headers: authHeaders })).json()) as typeof insightsAfterRec1;
      await fetch(`${base1}/brokers/accounts/${iqDemo.id}/history`, { headers: authHeaders });
      await fetch(`${base1}/brokers/accounts/${iqReal.id}/history`, { headers: authHeaders });
      const insightsFinal1 = (await (await fetch(`${base1}/learning/insights`, { headers: authHeaders })).json()) as typeof insightsAfterRec1;
      assert.equal(
        insightsFinal1.validTradesAnalyzed,
        insightsBeforeDupSync.validTradesAnalyzed,
        'Repeated history sync MUST NOT duplicate learning records'
      );

      assert.ok(insightsFinal1.byAccountBucket.MT5_DEMO.trades >= 2, 'MT5_DEMO must track MT5 demo trades');
      assert.ok(insightsFinal1.byAccountBucket.MT5_REAL.trades >= 2, 'MT5_REAL must track MT5 real trades');
      assert.equal(insightsFinal1.byAccountBucket.IQ_OPTION_DEMO.trades, 1, 'IQ_OPTION_DEMO must track IQ Option demo history independently');
      assert.equal(insightsFinal1.byAccountBucket.IQ_OPTION_REAL.trades, 1, 'IQ_OPTION_REAL must track IQ Option real history independently');
      console.log('PASS: All 4 buckets (MT5_DEMO, MT5_REAL, IQ_OPTION_DEMO, IQ_OPTION_REAL) tracked independently without misclassifying as PAPER_SIMULATOR or duplicating records.');

      console.log('\n=== 5. integrateAndroidScreenVision() historicalBias Integration ===');
      // Seed 10 historical SOLUSD 5m losses in engine to activate instrument caution bias
      eng.riskSettings.maxConsecutiveLosses = 20;
      eng.riskSettings.maxDailyTrades = 50;
      for (let i = 0; i < 10; i++) {
        const lossTrade = eng.openPaperTrade({
          symbol: 'SOLUSD',
          timeframe: '5m',
          direction: 'CALL',
          amount: 10,
          mode: 'manual',
          entryPrice: 150,
          strategyName: 'TREND_CONTINUATION',
          accountBucket: 'MT5_DEMO',
          userId,
        });
        assert.equal(lossTrade.ok, true, `Failed seeding loss #${i}: ${lossTrade.error}`);
        eng.settlePaperTrade(lossTrade.trade!.id, 'loss', 10, 148, 'manual');
      }
      const visionResult = await eng.integrateAndroidScreenVision({
        appName: 'MT5',
        accountMode: 'DEMO',
        symbol: 'SOLUSD',
        timeframe: '5m',
        detectedPrice: 62000,
        visualBias: 'CALL',
        visualConfidence: 82,
        summary: 'Bullish continuation observed on MT5 mobile',
        riskWarning: 'Verify spread',
        observations: ['Clean breakout'],
        model: 'test-vision',
        userId,
      });
      assert.equal(visionResult.quantMatched, true);
      assert.ok(
        (visionResult.signal.confidenceCalibration?.historicalAdjustment ?? 0) <= -8,
        `integrateAndroidScreenVision MUST pass historicalBias into analyzeMarketQuant() (got historicalAdjustment=${visionResult.signal.confidenceCalibration?.historicalAdjustment})`
      );
      assert.ok(
        visionResult.signal.reasons.some((r) => r.includes('required >= 7')) ||
          visionResult.signal.reasons.some((r) => r.includes('Historical caution: SOLUSD')),
        'integrateAndroidScreenVision MUST apply historicalBias scoreThresholdOffset / caution'
      );
      console.log('PASS: integrateAndroidScreenVision() passes historicalBias into analyzeMarketQuant().');
    } finally {
      srv1.close();
      appInst1.stopScheduler();
    }

    console.log('\n=== 6. Full Server Restart Persistence Recovery (Supabase paper_trades + broker_vault_state) ===');
    const appInst2 = createStandaloneApp({
      persistPath: null,
      enableScheduler: false,
      autoRestore: true,
      requireAuth: true,
      verifyToken,
    });
    const recSummary = await appInst2.recoveryPromise;
    assert.ok(recSummary.completed);
    const srv2 = await new Promise<ReturnType<typeof appInst2.app.listen>>((resolve) => {
      const s = appInst2.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base2 = `http://127.0.0.1:${(srv2.address() as { port: number }).port}/api`;
    try {
      const restoredEng = appInst2.getEngineForUser(userId);
      // Verify strategyName and accountBucket survived restart
      assert.ok(
        restoredEng.paperTrades.some((t) => t.accountBucket === 'MT5_DEMO' && t.strategyName === 'TREND_CONTINUATION'),
        'Restored Supabase paper trades MUST retain accountBucket and strategyName'
      );
      // Verify GET /api/learning/insights after restart restores broker orders & paused strategies
      const restoredInsights = (await (await fetch(`${base2}/learning/insights`, { headers: authHeaders })).json()) as {
        validTradesAnalyzed: number;
        byAccountBucket: Record<string, { trades: number }>;
        pausedStrategies: string[];
      };
      assert.ok(restoredInsights.byAccountBucket.MT5_DEMO.trades >= 1, 'MT5_DEMO broker/paper outcomes restored across restart');
      assert.ok(restoredInsights.byAccountBucket.MT5_REAL.trades >= 1, 'MT5_REAL broker outcomes restored across restart');
      assert.ok(
        restoredInsights.pausedStrategies.includes('TREND_CONTINUATION'),
        'Restored 10 SOLUSD TREND_CONTINUATION losses must automatically re-engage TREND_CONTINUATION pause protection on startup'
      );
      console.log('PASS: Restart recovery restored accountBucket, strategyName, broker_vault_state settled orders, and PerformanceLearner protection.');
    } finally {
      srv2.close();
      appInst2.stopScheduler();
    }

    console.log('\n=== 7. Unarmed Workspace Auto-Hydration (auto_paper_armed = false, No /api/state/hydrate) ===');
    const prevSettings = sbMock.userSettings.get(userId) || { user_id: userId };
    sbMock.userSettings.set(userId, {
      ...prevSettings,
      user_id: userId,
      preferred_mode: 'assisted',
      auto_paper_armed: false,
      emergency_stop: false,
    });
    const ordersBeforeUnarmedRestart = connectors.placedOrders.length;

    const appInst3 = createStandaloneApp({
      persistPath: null,
      enableScheduler: false,
      autoRestore: true,
      requireAuth: true,
      verifyToken,
    });
    const recSummary3 = await appInst3.recoveryPromise;
    assert.ok(recSummary3.completed);
    assert.equal(
      recSummary3.restoredUserIds.includes(userId),
      false,
      'Startup scheduler recovery must NOT arm/restore unarmed workspace as active scheduler'
    );

    const srv3 = await new Promise<ReturnType<typeof appInst3.app.listen>>((resolve) => {
      const s = appInst3.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base3 = `http://127.0.0.1:${(srv3.address() as { port: number }).port}/api`;
    try {
      const [tradesRes, insightsRes, tradesRepeatRes, modeRes, acctsRes, ordsRes] = await Promise.all([
        fetch(`${base3}/paper-trades`, { headers: authHeaders }),
        fetch(`${base3}/learning/insights`, { headers: authHeaders }),
        fetch(`${base3}/paper-trades`, { headers: authHeaders }),
        fetch(`${base3}/mode`, { headers: authHeaders }),
        fetch(`${base3}/brokers/accounts`, { headers: authHeaders }),
        fetch(`${base3}/brokers/orders`, { headers: authHeaders }),
      ]);

      assert.equal(tradesRes.status, 200);
      assert.equal(insightsRes.status, 200);
      const tradesData = (await tradesRes.json()) as {
        trades: Array<{ id: string; accountBucket?: string; strategyName?: string; status: string }>;
      };
      const tradesRepeatData = (await tradesRepeatRes.json()) as {
        trades: Array<{ id: string }>;
      };
      const insightsData = (await insightsRes.json()) as {
        validTradesAnalyzed: number;
        byAccountBucket: Record<string, { trades: number }>;
        pausedStrategies: string[];
      };
      const modeData = (await modeRes.json()) as { mode: string; autoArmed: boolean };
      const acctsData = (await acctsRes.json()) as { accounts: unknown[]; activeAccountId: string | null };
      const ordsData = (await ordsRes.json()) as { orders: unknown[] };

      const uniqueIds = new Set(tradesData.trades.map((t) => t.id));
      assert.equal(tradesData.trades.length, uniqueIds.size, 'Concurrent workspace hydration must not duplicate trade records');
      assert.equal(tradesRepeatData.trades.length, tradesData.trades.length, 'Repeated GET /api/paper-trades must remain idempotent');
      assert.ok(
        tradesData.trades.some((t) => t.accountBucket === 'MT5_DEMO' && t.strategyName === 'TREND_CONTINUATION'),
        'GET /api/paper-trades must restore accountBucket and strategyName when auto_paper_armed = false'
      );
      assert.ok(insightsData.validTradesAnalyzed >= 10, 'GET /api/learning/insights must analyze restored history when auto_paper_armed = false');
      assert.ok(insightsData.byAccountBucket.MT5_DEMO.trades >= 1, 'MT5_DEMO bucket restored');
      assert.ok(insightsData.pausedStrategies.includes('TREND_CONTINUATION'), 'Strategy protection state restored when auto_paper_armed = false');
      assert.equal(modeData.mode, 'assisted', 'Mode preserved');
      assert.equal(modeData.autoArmed, false, 'Automatic Mode MUST remain OFF when auto_paper_armed = false');
      assert.equal(connectors.placedOrders.length, ordersBeforeUnarmedRestart, 'No broker orders may execute during hydration');
      assert.ok(acctsData.accounts.length >= 2 && Boolean(acctsData.activeAccountId), 'Broker accounts and active selection preserved');
      assert.ok(ordsData.orders.length >= 1, 'Broker order history preserved');
      console.log('PASS: Unarmed workspace automatically hydrated paper trades, attribution, learning insights, and strategy protection without arming auto mode or executing orders.');
    } finally {
      srv3.close();
      appInst3.stopScheduler();
    }

    console.log('\nALL RUNTIME INTEGRATION REPAIR VERIFICATION TESTS PASSED.');
  } finally {
    globalThis.fetch = originalFetch;
    sbMock.server.close();
    connectors.mt5Server.close();
    connectors.iqServer.close();
    process.env = savedEnv;
  }
}

run().catch((err) => {
  console.error('RUNTIME INTEGRATION TEST FAILED:', err);
  process.exit(1);
});

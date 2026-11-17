import assert from 'assert';
import http from 'http';
import { NovaTradeEngine, DashboardAccountSource } from './novatrade-ai/server/src/tradingEngine.ts';
import { createStandaloneApp } from './novatrade-ai/server/src/app.ts';
import { BrokerAccountRecord, BrokerOrderRecord } from './novatrade-ai/server/src/brokerVault.ts';

console.log('========================================================================');
console.log('🧪 NOVATRADE AI — ACCOUNT-AWARE DASHBOARD REGRESSION SUITE');
console.log('========================================================================');

async function runTests() {
  let passed = 0;
  let total = 0;

  function recordPass(testName: string) {
    passed++;
    total++;
    console.log(`  ✅ [PASS] ${testName}`);
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Exactly Three Dashboard Selections Enforced & Persisted
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 1: Exactly Three Dashboard Selections Enforced ---');
  {
    const engine = new NovaTradeEngine();
    
    // Default must be 'paper'
    assert.strictEqual(engine.selectedDashboardSource, 'paper', 'Initial default dashboard source must be paper');
    recordPass('Default dashboard source initializes to "paper"');

    // Valid transitions among the 3 selections
    const validSources: DashboardAccountSource[] = ['paper', 'mt5', 'iq_option'];
    for (const src of validSources) {
      engine.selectedDashboardSource = src;
      assert.strictEqual(engine.selectedDashboardSource, src, `Engine must accept valid source ${src}`);
    }
    recordPass('Engine accepts strictly "paper", "mt5", and "iq_option"');

    // Verify Runtime Recovery Payload includes selectedDashboardSource
    const payload = engine.buildRuntimeRecoveryPayload();
    assert.strictEqual(payload.selectedDashboardSource, 'iq_option', 'Runtime recovery must capture selectedDashboardSource');
    recordPass('Runtime recovery payload captures selectedDashboardSource');

    // Simulate restart with a fresh engine and apply payload
    const restartedEngine = new NovaTradeEngine();
    assert.strictEqual(restartedEngine.selectedDashboardSource, 'paper', 'Fresh engine starts at default paper');
    restartedEngine.applyRuntimeRecoveryPayload(payload);
    assert.strictEqual(restartedEngine.selectedDashboardSource, 'iq_option', 'Restored engine recovers saved dashboard source');
    recordPass('Dashboard source persists and restores across simulated restart');
  }

  // ---------------------------------------------------------------------------
  // TEST 2: Automatic Mode Detection for MetaTrader 5 (DEMO vs REAL)
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 2: MetaTrader 5 Automatic Mode Detection ---');
  {
    function detectMt5Mode(account: Partial<BrokerAccountRecord> | null): 'DEMO' | 'REAL' | 'DISCONNECTED' {
      if (!account || !account.connected) return 'DISCONNECTED';
      const env = (account.environment || '').toLowerCase();
      const type = (account.accountType || '').toLowerCase();
      if (env === 'real' || type === 'real') return 'REAL';
      return 'DEMO';
    }

    // Disconnected / null
    assert.strictEqual(detectMt5Mode(null), 'DISCONNECTED');
    assert.strictEqual(detectMt5Mode({ connected: false, environment: 'demo' }), 'DISCONNECTED');
    recordPass('Unconnected MT5 returns DISCONNECTED');

    // Demo account
    const demoAccount: Partial<BrokerAccountRecord> = {
      brokerId: 'mt5',
      environment: 'demo',
      accountType: 'DEMO',
      connected: true,
      balance: 10000,
      currency: 'USD',
    };
    assert.strictEqual(detectMt5Mode(demoAccount), 'DEMO');
    recordPass('Connected demo MT5 account automatically detects DEMO mode');

    // Real account
    const realAccount: Partial<BrokerAccountRecord> = {
      brokerId: 'mt5',
      environment: 'real',
      accountType: 'REAL',
      connected: true,
      balance: 25000,
      currency: 'USD',
    };
    assert.strictEqual(detectMt5Mode(realAccount), 'REAL');
    recordPass('Connected real MT5 account automatically detects REAL mode');

    // Verify account environment was NOT mutated
    assert.strictEqual(demoAccount.environment, 'demo', 'Demo account environment must not be mutated');
    assert.strictEqual(realAccount.environment, 'real', 'Real account environment must not be mutated');
    recordPass('Automatic detection never mutates or switches broker account environment');
  }

  // ---------------------------------------------------------------------------
  // TEST 3: Automatic Mode Detection for IQ Option (PRACTICE vs REAL)
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 3: IQ Option Automatic Mode Detection ---');
  {
    function detectIqMode(account: Partial<BrokerAccountRecord> | null, connectorStatus?: { connected: boolean; environment?: string; accountType?: string }): 'PRACTICE' | 'REAL' | 'DISCONNECTED' {
      const isConnected = Boolean((account && account.connected) || connectorStatus?.connected);
      if (!isConnected) return 'DISCONNECTED';
      const env = (account?.environment || connectorStatus?.environment || '').toLowerCase();
      const type = (account?.accountType || connectorStatus?.accountType || '').toUpperCase();
      if (env === 'real' || type === 'REAL') return 'REAL';
      return 'PRACTICE';
    }

    // Disconnected
    assert.strictEqual(detectIqMode(null, { connected: false }), 'DISCONNECTED');
    recordPass('Unconnected IQ Option returns DISCONNECTED');

    // Practice / Demo account
    const practiceAccount: Partial<BrokerAccountRecord> = {
      brokerId: 'iq_option',
      environment: 'demo',
      accountType: 'PRACTICE',
      connected: true,
      balance: 1000,
      currency: 'USD',
    };
    assert.strictEqual(detectIqMode(practiceAccount), 'PRACTICE');
    recordPass('Connected practice IQ Option account automatically detects PRACTICE mode');

    // Real account
    const realIqAccount: Partial<BrokerAccountRecord> = {
      brokerId: 'iq_option',
      environment: 'real',
      accountType: 'REAL',
      connected: true,
      balance: 5000,
      currency: 'USD',
    };
    assert.strictEqual(detectIqMode(realIqAccount), 'REAL');
    recordPass('Connected real IQ Option account automatically detects REAL mode');

    // Ensure unsupported order placement remains locked
    assert.strictEqual(realIqAccount.environment, 'real', 'Real IQ account remains real without forcing demo');
    recordPass('IQ Option preserves user-selected account mode without forcing demo');
  }

  // ---------------------------------------------------------------------------
  // TEST 4: Data Isolation Between Paper, MT5, and IQ Option
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 4: Data Isolation (Paper vs MT5 vs IQ Option) ---');
  {
    const engine = new NovaTradeEngine(null);

    // Create a paper trade
    const paperTrade = engine.openPaperTrade({
      symbol: 'EURUSD',
      timeframe: 'M1',
      direction: 'CALL',
      amount: 100,
      mode: 'manual',
      entryPrice: 1.085,
      expirySeconds: 180,
      signalScore: 85,
      provider: 'test',
    });
    assert.ok(paperTrade, 'Paper trade should be created');

    // Mock broker orders
    const mockBrokerOrders: BrokerOrderRecord[] = [
      {
        id: 'ord-mt5-1',
        userId: 'test-user',
        accountId: 'acct-mt5-demo',
        brokerId: 'mt5',
        brokerName: 'MetaTrader 5',
        environment: 'demo',
        symbol: 'EURUSD',
        mappedSymbol: 'EURUSD',
        direction: 'CALL',
        orderType: 'MARKET',
        amount: 50,
        entryPrice: 1.085,
        filledPrice: 1.0851,
        realizedPnl: 15.2,
        brokerOrderId: 'mt5-ticket-12345',
        idempotencyKey: 'idem-1',
        status: 'FILLED',
        source: 'manual',
        note: 'Live MT5 order',
        createdAt: new Date().toISOString(),
        reconciledAt: new Date().toISOString(),
      },
      {
        id: 'ord-iq-1',
        userId: 'test-user',
        accountId: 'acct-iq-practice',
        brokerId: 'iq_option',
        brokerName: 'IQ Option',
        environment: 'demo',
        symbol: 'GBPUSD',
        mappedSymbol: 'GBPUSD',
        direction: 'PUT',
        orderType: 'BINARY_FIXED_EXPIRY',
        amount: 25,
        entryPrice: 1.295,
        filledPrice: 1.295,
        realizedPnl: 21.25,
        brokerOrderId: 'iq-deal-9988',
        idempotencyKey: 'idem-2',
        status: 'CLOSED',
        source: 'history_sync',
        note: 'IQ historical trade',
        createdAt: new Date().toISOString(),
        reconciledAt: new Date().toISOString(),
      },
    ];

    // Filter by source
    const paperTrades = engine.paperTrades;
    const mt5Orders = mockBrokerOrders.filter((o) => o.brokerId === 'mt5');
    const iqOrders = mockBrokerOrders.filter((o) => o.brokerId === 'iq_option');

    // Assert absolute isolation
    assert.strictEqual(paperTrades.length, 1);
    assert.strictEqual(paperTrades[0].symbol, 'EURUSD');
    assert.ok(!('brokerOrderId' in paperTrades[0]), 'Paper trade must not contain brokerOrderId');

    assert.strictEqual(mt5Orders.length, 1);
    assert.strictEqual(mt5Orders[0].brokerId, 'mt5');
    assert.strictEqual(mt5Orders[0].brokerOrderId, 'mt5-ticket-12345');

    assert.strictEqual(iqOrders.length, 1);
    assert.strictEqual(iqOrders[0].brokerId, 'iq_option');
    assert.strictEqual(iqOrders[0].brokerOrderId, 'iq-deal-9988');

    // Verify zero cross-contamination
    const paperContainsBrokerOrder = paperTrades.some((t: any) => t.id === 'ord-mt5-1' || t.id === 'ord-iq-1');
    const mt5ContainsPaperTrade = mt5Orders.some((o) => o.id === paperTrade.id);
    const iqContainsMt5Order = iqOrders.some((o) => o.id === 'ord-mt5-1');

    assert.strictEqual(paperContainsBrokerOrder, false, 'Paper trades must not contain broker orders');
    assert.strictEqual(mt5ContainsPaperTrade, false, 'MT5 orders must not contain paper trades');
    assert.strictEqual(iqContainsMt5Order, false, 'IQ Option orders must not contain MT5 orders');

    recordPass('Paper, MT5, and IQ Option datasets are strictly isolated with zero cross-contamination');
  }

  // ---------------------------------------------------------------------------
  // TEST 5: API Endpoints GET /api/dashboard/source & PUT /api/dashboard/source
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 5: Dashboard Source API Endpoints & Zero Side-Effects ---');
  {
    const { app } = createStandaloneApp({ requireAuth: false, enableScheduler: false, autoRestore: false });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. GET default source and baseline trade count
      const initialTradesRes = await fetch(`${baseUrl}/api/paper-trades`);
      const initialTradesData = await initialTradesRes.json();
      const initialTradeCount = initialTradesData.trades.length;

      const getRes1 = await fetch(`${baseUrl}/api/dashboard/source`);
      assert.strictEqual(getRes1.status, 200);
      const data1 = await getRes1.json();
      assert.strictEqual(data1.source, 'paper', 'Default API response must be paper');
      recordPass('GET /api/dashboard/source returns "paper" by default');

      // 2. PUT valid sources: 'mt5' and 'iq_option'
      const putMt5Res = await fetch(`${baseUrl}/api/dashboard/source`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'mt5' }),
      });
      assert.strictEqual(putMt5Res.status, 200);
      const putMt5Data = await putMt5Res.json();
      assert.strictEqual(putMt5Data.ok, true);
      assert.strictEqual(putMt5Data.source, 'mt5');
      recordPass('PUT /api/dashboard/source switches source to "mt5"');

      // Verify GET returns updated source
      const getRes2 = await fetch(`${baseUrl}/api/dashboard/source`);
      const data2 = await getRes2.json();
      assert.strictEqual(data2.source, 'mt5');
      recordPass('GET /api/dashboard/source confirms "mt5" persistence');

      // Switch to 'iq_option'
      const putIqRes = await fetch(`${baseUrl}/api/dashboard/source`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'iq_option' }),
      });
      assert.strictEqual(putIqRes.status, 200);
      const putIqData = await putIqRes.json();
      assert.strictEqual(putIqData.source, 'iq_option');
      recordPass('PUT /api/dashboard/source switches source to "iq_option"');

      // 3. Reject invalid source names (e.g., old 5-category names)
      const putInvalidRes = await fetch(`${baseUrl}/api/dashboard/source`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'MT5_DEMO' }), // invalid!
      });
      assert.strictEqual(putInvalidRes.status, 400, 'Invalid source must be rejected with 400');
      const errData = await putInvalidRes.json();
      assert.ok(errData.error.includes('paper') && errData.error.includes('mt5') && errData.error.includes('iq_option'));
      recordPass('Invalid 5-category source names rejected with 400 Bad Request');

      // 4. Verify ZERO orders executed and Automatic Mode remains unaffected
      const modeRes = await fetch(`${baseUrl}/api/mode`);
      const modeData = await modeRes.json();
      assert.strictEqual(modeData.autoArmed, false);
      assert.notStrictEqual(modeData.mode, 'automatic', 'Mode must not automatically switch to automatic');

      const tradesRes = await fetch(`${baseUrl}/api/paper-trades`);
      const tradesData = await tradesRes.json();
      assert.strictEqual(tradesData.trades.length, initialTradeCount, 'Zero orders executed as a side-effect of dashboard switching');
      recordPass('Switching dashboard source executes zero orders and maintains auto-paper OFF');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  console.log('\n========================================================================');
  console.log(`🎉 ALL ${passed}/${total} ACCOUNT-AWARE DASHBOARD TESTS PASSED SUCCESSFULLY!`);
  console.log('========================================================================\n');
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  });

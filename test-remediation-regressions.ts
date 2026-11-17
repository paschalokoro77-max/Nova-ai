import 'dotenv/config';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createFullStackApp } from './server.ts';
import { createStandaloneApp, createCorsOriginHandler, resolveAllowedCorsOrigins } from './novatrade-ai/server/src/app.ts';
import { AndroidCompanionManager } from './novatrade-ai/server/src/androidCompanion.ts';
import { BrokerConnectionManager } from './novatrade-ai/server/src/brokers/connectionManager.ts';
import { BrokerRegistry } from './novatrade-ai/server/src/brokers/registry.ts';
import { NovaTradeEngine } from './novatrade-ai/server/src/tradingEngine.ts';
import { runSupabaseDiagnostics } from './novatrade-ai/server/src/supabaseAdmin.ts';

const userId = 'qa-remediation-user';
const authHeaders = {
  'content-type': 'application/json',
  authorization: `Bearer test-token-${userId}`,
};
const verifyToken = async (h?: string) => {
  if (h && h.includes(userId)) return { userId, email: `${userId}@test.local` };
  return null;
};

async function run() {
  console.log('=== NOVATRADE AI: PRODUCTION BLOCKER REMEDIATION REGRESSION SUITE ===\n');

  const sbMockServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = req.method === 'POST' ? 201 : 200;
      const url = req.url || '';
      if (url.includes('/rpc/redeem_android_pairing_code')) {
        res.end(
          JSON.stringify({
            id: 'dev-1234',
            user_id: userId,
            device_name: 'Remediation QA Phone',
            device_model: 'Pixel',
            os_version: '14',
            device_token_hash: 'mockhash',
            token_prefix: 'nt_dev_mock',
            permissions: { allowMt5: true, allowIqOption: true },
            status: 'ACTIVE',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
        );
        return;
      }
      if (url.includes('android_devices')) {
        const hashMatch = url.match(/device_token_hash=eq\.([^&]+)/);
        const hash = hashMatch ? decodeURIComponent(hashMatch[1]) : 'mockhash';
        res.end(
          JSON.stringify([
            {
              id: 'dev-1234',
              user_id: userId,
              device_name: 'Remediation QA Phone',
              device_token_hash: hash,
              token_prefix: 'nt_dev_mock',
              permissions: { allowMt5: true, allowIqOption: true },
              status: 'ACTIVE',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ])
        );
        return;
      }
      if (url.includes('user_settings')) {
        res.end(JSON.stringify(req.method === 'GET' ? [{ user_id: userId, auto_paper_armed: false }] : {}));
        return;
      }
      res.end(JSON.stringify(req.method === 'GET' ? [] : {}));
    });
  });
  await new Promise<void>((resolve) => sbMockServer.listen(0, '127.0.0.1', () => resolve()));
  const sbPort = (sbMockServer.address() as { port: number }).port;

  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_ANON_KEY = 'mock-anon-key-test-value';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key-test-value';
  process.env.ANDROID_BRIDGE_SECRET = 'a'.repeat(32);
  process.env.BROKER_VAULT_SECRET = 'b'.repeat(32);

  try {
  // ----------------------------------------------------------------------------------
  // TEST 1: Task 4 — CORS Origin Handler & Production Health Routing
  // ----------------------------------------------------------------------------------
  console.log('--- Test 1: Task 4 — CORS Origin Protection & Health Endpoint ---');
  process.env.WEB_ORIGIN = 'https://novatrade.app';
  process.env.APP_URL = 'https://app.novatrade.io';

  const prodOrigins = resolveAllowedCorsOrigins(true);
  assert.ok(prodOrigins.includes('https://novatrade.app'));
  assert.ok(prodOrigins.includes('https://app.novatrade.io'));
  assert.ok(!prodOrigins.includes('http://localhost:3000'), 'Production CORS must exclude localhost');

  const handler = createCorsOriginHandler(true);
  // Allowed origin
  let allowed = false;
  handler('https://novatrade.app', (err, allow) => {
    assert.equal(err, null);
    allowed = Boolean(allow);
  });
  assert.ok(allowed, 'https://novatrade.app must be allowed');

  // Evil origin
  let evilAllowed = true;
  handler('https://evil-phishing.com', (err, allow) => {
    assert.equal(err, null);
    evilAllowed = Boolean(allow);
  });
  assert.equal(evilAllowed, false, 'Untrusted origin must be rejected by CORS handler');

  // No origin (native/curl)
  let noOriginAllowed = false;
  handler(undefined, (err, allow) => {
    assert.equal(err, null);
    noOriginAllowed = Boolean(allow);
  });
  assert.ok(noOriginAllowed, 'Requests without origin must be allowed');

  // Production check: Missing dist/index.html must throw descriptive error
  let caughtMissingDist = false;
  try {
    await createFullStackApp({
      isProduction: true,
      distDir: '/tmp/nonexistent-dist-dir-12345',
      routerOptions: { requireAuth: false },
    });
  } catch (err) {
    caughtMissingDist = true;
    assert.ok(
      err instanceof Error && err.message.includes('Production build assets missing'),
      `Expected 'Production build assets missing', got: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  assert.ok(caughtMissingDist, 'Missing dist/index.html must throw error on production startup');

  // Server health route verification
  const fullApp = await createFullStackApp({
    isProduction: false,
    routerOptions: { requireAuth: false, autoRestore: false, enableScheduler: false },
  });
  const srv = await new Promise<ReturnType<typeof fullApp.app.listen>>((resolve) => {
    const s = fullApp.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

  try {
    const healthRes = await fetch(`${base}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.status, 'ok');
    assert.ok(healthJson.executionCapabilities, 'GET /health must include executionCapabilities');
    assert.equal(healthJson.executionCapabilities.iqOptionOrderExecutionSupported, false);
    assert.equal(healthJson.executionCapabilities.mt5RealOrderPlacement, true);
    console.log('PASS: Task 4 CORS protections and /health JSON response verified.');
  } finally {
    srv.close();
    fullApp.stopScheduler();
  }

  // ----------------------------------------------------------------------------------
  // TEST 2: Task 1 — Android Action Queue Status, Verification Source & Broker Session Checks
  // ----------------------------------------------------------------------------------
  console.log('\n--- Test 2: Task 1 — Android Action Queue & Account Verification Guard ---');
  const companionMgr = new AndroidCompanionManager();
  const testScreenAnalysis = {
    id: crypto.randomUUID(),
    userId,
    deviceId: null,
    appPackage: 'net.metaquotes.metatrader5',
    appName: 'MT5' as const,
    detectedSymbol: 'EURUSD',
    normalizedSymbol: 'EURUSD',
    detectedTimeframe: '5m',
    detectedPrice: 1.085,
    detectedAccountMode: 'DEMO' as const,
    detectedBalance: 10000,
    detectedCurrency: 'USD',
    chartTrend: 'UPTREND' as const,
    visionSummary: 'Bullish breakout',
    riskWarning: null,
    recommendedAction: 'CALL' as const,
    confidenceScore: 85,
    signalId: null,
    quantDirection: 'CALL' as const,
    quantScore: 85,
    quantProvider: 'quant',
    alignmentStatus: 'ALIGNED' as const,
    candlestickObservations: [],
    tradeButtonsVisible: true,
    detectedActionLabels: ['BUY'],
    createdAt: new Date().toISOString(),
  };

  // 1. Unverified broker session -> BLOCKED_UNVERIFIED_ACCOUNT status
  const unverifiedAction = await companionMgr.queueActionFromScreen({
    userId,
    deviceId: null,
    analysis: testScreenAnalysis,
    operatingMode: 'assisted',
    stakeOrVolume: 25,
    expirySeconds: 180,
    riskStatus: { allowed: true, reasons: [] },
    verifiedBrokerSession: {
      verified: false,
      mode: 'UNKNOWN',
      source: 'UNVERIFIED',
      brokerAccountId: null,
      reason: 'No connected MT5 session',
    },
  });
  assert.ok(unverifiedAction);
  assert.equal(unverifiedAction.status, 'BLOCKED_UNVERIFIED_ACCOUNT');
  assert.equal(unverifiedAction.accountModeVerificationSource, 'UNVERIFIED');
  assert.equal(unverifiedAction.verifiedBrokerAccountId, null);

  // Attempting to approve an action with UNVERIFIED broker session must fail closed
  const approveUnverified = await companionMgr.approveAction(
    userId,
    unverifiedAction.id,
    { allowed: true, reasons: [] },
    { verified: false, mode: 'UNKNOWN', source: 'UNVERIFIED', brokerAccountId: null }
  );
  assert.equal(approveUnverified.ok, false);
  assert.equal(approveUnverified.statusCode, 404); // status is already BLOCKED_UNVERIFIED_ACCOUNT, not pending

  // 2. Queue with verified DEMO broker session
  const verifiedDemoAction = await companionMgr.queueActionFromScreen({
    userId,
    deviceId: null,
    analysis: testScreenAnalysis,
    operatingMode: 'assisted',
    stakeOrVolume: 25,
    expirySeconds: 180,
    riskStatus: { allowed: true, reasons: [] },
    verifiedBrokerSession: {
      verified: true,
      mode: 'DEMO',
      source: 'MT5_BRIDGE',
      brokerAccountId: 'acct-mt5-demo-1',
    },
  });
  assert.ok(verifiedDemoAction);
  assert.equal(verifiedDemoAction.status, 'PENDING_USER_APPROVAL');
  assert.equal(verifiedDemoAction.accountModeVerificationSource, 'MT5_BRIDGE');
  assert.equal(verifiedDemoAction.verifiedBrokerAccountId, 'acct-mt5-demo-1');

  // Approving with verified DEMO session succeeds
  const approveDemo = await companionMgr.approveAction(
    userId,
    verifiedDemoAction.id,
    { allowed: true, reasons: [] },
    { verified: true, mode: 'DEMO', source: 'MT5_BRIDGE', brokerAccountId: 'acct-mt5-demo-1' }
  );
  assert.equal(approveDemo.ok, true);
  assert.equal(approveDemo.action?.status, 'AUTHORIZED');

  // 3. Queue with REAL broker session -> BLOCKED_RISK (Real-money Android screen execution is locked)
  const realAction = await companionMgr.queueActionFromScreen({
    userId,
    deviceId: null,
    analysis: { ...testScreenAnalysis, detectedAccountMode: 'REAL' },
    operatingMode: 'assisted',
    stakeOrVolume: 50,
    expirySeconds: 180,
    riskStatus: { allowed: true, reasons: [] },
    verifiedBrokerSession: {
      verified: true,
      mode: 'REAL',
      source: 'MT5_BRIDGE',
      brokerAccountId: 'acct-mt5-real-1',
    },
  });
  assert.ok(realAction);
  assert.equal(realAction.status, 'BLOCKED_RISK');
  assert.ok(realAction.reason.includes('Real-money Android screen execution is locked'));

  console.log('PASS: Task 1 Android Action Queue status & verified broker session enforcement verified.');

  // ----------------------------------------------------------------------------------
  // TEST 3: Task 2 — Android Workspace Hydration & Emergency Stop Restoration
  // ----------------------------------------------------------------------------------
  console.log('\n--- Test 3: Task 2 — Android Device Endpoint Workspace Hydration ---');
  const testDataDir = path.resolve(process.cwd(), '.novatrade-data-remediation-test');
  fs.mkdirSync(testDataDir, { recursive: true });
  const appInst = createStandaloneApp({
    persistPath: path.join(testDataDir, 'state.json'),
    requireAuth: true,
    enableScheduler: false,
    autoRestore: false,
    verifyToken,
  });

  const appSrv = await new Promise<ReturnType<typeof appInst.app.listen>>((resolve) => {
    const s = appInst.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const appBase = `http://127.0.0.1:${(appSrv.address() as { port: number }).port}/api`;

  try {
    // Pair an Android device
    const pairRes = await fetch(`${appBase}/android/devices/pair`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ deviceName: 'Remediation QA Phone' }),
    });
    assert.equal(pairRes.status, 201);
    const pairing = (await pairRes.json()) as { pairingCode: string };

    const regRes = await fetch(`${appBase}/android/devices/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: pairing.pairingCode, deviceName: 'Remediation QA Phone' }),
    });
    assert.equal(regRes.status, 201);
    const registered = (await regRes.json()) as { deviceToken: string };
    const devTokenHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${registered.deviceToken}`,
    };

    // Trigger emergency stop via device
    const emRes = await fetch(`${appBase}/android/device/emergency-stop`, {
      method: 'POST',
      headers: devTokenHeaders,
      body: JSON.stringify({ engaged: true }),
    });
    assert.equal(emRes.status, 200);
    const emJson = (await emRes.json()) as { emergencyStop: boolean };
    assert.equal(emJson.emergencyStop, true);

    // Heartbeat returns emergencyStop true & active operatingMode
    const hbRes = await fetch(`${appBase}/android/device/heartbeat`, {
      method: 'POST',
      headers: devTokenHeaders,
      body: JSON.stringify({ appPackage: 'net.metaquotes.metatrader5' }),
    });
    assert.equal(hbRes.status, 200);
    const hbJson = (await hbRes.json()) as { emergencyStop: boolean; operatingMode: string };
    assert.equal(hbJson.emergencyStop, true);

    // Poll while emergencyStop is active blocks all pending actions
    const pollRes = await fetch(`${appBase}/android/device/poll`, {
      headers: devTokenHeaders,
    });
    assert.equal(pollRes.status, 200);
    const pollJson = (await pollRes.json()) as { actions: unknown[]; emergencyStop: boolean };
    assert.equal(pollJson.emergencyStop, true);
    assert.equal(pollJson.actions.length, 0);

    console.log('PASS: Task 2 Android Device endpoints hydrate workspace & respect Emergency Stop.');
  } finally {
    appSrv.close();
    appInst.stopScheduler();
    try {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // cleanup
    }
  }

  // ----------------------------------------------------------------------------------
  // TEST 4: Task 5 — Supabase Diagnostics (Migrations 001–009)
  // ----------------------------------------------------------------------------------
  console.log('\n--- Test 4: Task 5 — Supabase Diagnostics & Migration Checks ---');
  const diagnostics = await runSupabaseDiagnostics();
  assert.ok(diagnostics.migrationsSummary, 'Diagnostics must include migrationsSummary');
  assert.equal(Object.keys(diagnostics.migrationsSummary).length, 9, 'Expected 9 migrations (001-009)');
  assert.ok('008' in diagnostics.migrationsSummary);
  assert.ok('009' in diagnostics.migrationsSummary);
  assert.ok(Array.isArray(diagnostics.missingTables));
  assert.ok(Array.isArray(diagnostics.missingColumns));
  assert.ok(Array.isArray(diagnostics.missingFunctions));
  assert.ok(diagnostics.rlsPolicies && typeof diagnostics.rlsPolicies === 'object');
  console.log(`PASS: Task 5 Supabase diagnostics checked ${Object.keys(diagnostics.migrationsSummary).length} migrations.`);

  // ----------------------------------------------------------------------------------
  // TEST 5: Task 6 — Runtime Recovery Persistence of Shadows, Strategy States, and Proposals
  // ----------------------------------------------------------------------------------
  console.log('\n--- Test 5: Task 6 — Runtime Recovery Persistence & Restoration ---');
  const engine1 = new NovaTradeEngine(null, 'user-recovery-test');
  engine1.riskSettings.maxConsecutiveLosses = 2;

  // Record a pending shadow signal
  engine1.recordShadowSignalForTesting({
    symbol: 'EURUSD',
    timeframe: '5m',
    direction: 'CALL',
    strategy: 'TREND_CONTINUATION',
    entryPrice: 1.085,
    expiresAtMs: Date.now() + 60000,
  });
  assert.equal(engine1.getPendingShadowSignalsCount(), 1);

  // Ingest 3 consecutive losses to trigger strategy protection pause
  const now = Date.now();
  engine1.ingestBrokerOutcomes([
    {
      id: 'test-loss-1',
      symbol: 'EURUSD',
      timeframe: '5m',
      direction: 'CALL',
      amount: 25,
      payoutRate: 0.8,
      entryPrice: 1.085,
      exitPrice: 1.084,
      status: 'CLOSED_LOSS',
      pnl: -25,
      signalScore: 80,
      settledBy: 'manual',
      createdAt: new Date(now - 3000).toISOString(),
      closedAt: new Date(now - 3000).toISOString(),
      accountBucket: 'MT5_DEMO',
      strategyName: 'TREND_CONTINUATION',
    },
    {
      id: 'test-loss-2',
      symbol: 'EURUSD',
      timeframe: '5m',
      direction: 'CALL',
      amount: 25,
      payoutRate: 0.8,
      entryPrice: 1.085,
      exitPrice: 1.084,
      status: 'CLOSED_LOSS',
      pnl: -25,
      signalScore: 80,
      settledBy: 'manual',
      createdAt: new Date(now - 2000).toISOString(),
      closedAt: new Date(now - 2000).toISOString(),
      accountBucket: 'MT5_DEMO',
      strategyName: 'TREND_CONTINUATION',
    },
    {
      id: 'test-loss-3',
      symbol: 'EURUSD',
      timeframe: '5m',
      direction: 'CALL',
      amount: 25,
      payoutRate: 0.8,
      entryPrice: 1.085,
      exitPrice: 1.084,
      status: 'CLOSED_LOSS',
      pnl: -25,
      signalScore: 80,
      settledBy: 'manual',
      createdAt: new Date(now - 1000).toISOString(),
      closedAt: new Date(now - 1000).toISOString(),
      accountBucket: 'MT5_DEMO',
      strategyName: 'TREND_CONTINUATION',
    },
  ]);
  assert.ok(engine1.learner.isStrategyPaused('TREND_CONTINUATION'));

  // Create an assisted proposal
  engine1.createAssistedProposal({
    id: 'sig-test-prop',
    symbol: 'BTCUSD',
    timeframe: '5m',
    direction: 'CALL',
    score: 82,
    confidenceScore: 82,
    rawDirectionalConfidence: 82,
    actionableConfidence: 82,
    confidenceState: 'STRONG_SETUP_ACTIONABLE',
    zeroConfidenceReason: null,
    bullishScore: 82,
    bearishScore: 0,
    entryPrice: 62000,
    suggestedExpirySeconds: 180,
    provider: 'quant',
    marketStatus: 'LIVE',
    isStale: false,
    timestamp: new Date().toISOString(),
    indicators: null,
    supportingIndicators: null,
    riskAssessment: { level: 'LOW', volatilityRegime: 'LOW', atrPct: 0.5, suggestedStakePct: 1, summary: '' },
    mtf: null,
    backtest: { sampleSize: 10, wins: 8, losses: 2, winRatePct: 80, expectancyPerUnit: 0.6, horizonBars: 3, note: '' },
    reasons: ['Breakout'],
    warning: null,
    aiExplanation: null,
    activeStrategy: 'TREND_CONTINUATION',
  });
  assert.equal(engine1.assistedProposals.length, 1);

  // Export recovery payload
  const recoveryPayload = engine1.exportRuntimeRecoveryPayload();
  assert.equal(recoveryPayload.pendingShadowSignals.length, 1);
  assert.equal(recoveryPayload.assistedProposals.length, 1);
  assert.ok(recoveryPayload.learnerState);
  assert.ok(recoveryPayload.learnerState.strategyStates.TREND_CONTINUATION?.paused);

  // Restore into a fresh engine instance simulating restart
  const engine2 = new NovaTradeEngine(null, 'user-recovery-test');
  assert.equal(engine2.getPendingShadowSignalsCount(), 0);
  assert.equal(engine2.assistedProposals.length, 0);

  engine2.restoreFromSupabaseWorkspace({
    settingsRow: {
      auto_paper_armed: false,
      runtime_recovery: recoveryPayload,
    },
    tradesRows: [],
    signalsRows: [],
  });

  // Verify restored state
  assert.equal(engine2.getPendingShadowSignalsCount(), 1, 'Pending shadow signals must be restored');
  assert.equal(engine2.assistedProposals.length, 1, 'Assisted proposals must be restored');
  assert.ok(
    engine2.learner.isStrategyPaused('TREND_CONTINUATION'),
    'Strategy pause watermark must be restored across restart'
  );
  assert.equal(engine2.autoPaperArmed, false, 'autoPaperArmed must remain false if previously false');
  console.log('PASS: Task 6 runtime recovery preserves shadow signals, learner state, and assisted proposals without auto-trading.');

  // ----------------------------------------------------------------------------------
  // TEST 6: Task 7 — Health Metadata Execution Capabilities Breakdown
  // ----------------------------------------------------------------------------------
  console.log('\n--- Test 6: Task 7 — Health Endpoint Execution Capabilities Breakdown ---');
  const reg = new BrokerRegistry();
  const connMgr = new BrokerConnectionManager(reg, null);
  const brokerHealth = connMgr.getBrokerHealthSummary('test-health-user');
  assert.equal(brokerHealth.activeTarget, 'PAPER_SIMULATOR');
  assert.equal(brokerHealth.autoBrokerRoutingEnabled, false);
  console.log('PASS: Task 7 broker health summary accurately identifies active target & execution mode.');

  console.log('\n=============================================================');
  console.log('ALL REMEDIATION REGRESSION TESTS PASSED (Tasks 1 through 7).');
  console.log('=============================================================');
  } finally {
    sbMockServer.close();
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nREMEDIATION REGRESSION TEST FAILED:', err);
    process.exit(1);
  });

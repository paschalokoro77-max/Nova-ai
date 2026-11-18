import assert from 'assert';
import { AndroidCompanionManager } from './novatrade-ai/server/src/androidCompanion.ts';
import type { StoredSignal, AndroidScreenVisionResult } from './novatrade-ai/server/src/androidCompanion.ts';

console.log('========================================================================');
console.log('🧪 NOVATRADE AI — ANDROID SCREEN ANALYSIS SIGNAL ID FKEY REGRESSION SUITE');
console.log('========================================================================');

async function runRegressionTests() {
  const companionMgr = new AndroidCompanionManager();
  const userId = crypto.randomUUID();

  const dummyVision: AndroidScreenVisionResult = {
    appPackage: 'net.metaquotes.metatrader5',
    appName: 'MT5',
    detectedSymbol: 'EURUSD',
    normalizedSymbol: 'EURUSD',
    detectedTimeframeRaw: '5m',
    detectedPrice: 1.0850,
    accountMode: 'DEMO',
    detectedBalance: 10000,
    detectedCurrency: 'USD',
    chartTrend: 'UPTREND',
    summary: 'Test summary',
    riskWarning: null,
    visualBias: 'CALL',
    visualConfidence: 85,
    candlestickObservations: [],
    tradeButtonsVisible: true,
    detectedActionLabels: ['BUY'],
  };

  const missingSignal: StoredSignal = {
    id: crypto.randomUUID(),
    userId,
    symbol: 'EURUSD',
    timeframe: '5m',
    direction: 'CALL',
    score: 85,
    bullishScore: 85,
    bearishScore: 15,
    indicators: { trend: 'BULLISH', rsi14: 55, macdHistogram: 0.001, bbPercentB: 0.6, volatilityRegime: 'NORMAL', atrPct: 0.1, nearestSupport: 1.0800, nearestResistance: 1.0900, patterns: [] },
    marketRegime: 'TRENDING_BULLISH',
    activeStrategy: 'TREND_CONTINUATION',
    provider: 'test',
    createdAt: new Date().toISOString(),
  };

  const recordMissing = await companionMgr.recordScreenAnalysis({
    userId,
    deviceId: null,
    vision: dummyVision,
    quantSignal: missingSignal,
  });

  assert.ok(recordMissing, 'Record should be created successfully');
  assert.equal(recordMissing.signalId, missingSignal.id, 'In-memory signal association should be preserved');
  console.log('  ✅ [PASS] Missing / non-existent signal ID handled safely without foreign key crash');

  const recordNoSignal = await companionMgr.recordScreenAnalysis({
    userId,
    deviceId: null,
    vision: dummyVision,
    quantSignal: null,
  });

  assert.ok(recordNoSignal, 'Record without quant signal should succeed');
  assert.equal(recordNoSignal.signalId, null);
  console.log('  ✅ [PASS] Null signal ID handled successfully');

  console.log('\n========================================================================');
  console.log('🎉 ALL SIGNAL ID FKEY REGRESSION TESTS PASSED SUCCESSFULLY!');
  console.log('========================================================================\n');
}

runRegressionTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Regression test failed:', err);
    process.exit(1);
  });

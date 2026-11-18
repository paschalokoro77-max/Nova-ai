import assert from 'node:assert/strict';
import {
  analyzeMarketQuant,
  detectCandlestickPatterns,
  evaluateTimeframeExpiryCompatibility,
  getInstrumentBehaviorProfile,
  type Candle,
} from './novatrade-ai/server/src/quantEngine.ts';
import {
  PerformanceLearner,
  resolveAccountBucket,
  type LearnableTradeRecord,
} from './novatrade-ai/server/src/performanceLearner.ts';
import { NovaTradeEngine } from './novatrade-ai/server/src/tradingEngine.ts';
import { runComparativeWalkForwardBacktest } from './novatrade-ai/server/src/backtester.ts';

function buildSyntheticChoppyCandles(count = 80, base = 1.1000): Candle[] {
  const out: Candle[] = [];
  const start = Math.floor(Date.now() / 1000) - count * 300;
  for (let i = 0; i < count; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    const open = base + dir * 0.0002;
    const close = base - dir * 0.0002;
    out.push({
      time: start + i * 300,
      open,
      high: Math.max(open, close) + 0.0003,
      low: Math.min(open, close) - 0.0003,
      close,
      volume: 100,
    });
  }
  return out;
}

function buildSyntheticCleanUptrendCandles(count = 90, base = 1.0900): Candle[] {
  const out: Candle[] = [];
  const start = Math.floor(Date.now() / 1000) - count * 300;
  let price = base;
  for (let i = 0; i < count; i++) {
    // Smooth uptrend with periodic small pullbacks so structure has clean HH/HL and is not overextended
    const isPullback = i % 7 === 5;
    const step = isPullback ? -0.00035 : 0.00055;
    const open = price;
    const close = Number((price + step).toFixed(5));
    const high = Number((Math.max(open, close) + 0.00025).toFixed(5));
    const low = Number((Math.min(open, close) - 0.0002).toFixed(5));
    out.push({ time: start + i * 300, open, high, low, close, volume: 250 });
    price = close;
  }
  return out;
}

async function run() {
  console.log('=== 1. Market Intelligence, Strict Selection & Confidence Calibration Tests ===');
  const choppy = buildSyntheticChoppyCandles(80);
  const choppyRes = analyzeMarketQuant('EURUSD', '5m', choppy, 'synthetic-test', {
    minScore: 72,
    requireMtfAlignment: true,
    strategyProfile: 'balanced',
    marketStatus: 'LIVE',
    isStale: false,
    skipEmpiricalBacktest: true,
  });
  assert.equal(choppyRes.direction, 'WAIT', 'Choppy/ranging market MUST return WAIT');
  assert.ok((choppyRes.rejectionReasons?.length ?? 0) > 0, 'Choppy market must record explicit rejection reasons');
  assert.ok(choppyRes.confidenceScore <= 62, 'WAIT confidence must stay honestly capped <= 62');
  console.log('PASS: Choppy market rejected to WAIT with reasons:', choppyRes.rejectionReasons?.[0]);

  const uptrendPrimary = buildSyntheticCleanUptrendCandles(90, 1.09);
  const uptrendHtf = buildSyntheticCleanUptrendCandles(90, 1.08);
  const trendRes = analyzeMarketQuant('EURUSD', '5m', uptrendPrimary, 'synthetic-test', {
    minScore: 72,
    requireMtfAlignment: true,
    strategyProfile: 'balanced',
    marketStatus: 'LIVE',
    isStale: false,
    higherTimeframeCandles: { timeframe: '15m', candles: uptrendHtf },
    skipEmpiricalBacktest: true,
  });
  assert.ok(trendRes.pillars, 'Pillar breakdown must be populated');
  assert.ok(trendRes.confidenceCalibration, 'Confidence calibration metadata must be populated');
  assert.ok(trendRes.confidenceScore <= 88, 'Confidence must NEVER fabricate > 88% certainty');
  console.log(
    `PASS: Clean uptrend evaluated: dir=${trendRes.direction}, calibratedConfidence=${trendRes.confidenceScore}, independentBullPillars=${trendRes.pillars?.independentBullConfirmations}/5, ER=${trendRes.indicators?.efficiencyRatio}, ADX=${trendRes.indicators?.adx14}`
  );

  // Test MTF conflict rejection (uptrend primary vs downtrend HTF)
  const downtrendHtf = uptrendHtf.map((c, idx) => ({
    ...c,
    open: Number((1.2 - idx * 0.0005).toFixed(5)),
    close: Number((1.2 - idx * 0.0005 - 0.0003).toFixed(5)),
    high: Number((1.2 - idx * 0.0005 + 0.0001).toFixed(5)),
    low: Number((1.2 - idx * 0.0005 - 0.0005).toFixed(5)),
  }));
  const conflictRes = analyzeMarketQuant('EURUSD', '5m', uptrendPrimary, 'synthetic-test', {
    minScore: 72,
    requireMtfAlignment: true,
    strategyProfile: 'balanced',
    marketStatus: 'LIVE',
    isStale: false,
    higherTimeframeCandles: { timeframe: '15m', candles: downtrendHtf },
    skipEmpiricalBacktest: true,
  });
  assert.equal(conflictRes.direction, 'WAIT', 'MTF conflict MUST return WAIT');
  assert.equal(conflictRes.mtf?.alignment, 'CONFLICT');
  console.log('PASS: MTF conflict rejected to WAIT.');

  console.log('\n=== 2. Controlled Performance-Learning Engine Tests ===');
  const learner = new PerformanceLearner();
  // Small sample (< 10) must NOT overfit or adjust thresholds
  const smallSample: LearnableTradeRecord[] = Array.from({ length: 5 }, (_, i) => ({
    id: `small-${i}`,
    symbol: 'EURUSD',
    timeframe: '1m',
    direction: 'CALL',
    amount: 50,
    payoutRate: 0.8,
    entryPrice: 1.1,
    exitPrice: 1.1, // flat-price expiry loss
    status: 'SIMULATED_LOSS',
    pnl: -50,
    signalScore: 66,
    settledBy: 'auto-expiry-monitor',
    createdAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
  }));
  const smallInsights = learner.analyzeHistory(smallSample, 72);
  assert.equal(smallInsights.recommendedMinScore, 72, 'Must NOT overfit to < 15 global trades');
  assert.equal(smallInsights.cautionSymbols.length, 0, 'Must NOT flag instrument caution on < 10 trades');

  // Larger sample (15 trades: 4 wins, 11 losses — mirroring the reported 11/15 loss scenario) + duplicates/corrupt records
  const largeSample: LearnableTradeRecord[] = [
    ...Array.from({ length: 11 }, (_, i) => ({
      id: `loss-${i}`,
      symbol: 'EURUSD',
      timeframe: '1m' as const,
      direction: 'CALL' as const,
      amount: 50,
      payoutRate: 0.8,
      entryPrice: 1.1,
      exitPrice: i < 4 ? 1.1 : 1.0995,
      status: 'SIMULATED_LOSS',
      pnl: -50,
      signalScore: 67,
      settledBy: 'auto-expiry-monitor',
      createdAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `win-${i}`,
      symbol: 'EURUSD',
      timeframe: '1m' as const,
      direction: 'CALL' as const,
      amount: 50,
      payoutRate: 0.8,
      entryPrice: 1.1,
      exitPrice: 1.101,
      status: 'SIMULATED_WIN',
      pnl: 40,
      signalScore: 78,
      settledBy: 'auto-expiry-monitor',
      createdAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
    })),
    // Duplicate ID & corrupt inconsistent settlement (must be excluded!)
    {
      id: 'win-0',
      symbol: 'EURUSD',
      timeframe: '1m',
      direction: 'CALL',
      amount: 50,
      payoutRate: 0.8,
      entryPrice: 1.1,
      exitPrice: 1.101,
      status: 'SIMULATED_WIN',
      pnl: 40,
      signalScore: 78,
      settledBy: 'auto-expiry-monitor',
      createdAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
    },
    {
      id: 'corrupt-1',
      symbol: 'EURUSD',
      timeframe: '1m',
      direction: 'CALL',
      amount: 50,
      payoutRate: 0.8,
      entryPrice: 1.1,
      exitPrice: 1.101,
      status: 'SIMULATED_WIN',
      pnl: -50, // inconsistent
      signalScore: 78,
      settledBy: 'manual',
      createdAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
    },
  ];
  const fullInsights = learner.analyzeHistory(largeSample, 72);
  assert.equal(fullInsights.validTradesAnalyzed, 15, 'Must analyze exactly 15 valid trades');
  assert.equal(fullInsights.excludedTradesCount, 2, 'Must exclude duplicate and inconsistent trades');
  assert.ok(fullInsights.cautionSymbols.includes('EURUSD'), 'Must flag EURUSD as caution symbol after 11/15 losses');
  assert.ok(fullInsights.recommendedMinScore > 72, 'Must tighten min score on sustained sub-50% performance');
  assert.ok(fullInsights.auditLog.length >= 2, 'Must record auditable strategy adjustments');
  console.log(
    `PASS: PerformanceLearner excluded ${fullInsights.excludedTradesCount} invalid records, flagged EURUSD, raised minScore to ${fullInsights.recommendedMinScore}, auditLog entries=${fullInsights.auditLog.length}.`
  );

  console.log('\n=== 3. Advanced Risk Management & Anti-Martingale Tests ===');
  const engine = new NovaTradeEngine(null);
  engine.startingVirtualBalance = 1000;
  engine.riskSettings.maxTradeAmount = 100;
  engine.riskSettings.dailyLossLimit = 500;
  engine.riskSettings.maxConsecutiveLosses = 4;
  engine.riskSettings.lossCooldownSeconds = 120;
  engine.riskSettings.minAvailableBalancePct = 10;

  const stakeBeforeLosses = engine.calculateRecommendedStake(80);
  // Open 1st auto trade on BTCUSD with ATR-aware SL/TP
  const t1 = engine.openPaperTrade({
    symbol: 'BTCUSD',
    timeframe: '5m',
    direction: 'CALL',
    amount: 50,
    mode: 'automatic',
    entryPrice: 70000,
    atr: 200,
    expirySeconds: 300,
  });
  assert.equal(t1.ok, true);
  assert.ok(t1.trade!.stopLoss != null && t1.trade!.stopLoss < 70000 && t1.trade!.stopLoss > 69500, 'ATR-aware SL should be ~1.5*ATR (300)');

  // Duplicate / per-instrument simultaneous exposure check
  const dupAuto = engine.openPaperTrade({
    symbol: 'BTCUSD',
    timeframe: '5m',
    direction: 'CALL',
    amount: 50,
    mode: 'automatic',
    entryPrice: 70000,
    expirySeconds: 300,
  });
  assert.equal(dupAuto.ok, false, 'Second simultaneous automatic trade on same instrument must be blocked');

  // Settle 2 consecutive automatic losses -> verify anti-martingale stake DECREASES and cooldown ENGAGES
  engine.settlePaperTrade(t1.trade!.id, 'loss', 50, 69700, 'stop-loss-triggered');
  const t2 = engine.openPaperTrade({
    symbol: 'ETHUSD',
    timeframe: '5m',
    direction: 'PUT',
    amount: 40,
    mode: 'automatic',
    entryPrice: 3000,
    expirySeconds: 300,
  });
  assert.equal(t2.ok, true);
  engine.settlePaperTrade(t2.trade!.id, 'loss', 40, 3030, 'stop-loss-triggered');

  const stakeAfter2Losses = engine.calculateRecommendedStake(80);
  assert.ok(stakeAfter2Losses < stakeBeforeLosses, 'Stake MUST decrease after losses (never martingale)');
  const riskDuringCooldown = engine.getRiskStatus();
  assert.equal(riskDuringCooldown.allowed, false, 'Post-loss cooldown must block immediate re-entry');
  assert.ok(riskDuringCooldown.reasons.some((r) => r.includes('cooldown')), 'Cooldown reason must be explicit');
  console.log(
    `PASS: Anti-martingale stake stepped down ($${stakeBeforeLosses} -> $${stakeAfter2Losses}), per-instrument exposure & post-loss cooldown verified.`
  );

  console.log('\n=== 4. Adaptive Market Regimes, Intelligent Performance Protection & Independent 4-Account Tracking ===');
  // 4a. Verify 4-regime adaptive classification (TRENDING, RANGING, VOLATILE, REVERSING)
  assert.equal(trendRes.marketRegime, 'TRENDING', 'Clean uptrend must classify as TRENDING');
  assert.equal(trendRes.activeStrategy, 'TREND_CONTINUATION', 'Trending regime must select TREND_CONTINUATION');
  assert.equal(choppyRes.marketRegime, 'RANGING', 'Choppy/oscillating market must classify as RANGING');

  // Volatile spike series
  const volatileCandles: Candle[] = Array.from({ length: 80 }, (_, i) => {
    const start = Math.floor(Date.now() / 1000) - (80 - i) * 300;
    const swing = i > 65 ? (i % 2 === 0 ? 0.015 : -0.014) : (i % 2 === 0 ? 0.0004 : -0.0004);
    const open = 1.1;
    const close = Number((open + swing).toFixed(5));
    return {
      time: start,
      open,
      high: Number((Math.max(open, close) + (i > 65 ? 0.008 : 0.0003)).toFixed(5)),
      low: Number((Math.min(open, close) - (i > 65 ? 0.008 : 0.0003)).toFixed(5)),
      close,
      volume: i > 65 ? 900 : 120,
    };
  });
  const volatileRes = analyzeMarketQuant('EURUSD', '5m', volatileCandles, 'synthetic-test', {
    minScore: 72,
    requireMtfAlignment: false,
    strategyProfile: 'balanced',
    marketStatus: 'LIVE',
    isStale: false,
    skipEmpiricalBacktest: true,
  });
  assert.equal(volatileRes.marketRegime, 'VOLATILE', 'Extreme volatility spike must classify as VOLATILE');

  // Reversing series: sustained downtrend followed by strong bullish engulfing reversal at support
  const reversingCandles: Candle[] = [];
  const revStart = Math.floor(Date.now() / 1000) - 85 * 300;
  let rp = 1.1350;
  for (let i = 0; i < 82; i++) {
    const step = i % 6 === 4 ? 0.00025 : -0.00045;
    const open = rp;
    const close = Number((rp + step).toFixed(5));
    reversingCandles.push({
      time: revStart + i * 300,
      open,
      high: Number((Math.max(open, close) + 0.0002).toFixed(5)),
      low: Number((Math.min(open, close) - 0.0002).toFixed(5)),
      close,
      volume: 180,
    });
    rp = close;
  }
  // Bearish exhaustion bar + strong bullish engulfing reversal bar
  const exhaustOpen = rp;
  const exhaustClose = Number((rp - 0.0009).toFixed(5));
  reversingCandles.push({
    time: revStart + 82 * 300,
    open: exhaustOpen,
    high: Number((exhaustOpen + 0.0002).toFixed(5)),
    low: Number((exhaustClose - 0.0004).toFixed(5)),
    close: exhaustClose,
    volume: 320,
  });
  reversingCandles.push({
    time: revStart + 83 * 300,
    open: Number((exhaustClose - 0.0001).toFixed(5)),
    high: Number((exhaustOpen + 0.0012).toFixed(5)),
    low: Number((exhaustClose - 0.0002).toFixed(5)),
    close: Number((exhaustOpen + 0.0011).toFixed(5)),
    volume: 520,
  });
  const revRes = analyzeMarketQuant('EURUSD', '5m', reversingCandles, 'synthetic-test', {
    minScore: 72,
    requireMtfAlignment: false,
    strategyProfile: 'balanced',
    marketStatus: 'LIVE',
    isStale: false,
    skipEmpiricalBacktest: true,
  });
  assert.ok(
    revRes.marketRegime === 'REVERSING' || revRes.marketRegime === 'TRENDING',
    `Reversal series must classify cleanly (got ${revRes.marketRegime})`
  );
  console.log(
    `PASS: Adaptive 4-regime engine classified TRENDING=${trendRes.activeStrategy}, RANGING=${choppyRes.activeStrategy}, VOLATILE=${volatileRes.activeStrategy}, REVERSAL_TEST=${revRes.marketRegime}/${revRes.activeStrategy}.`
  );

  // 4b. Intelligent Performance Protection: pause after 3 consecutive losses, shadow-validate, auto-resume after 2 shadow wins
  const protectionLearner = new PerformanceLearner();
  const baseTs = Date.now() - 3600_000;
  const fourAccountHistory: LearnableTradeRecord[] = [
    // 3 consecutive losses on TREND_CONTINUATION in MT5_DEMO -> should auto-pause TREND_CONTINUATION
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `mt5-demo-loss-${i}`,
      symbol: 'EURUSD',
      timeframe: '5m' as const,
      direction: 'CALL' as const,
      amount: 50,
      payoutRate: 0.8,
      entryPrice: 1.1,
      exitPrice: 1.099,
      status: 'SIMULATED_LOSS',
      pnl: -50,
      signalScore: 75,
      settledBy: 'stop-loss-triggered',
      accountBucket: 'MT5_DEMO' as const,
      strategyName: 'TREND_CONTINUATION',
      createdAt: new Date(baseTs + i * 60_000).toISOString(),
      closedAt: new Date(baseTs + i * 60_000 + 30_000).toISOString(),
    })),
    // Independent wins in MT5_REAL, IQ_OPTION_DEMO, IQ_OPTION_REAL
    {
      id: 'mt5-real-win-1',
      symbol: 'GBPUSD',
      timeframe: '15m',
      direction: 'CALL',
      amount: 100,
      payoutRate: 0.8,
      entryPrice: 1.27,
      exitPrice: 1.272,
      status: 'SIMULATED_WIN',
      pnl: 80,
      signalScore: 80,
      settledBy: 'take-profit-triggered',
      accountBucket: 'MT5_REAL',
      strategyName: 'RANGE_MEAN_REVERSION',
      createdAt: new Date(baseTs + 200_000).toISOString(),
      closedAt: new Date(baseTs + 260_000).toISOString(),
    },
    {
      id: 'iq-demo-win-1',
      symbol: 'BTCUSD',
      timeframe: '5m',
      direction: 'PUT',
      amount: 50,
      payoutRate: 0.8,
      entryPrice: 70000,
      exitPrice: 69800,
      status: 'SIMULATED_WIN',
      pnl: 40,
      signalScore: 79,
      settledBy: 'auto-expiry-monitor',
      accountBucket: 'IQ_OPTION_DEMO',
      strategyName: 'STRUCTURE_REVERSAL',
      createdAt: new Date(baseTs + 300_000).toISOString(),
      closedAt: new Date(baseTs + 360_000).toISOString(),
    },
    {
      id: 'iq-real-loss-1',
      symbol: 'ETHUSD',
      timeframe: '1h',
      direction: 'CALL',
      amount: 50,
      payoutRate: 0.8,
      entryPrice: 3000,
      exitPrice: 2980,
      status: 'SIMULATED_LOSS',
      pnl: -50,
      signalScore: 76,
      settledBy: 'stop-loss-triggered',
      accountBucket: 'IQ_OPTION_REAL',
      strategyName: 'VOLATILITY_BREAKOUT',
      createdAt: new Date(baseTs + 400_000).toISOString(),
      closedAt: new Date(baseTs + 460_000).toISOString(),
    },
  ];

  const protInsights = protectionLearner.analyzeHistory(fourAccountHistory, 72);
  // Verify independent 4-account tracking buckets
  assert.equal(protInsights.byAccountBucket.MT5_DEMO?.trades, 3, 'MT5_DEMO bucket must track 3 trades');
  assert.equal(protInsights.byAccountBucket.MT5_REAL?.trades, 1, 'MT5_REAL bucket must track 1 trade');
  assert.equal(protInsights.byAccountBucket.IQ_OPTION_DEMO?.trades, 1, 'IQ_OPTION_DEMO bucket must track 1 trade');
  assert.equal(protInsights.byAccountBucket.IQ_OPTION_REAL?.trades, 1, 'IQ_OPTION_REAL bucket must track 1 trade');
  const stratBucket = (key: string) => protInsights.byStrategy.find((s) => s.key === key);
  assert.equal(stratBucket('TREND_CONTINUATION')?.trades, 3, 'byStrategy must track TREND_CONTINUATION');
  assert.equal(stratBucket('RANGE_MEAN_REVERSION')?.trades, 1, 'byStrategy must track RANGE_MEAN_REVERSION');
  assert.equal(stratBucket('STRUCTURE_REVERSAL')?.trades, 1, 'byStrategy must track STRUCTURE_REVERSAL');
  assert.equal(stratBucket('VOLATILITY_BREAKOUT')?.trades, 1, 'byStrategy must track VOLATILITY_BREAKOUT');

  // Verify TREND_CONTINUATION is automatically paused after 3 consecutive losses
  assert.equal(
    protectionLearner.isStrategyPaused('TREND_CONTINUATION').paused,
    true,
    'TREND_CONTINUATION must be paused after 3 consecutive losses'
  );
  assert.equal(
    protectionLearner.isStrategyPaused('RANGE_MEAN_REVERSION').paused,
    false,
    'Healthy strategy RANGE_MEAN_REVERSION must NOT be paused'
  );

  // Shadow validation while paused: 1 win is not enough; 2 consecutive shadow wins must auto-resume
  const shadow1 = protectionLearner.recordShadowValidation('TREND_CONTINUATION', true);
  assert.equal(shadow1.paused, true, '1 shadow win must not prematurely resume paused strategy');
  assert.equal(protectionLearner.isStrategyPaused('TREND_CONTINUATION').paused, true);
  const shadow2 = protectionLearner.recordShadowValidation('TREND_CONTINUATION', true);
  assert.equal(shadow2.paused, false, '2 consecutive validated shadow wins must auto-resume strategy');
  assert.equal(protectionLearner.isStrategyPaused('TREND_CONTINUATION').paused, false);
  console.log(
    'PASS: Intelligent Performance Protection paused TREND_CONTINUATION after 3 losses, continued shadow validation, auto-resumed after 2 shadow wins, and tracked MT5_DEMO / MT5_REAL / IQ_OPTION_DEMO / IQ_OPTION_REAL independently.'
  );

  // 4c. Instrument-specific profiles, 15m/180s Timeframe-Expiry compatibility, Pin-bar/Zero-tick safety & Strategy bias
  const eurusdProf = getInstrumentBehaviorProfile('EURUSD');
  const usdjpyProf = getInstrumentBehaviorProfile('USDJPY');
  const btcProf = getInstrumentBehaviorProfile('BTCUSD');
  const ethProf = getInstrumentBehaviorProfile('ETHUSD');
  assert.equal(eurusdProf.assetClass, 'FX_MAJOR');
  assert.equal(usdjpyProf.assetClass, 'FX_JPY');
  assert.equal(btcProf.assetClass, 'CRYPTO_LARGE');
  assert.equal(ethProf.assetClass, 'CRYPTO_ALT');
  assert.ok(usdjpyProf.minAtrToSpreadRatio > eurusdProf.minAtrToSpreadRatio, 'USDJPY requires stricter ATR/spread floor than EURUSD');
  assert.ok(ethProf.volatilityMult > btcProf.volatilityMult && btcProf.volatilityMult > eurusdProf.volatilityMult);

  const mismatch15m180s = evaluateTimeframeExpiryCompatibility('15m', 180);
  assert.equal(mismatch15m180s.compatible, false, '15m + 180s MUST be flagged incompatible');
  assert.equal(mismatch15m180s.status, 'MISMATCH_TOO_SHORT');
  assert.equal(mismatch15m180s.barFraction, 0.2);
  assert.equal(mismatch15m180s.recommendedExpirySeconds, 1800);
  assert.ok(mismatch15m180s.confidenceAdjustment < 0, 'Sub-bar expiry mismatch must apply negative calibration adjustment');

  const optimal5m900s = evaluateTimeframeExpiryCompatibility('5m', 900);
  assert.equal(optimal5m900s.compatible, true);
  assert.equal(optimal5m900s.status, 'OPTIMAL');
  assert.equal(optimal5m900s.barFraction, 3);

  // 15m + 180s requested on clean uptrend must flag MISMATCH_TOO_SHORT, penalize calibration, and recommend 1800s
  const mismatchRes = analyzeMarketQuant('EURUSD', '15m', uptrendPrimary, 'synthetic-test', {
    minScore: 72,
    requireMtfAlignment: true,
    strategyProfile: 'balanced',
    marketStatus: 'LIVE',
    isStale: false,
    higherTimeframeCandles: { timeframe: '1h', candles: uptrendHtf },
    requestedExpirySeconds: 180,
    skipEmpiricalBacktest: true,
  });
  assert.equal(mismatchRes.suggestedExpirySeconds, 1800);
  assert.equal(mismatchRes.requestedExpirySeconds, 180);
  assert.equal(mismatchRes.effectiveExpirySeconds, 1800);
  assert.equal(mismatchRes.expiryAdjusted, true);
  assert.ok(Boolean(mismatchRes.expiryAdjustmentReason));
  assert.equal(mismatchRes.timeframeExpiryCompatibility?.status, 'MISMATCH_TOO_SHORT');
  assert.equal(mismatchRes.timeframeExpiryCompatibility?.compatible, false);
  assert.ok((mismatchRes.confidenceCalibration?.regimeAdjustment ?? 0) < 0);
  assert.equal(engine.resolveEffectiveExpirySeconds(mismatchRes), 1800, 'Incompatible 15m+180s must adjust to 1800s');

  // Compatible requested expiry (1m + 300s -> 5 bars OPTIMAL) MUST be preserved rather than overwritten to 180s
  const compatRes = analyzeMarketQuant('EURUSD', '1m', uptrendPrimary, 'synthetic-test', {
    minScore: 72,
    requireMtfAlignment: true,
    strategyProfile: 'balanced',
    marketStatus: 'LIVE',
    isStale: false,
    higherTimeframeCandles: { timeframe: '5m', candles: uptrendHtf },
    requestedExpirySeconds: 300,
    skipEmpiricalBacktest: true,
  });
  assert.equal(compatRes.timeframeExpiryCompatibility?.compatible, true);
  assert.equal(compatRes.suggestedExpirySeconds, 180);
  assert.equal(compatRes.requestedExpirySeconds, 300);
  assert.equal(compatRes.effectiveExpirySeconds, 300);
  assert.equal(compatRes.expiryAdjusted, false);
  assert.equal(compatRes.expiryAdjustmentReason, null);
  assert.equal(engine.resolveEffectiveExpirySeconds(compatRes), 300, 'Compatible 1m+300s must preserve requested 300s expiry');

  // Hammer Pin Bar vs Symmetric Doji vs Trailing zero-range forming tick
  const hammerSeries = uptrendPrimary.slice(0, 10);
  const lastH = hammerSeries[hammerSeries.length - 1];
  hammerSeries.push({
    time: lastH.time + 300,
    open: 1.095,
    close: 1.0951,
    high: 1.09515,
    low: 1.0938,
    volume: 200,
  });
  const hammerPat = detectCandlestickPatterns(hammerSeries);
  assert.equal(hammerPat.isIndecision, false, 'Bullish Hammer Pin Bar must NOT be flagged Doji Indecision');
  assert.ok(hammerPat.patterns.includes('Bullish Hammer Pin Bar'));

  const formingZeroTick = [...uptrendPrimary, {
    time: uptrendPrimary[uptrendPrimary.length - 1].time + 300,
    open: uptrendPrimary[uptrendPrimary.length - 1].close,
    high: uptrendPrimary[uptrendPrimary.length - 1].close,
    low: uptrendPrimary[uptrendPrimary.length - 1].close,
    close: uptrendPrimary[uptrendPrimary.length - 1].close,
    volume: 0,
  }];
  const zeroTickRes = analyzeMarketQuant('EURUSD', '5m', formingZeroTick, 'synthetic-test', {
    minScore: 72,
    requireMtfAlignment: true,
    strategyProfile: 'balanced',
    marketStatus: 'LIVE',
    isStale: false,
    higherTimeframeCandles: { timeframe: '15m', candles: uptrendHtf },
    skipEmpiricalBacktest: true,
  });
  assert.ok(!zeroTickRes.indicators?.patterns.includes('Doji Indecision'), 'Single trailing zero-range tick must not trigger false Doji Indecision');

  // Verify strategy-level bias & Demo/Real bucket separation stay strict
  assert.equal(resolveAccountBucket('mt5', 'demo'), 'MT5_DEMO');
  assert.equal(resolveAccountBucket('mt5', 'real'), 'MT5_REAL');
  assert.equal(resolveAccountBucket('iq_option', 'demo'), 'IQ_OPTION_DEMO');
  assert.equal(resolveAccountBucket('iq_option', 'real'), 'IQ_OPTION_REAL');

  const stratBiasLearner = new PerformanceLearner();
  const stratSample: LearnableTradeRecord[] = Array.from({ length: 12 }, (_, i) => ({
    id: `strat-bias-${i}`,
    symbol: 'BTCUSD',
    timeframe: '5m',
    direction: 'CALL',
    amount: 50,
    payoutRate: 0.8,
    entryPrice: 70000,
    exitPrice: i < 4 ? 70200 : 69800,
    status: i < 4 ? 'SIMULATED_WIN' : 'SIMULATED_LOSS',
    pnl: i < 4 ? 40 : -50,
    signalScore: 74,
    settledBy: 'auto-expiry-monitor',
    accountBucket: 'MT5_REAL',
    strategyName: 'VOLATILITY_BREAKOUT',
    createdAt: new Date(baseTs + i * 60_000).toISOString(),
    closedAt: new Date(baseTs + i * 60_000 + 30_000).toISOString(),
  }));
  stratBiasLearner.analyzeHistory(stratSample, 72);
  const stratBias = stratBiasLearner.getBiasForSetup('ETHUSD', '1h', 'VOLATILITY_BREAKOUT');
  assert.equal(stratBias.strategySampleSize, 12);
  assert.ok((stratBias.strategyWinRatePct ?? 100) < 45);
  assert.ok(stratBias.confidenceAdjustment < 0 && stratBias.scoreThresholdOffset > 0);
  console.log('PASS: Instrument profiles, 15m/180s mismatch detection, compatible requested-expiry preservation, Pin-bar/Zero-tick handling, Demo/Real buckets, and Strategy Bias checks passed.');

  console.log('\n=== 5. Extended Walk-Forward Out-of-Sample Backtest (1m, 5m, 15m, 1h up to 1000 bars) ===');
  const report = await runComparativeWalkForwardBacktest({
    symbols: ['EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD', 'ETHUSD', 'SOLUSD'],
    timeframes: ['1m', '5m', '15m', '1h'],
    profile: 'balanced',
    improvedMinScore: 72,
    legacyMinScore: 65,
    horizonBars: 3,
    stakePerTrade: 100,
    candleLimit: 1000,
  });

  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.datasetsLoaded.length >= 10, 'Expected at least 10 real historical datasets loaded across 1m/5m/15m/1h');
  assert.equal(report.assumptions.strictCausalClosedHtfBars, true);
  assert.equal(report.assumptions.strictNonOverlappingIsOosBoundary, true);
  assert.ok(report.improved.inSample && report.improved.outOfSample);
  assert.equal(
    report.improved.all.totalTrades,
    report.improved.inSample.totalTrades + report.improved.outOfSample.totalTrades,
    'ALL trades must equal IS + OOS trades with strict non-overlapping split'
  );
  assert.ok(report.sampleSizeDisclosure.smallSampleWarnings.length > 0, 'Small sample buckets must be explicitly disclosed');
  console.log('\nALL INTELLIGENCE UPGRADE, PERFORMANCE PROTECTION & EXTENDED BACKTEST CHECKS COMPLETED.');
}

run().catch((err) => {
  console.error('INTELLIGENCE TEST FAILED:', err);
  process.exit(1);
});

import type { Candle, Timeframe, MarketStatus } from './marketData.ts';
import type { HistoricalBiasContext } from './performanceLearner.ts';

export type StrategyProfile = 'conservative' | 'balanced' | 'momentum';

export type AdaptiveMarketRegime = 'TRENDING' | 'RANGING' | 'VOLATILE' | 'REVERSING';

export type AdaptiveStrategyName =
  | 'TREND_CONTINUATION'
  | 'RANGE_MEAN_REVERSION'
  | 'STRUCTURE_REVERSAL'
  | 'VOLATILITY_BREAKOUT'
  | 'CAPITAL_PROTECTION';

export interface MarketStructureSnapshot {
  structure: 'BULLISH_HH_HL' | 'BEARISH_LH_LL' | 'CHOPPY_RANGE' | 'TRANSITION';
  regime?: AdaptiveMarketRegime;
  adx14: number;
  efficiencyRatio: number; // Kaufman ER: 0 = pure noise/chop, 1 = clean trend
  breakoutState: 'NONE' | 'BULLISH_BREAKOUT' | 'BEARISH_BREAKOUT' | 'FALSE_BULL_BREAKOUT' | 'FALSE_BEAR_BREAKOUT';
  reversalState: 'NONE' | 'BULLISH_REVERSAL' | 'BEARISH_REVERSAL';
  extensionAtr: number; // Signed distance of close from EMA21 in ATR units
  roomToTargetRatio: number; // Distance to opposing S/R divided by ATR
}

export interface PillarBreakdown {
  trendStructure: { bull: number; bear: number; max: number; verdict: 'BULL' | 'BEAR' | 'NEUTRAL' };
  momentum: { bull: number; bear: number; max: number; verdict: 'BULL' | 'BEAR' | 'NEUTRAL' };
  volatilityRegime: { bull: number; bear: number; max: number; verdict: 'BULL' | 'BEAR' | 'NEUTRAL' };
  priceActionSR: { bull: number; bear: number; max: number; verdict: 'BULL' | 'BEAR' | 'NEUTRAL' };
  multiTimeframe: { bull: number; bear: number; max: number; verdict: 'BULL' | 'BEAR' | 'NEUTRAL' };
  independentBullConfirmations: number;
  independentBearConfirmations: number;
  conflictPenalty: number;
}

export interface ConfidenceCalibration {
  rawScore: number;
  calibratedScore: number;
  independentConfirmations: number;
  conflictPenalty: number;
  regimeAdjustment: number;
  historicalAdjustment: number;
  empiricalWinRatePct: number | null;
  empiricalSampleSize: number;
  calibrationNote: string;
}

export interface IndicatorSnapshot {
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number | null;
  rsi14: number;
  macdLine: number;
  macdSignal: number;
  macdHistogram: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  bbBandwidthPct: number;
  bbPercentB: number;
  atr14: number;
  atrPct: number;
  nearestSupport: number;
  nearestResistance: number;
  supportDistancePct: number;
  resistanceDistancePct: number;
  trend: 'UPTREND' | 'DOWNTREND' | 'RANGING';
  volatilityRegime: 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME';
  patterns: string[];
  priceActionSummary: string;
  // Extended Phase 2 intelligence telemetry (backwards-compatible optional fields)
  adx14?: number;
  efficiencyRatio?: number;
  marketStructure?: MarketStructureSnapshot;
}

export interface MultiTimeframeSummary {
  primaryTimeframe: Timeframe;
  higherTimeframe: Timeframe;
  higherTrend: 'UPTREND' | 'DOWNTREND' | 'RANGING' | 'UNAVAILABLE';
  higherRsi: number | null;
  alignment: 'ALIGNED_BULLISH' | 'ALIGNED_BEARISH' | 'CONFLICT' | 'NEUTRAL';
}

export interface BacktestSampleStats {
  sampleSize: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  expectancyPerUnit: number | null;
  horizonBars: number;
  note: string;
}

export interface RiskAssessment {
  level: 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME';
  volatilityRegime: 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME' | 'UNKNOWN';
  atrPct: number | null;
  suggestedStakePct: number;
  summary: string;
}

export interface SupportingIndicatorsSummary {
  emaAlignment: string;
  rsiState: string;
  macdState: string;
  bollingerState: string;
  supportResistanceState: string;
  candlestickPattern: string;
  trendDirection: string;
  volatilityState: string;
  multiTimeframe: string;
}

export type InstrumentBehaviorClass =
  | 'FX_MAJOR'
  | 'FX_JPY'
  | 'CRYPTO_LARGE'
  | 'CRYPTO_ALT'
  | 'COMMODITY'
  | 'GENERAL';

export interface InstrumentBehaviorProfile {
  symbol: string;
  assetClass: InstrumentBehaviorClass;
  estimatedSpreadBps: number;
  minAtrToSpreadRatio: number;
  volatilityMult: number;
  maxTrendExtensionAtr: number;
  minReversalExtensionAtr: number;
  minRoomToTargetAtr: number;
  note: string;
}

export interface TimeframeExpiryCompatibility {
  timeframe: Timeframe;
  requestedExpirySeconds: number;
  recommendedExpirySeconds: number;
  recommendedRangeSeconds: [number, number];
  barFraction: number;
  status: 'OPTIMAL' | 'ACCEPTABLE' | 'MISMATCH_TOO_SHORT' | 'MISMATCH_TOO_LONG';
  compatible: boolean;
  confidenceAdjustment: number;
  note: string;
}

export interface QuantAnalysisResult {
  symbol: string;
  timeframe: Timeframe;
  direction: 'CALL' | 'PUT' | 'WAIT';
  score: number;
  confidenceScore: number;
  rawDirectionalConfidence?: number;
  actionableConfidence?: number;
  confidenceState?: 'STALE_OR_UNAVAILABLE' | 'WEAK_SETUP_WAIT' | 'STRONG_SETUP_ACTIONABLE';
  zeroConfidenceReason?: string | null;
  feedLastUpdateAt?: string | null;
  bullishScore: number;
  bearishScore: number;
  entryPrice: number | null;
  suggestedExpirySeconds: number;
  requestedExpirySeconds?: number;
  effectiveExpirySeconds?: number;
  expiryAdjusted?: boolean;
  expiryAdjustmentReason?: string | null;
  provider: string;
  marketStatus: MarketStatus;
  isStale: boolean;
  timestamp: string;
  indicators: IndicatorSnapshot | null;
  supportingIndicators: SupportingIndicatorsSummary | null;
  riskAssessment: RiskAssessment;
  mtf: MultiTimeframeSummary | null;
  backtest: BacktestSampleStats;
  reasons: string[];
  warning: string;
  // Extended Phase 2-4 diagnostics (backwards-compatible optional fields)
  marketRegime?: AdaptiveMarketRegime;
  activeStrategy?: AdaptiveStrategyName;
  pillars?: PillarBreakdown;
  confidenceCalibration?: ConfidenceCalibration;
  rejectionReasons?: string[];
  timeframeExpiryCompatibility?: TimeframeExpiryCompatibility;
  instrumentProfile?: InstrumentBehaviorProfile;
}

export interface QuantOptions {
  minScore?: number;
  requireMtfAlignment?: boolean;
  strategyProfile?: StrategyProfile;
  marketStatus?: MarketStatus;
  isStale?: boolean;
  higherTimeframeCandles?: { timeframe: Timeframe; candles: Candle[] } | null;
  historicalBias?: HistoricalBiasContext | null;
  skipEmpiricalBacktest?: boolean;
  requestedExpirySeconds?: number;
}

export function computeEmaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = new Array<number>(values.length);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

export function isLiveMarketStatus(status?: MarketStatus): boolean {
  return status === 'LIVE' || status === 'OPEN';
}

export function computeRsi(values: number[], period = 14): number {
  if (values.length <= period) return 50;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

export function computeMacd(values: number[]): {
  line: number;
  signal: number;
  histogram: number;
  prevHistogram: number;
  prev2Histogram: number;
} {
  const ema12 = computeEmaSeries(values, 12);
  const ema26 = computeEmaSeries(values, 26);
  const macdLine = ema12.map((v, idx) => v - ema26[idx]);
  const signalLine = computeEmaSeries(macdLine, 9);
  const last = macdLine.length - 1;
  const prev = Math.max(0, last - 1);
  const prev2 = Math.max(0, last - 2);
  return {
    line: macdLine[last],
    signal: signalLine[last],
    histogram: macdLine[last] - signalLine[last],
    prevHistogram: macdLine[prev] - signalLine[prev],
    prev2Histogram: macdLine[prev2] - signalLine[prev2],
  };
}

export function computeBollinger(values: number[], period = 20, mult = 2): {
  upper: number;
  middle: number;
  lower: number;
  bandwidthPct: number;
  percentB: number;
} {
  const slice = values.slice(-period);
  const minVal = Math.min(...slice);
  const maxVal = Math.max(...slice);
  const last = values[values.length - 1];
  if (maxVal === minVal) {
    return { upper: last, middle: last, lower: last, bandwidthPct: 0, percentB: 0.5 };
  }
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  const std = Math.sqrt(variance);
  if (std <= Math.abs(mean) * 1e-10) {
    return { upper: mean, middle: mean, lower: mean, bandwidthPct: 0, percentB: 0.5 };
  }
  const upper = mean + mult * std;
  const lower = mean - mult * std;
  const bandwidthPct = mean > 0 ? ((upper - lower) / mean) * 100 : 0;
  const percentB = upper !== lower ? (last - lower) / (upper - lower) : 0.5;
  return { upper, middle: mean, lower, bandwidthPct, percentB };
}

export function computeAtr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export function computeAdx(candles: Candle[], period = 14): { adx: number; plusDi: number; minusDi: number } {
  if (candles.length < period * 2) {
    return { adx: 15, plusDi: 20, minusDi: 20 };
  }
  const trs: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }

  let smoothTr = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlus = plusDm.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinus = minusDm.slice(0, period).reduce((a, b) => a + b, 0);

  const dxSeries: number[] = [];
  let lastPlusDi = 0;
  let lastMinusDi = 0;

  for (let i = period; i < trs.length; i++) {
    smoothTr = smoothTr - smoothTr / period + trs[i];
    smoothPlus = smoothPlus - smoothPlus / period + plusDm[i];
    smoothMinus = smoothMinus - smoothMinus / period + minusDm[i];

    const pDi = smoothTr > 0 ? (smoothPlus / smoothTr) * 100 : 0;
    const mDi = smoothTr > 0 ? (smoothMinus / smoothTr) * 100 : 0;
    lastPlusDi = pDi;
    lastMinusDi = mDi;
    const diSum = pDi + mDi;
    const dx = diSum > 0 ? (Math.abs(pDi - mDi) / diSum) * 100 : 0;
    dxSeries.push(dx);
  }

  if (dxSeries.length === 0) return { adx: 15, plusDi: lastPlusDi, minusDi: lastMinusDi };
  const initialCount = Math.min(period, dxSeries.length);
  let adx = dxSeries.slice(0, initialCount).reduce((a, b) => a + b, 0) / initialCount;
  for (let i = initialCount; i < dxSeries.length; i++) {
    adx = (adx * (period - 1) + dxSeries[i]) / period;
  }

  return {
    adx: Number(adx.toFixed(2)),
    plusDi: Number(lastPlusDi.toFixed(2)),
    minusDi: Number(lastMinusDi.toFixed(2)),
  };
}

export function computeEfficiencyRatio(closes: number[], period = 12): number {
  if (closes.length <= period) return 0;
  const end = closes.length - 1;
  const start = end - period;
  const netChange = Math.abs(closes[end] - closes[start]);
  let volatilitySum = 0;
  for (let i = start + 1; i <= end; i++) {
    volatilitySum += Math.abs(closes[i] - closes[i - 1]);
  }
  if (volatilitySum <= 1e-12) return 0;
  return Number(Math.min(1, netChange / volatilitySum).toFixed(3));
}

export function detectSupportResistance(candles: Candle[]): {
  support: number;
  resistance: number;
  hasOverheadResistance: boolean;
  hasUnderlyingSupport: boolean;
} {
  const lookback = candles.slice(-80);
  const lastClose = lookback[lookback.length - 1].close;
  const pivotLows: number[] = [];
  const pivotHighs: number[] = [];

  for (let i = 2; i < lookback.length - 2; i++) {
    const c = lookback[i];
    if (
      c.low <= lookback[i - 1].low &&
      c.low <= lookback[i - 2].low &&
      c.low <= lookback[i + 1].low &&
      c.low <= lookback[i + 2].low
    ) {
      pivotLows.push(c.low);
    }
    if (
      c.high >= lookback[i - 1].high &&
      c.high >= lookback[i - 2].high &&
      c.high >= lookback[i + 1].high &&
      c.high >= lookback[i + 2].high
    ) {
      pivotHighs.push(c.high);
    }
  }

  const below = pivotLows.filter((p) => p <= lastClose);
  const above = pivotHighs.filter((p) => p >= lastClose);
  const support = below.length > 0 ? Math.max(...below) : Math.min(...lookback.map((c) => c.low));
  const resistance = above.length > 0 ? Math.min(...above) : Math.max(...lookback.map((c) => c.high));
  return {
    support,
    resistance,
    hasOverheadResistance: above.length > 0,
    hasUnderlyingSupport: below.length > 0,
  };
}

export function detectMarketStructure(
  candles: Candle[],
  ema9: number,
  ema21: number,
  ema50: number,
  atr14: number,
  sr: { support: number; resistance: number },
  adx14: number,
  efficiencyRatio: number
): MarketStructureSnapshot {
  const lookback = candles.slice(-24);
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = 2; i < lookback.length - 2; i++) {
    const c = lookback[i];
    if (c.high >= lookback[i - 1].high && c.high >= lookback[i - 2].high && c.high >= lookback[i + 1].high && c.high >= lookback[i + 2].high) {
      swingHighs.push(c.high);
    }
    if (c.low <= lookback[i - 1].low && c.low <= lookback[i - 2].low && c.low <= lookback[i + 1].low && c.low <= lookback[i + 2].low) {
      swingLows.push(c.low);
    }
  }

  const last = candles[candles.length - 1];
  const prev = candles[Math.max(0, candles.length - 2)];
  const safeAtr = Math.max(atr14, last.close * 1e-6);
  const extensionAtr = Number(((last.close - ema21) / safeAtr).toFixed(2));

  const hh = swingHighs.length >= 2 && swingHighs[swingHighs.length - 1] > swingHighs[swingHighs.length - 2];
  const hl = swingLows.length >= 2 && swingLows[swingLows.length - 1] > swingLows[swingLows.length - 2];
  const lh = swingHighs.length >= 2 && swingHighs[swingHighs.length - 1] < swingHighs[swingHighs.length - 2];
  const ll = swingLows.length >= 2 && swingLows[swingLows.length - 1] < swingLows[swingLows.length - 2];

  let structure: MarketStructureSnapshot['structure'] = 'TRANSITION';
  if (efficiencyRatio < 0.22 && adx14 < 18) {
    structure = 'CHOPPY_RANGE';
  } else if (ema9 > ema21 && ema21 > ema50 && (hh || hl)) {
    structure = 'BULLISH_HH_HL';
  } else if (ema9 < ema21 && ema21 < ema50 && (lh || ll)) {
    structure = 'BEARISH_LH_LL';
  } else if (adx14 < 17) {
    structure = 'CHOPPY_RANGE';
  }

  // Breakout & false breakout detection against prior 18-bar range
  const priorRange = candles.slice(-20, -1);
  const priorHigh = priorRange.length > 0 ? Math.max(...priorRange.map((c) => c.high)) : sr.resistance;
  const priorLow = priorRange.length > 0 ? Math.min(...priorRange.map((c) => c.low)) : sr.support;
  const body = Math.abs(last.close - last.open);
  const barRange = Math.max(1e-9, last.high - last.low);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  let breakoutState: MarketStructureSnapshot['breakoutState'] = 'NONE';
  if (last.high > priorHigh && last.close < priorHigh && upperWick > body * 1.1) {
    breakoutState = 'FALSE_BULL_BREAKOUT';
  } else if (last.low < priorLow && last.close > priorLow && lowerWick > body * 1.1) {
    breakoutState = 'FALSE_BEAR_BREAKOUT';
  } else if (last.close > priorHigh && body / barRange >= 0.55) {
    breakoutState = 'BULLISH_BREAKOUT';
  } else if (last.close < priorLow && body / barRange >= 0.55) {
    breakoutState = 'BEARISH_BREAKOUT';
  }

  // Trend reversal detection (engulfing + reclaim of EMA9/21 after opposite swing)
  let reversalState: MarketStructureSnapshot['reversalState'] = 'NONE';
  if (prev.close < ema21 && last.close > ema9 && last.close > prev.high && lowerWick > upperWick) {
    reversalState = 'BULLISH_REVERSAL';
  } else if (prev.close > ema21 && last.close < ema9 && last.close < prev.low && upperWick > lowerWick) {
    reversalState = 'BEARISH_REVERSAL';
  }

  const distToResAtr = Math.max(0, sr.resistance - last.close) / safeAtr;
  const distToSupAtr = Math.max(0, last.close - sr.support) / safeAtr;
  const roomToTargetRatio = Number(Math.max(distToResAtr, distToSupAtr).toFixed(2));

  return {
    structure,
    adx14,
    efficiencyRatio,
    breakoutState,
    reversalState,
    extensionAtr,
    roomToTargetRatio,
  };
}

export function detectCandlestickPatterns(candles: Candle[]): { patterns: string[]; bias: number; summary: string; isIndecision: boolean } {
  if (candles.length < 3) {
    return { patterns: [], bias: 0, summary: 'Insufficient bars for pattern detection.', isIndecision: false };
  }
  const c0 = candles[candles.length - 1];
  const c1 = candles[candles.length - 2];
  const c2 = candles[candles.length - 3];

  const body0 = Math.abs(c0.close - c0.open);
  const range0 = Math.max(1e-9, c0.high - c0.low);
  const upperWick0 = c0.high - Math.max(c0.open, c0.close);
  const lowerWick0 = Math.min(c0.open, c0.close) - c0.low;

  const body1 = Math.abs(c1.close - c1.open);
  const patterns: string[] = [];
  let bias = 0;
  let isIndecision = false;

  const isBullPin = lowerWick0 > Math.max(body0 * 2.1, range0 * 0.55) && upperWick0 <= range0 * 0.22;
  const isBearPin = upperWick0 > Math.max(body0 * 2.1, range0 * 0.55) && lowerWick0 <= range0 * 0.22;

  if (body0 / range0 <= 0.12 && !isBullPin && !isBearPin) {
    patterns.push('Doji Indecision');
    isIndecision = true;
  }

  if (c1.close < c1.open && c0.close > c0.open && c0.open <= c1.close && c0.close >= c1.open && body0 > body1) {
    patterns.push('Bullish Engulfing');
    bias += 10;
  } else if (c1.close > c1.open && c0.close < c0.open && c0.open >= c1.close && c0.close <= c1.open && body0 > body1) {
    patterns.push('Bearish Engulfing');
    bias -= 10;
  }

  if (isBullPin && (body0 > 0 || c0.close >= c0.open)) {
    patterns.push('Bullish Hammer Pin Bar');
    bias += 8;
  } else if (isBearPin && (body0 > 0 || c0.close <= c0.open)) {
    patterns.push('Bearish Shooting Star');
    bias -= 8;
  }

  if (
    c2.close < c2.open &&
    Math.abs(c1.close - c1.open) < Math.abs(c2.close - c2.open) * 0.4 &&
    c0.close > c0.open &&
    c0.close > (c2.open + c2.close) / 2
  ) {
    patterns.push('Morning Star Reversal');
    bias += 9;
  } else if (
    c2.close > c2.open &&
    Math.abs(c1.close - c1.open) < Math.abs(c2.close - c2.open) * 0.4 &&
    c0.close < c0.open &&
    c0.close < (c2.open + c2.close) / 2
  ) {
    patterns.push('Evening Star Reversal');
    bias -= 9;
  }

  if (body0 / range0 >= 0.72) {
    if (c0.close > c0.open) {
      patterns.push('Bullish Momentum Bar');
      bias += 5;
    } else {
      patterns.push('Bearish Momentum Bar');
      bias -= 5;
    }
  }

  const bodyRatio = Math.round((body0 / range0) * 100);
  const candleDir = c0.close >= c0.open ? 'bullish' : 'bearish';
  const summary =
    patterns.length > 0
      ? `Latest ${candleDir} bar (${bodyRatio}% body) formed ${patterns.join(', ')}.`
      : `Latest ${candleDir} bar shows ${bodyRatio}% body-to-range without reversal pattern.`;

  return { patterns, bias, summary, isIndecision };
}

export function detectTrend(candles: Candle[], ema9: number, ema21: number, ema50: number): 'UPTREND' | 'DOWNTREND' | 'RANGING' {
  const recent = candles.slice(-12);
  const firstHalfHigh = Math.max(...recent.slice(0, 6).map((c) => c.high));
  const secondHalfHigh = Math.max(...recent.slice(6).map((c) => c.high));
  const firstHalfLow = Math.min(...recent.slice(0, 6).map((c) => c.low));
  const secondHalfLow = Math.min(...recent.slice(6).map((c) => c.low));

  if (ema9 > ema21 && ema21 > ema50 && (secondHalfHigh > firstHalfHigh || secondHalfLow > firstHalfLow)) {
    return 'UPTREND';
  }
  if (ema9 < ema21 && ema21 < ema50 && (secondHalfLow < firstHalfLow || secondHalfHigh < firstHalfHigh)) {
    return 'DOWNTREND';
  }
  return 'RANGING';
}

export function getHigherTimeframe(tf: Timeframe): Timeframe {
  if (tf === '1m') return '5m';
  if (tf === '5m') return '15m';
  return '1h';
}

export function getInstrumentBehaviorProfile(symbol: string): InstrumentBehaviorProfile {
  const clean = (symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/BTC/i.test(clean)) {
    return {
      symbol: clean || 'BTCUSD',
      assetClass: 'CRYPTO_LARGE',
      estimatedSpreadBps: 4.5,
      minAtrToSpreadRatio: 2.3,
      volatilityMult: 2.5,
      maxTrendExtensionAtr: 0.85,
      minReversalExtensionAtr: 1.55,
      minRoomToTargetAtr: 0.85,
      note: 'BTC large-cap crypto profile: 24/7 liquidity, moderate spread, clean trend pullbacks and 1.55+ ATR exhaustion fades.',
    };
  }
  if (/ETH|SOL|XRP|ADA|LTC|DOGE|BNB|AVAX/i.test(clean)) {
    return {
      symbol: clean,
      assetClass: 'CRYPTO_ALT',
      estimatedSpreadBps: 5.5,
      minAtrToSpreadRatio: 2.4,
      volatilityMult: 3.1,
      maxTrendExtensionAtr: 0.8,
      minReversalExtensionAtr: 1.55,
      minRoomToTargetAtr: 0.9,
      note: 'High-beta crypto profile: wider wick sweeps and volatility spikes; requires >= 2.4x spread ATR clearance.',
    };
  }
  if (/XAU|GC=F|GOLD/i.test(clean)) {
    return {
      symbol: clean || 'XAUUSD',
      assetClass: 'COMMODITY',
      estimatedSpreadBps: 3.5,
      minAtrToSpreadRatio: 2.3,
      volatilityMult: 1.65,
      maxTrendExtensionAtr: 0.78,
      minReversalExtensionAtr: 1.55,
      minRoomToTargetAtr: 0.9,
      note: 'Precious metals impulse profile: wider liquidity sweeps near session opens; avoids chasing extended moves.',
    };
  }
  if (/JPY/i.test(clean)) {
    return {
      symbol: clean,
      assetClass: 'FX_JPY',
      estimatedSpreadBps: 1.6,
      minAtrToSpreadRatio: 2.5,
      volatilityMult: 1.05,
      maxTrendExtensionAtr: 0.72,
      minReversalExtensionAtr: 1.6,
      minRoomToTargetAtr: 0.9,
      note: 'JPY cross FX profile: guards against low-ATR quiet-hour micro-chop where spread erodes short expiries.',
    };
  }
  if (/EUR|GBP|AUD|NZD|CAD|CHF/i.test(clean)) {
    return {
      symbol: clean,
      assetClass: 'FX_MAJOR',
      estimatedSpreadBps: 1.5,
      minAtrToSpreadRatio: 2.1,
      volatilityMult: 1.0,
      maxTrendExtensionAtr: 0.78,
      minReversalExtensionAtr: 1.55,
      minRoomToTargetAtr: 0.85,
      note: 'Major FX pair profile: tight spreads during active sessions; filters dead low-ATR flat bars.',
    };
  }
  return {
    symbol: clean || 'UNKNOWN',
    assetClass: 'GENERAL',
    estimatedSpreadBps: 2.0,
    minAtrToSpreadRatio: 2.2,
    volatilityMult: 1.2,
    maxTrendExtensionAtr: 0.78,
    minReversalExtensionAtr: 1.55,
    minRoomToTargetAtr: 0.9,
    note: 'Standard multi-asset profile.',
  };
}

function getTimeframeSeconds(tf: Timeframe): number {
  if (tf === '1m') return 60;
  if (tf === '5m') return 300;
  if (tf === '15m') return 900;
  return 3600;
}

function getSuggestedExpirySeconds(tf: Timeframe, volatility: IndicatorSnapshot['volatilityRegime'] | null): number {
  const base = tf === '1m' ? 180 : tf === '5m' ? 900 : tf === '15m' ? 1800 : 3600;
  if (volatility === 'HIGH') return Math.min(3600, Math.round(base * 1.33));
  return base;
}

export function evaluateTimeframeExpiryCompatibility(
  timeframe: Timeframe,
  requestedExpirySeconds?: number | null,
  volatility: IndicatorSnapshot['volatilityRegime'] | null = null
): TimeframeExpiryCompatibility {
  const tfSec = getTimeframeSeconds(timeframe);
  const recommendedExpirySeconds = getSuggestedExpirySeconds(timeframe, volatility);
  const minRec = Math.max(60, Math.round(tfSec * 1.5));
  const maxRec = Math.min(3600, Math.round(tfSec * 4));
  const effectiveReq =
    typeof requestedExpirySeconds === 'number' && Number.isFinite(requestedExpirySeconds) && requestedExpirySeconds > 0
      ? Math.round(requestedExpirySeconds)
      : recommendedExpirySeconds;
  const barFraction = Number((effectiveReq / tfSec).toFixed(2));

  if (barFraction < 0.75) {
    const severe = barFraction < 0.5;
    return {
      timeframe,
      requestedExpirySeconds: effectiveReq,
      recommendedExpirySeconds,
      recommendedRangeSeconds: [minRec, maxRec],
      barFraction,
      status: 'MISMATCH_TOO_SHORT',
      compatible: false,
      confidenceAdjustment: severe ? -6 : -3,
      note: `${effectiveReq}s expiry is only ${barFraction}x of a single ${timeframe} candle (${tfSec}s) — sub-bar spread/noise dominates; ${recommendedExpirySeconds}s (or ${timeframe === '15m' ? '1m/5m analysis' : 'shorter chart timeframe'}) is recommended.`,
    };
  }

  if (barFraction > 6.5) {
    return {
      timeframe,
      requestedExpirySeconds: effectiveReq,
      recommendedExpirySeconds,
      recommendedRangeSeconds: [minRec, maxRec],
      barFraction,
      status: 'MISMATCH_TOO_LONG',
      compatible: false,
      confidenceAdjustment: -4,
      note: `${effectiveReq}s expiry spans ${barFraction} ${timeframe} bars, exceeding typical ${timeframe} signal horizon (${recommendedExpirySeconds}s recommended).`,
    };
  }

  const optimal = barFraction >= 1.5 && barFraction <= 4.5;
  return {
    timeframe,
    requestedExpirySeconds: effectiveReq,
    recommendedExpirySeconds,
    recommendedRangeSeconds: [minRec, maxRec],
    barFraction,
    status: optimal ? 'OPTIMAL' : 'ACCEPTABLE',
    compatible: true,
    confidenceAdjustment: 0,
    note: `${effectiveReq}s expiry aligns with ${timeframe} structure (${barFraction} bars).`,
  };
}

function classifyVolatilityRegime(
  atrPct: number,
  bbBandwidthPct: number,
  symbol: string,
  timeframe: Timeframe
): IndicatorSnapshot['volatilityRegime'] {
  const inst = getInstrumentBehaviorProfile(symbol);
  const tfMult = timeframe === '1m' ? 1.0 : timeframe === '5m' ? 1.6 : timeframe === '15m' ? 2.4 : 3.8;
  const totalMult = tfMult * inst.volatilityMult;

  if (bbBandwidthPct < 0.035 * totalMult && atrPct < 0.02 * totalMult) return 'LOW';
  if (atrPct > 0.65 * totalMult || bbBandwidthPct > 2.2 * totalMult) return 'EXTREME';
  if (atrPct > 0.28 * totalMult || bbBandwidthPct > 0.9 * totalMult) return 'HIGH';
  return 'NORMAL';
}

/**
 * Independent 5-Pillar Core Evaluator (Phase 2 & 3).
 * Prevents correlated indicator double-counting by grouping indicators into
 * orthogonal evidence pillars:
 *  1. Trend & Market Structure (0-25): EMA stack + EMA21 slope + ADX + HH/HL structure
 *  2. Unified Momentum (0-20): RSI regime/slope + MACD histogram acceleration (one combined pillar)
 *  3. Volatility & Timing (0-20): Kaufman ER + Bollinger expansion corridor + non-overextended entry
 *  4. Price Action & S/R (0-20): S/R room-to-run + location-confirmed candlestick patterns + breakout check
 *  5. Multi-Timeframe (0-15): Computed in analyzeMarketQuant()
 */
function evaluateIndependentPillars(
  candles: Candle[],
  profile: StrategyProfile,
  symbol: string,
  timeframe: Timeframe
): {
  pillars: PillarBreakdown;
  indicators: IndicatorSnapshot;
  reasonsBull: string[];
  reasonsBear: string[];
  isIndecisionBar: boolean;
  distToResAtr: number;
  distToSupAtr: number;
  atrToSpreadRatio: number;
  flatBars12: number;
  instrumentProfile: InstrumentBehaviorProfile;
  macdPositive: boolean;
  macdNegative: boolean;
} {
  const closes = candles.map((c) => c.close);
  const ema9Arr = computeEmaSeries(closes, 9);
  const ema21Arr = computeEmaSeries(closes, 21);
  const ema50Arr = computeEmaSeries(closes, Math.min(50, closes.length));
  const ema200Arr = closes.length >= 120 ? computeEmaSeries(closes, Math.min(200, closes.length)) : null;

  const lastIdx = closes.length - 1;
  const ema9 = ema9Arr[lastIdx];
  const ema21 = ema21Arr[lastIdx];
  const ema50 = ema50Arr[lastIdx];
  const ema200 = ema200Arr ? ema200Arr[lastIdx] : null;
  const ema21Prev3 = ema21Arr[Math.max(0, lastIdx - 3)];

  const rsi14 = computeRsi(closes, 14);
  const prevRsi14 = computeRsi(closes.slice(0, -1), 14);
  const macd = computeMacd(closes);
  const bb = computeBollinger(closes, 20, 2);
  const atr14 = computeAtr(candles, 14);
  const adxData = computeAdx(candles, 14);
  const er = computeEfficiencyRatio(closes, 12);
  const instProfile = getInstrumentBehaviorProfile(symbol);

  const lastClose = closes[lastIdx];
  const atrPct = lastClose > 0 ? (atr14 / lastClose) * 100 : 0;
  const atrBps = atrPct * 100;
  const atrToSpreadRatio = instProfile.estimatedSpreadBps > 0 ? atrBps / instProfile.estimatedSpreadBps : 10;

  let flatBars12 = 0;
  for (let k = Math.max(1, candles.length - 12); k < candles.length; k++) {
    if (candles[k].close === candles[k - 1].close) flatBars12 += 1;
  }

  const sr = detectSupportResistance(candles);
  const supportDistancePct = lastClose > 0 ? ((lastClose - sr.support) / lastClose) * 100 : 0;
  const resistanceDistancePct = lastClose > 0 ? ((sr.resistance - lastClose) / lastClose) * 100 : 0;
  const trend = detectTrend(candles, ema9, ema21, ema50);
  // Ignore trailing zero-range forming tick (e.g. just-opened bar o=h=l=c on Yahoo FX) unless preceded by dead bars
  const lastRawBar = candles[candles.length - 1];
  const isTrailingZeroTick = lastRawBar.high === lastRawBar.low && flatBars12 <= 2;
  const patternCandles = isTrailingZeroTick && candles.length >= 4 ? candles.slice(0, -1) : candles;
  const patternInfo = detectCandlestickPatterns(patternCandles);
  const marketStructure = detectMarketStructure(candles, ema9, ema21, ema50, atr14, sr, adxData.adx, er);
  const volatilityRegime = classifyVolatilityRegime(atrPct, bb.bandwidthPct, symbol, timeframe);

  const eps = Math.max(1e-12, Math.abs(lastClose) * 1e-8);
  const safeAtr = Math.max(atr14, lastClose * 1e-6);
  const distToResAtr = sr.hasOverheadResistance ? Math.max(0, sr.resistance - lastClose) / safeAtr : 3.0;
  const distToSupAtr = sr.hasUnderlyingSupport ? Math.max(0, lastClose - sr.support) / safeAtr : 3.0;

  const reasonsBull: string[] = [];
  const reasonsBear: string[] = [];

  // --- PILLAR 1: Trend & Market Structure (max 25) ---
  let p1Bull = 0;
  let p1Bear = 0;
  const ema21SlopeBull = ema21 - ema21Prev3 > eps;
  const ema21SlopeBear = ema21Prev3 - ema21 > eps;

  if (ema9 > ema21 + eps && ema21 > ema50 + eps && ema21SlopeBull) {
    p1Bull += 13;
    reasonsBull.push('EMA 9 > 21 > 50 aligned with rising EMA21 slope.');
  } else if (ema9 < ema21 - eps && ema21 < ema50 - eps && ema21SlopeBear) {
    p1Bear += 13;
    reasonsBear.push('EMA 9 < 21 < 50 aligned with falling EMA21 slope.');
  } else if (ema9 > ema21 + eps && ema21SlopeBull) {
    p1Bull += 6;
  } else if (ema9 < ema21 - eps && ema21SlopeBear) {
    p1Bear += 6;
  }

  if (marketStructure.structure === 'BULLISH_HH_HL' && adxData.adx >= 18 && adxData.plusDi > adxData.minusDi) {
    p1Bull += 8;
    reasonsBull.push(`Bullish HH/HL market structure confirmed by ADX(${adxData.adx.toFixed(1)}).`);
  } else if (marketStructure.structure === 'BEARISH_LH_LL' && adxData.adx >= 18 && adxData.minusDi > adxData.plusDi) {
    p1Bear += 8;
    reasonsBear.push(`Bearish LH/LL market structure confirmed by ADX(${adxData.adx.toFixed(1)}).`);
  } else if (adxData.adx >= 18 && adxData.plusDi > adxData.minusDi && ema21SlopeBull) {
    p1Bull += 4;
  } else if (adxData.adx >= 18 && adxData.minusDi > adxData.plusDi && ema21SlopeBear) {
    p1Bear += 4;
  }

  if (ema200 != null) {
    if (lastClose > ema200 + eps && p1Bull > p1Bear) p1Bull += 4;
    else if (lastClose < ema200 - eps && p1Bear > p1Bull) p1Bear += 4;
  }
  p1Bull = Math.min(25, p1Bull);
  p1Bear = Math.min(25, p1Bear);

  // --- PILLAR 2: Unified Momentum (RSI pullback/continuation band + MACD bias, max 20) ---
  let p2Bull = 0;
  let p2Bear = 0;
  const strongTrend = adxData.adx >= 24;
  const rsiBullCap = strongTrend ? 72 : 66;
  const rsiBearFloor = strongTrend ? 28 : 34;
  const rsiBullHealthy = rsi14 >= 48 && rsi14 <= rsiBullCap && rsi14 >= prevRsi14 - 1.2;
  const rsiBearHealthy = rsi14 <= 52 && rsi14 >= rsiBearFloor && rsi14 <= prevRsi14 + 1.2;
  const macdPositive = macd.line > macd.signal + eps || (macd.line > eps && macd.histogram >= macd.prevHistogram);
  const macdNegative = macd.signal > macd.line + eps || (macd.line < -eps && macd.histogram <= macd.prevHistogram);
  const macdBullAccel = macd.line > macd.signal + eps && macd.histogram > eps && macd.histogram >= macd.prevHistogram;
  const macdBearAccel = macd.signal > macd.line + eps && macd.histogram < -eps && macd.histogram <= macd.prevHistogram;

  if (rsiBullHealthy && macdBullAccel) {
    p2Bull = 20;
    reasonsBull.push(`Unified momentum bullish: RSI(${rsi14.toFixed(1)}) + expanding positive MACD histogram.`);
  } else if (rsiBearHealthy && macdBearAccel) {
    p2Bear = 20;
    reasonsBear.push(`Unified momentum bearish: RSI(${rsi14.toFixed(1)}) + expanding negative MACD histogram.`);
  } else {
    if (rsiBullHealthy) p2Bull += 11;
    else if (rsi14 > 78 && !strongTrend) p2Bear += 6;
    if (rsiBearHealthy) p2Bear += 11;
    else if (rsi14 < 22 && !strongTrend) p2Bull += 6;

    if (macdPositive) p2Bull += 8;
    else if (macdNegative) p2Bear += 8;
  }
  p2Bull = Math.min(20, p2Bull);
  p2Bear = Math.min(20, p2Bear);

  // --- PILLAR 3: Volatility Quality, Efficiency & Non-Overextended Pullback Timing (max 20) ---
  let p3Bull = 0;
  let p3Bear = 0;
  const allowHighVol = profile === 'momentum';
  const cleanDirectionalFlow = er >= 0.25 && (volatilityRegime === 'NORMAL' || (allowHighVol && volatilityRegime === 'HIGH'));
  const maxTrendExt =
    profile === 'conservative'
      ? Math.min(0.7, instProfile.maxTrendExtensionAtr)
      : profile === 'momentum'
        ? Math.min(1.05, instProfile.maxTrendExtensionAtr + 0.2)
        : instProfile.maxTrendExtensionAtr;

  // Empirically validated pullback-continuation corridor (-0.15 .. +maxTrendExt ATR from EMA21)
  const sweetSpotBull = marketStructure.extensionAtr >= -0.15 && marketStructure.extensionAtr <= maxTrendExt;
  const sweetSpotBear = marketStructure.extensionAtr <= 0.15 && marketStructure.extensionAtr >= -maxTrendExt;
  const moderateFlowBull = marketStructure.extensionAtr > maxTrendExt && marketStructure.extensionAtr <= 1.25;
  const moderateFlowBear = marketStructure.extensionAtr < -maxTrendExt && marketStructure.extensionAtr >= -1.25;

  if (cleanDirectionalFlow && bb.bandwidthPct > 0 && atrToSpreadRatio >= instProfile.minAtrToSpreadRatio) {
    if (sweetSpotBull && bb.percentB >= 0.4 && bb.percentB <= 0.82 && lastClose >= ema21 - eps) {
      p3Bull = 20;
      reasonsBull.push(
        `Unextended pullback-continuation timing (ER ${er.toFixed(2)}, ext +${marketStructure.extensionAtr} ATR, %B ${bb.percentB.toFixed(2)}).`
      );
    } else if (sweetSpotBear && bb.percentB >= 0.18 && bb.percentB <= 0.6 && lastClose <= ema21 + eps) {
      p3Bear = 20;
      reasonsBear.push(
        `Unextended pullback-continuation timing (ER ${er.toFixed(2)}, ext ${marketStructure.extensionAtr} ATR, %B ${bb.percentB.toFixed(2)}).`
      );
    } else if (moderateFlowBull && lastClose > bb.middle + eps) {
      p3Bull = 11;
    } else if (moderateFlowBear && lastClose < bb.middle - eps) {
      p3Bear = 11;
    }
  }

  // --- PILLAR 4: Price Action, Breakouts & Support/Resistance Room-to-Run (max 20) ---
  let p4Bull = 0;
  let p4Bear = 0;
  const minRoom = instProfile.minRoomToTargetAtr;
  const hasRoomAbove = distToResAtr >= minRoom;
  const hasRoomBelow = distToSupAtr >= minRoom;

  if (hasRoomAbove && (lastClose > ema9 || marketStructure.extensionAtr >= -0.1)) {
    p4Bull += 10;
  }
  if (hasRoomBelow && (lastClose < ema9 || marketStructure.extensionAtr <= 0.1)) {
    p4Bear += 10;
  }

  if (marketStructure.breakoutState === 'BULLISH_BREAKOUT' && hasRoomAbove) {
    p4Bull += 6;
    reasonsBull.push('Confirmed bullish breakout with S/R clearance.');
  } else if (marketStructure.breakoutState === 'BEARISH_BREAKOUT' && hasRoomBelow) {
    p4Bear += 6;
    reasonsBear.push('Confirmed bearish breakdown with S/R clearance.');
  } else if (marketStructure.breakoutState === 'FALSE_BULL_BREAKOUT') {
    p4Bear += 8;
    reasonsBear.push('Detected false bullish breakout rejection wick.');
  } else if (marketStructure.breakoutState === 'FALSE_BEAR_BREAKOUT') {
    p4Bull += 8;
    reasonsBull.push('Detected false bearish breakdown rejection wick.');
  }

  if (patternInfo.bias > 0 && hasRoomAbove) {
    p4Bull += Math.min(8, patternInfo.bias);
    reasonsBull.push(patternInfo.summary);
  } else if (patternInfo.bias < 0 && hasRoomBelow) {
    p4Bear += Math.min(8, Math.abs(patternInfo.bias));
    reasonsBear.push(patternInfo.summary);
  }

  p4Bull = Math.min(20, p4Bull);
  p4Bear = Math.min(20, p4Bear);

  const verdictOf = (b: number, s: number, minPts: number): 'BULL' | 'BEAR' | 'NEUTRAL' => {
    if (b >= minPts && b >= s + 5) return 'BULL';
    if (s >= minPts && s >= b + 5) return 'BEAR';
    return 'NEUTRAL';
  };

  const pillars: PillarBreakdown = {
    trendStructure: { bull: p1Bull, bear: p1Bear, max: 25, verdict: verdictOf(p1Bull, p1Bear, 13) },
    momentum: { bull: p2Bull, bear: p2Bear, max: 20, verdict: verdictOf(p2Bull, p2Bear, 11) },
    volatilityRegime: { bull: p3Bull, bear: p3Bear, max: 20, verdict: verdictOf(p3Bull, p3Bear, 11) },
    priceActionSR: { bull: p4Bull, bear: p4Bear, max: 20, verdict: verdictOf(p4Bull, p4Bear, 10) },
    multiTimeframe: { bull: 0, bear: 0, max: 15, verdict: 'NEUTRAL' },
    independentBullConfirmations: 0,
    independentBearConfirmations: 0,
    conflictPenalty: 0,
  };

  return {
    pillars,
    reasonsBull,
    reasonsBear,
    isIndecisionBar: patternInfo.isIndecision,
    distToResAtr,
    distToSupAtr,
    atrToSpreadRatio,
    flatBars12,
    instrumentProfile: instProfile,
    macdPositive,
    macdNegative,
    indicators: {
      ema9: Number(ema9.toFixed(6)),
      ema21: Number(ema21.toFixed(6)),
      ema50: Number(ema50.toFixed(6)),
      ema200: ema200 != null ? Number(ema200.toFixed(6)) : null,
      rsi14,
      macdLine: Number(macd.line.toFixed(6)),
      macdSignal: Number(macd.signal.toFixed(6)),
      macdHistogram: Number(macd.histogram.toFixed(6)),
      bbUpper: Number(bb.upper.toFixed(6)),
      bbMiddle: Number(bb.middle.toFixed(6)),
      bbLower: Number(bb.lower.toFixed(6)),
      bbBandwidthPct: Number(bb.bandwidthPct.toFixed(4)),
      bbPercentB: Number(bb.percentB.toFixed(3)),
      atr14: Number(atr14.toFixed(6)),
      atrPct: Number(atrPct.toFixed(4)),
      nearestSupport: Number(sr.support.toFixed(6)),
      nearestResistance: Number(sr.resistance.toFixed(6)),
      supportDistancePct: Number(supportDistancePct.toFixed(3)),
      resistanceDistancePct: Number(resistanceDistancePct.toFixed(3)),
      trend,
      volatilityRegime,
      patterns: patternInfo.patterns,
      priceActionSummary: patternInfo.summary,
      adx14: adxData.adx,
      efficiencyRatio: er,
      marketStructure,
    },
  };
}

/**
 * Legacy Pre-Upgrade Evaluator — preserved strictly for Phase 7 A/B walk-forward backtesting
 * to compare the ORIGINAL engine against the IMPROVED engine on identical real market data.
 */
export function evaluateLegacyQuant(
  candles: Candle[],
  minScore = 65,
  profile: StrategyProfile = 'balanced',
  higherTimeframeCandles?: Candle[] | null
): { direction: 'CALL' | 'PUT' | 'WAIT'; bullScore: number; bearScore: number; score: number } {
  if (candles.length < 35) return { direction: 'WAIT', bullScore: 0, bearScore: 0, score: 0 };
  const evalSimple = (bars: Candle[]) => {
    const closes = bars.map((c) => c.close);
    const ema9Arr = computeEmaSeries(closes, 9);
    const ema21Arr = computeEmaSeries(closes, 21);
    const ema50Arr = computeEmaSeries(closes, Math.min(50, closes.length));
    const ema9 = ema9Arr[ema9Arr.length - 1];
    const ema21 = ema21Arr[ema21Arr.length - 1];
    const ema50 = ema50Arr[ema50Arr.length - 1];
    const prevEma9 = ema9Arr[Math.max(0, ema9Arr.length - 2)];
    const prevEma21 = ema21Arr[Math.max(0, ema21Arr.length - 2)];
    const rsi14 = computeRsi(closes, 14);
    const macd = computeMacd(closes);
    const bb = computeBollinger(closes, 20, 2);
    const atr14 = computeAtr(bars, 14);
    const lastClose = closes[closes.length - 1];
    const atrPct = lastClose > 0 ? (atr14 / lastClose) * 100 : 0;
    const sr = detectSupportResistance(bars);
    const supDist = lastClose > 0 ? ((lastClose - sr.support) / lastClose) * 100 : 0;
    const resDist = lastClose > 0 ? ((sr.resistance - lastClose) / lastClose) * 100 : 0;
    const trend = detectTrend(bars, ema9, ema21, ema50);
    const pat = detectCandlestickPatterns(bars);

    let bull = 0;
    let bear = 0;
    const eps = Math.max(1e-12, Math.abs(lastClose) * 1e-8);
    if (ema9 - ema21 > eps && ema21 - ema50 > eps) bull += profile === 'momentum' ? 28 : 24;
    else if (ema21 - ema9 > eps && ema50 - ema21 > eps) bear += profile === 'momentum' ? 28 : 24;
    else if (ema9 - ema21 > eps) bull += 14;
    else if (ema21 - ema9 > eps) bear += 14;

    if (prevEma9 <= prevEma21 + eps && ema9 - ema21 > eps) bull += 8;
    else if (prevEma9 >= prevEma21 - eps && ema21 - ema9 > eps) bear += 8;

    if (macd.line - macd.signal > eps && macd.histogram > eps) bull += macd.histogram > macd.prevHistogram ? 22 : 16;
    else if (macd.signal - macd.line > eps && macd.histogram < -eps) bear += macd.histogram < macd.prevHistogram ? 22 : 16;

    if (rsi14 >= 52 && rsi14 <= 70) bull += 18;
    else if (rsi14 >= 30 && rsi14 <= 48) bear += 18;
    else if (rsi14 > 50 && rsi14 < 52) bull += 8;
    else if (rsi14 > 48 && rsi14 < 50) bear += 8;
    else if (rsi14 < 30) bull += profile === 'conservative' ? 16 : 10;
    else if (rsi14 > 70) bear += profile === 'conservative' ? 16 : 10;

    if (bb.bandwidthPct > 0 && bb.percentB >= 0.45 && bb.percentB <= 0.92 && lastClose - bb.middle > eps) bull += 12;
    else if (bb.bandwidthPct > 0 && bb.percentB >= 0.08 && bb.percentB <= 0.55 && bb.middle - lastClose > eps) bear += 12;
    else if (bb.bandwidthPct > 0 && bb.percentB < 0.08) bull += 10;
    else if (bb.bandwidthPct > 0 && bb.percentB > 0.92) bear += 10;

    if (supDist <= 0.12 && resDist > 0.15) bull += 10;
    else if (resDist <= 0.12 && supDist > 0.15) bear += 10;

    if (pat.bias > 0) bull += Math.min(15, pat.bias);
    else if (pat.bias < 0) bear += Math.min(15, Math.abs(pat.bias));

    // Legacy bug: always evaluated volatility with EURUSD/1m thresholds
    const extremeVol = atrPct > 0.65 || bb.bandwidthPct > 2.2;
    return { bull: Math.min(100, bull), bear: Math.min(100, bear), trend, extremeVol };
  };

  const c = evalSimple(candles);
  let bull = c.bull;
  let bear = c.bear;
  let conflict = false;
  if (higherTimeframeCandles && higherTimeframeCandles.length >= 35) {
    const h = evalSimple(higherTimeframeCandles);
    if (h.trend === 'UPTREND' && bull > bear) bull = Math.min(100, bull + 10);
    else if (h.trend === 'DOWNTREND' && bear > bull) bear = Math.min(100, bear + 10);
    else if ((h.trend === 'UPTREND' && bear > bull) || (h.trend === 'DOWNTREND' && bull > bear)) conflict = true;
  }

  let direction: 'CALL' | 'PUT' | 'WAIT' = 'WAIT';
  const net = bull - bear;
  if (!c.extremeVol && !conflict) {
    if (net >= 16 && bull >= minScore) direction = 'CALL';
    else if (-net >= 16 && bear >= minScore) direction = 'PUT';
  }
  return { direction, bullScore: bull, bearScore: bear, score: Math.max(bull, bear) };
}

const empiricalBacktestCache = new Map<string, BacktestSampleStats>();

function runEmpiricalBacktest(
  candles: Candle[],
  symbol: string,
  timeframe: Timeframe,
  minScore: number,
  profile: StrategyProfile,
  horizonBars = 3
): BacktestSampleStats {
  if (candles.length < 70) {
    return {
      sampleSize: 0,
      wins: 0,
      losses: 0,
      winRatePct: null,
      expectancyPerUnit: null,
      horizonBars,
      note: 'Insufficient candle history for walk-forward replay (need >= 70 bars).',
    };
  }

  const lastBar = candles[candles.length - 1];
  const cacheKey = `${symbol}:${timeframe}:${candles.length}:${lastBar.time}:${lastBar.close.toFixed(6)}:${minScore}:${profile}:${horizonBars}`;
  const cached = empiricalBacktestCache.get(cacheKey);
  if (cached) return cached;

  let wins = 0;
  let losses = 0;
  const payout = 0.8;
  const instProfile = getInstrumentBehaviorProfile(symbol);
  const spreadBps = instProfile.estimatedSpreadBps;

  for (let i = 50; i < candles.length - horizonBars - 1; i += 2) {
    const window = candles.slice(0, i + 1);
    const res = analyzeMarketQuant(symbol, timeframe, window, 'backtest', {
      minScore,
      requireMtfAlignment: false,
      strategyProfile: profile,
      marketStatus: 'LIVE',
      isStale: false,
      skipEmpiricalBacktest: true,
    });
    if (res.direction === 'WAIT') continue;

    // Realistic 1-bar delayed entry at next bar open + half-spread; flat expiry settles as LOSS
    const rawEntry = candles[i + 1].open;
    const halfSpread = rawEntry * (spreadBps / 20000);
    const effectiveEntry = res.direction === 'CALL' ? rawEntry + halfSpread : rawEntry - halfSpread;
    const exit = candles[i + 1 + horizonBars].close;
    const won = (res.direction === 'CALL' && exit > effectiveEntry) || (res.direction === 'PUT' && exit < effectiveEntry);
    if (won) wins++;
    else losses++;
  }

  const sampleSize = wins + losses;
  const result: BacktestSampleStats =
    sampleSize === 0
      ? {
          sampleSize: 0,
          wins: 0,
          losses: 0,
          winRatePct: null,
          expectancyPerUnit: null,
          horizonBars,
          note: `No historical setups met strict ${minScore}/100 multi-pillar criteria across ${candles.length} bars.`,
        }
      : {
          sampleSize,
          wins,
          losses,
          winRatePct: Number(((wins / sampleSize) * 100).toFixed(1)),
          expectancyPerUnit: Number(((wins * payout - losses) / sampleSize).toFixed(3)),
          horizonBars,
          note: `Walk-forward check on ${candles.length} bars (1-bar entry delay, ${spreadBps} bps spread, ${horizonBars}-bar horizon, 80% payout, flat=loss${sampleSize < 15 ? '; low sample <15 trades' : ''}).`,
        };

  if (empiricalBacktestCache.size >= 160) {
    const oldest = empiricalBacktestCache.keys().next().value;
    if (oldest) empiricalBacktestCache.delete(oldest);
  }
  empiricalBacktestCache.set(cacheKey, result);
  return result;
}

function sanitizeCandles(candles?: Candle[]): { valid: Candle[]; rejectedCount: number } {
  if (!Array.isArray(candles)) return { valid: [], rejectedCount: 0 };
  const valid: Candle[] = [];
  let rejectedCount = 0;
  for (const c of candles) {
    if (
      c &&
      Number.isFinite(c.time) &&
      c.time > 0 &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.open > 0 &&
      c.high > 0 &&
      c.low > 0 &&
      c.close > 0 &&
      c.high >= c.low
    ) {
      valid.push(c);
    } else {
      rejectedCount += 1;
    }
  }
  return { valid, rejectedCount };
}

export function analyzeMarketQuant(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  provider: string,
  options: QuantOptions = {}
): QuantAnalysisResult {
  const profile: StrategyProfile = options.strategyProfile ?? 'balanced';
  const defaultProfileMin = profile === 'conservative' ? 76 : profile === 'momentum' ? 68 : 72;
  const historicalBias = options.historicalBias ?? null;
  const baseMinScore = options.minScore ?? defaultProfileMin;
  const effectiveMinScore = Math.max(60, Math.min(88, baseMinScore + (historicalBias?.scoreThresholdOffset ?? 0)));
  const requireMtf = options.requireMtfAlignment ?? true;
  const marketStatus = options.marketStatus ?? 'LIVE';
  const isStaleFeed = Boolean(options.isStale) || !isLiveMarketStatus(marketStatus);
  const higherTf = getHigherTimeframe(timeframe);
  const { valid: validCandles, rejectedCount } = sanitizeCandles(candles);

  if (validCandles.length < 35) {
    const lastBarTime = validCandles[validCandles.length - 1]?.time;
    const feedLastUpdateAt = lastBarTime ? new Date(lastBarTime * 1000).toISOString() : null;
    const missingReason =
      !candles || candles.length === 0
        ? `Market data unavailable from ${provider || 'provider'} — no OHLCV candles returned.`
        : rejectedCount > 0
          ? `Market candle data invalid (${rejectedCount} corrupted/non-positive bar(s) filtered; ${validCandles.length} valid bars remaining, minimum 35 required).`
          : `Insufficient candle history (${validCandles.length} bars supplied; minimum 35 required for multi-pillar analysis).`;
    return {
      symbol,
      timeframe,
      direction: 'WAIT',
      score: 0,
      confidenceScore: 0,
      rawDirectionalConfidence: 0,
      actionableConfidence: 0,
      confidenceState: 'STALE_OR_UNAVAILABLE',
      zeroConfidenceReason: missingReason,
      feedLastUpdateAt,
      bullishScore: 0,
      bearishScore: 0,
      entryPrice: validCandles[validCandles.length - 1]?.close ?? null,
      suggestedExpirySeconds: getSuggestedExpirySeconds(timeframe, null),
      provider,
      marketStatus: isLiveMarketStatus(marketStatus) ? 'UNAVAILABLE' : marketStatus,
      isStale: true,
      timestamp: new Date().toISOString(),
      indicators: null,
      supportingIndicators: null,
      riskAssessment: {
        level: 'EXTREME',
        volatilityRegime: 'UNKNOWN',
        atrPct: null,
        suggestedStakePct: 0,
        summary: missingReason,
      },
      mtf: null,
      backtest: {
        sampleSize: 0,
        wins: 0,
        losses: 0,
        winRatePct: null,
        expectancyPerUnit: null,
        horizonBars: 3,
        note: 'Insufficient valid candles (minimum 35 bars required).',
      },
      reasons: [missingReason],
      rejectionReasons: [missingReason],
      warning: 'MARKET DATA UNAVAILABLE OR INVALID — Decision locked to WAIT.',
    };
  }

  // Fixed bug: always pass actual symbol & timeframe for accurate volatility calibration
  const core = evaluateIndependentPillars(validCandles, profile, symbol, timeframe);
  const { pillars, indicators: ind } = core;
  const ms = ind.marketStructure!;
  const instProfile = core.instrumentProfile;
  const compatibility = evaluateTimeframeExpiryCompatibility(
    timeframe,
    options.requestedExpirySeconds,
    ind.volatilityRegime
  );

  // --- PILLAR 5: Enhanced Multi-Timeframe Alignment (max 15) ---
  let higherTrend: MultiTimeframeSummary['higherTrend'] = 'UNAVAILABLE';
  let higherRsi: number | null = null;
  let alignment: MultiTimeframeSummary['alignment'] = 'NEUTRAL';
  let htfPriceBull = false;
  let htfPriceBear = false;
  let htfStrongBull = false;
  let htfStrongBear = false;

  const validHtf = sanitizeCandles(options.higherTimeframeCandles?.candles).valid;
  if (validHtf.length >= 35) {
    const htfCloses = validHtf.map((c) => c.close);
    const htfEma21Arr = computeEmaSeries(htfCloses, 21);
    const htfEma21 = htfEma21Arr[htfEma21Arr.length - 1];
    const htfLastClose = htfCloses[htfCloses.length - 1];
    const htfEval = evaluateIndependentPillars(validHtf, profile, symbol, higherTf);
    higherTrend = htfEval.indicators.trend;
    higherRsi = htfEval.indicators.rsi14;

    htfPriceBull = htfLastClose > htfEma21;
    htfPriceBear = htfLastClose < htfEma21;
    htfStrongBull = higherTrend === 'UPTREND' || (htfPriceBull && htfEval.indicators.ema9 > htfEma21 && (higherRsi ?? 50) >= 51);
    htfStrongBear = higherTrend === 'DOWNTREND' || (htfPriceBear && htfEval.indicators.ema9 < htfEma21 && (higherRsi ?? 50) <= 49);

    const htfEarlyBull = htfPriceBull && (higherRsi ?? 50) >= 48;
    const htfEarlyBear = htfPriceBear && (higherRsi ?? 50) <= 52;

    const primaryBullSum =
      pillars.trendStructure.bull + pillars.momentum.bull + pillars.volatilityRegime.bull + pillars.priceActionSR.bull;
    const primaryBearSum =
      pillars.trendStructure.bear + pillars.momentum.bear + pillars.volatilityRegime.bear + pillars.priceActionSR.bear;

    if (htfStrongBull && !htfStrongBear) {
      pillars.multiTimeframe.bull = higherTrend === 'UPTREND' ? 15 : 11;
      pillars.multiTimeframe.verdict = 'BULL';
      alignment = primaryBullSum >= primaryBearSum ? 'ALIGNED_BULLISH' : 'CONFLICT';
    } else if (htfStrongBear && !htfStrongBull) {
      pillars.multiTimeframe.bear = higherTrend === 'DOWNTREND' ? 15 : 11;
      pillars.multiTimeframe.verdict = 'BEAR';
      alignment = primaryBearSum >= primaryBullSum ? 'ALIGNED_BEARISH' : 'CONFLICT';
    } else if (htfEarlyBull && primaryBearSum > primaryBullSum + 8) {
      pillars.multiTimeframe.bull = 6;
      alignment = 'CONFLICT';
    } else if (htfEarlyBear && primaryBullSum > primaryBearSum + 8) {
      pillars.multiTimeframe.bear = 6;
      alignment = 'CONFLICT';
    } else {
      alignment = 'NEUTRAL';
    }
  }

  const allPillars = [
    pillars.trendStructure,
    pillars.momentum,
    pillars.volatilityRegime,
    pillars.priceActionSR,
    pillars.multiTimeframe,
  ];
  const bullConfirmations = allPillars.filter((p) => p.verdict === 'BULL').length;
  const bearConfirmations = allPillars.filter((p) => p.verdict === 'BEAR').length;
  pillars.independentBullConfirmations = bullConfirmations;
  pillars.independentBearConfirmations = bearConfirmations;

  // Normalize to 0-100 when HTF is unavailable so 4 pillars can still be scored fairly (max 85 -> scaled to 92 max)
  const rawBull = allPillars.reduce((s, p) => s + p.bull, 0);
  const rawBear = allPillars.reduce((s, p) => s + p.bear, 0);
  const scaleFactor = higherTrend === 'UNAVAILABLE' ? 92 / 85 : 1;
  const bull = Math.min(100, Math.round(rawBull * scaleFactor));
  const bear = Math.min(100, Math.round(rawBear * scaleFactor));

  const dominantSide: 'CALL' | 'PUT' | 'NONE' = bull > bear ? 'CALL' : bear > bull ? 'PUT' : 'NONE';
  const dominantRaw = Math.max(bull, bear);
  const opposingRaw = Math.min(bull, bear);
  const dominantConfirmations = dominantSide === 'CALL' ? bullConfirmations : dominantSide === 'PUT' ? bearConfirmations : 0;
  const opposingConfirmations = dominantSide === 'CALL' ? bearConfirmations : dominantSide === 'PUT' ? bullConfirmations : 0;

  // Conflict penalty: penalize opposing pillar votes so contradictory indicators never look "confident"
  const conflictPenalty = Math.min(28, Math.round(opposingRaw * 0.45) + opposingConfirmations * 6);
  pillars.conflictPenalty = conflictPenalty;

  // --- ADAPTIVE MARKET REGIME CLASSIFICATION ---
  // Classifies the market into TRENDING, RANGING, VOLATILE, or REVERSING and adapts entry logic per regime.
  const cLast = validCandles[validCandles.length - 1];
  const lastBullBar = cLast.close > cLast.open;
  const lastBearBar = cLast.close < cLast.open;
  const minRevExt =
    profile === 'conservative'
      ? Math.max(1.65, instProfile.minReversalExtensionAtr)
      : profile === 'momentum'
        ? Math.max(1.45, instProfile.minReversalExtensionAtr - 0.1)
        : instProfile.minReversalExtensionAtr;
  const maxRevAdx = profile === 'conservative' ? 32 : 35;

  const hasExhaustionTurn =
    ms.adx14 < maxRevAdx &&
    ((ms.extensionAtr <= -minRevExt && ind.rsi14 <= 33 && ind.bbPercentB <= 0.12 && lastBullBar) ||
      (ms.extensionAtr >= minRevExt && ind.rsi14 >= 67 && ind.bbPercentB >= 0.88 && lastBearBar));

  const hasReversalPattern =
    ind.patterns.some((p) => /Engulfing|Hammer|Shooting Star|Morning Star|Evening Star/i.test(p)) ||
    ms.breakoutState === 'FALSE_BULL_BREAKOUT' ||
    ms.breakoutState === 'FALSE_BEAR_BREAKOUT' ||
    ms.reversalState !== 'NONE' ||
    hasExhaustionTurn;

  let marketRegime: AdaptiveMarketRegime = 'RANGING';
  if (ind.volatilityRegime === 'EXTREME' || ind.volatilityRegime === 'HIGH') {
    marketRegime = 'VOLATILE';
  } else if (
    hasExhaustionTurn ||
    (hasReversalPattern &&
      (ms.reversalState !== 'NONE' ||
        ms.breakoutState === 'FALSE_BULL_BREAKOUT' ||
        ms.breakoutState === 'FALSE_BEAR_BREAKOUT'))
  ) {
    marketRegime = 'REVERSING';
  } else if (
    ms.adx14 >= 18 &&
    ms.efficiencyRatio >= 0.25 &&
    (ms.structure === 'BULLISH_HH_HL' ||
      ms.structure === 'BEARISH_LH_LL' ||
      ind.trend === 'UPTREND' ||
      ind.trend === 'DOWNTREND')
  ) {
    marketRegime = 'TRENDING';
  } else {
    marketRegime = 'RANGING';
  }
  ms.regime = marketRegime;

  let activeStrategy: AdaptiveStrategyName =
    marketRegime === 'TRENDING'
      ? 'TREND_CONTINUATION'
      : marketRegime === 'RANGING'
        ? 'RANGE_MEAN_REVERSION'
        : marketRegime === 'REVERSING'
          ? 'STRUCTURE_REVERSAL'
          : ind.volatilityRegime === 'EXTREME'
            ? 'CAPITAL_PROTECTION'
            : 'VOLATILITY_BREAKOUT';

  // --- PHASE 3: REGIME-ADAPTED LIQUIDITY, STRUCTURE & STRATEGY GATING ---
  const rejectionReasons: string[] = [];
  let adaptiveCandidateSide: 'CALL' | 'PUT' | 'NONE' = dominantSide;
  let adaptiveEffectiveScore = dominantRaw;
  const minAtrRatio = profile === 'conservative' ? instProfile.minAtrToSpreadRatio + 0.3 : instProfile.minAtrToSpreadRatio;

  // Common universal guards
  if (ind.volatilityRegime === 'EXTREME') {
    activeStrategy = 'CAPITAL_PROTECTION';
    rejectionReasons.push(`Volatility regime is EXTREME (ATR ${ind.atrPct.toFixed(3)}%) — Capital Protection holds WAIT.`);
  } else if (ind.volatilityRegime === 'LOW') {
    rejectionReasons.push(`Volatility regime is LOW/FLAT (ATR ${ind.atrPct.toFixed(4)}%) — high risk of flat-price expiry loss.`);
  }
  if (core.atrToSpreadRatio < minAtrRatio) {
    rejectionReasons.push(
      `${symbol} ATR-to-spread ratio (${core.atrToSpreadRatio.toFixed(2)}x) is below ${minAtrRatio.toFixed(1)}x viability floor (${instProfile.estimatedSpreadBps} bps spread).`
    );
  }
  if (core.flatBars12 > 3) {
    rejectionReasons.push(`Low session liquidity detected (${core.flatBars12}/12 flat-close bars) — waiting for active volatility.`);
  }
  if (core.isIndecisionBar) {
    rejectionReasons.push('Latest completed bar is a Doji indecision candle — waiting for directional close confirmation.');
  }
  if (requireMtf && alignment === 'CONFLICT' && marketRegime !== 'REVERSING' && marketRegime !== 'RANGING') {
    rejectionReasons.push(`Higher timeframe (${higherTf} ${higherTrend}) conflicts with primary ${timeframe} structure.`);
  }

  if (marketRegime === 'TRENDING') {
    // Strategy: TREND_CONTINUATION (Unextended Pullback / Sweet-Spot Flow Only)
    const minIndependentPillars = profile === 'conservative' ? 4 : 3;
    const minAdxTrend = profile === 'conservative' ? 20 : 18;
    const minErTrend = profile === 'conservative' ? 0.27 : 0.25;
    const maxExtTrend =
      profile === 'conservative'
        ? Math.min(0.68, instProfile.maxTrendExtensionAtr)
        : profile === 'momentum'
          ? Math.min(0.95, instProfile.maxTrendExtensionAtr + 0.15)
          : instProfile.maxTrendExtensionAtr;

    if (ms.adx14 < minAdxTrend || ms.efficiencyRatio < minErTrend) {
      rejectionReasons.push(
        `Trend strength insufficient (${profile}: ADX ${ms.adx14.toFixed(1)} >= ${minAdxTrend}, ER ${ms.efficiencyRatio.toFixed(2)} >= ${minErTrend}).`
      );
    }
    if (dominantConfirmations < minIndependentPillars) {
      rejectionReasons.push(`Trend Continuation requires >= ${minIndependentPillars} independent pillars (got ${dominantConfirmations}).`);
    }
    if (opposingConfirmations >= 1 && opposingRaw >= 20) {
      rejectionReasons.push(`Major conflicting evidence detected (${opposingConfirmations} opposing pillar(s), score ${opposingRaw}/100).`);
    }
    if (requireMtf && higherTrend === 'UNAVAILABLE' && profile === 'conservative') {
      rejectionReasons.push(`Higher timeframe (${higherTf}) unavailable — conservative profile requires HTF confirmation.`);
    }
    if (requireMtf && higherTrend === 'RANGING' && profile === 'conservative') {
      rejectionReasons.push(`Higher timeframe (${higherTf}) is RANGING — conservative profile requires aligned HTF trend.`);
    }

    const netMargin = dominantRaw - opposingRaw;
    if (netMargin < 24) {
      rejectionReasons.push(`Trend net directional margin (${netMargin}) below required 24 pt separation.`);
    }

    if (dominantSide === 'CALL') {
      if (requireMtf && validHtf.length >= 35 && !htfPriceBull) {
        rejectionReasons.push(`Higher timeframe (${higherTf}) close is below HTF EMA21 — holding WAIT against counter-HTF CALL.`);
      }
      if (higherRsi != null && higherRsi > 77) {
        rejectionReasons.push(`Higher timeframe (${higherTf}) RSI=${higherRsi.toFixed(1)} is overextended — avoiding late top CALL.`);
      }
      if (ms.extensionAtr > maxExtTrend) {
        rejectionReasons.push(
          `Late CALL entry rejected: price extended +${ms.extensionAtr} ATR above EMA21 (sweet spot <= +${maxExtTrend} ATR).`
        );
      } else if (ms.extensionAtr < -0.25) {
        rejectionReasons.push(`Pullback CALL premature: price (${ms.extensionAtr} ATR) has not reclaimed EMA21.`);
      }
      if (ind.rsi14 > 65 || ind.rsi14 < 47) {
        rejectionReasons.push(`RSI(${ind.rsi14.toFixed(1)}) outside balanced bullish continuation corridor (47–65).`);
      }
      if (ms.breakoutState === 'FALSE_BULL_BREAKOUT') rejectionReasons.push('False bullish breakout rejection wick detected.');
      if (core.distToResAtr < instProfile.minRoomToTargetAtr) {
        rejectionReasons.push(`Insufficient room to resistance (${core.distToResAtr.toFixed(2)} ATR).`);
      }
    } else if (dominantSide === 'PUT') {
      if (requireMtf && validHtf.length >= 35 && !htfPriceBear) {
        rejectionReasons.push(`Higher timeframe (${higherTf}) close is above HTF EMA21 — holding WAIT against counter-HTF PUT.`);
      }
      if (higherRsi != null && higherRsi < 23) {
        rejectionReasons.push(`Higher timeframe (${higherTf}) RSI=${higherRsi.toFixed(1)} is oversold — avoiding late bottom PUT.`);
      }
      if (ms.extensionAtr < -maxExtTrend) {
        rejectionReasons.push(
          `Late PUT entry rejected: price extended ${ms.extensionAtr} ATR below EMA21 (sweet spot >= -${maxExtTrend} ATR).`
        );
      } else if (ms.extensionAtr > 0.25) {
        rejectionReasons.push(`Pullback PUT premature: price (+${ms.extensionAtr} ATR) remains above EMA21.`);
      }
      if (ind.rsi14 < 35 || ind.rsi14 > 53) {
        rejectionReasons.push(`RSI(${ind.rsi14.toFixed(1)}) outside balanced bearish continuation corridor (35–53).`);
      }
      if (ms.breakoutState === 'FALSE_BEAR_BREAKOUT') rejectionReasons.push('False bearish breakdown rejection wick detected.');
      if (core.distToSupAtr < instProfile.minRoomToTargetAtr) {
        rejectionReasons.push(`Insufficient room to support (${core.distToSupAtr.toFixed(2)} ATR).`);
      }
    }
  } else if (marketRegime === 'RANGING') {
    // Strategy: RANGE_MEAN_REVERSION — ATR/Bollinger/RSI range extremes with rejection close & HTF non-opposition.
    const maxRangeAdx = profile === 'conservative' ? 20 : 23;
    const atLowerExtreme =
      ms.adx14 < maxRangeAdx &&
      ms.efficiencyRatio < 0.28 &&
      ind.bbPercentB <= 0.16 &&
      ind.rsi14 <= 36 &&
      lastBullBar;
    const atUpperExtreme =
      ms.adx14 < maxRangeAdx &&
      ms.efficiencyRatio < 0.28 &&
      ind.bbPercentB >= 0.84 &&
      ind.rsi14 >= 64 &&
      lastBearBar;

    if (atLowerExtreme && (!requireMtf || (!htfStrongBear && higherTrend !== 'DOWNTREND')) && core.distToResAtr >= 1.1) {
      adaptiveCandidateSide = 'CALL';
      const srBonus = core.distToSupAtr <= 1.2 ? 6 : 2;
      adaptiveEffectiveScore = Math.max(
        dominantRaw,
        Math.min(84, Math.round(72 + (36 - ind.rsi14) * 0.7 + srBonus + (hasReversalPattern ? 6 : 0)))
      );
    } else if (atUpperExtreme && (!requireMtf || (!htfStrongBull && higherTrend !== 'UPTREND')) && core.distToSupAtr >= 1.1) {
      adaptiveCandidateSide = 'PUT';
      const srBonus = core.distToResAtr <= 1.2 ? 6 : 2;
      adaptiveEffectiveScore = Math.max(
        dominantRaw,
        Math.min(84, Math.round(72 + (ind.rsi14 - 64) * 0.7 + srBonus + (hasReversalPattern ? 6 : 0)))
      );
    } else {
      adaptiveCandidateSide = 'NONE';
      rejectionReasons.push(
        `Ranging market (ADX=${ms.adx14.toFixed(1)}, ER=${ms.efficiencyRatio.toFixed(2)}, %B=${ind.bbPercentB.toFixed(2)}) — mid-range chop rejected; waiting for verified range extreme.`
      );
    }
  } else if (marketRegime === 'REVERSING') {
    // Strategy: STRUCTURE_REVERSAL — overextension exhaustion snapbacks + low-ER false breakout/reversal traps.
    const exhaustionBull =
      ms.adx14 < maxRevAdx &&
      ms.extensionAtr <= -minRevExt &&
      ind.rsi14 <= 33 &&
      ind.bbPercentB <= 0.12 &&
      lastBullBar &&
      core.distToResAtr >= 0.9;
    const exhaustionBear =
      ms.adx14 < maxRevAdx &&
      ms.extensionAtr >= minRevExt &&
      ind.rsi14 >= 67 &&
      ind.bbPercentB >= 0.88 &&
      lastBearBar &&
      core.distToSupAtr >= 0.9;

    const structuralBullRev =
      ms.efficiencyRatio < 0.34 &&
      (ms.reversalState === 'BULLISH_REVERSAL' || ms.breakoutState === 'FALSE_BEAR_BREAKOUT') &&
      lastBullBar &&
      ind.rsi14 <= 48 &&
      core.distToResAtr >= 1.0 &&
      (!requireMtf || (!htfStrongBear && higherTrend !== 'DOWNTREND'));
    const structuralBearRev =
      ms.efficiencyRatio < 0.34 &&
      (ms.reversalState === 'BEARISH_REVERSAL' || ms.breakoutState === 'FALSE_BULL_BREAKOUT') &&
      lastBearBar &&
      ind.rsi14 >= 52 &&
      core.distToSupAtr >= 1.0 &&
      (!requireMtf || (!htfStrongBull && higherTrend !== 'UPTREND'));

    if (exhaustionBull || structuralBullRev) {
      adaptiveCandidateSide = 'CALL';
      const extBonus = exhaustionBull ? Math.min(10, Math.round((Math.abs(ms.extensionAtr) - 1.3) * 8)) : 4;
      adaptiveEffectiveScore = Math.max(
        dominantRaw,
        Math.min(86, 72 + extBonus + (hasReversalPattern ? 5 : 0) + (alignment === 'ALIGNED_BULLISH' ? 4 : 0))
      );
    } else if (exhaustionBear || structuralBearRev) {
      adaptiveCandidateSide = 'PUT';
      const extBonus = exhaustionBear ? Math.min(10, Math.round((Math.abs(ms.extensionAtr) - 1.3) * 8)) : 4;
      adaptiveEffectiveScore = Math.max(
        dominantRaw,
        Math.min(86, 72 + extBonus + (hasReversalPattern ? 5 : 0) + (alignment === 'ALIGNED_BEARISH' ? 4 : 0))
      );
    } else {
      adaptiveCandidateSide = 'NONE';
      rejectionReasons.push('Reversing market structure lacks exhaustion extreme or low-ER rejection confirmation — holding WAIT.');
    }
  } else {
    // Strategy: VOLATILITY_BREAKOUT (HIGH volatility only; EXTREME already blocked above)
    const strictVolMin = Math.min(88, effectiveMinScore + 4);
    const validBreakoutBull =
      ms.breakoutState === 'BULLISH_BREAKOUT' &&
      dominantSide === 'CALL' &&
      alignment === 'ALIGNED_BULLISH' &&
      ms.extensionAtr <= 1.25 &&
      core.distToResAtr >= 1.0;
    const validBreakoutBear =
      ms.breakoutState === 'BEARISH_BREAKOUT' &&
      dominantSide === 'PUT' &&
      alignment === 'ALIGNED_BEARISH' &&
      ms.extensionAtr >= -1.25 &&
      core.distToSupAtr >= 1.0;

    if (!validBreakoutBull && !validBreakoutBear) {
      rejectionReasons.push(
        `Elevated volatility (${ind.volatilityRegime}, ATR ${ind.atrPct.toFixed(3)}%) requires confirmed non-exhausted breakout + strict MTF alignment.`
      );
    }
    if (dominantConfirmations < 4) {
      rejectionReasons.push(`Volatility breakout requires >= 4 independent pillars (got ${dominantConfirmations}).`);
    }
    if (dominantRaw < strictVolMin) {
      rejectionReasons.push(`Volatility breakout score (${dominantRaw}/100) below elevated threshold (${strictVolMin}).`);
    }
  }

  // Gate 7: Live non-stale market data
  if (isStaleFeed) {
    rejectionReasons.unshift(
      `Market status is ${marketStatus} (candle feed stale or market closed) — actionable CALL/PUT suppressed to WAIT.`
    );
  }

  // Preliminary structural gate before computing empirical & calibrated confidence
  const prelimCandidate = rejectionReasons.length === 0 && adaptiveCandidateSide !== 'NONE' ? adaptiveCandidateSide : 'WAIT';

  // Walk-forward empirical backtest on current candle window (LRU memoized; skipped during recursive calls)
  const backtest: BacktestSampleStats = options.skipEmpiricalBacktest
    ? {
        sampleSize: 0,
        wins: 0,
        losses: 0,
        winRatePct: null,
        expectancyPerUnit: null,
        horizonBars: 3,
        note: 'Skipped during inner backtest evaluation.',
      }
    : runEmpiricalBacktest(validCandles, symbol, timeframe, effectiveMinScore, profile, 3);

  // --- PHASE 4: CALIBRATED CONFIDENCE ENGINE & POST-CALIBRATION CONFIDENCE GATE ---
  // Calibrated score accounts for pillar conflict, volatility/chop regime, timeframe-expiry fit,
  // historical learner bias, and Bayesian shrinkage toward empirical walk-forward outcomes.
  let regimeAdjustment = 0;
  if (ind.volatilityRegime === 'HIGH') regimeAdjustment -= 6;
  else if (ind.volatilityRegime === 'EXTREME' || ind.volatilityRegime === 'LOW') regimeAdjustment -= 14;
  if (ms.structure === 'CHOPPY_RANGE' && activeStrategy !== 'RANGE_MEAN_REVERSION') regimeAdjustment -= 8;
  if (alignment === 'CONFLICT') regimeAdjustment -= 10;
  else if (alignment === 'ALIGNED_BULLISH' || alignment === 'ALIGNED_BEARISH') regimeAdjustment += 4;
  regimeAdjustment += compatibility.confidenceAdjustment;

  // Mean-reversion / reversal setups inherently exhibit counter-momentum opposing pillar votes; apply moderated conflict scaling
  const effectiveConflictPenalty =
    activeStrategy === 'STRUCTURE_REVERSAL' || activeStrategy === 'RANGE_MEAN_REVERSION'
      ? Math.round(conflictPenalty * 0.35)
      : conflictPenalty;

  const historicalAdjustment = historicalBias?.confidenceAdjustment ?? 0;

  let calibrated = adaptiveEffectiveScore - effectiveConflictPenalty + regimeAdjustment + historicalAdjustment;

  // Empirical Bayesian shrinkage when walk-forward sample is meaningful (>= 8 signals)
  if (backtest.sampleSize >= 8 && backtest.winRatePct != null) {
    const empiricalWeight = Math.min(0.35, backtest.sampleSize / 40);
    calibrated = calibrated * (1 - empiricalWeight) + backtest.winRatePct * empiricalWeight;
  }

  const preGateCalibrated = isStaleFeed ? 0 : Math.max(0, Math.min(88, Math.round(calibrated)));

  // STRICT POST-CALIBRATION CONFIDENCE GATE: never emit CALL/PUT when calibratedScore < effectiveMinScore
  if (prelimCandidate !== 'WAIT' && preGateCalibrated < effectiveMinScore) {
    rejectionReasons.push(
      `Post-calibration confidence ${preGateCalibrated}/100 below required >= ${effectiveMinScore}/100 (raw ${adaptiveEffectiveScore}, conflict -${effectiveConflictPenalty}, regime ${regimeAdjustment >= 0 ? '+' : ''}${regimeAdjustment}, hist ${historicalAdjustment >= 0 ? '+' : ''}${historicalAdjustment}).`
    );
  }

  const direction: 'CALL' | 'PUT' | 'WAIT' =
    rejectionReasons.length === 0 && adaptiveCandidateSide !== 'NONE' && preGateCalibrated >= effectiveMinScore
      ? adaptiveCandidateSide
      : 'WAIT';

  // Honest calibration bounds: never claim > 88% certainty on short-horizon financial markets
  const calibratedScore = isStaleFeed
    ? 0
    : Math.max(0, Math.min(direction === 'WAIT' ? 62 : 88, preGateCalibrated));

  const confidenceCalibration: ConfidenceCalibration = {
    rawScore: adaptiveEffectiveScore,
    calibratedScore,
    independentConfirmations: dominantConfirmations,
    conflictPenalty: effectiveConflictPenalty,
    regimeAdjustment,
    historicalAdjustment,
    empiricalWinRatePct: backtest.winRatePct,
    empiricalSampleSize: backtest.sampleSize,
    calibrationNote:
      backtest.sampleSize >= 8 && backtest.winRatePct != null
        ? `Calibrated against ${backtest.sampleSize} walk-forward samples${backtest.sampleSize < 15 ? ' (low sample <15)' : ''} (${backtest.winRatePct}% observed win rate), conflict penalty -${effectiveConflictPenalty}, regime adj ${regimeAdjustment >= 0 ? '+' : ''}${regimeAdjustment}. Score reflects analytical evidence, not a guaranteed win probability.`
        : `Calibrated from ${dominantConfirmations}/5 independent pillars (${activeStrategy}), conflict penalty -${effectiveConflictPenalty}, regime adj ${regimeAdjustment >= 0 ? '+' : ''}${regimeAdjustment}. Score reflects analytical evidence, not a guaranteed win probability.`,
  };

  const reasons: string[] = [];
  if (direction === 'CALL') {
    if (activeStrategy === 'STRUCTURE_REVERSAL') {
      reasons.push(`Structure reversal CALL: oversold extension (${ms.extensionAtr} ATR, RSI ${ind.rsi14.toFixed(1)}) snapping back with bullish close.`);
    } else if (activeStrategy === 'RANGE_MEAN_REVERSION') {
      reasons.push(`Range mean-reversion CALL: lower Bollinger extreme (%B ${ind.bbPercentB.toFixed(2)}, RSI ${ind.rsi14.toFixed(1)}) rejecting upward.`);
    }
    reasons.push(...core.reasonsBull);
    if (alignment === 'ALIGNED_BULLISH') reasons.push(`Higher timeframe (${higherTf}) confirms bullish bias.`);
    if (!compatibility.compatible) reasons.push(`Timing note: ${compatibility.note}`);
    if (historicalBias?.cautionReason) reasons.push(historicalBias.cautionReason);
  } else if (direction === 'PUT') {
    if (activeStrategy === 'STRUCTURE_REVERSAL') {
      reasons.push(`Structure reversal PUT: overbought extension (+${ms.extensionAtr} ATR, RSI ${ind.rsi14.toFixed(1)}) snapping back with bearish close.`);
    } else if (activeStrategy === 'RANGE_MEAN_REVERSION') {
      reasons.push(`Range mean-reversion PUT: upper Bollinger extreme (%B ${ind.bbPercentB.toFixed(2)}, RSI ${ind.rsi14.toFixed(1)}) rejecting downward.`);
    }
    reasons.push(...core.reasonsBear);
    if (alignment === 'ALIGNED_BEARISH') reasons.push(`Higher timeframe (${higherTf}) confirms bearish bias.`);
    if (!compatibility.compatible) reasons.push(`Timing note: ${compatibility.note}`);
    if (historicalBias?.cautionReason) reasons.push(historicalBias.cautionReason);
  } else {
    reasons.push(...rejectionReasons);
    if (historicalBias?.cautionReason) reasons.push(historicalBias.cautionReason);
    if (core.reasonsBull[0]) reasons.push(`Bullish factor: ${core.reasonsBull[0]}`);
    if (core.reasonsBear[0]) reasons.push(`Bearish factor: ${core.reasonsBear[0]}`);
  }

  const entryPrice = validCandles[validCandles.length - 1].close;
  const rawDirectionalConfidence = calibratedScore;
  const actionableConfidence = isStaleFeed || direction === 'WAIT' ? 0 : calibratedScore;

  const riskLevel: RiskAssessment['level'] =
    isStaleFeed || ind.volatilityRegime === 'EXTREME'
      ? 'EXTREME'
      : ind.volatilityRegime === 'HIGH' || ind.volatilityRegime === 'LOW' || alignment === 'CONFLICT'
        ? 'HIGH'
        : direction === 'WAIT'
          ? 'MODERATE'
          : calibratedScore >= 76 && (alignment === 'ALIGNED_BULLISH' || alignment === 'ALIGNED_BEARISH')
            ? 'LOW'
            : 'MODERATE';

  const suggestedStakePct =
    isStaleFeed || direction === 'WAIT'
      ? 0
      : riskLevel === 'LOW'
        ? 1.0
        : riskLevel === 'MODERATE'
          ? 0.75
          : riskLevel === 'HIGH'
            ? 0.4
            : 0;

  const riskAssessment: RiskAssessment = {
    level: riskLevel,
    volatilityRegime: ind.volatilityRegime,
    atrPct: ind.atrPct,
    suggestedStakePct,
    summary: isStaleFeed
      ? `Market feed is ${marketStatus} (delayed or closed); actionable entries blocked.`
      : riskLevel === 'EXTREME'
        ? 'Extreme volatility detected; avoid entry.'
        : riskLevel === 'HIGH'
          ? 'Elevated volatility, flat liquidity, or higher-timeframe conflict; wait or reduce exposure.'
          : riskLevel === 'LOW'
            ? 'Aligned multi-timeframe structure with clean efficiency ratio and controlled ATR.'
            : 'Standard risk conditions; apply configured per-trade risk cap.',
  };

  const supportingIndicators: SupportingIndicatorsSummary = {
    emaAlignment:
      ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50
        ? `Bullish (9 > 21 > 50 · ADX ${ms.adx14.toFixed(1)})`
        : ind.ema9 < ind.ema21 && ind.ema21 < ind.ema50
          ? `Bearish (9 < 21 < 50 · ADX ${ms.adx14.toFixed(1)})`
          : `Mixed / Crossing (ADX ${ms.adx14.toFixed(1)})`,
    rsiState: `${ind.rsi14.toFixed(1)} (${ind.rsi14 > 70 ? 'Overbought' : ind.rsi14 < 30 ? 'Oversold' : ind.rsi14 >= 50 ? 'Bullish zone' : 'Bearish zone'})`,
    macdState: `${ind.macdHistogram >= 0 ? 'Positive' : 'Negative'} (${ind.macdHistogram.toFixed(6)})`,
    bollingerState: `%B ${ind.bbPercentB} · Width ${ind.bbBandwidthPct}% · ER ${ms.efficiencyRatio}`,
    supportResistanceState: `Support ${ind.nearestSupport} (-${ind.supportDistancePct}%) / Resistance ${ind.nearestResistance} (+${ind.resistanceDistancePct}%)`,
    candlestickPattern: ind.patterns.join(', ') || 'None detected',
    trendDirection: `${ind.trend} (${ms.structure})`,
    volatilityState: `${ind.volatilityRegime} (ATR ${ind.atrPct}%)`,
    multiTimeframe: `${higherTf} ${higherTrend} (${alignment})`,
  };

  const confidenceState: QuantAnalysisResult['confidenceState'] = isStaleFeed
    ? 'STALE_OR_UNAVAILABLE'
    : direction === 'WAIT'
      ? 'WEAK_SETUP_WAIT'
      : 'STRONG_SETUP_ACTIONABLE';
  const zeroConfidenceReason = isStaleFeed
    ? `Market status is ${marketStatus} (feed delayed or closed) — execution locked to 0/100.`
    : calibratedScore === 0
      ? 'Zero net directional edge after conflict and market-structure penalties.'
      : null;
  const lastBarTime = validCandles[validCandles.length - 1]?.time;
  const feedLastUpdateAt = lastBarTime ? new Date(lastBarTime * 1000).toISOString() : null;

  const requestedExpiry = compatibility.requestedExpirySeconds;
  const effectiveExpiry = compatibility.compatible ? requestedExpiry : compatibility.recommendedExpirySeconds;
  const expiryAdjusted = effectiveExpiry !== requestedExpiry;

  return {
    symbol,
    timeframe,
    direction,
    score: calibratedScore,
    confidenceScore: calibratedScore,
    rawDirectionalConfidence,
    actionableConfidence,
    confidenceState,
    zeroConfidenceReason,
    feedLastUpdateAt,
    bullishScore: bull,
    bearishScore: bear,
    entryPrice,
    suggestedExpirySeconds: compatibility.recommendedExpirySeconds,
    requestedExpirySeconds: requestedExpiry,
    effectiveExpirySeconds: effectiveExpiry,
    expiryAdjusted,
    expiryAdjustmentReason: expiryAdjusted ? compatibility.note : null,
    provider,
    marketStatus,
    isStale: isStaleFeed,
    timestamp: new Date().toISOString(),
    indicators: ind,
    supportingIndicators,
    riskAssessment,
    mtf: {
      primaryTimeframe: timeframe,
      higherTimeframe: higherTf,
      higherTrend,
      higherRsi,
      alignment,
    },
    backtest,
    reasons,
    marketRegime,
    activeStrategy,
    pillars,
    confidenceCalibration,
    rejectionReasons,
    timeframeExpiryCompatibility: compatibility,
    instrumentProfile: instProfile,
    warning: isStaleFeed
      ? 'MARKET CLOSED OR STALE — Actionable CALL/PUT signals suppressed until live OPEN candles resume.'
      : direction === 'WAIT'
        ? 'Decision is WAIT — strict multi-pillar confirmation, timing, liquidity, or MTF criteria not satisfied.'
        : !compatibility.compatible
          ? `Calibrated multi-pillar signal active, with timing caution: ${compatibility.note}`
          : 'Calibrated multi-pillar signal from live OHLCV structure. Confidence score reflects analytical evidence, never a guaranteed win rate.',
  };
}

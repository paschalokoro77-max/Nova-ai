import type { Candle, Timeframe, MarketStatus } from './marketData.ts';

export type StrategyProfile = 'conservative' | 'balanced' | 'momentum';

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
}

export interface QuantOptions {
  minScore?: number;
  requireMtfAlignment?: boolean;
  strategyProfile?: StrategyProfile;
  marketStatus?: MarketStatus;
  isStale?: boolean;
  higherTimeframeCandles?: { timeframe: Timeframe; candles: Candle[] } | null;
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
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

export function computeMacd(values: number[]): { line: number; signal: number; histogram: number; prevHistogram: number } {
  const ema12 = computeEmaSeries(values, 12);
  const ema26 = computeEmaSeries(values, 26);
  const macdLine = ema12.map((v, idx) => v - ema26[idx]);
  const signalLine = computeEmaSeries(macdLine, 9);
  const last = macdLine.length - 1;
  const prev = Math.max(0, last - 1);
  return {
    line: macdLine[last],
    signal: signalLine[last],
    histogram: macdLine[last] - signalLine[last],
    prevHistogram: macdLine[prev] - signalLine[prev],
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
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  const std = Math.sqrt(variance);
  const upper = mean + mult * std;
  const lower = mean - mult * std;
  const last = values[values.length - 1];
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

export function detectSupportResistance(candles: Candle[]): { support: number; resistance: number } {
  const lookback = candles.slice(-80);
  const lastClose = lookback[lookback.length - 1].close;
  const pivotLows: number[] = [];
  const pivotHighs: number[] = [];

  for (let i = 2; i < lookback.length - 2; i++) {
    const c = lookback[i];
    if (c.low <= lookback[i - 1].low && c.low <= lookback[i - 2].low && c.low <= lookback[i + 1].low && c.low <= lookback[i + 2].low) {
      pivotLows.push(c.low);
    }
    if (c.high >= lookback[i - 1].high && c.high >= lookback[i - 2].high && c.high >= lookback[i + 1].high && c.high >= lookback[i + 2].high) {
      pivotHighs.push(c.high);
    }
  }

  const below = pivotLows.filter((p) => p <= lastClose);
  const above = pivotHighs.filter((p) => p >= lastClose);
  const support = below.length > 0 ? Math.max(...below) : Math.min(...lookback.map((c) => c.low));
  const resistance = above.length > 0 ? Math.min(...above) : Math.max(...lookback.map((c) => c.high));
  return { support, resistance };
}

export function detectCandlestickPatterns(candles: Candle[]): { patterns: string[]; bias: number; summary: string } {
  if (candles.length < 3) return { patterns: [], bias: 0, summary: 'Insufficient bars for pattern detection.' };
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

  if (body0 / range0 <= 0.14) {
    patterns.push('Doji Indecision');
  }

  if (c1.close < c1.open && c0.close > c0.open && c0.open <= c1.close && c0.close >= c1.open && body0 > body1) {
    patterns.push('Bullish Engulfing');
    bias += 12;
  } else if (c1.close > c1.open && c0.close < c0.open && c0.open >= c1.close && c0.close <= c1.open && body0 > body1) {
    patterns.push('Bearish Engulfing');
    bias -= 12;
  }

  if (lowerWick0 > body0 * 2.1 && upperWick0 < body0 * 0.6 && body0 > 0) {
    patterns.push('Bullish Hammer Pin Bar');
    bias += 9;
  } else if (upperWick0 > body0 * 2.1 && lowerWick0 < body0 * 0.6 && body0 > 0) {
    patterns.push('Bearish Shooting Star');
    bias -= 9;
  }

  if (c2.close < c2.open && Math.abs(c1.close - c1.open) < Math.abs(c2.close - c2.open) * 0.4 && c0.close > c0.open && c0.close > (c2.open + c2.close) / 2) {
    patterns.push('Morning Star Reversal');
    bias += 11;
  } else if (c2.close > c2.open && Math.abs(c1.close - c1.open) < Math.abs(c2.close - c2.open) * 0.4 && c0.close < c0.open && c0.close < (c2.open + c2.close) / 2) {
    patterns.push('Evening Star Reversal');
    bias -= 11;
  }

  if (body0 / range0 >= 0.78) {
    if (c0.close > c0.open) {
      patterns.push('Bullish Momentum Bar');
      bias += 6;
    } else {
      patterns.push('Bearish Momentum Bar');
      bias -= 6;
    }
  }

  const bodyRatio = Math.round((body0 / range0) * 100);
  const candleDir = c0.close >= c0.open ? 'bullish' : 'bearish';
  const summary =
    patterns.length > 0
      ? `Latest ${candleDir} bar (${bodyRatio}% body) formed ${patterns.join(', ')}.`
      : `Latest ${candleDir} bar shows ${bodyRatio}% body-to-range without reversal pattern.`;

  return { patterns, bias, summary };
}

export function detectTrend(candles: Candle[], ema9: number, ema21: number, ema50: number): 'UPTREND' | 'DOWNTREND' | 'RANGING' {
  const recent = candles.slice(-12);
  const firstHalfHigh = Math.max(...recent.slice(0, 6).map((c) => c.high));
  const secondHalfHigh = Math.max(...recent.slice(6).map((c) => c.high));
  const firstHalfLow = Math.min(...recent.slice(0, 6).map((c) => c.low));
  const secondHalfLow = Math.min(...recent.slice(6).map((c) => c.low));

  if (ema9 > ema21 && ema21 > ema50 && (secondHalfHigh >= firstHalfHigh || secondHalfLow > firstHalfLow)) {
    return 'UPTREND';
  }
  if (ema9 < ema21 && ema21 < ema50 && (secondHalfLow <= firstHalfLow || secondHalfHigh < firstHalfHigh)) {
    return 'DOWNTREND';
  }
  return 'RANGING';
}

export function getHigherTimeframe(tf: Timeframe): Timeframe {
  if (tf === '1m') return '5m';
  if (tf === '5m') return '15m';
  return '1h';
}

function getSuggestedExpirySeconds(tf: Timeframe, volatility: IndicatorSnapshot['volatilityRegime'] | null): number {
  const base = tf === '1m' ? 180 : tf === '5m' ? 900 : tf === '15m' ? 1800 : 3600;
  if (volatility === 'HIGH') return Math.min(3600, Math.round(base * 1.33));
  return base;
}

function evaluateCore(candles: Candle[], profile: StrategyProfile): {
  bullScore: number;
  bearScore: number;
  indicators: IndicatorSnapshot;
  reasonsBull: string[];
  reasonsBear: string[];
} {
  const closes = candles.map((c) => c.close);
  const ema9Arr = computeEmaSeries(closes, 9);
  const ema21Arr = computeEmaSeries(closes, 21);
  const ema50Arr = computeEmaSeries(closes, Math.min(50, closes.length));
  const ema200Arr = closes.length >= 120 ? computeEmaSeries(closes, Math.min(200, closes.length)) : null;

  const ema9 = ema9Arr[ema9Arr.length - 1];
  const ema21 = ema21Arr[ema21Arr.length - 1];
  const ema50 = ema50Arr[ema50Arr.length - 1];
  const ema200 = ema200Arr ? ema200Arr[ema200Arr.length - 1] : null;
  const prevEma9 = ema9Arr[Math.max(0, ema9Arr.length - 2)];
  const prevEma21 = ema21Arr[Math.max(0, ema21Arr.length - 2)];

  const rsi14 = computeRsi(closes, 14);
  const macd = computeMacd(closes);
  const bb = computeBollinger(candles.map((c) => c.close), 20, 2);
  const atr14 = computeAtr(candles, 14);
  const lastClose = closes[closes.length - 1];
  const atrPct = lastClose > 0 ? (atr14 / lastClose) * 100 : 0;
  const sr = detectSupportResistance(candles);
  const supportDistancePct = lastClose > 0 ? ((lastClose - sr.support) / lastClose) * 100 : 0;
  const resistanceDistancePct = lastClose > 0 ? ((sr.resistance - lastClose) / lastClose) * 100 : 0;
  const trend = detectTrend(candles, ema9, ema21, ema50);
  const patternInfo = detectCandlestickPatterns(candles);

  let volatilityRegime: IndicatorSnapshot['volatilityRegime'] = 'NORMAL';
  if (bb.bandwidthPct < 0.04 && atrPct < 0.025) volatilityRegime = 'LOW';
  else if (atrPct > 0.65 || bb.bandwidthPct > 2.2) volatilityRegime = 'EXTREME';
  else if (atrPct > 0.28 || bb.bandwidthPct > 0.9) volatilityRegime = 'HIGH';

  let bullScore = 0;
  let bearScore = 0;
  const reasonsBull: string[] = [];
  const reasonsBear: string[] = [];

  if (ema9 > ema21 && ema21 > ema50) {
    bullScore += profile === 'momentum' ? 28 : 24;
    reasonsBull.push('EMA 9 > EMA 21 > EMA 50 stacked bullish trend.');
  } else if (ema9 < ema21 && ema21 < ema50) {
    bearScore += profile === 'momentum' ? 28 : 24;
    reasonsBear.push('EMA 9 < EMA 21 < EMA 50 stacked bearish trend.');
  } else if (ema9 > ema21) {
    bullScore += 14;
    reasonsBull.push('EMA 9 above EMA 21 short-term lift.');
  } else if (ema9 < ema21) {
    bearScore += 14;
    reasonsBear.push('EMA 9 below EMA 21 short-term drift.');
  }

  if (prevEma9 <= prevEma21 && ema9 > ema21) {
    bullScore += 8;
    reasonsBull.push('Fresh EMA 9/21 bullish crossover.');
  } else if (prevEma9 >= prevEma21 && ema9 < ema21) {
    bearScore += 8;
    reasonsBear.push('Fresh EMA 9/21 bearish crossover.');
  }

  if (macd.line > macd.signal && macd.histogram > 0) {
    bullScore += macd.histogram > macd.prevHistogram ? 22 : 16;
    reasonsBull.push(
      macd.histogram > macd.prevHistogram
        ? 'MACD above signal with expanding positive histogram.'
        : 'MACD above signal line.'
    );
  } else if (macd.line < macd.signal && macd.histogram < 0) {
    bearScore += macd.histogram < macd.prevHistogram ? 22 : 16;
    reasonsBear.push(
      macd.histogram < macd.prevHistogram
        ? 'MACD below signal with expanding negative histogram.'
        : 'MACD below signal line.'
    );
  }

  if (rsi14 >= 52 && rsi14 <= 69) {
    bullScore += 18;
    reasonsBull.push(`RSI(14) at ${rsi14.toFixed(1)} shows healthy bullish momentum.`);
  } else if (rsi14 <= 48 && rsi14 >= 31) {
    bearScore += 18;
    reasonsBear.push(`RSI(14) at ${rsi14.toFixed(1)} shows healthy bearish momentum.`);
  } else if (rsi14 < 30) {
    if (profile === 'conservative') {
      bullScore += 16;
      reasonsBull.push(`RSI(14) oversold (${rsi14.toFixed(1)}) near mean-reversion zone.`);
    } else {
      bullScore += 10;
    }
  } else if (rsi14 > 70) {
    if (profile === 'conservative') {
      bearScore += 16;
      reasonsBear.push(`RSI(14) overbought (${rsi14.toFixed(1)}) near exhaustion zone.`);
    } else {
      bearScore += 10;
    }
  }

  if (bb.percentB >= 0.45 && bb.percentB <= 0.88 && lastClose > bb.middle) {
    bullScore += 12;
    reasonsBull.push('Price holding in upper Bollinger expansion corridor.');
  } else if (bb.percentB <= 0.55 && bb.percentB >= 0.12 && lastClose < bb.middle) {
    bearScore += 12;
    reasonsBear.push('Price holding in lower Bollinger expansion corridor.');
  } else if (bb.percentB < 0.08) {
    bullScore += 10;
    reasonsBull.push('Price stretched at lower Bollinger Band.');
  } else if (bb.percentB > 0.92) {
    bearScore += 10;
    reasonsBear.push('Price stretched at upper Bollinger Band.');
  }

  if (supportDistancePct <= 0.12 && resistanceDistancePct > 0.15) {
    bullScore += 10;
    reasonsBull.push('Price rebounding near detected support pivot.');
  } else if (resistanceDistancePct <= 0.12 && supportDistancePct > 0.15) {
    bearScore += 10;
    reasonsBear.push('Price testing detected resistance pivot.');
  }

  if (patternInfo.bias > 0) {
    bullScore += Math.min(15, patternInfo.bias);
    reasonsBull.push(patternInfo.summary);
  } else if (patternInfo.bias < 0) {
    bearScore += Math.min(15, Math.abs(patternInfo.bias));
    reasonsBear.push(patternInfo.summary);
  }

  return {
    bullScore: Math.min(100, bullScore),
    bearScore: Math.min(100, bearScore),
    reasonsBull,
    reasonsBear,
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
    },
  };
}

function runEmpiricalBacktest(
  candles: Candle[],
  minScore: number,
  profile: StrategyProfile,
  horizonBars = 3
): BacktestSampleStats {
  if (candles.length < 65) {
    return {
      sampleSize: 0,
      wins: 0,
      losses: 0,
      winRatePct: null,
      expectancyPerUnit: null,
      horizonBars,
      note: 'Insufficient candle history for walk-forward replay (need >= 65 bars).',
    };
  }

  let wins = 0;
  let losses = 0;
  const payout = 0.8;

  for (let i = 45; i < candles.length - horizonBars; i += 2) {
    const window = candles.slice(0, i + 1);
    const evaluated = evaluateCore(window, profile);
    const diff = evaluated.bullScore - evaluated.bearScore;
    let sig: 'CALL' | 'PUT' | 'WAIT' = 'WAIT';
    if (diff >= 16 && evaluated.bullScore >= minScore) sig = 'CALL';
    else if (-diff >= 16 && evaluated.bearScore >= minScore) sig = 'PUT';
    if (sig === 'WAIT') continue;

    const entry = candles[i].close;
    const exit = candles[i + horizonBars].close;
    if (exit === entry) continue;
    const won = (sig === 'CALL' && exit > entry) || (sig === 'PUT' && exit < entry);
    if (won) wins++;
    else losses++;
  }

  const sampleSize = wins + losses;
  if (sampleSize === 0) {
    return {
      sampleSize: 0,
      wins: 0,
      losses: 0,
      winRatePct: null,
      expectancyPerUnit: null,
      horizonBars,
      note: `No historical setups met the ${minScore}/100 threshold across ${candles.length} bars.`,
    };
  }

  const winRate = (wins / sampleSize) * 100;
  const expectancy = (wins * payout - losses * 1) / sampleSize;
  return {
    sampleSize,
    wins,
    losses,
    winRatePct: Number(winRate.toFixed(1)),
    expectancyPerUnit: Number(expectancy.toFixed(3)),
    horizonBars,
    note: `Walk-forward check on ${candles.length} live-fetched bars (${horizonBars}-bar horizon, 80% payout assumption). Past sample is not a guarantee of future returns.`,
  };
}

export function analyzeMarketQuant(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  provider: string,
  options: QuantOptions = {}
): QuantAnalysisResult {
  const minScore = options.minScore ?? 65;
  const requireMtf = options.requireMtfAlignment ?? true;
  const profile: StrategyProfile = options.strategyProfile ?? 'balanced';
  const marketStatus = options.marketStatus ?? 'OPEN';
  const isStaleFeed = Boolean(options.isStale) || marketStatus !== 'OPEN';
  const higherTf = getHigherTimeframe(timeframe);

  if (!candles || candles.length < 35) {
    const lastBarTime = candles?.[candles.length - 1]?.time;
    const feedLastUpdateAt = lastBarTime ? new Date(lastBarTime * 1000).toISOString() : null;
    return {
      symbol,
      timeframe,
      direction: 'WAIT',
      score: 0,
      confidenceScore: 0,
      rawDirectionalConfidence: 0,
      actionableConfidence: 0,
      confidenceState: 'STALE_OR_UNAVAILABLE',
      zeroConfidenceReason: 'Market data unavailable or insufficient bars (minimum 35 required).',
      feedLastUpdateAt,
      bullishScore: 0,
      bearishScore: 0,
      entryPrice: candles?.[candles.length - 1]?.close ?? null,
      suggestedExpirySeconds: getSuggestedExpirySeconds(timeframe, null),
      provider,
      marketStatus: marketStatus === 'OPEN' ? 'UNAVAILABLE' : marketStatus,
      isStale: true,
      timestamp: new Date().toISOString(),
      indicators: null,
      supportingIndicators: null,
      riskAssessment: {
        level: 'EXTREME',
        volatilityRegime: 'UNKNOWN',
        atrPct: null,
        suggestedStakePct: 0,
        summary: 'Market data unavailable or insufficient bars — holding WAIT.',
      },
      mtf: null,
      backtest: {
        sampleSize: 0,
        wins: 0,
        losses: 0,
        winRatePct: null,
        expectancyPerUnit: null,
        horizonBars: 3,
        note: 'Insufficient verified candles (minimum 35 bars required).',
      },
      reasons: ['No verified candle stream sufficient for quantitative calculation.'],
      warning: 'MARKET DATA UNAVAILABLE — Decision locked to WAIT.',
    };
  }

  const core = evaluateCore(candles, profile);
  let bull = core.bullScore;
  let bear = core.bearScore;

  let higherTrend: MultiTimeframeSummary['higherTrend'] = 'UNAVAILABLE';
  let higherRsi: number | null = null;
  let alignment: MultiTimeframeSummary['alignment'] = 'NEUTRAL';

  if (options.higherTimeframeCandles && options.higherTimeframeCandles.candles.length >= 35) {
    const htfCore = evaluateCore(options.higherTimeframeCandles.candles, profile);
    higherTrend = htfCore.indicators.trend;
    higherRsi = htfCore.indicators.rsi14;
    if (higherTrend === 'UPTREND' && bull > bear) {
      alignment = 'ALIGNED_BULLISH';
      bull = Math.min(100, bull + 10);
    } else if (higherTrend === 'DOWNTREND' && bear > bull) {
      alignment = 'ALIGNED_BEARISH';
      bear = Math.min(100, bear + 10);
    } else if (
      (higherTrend === 'UPTREND' && bear > bull) ||
      (higherTrend === 'DOWNTREND' && bull > bear)
    ) {
      alignment = 'CONFLICT';
    }
  }

  const net = bull - bear;
  let direction: 'CALL' | 'PUT' | 'WAIT' = 'WAIT';
  const dominantScore = Math.max(bull, bear);
  const reasons: string[] = [];

  if (core.indicators.volatilityRegime === 'EXTREME') {
    reasons.push(`Volatility regime is EXTREME (ATR ${core.indicators.atrPct.toFixed(3)}%) — signal suppressed for capital protection.`);
  } else if (net >= 16 && bull >= minScore) {
    if (requireMtf && alignment === 'CONFLICT') {
      reasons.push(`Primary ${timeframe} leans bullish (${bull}/100) but higher timeframe (${higherTf}) is in DOWNTREND — MTF filter holds WAIT.`);
    } else {
      direction = 'CALL';
      reasons.push(...core.reasonsBull);
      if (alignment === 'ALIGNED_BULLISH') reasons.push(`Higher timeframe (${higherTf}) confirms UPTREND.`);
    }
  } else if (-net >= 16 && bear >= minScore) {
    if (requireMtf && alignment === 'CONFLICT') {
      reasons.push(`Primary ${timeframe} leans bearish (${bear}/100) but higher timeframe (${higherTf}) is in UPTREND — MTF filter holds WAIT.`);
    } else {
      direction = 'PUT';
      reasons.push(...core.reasonsBear);
      if (alignment === 'ALIGNED_BEARISH') reasons.push(`Higher timeframe (${higherTf}) confirms DOWNTREND.`);
    }
  } else {
    reasons.push(
      `Confluence below threshold (Bull ${bull}/100 vs Bear ${bear}/100; required >= ${minScore} with >= 16 pt margin).`
    );
    if (core.reasonsBull[0]) reasons.push(`Bullish factor: ${core.reasonsBull[0]}`);
    if (core.reasonsBear[0]) reasons.push(`Bearish factor: ${core.reasonsBear[0]}`);
  }

  if (isStaleFeed) {
    direction = 'WAIT';
    reasons.unshift(
      `Market status is ${marketStatus} (candle feed is stale or market closed) — actionable CALL/PUT signals are suppressed to WAIT.`
    );
  }

  const backtest = runEmpiricalBacktest(candles, minScore, profile, 3);
  const entryPrice = candles[candles.length - 1].close;
  const ind = core.indicators;
  const effectiveScore = isStaleFeed ? 0 : dominantScore;

  const riskLevel: RiskAssessment['level'] =
    isStaleFeed || ind.volatilityRegime === 'EXTREME'
      ? 'EXTREME'
      : ind.volatilityRegime === 'HIGH' || alignment === 'CONFLICT'
        ? 'HIGH'
        : direction === 'WAIT'
          ? 'MODERATE'
          : effectiveScore >= 80 && (alignment === 'ALIGNED_BULLISH' || alignment === 'ALIGNED_BEARISH')
            ? 'LOW'
            : 'MODERATE';

  const suggestedStakePct =
    isStaleFeed ? 0 : riskLevel === 'LOW' ? 1.0 : riskLevel === 'MODERATE' ? 0.75 : riskLevel === 'HIGH' ? 0.4 : 0;

  const riskAssessment: RiskAssessment = {
    level: riskLevel,
    volatilityRegime: ind.volatilityRegime,
    atrPct: ind.atrPct,
    suggestedStakePct,
    summary: isStaleFeed
      ? 'Market closed or stale feed; actionable entries blocked until live OPEN bars resume.'
      : riskLevel === 'EXTREME'
        ? 'Extreme volatility detected; avoid entry.'
        : riskLevel === 'HIGH'
          ? 'Elevated volatility or higher-timeframe conflict; reduce size or wait.'
          : riskLevel === 'LOW'
            ? 'Aligned multi-timeframe structure with controlled ATR.'
            : 'Standard risk conditions; apply configured per-trade cap.',
  };

  const supportingIndicators: SupportingIndicatorsSummary = {
    emaAlignment:
      ind.ema9 > ind.ema21 && ind.ema21 > ind.ema50
        ? 'Bullish (9 > 21 > 50)'
        : ind.ema9 < ind.ema21 && ind.ema21 < ind.ema50
          ? 'Bearish (9 < 21 < 50)'
          : 'Mixed / Crossing',
    rsiState: `${ind.rsi14.toFixed(1)} (${ind.rsi14 > 70 ? 'Overbought' : ind.rsi14 < 30 ? 'Oversold' : ind.rsi14 >= 50 ? 'Bullish zone' : 'Bearish zone'})`,
    macdState: `${ind.macdHistogram >= 0 ? 'Positive' : 'Negative'} (${ind.macdHistogram.toFixed(6)})`,
    bollingerState: `%B ${ind.bbPercentB} · Width ${ind.bbBandwidthPct}%`,
    supportResistanceState: `Support ${ind.nearestSupport} (-${ind.supportDistancePct}%) / Resistance ${ind.nearestResistance} (+${ind.resistanceDistancePct}%)`,
    candlestickPattern: ind.patterns.join(', ') || 'None detected',
    trendDirection: ind.trend,
    volatilityState: `${ind.volatilityRegime} (ATR ${ind.atrPct}%)`,
    multiTimeframe: `${higherTf} ${higherTrend} (${alignment})`,
  };

  const rawDirectionalConfidence = Math.max(bull, bear);
  const actionableConfidence = effectiveScore;
  const confidenceState: QuantAnalysisResult['confidenceState'] = isStaleFeed
    ? 'STALE_OR_UNAVAILABLE'
    : direction === 'WAIT'
      ? 'WEAK_SETUP_WAIT'
      : 'STRONG_SETUP_ACTIONABLE';
  const zeroConfidenceReason = actionableConfidence === 0
    ? (reasons[0] || (isStaleFeed ? 'Market closed or stale feed' : 'Confluence below threshold'))
    : null;
  const lastBarTime = candles[candles.length - 1]?.time;
  const feedLastUpdateAt = lastBarTime ? new Date(lastBarTime * 1000).toISOString() : null;

  return {
    symbol,
    timeframe,
    direction,
    score: effectiveScore,
    confidenceScore: effectiveScore,
    rawDirectionalConfidence,
    actionableConfidence,
    confidenceState,
    zeroConfidenceReason,
    feedLastUpdateAt,
    bullishScore: bull,
    bearishScore: bear,
    entryPrice,
    suggestedExpirySeconds: getSuggestedExpirySeconds(timeframe, ind.volatilityRegime),
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
    warning: isStaleFeed
      ? 'MARKET CLOSED OR STALE — Actionable CALL/PUT signals suppressed until live OPEN candles resume.'
      : direction === 'WAIT'
        ? 'Decision is WAIT — quantitative criteria or MTF alignment not satisfied.'
        : 'Quantitative signal generated from live OHLCV indicators. Confidence score reflects indicator confluence, not guaranteed accuracy.',
  };
}

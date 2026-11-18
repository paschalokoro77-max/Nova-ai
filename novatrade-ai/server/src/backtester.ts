import { fetchMarketCandles, type Candle, type Timeframe } from './marketData.ts';
import {
  analyzeMarketQuant,
  computeAdx,
  computeAtr,
  computeEfficiencyRatio,
  evaluateLegacyQuant,
  getHigherTimeframe,
  type StrategyProfile,
} from './quantEngine.ts';

export type MarketRegimeLabel = 'TRENDING' | 'RANGING' | 'VOLATILE' | 'REVERSING';

export interface SimulatedTradeOutcome {
  symbol: string;
  timeframe: Timeframe;
  direction: 'CALL' | 'PUT';
  score: number;
  regime: MarketRegimeLabel;
  strategy: string;
  entryPrice: number;
  exitPrice: number;
  won: boolean;
  pnl: number;
  isOutOfSample: boolean;
  timestamp: number;
}

export interface BacktestMetricsSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  maxDrawdown: number;
  expectancyPerTrade: number;
}

export interface SampleSizeWarning {
  scope: 'OVERALL_OOS' | 'INSTRUMENT_OOS' | 'TIMEFRAME_OOS' | 'STRATEGY_OOS';
  key: string;
  trades: number;
  note: string;
}

export interface ComparativeBacktestReport {
  generatedAt: string;
  datasetsLoaded: Array<{ symbol: string; timeframe: Timeframe; bars: number; htfBars: number; provider: string }>;
  datasetsFailed: Array<{ symbol: string; timeframe: Timeframe; error: string }>;
  assumptions: {
    stakePerTrade: number;
    payoutRate: number;
    horizonBars: number;
    executionDelayBars: number;
    fxSpreadAndSlippageBps: number;
    cryptoSpreadAndSlippageBps: number;
    flatPriceCountsAsLoss: boolean;
    outOfSampleSplitPct: number;
    strictCausalClosedHtfBars: boolean;
    strictNonOverlappingIsOosBoundary: boolean;
    reproducibilityNote: string;
  };
  sampleSizeDisclosure: {
    minimumRecommendedTradesPerBucket: number;
    totalOosTrades: number;
    fxOosTrades: number;
    cryptoOosTrades: number;
    smallSampleWarnings: SampleSizeWarning[];
    summary: string;
  };
  original: {
    all: BacktestMetricsSummary;
    inSample: BacktestMetricsSummary;
    outOfSample: BacktestMetricsSummary;
    byInstrument: Record<string, BacktestMetricsSummary>;
    byTimeframe: Record<string, BacktestMetricsSummary>;
    byStrategy: Record<string, BacktestMetricsSummary>;
    byRegime: Record<MarketRegimeLabel, BacktestMetricsSummary>;
  };
  improved: {
    all: BacktestMetricsSummary;
    inSample: BacktestMetricsSummary;
    outOfSample: BacktestMetricsSummary;
    byInstrument: Record<string, BacktestMetricsSummary>;
    byTimeframe: Record<string, BacktestMetricsSummary>;
    byStrategy: Record<string, BacktestMetricsSummary>;
    byRegime: Record<MarketRegimeLabel, BacktestMetricsSummary>;
  };
  deltaOutOfSample: {
    winRateDeltaPct: number | null;
    netPnlDelta: number;
    tradeReductionPct: number | null;
    maxDrawdownReduction: number;
  };
}

function summarizeOutcomes(outcomes: SimulatedTradeOutcome[]): BacktestMetricsSummary {
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let running = 0;
  let peak = 0;
  let maxDd = 0;

  const sorted = [...outcomes].sort(
    (a, b) => a.timestamp - b.timestamp || a.symbol.localeCompare(b.symbol) || a.timeframe.localeCompare(b.timeframe)
  );
  for (const t of sorted) {
    if (t.won) {
      wins += 1;
      grossProfit += t.pnl;
    } else {
      losses += 1;
      grossLoss += Math.abs(t.pnl);
    }
    running += t.pnl;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDd) maxDd = dd;
  }

  const total = wins + losses;
  return {
    totalTrades: total,
    wins,
    losses,
    winRatePct: total > 0 ? Number(((wins / total) * 100).toFixed(2)) : null,
    netPnl: Number((grossProfit - grossLoss).toFixed(2)),
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 999 : null,
    maxDrawdown: Number(maxDd.toFixed(2)),
    expectancyPerTrade: total > 0 ? Number(((grossProfit - grossLoss) / total).toFixed(2)) : 0,
  };
}

function classifyRegime(window: Candle[], symbol: string, timeframe: Timeframe): MarketRegimeLabel {
  const closes = window.map((c) => c.close);
  const atr = computeAtr(window, 14);
  const lastClose = closes[closes.length - 1];
  const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : 0;
  const isCrypto = /BTC|ETH|SOL/i.test(symbol);
  const tfMult = timeframe === '1m' ? 1.0 : timeframe === '5m' ? 1.6 : timeframe === '15m' ? 2.4 : 3.8;
  const highVolThresh = 0.28 * tfMult * (isCrypto ? 2.8 : 1.0);
  if (atrPct > highVolThresh) return 'VOLATILE';

  const adx = computeAdx(window, 14).adx;
  const er = computeEfficiencyRatio(closes, 12);
  if (adx >= 18 && er >= 0.25) return 'TRENDING';
  return 'RANGING';
}

function tfToSeconds(tf: Timeframe): number {
  if (tf === '1m') return 60;
  if (tf === '5m') return 300;
  if (tf === '15m') return 900;
  return 3600;
}

function sliceHigherTimeframeClosedBy(
  htfCandles: Candle[],
  primaryBarOpenSec: number,
  primaryTf: Timeframe,
  higherTf: Timeframe
): Candle[] {
  // Strictly causal bar-close cutoff: only expose HTF bars whose closing timestamp (open + htfDur)
  // is <= primary decision bar's closing timestamp (open + primaryDur), preventing intra-bar HTF look-ahead.
  const cutoffCloseSec = primaryBarOpenSec + tfToSeconds(primaryTf);
  const htfDurSec = tfToSeconds(higherTf);
  const out: Candle[] = [];
  for (const c of htfCandles) {
    if (c.time + htfDurSec <= cutoffCloseSec) out.push(c);
    else break;
  }
  return out;
}

export async function runComparativeWalkForwardBacktest(options?: {
  symbols?: string[];
  timeframes?: Timeframe[];
  profile?: StrategyProfile;
  improvedMinScore?: number;
  legacyMinScore?: number;
  horizonBars?: number;
  stakePerTrade?: number;
  candleLimit?: number;
  requestedExpirySeconds?: number;
}): Promise<ComparativeBacktestReport> {
  const symbols = options?.symbols ?? ['EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD', 'ETHUSD', 'SOLUSD'];
  const timeframes = options?.timeframes ?? ['1m', '5m', '15m', '1h'];
  const profile: StrategyProfile = options?.profile ?? 'balanced';
  const improvedMinScore = options?.improvedMinScore ?? 72;
  const legacyMinScore = options?.legacyMinScore ?? 65;
  const horizonBars = options?.horizonBars ?? 3;
  const stake = options?.stakePerTrade ?? 100;
  const candleLimit = Math.max(200, Math.min(2000, options?.candleLimit ?? 1000));
  const payoutRate = 0.8;
  const fxCostBps = 1.5; // 1.2 bps spread + 0.3 bps slippage
  const cryptoCostBps = 5.0; // 4.0 bps spread + 1.0 bps slippage

  const datasetsLoaded: ComparativeBacktestReport['datasetsLoaded'] = [];
  const datasetsFailed: ComparativeBacktestReport['datasetsFailed'] = [];
  const origOutcomes: SimulatedTradeOutcome[] = [];
  const impOutcomes: SimulatedTradeOutcome[] = [];

  // Cache by symbol + timeframe + limit so a smaller HTF fetch never truncates a larger primary fetch
  const candleCache = new Map<string, { ok: boolean; candles: Candle[]; provider: string; error?: string }>();
  const loadSeries = async (sym: string, tf: Timeframe, limit: number) => {
    const key = `${sym}:${tf}:${limit}`;
    if (candleCache.has(key)) return candleCache.get(key)!;
    const res = await fetchMarketCandles(sym, tf, limit, true);
    const entry = { ok: res.ok, candles: res.candles, provider: res.provider, error: res.error };
    candleCache.set(key, entry);
    return entry;
  };

  for (const symbol of symbols) {
    const isCrypto = /BTC|ETH|SOL/i.test(symbol);
    const totalCostBps = isCrypto ? cryptoCostBps : fxCostBps;

    for (const tf of timeframes) {
      const htf = getHigherTimeframe(tf);
      const primary = await loadSeries(symbol, tf, candleLimit);
      const higher = await loadSeries(symbol, htf, Math.min(candleLimit, 720));

      if (!primary.ok || primary.candles.length < 110) {
        datasetsFailed.push({
          symbol,
          timeframe: tf,
          error: primary.error || `Insufficient bars (${primary.candles.length})`,
        });
        continue;
      }

      datasetsLoaded.push({
        symbol,
        timeframe: tf,
        bars: primary.candles.length,
        htfBars: higher.ok ? higher.candles.length : 0,
        provider: primary.provider,
      });

      const bars = primary.candles;
      const startIdx = 60;
      const endIdx = bars.length - horizonBars - 2;
      const splitIdx = startIdx + Math.floor((endIdx - startIdx) * 0.5);

      let lastOrigTradeIdx = -999;
      let lastImpTradeIdx = -999;

      for (let i = startIdx; i <= endIdx; i++) {
        const isOos = i >= splitIdx;
        // Strict IS/OOS separation: in-sample trades must settle strictly prior to splitIdx
        if (!isOos && i + 1 + horizonBars >= splitIdx) continue;

        const window = bars.slice(0, i + 1);
        const htfSlice = higher.ok ? sliceHigherTimeframeClosedBy(higher.candles, bars[i].time, tf, htf) : [];
        const regime = classifyRegime(window, symbol, tf);

        // Realistic 1-bar delayed entry at bar i+1 open with half-spread + slippage
        const rawEntry = bars[i + 1].open;
        const exitPrice = bars[i + 1 + horizonBars].close;
        const costOffset = rawEntry * (totalCostBps / 20000);

        // 1. Original Legacy Engine (prevent overlapping trade on same instrument while horizon active)
        if (i - lastOrigTradeIdx >= horizonBars + 1) {
          const leg = evaluateLegacyQuant(window, legacyMinScore, profile, htfSlice.length >= 35 ? htfSlice : null);
          if (leg.direction === 'CALL' || leg.direction === 'PUT') {
            const effEntry = leg.direction === 'CALL' ? rawEntry + costOffset : rawEntry - costOffset;
            const won =
              (leg.direction === 'CALL' && exitPrice > effEntry) ||
              (leg.direction === 'PUT' && exitPrice < effEntry);
            origOutcomes.push({
              symbol,
              timeframe: tf,
              direction: leg.direction,
              score: leg.score,
              regime,
              strategy: 'LEGACY_ADDITIVE',
              entryPrice: effEntry,
              exitPrice,
              won,
              pnl: won ? stake * payoutRate : -stake,
              isOutOfSample: isOos,
              timestamp: bars[i].time,
            });
            lastOrigTradeIdx = i;
          }
        }

        // 2. Improved Adaptive Multi-Regime Engine
        if (i - lastImpTradeIdx >= horizonBars + 1) {
          const imp = analyzeMarketQuant(symbol, tf, window, primary.provider, {
            minScore: improvedMinScore,
            requireMtfAlignment: true,
            strategyProfile: profile,
            marketStatus: 'LIVE',
            isStale: false,
            higherTimeframeCandles: htfSlice.length >= 35 ? { timeframe: htf, candles: htfSlice } : null,
            skipEmpiricalBacktest: true,
            ...(options?.requestedExpirySeconds != null ? { requestedExpirySeconds: options.requestedExpirySeconds } : {}),
          });
          if (imp.direction === 'CALL' || imp.direction === 'PUT') {
            const effEntry = imp.direction === 'CALL' ? rawEntry + costOffset : rawEntry - costOffset;
            const won =
              (imp.direction === 'CALL' && exitPrice > effEntry) ||
              (imp.direction === 'PUT' && exitPrice < effEntry);
            impOutcomes.push({
              symbol,
              timeframe: tf,
              direction: imp.direction,
              score: imp.score,
              regime: (imp.marketRegime as MarketRegimeLabel) || regime,
              strategy: imp.activeStrategy || 'TREND_CONTINUATION',
              entryPrice: effEntry,
              exitPrice,
              won,
              pnl: won ? stake * payoutRate : -stake,
              isOutOfSample: isOos,
              timestamp: bars[i].time,
            });
            lastImpTradeIdx = i;
          }
        }
      }
    }
  }

  const groupSummaries = <K extends string>(list: SimulatedTradeOutcome[], keyFn: (t: SimulatedTradeOutcome) => K) => {
    const map = new Map<K, SimulatedTradeOutcome[]>();
    for (const t of list) {
      const k = keyFn(t);
      const arr = map.get(k) || [];
      arr.push(t);
      map.set(k, arr);
    }
    const result = {} as Record<K, BacktestMetricsSummary>;
    for (const [k, arr] of map.entries()) {
      result[k] = summarizeOutcomes(arr);
    }
    return result;
  };

  const buildBlock = (list: SimulatedTradeOutcome[]) => {
    const oos = list.filter((t) => t.isOutOfSample);
    const ins = list.filter((t) => !t.isOutOfSample);
    const byRegimeRaw = groupSummaries<MarketRegimeLabel>(oos, (t) => t.regime);
    return {
      all: summarizeOutcomes(list),
      inSample: summarizeOutcomes(ins),
      outOfSample: summarizeOutcomes(oos),
      byInstrument: groupSummaries(oos, (t) => t.symbol),
      byTimeframe: groupSummaries(oos, (t) => t.timeframe),
      byStrategy: groupSummaries(oos, (t) => t.strategy),
      byRegime: {
        TRENDING: byRegimeRaw.TRENDING || summarizeOutcomes([]),
        RANGING: byRegimeRaw.RANGING || summarizeOutcomes([]),
        VOLATILE: byRegimeRaw.VOLATILE || summarizeOutcomes([]),
        REVERSING: byRegimeRaw.REVERSING || summarizeOutcomes([]),
      },
    };
  };

  const original = buildBlock(origOutcomes);
  const improved = buildBlock(impOutcomes);

  const minRecommended = 30;
  const impOos = impOutcomes.filter((t) => t.isOutOfSample);
  const fxOosTrades = impOos.filter((t) => !/BTC|ETH|SOL/i.test(t.symbol)).length;
  const cryptoOosTrades = impOos.length - fxOosTrades;
  const smallSampleWarnings: SampleSizeWarning[] = [];
  if (improved.outOfSample.totalTrades < minRecommended) {
    smallSampleWarnings.push({
      scope: 'OVERALL_OOS',
      key: 'ALL',
      trades: improved.outOfSample.totalTrades,
      note: `Total OOS sample (${improved.outOfSample.totalTrades}) is below ${minRecommended} trades; confidence intervals remain wide.`,
    });
  }
  for (const [sym, m] of Object.entries(improved.byInstrument)) {
    if (m.totalTrades < minRecommended) {
      smallSampleWarnings.push({
        scope: 'INSTRUMENT_OOS',
        key: sym,
        trades: m.totalTrades,
        note: `${sym} has only ${m.totalTrades} OOS trade(s) (< ${minRecommended}) — statistically underpowered for per-pair significance.`,
      });
    }
  }
  for (const [tf, m] of Object.entries(improved.byTimeframe)) {
    if (m.totalTrades < minRecommended) {
      smallSampleWarnings.push({
        scope: 'TIMEFRAME_OOS',
        key: tf,
        trades: m.totalTrades,
        note: `${tf} has only ${m.totalTrades} OOS trade(s) (< ${minRecommended}) — treat timeframe breakdown as directional evidence only.`,
      });
    }
  }
  for (const [strat, m] of Object.entries(improved.byStrategy)) {
    if (m.totalTrades < minRecommended) {
      smallSampleWarnings.push({
        scope: 'STRATEGY_OOS',
        key: strat,
        trades: m.totalTrades,
        note: `${strat} has only ${m.totalTrades} OOS trade(s) (< ${minRecommended}).`,
      });
    }
  }
  if (fxOosTrades < 15) {
    smallSampleWarnings.push({
      scope: 'INSTRUMENT_OOS',
      key: 'FX_COHORT',
      trades: fxOosTrades,
      note: `Combined FX OOS cohort has only ${fxOosTrades} trade(s) across EURUSD/GBPUSD/USDJPY — insufficient to confirm positive FX expectancy separately from crypto.`,
    });
  }

  const winRateDeltaPct =
    original.outOfSample.winRatePct != null && improved.outOfSample.winRatePct != null
      ? Number((improved.outOfSample.winRatePct - original.outOfSample.winRatePct).toFixed(2))
      : null;
  const tradeReductionPct =
    original.outOfSample.totalTrades > 0
      ? Number(
          (((original.outOfSample.totalTrades - improved.outOfSample.totalTrades) / original.outOfSample.totalTrades) * 100).toFixed(1)
        )
      : null;

  return {
    generatedAt: new Date().toISOString(),
    datasetsLoaded,
    datasetsFailed,
    assumptions: {
      stakePerTrade: stake,
      payoutRate,
      horizonBars,
      executionDelayBars: 1,
      fxSpreadAndSlippageBps: fxCostBps,
      cryptoSpreadAndSlippageBps: cryptoCostBps,
      flatPriceCountsAsLoss: true,
      outOfSampleSplitPct: 50,
      strictCausalClosedHtfBars: true,
      strictNonOverlappingIsOosBoundary: true,
      reproducibilityNote:
        'Signal scoring and trade simulation are 100% deterministic for a fixed candle dataset. Live API calls fetch rolling market windows that advance over time as new bars form.',
    },
    sampleSizeDisclosure: {
      minimumRecommendedTradesPerBucket: minRecommended,
      totalOosTrades: improved.outOfSample.totalTrades,
      fxOosTrades,
      cryptoOosTrades,
      smallSampleWarnings,
      summary:
        smallSampleWarnings.length > 0
          ? `Small-sample caution: ${improved.outOfSample.totalTrades} OOS trades total (FX=${fxOosTrades}, Crypto=${cryptoOosTrades}). Sub-30 trade buckets (${smallSampleWarnings.map((w) => `${w.key}:${w.trades}`).join(', ')}) carry high sampling variance.`
          : `All reported OOS cohorts meet >= ${minRecommended} trades.`,
    },
    original,
    improved,
    deltaOutOfSample: {
      winRateDeltaPct,
      netPnlDelta: Number((improved.outOfSample.netPnl - original.outOfSample.netPnl).toFixed(2)),
      tradeReductionPct,
      maxDrawdownReduction: Number((original.outOfSample.maxDrawdown - improved.outOfSample.maxDrawdown).toFixed(2)),
    },
  };
}

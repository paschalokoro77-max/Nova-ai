import type { Timeframe } from './marketData.ts';
import type { AdaptiveStrategyName } from './quantEngine.ts';

export type AccountPerformanceBucket =
  | 'MT5_DEMO'
  | 'MT5_REAL'
  | 'IQ_OPTION_DEMO'
  | 'IQ_OPTION_REAL'
  | 'PAPER_SIMULATOR';

export interface LearnableTradeRecord {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  direction: 'CALL' | 'PUT';
  amount: number;
  payoutRate: number;
  entryPrice: number | null;
  exitPrice: number | null;
  status: string;
  pnl: number | null;
  signalScore: number | null;
  settledBy: string | null;
  createdAt: string;
  closedAt: string | null;
  accountBucket?: AccountPerformanceBucket;
  strategyName?: AdaptiveStrategyName;
  signalId?: string;
  brokerOrderId?: string;
}

export interface BucketPerformance {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number;
  status: 'STRONG' | 'NEUTRAL' | 'WEAK' | 'INSUFFICIENT_DATA';
}

export interface StrategyProtectionState {
  strategy: AdaptiveStrategyName;
  paused: boolean;
  reason: string | null;
  pausedAt: string | null;
  resumeAfterIso: string | null;
  consecutiveLosses: number;
  rollingWinRatePct: number | null;
  rollingSampleSize: number;
  consecutiveShadowWins: number;
  shadowWinsRequired: number;
}

export interface StrategyAdjustmentRecord {
  id: string;
  timestamp: string;
  scope: 'GLOBAL' | 'INSTRUMENT' | 'TIMEFRAME' | 'STRATEGY';
  target: string;
  action: 'RAISE_THRESHOLD' | 'CAUTION_FLAG' | 'CONFIDENCE_PENALTY' | 'CONFIDENCE_BOOST' | 'STRATEGY_PAUSED' | 'STRATEGY_RESUMED';
  delta: number;
  sampleSize: number;
  observedWinRatePct: number;
  reason: string;
}

export interface LearningInsights {
  validTradesAnalyzed: number;
  excludedTradesCount: number;
  exclusionReasons: Record<string, number>;
  overallWinRatePct: number | null;
  overallProfitFactor: number | null;
  byAccountBucket: Record<AccountPerformanceBucket, BucketPerformance>;
  byInstrument: BucketPerformance[];
  byTimeframe: BucketPerformance[];
  byStrategy: BucketPerformance[];
  byScoreBand: BucketPerformance[];
  strategyProtection: Record<AdaptiveStrategyName, StrategyProtectionState>;
  pausedStrategies: AdaptiveStrategyName[];
  recurringLossCauses: Array<{ cause: string; count: number; pctOfLosses: number }>;
  instrumentScoreAdjustments: Record<string, number>;
  timeframeScoreAdjustments: Record<string, number>;
  cautionSymbols: string[];
  recommendedMinScore: number;
  auditLog: StrategyAdjustmentRecord[];
  updatedAt: string;
}

export interface HistoricalBiasContext {
  instrumentWinRatePct: number | null;
  instrumentSampleSize: number;
  timeframeWinRatePct: number | null;
  timeframeSampleSize: number;
  strategyWinRatePct?: number | null;
  strategySampleSize?: number;
  scoreThresholdOffset: number;
  confidenceAdjustment: number;
  cautionReason: string | null;
  recommendedProfileNote?: string | null;
}

const MIN_BUCKET_SAMPLE = 10;
const MIN_GLOBAL_SAMPLE = 15;
const STRATEGY_PAUSE_CONSECUTIVE_LOSSES = 3;
const STRATEGY_PAUSE_ROLLING_WINDOW = 8;
const STRATEGY_PAUSE_ROLLING_MIN_WR = 42;
const STRATEGY_PAUSE_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes default
const STRATEGY_RESUME_SHADOW_WINS = 2;

const ALL_ACCOUNT_BUCKETS: AccountPerformanceBucket[] = [
  'MT5_DEMO',
  'MT5_REAL',
  'IQ_OPTION_DEMO',
  'IQ_OPTION_REAL',
  'PAPER_SIMULATOR',
];

const TRACKED_STRATEGIES: AdaptiveStrategyName[] = [
  'TREND_CONTINUATION',
  'RANGE_MEAN_REVERSION',
  'STRUCTURE_REVERSAL',
  'VOLATILITY_BREAKOUT',
  'CAPITAL_PROTECTION',
];

export function resolveAccountBucket(brokerId?: string | null, environment?: string | null): AccountPerformanceBucket {
  if (brokerId === 'mt5') return environment === 'real' ? 'MT5_REAL' : 'MT5_DEMO';
  if (brokerId === 'iq_option') return environment === 'real' ? 'IQ_OPTION_REAL' : 'IQ_OPTION_DEMO';
  return 'PAPER_SIMULATOR';
}

function isSettledStatus(status: string): 'WIN' | 'LOSS' | null {
  if (status === 'SIMULATED_WIN' || status === 'CLOSED_WIN') return 'WIN';
  if (status === 'SIMULATED_LOSS' || status === 'CLOSED_LOSS') return 'LOSS';
  return null;
}

function buildBucket(
  key: string,
  trades: Array<{ outcome: 'WIN' | 'LOSS'; pnl: number }>
): BucketPerformance {
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  for (const t of trades) {
    if (t.outcome === 'WIN') {
      wins += 1;
      grossProfit += Math.max(0, t.pnl);
    } else {
      losses += 1;
      grossLoss += Math.abs(Math.min(0, t.pnl));
    }
  }

  const total = wins + losses;
  const winRatePct = total > 0 ? Number(((wins / total) * 100).toFixed(1)) : 0;
  const netPnl = Number((grossProfit - grossLoss).toFixed(2));
  const profitFactor =
    grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 999 : null;
  const expectancy = total > 0 ? Number((netPnl / total).toFixed(2)) : 0;

  let status: BucketPerformance['status'] = 'INSUFFICIENT_DATA';
  if (total >= MIN_BUCKET_SAMPLE) {
    if (winRatePct >= 62 && netPnl > 0) status = 'STRONG';
    else if (winRatePct < 48 || (profitFactor !== null && profitFactor < 0.85)) status = 'WEAK';
    else status = 'NEUTRAL';
  }

  return {
    key,
    trades: total,
    wins,
    losses,
    winRatePct,
    netPnl,
    profitFactor,
    expectancy,
    status,
  };
}

export interface PersistedLearnerState {
  strategyStates: Record<string, StrategyProtectionState>;
  resumedAfterClosedAtMs: Record<string, number>;
  lastSeenClosedAtMs: Record<string, number>;
  auditLog: StrategyAdjustmentRecord[];
}

export class PerformanceLearner {
  private readonly auditLog: StrategyAdjustmentRecord[] = [];
  private readonly strategyStates = new Map<AdaptiveStrategyName, StrategyProtectionState>();
  private readonly lastSeenClosedAtMs = new Map<AdaptiveStrategyName, number>();
  private readonly resumedAfterClosedAtMs = new Map<AdaptiveStrategyName, number>();
  private lastInsights: LearningInsights | null = null;

  constructor() {
    for (const s of TRACKED_STRATEGIES) {
      this.strategyStates.set(s, {
        strategy: s,
        paused: false,
        reason: null,
        pausedAt: null,
        resumeAfterIso: null,
        consecutiveLosses: 0,
        rollingWinRatePct: null,
        rollingSampleSize: 0,
        consecutiveShadowWins: 0,
        shadowWinsRequired: STRATEGY_RESUME_SHADOW_WINS,
      });
    }
  }

  exportState(): PersistedLearnerState {
    const strategyStates: Record<string, StrategyProtectionState> = {};
    for (const [k, v] of this.strategyStates.entries()) {
      strategyStates[k] = { ...v };
    }
    const resumedAfterClosedAtMs: Record<string, number> = {};
    for (const [k, v] of this.resumedAfterClosedAtMs.entries()) {
      resumedAfterClosedAtMs[k] = v;
    }
    const lastSeenClosedAtMs: Record<string, number> = {};
    for (const [k, v] of this.lastSeenClosedAtMs.entries()) {
      lastSeenClosedAtMs[k] = v;
    }
    return {
      strategyStates,
      resumedAfterClosedAtMs,
      lastSeenClosedAtMs,
      auditLog: [...this.auditLog],
    };
  }

  restoreState(persisted?: Partial<PersistedLearnerState> | null): void {
    if (!persisted || typeof persisted !== 'object') return;
    if (persisted.strategyStates && typeof persisted.strategyStates === 'object') {
      for (const s of TRACKED_STRATEGIES) {
        const incoming = persisted.strategyStates[s];
        if (!incoming || typeof incoming !== 'object') continue;
        const current = this.strategyStates.get(s);
        this.strategyStates.set(s, {
          strategy: s,
          paused: Boolean(incoming.paused),
          reason: incoming.reason ?? null,
          pausedAt: incoming.pausedAt ?? null,
          resumeAfterIso: incoming.resumeAfterIso ?? null,
          consecutiveLosses: Number.isFinite(incoming.consecutiveLosses)
            ? Number(incoming.consecutiveLosses)
            : (current?.consecutiveLosses ?? 0),
          rollingWinRatePct:
            incoming.rollingWinRatePct != null && Number.isFinite(incoming.rollingWinRatePct)
              ? Number(incoming.rollingWinRatePct)
              : null,
          rollingSampleSize: Number.isFinite(incoming.rollingSampleSize)
            ? Number(incoming.rollingSampleSize)
            : (current?.rollingSampleSize ?? 0),
          consecutiveShadowWins: Number.isFinite(incoming.consecutiveShadowWins)
            ? Number(incoming.consecutiveShadowWins)
            : 0,
          shadowWinsRequired: Number.isFinite(incoming.shadowWinsRequired) && Number(incoming.shadowWinsRequired) > 0
            ? Number(incoming.shadowWinsRequired)
            : STRATEGY_RESUME_SHADOW_WINS,
        });
      }
    }
    if (persisted.resumedAfterClosedAtMs && typeof persisted.resumedAfterClosedAtMs === 'object') {
      for (const s of TRACKED_STRATEGIES) {
        const wm = persisted.resumedAfterClosedAtMs[s];
        if (typeof wm === 'number' && Number.isFinite(wm) && wm > 0) {
          const prevWm = this.resumedAfterClosedAtMs.get(s) ?? 0;
          if (wm > prevWm) this.resumedAfterClosedAtMs.set(s, wm);
        }
      }
    }
    if (persisted.lastSeenClosedAtMs && typeof persisted.lastSeenClosedAtMs === 'object') {
      for (const s of TRACKED_STRATEGIES) {
        const ts = persisted.lastSeenClosedAtMs[s];
        if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
          const prevTs = this.lastSeenClosedAtMs.get(s) ?? 0;
          if (ts > prevTs) this.lastSeenClosedAtMs.set(s, ts);
        }
      }
    }
    if (Array.isArray(persisted.auditLog)) {
      const seenIds = new Set(this.auditLog.map((a) => a.id));
      for (const rec of persisted.auditLog) {
        if (rec && rec.id && !seenIds.has(rec.id)) {
          this.auditLog.push(rec);
          seenIds.add(rec.id);
        }
      }
      this.auditLog.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      if (this.auditLog.length > 120) this.auditLog.length = 120;
    }
  }

  private recordAudit(rec: Omit<StrategyAdjustmentRecord, 'id' | 'timestamp'>) {
    const nowIso = new Date().toISOString();
    const existsRecent = this.auditLog.find(
      (a) =>
        a.scope === rec.scope &&
        a.target === rec.target &&
        a.action === rec.action &&
        a.delta === rec.delta &&
        a.sampleSize === rec.sampleSize
    );
    if (!existsRecent) {
      this.auditLog.unshift({
        id: `${rec.scope}-${rec.target}-${rec.action}-${Date.now()}`,
        timestamp: nowIso,
        ...rec,
      });
      if (this.auditLog.length > 120) this.auditLog.length = 120;
    }
  }

  /**
   * Intelligent Performance Protection:
   * While a strategy is paused, market analysis continues and validates shadow signals.
   * When validated shadow outcomes improve (>= 2 consecutive shadow wins, or cooldown expired + validated win),
   * the strategy resumes automatically without ever altering the user's selected broker account.
   */
  recordShadowValidation(strategy: AdaptiveStrategyName, won: boolean): StrategyProtectionState {
    const state = this.strategyStates.get(strategy) || {
      strategy,
      paused: false,
      reason: null,
      pausedAt: null,
      resumeAfterIso: null,
      consecutiveLosses: 0,
      rollingWinRatePct: null,
      rollingSampleSize: 0,
      consecutiveShadowWins: 0,
      shadowWinsRequired: STRATEGY_RESUME_SHADOW_WINS,
    };

    if (!state.paused) {
      this.strategyStates.set(strategy, state);
      return { ...state };
    }

    if (won) {
      state.consecutiveShadowWins += 1;
      const cooldownElapsed = state.resumeAfterIso ? Date.now() >= new Date(state.resumeAfterIso).getTime() : false;
      if (state.consecutiveShadowWins >= state.shadowWinsRequired || cooldownElapsed) {
        state.paused = false;
        state.reason = null;
        state.pausedAt = null;
        state.resumeAfterIso = null;
        state.consecutiveLosses = 0;
        const watermark = this.lastSeenClosedAtMs.get(strategy) ?? Date.now();
        this.resumedAfterClosedAtMs.set(strategy, watermark);
        const wins = state.consecutiveShadowWins;
        state.consecutiveShadowWins = 0;
        this.recordAudit({
          scope: 'STRATEGY',
          target: strategy,
          action: 'STRATEGY_RESUMED',
          delta: 0,
          sampleSize: wins,
          observedWinRatePct: 100,
          reason: `Strategy ${strategy} resumed automatically after ${wins} validated shadow win(s) confirmed improved market conditions.`,
        });
      }
    } else {
      state.consecutiveShadowWins = 0;
    }

    this.strategyStates.set(strategy, state);
    return { ...state };
  }

  isStrategyPaused(strategy?: AdaptiveStrategyName): { paused: boolean; reason: string | null } {
    if (!strategy) return { paused: false, reason: null };
    const state = this.strategyStates.get(strategy);
    if (!state || !state.paused) return { paused: false, reason: null };
    return { paused: true, reason: state.reason };
  }

  getPausedStrategies(): AdaptiveStrategyName[] {
    const out: AdaptiveStrategyName[] = [];
    for (const [k, v] of this.strategyStates.entries()) {
      if (v.paused) out.push(k);
    }
    return out;
  }

  analyzeHistory(rawTrades: LearnableTradeRecord[], baseMinScore = 72): LearningInsights {
    const seenIds = new Set<string>();
    const seenBrokerOrderIds = new Set<string>();
    const seenSignalIds = new Set<string>();
    const exclusionReasons: Record<string, number> = {};
    const bumpExclusion = (reason: string) => {
      exclusionReasons[reason] = (exclusionReasons[reason] || 0) + 1;
    };

    const valid: Array<LearnableTradeRecord & { outcome: 'WIN' | 'LOSS'; effectivePnl: number }> = [];

    for (const t of rawTrades) {
      if (!t || !t.id) {
        bumpExclusion('missing_id');
        continue;
      }
      if (seenIds.has(t.id)) {
        bumpExclusion('duplicate_trade_id');
        continue;
      }
      if (t.brokerOrderId && seenBrokerOrderIds.has(t.brokerOrderId)) {
        bumpExclusion('duplicate_broker_order_id');
        continue;
      }
      if (t.signalId && seenSignalIds.has(t.signalId)) {
        bumpExclusion('duplicate_signal_id');
        continue;
      }
      seenIds.add(t.id);
      if (t.brokerOrderId) seenBrokerOrderIds.add(t.brokerOrderId);
      if (t.signalId) seenSignalIds.add(t.signalId);

      const outcome = isSettledStatus(t.status);
      if (!outcome) {
        bumpExclusion('unsettled_or_cancelled');
        continue;
      }
      if (!Number.isFinite(t.amount) || t.amount <= 0) {
        bumpExclusion('invalid_stake');
        continue;
      }
      if (t.pnl == null || !Number.isFinite(t.pnl)) {
        bumpExclusion('missing_pnl');
        continue;
      }
      if ((outcome === 'WIN' && t.pnl <= 0) || (outcome === 'LOSS' && t.pnl >= 0)) {
        bumpExclusion('inconsistent_settlement_pnl');
        continue;
      }
      if (t.entryPrice != null && t.exitPrice != null && (!Number.isFinite(t.entryPrice) || !Number.isFinite(t.exitPrice))) {
        bumpExclusion('corrupt_prices');
        continue;
      }

      valid.push({ ...t, outcome, effectivePnl: t.pnl });
    }

    const byInstMap = new Map<string, Array<{ outcome: 'WIN' | 'LOSS'; pnl: number }>>();
    const byTfMap = new Map<string, Array<{ outcome: 'WIN' | 'LOSS'; pnl: number }>>();
    const byStratMap = new Map<AdaptiveStrategyName, Array<{ outcome: 'WIN' | 'LOSS'; pnl: number; closedAtMs: number }>>();
    const byBucketMap = new Map<AccountPerformanceBucket, Array<{ outcome: 'WIN' | 'LOSS'; pnl: number }>>();
    const byBandMap = new Map<string, Array<{ outcome: 'WIN' | 'LOSS'; pnl: number }>>();
    const lossCauseCounts = new Map<string, number>();

    for (const b of ALL_ACCOUNT_BUCKETS) byBucketMap.set(b, []);
    for (const s of TRACKED_STRATEGIES) byStratMap.set(s, []);

    let totalWins = 0;
    let totalLosses = 0;
    let grossProfit = 0;
    let grossLoss = 0;

    for (const t of valid) {
      if (t.outcome === 'WIN') {
        totalWins += 1;
        grossProfit += t.effectivePnl;
      } else {
        totalLosses += 1;
        grossLoss += Math.abs(t.effectivePnl);

        let cause = 'Directional reversal before expiry';
        if (t.entryPrice != null && t.exitPrice != null && t.entryPrice === t.exitPrice) {
          cause = 'Flat-price expiry settled as loss (low volatility / unchanged tick)';
        } else if (t.settledBy === 'stop-loss-triggered') {
          cause = 'Stop-loss triggered prematurely (volatility / entry timing)';
        } else if (t.signalScore != null && t.signalScore < 70) {
          cause = 'Low-conviction entry (signal score < 70)';
        } else if (t.timeframe === '1m') {
          cause = 'High-noise 1m timeframe micro-reversal';
        }
        lossCauseCounts.set(cause, (lossCauseCounts.get(cause) || 0) + 1);
      }

      const instArr = byInstMap.get(t.symbol) || [];
      instArr.push({ outcome: t.outcome, pnl: t.effectivePnl });
      byInstMap.set(t.symbol, instArr);

      const tfArr = byTfMap.get(t.timeframe) || [];
      tfArr.push({ outcome: t.outcome, pnl: t.effectivePnl });
      byTfMap.set(t.timeframe, tfArr);

      const bucket: AccountPerformanceBucket = t.accountBucket || 'PAPER_SIMULATOR';
      byBucketMap.get(bucket)!.push({ outcome: t.outcome, pnl: t.effectivePnl });

      const strat: AdaptiveStrategyName = t.strategyName || 'TREND_CONTINUATION';
      const closedAtMs = new Date(t.closedAt || t.createdAt).getTime();
      byStratMap.get(strat)!.push({ outcome: t.outcome, pnl: t.effectivePnl, closedAtMs });

      const band =
        t.signalScore == null
          ? 'UNSCORED'
          : t.signalScore >= 82
            ? '82-100'
            : t.signalScore >= 72
              ? '72-81'
              : t.signalScore >= 65
                ? '65-71'
                : '<65';
      const bandArr = byBandMap.get(band) || [];
      bandArr.push({ outcome: t.outcome, pnl: t.effectivePnl });
      byBandMap.set(band, bandArr);
    }

    // Evaluate Intelligent Performance Protection per strategy
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const pausedStrategies: AdaptiveStrategyName[] = [];
    const strategyProtection = {} as Record<AdaptiveStrategyName, StrategyProtectionState>;

    for (const strat of TRACKED_STRATEGIES) {
      const list = (byStratMap.get(strat) || []).slice().sort((a, b) => a.closedAtMs - b.closedAtMs);
      if (list.length > 0) {
        this.lastSeenClosedAtMs.set(strat, list[list.length - 1].closedAtMs);
      }
      const resumedWatermark = this.resumedAfterClosedAtMs.get(strat) ?? 0;
      const evaluationList = resumedWatermark > 0 ? list.filter((x) => x.closedAtMs > resumedWatermark) : list;

      let streak = 0;
      for (let i = evaluationList.length - 1; i >= 0; i--) {
        if (evaluationList[i].outcome === 'LOSS') streak += 1;
        else break;
      }
      const recent = evaluationList.slice(-STRATEGY_PAUSE_ROLLING_WINDOW);
      const recentWins = recent.filter((x) => x.outcome === 'WIN').length;
      const rollingWr = recent.length > 0 ? Number(((recentWins / recent.length) * 100).toFixed(1)) : null;

      const prev = this.strategyStates.get(strat)!;
      const shouldPauseStreak = streak >= STRATEGY_PAUSE_CONSECUTIVE_LOSSES;
      const shouldPauseRolling =
        recent.length >= STRATEGY_PAUSE_ROLLING_WINDOW && rollingWr !== null && rollingWr < STRATEGY_PAUSE_ROLLING_MIN_WR;

      if ((shouldPauseStreak || shouldPauseRolling) && !prev.paused) {
        const reason = shouldPauseStreak
          ? `${strat} paused after ${streak} consecutive losses; continuing shadow analysis until ${STRATEGY_RESUME_SHADOW_WINS} validated wins.`
          : `${strat} paused due to deteriorating rolling win rate (${rollingWr}% over last ${recent.length} trades); continuing shadow analysis.`;
        prev.paused = true;
        prev.reason = reason;
        prev.pausedAt = nowIso;
        prev.resumeAfterIso = new Date(nowMs + STRATEGY_PAUSE_COOLDOWN_MS).toISOString();
        prev.consecutiveShadowWins = 0;
        this.recordAudit({
          scope: 'STRATEGY',
          target: strat,
          action: 'STRATEGY_PAUSED',
          delta: 0,
          sampleSize: recent.length,
          observedWinRatePct: rollingWr ?? 0,
          reason,
        });
      }

      prev.consecutiveLosses = streak;
      prev.rollingWinRatePct = rollingWr;
      prev.rollingSampleSize = recent.length;
      this.strategyStates.set(strat, prev);
      strategyProtection[strat] = { ...prev };
      if (prev.paused) pausedStrategies.push(strat);
    }

    const byAccountBucket = {} as Record<AccountPerformanceBucket, BucketPerformance>;
    for (const b of ALL_ACCOUNT_BUCKETS) {
      byAccountBucket[b] = buildBucket(b, byBucketMap.get(b) || []);
    }

    const byInstrument = Array.from(byInstMap.entries())
      .map(([k, arr]) => buildBucket(k, arr))
      .sort((a, b) => b.trades - a.trades);
    const byTimeframe = Array.from(byTfMap.entries())
      .map(([k, arr]) => buildBucket(k, arr))
      .sort((a, b) => b.trades - a.trades);
    const byStrategy = TRACKED_STRATEGIES.map((s) => buildBucket(s, byStratMap.get(s) || [])).filter(
      (b) => b.trades > 0
    );
    const byScoreBand = Array.from(byBandMap.entries())
      .map(([k, arr]) => buildBucket(k, arr))
      .sort((a, b) => a.key.localeCompare(b.key));

    const recurringLossCauses = Array.from(lossCauseCounts.entries())
      .map(([cause, count]) => ({
        cause,
        count,
        pctOfLosses: totalLosses > 0 ? Number(((count / totalLosses) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    const instrumentScoreAdjustments: Record<string, number> = {};
    const timeframeScoreAdjustments: Record<string, number> = {};
    const cautionSymbols: string[] = [];

    for (const row of byInstrument) {
      if (row.trades < MIN_BUCKET_SAMPLE) continue;
      if (row.winRatePct < 45) {
        const delta = row.winRatePct < 35 ? 10 : 6;
        instrumentScoreAdjustments[row.key] = delta;
        cautionSymbols.push(row.key);
        this.recordAudit({
          scope: 'INSTRUMENT',
          target: row.key,
          action: 'RAISE_THRESHOLD',
          delta,
          sampleSize: row.trades,
          observedWinRatePct: row.winRatePct,
          reason: `${row.key} win rate ${row.winRatePct}% over ${row.trades} valid trades; raised min quality threshold by +${delta}.`,
        });
      } else if (row.winRatePct >= 65 && row.netPnl > 0) {
        instrumentScoreAdjustments[row.key] = -2;
      }
    }

    for (const row of byTimeframe) {
      if (row.trades < MIN_BUCKET_SAMPLE) continue;
      if (row.winRatePct < 46) {
        const delta = row.winRatePct < 36 ? 8 : 5;
        timeframeScoreAdjustments[row.key] = delta;
        this.recordAudit({
          scope: 'TIMEFRAME',
          target: row.key,
          action: 'RAISE_THRESHOLD',
          delta,
          sampleSize: row.trades,
          observedWinRatePct: row.winRatePct,
          reason: `Timeframe ${row.key} win rate ${row.winRatePct}% over ${row.trades} valid trades; raised min quality threshold by +${delta}.`,
        });
      }
    }

    const overallWinRatePct =
      valid.length > 0 ? Number(((totalWins / valid.length) * 100).toFixed(1)) : null;
    const overallProfitFactor =
      grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 999 : null;

    let recommendedMinScore = baseMinScore;
    if (valid.length >= MIN_GLOBAL_SAMPLE && overallWinRatePct !== null) {
      if (overallWinRatePct < 50) {
        recommendedMinScore = Math.min(84, baseMinScore + 6);
        this.recordAudit({
          scope: 'GLOBAL',
          target: 'ALL',
          action: 'RAISE_THRESHOLD',
          delta: recommendedMinScore - baseMinScore,
          sampleSize: valid.length,
          observedWinRatePct: overallWinRatePct,
          reason: `Global win rate ${overallWinRatePct}% over ${valid.length} valid trades is below 55.6% breakeven; tightened min score to ${recommendedMinScore}.`,
        });
      }
    }

    const excludedTradesCount = Object.values(exclusionReasons).reduce((a, b) => a + b, 0);
    const insights: LearningInsights = {
      validTradesAnalyzed: valid.length,
      excludedTradesCount,
      exclusionReasons,
      overallWinRatePct,
      overallProfitFactor,
      byAccountBucket,
      byInstrument,
      byTimeframe,
      byStrategy,
      byScoreBand,
      strategyProtection,
      pausedStrategies,
      recurringLossCauses,
      instrumentScoreAdjustments,
      timeframeScoreAdjustments,
      cautionSymbols,
      recommendedMinScore,
      auditLog: [...this.auditLog],
      updatedAt: nowIso,
    };

    this.lastInsights = insights;
    return insights;
  }

  getBiasForSetup(
    symbol: string,
    timeframe: Timeframe,
    strategyName?: AdaptiveStrategyName
  ): HistoricalBiasContext {
    const insights = this.lastInsights;
    if (!insights) {
      return {
        instrumentWinRatePct: null,
        instrumentSampleSize: 0,
        timeframeWinRatePct: null,
        timeframeSampleSize: 0,
        strategyWinRatePct: null,
        strategySampleSize: 0,
        scoreThresholdOffset: 0,
        confidenceAdjustment: 0,
        cautionReason: null,
        recommendedProfileNote: null,
      };
    }

    const inst = insights.byInstrument.find((b) => b.key === symbol);
    const tf = insights.byTimeframe.find((b) => b.key === timeframe);
    const strat = strategyName ? insights.byStrategy.find((b) => b.key === strategyName) : undefined;

    const instOffset = insights.instrumentScoreAdjustments[symbol] || 0;
    const tfOffset = insights.timeframeScoreAdjustments[timeframe] || 0;
    let stratOffset = 0;

    let confidenceAdjustment = 0;
    let cautionReason: string | null = null;
    let recommendedProfileNote: string | null = null;

    if (inst && inst.trades >= MIN_BUCKET_SAMPLE) {
      if (inst.winRatePct < 45) {
        confidenceAdjustment -= 8;
        cautionReason = `Historical caution: ${symbol} has ${inst.winRatePct}% win rate across ${inst.trades} valid trades.`;
      } else if (inst.winRatePct >= 65 && inst.netPnl > 0) {
        confidenceAdjustment += 3;
      }
    }

    if (tf && tf.trades >= MIN_BUCKET_SAMPLE) {
      if (tf.winRatePct < 46) {
        confidenceAdjustment -= 5;
        cautionReason =
          cautionReason ||
          `Historical caution: ${timeframe} timeframe has ${tf.winRatePct}% win rate across ${tf.trades} valid trades.`;
      }
    }

    if (strat && strat.trades >= MIN_BUCKET_SAMPLE) {
      if (strat.winRatePct < 45) {
        confidenceAdjustment -= 6;
        stratOffset = 4;
        cautionReason =
          cautionReason ||
          `Historical caution: ${strategyName} win rate is ${strat.winRatePct}% across ${strat.trades} valid trades.`;
        recommendedProfileNote = `${strategyName} underperforming historically (${strat.winRatePct}% WR) — stricter confirmation enforced.`;
      } else if (strat.winRatePct >= 62 && strat.netPnl > 0) {
        confidenceAdjustment += 2;
        recommendedProfileNote = `${strategyName} showing positive historical expectancy (${strat.winRatePct}% WR across ${strat.trades} trades).`;
      }
    }

    if (!recommendedProfileNote && insights.overallWinRatePct != null && insights.validTradesAnalyzed >= MIN_GLOBAL_SAMPLE) {
      if (insights.overallWinRatePct < 50) {
        recommendedProfileNote = `Overall WR ${insights.overallWinRatePct}% below 55.6% breakeven; tighter score floor ${insights.recommendedMinScore} advised.`;
      }
    }

    const scoreThresholdOffset = Math.max(-4, Math.min(12, instOffset + tfOffset + stratOffset));

    return {
      instrumentWinRatePct: inst && inst.trades >= MIN_BUCKET_SAMPLE ? inst.winRatePct : null,
      instrumentSampleSize: inst?.trades ?? 0,
      timeframeWinRatePct: tf && tf.trades >= MIN_BUCKET_SAMPLE ? tf.winRatePct : null,
      timeframeSampleSize: tf?.trades ?? 0,
      strategyWinRatePct: strat && strat.trades >= MIN_BUCKET_SAMPLE ? strat.winRatePct : null,
      strategySampleSize: strat?.trades ?? 0,
      scoreThresholdOffset,
      confidenceAdjustment,
      cautionReason,
      recommendedProfileNote,
    };
  }

  getAuditLog(): StrategyAdjustmentRecord[] {
    return [...this.auditLog];
  }
}

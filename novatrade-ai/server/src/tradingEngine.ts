import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeMarketQuant,
  evaluateTimeframeExpiryCompatibility,
  getHigherTimeframe,
  isLiveMarketStatus,
  type QuantAnalysisResult,
  type StrategyProfile,
} from './quantEngine.ts';
import {
  fetchMarketCandles,
  SUPPORTED_ASSETS,
  type Timeframe,
} from './marketData.ts';
import { generateGeminiExplanation, type GeminiCommentary } from './geminiAdvisor.ts';
import { getSupabaseAdmin } from './supabaseAdmin.ts';
import {
  PerformanceLearner,
  type AccountPerformanceBucket,
  type LearnableTradeRecord,
  type LearningInsights,
  type PersistedLearnerState,
} from './performanceLearner.ts';
import type { AdaptiveStrategyName } from './quantEngine.ts';

export interface PendingShadowSignal {
  symbol: string;
  timeframe: Timeframe;
  direction: 'CALL' | 'PUT';
  strategy: AdaptiveStrategyName;
  entryPrice: number;
  expiresAtMs: number;
}

export type DashboardAccountSource = 'paper' | 'mt5' | 'iq_option';

export interface RuntimeRecoveryPayload {
  pendingShadowSignals: PendingShadowSignal[];
  assistedProposals: AssistedProposal[];
  learnerState: PersistedLearnerState;
  updatedAt: string;
  selectedDashboardSource?: DashboardAccountSource;
}

export type OperatingMode = 'signals' | 'assisted' | 'automatic';

export interface RiskSettings {
  maxTradeAmount: number;
  dailyLossLimit: number;
  dailyProfitTarget: number;
  maxConsecutiveLosses: number;
  maxDailyTrades: number;
  maxSimultaneousTrades: number;
  maxTradesPerInstrument?: number;
  lossCooldownSeconds?: number;
  minAvailableBalancePct?: number;
  tradingScheduleEnabled: boolean;
  tradingStartHourUtc: number;
  tradingEndHourUtc: number;
  emergencyStop: boolean;
}

export interface AiSettings {
  strategyProfile: StrategyProfile;
  minSignalScore: number;
  requireMtfAlignment: boolean;
  enabledAssets: string[];
  defaultTimeframe: Timeframe;
  expirySeconds: number;
  scanIntervalSeconds: number;
  useGeminiCommentary: boolean;
}

export interface PaperTrade {
  id: string;
  userId?: string;
  symbol: string;
  timeframe: Timeframe;
  direction: 'CALL' | 'PUT';
  mode: OperatingMode | 'manual';
  amount: number;
  payoutRate: number;
  entryPrice: number | null;
  exitPrice: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  expirySeconds: number;
  requestedExpirySeconds?: number;
  expiryAdjusted?: boolean;
  expiryAdjustmentReason?: string | null;
  expiresAt: string | null;
  status:
    | 'SIMULATED_NOT_EXECUTED'
    | 'SIMULATED_PENDING_OUTCOME'
    | 'SIMULATED_WIN'
    | 'SIMULATED_LOSS'
    | 'CLOSED_WIN'
    | 'CLOSED_LOSS'
    | 'CANCELLED';
  pnl: number | null;
  signalScore: number | null;
  provider: string;
  settledBy: string | null;
  createdAt: string;
  closedAt: string | null;
  accountBucket?: AccountPerformanceBucket;
  strategyName?: AdaptiveStrategyName;
  signalId?: string;
}

export interface StoredSignal extends QuantAnalysisResult {
  id: string;
  aiExplanation: GeminiCommentary | null;
  sourceApp?: 'MT5' | 'IQ_OPTION' | 'UNKNOWN';
  accountModeDetected?: 'DEMO' | 'PRACTICE' | 'REAL' | 'UNKNOWN';
  screenAnalysisId?: string;
}

export interface AssistedProposal {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  direction: 'CALL' | 'PUT';
  score: number;
  recommendedAmount: number;
  entryPrice: number | null;
  expirySeconds: number;
  requestedExpirySeconds?: number;
  expiryAdjusted?: boolean;
  expiryAdjustmentReason?: string | null;
  reasons: string[];
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  createdAt: string;
  decidedAt: string | null;
  strategyName?: AdaptiveStrategyName;
  sourceApp?: 'MT5' | 'IQ_OPTION' | 'UNKNOWN';
  screenAnalysisId?: string;
}

export interface ActivityEvent {
  id: string;
  category: 'AUTH' | 'ANALYSIS' | 'TRADE' | 'RISK' | 'BROKER' | 'SETTINGS' | 'SCHEDULER';
  eventType: string;
  summary: string;
  createdAt: string;
}

export interface RiskStatus {
  allowed: boolean;
  reasons: string[];
  simulatedDailyLoss: number;
  simulatedDailyProfit: number;
  netDailyPnl: number;
  dailyTradesCount: number;
  consecutiveLosses: number;
  activeTradesCount: number;
  scheduleOpen: boolean;
  emergencyStop: boolean;
  autoPausedReason: string | null;
  limits: RiskSettings;
}

export interface PeriodPerformanceRow {
  period: string;
  trades: number;
  wins: number;
  losses: number;
  netPnl: number;
  winRatePct: number | null;
}

function getIsoWeekKey(date: Date): string {
  const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export class NovaTradeEngine {
  mode: OperatingMode = 'signals';
  autoPaperArmed = false;
  autoPausedReason: string | null = null;
  lastScanAt: string | null = null;
  lastCycleSummary: string | null = null;
  startingVirtualBalance = 10000;
  selectedDashboardSource: DashboardAccountSource = 'paper';
  private schedulerRunning = false;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  onAutonomousSignalTriggered?: (signal: StoredSignal, stake: number) => Promise<void>;
  getActiveAccountBucket?: () => AccountPerformanceBucket;

  riskSettings: RiskSettings = {
    maxTradeAmount: 100,
    dailyLossLimit: 500,
    dailyProfitTarget: 500,
    maxConsecutiveLosses: 3,
    maxDailyTrades: 25,
    maxSimultaneousTrades: 3,
    maxTradesPerInstrument: 1,
    lossCooldownSeconds: 180,
    minAvailableBalancePct: 10,
    tradingScheduleEnabled: false,
    tradingStartHourUtc: 7,
    tradingEndHourUtc: 20,
    emergencyStop: false,
  };

  aiSettings: AiSettings = {
    strategyProfile: 'balanced',
    minSignalScore: 72,
    requireMtfAlignment: true,
    enabledAssets: ['EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY', 'BTCUSD', 'ETHUSD'],
    defaultTimeframe: '5m',
    expirySeconds: 300,
    scanIntervalSeconds: 60,
    useGeminiCommentary: true,
  };

  paperTrades: PaperTrade[] = [];
  signals: StoredSignal[] = [];
  assistedProposals: AssistedProposal[] = [];
  activityLog: ActivityEvent[] = [];
  readonly learner = new PerformanceLearner();

  private consecutiveLosses = 0;
  private simulatedDailyLoss = 0;
  private simulatedDailyProfit = 0;
  private dailyTradesCount = 0;
  private dailyKey = new Date().toISOString().slice(0, 10);
  private lossCooldownUntilMs = 0;
  private readonly instrumentCooldownUntilMs = new Map<string, number>();
  private readonly pendingShadowSignals: PendingShadowSignal[] = [];
  private externalBrokerTrades: LearnableTradeRecord[] = [];
  private runtimeRecoveryColumnUnavailable = false;
  private readonly persistPath: string | null;
  readonly ownerUserId?: string;

  constructor(
    persistPath: string | null = process.env.NODE_ENV === 'production'
      ? null
      : path.resolve(process.cwd(), '.novatrade-data/state.json'),
    ownerUserId?: string
  ) {
    this.persistPath = process.env.NODE_ENV === 'production' ? null : persistPath;
    this.ownerUserId = ownerUserId;
    this.loadState();
  }

  buildRuntimeRecoveryPayload(): RuntimeRecoveryPayload {
    return {
      pendingShadowSignals: this.pendingShadowSignals.slice(0, 30).map((s) => ({ ...s })),
      assistedProposals: this.assistedProposals.slice(0, 60).map((p) => ({ ...p })),
      learnerState: this.learner.exportState(),
      selectedDashboardSource: this.selectedDashboardSource,
      updatedAt: new Date().toISOString(),
    };
  }

  exportRuntimeRecoveryPayload(): RuntimeRecoveryPayload {
    return this.buildRuntimeRecoveryPayload();
  }

  private applyRuntimeRecoveryPayload(recovery?: Partial<RuntimeRecoveryPayload> | null) {
    if (!recovery || typeof recovery !== 'object') return;
    if (
      recovery.selectedDashboardSource === 'paper' ||
      recovery.selectedDashboardSource === 'mt5' ||
      recovery.selectedDashboardSource === 'iq_option'
    ) {
      this.selectedDashboardSource = recovery.selectedDashboardSource;
    }
    if (recovery.learnerState) {
      this.learner.restoreState(recovery.learnerState);
    }
    if (Array.isArray(recovery.pendingShadowSignals)) {
      for (const item of recovery.pendingShadowSignals) {
        if (!item || !item.symbol || !item.strategy || (item.direction !== 'CALL' && item.direction !== 'PUT')) {
          continue;
        }
        const dup = this.pendingShadowSignals.some(
          (s) => s.symbol === item.symbol && s.timeframe === item.timeframe && s.strategy === item.strategy
        );
        if (!dup && this.pendingShadowSignals.length < 30) {
          this.pendingShadowSignals.push({
            symbol: String(item.symbol),
            timeframe: item.timeframe,
            direction: item.direction,
            strategy: item.strategy,
            entryPrice: Number(item.entryPrice),
            expiresAtMs: Number(item.expiresAtMs),
          });
        }
      }
    }
    if (Array.isArray(recovery.assistedProposals)) {
      const merged = new Map<string, AssistedProposal>();
      for (const existing of this.assistedProposals) {
        if (existing?.id) merged.set(existing.id, existing);
      }
      for (const incoming of recovery.assistedProposals) {
        if (incoming?.id && !merged.has(incoming.id)) {
          merged.set(incoming.id, incoming);
        }
      }
      this.assistedProposals = Array.from(merged.values())
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 60);
    }
  }

  private loadState() {
    if (!this.persistPath) return;
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf8')) as Partial<{
          mode: OperatingMode;
          autoPaperArmed: boolean;
          autoPausedReason: string | null;
          startingVirtualBalance: number;
          riskSettings: RiskSettings;
          aiSettings: AiSettings;
          paperTrades: PaperTrade[];
          externalBrokerTrades: LearnableTradeRecord[];
          signals: StoredSignal[];
          assistedProposals: AssistedProposal[];
          pendingShadowSignals: PendingShadowSignal[];
          selectedDashboardSource: DashboardAccountSource;
          learnerState: PersistedLearnerState;
          activityLog: ActivityEvent[];
          consecutiveLosses: number;
          simulatedDailyLoss: number;
          simulatedDailyProfit: number;
          dailyTradesCount: number;
          dailyKey: string;
        }>;
        if (raw.mode) this.mode = raw.mode;
        if (
          raw.selectedDashboardSource === 'paper' ||
          raw.selectedDashboardSource === 'mt5' ||
          raw.selectedDashboardSource === 'iq_option'
        ) {
          this.selectedDashboardSource = raw.selectedDashboardSource;
        }
        if (typeof raw.autoPaperArmed === 'boolean') this.autoPaperArmed = raw.autoPaperArmed;
        if (raw.autoPausedReason !== undefined) this.autoPausedReason = raw.autoPausedReason;
        if (typeof raw.startingVirtualBalance === 'number' && raw.startingVirtualBalance > 0) {
          this.startingVirtualBalance = raw.startingVirtualBalance;
        }
        if (raw.riskSettings) this.riskSettings = { ...this.riskSettings, ...raw.riskSettings };
        if (raw.aiSettings) this.aiSettings = { ...this.aiSettings, ...raw.aiSettings };
        if (Array.isArray(raw.paperTrades)) this.paperTrades = raw.paperTrades;
        if (Array.isArray(raw.externalBrokerTrades)) this.externalBrokerTrades = raw.externalBrokerTrades;
        if (Array.isArray(raw.signals)) this.signals = raw.signals;
        if (Array.isArray(raw.assistedProposals)) this.assistedProposals = raw.assistedProposals;
        if (Array.isArray(raw.activityLog)) this.activityLog = raw.activityLog;
        if (typeof raw.consecutiveLosses === 'number') this.consecutiveLosses = raw.consecutiveLosses;
        if (typeof raw.simulatedDailyLoss === 'number') this.simulatedDailyLoss = raw.simulatedDailyLoss;
        if (typeof raw.simulatedDailyProfit === 'number') this.simulatedDailyProfit = raw.simulatedDailyProfit;
        if (typeof raw.dailyTradesCount === 'number') this.dailyTradesCount = raw.dailyTradesCount;
        if (raw.dailyKey) this.dailyKey = raw.dailyKey;
        this.applyRuntimeRecoveryPayload({
          pendingShadowSignals: raw.pendingShadowSignals,
          learnerState: raw.learnerState,
          selectedDashboardSource: raw.selectedDashboardSource,
        });
      }
    } catch {
      // Ignore corrupt cache
    }
  }

  private saveState() {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(
        this.persistPath,
        JSON.stringify(
          {
            mode: this.mode,
            selectedDashboardSource: this.selectedDashboardSource,
            autoPaperArmed: this.autoPaperArmed,
            autoPausedReason: this.autoPausedReason,
            startingVirtualBalance: this.startingVirtualBalance,
            riskSettings: this.riskSettings,
            aiSettings: this.aiSettings,
            paperTrades: this.paperTrades.slice(0, 250),
            externalBrokerTrades: this.externalBrokerTrades.slice(0, 250),
            signals: this.signals.slice(0, 150),
            assistedProposals: this.assistedProposals.slice(0, 60),
            pendingShadowSignals: this.pendingShadowSignals.slice(0, 30),
            learnerState: this.learner.exportState(),
            activityLog: this.activityLog.slice(0, 150),
            consecutiveLosses: this.consecutiveLosses,
            simulatedDailyLoss: this.simulatedDailyLoss,
            simulatedDailyProfit: this.simulatedDailyProfit,
            dailyTradesCount: this.dailyTradesCount,
            dailyKey: this.dailyKey,
          },
          null,
          2
        )
      );
    } catch {
      // Non-fatal
    }
  }

  recalculateDailyCountersFromTrades() {
    const today = new Date().toISOString().slice(0, 10);
    this.dailyKey = today;
    const todaysTrades = this.paperTrades.filter((t) => (t.createdAt || '').slice(0, 10) === today && t.status !== 'CANCELLED');
    this.dailyTradesCount = todaysTrades.length;

    const settledToday = todaysTrades
      .filter(
        (t) =>
          t.status === 'SIMULATED_WIN' ||
          t.status === 'SIMULATED_LOSS' ||
          t.status === 'CLOSED_WIN' ||
          t.status === 'CLOSED_LOSS'
      )
      .slice()
      .sort((a, b) => new Date(a.closedAt || a.createdAt).getTime() - new Date(b.closedAt || b.createdAt).getTime());

    let profit = 0;
    let loss = 0;
    let streak = 0;
    for (const t of settledToday) {
      const isWin = t.status.includes('WIN');
      const pnl = t.pnl ?? (isWin ? t.amount * t.payoutRate : -t.amount);
      if (isWin || pnl >= 0) {
        profit += Math.abs(pnl);
        streak = 0;
      } else {
        loss += Math.abs(pnl);
        streak += 1;
      }
    }
    this.simulatedDailyProfit = Number(profit.toFixed(2));
    this.simulatedDailyLoss = Number(loss.toFixed(2));
    this.consecutiveLosses = streak;
  }

  async syncSettingsToSupabase(userId = this.ownerUserId): Promise<boolean> {
    const admin = getSupabaseAdmin();
    if (!admin || !userId || userId === 'local-preview') return false;
    const basePayload = {
      user_id: userId,
      preferred_mode: this.mode,
      paper_trade_amount: this.riskSettings.maxTradeAmount,
      daily_loss_limit: this.riskSettings.dailyLossLimit,
      daily_profit_target: this.riskSettings.dailyProfitTarget,
      max_consecutive_losses: this.riskSettings.maxConsecutiveLosses,
      max_simultaneous_trades: this.riskSettings.maxSimultaneousTrades,
      trading_schedule_enabled: this.riskSettings.tradingScheduleEnabled,
      trading_start_hour_utc: this.riskSettings.tradingStartHourUtc,
      trading_end_hour_utc: this.riskSettings.tradingEndHourUtc,
      emergency_stop: this.riskSettings.emergencyStop,
      auto_paper_armed: this.autoPaperArmed,
      strategy_profile: this.aiSettings.strategyProfile,
      ai_min_score: this.aiSettings.minSignalScore,
      require_mtf_alignment: this.aiSettings.requireMtfAlignment,
      enabled_assets: this.aiSettings.enabledAssets,
      default_timeframe: this.aiSettings.defaultTimeframe,
      expiry_seconds: this.aiSettings.expirySeconds,
      scan_interval_seconds: this.aiSettings.scanIntervalSeconds,
      use_gemini_commentary: this.aiSettings.useGeminiCommentary,
      updated_at: new Date().toISOString(),
    };

    const fullPayload = {
      ...basePayload,
      starting_virtual_balance: this.startingVirtualBalance,
      max_daily_trades: this.riskSettings.maxDailyTrades,
    };

    const payloadWithRecovery = this.runtimeRecoveryColumnUnavailable
      ? fullPayload
      : {
          ...fullPayload,
          runtime_recovery: this.buildRuntimeRecoveryPayload(),
        };

    const { error } = await admin.from('user_settings').upsert(payloadWithRecovery, { onConflict: 'user_id' });
    if (!error) return true;

    if (error.message.includes('runtime_recovery')) {
      this.runtimeRecoveryColumnUnavailable = true;
      const retryFull = await admin.from('user_settings').upsert(fullPayload, { onConflict: 'user_id' });
      if (!retryFull.error) return true;
    }

    const mentionsV2Column =
      error.message.includes('starting_virtual_balance') || error.message.includes('max_daily_trades');
    if (mentionsV2Column) {
      const retry = await admin.from('user_settings').upsert(basePayload, { onConflict: 'user_id' });
      if (!retry.error) return true;
    }

    this.logActivity('SETTINGS', 'SUPABASE_SETTINGS_SYNC_FAILED', `Failed to persist settings to Supabase: ${error.message}`, userId);
    return false;
  }

  async syncRuntimeRecoveryToSupabase(userId = this.ownerUserId): Promise<boolean> {
    const admin = getSupabaseAdmin();
    if (!admin || !userId || userId === 'local-preview' || this.runtimeRecoveryColumnUnavailable) {
      return false;
    }
    const payload = {
      user_id: userId,
      runtime_recovery: this.buildRuntimeRecoveryPayload(),
      updated_at: new Date().toISOString(),
    };
    const { error } = await admin.from('user_settings').upsert(payload, { onConflict: 'user_id' });
    if (!error) return true;
    if (error.message.includes('runtime_recovery') || error.code === 'PGRST204') {
      this.runtimeRecoveryColumnUnavailable = true;
      return false;
    }
    return false;
  }

  restoreFromSupabaseWorkspace(input: {
    settingsRow?: Record<string, unknown> | null;
    tradesRows?: Array<Record<string, unknown>>;
    signalsRows?: Array<Record<string, unknown>>;
  }): { status: 'restored' | 'blocked_emergency_stop' | 'paused_risk' | 'idle' } {
    const s = input.settingsRow;
    if (s) {
      const prefMode = s.preferred_mode;
      if (prefMode === 'signals' || prefMode === 'assisted' || prefMode === 'automatic') {
        this.mode = prefMode;
      }
      if (typeof s.starting_virtual_balance === 'number' && s.starting_virtual_balance > 0) {
        this.startingVirtualBalance = Number(s.starting_virtual_balance);
      }
      this.riskSettings = {
        ...this.riskSettings,
        maxTradeAmount: Number(s.paper_trade_amount ?? this.riskSettings.maxTradeAmount),
        dailyLossLimit: Number(s.daily_loss_limit ?? this.riskSettings.dailyLossLimit),
        dailyProfitTarget: Number(s.daily_profit_target ?? this.riskSettings.dailyProfitTarget),
        maxConsecutiveLosses: Number(s.max_consecutive_losses ?? this.riskSettings.maxConsecutiveLosses),
        maxDailyTrades: Number(s.max_daily_trades ?? this.riskSettings.maxDailyTrades),
        maxSimultaneousTrades: Number(s.max_simultaneous_trades ?? this.riskSettings.maxSimultaneousTrades),
        tradingScheduleEnabled: Boolean(s.trading_schedule_enabled),
        tradingStartHourUtc: Number(s.trading_start_hour_utc ?? this.riskSettings.tradingStartHourUtc),
        tradingEndHourUtc: Number(s.trading_end_hour_utc ?? this.riskSettings.tradingEndHourUtc),
        emergencyStop: Boolean(s.emergency_stop),
      };
      this.aiSettings = {
        ...this.aiSettings,
        strategyProfile:
          s.strategy_profile === 'conservative' || s.strategy_profile === 'balanced' || s.strategy_profile === 'momentum'
            ? s.strategy_profile
            : this.aiSettings.strategyProfile,
        minSignalScore: Number(s.ai_min_score ?? this.aiSettings.minSignalScore),
        requireMtfAlignment: s.require_mtf_alignment !== false,
        enabledAssets: Array.isArray(s.enabled_assets)
          ? (s.enabled_assets as string[])
          : this.aiSettings.enabledAssets,
        defaultTimeframe:
          s.default_timeframe === '1m' ||
          s.default_timeframe === '5m' ||
          s.default_timeframe === '15m' ||
          s.default_timeframe === '1h'
            ? s.default_timeframe
            : this.aiSettings.defaultTimeframe,
        expirySeconds: Number(s.expiry_seconds ?? this.aiSettings.expirySeconds),
        scanIntervalSeconds: Number(s.scan_interval_seconds ?? this.aiSettings.scanIntervalSeconds),
        useGeminiCommentary: s.use_gemini_commentary !== false,
      };
      if (s.runtime_recovery && typeof s.runtime_recovery === 'object') {
        this.applyRuntimeRecoveryPayload(s.runtime_recovery as Partial<RuntimeRecoveryPayload>);
      }
    }

    if (Array.isArray(input.tradesRows) && input.tradesRows.length > 0) {
      const mergedById = new Map<string, PaperTrade>();
      for (const existing of this.paperTrades) {
        if (existing?.id) mergedById.set(existing.id, existing);
      }

      for (const row of input.tradesRows) {
        const rawBucket = typeof row.account_bucket === 'string' ? row.account_bucket : undefined;
        const accountBucket: AccountPerformanceBucket =
          rawBucket === 'MT5_DEMO' ||
          rawBucket === 'MT5_REAL' ||
          rawBucket === 'IQ_OPTION_DEMO' ||
          rawBucket === 'IQ_OPTION_REAL' ||
          rawBucket === 'PAPER_SIMULATOR'
            ? rawBucket
            : 'PAPER_SIMULATOR';
        const rawStrategy = typeof row.strategy_name === 'string' ? row.strategy_name : undefined;
        const strategyName: AdaptiveStrategyName | undefined =
          rawStrategy === 'TREND_CONTINUATION' ||
          rawStrategy === 'RANGE_MEAN_REVERSION' ||
          rawStrategy === 'STRUCTURE_REVERSAL' ||
          rawStrategy === 'VOLATILITY_BREAKOUT' ||
          rawStrategy === 'CAPITAL_PROTECTION'
            ? rawStrategy
            : undefined;
        const mapped: PaperTrade = {
          id: String(row.id),
          userId: this.ownerUserId,
          symbol: String(row.symbol),
          timeframe: (row.timeframe as Timeframe) || '1m',
          direction: row.direction === 'PUT' ? 'PUT' : 'CALL',
          mode: (row.mode as OperatingMode | 'manual') || 'manual',
          amount: Number(row.amount ?? 0),
          payoutRate: Number(row.payout_rate ?? 0.8),
          entryPrice: row.entry_price != null ? Number(row.entry_price) : null,
          exitPrice: row.exit_price != null ? Number(row.exit_price) : null,
          stopLoss: row.stop_loss != null ? Number(row.stop_loss) : null,
          takeProfit: row.take_profit != null ? Number(row.take_profit) : null,
          expirySeconds: Number(row.expiry_seconds ?? 180),
          expiresAt: row.expires_at ? String(row.expires_at) : null,
          status: (row.status as PaperTrade['status']) || 'SIMULATED_PENDING_OUTCOME',
          pnl: row.pnl != null ? Number(row.pnl) : null,
          signalScore: row.signal_score != null ? Number(row.signal_score) : null,
          provider: 'supabase-recovery',
          settledBy: row.settled_by ? String(row.settled_by) : null,
          createdAt: String(row.created_at),
          closedAt: row.closed_at ? String(row.closed_at) : null,
          accountBucket,
          strategyName,
        };

        const existing = mergedById.get(mapped.id);
        if (!existing) {
          mergedById.set(mapped.id, mapped);
        } else {
          const existingPending = existing.status === 'SIMULATED_PENDING_OUTCOME';
          const mappedSettled = mapped.status !== 'SIMULATED_PENDING_OUTCOME';
          mergedById.set(mapped.id, {
            ...mapped,
            ...existing,
            accountBucket: existing.accountBucket ?? mapped.accountBucket,
            strategyName: existing.strategyName ?? mapped.strategyName,
            status: existingPending && mappedSettled ? mapped.status : existing.status,
            exitPrice: existing.exitPrice ?? mapped.exitPrice,
            pnl: existing.pnl ?? mapped.pnl,
            closedAt: existing.closedAt ?? mapped.closedAt,
            settledBy: existing.settledBy ?? mapped.settledBy,
          });
        }
      }

      this.paperTrades = Array.from(mergedById.values())
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 250);
      this.recalculateDailyCountersFromTrades();
    }

    if (this.paperTrades.length > 0 || this.externalBrokerTrades.length > 0) {
      this.learner.analyzeHistory(this.getAllLearnableTrades(), this.aiSettings.minSignalScore);
    }

    if (Array.isArray(input.signalsRows) && input.signalsRows.length > 0 && this.signals.length === 0) {
      this.signals = input.signalsRows.map((row) => {
        const storedScore = Number(row.score ?? 0);
        const dir: 'CALL' | 'PUT' | 'WAIT' = row.direction === 'CALL' || row.direction === 'PUT' ? row.direction : 'WAIT';
        return {
          id: String(row.id),
          symbol: String(row.symbol),
          timeframe: (row.timeframe as Timeframe) || '1m',
          direction: dir,
          score: storedScore,
          confidenceScore: storedScore,
          rawDirectionalConfidence: storedScore,
          actionableConfidence: storedScore,
          confidenceState: dir === 'WAIT' ? 'WEAK_SETUP_WAIT' : 'STRONG_SETUP_ACTIONABLE',
          zeroConfidenceReason:
            storedScore === 0
              ? 'Archived signal recorded 0/100 before confidence pipeline update; run a fresh analysis for live indicator confidence.'
              : null,
          bullishScore: dir === 'PUT' ? 0 : storedScore,
          bearishScore: dir === 'PUT' ? storedScore : 0,
          entryPrice: row.entry_price != null ? Number(row.entry_price) : null,
          suggestedExpirySeconds: Number(row.suggested_expiry_seconds ?? 180),
          provider: String(row.data_source || 'supabase-recovery'),
          marketStatus: 'LIVE',
          isStale: false,
          timestamp: String(row.created_at),
          indicators: (row.indicators as QuantAnalysisResult['indicators']) || null,
          supportingIndicators: null,
          riskAssessment: (row.risk_assessment as QuantAnalysisResult['riskAssessment']) || {
            level: 'MODERATE',
            volatilityRegime: 'UNKNOWN',
            atrPct: null,
            suggestedStakePct: 1,
            summary: 'Restored from Supabase.',
          },
          mtf: null,
          backtest: {
            sampleSize: Number(row.confidence_sample_size ?? 0),
            wins: 0,
            losses: 0,
            winRatePct: row.confidence_win_rate != null ? Number(row.confidence_win_rate) : null,
            expectancyPerUnit: null,
            horizonBars: 3,
            note: 'Restored from Supabase archive.',
          },
          reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [],
          warning: 'Restored from Supabase archive.',
          aiExplanation: row.ai_explanation
            ? { available: true, model: 'gemini-2.5-flash', summary: String(row.ai_explanation), riskNote: null }
            : null,
        };
      });
    }

    // CRITICAL SAFETY: Never resume automatic trading when emergency stop is active
    if (this.riskSettings.emergencyStop) {
      const wasArmed = Boolean(s?.auto_paper_armed) || this.autoPaperArmed;
      this.autoPaperArmed = false;
      this.autoPausedReason = 'Emergency stop is active; automatic trading remains blocked after restart.';
      if (wasArmed) {
        this.logActivity(
          'RISK',
          'SCHEDULER_RECOVERY_BLOCKED',
          'Automatic paper trading recovery blocked on server startup because emergency stop is active.',
          this.ownerUserId
        );
        void this.syncSettingsToSupabase();
      }
      this.saveState();
      return { status: 'blocked_emergency_stop' };
    }

    if (s?.auto_paper_armed) {
      const risk = this.getRiskStatus();
      if (risk.allowed) {
        this.autoPaperArmed = true;
        this.autoPausedReason = null;
        this.mode = 'automatic';
        this.logActivity(
          'SCHEDULER',
          'SCHEDULER_RESTORED',
          `Autonomous paper trading schedule restored after server restart (interval ${this.aiSettings.scanIntervalSeconds}s).`,
          this.ownerUserId
        );
        this.saveState();
        return { status: 'restored' };
      } else {
        this.autoPaperArmed = false;
        this.autoPausedReason = risk.reasons.join(' ');
        this.logActivity(
          'SCHEDULER',
          'SCHEDULER_RECOVERY_PAUSED',
          `Autonomous schedule could not resume after restart due to risk guard: ${this.autoPausedReason}`,
          this.ownerUserId
        );
        void this.syncSettingsToSupabase();
        this.saveState();
        return { status: 'paused_risk' };
      }
    }

    if (s && s.auto_paper_armed === false) {
      this.autoPaperArmed = false;
    }
    this.saveState();
    return { status: 'idle' };
  }

  setStartingVirtualBalance(amount: number, userId?: string) {
    this.startingVirtualBalance = Number(amount.toFixed(2));
    this.logActivity('SETTINGS', 'VIRTUAL_BALANCE_SET', `Starting virtual balance set to ${this.startingVirtualBalance.toFixed(2)}.`, userId);
    this.saveState();
    void this.syncSettingsToSupabase(userId ?? this.ownerUserId);
    return this.getVirtualBalanceSummary();
  }

  getVirtualBalanceSummary() {
    const pendingTrades = this.paperTrades.filter((t) => t.status === 'SIMULATED_PENDING_OUTCOME');
    const reservedBalance = pendingTrades.reduce((acc, t) => acc + t.amount, 0);

    const settled = this.paperTrades.filter(
      (t) =>
        t.status === 'SIMULATED_WIN' ||
        t.status === 'SIMULATED_LOSS' ||
        t.status === 'CLOSED_WIN' ||
        t.status === 'CLOSED_LOSS'
    );
    const settledPnl = settled.reduce((acc, t) => {
      const p = t.pnl ?? (t.status.includes('WIN') ? t.amount * t.payoutRate : -t.amount);
      return acc + p;
    }, 0);

    const totalEquity = Number((this.startingVirtualBalance + settledPnl).toFixed(2));
    const currentBalance = Number((totalEquity - reservedBalance).toFixed(2));

    return {
      startingBalance: this.startingVirtualBalance,
      currentBalance,
      reservedBalance: Number(reservedBalance.toFixed(2)),
      totalEquity,
      totalNetPnl: Number(settledPnl.toFixed(2)),
    };
  }

  logActivity(category: ActivityEvent['category'], eventType: string, summary: string, userId?: string) {
    const entry: ActivityEvent = {
      id: crypto.randomUUID(),
      category,
      eventType,
      summary,
      createdAt: new Date().toISOString(),
    };
    this.activityLog.unshift(entry);
    if (this.activityLog.length > 150) this.activityLog.length = 150;
    this.saveState();

    const admin = getSupabaseAdmin();
    if (admin && userId) {
      void admin
        .from('account_activity')
        .insert({
          id: entry.id,
          user_id: userId,
          category,
          event_type: eventType,
          summary,
          created_at: entry.createdAt,
        })
        .then(() => undefined, () => undefined);
    }
  }

  private rollPaperDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyKey) {
      this.dailyKey = today;
      this.consecutiveLosses = 0;
      this.simulatedDailyLoss = 0;
      this.simulatedDailyProfit = 0;
      this.dailyTradesCount = 0;
      this.autoPausedReason = null;
      this.saveState();
    }
  }

  isWithinTradingSchedule(now = new Date()): boolean {
    if (!this.riskSettings.tradingScheduleEnabled) return true;
    const hour = now.getUTCHours();
    const start = this.riskSettings.tradingStartHourUtc;
    const end = this.riskSettings.tradingEndHourUtc;
    if (start <= end) return hour >= start && hour <= end;
    return hour >= start || hour <= end;
  }

  getActiveTrades(): PaperTrade[] {
    return this.paperTrades.filter((t) => t.status === 'SIMULATED_PENDING_OUTCOME');
  }

  getRiskStatus(): RiskStatus {
    this.rollPaperDay();
    const reasons: string[] = [];
    const activeTradesCount = this.getActiveTrades().length;
    const scheduleOpen = this.isWithinTradingSchedule();

    if (this.riskSettings.emergencyStop) reasons.push('Emergency stop is engaged.');
    if (!scheduleOpen) {
      reasons.push(
        `Outside configured UTC trading schedule (${this.riskSettings.tradingStartHourUtc}:00–${this.riskSettings.tradingEndHourUtc}:00 UTC).`
      );
    }
    if (this.simulatedDailyLoss >= this.riskSettings.dailyLossLimit) reasons.push('Daily loss limit reached.');
    if (this.simulatedDailyProfit >= this.riskSettings.dailyProfitTarget) reasons.push('Daily profit target reached.');
    if (this.consecutiveLosses >= this.riskSettings.maxConsecutiveLosses) reasons.push('Maximum consecutive losses reached.');
    if (this.dailyTradesCount >= this.riskSettings.maxDailyTrades) {
      reasons.push(`Maximum daily trades (${this.riskSettings.maxDailyTrades}) reached.`);
    }
    if (activeTradesCount >= this.riskSettings.maxSimultaneousTrades) {
      reasons.push(`Maximum simultaneous trades (${this.riskSettings.maxSimultaneousTrades}) reached.`);
    }
    if (this.lossCooldownUntilMs > Date.now()) {
      const remainingSec = Math.ceil((this.lossCooldownUntilMs - Date.now()) / 1000);
      reasons.push(`Post-loss cooldown active (${remainingSec}s remaining after repeated losses).`);
    }

    return {
      allowed: reasons.length === 0,
      reasons,
      simulatedDailyLoss: Number(this.simulatedDailyLoss.toFixed(2)),
      simulatedDailyProfit: Number(this.simulatedDailyProfit.toFixed(2)),
      netDailyPnl: Number((this.simulatedDailyProfit - this.simulatedDailyLoss).toFixed(2)),
      dailyTradesCount: this.dailyTradesCount,
      consecutiveLosses: this.consecutiveLosses,
      activeTradesCount,
      scheduleOpen,
      emergencyStop: this.riskSettings.emergencyStop,
      autoPausedReason: this.autoPausedReason,
      limits: { ...this.riskSettings },
    };
  }

  calculateRecommendedStake(score: number): number {
    const remainingLossBudget = Math.max(0, this.riskSettings.dailyLossLimit - this.simulatedDailyLoss);
    const scoreFactor = score >= 82 ? 1.0 : score >= 72 ? 0.75 : 0.5;
    const lossStepDown = Math.pow(0.75, this.consecutiveLosses);
    const raw = Math.min(
      this.riskSettings.maxTradeAmount * scoreFactor * lossStepDown,
      remainingLossBudget * 0.35
    );
    return Math.max(1, Math.round(raw * 100) / 100);
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>
  ): Promise<R[]> {
    const limit = Math.max(1, concurrency);
    const results = new Array<R>(items.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await fn(items[idx]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return results;
  }

  resolveEffectiveExpirySeconds(analysis: QuantAnalysisResult): number {
    if (typeof analysis.effectiveExpirySeconds === 'number' && analysis.effectiveExpirySeconds > 0) {
      return analysis.effectiveExpirySeconds;
    }
    const compat = analysis.timeframeExpiryCompatibility;
    if (compat) {
      return compat.compatible && compat.requestedExpirySeconds
        ? compat.requestedExpirySeconds
        : compat.recommendedExpirySeconds || analysis.suggestedExpirySeconds;
    }
    return analysis.suggestedExpirySeconds || this.aiSettings.expirySeconds || 300;
  }

  async analyseAsset(
    symbol: string,
    timeframe: Timeframe = this.aiSettings.defaultTimeframe,
    includeGemini = this.aiSettings.useGeminiCommentary,
    userId: string | undefined = this.ownerUserId,
    options?: { skipLearnerRecompute?: boolean; requestedExpirySeconds?: number }
  ): Promise<{ analysis: StoredSignal; marketError?: string }> {
    const requestedExpiry = options?.requestedExpirySeconds ?? this.aiSettings.expirySeconds;
    const primary = await fetchMarketCandles(symbol, timeframe, 160);
    if (!primary.ok) {
      const fallback = analyzeMarketQuant(symbol, timeframe, [], primary.provider, {
        minScore: this.aiSettings.minSignalScore,
        requireMtfAlignment: this.aiSettings.requireMtfAlignment,
        strategyProfile: this.aiSettings.strategyProfile,
        marketStatus: primary.marketStatus,
        isStale: true,
        requestedExpirySeconds: requestedExpiry,
      });
      const stored: StoredSignal = {
        ...fallback,
        id: crypto.randomUUID(),
        aiExplanation: null,
      };
      return { analysis: stored, marketError: primary.error };
    }

    const higherTf = getHigherTimeframe(timeframe);
    const htfResult = await fetchMarketCandles(symbol, higherTf, 100);
    if (!options?.skipLearnerRecompute) {
      this.learner.analyzeHistory(this.getAllLearnableTrades(), this.aiSettings.minSignalScore);
    }
    const historicalBias = this.learner.getBiasForSetup(symbol, timeframe);

    const quant = analyzeMarketQuant(symbol, timeframe, primary.candles, primary.provider, {
      minScore: this.aiSettings.minSignalScore,
      requireMtfAlignment: this.aiSettings.requireMtfAlignment,
      strategyProfile: this.aiSettings.strategyProfile,
      marketStatus: primary.marketStatus,
      isStale: primary.isStale,
      higherTimeframeCandles: htfResult.ok ? { timeframe: higherTf, candles: htfResult.candles } : null,
      historicalBias,
      requestedExpirySeconds: requestedExpiry,
    });

    const aiExplanation = includeGemini ? await generateGeminiExplanation(quant) : null;
    const stored: StoredSignal = {
      ...quant,
      id: crypto.randomUUID(),
      aiExplanation,
    };

    this.signals.unshift(stored);
    if (this.signals.length > 150) this.signals.length = 150;
    this.saveState();

    const admin = getSupabaseAdmin();
    if (admin && userId) {
      void admin
        .from('trading_signals')
        .insert({
          id: stored.id,
          user_id: userId,
          symbol: stored.symbol,
          timeframe: stored.timeframe,
          direction: stored.direction,
          score: stored.score,
          entry_price: stored.entryPrice,
          suggested_expiry_seconds: stored.suggestedExpirySeconds,
          confidence_win_rate: stored.backtest.winRatePct,
          confidence_sample_size: stored.backtest.sampleSize,
          mtf_alignment: stored.mtf?.alignment || null,
          indicators: stored.indicators || {},
          risk_assessment: stored.riskAssessment,
          reasons: stored.reasons,
          ai_explanation: stored.aiExplanation?.summary || null,
          data_source: stored.provider,
          created_at: stored.timestamp,
        })
        .then(() => undefined, () => undefined);
    }

    return { analysis: stored };
  }

  async scanSingleAsset(
    symbol: string,
    timeframe: Timeframe = this.aiSettings.defaultTimeframe,
    userId: string | undefined = this.ownerUserId,
    options?: { skipLearnerRecompute?: boolean }
  ) {
    const assetMeta = SUPPORTED_ASSETS.find((a) => a.symbol === symbol);
    const { analysis, marketError } = await this.analyseAsset(symbol, timeframe, false, userId, options);
    this.lastScanAt = new Date().toISOString();
    this.saveState();
    return {
      symbol: analysis.symbol,
      name: assetMeta?.name || analysis.symbol,
      category: assetMeta?.category || 'FX',
      instrumentType: assetMeta?.instrumentType || 'FOREX',
      timeframe: analysis.timeframe,
      direction: analysis.direction,
      score: analysis.score,
      rawDirectionalConfidence: analysis.rawDirectionalConfidence ?? analysis.score,
      actionableConfidence: analysis.actionableConfidence ?? analysis.score,
      confidenceState: analysis.confidenceState,
      zeroConfidenceReason: analysis.zeroConfidenceReason ?? null,
      suggestedExpirySeconds: analysis.suggestedExpirySeconds,
      requestedExpirySeconds: analysis.requestedExpirySeconds ?? this.aiSettings.expirySeconds,
      effectiveExpirySeconds: this.resolveEffectiveExpirySeconds(analysis),
      expiryAdjusted: analysis.expiryAdjusted ?? false,
      expiryAdjustmentReason: analysis.expiryAdjustmentReason ?? null,
      entryPrice: analysis.entryPrice,
      provider: analysis.provider,
      marketStatus: analysis.marketStatus,
      isStale: analysis.isStale,
      trend: analysis.indicators?.trend || 'UNAVAILABLE',
      rsi14: analysis.indicators?.rsi14 ?? null,
      volatility: analysis.indicators?.volatilityRegime || 'UNAVAILABLE',
      mtfAlignment: analysis.mtf?.alignment || 'NEUTRAL',
      backtestWinRate: analysis.backtest.winRatePct,
      backtestSampleSize: analysis.backtest.sampleSize,
      riskLevel: analysis.riskAssessment.level,
      marketRegime: analysis.marketRegime ?? null,
      activeStrategy: analysis.activeStrategy ?? null,
      timeframeExpiryCompatibility: analysis.timeframeExpiryCompatibility ?? null,
      reasons: analysis.reasons,
      error: marketError || null,
      timestamp: analysis.timestamp,
    };
  }

  async scanMarkets(symbols?: string[], timeframe: Timeframe = this.aiSettings.defaultTimeframe) {
    const targetSymbols = (symbols && symbols.length > 0 ? symbols : this.aiSettings.enabledAssets).slice(0, 14);
    this.learner.analyzeHistory(this.getAllLearnableTrades(), this.aiSettings.minSignalScore);
    const results = await this.mapWithConcurrency(targetSymbols, 4, (sym) =>
      this.scanSingleAsset(sym, timeframe, this.ownerUserId, { skipLearnerRecompute: true })
    );
    this.lastScanAt = new Date().toISOString();
    this.saveState();
    return results;
  }

  createAssistedProposal(
    analysis: StoredSignal,
    meta?: { sourceApp?: 'MT5' | 'IQ_OPTION' | 'UNKNOWN'; screenAnalysisId?: string }
  ): AssistedProposal | null {
    if (analysis.direction === 'WAIT' || analysis.isStale || !isLiveMarketStatus(analysis.marketStatus)) return null;
    const recommendedAmount = this.calculateRecommendedStake(analysis.score);
    const proposal: AssistedProposal = {
      id: crypto.randomUUID(),
      symbol: analysis.symbol,
      timeframe: analysis.timeframe,
      direction: analysis.direction,
      score: analysis.score,
      recommendedAmount,
      entryPrice: analysis.entryPrice,
      expirySeconds: this.resolveEffectiveExpirySeconds(analysis),
      requestedExpirySeconds: analysis.requestedExpirySeconds ?? this.aiSettings.expirySeconds,
      expiryAdjusted: analysis.expiryAdjusted ?? false,
      expiryAdjustmentReason: analysis.expiryAdjustmentReason ?? null,
      reasons: analysis.reasons,
      status: 'PENDING_APPROVAL',
      createdAt: new Date().toISOString(),
      decidedAt: null,
      ...(analysis.activeStrategy ? { strategyName: analysis.activeStrategy } : {}),
      ...(meta?.sourceApp ? { sourceApp: meta.sourceApp } : analysis.sourceApp ? { sourceApp: analysis.sourceApp } : {}),
      ...(meta?.screenAnalysisId
        ? { screenAnalysisId: meta.screenAnalysisId }
        : analysis.screenAnalysisId
          ? { screenAnalysisId: analysis.screenAnalysisId }
          : {}),
    };
    this.assistedProposals.unshift(proposal);
    if (this.assistedProposals.length > 60) this.assistedProposals.length = 60;
    this.logActivity(
      'ANALYSIS',
      'ASSISTED_PROPOSAL',
      `Assisted proposal created: ${proposal.direction} ${proposal.symbol} (${proposal.score}/100, stake ${proposal.recommendedAmount}).`,
      this.ownerUserId
    );
    this.saveState();
    void this.syncRuntimeRecoveryToSupabase();
    return proposal;
  }

  async integrateAndroidScreenVision(input: {
    appName: 'MT5' | 'IQ_OPTION' | 'UNKNOWN';
    accountMode: 'DEMO' | 'PRACTICE' | 'REAL' | 'UNKNOWN';
    symbol: string | null;
    timeframe: Timeframe | null;
    detectedPrice: number | null;
    visualBias: 'CALL' | 'PUT' | 'WAIT';
    visualConfidence: number;
    summary: string;
    riskWarning: string;
    observations: string[];
    model: string;
    userId?: string;
  }): Promise<{ signal: StoredSignal; marketError?: string; quantMatched: boolean }> {
    const tf: Timeframe = input.timeframe ?? this.aiSettings.defaultTimeframe;
    const candidateSymbol = input.symbol || 'UNKNOWN';
    const canQueryMarket = /^[A-Z0-9_-]{3,20}$/.test(candidateSymbol) && candidateSymbol !== 'UNKNOWN';

    let stored: StoredSignal;
    let marketError: string | undefined;
    let quantMatched = false;

    if (canQueryMarket) {
      const primary = await fetchMarketCandles(candidateSymbol, tf, 160);
      if (primary.ok) {
        quantMatched = true;
        const higherTf = getHigherTimeframe(tf);
        const htfResult = await fetchMarketCandles(candidateSymbol, higherTf, 100);
        this.learner.analyzeHistory(this.getAllLearnableTrades(), this.aiSettings.minSignalScore);
        const historicalBias = this.learner.getBiasForSetup(candidateSymbol, tf);
        const quant = analyzeMarketQuant(candidateSymbol, tf, primary.candles, primary.provider, {
          minScore: this.aiSettings.minSignalScore,
          requireMtfAlignment: this.aiSettings.requireMtfAlignment,
          strategyProfile: this.aiSettings.strategyProfile,
          marketStatus: primary.marketStatus,
          isStale: primary.isStale,
          higherTimeframeCandles: htfResult.ok ? { timeframe: higherTf, candles: htfResult.candles } : null,
          historicalBias,
          requestedExpirySeconds: this.aiSettings.expirySeconds,
        });

        let fusedDirection: 'CALL' | 'PUT' | 'WAIT' = quant.direction;
        let fusedScore = quant.score;
        const fusedReasons = [...quant.reasons];

        if (quant.direction !== 'WAIT' && input.visualBias !== 'WAIT') {
          if (quant.direction === input.visualBias) {
            fusedScore = Math.min(100, Math.round(quant.score * 0.7 + input.visualConfidence * 0.3));
            fusedReasons.unshift(`Android ${input.appName} visual structure aligns (${input.visualBias}, ${input.visualConfidence}/100).`);
          } else {
            fusedDirection = 'WAIT';
            fusedScore = Math.min(45, quant.score);
            fusedReasons.unshift(
              `Downgraded to WAIT: visual ${input.appName} chart bias (${input.visualBias}) conflicts with quantitative candles (${quant.direction}).`
            );
          }
        } else if (input.observations.length > 0) {
          fusedReasons.unshift(`Android ${input.appName} vision: ${input.observations[0]}`);
        }

        stored = {
          ...quant,
          id: crypto.randomUUID(),
          direction: fusedDirection,
          score: fusedScore,
          confidenceScore: fusedScore,
          actionableConfidence: quant.isStale ? 0 : fusedScore,
          confidenceState: quant.isStale
            ? 'STALE_OR_UNAVAILABLE'
            : fusedDirection === 'WAIT'
              ? 'WEAK_SETUP_WAIT'
              : 'STRONG_SETUP_ACTIONABLE',
          sourceApp: input.appName,
          accountModeDetected: input.accountMode,
          aiExplanation: {
            available: true,
            model: input.model,
            summary: input.summary,
            riskNote: input.riskWarning,
          },
          reasons: fusedReasons,
        };
      } else {
        marketError = primary.error;
        stored = this.buildVisionOnlySignal({ ...input, symbol: candidateSymbol, timeframe: tf });
      }
    } else {
      stored = this.buildVisionOnlySignal({ ...input, symbol: candidateSymbol, timeframe: tf });
    }

    this.signals.unshift(stored);
    if (this.signals.length > 150) this.signals.length = 150;
    this.saveState();

    const admin = getSupabaseAdmin();
    if (admin && input.userId && input.userId !== 'local-preview') {
      void admin
        .from('trading_signals')
        .insert({
          id: stored.id,
          user_id: input.userId,
          symbol: stored.symbol,
          timeframe: stored.timeframe,
          direction: stored.direction,
          score: stored.score,
          entry_price: stored.entryPrice,
          suggested_expiry_seconds: stored.suggestedExpirySeconds,
          confidence_win_rate: stored.backtest.winRatePct,
          confidence_sample_size: stored.backtest.sampleSize,
          mtf_alignment: stored.mtf?.alignment || null,
          indicators: stored.indicators || {},
          risk_assessment: stored.riskAssessment,
          reasons: stored.reasons,
          ai_explanation: stored.aiExplanation?.summary || null,
          data_source: stored.provider,
          created_at: stored.timestamp,
        })
        .then(() => undefined, () => undefined);
    }

    return { signal: stored, marketError, quantMatched };
  }

  private buildVisionOnlySignal(input: {
    appName: 'MT5' | 'IQ_OPTION' | 'UNKNOWN';
    accountMode: 'DEMO' | 'PRACTICE' | 'REAL' | 'UNKNOWN';
    symbol: string;
    timeframe: Timeframe;
    detectedPrice: number | null;
    visualBias: 'CALL' | 'PUT' | 'WAIT';
    visualConfidence: number;
    summary: string;
    riskWarning: string;
    observations: string[];
    model: string;
  }): StoredSignal {
    const score = Math.max(0, Math.min(100, input.visualConfidence));
    const compat = evaluateTimeframeExpiryCompatibility(input.timeframe, this.aiSettings.expirySeconds);
    return {
      id: crypto.randomUUID(),
      symbol: input.symbol,
      timeframe: input.timeframe,
      direction: score >= this.aiSettings.minSignalScore ? input.visualBias : 'WAIT',
      score,
      confidenceScore: score,
      rawDirectionalConfidence: score,
      actionableConfidence: score >= this.aiSettings.minSignalScore ? score : 0,
      confidenceState: score >= this.aiSettings.minSignalScore ? 'STRONG_SETUP_ACTIONABLE' : 'WEAK_SETUP_WAIT',
      bullishScore: input.visualBias === 'CALL' ? score : 0,
      bearishScore: input.visualBias === 'PUT' ? score : 0,
      entryPrice: input.detectedPrice,
      suggestedExpirySeconds: compat.recommendedExpirySeconds,
      requestedExpirySeconds: this.aiSettings.expirySeconds,
      effectiveExpirySeconds: compat.compatible ? this.aiSettings.expirySeconds : compat.recommendedExpirySeconds,
      expiryAdjusted: !compat.compatible,
      expiryAdjustmentReason: !compat.compatible ? compat.note : null,
      timeframeExpiryCompatibility: compat,
      provider: `android-vision-${input.appName.toLowerCase()}`,
      marketStatus: 'OPEN',
      isStale: false,
      timestamp: new Date().toISOString(),
      indicators: null,
      supportingIndicators: null,
      riskAssessment: {
        level: 'MODERATE',
        volatilityRegime: 'UNKNOWN',
        atrPct: null,
        suggestedStakePct: 1,
        summary: 'Derived from Android mobile screenshot OCR & chart vision (live candle feed unavailable for this symbol).',
      },
      mtf: null,
      backtest: {
        sampleSize: 0,
        wins: 0,
        losses: 0,
        winRatePct: null,
        expectancyPerUnit: null,
        horizonBars: 3,
        note: 'Screen-vision analysis only; no candle backtest sample.',
      },
      reasons: input.observations.length > 0 ? input.observations : ['Derived from mobile trading screenshot.'],
      warning: 'Visual screen analysis only. Confirm price and account mode on your phone before trading.',
      sourceApp: input.appName,
      accountModeDetected: input.accountMode,
      aiExplanation: {
        available: true,
        model: input.model,
        summary: input.summary,
        riskNote: input.riskWarning,
      },
    };
  }

  openPaperTrade(input: {
    symbol: string;
    timeframe?: Timeframe;
    direction: 'CALL' | 'PUT';
    amount: number;
    mode: OperatingMode | 'manual';
    entryPrice?: number | null;
    atr?: number | null;
    expirySeconds?: number;
    requestedExpirySeconds?: number;
    expiryAdjusted?: boolean;
    expiryAdjustmentReason?: string | null;
    signalScore?: number | null;
    provider?: string;
    pendingOutcome?: boolean;
    userId?: string;
    accountBucket?: AccountPerformanceBucket;
    strategyName?: AdaptiveStrategyName;
    signalId?: string;
  }): { ok: boolean; trade?: PaperTrade; error?: string; risk?: RiskStatus } {
    const risk = this.getRiskStatus();
    if (!risk.allowed) {
      return { ok: false, error: `Risk guard blocked trade: ${risk.reasons.join(' ')}`, risk };
    }
    const balanceSummary = this.getVirtualBalanceSummary();
    if (input.amount > balanceSummary.currentBalance) {
      return {
        ok: false,
        error: `Insufficient available virtual balance ($${balanceSummary.currentBalance.toFixed(2)}) for stake ($${input.amount}).`,
        risk,
      };
    }
    if (input.amount > this.riskSettings.maxTradeAmount) {
      return {
        ok: false,
        error: `Stake ($${input.amount}) exceeds the maximum allowed stake of $${this.riskSettings.maxTradeAmount} per individual trade.`,
        risk,
      };
    }
    const remainingBudget = this.riskSettings.dailyLossLimit - this.simulatedDailyLoss;
    if (input.amount > remainingBudget) {
      return {
        ok: false,
        error: `Stake (${input.amount}) exceeds remaining daily loss budget (${remainingBudget.toFixed(2)}).`,
        risk,
      };
    }

    // Instrument-specific exposure limit & minimum reserve protection for autonomous execution
    const maxPerInst = Math.max(1, this.riskSettings.maxTradesPerInstrument ?? 1);
    const activeOnSymbol = this.getActiveTrades().filter((t) => t.symbol === input.symbol).length;
    if (input.mode === 'automatic' && activeOnSymbol >= maxPerInst) {
      return {
        ok: false,
        error: `Instrument exposure limit reached for ${input.symbol} (max ${maxPerInst} simultaneous trade).`,
        risk,
      };
    }
    const symCooldownUntil = this.instrumentCooldownUntilMs.get(input.symbol) || 0;
    if (input.mode === 'automatic' && symCooldownUntil > Date.now()) {
      const rem = Math.ceil((symCooldownUntil - Date.now()) / 1000);
      return {
        ok: false,
        error: `Instrument cooldown active for ${input.symbol} (${rem}s remaining after repeated losses).`,
        risk,
      };
    }
    if (input.mode === 'automatic') {
      const minReservePct = Math.max(0, Math.min(50, this.riskSettings.minAvailableBalancePct ?? 10));
      const minReserveFloor = Number(((this.startingVirtualBalance * minReservePct) / 100).toFixed(2));
      if (balanceSummary.currentBalance - input.amount < minReserveFloor) {
        return {
          ok: false,
          error: `Minimum balance reserve ($${minReserveFloor.toFixed(2)}, ${minReservePct}%) would be breached by stake ($${input.amount}).`,
          risk,
        };
      }
      const recentDuplicate = this.paperTrades.find(
        (t) =>
          t.symbol === input.symbol &&
          t.direction === input.direction &&
          t.status !== 'CANCELLED' &&
          Date.now() - new Date(t.createdAt).getTime() < 10_000
      );
      if (recentDuplicate) {
        return {
          ok: false,
          error: `Duplicate-order protection: ${input.direction} ${input.symbol} was already opened within the last 10 seconds.`,
          risk,
        };
      }
    }

    const expirySeconds = input.expirySeconds ?? this.aiSettings.expirySeconds;
    const now = Date.now();
    const pending = input.pendingOutcome ?? true;
    const entry = input.entryPrice ?? null;

    let stopLoss: number | null = null;
    let takeProfit: number | null = null;
    if (entry != null && entry > 0) {
      // ATR-aware SL/TP when ATR is supplied (clamped safely to 0.15%..1.5% of price); preserves 0.5% fallback
      const rawDelta = input.atr != null && input.atr > 0 ? input.atr * 1.5 : entry * 0.005;
      const delta = Math.max(entry * 0.0015, Math.min(entry * 0.015, rawDelta));
      const tpDelta = delta * 1.6;
      const decimals = entry > 100 ? 2 : 5;
      if (input.direction === 'CALL') {
        stopLoss = Number((entry - delta).toFixed(decimals));
        takeProfit = Number((entry + tpDelta).toFixed(decimals));
      } else {
        stopLoss = Number((entry + delta).toFixed(decimals));
        takeProfit = Number((entry - tpDelta).toFixed(decimals));
      }
    }

    const trade: PaperTrade = {
      id: crypto.randomUUID(),
      userId: input.userId,
      symbol: input.symbol,
      timeframe: input.timeframe ?? this.aiSettings.defaultTimeframe,
      direction: input.direction,
      mode: input.mode,
      amount: Number(input.amount.toFixed(2)),
      payoutRate: 0.8,
      entryPrice: entry,
      exitPrice: null,
      stopLoss,
      takeProfit,
      expirySeconds,
      requestedExpirySeconds: input.requestedExpirySeconds ?? expirySeconds,
      expiryAdjusted: input.expiryAdjusted ?? false,
      expiryAdjustmentReason: input.expiryAdjustmentReason ?? null,
      expiresAt: pending ? new Date(now + expirySeconds * 1000).toISOString() : null,
      status: pending ? 'SIMULATED_PENDING_OUTCOME' : 'SIMULATED_NOT_EXECUTED',
      pnl: null,
      signalScore: input.signalScore ?? null,
      provider: input.provider ?? 'market-feed',
      settledBy: null,
      createdAt: new Date(now).toISOString(),
      closedAt: null,
      accountBucket: input.accountBucket ?? this.getActiveAccountBucket?.() ?? 'PAPER_SIMULATOR',
      strategyName: input.strategyName,
      signalId: input.signalId,
    };

    this.dailyTradesCount += 1;
    this.paperTrades.unshift(trade);
    if (this.paperTrades.length > 300) this.paperTrades.length = 300;
    this.logActivity(
      'TRADE',
      'PAPER_TRADE_OPENED',
      `Paper trade ${trade.direction} ${trade.symbol} (stake ${trade.amount}, mode=${trade.mode}, bucket=${trade.accountBucket}, entry=${trade.entryPrice ?? 'N/A'}, SL=${stopLoss ?? 'N/A'}, TP=${takeProfit ?? 'N/A'}).`,
      input.userId
    );
    this.saveState();

    const admin = getSupabaseAdmin();
    if (admin && input.userId) {
      const baseInsert = {
        id: trade.id,
        user_id: input.userId,
        symbol: trade.symbol,
        timeframe: trade.timeframe,
        direction: trade.direction,
        mode: trade.mode,
        amount: trade.amount,
        payout_rate: trade.payoutRate,
        entry_price: trade.entryPrice,
        stop_loss: trade.stopLoss,
        take_profit: trade.takeProfit,
        expiry_seconds: trade.expirySeconds,
        expires_at: trade.expiresAt,
        status: trade.status,
        signal_score: trade.signalScore,
        created_at: trade.createdAt,
      };
      const fullInsert = {
        ...baseInsert,
        account_bucket: trade.accountBucket ?? 'PAPER_SIMULATOR',
        strategy_name: trade.strategyName ?? null,
      };
      void admin
        .from('paper_trades')
        .insert(fullInsert)
        .then(
          async ({ error }) => {
            if (!error) return;
            const missingV3Col =
              error.message.includes('account_bucket') || error.message.includes('strategy_name');
            if (missingV3Col) {
              const retry = await admin.from('paper_trades').insert(baseInsert);
              if (!retry.error) return;
            }
            this.logActivity(
              'TRADE',
              'SUPABASE_TRADE_SYNC_FAILED',
              `Paper trade Supabase insert warning: ${error.message}`,
              input.userId
            );
          },
          () => undefined
        );
    }

    return { ok: true, trade };
  }

  settlePaperTrade(
    tradeId: string,
    outcome: 'win' | 'loss',
    pnlInput?: number,
    exitPrice?: number | null,
    settledBy = 'manual'
  ): { ok: boolean; trade?: PaperTrade; error?: string; status?: number } {
    const trade = this.paperTrades.find((t) => t.id === tradeId);
    if (!trade || trade.status !== 'SIMULATED_PENDING_OUTCOME') {
      return { ok: false, error: 'Pending paper trade not found.', status: 404 };
    }

    const pnl =
      pnlInput !== undefined
        ? Number(pnlInput.toFixed(2))
        : outcome === 'win'
          ? Number((trade.amount * trade.payoutRate).toFixed(2))
          : trade.amount;

    if (outcome === 'loss' && pnl > trade.amount) {
      return { ok: false, error: 'Simulated loss cannot exceed trade stake.', status: 400 };
    }

    trade.status = outcome === 'win' ? 'SIMULATED_WIN' : 'SIMULATED_LOSS';
    trade.exitPrice = exitPrice ?? trade.exitPrice;
    trade.pnl = outcome === 'win' ? pnl : -pnl;
    trade.settledBy = settledBy;
    trade.closedAt = new Date().toISOString();

    if (outcome === 'win') {
      this.simulatedDailyProfit += pnl;
      this.consecutiveLosses = 0;
      this.lossCooldownUntilMs = 0;
      this.instrumentCooldownUntilMs.delete(trade.symbol);
    } else {
      this.simulatedDailyLoss += pnl;
      this.consecutiveLosses += 1;
      const baseCooldownSec = Math.max(0, this.riskSettings.lossCooldownSeconds ?? 180);
      if (this.consecutiveLosses >= 2 && baseCooldownSec > 0 && trade.mode === 'automatic') {
        this.lossCooldownUntilMs = Date.now() + baseCooldownSec * 1000 * (this.consecutiveLosses - 1);
      }
      // Track symbol-specific consecutive losses for per-instrument cooldown
      const recentSymTrades = this.paperTrades
        .filter((t) => t.symbol === trade.symbol && (t.status.includes('WIN') || t.status.includes('LOSS')))
        .slice(0, 2);
      if (recentSymTrades.length >= 2 && recentSymTrades.every((t) => t.status.includes('LOSS')) && baseCooldownSec > 0) {
        this.instrumentCooldownUntilMs.set(trade.symbol, Date.now() + Math.max(baseCooldownSec * 2, 300) * 1000);
      }
    }

    this.learner.analyzeHistory(this.getAllLearnableTrades(), this.aiSettings.minSignalScore);

    const risk = this.getRiskStatus();
    if (!risk.allowed && this.autoPaperArmed) {
      const isTemporaryGuard = risk.reasons.every(
        (r) => r.includes('simultaneous trades') || r.includes('max open') || r.includes('cooldown')
      );
      if (!isTemporaryGuard) {
        this.autoPaperArmed = false;
        this.autoPausedReason = risk.reasons.join(' ');
        this.logActivity('RISK', 'AUTO_PAUSED', `Automatic paper trading paused: ${this.autoPausedReason}`, trade.userId);
        void this.syncSettingsToSupabase(trade.userId ?? this.ownerUserId);
      }
    }

    this.logActivity(
      'TRADE',
      outcome === 'win' ? 'PAPER_TRADE_WON' : 'PAPER_TRADE_LOST',
      `Settled ${trade.direction} ${trade.symbol} (${outcome.toUpperCase()}, PnL ${trade.pnl >= 0 ? '+' : ''}${trade.pnl}, by ${settledBy}).`,
      trade.userId
    );
    this.saveState();
    void this.syncRuntimeRecoveryToSupabase(trade.userId ?? this.ownerUserId);

    const admin = getSupabaseAdmin();
    if (admin && trade.userId) {
      void admin
        .from('paper_trades')
        .update({
          status: trade.status,
          exit_price: trade.exitPrice,
          pnl: trade.pnl,
          result_amount: Math.abs(trade.pnl),
          settled_by: trade.settledBy,
          closed_at: trade.closedAt,
        })
        .eq('id', trade.id)
        .then(() => undefined, () => undefined);

      void admin
        .from('trade_results')
        .insert({
          user_id: trade.userId,
          paper_trade_id: trade.id,
          symbol: trade.symbol,
          direction: trade.direction,
          mode: trade.mode,
          stake: trade.amount,
          pnl: trade.pnl,
          outcome: outcome === 'win' ? 'WIN' : 'LOSS',
          entry_price: trade.entryPrice,
          exit_price: trade.exitPrice,
          settled_at: trade.closedAt,
        })
        .then(() => undefined, () => undefined);
    }

    return { ok: true, trade };
  }

  cancelPaperTrade(tradeId: string): { ok: boolean; trade?: PaperTrade; error?: string } {
    const trade = this.paperTrades.find((t) => t.id === tradeId);
    if (!trade || trade.status !== 'SIMULATED_PENDING_OUTCOME') {
      return { ok: false, error: 'Pending paper trade not found.' };
    }
    trade.status = 'CANCELLED';
    trade.pnl = 0;
    trade.settledBy = 'user-cancelled';
    trade.closedAt = new Date().toISOString();
    this.logActivity('TRADE', 'PAPER_TRADE_CANCELLED', `Cancelled paper trade ${trade.symbol} (${trade.id.slice(0, 8)}).`, trade.userId);
    this.saveState();

    const admin = getSupabaseAdmin();
    if (admin && trade.userId) {
      void admin
        .from('paper_trades')
        .update({
          status: 'CANCELLED',
          pnl: 0,
          settled_by: 'user-cancelled',
          closed_at: trade.closedAt,
        })
        .eq('id', trade.id)
        .then(() => undefined, () => undefined);
    }

    return { ok: true, trade };
  }

  hydrateFromClient(payload: {
    mode?: OperatingMode;
    autoPaperArmed?: boolean;
    paperTrades?: PaperTrade[];
    signals?: StoredSignal[];
    riskSettings?: Partial<RiskSettings>;
    aiSettings?: Partial<AiSettings>;
    startingVirtualBalance?: number;
  }) {
    if (Array.isArray(payload.paperTrades) && payload.paperTrades.length > 0 && this.paperTrades.length === 0) {
      const seen = new Set<string>();
      const deduped: PaperTrade[] = [];
      for (const t of payload.paperTrades) {
        if (!t?.id || seen.has(t.id)) continue;
        seen.add(t.id);
        deduped.push({ ...t, userId: this.ownerUserId });
      }
      this.paperTrades = deduped;
      this.recalculateDailyCountersFromTrades();
      this.learner.analyzeHistory(this.getAllLearnableTrades(), this.aiSettings.minSignalScore);
    }
    if (Array.isArray(payload.signals) && payload.signals.length > 0 && this.signals.length === 0) {
      this.signals = payload.signals;
    }
    if (payload.riskSettings) {
      this.riskSettings = { ...this.riskSettings, ...payload.riskSettings };
    }
    if (payload.aiSettings) {
      this.aiSettings = { ...this.aiSettings, ...payload.aiSettings };
    }
    if (typeof payload.startingVirtualBalance === 'number' && payload.startingVirtualBalance > 0) {
      this.startingVirtualBalance = payload.startingVirtualBalance;
    }
    if (payload.mode && (payload.mode === 'signals' || payload.mode === 'assisted' || payload.mode === 'automatic')) {
      this.mode = payload.mode;
    }
    if (this.riskSettings.emergencyStop) {
      this.autoPaperArmed = false;
      this.autoPausedReason = 'Emergency stop is active; automatic trading remains blocked.';
    } else if (typeof payload.autoPaperArmed === 'boolean' && payload.autoPaperArmed) {
      const risk = this.getRiskStatus();
      if (risk.allowed) {
        this.autoPaperArmed = true;
      }
    }
    this.saveState();
  }

  setEmergencyStop(engaged: boolean, userId?: string) {
    this.riskSettings.emergencyStop = engaged;
    if (engaged) {
      this.autoPaperArmed = false;
      this.autoPausedReason = 'Emergency stop engaged by user.';
      this.logActivity('RISK', 'EMERGENCY_STOP_ON', 'Emergency stop engaged. Automatic trading halted.', userId);
    } else {
      this.autoPausedReason = null;
      this.logActivity('RISK', 'EMERGENCY_STOP_OFF', 'Emergency stop cleared.', userId);
    }
    this.saveState();
    void this.syncSettingsToSupabase(userId ?? this.ownerUserId);
    return this.getRiskStatus();
  }

  resetDailyRiskCounters(userId?: string) {
    this.consecutiveLosses = 0;
    this.simulatedDailyLoss = 0;
    this.simulatedDailyProfit = 0;
    this.dailyTradesCount = 0;
    this.lossCooldownUntilMs = 0;
    this.instrumentCooldownUntilMs.clear();
    this.autoPausedReason = null;
    this.dailyKey = new Date().toISOString().slice(0, 10);
    this.logActivity('RISK', 'DAILY_COUNTERS_RESET', 'Daily simulated risk counters reset.', userId);
    this.saveState();
    return this.getRiskStatus();
  }

  getAllLearnableTrades(): LearnableTradeRecord[] {
    // Verified external broker outcomes appear first so signalId/brokerOrderId dedup preserves real broker settlement over synthetic duplicates
    return [...this.externalBrokerTrades, ...this.paperTrades];
  }

  ingestBrokerOutcomes(records: LearnableTradeRecord[]): {
    added: number;
    updated: number;
    insights: LearningInsights;
  } {
    let added = 0;
    let updated = 0;
    for (const raw of records) {
      if (!raw || !raw.id) continue;
      // Enrich missing strategyName or signalScore from matching paper trade / signal when linked
      const matchedPaper = raw.signalId
        ? this.paperTrades.find((p) => p.signalId === raw.signalId)
        : undefined;
      const matchedSignal = raw.signalId
        ? this.signals.find((s) => s.id === raw.signalId)
        : undefined;

      const enriched: LearnableTradeRecord = {
        ...raw,
        strategyName: raw.strategyName ?? matchedPaper?.strategyName ?? matchedSignal?.activeStrategy,
        signalScore: raw.signalScore ?? matchedPaper?.signalScore ?? matchedSignal?.score ?? null,
        timeframe: matchedPaper?.timeframe ?? matchedSignal?.timeframe ?? raw.timeframe,
      };

      const existingIdx = this.externalBrokerTrades.findIndex(
        (x) =>
          x.id === enriched.id ||
          (enriched.brokerOrderId != null && x.brokerOrderId === enriched.brokerOrderId)
      );
      if (existingIdx >= 0) {
        const prev = this.externalBrokerTrades[existingIdx];
        if (prev.pnl !== enriched.pnl || prev.status !== enriched.status || prev.accountBucket !== enriched.accountBucket) {
          this.externalBrokerTrades[existingIdx] = enriched;
          updated += 1;
        }
      } else {
        this.externalBrokerTrades.unshift(enriched);
        added += 1;
      }
    }
    if (this.externalBrokerTrades.length > 300) this.externalBrokerTrades.length = 300;
    if (added > 0 || updated > 0) {
      this.saveState();
      void this.syncRuntimeRecoveryToSupabase();
    }
    const insights = this.learner.analyzeHistory(this.getAllLearnableTrades(), this.aiSettings.minSignalScore);
    return { added, updated, insights };
  }

  getLearningInsights(): LearningInsights {
    return this.learner.analyzeHistory(this.getAllLearnableTrades(), this.aiSettings.minSignalScore);
  }

  getAnalytics() {
    const settled = this.paperTrades.filter(
      (t) =>
        t.status === 'SIMULATED_WIN' ||
        t.status === 'SIMULATED_LOSS' ||
        t.status === 'CLOSED_WIN' ||
        t.status === 'CLOSED_LOSS'
    );
    const wins = settled.filter((t) => t.status === 'SIMULATED_WIN' || t.status === 'CLOSED_WIN');
    const losses = settled.filter((t) => t.status === 'SIMULATED_LOSS' || t.status === 'CLOSED_LOSS');

    let grossProfit = 0;
    let grossLoss = 0;
    let runningEquity = 0;
    let peakEquity = 0;
    let maxDrawdown = 0;

    const chronological = [...settled].reverse();
    const equityCurve: Array<{ index: number; timestamp: string; symbol: string; equity: number; pnl: number }> = [];

    const dailyMap = new Map<string, { trades: number; wins: number; losses: number; netPnl: number }>();
    const weeklyMap = new Map<string, { trades: number; wins: number; losses: number; netPnl: number }>();
    const monthlyMap = new Map<string, { trades: number; wins: number; losses: number; netPnl: number }>();

    chronological.forEach((t, idx) => {
      const isWin = t.status.includes('WIN');
      const pnl = t.pnl ?? (isWin ? t.amount * t.payoutRate : -t.amount);
      if (pnl >= 0) grossProfit += pnl;
      else grossLoss += Math.abs(pnl);

      runningEquity = Number((runningEquity + pnl).toFixed(2));
      if (runningEquity > peakEquity) peakEquity = runningEquity;
      const dd = peakEquity - runningEquity;
      if (dd > maxDrawdown) maxDrawdown = dd;

      const ts = t.closedAt || t.createdAt;
      equityCurve.push({
        index: idx + 1,
        timestamp: ts,
        symbol: t.symbol,
        equity: runningEquity,
        pnl: Number(pnl.toFixed(2)),
      });

      const dt = new Date(ts);
      const dayKey = dt.toISOString().slice(0, 10);
      const weekKey = getIsoWeekKey(dt);
      const monthKey = dt.toISOString().slice(0, 7);

      for (const [map, key] of [
        [dailyMap, dayKey],
        [weeklyMap, weekKey],
        [monthlyMap, monthKey],
      ] as const) {
        const cur = map.get(key) || { trades: 0, wins: 0, losses: 0, netPnl: 0 };
        cur.trades += 1;
        if (isWin) cur.wins += 1;
        else cur.losses += 1;
        cur.netPnl = Number((cur.netPnl + pnl).toFixed(2));
        map.set(key, cur);
      }
    });

    const toPeriodRows = (map: Map<string, { trades: number; wins: number; losses: number; netPnl: number }>, limit: number): PeriodPerformanceRow[] =>
      Array.from(map.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-limit)
        .map(([period, v]) => ({
          period,
          trades: v.trades,
          wins: v.wins,
          losses: v.losses,
          netPnl: v.netPnl,
          winRatePct: v.trades > 0 ? Number(((v.wins / v.trades) * 100).toFixed(1)) : null,
        }));

    const bySymbolMap = new Map<string, { symbol: string; trades: number; wins: number; losses: number; netPnl: number }>();
    for (const t of settled) {
      const row = bySymbolMap.get(t.symbol) || { symbol: t.symbol, trades: 0, wins: 0, losses: 0, netPnl: 0 };
      row.trades += 1;
      const isWin = t.status.includes('WIN');
      if (isWin) row.wins += 1;
      else row.losses += 1;
      const pnl = t.pnl ?? (isWin ? t.amount * t.payoutRate : -t.amount);
      row.netPnl = Number((row.netPnl + pnl).toFixed(2));
      bySymbolMap.set(t.symbol, row);
    }

    const total = settled.length;
    const balance = this.getVirtualBalanceSummary();
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayBucket = dailyMap.get(todayKey);

    return {
      startingVirtualBalance: balance.startingBalance,
      currentVirtualBalance: balance.currentBalance,
      todayPnl: todayBucket?.netPnl ?? 0,
      todayTrades: todayBucket?.trades ?? 0,
      totalTrades: total,
      activeTrades: this.getActiveTrades().length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: total > 0 ? Number(((wins.length / total) * 100).toFixed(1)) : null,
      grossProfit: Number(grossProfit.toFixed(2)),
      grossLoss: Number(grossLoss.toFixed(2)),
      netPnl: Number((grossProfit - grossLoss).toFixed(2)),
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 999 : null,
      maxDrawdown: Number(maxDrawdown.toFixed(2)),
      equityCurve,
      dailyStats: toPeriodRows(dailyMap, 14),
      weeklyStats: toPeriodRows(weeklyMap, 8),
      monthlyStats: toPeriodRows(monthlyMap, 6),
      bySymbol: Array.from(bySymbolMap.values()),
    };
  }

  async monitorAndSettleExpiredTrades() {
    const now = Date.now();
    const activeTrades = this.paperTrades.filter((t) => t.status === 'SIMULATED_PENDING_OUTCOME');
    let settledCount = 0;

    for (const trade of activeTrades) {
      const feed = await fetchMarketCandles(trade.symbol, trade.timeframe, 15, true);
      if (!feed.ok || feed.currentPrice == null) continue;
      const currentPrice = feed.currentPrice;
      const entry = trade.entryPrice ?? currentPrice;
      const isExpired = trade.expiresAt && new Date(trade.expiresAt).getTime() <= now;

      let triggerOutcome: 'win' | 'loss' | null = null;
      let settledBy = 'auto-expiry-monitor';
      let exitPrice = currentPrice;

      if (trade.direction === 'CALL') {
        if (trade.stopLoss != null && currentPrice <= trade.stopLoss) {
          triggerOutcome = 'loss';
          settledBy = 'stop-loss-triggered';
          exitPrice = trade.stopLoss;
        } else if (trade.takeProfit != null && currentPrice >= trade.takeProfit) {
          triggerOutcome = 'win';
          settledBy = 'take-profit-triggered';
          exitPrice = trade.takeProfit;
        } else if (isExpired) {
          triggerOutcome = currentPrice > entry ? 'win' : 'loss';
          settledBy = 'auto-expiry-monitor';
          exitPrice = currentPrice;
        }
      } else { // PUT
        if (trade.stopLoss != null && currentPrice >= trade.stopLoss) {
          triggerOutcome = 'loss';
          settledBy = 'stop-loss-triggered';
          exitPrice = trade.stopLoss;
        } else if (trade.takeProfit != null && currentPrice <= trade.takeProfit) {
          triggerOutcome = 'win';
          settledBy = 'take-profit-triggered';
          exitPrice = trade.takeProfit;
        } else if (isExpired) {
          triggerOutcome = currentPrice < entry ? 'win' : 'loss';
          settledBy = 'auto-expiry-monitor';
          exitPrice = currentPrice;
        }
      }

      if (triggerOutcome) {
        this.settlePaperTrade(trade.id, triggerOutcome, undefined, exitPrice, settledBy);
        settledCount++;
      }
    }
    return settledCount;
  }

  getPendingShadowSignalsCount(): number {
    return this.pendingShadowSignals.length;
  }

  getPendingShadowSignals(): PendingShadowSignal[] {
    return this.pendingShadowSignals.map((s) => ({ ...s }));
  }

  recordShadowSignalForTesting(shadow: PendingShadowSignal): void {
    this.pendingShadowSignals.push({ ...shadow });
    this.saveState();
  }

  async settlePendingShadowSignals(): Promise<number> {
    if (this.riskSettings.emergencyStop) return 0;
    const nowMs = Date.now();
    let settledCount = 0;
    for (let idx = this.pendingShadowSignals.length - 1; idx >= 0; idx--) {
      const shadow = this.pendingShadowSignals[idx];
      if (shadow.expiresAtMs > nowMs) continue;
      const feed = await fetchMarketCandles(shadow.symbol, shadow.timeframe, 10, true);
      if (!feed.ok || feed.currentPrice == null) continue;
      const won =
        (shadow.direction === 'CALL' && feed.currentPrice > shadow.entryPrice) ||
        (shadow.direction === 'PUT' && feed.currentPrice < shadow.entryPrice);
      const updatedState = this.learner.recordShadowValidation(shadow.strategy, won);
      this.pendingShadowSignals.splice(idx, 1);
      settledCount += 1;
      if (!updatedState.paused) {
        this.logActivity(
          'ANALYSIS',
          'STRATEGY_AUTO_RESUMED',
          `Strategy ${shadow.strategy} resumed automatically after validated shadow performance recovered.`,
          this.ownerUserId
        );
      }
    }
    if (settledCount > 0) {
      this.saveState();
      void this.syncRuntimeRecoveryToSupabase();
    }
    return settledCount;
  }

  private recordShadowSignal(analysis: StoredSignal): boolean {
    if (!analysis.activeStrategy || analysis.entryPrice == null) return false;
    if (analysis.direction !== 'CALL' && analysis.direction !== 'PUT') return false;
    const dup = this.pendingShadowSignals.some(
      (s) => s.symbol === analysis.symbol && s.timeframe === analysis.timeframe && s.strategy === analysis.activeStrategy
    );
    if (dup || this.pendingShadowSignals.length >= 30) return false;
    this.pendingShadowSignals.push({
      symbol: analysis.symbol,
      timeframe: analysis.timeframe,
      direction: analysis.direction,
      strategy: analysis.activeStrategy,
      entryPrice: analysis.entryPrice,
      expiresAtMs: Date.now() + this.resolveEffectiveExpirySeconds(analysis) * 1000,
    });
    this.saveState();
    void this.syncRuntimeRecoveryToSupabase();
    return true;
  }

  /**
   * Unified autonomous signal evaluation and execution pipeline shared by
   * runAutonomousCycle() and POST /api/auto-paper/evaluate.
   */
  async evaluateAndExecuteAutonomousSignal(
    symbol: string,
    timeframe: Timeframe = this.aiSettings.defaultTimeframe,
    options: {
      allowExecution?: boolean;
      includeGemini?: boolean;
      precomputed?: { analysis: StoredSignal; marketError?: string };
      skipLearnerRecompute?: boolean;
    } = {}
  ): Promise<{
    analysis: StoredSignal;
    action: 'OPENED' | 'WAIT' | 'SHADOW_RECORDED' | 'SKIPPED_RISK' | 'SKIPPED_ACTIVE' | 'SKIPPED_COOLDOWN';
    trade?: PaperTrade;
    reason: string;
    risk: RiskStatus;
  }> {
    const riskBefore = this.getRiskStatus();
    if (this.riskSettings.emergencyStop) {
      const { analysis } = options.precomputed
        ? options.precomputed
        : await this.analyseAsset(symbol, timeframe, false, this.ownerUserId, {
            skipLearnerRecompute: options.skipLearnerRecompute,
          });
      return {
        analysis,
        action: 'SKIPPED_RISK',
        reason: 'Emergency Stop is engaged; autonomous analysis/execution paused.',
        risk: this.getRiskStatus(),
      };
    }

    const { analysis, marketError } = options.precomputed
      ? options.precomputed
      : await this.analyseAsset(symbol, timeframe, Boolean(options.includeGemini), this.ownerUserId, {
          skipLearnerRecompute: options.skipLearnerRecompute,
        });
    const riskNow = this.getRiskStatus();

    if (marketError) {
      return { analysis, action: 'WAIT', reason: `Market data unavailable: ${marketError}`, risk: riskNow };
    }
    if (analysis.isStale || !isLiveMarketStatus(analysis.marketStatus)) {
      return {
        analysis,
        action: 'WAIT',
        reason: `Market status is ${analysis.marketStatus}; signal suppressed to WAIT.`,
        risk: riskNow,
      };
    }
    if (analysis.direction !== 'CALL' && analysis.direction !== 'PUT') {
      return {
        analysis,
        action: 'WAIT',
        reason: analysis.rejectionReasons?.[0] || 'Quantitative engine decision is WAIT. No trade opened.',
        risk: riskNow,
      };
    }

    // Intelligent Performance Protection: EVERY automatic path checks isStrategyPaused()
    // and records shadow validation while paused instead of executing trades.
    const strategyCheck = this.learner.isStrategyPaused(analysis.activeStrategy);
    if (strategyCheck.paused && analysis.activeStrategy) {
      this.recordShadowSignal(analysis);
      return {
        analysis,
        action: 'SHADOW_RECORDED',
        reason: strategyCheck.reason || `Strategy ${analysis.activeStrategy} is paused; shadow validation signal recorded.`,
        risk: riskNow,
      };
    }

    const allowExec = options.allowExecution ?? riskNow.allowed;
    if (!allowExec || !riskNow.allowed) {
      return {
        analysis,
        action: 'SKIPPED_RISK',
        reason: `Risk guard deferred live entry: ${riskNow.reasons.join(' ')}`,
        risk: riskNow,
      };
    }

    const activeOnSymbol = this.getActiveTrades().some((t) => t.symbol === analysis.symbol);
    if (activeOnSymbol) {
      return {
        analysis,
        action: 'SKIPPED_ACTIVE',
        reason: `Active pending position already open on ${analysis.symbol}.`,
        risk: riskNow,
      };
    }

    const symCooldown = this.instrumentCooldownUntilMs.get(analysis.symbol) || 0;
    if (symCooldown > Date.now()) {
      const rem = Math.ceil((symCooldown - Date.now()) / 1000);
      return {
        analysis,
        action: 'SKIPPED_COOLDOWN',
        reason: `Instrument cooldown active for ${analysis.symbol} (${rem}s remaining).`,
        risk: riskNow,
      };
    }

    // Anti-martingale position sizing + selected account bucket attribution
    const recommended = this.calculateRecommendedStake(analysis.score);
    const stake = Math.min(recommended, this.riskSettings.maxTradeAmount, this.getVirtualBalanceSummary().currentBalance);
    const accountBucket = this.getActiveAccountBucket?.() ?? 'PAPER_SIMULATOR';
    const placed = this.openPaperTrade({
      symbol: analysis.symbol,
      timeframe: analysis.timeframe,
      direction: analysis.direction,
      amount: stake,
      mode: 'automatic',
      entryPrice: analysis.entryPrice,
      atr: analysis.indicators?.atr14 ?? null,
      expirySeconds: this.resolveEffectiveExpirySeconds(analysis),
      requestedExpirySeconds: analysis.requestedExpirySeconds ?? this.aiSettings.expirySeconds,
      expiryAdjusted: analysis.expiryAdjusted ?? false,
      expiryAdjustmentReason: analysis.expiryAdjustmentReason ?? null,
      signalScore: analysis.score,
      provider: analysis.provider,
      pendingOutcome: true,
      userId: this.ownerUserId,
      accountBucket,
      strategyName: analysis.activeStrategy,
      signalId: analysis.id,
    });

    if (!placed.ok || !placed.trade) {
      return {
        analysis,
        action: 'SKIPPED_RISK',
        reason: placed.error || 'Trade blocked by risk control.',
        risk: placed.risk || riskBefore,
      };
    }

    if (this.onAutonomousSignalTriggered && !this.riskSettings.emergencyStop) {
      await this.onAutonomousSignalTriggered(analysis, stake).catch(() => undefined);
    }

    return {
      analysis,
      action: 'OPENED',
      trade: placed.trade,
      reason: `Opened ${placed.trade.direction} ${placed.trade.symbol} (${analysis.activeStrategy || 'ADAPTIVE'}, bucket=${accountBucket}).`,
      risk: this.getRiskStatus(),
    };
  }

  async runAutonomousCycle(forceScan = false): Promise<{ settled: number; opened: PaperTrade[]; summary: string }> {
    if (this.schedulerRunning) {
      return { settled: 0, opened: [], summary: 'Cycle skipped; previous cycle still active.' };
    }
    this.schedulerRunning = true;
    try {
      const settled = await this.monitorAndSettleExpiredTrades();
      const opened: PaperTrade[] = [];

      if (this.riskSettings.emergencyStop) {
        this.autoPaperArmed = false;
        this.autoPausedReason = 'Emergency stop is engaged.';
        const summary = settled > 0 ? `Settled ${settled} expired trade(s). Emergency stop engaged.` : 'Emergency stop engaged.';
        this.lastCycleSummary = summary;
        return { settled, opened, summary };
      }

      if (!this.autoPaperArmed) {
        const summary = settled > 0 ? `Settled ${settled} expired trade(s). Auto mode paused.` : 'Auto mode paused.';
        this.lastCycleSummary = summary;
        return { settled, opened, summary };
      }

      // Evaluate any pending shadow signals FIRST so temporary risk restrictions (cooldowns / max open trades)
      // never block validated shadow outcomes from resuming paused strategies.
      const shadowSettled = await this.settlePendingShadowSignals();

      const lastScanMs = this.lastScanAt ? new Date(this.lastScanAt).getTime() : 0;
      const elapsedMs = Date.now() - lastScanMs;
      if (!forceScan && elapsedMs < this.aiSettings.scanIntervalSeconds * 1000) {
        const summary = settled > 0 || shadowSettled > 0
          ? `Settled ${settled} trade(s) and ${shadowSettled} shadow signal(s). Next scan in ${Math.ceil((this.aiSettings.scanIntervalSeconds * 1000 - elapsedMs) / 1000)}s.`
          : this.lastCycleSummary || 'Waiting for next scheduled scan interval.';
        return { settled, opened, summary };
      }

      const riskCheck = this.getRiskStatus();
      const isTemporaryWait =
        !riskCheck.allowed &&
        riskCheck.reasons.every(
          (r) => r.includes('simultaneous trades') || r.includes('max open') || r.includes('cooldown')
        );

      if (!riskCheck.allowed && !isTemporaryWait) {
        this.autoPaperArmed = false;
        this.autoPausedReason = riskCheck.reasons.join(' ');
        this.logActivity('RISK', 'AUTO_PAUSED', `Autonomous scheduler paused: ${this.autoPausedReason}`, this.ownerUserId);
        this.saveState();
        void this.syncSettingsToSupabase();
        this.lastCycleSummary = `Auto paused: ${this.autoPausedReason}`;
        return { settled, opened, summary: this.lastCycleSummary };
      }

      const hasPausedStrategy = this.learner.getPausedStrategies().length > 0;
      if (isTemporaryWait && !hasPausedStrategy) {
        this.lastCycleSummary = `Waiting (Auto armed): ${riskCheck.reasons.join(' ')}`;
        return { settled, opened, summary: this.lastCycleSummary };
      }

      if (riskCheck.allowed && this.autoPausedReason) {
        this.autoPausedReason = null;
      }

      const activeSymbols = new Set(this.getActiveTrades().map((t) => t.symbol));
      this.learner.analyzeHistory(this.getAllLearnableTrades(), this.aiSettings.minSignalScore);

      const scanTargets = this.aiSettings.enabledAssets.filter(
        (symbol) => hasPausedStrategy || !activeSymbols.has(symbol) || !riskCheck.allowed
      );
      const analyzedCandidates = await this.mapWithConcurrency(scanTargets, 4, async (symbol) => ({
        symbol,
        computed: await this.analyseAsset(symbol, this.aiSettings.defaultTimeframe, false, this.ownerUserId, {
          skipLearnerRecompute: true,
        }),
      }));

      // Prioritize highest-conviction actionable setups first so simultaneous exposure caps allocate to strongest signals
      analyzedCandidates.sort((a, b) => {
        const aAct = a.computed.analysis.direction !== 'WAIT' ? 1 : 0;
        const bAct = b.computed.analysis.direction !== 'WAIT' ? 1 : 0;
        if (aAct !== bAct) return bAct - aAct;
        return b.computed.analysis.score - a.computed.analysis.score;
      });

      let decisionsRecorded = 0;
      let shadowRecorded = 0;
      let waitCount = 0;

      for (const candidate of analyzedCandidates) {
        const currentRisk = this.getRiskStatus();
        const currentTempWait =
          !currentRisk.allowed &&
          currentRisk.reasons.every(
            (r) => r.includes('simultaneous trades') || r.includes('max open') || r.includes('cooldown')
          );
        if (!currentRisk.allowed && !currentTempWait) {
          this.autoPaperArmed = false;
          this.autoPausedReason = currentRisk.reasons.join(' ');
          void this.syncSettingsToSupabase();
          break;
        }
        if (currentRisk.allowed && activeSymbols.has(candidate.symbol)) continue;

        const res = await this.evaluateAndExecuteAutonomousSignal(
          candidate.symbol,
          this.aiSettings.defaultTimeframe,
          {
            allowExecution: currentRisk.allowed,
            precomputed: candidate.computed,
            skipLearnerRecompute: true,
          }
        );
        decisionsRecorded += 1;
        if (res.action === 'OPENED' && res.trade) {
          opened.push(res.trade);
          activeSymbols.add(candidate.symbol);
        } else if (res.action === 'SHADOW_RECORDED') {
          shadowRecorded += 1;
        } else if (res.action === 'WAIT') {
          waitCount += 1;
        }
      }

      this.lastScanAt = new Date().toISOString();
      const summary = `Settled ${settled} trade(s), ${shadowSettled} shadow signal(s); scanned ${decisionsRecorded} instrument(s) (${waitCount} WAIT); opened ${opened.length} trade(s), recorded ${shadowRecorded} shadow setup(s).`;
      this.lastCycleSummary = summary;
      this.logActivity('SCHEDULER', 'AUTO_SCAN_CYCLE', summary, this.ownerUserId);
      this.saveState();
      return { settled, opened, summary };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Autonomous scheduler cycle failed';
      this.lastCycleSummary = `Cycle failed: ${msg}`;
      this.logActivity('SCHEDULER', 'AUTO_CYCLE_FAILED', this.lastCycleSummary, this.ownerUserId);
      throw err;
    } finally {
      this.schedulerRunning = false;
    }
  }

  getAutonomousStatus(): 'SCANNING' | 'ANALYZING' | 'WAITING FOR OPPORTUNITY' | 'TRADE EXECUTED' | 'MANAGING POSITION' | 'RISK PAUSED' {
    const risk = this.getRiskStatus();
    if (!risk.allowed || this.riskSettings.emergencyStop) {
      return 'RISK PAUSED';
    }
    if (this.getActiveTrades().length > 0) {
      return 'MANAGING POSITION';
    }
    const recentTrade = this.paperTrades[0];
    if (recentTrade && (Date.now() - new Date(recentTrade.createdAt).getTime() < 45000) && recentTrade.mode === 'automatic') {
      return 'TRADE EXECUTED';
    }
    if (this.schedulerRunning) {
      return 'SCANNING';
    }
    if (this.autoPaperArmed) {
      return 'WAITING FOR OPPORTUNITY';
    }
    return 'WAITING FOR OPPORTUNITY';
  }

  startScheduler(tickIntervalMs = 5_000) {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => {
      void this.runAutonomousCycle(false).catch(() => undefined);
    }, tickIntervalMs);
  }

  stopScheduler() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }
}

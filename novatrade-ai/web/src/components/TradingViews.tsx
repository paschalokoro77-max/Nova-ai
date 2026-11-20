import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  Clock,
  Download,
  Play,
  Radar,
  RefreshCw,
  Search,
  Wallet,
  XCircle,
} from 'lucide-react';
import type {
  AnalyticsSummary,
  AssetDefinition,
  AssistedProposal,
  BrokerOrderType,
  BrokerOrderValidationResult,
  ManagedBrokerAccountPublic,
  OperatingMode,
  PaperTrade,
  RiskStatus,
  ScannerRow,
  SignalRecord,
  Timeframe,
} from '../types';
import { useAutoSave } from '../hooks/useAutoSave';
import {
  CARD_SURFACE,
  INPUT_CLASS,
  SELECT_CLASS,
  SUBTLE_PANEL,
  SaveStatusIndicator,
} from './ui';
import {
  EquityChart,
  PeriodPerformanceChart,
  WinLossDistributionChart,
} from './EquityChart';

interface ScannerProps {
  assets: AssetDefinition[];
  rows: ScannerRow[];
  timeframe: Timeframe;
  scanning: boolean;
  scanProgress: {
    active: boolean;
    completed: number;
    total: number;
    currentSymbol: string | null;
    latestDirection: 'CALL' | 'PUT' | 'WAIT' | null;
  };
  onTimeframeChange: (tf: Timeframe) => void;
  onRunScan: (symbols: string[]) => void;
  onSelectAsset: (symbol: string) => void;
}

export function MarketScannerView({
  assets,
  rows,
  timeframe,
  scanning,
  scanProgress,
  onTimeframeChange,
  onRunScan,
  onSelectAsset,
}: ScannerProps) {
  const [filterDir, setFilterDir] = useState<'ALL' | 'CALL' | 'PUT' | 'WAIT'>('ALL');
  const [query, setQuery] = useState('');
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(() =>
    assets.length > 0 ? assets.slice(0, 8).map((a) => a.symbol) : ['EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY', 'BTCUSD', 'ETHUSD']
  );

  useEffect(() => {
    if (assets.length > 0 && selectedSymbols.length === 0) {
      setSelectedSymbols(assets.slice(0, 8).map((a) => a.symbol));
    }
  }, [assets, selectedSymbols.length]);

  function toggleSymbol(sym: string) {
    setSelectedSymbols((prev) => {
      if (prev.includes(sym)) {
        return prev.length <= 1 ? prev : prev.filter((s) => s !== sym);
      }
      return [...prev, sym];
    });
  }

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filterDir !== 'ALL' && r.direction !== filterDir) return false;
      if (query.trim() && !r.symbol.toLowerCase().includes(query.trim().toLowerCase())) return false;
      return true;
    });
  }, [rows, filterDir, query]);

  const progressPct =
    scanProgress.total > 0 ? Math.min(100, Math.round((scanProgress.completed / scanProgress.total) * 100)) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">AI Market Scanner</h2>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
            Progressive multi-asset quantitative scan separating verified Forex, Crypto, and Commodity feeds.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-[#070C17] p-1">
            {(['1m', '5m', '15m', '1h'] as Timeframe[]).map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => onTimeframeChange(tf)}
                className={`min-h-9 px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-all ${
                  timeframe === tf
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm border border-slate-200/80 dark:border-slate-700'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border border-transparent'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onRunScan(selectedSymbols)}
            disabled={scanning}
            className="min-h-11 inline-flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shadow-sm shadow-blue-600/20 transition-all"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} />
            {scanning ? `Scanning ${scanProgress.completed}/${scanProgress.total}...` : `Scan ${selectedSymbols.length} Selected`}
          </button>
        </div>
      </div>

      {/* Scanning Progress Panel */}
      {(scanning || scanProgress.total > 0) && (
        <div className={`${CARD_SURFACE} p-4 relative overflow-hidden`}>
          {scanning && (
            <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-slate-200 dark:bg-slate-800">
              <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-blue-500 to-indigo-400 animate-scan-sweep" />
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-xl border ${
                  scanning
                    ? 'border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400'
                    : 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400'
                }`}
              >
                <Radar className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} />
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-900 dark:text-white">
                  {scanning
                    ? `Analysing ${scanProgress.currentSymbol || 'market feed'} (${scanProgress.completed} / ${scanProgress.total})`
                    : `Scan complete · ${scanProgress.completed} / ${scanProgress.total} instruments evaluated`}
                </p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {scanProgress.latestDirection
                    ? `Latest evaluation direction: ${scanProgress.latestDirection} on ${timeframe}`
                    : 'Computing EMA 9/21/50, RSI, MACD, Bollinger Bands, S/R, and MTF alignment'}
                </p>
              </div>
            </div>
            <span className="font-mono tabular-nums text-xs font-semibold text-blue-600 dark:text-indigo-400">
              {progressPct}%
            </span>
          </div>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              style={{ width: `${progressPct}%` }}
              className="h-full bg-blue-600 dark:bg-indigo-500 transition-all duration-300"
            />
          </div>
        </div>
      )}

      {/* Instrument Selector */}
      <div className={`${CARD_SURFACE} p-4 sm:p-5 space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            Selected Instruments ({selectedSymbols.length} / {assets.length || 13})
          </p>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => setSelectedSymbols(assets.filter((a) => a.instrumentType === 'FOREX').map((a) => a.symbol))}
              className="min-h-9 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap transition-colors"
            >
              Forex Only
            </button>
            <button
              type="button"
              onClick={() => setSelectedSymbols(assets.map((a) => a.symbol))}
              className="min-h-9 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap transition-colors"
            >
              Select All
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {assets.map((a) => {
            const active = selectedSymbols.includes(a.symbol);
            return (
              <button
                key={a.symbol}
                type="button"
                onClick={() => toggleSymbol(a.symbol)}
                className={`min-h-10 inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                  active
                    ? 'border-blue-500/70 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070C17] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {active && <Check className="h-3 w-3" />}
                <span>{a.symbol}</span>
                <span className="text-[10px] opacity-70">{a.instrumentType}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:w-64">
          <Search className="h-4 w-4 text-slate-400 absolute left-3.5 top-3.5" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter symbol..."
            className={`${INPUT_CLASS} pl-10 text-xs`}
          />
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-[#070C17] p-1">
          {(['ALL', 'CALL', 'PUT', 'WAIT'] as const).map((dir) => (
            <button
              key={dir}
              type="button"
              onClick={() => setFilterDir(dir)}
              className={`min-h-9 px-3 py-1 text-xs font-medium rounded-lg whitespace-nowrap transition-all ${
                filterDir === dir
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm border border-slate-200/80 dark:border-slate-700'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border border-transparent'
              }`}
            >
              {dir}
            </button>
          ))}
        </div>
      </div>

      {/* Results Table */}
      <div className={`${CARD_SURFACE} overflow-x-auto`}>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200/90 dark:border-slate-800 text-slate-500 dark:text-slate-400">
              <th className="px-4 py-3 font-medium">Instrument</th>
              <th className="px-4 py-3 font-medium">Decision</th>
              <th className="px-4 py-3 font-medium text-right">Confidence</th>
              <th className="px-4 py-3 font-medium text-right">Entry Price</th>
              <th className="px-4 py-3 font-medium text-right">Expiry</th>
              <th className="px-4 py-3 font-medium">Risk / Trend</th>
              <th className="px-4 py-3 font-medium">Provider</th>
              <th className="px-4 py-3 font-medium text-right">Chart</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800/80">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-slate-500 dark:text-slate-400">
                  {rows.length === 0
                    ? 'Select instruments above and click Scan to run live quantitative analysis.'
                    : 'No instruments match your current filter.'}
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <tr key={row.symbol} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/35 transition-colors">
                  <td className="px-4 py-3 font-medium text-slate-900 dark:text-white whitespace-nowrap">
                    <div>{row.name}</div>
                    <div className="text-[11px] text-slate-500">
                      {row.symbol} · {row.instrumentType}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-semibold whitespace-nowrap">
                    <span
                      className={
                        row.direction === 'CALL'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : row.direction === 'PUT'
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-amber-600 dark:text-amber-400'
                      }
                    >
                      {row.direction}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">
                    {row.rawDirectionalConfidence ?? row.score}/100
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">
                    {row.entryPrice != null ? row.entryPrice.toFixed(row.entryPrice > 100 ? 2 : 5) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                    <div>{Math.round(((row.effectiveExpirySeconds ?? row.suggestedExpirySeconds) || 180) / 60)}m</div>
                    {row.expiryAdjusted && row.requestedExpirySeconds != null && (
                      <div className="text-[10px] text-amber-600 dark:text-amber-400">
                        req {row.requestedExpirySeconds}s→{row.effectiveExpirySeconds}s
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    {row.riskLevel} · {row.trend} ({row.mtfAlignment})
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                    <div>{row.error ? 'Unavailable' : row.provider}</div>
                    {(row.isStale || (row.marketStatus && row.marketStatus !== 'OPEN' && row.marketStatus !== 'LIVE')) && (
                      <div className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                        {row.marketStatus || 'DELAYED_OR_CLOSED'} (signals locked to WAIT)
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => onSelectAsset(row.symbol)}
                      className="min-h-9 inline-flex items-center gap-1 text-blue-600 dark:text-indigo-400 hover:underline font-medium whitespace-nowrap"
                    >
                      Terminal <ArrowUpRight className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SignalsView({
  signals,
  onSelectSymbol,
}: {
  signals: SignalRecord[];
  onSelectSymbol: (sym: string) => void;
}) {
  const [dirFilter, setDirFilter] = useState<'ALL' | 'CALL' | 'PUT' | 'WAIT'>('ALL');
  const filtered = signals.filter((s) => dirFilter === 'ALL' || s.direction === dirFilter);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">Trading Signals</h2>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
            Every signal includes entry price, direction, suggested expiry, confidence score, supporting indicators, and risk assessment. Confidence reflects indicator confluence, never guaranteed accuracy.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-[#070C17] p-1">
          {(['ALL', 'CALL', 'PUT', 'WAIT'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDirFilter(d)}
              className={`min-h-9 px-3 py-1 text-xs font-medium rounded-lg whitespace-nowrap transition-all ${
                dirFilter === d
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm border border-slate-200/80 dark:border-slate-700'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border border-transparent'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className={`${CARD_SURFACE} p-10 text-center text-sm text-slate-500 dark:text-slate-400`}>
          No signals recorded yet. Run an analysis in Live Markets or AI Scanner.
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((sig) => (
            <div key={sig.id} className={`${CARD_SURFACE} p-5 space-y-3`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className={`text-base font-bold ${
                      sig.direction === 'CALL'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : sig.direction === 'PUT'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {sig.direction}
                  </span>
                  <span className="text-base font-semibold text-slate-900 dark:text-white">{sig.symbol}</span>
                  {sig.sourceApp && sig.sourceApp !== 'UNKNOWN' && (
                    <span className="rounded-md border border-blue-200 dark:border-indigo-800/70 bg-blue-50 dark:bg-indigo-950/35 px-2 py-0.5 text-[10px] font-semibold text-blue-700 dark:text-indigo-300">
                      {sig.sourceApp === 'MT5' ? 'MT5 Android Screen' : 'IQ Option Android Screen'}
                      {sig.accountModeDetected ? ` · ${sig.accountModeDetected}` : ''}
                    </span>
                  )}
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {sig.timeframe} · {sig.provider}
                    {sig.marketStatus && sig.marketStatus !== 'OPEN' && sig.marketStatus !== 'LIVE' ? ` · ${sig.marketStatus}` : ''} ·{' '}
                    {new Date(sig.timestamp).toLocaleString()}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onSelectSymbol(sig.symbol)}
                  className="min-h-10 rounded-xl border border-slate-200 dark:border-slate-700 px-3.5 py-1.5 text-xs font-medium text-blue-600 dark:text-indigo-400 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap transition-colors"
                >
                  Open Live Chart
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 border-t border-b border-slate-200/80 dark:border-slate-800 py-3 text-xs">
                <div>
                  <span className="text-slate-500">Entry Price</span>
                  <p className="mt-0.5 font-mono tabular-nums font-semibold text-slate-900 dark:text-white">
                    {sig.entryPrice != null ? sig.entryPrice.toFixed(sig.entryPrice > 100 ? 2 : 5) : '—'}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">Effective Expiry</span>
                  <p className="mt-0.5 font-mono tabular-nums font-semibold text-slate-900 dark:text-white">
                    {(() => {
                      const eff = sig.effectiveExpirySeconds ?? sig.suggestedExpirySeconds ?? 180;
                      return `${Math.round(eff / 60)}m (${eff}s)`;
                    })()}
                  </p>
                  {sig.expiryAdjusted && sig.requestedExpirySeconds != null && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400">
                      Req {sig.requestedExpirySeconds}s → adjusted ({sig.timeframe} fit)
                    </p>
                  )}
                </div>
                <div>
                  <span className="text-slate-500">Confidence Score</span>
                  <p className="mt-0.5 font-mono tabular-nums font-semibold text-blue-600 dark:text-indigo-400">
                    {sig.rawDirectionalConfidence ?? sig.confidenceScore ?? sig.score}/100
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">Risk Assessment</span>
                  <p className="mt-0.5 font-semibold text-slate-800 dark:text-slate-200">
                    {sig.riskAssessment?.level || 'MODERATE'}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">Historical Sample</span>
                  <p className="mt-0.5 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                    {sig.backtest.winRatePct != null
                      ? `${sig.backtest.winRatePct}% (n=${sig.backtest.sampleSize}${sig.backtest.sampleSize < 15 ? ', low sample' : ''})`
                      : 'Insufficient'}
                  </p>
                </div>
              </div>

              {sig.supportingIndicators && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                  <div>EMA: {sig.supportingIndicators.emaAlignment}</div>
                  <div>RSI: {sig.supportingIndicators.rsiState}</div>
                  <div>MACD: {sig.supportingIndicators.macdState}</div>
                  <div>Bollinger: {sig.supportingIndicators.bollingerState}</div>
                  <div>Pattern: {sig.supportingIndicators.candlestickPattern}</div>
                  <div>MTF: {sig.supportingIndicators.multiTimeframe}</div>
                </div>
              )}

              <p className="text-xs text-slate-600 dark:text-slate-300">{sig.reasons.join(' · ')}</p>
              {sig.riskAssessment?.summary && (
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Risk note: {sig.riskAssessment.summary}
                </p>
              )}
              {sig.aiExplanation?.summary && (
                <p className="text-xs text-blue-700 dark:text-indigo-300 border-t border-slate-200/80 dark:border-slate-800 pt-2">
                  Gemini analyst note: {sig.aiExplanation.summary}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface PaperTradingDeskProps {
  analytics: AnalyticsSummary | null;
  assets: AssetDefinition[];
  trades: PaperTrade[];
  proposals: AssistedProposal[];
  mode: OperatingMode;
  autoArmed: boolean;
  riskStatus: RiskStatus | null;
  selectedSymbol: string;
  selectedTimeframe: Timeframe;
  brokerAccounts?: ManagedBrokerAccountPublic[];
  activeBrokerAccountId?: string | null;
  busy: boolean;
  onSelectSymbol: (s: string) => void;
  onSelectBrokerTarget?: (accountId: string | null) => Promise<void>;
  onValidateBrokerOrder?: (
    accountId: string,
    symbol: string,
    dir: 'CALL' | 'PUT',
    amount: number,
    orderType: BrokerOrderType
  ) => Promise<BrokerOrderValidationResult>;
  onExecuteBrokerDemoOrder?: (accountId: string, symbol: string, dir: 'CALL' | 'PUT', amount: number, orderType: BrokerOrderType) => Promise<void>;
  onModeChange: (m: OperatingMode) => void;
  onUpdateStartingBalance: (val: number) => Promise<void>;
  onOpenManualTrade: (symbol: string, dir: 'CALL' | 'PUT', amount: number) => Promise<void>;
  onCreateAssistedProposal: () => Promise<void>;
  onApproveProposal: (id: string) => Promise<void>;
  onRejectProposal: (id: string) => Promise<void>;
  onRequestArmAuto: () => void;
  onRunAutoCycle: () => Promise<void>;
  onSettle: (id: string, outcome: 'win' | 'loss') => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}

export function PaperTradingDeskView({
  analytics,
  assets,
  trades,
  proposals,
  mode,
  autoArmed,
  riskStatus,
  selectedSymbol,
  selectedTimeframe,
  brokerAccounts = [],
  activeBrokerAccountId = null,
  busy,
  onSelectSymbol,
  onSelectBrokerTarget,
  onValidateBrokerOrder,
  onExecuteBrokerDemoOrder,
  onModeChange,
  onUpdateStartingBalance,
  onOpenManualTrade,
  onCreateAssistedProposal,
  onApproveProposal,
  onRejectProposal,
  onRequestArmAuto,
  onRunAutoCycle,
  onSettle,
  onCancel,
}: PaperTradingDeskProps) {
  const [stakeDraft, setStakeDraft] = useState('50');
  const [balanceDraft, setBalanceDraft] = useState(String(analytics?.startingVirtualBalance ?? 10000));
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [validatingOrder, setValidatingOrder] = useState(false);
  const [brokerValidation, setBrokerValidation] = useState<BrokerOrderValidationResult | null>(null);

  const validateBalance = (raw: string): string | null => {
    const num = Number(raw);
    if (!raw.trim() || !Number.isFinite(num) || num < 100 || num > 10000000) {
      return 'Enter between $100 and $10,000,000.';
    }
    return null;
  };

  const balanceAutoSave = useAutoSave<string>({
    baseline: analytics?.startingVirtualBalance != null ? String(analytics.startingVirtualBalance) : null,
    debounceMs: 650,
    serialize: (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) ? String(n) : raw;
    },
    validate: validateBalance,
    onSave: async (raw) => {
      const num = Number(raw);
      await onUpdateStartingBalance(num);
    },
  });

  useEffect(() => {
    if (analytics?.startingVirtualBalance != null) {
      const next = String(analytics.startingVirtualBalance);
      if (balanceAutoSave.syncBaseline(next)) {
        setBalanceDraft(next);
      }
    }
  }, [analytics?.startingVirtualBalance]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const parsedStake = Math.max(1, Number(stakeDraft) || 1);
  const pendingProposals = proposals.filter((p) => p.status === 'PENDING_APPROVAL');
  const activeBroker = useMemo(
    () => brokerAccounts.find((a) => a.id === activeBrokerAccountId) || null,
    [brokerAccounts, activeBrokerAccountId]
  );

  useEffect(() => {
    setBrokerValidation(null);
  }, [activeBrokerAccountId, selectedSymbol]);

  const formatCountdown = (expiresAt: string | null) => {
    if (!expiresAt) return 'Manual';
    const sec = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - nowMs) / 1000));
    if (sec === 0) return 'Settling...';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">Paper Trading Desk</h2>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
            Simulated execution, virtual capital management, Assisted approvals, and server-side Autonomous scheduler. Real-money broker execution remains disabled.
          </p>
        </div>
      </div>

      {/* Virtual Balance Bar */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className={`${CARD_SURFACE} p-5`}>
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Current Virtual Balance</span>
            <Wallet className="h-4 w-4 text-blue-600 dark:text-indigo-400" />
          </div>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
            ${(analytics?.currentVirtualBalance ?? 10000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Starting capital ${(analytics?.startingVirtualBalance ?? 10000).toLocaleString()} · Net {(analytics?.netPnl ?? 0) >= 0 ? '+' : ''}
            {(analytics?.netPnl ?? 0).toFixed(2)}
          </p>
        </div>

        <div className={`${CARD_SURFACE} p-5`}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-slate-500 dark:text-slate-400">Starting Virtual Capital ($)</p>
            <SaveStatusIndicator
              status={balanceAutoSave.status}
              validationError={balanceAutoSave.validationError}
              onRetry={balanceAutoSave.retry}
            />
          </div>
          <div className="mt-2">
            <input
              type="number"
              min={100}
              max={10000000}
              value={balanceDraft}
              onChange={(e) => {
                const next = e.target.value;
                setBalanceDraft(next);
                balanceAutoSave.scheduleSave(next);
              }}
              onBlur={() => balanceAutoSave.flushOnBlur(balanceDraft)}
              className={`${INPUT_CLASS} font-mono tabular-nums`}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            Saves automatically when you leave the field.
          </p>
        </div>

        <div className={`${CARD_SURFACE} p-5`}>
          <p className="text-xs text-slate-500 dark:text-slate-400">Today&apos;s Paper Quota</p>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
            {riskStatus?.dailyTradesCount ?? 0} / {riskStatus?.limits.maxDailyTrades ?? 25}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Active open: {trades.length} / {riskStatus?.limits.maxSimultaneousTrades ?? 3} max simultaneous
          </p>
        </div>
      </div>

      {/* Mode Switcher + Ticket */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className={`${CARD_SURFACE} p-5 space-y-4`}>
          <div>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">AI Operating Mode</p>
            <div className="mt-2 grid grid-cols-3 gap-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-[#070C17] p-1">
              {(['signals', 'assisted', 'automatic'] as OperatingMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => onModeChange(m)}
                  className={`min-h-10 rounded-lg py-2 text-xs font-semibold capitalize whitespace-nowrap transition-all ${
                    mode === m
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm border border-slate-200/80 dark:border-slate-700'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border border-transparent'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {mode === 'signals' && (
            <div className={`${SUBTLE_PANEL} p-4 text-xs text-slate-600 dark:text-slate-300 space-y-1.5`}>
              <p className="font-semibold text-slate-900 dark:text-white">Mode A · Quantitative Signals</p>
              <p className="leading-relaxed">
                Scans live market data and displays CALL, PUT, or WAIT opportunities with entry price, confidence score, and risk notes without automatic entry.
              </p>
            </div>
          )}

          {mode === 'assisted' && (
            <div className={`${SUBTLE_PANEL} p-4 text-xs space-y-3`}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-900 dark:text-white">Mode B · Assisted Paper Approval</span>
                <span className="text-slate-500">{selectedSymbol} · {selectedTimeframe}</span>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={onCreateAssistedProposal}
                className="w-full min-h-11 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 disabled:opacity-50 py-2.5 px-4 text-xs font-semibold text-white transition-colors"
              >
                Analyse {selectedSymbol} &amp; Request Approval
              </button>

              {pendingProposals.map((prop) => (
                <div key={prop.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1322] p-3.5 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
                    <span className={prop.direction === 'CALL' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                      {prop.direction} {prop.symbol} ({prop.timeframe})
                    </span>
                    <div className="flex items-center gap-2">
                      {prop.sourceApp && prop.sourceApp !== 'UNKNOWN' && (
                        <span className="rounded-md border border-blue-200 dark:border-indigo-800/70 bg-blue-50 dark:bg-indigo-950/35 px-2 py-0.5 text-[10px] font-semibold text-blue-700 dark:text-indigo-300">
                          {prop.sourceApp === 'MT5' ? 'MT5 Mobile' : 'IQ Option Mobile'}
                        </span>
                      )}
                      <span className="font-mono tabular-nums text-slate-900 dark:text-white">Stake ${prop.recommendedAmount}</span>
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Score {prop.score}/100 · Entry {prop.entryPrice ?? '—'} · Expiry {prop.expirySeconds}s
                    {prop.expiryAdjusted && prop.requestedExpirySeconds != null
                      ? ` (requested ${prop.requestedExpirySeconds}s adjusted for ${prop.timeframe})`
                      : ''}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onApproveProposal(prop.id)}
                      className="flex-1 min-h-10 inline-flex items-center justify-center gap-1 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition-colors"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onRejectProposal(prop.id)}
                      className="flex-1 min-h-10 inline-flex items-center justify-center gap-1 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      <XCircle className="h-3.5 w-3.5" /> Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {mode === 'automatic' && (
            <div className={`${SUBTLE_PANEL} p-4 text-xs space-y-3`}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                  <Bot className="h-4 w-4 text-blue-600 dark:text-indigo-400" /> Mode C · Autonomous Paper Loop
                </span>
                <span className={`font-semibold ${autoArmed ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                  {autoArmed ? 'ARMED' : 'PAUSED'}
                </span>
              </div>
              <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                Runs continuously on the server even when the dashboard is closed, enforcing all daily loss, profit target, consecutive loss, and max daily trade limits.
              </p>
              {riskStatus?.autoPausedReason && (
                <p className="text-red-600 dark:text-red-400 font-medium">Auto-paused: {riskStatus.autoPausedReason}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={onRequestArmAuto}
                  className={`flex-1 min-h-11 rounded-xl py-2.5 px-4 text-xs font-semibold text-white whitespace-nowrap transition-colors ${
                    autoArmed ? 'bg-amber-600 hover:bg-amber-500' : 'bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500'
                  }`}
                >
                  {autoArmed ? 'Pause Automatic Mode' : 'Arm Automatic Mode'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onRunAutoCycle}
                  className="min-h-11 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] px-4 py-2.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap transition-colors"
                >
                  Run Cycle Now
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Manual Paper / Connected Broker Ticket */}
        <div className={`${CARD_SURFACE} p-5 space-y-4`}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Simulated &amp; Broker Order Ticket</h3>
            <span className="text-[11px] font-medium text-slate-500">
              {activeBroker ? `${activeBroker.brokerName} · ${activeBroker.environment.toUpperCase()}` : 'Demo / Paper Only'}
            </span>
          </div>

          {onSelectBrokerTarget && (
            <div className="space-y-2">
              <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1.5">Execution Target</label>
              <select
                value={activeBrokerAccountId || ''}
                disabled={busy}
                onChange={(e) => onSelectBrokerTarget(e.target.value || null)}
                className={SELECT_CLASS}
              >
                <option value="">NovaTrade Paper Simulator (80% Payout)</option>
                {brokerAccounts
                  .filter(
                    (a) =>
                      Boolean(
                        a?.connected &&
                          (a.environment === 'real'
                            ? a?.capabilities?.liveOrderPlacementSupported
                            : a?.capabilities?.demoOrderPlacementSupported)
                      )
                  )
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} ({a.brokerName} · {a.environment.toUpperCase()})
                    </option>
                  ))}
              </select>

              {activeBroker && (
                <div className="rounded-xl border border-blue-200/80 dark:border-indigo-900/60 bg-blue-50/70 dark:bg-indigo-950/25 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div>
                    <span className="font-semibold text-slate-900 dark:text-white">{activeBroker?.label || 'Selected Account'}</span>
                    <span className="ml-2 text-slate-600 dark:text-slate-300">
                      {activeBroker?.brokerName || 'Broker'} · {activeBroker?.accountType || activeBroker.environment.toUpperCase()}
                    </span>
                  </div>
                  <div className="font-mono tabular-nums text-slate-800 dark:text-slate-200">
                    Bal: {activeBroker.balance != null ? `${activeBroker.balance.toFixed(2)} ${activeBroker.currency || 'USD'}` : 'Not synced'}
                    {activeBroker.equity != null && ` · Equity: ${activeBroker.equity.toFixed(2)} ${activeBroker.currency || 'USD'}`}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1.5">Instrument</label>
              <select
                value={selectedSymbol}
                onChange={(e) => onSelectSymbol(e.target.value)}
                className={SELECT_CLASS}
              >
                {assets.map((a) => (
                  <option key={a.symbol} value={a.symbol}>
                    {a.symbol} ({a.instrumentType})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1.5">
                Stake (Max ${riskStatus?.limits.maxTradeAmount ?? 100})
              </label>
              <input
                type="number"
                min={1}
                max={riskStatus?.limits.maxTradeAmount ?? 10000}
                value={stakeDraft}
                onChange={(e) => setStakeDraft(e.target.value)}
                className={`${INPUT_CLASS} font-mono tabular-nums`}
              />
            </div>
          </div>

          {activeBrokerAccountId && onValidateBrokerOrder && (() => {
            const brokerOrderType: BrokerOrderType =
              activeBroker?.brokerId === 'iq_option' ? 'BINARY_FIXED_EXPIRY' : 'MARKET';
            const modeTag =
              activeBroker?.accountType ||
              (activeBroker?.environment === 'real' ? 'REAL' : 'DEMO');
            return (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy || validatingOrder || !stakeDraft.trim() || parsedStake < 1}
                    onClick={async () => {
                      setValidatingOrder(true);
                      try {
                        const check = await onValidateBrokerOrder(
                          activeBrokerAccountId,
                          selectedSymbol,
                          'CALL',
                          parsedStake,
                          brokerOrderType
                        );
                        setBrokerValidation(check);
                      } finally {
                        setValidatingOrder(false);
                      }
                    }}
                    className="min-h-10 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] px-3.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors"
                  >
                    {validatingOrder
                      ? `Checking ${activeBroker?.brokerName || 'Broker'} Order...`
                      : `Validate ${modeTag} Order (Pre-Flight)`}
                  </button>
                </div>
                {brokerValidation && (
                  <div
                    className={`rounded-xl border px-3 py-2 text-[11px] ${
                      brokerValidation.valid
                        ? 'border-emerald-300 dark:border-emerald-800/70 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300'
                        : 'border-red-300 dark:border-red-800/70 bg-red-50/70 dark:bg-red-950/30 text-red-800 dark:text-red-300'
                    }`}
                  >
                    <p className="font-semibold">
                      {brokerValidation.valid ? 'Validation Passed' : 'Validation Blocked'} · {brokerValidation.mappedSymbol}
                      {brokerValidation.normalizedVolume != null ? ` · Vol ${brokerValidation.normalizedVolume}` : ''}
                      {brokerValidation.estimatedMargin != null ? ` · Margin ~${brokerValidation.estimatedMargin.toFixed(2)}` : ''}
                    </p>
                    <p>{brokerValidation.reason}</p>
                  </div>
                )}
              </div>
            );
          })()}

          {(() => {
            const brokerOrderType: BrokerOrderType =
              activeBroker?.brokerId === 'iq_option' ? 'BINARY_FIXED_EXPIRY' : 'MARKET';
            const modeTag =
              activeBroker?.accountType ||
              (activeBroker?.environment === 'real' ? 'REAL' : 'DEMO');
            return (
              <>
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <button
                    type="button"
                    disabled={busy || !stakeDraft.trim() || parsedStake < 1}
                    onClick={() => {
                      if (activeBrokerAccountId && onExecuteBrokerDemoOrder) {
                        void onExecuteBrokerDemoOrder(activeBrokerAccountId, selectedSymbol, 'CALL', parsedStake, brokerOrderType);
                      } else {
                        void onOpenManualTrade(selectedSymbol, 'CALL', parsedStake);
                      }
                    }}
                    className="min-h-11 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 py-2.5 text-xs font-semibold text-white transition-colors"
                  >
                    <Play className="h-3.5 w-3.5" />{' '}
                    {activeBrokerAccountId
                      ? `Send ${modeTag} BUY (CALL)`
                      : 'Open Paper CALL'}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !stakeDraft.trim() || parsedStake < 1}
                    onClick={() => {
                      if (activeBrokerAccountId && onExecuteBrokerDemoOrder) {
                        void onExecuteBrokerDemoOrder(activeBrokerAccountId, selectedSymbol, 'PUT', parsedStake, brokerOrderType);
                      } else {
                        void onOpenManualTrade(selectedSymbol, 'PUT', parsedStake);
                      }
                    }}
                    className="min-h-11 inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 py-2.5 text-xs font-semibold text-white transition-colors"
                  >
                    <Play className="h-3.5 w-3.5" />{' '}
                    {activeBrokerAccountId
                      ? `Send ${modeTag} SELL (PUT)`
                      : 'Open Paper PUT'}
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {activeBrokerAccountId
                    ? activeBroker?.brokerId === 'iq_option'
                      ? `Routes validated IQ Option ${modeTag} fixed-expiry orders with live broker mode verification, duplicate-order & per-account risk guards (follows active mode inside IQ Option).`
                      : `Routes validated MARKET ${modeTag} orders through MetaTrader 5 with pre-flight order_check(), duplicate-order & per-account risk guards.`
                    : 'Trades auto-settle at expiry using live verified market prices, or can be settled manually below.'}
                </p>
              </>
            );
          })()}
        </div>
      </div>

      {/* Active Paper Positions */}
      <div className={`${CARD_SURFACE} p-5 space-y-4`}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Clock className="h-4 w-4 text-blue-600 dark:text-indigo-400" /> Active Paper Positions ({trades.length})
          </h3>
        </div>

        {trades.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center text-xs text-slate-500 dark:text-slate-400">
            No open paper positions. Open a simulated trade above or arm Automatic Paper Mode.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                  <th className="py-3 pr-3 font-medium">Asset</th>
                  <th className="py-3 pr-3 font-medium">Dir</th>
                  <th className="py-3 pr-3 font-medium">Mode</th>
                  <th className="py-3 pr-3 font-medium text-right">Stake</th>
                  <th className="py-3 pr-3 font-medium text-right">Entry Price</th>
                  <th className="py-3 pr-3 font-medium text-right">Countdown</th>
                  <th className="py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800">
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td className="py-3 pr-3 font-medium text-slate-900 dark:text-white whitespace-nowrap">
                      {t.symbol} · {t.timeframe}
                    </td>
                    <td className={`py-3 pr-3 font-semibold ${t.direction === 'CALL' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                      {t.direction}
                    </td>
                    <td className="py-3 pr-3 text-slate-600 dark:text-slate-300 capitalize">{t.mode}</td>
                    <td className="py-3 pr-3 text-right font-mono tabular-nums text-slate-900 dark:text-white">${t.amount.toFixed(2)}</td>
                    <td className="py-3 pr-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {t.entryPrice != null ? t.entryPrice.toFixed(t.entryPrice > 100 ? 2 : 5) : '—'}
                    </td>
                    <td className="py-3 pr-3 text-right font-mono tabular-nums text-blue-600 dark:text-indigo-300">
                      {formatCountdown(t.expiresAt)}
                    </td>
                    <td className="py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onSettle(t.id, 'win')}
                          className="min-h-9 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 whitespace-nowrap"
                        >
                          Win
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onSettle(t.id, 'loss')}
                          className="min-h-9 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-red-700 dark:text-red-300 hover:bg-red-500/20 whitespace-nowrap"
                        >
                          Loss
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onCancel(t.id)}
                          className="min-h-9 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-slate-600 dark:text-slate-300 whitespace-nowrap"
                        >
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function TradeHistoryView({ trades }: { trades: PaperTrade[] }) {
  const [filter, setFilter] = useState<'ALL' | 'WIN' | 'LOSS' | 'CANCELLED'>('ALL');
  const closed = trades.filter((t) => {
    if (t.status === 'SIMULATED_PENDING_OUTCOME') return false;
    if (filter === 'WIN') return t.status.includes('WIN');
    if (filter === 'LOSS') return t.status.includes('LOSS');
    if (filter === 'CANCELLED') return t.status === 'CANCELLED';
    return true;
  });

  function exportCsv() {
    const headers = ['id', 'symbol', 'timeframe', 'direction', 'mode', 'amount', 'entryPrice', 'exitPrice', 'pnl', 'status', 'settledBy', 'createdAt', 'closedAt'];
    const lines = [
      headers.join(','),
      ...closed.map((t) =>
        [t.id, t.symbol, t.timeframe, t.direction, t.mode, t.amount, t.entryPrice ?? '', t.exitPrice ?? '', t.pnl ?? '', t.status, t.settledBy ?? '', t.createdAt, t.closedAt ?? ''].join(',')
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `novatrade-paper-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">Trade History</h2>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
            Auditable ledger of settled paper trades with entry/exit market prices and settlement source.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-[#070C17] p-1">
            {(['ALL', 'WIN', 'LOSS', 'CANCELLED'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`min-h-9 px-3 py-1 text-xs font-medium rounded-lg transition-all ${
                  filter === f
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm border border-slate-200/80 dark:border-slate-700'
                    : 'text-slate-600 dark:text-slate-400 border border-transparent'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={closed.length === 0}
            className="min-h-11 inline-flex items-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap transition-colors"
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </button>
        </div>
      </div>

      <div className={`${CARD_SURFACE} overflow-x-auto`}>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
              <th className="px-4 py-3 font-medium">Closed</th>
              <th className="px-4 py-3 font-medium">Instrument</th>
              <th className="px-4 py-3 font-medium">Dir</th>
              <th className="px-4 py-3 font-medium">Mode</th>
              <th className="px-4 py-3 font-medium text-right">Stake</th>
              <th className="px-4 py-3 font-medium text-right">Entry</th>
              <th className="px-4 py-3 font-medium text-right">Exit</th>
              <th className="px-4 py-3 font-medium text-right">P&amp;L</th>
              <th className="px-4 py-3 font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800">
            {closed.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-slate-500 dark:text-slate-400">
                  No settled paper trades match this filter.
                </td>
              </tr>
            ) : (
              closed.map((t) => {
                const win = t.status.includes('WIN');
                const loss = t.status.includes('LOSS');
                return (
                  <tr key={t.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/35 transition-colors">
                    <td className="px-4 py-3 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {new Date(t.closedAt || t.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900 dark:text-white whitespace-nowrap">
                      {t.symbol} · {t.timeframe}
                    </td>
                    <td className={`px-4 py-3 font-semibold ${t.direction === 'CALL' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                      {t.direction}
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300 capitalize">{t.mode}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">${t.amount.toFixed(2)}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {t.entryPrice != null ? t.entryPrice.toFixed(t.entryPrice > 100 ? 2 : 5) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {t.exitPrice != null ? t.exitPrice.toFixed(t.exitPrice > 100 ? 2 : 5) : '—'}
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-mono tabular-nums font-semibold ${
                        (t.pnl ?? 0) > 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : (t.pnl ?? 0) < 0
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-slate-400'
                      }`}
                    >
                      {t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '0.00'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={win ? 'text-emerald-600 dark:text-emerald-400 font-medium' : loss ? 'text-red-600 dark:text-red-400 font-medium' : 'text-slate-400'}>
                        {win ? 'WIN' : loss ? 'LOSS' : 'CANCELLED'}
                      </span>
                      {t.settledBy && <span className="ml-1.5 text-[10px] text-slate-400">({t.settledBy})</span>}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AnalyticsView({
  analytics,
  assets,
  riskStatus,
}: {
  analytics: AnalyticsSummary | null;
  assets: AssetDefinition[];
  riskStatus: RiskStatus | null;
}) {
  const [periodTab, setPeriodTab] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  if (!analytics) return null;

  const activePeriodRows =
    periodTab === 'daily' ? analytics.dailyStats : periodTab === 'weekly' ? analytics.weeklyStats : analytics.monthlyStats;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">Performance Analytics</h2>
        <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
          Daily, weekly, and monthly simulation performance across {assets.length} instruments. Computed strictly from settled paper trades.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className={`${CARD_SURFACE} p-4`}>
          <p className="text-xs text-slate-500 dark:text-slate-400">Settled Win Rate</p>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
            {analytics.winRatePct != null ? `${analytics.winRatePct}%` : 'N/A'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {analytics.wins}W / {analytics.losses}L ({analytics.totalTrades} total)
          </p>
        </div>
        <div className={`${CARD_SURFACE} p-4`}>
          <p className="text-xs text-slate-500 dark:text-slate-400">Net Simulated P&amp;L</p>
          <p
            className={`mt-2 text-2xl font-semibold font-mono tabular-nums ${
              analytics.netPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
            }`}
          >
            {analytics.netPnl >= 0 ? '+' : ''}
            {analytics.netPnl.toFixed(2)}
          </p>
          <p className="mt-1 text-xs text-slate-500">Balance ${analytics.currentVirtualBalance.toLocaleString()}</p>
        </div>
        <div className={`${CARD_SURFACE} p-4`}>
          <p className="text-xs text-slate-500 dark:text-slate-400">Profit Factor</p>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
            {analytics.profitFactor != null ? analytics.profitFactor.toFixed(2) : 'N/A'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Gross +{analytics.grossProfit.toFixed(2)} / -{analytics.grossLoss.toFixed(2)}
          </p>
        </div>
        <div className={`${CARD_SURFACE} p-4`}>
          <p className="text-xs text-slate-500 dark:text-slate-400">Max Drawdown &amp; Quota</p>
          <p className="mt-2 text-2xl font-semibold font-mono tabular-nums text-amber-600 dark:text-amber-400">
            -{analytics.maxDrawdown.toFixed(2)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Today {riskStatus?.dailyTradesCount ?? 0}/{riskStatus?.limits.maxDailyTrades ?? 25} · Streak {riskStatus?.consecutiveLosses ?? 0}
          </p>
        </div>
      </div>

      {/* Period Performance & Win/Loss Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className={`lg:col-span-2 ${CARD_SURFACE} p-5 space-y-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Daily / Weekly / Monthly Performance</h3>
            <div className="flex rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-[#070C17] p-1">
              {(['daily', 'weekly', 'monthly'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setPeriodTab(tab)}
                  className={`min-h-8 px-3 py-1 text-xs font-medium rounded-lg capitalize transition-all ${
                    periodTab === tab
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm border border-slate-200/80 dark:border-slate-700'
                      : 'text-slate-600 dark:text-slate-400 border border-transparent'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>
          <PeriodPerformanceChart
            rows={activePeriodRows}
            emptyLabel={`No ${periodTab} settled paper trades recorded yet.`}
          />
        </div>

        <div className={`${CARD_SURFACE} p-5 flex flex-col justify-between space-y-4`}>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Outcome &amp; Risk Summary</h3>
          <WinLossDistributionChart wins={analytics.wins} losses={analytics.losses} />
          <div className="grid grid-cols-2 gap-3 text-xs border-t border-slate-200/80 dark:border-slate-800 pt-3">
            <div>
              <span className="text-slate-500">Today&apos;s P&amp;L</span>
              <p className={`font-mono tabular-nums font-semibold ${analytics.todayPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {analytics.todayPnl >= 0 ? '+' : ''}
                {analytics.todayPnl.toFixed(2)}
              </p>
            </div>
            <div>
              <span className="text-slate-500">Consecutive Losses</span>
              <p className="font-mono tabular-nums font-semibold text-slate-900 dark:text-white">
                {riskStatus?.consecutiveLosses ?? 0} / {riskStatus?.limits.maxConsecutiveLosses ?? 3}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className={`${CARD_SURFACE} p-5`}>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">Cumulative Paper Equity Curve</h3>
        <EquityChart points={analytics.equityCurve} />
      </div>

      <div className={`${CARD_SURFACE} p-5`}>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">Performance by Asset</h3>
        {analytics.bySymbol.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">No settled trades grouped by symbol yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                  <th className="py-2 font-medium">Symbol</th>
                  <th className="py-2 font-medium text-right">Trades</th>
                  <th className="py-2 font-medium text-right">Wins</th>
                  <th className="py-2 font-medium text-right">Losses</th>
                  <th className="py-2 font-medium text-right">Net P&amp;L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800">
                {analytics.bySymbol.map((row) => (
                  <tr key={row.symbol}>
                    <td className="py-2.5 font-medium text-slate-900 dark:text-white">{row.symbol}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">{row.trades}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400">{row.wins}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums text-red-600 dark:text-red-400">{row.losses}</td>
                    <td
                      className={`py-2.5 text-right font-mono tabular-nums font-semibold ${
                        row.netPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {row.netPnl >= 0 ? '+' : ''}
                      {row.netPnl.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

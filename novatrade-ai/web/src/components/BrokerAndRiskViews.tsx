import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Cable,
  Check,
  CheckCircle2,
  History,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Palette,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Smartphone,
  Trash2,
  Unplug,
  User,
} from 'lucide-react';
import type {
  ActivityEvent,
  AiSettings,
  AndroidActionQueueItem,
  AndroidDevicePublic,
  AndroidScreenAnalysisRecord,
  AssetDefinition,
  BrokerAccountRiskLimits,
  BrokerAssetInfo,
  BrokerCatalogItem,
  BrokerId,
  BrokerOrderRecord,
  BrokerOrderType,
  BrokerOrderValidationResult,
  BrokerPosition,
  BrokerQuote,
  BrokerStatusSnapshot,
  Candle,
  InstrumentCompatibilityResult,
  ManagedBrokerAccountPublic,
  RiskSettings,
  RiskStatus,
  ThemePreference,
  Timeframe,
  UserProfile,
} from '../types';
import { AndroidBridgeSection } from './AndroidBridgeSection';
import { sanitizeErrorMessage } from '../lib/api';
import { isSupabaseConfigured, updateSupabaseProfile } from '../lib/supabase';
import { useAutoSave } from '../hooks/useAutoSave';
import {
  CARD_SURFACE,
  INPUT_CLASS,
  SELECT_CLASS,
  SUBTLE_PANEL,
  SaveStatusIndicator,
  ThemeSwitcher,
} from './ui';

interface BrokersViewProps {
  broker: BrokerStatusSnapshot | null;
  catalog: BrokerCatalogItem[];
  accounts: ManagedBrokerAccountPublic[];
  activeAccountId: string | null;
  autoBrokerExecution: boolean;
  emergencyStop: boolean;
  brokerOrders: BrokerOrderRecord[];
  assets: AssetDefinition[];
  busy: boolean;
  onRefresh: () => void;
  onSaveAccount: (input: {
    accountId?: string;
    brokerId: BrokerId;
    label: string;
    externalAccountId?: string | null;
    credentials: Record<string, string>;
  }) => Promise<ManagedBrokerAccountPublic>;
  onDeleteAccount: (accountId: string) => Promise<void>;
  onSelectActiveAccount: (accountId: string | null) => Promise<void>;
  onToggleAutoBrokerExecution: (enabled: boolean) => Promise<void>;
  onConnectAccount: (accountId: string) => Promise<void>;
  onDisconnectAccount: (accountId: string) => Promise<void>;
  onSyncAccount: (accountId: string) => Promise<void>;
  onUpdateAccountRisk: (accountId: string, limits: BrokerAccountRiskLimits) => Promise<void>;
  onCheckCompatibility: (accountId: string, symbol: string, orderType: BrokerOrderType) => Promise<InstrumentCompatibilityResult>;
  onValidateOrder: (accountId: string, symbol: string, direction: 'CALL' | 'PUT', amount: number, orderType: BrokerOrderType) => Promise<BrokerOrderValidationResult>;
  onFetchQuote: (accountId: string, symbol: string) => Promise<BrokerQuote>;
  onFetchCandles: (accountId: string, symbol: string, intervalSeconds?: number, count?: number) => Promise<{ candles: Candle[]; source: string; note?: string }>;
  onFetchAssets: (accountId: string) => Promise<{ assets: BrokerAssetInfo[]; count: number; source: string }>;
  onFetchPositions: (accountId: string) => Promise<{ supported: boolean; positions: BrokerPosition[]; source: string; note?: string }>;
  onSyncHistory: (accountId: string) => Promise<{ supported: boolean; trades: Array<Record<string, unknown>>; note: string }>;
  onReconcileOrders: (accountId?: string) => Promise<{ updatedCount: number; orders: BrokerOrderRecord[] }>;
  onConnectIq: () => void;
  onDisconnectIq: () => void;
  onFetchIqAssets: () => Promise<Array<{ symbol: string; category: string; open: boolean }>>;
  onFetchIqHistory: () => Promise<{ supported: boolean; trades: Array<Record<string, unknown>>; note: string }>;
  androidDevices?: AndroidDevicePublic[];
  androidAnalyses?: AndroidScreenAnalysisRecord[];
  androidActions?: AndroidActionQueueItem[];
  onPairAndroidDevice?: (input: {
    deviceName: string;
    allowMt5: boolean;
    allowIqOption: boolean;
  }) => Promise<{ device: AndroidDevicePublic; pairingCode: string; expiresAt: string }>;
  onUpdateAndroidPermissions?: (
    deviceId: string,
    patch: { status?: 'ACTIVE' | 'PAUSED'; allowMt5?: boolean; allowIqOption?: boolean }
  ) => Promise<void>;
  onRevokeAndroidDevice?: (deviceId: string) => Promise<void>;
  onAnalyzeAndroidScreenshot?: (input: {
    imageBase64: string;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    appPackageHint?: string | null;
    notes?: string;
    deviceId?: string;
    createAssistedProposal?: boolean;
  }) => Promise<void>;
  onApproveAndroidAction?: (actionId: string) => Promise<void>;
  onRejectAndroidAction?: (actionId: string) => Promise<void>;
}

function catalogStatusLabel(item: BrokerCatalogItem): { text: string; tone: string } {
  if (item.status === 'INTEGRATED_READONLY') {
    return {
      text: 'Unofficial · Practice Read-Only',
      tone: 'border-amber-300 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/35 text-amber-800 dark:text-amber-300',
    };
  }
  if (item.status === 'OFFICIAL_SANDBOX_API') {
    return {
      text: 'Official Python SDK · Demo Bridge Set',
      tone: 'border-emerald-300 dark:border-emerald-800/70 bg-emerald-50 dark:bg-emerald-950/35 text-emerald-800 dark:text-emerald-300',
    };
  }
  return {
    text: 'Official Python SDK · Windows Bridge Needed',
    tone: 'border-blue-300 dark:border-indigo-800/70 bg-blue-50 dark:bg-indigo-950/35 text-blue-700 dark:text-indigo-300',
  };
}

export function BrokerConnectionsView({
  broker,
  catalog,
  accounts,
  activeAccountId,
  autoBrokerExecution,
  emergencyStop,
  brokerOrders,
  assets,
  busy,
  onRefresh,
  onSaveAccount,
  onDeleteAccount,
  onSelectActiveAccount,
  onToggleAutoBrokerExecution,
  onConnectAccount,
  onDisconnectAccount,
  onSyncAccount,
  onUpdateAccountRisk,
  onCheckCompatibility,
  onValidateOrder,
  onFetchQuote,
  onFetchCandles,
  onFetchAssets,
  onFetchPositions,
  onSyncHistory,
  onReconcileOrders,
  onConnectIq,
  onDisconnectIq,
  onFetchIqAssets,
  onFetchIqHistory,
  androidDevices = [],
  androidAnalyses = [],
  androidActions = [],
  onPairAndroidDevice,
  onUpdateAndroidPermissions,
  onRevokeAndroidDevice,
  onAnalyzeAndroidScreenshot,
  onApproveAndroidAction,
  onRejectAndroidAction,
}: BrokersViewProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newBrokerId, setNewBrokerId] = useState<BrokerId>('mt5');
  const [newLabel, setNewLabel] = useState('');
  const [newCreds, setNewCreds] = useState<Record<string, string>>({});
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editingRiskAccountId, setEditingRiskAccountId] = useState<string | null>(null);
  const [riskDraft, setRiskDraft] = useState<BrokerAccountRiskLimits | null>(null);

  const [compatState, setCompatState] = useState<
    Record<
      string,
      {
        symbol: string;
        orderType: BrokerOrderType;
        result: InstrumentCompatibilityResult | null;
        orderCheck: BrokerOrderValidationResult | null;
      }
    >
  >({});
  const [quoteByAccount, setQuoteByAccount] = useState<Record<string, BrokerQuote>>({});
  const [candlesByAccount, setCandlesByAccount] = useState<Record<string, { candles: Candle[]; source: string; note?: string }>>({});
  const [assetsByAccount, setAssetsByAccount] = useState<Record<string, { assets: BrokerAssetInfo[]; count: number; source: string }>>({});
  const [positionsByAccount, setPositionsByAccount] = useState<Record<string, { supported: boolean; positions: BrokerPosition[]; source: string; note?: string }>>({});
  const [historyByAccount, setHistoryByAccount] = useState<Record<string, { supported: boolean; trades: Array<Record<string, unknown>>; note: string }>>({});

  const [iqAssets, setIqAssets] = useState<Array<{ symbol: string; category: string; open: boolean }> | null>(null);
  const [iqHistory, setIqHistory] = useState<{ supported: boolean; trades: Array<Record<string, unknown>>; note: string } | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);

  const [mt5Login, setMt5Login] = useState('');
  const [mt5Password, setMt5Password] = useState('');
  const [mt5Server, setMt5Server] = useState('MetaQuotes-Demo');
  const [mt5SuccessMsg, setMt5SuccessMsg] = useState<string | null>(null);
  const [isMt5LoggingIn, setIsMt5LoggingIn] = useState(false);

  const [iqEmail, setIqEmail] = useState('');
  const [iqPassword, setIqPassword] = useState('');
  const [iqSuccessMsg, setIqSuccessMsg] = useState<string | null>(null);
  const [isIqLoggingIn, setIsIqLoggingIn] = useState(false);

  async function handleMt5DirectLogin(e: React.FormEvent) {
    e.preventDefault();
    setDiagError(null);
    setMt5SuccessMsg(null);
    if (!mt5Login.trim() || !mt5Password) {
      setDiagError('Please enter both MT5 Account Login and Password.');
      return;
    }
    setIsMt5LoggingIn(true);
    try {
      const savedAccount = await onSaveAccount({
        brokerId: 'mt5',
        label: `MT5 Account (${mt5Login.trim()})`,
        externalAccountId: mt5Login.trim(),
        credentials: {
          accountNumber: mt5Login.trim(),
          apiSecret: mt5Password,
          serverName: mt5Server.trim() || 'MetaQuotes-Demo',
        },
      });
      setMt5Password('');
      if (!savedAccount?.id) {
        throw new Error('Unable to save MT5 credentials.');
      }

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('MT5 gateway is offline. Your account has not been connected.')), 10000)
      );

      await Promise.race([
        onConnectAccount(savedAccount.id),
        timeoutPromise,
      ]);

      setMt5SuccessMsg('MetaTrader 5 authenticated and connected successfully.');
      onRefresh();
    } catch (err) {
      setMt5SuccessMsg(null);
      const msg = sanitizeErrorMessage(err, 'MT5 gateway is offline. Your account has not been connected.');
      const lower = msg.toLowerCase();
      if (
        lower.includes('not configured') ||
        lower.includes('mt5_bridge_url') ||
        lower.includes('offline') ||
        lower.includes('unreachable') ||
        lower.includes('econnrefused') ||
        lower.includes('failed to fetch') ||
        lower.includes('timeout') ||
        lower.includes('bridge') ||
        lower.includes('gateway')
      ) {
        setDiagError('MT5 gateway is offline / not configured. Your account has not been connected.');
      } else {
        setDiagError(msg);
      }
    } finally {
      setIsMt5LoggingIn(false);
    }
  }

  async function handleIqDirectLogin(e: React.FormEvent) {
    e.preventDefault();
    setDiagError(null);
    setIqSuccessMsg(null);
    if (!iqEmail.trim() || !iqPassword) {
      setDiagError('Please enter both IQ Option Email and Password.');
      return;
    }
    setIsIqLoggingIn(true);
    try {
      const savedAccount = await onSaveAccount({
        brokerId: 'iq_option',
        label: `IQ Option (${iqEmail.trim()})`,
        credentials: {
          email: iqEmail.trim(),
          apiSecret: iqPassword,
        },
      });
      setIqPassword('');
      if (!savedAccount?.id) {
        throw new Error('Unable to save IQ Option credentials.');
      }

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('IQ Option connector is offline. Your account has not been connected.')), 10000)
      );

      await Promise.race([
        onConnectAccount(savedAccount.id),
        timeoutPromise,
      ]);

      setIqSuccessMsg('IQ Option authenticated and connected successfully.');
      onRefresh();
    } catch (err) {
      setIqSuccessMsg(null);
      const msg = sanitizeErrorMessage(err, 'IQ Option connector is offline. Your account has not been connected.');
      const lower = msg.toLowerCase();
      if (
        lower.includes('not configured') ||
        lower.includes('iq_connector_url') ||
        lower.includes('offline') ||
        lower.includes('unreachable') ||
        lower.includes('econnrefused') ||
        lower.includes('failed to fetch') ||
        lower.includes('timeout') ||
        lower.includes('connector') ||
        lower.includes('gateway')
      ) {
        setDiagError('IQ Option connector is offline / not configured. Your account has not been connected.');
      } else {
        setDiagError(msg);
      }
    } finally {
      setIsIqLoggingIn(false);
    }
  }

  const activeAccount = accounts.find((a) => a.id === activeAccountId) || null;
  const selectedCatalogItem = catalog.find((c) => c.id === newBrokerId) || catalog[0];

  function openAddModal(brokerId: BrokerId = 'mt5') {
    const item = catalog.find((c) => c.id === brokerId);
    setEditingAccountId(null);
    setNewBrokerId(brokerId);
    setNewLabel(brokerId === 'mt5' ? 'MT5 MetaQuotes-Demo' : `${item?.name || brokerId} Demo`);
    setNewCreds(brokerId === 'mt5' ? { serverName: 'MetaQuotes-Demo' } : {});
    setShowAddForm(true);
  }

  function openCredentialUpdate(acct: ManagedBrokerAccountPublic) {
    setEditingAccountId(acct.id);
    setNewBrokerId(acct.brokerId);
    setNewLabel(acct.label);
    setNewCreds(
      acct.brokerId === 'mt5'
        ? {
            serverName: 'MetaQuotes-Demo',
            ...(acct.externalAccountId ? { accountNumber: acct.externalAccountId } : {}),
          }
        : {}
    );
    setShowAddForm(true);
  }

  async function handleSubmitAccountForm(e: React.FormEvent) {
    e.preventDefault();
    setDiagError(null);
    try {
      await onSaveAccount({
        accountId: editingAccountId || undefined,
        brokerId: newBrokerId,
        label: newLabel.trim() || `${selectedCatalogItem?.name || newBrokerId} Demo`,
        externalAccountId: newCreds.accountNumber?.trim() || undefined,
        credentials: newCreds,
      });
      setShowAddForm(false);
      setEditingAccountId(null);
      setNewCreds({});
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : 'Unable to save broker account.');
    }
  }

  async function handleRunCompatibility(acct: ManagedBrokerAccountPublic) {
    setDiagError(null);
    const current = compatState[acct.id] || {
      symbol: assets[0]?.symbol || 'EURUSD',
      orderType: acct.capabilities.supportedOrderTypes[0] || 'MARKET',
      result: null,
      orderCheck: null,
    };
    try {
      const res = await onCheckCompatibility(acct.id, current.symbol, current.orderType);
      setCompatState((prev) => ({
        ...prev,
        [acct.id]: { ...current, result: res, orderCheck: null },
      }));
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : 'Compatibility check failed.');
    }
  }

  async function handleRunOrderValidation(acct: ManagedBrokerAccountPublic) {
    setDiagError(null);
    const current = compatState[acct.id] || {
      symbol: assets[0]?.symbol || 'EURUSD',
      orderType: acct.capabilities.supportedOrderTypes[0] || 'MARKET',
      result: null,
      orderCheck: null,
    };
    try {
      const validation = await onValidateOrder(
        acct.id,
        current.symbol,
        'CALL',
        Math.min(50, acct.riskLimits.maxOrderAmount),
        current.orderType
      );
      setCompatState((prev) => ({
        ...prev,
        [acct.id]: { ...current, orderCheck: validation },
      }));
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : 'Pre-flight order validation failed.');
    }
  }

  async function handleInspectMarketFeed(acct: ManagedBrokerAccountPublic, symbol: string) {
    setDiagError(null);
    try {
      const [quote, candleRes] = await Promise.all([
        onFetchQuote(acct.id, symbol),
        onFetchCandles(acct.id, symbol, 60, 20),
      ]);
      setQuoteByAccount((prev) => ({ ...prev, [acct.id]: quote }));
      setCandlesByAccount((prev) => ({ ...prev, [acct.id]: candleRes }));
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : 'Market feed inspection failed.');
    }
  }

  async function handleInspectAvailableSymbols(accountId: string) {
    setDiagError(null);
    try {
      const res = await onFetchAssets(accountId);
      setAssetsByAccount((prev) => ({ ...prev, [accountId]: res }));
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : 'Unable to fetch available broker symbols.');
    }
  }

  async function handleInspectPositions(accountId: string) {
    setDiagError(null);
    try {
      const res = await onFetchPositions(accountId);
      setPositionsByAccount((prev) => ({ ...prev, [accountId]: res }));
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : 'Unable to fetch open positions.');
    }
  }

  async function handleRunHistorySync(accountId: string) {
    setDiagError(null);
    try {
      const res = await onSyncHistory(accountId);
      setHistoryByAccount((prev) => ({ ...prev, [accountId]: res }));
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : 'Trade history sync failed.');
    }
  }

  async function handleInspectAssets() {
    setDiagError(null);
    try {
      const list = await onFetchIqAssets();
      setIqAssets(list);
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : 'Failed to fetch IQ assets.');
    }
  }

  async function handleInspectHistory() {
    setDiagError(null);
    try {
      const hist = await onFetchIqHistory();
      setIqHistory(hist);
    } catch (err) {
      setDiagError(err instanceof Error ? err.message : 'Failed to fetch IQ history.');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">MT5 + IQ Option Broker Manager</h2>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
            Manage demo accounts for MetaTrader 5 (Official Python SDK Bridge) and IQ Option (Unofficial Practice Read-Only Connector). Credentials stay encrypted on the server.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => openAddModal('mt5')}
            disabled={busy}
            className="min-h-11 inline-flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 px-4 py-2 text-xs font-semibold text-white whitespace-nowrap transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> Add MT5 / IQ Demo Account
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="min-h-11 inline-flex items-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] hover:bg-slate-50 dark:hover:bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /> Refresh Status
          </button>
        </div>
      </div>

      {/* Active Execution Target, Auto-Routing Guard & Real-Money Safety Lock */}
      <div className={`${CARD_SURFACE} p-5 flex flex-wrap items-center justify-between gap-4`}>
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-300/80 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/35 text-amber-700 dark:text-amber-300">
            <Lock className="h-4 w-4" />
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Active Execution Target</p>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white mt-0.5">
              {activeAccount
                ? `${activeAccount.label} · ${activeAccount.brokerName} (${activeAccount.accountType || 'DEMO'})`
                : 'NovaTrade Paper Simulator (Default Safe Mode)'}
            </h3>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
              Real-money execution is disabled. MT5 routes strictly DEMO orders after `mt5.order_check()`; IQ Option stays read-only PRACTICE diagnostics.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {activeAccount && activeAccount.brokerId === 'mt5' && activeAccount.connected && (
            <button
              type="button"
              disabled={busy || emergencyStop}
              onClick={() => onToggleAutoBrokerExecution(!autoBrokerExecution)}
              className={`min-h-10 rounded-xl border px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition-colors ${
                autoBrokerExecution && !emergencyStop
                  ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                  : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070C17] text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
              } disabled:opacity-40`}
            >
              {emergencyStop
                ? 'Auto MT5 Halted (Emergency Stop)'
                : autoBrokerExecution
                  ? 'Auto MT5 Demo Routing: ON'
                  : 'Auto MT5 Demo Routing: OFF'}
            </button>
          )}
          {activeAccount && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onSelectActiveAccount(null)}
              className="min-h-10 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070C17] px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              Switch to Paper Simulator
            </button>
          )}
          <span className="rounded-lg border border-amber-300 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/40 px-3 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-300 whitespace-nowrap">
            Live Money Locked (Demo Only)
          </span>
        </div>
      </div>

      {/* Managed Gateway Notice */}
      <div className={`${CARD_SURFACE} p-4 sm:p-5 space-y-2 border-blue-200/80 dark:border-indigo-900/50`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-blue-600 dark:text-indigo-400 shrink-0" />
            <h3 className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-white">
              NovaTrade Managed Broker Gateway
            </h3>
          </div>
          <span className={`rounded-md border px-2.5 py-0.5 text-[11px] font-medium ${
            broker?.connected || broker?.diagnostics?.reachable
              ? 'border-blue-200 dark:border-indigo-800/70 bg-blue-50 dark:bg-indigo-950/35 text-blue-700 dark:text-indigo-300'
              : 'border-amber-200 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/35 text-amber-700 dark:text-amber-300'
          }`}>
            {broker?.connected || broker?.diagnostics?.reachable
              ? 'Secure Backend Gateway Active'
              : 'Gateway Offline / Unconfigured'}
          </span>
        </div>
        <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
          Enter your existing MetaTrader 5 or IQ Option account credentials. All gateway routing, token encryption, and infrastructure communication are handled securely by NovaTrade&apos;s managed backend.
        </p>
      </div>

      {diagError && (
        <div className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          <span>{diagError}</span>
        </div>
      )}

      {/* Simplified Direct Broker Login Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* MetaTrader 5 Login */}
        <form onSubmit={handleMt5DirectLogin} className={`${CARD_SURFACE} p-5 sm:p-6 space-y-4`}>
          <div className="flex items-center justify-between border-b border-slate-200/80 dark:border-slate-800 pb-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <Cable className="h-4 w-4 text-blue-600 dark:text-indigo-400" /> MetaTrader 5 Login
            </h3>
            <span className="rounded-md bg-blue-500/15 px-2 py-0.5 text-[10px] font-semibold text-blue-700 dark:text-indigo-300">
              Official SDK Bridge
            </span>
          </div>

          {mt5SuccessMsg && (
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
              {mt5SuccessMsg}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Account Login *</label>
            <input
              type="text"
              required
              value={mt5Login}
              onChange={(e) => setMt5Login(e.target.value)}
              placeholder="e.g. 50241890"
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Password *</label>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={mt5Password}
              onChange={(e) => setMt5Password(e.target.value)}
              placeholder="MT5 account password"
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Server (optional)</label>
            <input
              type="text"
              value={mt5Server}
              onChange={(e) => setMt5Server(e.target.value)}
              placeholder="MetaQuotes-Demo"
              className={INPUT_CLASS}
            />
          </div>
          <button
            type="submit"
            disabled={busy || isMt5LoggingIn}
            className="w-full min-h-11 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 disabled:opacity-50 px-4 py-2.5 text-xs font-semibold text-white transition-colors flex items-center justify-center gap-2"
          >
            {isMt5LoggingIn ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Authenticating with MT5...</span>
              </>
            ) : (
              <span>Login to MetaTrader 5</span>
            )}
          </button>
        </form>

        {/* IQ Option Login */}
        <form onSubmit={handleIqDirectLogin} className={`${CARD_SURFACE} p-5 sm:p-6 space-y-4`}>
          <div className="flex items-center justify-between border-b border-slate-200/80 dark:border-slate-800 pb-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <Cable className="h-4 w-4 text-amber-600 dark:text-amber-400" /> IQ Option Login
            </h3>
            <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
              Practice Read-Only
            </span>
          </div>

          {iqSuccessMsg && (
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
              {iqSuccessMsg}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Email *</label>
            <input
              type="email"
              required
              autoComplete="email"
              value={iqEmail}
              onChange={(e) => setIqEmail(e.target.value)}
              placeholder="your-email@example.com"
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Password *</label>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={iqPassword}
              onChange={(e) => setIqPassword(e.target.value)}
              placeholder="IQ Option password"
              className={INPUT_CLASS}
            />
          </div>
          <div className="pt-6">
            <button
              type="submit"
              disabled={busy || isIqLoggingIn}
              className="w-full min-h-11 rounded-xl bg-amber-600 hover:bg-amber-500 dark:bg-amber-600 dark:hover:bg-amber-500 disabled:opacity-50 px-4 py-2.5 text-xs font-semibold text-white transition-colors flex items-center justify-center gap-2"
            >
              {isIqLoggingIn ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Authenticating with IQ Option...</span>
                </>
              ) : (
                <span>Login to IQ Option</span>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Add / Edit Account Modal Card */}
      {showAddForm && (
        <form onSubmit={handleSubmitAccountForm} className={`${CARD_SURFACE} p-5 sm:p-6 space-y-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 dark:border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-blue-600 dark:text-indigo-400" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                {editingAccountId ? 'Update Demo Account Credentials' : 'Connect New Sandbox / Demo Account'}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowAddForm(false);
                setEditingAccountId(null);
              }}
              className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            >
              Cancel
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Broker Connector</label>
              <select
                value={newBrokerId}
                disabled={Boolean(editingAccountId)}
                onChange={(e) => {
                  const id = e.target.value as BrokerId;
                  const item = catalog.find((c) => c.id === id);
                  setNewBrokerId(id);
                  if (!editingAccountId) {
                    setNewLabel(id === 'mt5' ? 'MT5 MetaQuotes-Demo' : `${item?.name || id} Demo`);
                  }
                  setNewCreds(id === 'mt5' ? { serverName: 'MetaQuotes-Demo' } : {});
                }}
                className={SELECT_CLASS}
              >
                {catalog.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Account Label</label>
              <input
                type="text"
                required
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="e.g. MetaTrader 5 Demo Desk"
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Environment</label>
              <input
                type="text"
                disabled
                value="DEMO / PRACTICE ONLY (Live Locked)"
                className={`${INPUT_CLASS} opacity-75 cursor-not-allowed`}
              />
            </div>
          </div>

          {selectedCatalogItem?.capabilities && (
            <div className={`${SUBTLE_PANEL} p-3.5 text-xs text-slate-600 dark:text-slate-300 space-y-1`}>
              <p className="font-semibold text-slate-900 dark:text-white">
                {selectedCatalogItem.isOfficialApi ? 'Official API Adapter' : 'External Bridge / Unofficial Connector'} ·{' '}
                Assets: {selectedCatalogItem.capabilities.supportedAssetClasses.join(', ')}
              </p>
              <p className="leading-relaxed">{selectedCatalogItem.description}</p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(selectedCatalogItem?.capabilities?.credentialFields || []).map((field) => (
              <div key={field.key}>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  {field.label} {field.required && !editingAccountId ? '*' : '(optional)'}
                </label>
                <input
                  type={field.secret ? 'password' : 'text'}
                  autoComplete={field.secret ? 'new-password' : 'off'}
                  required={field.required && !editingAccountId}
                  value={newCreds[field.key] || ''}
                  onChange={(e) => setNewCreds((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={field.placeholder}
                  className={INPUT_CLASS}
                />
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Secrets are encrypted with AES-256-GCM on the server vault and never returned in API responses or frontend storage.
            </p>
            <button
              type="submit"
              disabled={busy}
              className="min-h-11 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 disabled:opacity-50 px-5 py-2 text-xs font-semibold text-white transition-colors"
            >
              {editingAccountId ? 'Update Encrypted Account' : 'Save Demo Account'}
            </button>
          </div>
        </form>
      )}

      {/* User Multi-Account List */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <Cable className="h-4 w-4 text-blue-600 dark:text-indigo-400" />
            Configured Accounts ({accounts.length})
          </h3>
          <span className="text-xs text-slate-500 dark:text-slate-400">Supports multiple accounts per user</span>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {accounts.map((acct) => {
            const isActiveTarget = activeAccountId === acct.id;
            const compatEntry = compatState[acct.id] || {
              symbol: assets[0]?.symbol || 'EURUSD',
              orderType: acct.capabilities.supportedOrderTypes[0] || 'MARKET',
              result: null,
              orderCheck: null,
            };
            const syncedQuote = quoteByAccount[acct.id];
            const syncedCandles = candlesByAccount[acct.id];
            const syncedAssets = assetsByAccount[acct.id];
            const syncedPositions = positionsByAccount[acct.id];
            const syncedHist = historyByAccount[acct.id];
            const isEditingRisk = editingRiskAccountId === acct.id && riskDraft;

            return (
              <div
                key={acct.id}
                className={`${CARD_SURFACE} p-5 space-y-4 ${
                  isActiveTarget ? 'ring-1 ring-blue-500/60 dark:ring-indigo-500/60' : ''
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">{acct.label}</span>
                      {isActiveTarget && (
                        <span className="rounded-md bg-blue-500/15 px-2 py-0.5 text-[11px] font-semibold text-blue-700 dark:text-indigo-300">
                          Active Target
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {acct.brokerName} · {acct.capabilities.isOfficialApi ? 'Official API' : 'Bridge / Unofficial'} ·{' '}
                      {acct.accountType || 'DEMO / SANDBOX'}
                    </p>
                  </div>

                  <span
                    className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${
                      acct.connected
                        ? 'border-emerald-300 dark:border-emerald-800/70 bg-emerald-50 dark:bg-emerald-950/35 text-emerald-700 dark:text-emerald-300'
                        : acct.status === 'AUTHENTICATION FAILED' || acct.status === 'GATEWAY OFFLINE'
                          ? 'border-red-300 dark:border-red-800/70 bg-red-50 dark:bg-red-950/35 text-red-700 dark:text-red-300'
                          : acct.status === 'GATEWAY ONLINE'
                            ? 'border-blue-300 dark:border-blue-800/70 bg-blue-50 dark:bg-blue-950/35 text-blue-700 dark:text-blue-300'
                            : 'border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {acct.status}
                  </span>
                </div>

                {/* Balance, Equity, Credentials Mask */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-slate-200/80 dark:border-slate-800 text-xs">
                  <div>
                    <p className="text-[11px] text-slate-500">Demo Balance</p>
                    <p className="mt-0.5 font-mono tabular-nums font-semibold text-slate-900 dark:text-white">
                      {acct.balance != null ? `${acct.balance.toFixed(2)} ${acct.currency || 'USD'}` : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Equity / NAV</p>
                    <p className="mt-0.5 font-mono tabular-nums font-semibold text-slate-900 dark:text-white">
                      {acct.equity != null ? `${acct.equity.toFixed(2)} ${acct.currency || 'USD'}` : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Vault Credentials</p>
                    <p className="mt-0.5 font-medium text-slate-700 dark:text-slate-200 truncate">
                      {acct.hasCredentials ? acct.maskedCredentialHint || 'Encrypted' : 'Not Configured'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Demo Execution</p>
                    <p
                      className={`mt-0.5 font-semibold ${
                        acct.capabilities.demoOrderPlacementSupported
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {acct.capabilities.demoOrderPlacementSupported ? 'Sandbox Ready' : 'Read-Only'}
                    </p>
                  </div>
                </div>

                {/* Capabilities Summary */}
                <div className="text-[11px] text-slate-600 dark:text-slate-400 flex flex-wrap gap-x-4 gap-y-1">
                  <span>Assets: {acct.capabilities.supportedAssetClasses.join(', ')}</span>
                  <span>Orders: {acct.capabilities.supportedOrderTypes.join(', ')}</span>
                  <span>Daily Cap: {acct.dailyOrdersCount}/{acct.riskLimits.maxDailyOrders} · Max ${acct.riskLimits.maxOrderAmount}</span>
                </div>

                {acct.lastError && (
                  <p className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/35 px-3 py-1.5 text-[11px] text-red-700 dark:text-red-300">
                    {sanitizeErrorMessage(acct.lastError, 'Broker gateway error occurred.')}
                  </p>
                )}

                {/* Action Buttons */}
                <div className="flex flex-wrap gap-2">
                  {!acct.connected ? (
                    <button
                      type="button"
                      disabled={busy || !acct.hasCredentials}
                      onClick={() => {
                        setDiagError(null);
                        setMt5SuccessMsg(null);
                        setIqSuccessMsg(null);
                        void onConnectAccount(acct.id).catch((err) => {
                          setDiagError(sanitizeErrorMessage(err, 'Broker connection failed.'));
                        });
                      }}
                      className="min-h-10 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 disabled:opacity-40 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors"
                    >
                      Connect Demo
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onDisconnectAccount(acct.id)}
                      className="min-h-10 inline-flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <Unplug className="h-3.5 w-3.5" /> Disconnect
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onSyncAccount(acct.id)}
                    className="min-h-10 inline-flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <Activity className="h-3.5 w-3.5" /> Health &amp; Balance
                  </button>

                  {acct.capabilities.demoOrderPlacementSupported && (
                    <button
                      type="button"
                      disabled={busy || !acct.connected}
                      onClick={() => onSelectActiveAccount(isActiveTarget ? null : acct.id)}
                      className="min-h-10 rounded-xl border border-blue-500/40 bg-blue-500/10 px-3 py-1.5 text-xs font-semibold text-blue-700 dark:text-indigo-300 disabled:opacity-40"
                    >
                      {isActiveTarget ? 'Target Active' : 'Use as Execution Target'}
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => openCredentialUpdate(acct)}
                    className="min-h-10 rounded-xl border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Credentials
                  </button>

                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (isEditingRisk) {
                        setEditingRiskAccountId(null);
                        setRiskDraft(null);
                      } else {
                        setEditingRiskAccountId(acct.id);
                        setRiskDraft({ ...acct.riskLimits });
                      }
                    }}
                    className="min-h-10 rounded-xl border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Risk Limits
                  </button>

                  <button
                    type="button"
                    disabled={busy || !acct.hasCredentials}
                    onClick={() => handleRunHistorySync(acct.id)}
                    className="min-h-10 inline-flex items-center gap-1 rounded-xl border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <History className="h-3.5 w-3.5" /> History
                  </button>

                  {acct.capabilities.positionsSyncSupported && (
                    <button
                      type="button"
                      disabled={busy || !acct.connected}
                      onClick={() => handleInspectPositions(acct.id)}
                      className="min-h-10 rounded-xl border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      Positions
                    </button>
                  )}

                  {!acct.id.startsWith('iq-default-') && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onDeleteAccount(acct.id)}
                      className="min-h-10 inline-flex items-center gap-1 rounded-xl border border-red-300/70 dark:border-red-900/60 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                      aria-label={`Delete ${acct.label}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Inline Per-Account Risk Limits Editor */}
                {isEditingRisk && riskDraft && (
                  <div className={`${SUBTLE_PANEL} p-3.5 space-y-3 text-xs`}>
                    <p className="font-semibold text-slate-900 dark:text-white">Per-Account Risk Guard ({acct.label})</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Max Stake ($)</label>
                        <input
                          type="number"
                          min={1}
                          value={riskDraft.maxOrderAmount}
                          onChange={(e) => setRiskDraft({ ...riskDraft, maxOrderAmount: Number(e.target.value) || 1 })}
                          className={`${INPUT_CLASS} min-h-9 text-xs font-mono`}
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Max Daily Loss ($)</label>
                        <input
                          type="number"
                          min={1}
                          value={riskDraft.maxDailyLoss}
                          onChange={(e) => setRiskDraft({ ...riskDraft, maxDailyLoss: Number(e.target.value) || 1 })}
                          className={`${INPUT_CLASS} min-h-9 text-xs font-mono`}
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Max Daily Orders</label>
                        <input
                          type="number"
                          min={1}
                          value={riskDraft.maxDailyOrders}
                          onChange={(e) => setRiskDraft({ ...riskDraft, maxDailyOrders: Number(e.target.value) || 1 })}
                          className={`${INPUT_CLASS} min-h-9 text-xs font-mono`}
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Max Open</label>
                        <input
                          type="number"
                          min={1}
                          value={riskDraft.maxOpenPositions}
                          onChange={(e) => setRiskDraft({ ...riskDraft, maxOpenPositions: Number(e.target.value) || 1 })}
                          className={`${INPUT_CLASS} min-h-9 text-xs font-mono`}
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-4">
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={riskDraft.allowCall}
                            onChange={(e) => setRiskDraft({ ...riskDraft, allowCall: e.target.checked })}
                          />
                          Allow CALL/BUY
                        </label>
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={riskDraft.allowPut}
                            onChange={(e) => setRiskDraft({ ...riskDraft, allowPut: e.target.checked })}
                          />
                          Allow PUT/SELL
                        </label>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          await onUpdateAccountRisk(acct.id, riskDraft);
                          setEditingRiskAccountId(null);
                          setRiskDraft(null);
                        }}
                        className="min-h-9 rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white"
                      >
                        Save Account Limits
                      </button>
                    </div>
                  </div>
                )}

                {/* Instrument Compatibility, Quote/Candle Probe & Pre-Flight Order Validation */}
                <div className={`${SUBTLE_PANEL} p-3 space-y-2 text-xs`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300">Inspect &amp; Validate:</span>
                    <select
                      value={compatEntry.symbol}
                      onChange={(e) =>
                        setCompatState((prev) => ({
                          ...prev,
                          [acct.id]: { ...compatEntry, symbol: e.target.value, result: null, orderCheck: null },
                        }))
                      }
                      className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] px-2 py-1 text-xs text-slate-800 dark:text-slate-200"
                    >
                      {(assets.length > 0 ? assets : [{ symbol: 'EURUSD' }, { symbol: 'BTCUSD' }, { symbol: 'XAUUSD' }]).map((a) => (
                        <option key={a.symbol} value={a.symbol}>
                          {a.symbol}
                        </option>
                      ))}
                    </select>
                    <select
                      value={compatEntry.orderType}
                      onChange={(e) =>
                        setCompatState((prev) => ({
                          ...prev,
                          [acct.id]: { ...compatEntry, orderType: e.target.value as BrokerOrderType, result: null, orderCheck: null },
                        }))
                      }
                      className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] px-2 py-1 text-xs text-slate-800 dark:text-slate-200"
                    >
                      <option value="MARKET">MARKET</option>
                      <option value="LIMIT">LIMIT</option>
                      <option value="BINARY_FIXED_EXPIRY">BINARY_FIXED_EXPIRY</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => handleRunCompatibility(acct)}
                      className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      Check Symbol
                    </button>
                    {acct.brokerId === 'mt5' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleRunOrderValidation(acct)}
                        className="rounded-lg border border-blue-500/40 bg-blue-500/10 px-2.5 py-1 text-xs font-medium text-blue-700 dark:text-indigo-300 disabled:opacity-40"
                      >
                        Order Check
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy || !acct.connected}
                      onClick={() => handleInspectMarketFeed(acct, compatEntry.symbol)}
                      className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 disabled:opacity-40 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      Price &amp; Candles
                    </button>
                    <button
                      type="button"
                      disabled={busy || !acct.connected}
                      onClick={() => handleInspectAvailableSymbols(acct.id)}
                      className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 disabled:opacity-40 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      Symbols
                    </button>
                  </div>
                  {compatEntry.result && (
                    <p
                      className={`text-[11px] flex items-center gap-1.5 ${
                        compatEntry.result.compatible ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-300'
                      }`}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      <span>
                        {compatEntry.result.compatible
                          ? `Compatible (${compatEntry.result.symbol} -> ${compatEntry.result.mappedSymbol}): ${compatEntry.result.reason}`
                          : `Rejected: ${compatEntry.result.reason}`}
                      </span>
                    </p>
                  )}
                  {compatEntry.orderCheck && (
                    <p
                      className={`text-[11px] flex items-center gap-1.5 ${
                        compatEntry.orderCheck.valid ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      <span>
                        [{compatEntry.orderCheck.source}] {compatEntry.orderCheck.valid ? 'VALID' : 'BLOCKED'}
                        {compatEntry.orderCheck.normalizedVolume != null ? ` · ${compatEntry.orderCheck.normalizedVolume} lots` : ''}
                        {compatEntry.orderCheck.estimatedMargin != null ? ` · Margin $${compatEntry.orderCheck.estimatedMargin.toFixed(2)}` : ''}
                        {' — '}
                        {compatEntry.orderCheck.reason}
                      </span>
                    </p>
                  )}
                </div>

                {syncedQuote && (
                  <div className={`${SUBTLE_PANEL} p-3 text-xs space-y-1 text-slate-600 dark:text-slate-300`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900 dark:text-white">
                        {syncedQuote.symbol} ({syncedQuote.source})
                      </span>
                      <span className="font-mono tabular-nums">
                        {syncedQuote.bid != null && syncedQuote.ask != null
                          ? `Bid ${syncedQuote.bid} / Ask ${syncedQuote.ask}`
                          : `Last ${syncedQuote.last ?? '—'}`}
                      </span>
                    </div>
                    {syncedCandles && (
                      <p className="text-[11px] text-slate-500">
                        Candles loaded: {syncedCandles.candles.length} bars
                        {syncedCandles.candles[syncedCandles.candles.length - 1]
                          ? ` (latest close ${syncedCandles.candles[syncedCandles.candles.length - 1].close})`
                          : ''}
                      </p>
                    )}
                    {syncedQuote.note && <p className="text-[11px] text-slate-500">{syncedQuote.note}</p>}
                  </div>
                )}

                {syncedAssets && (
                  <div className={`${SUBTLE_PANEL} p-3 text-xs space-y-2 text-slate-600 dark:text-slate-300`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-900 dark:text-white">
                        Available Broker Symbols ({syncedAssets.count})
                      </span>
                      <span className="text-[11px] text-slate-500">Tap symbol to fetch live price</span>
                    </div>
                    {syncedAssets.assets.length === 0 ? (
                      <p className="text-[11px] text-slate-500">No symbols returned by broker bridge.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {syncedAssets.assets.slice(0, 24).map((sym) => (
                          <button
                            key={`${sym.category}:${sym.symbol}`}
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setCompatState((prev) => ({
                                ...prev,
                                [acct.id]: { ...compatEntry, symbol: sym.symbol, result: null, orderCheck: null },
                              }));
                              void handleInspectMarketFeed(acct, sym.symbol);
                            }}
                            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] hover:border-blue-500 px-2 py-1 text-[11px] font-mono text-slate-800 dark:text-slate-200"
                          >
                            {sym.symbol}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {syncedPositions && (
                  <div className={`${SUBTLE_PANEL} p-3 text-xs text-slate-600 dark:text-slate-300 space-y-1.5`}>
                    <p className="font-medium text-slate-900 dark:text-white">
                      Open MT5 Demo Positions ({syncedPositions.positions.length})
                    </p>
                    {syncedPositions.positions.length === 0 ? (
                      <p className="text-[11px] text-slate-500">No open positions on connected MT5 demo account.</p>
                    ) : (
                      <div className="space-y-1">
                        {syncedPositions.positions.slice(0, 6).map((p) => (
                          <div key={p.ticket} className="flex items-center justify-between font-mono text-[11px]">
                            <span>
                              #{p.ticket} {p.symbol} {p.side} {p.volume}
                            </span>
                            <span className={(p.profit ?? 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                              {(p.profit ?? 0) >= 0 ? '+' : ''}
                              {(p.profit ?? 0).toFixed(2)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {syncedHist && (
                  <div className={`${SUBTLE_PANEL} p-3 text-xs text-slate-600 dark:text-slate-300`}>
                    <p className="font-medium text-slate-900 dark:text-white">Synced Trade History ({syncedHist.trades.length} items)</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">{syncedHist.note}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Broker Sandbox Order Ledger & Reconciliation */}
      <div className={`${CARD_SURFACE} p-5 sm:p-6 space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Sandbox Broker Order Ledger &amp; Reconciliation</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Tracks idempotent demo broker orders routed to MetaTrader 5 and reconciles fill statuses directly against the connected MT5 Python bridge.
            </p>
          </div>
          <button
            type="button"
            disabled={busy || brokerOrders.length === 0}
            onClick={() => onReconcileOrders()}
            className="min-h-10 inline-flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070C17] hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /> Reconcile Order Statuses
          </button>
        </div>

        {brokerOrders.length === 0 ? (
          <div className={`${SUBTLE_PANEL} p-6 text-center text-xs text-slate-500 dark:text-slate-400`}>
            No demo broker orders have been routed yet. Connect a MetaTrader 5 (MT5) Demo bridge account and select it as your execution target on the Paper Trading Desk.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 pr-3 font-medium">Broker</th>
                  <th className="py-2.5 pr-3 font-medium">Symbol</th>
                  <th className="py-2.5 pr-3 font-medium">Side / Type</th>
                  <th className="py-2.5 pr-3 font-medium text-right">Amount</th>
                  <th className="py-2.5 pr-3 font-medium text-right">Fill Price</th>
                  <th className="py-2.5 pr-3 font-medium">Status</th>
                  <th className="py-2.5 font-medium">Broker Order ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/70 dark:divide-slate-800">
                {brokerOrders.slice(0, 20).map((ord) => (
                  <tr key={ord.id}>
                    <td className="py-2.5 pr-3 font-medium text-slate-900 dark:text-white whitespace-nowrap">{ord.brokerName}</td>
                    <td className="py-2.5 pr-3 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                      {ord.symbol} → {ord.mappedSymbol}
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      <span className={ord.direction === 'CALL' ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-red-600 dark:text-red-400 font-semibold'}>
                        {ord.direction}
                      </span>{' '}
                      <span className="text-slate-500">· {ord.orderType}</span>
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-slate-900 dark:text-white">${ord.amount.toFixed(2)}</td>
                    <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {ord.filledPrice != null ? ord.filledPrice.toFixed(ord.filledPrice > 100 ? 2 : 5) : '—'}
                    </td>
                    <td className="py-2.5 pr-3 font-semibold text-slate-800 dark:text-slate-200">{ord.status}</td>
                    <td className="py-2.5 font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[140px]">
                      {ord.brokerOrderId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Preserved IQ Option Env Connector Diagnostics Card */}
      <div className={`${CARD_SURFACE} p-5 sm:p-6 space-y-5`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Legacy Environment Connector · IQ Option</p>
            <h3 className="mt-1 text-base font-semibold text-slate-900 dark:text-white">
              {broker?.connected ? 'Connected (PRACTICE Read-Only)' : 'Not Connected'}
            </h3>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 max-w-2xl leading-relaxed">{broker?.message}</p>
          </div>
          <span className="rounded-lg border border-amber-300 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/40 px-3 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-300 whitespace-nowrap">
            Unofficial · Order Execution Locked
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-slate-200/80 dark:border-slate-800">
          <div>
            <p className="text-[11px] text-slate-500">Gateway Status</p>
            <p className="mt-1 text-xs font-semibold text-slate-900 dark:text-slate-200">
              {broker?.diagnostics?.urlValid
                ? 'Managed Gateway Active'
                : 'Gateway Standby'}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-slate-500">Health &amp; Reachability</p>
            <p className="mt-1 text-xs font-semibold text-slate-900 dark:text-slate-200">
              {broker?.diagnostics?.reachable
                ? `Reachable (${broker.diagnostics.latencyMs ?? 0}ms)`
                : broker?.connectorUrlConfigured
                  ? 'Unreachable'
                  : 'Standby'}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-slate-500">Practice Balance</p>
            <p className="mt-1 text-xs font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-200">
              {broker?.balance != null ? `${broker.balance.toFixed(2)} ${broker.currency || ''}` : '—'}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-slate-500">Order Execution</p>
            <p className="mt-1 text-xs font-semibold text-red-600 dark:text-red-400">Locked (Read-Only)</p>
          </div>
        </div>

        {broker?.diagnostics && (
          <div className={`${SUBTLE_PANEL} p-3.5 text-xs space-y-2`}>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
              <span>
                Account Type: <strong className="text-slate-800 dark:text-slate-200">{broker.accountType || 'Unavailable'}</strong>
              </span>
              <span>
                Connector Auth Token:{' '}
                <strong className="text-slate-800 dark:text-slate-200">
                  {broker.diagnostics.tokenConfigured ? 'Set (Hidden)' : 'Not Set'}
                </strong>
              </span>
              <span>
                Remote Credentials:{' '}
                <strong className="text-slate-800 dark:text-slate-200">
                  {broker.diagnostics.credentialsConfigured === null
                    ? 'Unknown (Connector Offline)'
                    : broker.diagnostics.credentialsConfigured
                      ? 'Configured on Connector'
                      : 'Missing on Connector'}
                </strong>
              </span>
            </div>

            {broker.diagnostics.warnings.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {broker.diagnostics.warnings.map((w, idx) => (
                  <p
                    key={idx}
                    className="rounded-lg border border-amber-300 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/35 px-2.5 py-1.5 text-amber-800 dark:text-amber-300"
                  >
                    {w}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2.5 pt-1">
          <button
            type="button"
            disabled={busy || !broker?.diagnostics?.urlValid}
            onClick={onConnectIq}
            className="min-h-11 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 disabled:opacity-40 px-4 py-2 text-xs font-semibold text-white whitespace-nowrap transition-colors"
          >
            Connect Practice Session
          </button>
          <button
            type="button"
            disabled={busy || !broker?.connected}
            onClick={onDisconnectIq}
            className="min-h-11 inline-flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070C17] hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap transition-colors"
          >
            <Unplug className="h-3.5 w-3.5" /> Disconnect
          </button>
          <button
            type="button"
            disabled={busy || !broker?.connected}
            onClick={handleInspectAssets}
            className="min-h-11 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070C17] hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap transition-colors"
          >
            Fetch Open Assets
          </button>
          <button
            type="button"
            disabled={busy || !broker?.connected}
            onClick={handleInspectHistory}
            className="min-h-11 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070C17] hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap transition-colors"
          >
            Fetch Trade History
          </button>
        </div>

        {iqAssets && (
          <div className={`${SUBTLE_PANEL} p-3.5 text-xs`}>
            <p className="font-medium text-slate-800 dark:text-slate-200 mb-2">Open IQ Option Assets ({iqAssets.length})</p>
            <div className="flex flex-wrap gap-2 text-slate-600 dark:text-slate-400">
              {iqAssets.slice(0, 24).map((a) => (
                <span key={`${a.category}:${a.symbol}`}>
                  {a.symbol} ({a.category})
                </span>
              ))}
            </div>
          </div>
        )}

        {iqHistory && (
          <div className={`${SUBTLE_PANEL} p-3.5 text-xs text-slate-600 dark:text-slate-300`}>
            <p className="font-medium text-slate-900 dark:text-slate-200">IQ Option Trade History</p>
            <p className="mt-1 text-slate-500 dark:text-slate-400">
              {iqHistory.note} · Entries returned: {iqHistory.trades.length}
            </p>
          </div>
        )}
      </div>

      {/* 2-Broker Capability Matrix (MT5 + IQ Option) */}
      <div className={`${CARD_SURFACE} p-5 sm:p-6 space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">MT5 + IQ Option Adapter Capabilities</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Each connector exposes only verified capabilities supported by its underlying protocol.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {catalog.map((item) => {
            const badge = catalogStatusLabel(item);
            const caps = item.capabilities;
            return (
              <div key={item.id} className={`${SUBTLE_PANEL} p-4 flex flex-col justify-between gap-3`}>
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900 dark:text-white">{item.name}</span>
                    <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${badge.tone}`}>
                      {badge.text}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">{item.description}</p>
                </div>

                {caps && (
                  <div className="border-t border-slate-200/80 dark:border-slate-800 pt-2.5 space-y-1.5 text-[11px] text-slate-600 dark:text-slate-300">
                    <div>
                      <span className="text-slate-500">Asset Classes:</span> {caps.supportedAssetClasses.join(', ')}
                    </div>
                    <div>
                      <span className="text-slate-500">Order Types:</span> {caps.supportedOrderTypes.join(', ')}
                    </div>
                    <div className="flex items-center justify-between pt-1">
                      <span className={caps.demoOrderPlacementSupported ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-amber-600 dark:text-amber-400'}>
                        {caps.demoOrderPlacementSupported ? 'Demo Execution: Yes' : 'Demo Execution: Read-Only'}
                      </span>
                      <button
                        type="button"
                        onClick={() => openAddModal(item.id)}
                        className="text-blue-600 dark:text-indigo-400 font-semibold hover:underline"
                      >
                        Configure
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {onPairAndroidDevice &&
        onUpdateAndroidPermissions &&
        onRevokeAndroidDevice &&
        onAnalyzeAndroidScreenshot &&
        onApproveAndroidAction &&
        onRejectAndroidAction && (
          <AndroidBridgeSection
            devices={androidDevices}
            analyses={androidAnalyses}
            actions={androidActions}
            busy={busy}
            onPairDevice={onPairAndroidDevice}
            onUpdatePermissions={onUpdateAndroidPermissions}
            onRevokeDevice={onRevokeAndroidDevice}
            onAnalyzeScreenshot={onAnalyzeAndroidScreenshot}
            onApproveAction={onApproveAndroidAction}
            onRejectAction={onRejectAndroidAction}
          />
        )}
    </div>
  );
}

interface RiskProps {
  riskStatus: RiskStatus | null;
  busy: boolean;
  onSaveRisk: (settings: RiskSettings) => Promise<void>;
  onRequestEmergencyStop: (engaged: boolean) => void;
  onRequestResetDaily: () => void;
}

type RiskDraft = {
  maxTradeAmount: string;
  dailyLossLimit: string;
  dailyProfitTarget: string;
  maxConsecutiveLosses: string;
  maxDailyTrades: string;
  maxSimultaneousTrades: string;
  tradingScheduleEnabled: boolean;
  tradingStartHourUtc: string;
  tradingEndHourUtc: string;
  emergencyStop: boolean;
};

function toRiskDraft(r: RiskSettings): RiskDraft {
  return {
    maxTradeAmount: String(r.maxTradeAmount),
    dailyLossLimit: String(r.dailyLossLimit),
    dailyProfitTarget: String(r.dailyProfitTarget),
    maxConsecutiveLosses: String(r.maxConsecutiveLosses),
    maxDailyTrades: String(r.maxDailyTrades),
    maxSimultaneousTrades: String(r.maxSimultaneousTrades),
    tradingScheduleEnabled: r.tradingScheduleEnabled,
    tradingStartHourUtc: String(r.tradingStartHourUtc),
    tradingEndHourUtc: String(r.tradingEndHourUtc),
    emergencyStop: r.emergencyStop,
  };
}

function validateRiskDraft(d: RiskDraft): { valid: RiskSettings | null; error: string | null } {
  const maxTradeAmount = Number(d.maxTradeAmount);
  const dailyLossLimit = Number(d.dailyLossLimit);
  const dailyProfitTarget = Number(d.dailyProfitTarget);
  const maxConsecutiveLosses = Number(d.maxConsecutiveLosses);
  const maxDailyTrades = Number(d.maxDailyTrades);
  const maxSimultaneousTrades = Number(d.maxSimultaneousTrades);
  const tradingStartHourUtc = Number(d.tradingStartHourUtc);
  const tradingEndHourUtc = Number(d.tradingEndHourUtc);

  if (!d.maxTradeAmount.trim() || !Number.isFinite(maxTradeAmount) || maxTradeAmount < 1 || maxTradeAmount > 100000) {
    return { valid: null, error: 'Max stake must be between $1 and $100,000.' };
  }
  if (!d.dailyLossLimit.trim() || !Number.isFinite(dailyLossLimit) || dailyLossLimit < 1 || dailyLossLimit > 1000000) {
    return { valid: null, error: 'Daily loss limit must be between $1 and $1,000,000.' };
  }
  if (!d.dailyProfitTarget.trim() || !Number.isFinite(dailyProfitTarget) || dailyProfitTarget < 1 || dailyProfitTarget > 1000000) {
    return { valid: null, error: 'Daily profit target must be between $1 and $1,000,000.' };
  }
  if (!d.maxDailyTrades.trim() || !Number.isInteger(maxDailyTrades) || maxDailyTrades < 1 || maxDailyTrades > 500) {
    return { valid: null, error: 'Max daily trades must be a whole number from 1 to 500.' };
  }
  if (!d.maxConsecutiveLosses.trim() || !Number.isInteger(maxConsecutiveLosses) || maxConsecutiveLosses < 1 || maxConsecutiveLosses > 20) {
    return { valid: null, error: 'Max consecutive losses must be a whole number from 1 to 20.' };
  }
  if (!d.maxSimultaneousTrades.trim() || !Number.isInteger(maxSimultaneousTrades) || maxSimultaneousTrades < 1 || maxSimultaneousTrades > 20) {
    return { valid: null, error: 'Max simultaneous trades must be a whole number from 1 to 20.' };
  }
  if (
    !d.tradingStartHourUtc.trim() ||
    !Number.isInteger(tradingStartHourUtc) ||
    tradingStartHourUtc < 0 ||
    tradingStartHourUtc > 23 ||
    !d.tradingEndHourUtc.trim() ||
    !Number.isInteger(tradingEndHourUtc) ||
    tradingEndHourUtc < 0 ||
    tradingEndHourUtc > 23
  ) {
    return { valid: null, error: 'UTC trading hours must be whole numbers between 0 and 23.' };
  }

  return {
    error: null,
    valid: {
      maxTradeAmount,
      dailyLossLimit,
      dailyProfitTarget,
      maxConsecutiveLosses,
      maxDailyTrades,
      maxSimultaneousTrades,
      tradingScheduleEnabled: d.tradingScheduleEnabled,
      tradingStartHourUtc,
      tradingEndHourUtc,
      emergencyStop: d.emergencyStop,
    },
  };
}

export function RiskManagementView({
  riskStatus,
  busy,
  onSaveRisk,
  onRequestEmergencyStop,
  onRequestResetDaily,
}: RiskProps) {
  const defaultRisk: RiskSettings = riskStatus?.limits || {
    maxTradeAmount: 100,
    dailyLossLimit: 500,
    dailyProfitTarget: 500,
    maxConsecutiveLosses: 3,
    maxDailyTrades: 25,
    maxSimultaneousTrades: 3,
    tradingScheduleEnabled: false,
    tradingStartHourUtc: 7,
    tradingEndHourUtc: 20,
    emergencyStop: false,
  };

  const [draft, setDraft] = useState<RiskDraft>(() => toRiskDraft(defaultRisk));

  const autoSave = useAutoSave<RiskDraft>({
    baseline: toRiskDraft(defaultRisk),
    debounceMs: 600,
    serialize: (val) => {
      const parsed = validateRiskDraft(val);
      return parsed.valid ? JSON.stringify(parsed.valid) : JSON.stringify(val);
    },
    validate: (val) => validateRiskDraft(val).error,
    onSave: async (val) => {
      const parsed = validateRiskDraft(val);
      if (!parsed.valid) throw new Error(parsed.error || 'Invalid risk settings.');
      await onSaveRisk(parsed.valid);
    },
  });

  useEffect(() => {
    if (!riskStatus?.limits) return;
    const next = toRiskDraft(riskStatus.limits);
    if (autoSave.syncBaseline(next)) {
      setDraft(next);
    }
  }, [riskStatus?.limits]); // eslint-disable-line react-hooks/exhaustive-deps

  function updateNumberField(key: keyof RiskDraft, raw: string) {
    const next = { ...draft, [key]: raw };
    setDraft(next);
    autoSave.scheduleSave(next);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">Risk Management</h2>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
            Server-enforced stake cap, max daily loss, max daily trades, consecutive loss pause, daily profit lock, and emergency stop.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onRequestEmergencyStop(!riskStatus?.emergencyStop)}
            className={`min-h-11 inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold whitespace-nowrap transition-colors ${
              riskStatus?.emergencyStop
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                : 'bg-red-600 hover:bg-red-500 text-white'
            }`}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            {riskStatus?.emergencyStop ? 'Clear Emergency Stop' : 'Engage Emergency Stop'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onRequestResetDaily}
            className="min-h-11 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] hover:bg-slate-50 dark:hover:bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap transition-colors"
          >
            Reset Daily Counters
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className={`${CARD_SURFACE} p-4`}>
          <p className="text-xs text-slate-500 dark:text-slate-400">Risk Guard Status</p>
          <p className={`mt-2 text-lg font-semibold ${riskStatus?.allowed ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
            {riskStatus?.allowed ? 'Clear' : 'Paused / Blocked'}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {riskStatus?.reasons[0] || 'All risk thresholds nominal'}
          </p>
        </div>
        <div className={`${CARD_SURFACE} p-4`}>
          <p className="text-xs text-slate-500 dark:text-slate-400">Daily Simulated Loss</p>
          <p className="mt-2 text-lg font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
            ${riskStatus?.simulatedDailyLoss.toFixed(2)} / ${riskStatus?.limits.dailyLossLimit}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Auto-pauses on breach</p>
        </div>
        <div className={`${CARD_SURFACE} p-4`}>
          <p className="text-xs text-slate-500 dark:text-slate-400">Daily Trades &amp; Profit</p>
          <p className="mt-2 text-lg font-semibold font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
            {riskStatus?.dailyTradesCount ?? 0} / {riskStatus?.limits.maxDailyTrades ?? 25}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Profit +${riskStatus?.simulatedDailyProfit.toFixed(2)} / ${riskStatus?.limits.dailyProfitTarget}
          </p>
        </div>
        <div className={`${CARD_SURFACE} p-4`}>
          <p className="text-xs text-slate-500 dark:text-slate-400">Consecutive Losses</p>
          <p className="mt-2 text-lg font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
            {riskStatus?.consecutiveLosses} / {riskStatus?.limits.maxConsecutiveLosses}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Open positions: {riskStatus?.activeTradesCount} / {riskStatus?.limits.maxSimultaneousTrades}
          </p>
        </div>
      </div>

      <div className={`${CARD_SURFACE} p-5 sm:p-6 space-y-5`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 dark:border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-4 w-4 text-blue-600 dark:text-indigo-400 shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Risk Limit Thresholds</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">Changes save automatically when you finish editing.</p>
            </div>
          </div>
          <SaveStatusIndicator
            status={autoSave.status}
            validationError={autoSave.validationError}
            onRetry={autoSave.retry}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Maximum Stake Per Trade ($)</label>
            <input
              type="number"
              min={1}
              max={100000}
              value={draft.maxTradeAmount}
              onChange={(e) => updateNumberField('maxTradeAmount', e.target.value)}
              onBlur={() => autoSave.flushOnBlur(draft)}
              className={`${INPUT_CLASS} font-mono tabular-nums`}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Maximum Daily Loss ($)</label>
            <input
              type="number"
              min={1}
              max={1000000}
              value={draft.dailyLossLimit}
              onChange={(e) => updateNumberField('dailyLossLimit', e.target.value)}
              onBlur={() => autoSave.flushOnBlur(draft)}
              className={`${INPUT_CLASS} font-mono tabular-nums`}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Daily Profit Target ($)</label>
            <input
              type="number"
              min={1}
              max={1000000}
              value={draft.dailyProfitTarget}
              onChange={(e) => updateNumberField('dailyProfitTarget', e.target.value)}
              onBlur={() => autoSave.flushOnBlur(draft)}
              className={`${INPUT_CLASS} font-mono tabular-nums`}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Maximum Daily Trades</label>
            <input
              type="number"
              min={1}
              max={500}
              value={draft.maxDailyTrades}
              onChange={(e) => updateNumberField('maxDailyTrades', e.target.value)}
              onBlur={() => autoSave.flushOnBlur(draft)}
              className={`${INPUT_CLASS} font-mono tabular-nums`}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Maximum Consecutive Losses</label>
            <input
              type="number"
              min={1}
              max={20}
              value={draft.maxConsecutiveLosses}
              onChange={(e) => updateNumberField('maxConsecutiveLosses', e.target.value)}
              onBlur={() => autoSave.flushOnBlur(draft)}
              className={`${INPUT_CLASS} font-mono tabular-nums`}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Max Simultaneous Trades</label>
            <input
              type="number"
              min={1}
              max={20}
              value={draft.maxSimultaneousTrades}
              onChange={(e) => updateNumberField('maxSimultaneousTrades', e.target.value)}
              onBlur={() => autoSave.flushOnBlur(draft)}
              className={`${INPUT_CLASS} font-mono tabular-nums`}
            />
          </div>
        </div>

        <div className="border-t border-slate-200/80 dark:border-slate-800 pt-4 space-y-3">
          <label className="inline-flex min-h-11 items-center gap-2.5 text-sm text-slate-800 dark:text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.tradingScheduleEnabled}
              onChange={(e) => {
                const next = { ...draft, tradingScheduleEnabled: e.target.checked };
                setDraft(next);
                autoSave.scheduleSave(next);
              }}
              className="h-4 w-4 rounded border-slate-400 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
            />
            Enforce UTC Trading Schedule Window
          </label>
          {draft.tradingScheduleEnabled && (
            <div className="grid grid-cols-2 sm:w-80 gap-3">
              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Start Hour (UTC)</label>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={draft.tradingStartHourUtc}
                  onChange={(e) => updateNumberField('tradingStartHourUtc', e.target.value)}
                  onBlur={() => autoSave.flushOnBlur(draft)}
                  className={`${INPUT_CLASS} font-mono tabular-nums`}
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">End Hour (UTC)</label>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={draft.tradingEndHourUtc}
                  onChange={(e) => updateNumberField('tradingEndHourUtc', e.target.value)}
                  onBlur={() => autoSave.flushOnBlur(draft)}
                  className={`${INPUT_CLASS} font-mono tabular-nums`}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type AiDraft = {
  strategyProfile: AiSettings['strategyProfile'];
  minSignalScore: string;
  requireMtfAlignment: boolean;
  enabledAssets: string[];
  defaultTimeframe: Timeframe;
  expirySeconds: string;
  scanIntervalSeconds: string;
  useGeminiCommentary: boolean;
};

function toAiDraft(s: AiSettings): AiDraft {
  return {
    strategyProfile: s.strategyProfile,
    minSignalScore: String(s.minSignalScore),
    requireMtfAlignment: s.requireMtfAlignment,
    enabledAssets: s.enabledAssets,
    defaultTimeframe: s.defaultTimeframe,
    expirySeconds: String(s.expirySeconds),
    scanIntervalSeconds: String(s.scanIntervalSeconds),
    useGeminiCommentary: s.useGeminiCommentary,
  };
}

function validateAiDraft(d: AiDraft): { valid: AiSettings | null; error: string | null } {
  const minSignalScore = Number(d.minSignalScore);
  const expirySeconds = Number(d.expirySeconds);
  const scanIntervalSeconds = Number(d.scanIntervalSeconds);

  if (!d.minSignalScore.trim() || !Number.isInteger(minSignalScore) || minSignalScore < 40 || minSignalScore > 95) {
    return { valid: null, error: 'Minimum score must be a whole number between 40 and 95.' };
  }
  if (!d.expirySeconds.trim() || !Number.isInteger(expirySeconds) || expirySeconds < 60 || expirySeconds > 3600) {
    return { valid: null, error: 'Trade expiry must be between 60 and 3,600 seconds.' };
  }
  if (!d.scanIntervalSeconds.trim() || !Number.isInteger(scanIntervalSeconds) || scanIntervalSeconds < 15 || scanIntervalSeconds > 900) {
    return { valid: null, error: 'Scan interval must be between 15 and 900 seconds.' };
  }
  if (d.enabledAssets.length < 1) {
    return { valid: null, error: 'Select at least one instrument for autonomous watchlist.' };
  }

  return {
    error: null,
    valid: {
      strategyProfile: d.strategyProfile,
      minSignalScore,
      requireMtfAlignment: d.requireMtfAlignment,
      enabledAssets: d.enabledAssets,
      defaultTimeframe: d.defaultTimeframe,
      expirySeconds,
      scanIntervalSeconds,
      useGeminiCommentary: d.useGeminiCommentary,
    },
  };
}

function validateProfile(p: UserProfile): string | null {
  if (!p.displayName || p.displayName.trim().length < 2) {
    return 'Display name must be at least 2 characters.';
  }
  if (!p.timezone || p.timezone.trim().length < 2) {
    return 'Timezone cannot be empty.';
  }
  if (!p.preferredCurrency) {
    return 'Select a preferred currency.';
  }
  return null;
}

export function SettingsView({
  aiSettings,
  assets,
  profile,
  activity,
  themePreference,
  systemPrefersDark,
  onChangeTheme,
  onSaveAiSettings,
  onUpdateProfile,
  onSignOut,
}: {
  aiSettings: AiSettings | null;
  assets: AssetDefinition[];
  profile: UserProfile;
  activity: ActivityEvent[];
  themePreference: ThemePreference;
  systemPrefersDark?: boolean;
  onChangeTheme: (next: ThemePreference) => void;
  onSaveAiSettings: (settings: AiSettings) => Promise<void>;
  onUpdateProfile: (p: UserProfile) => void;
  onSignOut: () => void;
}) {
  const defaultAi: AiSettings = aiSettings || {
    strategyProfile: 'balanced',
    minSignalScore: 65,
    requireMtfAlignment: true,
    enabledAssets: ['EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY', 'BTCUSD', 'ETHUSD'],
    defaultTimeframe: '1m',
    expirySeconds: 180,
    scanIntervalSeconds: 60,
    useGeminiCommentary: true,
  };

  const [aiDraft, setAiDraft] = useState<AiDraft>(() => toAiDraft(defaultAi));
  const [profileForm, setProfileForm] = useState<UserProfile>(profile);

  const aiAutoSave = useAutoSave<AiDraft>({
    baseline: aiSettings ? toAiDraft(aiSettings) : null,
    debounceMs: 550,
    serialize: (val) => {
      const parsed = validateAiDraft(val);
      return parsed.valid ? JSON.stringify(parsed.valid) : JSON.stringify(val);
    },
    validate: (val) => validateAiDraft(val).error,
    onSave: async (val) => {
      const parsed = validateAiDraft(val);
      if (!parsed.valid) throw new Error(parsed.error || 'Invalid AI configuration.');
      await onSaveAiSettings(parsed.valid);
    },
  });

  const profileAutoSave = useAutoSave<UserProfile>({
    baseline: profile,
    debounceMs: 600,
    serialize: (p) =>
      JSON.stringify({
        id: p.id,
        displayName: p.displayName.trim(),
        preferredCurrency: p.preferredCurrency,
        timezone: p.timezone.trim(),
      }),
    validate: validateProfile,
    onSave: async (p) => {
      const cleaned: UserProfile = {
        ...p,
        displayName: p.displayName.trim(),
        timezone: p.timezone.trim(),
      };
      const updated = isSupabaseConfigured ? await updateSupabaseProfile(cleaned) : cleaned;
      onUpdateProfile(updated);
    },
  });

  useEffect(() => {
    if (!aiSettings) return;
    const next = toAiDraft(aiSettings);
    if (aiAutoSave.syncBaseline(next)) {
      setAiDraft(next);
    }
  }, [aiSettings]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (profileAutoSave.syncBaseline(profile, profile.id !== profileForm.id)) {
      setProfileForm(profile);
    }
  }, [profile]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleAsset(sym: string) {
    const exists = aiDraft.enabledAssets.includes(sym);
    if (exists && aiDraft.enabledAssets.length <= 1) return;
    const next: AiDraft = {
      ...aiDraft,
      enabledAssets: exists
        ? aiDraft.enabledAssets.filter((s) => s !== sym)
        : [...aiDraft.enabledAssets, sym],
    };
    setAiDraft(next);
    aiAutoSave.scheduleSave(next);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">Platform Settings &amp; Profile</h2>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
            Configure appearance, autonomous scheduler thresholds, trader profile, and review account activity. Changes save automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="min-h-11 inline-flex items-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] hover:bg-slate-50 dark:hover:bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" /> Sign Out
        </button>
      </div>

      {/* Appearance & Theme */}
      <div className={`${CARD_SURFACE} p-5 sm:p-6 space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070C17] text-blue-600 dark:text-indigo-400">
              <Palette className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Appearance &amp; Theme</h3>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Choose Light Mode, Dark Mode, or follow your Android, desktop, or browser System Default appearance.
              </p>
            </div>
          </div>
        </div>
        <ThemeSwitcher value={themePreference} systemPrefersDark={systemPrefersDark} onChange={onChangeTheme} />
      </div>

      {/* AI Strategy & Scan Interval Settings */}
      {aiSettings && (
        <div className={`${CARD_SURFACE} p-5 sm:p-6 space-y-5`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 dark:border-slate-800 pb-4">
            <div className="flex items-center gap-2.5">
              <Sliders className="h-4 w-4 text-blue-600 dark:text-indigo-400 shrink-0" />
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Quantitative AI &amp; Scheduler Configuration</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">Watchlist, confidence thresholds, expiry, and scan cadence save automatically.</p>
              </div>
            </div>
            <SaveStatusIndicator
              status={aiAutoSave.status}
              validationError={aiAutoSave.validationError}
              onRetry={aiAutoSave.retry}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Strategy Profile</label>
              <select
                value={aiDraft.strategyProfile}
                onChange={(e) => {
                  const next = { ...aiDraft, strategyProfile: e.target.value as AiSettings['strategyProfile'] };
                  setAiDraft(next);
                  aiAutoSave.scheduleSave(next);
                }}
                className={SELECT_CLASS}
              >
                <option value="conservative">Conservative</option>
                <option value="balanced">Balanced</option>
                <option value="momentum">Momentum</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Min Score (40–95)</label>
              <input
                type="number"
                min={40}
                max={95}
                value={aiDraft.minSignalScore}
                onChange={(e) => {
                  const next = { ...aiDraft, minSignalScore: e.target.value };
                  setAiDraft(next);
                  aiAutoSave.scheduleSave(next);
                }}
                onBlur={() => aiAutoSave.flushOnBlur(aiDraft)}
                className={`${INPUT_CLASS} font-mono tabular-nums`}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Default Timeframe</label>
              <select
                value={aiDraft.defaultTimeframe}
                onChange={(e) => {
                  const next = { ...aiDraft, defaultTimeframe: e.target.value as Timeframe };
                  setAiDraft(next);
                  aiAutoSave.scheduleSave(next);
                }}
                className={SELECT_CLASS}
              >
                <option value="1m">1 Minute</option>
                <option value="5m">5 Minutes</option>
                <option value="15m">15 Minutes</option>
                <option value="1h">1 Hour</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Trade Expiry (sec)</label>
              <input
                type="number"
                min={60}
                max={3600}
                step={30}
                value={aiDraft.expirySeconds}
                onChange={(e) => {
                  const next = { ...aiDraft, expirySeconds: e.target.value };
                  setAiDraft(next);
                  aiAutoSave.scheduleSave(next);
                }}
                onBlur={() => aiAutoSave.flushOnBlur(aiDraft)}
                className={`${INPUT_CLASS} font-mono tabular-nums`}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Scan Interval (sec)</label>
              <input
                type="number"
                min={15}
                max={900}
                step={15}
                value={aiDraft.scanIntervalSeconds}
                onChange={(e) => {
                  const next = { ...aiDraft, scanIntervalSeconds: e.target.value };
                  setAiDraft(next);
                  aiAutoSave.scheduleSave(next);
                }}
                onBlur={() => aiAutoSave.flushOnBlur(aiDraft)}
                className={`${INPUT_CLASS} font-mono tabular-nums`}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-6 border-t border-slate-200/80 dark:border-slate-800 pt-4">
            <label className="inline-flex min-h-10 items-center gap-2.5 text-sm text-slate-800 dark:text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={aiDraft.requireMtfAlignment}
                onChange={(e) => {
                  const next = { ...aiDraft, requireMtfAlignment: e.target.checked };
                  setAiDraft(next);
                  aiAutoSave.scheduleSave(next);
                }}
                className="h-4 w-4 rounded border-slate-400 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
              />
              Require Higher-Timeframe Alignment (MTF Filter)
            </label>
            <label className="inline-flex min-h-10 items-center gap-2.5 text-sm text-slate-800 dark:text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={aiDraft.useGeminiCommentary}
                onChange={(e) => {
                  const next = { ...aiDraft, useGeminiCommentary: e.target.checked };
                  setAiDraft(next);
                  aiAutoSave.scheduleSave(next);
                }}
                className="h-4 w-4 rounded border-slate-400 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
              />
              Generate Gemini Analyst Commentary (explanations only)
            </label>
          </div>

          <div className="border-t border-slate-200/80 dark:border-slate-800 pt-4">
            <p className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2.5">
              Autonomous Mode Watchlist ({aiDraft.enabledAssets.length} active)
            </p>
            <div className="flex flex-wrap gap-2">
              {assets.map((asset) => {
                const active = aiDraft.enabledAssets.includes(asset.symbol);
                return (
                  <button
                    key={asset.symbol}
                    type="button"
                    onClick={() => toggleAsset(asset.symbol)}
                    className={`min-h-10 inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                      active
                        ? 'border-blue-500/70 bg-blue-500/10 text-blue-700 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070C17] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    {active && <Check className="h-3 w-3" />}
                    {asset.symbol}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* User Profile & Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className={`${CARD_SURFACE} p-5 sm:p-6 space-y-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 dark:border-slate-800 pb-3.5">
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-blue-600 dark:text-indigo-400" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Trader Profile</h3>
            </div>
            <SaveStatusIndicator
              status={profileAutoSave.status}
              validationError={profileAutoSave.validationError}
              onRetry={profileAutoSave.retry}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">Email</label>
            <input
              type="email"
              disabled
              value={profileForm.email}
              className="w-full min-h-11 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-[#070C17] px-3.5 py-2 text-sm text-slate-500 dark:text-slate-400 cursor-not-allowed"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Display Name</label>
            <input
              type="text"
              value={profileForm.displayName}
              onChange={(e) => {
                const next = { ...profileForm, displayName: e.target.value };
                setProfileForm(next);
                profileAutoSave.scheduleSave(next);
              }}
              onBlur={() => profileAutoSave.flushOnBlur(profileForm)}
              placeholder="Your trader name"
              className={INPUT_CLASS}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Preferred Currency</label>
              <select
                value={profileForm.preferredCurrency}
                onChange={(e) => {
                  const next = { ...profileForm, preferredCurrency: e.target.value };
                  setProfileForm(next);
                  profileAutoSave.scheduleSave(next);
                }}
                className={SELECT_CLASS}
              >
                <option value="USD">USD ($)</option>
                <option value="EUR">EUR (€)</option>
                <option value="GBP">GBP (£)</option>
                <option value="NGN">NGN (₦)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Timezone</label>
              <input
                type="text"
                value={profileForm.timezone}
                onChange={(e) => {
                  const next = { ...profileForm, timezone: e.target.value };
                  setProfileForm(next);
                  profileAutoSave.scheduleSave(next);
                }}
                onBlur={() => profileAutoSave.flushOnBlur(profileForm)}
                placeholder="e.g. Africa/Lagos or UTC"
                className={INPUT_CLASS}
              />
            </div>
          </div>

          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Updates persist automatically when you finish editing.
          </p>
        </div>

        <div className={`${CARD_SURFACE} p-5 sm:p-6`}>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-3.5 border-b border-slate-200/80 dark:border-slate-800 pb-3.5">
            Recent Account Activity
          </h3>
          {activity.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center">No activity recorded yet.</p>
          ) : (
            <div className="space-y-2.5 max-h-[340px] overflow-y-auto pr-1">
              {activity.slice(0, 25).map((ev) => (
                <div key={ev.id} className="border-b border-slate-200/70 dark:border-slate-800/80 pb-2.5 text-xs last:border-b-0">
                  <div className="flex items-center justify-between gap-2 text-slate-500 dark:text-slate-400">
                    <span className="font-medium text-slate-800 dark:text-slate-200 truncate">
                      {ev.category} · {ev.eventType}
                    </span>
                    <span className="font-mono tabular-nums shrink-0">{new Date(ev.createdAt).toLocaleTimeString()}</span>
                  </div>
                  <p className="mt-0.5 text-slate-600 dark:text-slate-400 leading-relaxed">{ev.summary}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  Bell,
  Bot,
  Cable,
  CandlestickChart as CandleIcon,
  Check,
  CheckCircle2,
  ChevronDown,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  MoreHorizontal,
  Play,
  Radar,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sun,
  Target,
  TrendingUp,
  Wallet,
  X,
  XCircle,
} from 'lucide-react';
import type {
  ActivityEvent,
  AiSettings,
  AnalyticsSummary,
  AndroidActionQueueItem,
  AndroidDevicePublic,
  AndroidScreenAnalysisRecord,
  AssetDefinition,
  AssistedProposal,
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
  CandleFeedResponse,
  HealthStatus,
  InstrumentCompatibilityResult,
  ManagedBrokerAccountPublic,
  NavSection,
  OperatingMode,
  PaperTrade,
  RiskSettings,
  RiskStatus,
  ScannerRow,
  SignalRecord,
  ThemePreference,
  Timeframe,
  ToastNotice,
  UserProfile,
} from './types';
import { apiRequest, sanitizeErrorMessage } from './lib/api';
import {
  fetchUserWorkspaceFromSupabase,
  isAuthCallbackRoute,
  isSupabaseConfigured,
  loadSupabaseProfile,
  persistPaperTradeToSupabase,
  persistSignalToSupabase,
  signOutSupabase,
  supabase,
  syncSupabaseSettings,
} from './lib/supabase';
import { CandlestickChart } from './components/CandlestickChart';
import { EquityChart } from './components/EquityChart';
import { AuthGateView } from './components/AuthGateView';
import { AuthCallbackView } from './components/AuthCallbackView';
import { ConfirmDialog } from './components/ConfirmDialog';
import {
  CARD_SURFACE,
  INPUT_CLASS,
  NovaLogo,
  SELECT_CLASS,
  SUBTLE_PANEL,
  ThemeSwitcher,
} from './components/ui';
import {
  AnalyticsView,
  MarketScannerView,
  PaperTradingDeskView,
  SignalsView,
  TradeHistoryView,
} from './components/TradingViews';
import {
  BrokerConnectionsView,
  RiskManagementView,
  SettingsView,
} from './components/BrokerAndRiskViews';
import { NovaPayView } from './components/NovaPayView';

const LOCAL_PROFILE_KEY = 'novatrade_local_profile_v1';
const THEME_STORAGE_KEY = 'novatrade_theme_v1';

const NAV_GROUPS: Array<{
  title: string;
  items: Array<{ id: NavSection; label: string; icon: typeof LayoutDashboard }>;
}> = [
  {
    title: 'Workspace',
    items: [
      { id: 'overview', label: 'Overview', icon: LayoutDashboard },
      { id: 'scanner', label: 'AI Scanner', icon: Radar },
      { id: 'live-markets', label: 'Live Markets', icon: CandleIcon },
      { id: 'signals', label: 'Trading Signals', icon: Activity },
    ],
  },
  {
    title: 'Execution',
    items: [
      { id: 'paper-trading', label: 'Paper Trading', icon: Wallet },
      { id: 'history', label: 'Trade History', icon: History },
      { id: 'analytics', label: 'Performance Analytics', icon: BarChart3 },
    ],
  },
  {
    title: 'Controls',
    items: [
      { id: 'risk', label: 'Risk Management', icon: ShieldCheck },
      { id: 'brokers', label: 'Broker Connections', icon: Cable },
      { id: 'novapay', label: 'NovaPay Wallet', icon: Wallet },
      { id: 'settings', label: 'Settings', icon: Sliders },
    ],
  },
];

const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

function readStoredThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    // Ignore storage read errors
  }
  return 'system';
}

export default function App() {
  const [inAuthCallback, setInAuthCallback] = useState(() => isAuthCallbackRoute());
  const [authReady, setAuthReady] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [supabaseAccessToken, setSupabaseAccessToken] = useState<string | null>(null);
  const [activeNav, setActiveNav] = useState<NavSection>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [lastSeenActivityCount, setLastSeenActivityCount] = useState(0);

  // Light / Dark / System theme management
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readStoredThemePreference());
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    setSystemPrefersDark(mql.matches);
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  const resolvedTheme: 'light' | 'dark' =
    themePreference === 'system' ? (systemPrefersDark ? 'dark' : 'light') : themePreference;

  useEffect(() => {
    const root = document.documentElement;
    if (resolvedTheme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', resolvedTheme === 'dark' ? '#060A13' : '#F8FAFC');
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    } catch {
      // Ignore storage errors
    }
  }, [resolvedTheme, themePreference]);

  // Market & Chart state
  const [assets, setAssets] = useState<AssetDefinition[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState('EURUSD');
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>('1m');
  const [candleFeed, setCandleFeed] = useState<CandleFeedResponse | null>(null);
  const [candleLoading, setCandleLoading] = useState(false);
  const [candleError, setCandleError] = useState<string | null>(null);

  // Platform state
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [mode, setMode] = useState<OperatingMode>('signals');
  const [autoArmed, setAutoArmed] = useState(false);
  const [riskStatus, setRiskStatus] = useState<RiskStatus | null>(null);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);
  const [brokerStatus, setBrokerStatus] = useState<BrokerStatusSnapshot | null>(null);
  const [brokerCatalog, setBrokerCatalog] = useState<BrokerCatalogItem[]>([]);
  const [brokerAccounts, setBrokerAccounts] = useState<ManagedBrokerAccountPublic[]>([]);
  const [activeBrokerAccountId, setActiveBrokerAccountId] = useState<string | null>(null);
  const [autoBrokerExecution, setAutoBrokerExecution] = useState(false);
  const [brokerOrders, setBrokerOrders] = useState<BrokerOrderRecord[]>([]);
  const [androidDevices, setAndroidDevices] = useState<AndroidDevicePublic[]>([]);
  const [androidAnalyses, setAndroidAnalyses] = useState<AndroidScreenAnalysisRecord[]>([]);
  const [androidActions, setAndroidActions] = useState<AndroidActionQueueItem[]>([]);

  // Signals, Trades, Proposals, Analytics, Activity
  const [currentAnalysis, setCurrentAnalysis] = useState<SignalRecord | null>(null);
  const [signals, setSignals] = useState<SignalRecord[]>([]);
  const [scannerRows, setScannerRows] = useState<ScannerRow[]>([]);
  const [scanProgress, setScanProgress] = useState<{
    active: boolean;
    completed: number;
    total: number;
    currentSymbol: string | null;
    latestDirection: 'CALL' | 'PUT' | 'WAIT' | null;
  }>({ active: false, completed: 0, total: 0, currentSymbol: null, latestDirection: null });
  const [paperTrades, setPaperTrades] = useState<PaperTrade[]>([]);
  const [activeTrades, setActiveTrades] = useState<PaperTrade[]>([]);
  const [proposals, setProposals] = useState<AssistedProposal[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);

  // Interactive controls, toasts, and confirmations
  const [manualStakeDraft, setManualStakeDraft] = useState('50');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [toasts, setToasts] = useState<ToastNotice[]>([]);
  const [confirmState, setConfirmState] = useState<{
    type: 'emergency-stop' | 'reset-daily' | 'arm-auto' | null;
    payload?: boolean;
  }>({ type: null });

  const pushToast = useCallback((kind: ToastNotice['kind'], title: string, message: string) => {
    const safeMessage =
      kind === 'error'
        ? sanitizeErrorMessage(message, 'An unexpected error occurred. Please try again.')
        : sanitizeErrorMessage(message, message);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [{ id, kind, title, message: safeMessage, createdAt: new Date().toISOString() }, ...prev].slice(0, 4));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5200);
  }, []);

  const authHeaders = useMemo<Record<string, string>>(() => {
    const headers: Record<string, string> = {};
    if (supabaseAccessToken) {
      headers.Authorization = `Bearer ${supabaseAccessToken}`;
    }
    return headers;
  }, [supabaseAccessToken]);

  // Auth & persistent session initialization
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      try {
        const saved = localStorage.getItem(LOCAL_PROFILE_KEY);
        if (saved) {
          setProfile(JSON.parse(saved) as UserProfile);
        } else {
          setProfile({
            id: 'local-research-session',
            email: 'research@novatrade.local',
            displayName: 'Research Workspace',
            role: 'trader',
            preferredCurrency: 'USD',
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            authMode: 'local-preview',
          });
        }
      } catch {
        setProfile(null);
      }
      setAuthReady(true);
      return;
    }

    let mounted = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return;
      if (data.session?.user) {
        setSupabaseAccessToken(data.session.access_token);
        const p = await loadSupabaseProfile(data.session.user.id, data.session.user.email || '');
        if (mounted) setProfile(p);
      } else {
        setProfile(null);
      }
      setAuthReady(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!mounted) return;
      if (session?.user) {
        setSupabaseAccessToken(session.access_token);
        const p = await loadSupabaseProfile(session.user.id, session.user.email || '');
        if (mounted) setProfile(p);
      } else {
        setSupabaseAccessToken(null);
        setProfile(null);
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const refreshPlatformState = useCallback(async () => {
    try {
      const [
        healthRes,
        assetsRes,
        riskRes,
        aiRes,
        autoRes,
        brokerRes,
        catalogRes,
        accountsRes,
        brokerOrdersRes,
        tradesRes,
        signalsRes,
        proposalsRes,
        analyticsRes,
        activityRes,
        androidDevicesRes,
        androidAnalysesRes,
        androidActionsRes,
      ] = await Promise.all([
        apiRequest<HealthStatus>('/api/health', { headers: authHeaders }),
        apiRequest<{ assets: AssetDefinition[] }>('/api/market/assets', { headers: authHeaders }),
        apiRequest<RiskStatus>('/api/risk/status', { headers: authHeaders }),
        apiRequest<{ settings: AiSettings }>('/api/ai/settings', { headers: authHeaders }),
        apiRequest<{ armed: boolean }>('/api/auto-paper/status', { headers: authHeaders }),
        apiRequest<BrokerStatusSnapshot>('/api/broker/status', { headers: authHeaders }),
        apiRequest<{ brokers: BrokerCatalogItem[] }>('/api/brokers/catalog', { headers: authHeaders }),
        apiRequest<{
          activeAccountId: string | null;
          autoExecuteBrokerDemo?: boolean;
          accounts: ManagedBrokerAccountPublic[];
        }>('/api/brokers/accounts', { headers: authHeaders }),
        apiRequest<{ orders: BrokerOrderRecord[] }>('/api/brokers/orders', { headers: authHeaders }),
        apiRequest<{ trades: PaperTrade[]; activeTrades: PaperTrade[] }>('/api/paper-trades', { headers: authHeaders }),
        apiRequest<{ signals: SignalRecord[] }>('/api/signals', { headers: authHeaders }),
        apiRequest<{ proposals: AssistedProposal[] }>('/api/assisted/proposals', { headers: authHeaders }),
        apiRequest<AnalyticsSummary>('/api/analytics', { headers: authHeaders }),
        apiRequest<{ events: ActivityEvent[] }>('/api/activity', { headers: authHeaders }),
        apiRequest<{ devices: AndroidDevicePublic[] }>('/api/android/devices', { headers: authHeaders }).catch(() => ({
          devices: [],
        })),
        apiRequest<{ analyses: AndroidScreenAnalysisRecord[] }>('/api/android/analyses', { headers: authHeaders }).catch(
          () => ({ analyses: [] })
        ),
        apiRequest<{ actions: AndroidActionQueueItem[] }>('/api/android/actions', { headers: authHeaders }).catch(() => ({
          actions: [],
        })),
      ]);

      setHealth(healthRes);
      setMode(healthRes.mode);
      setAssets(assetsRes.assets);
      setRiskStatus(riskRes);
      setAiSettings(aiRes.settings);
      setAutoArmed(autoRes.armed);
      setBrokerStatus(brokerRes ?? null);
      setBrokerCatalog(Array.isArray(catalogRes?.brokers) ? catalogRes.brokers : []);
      setBrokerAccounts(Array.isArray(accountsRes?.accounts) ? accountsRes.accounts.filter(Boolean) : []);
      setActiveBrokerAccountId(accountsRes?.activeAccountId ?? null);
      setAutoBrokerExecution(Boolean(accountsRes?.autoExecuteBrokerDemo) && !riskRes?.emergencyStop);
      setBrokerOrders(brokerOrdersRes.orders);
      setPaperTrades(tradesRes.trades);
      setActiveTrades(tradesRes.activeTrades);
      setSignals(signalsRes.signals);
      setProposals(proposalsRes.proposals);
      setAnalytics(analyticsRes);
      setActivity(activityRes.events);
      setAndroidDevices(Array.isArray(androidDevicesRes?.devices) ? androidDevicesRes.devices : []);
      setAndroidAnalyses(Array.isArray(androidAnalysesRes?.analyses) ? androidAnalysesRes.analyses : []);
      setAndroidActions(Array.isArray(androidActionsRes?.actions) ? androidActionsRes.actions : []);
      if (!currentAnalysis && signalsRes.signals[0]) {
        setCurrentAnalysis(signalsRes.signals[0]);
      }
    } catch (err) {
      pushToast('error', 'Connection Issue', err instanceof Error ? err.message : 'Unable to reach NovaTrade API.');
    }
  }, [authHeaders, currentAnalysis, pushToast]);

  // Hydrate Supabase user workspace once session becomes active
  useEffect(() => {
    if (!profile || profile.authMode !== 'supabase' || !supabaseAccessToken) return;
    let active = true;
    fetchUserWorkspaceFromSupabase(profile.id).then(async (workspace) => {
      if (!active || !workspace) return;
      try {
        await apiRequest('/api/state/hydrate', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(workspace),
        });
        await refreshPlatformState();
      } catch {
        // Non-fatal
      }
    });
    return () => {
      active = false;
    };
  }, [profile?.id, profile?.authMode, supabaseAccessToken, authHeaders, refreshPlatformState]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadCandles = useCallback(async (symbol: string, timeframe: Timeframe) => {
    setCandleLoading(true);
    setCandleError(null);
    try {
      const res = await apiRequest<CandleFeedResponse>(
        `/api/market/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=140`
      );
      setCandleFeed(res);
    } catch (err) {
      setCandleError(err instanceof Error ? err.message : 'Failed to load candles.');
      setCandleFeed(null);
    } finally {
      setCandleLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!profile) return;
    void refreshPlatformState();
    const timer = setInterval(() => {
      void refreshPlatformState();
    }, 10_000);
    return () => clearInterval(timer);
  }, [profile?.id, refreshPlatformState]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live price & candle refresh loop on Live Markets
  useEffect(() => {
    if (!profile) return;
    void loadCandles(selectedSymbol, selectedTimeframe);
    const liveFeedTimer = setInterval(() => {
      if (activeNav === 'live-markets' || activeNav === 'overview') {
        void loadCandles(selectedSymbol, selectedTimeframe);
      }
    }, 12_000);
    return () => clearInterval(liveFeedTimer);
  }, [profile?.id, selectedSymbol, selectedTimeframe, activeNav, loadCandles]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedAssetMeta = useMemo(
    () =>
      assets.find((a) => a.symbol === selectedSymbol) || {
        symbol: selectedSymbol,
        name: selectedSymbol,
        category: 'FX' as const,
        instrumentType: 'FOREX' as const,
        decimals: 5,
      },
    [assets, selectedSymbol]
  );

  const groupedAssets = useMemo(() => {
    const list = assets.length > 0 ? assets : [selectedAssetMeta];
    return {
      FOREX: list.filter((a) => a.instrumentType === 'FOREX'),
      CRYPTO: list.filter((a) => a.instrumentType === 'CRYPTO'),
      COMMODITY: list.filter((a) => a.instrumentType === 'COMMODITY'),
    };
  }, [assets, selectedAssetMeta]);

  async function handleRunAnalysis() {
    setBusy(true);
    try {
      const res = await apiRequest<{ signal: SignalRecord; marketError?: string }>('/api/signals/analyse', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ symbol: selectedSymbol, timeframe: selectedTimeframe }),
      });
      setCurrentAnalysis(res.signal);
      if (profile?.authMode === 'supabase') {
        void persistSignalToSupabase(profile.id, res.signal).catch(() => undefined);
      }
      if (res.marketError) {
        pushToast('error', 'Market Feed Unavailable', res.marketError);
      } else {
        pushToast(
          res.signal.direction === 'WAIT' ? 'info' : 'success',
          `${res.signal.symbol} (${res.signal.timeframe}) · ${res.signal.direction}`,
          `Confidence ${res.signal.confidenceScore ?? res.signal.score}/100 · Risk ${res.signal.riskAssessment?.level || 'MODERATE'}`
        );
      }
      await refreshPlatformState();
      await loadCandles(selectedSymbol, selectedTimeframe);
    } catch (err) {
      pushToast('error', 'Analysis Failed', err instanceof Error ? err.message : 'Quantitative evaluation failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleModeChange(nextMode: OperatingMode) {
    setBusy(true);
    try {
      await apiRequest('/api/mode', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ mode: nextMode }),
      });
      setMode(nextMode);
      if (profile && isSupabaseConfigured && aiSettings && riskStatus) {
        void syncSupabaseSettings(
          profile.id,
          nextMode,
          riskStatus.limits,
          aiSettings,
          autoArmed,
          analytics?.startingVirtualBalance
        ).catch(() => undefined);
      }
      pushToast('info', 'Operating Mode Updated', `Switched to ${nextMode.toUpperCase()} mode.`);
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Mode Switch Failed', err instanceof Error ? err.message : 'Could not change mode.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateAssistedProposal() {
    setBusy(true);
    try {
      const res = await apiRequest<{ analysis: SignalRecord; proposal: AssistedProposal | null; notice: string }>(
        '/api/assisted/propose',
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ symbol: selectedSymbol, timeframe: selectedTimeframe }),
        }
      );
      setCurrentAnalysis(res.analysis);
      pushToast(res.proposal ? 'warning' : 'info', 'Assisted Proposal', res.notice);
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Assisted Analysis Failed', err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleApproveProposal(id: string) {
    setBusy(true);
    try {
      const res = await apiRequest<{ trade?: PaperTrade; notice: string }>(`/api/assisted/proposals/${id}/approve`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      if (res.trade && profile?.authMode === 'supabase') {
        void persistPaperTradeToSupabase(profile.id, res.trade).catch(() => undefined);
      }
      pushToast('success', 'Paper Trade Approved', res.notice);
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Approval Rejected', err instanceof Error ? err.message : 'Blocked by risk guard.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRejectProposal(id: string) {
    setBusy(true);
    try {
      await apiRequest(`/api/assisted/proposals/${id}/reject`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      pushToast('info', 'Proposal Rejected', 'No paper position opened.');
      await refreshPlatformState();
    } finally {
      setBusy(false);
    }
  }

  async function executeToggleAutoArm(targetArmed: boolean) {
    setBusy(true);
    try {
      const res = await apiRequest<{ armed: boolean; notice: string }>('/api/auto-paper/arm', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ enabled: targetArmed }),
      });
      setAutoArmed(res.armed);
      if (res.armed) setMode('automatic');
      if (profile && isSupabaseConfigured && aiSettings && riskStatus) {
        await syncSupabaseSettings(
          profile.id,
          res.armed ? 'automatic' : mode,
          riskStatus.limits,
          aiSettings,
          res.armed,
          analytics?.startingVirtualBalance
        ).catch(() => undefined);
      }
      pushToast(res.armed ? 'success' : 'info', res.armed ? 'Autonomous Mode Armed' : 'Autonomous Mode Paused', res.notice);
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Autonomous Mode Blocked', err instanceof Error ? err.message : 'Risk guard blocked automatic mode.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRunAutoCycleNow() {
    setBusy(true);
    try {
      const res = await apiRequest<{ summary: string }>('/api/auto-paper/cycle', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      pushToast('info', 'Scheduler Cycle Complete', res.summary);
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Scheduler Cycle Failed', err instanceof Error ? err.message : 'Cycle error.');
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenManualPaperTrade(symbol: string, direction: 'CALL' | 'PUT', amount: number) {
    setBusy(true);
    try {
      const res = await apiRequest<{ trade: PaperTrade; notice: string }>('/api/paper-trades', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          symbol,
          timeframe: selectedTimeframe,
          direction,
          amount,
          entryPrice: symbol === selectedSymbol ? candleFeed?.currentPrice ?? null : null,
          expirySeconds: aiSettings?.expirySeconds ?? 180,
          mode,
        }),
      });
      if (res.trade && profile?.authMode === 'supabase') {
        void persistPaperTradeToSupabase(profile.id, res.trade).catch(() => undefined);
      }
      pushToast('success', `Paper ${direction} Opened`, `${symbol} · $${amount.toFixed(2)} (${res.notice})`);
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Paper Trade Blocked', err instanceof Error ? err.message : 'Risk limits exceeded.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSettleTrade(id: string, outcome: 'win' | 'loss') {
    setBusy(true);
    try {
      const res = await apiRequest<{ trade: PaperTrade }>(`/api/paper-trades/${id}/settle`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ outcome }),
      });
      if (res.trade && profile?.authMode === 'supabase') {
        void persistPaperTradeToSupabase(profile.id, res.trade).catch(() => undefined);
      }
      pushToast(outcome === 'win' ? 'success' : 'warning', `Trade Settled (${outcome.toUpperCase()})`, `${res.trade.symbol} PnL ${res.trade.pnl ?? 0}`);
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Settlement Failed', err instanceof Error ? err.message : 'Unable to settle.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelTrade(id: string) {
    setBusy(true);
    try {
      const res = await apiRequest<{ trade: PaperTrade }>(`/api/paper-trades/${id}/cancel`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      if (res.trade && profile?.authMode === 'supabase') {
        void persistPaperTradeToSupabase(profile.id, res.trade).catch(() => undefined);
      }
      pushToast('info', 'Paper Trade Cancelled', 'Position cancelled without PnL.');
      await refreshPlatformState();
    } finally {
      setBusy(false);
    }
  }

  /** Silent auto-save handler for starting virtual capital (throws on error for retry UI) */
  const handleUpdateStartingBalance = useCallback(
    async (startingVirtualBalance: number) => {
      await apiRequest('/api/virtual-balance', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ startingVirtualBalance }),
      });
      if (profile && isSupabaseConfigured && aiSettings && riskStatus) {
        await syncSupabaseSettings(profile.id, mode, riskStatus.limits, aiSettings, autoArmed, startingVirtualBalance);
      }
      setAnalytics((prev) =>
        prev
          ? {
              ...prev,
              startingVirtualBalance,
              currentVirtualBalance: startingVirtualBalance + prev.netPnl,
            }
          : prev
      );
    },
    [aiSettings, authHeaders, autoArmed, mode, profile, riskStatus]
  );

  async function handleProgressiveScan(symbols: string[]) {
    if (symbols.length === 0) return;
    setScanning(true);
    setScanProgress({
      active: true,
      completed: 0,
      total: symbols.length,
      currentSymbol: symbols[0],
      latestDirection: null,
    });
    const collected: ScannerRow[] = [];

    try {
      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        setScanProgress((prev) => ({ ...prev, currentSymbol: sym }));
        const res = await apiRequest<{ row: ScannerRow }>('/api/scanner/scan-one', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ symbol: sym, timeframe: selectedTimeframe }),
        });
        collected.push(res.row);
        setScannerRows([...collected]);
        setScanProgress({
          active: i + 1 < symbols.length,
          completed: i + 1,
          total: symbols.length,
          currentSymbol: sym,
          latestDirection: res.row.direction,
        });
      }
      pushToast('success', 'AI Market Scan Complete', `Evaluated ${collected.length} instruments on ${selectedTimeframe}.`);
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Market Scan Interrupted', err instanceof Error ? err.message : 'Scan error.');
    } finally {
      setScanning(false);
    }
  }

  /** Silent auto-save handler for risk settings (throws on error for retry UI) */
  const handleSaveRisk = useCallback(
    async (settings: RiskSettings) => {
      const res = await apiRequest<{ settings: RiskSettings; status: RiskStatus }>('/api/risk/settings', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(settings),
      });
      if (profile && isSupabaseConfigured && aiSettings) {
        await syncSupabaseSettings(
          profile.id,
          mode,
          settings,
          aiSettings,
          autoArmed,
          analytics?.startingVirtualBalance
        );
      }
      setRiskStatus(res.status);
      if (settings.emergencyStop) {
        setAutoBrokerExecution(false);
      }
    },
    [aiSettings, analytics?.startingVirtualBalance, authHeaders, autoArmed, mode, profile]
  );

  async function executeEmergencyStop(engaged: boolean) {
    setBusy(true);
    try {
      await apiRequest('/api/risk/emergency-stop', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ engaged }),
      });
      if (engaged) {
        setAutoBrokerExecution(false);
      }
      if (profile && isSupabaseConfigured && aiSettings && riskStatus) {
        void syncSupabaseSettings(
          profile.id,
          mode,
          { ...riskStatus.limits, emergencyStop: engaged },
          aiSettings,
          engaged ? false : autoArmed,
          analytics?.startingVirtualBalance
        ).catch(() => undefined);
      }
      pushToast(
        engaged ? 'error' : 'success',
        engaged ? 'Emergency Stop Engaged' : 'Emergency Stop Cleared',
        engaged ? 'All automatic paper and broker demo execution has been halted.' : 'Risk guard restored to normal checks.'
      );
      await refreshPlatformState();
    } finally {
      setBusy(false);
    }
  }

  async function executeResetDailyRisk() {
    setBusy(true);
    try {
      await apiRequest('/api/risk/reset-daily', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      pushToast('info', 'Daily Counters Reset', 'Simulated daily loss, profit, trade count, and loss streak cleared.');
      await refreshPlatformState();
    } finally {
      setBusy(false);
    }
  }

  /** Silent auto-save handler for AI & scheduler settings (throws on error for retry UI) */
  const handleSaveAiSettings = useCallback(
    async (settings: AiSettings) => {
      const res = await apiRequest<{ settings: AiSettings }>('/api/ai/settings', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(settings),
      });
      if (profile && isSupabaseConfigured && riskStatus) {
        await syncSupabaseSettings(
          profile.id,
          mode,
          riskStatus.limits,
          settings,
          autoArmed,
          analytics?.startingVirtualBalance
        );
      }
      setAiSettings(res.settings);
    },
    [analytics?.startingVirtualBalance, authHeaders, autoArmed, mode, profile, riskStatus]
  );

  async function handleSaveBrokerAccount(input: {
    accountId?: string;
    brokerId: BrokerId;
    label: string;
    externalAccountId?: string | null;
    credentials: Record<string, string>;
  }): Promise<ManagedBrokerAccountPublic> {
    setBusy(true);
    try {
      const res = await apiRequest<{ account?: ManagedBrokerAccountPublic; error?: string; message?: string }>('/api/brokers/accounts', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ ...input, environment: 'demo' }),
      });
      const account = res?.account;
      if (!account || typeof account !== 'object' || !account.id) {
        throw new Error(
          sanitizeErrorMessage(res?.error ?? res?.message, 'Unable to save broker account: invalid server response.')
        );
      }
      pushToast('success', 'Broker Account Saved', `${account.label || input.label || 'Broker Account'} saved securely (demo-only).`);
      await refreshPlatformState();
      return account;
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteBrokerAccount(accountId: string) {
    setBusy(true);
    try {
      await apiRequest(`/api/brokers/accounts/${accountId}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      pushToast('info', 'Broker Account Removed', 'Account credentials purged from server vault.');
      await refreshPlatformState();
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectActiveBrokerAccount(accountId: string | null) {
    setBusy(true);
    try {
      await apiRequest('/api/brokers/active', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ accountId }),
      });
      setActiveBrokerAccountId(accountId);
      pushToast(
        'info',
        'Execution Target Updated',
        accountId ? 'Routed manual/sandbox orders to selected demo broker account.' : 'Switched back to NovaTrade Paper Simulator.'
      );
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Target Switch Failed', err instanceof Error ? err.message : 'Unable to switch target.');
    } finally {
      setBusy(false);
    }
  }

  async function handleConnectBrokerAccount(accountId: string) {
    if (!accountId) {
      const msg = 'Missing broker account identifier.';
      pushToast('error', 'Broker Connection Failed', msg);
      throw new Error(msg);
    }
    setBusy(true);
    try {
      const res = await apiRequest<{
        account?: ManagedBrokerAccountPublic;
        connected?: boolean;
        status?: string;
        lastError?: string | null;
        error?: string;
        message?: string;
      }>(`/api/brokers/accounts/${accountId}/connect`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      const account = res?.account;
      if (!account || typeof account !== 'object') {
        throw new Error(
          sanitizeErrorMessage(
            res?.error ?? res?.message,
            'MT5 gateway is offline / not configured. Your account has not been connected.'
          )
        );
      }
      if (account.connected !== true) {
        throw new Error(
          sanitizeErrorMessage(
            account.lastError,
            'MT5 gateway is offline / not configured. Your account has not been connected.'
          )
        );
      }
      pushToast('success', 'Broker Demo Connected', `${account.label || 'Broker Account'} · ${account.accountType || 'DEMO'}`);
      await refreshPlatformState();
    } catch (err) {
      const msg = sanitizeErrorMessage(err, 'MT5 gateway is offline / not configured. Your account has not been connected.');
      pushToast('error', 'Broker Connection Failed', msg);
      await refreshPlatformState();
      throw new Error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnectBrokerAccount(accountId: string) {
    setBusy(true);
    try {
      const res = await apiRequest<{ account?: ManagedBrokerAccountPublic; error?: string }>(
        `/api/brokers/accounts/${accountId}/disconnect`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({}),
        }
      );
      pushToast('info', 'Broker Disconnected', `${res?.account?.label || 'Broker account'} disconnected.`);
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Broker Disconnect Failed', sanitizeErrorMessage(err, 'Unable to disconnect.'));
      await refreshPlatformState();
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncBrokerAccount(accountId: string) {
    setBusy(true);
    try {
      const res = await apiRequest<{ account?: ManagedBrokerAccountPublic; error?: string; message?: string }>(
        `/api/brokers/accounts/${accountId}/sync`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({}),
        }
      );
      const account = res?.account;
      if (!account || typeof account !== 'object') {
        throw new Error(
          sanitizeErrorMessage(res?.error ?? res?.message, 'Broker health check did not return a valid account payload.')
        );
      }
      pushToast(
        account.connected === true ? 'success' : 'info',
        'Health & Balance Synced',
        `${account.label || 'Broker Account'}: ${account.status}${account.balance != null ? ` · ${account.balance.toFixed(2)} ${account.currency || 'USD'}` : ''}`
      );
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Health & Balance Sync Failed', sanitizeErrorMessage(err, 'Unable to sync broker account.'));
      await refreshPlatformState();
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateBrokerAccountRisk(accountId: string, limits: BrokerAccountRiskLimits) {
    setBusy(true);
    try {
      await apiRequest(`/api/brokers/accounts/${accountId}/risk`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(limits),
      });
      pushToast('success', 'Account Risk Limits Updated', 'Per-account risk limits saved on server.');
      await refreshPlatformState();
    } finally {
      setBusy(false);
    }
  }

  async function handleCheckBrokerCompatibility(
    accountId: string,
    symbol: string,
    orderType: BrokerOrderType
  ): Promise<InstrumentCompatibilityResult> {
    return apiRequest<InstrumentCompatibilityResult>(`/api/brokers/accounts/${accountId}/compatibility`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ symbol, orderType }),
    });
  }

  async function handleSyncBrokerHistory(accountId: string) {
    return apiRequest<{ supported: boolean; trades: Array<Record<string, unknown>>; note: string }>(
      `/api/brokers/accounts/${accountId}/history`,
      { headers: authHeaders }
    );
  }

  async function handleReconcileBrokerOrders(accountId?: string) {
    setBusy(true);
    try {
      const res = await apiRequest<{ updatedCount: number; orders: BrokerOrderRecord[] }>('/api/brokers/orders/reconcile', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(accountId ? { accountId } : {}),
      });
      pushToast('info', 'Orders Reconciled', `Checked broker statuses (${res.updatedCount} updated).`);
      await refreshPlatformState();
      return res;
    } finally {
      setBusy(false);
    }
  }

  async function handlePairAndroidDevice(input: {
    deviceName: string;
    allowMt5: boolean;
    allowIqOption: boolean;
  }) {
    setBusy(true);
    try {
      const res = await apiRequest<{
        device: AndroidDevicePublic;
        pairingCode: string;
        expiresAt: string;
      }>('/api/android/devices/pair', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(input),
      });
      pushToast('info', 'Android Pairing Code Ready', `Code ${res.pairingCode} generated for ${res.device.deviceName}.`);
      await refreshPlatformState();
      return res;
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateAndroidPermissions(
    deviceId: string,
    patch: { status?: 'ACTIVE' | 'PAUSED'; allowMt5?: boolean; allowIqOption?: boolean }
  ) {
    setBusy(true);
    try {
      await apiRequest(`/api/android/devices/${deviceId}/permissions`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(patch),
      });
      pushToast('info', 'Android Device Updated', 'Bridge permissions saved.');
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Device Update Failed', sanitizeErrorMessage(err, 'Unable to update Android device.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRevokeAndroidDevice(deviceId: string) {
    setBusy(true);
    try {
      await apiRequest(`/api/android/devices/${deviceId}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      pushToast('info', 'Android Device Revoked', 'Device token and pending mobile actions revoked.');
      await refreshPlatformState();
    } finally {
      setBusy(false);
    }
  }

  async function handleAnalyzeAndroidScreenshot(input: {
    imageBase64: string;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    appPackageHint?: string | null;
    notes?: string;
    deviceId?: string;
    createAssistedProposal?: boolean;
  }) {
    setBusy(true);
    try {
      const res = await apiRequest<{
        analysis: AndroidScreenAnalysisRecord;
        signal: SignalRecord;
      }>('/api/android/screen/analyze', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(input),
      });
      setCurrentAnalysis(res.signal);
      pushToast(
        res.analysis.recommendedAction === 'WAIT' ? 'info' : 'success',
        `${res.analysis.appName} Screen Analyzed`,
        `${res.analysis.normalizedSymbol || res.analysis.detectedSymbol || 'Symbol'} · ${res.analysis.recommendedAction} (${res.analysis.confidenceScore}/100)`
      );
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Screen Analysis Failed', sanitizeErrorMessage(err, 'Unable to analyze screenshot.'));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function handleApproveAndroidAction(actionId: string) {
    setBusy(true);
    try {
      const res = await apiRequest<{ notice: string }>(`/api/android/actions/${actionId}/approve`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      pushToast('success', 'Android Action Approved', res.notice);
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Approval Blocked', sanitizeErrorMessage(err, 'Unable to approve mobile action.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRejectAndroidAction(actionId: string) {
    setBusy(true);
    try {
      await apiRequest(`/api/android/actions/${actionId}/reject`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      pushToast('info', 'Android Action Rejected', 'Queued mobile proposal rejected.');
      await refreshPlatformState();
    } finally {
      setBusy(false);
    }
  }

  async function handleExecuteBrokerDemoOrder(
    accountId: string,
    symbol: string,
    direction: 'CALL' | 'PUT',
    amount: number,
    orderType: BrokerOrderType
  ) {
    setBusy(true);
    try {
      const res = await apiRequest<{ order: BrokerOrderRecord; duplicatePrevented?: boolean }>('/api/brokers/orders', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          accountId,
          environment: 'demo',
          symbol,
          direction,
          orderType,
          amount,
          entryPrice: symbol === selectedSymbol ? candleFeed?.currentPrice ?? null : null,
          expirySeconds: aiSettings?.expirySeconds ?? 180,
          idempotencyKey: `${accountId}-${symbol}-${direction}-${Math.floor(Date.now() / 5000)}`,
          source: 'manual',
        }),
      });
      pushToast(
        res.duplicatePrevented ? 'warning' : 'success',
        res.duplicatePrevented ? 'Duplicate Order Prevented' : `Demo ${direction} Sent`,
        `${res.order.brokerName}: ${res.order.mappedSymbol} (${res.order.status})`
      );
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Broker Demo Order Blocked', err instanceof Error ? err.message : 'Order validation failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleAutoBrokerExecution(enabled: boolean) {
    setBusy(true);
    try {
      const res = await apiRequest<{ enabled: boolean; activeAccountId: string | null; reason: string }>('/api/brokers/auto-execution', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ enabled }),
      });
      setAutoBrokerExecution(res.enabled);
      pushToast(
        res.enabled ? 'info' : 'warning',
        res.enabled ? 'Auto MT5 Demo Routing Armed' : 'Auto MT5 Demo Routing Disarmed',
        res.reason
      );
      await refreshPlatformState();
    } catch (err) {
      pushToast('error', 'Auto Routing Toggle Failed', err instanceof Error ? err.message : 'Unable to update auto broker execution.');
    } finally {
      setBusy(false);
    }
  }

  async function handleValidateBrokerOrder(
    accountId: string,
    symbol: string,
    direction: 'CALL' | 'PUT',
    amount: number,
    orderType: BrokerOrderType
  ): Promise<BrokerOrderValidationResult> {
    const res = await apiRequest<{ validation: BrokerOrderValidationResult }>('/api/brokers/orders/validate', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        accountId,
        environment: 'demo',
        symbol,
        direction,
        orderType,
        amount,
      }),
    });
    return res.validation;
  }

  async function handleFetchBrokerQuote(accountId: string, symbol: string): Promise<BrokerQuote> {
    const res = await apiRequest<{ quote: BrokerQuote }>(`/api/brokers/accounts/${accountId}/quote?symbol=${encodeURIComponent(symbol)}`, {
      headers: authHeaders,
    });
    return res.quote;
  }

  async function handleFetchBrokerCandles(
    accountId: string,
    symbol: string,
    intervalSeconds = 60,
    count = 50
  ): Promise<{ candles: Candle[]; source: string; note?: string }> {
    return apiRequest<{ candles: Candle[]; source: string; note?: string }>(
      `/api/brokers/accounts/${accountId}/candles?symbol=${encodeURIComponent(symbol)}&interval=${intervalSeconds}&count=${count}`,
      { headers: authHeaders }
    );
  }

  async function handleFetchBrokerPositions(
    accountId: string
  ): Promise<{ supported: boolean; positions: BrokerPosition[]; source: string; note?: string }> {
    return apiRequest<{ supported: boolean; positions: BrokerPosition[]; source: string; note?: string }>(
      `/api/brokers/accounts/${accountId}/positions`,
      { headers: authHeaders }
    );
  }

  async function handleFetchBrokerAssets(
    accountId: string
  ): Promise<{ assets: BrokerAssetInfo[]; count: number; source: string }> {
    return apiRequest<{ assets: BrokerAssetInfo[]; count: number; source: string }>(
      `/api/brokers/accounts/${accountId}/assets`,
      { headers: authHeaders }
    );
  }

  async function handleSignOut() {
    if (isSupabaseConfigured) {
      await signOutSupabase();
    } else {
      localStorage.removeItem(LOCAL_PROFILE_KEY);
    }
    setProfileMenuOpen(false);
    setProfile(null);
  }

  if (inAuthCallback) {
    return (
      <AuthCallbackView
        onComplete={async (session) => {
          if (session?.user) {
            setSupabaseAccessToken(session.access_token);
            const p = await loadSupabaseProfile(session.user.id, session.user.email || '');
            setProfile(p);
          }
          setInAuthCallback(false);
        }}
      />
    );
  }

  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] dark:bg-[#060A13] flex items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        Initializing NovaTrade AI workspace...
      </div>
    );
  }

  if (!profile) {
    return (
      <AuthGateView
        themePreference={themePreference}
        systemPrefersDark={systemPrefersDark}
        onChangeTheme={setThemePreference}
        onAuthenticatedLocal={(email, displayName) => {
          const local: UserProfile = {
            id: 'local-research-session',
            email,
            displayName,
            role: 'trader',
            preferredCurrency: 'USD',
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            authMode: 'local-preview',
          };
          localStorage.setItem(LOCAL_PROFILE_KEY, JSON.stringify(local));
          setProfile(local);
        }}
      />
    );
  }

  const pendingProposals = proposals.filter((p) => p.status === 'PENDING_APPROVAL');
  const activeNavTitle = NAV_ITEMS.find((n) => n.id === activeNav)?.label || 'Overview';
  const unreadCount = Math.max(0, activity.length - lastSeenActivityCount);
  const actionableSignalsCount = signals.filter((s) => s.direction === 'CALL' || s.direction === 'PUT').length;
  const parsedManualStake = Math.max(1, Number(manualStakeDraft) || 1);
  const avatarInitials = (profile.displayName || profile.email || 'NT')
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || '')
    .join('');

  const ThemeIcon = themePreference === 'system' ? Monitor : themePreference === 'dark' ? Moon : Sun;
  const headerThemeAccent =
    themePreference === 'light'
      ? 'border-amber-300 dark:border-amber-400/50 bg-white dark:bg-white/10 text-slate-800 dark:text-amber-100'
      : themePreference === 'dark'
        ? 'border-indigo-500/60 bg-[#070C1A] text-white'
        : 'border-yellow-500/70 dark:border-yellow-400/60 bg-amber-50/90 dark:bg-[#191507] text-amber-950 dark:text-amber-100';
  const headerThemeIconColor =
    themePreference === 'light'
      ? 'text-amber-500'
      : themePreference === 'dark'
        ? 'text-indigo-400'
        : 'text-yellow-600 dark:text-yellow-400';

  return (
    <div className="min-h-screen bg-[#F8FAFC] dark:bg-[#060A13] text-slate-900 dark:text-slate-100 flex overflow-x-hidden relative transition-colors">
      {/* Subtle Ambient Background Gradient */}
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(37,99,235,0.05),transparent_50%)] dark:bg-[radial-gradient(ellipse_at_top_right,rgba(79,70,229,0.12),transparent_48%),radial-gradient(ellipse_at_bottom_left,rgba(37,99,235,0.08),transparent_48%)]" />

      {/* Desktop Sidebar Navigation */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col border-r border-slate-200/90 dark:border-slate-800/90 bg-white dark:bg-[#090F1D] shrink-0 relative z-20">
        <div className="h-16 px-5 flex items-center border-b border-slate-200/80 dark:border-slate-800/80">
          <NovaLogo />
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          {NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="px-3 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                {group.title}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = activeNav === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActiveNav(item.id)}
                      className={`w-full min-h-10 flex items-center gap-3 rounded-xl px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                        active
                          ? 'bg-blue-50 text-blue-700 dark:bg-indigo-500/15 dark:text-indigo-300 font-semibold'
                          : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-blue-600 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'}`} />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="p-4 border-t border-slate-200/80 dark:border-slate-800/80 text-[11px] text-slate-500 dark:text-slate-400 space-y-1.5">
          <div className="flex items-center justify-between">
            <span>Execution</span>
            <span className="font-medium text-slate-700 dark:text-slate-200">Paper Only</span>
          </div>
          <div className="flex items-center justify-between">
            <span>AI Loop</span>
            <span className={`font-semibold ${autoArmed ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-600 dark:text-slate-300'}`}>
              {autoArmed ? 'Armed' : 'Standby'}
            </span>
          </div>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm" onClick={() => setMobileMenuOpen(false)} />
          <aside className="relative w-72 max-w-[84vw] bg-white dark:bg-[#090F1D] border-r border-slate-200 dark:border-slate-800 flex flex-col z-10">
            <div className="flex items-center justify-between px-4 h-14 border-b border-slate-200 dark:border-slate-800">
              <NovaLogo />
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="min-h-11 min-w-11 flex items-center justify-center rounded-xl text-slate-500 hover:text-slate-900 dark:hover:text-white"
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3 space-y-4">
              {NAV_GROUPS.map((group) => (
                <div key={group.title}>
                  <p className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                    {group.title}
                  </p>
                  <div className="space-y-0.5">
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      const active = activeNav === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            setActiveNav(item.id);
                            setMobileMenuOpen(false);
                          }}
                          className={`w-full min-h-11 flex items-center gap-3 rounded-xl px-3 py-2 text-xs font-medium whitespace-nowrap ${
                            active
                              ? 'bg-blue-50 text-blue-700 dark:bg-indigo-500/15 dark:text-indigo-300 font-semibold'
                              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                          }`}
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          <span>{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
            <div className="p-3 border-t border-slate-200 dark:border-slate-800">
              <ThemeSwitcher compact value={themePreference} systemPrefersDark={systemPrefersDark} onChange={setThemePreference} />
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 relative z-10">
        {/* Compact Top Header (<= 7% mobile height) */}
        <header className="sticky top-0 z-30 h-14 sm:h-16 border-b border-slate-200/90 dark:border-slate-800/90 bg-white/90 dark:bg-[#090F1D]/90 backdrop-blur-xl px-3 sm:px-6 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden min-h-11 min-w-11 flex items-center justify-center rounded-xl border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex items-center gap-2 text-sm">
              <span className="hidden sm:inline text-slate-400 dark:text-slate-500 font-medium">Workspace</span>
              <span className="hidden sm:inline text-slate-300 dark:text-slate-700">/</span>
              <h1 className="text-sm sm:text-base font-semibold text-slate-900 dark:text-white truncate">
                {activeNavTitle}
              </h1>
            </div>
          </div>

          <div className="hidden xl:flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
            <span>Mode: <strong className="text-slate-700 dark:text-slate-200">{mode.toUpperCase()}</strong></span>
            <span className="text-slate-300 dark:text-slate-700">·</span>
            <span>
              {activeBrokerAccountId
                ? `Target: ${brokerAccounts.find((a) => a?.id === activeBrokerAccountId)?.label || 'Demo Broker'}`
                : `Brokers Connected: ${brokerAccounts.filter((a) => Boolean(a?.connected)).length || (brokerStatus?.connected ? 1 : 0)}`}
            </span>
            <span className="text-slate-300 dark:text-slate-700">·</span>
            <span className={riskStatus?.allowed ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-red-600 dark:text-red-400 font-medium'}>
              Risk: {riskStatus?.allowed ? 'Clear' : 'Paused'}
            </span>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {/* Theme Switcher Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setThemeMenuOpen((v) => !v);
                  setNotifOpen(false);
                  setProfileMenuOpen(false);
                }}
                className={`min-h-10 min-w-10 sm:px-2.5 inline-flex items-center justify-center gap-1.5 rounded-xl border transition-colors ${headerThemeAccent}`}
                aria-label="Theme preference"
                title="Switch Light / Dark / System theme"
              >
                <ThemeIcon className={`h-4 w-4 ${headerThemeIconColor}`} />
                <span className="hidden md:inline text-xs font-semibold capitalize">{themePreference}</span>
              </button>

              {themeMenuOpen && (
                <div className="absolute right-0 mt-2 w-64 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1322] p-2 shadow-2xl z-50 text-xs space-y-1">
                  <p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                    Appearance
                  </p>
                  {(
                    [
                      {
                        id: 'light',
                        label: 'Light Mode',
                        sub: 'White appearance',
                        icon: Sun,
                        activeClass: 'bg-white text-slate-900 border-amber-400 ring-1 ring-amber-400/45 shadow-sm',
                        iconBoxClass: 'bg-white border-amber-300 text-amber-500',
                        checkClass: 'text-amber-500',
                      },
                      {
                        id: 'dark',
                        label: 'Dark Mode',
                        sub: 'Deep navy & obsidian',
                        icon: Moon,
                        activeClass: 'bg-[#060B18] text-white border-indigo-500 ring-1 ring-indigo-500/55 shadow-sm',
                        iconBoxClass: 'bg-[#050914] border-indigo-500/60 text-indigo-400',
                        checkClass: 'text-indigo-400',
                      },
                      {
                        id: 'system',
                        label: 'System Default',
                        sub: `Follows device (${systemPrefersDark ? 'Dark' : 'Light'})`,
                        icon: Monitor,
                        activeClass:
                          'bg-amber-50 text-amber-950 dark:bg-[#191507] dark:text-amber-50 border-yellow-500 dark:border-yellow-400 ring-1 ring-yellow-500/45 dark:ring-yellow-400/45 shadow-sm',
                        iconBoxClass:
                          'bg-gradient-to-br from-white via-amber-50 to-[#060B18] border-yellow-500/60 text-yellow-600 dark:text-yellow-400',
                        checkClass: 'text-yellow-600 dark:text-yellow-400',
                      },
                    ] as const
                  ).map((opt) => {
                    const Icon = opt.icon;
                    const active = themePreference === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          setThemePreference(opt.id);
                          setThemeMenuOpen(false);
                        }}
                        className={`w-full min-h-11 flex items-center justify-between gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-all ${
                          active
                            ? `${opt.activeClass} font-semibold`
                            : 'border-transparent text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                        }`}
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${opt.iconBoxClass}`}>
                            <Icon className="h-3.5 w-3.5" />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate">{opt.label}</span>
                            <span className={`block text-[10px] font-normal truncate ${active && opt.id === 'dark' ? 'text-slate-300' : 'text-slate-500 dark:text-slate-400'}`}>
                              {opt.sub}
                            </span>
                          </span>
                        </span>
                        {active && <Check className={`h-4 w-4 shrink-0 ${opt.checkClass}`} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Notification Center */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setNotifOpen((v) => !v);
                  setProfileMenuOpen(false);
                  setThemeMenuOpen(false);
                  setLastSeenActivityCount(activity.length);
                }}
                className="min-h-10 min-w-10 flex items-center justify-center rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0C1322] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 relative transition-colors"
                aria-label="Notifications"
              >
                <Bell className="h-4 w-4" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 h-4 min-w-4 rounded-full bg-blue-600 px-1 text-[10px] font-semibold text-white flex items-center justify-center">
                    {Math.min(9, unreadCount)}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 mt-2 w-80 max-w-[88vw] rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1322] p-4 shadow-2xl z-50">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-slate-900 dark:text-white">Notification Center</span>
                    <button
                      type="button"
                      onClick={() => setNotifOpen(false)}
                      className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white"
                    >
                      Close
                    </button>
                  </div>
                  <div className="max-h-64 overflow-y-auto divide-y divide-slate-200/80 dark:divide-slate-800 text-xs">
                    {activity.length === 0 ? (
                      <p className="py-4 text-center text-slate-500">No recent events.</p>
                    ) : (
                      activity.slice(0, 10).map((ev) => (
                        <div key={ev.id} className="py-2.5">
                          <div className="flex items-center justify-between text-[11px] text-slate-500">
                            <span className="font-medium text-blue-600 dark:text-indigo-300">{ev.eventType}</span>
                            <span className="font-mono">{new Date(ev.createdAt).toLocaleTimeString()}</span>
                          </div>
                          <p className="mt-0.5 text-slate-700 dark:text-slate-300">{ev.summary}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* User Profile Menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setProfileMenuOpen((v) => !v);
                  setNotifOpen(false);
                  setThemeMenuOpen(false);
                }}
                className="min-h-10 inline-flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0C1322] px-2 sm:px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-600/15 dark:bg-indigo-500/20 text-[10px] font-bold text-blue-700 dark:text-indigo-300">
                  {avatarInitials || 'NT'}
                </span>
                <span className="hidden sm:inline max-w-[110px] truncate">{profile.displayName}</span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>

              {profileMenuOpen && (
                <div className="absolute right-0 mt-2 w-64 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1322] p-2.5 shadow-2xl z-50 text-xs space-y-2">
                  <div className="px-2.5 py-2 border-b border-slate-200/80 dark:border-slate-800">
                    <p className="font-semibold text-slate-900 dark:text-white truncate">{profile.displayName}</p>
                    <p className="text-[11px] text-slate-500 truncate">{profile.email}</p>
                  </div>
                  <div className="px-1">
                    <p className="px-1.5 pb-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">Theme</p>
                    <ThemeSwitcher compact value={themePreference} systemPrefersDark={systemPrefersDark} onChange={setThemePreference} />
                  </div>
                  <div className="pt-1 border-t border-slate-200/80 dark:border-slate-800 space-y-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveNav('settings');
                        setProfileMenuOpen(false);
                      }}
                      className="w-full min-h-10 flex items-center gap-2 rounded-xl px-3 py-2 text-left text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <Sliders className="h-3.5 w-3.5" /> Settings &amp; Profile
                    </button>
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="w-full min-h-10 flex items-center gap-2 rounded-xl px-3 py-2 text-left text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                    >
                      <LogOut className="h-3.5 w-3.5" /> Sign Out
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Emergency Stop CTA */}
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmState({ type: 'emergency-stop', payload: !riskStatus?.emergencyStop })}
              className={`min-h-10 rounded-xl px-3 py-2 text-xs font-semibold whitespace-nowrap transition-colors ${
                riskStatus?.emergencyStop
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                  : 'bg-red-600 hover:bg-red-500 text-white'
              }`}
            >
              {riskStatus?.emergencyStop ? 'Resume Guard' : 'Emergency Stop'}
            </button>
          </div>
        </header>

        {/* Main Viewport */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 pb-24 lg:pb-8 space-y-6 max-w-[1380px] w-full mx-auto">
          {!isSupabaseConfigured && (
            <div className="rounded-2xl border border-amber-300 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-900 dark:text-amber-200">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <span>
                  Cloud sync unavailable (<code className="font-mono">VITE_SUPABASE_URL</code> /{' '}
                  <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> pending). Running in local research mode.
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveNav('settings')}
                className="text-amber-800 dark:text-amber-300 underline hover:opacity-80 whitespace-nowrap"
              >
                Account &amp; Settings
              </button>
            </div>
          )}

          {/* OVERVIEW */}
          {activeNav === 'overview' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
                    NovaTrade Command Overview
                  </h2>
                  <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
                    Live quantitative market intelligence, paper simulation portfolio, and server-side risk controls.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveNav('scanner')}
                    className="min-h-11 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] hover:bg-slate-50 dark:hover:bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap transition-colors"
                  >
                    Open AI Scanner
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveNav('live-markets')}
                    className="min-h-11 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shadow-sm shadow-blue-600/20 transition-colors"
                  >
                    Open Live Markets
                  </button>
                </div>
              </div>

              {/* 6 Summary KPI Cards */}
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
                <div className={`${CARD_SURFACE} p-4`}>
                  <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span>Account Balance</span>
                    <Wallet className="h-3.5 w-3.5 text-slate-400" />
                  </div>
                  <p className="mt-2 text-xl sm:text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
                    ${(analytics?.currentVirtualBalance ?? 10000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">Paper virtual equity</p>
                </div>

                <div className={`${CARD_SURFACE} p-4`}>
                  <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span>Today&apos;s P&amp;L</span>
                    <TrendingUp className="h-3.5 w-3.5 text-slate-400" />
                  </div>
                  <p
                    className={`mt-2 text-xl sm:text-2xl font-semibold font-mono tabular-nums ${
                      (analytics?.todayPnl ?? 0) >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {(analytics?.todayPnl ?? 0) >= 0 ? '+' : ''}
                    ${(analytics?.todayPnl ?? 0).toFixed(2)}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">{analytics?.todayTrades ?? 0} settled today</p>
                </div>

                <div className={`${CARD_SURFACE} p-4`}>
                  <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span>Total Trades</span>
                    <Activity className="h-3.5 w-3.5 text-slate-400" />
                  </div>
                  <p className="mt-2 text-xl sm:text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
                    {analytics?.totalTrades ?? 0}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">{activeTrades.length} active open</p>
                </div>

                <div className={`${CARD_SURFACE} p-4`}>
                  <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span>Win Rate</span>
                    <Target className="h-3.5 w-3.5 text-slate-400" />
                  </div>
                  <p className="mt-2 text-xl sm:text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
                    {analytics?.winRatePct != null ? `${analytics.winRatePct}%` : '—'}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {analytics?.wins ?? 0}W / {analytics?.losses ?? 0}L settled
                  </p>
                </div>

                <div className={`${CARD_SURFACE} p-4`}>
                  <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span>Active Signals</span>
                    <Radar className="h-3.5 w-3.5 text-slate-400" />
                  </div>
                  <p className="mt-2 text-xl sm:text-2xl font-semibold font-mono tabular-nums text-blue-600 dark:text-indigo-400">
                    {actionableSignalsCount}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">{signals.length} total scanned</p>
                </div>

                <div className={`${CARD_SURFACE} p-4`}>
                  <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span>AI Status</span>
                    <Bot className="h-3.5 w-3.5 text-slate-400" />
                  </div>
                  <p
                    className={`mt-2 text-xl sm:text-2xl font-semibold ${
                      !riskStatus?.allowed
                        ? 'text-red-600 dark:text-red-400'
                        : autoArmed
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-blue-600 dark:text-indigo-400'
                    }`}
                  >
                    {!riskStatus?.allowed ? 'Risk Halted' : autoArmed ? 'Autonomous' : mode.toUpperCase()}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500 truncate">
                    {health?.scheduler.lastCycleSummary || `Interval ${aiSettings?.scanIntervalSeconds ?? 60}s`}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className={`lg:col-span-2 ${CARD_SURFACE} p-5`}>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Paper Equity Performance</h3>
                    <button
                      type="button"
                      onClick={() => setActiveNav('analytics')}
                      className="text-xs font-medium text-blue-600 dark:text-indigo-400 hover:underline"
                    >
                      Daily / Weekly / Monthly Analytics
                    </button>
                  </div>
                  <EquityChart points={analytics?.equityCurve || []} />
                </div>

                <div className={`${CARD_SURFACE} p-5 flex flex-col justify-between`}>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Quick Automation Control</h3>
                    <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                      Server-side autonomous scheduler monitors {aiSettings?.enabledAssets.length ?? 6} enabled assets every{' '}
                      {aiSettings?.scanIntervalSeconds ?? 60}s and settles expired paper positions automatically.
                    </p>
                  </div>
                  <div className="space-y-2.5 mt-4">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmState({ type: 'arm-auto', payload: !autoArmed })}
                      className={`w-full min-h-11 rounded-xl py-2.5 px-4 text-xs font-semibold text-white transition-colors ${
                        autoArmed ? 'bg-amber-600 hover:bg-amber-500' : 'bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500'
                      }`}
                    >
                      {autoArmed ? 'Pause Automatic Mode' : 'Arm Automatic Mode'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={handleRunAutoCycleNow}
                      className="w-full min-h-11 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070C17] hover:bg-slate-50 dark:hover:bg-slate-800 py-2.5 px-4 text-xs font-medium text-slate-700 dark:text-slate-200 transition-colors"
                    >
                      Trigger Autonomous Cycle Now
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveNav('paper-trading')}
                      className="w-full min-h-11 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070C17] hover:bg-slate-50 dark:hover:bg-slate-800 py-2.5 px-4 text-xs font-medium text-slate-700 dark:text-slate-200 transition-colors"
                    >
                      Open Paper Trading Desk
                    </button>
                  </div>
                </div>
              </div>

              <div className={`${CARD_SURFACE} p-5`}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Latest Quantitative Signals</h3>
                  <button
                    type="button"
                    onClick={() => setActiveNav('signals')}
                    className="text-xs font-medium text-blue-600 dark:text-indigo-400 hover:underline"
                  >
                    View All ({signals.length})
                  </button>
                </div>
                {signals.length === 0 ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    No signals generated yet. Open Live Markets or AI Scanner to evaluate live candles.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-200/80 dark:divide-slate-800">
                    {signals.slice(0, 5).map((s) => (
                      <div key={s.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-3">
                          <span
                            className={`font-semibold ${
                              s.direction === 'CALL'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : s.direction === 'PUT'
                                  ? 'text-red-600 dark:text-red-400'
                                  : 'text-amber-600 dark:text-amber-400'
                            }`}
                          >
                            {s.direction}
                          </span>
                          <span className="font-semibold text-slate-900 dark:text-white">{s.symbol}</span>
                          <span className="text-slate-500 dark:text-slate-400">
                            {s.timeframe} · {s.provider}
                          </span>
                        </div>
                        <div className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                          Confidence {s.confidenceScore ?? s.score}/100 · {new Date(s.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* AI SCANNER */}
          {activeNav === 'scanner' && (
            <MarketScannerView
              assets={assets}
              rows={scannerRows}
              timeframe={selectedTimeframe}
              scanning={scanning}
              scanProgress={scanProgress}
              onTimeframeChange={setSelectedTimeframe}
              onRunScan={handleProgressiveScan}
              onSelectAsset={(sym) => {
                setSelectedSymbol(sym);
                setActiveNav('live-markets');
              }}
            />
          )}

          {/* LIVE MARKETS TERMINAL */}
          {activeNav === 'live-markets' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <select
                    value={selectedSymbol}
                    onChange={(e) => setSelectedSymbol(e.target.value)}
                    className={`${SELECT_CLASS} sm:w-auto font-semibold`}
                  >
                    {groupedAssets.FOREX.length > 0 && (
                      <optgroup label="Forex Pairs (FX Feed)">
                        {groupedAssets.FOREX.map((a) => (
                          <option key={a.symbol} value={a.symbol}>
                            {a.symbol} — {a.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {groupedAssets.CRYPTO.length > 0 && (
                      <optgroup label="Cryptocurrencies (Spot Crypto)">
                        {groupedAssets.CRYPTO.map((a) => (
                          <option key={a.symbol} value={a.symbol}>
                            {a.symbol} — {a.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {groupedAssets.COMMODITY.length > 0 && (
                      <optgroup label="Commodities (Futures Feed)">
                        {groupedAssets.COMMODITY.map((a) => (
                          <option key={a.symbol} value={a.symbol}>
                            {a.symbol} — {a.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>

                  <div className="flex rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-[#070C17] p-1">
                    {(['1m', '5m', '15m', '1h'] as Timeframe[]).map((tf) => (
                      <button
                        key={tf}
                        type="button"
                        onClick={() => setSelectedTimeframe(tf)}
                        className={`min-h-9 px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-all ${
                          selectedTimeframe === tf
                            ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm border border-slate-200/80 dark:border-slate-700'
                            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border border-transparent'
                        }`}
                      >
                        {tf}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={candleLoading}
                    onClick={() => loadCandles(selectedSymbol, selectedTimeframe)}
                    className="min-h-11 inline-flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] hover:bg-slate-50 dark:hover:bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap transition-colors"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${candleLoading ? 'animate-spin' : ''}`} /> Refresh
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleRunAnalysis}
                    className="min-h-11 inline-flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shadow-sm shadow-blue-600/20 transition-colors"
                  >
                    <Play className="h-3.5 w-3.5" /> {busy ? 'Analysing...' : 'Run Quantitative Analysis'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                <div className="xl:col-span-2 space-y-6">
                  <div className={`${CARD_SURFACE} p-5`}>
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                      <div>
                        <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                          {selectedAssetMeta.name} · {selectedAssetMeta.instrumentType}
                        </h2>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Provider: {candleFeed?.provider || 'Checking...'} · Status:{' '}
                          <span
                            className={
                              candleFeed?.marketStatus === 'OPEN'
                                ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                                : 'text-amber-600 dark:text-amber-400 font-medium'
                            }
                          >
                            {candleFeed?.marketStatus || 'CONNECTING'}
                          </span>{' '}
                          · Updated {candleFeed?.fetchedAt ? new Date(candleFeed.fetchedAt).toLocaleTimeString() : '—'}
                        </p>
                      </div>
                      <div className="text-right font-mono tabular-nums">
                        <div className="text-xl font-semibold text-slate-900 dark:text-white">
                          {candleFeed?.currentPrice != null
                            ? candleFeed.currentPrice.toFixed(selectedAssetMeta.decimals)
                            : '—'}
                        </div>
                        {candleFeed?.priceChangePct != null && (
                          <div
                            className={`text-xs ${
                              candleFeed.priceChangePct >= 0
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-red-600 dark:text-red-400'
                            }`}
                          >
                            {candleFeed.priceChangePct >= 0 ? '+' : ''}
                            {candleFeed.priceChangePct.toFixed(3)}% window
                          </div>
                        )}
                      </div>
                    </div>

                    <CandlestickChart
                      symbol={selectedSymbol}
                      timeframe={selectedTimeframe}
                      candles={candleFeed?.candles || []}
                      overlays={candleFeed?.overlays}
                      indicators={currentAnalysis?.symbol === selectedSymbol ? currentAnalysis.indicators : null}
                      decimals={selectedAssetMeta.decimals}
                      loading={candleLoading}
                      error={candleError}
                    />
                  </div>

                  {/* Quantitative Breakdown */}
                  <div className={`${CARD_SURFACE} p-5 space-y-4`}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs text-slate-500 dark:text-slate-400">Quantitative Decision & Confidence Breakdown</p>
                        <div className="mt-1 flex items-center gap-3">
                          <span
                            className={`text-2xl font-bold ${
                              currentAnalysis?.direction === 'CALL'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : currentAnalysis?.direction === 'PUT'
                                  ? 'text-red-600 dark:text-red-400'
                                  : 'text-amber-600 dark:text-amber-400'
                            }`}
                          >
                            {currentAnalysis?.direction || 'WAIT'}
                          </span>
                          <div className="text-xs font-mono tabular-nums space-y-0.5">
                            <div>
                              <span className="text-slate-500">Actionable Conf:</span>{' '}
                              <strong className="text-slate-900 dark:text-white">
                                {currentAnalysis?.actionableConfidence ?? currentAnalysis?.confidenceScore ?? currentAnalysis?.score ?? 0}/100
                              </strong>
                            </div>
                            <div>
                              <span className="text-slate-500">Raw Directional:</span>{' '}
                              <span className="text-slate-600 dark:text-slate-400">
                                {currentAnalysis?.rawDirectionalConfidence ?? Math.max(currentAnalysis?.rawDirectionalConfidence ?? 0, currentAnalysis?.bullishScore || 0, currentAnalysis?.bearishScore || 0, currentAnalysis?.confidenceScore || 0, currentAnalysis?.score || 0)}/100
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="text-right text-xs text-slate-500 dark:text-slate-400 space-y-0.5">
                        <div>
                          Suggested Expiry:{' '}
                          <strong className="font-mono text-slate-900 dark:text-white">
                            {Math.round((currentAnalysis?.suggestedExpirySeconds || 180) / 60)}m
                          </strong>
                        </div>
                        <div>
                          Feed Updated:{' '}
                          <span className="font-mono text-slate-700 dark:text-slate-300">
                            {currentAnalysis?.feedLastUpdateAt ? new Date(currentAnalysis.feedLastUpdateAt).toLocaleTimeString() : '—'}
                          </span>
                        </div>
                        <div>
                          Risk:{' '}
                          <span className="font-semibold text-slate-800 dark:text-slate-200">
                            {currentAnalysis?.riskAssessment?.level || 'MODERATE'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Confidence State & Exact Reason banner */}
                    {(currentAnalysis?.actionableConfidence === 0 || currentAnalysis?.isStale) && (
                      <div className="rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 p-3 text-xs text-amber-800 dark:text-amber-300 space-y-1">
                        <div className="flex items-center gap-1.5 font-semibold">
                          <span>Confidence Locked to 0 (State: {currentAnalysis?.confidenceState || 'STALE_OR_UNAVAILABLE'})</span>
                        </div>
                        <p className="text-[11px] opacity-90">
                          <strong>Reason:</strong> {currentAnalysis?.zeroConfidenceReason || currentAnalysis?.reasons?.[0] || 'Market data unavailable or setup weak.'}
                        </p>
                        {currentAnalysis?.isStale && (
                          <p className="text-[10px] text-red-600 dark:text-red-400 font-medium">
                            Warning: Market feed is delayed or closed. Delayed prices are not represented as live executable prices.
                          </p>
                        )}
                      </div>
                    )}

                    {currentAnalysis?.indicators && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 border-t border-slate-200/80 dark:border-slate-800 pt-4 text-xs">
                        <div>
                          <span className="text-slate-500">Trend</span>
                          <p className="mt-0.5 font-medium text-slate-900 dark:text-white">{currentAnalysis.indicators.trend}</p>
                        </div>
                        <div>
                          <span className="text-slate-500">RSI (14)</span>
                          <p className="mt-0.5 font-mono tabular-nums text-slate-900 dark:text-white">{currentAnalysis.indicators.rsi14}</p>
                        </div>
                        <div>
                          <span className="text-slate-500">MACD Hist</span>
                          <p className="mt-0.5 font-mono tabular-nums text-slate-900 dark:text-white">
                            {currentAnalysis.indicators.macdHistogram.toFixed(6)}
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-500">Volatility</span>
                          <p className="mt-0.5 font-medium text-slate-900 dark:text-white">
                            {currentAnalysis.indicators.volatilityRegime} ({currentAnalysis.indicators.atrPct}%)
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-500">EMA 9 / 21 / 50</span>
                          <p className="mt-0.5 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                            {currentAnalysis.indicators.ema9.toFixed(4)} / {currentAnalysis.indicators.ema21.toFixed(4)}
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-500">Bollinger %B</span>
                          <p className="mt-0.5 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                            {currentAnalysis.indicators.bbPercentB} ({currentAnalysis.indicators.bbBandwidthPct}%)
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-500">Nearest Support</span>
                          <p className="mt-0.5 font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                            {currentAnalysis.indicators.nearestSupport.toFixed(selectedAssetMeta.decimals)}
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-500">Nearest Resistance</span>
                          <p className="mt-0.5 font-mono tabular-nums text-red-600 dark:text-red-400">
                            {currentAnalysis.indicators.nearestResistance.toFixed(selectedAssetMeta.decimals)}
                          </p>
                        </div>
                      </div>
                    )}

                    {currentAnalysis && (
                      <div className="border-t border-slate-200/80 dark:border-slate-800 pt-3 space-y-2">
                        <ul className="space-y-1 text-xs text-slate-700 dark:text-slate-300 list-disc pl-4">
                          {currentAnalysis.reasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                        {currentAnalysis.aiExplanation?.summary && (
                          <div className="rounded-xl border border-indigo-200 dark:border-indigo-500/25 bg-indigo-50/70 dark:bg-indigo-950/30 p-3 text-xs">
                            <p className="font-semibold text-indigo-700 dark:text-indigo-300">Gemini Analyst Commentary</p>
                            <p className="mt-1 text-slate-700 dark:text-slate-300 leading-relaxed">{currentAnalysis.aiExplanation.summary}</p>
                            {currentAnalysis.aiExplanation.riskNote && (
                              <p className="mt-1 text-slate-500 dark:text-slate-400">{currentAnalysis.aiExplanation.riskNote}</p>
                            )}
                          </div>
                        )}
                        <p className="text-[11px] text-slate-500">{currentAnalysis.warning}</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right Column: Modes & Quick Paper Ticket */}
                <div className="space-y-6">
                  <div className={`${CARD_SURFACE} p-5 space-y-4`}>
                    <div>
                      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Operating Mode</p>
                      <div className="mt-2 grid grid-cols-3 gap-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-[#070C17] p-1">
                        {(['signals', 'assisted', 'automatic'] as OperatingMode[]).map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => handleModeChange(m)}
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
                      <div className={`${SUBTLE_PANEL} p-3.5 text-xs text-slate-600 dark:text-slate-300 space-y-1.5`}>
                        <p className="font-semibold text-slate-900 dark:text-white">Mode A: Quantitative Signals</p>
                        <p className="leading-relaxed">
                          Evaluates multi-indicator confluence and higher-timeframe alignment to generate CALL, PUT, or WAIT signals.
                        </p>
                      </div>
                    )}

                    {mode === 'assisted' && (
                      <div className={`${SUBTLE_PANEL} p-3.5 text-xs space-y-3`}>
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-slate-900 dark:text-white">Mode B: Assisted Trading</span>
                          <span className="text-slate-500">Approval Required</span>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={handleCreateAssistedProposal}
                          className="w-full min-h-11 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 disabled:opacity-50 py-2 px-3 text-xs font-semibold text-white transition-colors"
                        >
                          Generate Assisted Proposal
                        </button>

                        {pendingProposals.map((prop) => (
                          <div key={prop.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1322] p-3 space-y-2">
                            <div className="flex items-center justify-between font-medium">
                              <span className={prop.direction === 'CALL' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                                {prop.direction} {prop.symbol} ({prop.timeframe})
                              </span>
                              <span className="font-mono tabular-nums text-slate-900 dark:text-white">${prop.recommendedAmount}</span>
                            </div>
                            <p className="text-[11px] text-slate-500">Confidence {prop.score}/100 · Entry {prop.entryPrice ?? '—'}</p>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => handleApproveProposal(prop.id)}
                                className="flex-1 min-h-10 inline-flex items-center justify-center gap-1 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => handleRejectProposal(prop.id)}
                                className="flex-1 min-h-10 inline-flex items-center justify-center gap-1 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300"
                              >
                                <XCircle className="h-3.5 w-3.5" /> Reject
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {mode === 'automatic' && (
                      <div className={`${SUBTLE_PANEL} p-3.5 text-xs space-y-3`}>
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                            <Bot className="h-4 w-4 text-blue-600 dark:text-indigo-400" /> Mode C: Autonomous Paper
                          </span>
                          <span className={autoArmed ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-amber-600 dark:text-amber-400 font-semibold'}>
                            {autoArmed ? 'ARMED' : 'PAUSED'}
                          </span>
                        </div>
                        <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                          Continuously scans enabled instruments on the server, opens validated paper trades, and auto-settles expiries.
                        </p>
                        {riskStatus?.autoPausedReason && (
                          <p className="text-red-600 dark:text-red-400">Paused: {riskStatus.autoPausedReason}</p>
                        )}
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirmState({ type: 'arm-auto', payload: !autoArmed })}
                            className={`flex-1 min-h-10 rounded-xl py-2 px-3 text-xs font-semibold text-white transition-colors ${
                              autoArmed ? 'bg-amber-600 hover:bg-amber-500' : 'bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500'
                            }`}
                          >
                            {autoArmed ? 'Pause Auto' : 'Arm Auto'}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={handleRunAutoCycleNow}
                            className="flex-1 min-h-10 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] py-2 px-3 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                          >
                            Run Cycle
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="border-t border-slate-200/80 dark:border-slate-800 pt-4 space-y-3">
                      <p className="text-xs font-medium text-slate-700 dark:text-slate-300">Paper Trade Ticket (Simulation Only)</p>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">
                          Stake Amount (Max ${riskStatus?.limits.maxTradeAmount ?? 100})
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={riskStatus?.limits.maxTradeAmount ?? 1000}
                          value={manualStakeDraft}
                          onChange={(e) => setManualStakeDraft(e.target.value)}
                          className={`${INPUT_CLASS} font-mono tabular-nums`}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          disabled={busy || !manualStakeDraft.trim() || parsedManualStake < 1}
                          onClick={() => handleOpenManualPaperTrade(selectedSymbol, 'CALL', parsedManualStake)}
                          className="min-h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 py-2.5 text-xs font-semibold text-white transition-colors"
                        >
                          Paper CALL
                        </button>
                        <button
                          type="button"
                          disabled={busy || !manualStakeDraft.trim() || parsedManualStake < 1}
                          onClick={() => handleOpenManualPaperTrade(selectedSymbol, 'PUT', parsedManualStake)}
                          className="min-h-11 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 py-2.5 text-xs font-semibold text-white transition-colors"
                        >
                          Paper PUT
                        </button>
                      </div>
                      <p className="text-[11px] text-slate-500">
                        Binary options contracts: {selectedAssetMeta.binaryOptionsOfferedByBroker ? 'Available via connected broker' : 'Disabled (no live broker feed)'}.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeNav === 'signals' && (
            <SignalsView
              signals={signals}
              onSelectSymbol={(sym) => {
                setSelectedSymbol(sym);
                setActiveNav('live-markets');
              }}
            />
          )}

          {activeNav === 'paper-trading' && (
            <PaperTradingDeskView
              analytics={analytics}
              assets={assets}
              trades={activeTrades}
              proposals={proposals}
              mode={mode}
              autoArmed={autoArmed}
              riskStatus={riskStatus}
              selectedSymbol={selectedSymbol}
              selectedTimeframe={selectedTimeframe}
              brokerAccounts={brokerAccounts}
              activeBrokerAccountId={activeBrokerAccountId}
              busy={busy}
              onSelectSymbol={setSelectedSymbol}
              onSelectBrokerTarget={handleSelectActiveBrokerAccount}
              onValidateBrokerOrder={handleValidateBrokerOrder}
              onExecuteBrokerDemoOrder={handleExecuteBrokerDemoOrder}
              onModeChange={handleModeChange}
              onUpdateStartingBalance={handleUpdateStartingBalance}
              onOpenManualTrade={handleOpenManualPaperTrade}
              onCreateAssistedProposal={handleCreateAssistedProposal}
              onApproveProposal={handleApproveProposal}
              onRejectProposal={handleRejectProposal}
              onRequestArmAuto={() => setConfirmState({ type: 'arm-auto', payload: !autoArmed })}
              onRunAutoCycle={handleRunAutoCycleNow}
              onSettle={handleSettleTrade}
              onCancel={handleCancelTrade}
            />
          )}

          {activeNav === 'history' && <TradeHistoryView trades={paperTrades} />}

          {activeNav === 'analytics' && <AnalyticsView analytics={analytics} assets={assets} riskStatus={riskStatus} />}

          {activeNav === 'risk' && (
            <RiskManagementView
              riskStatus={riskStatus}
              busy={busy}
              onSaveRisk={handleSaveRisk}
              onRequestEmergencyStop={(engaged) => setConfirmState({ type: 'emergency-stop', payload: engaged })}
              onRequestResetDaily={() => setConfirmState({ type: 'reset-daily' })}
            />
          )}

          {activeNav === 'novapay' && (
            <NovaPayView
              accounts={brokerAccounts}
              busy={busy}
              onRefresh={refreshPlatformState}
              onConnectAccount={handleConnectBrokerAccount}
              onSyncAccount={handleSyncBrokerAccount}
              onNavigateBrokers={() => setActiveNav('brokers')}
            />
          )}

          {activeNav === 'brokers' && (
            <BrokerConnectionsView
              broker={brokerStatus}
              catalog={brokerCatalog}
              accounts={brokerAccounts}
              activeAccountId={activeBrokerAccountId}
              autoBrokerExecution={autoBrokerExecution}
              emergencyStop={Boolean(riskStatus?.emergencyStop)}
              brokerOrders={brokerOrders}
              assets={assets}
              busy={busy}
              onRefresh={refreshPlatformState}
              onSaveAccount={handleSaveBrokerAccount}
              onDeleteAccount={handleDeleteBrokerAccount}
              onSelectActiveAccount={handleSelectActiveBrokerAccount}
              onToggleAutoBrokerExecution={handleToggleAutoBrokerExecution}
              onConnectAccount={handleConnectBrokerAccount}
              onDisconnectAccount={handleDisconnectBrokerAccount}
              onSyncAccount={handleSyncBrokerAccount}
              onUpdateAccountRisk={handleUpdateBrokerAccountRisk}
              onCheckCompatibility={handleCheckBrokerCompatibility}
              onValidateOrder={handleValidateBrokerOrder}
              onFetchQuote={handleFetchBrokerQuote}
              onFetchCandles={handleFetchBrokerCandles}
              onFetchPositions={handleFetchBrokerPositions}
              onFetchAssets={handleFetchBrokerAssets}
              onSyncHistory={handleSyncBrokerHistory}
              onReconcileOrders={handleReconcileBrokerOrders}
              onConnectIq={async () => {
                setBusy(true);
                try {
                  const r = await apiRequest<{ message: string }>('/api/broker/iq/connect', {
                    method: 'POST',
                    headers: authHeaders,
                    body: JSON.stringify({}),
                  });
                  pushToast('info', 'IQ Option Connector', r.message);
                  await refreshPlatformState();
                } catch (err) {
                  pushToast('error', 'IQ Option Connection Failed', err instanceof Error ? err.message : 'Unable to connect.');
                } finally {
                  setBusy(false);
                }
              }}
              onDisconnectIq={async () => {
                setBusy(true);
                try {
                  const r = await apiRequest<{ message: string }>('/api/broker/iq/disconnect', {
                    method: 'POST',
                    headers: authHeaders,
                    body: JSON.stringify({}),
                  });
                  pushToast('info', 'IQ Option Disconnected', r.message);
                  await refreshPlatformState();
                } finally {
                  setBusy(false);
                }
              }}
              onFetchIqAssets={async () => {
                const res = await apiRequest<{ assets: Array<{ symbol: string; category: string; open: boolean }> }>('/api/broker/iq/assets', {
                  headers: authHeaders,
                });
                return res.assets;
              }}
              onFetchIqHistory={async () => {
                return apiRequest<{ supported: boolean; trades: Array<Record<string, unknown>>; note: string }>('/api/broker/iq/history', {
                  headers: authHeaders,
                });
              }}
              androidDevices={androidDevices}
              androidAnalyses={androidAnalyses}
              androidActions={androidActions}
              onPairAndroidDevice={handlePairAndroidDevice}
              onUpdateAndroidPermissions={handleUpdateAndroidPermissions}
              onRevokeAndroidDevice={handleRevokeAndroidDevice}
              onAnalyzeAndroidScreenshot={handleAnalyzeAndroidScreenshot}
              onApproveAndroidAction={handleApproveAndroidAction}
              onRejectAndroidAction={handleRejectAndroidAction}
            />
          )}

          {activeNav === 'settings' && (
            <SettingsView
              aiSettings={aiSettings}
              assets={assets}
              profile={profile}
              activity={activity}
              themePreference={themePreference}
              systemPrefersDark={systemPrefersDark}
              onChangeTheme={setThemePreference}
              onSaveAiSettings={handleSaveAiSettings}
              onUpdateProfile={(p) => {
                setProfile(p);
                if (!isSupabaseConfigured) {
                  localStorage.setItem(LOCAL_PROFILE_KEY, JSON.stringify(p));
                }
              }}
              onSignOut={handleSignOut}
            />
          )}
        </main>
      </div>

      {/* Mobile Fixed Bottom Navigation Bar (h-16, <= 8% viewport height) */}
      <nav
        aria-label="Mobile primary navigation"
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 h-16 pb-safe border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#090F1D]/95 backdrop-blur-xl grid grid-cols-5"
      >
        {[
          { id: 'overview' as NavSection, label: 'Overview', icon: LayoutDashboard },
          { id: 'scanner' as NavSection, label: 'Scanner', icon: Radar },
          { id: 'live-markets' as NavSection, label: 'Markets', icon: CandleIcon },
          { id: 'paper-trading' as NavSection, label: 'Paper', icon: Wallet },
        ].map((tab) => {
          const Icon = tab.icon;
          const active = activeNav === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setActiveNav(tab.id);
                setMobileMoreOpen(false);
              }}
              className={`min-h-11 flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
                active ? 'text-blue-600 dark:text-indigo-400 font-semibold' : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setMobileMoreOpen((v) => !v)}
          className={`min-h-11 flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
            ['signals', 'history', 'analytics', 'risk', 'brokers', 'settings'].includes(activeNav) || mobileMoreOpen
              ? 'text-blue-600 dark:text-indigo-400 font-semibold'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          <MoreHorizontal className="h-4 w-4" />
          <span>More</span>
        </button>
      </nav>

      {/* Mobile More Bottom Sheet */}
      {mobileMoreOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex items-end pb-16">
          <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm" onClick={() => setMobileMoreOpen(false)} />
          <div className="relative z-10 w-full rounded-t-3xl border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1322] p-4 space-y-3 shadow-2xl">
            <div className="w-10 h-1 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto" />
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-semibold text-slate-900 dark:text-white">Terminal Modules</span>
              <button type="button" onClick={() => setMobileMoreOpen(false)} className="text-xs text-slate-500">
                Close
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {NAV_ITEMS.filter((n) => ['signals', 'history', 'analytics', 'risk', 'brokers', 'settings'].includes(n.id)).map((item) => {
                const Icon = item.icon;
                const active = activeNav === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveNav(item.id);
                      setMobileMoreOpen(false);
                    }}
                    className={`min-h-11 flex items-center gap-2.5 rounded-xl border px-3 py-2 text-xs font-medium ${
                      active
                        ? 'border-blue-500 bg-blue-500/10 text-blue-600 dark:text-indigo-300'
                        : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="pt-2 border-t border-slate-200/80 dark:border-slate-800">
              <ThemeSwitcher compact value={themePreference} systemPrefersDark={systemPrefersDark} onChange={setThemePreference} />
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification Stack */}
      {toasts.length > 0 && (
        <div className="fixed top-16 right-3 sm:right-6 z-50 w-80 max-w-[90vw] space-y-2 pointer-events-none">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto rounded-xl border p-3.5 shadow-xl backdrop-blur-xl text-xs transition-all ${
                t.kind === 'error'
                  ? 'border-red-300 dark:border-red-800/80 bg-white/95 dark:bg-[#1E1018]/95 text-red-800 dark:text-red-200'
                  : t.kind === 'success'
                    ? 'border-emerald-300 dark:border-emerald-800/80 bg-white/95 dark:bg-[#0D1E1B]/95 text-emerald-900 dark:text-emerald-200'
                    : t.kind === 'warning'
                      ? 'border-amber-300 dark:border-amber-800/80 bg-white/95 dark:bg-[#1E190E]/95 text-amber-900 dark:text-amber-200'
                      : 'border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#0C1322]/95 text-slate-800 dark:text-slate-200'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{t.title}</p>
                  <p className="mt-0.5 opacity-85 leading-relaxed">{t.message}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setToasts((prev) => prev.filter((item) => item.id !== t.id))}
                  className="opacity-60 hover:opacity-100"
                  aria-label="Dismiss toast"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Confirmation Dialogs */}
      <ConfirmDialog
        open={confirmState.type === 'emergency-stop'}
        title={confirmState.payload ? 'Engage Emergency Stop?' : 'Clear Emergency Stop?'}
        description={
          confirmState.payload
            ? 'Immediately pauses the autonomous paper trading scheduler and blocks all new paper entries until you clear the emergency stop.'
            : 'Restores paper trading eligibility subject to all daily loss, daily trade count, and consecutive loss caps.'
        }
        confirmLabel={confirmState.payload ? 'Engage Emergency Stop' : 'Clear Emergency Stop'}
        tone={confirmState.payload ? 'danger' : 'primary'}
        busy={busy}
        onCancel={() => setConfirmState({ type: null })}
        onConfirm={async () => {
          const val = Boolean(confirmState.payload);
          setConfirmState({ type: null });
          await executeEmergencyStop(val);
        }}
      />

      <ConfirmDialog
        open={confirmState.type === 'reset-daily'}
        title="Reset Daily Risk Counters?"
        description="Resets today's simulated daily loss, daily profit, daily trade count, and consecutive loss streak counters back to zero."
        confirmLabel="Reset Daily Counters"
        tone="warning"
        busy={busy}
        onCancel={() => setConfirmState({ type: null })}
        onConfirm={async () => {
          setConfirmState({ type: null });
          await executeResetDailyRisk();
        }}
      />

      <ConfirmDialog
        open={confirmState.type === 'arm-auto'}
        title={confirmState.payload ? 'Arm Autonomous Paper Mode?' : 'Pause Autonomous Paper Mode?'}
        description={
          confirmState.payload
            ? `Starts the server-side autonomous scheduler scanning ${aiSettings?.enabledAssets.length ?? 6} instruments every ${aiSettings?.scanIntervalSeconds ?? 60}s and opening validated PAPER trades within your risk limits. Real-money broker execution remains locked.`
            : 'Pauses autonomous paper trade scanning while keeping open trade expiry monitoring active.'
        }
        confirmLabel={confirmState.payload ? 'Arm Autonomous Mode' : 'Pause Autonomous Mode'}
        tone={confirmState.payload ? 'primary' : 'warning'}
        busy={busy}
        onCancel={() => setConfirmState({ type: null })}
        onConfirm={async () => {
          const val = Boolean(confirmState.payload);
          setConfirmState({ type: null });
          await executeToggleAutoArm(val);
        }}
      />
    </div>
  );
}

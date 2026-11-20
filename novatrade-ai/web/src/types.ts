export type Timeframe = '1m' | '5m' | '15m' | '1h';
export type OperatingMode = 'signals' | 'assisted' | 'automatic';
export type StrategyProfile = 'conservative' | 'balanced' | 'momentum';
export type ThemePreference = 'light' | 'dark' | 'system';
export type DashboardAccountSource = 'paper' | 'mt5' | 'iq_option';

export type NavSection =
  | 'overview'
  | 'scanner'
  | 'live-markets'
  | 'signals'
  | 'paper-trading'
  | 'history'
  | 'analytics'
  | 'risk'
  | 'brokers'
  | 'novapay'
  | 'settings';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AssetDefinition {
  symbol: string;
  name: string;
  category: 'FX' | 'CRYPTO' | 'COMMODITY';
  instrumentType: 'FOREX' | 'CRYPTO' | 'COMMODITY';
  decimals: number;
  binaryOptionsOfferedByBroker?: boolean;
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

export interface GeminiCommentary {
  available: boolean;
  model: string;
  summary: string | null;
  riskNote: string | null;
  error?: string;
}

export interface SignalRecord {
  id: string;
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
  marketStatus?: 'LIVE' | 'DELAYED' | 'MARKET_CLOSED' | 'OPEN' | 'DELAYED_OR_CLOSED' | 'UNAVAILABLE';
  isStale?: boolean;
  timestamp: string;
  indicators: IndicatorSnapshot | null;
  supportingIndicators: SupportingIndicatorsSummary | null;
  riskAssessment: RiskAssessment | null;
  mtf: MultiTimeframeSummary | null;
  backtest: BacktestSampleStats;
  reasons: string[];
  warning: string;
  aiExplanation: GeminiCommentary | null;
  sourceApp?: 'MT5' | 'IQ_OPTION' | 'UNKNOWN';
  accountModeDetected?: 'DEMO' | 'PRACTICE' | 'REAL' | 'UNKNOWN';
  screenAnalysisId?: string;
}

export interface CandleFeedResponse {
  ok: boolean;
  symbol: string;
  instrumentType: 'FOREX' | 'CRYPTO' | 'COMMODITY';
  timeframe: Timeframe;
  candles: Candle[];
  currentPrice: number | null;
  priceChangePct: number | null;
  provider: string;
  marketStatus: 'LIVE' | 'DELAYED' | 'MARKET_CLOSED' | 'OPEN' | 'DELAYED_OR_CLOSED' | 'UNAVAILABLE';
  fetchedAt: string;
  lastBarAt: string | null;
  latencyMs: number;
  isStale: boolean;
  error?: string;
  overlays?: {
    ema9: number[];
    ema21: number[];
    ema50: number[];
    bbUpper: number;
    bbMiddle: number;
    bbLower: number;
  };
}

export interface ScannerRow {
  symbol: string;
  name: string;
  category: string;
  instrumentType: 'FOREX' | 'CRYPTO' | 'COMMODITY';
  timeframe: Timeframe;
  direction: 'CALL' | 'PUT' | 'WAIT';
  score: number;
  rawDirectionalConfidence?: number;
  actionableConfidence?: number;
  confidenceState?: 'STALE_OR_UNAVAILABLE' | 'WEAK_SETUP_WAIT' | 'STRONG_SETUP_ACTIONABLE';
  zeroConfidenceReason?: string | null;
  suggestedExpirySeconds: number;
  requestedExpirySeconds?: number;
  effectiveExpirySeconds?: number;
  expiryAdjusted?: boolean;
  expiryAdjustmentReason?: string | null;
  entryPrice: number | null;
  provider: string;
  marketStatus?: 'LIVE' | 'DELAYED' | 'MARKET_CLOSED' | 'OPEN' | 'DELAYED_OR_CLOSED' | 'UNAVAILABLE';
  isStale?: boolean;
  trend: string;
  rsi14: number | null;
  volatility: string;
  mtfAlignment: string;
  backtestWinRate: number | null;
  backtestSampleSize: number;
  riskLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME';
  reasons: string[];
  error: string | null;
  timestamp: string;
}

export interface PaperTrade {
  id: string;
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
  status: string;
  pnl: number | null;
  signalScore: number | null;
  provider: string;
  settledBy: string | null;
  createdAt: string;
  closedAt: string | null;
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
  sourceApp?: 'MT5' | 'IQ_OPTION' | 'UNKNOWN';
  screenAnalysisId?: string;
}

export interface RiskSettings {
  maxTradeAmount: number;
  dailyLossLimit: number;
  dailyProfitTarget: number;
  maxConsecutiveLosses: number;
  maxDailyTrades: number;
  maxSimultaneousTrades: number;
  tradingScheduleEnabled: boolean;
  tradingStartHourUtc: number;
  tradingEndHourUtc: number;
  emergencyStop: boolean;
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

export type BrokerId = 'mt5' | 'iq_option';
export type BrokerApiType =
  | 'official_python_bridge'
  | 'terminal_bridge'
  | 'unofficial_connector';
export type BrokerAssetClass = 'FOREX' | 'CRYPTO' | 'COMMODITY' | 'STOCKS' | 'CFD' | 'BINARY';
export type BrokerOrderType = 'MARKET' | 'LIMIT' | 'BINARY_FIXED_EXPIRY';
export type BrokerConnectionState =
  | 'CONNECTED'
  | 'GATEWAY ONLINE'
  | 'GATEWAY OFFLINE'
  | 'NOT CONFIGURED'
  | 'AUTHENTICATION FAILED';

export interface BrokerCredentialFieldSpec {
  key: 'apiKey' | 'apiSecret' | 'accessToken' | 'accountNumber' | 'bridgeUrl' | 'bridgeToken' | 'serverName' | 'email';
  label: string;
  secret: boolean;
  required: boolean;
  placeholder: string;
}

export interface BrokerCapabilities {
  brokerId: BrokerId;
  broker: string;
  apiType: BrokerApiType;
  isOfficialApi: boolean;
  isPreparedAdapterOnly: boolean;
  adapterInstalled: boolean;
  authorisedApiVerified: boolean;
  connectorConfigured: boolean;
  demoSupported: boolean;
  realAccountSupported: boolean;
  orderExecutionSupported: boolean;
  marketDataSupported: boolean;
  accountSyncSupported: boolean;
  positionsSyncSupported: boolean;
  historySupported: boolean;
  demoOrderPlacementSupported: boolean;
  liveOrderPlacementSupported: boolean;
  supportedAssetClasses: BrokerAssetClass[];
  supportedOrderTypes: BrokerOrderType[];
  environment: 'demo' | 'real' | null;
  message: string;
  credentialFields: BrokerCredentialFieldSpec[];
}

export interface BrokerConnectorDiagnostics {
  configured: boolean;
  urlValid: boolean;
  hadVarNamePrefix: boolean;
  isLocalhost: boolean;
  reachable: boolean;
  authenticated: boolean;
  credentialsConfigured: boolean | null;
  tokenConfigured: boolean;
  latencyMs: number | null;
  targetHost: string | null;
  warnings: string[];
  lastConnectorError: string | null;
}

export interface BrokerStatusSnapshot extends Partial<BrokerCapabilities> {
  broker: string;
  adapterInstalled: boolean;
  authorisedApiVerified: boolean;
  connectorConfigured: boolean;
  demoSupported: boolean;
  realAccountSupported: boolean;
  orderExecutionSupported: boolean;
  historySupported: boolean;
  environment: 'demo' | 'real' | null;
  message: string;
  connected: boolean;
  executionEnabled: boolean;
  accountType: string | null;
  balance: number | null;
  equity?: number | null;
  currency: string | null;
  connectorUrlConfigured: boolean;
  lastCheckedAt: string;
  limitations: string[];
  diagnostics?: BrokerConnectorDiagnostics;
}

export interface BrokerCatalogItem {
  id: BrokerId;
  name: string;
  apiType?: BrokerApiType;
  isOfficialApi?: boolean;
  isPreparedAdapterOnly?: boolean;
  status: 'INTEGRATED_READONLY' | 'OFFICIAL_SANDBOX_API' | 'PREPARED_BRIDGE' | 'PLANNED';
  description: string;
  realExecutionEnabled: boolean;
  capabilities?: BrokerCapabilities;
}

export interface BrokerAccountRiskLimits {
  maxOrderAmount: number;
  maxDailyLoss: number;
  maxDailyOrders: number;
  maxOpenPositions: number;
  allowCall: boolean;
  allowPut: boolean;
}

export interface ManagedBrokerAccountPublic {
  id: string;
  userId: string;
  brokerId: BrokerId;
  brokerName: string;
  label: string;
  environment: 'demo' | 'real';
  externalAccountId: string | null;
  status: BrokerConnectionState;
  connected: boolean;
  accountType: string | null;
  balance: number | null;
  equity: number | null;
  currency: string | null;
  hasCredentials: boolean;
  maskedCredentialHint: string | null;
  credentialSource: 'user_vault' | 'server_env' | 'none';
  capabilities: BrokerCapabilities;
  limitations: string[];
  diagnostics?: BrokerConnectorDiagnostics;
  riskLimits: BrokerAccountRiskLimits;
  dailyOrdersCount: number;
  dailySimulatedLoss: number;
  lastCheckedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  isAuthoritative?: boolean;
  isStaleDuplicate?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InstrumentCompatibilityResult {
  compatible: boolean;
  brokerId: BrokerId;
  symbol: string;
  mappedSymbol: string | null;
  assetClass: BrokerAssetClass;
  supportedOrderTypes: BrokerOrderType[];
  reason: string;
}

export interface BrokerOrderRecord {
  id: string;
  userId: string;
  accountId: string;
  brokerId: BrokerId;
  brokerName: string;
  environment: 'demo' | 'real';
  symbol: string;
  mappedSymbol: string;
  direction: 'CALL' | 'PUT';
  orderType: BrokerOrderType;
  amount: number;
  entryPrice: number | null;
  filledPrice: number | null;
  realizedPnl: number | null;
  brokerOrderId: string;
  idempotencyKey: string;
  status: 'SUBMITTED' | 'FILLED' | 'PARTIAL' | 'REJECTED' | 'CANCELLED' | 'CLOSED' | 'UNKNOWN';
  source: 'assisted' | 'automatic' | 'manual' | 'history_sync';
  note: string;
  createdAt: string;
  reconciledAt: string | null;
}

export interface BrokerAssetInfo {
  symbol: string;
  brokerSymbol?: string;
  name?: string;
  category: string;
  open: boolean;
  digits?: number;
}

export interface BrokerQuote {
  symbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  spread: number | null;
  time: number | null;
  source: string;
  note?: string;
}

export interface BrokerPosition {
  ticket: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: number;
  openPrice: number;
  currentPrice: number | null;
  profit: number | null;
  sl: number | null;
  tp: number | null;
  openedAt: string | null;
  expiresAt?: string | null;
  instrumentType?: string | null;
  mode?: 'PRACTICE' | 'REAL' | null;
  canClose?: boolean;
  comment?: string | null;
}

export interface BrokerOrderValidationResult {
  valid: boolean;
  compatible: boolean;
  environment: 'demo' | 'real';
  symbol: string;
  mappedSymbol: string | null;
  direction: 'CALL' | 'PUT';
  orderType: BrokerOrderType;
  amount: number;
  normalizedVolume: number | null;
  estimatedMargin: number | null;
  freeMargin: number | null;
  retcode?: number | null;
  reason: string;
  source: string;
}

export interface PeriodPerformanceRow {
  period: string;
  trades: number;
  wins: number;
  losses: number;
  netPnl: number;
  winRatePct: number | null;
}

export interface AnalyticsSummary {
  startingVirtualBalance: number;
  currentVirtualBalance: number;
  todayPnl: number;
  todayTrades: number;
  totalTrades: number;
  activeTrades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  profitFactor: number | null;
  maxDrawdown: number;
  equityCurve: Array<{ index: number; timestamp: string; symbol: string; equity: number; pnl: number }>;
  dailyStats: PeriodPerformanceRow[];
  weeklyStats: PeriodPerformanceRow[];
  monthlyStats: PeriodPerformanceRow[];
  bySymbol: Array<{ symbol: string; trades: number; wins: number; losses: number; netPnl: number }>;
}

export interface ActivityEvent {
  id: string;
  category: string;
  eventType: string;
  summary: string;
  createdAt: string;
}

export interface HealthStatus {
  status: string;
  mode: OperatingMode;
  executionMode: string;
  liveExecution: boolean;
  version: string;
  virtualBalance?: {
    startingBalance: number;
    currentBalance: number;
    totalNetPnl: number;
  };
  scheduler: {
    armed: boolean;
    scanIntervalSeconds: number;
    lastScanAt: string | null;
    lastCycleSummary: string | null;
  };
  supabase: {
    clientConfigured: boolean;
    serverConfigured: boolean;
  };
  geminiConfigured: boolean;
  iqConnectorConfigured: boolean;
  iqConnectorUrlValid?: boolean;
  executionCapabilities?: {
    paperSimulation: boolean;
    mt5BridgeConfigured: boolean;
    mt5DemoRoutingSupported: boolean;
    mt5RealRoutingSupported: boolean;
    iqOptionInspectionSupported: boolean;
    iqOptionOrderExecutionSupported: boolean;
  };
  execution?: {
    paperSimulation: { supported: boolean; active: boolean };
    mt5Demo: { supported: boolean; bridgeConfigured: boolean; connected: boolean; active: boolean };
    mt5Real: { supported: boolean; bridgeConfigured: boolean; connected: boolean; active: boolean };
    iqOption: {
      inspectionSupported: boolean;
      orderExecutionSupported: boolean;
      demoConnected: boolean;
      realConnected: boolean;
      active: boolean;
      selectedEnvironment: 'demo' | 'real' | null;
    };
    autoBrokerRoutingEnabled: boolean;
    activeTarget: 'PAPER_SIMULATOR' | 'MT5_DEMO' | 'MT5_REAL' | 'IQ_OPTION_DEMO' | 'IQ_OPTION_REAL';
    activeAccount: {
      id: string;
      brokerId: 'mt5' | 'iq_option';
      label: string;
      environment: 'demo' | 'real';
      connected: boolean;
      accountType: string | null;
    } | null;
  };
}

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  role: string;
  preferredCurrency: string;
  timezone: string;
  authMode: 'supabase' | 'local-preview';
}

export interface ToastNotice {
  id: string;
  kind: 'info' | 'success' | 'error' | 'warning';
  title: string;
  message: string;
  createdAt: string;
}

export interface AndroidDevicePermissions {
  mediaProjection: boolean;
  accessibility: boolean;
  allowMt5: boolean;
  allowIqOption: boolean;
  assistedApprovalRequired: boolean;
  realMoneyBlocked: boolean;
}

export interface AndroidDevicePublic {
  id: string;
  userId: string;
  deviceName: string;
  deviceModel: string | null;
  osVersion: string | null;
  pairingExpiresAt: string | null;
  tokenPrefix: string | null;
  permissions: AndroidDevicePermissions;
  targetPackages: string[];
  status: 'PAIRED_PENDING' | 'ACTIVE' | 'PAUSED' | 'REVOKED';
  lastAppPackage: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AndroidScreenAnalysisRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  appPackage: string;
  appName: 'MT5' | 'IQ_OPTION' | 'UNKNOWN';
  detectedSymbol: string | null;
  normalizedSymbol: string | null;
  detectedTimeframe: string | null;
  detectedPrice: number | null;
  detectedAccountMode: 'DEMO' | 'PRACTICE' | 'REAL' | 'UNKNOWN';
  detectedBalance: number | null;
  detectedCurrency: string | null;
  chartTrend: 'UPTREND' | 'DOWNTREND' | 'RANGING' | 'UNCLEAR';
  visionSummary: string;
  riskWarning: string | null;
  recommendedAction: 'CALL' | 'PUT' | 'WAIT';
  confidenceScore: number;
  signalId: string | null;
  quantDirection: 'CALL' | 'PUT' | 'WAIT' | null;
  quantScore: number | null;
  quantProvider: string | null;
  alignmentStatus: 'ALIGNED' | 'CONFLICT' | 'VISION_ONLY' | 'NO_TRADE';
  candlestickObservations: string[];
  tradeButtonsVisible: boolean;
  detectedActionLabels: string[];
  createdAt: string;
}

export interface AndroidActionQueueItem {
  id: string;
  userId: string;
  deviceId: string | null;
  screenAnalysisId: string | null;
  appPackage: string;
  appName: 'MT5' | 'IQ_OPTION' | 'UNKNOWN';
  operatingMode: OperatingMode;
  symbol: string;
  direction: 'CALL' | 'PUT';
  stakeOrVolume: number;
  expirySeconds: number;
  accountModeVerified: 'DEMO' | 'PRACTICE' | 'REAL' | 'UNKNOWN';
  accountModeVerificationSource?: 'BROKER_SESSION' | 'MT5_BRIDGE' | 'IQ_CONNECTOR' | 'UNVERIFIED';
  verifiedBrokerAccountId?: string | null;
  status:
    | 'PENDING_USER_APPROVAL'
    | 'AUTHORIZED'
    | 'DISPATCHED_TO_DEVICE'
    | 'EXECUTED_REPORTED'
    | 'REJECTED'
    | 'BLOCKED_RISK'
    | 'BLOCKED_UNVERIFIED_ACCOUNT'
    | 'EXPIRED';
  reason: string;
  expiresAt: string | null;
  approvedAt: string | null;
  executedAt: string | null;
  deviceAckNote: string | null;
  createdAt: string;
}

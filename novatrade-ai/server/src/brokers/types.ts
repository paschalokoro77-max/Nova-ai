/**
 * Universal Multi-Broker Adapter Contract & Connection Manager Types.
 * Safety invariants:
 * - Only documented official REST/Gateway APIs or explicitly labelled bridge/unofficial read-only connectors.
 * - Real-money execution stays locked; only demo/practice/paper environments may be authenticated or routed.
 * - Broker credentials remain server-side only and are never returned to the frontend.
 */

export type BrokerId = 'mt5' | 'iq_option';
export type BrokerEnvironment = 'demo' | 'real';
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
  /** True when broker uses an official SDK or API (e.g. MetaQuotes MetaTrader5 official Python SDK) */
  isOfficialApi: boolean;
  /** True when the adapter requires a separately hosted bridge/gateway or credentials before live connectivity works */
  isPreparedAdapterOnly: boolean;
  adapterInstalled: boolean;
  authorisedApiVerified: boolean;
  connectorConfigured: boolean;
  demoSupported: boolean;
  realAccountSupported: boolean;
  /** Backwards-compatible aggregate order execution capability flag (strictly demo/paper when true) */
  orderExecutionSupported: boolean;
  marketDataSupported: boolean;
  accountSyncSupported: boolean;
  positionsSyncSupported: boolean;
  historySupported: boolean;
  demoOrderPlacementSupported: boolean;
  liveOrderPlacementSupported: boolean;
  supportedAssetClasses: BrokerAssetClass[];
  supportedOrderTypes: BrokerOrderType[];
  environment: BrokerEnvironment | null;
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

export interface BrokerStatusSnapshot extends BrokerCapabilities {
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

export interface BrokerAssetInfo {
  symbol: string;
  brokerSymbol?: string;
  name?: string;
  category: string;
  open: boolean;
}

export interface BrokerCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
  mode?: string | null;
  canClose?: boolean;
  comment?: string | null;
}

export interface BrokerOrderValidationResult {
  valid: boolean;
  compatible: boolean;
  environment: BrokerEnvironment;
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

export interface BrokerTradeHistoryResult {
  supported: boolean;
  trades: Array<Record<string, unknown>>;
  note: string;
}

export interface BrokerCredentialsInput {
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  accountNumber?: string;
  bridgeUrl?: string;
  bridgeToken?: string;
  serverName?: string;
  email?: string;
}

export interface BrokerAccountContext {
  accountId: string;
  brokerId: BrokerId;
  label: string;
  environment: BrokerEnvironment;
  externalAccountId: string | null;
  credentials: BrokerCredentialsInput;
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

export interface BrokerOrderRequest {
  environment: BrokerEnvironment;
  symbol: string;
  mappedSymbol?: string;
  assetClass?: BrokerAssetClass;
  direction: 'CALL' | 'PUT';
  orderType: BrokerOrderType;
  amount: number;
  entryPrice: number | null;
  expirySeconds: number;
  idempotencyKey: string;
}

export interface BrokerOrderPlacementResult {
  accepted: boolean;
  brokerOrderId: string;
  status: 'SUBMITTED' | 'FILLED' | 'PARTIAL' | 'REJECTED' | 'CANCELLED' | 'CLOSED';
  mappedSymbol: string;
  filledPrice: number | null;
  filledUnits: number | null;
  rawStatus: string;
  message: string;
  submittedAt: string;
}

export interface BrokerOrderReconciliationResult {
  found: boolean;
  brokerOrderId: string;
  status: 'SUBMITTED' | 'FILLED' | 'PARTIAL' | 'REJECTED' | 'CANCELLED' | 'CLOSED' | 'UNKNOWN';
  filledPrice: number | null;
  realizedPnl: number | null;
  updatedAt: string;
  note: string;
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
  environment: BrokerEnvironment;
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

export interface BrokerOrderRecord {
  id: string;
  userId: string;
  accountId: string;
  brokerId: BrokerId;
  brokerName: string;
  environment: BrokerEnvironment;
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

export interface BrokerAdapter {
  readonly brokerId: BrokerId;
  readonly brokerName: string;
  getCapabilities(ctx?: BrokerAccountContext): Promise<BrokerCapabilities>;
  getStatus(ctx?: BrokerAccountContext): Promise<BrokerStatusSnapshot>;
  connect(ctx?: BrokerAccountContext): Promise<{
    connected: boolean;
    accountType: string | null;
    balance: number | null;
    equity?: number | null;
    currency: string | null;
    externalAccountId?: string | null;
    message: string;
  }>;
  disconnect(ctx?: BrokerAccountContext): Promise<{ connected: boolean; message: string }>;
  getBalance(ctx?: BrokerAccountContext): Promise<{
    balance: number | null;
    equity?: number | null;
    accountType: string | null;
    currency: string | null;
    source: string;
  }>;
  getAssets(ctx?: BrokerAccountContext): Promise<{ assets: BrokerAssetInfo[]; count: number; source: string }>;
  getQuote?(symbol: string, ctx?: BrokerAccountContext): Promise<BrokerQuote>;
  getCandles?(
    symbol: string,
    intervalSeconds: number,
    count: number,
    ctx?: BrokerAccountContext
  ): Promise<{ candles: BrokerCandle[]; source: string; note?: string }>;
  getPositions?(ctx?: BrokerAccountContext): Promise<{
    supported: boolean;
    positions: BrokerPosition[];
    source: string;
    note?: string;
  }>;
  checkInstrumentCompatibility(
    symbol: string,
    assetClass: BrokerAssetClass,
    orderType?: BrokerOrderType,
    ctx?: BrokerAccountContext
  ): InstrumentCompatibilityResult;
  validateOrder?(
    ctx: BrokerAccountContext,
    order: BrokerOrderRequest
  ): Promise<BrokerOrderValidationResult>;
  getTradeHistory(ctx?: BrokerAccountContext): Promise<BrokerTradeHistoryResult>;
  placeOrder?(
    ctx: BrokerAccountContext,
    order: BrokerOrderRequest
  ): Promise<BrokerOrderPlacementResult>;
  getOrderStatus?(
    ctx: BrokerAccountContext,
    brokerOrderId: string
  ): Promise<BrokerOrderReconciliationResult>;
  closePosition?(
    ctx: BrokerAccountContext,
    brokerOrderId: string
  ): Promise<{
    closed: boolean;
    brokerOrderId: string;
    status: string;
    realizedPnl: number | null;
    mode?: string | null;
    message: string;
    closedAt?: string | null;
  }>;
}

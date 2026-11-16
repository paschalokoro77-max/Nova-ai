import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  BrokerAccountContext,
  BrokerAccountRiskLimits,
  BrokerAssetClass,
  BrokerCandle,
  BrokerCapabilities,
  BrokerConnectionState,
  BrokerConnectorDiagnostics,
  BrokerCredentialsInput,
  BrokerEnvironment,
  BrokerId,
  BrokerOrderPlacementResult,
  BrokerOrderRecord,
  BrokerOrderRequest,
  BrokerOrderType,
  BrokerOrderValidationResult,
  BrokerPosition,
  BrokerQuote,
  BrokerTradeHistoryResult,
  InstrumentCompatibilityResult,
  ManagedBrokerAccountPublic,
} from './types.ts';
import { BrokerRegistry } from './registry.ts';
import { getSupabaseAdmin } from '../supabaseAdmin.ts';

export class BrokerConnectionError extends Error {
  readonly statusCode: number;
  readonly connectionStatus: BrokerConnectionState;
  readonly account?: ManagedBrokerAccountPublic;

  constructor(
    message: string,
    options: {
      statusCode: number;
      connectionStatus: BrokerConnectionState;
      account?: ManagedBrokerAccountPublic;
    }
  ) {
    super(message);
    this.name = 'BrokerConnectionError';
    this.statusCode = options.statusCode;
    this.connectionStatus = options.connectionStatus;
    this.account = options.account;
  }
}

interface StoredAccountInternal {
  id: string;
  userId: string;
  brokerId: BrokerId;
  label: string;
  environment: BrokerEnvironment;
  externalAccountId: string | null;
  status: BrokerConnectionState;
  connected: boolean;
  accountType: string | null;
  balance: number | null;
  equity: number | null;
  currency: string | null;
  encryptedCredentials: string | null;
  maskedCredentialHint: string | null;
  credentialSource: 'user_vault' | 'server_env' | 'none';
  riskLimits: BrokerAccountRiskLimits;
  dailyKey: string;
  dailyOrdersCount: number;
  dailySimulatedLoss: number;
  lastCheckedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserBrokerStore {
  activeAccountId: string | null;
  autoExecuteBrokerDemo?: boolean;
  accounts: StoredAccountInternal[];
  orders: BrokerOrderRecord[];
  seenIdempotencyKeys: Record<string, string>;
}

const DEFAULT_ACCOUNT_RISK_LIMITS: BrokerAccountRiskLimits = {
  maxOrderAmount: 100,
  maxDailyLoss: 500,
  maxDailyOrders: 20,
  maxOpenPositions: 5,
  allowCall: true,
  allowPut: true,
};

function maskSecret(val: string | undefined): string | null {
  const clean = (val || '').trim();
  if (!clean) return null;
  if (clean.length <= 4) return '••••';
  return `••••${clean.slice(-4)}`;
}

function buildCredentialHint(creds: BrokerCredentialsInput): string | null {
  return (
    maskSecret(creds.accessToken) ||
    maskSecret(creds.apiKey) ||
    maskSecret(creds.bridgeToken) ||
    (creds.bridgeUrl ? creds.bridgeUrl.replace(/^https?:\/\//, '').slice(0, 24) : null) ||
    (creds.accountNumber ? maskSecret(creds.accountNumber) : null) ||
    (creds.apiSecret ? 'Password Encrypted' : null)
  );
}

function hasAnyCredentialValue(creds: BrokerCredentialsInput): boolean {
  return Boolean(
    creds.apiKey?.trim() ||
      creds.apiSecret?.trim() ||
      creds.accessToken?.trim() ||
      creds.accountNumber?.trim() ||
      creds.bridgeUrl?.trim() ||
      creds.bridgeToken?.trim() ||
      creds.serverName?.trim()
  );
}

export class BrokerConnectionManager {
  private readonly registry: BrokerRegistry;
  private readonly baseDir: string | null;
  private readonly stores = new Map<string, UserBrokerStore>();
  private readonly vaultKey: Buffer;

  constructor(registry: BrokerRegistry, persistPath: string | null = path.resolve(process.cwd(), '.novatrade-data/state.json')) {
    this.registry = registry;
    this.baseDir = persistPath ? path.join(path.dirname(persistPath), 'brokers') : null;
    this.vaultKey = this.loadOrCreateMasterKey();
  }

  private loadOrCreateMasterKey(): Buffer {
    const envSecret = (process.env.BROKER_VAULT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (envSecret) {
      return crypto.createHash('sha256').update(envSecret).digest();
    }
    if (this.baseDir) {
      try {
        fs.mkdirSync(this.baseDir, { recursive: true });
        const keyPath = path.join(this.baseDir, '.broker-vault.key');
        if (fs.existsSync(keyPath)) {
          const hex = fs.readFileSync(keyPath, 'utf8').trim();
          if (hex.length === 64) return Buffer.from(hex, 'hex');
        }
        const generated = crypto.randomBytes(32);
        fs.writeFileSync(keyPath, generated.toString('hex'), { mode: 0o600 });
        return generated;
      } catch {
        // Fallback to process-local ephemeral key
      }
    }
    return crypto.randomBytes(32);
  }

  private encryptCredentials(creds: BrokerCredentialsInput): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.vaultKey, iv);
    const plaintext = JSON.stringify(creds);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
  }

  private decryptCredentials(payload: string | null): BrokerCredentialsInput {
    if (!payload) return {};
    try {
      const [ivB64, tagB64, dataB64] = payload.split('.');
      if (!ivB64 || !tagB64 || !dataB64) return {};
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.vaultKey, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
      return JSON.parse(plain) as BrokerCredentialsInput;
    } catch {
      return {};
    }
  }

  private normalizeUserId(userId?: string): string {
    const clean = (userId || '').trim();
    return clean || 'local-preview';
  }

  private getStorePath(userId?: string): string | null {
    if (!this.baseDir) return null;
    const safe = this.normalizeUserId(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, `${safe}.json`);
  }

  private getStore(userId?: string): UserBrokerStore {
    const uid = this.normalizeUserId(userId);
    const existing = this.stores.get(uid);
    if (existing) return existing;

    let loaded: UserBrokerStore | null = null;
    const filePath = this.getStorePath(uid);
    if (filePath && fs.existsSync(filePath)) {
      try {
        loaded = JSON.parse(fs.readFileSync(filePath, 'utf8')) as UserBrokerStore;
      } catch {
        loaded = null;
      }
    }

    const store: UserBrokerStore = loaded || {
      activeAccountId: null,
      autoExecuteBrokerDemo: false,
      accounts: [],
      orders: [],
      seenIdempotencyKeys: {},
    };
    if (!Array.isArray(store.accounts)) store.accounts = [];
    if (!Array.isArray(store.orders)) store.orders = [];
    if (!store.seenIdempotencyKeys) store.seenIdempotencyKeys = {};

    // Remove any out-of-scope legacy brokers persisted prior to the MT5 + IQ Option scope lock
    store.accounts = store.accounts.filter((a) => a.brokerId === 'mt5' || a.brokerId === 'iq_option');
    store.orders = store.orders.filter((o) => o.brokerId === 'mt5' || o.brokerId === 'iq_option');
    if (store.activeAccountId && !store.accounts.some((a) => a.id === store.activeAccountId)) {
      store.activeAccountId = null;
      store.autoExecuteBrokerDemo = false;
    }

    // Seed default MetaTrader 5 (MetaQuotes-Demo) and IQ Option entries if missing on initial workspace
    const now = new Date().toISOString();
    const shouldSeedMt5 =
      !store.accounts.some((a) => a.brokerId === 'mt5') &&
      (store.accounts.length === 0 || (store.accounts.length === 1 && store.accounts[0].id.startsWith('iq-default-')));
    if (shouldSeedMt5) {
      const hasEnvMt5 = Boolean((process.env.MT5_BRIDGE_URL || '').trim());
      const mt5Server = (process.env.MT5_DEMO_SERVER || 'MetaQuotes-Demo').trim() || 'MetaQuotes-Demo';
      const mt5Login = (process.env.MT5_DEMO_LOGIN || '').trim() || null;
      store.accounts.unshift({
        id: `mt5-default-${uid.slice(0, 8)}`,
        userId: uid,
        brokerId: 'mt5',
        label: `MT5 ${mt5Server}`,
        environment: 'demo',
        externalAccountId: mt5Login,
        status: hasEnvMt5 ? 'GATEWAY OFFLINE' : 'NOT CONFIGURED',
        connected: false,
        accountType: `DEMO (${mt5Server})`,
        balance: null,
        equity: null,
        currency: 'USD',
        encryptedCredentials: null,
        maskedCredentialHint: null,
        credentialSource: hasEnvMt5 ? 'server_env' : 'none',
        riskLimits: { ...DEFAULT_ACCOUNT_RISK_LIMITS },
        dailyKey: now.slice(0, 10),
        dailyOrdersCount: 0,
        dailySimulatedLoss: 0,
        lastCheckedAt: null,
        lastSyncedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (store.accounts.length === 0 || !store.accounts.some((a) => a.brokerId === 'iq_option')) {
      const hasEnvIq = Boolean((process.env.IQ_CONNECTOR_URL || '').trim());
      if (store.accounts.length <= 1 && !store.accounts.some((a) => a.id.startsWith('iq-default-'))) {
        store.accounts.push({
          id: `iq-default-${uid.slice(0, 8)}`,
          userId: uid,
          brokerId: 'iq_option',
          label: 'IQ Option (PRACTICE Env)',
          environment: 'demo',
          externalAccountId: null,
          status: hasEnvIq ? 'GATEWAY OFFLINE' : 'NOT CONFIGURED',
          connected: false,
          accountType: null,
          balance: null,
          equity: null,
          currency: 'USD',
          encryptedCredentials: null,
          maskedCredentialHint: null,
          credentialSource: hasEnvIq ? 'server_env' : 'none',
          riskLimits: { ...DEFAULT_ACCOUNT_RISK_LIMITS },
          dailyKey: now.slice(0, 10),
          dailyOrdersCount: 0,
          dailySimulatedLoss: 0,
          lastCheckedAt: null,
          lastSyncedAt: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    this.stores.set(uid, store);
    return store;
  }

  private saveStore(userId: string | undefined, store: UserBrokerStore) {
    const filePath = this.getStorePath(userId);
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(store, null, 2), { mode: 0o600 });
    } catch {
      // Non-fatal persistence fallback
    }
  }

  private rollAccountDay(acct: StoredAccountInternal) {
    const today = new Date().toISOString().slice(0, 10);
    if (acct.dailyKey !== today) {
      acct.dailyKey = today;
      acct.dailyOrdersCount = 0;
      acct.dailySimulatedLoss = 0;
    }
  }

  private toContext(acct: StoredAccountInternal): BrokerAccountContext {
    return {
      accountId: acct.id,
      brokerId: acct.brokerId,
      label: acct.label,
      environment: acct.environment,
      externalAccountId: acct.externalAccountId,
      credentials: this.decryptCredentials(acct.encryptedCredentials),
    };
  }

  private hasEnvFallback(brokerId: BrokerId): boolean {
    switch (brokerId) {
      case 'iq_option':
        return Boolean((process.env.IQ_CONNECTOR_URL || '').trim());
      case 'mt5':
        return Boolean((process.env.MT5_BRIDGE_URL || '').trim());
    }
  }

  private async toPublicAccount(
    acct: StoredAccountInternal,
    diagnostics?: BrokerConnectorDiagnostics,
    capabilitiesOverride?: BrokerCapabilities
  ): Promise<ManagedBrokerAccountPublic> {
    this.rollAccountDay(acct);
    const adapter = this.registry.get(acct.brokerId);
    const ctx = this.toContext(acct);
    const capabilities =
      capabilitiesOverride ||
      (adapter
        ? await adapter.getCapabilities(ctx)
        : ({
            brokerId: acct.brokerId,
            broker: acct.brokerId,
            apiType: 'unofficial_connector',
            isOfficialApi: false,
            isPreparedAdapterOnly: true,
            adapterInstalled: false,
            authorisedApiVerified: false,
            connectorConfigured: false,
            demoSupported: false,
            realAccountSupported: false,
            orderExecutionSupported: false,
            marketDataSupported: false,
            accountSyncSupported: false,
            positionsSyncSupported: false,
            historySupported: false,
            demoOrderPlacementSupported: false,
            liveOrderPlacementSupported: false,
            supportedAssetClasses: [],
            supportedOrderTypes: [],
            environment: null,
            message: 'Adapter missing',
            credentialFields: [],
          } satisfies BrokerCapabilities));

    const decrypted = ctx.credentials;
    const hasVault = hasAnyCredentialValue(decrypted);
    const hasEnv = this.hasEnvFallback(acct.brokerId);

    return {
      id: acct.id,
      userId: acct.userId,
      brokerId: acct.brokerId,
      brokerName: adapter?.brokerName || acct.brokerId,
      label: acct.label,
      environment: acct.environment,
      externalAccountId: acct.externalAccountId,
      status: acct.status,
      connected: acct.connected,
      accountType: acct.accountType,
      balance: acct.balance,
      equity: acct.equity,
      currency: acct.currency,
      hasCredentials: hasVault || hasEnv,
      maskedCredentialHint: acct.maskedCredentialHint || (hasEnv ? 'Server Environment' : null),
      credentialSource: hasVault ? 'user_vault' : hasEnv ? 'server_env' : 'none',
      capabilities,
      limitations: diagnostics?.warnings || [],
      diagnostics,
      riskLimits: { ...acct.riskLimits },
      dailyOrdersCount: acct.dailyOrdersCount,
      dailySimulatedLoss: Number(acct.dailySimulatedLoss.toFixed(2)),
      lastCheckedAt: acct.lastCheckedAt,
      lastSyncedAt: acct.lastSyncedAt,
      lastError: acct.lastError,
      createdAt: acct.createdAt,
      updatedAt: acct.updatedAt,
    };
  }

  private async syncBrokerSummaryToSupabase(acct: StoredAccountInternal, capabilities: BrokerCapabilities) {
    const admin = getSupabaseAdmin();
    if (!admin || !acct.userId || acct.userId === 'local-preview') return;
    try {
      await admin.from('broker_connections').upsert(
        {
          user_id: acct.userId,
          broker_name: acct.brokerId,
          environment: acct.environment === 'real' ? 'REAL' : 'PRACTICE',
          status: acct.status,
          account_type: acct.accountType,
          last_balance: acct.balance,
          currency: acct.currency || 'USD',
          capabilities,
          execution_enabled: false,
          last_error: acct.lastError,
          last_checked_at: acct.lastCheckedAt || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,broker_name' }
      );
    } catch {
      // Non-fatal archive sync
    }
  }

  async listAccounts(
    userId: string
  ): Promise<{ activeAccountId: string | null; autoExecuteBrokerDemo: boolean; accounts: ManagedBrokerAccountPublic[] }> {
    const store = this.getStore(userId);
    const list = await Promise.all(store.accounts.map((a) => this.toPublicAccount(a)));
    return {
      activeAccountId: store.activeAccountId,
      autoExecuteBrokerDemo: Boolean(store.autoExecuteBrokerDemo),
      accounts: list,
    };
  }

  async createOrUpdateAccount(
    userId: string,
    input: {
      accountId?: string;
      brokerId: BrokerId;
      label: string;
      environment?: BrokerEnvironment;
      externalAccountId?: string | null;
      credentials?: BrokerCredentialsInput;
      riskLimits?: Partial<BrokerAccountRiskLimits>;
    }
  ): Promise<ManagedBrokerAccountPublic> {
    if (input.environment === 'real') {
      throw new Error('Real-money broker accounts are locked while live execution is disabled. Use demo/practice environment.');
    }
    const adapter = this.registry.get(input.brokerId);
    if (!adapter) {
      throw new Error(`Unsupported broker: ${input.brokerId}`);
    }

    const store = this.getStore(userId);
    const now = new Date().toISOString();
    let target = input.accountId ? store.accounts.find((a) => a.id === input.accountId) : undefined;

    if (!target) {
      const creds = input.credentials || {};
      const hasCreds = hasAnyCredentialValue(creds);
      const hasEnv = this.hasEnvFallback(input.brokerId);
      const hasBridge = hasEnv || Boolean(creds.bridgeUrl?.trim());
      target = {
        id: crypto.randomUUID(),
        userId,
        brokerId: input.brokerId,
        label: input.label.trim() || `${adapter.brokerName} Demo`,
        environment: 'demo',
        externalAccountId: input.externalAccountId?.trim() || creds.accountNumber?.trim() || null,
        status: hasBridge ? 'GATEWAY OFFLINE' : 'NOT CONFIGURED',
        connected: false,
        accountType: null,
        balance: null,
        equity: null,
        currency: 'USD',
        encryptedCredentials: hasCreds ? this.encryptCredentials(creds) : null,
        maskedCredentialHint: buildCredentialHint(creds),
        credentialSource: hasCreds ? 'user_vault' : hasEnv ? 'server_env' : 'none',
        riskLimits: { ...DEFAULT_ACCOUNT_RISK_LIMITS, ...(input.riskLimits || {}) },
        dailyKey: now.slice(0, 10),
        dailyOrdersCount: 0,
        dailySimulatedLoss: 0,
        lastCheckedAt: null,
        lastSyncedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      store.accounts.push(target);
    } else {
      target.label = input.label.trim() || target.label;
      if (input.externalAccountId !== undefined) {
        target.externalAccountId = input.externalAccountId?.trim() || null;
      }
      if (input.credentials && hasAnyCredentialValue(input.credentials)) {
        const merged = { ...this.decryptCredentials(target.encryptedCredentials), ...input.credentials };
        target.encryptedCredentials = this.encryptCredentials(merged);
        target.maskedCredentialHint = buildCredentialHint(merged);
        target.credentialSource = 'user_vault';
        if (input.credentials.accountNumber) {
          target.externalAccountId = input.credentials.accountNumber.trim();
        }
        const hasBridge = this.hasEnvFallback(target.brokerId) || Boolean(merged.bridgeUrl?.trim());
        if (target.status === 'NOT CONFIGURED' && hasBridge) target.status = 'GATEWAY OFFLINE';
        if (!hasBridge) target.status = 'NOT CONFIGURED';
      }
      if (input.riskLimits) {
        target.riskLimits = { ...target.riskLimits, ...input.riskLimits };
      }
      target.updatedAt = now;
    }

    this.saveStore(userId, store);
    return this.toPublicAccount(target);
  }

  deleteAccount(userId: string, accountId: string): boolean {
    const store = this.getStore(userId);
    const idx = store.accounts.findIndex((a) => a.id === accountId);
    if (idx === -1) return false;
    store.accounts.splice(idx, 1);
    if (store.activeAccountId === accountId) {
      store.activeAccountId = null;
    }
    this.saveStore(userId, store);
    return true;
  }

  selectActiveAccount(userId: string, accountId: string | null): { activeAccountId: string | null; autoExecuteBrokerDemo: boolean } {
    const store = this.getStore(userId);
    if (accountId === null) {
      store.activeAccountId = null;
      store.autoExecuteBrokerDemo = false;
      this.saveStore(userId, store);
      return { activeAccountId: null, autoExecuteBrokerDemo: false };
    }
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) {
      throw new Error('Broker account not found for user.');
    }
    store.activeAccountId = acct.id;
    if (acct.brokerId !== 'mt5' || !acct.connected) {
      store.autoExecuteBrokerDemo = false;
    }
    this.saveStore(userId, store);
    return { activeAccountId: acct.id, autoExecuteBrokerDemo: Boolean(store.autoExecuteBrokerDemo) };
  }

  isAutoBrokerExecutionEnabled(userId: string): boolean {
    const store = this.getStore(userId);
    return Boolean(store.autoExecuteBrokerDemo && store.activeAccountId);
  }

  getActiveExecutionAccountId(userId: string): string | null {
    return this.getStore(userId).activeAccountId;
  }

  async setAutoBrokerExecutionEnabled(
    userId: string,
    enabled: boolean,
    globalEmergencyStop: boolean
  ): Promise<{ enabled: boolean; activeAccountId: string | null; reason: string }> {
    const store = this.getStore(userId);
    if (!enabled || globalEmergencyStop) {
      store.autoExecuteBrokerDemo = false;
      this.saveStore(userId, store);
      return {
        enabled: false,
        activeAccountId: store.activeAccountId,
        reason: globalEmergencyStop
          ? 'Emergency Stop engaged; automatic MT5 demo routing disarmed.'
          : 'Automatic MT5 demo execution paused.',
      };
    }
    if (!store.activeAccountId) {
      throw new Error('Select a connected MetaTrader 5 (MT5) demo account as your Active Execution Target first.');
    }
    const acct = store.accounts.find((a) => a.id === store.activeAccountId);
    if (!acct || acct.environment !== 'demo' || !acct.connected) {
      throw new Error('Active execution account must be a connected DEMO account.');
    }
    const adapter = this.registry.get(acct.brokerId);
    const caps = adapter ? await adapter.getCapabilities(this.toContext(acct)) : null;
    if (!caps?.demoOrderPlacementSupported) {
      throw new Error(`${acct.label} is read-only and cannot receive automatic demo orders.`);
    }
    store.autoExecuteBrokerDemo = true;
    this.saveStore(userId, store);
    return {
      enabled: true,
      activeAccountId: acct.id,
      reason: `Validated AI signals will route guarded demo orders to ${acct.label} while Emergency Stop and risk limits stay clear.`,
    };
  }

  updateAccountRiskLimits(userId: string, accountId: string, limits: Partial<BrokerAccountRiskLimits>): BrokerAccountRiskLimits {
    const store = this.getStore(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) throw new Error('Broker account not found.');
    acct.riskLimits = { ...acct.riskLimits, ...limits };
    acct.updatedAt = new Date().toISOString();
    this.saveStore(userId, store);
    return { ...acct.riskLimits };
  }

  async connectAccount(userId: string, accountId: string): Promise<ManagedBrokerAccountPublic> {
    const store = this.getStore(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) {
      throw new BrokerConnectionError('Broker account not found.', {
        statusCode: 404,
        connectionStatus: 'NOT CONFIGURED',
      });
    }
    if (acct.environment !== 'demo') {
      throw new BrokerConnectionError('Real-money broker connections are locked.', {
        statusCode: 423,
        connectionStatus: acct.status,
      });
    }
    const adapter = this.registry.get(acct.brokerId);
    if (!adapter) {
      throw new BrokerConnectionError(`Broker adapter missing: ${acct.brokerId}`, {
        statusCode: 400,
        connectionStatus: 'NOT CONFIGURED',
      });
    }

    const ctx = this.toContext(acct);
    const now = new Date().toISOString();
    try {
      const res = await adapter.connect(ctx);
      acct.connected = res.connected;
      acct.status = res.connected ? 'CONNECTED' : 'AUTHENTICATION FAILED';
      acct.accountType = res.accountType;
      acct.balance = res.balance;
      acct.equity = res.equity ?? res.balance;
      acct.currency = res.currency || acct.currency;
      acct.externalAccountId = res.externalAccountId ?? acct.externalAccountId;
      acct.lastError = res.connected ? null : res.message;
      acct.lastCheckedAt = now;
      acct.lastSyncedAt = res.connected ? now : acct.lastSyncedAt;
      acct.updatedAt = now;
      this.saveStore(userId, store);

      const statusSnap = await adapter.getStatus(this.toContext(acct));
      void this.syncBrokerSummaryToSupabase(acct, statusSnap);
      const publicAccount = await this.toPublicAccount(acct, statusSnap.diagnostics, statusSnap);
      if (!res.connected) {
        throw new BrokerConnectionError(res.message || 'Broker authentication failed.', {
          statusCode: 401,
          connectionStatus: 'AUTHENTICATION FAILED',
          account: publicAccount,
        });
      }
      return publicAccount;
    } catch (err) {
      if (err instanceof BrokerConnectionError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : 'Connection failed.';
      const lower = msg.toLowerCase();
      const hasBridge = this.hasEnvFallback(acct.brokerId) || Boolean((ctx.credentials.bridgeUrl || '').trim());
      const isNotConfigured =
        !hasBridge ||
        lower.includes('is not configured') ||
        lower.includes('bridge url') ||
        lower.includes('connector_url') ||
        lower.includes('mt5_bridge_url') ||
        lower.includes('iq_connector_url');
      const isGatewayOffline =
        !isNotConfigured &&
        (lower.includes('unreachable') ||
          lower.includes('offline') ||
          lower.includes('econnrefused') ||
          lower.includes('etimedout') ||
          lower.includes('enotfound') ||
          lower.includes('fetch failed') ||
          lower.includes('timeout') ||
          lower.includes('aborted') ||
          lower.includes('unexpected html response') ||
          lower.includes('non-json response') ||
          lower.includes('http 5'));

      const connectionStatus: BrokerConnectionState = isNotConfigured
        ? 'NOT CONFIGURED'
        : isGatewayOffline
          ? 'GATEWAY OFFLINE'
          : 'AUTHENTICATION FAILED';
      const statusCode = isNotConfigured ? 422 : isGatewayOffline ? 424 : 401;

      acct.connected = false;
      acct.status = connectionStatus;
      acct.lastError = msg;
      acct.lastCheckedAt = now;
      acct.updatedAt = now;
      this.saveStore(userId, store);
      const publicAccount = await this.toPublicAccount(acct);
      throw new BrokerConnectionError(msg, {
        statusCode,
        connectionStatus,
        account: publicAccount,
      });
    }
  }

  async disconnectAccount(userId: string, accountId: string): Promise<ManagedBrokerAccountPublic> {
    const store = this.getStore(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) throw new Error('Broker account not found.');
    const adapter = this.registry.get(acct.brokerId);
    if (adapter) {
      await adapter.disconnect(this.toContext(acct)).catch(() => undefined);
    }
    acct.connected = false;
    const hasBridge = this.hasEnvFallback(acct.brokerId) || Boolean((this.decryptCredentials(acct.encryptedCredentials).bridgeUrl || '').trim());
    acct.status = !hasBridge ? 'NOT CONFIGURED' : 'GATEWAY OFFLINE';
    acct.lastCheckedAt = new Date().toISOString();
    acct.updatedAt = acct.lastCheckedAt;
    if (store.activeAccountId === accountId) {
      store.activeAccountId = null;
      store.autoExecuteBrokerDemo = false;
    }
    this.saveStore(userId, store);
    return this.toPublicAccount(acct);
  }

  async checkHealthAndSyncBalance(userId: string, accountId: string): Promise<ManagedBrokerAccountPublic> {
    const store = this.getStore(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) throw new Error('Broker account not found.');
    const adapter = this.registry.get(acct.brokerId);
    if (!adapter) throw new Error('Broker adapter not installed.');

    const snap = await adapter.getStatus(this.toContext(acct));
    const now = new Date().toISOString();
    acct.connected = snap.connected;
    acct.status = snap.connected
      ? 'CONNECTED'
      : !snap.connectorConfigured
        ? 'NOT CONFIGURED'
        : !snap.diagnostics?.reachable
          ? 'GATEWAY OFFLINE'
          : snap.diagnostics?.lastConnectorError
            ? 'AUTHENTICATION FAILED'
            : 'GATEWAY ONLINE';
    acct.accountType = snap.accountType ?? acct.accountType;
    acct.balance = snap.balance ?? acct.balance;
    acct.equity = snap.equity ?? acct.equity;
    acct.currency = snap.currency ?? acct.currency;
    acct.lastCheckedAt = now;
    if (snap.connected) acct.lastSyncedAt = now;
    acct.lastError = snap.diagnostics?.lastConnectorError || (snap.connected ? null : snap.message);
    acct.updatedAt = now;
    if (!acct.connected && store.activeAccountId === acct.id) {
      store.autoExecuteBrokerDemo = false;
    }
    this.saveStore(userId, store);
    void this.syncBrokerSummaryToSupabase(acct, snap);
    return this.toPublicAccount(acct, snap.diagnostics, snap);
  }

  checkInstrumentCompatibilityForAccount(
    userId: string,
    accountId: string,
    symbol: string,
    assetClass: BrokerAssetClass,
    orderType: BrokerOrderType
  ): InstrumentCompatibilityResult {
    const store = this.getStore(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) throw new Error('Broker account not found.');
    const adapter = this.registry.get(acct.brokerId);
    if (!adapter) throw new Error('Broker adapter missing.');
    return adapter.checkInstrumentCompatibility(symbol, assetClass, orderType, this.toContext(acct));
  }

  async getAccountQuote(userId: string, accountId: string, symbol: string): Promise<BrokerQuote> {
    const store = this.getStore(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) throw new Error('Broker account not found.');
    const adapter = this.registry.get(acct.brokerId);
    if (!adapter?.getQuote) {
      throw new Error(`${adapter?.brokerName || acct.brokerId} does not support quote lookup.`);
    }
    return adapter.getQuote(symbol, this.toContext(acct));
  }

  async getAccountCandles(
    userId: string,
    accountId: string,
    symbol: string,
    intervalSeconds: number,
    count: number
  ): Promise<{ candles: BrokerCandle[]; source: string; note?: string }> {
    const store = this.getStore(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) throw new Error('Broker account not found.');
    const adapter = this.registry.get(acct.brokerId);
    if (!adapter?.getCandles) {
      throw new Error(`${adapter?.brokerName || acct.brokerId} does not support candlestick retrieval.`);
    }
    return adapter.getCandles(symbol, intervalSeconds, count, this.toContext(acct));
  }

  async getAccountPositions(
    userId: string,
    accountId: string
  ): Promise<{ supported: boolean; positions: BrokerPosition[]; source: string; note?: string }> {
    const store = this.getStore(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) throw new Error('Broker account not found.');
    const adapter = this.registry.get(acct.brokerId);
    if (!adapter?.getPositions) {
      return {
        supported: false,
        positions: [],
        source: acct.brokerId.toUpperCase(),
        note: `${adapter?.brokerName || acct.brokerId} is read-only / does not expose open MT5-style positions.`,
      };
    }
    return adapter.getPositions(this.toContext(acct));
  }

  async getAccountAssets(userId: string, accountId: string) {
    const store = this.getStore(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) throw new Error('Broker account not found.');
    const adapter = this.registry.get(acct.brokerId);
    if (!adapter) throw new Error('Broker adapter not installed.');
    return adapter.getAssets(this.toContext(acct));
  }

  async validateDemoOrder(
    userId: string,
    input: {
      accountId: string;
      symbol: string;
      assetClass: BrokerAssetClass;
      direction: 'CALL' | 'PUT';
      orderType: BrokerOrderType;
      amount: number;
      entryPrice: number | null;
      expirySeconds: number;
      globalEmergencyStop: boolean;
    }
  ): Promise<BrokerOrderValidationResult> {
    const cleanSymbol = input.symbol.toUpperCase();
    const fail = (reason: string, compatible = false): BrokerOrderValidationResult => ({
      valid: false,
      compatible,
      environment: 'demo',
      symbol: cleanSymbol,
      mappedSymbol: compatible ? cleanSymbol : null,
      direction: input.direction,
      orderType: input.orderType,
      amount: input.amount,
      normalizedVolume: null,
      estimatedMargin: null,
      freeMargin: null,
      reason,
      source: 'NOVATRADE_RISK_VALIDATOR',
    });

    if (input.globalEmergencyStop) {
      return fail('Emergency Stop is active. Order validation & execution halted.');
    }
    const store = this.getStore(userId);
    const acct = store.accounts.find((a) => a.id === input.accountId);
    if (!acct) {
      return fail('Selected broker account not found.');
    }
    this.rollAccountDay(acct);
    if (acct.environment !== 'demo') {
      return fail('Real-money broker orders are locked. Demo/Practice environment only.');
    }
    const adapter = this.registry.get(acct.brokerId);
    if (!adapter) {
      return fail('Broker adapter not installed.');
    }
    const ctx = this.toContext(acct);
    const caps = await adapter.getCapabilities(ctx);
    if (!caps.demoOrderPlacementSupported) {
      return fail(`${adapter.brokerName} is read-only or unconfigured for demo order placement.`);
    }
    const compat = adapter.checkInstrumentCompatibility(cleanSymbol, input.assetClass, input.orderType, ctx);
    if (!compat.compatible || !compat.mappedSymbol) {
      return fail(compat.reason, false);
    }

    const limits = acct.riskLimits;
    if (input.direction === 'CALL' && !limits.allowCall) {
      return fail(`Per-account risk guard: CALL/BUY direction is disabled on ${acct.label}.`, true);
    }
    if (input.direction === 'PUT' && !limits.allowPut) {
      return fail(`Per-account risk guard: PUT/SELL direction is disabled on ${acct.label}.`, true);
    }
    if (input.amount > limits.maxOrderAmount) {
      return fail(`Stake ($${input.amount}) exceeds ${acct.label} maxOrderAmount ($${limits.maxOrderAmount}).`, true);
    }
    if (acct.dailyOrdersCount >= limits.maxDailyOrders) {
      return fail(`Daily order cap (${limits.maxDailyOrders}) reached on ${acct.label}.`, true);
    }
    if (acct.dailySimulatedLoss >= limits.maxDailyLoss) {
      return fail(`Daily loss limit ($${limits.maxDailyLoss}) reached on ${acct.label}.`, true);
    }
    if (!acct.connected) {
      return fail(`${acct.label} is not connected. Connect the demo session to run terminal validation.`, true);
    }

    if (adapter.validateOrder) {
      const orderReq: BrokerOrderRequest = {
        environment: 'demo',
        symbol: cleanSymbol,
        mappedSymbol: compat.mappedSymbol,
        assetClass: input.assetClass,
        direction: input.direction,
        orderType: input.orderType,
        amount: input.amount,
        entryPrice: input.entryPrice,
        expirySeconds: input.expirySeconds,
        idempotencyKey: `val-${acct.id}-${cleanSymbol}`,
      };
      return adapter.validateOrder(ctx, orderReq);
    }

    return {
      valid: true,
      compatible: true,
      environment: 'demo',
      symbol: cleanSymbol,
      mappedSymbol: compat.mappedSymbol,
      direction: input.direction,
      orderType: input.orderType,
      amount: input.amount,
      normalizedVolume: null,
      estimatedMargin: null,
      freeMargin: null,
      reason: compat.reason,
      source: 'NOVATRADE_RISK_VALIDATOR',
    };
  }

  async executeDemoOrder(
    userId: string,
    input: {
      accountId: string;
      symbol: string;
      assetClass: BrokerAssetClass;
      direction: 'CALL' | 'PUT';
      orderType: BrokerOrderType;
      amount: number;
      entryPrice: number | null;
      expirySeconds: number;
      idempotencyKey?: string;
      source: 'assisted' | 'automatic' | 'manual';
      globalEmergencyStop: boolean;
    }
  ): Promise<{ order: BrokerOrderRecord; placement: BrokerOrderPlacementResult; duplicatePrevented?: boolean }> {
    if (input.globalEmergencyStop) {
      throw new Error('Emergency Stop is active. All broker and paper order execution is halted.');
    }

    const store = this.getStore(userId);
    const acct = store.accounts.find((a) => a.id === input.accountId);
    if (!acct) {
      throw new Error('Selected broker account not found.');
    }
    this.rollAccountDay(acct);

    // 1. Validate account environment & connection
    if (acct.environment !== 'demo') {
      throw new Error('Real-money broker orders are locked. Demo/Practice environment only.');
    }
    if (!acct.connected) {
      throw new Error(`${acct.label} is not connected. Connect the demo session first.`);
    }

    // 2. Duplicate-order protection via explicit idempotencyKey + short 8s (account, symbol, direction) window
    const idempotencyKey = (input.idempotencyKey || `${acct.id}-${input.symbol}-${input.direction}-${Date.now()}`).trim();
    const existingOrderId = store.seenIdempotencyKeys[idempotencyKey];
    if (existingOrderId) {
      const existing = store.orders.find((o) => o.id === existingOrderId);
      if (existing) {
        return {
          order: existing,
          duplicatePrevented: true,
          placement: {
            accepted: true,
            brokerOrderId: existing.brokerOrderId,
            status: existing.status === 'UNKNOWN' ? 'SUBMITTED' : existing.status,
            mappedSymbol: existing.mappedSymbol,
            filledPrice: existing.filledPrice,
            filledUnits: null,
            rawStatus: existing.status,
            message: 'Duplicate order prevented via idempotency key; returning existing order record.',
            submittedAt: existing.createdAt,
          },
        };
      }
    }

    const recentDup = store.orders.find(
      (o) =>
        o.accountId === acct.id &&
        o.symbol === input.symbol.toUpperCase() &&
        o.direction === input.direction &&
        o.status !== 'CANCELLED' &&
        o.status !== 'REJECTED' &&
        Date.now() - new Date(o.createdAt).getTime() < 8000
    );
    if (recentDup) {
      throw new Error(
        `Duplicate-order protection: ${input.direction} order on ${input.symbol} was already sent to ${acct.label} within the last 8 seconds.`
      );
    }

    // 3. Validate adapter permissions & instrument compatibility
    const adapter = this.registry.get(acct.brokerId);
    if (!adapter) throw new Error('Broker adapter not installed.');
    const ctx = this.toContext(acct);
    const caps = await adapter.getCapabilities(ctx);
    if (!caps.demoOrderPlacementSupported || !adapter.placeOrder) {
      throw new Error(`${adapter.brokerName} is read-only or does not support order placement.`);
    }

    const compat = adapter.checkInstrumentCompatibility(input.symbol, input.assetClass, input.orderType, ctx);
    if (!compat.compatible || !compat.mappedSymbol) {
      throw new Error(`Instrument incompatibility: ${compat.reason}`);
    }

    // 4. Per-account risk limit checks
    const limits = acct.riskLimits;
    if (input.direction === 'CALL' && !limits.allowCall) {
      throw new Error(`Per-account risk guard: CALL/BUY direction is disabled on ${acct.label}.`);
    }
    if (input.direction === 'PUT' && !limits.allowPut) {
      throw new Error(`Per-account risk guard: PUT/SELL direction is disabled on ${acct.label}.`);
    }
    if (input.amount > limits.maxOrderAmount) {
      throw new Error(
        `Per-account risk limit: Stake ($${input.amount}) exceeds ${acct.label} maxOrderAmount ($${limits.maxOrderAmount}).`
      );
    }
    if (acct.dailyOrdersCount >= limits.maxDailyOrders) {
      throw new Error(
        `Per-account risk limit: Daily order cap (${limits.maxDailyOrders}) reached on ${acct.label}.`
      );
    }
    if (acct.dailySimulatedLoss >= limits.maxDailyLoss) {
      throw new Error(
        `Per-account risk limit: Daily loss limit ($${limits.maxDailyLoss}) reached on ${acct.label}.`
      );
    }
    const openCount = store.orders.filter(
      (o) => o.accountId === acct.id && (o.status === 'SUBMITTED' || o.status === 'PARTIAL')
    ).length;
    if (openCount >= limits.maxOpenPositions) {
      throw new Error(
        `Per-account risk limit: Max open orders (${limits.maxOpenPositions}) reached on ${acct.label}.`
      );
    }

    const orderPayload: BrokerOrderRequest = {
      environment: 'demo',
      symbol: input.symbol,
      mappedSymbol: compat.mappedSymbol,
      assetClass: input.assetClass,
      direction: input.direction,
      orderType: input.orderType,
      amount: input.amount,
      entryPrice: input.entryPrice,
      expirySeconds: input.expirySeconds,
      idempotencyKey,
    };

    // 4b. Pre-flight broker order validation (e.g., MT5 mt5.order_check()) when supported
    if (adapter.validateOrder) {
      const preflight = await adapter.validateOrder(ctx, orderPayload);
      if (!preflight.valid) {
        throw new Error(`Order validation failed: ${preflight.reason}`);
      }
    }

    // 5. Execute sandbox/demo order on broker adapter
    const placement = await adapter.placeOrder(ctx, orderPayload);

    const record: BrokerOrderRecord = {
      id: crypto.randomUUID(),
      userId,
      accountId: acct.id,
      brokerId: acct.brokerId,
      brokerName: adapter.brokerName,
      environment: 'demo',
      symbol: input.symbol.toUpperCase(),
      mappedSymbol: placement.mappedSymbol,
      direction: input.direction,
      orderType: input.orderType,
      amount: input.amount,
      entryPrice: input.entryPrice,
      filledPrice: placement.filledPrice,
      realizedPnl: null,
      brokerOrderId: placement.brokerOrderId,
      idempotencyKey,
      status: placement.status,
      source: input.source,
      note: placement.message,
      createdAt: placement.submittedAt,
      reconciledAt: placement.status === 'FILLED' ? placement.submittedAt : null,
    };

    if (placement.accepted) {
      acct.dailyOrdersCount += 1;
    }
    store.orders.unshift(record);
    if (store.orders.length > 250) store.orders.length = 250;
    store.seenIdempotencyKeys[idempotencyKey] = record.id;
    this.saveStore(userId, store);

    return { order: record, placement };
  }

  async reconcileOrders(userId: string, accountId?: string): Promise<{ updatedCount: number; orders: BrokerOrderRecord[] }> {
    const store = this.getStore(userId);
    let updatedCount = 0;

    for (const ord of store.orders) {
      if (accountId && ord.accountId !== accountId) continue;
      if (ord.status === 'CLOSED' || ord.status === 'CANCELLED' || ord.status === 'REJECTED') continue;
      const acct = store.accounts.find((a) => a.id === ord.accountId);
      if (!acct) continue;
      const adapter = this.registry.get(acct.brokerId);
      if (!adapter?.getOrderStatus) continue;

      const res = await adapter.getOrderStatus(this.toContext(acct), ord.brokerOrderId);
      if (res.found) {
        if (res.status !== ord.status || res.filledPrice !== ord.filledPrice || res.realizedPnl !== ord.realizedPnl) {
          ord.status = res.status;
          ord.filledPrice = res.filledPrice ?? ord.filledPrice;
          ord.realizedPnl = res.realizedPnl ?? ord.realizedPnl;
          ord.note = res.note;
          ord.reconciledAt = res.updatedAt;
          if (typeof res.realizedPnl === 'number' && res.realizedPnl < 0) {
            this.rollAccountDay(acct);
            acct.dailySimulatedLoss = Number((acct.dailySimulatedLoss + Math.abs(res.realizedPnl)).toFixed(2));
          }
          updatedCount += 1;
        }
      }
    }

    if (updatedCount > 0) this.saveStore(userId, store);
    return {
      updatedCount,
      orders: accountId ? store.orders.filter((o) => o.accountId === accountId) : store.orders,
    };
  }

  async syncAccountTradeHistory(userId: string, accountId: string): Promise<BrokerTradeHistoryResult> {
    const store = this.getStore(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) throw new Error('Broker account not found.');
    const adapter = this.registry.get(acct.brokerId);
    if (!adapter) throw new Error('Broker adapter missing.');
    const res = await adapter.getTradeHistory(this.toContext(acct));
    acct.lastSyncedAt = new Date().toISOString();
    this.saveStore(userId, store);
    return res;
  }

  listOrders(userId: string, accountId?: string): BrokerOrderRecord[] {
    const store = this.getStore(userId);
    return accountId ? store.orders.filter((o) => o.accountId === accountId) : store.orders;
  }
}

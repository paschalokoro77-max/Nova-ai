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
  BrokerStatusSnapshot,
  BrokerTradeHistoryResult,
  InstrumentCompatibilityResult,
  ManagedBrokerAccountPublic,
} from './types.ts';
import { BrokerRegistry } from './registry.ts';
import { getSupabaseAdmin } from '../supabaseAdmin.ts';
import {
  resolveAccountBucket,
  type AccountPerformanceBucket,
  type LearnableTradeRecord,
} from '../performanceLearner.ts';
import type { VerifiedBrokerAccountSession } from '../androidCompanion.ts';

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

function toFiniteBalance(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

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
  private readonly hydratedUsers = new Set<string>();
  private readonly pendingHydrations = new Map<string, Promise<UserBrokerStore>>();
  private readonly inflightAccountOps = new Map<string, Promise<ManagedBrokerAccountPublic>>();
  private readonly vaultKey: Buffer;
  private lastPersistenceError: string | null = null;
  private vaultTableUnavailable = false;

  constructor(
    registry: BrokerRegistry,
    persistPath: string | null = process.env.NODE_ENV === 'production'
      ? null
      : path.resolve(process.cwd(), '.novatrade-data/state.json')
  ) {
    this.registry = registry;
    const effectivePath = process.env.NODE_ENV === 'production' ? null : persistPath;
    this.baseDir = effectivePath ? path.join(path.dirname(effectivePath), 'brokers') : null;
    this.vaultKey = this.loadOrCreateMasterKey();
  }

  private loadOrCreateMasterKey(): Buffer {
    const isProduction = process.env.NODE_ENV === 'production';
    const vaultSecret = (process.env.BROKER_VAULT_SECRET || '').trim();
    if (isProduction) {
      if (!vaultSecret || Buffer.byteLength(vaultSecret, 'utf8') < 32) {
        throw new Error('BROKER_VAULT_SECRET (minimum 32 bytes) is required in production.');
      }
      return crypto.createHash('sha256').update(vaultSecret).digest();
    }
    const envSecret = vaultSecret || (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
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

  private sanitizeAccountForVault(acct: StoredAccountInternal): StoredAccountInternal {
    // Strictly persist only encryptedCredentials (AES-256-GCM ciphertext) — never plaintext passwords/secrets.
    return {
      id: acct.id,
      userId: acct.userId,
      brokerId: acct.brokerId,
      label: acct.label,
      environment: acct.environment === 'real' ? 'real' : 'demo',
      externalAccountId: acct.externalAccountId,
      status: acct.status,
      connected: Boolean(acct.connected),
      accountType: acct.accountType,
      balance: acct.balance,
      equity: acct.equity,
      currency: acct.currency,
      encryptedCredentials: acct.encryptedCredentials,
      maskedCredentialHint: acct.maskedCredentialHint,
      credentialSource: acct.credentialSource,
      riskLimits: { ...DEFAULT_ACCOUNT_RISK_LIMITS, ...(acct.riskLimits || {}) },
      dailyKey: acct.dailyKey,
      dailyOrdersCount: acct.dailyOrdersCount,
      dailySimulatedLoss: acct.dailySimulatedLoss,
      lastCheckedAt: acct.lastCheckedAt,
      lastSyncedAt: acct.lastSyncedAt,
      lastError: acct.lastError,
      createdAt: acct.createdAt,
      updatedAt: acct.updatedAt,
    };
  }

  private isValidEncryptedPayload(payload: unknown): payload is string {
    if (typeof payload !== 'string' || !payload.trim()) return false;
    const parts = payload.split('.');
    return parts.length === 3 && parts.every((p) => p.length > 0);
  }

  getLastPersistenceError(): string | null {
    return this.lastPersistenceError;
  }

  private isMissingTableError(error: { code?: string; message?: string } | null | undefined): boolean {
    if (!error) return false;
    const msg = (error.message || '').toLowerCase();
    return (
      error.code === 'PGRST205' ||
      error.code === '42P01' ||
      msg.includes('schema cache') ||
      msg.includes('could not find the table') ||
      msg.includes('does not exist')
    );
  }

  private async readVaultRowFromSupabase(uid: string): Promise<{
    row: {
      active_account_id?: string | null;
      auto_execute_broker_demo?: boolean;
      accounts_json?: unknown;
      orders_json?: unknown;
      idempotency_keys_json?: unknown;
    } | null;
    error: string | null;
  }> {
    const admin = getSupabaseAdmin();
    if (!admin) return { row: null, error: null };

    if (!this.vaultTableUnavailable) {
      const { data, error } = await admin
        .from('broker_vault_state')
        .select('active_account_id,auto_execute_broker_demo,accounts_json,orders_json,idempotency_keys_json')
        .eq('user_id', uid)
        .maybeSingle();

      if (!error) {
        if (data && typeof data === 'object') {
          return { row: data as Record<string, unknown>, error: null };
        }
        // If broker_vault_state exists but has no row yet, also check fallback row in broker_connections
      } else if (this.isMissingTableError(error)) {
        this.vaultTableUnavailable = true;
      } else {
        return { row: null, error: error.message };
      }
    }

    // Fallback to existing public.broker_connections table (available since 001_complete_platform.sql)
    const fallback = await admin
      .from('broker_connections')
      .select('capabilities')
      .eq('user_id', uid)
      .eq('broker_name', '__vault_state__')
      .maybeSingle();

    if (fallback.error) {
      if (this.isMissingTableError(fallback.error)) {
        return { row: null, error: null };
      }
      return { row: null, error: fallback.error.message };
    }

    const caps = (fallback.data as { capabilities?: Record<string, unknown> } | null)?.capabilities;
    if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
      return {
        row: {
          active_account_id: typeof caps.active_account_id === 'string' ? caps.active_account_id : null,
          auto_execute_broker_demo: Boolean(caps.auto_execute_broker_demo),
          accounts_json: caps.accounts_json,
          orders_json: caps.orders_json,
          idempotency_keys_json: caps.idempotency_keys_json,
        },
        error: null,
      };
    }
    return { row: null, error: null };
  }

  async ensureHydrated(userId?: string): Promise<UserBrokerStore> {
    const uid = this.normalizeUserId(userId);
    const localStore = this.getStore(uid);
    if (uid === 'local-preview' || this.hydratedUsers.has(uid)) {
      return localStore;
    }

    const inflight = this.pendingHydrations.get(uid);
    if (inflight) return inflight;

    const hydrationPromise = (async (): Promise<UserBrokerStore> => {
      const admin = getSupabaseAdmin();
      if (!admin) {
        this.hydratedUsers.add(uid);
        return localStore;
      }

      try {
        const { row, error } = await this.readVaultRowFromSupabase(uid);

        if (error) {
          this.lastPersistenceError = `Supabase broker vault read failed: ${error}`;
          console.warn(`[BrokerConnectionManager] ${this.lastPersistenceError}`);
          return localStore;
        }

        if (row) {
          const rawAccounts = Array.isArray(row.accounts_json) ? (row.accounts_json as StoredAccountInternal[]) : [];
          const restoredAccounts: StoredAccountInternal[] = [];
          for (const item of rawAccounts) {
            if (!item || typeof item !== 'object') continue;
            if (item.brokerId !== 'mt5' && item.brokerId !== 'iq_option') continue;
            if (typeof item.id !== 'string' || !item.id.trim()) continue;
            const safeEnv: BrokerEnvironment = item.environment === 'real' ? 'real' : 'demo';
            const enc = this.isValidEncryptedPayload(item.encryptedCredentials) ? item.encryptedCredentials : null;
            restoredAccounts.push(
              this.sanitizeAccountForVault({
                ...item,
                userId: uid,
                environment: safeEnv,
                encryptedCredentials: enc,
              })
            );
          }

          // Merge restored accounts with any in-memory accounts so existing connections are never lost
          if (restoredAccounts.length > 0) {
            const byId = new Map<string, StoredAccountInternal>();
            for (const acct of restoredAccounts) {
              byId.set(acct.id, acct);
            }
            for (const memAcct of localStore.accounts) {
              const isDefaultSeed = memAcct.id.startsWith('mt5-default-') || memAcct.id.startsWith('iq-default-');
              if (byId.has(memAcct.id)) {
                const prev = byId.get(memAcct.id)!;
                if (memAcct.updatedAt > prev.updatedAt) {
                  byId.set(memAcct.id, memAcct);
                }
              } else if (!isDefaultSeed || !restoredAccounts.some((a) => a.brokerId === memAcct.brokerId)) {
                byId.set(memAcct.id, memAcct);
              }
            }
            localStore.accounts = Array.from(byId.values());
          }

          if (Array.isArray(row.orders_json)) {
            const existingOrderIds = new Set(localStore.orders.map((o) => o.id));
            const restoredOrders = (row.orders_json as BrokerOrderRecord[]).filter(
              (o) => o && typeof o === 'object' && typeof o.id === 'string' && (o.brokerId === 'mt5' || o.brokerId === 'iq_option')
            );
            for (const ord of restoredOrders) {
              if (!existingOrderIds.has(ord.id)) {
                localStore.orders.push(ord);
                existingOrderIds.add(ord.id);
              }
            }
            localStore.orders.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
            if (localStore.orders.length > 250) localStore.orders.length = 250;
          }

          if (row.idempotency_keys_json && typeof row.idempotency_keys_json === 'object' && !Array.isArray(row.idempotency_keys_json)) {
            const restoredKeys = row.idempotency_keys_json as Record<string, string>;
            localStore.seenIdempotencyKeys = { ...restoredKeys, ...localStore.seenIdempotencyKeys };
          }

          if (
            !localStore.activeAccountId &&
            typeof row.active_account_id === 'string' &&
            localStore.accounts.some((a) => a.id === row.active_account_id)
          ) {
            localStore.activeAccountId = row.active_account_id;
          }

          if (typeof row.auto_execute_broker_demo === 'boolean' && localStore.activeAccountId) {
            localStore.autoExecuteBrokerDemo = row.auto_execute_broker_demo;
          }
        }

        this.hydratedUsers.add(uid);
        this.lastPersistenceError = null;
        return localStore;
      } catch (err) {
        this.lastPersistenceError = `Supabase broker vault hydration error: ${err instanceof Error ? err.message : 'unknown error'}`;
        console.warn(`[BrokerConnectionManager] ${this.lastPersistenceError}`);
        return localStore;
      } finally {
        this.pendingHydrations.delete(uid);
      }
    })();

    this.pendingHydrations.set(uid, hydrationPromise);
    return hydrationPromise;
  }

  private async persistStoreToSupabase(userId: string | undefined, store: UserBrokerStore): Promise<{ ok: boolean; error?: string }> {
    const uid = this.normalizeUserId(userId);
    if (uid === 'local-preview') return { ok: true };
    const admin = getSupabaseAdmin();
    if (!admin) return { ok: true };

    try {
      const sanitizedAccounts = store.accounts.map((a) => this.sanitizeAccountForVault(a));
      const trimmedOrders = store.orders.slice(0, 250);
      const keyEntries = Object.entries(store.seenIdempotencyKeys);
      const trimmedKeys =
        keyEntries.length > 500
          ? Object.fromEntries(keyEntries.slice(keyEntries.length - 500))
          : { ...store.seenIdempotencyKeys };
      const nowIso = new Date().toISOString();

      const vaultPayload = {
        active_account_id: store.activeAccountId,
        auto_execute_broker_demo: Boolean(store.autoExecuteBrokerDemo),
        accounts_json: sanitizedAccounts,
        orders_json: trimmedOrders,
        idempotency_keys_json: trimmedKeys,
      };

      if (!this.vaultTableUnavailable) {
        const { error } = await admin.from('broker_vault_state').upsert(
          {
            user_id: uid,
            ...vaultPayload,
            updated_at: nowIso,
          },
          { onConflict: 'user_id' }
        );
        if (!error) {
          this.lastPersistenceError = null;
          return { ok: true };
        }
        if (this.isMissingTableError(error)) {
          this.vaultTableUnavailable = true;
        } else {
          this.lastPersistenceError = `Supabase broker vault write failed: ${error.message}`;
          console.warn(`[BrokerConnectionManager] ${this.lastPersistenceError}`);
          return { ok: false, error: error.message };
        }
      }

      // Fallback write into existing public.broker_connections table (encrypted AES-256-GCM credentials only)
      const fallbackWrite = await admin.from('broker_connections').upsert(
        {
          user_id: uid,
          broker_name: '__vault_state__',
          environment: 'PRACTICE',
          status: 'DISCONNECTED',
          account_type: 'ENCRYPTED_VAULT',
          capabilities: vaultPayload,
          execution_enabled: false,
          last_checked_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: 'user_id,broker_name' }
      );
      if (fallbackWrite.error) {
        this.lastPersistenceError = `Supabase broker vault write failed: ${fallbackWrite.error.message}`;
        console.warn(`[BrokerConnectionManager] ${this.lastPersistenceError}`);
        return { ok: false, error: fallbackWrite.error.message };
      }
      this.lastPersistenceError = null;
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      this.lastPersistenceError = `Supabase broker vault write exception: ${msg}`;
      console.warn(`[BrokerConnectionManager] ${this.lastPersistenceError}`);
      return { ok: false, error: msg };
    }
  }

  private saveStore(userId: string | undefined, store: UserBrokerStore, persistRemote = true) {
    const filePath = this.getStorePath(userId);
    if (filePath) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(store, null, 2), { mode: 0o600 });
      } catch {
        // Non-fatal local persistence fallback
      }
    }
    if (persistRemote) {
      void this.persistStoreToSupabase(userId, store);
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

  findAuthoritativeIqAccountId(store: UserBrokerStore): string | null {
    const iqAccounts = store.accounts.filter((a) => a.brokerId === 'iq_option');
    if (iqAccounts.length === 0) return null;
    const score = (a: StoredAccountInternal): number => {
      let s = 0;
      if (a.connected) s += 1000;
      if (a.credentialSource === 'user_vault') s += 200;
      else if (a.credentialSource === 'server_env') s += 50;
      if (typeof a.balance === 'number' && Number.isFinite(a.balance)) s += 100;
      if (a.status === 'CONNECTED') s += 100;
      return s;
    };
    const sorted = [...iqAccounts].sort((a, b) => {
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      const ta = new Date(a.lastSyncedAt || a.updatedAt || a.createdAt).getTime() || 0;
      const tb = new Date(b.lastSyncedAt || b.updatedAt || b.createdAt).getTime() || 0;
      return tb - ta;
    });
    return sorted[0]?.id ?? null;
  }

  async listAccounts(
    userId: string
  ): Promise<{ activeAccountId: string | null; autoExecuteBrokerDemo: boolean; accounts: ManagedBrokerAccountPublic[] }> {
    const store = await this.ensureHydrated(userId);
    const authIqId = this.findAuthoritativeIqAccountId(store);
    const list = await Promise.all(
      store.accounts.map(async (a) => {
        const pub = await this.toPublicAccount(a);
        if (a.brokerId === 'iq_option') {
          pub.isAuthoritative = a.id === authIqId;
          pub.isStaleDuplicate = a.id !== authIqId && !a.connected;
        }
        return pub;
      })
    );
    return {
      activeAccountId: store.activeAccountId,
      autoExecuteBrokerDemo: Boolean(store.autoExecuteBrokerDemo),
      accounts: list,
    };
  }

  private findMatchingIqAccountForUpsert(
    store: UserBrokerStore,
    email?: string,
    label?: string,
    environment?: BrokerEnvironment
  ): StoredAccountInternal | undefined {
    const normalizedEmail = (email || '').trim().toLowerCase();
    const iqAccounts = store.accounts.filter((a) => a.brokerId === 'iq_option');
    if (iqAccounts.length === 0) return undefined;

    if (normalizedEmail) {
      const matches = iqAccounts.filter((a) => {
        const decrypted = this.decryptCredentials(a.encryptedCredentials);
        const storedEmail = (decrypted.email || '').trim().toLowerCase();
        if (storedEmail && storedEmail === normalizedEmail) return true;
        const lbl = (a.label || '').trim().toLowerCase();
        return lbl === `iq option (${normalizedEmail})` || lbl === normalizedEmail;
      });
      if (matches.length > 0) {
        if (environment) {
          const envMatch = matches.find((a) => a.environment === environment);
          if (envMatch) return envMatch;
          const cleanLbl = (label || '').trim().toLowerCase();
          const hasDifferentiatingLabel = cleanLbl && matches.every(
            (a) => (a.label || '').trim().toLowerCase() !== cleanLbl
          );
          if (hasDifferentiatingLabel) {
            return undefined;
          }
        }
        // Prefer the currently connected / most recently synced record so login updates the authoritative account in place
        matches.sort((a, b) => {
          if (a.connected !== b.connected) return a.connected ? -1 : 1;
          const ta = new Date(a.lastSyncedAt || a.updatedAt || a.createdAt).getTime() || 0;
          const tb = new Date(b.lastSyncedAt || b.updatedAt || b.createdAt).getTime() || 0;
          return tb - ta;
        });
        return matches[0];
      }
    }

    // Prevent spawning duplicate empty/unconfigured "IQ Option Demo" shells
    const cleanLabel = (label || '').trim().toLowerCase();
    if (!normalizedEmail && cleanLabel) {
      const shell = iqAccounts.find(
        (a) => a.credentialSource === 'none' && (a.label || '').trim().toLowerCase() === cleanLabel
      );
      if (shell) return shell;
    }

    return undefined;
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
    const adapter = this.registry.get(input.brokerId);
    if (!adapter) {
      throw new Error(`Unsupported broker: ${input.brokerId}`);
    }

    const store = await this.ensureHydrated(userId);
    const now = new Date().toISOString();
    let target = input.accountId ? store.accounts.find((a) => a.id === input.accountId) : undefined;
    if (!target && input.brokerId === 'iq_option') {
      target = this.findMatchingIqAccountForUpsert(store, input.credentials?.email, input.label, input.environment);
    }
    const resolvedEnv: BrokerEnvironment = input.environment === 'real' ? 'real' : 'demo';

    if (!target) {
      const creds = input.credentials || {};
      const hasCreds = hasAnyCredentialValue(creds);
      const hasEnv = this.hasEnvFallback(input.brokerId);
      const hasBridge = hasEnv || Boolean(creds.bridgeUrl?.trim());
      target = {
        id: crypto.randomUUID(),
        userId,
        brokerId: input.brokerId,
        label: input.label.trim() || `${adapter.brokerName} ${resolvedEnv === 'real' ? 'Real' : 'Demo'}`,
        environment: resolvedEnv,
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
      if (input.environment) {
        target.environment = input.environment === 'real' ? 'real' : 'demo';
      }
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

    this.saveStore(userId, store, false);
    await this.persistStoreToSupabase(userId, store);
    const pub = await this.toPublicAccount(target);
    if (target.brokerId === 'iq_option') {
      const authIqId = this.findAuthoritativeIqAccountId(store);
      pub.isAuthoritative = target.id === authIqId;
      pub.isStaleDuplicate = target.id !== authIqId && !target.connected;
    }
    return pub;
  }

  /** Explicitly invoked (opt-in) cleanup of stale disconnected IQ Option duplicate records.
   * Preserves the authoritative / connected IQ Option record untouched and never calls adapter.disconnect().
   */
  async cleanupStaleIqDuplicates(
    userId: string
  ): Promise<{ keptAccountId: string | null; removedIds: string[]; removedCount: number }> {
    const store = await this.ensureHydrated(userId);
    const authIqId = this.findAuthoritativeIqAccountId(store);
    if (!authIqId) {
      return { keptAccountId: null, removedIds: [], removedCount: 0 };
    }

    const removedIds: string[] = [];
    store.accounts = store.accounts.filter((acct) => {
      if (acct.brokerId !== 'iq_option') return true;
      if (acct.id === authIqId) return true;
      if (acct.connected) return true;
      removedIds.push(acct.id);
      return false;
    });

    if (removedIds.length > 0) {
      if (store.activeAccountId && removedIds.includes(store.activeAccountId)) {
        store.activeAccountId = authIqId;
      }
      this.saveStore(userId, store, false);
      await this.persistStoreToSupabase(userId, store);
    }

    return {
      keptAccountId: authIqId,
      removedIds,
      removedCount: removedIds.length,
    };
  }

  async deleteAccount(userId: string, accountId: string): Promise<boolean> {
    const store = await this.ensureHydrated(userId);
    const idx = store.accounts.findIndex((a) => a.id === accountId);
    if (idx === -1) return false;
    store.accounts.splice(idx, 1);
    if (store.activeAccountId === accountId) {
      store.activeAccountId = null;
      store.autoExecuteBrokerDemo = false;
    }
    this.saveStore(userId, store, false);
    await this.persistStoreToSupabase(userId, store);
    return true;
  }

  async selectActiveAccount(
    userId: string,
    accountId: string | null
  ): Promise<{ activeAccountId: string | null; autoExecuteBrokerDemo: boolean }> {
    const store = await this.ensureHydrated(userId);
    if (accountId === null) {
      store.activeAccountId = null;
      store.autoExecuteBrokerDemo = false;
      this.saveStore(userId, store, false);
      await this.persistStoreToSupabase(userId, store);
      return { activeAccountId: null, autoExecuteBrokerDemo: false };
    }
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) {
      throw new Error('Broker account not found for user.');
    }
    store.activeAccountId = acct.id;
    if (!acct.connected) {
      store.autoExecuteBrokerDemo = false;
    }
    this.saveStore(userId, store, false);
    await this.persistStoreToSupabase(userId, store);
    return { activeAccountId: acct.id, autoExecuteBrokerDemo: Boolean(store.autoExecuteBrokerDemo) };
  }

  isAutoBrokerExecutionEnabled(userId: string): boolean {
    const store = this.getStore(userId);
    return Boolean(store.autoExecuteBrokerDemo && store.activeAccountId);
  }

  getActiveExecutionAccountId(userId: string): string | null {
    return this.getStore(userId).activeAccountId;
  }

  getActiveAccountBucket(userId: string): AccountPerformanceBucket {
    const store = this.getStore(userId);
    if (!store.activeAccountId) return 'PAPER_SIMULATOR';
    const acct = store.accounts.find((a) => a.id === store.activeAccountId);
    if (!acct) return 'PAPER_SIMULATOR';
    return resolveAccountBucket(acct.brokerId, acct.environment);
  }

  getAccountBucket(userId: string, accountId?: string | null): AccountPerformanceBucket {
    const store = this.getStore(userId);
    const targetId = accountId ?? store.activeAccountId;
    if (!targetId) return 'PAPER_SIMULATOR';
    const acct = store.accounts.find((a) => a.id === targetId);
    if (!acct) return 'PAPER_SIMULATOR';
    return resolveAccountBucket(acct.brokerId, acct.environment);
  }

  resolveVerifiedBrokerSession(
    userId: string,
    appName: 'MT5' | 'IQ_OPTION' | 'UNKNOWN'
  ): VerifiedBrokerAccountSession {
    if (appName === 'UNKNOWN') {
      return {
        verified: false,
        mode: 'UNKNOWN',
        source: 'UNVERIFIED',
        brokerAccountId: null,
        reason: 'Target trading app could not be verified as MT5 or IQ Option.',
      };
    }

    const expectedBrokerId: BrokerId = appName === 'MT5' ? 'mt5' : 'iq_option';
    const store = this.getStore(userId);
    const activeAcct = store.activeAccountId ? store.accounts.find((a) => a.id === store.activeAccountId) : undefined;
    const acct =
      activeAcct && activeAcct.brokerId === expectedBrokerId && activeAcct.connected
        ? activeAcct
        : store.accounts.find((a) => a.brokerId === expectedBrokerId && a.connected);

    if (!acct || !acct.connected) {
      return {
        verified: false,
        mode: 'UNKNOWN',
        source: 'UNVERIFIED',
        brokerAccountId: null,
        reason: `No connected ${appName === 'MT5' ? 'MetaTrader 5 (MT5)' : 'IQ Option'} broker session is active to verify account mode.`,
      };
    }

    const rawAccountType = (acct.accountType || '').trim().toUpperCase();
    if (acct.brokerId === 'mt5') {
      if (rawAccountType && acct.environment === 'demo' && rawAccountType !== 'DEMO') {
        return {
          verified: false,
          mode: 'UNKNOWN',
          source: 'UNVERIFIED',
          brokerAccountId: null,
          reason: `MT5 session mode conflict: configured environment is DEMO but bridge reported ${rawAccountType}.`,
        };
      }
      if (rawAccountType && acct.environment === 'real' && rawAccountType !== 'REAL') {
        return {
          verified: false,
          mode: 'UNKNOWN',
          source: 'UNVERIFIED',
          brokerAccountId: null,
          reason: `MT5 session mode conflict: configured environment is REAL but bridge reported ${rawAccountType}.`,
        };
      }
      return {
        verified: true,
        mode: acct.environment === 'real' ? 'REAL' : 'DEMO',
        source: 'MT5_BRIDGE',
        brokerAccountId: acct.id,
      };
    }

    if (rawAccountType !== 'PRACTICE' && rawAccountType !== 'REAL') {
      return {
        verified: false,
        mode: 'UNKNOWN',
        source: 'UNVERIFIED',
        brokerAccountId: null,
        reason: `IQ Option active account mode is ${rawAccountType || 'UNVERIFIED'}; live orders are blocked until mode is verified directly from IQ Option.`,
      };
    }
    if (acct.environment === 'demo' && rawAccountType !== 'PRACTICE') {
      return {
        verified: false,
        mode: 'UNKNOWN',
        source: 'UNVERIFIED',
        brokerAccountId: null,
        reason: `IQ Option session mode conflict: configured environment is DEMO but connector reported ${rawAccountType}.`,
      };
    }
    if (acct.environment === 'real' && rawAccountType !== 'REAL') {
      return {
        verified: false,
        mode: 'UNKNOWN',
        source: 'UNVERIFIED',
        brokerAccountId: null,
        reason: `IQ Option session mode conflict: configured environment is REAL but connector reported ${rawAccountType}.`,
      };
    }
    return {
      verified: true,
      mode: rawAccountType === 'REAL' ? 'REAL' : 'PRACTICE',
      source: 'IQ_CONNECTOR',
      brokerAccountId: acct.id,
    };
  }

  getBrokerHealthSummary(userId: string) {
    const store = this.getStore(userId);
    const active = store.activeAccountId ? store.accounts.find((a) => a.id === store.activeAccountId) ?? null : null;
    const mt5DemoConnected = store.accounts.some((a) => a.brokerId === 'mt5' && a.environment === 'demo' && a.connected);
    const mt5RealConnected = store.accounts.some((a) => a.brokerId === 'mt5' && a.environment === 'real' && a.connected);
    const iqDemoConnected = store.accounts.some((a) => a.brokerId === 'iq_option' && a.environment === 'demo' && a.connected);
    const iqRealConnected = store.accounts.some((a) => a.brokerId === 'iq_option' && a.environment === 'real' && a.connected);
    return {
      activeTarget: this.getActiveAccountBucket(userId),
      activeAccount: active
        ? {
            id: active.id,
            brokerId: active.brokerId,
            environment: active.environment,
            connected: active.connected,
            accountType: active.accountType,
          }
        : null,
      autoBrokerRoutingEnabled: Boolean(store.autoExecuteBrokerDemo && active && active.connected),
      mt5DemoConnected,
      mt5RealConnected,
      iqDemoConnected,
      iqRealConnected,
    };
  }

  async setAutoBrokerExecutionEnabled(
    userId: string,
    enabled: boolean,
    globalEmergencyStop: boolean
  ): Promise<{ enabled: boolean; activeAccountId: string | null; reason: string }> {
    const store = await this.ensureHydrated(userId);
    if (!enabled || globalEmergencyStop) {
      store.autoExecuteBrokerDemo = false;
      this.saveStore(userId, store, false);
      await this.persistStoreToSupabase(userId, store);
      return {
        enabled: false,
        activeAccountId: store.activeAccountId,
        reason: globalEmergencyStop
          ? 'Emergency Stop engaged; automatic broker routing disarmed.'
          : 'Automatic broker execution paused.',
      };
    }
    if (!store.activeAccountId) {
      throw new Error('Select a connected broker account (IQ Option or MT5) as your Active Execution Target first.');
    }
    const acct = store.accounts.find((a) => a.id === store.activeAccountId);
    if (!acct || !acct.connected) {
      throw new Error('Active execution account must be a connected broker account.');
    }
    if (acct.brokerId === 'iq_option') {
      const iqType = (acct.accountType || '').trim().toUpperCase();
      if (iqType !== 'PRACTICE' && iqType !== 'REAL') {
        throw new Error('IQ Option active account mode is UNVERIFIED; automatic execution is blocked until mode is verified.');
      }
    }
    const adapter = this.registry.get(acct.brokerId);
    const caps = adapter ? await adapter.getCapabilities(this.toContext(acct)) : null;
    const supportsExecution = acct.environment === 'real' ? caps?.liveOrderPlacementSupported : caps?.demoOrderPlacementSupported;
    if (!supportsExecution) {
      throw new Error(`${acct.label} is not configured to receive automatic broker orders.`);
    }
    store.autoExecuteBrokerDemo = true;
    this.saveStore(userId, store, false);
    await this.persistStoreToSupabase(userId, store);
    const modeLabel = acct.accountType || acct.environment.toUpperCase();
    return {
      enabled: true,
      activeAccountId: acct.id,
      reason: `Validated AI signals will route guarded ${modeLabel} orders to ${acct.label} while Emergency Stop and risk limits stay clear.`,
    };
  }

  async updateAccountRiskLimits(
    userId: string,
    accountId: string,
    limits: Partial<BrokerAccountRiskLimits>
  ): Promise<BrokerAccountRiskLimits> {
    const store = await this.ensureHydrated(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) throw new Error('Broker account not found.');
    acct.riskLimits = { ...acct.riskLimits, ...limits };
    acct.updatedAt = new Date().toISOString();
    this.saveStore(userId, store, false);
    await this.persistStoreToSupabase(userId, store);
    return { ...acct.riskLimits };
  }

  async connectAccount(userId: string, accountId: string): Promise<ManagedBrokerAccountPublic> {
    const opKey = `${userId}:${accountId}:connect`;
    const existing = this.inflightAccountOps.get(opKey);
    if (existing) return existing;

    const promise = this.connectAccountInternal(userId, accountId).finally(() => {
      if (this.inflightAccountOps.get(opKey) === promise) {
        this.inflightAccountOps.delete(opKey);
      }
    });
    this.inflightAccountOps.set(opKey, promise);
    return promise;
  }

  private async connectAccountInternal(userId: string, accountId: string): Promise<ManagedBrokerAccountPublic> {
    const store = await this.ensureHydrated(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) {
      throw new BrokerConnectionError('Broker account not found.', {
        statusCode: 404,
        connectionStatus: 'NOT CONFIGURED',
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
      const validBalance = toFiniteBalance(res.balance);
      const validEquity = toFiniteBalance(res.equity) ?? validBalance;
      const iqNormalizedType = (res.accountType || '').trim().toUpperCase();
      const iqVerified =
        acct.brokerId !== 'iq_option' || (res.connected && (iqNormalizedType === 'REAL' || iqNormalizedType === 'PRACTICE'));
      const effectiveConnected = Boolean(res.connected && iqVerified);

      const iqUnverifiedSession = acct.brokerId === 'iq_option' && !effectiveConnected && iqNormalizedType === 'UNVERIFIED';

      acct.connected = effectiveConnected;
      acct.status = effectiveConnected
        ? 'CONNECTED'
        : iqUnverifiedSession
          ? 'MODE UNVERIFIED'
          : 'AUTHENTICATION FAILED';
      if (acct.brokerId === 'iq_option') {
        acct.accountType = effectiveConnected
          ? iqNormalizedType
          : iqUnverifiedSession
            ? 'UNVERIFIED'
            : null;
        acct.environment = effectiveConnected && iqNormalizedType === 'REAL' ? 'real' : 'demo';
      } else {
        acct.accountType = res.accountType;
      }
      acct.balance = effectiveConnected ? (validBalance ?? acct.balance) : null;
      acct.equity = effectiveConnected ? (validEquity ?? acct.equity ?? acct.balance) : null;
      acct.currency = res.currency || acct.currency;
      acct.externalAccountId = res.externalAccountId ?? acct.externalAccountId;
      acct.lastError = effectiveConnected
        ? null
        : res.message || 'IQ Option active account mode could not be verified (UNVERIFIED).';
      acct.lastCheckedAt = now;
      acct.lastSyncedAt = effectiveConnected ? now : acct.lastSyncedAt;
      acct.updatedAt = now;
      this.saveStore(userId, store, false);
      await this.persistStoreToSupabase(userId, store);

      let statusSnap: BrokerStatusSnapshot;
      if (acct.brokerId === 'iq_option' && effectiveConnected) {
        const caps = await adapter.getCapabilities(this.toContext(acct));
        statusSnap = {
          ...caps,
          connected: true,
          executionEnabled: true,
          accountType: res.accountType,
          balance: acct.balance,
          equity: acct.equity,
          currency: res.currency || acct.currency,
          connectorUrlConfigured: true,
          lastCheckedAt: now,
          message: res.message,
          limitations: [],
          diagnostics: {
            configured: true,
            urlValid: true,
            hadVarNamePrefix: false,
            isLocalhost: false,
            reachable: true,
            authenticated: true,
            credentialsConfigured: true,
            tokenConfigured: Boolean((ctx.credentials.bridgeToken || process.env.IQ_CONNECTOR_TOKEN || '').trim()),
            latencyMs: null,
            targetHost: null,
            warnings: [],
            lastConnectorError: null,
          },
        };
      } else {
        statusSnap = await adapter.getStatus(this.toContext(acct));
      }
      void this.syncBrokerSummaryToSupabase(acct, statusSnap);
      const publicAccount = await this.toPublicAccount(acct, statusSnap.diagnostics, statusSnap);
      if (acct.brokerId === 'iq_option') {
        const authIqId = this.findAuthoritativeIqAccountId(store);
        publicAccount.isAuthoritative = acct.id === authIqId;
        publicAccount.isStaleDuplicate = acct.id !== authIqId && !acct.connected;
      }
      if (!effectiveConnected) {
        throw new BrokerConnectionError(
          res.message ||
            (iqUnverifiedSession
              ? 'IQ Option session authenticated, but active account mode could not be verified (UNVERIFIED); live orders are blocked.'
              : 'Broker authentication failed.'),
          {
            statusCode: iqUnverifiedSession ? 409 : 401,
            connectionStatus: iqUnverifiedSession ? 'MODE UNVERIFIED' : 'AUTHENTICATION FAILED',
            account: publicAccount,
          }
        );
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
          lower.includes('timed out') ||
          lower.includes('aborted') ||
          lower.includes('busy with an upstream broker operation') ||
          lower.includes('unexpected html response') ||
          lower.includes('non-json response') ||
          lower.includes('http 5'));

      const connectionStatus: BrokerConnectionState = isNotConfigured
        ? 'NOT CONFIGURED'
        : isGatewayOffline
          ? 'GATEWAY OFFLINE'
          : 'AUTHENTICATION FAILED';
      const statusCode = isNotConfigured ? 422 : isGatewayOffline ? 424 : 401;

      // Do not overwrite an already-healthy IQ Option session on a transient timeout/busy error
      const isTransientTimeout =
        acct.brokerId === 'iq_option' &&
        acct.connected &&
        isGatewayOffline &&
        (lower.includes('timeout') || lower.includes('timed out') || lower.includes('busy') || lower.includes('aborted'));

      if (isTransientTimeout) {
        acct.lastError = `Temporary connector delay (${msg}); active session preserved.`;
        acct.lastCheckedAt = now;
        acct.updatedAt = now;
      } else {
        acct.connected = false;
        acct.status = connectionStatus;
        acct.balance = null;
        acct.equity = null;
        acct.lastError = msg;
        acct.lastCheckedAt = now;
        acct.updatedAt = now;
      }
      this.saveStore(userId, store, false);
      await this.persistStoreToSupabase(userId, store);
      const publicAccount = await this.toPublicAccount(acct);
      throw new BrokerConnectionError(msg, {
        statusCode,
        connectionStatus: isTransientTimeout ? 'CONNECTED' : connectionStatus,
        account: publicAccount,
      });
    }
  }

  async disconnectAccount(userId: string, accountId: string): Promise<ManagedBrokerAccountPublic> {
    const store = await this.ensureHydrated(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) throw new Error('Broker account not found.');
    const adapter = this.registry.get(acct.brokerId);

    // Protect the active IQ Option session: stale/disconnected duplicate cards must NEVER disconnect the live connector
    const otherConnectedIq =
      acct.brokerId === 'iq_option' &&
      store.accounts.some((a) => a.brokerId === 'iq_option' && a.id !== acct.id && a.connected);
    const shouldCallRemoteDisconnect =
      Boolean(adapter) &&
      (acct.brokerId !== 'iq_option' || (acct.connected && !otherConnectedIq));

    if (adapter && shouldCallRemoteDisconnect) {
      await adapter.disconnect(this.toContext(acct)).catch(() => undefined);
    }
    acct.connected = false;
    acct.balance = null;
    acct.equity = null;
    if (acct.brokerId === 'iq_option') {
      acct.accountType = null;
      acct.environment = 'demo';
    }
    const hasBridge = this.hasEnvFallback(acct.brokerId) || Boolean((this.decryptCredentials(acct.encryptedCredentials).bridgeUrl || '').trim());
    acct.status = !hasBridge ? 'NOT CONFIGURED' : 'GATEWAY OFFLINE';
    acct.lastCheckedAt = new Date().toISOString();
    acct.updatedAt = acct.lastCheckedAt;
    if (store.activeAccountId === accountId) {
      store.activeAccountId = null;
      store.autoExecuteBrokerDemo = false;
    }
    this.saveStore(userId, store, false);
    await this.persistStoreToSupabase(userId, store);
    return this.toPublicAccount(acct);
  }

  async checkHealthAndSyncBalance(userId: string, accountId: string): Promise<ManagedBrokerAccountPublic> {
    const opKey = `${userId}:${accountId}:sync`;
    const existing = this.inflightAccountOps.get(opKey);
    if (existing) return existing;

    const promise = this.checkHealthAndSyncBalanceInternal(userId, accountId).finally(() => {
      if (this.inflightAccountOps.get(opKey) === promise) {
        this.inflightAccountOps.delete(opKey);
      }
    });
    this.inflightAccountOps.set(opKey, promise);
    return promise;
  }

  private async checkHealthAndSyncBalanceInternal(userId: string, accountId: string): Promise<ManagedBrokerAccountPublic> {
    const store = await this.ensureHydrated(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) throw new Error('Broker account not found.');
    const adapter = this.registry.get(acct.brokerId);
    if (!adapter) throw new Error('Broker adapter not installed.');

    const snap = await adapter.getStatus(this.toContext(acct));
    const now = new Date().toISOString();
    const errLower = (snap.diagnostics?.lastConnectorError || snap.message || '').toLowerCase();
    const recentSyncAgeMs = acct.lastSyncedAt ? Date.now() - new Date(acct.lastSyncedAt).getTime() : Infinity;

    // A temporary timeout must NOT overwrite a healthy authenticated IQ Option session
    const isTransientUnreachableOnHealthy =
      acct.brokerId === 'iq_option' &&
      acct.connected &&
      !snap.connected &&
      !snap.diagnostics?.reachable &&
      recentSyncAgeMs < 90_000 &&
      (errLower.includes('timeout') || errLower.includes('timed out') || errLower.includes('aborted') || errLower.includes('busy') || errLower.includes('http 50'));

    if (isTransientUnreachableOnHealthy) {
      acct.lastCheckedAt = now;
      acct.lastError = `Temporary connector timeout (${snap.diagnostics?.lastConnectorError || 'delayed response'}); healthy session preserved.`;
      acct.updatedAt = now;
    } else {
      if (acct.brokerId === 'iq_option') {
        const snapType = (snap.accountType || '').trim().toUpperCase();
        const verifiedIq = snap.connected && (snapType === 'REAL' || snapType === 'PRACTICE');
        acct.connected = verifiedIq;
        acct.status = verifiedIq
          ? 'CONNECTED'
          : !snap.connectorConfigured
            ? 'NOT CONFIGURED'
            : !snap.diagnostics?.reachable
              ? 'GATEWAY OFFLINE'
              : snapType === 'UNVERIFIED'
                ? 'MODE UNVERIFIED'
                : snap.diagnostics?.lastConnectorError
                  ? 'AUTHENTICATION FAILED'
                  : 'GATEWAY ONLINE';
        acct.accountType = verifiedIq ? snapType : snapType === 'UNVERIFIED' ? 'UNVERIFIED' : null;
        acct.environment = verifiedIq && snapType === 'REAL' ? 'real' : 'demo';
      } else {
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
        acct.accountType = snap.connected ? (snap.accountType ?? acct.accountType) : null;
      }
      const nextBalance = toFiniteBalance(snap.balance);
      const nextEquity = toFiniteBalance(snap.equity) ?? nextBalance;
      // Preserve last valid balance if connected session had a temporary balance-read timeout
      acct.balance = acct.connected ? (nextBalance ?? acct.balance) : null;
      acct.equity = acct.connected ? (nextEquity ?? acct.equity ?? acct.balance) : null;
      acct.currency = snap.currency ?? acct.currency;
      acct.lastCheckedAt = now;
      if (acct.connected) acct.lastSyncedAt = now;
      acct.lastError = snap.diagnostics?.lastConnectorError || (acct.connected ? null : snap.message);
      acct.updatedAt = now;
      if (!acct.connected && store.activeAccountId === acct.id) {
        store.autoExecuteBrokerDemo = false;
      }
    }
    this.saveStore(userId, store, false);
    await this.persistStoreToSupabase(userId, store);
    void this.syncBrokerSummaryToSupabase(acct, snap);
    const pub = await this.toPublicAccount(acct, snap.diagnostics, snap);
    if (acct.brokerId === 'iq_option') {
      const authIqId = this.findAuthoritativeIqAccountId(store);
      pub.isAuthoritative = acct.id === authIqId;
      pub.isStaleDuplicate = acct.id !== authIqId && !acct.connected;
    }
    return pub;
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
    const store = await this.ensureHydrated(userId);
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
    const store = await this.ensureHydrated(userId);
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
    const store = await this.ensureHydrated(userId);
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
    const store = await this.ensureHydrated(userId);
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
    const store = await this.ensureHydrated(userId);
    const acct = store.accounts.find((a) => a.id === input.accountId);
    const fail = (reason: string, compatible = false): BrokerOrderValidationResult => ({
      valid: false,
      compatible,
      environment: acct?.environment ?? 'demo',
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
    if (!acct) {
      return fail('Selected broker account not found.');
    }
    this.rollAccountDay(acct);
    const adapter = this.registry.get(acct.brokerId);
    if (!adapter) {
      return fail('Broker adapter not installed.');
    }
    const ctx = this.toContext(acct);
    const caps = await adapter.getCapabilities(ctx);
    const supportsExecution =
      acct.environment === 'real' ? caps.liveOrderPlacementSupported : caps.demoOrderPlacementSupported;
    if (!supportsExecution) {
      return fail(`${adapter.brokerName} is read-only or unconfigured for ${acct.environment.toUpperCase()} order placement.`);
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
    const effectiveMaxStake = Math.min(100, limits.maxOrderAmount);
    if (input.amount > effectiveMaxStake) {
      return fail(`Stake ($${input.amount}) exceeds the maximum allowed stake of $${effectiveMaxStake} per individual trade.`, true);
    }
    if (acct.dailyOrdersCount >= limits.maxDailyOrders) {
      return fail(`Daily order cap (${limits.maxDailyOrders}) reached on ${acct.label}.`, true);
    }
    if (acct.dailySimulatedLoss >= limits.maxDailyLoss) {
      return fail(`Daily loss limit ($${limits.maxDailyLoss}) reached on ${acct.label}.`, true);
    }
    if (!acct.connected) {
      return fail(`${acct.label} is not connected. Connect the ${acct.environment.toUpperCase()} session to run terminal validation.`, true);
    }
    if (acct.brokerId === 'iq_option') {
      const iqType = (acct.accountType || '').trim().toUpperCase();
      if (iqType !== 'PRACTICE' && iqType !== 'REAL') {
        return fail('IQ Option active account mode is UNVERIFIED; live orders are blocked until mode is verified directly from IQ Option.', true);
      }
    }

    if (adapter.validateOrder) {
      const orderReq: BrokerOrderRequest = {
        environment: acct.environment,
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
      environment: acct.environment,
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

    const store = await this.ensureHydrated(userId);
    const acct = store.accounts.find((a) => a.id === input.accountId);
    if (!acct) {
      throw new Error('Selected broker account not found.');
    }
    this.rollAccountDay(acct);

    // 1. Validate account connection (execution destination strictly follows the user's selected account & environment)
    if (!acct.connected) {
      throw new Error(`${acct.label} is not connected. Connect the ${acct.environment.toUpperCase()} session first.`);
    }
    if (acct.brokerId === 'iq_option') {
      const iqType = (acct.accountType || '').trim().toUpperCase();
      if (iqType !== 'PRACTICE' && iqType !== 'REAL') {
        throw new Error('IQ Option active account mode is UNVERIFIED; live orders are blocked until mode is verified directly from IQ Option.');
      }
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

    const limits = acct.riskLimits;
    const effectiveMaxStake = Math.min(100, limits.maxOrderAmount);
    if (input.amount > effectiveMaxStake) {
      throw new Error(
        `Per-account risk limit: Stake ($${input.amount}) exceeds the maximum allowed stake of $${effectiveMaxStake} per individual trade.`
      );
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
    const supportsExecution =
      acct.environment === 'real' ? caps.liveOrderPlacementSupported : caps.demoOrderPlacementSupported;
    if (!supportsExecution || !adapter.placeOrder) {
      throw new Error(`${adapter.brokerName} is read-only or does not support ${acct.environment.toUpperCase()} order placement.`);
    }

    const compat = adapter.checkInstrumentCompatibility(input.symbol, input.assetClass, input.orderType, ctx);
    if (!compat.compatible || !compat.mappedSymbol) {
      throw new Error(`Instrument incompatibility: ${compat.reason}`);
    }

    // 4. Per-account risk limit checks
    if (input.direction === 'CALL' && !limits.allowCall) {
      throw new Error(`Per-account risk guard: CALL/BUY direction is disabled on ${acct.label}.`);
    }
    if (input.direction === 'PUT' && !limits.allowPut) {
      throw new Error(`Per-account risk guard: PUT/SELL direction is disabled on ${acct.label}.`);
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

    const effectiveOrderType: BrokerOrderType =
      acct.brokerId === 'iq_option' ? 'BINARY_FIXED_EXPIRY' : input.orderType;

    const orderPayload: BrokerOrderRequest = {
      environment: acct.environment,
      symbol: input.symbol,
      mappedSymbol: compat.mappedSymbol,
      assetClass: input.assetClass,
      direction: input.direction,
      orderType: effectiveOrderType,
      amount: input.amount,
      entryPrice: input.entryPrice,
      expirySeconds: input.expirySeconds,
      idempotencyKey,
    };

    // 4b. Pre-flight broker order validation & live active mode sync
    if (adapter.validateOrder) {
      const preflight = await adapter.validateOrder(ctx, orderPayload);
      if (!preflight.valid) {
        throw new Error(`Order validation failed: ${preflight.reason}`);
      }
      if (acct.brokerId === 'iq_option') {
        acct.environment = preflight.environment;
        acct.accountType = preflight.environment === 'real' ? 'REAL' : 'PRACTICE';
        orderPayload.environment = preflight.environment;
      }
    }

    // 5. Execute order on broker adapter (MT5 or IQ Option on verified live mode)
    const placement = await adapter.placeOrder(this.toContext(acct), orderPayload);

    const record: BrokerOrderRecord = {
      id: crypto.randomUUID(),
      userId,
      accountId: acct.id,
      brokerId: acct.brokerId,
      brokerName: adapter.brokerName,
      environment: acct.environment,
      symbol: input.symbol.toUpperCase(),
      mappedSymbol: placement.mappedSymbol,
      direction: input.direction,
      orderType: effectiveOrderType,
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
    this.saveStore(userId, store, false);
    await this.persistStoreToSupabase(userId, store);

    return { order: record, placement };
  }

  async closeAccountPosition(
    userId: string,
    accountId: string,
    brokerOrderId: string
  ): Promise<{
    closed: boolean;
    brokerOrderId: string;
    status: string;
    realizedPnl: number | null;
    mode?: string | null;
    message: string;
    closedAt?: string | null;
  }> {
    const store = await this.ensureHydrated(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) throw new Error('Broker account not found.');
    const adapter = this.registry.get(acct.brokerId);
    if (!adapter?.closePosition) {
      throw new Error(`${adapter?.brokerName || acct.brokerId} does not support closing open positions via API.`);
    }
    const res = await adapter.closePosition(this.toContext(acct), brokerOrderId);
    if (res.closed) {
      const ord = store.orders.find(
        (o) => o.accountId === accountId && String(o.brokerOrderId) === String(brokerOrderId)
      );
      if (ord) {
        ord.status = 'CLOSED';
        if (typeof res.realizedPnl === 'number' && Number.isFinite(res.realizedPnl)) {
          ord.realizedPnl = res.realizedPnl;
          if (res.realizedPnl < 0) {
            this.rollAccountDay(acct);
            acct.dailySimulatedLoss = Number((acct.dailySimulatedLoss + Math.abs(res.realizedPnl)).toFixed(2));
          }
        }
        ord.note = res.message;
        ord.reconciledAt = res.closedAt || new Date().toISOString();
      }
      this.saveStore(userId, store, false);
      await this.persistStoreToSupabase(userId, store);
    }
    return res;
  }

  async reconcileOrders(userId: string, accountId?: string): Promise<{ updatedCount: number; orders: BrokerOrderRecord[] }> {
    const store = await this.ensureHydrated(userId);
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

    if (updatedCount > 0) {
      this.saveStore(userId, store, false);
      await this.persistStoreToSupabase(userId, store);
    }
    return {
      updatedCount,
      orders: accountId ? store.orders.filter((o) => o.accountId === accountId) : store.orders,
    };
  }

  getSettledOrderLearnables(userId: string, accountId?: string): LearnableTradeRecord[] {
    const store = this.getStore(userId);
    const out: LearnableTradeRecord[] = [];
    for (const ord of store.orders) {
      if (accountId && ord.accountId !== accountId) continue;
      if (ord.status !== 'CLOSED' && ord.status !== 'FILLED') continue;
      if (typeof ord.realizedPnl !== 'number' || !Number.isFinite(ord.realizedPnl) || ord.realizedPnl === 0) continue;
      const acct = store.accounts.find((a) => a.id === ord.accountId);
      const brokerId = acct?.brokerId ?? ord.brokerId;
      const env = acct?.environment ?? ord.environment;
      const signalId = ord.idempotencyKey?.startsWith('auto-') ? ord.idempotencyKey.slice(5) : undefined;
      out.push({
        id: `broker-order:${ord.brokerId}:${ord.environment}:${ord.brokerOrderId || ord.id}`,
        brokerOrderId: `${ord.brokerId}:${ord.brokerOrderId || ord.id}`,
        signalId,
        symbol: ord.symbol,
        timeframe: '5m',
        direction: ord.direction,
        amount: Math.max(1, ord.amount),
        payoutRate: 0.8,
        entryPrice: ord.filledPrice ?? ord.entryPrice,
        exitPrice: null,
        status: ord.realizedPnl > 0 ? 'CLOSED_WIN' : 'CLOSED_LOSS',
        pnl: Number(ord.realizedPnl.toFixed(2)),
        signalScore: null,
        settledBy: 'broker-reconciliation',
        createdAt: ord.createdAt,
        closedAt: ord.reconciledAt || ord.createdAt,
        accountBucket: resolveAccountBucket(brokerId, env),
      });
    }
    return out;
  }

  private extractHistoryLearnables(
    acct: StoredAccountInternal,
    trades: Array<Record<string, unknown>>
  ): LearnableTradeRecord[] {
    const out: LearnableTradeRecord[] = [];
    const bucket = resolveAccountBucket(acct.brokerId, acct.environment);
    for (let i = 0; i < trades.length; i++) {
      const item = trades[i];
      if (!item || typeof item !== 'object') continue;
      const rawPnl = item.pnl ?? item.profit;
      const pnl = typeof rawPnl === 'number' ? rawPnl : Number(rawPnl);
      if (!Number.isFinite(pnl) || pnl === 0) continue;
      const symbol = String(item.symbol || item.active || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (!symbol) continue;

      const rawId = item.ticket ?? item.order_id ?? item.orderId ?? item.id ?? `${i}-${item.closed_at || item.time || ''}`;
      const extId = String(rawId).trim();
      if (!extId) continue;

      const rawDir = String(item.direction ?? item.side ?? item.type ?? 'CALL').toUpperCase();
      const direction: 'CALL' | 'PUT' =
        rawDir === 'PUT' || rawDir === 'SELL' || rawDir === '1' ? 'PUT' : 'CALL';
      const rawAmt = Number(item.amount ?? item.stake ?? item.volume ?? item.invest ?? 100);
      const amount = Number.isFinite(rawAmt) && rawAmt > 0 ? rawAmt : 100;
      const entryRaw = item.entryPrice ?? item.entry_price ?? item.open_price ?? item.openPrice;
      const exitRaw = item.exitPrice ?? item.exit_price ?? item.close_price ?? item.closePrice;
      const entryPrice = typeof entryRaw === 'number' && Number.isFinite(entryRaw) ? entryRaw : null;
      const exitPrice = typeof exitRaw === 'number' && Number.isFinite(exitRaw) ? exitRaw : null;
      const closedRaw = item.closedAt ?? item.closed_at ?? item.close_time ?? item.time;
      const closedAt =
        typeof closedRaw === 'number'
          ? new Date(closedRaw > 1e12 ? closedRaw : closedRaw * 1000).toISOString()
          : typeof closedRaw === 'string' && closedRaw
            ? closedRaw
            : new Date().toISOString();

      out.push({
        id: `broker-hist:${acct.brokerId}:${acct.environment}:${extId}`,
        brokerOrderId: `${acct.brokerId}:${extId}`,
        symbol,
        timeframe: '5m',
        direction,
        amount,
        payoutRate: 0.8,
        entryPrice,
        exitPrice,
        status: pnl > 0 ? 'CLOSED_WIN' : 'CLOSED_LOSS',
        pnl: Number(pnl.toFixed(2)),
        signalScore: null,
        settledBy: 'broker-history-sync',
        createdAt: closedAt,
        closedAt,
        accountBucket: bucket,
      });
    }
    return out;
  }

  async syncAccountTradeHistory(
    userId: string,
    accountId: string
  ): Promise<BrokerTradeHistoryResult & { learnedRecords: LearnableTradeRecord[] }> {
    const store = await this.ensureHydrated(userId);
    const acct = store.accounts.find((a) => a.id === accountId);
    if (!acct) throw new Error('Broker account not found.');
    const adapter = this.registry.get(acct.brokerId);
    if (!adapter) throw new Error('Broker adapter missing.');
    const res = await adapter.getTradeHistory(this.toContext(acct));
    acct.lastSyncedAt = new Date().toISOString();
    this.saveStore(userId, store, false);
    await this.persistStoreToSupabase(userId, store);
    const learnedRecords = res.supported ? this.extractHistoryLearnables(acct, res.trades) : [];
    return { ...res, learnedRecords };
  }

  listOrders(userId: string, accountId?: string): BrokerOrderRecord[] {
    const store = this.getStore(userId);
    return accountId ? store.orders.filter((o) => o.accountId === accountId) : store.orders;
  }
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSupabaseAdmin, getSupabaseServerConfig } from './supabaseAdmin.ts';
import {
  ANDROID_TRADING_PACKAGES,
  type AndroidAccountMode,
  type AndroidScreenVisionResult,
  type AndroidTradingAppName,
} from './androidVision.ts';
import type { OperatingMode, RiskStatus, StoredSignal } from './tradingEngine.ts';

export type AndroidDeviceStatus = 'PAIRED_PENDING' | 'ACTIVE' | 'PAUSED' | 'REVOKED';

export interface AndroidDevicePermissions {
  mediaProjection: boolean;
  accessibility: boolean;
  allowMt5: boolean;
  allowIqOption: boolean;
  assistedApprovalRequired: boolean;
  realMoneyBlocked: true;
}

interface AndroidDeviceInternal {
  id: string;
  userId: string;
  deviceName: string;
  deviceModel: string | null;
  osVersion: string | null;
  pairingCodeHash: string | null;
  pairingExpiresAt: string | null;
  deviceTokenHash: string | null;
  tokenPrefix: string | null;
  permissions: AndroidDevicePermissions;
  targetPackages: string[];
  status: AndroidDeviceStatus;
  lastAppPackage: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  status: AndroidDeviceStatus;
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
  appName: AndroidTradingAppName;
  detectedSymbol: string | null;
  normalizedSymbol: string | null;
  detectedTimeframe: string | null;
  detectedPrice: number | null;
  detectedAccountMode: AndroidAccountMode;
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

export type AndroidActionStatus =
  | 'PENDING_USER_APPROVAL'
  | 'AUTHORIZED'
  | 'DISPATCHED_TO_DEVICE'
  | 'EXECUTED_REPORTED'
  | 'REJECTED'
  | 'BLOCKED_RISK'
  | 'BLOCKED_UNVERIFIED_ACCOUNT'
  | 'EXPIRED';

export type AndroidAccountModeVerificationSource = 'BROKER_SESSION' | 'MT5_BRIDGE' | 'IQ_CONNECTOR' | 'UNVERIFIED';

export interface VerifiedBrokerAccountSession {
  verified: boolean;
  mode: AndroidAccountMode;
  source: AndroidAccountModeVerificationSource;
  brokerAccountId: string | null;
  reason?: string;
}

export interface AndroidActionQueueItem {
  id: string;
  userId: string;
  deviceId: string | null;
  screenAnalysisId: string | null;
  appPackage: string;
  appName: AndroidTradingAppName;
  operatingMode: OperatingMode;
  symbol: string;
  direction: 'CALL' | 'PUT';
  stakeOrVolume: number;
  expirySeconds: number;
  accountModeVerified: AndroidAccountMode;
  accountModeVerificationSource: AndroidAccountModeVerificationSource;
  verifiedBrokerAccountId: string | null;
  status: AndroidActionStatus;
  reason: string;
  expiresAt: string | null;
  approvedAt: string | null;
  executedAt: string | null;
  deviceAckNote: string | null;
  createdAt: string;
}

interface AndroidUserStore {
  devices: AndroidDeviceInternal[];
  analyses: AndroidScreenAnalysisRecord[];
  actions: AndroidActionQueueItem[];
}

function hashSecret(secret: string): string {
  const bridgeSecret = (process.env.ANDROID_BRIDGE_SECRET ?? '').trim();
  if (!bridgeSecret) {
    throw new Error('ANDROID_BRIDGE_SECRET environment variable is required for Android pairing and device token hashing.');
  }
  if (Buffer.byteLength(bridgeSecret, 'utf8') < 32) {
    throw new Error('ANDROID_BRIDGE_SECRET must be at least 32 bytes.');
  }
  return crypto.createHmac('sha256', bridgeSecret).update(secret).digest('hex');
}

function timingSafeHexMatch(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function toPublicDevice(d: AndroidDeviceInternal): AndroidDevicePublic {
  return {
    id: d.id,
    userId: d.userId,
    deviceName: d.deviceName,
    deviceModel: d.deviceModel,
    osVersion: d.osVersion,
    pairingExpiresAt: d.pairingExpiresAt,
    tokenPrefix: d.tokenPrefix,
    permissions: {
      ...d.permissions,
      realMoneyBlocked: true,
    },
    targetPackages: d.targetPackages,
    status: d.status,
    lastAppPackage: d.lastAppPackage,
    lastSeenAt: d.lastSeenAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export class AndroidCompanionManager {
  private readonly persistDir: string | null;
  private readonly stores = new Map<string, AndroidUserStore>();
  private readonly hydratedHistoryUsers = new Set<string>();
  private lastPersistenceError: string | null = null;

  constructor(statePersistPath: string | null) {
    const effectivePath = process.env.NODE_ENV === 'production' ? null : statePersistPath;
    this.persistDir = effectivePath ? path.join(path.dirname(effectivePath), 'android') : null;
    this.preloadPersistedStores();
  }

  getLastPersistenceError(): string | null {
    return this.lastPersistenceError;
  }

  private getStorePath(userId: string): string | null {
    if (!this.persistDir) return null;
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.persistDir, `${safeId}.json`);
  }

  private preloadPersistedStores() {
    if (!this.persistDir) return;
    try {
      if (!fs.existsSync(this.persistDir)) return;
      for (const file of fs.readdirSync(this.persistDir)) {
        if (!file.endsWith('.json')) continue;
        const userId = file.replace(/\.json$/, '');
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(this.persistDir, file), 'utf8')) as Partial<AndroidUserStore>;
          this.stores.set(userId, {
            devices: Array.isArray(parsed.devices) ? parsed.devices : [],
            analyses: Array.isArray(parsed.analyses) ? parsed.analyses : [],
            actions: Array.isArray(parsed.actions) ? parsed.actions : [],
          });
        } catch {
          // Ignore corrupt local file
        }
      }
    } catch {
      // Ignore directory read failure
    }
  }

  private getOrInitStore(userId: string): AndroidUserStore {
    let store = this.stores.get(userId);
    if (store) return store;
    const fp = this.getStorePath(userId);
    if (fp && fs.existsSync(fp)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as Partial<AndroidUserStore>;
        store = {
          devices: Array.isArray(parsed.devices) ? parsed.devices : [],
          analyses: Array.isArray(parsed.analyses) ? parsed.analyses : [],
          actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        };
        this.stores.set(userId, store);
        return store;
      } catch {
        // Fallback to clean store
      }
    }
    store = { devices: [], analyses: [], actions: [] };
    this.stores.set(userId, store);
    return store;
  }

  private saveStore(userId: string) {
    const fp = this.getStorePath(userId);
    if (!fp) return;
    const store = this.stores.get(userId);
    if (!store) return;
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const tmp = `${fp}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
      fs.renameSync(tmp, fp);
    } catch {
      // Non-fatal
    }
  }

  private expireStaleActions(store: AndroidUserStore) {
    const nowMs = Date.now();
    for (const action of store.actions) {
      if (
        (action.status === 'PENDING_USER_APPROVAL' || action.status === 'AUTHORIZED') &&
        action.expiresAt &&
        new Date(action.expiresAt).getTime() <= nowMs
      ) {
        action.status = 'EXPIRED';
      }
    }
  }

  async createPairingRequest(
    userId: string,
    input: { deviceName: string; allowMt5?: boolean; allowIqOption?: boolean }
  ): Promise<{ device: AndroidDevicePublic; pairingCode: string; expiresAt: string }> {
    const sbCfg = getSupabaseServerConfig();
    if (userId === 'local-preview' && sbCfg.clientAuthConfigured) {
      throw new Error('Authenticated Supabase session required for Android pairing.');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const pairingCode = generatePairingCode();
    const pairingCodeHash = hashSecret(pairingCode);
    const allowMt5 = input.allowMt5 !== false;
    const allowIqOption = input.allowIqOption !== false;
    const targetPackages = [
      ...(allowMt5 ? [ANDROID_TRADING_PACKAGES.MT5] : []),
      ...(allowIqOption ? [ANDROID_TRADING_PACKAGES.IQ_OPTION] : []),
    ];

    const device: AndroidDeviceInternal = {
      id: crypto.randomUUID(),
      userId,
      deviceName: input.deviceName.trim().slice(0, 60) || 'Android Trading Phone',
      deviceModel: null,
      osVersion: null,
      pairingCodeHash,
      pairingExpiresAt: expiresAt,
      deviceTokenHash: null,
      tokenPrefix: null,
      permissions: {
        mediaProjection: false,
        accessibility: false,
        allowMt5,
        allowIqOption,
        assistedApprovalRequired: true,
        realMoneyBlocked: true,
      },
      targetPackages,
      status: 'PAIRED_PENDING',
      lastAppPackage: null,
      lastSeenAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const admin = getSupabaseAdmin();
    if (userId !== 'local-preview') {
      if (!admin) {
        throw new Error('Supabase service_role client is not configured; cannot persist pairing request.');
      }
      const { error } = await admin.from('android_devices').insert({
        id: device.id,
        user_id: userId,
        device_name: device.deviceName,
        pairing_code_hash: pairingCodeHash,
        pairing_expires_at: expiresAt,
        permissions: device.permissions,
        target_packages: device.targetPackages,
        status: 'PAIRED_PENDING',
        created_at: device.createdAt,
        updated_at: device.updatedAt,
      });

      if (error) {
        throw new Error(`Failed to persist pairing request to Supabase: ${error.message}`);
      }
    }

    const store = this.getOrInitStore(userId);
    store.devices.unshift(device);
    if (store.devices.length > 20) store.devices.length = 20;
    this.saveStore(userId);

    return {
      device: toPublicDevice(device),
      pairingCode,
      expiresAt,
    };
  }

  async registerDeviceWithPairingCode(input: {
    pairingCode: string;
    deviceName?: string;
    deviceModel?: string;
    osVersion?: string;
    mediaProjectionGranted?: boolean;
    accessibilityGranted?: boolean;
  }): Promise<{ device: AndroidDevicePublic; deviceToken: string } | null> {
    const cleanCode = input.pairingCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!cleanCode) return null;
    const candidateHash = hashSecret(cleanCode);

    const sbCfg = getSupabaseServerConfig();
    const admin = getSupabaseAdmin();

    if (!admin) {
      // Never fall back to local pairing if Supabase auth/production is configured
      if (sbCfg.clientAuthConfigured) {
        throw new Error('Supabase admin service role is required for secure device pairing.');
      }
      // Isolated local-preview pairing only when Supabase is unconfigured
      const previewStore = this.getOrInitStore('local-preview');
      const nowMs = Date.now();
      for (const dev of previewStore.devices) {
        if (dev.status !== 'PAIRED_PENDING' || !dev.pairingCodeHash) continue;
        if (dev.pairingExpiresAt && new Date(dev.pairingExpiresAt).getTime() <= nowMs) continue;
        if (!timingSafeHexMatch(dev.pairingCodeHash, candidateHash)) continue;

        const rawToken = `nt_dev_${crypto.randomBytes(24).toString('hex')}`;
        dev.deviceTokenHash = hashSecret(rawToken);
        dev.tokenPrefix = rawToken.slice(0, 12);
        dev.pairingCodeHash = null;
        dev.pairingExpiresAt = null;
        if (input.deviceName?.trim()) dev.deviceName = input.deviceName.trim().slice(0, 60);
        if (input.deviceModel?.trim()) dev.deviceModel = input.deviceModel.trim().slice(0, 80);
        if (input.osVersion?.trim()) dev.osVersion = input.osVersion.trim().slice(0, 40);
        if (typeof input.mediaProjectionGranted === 'boolean') {
          dev.permissions.mediaProjection = input.mediaProjectionGranted;
        }
        if (typeof input.accessibilityGranted === 'boolean') {
          dev.permissions.accessibility = input.accessibilityGranted;
        }
        dev.permissions.realMoneyBlocked = true;
        dev.status = 'ACTIVE';
        dev.lastSeenAt = new Date().toISOString();
        dev.updatedAt = dev.lastSeenAt;
        this.saveStore('local-preview');
        return { device: toPublicDevice(dev), deviceToken: rawToken };
      }
      return null;
    }

    const rawToken = `nt_dev_${crypto.randomBytes(24).toString('hex')}`;
    const tokenHash = hashSecret(rawToken);
    const tokenPrefix = rawToken.slice(0, 12);

    const { data: updatedDev, error } = await admin.rpc('redeem_android_pairing_code', {
      p_pairing_code_hash: candidateHash,
      p_device_name: input.deviceName || 'Android Trading Phone',
      p_device_model: input.deviceModel || null,
      p_os_version: input.osVersion || null,
      p_media_projection: input.mediaProjectionGranted ?? false,
      p_accessibility: input.accessibilityGranted ?? false,
      p_token_hash: tokenHash,
      p_token_prefix: tokenPrefix,
    });

    if (error) {
      throw new Error(`Database error during pairing redemption: ${error.message}`);
    }

    if (!updatedDev) {
      return null; // Invalid or expired pairing code, or already redeemed
    }

    const dbDev = typeof updatedDev === 'string' ? JSON.parse(updatedDev) : updatedDev;
    const deviceInternal: AndroidDeviceInternal = {
      id: dbDev.id,
      userId: dbDev.user_id,
      deviceName: dbDev.device_name,
      deviceModel: dbDev.device_model,
      osVersion: dbDev.os_version,
      pairingCodeHash: null,
      pairingExpiresAt: null,
      deviceTokenHash: dbDev.device_token_hash,
      tokenPrefix: dbDev.token_prefix,
      permissions: {
        ...(dbDev.permissions || {}),
        realMoneyBlocked: true,
      },
      targetPackages: dbDev.target_packages || [],
      status: dbDev.status,
      lastAppPackage: dbDev.last_app_package,
      lastSeenAt: dbDev.last_seen_at,
      createdAt: dbDev.created_at,
      updatedAt: dbDev.updated_at,
    };

    const store = this.getOrInitStore(deviceInternal.userId);
    const idx = store.devices.findIndex((d) => d.id === deviceInternal.id);
    if (idx >= 0) {
      store.devices[idx] = deviceInternal;
    } else {
      store.devices.unshift(deviceInternal);
    }
    this.saveStore(deviceInternal.userId);

    return { device: toPublicDevice(deviceInternal), deviceToken: rawToken };
  }

  async authenticateDeviceToken(authHeader?: string): Promise<{ userId: string; device: AndroidDeviceInternal } | null> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7).trim();
    if (!token.startsWith('nt_dev_') || token.length < 24) return null;
    const candidateHash = hashSecret(token);

    const sbCfg = getSupabaseServerConfig();
    const admin = getSupabaseAdmin();

    if (admin) {
      const { data: matchedDevs, error } = await admin
        .from('android_devices')
        .select('*')
        .eq('device_token_hash', candidateHash)
        .neq('status', 'REVOKED')
        .limit(1);

      if (error) {
        throw new Error(`Database error validating device token: ${error.message}`);
      }

      if (matchedDevs && matchedDevs.length > 0) {
        const dbDev = matchedDevs[0];
        const userId = dbDev.user_id;
        const deviceInternal: AndroidDeviceInternal = {
          id: dbDev.id,
          userId,
          deviceName: dbDev.device_name,
          deviceModel: dbDev.device_model,
          osVersion: dbDev.os_version,
          pairingCodeHash: dbDev.pairing_code_hash,
          pairingExpiresAt: dbDev.pairing_expires_at,
          deviceTokenHash: dbDev.device_token_hash,
          tokenPrefix: dbDev.token_prefix,
          permissions: {
            ...(dbDev.permissions || {}),
            realMoneyBlocked: true,
          },
          targetPackages: dbDev.target_packages || [],
          status: dbDev.status,
          lastAppPackage: dbDev.last_app_package,
          lastSeenAt: dbDev.last_seen_at,
          createdAt: dbDev.created_at,
          updatedAt: dbDev.updated_at,
        };

        const store = this.getOrInitStore(userId);
        const idx = store.devices.findIndex((d) => d.id === deviceInternal.id);
        if (idx >= 0) {
          store.devices[idx] = deviceInternal;
        } else {
          store.devices.unshift(deviceInternal);
        }
        this.saveStore(userId);

        return { userId, device: deviceInternal };
      }

      return null;
    }

    if (sbCfg.clientAuthConfigured) {
      throw new Error('Supabase admin service role is required to authenticate paired Android devices.');
    }

    // Isolated local-preview token verification when Supabase is unconfigured
    const previewStore = this.getOrInitStore('local-preview');
    for (const dev of previewStore.devices) {
      if (dev.status === 'REVOKED' || !dev.deviceTokenHash) continue;
      if (timingSafeHexMatch(dev.deviceTokenHash, candidateHash)) {
        return { userId: 'local-preview', device: dev };
      }
    }

    return null;
  }

  async listDevices(userId: string): Promise<AndroidDevicePublic[]> {
    const admin = getSupabaseAdmin();
    if (userId !== 'local-preview') {
      if (!admin) {
        throw new Error('Supabase admin service role is required to list paired Android devices.');
      }
      const { data: dbDevs, error } = await admin
        .from('android_devices')
        .select('*')
        .eq('user_id', userId)
        .neq('status', 'REVOKED')
        .order('created_at', { ascending: false });

      if (error) {
        throw new Error(`Failed to load paired Android devices from Supabase: ${error.message}`);
      }

      const store = this.getOrInitStore(userId);
      store.devices = (dbDevs || []).map((dbDev: Record<string, any>) => ({
        id: dbDev.id,
        userId: dbDev.user_id,
        deviceName: dbDev.device_name,
        deviceModel: dbDev.device_model,
        osVersion: dbDev.os_version,
        pairingCodeHash: dbDev.pairing_code_hash,
        pairingExpiresAt: dbDev.pairing_expires_at,
        deviceTokenHash: dbDev.device_token_hash,
        tokenPrefix: dbDev.token_prefix,
        permissions: {
          ...(dbDev.permissions || {}),
          realMoneyBlocked: true,
        },
        targetPackages: dbDev.target_packages || [],
        status: dbDev.status,
        lastAppPackage: dbDev.last_app_package,
        lastSeenAt: dbDev.last_seen_at,
        createdAt: dbDev.created_at,
        updatedAt: dbDev.updated_at,
      }));
      this.saveStore(userId);
    }

    const store = this.getOrInitStore(userId);
    const nowMs = Date.now();
    let changed = false;
    for (const d of store.devices) {
      if (d.status === 'PAIRED_PENDING' && d.pairingExpiresAt && new Date(d.pairingExpiresAt).getTime() <= nowMs) {
        d.status = 'PAUSED';
        d.pairingCodeHash = null;
        changed = true;
      }
    }
    if (changed) this.saveStore(userId);
    return store.devices.filter((d) => d.status !== 'REVOKED').map(toPublicDevice);
  }

  async updateDevicePermissions(
    userId: string,
    deviceId: string,
    patch: {
      status?: 'ACTIVE' | 'PAUSED';
      allowMt5?: boolean;
      allowIqOption?: boolean;
      mediaProjection?: boolean;
      accessibility?: boolean;
      assistedApprovalRequired?: boolean;
      lastAppPackage?: string | null;
    }
  ): Promise<AndroidDevicePublic | null> {
    if (userId !== 'local-preview') {
      await this.listDevices(userId);
    }
    const store = this.getOrInitStore(userId);
    const dev = store.devices.find((d) => d.id === deviceId && d.status !== 'REVOKED');
    if (!dev) return null;
    if (patch.status && dev.deviceTokenHash) dev.status = patch.status;
    if (typeof patch.allowMt5 === 'boolean') dev.permissions.allowMt5 = patch.allowMt5;
    if (typeof patch.allowIqOption === 'boolean') dev.permissions.allowIqOption = patch.allowIqOption;
    if (typeof patch.mediaProjection === 'boolean') dev.permissions.mediaProjection = patch.mediaProjection;
    if (typeof patch.accessibility === 'boolean') dev.permissions.accessibility = patch.accessibility;
    if (typeof patch.assistedApprovalRequired === 'boolean') {
      dev.permissions.assistedApprovalRequired = patch.assistedApprovalRequired;
    }
    dev.permissions.realMoneyBlocked = true;
    dev.targetPackages = [
      ...(dev.permissions.allowMt5 ? [ANDROID_TRADING_PACKAGES.MT5] : []),
      ...(dev.permissions.allowIqOption ? [ANDROID_TRADING_PACKAGES.IQ_OPTION] : []),
    ];
    if (patch.lastAppPackage !== undefined) dev.lastAppPackage = patch.lastAppPackage;
    dev.updatedAt = new Date().toISOString();

    const admin = getSupabaseAdmin();
    if (userId !== 'local-preview') {
      if (!admin) {
        throw new Error('Supabase admin service role is required to update device permissions.');
      }
      const { error } = await admin
        .from('android_devices')
        .update({
          permissions: dev.permissions,
          target_packages: dev.targetPackages,
          status: dev.status,
          last_app_package: dev.lastAppPackage,
          updated_at: dev.updatedAt,
        })
        .eq('id', dev.id)
        .eq('user_id', userId);
      if (error) {
        throw new Error(`Failed to update device permissions in Supabase: ${error.message}`);
      }
    }

    this.saveStore(userId);
    return toPublicDevice(dev);
  }

  async revokeDevice(userId: string, deviceId: string): Promise<boolean> {
    if (userId !== 'local-preview') {
      await this.listDevices(userId);
    }
    const store = this.getOrInitStore(userId);
    const dev = store.devices.find((d) => d.id === deviceId && d.status !== 'REVOKED');
    if (!dev) return false;
    dev.status = 'REVOKED';
    dev.updatedAt = new Date().toISOString();

    const admin = getSupabaseAdmin();
    if (userId !== 'local-preview') {
      if (!admin) {
        throw new Error('Supabase admin service role is required to revoke device.');
      }
      const { error } = await admin
        .from('android_devices')
        .update({
          status: 'REVOKED',
          updated_at: dev.updatedAt,
        })
        .eq('id', deviceId)
        .eq('user_id', userId);
      if (error) {
        throw new Error(`Failed to revoke device in Supabase: ${error.message}`);
      }
    }

    this.saveStore(userId);
    return true;
  }

  private async ensureUserHistoryLoaded(userId: string): Promise<void> {
    if (!userId || userId === 'local-preview' || this.hydratedHistoryUsers.has(userId)) return;
    const admin = getSupabaseAdmin();
    if (!admin) return;
    try {
      const [analysesRes, actionsRes] = await Promise.all([
        admin
          .from('android_screen_analyses')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(50),
        admin
          .from('android_action_queue')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(60),
      ]);
      if (analysesRes.error || actionsRes.error) {
        const msg = analysesRes.error?.message || actionsRes.error?.message || 'Supabase history load failed';
        this.lastPersistenceError = msg;
        console.error('[AndroidCompanionManager] Failed to load Android history from Supabase:', msg);
        return;
      }
      const store = this.getOrInitStore(userId);
      if (Array.isArray(analysesRes.data) && analysesRes.data.length > 0) {
        const seenA = new Set(store.analyses.map((a) => a.id));
        for (const row of analysesRes.data as Array<Record<string, any>>) {
          if (!row.id || seenA.has(row.id)) continue;
          const qcc = (row.quant_cross_check || {}) as Record<string, any>;
          const rawExt = (row.raw_extraction || {}) as Record<string, any>;
          store.analyses.push({
            id: String(row.id),
            userId: String(row.user_id),
            deviceId: row.device_id ? String(row.device_id) : null,
            appPackage: String(row.app_package || 'unknown'),
            appName: (row.app_name || 'UNKNOWN') as AndroidTradingAppName,
            detectedSymbol: row.detected_symbol ? String(row.detected_symbol) : null,
            normalizedSymbol: row.normalized_symbol ? String(row.normalized_symbol) : null,
            detectedTimeframe: row.detected_timeframe ? String(row.detected_timeframe) : null,
            detectedPrice: row.detected_price != null ? Number(row.detected_price) : null,
            detectedAccountMode: (row.detected_account_mode || 'UNKNOWN') as AndroidAccountMode,
            detectedBalance: row.detected_balance != null ? Number(row.detected_balance) : null,
            detectedCurrency: row.detected_currency ? String(row.detected_currency) : null,
            chartTrend: (row.chart_trend || 'UNCLEAR') as AndroidScreenAnalysisRecord['chartTrend'],
            visionSummary: String(row.vision_summary || ''),
            riskWarning: row.risk_warning ? String(row.risk_warning) : null,
            recommendedAction: (row.recommended_action || 'WAIT') as 'CALL' | 'PUT' | 'WAIT',
            confidenceScore: Number(row.confidence_score ?? 0),
            signalId: row.signal_id ? String(row.signal_id) : null,
            quantDirection: qcc.direction ?? null,
            quantScore: qcc.score != null ? Number(qcc.score) : null,
            quantProvider: qcc.provider ?? null,
            alignmentStatus: (qcc.alignmentStatus || 'VISION_ONLY') as AndroidScreenAnalysisRecord['alignmentStatus'],
            candlestickObservations: Array.isArray(rawExt.candlestickObservations) ? rawExt.candlestickObservations : [],
            tradeButtonsVisible: Boolean(rawExt.tradeButtonsVisible),
            detectedActionLabels: Array.isArray(rawExt.detectedActionLabels) ? rawExt.detectedActionLabels : [],
            createdAt: String(row.created_at),
          });
        }
        store.analyses.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        if (store.analyses.length > 50) store.analyses.length = 50;
      }
      if (Array.isArray(actionsRes.data) && actionsRes.data.length > 0) {
        const seenQ = new Set(store.actions.map((a) => a.id));
        for (const row of actionsRes.data as Array<Record<string, any>>) {
          if (!row.id || seenQ.has(row.id)) continue;
          const rawStatus = String(row.status || 'PENDING_USER_APPROVAL');
          const status: AndroidActionStatus =
            rawStatus === 'BLOCKED_REAL_MONEY_LOCK'
              ? 'BLOCKED_RISK'
              : (rawStatus as AndroidActionStatus);
          store.actions.push({
            id: String(row.id),
            userId: String(row.user_id),
            deviceId: row.device_id ? String(row.device_id) : null,
            screenAnalysisId: row.screen_analysis_id ? String(row.screen_analysis_id) : null,
            appPackage: String(row.app_package || 'unknown'),
            appName: (row.app_name || 'UNKNOWN') as AndroidTradingAppName,
            operatingMode: (row.operating_mode || 'assisted') as OperatingMode,
            symbol: String(row.symbol || 'UNKNOWN'),
            direction: row.direction === 'PUT' ? 'PUT' : 'CALL',
            stakeOrVolume: Number(row.stake_or_volume ?? 0),
            expirySeconds: Number(row.expiry_seconds ?? 180),
            accountModeVerified: (row.account_mode_verified || 'UNKNOWN') as AndroidAccountMode,
            accountModeVerificationSource: (row.account_mode_verification_source || 'UNVERIFIED') as AndroidAccountModeVerificationSource,
            verifiedBrokerAccountId: row.verified_broker_account_id ? String(row.verified_broker_account_id) : null,
            status,
            reason: String(row.reason || ''),
            expiresAt: row.expires_at ? String(row.expires_at) : null,
            approvedAt: row.approved_at ? String(row.approved_at) : null,
            executedAt: row.executed_at ? String(row.executed_at) : null,
            deviceAckNote: row.device_ack_note ? String(row.device_ack_note) : null,
            createdAt: String(row.created_at),
          });
        }
        store.actions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        if (store.actions.length > 60) store.actions.length = 60;
      }
      this.hydratedHistoryUsers.add(userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Android history hydration exception';
      this.lastPersistenceError = msg;
      console.error('[AndroidCompanionManager] History hydration exception:', msg);
    }
  }

  async listAnalyses(userId: string): Promise<AndroidScreenAnalysisRecord[]> {
    await this.ensureUserHistoryLoaded(userId);
    const store = this.getOrInitStore(userId);
    return store.analyses;
  }

  async listActions(userId: string): Promise<AndroidActionQueueItem[]> {
    await this.ensureUserHistoryLoaded(userId);
    const store = this.getOrInitStore(userId);
    this.expireStaleActions(store);
    return store.actions;
  }

  async recordDeviceHeartbeat(userId: string, deviceId: string, appPackage?: string | null, permissionsPatch?: Partial<AndroidDevicePermissions>) {
    const store = this.getOrInitStore(userId);
    const dev = store.devices.find((d) => d.id === deviceId && d.status !== 'REVOKED');
    if (!dev) return null;
    const now = new Date().toISOString();
    dev.lastSeenAt = now;
    dev.updatedAt = now;
    if (appPackage !== undefined) dev.lastAppPackage = appPackage;
    if (permissionsPatch) {
      if (typeof permissionsPatch.mediaProjection === 'boolean') dev.permissions.mediaProjection = permissionsPatch.mediaProjection;
      if (typeof permissionsPatch.accessibility === 'boolean') dev.permissions.accessibility = permissionsPatch.accessibility;
    }
    this.saveStore(userId);

    const admin = getSupabaseAdmin();
    if (admin && userId !== 'local-preview') {
      const { error } = await admin
        .from('android_devices')
        .update({
          last_seen_at: dev.lastSeenAt,
          last_app_package: dev.lastAppPackage,
          permissions: dev.permissions,
          updated_at: dev.updatedAt,
        })
        .eq('id', dev.id);
      if (error) {
        this.lastPersistenceError = `Failed to persist Android device heartbeat: ${error.message}`;
        console.error('[AndroidCompanionManager]', this.lastPersistenceError);
        throw new Error(this.lastPersistenceError);
      }
      this.lastPersistenceError = null;
    }

    return toPublicDevice(dev);
  }

  async recordScreenAnalysis(input: {
    userId: string;
    deviceId: string | null;
    vision: AndroidScreenVisionResult;
    quantSignal?: StoredSignal | null;
  }): Promise<AndroidScreenAnalysisRecord> {
    const store = this.getOrInitStore(input.userId);
    let alignmentStatus: AndroidScreenAnalysisRecord['alignmentStatus'] = 'VISION_ONLY';
    const quantSignal = input.quantSignal;
    if (quantSignal) {
      const vDir = input.vision.visualBias;
      const qDir = quantSignal.direction;
      if (vDir === 'WAIT' || qDir === 'WAIT') {
        alignmentStatus = 'NO_TRADE';
      } else if (vDir === qDir) {
        alignmentStatus = 'ALIGNED';
      } else {
        alignmentStatus = 'CONFLICT';
      }
    }

    const record: AndroidScreenAnalysisRecord = {
      id: crypto.randomUUID(),
      userId: input.userId,
      deviceId: input.deviceId,
      appPackage: input.vision.appPackage,
      appName: input.vision.appName,
      detectedSymbol: input.vision.detectedSymbol,
      normalizedSymbol: input.vision.normalizedSymbol,
      detectedTimeframe: input.vision.detectedTimeframeRaw,
      detectedPrice: input.vision.detectedPrice,
      detectedAccountMode: input.vision.accountMode,
      detectedBalance: input.vision.detectedBalance,
      detectedCurrency: input.vision.detectedCurrency,
      chartTrend: input.vision.chartTrend,
      visionSummary: input.vision.summary,
      riskWarning: input.vision.riskWarning,
      recommendedAction: input.vision.visualBias,
      confidenceScore: input.vision.visualConfidence,
      signalId: quantSignal?.id || null,
      quantDirection: quantSignal?.direction || null,
      quantScore: quantSignal?.score || null,
      quantProvider: quantSignal?.provider || null,
      alignmentStatus,
      candlestickObservations: input.vision.candlestickObservations,
      tradeButtonsVisible: input.vision.tradeButtonsVisible,
      detectedActionLabels: input.vision.detectedActionLabels,
      createdAt: new Date().toISOString(),
    };

    const admin = getSupabaseAdmin();
    let verifiedSignalId: string | null = null;
    if (admin && input.userId !== 'local-preview' && record.signalId) {
      try {
        const { data: sigMatch, error: sigErr } = await admin
          .from('trading_signals')
          .select('id')
          .eq('id', record.signalId)
          .maybeSingle();
        if (!sigErr && sigMatch) {
          verifiedSignalId = record.signalId;
        }
      } catch (_e) {
        verifiedSignalId = null;
      }
    }

    if (admin && input.userId !== 'local-preview') {
      const { error } = await admin.from('android_screen_analyses').insert({
        id: record.id,
        user_id: record.userId,
        device_id: record.deviceId,
        app_package: record.appPackage,
        app_name: record.appName,
        detected_symbol: record.detectedSymbol,
        normalized_symbol: record.normalizedSymbol,
        detected_timeframe: record.detectedTimeframe,
        detected_price: record.detectedPrice,
        detected_account_mode: record.detectedAccountMode,
        detected_balance: record.detectedBalance,
        detected_currency: record.detectedCurrency,
        chart_trend: record.chartTrend,
        vision_summary: record.visionSummary,
        risk_warning: record.riskWarning,
        recommended_action: record.recommendedAction,
        confidence_score: record.confidenceScore,
        signal_id: verifiedSignalId,
        quant_cross_check: quantSignal
          ? {
              direction: quantSignal.direction,
              score: quantSignal.score,
              provider: quantSignal.provider,
              alignmentStatus,
            }
          : {},
        raw_extraction: {
          candlestickObservations: record.candlestickObservations,
          tradeButtonsVisible: record.tradeButtonsVisible,
          detectedActionLabels: record.detectedActionLabels,
        },
        created_at: record.createdAt,
      });
      if (error) {
        this.lastPersistenceError = `Failed to persist Android screen analysis: ${error.message}`;
        console.error('[AndroidCompanionManager]', this.lastPersistenceError);
        throw new Error(this.lastPersistenceError);
      }
      this.lastPersistenceError = null;
    }

    store.analyses.unshift(record);
    if (store.analyses.length > 50) store.analyses.length = 50;
    this.saveStore(input.userId);
    return record;
  }

  async queueActionFromScreen(input: {
    userId: string;
    deviceId: string | null;
    analysis: AndroidScreenAnalysisRecord;
    operatingMode: OperatingMode;
    stakeOrVolume: number;
    expirySeconds: number;
    riskStatus: RiskStatus;
    verifiedBrokerSession?: VerifiedBrokerAccountSession;
  }): Promise<AndroidActionQueueItem | null> {
    if (input.analysis.recommendedAction !== 'CALL' && input.analysis.recommendedAction !== 'PUT') {
      return null;
    }
    const store = this.getOrInitStore(input.userId);
    this.expireStaleActions(store);

    const session = input.verifiedBrokerSession;
    const isVerified = Boolean(
      session?.verified &&
        session.source !== 'UNVERIFIED' &&
        (session.mode === 'DEMO' || session.mode === 'PRACTICE' || session.mode === 'REAL')
    );
    const accountModeVerified: AndroidAccountMode = isVerified ? session!.mode : 'UNKNOWN';
    const accountModeVerificationSource: AndroidAccountModeVerificationSource = isVerified
      ? session!.source
      : 'UNVERIFIED';
    const verifiedBrokerAccountId: string | null = isVerified ? session!.brokerAccountId : null;

    let status: AndroidActionStatus = 'PENDING_USER_APPROVAL';
    let reason = 'Queued from Android screen analysis. Requires explicit user approval in Assisted mode.';
    if (!input.riskStatus.allowed) {
      status = 'BLOCKED_RISK';
      reason = `Blocked by risk guard: ${input.riskStatus.reasons.join(' ')}`;
    } else if (accountModeVerified === 'REAL' || input.analysis.detectedAccountMode === 'REAL') {
      status = 'BLOCKED_RISK';
      reason =
        'Real-money Android screen execution is locked. Switch mobile app and active broker session to DEMO / PRACTICE to queue executable approvals.';
    } else if (!isVerified) {
      status = 'BLOCKED_UNVERIFIED_ACCOUNT';
      reason =
        session?.reason ||
        'Broker account mode is UNVERIFIED. Connect and verify a DEMO / PRACTICE broker account before queuing executable Android approvals.';
    } else if (input.operatingMode === 'automatic') {
      status = 'PENDING_USER_APPROVAL';
      reason = 'Unattended Android screen execution is disabled in Phase 1. Requires manual approval.';
    }

    const now = new Date();
    const item: AndroidActionQueueItem = {
      id: crypto.randomUUID(),
      userId: input.userId,
      deviceId: input.deviceId,
      screenAnalysisId: input.analysis.id,
      appPackage: input.analysis.appPackage,
      appName: input.analysis.appName,
      operatingMode: input.operatingMode,
      symbol: input.analysis.normalizedSymbol || input.analysis.detectedSymbol || 'UNKNOWN',
      direction: input.analysis.recommendedAction,
      stakeOrVolume: Number(input.stakeOrVolume.toFixed(2)),
      expirySeconds: input.expirySeconds,
      accountModeVerified,
      accountModeVerificationSource,
      verifiedBrokerAccountId,
      status,
      reason,
      expiresAt: status === 'PENDING_USER_APPROVAL' ? new Date(now.getTime() + 5 * 60 * 1000).toISOString() : null,
      approvedAt: null,
      executedAt: null,
      deviceAckNote: null,
      createdAt: now.toISOString(),
    };

    const persisted = await this.persistActionToSupabase(item);
    if (!persisted.ok) {
      throw new Error(`Failed to persist Android queued action: ${persisted.error}`);
    }

    store.actions.unshift(item);
    if (store.actions.length > 60) store.actions.length = 60;
    this.saveStore(input.userId);
    return item;
  }

  async approveAction(
    userId: string,
    actionId: string,
    riskStatus: RiskStatus,
    verifiedBrokerSession?: VerifiedBrokerAccountSession
  ): Promise<{ ok: boolean; action?: AndroidActionQueueItem; error?: string; statusCode?: number }> {
    await this.ensureUserHistoryLoaded(userId);
    const store = this.getOrInitStore(userId);
    this.expireStaleActions(store);
    const action = store.actions.find((a) => a.id === actionId);
    if (!action || action.status !== 'PENDING_USER_APPROVAL') {
      return { ok: false, error: 'Pending Android assisted action not found or expired.', statusCode: 404 };
    }

    const prevStatus = action.status;
    const prevReason = action.reason;
    const prevApprovedAt = action.approvedAt;
    const prevExpiresAt = action.expiresAt;
    const prevMode = action.accountModeVerified;
    const prevSource = action.accountModeVerificationSource;
    const prevAcctId = action.verifiedBrokerAccountId;

    if (verifiedBrokerSession) {
      if (verifiedBrokerSession.verified && verifiedBrokerSession.source !== 'UNVERIFIED') {
        action.accountModeVerified = verifiedBrokerSession.mode;
        action.accountModeVerificationSource = verifiedBrokerSession.source;
        action.verifiedBrokerAccountId = verifiedBrokerSession.brokerAccountId;
      } else {
        action.accountModeVerified = 'UNKNOWN';
        action.accountModeVerificationSource = 'UNVERIFIED';
        action.verifiedBrokerAccountId = null;
      }
    }

    if (!riskStatus.allowed) {
      action.status = 'BLOCKED_RISK';
      action.reason = `Blocked by risk guard: ${riskStatus.reasons.join(' ')}`;
      const persisted = await this.persistActionToSupabase(action);
      if (!persisted.ok) {
        action.status = prevStatus;
        action.reason = prevReason;
        return { ok: false, error: `Supabase persistence error: ${persisted.error}`, statusCode: 500 };
      }
      this.saveStore(userId);
      return { ok: false, error: action.reason, statusCode: 409 };
    }

    if (action.accountModeVerified === 'REAL') {
      action.status = 'BLOCKED_RISK';
      action.reason = 'Real-money Android execution is locked. Only verified DEMO/PRACTICE accounts can be authorized.';
      const persisted = await this.persistActionToSupabase(action);
      if (!persisted.ok) {
        action.status = prevStatus;
        action.reason = prevReason;
        return { ok: false, error: `Supabase persistence error: ${persisted.error}`, statusCode: 500 };
      }
      this.saveStore(userId);
      return { ok: false, error: action.reason, statusCode: 423 };
    }

    if (
      (action.accountModeVerified !== 'DEMO' && action.accountModeVerified !== 'PRACTICE') ||
      action.accountModeVerificationSource === 'UNVERIFIED'
    ) {
      action.status = 'BLOCKED_UNVERIFIED_ACCOUNT';
      action.reason =
        verifiedBrokerSession?.reason ||
        'Cannot authorize Android action: broker account mode is UNVERIFIED. Connect a DEMO or PRACTICE broker session first.';
      const persisted = await this.persistActionToSupabase(action);
      if (!persisted.ok) {
        action.status = prevStatus;
        action.reason = prevReason;
        action.accountModeVerified = prevMode;
        action.accountModeVerificationSource = prevSource;
        action.verifiedBrokerAccountId = prevAcctId;
        return { ok: false, error: `Supabase persistence error: ${persisted.error}`, statusCode: 500 };
      }
      this.saveStore(userId);
      return { ok: false, error: action.reason, statusCode: 409 };
    }

    const now = new Date();
    action.status = 'AUTHORIZED';
    action.approvedAt = now.toISOString();
    action.expiresAt = new Date(now.getTime() + 30 * 1000).toISOString();
    action.reason = `Authorized by user for verified ${action.accountModeVerified} workflow (${action.accountModeVerificationSource}).`;

    const persisted = await this.persistActionToSupabase(action);
    if (!persisted.ok) {
      action.status = prevStatus;
      action.reason = prevReason;
      action.approvedAt = prevApprovedAt;
      action.expiresAt = prevExpiresAt;
      action.accountModeVerified = prevMode;
      action.accountModeVerificationSource = prevSource;
      action.verifiedBrokerAccountId = prevAcctId;
      return { ok: false, error: `Failed to persist Android authorization to Supabase: ${persisted.error}`, statusCode: 500 };
    }

    this.saveStore(userId);
    return { ok: true, action };
  }

  async rejectAction(userId: string, actionId: string, reason = 'Rejected by user.'): Promise<AndroidActionQueueItem | null> {
    await this.ensureUserHistoryLoaded(userId);
    const store = this.getOrInitStore(userId);
    const action = store.actions.find((a) => a.id === actionId);
    if (!action || (action.status !== 'PENDING_USER_APPROVAL' && action.status !== 'AUTHORIZED')) {
      return null;
    }
    const prevStatus = action.status;
    const prevReason = action.reason;
    action.status = 'REJECTED';
    action.reason = reason;
    const persisted = await this.persistActionToSupabase(action);
    if (!persisted.ok) {
      action.status = prevStatus;
      action.reason = prevReason;
      throw new Error(`Failed to persist Android action rejection: ${persisted.error}`);
    }
    this.saveStore(userId);
    return action;
  }

  async blockAllPendingOnEmergencyStop(userId: string): Promise<void> {
    await this.ensureUserHistoryLoaded(userId);
    const store = this.getOrInitStore(userId);
    let changed = false;
    for (const action of store.actions) {
      if (action.status === 'PENDING_USER_APPROVAL' || action.status === 'AUTHORIZED') {
        action.status = 'BLOCKED_RISK';
        action.reason = 'Emergency stop engaged by user.';
        const persisted = await this.persistActionToSupabase(action);
        if (!persisted.ok) {
          throw new Error(`Failed to persist Emergency Stop block to Supabase: ${persisted.error}`);
        }
        changed = true;
      }
    }
    if (changed) this.saveStore(userId);
  }

  async pollAuthorizedActionsForDevice(
    userId: string,
    deviceId: string,
    emergencyStop: boolean
  ): Promise<AndroidActionQueueItem[]> {
    await this.ensureUserHistoryLoaded(userId);
    if (emergencyStop) {
      await this.blockAllPendingOnEmergencyStop(userId);
      return [];
    }
    const store = this.getOrInitStore(userId);
    this.expireStaleActions(store);
    const authorized = store.actions.filter(
      (a) =>
        a.deviceId === deviceId &&
        a.status === 'AUTHORIZED' &&
        (a.accountModeVerified === 'DEMO' || a.accountModeVerified === 'PRACTICE') &&
        a.accountModeVerificationSource !== 'UNVERIFIED'
    );
    const dispatched: AndroidActionQueueItem[] = [];
    for (const act of authorized) {
      const prevStatus = act.status;
      act.status = 'DISPATCHED_TO_DEVICE';
      const persisted = await this.persistActionToSupabase(act);
      if (!persisted.ok) {
        act.status = prevStatus;
        throw new Error(`Failed to persist Android action dispatch to Supabase: ${persisted.error}`);
      }
      dispatched.push(act);
    }
    if (dispatched.length > 0) this.saveStore(userId);
    return dispatched;
  }

  async acknowledgeDeviceAction(
    userId: string,
    deviceId: string,
    actionId: string,
    outcome: 'EXECUTED_REPORTED' | 'REJECTED' | 'EXPIRED',
    note?: string
  ): Promise<AndroidActionQueueItem | null> {
    await this.ensureUserHistoryLoaded(userId);
    const store = this.getOrInitStore(userId);
    this.expireStaleActions(store);
    const action = store.actions.find((a) => a.id === actionId && a.deviceId === deviceId);
    if (!action) return null;
    if (action.accountModeVerified === 'REAL') return null;
    if (
      outcome === 'EXECUTED_REPORTED' &&
      ((action.accountModeVerified !== 'DEMO' && action.accountModeVerified !== 'PRACTICE') ||
        action.accountModeVerificationSource === 'UNVERIFIED')
    ) {
      return null;
    }
    if (action.status !== 'AUTHORIZED' && action.status !== 'DISPATCHED_TO_DEVICE') return null;
    const prevStatus = action.status;
    const prevExec = action.executedAt;
    const prevNote = action.deviceAckNote;
    action.status = outcome;
    action.executedAt = new Date().toISOString();
    action.deviceAckNote = note ? note.slice(0, 240) : null;
    const persisted = await this.persistActionToSupabase(action);
    if (!persisted.ok) {
      action.status = prevStatus;
      action.executedAt = prevExec;
      action.deviceAckNote = prevNote;
      throw new Error(`Failed to persist Android action acknowledgement to Supabase: ${persisted.error}`);
    }
    this.saveStore(userId);
    return action;
  }

  private async persistActionToSupabase(action: AndroidActionQueueItem): Promise<{ ok: boolean; error?: string }> {
    const admin = getSupabaseAdmin();
    if (!admin || action.userId === 'local-preview') return { ok: true };
    try {
      const { error } = await admin.from('android_action_queue').upsert(
        {
          id: action.id,
          user_id: action.userId,
          device_id: action.deviceId,
          screen_analysis_id: action.screenAnalysisId,
          app_package: action.appPackage,
          app_name: action.appName,
          operating_mode: action.operatingMode,
          symbol: action.symbol,
          direction: action.direction,
          stake_or_volume: action.stakeOrVolume,
          expiry_seconds: action.expirySeconds,
          account_mode_verified: action.accountModeVerified,
          account_mode_verification_source: action.accountModeVerificationSource,
          verified_broker_account_id: action.verifiedBrokerAccountId,
          status: action.status,
          reason: action.reason,
          expires_at: action.expiresAt,
          approved_at: action.approvedAt,
          executed_at: action.executedAt,
          device_ack_note: action.deviceAckNote,
          created_at: action.createdAt,
        },
        { onConflict: 'id' }
      );
      if (error) {
        this.lastPersistenceError = error.message;
        console.error('[AndroidCompanionManager] Supabase android_action_queue write failed:', error.message);
        return { ok: false, error: error.message };
      }
      this.lastPersistenceError = null;
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Supabase write exception';
      this.lastPersistenceError = msg;
      console.error('[AndroidCompanionManager] Supabase android_action_queue write exception:', msg);
      return { ok: false, error: msg };
    }
  }
}

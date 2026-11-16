import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSupabaseAdmin } from './supabaseAdmin.ts';
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
  | 'BLOCKED_REAL_MONEY_LOCK'
  | 'EXPIRED';

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
  const salt = (process.env.ANDROID_BRIDGE_SECRET || process.env.MT5_BRIDGE_TOKEN || 'novatrade-android-bridge-v1').trim();
  return crypto.createHmac('sha256', salt).update(secret).digest('hex');
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

  constructor(statePersistPath: string | null) {
    this.persistDir = statePersistPath ? path.join(path.dirname(statePersistPath), 'android') : null;
    this.preloadPersistedStores();
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
    const store = this.getOrInitStore(userId);
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

    store.devices.unshift(device);
    if (store.devices.length > 20) store.devices.length = 20;
    this.saveStore(userId);

    const admin = getSupabaseAdmin();
    if (admin && userId !== 'local-preview') {
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
    const nowIso = new Date().toISOString();

    const admin = getSupabaseAdmin();
    if (admin) {
      const { data: matchedDevs, error: fetchErr } = await admin
        .from('android_devices')
        .select('*')
        .eq('pairing_code_hash', candidateHash)
        .eq('status', 'PAIRED_PENDING')
        .gt('pairing_expires_at', nowIso);

      if (!fetchErr && matchedDevs && matchedDevs.length > 0) {
        const targetDbDev = matchedDevs[0];
        const rawToken = `nt_dev_${crypto.randomBytes(24).toString('hex')}`;
        const tokenHash = hashSecret(rawToken);
        const tokenPrefix = rawToken.slice(0, 12);
        const newName = input.deviceName?.trim().slice(0, 60) || targetDbDev.device_name || 'Android Trading Phone';
        const newModel = input.deviceModel?.trim().slice(0, 80) || targetDbDev.device_model;
        const newOs = input.osVersion?.trim().slice(0, 40) || targetDbDev.os_version;
        const perms = {
          ...(targetDbDev.permissions || {}),
          ...(typeof input.mediaProjectionGranted === 'boolean' ? { mediaProjection: input.mediaProjectionGranted } : {}),
          ...(typeof input.accessibilityGranted === 'boolean' ? { accessibility: input.accessibilityGranted } : {}),
          realMoneyBlocked: true,
        };

        const { data: updatedDev, error: updateErr } = await admin
          .from('android_devices')
          .update({
            device_name: newName,
            device_model: newModel,
            os_version: newOs,
            pairing_code_hash: null,
            pairing_expires_at: null,
            device_token_hash: tokenHash,
            token_prefix: tokenPrefix,
            permissions: perms,
            status: 'ACTIVE',
            last_seen_at: nowIso,
            updated_at: nowIso,
          })
          .eq('id', targetDbDev.id)
          .eq('status', 'PAIRED_PENDING')
          .select()
          .single();

        if (!updateErr && updatedDev) {
          const deviceInternal: AndroidDeviceInternal = {
            id: updatedDev.id,
            userId: updatedDev.user_id,
            deviceName: updatedDev.device_name,
            deviceModel: updatedDev.device_model,
            osVersion: updatedDev.os_version,
            pairingCodeHash: null,
            pairingExpiresAt: null,
            deviceTokenHash: updatedDev.device_token_hash,
            tokenPrefix: updatedDev.token_prefix,
            permissions: updatedDev.permissions,
            targetPackages: updatedDev.target_packages || [],
            status: updatedDev.status,
            lastAppPackage: updatedDev.last_app_package,
            lastSeenAt: updatedDev.last_seen_at,
            createdAt: updatedDev.created_at,
            updatedAt: updatedDev.updated_at,
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
      }
    }

    const nowMs = Date.now();
    for (const [userId, store] of this.stores.entries()) {
      for (const dev of store.devices) {
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
        this.saveStore(userId);

        const adminAdmin = getSupabaseAdmin();
        if (adminAdmin && userId !== 'local-preview') {
          void adminAdmin
            .from('android_devices')
            .update({
              device_name: dev.deviceName,
              device_model: dev.deviceModel,
              os_version: dev.osVersion,
              pairing_code_hash: null,
              pairing_expires_at: null,
              device_token_hash: dev.deviceTokenHash,
              token_prefix: dev.tokenPrefix,
              permissions: dev.permissions,
              status: dev.status,
              last_seen_at: dev.lastSeenAt,
              updated_at: dev.updatedAt,
            })
            .eq('id', dev.id)
            .then(() => undefined, () => undefined);
        }
        return { device: toPublicDevice(dev), deviceToken: rawToken };
      }
    }

    return null;
  }

  async authenticateDeviceToken(authHeader?: string): Promise<{ userId: string; device: AndroidDeviceInternal } | null> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7).trim();
    if (!token.startsWith('nt_dev_') || token.length < 24) return null;
    const candidateHash = hashSecret(token);

    for (const [userId, store] of this.stores.entries()) {
      for (const dev of store.devices) {
        if (dev.status === 'REVOKED' || !dev.deviceTokenHash) continue;
        if (timingSafeHexMatch(dev.deviceTokenHash, candidateHash)) {
          return { userId, device: dev };
        }
      }
    }

    const admin = getSupabaseAdmin();
    if (admin) {
      const { data: matchedDevs, error } = await admin
        .from('android_devices')
        .select('*')
        .eq('device_token_hash', candidateHash)
        .neq('status', 'REVOKED')
        .limit(1);

      if (!error && matchedDevs && matchedDevs.length > 0) {
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
          permissions: dbDev.permissions,
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
    }

    return null;
  }

  async listDevices(userId: string): Promise<AndroidDevicePublic[]> {
    const admin = getSupabaseAdmin();
    if (admin && userId !== 'local-preview') {
      const { data: dbDevs, error } = await admin
        .from('android_devices')
        .select('*')
        .eq('user_id', userId)
        .neq('status', 'REVOKED')
        .order('created_at', { ascending: false });

      if (!error && dbDevs) {
        const store = this.getOrInitStore(userId);
        store.devices = dbDevs.map((dbDev: Record<string, any>) => ({
          id: dbDev.id,
          userId: dbDev.user_id,
          deviceName: dbDev.device_name,
          deviceModel: dbDev.device_model,
          osVersion: dbDev.os_version,
          pairingCodeHash: dbDev.pairing_code_hash,
          pairingExpiresAt: dbDev.pairing_expires_at,
          deviceTokenHash: dbDev.device_token_hash,
          tokenPrefix: dbDev.token_prefix,
          permissions: dbDev.permissions,
          targetPackages: dbDev.target_packages || [],
          status: dbDev.status,
          lastAppPackage: dbDev.last_app_package,
          lastSeenAt: dbDev.last_seen_at,
          createdAt: dbDev.created_at,
          updatedAt: dbDev.updated_at,
        }));
        this.saveStore(userId);
      }
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
    this.saveStore(userId);

    const admin = getSupabaseAdmin();
    if (admin && userId !== 'local-preview') {
      await admin
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
    }
    return toPublicDevice(dev);
  }

  async revokeDevice(userId: string, deviceId: string): Promise<boolean> {
    const store = this.getOrInitStore(userId);
    const dev = store.devices.find((d) => d.id === deviceId && d.status !== 'REVOKED');
    if (!dev) return false;
    dev.status = 'REVOKED';
    dev.updatedAt = new Date().toISOString();
    this.saveStore(userId);

    const admin = getSupabaseAdmin();
    if (admin && userId !== 'local-preview') {
      await admin
        .from('android_devices')
        .update({
          status: 'REVOKED',
          updated_at: dev.updatedAt,
        })
        .eq('id', deviceId)
        .eq('user_id', userId);
    }
    return true;
  }

  listAnalyses(userId: string): AndroidScreenAnalysisRecord[] {
    const store = this.getOrInitStore(userId);
    return store.analyses;
  }

  listActions(userId: string): AndroidActionQueueItem[] {
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
      void admin
        .from('android_devices')
        .update({
          last_seen_at: dev.lastSeenAt,
          last_app_package: dev.lastAppPackage,
          permissions: dev.permissions,
          updated_at: dev.updatedAt,
        })
        .eq('id', dev.id)
        .then(() => undefined, () => undefined);
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

    store.analyses.unshift(record);
    if (store.analyses.length > 50) store.analyses.length = 50;
    this.saveStore(input.userId);

    const admin = getSupabaseAdmin();
    if (admin && input.userId !== 'local-preview') {
      await admin
        .from('android_screen_analyses')
        .insert({
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
          signal_id: record.signalId,
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
        })
        .then(() => undefined, () => undefined);
    }
    return record;
  }

  queueActionFromScreen(input: {
    userId: string;
    deviceId: string | null;
    analysis: AndroidScreenAnalysisRecord;
    operatingMode: OperatingMode;
    stakeOrVolume: number;
    expirySeconds: number;
    riskStatus: RiskStatus;
  }): AndroidActionQueueItem | null {
    if (input.analysis.recommendedAction !== 'CALL' && input.analysis.recommendedAction !== 'PUT') {
      return null;
    }
    const store = this.getOrInitStore(input.userId);
    this.expireStaleActions(store);
    let status: AndroidActionStatus = 'PENDING_USER_APPROVAL';
    let reason = 'Queued from Android screen analysis. Requires explicit user approval in Assisted mode.';
    if (!input.riskStatus.allowed) {
      status = 'BLOCKED_RISK';
      reason = `Blocked by risk guard: ${input.riskStatus.reasons.join(' ')}`;
    } else if (input.analysis.detectedAccountMode === 'REAL') {
      status = 'BLOCKED_REAL_MONEY_LOCK';
      reason = 'Real-money Android screen execution is locked. Switch mobile app to DEMO / PRACTICE to queue executable approvals.';
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
      accountModeVerified: input.analysis.detectedAccountMode,
      status,
      reason,
      expiresAt: status === 'PENDING_USER_APPROVAL' ? new Date(now.getTime() + 5 * 60 * 1000).toISOString() : null,
      approvedAt: null,
      executedAt: null,
      deviceAckNote: null,
      createdAt: now.toISOString(),
    };

    store.actions.unshift(item);
    if (store.actions.length > 60) store.actions.length = 60;
    this.saveStore(input.userId);
    this.persistActionToSupabase(item);
    return item;
  }

  approveAction(
    userId: string,
    actionId: string,
    riskStatus: RiskStatus
  ): { ok: boolean; action?: AndroidActionQueueItem; error?: string; statusCode?: number } {
    const store = this.getOrInitStore(userId);
    this.expireStaleActions(store);
    const action = store.actions.find((a) => a.id === actionId);
    if (!action || action.status !== 'PENDING_USER_APPROVAL') {
      return { ok: false, error: 'Pending Android assisted action not found or expired.', statusCode: 404 };
    }
    if (!riskStatus.allowed) {
      action.status = 'BLOCKED_RISK';
      action.reason = `Blocked by risk guard: ${riskStatus.reasons.join(' ')}`;
      this.saveStore(userId);
      this.persistActionToSupabase(action);
      return { ok: false, error: action.reason, statusCode: 409 };
    }
    if (action.accountModeVerified === 'REAL') {
      action.status = 'BLOCKED_REAL_MONEY_LOCK';
      action.reason = 'Real-money Android execution is locked. Only DEMO/PRACTICE accounts can be authorized.';
      this.saveStore(userId);
      this.persistActionToSupabase(action);
      return { ok: false, error: action.reason, statusCode: 423 };
    }

    const now = new Date();
    action.status = 'AUTHORIZED';
    action.approvedAt = now.toISOString();
    action.expiresAt = new Date(now.getTime() + 30 * 1000).toISOString();
    action.reason = 'Authorized by user for demo/paper workflow (Phase 1 safe tracking).';
    this.saveStore(userId);
    this.persistActionToSupabase(action);
    return { ok: true, action };
  }

  rejectAction(userId: string, actionId: string, reason = 'Rejected by user.'): AndroidActionQueueItem | null {
    const store = this.getOrInitStore(userId);
    const action = store.actions.find((a) => a.id === actionId);
    if (!action || (action.status !== 'PENDING_USER_APPROVAL' && action.status !== 'AUTHORIZED')) {
      return null;
    }
    action.status = 'REJECTED';
    action.reason = reason;
    this.saveStore(userId);
    this.persistActionToSupabase(action);
    return action;
  }

  blockAllPendingOnEmergencyStop(userId: string) {
    const store = this.getOrInitStore(userId);
    let changed = false;
    for (const action of store.actions) {
      if (action.status === 'PENDING_USER_APPROVAL' || action.status === 'AUTHORIZED') {
        action.status = 'BLOCKED_RISK';
        action.reason = 'Emergency stop engaged by user.';
        changed = true;
        this.persistActionToSupabase(action);
      }
    }
    if (changed) this.saveStore(userId);
  }

  pollAuthorizedActionsForDevice(userId: string, deviceId: string, emergencyStop: boolean): AndroidActionQueueItem[] {
    if (emergencyStop) {
      this.blockAllPendingOnEmergencyStop(userId);
      return [];
    }
    const store = this.getOrInitStore(userId);
    this.expireStaleActions(store);
    const authorized = store.actions.filter(
      (a) =>
        a.deviceId === deviceId &&
        a.status === 'AUTHORIZED' &&
        a.accountModeVerified !== 'REAL'
    );
    for (const act of authorized) {
      act.status = 'DISPATCHED_TO_DEVICE';
      this.persistActionToSupabase(act);
    }
    if (authorized.length > 0) this.saveStore(userId);
    return authorized;
  }

  acknowledgeDeviceAction(
    userId: string,
    deviceId: string,
    actionId: string,
    outcome: 'EXECUTED_REPORTED' | 'REJECTED' | 'EXPIRED',
    note?: string
  ): AndroidActionQueueItem | null {
    const store = this.getOrInitStore(userId);
    this.expireStaleActions(store);
    const action = store.actions.find((a) => a.id === actionId && a.deviceId === deviceId);
    if (!action) return null;
    if (action.accountModeVerified === 'REAL') return null;
    if (action.status !== 'AUTHORIZED' && action.status !== 'DISPATCHED_TO_DEVICE') return null;
    action.status = outcome;
    action.executedAt = new Date().toISOString();
    action.deviceAckNote = note ? note.slice(0, 240) : null;
    this.saveStore(userId);
    this.persistActionToSupabase(action);
    return action;
  }

  private persistActionToSupabase(action: AndroidActionQueueItem) {
    const admin = getSupabaseAdmin();
    if (!admin || action.userId === 'local-preview') return;
    void admin
      .from('android_action_queue')
      .upsert(
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
          status: action.status,
          reason: action.reason,
          expires_at: action.expiresAt,
          approved_at: action.approvedAt,
          executed_at: action.executedAt,
          device_ack_note: action.deviceAckNote,
          created_at: action.createdAt,
        },
        { onConflict: 'id' }
      )
      .then(() => undefined, () => undefined);
  }
}

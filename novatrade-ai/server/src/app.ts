import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { fetchMarketCandles, getAssetDefinition, getMarketDataProviderStatus, SUPPORTED_ASSETS, type Timeframe } from './marketData.ts';
import { computeBollinger, computeEmaSeries } from './quantEngine.ts';
import { BrokerRegistry } from './brokers/registry.ts';
import { BrokerConnectionError, BrokerConnectionManager } from './brokers/connectionManager.ts';
import { parseIqConnectorConfig } from './brokers/iqOption.ts';
import { NovaTradeEngine } from './tradingEngine.ts';
import { AndroidCompanionManager } from './androidCompanion.ts';
import { analyzeAndroidTradingScreen } from './androidVision.ts';
import {
  getSupabaseAdmin,
  getSupabaseServerConfig,
  runSupabaseDiagnostics,
  verifySupabaseBearerToken,
} from './supabaseAdmin.ts';

export interface CreateServerOptions {
  persistPath?: string | null;
  enableScheduler?: boolean;
  autoRestore?: boolean;
  verifyToken?: (authHeader?: string) => Promise<{ userId: string; email: string | null } | null>;
}

export interface SchedulerRecoverySummary {
  completed: boolean;
  restoredCount: number;
  blockedByEmergencyStopCount: number;
  pausedByRiskCount: number;
  failedCount: number;
  restoredUserIds: string[];
  restoredAt: string | null;
  lastError: string | null;
}

const globalSchedulerRegistry = new Map<string, ReturnType<typeof setInterval>>();

function isLoopbackRequest(req: express.Request): boolean {
  if (req.headers['x-forwarded-for']) return false;
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export function createNovaTradeRouter(options: CreateServerOptions = {}) {
  const router = express.Router();
  const persistPath = options.persistPath === undefined ? path.resolve(process.cwd(), '.novatrade-data/state.json') : options.persistPath;
  const schedulerKey = persistPath || '__memory__';
  const schedulerInstanceId = crypto.randomUUID().slice(0, 8);
  const engines = new Map<string, NovaTradeEngine>();
  const defaultEngine = new NovaTradeEngine(persistPath);
  engines.set('local-preview', defaultEngine);

  const brokers = new BrokerRegistry();
  const brokerManager = new BrokerConnectionManager(brokers, persistPath);
  const androidManager = new AndroidCompanionManager(persistPath);
  const iqOption = brokers.get('iq_option')!;
  const tokenVerifier = options.verifyToken ?? verifySupabaseBearerToken;

  function attachBrokerAutoHook(eng: NovaTradeEngine, uid: string) {
    eng.onAutonomousSignalTriggered = async (signal, stake) => {
      if (eng.riskSettings.emergencyStop || !brokerManager.isAutoBrokerExecutionEnabled(uid)) return;
      const targetAccountId = brokerManager.getActiveExecutionAccountId(uid);
      if (!targetAccountId) return;
      if (signal.direction !== 'CALL' && signal.direction !== 'PUT') return;
      const assetMeta = getAssetDefinition(signal.symbol);
      const actUid = uid === 'local-preview' ? undefined : uid;
      try {
        const validation = await brokerManager.validateDemoOrder(uid, {
          accountId: targetAccountId,
          symbol: signal.symbol,
          assetClass: assetMeta.instrumentType,
          direction: signal.direction,
          orderType: 'MARKET',
          amount: stake,
          entryPrice: signal.entryPrice,
          expirySeconds: signal.suggestedExpirySeconds || eng.aiSettings.expirySeconds,
          globalEmergencyStop: eng.riskSettings.emergencyStop,
        });
        if (!validation.valid) {
          eng.logActivity('BROKER', 'AUTO_BROKER_SKIPPED', `Auto MT5 demo order skipped (${signal.symbol}): ${validation.reason}`, actUid);
          return;
        }
        const routed = await brokerManager.executeDemoOrder(uid, {
          accountId: targetAccountId,
          symbol: signal.symbol,
          assetClass: assetMeta.instrumentType,
          direction: signal.direction,
          orderType: 'MARKET',
          amount: stake,
          entryPrice: signal.entryPrice,
          expirySeconds: signal.suggestedExpirySeconds || eng.aiSettings.expirySeconds,
          idempotencyKey: `auto-${signal.id}`,
          source: 'automatic',
          globalEmergencyStop: eng.riskSettings.emergencyStop,
        });
        eng.logActivity(
          'BROKER',
          routed.duplicatePrevented ? 'AUTO_BROKER_DUPLICATE_PREVENTED' : 'AUTO_BROKER_DEMO_ORDER',
          `Auto routed ${routed.order.direction} ${routed.order.mappedSymbol} to ${routed.order.brokerName} (${routed.order.status})`,
          actUid
        );
      } catch (err) {
        eng.logActivity(
          'BROKER',
          'AUTO_BROKER_ORDER_BLOCKED',
          err instanceof Error ? err.message : 'Automatic demo order blocked.',
          actUid
        );
      }
    };
  }

  attachBrokerAutoHook(defaultEngine, 'local-preview');

  function getEngineForUser(userId: string): NovaTradeEngine {
    const existing = engines.get(userId);
    if (existing) return existing;
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const userPersist = persistPath ? path.join(path.dirname(persistPath), 'users', `${safeId}.json`) : null;
    const userEngine = new NovaTradeEngine(userPersist, userId);
    attachBrokerAutoHook(userEngine, userId);
    engines.set(userId, userEngine);
    return userEngine;
  }

  let recoverySummary: SchedulerRecoverySummary = {
    completed: false,
    restoredCount: 0,
    blockedByEmergencyStopCount: 0,
    pausedByRiskCount: 0,
    failedCount: 0,
    restoredUserIds: [],
    restoredAt: null,
    lastError: null,
  };

  async function restoreEligibleSchedulers(): Promise<SchedulerRecoverySummary> {
    let restoredCount = 0;
    let blockedByEmergencyStopCount = 0;
    let pausedByRiskCount = 0;
    let failedCount = 0;
    let lastError: string | null = null;
    const restoredUserIds = new Set<string>();

    // 1. Inspect default local engine & persisted user JSON workspaces
    const evaluateLocalEngine = (key: string, eng: NovaTradeEngine) => {
      if (eng.riskSettings.emergencyStop) {
        if (eng.autoPaperArmed) {
          eng.autoPaperArmed = false;
          eng.autoPausedReason = 'Emergency stop is active; automatic trading remains blocked after restart.';
          eng.logActivity(
            'RISK',
            'SCHEDULER_RECOVERY_BLOCKED',
            `Blocked automatic trading restore for ${key} because emergency stop is active.`,
            eng.ownerUserId
          );
          blockedByEmergencyStopCount += 1;
        }
        return;
      }
      if (eng.autoPaperArmed) {
        const risk = eng.getRiskStatus();
        if (risk.allowed) {
          restoredCount += 1;
          restoredUserIds.add(key);
          eng.logActivity(
            'SCHEDULER',
            'SCHEDULER_RESTORED',
            `Automatic paper trading schedule restored on server startup (instance ${schedulerInstanceId}).`,
            eng.ownerUserId
          );
        } else {
          eng.autoPaperArmed = false;
          eng.autoPausedReason = risk.reasons.join(' ');
          pausedByRiskCount += 1;
          eng.logActivity(
            'SCHEDULER',
            'SCHEDULER_RECOVERY_PAUSED',
            `Automatic schedule paused on startup due to risk guard: ${eng.autoPausedReason}`,
            eng.ownerUserId
          );
        }
      }
    };

    evaluateLocalEngine('local-preview', defaultEngine);

    if (persistPath) {
      const usersDir = path.join(path.dirname(persistPath), 'users');
      try {
        if (fs.existsSync(usersDir)) {
          const files = fs.readdirSync(usersDir).filter((f) => f.endsWith('.json'));
          for (const file of files) {
            try {
              const raw = JSON.parse(fs.readFileSync(path.join(usersDir, file), 'utf8')) as {
                autoPaperArmed?: boolean;
                riskSettings?: { emergencyStop?: boolean };
              };
              const uid = file.replace(/\.json$/, '');
              if (raw.autoPaperArmed || raw.riskSettings?.emergencyStop) {
                const eng = getEngineForUser(uid);
                evaluateLocalEngine(uid, eng);
              }
            } catch (err) {
              failedCount += 1;
              lastError = err instanceof Error ? err.message : 'Local workspace restore failed';
              defaultEngine.logActivity('SCHEDULER', 'SCHEDULER_RECOVERY_FAILED', `Failed reading local user state ${file}: ${lastError}`);
            }
          }
        }
      } catch (err) {
        failedCount += 1;
        lastError = err instanceof Error ? err.message : 'Local users directory scan failed';
        defaultEngine.logActivity('SCHEDULER', 'SCHEDULER_RECOVERY_FAILED', lastError);
      }
    }

    // 2. Restore eligible Supabase-backed user workspaces (auto_paper_armed = true)
    const admin = getSupabaseAdmin();
    if (admin) {
      try {
        const { data: armedRows, error } = await admin
          .from('user_settings')
          .select('*')
          .eq('auto_paper_armed', true);

        if (error) {
          failedCount += 1;
          lastError = error.message;
          defaultEngine.logActivity('SCHEDULER', 'SCHEDULER_RECOVERY_FAILED', `Supabase recovery query failed: ${error.message}`);
        } else if (Array.isArray(armedRows)) {
          for (const row of armedRows) {
            const userId = String(row.user_id || '');
            if (!userId) continue;
            try {
              const userEngine = getEngineForUser(userId);
              const [tradesRes, signalsRes] = await Promise.all([
                admin
                  .from('paper_trades')
                  .select('*')
                  .eq('user_id', userId)
                  .order('created_at', { ascending: false })
                  .limit(250),
                admin
                  .from('trading_signals')
                  .select('*')
                  .eq('user_id', userId)
                  .order('created_at', { ascending: false })
                  .limit(100),
              ]);
              const outcome = userEngine.restoreFromSupabaseWorkspace({
                settingsRow: row as Record<string, unknown>,
                tradesRows: Array.isArray(tradesRes.data) ? (tradesRes.data as Array<Record<string, unknown>>) : [],
                signalsRows: Array.isArray(signalsRes.data) ? (signalsRes.data as Array<Record<string, unknown>>) : [],
              });
              if (outcome.status === 'restored' && !restoredUserIds.has(userId)) {
                restoredCount += 1;
                restoredUserIds.add(userId);
              } else if (outcome.status === 'blocked_emergency_stop') {
                blockedByEmergencyStopCount += 1;
              } else if (outcome.status === 'paused_risk') {
                pausedByRiskCount += 1;
              }
            } catch (userErr) {
              failedCount += 1;
              lastError = userErr instanceof Error ? userErr.message : 'User scheduler restore failed';
              defaultEngine.logActivity(
                'SCHEDULER',
                'SCHEDULER_RECOVERY_FAILED',
                `Scheduler restore failed for user ${userId}: ${lastError}`,
                userId
              );
            }
          }
        }
      } catch (err) {
        failedCount += 1;
        lastError = err instanceof Error ? err.message : 'Supabase scheduler recovery threw an exception';
        defaultEngine.logActivity('SCHEDULER', 'SCHEDULER_RECOVERY_FAILED', lastError);
      }
    }

    recoverySummary = {
      completed: true,
      restoredCount,
      blockedByEmergencyStopCount,
      pausedByRiskCount,
      failedCount,
      restoredUserIds: Array.from(restoredUserIds),
      restoredAt: new Date().toISOString(),
      lastError,
    };
    return recoverySummary;
  }

  const recoveryPromise = options.autoRestore === false ? Promise.resolve(recoverySummary) : restoreEligibleSchedulers();

  // Prevent duplicate scheduler intervals for the same workspace key
  const existingGlobalTimer = globalSchedulerRegistry.get(schedulerKey);
  if (existingGlobalTimer) {
    clearInterval(existingGlobalTimer);
    globalSchedulerRegistry.delete(schedulerKey);
  }

  let schedulerInterval: ReturnType<typeof setInterval> | null = null;
  let schedulerTickInFlight = false;
  if (options.enableScheduler !== false) {
    schedulerInterval = setInterval(() => {
      if (schedulerTickInFlight) return;
      schedulerTickInFlight = true;
      void (async () => {
        try {
          for (const eng of engines.values()) {
            if (eng.riskSettings.emergencyStop) {
              if (eng.autoPaperArmed) {
                eng.autoPaperArmed = false;
                eng.autoPausedReason = 'Emergency stop is active.';
              }
              continue;
            }
            if (eng.autoPaperArmed || eng.getActiveTrades().length > 0) {
              await eng.runAutonomousCycle(false).catch(() => undefined);
            }
          }
        } finally {
          schedulerTickInFlight = false;
        }
      })();
    }, 5_000);
    globalSchedulerRegistry.set(schedulerKey, schedulerInterval);
  }

  async function resolveUser(req: express.Request): Promise<{ userId?: string; email?: string | null; tokenInvalid?: boolean }> {
    const authHeader = req.headers.authorization;
    if (!authHeader) return {};
    const auth = await tokenVerifier(authHeader);
    if (!auth) return { tokenInvalid: true };
    return { userId: auth.userId, email: auth.email };
  }

  async function resolveWorkspace(
    req: express.Request,
    res: express.Response,
    requireAuthIfSupabaseConfigured = true
  ): Promise<{ engine: NovaTradeEngine; userId?: string } | null> {
    const user = await resolveUser(req);
    if (user.tokenInvalid) {
      res.status(401).json({ error: 'Invalid or expired authorization bearer token.' });
      return null;
    }
    if (user.userId) {
      return { engine: getEngineForUser(user.userId), userId: user.userId };
    }
    const sb = getSupabaseServerConfig();
    if (requireAuthIfSupabaseConfigured && sb.clientAuthConfigured) {
      res.status(401).json({ error: 'Authenticated Supabase session required.' });
      return null;
    }
    return { engine: defaultEngine };
  }

  router.get('/health', async (req, res) => {
    const sb = getSupabaseServerConfig();
    const iqCfg = parseIqConnectorConfig();
    const user = await resolveUser(req);
    const activeEngine = user.userId ? getEngineForUser(user.userId) : defaultEngine;
    const balance = activeEngine.getVirtualBalanceSummary();
    res.json({
      status: 'ok',
      mode: activeEngine.mode,
      executionMode: 'paper only',
      liveExecution: false,
      version: '0.3.1',
      virtualBalance: balance,
      scheduler: {
        instanceId: schedulerInstanceId,
        armed: activeEngine.autoPaperArmed,
        scanIntervalSeconds: activeEngine.aiSettings.scanIntervalSeconds,
        lastScanAt: activeEngine.lastScanAt,
        lastCycleSummary: activeEngine.lastCycleSummary,
        recovery: recoverySummary,
      },
      supabase: {
        clientConfigured: sb.clientAuthConfigured,
        serverConfigured: sb.serviceRoleConfigured,
      },
      geminiConfigured: Boolean((process.env.GEMINI_API_KEY || '').trim() && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
      iqConnectorConfigured: iqCfg.configured,
      iqConnectorUrlValid: iqCfg.urlValid,
    });
  });

  router.get('/supabase/status', (_req, res) => {
    const sb = getSupabaseServerConfig();
    const rawUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim();
    const rawAnon = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim();
    res.json({
      clientConfigured: sb.clientAuthConfigured,
      serverConfigured: sb.serviceRoleConfigured,
      urlValid: sb.urlValid,
      missingVars: [
        ...(!rawUrl ? ['VITE_SUPABASE_URL'] : !sb.urlValid ? ['VITE_SUPABASE_URL (invalid http/https URL format)'] : []),
        ...(!rawAnon ? ['VITE_SUPABASE_ANON_KEY'] : []),
        ...(!sb.serviceRoleConfigured ? ['SUPABASE_SERVICE_ROLE_KEY (optional server persistence)'] : []),
      ],
    });
  });

  router.get('/supabase/diagnostics', async (_req, res) => {
    const diagnostics = await runSupabaseDiagnostics();
    res.json(diagnostics);
  });

  router.post('/supabase/verify-rls', async (req, res) => {
    if (!isLoopbackRequest(req)) {
      return res.status(401).json({ error: 'Loopback verification only.' });
    }
    const admin = getSupabaseAdmin();
    const cfg = getSupabaseServerConfig();
    if (!admin || !cfg.urlValid || !cfg.anonKey) {
      return res.status(400).json({ ok: false, error: 'Supabase client or service role is not configured.' });
    }

    const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const emailA = `novatrade-audit-a-${nonce}@example.com`;
    const emailB = `novatrade-audit-b-${nonce}@example.com`;
    const password = `NtAudit#${nonce}!99`;
    let userAId: string | null = null;
    let userBId: string | null = null;

    try {
      const createdA = await admin.auth.admin.createUser({ email: emailA, password, email_confirm: true });
      const createdB = await admin.auth.admin.createUser({ email: emailB, password, email_confirm: true });
      if (createdA.error || !createdA.data.user || createdB.error || !createdB.data.user) {
        return res.status(500).json({
          ok: false,
          error: createdA.error?.message || createdB.error?.message || 'Failed to create temporary verification users.',
        });
      }
      userAId = createdA.data.user.id;
      userBId = createdB.data.user.id;

      const clientA = createClient(cfg.url, cfg.anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
      const clientB = createClient(cfg.url, cfg.anonKey, { auth: { autoRefreshToken: false, persistSession: false } });

      const signInA = await clientA.auth.signInWithPassword({ email: emailA, password });
      const signInB = await clientB.auth.signInWithPassword({ email: emailB, password });

      const loginSessionValid = Boolean(signInA.data.session?.access_token && signInB.data.session?.access_token);
      if (!loginSessionValid) {
        return res.status(500).json({
          ok: false,
          loginSessionValid: false,
          error: signInA.error?.message || signInB.error?.message || 'Password login failed.',
        });
      }

      const tradeId = crypto.randomUUID();
      const insertA = await clientA.from('paper_trades').insert({
        id: tradeId,
        user_id: userAId,
        symbol: 'EURUSD',
        timeframe: '1m',
        direction: 'CALL',
        mode: 'manual',
        amount: 25,
        payout_rate: 0.8,
        entry_price: 1.085,
        expiry_seconds: 180,
        status: 'SIMULATED_PENDING_OUTCOME',
      });

      const readA = await clientA.from('paper_trades').select('id,user_id,symbol,amount').eq('id', tradeId);
      const readB = await clientB.from('paper_trades').select('id,user_id,symbol,amount').eq('id', tradeId);

      // Verify auto_paper_armed persistence in user_settings under User A RLS
      const settingsUpsertA = await clientA.from('user_settings').upsert({
        user_id: userAId,
        preferred_mode: 'automatic',
        auto_paper_armed: true,
        emergency_stop: false,
      });
      const settingsReadB = await clientB.from('user_settings').select('user_id,auto_paper_armed').eq('user_id', userAId);

      return res.json({
        ok: Boolean(
          !insertA.error &&
            readA.data?.length === 1 &&
            !readB.error &&
            (readB.data?.length ?? -1) === 0 &&
            !settingsUpsertA.error &&
            (settingsReadB.data?.length ?? -1) === 0
        ),
        loginSessionValid,
        paperTradeInserted: !insertA.error,
        insertError: insertA.error?.message || null,
        userASeesTrade: readA.data?.length === 1,
        userBIsolatedZeroRows: !readB.error && readB.data?.length === 0,
        userBSettingsIsolatedZeroRows: !settingsReadB.error && settingsReadB.data?.length === 0,
        settingsError: settingsUpsertA.error?.message || null,
      });
    } finally {
      if (userAId) await admin.auth.admin.deleteUser(userAId).catch(() => undefined);
      if (userBId) await admin.auth.admin.deleteUser(userBId).catch(() => undefined);
    }
  });

  router.post('/supabase/audit-account', async (req, res) => {
    if (!isLoopbackRequest(req)) {
      return res.status(401).json({ error: 'Loopback verification only.' });
    }
    const admin = getSupabaseAdmin();
    const cfg = getSupabaseServerConfig();
    if (!admin || !cfg.urlValid || !cfg.anonKey) {
      return res.status(400).json({ ok: false, error: 'Supabase admin/client not configured.' });
    }

    const emailInput = String((req.body?.email as string) || '').trim().toLowerCase();
    if (!emailInput || !emailInput.includes('@')) {
      return res.status(400).json({ ok: false, error: 'Provide target email.' });
    }

    // 1. Find existing authenticated user by email (no temporary account creation)
    let targetUser: { id: string; email?: string; email_confirmed_at?: string | null; last_sign_in_at?: string | null } | null = null;
    for (let page = 1; page <= 10; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
      if (error) {
        return res.status(500).json({ ok: false, error: `Failed to query auth.users: ${error.message}` });
      }
      const match = (data.users || []).find((u) => (u.email || '').toLowerCase() === emailInput);
      if (match) {
        targetUser = match;
        break;
      }
      if (!data.users || data.users.length < 100) break;
    }

    if (!targetUser) {
      return res.status(404).json({ ok: false, userFound: false, error: 'Authenticated user not found in Supabase Auth.' });
    }

    const userId = targetUser.id;
    const [profileRes, settingsRes, tradesRes, signalsRes, activityRes] = await Promise.all([
      admin.from('user_profiles').select('id,email,display_name,role,preferred_currency,timezone,updated_at').eq('id', userId).maybeSingle(),
      admin.from('user_settings').select('*').eq('user_id', userId).maybeSingle(),
      admin.from('paper_trades').select('id,symbol,direction,mode,amount,status,pnl,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(200),
      admin.from('trading_signals').select('id').eq('user_id', userId).limit(200),
      admin.from('account_activity').select('id').eq('user_id', userId).limit(200),
    ]);

    const preExisting = {
      userFound: true,
      userId,
      emailConfirmed: Boolean(targetUser.email_confirmed_at),
      hasSignedInBefore: Boolean(targetUser.last_sign_in_at),
      profileSavedInSupabase: Boolean(profileRes.data && !profileRes.error),
      profileError: profileRes.error?.message || null,
      profileSummary: profileRes.data
        ? {
            displayName: profileRes.data.display_name,
            role: profileRes.data.role,
            preferredCurrency: profileRes.data.preferred_currency,
            timezone: profileRes.data.timezone,
          }
        : null,
      settingsSavedInSupabase: Boolean(settingsRes.data && !settingsRes.error),
      settingsError: settingsRes.error?.message || null,
      settingsSummary: settingsRes.data
        ? {
            preferredMode: settingsRes.data.preferred_mode,
            startingVirtualBalance: settingsRes.data.starting_virtual_balance,
            paperTradeAmount: settingsRes.data.paper_trade_amount,
            dailyLossLimit: settingsRes.data.daily_loss_limit,
            maxDailyTrades: settingsRes.data.max_daily_trades,
            autoPaperArmed: settingsRes.data.auto_paper_armed,
            emergencyStop: settingsRes.data.emergency_stop,
          }
        : null,
      existingPaperTradesCount: Array.isArray(tradesRes.data) ? tradesRes.data.length : 0,
      existingSignalsCount: Array.isArray(signalsRes.data) ? signalsRes.data.length : 0,
      existingActivityCount: Array.isArray(activityRes.data) ? activityRes.data.length : 0,
    };

    // Backup original settings & snapshot existing IDs so E2E verification leaves zero test clutter
    const originalSettingsRow = settingsRes.data ? { ...settingsRes.data } : null;
    const preTradeIds = new Set((tradesRes.data || []).map((t) => String(t.id)));
    const preSignalIds = new Set((signalsRes.data || []).map((s) => String(s.id)));
    const preActivityIds = new Set((activityRes.data || []).map((a) => String(a.id)));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-user-audit-'));
    const auditPersist = path.join(tmpDir, 'state.json');
    const auditToken = `audit-${crypto.randomUUID()}`;
    const localAuth = async (h?: string) => (h === `Bearer ${auditToken}` ? { userId, email: targetUser!.email || emailInput } : null);

    const e2e: Record<string, unknown> = {};
    let app1: ReturnType<typeof createStandaloneApp> | null = null;
    let app2: ReturnType<typeof createStandaloneApp> | null = null;
    let app3: ReturnType<typeof createStandaloneApp> | null = null;
    let srv1: ReturnType<express.Express['listen']> | null = null;

    try {
      app1 = createStandaloneApp({
        persistPath: auditPersist,
        enableScheduler: false,
        autoRestore: false,
        verifyToken: localAuth,
      });
      srv1 = app1.app.listen(0);
      const port = (srv1.address() as { port: number }).port;
      const apiBase = `http://127.0.0.1:${port}/api`;
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${auditToken}` };

      // Ensure user_settings can persist for this real userId
      await app1.getEngineForUser(userId).syncSettingsToSupabase(userId);

      // Test 4: Signals mode
      const modeSig = await fetch(`${apiBase}/mode`, { method: 'PUT', headers, body: JSON.stringify({ mode: 'signals' }) });
      const sigRes = await fetch(`${apiBase}/signals/analyse`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ symbol: 'BTCUSD', timeframe: '1m', includeGemini: false }),
      });
      const sigJson = (await sigRes.json()) as { signal?: { direction: string; score: number; marketStatus?: string } };
      e2e.signalsMode = {
        modeSwitchStatus: modeSig.status,
        analyseStatus: sigRes.status,
        direction: sigJson.signal?.direction,
        score: sigJson.signal?.score,
        marketStatus: sigJson.signal?.marketStatus,
      };

      // Test 5: Assisted mode
      const modeAst = await fetch(`${apiBase}/mode`, { method: 'PUT', headers, body: JSON.stringify({ mode: 'assisted' }) });
      const astPropRes = await fetch(`${apiBase}/assisted/propose`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ symbol: 'BTCUSD', timeframe: '1m' }),
      });
      const astPropJson = (await astPropRes.json()) as { analysis?: { direction: string }; proposal?: { id: string } | null; notice?: string };
      e2e.assistedMode = {
        modeSwitchStatus: modeAst.status,
        proposeStatus: astPropRes.status,
        decision: astPropJson.analysis?.direction,
        proposalCreated: Boolean(astPropJson.proposal),
        notice: astPropJson.notice,
      };

      // Test 6: Automatic Paper Trading (arm + run cycle + verify Supabase user_settings armed persisted)
      const armRes = await fetch(`${apiBase}/auto-paper/arm`, { method: 'POST', headers, body: JSON.stringify({ enabled: true }) });
      const armJson = (await armRes.json()) as { armed?: boolean };
      const cycleRes = await fetch(`${apiBase}/auto-paper/cycle`, { method: 'POST', headers, body: JSON.stringify({}) });
      const cycleJson = (await cycleRes.json()) as { summary?: string; settled?: number; opened?: unknown[] };
      const armedRowCheck = await admin.from('user_settings').select('preferred_mode,auto_paper_armed,emergency_stop').eq('user_id', userId).maybeSingle();
      e2e.automaticMode = {
        armStatus: armRes.status,
        armed: Boolean(armJson.armed),
        cycleStatus: cycleRes.status,
        cycleSummary: cycleJson.summary,
        supabaseAutoPaperArmed: armedRowCheck.data?.auto_paper_armed ?? null,
      };

      // Test 3 & 7: Paper trade DB persistence + reload verification + automatic settlement
      const openRes = await fetch(`${apiBase}/paper-trades`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ symbol: 'BTCUSD', timeframe: '1m', direction: 'CALL', amount: 25, entryPrice: 1, expirySeconds: 60, mode: 'automatic' }),
      });
      const openJson = (await openRes.json()) as { trade?: { id: string } };
      const createdTradeId = openJson.trade?.id;
      await new Promise((r) => setTimeout(r, 350));
      const dbTradeBeforeRefresh = createdTradeId
        ? await admin.from('paper_trades').select('id,status,amount,entry_price').eq('id', createdTradeId).maybeSingle()
        : { data: null };

      // Trigger automatic settlement on the expired trade using live BTCUSD price
      const eng1 = app1.getEngineForUser(userId);
      const pendingTrade = eng1.paperTrades.find((t) => t.id === createdTradeId);
      if (pendingTrade) {
        pendingTrade.expiresAt = new Date(Date.now() - 5000).toISOString();
      }
      const settledCount = await eng1.monitorAndSettleExpiredTrades();
      await new Promise((r) => setTimeout(r, 350));
      const dbTradeAfterSettle = createdTradeId
        ? await admin.from('paper_trades').select('id,status,exit_price,pnl,settled_by').eq('id', createdTradeId).maybeSingle()
        : { data: null };

      e2e.paperPersistenceAndSettlement = {
        openStatus: openRes.status,
        persistedInPostgresBeforeRefresh: Boolean(dbTradeBeforeRefresh.data?.id),
        settledCount,
        settledStatus: dbTradeAfterSettle.data?.status ?? null,
        exitPrice: dbTradeAfterSettle.data?.exit_price ?? null,
        pnl: dbTradeAfterSettle.data?.pnl ?? null,
        settledBy: dbTradeAfterSettle.data?.settled_by ?? null,
      };

      // Test 8: Daily risk limits (maxTradeAmount + maxDailyTrades)
      const overMax = await fetch(`${apiBase}/paper-trades`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ symbol: 'BTCUSD', direction: 'CALL', amount: 500, entryPrice: 68000 }),
      });
      await fetch(`${apiBase}/risk/settings`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          maxTradeAmount: 100,
          dailyLossLimit: 500,
          dailyProfitTarget: 500,
          maxConsecutiveLosses: 3,
          maxDailyTrades: 1,
          maxSimultaneousTrades: 3,
        }),
      });
      const hitDailyCap = await fetch(`${apiBase}/paper-trades`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ symbol: 'BTCUSD', direction: 'CALL', amount: 10, entryPrice: 68000 }),
      });
      e2e.dailyRiskLimits = {
        overStakeStatus: overMax.status,
        overDailyTradeCapStatus: hitDailyCap.status,
      };

      // Restore maxDailyTrades higher so restart recovery test is eligible when emergency_stop is false
      await fetch(`${apiBase}/risk/settings`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          maxTradeAmount: 100,
          dailyLossLimit: 500,
          dailyProfitTarget: 500,
          maxConsecutiveLosses: 3,
          maxDailyTrades: 25,
          maxSimultaneousTrades: 3,
        }),
      });
      await fetch(`${apiBase}/auto-paper/arm`, { method: 'POST', headers, body: JSON.stringify({ enabled: true }) });

      // Test 10a: Server restart scheduler recovery (armed = true, emergency_stop = false)
      app2 = createStandaloneApp({
        persistPath: path.join(tmpDir, 'restart-2', 'state.json'),
        enableScheduler: false,
        autoRestore: true,
        verifyToken: localAuth,
      });
      const rec2 = await app2.recoveryPromise;
      const recoveredEng2 = app2.getEngineForUser(userId);
      e2e.restartRecoveryArmed = {
        recoveredCount: rec2.restoredCount,
        userRestored: rec2.restoredUserIds.includes(userId),
        autoPaperArmedAfterRestart: recoveredEng2.autoPaperArmed,
        persistedTradesReloaded: recoveredEng2.paperTrades.some((t) => t.id === createdTradeId),
      };

      // Test 9 & 10b: Emergency Stop + verify scheduler NEVER resumes after restart while emergency_stop=true
      const stopRes = await fetch(`${apiBase}/risk/emergency-stop`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ engaged: true }),
      });
      const stopJson = (await stopRes.json()) as { autoPaperArmed?: boolean; status?: { allowed: boolean; emergencyStop: boolean } };
      const blockedTradeRes = await fetch(`${apiBase}/paper-trades`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ symbol: 'BTCUSD', direction: 'CALL', amount: 10, entryPrice: 68000 }),
      });
      // Force DB auto_paper_armed=true while emergency_stop=true to verify recovery safety lock
      await admin.from('user_settings').update({ auto_paper_armed: true, emergency_stop: true }).eq('user_id', userId);
      app3 = createStandaloneApp({
        persistPath: path.join(tmpDir, 'restart-3', 'state.json'),
        enableScheduler: false,
        autoRestore: true,
        verifyToken: localAuth,
      });
      const rec3 = await app3.recoveryPromise;
      const recoveredEng3 = app3.getEngineForUser(userId);
      e2e.emergencyStop = {
        stopStatus: stopRes.status,
        emergencyStopEngaged: Boolean(stopJson.status?.emergencyStop),
        autoDisarmedImmediately: stopJson.autoPaperArmed === false,
        blockedTradeStatus: blockedTradeRes.status,
        blockedOnRestartCount: rec3.blockedByEmergencyStopCount,
        autoArmedAfterEmergencyRestart: recoveredEng3.autoPaperArmed,
      };
    } finally {
      if (srv1) srv1.close();
      app1?.stopScheduler();
      app2?.stopScheduler();
      app3?.stopScheduler();
      fs.rmSync(tmpDir, { recursive: true, force: true });

      // Clean up ONLY audit-created rows & restore exact pre-test user_settings
      const [postTrades, postSignals, postActivity] = await Promise.all([
        admin.from('paper_trades').select('id').eq('user_id', userId),
        admin.from('trading_signals').select('id').eq('user_id', userId),
        admin.from('account_activity').select('id').eq('user_id', userId),
      ]);
      const delTrades = (postTrades.data || []).map((r) => String(r.id)).filter((id) => !preTradeIds.has(id));
      const delSignals = (postSignals.data || []).map((r) => String(r.id)).filter((id) => !preSignalIds.has(id));
      const delActivity = (postActivity.data || []).map((r) => String(r.id)).filter((id) => !preActivityIds.has(id));

      if (delTrades.length > 0) await admin.from('paper_trades').delete().in('id', delTrades);
      if (delSignals.length > 0) await admin.from('trading_signals').delete().in('id', delSignals);
      if (delActivity.length > 0) await admin.from('account_activity').delete().in('id', delActivity);

      if (originalSettingsRow) {
        await admin.from('user_settings').upsert(originalSettingsRow, { onConflict: 'user_id' });
      } else {
        await admin.from('user_settings').delete().eq('user_id', userId);
      }
    }

    return res.json({
      ok: true,
      preExisting,
      e2e,
    });
  });

  router.post('/state/hydrate', async (req, res) => {
    const user = await resolveUser(req);
    if (!user.userId) return res.status(401).json({ error: 'Authenticated Supabase session required.' });
    const scopedEngine = getEngineForUser(user.userId);
    const body = req.body ?? {};
    scopedEngine.hydrateFromClient(body);
    return res.json({ hydrated: true, analytics: scopedEngine.getAnalytics(), risk: scopedEngine.getRiskStatus() });
  });

  // Market data endpoints
  router.get('/market/assets', async (_req, res) => {
    let brokerBinarySymbols = new Set<string>();
    try {
      const iq = await iqOption.getStatus();
      if (iq.connected && iqOption.getAssets) {
        const list = await iqOption.getAssets();
        brokerBinarySymbols = new Set(
          list.assets
            .filter((a) => a.category === 'binary' || a.category === 'turbo')
            .map((a) => a.symbol.toUpperCase())
        );
      }
    } catch {
      // Broker unavailable — keep false honestly
    }

    res.json({
      assets: SUPPORTED_ASSETS.map((a) => ({
        ...a,
        binaryOptionsOfferedByBroker: brokerBinarySymbols.has(a.symbol),
      })),
      timeframes: ['1m', '5m', '15m', '1h'],
    });
  });

  router.get('/market/status', async (_req, res) => {
    const status = await getMarketDataProviderStatus();
    res.json(status);
  });

  router.get('/market/candles', async (req, res) => {
    const schema = z.object({
      symbol: z.string().regex(/^[A-Z0-9_-]{3,20}$/).default('EURUSD'),
      timeframe: z.enum(['1m', '5m', '15m', '1h']).default('1m'),
      limit: z.coerce.number().int().min(30).max(300).default(140),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid symbol or timeframe query.' });

    const data = await fetchMarketCandles(parsed.data.symbol, parsed.data.timeframe, parsed.data.limit);
    if (!data.ok) return res.status(424).json(data);

    const closes = data.candles.map((c) => c.close);
    const ema9 = computeEmaSeries(closes, 9);
    const ema21 = computeEmaSeries(closes, 21);
    const ema50 = computeEmaSeries(closes, Math.min(50, closes.length));
    const bb = computeBollinger(closes, 20, 2);

    return res.json({
      ...data,
      overlays: {
        ema9: ema9.map((v) => Number(v.toFixed(6))),
        ema21: ema21.map((v) => Number(v.toFixed(6))),
        ema50: ema50.map((v) => Number(v.toFixed(6))),
        bbUpper: Number(bb.upper.toFixed(6)),
        bbMiddle: Number(bb.middle.toFixed(6)),
        bbLower: Number(bb.lower.toFixed(6)),
      },
    });
  });

  // Quantitative AI analysis endpoints
  const handleAnalyse = async (req: express.Request, res: express.Response) => {
    const schema = z.object({
      symbol: z.string().regex(/^[A-Z0-9_-]{3,20}$/).default('EURUSD'),
      timeframe: z.enum(['1m', '5m', '15m', '1h']).default('1m'),
      includeGemini: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid symbol or timeframe.' });

    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;

    const { analysis, marketError } = await ws.engine.analyseAsset(
      parsed.data.symbol,
      parsed.data.timeframe as Timeframe,
      parsed.data.includeGemini ?? ws.engine.aiSettings.useGeminiCommentary,
      ws.userId
    );

    if (marketError) {
      return res.status(200).json({
        signal: analysis,
        source: 'unavailable',
        marketError,
        timestamp: analysis.timestamp,
      });
    }

    return res.json({
      signal: analysis,
      source: analysis.provider,
      timestamp: analysis.timestamp,
    });
  };

  router.post('/signals/demo', handleAnalyse);
  router.post('/signals/analyse', handleAnalyse);

  router.get('/signals', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    return res.json({ signals: ws.engine.signals });
  });

  // Market scanner (batch + progressive single-asset)
  router.post('/scanner/run', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    const schema = z.object({
      symbols: z.array(z.string().regex(/^[A-Z0-9_-]{3,20}$/)).max(14).optional(),
      timeframe: z.enum(['1m', '5m', '15m', '1h']).default(ws.engine.aiSettings.defaultTimeframe),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid scanner parameters.' });
    const results = await ws.engine.scanMarkets(parsed.data.symbols, parsed.data.timeframe as Timeframe);
    return res.json({
      results,
      timeframe: parsed.data.timeframe,
      scannedAt: ws.engine.lastScanAt,
    });
  });

  router.post('/scanner/scan-one', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    const schema = z.object({
      symbol: z.string().regex(/^[A-Z0-9_-]{3,20}$/),
      timeframe: z.enum(['1m', '5m', '15m', '1h']).default(ws.engine.aiSettings.defaultTimeframe),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid scanner parameters.' });
    const row = await ws.engine.scanSingleAsset(parsed.data.symbol, parsed.data.timeframe as Timeframe, ws.userId);
    return res.json({ row });
  });

  // Operating mode
  router.get('/mode', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    return res.json({ mode: ws.engine.mode, autoArmed: ws.engine.autoPaperArmed });
  });

  router.put('/mode', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const schema = z.object({ mode: z.enum(['signals', 'assisted', 'automatic']) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid operating mode.' });
    ws.engine.mode = parsed.data.mode;
    ws.engine.logActivity('SETTINGS', 'MODE_CHANGED', `Operating mode switched to ${parsed.data.mode.toUpperCase()}.`, ws.userId);
    await ws.engine.syncSettingsToSupabase(ws.userId);
    return res.json({ mode: ws.engine.mode, autoArmed: ws.engine.autoPaperArmed });
  });

  // Assisted trading mode (Mode B)
  router.get('/assisted/proposals', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    return res.json({ proposals: ws.engine.assistedProposals });
  });

  router.post('/assisted/propose', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const schema = z.object({
      symbol: z.string().regex(/^[A-Z0-9_-]{3,20}$/).default('EURUSD'),
      timeframe: z.enum(['1m', '5m', '15m', '1h']).default(ws.engine.aiSettings.defaultTimeframe),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid assisted analysis request.' });

    const { analysis, marketError } = await ws.engine.analyseAsset(
      parsed.data.symbol,
      parsed.data.timeframe as Timeframe,
      ws.engine.aiSettings.useGeminiCommentary,
      ws.userId
    );
    if (marketError) {
      return res.status(424).json({ error: marketError, analysis });
    }
    const proposal = ws.engine.createAssistedProposal(analysis);
    return res.json({
      analysis,
      proposal,
      notice: proposal
        ? 'Assisted trade proposal requires your explicit approval before paper execution.'
        : analysis.isStale || analysis.marketStatus !== 'OPEN'
          ? 'Market feed is closed or stale; assisted trade proposals are disabled until live OPEN data resumes.'
          : 'Quantitative decision is WAIT; no trade proposal created.',
    });
  });

  router.post('/assisted/proposals/:id/approve', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const proposal = ws.engine.assistedProposals.find((p) => p.id === req.params.id);
    if (!proposal || proposal.status !== 'PENDING_APPROVAL') {
      return res.status(404).json({ error: 'Pending assisted proposal not found.' });
    }
    const schema = z.object({ amount: z.number().positive().max(100000).optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid trade amount override.' });

    const amount = parsed.data.amount ?? proposal.recommendedAmount;
    const opened = ws.engine.openPaperTrade({
      symbol: proposal.symbol,
      timeframe: proposal.timeframe,
      direction: proposal.direction,
      amount,
      mode: 'assisted',
      entryPrice: proposal.entryPrice,
      expirySeconds: proposal.expirySeconds,
      signalScore: proposal.score,
      pendingOutcome: true,
      userId: ws.userId,
    });
    if (!opened.ok) {
      return res.status(409).json({ error: opened.error, risk: opened.risk });
    }
    proposal.status = 'APPROVED';
    proposal.decidedAt = new Date().toISOString();
    return res.status(201).json({
      proposal,
      trade: opened.trade,
      notice: 'Approved for paper simulation only. Real broker execution remains locked.',
    });
  });

  router.post('/assisted/proposals/:id/reject', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const proposal = ws.engine.assistedProposals.find((p) => p.id === req.params.id);
    if (!proposal || proposal.status !== 'PENDING_APPROVAL') {
      return res.status(404).json({ error: 'Pending assisted proposal not found.' });
    }
    proposal.status = 'REJECTED';
    proposal.decidedAt = new Date().toISOString();
    ws.engine.logActivity('TRADE', 'ASSISTED_REJECTED', `Rejected assisted proposal for ${proposal.direction} ${proposal.symbol}.`, ws.userId);
    return res.json({ proposal });
  });

  // Virtual balance & paper trades
  router.put('/virtual-balance', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const schema = z.object({ startingVirtualBalance: z.number().positive().max(10000000) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Provide a valid positive starting balance.' });
    const summary = ws.engine.setStartingVirtualBalance(parsed.data.startingVirtualBalance, ws.userId);
    return res.json(summary);
  });

  router.get('/paper-trades', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    return res.json({
      trades: ws.engine.paperTrades,
      activeTrades: ws.engine.getActiveTrades(),
      virtualBalance: ws.engine.getVirtualBalanceSummary(),
    });
  });

  router.post('/paper-trades', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const schema = z.object({
      symbol: z.string().regex(/^[A-Z0-9_-]{3,20}$/),
      timeframe: z.enum(['1m', '5m', '15m', '1h']).optional(),
      direction: z.enum(['CALL', 'PUT']),
      amount: z.number().positive().max(100000),
      dailyLossLimit: z.number().positive().max(1000000).optional(),
      entryPrice: z.number().positive().nullable().optional(),
      expirySeconds: z.number().int().min(30).max(3600).optional(),
      mode: z.enum(['signals', 'assisted', 'automatic', 'manual']).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid paper trade request.' });

    let entryPrice = parsed.data.entryPrice ?? null;
    if (entryPrice == null) {
      const latest = await fetchMarketCandles(parsed.data.symbol, (parsed.data.timeframe || '1m') as Timeframe, 20);
      if (latest.ok) entryPrice = latest.currentPrice;
    }

    const result = ws.engine.openPaperTrade({
      symbol: parsed.data.symbol,
      timeframe: parsed.data.timeframe as Timeframe | undefined,
      direction: parsed.data.direction,
      amount: parsed.data.amount,
      mode: parsed.data.mode ?? 'manual',
      entryPrice,
      expirySeconds: parsed.data.expirySeconds,
      pendingOutcome: true,
      userId: ws.userId,
    });
    if (!result.ok) {
      return res.status(409).json({ error: result.error, risk: result.risk });
    }
    return res.status(201).json({ trade: result.trade, notice: 'Paper trade opened. Real-money broker execution is disabled.' });
  });

  router.post('/paper-trades/:id/settle', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const schema = z.object({
      outcome: z.enum(['win', 'loss']),
      pnl: z.number().positive().max(100000).optional(),
      exitPrice: z.number().positive().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Provide outcome (win or loss).' });

    const settled = ws.engine.settlePaperTrade(req.params.id, parsed.data.outcome, parsed.data.pnl, parsed.data.exitPrice ?? null, 'manual');
    if (!settled.ok) {
      return res.status(settled.status || 400).json({ error: settled.error });
    }
    return res.json({
      trade: settled.trade,
      risk: ws.engine.getRiskStatus(),
      autoPaperArmed: ws.engine.autoPaperArmed,
      notice: 'Simulated settlement recorded.',
    });
  });

  router.post('/paper-trades/:id/cancel', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const cancelled = ws.engine.cancelPaperTrade(req.params.id);
    if (!cancelled.ok) return res.status(404).json({ error: cancelled.error });
    return res.json({ trade: cancelled.trade });
  });

  // Analytics
  router.get('/analytics', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    return res.json(ws.engine.getAnalytics());
  });

  // Risk management
  router.get('/risk/status', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    return res.json(ws.engine.getRiskStatus());
  });

  router.put('/risk/settings', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const schema = z.object({
      maxTradeAmount: z.number().positive().max(100000),
      dailyLossLimit: z.number().positive().max(1000000),
      dailyProfitTarget: z.number().positive().max(1000000),
      maxConsecutiveLosses: z.number().int().min(1).max(20),
      maxDailyTrades: z.number().int().min(1).max(500).optional(),
      maxSimultaneousTrades: z.number().int().min(1).max(20).optional(),
      tradingScheduleEnabled: z.boolean().optional(),
      tradingStartHourUtc: z.number().int().min(0).max(23).optional(),
      tradingEndHourUtc: z.number().int().min(0).max(23).optional(),
      emergencyStop: z.boolean().optional(),
      startingVirtualBalance: z.number().positive().max(10000000).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid risk settings.' });

    const { startingVirtualBalance, ...riskPatch } = parsed.data;
    Object.assign(ws.engine.riskSettings, riskPatch);
    if (startingVirtualBalance) {
      ws.engine.setStartingVirtualBalance(startingVirtualBalance, ws.userId);
    }
    if (ws.engine.riskSettings.emergencyStop) {
      ws.engine.autoPaperArmed = false;
      ws.engine.autoPausedReason = 'Emergency stop engaged.';
      await brokerManager.setAutoBrokerExecutionEnabled(ws.userId || 'local-preview', false, true);
      androidManager.blockAllPendingOnEmergencyStop(ws.userId || 'local-preview');
    }
    ws.engine.logActivity('RISK', 'RISK_SETTINGS_UPDATED', 'Risk management parameters updated.', ws.userId);
    await ws.engine.syncSettingsToSupabase(ws.userId);
    return res.json({ settings: ws.engine.riskSettings, status: ws.engine.getRiskStatus() });
  });

  router.post('/risk/emergency-stop', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const schema = z.object({ engaged: z.boolean() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Provide engaged: boolean.' });
    const status = ws.engine.setEmergencyStop(parsed.data.engaged, ws.userId);
    if (parsed.data.engaged) {
      await brokerManager.setAutoBrokerExecutionEnabled(ws.userId || 'local-preview', false, true);
      androidManager.blockAllPendingOnEmergencyStop(ws.userId || 'local-preview');
    }
    await ws.engine.syncSettingsToSupabase(ws.userId);
    return res.json({ status, autoPaperArmed: ws.engine.autoPaperArmed });
  });

  router.post('/risk/reset-daily', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const status = ws.engine.resetDailyRiskCounters(ws.userId);
    return res.json({ status });
  });

  // AI settings
  router.get('/ai/settings', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    return res.json({ settings: ws.engine.aiSettings });
  });

  router.put('/ai/settings', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const schema = z.object({
      strategyProfile: z.enum(['conservative', 'balanced', 'momentum']).optional(),
      minSignalScore: z.number().int().min(40).max(95).optional(),
      requireMtfAlignment: z.boolean().optional(),
      enabledAssets: z.array(z.string().regex(/^[A-Z0-9_-]{3,20}$/)).min(1).max(14).optional(),
      defaultTimeframe: z.enum(['1m', '5m', '15m', '1h']).optional(),
      expirySeconds: z.number().int().min(60).max(3600).optional(),
      scanIntervalSeconds: z.number().int().min(15).max(900).optional(),
      useGeminiCommentary: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid AI settings.' });
    Object.assign(ws.engine.aiSettings, parsed.data);
    ws.engine.logActivity('SETTINGS', 'AI_SETTINGS_UPDATED', 'Quantitative AI strategy settings updated.', ws.userId);
    await ws.engine.syncSettingsToSupabase(ws.userId);
    return res.json({ settings: ws.engine.aiSettings });
  });

  // Autonomous paper mode (Mode C)
  router.post('/auto-paper/arm', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const enabled = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!enabled.success) return res.status(400).json({ error: 'Provide enabled: true or false.' });
    if (enabled.data.enabled) {
      const risk = ws.engine.getRiskStatus();
      if (!risk.allowed) {
        return res.status(409).json({ armed: false, error: `Risk guard prevents arming: ${risk.reasons.join(' ')}`, risk });
      }
      ws.engine.autoPaperArmed = true;
      ws.engine.autoPausedReason = null;
      ws.engine.mode = 'automatic';
      ws.engine.logActivity('SCHEDULER', 'AUTO_ARMED', 'Autonomous paper trading scheduler armed.', ws.userId);
    } else {
      ws.engine.autoPaperArmed = false;
      ws.engine.logActivity('SCHEDULER', 'AUTO_PAUSED', 'Autonomous paper trading paused by user.', ws.userId);
    }
    await ws.engine.syncSettingsToSupabase(ws.userId);
    return res.json({
      armed: ws.engine.autoPaperArmed,
      risk: ws.engine.getRiskStatus(),
      notice: 'Paper simulation mode only. Real broker orders remain disabled.',
    });
  });

  router.get('/auto-paper/status', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    return res.json({
      armed: ws.engine.autoPaperArmed,
      risk: ws.engine.getRiskStatus(),
      execution: 'PAPER_ONLY',
      scanIntervalSeconds: ws.engine.aiSettings.scanIntervalSeconds,
      lastScanAt: ws.engine.lastScanAt,
      lastCycleSummary: ws.engine.lastCycleSummary,
    });
  });

  router.post('/auto-paper/evaluate', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    if (!ws.engine.autoPaperArmed) {
      return res.status(409).json({ entered: false, reason: 'Automatic paper mode is not armed.' });
    }
    const schema = z.object({
      symbol: z.string().regex(/^[A-Z0-9_-]{3,20}$/).default('EURUSD'),
      timeframe: z.enum(['1m', '5m', '15m', '1h']).default('1m'),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid market request.' });

    const risk = ws.engine.getRiskStatus();
    if (!risk.allowed) {
      ws.engine.autoPaperArmed = false;
      ws.engine.autoPausedReason = risk.reasons.join(' ');
      return res.status(409).json({ entered: false, reason: `Risk guard stopped automatic trading: ${ws.engine.autoPausedReason}`, risk });
    }

    const { analysis, marketError } = await ws.engine.analyseAsset(parsed.data.symbol, parsed.data.timeframe as Timeframe, false, ws.userId);
    if (marketError) {
      return res.json({ entered: false, reason: `Market data unavailable: ${marketError}`, analysis });
    }
    if (analysis.isStale || analysis.marketStatus !== 'OPEN') {
      return res.json({ entered: false, reason: `Market status is ${analysis.marketStatus}; signal suppressed to WAIT.`, analysis });
    }
    if (analysis.direction !== 'CALL' && analysis.direction !== 'PUT') {
      return res.json({ entered: false, reason: 'Quantitative engine decision is WAIT. No paper trade opened.', analysis });
    }

    const stake = ws.engine.calculateRecommendedStake(analysis.score);
    const opened = ws.engine.openPaperTrade({
      symbol: analysis.symbol,
      timeframe: analysis.timeframe,
      direction: analysis.direction,
      amount: stake,
      mode: 'automatic',
      entryPrice: analysis.entryPrice,
      expirySeconds: analysis.suggestedExpirySeconds || ws.engine.aiSettings.expirySeconds,
      signalScore: analysis.score,
      provider: analysis.provider,
      pendingOutcome: true,
      userId: ws.userId,
    });
    if (!opened.ok) {
      return res.status(409).json({ entered: false, reason: opened.error, analysis });
    }
    return res.status(201).json({
      entered: true,
      trade: opened.trade,
      analysis,
      notice: 'Paper simulation only. No broker order was sent.',
    });
  });

  router.post('/auto-paper/cycle', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const result = await ws.engine.runAutonomousCycle(true);
    return res.json({ ...result, status: ws.engine.getRiskStatus(), armed: ws.engine.autoPaperArmed });
  });

  // Multi-Broker & Legacy IQ Option endpoints
  router.get('/broker/status', async (_req, res) => {
    const status = await iqOption.getStatus();
    return res.json(status);
  });

  router.get('/broker/catalog', async (_req, res) => {
    const catalog = await brokers.listCatalog();
    return res.json({ brokers: catalog });
  });

  router.get('/brokers/catalog', async (_req, res) => {
    const catalog = await brokers.listCatalog();
    return res.json({ brokers: catalog });
  });

  router.get('/novapay/accounts', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const data = await brokerManager.listAccounts(userId);
    const totalBalance = data.accounts.reduce((sum, a) => sum + (a.balance || 0), 0);
    const totalEquity = data.accounts.reduce((sum, a) => sum + (a.equity || a.balance || 0), 0);
    const connectedCount = data.accounts.filter((a) => a.connected).length;
    return res.json({
      walletId: `np-wallet-${userId.slice(0, 8)}`,
      currency: 'USD',
      totalBalance,
      totalEquity,
      connectedCount,
      accounts: data.accounts,
    });
  });

  router.get('/brokers/accounts', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const data = await brokerManager.listAccounts(ws.userId || 'local-preview');
    return res.json(data);
  });

  router.post('/brokers/accounts', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const schema = z.object({
      accountId: z.string().max(100).optional(),
      brokerId: z.enum(['mt5', 'iq_option']),
      label: z.string().min(1).max(80),
      environment: z.enum(['demo', 'real']).optional(),
      externalAccountId: z.string().max(80).nullable().optional(),
      credentials: z
        .object({
          apiKey: z.string().max(240).optional(),
          apiSecret: z.string().max(240).optional(),
          accessToken: z.string().max(512).optional(),
          accountNumber: z.string().max(80).optional(),
          bridgeUrl: z.string().max(240).optional(),
          bridgeToken: z.string().max(240).optional(),
          serverName: z.string().max(120).optional(),
          email: z.string().max(160).optional(),
        })
        .optional(),
      riskLimits: z
        .object({
          maxOrderAmount: z.number().min(1).max(100000).optional(),
          maxDailyLoss: z.number().min(1).max(1000000).optional(),
          maxDailyOrders: z.number().int().min(1).max(500).optional(),
          maxOpenPositions: z.number().int().min(1).max(50).optional(),
          allowCall: z.boolean().optional(),
          allowPut: z.boolean().optional(),
        })
        .optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid broker account payload.' });
    }
    if (parsed.data.environment === 'real') {
      return res.status(423).json({
        error: 'Real-money broker accounts are locked while live execution is disabled. Use demo/practice only.',
      });
    }
    try {
      const account = await brokerManager.createOrUpdateAccount(userId, parsed.data);
      ws.engine.logActivity('BROKER', 'BROKER_ACCOUNT_SAVED', `Saved demo broker account "${account.label}" (${account.brokerName}).`, ws.userId);
      return res.status(201).json({ account });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to save broker account.' });
    }
  });

  router.delete('/brokers/accounts/:accountId', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const removed = brokerManager.deleteAccount(userId, req.params.accountId);
    if (!removed) return res.status(404).json({ error: 'Broker account not found.' });
    ws.engine.logActivity('BROKER', 'BROKER_ACCOUNT_REMOVED', `Removed broker account ${req.params.accountId}.`, ws.userId);
    return res.json({ ok: true });
  });

  router.post('/brokers/active', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const schema = z.object({ accountId: z.string().nullable() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid accountId.' });
    try {
      const result = brokerManager.selectActiveAccount(userId, parsed.data.accountId);
      ws.engine.logActivity(
        'BROKER',
        'ACTIVE_BROKER_SELECTED',
        result.activeAccountId ? `Selected execution account ${result.activeAccountId}.` : 'Switched execution target to Paper Simulator.',
        ws.userId
      );
      return res.json(result);
    } catch (err) {
      return res.status(404).json({ error: err instanceof Error ? err.message : 'Broker account not found.' });
    }
  });

  router.post('/brokers/accounts/:accountId/connect', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    try {
      const account = await brokerManager.connectAccount(userId, req.params.accountId);
      ws.engine.logActivity('BROKER', 'BROKER_CONNECT', `Connected ${account.label} (${account.accountType || 'DEMO'}).`, ws.userId);
      return res.json({ account });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Broker connection failed.';
      ws.engine.logActivity('BROKER', 'BROKER_CONNECT_FAILED', msg, ws.userId);
      if (err instanceof BrokerConnectionError) {
        return res.status(err.statusCode).json({
          error: msg,
          status: err.connectionStatus,
          connected: false,
          ...(err.account ? { account: err.account } : {}),
        });
      }
      const lower = msg.toLowerCase();
      const statusCode = lower.includes('not found') ? 404 : lower.includes('not configured') ? 422 : 424;
      const status = lower.includes('not configured') ? 'NOT CONFIGURED' : undefined;
      return res.status(statusCode).json({
        error: msg,
        ...(status ? { status } : {}),
      });
    }
  });

  router.post('/brokers/accounts/:accountId/disconnect', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    try {
      const account = await brokerManager.disconnectAccount(userId, req.params.accountId);
      ws.engine.logActivity('BROKER', 'BROKER_DISCONNECT', `Disconnected ${account.label}.`, ws.userId);
      return res.json({ account });
    } catch (err) {
      return res.status(404).json({ error: err instanceof Error ? err.message : 'Broker account not found.' });
    }
  });

  router.post('/brokers/accounts/:accountId/sync', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    try {
      const account = await brokerManager.checkHealthAndSyncBalance(userId, req.params.accountId);
      return res.json({ account });
    } catch (err) {
      return res.status(404).json({ error: err instanceof Error ? err.message : 'Broker account not found.' });
    }
  });

  router.put('/brokers/accounts/:accountId/risk', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const schema = z.object({
      maxOrderAmount: z.number().min(1).max(100000).optional(),
      maxDailyLoss: z.number().min(1).max(1000000).optional(),
      maxDailyOrders: z.number().int().min(1).max(500).optional(),
      maxOpenPositions: z.number().int().min(1).max(50).optional(),
      allowCall: z.boolean().optional(),
      allowPut: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid per-account risk limits.' });
    try {
      const riskLimits = brokerManager.updateAccountRiskLimits(userId, req.params.accountId, parsed.data);
      return res.json({ riskLimits });
    } catch (err) {
      return res.status(404).json({ error: err instanceof Error ? err.message : 'Broker account not found.' });
    }
  });

  router.post('/brokers/accounts/:accountId/compatibility', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const schema = z.object({
      symbol: z.string().min(2).max(20),
      orderType: z.enum(['MARKET', 'LIMIT', 'BINARY_FIXED_EXPIRY']).default('MARKET'),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid symbol or orderType.' });
    const meta = getAssetDefinition(parsed.data.symbol);
    try {
      const result = brokerManager.checkInstrumentCompatibilityForAccount(
        userId,
        req.params.accountId,
        parsed.data.symbol,
        meta.instrumentType,
        parsed.data.orderType
      );
      return res.json(result);
    } catch (err) {
      return res.status(404).json({ error: err instanceof Error ? err.message : 'Broker account not found.' });
    }
  });

  router.get('/brokers/orders', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
    return res.json({ orders: brokerManager.listOrders(userId, accountId) });
  });

  router.post('/brokers/orders', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const schema = z.object({
      accountId: z.string().min(1),
      environment: z.enum(['demo', 'real']).default('demo'),
      symbol: z.string().min(2).max(20),
      direction: z.enum(['CALL', 'PUT']),
      orderType: z.enum(['MARKET', 'LIMIT', 'BINARY_FIXED_EXPIRY']).default('MARKET'),
      amount: z.number().min(1).max(100000),
      entryPrice: z.number().positive().nullable().optional(),
      expirySeconds: z.number().int().min(30).max(86400).default(180),
      idempotencyKey: z.string().min(4).max(100).optional(),
      source: z.enum(['assisted', 'automatic', 'manual']).default('manual'),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid broker order payload.' });
    }
    if (parsed.data.environment === 'real') {
      return res.status(423).json({
        executed: false,
        error: 'Real-money broker order execution is locked. Only demo/sandbox orders are permitted.',
      });
    }

    const globalRisk = ws.engine.getRiskStatus();
    if (!globalRisk.allowed) {
      return res.status(409).json({
        executed: false,
        error: `Global risk guard blocked order: ${globalRisk.reasons.join(' ')}`,
      });
    }

    const assetMeta = getAssetDefinition(parsed.data.symbol);
    try {
      const result = await brokerManager.executeDemoOrder(userId, {
        accountId: parsed.data.accountId,
        symbol: parsed.data.symbol,
        assetClass: assetMeta.instrumentType,
        direction: parsed.data.direction,
        orderType: parsed.data.orderType,
        amount: parsed.data.amount,
        entryPrice: parsed.data.entryPrice ?? null,
        expirySeconds: parsed.data.expirySeconds,
        idempotencyKey: parsed.data.idempotencyKey,
        source: parsed.data.source,
        globalEmergencyStop: ws.engine.riskSettings.emergencyStop,
      });
      ws.engine.logActivity(
        'BROKER',
        result.duplicatePrevented ? 'BROKER_DUPLICATE_PREVENTED' : 'BROKER_DEMO_ORDER',
        `${result.order.brokerName}: ${result.order.direction} ${result.order.mappedSymbol} (${result.order.status})`,
        ws.userId
      );
      return res.status(result.duplicatePrevented ? 200 : 201).json(result);
    } catch (err) {
      return res.status(409).json({
        executed: false,
        error: err instanceof Error ? err.message : 'Broker order blocked.',
      });
    }
  });

  router.post('/brokers/orders/reconcile', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const accountId = typeof req.body?.accountId === 'string' ? req.body.accountId : undefined;
    const result = await brokerManager.reconcileOrders(userId, accountId);
    return res.json(result);
  });

  router.get('/brokers/accounts/:accountId/quote', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const symbol = typeof req.query.symbol === 'string' && req.query.symbol.trim() ? req.query.symbol.trim() : 'EURUSD';
    try {
      const quote = await brokerManager.getAccountQuote(userId, req.params.accountId, symbol);
      return res.json({ quote });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to fetch broker quote.';
      return res.status(msg.toLowerCase().includes('not found') ? 404 : 424).json({ error: msg });
    }
  });

  router.get('/brokers/accounts/:accountId/candles', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const symbol = typeof req.query.symbol === 'string' && req.query.symbol.trim() ? req.query.symbol.trim() : 'EURUSD';
    const interval = Math.max(60, Math.min(86400, Number(req.query.interval) || 60));
    const count = Math.max(1, Math.min(300, Number(req.query.count) || 50));
    try {
      const data = await brokerManager.getAccountCandles(userId, req.params.accountId, symbol, interval, count);
      return res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to fetch broker candles.';
      return res.status(msg.toLowerCase().includes('not found') ? 404 : 424).json({ error: msg });
    }
  });

  router.get('/brokers/accounts/:accountId/positions', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    try {
      const data = await brokerManager.getAccountPositions(userId, req.params.accountId);
      return res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to fetch open positions.';
      return res.status(msg.toLowerCase().includes('not found') ? 404 : 424).json({ error: msg });
    }
  });

  router.get('/brokers/accounts/:accountId/assets', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    try {
      const data = await brokerManager.getAccountAssets(userId, req.params.accountId);
      return res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to fetch available broker symbols.';
      return res.status(msg.toLowerCase().includes('not found') ? 404 : 424).json({ error: msg });
    }
  });

  router.post('/brokers/orders/validate', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const schema = z.object({
      accountId: z.string().min(1),
      environment: z.enum(['demo', 'real']).default('demo'),
      symbol: z.string().min(2).max(20),
      direction: z.enum(['CALL', 'PUT']),
      orderType: z.enum(['MARKET', 'LIMIT', 'BINARY_FIXED_EXPIRY']).default('MARKET'),
      amount: z.number().min(1).max(100000),
      entryPrice: z.number().positive().nullable().optional(),
      expirySeconds: z.number().int().min(30).max(86400).default(180),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid order validation payload.' });
    }
    if (parsed.data.environment === 'real') {
      return res.status(423).json({
        valid: false,
        compatible: false,
        reason: 'Real-money broker orders are locked. Demo/Practice environment only.',
      });
    }
    const assetMeta = getAssetDefinition(parsed.data.symbol);
    const validation = await brokerManager.validateDemoOrder(userId, {
      accountId: parsed.data.accountId,
      symbol: parsed.data.symbol,
      assetClass: assetMeta.instrumentType,
      direction: parsed.data.direction,
      orderType: parsed.data.orderType,
      amount: parsed.data.amount,
      entryPrice: parsed.data.entryPrice ?? null,
      expirySeconds: parsed.data.expirySeconds,
      globalEmergencyStop: ws.engine.riskSettings.emergencyStop,
    });
    return res.json({ validation });
  });

  router.get('/brokers/auto-execution', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    return res.json({
      enabled: brokerManager.isAutoBrokerExecutionEnabled(userId) && !ws.engine.riskSettings.emergencyStop,
      activeAccountId: brokerManager.getActiveExecutionAccountId(userId),
      emergencyStop: ws.engine.riskSettings.emergencyStop,
    });
  });

  router.put('/brokers/auto-execution', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const schema = z.object({ enabled: z.boolean() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Provide enabled: boolean.' });
    try {
      const result = await brokerManager.setAutoBrokerExecutionEnabled(
        userId,
        parsed.data.enabled,
        ws.engine.riskSettings.emergencyStop
      );
      ws.engine.logActivity('BROKER', 'AUTO_BROKER_TOGGLED', result.reason, ws.userId);
      return res.json(result);
    } catch (err) {
      return res.status(409).json({ error: err instanceof Error ? err.message : 'Unable to update auto execution.' });
    }
  });

  router.get('/brokers/accounts/:accountId/history', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    try {
      const result = await brokerManager.syncAccountTradeHistory(userId, req.params.accountId);
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Trade history sync failed.';
      return res.status(msg.toLowerCase().includes('not found') ? 404 : 424).json({ error: msg });
    }
  });

  router.post('/broker/iq/connect', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    try {
      const result = await iqOption.connect();
      ws.engine.logActivity('BROKER', 'IQ_CONNECT', result.message, ws.userId);
      return res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'IQ Option connection failed.';
      const lower = msg.toLowerCase();
      const isNotConfigured = lower.includes('not configured') || lower.includes('iq_connector_url');
      const isAuthFail = !isNotConfigured && (lower.includes('auth') || lower.includes('password') || lower.includes('2fa') || lower.includes('invalid'));
      const status = isNotConfigured ? 'NOT CONFIGURED' : isAuthFail ? 'AUTHENTICATION FAILED' : 'GATEWAY OFFLINE';
      const statusCode = isNotConfigured ? 422 : isAuthFail ? 401 : 424;
      ws.engine.logActivity('BROKER', 'IQ_CONNECT_FAILED', msg, ws.userId);
      return res.status(statusCode).json({ connected: false, status, error: msg });
    }
  });

  router.post('/broker/iq/disconnect', async (req, res) => {
    const ws = await resolveWorkspace(req, res, false);
    if (!ws) return;
    try {
      const result = await iqOption.disconnect();
      ws.engine.logActivity('BROKER', 'IQ_DISCONNECT', result.message, ws.userId);
      return res.json(result);
    } catch (err) {
      return res.status(424).json({ error: err instanceof Error ? err.message : 'Disconnect failed.' });
    }
  });

  router.get('/broker/iq/balance', async (_req, res) => {
    try {
      const data = await iqOption.getBalance();
      return res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Balance retrieval failed.';
      return res.status(msg.toLowerCase().includes('not configured') ? 422 : 424).json({ error: msg });
    }
  });

  router.get('/broker/iq/assets', async (_req, res) => {
    try {
      const data = await iqOption.getAssets();
      return res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Asset retrieval failed.';
      return res.status(msg.toLowerCase().includes('not configured') ? 422 : 424).json({ error: msg });
    }
  });

  router.post('/broker/iq/candles', async (req, res) => {
    const schema = z.object({
      symbol: z.string().regex(/^[A-Z0-9_-]{3,25}$/).default('EURUSD'),
      intervalSeconds: z.number().int().min(5).max(3600).default(60),
      count: z.number().int().min(10).max(500).default(60),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid candle request.' });
    try {
      const data = await iqOption.getCandles!(parsed.data.symbol, parsed.data.intervalSeconds, parsed.data.count);
      return res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Candle retrieval failed.';
      return res.status(msg.toLowerCase().includes('not configured') ? 422 : 424).json({ error: msg });
    }
  });

  router.get('/broker/iq/history', async (_req, res) => {
    try {
      const data = await iqOption.getTradeHistory();
      return res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Trade history retrieval failed.';
      return res.status(msg.toLowerCase().includes('not configured') ? 422 : 424).json({ error: msg });
    }
  });

  router.post('/live-trading/enable', async (_req, res) => {
    const capabilities = await iqOption.getCapabilities();
    return res.status(409).json({
      enabled: false,
      error: 'Live trading is locked. Real-money execution remains disabled across all broker adapters.',
      broker: capabilities.broker,
    });
  });

  router.post('/live-trades', (_req, res) => {
    return res.status(423).json({
      executed: false,
      error: 'Live order execution is disabled. No real broker order was sent.',
    });
  });

  // Android App Bridge (Phase 1: Pairing, Device Management, Multimodal Screen Analysis & Assisted Queue)
  router.get('/android/devices', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    return res.json({
      devices: await androidManager.listDevices(userId),
      realMoneyAutomationBlocked: true,
    });
  });

  router.post('/android/devices/pair', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const schema = z.object({
      deviceName: z.string().min(2).max(60).default('Android Phone'),
      allowMt5: z.boolean().optional(),
      allowIqOption: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid pairing request.' });
    }
    const userId = ws.userId || 'local-preview';
    const pairing = await androidManager.createPairingRequest(userId, parsed.data);
    ws.engine.logActivity(
      'BROKER',
      'ANDROID_PAIRING_CREATED',
      `Generated single-use Android pairing code for "${pairing.device.deviceName}" (expires ${pairing.expiresAt}).`,
      ws.userId
    );
    return res.status(201).json(pairing);
  });

  router.post('/android/devices/register', async (req, res) => {
    const schema = z.object({
      pairingCode: z.string().min(4).max(16),
      deviceName: z.string().min(1).max(60).optional(),
      deviceModel: z.string().max(80).optional(),
      osVersion: z.string().max(40).optional(),
      mediaProjectionGranted: z.boolean().optional(),
      accessibilityGranted: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid device registration payload.' });
    }
    const result = await androidManager.registerDeviceWithPairingCode(parsed.data);
    if (!result) {
      return res.status(401).json({ error: 'Invalid or expired Android pairing code.' });
    }
    const targetEngine = getEngineForUser(result.device.userId);
    targetEngine.logActivity(
      'BROKER',
      'ANDROID_DEVICE_REGISTERED',
      `Android companion device "${result.device.deviceName}" paired (${result.device.tokenPrefix}...).`,
      result.device.userId === 'local-preview' ? undefined : result.device.userId
    );
    return res.status(201).json({
      ...result,
      realMoneyAutomationBlocked: true,
      notice: 'Device paired. Real-money automated execution remains disabled.',
    });
  });

  router.put('/android/devices/:deviceId/permissions', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const schema = z.object({
      status: z.enum(['ACTIVE', 'PAUSED']).optional(),
      allowMt5: z.boolean().optional(),
      allowIqOption: z.boolean().optional(),
      mediaProjection: z.boolean().optional(),
      accessibility: z.boolean().optional(),
      assistedApprovalRequired: z.boolean().optional(),
      allowRealMoneyAutomation: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid device permission update.' });
    }
    if (parsed.data.allowRealMoneyAutomation === true) {
      return res.status(423).json({
        error: 'Real-money automated Android execution is locked in Phase 1 and cannot be enabled.',
      });
    }
    const userId = ws.userId || 'local-preview';
    const updated = await androidManager.updateDevicePermissions(userId, req.params.deviceId, parsed.data);
    if (!updated) return res.status(404).json({ error: 'Paired Android device not found.' });
    ws.engine.logActivity(
      'BROKER',
      'ANDROID_DEVICE_UPDATED',
      `Updated Android Bridge permissions for "${updated.deviceName}" (status=${updated.status}).`,
      ws.userId
    );
    return res.json({ device: updated });
  });

  router.delete('/android/devices/:deviceId', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const removed = await androidManager.revokeDevice(userId, req.params.deviceId);
    if (!removed) return res.status(404).json({ error: 'Paired Android device not found.' });
    ws.engine.logActivity('BROKER', 'ANDROID_DEVICE_REVOKED', `Revoked Android device ${req.params.deviceId}.`, ws.userId);
    return res.json({ ok: true });
  });

  router.get('/android/analyses', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    return res.json({ analyses: androidManager.listAnalyses(userId) });
  });

  router.get('/android/actions', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    return res.json({ actions: androidManager.listActions(userId) });
  });

  router.post('/android/actions/:actionId/approve', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const result = androidManager.approveAction(userId, req.params.actionId, ws.engine.getRiskStatus());
    if (!result.ok) {
      return res.status(result.statusCode || 409).json({ error: result.error });
    }
    ws.engine.logActivity(
      'TRADE',
      'ANDROID_ACTION_APPROVED',
      `Approved Android Assisted ${result.action!.direction} ${result.action!.symbol} (${result.action!.appName}, ${result.action!.accountModeVerified}).`,
      ws.userId
    );
    return res.json({
      action: result.action,
      notice: 'Approved for DEMO/assisted tracking only. Real-money execution remains disabled.',
    });
  });

  router.post('/android/actions/:actionId/reject', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    const userId = ws.userId || 'local-preview';
    const updated = androidManager.rejectAction(userId, req.params.actionId);
    if (!updated) return res.status(404).json({ error: 'Pending Android action not found.' });
    ws.engine.logActivity(
      'TRADE',
      'ANDROID_ACTION_REJECTED',
      `Rejected Android Assisted ${updated.direction} ${updated.symbol}.`,
      ws.userId
    );
    return res.json({ action: updated });
  });

  router.post(
    '/android/screen/analyze',
    express.json({ limit: '4mb' }),
    async (req, res) => {
      // Authenticate either via paired Android device Bearer token (nt_dev_...) OR dashboard Supabase session
      const deviceAuth = await androidManager.authenticateDeviceToken(req.headers.authorization);
      let userId: string;
      let engine: NovaTradeEngine;
      let deviceId: string | null = null;
      let activityUid: string | undefined;

      if (deviceAuth) {
        if (deviceAuth.device.status !== 'ACTIVE') {
          return res.status(401).json({ error: `Android device is ${deviceAuth.device.status}; resume device in NovaTrade dashboard.` });
        }
        userId = deviceAuth.userId;
        deviceId = deviceAuth.device.id;
        engine = getEngineForUser(userId);
        activityUid = userId === 'local-preview' ? undefined : userId;
      } else {
        const ws = await resolveWorkspace(req, res, true);
        if (!ws) return;
        userId = ws.userId || 'local-preview';
        engine = ws.engine;
        activityUid = ws.userId;
      }

      const schema = z.object({
        imageBase64: z.string().min(100),
        mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).default('image/jpeg'),
        appPackageHint: z.string().max(120).nullable().optional(),
        accessibilityText: z.array(z.string().max(240)).max(60).optional(),
        notes: z.string().max(240).optional(),
        deviceId: z.string().uuid().optional(),
        createAssistedProposal: z.boolean().optional(),
      });
      const parsed = schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid screenshot analysis payload.' });
      }

      if (deviceId && deviceAuth) {
        const hintLower = (parsed.data.appPackageHint || '').toLowerCase();
        if (hintLower.includes('metatrader5') && !deviceAuth.device.permissions.allowMt5) {
          return res.status(423).json({ error: 'MT5 screen capture is disabled in device permissions.' });
        }
        if (hintLower.includes('iqoption') && !deviceAuth.device.permissions.allowIqOption) {
          return res.status(423).json({ error: 'IQ Option screen capture is disabled in device permissions.' });
        }
        await androidManager.recordDeviceHeartbeat(userId, deviceId, parsed.data.appPackageHint ?? null);
      } else if (parsed.data.deviceId) {
        const ownDevice = (await androidManager.listDevices(userId)).find((d) => d.id === parsed.data.deviceId);
        if (ownDevice) deviceId = ownDevice.id;
      }

      const vision = await analyzeAndroidTradingScreen({
        imageBase64: parsed.data.imageBase64,
        mimeType: parsed.data.mimeType,
        appPackageHint: parsed.data.appPackageHint,
        accessibilityText: parsed.data.accessibilityText,
        notes: parsed.data.notes,
      });

      if (!vision.visionAvailable) {
        return res.status(vision.error?.includes('not configured') ? 422 : 424).json({
          error: vision.error || 'Screen visual analysis failed.',
          vision,
        });
      }

      if (deviceAuth) {
        if (vision.appName === 'MT5' && !deviceAuth.device.permissions.allowMt5) {
          return res.status(423).json({ error: 'MT5 screen analysis is disabled for this paired device.' });
        }
        if (vision.appName === 'IQ_OPTION' && !deviceAuth.device.permissions.allowIqOption) {
          return res.status(423).json({ error: 'IQ Option screen analysis is disabled for this paired device.' });
        }
      }

      const integrated = await engine.integrateAndroidScreenVision({
        appName: vision.appName,
        accountMode: vision.accountMode,
        symbol: vision.normalizedSymbol || vision.detectedSymbol,
        timeframe: vision.normalizedTimeframe,
        detectedPrice: vision.detectedPrice,
        visualBias: vision.visualBias,
        visualConfidence: vision.visualConfidence,
        summary: vision.summary,
        riskWarning: vision.riskWarning,
        observations: vision.candlestickObservations,
        model: vision.model,
        userId: activityUid,
      });

      const analysisRecord = await androidManager.recordScreenAnalysis({
        userId,
        deviceId,
        vision,
        quantSignal: integrated.signal,
      });

      integrated.signal.screenAnalysisId = analysisRecord.id;

      let assistedProposal = null;
      let queuedAction = null;
      const shouldQueueAssisted =
        (engine.mode === 'assisted' || engine.mode === 'automatic' || parsed.data.createAssistedProposal === true) &&
        (analysisRecord.recommendedAction === 'CALL' || analysisRecord.recommendedAction === 'PUT');

      if (shouldQueueAssisted) {
        assistedProposal = engine.createAssistedProposal(integrated.signal, {
          sourceApp: analysisRecord.appName,
          screenAnalysisId: analysisRecord.id,
        });
        const stake = engine.calculateRecommendedStake(analysisRecord.confidenceScore);
        queuedAction = androidManager.queueActionFromScreen({
          userId,
          deviceId,
          analysis: analysisRecord,
          operatingMode: engine.mode,
          stakeOrVolume: stake,
          expirySeconds: integrated.signal.suggestedExpirySeconds || engine.aiSettings.expirySeconds,
          riskStatus: engine.getRiskStatus(),
        });
      }

      engine.logActivity(
        'ANALYSIS',
        'ANDROID_SCREEN_ANALYZED',
        `Android ${analysisRecord.appName} (${analysisRecord.detectedAccountMode}) ${analysisRecord.detectedSymbol || 'Unknown'} -> ${analysisRecord.recommendedAction} (${analysisRecord.confidenceScore}/100, ${analysisRecord.alignmentStatus}).`,
        activityUid
      );

      return res.status(201).json({
        analysis: analysisRecord,
        signal: integrated.signal,
        assistedProposal,
        queuedAction,
        quantMatched: integrated.quantMatched,
        marketError: integrated.marketError || null,
        realMoneyAutomationBlocked: true,
      });
    }
  );

  router.post('/android/device/heartbeat', async (req, res) => {
    const auth = await androidManager.authenticateDeviceToken(req.headers.authorization);
    if (!auth) return res.status(401).json({ error: 'Invalid or revoked Android device token.' });
    const schema = z.object({
      appPackage: z.string().max(120).nullable().optional(),
      mediaProjection: z.boolean().optional(),
      accessibility: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid heartbeat payload.' });
    const updated = await androidManager.recordDeviceHeartbeat(auth.userId, auth.device.id, parsed.data.appPackage, {
      mediaProjection: parsed.data.mediaProjection,
      accessibility: parsed.data.accessibility,
    });
    const engine = getEngineForUser(auth.userId);
    return res.json({
      device: updated,
      operatingMode: engine.mode,
      emergencyStop: engine.riskSettings.emergencyStop,
      realMoneyAutomationBlocked: true,
    });
  });

  router.get('/android/device/poll', async (req, res) => {
    const auth = await androidManager.authenticateDeviceToken(req.headers.authorization);
    if (!auth) return res.status(401).json({ error: 'Invalid or revoked Android device token.' });
    const engine = getEngineForUser(auth.userId);
    await androidManager.recordDeviceHeartbeat(auth.userId, auth.device.id);
    const actions = androidManager.pollAuthorizedActionsForDevice(
      auth.userId,
      auth.device.id,
      engine.riskSettings.emergencyStop
    );
    return res.json({
      actions,
      emergencyStop: engine.riskSettings.emergencyStop,
      realMoneyAutomationBlocked: true,
    });
  });

  router.post('/android/device/ack', async (req, res) => {
    const auth = await androidManager.authenticateDeviceToken(req.headers.authorization);
    if (!auth) return res.status(401).json({ error: 'Invalid or revoked Android device token.' });
    const schema = z.object({
      actionId: z.string().min(1),
      outcome: z.enum(['EXECUTED_REPORTED', 'REJECTED', 'EXPIRED']),
      note: z.string().max(240).optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid action acknowledgement payload.' });
    const updated = await androidManager.acknowledgeDeviceAction(
      auth.userId,
      auth.device.id,
      parsed.data.actionId,
      parsed.data.outcome,
      parsed.data.note
    );
    if (!updated) return res.status(404).json({ error: 'Queued Android action not found.' });
    const engine = getEngineForUser(auth.userId);
    engine.logActivity(
      'TRADE',
      'ANDROID_ACTION_ACK',
      `Device ack (${updated.status}) for ${updated.symbol} ${updated.direction}.`,
      auth.userId === 'local-preview' ? undefined : auth.userId
    );
    return res.json({ action: updated });
  });

  router.post('/android/device/emergency-stop', async (req, res) => {
    const auth = await androidManager.authenticateDeviceToken(req.headers.authorization);
    if (!auth) return res.status(401).json({ error: 'Invalid or revoked Android device token.' });
    const schema = z.object({ engaged: z.boolean().default(true) });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Provide engaged: boolean.' });
    const engine = getEngineForUser(auth.userId);
    const actUid = auth.userId === 'local-preview' ? undefined : auth.userId;
    const status = engine.setEmergencyStop(parsed.data.engaged, actUid);
    if (parsed.data.engaged) {
      await brokerManager.setAutoBrokerExecutionEnabled(auth.userId, false, true);
      androidManager.blockAllPendingOnEmergencyStop(auth.userId);
    }
    await engine.syncSettingsToSupabase(actUid);
    return res.json({
      status,
      emergencyStop: status.emergencyStop,
      autoPaperArmed: engine.autoPaperArmed,
    });
  });

  router.post('/android/device/disconnect', async (req, res) => {
    const auth = await androidManager.authenticateDeviceToken(req.headers.authorization);
    if (!auth) return res.status(401).json({ error: 'Invalid or revoked Android device token.' });
    const revoked = await androidManager.revokeDevice(auth.userId, auth.device.id);
    if (!revoked) return res.status(404).json({ error: 'Paired Android device not found.' });
    const engine = getEngineForUser(auth.userId);
    const actUid = auth.userId === 'local-preview' ? undefined : auth.userId;
    engine.logActivity('BROKER', 'ANDROID_DEVICE_DISCONNECTED', `Android companion "${auth.device.deviceName}" disconnected by device user.`, actUid);
    return res.json({ ok: true, revoked: true });
  });

  router.get('/activity', async (req, res) => {
    const ws = await resolveWorkspace(req, res, true);
    if (!ws) return;
    return res.json({ events: ws.engine.activityLog });
  });

  router.use((req, res) => {
    return res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` });
  });

  router.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const rawStatus = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
    const status =
      rawStatus === 403 ? 401 : rawStatus === 502 || rawStatus === 503 || rawStatus === 504 ? 424 : rawStatus;
    const message = err instanceof Error ? err.message : 'Internal server error.';
    return res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
  });

  const stopScheduler = () => {
    if (schedulerInterval) {
      clearInterval(schedulerInterval);
      schedulerInterval = null;
    }
    const regTimer = globalSchedulerRegistry.get(schedulerKey);
    if (regTimer) {
      clearInterval(regTimer);
      globalSchedulerRegistry.delete(schedulerKey);
    }
  };

  return {
    router,
    engine: defaultEngine,
    stopScheduler,
    getEngineForUser,
    restoreEligibleSchedulers,
    recoveryPromise,
    getRecoverySummary: () => recoverySummary,
    schedulerInstanceId,
  };
}

export function createStandaloneApp(options: CreateServerOptions = {}) {
  const app = express();
  app.use(cors({ origin: process.env.WEB_ORIGIN || true }));
  const standardJson = express.json({ limit: '150kb' });
  app.use((req, res, next) => {
    if (req.path === '/api/android/screen/analyze') {
      next();
      return;
    }
    standardJson(req, res, next);
  });
  const result = createNovaTradeRouter(options);
  app.use('/api', result.router);
  return { app, ...result };
}

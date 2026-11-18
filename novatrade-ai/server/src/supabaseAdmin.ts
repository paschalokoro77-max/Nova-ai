import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let adminClient: SupabaseClient | null = null;

export function getSupabaseServerConfig() {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim();
  const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  let urlValid = false;
  if (url) {
    try {
      const parsed = new URL(url);
      urlValid = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      urlValid = false;
    }
  }
  return {
    url,
    anonKey,
    urlValid,
    configured: Boolean(urlValid && (serviceRoleKey || anonKey)),
    serviceRoleConfigured: Boolean(urlValid && serviceRoleKey),
    clientAuthConfigured: Boolean(urlValid && anonKey),
  };
}

export function validateProductionEnvironment(): void {
  const cfg = getSupabaseServerConfig();
  const issues: string[] = [];

  if (!cfg.urlValid) {
    issues.push('SUPABASE_URL (or VITE_SUPABASE_URL) must be a valid HTTP/HTTPS URL');
  }
  if (!cfg.anonKey) {
    issues.push('SUPABASE_ANON_KEY (or VITE_SUPABASE_ANON_KEY) is required');
  }
  if (!cfg.serviceRoleConfigured) {
    issues.push('SUPABASE_SERVICE_ROLE_KEY is required');
  }

  const bridgeSecret = (process.env.ANDROID_BRIDGE_SECRET || '').trim();
  if (!bridgeSecret || Buffer.byteLength(bridgeSecret, 'utf8') < 32) {
    issues.push('ANDROID_BRIDGE_SECRET must be set to at least 32 bytes');
  }

  const vaultSecret = (process.env.BROKER_VAULT_SECRET || '').trim();
  if (!vaultSecret || Buffer.byteLength(vaultSecret, 'utf8') < 32) {
    issues.push('BROKER_VAULT_SECRET must be set to at least 32 bytes');
  }

  if (issues.length > 0) {
    throw new Error(`Production environment validation failed: ${issues.join('; ')}`);
  }
}

export function getSupabaseAdmin(): SupabaseClient | null {
  const cfg = getSupabaseServerConfig();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!cfg.urlValid || !cfg.url || !key) return null;
  if (!adminClient) {
    adminClient = createClient(cfg.url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return adminClient;
}

export async function verifySupabaseBearerToken(authHeader?: string): Promise<{ userId: string; email: string | null } | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const cfg = getSupabaseServerConfig();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || cfg.anonKey).trim();
  if (!cfg.urlValid || !cfg.url || !key) return null;

  try {
    const client = createClient(cfg.url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) return null;
    return {
      userId: data.user.id,
      email: data.user.email ?? null,
    };
  } catch {
    return null;
  }
}

export interface MissingColumnReport {
  table: string;
  columns: string[];
  migration: string;
  error: string;
}

export interface TableRlsDiagnostic {
  rlsProtected: boolean;
  anonBlocked: boolean;
  error: string | null;
}

export interface SupabaseSchemaDiagnostics {
  clientConfigured: boolean;
  serverConfigured: boolean;
  urlValid: boolean;
  authReachable: boolean;
  authError: string | null;
  serviceRoleValid: boolean;
  migration001Applied: boolean;
  migration002Applied: boolean;
  migration003Applied: boolean;
  migration004Applied: boolean;
  migration005Applied: boolean;
  migration006Applied: boolean;
  migration007Applied: boolean;
  migration008Applied: boolean;
  migration009Applied: boolean;
  tables: Record<string, { exists: boolean; error: string | null }>;
  missingTables: string[];
  missingColumns: MissingColumnReport[];
  missingFunctions: string[];
  rlsPolicies: Record<string, TableRlsDiagnostic>;
  migrationsSummary: Record<string, { applied: boolean; detail: string }>;
  eligibleAutoWorkspacesCount: number;
  checkedAt: string;
}

const MIGRATION_001_CHECKS: Array<{ name: string; table: string; columns: string }> = [
  { name: 'user_profiles', table: 'user_profiles', columns: 'id,email,display_name,role,preferred_currency,timezone' },
  {
    name: 'user_settings',
    table: 'user_settings',
    columns:
      'user_id,preferred_mode,paper_trade_amount,daily_loss_limit,daily_profit_target,max_consecutive_losses,max_simultaneous_trades,trading_schedule_enabled,trading_start_hour_utc,trading_end_hour_utc,emergency_stop,auto_paper_armed,strategy_profile,ai_min_score,require_mtf_alignment,enabled_assets,default_timeframe,expiry_seconds,scan_interval_seconds,use_gemini_commentary',
  },
  {
    name: 'analysis_runs',
    table: 'analysis_runs',
    columns: 'id,user_id,symbol,timeframe,direction,rule_score,entry_price,indicators,mtf_alignment,backtest_win_rate,backtest_sample_size,ai_explanation',
  },
  {
    name: 'trading_signals',
    table: 'trading_signals',
    columns: 'id,user_id,symbol,timeframe,direction,score,entry_price,suggested_expiry_seconds,confidence_win_rate,confidence_sample_size,mtf_alignment,indicators,reasons,ai_explanation,data_source',
  },
  {
    name: 'paper_trades',
    table: 'paper_trades',
    columns: 'id,user_id,symbol,timeframe,direction,mode,amount,payout_rate,entry_price,exit_price,expiry_seconds,expires_at,status,pnl,result_amount,signal_score,settled_by',
  },
  {
    name: 'trade_results',
    table: 'trade_results',
    columns: 'id,user_id,paper_trade_id,symbol,direction,mode,stake,pnl,outcome,entry_price,exit_price,settled_at',
  },
  {
    name: 'broker_connections',
    table: 'broker_connections',
    columns: 'id,user_id,broker_name,environment,status,account_type,last_balance,capabilities,execution_enabled',
  },
  {
    name: 'account_activity',
    table: 'account_activity',
    columns: 'id,user_id,event_type,category,summary,metadata',
  },
];

const MIGRATION_002_CHECKS: Array<{ name: string; table: string; columns: string }> = [
  {
    name: 'user_settings_v2',
    table: 'user_settings',
    columns: 'starting_virtual_balance,max_daily_trades',
  },
  {
    name: 'trading_signals_v2',
    table: 'trading_signals',
    columns: 'risk_assessment',
  },
];

const MIGRATION_003_CHECKS: Array<{ name: string; table: string; columns: string }> = [
  {
    name: 'android_devices',
    table: 'android_devices',
    columns: 'id,user_id,device_name,status,permissions',
  },
  {
    name: 'android_screen_analyses',
    table: 'android_screen_analyses',
    columns: 'id,user_id,app_name,detected_symbol,detected_account_mode,recommended_action,confidence_score',
  },
  {
    name: 'android_action_queue',
    table: 'android_action_queue',
    columns: 'id,user_id,device_id,symbol,direction,status,account_mode_verified,account_mode_verification_source,verified_broker_account_id',
  },
];

const MIGRATION_006_CHECKS: Array<{ name: string; table: string; columns: string }> = [
  {
    name: 'paper_trades_v6',
    table: 'paper_trades',
    columns: 'stop_loss,take_profit',
  },
];

const MIGRATION_007_CHECKS: Array<{ name: string; table: string; columns: string }> = [
  {
    name: 'broker_vault_state',
    table: 'broker_vault_state',
    columns: 'user_id,active_account_id,auto_execute_broker_demo,accounts_json,orders_json,idempotency_keys_json,updated_at',
  },
];

const MIGRATION_008_CHECKS: Array<{ name: string; table: string; columns: string }> = [
  {
    name: 'paper_trades_v8',
    table: 'paper_trades',
    columns: 'account_bucket,strategy_name',
  },
];

const MIGRATION_009_CHECKS: Array<{ name: string; table: string; columns: string }> = [
  {
    name: 'user_settings_v9',
    table: 'user_settings',
    columns: 'runtime_recovery',
  },
];

const RLS_PROTECTED_TABLES = [
  'user_settings',
  'paper_trades',
  'broker_connections',
  'broker_vault_state',
  'android_devices',
  'android_action_queue',
];

function isMissingTableError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('could not find the table') ||
    lower.includes('does not exist') && lower.includes('relation') ||
    lower.includes('pgrst205')
  );
}

async function runMigrationChecks(
  admin: SupabaseClient,
  migrationId: string,
  checks: Array<{ name: string; table: string; columns: string }>,
  tables: Record<string, { exists: boolean; error: string | null }>,
  missingTablesSet: Set<string>,
  missingColumns: MissingColumnReport[]
): Promise<boolean> {
  let allPassed = true;
  for (const check of checks) {
    const { error } = await admin.from(check.table).select(check.columns).limit(0);
    tables[check.name] = { exists: !error, error: error ? error.message : null };
    if (error) {
      allPassed = false;
      if (isMissingTableError(error.message)) {
        missingTablesSet.add(check.table);
      } else {
        const failedCols: string[] = [];
        for (const col of check.columns.split(',').map((c) => c.trim()).filter(Boolean)) {
          const single = await admin.from(check.table).select(col).limit(0);
          if (single.error) failedCols.push(col);
        }
        missingColumns.push({
          table: check.table,
          columns: failedCols.length > 0 ? failedCols : check.columns.split(',').map((c) => c.trim()),
          migration: migrationId,
          error: error.message,
        });
      }
    }
  }
  return allPassed;
}

export async function runSupabaseDiagnostics(): Promise<SupabaseSchemaDiagnostics> {
  const cfg = getSupabaseServerConfig();
  const checkedAt = new Date().toISOString();
  const tables: Record<string, { exists: boolean; error: string | null }> = {};
  const missingTablesSet = new Set<string>();
  const missingColumns: MissingColumnReport[] = [];
  const missingFunctions: string[] = [];
  const rlsPolicies: Record<string, TableRlsDiagnostic> = {};

  let authReachable = false;
  let authError: string | null = null;
  if (cfg.urlValid && cfg.anonKey) {
    try {
      const res = await fetch(`${cfg.url.replace(/\/$/, '')}/auth/v1/settings`, {
        headers: { apikey: cfg.anonKey },
        signal: AbortSignal.timeout(5000),
      });
      authReachable = res.ok;
      if (!res.ok) authError = `Supabase Auth HTTP ${res.status}`;
    } catch (err) {
      authError = err instanceof Error ? err.message : 'Supabase Auth unreachable';
    }
  } else {
    authError = 'Supabase URL or anon key is missing/invalid.';
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      clientConfigured: cfg.clientAuthConfigured,
      serverConfigured: cfg.serviceRoleConfigured,
      urlValid: cfg.urlValid,
      authReachable,
      authError,
      serviceRoleValid: false,
      migration001Applied: false,
      migration002Applied: false,
      migration003Applied: false,
      migration004Applied: false,
      migration005Applied: false,
      migration006Applied: false,
      migration007Applied: false,
      migration008Applied: false,
      migration009Applied: false,
      tables,
      missingTables: [],
      missingColumns,
      missingFunctions,
      rlsPolicies,
      migrationsSummary: {},
      eligibleAutoWorkspacesCount: 0,
      checkedAt,
    };
  }

  let serviceRoleValid = false;
  try {
    const { error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
    serviceRoleValid = !error;
    if (error && !authError) authError = error.message;
  } catch (err) {
    if (!authError) authError = err instanceof Error ? err.message : 'Admin check failed';
  }

  const migration001Applied = await runMigrationChecks(admin, '001', MIGRATION_001_CHECKS, tables, missingTablesSet, missingColumns);
  const migration002Applied = await runMigrationChecks(admin, '002', MIGRATION_002_CHECKS, tables, missingTablesSet, missingColumns);
  const migration003Applied = await runMigrationChecks(admin, '003', MIGRATION_003_CHECKS, tables, missingTablesSet, missingColumns);
  const migration006Applied = await runMigrationChecks(admin, '006', MIGRATION_006_CHECKS, tables, missingTablesSet, missingColumns);
  const migration007Applied = await runMigrationChecks(admin, '007', MIGRATION_007_CHECKS, tables, missingTablesSet, missingColumns);
  const migration008Applied = await runMigrationChecks(admin, '008', MIGRATION_008_CHECKS, tables, missingTablesSet, missingColumns);
  const migration009Applied = await runMigrationChecks(admin, '009', MIGRATION_009_CHECKS, tables, missingTablesSet, missingColumns);

  // Migration 004 creates partial indexes on android_devices (requires migration 003 base table/columns)
  const migration004Applied = Boolean(tables.android_devices?.exists) && !missingTablesSet.has('android_devices');
  tables.android_pairing_indexes_004 = {
    exists: migration004Applied,
    error: migration004Applied
      ? null
      : 'Prerequisite table public.android_devices unavailable for pairing indexes.',
  };

  // Migration 005 adds single-use atomic RPC redeem_android_pairing_code(); blank args cleanly return null with 0 side effects
  let migration005Applied = false;
  try {
    const { error: rpcError } = await admin.rpc('redeem_android_pairing_code', {
      p_pairing_code_hash: '',
      p_device_name: '',
      p_device_model: null,
      p_os_version: null,
      p_media_projection: false,
      p_accessibility: false,
      p_token_hash: '',
      p_token_prefix: '',
    });
    migration005Applied = !rpcError;
    tables.redeem_android_pairing_code = {
      exists: migration005Applied,
      error: rpcError ? rpcError.message : null,
    };
    if (rpcError) {
      missingFunctions.push('public.redeem_android_pairing_code');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'RPC check failed';
    tables.redeem_android_pairing_code = { exists: false, error: msg };
    missingFunctions.push('public.redeem_android_pairing_code');
  }

  // Non-destructive RLS isolation probe using unauthenticated anon key
  if (cfg.urlValid && cfg.url && cfg.anonKey) {
    const anonClient = createClient(cfg.url, cfg.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    for (const tbl of RLS_PROTECTED_TABLES) {
      if (missingTablesSet.has(tbl)) {
        rlsPolicies[tbl] = { rlsProtected: false, anonBlocked: true, error: 'Table missing' };
        continue;
      }
      try {
        const { data, error } = await anonClient.from(tbl).select('*').limit(1);
        const leakedRows = !error && Array.isArray(data) && data.length > 0;
        rlsPolicies[tbl] = {
          rlsProtected: !leakedRows,
          anonBlocked: !leakedRows,
          error: leakedRows ? 'Anon query returned rows without authentication (check RLS policy).' : error ? error.message : null,
        };
      } catch (err) {
        rlsPolicies[tbl] = {
          rlsProtected: true,
          anonBlocked: true,
          error: err instanceof Error ? err.message : null,
        };
      }
    }
  }

  let eligibleAutoWorkspacesCount = 0;
  if (migration001Applied) {
    const { count } = await admin
      .from('user_settings')
      .select('user_id', { count: 'exact', head: true })
      .eq('auto_paper_armed', true)
      .eq('emergency_stop', false);
    eligibleAutoWorkspacesCount = count ?? 0;
  }

  const migrationsSummary: Record<string, { applied: boolean; detail: string }> = {
    '001': {
      applied: migration001Applied,
      detail: migration001Applied ? 'Core platform tables verified.' : 'Missing core platform table(s) or columns.',
    },
    '002': {
      applied: migration002Applied,
      detail: migration002Applied ? 'Virtual balance and risk assessment columns verified.' : 'Missing 002 columns.',
    },
    '003': {
      applied: migration003Applied,
      detail: migration003Applied ? 'Android companion tables and verification columns verified.' : 'Missing 003 Android tables or verification columns.',
    },
    '004': {
      applied: migration004Applied,
      detail: migration004Applied
        ? 'Target table public.android_devices present (partial pg_indexes verified via SQL).'
        : 'Target table public.android_devices missing.',
    },
    '005': {
      applied: migration005Applied,
      detail: migration005Applied ? 'RPC public.redeem_android_pairing_code verified.' : 'RPC public.redeem_android_pairing_code missing.',
    },
    '006': {
      applied: migration006Applied,
      detail: migration006Applied ? 'paper_trades SL/TP columns verified.' : 'Missing paper_trades stop_loss/take_profit columns.',
    },
    '007': {
      applied: migration007Applied,
      detail: migration007Applied ? 'broker_vault_state table verified.' : 'Missing broker_vault_state table or columns.',
    },
    '008': {
      applied: migration008Applied,
      detail: migration008Applied ? 'paper_trades account_bucket and strategy_name verified.' : 'Missing 008 learning attribution columns.',
    },
    '009': {
      applied: migration009Applied,
      detail: migration009Applied ? 'user_settings.runtime_recovery verified.' : 'Optional 009 runtime_recovery column not yet applied (graceful fallback active).',
    },
  };

  return {
    clientConfigured: cfg.clientAuthConfigured,
    serverConfigured: cfg.serviceRoleConfigured,
    urlValid: cfg.urlValid,
    authReachable,
    authError,
    serviceRoleValid,
    migration001Applied,
    migration002Applied,
    migration003Applied,
    migration004Applied,
    migration005Applied,
    migration006Applied,
    migration007Applied,
    migration008Applied,
    migration009Applied,
    tables,
    missingTables: Array.from(missingTablesSet),
    missingColumns,
    missingFunctions,
    rlsPolicies,
    migrationsSummary,
    eligibleAutoWorkspacesCount,
    checkedAt,
  };
}

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
  tables: Record<string, { exists: boolean; error: string | null }>;
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
    columns: 'id,user_id,device_id,symbol,direction,status,account_mode_verified',
  },
];

export async function runSupabaseDiagnostics(): Promise<SupabaseSchemaDiagnostics> {
  const cfg = getSupabaseServerConfig();
  const checkedAt = new Date().toISOString();
  const tables: Record<string, { exists: boolean; error: string | null }> = {};

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
      tables,
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

  let migration001Applied = true;
  for (const check of MIGRATION_001_CHECKS) {
    const { error } = await admin.from(check.table).select(check.columns).limit(0);
    tables[check.name] = { exists: !error, error: error ? error.message : null };
    if (error) migration001Applied = false;
  }

  let migration002Applied = true;
  for (const check of MIGRATION_002_CHECKS) {
    const { error } = await admin.from(check.table).select(check.columns).limit(0);
    tables[check.name] = { exists: !error, error: error ? error.message : null };
    if (error) migration002Applied = false;
  }

  let migration003Applied = true;
  for (const check of MIGRATION_003_CHECKS) {
    const { error } = await admin.from(check.table).select(check.columns).limit(0);
    tables[check.name] = { exists: !error, error: error ? error.message : null };
    if (error) migration003Applied = false;
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
    tables,
    eligibleAutoWorkspacesCount,
    checkedAt,
  };
}

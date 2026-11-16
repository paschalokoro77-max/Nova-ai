import { createClient, type EmailOtpType, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type {
  ActivityEvent,
  AiSettings,
  OperatingMode,
  PaperTrade,
  RiskSettings,
  SignalRecord,
  UserProfile,
} from '../types';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

/**
 * Dynamically detects the active browser origin (never hardcoded to localhost).
 */
export function getBrowserPreviewOrigin(): string {
  if (typeof window === 'undefined' || !window.location?.origin) {
    return '';
  }
  return window.location.origin.replace(/\/$/, '');
}

/**
 * Returns the dynamic /auth/callback redirect URL for the active preview origin.
 */
export function getAuthCallbackUrl(): string {
  const origin = getBrowserPreviewOrigin();
  return origin ? `${origin}/auth/callback` : '/auth/callback';
}

export interface ParsedCallbackParams {
  code: string | null;
  tokenHash: string | null;
  type: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  error: string | null;
  errorDescription: string | null;
  hasCallbackPayload: boolean;
}

export function parseAuthCallbackUrl(urlString: string): ParsedCallbackParams {
  let searchParams = new URLSearchParams();
  let hashParams = new URLSearchParams();

  try {
    const parsed = new URL(urlString, 'https://placeholder.invalid');
    searchParams = parsed.searchParams;
    const rawHash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
    hashParams = new URLSearchParams(rawHash);
  } catch {
    // Keep empty params if malformed
  }

  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') || hashParams.get('type');
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');
  const error = searchParams.get('error') || hashParams.get('error');
  const errorDescription = searchParams.get('error_description') || hashParams.get('error_description');

  const hasCallbackPayload = Boolean(code || tokenHash || accessToken || error || errorDescription);

  return {
    code,
    tokenHash,
    type,
    accessToken,
    refreshToken,
    error,
    errorDescription,
    hasCallbackPayload,
  };
}

export function isAuthCallbackRoute(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.pathname === '/auth/callback') return true;
  const parsed = parseAuthCallbackUrl(window.location.href);
  return parsed.hasCallbackPayload;
}

export interface CallbackProcessResult {
  ok: boolean;
  session: Session | null;
  flowType: string | null;
  message: string;
}

export async function processSupabaseAuthCallback(urlString = window.location.href): Promise<CallbackProcessResult> {
  if (!supabase) {
    return {
      ok: false,
      session: null,
      flowType: null,
      message: 'Supabase credentials (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY) are not configured.',
    };
  }

  const params = parseAuthCallbackUrl(urlString);

  if (params.error || params.errorDescription) {
    return {
      ok: false,
      session: null,
      flowType: params.type,
      message: decodeURIComponent((params.errorDescription || params.error || 'Confirmation failed').replace(/\+/g, ' ')),
    };
  }

  if (params.tokenHash && params.type) {
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: params.tokenHash,
      type: params.type as EmailOtpType,
    });
    if (error) {
      return { ok: false, session: null, flowType: params.type, message: error.message };
    }
    return {
      ok: true,
      session: data.session ?? null,
      flowType: params.type,
      message: params.type === 'recovery' ? 'Recovery verified. Choose a new password.' : 'Email confirmed. Session active.',
    };
  }

  if (params.code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(params.code);
    if (error) {
      const existing = await supabase.auth.getSession();
      if (existing.data.session) {
        return {
          ok: true,
          session: existing.data.session,
          flowType: params.type,
          message: 'Email confirmed. Session established.',
        };
      }
      return {
        ok: false,
        session: null,
        flowType: params.type,
        message: error.message,
      };
    }
    return {
      ok: true,
      session: data.session ?? null,
      flowType: params.type,
      message: params.type === 'recovery' ? 'Recovery verified. Choose a new password.' : 'Email confirmed. Session active.',
    };
  }

  if (params.accessToken && params.refreshToken) {
    const { data, error } = await supabase.auth.setSession({
      access_token: params.accessToken,
      refresh_token: params.refreshToken,
    });
    if (error) {
      return { ok: false, session: null, flowType: params.type, message: error.message };
    }
    return {
      ok: true,
      session: data.session ?? null,
      flowType: params.type,
      message: params.type === 'recovery' ? 'Recovery verified. Choose a new password.' : 'Email confirmed. Session active.',
    };
  }

  const { data } = await supabase.auth.getSession();
  if (data.session) {
    return {
      ok: true,
      session: data.session,
      flowType: params.type,
      message: 'Email confirmed. Session established.',
    };
  }

  return {
    ok: false,
    session: null,
    flowType: params.type,
    message: 'No confirmation token or active session was found in the callback URL. If you already confirmed your email, return to Sign In.',
  };
}

export async function getActiveSession(): Promise<Session | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

export async function signUpWithEmail(email: string, password: string, displayName: string) {
  if (!supabase) {
    throw new Error('Supabase is not connected yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY first.');
  }
  const emailRedirectTo = getAuthCallbackUrl();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName },
      emailRedirectTo,
    },
  });
  if (error) throw error;
  return { ...data, emailRedirectTo };
}

export async function resendConfirmationEmail(email: string) {
  if (!supabase) {
    throw new Error('Supabase is not connected yet.');
  }
  const emailRedirectTo = getAuthCallbackUrl();
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo },
  });
  if (error) throw error;
  return emailRedirectTo;
}

export async function signInWithEmail(email: string, password: string) {
  if (!supabase) {
    throw new Error('Supabase is not connected yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY first.');
  }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOutSupabase() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function sendPasswordRecovery(email: string) {
  if (!supabase) {
    throw new Error('Supabase is not connected yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY first.');
  }
  const redirectTo = getAuthCallbackUrl();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo,
  });
  if (error) throw error;
  return redirectTo;
}

export async function updateSupabasePassword(newPassword: string) {
  if (!supabase) throw new Error('Supabase is not connected.');
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export async function loadSupabaseProfile(userId: string, email: string): Promise<UserProfile> {
  if (!supabase) {
    return {
      id: userId,
      email,
      displayName: email.split('@')[0] || 'Trader',
      role: 'trader',
      preferredCurrency: 'USD',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      authMode: 'local-preview',
    };
  }
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id,email,display_name,role,preferred_currency,timezone')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) {
    return {
      id: userId,
      email,
      displayName: email.split('@')[0] || 'Trader',
      role: 'trader',
      preferredCurrency: 'USD',
      timezone: 'UTC',
      authMode: 'supabase',
    };
  }

  return {
    id: data.id,
    email: data.email || email,
    displayName: data.display_name || email.split('@')[0] || 'Trader',
    role: data.role || 'trader',
    preferredCurrency: data.preferred_currency || 'USD',
    timezone: data.timezone || 'UTC',
    authMode: 'supabase',
  };
}

export async function updateSupabaseProfile(profile: UserProfile) {
  if (!supabase) return profile;
  const { error } = await supabase.from('user_profiles').upsert(
    {
      id: profile.id,
      email: profile.email,
      display_name: profile.displayName.trim(),
      preferred_currency: profile.preferredCurrency,
      timezone: profile.timezone.trim(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) throw new Error(error.message);
  return {
    ...profile,
    displayName: profile.displayName.trim(),
    timezone: profile.timezone.trim(),
  };
}

export async function syncSupabaseSettings(
  userId: string,
  mode: OperatingMode | string,
  risk: RiskSettings,
  ai: AiSettings,
  autoArmed: boolean,
  startingVirtualBalance?: number
) {
  if (!supabase) return;
  const { error } = await supabase.from('user_settings').upsert(
    {
      user_id: userId,
      preferred_mode: mode,
      starting_virtual_balance: startingVirtualBalance ?? 10000,
      paper_trade_amount: risk.maxTradeAmount,
      daily_loss_limit: risk.dailyLossLimit,
      daily_profit_target: risk.dailyProfitTarget,
      max_consecutive_losses: risk.maxConsecutiveLosses,
      max_daily_trades: risk.maxDailyTrades,
      max_simultaneous_trades: risk.maxSimultaneousTrades,
      trading_schedule_enabled: risk.tradingScheduleEnabled,
      trading_start_hour_utc: risk.tradingStartHourUtc,
      trading_end_hour_utc: risk.tradingEndHourUtc,
      emergency_stop: risk.emergencyStop,
      auto_paper_armed: autoArmed,
      strategy_profile: ai.strategyProfile,
      ai_min_score: ai.minSignalScore,
      require_mtf_alignment: ai.requireMtfAlignment,
      enabled_assets: ai.enabledAssets,
      default_timeframe: ai.defaultTimeframe,
      expiry_seconds: ai.expirySeconds,
      scan_interval_seconds: ai.scanIntervalSeconds,
      use_gemini_commentary: ai.useGeminiCommentary,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) throw new Error(error.message);
}

export async function fetchUserWorkspaceFromSupabase(userId: string): Promise<{
  mode?: OperatingMode;
  autoPaperArmed?: boolean;
  startingVirtualBalance?: number;
  riskSettings?: Partial<RiskSettings>;
  aiSettings?: Partial<AiSettings>;
  paperTrades?: PaperTrade[];
  signals?: SignalRecord[];
  activity?: ActivityEvent[];
} | null> {
  if (!supabase) return null;
  try {
    const [settingsRes, tradesRes, signalsRes, activityRes] = await Promise.all([
      supabase.from('user_settings').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('paper_trades').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(200),
      supabase.from('trading_signals').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
      supabase.from('account_activity').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(100),
    ]);

    const s = settingsRes.data;
    const riskSettings: Partial<RiskSettings> | undefined = s
      ? {
          maxTradeAmount: Number(s.paper_trade_amount ?? 100),
          dailyLossLimit: Number(s.daily_loss_limit ?? 500),
          dailyProfitTarget: Number(s.daily_profit_target ?? 500),
          maxConsecutiveLosses: Number(s.max_consecutive_losses ?? 3),
          maxDailyTrades: Number(s.max_daily_trades ?? 25),
          maxSimultaneousTrades: Number(s.max_simultaneous_trades ?? 3),
          tradingScheduleEnabled: Boolean(s.trading_schedule_enabled),
          tradingStartHourUtc: Number(s.trading_start_hour_utc ?? 7),
          tradingEndHourUtc: Number(s.trading_end_hour_utc ?? 20),
          emergencyStop: Boolean(s.emergency_stop),
        }
      : undefined;

    const aiSettings: Partial<AiSettings> | undefined = s
      ? {
          strategyProfile: s.strategy_profile || 'balanced',
          minSignalScore: Number(s.ai_min_score ?? 65),
          requireMtfAlignment: s.require_mtf_alignment !== false,
          enabledAssets: Array.isArray(s.enabled_assets) ? s.enabled_assets : undefined,
          defaultTimeframe: s.default_timeframe || '1m',
          expirySeconds: Number(s.expiry_seconds ?? 180),
          scanIntervalSeconds: Number(s.scan_interval_seconds ?? 60),
          useGeminiCommentary: s.use_gemini_commentary !== false,
        }
      : undefined;

    const paperTrades: PaperTrade[] | undefined = Array.isArray(tradesRes.data)
      ? tradesRes.data.map((row) => ({
          id: row.id,
          symbol: row.symbol,
          timeframe: row.timeframe || '1m',
          direction: row.direction,
          mode: row.mode || 'manual',
          amount: Number(row.amount),
          payoutRate: Number(row.payout_rate ?? 0.8),
          entryPrice: row.entry_price != null ? Number(row.entry_price) : null,
          exitPrice: row.exit_price != null ? Number(row.exit_price) : null,
          expirySeconds: Number(row.expiry_seconds ?? 180),
          expiresAt: row.expires_at ?? null,
          status: row.status,
          pnl: row.pnl != null ? Number(row.pnl) : null,
          signalScore: row.signal_score != null ? Number(row.signal_score) : null,
          provider: 'supabase-archive',
          settledBy: row.settled_by ?? null,
          createdAt: row.created_at,
          closedAt: row.closed_at ?? null,
        }))
      : undefined;

    const signals: SignalRecord[] | undefined = Array.isArray(signalsRes.data)
      ? signalsRes.data.map((row) => ({
          id: row.id,
          symbol: row.symbol,
          timeframe: row.timeframe || '1m',
          direction: row.direction,
          score: Number(row.score ?? 0),
          confidenceScore: Number(row.score ?? 0),
          bullishScore: Number(row.score ?? 0),
          bearishScore: 0,
          entryPrice: row.entry_price != null ? Number(row.entry_price) : null,
          suggestedExpirySeconds: Number(row.suggested_expiry_seconds ?? 180),
          provider: row.data_source || 'supabase-archive',
          timestamp: row.created_at,
          indicators: row.indicators || null,
          supportingIndicators: null,
          riskAssessment: row.risk_assessment || null,
          mtf: row.mtf_alignment
            ? {
                primaryTimeframe: row.timeframe || '1m',
                higherTimeframe: '5m',
                higherTrend: 'RANGING',
                higherRsi: null,
                alignment: row.mtf_alignment,
              }
            : null,
          backtest: {
            sampleSize: Number(row.confidence_sample_size ?? 0),
            wins: 0,
            losses: 0,
            winRatePct: row.confidence_win_rate != null ? Number(row.confidence_win_rate) : null,
            expectancyPerUnit: null,
            horizonBars: 3,
            note: 'Loaded from Supabase archive.',
          },
          reasons: Array.isArray(row.reasons) ? row.reasons : [],
          warning: 'Loaded from Supabase history.',
          aiExplanation: row.ai_explanation
            ? { available: true, model: 'gemini-2.5-flash', summary: row.ai_explanation, riskNote: null }
            : null,
        }))
      : undefined;

    const activity: ActivityEvent[] | undefined = Array.isArray(activityRes.data)
      ? activityRes.data.map((row) => ({
          id: row.id,
          category: row.category,
          eventType: row.event_type,
          summary: row.summary,
          createdAt: row.created_at,
        }))
      : undefined;

    const rawMode = s?.preferred_mode;
    const mode: OperatingMode | undefined =
      rawMode === 'signals' || rawMode === 'assisted' || rawMode === 'automatic' ? rawMode : undefined;

    return {
      mode,
      autoPaperArmed: typeof s?.auto_paper_armed === 'boolean' ? s.auto_paper_armed : undefined,
      startingVirtualBalance: s?.starting_virtual_balance != null ? Number(s.starting_virtual_balance) : undefined,
      riskSettings,
      aiSettings,
      paperTrades,
      signals,
      activity,
    };
  } catch {
    return null;
  }
}

export async function persistPaperTradeToSupabase(userId: string, trade: PaperTrade) {
  if (!supabase) return;
  await supabase.from('paper_trades').upsert({
    id: trade.id,
    user_id: userId,
    symbol: trade.symbol,
    timeframe: trade.timeframe,
    direction: trade.direction,
    mode: trade.mode,
    amount: trade.amount,
    payout_rate: trade.payoutRate,
    entry_price: trade.entryPrice,
    exit_price: trade.exitPrice,
    expiry_seconds: trade.expirySeconds,
    expires_at: trade.expiresAt,
    status: trade.status,
    pnl: trade.pnl,
    signal_score: trade.signalScore,
    settled_by: trade.settledBy,
    created_at: trade.createdAt,
    closed_at: trade.closedAt,
  });
}

export async function persistSignalToSupabase(userId: string, sig: SignalRecord) {
  if (!supabase) return;
  await supabase.from('trading_signals').upsert({
    id: sig.id,
    user_id: userId,
    symbol: sig.symbol,
    timeframe: sig.timeframe,
    direction: sig.direction,
    score: sig.score,
    entry_price: sig.entryPrice,
    suggested_expiry_seconds: sig.suggestedExpirySeconds,
    confidence_win_rate: sig.backtest.winRatePct,
    confidence_sample_size: sig.backtest.sampleSize,
    mtf_alignment: sig.mtf?.alignment || null,
    indicators: sig.indicators || {},
    risk_assessment: sig.riskAssessment || null,
    reasons: sig.reasons,
    ai_explanation: sig.aiExplanation?.summary || null,
    data_source: sig.provider,
    created_at: sig.timestamp,
  });
}

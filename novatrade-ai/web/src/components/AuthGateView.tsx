import { useState, type FormEvent } from 'react';
import { Lock, Mail, RefreshCw, ShieldAlert, User } from 'lucide-react';
import {
  getAuthCallbackUrl,
  isSupabaseConfigured,
  resendConfirmationEmail,
  sendPasswordRecovery,
  signInWithEmail,
  signUpWithEmail,
} from '../lib/supabase';
import type { ThemePreference } from '../types';
import { CARD_SURFACE, INPUT_CLASS, NovaLogo, ThemeSwitcher } from './ui';

interface AuthGateProps {
  themePreference: ThemePreference;
  systemPrefersDark?: boolean;
  onChangeTheme: (next: ThemePreference) => void;
  onAuthenticatedLocal: (email: string, displayName: string) => void;
}

export function AuthGateView({ themePreference, systemPrefersDark, onChangeTheme, onAuthenticatedLocal }: AuthGateProps) {
  const [mode, setMode] = useState<'login' | 'register' | 'recovery'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [pendingConfirmEmail, setPendingConfirmEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const callbackUrl = getAuthCallbackUrl();
  const isProdBuild = import.meta.env.PROD;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (!isSupabaseConfigured) {
        if (isProdBuild) {
          throw new Error('Production deployment requires live Supabase authentication credentials.');
        }
        if (mode === 'recovery') {
          setNotice('Password recovery requires your Supabase project URL and publishable key.');
          return;
        }
        if (!email.trim()) throw new Error('Enter an email address to start a local research session.');
        onAuthenticatedLocal(email.trim(), displayName.trim() || email.trim().split('@')[0]);
        return;
      }

      if (mode === 'login') {
        await signInWithEmail(email.trim(), password);
      } else if (mode === 'register') {
        const res = await signUpWithEmail(email.trim(), password, displayName.trim() || email.trim().split('@')[0]);
        if (!res.session) {
          setPendingConfirmEmail(email.trim());
          setNotice(
            `Confirmation email sent to ${email.trim()} with redirect ${res.emailRedirectTo}. Open the link to verify your account before signing in.`
          );
          setMode('login');
        }
      } else {
        const redirectTo = await sendPasswordRecovery(email.trim());
        setNotice(`Password recovery email sent (redirecting to ${redirectTo}) if an account exists.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication request failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    if (!pendingConfirmEmail) return;
    setResending(true);
    setError(null);
    try {
      const redirectTo = await resendConfirmationEmail(pendingConfirmEmail);
      setNotice(`Confirmation email resent to ${pendingConfirmEmail} (redirect: ${redirectTo}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend confirmation email.');
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] dark:bg-[#060A13] text-slate-900 dark:text-slate-100 flex flex-col justify-between p-4 sm:p-6 relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(37,99,235,0.08),transparent_50%),radial-gradient(ellipse_at_bottom_left,rgba(79,70,229,0.07),transparent_50%)] dark:bg-[radial-gradient(ellipse_at_top_right,rgba(79,70,229,0.16),transparent_50%),radial-gradient(ellipse_at_bottom_left,rgba(59,130,246,0.12),transparent_50%)]" />

      <div className="relative z-10 max-w-md w-full mx-auto flex items-center justify-between gap-3 pt-1 pb-4">
        <NovaLogo />
        <div className="w-52 sm:w-60 shrink-0">
          <ThemeSwitcher compact value={themePreference} systemPrefersDark={systemPrefersDark} onChange={onChangeTheme} />
        </div>
      </div>

      <div className={`relative z-10 w-full max-w-md mx-auto ${CARD_SURFACE} p-6 sm:p-8 shadow-xl`}>
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
            {mode === 'login' ? 'Sign in to workspace' : mode === 'register' ? 'Create trader account' : 'Reset password'}
          </h1>
          <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
            Protected trading research, quantitative scanner, and paper execution controls.
          </p>
        </div>

        {!isSupabaseConfigured && (
          <div className="mb-5 rounded-xl border border-amber-300 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/40 p-3.5 text-xs text-amber-900 dark:text-amber-200">
            <div className="flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
              <div>
                <p className="font-medium text-amber-900 dark:text-amber-300">Supabase credentials pending</p>
                <p className="mt-1 leading-relaxed opacity-90">
                  Add <code className="font-mono">VITE_SUPABASE_URL</code> and{' '}
                  <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> to enable live auth &amp; cloud sync.
                  Enter an email below to continue in local research mode.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="mb-5 grid grid-cols-3 gap-1 rounded-xl bg-slate-100 dark:bg-[#070C17] p-1 border border-slate-200 dark:border-slate-800">
          {(['login', 'register', 'recovery'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => {
                setMode(tab);
                setError(null);
                setNotice(null);
              }}
              className={`min-h-10 rounded-lg py-2 text-xs font-semibold whitespace-nowrap transition-all ${
                mode === tab
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm border border-slate-200/80 dark:border-slate-700'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 border border-transparent'
              }`}
            >
              {tab === 'login' ? 'Sign In' : tab === 'register' ? 'Register' : 'Recover'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Display Name</label>
              <div className="relative">
                <User className="h-4 w-4 text-slate-400 absolute left-3.5 top-3.5" />
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Alex Mercer"
                  className={`${INPUT_CLASS} pl-10`}
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Email Address</label>
            <div className="relative">
              <Mail className="h-4 w-4 text-slate-400 absolute left-3.5 top-3.5" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="trader@domain.com"
                className={`${INPUT_CLASS} pl-10`}
              />
            </div>
          </div>

          {mode !== 'recovery' && isSupabaseConfigured && (
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Password</label>
              <div className="relative">
                <Lock className="h-4 w-4 text-slate-400 absolute left-3.5 top-3.5" />
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  className={`${INPUT_CLASS} pl-10`}
                />
              </div>
            </div>
          )}

          {error && (
            <p className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/50 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
          {notice && (
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/50 px-3.5 py-2.5 text-xs text-emerald-800 dark:text-emerald-300 space-y-2">
              <p className="leading-relaxed break-words">{notice}</p>
              {pendingConfirmEmail && (
                <button
                  type="button"
                  disabled={resending}
                  onClick={handleResend}
                  className="inline-flex items-center gap-1.5 underline hover:opacity-80"
                >
                  <RefreshCw className={`h-3 w-3 ${resending ? 'animate-spin' : ''}`} />
                  {resending ? 'Resending...' : 'Resend confirmation email'}
                </button>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full min-h-11 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 disabled:opacity-50 py-2.5 px-4 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all"
          >
            {busy
              ? 'Processing...'
              : !isSupabaseConfigured
                ? 'Continue in Local Research Mode'
                : mode === 'login'
                  ? 'Sign In'
                  : mode === 'register'
                    ? 'Create Account'
                    : 'Send Recovery Link'}
          </button>
        </form>

        {isSupabaseConfigured && (
          <p className="mt-4 text-[11px] text-slate-500 leading-relaxed break-all">
            Auth redirect: <code className="font-mono text-slate-600 dark:text-slate-400">{callbackUrl}</code>
          </p>
        )}
      </div>

      <div className="relative z-10 text-center pt-4 pb-2 text-[11px] text-slate-500 dark:text-slate-500">
        Paper simulation terminal · Live-money execution locked
      </div>
    </div>
  );
}

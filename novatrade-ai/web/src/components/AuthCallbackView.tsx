import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, Loader2, Lock, XCircle } from 'lucide-react';
import type { Session } from '@supabase/supabase-js';
import {
  getAuthCallbackUrl,
  processSupabaseAuthCallback,
  updateSupabasePassword,
} from '../lib/supabase';

interface AuthCallbackViewProps {
  onComplete: (session: Session | null) => void;
}

export function AuthCallbackView({ onComplete }: AuthCallbackViewProps) {
  const [status, setStatus] = useState<'verifying' | 'recovery' | 'success' | 'error'>('verifying');
  const [message, setMessage] = useState('Verifying your confirmation link...');
  const [verifiedSession, setVerifiedSession] = useState<Session | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    let active = true;

    async function run() {
      const result = await processSupabaseAuthCallback(window.location.href);
      if (!active) return;

      if (window.location.pathname === '/auth/callback' || window.location.search || window.location.hash) {
        window.history.replaceState({}, document.title, '/');
      }

      if (!result.ok) {
        setStatus('error');
        setMessage(result.message);
        return;
      }

      setVerifiedSession(result.session);
      if (result.flowType === 'recovery') {
        setStatus('recovery');
        setMessage(result.message);
        return;
      }

      setStatus('success');
      setMessage(result.message);
      setTimeout(() => {
        if (active) onComplete(result.session);
      }, 900);
    }

    void run();
    return () => {
      active = false;
    };
  }, [onComplete]);

  async function handlePasswordUpdate(e: FormEvent) {
    e.preventDefault();
    setSavingPassword(true);
    try {
      await updateSupabasePassword(newPassword);
      setStatus('success');
      setMessage('Password updated. Opening your workspace...');
      setTimeout(() => onComplete(verifiedSession), 900);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Unable to update password.');
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] dark:bg-[#060A13] text-slate-900 dark:text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1322] p-6 sm:p-8 space-y-4 shadow-xl">
        <div className="text-xs font-semibold text-blue-600 dark:text-indigo-400">NovaTrade AI · Authentication Callback</div>

        {status === 'verifying' && (
          <div className="flex items-center gap-3 py-4">
            <Loader2 className="h-5 w-5 animate-spin text-blue-500 shrink-0" />
            <p className="text-sm text-slate-700 dark:text-slate-200">{message}</p>
          </div>
        )}

        {status === 'success' && (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0 mt-0.5" />
              <div>
                <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Confirmation Complete</h1>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{message}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onComplete(verifiedSession)}
              className="w-full min-h-11 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 py-2.5 px-4 text-sm font-medium text-white transition-colors"
            >
              Continue to Dashboard
            </button>
          </div>
        )}

        {status === 'recovery' && (
          <form onSubmit={handlePasswordUpdate} className="space-y-4">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Set New Password</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">{message}</p>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">New Password</label>
              <div className="relative">
                <Lock className="h-4 w-4 text-slate-400 absolute left-3 top-3.5" />
                <input
                  type="password"
                  required
                  minLength={6}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  className="w-full min-h-11 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070C17] pl-9 pr-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 dark:focus:border-indigo-400 focus:outline-none"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={savingPassword}
              className="w-full min-h-11 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 disabled:opacity-50 py-2.5 px-4 text-sm font-medium text-white transition-colors"
            >
              {savingPassword ? 'Updating...' : 'Update Password'}
            </button>
          </form>
        )}

        {status === 'error' && (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <XCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
              <div>
                <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Verification Issue</h1>
                <p className="mt-1 text-sm text-red-600 dark:text-red-300 leading-relaxed">{message}</p>
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070C17] p-3 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Ensure <code className="font-mono text-slate-800 dark:text-slate-300 break-all">{getAuthCallbackUrl()}</code> is listed in
              your Supabase Dashboard under <strong>Authentication → URL Configuration → Redirect URLs</strong>.
            </div>
            <button
              type="button"
              onClick={() => onComplete(null)}
              className="w-full min-h-11 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 py-2.5 px-4 text-sm font-medium text-white transition-colors"
            >
              Return to Sign In
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import {
  Wallet,
  CreditCard,
  RefreshCw,
  Cable,
  ShieldCheck,
  CheckCircle2,
  Lock,
} from 'lucide-react';
import type { ManagedBrokerAccountPublic } from '../types';

interface NovaPayViewProps {
  accounts: ManagedBrokerAccountPublic[];
  busy: boolean;
  onRefresh: () => void;
  onConnectAccount: (accountId: string) => Promise<void>;
  onSyncAccount: (accountId: string) => Promise<void>;
  onNavigateBrokers: () => void;
}

export function NovaPayView({
  accounts,
  busy,
  onRefresh,
  onConnectAccount,
  onSyncAccount,
  onNavigateBrokers,
}: NovaPayViewProps) {
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const connectedAccounts = accounts.filter((a) => a.connected);
  const validBalanceAccounts = connectedAccounts.filter(
    (a) => typeof a.balance === 'number' && Number.isFinite(a.balance)
  );
  const validEquityAccounts = connectedAccounts.filter((a) => {
    const val = a.equity ?? a.balance;
    return typeof val === 'number' && Number.isFinite(val);
  });
  const totalBalance =
    validBalanceAccounts.length > 0
      ? validBalanceAccounts.reduce((sum, a) => sum + (a.balance as number), 0)
      : null;
  const totalEquity =
    validEquityAccounts.length > 0
      ? validEquityAccounts.reduce((sum, a) => sum + ((a.equity ?? a.balance) as number), 0)
      : null;

  async function handleSync(accountId: string) {
    setSyncingId(accountId);
    setSuccessMsg(null);
    try {
      await onSyncAccount(accountId);
      setSuccessMsg('Broker account balance and equity synchronized into NovaPay successfully.');
      onRefresh();
    } catch (err) {
      setSuccessMsg(err instanceof Error ? err.message : 'Synchronization failed.');
    } finally {
      setSyncingId(null);
    }
  }

  const CARD_SURFACE = 'rounded-2xl border border-slate-200/80 dark:border-slate-800/80 bg-white/80 dark:bg-[#0B1329]/80 backdrop-blur-xl shadow-xs';

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              <Wallet className="h-5 w-5" />
            </span>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
              NovaPay Platform · Broker Integration
            </h1>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Unified multi-broker asset synchronization. Connected MetaTrader 5 and IQ Option accounts are securely synced in real-time.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onRefresh}
            className="flex items-center gap-2 min-h-10 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070C17] px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
            <span>Sync NovaPay Ledger</span>
          </button>
          <button
            type="button"
            onClick={onNavigateBrokers}
            className="flex items-center gap-2 min-h-10 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-xs font-semibold text-white transition-colors"
          >
            <Cable className="h-3.5 w-3.5" />
            <span>Manage Broker Connections</span>
          </button>
        </div>
      </div>

      {successMsg && (
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 px-4 py-3 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Summary Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className={`${CARD_SURFACE} p-5 space-y-2`}>
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">NovaPay Total Balance</p>
          <p className="text-2xl font-bold font-mono tracking-tight text-slate-900 dark:text-white">
            {totalBalance != null
              ? `$${totalBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : 'Unavailable'}
          </p>
          <p className={`text-[11px] flex items-center gap-1 ${totalBalance != null ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}`}>
            <ShieldCheck className="h-3 w-3" /> {totalBalance != null ? 'Genuine Broker Aggregated' : 'No verified broker balance synced'}
          </p>
        </div>

        <div className={`${CARD_SURFACE} p-5 space-y-2`}>
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Total Equity / NAV</p>
          <p className="text-2xl font-bold font-mono tracking-tight text-slate-900 dark:text-white">
            {totalEquity != null
              ? `$${totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : 'Unavailable'}
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {totalEquity != null ? 'Reconciled via API Bridges' : 'Awaiting verified broker equity'}
          </p>
        </div>

        <div className={`${CARD_SURFACE} p-5 space-y-2`}>
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Connected Broker Accounts</p>
          <p className="text-2xl font-bold font-mono tracking-tight text-slate-900 dark:text-white">
            {connectedAccounts.length} <span className="text-sm font-normal text-slate-400">/ {accounts.length} total</span>
          </p>
          <p className="text-[11px] text-blue-600 dark:text-blue-400">MT5 &amp; IQ Option Active</p>
        </div>

        <div className={`${CARD_SURFACE} p-5 space-y-2`}>
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Security &amp; RLS Status</p>
          <div className="flex items-center gap-2 pt-1">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
              <Lock className="h-3 w-3" /> Vault Protected
            </span>
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Supabase user ownership enforced</p>
        </div>
      </div>

      {/* Connected Accounts Section */}
      <div className={`${CARD_SURFACE} p-6 space-y-6`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 dark:border-slate-800 pb-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-indigo-600 dark:text-indigo-400" /> Synchronized Broker Accounts in NovaPay
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Genuine account balances, equity, and live connection statuses streaming directly into NovaPay.
            </p>
          </div>
          <span className="rounded-lg bg-indigo-500/10 px-3 py-1 text-xs font-medium text-indigo-700 dark:text-indigo-300">
            Secure Server-Side Synchronization
          </span>
        </div>

        {accounts.length === 0 ? (
          <div className="text-center py-12 space-y-3">
            <Wallet className="h-10 w-10 text-slate-400 mx-auto" />
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">No broker accounts configured yet.</p>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Connect your MetaTrader 5 or IQ Option account in Broker Connections to begin synchronizing balances into NovaPay.
            </p>
            <button
              type="button"
              onClick={onNavigateBrokers}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-xs font-semibold text-white transition-colors mt-2"
            >
              <Cable className="h-3.5 w-3.5" />
              <span>Go to Broker Connections</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {accounts.map((acct) => (
              <div
                key={acct.id}
                className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/50 dark:bg-[#070C17]/50 p-5 space-y-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">{acct.label}</span>
                      <span className="rounded-md bg-slate-200/70 dark:bg-slate-800 px-2 py-0.5 text-[10px] uppercase font-bold text-slate-700 dark:text-slate-300">
                        {acct.brokerId}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                      Login ID: <span className="font-mono text-slate-700 dark:text-slate-300">{acct.externalAccountId || '—'}</span> · {acct.accountType || 'Demo Sandbox'}
                    </p>
                  </div>
                  <span
                    className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${
                      acct.connected
                        ? 'border-emerald-300 dark:border-emerald-800/70 bg-emerald-50 dark:bg-emerald-950/35 text-emerald-700 dark:text-emerald-300'
                        : 'border-red-300 dark:border-red-800/70 bg-red-50 dark:bg-red-950/35 text-red-700 dark:text-red-300'
                    }`}
                  >
                    {acct.status}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-3 border-t border-slate-200/80 dark:border-slate-800 text-xs">
                  <div>
                    <p className="text-[11px] text-slate-500">Genuine Balance</p>
                    <p className="mt-0.5 font-mono tabular-nums font-semibold text-slate-900 dark:text-white text-sm">
                      {typeof acct.balance === 'number' && Number.isFinite(acct.balance)
                        ? `$${acct.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${acct.currency || 'USD'}`
                        : acct.connected
                          ? 'Unavailable'
                          : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Equity / NAV</p>
                    <p className="mt-0.5 font-mono tabular-nums font-semibold text-slate-900 dark:text-white text-sm">
                      {typeof acct.equity === 'number' && Number.isFinite(acct.equity)
                        ? `$${acct.equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${acct.currency || 'USD'}`
                        : acct.connected
                          ? 'Unavailable'
                          : '—'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-slate-200/80 dark:border-slate-800 text-xs">
                  <span className="text-[11px] text-slate-400">
                    {acct.lastSyncedAt ? `Synced: ${new Date(acct.lastSyncedAt).toLocaleTimeString()}` : 'Not synced yet'}
                  </span>
                  <div className="flex items-center gap-2">
                    {!acct.connected ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          void onConnectAccount(acct.id).catch((err) => {
                            setSuccessMsg(err instanceof Error ? err.message : 'Unable to connect broker account.');
                          });
                        }}
                        className="rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors"
                      >
                        Connect
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy || syncingId === acct.id}
                        onClick={() => handleSync(acct.id)}
                        className="flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070C17] px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 transition-colors"
                      >
                        <RefreshCw className={`h-3 w-3 ${syncingId === acct.id ? 'animate-spin' : ''}`} />
                        <span>Sync Balance</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

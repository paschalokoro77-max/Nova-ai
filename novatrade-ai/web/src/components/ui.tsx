import { AlertCircle, Check, Loader2, Monitor, Moon, Sun } from 'lucide-react';
import type { ThemePreference } from '../types';
import type { AutoSaveStatus } from '../hooks/useAutoSave';

export const CARD_SURFACE =
  'rounded-2xl border border-slate-200/90 dark:border-slate-800/90 bg-white dark:bg-[#0C1322] shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:shadow-[0_1px_0_rgba(255,255,255,0.03)_inset] transition-colors';

export const SUBTLE_PANEL =
  'rounded-xl border border-slate-200/80 dark:border-slate-800/80 bg-slate-50/90 dark:bg-[#070C17]';

export const INPUT_CLASS =
  'w-full min-h-11 rounded-xl border border-slate-300/90 dark:border-slate-700/90 bg-white dark:bg-[#070C17] px-3.5 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-500 dark:focus:border-indigo-400 focus:ring-2 focus:ring-blue-500/15 dark:focus:ring-indigo-500/20 focus:outline-none transition-colors';

export const SELECT_CLASS =
  'w-full min-h-11 rounded-xl border border-slate-300/90 dark:border-slate-700/90 bg-white dark:bg-[#070C17] px-3.5 py-2 text-sm text-slate-900 dark:text-slate-100 focus:border-blue-500 dark:focus:border-indigo-400 focus:ring-2 focus:ring-blue-500/15 dark:focus:ring-indigo-500/20 focus:outline-none transition-colors';

export function NovaLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-600 text-white shadow-sm shadow-blue-600/25">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 16l5-6 4 4 7-8" />
          <path d="M16 6h4v4" />
        </svg>
      </div>
      {!compact && (
        <div className="min-w-0">
          <div className="font-display text-sm font-bold tracking-tight text-slate-900 dark:text-white leading-none">
            NovaTrade <span className="text-blue-600 dark:text-indigo-400">AI</span>
          </div>
          <p className="mt-1 text-[11px] font-medium text-slate-500 dark:text-slate-400 leading-none truncate">
            Quantitative Paper Terminal
          </p>
        </div>
      )}
    </div>
  );
}

export function SaveStatusIndicator({
  status,
  validationError,
  onRetry,
}: {
  status: AutoSaveStatus;
  validationError?: string | null;
  onRetry?: () => void;
}) {
  if (validationError) {
    return (
      <span
        role="status"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400"
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        <span>{validationError}</span>
      </span>
    );
  }

  if (status === 'saving') {
    return (
      <span
        role="status"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0 text-blue-600 dark:text-indigo-400" />
        <span>Saving...</span>
      </span>
    );
  }

  if (status === 'saved') {
    return (
      <span
        role="status"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400"
      >
        <Check className="h-3.5 w-3.5 shrink-0" />
        <span>All changes saved</span>
      </span>
    );
  }

  if (status === 'error') {
    return (
      <span role="alert" className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        <span>Couldn&apos;t save.</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="underline underline-offset-2 font-semibold hover:text-red-700 dark:hover:text-red-300 cursor-pointer"
          >
            Retry.
          </button>
        )}
      </span>
    );
  }

  return null;
}

export function ThemeSwitcher({
  value,
  onChange,
  compact = false,
  systemPrefersDark,
}: {
  value: ThemePreference;
  onChange: (next: ThemePreference) => void;
  compact?: boolean;
  systemPrefersDark?: boolean;
}) {
  const effectiveSystemDark =
    systemPrefersDark ??
    (typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true);

  const options: Array<{
    id: ThemePreference;
    label: string;
    fullLabel: string;
    description: string;
    icon: typeof Sun;
    activeButtonClass: string;
    activeIconClass: string;
    idleIconClass: string;
    indicatorBarClass: string;
    checkBadgeClass: string;
  }> = [
    {
      id: 'light',
      label: 'Light',
      fullLabel: 'Light Mode',
      description: 'Clean white surface',
      icon: Sun,
      activeButtonClass:
        'bg-white text-slate-900 border-amber-400 ring-1 ring-amber-400/50 shadow-[0_2px_10px_rgba(245,158,11,0.18)]',
      activeIconClass: 'text-amber-500',
      idleIconClass: 'text-amber-500/70 dark:text-amber-400/60',
      indicatorBarClass: 'bg-amber-400',
      checkBadgeClass: 'bg-amber-100 text-amber-700 border-amber-300',
    },
    {
      id: 'dark',
      label: 'Dark',
      fullLabel: 'Dark Mode',
      description: 'Deep navy & obsidian',
      icon: Moon,
      activeButtonClass:
        'bg-[#060B18] text-white border-indigo-500 ring-1 ring-indigo-500/55 shadow-[0_2px_12px_rgba(99,102,241,0.28)]',
      activeIconClass: 'text-indigo-400',
      idleIconClass: 'text-indigo-500/70 dark:text-indigo-400/65',
      indicatorBarClass: 'bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500',
      checkBadgeClass: 'bg-indigo-500/20 text-indigo-300 border-indigo-400/50',
    },
    {
      id: 'system',
      label: 'System',
      fullLabel: 'System Default',
      description: `Follows device (${effectiveSystemDark ? 'Dark' : 'Light'})`,
      icon: Monitor,
      activeButtonClass:
        'bg-amber-50 text-amber-950 dark:bg-[#191507] dark:text-amber-50 border-yellow-500 dark:border-yellow-400 ring-1 ring-yellow-500/45 dark:ring-yellow-400/45 shadow-[0_2px_10px_rgba(234,179,8,0.2)]',
      activeIconClass: 'text-yellow-600 dark:text-yellow-400',
      idleIconClass: 'text-yellow-600/70 dark:text-yellow-400/65',
      indicatorBarClass: 'bg-yellow-500 dark:bg-yellow-400',
      checkBadgeClass: 'bg-yellow-400/20 text-yellow-700 dark:text-yellow-300 border-yellow-500/50',
    },
  ];

  if (compact) {
    return (
      <div
        role="radiogroup"
        aria-label="Theme mode"
        className="w-full inline-grid grid-cols-3 gap-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-[#070C17] p-1"
      >
        {options.map((opt) => {
          const Icon = opt.icon;
          const active = value === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(opt.id)}
              className={`relative min-h-9 inline-flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-medium whitespace-nowrap transition-all overflow-hidden cursor-pointer ${
                active
                  ? `${opt.activeButtonClass} font-semibold`
                  : 'border-transparent text-slate-600 dark:text-slate-400 hover:bg-white/60 dark:hover:bg-slate-800/50 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? opt.activeIconClass : opt.idleIconClass}`} />
              <span>{opt.label}</span>
              {active && <Check className={`h-3 w-3 shrink-0 ${opt.activeIconClass}`} />}
              {active && <span aria-hidden="true" className={`absolute bottom-0 inset-x-2 h-0.5 rounded-full ${opt.indicatorBarClass}`} />}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme mode"
      className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full"
    >
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.id)}
            className={`relative flex flex-col justify-between gap-3 rounded-xl border p-3.5 text-left transition-all cursor-pointer ${
              active
                ? `${opt.activeButtonClass} font-semibold`
                : 'border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-[#070C17] text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 hover:bg-white dark:hover:bg-[#0D1528]'
            }`}
          >
            {/* Visual Theme Swatch Preview */}
            <div className="flex items-center justify-between gap-2 w-full">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${
                    opt.id === 'light'
                      ? 'bg-white border-amber-300/80 text-amber-500 shadow-xs'
                      : opt.id === 'dark'
                        ? 'bg-[#050914] border-indigo-500/60 text-indigo-400'
                        : 'bg-gradient-to-br from-white via-amber-50 to-[#060B18] border-yellow-500/60 text-yellow-600 dark:text-yellow-400'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0">
                  <div className="text-xs font-semibold leading-tight truncate">{opt.fullLabel}</div>
                  <div
                    className={`text-[11px] leading-tight mt-0.5 truncate ${
                      active
                        ? opt.id === 'dark'
                          ? 'text-slate-300'
                          : opt.id === 'system'
                            ? 'text-amber-800 dark:text-amber-200/80'
                            : 'text-slate-500'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {opt.description}
                  </div>
                </div>
              </div>

              {active ? (
                <span
                  className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${opt.checkBadgeClass}`}
                  aria-label="Selected"
                >
                  <Check className="h-3 w-3" />
                </span>
              ) : (
                <span
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 rounded-full border border-slate-300 dark:border-slate-700"
                />
              )}
            </div>

            {/* Distinct Selected Bottom Accent Bar */}
            <div
              aria-hidden="true"
              className={`h-1 w-full rounded-full transition-opacity ${
                active ? opt.indicatorBarClass : 'bg-slate-200/80 dark:bg-slate-800/80 opacity-60'
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}

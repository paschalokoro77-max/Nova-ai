import { AlertTriangle, X } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary' | 'warning';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  const confirmBtnClass =
    tone === 'danger'
      ? 'bg-red-600 hover:bg-red-500 text-white shadow-sm shadow-red-600/20'
      : tone === 'warning'
        ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-sm shadow-amber-600/20'
        : 'bg-blue-600 hover:bg-blue-500 text-white shadow-sm shadow-blue-600/20';

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-slate-950/55 dark:bg-slate-950/75 backdrop-blur-sm" onClick={onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="relative z-10 w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1322] p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3.5">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                tone === 'danger'
                  ? 'border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400'
                  : tone === 'warning'
                    ? 'border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/50 text-amber-600 dark:text-amber-400'
                    : 'border-blue-200 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400'
              }`}
            >
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h3 id="confirm-dialog-title" className="text-base font-semibold text-slate-900 dark:text-white">
                {title}
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{description}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="min-h-10 min-w-10 flex items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-white transition-colors"
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="min-h-11 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070C17] px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`min-h-11 rounded-xl px-4 py-2 text-xs font-semibold whitespace-nowrap disabled:opacity-50 transition-colors ${confirmBtnClass}`}
          >
            {busy ? 'Applying...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

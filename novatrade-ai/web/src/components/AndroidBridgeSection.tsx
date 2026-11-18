import { useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Eye,
  Lock,
  PauseCircle,
  PlayCircle,
  ShieldAlert,
  Smartphone,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import type {
  AndroidActionQueueItem,
  AndroidDevicePublic,
  AndroidScreenAnalysisRecord,
} from '../types';
import { sanitizeErrorMessage } from '../lib/api';
import { CARD_SURFACE, INPUT_CLASS, SELECT_CLASS, SUBTLE_PANEL } from './ui';

interface AndroidBridgeSectionProps {
  devices: AndroidDevicePublic[];
  analyses: AndroidScreenAnalysisRecord[];
  actions: AndroidActionQueueItem[];
  busy: boolean;
  onPairDevice: (input: {
    deviceName: string;
    allowMt5: boolean;
    allowIqOption: boolean;
  }) => Promise<{ device: AndroidDevicePublic; pairingCode: string; expiresAt: string }>;
  onUpdatePermissions: (
    deviceId: string,
    patch: {
      status?: 'ACTIVE' | 'PAUSED';
      allowMt5?: boolean;
      allowIqOption?: boolean;
    }
  ) => Promise<void>;
  onRevokeDevice: (deviceId: string) => Promise<void>;
  onAnalyzeScreenshot: (input: {
    imageBase64: string;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    appPackageHint?: string | null;
    notes?: string;
    deviceId?: string;
    createAssistedProposal?: boolean;
  }) => Promise<void>;
  onApproveAction: (actionId: string) => Promise<void>;
  onRejectAction: (actionId: string) => Promise<void>;
}

function formatAppLabel(appName: AndroidScreenAnalysisRecord['appName']): string {
  if (appName === 'MT5') return 'MetaTrader 5 Mobile';
  if (appName === 'IQ_OPTION') return 'IQ Option Mobile';
  return 'Unidentified App';
}

function accountModeTone(mode: AndroidScreenAnalysisRecord['detectedAccountMode']): string {
  if (mode === 'DEMO' || mode === 'PRACTICE') {
    return 'border-emerald-300 dark:border-emerald-800/70 bg-emerald-50 dark:bg-emerald-950/35 text-emerald-700 dark:text-emerald-300';
  }
  if (mode === 'REAL') {
    return 'border-red-300 dark:border-red-800/70 bg-red-50 dark:bg-red-950/35 text-red-700 dark:text-red-300';
  }
  return 'border-amber-300 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/35 text-amber-700 dark:text-amber-300';
}

export function AndroidBridgeSection({
  devices,
  analyses,
  actions,
  busy,
  onPairDevice,
  onUpdatePermissions,
  onRevokeDevice,
  onAnalyzeScreenshot,
  onApproveAction,
  onRejectAction,
}: AndroidBridgeSectionProps) {
  const [deviceName, setDeviceName] = useState('My Android Phone');
  const [allowMt5, setAllowMt5] = useState(true);
  const [allowIqOption, setAllowIqOption] = useState(true);
  const [activePairing, setActivePairing] = useState<{
    pairingCode: string;
    expiresAt: string;
    deviceName: string;
  } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [appPackageHint, setAppPackageHint] = useState<string>('');
  const [captureNotes, setCaptureNotes] = useState('');
  const [createProposal, setCreateProposal] = useState(true);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [previewMimeType, setPreviewMimeType] = useState<'image/png' | 'image/jpeg' | 'image/webp'>('image/jpeg');
  const [localError, setLocalError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const latestAnalysis = analyses[0] || null;
  const pendingActions = actions.filter((a) => a.status === 'PENDING_USER_APPROVAL');

  async function handleGeneratePairing(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (!allowMt5 && !allowIqOption) {
      setLocalError('Select at least one target Android trading app (MT5 or IQ Option).');
      return;
    }
    try {
      const res = await onPairDevice({
        deviceName: deviceName.trim() || 'Android Phone',
        allowMt5,
        allowIqOption,
      });
      setActivePairing({
        pairingCode: res.pairingCode,
        expiresAt: res.expiresAt,
        deviceName: res.device.deviceName,
      });
      setCopiedCode(false);
    } catch (err) {
      setLocalError(sanitizeErrorMessage(err, 'Unable to generate pairing code.'));
    }
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    setLocalError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setLocalError('Select a PNG, JPEG, or WebP screenshot from MT5 or IQ Option.');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setLocalError('Screenshot exceeds 4 MB limit.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setPreviewDataUrl(reader.result);
        setPreviewMimeType(file.type as 'image/png' | 'image/jpeg' | 'image/webp');
      }
    };
    reader.onerror = () => {
      setLocalError('Failed to read screenshot file.');
    };
    reader.readAsDataURL(file);
  }

  async function handleRunScreenAnalysis() {
    if (!previewDataUrl) {
      setLocalError('Upload or capture an MT5 / IQ Option screenshot first.');
      return;
    }
    setLocalError(null);
    setAnalyzing(true);
    try {
      await onAnalyzeScreenshot({
        imageBase64: previewDataUrl,
        mimeType: previewMimeType,
        appPackageHint: appPackageHint || null,
        notes: captureNotes.trim() || undefined,
        deviceId: selectedDeviceId || undefined,
        createAssistedProposal: createProposal,
      });
    } catch (err) {
      setLocalError(sanitizeErrorMessage(err, 'Screen analysis failed.'));
    } finally {
      setAnalyzing(false);
    }
  }

  const registerEndpoint =
    typeof window !== 'undefined' ? `${window.location.origin}/api/android/devices/register` : '/api/android/devices/register';

  return (
    <div className={`${CARD_SURFACE} p-5 sm:p-6 space-y-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-blue-200 dark:border-indigo-800/70 bg-blue-50 dark:bg-indigo-950/35 text-blue-600 dark:text-indigo-400">
            <Smartphone className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-slate-900 dark:text-white">
              Android App Bridge · MT5 &amp; IQ Option Mobile
            </h3>
            <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400 max-w-2xl leading-relaxed">
              Pair your Android phone and analyze live MT5 (`net.metaquotes.metatrader5`) or IQ Option (`com.iqoption`) trading screens using Gemini Vision fused with NovaTrade&apos;s quantitative engine.
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/40 px-3 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-300 whitespace-nowrap">
          <Lock className="h-3.5 w-3.5" /> Phase 1 · Real-Money Auto Locked
        </span>
      </div>

      {localError && (
        <div className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-2.5 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          <span>{localError}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Left Column: Secure Pairing & Paired Devices */}
        <div className="space-y-4">
          <form onSubmit={handleGeneratePairing} className={`${SUBTLE_PANEL} p-4 space-y-3`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-900 dark:text-white">1. Pair Android Companion Device</span>
              <span className="text-[11px] text-slate-500">Single-use 10m code</span>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">Device Label</label>
              <input
                type="text"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="e.g. Pixel 8 Pro"
                className={INPUT_CLASS}
              />
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-700 dark:text-slate-300">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={allowMt5} onChange={(e) => setAllowMt5(e.target.checked)} />
                Allow MT5 Mobile
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={allowIqOption} onChange={(e) => setAllowIqOption(e.target.checked)} />
                Allow IQ Option Mobile
              </label>
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full min-h-10 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 disabled:opacity-40 px-4 py-2 text-xs font-semibold text-white transition-colors"
            >
              Generate Pairing Code
            </button>

            {activePairing && (
              <div className="rounded-xl border border-blue-200 dark:border-indigo-800/70 bg-white dark:bg-[#0C1322] p-3 space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500 dark:text-slate-400">
                    Code for <strong className="text-slate-900 dark:text-white">{activePairing.deviceName}</strong>:
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(activePairing.pairingCode).catch(() => undefined);
                      setCopiedCode(true);
                    }}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-indigo-400 hover:underline"
                  >
                    <Copy className="h-3 w-3" /> {copiedCode ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="font-mono text-lg font-bold tracking-widest text-blue-600 dark:text-indigo-400">
                  {activePairing.pairingCode}
                </p>
                <p className="text-[11px] text-slate-500 break-all">
                  Register endpoint: <span className="font-mono">{registerEndpoint}</span> · Expires{' '}
                  {new Date(activePairing.expiresAt).toLocaleTimeString()}
                </p>
              </div>
            )}
          </form>

          {/* Paired Device List */}
          <div className={`${SUBTLE_PANEL} p-4 space-y-3`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-900 dark:text-white">
                Paired Devices ({devices.length})
              </span>
              <span className="text-[11px] text-slate-500">Scoped Bearer Tokens</span>
            </div>

            {devices.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                No Android devices paired yet. Generate a pairing code above or test screenshot analysis on the right.
              </p>
            ) : (
              <div className="space-y-2.5">
                {devices.map((dev) => (
                  <div
                    key={dev.id}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1322] p-3 space-y-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-semibold text-slate-900 dark:text-white">{dev.deviceName}</p>
                        <p className="text-[11px] text-slate-500">
                          {dev.deviceModel || 'Pending registration'}
                          {dev.tokenPrefix ? ` · Token ${dev.tokenPrefix}…` : ''}
                          {dev.lastSeenAt ? ` · Seen ${new Date(dev.lastSeenAt).toLocaleTimeString()}` : ''}
                        </p>
                      </div>
                      <span
                        className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${
                          dev.status === 'ACTIVE'
                            ? 'border-emerald-300 dark:border-emerald-800/70 bg-emerald-50 dark:bg-emerald-950/35 text-emerald-700 dark:text-emerald-300'
                            : 'border-amber-300 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/35 text-amber-700 dark:text-amber-300'
                        }`}
                      >
                        {dev.status}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-600 dark:text-slate-300">
                      <label className="inline-flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={dev.permissions.allowMt5}
                          onChange={(e) => onUpdatePermissions(dev.id, { allowMt5: e.target.checked })}
                        />
                        MT5
                      </label>
                      <label className="inline-flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={dev.permissions.allowIqOption}
                          onChange={(e) => onUpdatePermissions(dev.id, { allowIqOption: e.target.checked })}
                        />
                        IQ Option
                      </label>
                      <span>Screen: {dev.permissions.mediaProjection ? 'Granted' : 'Pending'}</span>
                      <span>Accessibility: {dev.permissions.accessibility ? 'Granted' : 'Pending'}</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {dev.status !== 'PAIRED_PENDING' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            onUpdatePermissions(dev.id, { status: dev.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                        >
                          {dev.status === 'ACTIVE' ? (
                            <>
                              <PauseCircle className="h-3 w-3" /> Pause
                            </>
                          ) : (
                            <>
                              <PlayCircle className="h-3 w-3" /> Resume
                            </>
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRevokeDevice(dev.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-red-300/70 dark:border-red-900/60 px-2.5 py-1 text-[11px] font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                      >
                        <Trash2 className="h-3 w-3" /> Revoke
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Multimodal Screen Ingestion & AI Analysis */}
        <div className="space-y-4">
          <div className={`${SUBTLE_PANEL} p-4 space-y-3`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5 text-blue-600 dark:text-indigo-400" />
                2. Trading Screen Visual Analyzer (MT5 &amp; IQ Option)
              </span>
              <span className="text-[11px] text-slate-500">Gemini Vision + Quant</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Source App Hint</label>
                <select
                  value={appPackageHint}
                  onChange={(e) => setAppPackageHint(e.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value="">Auto-detect App</option>
                  <option value="net.metaquotes.metatrader5">MetaTrader 5 Mobile</option>
                  <option value="com.iqoption">IQ Option Mobile</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Associated Device (Optional)</label>
                <select
                  value={selectedDeviceId}
                  onChange={(e) => setSelectedDeviceId(e.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value="">Direct Screen Upload</option>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.deviceName}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <label className="min-h-10 inline-flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0C1322] hover:bg-slate-50 dark:hover:bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer">
                <Upload className="h-3.5 w-3.5" /> Select Phone Screenshot
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleFileSelected}
                  className="hidden"
                />
              </label>
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={createProposal}
                  onChange={(e) => setCreateProposal(e.target.checked)}
                />
                Queue Assisted approval if actionable
              </label>
            </div>

            <input
              type="text"
              value={captureNotes}
              onChange={(e) => setCaptureNotes(e.target.value)}
              placeholder="Optional note (e.g. M5 EURUSD rejection at resistance)"
              className={INPUT_CLASS}
            />

            {previewDataUrl && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1322] p-2">
                <img
                  src={previewDataUrl}
                  alt="Selected trading app screenshot"
                  className="max-h-44 w-full object-contain rounded-lg"
                />
              </div>
            )}

            <button
              type="button"
              disabled={busy || analyzing || !previewDataUrl}
              onClick={handleRunScreenAnalysis}
              className="w-full min-h-10 rounded-xl bg-blue-600 hover:bg-blue-500 dark:bg-indigo-600 dark:hover:bg-indigo-500 disabled:opacity-40 px-4 py-2 text-xs font-semibold text-white transition-colors"
            >
              {analyzing ? 'Analyzing Screen with Gemini + Quant Engine...' : 'Analyze Trading Screen'}
            </button>
          </div>

          {/* Latest Screen Analysis Readout */}
          {latestAnalysis && (
            <div className={`${SUBTLE_PANEL} p-4 space-y-2.5 text-xs`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-900 dark:text-white">
                  Latest Screen Reading · {formatAppLabel(latestAnalysis.appName)}
                </span>
                <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${accountModeTone(latestAnalysis.detectedAccountMode)}`}>
                  Mode: {latestAnalysis.detectedAccountMode}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                <div>
                  <span className="text-[11px] text-slate-500">Symbol</span>
                  <p className="font-mono font-semibold text-slate-900 dark:text-white">
                    {latestAnalysis.normalizedSymbol || latestAnalysis.detectedSymbol || '—'}
                  </p>
                </div>
                <div>
                  <span className="text-[11px] text-slate-500">Timeframe</span>
                  <p className="font-mono font-semibold text-slate-900 dark:text-white">
                    {latestAnalysis.detectedTimeframe || '—'}
                  </p>
                </div>
                <div>
                  <span className="text-[11px] text-slate-500">Price</span>
                  <p className="font-mono font-semibold text-slate-900 dark:text-white">
                    {latestAnalysis.detectedPrice != null ? latestAnalysis.detectedPrice : '—'}
                  </p>
                </div>
                <div>
                  <span className="text-[11px] text-slate-500">Decision</span>
                  <p
                    className={`font-semibold ${
                      latestAnalysis.recommendedAction === 'CALL'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : latestAnalysis.recommendedAction === 'PUT'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {latestAnalysis.recommendedAction} ({latestAnalysis.confidenceScore}/100)
                  </p>
                </div>
              </div>

              {latestAnalysis.detectedBalance != null && (
                <p className="text-[11px] text-slate-500">
                  OCR screen balance (visual observation only, not live broker sync):{' '}
                  <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">
                    {latestAnalysis.detectedBalance} {latestAnalysis.detectedCurrency || ''}
                  </span>
                </p>
              )}

              <p className="text-slate-700 dark:text-slate-300 leading-relaxed">{latestAnalysis.visionSummary}</p>
              <p className="text-[11px] text-slate-500">
                Trend: {latestAnalysis.chartTrend} · Alignment: {latestAnalysis.alignmentStatus}
                {latestAnalysis.quantScore != null ? ` · Quant ${latestAnalysis.quantDirection} (${latestAnalysis.quantScore}/100)` : ''}
              </p>
              {latestAnalysis.riskWarning && (
                <p className="text-[11px] text-amber-700 dark:text-amber-300">{latestAnalysis.riskWarning}</p>
              )}
            </div>
          )}

          {/* Pending Assisted Android Actions */}
          {pendingActions.length > 0 && (
            <div className={`${SUBTLE_PANEL} p-4 space-y-2.5 text-xs`}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-900 dark:text-white">
                  Pending Assisted Mobile Actions ({pendingActions.length})
                </span>
                <span className="text-[11px] text-amber-600 dark:text-amber-400">Approval Required</span>
              </div>
              {pendingActions.map((act) => (
                <div
                  key={act.id}
                  className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1322] p-3 space-y-2"
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span className={act.direction === 'CALL' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                      {act.direction} {act.symbol} · {act.appName} ({act.accountModeVerified})
                    </span>
                    <span className="font-mono text-slate-900 dark:text-white">${act.stakeOrVolume}</span>
                  </div>
                  <p className="text-[11px] text-slate-500">{act.reason}</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onApproveAction(act.id)}
                      className="flex-1 min-h-9 inline-flex items-center justify-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Approve (Demo Tracking)
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onRejectAction(act.id)}
                      className="flex-1 min-h-9 inline-flex items-center justify-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <XCircle className="h-3.5 w-3.5" /> Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

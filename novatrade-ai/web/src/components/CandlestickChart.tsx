import { useMemo, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { Candle, IndicatorSnapshot } from '../types';

interface Props {
  symbol?: string;
  timeframe?: string;
  candles: Candle[];
  overlays?: {
    ema9: number[];
    ema21: number[];
    ema50: number[];
    bbUpper: number;
    bbMiddle: number;
    bbLower: number;
  };
  indicators?: IndicatorSnapshot | null;
  decimals?: number;
  loading?: boolean;
  error?: string | null;
}

export function CandlestickChart({
  symbol,
  timeframe,
  candles,
  overlays,
  indicators,
  decimals = 5,
  loading = false,
  error = null,
}: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [showEmas, setShowEmas] = useState(true);
  const [showSr, setShowSr] = useState(true);
  const [showBb, setShowBb] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  const visibleCount = fullscreen ? 110 : 72;
  const viewCandles = useMemo(() => candles.slice(-visibleCount), [candles, visibleCount]);
  const offset = Math.max(0, candles.length - viewCandles.length);

  const chartMath = useMemo(() => {
    if (viewCandles.length === 0) return null;
    const lows = viewCandles.map((c) => c.low);
    const highs = viewCandles.map((c) => c.high);
    if (showSr && indicators) {
      lows.push(indicators.nearestSupport);
      highs.push(indicators.nearestResistance);
    }
    if (showBb && overlays) {
      lows.push(overlays.bbLower);
      highs.push(overlays.bbUpper);
    }
    const minPrice = Math.min(...lows);
    const maxPrice = Math.max(...highs);
    const pad = Math.max((maxPrice - minPrice) * 0.1, minPrice * 0.0002);
    return {
      min: minPrice - pad,
      max: maxPrice + pad,
      span: Math.max(1e-9, maxPrice - minPrice + pad * 2),
    };
  }, [viewCandles, indicators, overlays, showSr, showBb]);

  const renderInnerChart = (isModal: boolean) => {
    if (loading && candles.length === 0) {
      return (
        <div className="h-[320px] w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070C17] p-4 flex items-center justify-center text-sm text-slate-500 dark:text-slate-400">
          Loading verified OHLCV candle stream...
        </div>
      );
    }

    if (error && candles.length === 0) {
      return (
        <div className="h-[320px] w-full rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50/60 dark:bg-[#070C17] p-6 flex flex-col items-center justify-center text-center">
          <p className="text-sm font-medium text-red-600 dark:text-red-400">Market data unavailable</p>
          <p className="mt-1 max-w-md text-xs text-slate-600 dark:text-slate-400">{error}</p>
        </div>
      );
    }

    if (!chartMath || viewCandles.length === 0) {
      return (
        <div className="h-[320px] w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070C17] p-4 flex items-center justify-center text-sm text-slate-500 dark:text-slate-400">
          Select an asset and timeframe to inspect live candlesticks.
        </div>
      );
    }

    const W = isModal ? 1120 : 820;
    const H = isModal ? 460 : 310;
    const padLeft = 10;
    const padRight = 78;
    const padTop = 16;
    const padBottom = 26;
    const plotW = W - padLeft - padRight;
    const plotH = H - padTop - padBottom;

    const yOf = (price: number) => padTop + ((chartMath.max - price) / chartMath.span) * plotH;
    const stepX = plotW / viewCandles.length;
    const bodyW = Math.max(2.5, Math.min(9, stepX * 0.62));

    const linePath = (series?: number[]) => {
      if (!series || series.length < candles.length) return '';
      const slice = series.slice(offset);
      return slice
        .map((val, idx) => {
          const x = padLeft + idx * stepX + stepX / 2;
          const y = yOf(val);
          return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
    };

    const activeCandle = hoverIdx != null ? viewCandles[hoverIdx] : viewCandles[viewCandles.length - 1];
    const priceTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => chartMath.max - r * chartMath.span);

    return (
      <div className="w-full">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex flex-wrap items-center gap-3 font-mono tabular-nums">
            <span>
              O <strong className="text-slate-900 dark:text-slate-100">{activeCandle.open.toFixed(decimals)}</strong>
            </span>
            <span>
              H <strong className="text-slate-900 dark:text-slate-100">{activeCandle.high.toFixed(decimals)}</strong>
            </span>
            <span>
              L <strong className="text-slate-900 dark:text-slate-100">{activeCandle.low.toFixed(decimals)}</strong>
            </span>
            <span>
              C <strong className="text-slate-900 dark:text-slate-100">{activeCandle.close.toFixed(decimals)}</strong>
            </span>
            <span className="text-slate-500">
              {new Date(activeCandle.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' })} (WAT)
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <button
              type="button"
              onClick={() => setShowEmas((v) => !v)}
              className={`rounded-md border px-2 py-1 whitespace-nowrap transition-colors ${
                showEmas
                  ? 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300'
                  : 'border-slate-300 dark:border-slate-700 text-slate-400'
              }`}
            >
              EMA 9/21/50
            </button>
            <button
              type="button"
              onClick={() => setShowBb((v) => !v)}
              className={`rounded-md border px-2 py-1 whitespace-nowrap transition-colors ${
                showBb
                  ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300'
                  : 'border-slate-300 dark:border-slate-700 text-slate-400'
              }`}
            >
              BB(20)
            </button>
            <button
              type="button"
              onClick={() => setShowSr((v) => !v)}
              className={`rounded-md border px-2 py-1 whitespace-nowrap transition-colors ${
                showSr
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                  : 'border-slate-300 dark:border-slate-700 text-slate-400'
              }`}
            >
              S/R Levels
            </button>
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-indigo-500/30 bg-white dark:bg-slate-900 px-2.5 py-1 font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
              title={fullscreen ? 'Exit Full-Screen Chart' : 'Open Full-Screen Chart'}
            >
              {fullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
              {fullscreen ? 'Exit' : 'Expand'}
            </button>
          </div>
        </div>

        <div className="relative w-full overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#070C17]">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className={`${isModal ? 'h-[62vh] min-h-[360px]' : 'h-[280px] sm:h-[310px]'} w-full select-none`}
            onMouseLeave={() => setHoverIdx(null)}
          >
            {/* Grid lines & price labels */}
            {priceTicks.map((tick, i) => {
              const y = yOf(tick);
              return (
                <g key={i}>
                  <line
                    x1={padLeft}
                    y1={y}
                    x2={W - padRight}
                    y2={y}
                    className="stroke-slate-200 dark:stroke-slate-800"
                    strokeDasharray="3 3"
                    strokeWidth="1"
                  />
                  <text
                    x={W - padRight + 6}
                    y={y + 3}
                    className="fill-slate-600 dark:fill-slate-400"
                    fontSize="10"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {tick.toFixed(decimals)}
                  </text>
                </g>
              );
            })}

            {/* Bollinger Band Reference Lines */}
            {showBb && overlays && (
              <>
                <line
                  x1={padLeft}
                  y1={yOf(overlays.bbUpper)}
                  x2={W - padRight}
                  y2={yOf(overlays.bbUpper)}
                  stroke="#6366F1"
                  strokeDasharray="2 3"
                  strokeOpacity="0.45"
                  strokeWidth="1"
                />
                <line
                  x1={padLeft}
                  y1={yOf(overlays.bbLower)}
                  x2={W - padRight}
                  y2={yOf(overlays.bbLower)}
                  stroke="#6366F1"
                  strokeDasharray="2 3"
                  strokeOpacity="0.45"
                  strokeWidth="1"
                />
              </>
            )}

            {/* Support & Resistance */}
            {showSr && indicators && (
              <>
                <line
                  x1={padLeft}
                  y1={yOf(indicators.nearestSupport)}
                  x2={W - padRight}
                  y2={yOf(indicators.nearestSupport)}
                  stroke="#10B981"
                  strokeDasharray="5 4"
                  strokeOpacity="0.7"
                  strokeWidth="1.2"
                />
                <line
                  x1={padLeft}
                  y1={yOf(indicators.nearestResistance)}
                  x2={W - padRight}
                  y2={yOf(indicators.nearestResistance)}
                  stroke="#EF4444"
                  strokeDasharray="5 4"
                  strokeOpacity="0.7"
                  strokeWidth="1.2"
                />
              </>
            )}

            {/* EMAs */}
            {showEmas && overlays?.ema50 && (
              <path d={linePath(overlays.ema50)} fill="none" stroke="#A78BFA" strokeWidth="1.2" strokeOpacity="0.85" />
            )}
            {showEmas && overlays?.ema21 && (
              <path d={linePath(overlays.ema21)} fill="none" stroke="#FBBF24" strokeWidth="1.25" strokeOpacity="0.88" />
            )}
            {showEmas && overlays?.ema9 && (
              <path d={linePath(overlays.ema9)} fill="none" stroke="#38BDF8" strokeWidth="1.4" strokeOpacity="0.95" />
            )}

            {/* Candlesticks */}
            {viewCandles.map((c, idx) => {
              const xCenter = padLeft + idx * stepX + stepX / 2;
              const bull = c.close >= c.open;
              const color = bull ? '#10B981' : '#EF4444';
              const yHigh = yOf(c.high);
              const yLow = yOf(c.low);
              const yTop = yOf(Math.max(c.open, c.close));
              const yBottom = yOf(Math.min(c.open, c.close));
              const bodyH = Math.max(1.5, yBottom - yTop);

              return (
                <g
                  key={c.time}
                  onMouseEnter={() => setHoverIdx(idx)}
                  onClick={() => setHoverIdx(idx)}
                  className="cursor-crosshair"
                >
                  <rect x={padLeft + idx * stepX} y={padTop} width={stepX} height={plotH} fill="transparent" />
                  {hoverIdx === idx && (
                    <line
                      x1={xCenter}
                      y1={padTop}
                      x2={xCenter}
                      y2={H - padBottom}
                      stroke="#64748B"
                      strokeDasharray="2 2"
                      strokeWidth="1"
                    />
                  )}
                  <line x1={xCenter} y1={yHigh} x2={xCenter} y2={yLow} stroke={color} strokeWidth="1.2" />
                  <rect x={xCenter - bodyW / 2} y={yTop} width={bodyW} height={bodyH} fill={color} rx="0.8" />
                </g>
              );
            })}

            {/* Time axis ticks */}
            {[0, Math.floor(viewCandles.length / 2), viewCandles.length - 1].map((idx) => {
              const c = viewCandles[idx];
              if (!c) return null;
              const x = padLeft + idx * stepX + stepX / 2;
              return (
                <text
                  key={idx}
                  x={x}
                  y={H - 7}
                  textAnchor="middle"
                  className="fill-slate-500"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {new Date(c.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' })}
                </text>
              );
            })}
          </svg>
        </div>
      </div>
    );
  };

  return (
    <>
      {renderInnerChart(false)}
      {fullscreen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
          <div className="fixed inset-0 bg-slate-950/65 dark:bg-slate-950/80 backdrop-blur-sm" onClick={() => setFullscreen(false)} />
          <div className="relative z-10 w-full max-w-6xl rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0C1322] p-4 sm:p-6 shadow-2xl">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                  {symbol || 'Market Chart'} · {timeframe || '1m'} Full-Screen Terminal
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  EMA 9/21/50, Bollinger Band envelope, and quantitative Support / Resistance levels
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFullscreen(false)}
                className="min-h-10 rounded-xl border border-slate-300 dark:border-slate-700 px-3.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                Close
              </button>
            </div>
            {renderInnerChart(true)}
          </div>
        </div>
      )}
    </>
  );
}

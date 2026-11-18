import type { PeriodPerformanceRow } from '../types';

interface Point {
  index: number;
  timestamp: string;
  symbol: string;
  equity: number;
  pnl: number;
}

export function EquityChart({ points }: { points: Point[] }) {
  if (points.length === 0) {
    return (
      <div className="h-[220px] rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-[#070C17] flex items-center justify-center p-4 text-center text-sm text-slate-500 dark:text-slate-400">
        No settled paper trades yet. Equity curve updates automatically as trades settle.
      </div>
    );
  }

  const series = [{ index: 0, equity: 0 }, ...points];
  const values = series.map((p) => p.equity);
  const minVal = Math.min(0, ...values);
  const maxVal = Math.max(0, ...values);
  const span = Math.max(10, maxVal - minVal);
  const W = 720;
  const H = 220;
  const padX = 52;
  const padY = 20;
  const plotW = W - padX - 18;
  const plotH = H - padY * 2;

  const xOf = (idx: number) => padX + (idx / Math.max(1, series.length - 1)) * plotW;
  const yOf = (val: number) => padY + ((maxVal - val) / span) * plotH;
  const zeroY = yOf(0);

  const pathD = series
    .map((pt, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(pt.equity).toFixed(1)}`)
    .join(' ');

  const areaD = `${pathD} L${xOf(series.length - 1).toFixed(1)},${zeroY.toFixed(1)} L${xOf(0).toFixed(1)},${zeroY.toFixed(1)} Z`;

  const lastEquity = series[series.length - 1].equity;
  const stroke = lastEquity >= 0 ? '#10B981' : '#EF4444';

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#070C17] p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[210px] w-full">
        <defs>
          <linearGradient id="equityGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1={padX} y1={zeroY} x2={W - 18} y2={zeroY} className="stroke-slate-300 dark:stroke-slate-700" strokeDasharray="4 4" />
        <text x={8} y={zeroY + 4} className="fill-slate-600 dark:fill-slate-400" fontSize="10" fontFamily="JetBrains Mono, monospace">
          0.00
        </text>
        <text x={8} y={padY + 6} className="fill-slate-600 dark:fill-slate-400" fontSize="10" fontFamily="JetBrains Mono, monospace">
          {maxVal.toFixed(0)}
        </text>
        <text x={8} y={H - padY} className="fill-slate-600 dark:fill-slate-400" fontSize="10" fontFamily="JetBrains Mono, monospace">
          {minVal.toFixed(0)}
        </text>
        <path d={areaD} fill="url(#equityGrad)" />
        <path d={pathD} fill="none" stroke={stroke} strokeWidth="2.4" />
        {series.map((pt, i) => (
          <circle key={i} cx={xOf(i)} cy={yOf(pt.equity)} r="3.2" fill={stroke} />
        ))}
      </svg>
    </div>
  );
}

export function PeriodPerformanceChart({
  rows,
  emptyLabel,
}: {
  rows: PeriodPerformanceRow[];
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="h-[210px] rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-[#070C17] flex items-center justify-center p-4 text-center text-xs text-slate-500 dark:text-slate-400">
        {emptyLabel}
      </div>
    );
  }

  const maxAbs = Math.max(10, ...rows.map((r) => Math.abs(r.netPnl)));

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#070C17] p-4 space-y-3">
      <div className="flex items-end gap-2 h-[150px]">
        {rows.map((row) => {
          const heightPct = Math.max(8, Math.round((Math.abs(row.netPnl) / maxAbs) * 100));
          const positive = row.netPnl >= 0;
          return (
            <div key={row.period} className="flex-1 min-w-0 flex flex-col items-center justify-end h-full gap-1.5">
              <span
                className={`text-[10px] font-mono tabular-nums font-medium ${
                  positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                }`}
              >
                {positive ? '+' : ''}
                {row.netPnl.toFixed(0)}
              </span>
              <div className="w-full max-w-[34px] flex items-end justify-center h-[108px]">
                <div
                  style={{ height: `${heightPct}%` }}
                  className={`w-full rounded-t-md transition-all ${
                    positive
                      ? 'bg-gradient-to-t from-emerald-600 to-emerald-400'
                      : 'bg-gradient-to-t from-red-600 to-rose-400'
                  }`}
                  title={`${row.period}: ${row.wins}W/${row.losses}L (${row.netPnl >= 0 ? '+' : ''}${row.netPnl})`}
                />
              </div>
              <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 truncate max-w-full">
                {row.period.length > 7 ? row.period.slice(5) : row.period}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function WinLossDistributionChart({ wins, losses }: { wins: number; losses: number }) {
  const total = wins + losses;
  const winPct = total > 0 ? Math.round((wins / total) * 1000) / 10 : 0;
  const lossPct = total > 0 ? Math.round((losses / total) * 1000) / 10 : 0;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#070C17] p-4 space-y-4">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-slate-700 dark:text-slate-200">Winning vs Losing Distribution</span>
        <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">{total} settled</span>
      </div>

      {total === 0 ? (
        <p className="py-10 text-center text-xs text-slate-500 dark:text-slate-400">
          Settle paper trades to compare winning and losing trade ratios.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="h-4 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800 flex">
            <div style={{ width: `${winPct}%` }} className="bg-emerald-500 transition-all" />
            <div style={{ width: `${lossPct}%` }} className="bg-red-500 transition-all" />
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3">
              <p className="text-slate-600 dark:text-slate-300">Winning Trades</p>
              <p className="mt-1 text-lg font-semibold font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                {wins} ({winPct}%)
              </p>
            </div>
            <div className="rounded-lg border border-red-500/25 bg-red-500/10 p-3">
              <p className="text-slate-600 dark:text-slate-300">Losing Trades</p>
              <p className="mt-1 text-lg font-semibold font-mono tabular-nums text-red-600 dark:text-red-400">
                {losses} ({lossPct}%)
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

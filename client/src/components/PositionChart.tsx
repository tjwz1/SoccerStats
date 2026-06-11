import { useApi } from "../hooks/useApi";

interface PositionPoint {
  matchday: number;
  position: number;
  pts: number;
}

interface Props {
  competitionCode: string;
  teamId: number;
  season?: number;
}

export default function PositionChart({ competitionCode, teamId, season }: Props) {
  const url = `/api/competitions/${competitionCode}/position-history?teamId=${teamId}${season ? `&season=${season}` : ""}`;
  const { data: points, loading } = useApi<PositionPoint[]>(url);

  if (loading) {
    return (
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl px-4 py-5 flex items-center gap-3">
        <div className="w-4 h-4 border-2 border-slate-600 border-t-white rounded-full animate-spin shrink-0" />
        <span className="text-xs text-slate-500">Loading position history…</span>
      </div>
    );
  }
  if (!points || points.length === 0) return null;

  const W = 480;
  const H = 130;
  const padX = 36;
  const padY = 14;
  const chartW = W - padX * 2;
  const chartH = H - padY * 2;

  const n = points.length;
  const maxPos = Math.max(...points.map((p) => p.position));
  // Add 1 so there's breathing room below the worst position line
  const axisMax = maxPos + 1;

  function cx(i: number) {
    return padX + (i / Math.max(n - 1, 1)) * chartW;
  }
  // Inverted: position 1 maps to the top of the chart
  function cy(pos: number) {
    return padY + ((pos - 1) / (axisMax - 1)) * chartH;
  }

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${cx(i).toFixed(1)} ${cy(p.position).toFixed(1)}`)
    .join(" ");

  // Filled area beneath the line (inverted — "below" in chart space = worse positions)
  const areaPath = `${linePath} L ${cx(n - 1).toFixed(1)} ${(padY + chartH).toFixed(1)} L ${padX.toFixed(1)} ${(padY + chartH).toFixed(1)} Z`;

  // Zone bands — only render if they fit within axisMax
  const CLzone = 4;     // top 4 = CL (most leagues)
  const relZone = maxPos - 2; // bottom 3 (adjust to axisMax)

  // Y-axis ticks: 1 (top) and every 5 positions
  const yTicks: number[] = [1];
  for (let p = 5; p <= axisMax; p += 5) yTicks.push(p);
  if (!yTicks.includes(maxPos)) yTicks.push(maxPos);

  // Current (last) position
  const last = points[points.length - 1];
  const lastX = cx(n - 1);
  const lastY = cy(last.position);
  const posColor =
    last.position <= 4 ? "#22c55e" :
    last.position <= 6 ? "#86efac" :
    last.position >= relZone ? "#ef4444" :
    "#94a3b8";

  return (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
          League Position
        </h3>
        <div className="flex items-center gap-1.5">
          <span
            className="text-sm font-bold tabular-nums"
            style={{ color: posColor }}
          >
            {last.position}{last.position === 1 ? "st" : last.position === 2 ? "nd" : last.position === 3 ? "rd" : "th"}
          </span>
          <span className="text-[10px] text-slate-500">· {last.pts} pts</span>
        </div>
      </div>

      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
        <defs>
          {/* Green gradient for top positions (low position numbers = good) */}
          <linearGradient id="pos-area-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* CL zone band (positions 1-4) */}
        {CLzone < axisMax && (
          <rect
            x={padX} y={padY}
            width={chartW}
            height={cy(CLzone) - padY + (chartH / axisMax / 2)}
            fill="#22c55e" opacity="0.04"
          />
        )}

        {/* Relegation zone band */}
        {relZone <= axisMax && relZone > CLzone + 1 && (
          <rect
            x={padX} y={cy(relZone) - chartH / axisMax / 2}
            width={chartW}
            height={padY + chartH - cy(relZone) + chartH / axisMax / 2}
            fill="#ef4444" opacity="0.05"
          />
        )}

        {/* Y-axis gridlines */}
        {yTicks.map((pos) => (
          <g key={pos}>
            <line
              x1={padX} y1={cy(pos)} x2={W - padX} y2={cy(pos)}
              stroke="#1e293b" strokeWidth="1"
            />
            <text x={padX - 4} y={cy(pos) + 3} textAnchor="end" fontSize="8" fill="#475569">
              {pos}
            </text>
          </g>
        ))}

        {/* Area fill */}
        <path d={areaPath} fill="url(#pos-area-grad)" />

        {/* Line */}
        <path d={linePath} fill="none" stroke="#64748b" strokeWidth="1.5" strokeLinejoin="round" />

        {/* Data dots */}
        {points.map((p, i) => {
          const dotColor =
            p.position <= 4 ? "#22c55e" :
            p.position >= relZone ? "#ef4444" :
            "#475569";
          return (
            <g key={i}>
              <circle
                cx={cx(i)} cy={cy(p.position)} r="2.5"
                fill={dotColor} stroke="#0f172a" strokeWidth="0.5"
              />
              <title>MD{p.matchday}: {p.position}{p.position === 1 ? "st" : p.position === 2 ? "nd" : p.position === 3 ? "rd" : "th"} place · {p.pts} pts</title>
            </g>
          );
        })}

        {/* Highlight last position */}
        <circle cx={lastX} cy={lastY} r="5" fill={posColor} stroke="#0f172a" strokeWidth="1.5" />

        {/* Baseline */}
        <line x1={padX} y1={padY + chartH} x2={W - padX} y2={padY + chartH} stroke="#334155" strokeWidth="1" />

        {/* X-axis: first and last matchday labels */}
        <text x={padX} y={padY + chartH + 11} textAnchor="middle" fontSize="8" fill="#475569">
          MD{points[0].matchday}
        </text>
        {n > 1 && (
          <text x={cx(n - 1)} y={padY + chartH + 11} textAnchor="middle" fontSize="8" fill="#475569">
            MD{last.matchday}
          </text>
        )}
      </svg>

      {/* Zone legend */}
      <div className="flex items-center gap-4 mt-1">
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-sm bg-green-500/20 border border-green-500/30" />
          <span className="text-[9px] text-slate-500">Top 4</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-sm bg-red-500/20 border border-red-500/30" />
          <span className="text-[9px] text-slate-500">Relegation</span>
        </div>
        <span className="text-[9px] text-slate-600 ml-auto">{n} matches played</span>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import type { ScheduleMatch } from "../types";

const POLL_MS = 60_000;

function shortTeamName(name: string): string {
  return name
    .replace(/\s+(FC|F\.C\.|CF|AFC|SC|SV|RCD|CD|UD|SD)$/i, "")
    .replace(/^(FC|AFC)\s+/i, "")
    .replace(/\s+Football Club$/i, "")
    .trim();
}

interface LiveMatch extends Pick<ScheduleMatch, "id" | "homeTeam" | "homeTeamCrest" | "awayTeam" | "awayTeamCrest" | "scoreHome" | "scoreAway" | "competition" | "competitionEmblem"> {}

export default function LiveTicker() {
  const [matches, setMatches] = useState<LiveMatch[]>([]);
  const [error, setError] = useState(false);

  async function fetchLive() {
    try {
      const res = await fetch("/api/live-matches");
      if (!res.ok) throw new Error();
      const data: LiveMatch[] = await res.json();
      setMatches(data);
      setError(false);
    } catch {
      setError(true);
    }
  }

  useEffect(() => {
    fetchLive();
    const id = setInterval(fetchLive, POLL_MS);
    return () => clearInterval(id);
  }, []);

  if (error || matches.length === 0) return null;

  return (
    <div className="border-b border-slate-800 bg-slate-900/80 overflow-hidden">
      <div className="flex items-center">
        <div className="shrink-0 px-3 py-1.5 border-r border-slate-800 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          <span className="text-[9px] font-bold text-red-400 uppercase tracking-wider">Live</span>
        </div>
        {/* Scrolling ticker */}
        <div className="flex-1 overflow-hidden relative">
          <div
            className="flex items-center gap-6 px-4 animate-ticker whitespace-nowrap"
            style={{ animationDuration: `${Math.max(20, matches.length * 8)}s` }}
          >
            {/* Duplicate items for seamless loop */}
            {[...matches, ...matches].map((m, i) => (
              <span key={`${m.id}-${i}`} className="flex items-center gap-2 text-xs shrink-0">
                {m.competitionEmblem && (
                  <img src={m.competitionEmblem} alt="" className="w-3.5 h-3.5 object-contain" />
                )}
                {m.homeTeamCrest && (
                  <img src={m.homeTeamCrest} alt="" className="w-4 h-4 object-contain" />
                )}
                <span className="text-slate-300 font-medium">{shortTeamName(m.homeTeam)}</span>
                <span className="font-bold text-white tabular-nums px-1.5 py-0.5 bg-slate-800 rounded text-[11px]">
                  {m.scoreHome ?? 0} – {m.scoreAway ?? 0}
                </span>
                <span className="text-slate-300 font-medium">{shortTeamName(m.awayTeam)}</span>
                <span className="text-slate-700 text-base">·</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

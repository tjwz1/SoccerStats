import { useEffect, useState } from "react";
import type { ScheduleMatch, MatchGoalEvent } from "../types";
import { useLiveMatches } from "../contexts/LiveMatchesContext";

function shortTeamName(name: string): string {
  return name
    .replace(/\s+(FC|F\.C\.|CF|AFC|SC|SV|RCD|CD|UD|SD)$/i, "")
    .replace(/^(FC|AFC)\s+/i, "")
    .replace(/\s+Football Club$/i, "")
    .trim();
}

function goalLabel(g: MatchGoalEvent): string {
  const last = g.scorer.split(" ").pop() ?? g.scorer;
  const prefix = g.type === "OWN_GOAL" ? "OG " : g.type === "PENALTY" ? "PEN " : "";
  return `${prefix}${last} ${g.minute}'`;
}

export default function LiveTicker() {
  const { liveMatches: matches } = useLiveMatches();
  const [goalsByMatchId, setGoalsByMatchId] = useState<Map<number, MatchGoalEvent[]>>(new Map());

  // Lazily fetch goal events for each live match (ESPN-supplemented by the server)
  useEffect(() => {
    if (!matches.length) return;
    let cancelled = false;

    async function loadGoals(m: ScheduleMatch) {
      try {
        const params = new URLSearchParams({
          status: m.status,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          utcDate: m.utcDate,
          competition: m.competitionCode,
        });
        const res = await fetch(`/api/matches/${m.id}?${params}`);
        if (!res.ok || cancelled) return;
        const data = await res.json() as { goals: MatchGoalEvent[] };
        if (!cancelled) {
          setGoalsByMatchId((prev) => new Map([...prev, [m.id, data.goals ?? []]]));
        }
      } catch {}
    }

    for (const m of matches) loadGoals(m);
    return () => { cancelled = true; };
  }, [matches]);

  if (!matches.length) return null;

  // Build display entries (duplicate for seamless CSS marquee loop)
  const entries = [...matches, ...matches];

  return (
    <div className="border-b border-slate-800 bg-slate-900/80 overflow-hidden">
      <div className="flex items-center">
        <div className="shrink-0 px-3 py-1.5 border-r border-slate-800 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          <span className="text-[9px] font-bold text-red-400 uppercase tracking-wider">Live</span>
        </div>

        <div className="flex-1 overflow-hidden relative">
          <div
            className="flex items-center gap-6 px-4 animate-ticker whitespace-nowrap"
            style={{ animationDuration: `${Math.max(20, matches.length * 10)}s` }}
          >
            {entries.map((m, i) => {
              const goals = goalsByMatchId.get(m.id) ?? [];
              const homeGoals = goals.filter((g) => g.team === "home");
              const awayGoals = goals.filter((g) => g.team === "away");

              return (
                <span key={`${m.id}-${i}`} className="flex items-center gap-1.5 text-xs shrink-0">
                  {m.competitionEmblem && (
                    <img src={m.competitionEmblem} alt="" className="w-3.5 h-3.5 object-contain" />
                  )}

                  {/* Home side */}
                  <span className="flex items-center gap-1">
                    {m.homeTeamCrest && (
                      <img src={m.homeTeamCrest} alt="" className="w-4 h-4 object-contain" />
                    )}
                    <span className="text-slate-300 font-medium">{shortTeamName(m.homeTeam)}</span>
                    {homeGoals.length > 0 && (
                      <span className="text-[9px] text-green-500/80 ml-0.5">
                        {homeGoals.map(goalLabel).join(" ")}
                      </span>
                    )}
                  </span>

                  <span className="font-bold text-white tabular-nums px-1.5 py-0.5 bg-slate-800 rounded text-[11px]">
                    {m.scoreHome ?? 0} – {m.scoreAway ?? 0}
                  </span>

                  {/* Away side */}
                  <span className="flex items-center gap-1">
                    {awayGoals.length > 0 && (
                      <span className="text-[9px] text-green-500/80 mr-0.5">
                        {awayGoals.map(goalLabel).join(" ")}
                      </span>
                    )}
                    <span className="text-slate-300 font-medium">{shortTeamName(m.awayTeam)}</span>
                    {m.awayTeamCrest && (
                      <img src={m.awayTeamCrest} alt="" className="w-4 h-4 object-contain" />
                    )}
                  </span>

                  <span className="text-slate-700 text-base">·</span>
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { Team, CompetitionStats, StatLeader } from "../types";
import { useApi } from "../hooks/useApi";

type StatFilter = "goals" | "assists" | "cleanSheets";

// Standard competition ranking (1–1–3–4–4–6…).
function withRanks(leaders: StatLeader[]): Array<StatLeader & { rank: number }> {
  let rank = 1;
  return leaders.map((s, i, arr) => {
    if (i > 0 && s.value < arr[i - 1].value) rank = i + 1;
    return { ...s, rank };
  });
}

interface Props {
  compCode: string;
  season: number | null;
  onSelectTeam: (team: Team) => void;
}

export default function StatLeaders({ compCode, season, onSelectTeam }: Props) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<StatFilter>("goals");

  const qs = season ? `?season=${season}` : "";
  const { data: stats, loading, retry } = useApi<CompetitionStats>(
    `/api/competitions/${compCode}/live-scorers${qs}`
  );

  const retryRef = useRef(retry);
  useEffect(() => { retryRef.current = retry; }, [retry]);

  const FILTERS: { key: StatFilter; label: string; col: string }[] = [
    { key: "goals",       label: "Goals",       col: "G"  },
    { key: "assists",     label: "Assists",      col: "A"  },
    { key: "cleanSheets", label: "Clean Sheets", col: "CS" },
  ];

  const allLeaders: StatLeader[] =
    filter === "goals"       ? (stats?.goals       ?? []) :
    filter === "assists"     ? (stats?.assists      ?? []) :
                               (stats?.cleanSheets  ?? []);

  const ranked = withRanks(allLeaders);
  const leaders = ranked.slice(0, 10);

  const hasLive = !!stats?.hasLive && filter !== "cleanSheets";

  useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(() => retryRef.current(), 30_000);
    return () => clearInterval(id);
  }, [hasLive]);

  function handlePlayerClick(s: StatLeader) {
    if (!s.player.id) {
      onSelectTeam(s.team);
      return;
    }
    navigate(`/player/${s.player.id}?competition=${compCode}`, {
      state: {
        player: {
          id: s.player.id,
          name: s.player.name,
          position: s.player.position,
          nationality: s.player.nationality,
          dateOfBirth: s.player.dateOfBirth,
          shirtNumber: null,
        },
        teamName: s.team.shortName || s.team.name,
      },
    });
  }

  const activeCol = FILTERS.find((f) => f.key === filter)?.col ?? "G";

  return (
    <div className="flex flex-col gap-2 flex-1 min-h-0">
      {/* Filter tabs */}
      <div className="flex gap-1 bg-slate-800/60 rounded-lg p-0.5 shrink-0">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`flex-1 py-1 rounded-md text-[10px] font-medium transition-colors leading-tight px-1 ${
              filter === key
                ? "bg-green-600 text-white"
                : "text-slate-400 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Column header */}
      <div className="flex items-center gap-2 px-1 text-[10px] text-slate-600 uppercase tracking-wider shrink-0">
        <span className="w-4 text-right shrink-0">#</span>
        <span className="flex-1 pl-1 flex items-center gap-1.5">
          Player
          {hasLive && (
            <span className="flex items-center gap-1 text-green-400 normal-case tracking-normal font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              Live
            </span>
          )}
        </span>
        <span className="w-6 text-center shrink-0 font-bold">{activeCol}</span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto min-h-0 space-y-px">
        {loading && (
          <div className="space-y-1.5 mt-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-8 bg-slate-800 rounded animate-pulse" />
            ))}
          </div>
        )}

        {!loading && leaders.length === 0 && (
          <p className="text-xs text-slate-600 text-center mt-8 px-2">
            {filter === "cleanSheets"
              ? "No finished matches yet for this competition."
              : `No ${filter} data for this competition.`}
          </p>
        )}

        {leaders.map((s, i) => {
          const isLiveEntry = hasLive && (s.liveAdd ?? 0) > 0;
          const showRank = i === 0 || s.rank !== leaders[i - 1].rank;
          return (
            <div
              key={`${s.player.id || s.player.name}-${i}`}
              className={`flex items-center gap-2 px-1 py-1.5 rounded-md hover:bg-slate-800/60 group ${isLiveEntry ? "bg-green-950/30" : ""}`}
            >
              <span className="w-4 text-right text-[10px] text-slate-600 shrink-0 tabular-nums">
                {showRank ? s.rank : ""}
              </span>

              {/* Team crest */}
              <button
                onClick={() => onSelectTeam(s.team)}
                title={s.team.shortName || s.team.name}
                className="shrink-0"
              >
                {s.team.crest ? (
                  <img src={s.team.crest} alt="" className="w-4 h-4 object-contain" />
                ) : (
                  <div className="w-4 h-4 rounded-full bg-slate-700 flex items-center justify-center text-[7px] font-bold">
                    {s.team.tla.slice(0, 2)}
                  </div>
                )}
              </button>

              {/* Player / team name */}
              <button onClick={() => handlePlayerClick(s)} className="flex-1 min-w-0 text-left">
                <p className="text-xs text-slate-300 group-hover:text-white transition-colors font-medium truncate flex items-center gap-1">
                  {s.player.name}
                  {isLiveEntry && (
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse shrink-0" />
                  )}
                </p>
                {(s.player.id !== 0 || filter !== "cleanSheets") && (
                  <p className="text-[10px] text-slate-600 truncate">
                    {s.team.shortName || s.team.name}
                  </p>
                )}
              </button>

              <span className={`w-6 text-center text-sm font-bold tabular-nums shrink-0 ${isLiveEntry ? "text-green-300" : "text-white"}`}>
                {s.value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { Competition, Team, CompetitionStats, StatLeader } from "../types";
import type { FavTeam } from "../hooks/useFavourites";
import { useApi } from "../hooks/useApi";

type StatFilter = "goals" | "assists" | "cleanSheets";

// Standard competition ranking (1–1–3–4–4–6…).
// Tied players share the same rank; the next rank skips the occupied positions.
function withRanks(leaders: StatLeader[]): Array<StatLeader & { rank: number }> {
  let rank = 1;
  return leaders.map((s, i, arr) => {
    if (i > 0 && s.value < arr[i - 1].value) rank = i + 1;
    return { ...s, rank };
  });
}

interface Props {
  onSelectTeam: (team: Team) => void;
  selectedTeam: Team | null;
  selectedComp: Competition | null;
  onSelectComp: (comp: Competition) => void;
  selectedSeason: number | null;
  onSelectSeason: (year: number | null) => void;
  favourites: FavTeam[];
  isFavourite: (id: number) => boolean;
  toggleFavourite: (team: Team, competitionCode?: string) => void;
}

// ── Stat leaders panel (shown when no team selected) ─────────────────────────

function StatLeaders({
  compCode,
  season,
  onSelectTeam,
}: {
  compCode: string;
  season: number | null;
  onSelectTeam: (team: Team) => void;
}) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<StatFilter>("goals");

  const qs = season ? `?season=${season}` : "";
  const { data: stats, loading, retry } = useApi<CompetitionStats>(
    `/api/competitions/${compCode}/live-scorers${qs}`
  );

  // Poll every 30s — scorers TTL on server is 2min, so this picks up updates promptly
  const retryRef = useRef(retry);
  useEffect(() => { retryRef.current = retry; }, [retry]);
  useEffect(() => {
    const id = setInterval(() => retryRef.current(), 30_000);
    return () => clearInterval(id);
  }, []);

  const FILTERS: { key: StatFilter; label: string; col: string }[] = [
    { key: "goals",       label: "Goals",  col: "G" },
    { key: "assists",     label: "Assists", col: "A" },
    { key: "cleanSheets", label: "Clean Sheets", col: "CS" },
  ];

  const allLeaders: StatLeader[] =
    filter === "goals"       ? (stats?.goals       ?? []) :
    filter === "assists"     ? (stats?.assists      ?? []) :
                               (stats?.cleanSheets  ?? []);

  const ranked = withRanks(allLeaders);
  const leaders = ranked.slice(0, 10);

  const hasLive = !!stats?.hasLive && filter !== "cleanSheets";

  function handlePlayerClick(s: StatLeader) {
    // Clean-sheet entries use ESPN player IDs (id=0) — navigate to team instead
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

// ── Main export ───────────────────────────────────────────────────────────────

export default function TeamSearch({
  onSelectTeam,
  selectedTeam,
  selectedComp,
  onSelectComp,
  selectedSeason,
  onSelectSeason,
  favourites,
  isFavourite,
  toggleFavourite,
}: Props) {
  const { data: competitions, loading: compsLoading } = useApi<Competition[]>("/api/competitions");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Team[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  // Debounced global team search
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) { setSearchResults(null); return; }
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await fetch(`/api/teams/search?q=${encodeURIComponent(q)}`);
        setSearchResults(await res.json());
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const isSearching = searchQuery.trim().length >= 2;

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Global team search — always visible */}
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search any team…"
        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-green-500 shrink-0"
      />

      {/* 1-char hint */}
      {searchQuery.trim().length === 1 && (
        <p className="text-xs text-slate-600 text-center -mt-1 shrink-0">Type at least 2 characters</p>
      )}

      {/* Search results */}
      {isSearching && (
        <div className="flex-1 overflow-y-auto min-h-0">
          {searchLoading && (
            <div className="space-y-1.5 mt-1">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-9 bg-slate-800 rounded animate-pulse" />
              ))}
            </div>
          )}
          {!searchLoading && searchResults?.length === 0 && (
            <p className="text-xs text-slate-500 text-center mt-8">
              No teams found for <span className="text-slate-300">"{searchQuery}"</span>
            </p>
          )}
          {!searchLoading && (searchResults ?? []).map((team) => (
            <button
              key={team.id}
              onClick={() => { onSelectTeam(team); setSearchQuery(""); }}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition-colors mb-0.5 ${
                selectedTeam?.id === team.id
                  ? "bg-green-700/40 text-white border border-green-600"
                  : "text-slate-300 hover:bg-slate-700"
              }`}
            >
              {team.crest ? (
                <img src={team.crest} alt="" className="w-6 h-6 object-contain shrink-0" />
              ) : (
                <div className="w-6 h-6 rounded-full bg-slate-600 flex items-center justify-center text-[10px] font-bold shrink-0">
                  {team.tla}
                </div>
              )}
              <span className="font-medium truncate">{team.shortName || team.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Normal view when not searching */}
      {!isSearching && (
        <>
      {/* Competition selector */}
      <select
        value={selectedComp?.code ?? ""}
        onChange={(e) => {
          const comp = competitions?.find((c) => c.code === e.target.value) ?? null;
          if (comp) onSelectComp(comp);
        }}
        disabled={compsLoading}
        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-green-500 cursor-pointer disabled:opacity-50"
      >
        <option value="" disabled>
          Select a league…
        </option>
        {competitions?.map((c) => (
          <option key={c.id} value={c.code}>
            {c.name}
          </option>
        ))}
      </select>

      {/* Favourites quick-access strip */}
      {favourites.length > 0 && (
        <div className="shrink-0">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold mb-1.5">
            Favourites
          </p>
          <div className="flex flex-wrap gap-1.5">
            {favourites.map((team) => (
              <div
                key={team.id}
                className="flex items-center gap-0.5 bg-slate-800 hover:bg-slate-700 rounded-md pl-1.5 pr-0.5 py-0.5 transition-colors group/chip"
              >
                <button
                  onClick={() => {
                    // If this favourite has a stored competition and it differs from the
                    // current selection, switch to it so the schedule/lineup load correctly.
                    if (team.competitionCode && team.competitionCode !== selectedComp?.code) {
                      const comp = competitions?.find((c) => c.code === team.competitionCode);
                      if (comp) onSelectComp(comp);
                    }
                    onSelectTeam(team);
                  }}
                  className="flex items-center gap-1 text-xs text-slate-300 group-hover/chip:text-white transition-colors"
                >
                  {team.crest && (
                    <img src={team.crest} alt="" className="w-3.5 h-3.5 object-contain shrink-0" />
                  )}
                  <span className="max-w-[72px] truncate">{team.shortName || team.name}</span>
                </button>
                <button
                  onClick={() => toggleFavourite(team)}
                  title="Remove from favourites"
                  className="ml-0.5 text-slate-600 hover:text-red-400 transition-colors text-sm leading-none px-0.5"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No competition selected */}
      {!selectedComp && !compsLoading && (
        <p className="text-xs text-slate-500 text-center mt-6">
          Select a league above to get started
        </p>
      )}

      {/* Stat leaders — shown when a competition is selected */}
      {selectedComp && (
        <StatLeaders compCode={selectedComp.code} season={selectedSeason} onSelectTeam={onSelectTeam} />
      )}
        </>
      )}
    </div>
  );
}

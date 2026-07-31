import { useState } from "react";
import type { Competition, Team } from "../types";
import type { FavTeam } from "../hooks/useFavourites";
import { useCompetitions } from "../contexts/CompetitionsContext";
import { useTeamSearch } from "../hooks/useTeamSearch";
import StatLeaders from "./StatLeaders";

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

// ── Main export ───────────────────────────────────────────────────────────────

export default function TeamSearch({
  onSelectTeam,
  selectedTeam,
  selectedComp,
  onSelectComp,
  selectedSeason,
  onSelectSeason: _onSelectSeason,
  favourites,
  isFavourite: _isFavourite,
  toggleFavourite,
}: Props) {
  const { competitions, competitionsLoading: compsLoading } = useCompetitions();
  const [searchQuery, setSearchQuery] = useState("");

  // Routed through useTeamSearch so the INFLIGHT deduplication map prevents
  // concurrent identical queries from firing duplicate HTTP requests.
  const { results: searchResults, loading: searchLoading } = useTeamSearch(searchQuery, 300);

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

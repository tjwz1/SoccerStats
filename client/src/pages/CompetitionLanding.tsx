import { useState, useEffect } from "react";
import type { Competition, StandingsData, CompetitionSeason, Team } from "../types";
import { useApi } from "../hooks/useApi";
import BracketView from "../components/BracketView";

// ── Qualification zone config ─────────────────────────────────────────────────

type Zone = "ucl" | "uel" | "ecl" | "playoff" | "rel";

// [minPos, maxPos, zone] — inclusive position bounds
// Exact overrides for competitions where the specific rules are known
const ZONE_OVERRIDES: Record<string, [number, number, Zone][]> = {
  PL:  [[1,4,"ucl"], [5,5,"uel"], [6,6,"ecl"], [18,20,"rel"]],
  BL1: [[1,4,"ucl"], [5,5,"uel"], [6,6,"ecl"], [16,16,"playoff"], [17,18,"rel"]],
  PD:  [[1,4,"ucl"], [5,5,"uel"], [6,7,"ecl"], [18,20,"rel"]],
  SA:  [[1,4,"ucl"], [5,6,"uel"], [7,7,"ecl"], [18,20,"rel"]],
  FL1: [[1,2,"ucl"], [3,3,"uel"], [4,4,"ecl"], [17,17,"playoff"], [18,20,"rel"]],
  DED: [[1,2,"ucl"], [3,4,"uel"], [5,5,"ecl"], [16,16,"playoff"], [17,18,"rel"]],
  PPL: [[1,2,"ucl"], [3,3,"uel"], [4,4,"ecl"], [16,16,"playoff"], [17,18,"rel"]],
};

// For competitions without exact rules, derive reasonable zones from team count
function deriveZones(totalTeams: number): [number, number, Zone][] {
  if (totalTeams < 8) return [];
  const relCount = totalTeams >= 18 ? 3 : 2;
  const uclSpots = totalTeams >= 16 ? 4 : 2;
  return [
    [1, uclSpots, "ucl"],
    [uclSpots + 1, uclSpots + 1, "uel"],
    [totalTeams - relCount + 1, totalTeams, "rel"],
  ];
}

function getZoneRanges(compCode: string, totalTeams: number): [number, number, Zone][] {
  return ZONE_OVERRIDES[compCode] ?? deriveZones(totalTeams);
}

const ZONE_DOT: Record<Zone, string> = {
  ucl:     "bg-blue-500",
  uel:     "bg-orange-500",
  ecl:     "bg-lime-500",
  playoff: "bg-yellow-500",
  rel:     "bg-red-500",
};

const ZONE_LABEL: Record<Zone, string> = {
  ucl:     "Champions League",
  uel:     "Europa League",
  ecl:     "Conference League",
  playoff: "Playoff",
  rel:     "Relegation",
};

function getZone(compCode: string, position: number, totalTeams: number): Zone | null {
  for (const [min, max, zone] of getZoneRanges(compCode, totalTeams)) {
    if (position >= min && position <= max) return zone;
  }
  return null;
}

// Competitions that have a knockout bracket in addition to standings
const KNOCKOUT_COMP_CODES = new Set(["CL", "EL", "ECL", "EC", "WC", "CLI"]);

type CompView = "standings" | "bracket";

interface Props {
  comp: Competition;
  onSelectTeam: (team: Team) => void;
  selectedSeason: number | null;
  onSeasonChange: (year: number | null) => void;
  isFavourite: (id: number) => boolean;
  toggleFavourite: (team: Team) => void;
}

function FormPips({ form }: { form: string | null }) {
  if (!form) return null;
  const results = form.split(",").slice(-5);
  return (
    <div className="flex gap-0.5">
      {results.map((r, i) => (
        <span
          key={i}
          title={r === "W" ? "Win" : r === "D" ? "Draw" : "Loss"}
          className={`w-4 h-4 rounded-sm text-[8px] font-bold flex items-center justify-center ${
            r === "W"
              ? "bg-green-600/80 text-green-100"
              : r === "D"
              ? "bg-slate-600 text-slate-300"
              : "bg-red-700/70 text-red-200"
          }`}
        >
          {r}
        </span>
      ))}
    </div>
  );
}

export default function CompetitionLanding({ comp, onSelectTeam, selectedSeason, onSeasonChange, isFavourite, toggleFavourite }: Props) {
  const hasKnockout = KNOCKOUT_COMP_CODES.has(comp.code);
  const [compView, setCompView] = useState<CompView>("standings");

  const [selectedGroupType, setSelectedGroupType] = useState<string | null>(null);
  const [isMultiGroup, setIsMultiGroup] = useState(false);

  const { data: seasons } = useApi<CompetitionSeason[]>(
    `/api/competitions/${comp.code}/seasons`
  );

  const standingsUrl = `/api/competitions/${comp.code}/standings${
    selectedSeason ? `?season=${selectedSeason}` : ""
  }`;
  const { data: standings, loading } = useApi<StandingsData>(standingsUrl);

  const groups = standings?.groups ?? [];

  useEffect(() => {
    if (groups.length > 1) setIsMultiGroup(true);
  }, [groups.length]);

  useEffect(() => {
    setSelectedGroupType(null);
    setIsMultiGroup(false);
    setCompView("standings");
  }, [comp.code]);

  useEffect(() => {
    if (groups.length > 0 && !selectedGroupType) {
      setSelectedGroupType(groups[0].type);
    }
  }, [standings]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSelectedGroupType(null);
  }, [selectedSeason]);

  const activeGroup =
    (selectedGroupType ? groups.find((g) => g.type === selectedGroupType) : null) ??
    groups[0];
  const rows = activeGroup?.rows ?? [];

  return (
    <div className="w-full">
      {/* Header row: competition name + selectors */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          {comp.emblem && (
            <img src={comp.emblem} alt="" className="w-8 h-8 object-contain" />
          )}
          <h2 className="text-lg font-bold text-white">{comp.name}</h2>
          {activeGroup && groups.length === 1 && (
            <span className="text-xs text-slate-500 uppercase tracking-wider">
              Standings
            </span>
          )}
        </div>

        <div className="flex gap-2">
          {seasons && seasons.length > 1 && (
            <select
              value={selectedSeason ?? ""}
              onChange={(e) =>
                onSeasonChange(e.target.value ? parseInt(e.target.value) : null)
              }
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-green-500 cursor-pointer"
            >
              <option value="">Current season</option>
              {seasons.slice(1).map((s) => (
                <option key={s.year} value={s.year}>
                  {s.year}
                  {s.winner ? ` · ${s.winner}` : ""}
                </option>
              ))}
            </select>
          )}

          {isMultiGroup && groups.length > 0 && (
            <select
              value={activeGroup?.type ?? ""}
              onChange={(e) => setSelectedGroupType(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-green-500 cursor-pointer"
            >
              {groups.map((g) => (
                <option key={g.type} value={g.type}>
                  Group {g.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Standings / Bracket tab strip */}
      {hasKnockout && (
        <div className="flex gap-1 mb-4 border-b border-slate-800">
          {(["standings", "bracket"] as CompView[]).map((v) => (
            <button
              key={v}
              onClick={() => setCompView(v)}
              className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                compView === v
                  ? "border-green-500 text-white"
                  : "border-transparent text-slate-500 hover:text-slate-300"
              }`}
            >
              {v === "standings" ? (isMultiGroup ? "Groups" : "Standings") : "Bracket"}
            </button>
          ))}
        </div>
      )}

      {/* Bracket view */}
      {compView === "bracket" && (
        <BracketView compCode={comp.code} season={selectedSeason} />
      )}

      {/* Standings table */}
      {compView === "standings" && <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden">
        {/* Column headers */}
        <div className="grid items-center gap-x-4 px-5 py-3 border-b border-slate-800 text-[11px] text-slate-500 uppercase tracking-wider font-medium"
          style={{ gridTemplateColumns: "2rem 1fr 2.5rem 2.5rem 2.5rem 2.5rem 3rem 3rem 5.5rem 1.25rem" }}
        >
          <span className="text-right">#</span>
          <span className="pl-2">Club</span>
          <span className="text-center">P</span>
          <span className="text-center">W</span>
          <span className="text-center">D</span>
          <span className="text-center">L</span>
          <span className="text-center">GD</span>
          <span className="text-center font-bold text-slate-400">Pts</span>
          <span className="text-center">Form</span>
          <span />
        </div>

        {/* Skeleton */}
        {loading && (
          <div>
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                className={`h-12 animate-pulse ${i % 2 === 1 ? "bg-slate-800/30" : "bg-slate-800/10"}`}
              />
            ))}
          </div>
        )}

        {!loading && rows.length === 0 && (
          <p className="text-sm text-slate-500 text-center py-14">
            No standings available for this competition.
          </p>
        )}

        {/* Rows */}
        {rows.map((row, i) => {
          const zone = getZone(comp.code, row.position, rows.length);
          return (
          <div
            key={row.team.id}
            className={`relative w-full grid items-center gap-x-4 px-5 py-3 transition-colors border-b border-slate-800/40 last:border-0 hover:bg-green-900/10 group ${
              i % 2 === 1 ? "bg-slate-900/30" : ""
            }`}
            style={{ gridTemplateColumns: "2rem 1fr 2.5rem 2.5rem 2.5rem 2.5rem 3rem 3rem 5.5rem 1.25rem" }}
          >
            {/* Zone indicator bar — absolutely positioned to avoid border-color conflicts */}
            {zone && (
              <span className={`absolute left-0 top-0 bottom-0 w-1 ${ZONE_DOT[zone]}`} />
            )}
            {/* Position */}
            <span className="text-right text-sm text-slate-500 tabular-nums font-medium">
              {row.position}
            </span>

            {/* Club name + crest — clickable */}
            <button
              onClick={() => onSelectTeam(row.team)}
              className="flex items-center gap-2.5 pl-2 min-w-0 text-left"
            >
              {row.team.crest ? (
                <img src={row.team.crest} alt="" className="w-5 h-5 object-contain shrink-0" />
              ) : (
                <div className="w-5 h-5 rounded-full bg-slate-700 flex items-center justify-center text-[8px] font-bold shrink-0">
                  {row.team.tla.slice(0, 2)}
                </div>
              )}
              <span className="text-sm font-medium text-white truncate group-hover:text-green-400 transition-colors">
                {row.team.shortName || row.team.name}
              </span>
            </button>

            {/* Stats — clicking anywhere in the row (outside the two buttons) also selects */}
            <span onClick={() => onSelectTeam(row.team)} className="text-center text-sm text-slate-400 tabular-nums cursor-pointer">
              {row.playedGames}
            </span>
            <span onClick={() => onSelectTeam(row.team)} className="text-center text-sm text-slate-400 tabular-nums cursor-pointer">
              {row.won}
            </span>
            <span onClick={() => onSelectTeam(row.team)} className="text-center text-sm text-slate-400 tabular-nums cursor-pointer">
              {row.draw}
            </span>
            <span onClick={() => onSelectTeam(row.team)} className="text-center text-sm text-slate-400 tabular-nums cursor-pointer">
              {row.lost}
            </span>
            <span
              onClick={() => onSelectTeam(row.team)}
              className={`text-center text-sm tabular-nums font-medium cursor-pointer ${
                row.goalDifference > 0
                  ? "text-green-400/80"
                  : row.goalDifference < 0
                  ? "text-red-400/80"
                  : "text-slate-400"
              }`}
            >
              {row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference}
            </span>
            <span onClick={() => onSelectTeam(row.team)} className="text-center text-sm font-bold text-white tabular-nums cursor-pointer">
              {row.points}
            </span>

            {/* Form pips */}
            <div onClick={() => onSelectTeam(row.team)} className="flex justify-center cursor-pointer">
              <FormPips form={row.form} />
            </div>

            {/* Favourite star */}
            <button
              onClick={() => toggleFavourite(row.team)}
              title={isFavourite(row.team.id) ? "Remove from favourites" : "Add to favourites"}
              className={`text-sm text-center transition-colors ${
                isFavourite(row.team.id)
                  ? "text-yellow-400"
                  : "text-slate-700 opacity-0 group-hover:opacity-100 hover:text-yellow-400"
              }`}
            >
              {isFavourite(row.team.id) ? "★" : "☆"}
            </button>
          </div>
        );
        })}
      </div>}

      {/* Zone legend */}
      {compView === "standings" && rows.length > 0 && (() => {
        const zoneRanges = getZoneRanges(comp.code, rows.length);
        if (zoneRanges.length === 0) return null;
        const uniqueZones = zoneRanges.map(([,, z]) => z).filter((z, i, a) => a.indexOf(z) === i) as Zone[];
        return (
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 px-1">
            {uniqueZones.map((zone) => (
              <div key={zone} className="flex items-center gap-1.5">
                <div className={`w-0.5 h-3 rounded-full ${ZONE_DOT[zone]}`} />
                <span className="text-[10px] text-slate-500">{ZONE_LABEL[zone]}</span>
              </div>
            ))}
          </div>
        );
      })()}

      {compView === "standings" && (
        <p className="text-[10px] text-slate-600 text-right mt-2 uppercase tracking-wider">
          Click a club to view their squad &amp; schedule
        </p>
      )}
    </div>
  );
}

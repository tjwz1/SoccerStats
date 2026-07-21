import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { Competition, StandingsData, CompetitionSeason, Team, ScheduleMatch, StandingRow } from "../types";
import { useApi } from "../hooks/useApi";
import { useLiveMatches } from "../contexts/LiveMatchesContext";
import BracketView from "../components/BracketView";
import StatLeaders from "../components/StatLeaders";

// ── Fixture types ─────────────────────────────────────────────────────────────

interface FixtureMatch {
  id: number;
  utcDate: string;
  status: string;
  matchday: number | null;
  stage: string;
  homeTeam: { id: number; name: string; crest: string };
  awayTeam: { id: number; name: string; crest: string };
  scoreHome: number | null;
  scoreAway: number | null;
  winner: string | null;
}

// ── Qualification zone config ─────────────────────────────────────────────────

// International group tournaments where top 2 advance + best 3rd-placed teams
const INTL_GROUP_CODES = new Set(["WC", "EC"]);

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

type CompView = "standings" | "bracket" | "fixtures" | "scorers";

// ── Fixture helpers ───────────────────────────────────────────────────────────

const STAGE_LABELS: Record<string, string> = {
  REGULAR_SEASON: "Regular Season",
  GROUP_STAGE: "Group Stage",
  ROUND_OF_16: "Round of 16",
  QUARTER_FINALS: "Quarter-Finals",
  SEMI_FINALS: "Semi-Finals",
  FINAL: "Final",
  PRELIMINARY_ROUND: "Preliminary Round",
  QUALIFICATION: "Qualification",
  PLAYOFF_ROUND_ONE: "Playoff Round 1",
  PLAYOFF_ROUND_TWO: "Playoff Round 2",
  "3RD_PLACE": "3rd Place",
  KNOCKOUT_ROUND_PLAY_OFFS: "Knockout Round Play-Offs",
  LEAGUE_PHASE: "League Phase",
  FIRST_ROUND: "Round 1",
  SECOND_ROUND: "Round 2",
  THIRD_ROUND: "Round 3",
  FOURTH_ROUND: "Round 4",
};

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtFixtureDate(utcDate: string): string {
  const d = new Date(utcDate);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time}`;
}

function shortTeamName(name: string): string {
  return name
    .replace(/\s+(FC|F\.C\.|CF|C\.F\.|AFC|A\.F\.C\.|SC|S\.C\.|SV|CD|UD|SD)$/i, "")
    .replace(/^(FC|F\.C\.|AFC|A\.F\.C\.)\s+/i, "")
    .replace(/\s+Football Club$/i, "")
    .trim();
}

// ── FixturesView component ────────────────────────────────────────────────────

function buildTeam(t: { id: number; name: string; crest: string }): Team {
  return { id: t.id, name: t.name, shortName: t.name, crest: t.crest, tla: "" };
}

function FixtureMatchRow({ m, onSelectTeam }: { m: FixtureMatch; onSelectTeam: (t: Team) => void }) {
  const [homeErr, setHomeErr] = useState(false);
  const [awayErr, setAwayErr] = useState(false);
  const isFinished = m.status === "FINISHED";
  const isLive = m.status === "IN_PLAY" || m.status === "PAUSED";
  const hasScore = m.scoreHome !== null && m.scoreAway !== null;
  return (
    <div className={`flex items-center px-4 py-2.5 gap-2 ${isLive ? "bg-green-950/20" : ""}`}>
      {/* Home team */}
      <div className="flex items-center gap-1.5 flex-1 min-w-0 justify-end">
        <button
          onClick={() => onSelectTeam(buildTeam(m.homeTeam))}
          className="text-xs font-medium text-slate-200 hover:text-green-400 transition-colors truncate text-right"
        >
          {shortTeamName(m.homeTeam.name)}
        </button>
        {m.homeTeam.crest && !homeErr ? (
          <img src={m.homeTeam.crest} alt="" onError={() => setHomeErr(true)} className="w-5 h-5 object-contain shrink-0" />
        ) : null}
      </div>

      {/* Score or time */}
      <div className="w-20 shrink-0 text-center">
        {isFinished && hasScore ? (
          <span className="text-sm font-bold text-white tabular-nums">{m.scoreHome}–{m.scoreAway}</span>
        ) : isLive && hasScore ? (
          <span className="text-sm font-bold text-red-300 tabular-nums">{m.scoreHome}–{m.scoreAway}</span>
        ) : m.status === "POSTPONED" ? (
          <span className="text-[10px] font-semibold text-amber-400">POSTP.</span>
        ) : (
          <span className="text-[10px] text-slate-500 leading-tight">{fmtFixtureDate(m.utcDate)}</span>
        )}
      </div>

      {/* Away team */}
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        {m.awayTeam.crest && !awayErr ? (
          <img src={m.awayTeam.crest} alt="" onError={() => setAwayErr(true)} className="w-5 h-5 object-contain shrink-0" />
        ) : null}
        <button
          onClick={() => onSelectTeam(buildTeam(m.awayTeam))}
          className="text-xs font-medium text-slate-200 hover:text-green-400 transition-colors truncate"
        >
          {shortTeamName(m.awayTeam.name)}
        </button>
      </div>
    </div>
  );
}

function FixturesView({
  comp,
  selectedSeason,
  onSelectTeam,
}: {
  comp: Competition;
  selectedSeason: number | null;
  onSelectTeam: (team: Team) => void;
}) {
  const fixturesUrl = `/api/competitions/${comp.code}/fixtures${selectedSeason ? `?season=${selectedSeason}` : ""}`;
  const { data: fixtures, loading, error } = useApi<FixtureMatch[]>(fixturesUrl);

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-slate-500">
        <div className="w-6 h-6 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
        <p className="text-sm">Loading fixtures…</p>
      </div>
    );
  }
  if (error) {
    return (
      <p className="text-sm text-red-400 text-center py-14">
        {error.includes("403") ? "This competition requires a paid API tier." : "Failed to load fixtures."}
      </p>
    );
  }
  if (!fixtures || fixtures.length === 0) {
    return <p className="text-sm text-slate-500 text-center py-14">No fixtures available.</p>;
  }

  // Determine grouping key: matchday if present, else stage
  const hasMatchdays = fixtures.some((m) => m.matchday !== null);

  type Group = { key: string; label: string; matches: FixtureMatch[] };
  const groupMap = new Map<string, Group>();

  for (const m of fixtures) {
    let key: string;
    let label: string;
    if (hasMatchdays && m.matchday !== null) {
      key = `md-${m.matchday}`;
      label = `Matchday ${m.matchday}`;
    } else {
      key = `stage-${m.stage}`;
      label = stageLabel(m.stage || "Other");
    }
    if (!groupMap.has(key)) groupMap.set(key, { key, label, matches: [] });
    groupMap.get(key)!.matches.push(m);
  }

  const groups = Array.from(groupMap.values());

  return (
    <div className="space-y-4">
      {groups.map(({ key, label, matches }) => {
        const collapsed = collapsedGroups.has(key);
        return (
          <div key={key} className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden">
            {/* Group header */}
            <button
              onClick={() => toggleGroup(key)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-800/40 transition-colors"
            >
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{label}</span>
              <svg
                className={`w-4 h-4 text-slate-600 transition-transform ${collapsed ? "" : "rotate-180"}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {!collapsed && (
              <div className="divide-y divide-slate-800/50">
                {matches.map((m) => (
                  <FixtureMatchRow key={m.id} m={m} onSelectTeam={onSelectTeam} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface Props {
  comp: Competition;
  onSelectTeam: (team: Team) => void;
  selectedSeason: number | null;
  onSeasonChange: (year: number | null) => void;
  isFavourite: (id: number) => boolean;
  toggleFavourite: (team: Team, competitionCode?: string) => void;
}

// Compute projected points and goal-difference adjustment from a live match score
function calcLiveAdj(teamId: number, m: ScheduleMatch): { pts: number; gd: number } {
  const isHome = m.homeTeamId === teamId;
  const gf = isHome ? (m.scoreHome ?? 0) : (m.scoreAway ?? 0);
  const ga = isHome ? (m.scoreAway ?? 0) : (m.scoreHome ?? 0);
  return { pts: gf > ga ? 3 : gf === ga ? 1 : 0, gd: gf - ga };
}

type LiveRow = StandingRow & {
  originalPosition: number;
  projectedPosition: number;
  projectedPts: number;
  projectedGD: number;
  liveMatch: ScheduleMatch | null;
};

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

  const { data: seasons } = useApi<CompetitionSeason[]>(
    `/api/competitions/${comp.code}/seasons`
  );

  const standingsUrl = `/api/competitions/${comp.code}/standings${
    selectedSeason ? `?season=${selectedSeason}` : ""
  }`;
  const { data: standings, loading, error: standingsError, retry: retryStandings } = useApi<StandingsData>(standingsUrl);

  const retryStandingsRef = useRef(retryStandings);
  useEffect(() => { retryStandingsRef.current = retryStandings; }, [retryStandings]);

  const groups = standings?.groups ?? [];
  const isMultiGroup = groups.length > 1;

  // Silently prime past-season standings + scorers so the season switcher feels instant.
  // Past seasons are cached FOREVER on the server, so each URL is only fetched once ever.
  useEffect(() => {
    if (!seasons || seasons.length <= 1) return;
    for (const s of seasons.slice(1)) {
      fetch(`/api/competitions/${comp.code}/standings?season=${s.year}`).catch(() => {});
      fetch(`/api/competitions/${comp.code}/scorers?season=${s.year}`).catch(() => {});
    }
  }, [seasons, comp.code]);

  // Prefetch a team's lineup when the user hovers a standings row. 150ms debounce
  // prevents firing on accidental hover-throughs while scrolling.
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchTeam = useCallback((teamId: number) => {
    if (prefetchTimer.current) clearTimeout(prefetchTimer.current);
    prefetchTimer.current = setTimeout(() => {
      fetch(`/api/teams/${teamId}/lineup?competition=${comp.code}`).catch(() => {});
    }, 150);
  }, [comp.code]);

  useEffect(() => {
    setSelectedGroupType(null);
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

  // Reset to standings if the Scorers tab is active but the current comp doesn't show it.
  useEffect(() => {
    if (hasKnockout && compView === "scorers") setCompView("standings");
  }, [hasKnockout, compView]);

  const activeGroup =
    (selectedGroupType ? groups.find((g) => g.type === selectedGroupType) : null) ??
    groups[0];
  const rows = activeGroup?.rows ?? [];

  // ── WC / EC group qualification status ─────────────────────────────────────
  const isIntlMultiGroup = isMultiGroup && INTL_GROUP_CODES.has(comp.code);

  // Live matches come from the global context (polled every 30s by LiveMatchesContext).
  // Filter to this competition — avoids a redundant per-competition polling interval.
  const { liveMatches: allLiveMatches } = useLiveMatches();
  const liveMatches = useMemo(
    () => allLiveMatches.filter((m) => m.competitionCode === comp.code),
    [allLiveMatches, comp.code]
  );

  // team ID → live match lookup (covers all groups in tournament)
  const liveByTeam = useMemo(() => {
    const map = new Map<number, ScheduleMatch>();
    for (const m of liveMatches ?? []) {
      map.set(m.homeTeamId, m);
      map.set(m.awayTeamId, m);
    }
    return map;
  }, [liveMatches]);

  const hasLiveInGroup = (liveMatches?.length ?? 0) > 0 &&
    rows.some((r) => liveByTeam.has(r.team.id));

  // Poll standings every 60s so form and points update automatically after a match ends.
  // The server's 15-min SWR handles the expensive re-computation; this just ensures the
  // client triggers it rather than showing stale data until the next page navigation.
  useEffect(() => {
    if (!hasLiveInGroup) return;
    const id = setInterval(() => retryStandingsRef.current(), 60_000);
    return () => clearInterval(id);
  }, [hasLiveInGroup]);

  // Projected standings: apply current live score outcomes then re-sort
  const projectedRows = useMemo((): LiveRow[] => {
    if (!liveMatches?.length) {
      return rows.map((r) => ({
        ...r,
        originalPosition: r.position,
        projectedPosition: r.position,
        projectedPts: r.points,
        projectedGD: r.goalDifference,
        liveMatch: null,
      }));
    }
    const augmented = rows.map((r) => {
      const m = liveByTeam.get(r.team.id) ?? null;
      const adj = m ? calcLiveAdj(r.team.id, m) : { pts: 0, gd: 0 };
      return {
        ...r,
        originalPosition: r.position,
        projectedPts: r.points + adj.pts,
        projectedGD: r.goalDifference + adj.gd,
        liveMatch: m,
        projectedPosition: 0,
      };
    });
    return augmented;
  }, [rows, liveMatches, liveByTeam]);

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

      {/* Tab strip — always shown since Matches and Scorers are always available */}
      <div className="flex gap-1 mb-4 border-b border-slate-800">
        <button
          onClick={() => setCompView("standings")}
          className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
            compView === "standings"
              ? "border-green-500 text-white"
              : "border-transparent text-slate-500 hover:text-slate-300"
          }`}
        >
          {isMultiGroup ? "Groups" : "Standings"}
        </button>
        {hasKnockout && (
          <button
            onClick={() => setCompView("bracket")}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              compView === "bracket"
                ? "border-green-500 text-white"
                : "border-transparent text-slate-500 hover:text-slate-300"
            }`}
          >
            Bracket
          </button>
        )}
        <button
          onClick={() => setCompView("fixtures")}
          className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
            compView === "fixtures"
              ? "border-green-500 text-white"
              : "border-transparent text-slate-500 hover:text-slate-300"
          }`}
        >
          Matches
        </button>
        {!hasKnockout && (
          <button
            onClick={() => setCompView("scorers")}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              compView === "scorers"
                ? "border-green-500 text-white"
                : "border-transparent text-slate-500 hover:text-slate-300"
            }`}
          >
            Scorers
          </button>
        )}
      </div>

      {/* Bracket view */}
      {compView === "bracket" && (
        <BracketView compCode={comp.code} season={selectedSeason} />
      )}

      {/* Fixtures view */}
      {compView === "fixtures" && (
        <FixturesView comp={comp} selectedSeason={selectedSeason} onSelectTeam={onSelectTeam} />
      )}

      {/* Scorers view — only for domestic/non-knockout competitions; sidebar covers this for tournaments */}
      {compView === "scorers" && !hasKnockout && (
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
          <StatLeaders compCode={comp.code} season={selectedSeason} onSelectTeam={onSelectTeam} />
        </div>
      )}

      {/* Standings table */}
      {compView === "standings" && <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden">
        {/* Column headers */}
        <div className="grid items-center gap-x-4 px-5 py-3 border-b border-slate-800 text-[11px] text-slate-500 uppercase tracking-wider font-medium"
          style={{ gridTemplateColumns: "2rem 1fr 2.5rem 2.5rem 2.5rem 2.5rem 2.5rem 2.5rem 3rem 3rem 5.5rem 1.25rem" }}
        >
          <span className="text-right">#</span>
          <span className="pl-2 flex items-center gap-2">
            Club
            {hasLiveInGroup && (
              <span className="flex items-center gap-1 text-green-400 normal-case tracking-normal font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                Live
              </span>
            )}
          </span>
          <span className="text-center">P</span>
          <span className="text-center">W</span>
          <span className="text-center">D</span>
          <span className="text-center">L</span>
          <span className="text-center">GF</span>
          <span className="text-center">GA</span>
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

        {!loading && standingsError && (
          <div className="flex flex-col items-center py-14 gap-2">
            <p className="text-sm text-red-400">
              {standingsError.includes("403")
                ? "This competition requires a paid API tier."
                : standingsError.includes("429")
                ? "Rate limit hit — try again in a moment."
                : "Failed to load standings."}
            </p>
            <button
              onClick={retryStandings}
              className="text-xs text-slate-400 hover:text-white underline transition-colors"
            >
              Try again
            </button>
          </div>
        )}

        {!loading && !standingsError && rows.length === 0 && (
          <p className="text-sm text-slate-500 text-center py-14">
            No standings available for this competition.
          </p>
        )}

        {/* Rows */}
        {projectedRows.map((row, i) => {
          const zone = isIntlMultiGroup ? null : getZone(comp.code, row.position, rows.length);
          const intlBarColor = isIntlMultiGroup
            ? row.position <= 2 ? "bg-green-500"
            : row.position === 3 ? "bg-amber-500"
            : "bg-red-500"
            : null;
          const isLive = row.liveMatch !== null;
          const oppName = isLive
            ? (row.liveMatch!.homeTeamId === row.team.id
                ? row.liveMatch!.awayTeam
                : row.liveMatch!.homeTeam)
            : "";
          const teamScore = isLive
            ? (row.liveMatch!.homeTeamId === row.team.id
                ? row.liveMatch!.scoreHome
                : row.liveMatch!.scoreAway)
            : null;
          const oppScore = isLive
            ? (row.liveMatch!.homeTeamId === row.team.id
                ? row.liveMatch!.scoreAway
                : row.liveMatch!.scoreHome)
            : null;

          return (
          <div
            key={row.team.id}
            onMouseEnter={() => prefetchTeam(row.team.id)}
            className={`relative w-full grid items-center gap-x-4 px-5 py-3 transition-colors border-b border-slate-800/40 last:border-0 hover:bg-green-900/10 group ${
              isLive ? "bg-green-950/20" : i % 2 === 1 ? "bg-slate-900/30" : ""
            }`}
            style={{ gridTemplateColumns: "2rem 1fr 2.5rem 2.5rem 2.5rem 2.5rem 2.5rem 2.5rem 3rem 3rem 5.5rem 1.25rem" }}
          >
            {/* Zone indicator bar */}
            {zone && (
              <span className={`absolute left-0 top-0 bottom-0 w-1 ${ZONE_DOT[zone]}`} />
            )}
            {intlBarColor && (
              <span className={`absolute left-0 top-0 bottom-0 w-1 ${intlBarColor}`} />
            )}

            {/* Position */}
            <span className="flex items-center justify-end text-sm text-slate-500 tabular-nums font-medium">
              {row.position}
            </span>

            {/* Club name + crest + optional live score chip */}
            <button
              onClick={() => onSelectTeam(row.team)}
              className="flex items-center gap-2 pl-2 min-w-0 text-left"
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
              {isLive && (
                <span className="flex items-center gap-1 shrink-0 ml-1 text-[10px] font-bold text-green-400 whitespace-nowrap">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  {teamScore ?? 0}–{oppScore ?? 0}
                  <span className="text-[9px] text-green-600 font-medium">
                    vs {oppName.slice(0, 3).toUpperCase()}
                  </span>
                </span>
              )}
            </button>

            {/* Stats */}
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
            <span onClick={() => onSelectTeam(row.team)} className="text-center text-sm text-slate-400 tabular-nums cursor-pointer">
              {row.goalsFor ?? "—"}
            </span>
            <span onClick={() => onSelectTeam(row.team)} className="text-center text-sm text-slate-400 tabular-nums cursor-pointer">
              {row.goalsAgainst ?? "—"}
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
            <span
              onClick={() => onSelectTeam(row.team)}
              className="text-center text-sm font-bold tabular-nums cursor-pointer text-white"
            >
              {row.points}
            </span>

            {/* Form pips */}
            <div onClick={() => onSelectTeam(row.team)} className="flex justify-center cursor-pointer">
              <FormPips form={row.form} />
            </div>

            {/* Favourite star */}
            <button
              onClick={() => toggleFavourite(row.team, comp.code)}
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
      {compView === "standings" && rows.length > 0 && (isIntlMultiGroup ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 px-1">
          <div className="flex items-center gap-1.5">
            <div className="w-0.5 h-3 rounded-full bg-green-500" />
            <span className="text-[10px] text-slate-500">Advancing (top 2)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-0.5 h-3 rounded-full bg-amber-500" />
            <span className="text-[10px] text-slate-500">May advance (best 3rd)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-0.5 h-3 rounded-full bg-red-500" />
            <span className="text-[10px] text-slate-500">Eliminated</span>
          </div>
        </div>
      ) : (() => {
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
      })())}

      {compView === "standings" && (
        <p className="text-[10px] text-slate-600 text-right mt-2 uppercase tracking-wider">
          Click a club to view their squad &amp; schedule
        </p>
      )}
    </div>
  );
}

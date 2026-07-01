import { useState, useMemo } from "react";
import { useApi } from "../hooks/useApi";
import { useLiveMatches } from "../contexts/LiveMatchesContext";
import type { ScheduleMatch, Competition, Team } from "../types";

interface Props {
  onNavigateToTeam: (team: Team, comp: Competition) => void;
  favouriteTeamIds?: number[];
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function monthRange(year: number, month: number) {
  // Extend one day past month end to catch UTC-midnight games that land in this
  // month in local time (e.g. Jul 1 01:00 UTC = Jun 30 19:00 in America/Denver).
  const nextDay = new Date(year, month + 1, 1);
  return {
    dateFrom: isoDate(year, month, 1),
    dateTo: `${nextDay.getFullYear()}-${pad(nextDay.getMonth() + 1)}-${pad(nextDay.getDate())}`,
  };
}

function fmtSelectedDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function fmtKickOff(utcDate: string): string {
  return new Date(utcDate).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TODAY = todayLocal();
const TODAY_YEAR = new Date().getFullYear();
const TODAY_MONTH = new Date().getMonth();

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAY_HEADERS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const LIVE_STATUSES = new Set(["IN_PLAY", "PAUSED", "HALF_TIME"]);

const COMP_ORDER = ["PL", "BL1", "PD", "SA", "FL1", "DED", "PPL", "CL", "EL", "EC", "WC"];

// ── Component ─────────────────────────────────────────────────────────────────

export default function FixtureCalendar({ onNavigateToTeam, favouriteTeamIds }: Props) {
  const [viewYear, setViewYear]   = useState(TODAY_YEAR);
  const [viewMonth, setViewMonth] = useState(TODAY_MONTH);
  const [selected, setSelected]   = useState(TODAY);
  const [myTeamsOnly, setMyTeamsOnly] = useState(false);

  const hasFavourites = (favouriteTeamIds?.length ?? 0) > 0;

  const { dateFrom, dateTo } = monthRange(viewYear, viewMonth);

  const { data: monthFixtures, loading } = useApi<ScheduleMatch[]>(
    `/api/fixtures?dateFrom=${dateFrom}&dateTo=${dateTo}`
  );

  // Live overlay — comes from the app-level LiveMatchesContext (one poll for the whole app)
  const { liveById } = useLiveMatches();

  // Optionally filter to only matches involving favourited teams
  const filteredFixtures = useMemo(() => {
    const fixtures = monthFixtures ?? [];
    if (!myTeamsOnly || !favouriteTeamIds?.length) return fixtures;
    return fixtures.filter(
      (m) => favouriteTeamIds.includes(m.homeTeamId) || favouriteTeamIds.includes(m.awayTeamId)
    );
  }, [monthFixtures, myTeamsOnly, favouriteTeamIds]);

  // Date → matches map — live overlay applied so scores/status are always fresh
  const byDate = useMemo(() => {
    const map = new Map<string, ScheduleMatch[]>();
    for (const raw of filteredFixtures) {
      const live = liveById.get(raw.id);
      const m = live
        ? { ...raw, status: live.status, scoreHome: live.scoreHome, scoreAway: live.scoreAway }
        : raw;
      const d = new Date(m.utcDate);
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return map;
  }, [filteredFixtures, liveById]);

  const datesWithFixtures = useMemo(() => new Set(byDate.keys()), [byDate]);

  // Calendar grid — Monday-first
  const daysInMonth  = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun
  const offset       = (firstWeekday + 6) % 7; // Mon = 0, Sun = 6

  const cells: (number | null)[] = [
    ...Array<null>(offset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  // Month navigation
  function prevMonth() {
    const nm = viewMonth === 0 ? 11 : viewMonth - 1;
    const ny = viewMonth === 0 ? viewYear - 1 : viewYear;
    setViewMonth(nm);
    setViewYear(ny);
    setSelected(ny === TODAY_YEAR && nm === TODAY_MONTH ? TODAY : isoDate(ny, nm, 1));
  }

  function nextMonth() {
    const nm = viewMonth === 11 ? 0 : viewMonth + 1;
    const ny = viewMonth === 11 ? viewYear + 1 : viewYear;
    setViewMonth(nm);
    setViewYear(ny);
    setSelected(ny === TODAY_YEAR && nm === TODAY_MONTH ? TODAY : isoDate(ny, nm, 1));
  }

  // Selected day competitions
  const dayMatches = byDate.get(selected) ?? [];
  const byComp = useMemo(() => {
    const map = new Map<string, ScheduleMatch[]>();
    for (const m of dayMatches) {
      if (!map.has(m.competitionCode)) map.set(m.competitionCode, []);
      map.get(m.competitionCode)!.push(m);
    }
    return new Map(
      [...map.entries()].sort(([a], [b]) => {
        const ia = COMP_ORDER.indexOf(a), ib = COMP_ORDER.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        return ia !== -1 ? -1 : ib !== -1 ? 1 : a.localeCompare(b);
      })
    );
  }, [selected, byDate]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleTeam(m: ScheduleMatch, side: "home" | "away") {
    const comp: Competition = {
      id: 0,
      name: m.competition,
      code: m.competitionCode,
      emblem: m.competitionEmblem,
    };
    const name  = side === "home" ? m.homeTeam  : m.awayTeam;
    const id    = side === "home" ? m.homeTeamId : m.awayTeamId;
    const crest = side === "home" ? m.homeTeamCrest : m.awayTeamCrest;
    onNavigateToTeam({ id, name, shortName: name, crest, tla: name.slice(0, 3).toUpperCase() }, comp);
  }

  return (
    <div className="w-full space-y-4">
      {/* ── Calendar card ──────────────────────────────────────────────────── */}
      <div className="bg-slate-900 rounded-xl p-5">
        {/* Month header */}
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={prevMonth}
            className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-white hover:bg-slate-800 transition-colors text-lg leading-none"
          >
            ‹
          </button>
          <div className="flex items-center gap-2">
            <span className="text-white font-semibold text-sm tracking-wide">
              {MONTH_NAMES[viewMonth]} {viewYear}
            </span>
            {(viewYear !== TODAY_YEAR || viewMonth !== TODAY_MONTH) && (
              <button
                onClick={() => { setViewYear(TODAY_YEAR); setViewMonth(TODAY_MONTH); setSelected(TODAY); }}
                className="text-[10px] text-green-400 hover:text-green-300 font-medium px-1.5 py-0.5 rounded border border-green-600/40 hover:border-green-500/60 transition-colors"
              >
                Today
              </button>
            )}
          </div>
          <button
            onClick={nextMonth}
            className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-white hover:bg-slate-800 transition-colors text-lg leading-none"
          >
            ›
          </button>
        </div>

        {/* My Teams filter toggle */}
        {hasFavourites && (
          <div className="flex justify-center mb-3">
            <button
              onClick={() => setMyTeamsOnly((v) => !v)}
              className={`text-[10px] font-medium px-3 py-1 rounded-full border transition-colors ${
                myTeamsOnly
                  ? "bg-yellow-500/15 border-yellow-500/40 text-yellow-400"
                  : "border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-600"
              }`}
            >
              ★ My Teams
            </button>
          </div>
        )}

        {/* Weekday headers */}
        <div className="grid grid-cols-7 mb-1">
          {DAY_HEADERS.map((h) => (
            <div key={h} className="text-center text-[11px] font-medium text-slate-600 py-1">
              {h}
            </div>
          ))}
        </div>

        {/* Days grid */}
        <div className="grid grid-cols-7 gap-y-1">
          {cells.map((day, i) => {
            if (day === null) return <div key={`e${i}`} />;
            const dateStr    = isoDate(viewYear, viewMonth, day);
            const isToday    = dateStr === TODAY;
            const isSel      = dateStr === selected;
            const hasFixture = datesWithFixtures.has(dateStr);

            return (
              <button
                key={dateStr}
                onClick={() => setSelected(dateStr)}
                className={`
                  relative mx-auto flex flex-col items-center justify-center
                  w-9 h-9 rounded-full text-sm font-medium transition-all
                  ${isSel
                    ? "bg-green-600 text-white"
                    : isToday
                    ? "ring-2 ring-green-500 text-green-400 hover:bg-slate-800"
                    : "text-slate-300 hover:bg-slate-800"
                  }
                `}
              >
                {day}
                {hasFixture && (
                  <span
                    className={`absolute bottom-[3px] w-1 h-1 rounded-full ${
                      isSel ? "bg-white/70" : "bg-green-500"
                    }`}
                  />
                )}
              </button>
            );
          })}
        </div>

        {loading && (
          <div className="flex justify-center pt-4">
            <div className="w-4 h-4 border-2 border-slate-700 border-t-slate-400 rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* ── Fixtures for selected day ───────────────────────────────────────── */}
      <div>
        <p className="text-xs text-slate-500 font-medium mb-3 px-1">
          {fmtSelectedDate(selected)}
        </p>

        {!loading && byComp.size === 0 && (
          <div className="text-center text-slate-600 py-10">
            <p className="text-sm">
              {myTeamsOnly ? "No fixtures for your teams on this date" : "No fixtures on this date"}
            </p>
          </div>
        )}

        {!loading &&
          [...byComp.entries()].map(([code, matches]) => {
            const first = matches[0];
            return (
              <div key={code} className="mb-4">
                {/* Competition label */}
                <div className="flex items-center gap-2 mb-1.5 px-1">
                  {first.competitionEmblem && (
                    <img
                      src={first.competitionEmblem}
                      alt=""
                      className="w-4 h-4 object-contain"
                      onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                    />
                  )}
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
                    {first.competition}
                  </span>
                </div>

                {/* Match rows */}
                <div className="bg-slate-900 rounded-lg overflow-hidden divide-y divide-slate-800/80">
                  {matches.map((m) => {
                    const isLive    = LIVE_STATUSES.has(m.status);
                    const isFin     = m.status === "FINISHED";
                    const scoreHome = m.scoreHome;
                    const scoreAway = m.scoreAway;
                    const hasScore  = scoreHome !== null && scoreAway !== null;
                    const homeWon   = m.winner === "HOME_TEAM";
                    const awayWon   = m.winner === "AWAY_TEAM";
                    const isPen     = m.duration === "PENALTY_SHOOTOUT";
                    const isAET     = m.duration === "EXTRA_TIME" || isPen;
                    // etScoreHome is cumulative AET score; scoreHome is pen result for PK games
                    const displayHome = isAET && m.etScoreHome !== null ? m.etScoreHome : scoreHome;
                    const displayAway = isAET && m.etScoreAway !== null ? m.etScoreAway : scoreAway;

                    return (
                      <div key={m.id}>
                        <div className="flex items-center px-3 py-2.5 hover:bg-slate-800/50 transition-colors">
                          {/* Status */}
                          <div className="w-14 shrink-0 text-center">
                            {isLive ? (
                              <span className="flex items-center justify-center gap-1 text-[11px] font-bold text-green-400">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                                LIVE
                              </span>
                            ) : isFin ? (
                              <span className="text-[11px] text-slate-500">FT</span>
                            ) : (
                              <span className="text-[11px] text-slate-400">{fmtKickOff(m.utcDate)}</span>
                            )}
                          </div>

                          {/* Home */}
                          {m.homeTeam ? (
                            <button
                              onClick={() => handleTeam(m, "home")}
                              title={`View ${m.homeTeam}`}
                              className="flex items-center gap-2 flex-1 justify-end min-w-0 group"
                            >
                              <span
                                className={`text-sm truncate transition-colors ${
                                  homeWon ? "text-white font-semibold" : "text-slate-300 group-hover:text-green-400"
                                }`}
                              >
                                {m.homeTeam}
                              </span>
                              {m.homeTeamCrest ? (
                                <img
                                  src={m.homeTeamCrest}
                                  alt=""
                                  className="w-5 h-5 object-contain shrink-0"
                                  onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                                />
                              ) : (
                                <span className="w-5 h-5 shrink-0 rounded-full bg-slate-700 text-[8px] flex items-center justify-center text-slate-500">?</span>
                              )}
                            </button>
                          ) : (
                            <div className="flex items-center gap-2 flex-1 justify-end min-w-0">
                              <span className="text-sm text-slate-600 italic">TBD</span>
                              <span className="w-5 h-5 shrink-0" />
                            </div>
                          )}

                          {/* Score */}
                          <div className="w-14 shrink-0 text-center mx-1">
                            {hasScore ? (
                              <div className="flex flex-col items-center leading-tight">
                                <span className={`text-sm font-bold tabular-nums ${isLive ? "text-green-400" : "text-white"}`}>
                                  {displayHome} – {displayAway}
                                </span>
                                {isAET && <span className="text-[9px] text-slate-500">AET</span>}
                                {isPen && <span className="text-[9px] text-slate-400">{scoreHome}–{scoreAway} pens</span>}
                              </div>
                            ) : (
                              <span className="text-xs text-slate-600">vs</span>
                            )}
                          </div>

                          {/* Away */}
                          {m.awayTeam ? (
                            <button
                              onClick={() => handleTeam(m, "away")}
                              title={`View ${m.awayTeam}`}
                              className="flex items-center gap-2 flex-1 min-w-0 group"
                            >
                              {m.awayTeamCrest ? (
                                <img
                                  src={m.awayTeamCrest}
                                  alt=""
                                  className="w-5 h-5 object-contain shrink-0"
                                  onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                                />
                              ) : (
                                <span className="w-5 h-5 shrink-0 rounded-full bg-slate-700 text-[8px] flex items-center justify-center text-slate-500">?</span>
                              )}
                              <span
                                className={`text-sm truncate transition-colors ${
                                  awayWon ? "text-white font-semibold" : "text-slate-300 group-hover:text-green-400"
                                }`}
                              >
                                {m.awayTeam}
                              </span>
                            </button>
                          ) : (
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <span className="w-5 h-5 shrink-0" />
                              <span className="text-sm text-slate-600 italic">TBD</span>
                            </div>
                          )}
                        </div>

                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

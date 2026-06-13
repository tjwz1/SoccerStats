import { useState, useMemo, useRef, useEffect } from "react";
import { useApi } from "../hooks/useApi";
import { useLiveMatches } from "../contexts/LiveMatchesContext";
import type { ScheduleMatch, Competition, Team, MatchDetailData, MatchTeamStats } from "../types";

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
  const last = new Date(year, month + 1, 0).getDate();
  return { dateFrom: isoDate(year, month, 1), dateTo: isoDate(year, month, last) };
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

// ── Inline match detail (shown when score is clicked) ─────────────────────────

function StatMiniBar({ home, away, label }: { home: number | null; away: number | null; label: string }) {
  if (home === null && away === null) return null;
  const h = home ?? 0, a = away ?? 0;
  const total = h + a;
  const homePct = total > 0 ? (h / total) * 100 : 50;
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[10px] tabular-nums">
        <span className="text-slate-300 font-semibold">{typeof home === "number" && home % 1 !== 0 ? `${home.toFixed(1)}%` : (home ?? 0)}</span>
        <span className="text-slate-600 text-[9px] uppercase tracking-wider">{label}</span>
        <span className="text-slate-300 font-semibold">{typeof away === "number" && away % 1 !== 0 ? `${away.toFixed(1)}%` : (away ?? 0)}</span>
      </div>
      <div className="flex h-1 rounded-full overflow-hidden gap-px">
        <div className="bg-green-500/60 rounded-l-full" style={{ width: `${homePct}%` }} />
        <div className="bg-slate-500/40 rounded-r-full" style={{ width: `${100 - homePct}%` }} />
      </div>
    </div>
  );
}

function CalendarMatchDetail({ match, onScoreChange }: { match: ScheduleMatch; onScoreChange?: (home: number, away: number) => void }) {
  const isLive = LIVE_STATUSES.has(match.status);
  const hasStats = match.status === "FINISHED" || isLive;

  const enc = `homeTeam=${encodeURIComponent(match.homeTeam)}&awayTeam=${encodeURIComponent(match.awayTeam)}&utcDate=${encodeURIComponent(match.utcDate)}&competition=${encodeURIComponent(match.competitionCode)}`;

  const { data: detail, loading: detailLoading, retry: retryDetail } = useApi<MatchDetailData>(
    hasStats ? `/api/matches/${match.id}?status=${encodeURIComponent(match.status)}&${enc}` : null
  );
  const { data: teamStats, loading: statsLoading, retry: retryStats } = useApi<MatchTeamStats>(
    hasStats ? `/api/matches/${match.id}/team-stats?${enc}` : null
  );

  const retryDetailRef = useRef(retryDetail);
  const retryStatsRef  = useRef(retryStats);
  useEffect(() => { retryDetailRef.current = retryDetail; }, [retryDetail]);
  useEffect(() => { retryStatsRef.current  = retryStats;  }, [retryStats]);
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => { retryDetailRef.current(); retryStatsRef.current(); }, 30_000);
    return () => clearInterval(id);
  }, [isLive]);

  // Bubble the authoritative FT score up to the calendar row whenever detail arrives
  useEffect(() => {
    if (detail?.ftHome !== null && detail?.ftHome !== undefined &&
        detail?.ftAway !== null && detail?.ftAway !== undefined) {
      onScoreChange?.(detail.ftHome, detail.ftAway);
    }
  }, [detail?.ftHome, detail?.ftAway]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasStats) {
    return (
      <div className="px-4 py-2.5 text-[11px] text-slate-500 text-center border-t border-slate-800/60 bg-slate-900/40">
        Timeline available after kickoff.
      </div>
    );
  }

  const isLoading = detailLoading || statsLoading;
  if (isLoading && !detail && !teamStats) {
    return (
      <div className="flex justify-center py-4 border-t border-slate-800/60 bg-slate-900/40">
        <div className="w-4 h-4 border-2 border-slate-700 border-t-slate-400 rounded-full animate-spin" />
      </div>
    );
  }

  const goals = detail?.goals ?? [];
  type EventItem =
    | { kind: "goal"; team: "home" | "away"; min: number; label: string; sub: string | null; icon: string }
    | { kind: "card"; team: "home" | "away"; min: number; label: string; sub: null; icon: string }
    | { kind: "sub";  team: "home" | "away"; min: number; label: string; sub: string; icon: string };

  const events: EventItem[] = [
    ...goals.map((g) => ({
      kind: "goal" as const, team: g.team, min: g.minute + (g.extraTime ?? 0),
      label: g.scorer.split(" ").pop() ?? g.scorer,
      sub: g.assist ? g.assist.split(" ").pop() ?? null : null,
      icon: g.type === "OWN_GOAL" ? "🔴" : g.type === "PENALTY" ? "⚽p" : "⚽",
    })),
    ...(detail?.bookings ?? []).map((b) => ({
      kind: "card" as const, team: b.team, min: b.minute + (b.extraTime ?? 0),
      label: b.player.split(" ").pop() ?? b.player, sub: null,
      icon: b.card === "RED" ? "🟥" : b.card === "YELLOW_RED" ? "🟨🟥" : "🟨",
    })),
    ...(detail?.substitutions ?? []).map((s) => ({
      kind: "sub" as const, team: s.team, min: s.minute + (s.extraTime ?? 0),
      label: s.playerIn.split(" ").pop() ?? s.playerIn,
      sub: s.playerOut.split(" ").pop() ?? s.playerOut,
      icon: "🔄",
    })),
  ].sort((a, b) => a.min - b.min);

  const hasEvents  = events.length > 0;
  const hasTeamSt  = teamStats && (teamStats.home.possession !== null || teamStats.home.shots !== null);

  if (!hasEvents && !hasTeamSt) {
    return (
      <div className="px-4 py-2.5 text-[11px] text-slate-500 text-center border-t border-slate-800/60 bg-slate-900/40">
        No events recorded yet.
      </div>
    );
  }

  return (
    <div className="border-t border-slate-800/60 bg-slate-900/50 px-4 py-3 space-y-3">
      {/* HT score */}
      {detail?.htHome !== null && detail?.htAway !== null && (
        <p className="text-center text-[10px] text-slate-500">
          HT <span className="text-slate-300 font-semibold">{detail.htHome}–{detail.htAway}</span>
        </p>
      )}

      {/* Column headers */}
      {hasEvents && (
        <div className="flex text-[9px] text-slate-600 uppercase tracking-wider font-semibold px-1">
          <span className="flex-1 text-green-600/60">{match.homeTeam.split(" ").slice(-1)[0]}</span>
          <span className="w-10 text-center shrink-0" />
          <span className="flex-1 text-right text-blue-400/60">{match.awayTeam.split(" ").slice(-1)[0]}</span>
        </div>
      )}

      {/* Events */}
      {hasEvents && (
        <div className="space-y-1">
          {events.map((e, i) => {
            const minStr = `${Math.floor(e.min)}'`;
            const isHome = e.team === "home";
            return (
              <div key={i} className="flex items-start gap-1 text-[11px]">
                <div className={`flex-1 min-w-0 ${isHome ? "" : "opacity-0 pointer-events-none"}`}>
                  {isHome && (
                    <div className="text-right">
                      <span className="text-slate-200">{e.label} {e.icon}</span>
                      {e.sub && e.kind !== "sub" && <div className="text-[9px] text-slate-500">{e.sub}</div>}
                      {e.kind === "sub" && <div className="text-[9px] text-slate-500">↓ {e.sub}</div>}
                    </div>
                  )}
                </div>
                <div className="w-10 shrink-0 text-center text-[10px] font-mono text-slate-600">{minStr}</div>
                <div className={`flex-1 min-w-0 ${!isHome ? "" : "opacity-0 pointer-events-none"}`}>
                  {!isHome && (
                    <div>
                      <span className="text-slate-200">{e.icon} {e.label}</span>
                      {e.sub && e.kind !== "sub" && <div className="text-[9px] text-slate-500">{e.sub}</div>}
                      {e.kind === "sub" && <div className="text-[9px] text-slate-500">↓ {e.sub}</div>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Team stats */}
      {hasTeamSt && teamStats && (
        <div className="border-t border-slate-800/40 pt-2 space-y-1.5">
          <StatMiniBar label="Possession" home={teamStats.home.possession} away={teamStats.away.possession} />
          <StatMiniBar label="Shots" home={teamStats.home.shots} away={teamStats.away.shots} />
          <StatMiniBar label="On Target" home={teamStats.home.shotsOnTarget} away={teamStats.away.shotsOnTarget} />
          <StatMiniBar label="Corners" home={teamStats.home.corners} away={teamStats.away.corners} />
        </div>
      )}
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function FixtureCalendar({ onNavigateToTeam, favouriteTeamIds }: Props) {
  const [viewYear, setViewYear]   = useState(TODAY_YEAR);
  const [viewMonth, setViewMonth] = useState(TODAY_MONTH);
  const [selected, setSelected]   = useState(TODAY);
  const [myTeamsOnly, setMyTeamsOnly] = useState(false);
  const [expandedMatchId, setExpandedMatchId] = useState<number | null>(null);
  // Authoritative FT scores reported back by the expanded detail panel (live polls /matches/:id)
  const [liveScoreOverrides, setLiveScoreOverrides] = useState<Map<number, { home: number; away: number }>>(new Map());

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
          <span className="text-white font-semibold text-sm tracking-wide">
            {MONTH_NAMES[viewMonth]} {viewYear}
          </span>
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
                    const override  = isLive ? liveScoreOverrides.get(m.id) : undefined;
                    const scoreHome = override !== undefined ? override.home : m.scoreHome;
                    const scoreAway = override !== undefined ? override.away : m.scoreAway;
                    const hasScore  = scoreHome !== null && scoreAway !== null;
                    const homeWon   = m.winner === "HOME_TEAM";
                    const awayWon   = m.winner === "AWAY_TEAM";
                    const canExpand = hasScore || isLive;
                    const isExpanded = expandedMatchId === m.id;

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

                          {/* Score — clicking expands match detail */}
                          <div className="w-14 shrink-0 text-center mx-1">
                            {hasScore ? (
                              <button
                                onClick={() => setExpandedMatchId(isExpanded ? null : m.id)}
                                className="w-full rounded px-1 py-0.5 hover:bg-slate-700/50 transition-colors group/score"
                                title={isExpanded ? "Hide details" : "View goals & stats"}
                              >
                                <span className={`text-sm font-bold tabular-nums transition-colors ${isExpanded ? "text-green-400" : "text-white group-hover/score:text-green-300"}`}>
                                  {scoreHome} – {scoreAway}
                                </span>
                                <div className={`text-[8px] text-slate-600 leading-none transition-transform ${isExpanded ? "rotate-180" : ""}`}>▾</div>
                              </button>
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

                        {/* Inline match detail — shown when score is clicked */}
                        {isExpanded && canExpand && (
                          <CalendarMatchDetail
                            match={m}
                            onScoreChange={(home, away) =>
                              setLiveScoreOverrides((prev) => {
                                const next = new Map(prev);
                                next.set(m.id, { home, away });
                                return next;
                              })
                            }
                          />
                        )}
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

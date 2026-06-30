import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { ScheduleMatch, LineupData, Player, MatchDetailData, MatchGoalEvent, MatchBookingEvent, MatchSubstitutionEvent, PlayerGameStats, MatchLineups, MatchLineupPlayer, MatchTeamStats } from "../types";
import { useApi } from "../hooks/useApi";
import Pitch from "./Pitch";
import Bench from "./Bench";

// ── Name normalisation helpers ────────────────────────────────────────────────

// Strip diacritics, dots, hyphens (treated as spaces), then return all
// meaningful tokens (>2 chars). Used so "Alexander-Arnold" / "Alexander Arnold",
// "Félix" / "Felix", "Vini Jr" / "Vinicius Junior" all share at least one token.
function subNameTokens(name: string): string[] {
  return name
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/-/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

// ── 2-legged tie detection ────────────────────────────────────────────────────

const TWO_LEGGED_COMP_CODES = new Set(["CL", "EL", "ECL", "esp.copa_del_rey"]);

interface TieInfo {
  aggOurs: number;
  aggTheirs: number;
  /** true = our team progressed, false = eliminated, null = undecided (upcoming leg 2) */
  won: boolean | null;
  legNumber: 1 | 2;
}

function normForTie(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bfc\b|\bf\.c\.\b|\bafc\b|\bsc\b|\bcf\b|\bcd\b|\bud\b/g, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getOurSide(
  match: ScheduleMatch,
  teamId: number,
  teamName: string
): "home" | "away" | null {
  if (match.homeTeamId === teamId) return "home";
  if (match.awayTeamId === teamId) return "away";
  const n = normForTie(teamName);
  const h = normForTie(match.homeTeam);
  const a = normForTie(match.awayTeam);
  if (h.includes(n) || n.includes(h)) return "home";
  if (a.includes(n) || n.includes(a)) return "away";
  return null;
}

function computeTieInfos(
  matches: ScheduleMatch[],
  teamId: number,
  teamName: string
): Map<number, TieInfo> {
  const result = new Map<number, TieInfo>();

  const relevant = matches.filter((m) => TWO_LEGGED_COMP_CODES.has(m.competitionCode));

  // Group by competition + opponent (normalized)
  const groups = new Map<
    string,
    { match: ScheduleMatch; side: "home" | "away" }[]
  >();
  for (const m of relevant) {
    const side = getOurSide(m, teamId, teamName);
    if (!side) continue;
    const opp = normForTie(side === "home" ? m.awayTeam : m.homeTeam);
    const key = `${m.competitionCode}:${opp}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ match: m, side });
  }

  for (const [, entries] of groups) {
    if (entries.length < 2) continue;

    // Sort oldest-first
    entries.sort(
      (a, b) => +new Date(a.match.utcDate) - +new Date(b.match.utcDate)
    );

    // Identify adjacent pairs (home/away swapped, within 45 days)
    for (let i = 0; i < entries.length - 1; i++) {
      const e1 = entries[i];
      const e2 = entries[i + 1];
      const daysDiff =
        (+new Date(e2.match.utcDate) - +new Date(e1.match.utcDate)) / 86_400_000;
      if (daysDiff > 45) continue;
      if (e1.side === e2.side) continue; // same side = group-stage pair, skip

      const getGoals = (e: { match: ScheduleMatch; side: "home" | "away" }) => {
        const { scoreHome: sh, scoreAway: sa, etScoreHome: eth, etScoreAway: eta } = e.match;
        if (sh === null || sa === null) return null;
        // score.extraTime is cumulative (total score at 120 min), so use it directly.
        const home = eth !== null ? eth : sh;
        const away = eta !== null ? eta : sa;
        return {
          ours: e.side === "home" ? home : away,
          theirs: e.side === "home" ? away : home,
        };
      };

      const g1 = e1.match.status === "FINISHED" ? getGoals(e1) : null;
      const g2 = e2.match.status === "FINISHED" ? getGoals(e2) : null;

      if (g1 && g2) {
        const aggOurs = g1.ours + g2.ours;
        const aggTheirs = g1.theirs + g2.theirs;

        let won: boolean | null;
        if (aggOurs > aggTheirs) {
          won = true;
        } else if (aggOurs < aggTheirs) {
          won = false;
        } else {
          // Tied on agg — leg 2 winner decides (ET/pens)
          const { winner, duration, penScoreHome: ph, penScoreAway: pa } = e2.match;
          if (winner === "HOME_TEAM") won = e2.side === "home";
          else if (winner === "AWAY_TEAM") won = e2.side === "away";
          else if (duration === "PENALTY_SHOOTOUT" && ph !== null && pa !== null && ph !== pa) {
            // winner field missing — infer from valid penalty score
            won = ph > pa ? e2.side === "home" : e2.side === "away";
          } else {
            won = null;
          }
        }
        result.set(e1.match.id, { aggOurs, aggTheirs, won, legNumber: 1 });
        result.set(e2.match.id, { aggOurs, aggTheirs, won, legNumber: 2 });
      } else if (g1) {
        // Leg 1 done, leg 2 upcoming — show partial agg for context
        result.set(e1.match.id, { aggOurs: g1.ours, aggTheirs: g1.theirs, won: null, legNumber: 1 });
        result.set(e2.match.id, { aggOurs: g1.ours, aggTheirs: g1.theirs, won: null, legNumber: 2 });
      }

      i++; // skip the paired entry
    }
  }

  return result;
}

// Convert actual match lineup players → Player objects usable by Pitch/Bench
function toPlayer(p: MatchLineupPlayer): Player {
  return {
    id: p.id,
    name: p.name,
    position: (p.position as Player["position"]) || "Midfielder",
    role: (p.role as Player["role"]) || undefined,
    nationality: "",
    dateOfBirth: "",
    shirtNumber: p.shirtNumber,
    photo: p.photo,
  };
}

interface Props {
  matches: ScheduleMatch[];
  loading: boolean;
  error: string | null;
  teamId: number;
  teamName: string;
  onRetry?: () => void;
  upcomingLoading?: boolean;
}

type Result = "W" | "D" | "L";

const RESULT_STYLE: Record<Result, string> = {
  W: "bg-green-600/20 text-green-400 border-green-600/30",
  D: "bg-slate-700/50 text-slate-300 border-slate-600/30",
  L: "bg-red-600/20 text-red-400 border-red-600/30",
};
const RESULT_LABEL: Record<Result, string> = { W: "Win", D: "Draw", L: "Loss" };

function getResult(match: ScheduleMatch, teamId: number): Result | null {
  if (match.status !== "FINISHED") return null;
  if (match.winner) {
    if (match.winner === "DRAW") return "D";
    const isHome = match.homeTeamId === teamId;
    return (isHome ? match.winner === "HOME_TEAM" : match.winner === "AWAY_TEAM") ? "W" : "L";
  }
  if (match.scoreHome === null || match.scoreAway === null) return null;
  // For penalty matches with missing winner field, try penalty score then additive total
  if (match.duration === "PENALTY_SHOOTOUT") {
    const ph = match.penScoreHome, pa = match.penScoreAway;
    if (ph !== null && pa !== null && ph !== pa) {
      const isHome = match.homeTeamId === teamId;
      return (isHome ? ph > pa : pa > ph) ? "W" : "L";
    }
  }
  const isHome = match.homeTeamId === teamId;
  const forUs = isHome ? match.scoreHome : match.scoreAway;
  const against = isHome ? match.scoreAway : match.scoreHome;
  return forUs > against ? "W" : forUs < against ? "L" : "D";
}

function shortName(name: string): string {
  return name
    .replace(/\s+(FC|F\.C\.|CF|C\.F\.|AFC|A\.F\.C\.|SC|S\.C\.|SV|RCD|CD|UD|SD)$/i, "")
    .replace(/^(FC|F\.C\.|AFC|A\.F\.C\.)\s+/i, "")
    .replace(/\s+Football Club$/i, "")
    .trim();
}

function formatDate(utcDate: string): string {
  const d = new Date(utcDate);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const matchDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((matchDay.getTime() - today.getTime()) / 86_400_000);
  let dayStr: string;
  if (diff === 0) dayStr = "Today";
  else if (diff === 1) dayStr = "Tomorrow";
  else if (diff === -1) dayStr = "Yesterday";
  else dayStr = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${dayStr} · ${time}`;
}

function googleLink(match: ScheduleMatch): string {
  const home = shortName(match.homeTeam);
  const away = shortName(match.awayTeam);
  const isLive = match.status === "IN_PLAY" || match.status === "PAUSED";
  if (isLive) return `https://www.google.com/search?q=${encodeURIComponent(`${home} vs ${away} live score`)}`;
  const d = new Date(match.utcDate);
  const dateStr = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  return `https://www.google.com/search?q=${encodeURIComponent(`${home} vs ${away} ${match.competition} ${dateStr}`)}`;
}

// ── Match timeline panel ──────────────────────────────────────────────────────

type TlEvent =
  | { kind: "goal"; min: number; extra: number | null; team: "home" | "away"; data: MatchGoalEvent }
  | { kind: "card"; min: number; extra: number | null; team: "home" | "away"; data: MatchBookingEvent }
  | { kind: "sub";  min: number; extra: number | null; team: "home" | "away"; data: MatchSubstitutionEvent };

function tlMin(e: TlEvent) { return e.min + (e.extra ?? 0); }

function EventCell({ event, side }: { event: TlEvent; side: "home" | "away" }) {
  const align = side === "home" ? "text-right items-end" : "text-left items-start";
  if (event.kind === "goal") {
    const g = event.data;
    const isOG = g.type === "OWN_GOAL";
    const isPen = g.type === "PENALTY";
    const lastName = g.scorer.split(" ").pop() ?? g.scorer;
    return (
      <div className={`flex flex-col ${align} gap-0`}>
        <span className="text-[11px] font-semibold text-white leading-tight">
          {isOG ? "🔴" : "⚽"} {lastName}
          {isOG && <span className="text-slate-500 font-normal text-[9px]"> og</span>}
          {isPen && <span className="text-slate-500 font-normal text-[9px]"> p</span>}
        </span>
        {g.assist && !isOG && (
          <span className="text-[9px] text-slate-500 leading-tight">{g.assist.split(" ").pop()}</span>
        )}
      </div>
    );
  }
  if (event.kind === "card") {
    const b = event.data;
    const icon = b.card === "RED" ? "🟥" : b.card === "YELLOW_RED" ? "🟨🟥" : "🟨";
    const lastName = b.player.split(" ").pop() ?? b.player;
    return (
      <div className={`flex flex-col ${align}`}>
        <span className="text-[11px] leading-tight text-slate-200">
          {side === "away" ? `${icon} ` : ""}{lastName}{side === "home" ? ` ${icon}` : ""}
        </span>
      </div>
    );
  }
  // sub
  const s = event.data;
  const inLast  = s.playerIn.split(" ").pop()  ?? s.playerIn;
  const outLast = s.playerOut.split(" ").pop() ?? s.playerOut;
  return (
    <div className={`flex flex-col ${align} gap-0`}>
      <span className="text-[10px] text-green-400 leading-tight">↑ {inLast}</span>
      <span className="text-[10px] text-slate-500 leading-tight">↓ {outLast}</span>
    </div>
  );
}

function MatchTimelinePanel({
  match,
  viewingTeamId,
}: {
  match: ScheduleMatch;
  viewingTeamId: number;
}) {
  const isLive = match.status === "IN_PLAY" || match.status === "PAUSED";
  const hasStats = match.status === "FINISHED" || isLive;
  const detailUrl = hasStats
    ? `/api/matches/${match.id}?status=${encodeURIComponent(match.status)}&homeTeam=${encodeURIComponent(match.homeTeam)}&awayTeam=${encodeURIComponent(match.awayTeam)}&utcDate=${encodeURIComponent(match.utcDate)}&competition=${encodeURIComponent(match.competitionCode)}`
    : null;
  const { data: detail, loading, retry } = useApi<MatchDetailData>(detailUrl);

  // Keep a stable ref to retry so the interval effect doesn't restart on every render
  const retryRef = useRef(retry);
  useEffect(() => { retryRef.current = retry; }, [retry]);

  // Poll every 30 s while live so cards/subs/goals update without page reload
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => retryRef.current(), 30_000);
    return () => clearInterval(id);
  }, [isLive]);

  if (!hasStats) {
    return <p className="text-xs text-slate-500 text-center py-6">Timeline available after kickoff.</p>;
  }
  if (loading) {
    return (
      <div className="py-8 flex justify-center">
        <div className="w-5 h-5 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
      </div>
    );
  }

  const goals = detail?.goals ?? [];
  const bookings = detail?.bookings ?? [];
  const substitutions = detail?.substitutions ?? [];
  const hasAnyEvents = goals.length > 0 || bookings.length > 0 || substitutions.length > 0;

  if (!detail || !hasAnyEvents) {
    return <p className="text-xs text-slate-500 text-center py-6">No events recorded.</p>;
  }

  // Build chronological event list
  const events: TlEvent[] = [
    ...goals.map((g): TlEvent => ({ kind: "goal", min: g.minute, extra: g.extraTime, team: g.team, data: g })),
    ...bookings.map((b): TlEvent => ({ kind: "card", min: b.minute, extra: b.extraTime, team: b.team, data: b })),
    ...substitutions.map((s): TlEvent => ({ kind: "sub", min: s.minute, extra: s.extraTime, team: s.team, data: s })),
  ].sort((a, b) => tlMin(b) - tlMin(a));

  // SVG goal-only timeline
  const W = 280;
  const H = 100;
  const padX = 28;
  const lineY = H / 2;
  const barW = W - padX * 2;
  const maxMin = goals.length > 0 ? Math.max(...goals.map((g) => g.minute + (g.extraTime ?? 0))) : 90;
  const totalMin = Math.max(90, maxMin + 5);
  function xAt(min: number, extra?: number | null) {
    return padX + ((min + (extra ?? 0)) / totalMin) * barW;
  }
  const homeGoals = goals.filter((g) => g.team === "home");
  const awayGoals = goals.filter((g) => g.team === "away");
  const ourSide: "home" | "away" = match.homeTeamId === viewingTeamId ? "home" : "away";

  function renderGoalMarker(g: MatchGoalEvent, i: number, above: boolean) {
    const x = xAt(g.minute, g.extraTime);
    const isOurs = g.team === ourSide;
    const isOG = g.type === "OWN_GOAL";
    const color = isOG ? "#ef4444" : above ? "#22c55e" : "#60a5fa";
    const lineEnd = above ? lineY - 5 : lineY + 5;
    const dotY = above ? lineY - 22 : lineY + 22;
    const minLabelY = above ? dotY - 9 : dotY + 14;
    const scorerLabelY = above ? dotY - 19 : dotY + 24;
    const minuteStr = g.extraTime ? `${g.minute}+${g.extraTime}'` : `${g.minute}'`;
    const lastName = g.scorer.split(" ").pop() ?? g.scorer;
    return (
      <g key={`${g.team}-${i}`}>
        <line x1={x} y1={lineEnd} x2={x} y2={dotY} stroke={color} strokeWidth="1" opacity="0.4" />
        <circle cx={x} cy={dotY} r="4.5" fill={color} opacity={isOurs ? 0.9 : 0.45} />
        {isOG && <text x={x} y={dotY + 1.5} textAnchor="middle" fontSize="5" fill="#fff" fontWeight="bold">og</text>}
        {g.type === "PENALTY" && !isOG && <text x={x} y={dotY + 1.5} textAnchor="middle" fontSize="5" fill="#fff" fontWeight="bold">p</text>}
        <text x={x} y={minLabelY} textAnchor="middle" fontSize="6.5" fill={color} opacity={isOurs ? 0.9 : 0.5}>{minuteStr}</text>
        <text x={x} y={scorerLabelY} textAnchor="middle" fontSize="6" fill="#94a3b8" opacity={isOurs ? 0.9 : 0.5}>{lastName}</text>
      </g>
    );
  }

  return (
    <div className="px-4 py-4 space-y-4">
      {/* SVG goal timeline (only when goals exist) */}
      {goals.length > 0 && (
        <div>
          <div className="flex justify-between text-[9px] text-slate-500 uppercase tracking-wider mb-1 px-1">
            <span className="text-green-500/70">{shortName(match.homeTeam)}</span>
            <span className="text-blue-400/70 text-right">{shortName(match.awayTeam)}</span>
          </div>
          <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
            {[45, 90].filter((m) => m < totalMin).map((m) => (
              <g key={m}>
                <line x1={xAt(m)} y1={lineY - 5} x2={xAt(m)} y2={lineY + 5} stroke="#334155" strokeWidth="1" />
                <text x={xAt(m)} y={lineY + 14} textAnchor="middle" fontSize="7" fill="#475569">{m}'</text>
              </g>
            ))}
            <text x={padX} y={lineY + 14} textAnchor="middle" fontSize="7" fill="#334155">0'</text>
            <line x1={padX} y1={lineY} x2={W - padX} y2={lineY} stroke="#334155" strokeWidth="1.5" />
            {homeGoals.map((g, i) => renderGoalMarker(g, i, true))}
            {awayGoals.map((g, i) => renderGoalMarker(g, i, false))}
          </svg>
          {detail.htHome !== null && detail.htAway !== null && (
            <p className="text-center text-[10px] text-slate-500 mt-1">
              HT: <span className="text-slate-300 font-semibold">{detail.htHome}–{detail.htAway}</span>
            </p>
          )}
        </div>
      )}

      {/* Chronological event log */}
      <div className="border-t border-slate-700/50 pt-3">
        <div className="flex justify-between text-[9px] text-slate-500 uppercase tracking-wider mb-2 px-1">
          <span className="text-green-500/70">{shortName(match.homeTeam)}</span>
          <span className="text-[9px] text-slate-600 uppercase tracking-widest">Events</span>
          <span className="text-blue-400/70">{shortName(match.awayTeam)}</span>
        </div>
        <div className="space-y-1.5">
          {events.map((event, i) => {
            const minuteStr = event.extra ? `${event.min}+${event.extra}'` : `${event.min}'`;
            return (
              <div key={i} className="flex items-center gap-2">
                <div className="flex-1 flex justify-end">
                  {event.team === "home" && <EventCell event={event} side="home" />}
                </div>
                <div className="w-10 shrink-0 text-center text-[10px] font-mono text-slate-600">
                  {minuteStr}
                </div>
                <div className="flex-1 flex justify-start">
                  {event.team === "away" && <EventCell event={event} side="away" />}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center justify-center gap-4 pt-1">
        {[
          { icon: "⚽", label: "Goal" },
          { icon: "🟨", label: "Yellow" },
          { icon: "🟥", label: "Red" },
          { icon: "↑", label: "Sub", cls: "text-green-400 font-bold text-xs" },
        ].map(({ icon, label, cls }) => (
          <div key={label} className="flex items-center gap-1">
            <span className={cls ?? "text-[11px]"}>{icon}</span>
            <span className="text-[9px] text-slate-500">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Match stats section ───────────────────────────────────────────────────────

function MatchStatsSection({
  detail,
  match,
  viewingTeamId,
}: {
  detail: MatchDetailData;
  match: ScheduleMatch;
  viewingTeamId: number;
}) {
  const isHome = match.homeTeamId === viewingTeamId;
  // "our" goals are whichever side the viewing team is on
  const ourSide: "home" | "away" = isHome ? "home" : "away";

  const htAvailable = detail.htHome !== null && detail.htAway !== null;
  const hasGoals = detail.goals.length > 0;

  if (!htAvailable && !hasGoals) return null;

  return (
    <div className="px-4 pt-3 pb-2 border-b border-slate-700/60 space-y-2">
      {/* Half-time score */}
      {htAvailable && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider w-6">HT</span>
          <span className="text-xs font-bold text-white tabular-nums">
            {detail.htHome} – {detail.htAway}
          </span>
        </div>
      )}

      {/* Goal events */}
      {hasGoals && (
        <div className="space-y-1">
          {detail.goals.map((g, i) => {
            const isOurs = g.team === ourSide;
            const isOwnGoal = g.type === "OWN_GOAL";
            const minuteStr = g.extraTime ? `${g.minute}+${g.extraTime}'` : `${g.minute}'`;
            return (
              <div key={i} className={`flex items-start gap-2 text-xs ${isOurs ? "text-white" : "text-slate-500"}`}>
                <span className="text-[10px] font-mono text-slate-500 w-10 shrink-0 text-right">{minuteStr}</span>
                <span className="shrink-0">{isOwnGoal ? "🔴" : "⚽"}</span>
                <span className="leading-tight">
                  <span className={isOurs ? "font-semibold" : ""}>{g.scorer}</span>
                  {isOwnGoal && <span className="text-[10px] text-slate-500"> (og)</span>}
                  {g.type === "PENALTY" && <span className="text-[10px] text-slate-500"> (pen)</span>}
                  {g.assist && !isOwnGoal && (
                    <span className="text-[10px] text-slate-500"> · {g.assist}</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Per-player match stats tooltip ───────────────────────────────────────────

const POS_LABEL: Record<string, string> = {
  Goalkeeper: "GK", Defender: "DEF", Midfielder: "MID", Attacker: "FWD",
};

function normLast(name: string): string {
  return name.toLowerCase().replace(/\./g, "").trim().split(" ").pop() ?? "";
}

function MatchPlayerTooltip({
  player, x, y, playerStats, statsLoading,
}: {
  player: Player;
  x: number;
  y: number;
  playerStats: Record<string, PlayerGameStats> | null;
  statsLoading: boolean;
}) {
  const matchStats: PlayerGameStats | null = useMemo(() => {
    if (!playerStats) return null;
    const last = normLast(player.name);
    return playerStats[last] ?? null;
  }, [player.name, playerStats]);

  const role = POS_LABEL[player.position] ?? player.position;
  const left = Math.min(x + 14, window.innerWidth - 170);
  const top = Math.max(y - 60, 8);

  return (
    <div
      style={{ position: "fixed", left, top, zIndex: 9999, pointerEvents: "none" }}
      className="bg-slate-800 border border-slate-700 rounded-lg shadow-xl px-3 py-2 text-xs min-w-[140px]"
    >
      <p className="font-semibold text-white leading-tight truncate max-w-[150px]">{player.name}</p>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-slate-400 text-[10px]">{role}</p>
        {matchStats?.rating != null && (
          <span
            className={`text-[10px] font-bold ${
              matchStats.rating >= 7.5 ? "text-green-400" : matchStats.rating >= 6.5 ? "text-yellow-400" : "text-slate-400"
            }`}
          >
            ★{matchStats.rating.toFixed(1)}
          </span>
        )}
      </div>
      {statsLoading && !matchStats ? (
        <p className="text-slate-500 text-[10px] animate-pulse">Loading…</p>
      ) : matchStats ? (
        <div className="space-y-1">
          <div className="flex items-center gap-3 text-slate-200">
            <span className="text-slate-500 text-[10px]">{matchStats.starter ? "STR" : "SUB"}</span>
            <span>⚽ {matchStats.goals}</span>
            <span>🅰️ {matchStats.assists}</span>
            {matchStats.shots > 0 && <span className="text-slate-400 text-[10px]">{matchStats.shots} sh</span>}
          </div>
          {(matchStats.yellowCards > 0 || matchStats.redCards > 0) && (
            <div className="flex gap-1 text-[11px]">
              {matchStats.yellowCards > 0 && <span>🟨</span>}
              {matchStats.redCards > 0 && <span>🟥</span>}
            </div>
          )}
        </div>
      ) : (
        <p className="text-slate-500 text-[10px]">Click for career stats</p>
      )}
    </div>
  );
}

// ── Team match stats panel ────────────────────────────────────────────────────

function StatBar({
  label,
  home,
  away,
  isPercent,
}: {
  label: string;
  home: number | null;
  away: number | null;
  isPercent?: boolean;
}) {
  if (home === null && away === null) return null;
  const h = home ?? 0;
  const a = away ?? 0;
  const total = h + a;
  const homePct = total > 0 ? (h / total) * 100 : 50;
  const awayPct = 100 - homePct;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] text-slate-300 tabular-nums">
        <span className="font-semibold">{isPercent ? `${h.toFixed(1)}%` : h}</span>
        <span className="text-slate-500 uppercase tracking-wider text-[9px]">{label}</span>
        <span className="font-semibold">{isPercent ? `${a.toFixed(1)}%` : a}</span>
      </div>
      <div className="flex h-1 rounded-full overflow-hidden gap-px">
        <div
          className="bg-green-500/70 rounded-l-full transition-all"
          style={{ width: `${homePct}%` }}
        />
        <div
          className="bg-slate-500/50 rounded-r-full transition-all"
          style={{ width: `${awayPct}%` }}
        />
      </div>
    </div>
  );
}

function MatchTeamStatsPanel({ match }: { match: ScheduleMatch }) {
  const hasStats = match.status === "FINISHED" || match.status === "IN_PLAY" || match.status === "PAUSED";
  const url = hasStats
    ? `/api/matches/${match.id}/team-stats?homeTeam=${encodeURIComponent(match.homeTeam)}&awayTeam=${encodeURIComponent(match.awayTeam)}&utcDate=${encodeURIComponent(match.utcDate)}&competition=${encodeURIComponent(match.competitionCode)}`
    : null;
  const { data: stats, loading } = useApi<MatchTeamStats>(url);

  if (!hasStats) {
    return <p className="text-xs text-slate-500 text-center py-6">Stats available after kickoff.</p>;
  }
  if (loading) {
    return (
      <div className="py-8 flex justify-center">
        <div className="w-5 h-5 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
      </div>
    );
  }
  if (!stats) {
    return <p className="text-xs text-slate-500 text-center py-6">Match stats not available.</p>;
  }

  return (
    <div className="px-4 py-4 space-y-3">
      {/* Team name header */}
      <div className="flex justify-between text-[10px] text-slate-400 font-semibold uppercase tracking-wider mb-1">
        <span className="truncate max-w-[80px]">{shortName(match.homeTeam)}</span>
        <span className="truncate max-w-[80px] text-right">{shortName(match.awayTeam)}</span>
      </div>
      <StatBar label="Possession" home={stats.home.possession} away={stats.away.possession} isPercent />
      <StatBar label="Shots" home={stats.home.shots} away={stats.away.shots} />
      <StatBar label="On Target" home={stats.home.shotsOnTarget} away={stats.away.shotsOnTarget} />
      <StatBar label="Corners" home={stats.home.corners} away={stats.away.corners} />
      <StatBar label="Fouls" home={stats.home.fouls} away={stats.away.fouls} />
      <StatBar label="Offsides" home={stats.home.offsides} away={stats.away.offsides} />
      <StatBar label="Yellow Cards" home={stats.home.yellowCards} away={stats.away.yellowCards} />
      <StatBar label="Saves" home={stats.home.saves} away={stats.away.saves} />
    </div>
  );
}

// ── Inline lineup panel (lazy-loads when the card is expanded) ────────────────

function MatchLineupPanel({ match, teamId, teamName }: { match: ScheduleMatch; teamId: number; teamName: string }) {
  const navigate = useNavigate();
  const [hovered, setHovered] = useState<{ player: Player; x: number; y: number } | null>(null);
  const [viewingSide, setViewingSide] = useState<"ours" | "theirs">("ours");
  const compCode = match.competitionCode;
  const isActive = match.status === "IN_PLAY" || match.status === "PAUSED";
  const isUpcoming = match.status === "SCHEDULED" || match.status === "TIMED";
  const hasStats = match.status === "FINISHED" || isActive;

  const { data: lineup, loading: lineupLoading, error: lineupError } = useApi<LineupData>(
    `/api/teams/${teamId}/lineup?competition=${compCode}`
  );

  // Build name → player ID map from the FD.org predicted squad (which has real player IDs).
  // Used as fallback when actual lineup players come from ESPN (id = 0).
  const squadIdByName = useMemo(() => {
    const map = new Map<string, number>();
    if (!lineup) return map;
    for (const p of [...lineup.starters, ...lineup.bench]) {
      if (!p.id) continue;
      map.set(p.name.toLowerCase(), p.id);
      const lastName = p.name.split(" ").pop()?.toLowerCase();
      if (lastName && lastName.length > 2) map.set(lastName, p.id);
    }
    return map;
  }, [lineup]);

  // Build name → position map from the FD.org predicted squad.
  // ESPN bench players have no position data and default to "Midfielder" —
  // we correct that by looking up the player's real position from the predicted squad.
  const squadPositionByName = useMemo(() => {
    const map = new Map<string, Player["position"]>();
    if (!lineup) return map;
    for (const p of [...lineup.starters, ...lineup.bench]) {
      map.set(p.name.toLowerCase(), p.position);
      const lastName = p.name.split(" ").pop()?.toLowerCase();
      if (lastName && lastName.length > 2) map.set(lastName, p.position);
    }
    return map;
  }, [lineup]);

  // Build name → photo map from the predicted squad (photos resolved via FPL/SofaScore/TheSportsDB).
  // The actual lineup from FD.org/ESPN has photo: null when the server's in-memory photo cache
  // was cold at cache-write time. We fill the gap here on the client, which always has lineup data.
  const squadPhotoByName = useMemo(() => {
    const map = new Map<string, string>();
    if (!lineup) return map;
    for (const p of [...lineup.starters, ...lineup.bench]) {
      if (!p.photo) continue;
      map.set(p.name.toLowerCase(), p.photo);
      const lastName = p.name.split(" ").pop()?.toLowerCase();
      if (lastName && lastName.length > 2) map.set(lastName, p.photo);
    }
    return map;
  }, [lineup]);

  // For upcoming games, also try FD.org — official lineups appear ~1 h before kickoff while status is still TIMED.
  const actualLineupUrl = (hasStats || isUpcoming) && match.id > 0
    ? `/api/matches/${match.id}/actual-lineup?homeTeam=${encodeURIComponent(match.homeTeam)}&awayTeam=${encodeURIComponent(match.awayTeam)}&utcDate=${encodeURIComponent(match.utcDate)}&competition=${encodeURIComponent(match.competitionCode)}&status=${encodeURIComponent(match.status)}`
    : null;
  const { data: actualLineup, loading: actualLoading } = useApi<MatchLineups>(actualLineupUrl);

  const { data: detail, loading: detailLoading, retry: retryDetail } = useApi<MatchDetailData>(
    hasStats ? `/api/matches/${match.id}?status=${encodeURIComponent(match.status)}&homeTeam=${encodeURIComponent(match.homeTeam)}&awayTeam=${encodeURIComponent(match.awayTeam)}&utcDate=${encodeURIComponent(match.utcDate)}&competition=${encodeURIComponent(match.competitionCode)}` : null
  );

  const playerStatsUrl = hasStats
    ? `/api/matches/${match.id}/player-stats?homeTeam=${encodeURIComponent(match.homeTeam)}&awayTeam=${encodeURIComponent(match.awayTeam)}&utcDate=${encodeURIComponent(match.utcDate)}&competition=${encodeURIComponent(match.competitionCode)}&status=${encodeURIComponent(match.status)}`
    : null;
  const { data: playerStats, loading: statsLoading, retry: retryStats } = useApi<Record<string, PlayerGameStats>>(playerStatsUrl);

  // Poll stats and detail every 30 s while the match is live
  const retryStatsRef = useRef(retryStats);
  useEffect(() => { retryStatsRef.current = retryStats; }, [retryStats]);
  const retryDetailRef2 = useRef(retryDetail);
  useEffect(() => { retryDetailRef2.current = retryDetail; }, [retryDetail]);
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => { retryStatsRef.current(); retryDetailRef2.current(); }, 30_000);
    return () => clearInterval(id);
  }, [isActive]);

  // Build from detail.substitutions so the ↓ badges work even when playerStats
  // cache predates the subbedOut field.
  // Uses the same normalisation as Pitch.normLast — diacritics stripped, hyphens
  // treated as spaces — so "Alexander-Arnold" and "Alexander Arnold" both resolve
  // to the same key, as do accented variants like "Félix" / "Felix".
  const subbedOutNames = useMemo(() => {
    const s = new Set<string>();
    for (const sub of detail?.substitutions ?? []) {
      for (const tok of subNameTokens(sub.playerOut)) s.add(tok);
    }
    return s;
  }, [detail?.substitutions]);

  function handlePlayerClick(player: Player) {
    let id = player.id;
    if (!id && player.name) {
      // ESPN-sourced players have id=0: look up from the predicted squad by name
      const lower = player.name.toLowerCase();
      id = squadIdByName.get(lower) ?? 0;
      if (!id) {
        const lastName = player.name.split(" ").pop()?.toLowerCase();
        if (lastName) id = squadIdByName.get(lastName) ?? 0;
      }
    }
    if (!id) return;
    navigate(`/player/${id}?competition=${compCode}`, { state: { player: { ...player, id }, teamName } });
  }

  function handleHover(player: Player | null, x: number, y: number) {
    setHovered(player ? { player, x, y } : null);
  }

  // Upcoming games: wait for the FD.org lineup check, then either show confirmed lineup or "not released".
  // Finished/live games: wait for the predicted squad, then overlay actual lineup when it arrives.
  if (isUpcoming) {
    if (actualLoading) {
      return (
        <div className="py-8 flex justify-center">
          <div className="w-5 h-5 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
        </div>
      );
    }
    if (!actualLineup?.hasData) {
      return <p className="text-xs text-slate-500 text-center py-6">Lineups not yet released.</p>;
    }
  } else {
    if (lineupLoading) {
      return (
        <div className="py-8 flex justify-center">
          <div className="w-5 h-5 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
        </div>
      );
    }
    if (lineupError || !lineup) {
      return <p className="text-xs text-slate-500 text-center py-4">Lineup unavailable for this competition.</p>;
    }
  }

  const useActual = (hasStats || isUpcoming) && actualLineup?.hasData === true;
  const isHome = match.homeTeamId === teamId;
  const viewerName = isHome ? match.homeTeam : match.awayTeam;
  const opponentName = isHome ? match.awayTeam : match.homeTeam;

  // Enrich an actual-lineup player with photo/position from the predicted squad when missing.
  // The actual lineup (FD.org/ESPN) has photo: null when the server's photo cache was cold at
  // cache-write time; the predicted lineup always resolves photos via FPL/SofaScore/TheSportsDB.
  // Position enrichment is always applied: ESPN/FD.org bench players often get position="Midfielder"
  // role="CM" as a generic fallback when no position data is available, so we can't rely on role
  // to distinguish "genuinely a midfielder" from "fallback label".
  function enrichPlayer(p: ReturnType<typeof toPlayer>): ReturnType<typeof toPlayer> {
    const lower = p.name.toLowerCase();
    const lastName = p.name.split(" ").pop()?.toLowerCase() ?? "";
    const photo = p.photo ?? squadPhotoByName.get(lower) ?? squadPhotoByName.get(lastName) ?? null;
    const squadPos = squadPositionByName.get(lower) ?? squadPositionByName.get(lastName);
    const pos = squadPos ?? p.position;
    return photo === p.photo && pos === p.position ? p : { ...p, photo, position: pos };
  }

  const viewerStarters = useActual
    ? (isHome ? actualLineup!.homeStarters : actualLineup!.awayStarters).map(toPlayer).map(enrichPlayer)
    : lineup!.starters;
  const viewerBench = useActual
    ? (isHome ? actualLineup!.homeBench : actualLineup!.awayBench).map(toPlayer).map(enrichPlayer)
    : lineup!.bench;
  const viewerFormation = useActual
    ? (isHome ? actualLineup!.homeFormation : actualLineup!.awayFormation) || lineup?.formation || ""
    : lineup!.formation;

  const opponentStarters = useActual
    ? (isHome ? actualLineup!.awayStarters : actualLineup!.homeStarters).map(toPlayer).map(enrichPlayer)
    : [];
  const opponentBench = useActual
    ? (isHome ? actualLineup!.awayBench : actualLineup!.homeBench).map(toPlayer).map(enrichPlayer)
    : [];
  const opponentFormation = useActual
    ? (isHome ? actualLineup!.awayFormation : actualLineup!.homeFormation) || ""
    : "";

  const displayStarters = viewingSide === "theirs" && useActual ? opponentStarters : viewerStarters;
  const displayBench    = viewingSide === "theirs" && useActual ? opponentBench    : viewerBench;
  const displayFormation = viewingSide === "theirs" && useActual ? opponentFormation : viewerFormation;

  return (
    <div>
      {detail && (
        <MatchStatsSection detail={detail} match={match} viewingTeamId={teamId} />
      )}
      {hasStats && detailLoading && (
        <div className="flex justify-center py-2">
          <div className="w-3 h-3 border border-slate-600 border-t-slate-400 rounded-full animate-spin" />
        </div>
      )}

      <div className="pt-3 pb-1 px-4">
        {/* Team side toggle — only visible when we have actual lineup data for both sides */}
        {useActual && (
          <div className="flex items-center justify-center gap-1 mb-3">
            <button
              onClick={() => setViewingSide("ours")}
              className={`text-[10px] px-2.5 py-0.5 rounded-full transition-colors ${
                viewingSide === "ours" ? "bg-slate-700 text-white font-medium" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {shortName(viewerName)}
            </button>
            <span className="text-slate-700 text-[10px]">·</span>
            <button
              onClick={() => setViewingSide("theirs")}
              className={`text-[10px] px-2.5 py-0.5 rounded-full transition-colors ${
                viewingSide === "theirs" ? "bg-slate-700 text-white font-medium" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {shortName(opponentName)}
            </button>
          </div>
        )}

        <p className="text-[10px] text-slate-500 text-center mb-3 uppercase tracking-wider">
          {displayFormation} ·{" "}
          {isUpcoming
            ? useActual
              ? "Confirmed Lineup · Click for career"
              : "Predicted Lineup · Click for career"
            : "Hover for match stats · Click for career"}
        </p>
        <div className="max-w-[220px] mx-auto">
          <Pitch
            starters={displayStarters}
            formation={displayFormation}
            subbedOutNames={subbedOutNames}
            onHover={handleHover}
            onClick={handlePlayerClick}
            compact
          />
        </div>
      </div>

      {displayBench.length > 0 && (
        <div className="px-4 pb-3">
          <Bench bench={displayBench} onClick={handlePlayerClick} onHover={handleHover} playerStats={playerStats ?? null} />
        </div>
      )}

      {hovered && (
        <MatchPlayerTooltip
          player={hovered.player}
          x={hovered.x}
          y={hovered.y}
          playerStats={playerStats ?? null}
          statsLoading={statsLoading}
        />
      )}
    </div>
  );
}

// ── H2H panel ─────────────────────────────────────────────────────────────────

function H2HPanel({ match, viewingTeamId }: { match: ScheduleMatch; viewingTeamId: number }) {
  const { data: h2h, loading } = useApi<ScheduleMatch[]>(
    `/api/h2h?homeTeamId=${match.homeTeamId}&awayTeamId=${match.awayTeamId}&comp=${encodeURIComponent(match.competitionCode)}`
  );

  if (loading) {
    return (
      <div className="py-8 flex justify-center">
        <div className="w-5 h-5 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
      </div>
    );
  }

  const meetings = h2h ?? [];

  if (meetings.length === 0) {
    return <p className="text-xs text-slate-500 text-center py-6">No recent meetings found in this competition.</p>;
  }

  const wins   = meetings.filter((m) => getResult(m, viewingTeamId) === "W").length;
  const draws  = meetings.filter((m) => getResult(m, viewingTeamId) === "D").length;
  const losses = meetings.filter((m) => getResult(m, viewingTeamId) === "L").length;

  return (
    <div className="px-4 py-4 space-y-3">
      {/* W/D/L summary */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
          Last {meetings.length} meetings
        </span>
        <div className="flex items-center gap-3 text-[11px] font-bold">
          <span className="text-green-400">{wins}W</span>
          <span className="text-slate-500">{draws}D</span>
          <span className="text-red-400">{losses}L</span>
        </div>
      </div>

      {/* Result rows */}
      <div className="space-y-1.5">
        {meetings.map((m, i) => {
          const result = getResult(m, viewingTeamId);
          const d = new Date(m.utcDate);
          const dateStr = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="text-[10px] text-slate-600 w-16 shrink-0 tabular-nums">{dateStr}</span>
              <span className="text-slate-400 truncate flex-1 min-w-0 text-[10px]">
                {shortName(m.homeTeam)} vs {shortName(m.awayTeam)}
              </span>
              <span className="text-white font-bold tabular-nums text-[11px] shrink-0">
                {m.scoreHome}–{m.scoreAway}
              </span>
              {result && (
                <span
                  className={`text-[10px] font-bold w-3.5 text-right shrink-0 ${
                    result === "W" ? "text-green-400" : result === "L" ? "text-red-400" : "text-slate-500"
                  }`}
                >
                  {result}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Score display ─────────────────────────────────────────────────────────────

function ScoreDisplay({ match, isLive }: { match: ScheduleMatch; isLive: boolean }) {
  const isPen = match.duration === "PENALTY_SHOOTOUT";
  const isAET = match.duration === "EXTRA_TIME" || isPen;

  // Only display pen scores when valid: non-null and non-equal
  // (equal pens is impossible for a decided match — guard against bad API data)
  const hasPens = isPen
    && match.penScoreHome !== null
    && match.penScoreAway !== null
    && match.penScoreHome !== match.penScoreAway;

  // etScoreHome is the cumulative score at end of extra time (120 min), per fd.org API.
  const displayHome = isAET && match.etScoreHome !== null ? match.etScoreHome : match.scoreHome;
  const displayAway = isAET && match.etScoreAway !== null ? match.etScoreAway : match.scoreAway;

  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={`text-sm font-bold tabular-nums leading-tight ${isLive ? "text-red-300" : "text-white"}`}>
        {displayHome} – {displayAway}
      </span>
      {isAET && (
        <span className="text-[9px] font-semibold text-slate-500 uppercase tracking-wider leading-tight">AET</span>
      )}
      {hasPens && (
        <span className="text-[9px] tabular-nums text-slate-400 leading-tight">
          ({match.penScoreHome}–{match.penScoreAway} pens)
        </span>
      )}
    </div>
  );
}

// ── Match card ────────────────────────────────────────────────────────────────

function MatchCard({ match, teamId, teamName, tieInfo }: { match: ScheduleMatch; teamId: number; teamName: string; tieInfo?: TieInfo }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<"lineup" | "stats" | "timeline" | "h2h">("lineup");
  const [homeErr, setHomeErr] = useState(false);
  const [awayErr, setAwayErr] = useState(false);
  const [compErr, setCompErr] = useState(false);

  function goToTeam(id: number, name: string, crest: string) {
    const navTeam = {
      id,
      name,
      shortName: shortName(name),
      crest: crest || "",
      tla: name.split(/\s+/).filter(Boolean).map((w: string) => w[0]).join("").slice(0, 3).toUpperCase(),
    };
    const navComp = { id: 0, name: match.competition, code: match.competitionCode, emblem: match.competitionEmblem || "" };
    navigate("/", { state: { navTeam, navComp, navView: "schedule" } });
  }

  const isLive = match.status === "IN_PLAY" || match.status === "PAUSED";
  const isUpcoming = match.status === "SCHEDULED" || match.status === "TIMED";
  const isFinished = match.status === "FINISHED";
  const isPostponed = match.status === "POSTPONED";
  const result = isFinished ? getResult(match, teamId) : null;
  // Negative IDs = ESPN/TM-sourced cup matches; football-data.org lineup lookup won't work for them.
  // Upcoming games can expand — FD.org publishes official lineups ~1 h before kickoff (status stays TIMED).
  const canExpand = !isPostponed && !!match.competitionCode && match.id > 0;

  // Pre-fetch all three panel data sources as soon as the card expands so that
  // switching tabs is instant. useApi deduplication ensures no double HTTP requests
  // even though the individual panels also call useApi for the same URLs.
  const cardHasStats = isFinished || isLive;
  const encParams = `homeTeam=${encodeURIComponent(match.homeTeam)}&awayTeam=${encodeURIComponent(match.awayTeam)}&utcDate=${encodeURIComponent(match.utcDate)}&competition=${encodeURIComponent(match.competitionCode)}`;
  const { data: cardDetail } = useApi<MatchDetailData>(expanded && cardHasStats ? `/api/matches/${match.id}?status=${encodeURIComponent(match.status)}&${encParams}` : null);
  useApi<Record<string, PlayerGameStats>>(expanded && cardHasStats ? `/api/matches/${match.id}/player-stats?${encParams}&status=${encodeURIComponent(match.status)}` : null);
  useApi<MatchTeamStats>(expanded && cardHasStats ? `/api/matches/${match.id}/team-stats?${encParams}` : null);

  // When the card is expanded and live, use the authoritative FT score from the detail
  // response instead of the liveById overlay (which has SWR lag up to ~60s).
  const displayedMatch = (isLive && cardDetail?.ftHome !== null && cardDetail?.ftHome !== undefined &&
                          cardDetail?.ftAway !== null && cardDetail?.ftAway !== undefined)
    ? { ...match, scoreHome: cardDetail.ftHome, scoreAway: cardDetail.ftAway }
    : match;
  const hasScore = displayedMatch.scoreHome !== null && displayedMatch.scoreAway !== null;

  return (
    <div className={`bg-slate-800/60 border rounded-xl overflow-hidden ${isLive ? "border-red-500/40" : "border-slate-700/60"}`}>
      <div className="p-3">
        {/* Competition + date */}
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-1.5 min-w-0">
            {match.competitionEmblem && !compErr && (
              <img src={match.competitionEmblem} alt="" onError={() => setCompErr(true)} className="w-4 h-4 object-contain shrink-0" />
            )}
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider truncate">
              {match.competition}{match.matchday ? ` · MD${match.matchday}` : ""}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            {isLive && (
              <span className="flex items-center gap-1 text-[10px] font-bold text-red-400">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                LIVE
              </span>
            )}
            {isPostponed && <span className="text-[10px] font-semibold text-amber-400">POSTPONED</span>}
            <span className="text-[10px] text-slate-500">{formatDate(match.utcDate)}</span>
          </div>
        </div>

        {/* Teams + score */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {match.homeTeamCrest && !homeErr && (
              <img src={match.homeTeamCrest} alt="" onError={() => setHomeErr(true)} className="w-5 h-5 object-contain shrink-0" />
            )}
            <button
              onClick={(e) => { e.stopPropagation(); goToTeam(match.homeTeamId, match.homeTeam, match.homeTeamCrest); }}
              className={`text-xs font-semibold truncate hover:underline transition-colors text-left ${match.homeTeamId === teamId ? "text-white" : "text-slate-300 hover:text-white"}`}
            >
              {shortName(match.homeTeam)}
            </button>
          </div>
          <div className="shrink-0 px-2 text-center min-w-[56px]">
            {hasScore ? (
              <ScoreDisplay match={displayedMatch} isLive={isLive} />
            ) : (
              <span className="text-xs font-medium text-slate-500">vs</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 min-w-0 flex-1 justify-end">
            <button
              onClick={(e) => { e.stopPropagation(); goToTeam(match.awayTeamId, match.awayTeam, match.awayTeamCrest); }}
              className={`text-xs font-semibold truncate text-right hover:underline transition-colors ${match.awayTeamId === teamId ? "text-white" : "text-slate-300 hover:text-white"}`}
            >
              {shortName(match.awayTeam)}
            </button>
            {match.awayTeamCrest && !awayErr && (
              <img src={match.awayTeamCrest} alt="" onError={() => setAwayErr(true)} className="w-5 h-5 object-contain shrink-0" />
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between mt-2.5">
          <div className="flex flex-col gap-0.5">
            {result && (
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border self-start ${RESULT_STYLE[result]}`}>
                {RESULT_LABEL[result]}
              </span>
            )}
            {tieInfo && (
              <span className="text-[9px] text-slate-400 pl-0.5 leading-tight">
                <span className="text-slate-500">Leg {tieInfo.legNumber} · </span>
                <span className={
                  tieInfo.won === true ? "text-green-400/80 font-semibold" :
                  tieInfo.won === false ? "text-red-400/80 font-semibold" :
                  "text-slate-400"
                }>
                  {tieInfo.aggOurs}–{tieInfo.aggTheirs} agg
                  {tieInfo.won === true && " · Progressed"}
                  {tieInfo.won === false && " · Eliminated"}
                </span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {(isLive || isUpcoming) && (
              <a href={googleLink(match)} target="_blank" rel="noopener noreferrer"
                className="text-[10px] text-slate-500 hover:text-green-400 transition-colors">
                {isLive ? "Live score →" : "Search →"}
              </a>
            )}
            {canExpand && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="text-[10px] font-medium text-slate-400 hover:text-white transition-colors flex items-center gap-0.5"
              >
                ⚽ Lineup
                <svg className={`w-3 h-3 ml-0.5 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-slate-700/60 bg-slate-900/40">
          {/* Panel tabs */}
          <div className="flex border-b border-slate-700/60">
            <button
              onClick={() => setPanel("lineup")}
              className={`flex-1 py-2 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                panel === "lineup"
                  ? "text-white border-b-2 border-green-500 -mb-px"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              ⚽ Lineup
            </button>
            <button
              onClick={() => setPanel("stats")}
              className={`flex-1 py-2 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                panel === "stats"
                  ? "text-white border-b-2 border-green-500 -mb-px"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              📊 Stats
            </button>
            <button
              onClick={() => setPanel("timeline")}
              className={`flex-1 py-2 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                panel === "timeline"
                  ? "text-white border-b-2 border-green-500 -mb-px"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              ⏱ Timeline
            </button>
            <button
              onClick={() => setPanel("h2h")}
              className={`flex-1 py-2 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                panel === "h2h"
                  ? "text-white border-b-2 border-green-500 -mb-px"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              H2H
            </button>
          </div>
          {panel === "lineup" && <MatchLineupPanel match={match} teamId={teamId} teamName={teamName} />}
          {panel === "stats" && <MatchTeamStatsPanel match={match} />}
          {panel === "timeline" && <MatchTimelinePanel match={match} viewingTeamId={teamId} />}
          {panel === "h2h" && <H2HPanel match={match} viewingTeamId={teamId} />}
        </div>
      )}
    </div>
  );
}

// ── Schedule section header ───────────────────────────────────────────────────

function Section({ title, color, dot, children }: { title: string; color: string; dot?: boolean; children: React.ReactNode }) {
  return (
    <section>
      <h2 className={`text-xs font-semibold uppercase tracking-widest mb-3 flex items-center gap-2 ${color}`}>
        {dot && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
        {title}
      </h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function TeamSchedule({ matches, loading, error, teamId, teamName, onRetry, upcomingLoading }: Props) {
  const tieInfos = useMemo(
    () => computeTieInfos(matches, teamId, teamName),
    [matches, teamId, teamName]
  );

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-slate-500">
        <div className="w-6 h-6 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
        <p className="text-sm">Loading schedule…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-slate-500">
        <p className="text-sm">Could not load schedule.</p>
        {onRetry && (
          <button onClick={onRetry} className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded-lg transition-colors">
            Retry
          </button>
        )}
      </div>
    );
  }

  if (matches.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-20 text-slate-500">
        <p className="text-sm">No schedule data found for {teamName}.</p>
      </div>
    );
  }

  const live      = matches.filter((m) => ["IN_PLAY", "PAUSED"].includes(m.status));
  const upcoming  = matches.filter((m) => ["SCHEDULED", "TIMED"].includes(m.status))
                           .sort((a, b) => +new Date(a.utcDate) - +new Date(b.utcDate));
  const results   = matches.filter((m) => m.status === "FINISHED")
                           .sort((a, b) => +new Date(b.utcDate) - +new Date(a.utcDate));
  const postponed = matches.filter((m) => m.status === "POSTPONED");

  return (
    <div className="space-y-8 w-full">
      {live.length > 0 && (
        <Section title="Playing Now" color="text-red-400/80" dot>
          {live.map((m) => <MatchCard key={m.id} match={m} teamId={teamId} teamName={teamName} tieInfo={tieInfos.get(m.id)} />)}
        </Section>
      )}
      {(upcoming.length > 0 || upcomingLoading) && (
        <Section title="Upcoming" color="text-slate-500">
          {upcoming.map((m) => <MatchCard key={m.id} match={m} teamId={teamId} teamName={teamName} tieInfo={tieInfos.get(m.id)} />)}
          {upcomingLoading && upcoming.length === 0 && (
            <div className="flex items-center gap-2 py-3 text-slate-600">
              <div className="w-3.5 h-3.5 border-2 border-slate-700 border-t-slate-500 rounded-full animate-spin" />
              <span className="text-xs">Checking for upcoming matches…</span>
            </div>
          )}
        </Section>
      )}
      {results.length > 0 && (
        <Section title="Results" color="text-slate-500">
          {results.map((m) => <MatchCard key={m.id} match={m} teamId={teamId} teamName={teamName} tieInfo={tieInfos.get(m.id)} />)}
        </Section>
      )}
      {postponed.length > 0 && (
        <Section title="Postponed" color="text-amber-500/60">
          {postponed.map((m) => <MatchCard key={m.id} match={m} teamId={teamId} teamName={teamName} tieInfo={tieInfos.get(m.id)} />)}
        </Section>
      )}
    </div>
  );
}

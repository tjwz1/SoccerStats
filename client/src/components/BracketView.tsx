import { useState, useEffect } from "react";
import type { BracketData, BracketTie, BracketMatchData, ScheduleMatch } from "../types";
import { useApi } from "../hooks/useApi";
import { useLiveMatches } from "../contexts/LiveMatchesContext";
import MatchDetailModal from "./MatchDetailModal";

interface Props {
  compCode: string;
  season: number | null;
}

function fmt(utcDate: string) {
  return new Date(utcDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function shortName(name: string): string {
  return name
    .replace(/\s+(FC|F\.C\.|CF|AFC|SC|SV|RCD|CD|UD|SD)$/i, "")
    .replace(/^(FC|AFC)\s+/i, "")
    .replace(/\s+Football Club$/i, "")
    .trim();
}

// Overlay live match data onto a bracket match so scores/status are always current.
function withLive(match: BracketMatchData, liveById: Map<number, ScheduleMatch>): BracketMatchData {
  const live = liveById.get(match.id);
  if (!live) return match;
  return {
    ...match,
    status: live.status,
    scoreHome: live.scoreHome,
    scoreAway: live.scoreAway,
    winner: live.winner,
    etScoreHome: live.etScoreHome,
    etScoreAway: live.etScoreAway,
    penScoreHome: live.penScoreHome,
    penScoreAway: live.penScoreAway,
  };
}

// ── Compact live ticker for the bracket ───────────────────────────────────────
function BracketTicker({ matches }: { matches: ScheduleMatch[] }) {
  if (!matches.length) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-2 items-center">
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
        <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider">Live</span>
      </div>
      {matches.map((m) => (
        <div
          key={m.id}
          className="flex items-center gap-1 text-[11px] bg-slate-900 border border-red-500/20 rounded px-2 py-1"
        >
          {m.homeTeamCrest && (
            <img src={m.homeTeamCrest} alt="" className="w-3.5 h-3.5 object-contain shrink-0" />
          )}
          <span className="text-slate-300">{shortName(m.homeTeam)}</span>
          <span className="font-bold text-white tabular-nums bg-slate-800 px-1.5 py-0.5 rounded mx-0.5">
            {m.scoreHome ?? 0}–{m.scoreAway ?? 0}
          </span>
          <span className="text-slate-300">{shortName(m.awayTeam)}</span>
          {m.awayTeamCrest && (
            <img src={m.awayTeamCrest} alt="" className="w-3.5 h-3.5 object-contain shrink-0" />
          )}
          {m.status === "PAUSED" && (
            <span className="text-[9px] text-yellow-400 font-semibold ml-1">HT</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── TeamRow ────────────────────────────────────────────────────────────────────
function TeamRow({
  team,
  isWinner,
  score,
  isLive = false,
}: {
  team: { name: string; shortName: string; crest: string };
  isWinner: boolean;
  score: number | null;
  isLive?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 py-[3px]">
      {team.crest ? (
        <img src={team.crest} alt="" className="w-4 h-4 object-contain shrink-0" />
      ) : (
        <div className="w-4 h-4 rounded-full bg-slate-700 shrink-0" />
      )}
      <span
        className={`text-[11px] truncate flex-1 min-w-0 ${
          isWinner ? "text-white font-semibold" : isLive ? "text-slate-200" : "text-slate-400"
        }`}
      >
        {team.shortName || team.name}
      </span>
      <span
        className={`tabular-nums text-xs font-bold w-4 text-right shrink-0 ${
          score !== null
            ? isWinner
              ? "text-white"
              : isLive
              ? "text-green-400"
              : "text-slate-500"
            : "text-slate-700"
        }`}
      >
        {score !== null ? score : "–"}
      </span>
    </div>
  );
}

// ── SingleLegCard ─────────────────────────────────────────────────────────────
function SingleLegCard({
  match,
  winner,
}: {
  match: BracketMatchData;
  winner: "home" | "away" | null;
}) {
  const done = match.status === "FINISHED";
  const live = match.status === "IN_PLAY" || match.status === "PAUSED";
  const showScore = done || live;
  const hasPens = match.penScoreHome !== null;

  // For PK games show AET total (fullTime + incremental ET goals) as the main score.
  // etScoreHome is incremental (goals scored during ET only), so AET = scoreHome + etScoreHome.
  const displayHome = showScore
    ? (hasPens && match.etScoreHome !== null
        ? (match.scoreHome ?? 0) + match.etScoreHome
        : match.scoreHome)
    : null;
  const displayAway = showScore
    ? (hasPens && match.etScoreAway !== null
        ? (match.scoreAway ?? 0) + match.etScoreAway
        : match.scoreAway)
    : null;

  return (
    <div className="px-2.5 py-2">
      <TeamRow
        team={match.homeTeam}
        isWinner={done && winner === "home"}
        score={displayHome}
        isLive={live}
      />
      <TeamRow
        team={match.awayTeam}
        isWinner={done && winner === "away"}
        score={displayAway}
        isLive={live}
      />
      {!done && !live && (
        <p className="text-[10px] text-slate-600 text-center mt-1">{fmt(match.utcDate)}</p>
      )}
      {live && (
        <p className="flex items-center justify-center gap-1 text-[10px] text-red-400 mt-1">
          <span className="w-1 h-1 rounded-full bg-red-500 animate-pulse inline-block" />
          {match.status === "PAUSED" ? "Half Time" : "Live"}
        </p>
      )}
      {hasPens && (
        <p className="text-[10px] text-slate-600 text-center">
          AET · Pens {match.penScoreHome}–{match.penScoreAway}
        </p>
      )}
      {match.etScoreHome !== null && !hasPens && (
        <p className="text-[10px] text-slate-600 text-center">
          AET {match.etScoreHome}–{match.etScoreAway}
        </p>
      )}
    </div>
  );
}

// ── TwoLeggedCard ─────────────────────────────────────────────────────────────
function TwoLeggedCard({ tie }: { tie: BracketTie }) {
  const { leg1, leg2, aggHome, aggAway, winner } = tie;
  const pending = aggHome === null;

  return (
    <div>
      <div className="px-2.5 pt-2 pb-1.5">
        <TeamRow
          team={leg1.homeTeam}
          isWinner={!pending && winner === "home"}
          score={aggHome}
        />
        <TeamRow
          team={leg1.awayTeam}
          isWinner={!pending && winner === "away"}
          score={aggAway}
        />
      </div>
      <div className="border-t border-slate-800/50 px-2.5 py-1 flex gap-2 text-[10px] text-slate-500">
        <span>
          L1{" "}
          {leg1.status === "FINISHED" && leg1.scoreHome !== null
            ? `${leg1.scoreHome}–${leg1.scoreAway}`
            : fmt(leg1.utcDate)}
        </span>
        {leg2 && (
          <span>
            L2{" "}
            {leg2.status === "FINISHED" && leg2.scoreHome !== null
              ? `${leg2.scoreHome}–${leg2.scoreAway}`
              : fmt(leg2.utcDate)}
          </span>
        )}
        {(leg1.penScoreHome !== null || leg2?.penScoreHome !== null) && (
          <span className="ml-auto text-slate-600">
            P{" "}
            {leg2?.penScoreHome ?? leg1.penScoreHome}–
            {leg2?.penScoreAway ?? leg1.penScoreAway}
          </span>
        )}
      </div>
    </div>
  );
}

// ── TieCard ───────────────────────────────────────────────────────────────────
function TieCard({ tie, onClick }: { tie: BracketTie; onClick: () => void }) {
  const isLive = (["IN_PLAY", "PAUSED"] as string[]).some(
    (s) => tie.leg1.status === s || tie.leg2?.status === s
  );
  const isClickable = tie.leg1.status !== "SCHEDULED" || tie.leg2?.status !== "SCHEDULED";
  return (
    <div
      onClick={isClickable ? onClick : undefined}
      className={`bg-slate-900/70 border rounded-lg overflow-hidden transition-colors ${
        isLive ? "border-red-500/50" : "border-slate-800"
      } ${isClickable ? "cursor-pointer hover:border-green-600/50 hover:bg-slate-800/60" : ""}`}
    >
      {tie.leg2 ? (
        <TwoLeggedCard tie={tie} />
      ) : (
        <SingleLegCard match={tie.leg1} winner={tie.winner} />
      )}
    </div>
  );
}

// ── BracketView ───────────────────────────────────────────────────────────────
export default function BracketView({ compCode, season }: Props) {
  const url = `/api/competitions/${compCode}/bracket${season ? `?season=${season}` : ""}`;
  const { data, loading, error, retry } = useApi<BracketData>(url);
  const [selectedTie, setSelectedTie] = useState<BracketTie | null>(null);
  const { liveMatches, liveById } = useLiveMatches();

  // Live matches in this specific competition
  const compLive = liveMatches.filter((m) => m.competitionCode === compCode);
  const hasLive = compLive.length > 0;

  // Auto-refresh bracket while matches are live so winner advancement appears promptly.
  // Live scores are overlaid instantly via liveById; the re-fetch picks up next-round team slots.
  useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(retry, 60_000);
    return () => clearInterval(id);
  }, [hasLive, retry]);

  if (loading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-4 pt-1">
        {[8, 8, 4, 2, 1].map((n, i) => (
          <div key={i} className="flex-none w-48 space-y-1">
            <div className="h-5 w-28 bg-slate-800 rounded animate-pulse mx-auto mb-3" />
            {Array.from({ length: Math.min(n, 4) }).map((_, j) => (
              <div key={j} className="h-[72px] bg-slate-800/60 rounded-lg animate-pulse" />
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (error || !data?.rounds.length) {
    return (
      <p className="text-sm text-slate-500 text-center py-14">
        {error && !error.includes("404")
          ? "Failed to load bracket — try refreshing."
          : "Knockout bracket not yet available for this competition."}
      </p>
    );
  }

  // Apply live score overlays so bracket cards always show current scores.
  // Winner recomputation for single-leg matches handles the case where the
  // server cache hasn't refreshed yet but liveById already has FINISHED status.
  const rounds = data.rounds.map((round) => ({
    ...round,
    ties: round.ties.map((tie) => {
      const leg1 = withLive(tie.leg1, liveById);
      const leg2 = tie.leg2 ? withLive(tie.leg2, liveById) : null;
      // Recompute winner for single-leg ties that finished while cache was stale
      let winner = tie.winner;
      if (!leg2 && leg1.status === "FINISHED" && winner === null) {
        winner = leg1.winner === "HOME_TEAM" ? "home" : leg1.winner === "AWAY_TEAM" ? "away" : null;
      }
      // fd.org sometimes omits score.winner for PK games — infer from pen scores
      if (winner === null && leg1.penScoreHome !== null && leg1.penScoreAway !== null
          && leg1.penScoreHome !== leg1.penScoreAway) {
        winner = leg1.penScoreHome > leg1.penScoreAway ? "home" : "away";
      }
      return { ...tie, leg1, leg2, winner };
    }),
  }));

  // Proportional slot heights: every column shares the same total height.
  const maxTies = Math.max(...rounds.map((r) => r.ties.length));
  const twoLegged = rounds.some((r) => r.ties.some((t) => t.leg2 !== null));
  const SLOT_PX = twoLegged ? 108 : 82;
  const totalH = maxTies * SLOT_PX;

  return (
    <>
      <BracketTicker matches={compLive} />

      <div className="overflow-x-auto pb-4">
        <div className="flex gap-2 min-w-max">
          {rounds.map((round) => {
            const slotH = totalH / round.ties.length;
            return (
              <div key={round.stage} className="flex-none w-48">
                <div className="text-center mb-3">
                  <span className="inline-block px-3 py-1 rounded-md bg-slate-800 border border-slate-700 text-[11px] font-bold text-slate-300 uppercase tracking-wider whitespace-nowrap">
                    {round.name}
                  </span>
                  <div className="text-[10px] text-slate-600 mt-1">
                    {round.ties.length} {round.ties.length === 1 ? "match" : "ties"}
                  </div>
                </div>

                <div style={{ height: totalH }}>
                  {round.ties.map((tie) => (
                    <div
                      key={`${tie.leg1.id}-${tie.leg2?.id ?? "s"}`}
                      style={{ height: slotH }}
                      className="flex items-center px-1"
                    >
                      <div className="w-full">
                        <TieCard tie={tie} onClick={() => setSelectedTie(tie)} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {selectedTie && (
        <MatchDetailModal tie={selectedTie} onClose={() => setSelectedTie(null)} />
      )}
    </>
  );
}

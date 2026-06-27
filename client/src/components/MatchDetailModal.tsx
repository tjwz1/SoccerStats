import { useEffect } from "react";
import type { BracketMatchData, BracketTie, MatchDetailData, MatchGoalEvent } from "../types";
import { useApi } from "../hooks/useApi";

interface Props {
  tie: BracketTie;
  onClose: () => void;
}

function fmtDate(utcDate: string) {
  return new Date(utcDate).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
}

function goalIcon(type: MatchGoalEvent["type"]) {
  if (type === "OWN_GOAL") return "⚽ OG";
  if (type === "PENALTY") return "⚽ PEN";
  return "⚽";
}

function GoalLine({ g }: { g: MatchGoalEvent }) {
  const isHome = g.team === "home";
  const min = g.extraTime ? `${g.minute}+${g.extraTime}'` : `${g.minute}'`;
  return (
    <div className={`flex items-start gap-2 text-xs py-0.5 ${isHome ? "" : "flex-row-reverse text-right"}`}>
      <span className="text-slate-500 tabular-nums w-8 shrink-0 pt-0.5">{min}</span>
      <span className="text-[10px] text-green-500 pt-0.5 shrink-0">{goalIcon(g.type)}</span>
      <span className="text-slate-200">
        {g.scorer}
        {g.assist && <span className="text-slate-500"> ({g.assist})</span>}
      </span>
    </div>
  );
}

function LegDetail({ match, label }: { match: BracketMatchData; label?: string }) {
  const params = new URLSearchParams({
    status: match.status,
    homeTeam: match.homeTeam.name,
    awayTeam: match.awayTeam.name,
    utcDate: match.utcDate,
  });
  const { data, loading } = useApi<MatchDetailData>(
    match.status !== "SCHEDULED" ? `/api/matches/${match.id}?${params}` : null
  );

  const done = match.status === "FINISHED";
  const allGoals = [...(data?.goals ?? [])].sort((a, b) => a.minute - b.minute);

  return (
    <div className="mt-3">
      {label && (
        <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">{label}</div>
      )}

      {/* Score row */}
      <div className="flex items-center justify-between gap-4">
        {/* Home */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {match.homeTeam.crest && (
            <img src={match.homeTeam.crest} alt="" className="w-6 h-6 object-contain shrink-0" />
          )}
          <span className="text-sm font-semibold text-white truncate">
            {match.homeTeam.shortName || match.homeTeam.name}
          </span>
        </div>

        <div className="text-center shrink-0">
          {done ? (
            <span className="text-2xl font-bold text-white tabular-nums">
              {match.scoreHome} – {match.scoreAway}
            </span>
          ) : (
            <span className="text-sm text-slate-500">{fmtDate(match.utcDate)}</span>
          )}
          {match.etScoreHome !== null && match.penScoreHome === null && (
            <div className="text-[10px] text-slate-500">AET {match.etScoreHome}–{match.etScoreAway}</div>
          )}
          {match.penScoreHome !== null && (
            <div className="text-[10px] text-slate-500">Pens {match.penScoreHome}–{match.penScoreAway}</div>
          )}
        </div>

        {/* Away */}
        <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">
          <span className="text-sm font-semibold text-white truncate text-right">
            {match.awayTeam.shortName || match.awayTeam.name}
          </span>
          {match.awayTeam.crest && (
            <img src={match.awayTeam.crest} alt="" className="w-6 h-6 object-contain shrink-0" />
          )}
        </div>
      </div>

      {/* Goal events */}
      {loading && (
        <div className="mt-3 h-4 w-32 bg-slate-800 rounded animate-pulse" />
      )}
      {!loading && allGoals.length > 0 && (
        <div className="mt-3 border-t border-slate-800/60 pt-2 space-y-0.5">
          {allGoals.map((g, i) => (
            <GoalLine key={i} g={g} />
          ))}
        </div>
      )}
      {!loading && done && allGoals.length === 0 && (
        <p className="mt-2 text-[11px] text-slate-600 text-center">No goal events available</p>
      )}
    </div>
  );
}

export default function MatchDetailModal({ tie, onClose }: Props) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const { leg1, leg2, aggHome, aggAway, winner } = tie;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Panel */}
      <div
        className="relative bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-slate-500 hover:text-white transition-colors text-lg leading-none"
        >
          ×
        </button>

        {/* Aggregate score for two-legged ties */}
        {leg2 && aggHome !== null && (
          <div className="text-center mb-4">
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Aggregate</div>
            <div className="text-3xl font-bold text-white tabular-nums">
              {aggHome} – {aggAway}
            </div>
            {winner && (
              <div className="text-xs text-slate-400 mt-1">
                {winner === "home"
                  ? `${leg1.homeTeam.shortName || leg1.homeTeam.name} advance`
                  : `${leg1.awayTeam.shortName || leg1.awayTeam.name} advance`}
              </div>
            )}
          </div>
        )}

        {/* Leg details */}
        {leg2 ? (
          <>
            <LegDetail match={leg1} label="Leg 1" />
            <div className="border-t border-slate-800 my-4" />
            <LegDetail match={leg2} label="Leg 2" />
          </>
        ) : (
          <LegDetail match={leg1} />
        )}
      </div>
    </div>
  );
}

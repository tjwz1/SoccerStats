import type { BracketData, BracketTie, BracketMatchData } from "../types";
import { useApi } from "../hooks/useApi";

interface Props {
  compCode: string;
  season: number | null;
}

function fmt(utcDate: string) {
  return new Date(utcDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function TeamRow({
  team,
  isWinner,
  score,
}: {
  team: { name: string; shortName: string; crest: string };
  isWinner: boolean;
  score: number | null;
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
          isWinner ? "text-white font-semibold" : "text-slate-400"
        }`}
      >
        {team.shortName || team.name}
      </span>
      <span
        className={`tabular-nums text-xs font-bold w-4 text-right shrink-0 ${
          score !== null
            ? isWinner
              ? "text-white"
              : "text-slate-500"
            : "text-slate-700"
        }`}
      >
        {score !== null ? score : "–"}
      </span>
    </div>
  );
}

function SingleLegCard({
  match,
  winner,
}: {
  match: BracketMatchData;
  winner: "home" | "away" | null;
}) {
  const done = match.status === "FINISHED";
  return (
    <div className="px-2.5 py-2">
      <TeamRow
        team={match.homeTeam}
        isWinner={done && winner === "home"}
        score={done ? match.scoreHome : null}
      />
      <TeamRow
        team={match.awayTeam}
        isWinner={done && winner === "away"}
        score={done ? match.scoreAway : null}
      />
      {!done && (
        <p className="text-[10px] text-slate-600 text-center mt-1">{fmt(match.utcDate)}</p>
      )}
      {match.penScoreHome !== null && (
        <p className="text-[10px] text-slate-600 text-center">
          Pens {match.penScoreHome}–{match.penScoreAway}
        </p>
      )}
      {match.etScoreHome !== null && match.penScoreHome === null && (
        <p className="text-[10px] text-slate-600 text-center">
          AET {match.etScoreHome}–{match.etScoreAway}
        </p>
      )}
    </div>
  );
}

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

function TieCard({ tie }: { tie: BracketTie }) {
  const isLive = (["IN_PLAY", "PAUSED"] as string[]).some(
    (s) => tie.leg1.status === s || tie.leg2?.status === s
  );
  return (
    <div
      className={`bg-slate-900/70 border rounded-lg overflow-hidden ${
        isLive ? "border-red-500/50" : "border-slate-800"
      }`}
    >
      {tie.leg2 ? (
        <TwoLeggedCard tie={tie} />
      ) : (
        <SingleLegCard match={tie.leg1} winner={tie.winner} />
      )}
    </div>
  );
}

export default function BracketView({ compCode, season }: Props) {
  const url = `/api/competitions/${compCode}/bracket${season ? `?season=${season}` : ""}`;
  const { data, loading, error } = useApi<BracketData>(url);

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
        Knockout bracket not yet available for this competition.
      </p>
    );
  }

  const rounds = data.rounds;

  // Proportional slot heights: every column shares the same total height.
  // A round with N ties gets totalH / N px per slot so ties visually
  // "double in size" as you advance through the bracket.
  const maxTies = Math.max(...rounds.map((r) => r.ties.length));
  const twoLegged = rounds.some((r) => r.ties.some((t) => t.leg2 !== null));
  // Min px needed for a single tie card (two-legged cards are taller)
  const SLOT_PX = twoLegged ? 108 : 82;
  const totalH = maxTies * SLOT_PX;

  return (
    <div className="overflow-x-auto pb-4">
      <div className="flex gap-2 min-w-max">
        {rounds.map((round) => {
          const slotH = totalH / round.ties.length;
          return (
            <div key={round.stage} className="flex-none w-48">
              {/* Round header */}
              <div className="text-center mb-3">
                <span className="inline-block px-3 py-1 rounded-md bg-slate-800 border border-slate-700 text-[11px] font-bold text-slate-300 uppercase tracking-wider whitespace-nowrap">
                  {round.name}
                </span>
                <div className="text-[10px] text-slate-600 mt-1">
                  {round.ties.length} {round.ties.length === 1 ? "match" : "ties"}
                </div>
              </div>

              {/* Ties: each in a proportionally-sized slot, card centred */}
              <div style={{ height: totalH }}>
                {round.ties.map((tie) => (
                  <div
                    key={`${tie.leg1.id}-${tie.leg2?.id ?? "s"}`}
                    style={{ height: slotH }}
                    className="flex items-center px-1"
                  >
                    <div className="w-full">
                      <TieCard tie={tie} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

import type { Player } from "../types";
import { layoutFromLineup, layoutFromLineupFlipped } from "../utils/pitchLayout";
import PlayerMarker from "./PlayerMarker";

interface Props {
  starters: Player[];
  formation: string;
  opponent?: { starters: Player[]; formation: string };
  subbedOutNames?: Set<string>;
  onHover: (player: Player | null, x: number, y: number) => void;
  onClick: (player: Player) => void;
  compact?: boolean;
}

// Mirror of subNameTokens in TeamSchedule — diacritics stripped, hyphens as spaces,
// all meaningful tokens (>2 chars) returned so any shared token counts as a match.
function nameTokens(name: string): string[] {
  return name
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/-/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function isSubbedOut(name: string, subbedOutNames: Set<string>): boolean {
  return nameTokens(name).some((t) => subbedOutNames.has(t));
}

export default function Pitch({ starters, formation, opponent, subbedOutNames, onHover, onClick, compact = false }: Props) {
  const positions = layoutFromLineup(starters, formation, !!opponent);
  const opponentPositions = opponent
    ? layoutFromLineupFlipped(opponent.starters, opponent.formation)
    : [];

  return (
    <div className="relative w-full" style={{ aspectRatio: "2/3" }}>
      <svg
        viewBox="0 0 100 150"
        className="absolute inset-0 w-full h-full"
        preserveAspectRatio="none"
      >
        {Array.from({ length: 10 }).map((_, i) => (
          <rect key={i} x="0" y={i * 15} width="100" height="15" fill={i % 2 === 0 ? "#166534" : "#15803d"} />
        ))}
        <rect x="2" y="2" width="96" height="146" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="0.8" />
        <line x1="2" y1="75" x2="98" y2="75" stroke="rgba(255,255,255,0.6)" strokeWidth="0.6" />
        <circle cx="50" cy="75" r="12" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="0.6" />
        <circle cx="50" cy="75" r="0.8" fill="rgba(255,255,255,0.6)" />
        <rect x="22" y="2" width="56" height="22" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="0.6" />
        <rect x="22" y="126" width="56" height="22" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="0.6" />
        <rect x="34" y="2" width="32" height="8" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="0.6" />
        <rect x="34" y="140" width="32" height="8" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="0.6" />
        <circle cx="50" cy="18" r="0.8" fill="rgba(255,255,255,0.6)" />
        <circle cx="50" cy="132" r="0.8" fill="rgba(255,255,255,0.6)" />
        <path d="M 2 8 A 6 6 0 0 0 8 2" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="0.6" />
        <path d="M 98 8 A 6 6 0 0 1 92 2" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="0.6" />
        <path d="M 2 142 A 6 6 0 0 1 8 148" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="0.6" />
        <path d="M 98 142 A 6 6 0 0 0 92 148" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="0.6" />
      </svg>

      {/* Opponent (top half, flipped formation) */}
      {opponentPositions.map(({ player, pos }, idx) => (
        <PlayerMarker
          key={`opp-${idx}-${player.name}`}
          player={player}
          x={pos.x}
          y={pos.y}
          size={compact ? "small" : "normal"}
          subbedOut={subbedOutNames ? isSubbedOut(player.name, subbedOutNames) : false}
          onHover={onHover}
          onClick={onClick}
        />
      ))}

      {/* Viewed team (bottom half) */}
      {positions.map(({ player, pos }, idx) => (
        <PlayerMarker
          key={player.id !== 0 ? player.id : `own-${idx}-${player.name}`}
          player={player}
          x={pos.x}
          y={pos.y}
          size={compact ? "small" : "normal"}
          subbedOut={subbedOutNames ? isSubbedOut(player.name, subbedOutNames) : false}
          onHover={onHover}
          onClick={onClick}
        />
      ))}
    </div>
  );
}

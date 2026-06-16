import type { Player, PitchPosition } from "../types";

// X bias per role within their line (0=leftmost, 100=rightmost)
const ROLE_X_BIAS: Record<string, number> = {
  LB: 0, LW: 0,
  CB: 0.5, DM: 0.5, CM: 0.5, AM: 0.5, GK: 0.5,
  RB: 1, RW: 1,
  CF: 0.5,
};

// Position order for sorting starters into formation lines
const POS_ORDER: Record<string, number> = {
  Goalkeeper: 0, Defender: 1, Midfielder: 2, Attacker: 3,
};

// Sort starters so GK is first, then Defenders, Midfielders, Attackers.
// ESPN (and some other sources) return players in jersey/formation-place order
// rather than position order, so we must sort before slicing into formation lines.
function sortForLayout(starters: Player[]): Player[] {
  const gks = starters.filter((p) => p.position === "Goalkeeper");
  const rest = starters
    .filter((p) => p.position !== "Goalkeeper")
    .sort((a, b) => (POS_ORDER[a.position] ?? 2) - (POS_ORDER[b.position] ?? 2));
  return [...gks, ...rest];
}

function linesToY(lines: number[], bottomHalfOnly: boolean): number[] {
  // Two-team view: stay in bottom half (y=55–76); single-team: spread full pitch (y=16–76).
  const yBack = 76;
  const yFront = bottomHalfOnly ? 55 : 16;
  return lines.map((_, i) =>
    lines.length === 1 ? yBack : yBack - (i * (yBack - yFront)) / (lines.length - 1)
  );
}

function xForIndex(idx: number, total: number, _bias: number): number {
  if (total === 1) return 50;
  const margin = Math.max(8, 38 - total * 5);
  const span = 100 - 2 * margin;
  return margin + (span / (total - 1)) * idx;
}

// Opponent team layout: GK at top (y=12), lines progress downward toward center
export function layoutFromLineupFlipped(
  starters: Player[],
  formationStr: string
): Array<{ player: Player; pos: PitchPosition }> {
  if (!starters.length) return [];

  const ordered = sortForLayout(starters);

  // GK is near the top goal
  const result: Array<{ player: Player; pos: PitchPosition }> = [
    { player: ordered[0], pos: { x: 50, y: 10 } },
  ];

  const lineCounts = formationStr.split("-").map(Number).filter((n) => !isNaN(n) && n > 0);
  if (!lineCounts.length) return result;

  // All opponent outfield players stay in the top half (y < 50%).
  // Back line (defenders) at y=24, front line (forwards) at y=45.
  const yTop = 24;
  const yBot = 45;
  const lineYs = lineCounts.map((_, i) =>
    lineCounts.length === 1
      ? yTop
      : yTop + (i * (yBot - yTop)) / (lineCounts.length - 1)
  );

  let playerIdx = 1;
  lineCounts.forEach((count, lineIdx) => {
    const y = lineYs[lineIdx];
    const linePlayers = ordered.slice(playerIdx, playerIdx + count);
    playerIdx += count;

    const sorted = [...linePlayers].sort((a, b) => {
      const ba = ROLE_X_BIAS[a.role ?? "CM"] ?? 0.5;
      const bb = ROLE_X_BIAS[b.role ?? "CM"] ?? 0.5;
      return ba - bb;
    });

    sorted.forEach((player, i) => {
      result.push({
        player,
        pos: { x: xForIndex(i, count, ROLE_X_BIAS[player.role ?? "CM"] ?? 0.5), y },
      });
    });
  });

  return result;
}

export function layoutFromLineup(
  starters: Player[],
  formationStr: string,
  bottomHalfOnly: boolean = false
): Array<{ player: Player; pos: PitchPosition }> {
  if (!starters.length) return [];

  const ordered = sortForLayout(starters);

  // GK near the bottom goal. Slightly higher (88) in single-team view to look centred.
  const result: Array<{ player: Player; pos: PitchPosition }> = [
    { player: ordered[0], pos: { x: 50, y: bottomHalfOnly ? 90 : 88 } },
  ];

  const lineCounts = formationStr.split("-").map(Number).filter((n) => !isNaN(n) && n > 0);
  const lineYs = linesToY(lineCounts, bottomHalfOnly);

  let playerIdx = 1;
  lineCounts.forEach((count, lineIdx) => {
    const y = lineYs[lineIdx];
    const linePlayers = ordered.slice(playerIdx, playerIdx + count);
    playerIdx += count;

    const sorted = [...linePlayers].sort((a, b) => {
      const ba = ROLE_X_BIAS[a.role ?? "CM"] ?? 0.5;
      const bb = ROLE_X_BIAS[b.role ?? "CM"] ?? 0.5;
      return ba - bb;
    });

    sorted.forEach((player, i) => {
      result.push({ player, pos: { x: xForIndex(i, count, ROLE_X_BIAS[player.role ?? "CM"] ?? 0.5), y } });
    });
  });

  return result;
}

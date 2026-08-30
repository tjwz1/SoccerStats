/**
 * Cross-team squad-overlap scan.
 *
 * Verification tool for the squad-reconciliation fix in services/footballApi.ts
 * (getTeamLineup): fetches every club team's lineup across every club competition and
 * flags any player who shows up on more than one team at once — the exact "Ferran Torres
 * on both Barcelona and PSG" bug. International competitions (WC/EC) are skipped — a
 * player legitimately appears on both his club and his country's squad.
 *
 * Duplicate detection uses EXACT normalized-name equality, not the fuzzy playerNamesMatch
 * heuristic from production. That heuristic (last name >=4 chars equal, or any shared token
 * >=5 chars) is deliberately loose because it's only ever applied *within one team* in
 * production (matching fd.org's squad against that same team's TM page) — collisions there
 * are rare and low-stakes. Applied globally across ~1600 players spanning three leagues here,
 * it produces massive false-positive clustering (e.g. two unrelated players who both happen
 * to be named "Bruno" get merged). A transferred player shows up under the *same* displayed
 * name string on both squads (fd.org's name on the old club, the identical TM-scraped name
 * on the new one), so exact match after normalization is the correct check for this script.
 *
 * Also reports each scanned team's squad size, flagged if implausibly small (<15) — a
 * sign the TM reconciliation's sanity floor (MIN_TM_SQUAD_FOR_FILTER) mis-fired and
 * over-filtered a real squad down.
 *
 * Usage (from server/):
 *   npx ts-node --project scripts/tsconfig.json --transpile-only scripts/check-squad-overlaps.ts
 *
 * Scope to specific competitions (recommended for a quick check — the full scan across
 * every club competition can take a long time on the free tier's 10 req/min ceiling):
 *   npx ts-node --project scripts/tsconfig.json --transpile-only scripts/check-squad-overlaps.ts PD FL1 PL
 */
import { config } from "dotenv";
import path from "path";
config({ path: path.resolve(__dirname, "../.env") });

import { getCompetitions, getTeams, getTeamLineup, isInternationalComp } from "../src/services/footballApi";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Same matcher as footballApi.ts's squad reconciliation — duplicated here (not imported)
// so this script keeps working as a standalone check even if that logic changes shape.
function normPlayerName(n: string): string {
  return n.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, "").trim().replace(/\s+/g, " ");
}
function playerNamesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const aT = a.split(" "), bT = b.split(" ");
  const aLast = aT[aT.length - 1], bLast = bT[bT.length - 1];
  if (aLast.length >= 4 && aLast === bLast) return true;
  for (const tok of aT) if (tok.length >= 5 && bT.includes(tok)) return true;
  return false;
}

interface Sighting {
  name: string;
  norm: string;
  teamId: number;
  team: string;
  compCode: string;
}

async function main() {
  const requested = process.argv.slice(2).map((c) => c.toUpperCase());
  const allComps = await getCompetitions();
  const clubComps = allComps.filter(
    (c) => !isInternationalComp(c.code) && (requested.length === 0 || requested.includes(c.code))
  );

  console.log(`Scanning ${clubComps.length} club competition(s): ${clubComps.map((c) => c.code).join(", ")}\n`);

  const sightings: Sighting[] = [];
  const smallSquads: Array<{ team: string; compCode: string; size: number }> = [];
  let teamsScanned = 0;

  for (const comp of clubComps) {
    let teams: Array<{ id: number; name: string }>;
    try {
      teams = await getTeams(comp.code);
    } catch (e) {
      console.warn(`[${comp.code}] getTeams failed: ${(e as Error).message}`);
      continue;
    }

    for (const team of teams) {
      try {
        const lineup = await getTeamLineup(String(team.id), comp.code) as any;
        const players = [...lineup.starters, ...lineup.bench] as Array<{ id: number; name: string }>;
        for (const p of players) {
          sightings.push({ name: p.name, norm: normPlayerName(p.name), teamId: team.id, team: team.name, compCode: comp.code });
        }
        if (players.length < 15) smallSquads.push({ team: team.name, compCode: comp.code, size: players.length });
        teamsScanned++;
      } catch (e) {
        console.warn(`[${comp.code}] lineup fetch failed for ${team.name}: ${(e as Error).message}`);
      }
      // Stay well under fd.org's 10 req/min free-tier ceiling — each lineup call itself
      // fans out into several sub-requests (scorers, TM, photos).
      await sleep(300);
    }
    console.log(`[${comp.code}] scanned ${teams.length} teams`);
  }

  // Group by EXACT normalized name (see header comment for why not the fuzzy matcher),
  // deduping repeat sightings on the same team first (a player can legitimately appear
  // once from fd.org's squad and again as a near-duplicate TM supplement entry).
  const byNorm = new Map<string, Sighting[]>();
  for (const s of sightings) {
    if (!byNorm.has(s.norm)) byNorm.set(s.norm, []);
    byNorm.get(s.norm)!.push(s);
  }
  const duplicates = [...byNorm.values()]
    .map((entries) => {
      const byTeam = new Map<number, Sighting>();
      for (const e of entries) if (!byTeam.has(e.teamId)) byTeam.set(e.teamId, e);
      return [...byTeam.values()];
    })
    .filter((entries) => entries.length > 1);

  console.log(`\n=== Scanned ${teamsScanned} teams across ${clubComps.length} competition(s), ${sightings.length} player sightings ===`);
  console.log(`=== ${duplicates.length} player(s) found on more than one team (exact name match) ===`);
  for (const d of duplicates) {
    console.log(`- ${d[0].name}: ${d.map((e) => `${e.name} @ ${e.team} (${e.compCode})`).join(" & ")}`);
  }
  if (duplicates.length === 0) console.log("None — every scanned player appears on exactly one club squad.");

  // Secondary, informational-only pass using production's actual fuzzy matcher, restricted
  // to pairs sharing a competition (closer to how a human would spot the bug) — flagged
  // separately since this heuristic is known to produce false positives at this scale.
  const fuzzyExtra: Array<[Sighting, Sighting]> = [];
  const exactDupKeys = new Set(duplicates.map((d) => d[0].norm ?? normPlayerName(d[0].name)));
  for (let i = 0; i < sightings.length; i++) {
    for (let j = i + 1; j < sightings.length; j++) {
      const a = sightings[i], b = sightings[j];
      if (a.teamId === b.teamId || a.norm === b.norm) continue;
      if (exactDupKeys.has(a.norm) || exactDupKeys.has(b.norm)) continue;
      if (playerNamesMatch(a.norm, b.norm)) fuzzyExtra.push([a, b]);
    }
  }
  console.log(`\n=== ${fuzzyExtra.length} additional fuzzy-only near-match pair(s) (informational, likely mostly false positives — different people sharing a name token) ===`);
  for (const [a, b] of fuzzyExtra.slice(0, 20)) {
    console.log(`- "${a.name}" @ ${a.team} (${a.compCode})  ~  "${b.name}" @ ${b.team} (${b.compCode})`);
  }
  if (fuzzyExtra.length > 20) console.log(`  ...and ${fuzzyExtra.length - 20} more`);

  console.log(`\n=== ${smallSquads.length} team(s) with an implausibly small squad (<15) ===`);
  for (const s of smallSquads) console.log(`- ${s.team} (${s.compCode}): ${s.size} players`);
  if (smallSquads.length === 0) console.log("None — no sign of over-aggressive TM-reconciliation filtering.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

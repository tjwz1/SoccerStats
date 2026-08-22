import { exec } from "child_process";
import { promisify } from "util";
import { getCached, setCached } from "../db/apiCache";
import type { WikiCareerRow } from "../db/wikiCareerCache";

const execAsync = promisify(exec);
const SS_BASE = "https://www.sofascore.com";
const SS_ID_TTL_MS   = 30 * 24 * 60 * 60 * 1000; // 30 days — player IDs are stable
const SS_CAREER_TTL_MS = 24 * 60 * 60 * 1000;     // 24h — refresh daily for current-season rows

function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/ø/g, "o").replace(/ð/g, "d").replace(/þ/g, "th").replace(/ł/g, "l")
    .replace(/ß/g, "ss").replace(/æ/g, "ae").replace(/œ/g, "oe")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function ssFetch<T>(path: string): Promise<T | null> {
  try {
    const { stdout } = await execAsync(
      `curl -sf --max-time 12 -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36" -H "Referer: https://www.sofascore.com/" "${SS_BASE}${path}"`,
      { timeout: 15000 }
    );
    if (!stdout) return null;
    return JSON.parse(stdout) as T;
  } catch (e) {
    console.warn(`[ssCareer] Fetch error: ${(e as Error).message}`);
    return null;
  }
}

async function findSsPlayerId(playerName: string, fdoId: number): Promise<number | null> {
  const cacheKey = `/ss-player-id/${fdoId}`;
  const cached = await getCached(cacheKey);
  if (cached !== null) return (cached as { ssId: number }).ssId ?? null;

  const data = await ssFetch<any>(`/api/v1/search/all?q=${encodeURIComponent(playerName)}&page=0`);
  if (!data) return null;

  const players: any[] = (data.results ?? []).filter((r: any) => r.type === "player");
  const target = normName(playerName);
  const match =
    players.find((r: any) => normName(r.entity?.name ?? "") === target) ??
    players.find((r: any) => normName(r.entity?.shortName ?? "") === target) ??
    players[0];

  const ssId: number | null = match?.entity?.id ?? null;
  await setCached(cacheKey, { ssId }, SS_ID_TTL_MS);
  return ssId;
}

// Normalize a SofaScore season year string to "YYYY/YY" for club seasons, or leave
// plain "YYYY" for single-year international tournaments (World Cup, Euros, qualifiers).
function normSsYear(y: string): string {
  // "25/26" → "2025/26"
  if (/^\d{2}\/\d{2}$/.test(y)) {
    const [a, b] = y.split("/");
    return `20${a}/${b}`;
  }
  // "2024/25" or "2024/2025" already fine
  if (/^\d{4}\/\d{4}$/.test(y)) {
    const [y1, y2] = y.split("/");
    return `${y1}/${y2.slice(2)}`;
  }
  return y;
}

interface SsSeasonPair {
  tournamentId: number;
  tournamentName: string;
  seasonId: number;
  seasonYear: string;
}

// The player-level /statistics endpoint only returns a recent-season summary — it silently
// truncates deep career history (e.g. it's missing a 20-year veteran's first decade entirely).
// The full per-(tournament, season) list is only available via /statistics/seasons, which we
// then have to fan out to individually since SofaScore has no bulk "full career" endpoint.
async function fetchSsSeasonPairs(ssId: number): Promise<SsSeasonPair[]> {
  const data = await ssFetch<any>(`/api/v1/player/${ssId}/statistics/seasons`);
  const groups: any[] = data?.uniqueTournamentSeasons ?? [];
  const pairs: SsSeasonPair[] = [];
  for (const g of groups) {
    const tournamentId = g.uniqueTournament?.id;
    const tournamentName = g.uniqueTournament?.name ?? "";
    if (!tournamentId) continue;
    for (const s of g.seasons ?? []) {
      if (!s?.id || !s?.year) continue;
      pairs.push({ tournamentId, tournamentName, seasonId: s.id, seasonYear: s.year });
    }
  }
  return pairs;
}

export async function fetchSofaScoreCareer(
  playerName: string,
  fdoId: number
): Promise<WikiCareerRow[]> {
  const cacheKey = `/ss-career/${fdoId}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached as WikiCareerRow[];

  const ssId = await findSsPlayerId(playerName, fdoId);
  if (!ssId) {
    console.log(`[ssCareer] No SofaScore ID found for "${playerName}"`);
    return [];
  }

  const pairs = await fetchSsSeasonPairs(ssId);
  if (pairs.length === 0) {
    console.log(`[ssCareer] No career stats from SofaScore for "${playerName}" (ss=${ssId})`);
    return [];
  }

  const seasonStats = await Promise.all(
    pairs.map((p) =>
      ssFetch<any>(`/api/v1/player/${ssId}/unique-tournament/${p.tournamentId}/season/${p.seasonId}/statistics/overall`)
        .then((data) => (data ? { pair: p, data } : null))
        .catch(() => null)
    )
  );

  const rows: WikiCareerRow[] = seasonStats
    .filter((r): r is { pair: SsSeasonPair; data: any } => !!r && (r.data.statistics?.appearances ?? 0) > 0)
    .map(({ pair, data }) => ({
      season: normSsYear(pair.seasonYear),
      team: data.team?.name ?? "",
      league: pair.tournamentName,
      appearances: data.statistics.appearances ?? 0,
      goals: data.statistics.goals ?? 0,
      assists: data.statistics.assists ?? 0,
    }))
    .filter((r) => r.season && r.team);

  console.log(`[ssCareer] "${playerName}" → ${rows.length} career rows from SofaScore (ss=${ssId}, ${pairs.length} tournament/season pairs probed)`);
  if (rows.length > 0) setCached(cacheKey, rows, SS_CAREER_TTL_MS).catch(() => {});
  return rows;
}

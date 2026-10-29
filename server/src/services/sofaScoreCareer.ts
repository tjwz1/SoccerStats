import { exec } from "child_process";
import { promisify } from "util";
import { waitUntil } from "@vercel/functions";
import { getCached, setCached } from "../db/apiCache";
import type { WikiCareerRow } from "../db/wikiCareerCache";
import { getIdentityMode, resolvePlayerIdentity, scoreAndStore } from "./identity/resolver";
import type { CandidateAnchor } from "./identity/nameMatch";

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

// Each curl call is a separate OS process. A single player's full career can be 70-80+
// (tournament, season) pairs. At 5 concurrency that takes up to 96s (12 rounds × 8s/pair),
// exceeding Vercel's function timeout and leaving SofaScore scrapes incomplete. Raising to 15
// brings the worst case to ~32s (5-6 rounds) — well under the 60s serverless limit — while
// keeping total simultaneous curl processes bounded at ~15 (acceptable for the host OS).
const SS_FETCH_CONCURRENCY = 15;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Last time a block signal was seen, so the bulk admin refresh job can detect an
// active block and stop early. Does not change live single-player fetch behavior —
// those keep retrying every time, same as before.
let ssLastBlockedAt = 0;
export function getSsLastBlockedAt(): number {
  return ssLastBlockedAt;
}

async function ssFetch<T>(path: string): Promise<T | null> {
  try {
    // No User-Agent: a spoofed browser UA (previously a hardcoded "Chrome/136..."
    // string) is what SofaScore's bot detection actually flags — confirmed directly
    // against the live API, varying one header at a time. A bare request, or one with
    // only Referer, passes every time; adding the fake-Chrome UA back reproduces the
    // block instantly, on any network, via curl or node-fetch alike. Keep Referer
    // (harmless) but never re-add a spoofed User-Agent here.
    //
    // No -f: the challenge response is HTTP 403 with a small JSON body
    // ({"error":{"code":403,"reason":"challenge"}}), not an empty one — -f would
    // discard that body on any HTTP error, making a block indistinguishable from
    // every other curl failure.
    const { stdout } = await execAsync(
      `curl -s --max-time 12 -H "Referer: https://www.sofascore.com/" "${SS_BASE}${path}"`,
      { timeout: 15000 }
    );
    if (!stdout) return null;
    const parsed = JSON.parse(stdout);
    if (parsed?.error?.code === 403) {
      ssLastBlockedAt = Date.now();
      console.warn(`[ssCareer] Blocked (403 ${parsed.error.reason ?? "?"}) for ${path}`);
      return null;
    }
    return parsed as T;
  } catch (e) {
    console.warn(`[ssCareer] Fetch error: ${(e as Error).message}`);
    return null;
  }
}

// Phase B (identity layer, shadow mode only): scores every search candidate through the
// identity layer and logs/stores the result, but never changes what this function returns
// — `legacyPick` stays the source of truth this phase. A no-op (not even called) when
// IDENTITY_MODE is "off" or no anchor was supplied, so every existing caller that doesn't
// pass one is completely unaffected.
async function shadowMatchSofaScore(
  fdoId: number,
  anchor: CandidateAnchor,
  players: any[],
  legacyPick: any
): Promise<void> {
  const candidates = players
    .filter((r) => r.entity?.id)
    .map((r) => ({
      externalId: String(r.entity.id),
      name: r.entity.name ?? r.entity.shortName ?? "",
      club: r.entity.team?.name ?? null,
    }));
  const internalId = await resolvePlayerIdentity(anchor, "fdorg", String(fdoId));
  const result = await scoreAndStore(internalId, anchor, "sofascore", candidates, fdoId);
  const legacyPickId = legacyPick?.entity?.id != null ? String(legacyPick.entity.id) : "none";
  const resolverPickId = result.bestCandidate?.externalId ?? "none";
  console.log(
    `[identity] source=sofascore fdId=${fdoId} name="${anchor.name}" legacyPick=${legacyPickId} ` +
    `resolverPick=${resolverPickId} agree=${legacyPickId === resolverPickId} ` +
    `confidence=${result.confidence.toFixed(2)} verdict=${result.verdict} candidates=${candidates.length}`
  );
}

async function findSsPlayerId(playerName: string, fdoId: number, anchor?: CandidateAnchor): Promise<number | null> {
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

  if (getIdentityMode() !== "off" && anchor) {
    waitUntil(
      shadowMatchSofaScore(fdoId, anchor, players, match).catch((e) =>
        console.warn(`[identity] sofascore shadow error for fdId=${fdoId}: ${(e as Error).message}`)
      )
    );
  }

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
  fdoId: number,
  anchor?: CandidateAnchor
): Promise<WikiCareerRow[]> {
  const cacheKey = `/ss-career/${fdoId}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached as WikiCareerRow[];

  const ssId = await findSsPlayerId(playerName, fdoId, anchor);
  if (!ssId) {
    console.log(`[ssCareer] No SofaScore ID found for "${playerName}"`);
    return [];
  }

  const pairs = await fetchSsSeasonPairs(ssId);
  if (pairs.length === 0) {
    console.log(`[ssCareer] No career stats from SofaScore for "${playerName}" (ss=${ssId})`);
    return [];
  }

  const seasonStats = await mapWithConcurrency(pairs, SS_FETCH_CONCURRENCY, (p) =>
    ssFetch<any>(`/api/v1/player/${ssId}/unique-tournament/${p.tournamentId}/season/${p.seasonId}/statistics/overall`)
      .then((data) => (data ? { pair: p, data } : null))
      .catch(() => null)
  );

  // If SofaScore rate-limited us mid-fetch, grade by success rate rather than discarding all
  // progress. A partial result is still better than nothing, but we cache it briefly (1h) so
  // the stale-detection and needsSofaRefresh logic re-trigger a full retry soon.
  const successCount = seasonStats.filter((r) => r !== null).length;
  const successRate = pairs.length > 0 ? successCount / pairs.length : 1;
  // Below 50%: too few results — treat as a complete failure and don't cache anything.
  // 50–75%: partial results are better than nothing; cache with a 1-hour TTL so the
  // stale-detection logic re-triggers SofaScore after the short window expires.
  if (pairs.length >= 3 && successRate < 0.5) {
    console.warn(`[ssCareer] "${playerName}" → only ${successCount}/${pairs.length} season fetches succeeded (ss=${ssId}); too few to cache`);
    return [];
  }
  const isPartial = pairs.length >= 3 && successRate < 0.75;

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

  const cacheTtl = isPartial ? 60 * 60 * 1000 : SS_CAREER_TTL_MS;
  if (isPartial) console.warn(`[ssCareer] "${playerName}" → partial: ${successCount}/${pairs.length} succeeded, caching with 1h TTL (ss=${ssId})`);
  else console.log(`[ssCareer] "${playerName}" → ${rows.length} career rows from SofaScore (ss=${ssId}, ${pairs.length} tournament/season pairs probed)`);
  if (rows.length > 0) setCached(cacheKey, rows, cacheTtl).catch(() => {});
  return rows;
}

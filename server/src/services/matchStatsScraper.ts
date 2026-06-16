import { safeFetch as fetch } from "../utils/httpClient";
import { getCached, setCached, FOREVER_TTL_MS } from "../db/apiCache";

// ESPN public sports API — no auth required, returns per-player match stats
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// Map football-data.org competition codes (and cup slugs) to ESPN league slugs
const COMP_MAP: Record<string, string> = {
  PL: "eng.1",
  CL: "uefa.champions",
  EL: "uefa.europa",
  ECL: "uefa.europa.conference",
  UECL: "uefa.europa.conference",
  BL1: "ger.1",
  SA: "ita.1",
  PD: "esp.1",
  FL1: "fra.1",
  DED: "ned.1",
  PPL: "por.1",
  // International tournaments
  EC: "uefa.euro",
  WC: "fifa.world",
  // Domestic cups (ESPN cup slugs are their own keys)
  "esp.copa_del_rey": "esp.copa_del_rey",
  "ger.dfb_pokal":    "ger.dfb_pokal",
  "ita.coppa_italia": "ita.coppa_italia",
  "ned.cup":          "ned.cup",
};

const ESPN_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  Accept: "application/json, */*",
};

// Headers that mimic a real browser — required for Google and news sites
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
};

export interface PlayerGameStats {
  minutesPlayed: number;  // 0 if not tracked; use starter/sub status instead
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  shots: number;
  shotsOnTarget: number;
  rating: number | null;
  starter: boolean;
  subbedIn: boolean;
  subbedOut: boolean;
}

// Keyed by lowercase last name for fuzzy matching
export type MatchPlayerStatsMap = Record<string, PlayerGameStats>;

// In-memory cache by football-data.org match ID
const statsCache = new Map<number, { data: MatchPlayerStatsMap; fetchedAt: number }>();
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const STATS_CACHE_MAX = 500;

// Cache ESPN event ID lookups — stable once a match is played
const eventIdCache = new Map<string, string>();  // only caches successful lookups (non-null)
const EVENT_ID_CACHE_MAX = 1000;
// Short-term null cache: records when a lookup returned no result so we don't hammer
// ESPN on every request when the event doesn't exist (yet). Retried after 10 minutes.
const eventIdNullCache = new Map<string, number>(); // cacheKey → timestamp
const NULL_RETRY_MS = 10 * 60 * 1000;
// Deduplicates concurrent lookups for the same event so parallel route handlers
// (actual-lineup + player-stats) share one scoreboard request instead of two.
const eventIdInflight = new Map<string, Promise<string | null>>();

// In-memory cache for ESPN goal events (keyed by football-data.org match ID)
const goalsCache = new Map<number, { data: EspnGoalEvent[]; fetchedAt: number }>();
const GOALS_CACHE_MAX = 500;

// Shared cache for ESPN summary responses — both lineup and stats parse the same
// summary endpoint; this prevents a second HTTP call when both routes fire together.
// 1-minute TTL so live match data (goals, subs, cards) refreshes on each polling cycle.
const summaryCache = new Map<string, { data: any; fetchedAt: number }>();
const SUMMARY_TTL_MS = 60_000;
const SUMMARY_CACHE_MAX = 300;

function cappedSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number) {
  if (map.size >= maxSize && !map.has(key)) {
    map.delete(map.keys().next().value!);
  }
  map.set(key, value);
}

async function espnFetch(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: ESPN_HEADERS,
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      console.warn(`[matchStats] ESPN ${res.status}: ${url}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`[matchStats] Fetch error: ${(e as Error).message}`);
    return null;
  }
}

// Aliases for international team names that differ between fd.org and ESPN.
// Applied after basic normalisation so both sides resolve to the same token.
const INT_ALIASES: [RegExp, string][] = [
  [/\bunited states\b/g, "usa"],
  [/\bkorea republic\b/g, "korea"],
  [/\brepublic of korea\b/g, "korea"],
  [/\bsouth korea\b/g, "korea"],
  [/\bdpr korea\b/g, "northkorea"],
  [/\bnorth korea\b/g, "northkorea"],
  [/\bcote d ivoire\b/g, "ivoire"],
  [/\bivory coast\b/g, "ivoire"],
  [/\bdr congo\b/g, "congo"],
  [/\bdemocratic republic of congo\b/g, "congo"],
  // fd.org uses "Türkiye" (official since 2022); ESPN English uses "Turkey"
  [/\bturkiye\b/g, "turkey"],
  // Czech Republic / Czechia — fd.org and ESPN may differ on which form to use
  [/\bczechia\b/g, "czech"],
  [/\bczech republic\b/g, "czech"],
];

// Normalize team name for fuzzy comparison.
// NFD decomposition strips diacritics (ü→u, é→e, á→a) before the ASCII filter so that
// names like "Türkiye", "México", "Panamá", "Perú", "Curaçao" survive normalisation
// with recognisable tokens rather than being mangled into non-matching fragments.
function normTeam(name: string): string {
  let n = name
    .normalize("NFD").replace(/[̀-ͯ]/g, "")  // strip combining diacritics
    .toLowerCase()
    .replace(/\b(fc|f\.c\.|afc|sc|sfc|cf|rcd|cd|ud|sd)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [pattern, alias] of INT_ALIASES) n = n.replace(pattern, alias);
  return n;
}

export function teamsMatch(fdTeam: string, espnTeam: string): boolean {
  const fdWords = normTeam(fdTeam).split(" ").filter((w) => w.length >= 3);
  const espnNorm = normTeam(espnTeam);
  return fdWords.length > 0 && fdWords.some((w) => espnNorm.includes(w));
}

function shiftDay(yyyymmdd: string, delta: number): string {
  const d = new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function addDay(yyyymmdd: string): string { return shiftDay(yyyymmdd, 1); }

function lastName(name: string): string {
  return name.toLowerCase().replace(/\./g, "").trim().split(" ").pop() ?? "";
}

function statVal(stats: any[], name: string): number {
  return stats.find((s: any) => s.name === name)?.value ?? 0;
}

// Find the ESPN event ID matching the football-data.org match
async function findEspnEventId(
  homeTeam: string,
  awayTeam: string,
  utcDate: string,
  competitionCode: string
): Promise<string | null> {
  const cacheKey = `${competitionCode}:${utcDate.slice(0, 10)}:${normTeam(homeTeam)}:${normTeam(awayTeam)}`;
  if (eventIdCache.has(cacheKey)) return eventIdCache.get(cacheKey)!;

  // Short-circuit if a recent lookup already failed (avoids repeated scoreboard fetches)
  const nullAt = eventIdNullCache.get(cacheKey);
  if (nullAt && Date.now() - nullAt < NULL_RETRY_MS) return null;

  // Deduplicate concurrent lookups — parallel route handlers (actual-lineup + player-stats)
  // share one scoreboard fetch instead of both slipping through before the cache is warm.
  if (eventIdInflight.has(cacheKey)) return eventIdInflight.get(cacheKey)!;

  const promise = (async () => {
    const espnLeague = COMP_MAP[competitionCode] ?? "eng.1";
    const base = utcDate.slice(0, 10).replace(/-/g, ""); // YYYYMMDD

    // Fetch UTC-1, UTC, and UTC+1 in parallel — ESPN uses local-time date keys so the
    // correct scoreboard date depends on kick-off timezone (US evening = UTC next day, etc.).
    // Parallel fetch cuts worst-case latency from 3× to 1× ESPN round-trip.
    const [dateMinus, dateBase, datePlus] = await Promise.all([
      espnFetch(`${ESPN_BASE}/${espnLeague}/scoreboard?dates=${shiftDay(base, -1)}`),
      espnFetch(`${ESPN_BASE}/${espnLeague}/scoreboard?dates=${base}`),
      espnFetch(`${ESPN_BASE}/${espnLeague}/scoreboard?dates=${addDay(base)}`),
    ]);

    // Scan in priority order: exact UTC date first, then ±1 day fallbacks.
    for (const data of [dateBase, dateMinus, datePlus]) {
      if (!data?.events) continue;

      for (const event of data.events) {
        const competitors: any[] = event.competitions?.[0]?.competitors ?? [];
        const espnHome = competitors.find((c: any) => c.homeAway === "home")?.team?.displayName ?? "";
        const espnAway = competitors.find((c: any) => c.homeAway === "away")?.team?.displayName ?? "";

        // Try both orderings (ESPN home/away may not match football-data.org)
        if (
          (teamsMatch(homeTeam, espnHome) && teamsMatch(awayTeam, espnAway)) ||
          (teamsMatch(homeTeam, espnAway) && teamsMatch(awayTeam, espnHome))
        ) {
          console.log(`[matchStats] ESPN event ${event.id}: ${espnHome} vs ${espnAway}`);
          cappedSet(eventIdCache, cacheKey, event.id as string, EVENT_ID_CACHE_MAX);
          return event.id as string;
        }
      }
    }

    // Don't permanently cache null — ESPN may be temporarily down or the event not yet listed.
    // The null-TTL cache prevents hammering within the retry window.
    console.log(`[matchStats] No ESPN event found for ${homeTeam} vs ${awayTeam} (${utcDate.slice(0, 10)}, comp=${competitionCode})`);
    eventIdNullCache.set(cacheKey, Date.now());
    return null;
  })().finally(() => eventIdInflight.delete(cacheKey));

  eventIdInflight.set(cacheKey, promise);
  return promise;
}

// Fetch and parse per-player stats from ESPN match summary
async function fetchEspnStats(
  eventId: string,
  competitionCode: string
): Promise<MatchPlayerStatsMap> {
  const espnLeague = COMP_MAP[competitionCode] ?? "eng.1";
  const summaryKey = `${espnLeague}:${eventId}`;
  const _sc0 = summaryCache.get(summaryKey);
  let data: any = _sc0 && Date.now() - _sc0.fetchedAt < SUMMARY_TTL_MS ? _sc0.data : null;
  if (!data) {
    data = await espnFetch(`${ESPN_BASE}/${espnLeague}/summary?event=${eventId}`);
    if (data) cappedSet(summaryCache, summaryKey, { data, fetchedAt: Date.now() }, SUMMARY_CACHE_MAX);
  }
  if (!data?.rosters) return {};

  // Build a set of last names for players who were substituted off, derived from
  // substitution key events: "Substitution, Team. PlayerIn replaces PlayerOut..."
  const subbedOutLastNames = new Set<string>();
  for (const ev of data.keyEvents ?? []) {
    const typeStr: string = (ev.type?.type ?? "").toLowerCase();
    if (typeStr === "substitution") {
      const text: string = ev.text ?? "";
      const m = text.match(/replaces\s+(.+?)(?:\s+because[^.]*)?\.?\s*$/i);
      if (m) subbedOutLastNames.add(lastName(m[1].trim()));
    }
  }

  const result: MatchPlayerStatsMap = {};

  for (const roster of data.rosters) {
    for (const entry of roster.roster ?? []) {
      const name: string = entry.athlete?.displayName ?? "";
      if (!name) continue;

      const stats: any[] = entry.stats ?? [];
      if (statVal(stats, "appearances") === 0) continue; // didn't play

      const last = lastName(name);
      if (!last) continue;

      result[last] = {
        minutesPlayed: 0, // ESPN doesn't expose exact minutes in free summary
        goals: statVal(stats, "totalGoals"),
        assists: statVal(stats, "goalAssists"),
        yellowCards: statVal(stats, "yellowCards"),
        redCards: statVal(stats, "redCards"),
        shots: statVal(stats, "totalShots"),
        shotsOnTarget: statVal(stats, "shotsOnTarget"),
        rating: null,
        starter: entry.starter === true,
        subbedIn: entry.subbedIn === true,
        subbedOut: subbedOutLastNames.has(last),
      };
    }
  }

  return result;
}

// ── ESPN team-level match stats ────────────────────────────────────────────

export interface EspnTeamStatLine {
  teamName: string;
  homeAway: "home" | "away";
  possession: number | null;
  shots: number | null;
  shotsOnTarget: number | null;
  corners: number | null;
  fouls: number | null;
  yellowCards: number | null;
  redCards: number | null;
  offsides: number | null;
  saves: number | null;
}

export interface EspnMatchTeamStats {
  home: EspnTeamStatLine;
  away: EspnTeamStatLine;
}

function parseStat(stats: any[], ...names: string[]): number | null {
  for (const name of names) {
    const entry = stats.find((s: any) => s.name === name);
    if (entry != null) {
      const v = parseFloat(entry.displayValue ?? entry.value ?? "");
      if (!isNaN(v)) return v;
    }
  }
  return null;
}

async function fetchEspnTeamStats(
  eventId: string,
  competitionCode: string
): Promise<EspnMatchTeamStats | null> {
  const espnLeague = COMP_MAP[competitionCode] ?? "eng.1";
  const summaryKey = `${espnLeague}:${eventId}`;
  const _sc1 = summaryCache.get(summaryKey);
  let data: any = _sc1 && Date.now() - _sc1.fetchedAt < SUMMARY_TTL_MS ? _sc1.data : null;
  if (!data) {
    data = await espnFetch(`${ESPN_BASE}/${espnLeague}/summary?event=${eventId}`);
    if (data) cappedSet(summaryCache, summaryKey, { data, fetchedAt: Date.now() }, SUMMARY_CACHE_MAX);
  }

  const teams: any[] = data?.boxscore?.teams ?? [];
  if (teams.length < 2) return null;

  function parseTeam(t: any): EspnTeamStatLine {
    const stats: any[] = t.statistics ?? [];
    return {
      teamName: t.team?.displayName ?? t.team?.name ?? "",
      homeAway: t.homeAway === "away" ? "away" : "home",
      possession: parseStat(stats, "possessionPct", "possession"),
      shots: parseStat(stats, "totalShots", "shots"),
      shotsOnTarget: parseStat(stats, "shotsOnTarget", "onTargetAttempts"),
      corners: parseStat(stats, "cornerKicks", "corners"),
      fouls: parseStat(stats, "foulsCommitted", "foulsConceded"),
      yellowCards: parseStat(stats, "yellowCards"),
      redCards: parseStat(stats, "redCards"),
      offsides: parseStat(stats, "offsides"),
      saves: parseStat(stats, "saves", "goalKeeperSaves"),
    };
  }

  const homeSide = teams.find((t) => t.homeAway === "home") ?? teams[0];
  const awaySide = teams.find((t) => t.homeAway === "away") ?? teams[1];

  return { home: parseTeam(homeSide), away: parseTeam(awaySide) };
}

export async function getMatchTeamStats(
  matchId: number,
  homeTeam: string,
  awayTeam: string,
  utcDate: string,
  competitionCode: string
): Promise<EspnMatchTeamStats | null> {
  const eventId = await findEspnEventId(homeTeam, awayTeam, utcDate, competitionCode);
  if (!eventId) return null;
  return fetchEspnTeamStats(eventId, competitionCode);
}

// ── Google scraper ─────────────────────────────────────────────────────────
// Searches Google for the match and tries to extract player ratings from the
// sports panel. Ratings appear via WhoScored data embedded in Google results.
async function scrapeGoogleRatings(
  homeTeam: string,
  awayTeam: string,
  utcDate: string
): Promise<Record<string, number>> {
  try {
    const d = new Date(utcDate);
    const day = d.getUTCDate();
    const month = d.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
    const year = d.getUTCFullYear();
    const query = `${homeTeam} vs ${awayTeam} ${day} ${month} ${year} player ratings lineup`;

    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=gb`;
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.log(`[matchStats] Google returned ${res.status} — skipping ratings`);
      return {};
    }

    const html = await res.text();

    // Google's sports panel embeds WhoScored player ratings in the HTML.
    // Look for numeric ratings (5.0–10.0) adjacent to player names.
    // Multiple patterns tried in order of reliability:
    const ratings: Record<string, number> = {};

    // Pattern 1: data-entityname attribute with adjacent rating span
    const entityPattern = /data-entityname="([^"]+)"[^>]*>[\s\S]{0,200}?(\b(?:[5-9]\.\d|10\.0)\b)/g;
    for (const m of html.matchAll(entityPattern)) {
      const name = m[1].trim();
      const rating = parseFloat(m[2]);
      if (name && !isNaN(rating) && rating >= 5 && rating <= 10) {
        const last = lastName(name);
        if (last.length >= 3 && !ratings[last]) ratings[last] = rating;
      }
    }

    // Pattern 2: player name followed by rating in parenthetical or table cell
    const tablePattern = /\b([A-Z][a-záéíóúñãõüöäàèìòùâêîôûç\-']+(?:\s+[A-Z][a-záéíóúñãõüöäàèìòùâêîôûç\-']+){1,3})\b[\s\S]{0,80}?(\b(?:[6-9]\.\d|10\.0)\b)/g;
    for (const m of html.matchAll(tablePattern)) {
      const name = m[1].trim();
      const rating = parseFloat(m[2]);
      if (rating >= 6 && rating <= 10) {
        const last = lastName(name);
        if (last.length >= 3 && !ratings[last]) ratings[last] = rating;
      }
    }

    const found = Object.keys(ratings).length;
    console.log(`[matchStats] Google scrape: found ${found} player ratings`);
    return ratings;
  } catch (e) {
    console.warn(`[matchStats] Google scrape error: ${(e as Error).message}`);
    return {};
  }
}

// ── ESPN lineup extraction ─────────────────────────────────────────────────

export interface EspnLineupPlayer {
  name: string;
  broadPosition: string;   // "Goalkeeper" | "Defender" | "Midfielder" | "Attacker"
  espnPosition: string;    // raw ESPN position abbreviation e.g. "CB", "CM", "ST"
  starter: boolean;
  subbedIn: boolean;
  shirtNumber: number | null;
}

export interface EspnTeamLineup {
  teamName: string;
  starters: EspnLineupPlayer[];
  bench: EspnLineupPlayer[];
  formation: string;
}

export interface EspnMatchLineup {
  homeTeamId: number | null;
  homeTeamName: string;
  awayTeamId: number | null;
  awayTeamName: string;
  home: EspnTeamLineup;
  away: EspnTeamLineup;
}

// Cache for ESPN raw lineup data (separate from stats cache)
const lineupCache = new Map<number, { data: EspnMatchLineup; fetchedAt: number }>();

// ESPN position abbreviation → broad position
// ESPN uses: G (GK), CD (CB), LD (LB), RD (RB), DM, CM, AM, LM, RM, F, S, ST, LW, RW
const ESPN_POS_BROAD: Record<string, string> = {
  G: "Goalkeeper", GK: "Goalkeeper",
  CD: "Defender", CB: "Defender",
  LD: "Defender", LB: "Defender",
  RD: "Defender", RB: "Defender",
  WB: "Defender", LWB: "Defender", RWB: "Defender",
  DM: "Midfielder", CDM: "Midfielder",
  CM: "Midfielder", CAM: "Midfielder", AM: "Midfielder",
  LM: "Midfielder", RM: "Midfielder",
  LW: "Attacker", RW: "Attacker",
  F: "Attacker", S: "Attacker", ST: "Attacker",
  CF: "Attacker", SS: "Attacker",
};

function espnPosBroad(abbr: string, name: string): string {
  const a = abbr.toUpperCase();
  if (ESPN_POS_BROAD[a]) return ESPN_POS_BROAD[a];
  const n = name.toLowerCase();
  if (n.includes("goal")) return "Goalkeeper";
  if (n.includes("back") || n.includes("defender") || n.includes("center def")) return "Defender";
  if (n.includes("midfield")) return "Midfielder";
  if (n.includes("forward") || n.includes("winger") || n.includes("striker")) return "Attacker";
  return "Midfielder";
}

// ESPN position abbreviation → our pitch role (for pitchLayout x-positioning)
const ESPN_POS_ROLE: Record<string, string> = {
  G: "GK", GK: "GK",
  CD: "CB", CB: "CB",
  LD: "LB", LB: "LB", LWB: "LB",
  RD: "RB", RB: "RB", RWB: "RB",
  DM: "DM", CDM: "DM",
  CM: "CM", AM: "AM", CAM: "AM",
  LM: "LW", RM: "RW",
  LW: "LW", RW: "RW",
  F: "CF", S: "CF", ST: "CF", CF: "CF", SS: "CF",
};

function inferFormation(starters: EspnLineupPlayer[]): string {
  const outfield = starters.filter((p) => p.broadPosition !== "Goalkeeper");
  const def = outfield.filter((p) => p.broadPosition === "Defender").length;
  const mid = outfield.filter((p) => p.broadPosition === "Midfielder").length;
  const att = outfield.filter((p) => p.broadPosition === "Attacker").length;
  return [def, mid, att].filter((n) => n > 0).join("-");
}

export async function getEspnMatchLineup(
  matchId: number,
  homeTeam: string,
  awayTeam: string,
  utcDate: string,
  competitionCode: string
): Promise<EspnMatchLineup | null> {
  // L1: in-memory
  const memCached = lineupCache.get(matchId);
  if (memCached && Date.now() - memCached.fetchedAt < CACHE_TTL_MS) return memCached.data;

  // L2: Supabase — survives server restarts (only for FD.org-sourced matches with positive IDs)
  if (matchId > 0) {
    const dbCached = await getCached(`/espn-lineup/${matchId}`);
    if (dbCached) {
      const data = dbCached as EspnMatchLineup;
      lineupCache.set(matchId, { data, fetchedAt: Date.now() });
      return data;
    }
  }

  const eventId = await findEspnEventId(homeTeam, awayTeam, utcDate, competitionCode);
  if (!eventId) return null;

  const espnLeague = COMP_MAP[competitionCode] ?? "eng.1";
  const summaryKey = `${espnLeague}:${eventId}`;
  const _sc4 = summaryCache.get(summaryKey);
  let data: any = _sc4 && Date.now() - _sc4.fetchedAt < SUMMARY_TTL_MS ? _sc4.data : null;
  if (!data) {
    data = await espnFetch(`${ESPN_BASE}/${espnLeague}/summary?event=${eventId}`);
    if (data) cappedSet(summaryCache, summaryKey, { data, fetchedAt: Date.now() }, SUMMARY_CACHE_MAX);
  }
  if (!data?.rosters) return null;

  const teams: EspnTeamLineup[] = [];
  const teamMeta: Array<{ teamName: string; teamId: number | null }> = [];

  for (const roster of data.rosters as any[]) {
    const teamName: string = roster.team?.displayName ?? roster.team?.name ?? "";
    const teamId: number | null = roster.team?.id ?? null;

    const starters: EspnLineupPlayer[] = [];
    const bench: EspnLineupPlayer[] = [];

    for (const entry of roster.roster ?? []) {
      // ESPN uses entry.position (not entry.athlete.position) for the player's match position
      const abbr: string = (entry.position?.abbreviation ?? entry.athlete?.position?.abbreviation ?? "").toUpperCase();
      const posName: string = entry.position?.name ?? entry.athlete?.position?.name ?? "";
      const broad = espnPosBroad(abbr, posName);
      const role = ESPN_POS_ROLE[abbr] ?? (broad === "Goalkeeper" ? "GK" : broad === "Defender" ? "CB" : broad === "Attacker" ? "CF" : "CM");

      const player: EspnLineupPlayer = {
        name: entry.athlete?.displayName ?? "",
        broadPosition: broad,
        espnPosition: role,
        starter: entry.starter === true,
        subbedIn: entry.subbedIn === true,
        // jersey is at entry.jersey (not entry.athlete.jersey)
        shirtNumber: entry.jersey ? parseInt(entry.jersey, 10) : (entry.athlete?.jersey ? parseInt(entry.athlete.jersey, 10) : null),
      };

      if (entry.starter) {
        starters.push(player);
      } else {
        bench.push(player);
      }
    }

    teams.push({ teamName, starters, bench, formation: inferFormation(starters) });
    teamMeta.push({ teamName, teamId });
  }

  if (teams.length < 2) return null;

  // Determine home/away based on team name matching
  const homeIdx = teamsMatch(homeTeam, teams[0].teamName) ? 0 : 1;
  const awayIdx = 1 - homeIdx;

  const result: EspnMatchLineup = {
    homeTeamId: teamMeta[homeIdx].teamId,
    homeTeamName: teams[homeIdx].teamName,
    awayTeamId: teamMeta[awayIdx].teamId,
    awayTeamName: teams[awayIdx].teamName,
    home: teams[homeIdx],
    away: teams[awayIdx],
  };

  if (teams[0].starters.length > 0) {
    lineupCache.set(matchId, { data: result, fetchedAt: Date.now() });
    if (matchId > 0) setCached(`/espn-lineup/${matchId}`, result, FOREVER_TTL_MS);
    console.log(`[matchStats] ESPN lineup cached: ${teams[homeIdx].teamName} ${teams[homeIdx].formation} vs ${teams[awayIdx].teamName} ${teams[awayIdx].formation}`);
  }

  return result;
}

export async function getMatchPlayerStats(
  matchId: number,
  homeTeam: string,
  awayTeam: string,
  utcDate: string,
  competitionCode: string,
  isLive = false
): Promise<MatchPlayerStatsMap> {
  if (!isLive) {
    // L1: in-memory
    const memCached = statsCache.get(matchId);
    if (memCached && Date.now() - memCached.fetchedAt < CACHE_TTL_MS) return memCached.data;

    // L2: Supabase — survives server restarts (only for FD.org-sourced matches with positive IDs)
    if (matchId > 0) {
      const dbCached = await getCached(`/espn-stats/${matchId}`);
      if (dbCached) {
        const data = dbCached as MatchPlayerStatsMap;
        cappedSet(statsCache, matchId, { data, fetchedAt: Date.now() }, STATS_CACHE_MAX);
        return data;
      }
    }
  }

  // Start both lookups concurrently — Google ratings run in the background and
  // don't block the response; ESPN stats are returned as soon as they're ready.
  const eventIdPromise = findEspnEventId(homeTeam, awayTeam, utcDate, competitionCode);
  const googleRatingsPromise = scrapeGoogleRatings(homeTeam, awayTeam, utcDate);

  const eventId = await eventIdPromise;
  if (!eventId) return {};

  const stats = await fetchEspnStats(eventId, competitionCode);

  const count = Object.keys(stats).length;
  if (count > 0) {
    cappedSet(statsCache, matchId, { data: stats, fetchedAt: Date.now() }, STATS_CACHE_MAX);
    // Don't persist to Supabase with FOREVER_TTL while the match is still in progress
    if (!isLive && matchId > 0) setCached(`/espn-stats/${matchId}`, stats, FOREVER_TTL_MS);
    console.log(`[matchStats] Cached ${count} player stats for match ${matchId}`);
  }

  // Enrich with Google ratings in the background — doesn't block the HTTP response.
  // The stats object is stored by reference in the cache, so mutations here are
  // reflected on the next cache hit automatically.
  googleRatingsPromise.then((ratings) => {
    const ratingCount = Object.keys(ratings).length;
    if (!ratingCount) return;
    for (const [last, rating] of Object.entries(ratings)) {
      if (stats[last]) stats[last].rating = rating;
    }
    console.log(`[matchStats] Google ratings enriched ${ratingCount} players for match ${matchId}`);
    if (!isLive && matchId > 0 && count > 0) setCached(`/espn-stats/${matchId}`, stats, FOREVER_TTL_MS);
  });

  return stats;
}

// ── ESPN booking & substitution events ────────────────────────────────────

export interface EspnBookingEvent {
  minute: number;
  extraTime: number | null;
  player: string;
  teamDisplayName: string;
  card: "YELLOW" | "YELLOW_RED" | "RED";
}

export interface EspnSubstitutionEvent {
  minute: number;
  extraTime: number | null;
  playerIn: string;
  playerOut: string;
  teamDisplayName: string;
}

// In-memory + Supabase cache for events so ESPN is only scraped once per match
const eventsCache = new Map<number, { data: { bookings: EspnBookingEvent[]; substitutions: EspnSubstitutionEvent[] }; fetchedAt: number }>();
const EVENTS_CACHE_MAX = 500;

function parseClock(clockStr: string): { minute: number; extraTime: number | null } {
  const plusMatch = clockStr.match(/^(\d+)[+']+(\d+)'?$/);
  if (plusMatch) return { minute: parseInt(plusMatch[1], 10), extraTime: parseInt(plusMatch[2], 10) };
  const simpleMatch = clockStr.match(/^(\d+)'?$/);
  return { minute: simpleMatch ? parseInt(simpleMatch[1], 10) : 0, extraTime: null };
}

export async function getMatchBookingsAndSubs(
  matchId: number,
  homeTeam: string,
  awayTeam: string,
  utcDate: string,
  competitionCode: string,
  isLive = false
): Promise<{ bookings: EspnBookingEvent[]; substitutions: EspnSubstitutionEvent[] }> {
  const empty = { bookings: [], substitutions: [] };

  if (!isLive) {
    // L1: in-memory
    const mem = eventsCache.get(matchId);
    if (mem && Date.now() - mem.fetchedAt < CACHE_TTL_MS) return mem.data;

    // L2: Supabase
    if (matchId > 0) {
      const db = await getCached(`/espn-events/${matchId}`);
      if (db) {
        const data = db as typeof empty;
        cappedSet(eventsCache, matchId, { data, fetchedAt: Date.now() }, EVENTS_CACHE_MAX);
        return data;
      }
    }
  }

  const eventId = await findEspnEventId(homeTeam, awayTeam, utcDate, competitionCode);
  if (!eventId) return empty;

  const espnLeague = COMP_MAP[competitionCode] ?? "eng.1";
  const summaryKey = `${espnLeague}:${eventId}`;
  const _sc2 = summaryCache.get(summaryKey);
  let data: any = _sc2 && Date.now() - _sc2.fetchedAt < SUMMARY_TTL_MS ? _sc2.data : null;
  if (!data) {
    data = await espnFetch(`${ESPN_BASE}/${espnLeague}/summary?event=${eventId}`);
    if (data) cappedSet(summaryCache, summaryKey, { data, fetchedAt: Date.now() }, SUMMARY_CACHE_MAX);
  }
  if (!data) return empty;

  const keyEvents: any[] = data.keyEvents ?? [];
  const bookings: EspnBookingEvent[] = [];
  const substitutions: EspnSubstitutionEvent[] = [];

  for (const ev of keyEvents) {
    const typeStr: string = (ev.type?.type ?? "").toLowerCase();
    const { minute, extraTime } = parseClock(ev.clock?.displayValue ?? "");
    const text: string = ev.text ?? "";

    if (typeStr === "yellow-card" || typeStr === "red-card" || typeStr === "yellow-red-card" || typeStr === "second-yellow-card") {
      // Text format: "Player Name (Team) is shown the yellow card..."
      const m = text.match(/^(.+?)\s+\(([^)]+)\)/);
      if (!m) continue;
      const card: EspnBookingEvent["card"] =
        typeStr === "red-card" ? "RED" : typeStr.includes("yellow-red") || typeStr.includes("second") ? "YELLOW_RED" : "YELLOW";
      bookings.push({ minute, extraTime, player: m[1].trim(), teamDisplayName: m[2].trim(), card });

    } else if (typeStr === "substitution") {
      // Text format: "Substitution, Team. PlayerIn replaces PlayerOut[ because of...]."
      const m = text.match(/^Substitution,\s*([^.]+)\.\s*(.+?)\s+replaces\s+(.+?)(?:\s+because[^.]*)?\.?\s*$/i);
      if (!m) continue;
      substitutions.push({
        minute, extraTime,
        playerIn: m[2].trim(), playerOut: m[3].trim(), teamDisplayName: m[1].trim(),
      });
    }
  }

  const result = { bookings, substitutions };
  // Always write to in-memory cache (even empty) so repeated requests within the server's
  // lifetime don't re-hit ESPN for matches with no cards/subs.
  cappedSet(eventsCache, matchId, { data: result, fetchedAt: Date.now() }, EVENTS_CACHE_MAX);
  // Persist to Supabase only when we have data — if ESPN doesn't have events yet we'll
  // retry on the next cold start rather than caching "no data" permanently.
  if (!isLive && matchId > 0 && (bookings.length > 0 || substitutions.length > 0)) {
    setCached(`/espn-events/${matchId}`, result, FOREVER_TTL_MS);
  }
  return result;
}

// ── ESPN goal event data ───────────────────────────────────────────────────

export interface EspnGoalEvent {
  minute: number;
  extraTime: number | null;
  teamDisplayName: string;
  scorer: string;
  assist: string | null;
  ownGoal: boolean;
  penalty: boolean;
}

export async function getMatchGoalEvents(
  matchId: number,
  homeTeam: string,
  awayTeam: string,
  utcDate: string,
  competitionCode: string,
  isLive = false
): Promise<EspnGoalEvent[]> {
  if (!isLive) {
    // L1: in-memory (7-day TTL, same as stats/events caches)
    const mem = goalsCache.get(matchId);
    if (mem && Date.now() - mem.fetchedAt < CACHE_TTL_MS) return mem.data;

    // L2: Supabase — survives server restarts for finished matches
    if (matchId > 0) {
      const db = await getCached(`/espn-goals/${matchId}`);
      if (db) {
        const data = db as EspnGoalEvent[];
        cappedSet(goalsCache, matchId, { data, fetchedAt: Date.now() }, GOALS_CACHE_MAX);
        return data;
      }
    }
  }

  const eventId = await findEspnEventId(homeTeam, awayTeam, utcDate, competitionCode);
  if (!eventId) return [];

  const espnLeague = COMP_MAP[competitionCode] ?? "eng.1";
  const summaryKey = `${espnLeague}:${eventId}`;
  const _sc3 = summaryCache.get(summaryKey);
  let data: any = _sc3 && Date.now() - _sc3.fetchedAt < SUMMARY_TTL_MS ? _sc3.data : null;
  if (!data) {
    data = await espnFetch(`${ESPN_BASE}/${espnLeague}/summary?event=${eventId}`);
    if (data) cappedSet(summaryCache, summaryKey, { data, fetchedAt: Date.now() }, SUMMARY_CACHE_MAX);
  }
  if (!data) return [];

  // header.competitions[0].details contains the scoring plays with clock, team, participants, flags
  const details: any[] = data?.header?.competitions?.[0]?.details ?? [];
  const scoringPlays = details.filter((d: any) => d.scoringPlay === true);

  const goals = scoringPlays.map((d: any): EspnGoalEvent => {
    const clockStr: string = d.clock?.displayValue ?? "";
    let minute = 0;
    let extraTime: number | null = null;

    // Formats: "42'", "90+2'", "45'+4'" (stoppage time in first half shown as base+added)
    const plusMatch = clockStr.match(/^(\d+)[+']+(\d+)'?$/);
    if (plusMatch) {
      minute = parseInt(plusMatch[1], 10);
      extraTime = parseInt(plusMatch[2], 10);
    } else {
      const simpleMatch = clockStr.match(/^(\d+)'?$/);
      if (simpleMatch) minute = parseInt(simpleMatch[1], 10);
    }

    const scorer: string = d.participants?.[0]?.athlete?.displayName ?? "Unknown";
    // Second participant is the assist (if present and not an own goal)
    const assist: string | null =
      !d.ownGoal && d.participants?.[1]?.athlete?.displayName
        ? d.participants[1].athlete.displayName
        : null;

    return {
      minute,
      extraTime,
      teamDisplayName: d.team?.displayName ?? "",
      scorer,
      assist,
      ownGoal: d.ownGoal === true,
      penalty: d.penaltyKick === true,
    };
  });

  // Cache in memory regardless of count; persist to Supabase for finished matches with goals.
  cappedSet(goalsCache, matchId, { data: goals, fetchedAt: Date.now() }, GOALS_CACHE_MAX);
  if (!isLive && matchId > 0 && goals.length > 0) {
    setCached(`/espn-goals/${matchId}`, goals, FOREVER_TTL_MS);
  }
  return goals;
}

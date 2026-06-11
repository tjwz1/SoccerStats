import { safeFetch as fetch } from "../utils/httpClient";
import * as cheerio from "cheerio";
import type { ScheduleMatch } from "./footballApi";
import { getCached, setCached } from "../db/apiCache";

// ── ESPN cup schedule ─────────────────────────────────────────────────────────
// ESPN team schedule API works for these cups (teams endpoint has full team list).
// Copa Libertadores intentionally excluded — handled as a separate competition.

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// Map football-data.org domestic code → ESPN cup slug + display name
const DOMESTIC_CUP_MAP: Record<string, { slug: string; name: string }> = {
  PD:  { slug: "esp.copa_del_rey", name: "Copa del Rey" },
  BL1: { slug: "ger.dfb_pokal",    name: "DFB-Pokal" },
  SA:  { slug: "ita.coppa_italia", name: "Coppa Italia" },
  DED: { slug: "ned.cup",          name: "KNVB Beker" },
};

// Map domestic league slug to ESPN league slug (for team ID lookup)
const DOMESTIC_LEAGUE_SLUG: Record<string, string> = {
  PD:  "esp.1",
  BL1: "ger.1",
  SA:  "ita.1",
  DED: "ned.1",
};

// Cup slugs also need to work in the existing COMP_MAP inside matchStatsScraper
// for match stats lookup — they're added there separately.

const ESPN_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
};

async function espnGet(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: ESPN_HEADERS,
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      console.warn(`[cupSchedule] ESPN ${res.status}: ${url}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`[cupSchedule] ESPN fetch error: ${(e as Error).message}`);
    return null;
  }
}

function normTeam(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(fc|f\.c\.|afc|sc|sfc|cf|rcd|cd|ud|sd|sv|1\.)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function teamsMatch(a: string, b: string): boolean {
  const aNorm = normTeam(a);
  const bNorm = normTeam(b);
  const aWords = aNorm.split(" ").filter((w) => w.length >= 3);
  return aWords.length > 0 && aWords.some((w) => bNorm.includes(w));
}

// Cache ESPN team IDs to avoid repeated lookups per team
const espnTeamIdCache = new Map<string, string | null>(); // key: "{leagueSlug}:{teamName}"

async function findEspnTeamId(teamName: string, leagueSlug: string): Promise<string | null> {
  const cacheKey = `${leagueSlug}:${teamName}`;
  if (espnTeamIdCache.has(cacheKey)) return espnTeamIdCache.get(cacheKey)!;

  const data = await espnGet(`${ESPN_BASE}/${leagueSlug}/teams?limit=100`);
  const teams: any[] = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];

  const match = teams.find((t: any) => teamsMatch(teamName, t.team?.displayName ?? ""));
  const id: string | null = match?.team?.id ?? null;
  espnTeamIdCache.set(cacheKey, id);
  return id;
}

function espnScoreVal(score: any): number | null {
  if (score === undefined || score === null) return null;
  if (typeof score === "number") return score;
  if (typeof score === "string") return parseInt(score, 10);
  if (typeof score === "object" && "value" in score) return score.value;
  return null;
}

function espnStatus(event: any): string {
  const state: string = event.status?.type?.state ?? event.competitions?.[0]?.status?.type?.state ?? "";
  if (state === "in") return "IN_PLAY";
  if (state === "post") return "FINISHED";
  return "SCHEDULED";
}

// ESPN event IDs are numeric strings (e.g. "401859850").
// We store them as NEGATIVE numbers in ScheduleMatch.id so the route layer
// can detect "ESPN-sourced" matches and skip football-data.org lookups.
function toNegativeId(espnEventId: string): number {
  return -parseInt(espnEventId, 10);
}

// In-memory cache: "{fdTeamId}:{domesticCode}" → matches (valid for 30 min)
const cupCache = new Map<string, { data: ScheduleMatch[]; fetchedAt: number }>();
const CUP_CACHE_TTL_MS = 30 * 60 * 1000;

export async function fetchEspnCupMatches(
  fdTeamId: number,
  teamName: string,
  domesticCode: string
): Promise<ScheduleMatch[]> {
  const memKey = `${fdTeamId}:${domesticCode}`;
  const dbKey = `/cup-espn/${fdTeamId}/${domesticCode}`;

  // L1: in-memory
  const memCached = cupCache.get(memKey);
  if (memCached && Date.now() - memCached.fetchedAt < CUP_CACHE_TTL_MS) return memCached.data;

  // L2: Supabase
  const dbCached = await getCached(dbKey);
  if (dbCached) {
    const data = dbCached as ScheduleMatch[];
    cupCache.set(memKey, { data, fetchedAt: Date.now() });
    return data;
  }

  const cup = DOMESTIC_CUP_MAP[domesticCode];
  if (!cup) return [];

  const leagueSlug = DOMESTIC_LEAGUE_SLUG[domesticCode];
  if (!leagueSlug) return [];

  const espnTeamId = await findEspnTeamId(teamName, leagueSlug);
  if (!espnTeamId) {
    console.log(`[cupSchedule] ESPN team not found for "${teamName}" in ${leagueSlug}`);
    return [];
  }

  const schedUrl = `${ESPN_BASE}/${cup.slug}/teams/${espnTeamId}/schedule`;
  const sched = await espnGet(schedUrl);
  if (!sched?.events) {
    console.log(`[cupSchedule] No events for ${teamName} in ${cup.name}`);
    return [];
  }

  const matches: ScheduleMatch[] = [];

  for (const event of sched.events as any[]) {
    const comp = event.competitions?.[0];
    if (!comp) continue;

    const competitors: any[] = comp.competitors ?? [];
    const homeComp = competitors.find((c: any) => c.homeAway === "home");
    const awayComp = competitors.find((c: any) => c.homeAway === "away");
    if (!homeComp || !awayComp) continue;

    const status = espnStatus(event);
    const isFinished = status === "FINISHED";

    const homeScoreRaw = espnScoreVal(homeComp.score);
    const awayScoreRaw = espnScoreVal(awayComp.score);

    // Detect penalty / AET from status type name
    const statusName: string = comp.status?.type?.name ?? "";
    const shortDetail: string = comp.status?.type?.shortDetail ?? comp.status?.type?.detail ?? "";
    const isPen = statusName === "STATUS_FINAL_PEN" || shortDetail.includes("Pens") || shortDetail.includes("pens");
    const isAET = statusName === "STATUS_FINAL_AET" || shortDetail === "AET" || shortDetail.includes("AET");
    const duration: ScheduleMatch["duration"] = isPen
      ? "PENALTY_SHOOTOUT"
      : isAET
      ? "EXTRA_TIME"
      : isFinished
      ? "REGULAR"
      : null;

    // Winner — ESPN has `winner` boolean per competitor
    let winner: ScheduleMatch["winner"] = null;
    if (isFinished) {
      const homeWins = homeComp.winner === true;
      const awayWins = awayComp.winner === true;
      winner = homeWins ? "HOME_TEAM" : awayWins ? "AWAY_TEAM" : "DRAW";
    }

    // Determine which competitor is "our" team
    const weAreHome = homeComp.team?.id === espnTeamId;

    const matchId = toNegativeId(event.id);

    matches.push({
      id: matchId,
      status,
      utcDate: event.date,
      matchday: null,
      competition: cup.name,
      competitionCode: cup.slug,
      competitionEmblem: "",
      homeTeam: homeComp.team?.displayName ?? "",
      homeTeamId: weAreHome ? fdTeamId : 0,
      homeTeamCrest: homeComp.team?.logos?.[0]?.href ?? homeComp.team?.logo ?? "",
      awayTeam: awayComp.team?.displayName ?? "",
      awayTeamId: weAreHome ? 0 : fdTeamId,
      awayTeamCrest: awayComp.team?.logos?.[0]?.href ?? awayComp.team?.logo ?? "",
      scoreHome: isFinished ? homeScoreRaw : null,
      scoreAway: isFinished ? awayScoreRaw : null,
      duration,
      winner,
      etScoreHome: null,
      etScoreAway: null,
      penScoreHome: null,
      penScoreAway: null,
    });
  }

  console.log(`[cupSchedule] ESPN ${cup.name}: ${matches.length} matches for ${teamName}`);
  cupCache.set(memKey, { data: matches, fetchedAt: Date.now() });
  if (matches.length > 0) setCached(dbKey, matches, CUP_CACHE_TTL_MS);
  return matches;
}

// ── Transfermarkt club schedule scraper (FA Cup + EFL Cup) ───────────────────
// For cups where ESPN team schedules don't work (FA Cup, EFL Cup, etc.),
// we scrape Transfermarkt's Spielplan page which groups matches by competition.
// The page structure: each competition has a box-headline containing a link
// with the TM competition code (e.g. /wettbewerb/FAC/), followed by the match tbody.

const TM_BASE = "https://www.transfermarkt.com";
const TM_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
  Referer: "https://www.transfermarkt.com/",
};

// Maps TM competition code → display name + our competition code
const TM_CUP_INFO: Record<string, { name: string; code: string }> = {
  FAC: { name: "FA Cup",   code: "FAC" },
  CGB: { name: "EFL Cup",  code: "EFL" },
  GPC: { name: "DFB-Pokal", code: "DFB" },  // German cup fallback
  IIC: { name: "Coppa Italia", code: "CI" }, // Italian cup fallback
  CDR: { name: "Copa del Rey", code: "CDR" }, // Spanish cup fallback
  CDF: { name: "Coupe de France", code: "CF" },
  KNV: { name: "KNVB Beker", code: "KNV" },
  TPC: { name: "Taça de Portugal", code: "TPC" },
};

// Leagues whose domestic cups we scrape from Transfermarkt
// (ESPN works for most; only PL & ELC need TM scraping)
const TM_CUP_LEAGUES = new Set(["PL", "ELC"]);

async function tmFetch(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: TM_HEADERS,
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (res.status === 403 || res.status === 429) {
      console.warn(`[cupSchedule:TM] Blocked (${res.status}) for ${url}`);
      return null;
    }
    if (!res.ok) return null;
    const text = await res.text();
    if (text.includes("cf-browser-verification") || text.includes("Just a moment")) {
      console.warn(`[cupSchedule:TM] Cloudflare challenge`);
      return null;
    }
    return text;
  } catch (e) {
    console.warn(`[cupSchedule:TM] Error: ${(e as Error).message}`);
    return null;
  }
}

// Parse "Sun 12/01/2025" → ISO date string
function parseTmDate(dateStr: string): string | null {
  // Format: "Day DD/MM/YYYY" or "DD/MM/YYYY"
  const m = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}T00:00:00Z`;
}

// Parse "4:6" or "4:6 (aet)" into score objects
function parseTmScore(scoreText: string): {
  home: number | null;
  away: number | null;
  duration: ScheduleMatch["duration"];
  winner: ScheduleMatch["winner"];
} {
  const m = scoreText.match(/(\d+)\s*:\s*(\d+)/);
  if (!m) return { home: null, away: null, duration: null, winner: null };

  const home = parseInt(m[1], 10);
  const away = parseInt(m[2], 10);
  const lower = scoreText.toLowerCase();
  const isPen = lower.includes("pens") || lower.includes("pen");
  const isAET = lower.includes("aet") || lower.includes("extra");

  const duration: ScheduleMatch["duration"] = isPen
    ? "PENALTY_SHOOTOUT"
    : isAET
    ? "EXTRA_TIME"
    : "REGULAR";
  const winner: ScheduleMatch["winner"] =
    home > away ? "HOME_TEAM" : away > home ? "AWAY_TEAM" : "DRAW";

  return { home, away, duration, winner };
}

// In-memory cache for TM club schedule: "{tmClubId}:{season}" → matches
const tmCupCache = new Map<string, { data: ScheduleMatch[]; fetchedAt: number }>();

// Find the match table for a competition section identified by <a name="{code}"> anchor.
// TM page structure: <h2>...<a name="FAC" href="...">...</a>...</h2> followed (in siblings
// or parent's siblings) by <div class="responsive-table"><table>…</table></div>.
function findMatchTable(anchor: any, $: any): any | null {
  const heading = anchor.closest("h2, h3, h1");
  const DATE_PAT = /\d{2}\/\d{2}\/\d{4}/;

  const hasDateRows = (table: any) =>
    table.find("tbody tr").filter((_: any, tr: any) =>
      DATE_PAT.test($(tr).find("td").eq(1).text())
    ).length > 0;

  // Walk forward through siblings (and siblings of parent) looking for a responsive-table or table
  for (const startEl of [heading, heading.parent(), anchor.parent()]) {
    if (!startEl.length) continue;
    let found: any = null;
    startEl.nextAll().each((_: any, sib: any) => {
      if (found) return;
      const $sib = $(sib);
      // Direct div.responsive-table
      if ($sib.hasClass("responsive-table")) {
        const t = $sib.find("table").first();
        if (hasDateRows(t)) { found = t; return; }
      }
      // Nested
      const nested = $sib.find("div.responsive-table table").first();
      if (nested.length && hasDateRows(nested)) { found = nested; return; }
      // Bare table
      if ($sib.is("table") && hasDateRows($sib)) { found = $sib; return; }
    });
    if (found) return found;
  }
  return null;
}

function parseTmMatchRows(
  table: any,
  $: any,
  fdTeamId: number,
  teamName: string,
  cupInfo: { name: string; code: string }
): ScheduleMatch[] {
  const DATE_PAT = /\d{2}\/\d{2}\/\d{4}/;
  const rows: ScheduleMatch[] = [];

  table.find("tbody tr").each((_: any, tr: any) => {
    const cells = $(tr).find("td");
    if (cells.length < 6) return;

    const dateText = cells.eq(1).text().trim();
    const utcDate = parseTmDate(dateText);
    if (!utcDate) return;

    const isHome = cells.eq(3).text().trim() === "H";

    // Opponent from the anchor with title pointing to a TM club page
    const opponentAnchor = $(tr).find("a[title][href*='/startseite/verein/']").last();
    const opponentName = opponentAnchor.attr("title")?.trim() ?? "";
    const opponentHref = opponentAnchor.attr("href") ?? "";
    const opponentTmIdMatch = opponentHref.match(/\/verein\/(\d+)/);
    if (!opponentName) return;

    const opponentCrestUrl = opponentTmIdMatch
      ? `https://tmssl.akamaized.net/images/wappen/profil/${opponentTmIdMatch[1]}.png`
      : "";

    // Score — last cell; result link contains both the score and extra text (e.g. "on pens")
    const scoreText = $(tr).find("a.ergebnis-link").text().trim();
    const { home: scoreHome, away: scoreAway, duration, winner } = parseTmScore(scoreText);
    const hasScore = scoreHome !== null;

    // TM always uses HOME:AWAY format — no swapping needed.
    const homeTeamName = isHome ? teamName : opponentName;
    const awayTeamName = isHome ? opponentName : teamName;
    const homeTeamId = isHome ? fdTeamId : 0;
    const awayTeamId = isHome ? 0 : fdTeamId;
    const homeCrest = isHome ? "" : opponentCrestUrl;
    const awayCrest = isHome ? opponentCrestUrl : "";

    // Negative ID to flag as non-football-data.org source.
    // Use absolute day number (no mod 5 aliasing) to guarantee uniqueness per team+date.
    const dayNum = Math.floor(new Date(utcDate).getTime() / 86_400_000);
    const matchId = -((fdTeamId * 100_000 + (dayNum % 100_000)) % 2_000_000_000);

    rows.push({
      id: matchId,
      status: hasScore ? "FINISHED" : "SCHEDULED",
      utcDate,
      matchday: null,
      competition: cupInfo.name,
      competitionCode: cupInfo.code,
      competitionEmblem: "",
      homeTeam: homeTeamName,
      homeTeamId,
      homeTeamCrest: homeCrest,
      awayTeam: awayTeamName,
      awayTeamId,
      awayTeamCrest: awayCrest,
      scoreHome: hasScore ? scoreHome : null,
      scoreAway: hasScore ? scoreAway : null,
      duration: hasScore ? duration : null,
      winner: hasScore ? winner : null,
      etScoreHome: null,
      etScoreAway: null,
      penScoreHome: null,
      penScoreAway: null,
    });
  });

  return rows;
}

export async function fetchTmCupMatches(
  fdTeamId: number,
  teamName: string,
  tmSlug: string,
  tmId: string,
  season: number
): Promise<ScheduleMatch[]> {
  const memKey = `${tmId}:${season}`;
  const dbKey = `/cup-tm/${tmId}/${season}`;

  // L1: in-memory
  const memCached = tmCupCache.get(memKey);
  if (memCached && Date.now() - memCached.fetchedAt < CUP_CACHE_TTL_MS) return memCached.data;

  // L2: Supabase
  const dbCached = await getCached(dbKey);
  if (dbCached) {
    const data = dbCached as ScheduleMatch[];
    tmCupCache.set(memKey, { data, fetchedAt: Date.now() });
    return data;
  }

  const url = `${TM_BASE}/${tmSlug}/spielplan/verein/${tmId}/saison_id/${season}`;
  const html = await tmFetch(url);
  if (!html) return [];

  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");

  const $ = cheerio.load(cleaned);
  const matches: ScheduleMatch[] = [];

  // TM competition sections use <a name="{CODE}"> anchors (e.g. <a name="FAC">).
  // Locate each known cup competition's section and parse its match rows.
  for (const [tmCode, cupInfo] of Object.entries(TM_CUP_INFO)) {
    const anchor = $(`a[name="${tmCode}"]`).first();
    if (!anchor.length) continue;

    const table = findMatchTable(anchor, $);
    if (!table) {
      console.log(`[cupSchedule:TM] No match table found for ${tmCode} (${teamName})`);
      continue;
    }

    const cupMatches = parseTmMatchRows(table, $, fdTeamId, teamName, cupInfo);
    matches.push(...cupMatches);
    console.log(`[cupSchedule:TM] ${cupInfo.name}: ${cupMatches.length} matches for ${teamName}`);
  }

  tmCupCache.set(memKey, { data: matches, fetchedAt: Date.now() });
  if (matches.length > 0) setCached(dbKey, matches, CUP_CACHE_TTL_MS);
  return matches;
}

// Re-export which leagues use which scraper
export { DOMESTIC_CUP_MAP, TM_CUP_LEAGUES };

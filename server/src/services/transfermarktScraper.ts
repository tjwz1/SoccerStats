import { safeFetch as fetch } from "../utils/httpClient";
import * as cheerio from "cheerio";
import type { ClubTrophy } from "./wikiStats";
import { getCached, setCached } from "../db/apiCache";

// TM slugs/IDs are stable for years — persist to avoid re-scraping on every restart
const TM_SEARCH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const BASE = "https://www.transfermarkt.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
  Referer: "https://www.transfermarkt.com/",
};

// Strip scripts, styles, noscript, and link tags from raw HTML before loading into cheerio.
// Measured on TM search page: removes 38 KB (37%) of non-content, shrinking DOM parse input
// from 101 KB to 63 KB and reducing cheerio memory allocation by the same proportion.
function stripNonContent(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<link\b[^>]*>/gi, "");
}

async function tmFetch(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (res.status === 403 || res.status === 429) {
      console.warn(`[transfermarkt] Blocked (${res.status}) for ${url}`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[transfermarkt] HTTP ${res.status} for ${url}`);
      return null;
    }
    const text = await res.text();
    if (text.includes("cf-browser-verification") || text.includes("Just a moment")) {
      console.warn(`[transfermarkt] Cloudflare challenge for ${url}`);
      return null;
    }
    return stripNonContent(text);
  } catch (e) {
    console.warn(`[transfermarkt] Fetch error: ${(e as Error).message}`);
    return null;
  }
}

// ── Shared search helper ──────────────────────────────────────────────────────
// Both club and player lookups hit the same Transfermarkt search endpoint.
// A single helper eliminates the duplication; callers pass the href pattern
// that distinguishes their entity type in the search results.

interface EntityRef { slug: string; id: string; name: string }

// In-process search cache: avoids re-querying TM for the same name within one
// server lifetime (club/player names are stable; this is safe to cache forever).
const tmSearchCache = new Map<string, EntityRef | null>();

async function tmSearch(query: string, hrefPattern: RegExp): Promise<EntityRef | null> {
  const cacheKey = `${hrefPattern.source}:${query}`;
  // L1: in-memory
  if (tmSearchCache.has(cacheKey)) return tmSearchCache.get(cacheKey)!;

  // L2: Supabase — TM slugs are stable, persist to avoid re-scraping on restart.
  // Only use a positive hit from Supabase; a cached null may be from a prior SSL/network failure,
  // so treat it as a miss and run a fresh search so the result can be corrected.
  const dbKey = `/tm-search/${encodeURIComponent(cacheKey)}`;
  const dbCached = await getCached(dbKey);
  if (dbCached !== null) {
    const ref = (dbCached as { ref: EntityRef | null }).ref;
    if (ref !== null) {
      tmSearchCache.set(cacheKey, ref);
      return ref;
    }
    // ref is null — fall through to re-run the search
  }

  const searchUrl =
    `${BASE}/schnellsuche/ergebnis/schnellsuche` +
    `?query=${encodeURIComponent(query)}&x=0&y=0`;
  const html = await tmFetch(searchUrl);
  if (!html) { tmSearchCache.set(cacheKey, null); return null; }

  const $ = cheerio.load(html);
  let best: EntityRef | null = null;

  // Walk every anchor; stop at the first match for the requested entity type.
  $("a[href]").each((_, el) => {
    if (best) return;
    const href = $(el).attr("href") ?? "";
    const m = href.match(hrefPattern);
    if (!m) return;
    const name = $(el).text().trim();
    if (!name) return;
    best = { slug: m[1], id: m[2], name };
  });

  tmSearchCache.set(cacheKey, best);
  // Only persist non-null results — a null from an SSL/network failure shouldn't
  // block retries for 30 days. Re-running the search is cheap (one HTTP call).
  if (best !== null) setCached(dbKey, { ref: best }, TM_SEARCH_TTL_MS);
  return best;
}

// Club links: /{slug}/startseite/verein/{id}
const CLUB_HREF  = /^\/([^/]+)\/startseite\/verein\/(\d+)/;
// Player links: /{slug}/profil/spieler/{id}
const PLAYER_HREF = /^\/([^/]+)\/profil\/spieler\/(\d+)/;

// ── Honours page scraper ──────────────────────────────────────────────────────

const CATEGORY_MAP: [string, string][] = [
  ["international", "European"],
  ["european", "European"],
  ["continental", "European"],
  ["world", "International"],
  ["confederation", "European"],
  ["national", "Domestic"],
  ["domestic", "Domestic"],
  ["league", "Domestic"],
  ["cup", "Domestic"],
  ["super", "Domestic"],
  ["shield", "Domestic"],
  ["other", "Other"],
];

function mapCategory(text: string): string {
  const lower = text.toLowerCase();
  for (const [key, val] of CATEGORY_MAP) {
    if (lower.includes(key)) return val;
  }
  return "Domestic";
}

function extractYears(text: string): string[] {
  return [
    ...new Set(
      Array.from(text.matchAll(/\b(\d{4}(?:[\/\-–]\d{2,4})?)\b/g))
        .map((m) => m[1])
        .filter((y) => {
          const yr = parseInt(y.slice(0, 4), 10);
          return yr > 1870 && yr < 2100;
        })
    ),
  ];
}

// Parse the /erfolge/ honours page HTML.
// Transfermarkt renders grouped sections (one per category) each containing
// a list of trophies. The exact class names have changed over time, so we
// try several selector patterns and fall back gracefully.
function parseHonoursHtml(html: string): ClubTrophy[] {
  const $ = cheerio.load(html);
  const trophies: ClubTrophy[] = [];

  // Strategy A: modern trophyList layout (post-2022 redesign)
  let foundA = false;
  $(".trophyList").each((_, list) => {
    // Category heading sits just before the list in a box-header
    const boxHeader = $(list).closest(".box").find(".content-box-headline, .box-header h2").first().text().trim();
    const category = mapCategory(boxHeader || "domestic");

    $(list).find(".trophyListItem, li").each((_, item) => {
      const name = $(item).find("h2 a, .trophyListItem-title, h3 a").first().text().trim()
        || $(item).children("h2, h3").first().text().trim();
      if (!name || name.length < 3) return;

      const sub = $(item).find(".trophyListItem-details, .trophyListItem-subheadline").text();
      const countMatch = sub.match(/(\d+)\s*(?:×|time|mal|x)/i) ?? sub.match(/×\s*(\d+)/i);

      const years: string[] = [];
      $(item).find("ul li, .season").each((_, li) => {
        const yr = $(li).text().trim();
        if (/^\d{4}/.test(yr)) years.push(yr);
      });

      const count = countMatch ? parseInt(countMatch[1], 10) : Math.max(years.length, 1);
      if (count === 0 && years.length === 0) return;

      trophies.push({ category, name, count: Math.max(count, years.length), years });
      foundA = true;
    });
  });

  if (foundA) return trophies;

  // Strategy B: classic layout — .box wrappers with data-id or .success-title items
  $(".box").each((_, box) => {
    const heading = $(box).find(".content-box-headline, h2.box-headline").first().text().trim();
    if (!heading) return;
    const category = mapCategory(heading);

    // Each trophy is either a .erfolg row or a standalone element with a title + count
    $(box).find("tr, .erfolg-box, li.erfolg").each((_, row) => {
      const name =
        $(row).find(".hauptlink a, .success-title").first().text().trim() ||
        $(row).find("td").eq(0).text().trim();
      if (!name || name.length < 3) return;

      const countText = $(row).find("td").eq(1).text().trim() || "";
      const countMatch = countText.match(/(\d+)/);
      const years = extractYears($(row).text());
      const count = countMatch ? parseInt(countMatch[1], 10) : Math.max(years.length, 1);

      trophies.push({ category, name, count: Math.max(count, years.length), years });
    });
  });

  return trophies;
}

// ── Player URL discovery delegated to tmSearch ────────────────────────────────

// ── Player career stats ───────────────────────────────────────────────────────

export interface TmCareerRow {
  season: string;
  team: string;
  competition: string;
  appearances: number;
  goals: number;
  assists: number;
}

// TM's leistungsdaten page is now client-side rendered (no server-side table).
// Use TM's internal JSON API instead: /ceapi/player/{id}/performance
// Returns current-season stats for ALL competitions including domestic cups.
async function fetchTmPerformanceJson(
  playerId: string,
  teamName: string
): Promise<TmCareerRow[]> {
  const url = `${BASE}/ceapi/player/${playerId}/performance`;
  const text = await fetch(url, {
    headers: {
      ...HEADERS,
      Accept: "application/json, text/plain, */*",
      Referer: `${BASE}/`,
    },
    signal: AbortSignal.timeout(10_000),
    redirect: "follow",
  }).then((r) => (r.ok ? r.text() : null)).catch(() => null);

  if (!text) return [];

  let data: Record<string, any>;
  try { data = JSON.parse(text); } catch { return []; }

  // TM season format: "25/26" → "2025/26"
  function expandSeason(s: string): string {
    const m = s.match(/^(\d{2})\/(\d{2})$/);
    return m ? `20${m[1]}/${m[2]}` : s;
  }

  const rows: TmCareerRow[] = [];
  for (const entry of Object.values(data) as any[]) {
    const apps: number = entry.gamesPlayed ?? 0;
    if (!entry.nameSeason || !entry.competitionDescription || apps === 0) continue;
    rows.push({
      season: expandSeason(entry.nameSeason as string),
      team: teamName,
      competition: entry.competitionDescription as string,
      appearances: apps,
      goals: entry.goalsScored ?? 0,
      assists: entry.assists ?? 0,
    });
  }
  return rows;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Resolve a club's Transfermarkt slug and numeric ID for use in schedule pages. */
export async function getTmClubRef(clubName: string): Promise<{ slug: string; id: string } | null> {
  const ref = await tmSearch(clubName, CLUB_HREF);
  if (!ref) return null;
  return { slug: ref.slug, id: ref.id };
}

export async function scrapeTransfermarktPlayerStats(
  playerName: string,
  currentTeam = ""
): Promise<TmCareerRow[]> {
  const player = await tmSearch(playerName, PLAYER_HREF);
  if (!player) {
    console.log(`[transfermarkt] Player not found for "${playerName}"`);
    return [];
  }
  console.log(`[transfermarkt] Found player "${player.name}" (id=${player.id})`);

  await sleep(200);

  // Use TM's JSON API which returns current-season stats across all competitions
  // (including domestic cups that the football-data.org scorers endpoint misses).
  const rows = await fetchTmPerformanceJson(player.id, currentTeam || player.name);
  console.log(`[transfermarkt] ${playerName} → ${rows.length} current-season rows via ceapi`);
  return rows;
}

export async function scrapeTransfermarktHonours(teamName: string): Promise<ClubTrophy[]> {
  const club = await tmSearch(teamName, CLUB_HREF);
  if (!club) {
    console.log(`[transfermarkt] Club not found for "${teamName}"`);
    return [];
  }
  console.log(`[transfermarkt] Found club "${club.name}" (id=${club.id})`);

  await sleep(200);

  const honoursUrl = `${BASE}/${club.slug}/erfolge/verein/${club.id}`;
  const html = await tmFetch(honoursUrl);
  if (!html) return [];

  const trophies = parseHonoursHtml(html);
  console.log(`[transfermarkt] ${teamName} → ${trophies.length} trophies`);
  return trophies;
}

export async function scrapeTransfermarktPlayerHonours(playerName: string): Promise<ClubTrophy[]> {
  const player = await tmSearch(playerName, PLAYER_HREF);
  if (!player) {
    console.log(`[transfermarkt] Player not found for honours "${playerName}"`);
    return [];
  }
  console.log(`[transfermarkt] Found player "${player.name}" (id=${player.id}) for honours`);

  await sleep(200);

  const honoursUrl = `${BASE}/${player.slug}/erfolge/spieler/${player.id}`;
  const html = await tmFetch(honoursUrl);
  if (!html) return [];

  const raw = parseHonoursHtml(html);
  // TM player achievement pages list each year as a separate <li>, causing
  // year strings like "25/26" or "2024" to be parsed as trophy names.
  // Filter them out — real trophy names contain at least one non-digit letter.
  const trophies = raw.filter(t => /[a-zA-Z]/.test(t.name));
  console.log(`[transfermarkt] ${playerName} → ${trophies.length} player honours (${raw.length - trophies.length} year-only entries filtered)`);
  return trophies;
}

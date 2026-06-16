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
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
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
      signal: AbortSignal.timeout(8_000),
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
    signal: AbortSignal.timeout(6_000),
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
  const ref = await resolveClubRef(clubName);
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
  const club = await resolveClubRef(teamName);
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

// ── Club squad scraper ────────────────────────────────────────────────────────
// Fetches TM's /kader/ (squad) page for a club and returns every registered player.
// Used to supplement fd.org squad data which can be incomplete for some leagues.

export interface TmSquadPlayer {
  name: string;
  position: string; // fd.org-style position string or generic fallback
}

// Map TM full-text position labels (as they appear on the /kader/ page) to the
// same strings that fd.org uses so getRole() can process them directly.
const TM_POS_MAP: Record<string, string> = {
  "goalkeeper":          "Goalkeeper",
  "centre-back":         "Centre-Back",
  "center-back":         "Centre-Back",
  "central defence":     "Centre-Back",
  "sweeper":             "Sweeper",
  "left-back":           "Left-Back",
  "right-back":          "Right-Back",
  "wing-back left":      "Wing-Back (Left)",
  "wing-back right":     "Wing-Back (Right)",
  "left wing-back":      "Wing-Back (Left)",
  "right wing-back":     "Wing-Back (Right)",
  "defensive midfield":  "Defensive Midfield",
  "central midfield":    "Central Midfield",
  "attacking midfield":  "Attacking Midfield",
  "left midfield":       "Left Midfield",
  "right midfield":      "Right Midfield",
  "left winger":         "Left Winger",
  "right winger":        "Right Winger",
  "second striker":      "Second Striker",
  "centre-forward":      "Centre-Forward",
  "center-forward":      "Centre-Forward",
  "striker":             "Centre-Forward",
};

function mapTmPosition(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (TM_POS_MAP[lower]) return TM_POS_MAP[lower];
  // Partial-match fallback
  if (lower.includes("goalkeeper") || lower === "gk") return "Goalkeeper";
  if (lower.includes("back") || lower.includes("defence") || lower.includes("defense") || lower === "cb" || lower === "lb" || lower === "rb") return "Defence";
  if (lower.includes("midfield") || lower === "dm" || lower === "cm" || lower === "am") return "Midfield";
  if (lower.includes("forward") || lower.includes("winger") || lower.includes("striker") || lower === "fw") return "Offence";
  return "Midfield";
}

// TM /kader/ squad page rows: player links matching PLAYER_HREF plus the position
// text that appears in a sibling cell within the same <tr>.
function parseTmSquadHtml(html: string): TmSquadPlayer[] {
  const $ = cheerio.load(html);
  const players: TmSquadPlayer[] = [];
  const seen = new Set<string>();

  // Walk every row in the items table; each player row has a .hauptlink anchor
  // linking to their profile and a position label in an adjacent cell.
  $("table.items tbody tr").each((_, tr) => {
    // Player name from the hauptlink anchor — skip rows with no player link
    const anchor = $(tr).find("td.hauptlink a[href]").first();
    if (!anchor.length) return;

    const href = anchor.attr("href") ?? "";
    if (!PLAYER_HREF.test(href)) return;

    const name = anchor.text().trim();
    if (!name || name.length < 2 || seen.has(name)) return;
    seen.add(name);

    // Position from the "posrela" cell (abbreviated text in a nested <td>)
    // or from cells that contain only a position string.
    const posCell = $(tr).find("td.posrela");
    const posText = posCell.find("td").last().text().trim() || posCell.text().trim();

    players.push({ name, position: mapTmPosition(posText) || "Midfield" });
  });

  return players;
}

const TM_SQUAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 h — squads change at most at transfer deadline

// Maps fd.org club names → TM search queries for clubs whose names don't match TM's catalogue.
// Only needed when fd.org uses a different canonical name than TM (prefixes, year suffixes, etc.)
const TM_CLUB_NAME_ALIASES: Record<string, string> = {
  // Serie A
  "FC Internazionale Milano": "Inter Milan",
  "ACF Fiorentina": "Fiorentina",
  "Atalanta BC": "Atalanta",
  "Bologna FC 1909": "Bologna",
  "Cagliari Calcio": "Cagliari",
  "Genoa CFC": "Genoa",
  "Juventus FC": "Juventus",
  "SS Lazio": "Lazio",
  "SSC Napoli": "Napoli",
  "Parma Calcio 1913": "Parma",
  "Udinese Calcio": "Udinese",
  "Frosinone Calcio": "Frosinone",
  "US Sassuolo Calcio": "Sassuolo",
  "US Lecce": "Lecce",
  "Venezia FC": "Venezia",
  "Como 1907": "Como",
  // Bundesliga
  "1. FC Köln": "FC Köln",
  "TSG 1899 Hoffenheim": "Hoffenheim",
  "1. FSV Mainz 05": "Mainz 05",
  "FC St. Pauli 1910": "FC St. Pauli",
  "1. FC Union Berlin": "Union Berlin",
  "1. FC Heidenheim 1846": "Heidenheim",
  "FC Bayern München": "Bayern Munich",
  // La Liga
  "Club Atlético de Madrid": "Atletico Madrid",
  "RCD Espanyol de Barcelona": "Espanyol",
  "Real Betis Balompié": "Real Betis",
  "Real Sociedad de Fútbol": "Real Sociedad",
  "Deportivo Alavés": "Deportivo Alavés",
  "Rayo Vallecano de Madrid": "Rayo Vallecano",
  // Ligue 1
  "Paris Saint-Germain FC": "Paris Saint-Germain",
  "Stade Rennais FC 1901": "Stade Rennes",
  "AS Monaco FC": "AS Monaco",
  "RC Strasbourg Alsace": "RC Strasbourg",
  "ES Troyes AC": "Troyes",
  "Racing Club de Lens": "Racing Lens",
  "Stade Brestois 29": "Stade Brest",
  "Olympique Lyonnais": "Olympique Lyonnais",
  // Eredivisie
  "AFC Ajax": "Ajax",
  "FC Twente '65": "FC Twente",
  "SC Cambuur-Leeuwarden": "SC Cambuur",
  "Willem II Tilburg": "Willem II",
  "ADO Den Haag": "ADO Den Haag",
  // Brasileirão
  "CA Mineiro": "Atletico Mineiro",
  "Grêmio FBPA": "Grêmio",
  "CA Paranaense": "Atletico Paranaense",
  "SE Palmeiras": "Palmeiras",
  "Botafogo FR": "Botafogo",
  "Cruzeiro EC": "Cruzeiro",
  "Chapecoense AF": "Chapecoense",
  "SC Corinthians Paulista": "Corinthians",
  "CR Vasco da Gama": "Vasco da Gama",
  "EC Bahia": "Bahia",
  "EC Vitória": "Vitória",
  "SC Internacional": "Internacional",
  "Fluminense FC": "Fluminense",
  "Santos FC": "Santos",
  "São Paulo FC": "São Paulo",
  "Coritiba FBC": "Coritiba",
  "Clube do Remo": "Clube do Remo",
  "Mirassol FC": "Mirassol",
  // Primeira Liga
  "Sport Lisboa e Benfica": "SL Benfica",
  "Sporting Clube de Portugal": "Sporting CP",
  "Sporting Clube de Braga": "SC Braga",
  "GD Estoril Praia": "Estoril",
  "Moreirense FC": "Moreirense",
  "Gil Vicente FC": "Gil Vicente",
  "Vitória SC": "Vitória SC",
  "FC Arouca": "Arouca",
  "CF Estrela da Amadora": "Estrela Amadora",
  // Premier League
  "Brighton & Hove Albion FC": "Brighton & Hove Albion",
  "Wolverhampton Wanderers FC": "Wolverhampton Wanderers",
};

/** Resolve TM search query for a club: try raw name, fall back to alias if not found. */
async function resolveClubRef(clubName: string): Promise<EntityRef | null> {
  const ref = await tmSearch(clubName, CLUB_HREF);
  if (ref) return ref;
  const alias = TM_CLUB_NAME_ALIASES[clubName];
  if (!alias) return null;
  console.log(`[transfermarkt] Retrying "${clubName}" as "${alias}"`);
  return tmSearch(alias, CLUB_HREF);
}

export async function getTmClubSquad(clubName: string, season: number): Promise<TmSquadPlayer[]> {
  const club = await resolveClubRef(clubName);
  if (!club) {
    console.log(`[transfermarkt] Club not found for squad "${clubName}"`);
    return [];
  }

  const dbKey = `/tm-squad/${club.id}/${season}`;
  const cached = await getCached(dbKey);
  if (cached) return cached as TmSquadPlayer[];

  await sleep(200);

  const url = `${BASE}/${club.slug}/kader/verein/${club.id}/saison_id/${season}`;
  const html = await tmFetch(url);
  if (!html) {
    console.log(`[transfermarkt] Squad page unavailable for "${clubName}" (${url})`);
    return [];
  }

  const players = parseTmSquadHtml(html);
  console.log(`[transfermarkt] ${clubName} → ${players.length} players from squad page (season ${season})`);

  if (players.length > 0) setCached(dbKey, players, TM_SQUAD_TTL_MS);
  return players;
}

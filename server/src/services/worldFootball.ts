import { safeFetch as fetch } from "../utils/httpClient";
import * as cheerio from "cheerio";
import { getCached, setCached } from "../db/apiCache";

const BASE = "https://www.worldfootball.net";
const WF_SLEEP_MS = 500;
const WF_CAREER_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

const HEADERS = {
  "User-Agent": "SoccerStatsApp/1.0 (educational project; contact: thomasjzhao@gmail.com)",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface WfCareerRow {
  season: string;
  team: string;
  competition: string;
  appearances: number;
  goals: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Strip scripts/styles before cheerio to reduce DOM parse cost.
function stripNonContent(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
}

async function wfFetch(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(3_000),
      redirect: "follow",
    });
    if (!res.ok) {
      console.warn(`[worldfootball] HTTP ${res.status} for ${url}`);
      return null;
    }
    const text = await res.text();
    if (text.includes("captcha") || text.includes("bot detection")) {
      console.warn(`[worldfootball] Bot detection triggered for ${url}`);
      return null;
    }
    return stripNonContent(text);
  } catch (e) {
    console.warn(`[worldfootball] Fetch error: ${(e as Error).message}`);
    return null;
  }
}

// Normalize a player name to a worldfootball.net slug:
// lowercase, diacritics stripped, spaces to hyphens.
function toWfSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

// Verify a worldfootball.net player summary page looks valid
// (not a 404-page or search redirect).
function isValidProfilePage(html: string): boolean {
  return html.includes("player_summary") && !html.includes("No results found") && !html.includes("Sorry, we could");
}

// Search worldfootball.net and return the first player profile slug.
async function findPlayerSlug(playerName: string): Promise<string | null> {
  // First attempt: direct slug guess from the player's name.
  const directSlug = toWfSlug(playerName);
  const directUrl = `${BASE}/player_summary/${directSlug}/`;
  const directHtml = await wfFetch(directUrl);
  if (directHtml && isValidProfilePage(directHtml)) {
    return directSlug;
  }

  await sleep(WF_SLEEP_MS);

  // Second attempt: search endpoint.
  const searchUrl = `${BASE}/suchen/en/spieler/${encodeURIComponent(toWfSlug(playerName))}/`;
  const searchHtml = await wfFetch(searchUrl);
  if (!searchHtml) return null;

  const $ = cheerio.load(searchHtml);
  let slug: string | null = null;

  $("a[href*='/player_summary/']").each((_, el) => {
    if (slug) return;
    const href = $(el).attr("href") ?? "";
    const m = href.match(/\/player_summary\/([^/]+)\//);
    if (m) slug = m[1];
  });

  return slug;
}

// Parse career stats table from a worldfootball.net player summary page.
// The site uses .standard_tabelle for career tables; row structure:
// Season | Club | Competition | Apps | Goals
function parseWfCareerTable(html: string): WfCareerRow[] {
  const $ = cheerio.load(html);
  const rows: WfCareerRow[] = [];

  $("table.standard_tabelle").each((_, table) => {
    if (rows.length > 0) return;

    const headerRow = $(table).find("tr").first();
    const headers = headerRow
      .find("th, td")
      .map((_, th) => $(th).text().trim().toLowerCase())
      .get();

    // Need at least a season and team column to be a career table
    const seasonIdx = headers.findIndex((h) => h.includes("season") || h.includes("year"));
    const teamIdx = headers.findIndex((h) => h.includes("club") || h.includes("team"));
    if (seasonIdx === -1 || teamIdx === -1) return;

    const compIdx = headers.findIndex((h) => h.includes("competition") || h.includes("league") || h.includes("cup"));
    const appsIdx = headers.findIndex(
      (h) => h === "apps" || h === "games" || h === "pld" || h.includes("appearance") || h.includes("game")
    );
    const goalsIdx = headers.findIndex(
      (h) => h === "goals" || h === "gls" || h === "goal" || h.includes("goal")
    );
    if (appsIdx === -1 || goalsIdx === -1) return;

    $(table)
      .find("tr")
      .slice(1)
      .each((_, tr) => {
        const cells = $(tr).find("td");
        if (cells.length < 3) return;

        const season = $(cells.eq(seasonIdx)).text().trim();
        if (!season || !/\d{4}/.test(season)) return;
        if (season.toLowerCase().includes("total") || season.toLowerCase().includes("career")) return;

        const team = $(cells.eq(teamIdx)).text().trim();
        if (!team) return;

        const competition = compIdx !== -1 ? $(cells.eq(compIdx)).text().trim() : "";
        const apps = parseInt($(cells.eq(appsIdx)).text().replace(/\D/g, "") || "0", 10);
        const goals = parseInt($(cells.eq(goalsIdx)).text().replace(/\D/g, "") || "0", 10);

        // Normalise season format: "2010-11" → "2010/11", "2010-2011" → "2010/11"
        const normSeason = season
          .replace(/[–—]/g, "-")
          .replace(/^(\d{4})-(\d{4})$/, (_, y1, y2) => `${y1}/${y2.slice(2)}`)
          .replace(/^(\d{4})-(\d{2})$/, (_, y1, y2) => `${y1}/${y2}`);

        rows.push({ season: normSeason, team, competition, appearances: apps, goals });
      });
  });

  return rows;
}

export async function fetchWorldFootballCareer(playerName: string): Promise<WfCareerRow[]> {
  const cacheKey = `/wf-career/${encodeURIComponent(playerName)}`;

  const cached = await getCached(cacheKey);
  if (cached) return cached as WfCareerRow[];

  const slug = await findPlayerSlug(playerName);
  if (!slug) {
    console.log(`[worldfootball] No player found for "${playerName}"`);
    // Cache miss (not null) so we don't retry every request
    return [];
  }

  await sleep(WF_SLEEP_MS);

  const profileUrl = `${BASE}/player_summary/${slug}/`;
  const html = await wfFetch(profileUrl);
  if (!html) return [];

  const rows = parseWfCareerTable(html);
  console.log(`[worldfootball] "${playerName}" → ${rows.length} career rows`);

  // Cache even if empty: a miss means the player has no structured table,
  // and re-scraping on every request wastes resources.
  setCached(cacheKey, rows, WF_CAREER_TTL).catch(() => {});

  return rows;
}

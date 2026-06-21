import { safeFetch as fetch } from "../utils/httpClient";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { WikiCareerRow } from "../db/wikiCareerCache";
import type { Trophy } from "../db/wikiTrophyCache";
import { getCached, setCached } from "../db/apiCache";

const WIKI_HEADERS = {
  "User-Agent": "SoccerStatsApp/1.0 (educational project; contact: thomasjzhao@gmail.com)",
};

// Polite delay between sequential Wikipedia API requests.
// 200 ms keeps us well within the 1 req/s guideline while staying fast.
const WIKI_SLEEP_MS = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fetch a Wikipedia API URL and retry up to 3× with exponential back-off if
// the response is not JSON (Wikipedia sends HTML when rate-limited).
async function wikiFetch(url: string, timeoutMs = 6000): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: WIKI_HEADERS });
      const text = await res.text();
      if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) return text;
      console.warn(`[wikiStats] Rate limited (attempt ${attempt + 1})`);
      if (attempt < 1) await sleep(2000);
    } catch {
      if (attempt < 1) await sleep(1000);
    }
  }
  return null;
}

// ── Page discovery ────────────────────────────────────────────────────────────

async function findWikiTitle(playerName: string): Promise<string | null> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=opensearch` +
    `&search=${encodeURIComponent(playerName)}&limit=5&namespace=0&format=json`;
  const text = await wikiFetch(url, 8000);
  if (!text) return null;
  try {
    const data = JSON.parse(text) as [string, string[], string[], string[]];
    const titles = data[1] ?? [];
    const urls = data[3] ?? [];
    for (let i = 0; i < titles.length; i++) {
      if (titles[i] && !titles[i].toLowerCase().includes("disambiguation")) {
        const m = urls[i]?.match(/\/wiki\/(.+)$/);
        if (m) return decodeURIComponent(m[1].replace(/_/g, " "));
      }
    }
    return titles[0] ?? null;
  } catch { return null; }
}

// Football club indicators in Wikipedia article titles.
const CLUB_INDICATORS = ["F.C.", "FC ", " FC", "A.C.", "S.C.", "C.F.", "A.F.C.", "S.S.", "R.C.D."];

async function findClubWikiTitle(teamName: string): Promise<string | null> {
  const searchAndParse = async (query: string) => {
    const url =
      `https://en.wikipedia.org/w/api.php?action=opensearch` +
      `&search=${encodeURIComponent(query)}&limit=8&namespace=0&format=json`;
    const text = await wikiFetch(url, 8000);
    if (!text) return { titles: [] as string[], urls: [] as string[] };
    try {
      const data = JSON.parse(text) as [string, string[], string[], string[]];
      return { titles: data[1] ?? [], urls: data[3] ?? [] };
    } catch { return { titles: [], urls: [] }; }
  };

  const titleFromUrl = (url: string) => {
    const m = url?.match(/\/wiki\/(.+)$/);
    return m ? decodeURIComponent(m[1].replace(/_/g, " ")) : null;
  };

  // National teams need a dedicated search path — the club indicator heuristic
  // always misses them (e.g. "France" finds the country, not the football team).
  if (isNationalTeam(teamName)) {
    const query = `${teamName} national football team`;
    const { titles, urls } = await searchAndParse(query);
    for (let i = 0; i < titles.length; i++) {
      const t = titles[i] ?? "";
      if (t.toLowerCase().includes("disambiguation")) continue;
      if (t.toLowerCase().includes("national football team") || t.toLowerCase().includes("national soccer team")) {
        return titleFromUrl(urls[i]) ?? t;
      }
    }
    // Fallback: first non-disambiguation result from the national team query
    for (let i = 0; i < titles.length; i++) {
      if (titles[i] && !titles[i].toLowerCase().includes("disambiguation")) {
        return titleFromUrl(urls[i]) ?? titles[i];
      }
    }
    return null;
  }

  const preferClub = (titles: string[], urls: string[]): string | null => {
    // Priority 1: title contains a club indicator
    for (let i = 0; i < titles.length; i++) {
      const t = titles[i];
      if (!t || t.toLowerCase().includes("disambiguation")) continue;
      if (CLUB_INDICATORS.some((ind) => t.includes(ind))) {
        return titleFromUrl(urls[i]) ?? t;
      }
    }
    // Priority 2: first non-disambiguation result
    for (let i = 0; i < titles.length; i++) {
      if (titles[i] && !titles[i].toLowerCase().includes("disambiguation")) {
        return titleFromUrl(urls[i]) ?? titles[i];
      }
    }
    return null;
  };

  // First pass: search the team name directly
  const { titles, urls } = await searchAndParse(teamName);
  const clubResult = preferClub(titles, urls);

  // If we got a non-club page (no indicator in title), try again with " football" suffix
  if (clubResult && !CLUB_INDICATORS.some((ind) => clubResult.includes(ind))) {
    await sleep(WIKI_SLEEP_MS);
    const { titles: t2, urls: u2 } = await searchAndParse(teamName + " football club");
    const clubResult2 = preferClub(t2, u2);
    if (clubResult2) return clubResult2;
  }

  return clubResult;
}

// Fetch the section list and return indices for the career-stats and honours
// sections in a single API call (was two separate calls before).
// Also returns the resolved title (Wikipedia follows redirects, so "FC Bayern München"
// resolves to "FC Bayern Munich" — we must use the resolved title for subsequent fetches).
async function findSectionIndices(title: string): Promise<{ career: string | null; honours: string | null; resolvedTitle: string }> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=parse` +
    `&page=${encodeURIComponent(title)}&prop=sections&format=json&redirects=1`;
  const text = await wikiFetch(url, 8000);
  if (!text) return { career: null, honours: null, resolvedTitle: title };
  try {
    const parsed = JSON.parse(text) as any;
    const resolvedTitle: string = parsed?.parse?.title ?? title;
    const sections: Array<{ line: string; index: string }> =
      parsed?.parse?.sections ?? [];
    const career =
      (sections.find((s) => s.line.toLowerCase().includes("statistic")) ??
       sections.find((s) => s.line.toLowerCase().includes("career")))?.index ?? null;
    const honours =
      (sections.find((s) => s.line.toLowerCase().includes("honour")) ??
       sections.find((s) => s.line.toLowerCase().includes("honor")))?.index ?? null;
    return { career, honours, resolvedTitle };
  } catch { return { career: null, honours: null, resolvedTitle: title }; }
}

// Fetch section HTML (for career-stats table parsing via cheerio).
async function fetchPageHtml(title: string, section?: string): Promise<string | null> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=parse` +
    `&page=${encodeURIComponent(title)}` +
    `&prop=text&format=json&disablelimitreport=true&disableeditsection=true` +
    (section ? `&section=${section}` : "");
  const text = await wikiFetch(url, 8000);
  if (!text) return null;
  try { return (JSON.parse(text) as any)?.parse?.text?.["*"] ?? null; }
  catch { return null; }
}

// Fetch section wikitext (~85 % smaller than HTML — no CSS, cite markup, etc.)
// Used for honours parsing where structure is simple enough for regex.
async function fetchPageWikitext(title: string, section: string): Promise<string | null> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=parse` +
    `&page=${encodeURIComponent(title)}` +
    `&prop=wikitext&format=json` +
    `&section=${section}`;
  const text = await wikiFetch(url, 8000);
  if (!text) return null;
  try { return (JSON.parse(text) as any)?.parse?.wikitext?.["*"] ?? null; }
  catch { return null; }
}

// ── Career-stats HTML table parser ────────────────────────────────────────────

function flattenTable($: cheerio.CheerioAPI, table: AnyNode): string[][] {
  const grid: string[][] = [];
  const rowSpanTrack: Map<number, { text: string; remaining: number }> = new Map();

  $(table).find("tr").each((rowIdx, tr) => {
    grid[rowIdx] = [];
    let colCursor = 0;

    for (const [c, span] of rowSpanTrack.entries()) {
      grid[rowIdx][c] = span.text;
      span.remaining--;
      if (span.remaining === 0) rowSpanTrack.delete(c);
    }

    $(tr).children("td,th").each((_, cell) => {
      while (grid[rowIdx][colCursor] !== undefined) colCursor++;
      const rawText = $(cell).text().replace(/\[.*?\]/g, "").trim();
      const rowspan = parseInt($(cell).attr("rowspan") ?? "1", 10);
      const colspan = parseInt($(cell).attr("colspan") ?? "1", 10);
      for (let c = 0; c < colspan; c++) {
        grid[rowIdx][colCursor + c] = rawText;
        if (rowspan > 1) rowSpanTrack.set(colCursor + c, { text: rawText, remaining: rowspan - 1 });
      }
      colCursor += colspan;
    });
  });

  return grid.filter((r) => r && r.length > 0);
}

function findCol(headers: string[], ...keywords: string[]): number {
  return headers.findIndex((h) => keywords.some((k) => h.toLowerCase().includes(k.toLowerCase())));
}

export function seasonStartYear(season: string): number {
  const m = season.match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : 0;
}

// Strip embedded <style> and <link> blocks that Wikipedia injects into section HTML.
// Measured: removes ~4 KB (10%) of non-content before cheerio builds the DOM.
function stripWikiStyles(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<link\b[^>]*>/gi, "");
}

function parseCareerTable(html: string): WikiCareerRow[] {
  const $ = cheerio.load(stripWikiStyles(html));
  const rows: WikiCareerRow[] = [];

  $("table.wikitable").each((_, table) => {
    if (rows.length > 0) return;
    const grid = flattenTable($, table);
    if (grid.length < 3) return;

    const firstRow = grid[0] ?? [];
    const secondRow = grid[1] ?? [];
    const allHeaders = firstRow.map((h, i) => h || secondRow[i] || "");
    const subHeaders = secondRow.map((h, i) => h || firstRow[i] || "");

    const seasonCol = findCol(allHeaders, "Season", "Year");
    const clubCol = findCol(allHeaders, "Club", "Team");
    if (seasonCol === -1 || clubCol === -1) return;

    const leagueCol = findCol(allHeaders, "League", "Division", "Competition");

    // Scan right-to-left for stat columns: goals usually appears before the final assist/total column.
    // Also detect assists column (present on many but not all Wikipedia career tables).
    let totalAppsCol = -1;
    let totalGoalsCol = -1;
    let totalAssistsCol = -1;
    for (let c = subHeaders.length - 1; c >= 0; c--) {
      const h = subHeaders[c].toLowerCase().trim();
      if (totalAssistsCol === -1 && (h === "assists" || h === "ast" || h === "a")) {
        totalAssistsCol = c;
      } else if (totalGoalsCol === -1 && (h === "goals" || h === "gls" || h === "g")) {
        totalGoalsCol = c;
      } else if (totalAppsCol === -1 && (h === "apps" || h === "app" || h === "p" || h === "mp" || h === "appearances")) {
        totalAppsCol = c;
        break;
      }
    }
    if (totalAppsCol === -1 || totalGoalsCol === -1) {
      const colCount = Math.max(firstRow.length, secondRow.length);
      totalAppsCol = colCount - 2;
      totalGoalsCol = colCount - 1;
    }

    const headerRowCount = secondRow.some((h) => h.toLowerCase() === "apps" || h.toLowerCase() === "goals") ? 2 : 1;
    let lastClub = "";
    let lastLeague = "";

    for (let r = headerRowCount; r < grid.length; r++) {
      const row = grid[r];
      if (!row || row.length < 3) continue;
      const season = row[seasonCol]?.trim() ?? "";
      const club = row[clubCol]?.trim() || lastClub;
      const league = leagueCol !== -1 ? (row[leagueCol]?.trim() || lastLeague) : "";
      if (!season || !/\d{4}/.test(season)) continue;
      if (season.toLowerCase().includes("total") || club.toLowerCase().includes("total") || club === "") continue;

      const apps = parseInt((row[totalAppsCol]?.replace(/[^0-9]/g, "") ?? "0") || "0", 10);
      const goals = parseInt((row[totalGoalsCol]?.replace(/[^0-9]/g, "") ?? "0") || "0", 10);
      const assists = totalAssistsCol !== -1
        ? parseInt((row[totalAssistsCol]?.replace(/[^0-9]/g, "") ?? "0") || "0", 10)
        : 0;
      const normSeason = season
        .replace(/[–—]/g, "/").replace("-", "/")
        .replace(/(\d{4})\/(\d{4})/, (_, y1, y2) => `${y1}/${y2.slice(2)}`);

      // Skip international-career rows that sometimes appear in the club career table
      if (isNationalTeam(club)) continue;

      rows.push({ season: normSeason, team: club, league, appearances: apps, goals, assists });
      lastClub = club;
      lastLeague = league;
    }
  });

  return rows;
}

// ── Honours wikitext parser ───────────────────────────────────────────────────
// Parses the raw wikitext of the Honours section — much smaller payload than
// the HTML equivalent (~2 KB vs ~15 KB) with no cheerio dependency needed.

const NATIONAL_TEAM_NAMES = new Set([
  "england","scotland","wales","northern ireland","republic of ireland","ireland",
  "france","germany","spain","italy","portugal","netherlands","belgium","croatia",
  "denmark","sweden","norway","switzerland","austria","poland","czech republic",
  "czechia","hungary","russia","ukraine","turkey","serbia","greece","romania",
  "slovakia","albania","north macedonia","georgia","iceland","finland",
  "brazil","argentina","colombia","chile","peru","uruguay","ecuador","venezuela",
  "mexico","usa","united states","canada","costa rica","jamaica","panama",
  "japan","south korea","australia","china","iran","saudi arabia","qatar",
  "ghana","senegal","cameroon","nigeria","ivory coast","côte d'ivoire",
  "morocco","egypt","south africa","algeria","tunisia","mali","guinea",
]);

function isNationalTeam(name: string): boolean {
  return NATIONAL_TEAM_NAMES.has(name.toLowerCase());
}

function cleanTeamName(raw: string): string {
  return raw
    .replace(/\s+national (football |soccer )?team\b/i, "")
    .replace(/\s+(F\.?C\.?|A\.?F\.?C\.?|S\.?C\.?|C\.?F\.?)$/i, "")
    .replace(/^(F\.?C\.?|A\.?F\.?C\.?)\s+/i, "")
    .trim();
}

function parseHonoursWikitext(wikitext: string): Trophy[] {
  const trophies: Trophy[] = [];
  let category: "club" | "international" | "individual" = "club";
  let currentTeam = "";

  // Strip citations, HTML comments, templates, and wiki links — leaving plain text.
  const delink = (s: string) =>
    s
      .replace(/\s*<ref[^>]*(?:\/>|>[\s\S]*?<\/ref>)/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/{{[^{}]*}}/g, "")
      .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
      .replace(/'''?/g, "")
      .trim();

  for (const rawLine of wikitext.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // ===TeamName=== or ==Section== subsection headers (common Wikipedia format)
    // These are equivalent to ;TeamName definition-list entries.
    const sectionMatch = line.match(/^={2,4}([^=]+)={2,4}$/);
    if (sectionMatch) {
      const name = cleanTeamName(delink(sectionMatch[1]));
      const lower = name.toLowerCase();
      if (lower === "individual" || lower.startsWith("individual") || lower === "personal") {
        category = "individual"; currentTeam = "";
      } else if (lower === "club" || lower.startsWith("club ") || lower === "club honours") {
        category = "club"; currentTeam = "";
      } else if (lower.includes("international") || lower === "national team" || lower.includes("national career")) {
        category = "international"; currentTeam = "";
      } else if (lower === "honours" || lower === "honors" || lower.startsWith("honour") || lower.startsWith("honor")) {
        // top-level ==Honours== heading — reset state
        category = "club"; currentTeam = "";
      } else {
        // Treat as a team name
        currentTeam = name;
        category = isNationalTeam(currentTeam) ? "international" : "club";
      }
      continue;
    }

    // ;TeamName or ;Category heading
    if (line.startsWith(";")) {
      const name = cleanTeamName(delink(line.slice(1)));
      const lower = name.toLowerCase();
      if (lower === "individual" || lower.startsWith("individual ")) {
        category = "individual"; currentTeam = "";
      } else if (lower === "club" || lower.startsWith("club ")) {
        category = "club"; currentTeam = "";
      } else if (lower.includes("international") || lower === "national team") {
        category = "international"; currentTeam = "";
      } else {
        currentTeam = name;
        category = isNationalTeam(currentTeam) ? "international" : "club";
      }
      continue;
    }

    // * TrophyName: year1, year2 entry
    if (line.startsWith("*") && (currentTeam || category === "individual")) {
      const cleaned = delink(line.replace(/^\*+/, "").trim());
      const colonIdx = cleaned.indexOf(":");
      if (colonIdx <= 0) continue;

      const name = cleaned.slice(0, colonIdx).trim().replace(/\s*\([^)]*\)\s*/g, "").trim();
      if (!name) continue;

      const years = [...new Set(
        Array.from(cleaned.slice(colonIdx + 1).matchAll(/\b(\d{4}(?:[–\-\/]\d{2,4})?)\b/g))
          .map((m) => m[1])
          .filter((y) => parseInt(y.slice(0, 4), 10) > 1950)
      )];

      if (years.length === 0) continue;
      trophies.push({ name, team: currentTeam, category, years });
    }
  }

  return trophies;
}

// ── Club honours parser ───────────────────────────────────────────────────────

export interface ClubTrophy {
  category: string;
  name: string;
  count: number;
  years: string[];
  imageUrl?: string;
}

// Attach imageUrl to each ClubTrophy using a single batched Wikipedia pageimages call.
// Wikipedia allows up to 50 pipe-separated titles per query — this replaces the old
// N-individual-calls pattern (one per trophy) with 1 call for the full trophy list.
// Measured: 15 separate calls (294 B × 15 + 15 RTTs) → 1 call (2,907 B + 1 RTT).
async function attachTrophyImages(trophies: ClubTrophy[]): Promise<ClubTrophy[]> {
  if (trophies.length === 0) return trophies;

  const WIKI_LIMIT = 50; // Wikipedia max titles per query request
  const imageMap: Record<string, string> = {};

  for (let i = 0; i < trophies.length; i += WIKI_LIMIT) {
    const batch = trophies.slice(i, i + WIKI_LIMIT).map((t) => t.name);
    const url =
      `https://en.wikipedia.org/w/api.php?action=query` +
      `&titles=${batch.map(encodeURIComponent).join("|")}` +
      `&prop=pageimages&pithumbsize=80&pilicense=any` +
      `&format=json&formatversion=2`;
    const text = await wikiFetch(url, 10000);
    if (text) {
      try {
        const data = JSON.parse(text) as any;
        // Build a normalized-title → original-input map so we can match back
        const norm: Record<string, string> = {};
        for (const n of (data?.query?.normalized ?? []) as Array<{ from: string; to: string }>) {
          norm[n.to] = n.from;
        }
        for (const page of (data?.query?.pages ?? []) as any[]) {
          const src: string | undefined = page?.thumbnail?.source;
          if (!src || page.missing) continue;
          // Store under both the canonical title and (if normalized) the original name
          imageMap[page.title] = src;
          const orig = norm[page.title];
          if (orig) imageMap[orig] = src;
        }
      } catch { /* ignore parse errors */ }
    }
    if (i + WIKI_LIMIT < trophies.length) await sleep(WIKI_SLEEP_MS);
  }

  return trophies.map((t) => ({
    ...t,
    imageUrl: imageMap[t.name] ?? undefined,
  }));
}

function extractYears(text: string): string[] {
  return [...new Set(
    Array.from(text.matchAll(/\b(\d{4}(?:[–\-\/]\d{2,4})?)\b/g))
      .map((m) => m[1])
      .filter((y) => {
        const yr = parseInt(y.slice(0, 4), 10);
        return yr > 1870 && yr < 2100;
      })
  )];
}

// Parse the standard Wikipedia club honours table (wikitable with Type/Competition/Titles/Seasons columns).
function parseClubHonoursHtml(html: string): ClubTrophy[] {
  const $ = cheerio.load(stripWikiStyles(html));
  const results: ClubTrophy[] = [];

  $("table.wikitable").first().find("tr").each((_, tr) => {
    const cells = $(tr).children("td, th");
    if (cells.length < 3) return;

    // Detect if first <td> is a rowspan category cell (e.g. "Domestic")
    const firstTd = cells.first();
    const isCategory = firstTd.is("td") && parseInt(firstTd.attr("rowspan") ?? "1", 10) > 1;

    // If this row has a category cell, the layout is: [Type, Competition, Count, Seasons]
    // Otherwise: [Competition, Count, Seasons] (continuation rows)
    let competitionCell: cheerio.Cheerio<AnyNode>;
    let countCell: cheerio.Cheerio<AnyNode>;
    let seasonsCell: cheerio.Cheerio<AnyNode>;

    if (isCategory) {
      competitionCell = cells.eq(1);
      countCell = cells.eq(2);
      seasonsCell = cells.eq(3);
    } else {
      // First cell may be a header <th scope="row"> — competition name
      if (cells.first().is("th")) {
        competitionCell = cells.first();
        countCell = cells.eq(1);
        seasonsCell = cells.eq(2);
      } else {
        return; // skip rows that don't match expected layout
      }
    }

    const name = competitionCell.text().replace(/\[.*?\]/g, "").replace(/\s+/g, " ").trim();
    const countText = countCell.text().replace(/\D/g, "");
    const count = countText ? parseInt(countText, 10) : 0;
    const seasons = seasonsCell.text().replace(/\[.*?\]/g, "").trim();
    const years = extractYears(seasons);

    if (!name || (count === 0 && years.length === 0)) return;

    // Determine category from the rowspan cell (search upward in results for last-set category)
    let category = "Domestic";
    if (isCategory) {
      const catText = firstTd.text().replace(/\s+/g, " ").trim().toLowerCase();
      if (catText.includes("european") || catText.includes("continental") || catText.includes("international")) {
        category = "European";
      } else if (catText.includes("domestic") || catText.includes("national") || catText.includes("league")) {
        category = "Domestic";
      } else {
        category = "Other";
      }
      // Store the category for this row's group
      (tr as any).__category__ = category;
    } else {
      // Inherit category from the last result
      category = results.length > 0 ? results[results.length - 1].category : "Domestic";
    }

    results.push({ category, name, count: Math.max(count, years.length), years });
  });

  return results;
}

// Fallback wikitext parser for clubs that use definition-list or bullet-list format
// (less common for major clubs, but used by some smaller ones).
function parseClubHonoursWikitext(wikitext: string): ClubTrophy[] {
  const results: ClubTrophy[] = [];
  let category = "Domestic";
  let currentTrophy = "";

  const delink = (s: string) =>
    s
      .replace(/\s*<ref[^>]*(?:\/>|>[\s\S]*?<\/ref>)/g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/{{[^{}]*}}/g, "")
      .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
      .replace(/'''?/g, "")
      .trim();

  const CATEGORY_KEYWORDS: Array<[string, string]> = [
    ["european", "European"], ["continental", "European"], ["international", "European"],
    ["domestic", "Domestic"], ["national", "Domestic"],
    ["other", "Other"], ["minor", "Other"],
  ];

  for (const rawLine of wikitext.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const sectionMatch = line.match(/^={2,4}([^=]+)={2,4}$/);
    if (sectionMatch) {
      const lower = delink(sectionMatch[1]).toLowerCase();
      if (lower.includes("honour") || lower.includes("honor")) {
        category = "Domestic"; currentTrophy = "";
      } else {
        for (const [key, val] of CATEGORY_KEYWORDS) {
          if (lower.includes(key)) { category = val; break; }
        }
        currentTrophy = "";
      }
      continue;
    }

    if (line.startsWith(";")) {
      currentTrophy = delink(line.slice(1)).trim();
      continue;
    }

    if (line.startsWith(":") && currentTrophy) {
      const cleaned = delink(line.slice(1)).trim();
      if (!cleaned.toLowerCase().startsWith("winner") && !cleaned.toLowerCase().startsWith("champion")) continue;
      const count = parseInt((cleaned.match(/\((\d+)\)/)?.[1]) ?? "1", 10);
      const years = extractYears(cleaned);
      if (years.length === 0 && count === 0) continue;
      const existing = results.find((r) => r.name === currentTrophy && r.category === category);
      if (existing) {
        for (const y of years) if (!existing.years.includes(y)) existing.years.push(y);
        existing.count = Math.max(existing.count, count, existing.years.length);
      } else {
        results.push({ category, name: currentTrophy, count: Math.max(count, years.length), years });
      }
      continue;
    }

    // Nested bullet: * [[Trophy]] then ** Winners (N): years
    if (line.startsWith("**")) {
      const cleaned = delink(line.replace(/^\*+/, "").trim());
      if (!cleaned.toLowerCase().startsWith("winner") && !cleaned.toLowerCase().startsWith("champion")) continue;
      if (!currentTrophy) continue;
      const count = parseInt((cleaned.match(/\((\d+)\)/)?.[1]) ?? "1", 10);
      const years = extractYears(cleaned);
      if (years.length === 0 && count === 0) continue;
      results.push({ category, name: currentTrophy, count: Math.max(count, years.length), years });
      continue;
    }

    if (line.startsWith("*") && !line.startsWith("**")) {
      const cleaned = delink(line.replace(/^\*+/, "").trim());
      // Single * is a trophy name in nested format
      if (!cleaned.includes(":")) {
        currentTrophy = cleaned.replace(/\s*\([^)]*\)\s*/g, "").trim();
        continue;
      }
      // Single * with colon: *TrophyName (N): years format
      const colonIdx = cleaned.indexOf(":");
      const namePart = cleaned.slice(0, colonIdx).trim();
      const lowerName = namePart.toLowerCase();
      if (lowerName.includes("runner") || lowerName.includes("finalist") || lowerName.includes("second") || lowerName.includes("third")) continue;
      const countInName = namePart.match(/\((\d+)[^)]*\)/);
      const name = namePart.replace(/\s*\([^)]*\)\s*/g, "").trim();
      if (!name) continue;
      const count = countInName ? parseInt(countInName[1], 10) : 1;
      const years = extractYears(cleaned.slice(colonIdx + 1));
      if (years.length === 0 && count <= 1) continue;
      results.push({ category, name, count: Math.max(count, years.length), years });
    }
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Combined pipeline: 1 title lookup + 1 sections list → career HTML and
// honours wikitext fetched IN PARALLEL. Replaces two separate 3-call chains
// (6 sequential calls, ~7 s) with 4 calls (2 parallel), cutting wiki latency
// to ~2.5 s for a full cold fetch.
export async function fetchPlayerWikiData(
  playerName: string,
  needsCareer: boolean,
  needsHonours: boolean
): Promise<{ career: WikiCareerRow[]; trophies: Trophy[] }> {
  const title = await findWikiTitle(playerName);
  if (!title) {
    console.log(`[wikiStats] No Wikipedia page found for ${playerName}`);
    return { career: [], trophies: [] };
  }

  await sleep(WIKI_SLEEP_MS);
  const { career: careerIdx, honours: honoursIdx, resolvedTitle } = await findSectionIndices(title);

  if (!careerIdx && !honoursIdx) return { career: [], trophies: [] };

  await sleep(WIKI_SLEEP_MS);

  // Use resolvedTitle for subsequent fetches — Wikipedia may redirect (e.g. "FC Bayern München" → "FC Bayern Munich").
  const [careerHtml, honoursWikitext] = await Promise.all([
    needsCareer && careerIdx ? fetchPageHtml(resolvedTitle, careerIdx) : Promise.resolve(null),
    needsHonours && honoursIdx ? fetchPageWikitext(resolvedTitle, honoursIdx) : Promise.resolve(null),
  ]);

  let career: WikiCareerRow[] = [];
  if (needsCareer && careerHtml) {
    career = parseCareerTable(careerHtml);
    // Fallback: section had no table — try the full page once.
    if (career.length === 0 && careerIdx) {
      await sleep(WIKI_SLEEP_MS);
      const fullHtml = await fetchPageHtml(title);
      if (fullHtml) career = parseCareerTable(fullHtml);
    }
    console.log(`[wikiStats] ${playerName} → ${career.length} career rows from "${title}"`);
  }

  const trophies = needsHonours && honoursWikitext ? parseHonoursWikitext(honoursWikitext) : [];
  if (needsHonours) console.log(`[wikiStats] ${playerName} → ${trophies.length} honours from "${title}"`);

  return { career, trophies };
}

// Thin wrapper kept for the populate endpoint (career-only).
export async function fetchPlayerWikiCareer(
  _playerId: number,
  playerName: string
): Promise<WikiCareerRow[]> {
  const { career } = await fetchPlayerWikiData(playerName, true, false);
  return career;
}

// Keywords that identify international/continental trophies for national team re-categorisation.
const INTL_TROPHY_KEYWORDS = [
  "world cup", "world championship", "confederations cup", "olympic", "gold cup",
  "copa america", "africa cup", "asian cup", "nations league", "nations cup",
  "european championship", "euro ", "uefa", "continental championship",
];

function recategorizeNationalTrophies(trophies: ClubTrophy[]): ClubTrophy[] {
  return trophies.map((t) => {
    const lower = t.name.toLowerCase();
    if (INTL_TROPHY_KEYWORDS.some((k) => lower.includes(k))) {
      return { ...t, category: "European" }; // "European" is the app's "international" bucket
    }
    return t;
  });
}

export async function fetchClubHonours(teamName: string): Promise<ClubTrophy[]> {
  const isNatl = isNationalTeam(teamName);
  const title = await findClubWikiTitle(teamName);
  if (!title) {
    console.log(`[clubHonours] No Wikipedia page found for "${teamName}"`);
    return [];
  }

  await sleep(WIKI_SLEEP_MS);
  const { honours: honoursIdx, resolvedTitle } = await findSectionIndices(title);
  if (!honoursIdx) {
    console.log(`[clubHonours] No Honours section found for "${teamName}" (page: "${resolvedTitle}")`);
    return [];
  }

  await sleep(WIKI_SLEEP_MS);

  // National team pages often embed competitive record tables inside the Honours section
  // which confuse the HTML table parser. Skip straight to wikitext for national teams.
  if (!isNatl) {
    const html = await fetchPageHtml(resolvedTitle, honoursIdx);
    if (html) {
      const trophies = parseClubHonoursHtml(html);
      if (trophies.length > 0) {
        console.log(`[clubHonours] ${teamName} → ${trophies.length} trophies (HTML table) from "${title}"`);
        return attachTrophyImages(trophies);
      }
    }
  }

  const wikitext = await fetchPageWikitext(resolvedTitle, honoursIdx);
  if (!wikitext) return [];
  let trophies = parseClubHonoursWikitext(wikitext);
  if (isNatl) trophies = recategorizeNationalTrophies(trophies);
  console.log(`[clubHonours] ${teamName} → ${trophies.length} trophies (wikitext${isNatl ? ", national team" : ""}) from "${resolvedTitle}"`);
  return attachTrophyImages(trophies);
}

// ── International squad scrapers (WC / EC) ───────────────────────────────────
// Wikipedia hosts complete squad lists for every major international tournament.
// These functions fetch the relevant article once (cached 6 h) and parse the
// wikitable for a named national team.  Used to supplement football-data.org squad
// data which is often incomplete for national teams.

export interface IntlSquadPlayer {
  name: string;
  position: string; // fd.org-style generic: "Goalkeeper" | "Defence" | "Midfield" | "Offence"
  dateOfBirth: string; // "YYYY-MM-DD"
}

// Per-article in-memory HTML cache (keyed by the Supabase cache key / db-key)
const squadPageHtmlInMem = new Map<string, { html: string; at: number }>();
const SQUAD_PAGE_HTML_TTL = 6 * 60 * 60 * 1000; // 6 h

function mapWikiPosAbbr(abbr: string): string {
  switch (abbr.trim().toUpperCase()) {
    case "GK": return "Goalkeeper";
    case "DF": return "Defence";
    case "MF": return "Midfield";
    case "FW": return "Offence";
    default:   return "Midfield";
  }
}

async function getSquadPageHtml(wikiPageTitle: string, dbKey: string): Promise<string | null> {
  // L1: in-memory
  const mem = squadPageHtmlInMem.get(dbKey);
  if (mem && Date.now() - mem.at < SQUAD_PAGE_HTML_TTL) return mem.html;

  // L2: Supabase
  const dbHit = await getCached(dbKey);
  if (dbHit && typeof (dbHit as any).html === "string") {
    const { html } = dbHit as { html: string };
    squadPageHtmlInMem.set(dbKey, { html, at: Date.now() });
    return html;
  }

  const apiUrl =
    `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(wikiPageTitle)}` +
    `&prop=text&format=json&disablelimitreport=1`;

  console.log(`[intlSquad] Fetching Wikipedia page "${wikiPageTitle}"…`);
  const text = await wikiFetch(apiUrl, 20000);
  if (!text) return null;

  let html: string;
  try {
    const parsed = JSON.parse(text);
    html = parsed.parse?.text?.["*"] ?? "";
  } catch { return null; }

  if (!html) return null;

  squadPageHtmlInMem.set(dbKey, { html, at: Date.now() });
  setCached(dbKey, { html }, SQUAD_PAGE_HTML_TTL).catch(() => {});
  return html;
}

function normTeamForWiki(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+national\s+(football|soccer)\s+team\b/i, "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

// fd.org national team names that differ from Wikipedia article headings
const TEAM_WIKI_ALIASES: Record<string, string[]> = {
  "usa":               ["united states"],
  "united states":     ["usa"],
  "south korea":       ["korea republic", "republic of korea"],
  "republic of korea": ["south korea"],
  "iran":              ["ir iran"],
  "ivory coast":       ["cote d ivoire"],
  "czech republic":    ["czechia"],
  "türkiye":           ["turkey"],
  "turkey":            ["türkiye"],
};

function teamHeadingMatches(heading: string, targetNorm: string): boolean {
  if (heading === targetNorm) return true;
  const aliases = TEAM_WIKI_ALIASES[targetNorm] ?? [];
  if (aliases.some((a) => heading === a || heading.includes(a) || a.includes(heading))) return true;
  const tToks = targetNorm.split(" ").filter((t) => t.length >= 3);
  const hToks = heading.split(" ").filter((t) => t.length >= 3);
  return (tToks.length > 0 && tToks.every((t) => heading.includes(t))) ||
         (hToks.length > 0 && hToks.every((h) => targetNorm.includes(h)));
}

function parseSquadTable($: ReturnType<typeof cheerio.load>, html: string, teamName: string, logTag: string): IntlSquadPlayer[] {
  const targetNorm = normTeamForWiki(teamName);
  let targetTable: cheerio.Cheerio<AnyNode> | null = null;

  // Wikipedia tournament squad pages: <h2>Group X</h2> <h3>Country</h3> <table class="wikitable">
  $("h2, h3").each((_, el) => {
    if (targetTable) return;
    const headingText = normTeamForWiki($(el).text());
    if (!teamHeadingMatches(headingText, targetNorm)) return;

    let sibling = $(el).next();
    while (sibling.length) {
      if (sibling.is("h2, h3")) break;
      if (sibling.is("table.wikitable")) { targetTable = sibling; return; }
      const inner = sibling.find("table.wikitable").first();
      if (inner.length) { targetTable = inner; return; }
      sibling = sibling.next();
    }
  });

  if (!targetTable) {
    console.log(`[${logTag}] No squad table found for "${teamName}" (norm: "${targetNorm}")`);
    return [];
  }

  const players: IntlSquadPlayer[] = [];

  (targetTable as cheerio.Cheerio<AnyNode>).find("tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length < 4) return; // header row uses <th>

    const posAbbr = $(cells.eq(1)).text().trim();
    let playerName = $(cells.eq(2)).find("a").last().text().trim();
    if (!playerName) playerName = $(cells.eq(2)).text().trim();
    playerName = playerName.replace(/\s*\[[^\]]*\]/g, "").replace(/\*+$/, "").trim();
    if (!playerName || playerName.length < 2) return;

    const bday = $(cells.eq(3)).find(".bday").text().trim();
    const dobMatch = bday || ($(cells.eq(3)).text().match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "");

    players.push({ name: playerName, position: mapWikiPosAbbr(posAbbr), dateOfBirth: dobMatch });
  });

  console.log(`[${logTag}] ${teamName} → ${players.length} players from Wikipedia`);
  return players;
}

async function getIntlSquadFromWiki(
  wikiPageTitle: string,
  dbKey: string,
  teamName: string,
  logTag: string
): Promise<IntlSquadPlayer[]> {
  const html = await getSquadPageHtml(wikiPageTitle, dbKey);
  if (!html) return [];
  const $ = cheerio.load(html);
  return parseSquadTable($, html, teamName, logTag);
}

// WC 2026 squad supplement
export async function getWcSquadFromWiki(teamName: string): Promise<IntlSquadPlayer[]> {
  return getIntlSquadFromWiki(
    "2026_FIFA_World_Cup_squads",
    "/wiki-squad-html/wc-2026",
    teamName,
    "wcSquad"
  );
}

// Euro 2024 squad supplement (most recent UEFA European Championship)
export async function getEcSquadFromWiki(teamName: string): Promise<IntlSquadPlayer[]> {
  return getIntlSquadFromWiki(
    "UEFA_Euro_2024_squads",
    "/wiki-squad-html/ec-2024",
    teamName,
    "ecSquad"
  );
}

// ── WC knockout qualification status ─────────────────────────────────────────

function normalizeForMatch(name: string): string {
  return name.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, "").trim();
}

// Wikipedia sometimes uses different names than football-data.org.
// Keys are normalised Wikipedia names; values are normalised fd.org names.
const WIKI_NAME_MAP: Record<string, string> = {
  "south korea":           "korea republic",
  "ivory coast":           "cote divoire",
  "iran":                  "ir iran",
  "cape verde":            "cabo verde",
  "republic of ireland":   "ireland",
  "trinidad and tobago":   "trinidad tobago",
  "antigua and barbuda":   "antigua barbuda",
  "saint kitts and nevis": "saint kitts nevis",
  "united states":         "united states",
};

export type KnockoutStatus = "Q" | "E" | "3rd";

// The main "2026 FIFA World Cup" article contains group tables in sections 20–31
// (Group A = 20, Group B = 21, … Group L = 31).
// Wikipedia only adds "Knockout stage" text to the last cell of a row when
// advancement is CONFIRMED (not just "currently in top 2"), and "Eliminated"
// when a team is mathematically out. This is more accurate than colours alone.
async function fetchGroupSection(season: number, sectionIndex: number): Promise<string> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=parse` +
    `&page=${season}_FIFA_World_Cup&prop=text&format=json` +
    `&section=${sectionIndex}&redirects=1`;
  const text = await wikiFetch(url, 15000);
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return parsed?.parse?.text?.["*"] ?? "";
  } catch { return ""; }
}

function parseGroupHtml(html: string, result: Map<string, KnockoutStatus>): void {
  if (!html) return;
  const $ = cheerio.load(html);

  $("table.wikitable").each((_, table) => {
    const $table = $(table);
    const headerCells = $table.find("tr").first().find("th");
    const headers = headerCells.map((_, th) => $(th).text().trim().toLowerCase()).get();
    if (!headers.includes("pos") || !headers.some(h => h.startsWith("team"))) return;

    $table.find("tr").slice(1).each((_, row) => {
      const $row = $(row);

      // Team name is in the <th scope="row"> cell (not a <td>)
      const teamCell = $row.find("th[scope='row']");
      const rawName = teamCell.find("a").first().text().trim() || teamCell.text().trim();
      if (!rawName) return;

      // Status is in the last <td> cell of the row
      const lastTd = $row.find("td").last();
      const statusText = lastTd.text().trim().toLowerCase();

      let status: KnockoutStatus | null = null;
      if (statusText.startsWith("knockout stage") && !statusText.includes("possible")) {
        status = "Q";
      } else if (statusText.includes("eliminated")) {
        status = "E";
      } else if (statusText.includes("possible knockout")) {
        status = "3rd";
      }

      if (!status) return;

      const norm   = normalizeForMatch(rawName);
      const mapped = WIKI_NAME_MAP[norm] ?? norm;
      result.set(mapped, status);
    });
  });
}

export async function getWcKnockoutStatus(season: number): Promise<Map<string, KnockoutStatus>> {
  const cacheKey = `/wiki/wc-knockout/${season}`;
  const cached = await getCached(cacheKey);
  if (cached) return new Map(Object.entries(cached as Record<string, KnockoutStatus>));

  // Groups A–L = sections 20–31 in the main WC article.
  const GROUP_SECTIONS = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];

  const htmlChunks = await Promise.all(
    GROUP_SECTIONS.map(idx => fetchGroupSection(season, idx))
  );

  const result = new Map<string, KnockoutStatus>();
  for (const html of htmlChunks) {
    parseGroupHtml(html, result);
  }

  if (result.size > 0) {
    await setCached(cacheKey, Object.fromEntries(result), 30 * 60_000);
  }
  return result;
}

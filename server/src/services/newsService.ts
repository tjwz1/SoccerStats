import { safeFetch as fetch } from "../utils/httpClient";
import * as cheerio from "cheerio";

export interface NewsArticle {
  title: string;
  url: string;
  source: string;
  publishedAt: string; // ISO string
}

export interface NewsResponse {
  digest: string[];
  articles: NewsArticle[];
}

const cache = new Map<string, { data: NewsArticle[]; fetchedAt: number }>();
const NEWS_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ─── Digest algorithm ───────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","from",
  "by","as","into","through","is","are","was","were","be","been","being","have",
  "has","had","do","does","did","will","would","could","should","may","might",
  "must","shall","can","that","this","these","those","not","no","up","out",
  "over","more","most","very","just","also","than","then","now","all","both",
  "each","few","some","such","only","own","same","so","too","s","t","don",
  "what","which","who","how","when","where","why","new","says","say","amid",
  "ahead","set","back","make","get","still","first","last","next","after",
  "before","between","since","while","without","his","her","their","its",
  "our","your","him","them","us","we","he","she","it","i","you","they",
  "about","one","two","three","four","five","six","seven","eight","nine","ten",
  "per","off","on","up","down","away","home","here","there","every","around",
]);

// Generic words that are capitalised in football headlines but aren't names
const GENERIC_CAPS = new Set([
  // Competitions
  "premier","league","champions","europa","cup","fa","efl","carabao","world",
  "super","serie","bundesliga","ligue","laliga","eredivisie","allsvenskan",
  "final","semi","round","group","playoff",
  // Club words & common abbreviations
  "club","fc","afc","united","utd","city","man","town","rovers","wanderers",
  "athletic","albion","wednesday","hotspur","villa","palace","forest","spurs",
  "gunners","reds","blues","toffees","saints","hammers","foxes","wolves",
  "magpies","hornets","bees","seagulls","baggies","clarets","robins",
  // Premier League & common European club names
  "arsenal","chelsea","liverpool","tottenham","manchester","everton","fulham",
  "brentford","brighton","newcastle","westham","astonvilla","crystal",
  "nottingham","bournemouth","leicester","ipswich","southampton","wolves",
  "realmadrid","barcelona","atletico","juventus","milan","inter","napoli",
  "psg","paris","dortmund","bayern","ajax","benfica","porto","sporting",
  // Roles
  "manager","coach","boss","player","captain","goalkeeper","striker","winger",
  "defender","midfielder","forward","bench","squad","team","side","xi","staff",
  // Time
  "monday","tuesday","wednesday","thursday","friday","saturday","sunday",
  "january","february","march","april","may","june","july","august",
  "september","october","november","december","season","summer","winter",
  // Media language
  "report","update","news","latest","deal","confirm","confirmed","revealed",
  "exclusive","source","claims","says","said","told","speaks","live","breaking",
  "transfer","window","bid","fee","move","swap","loan","free",
  // Nationalities / regions
  "english","spanish","french","german","italian","dutch","portuguese",
  "brazilian","argentine","belgian","swedish","norwegian","danish",
  "international","national","domestic","european","british",
  // Generic football terms
  "football","soccer","match","game","fixture","result","goal","goals",
  "score","scores","points","table","standing","standings","debut",
]);

const TRANSFER_RE = /\b(sign|signs|signed|signing|transfer|bid|deal|loan|linked|link|move|join|joins|joined|fee|target|targets|sell|sold|depart|departure|release|released|agree|agreed|complete|completed|pursue|interest|want|wants|wanted|approach|approaches|approached|talks|negotiat\w*|swoop|snap.up|snap\s+up|hijack|pipped|race.for|race\s+for|swapped?)\b/i;
const INJURY_RE   = /\b(injur\w*|miss\w*|doubt\w*|ruled.out|absence|absent|return\w*|fitness|fit\b|unfit|hamstring|knee|ankle|calf|surgery|recover\w*|setback|unavailable|sidelined?)\b/i;
const RESULT_RE   = /\b(beat|beats|win|wins|won|draw|draws|drew|defeat\w*|lost|loss|score\w*|goal|goals|victory|victories|thrash\w*|overcome)\b/i;
const MANAGER_RE  = /\b(manager|sack\w*|appoint\w*|resign\w*|contract|extend\w*|renew\w*|hire[sd]?|dismiss\w*|coaching|technical.director)\b/i;

// Story-stage signals, checked from most to least specific
const TRANSFER_SIGNALS: Array<[RegExp, string]> = [
  [/\b(confirm\w*|done|complet\w*|signed?|agreed?|official|sealed?)\b/i, "a deal is reported to be confirmed"],
  [/\b(imminent|breakthrough|boost|progress\w*|advanc\w*|clos\w*)\b/i,  "talks appear to be progressing"],
  [/\b(blow|collaps\w*|pull.out|pulled.out|reject\w*|stall\w*|fail\w*|fell.through|setback)\b/i, "reports suggest complications in negotiations"],
  [/\b(want\w*|target\w*|interest\w*|link\w*|pursu\w*|chasing?|eye[sd]?|watch\w*|approach\w*)\b/i, "transfer interest has been reported"],
];

const INJURY_SIGNALS: Array<[RegExp, string]> = [
  [/\b(return\w*|recover\w*|back|fit\b|cleared)\b/i, "a return from injury is being tracked"],
  [/\b(injur\w*|miss\w*|doubt\w*|ruled.out|sidelined?|unavailable|setback|surgery)\b/i, "a fitness or availability concern has been flagged"],
];

const MANAGER_SIGNALS: Array<[RegExp, string]> = [
  [/\b(sack\w*|fire[sd]?|dismiss\w*|left.the.club|resign\w*)\b/i, "a managerial departure is being covered"],
  [/\b(appoint\w*|confirm\w*|new.manager|hired?)\b/i,              "a managerial appointment is in the news"],
  [/\b(contract|extend\w*|renew\w*|sign\w*)\b/i,                   "contract matters are being reported"],
];

// Known clubs: ordered longest-key-first so "real madrid" matches before "madrid"
const CLUB_DISPLAY: Array<[string, string]> = [
  ["real madrid",        "Real Madrid"],
  ["manchester city",    "Man City"],
  ["manchester united",  "Man Utd"],
  ["aston villa",        "Aston Villa"],
  ["crystal palace",     "Crystal Palace"],
  ["nottingham forest",  "Nott'm Forest"],
  ["west ham",           "West Ham"],
  ["atletico madrid",    "Atletico Madrid"],
  ["borussia dortmund",  "Dortmund"],
  ["inter milan",        "Inter Milan"],
  ["ac milan",           "AC Milan"],
  ["arsenal",            "Arsenal"],
  ["chelsea",            "Chelsea"],
  ["liverpool",          "Liverpool"],
  ["tottenham",          "Tottenham"],
  ["everton",            "Everton"],
  ["fulham",             "Fulham"],
  ["brentford",          "Brentford"],
  ["brighton",           "Brighton"],
  ["newcastle",          "Newcastle"],
  ["bournemouth",        "Bournemouth"],
  ["leicester",          "Leicester"],
  ["ipswich",            "Ipswich"],
  ["southampton",        "Southampton"],
  ["atletico",           "Atletico Madrid"],
  ["barcelona",          "Barcelona"],
  ["juventus",           "Juventus"],
  ["napoli",             "Napoli"],
  ["dortmund",           "Dortmund"],
  ["milan",              "AC Milan"],
  ["inter",              "Inter Milan"],
  ["psg",                "PSG"],
  ["ajax",               "Ajax"],
  ["benfica",            "Benfica"],
  ["porto",              "Porto"],
  ["celtic",             "Celtic"],
  ["rangers",            "Rangers"],
  ["spurs",              "Tottenham"],
  ["wolves",             "Wolves"],
];

function matchSignal(text: string, signals: Array<[RegExp, string]>): string | null {
  for (const [re, label] of signals) if (re.test(text)) return label;
  return null;
}

function primaryCategory(titles: string[]): "transfer" | "injury" | "result" | "manager" | "general" {
  const counts = { transfer: 0, injury: 0, result: 0, manager: 0 };
  for (const t of titles) {
    if (TRANSFER_RE.test(t)) counts.transfer++;
    if (INJURY_RE.test(t))   counts.injury++;
    if (RESULT_RE.test(t))   counts.result++;
    if (MANAGER_RE.test(t))  counts.manager++;
  }
  const max = Math.max(...Object.values(counts));
  if (max === 0) return "general";
  const winner = (Object.keys(counts) as Array<keyof typeof counts>).find((k) => counts[k] === max)!;
  return winner as "transfer" | "injury" | "result" | "manager";
}

// Extract clubs mentioned in headlines, excluding the team being viewed
function extractClubs(titles: string[], excludeLower: Set<string>): string[] {
  const combined = titles.join(" ").toLowerCase();
  const found = new Set<string>();
  const usedDisplayNames = new Set<string>();

  for (const [key, display] of CLUB_DISPLAY) {
    if (usedDisplayNames.has(display)) continue;
    const keyWords = key.split(" ");
    if (keyWords.every((w) => excludeLower.has(w))) continue; // skip viewed team
    if (combined.includes(key)) {
      found.add(display);
      usedDisplayNames.add(display);
    }
  }
  return [...found].slice(0, 3);
}

// Extract reported transfer fee from headlines (e.g. £45m, €80 million)
function extractFee(titles: string[]): string | null {
  const combined = titles.join(" ");
  const m = combined.match(/[£€$]\s*(\d+(?:\.\d+)?)\s*(m\b|million|bn\b|billion)/i);
  if (m) {
    const num = m[1];
    const unit = /^b/i.test(m[2]) ? "bn" : "m";
    return `£${num}${unit}`;
  }
  if (/\bfree transfer\b|\bout of contract\b|\bbosman\b/i.test(combined)) return "free transfer";
  return null;
}

// Detect injury body part and timeline from headlines
function extractInjuryDetails(titles: string[]): { bodyPart: string | null; timeline: string | null } {
  const combined = titles.join(" ").toLowerCase();
  const BODY_PARTS = ["hamstring", "achilles", "shoulder", "groin", "muscle", "knee", "ankle", "calf", "thigh", "foot", "hip", "back"];
  const bodyPart = BODY_PARTS.find((p) => combined.includes(p)) ?? null;

  let timeline: string | null = null;
  const weeks = titles.join(" ").match(/(\w+)\s+weeks?\s+out|\bout\s+for\s+(\w+)\s+weeks?/i);
  const until = titles.join(" ").match(/out\s+until\s+(\w+)/i);
  if (weeks) timeline = `${(weeks[1] ?? weeks[2]).toLowerCase()} weeks`;
  else if (until) timeline = `out until ${until[1]}`;

  return { bodyPart, timeline };
}

function buildBullet(entity: string, count: number, titles: string[], excludeLower: Set<string>): string {
  const combined = titles.join(" ");
  const n = count === 1 ? "1 report" : `${count} reports`;
  const cat = primaryCategory(titles);

  if (cat === "transfer") {
    const signal = matchSignal(combined, TRANSFER_SIGNALS) ?? "transfer activity reported";
    const clubs = extractClubs(titles, excludeLower);
    const fee = extractFee(titles);
    const isLoan = /\bloan\b/i.test(combined);

    const details: string[] = [];
    if (clubs.length > 0) details.push(`clubs involved: ${clubs.join(", ")}`);
    if (isLoan) details.push("loan move reported");
    if (fee) details.push(`fee: ${fee}`);

    const suffix = details.length ? ` — ${details.join(", ")}` : "";
    return `${entity} (${n}): ${signal}${suffix}.`;
  }

  if (cat === "injury") {
    const signal = matchSignal(combined, INJURY_SIGNALS) ?? "injury news in the media";
    const { bodyPart, timeline } = extractInjuryDetails(titles);

    const details: string[] = [];
    if (bodyPart) details.push(`${bodyPart} concern`);
    if (timeline) details.push(timeline);

    const suffix = details.length ? ` — ${details.join(", ")}` : "";
    return `${entity} (${n}): ${signal}${suffix}.`;
  }

  if (cat === "manager") {
    const signal = matchSignal(combined, MANAGER_SIGNALS) ?? "coaching matters covered";
    return `${entity} (${n}): ${signal}.`;
  }

  if (cat === "result") {
    return `${entity} (${n}): featured prominently in match coverage.`;
  }

  return `${entity} (${n}): generating coverage across multiple stories.`;
}

// Find entities (person names) that appear across 2+ different article titles.
// Extracts consecutive runs of valid capitalised tokens so "Julian Alvarez" is
// treated as one entity rather than two. Component single tokens are dropped
// whenever a longer form covering the same person exists with 2+ mentions.
function findEntities(
  articles: NewsArticle[],
  excludeLower: Set<string>,
): Array<{ entity: string; idxs: Set<number> }> {
  const map = new Map<string, Set<number>>();

  function isValidToken(raw: string): string | null {
    const clean = raw.replace(/[^a-zA-Z]/g, "");
    if (clean.length < 2 || !/^[A-Z]/.test(clean)) return null;
    const lower = clean.toLowerCase();
    if (STOP_WORDS.has(lower) || GENERIC_CAPS.has(lower) || excludeLower.has(lower)) return null;
    return clean;
  }

  function addToMap(key: string, idx: number) {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(idx);
  }

  articles.forEach((article, idx) => {
    const tokens = article.title.split(/[\s\-–—,.:;!?'"()\[\]/]+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      const w0 = isValidToken(tokens[i]);
      if (!w0) { i++; continue; }

      const w1 = i + 1 < tokens.length ? isValidToken(tokens[i + 1]) : null;
      const w2 = i + 2 < tokens.length ? isValidToken(tokens[i + 2]) : null;

      // Register all valid-length name forms starting at position i
      addToMap(w0, idx);
      if (w1) {
        addToMap(`${w0} ${w1}`, idx);
        if (w2) addToMap(`${w0} ${w1} ${w2}`, idx);
      }

      i++;
    }
  });

  const entries = [...map.entries()].filter(([, s]) => s.size >= 2);

  // Absorb any entity whose tokens appear as a contiguous sub-sequence inside a
  // longer entity. e.g. "Eli Junior Kroupi" absorbs "Eli Junior", "Junior Kroupi",
  // "Eli", "Junior", and "Kroupi" — prefix, suffix, and all interior single tokens.
  const absorbed = new Set<string>();
  for (const [longer] of entries) {
    const lp = longer.split(" ");
    if (lp.length < 2) continue;
    for (const [shorter] of entries) {
      if (shorter === longer) continue;
      const sp = shorter.split(" ");
      if (sp.length >= lp.length) continue;
      // Check if sp appears as a contiguous run anywhere inside lp
      const fits = lp.some((_, start) =>
        start + sp.length <= lp.length && sp.every((w, i) => lp[start + i] === w)
      );
      if (fits) absorbed.add(shorter);
    }
  }

  return entries
    .filter(([entity]) => !absorbed.has(entity))
    .sort(([, a], [, b]) => b.size - a.size)
    .map(([entity, idxs]) => ({ entity, idxs }));
}

export function generateDigest(articles: NewsArticle[], teamName: string): string[] {
  if (articles.length === 0) return [];

  const excludeLower = new Set(
    teamName.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z]/g, "")).filter(Boolean)
  );

  const entities = findEntities(articles, excludeLower);

  if (entities.length === 0) {
    return [`${articles.length} recent stories covering ${teamName}.`];
  }

  // One bullet per top entity (up to 4), each telling a distinct story
  return entities.slice(0, 4).map(({ entity, idxs }) => {
    const titles = [...idxs].map((i) => articles[i].title);
    return buildBullet(entity, idxs.size, titles, excludeLower);
  });
}

// Strip generic suffixes/prefixes that don't help search relevance
function searchQuery(teamName: string): string {
  const stripped = teamName
    .replace(/\bF\.?C\.?\b/gi, "")
    .replace(/\bA\.?F\.?C\.?\b/gi, "")
    .replace(/\s+Football\s+Club\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${stripped} football`;
}

export async function fetchTeamNews(teamName: string): Promise<NewsResponse> {
  const cacheKey = teamName.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < NEWS_TTL_MS) {
    return { digest: generateDigest(cached.data, teamName), articles: cached.data };
  }

  const q = searchQuery(teamName);
  const url =
    `https://news.google.com/rss/search` +
    `?q=${encodeURIComponent(q)}&hl=en-GB&gl=GB&ceid=GB:en`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RSS/2.0 reader)",
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!res.ok) {
      console.warn(`[news] HTTP ${res.status} for "${teamName}"`);
      return { digest: [], articles: [] };
    }
    // Detect HTML error pages (rate-limited 200s from Google) before XML parsing
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/html")) {
      console.warn(`[news] Rate-limited or blocked for "${teamName}" (content-type: ${ct})`);
      return { digest: [], articles: [] };
    }

    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const articles: NewsArticle[] = [];

    $("item").each((_, el) => {
      const $el = $(el);

      // <title> in Google News RSS is "Headline - Source Name"
      const rawTitle = $el.find("title").first().text().trim();
      const sourceName = $el.find("source").first().text().trim();

      // Strip the trailing " - Source" suffix that Google appends
      const title = sourceName && rawTitle.endsWith(` - ${sourceName}`)
        ? rawTitle.slice(0, -(` - ${sourceName}`).length).trim()
        : rawTitle.replace(/\s+-\s+\S[^-]*$/, "").trim();

      // <link> in RSS XML is a text node sibling of the closing tag — use <guid> as reliable fallback
      const link =
        $el.find("link").text().trim() ||
        $el.find("guid").text().trim();

      const pubDate = $el.find("pubDate").text().trim();

      if (!title || !link) return;

      articles.push({
        title,
        url: link,
        source: sourceName || "Unknown",
        publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      });
    });

    // Deduplicate: keep only the first article per normalised title prefix
    // (Google RSS often returns the same story from multiple outlets in a row)
    const seen = new Set<string>();
    const deduped = articles.filter((a) => {
      const key = a.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60).trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const data = deduped.slice(0, 20);
    cache.set(cacheKey, { data, fetchedAt: Date.now() });
    console.log(`[news] "${teamName}" → ${data.length} articles (${articles.length - deduped.length} dupes removed)`);
    return { digest: generateDigest(data, teamName), articles: data };
  } catch (e) {
    console.warn(`[news] Fetch error for "${teamName}": ${(e as Error).message}`);
    return { digest: [], articles: [] };
  }
}

import { safeFetch as fetch } from "../utils/httpClient";
import * as cheerio from "cheerio";
import { getAnyCached, setCached } from "../db/apiCache";
import { summarizeNews } from "./aiSummary";
import { resolveGoogleNewsUrls } from "./googleNewsUrl";

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

// ─── AI digest: body scraping + windowing + dedup + truncation ───────────────

const DIGEST_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — LLM call is expensive
const DAY_MS = 24 * 60 * 60 * 1000;
const SCRAPE_TIMEOUT_MS = 6_000;
const SCRAPE_CONCURRENCY = 5;
const MAX_WORDS_PER_ARTICLE = 350;
const MAX_TOTAL_WORDS = 6_000;

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Extract the main article text from a raw HTML page with cheerio: prefer a real
// <article>, else the block element whose concatenated <p> text is longest.
function extractArticleText(html: string): string {
  const $ = cheerio.load(html);
  $("script,style,nav,aside,footer,header,figure,form,noscript,iframe").remove();

  const pText = (el: cheerio.Cheerio<any>): string =>
    collapseWhitespace(
      el
        .find("p")
        .map((_, p) => $(p).text())
        .get()
        .join(" ")
    );

  const article = $("article").first();
  if (article.length) {
    const t = pText(article);
    if (t.length >= 200) return t;
  }

  let best = "";
  $("main, [role=main], .article-body, .article__body, .story-body, .content, #content, section, div").each(
    (_, el) => {
      const t = pText($(el));
      if (t.length > best.length) best = t;
    }
  );
  if (best.length >= 200) return best;

  // Last resort: all <p> on the page.
  return pText($("body"));
}

// Fetch each url and return url -> main text. Failures/paywalls are simply omitted.
export async function fetchArticleBodies(urls: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = [...new Set(urls)];

  async function worker() {
    for (;;) {
      const url = queue.shift();
      if (!url) return;
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml",
          },
          signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
          redirect: "follow",
        });
        if (!res.ok) continue;
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("html")) continue;
        const html = await res.text();
        const text = extractArticleText(html);
        if (text.length >= 200) out.set(url, text);
      } catch {
        // omit this url
      }
    }
  }

  await Promise.allSettled(
    Array.from({ length: Math.min(SCRAPE_CONCURRENCY, queue.length) }, worker)
  );
  return out;
}

// Cheap near-duplicate check: token Jaccard on the first N words. Repeated wire
// copy across outlets scores high and gets dropped.
function firstWordsTokenSet(text: string, n: number): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, n)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= maxWords ? text : words.slice(0, maxWords).join(" ");
}

// Assemble the text blob handed to the LLM from the in-window articles.
// `resolvedByUrl` maps a Google News redirect link to the real publisher URL that
// `bodies` is keyed by; a missing entry means the link never resolved and we fall
// back to the RSS <description> snippet.
export function buildDigestInput(
  recent: NewsArticle[],
  bodies: Map<string, string>,
  descByUrl: Map<string, string>,
  resolvedByUrl: Map<string, string> = new Map()
): string {
  const kept: Array<{ source: string; text: string }> = [];
  const keptSets: Set<string>[] = [];

  for (const a of recent) {
    const body = bodies.get(resolvedByUrl.get(a.url) ?? a.url);
    const raw = body
      ? body
      : descByUrl.get(a.url)
        ? `${a.title}. ${descByUrl.get(a.url)}`
        : a.title;
    const text = collapseWhitespace(raw);
    if (!text) continue;

    const sig = firstWordsTokenSet(text, 40);
    if (keptSets.some((s) => jaccard(s, sig) > 0.7)) continue;

    kept.push({ source: a.source, text: truncateWords(text, MAX_WORDS_PER_ARTICLE) });
    keptSets.push(sig);
  }

  let total = 0;
  const blocks: string[] = [];
  for (const { source, text } of kept) {
    const words = text.split(/\s+/).filter(Boolean).length;
    if (total + words > MAX_TOTAL_WORDS) break;
    total += words;
    blocks.push(`「${source}」\n${text}`);
  }
  return blocks.join("\n\n---\n\n");
}

// Compute the digest: try the AI summary over scraped bodies, fall back to the
// heuristic. Cached under team-news-digest:<teamId> at 6h TTL, independent of the
// 15-min article cache — a warm digest skips scraping + the LLM entirely.
async function computeDigest(
  teamName: string,
  teamId: string,
  data: NewsArticle[],
  descByUrl: Map<string, string>
): Promise<string[]> {
  const digestKey = `team-news-digest:${teamId}`;

  // 24h window; widen to 48h if too thin. Full `data` still drives `articles`.
  let recent = data.filter((a) => Date.parse(a.publishedAt) >= Date.now() - DAY_MS);
  if (recent.length < 3) {
    recent = data.filter((a) => Date.parse(a.publishedAt) >= Date.now() - 2 * DAY_MS);
  }

  if (recent.length === 0) {
    return [`Quiet news day — no major ${teamName} stories in the last 24 hours.`];
  }

  const cached = await getAnyCached(digestKey);
  if (cached && !cached.stale && Array.isArray(cached.data) && cached.data.length) {
    return cached.data as string[];
  }
  const staleFallback =
    cached && Array.isArray(cached.data) && cached.data.length ? (cached.data as string[]) : null;

  try {
    // Google News RSS links are encrypted redirects — resolve them to real
    // publisher URLs before scraping. Unresolved links fall back to the snippet.
    const resolvedByUrl = await resolveGoogleNewsUrls(recent.map((a) => a.url));
    const bodies = await fetchArticleBodies([...new Set(resolvedByUrl.values())]);
    const joined = buildDigestInput(recent, bodies, descByUrl, resolvedByUrl);
    console.log(
      `[news] "${teamName}" digest: ${recent.length} in-window, ` +
        `${resolvedByUrl.size} urls resolved, ${bodies.size} bodies scraped`
    );
    const digest = await summarizeNews(teamName, joined);
    if (!digest.length) throw new Error("empty digest");
    await setCached(digestKey, digest, DIGEST_CACHE_TTL_MS);
    return digest;
  } catch (e) {
    console.warn(`[news] AI digest failed for "${teamName}": ${(e as Error).message}`);
    return staleFallback ?? generateDigest(data, teamName);
  }
}

// Fetch + parse the Google News RSS search feed. Returns the deduped article list
// (capped at 20) plus a url -> <description>-snippet map used as a scrape fallback.
export async function fetchRssArticles(
  teamName: string
): Promise<{ data: NewsArticle[]; descByUrl: Map<string, string>; rawCount: number }> {
  const q = searchQuery(teamName);
  const url =
    `https://news.google.com/rss/search` +
    `?q=${encodeURIComponent(q)}&hl=en-GB&gl=GB&ceid=GB:en`;

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
    return { data: [], descByUrl: new Map(), rawCount: 0 };
  }
  // Detect HTML error pages (rate-limited 200s from Google) before XML parsing
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/html")) {
    console.warn(`[news] Rate-limited or blocked for "${teamName}" (content-type: ${ct})`);
    return { data: [], descByUrl: new Map(), rawCount: 0 };
  }

  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  const articles: NewsArticle[] = [];
  // RSS <description> snippet keyed by url — a fallback for scrape misses. Kept
  // local so the NewsArticle shape (the client contract) is untouched.
  const descByUrl = new Map<string, string>();

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

    const rawDesc = $el.find("description").first().text().trim();
    if (rawDesc) {
      const snippet = cheerio.load(rawDesc).root().text().replace(/\s+/g, " ").trim();
      if (snippet) descByUrl.set(link, snippet.slice(0, 500));
    }

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
  console.log(`[news] "${teamName}" → ${data.length} articles (${articles.length - deduped.length} dupes removed)`);
  return { data, descByUrl, rawCount: articles.length };
}

export async function fetchTeamNews(teamName: string, teamId: string): Promise<NewsResponse> {
  try {
    const { data, descByUrl } = await fetchRssArticles(teamName);
    if (data.length === 0) return { digest: [], articles: [] };

    let digest: string[];
    try {
      digest = await computeDigest(teamName, teamId, data, descByUrl);
    } catch (e) {
      console.warn(`[news] digest error for "${teamName}": ${(e as Error).message}`);
      digest = generateDigest(data, teamName);
    }
    return { digest, articles: data };
  } catch (e) {
    console.warn(`[news] Fetch error for "${teamName}": ${(e as Error).message}`);
    return { digest: [], articles: [] };
  }
}

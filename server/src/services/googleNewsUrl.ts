import { safeFetch as fetch } from "../utils/httpClient";
import * as cheerio from "cheerio";
import { getCached, setCached } from "../db/apiCache";

// Resolve Google News RSS redirect links (news.google.com/rss/articles/<token>)
// to the real publisher URL. Google encrypts these; the only known method is to
// scrape a per-article signature + timestamp from the article page and call
// Google's undocumented `batchexecute` RPC. Ported from the `googlenewsdecoder`
// Python package (MIT, © Sujith Chebbi) — this WILL break whenever Google changes
// the RPC, so every caller must treat a null result as "fall back to snippet".

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

// Decoded URLs are immutable — cache hard so a warm digest never re-hits Google.
const DECODE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const RESOLVE_CONCURRENCY = 3;
const RESOLVE_HTTP_TIMEOUT_MS = 8_000;

function extractToken(sourceUrl: string): string | null {
  try {
    const u = new URL(sourceUrl);
    if (u.hostname !== "news.google.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const i = parts.findIndex((p) => p === "articles" || p === "read");
    if (i === -1 || !parts[i + 1]) return null;
    return parts[i + 1];
  } catch {
    return null;
  }
}

async function getDecodingParams(
  token: string
): Promise<{ signature: string; timestamp: string } | null> {
  for (const url of [
    `https://news.google.com/articles/${token}`,
    `https://news.google.com/rss/articles/${token}`,
  ]) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(RESOLVE_HTTP_TIMEOUT_MS),
        redirect: "follow",
      });
      if (!res.ok) continue;
      const $ = cheerio.load(await res.text());
      let sg: string | undefined;
      let ts: string | undefined;
      $("c-wiz > div[jscontroller]").each((_, el) => {
        const s = $(el).attr("data-n-a-sg");
        const t = $(el).attr("data-n-a-ts");
        if (s && t && !sg) {
          sg = s;
          ts = t;
        }
      });
      if (sg && ts) return { signature: sg, timestamp: ts };
    } catch {
      // try next url form
    }
  }
  return null;
}

function parseBatchExecute(text: string): string | null {
  // Primary: mirror the Python lib — 2nd "\n\n" block, JSON, drop last 2, [0][2] is
  // itself JSON whose [1] is the URL.
  try {
    const block = text.split("\n\n")[1];
    const outer = JSON.parse(block).slice(0, -2);
    const inner = JSON.parse(outer[0][2]);
    if (typeof inner[1] === "string" && /^https?:\/\//.test(inner[1])) return inner[1];
  } catch {
    // fall through
  }
  // Fallback: pull the URL out of the `garturlres` envelope textually.
  const m = text.match(/\\"garturlres\\",\\"(https?:[^\\"]+)\\"/);
  return m ? m[1].replace(/\\\//g, "/") : null;
}

async function decodeToken(token: string): Promise<string | null> {
  const params = await getDecodingParams(token);
  if (!params) return null;

  const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${token}",${params.timestamp},"${params.signature}"]`;
  const fReq = JSON.stringify([[["Fbv4je", inner, null, "generic"]]]);

  try {
    const res = await fetch(
      "https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": BROWSER_UA,
          Referer: "https://news.google.com/",
        },
        body: "f.req=" + encodeURIComponent(fReq),
        signal: AbortSignal.timeout(RESOLVE_HTTP_TIMEOUT_MS),
      }
    );
    if (res.status === 429) throw new Error("rate-limited");
    if (!res.ok) return null;
    return parseBatchExecute(await res.text());
  } catch (e) {
    if ((e as Error).message === "rate-limited") throw e;
    return null;
  }
}

// Resolve one Google News link. Non-Google or already-clean URLs pass through.
export async function resolveGoogleNewsUrl(sourceUrl: string): Promise<string | null> {
  const token = extractToken(sourceUrl);
  if (!token) return /^https?:\/\//.test(sourceUrl) ? sourceUrl : null;

  const cacheKey = `gnews-url:${token}`;
  const cached = await getCached(cacheKey);
  if (typeof cached === "string") return cached;

  const decoded = await decodeToken(token);
  if (decoded) await setCached(cacheKey, decoded, DECODE_CACHE_TTL_MS);
  return decoded;
}

// Resolve many links → Map<originalUrl, realUrl>. Concurrency-limited; bails out of
// the remaining work on the first 429 so we degrade to snippets instead of
// hammering Google.
export async function resolveGoogleNewsUrls(
  urls: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = [...new Set(urls)];
  let rateLimited = false;

  async function worker() {
    while (queue.length && !rateLimited) {
      const original = queue.shift()!;
      try {
        const real = await resolveGoogleNewsUrl(original);
        if (real) out.set(original, real);
      } catch {
        rateLimited = true; // 429 — stop the whole run
      }
    }
  }

  await Promise.allSettled(
    Array.from({ length: Math.min(RESOLVE_CONCURRENCY, queue.length) }, worker)
  );
  return out;
}

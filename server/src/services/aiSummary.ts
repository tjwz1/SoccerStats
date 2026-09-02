import { safeFetch as fetch } from "../utils/httpClient";

// Provider-agnostic news summariser. Currently backed by the Google Gemini
// `generateContent` REST endpoint (no SDK — plain fetch). Model ids live in
// constants so swapping them is a one-line change. Both are Flash-tier models on
// Gemini's free rate-limited tier — Pro-tier models lost their free tier in 2026,
// so the fallback is a second free Flash model, not Pro. Callers should treat any
// throw as "fall back to the heuristic digest".

// 3.5-flash is primary because 3.6-flash has been returning 503 / timing out
// frequently on the free tier; revisit once it stabilises. Both are free-tier.
const GEMINI_MODEL_PRIMARY = "gemini-3.5-flash";
const GEMINI_MODEL_FALLBACK = "gemini-3.6-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Thrown on HTTP 429 / 5xx / empty candidates / parse failure so summarizeNews can
// decide whether to retry with the fallback model and callers can fall through.
export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

// Gemini's 429 body carries the wait it wants, as a `retryDelay: "12.5s"` field
// and/or "Please retry in 12.5s" in the message. Pull whichever is present.
function parseRetryAfterMs(body: string): number | undefined {
  const m =
    body.match(/"retryDelay":\s*"([\d.]+)s"/) ??
    body.match(/retry in ([\d.]+)s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : undefined;
}

function buildPrompt(teamName: string, articleText: string): string {
  return [
    `You are a football news editor briefing a ${teamName} fan who will NOT click through to read any of the articles. Below is the scraped text of news articles from the last 24 hours about ${teamName}.`,
    ``,
    `Write a digest that tells the fan exactly what happened, with the specifics. Respond with ONLY a JSON object of the exact form:`,
    `{"bullets": ["...", "..."]}`,
    ``,
    `Content rules:`,
    `- 3 to 6 bullets, ordered by how widely each story is reported (biggest story first). One bullet per distinct story.`,
    `- Each bullet is 1 to 2 sentences, roughly 20 to 45 words.`,
    `- Pack in the concrete details that are actually present in the text, e.g.: transfer fees and add-ons, contract length and wages, release / buy-back / loan / option clauses, the selling and buying clubs, player age and position, squad numbers, paraphrased manager or player quotes, match results and scorelines, records or milestones reached, injury diagnosis and expected return date, and official dates.`,
    `- Prefer concrete facts over vague phrasing. Never write filler such as "generating coverage", "in the news", "reports have emerged", or "transfer interest has been reported" — if a story carries no concrete detail in the supplied text, leave it out entirely.`,
    `- Do not repeat the same signing, result, or story across multiple bullets.`,
    `- Only state what the supplied text supports. Do not invent figures, quotes, dates, or clubs. If sources conflict on a number, give the range or say "reported at around".`,
    `- Plain text only: no markdown, no leading bullet character, no source attribution like "(BBC)".`,
    ``,
    `--- ARTICLES ---`,
    articleText,
  ].join("\n");
}

// Defensive parse: strip code fences, try JSON.parse -> .bullets, else split raw
// text on newlines / leading bullet glyphs. Always returns at most 5 clean strings.
export function parseBullets(raw: string): string[] {
  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  const finish = (arr: unknown[]): string[] =>
    arr
      .map((x) => String(x).replace(/^\s*[•\-*•]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim())
      .filter((s) => s.length > 0 && !/^[#>*_\-\s]+$/.test(s))
      .slice(0, 6);

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && Array.isArray(parsed.bullets)) {
      const out = finish(parsed.bullets);
      if (out.length) return out;
    }
  } catch {
    // fall through to line splitting
  }

  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^[{}\[\]]+$/.test(l) && !/^"?bullets"?\s*:/i.test(l));

  return finish(lines);
}

// 429 (rate limit) and 5xx (esp. 503 "model overloaded") are transient on the
// Gemini free tier and clear within seconds; a thrown request (network / abort)
// is treated the same. Retried with backoff against the SAME model before we
// bother switching models, because both Flash models share one overloaded backend.
function isRetryable(e: unknown): boolean {
  const s = e instanceof GeminiError ? e.status : undefined;
  if (s === 429 || (s !== undefined && s >= 500)) return true;
  return e instanceof GeminiError && e.status === undefined; // network / timeout
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_RETRY_WAIT_MS = 20_000; // give up rather than stall the request longer

async function callGeminiWithRetry(
  model: string,
  prompt: string,
  maxAttempts = 2
): Promise<string[]> {
  // Fixed backoff for 503s (immediate responses); 429s override it with Google's
  // own retry hint. Keep the attempt budget small — during an outage every extra
  // call eats the 20-request free-tier window.
  const backoffs = [2_000, 6_000];
  let timeoutsUsed = 0;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await callGemini(model, prompt);
    } catch (e) {
      lastErr = e;
      const timedOut = e instanceof GeminiError && e.status === undefined;
      if (timedOut && ++timeoutsUsed >= 1) throw e; // one 75s wait is enough
      if (!isRetryable(e) || attempt === maxAttempts - 1) throw e;

      const hinted = e instanceof GeminiError ? e.retryAfterMs : undefined;
      if (hinted !== undefined && hinted > MAX_RETRY_WAIT_MS) throw e; // not worth waiting
      const wait = (hinted ?? backoffs[attempt]) + Math.floor(Math.random() * 1_000);
      console.warn(
        `[aiSummary] ${model} attempt ${attempt + 1} failed (${(e as Error).message}); retry in ${wait}ms`
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function callGemini(
  model: string,
  prompt: string,
  thinkingLevel: "MINIMAL" | "LOW" | null = "LOW"
): Promise<string[]> {
  const key = process.env.GEMINI_API_KEY as string;
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${key}`;

  const generationConfig: Record<string, unknown> = {
    temperature: 0.3,
    responseMimeType: "application/json",
  };
  // Summarising supplied text needs little reasoning; low thinking cuts latency
  // (the main cause of timeouts) and token use. `thinkingLevel` is the Gemini-3+
  // control (enum MINIMAL|LOW|MEDIUM|HIGH); if a model rejects it we retry without.
  if (thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
      // Generous — Flash "thinking" on ~6-7k words can be slow, especially on the
      // free tier under load. This runs on the digest's background refresh path
      // (users get the stale digest instantly) and Vercel maxDuration is 300s.
      signal: AbortSignal.timeout(75_000),
    });
  } catch (e) {
    // Network/timeout — retryable (status left undefined).
    throw new GeminiError(`request failed for ${model}: ${(e as Error).message}`);
  }

  if (res.status === 429) {
    const body = await res.text().catch(() => "");
    throw new GeminiError(
      `HTTP 429 from ${model}`,
      429,
      parseRetryAfterMs(body)
    );
  }
  if (res.status >= 500) {
    throw new GeminiError(`HTTP ${res.status} from ${model}`, res.status);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Some models may not accept thinkingConfig — retry once without it.
    if (res.status === 400 && thinkingLevel && /thinking/i.test(body)) {
      console.warn(`[aiSummary] ${model} rejected thinkingConfig; retrying without it`);
      return callGemini(model, prompt, null);
    }
    // 4xx other than 429 (bad key, bad request) — not retryable; the caller still
    // falls back to the heuristic, so surface it as GeminiError.
    throw new GeminiError(`HTTP ${res.status} from ${model}: ${body.slice(0, 200)}`, res.status);
  }

  const body: any = await res.json().catch(() => null);
  const raw: string | undefined =
    body?.candidates?.[0]?.content?.parts?.[0]?.text ??
    body?.candidates?.[0]?.content?.parts
      ?.map((p: any) => p?.text)
      .filter(Boolean)
      .join("\n");

  const finish = body?.candidates?.[0]?.finishReason;
  if (body?.usageMetadata) {
    console.log(
      `[aiSummary] model=${model} finish=${finish ?? "?"} tokens=${JSON.stringify(body.usageMetadata)}`
    );
  }

  if (!raw || !raw.trim()) {
    throw new GeminiError(`empty candidates from ${model} (finishReason=${finish ?? "?"})`);
  }

  const bullets = parseBullets(raw);
  if (!bullets.length) {
    throw new GeminiError(`could not parse bullets from ${model} output`);
  }
  return bullets;
}

/**
 * Summarise recent news about a team into 3–6 detail-dense bullets.
 * Primary Flash model with retry+backoff (transient 429/503/timeout), then the
 * fallback Flash model with the same treatment. Throws (GeminiError or otherwise)
 * only after all of that fails, or when no API key is set — the caller then falls
 * back to the heuristic digest.
 */
export async function summarizeNews(teamName: string, articleText: string): Promise<string[]> {
  if (!process.env.GEMINI_API_KEY) {
    throw new GeminiError("GEMINI_API_KEY not set");
  }

  const prompt = buildPrompt(teamName, articleText);

  try {
    return await callGeminiWithRetry(GEMINI_MODEL_PRIMARY, prompt);
  } catch (e) {
    console.warn(
      `[aiSummary] ${GEMINI_MODEL_PRIMARY} exhausted (${(e as Error).message}); trying ${GEMINI_MODEL_FALLBACK}`
    );
    return await callGeminiWithRetry(GEMINI_MODEL_FALLBACK, prompt);
  }
}

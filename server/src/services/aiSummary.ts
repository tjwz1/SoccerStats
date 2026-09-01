import { safeFetch as fetch } from "../utils/httpClient";

// Provider-agnostic news summariser. Currently backed by the Google Gemini
// `generateContent` REST endpoint (no SDK — plain fetch). Model ids live in
// constants so swapping them is a one-line change. Both are Flash-tier models on
// Gemini's free rate-limited tier — Pro-tier models lost their free tier in 2026,
// so the fallback is a second free Flash model, not Pro. Callers should treat any
// throw as "fall back to the heuristic digest".

const GEMINI_MODEL_PRIMARY = "gemini-3.6-flash";
const GEMINI_MODEL_FALLBACK = "gemini-3.5-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Thrown on HTTP 429 / 5xx / empty candidates / parse failure so summarizeNews can
// decide whether to retry with the fallback model and callers can fall through.
export class GeminiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GeminiError";
  }
}

function buildPrompt(teamName: string, articleText: string): string {
  return [
    `You are a football news editor. Below is the full text of news articles published in the last 24 hours about ${teamName}.`,
    ``,
    `Write a factual summary of what is being reported. Respond with ONLY a JSON object of the exact form:`,
    `{"bullets": ["...", "..."]}`,
    ``,
    `Rules:`,
    `- 3 to 5 bullets.`,
    `- Each bullet is ONE short sentence, plain text, no markdown, no leading bullet character.`,
    `- Lead with the biggest / most widely reported story.`,
    `- Only state things supported by the supplied text. No speculation, no outside knowledge.`,
    `- Refer to "${teamName}" by name where relevant; do not invent quotes, fees, or dates.`,
    `- If the articles disagree, summarise the consensus or note the uncertainty briefly.`,
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
      .slice(0, 5);

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

async function callGemini(model: string, prompt: string): Promise<string[]> {
  const key = process.env.GEMINI_API_KEY as string;
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${key}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    // Network/timeout — treat as retryable.
    throw new GeminiError(`request failed for ${model}: ${(e as Error).message}`);
  }

  if (res.status === 429 || res.status >= 500) {
    throw new GeminiError(`HTTP ${res.status} from ${model}`, res.status);
  }
  if (!res.ok) {
    // 4xx other than 429 (bad key, bad request) — not worth a Pro retry, but the
    // caller still falls back to the heuristic, so surface it as GeminiError.
    const body = await res.text().catch(() => "");
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
 * Summarise recent news about a team into 3–5 factual bullets.
 * Tries the primary Flash model, then the fallback Flash model once on
 * 404 / quota / 5xx / parse failure. Throws (GeminiError or otherwise) if both
 * attempts fail or no API key is set — the caller falls back to the heuristic.
 */
export async function summarizeNews(teamName: string, articleText: string): Promise<string[]> {
  if (!process.env.GEMINI_API_KEY) {
    throw new GeminiError("GEMINI_API_KEY not set");
  }

  const prompt = buildPrompt(teamName, articleText);

  try {
    return await callGemini(GEMINI_MODEL_PRIMARY, prompt);
  } catch (e) {
    console.warn(
      `[aiSummary] primary model failed (${(e as Error).message}); retrying with ${GEMINI_MODEL_FALLBACK}`
    );
    return await callGemini(GEMINI_MODEL_FALLBACK, prompt);
  }
}

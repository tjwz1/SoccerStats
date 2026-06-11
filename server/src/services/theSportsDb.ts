import { safeFetch as fetch } from "../utils/httpClient";
import { getPhoto, setPhoto } from "../db/photoCache";

// Sliding-window rate limiter: max 20 req/60 s (TheSportsDB free tier is ~25/min)
const REQ_TIMESTAMPS: number[] = [];
const RATE_LIMIT = 20;
const WINDOW_MS = 60_000;

async function throttle(): Promise<void> {
  const now = Date.now();
  while (REQ_TIMESTAMPS.length && REQ_TIMESTAMPS[0] < now - WINDOW_MS) {
    REQ_TIMESTAMPS.shift();
  }
  if (REQ_TIMESTAMPS.length >= RATE_LIMIT) {
    const wait = REQ_TIMESTAMPS[0] + WINDOW_MS - Date.now() + 50;
    await new Promise((r) => setTimeout(r, wait));
    REQ_TIMESTAMPS.shift();
  }
  REQ_TIMESTAMPS.push(Date.now());
}

async function lookupPhoto(player: { id: number; name: string }): Promise<string | null> {
  const cached = await getPhoto(player.name);
  if (cached !== undefined) return cached;

  try {
    // Use ASCII-normalized name for the search query to handle special characters
    const searchName = player.name
      .replace(/ø/g, "o").replace(/ð/g, "d").replace(/þ/g, "th").replace(/ł/g, "l")
      .replace(/ß/g, "ss").replace(/æ/g, "ae").replace(/œ/g, "oe")
      .normalize("NFD").replace(/[̀-ͯ]/g, "");
    await throttle();
    const res = await fetch(
      `https://www.thesportsdb.com/api/v1/json/3/searchplayers.php?p=${encodeURIComponent(searchName)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json() as any;
    const players: any[] = data.player ?? [];

    // 1st choice: idAPIfootball cross-reference — guaranteed correct match
    const matched = players.find(
      (p) => p.idAPIfootball && Number(p.idAPIfootball) === player.id
    );

    // 2nd choice: only one result returned — no ambiguity
    const unique = !matched && players.length === 1 ? players[0] : null;

    // 3rd choice: result name is a close enough match (normalise accents/case)
    const normalize = (s: string) =>
      s.toLowerCase()
        .replace(/ø/g, "o").replace(/ð/g, "d").replace(/þ/g, "th").replace(/ł/g, "l")
        .replace(/ß/g, "ss").replace(/æ/g, "ae").replace(/œ/g, "oe")
        .normalize("NFD").replace(/[̀-ͯ]/g, "");
    const queryNorm = normalize(player.name);
    const nameMatch =
      !matched && !unique
        ? (players.find((p) => normalize(p.strPlayer ?? "") === queryNorm) ?? null)
        : null;

    const best = matched ?? unique ?? nameMatch ?? null;
    const url: string | null = best?.strCutout || best?.strThumb || null;

    // Only cache definitive API responses (found or confirmed not found)
    await setPhoto(player.name, url);
    return url;
  } catch {
    // Don't cache network errors or rate-limit failures — allow retry on next request
    return null;
  }
}

export async function fetchPhotos(
  players: Array<{ id: number; name: string }>
): Promise<Record<number, string | null>> {
  // Run all lookups concurrently — throttle() inside lookupPhoto enforces the
  // global 20 req/min rate limit so we never overwhelm TheSportsDB regardless
  // of how many teams are fetched in parallel. Cache hits skip throttle entirely.
  const results = await Promise.all(
    players.map(async (p) => ({ id: p.id, photo: await lookupPhoto(p) }))
  );
  return Object.fromEntries(results.map(({ id, photo }) => [id, photo]));
}

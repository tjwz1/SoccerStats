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

const normalize = (s: string) =>
  s.toLowerCase()
    .replace(/ø/g, "o").replace(/ð/g, "d").replace(/þ/g, "th").replace(/ł/g, "l")
    .replace(/ß/g, "ss").replace(/æ/g, "ae").replace(/œ/g, "oe")
    .normalize("NFD").replace(/[̀-ͯ]/g, "");

// Extract the longest significant word (>=5 chars) from a team name, stripping
// generic prefixes ("FC", "SC", "CF", etc.) that appear across many clubs.
function teamKeyword(teamName: string): string {
  const stripped = normalize(teamName)
    .replace(/\b(fc|sc|cf|sd|ud|rcd|rc|cd|ac|ss|sv|vfb|vfl|bsc|asc|afc|fk|nk|sk|jk|jfc|1\.)\b/g, " ")
    .trim();
  const words = stripped.split(/\s+/).filter(w => w.length >= 5);
  // longest word is the strongest team identifier (e.g. "barcelona", "manchester")
  return words.sort((a, b) => b.length - a.length)[0] ?? "";
}

async function lookupPhoto(
  player: { id: number; name: string },
  expectedTeamKey: string // pre-computed from fetchPhotos; empty string = no team check
): Promise<string | null> {
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

    const queryNorm = normalize(player.name);

    // 2nd choice: exact name match after normalisation.
    const nameMatch = !matched
      ? (players.find((p) => normalize(p.strPlayer ?? "") === queryNorm) ?? null)
      : null;

    // 3rd choice: single result that passes BOTH checks:
    //   (a) every query word appears as a complete word in the result name — rejects
    //       "Rodri"→"Jay Rodriguez" and "Pedri"→"Pedrinho" while keeping
    //       "Alisson"→"Alisson Becker" (mononym where name IS a result word).
    //   (b) result team contains the expected team's key identifier word — rejects
    //       "Gerard Martin"→"Gerardo Martino (Atlanta United)" and
    //       "Guille Fernandez"→"Guillermo Fernández (Rosario Central)" while
    //       keeping "Pablo Gavira"→"Gavi (Barcelona)" when teamKey="barcelona".
    const qWords = queryNorm.split(" ");
    const unique = !matched && !nameMatch && players.length === 1
      && qWords.every(w => normalize(players[0].strPlayer ?? "").split(" ").includes(w))
      && (expectedTeamKey === "" || normalize(players[0].strTeam ?? "").includes(expectedTeamKey))
      ? players[0]
      : null;

    const best = matched ?? nameMatch ?? unique ?? null;
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
  players: Array<{ id: number; name: string }>,
  teamName?: string
): Promise<Record<number, string | null>> {
  const expectedTeamKey = teamName ? teamKeyword(teamName) : "";
  // Run all lookups concurrently — throttle() inside lookupPhoto enforces the
  // global 20 req/min rate limit so we never overwhelm TheSportsDB regardless
  // of how many teams are fetched in parallel. Cache hits skip throttle entirely.
  const results = await Promise.all(
    players.map(async (p) => ({ id: p.id, photo: await lookupPhoto(p, expectedTeamKey) }))
  );
  return Object.fromEntries(results.map(({ id, photo }) => [id, photo]));
}

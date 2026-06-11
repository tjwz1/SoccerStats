import { safeFetch as fetch } from "../utils/httpClient";

const FPL_URL = "https://fantasy.premierleague.com/api/bootstrap-static/";
const PHOTO_BASE = "https://resources.premierleague.com/premierleague/photos/players/250x250/p";

interface FplPlayer {
  code: number;
  first_name: string;
  second_name: string;
  web_name: string;
}

let _cache: FplPlayer[] | null = null;
let _cacheTime = 0;
const TTL_MS = 6 * 3600 * 1000;

async function getFplPlayers(): Promise<FplPlayer[]> {
  if (_cache && Date.now() - _cacheTime < TTL_MS) return _cache;
  try {
    const res = await fetch(FPL_URL, { signal: AbortSignal.timeout(6000) });
    const data = (await res.json()) as any;
    _cache = (data.elements ?? []) as FplPlayer[];
    _cacheTime = Date.now();
  } catch {
    // serve stale cache rather than failing
  }
  return _cache ?? [];
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/ø/g, "o").replace(/ð/g, "d").replace(/þ/g, "th").replace(/ł/g, "l")
    .replace(/ß/g, "ss").replace(/æ/g, "ae").replace(/œ/g, "oe")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function lookupFplPhoto(name: string): Promise<string | null> {
  const players = await getFplPlayers();
  const q = norm(name);

  // 1. Exact full name (first_name + second_name)
  let hit = players.find((p) => norm(`${p.first_name} ${p.second_name}`) === q);

  // 2. web_name exact (e.g. "Saka", "Salah")
  if (!hit) hit = players.find((p) => norm(p.web_name) === q);

  // 3. Unambiguous second_name (family name) match
  if (!hit) {
    const qParts = q.split(" ");
    const lastName = qParts[qParts.length - 1];
    if (lastName.length > 3) {
      const candidates = players.filter((p) => {
        const sn = norm(p.second_name);
        return sn === lastName || sn.startsWith(lastName) || lastName.startsWith(sn);
      });
      if (candidates.length === 1) hit = candidates[0];
    }
  }

  // 4. First word + last word of FPL full name matches query
  if (!hit) {
    const candidates = players.filter((p) => {
      const parts = norm(`${p.first_name} ${p.second_name}`).split(" ");
      const abbrev = `${parts[0]} ${parts[parts.length - 1]}`;
      return abbrev === q;
    });
    if (candidates.length === 1) hit = candidates[0];
  }

  if (!hit) return null;
  return `${PHOTO_BASE}${hit.code}.png`;
}

export async function fetchFplPhotos(
  players: Array<{ id: number; name: string }>
): Promise<Record<number, string | null>> {
  const results = await Promise.all(
    players.map(async (p) => ({ id: p.id, photo: await lookupFplPhoto(p.name) }))
  );
  return Object.fromEntries(results.map(({ id, photo }) => [id, photo]));
}

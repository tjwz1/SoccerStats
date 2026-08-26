import { safeFetch as fetch } from "../utils/httpClient";
import { getCached, setCached } from "../db/apiCache";

const SS_SEARCH = "https://api.sofascore.com/api/v1/search/all?q=";
const SS_TEAM_PLAYERS = "https://api.sofascore.com/api/v1/team/";
const SS_PHOTO = "https://api.sofascore.com/api/v1/player/";

// 7 days — squad photos are stable within a season; transfers happen infrequently
const SOFA_PHOTOS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Browser-like headers to avoid being blocked by SofaScore
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://www.sofascore.com/",
  "Origin": "https://www.sofascore.com",
};

function norm(s: string): string {
  return s
    .toLowerCase()
    // Replace non-decomposable special characters before NFD
    .replace(/ø/g, "o").replace(/ð/g, "d").replace(/þ/g, "th").replace(/ł/g, "l")
    .replace(/ß/g, "ss").replace(/æ/g, "ae").replace(/œ/g, "oe")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cappedSet<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  if (map.size >= max && !map.has(key)) map.delete(map.keys().next().value!);
  map.set(key, value);
}

// In-memory cache: football-data.org teamId → (normalised name → photo URL)
const teamPhotoCache = new Map<string, Map<string, string>>();
const TEAM_PHOTO_CACHE_MAX = 200;

async function buildTeamPhotoMap(teamName: string, fdoTeamId: string): Promise<Map<string, string>> {
  // L1: in-memory (instant, lives for the server session)
  if (teamPhotoCache.has(fdoTeamId)) return teamPhotoCache.get(fdoTeamId)!;

  // L2: Supabase (persists across server restarts)
  const cacheKey = `/sofa-photos/${fdoTeamId}`;
  const dbCached = await getCached(cacheKey);
  if (dbCached) {
    const map = new Map<string, string>(Object.entries(dbCached as Record<string, string>));
    cappedSet(teamPhotoCache, fdoTeamId, map, TEAM_PHOTO_CACHE_MAX);
    return map;
  }

  const photoMap = new Map<string, string>();

  try {
    // 1. Search SofaScore for the team
    const searchRes = await fetch(
      `${SS_SEARCH}${encodeURIComponent(teamName)}&page=0`,
      { headers: HEADERS, signal: AbortSignal.timeout(5000) }
    );
    if (!searchRes.ok) return photoMap;

    const searchData = (await searchRes.json()) as any;
    const teams: any[] = (searchData.results ?? []).filter((r: any) => r.type === "team");

    // Find best team match by exact name
    const normTeam = norm(teamName);
    const match =
      teams.find((r) => norm(r.entity.name) === normTeam) ??
      teams.find((r) => norm(r.entity.shortName ?? "") === normTeam) ??
      teams[0]; // best-guess first result

    if (!match) {
      cappedSet(teamPhotoCache, fdoTeamId, photoMap, TEAM_PHOTO_CACHE_MAX);
      return photoMap;
    }

    const ssTeamId = match.entity.id as number;

    // 2. Fetch team's player list from SofaScore
    const playersRes = await fetch(`${SS_TEAM_PLAYERS}${ssTeamId}/players`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(5000),
    });
    if (!playersRes.ok) {
      cappedSet(teamPhotoCache, fdoTeamId, photoMap, TEAM_PHOTO_CACHE_MAX);
      return photoMap;
    }

    const playersData = (await playersRes.json()) as any;
    for (const entry of playersData.players ?? []) {
      const p = entry.player ?? entry;
      if (!p?.id) continue;
      const photoUrl = `${SS_PHOTO}${p.id}/image`;
      // Don't overwrite: the first (most prominent) entry for a name wins.
      if (p.name && !photoMap.has(norm(p.name))) photoMap.set(norm(p.name), photoUrl);
      const sn = norm(p.shortName ?? "");
      if (sn && sn !== norm(p.name ?? "") && !photoMap.has(sn)) photoMap.set(sn, photoUrl);
    }
  } catch {
    // Network/parse error — return empty map, fall back to TheSportsDB
  }

  teamPhotoCache.set(fdoTeamId, photoMap);
  if (photoMap.size > 0) setCached(cacheKey, Object.fromEntries(photoMap), SOFA_PHOTOS_TTL_MS);
  return photoMap;
}

// Multi-strategy lookup: exact → prefix → initials+surname.
// fd.org names are often shorter than SofaScore's full legal names, so exact
// matching misses players like "Rodrigo Hernández" (fd.org) vs
// "Rodrigo Hernández Cascante" (SofaScore full name).
function findPhoto(photoMap: Map<string, string>, fdName: string): string | null {
  const q = norm(fdName);

  // 1. Exact match
  const exact = photoMap.get(q);
  if (exact) return exact;

  // 2. Prefix: fd.org name (must be ≥2 words) is a word-boundary prefix of a SofaScore name.
  //    e.g. "rodrigo hernandez" → "rodrigo hernandez cascante".
  //    Requiring ≥2 words prevents short nicknames ("Rodri", "Pedri") from false-matching
  //    unrelated players whose names happen to start with the same letters.
  //    Only accepted when exactly one SofaScore key qualifies.
  const qWords = q.split(" ");
  if (qWords.length >= 2) {
    const prefix = q + " ";
    let hit: string | null = null;
    let ambiguous = false;
    for (const [key, url] of photoMap) {
      if (key.startsWith(prefix)) {
        if (hit !== null) { ambiguous = true; break; }
        hit = url;
      }
    }
    if (hit && !ambiguous) return hit;
  }

  // 3. Initials+surname abbreviation: "F. de Jong" style keys.
  //    Build the abbreviated form of the fd.org name and look it up directly.
  if (qWords.length >= 2) {
    const abbreviated = `${qWords[0][0]} ${qWords.slice(1).join(" ")}`;
    const abbr = photoMap.get(abbreviated);
    if (abbr) return abbr;
  }

  return null;
}

export async function fetchSofaScorePhotos(
  players: Array<{ id: number; name: string }>,
  teamName: string,
  fdoTeamId: string
): Promise<Record<number, string | null>> {
  const photoMap = await buildTeamPhotoMap(teamName, fdoTeamId);

  return Object.fromEntries(
    players.map((p) => [p.id, findPhoto(photoMap, p.name)])
  );
}

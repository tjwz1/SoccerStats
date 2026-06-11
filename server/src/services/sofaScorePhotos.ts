import { safeFetch as fetch } from "../utils/httpClient";
import { getCached, setCached } from "../db/apiCache";

const SS_SEARCH = "https://api.sofascore.com/api/v1/search/all?q=";
const SS_TEAM_PLAYERS = "https://api.sofascore.com/api/v1/team/";
const SS_PHOTO = "https://api.sofascore.com/api/v1/player/";

// 7 days — squad photos are stable within a season; transfers happen infrequently
const SOFA_PHOTOS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Browser-like headers to avoid being blocked by SofaScore
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
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

// In-memory cache: football-data.org teamId → (normalised name → photo URL)
const teamPhotoCache = new Map<string, Map<string, string>>();

async function buildTeamPhotoMap(teamName: string, fdoTeamId: string): Promise<Map<string, string>> {
  // L1: in-memory (instant, lives for the server session)
  if (teamPhotoCache.has(fdoTeamId)) return teamPhotoCache.get(fdoTeamId)!;

  // L2: Supabase (persists across server restarts)
  const cacheKey = `/sofa-photos/${fdoTeamId}`;
  const dbCached = await getCached(cacheKey);
  if (dbCached) {
    const map = new Map<string, string>(Object.entries(dbCached as Record<string, string>));
    teamPhotoCache.set(fdoTeamId, map);
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
      teamPhotoCache.set(fdoTeamId, photoMap);
      return photoMap;
    }

    const ssTeamId = match.entity.id as number;

    // 2. Fetch team's player list from SofaScore
    const playersRes = await fetch(`${SS_TEAM_PLAYERS}${ssTeamId}/players`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(5000),
    });
    if (!playersRes.ok) {
      teamPhotoCache.set(fdoTeamId, photoMap);
      return photoMap;
    }

    const playersData = (await playersRes.json()) as any;
    for (const entry of playersData.players ?? []) {
      const p = entry.player ?? entry;
      if (!p?.id) continue;
      const photoUrl = `${SS_PHOTO}${p.id}/image`;
      if (p.name) photoMap.set(norm(p.name), photoUrl);
      if (p.shortName && p.shortName !== p.name) photoMap.set(norm(p.shortName), photoUrl);
    }
  } catch {
    // Network/parse error — return empty map, fall back to TheSportsDB
  }

  teamPhotoCache.set(fdoTeamId, photoMap);
  if (photoMap.size > 0) setCached(cacheKey, Object.fromEntries(photoMap), SOFA_PHOTOS_TTL_MS);
  return photoMap;
}

export async function fetchSofaScorePhotos(
  players: Array<{ id: number; name: string }>,
  teamName: string,
  fdoTeamId: string
): Promise<Record<number, string | null>> {
  const photoMap = await buildTeamPhotoMap(teamName, fdoTeamId);

  return Object.fromEntries(
    players.map((p) => {
      const url = photoMap.get(norm(p.name)) ?? null;
      return [p.id, url];
    })
  );
}

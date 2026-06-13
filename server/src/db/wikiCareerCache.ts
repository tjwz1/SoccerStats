import { getCached, setCached, FOREVER_TTL_MS, warmMemCache } from "./apiCache";
import { getClient } from "./supabase";

export interface WikiCareerRow {
  season: string;
  team: string;
  league: string;
  appearances: number;
  goals: number;
  assists: number;
}

const key = (playerId: number) => `wiki_career:${playerId}`;

export async function getWikiStats(playerId: number): Promise<WikiCareerRow[] | null> {
  const cached = await getCached(key(playerId));
  if (!cached) return null;
  return (cached as any).rows as WikiCareerRow[];
}

// Batch lookup — single Supabase query for an entire squad.
// Returns a map of playerId → rows (only players with cached data are included).
export async function getWikiStatsBatch(playerIds: number[]): Promise<Map<number, WikiCareerRow[]>> {
  if (playerIds.length === 0) return new Map();
  const keys = playerIds.map(key);
  const { data, error } = await getClient()
    .from("api_cache")
    .select("path, data, expires_at")
    .in("path", keys)
    .gt("expires_at", new Date().toISOString());

  const map = new Map<number, WikiCareerRow[]>();
  if (error || !data) return map;
  for (const row of data) {
    const id = parseInt((row.path as string).replace("wiki_career:", ""), 10);
    const rows = (row.data as any)?.rows as WikiCareerRow[] | undefined;
    if (rows && rows.length > 0) {
      map.set(id, rows);
      // Backfill memCache so individual getCached() calls for these players skip Supabase
      const expiresAt = new Date(row.expires_at as string).getTime();
      warmMemCache(row.path as string, row.data, expiresAt);
    }
  }
  return map;
}

export async function setWikiStats(
  playerId: number,
  _playerName: string,
  rows: WikiCareerRow[]
): Promise<void> {
  if (rows.length === 0) return; // don't cache empty results — allows retries
  await setCached(key(playerId), { rows }, FOREVER_TTL_MS);
}

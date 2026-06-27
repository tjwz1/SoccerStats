import { getClient } from "./supabase";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
export const FOREVER_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year — for past-season data

// In-memory fallback so Supabase outages don't cause repeated external API calls
const memCache = new Map<string, { value: unknown; expiresAt: number }>();

export async function getCached(path: string): Promise<unknown | null> {
  // Check memory first — fast path, zero network
  const mem = memCache.get(path);
  if (mem && mem.expiresAt > Date.now()) return mem.value;

  try {
    const { data, error } = await getClient()
      .from("api_cache")
      .select("data, expires_at")
      .eq("path", path)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (error || !data) return null;
    // Backfill memory so the next request doesn't hit Supabase
    const expiresAt = new Date(data.expires_at as string).getTime();
    memCache.set(path, { value: data.data, expiresAt });
    return data.data;
  } catch {
    return null;
  }
}

// Returns any cached entry regardless of TTL, plus a staleness flag.
// Use for stale-while-revalidate: serve stale immediately, refresh in background.
export async function getAnyCached(
  path: string
): Promise<{ data: unknown; stale: boolean } | null> {
  // Check memory first
  const mem = memCache.get(path);
  if (mem) {
    return { data: mem.value, stale: mem.expiresAt <= Date.now() };
  }

  try {
    const { data, error } = await getClient()
      .from("api_cache")
      .select("data, expires_at")
      .eq("path", path)
      .maybeSingle();

    if (error || !data) return null;
    const expiresAt = new Date(data.expires_at as string).getTime();
    const stale = expiresAt <= Date.now();
    // Backfill memory so the next request skips Supabase entirely
    memCache.set(path, { value: data.data, expiresAt });
    return { data: data.data, stale };
  } catch {
    return null;
  }
}

// Write directly into memCache without touching Supabase — for callers that already
// have fresh data from a batch Supabase read and just need to warm the local cache.
export function warmMemCache(path: string, value: unknown, expiresAt: number): void {
  memCache.set(path, { value, expiresAt });
}

export function clearMemCache(): void {
  memCache.clear();
}

export async function setCached(path: string, value: unknown, ttlMs = DEFAULT_TTL_MS): Promise<void> {
  // Always write to memory cache first — this works even when Supabase is down
  memCache.set(path, { value, expiresAt: Date.now() + ttlMs });

  // Best-effort write to Supabase for persistence across restarts
  try {
    const expires_at = new Date(Date.now() + ttlMs).toISOString();
    const { error } = await getClient()
      .from("api_cache")
      .upsert({ path, data: value, expires_at });
    if (error) console.error("[apiCache] write failed:", error.message);
  } catch (e: unknown) {
    console.error("[apiCache] write failed:", (e as Error).message);
  }
}

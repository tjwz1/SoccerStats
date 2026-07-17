import { getClient } from "../db/supabase";
import { warmMemCache } from "../db/apiCache";

// On cold start, batch-load frequently-accessed competition/standings/scorers cache entries
// from Supabase into the in-memory cache so the first real request doesn't pay a Supabase
// round-trip on top of the fd.org call. Runs fire-and-forget at module load time.
const WARM_PREFIXES = ["/competitions"];

export function warmL1Cache(): void {
  if (!process.env.SUPABASE_URL) return; // no Supabase configured — skip

  (async () => {
    try {
      const now = new Date().toISOString();
      const { data } = await getClient()
        .from("api_cache")
        .select("path, data, expires_at")
        .gt("expires_at", now)
        .or(WARM_PREFIXES.map((p) => `path.like.${p}%`).join(","))
        .limit(300);

      let count = 0;
      for (const row of data ?? []) {
        warmMemCache(row.path as string, row.data, new Date(row.expires_at as string).getTime());
        count++;
      }
      if (count > 0) console.log(`[warmup] Pre-warmed ${count} L1 cache entries from Supabase`);
    } catch (e: unknown) {
      console.error("[warmup] Pre-warm failed:", (e as Error).message);
    }
  })();
}

import { getClient } from "../db/supabase";
import { warmMemCache } from "../db/apiCache";
import type { TeamEntry } from "./teamIndex";
import { buildTeamIndex, setKnownCompCodes } from "./teamIndex";

// On cold start, batch-load frequently-accessed cache entries from Supabase into the
// in-memory cache so the first real request doesn't pay a Supabase round-trip on top
// of the fd.org call. Also builds the in-memory team search index. Fire-and-forget.
const WARM_PREFIXES = [
  "/competitions",
  "/team-lineup/v3/",
  "/standings/v5/",
  "/competition-fixtures/v1/",
  "/scorers/v5/",
];

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
        .limit(600);

      let count = 0;
      const teamsByComp = new Map<string, TeamEntry[]>();
      let competitionCodes: string[] = [];

      for (const row of data ?? []) {
        const path = row.path as string;
        warmMemCache(path, row.data, new Date(row.expires_at as string).getTime());
        count++;

        // Extract competition codes from the competitions list for index completeness tracking
        if (path === "/competitions/v1" && Array.isArray(row.data)) {
          competitionCodes = (row.data as any[]).map((c) => c.code).filter(Boolean);
        }

        // Collect team lists to build search index without a second Supabase query
        const m = path.match(/^\/teams\/v1\/([A-Z0-9]+)$/);
        if (m && Array.isArray(row.data)) {
          teamsByComp.set(m[1], row.data as TeamEntry[]);
        }
      }

      if (count > 0) console.log(`[warmup] Pre-warmed ${count} L1 cache entries from Supabase`);

      if (competitionCodes.length > 0) setKnownCompCodes(competitionCodes);

      if (teamsByComp.size > 0) {
        buildTeamIndex(teamsByComp);
        console.log(`[warmup] Built team search index from ${teamsByComp.size} competitions`);
      }
    } catch (e: unknown) {
      console.error("[warmup] Pre-warm failed:", (e as Error).message);
    }
  })();
}

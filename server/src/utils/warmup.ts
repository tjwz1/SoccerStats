import { getClient } from "../db/supabase";
import { warmMemCache } from "../db/apiCache";
import { hydrateIndex, setKnownCompCodes, type TeamEntry } from "./teamIndex";

// On cold start, batch-load frequently-accessed cache entries from Supabase into the
// in-memory cache so the first real request doesn't pay a Supabase round-trip on top
// of the fd.org call. Also hydrates the in-memory team search index. Fire-and-forget.
//
// Deliberately loads STALE rows too (no `expires_at` filter): a stale row still lets
// serveWithSWR answer instantly while refreshing in the background, whereas a missing
// row blocks the request on a live upstream fetch. This is the same safety net the
// (separately broken) daily purge cron accidentally provides today by never deleting
// anything — this just targets it at the keys that actually matter for load time
// instead of leaving it to chance which rows happen to still be around.
//
// Prefix-matched: per-team / per-season / per-competition sets too numerous to
// enumerate here without their own extra Supabase round trip.
//
// MAINTENANCE WARNING: these strings (and the ones in exactKeys() below) are hand-kept
// in sync with the cache-key formats routes/teams.ts constructs independently — nothing
// enforces that. A version bump on a route's key (e.g. "/standings/v13/" -> "v14") here
// compiles and passes every test, but silently stops that data from being pre-warmed;
// cold starts just quietly regress with no alarm. This already happened once (the old
// "/teams/v1/{CODE}" prefix below was dead code because it was never actually added to
// this list). When you change a cache key's format in routes/teams.ts, grep this file
// for the old prefix/key and update it here too.
const WARM_PREFIXES = [
  "/team-lineup/v3/",
  "/standings/v5/",     // past-season standings (1-year TTL)
  "/standings/v13/",    // current-season standings — sidebar/standings page
  "/scorers/v5/",
  "/live-scorers/v2/",  // sidebar stat leaders
  "/competition-fixtures/v1/",
  "/bracket/v4/",
  "/competition-seasons/v3/",
  "team-news-digest:",
  "team-news:",
];

// Exact singleton/date-computed keys. `/competitions/v1` replaces the old bare
// `/competitions` prefix, which incidentally matched ~190 large legacy raw fd.org rows
// (e.g. `/competitions/PL/matches?season=...&limit=500`, ~390 KB each) that nothing
// here ever reads — that was the bulk of the old warm-up's ~14.5 MB payload. The bare
// `/espn/` prefix (660-930 KB rows) is dropped for the same reason.
function exactKeys(): string[] {
  const now = new Date();
  const monthStart = (offset: number) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    return d.toISOString().slice(0, 10);
  };
  return [
    "/competitions/v1",
    "/live-matches",
    "/team-index/v1",
    // Previous, current and next month's fixture window — covers the home calendar
    // across a month rollover without waiting for a user to trigger the miss.
    `/fixtures/v1/${monthStart(-1)}/${monthStart(0)}`,
    `/fixtures/v1/${monthStart(0)}/${monthStart(1)}`,
    `/fixtures/v1/${monthStart(1)}/${monthStart(2)}`,
  ];
}

export function warmL1Cache(): void {
  if (!process.env.SUPABASE_URL) return; // no Supabase configured — skip

  (async () => {
    try {
      let count = 0;
      const byPath = new Map<string, { data: unknown; expires_at: string }>();

      // Two independent queries issued in parallel (not sequentially — this is a
      // cold-start latency path, so an extra serial round trip here works against the
      // whole point of this function):
      //
      // 1. Exact keys, with no `.limit()` exposure. This small, fixed-size set
      //    (competitions, live-matches, the team index, 3 fixture windows) must never
      //    be at the mercy of the much larger prefix-matched set's row count — with a
      //    single combined query and an arbitrary (unordered) cap, a surge of rows in
      //    the prefix set (e.g. many /team-lineup/v3/ entries after heavy traffic)
      //    could silently push /team-index/v1 itself out of the truncated result.
      // 2. Prefix-matched: per-team / per-season / per-competition sets too numerous to
      //    enumerate without their own extra Supabase round trip per key. Capped, since
      //    these sets grow with traffic (more teams/seasons visited over time) — losing
      //    a few of these only means slightly fewer teams pre-warmed, not a correctness gap.
      const exact = exactKeys();
      const [exactResult, prefixResult] = await Promise.all([
        getClient().from("api_cache").select("path, data, expires_at").in("path", exact),
        getClient()
          .from("api_cache")
          .select("path, data, expires_at")
          .or(WARM_PREFIXES.map((p) => `path.like.${p}%`).join(","))
          .limit(500),
      ]);

      if (exactResult.error) {
        console.error("[warmup] Exact-key query failed:", exactResult.error.message);
      } else {
        for (const row of exactResult.data ?? []) byPath.set(row.path as string, row);
      }

      if (prefixResult.error) {
        console.error("[warmup] Prefix query failed:", prefixResult.error.message);
      } else {
        for (const row of prefixResult.data ?? []) byPath.set(row.path as string, row);
      }

      for (const [path, row] of byPath) {
        warmMemCache(path, row.data, new Date(row.expires_at).getTime());
        count++;
      }

      if (count > 0) console.log(`[warmup] Pre-warmed ${count} L1 cache entries from Supabase`);

      // Hydrate the search index straight from the persisted /team-index/v1 row — the
      // same source the search route's own fast path (routes/teams.ts) reads from on a
      // cold miss. (The previous version tried to rebuild this from /teams/v1/{CODE}
      // rows, a prefix that was never actually in WARM_PREFIXES, so that path was dead
      // code — this hydrates from data that is actually loaded above.)
      const indexRow = byPath.get("/team-index/v1");
      if (indexRow) {
        hydrateIndex(indexRow.data as { codes: string[]; teams: Record<string, TeamEntry[]> });
        console.log("[warmup] Hydrated team search index from persisted /team-index/v1");
      }

      const compsRow = byPath.get("/competitions/v1");
      if (compsRow && Array.isArray(compsRow.data)) {
        setKnownCompCodes((compsRow.data as any[]).map((c) => c.code).filter(Boolean));
      }
    } catch (e: unknown) {
      console.error("[warmup] Pre-warm failed:", (e as Error).message);
    }
  })();
}

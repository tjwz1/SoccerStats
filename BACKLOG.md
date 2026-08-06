# Backlog

Planned improvements that are not urgent now but should be addressed before/at scale. Ordered by priority.

---

## Before Public Launch

### 1. Supabase `api_cache` expiry cleanup

**Problem:** `setCached` upserts rows with an `expires_at` timestamp but nothing ever deletes them. Expired rows accumulate silently — they're never served (the warmup query already filters `gt("expires_at", now)`) but they bloat the table and slow scans over time. Past-season data with `FOREVER_TTL_MS` (1 year) makes this worse.

**Fix:** A daily DELETE job:
```sql
DELETE FROM api_cache WHERE expires_at < NOW() - INTERVAL '1 day';
```

Options:
- **Supabase pg_cron** (paid tier): schedule directly in the database
- **Vercel cron** (`vercel.json` `crons`): hit a protected admin endpoint that runs the DELETE

---

### 2. Rate limiter shared store

**Problem:** `express-rate-limit` uses an in-memory store by default (`app.ts:33`). Under Vercel, each function instance has its own counter — a user routed across N instances effectively gets N× the allowed rate. The 200 req/min cap is meaningless for abuse prevention at scale.

**Fix (simple):** Replace the default store with a Supabase-backed store. `express-rate-limit` accepts a custom `store` option. A Supabase `rate_limits` table with `(ip, window_start, count)` rows keeps counters shared across all instances.

**Fix (better at scale):** Use Vercel Edge Middleware for rate limiting at the CDN layer, before the function is invoked. Vercel's built-in rate limiting or Upstash Redis via the `@upstash/ratelimit` package both work here.

---

### 3. CDN caching headers for historical data

**Problem:** Every API request — even for fully static historical data (past-season brackets, career standings, completed seasons) — hits a serverless function → Supabase → response. There are no `Cache-Control` headers set on any API response. Vercel's Edge Network can serve GET responses from CDN if the server opts in.

**Fix:** Add `Cache-Control` headers based on TTL type. The existing `isPastSeason` / `FOREVER_TTL_MS` logic already distinguishes immutable from mutable data — use the same flag to drive the header:

```typescript
// Past-season (immutable): CDN caches for 24h, zero function invocations on repeat requests
res.set("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=3600");

// Current-season (SWR pattern must run): no CDN caching
res.set("Cache-Control", "no-store");
```

Routes using `serveWithSWR` for current data must use `no-store` since the SWR pattern requires the function to execute.

Candidates for `public, s-maxage=86400`:
- `/competitions/:code/bracket?season=<past>` — immutable once the season ends
- `/competitions/:code/standings?season=<past>` — immutable
- `/players/:id` career stats — mostly immutable (Wikipedia-sourced)

---

## Later (Accounts)

### 4. User accounts and synced favourites

**Goal:** Allow users to sync their favourited teams across devices. Keep anonymous (localStorage) users working exactly as today — accounts are additive, not a breaking migration.

**Auth:** Supabase Auth (already the DB; avoids adding a new auth library). Email/password + magic link to start; OAuth (Google) if needed later.

**Schema:**
```sql
CREATE TABLE favourites (
  user_id  uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  team_id  integer NOT NULL,
  competition_code text NOT NULL,
  added_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, team_id)
);
```

This mirrors exactly what `useFavourites.ts` already stores in localStorage.

**Client integration:** `useFavourites.ts` is the sole integration point. Swap its `localStorage` read/write for API calls when a session exists; fall back to `localStorage` for anonymous users. Nothing else in the client changes since all consumers already go through this hook.

**API surface needed:**
- `GET /api/favourites` — returns `[{ teamId, competitionCode }]` for the authed user
- `POST /api/favourites` — adds a team
- `DELETE /api/favourites/:teamId` — removes a team

**Anonymous → account migration:** On first sign-in, read localStorage favourites and POST them all to the server. Simple one-time sync.

---

## Known Ceiling (No Fix Needed Now)

### Cross-instance `inflight` deduplication

The `inflight` Map in `footballApi.ts` deduplicates concurrent fd.org calls within a single Vercel instance. At scale, multiple instances handling simultaneous cold misses on the same path can each call fd.org independently, potentially triggering 429s. The fix (a shared Supabase "claim" row or upstream caching proxy) adds real complexity for a problem not yet hit. A comment in the code flags it (`footballApi.ts:61`). Revisit when fd.org 429s appear in logs under real concurrent load.

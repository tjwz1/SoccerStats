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

## When Real Users Arrive

### 4. Tighten Supabase Auth refresh token lifetime

**Context:** Accounts are implemented (`feature/accounts` branch). Supabase Auth is used with magic-link sign-in.

**Problem:** Supabase refresh tokens default to a rolling unlimited lifetime. A stolen refresh token is valid indefinitely — it can be used to re-authenticate forever without the user knowing.

**Fix:** In the Supabase dashboard → Auth → Settings, set the refresh token lifetime to **7 days** (or whatever matches expected session length). Users who haven't opened the app in 7 days will be asked to sign in again — a small UX cost that closes an otherwise open-ended auth window.

**When:** Do this before accounts go live with real users. Low-effort: one dropdown change in the dashboard, no code change required.

---

### 5. Token storage: localStorage → httpOnly cookies

**Problem:** Supabase stores JWTs in `localStorage` by default. Any XSS vulnerability on the page can read these tokens. `httpOnly` cookies are inaccessible to JavaScript entirely.

**Fix:** Initialise the Supabase client with `auth: { storage: cookieStorage }` and configure the server to handle the `set-cookie` flow. Requires the client and server to share the same domain (already true on Vercel with a custom domain).

**When:** Meaningful only once there is user data worth protecting at scale. Low urgency for a small user base; higher urgency if the app ever handles anything beyond favourites.

---

### 6. Audit log alerts for suspicious auth events

**Problem:** Supabase Auth logs sign-in/sign-out events in `auth.audit_log_entries`, but nothing watches them. Mass magic-link attempts from one IP (email harvesting probe) or a sudden spike in account deletions would go unnoticed.

**Fix:** Set up a Supabase database webhook or a pg_cron job that periodically checks for anomalies (e.g. >10 magic-link requests from one IP in an hour) and sends an alert (email or Slack).

**When:** Only worth doing once there are enough users that abuse is plausible.

---

## Known Ceiling (No Fix Needed Now)

### Cross-instance `inflight` deduplication

The `inflight` Map in `footballApi.ts` deduplicates concurrent fd.org calls within a single Vercel instance. At scale, multiple instances handling simultaneous cold misses on the same path can each call fd.org independently, potentially triggering 429s. The fix (a shared Supabase "claim" row or upstream caching proxy) adds real complexity for a problem not yet hit. A comment in the code flags it (`footballApi.ts:61`). Revisit when fd.org 429s appear in logs under real concurrent load.

# Backlog

Planned improvements that are not urgent now but should be addressed before/at scale. Ordered by priority.

---

## Bugs

### News feed stopped updating daily — FIXED (2026-09-13)

**Observed (2026-09-08):** Team news is stale — Barcelona's most recent article is ~a week old. The daily news digest / article fetch appears to have stopped running or is failing silently. Affects at least Barcelona; likely all teams.

**Root cause (verified against production):** the news pipeline itself was never broken. `api_cache` showed Barcelona's digest frozen at `date: 2026-09-08, ok: true` — a genuinely successful generation that then never ran again. A live production log tail (`vercel logs`) during a manually-triggered stale request showed zero backend activity — no RSS fetch, no Gemini call. Root cause: `serveWithSWR`'s (and the bracket route's own inline copy of the same pattern) background revalidation fires an un-awaited promise *after* `res.json()` has already been sent. On Vercel, the function's execution can be frozen the instant the response is flushed — there was no `waitUntil()` anywhere in the codebase telling the platform to keep the invocation alive for that background work. It likely completed only on the rare occasion an instance happened to stay warm by chance, which stopped happening around 2026-09-08.

**Fix:** added `@vercel/functions`, and wrapped both background-revalidation call sites (`serveWithSWR` in `teams.ts`, and the bracket route's inline SWR) in `waitUntil(...)`. This is a systemic fix — it protects every stale-while-revalidate endpoint in the app, not just news. Verified locally: cleared the stale Barcelona cache rows, hit `/api/teams/81/news`, got a freshly-generated digest referencing current news, and confirmed the Supabase row's `date` advanced to today. The Vercel-freeze behavior itself can only be fully confirmed after this deploys to production and a real stale cache entry gets revalidated in the background — worth spot-checking `team-news-digest:*` rows a day or two after deploy.

---

### Champions League page: wrong zone indicators + stale bracket — FIXED (2026-09-13)

**Observed (2026-09-09):** The Champions League page is misrepresenting the new league-phase format.

- **Standings zone indicators are hardcoded from another league.** Correct CL league-phase rules: top **8** automatically qualify for the Round of 16; teams **9–24** (the next 16) go to a knockout play-off round to qualify; teams **25th and below** are eliminated. No relegation.
- **The knockout bracket shown for the current season is actually last season's bracket.**
- It is still the league phase, so **no bracket should be shown at all** yet.

**Root cause (verified against live fd.org data):** `/api/competitions/CL/standings` returns no `description` field and no `zoneRanges` on any row for the 36-team league-phase table — confirmed by pulling the live response directly. `getZone()`/`getZoneRanges()` (`client/src/pages/CompetitionLanding.tsx`) had no `"CL"` entry in `ZONE_OVERRIDES`, so it fell through to `deriveZones()`, a generic domestic-league heuristic (top-4/relegation), producing nonsense zones for a 36-team single table. Separately, `getBracketMatches()` (`server/src/services/footballApi.ts`) had a fallback that silently recursed into `seasonYear - 1` whenever the current season had zero knockout matches yet — written for the old format's brief August inter-season gap, but the new 36-team league phase runs Sept–Jan, so that fallback now serves last season's finished bracket for months, and because it always returns non-empty data, the client never hit its "not available yet" empty state.

**Fix:**
- Added a `CL` entry to `ZONE_OVERRIDES`: `[[1,8,"r16"], [9,24,"playoff"], [25,36,"elim"]]`, plus new `r16`/`elim` zone types with colors and labels ("Round of 16" / "Eliminated"). Verified the boundaries against the live 36-team table.
- Removed the silent previous-season fallback in `getBracketMatches()` for the "no knockout matches yet" case — it now returns `null`. `BracketView.tsx` already had correct handling for this (`error.includes("404")` → "Knockout bracket not yet available for this competition"), so no client change was needed there; verified locally that `/api/competitions/CL/bracket` now returns 404 instead of last season's bracket.
- Fixed the bracket route's own inline SWR background-refresh to use `waitUntil()` too (same systemic issue as the news fix above — it has its own copy of the pattern, not the shared `serveWithSWR` helper).

---

### Team "Form" not updating for the current season

**Observed (2026-09-11):** The Form indicator shows correctly for past/previous seasons but is not updating for the current season. Expected: form should reflect at most the last 5 games played.

**Not yet investigated.**

---

## When Real Users Arrive

### 1. Tighten Supabase Auth refresh token lifetime

**Context:** Accounts are implemented (`feature/accounts` branch). Supabase Auth is used with magic-link sign-in.

**Problem:** Supabase refresh tokens default to a rolling unlimited lifetime. A stolen refresh token is valid indefinitely — it can be used to re-authenticate forever without the user knowing.

**Fix:** In the Supabase dashboard → Auth → Settings, set the refresh token lifetime to **7 days** (or whatever matches expected session length). Users who haven't opened the app in 7 days will be asked to sign in again — a small UX cost that closes an otherwise open-ended auth window.

**When:** Do this before accounts go live with real users. Low-effort: one dropdown change in the dashboard, no code change required.

---

### 2. Token storage: localStorage → httpOnly cookies

**Problem:** Supabase stores JWTs in `localStorage` by default. Any XSS vulnerability on the page can read these tokens. `httpOnly` cookies are inaccessible to JavaScript entirely.

**Fix:** Initialise the Supabase client with `auth: { storage: cookieStorage }` and configure the server to handle the `set-cookie` flow. Requires the client and server to share the same domain (already true on Vercel with a custom domain).

**When:** Meaningful only once there is user data worth protecting at scale. Low urgency for a small user base; higher urgency if the app ever handles anything beyond favourites.

---

### 3. Audit log alerts for suspicious auth events

**Problem:** Supabase Auth logs sign-in/sign-out events in `auth.audit_log_entries`, but nothing watches them. Mass magic-link attempts from one IP (email harvesting probe) or a sudden spike in account deletions would go unnoticed.

**Fix:** Set up a Supabase database webhook or a pg_cron job that periodically checks for anomalies (e.g. >10 magic-link requests from one IP in an hour) and sends an alert (email or Slack).

**When:** Only worth doing once there are enough users that abuse is plausible.

---

## Known Ceiling (No Fix Needed Now)

### Cross-instance `inflight` deduplication

The `inflight` Map in `footballApi.ts` deduplicates concurrent fd.org calls within a single Vercel instance. At scale, multiple instances handling simultaneous cold misses on the same path can each call fd.org independently, potentially triggering 429s. The fix (a shared Supabase "claim" row or upstream caching proxy) adds real complexity for a problem not yet hit. A comment in the code flags it (`footballApi.ts:61`). Revisit when fd.org 429s appear in logs under real concurrent load.

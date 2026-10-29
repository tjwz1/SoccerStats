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

**Fix (round 1):**
- Added a `CL` entry to `ZONE_OVERRIDES`, plus new `r16`/`elim` zone types. Verified the boundaries against the live 36-team table.
- Removed the silent previous-season fallback in `getBracketMatches()` for the "no knockout matches yet" case — it now returns `null`.
- Fixed the bracket route's own inline SWR background-refresh to use `waitUntil()` too (same systemic issue as the news fix above — it has its own copy of the pattern, not the shared `serveWithSWR` helper).

**Deploy hiccup:** the first deploy of round 1 crashed every request in production (`Cannot find module '@vercel/functions'`, `FUNCTION_INVOCATION_FAILED`). Root cause: the serverless function bundle installs from a **separate root `package.json`** (kept manually in sync with `server/package.json`) — the fix only added the dependency to `server/package.json`. Fixed by adding it to the root one too and redeploying.

**Fix (round 2, user-verified against production):** two issues remained after round 1 deployed successfully —
- **Bracket was still last season's**, even with the "no knockout matches" fallback removed. Root cause was different than assumed: `getBracketMatches()` was still deriving "current season" via `getCurrentSeason()`'s local month-based clock heuristic when no season was given — and that heuristic had drifted a year behind fd.org's own actual current-season pointer (confirmed directly against the live fd.org API: `/competitions/CL/matches?season=2025` was cached with a forever-TTL as an "immutable past season" while fd.org's own `/competitions/CL/seasons` listed 2026 as already started with a live table). Fix: stop re-deriving current season via local clock math for the bracket at all — omit the `season` query param when none is given and let fd.org resolve "current" itself, the same reliable approach `getStandings()` already used. Verified directly against fd.org: omitting `season` correctly returns `filters.season: "2026"`.
- **Positions 25–36 showed a red "eliminated" dot that shouldn't exist** — only the top 24 (auto-qualify / playoff) should have any indicator; the rest should be unmarked, matching how unmapped mid-table positions already work for domestic leagues. Removed the `elim` zone entirely; `CL` in `ZONE_OVERRIDES` now only covers `[[1,8,"r16"], [9,24,"playoff"]]`.

Also fixed a related gap surfaced by this: the local smoke-test hook (`.claude/scripts/session-start.sh`, separate from `.github/workflows/smoke-test.yml`) didn't treat 404 as a valid "not yet available" outcome for bracket endpoints the way the GitHub Actions workflow already did — it flagged the correctly-fixed CL bracket 404 as a failure. Added the same 404-is-pass exception there.

---

### Team "Form" not updating for the current season

**Observed (2026-09-11):** The Form indicator shows correctly for past/previous seasons but is not updating for the current season. Expected: form should reflect at most the last 5 games played.

**Not yet investigated.**

---

## Deferred Features

### Per-team chatbot (deferred until data cleanup is done)

**Idea (2026-09-16):** an "Ask about <team>" chat on each team page that answers questions from the app's own data (squad, career stats, results/fixtures, standings, honours, news) as a first step toward a more analytical product. Analysed and planned; **feasible on the existing Gemini Flash free tier** using a single LLM call per question over a cached, compacted "team knowledge pack" (~7–9k tokens). Groq and OpenRouter free tiers were evaluated and rejected (TPM/RPD too low for that prompt size).

**Decisions made:** signed-in users only (reuse `requireAuth`) with per-user + global daily caps in the `rate_limits` table; right-side slide-in drawer, not a fifth tab; architecture unchanged (one new POST route `/api/teams/:id/chat`, one new component). No new dependencies.

**When to pick up:** after the player/career data is cleaned and validated — answer quality is bounded by that data. Start with phase 0 (server-only admin pack-preview endpoint `GET /api/admin/chat-pack/:id`) to see data gaps before building any UI. Full plan: `C:\Users\tjzha\.claude\plans\purring-sparking-teacup.md` (section "Appendix: Per-Team Chatbot Plan").

---

### Internal player-id layer with confidence-ranked source matching (Phase A complete 2026-10-29)

**Current state (analysed 2026-09-18):** the fd.org person id is the anchor and PK everywhere; every other source (SofaScore, Transfermarkt, TheSportsDB, FPL, Wikipedia, worldfootball, ESPN) is resolved by name search plus a per-source heuristic ladder with no confidence score. Known consequences: SofaScore falls back to the first search result unconditionally and caches it 30 days; `players.tm_ref` is pinned forever without recording how it matched; photos are keyed by raw name and ESPN match stats by bare surname (namesakes collide); ESPN athlete ids leak into the fd.org id field; TM-only squad players (`id: 0`) can never acquire data; nine near-duplicate name normalisers exist and none handles Jr/II suffixes or non-Latin names.

**Decisions made:** new surrogate internal id (bigint starting at 10,000,000, chosen so it can never collide with fd.org's ~5-digit ids or ESPN's ~6-digit athlete ids) + `player_source_ref` crosswalk with confidence/status/evidence + `player_match_candidates` review queue; big-5 fd.org squads first; high-confidence refs pinned, low-confidence fall back to today's heuristics and are queued for manual promote/reject via admin endpoints; one shared normaliser + weighted evidence scorer (name similarity, DOB, club, nationality, position, shirt, TheSportsDB `idAPIfootball` cross-ref); shadow-mode rollout behind `IDENTITY_MODE=off|shadow|on`; client keeps `/player/{fdId}` in v1.

**Scope is v1 = big-5 only.** ESPN-sourced leagues (MLS, Liga MX, Scottish Premiership, Liga Argentina, J1 League, Süper Lig), UCL-only clubs, and today's TM-supplemented `id: 0` players are explicitly deferred to a later phase (Phase C "ESPN id guard" + Phase D re-key) — not a scope gap that needs rework later, since the schema (surrogate id range, `source` enum) already has room reserved for them. **Important to come back to:** until that later phase lands, ESPN-league players stay in their current stopgap state — non-clickable in the squad grid and stat leaders (fixed 2026-10-24 by zeroing their id client-side instead of letting it collide with an unrelated fd.org player — see "ESPN player-id collision" below) — so those leagues get no player pages at all in the meantime, not just unreliable ones.

**Separately, already fixed and live (not part of this project):** a related but distinct bug in `mergeEspnAssists`'s player-name matching (`routes/teams.ts`) — matched players across sources on any shared surname or 5+-char name fragment with no team-awareness, confirmed cross-matching real different players (e.g. "Unai López" vs "Fermín López" in LaLiga's assist leaderboard) across all five big-5 leagues. Fixed 2026-10-28 by splitting out a stricter team-gated `playerNamesMatch`; verified across all big-5 leagues with no remaining false positives.

**Phase A results (2026-10-29):** `identity-backfill.ts --apply` run against all big-5 leagues — 2,665 `player_identity` rows, 7,453 `player_source_ref` rows (every player's fd.org ref at 1.0, plus 2,344 Transfermarkt and 2,454 SofaScore legacy refs imported at 0.70/`auto_low`). **10 pre-existing data conflicts found and safely skipped** rather than silently imported — two different fd.org players had been matched to the same TM or SofaScore id by the old ad hoc heuristic, e.g. fd.org ids 99775 ("Jeremy Doku") and 215510 ("Jeremy") both carried `tm_ref.id = 486049`, and fd.org id 3313 ("John Stones") conflicted with another player on *both* TM and SofaScore. These are exactly the kind of cross-player mismatch this project exists to catch; worth a manual look via the (not yet built) review queue once Phase B's admin endpoints exist. Backfill script also needed two bug fixes mid-run: a lock file against overlapping runs, and per-ref try/catch on the (source, external_id) unique constraint instead of crashing the whole batch on the first conflict (both committed). Still fully inert — `IDENTITY_MODE=off`, nothing in the live app reads any of this yet.

**When to pick up:** Phase B (shadow mode — wire scrapers to consult the resolver, log agreement vs. legacy without changing any response) and Phase C (cutover, where ESPN support actually lands) are next, whenever picked up. Full analysis and plan (Parts 1 to 3): `C:\Users\tjzha\.claude\plans\purring-sparking-teacup.md` (section "Appendix A: Player Identity Layer").

---

### Slow first load after idle — MAIN ISSUE FIXED (2026-10-08), remaining phases deferred

**Symptom (2026-09-25):** when production visits are a couple of days apart, the first load of the fixture calendar, sidebar stat leaders and standings is slow. Warm visits are fast.

**Root causes found and fixed (Phase 1, merged #4):** cache writes on the cold path weren't awaited or wrapped in `waitUntil` (`serveWithSWR`, the team-index write, `doFetch`), so Vercel could drop them — the persisted team search index had 0 rows, forcing a ~13-call fd.org rebuild on every cold instance's first search. The cold-start warm-up loaded 14.5 MB of mostly irrelevant rows and missed every actual hot key (v13 standings, live-scorers, fixtures, live-matches). Both fixed; warm-up now reliably loads ~130-180 small rows and hydrates the index every time.

**Proactive warming added (Phase 2, merged #5):** `.github/workflows/warm-cache-{a,b,c}.yml` + `.github/scripts/warm-cache.sh` hit the app's own core endpoints on a schedule (light/all-competitions/daily tiers), so hot rows get refreshed even with zero real traffic.

**Verified against production after a real 5-day unattended gap (2026-10-08):** 100% workflow success rate since merge. Read-only Supabase check showed every tracked competition's standings/scorers/live-scorers within ~6 h of staleness (GitHub throttles the configured 20 min/4 h schedules down to an effective ~5-6 h / ~7-9 h — a platform limit, not a bug — but Tier C's daily cadence lands exactly on schedule). Live timing confirmed fast responses for in-scope endpoints. **The reported symptom is resolved.**

**Phase 3 (per-request/cold-start overhead) — deferred, not pursued:**
- Rate limiter overhead: measured negligible in Phase 0 (~100 ms or less) — ruled out per the plan's own threshold.
- Region pin: user has already confirmed the Supabase region separately — not needed.
- Lazy-loading the cheerio-backed scrapers (`wikiStats`, `transfermarktScraper`, `worldFootball`, `newsService`) off the cold-start path: measured locally at ~850-900 ms of module-load time (by far the largest chunk of the whole import graph), confirmed safe to defer (no top-level side effects, only `footballApi.ts` and `routes/teams.ts` import from them, only functions). **Real production savings are unknown** — the local number is inflated by `ts-node` transpilation and unbundled `node_modules` resolution, neither of which applies to Vercel's bundled deployment, and Vercel's own cold-start/Init Duration metrics weren't accessible to confirm the real figure. Left undone since Phase 1+2 already fixed the actual reported problem; this would be polish on top, not a fix for a known issue.

**Separate, unrelated fix found and applied while diagnosing a side issue:** the SofaScore career scraper (`server/src/services/sofaScoreCareer.ts`) was sending a spoofed `User-Agent` that SofaScore's bot detection flagged, blocking it on every network tested — this is why the personal local player-profile prefill (`server/PREFILL.txt`) stopped making progress. Fixed locally (header removed, verified end-to-end against production: incomplete-profile count actually dropped). **Not yet committed** — this is for personal prefill use, not urgent for the app itself.

**If resuming Phase 3 later:** the blocker is getting real Vercel cold-start/Init Duration numbers, which need either a Vercel Personal Access Token (vercel.com/account/tokens) for API-level log/observability access, or a plan tier that exposes Monitoring/Observability data — see conversation on 2026-10-08 for what was tried. Also revisit Phase 4 (bound goal-event fan-out, skip search prewarm) and Phase 5 (client early fetch, deferred priming, deep links), neither started.

**When to pick up:** whenever the user asks for it. Full analysis, blast-radius table and verification steps: `C:\Users\tjzha\.claude\plans\purring-sparking-teacup.md` (top section, "Slow First Load After Idle").

---

### Feature ideas vs. FotMob/competitors (researched 2026-10-15)

**Confirmed internal finding — some data is already fetched/cached but inconsistently surfaced** (cheaper than new scraping or new stats work): Champions League bracket matches show far less detail than regular schedule matches for the identical data shape (`MatchDetailModal.tsx` fetches only score+goals; `TeamSchedule.tsx`'s own match panel for the same match type also shows cards, subs, team stats, player stats, lineups, H2H — all already built). Position history chart and stat leaders only appear inside a team's own tabs, never on the competition landing page. The live ticker shows goals only, though the same response already carries cards/subs. A working SofaScore photo proxy (`GET /api/player-photo/:sofaId`) is wired up server-side but never called by the client — a latent reliability risk if SofaScore ever blocks direct browser image requests the way it already blocked the scraper.

**Near-term candidates (not stats-gated):**
1. Bracket match-detail parity with the schedule's match panel — reuse existing endpoints/components, low effort.
2. Wire the client to the existing SofaScore photo proxy instead of raw image URLs.
3. Player favouriting (favourites currently team-only) + a "my teams" home dashboard.
4. PWA basics (manifest + service worker) as a prerequisite for push notifications (goal/kickoff alerts for favourite teams) — the one item with real new infrastructure, scope separately when picked up.

**Hold until chatbot work begins (stats/analytical content):**
1. Reuse position chart + stat leaders on the competition landing page, not just inside a team's own tabs.
2. Per-match player ratings, heatmaps/shot maps, live xG, momentum graph — all need new data sourcing beyond anything currently scraped; the biggest lift here by far.
3. Player-vs-player comparison view; predicted lineups ahead of the official one.
4. Chatbot-adjacent, not separate work: an ML/LLM-personalized news feed and AI match previews/predictions are natural extensions of the chatbot's own Gemini infra — raise again once that exists.
5. Not recommended: odds/betting integration (needs a paid provider, real-money adjacency disproportionate to this app's scope).

**When to pick up:** feature work resumes after the chatbot (for the held items) or anytime for the near-term ones. Full detail, sourcing and file:line evidence: `C:\Users\tjzha\.claude\plans\purring-sparking-teacup.md` ("Feature & Structural Backlog Research" section).

---

### Structural gaps for future scaling (researched 2026-10-15)

Ten findings, none yet tracked elsewhere in this file:
1. Four tables (`api_cache`, `players`, `player_seasons`, `player_photos`) plus the `rate_limit_increment` RPC exist in production with no migration file — a fresh environment or disaster recovery can't rebuild the schema from the repo alone. (The RPC being silently missing in production for an unknown period is exactly this risk having already materialized — see the rate-limiter fix earlier this session.)
2. Adding one new competition touches 5-6 independent hand-maintained lists across the codebase (`TEAM_IDS`, `ESPN_LEAGUES`, `COMP_CANONICAL`/`COMP_DISPLAY_NAMES`, `TM_CLUB_NAME_ALIASES`, `DOMESTIC_CUP_MAP`/`TM_CUP_LEAGUES`, the smoke-test workflow's hardcoded checks) with no single registry.
3. Every non-fd.org source (Transfermarkt, Wikipedia, worldfootball.net, SofaScore, Google News) is an unversioned scrape with no breakage alerting — a scraper silently returning empty data looks identical to genuine absence. The SofaScore User-Agent block (broken for weeks, unnoticed) is the real-world proof.
4. The entire backend is one Vercel function sharing one memory/time budget — user traffic and both long-running admin jobs share the same 300s ceiling; the admin route's own time-slicing logic is a workaround, not a structural fix.
5. No CI test gate on pull requests — e2e requires a live server+client and runs manually or on the next scheduled smoke test only.
6. No error-tracking/APM — ~126 `console.log`/`error` call sites are the entire error-visibility mechanism.
7. Rate limiting is IP-only, never per-user; the authenticated favourites/account mutation routes have no rate limiting at all.
8. No admin dashboard — every admin operation is a raw curl call gated by a shared secret.
9. Every environment (local, PR previews, production) shares one Supabase database with no isolation.
10. Root/server `package.json` dependency duplication is still manual, not structurally resolved — already caused one production deploy crash and remains a live risk for every future dependency.

**When to pick up:** whenever scaling pressure (more users, more contributors, more leagues) makes one of these bite — not urgent today. Full detail: `C:\Users\tjzha\.claude\plans\purring-sparking-teacup.md` ("Feature & Structural Backlog Research" section).

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

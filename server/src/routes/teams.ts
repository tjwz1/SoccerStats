import { Router } from "express";
import { getCompetitions, getTeams, getTeamLineup, getTeamSchedule, getMatchDetail, getMatchLineups, getStandings, getCompetitionSeasons, getTopScorers, getTeamCleanSheets, getBracketMatches, getLiveMatches, getPositionHistory, getUpcomingFixtures, getH2HMatches, isInternationalComp, getFinishedMatchList, getCompetitionFixtures, type FinishedMatchRef, type StandingsData, type MatchGoalEvent } from "../services/footballApi";
import { fetchClubHonours, type ClubTrophy } from "../services/wikiStats";
import { scrapeTransfermarktHonours, getTmClubRef } from "../services/transfermarktScraper";
import { getMatchPlayerStats, getEspnMatchLineup, getMatchTeamStats, getMatchGoalEvents, getMatchBookingsAndSubs, teamsMatch, type EspnLineupPlayer } from "../services/matchStatsScraper";
import { fetchEspnCupMatches, fetchTmCupMatches, DOMESTIC_CUP_MAP, TM_CUP_LEAGUES } from "../services/cupSchedule";
import { fetchTeamNews } from "../services/newsService";
import { getCached, getAnyCached, setCached, clearMemCache, clearAllCache, FOREVER_TTL_MS } from "../db/apiCache";
import { requireAdmin } from "../utils/auth";
import { isIndexComplete, searchTeamIndex, addCompToIndex, setKnownCompCodes } from "../utils/teamIndex";
import type { Response } from "express";

// Keys currently being revalidated in the background — prevents duplicate background
// fetches when two requests arrive simultaneously for the same stale route.
const revalidating = new Set<string>();

// Stale-while-revalidate helper: if a cached entry exists (even expired) return it
// immediately, then refresh in the background. Only blocks when there is no entry at all.
async function serveWithSWR<T>(
  res: Response,
  key: string,
  ttlMs: number,
  fetch: () => Promise<T>,
  shouldCache: (d: T) => boolean = () => true
): Promise<void> {
  const hit = await getAnyCached(key);
  if (hit) {
    res.json(hit.data);
    if (hit.stale && !revalidating.has(key)) {
      revalidating.add(key);
      fetch()
        .then((fresh) => { if (shouldCache(fresh)) setCached(key, fresh, ttlMs); })
        .catch((e) => console.error(`[SWR] refresh failed for ${key}:`, e.message))
        .finally(() => revalidating.delete(key));
    }
    return;
  }
  const fresh = await fetch();
  if (shouldCache(fresh)) setCached(key, fresh, ttlMs);
  res.json(fresh);
}
import type { MatchLineupPlayer } from "../services/footballApi";

const CLUB_HONOURS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory L1 cache for assembled lineup responses — zero-latency within the same process.
// Supabase (via serveWithSWR in the route) acts as L2, persisting across Vercel cold starts.
const lineupCache = new Map<string, { data: unknown; fetchedAt: number }>();
const LINEUP_TTL_MS = 24 * 60 * 60 * 1000; // 24h — squad changes at most weekly

const router = Router();

// Reject obviously-invalid numeric IDs before any downstream logic
function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0 || n > 999_999_999) return null;
  return n;
}

// Trim and enforce max length on free-text query params to prevent abuse
function safeStr(raw: string | undefined, maxLen = 100): string {
  return (raw ?? "").trim().slice(0, maxLen);
}

router.get("/fixtures", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dateFrom = safeStr(req.query.dateFrom as string | undefined) || today;
    const dateTo   = safeStr(req.query.dateTo   as string | undefined) || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return res.status(400).json({ error: "invalid date format" });
    }
    const cacheKey = `/fixtures/v1/${dateFrom}/${dateTo}`;
    await serveWithSWR(res, cacheKey, 5 * 60 * 1000,
      () => getUpcomingFixtures(dateFrom, dateTo),
      (d) => Array.isArray(d)
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions", async (_req, res) => {
  try {
    await serveWithSWR(res, "/competitions/v1", 60 * 60 * 1000,
      async () => {
        const comps = await getCompetitions();
        // Register the full competition code list so the team search index knows
        // when it covers all competitions and can safely serve as the fast path.
        setKnownCompCodes((comps as any[]).map((c: any) => c.code).filter(Boolean));
        return comps;
      },
      (d: any[]) => d.length > 0
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions/:code/teams", async (req, res) => {
  try {
    const cacheKey = `/teams/v1/${req.params.code}`;
    await serveWithSWR(res, cacheKey, 60 * 60 * 1000,
      () => getTeams(req.params.code),
      (d: any[]) => d.length > 0
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions/:code/seasons", async (req, res) => {
  try {
    const cacheKey = `/competition-seasons/v2/${req.params.code}`;
    await serveWithSWR(res, cacheKey, 24 * 60 * 60 * 1000,
      () => getCompetitionSeasons(req.params.code),
      (d: any[]) => d.length > 0
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions/:code/bracket", async (req, res) => {
  const season = req.query.season ? parseInt(req.query.season as string, 10) : undefined;
  const cacheKey = `/bracket/v2/${req.params.code}${season ? `/${season}` : ""}`;
  try {
    // Manual SWR so null (bracket not yet available) maps to 404 rather than 200.
    const hit = await getAnyCached(cacheKey);
    if (hit) {
      if (hit.data === null) return res.status(404).json({ error: "bracket not available" });
      res.json(hit.data);
      if (hit.stale) {
        getBracketMatches(req.params.code, season)
          .then((d) => setCached(cacheKey, d ?? null, 30 * 60 * 1000))
          .catch(() => {});
      }
      return;
    }
    const data = await getBracketMatches(req.params.code, season);
    await setCached(cacheKey, data ?? null, 30 * 60 * 1000);
    if (!data) return res.status(404).json({ error: "bracket not available" });
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions/:code/live-matches", async (req, res) => {
  try {
    const all = await getLiveMatches();
    res.json(all.filter((m) => m.competitionCode === req.params.code));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions/:code/standings", async (req, res) => {
  try {
    const season = req.query.season ? parseInt(req.query.season as string, 10) : undefined;
    if (season) {
      // Past seasons are immutable — SWR with permanent cache is safe.
      const cacheKey = `/standings/v5/${req.params.code}/${season}`;
      await serveWithSWR(res, cacheKey, 365 * 24 * 60 * 60 * 1000,
        () => getStandings(req.params.code, season),
        (d) => d.groups.length > 0
      );
    } else {
      // Current season: 5-min route-level SWR so cold/expired requests return
      // stale standings instantly instead of blocking 8-17s on fd.org.
      const cacheKey = `/standings/v5/${req.params.code}/current`;
      await serveWithSWR(res, cacheKey, 5 * 60 * 1000,
        () => getStandings(req.params.code, season),
        (d) => d.groups.length > 0
      );
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions/:code/scorers", async (req, res) => {
  try {
    const season = req.query.season ? parseInt(req.query.season as string, 10) : undefined;
    const cacheKey = `/scorers/v5/${req.params.code}${season ? `/${season}` : ""}`;
    await serveWithSWR(res, cacheKey, 15 * 60 * 1000,
      async () => {
        const [fdData, csData] = await Promise.all([
          getTopScorers(req.params.code, season).catch(() => ({ goals: [], assists: [] })),
          getTeamCleanSheets(req.params.code, season).catch(() => []),
        ]);
        return { goals: fdData.goals, assists: fdData.assists, cleanSheets: csData };
      },
      (d) => d.goals.length > 0 || d.assists.length > 0
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions/:code/fixtures", async (req, res) => {
  try {
    const season = req.query.season ? parseInt(req.query.season as string, 10) : undefined;
    const isPast = season !== undefined && season < new Date().getFullYear() - (new Date().getMonth() < 7 ? 1 : 0);
    const ttl = isPast ? 365 * 24 * 60 * 60 * 1000 : 5 * 60 * 1000;
    const cacheKey = `/competition-fixtures/v1/${req.params.code}${season ? `/${season}` : ""}`;
    await serveWithSWR(res, cacheKey, ttl,
      () => getCompetitionFixtures(req.params.code, season),
      (d) => Array.isArray(d) && d.length > 0
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions/:code/live-scorers", async (req, res) => {
  const code = req.params.code;
  const season = req.query.season ? parseInt(req.query.season as string, 10) : undefined;
  const cacheKey = `/live-scorers/v1/${code}/${season ?? "current"}`;
  try {
    await serveWithSWR(res, cacheKey, 5 * 60 * 1000, async () => {
    const intl = isInternationalComp(code);

    const [fdDataRaw, csData, allLive, finishedList] = await Promise.all([
      getTopScorers(code, season).catch(() => ({ goals: [], assists: [] })),
      getTeamCleanSheets(code, season).catch(() => []),
      getLiveMatches().catch(() => []),
      // For international comps fd.org /matches/:id has no goal events on the free tier,
      // so we fetch all finished matches and rebuild assists via ESPN (same as live overlay).
      intl
        ? getFinishedMatchList(code, season).catch(() => [] as FinishedMatchRef[])
        : Promise.resolve([] as FinishedMatchRef[]),
    ]);

    // Trim to 50 — client shows 10; extra headroom for live re-ordering without sending 400 entries
    const fdData = { goals: fdDataRaw.goals.slice(0, 50), assists: fdDataRaw.assists.slice(0, 50) };

    const liveMatches = allLive.filter((m) => m.competitionCode === code);

    // Helpers must be available for both the finished-assist pass and the live-match pass.
    function normName(s: string): string {
      return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").trim().replace(/\s+/g, " ");
    }
    function lastToken(s: string): string {
      const parts = normName(s).split(" ");
      return parts[parts.length - 1];
    }
    function namesMatch(a: string, b: string): boolean {
      const na = normName(a), nb = normName(b);
      if (na === nb) return true;
      const la = lastToken(a), lb = lastToken(b);
      if (la === lb && la.length >= 4) return true;
      for (const tok of na.split(" ")) {
        if (tok.length >= 5 && nb.includes(tok)) return true;
      }
      return false;
    }

    // For international competitions, build a complete assists leaderboard from ESPN
    // goal events across all finished matches — identical approach to the live overlay.
    type AssistEntry = { count: number; teamId: number; teamName: string; teamCrest: string; displayName: string };
    const finishedAssistMap = new Map<string, AssistEntry>();

    if (intl && finishedList.length > 0) {
      await Promise.all(
        finishedList.map(async (m) => {
          try {
            const events = await getMatchGoalEvents(m.id, m.homeTeam, m.awayTeam, m.utcDate, code);
            for (const e of events) {
              if (e.ownGoal || !e.assist) continue;
              const isHome = namesMatch(m.homeTeam, e.teamDisplayName);
              const tId   = isHome ? m.homeTeamId   : m.awayTeamId;
              const tName = isHome ? m.homeTeam      : m.awayTeam;
              const tCrest = isHome ? m.homeTeamCrest : m.awayTeamCrest;
              const key = normName(e.assist);
              const ex = finishedAssistMap.get(key) ?? { count: 0, teamId: tId, teamName: tName, teamCrest: tCrest, displayName: e.assist };
              finishedAssistMap.set(key, { ...ex, count: ex.count + 1 });
            }
          } catch { /* silently skip */ }
        })
      );
    }

    // Use ESPN-built assists for international comps; fd.org scorers-based for domestic.
    const baseAssists: any[] = (intl && finishedAssistMap.size > 0)
      ? Array.from(finishedAssistMap.values())
          .sort((a, b) => b.count - a.count)
          .slice(0, 30)
          .map(({ count, teamId, teamName, teamCrest, displayName }) => ({
            value: count,
            liveAdd: 0,
            playedMatches: 0,
            player: { id: 0, name: displayName, nationality: "", dateOfBirth: "", position: "" },
            team: { id: teamId, name: teamName, shortName: teamName, crest: teamCrest, tla: teamName.slice(0, 3).toUpperCase() },
          }))
      : fdData.assists;

    if (!liveMatches.length) {
      return { goals: fdData.goals, assists: baseAssists, cleanSheets: csData, hasLive: false };
    }

    // Aggregate live goals/assists — key is normalized name, value stores original for display
    type LiveEntry = { goals: number; assists: number; teamId: number; teamName: string; teamCrest: string; displayName: string };
    const liveMap = new Map<string, LiveEntry>();

    function upsert(key: string, displayName: string, teamId: number, teamName: string, teamCrest: string, field: "goals" | "assists") {
      const existing = liveMap.get(key) ?? { goals: 0, assists: 0, teamId, teamName, teamCrest, displayName };
      liveMap.set(key, { ...existing, [field]: existing[field] + 1 });
    }

    await Promise.all(liveMatches.map(async (match) => {
      try {
        const events = await getMatchGoalEvents(match.id, match.homeTeam, match.awayTeam, match.utcDate, match.competitionCode, true);
        for (const e of events) {
          if (e.ownGoal) continue;
          const isHome = namesMatch(match.homeTeam, e.teamDisplayName);
          const tId = isHome ? match.homeTeamId : match.awayTeamId;
          const tName = isHome ? match.homeTeam : match.awayTeam;
          const tCrest = isHome ? match.homeTeamCrest : match.awayTeamCrest;

          upsert(normName(e.scorer), e.scorer, tId, tName, tCrest, "goals");
          if (e.assist) upsert(normName(e.assist), e.assist, tId, tName, tCrest, "assists");
        }
      } catch { /* silently skip failed match */ }
    }));

    // Merge live-match additions onto a base leader list.
    // Goals: fd.org scorers updates live, so base already has them — liveAdd is UI indicator only.
    // Assists: for intl comps base is ESPN finished-match data; live assists add on top.
    //          For domestic comps base is fd.org scorers; live assists add on top.
    function mergeLive(base: any[], field: "goals" | "assists"): any[] {
      const usedKeys = new Set<string>();
      const merged = base.map((r) => {
        let liveAdd = 0;
        for (const [k, lv] of liveMap) {
          if (namesMatch(r.player.name, k)) {
            liveAdd = field === "goals" ? lv.goals : lv.assists;
            usedKeys.add(k);
            break;
          }
        }
        const valueAdd = field === "assists" ? liveAdd : 0;
        return { ...r, value: r.value + valueAdd, liveAdd };
      });
      for (const [k, lv] of liveMap) {
        if (usedKeys.has(k)) continue;
        const add = field === "goals" ? lv.goals : lv.assists;
        if (add <= 0) continue;
        merged.push({
          value: add,
          liveAdd: add,
          playedMatches: 0,
          player: { id: 0, name: lv.displayName, nationality: "", dateOfBirth: "", position: "" },
          team: { id: lv.teamId, name: lv.teamName, shortName: lv.teamName, crest: lv.teamCrest, tla: lv.teamName.slice(0, 3).toUpperCase() },
        } as any);
        usedKeys.add(k);
      }
      merged.sort((a, b) => b.value - a.value);
      return merged;
    }

    return {
      goals: mergeLive(fdData.goals, "goals"),
      assists: mergeLive(baseAssists, "assists"),
      cleanSheets: csData,
      hasLive: true,
    };
    }); // end serveWithSWR
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions/:code/position-history", async (req, res) => {
  try {
    const teamId = parseInt((req.query.teamId as string) ?? "", 10);
    if (isNaN(teamId)) return res.status(400).json({ error: "?teamId= required" });
    const season = req.query.season ? parseInt(req.query.season as string, 10) : undefined;
    const cacheKey = `/position-history/v1/${req.params.code}/${teamId}${season ? `/${season}` : ""}`;
    await serveWithSWR(res, cacheKey, 60 * 60 * 1000,
      () => getPositionHistory(req.params.code, teamId, season),
      (d) => d.length > 0
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// SSE stream — must be registered before the plain /live-matches route
router.get("/live-matches/stream", async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const send = async () => {
    try {
      const data = await getLiveMatches();
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      if (!res.writableEnded) res.write(`data: []\n\n`);
    }
  };

  await send();
  const interval = setInterval(send, 30_000);
  req.on("close", () => clearInterval(interval));
});

router.get("/live-matches", async (_req, res) => {
  try {
    res.json(await getLiveMatches());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/admin/cache/clear", requireAdmin, async (_req, res) => {
  await clearAllCache();
  res.status(204).send();
});

router.get("/teams/search", async (req, res) => {
  const q = safeStr(req.query.q as string | undefined, 50).toLowerCase();
  if (q.length < 2) return res.json([]);
  try {
    // Fast path: use the in-memory index only when it's complete (all competitions indexed).
    // A partial index would return inconsistent results vs. the full parallel-fetch fallback.
    if (isIndexComplete()) {
      return res.json(searchTeamIndex(q, 15));
    }

    const competitions = await getCompetitions();
    // Domestic leagues first so e.g. "barcelona" gets PD (La Liga) not CL
    const DOMESTIC_PRIORITY = ["PL", "PD", "BL1", "SA", "FL1", "DED", "PPL", "BSA", "ELC"];
    const sorted = [...competitions].sort((a: any, b: any) => {
      const ai = DOMESTIC_PRIORITY.indexOf(a.code);
      const bi = DOMESTIC_PRIORITY.indexOf(b.code);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    const teamArrays = await Promise.all(
      sorted.map(async (c: { code: string }) => ({
        code: c.code,
        teams: await getTeams(c.code).catch(() => []),
      }))
    );
    const seenIds = new Set<number>();
    const results: unknown[] = [];
    for (const { code: compCode, teams } of teamArrays) {
      for (const team of teams as any[]) {
        if (seenIds.has(team.id)) continue;
        const name = (team.name ?? "").toLowerCase();
        const short = (team.shortName ?? "").toLowerCase();
        const tla = (team.tla ?? "").toLowerCase();
        if (name.includes(q) || short.includes(q) || tla.includes(q)) {
          seenIds.add(team.id);
          results.push({ ...team, competitionCode: compCode });
        }
      }
    }
    // Populate the index with freshly-fetched data so subsequent requests
    // can use the fast path (all comps are now loaded and indexed).
    setKnownCompCodes(sorted.map((c: any) => c.code));
    for (const { code: compCode, teams } of teamArrays) {
      addCompToIndex(compCode, teams as any[]);
    }
    res.json(results.slice(0, 15));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/teams/:id/lineup", async (req, res) => {
  const competition = (req.query.competition as string) || "PL";
  const memKey = `${req.params.id}:${competition}`;
  const sbKey = `/team-lineup/v3/${req.params.id}/${competition}`;

  // L1: in-memory — zero latency within the same process instance
  const hit = lineupCache.get(memKey);
  if (hit && Date.now() - hit.fetchedAt < LINEUP_TTL_MS) return res.json(hit.data);

  // L2: Supabase SWR — serves stale data immediately on Vercel cold starts,
  // then refreshes in the background. Only blocks when there is no cached entry at all.
  try {
    await serveWithSWR(res, sbKey, LINEUP_TTL_MS,
      async () => {
        const data = await getTeamLineup(req.params.id, competition || undefined);
        lineupCache.set(memKey, { data, fetchedAt: Date.now() });
        return data;
      },
      (d: any) => Array.isArray(d?.starters) && d.starters.length > 0
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/teams/:id/honours", async (req, res) => {
  try {
    const teamId = req.params.id;
    const teamName = safeStr(req.query.name as string | undefined);
    if (!teamName) return res.status(400).json({ error: "?name= query param required" });

    const cacheKey = `/club-honours/${teamId}`;
    await serveWithSWR(res, cacheKey, CLUB_HONOURS_TTL_MS,
      async () => {
        let data = await fetchClubHonours(teamName!);
        if (data.length === 0) {
          console.log(`[honours] Wikipedia empty for "${teamName}", trying Transfermarkt…`);
          data = await scrapeTransfermarktHonours(teamName!);
        }
        return data;
      },
      (d) => d.length > 0
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/matches/:id", async (req, res) => {
  try {
    const matchId = parseId(req.params.id);
    if (!matchId) return res.status(400).json({ error: "invalid match id" });
    const status = safeStr(req.query.status as string | undefined, 20) || "FINISHED";
    const homeTeam = safeStr(req.query.homeTeam as string | undefined);
    const awayTeam = safeStr(req.query.awayTeam as string | undefined);
    const utcDate = safeStr(req.query.utcDate as string | undefined, 30);
    const competition = safeStr(req.query.competition as string | undefined, 10);

    const isLive = ["IN_PLAY", "PAUSED"].includes(status);
    const isFinished = status === "FINISHED";

    // Return cached assembled response for finished matches (ESPN scrapes included)
    const assembledKey = `match-assembled:${matchId}`;
    if (isFinished) {
      const hit = await getCached(assembledKey);
      if (hit) return res.json(hit);
    }

    const detail = await getMatchDetail(matchId, status);
    let goals = detail.goals;
    let bookings = detail.bookings;
    let substitutions = detail.substitutions;

    if (homeTeam && awayTeam && utcDate && competition) {
      // Supplement goals from ESPN when fd.org returns none (free-tier gap)
      if (goals.length === 0) {
        try {
          const espnGoals = await getMatchGoalEvents(matchId, homeTeam, awayTeam, utcDate, competition, isLive);
          if (espnGoals.length > 0) {
            goals = espnGoals.map((g) => ({
              minute: g.minute,
              extraTime: g.extraTime,
              team: (teamsMatch(homeTeam, g.teamDisplayName) ? "home" : "away") as "home" | "away",
              scorer: g.scorer,
              assist: g.assist,
              type: (g.ownGoal ? "OWN_GOAL" : g.penalty ? "PENALTY" : "REGULAR") as "REGULAR" | "OWN_GOAL" | "PENALTY",
            }));
          }
        } catch {}
      }

      // Always supplement bookings/subs from ESPN (fd.org free tier never includes these)
      if (bookings.length === 0) {
        try {
          const espnEvents = await getMatchBookingsAndSubs(matchId, homeTeam, awayTeam, utcDate, competition, isLive);
          bookings = espnEvents.bookings.map((b) => ({
            minute: b.minute,
            extraTime: b.extraTime,
            team: (teamsMatch(homeTeam, b.teamDisplayName) ? "home" : "away") as "home" | "away",
            player: b.player,
            card: b.card,
          }));
          substitutions = espnEvents.substitutions.map((s) => ({
            minute: s.minute,
            extraTime: s.extraTime,
            team: (teamsMatch(homeTeam, s.teamDisplayName) ? "home" : "away") as "home" | "away",
            playerOut: s.playerOut,
            playerIn: s.playerIn,
          }));
        } catch {}
      }
    }

    const assembled = { ...detail, goals, bookings, substitutions };
    // Cache finished matches forever; only skip caching when goals were expected but missing
    // (allows ESPN data to be picked up on the next request if the scrape initially failed).
    if (isFinished && (goals.length > 0 || bookings.length > 0 || substitutions.length > 0)) {
      setCached(assembledKey, assembled, FOREVER_TTL_MS);
    }
    res.json(assembled);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/matches/:id/team-stats", async (req, res) => {
  try {
    const matchId = parseId(req.params.id);
    if (!matchId) return res.status(400).json({ error: "invalid match id" });
    const homeTeam = safeStr(req.query.homeTeam as string | undefined);
    const awayTeam = safeStr(req.query.awayTeam as string | undefined);
    const utcDate = safeStr(req.query.utcDate as string | undefined, 30);
    const competition = safeStr(req.query.competition as string | undefined, 10) || "PL";
    if (!homeTeam || !awayTeam || !utcDate) {
      return res.status(400).json({ error: "homeTeam, awayTeam, utcDate required" });
    }
    const cacheKey = `match-team-stats:${matchId}`;
    const cached = await getCached(cacheKey);
    if (cached) return res.json(cached);
    const stats = await getMatchTeamStats(matchId, homeTeam, awayTeam, utcDate, competition);
    if (!stats) return res.status(404).json({ error: "team stats not available" });
    setCached(cacheKey, stats, FOREVER_TTL_MS);
    res.json(stats);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/matches/:id/player-stats", async (req, res) => {
  try {
    const matchId = parseId(req.params.id);
    if (!matchId) return res.status(400).json({ error: "invalid match id" });
    const homeTeam = safeStr(req.query.homeTeam as string | undefined);
    const awayTeam = safeStr(req.query.awayTeam as string | undefined);
    const utcDate = safeStr(req.query.utcDate as string | undefined, 30);
    const competition = safeStr(req.query.competition as string | undefined, 10) || "PL";
    const status = safeStr(req.query.status as string | undefined, 20) || "FINISHED";
    const isLive = ["IN_PLAY", "PAUSED"].includes(status);
    if (!homeTeam || !awayTeam || !utcDate) {
      return res.status(400).json({ error: "homeTeam, awayTeam, utcDate required" });
    }
    const cacheKey = `match-player-stats:${matchId}`;
    if (!isLive) {
      const cached = await getCached(cacheKey);
      if (cached) return res.json(cached);
    }
    const stats = await getMatchPlayerStats(matchId, homeTeam, awayTeam, utcDate, competition, isLive);
    if (!isLive && Array.isArray(stats) && stats.length > 0) {
      setCached(cacheKey, stats, FOREVER_TTL_MS);
    }
    res.json(stats);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

function espnPlayerToLineupPlayer(p: EspnLineupPlayer, photoCache: Map<number, string | null>): MatchLineupPlayer {
  return {
    id: 0, // ESPN players have no football-data.org ID
    name: p.name,
    position: p.broadPosition as any,
    role: p.espnPosition as any,
    shirtNumber: p.shirtNumber,
    photo: null,
  };
}

router.get("/matches/:id/actual-lineup", async (req, res) => {
  try {
    const matchId = parseId(req.params.id);
    if (!matchId) return res.status(400).json({ error: "invalid match id" });

    const homeTeam = safeStr(req.query.homeTeam as string | undefined);
    const awayTeam = safeStr(req.query.awayTeam as string | undefined);
    const utcDate = safeStr(req.query.utcDate as string | undefined, 30);
    const competition = safeStr(req.query.competition as string | undefined, 10) || "PL";

    const status = safeStr(req.query.status as string | undefined, 20) || "FINISHED";
    const isLive = ["IN_PLAY", "PAUSED"].includes(status);
    const isFinished = status === "FINISHED";

    const cacheKey = `match-actual-lineup:${matchId}`;
    if (isFinished) {
      const cached = await getCached(cacheKey);
      if (cached) return res.json(cached);
    }

    // Try football-data.org first (has player IDs for photo lookup)
    let lineups = await getMatchLineups(matchId, status);

    // If football-data.org has no lineup data, fall back to ESPN roster data
    if (!lineups.hasData && homeTeam && awayTeam && utcDate) {
      const espnLineup = await getEspnMatchLineup(matchId, homeTeam, awayTeam, utcDate, competition);
      if (espnLineup) {
        const toPlayers = (arr: EspnLineupPlayer[]): MatchLineupPlayer[] =>
          arr.map((p) => espnPlayerToLineupPlayer(p, new Map()));

        lineups = {
          homeTeamId: espnLineup.homeTeamId ?? 0,
          homeTeamName: espnLineup.homeTeamName,
          awayTeamId: espnLineup.awayTeamId ?? 0,
          awayTeamName: espnLineup.awayTeamName,
          homeFormation: espnLineup.home.formation,
          awayFormation: espnLineup.away.formation,
          homeStarters: toPlayers(espnLineup.home.starters),
          awayStarters: toPlayers(espnLineup.away.starters),
          homeBench: toPlayers(espnLineup.home.bench),
          awayBench: toPlayers(espnLineup.away.bench),
          hasData: espnLineup.home.starters.length > 0 || espnLineup.away.starters.length > 0,
        };
      }
    }

    if (isFinished && lineups.hasData) {
      setCached(cacheKey, lineups, FOREVER_TTL_MS);
    }
    res.json(lineups);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});


router.get("/teams/:id/news", async (req, res) => {
  try {
    const teamName = (req.query.name as string | undefined)?.trim();
    if (!teamName) return res.status(400).json({ error: "?name= query param required" });
    const cacheKey = `team-news:${req.params.id}`;
    await serveWithSWR(res, cacheKey, 15 * 60 * 1000,
      () => fetchTeamNews(teamName),
      (d) => Array.isArray(d) && (d as unknown[]).length > 0
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/teams/:id/schedule", async (req, res) => {
  try {
    const domestic = (req.query.competition as string | undefined) ?? "PL";
    const teamName = (req.query.name as string | undefined) ?? "";
    const teamIdNum = parseInt(req.params.id, 10);
    const season = req.query.season ? parseInt(req.query.season as string, 10) : undefined;
    const pastKey = `/team-schedule-past/${req.params.id}/${domestic}`;

    // Fast path: return only FINISHED matches from permanent Supabase cache.
    // Skip when a specific season is requested (cache is keyed without season).
    if (req.query.past === "true" && !season) {
      const cached = await getCached(pastKey);
      return res.json(cached ?? []);
    }

    // International tournaments (WC, EC): skip the assembled Supabase cache and always
    // rebuild synchronously. The Vercel SWR pattern fires a background refresh after sending
    // the response, but Vercel kills that background task — so stale assembled data persists
    // indefinitely. For intl comps we must serve fresh data so bracket propagation (which fills
    // in TBD team names after each round) is always reflected. The cost is negligible because
    // the underlying fd.org data is already cached in apiFetch at a 2-min TTL.
    if (isInternationalComp(domestic)) {
      const fdMatches = await getTeamSchedule(req.params.id, domestic, season);
      fdMatches.sort((a, b) => +new Date(b.utcDate) - +new Date(a.utcDate));
      const finished = fdMatches.filter((m) => m.status === "FINISHED");
      if (finished.length > 0) setCached(pastKey, finished, FOREVER_TTL_MS);
      return res.json(fdMatches);
    }

    // SWR: serve stale assembled schedule immediately on cache expiry (background refresh).
    // Prevents Vercel timeouts caused by blocking on 4 parallel fd.org fetches + cup scraping.
    const assembledKey = `/team-schedule-full/${req.params.id}/${domestic}${season ? `/${season}` : ""}`;
    const ASSEMBLED_TTL = 30 * 60 * 1000; // 30 min — aligned with SCHEDULE_TTL_MS in footballApi

    await serveWithSWR(res, assembledKey, ASSEMBLED_TTL,
      async () => {
        const [fdMatches, cupMatches] = await Promise.all([
          getTeamSchedule(req.params.id, domestic, season),
          (async () => {
            if (!teamName || season) return [];
            if (DOMESTIC_CUP_MAP[domestic]) {
              return fetchEspnCupMatches(teamIdNum, teamName, domestic);
            }
            if (TM_CUP_LEAGUES.has(domestic)) {
              const tmRef = await getTmClubRef(teamName);
              if (tmRef) {
                const now = new Date();
                const tmSeason = now.getFullYear() - (now.getMonth() < 7 ? 1 : 0);
                return fetchTmCupMatches(teamIdNum, teamName, tmRef.slug, tmRef.id, tmSeason);
              }
            }
            return [];
          })(),
        ]);

        const seen = new Set<number>(fdMatches.map((m) => m.id));
        const merged = [...fdMatches];
        for (const m of cupMatches) {
          if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
        }
        merged.sort((a, b) => +new Date(b.utcDate) - +new Date(a.utcDate));

        const finished = merged.filter((m) => m.status === "FINISHED");
        if (finished.length > 0) setCached(pastKey, finished, FOREVER_TTL_MS);

        return merged;
      },
      (d) => d.length > 0
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/h2h", async (req, res) => {
  try {
    const teamId1 = parseId((req.query.homeTeamId as string | undefined) ?? "");
    const teamId2 = parseId((req.query.awayTeamId as string | undefined) ?? "");
    const comp    = safeStr(req.query.comp as string | undefined) || "PL";
    if (!teamId1 || !teamId2) return res.status(400).json({ error: "invalid team IDs" });
    // Canonical key: sort IDs so A-vs-B and B-vs-A share the same cache entry.
    const key = `/h2h/v1/${[teamId1, teamId2].sort().join("-")}/${comp}`;
    await serveWithSWR(res, key, 30 * 60 * 1000,
      () => getH2HMatches(teamId1, teamId2, comp, 5),
      (d) => Array.isArray(d) && d.length > 0
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

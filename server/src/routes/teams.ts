import { Router } from "express";
import { getCompetitions, getTeams, getTeamLineup, getTeamSchedule, getMatchDetail, getMatchLineups, getStandings, getCompetitionSeasons, getTopScorers, getTeamCleanSheets, getBracketMatches, getLiveMatches, getPositionHistory, getUpcomingFixtures, getH2HMatches, type StandingsData, type MatchGoalEvent } from "../services/footballApi";
import { fetchClubHonours, type ClubTrophy } from "../services/wikiStats";
import { scrapeTransfermarktHonours, getTmClubRef } from "../services/transfermarktScraper";
import { getMatchPlayerStats, getEspnMatchLineup, getMatchTeamStats, getMatchGoalEvents, getMatchBookingsAndSubs, teamsMatch, type EspnLineupPlayer } from "../services/matchStatsScraper";
import { fetchEspnCupMatches, fetchTmCupMatches, DOMESTIC_CUP_MAP, TM_CUP_LEAGUES } from "../services/cupSchedule";
import { fetchTeamNews } from "../services/newsService";
import { getCached, getAnyCached, setCached, FOREVER_TTL_MS } from "../db/apiCache";
import type { Response } from "express";

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
    if (hit.stale) {
      fetch()
        .then((fresh) => { if (shouldCache(fresh)) setCached(key, fresh, ttlMs); })
        .catch((e) => console.error(`[SWR] refresh failed for ${key}:`, e.message));
    }
    return;
  }
  const fresh = await fetch();
  if (shouldCache(fresh)) setCached(key, fresh, ttlMs);
  res.json(fresh);
}
import type { MatchLineupPlayer } from "../services/footballApi";

const CLUB_HONOURS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory cache for computed lineup responses — avoids re-running photo resolution
// and XI selection on every request. Underlying squad + scorer data (in apiFetch/Supabase)
// has its own TTL; this layer caches the assembled result for one hour.
const lineupCache = new Map<string, { data: unknown; fetchedAt: number }>();
const LINEUP_TTL_MS = 60 * 60 * 1000; // 1 hour

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
    res.json(await getUpcomingFixtures(dateFrom, dateTo));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions", async (_req, res) => {
  try {
    res.json(await getCompetitions());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions/:code/teams", async (req, res) => {
  try {
    res.json(await getTeams(req.params.code));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions/:code/seasons", async (req, res) => {
  try {
    const cacheKey = `/competition-seasons/v2/${req.params.code}`;
    const cached = await getCached(cacheKey);
    if (cached) return res.json(cached);
    const seasons = await getCompetitionSeasons(req.params.code);
    if (seasons.length > 0) setCached(cacheKey, seasons, 24 * 60 * 60 * 1000); // 24 hours
    res.json(seasons);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions/:code/bracket", async (req, res) => {
  try {
    const season = req.query.season ? parseInt(req.query.season as string, 10) : undefined;
    const data = await getBracketMatches(req.params.code, season);
    if (!data) return res.status(404).json({ error: "bracket not available" });
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions/:code/standings", async (req, res) => {
  try {
    const season = req.query.season ? parseInt(req.query.season as string, 10) : undefined;
    const cacheKey = `/standings/v4/${req.params.code}${season ? `/${season}` : ""}`;
    await serveWithSWR(res, cacheKey, 60 * 60 * 1000,
      () => getStandings(req.params.code, season),
      (d) => d.groups.length > 0
    );
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/competitions/:code/scorers", async (req, res) => {
  try {
    const season = req.query.season ? parseInt(req.query.season as string, 10) : undefined;
    const cacheKey = `/scorers/v3/${req.params.code}${season ? `/${season}` : ""}`;
    await serveWithSWR(res, cacheKey, 60 * 60 * 1000,
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

router.get("/live-matches", async (_req, res) => {
  try {
    res.json(await getLiveMatches());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/teams/search", async (req, res) => {
  const q = safeStr(req.query.q as string | undefined, 50).toLowerCase();
  if (q.length < 2) return res.json([]);
  try {
    const competitions = await getCompetitions();
    const teamArrays = await Promise.all(
      competitions.map((c: { code: string }) => getTeams(c.code).catch(() => []))
    );
    const seen = new Set<number>();
    const results: unknown[] = [];
    for (const teams of teamArrays) {
      for (const team of teams as any[]) {
        if (seen.has(team.id)) continue;
        const name = (team.name ?? "").toLowerCase();
        const short = (team.shortName ?? "").toLowerCase();
        const tla = (team.tla ?? "").toLowerCase();
        if (name.includes(q) || short.includes(q) || tla.includes(q)) {
          seen.add(team.id);
          results.push(team);
        }
      }
    }
    res.json(results.slice(0, 15));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/teams/:id/lineup", async (req, res) => {
  const competition = (req.query.competition as string) || "PL";
  const cacheKey = `${req.params.id}:${competition}`;
  const hit = lineupCache.get(cacheKey);
  if (hit && Date.now() - hit.fetchedAt < LINEUP_TTL_MS) return res.json(hit.data);
  try {
    const data = await getTeamLineup(req.params.id, competition || undefined);
    lineupCache.set(cacheKey, { data, fetchedAt: Date.now() });
    res.json(data);
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

    const detail = await getMatchDetail(matchId, status);
    let goals = detail.goals;
    let bookings = detail.bookings;
    let substitutions = detail.substitutions;

    if (homeTeam && awayTeam && utcDate && competition) {
      // Supplement goals from ESPN when fd.org returns none (free-tier gap)
      if (goals.length === 0) {
        try {
          const espnGoals = await getMatchGoalEvents(homeTeam, awayTeam, utcDate, competition);
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
          const espnEvents = await getMatchBookingsAndSubs(matchId, homeTeam, awayTeam, utcDate, competition);
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

    res.json({ ...detail, goals, bookings, substitutions });
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
    const stats = await getMatchTeamStats(matchId, homeTeam, awayTeam, utcDate, competition);
    if (!stats) return res.status(404).json({ error: "team stats not available" });
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
    if (!homeTeam || !awayTeam || !utcDate) {
      return res.status(400).json({ error: "homeTeam, awayTeam, utcDate required" });
    }
    const stats = await getMatchPlayerStats(matchId, homeTeam, awayTeam, utcDate, competition);
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

    res.json(lineups);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});


router.get("/teams/:id/news", async (req, res) => {
  try {
    const teamName = (req.query.name as string | undefined)?.trim();
    if (!teamName) return res.status(400).json({ error: "?name= query param required" });
    const articles = await fetchTeamNews(teamName);
    res.json(articles);
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

    // Fetch football-data.org schedule + cup matches in parallel
    const [fdMatches, cupMatches] = await Promise.all([
      getTeamSchedule(req.params.id, domestic, season),
      (async () => {
        if (!teamName || season) return []; // skip cup scraping for specific historical seasons
        // ESPN cup scraper (Copa del Rey, DFB-Pokal, Coppa Italia, KNVB Beker)
        if (DOMESTIC_CUP_MAP[domestic]) {
          return fetchEspnCupMatches(teamIdNum, teamName, domestic);
        }
        // Transfermarkt cup scraper (FA Cup / EFL Cup for PL + Championship)
        if (TM_CUP_LEAGUES.has(domestic)) {
          const tmRef = await getTmClubRef(teamName);
          if (tmRef) {
            // TM saison_id: 2025 = 2025/26 season. Season starts in ~July.
            const now = new Date();
            const season = now.getFullYear() - (now.getMonth() < 7 ? 1 : 0);
            return fetchTmCupMatches(teamIdNum, teamName, tmRef.slug, tmRef.id, season);
          }
        }
        return [];
      })(),
    ]);

    // Merge, deduplicate by id, sort newest-first
    const seen = new Set<number>(fdMatches.map((m) => m.id));
    const merged = [...fdMatches];
    for (const m of cupMatches) {
      if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
    }
    merged.sort((a, b) => +new Date(b.utcDate) - +new Date(a.utcDate));

    // Persist finished matches permanently — they are immutable and serve the ?past=true fast path.
    const finished = merged.filter((m) => m.status === "FINISHED");
    if (finished.length > 0) setCached(pastKey, finished, FOREVER_TTL_MS);

    res.json(merged);
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
    res.json(await getH2HMatches(teamId1, teamId2, comp, 5));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import teamsRouter, { clearLineupCacheForTeam } from "./routes/teams";
import playersRouter from "./routes/players";
import favouritesRouter from "./routes/favourites";
import accountRouter from "./routes/account";
import { getClient } from "./db/supabase";
import { deleteCached, deleteCachedByPrefix } from "./db/apiCache";
import { getTeamSquadPlayers, getTeams } from "./services/footballApi";
import { refreshPlayerProfile, getProfileRefreshMeta } from "./services/playerStore";
import { fetchPlayerWikiData } from "./services/wikiStats";
import { fetchSofaScoreCareer } from "./services/sofaScoreCareer";
import { scrapeTransfermarktPlayerStats, type TmCareerRow } from "./services/transfermarktScraper";
import { setWikiStats, getWikiStats, clearPlayerCareer, type WikiCareerRow } from "./db/wikiCareerCache";
import { setWikiTrophies, getWikiTrophies } from "./db/wikiTrophyCache";
import { requireAdmin } from "./utils/auth";
import { SupabaseRateLimitStore } from "./utils/rateLimitStore";
import { warmL1Cache } from "./utils/warmup";

dotenv.config();
warmL1Cache();

const app = express();

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// Gzip compression for all responses
app.use(compression());

// Restrict CORS to the known client origin (configurable via env for production)
const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173").split(",").map((o) => o.trim());
app.use(cors({ origin: allowedOrigins }));

// General API rate limit: 200 requests per minute per IP.
// Uses a shared Supabase store so the limit is enforced consistently across all
// Vercel instances. Requires server/migrations/001_rate_limits.sql to be applied.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  store: process.env.SUPABASE_URL ? new SupabaseRateLimitStore(RATE_LIMIT_WINDOW_MS) : undefined,
  message: { error: "Too many requests, please slow down." },
});

// Strict limit for admin endpoints: 10 per minute per IP
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests." },
});

// Tighter limit for authenticated user data endpoints: 30 per minute per IP.
// Applied in addition to the general apiLimiter above.
const favLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests." },
});

if (process.env.LOG_REQUESTS === "true") {
  app.use((req, _res, next) => {
    console.log(`[req] ${req.method} ${req.path}`);
    next();
  });
}

app.use("/api", apiLimiter);
app.use(express.json({ limit: "100kb" }));

app.use("/api", teamsRouter);
app.use("/api/players", playersRouter);
app.use("/api/favourites", favLimiter, favouritesRouter);
app.use("/api/account", favLimiter, accountRouter);

const SERVER_STARTED_AT = Date.now();
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", startedAt: SERVER_STARTED_AT, mock: !process.env.FOOTBALL_API_KEY, key: process.env.FOOTBALL_API_KEY ? "set" : "missing" });
});

// Team IDs (La Liga + UCL)
const TEAM_IDS: Record<string, string> = {
  // La Liga
  athletic_club: "77",
  atletico_madrid: "78",
  osasuna: "79",
  espanyol: "80",
  barcelona: "81",
  getafe: "82",
  real_madrid: "86",
  rayo_vallecano: "87",
  levante: "88",
  mallorca: "89",
  real_betis: "90",
  real_sociedad: "92",
  villarreal: "94",
  valencia: "95",
  alaves: "263",
  elche: "285",
  girona: "298",
  celta: "558",
  sevilla: "559",
  real_oviedo: "1048",
  // Bundesliga
  fc_koeln: "1",
  hoffenheim: "2",
  leverkusen: "3",
  dortmund: "4",
  bayern: "5",
  hsv: "7",
  stuttgart: "10",
  wolfsburg: "11",
  bremen: "12",
  mainz: "15",
  augsburg: "16",
  freiburg: "17",
  mgladbach: "18",
  frankfurt: "19",
  st_pauli: "20",
  union_berlin: "28",
  heidenheim: "44",
  rb_leipzig: "721",
  // Premier League
  arsenal: "57",
  aston_villa: "58",
  chelsea: "61",
  everton: "62",
  fulham: "63",
  liverpool: "64",
  man_city: "65",
  man_united: "66",
  newcastle: "67",
  sunderland: "71",
  tottenham: "73",
  wolves: "76",
  burnley: "328",
  leeds: "341",
  nottingham: "351",
  crystal_palace: "354",
  brighton: "397",
  brentford: "402",
  west_ham: "563",
  bournemouth: "1044",
  // Serie A
  milan: "98",
  fiorentina: "99",
  roma: "100",
  atalanta: "102",
  bologna: "103",
  cagliari: "104",
  genoa: "107",
  inter: "108",
  juventus: "109",
  lazio: "110",
  parma: "112",
  napoli: "113",
  udinese: "115",
  verona: "450",
  cremonese: "457",
  sassuolo: "471",
  pisa: "487",
  torino: "586",
  lecce: "5890",
  como: "7397",
  // Ligue 1
  toulouse: "511",
  brest: "512",
  marseille: "516",
  auxerre: "519",
  lille: "521",
  nice: "522",
  lyon: "523",
  psg: "524",
  lorient: "525",
  rennes: "529",
  angers: "532",
  le_havre: "533",
  nantes: "543",
  metz: "545",
  lens: "546",
  monaco: "548",
  strasbourg: "576",
  paris_fc: "1045",
  // Primeira Liga (UCL)
  sporting_cp: "498",
  benfica: "1903",
  // Other UCL
  galatasaray: "610",
  qarabag: "611",
  olympiakos: "654",
  psv: "674",
  ajax: "678",
  club_brugge: "851",
  slavia_praha: "930",
  kobenhavn: "1876",
  union_sg: "3929",
  bodo_glimt: "5721",
  fk_kairat: "10601",
  paphos: "11034",
};

// Populate Wikipedia career stats for all players on a given team.
// Runs sequentially (1 player at a time) to be polite to Wikipedia.
app.post("/api/admin/populate-wiki-stats", adminLimiter, requireAdmin, async (req, res) => {
  const teamsParam = (req.query.teams as string ?? req.query.team as string ?? "").toLowerCase().replace(/\s/g, "_");
  const teamKeys = teamsParam.split(",").map((t) => t.trim()).filter(Boolean);
  const resolved = teamKeys.map((k) => ({ key: k, id: TEAM_IDS[k] }));
  const invalid = resolved.filter((r) => !r.id);
  if (invalid.length || resolved.length === 0) {
    return res.status(400).json({ error: `Unknown team(s). Use: ${Object.keys(TEAM_IDS).join(", ")}` });
  }

  const skipExisting = req.query.skip_existing !== "false";
  const trophiesOnly = req.query.trophies_only === "true";
  res.json({ status: "started", teams: teamKeys, skip_existing: skipExisting, trophies_only: trophiesOnly });

  (async () => {
    for (const { key: teamKey, id: teamId } of resolved) {
      let done = 0;
      let skipped = 0;
      let failed = 0;
      try {
        const { teamName, players } = await getTeamSquadPlayers(teamId!);
        for (const player of players) {
          const [existingStats, existingHonours] = skipExisting
            ? await Promise.all([getWikiStats(player.id), getWikiTrophies(player.id)])
            : [null, null] as const;
          const needsCareer = trophiesOnly ? false : (!existingStats || existingStats.length === 0);
          const needsHonours = trophiesOnly
            ? (existingHonours === null || existingHonours.length === 0)
            : existingHonours === null;
          if (skipExisting && !needsCareer && !needsHonours) { skipped++; continue; }
          try {
            // SofaScore primary (real assists, full history), Transfermarkt backup
            // (current season only — TM's full history is paywalled). Wikipedia is never
            // used for career: its club tables have no Assists column.
            const [{ trophies }, sofaCareer, tmCareer] = await Promise.all([
              fetchPlayerWikiData(player.name, false, needsHonours),
              needsCareer
                ? fetchSofaScoreCareer(player.name, player.id).catch(() => [] as WikiCareerRow[])
                : Promise.resolve([] as WikiCareerRow[]),
              needsCareer
                ? scrapeTransfermarktPlayerStats(player.name, teamName, player.id).catch(() => [] as TmCareerRow[])
                : Promise.resolve([] as TmCareerRow[]),
            ]);
            const career: WikiCareerRow[] = sofaCareer.length > 0
              ? sofaCareer
              : tmCareer.map((r) => ({ season: r.season, team: r.team, league: r.competition, appearances: r.appearances, goals: r.goals, assists: r.assists }));
            await Promise.all([
              needsCareer ? setWikiStats(player.id, player.name, career) : Promise.resolve(),
              needsHonours ? setWikiTrophies(player.id, player.name, trophies) : Promise.resolve(),
            ]);
            done++;
          } catch (e: any) {
            console.error(`[populate-wiki] Error for ${player.name}: ${e.message}`);
            failed++;
          }
          await new Promise((r) => setTimeout(r, 3000));
        }
      } catch (e: any) {
        console.error(`[populate-wiki] Error fetching squad for ${teamKey}: ${e.message}`);
      }
      console.log(`[populate-wiki] ${teamKey} done: ${done} ok, ${skipped} skipped, ${failed} failed`);
    }
  })();
});

// Once-daily player-stats refresh — called by Vercel cron (Authorization: Bearer CRON_SECRET)
// and manually via GET /api/admin/refresh-players with x-admin-secret header.
//
// Walks the big-5 league squads (override with ?leagues=PL,PD,BL1,SA,FL1), then re-runs the
// assembly pipeline for each player and upserts player_profiles. Ordered least-complete /
// stalest first, so a fresh deployment fills the roster out over successive nights and then
// just keeps it current. Bounded by ?budgetMs (default 280s) to stay under the function's
// maxDuration; fd.org's rate limit is the real throughput cap, so full coverage is gradual.
const BIG_5 = ["PL", "PD", "BL1", "SA", "FL1"];
app.get("/api/admin/refresh-players", adminLimiter, requireAdmin, async (req, res) => {
  const leagues = ((req.query.leagues as string) || BIG_5.join(","))
    .split(",").map((s) => s.trim()).filter(Boolean);
  const budgetMs = Math.min(Number(req.query.budgetMs) || 280_000, 290_000);
  const paceMs = Math.max(Number(req.query.paceMs) || 1200, 0);
  const started = Date.now();

  try {
    // Build player -> {teamId, competition} from the league squads.
    const idTeam = new Map<number, number>();
    const idComp = new Map<number, string>();
    for (const code of leagues) {
      try {
        const teams = await getTeams(code);
        for (const t of teams as Array<{ id: number }>) {
          try {
            const { players } = await getTeamSquadPlayers(String(t.id));
            for (const p of players) {
              idTeam.set(p.id, t.id);
              idComp.set(p.id, code);
            }
          } catch { /* skip unreadable squad */ }
        }
      } catch { /* skip unreadable league */ }
    }

    const ids = [...idTeam.keys()];
    const meta = await getProfileRefreshMeta(ids);
    // Priority: never-stored (0) → stored-incomplete (1) → stored-complete (2); then oldest first.
    ids.sort((a, b) => {
      const ma = meta.get(a), mb = meta.get(b);
      const rank = (m?: { complete: boolean }) => (!m ? 0 : m.complete ? 2 : 1);
      const ra = rank(ma), rb = rank(mb);
      if (ra !== rb) return ra - rb;
      const ta = ma ? new Date(ma.refreshed_at).getTime() : 0;
      const tb = mb ? new Date(mb.refreshed_at).getTime() : 0;
      return ta - tb;
    });

    let done = 0, failed = 0, processed = 0;
    for (const id of ids) {
      if (Date.now() - started > budgetMs) break;
      processed++;
      try {
        const r = await refreshPlayerProfile(id, idComp.get(id) ?? "PL", idTeam.get(id));
        if (r) done++; else failed++;
      } catch { failed++; }
      if (paceMs) await new Promise((r) => setTimeout(r, paceMs));
    }

    const elapsedSec = Math.round((Date.now() - started) / 1000);
    console.log(`[refresh-players] processed=${processed}/${ids.length} ok=${done} failed=${failed} in ${elapsedSec}s`);
    res.json({ leagues, totalPlayers: ids.length, processed, refreshed: done, failed, elapsedSec });
  } catch (e: any) {
    res.status(500).json({ error: e.message, elapsedSec: Math.round((Date.now() - started) / 1000) });
  }
});

// Purge expired api_cache rows — called daily by Vercel cron (Authorization: Bearer CRON_SECRET)
// and manually via DELETE /api/admin/cache/expired with x-admin-secret header.
app.delete("/api/admin/cache/expired", adminLimiter, requireAdmin, async (_req, res) => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { error, count } = await getClient()
      .from("api_cache")
      .delete({ count: "exact" })
      .lt("expires_at", cutoff);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ deleted: count, cutoff });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Force-refresh squad data for specific team(s) by deleting their api_cache entries.
// Useful during transfer windows when fd.org data changes but the 24h TTL hasn't expired yet.
// Query params: teamId (fd.org team ID) and/or competitionCode (e.g. "PD", "PL").
// Deletes /teams/{teamId}, /competitions/{competitionCode}/teams, the SofaScore photo map,
// and all lineup cache entries for the team (across competitions) — via deleteCached /
// deleteCachedByPrefix so the in-process apiCache memCache is cleared too, not just Supabase.
// Also drops the team's entries from routes/teams.ts's separate in-process lineupCache Map,
// which neither of those touches — without this a warm instance kept serving the pre-purge
// squad for up to LINEUP_TTL_MS (24h) even right after calling this endpoint.
app.delete("/api/admin/cache/squad", adminLimiter, requireAdmin, async (req, res) => {
  const teamId = req.query.teamId as string | undefined;
  const competitionCode = (req.query.competitionCode as string | undefined)?.toUpperCase();

  const paths: string[] = [];
  if (teamId) {
    paths.push(`/teams/${teamId}`);
    paths.push(`/sofa-photos/${teamId}`);
  }
  if (competitionCode) paths.push(`/competitions/${competitionCode}/teams`);

  if (paths.length === 0) {
    return res.status(400).json({ error: "Provide at least one of: teamId, competitionCode" });
  }

  try {
    await Promise.all(paths.map((p) => deleteCached(p)));

    let lineupCleared = 0;
    if (teamId) {
      await deleteCachedByPrefix(`/team-lineup/v3/${teamId}/`);
      lineupCleared = clearLineupCacheForTeam(teamId);
    }

    res.json({
      clearedPaths: paths,
      lineupPrefix: teamId ? `/team-lineup/v3/${teamId}/` : null,
      lineupCacheEntriesCleared: lineupCleared,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/photo-cache/nulls", adminLimiter, requireAdmin, async (_req, res) => {
  try {
    const { error, count } = await getClient()
      .from("player_photos")
      .delete({ count: "exact" })
      .is("photo_url", null);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ deleted: count });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Clear career cache for specific players (by fd.org player ID).
// Deletes player_seasons rows + SofaScore career/ID lookup keys from api_cache.
// Forces a clean re-fetch from SofaScore on next profile view.
// Query: ?playerIds=123,456,789
app.delete("/api/admin/cache/career", adminLimiter, requireAdmin, async (req, res) => {
  const raw = req.query.playerIds as string | undefined;
  if (!raw?.trim()) {
    return res.status(400).json({ error: "Provide playerIds as comma-separated fd.org player IDs" });
  }
  const ids = raw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
  if (ids.length === 0) return res.status(400).json({ error: "No valid player IDs" });

  try {
    const ssPaths = ids.flatMap((id) => [`/ss-career/${id}`, `/ss-player-id/${id}`]);
    const [careerResult, cacheResult] = await Promise.all([
      clearPlayerCareer(ids),
      getClient().from("api_cache").delete({ count: "exact" }).in("path", ssPaths),
    ]);
    res.json({
      playerIds: ids,
      playerSeasonsDeleted: careerResult.deleted,
      apiCacheDeleted: cacheResult.count ?? 0,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default app;

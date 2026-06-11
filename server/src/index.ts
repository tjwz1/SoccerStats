import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import teamsRouter from "./routes/teams";
import playersRouter from "./routes/players";
import { getClient } from "./db/supabase";
import { getTeamSquadPlayers } from "./services/footballApi";
import { fetchPlayerWikiData } from "./services/wikiStats";
import { setWikiStats, getWikiStats } from "./db/wikiCareerCache";
import { setWikiTrophies, getWikiTrophies } from "./db/wikiTrophyCache";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// Gzip compression for all responses
app.use(compression());

// Restrict CORS to the known client origin (configurable via env for production)
const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173").split(",").map((o) => o.trim());
app.use(cors({ origin: allowedOrigins }));

// General API rate limit: 200 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
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

app.use("/api", apiLimiter);
app.use(express.json({ limit: "100kb" }));

app.use("/api", teamsRouter);
app.use("/api/players", playersRouter);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", mock: !process.env.FOOTBALL_API_KEY, key: process.env.FOOTBALL_API_KEY ? "set" : "missing" });
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

// Guard for admin endpoints: require a matching X-Admin-Secret header or localhost origin.
// If ADMIN_SECRET is unset, only localhost requests are allowed.
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const secret = process.env.ADMIN_SECRET;
  const provided = req.headers["x-admin-secret"] as string | undefined;
  const isLocalhost = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
  if ((secret && provided === secret) || (!secret && isLocalhost)) return next();
  res.status(403).json({ error: "Forbidden" });
}

// Populate Wikipedia career stats for all players on a given team.
// Runs sequentially (1 player at a time) to be polite to Wikipedia.
app.post("/api/admin/populate-wiki-stats", adminLimiter, requireAdmin, async (req, res) => {
  // Accept comma-separated teams, e.g. ?teams=barcelona,real_madrid
  const teamsParam = (req.query.teams as string ?? req.query.team as string ?? "").toLowerCase().replace(/\s/g, "_");
  const teamKeys = teamsParam.split(",").map((t) => t.trim()).filter(Boolean);
  const resolved = teamKeys.map((k) => ({ key: k, id: TEAM_IDS[k] }));
  const invalid = resolved.filter((r) => !r.id);
  if (invalid.length || resolved.length === 0) {
    return res.status(400).json({ error: `Unknown team(s). Use: ${Object.keys(TEAM_IDS).join(", ")}` });
  }

  // ?skip_existing=false to re-fetch players who already have stats (default: skip)
  // ?trophies_only=true to only re-fetch honours (skips career, treats empty [] as needs-fetch)
  const skipExisting = req.query.skip_existing !== "false";
  const trophiesOnly = req.query.trophies_only === "true";
  res.json({ status: "started", teams: teamKeys, skip_existing: skipExisting, trophies_only: trophiesOnly });

  // Run teams sequentially so we stay within Wikipedia's rate limit (~1 req/s total)
  (async () => {
    for (const { key: teamKey, id: teamId } of resolved) {
      let done = 0;
      let skipped = 0;
      let failed = 0;
      try {
        const players = await getTeamSquadPlayers(teamId!);
        for (const player of players) {
          // Single parallel cache check; skip only when both are already populated.
          const [existingStats, existingHonours] = skipExisting
            ? await Promise.all([getWikiStats(player.id), getWikiTrophies(player.id)])
            : [null, null] as const;
          // trophies_only: skip career entirely; re-fetch honours even if empty array
          const needsCareer = trophiesOnly ? false : (!existingStats || existingStats.length === 0);
          const needsHonours = trophiesOnly
            ? (existingHonours === null || existingHonours.length === 0)
            : existingHonours === null;
          if (skipExisting && !needsCareer && !needsHonours) { skipped++; continue; }
          try {
            const { career, trophies } = await fetchPlayerWikiData(player.name, needsCareer, needsHonours);
            await Promise.all([
              needsCareer ? setWikiStats(player.id, player.name, career) : Promise.resolve(),
              needsHonours ? setWikiTrophies(player.id, trophies) : Promise.resolve(),
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (!process.env.FOOTBALL_API_KEY) {
    console.log("No FOOTBALL_API_KEY set — using mock data");
  }
});

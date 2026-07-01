import fetch from "node-fetch";
import https from "https";
import { MOCK_COMPETITIONS, MOCK_TEAMS, MOCK_LINEUP, MOCK_PLAYER_STATS } from "./mockData";
import { fetchPhotos } from "./theSportsDb";
import { fetchFplPhotos } from "./fplPhotos";
import { fetchSofaScorePhotos } from "./sofaScorePhotos";
import { getCached, getAnyCached, setCached, FOREVER_TTL_MS } from "../db/apiCache";
import { getWikiStats, getWikiStatsBatch, setWikiStats } from "../db/wikiCareerCache";
import { getWikiTrophies, setWikiTrophies } from "../db/wikiTrophyCache";
import { fetchPlayerWikiData, getWcSquadFromWiki, getEcSquadFromWiki, getWcKnockoutStatus } from "./wikiStats";
import { scrapeTransfermarktPlayerStats, scrapeTransfermarktPlayerHonours, getTmClubSquad, type TmCareerRow, type TmSquadPlayer } from "./transfermarktScraper";
import type { ClubTrophy as TmClubTrophy } from "./wikiStats";
import type { Trophy } from "../db/wikiTrophyCache";

// Map competition display names (both API and Wikipedia variants) to canonical identifiers
const COMP_CANONICAL: Record<string, string> = {
  "premier league": "premierleague",
  "la liga": "laliga",
  "primera división": "laliga",
  "primera division": "laliga",
  "bundesliga": "bundesliga",
  "1. bundesliga": "bundesliga",
  "serie a": "seriea",
  "ligue 1": "ligue1",
  "eredivisie": "eredivisie",
  "brasileirão": "brasileirao",
  "campeonato brasileiro série a": "brasileirao",
  "primeira liga": "primeiraliga",
  "liga portugal": "primeiraliga",
  "championship": "championship",
  "champions league": "championsleague",
  "uefa champions league": "championsleague",
  "europa league": "europaleague",
  "uefa europa league": "europaleague",
  "copa libertadores": "copaliber",
};

function normalizeComp(name: string): string {
  const lower = name.toLowerCase().trim();
  return COMP_CANONICAL[lower] ?? lower.replace(/[^a-z0-9]/g, "");
}

const BASE_URL = "https://api.football-data.org/v4";

function apiKey() { return process.env.FOOTBALL_API_KEY; }
function useMock() { return !apiKey(); }

const SQUAD_TTL_MS = 24 * 60 * 60 * 1000;       // 24 h — squad composition changes at most weekly
const SCORERS_CURRENT_TTL_MS = 2 * 60 * 1000;   // 2 min — fd.org updates scorers every ~2-5 min during live matches

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Deduplicates concurrent live fetches so two requests racing on the same uncached
// path share one HTTP call instead of both 429-ing.
const inflight = new Map<string, Promise<unknown>>();

// Skip TLS verification for football-data.org — their certificate chain is
// incomplete on some Node.js builds (Windows in particular).
const fdAgent = new https.Agent({ rejectUnauthorized: false });

// Raw HTTP fetch from fd.org — retries on 429, caches result.
// The inflight map entry is cleaned up in the finally block.
async function doFetch(path: string, ttlMs?: number): Promise<unknown> {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${BASE_URL}${path}`, {
        headers: { "X-Auth-Token": apiKey()! },
        agent: fdAgent,
      } as Parameters<typeof fetch>[1]);
      if (res.status === 429) {
        const waitMs = 30_000; // capped so Vercel functions can still respond; SWR routes serve stale meanwhile
        console.warn(`[footballApi] Rate limited on ${path} (attempt ${attempt + 1}), waiting ${waitMs / 1000}s…`);
        if (attempt < 2) await sleep(waitMs);
        continue;
      }
      if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
      const data = await res.json();
      await setCached(path, data, ttlMs);
      return data;
    }
    throw new Error("API error 429: Too Many Requests");
  } finally {
    inflight.delete(path);
  }
}

// Stale-while-revalidate: if a cached entry exists (even if expired), return it
// immediately and kick off a background refresh so the next caller gets fresh data.
// Only when there is NO cached entry at all do we block on the fd.org call.
async function apiFetch(path: string, ttlMs?: number): Promise<unknown> {
  const hit = await getAnyCached(path);

  if (hit !== null) {
    // Stale — start a background refresh if one isn't already running.
    if (hit.stale && !inflight.has(path)) {
      const p = doFetch(path, ttlMs);
      inflight.set(path, p);
      p.catch((e) => console.error(`[footballApi] background refresh failed for ${path}:`, e.message));
    }
    return hit.data; // serve immediately (fresh or stale)
  }

  // No cached entry at all — must wait for a live fetch.
  if (inflight.has(path)) return inflight.get(path)!;
  const p = doFetch(path, ttlMs);
  inflight.set(path, p);
  return p;
}

// ── Position role mapping ─────────────────────────────────────────────────
type Role = "GK" | "RB" | "CB" | "LB" | "DM" | "CM" | "AM" | "RW" | "LW" | "CF";

const ROLE_MAP: Record<string, Role> = {
  "Goalkeeper": "GK",
  "Centre-Back": "CB", "Sweeper": "CB",
  "Right-Back": "RB", "Wing-Back (Right)": "RB",
  "Left-Back": "LB", "Wing-Back (Left)": "LB",
  "Defence": "CB",            // generic fallback
  "Defensive Midfield": "DM",
  "Central Midfield": "CM",
  "Midfield": "CM",           // generic fallback
  "Attacking Midfield": "AM",
  "Right Winger": "RW", "Right Midfield": "RW",
  "Left Winger": "LW",  "Left Midfield": "LW",
  "Second Striker": "CF", "Centre-Forward": "CF",
  "Offence": "CF",            // generic fallback
};

// Positions that have no specific detail (youth/reserve designations)
const GENERIC_POS = new Set(["Goalkeeper", "Defence", "Midfield", "Offence", null]);

function getRole(pos: string | null): Role | null {
  return pos ? (ROLE_MAP[pos] ?? null) : null;
}

function broadPosition(role: Role): "Goalkeeper" | "Defender" | "Midfielder" | "Attacker" {
  if (role === "GK") return "Goalkeeper";
  if (["RB", "CB", "LB"].includes(role)) return "Defender";
  if (["DM", "CM", "AM"].includes(role)) return "Midfielder";
  return "Attacker";
}

// Fetch total career appearances from the wiki cache for all squad members in parallel.
// Used as a secondary ranking signal for defenders/GKs absent from the scorers endpoint
// (the scorers API only includes players with at least one goal or assist).
// Single batch Supabase query instead of N parallel queries — ~10× faster for a typical squad.
async function fetchCareerAppTotals(squad: any[]): Promise<Map<number, number>> {
  const playerIds = squad.map((p: any) => p.id as number);
  const wikiMap = await getWikiStatsBatch(playerIds);
  const map = new Map<number, number>();
  for (const [id, rows] of wikiMap) {
    const total = rows.reduce((sum, r) => sum + (r.appearances ?? 0), 0);
    if (total > 0) map.set(id, total);
  }
  return map;
}

// ── Starting XI selection ─────────────────────────────────────────────────
type PickedPlayer = { player: any; role: Role };

function buildPool(
  squad: any[],
  photos: Record<number, string | null> = {},
  appearances: Map<number, number> = new Map(),
  careerApps: Map<number, number> = new Map()
): Record<Role, any[]> {
  const pool: Record<Role, any[]> = {
    GK: [], RB: [], CB: [], LB: [], DM: [], CM: [], AM: [], RW: [], LW: [], CF: [],
  };
  for (const p of squad) {
    const r = getRole(p.position);
    if (r) pool[r].push(p);
  }
  // Sort: specific position → current-season apps → photo → career total apps → shirt number
  // Photo is before careerApps: TheSportsDB coverage is a reliable "first-team player" signal
  // whereas careerApps from wiki may be 0 for players whose career table didn't parse.
  for (const role of Object.keys(pool) as Role[]) {
    pool[role].sort((a, b) => {
      const ag = GENERIC_POS.has(a.position) ? 1 : 0;
      const bg = GENERIC_POS.has(b.position) ? 1 : 0;
      if (ag !== bg) return ag - bg;
      const aApps = appearances.get(a.id) ?? 0;
      const bApps = appearances.get(b.id) ?? 0;
      if (aApps !== bApps) return bApps - aApps;
      const ap = photos[a.id] ? 0 : 1;
      const bp = photos[b.id] ? 0 : 1;
      if (ap !== bp) return ap - bp;
      // Wiki career totals — tiebreaker when both have (or lack) photos
      const aCareer = careerApps.get(a.id) ?? 0;
      const bCareer = careerApps.get(b.id) ?? 0;
      if (aCareer !== bCareer) return bCareer - aCareer;
      return (a.shirtNumber ?? 99) - (b.shirtNumber ?? 99);
    });
  }
  return pool;
}

function selectXI(
  squad: any[],
  photos: Record<number, string | null> = {},
  appearances: Map<number, number> = new Map(),
  careerApps: Map<number, number> = new Map()
): PickedPlayer[] {
  const pool = buildPool(squad, photos, appearances, careerApps);
  const pick = (role: Role, n: number): PickedPlayer[] =>
    pool[role].slice(0, n).map((p) => ({ player: p, role }));

  // GK
  const gk: PickedPlayer[] = pool.GK[0] ? [{ player: pool.GK[0], role: "GK" as Role }] : [];

  // Back line: RB+2CB+LB (standard), or fill missing FB slots with extra CBs
  const rb = pick("RB", 1);
  const lb = pick("LB", 1);
  const fbCount = rb.length + lb.length; // 0, 1, or 2
  const cbCount = fbCount === 2 ? 2 : fbCount === 1 ? 3 : 4;
  const cb = pick("CB", cbCount);
  const backs: PickedPlayer[] = [...rb, ...cb, ...lb];
  const nBack = backs.length;
  const outfieldSlots = 10 - nBack;

  let dm: PickedPlayer[] = [];
  let midLine: PickedPlayer[] = [];
  let attLine: PickedPlayer[] = [];

  const ids = (arr: PickedPlayer[]) => new Set(arr.map(x => x.player.id));

  // Use a dedicated DM row (4-x-y-1 style) only when CMs are scarce.
  // Teams with 3+ genuine CMs (e.g. Barça: Pedri+Frenkie+Fermín) get a proper
  // 4-3-3 so all three midfielders can start instead of being squeezed out by DMs.
  const useDMLine = pool.DM.length >= 1 &&
                    pool.CF.length >= 1 &&
                    (pool.LW.length >= 1 || pool.RW.length >= 1) &&
                    pool.CM.length < 3;

  if (useDMLine) {
    // ─ 4-x-y-1 style (dedicated DM line) ─
    dm = pick("DM", Math.min(pool.DM.length, 2));
    attLine = pick("CF", 1);
    const lw = pool.LW.length ? pick("LW", 1) : [];
    const rw = pool.RW.length ? pick("RW", 1) : [];

    const neededMid = outfieldSlots - dm.length - attLine.length - lw.length - rw.length;
    const used = ids([...gk, ...backs, ...dm, ...attLine, ...lw, ...rw]);
    const amcm: PickedPlayer[] = [...pool.AM, ...pool.CM]
      .filter(p => !used.has(p.id))
      .sort((a, b) => {
        const aApps = appearances.get(a.id) ?? 0;
        const bApps = appearances.get(b.id) ?? 0;
        if (aApps !== bApps) return bApps - aApps;
        const ap = photos[a.id] ? 0 : 1;
        const bp = photos[b.id] ? 0 : 1;
        if (ap !== bp) return ap - bp;
        const aCareer = careerApps.get(a.id) ?? 0;
        const bCareer = careerApps.get(b.id) ?? 0;
        return bCareer - aCareer;
      })
      .slice(0, neededMid)
      .map(p => ({ player: p, role: (getRole(p.position) ?? "CM") as Role }));

    midLine = [...lw, ...amcm, ...rw];
  } else {
    // ─ 4-3-3 style (no dedicated DM line) ─
    const lw = pick("LW", 1);
    const rw = pick("RW", 1);
    const cf = pick("CF", 1);
    attLine = [...lw, ...cf, ...rw];

    const neededMid = outfieldSlots - attLine.length;
    const used = ids([...gk, ...backs, ...attLine]);
    // Global sort across all midfield roles so appearances, then photo, decide who starts
    // regardless of whether they're DM, CM, or AM.
    midLine = [...pool.DM, ...pool.CM, ...pool.AM]
      .filter(p => !used.has(p.id))
      .sort((a, b) => {
        const aApps = appearances.get(a.id) ?? 0;
        const bApps = appearances.get(b.id) ?? 0;
        if (aApps !== bApps) return bApps - aApps;
        const ap = photos[a.id] ? 0 : 1;
        const bp = photos[b.id] ? 0 : 1;
        if (ap !== bp) return ap - bp;
        const aCareer = careerApps.get(a.id) ?? 0;
        const bCareer = careerApps.get(b.id) ?? 0;
        return bCareer - aCareer;
      })
      .slice(0, neededMid)
      // DMs placed in the flat midfield row get CM role so formationString sees "4-3-3"
      .map(p => ({ player: p, role: (getRole(p.position) === "DM" ? "CM" : getRole(p.position) ?? "CM") as Role }));
  }

  const xi: PickedPlayer[] = [...gk, ...backs, ...dm, ...midLine, ...attLine];

  // Safety fill: if squad is thin in a position, pull any remaining mapped player
  if (xi.length < 11) {
    const used = ids(xi);
    const extras = squad
      .filter(p => !used.has(p.id) && getRole(p.position) !== null)
      .sort((a, b) => (GENERIC_POS.has(a.position) ? 1 : 0) - (GENERIC_POS.has(b.position) ? 1 : 0))
      .slice(0, 11 - xi.length)
      .map(p => ({ player: p, role: getRole(p.position) as Role }));
    xi.push(...extras);
  }

  return xi;
}

function formationString(xi: PickedPlayer[]): string {
  const count = (roles: Role[]) => xi.filter(x => roles.includes(x.role)).length;
  const nBack = count(["RB", "CB", "LB"]);
  const nDM   = count(["DM"]);

  if (nDM > 0) {
    // DM row is separate; attacking-mid row = LW/AM/CM/RW; fwd row = CF
    const nMid = count(["CM", "AM", "LW", "RW"]);
    const nFwd = count(["CF"]);
    if (nMid > 0 && nFwd > 0) return `${nBack}-${nDM}-${nMid}-${nFwd}`;
    if (nMid > 0)              return `${nBack}-${nDM}-${nMid}`;
    return `${nBack}-${nDM}`;
  }
  // No DM row: pure mid = CM/AM; attack row = LW/CF/RW together
  const nMid = count(["CM", "AM"]);
  const nAtt = count(["LW", "CF", "RW"]);
  return `${nBack}-${nMid}-${nAtt}`;
}

// ── Photo cache (populated by getTeamLineup, consumed by getMatchLineups) ──
// Capped at 2000 entries to prevent unbounded growth across many team loads.
const PHOTO_CACHE_LIMIT = 2000;
const playerPhotoCache = new Map<number, string | null>();

function setPhotoCache(id: number, url: string | null) {
  if (playerPhotoCache.size >= PHOTO_CACHE_LIMIT && !playerPhotoCache.has(id)) {
    // Evict oldest entry (Maps preserve insertion order)
    playerPhotoCache.delete(playerPhotoCache.keys().next().value!);
  }
  playerPhotoCache.set(id, url);
}

// ── Match lineup types ────────────────────────────────────────────────────
export interface MatchLineupPlayer {
  id: number;
  name: string;
  position: string;      // broad: "Goalkeeper" | "Defender" | "Midfielder" | "Attacker"
  role: Role | null;     // specific: "GK" | "CB" | "LB" | "CM" etc.
  shirtNumber: number | null;
  photo: string | null;
}

export interface MatchLineups {
  homeTeamId: number;
  homeTeamName: string;
  awayTeamId: number;
  awayTeamName: string;
  homeFormation: string;
  awayFormation: string;
  homeStarters: MatchLineupPlayer[];
  awayStarters: MatchLineupPlayer[];
  homeBench: MatchLineupPlayer[];
  awayBench: MatchLineupPlayer[];
  hasData: boolean;
}

function positionBroad(pos: string | null): string {
  if (!pos) return "Midfielder";
  const r = getRole(pos);
  if (r) return broadPosition(r);
  const l = pos.toLowerCase();
  if (l.includes("goal")) return "Goalkeeper";
  if (l.includes("back") || l === "defence") return "Defender";
  if (l.includes("winger") || l.includes("forward") || l.includes("striker") || l === "offence") return "Attacker";
  return "Midfielder";
}

export async function getMatchLineups(matchId: number, status = "FINISHED"): Promise<MatchLineups> {
  // Use appropriate TTL based on match status so lineup data stays fresh until kickoff.
  // Upcoming (SCHEDULED/TIMED): 10 min — official lineups drop ~1 h before kickoff.
  // Live: 1 min — substitutions happen during the match.
  // Finished: cache forever — lineups don't change post-match.
  const ttl = status === "FINISHED" ? FOREVER_TTL_MS
    : ["IN_PLAY", "PAUSED"].includes(status) ? 60_000
    : 10 * 60_000;
  const data = await apiFetch(`/matches/${matchId}`, ttl) as any;

  const mapPlayer = (p: any): MatchLineupPlayer => {
    const role = getRole(p.position) ?? null;
    return {
      id: p.id ?? 0,
      name: p.name ?? "",
      position: positionBroad(p.position),
      role,
      shirtNumber: p.shirtNumber ?? null,
      photo: playerPhotoCache.get(p.id) ?? null,
    };
  };

  const homeLineup: any[] = data.homeTeam?.lineup ?? [];
  const awayLineup: any[] = data.awayTeam?.lineup ?? [];
  const homeBench: any[] = data.homeTeam?.bench ?? [];
  const awayBench: any[] = data.awayTeam?.bench ?? [];

  return {
    homeTeamId: data.homeTeam?.id ?? 0,
    homeTeamName: data.homeTeam?.name ?? "",
    awayTeamId: data.awayTeam?.id ?? 0,
    awayTeamName: data.awayTeam?.name ?? "",
    homeFormation: data.homeTeam?.formation ?? "",
    awayFormation: data.awayTeam?.formation ?? "",
    homeStarters: homeLineup.map(mapPlayer),
    awayStarters: awayLineup.map(mapPlayer),
    homeBench: homeBench.map(mapPlayer),
    awayBench: awayBench.map(mapPlayer),
    hasData: homeLineup.length > 0 || awayLineup.length > 0,
  };
}

// ── Public API ────────────────────────────────────────────────────────────
const COMP_DISPLAY_NAMES: Record<string, string> = {
  "Primera Division": "La Liga",
  "Campeonato Brasileiro Série A": "Brasileirão",
  "ELC": "Championship",
  "1. Bundesliga": "Bundesliga",
  "UEFA Champions League": "Champions League",
  "UEFA Europa League": "Europa League",
  "UEFA Europa Conference League": "Conference League",
  "Copa CONMEBOL Libertadores": "Copa Libertadores",
  "FIFA World Cup": "World Cup",
  "UEFA European Championship": "Euro",
  "European Championship": "Euro",
};

// ── Match detail ──────────────────────────────────────────────────────────

export interface MatchGoalEvent {
  minute: number;
  extraTime: number | null;
  team: "home" | "away";
  scorer: string;
  assist: string | null;
  type: "REGULAR" | "OWN_GOAL" | "PENALTY";
}

export interface MatchBookingEvent {
  minute: number;
  extraTime: number | null;
  team: "home" | "away";
  player: string;
  card: "YELLOW" | "YELLOW_RED" | "RED";
}

export interface MatchSubstitutionEvent {
  minute: number;
  extraTime: number | null;
  team: "home" | "away";
  playerOut: string;
  playerIn: string;
}

export interface MatchDetailData {
  id: number;
  status: string;
  htHome: number | null;
  htAway: number | null;
  ftHome: number | null;
  ftAway: number | null;
  goals: MatchGoalEvent[];
  bookings: MatchBookingEvent[];
  substitutions: MatchSubstitutionEvent[];
}

export async function getMatchDetail(matchId: number, status: string): Promise<MatchDetailData> {
  // Finished matches are immutable — cache forever. Live matches need fresh data.
  const ttl = status === "FINISHED" ? FOREVER_TTL_MS
    : ["IN_PLAY", "PAUSED"].includes(status) ? 60_000
    : 5 * 60_000;

  const data = await apiFetch(`/matches/${matchId}`, ttl) as any;

  const homeId: number = data?.homeTeam?.id ?? 0;

  return {
    id: data.id,
    status: data.status ?? status,
    htHome: data.score?.halfTime?.home ?? null,
    htAway: data.score?.halfTime?.away ?? null,
    ftHome: data.score?.fullTime?.home ?? null,
    ftAway: data.score?.fullTime?.away ?? null,
    goals: (data.goals ?? []).map((g: any): MatchGoalEvent => ({
      minute: g.minute ?? 0,
      extraTime: g.extraTime ?? null,
      team: (g.team?.id ?? 0) === homeId ? "home" : "away",
      scorer: g.scorer?.name ?? g.scorer?.shortName ?? "Unknown",
      assist: g.assist?.name ?? g.assist?.shortName ?? null,
      type: (g.type as MatchGoalEvent["type"]) ?? "REGULAR",
    })),
    bookings: (data.bookings ?? []).map((b: any): MatchBookingEvent => ({
      minute: b.minute ?? 0,
      extraTime: b.extraTime ?? null,
      team: (b.team?.id ?? 0) === homeId ? "home" : "away",
      player: b.player?.name ?? b.player?.shortName ?? "Unknown",
      card: (b.card as MatchBookingEvent["card"]) ?? "YELLOW",
    })),
    substitutions: (data.substitutions ?? []).map((s: any): MatchSubstitutionEvent => ({
      minute: s.minute ?? 0,
      extraTime: s.extraTime ?? null,
      team: (s.team?.id ?? 0) === homeId ? "home" : "away",
      playerOut: s.playerOut?.name ?? s.playerOut?.shortName ?? "Unknown",
      playerIn: s.playerIn?.name ?? s.playerIn?.shortName ?? "Unknown",
    })),
  };
}

// ── Knockout bracket ─────────────────────────────────────────────────────

const GROUP_STAGE_SLUGS = new Set([
  "GROUP_STAGE", "LEAGUE_PHASE", "LEAGUE_STAGE",
  "PRELIMINARY_ROUND", "QUALIFYING", "QUALIFYING_ROUNDS",
  "ADDITIONAL_PRELIMINARY_ROUND",
  "REGULAR_SEASON",  // domestic league matches — not a knockout round
]);

const STAGE_ORDER = [
  "PLAYOFFS", "KNOCKOUT_PHASE_PLAY_OFFS", "PLAYOFF_ROUND",
  "LAST_64", "LAST_32", "LAST_16", "ROUND_OF_16",
  "QUARTER_FINALS", "SEMI_FINALS", "THIRD_PLACE", "FINAL",
];

const STAGE_DISPLAY: Record<string, string> = {
  PLAYOFFS:                 "Play-off",
  KNOCKOUT_PHASE_PLAY_OFFS: "Play-off",
  PLAYOFF_ROUND:            "Play-off",
  LAST_64:                  "Round of 64",
  LAST_32:                  "Round of 32",
  LAST_16:                  "Round of 16",
  ROUND_OF_16:              "Round of 16",
  QUARTER_FINALS:           "Quarter-Finals",
  SEMI_FINALS:              "Semi-Finals",
  THIRD_PLACE:              "3rd Place",
  FINAL:                    "Final",
};

export interface BracketMatchData {
  id: number;
  status: string;
  utcDate: string;
  homeTeam: { id: number; name: string; shortName: string; crest: string };
  awayTeam: { id: number; name: string; shortName: string; crest: string };
  scoreHome: number | null;
  scoreAway: number | null;
  winner: string | null;
  etScoreHome: number | null;
  etScoreAway: number | null;
  penScoreHome: number | null;
  penScoreAway: number | null;
}

export interface BracketTie {
  leg1: BracketMatchData;
  leg2: BracketMatchData | null;
  aggHome: number | null;
  aggAway: number | null;
  winner: "home" | "away" | null;
}

export interface BracketRound {
  name: string;
  stage: string;
  ties: BracketTie[];
}

export interface BracketData {
  rounds: BracketRound[];
}

function mapBracketMatch(m: any): BracketMatchData {
  const ft  = m.score?.fullTime  ?? {};
  const et  = m.score?.extraTime ?? {};
  const pen = m.score?.penalties ?? {};
  return {
    id:          m.id,
    status:      m.status ?? "SCHEDULED",
    utcDate:     m.utcDate ?? "",
    homeTeam: {
      id:        m.homeTeam?.id ?? 0,
      name:      m.homeTeam?.name ?? "",
      shortName: m.homeTeam?.shortName ?? m.homeTeam?.name ?? "",
      crest:     m.homeTeam?.crest ?? "",
    },
    awayTeam: {
      id:        m.awayTeam?.id ?? 0,
      name:      m.awayTeam?.name ?? "",
      shortName: m.awayTeam?.shortName ?? m.awayTeam?.name ?? "",
      crest:     m.awayTeam?.crest ?? "",
    },
    scoreHome:    ft.home   ?? null,
    scoreAway:    ft.away   ?? null,
    winner:       m.score?.winner ?? null,
    etScoreHome:  et.home   ?? null,
    etScoreAway:  et.away   ?? null,
    penScoreHome: pen.home  ?? null,
    penScoreAway: pen.away  ?? null,
  };
}

// Propagate winners through the bracket without waiting for fd.org to populate
// next-round team slots (which it does lazily, sometimes days later).
//
// Algorithm: sort each round's ties by kickoff date, then pair sequentially —
// ties [0,1] feed next-round slot 0, [2,3] feed slot 1, etc. This matches the
// standard single-elimination bracket structure used by WC, CL, EC, and similar.
// Semi-final LOSERS are additionally routed to the THIRD_PLACE match when present.
function propagateWinners(rounds: BracketRound[]): BracketRound[] {
  // Deep-clone team objects so we can safely replace TBD slots.
  const result: BracketRound[] = rounds.map((r) => ({
    ...r,
    ties: r.ties.map((t) => ({
      ...t,
      leg1: { ...t.leg1, homeTeam: { ...t.leg1.homeTeam }, awayTeam: { ...t.leg1.awayTeam } },
      leg2: t.leg2
        ? { ...t.leg2, homeTeam: { ...t.leg2.homeTeam }, awayTeam: { ...t.leg2.awayTeam } }
        : null,
    })),
  }));

  // Determine effective winner, falling back when score.winner is missing.
  // For PK games fd.org stores the final pen result in score.fullTime (scoreHome/scoreAway).
  const effectiveWinner = (t: BracketTie): "home" | "away" | null => {
    if (t.winner) return t.winner;
    const { scoreHome: sh, scoreAway: sa, etScoreHome: eth, penScoreHome: ph, penScoreAway: pa } = t.leg1;
    // PK game: fd.org encodes final pen result in score.fullTime when etScore is present
    if (eth !== null && sh !== null && sa !== null && sh !== sa) return sh > sa ? "home" : "away";
    // Fallback: score.penalties if decisive
    if (ph !== null && pa !== null && ph !== pa) return ph > pa ? "home" : "away";
    return null;
  };
  const winnerOf = (t: BracketTie) => {
    const w = effectiveWinner(t);
    return w === "home" ? t.leg1.homeTeam : w === "away" ? t.leg1.awayTeam : null;
  };
  const loserOf = (t: BracketTie) => {
    const w = effectiveWinner(t);
    return w === "home" ? t.leg1.awayTeam : w === "away" ? t.leg1.homeTeam : null;
  };

  // Sort a round's ties by first-leg kickoff, using match id as tiebreaker.
  const byDate = (ties: BracketTie[]) =>
    [...ties].sort((a, b) => {
      const da = new Date(a.leg1.utcDate).getTime();
      const db = new Date(b.leg1.utcDate).getTime();
      return da !== db ? da - db : a.leg1.id - b.leg1.id;
    });

  // Main bracket: propagate winners from round N to round N+1.
  // Use pre-populated team IDs in next-round slots to find the correct source match
  // (critical for WC/tournament brackets where the draw pairs non-consecutive matches,
  // e.g. R32[0] & R32[3] → R16[0] rather than R32[0] & R32[1] → R16[0]).
  // Falls back to sequential order for fully-TBD (id=0) slots.
  const mainRounds = result.filter((r) => r.stage !== "THIRD_PLACE");
  for (let ri = 0; ri < mainRounds.length - 1; ri++) {
    const srcSorted = byDate(mainRounds[ri].ties);
    const next = mainRounds[ri + 1].ties;
    const usedSrcIds = new Set<number>();

    for (let ti = 0; ti < next.length; ti++) {
      const nextTie = next[ti];
      const homeId = nextTie.leg1.homeTeam.id;
      const awayId = nextTie.leg1.awayTeam.id;

      // Find the src tie by team presence (pre-populated) or next-unclaimed (TBD)
      const findByTeam = (teamId: number) =>
        srcSorted.find(
          (s) => !usedSrcIds.has(s.leg1.id) &&
            (s.leg1.homeTeam.id === teamId || s.leg1.awayTeam.id === teamId)
        ) ?? null;
      const findSequential = () =>
        srcSorted.find((s) => !usedSrcIds.has(s.leg1.id)) ?? null;

      const feedHome = homeId !== 0 ? findByTeam(homeId) : findSequential();
      if (feedHome) usedSrcIds.add(feedHome.leg1.id);

      const feedAway = awayId !== 0 ? findByTeam(awayId) : findSequential();
      if (feedAway) usedSrcIds.add(feedAway.leg1.id);

      if (feedHome) {
        const homeWinner = winnerOf(feedHome);
        if (homeWinner && nextTie.leg1.homeTeam.id === 0) {
          nextTie.leg1.homeTeam = { ...homeWinner };
        }
      }
      if (feedAway) {
        const awayWinner = winnerOf(feedAway);
        if (awayWinner && nextTie.leg1.awayTeam.id === 0) {
          nextTie.leg1.awayTeam = { ...awayWinner };
        }
      }
    }
  }

  // 3rd-place branch: losers of the two semi-final ties.
  const sfRound  = result.find((r) => r.stage === "SEMI_FINALS");
  const tpRound  = result.find((r) => r.stage === "THIRD_PLACE");
  if (sfRound && tpRound && tpRound.ties.length >= 1) {
    const sfSorted = byDate(sfRound.ties);
    const tp = tpRound.ties[0];
    const loser0 = sfSorted[0] ? loserOf(sfSorted[0]) : null;
    const loser1 = sfSorted[1] ? loserOf(sfSorted[1]) : null;
    if (loser0 && tp.leg1.homeTeam.id === 0) tp.leg1.homeTeam = { ...loser0 };
    if (loser1 && tp.leg1.awayTeam.id === 0) tp.leg1.awayTeam = { ...loser1 };
  }

  return result;
}

export async function getBracketMatches(competitionCode: string, season?: number): Promise<BracketData | null> {
  if (useMock()) return null;

  const isIntl = INTERNATIONAL_COMP_CODES.has(competitionCode);
  const seasonYear = season ?? (isIntl ? new Date().getFullYear() : CURRENT_SEASON);
  // Historical seasons are immutable → cache forever.
  // Current season uses a short TTL so winner advancement propagates quickly after knockout matches finish.
  const ttl = season && season < CURRENT_SEASON ? FOREVER_TTL_MS : 2 * 60_000;

  let raw: any;
  try {
    raw = await apiFetch(
      `/competitions/${competitionCode}/matches?season=${seasonYear}`,
      ttl
    );
  } catch (e: any) {
    // 403 (tier restriction) or 404 (competition not found) → no bracket available
    if (/API error (403|404)/.test(e.message)) return null;
    throw e;
  }

  const data = raw as any;
  const all: any[] = data.matches ?? [];
  const knockout = all.filter((m) => !GROUP_STAGE_SLUGS.has(m.stage));
  if (knockout.length === 0) return null;

  // Group by stage
  const byStage = new Map<string, any[]>();
  for (const m of knockout) {
    const s = m.stage ?? "UNKNOWN";
    if (!byStage.has(s)) byStage.set(s, []);
    byStage.get(s)!.push(m);
  }

  const sortedStages = [...byStage.keys()].sort((a, b) => {
    const ai = STAGE_ORDER.indexOf(a);
    const bi = STAGE_ORDER.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  const rounds: BracketRound[] = sortedStages.map((stage) => {
    const stageMatches = byStage.get(stage)!.map(mapBracketMatch);

    // Pair two-legged ties: find reversed fixture (swapped home/away)
    const ties: BracketTie[] = [];
    const used = new Set<number>();

    for (const m of stageMatches) {
      if (used.has(m.id)) continue;
      used.add(m.id);

      // Don't pair when teams are TBD (id=0) — placeholder slots all share id=0
      // and would incorrectly match each other as home/away legs.
      const leg2 = (m.homeTeam.id !== 0 && m.awayTeam.id !== 0)
        ? stageMatches.find(
            (n) => !used.has(n.id) && n.homeTeam.id === m.awayTeam.id && n.awayTeam.id === m.homeTeam.id
          ) ?? null
        : null;
      if (leg2) used.add(leg2.id);

      // leg1 is the chronologically earlier match (or whichever we find first)
      const [first, second] = leg2 && new Date(leg2.utcDate) < new Date(m.utcDate)
        ? [leg2, m]
        : [m, leg2];

      // Aggregate: first.homeTeam is the "home" perspective
      const agg1Done = first.status === "FINISHED";
      const agg2Done = second !== null && second.status === "FINISHED";
      const aggHome =
        agg1Done || agg2Done
          ? (first.scoreHome ?? 0) + (second?.scoreAway ?? 0)
          : null;
      const aggAway =
        agg1Done || agg2Done
          ? (first.scoreAway ?? 0) + (second?.scoreHome ?? 0)
          : null;

      let winner: "home" | "away" | null = null;
      if (second === null) {
        // Single leg
        if (first.status === "FINISHED") {
          winner = first.winner === "HOME_TEAM" ? "home" : first.winner === "AWAY_TEAM" ? "away" : null;
          // fd.org sometimes omits score.winner for PK games.
          // For PK games fd.org stores the final pen result in score.fullTime (scoreHome/scoreAway).
          // score.penalties only has the initial-rounds tally (can be equal even after sudden death).
          if (winner === null && first.etScoreHome !== null
              && first.scoreHome !== null && first.scoreAway !== null
              && first.scoreHome !== first.scoreAway) {
            winner = first.scoreHome > first.scoreAway ? "home" : "away";
          }
          // Fallback: infer from score.penalties if score.fullTime doesn't help
          if (winner === null && first.penScoreHome !== null && first.penScoreAway !== null
              && first.penScoreHome !== first.penScoreAway) {
            winner = first.penScoreHome > first.penScoreAway ? "home" : "away";
          }
        }
      } else if (agg1Done && agg2Done && aggHome !== null && aggAway !== null) {
        if (aggHome > aggAway) winner = "home";
        else if (aggAway > aggHome) winner = "away";
        else {
          // Aggregate equal — check penalty shootout on the decisive leg
          const decisive = second.penScoreHome !== null ? second : first;
          if (decisive.penScoreHome !== null) {
            // For the decisive leg, home team winning means the leg2-home team goes through.
            // leg2-home = first-away, so leg2 home win = first-away = "away" wins the tie.
            const decisiveIsSecond = decisive === second;
            winner = (decisive.winner === "HOME_TEAM")
              ? (decisiveIsSecond ? "away" : "home")
              : (decisiveIsSecond ? "home" : "away");
          }
        }
      }

      ties.push({ leg1: first, leg2: second, aggHome, aggAway, winner });
    }

    // Sort: decided ties first (winner known), then by date
    ties.sort((a, b) => {
      const aDate = new Date(a.leg1.utcDate).getTime();
      const bDate = new Date(b.leg1.utcDate).getTime();
      return aDate - bDate;
    });

    return { name: STAGE_DISPLAY[stage] ?? stage, stage, ties };
  });

  return { rounds: propagateWinners(rounds) };
}

// ── Schedule ──────────────────────────────────────────────────────────────
// Past results are immutable; upcoming fixtures change only when postponed/rescheduled.
// Live scores come from the separate live-matches endpoint, not this cache.
const SCHEDULE_TTL_MS = 30 * 60 * 1000; // 30 min — live scores handled by live-matches overlay

export interface ScheduleMatch {
  id: number;
  status: string;
  utcDate: string;
  matchday: number | null;
  competition: string;
  competitionCode: string;
  competitionEmblem: string;
  homeTeam: string;
  homeTeamId: number;
  homeTeamCrest: string;
  awayTeam: string;
  awayTeamId: number;
  awayTeamCrest: string;
  scoreHome: number | null;
  scoreAway: number | null;
  // Extra time / penalty shootout breakdown
  duration: "REGULAR" | "EXTRA_TIME" | "PENALTY_SHOOTOUT" | null;
  winner: "HOME_TEAM" | "AWAY_TEAM" | "DRAW" | null;
  etScoreHome: number | null;
  etScoreAway: number | null;
  penScoreHome: number | null;
  penScoreAway: number | null;
}

// Competition codes to check for European matches (all in free tier).
const EURO_COMPS = ["CL", "EL", "ECL"] as const;

// International tournaments run every 4 years — we must search multiple recent seasons.
// Club competitions always use CURRENT_SEASON only.
const INTERNATIONAL_COMP_CODES = new Set(["EC", "WC"]);

export async function getTeamSchedule(teamId: string, domesticCode = "PL", forcedSeason?: number): Promise<ScheduleMatch[]> {
  if (useMock()) return [];

  const isIntl = INTERNATIONAL_COMP_CODES.has(domesticCode);

  const comps: string[] = isIntl
    ? [domesticCode]
    : [...new Set([domesticCode, ...EURO_COMPS])];

  let seasons: number[];
  if (forcedSeason) {
    seasons = [forcedSeason];
  } else if (isIntl) {
    // Default to current year only — past tournament seasons are selected via the season picker.
    // Fetching 5 years back for WC/EC causes 5 parallel fd.org calls, most returning empty,
    // and the resulting payload pushes over Vercel's 10-second function timeout on cold cache.
    seasons = [now.getFullYear()];
  } else {
    seasons = [CURRENT_SEASON];
  }

  const mapMatch = (m: any): ScheduleMatch => ({
    id: m.id,
    status: m.status,
    utcDate: m.utcDate,
    matchday: m.matchday ?? null,
    competition: COMP_DISPLAY_NAMES[m.competition?.name] ?? m.competition?.name ?? "",
    competitionCode: m.competition?.code ?? "",
    competitionEmblem: m.competition?.emblem ?? "",
    homeTeam: m.homeTeam?.name ?? "",
    homeTeamId: m.homeTeam?.id ?? 0,
    homeTeamCrest: m.homeTeam?.crest ?? "",
    awayTeam: m.awayTeam?.name ?? "",
    awayTeamId: m.awayTeam?.id ?? 0,
    awayTeamCrest: m.awayTeam?.crest ?? "",
    scoreHome: m.score?.fullTime?.home ?? null,
    scoreAway: m.score?.fullTime?.away ?? null,
    duration: m.score?.duration ?? null,
    winner: m.score?.winner ?? null,
    etScoreHome: m.score?.extraTime?.home ?? null,
    etScoreAway: m.score?.extraTime?.away ?? null,
    penScoreHome: m.score?.penalties?.home ?? null,
    penScoreAway: m.score?.penalties?.away ?? null,
  });

  const teamIdNum = parseInt(teamId, 10);
  const seen = new Set<number>();
  const all: ScheduleMatch[] = [];

  await Promise.all(
    comps.flatMap((code) =>
      seasons.map(async (season) => {
        try {
          // The ?teams= filter is not supported in the free tier — we fetch the full
          // competition schedule (limit=500 covers a full season) and filter by team ID.
          // Past seasons are immutable so cache them permanently; current season uses short TTL.
          const matchesTtl = season < CURRENT_SEASON ? FOREVER_TTL_MS : SCHEDULE_TTL_MS;
          const data = await apiFetch(
            `/competitions/${code}/matches?season=${season}&limit=500`,
            matchesTtl
          ) as any;
          for (const m of (data?.matches ?? [])) {
            if (["CANCELLED", "SUSPENDED"].includes(m.status)) continue;
            if (m.homeTeam?.id !== teamIdNum && m.awayTeam?.id !== teamIdNum) continue;
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            all.push(mapMatch(m));
          }
        } catch {
          // Team not in this competition/season — silently skip.
        }
      })
    )
  );

  return all.sort((a, b) => +new Date(b.utcDate) - +new Date(a.utcDate));
}

export async function getH2HMatches(
  teamId1: number,
  teamId2: number,
  competitionCode: string,
  limit = 5
): Promise<ScheduleMatch[]> {
  if (useMock()) return [];

  const seasons = [CURRENT_SEASON, CURRENT_SEASON - 1, CURRENT_SEASON - 2];
  const seen = new Set<number>();
  const all: ScheduleMatch[] = [];

  await Promise.all(
    seasons.map(async (season) => {
      try {
        const ttl = season < CURRENT_SEASON ? FOREVER_TTL_MS : SCHEDULE_TTL_MS;
        const data = await apiFetch(
          `/competitions/${competitionCode}/matches?season=${season}&limit=500`,
          ttl
        ) as any;
        for (const m of (data?.matches ?? [])) {
          if (m.status !== "FINISHED") continue;
          const isH2H =
            (m.homeTeam?.id === teamId1 && m.awayTeam?.id === teamId2) ||
            (m.homeTeam?.id === teamId2 && m.awayTeam?.id === teamId1);
          if (!isH2H || seen.has(m.id)) continue;
          seen.add(m.id);
          all.push(mapFixtureMatch(m));
        }
      } catch {}
    })
  );

  return all
    .sort((a, b) => +new Date(b.utcDate) - +new Date(a.utcDate))
    .slice(0, limit);
}

export async function getCompetitions() {
  if (useMock()) return MOCK_COMPETITIONS;
  const data = await apiFetch("/competitions?plan=TIER_ONE") as any;
  return data.competitions.map((c: any) => ({
    id: c.id,
    name: COMP_DISPLAY_NAMES[c.name] ?? c.name,
    code: c.code,
    emblem: c.emblem,
  }));
}

const LIVE_TTL_MS = 30 * 1000; // 30 seconds

export async function getLiveMatches(): Promise<ScheduleMatch[]> {
  if (useMock()) return [];
  try {
    const mapMatch = (m: any): ScheduleMatch => ({
      id: m.id,
      status: m.status,
      utcDate: m.utcDate,
      matchday: m.matchday ?? null,
      competition: COMP_DISPLAY_NAMES[m.competition?.name] ?? m.competition?.name ?? "",
      competitionCode: m.competition?.code ?? "",
      competitionEmblem: m.competition?.emblem ?? "",
      homeTeam: m.homeTeam?.name ?? "",
      homeTeamId: m.homeTeam?.id ?? 0,
      homeTeamCrest: m.homeTeam?.crest ?? "",
      awayTeam: m.awayTeam?.name ?? "",
      awayTeamId: m.awayTeam?.id ?? 0,
      awayTeamCrest: m.awayTeam?.crest ?? "",
      scoreHome: m.score?.fullTime?.home ?? null,
      scoreAway: m.score?.fullTime?.away ?? null,
      duration: m.score?.duration ?? null,
      winner: m.score?.winner ?? null,
      etScoreHome: m.score?.extraTime?.home ?? null,
      etScoreAway: m.score?.extraTime?.away ?? null,
      penScoreHome: m.score?.penalties?.home ?? null,
      penScoreAway: m.score?.penalties?.away ?? null,
    });
    const [inPlay, paused] = await Promise.all([
      apiFetch("/matches?status=IN_PLAY", LIVE_TTL_MS) as Promise<any>,
      apiFetch("/matches?status=PAUSED", LIVE_TTL_MS) as Promise<any>,
    ]);
    const seen = new Set<number>();
    const all: ScheduleMatch[] = [];
    for (const m of [...(inPlay?.matches ?? []), ...(paused?.matches ?? [])]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      all.push(mapMatch(m));
    }
    return all;
  } catch {
    return [];
  }
}

function mapFixtureMatch(m: any): ScheduleMatch {
  return {
    id: m.id,
    status: m.status,
    utcDate: m.utcDate,
    matchday: m.matchday ?? null,
    competition: COMP_DISPLAY_NAMES[m.competition?.name] ?? m.competition?.name ?? "",
    competitionCode: m.competition?.code ?? "",
    competitionEmblem: m.competition?.emblem ?? "",
    homeTeam: m.homeTeam?.shortName ?? m.homeTeam?.name ?? "",
    homeTeamId: m.homeTeam?.id ?? 0,
    homeTeamCrest: m.homeTeam?.crest ?? "",
    awayTeam: m.awayTeam?.shortName ?? m.awayTeam?.name ?? "",
    awayTeamId: m.awayTeam?.id ?? 0,
    awayTeamCrest: m.awayTeam?.crest ?? "",
    scoreHome: m.score?.fullTime?.home ?? null,
    scoreAway: m.score?.fullTime?.away ?? null,
    duration: m.score?.duration ?? null,
    winner: m.score?.winner ?? null,
    etScoreHome: m.score?.extraTime?.home ?? null,
    etScoreAway: m.score?.extraTime?.away ?? null,
    penScoreHome: m.score?.penalties?.home ?? null,
    penScoreAway: m.score?.penalties?.away ?? null,
  };
}

// fd.org interprets dateTo as utcDate ≤ dateTo 00:00 UTC, so games later on dateTo day are missed.
// We advance dateTo by one day so the full requested end date is included.
async function fetchFixtureChunk(dateFrom: string, dateTo: string): Promise<ScheduleMatch[]> {
  const toDate = new Date(dateTo);
  toDate.setUTCDate(toDate.getUTCDate() + 1);
  const dateToPlusOne = toDate.toISOString().slice(0, 10);
  const data = await apiFetch(`/matches?dateFrom=${dateFrom}&dateTo=${dateToPlusOne}`, 5 * 60_000) as any;
  return (data?.matches ?? []).map(mapFixtureMatch);
}

// fd.org global /matches endpoint has a maximum date range of ~10 days.
// Requests spanning a longer period are split into 10-day chunks and fetched in parallel.
export async function getUpcomingFixtures(dateFrom: string, dateTo: string): Promise<ScheduleMatch[]> {
  if (useMock()) return [];
  const start = new Date(dateFrom);
  const end   = new Date(dateTo);
  const diffDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (diffDays <= 10) return fetchFixtureChunk(dateFrom, dateTo);

  // Build 10-day chunks
  const chunks: Array<[string, string]> = [];
  const cur = new Date(start);
  while (cur <= end) {
    const chunkFrom = cur.toISOString().slice(0, 10);
    const chunkEndMs = Math.min(cur.getTime() + 9 * 86_400_000, end.getTime());
    const chunkTo = new Date(chunkEndMs).toISOString().slice(0, 10);
    chunks.push([chunkFrom, chunkTo]);
    cur.setDate(cur.getDate() + 10);
  }
  const results = await Promise.all(chunks.map(([f, t]) => fetchFixtureChunk(f, t)));
  // Deduplicate: midnight-UTC games on chunk boundaries appear in two adjacent chunks
  const seen = new Set<number>();
  const all: ScheduleMatch[] = [];
  for (const chunk of results) {
    for (const m of chunk) {
      if (!seen.has(m.id)) { seen.add(m.id); all.push(m); }
    }
  }
  return all;
}

export interface PositionPoint {
  matchday: number;
  position: number;
  pts: number;
}

export async function getPositionHistory(
  competitionCode: string,
  teamId: number,
  season?: number
): Promise<PositionPoint[]> {
  if (useMock()) return [];
  const seasonYear = season ?? CURRENT_SEASON;
  const ttl = seasonYear < CURRENT_SEASON ? FOREVER_TTL_MS : SCHEDULE_TTL_MS;
  let raw: any;
  try {
    raw = await apiFetch(`/competitions/${competitionCode}/matches?season=${seasonYear}&limit=500`, ttl);
  } catch {
    return [];
  }

  // Only consider finished matches with a valid full-time score
  const finished: any[] = ((raw as any)?.matches ?? []).filter(
    (m: any) =>
      m.status === "FINISHED" &&
      m.score?.fullTime?.home !== null && m.score?.fullTime?.home !== undefined &&
      m.score?.fullTime?.away !== null && m.score?.fullTime?.away !== undefined
  );

  // Sort by date ascending so we build the table chronologically
  finished.sort(
    (a: any, b: any) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime()
  );

  // Rolling standings table
  const table = new Map<number, { pts: number; gd: number; gf: number }>();

  function ensureEntry(id: number) {
    if (!table.has(id)) table.set(id, { pts: 0, gd: 0, gf: 0 });
  }

  function positionOf(id: number): number {
    const rows = Array.from(table.entries())
      .sort(([, a], [, b]) =>
        b.pts !== a.pts ? b.pts - a.pts : b.gd !== a.gd ? b.gd - a.gd : b.gf - a.gf
      );
    const idx = rows.findIndex(([rowId]) => rowId === id);
    return idx === -1 ? 0 : idx + 1;
  }

  const result: PositionPoint[] = [];

  for (const m of finished) {
    const homeId: number = m.homeTeam?.id;
    const awayId: number = m.awayTeam?.id;
    if (!homeId || !awayId) continue;

    const hg: number = m.score.fullTime.home;
    const ag: number = m.score.fullTime.away;

    ensureEntry(homeId);
    ensureEntry(awayId);
    const h = table.get(homeId)!;
    const a = table.get(awayId)!;

    h.gf += hg; h.gd += hg - ag;
    a.gf += ag; a.gd += ag - hg;
    if (hg > ag) h.pts += 3;
    else if (hg < ag) a.pts += 3;
    else { h.pts += 1; a.pts += 1; }

    // Record after matches involving our team
    if (homeId === teamId || awayId === teamId) {
      const pos = positionOf(teamId);
      if (pos > 0) {
        result.push({
          matchday: m.matchday ?? result.length + 1,
          position: pos,
          pts: table.get(teamId)!.pts,
        });
      }
    }
  }

  return result;
}

export async function getTeams(competitionCode: string) {
  if (useMock()) return MOCK_TEAMS;
  const data = await apiFetch(`/competitions/${competitionCode}/teams`) as any;
  // Pre-warm scorers in background. International tournaments use their own season year
  // (not CURRENT_SEASON) — skip pre-warming for them to avoid 404 noise.
  if (!INTERNATIONAL_COMP_CODES.has(competitionCode)) {
    apiFetch(`/competitions/${competitionCode}/scorers?season=${CURRENT_SEASON}&limit=400`, SCORERS_CURRENT_TTL_MS).catch(() => {});
  }
  return data.teams.map((t: any) => ({
    id: t.id, name: t.name, shortName: t.shortName, crest: t.crest, tla: t.tla,
  }));
}

export interface StandingRow {
  position: number;
  team: { id: number; name: string; shortName: string; tla: string; crest: string };
  playedGames: number;
  won: number;
  draw: number;
  lost: number;
  points: number;
  goalDifference: number;
  form: string | null;
  knockoutStatus?: "Q" | "E" | "3rd" | null;
}

export interface StandingsGroup {
  label: string;
  type: string;
  rows: StandingRow[];
}

export interface StandingsData {
  groups: StandingsGroup[];
}

function mapStandingRow(e: any): StandingRow {
  return {
    position: e.position,
    team: {
      id: e.team.id,
      name: e.team.name,
      shortName: e.team.shortName || e.team.name,
      tla: e.team.tla,
      crest: e.team.crest,
    },
    playedGames: e.playedGames,
    won: e.won,
    draw: e.draw,
    lost: e.lost,
    points: e.points,
    goalDifference: e.goalDifference,
    form: e.form ?? null,
  };
}

function formatGroupLabel(raw: string): string {
  // "Group A" → "A", "GROUP_A" → "A", other → strip underscores
  return raw.replace(/^Group\s+/i, "").replace(/^GROUP_/, "") || raw;
}

export interface CompetitionSeason {
  year: number;
  startDate: string;
  endDate: string;
  winner: string | null;
}

export async function getCompetitionSeasons(competitionCode: string): Promise<CompetitionSeason[]> {
  const data = await apiFetch(`/competitions/${competitionCode}`) as any;
  const seen = new Set<number>();
  // Free tier supports roughly the last 3 seasons; filter out older data that returns 403
  const cutoff = new Date().getFullYear() - 3;
  return (data.seasons ?? [])
    .map((s: any) => {
      const year = new Date(s.startDate).getFullYear();
      return { year, startDate: s.startDate, endDate: s.endDate, winner: s.winner?.name ?? null };
    })
    .filter((s: any) => {
      if (seen.has(s.year)) return false;
      seen.add(s.year);
      return s.year >= cutoff;
    })
    .sort((a: any, b: any) => b.year - a.year);
}

// Compute last-5-results form per team from the competition's finished matches.
// Called for any team where fd.org's standings response returned null form.
async function computeStatsFromMatches(
  competitionCode: string,
  seasonYear: number
): Promise<{ form: Map<number, string>; gd: Map<number, number> }> {
  // Same URL and TTL as getTeamCleanSheets/getFinishedMatchList so all three share the
  // same Supabase cache entry. SCORERS_CURRENT_TTL_MS (2 min) ensures the finished-match
  // list stays fresh during live tournaments so form updates promptly when matches end.
  const data = await apiFetch(
    `/competitions/${competitionCode}/matches?season=${seasonYear}&status=FINISHED`,
    SCORERS_CURRENT_TTL_MS
  ) as any;
  const matches: any[] = data?.matches ?? [];

  // Sort most-recent first so we can stop collecting per-team after 5 for form
  matches.sort((a, b) => new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime());

  const teamResults = new Map<number, string[]>(); // teamId → results, most-recent first
  const teamGD = new Map<number, number>();         // teamId → cumulative goal difference

  for (const m of matches) {
    const homeId: number = m.homeTeam?.id;
    const awayId: number = m.awayTeam?.id;
    const winner: string | null = m.score?.winner ?? null;
    const homeGoals: number | null = m.score?.fullTime?.home ?? null;
    const awayGoals: number | null = m.score?.fullTime?.away ?? null;
    if (!homeId || !awayId || !winner) continue;

    if ((teamResults.get(homeId)?.length ?? 0) < 5) {
      const r = teamResults.get(homeId) ?? [];
      r.push(winner === "HOME_TEAM" ? "W" : winner === "DRAW" ? "D" : "L");
      teamResults.set(homeId, r);
    }
    if ((teamResults.get(awayId)?.length ?? 0) < 5) {
      const r = teamResults.get(awayId) ?? [];
      r.push(winner === "AWAY_TEAM" ? "W" : winner === "DRAW" ? "D" : "L");
      teamResults.set(awayId, r);
    }

    if (homeGoals !== null && awayGoals !== null) {
      teamGD.set(homeId, (teamGD.get(homeId) ?? 0) + (homeGoals - awayGoals));
      teamGD.set(awayId, (teamGD.get(awayId) ?? 0) + (awayGoals - homeGoals));
    }
  }

  // Reverse each team's list so the string reads oldest→newest (rightmost = most recent)
  const form = new Map<number, string>();
  for (const [id, results] of teamResults) {
    form.set(id, [...results].reverse().join(","));
  }
  return { form, gd: teamGD };
}

export async function getStandings(competitionCode: string, season?: number): Promise<StandingsData> {
  const query = season ? `?season=${season}` : "";
  // Past seasons are immutable — cache forever. Current season uses short TTL so points/form
  // update promptly when a match ends (works for both domestic and international comps).
  const isIntl = INTERNATIONAL_COMP_CODES.has(competitionCode);
  const currentYear = isIntl ? new Date().getFullYear() : CURRENT_SEASON;
  const standingsTtl = (season && season < currentYear) ? FOREVER_TTL_MS : SCORERS_CURRENT_TTL_MS;
  const isCurrentSeason = !season || season >= currentYear;

  // For international comps we always need match stats (form + GD recomputation).
  // Start that fetch concurrently with the standings fetch so both hit Supabase/fd.org
  // in parallel rather than sequentially — saves one full round-trip on cache miss.
  const matchStatsPromise = (isIntl && isCurrentSeason)
    ? computeStatsFromMatches(competitionCode, currentYear).catch(() => null)
    : Promise.resolve(null);

  const data = await apiFetch(`/competitions/${competitionCode}/standings${query}`, standingsTtl) as any;
  const all: any[] = data.standings ?? [];

  // Entries that belong to a named group (World Cup, Euros: group="Group A" / "GROUP_A")
  const grouped = all.filter((s) => s.group && s.table?.length > 0);

  let result: StandingsData;
  if (grouped.length > 1) {
    result = {
      groups: grouped.map((s) => ({
        label: formatGroupLabel(s.group),
        type: s.group,
        rows: s.table.map(mapStandingRow),
      })),
    };
  } else {
    const single = all.find((s) => s.type === "TOTAL") ?? all.find((s) => s.table?.length > 0);
    result = single
      ? { groups: [{ label: "Standings", type: single.type ?? "TOTAL", rows: (single.table ?? []).map(mapStandingRow) }] }
      : { groups: [] };
  }

  // Recompute form and GD from FINISHED matches for the current season.
  // For international comps (WC/EC), fd.org's standings update slowly after tournament
  // matches — always recompute both form and GD to stay accurate.
  // For domestic leagues, fd.org standings are reliable; only fill in null form values.
  if (isCurrentSeason && result.groups.length > 0) {
    const needsStats = isIntl
      ? true
      : result.groups.some((g) => g.rows.some((r) => r.form === null));
    if (needsStats) {
      try {
        const seasonYear = isIntl ? currentYear : CURRENT_SEASON;
        const computed = await (matchStatsPromise ?? computeStatsFromMatches(competitionCode, seasonYear).catch(() => null));
        if (computed) {
          const { form: computedForm, gd: computedGD } = computed;
          for (const group of result.groups) {
            for (const row of group.rows) {
              if (isIntl || row.form === null) {
                const f = computedForm.get(row.team.id);
                if (f) row.form = f;
              }
              if (isIntl) {
                const gd = computedGD.get(row.team.id);
                if (gd !== undefined) row.goalDifference = gd;
              }
            }
          }
        }
      } catch (e) {
        console.warn(`[standings] stats computation failed for ${competitionCode}:`, (e as Error).message);
      }
    }
  }

  // Annotate WC group rows with confirmed knockout status scraped from Wikipedia.
  // EC format doesn't have the same "best 3rd" complexity — skip for now.
  if (competitionCode === "WC" && isCurrentSeason && result.groups.length > 0) {
    try {
      const wcYear = isIntl ? currentYear : new Date().getFullYear();
      const statusMap = await getWcKnockoutStatus(wcYear);
      if (statusMap.size > 0) {
        const normalize = (s: string) =>
          s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, "").trim();

        for (const group of result.groups) {
          const allDone = group.rows.every(r => r.playedGames >= 3);
          for (const row of group.rows) {
            const key = normalize(row.team.name);
            const scraped = statusMap.get(key) ?? null;
            if (scraped) {
              row.knockoutStatus = scraped;
            } else if (allDone && row.position === 3) {
              // Group finished, 3rd place — may advance as best 3rd (Wikipedia hasn't confirmed yet)
              row.knockoutStatus = "3rd";
            } else {
              row.knockoutStatus = null;
            }
          }
        }
      }
    } catch (e) {
      console.warn("[standings] WC knockout status fetch failed:", (e as Error).message);
    }
  }

  return result;
}

export interface FdStatLeader {
  value: number;
  playedMatches: number;
  player: { id: number; name: string; nationality: string; dateOfBirth: string; position: string };
  team: { id: number; name: string; shortName: string; crest: string; tla: string };
}

function mapFdScorer(s: any, statField: "goals" | "assists"): FdStatLeader {
  return {
    value: s[statField] ?? 0,
    playedMatches: s.playedMatches ?? 0,
    player: {
      id: s.player?.id ?? 0,
      name: s.player?.name ?? "",
      nationality: s.player?.nationality ?? "",
      dateOfBirth: s.player?.dateOfBirth ?? "",
      position: s.player?.position ?? "",
    },
    team: {
      id: s.team?.id ?? 0,
      name: s.team?.name ?? "",
      shortName: s.team?.shortName ?? s.team?.name ?? "",
      crest: s.team?.crest ?? "",
      tla: s.team?.tla ?? "",
    },
  };
}

// Returns top goal scorers and assist leaders from the fd.org scorers endpoint.
// Uses limit=400 so that high-assist/low-goal players (e.g. creative midfielders who
// rarely score) are captured in the assists leaderboard. The same endpoint is already
// cached by getTeamLineup, so this is almost always a cache hit.
// Derives team-level clean sheet counts from all finished matches in the season.
// Uses the same fd.org free tier — one request, cached 1 hour.
// Returned as FdStatLeader[] with player.id=0 (team stat, no per-GK attribution).
export async function getTeamCleanSheets(competitionCode: string, season?: number): Promise<FdStatLeader[]> {
  if (useMock()) return [];

  const isIntl = INTERNATIONAL_COMP_CODES.has(competitionCode);
  const seasonYear = season ?? (isIntl ? new Date().getFullYear() : CURRENT_SEASON);
  // Same TTL as computeFormFromMatches and getFinishedMatchList so all three share the
  // same cache entry — whichever runs first wins, and they all get consistently fresh data.
  const ttl = season && season < CURRENT_SEASON ? FOREVER_TTL_MS : SCORERS_CURRENT_TTL_MS;
  const data = await apiFetch(
    `/competitions/${competitionCode}/matches?season=${seasonYear}&status=FINISHED`,
    ttl
  ) as any;

  const matches: any[] = data.matches ?? [];
  const csMap = new Map<number, { count: number; team: any }>();

  for (const m of matches) {
    const homeGoals: number | null = m.score?.fullTime?.home ?? null;
    const awayGoals: number | null = m.score?.fullTime?.away ?? null;
    if (homeGoals === null || awayGoals === null) continue;

    if (awayGoals === 0 && m.homeTeam?.id) {
      const e = csMap.get(m.homeTeam.id) ?? { count: 0, team: m.homeTeam };
      e.count++;
      csMap.set(m.homeTeam.id, e);
    }
    if (homeGoals === 0 && m.awayTeam?.id) {
      const e = csMap.get(m.awayTeam.id) ?? { count: 0, team: m.awayTeam };
      e.count++;
      csMap.set(m.awayTeam.id, e);
    }
  }

  return Array.from(csMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map(({ count, team }) => ({
      value: count,
      playedMatches: 0,
      player: {
        id: 0,
        name: team?.shortName || team?.name || "",
        nationality: "",
        dateOfBirth: "",
        position: "",
      },
      team: {
        id: team?.id ?? 0,
        name: team?.name ?? "",
        shortName: team?.shortName ?? team?.name ?? "",
        crest: team?.crest ?? "",
        tla: team?.tla ?? "",
      },
    }));
}

export async function getTopScorers(
  competitionCode: string,
  season?: number
): Promise<{ goals: FdStatLeader[]; assists: FdStatLeader[] }> {
  if (useMock()) return { goals: [], assists: [] };

  const isIntl = INTERNATIONAL_COMP_CODES.has(competitionCode);
  const seasonYear = season ?? (isIntl ? new Date().getFullYear() : CURRENT_SEASON);
  const ttl = season && season < CURRENT_SEASON ? FOREVER_TTL_MS : SCORERS_CURRENT_TTL_MS;
  const data = await apiFetch(
    `/competitions/${competitionCode}/scorers?season=${seasonYear}&limit=400`,
    ttl
  ) as any;

  const raw: any[] = data.scorers ?? [];

  const goals = raw
    .slice()                                              // already sorted by goals desc by the API
    .slice(0, 30)
    .map((s) => mapFdScorer(s, "goals"));

  // Assists: fd.org /scorers only lists goal scorers so pure playmakers are absent.
  // For international competitions the live-scorers route rebuilds assists from ESPN.
  // For domestic competitions this partial list is the best available from fd.org.
  const assists = raw
    .filter((s) => (s.assists ?? 0) > 0)
    .sort((a, b) => (b.assists ?? 0) - (a.assists ?? 0))
    .slice(0, 30)
    .map((s) => mapFdScorer(s, "assists"));

  return { goals, assists };
}

export function isInternationalComp(code: string): boolean {
  return INTERNATIONAL_COMP_CODES.has(code);
}

// Returns lightweight finished-match records for building ESPN-based leaderboards.
export interface FinishedMatchRef {
  id: number;
  homeTeam: string;
  homeTeamId: number;
  homeTeamCrest: string;
  awayTeam: string;
  awayTeamId: number;
  awayTeamCrest: string;
  utcDate: string;
}

export async function getFinishedMatchList(
  competitionCode: string,
  season?: number
): Promise<FinishedMatchRef[]> {
  const isIntl = INTERNATIONAL_COMP_CODES.has(competitionCode);
  const seasonYear = season ?? (isIntl ? new Date().getFullYear() : CURRENT_SEASON);
  const ttl = season && season < CURRENT_SEASON ? FOREVER_TTL_MS : SCORERS_CURRENT_TTL_MS;
  const data = await apiFetch(
    `/competitions/${competitionCode}/matches?season=${seasonYear}&status=FINISHED`,
    ttl
  ) as any;
  return (data?.matches ?? []).map((m: any) => ({
    id: m.id ?? 0,
    homeTeam: m.homeTeam?.name ?? "",
    homeTeamId: m.homeTeam?.id ?? 0,
    homeTeamCrest: m.homeTeam?.crest ?? "",
    awayTeam: m.awayTeam?.name ?? "",
    awayTeamId: m.awayTeam?.id ?? 0,
    awayTeamCrest: m.awayTeam?.crest ?? "",
    utcDate: m.utcDate ?? "",
  }));
}

export async function getTeamLineup(teamId: string, competitionCode?: string) {
  if (useMock()) return MOCK_LINEUP;

  // Kick off squad + scorers concurrently when competition code is already known.
  // Squad source: prefer /competitions/{code}/teams (works on fd.org free tier and is
  // already cached in Supabase by getTeams). Fall back to /teams/{id} only when the
  // competition endpoint doesn't contain this team (e.g. search result from another league).
  const [teamData, preloadedScorers] = await Promise.all([
    (async () => {
      if (competitionCode) {
        try {
          const d = await apiFetch(`/competitions/${competitionCode}/teams`, SQUAD_TTL_MS) as any;
          const found = d.teams?.find((t: any) => String(t.id) === String(teamId));
          if (found?.squad?.length > 0) return found;
        } catch { /* fall through to /teams/{id} */ }
      }
      return apiFetch(`/teams/${teamId}`, SQUAD_TTL_MS);
    })(),
    competitionCode
      ? apiFetch(`/competitions/${competitionCode}/scorers?season=${CURRENT_SEASON}&limit=400`, SCORERS_CURRENT_TTL_MS).catch(() => null)
      : Promise.resolve(null),
  ]);
  const data = teamData as any;
  const squad: any[] = data.squad ?? [];

  // Resolve competition code (caller-supplied first, fall back to team's running competition)
  const compCode = competitionCode
    ?? (data.runningCompetitions as any[] | undefined)
        ?.find((c: any) => c.type === "LEAGUE")?.code;

  // Process scorers — use the pre-loaded result, or fetch now if compCode was unknown upfront
  const appearances = new Map<number, number>();
  const goalStats = new Map<number, { goals: number; assists: number }>();
  if (compCode) {
    try {
      const scorersRaw = (preloadedScorers ??
        await apiFetch(`/competitions/${compCode}/scorers?season=${CURRENT_SEASON}&limit=400`, SCORERS_CURRENT_TTL_MS)) as any;
      for (const s of scorersRaw?.scorers ?? []) {
        if (s.player?.id) {
          appearances.set(s.player.id, s.playedMatches ?? 0);
          goalStats.set(s.player.id, { goals: s.goals ?? 0, assists: s.assists ?? 0 });
        }
      }
    } catch { /* graceful degradation — sorting falls back to career/photo signal */ }

    // Pre-warm past-season scorer caches for the main competition only.
    // CL/EL are skipped here — they're only fetched if a player actually appeared in them.
    (async () => {
      for (const season of CAREER_SEASONS) {
        apiFetch(`/competitions/${compCode}/scorers?season=${season}&limit=400`, FOREVER_TTL_MS).catch(() => {});
        await sleep(500);
      }
    })();
  }

  const squadForPhotos = squad.map((p: any) => ({ id: p.id, name: p.name }));
  let allSquadPhotos: Record<number, string | null>;
  let careerApps: Map<number, number>;

  // Merge photo sources: lower-priority spread first, higher-priority nulls never overwrite real URLs.
  // SofaScore returns explicit null for all players when blocked (403) — without this guard
  // those nulls would overwrite valid TheSportsDB photos in the spread.
  function mergePhotos(...sources: Record<number, string | null>[]): Record<number, string | null> {
    const out: Record<number, string | null> = {};
    for (const src of sources) {
      for (const [id, url] of Object.entries(src)) {
        if (url !== null || !(Number(id) in out)) out[Number(id)] = url;
      }
    }
    return out;
  }

  if (compCode === "PL") {
    // FPL (official PL source) → SofaScore fallback → TheSportsDB last resort
    const [fplPhotos, wikiAppMap] = await Promise.all([
      fetchFplPhotos(squadForPhotos),
      fetchCareerAppTotals(squad),
    ]);
    const fplMisses = squad.filter((p: any) => !fplPhotos[p.id]);
    const ssPhotos = fplMisses.length > 0
      ? await fetchSofaScorePhotos(fplMisses.map((p: any) => ({ id: p.id, name: p.name })), data.name, teamId)
      : {};
    const ssMisses = fplMisses.filter((p: any) => !ssPhotos[p.id]);
    const tsdbPhotos = ssMisses.length > 0
      ? await fetchPhotos(ssMisses.map((p: any) => ({ id: p.id, name: p.name })))
      : {};
    // Priority: FPL > SofaScore > TheSportsDB (nulls from higher source never overwrite real URLs)
    allSquadPhotos = mergePhotos(tsdbPhotos, ssPhotos, fplPhotos);
    careerApps = wikiAppMap;
  } else {
    // SofaScore (comprehensive for all leagues) → TheSportsDB fallback
    const [ssPhotos, wikiAppMap] = await Promise.all([
      fetchSofaScorePhotos(squadForPhotos, data.name, teamId),
      fetchCareerAppTotals(squad),
    ]);
    const ssMisses = squad.filter((p: any) => !ssPhotos[p.id]);
    const tsdbPhotos = ssMisses.length > 0
      ? await fetchPhotos(ssMisses.map((p: any) => ({ id: p.id, name: p.name })))
      : {};
    // Priority: SofaScore > TheSportsDB (nulls from SofaScore never overwrite real TheSportsDB URLs)
    allSquadPhotos = mergePhotos(tsdbPhotos, ssPhotos);
    careerApps = wikiAppMap;
  }

  // Populate the photo cache for use by getMatchLineups()
  for (const [id, url] of Object.entries(allSquadPhotos)) {
    setPhotoCache(Number(id), url);
  }

  let xi = selectXI(squad, allSquadPhotos, appearances, careerApps);
  const starterIds = new Set(xi.map((x) => x.player.id));

  // Bench: all non-starters (no cap — squad view shows all).
  // Players with null position get a CM fallback via mapBenchPlayer below.
  const bench = squad
    .filter((p) => !starterIds.has(p.id))
    .sort((a, b) => {
      const ag = GENERIC_POS.has(a.position) ? 1 : 0;
      const bg = GENERIC_POS.has(b.position) ? 1 : 0;
      if (ag !== bg) return ag - bg;
      const aApps = appearances.get(a.id) ?? 0;
      const bApps = appearances.get(b.id) ?? 0;
      if (aApps !== bApps) return bApps - aApps;
      const ap = allSquadPhotos[a.id] ? 0 : 1;
      const bp = allSquadPhotos[b.id] ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const aCareer = careerApps.get(a.id) ?? 0;
      const bCareer = careerApps.get(b.id) ?? 0;
      return bCareer - aCareer;
    });

  // Squad supplement: add players missing from fd.org via web scrapers.
  // International comps → Wikipedia tournament squads (complete 26-man rosters).
  // Club comps → Transfermarkt /kader/ page (comprehensive for all leagues).
  // Supplemented players get id=0 — visible in squad view but non-interactive.
  type SupplementPlayer = { id: 0; name: string; position: string; dateOfBirth: string };
  const supplementPlayers: SupplementPlayer[] = [];

  // Shared name deduplication helpers
  function normPlayerName(n: string): string {
    return n.toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z\s]/g, "").trim().replace(/\s+/g, " ");
  }
  function playerNamesMatch(a: string, b: string): boolean {
    if (a === b) return true;
    const aT = a.split(" "), bT = b.split(" ");
    const aLast = aT[aT.length - 1], bLast = bT[bT.length - 1];
    if (aLast.length >= 4 && aLast === bLast) return true;
    for (const tok of aT) if (tok.length >= 5 && bT.includes(tok)) return true;
    return false;
  }

  function buildExistingNorms(): Set<string> {
    return new Set([
      ...xi.map(({ player: p }) => normPlayerName(p.name)),
      ...bench.map((p: any) => normPlayerName(p.name)),
    ]);
  }

  function addMissing(
    candidates: Array<{ name: string; position: string; dateOfBirth?: string }>,
    existingNorms: Set<string>,
    source: string
  ) {
    let added = 0;
    for (const wp of candidates) {
      const wpNorm = normPlayerName(wp.name);
      const alreadyPresent = Array.from(existingNorms).some((en) => playerNamesMatch(en, wpNorm));
      if (alreadyPresent) continue;
      supplementPlayers.push({ id: 0, name: wp.name, position: wp.position, dateOfBirth: wp.dateOfBirth ?? "" });
      existingNorms.add(wpNorm);
      added++;
    }
    if (added > 0) console.log(`[lineup] ${source} supplement: +${added} players for ${data.name}`);
  }

  if (compCode === "WC") {
    try {
      const wikiSquad = await getWcSquadFromWiki(data.name);
      addMissing(wikiSquad, buildExistingNorms(), "WC Wikipedia");
    } catch (e) {
      console.warn(`[lineup] WC Wikipedia supplement failed:`, (e as Error).message);
    }
  } else if (compCode === "EC") {
    try {
      const wikiSquad = await getEcSquadFromWiki(data.name);
      addMissing(wikiSquad, buildExistingNorms(), "EC Wikipedia");
    } catch (e) {
      console.warn(`[lineup] EC Wikipedia supplement failed:`, (e as Error).message);
    }
  } else if (compCode) {
    // Club competitions: use Transfermarkt /kader/ page
    // 15s cap so a slow TM cold-start doesn't block the entire lineup response
    try {
      const tmSquad = await Promise.race([
        getTmClubSquad(data.name, CURRENT_SEASON),
        new Promise<TmSquadPlayer[]>((resolve) => setTimeout(() => resolve([]), 7_000)),
      ]);
      addMissing(tmSquad, buildExistingNorms(), `TM (${compCode})`);
    } catch (e) {
      console.warn(`[lineup] TM squad supplement failed for ${data.name}:`, (e as Error).message);
    }
  }

  // When fd.org returned an empty squad, promote TM supplement players to form the XI.
  // supplementPlayers have specific TM positions (e.g. "Central Midfield") so selectXI
  // can build a formation from them; remaining non-starters stay in supplementPlayers.
  if (xi.length === 0 && supplementPlayers.length >= 11) {
    // Use negative sequential IDs so selectXI's deduplication set works correctly
    // (all supplement players would otherwise share id=0 and collide).
    const fakeSquad = supplementPlayers.map((p, i) => ({
      id: -(i + 1),
      name: p.name,
      position: p.position,
      nationality: "",
      dateOfBirth: p.dateOfBirth,
      shirtNumber: null,
    }));
    const tmXi = selectXI(fakeSquad, {}, new Map(), new Map());
    if (tmXi.length >= 11) {
      const tmStarterNames = new Set(tmXi.map((x) => x.player.name));
      const remaining = supplementPlayers.filter((p) => !tmStarterNames.has(p.name));
      supplementPlayers.splice(0, supplementPlayers.length, ...remaining);
      // Reset each starter's id back to 0 (non-interactive) before using
      xi = tmXi.map((x) => ({ ...x, player: { ...x.player, id: 0 } }));
      console.log(`[lineup] TM XI fallback for ${data.name}: ${tmXi.length} starters`);
    }
  }

  const photos = allSquadPhotos;

  // Background Wikipedia pre-warm: fetch career + trophy data for starters/bench
  // not yet cached so that clicking a player is instant rather than 3-7s cold.
  (async () => {
    const displayed = [
      ...xi.map(({ player: p }) => ({ id: p.id as number, name: p.name as string })),
      ...bench.map((p: any) => ({ id: p.id as number, name: p.name as string })),
    ];
    for (const p of displayed) {
      if (careerApps.has(p.id)) continue;
      try {
        const wikiData = await fetchPlayerWikiData(p.name, true, true);
        if (wikiData.career.length > 0) setWikiStats(p.id, p.name, wikiData.career);
        if (wikiData.trophies.length > 0) setWikiTrophies(p.id, wikiData.trophies);
      } catch {}
      await sleep(800);
    }
  })().catch(() => {});

  function mapBenchPlayer(p: any) {
    const role = getRole(p.position) ?? "CM";
    return {
      id: p.id,
      name: p.name,
      position: broadPosition(role),
      role,
      nationality: p.nationality ?? "",
      dateOfBirth: p.dateOfBirth ?? "",
      shirtNumber: p.shirtNumber ?? null,
      photo: photos[p.id] ?? null,
      appearances: appearances.get(p.id) ?? 0,
      goals: goalStats.get(p.id)?.goals ?? 0,
      assists: goalStats.get(p.id)?.assists ?? 0,
    };
  }

  return {
    competitionCode: compCode ?? null,
    formation: formationString(xi),
    starters: xi.map(({ player: p, role }) => ({
      id: p.id,
      name: p.name,
      position: broadPosition(role),
      role,
      nationality: p.nationality ?? "",
      dateOfBirth: p.dateOfBirth ?? "",
      shirtNumber: p.shirtNumber ?? null,
      photo: photos[p.id] ?? null,
      appearances: appearances.get(p.id) ?? 0,
      goals: goalStats.get(p.id)?.goals ?? 0,
      assists: goalStats.get(p.id)?.assists ?? 0,
    })),
    bench: [
      ...bench.map(mapBenchPlayer),
      // Supplemented players (id=0): from Wikipedia or TM, appear in squad view only
      ...supplementPlayers.map((p) => {
        const role = getRole(p.position) ?? "CM";
        return {
          id: 0,
          name: p.name,
          position: broadPosition(role),
          role,
          nationality: "",
          dateOfBirth: p.dateOfBirth,
          shirtNumber: null,
          photo: null,
          appearances: 0,
          goals: 0,
          assists: 0,
        };
      }),
    ],
  };
}

// ── Stats via scorers endpoint ────────────────────────────────────────────────
// Season starts in August — 2025 = 2025/26 season.
const now = new Date();
const CURRENT_SEASON = now.getFullYear() - (now.getMonth() < 7 ? 1 : 0);
// Past seasons to query — goes back 10 years. Past-season data is immutable.
const CAREER_SEASONS = Array.from({ length: 10 }, (_, i) => CURRENT_SEASON - 1 - i);

// Human-readable names for competition codes shown in the career panel
const COMP_DISPLAY: Record<string, string> = {
  PL:  "Premier League",
  PD:  "La Liga",
  BL1: "Bundesliga",
  SA:  "Serie A",
  FL1: "Ligue 1",
  DED: "Eredivisie",
  BSA: "Brasileirão",
  PPL: "Primeira Liga",
  ELC: "Championship",
  CL:  "Champions League",
  EL:  "Europa League",
  ECL: "Conference League",
  CLI: "Copa Libertadores",
  EC:  "Euro",
  WC:  "World Cup",
};

interface ScorerEntry {
  goals: number;
  assists: number;
  appearances: number;
  team: string | null;
}

async function fetchScorerStats(
  playerId: number,
  competitionCode: string,
  season: number
): Promise<ScorerEntry | null> {
  try {
    const ttl = season < CURRENT_SEASON ? FOREVER_TTL_MS : SCORERS_CURRENT_TTL_MS;
    const data = await apiFetch(
      `/competitions/${competitionCode}/scorers?season=${season}&limit=400`,
      ttl
    ) as any;
    const hit = data.scorers?.find((s: any) => s.player.id === playerId);
    if (!hit) return null;
    return {
      goals: hit.goals ?? 0,
      assists: hit.assists ?? 0,
      appearances: hit.playedMatches ?? 0,
      team: hit.team?.name ?? null,
    };
  } catch {
    return null;
  }
}

export async function getTeamSquadPlayers(teamId: string): Promise<Array<{ id: number; name: string }>> {
  if (useMock()) return [];
  const data = await apiFetch(`/teams/${teamId}`, SQUAD_TTL_MS) as any;
  return (data.squad ?? []).map((p: any) => ({ id: p.id as number, name: p.name as string }));
}

// Merge Transfermarkt career rows with Wikipedia career rows.
// TM provides per-competition granularity; Wiki provides season-aggregate totals.
// Strategy: for any season Transfermarkt covers, prefer TM rows entirely
// (more granular and accurate). Wiki rows fill in seasons TM missed.
function mergeCareerSources(
  wikiRows: Array<{ season: string; team: string; league: string; appearances: number; goals: number; assists: number }>,
  tmRows: TmCareerRow[]
): Array<{ season: string; team: string; league: string; appearances: number; goals: number; assists: number }> {
  if (tmRows.length === 0) return wikiRows;

  const tmSeasons = new Set(tmRows.map((r) => r.season));
  const tmConverted = tmRows.map((r) => ({
    season: r.season,
    team: r.team,
    league: r.competition,
    appearances: r.appearances,
    goals: r.goals,
    assists: r.assists,
  }));

  // Wiki rows only for seasons Transfermarkt doesn't cover
  const wikiGap = wikiRows.filter((r) => !tmSeasons.has(r.season));

  return [...tmConverted, ...wikiGap];
}

// Normalise a trophy name for cross-source matching:
// strips leading country adjectives and collapses punctuation/spacing.
function normTrophyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(english|spanish|german|italian|french|portuguese|dutch|scottish|belgian)\s+/i, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Merge Transfermarkt player honours with Wikipedia player trophies.
// Wikipedia is the primary source (has team attribution); TM fills gaps.
// For trophies found in both, we union the years lists.
function mergePlayerTrophies(wikiTrophies: Trophy[], tmTrophies: TmClubTrophy[]): Trophy[] {
  if (tmTrophies.length === 0) return wikiTrophies;

  const result: Trophy[] = wikiTrophies.map((t) => ({ ...t, years: [...t.years] }));
  const wikiIdx = new Map<string, Trophy>(result.map((t) => [normTrophyName(t.name), t]));

  for (const tm of tmTrophies) {
    const key = normTrophyName(tm.name);
    const existing = wikiIdx.get(key);
    if (existing) {
      // Enrich years from TM (union, sorted)
      const merged = [...new Set([...existing.years, ...tm.years])].sort();
      existing.years = merged;
    } else {
      // TM has something Wikipedia missed — add it (no team info available from TM)
      const cat: Trophy["category"] = tm.category === "International" ? "international" : "club";
      const entry: Trophy = { name: tm.name, team: "", category: cat, years: tm.years };
      result.push(entry);
      wikiIdx.set(key, entry);
    }
  }

  return result;
}

export async function getPlayer(playerId: string, competitionCode = "PL") {
  if (useMock()) return { ...MOCK_PLAYER_STATS, id: playerId, name: "Bukayo Saka" };

  const id = parseInt(playerId, 10);
  const probeComps = [...new Set([competitionCode, "CL", "EL"])];

  // Phase 1: bio + both DB caches in parallel — saves 2 sequential round-trips.
  const TM_CUP_CHECK_TTL_MS = 24 * 60 * 60 * 1000; // re-check TM for cup rows at most once per day
  const [personData, cachedStats, cachedTrophies, tmCupChecked] = await Promise.all([
    apiFetch(`/persons/${id}`, 24 * 60 * 60 * 1000) as Promise<any>,
    getWikiStats(id),
    getWikiTrophies(id),
    getCached(`tm_cup_checked:${id}`),
  ]);

  // Current season string e.g. "2025/26"
  const currentSeasonStr = `${CURRENT_SEASON}/${String(CURRENT_SEASON + 1).slice(2)}`;

  // Re-scrape TM if: (a) no cache at all, or (b) cache exists with current-season league/UEFA
  // rows but NO cup rows — i.e. cached before cup integration.
  // A row is a "cup row" if its competition doesn't normalise to a known league/UEFA code.
  // Throttled to at most once per day to avoid slow loads for players without cup appearances.
  const canonicalValues = new Set(Object.values(COMP_CANONICAL));
  const cachedCurrentSeasonRows = (cachedStats ?? []).filter(r => r.season === currentSeasonStr);
  const cachedHasCupRows = cachedCurrentSeasonRows.some(
    r => !canonicalValues.has(normalizeComp(r.league ?? ""))
  );
  const needsCareer = cachedStats === null;
  const needsCurrentSeasonCups =
    !needsCareer &&
    cachedCurrentSeasonRows.length > 0 &&
    !cachedHasCupRows &&
    !tmCupChecked; // skip if TM was already checked within the last 24h
  const needsTrophies = cachedTrophies === null;

  // Phase 2: scorer API + wiki + Transfermarkt all run in parallel.
  // Wiki/TM are only invoked on a cache miss or when cups are missing from cache.
  // International tournaments (WC/EC) run in the calendar year of the tournament,
  // not the club-season year (e.g. WC 2026 uses season=2026, not CURRENT_SEASON=2025).
  const INTL_SEASON = now.getFullYear();
  const [currentSeasonHits, freshWiki, tmCareer, tmHonours] = await Promise.all([
    Promise.all(
      probeComps.map(async (code) => {
        const seasonYear = INTERNATIONAL_COMP_CODES.has(code) ? INTL_SEASON : CURRENT_SEASON;
        const entry = await fetchScorerStats(id, code, seasonYear);
        return entry ? { code, entry, seasonYear } : null;
      })
    ).then((r) => r.filter(Boolean) as Array<{ code: string; entry: ScorerEntry; seasonYear: number }>),
    (needsCareer || needsTrophies)
      ? fetchPlayerWikiData(personData.name, needsCareer, needsTrophies)
      : Promise.resolve(null),
    needsCareer || needsCurrentSeasonCups
      ? scrapeTransfermarktPlayerStats(personData.name, personData.currentTeam?.name ?? "").catch(() => [] as TmCareerRow[])
      : Promise.resolve([] as TmCareerRow[]),
    // TM player honours run in parallel with career stats on a trophy cache miss
    needsTrophies
      ? scrapeTransfermarktPlayerHonours(personData.name).catch(() => [] as TmClubTrophy[])
      : Promise.resolve([] as TmClubTrophy[]),
  ]);

  // Merge TM (granular, has cup data) with wiki/cache (gap-filler for older seasons).
  // On cup re-scrape (needsCurrentSeasonCups), use cachedStats as the "wiki" base so
  // historical rows are preserved and only new TM cup rows are added.
  const mergedCareer = mergeCareerSources(
    freshWiki?.career ?? (needsCurrentSeasonCups ? (cachedStats ?? []) : []),
    tmCareer
  );
  if (mergedCareer.length) setWikiStats(id, personData.name, mergedCareer);
  // Mark that TM cup check has run so we don't re-scrape on every request for
  // players who have no cup appearances this season.
  if (needsCurrentSeasonCups) setCached(`tm_cup_checked:${id}`, true, TM_CUP_CHECK_TTL_MS);

  // Merge TM player honours with Wikipedia trophies; TM fills entries wiki missed.
  const mergedTrophies = mergePlayerTrophies(freshWiki?.trophies ?? [], tmHonours);
  if (needsTrophies && mergedTrophies.length > 0) setWikiTrophies(id, mergedTrophies);

  // Filter out junk: year-only names and "participant" entries (not real honours).
  const validtrophy = (t: Trophy) =>
    /[a-zA-Z]/.test(t.name) && !t.name.toLowerCase().includes("participant");
  // Prefer freshly merged data (has cups from TM); fall back to cache if no re-scrape ran.
  const wikiRows = mergedCareer.length > 0 ? mergedCareer : cachedStats;
  const trophies = (cachedTrophies ?? mergedTrophies).filter(validtrophy);

  // Past seasons: only probe competitions where the player actually appeared this season.
  // CL/EL are added only if the player had scorer entries there in the current season.
  // This cuts worst-case API calls from 30 to ~10 for a typical domestic-only player.
  const currentSeasonCodes = new Set(currentSeasonHits.map((r) => r.code));
  const activeComps = [...new Set([
    competitionCode,
    ...(currentSeasonCodes.has("CL") ? ["CL"] : []),
    ...(currentSeasonCodes.has("EL") ? ["EL"] : []),
    ...(currentSeasonCodes.has("ECL") ? ["ECL"] : []),
  ])];

  // Past-season scorer lookups: run all in parallel.
  // Past seasons use FOREVER_TTL so Supabase/memCache hits dominate — running all at once
  // reduces wait time from ceil(N/5)×50ms batches to a single ~50ms parallel read.
  // apiFetch deduplicates in-flight requests for the same path, so concurrent fd.org
  // misses on the same path share one HTTP call rather than stacking 429s.
  const pastSeasonTasks = CAREER_SEASONS.flatMap((season) =>
    activeComps.map((code) => ({ code, season }))
  );

  const pastSeasonResults = await Promise.all(
    pastSeasonTasks.map(async ({ code, season }) => {
      const entry = await fetchScorerStats(id, code, season);
      return entry ? { code, season, entry } : null;
    })
  );
  const pastSeasonHits = pastSeasonResults.filter(Boolean) as Array<{ code: string; season: number; entry: ScorerEntry }>;

  // Career rows: each (competition × season) pair is its own row
  interface CareerRow { season: string; team: string; competition: string; appearances: number; goals: number; assists: number; }

  const fallbackTeam = personData.currentTeam?.name ?? "";

  const apiCareer: CareerRow[] = [
    ...currentSeasonHits.map(({ code, entry, seasonYear }) => ({
      season: INTERNATIONAL_COMP_CODES.has(code)
        ? `${seasonYear}`
        : `${CURRENT_SEASON}/${String(CURRENT_SEASON + 1).slice(2)}`,
      team: entry.team ?? fallbackTeam,
      competition: COMP_DISPLAY[code] ?? code,
      appearances: entry.appearances,
      goals: entry.goals,
      assists: entry.assists,
    })),
    ...pastSeasonHits.map(({ code, season, entry }) => ({
      season: `${season}/${String(season + 1).slice(2)}`,
      team: entry.team ?? fallbackTeam,
      competition: COMP_DISPLAY[code] ?? code,
      appearances: entry.appearances,
      goals: entry.goals,
      assists: entry.assists,
    })),
  ];

  // Merge Wikipedia career rows for any (season, competition) not already covered by the API.
  // Handles: pre-2015 history, goalkeeper seasons (never in scorers endpoint),
  // and competitions the API didn't query (e.g. a player's former league).
  const apiCompKeys = new Set(
    apiCareer.map((r) => `${r.season}|${normalizeComp(r.competition)}`)
  );
  const wikiCareer: CareerRow[] = (wikiRows ?? [])
    .filter((r) => !apiCompKeys.has(`${r.season}|${normalizeComp(r.league || "")}`))
    .map((r) => ({
      season: r.season,
      team: r.team,
      competition: r.league || "League",
      appearances: r.appearances,
      goals: r.goals,
      assists: r.assists,
    }));

  const career: CareerRow[] = [...apiCareer, ...wikiCareer].sort(
    (a, b) => b.season.localeCompare(a.season) || a.competition.localeCompare(b.competition)
  );

  // "This Season" = scorers API (league + UEFA) + wiki/TM rows for cups not in scorers
  const scorerCompKeys = new Set(
    currentSeasonHits.map(({ code }) => normalizeComp(COMP_DISPLAY[code] ?? code))
  );
  const currentSeasonWikiRows = (wikiRows ?? []).filter(
    (r) => r.season === currentSeasonStr && !scorerCompKeys.has(normalizeComp(r.league || ""))
  );
  const currentSeason = {
    appearances:
      currentSeasonHits.reduce((a, { entry: e }) => a + e.appearances, 0) +
      currentSeasonWikiRows.reduce((a, r) => a + r.appearances, 0),
    goals:
      currentSeasonHits.reduce((a, { entry: e }) => a + e.goals, 0) +
      currentSeasonWikiRows.reduce((a, r) => a + r.goals, 0),
    assists:
      currentSeasonHits.reduce((a, { entry: e }) => a + e.assists, 0) +
      currentSeasonWikiRows.reduce((a, r) => a + r.assists, 0),
    minutesPlayed: 0,
  };

  // Career totals = sum across all rows (API + wiki)
  const allRows = [...apiCareer, ...wikiCareer];
  const totals = allRows.reduce(
    (acc, e) => ({ appearances: acc.appearances + e.appearances, goals: acc.goals + e.goals, assists: acc.assists + e.assists }),
    { appearances: 0, goals: 0, assists: 0 }
  );

  return {
    id: personData.id,
    name: personData.name,
    nationality: personData.nationality,
    dateOfBirth: personData.dateOfBirth,
    position: personData.section ?? personData.position,
    currentSeason,
    career,
    totals,
    trophies: trophies ?? [],
  };
}

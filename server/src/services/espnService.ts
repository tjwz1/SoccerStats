import { safeFetch as fetch } from "../utils/httpClient";
import { getAnyCached, setCached, FOREVER_TTL_MS } from "../db/apiCache";
import type {
  StandingsData, StandingRow, StandingsGroup,
  CompetitionFixture, ScheduleMatch, FdStatLeader,
} from "./footballApi";

const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_CORE = "https://site.api.espn.com/apis/v2/sports/soccer";

const ESPN_LIVE_TTL   = 2 * 60 * 1000;
const ESPN_MED_TTL    = 30 * 60 * 1000;
const ESPN_STATIC_TTL = 6 * 60 * 60 * 1000;

// Keys currently being revalidated in the background — prevents duplicate background
// fetches when two ESPN requests arrive simultaneously for the same stale entry.
const revalidatingEspn = new Set<string>();

export interface EspnLeagueConfig {
  slug: string;
  name: string;
  area: string;
  emblem: string;
  code: string;
  /** true = current season is the calendar year (MLS, J-League). false = European Aug-May. */
  calendarYear: boolean;
}

export const ESPN_LEAGUES: Record<string, EspnLeagueConfig> = {
  MLS: {
    slug: "usa.1",
    name: "MLS",
    area: "United States",
    emblem: "",
    code: "MLS",
    calendarYear: true,
  },
  MX1: {
    slug: "mex.1",
    name: "Liga MX",
    area: "Mexico",
    emblem: "",
    code: "MX1",
    calendarYear: false,
  },
  SCO: {
    slug: "sco.1",
    name: "Scottish Premiership",
    area: "Scotland",
    emblem: "",
    code: "SCO",
    calendarYear: false,
  },
  ARG: {
    slug: "arg.1",
    name: "Liga Argentina",
    area: "Argentina",
    emblem: "",
    code: "ARG",
    calendarYear: true,
  },
  JPN: {
    slug: "jpn.j1",
    name: "J1 League",
    area: "Japan",
    emblem: "",
    code: "JPN",
    calendarYear: true,
  },
  TUR: {
    slug: "tur.1",
    name: "Süper Lig",
    area: "Turkey",
    emblem: "",
    code: "TUR",
    calendarYear: false,
  },
};

export function isEspnLeague(code: string): boolean {
  return code in ESPN_LEAGUES;
}

export function getEspnLeagueConfig(code: string): EspnLeagueConfig | undefined {
  return ESPN_LEAGUES[code];
}

/** Current season year for an ESPN league (calendar year or European). */
export function getEspnCurrentSeason(config: EspnLeagueConfig): number {
  const now = new Date();
  if (config.calendarYear) return now.getFullYear();
  // European: season starts August, so before August we're still in the prior season
  return now.getFullYear() - (now.getMonth() < 7 ? 1 : 0);
}

function espnCrest(teamId: string | number): string {
  return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/soccer/500/${teamId}.png&w=80&h=80&transparent=true`;
}

function mapEspnPosition(abbr: string | null | undefined): string {
  const a = (abbr ?? "").toUpperCase();
  if (a === "G" || a === "GK") return "Goalkeeper";
  if (a === "D" || a === "CB" || a === "LB" || a === "RB") return "Defence";
  if (a === "M" || a === "CM" || a === "LM" || a === "RM" || a === "DM" || a === "AM") return "Midfield";
  return "Offence";
}

function statVal(stats: any[], name: string): number {
  const s = stats.find((x: any) => x.name === name || x.abbreviation === name);
  if (!s) return 0;
  if (typeof s.value === "number") return s.value;
  return parseFloat(s.displayValue ?? "0") || 0;
}

async function espnFetch(url: string, ttlMs: number): Promise<any> {
  const key = `/espn/${url.replace(/^https?:\/\/[^/]+/, "")}`;
  const hit = await getAnyCached(key);
  if (hit) {
    // SWR: serve stale data immediately and refresh in background.
    // Consistent with the serveWithSWR pattern used throughout teams.ts.
    if (hit.stale && !revalidatingEspn.has(key)) {
      revalidatingEspn.add(key);
      fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
        .then((r) => r.ok ? r.json() : Promise.reject(new Error(`ESPN HTTP ${r.status}`)))
        .then((data) => setCached(key, data, ttlMs))
        .catch(() => {})
        .finally(() => revalidatingEspn.delete(key));
    }
    return hit.data;
  }
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status} for ${url}`);
  const data = await res.json();
  setCached(key, data, ttlMs).catch(() => {});
  return data;
}

// ── Teams ─────────────────────────────────────────────────────────────────────

export async function getEspnTeams(
  config: EspnLeagueConfig
): Promise<Array<{ id: number; name: string; shortName: string; tla: string; crest: string }>> {
  const data = await espnFetch(`${ESPN_SITE}/${config.slug}/teams`, ESPN_STATIC_TTL);
  const teams: any[] = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return teams.map(({ team }: any) => ({
    id: parseInt(team.id, 10),
    name: team.displayName ?? team.name ?? "",
    shortName: team.shortDisplayName ?? team.displayName ?? "",
    tla: (team.abbreviation ?? "").slice(0, 4),
    crest: team.logos?.[0]?.href ?? espnCrest(team.id),
  }));
}

// ── Standings ─────────────────────────────────────────────────────────────────

export async function getEspnStandings(
  config: EspnLeagueConfig,
  _season?: number
): Promise<StandingsData> {
  let data: any;
  try {
    data = await espnFetch(`${ESPN_CORE}/${config.slug}/standings`, ESPN_MED_TTL);
  } catch {
    return { groups: [] };
  }
  const children: any[] = data?.children ?? [];
  const groups = children.length > 0 ? children : [data];

  const standingGroups: StandingsGroup[] = groups.map((group: any) => {
    const entries: any[] = group?.standings?.entries ?? [];
    const rows: StandingRow[] = entries.map((e: any, idx: number) => {
      const team = e.team ?? {};
      const stats: any[] = e.stats ?? [];
      const rankStat = stats.find((s: any) => s.name === "rank");
      const pos = typeof rankStat?.value === "number" ? rankStat.value : idx + 1;
      return {
        position: pos,
        team: {
          id: parseInt(team.id, 10),
          name: team.displayName ?? team.name ?? "",
          shortName: team.shortDisplayName ?? team.displayName ?? "",
          tla: (team.abbreviation ?? "").slice(0, 4),
          crest: team.logos?.[0]?.href ?? espnCrest(team.id),
        },
        playedGames: statVal(stats, "gamesPlayed"),
        won:  statVal(stats, "wins"),
        draw: statVal(stats, "ties"),
        lost: statVal(stats, "losses"),
        points: statVal(stats, "points"),
        goalDifference: statVal(stats, "pointDifferential"),
        goalsFor:     statVal(stats, "pointsFor"),
        goalsAgainst: statVal(stats, "pointsAgainst"),
        form: null,
      };
    });
    rows.sort((a, b) => a.position - b.position);
    const label: string = group.name ?? group.abbreviation ?? "Standings";
    // Use a slug of the label as type so multi-conference leagues have unique keys
    const type = label.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    return { label, type, rows };
  });

  // If every team has 0 games played the season hasn't started yet.
  // Return seasonNotStarted so the client shows the appropriate message
  // instead of a table full of zeros.
  const allRows = standingGroups.flatMap((g) => g.rows);
  const maxPlayed = allRows.reduce((m, r) => Math.max(m, r.playedGames), 0);
  if (allRows.length > 0 && maxPlayed === 0) {
    return { groups: [], seasonNotStarted: true };
  }

  return { groups: standingGroups };
}

// ── Scorers ───────────────────────────────────────────────────────────────────

export async function getEspnScorers(
  config: EspnLeagueConfig,
  _season?: number
): Promise<{ goals: FdStatLeader[]; assists: FdStatLeader[] }> {
  const data = await espnFetch(
    `${ESPN_SITE}/${config.slug}/statistics?type=scoring`,
    ESPN_LIVE_TTL
  );
  const stats: any[] = data?.stats ?? [];

  function mapLeaders(cat: any): FdStatLeader[] {
    if (!cat) return [];
    return (cat.leaders ?? []).slice(0, 30).map((item: any) => {
      const ath = item.athlete ?? {};
      const team = item.team ?? {};
      return {
        value: item.value ?? 0,
        playedMatches: 0,
        player: {
          id: parseInt(ath.id, 10) || 0,
          name: ath.displayName ?? ath.fullName ?? "",
          nationality: ath.citizenship ?? "",
          dateOfBirth: "",
          position: mapEspnPosition(ath.position?.abbreviation),
        },
        team: {
          id: parseInt(team.id, 10) || 0,
          name: team.displayName ?? team.name ?? "",
          shortName: team.shortDisplayName ?? team.displayName ?? "",
          crest: team.logos?.[0]?.href ?? (team.id ? espnCrest(team.id) : ""),
          tla: (team.abbreviation ?? "").slice(0, 4),
        },
      };
    });
  }

  const goalsCat  = stats.find((s: any) => s.name === "goalsLeaders"   || s.abbreviation === "G");
  const assistCat = stats.find((s: any) => s.name === "assistsLeaders" || s.abbreviation === "A");
  return { goals: mapLeaders(goalsCat), assists: mapLeaders(assistCat) };
}

// ── Competition fixtures ──────────────────────────────────────────────────────

function buildDateRange(config: EspnLeagueConfig, season: number): string {
  if (config.calendarYear) {
    return `${season}0201-${season}1201`;
  }
  return `${season}0801-${season + 1}0701`;
}

export async function getEspnCompetitionFixtures(
  config: EspnLeagueConfig,
  season?: number
): Promise<CompetitionFixture[]> {
  const yr = season ?? getEspnCurrentSeason(config);
  const dateRange = buildDateRange(config, yr);
  const data = await espnFetch(
    `${ESPN_SITE}/${config.slug}/scoreboard?dates=${dateRange}&limit=500`,
    season && season < getEspnCurrentSeason(config) ? FOREVER_TTL_MS : ESPN_MED_TTL
  );
  const events: any[] = data?.events ?? [];
  const fixtures: CompetitionFixture[] = [];

  const parseScore = (c: any): number | null => {
    const s = c.score;
    if (s == null) return null;
    if (typeof s === "number") return s;
    if (typeof s === "string") { const n = parseFloat(s); return isNaN(n) ? null : n; }
    const v = s.value ?? s.displayValue;
    if (v == null) return null;
    const n = parseFloat(String(v));
    return isNaN(n) ? null : n;
  };

  for (const e of events) {
    const id = parseInt(e.id, 10);
    if (!id) continue;
    const comp = e.competitions?.[0] ?? {};
    const competitors: any[] = comp.competitors ?? [];
    const home = competitors.find((c: any) => c.homeAway === "home") ?? competitors[0] ?? {};
    const away = competitors.find((c: any) => c.homeAway === "away") ?? competitors[1] ?? {};
    const done = (comp.status?.type ?? e.status?.type)?.completed === true;
    fixtures.push({
      id,
      utcDate: e.date ?? "",
      status: done ? "FINISHED" : "SCHEDULED",
      matchday: null,
      stage: "REGULAR_SEASON",
      homeTeam: {
        id: parseInt(home.team?.id, 10) || 0,
        name: home.team?.displayName ?? "",
        crest: home.team?.logos?.[0]?.href ?? espnCrest(home.team?.id ?? 0),
      },
      awayTeam: {
        id: parseInt(away.team?.id, 10) || 0,
        name: away.team?.displayName ?? "",
        crest: away.team?.logos?.[0]?.href ?? espnCrest(away.team?.id ?? 0),
      },
      scoreHome: done ? parseScore(home) : null,
      scoreAway: done ? parseScore(away) : null,
      winner: done
        ? (home.winner === true ? "HOME_TEAM" : away.winner === true ? "AWAY_TEAM" : "DRAW")
        : null,
    });
  }
  fixtures.sort((a, b) => a.utcDate.localeCompare(b.utcDate));
  return fixtures;
}

// ── Team schedule ─────────────────────────────────────────────────────────────

export async function getEspnTeamSchedule(
  espnTeamId: number,
  config: EspnLeagueConfig,
  season?: number
): Promise<ScheduleMatch[]> {
  const yr = season ?? getEspnCurrentSeason(config);
  const data = await espnFetch(
    `${ESPN_SITE}/${config.slug}/teams/${espnTeamId}/schedule?season=${yr}`,
    ESPN_MED_TTL
  );
  const events: any[] = data?.events ?? [];
  const seen = new Set<number>();
  const matches: ScheduleMatch[] = [];

  for (const e of events) {
    const id = parseInt(e.id, 10);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const comp = e.competitions?.[0] ?? {};
    const competitors: any[] = comp.competitors ?? [];
    const home = competitors.find((c: any) => c.homeAway === "home") ?? competitors[0] ?? {};
    const away = competitors.find((c: any) => c.homeAway === "away") ?? competitors[1] ?? {};

    // Status is nested under comp.status.type (not e.status.type) in team schedule responses
    const statusType = comp.status?.type ?? e.status?.type ?? {};
    const done = statusType.completed === true;
    const typeName: string = statusType.name ?? "STATUS_SCHEDULED";
    const statusMap: Record<string, string> = {
      STATUS_FULL_TIME: "FINISHED", STATUS_FINAL: "FINISHED",
      STATUS_HALFTIME: "HALF_TIME", STATUS_IN_PROGRESS: "IN_PLAY",
      STATUS_POSTPONED: "POSTPONED", STATUS_CANCELED: "CANCELLED",
      STATUS_SCHEDULED: "SCHEDULED", STATUS_TIMED: "TIMED",
    };
    const status = done ? "FINISHED" : (statusMap[typeName] ?? "SCHEDULED");

    // Score is an object { value, displayValue } in team schedule responses
    const parseScore = (c: any): number | null => {
      if (!done) return null;
      const s = c.score;
      if (s == null) return null;
      if (typeof s === "number") return s;
      if (typeof s === "string") { const n = parseFloat(s); return isNaN(n) ? null : n; }
      // object form: { value: 2, displayValue: "2" }
      const v = s.value ?? s.displayValue;
      if (v == null) return null;
      const n = parseFloat(String(v));
      return isNaN(n) ? null : n;
    };

    matches.push({
      id,
      status,
      utcDate: e.date ?? "",
      matchday: null,
      competition: config.name,
      competitionCode: config.code,
      competitionEmblem: config.emblem,
      homeTeam: home.team?.displayName ?? "",
      homeTeamId: parseInt(home.team?.id, 10) || 0,
      homeTeamCrest: home.team?.logos?.[0]?.href ?? espnCrest(home.team?.id ?? 0),
      awayTeam: away.team?.displayName ?? "",
      awayTeamId: parseInt(away.team?.id, 10) || 0,
      awayTeamCrest: away.team?.logos?.[0]?.href ?? espnCrest(away.team?.id ?? 0),
      scoreHome: parseScore(home),
      scoreAway: parseScore(away),
      duration: null,
      winner: done
        ? (home.winner === true ? "HOME_TEAM" : away.winner === true ? "AWAY_TEAM" : "DRAW")
        : null,
      etScoreHome: null, etScoreAway: null,
      regularTimeHome: null, regularTimeAway: null,
      penScoreHome: null, penScoreAway: null,
    });
  }

  matches.sort((a, b) => a.utcDate.localeCompare(b.utcDate));
  return matches;
}

// ── Squad / roster for lineup builder ─────────────────────────────────────────

/**
 * Returns ESPN team data shaped like fd.org's `/teams/{id}` response so the
 * shared lineup-builder logic in footballApi.ts can consume it directly.
 */
export async function getEspnTeamDataForLineup(
  espnTeamId: number,
  config: EspnLeagueConfig
): Promise<{ id: number; name: string; shortName: string; squad: any[] }> {
  const data = await espnFetch(
    `${ESPN_SITE}/${config.slug}/teams/${espnTeamId}/roster`,
    ESPN_STATIC_TTL
  );
  const teamInfo = data?.team ?? {};
  const athletes: any[] = data?.athletes ?? [];

  const squad = athletes.map((a: any) => ({
    id: parseInt(a.id, 10),
    name: a.displayName ?? a.fullName ?? "",
    position: mapEspnPosition(a.position?.abbreviation),
    shirtNumber: a.jersey ? parseInt(a.jersey, 10) : null,
    nationality: a.citizenship ?? a.birthCountry?.name ?? null,
    dateOfBirth: a.dateOfBirth ?? null,
  }));

  return {
    id: espnTeamId,
    name: teamInfo.displayName ?? teamInfo.name ?? "",
    shortName: teamInfo.shortDisplayName ?? "",
    squad,
  };
}

export type NormalizedPosition = "Goalkeeper" | "Defender" | "Midfielder" | "Attacker";
export type PlayerRole = "GK" | "RB" | "CB" | "LB" | "DM" | "CM" | "AM" | "RW" | "LW" | "CF";

export interface Competition {
  id: number;
  name: string;
  code: string;
  emblem: string;
}

export interface Team {
  id: number;
  name: string;
  shortName: string;
  crest: string;
  tla: string;
}

export interface StandingRow {
  position: number;
  team: Team;
  playedGames: number;
  won: number;
  draw: number;
  lost: number;
  points: number;
  goalDifference: number;
  form: string | null;
}

export interface CompetitionSeason {
  year: number;
  startDate: string;
  endDate: string;
  winner: string | null;
}

export interface StandingsGroup {
  label: string;
  type: string;
  rows: StandingRow[];
}

export interface StandingsData {
  groups: StandingsGroup[];
}

export interface Player {
  id: number;
  name: string;
  position: NormalizedPosition;
  role?: PlayerRole;
  nationality: string;
  dateOfBirth: string;
  shirtNumber: number | null;
  photo?: string | null;
  appearances?: number;
  goals?: number;
  assists?: number;
}

export interface LineupData {
  competitionCode?: string | null;
  formation: string;
  starters: Player[];
  bench: Player[];
}

export interface Trophy {
  name: string;
  team: string;
  category: "club" | "international" | "individual";
  years: string[];
}

export interface CareerEntry {
  season: string;
  team: string;
  competition: string;
  appearances: number;
  goals: number;
  assists: number;
}

export interface PlayerDetail {
  id: number | string;
  name: string;
  nationality?: string;
  dateOfBirth?: string;
  position?: string;
  currentSeason: {
    appearances: number;
    goals: number;
    assists: number;
    minutesPlayed: number;
  };
  career: CareerEntry[];
  totals: {
    appearances: number;
    goals: number;
    assists: number;
  };
  trophies: Trophy[];
}

export interface ClubTrophy {
  category: string;
  name: string;
  count: number;
  years: string[];
  imageUrl?: string;
}

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
  duration: "REGULAR" | "EXTRA_TIME" | "PENALTY_SHOOTOUT" | null;
  winner: "HOME_TEAM" | "AWAY_TEAM" | "DRAW" | null;
  etScoreHome: number | null;
  etScoreAway: number | null;
  penScoreHome: number | null;
  penScoreAway: number | null;
}

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

export interface PitchPosition {
  x: number;
  y: number;
}

export interface MatchLineupPlayer {
  id: number;
  name: string;
  position: string;
  role: string | null;
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

export interface StatLeader {
  value: number;
  playedMatches: number;
  liveAdd?: number;    // goals/assists scored in currently live matches (not yet in fd.org)
  player: {
    id: number;       // fd.org ID for goals/assists; 0 for ESPN-only entries (clean sheets)
    name: string;
    nationality: string;
    dateOfBirth: string;
    position: string;
  };
  team: Team;
}

export interface CompetitionStats {
  goals: StatLeader[];
  assists: StatLeader[];
  cleanSheets: StatLeader[];
  hasLive?: boolean;   // true when at least one match in this competition is currently live
}

export interface TeamStatLine {
  teamName: string;
  possession: number | null;
  shots: number | null;
  shotsOnTarget: number | null;
  corners: number | null;
  fouls: number | null;
  yellowCards: number | null;
  redCards: number | null;
  offsides: number | null;
  saves: number | null;
}

export interface MatchTeamStats {
  home: TeamStatLine;
  away: TeamStatLine;
}

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

export interface PlayerGameStats {
  minutesPlayed: number;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  shots: number;
  shotsOnTarget: number;
  rating: number | null;
  starter: boolean;
  subbedIn: boolean;
  subbedOut: boolean;
}

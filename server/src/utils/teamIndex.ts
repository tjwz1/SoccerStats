// In-memory team search index built during cold-start warmup.
// Only used as the search fast-path once ALL known competitions are indexed —
// a partial index would return different results than a full API search.

export interface TeamEntry {
  id: number;
  name: string;
  shortName?: string;
  tla?: string;
  crest?: string;
  competitionCode?: string;
}

// token → teams that match it (deduplicated by id, first comp wins)
const index = new Map<string, TeamEntry[]>();
// id → comp code that "owns" this team in the index
const seen = new Map<number, string>();
// comp codes that have been fully added to the index
const indexedComps = new Set<string>();
// comp codes that are expected to be in a complete index
let knownCompCodes: Set<string> = new Set();

const DOMESTIC_PRIORITY = ["PL", "PD", "BL1", "SA", "FL1", "DED", "PPL", "BSA", "ELC"];

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function addTeamsForComp(compCode: string, teams: TeamEntry[]) {
  for (const team of teams) {
    if (seen.has(team.id)) continue;
    seen.set(team.id, compCode);
    const entry: TeamEntry = { ...team, competitionCode: compCode };
    const tokens = new Set([
      ...tokenize(team.name ?? ""),
      ...tokenize(team.shortName ?? ""),
      ...tokenize(team.tla ?? ""),
    ]);
    for (const tok of tokens) {
      const bucket = index.get(tok) ?? [];
      bucket.push(entry);
      index.set(tok, bucket);
    }
  }
  indexedComps.add(compCode);
}

export function buildTeamIndex(teamsByComp: Map<string, TeamEntry[]>): void {
  index.clear();
  seen.clear();
  indexedComps.clear();

  // Sort comps: domestic leagues first so that e.g. "Barcelona" → PD not CL
  const sorted = [...teamsByComp.entries()].sort(([a], [b]) => {
    const ai = DOMESTIC_PRIORITY.indexOf(a);
    const bi = DOMESTIC_PRIORITY.indexOf(b);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  for (const [compCode, teams] of sorted) {
    addTeamsForComp(compCode, teams);
  }
}

export function addCompToIndex(compCode: string, teams: TeamEntry[]): void {
  addTeamsForComp(compCode, teams);
}

/** Register the full set of competition codes that should be in a complete index. */
export function setKnownCompCodes(codes: string[]): void {
  knownCompCodes = new Set(codes);
}

/** Returns true only when every known competition has been indexed — partial index is unsafe. */
export function isIndexComplete(): boolean {
  if (knownCompCodes.size === 0 || indexedComps.size === 0) return false;
  for (const code of knownCompCodes) {
    if (!indexedComps.has(code)) return false;
  }
  return true;
}

/** Returns up to `limit` teams matching query string, preserving domestic-first ordering. */
export function searchTeamIndex(q: string, limit = 15): TeamEntry[] {
  const qTokens = tokenize(q);
  if (qTokens.length === 0) return [];

  // Gather candidates from the first token, then filter by all remaining tokens
  const first = qTokens[0];
  const candidates = new Map<number, TeamEntry>();

  // Prefix-match on the first query token against all index tokens
  for (const [tok, entries] of index) {
    if (!tok.startsWith(first)) continue;
    for (const e of entries) {
      if (!candidates.has(e.id)) candidates.set(e.id, e);
    }
  }

  // For multi-token queries, require all subsequent tokens to appear in the team's name
  const results: TeamEntry[] = [];
  outer: for (const team of candidates.values()) {
    const fullText = [team.name, team.shortName, team.tla]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
    for (let i = 1; i < qTokens.length; i++) {
      if (!fullText.includes(qTokens[i])) continue outer;
    }
    results.push(team);
    if (results.length >= limit) break;
  }

  return results;
}

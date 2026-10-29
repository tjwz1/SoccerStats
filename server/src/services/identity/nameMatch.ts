/**
 * Pure name normalisation, similarity scoring, and evidence-weighted candidate scoring
 * for the player identity layer (Phase A — see BACKLOG.md and the plan file's
 * "Appendix A: Player Identity Layer"). No I/O, no deps beyond the standard library.
 *
 * Replaces the nine near-duplicate ad hoc name normalisers scattered across the scraper
 * services with one shared implementation, and replaces blind "first match wins" /
 * substring-matching heuristics (the mechanism behind the ESPN id-collision bug and the
 * cross-player assist-merge bug, both fixed ad hoc in October 2026) with an explicit,
 * auditable confidence score built from several independent pieces of evidence.
 */
import { clubNamesMatch } from "./clubKey";

const PARTICLES = new Set([
  "de", "van", "von", "da", "di", "del", "della", "der", "den",
  "le", "la", "el", "al", "bin", "ibn", "y",
]);

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

// Letters with no NFD accent decomposition — must be mapped by hand before NFD stripping,
// or they're silently dropped instead of folding to their ASCII equivalent (the same class
// of bug fixed for ß in routes/teams.ts's normName on 2026-10-28).
const PRE_NFD_MAP: Record<string, string> = {
  ø: "o", ð: "d", þ: "th", ł: "l", ß: "ss", æ: "ae", œ: "oe", đ: "d", ı: "i",
};

function applyPreNfdMap(s: string): string {
  let out = "";
  for (const ch of s) out += PRE_NFD_MAP[ch] ?? ch;
  return out;
}

/**
 * Normalises a name for matching. Returns "" for input with no Latin-alphabet content
 * (e.g. a name given only in Cyrillic/CJK script) — "" must be treated as "no evidence
 * either way", never as a match (two non-Latin names would otherwise both normalise to ""
 * and falsely look identical).
 */
export function normalizeName(raw: string): string {
  if (!raw) return "";
  let s = raw.toLowerCase();
  s = applyPreNfdMap(s);
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, ""); // strip combining marks
  // "aa" is the pre-Unicode ASCII transliteration convention for å (e.g. fd.org's
  // "Haaland" vs a source spelling it "Håland", which NFD-strips to "haland") — fold
  // them to the same form so this well-known case scores as the same name, not a
  // coincidental near-miss.
  s = s.replace(/aa/g, "a");
  s = s.replace(/['’\-.]/g, " ");
  s = s.replace(/[^a-z0-9 ]/g, " ");
  s = s.trim().replace(/\s+/g, " ");
  if (!s) return "";

  const tokens = s.split(" ").filter(Boolean);
  if (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

export interface NameTokens {
  tokens: string[];
  surname: string;
  initials: string[];
  particles: string[];
}

/** Surname = last token that isn't a particle (so "de Jong" keeps "jong", not "de"). */
export function nameTokens(norm: string): NameTokens {
  const tokens = norm.split(" ").filter(Boolean);
  const particles = tokens.filter((t) => PARTICLES.has(t));
  let surname = "";
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!PARTICLES.has(tokens[i])) { surname = tokens[i]; break; }
  }
  const initials = tokens.map((t) => t[0] ?? "");
  return { tokens, surname, initials, particles };
}

function bigrams(s: string): string[] {
  const packed = s.replace(/ /g, "");
  if (packed.length < 2) return packed.length === 1 ? [packed] : [];
  const out: string[] = [];
  for (let i = 0; i < packed.length - 1; i++) out.push(packed.slice(i, i + 2));
  return out;
}

function diceCoefficient(a: string, b: string): number {
  const ba = bigrams(a), bb = bigrams(b);
  if (ba.length === 0 || bb.length === 0) return ba.length === bb.length ? 1 : 0;
  const counts = new Map<string, number>();
  for (const g of ba) counts.set(g, (counts.get(g) ?? 0) + 1);
  let overlap = 0;
  for (const g of bb) {
    const c = counts.get(g) ?? 0;
    if (c > 0) { overlap++; counts.set(g, c - 1); }
  }
  return (2 * overlap) / (ba.length + bb.length);
}

function jaccardTokens(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

// An initial ("f") matching the first letter of the other side's full token ("frenkie")
// counts as a token match for the Jaccard half — handles "F. de Jong" vs "Frenkie de Jong".
function tokensEquivalent(ta: string[], tb: string[]): { a: string[]; b: string[] } {
  const na = [...ta], nb = [...tb];
  for (let i = 0; i < na.length; i++) {
    if (na[i].length === 1) {
      const match = nb.find((t) => t[0] === na[i] && t.length > 1);
      if (match) na[i] = match;
    }
  }
  for (let i = 0; i < nb.length; i++) {
    if (nb[i].length === 1) {
      const match = na.find((t) => t[0] === nb[i] && t.length > 1);
      if (match) nb[i] = match;
    }
  }
  return { a: na, b: nb };
}

/**
 * 0.5 x Dice(char bigrams) + 0.5 x Jaccard(tokens, with initial-matching), with a 0.8
 * floor when one side's tokens are all contained in the other's (handles Transfermarkt's
 * fuller legal names, e.g. "Alisson" vs "Alisson Becker"). Chosen over Jaro-Winkler
 * (over-rewards shared prefixes — "Rodri" vs "Rodriguez") and plain Levenshtein (penalises
 * token reordering, which is common across sources).
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return 0; // no evidence either way, never a match
  if (na === nb) return 1;

  const ta = nameTokens(na), tb = nameTokens(nb);
  const { a: eqa, b: eqb } = tokensEquivalent(ta.tokens, tb.tokens);

  const dice = diceCoefficient(na, nb);
  const jac = jaccardTokens(eqa, eqb);
  let score = 0.5 * dice + 0.5 * jac;

  const sa = new Set(eqa), sb = new Set(eqb);
  const aSubsetOfB = [...sa].every((t) => sb.has(t));
  const bSubsetOfA = [...sb].every((t) => sa.has(t));
  if ((aSubsetOfB || bSubsetOfA) && sa.size > 0 && sb.size > 0) {
    score = Math.max(score, 0.8);
  }

  return Math.min(1, score);
}

export interface CandidateAnchor {
  name: string;
  dob?: string | null;       // YYYY-MM-DD
  club?: string | null;
  nationality?: string | null;
  position?: string | null;  // broad group, e.g. "Defender"
  shirtNumber?: number | null;
  idAPIfootball?: number | null; // TheSportsDB cross-ref — short-circuits to 1.0 when it equals the fd.org anchor id
}

export interface ScoreResult {
  confidence: number;
  status: "auto_high" | "auto_low" | "queued" | "discarded";
  evidence: Record<string, unknown>;
}

const AUTO_HIGH = 0.85;
const AUTO_LOW = 0.60;
const QUEUE_FLOOR = 0.40;

function statusFor(confidence: number): ScoreResult["status"] {
  if (confidence >= AUTO_HIGH) return "auto_high";
  if (confidence >= AUTO_LOW) return "auto_low";
  if (confidence >= QUEUE_FLOOR) return "queued";
  return "discarded";
}

function yearOf(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const y = Number(dob.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

/**
 * Scores one candidate against the anchor. `peers` are the OTHER candidates being
 * considered for the same anchor in this match attempt — used for the uniqueness bonus /
 * ambiguity penalty, not to be confused with the review queue's own candidate rows.
 */
export function scoreCandidate(
  anchor: CandidateAnchor,
  candidate: CandidateAnchor,
  opts: { peers?: CandidateAnchor[]; fdId?: number } = {}
): ScoreResult {
  const evidence: Record<string, unknown> = {};

  if (
    opts.fdId !== undefined &&
    candidate.idAPIfootball !== undefined &&
    candidate.idAPIfootball !== null &&
    candidate.idAPIfootball === opts.fdId
  ) {
    evidence.crossref = "idAPIfootball";
    return { confidence: 1, status: "auto_high", evidence };
  }

  const sim = nameSimilarity(anchor.name, candidate.name);
  evidence.nameSimilarity = sim;
  if (sim < 0.5) {
    return { confidence: 0, status: "discarded", evidence: { ...evidence, reason: "name similarity below floor" } };
  }
  let score = 0.45 * sim;

  const ay = yearOf(anchor.dob), cy = yearOf(candidate.dob);
  if (ay !== null && cy !== null) {
    const diff = Math.abs(ay - cy);
    if (diff > 1) {
      return { confidence: 0, status: "discarded", evidence: { ...evidence, reason: "DOB year mismatch", anchorYear: ay, candidateYear: cy } };
    }
    if (anchor.dob && candidate.dob && anchor.dob === candidate.dob) {
      score += 0.35;
      evidence.dob = "exact";
    } else {
      score += 0.15;
      evidence.dob = "year-only";
    }
  }

  if (anchor.club && candidate.club && clubsMatch(anchor.club, candidate.club)) {
    score += 0.15;
    evidence.club = true;
  }
  if (anchor.nationality && candidate.nationality &&
      normalizeName(anchor.nationality) === normalizeName(candidate.nationality)) {
    score += 0.05;
    evidence.nationality = true;
  }
  if (anchor.position && candidate.position &&
      normalizeName(anchor.position) === normalizeName(candidate.position)) {
    score += 0.03;
    evidence.position = true;
  }
  if (anchor.shirtNumber != null && candidate.shirtNumber != null &&
      anchor.shirtNumber === candidate.shirtNumber) {
    score += 0.02;
    evidence.shirt = true;
  }

  const peers = opts.peers ?? [];
  const peerScores = peers.map((p) => 0.45 * nameSimilarity(anchor.name, p.name));
  const strongPeers = peerScores.filter((s) => s >= 0.4 * 0.45 / 0.45); // peers scoring >=0.4 on name alone
  if (strongPeers.length === 0 && peers.length > 0) {
    score += 0.05;
    evidence.uniqueness = "bonus";
  }
  const closeRival = peerScores.some((s) => Math.abs(s - 0.45 * sim) <= 0.05 && s > 0);
  if (closeRival) {
    score -= 0.10;
    evidence.ambiguity = "penalty";
    score = Math.min(score, AUTO_LOW - 0.001);
  }

  score = Math.max(0, Math.min(1, score));
  return { confidence: score, status: statusFor(score), evidence };
}

const clubsMatch = clubNamesMatch;

/**
 * Club-name comparison for the identity layer's scoring module, reusing the two existing
 * club-name heuristics already proven in this codebase instead of inventing a third:
 * Transfermarkt's fd.org-name -> TM-search-query alias table, and TheSportsDB's
 * longest-significant-word "team keyword" extraction.
 */
import { TM_CLUB_NAME_ALIASES } from "../transfermarktScraper";
import { teamKeyword } from "../theSportsDb";

/** fd.org's name for a club, resolved to the name another source is more likely to use. */
export function resolveClubAlias(fdClubName: string): string {
  return TM_CLUB_NAME_ALIASES[fdClubName] ?? fdClubName;
}

/**
 * True when two club names most likely refer to the same club, tried cheapest-first:
 * exact alias-resolved match, then a shared "team keyword" (the longest >=5-char word
 * after stripping generic prefixes like "FC"/"SC" — e.g. "barcelona", "manchester").
 */
export function clubNamesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ra = resolveClubAlias(a), rb = resolveClubAlias(b);
  if (ra.trim().toLowerCase() === rb.trim().toLowerCase()) return true;
  const ka = teamKeyword(a), kb = teamKeyword(b);
  return !!ka && ka === kb;
}

/**
 * Shared block-cooldown state for every Transfermarkt-calling module
 * (transfermarktScraper.ts, cupSchedule.ts's own TM fetcher). A single in-memory
 * timestamp, not per-module — TM's WAF challenges the whole IP, not one endpoint, so a
 * block seen by one caller should be visible to all of them. Exists specifically so the
 * bulk admin refresh job can stop hammering an already-blocked host instead of each
 * module discovering and re-discovering the same block independently.
 */
let lastBlockedAt = 0;

export function recordTmBlocked(): void {
  lastBlockedAt = Date.now();
}

export function getTmLastBlockedAt(): number {
  return lastBlockedAt;
}

export function isTmRecentlyBlocked(windowMs: number): boolean {
  return lastBlockedAt > 0 && Date.now() - lastBlockedAt < windowMs;
}

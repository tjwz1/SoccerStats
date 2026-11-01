/**
 * Shared block-cooldown state for every SofaScore-calling module (sofaScoreCareer.ts,
 * sofaScorePhotos.ts). A single in-memory timestamp, not per-module — SofaScore's bot
 * detection blocks the whole IP, not one endpoint, so a block seen by one caller should be
 * visible to all of them. Exists specifically so the bulk admin refresh job (and, where
 * appropriate, high-traffic live callers like the squad photo lookup) can stop hammering an
 * already-blocked host instead of each module discovering and re-discovering the same block
 * independently.
 */
let lastBlockedAt = 0;

export function recordSsBlocked(): void {
  lastBlockedAt = Date.now();
}

export function getSsLastBlockedAt(): number {
  return lastBlockedAt;
}

export function isSsRecentlyBlocked(windowMs: number): boolean {
  return lastBlockedAt > 0 && Date.now() - lastBlockedAt < windowMs;
}

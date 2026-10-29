/**
 * Sits in front of the identity store: "ask for a pinned ref first; otherwise score the
 * candidates handed to it and write the outcome back." Phase A only — IDENTITY_MODE
 * defaults to "off", under which every function here is a zero-DB-read no-op, so importing
 * this module has no effect on the live app until a later phase flips the env var.
 */
import {
  getActiveRef, getRefBySourceId, upsertRef, recordCandidate, createIdentity, getIdentity,
  type IdentitySource, type PlayerSourceRef,
} from "./identityStore";
import { scoreCandidate, type CandidateAnchor } from "./nameMatch";

export type IdentityMode = "off" | "shadow" | "on";

export function getIdentityMode(): IdentityMode {
  const v = (process.env.IDENTITY_MODE ?? "off").toLowerCase();
  return v === "shadow" || v === "on" ? v : "off";
}

/**
 * Returns a pinned ref (auto_high or manual_confirmed) for this (internalId, source), or
 * null if there isn't one — callers fall back to their existing heuristic when null. In
 * "off" mode this never touches the database and always returns null.
 */
export async function resolveSourceRef(internalId: number, source: IdentitySource): Promise<PlayerSourceRef | null> {
  if (getIdentityMode() === "off") return null;
  const ref = await getActiveRef(internalId, source);
  if (!ref) return null;
  if (ref.status === "auto_high" || ref.status === "manual_confirmed") return ref;
  return null;
}

/** Find-or-create an identity from an anchor source (fd.org or ESPN roster entry). */
export async function resolvePlayerIdentity(
  anchor: CandidateAnchor,
  primarySource: IdentitySource,
  anchorExternalId: string
): Promise<number> {
  const byId = await getRefBySourceId(primarySource, anchorExternalId);
  if (byId) return byId.internal_id;

  const identity = await createIdentity({
    displayName: anchor.name,
    dob: anchor.dob ?? null,
    nationality: anchor.nationality ?? null,
    position: anchor.position ?? null,
    primarySource,
  });
  await upsertRef({
    internalId: identity.id,
    source: primarySource,
    externalId: anchorExternalId,
    externalName: anchor.name,
    confidence: 1,
    status: "manual_confirmed", // the anchor source defines the identity by construction
    matchedBy: "anchor",
  });
  return identity.id;
}

export interface ScoreAndStoreResult {
  pinned: PlayerSourceRef | null;
  confidence: number;
  verdict: "auto_high" | "auto_low" | "queued" | "discarded";
  // The resolver's actual top pick, regardless of verdict — `pinned` is only set for
  // auto_high, but a caller logging agreement/disagreement with its own legacy pick
  // needs to know what the resolver would have picked even when it wasn't confident
  // enough to pin. Null only when there were zero candidates to begin with.
  bestCandidate: { externalId: string; externalSlug?: string; name: string } | null;
}

/**
 * Scores every candidate against the anchor, pins the best one if it clears the auto_high
 * bar, queues anything in the review range (auto_low/queued), and always returns the
 * legacy pick's spot in the log line via the caller (see the shadow-log line format in
 * the plan) — this function itself only handles the scoring + storage side.
 */
export async function scoreAndStore(
  internalId: number,
  anchor: CandidateAnchor,
  source: IdentitySource,
  candidates: Array<CandidateAnchor & { externalId: string; externalSlug?: string }>,
  fdId?: number
): Promise<ScoreAndStoreResult> {
  if (candidates.length === 0) {
    return { pinned: null, confidence: 0, verdict: "discarded", bestCandidate: null };
  }

  const scored = candidates.map((c) => ({
    candidate: c,
    result: scoreCandidate(anchor, c, { peers: candidates.filter((p) => p !== c), fdId }),
  }));
  scored.sort((a, b) => b.result.confidence - a.result.confidence);
  const best = scored[0];
  const bestCandidate = { externalId: best.candidate.externalId, externalSlug: best.candidate.externalSlug, name: best.candidate.name };

  // Never overwrite a manual decision with an automated one.
  const existing = await getActiveRef(internalId, source);
  if (existing && (existing.status === "manual_confirmed" || existing.status === "manual_rejected")) {
    return { pinned: existing.status === "manual_confirmed" ? existing : null, confidence: best.result.confidence, verdict: best.result.status, bestCandidate };
  }

  if (best.result.status === "auto_high") {
    const pinned = await upsertRef({
      internalId, source,
      externalId: best.candidate.externalId,
      externalSlug: best.candidate.externalSlug,
      externalName: best.candidate.name,
      confidence: best.result.confidence,
      status: "auto_high",
      matchedBy: "scoreCandidate",
      evidence: best.result.evidence,
    });
    return { pinned, confidence: best.result.confidence, verdict: "auto_high", bestCandidate };
  }

  if (best.result.status === "auto_low") {
    await upsertRef({
      internalId, source,
      externalId: best.candidate.externalId,
      externalSlug: best.candidate.externalSlug,
      externalName: best.candidate.name,
      confidence: best.result.confidence,
      status: "auto_low",
      matchedBy: "scoreCandidate",
      evidence: best.result.evidence,
    });
    await recordCandidate({
      internalId, source,
      externalId: best.candidate.externalId,
      externalSlug: best.candidate.externalSlug,
      candidateName: best.candidate.name,
      confidence: best.result.confidence,
      evidence: best.result.evidence,
    });
    return { pinned: null, confidence: best.result.confidence, verdict: "auto_low", bestCandidate };
  }

  if (best.result.status === "queued") {
    await recordCandidate({
      internalId, source,
      externalId: best.candidate.externalId,
      externalSlug: best.candidate.externalSlug,
      candidateName: best.candidate.name,
      confidence: best.result.confidence,
      evidence: best.result.evidence,
    });
    return { pinned: null, confidence: best.result.confidence, verdict: "queued", bestCandidate };
  }

  return { pinned: null, confidence: best.result.confidence, verdict: "discarded", bestCandidate };
}

export async function identityExists(internalId: number): Promise<boolean> {
  return (await getIdentity(internalId)) !== null;
}

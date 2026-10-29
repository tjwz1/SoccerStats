/**
 * Supabase CRUD for the player identity layer (migration 004_player_identity.sql).
 * Phase A only — nothing in the live app calls this yet (see resolver.ts's IDENTITY_MODE
 * gate). Mirrors the access pattern in db/supabase.ts: service-role client, no RLS
 * policies (server-only access).
 */
import { getClient } from "../../db/supabase";

export type IdentitySource =
  | "fdorg" | "sofascore" | "transfermarkt" | "thesportsdb"
  | "fpl" | "wikipedia" | "worldfootball" | "espn";

export type RefStatus = "auto_high" | "auto_low" | "manual_confirmed" | "manual_rejected";
export type CandidateStatus = "pending" | "promoted" | "rejected" | "superseded";

export interface PlayerIdentity {
  id: number;
  display_name: string;
  dob: string | null;
  nationality: string | null;
  position: string | null;
  primary_source: IdentitySource;
  created_at: string;
  updated_at: string;
}

export interface PlayerSourceRef {
  id: number;
  internal_id: number;
  source: IdentitySource;
  external_id: string | null;
  external_slug: string | null;
  external_name: string | null;
  confidence: number;
  status: RefStatus;
  matched_by: string | null;
  evidence: Record<string, unknown> | null;
  resolved_at: string;
}

export interface PlayerMatchCandidate {
  id: number;
  internal_id: number;
  source: IdentitySource;
  external_id: string | null;
  external_slug: string | null;
  candidate_name: string;
  confidence: number;
  evidence: Record<string, unknown> | null;
  status: CandidateStatus;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export async function createIdentity(fields: {
  displayName: string;
  dob?: string | null;
  nationality?: string | null;
  position?: string | null;
  primarySource: IdentitySource;
}): Promise<PlayerIdentity> {
  const { data, error } = await getClient()
    .from("player_identity")
    .insert({
      display_name: fields.displayName,
      dob: fields.dob ?? null,
      nationality: fields.nationality ?? null,
      position: fields.position ?? null,
      primary_source: fields.primarySource,
    })
    .select()
    .single();
  if (error) throw error;
  return data as PlayerIdentity;
}

export async function getIdentity(internalId: number): Promise<PlayerIdentity | null> {
  const { data, error } = await getClient()
    .from("player_identity")
    .select("*")
    .eq("id", internalId)
    .maybeSingle();
  if (error) throw error;
  return data as PlayerIdentity | null;
}

/** Active (non-rejected) ref for a given (internal_id, source), or null. */
export async function getActiveRef(internalId: number, source: IdentitySource): Promise<PlayerSourceRef | null> {
  const { data, error } = await getClient()
    .from("player_source_ref")
    .select("*")
    .eq("internal_id", internalId)
    .eq("source", source)
    .neq("status", "manual_rejected")
    .maybeSingle();
  if (error) throw error;
  return data as PlayerSourceRef | null;
}

export async function getRefBySourceId(source: IdentitySource, externalId: string): Promise<PlayerSourceRef | null> {
  const { data, error } = await getClient()
    .from("player_source_ref")
    .select("*")
    .eq("source", source)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) throw error;
  return data as PlayerSourceRef | null;
}

/**
 * Insert or replace the active ref for (internal_id, source). Manual decisions
 * (manual_confirmed / manual_rejected) are never overwritten by an automated call —
 * callers performing an automated match must check getActiveRef's status first and skip
 * writing if it's already manual_*. This function itself does not enforce that (it's a
 * thin CRUD layer); the resolver is responsible for the policy.
 */
export async function upsertRef(ref: {
  internalId: number;
  source: IdentitySource;
  externalId: string | null;
  externalSlug?: string | null;
  externalName?: string | null;
  confidence: number;
  status: RefStatus;
  matchedBy: string;
  evidence?: Record<string, unknown>;
}): Promise<PlayerSourceRef> {
  const existing = await getActiveRef(ref.internalId, ref.source);
  if (existing) {
    const { data, error } = await getClient()
      .from("player_source_ref")
      .update({
        external_id: ref.externalId,
        external_slug: ref.externalSlug ?? null,
        external_name: ref.externalName ?? null,
        confidence: ref.confidence,
        status: ref.status,
        matched_by: ref.matchedBy,
        evidence: ref.evidence ?? null,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .select()
      .single();
    if (error) throw error;
    return data as PlayerSourceRef;
  }
  const { data, error } = await getClient()
    .from("player_source_ref")
    .insert({
      internal_id: ref.internalId,
      source: ref.source,
      external_id: ref.externalId,
      external_slug: ref.externalSlug ?? null,
      external_name: ref.externalName ?? null,
      confidence: ref.confidence,
      status: ref.status,
      matched_by: ref.matchedBy,
      evidence: ref.evidence ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data as PlayerSourceRef;
}

export async function recordCandidate(candidate: {
  internalId: number;
  source: IdentitySource;
  externalId: string | null;
  externalSlug?: string | null;
  candidateName: string;
  confidence: number;
  evidence?: Record<string, unknown>;
}): Promise<PlayerMatchCandidate> {
  const { data, error } = await getClient()
    .from("player_match_candidates")
    .upsert(
      {
        internal_id: candidate.internalId,
        source: candidate.source,
        external_id: candidate.externalId,
        external_slug: candidate.externalSlug ?? null,
        candidate_name: candidate.candidateName,
        confidence: candidate.confidence,
        evidence: candidate.evidence ?? null,
        status: "pending" as CandidateStatus,
      },
      { onConflict: "internal_id,source,external_id" }
    )
    .select()
    .single();
  if (error) throw error;
  return data as PlayerMatchCandidate;
}

export async function listCandidates(filters: {
  status?: CandidateStatus;
  source?: IdentitySource;
  minScore?: number;
  limit?: number;
  offset?: number;
} = {}): Promise<PlayerMatchCandidate[]> {
  let q = getClient().from("player_match_candidates").select("*").order("confidence", { ascending: false });
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.source) q = q.eq("source", filters.source);
  if (filters.minScore !== undefined) q = q.gte("confidence", filters.minScore);
  q = q.range(filters.offset ?? 0, (filters.offset ?? 0) + (filters.limit ?? 50) - 1);
  const { data, error } = await q;
  if (error) throw error;
  return data as PlayerMatchCandidate[];
}

export async function decideCandidate(
  candidateId: number,
  decision: "promoted" | "rejected",
  decidedBy: string
): Promise<PlayerMatchCandidate> {
  const { data, error } = await getClient()
    .from("player_match_candidates")
    .update({ status: decision, decided_at: new Date().toISOString(), decided_by: decidedBy })
    .eq("id", candidateId)
    .select()
    .single();
  if (error) throw error;
  return data as PlayerMatchCandidate;
}

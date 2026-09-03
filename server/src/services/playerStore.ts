import { getClient } from "../db/supabase";
import { getAnyCached } from "../db/apiCache";
import { getPlayer } from "./footballApi";

// Assembled player payload as returned by getPlayer(). getPlayer is intentionally left
// untouched (it owns all the scraper/API retrieval logic) — this module is a persistence
// and serving layer wrapped around it.
export type PlayerPayload = Awaited<ReturnType<typeof getPlayer>>;

export interface StoredProfile {
  id: number;
  name: string;
  competition: string;
  team_id: number | null;
  data: PlayerPayload;
  complete: boolean;
  refreshed_at: string;
}

// A profile is "complete" once it carries real career data. Incomplete rows are still
// served immediately (instant reads) but are re-prioritised by the daily cron and the
// on-read stale-while-revalidate refresh until they fill in.
const CAREER_COMPLETE_THRESHOLD = 4;

function payloadHasData(d: PlayerPayload | null): boolean {
  if (!d) return false;
  const p = d as any;
  return (
    (p.career?.length ?? 0) > 0 ||
    (p.trophies?.length ?? 0) > 0 ||
    (p.currentSeason?.appearances ?? 0) > 0
  );
}

export function isPayloadComplete(d: PlayerPayload | null): boolean {
  const p = d as any;
  return payloadHasData(d) && (p?.career?.length ?? 0) >= CAREER_COMPLETE_THRESHOLD;
}

// ── Read ────────────────────────────────────────────────────────────────────

export async function getStoredProfile(id: number): Promise<StoredProfile | null> {
  try {
    const { data, error } = await getClient()
      .from("player_profiles")
      .select("id, name, competition, team_id, data, complete, refreshed_at")
      .eq("id", id)
      .maybeSingle();

    if (!error && data) return data as StoredProfile;
  } catch {
    /* fall through to legacy migration */
  }

  // One-time migration path: a player visited before this table existed still has an
  // assembled blob in api_cache under player_response:<id>. Serve it now and copy it
  // into player_profiles so the next read is a direct hit.
  try {
    const legacy = await getAnyCached(`player_response:${id}`);
    const payload = legacy?.data as PlayerPayload | undefined;
    if (payload && payloadHasData(payload)) {
      const row = await saveProfile(id, (payload as any).competition ?? "PL", payload, null);
      return row;
    }
  } catch {
    /* ignore */
  }

  return null;
}

export async function getProfileRefreshMeta(
  ids: number[]
): Promise<Map<number, { refreshed_at: string; complete: boolean }>> {
  const map = new Map<number, { refreshed_at: string; complete: boolean }>();
  if (ids.length === 0) return map;
  try {
    const client = getClient();
    for (let i = 0; i < ids.length; i += 300) {
      const chunk = ids.slice(i, i + 300);
      const { data, error } = await client
        .from("player_profiles")
        .select("id, refreshed_at, complete")
        .in("id", chunk);
      if (error || !data) continue;
      for (const r of data) {
        map.set(r.id as number, {
          refreshed_at: r.refreshed_at as string,
          complete: r.complete as boolean,
        });
      }
    }
  } catch {
    /* return whatever we have */
  }
  return map;
}

// ── Write ───────────────────────────────────────────────────────────────────

async function saveProfile(
  id: number,
  competition: string,
  data: PlayerPayload,
  teamId: number | null
): Promise<StoredProfile> {
  const row: StoredProfile = {
    id,
    name: (data as any)?.name ?? "",
    competition,
    team_id: teamId,
    data,
    complete: isPayloadComplete(data),
    refreshed_at: new Date().toISOString(),
  };
  try {
    // Don't clobber a known team_id with null on a refresh that didn't supply one.
    const upsertRow = teamId == null ? { ...row, team_id: undefined } : row;
    const { error } = await getClient()
      .from("player_profiles")
      .upsert(upsertRow as any, { onConflict: "id" });
    if (error) console.error("[playerStore] upsert failed:", error.message);
  } catch (e) {
    console.error("[playerStore] upsert failed:", (e as Error).message);
  }
  return row;
}

// Deduplicates concurrent refreshes for the same player so the first-visit foreground
// wait, its background continuation, and a quick client retry all share one getPlayer() run.
const inflight = new Map<number, Promise<PlayerPayload | null>>();

/**
 * Re-run the assembly pipeline for one player and persist the result.
 * Never rejects — returns null on failure so callers can race it against a timeout safely.
 */
export function refreshPlayerProfile(
  id: number,
  competition = "PL",
  teamId?: number | null
): Promise<PlayerPayload | null> {
  const existing = inflight.get(id);
  if (existing) return existing;

  const run = (async () => {
    try {
      const data = await getPlayer(String(id), competition);
      if (data) await saveProfile(id, competition, data, teamId ?? null);
      return data ?? null;
    } catch (e) {
      console.error(`[playerStore] refresh failed for ${id}:`, (e as Error).message);
      return null;
    } finally {
      inflight.delete(id);
    }
  })();

  inflight.set(id, run);
  return run;
}

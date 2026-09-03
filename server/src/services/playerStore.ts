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

// Minimal, client-renderable PlayerDetail used while the real career history is still being
// assembled. The `pending` flag tells the client to keep polling; the read route also kicks
// a background refresh whenever it serves one of these.
export function buildPendingPayload(id: number, name = ""): PlayerPayload {
  return {
    id,
    name,
    photo: null,
    currentSeason: { appearances: 0, goals: 0, assists: 0, minutesPlayed: 0 },
    career: [],
    totals: { appearances: 0, goals: 0, assists: 0 },
    trophies: [],
    pending: true,
  } as unknown as PlayerPayload;
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

export interface ProfileLite {
  id: number;
  team_id: number | null;
  competition: string;
  refreshed_at: string;
  complete: boolean;
}

// Lightweight listing of every stored profile — the daily refresh job seeds its candidate
// set from this (no external calls) before optionally discovering new players from squads.
export async function listStoredProfiles(): Promise<ProfileLite[]> {
  const out: ProfileLite[] = [];
  try {
    const client = getClient();
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client
        .from("player_profiles")
        .select("id, team_id, competition, refreshed_at, complete")
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      for (const r of data) {
        out.push({
          id: r.id as number,
          team_id: (r.team_id as number | null) ?? null,
          competition: (r.competition as string) ?? "PL",
          refreshed_at: r.refreshed_at as string,
          complete: r.complete as boolean,
        });
      }
      if (data.length < PAGE) break;
    }
  } catch {
    /* return whatever we have */
  }
  return out;
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

// Insert placeholder rows for players discovered from a squad walk but not yet assembled.
// `ignoreDuplicates` means existing real rows are never touched. Skeletons carry a `pending`
// payload and an epoch `refreshed_at` so they (a) seed future refresh runs without another
// squad walk, (b) render name + team instantly on first visit instead of a bare spinner, and
// (c) sort to the front of the refresh queue. Returns the count actually inserted.
export async function saveSkeletonProfiles(
  entries: Array<{ id: number; name: string; teamId: number | null; competition: string }>
): Promise<number> {
  if (entries.length === 0) return 0;
  const rows = entries.map((e) => ({
    id: e.id,
    name: e.name,
    competition: e.competition,
    team_id: e.teamId,
    data: buildPendingPayload(e.id, e.name),
    complete: false,
    refreshed_at: new Date(0).toISOString(),
  }));
  let inserted = 0;
  try {
    const client = getClient();
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { data, error } = await client
        .from("player_profiles")
        .upsert(chunk as any, { onConflict: "id", ignoreDuplicates: true })
        .select("id");
      if (error) {
        console.error("[playerStore] skeleton upsert failed:", error.message);
        continue;
      }
      inserted += data?.length ?? 0;
    }
  } catch (e) {
    console.error("[playerStore] skeleton upsert failed:", (e as Error).message);
  }
  return inserted;
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

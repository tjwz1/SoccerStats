import { getClient } from "./supabase";

// undefined = not in cache (never looked up)
// null      = cached negative (looked up, no photo found)
// string    = photo URL
const NULL_PHOTO_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // re-fetch failed lookups after 7 days
const PHOTO_TTL_MS      = 90 * 24 * 60 * 60 * 1000; // re-fetch successful lookups after 90 days

function readRow(data: { photo_url: string | null; fetched_at: string } | null): string | null | undefined {
  if (!data) return undefined;
  const age = Date.now() - new Date(data.fetched_at).getTime();
  if (data.photo_url === null && age > NULL_PHOTO_TTL_MS) return undefined; // re-fetch negatives after 7d
  if (data.photo_url !== null && age > PHOTO_TTL_MS)     return undefined; // re-fetch positives after 90d
  return data.photo_url;
}

// Identity layer Phase D: `player_name` is this table's actual primary key (confirmed live —
// two rows can never share a name), so this does not fix namesake collisions; that would need
// replacing the PK itself, a bigger migration not done in this pass. What this does fix: name
// drift for the SAME real person (a source recording their name slightly differently over
// time) — checking internal_id first can find their existing cached photo under an old name
// variant instead of re-fetching. Falls back to the name-based lookup (today's exact
// behavior) when internalId is absent or no row has been tagged with it yet.
export async function getPhoto(name: string, internalId?: number | null): Promise<string | null | undefined> {
  if (internalId != null) {
    const { data, error } = await getClient()
      .from("player_photos")
      .select("photo_url, fetched_at")
      .eq("internal_id", internalId)
      .maybeSingle();
    if (!error && data) return readRow(data as { photo_url: string | null; fetched_at: string });
  }

  const { data, error } = await getClient()
    .from("player_photos")
    .select("photo_url, fetched_at")
    .eq("player_name", name)
    .maybeSingle();

  if (error) return undefined;
  return readRow(data as { photo_url: string | null; fetched_at: string } | null);
}

// Always upserts on player_name (the real PK) — internal_id is stamped as metadata on that
// same row, not used as the conflict target (there's no unique constraint on it, and there
// can't safely be one without also relaxing the player_name PK — see getPhoto's comment).
export async function setPhoto(name: string, url: string | null, internalId?: number | null): Promise<void> {
  const { error } = await getClient()
    .from("player_photos")
    .upsert(
      {
        player_name: name,
        photo_url: url,
        fetched_at: new Date().toISOString(),
        internal_id: internalId ?? null,
      },
      { onConflict: "player_name" }
    );
  if (error) console.error("[photoCache] write failed:", error.message);
}

import { getClient } from "./supabase";

// undefined = not in cache (never looked up)
// null      = cached negative (looked up, no photo found)
// string    = photo URL
const NULL_PHOTO_TTL_MS = 7 * 24 * 60 * 60 * 1000; // re-fetch failed lookups after 7 days

export async function getPhoto(name: string): Promise<string | null | undefined> {
  const { data, error } = await getClient()
    .from("player_photos")
    .select("photo_url, fetched_at")
    .eq("player_name", name)
    .maybeSingle();

  if (error) return undefined;
  if (!data) return undefined;

  // Null entries expire — TheSportsDB coverage improves over time
  if (data.photo_url === null) {
    const age = Date.now() - new Date(data.fetched_at as string).getTime();
    if (age > NULL_PHOTO_TTL_MS) return undefined;
  }

  return data.photo_url as string | null;
}

export async function setPhoto(name: string, url: string | null): Promise<void> {
  const { error } = await getClient()
    .from("player_photos")
    .upsert({
      player_name: name,
      photo_url: url,
      fetched_at: new Date().toISOString(),
    });
  if (error) console.error("[photoCache] write failed:", error.message);
}

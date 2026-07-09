import { getClient } from "./supabase";

export interface Trophy {
  name: string;
  team: string;
  category: "club" | "international" | "individual";
  years: string[];
}

const TM_CUP_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export async function getWikiTrophies(playerId: number): Promise<Trophy[] | null> {
  try {
    const { data, error } = await getClient()
      .from("players")
      .select("trophies")
      .eq("id", playerId)
      .maybeSingle();

    if (error || !data || !data.trophies) return null;
    const trophies = data.trophies as Trophy[];
    return trophies.length > 0 ? trophies : null;
  } catch {
    return null;
  }
}

export async function setWikiTrophies(
  playerId: number,
  playerName: string,
  trophies: Trophy[]
): Promise<void> {
  if (trophies.length === 0) return;
  try {
    const { error } = await getClient()
      .from("players")
      .upsert(
        {
          id: playerId,
          name: playerName,
          trophies,
          trophies_fetched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );

    if (error) console.error("[playerCache] trophies write failed:", error.message);
  } catch (e: unknown) {
    console.error("[playerCache] trophies write failed:", (e as Error).message);
  }
}

export async function getTmCupChecked(playerId: number): Promise<boolean> {
  try {
    const { data, error } = await getClient()
      .from("players")
      .select("tm_cup_checked_at")
      .eq("id", playerId)
      .maybeSingle();

    if (error || !data?.tm_cup_checked_at) return false;
    const age = Date.now() - new Date(data.tm_cup_checked_at as string).getTime();
    return age < TM_CUP_CHECK_TTL_MS;
  } catch {
    return false;
  }
}

export async function setTmCupChecked(playerId: number): Promise<void> {
  try {
    await getClient()
      .from("players")
      .update({ tm_cup_checked_at: new Date().toISOString() })
      .eq("id", playerId);
  } catch {
    // best-effort
  }
}

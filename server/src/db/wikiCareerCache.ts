import { getClient } from "./supabase";

export interface WikiCareerRow {
  season: string;
  team: string;
  league: string;
  appearances: number;
  goals: number;
  assists: number;
}

export async function getWikiStats(playerId: number): Promise<WikiCareerRow[] | null> {
  try {
    const { data, error } = await getClient()
      .from("player_seasons")
      .select("season, team_name, competition, appearances, goals, assists")
      .eq("player_id", playerId);

    if (error || !data || data.length === 0) return null;
    return data.map((r) => ({
      season: r.season as string,
      team: (r.team_name as string) ?? "",
      league: r.competition as string,
      appearances: r.appearances as number,
      goals: r.goals as number,
      assists: r.assists as number,
    }));
  } catch {
    return null;
  }
}

// Batch lookup — single Supabase query for an entire squad.
// Returns a map of playerId → rows (only players with cached data are included).
export async function getWikiStatsBatch(playerIds: number[]): Promise<Map<number, WikiCareerRow[]>> {
  if (playerIds.length === 0) return new Map();
  try {
    const { data, error } = await getClient()
      .from("player_seasons")
      .select("player_id, season, team_name, competition, appearances, goals, assists")
      .in("player_id", playerIds);

    const map = new Map<number, WikiCareerRow[]>();
    if (error || !data) return map;

    for (const row of data) {
      const id = row.player_id as number;
      const entry: WikiCareerRow = {
        season: row.season as string,
        team: (row.team_name as string) ?? "",
        league: row.competition as string,
        appearances: row.appearances as number,
        goals: row.goals as number,
        assists: row.assists as number,
      };
      const existing = map.get(id) ?? [];
      existing.push(entry);
      map.set(id, existing);
    }
    return map;
  } catch {
    return new Map();
  }
}

export async function setWikiStats(
  playerId: number,
  playerName: string,
  rows: WikiCareerRow[]
): Promise<void> {
  if (rows.length === 0) return;
  try {
    // Ensure the player row exists — player_seasons FKs reference it.
    // ignoreDuplicates preserves existing name/trophies on repeated calls.
    await getClient()
      .from("players")
      .upsert(
        { id: playerId, name: playerName, updated_at: new Date().toISOString() },
        { onConflict: "id", ignoreDuplicates: false }
      );

    const { error } = await getClient()
      .from("player_seasons")
      .upsert(
        rows.map((r) => ({
          player_id: playerId,
          competition: r.league,
          season: r.season,
          team_name: r.team,
          appearances: r.appearances,
          goals: r.goals,
          assists: r.assists,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "player_id,competition,season" }
      );

    if (error) console.error("[playerSeasons] write failed:", error.message);
  } catch (e: unknown) {
    console.error("[playerSeasons] write failed:", (e as Error).message);
  }
}

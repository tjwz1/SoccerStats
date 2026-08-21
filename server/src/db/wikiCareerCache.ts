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

// Delete cached career rows for players whose assists look wrong from the old broken parser:
// goals >= 10 across all rows but assists = 0 across all rows, with 3+ seasons cached.
// Safe to run after the findStatCols fix — re-scrape on next profile visit will store
// correct values. Goalkeepers (goals=0, assists=0) are unaffected by the goals >= 10 guard.
export async function clearStaleAssists(): Promise<{ deleted: number }> {
  try {
    const client = getClient();
    // Identify player_ids with the broken-parser signature.
    const { data: suspects, error: selErr } = await client
      .from("player_seasons")
      .select("player_id, goals, assists")
      .gte("goals", 0);

    if (selErr || !suspects) return { deleted: 0 };

    // Aggregate in JS (Supabase free tier has no GROUP BY in REST API).
    const totals = new Map<number, { goals: number; assists: number; seasons: number }>();
    for (const r of suspects) {
      const id = r.player_id as number;
      const t = totals.get(id) ?? { goals: 0, assists: 0, seasons: 0 };
      t.goals   += r.goals   as number;
      t.assists += r.assists as number;
      t.seasons += 1;
      totals.set(id, t);
    }

    const staleIds = [...totals.entries()]
      .filter(([, t]) => t.goals >= 10 && t.assists === 0 && t.seasons >= 3)
      .map(([id]) => id);

    if (staleIds.length === 0) return { deleted: 0 };

    const { error: delErr } = await client
      .from("player_seasons")
      .delete()
      .in("player_id", staleIds);

    if (delErr) {
      console.error("[clearStaleAssists] delete failed:", delErr.message);
      return { deleted: 0 };
    }
    return { deleted: staleIds.length };
  } catch (e: unknown) {
    console.error("[clearStaleAssists] failed:", (e as Error).message);
    return { deleted: 0 };
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

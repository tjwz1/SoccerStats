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

// Detects a broken/fragmentary cached-career signature. Three patterns:
//   1. goals >= 10, assists = 0, seasons >= 3 (parser found no assists at all)
//   2. goals >= 200, assists <= 20, seasons >= 8 (parser found some but far too few —
//      e.g. Messi showing 13 assists, Mbappé showing 7, despite hundreds of real assists)
//   3. rows.length <= 2 and every row is a blank 0-goal/0-assist stub — the signature left by
//      a mostly-failed source fetch (e.g. SofaScore rate-limited mid-fetch) that still returned
//      one or two rows, which then get cached as if they were the player's whole career. A
//      real player's cached history is essentially never just 1-2 all-zero rows once they have
//      a "current team" (the only reason this gets checked at all — see needsSofaRefresh).
// Goalkeepers with many all-zero rows are unaffected by patterns 1/2 (goals >= 10 guard) and
// by pattern 3 once they have more than 2 cached rows, which any real keeper accumulates fast.
export function hasStaleAssistSignature(rows: WikiCareerRow[]): boolean {
  const totals = rows.reduce(
    (acc, r) => ({ goals: acc.goals + r.goals, assists: acc.assists + r.assists, seasons: acc.seasons + 1 }),
    { goals: 0, assists: 0, seasons: 0 }
  );
  return (
    (totals.goals >= 10 && totals.assists === 0 && totals.seasons >= 3) ||
    (totals.goals >= 200 && totals.assists <= 20 && totals.seasons >= 8) ||
    (rows.length > 0 && rows.length <= 2 && totals.goals === 0 && totals.assists === 0)
  );
}

// Delete cached career rows for players whose assists look wrong from the old broken parser.
// Safe to run after the findStatCols fix — re-scrape on next profile visit will store
// correct values.
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
    const rowsById = new Map<number, WikiCareerRow[]>();
    for (const r of suspects) {
      const id = r.player_id as number;
      const list = rowsById.get(id) ?? [];
      list.push({ season: "", team: "", league: "", appearances: 0, goals: r.goals as number, assists: r.assists as number });
      rowsById.set(id, list);
    }

    const staleIds = [...rowsById.entries()]
      .filter(([, rows]) => hasStaleAssistSignature(rows))
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

export async function clearAllPlayerCareer(): Promise<{ deleted: number }> {
  try {
    const { data, error } = await getClient()
      .from("player_seasons")
      .delete()
      .neq("player_id", 0)
      .select("player_id");
    if (error) {
      console.error("[clearAllPlayerCareer] failed:", error.message);
      return { deleted: 0 };
    }
    return { deleted: data?.length ?? 0 };
  } catch (e: unknown) {
    console.error("[clearAllPlayerCareer] failed:", (e as Error).message);
    return { deleted: 0 };
  }
}

export async function clearPlayerCareer(playerIds: number[]): Promise<{ deleted: number }> {
  if (playerIds.length === 0) return { deleted: 0 };
  try {
    const { error } = await getClient().from("player_seasons").delete().in("player_id", playerIds);
    if (error) {
      console.error("[clearPlayerCareer] failed:", error.message);
      return { deleted: 0 };
    }
    return { deleted: playerIds.length };
  } catch (e: unknown) {
    console.error("[clearPlayerCareer] failed:", (e as Error).message);
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

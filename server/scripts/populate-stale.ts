/**
 * Populate SofaScore career data for all players with stale / missing career history.
 *
 * SofaScore is inaccessible from Vercel's cloud IPs, so this must run locally.
 * It writes results to Supabase (player_seasons + api_cache), which Vercel then
 * reads on the next player page visit — no SofaScore call needed from the server.
 *
 * Two detection passes:
 *   1. player_seasons rows with a stale assist-/season- signature
 *   2. api_cache player_response:* entries with career.length < STALE_CAREER_THRESHOLD
 *      (catches players whose player_seasons was cleared but player_response still cached)
 *
 * Usage (from server/):
 *   npx ts-node --project scripts/tsconfig.json --transpile-only scripts/populate-stale.ts
 *
 * Target specific player IDs only:
 *   npx ts-node --project scripts/tsconfig.json --transpile-only scripts/populate-stale.ts 3331 3257
 */
import { config } from "dotenv";
import path from "path";
config({ path: path.resolve(__dirname, "../.env") });

import { getClient } from "../src/db/supabase";
import {
  hasStaleAssistSignature,
  setWikiStats,
  type WikiCareerRow,
} from "../src/db/wikiCareerCache";
import { fetchSofaScoreCareer } from "../src/services/sofaScoreCareer";
import { deleteCached } from "../src/db/apiCache";

// Players with fewer than this many career rows in their cached response are considered stale
const STALE_CAREER_THRESHOLD = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const sb = getClient();

  // Optional: filter to specific player IDs passed as CLI args
  const targetIds = process.argv.slice(2).map(Number).filter(Boolean);

  const staleSet = new Set<number>();

  if (targetIds.length > 0) {
    for (const id of targetIds) staleSet.add(id);
  } else {
    // ── Pass 1: scan player_seasons for stale signatures ──────────────────────
    console.log("Pass 1: scanning player_seasons for stale signatures...");
    const { data: seasons, error: e1 } = await sb
      .from("player_seasons")
      .select("player_id, season, goals, assists, appearances");

    if (e1) {
      console.error("Failed to fetch player_seasons:", e1.message);
    } else {
      const byPlayer = new Map<number, WikiCareerRow[]>();
      for (const r of seasons ?? []) {
        const id = r.player_id as number;
        const list = byPlayer.get(id) ?? [];
        list.push({
          season: r.season as string,
          team: "",
          league: "",
          appearances: r.appearances as number,
          goals: r.goals as number,
          assists: r.assists as number,
        });
        byPlayer.set(id, list);
      }
      for (const [id, rows] of byPlayer) {
        if (hasStaleAssistSignature(rows)) staleSet.add(id);
      }
      console.log(
        `  → ${staleSet.size} stale from ${byPlayer.size} players in player_seasons`
      );
    }

    // ── Pass 2: scan api_cache for player_response entries with low career counts ─
    console.log(
      `Pass 2: scanning api_cache for player_response entries with career < ${STALE_CAREER_THRESHOLD}...`
    );
    const { data: cached, error: e2 } = await sb
      .from("api_cache")
      .select("path, data")
      .like("path", "player_response:%");

    if (e2) {
      console.error("Failed to fetch api_cache:", e2.message);
    } else {
      let cacheStale = 0;
      for (const row of cached ?? []) {
        const p = row.path as string;
        const id = Number(p.replace("player_response:", ""));
        if (!id || isNaN(id)) continue;
        const career: unknown[] = (row.data as any)?.career ?? [];
        if (career.length < STALE_CAREER_THRESHOLD) {
          staleSet.add(id);
          cacheStale++;
        }
      }
      console.log(`  → ${cacheStale} additional stale from api_cache player_response entries`);
    }
  }

  console.log(`\nTotal stale players to populate: ${staleSet.size}`);
  if (staleSet.size === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  // ── Fetch player names ────────────────────────────────────────────────────────
  const staleIds = [...staleSet];
  const { data: players } = await sb
    .from("players")
    .select("id, name")
    .in("id", staleIds);

  const nameMap = new Map<number, string>();
  for (const p of players ?? []) nameMap.set(p.id as number, p.name as string);

  // ── Populate each player from SofaScore ──────────────────────────────────────
  let success = 0;
  let skipped = 0;

  for (let i = 0; i < staleIds.length; i++) {
    const id = staleIds[i];
    const name = nameMap.get(id);

    if (!name) {
      console.log(`[${i + 1}/${staleIds.length}] Player ${id} — no name in DB, skipping`);
      skipped++;
      continue;
    }

    process.stdout.write(`[${i + 1}/${staleIds.length}] ${name} (${id})... `);

    // Delete stale ss-career cache so fetchSofaScoreCareer re-fetches from SofaScore
    await deleteCached(`/ss-career/${id}`);

    const rows = await fetchSofaScoreCareer(name, id);

    if (rows.length === 0) {
      console.log(`no SofaScore data`);
      skipped++;
    } else {
      await setWikiStats(id, name, rows);
      // Delete stale player_response so Vercel assembles fresh on next visit
      await deleteCached(`player_response:${id}`);
      console.log(`${rows.length} rows stored`);
      success++;
    }

    // Brief pause between players to respect SofaScore rate limits
    if (i < staleIds.length - 1) await sleep(2500);
  }

  console.log(`\nDone. ${success} populated, ${skipped} skipped / no data.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

/**
 * Phase A backfill for the player identity layer (migration 004_player_identity.sql).
 * Local only, no live network calls: builds player_identity rows from the already-stored
 * player_profiles table (fd.org is the anchor source, confidence 1.0 by construction),
 * and imports the two existing per-player foreign-source signals already in Supabase —
 * players.tm_ref and the /ss-player-id/{fdId} api_cache rows — as legacy_import refs at
 * 0.70 confidence (auto_low: not trusted enough to use outright, but recorded and
 * available for later re-scoring once real bio evidence is fetched).
 *
 * Usage (from server/):
 *   npx ts-node --project scripts/tsconfig.json --transpile-only scripts/identity-backfill.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json --transpile-only scripts/identity-backfill.ts --dry-run --leagues=PD,SA
 *   npx ts-node --project scripts/tsconfig.json --transpile-only scripts/identity-backfill.ts --apply   (writes for real)
 *
 * --rescore is deliberately NOT implemented here: re-scoring a legacy ref against real
 * bio evidence needs a live TM/SofaScore profile fetch, which is out of scope for a
 * local-only, no-network Phase A pass. That's Phase B (shadow mode) work.
 */
import { config } from "dotenv";
import path from "path";
config({ path: path.resolve(__dirname, "../.env") });

import fs from "fs";
import { getClient } from "../src/db/supabase";
import { createIdentity, upsertRef } from "../src/services/identity/identityStore";
import { normalizeName } from "../src/services/identity/nameMatch";

const LOCK_FILE = path.resolve(__dirname, ".identity-backfill.lock");

const BIG_5 = ["PL", "PD", "BL1", "SA", "FL1"];

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--apply"); // default: dry-run unless --apply is explicit
  const leaguesArg = args.find((a) => a.startsWith("--leagues="));
  const leagues = leaguesArg ? leaguesArg.split("=")[1].split(",").map((s) => s.trim()) : BIG_5;
  const concurrencyArg = args.find((a) => a.startsWith("--concurrency="));
  const concurrency = concurrencyArg ? Number(concurrencyArg.split("=")[1]) : 15;
  return { dryRun, leagues, concurrency };
}

// Each player is independent (a brand-new internal_id, never shared across players), so
// processing several in parallel is safe — no row contention between workers. Measured
// ~213ms/round-trip to Supabase from a local dev machine and ~9-10 sequential calls per
// player made a one-shot --apply run take ~90 minutes at concurrency 1; this cuts it to
// roughly concurrency-many times faster.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface ProfileRow {
  id: number;
  name: string;
  competition: string;
  team_id: number | null;
  data: any;
  tm_ref: unknown;
}

async function fetchProfiles(client: ReturnType<typeof getClient>, leagues: string[]): Promise<ProfileRow[]> {
  const out: ProfileRow[] = [];
  const PAGE = 1000;
  for (const league of leagues) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client
        .from("player_profiles")
        .select("id,name,competition,team_id,data")
        .eq("competition", league)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) out.push({ ...(r as any), tm_ref: undefined });
      if (data.length < PAGE) break;
    }
  }

  // Merge in players.tm_ref for the same ids, one query.
  const ids = out.map((r) => r.id);
  const CHUNK = 500;
  const tmRefById = new Map<number, unknown>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await client.from("players").select("id,tm_ref").in("id", chunk);
    if (error) throw error;
    for (const r of data ?? []) tmRefById.set(r.id as number, (r as any).tm_ref);
  }
  for (const r of out) r.tm_ref = tmRefById.get(r.id) ?? null;

  return out;
}

async function fetchSsPlayerIds(client: ReturnType<typeof getClient>, fdIds: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  const CHUNK = 200;
  for (let i = 0; i < fdIds.length; i += CHUNK) {
    const chunk = fdIds.slice(i, i + CHUNK);
    const paths = chunk.map((id) => `/ss-player-id/${id}`);
    const { data, error } = await client.from("api_cache").select("path,data").in("path", paths);
    if (error) throw error;
    for (const row of data ?? []) {
      const fdId = Number((row.path as string).split("/").pop());
      const ssId = (row.data as any)?.ssId;
      if (Number.isFinite(fdId) && ssId) result.set(fdId, ssId);
    }
  }
  return result;
}

async function main() {
  const { dryRun, leagues, concurrency } = parseArgs();
  console.log(`Identity backfill — ${dryRun ? "DRY RUN (no writes)" : "APPLYING"} — leagues: ${leagues.join(", ")}${dryRun ? "" : ` — concurrency ${concurrency}`}`);

  // Guards against two overlapping invocations (e.g. a second --apply started before the
  // first finished) racing on the same (fdorg, external_id) inserts — exactly what crashed
  // an earlier run with a 23505 unique-violation on a mid-run player.
  if (!dryRun) {
    if (fs.existsSync(LOCK_FILE)) {
      console.error(`Another --apply run appears to be in progress (lock file ${LOCK_FILE} exists). If that's stale (a previous run crashed without cleaning up), delete it and retry.`);
      process.exit(1);
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    process.on("exit", () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });
  }

  const client = getClient();
  const profiles = await fetchProfiles(client, leagues);
  console.log(`\nFound ${profiles.length} stored player_profiles rows for these leagues.`);

  const ssIdByFdId = await fetchSsPlayerIds(client, profiles.map((p) => p.id));

  // Resumability: skip any player who already has an active fdorg ref (from an earlier,
  // partially-completed --apply run) instead of redoing — and failing on — that work.
  const alreadyLinked = new Set<string>();
  if (!dryRun) {
    const ids = profiles.map((p) => String(p.id));
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const { data, error } = await client
        .from("player_source_ref")
        .select("external_id")
        .eq("source", "fdorg")
        .neq("status", "manual_rejected")
        .in("external_id", chunk);
      if (error) throw error;
      for (const row of data ?? []) alreadyLinked.add(row.external_id as string);
    }
    if (alreadyLinked.size > 0) {
      console.log(`${alreadyLinked.size} player(s) already have an identity from a previous run — skipping those.`);
    }
  }

  let identitiesCreated = 0;
  let tmRefsImported = 0;
  let ssRefsImported = 0;
  let skippedNoName = 0;
  let skippedAlreadyLinked = 0;
  const dataConflicts: string[] = [];
  let done = 0;
  const LEGACY_CONFIDENCE = 0.70;

  async function processOne(p: ProfileRow): Promise<void> {
    const name = p.data?.name || p.name;
    if (!name) { skippedNoName++; return; }
    if (alreadyLinked.has(String(p.id))) { skippedAlreadyLinked++; return; }

    const dob: string | null = p.data?.dateOfBirth ? String(p.data.dateOfBirth).slice(0, 10) : null;
    const nationality: string | null = p.data?.nationality ?? null;
    const position: string | null = p.data?.position ?? null;

    let internalId: number | null = null;
    if (!dryRun) {
      const identity = await createIdentity({
        displayName: name, dob, nationality, position, primarySource: "fdorg",
      });
      try {
        await upsertRef({
          internalId: identity.id, source: "fdorg", externalId: String(p.id),
          externalName: name, confidence: 1, status: "manual_confirmed", matchedBy: "anchor",
        });
      } catch (e: any) {
        // Someone else (a concurrent worker, or a previous crashed run we didn't know
        // about) already claimed this external_id — drop the orphan identity we just
        // created and skip the rest of this player rather than crash the whole batch.
        if (e?.code === "23505") {
          await client.from("player_identity").delete().eq("id", identity.id);
          skippedAlreadyLinked++;
          return;
        }
        throw e;
      }
      internalId = identity.id;
      await Promise.all([
        client.from("player_profiles").update({ internal_id: identity.id }).eq("id", p.id),
        client.from("players").update({ internal_id: identity.id }).eq("id", p.id),
        client.from("player_seasons").update({ internal_id: identity.id }).eq("player_id", p.id),
      ]);
    }
    identitiesCreated++;

    // A legacy ref write can conflict on (source, external_id) when two different fd.org
    // players were matched to the same Transfermarkt/SofaScore id by the old ad hoc
    // heuristic (a real data-quality bug, not a script bug — confirmed live: fd.org ids
    // 99775 "Jeremy Doku" and 215510 "Jeremy" both carry tm_ref id 486049). Log and skip
    // that one ref rather than crash the whole run; it's exactly the kind of conflict the
    // review queue exists for, surfaced here instead of silently importing a wrong link.
    async function tryUpsertLegacyRef(args: Parameters<typeof upsertRef>[0]): Promise<void> {
      try {
        await upsertRef(args);
      } catch (e: any) {
        if (e?.code === "23505") {
          dataConflicts.push(`${args.source} external_id=${args.externalId} also claimed by another player (skipped for ${name}, fd.org id ${p.id})`);
          return;
        }
        throw e;
      }
    }

    const refWrites: Promise<unknown>[] = [];

    const tmRefVal = p.tm_ref;
    if (tmRefVal && typeof tmRefVal === "object" && (tmRefVal as any).id) {
      tmRefsImported++;
      if (!dryRun && internalId) {
        refWrites.push(tryUpsertLegacyRef({
          internalId, source: "transfermarkt",
          externalId: String((tmRefVal as any).id),
          externalSlug: (tmRefVal as any).slug ?? null,
          confidence: LEGACY_CONFIDENCE, status: "auto_low", matchedBy: "legacy_import",
        }));
      }
    }

    const ssId = ssIdByFdId.get(p.id);
    if (ssId) {
      ssRefsImported++;
      if (!dryRun && internalId) {
        refWrites.push(tryUpsertLegacyRef({
          internalId, source: "sofascore",
          externalId: String(ssId),
          confidence: LEGACY_CONFIDENCE, status: "auto_low", matchedBy: "legacy_import",
        }));
      }
    }

    if (refWrites.length) await Promise.all(refWrites);

    done++;
    if (!dryRun && done % 200 === 0) console.log(`  ...${done}/${profiles.length} players processed`);
  }

  await mapWithConcurrency(profiles, dryRun ? 1 : concurrency, processOne);

  // Photos: link only where the normalised name is unique within the fetched set — a
  // shared name among these players means we can't safely tell which photo belongs to
  // which identity without more evidence, so leave those unlinked for a later pass.
  const nameGroups = new Map<string, ProfileRow[]>();
  for (const p of profiles) {
    const norm = normalizeName(p.data?.name || p.name || "");
    if (!norm) continue;
    const g = nameGroups.get(norm) ?? [];
    g.push(p);
    nameGroups.set(norm, g);
  }
  const uniqueNamePlayers = [...nameGroups.values()].filter((g) => g.length === 1).length;
  const ambiguousNameGroups = [...nameGroups.values()].filter((g) => g.length > 1);

  console.log(`\n=== Results ===`);
  console.log(`identities ${dryRun ? "that would be " : ""}created: ${identitiesCreated}`);
  console.log(`  skipped (no name): ${skippedNoName}`);
  console.log(`  skipped (already linked from an earlier run): ${skippedAlreadyLinked}`);
  console.log(`tm_ref legacy refs ${dryRun ? "that would be " : ""}imported: ${tmRefsImported}`);
  console.log(`sofascore legacy refs ${dryRun ? "that would be " : ""}imported: ${ssRefsImported}`);
  console.log(`\nphoto linkability: ${uniqueNamePlayers} players have a unique name in this set (safely linkable)`);
  console.log(`  ${ambiguousNameGroups.length} name(s) are shared by 2+ players in this set (left unlinked):`);
  for (const g of ambiguousNameGroups.slice(0, 10)) {
    console.log(`    "${g[0].data?.name || g[0].name}": ids ${g.map((p) => p.id).join(", ")}`);
  }
  if (ambiguousNameGroups.length > 10) console.log(`    ...and ${ambiguousNameGroups.length - 10} more`);

  if (dataConflicts.length > 0) {
    console.log(`\n${dataConflicts.length} legacy ref(s) skipped due to a pre-existing data conflict (two fd.org players sharing one TM/SofaScore id) — worth a manual look:`);
    for (const c of dataConflicts.slice(0, 20)) console.log(`    ${c}`);
    if (dataConflicts.length > 20) console.log(`    ...and ${dataConflicts.length - 20} more`);
  }

  if (dryRun) {
    console.log(`\nDry run only — nothing was written. Re-run with --apply to write for real.`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

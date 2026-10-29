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

import { getClient } from "../src/db/supabase";
import { createIdentity, upsertRef } from "../src/services/identity/identityStore";
import { normalizeName } from "../src/services/identity/nameMatch";

const BIG_5 = ["PL", "PD", "BL1", "SA", "FL1"];

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--apply"); // default: dry-run unless --apply is explicit
  const leaguesArg = args.find((a) => a.startsWith("--leagues="));
  const leagues = leaguesArg ? leaguesArg.split("=")[1].split(",").map((s) => s.trim()) : BIG_5;
  return { dryRun, leagues };
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
  const { dryRun, leagues } = parseArgs();
  console.log(`Identity backfill — ${dryRun ? "DRY RUN (no writes)" : "APPLYING"} — leagues: ${leagues.join(", ")}`);

  const client = getClient();
  const profiles = await fetchProfiles(client, leagues);
  console.log(`\nFound ${profiles.length} stored player_profiles rows for these leagues.`);

  const ssIdByFdId = await fetchSsPlayerIds(client, profiles.map((p) => p.id));

  let identitiesCreated = 0;
  let tmRefsImported = 0;
  let ssRefsImported = 0;
  let skippedNoName = 0;
  const LEGACY_CONFIDENCE = 0.70;

  for (const p of profiles) {
    const name = p.data?.name || p.name;
    if (!name) { skippedNoName++; continue; }

    const dob: string | null = p.data?.dateOfBirth ? String(p.data.dateOfBirth).slice(0, 10) : null;
    const nationality: string | null = p.data?.nationality ?? null;
    const position: string | null = p.data?.position ?? null;

    let internalId: number | null = null;
    if (!dryRun) {
      const identity = await createIdentity({
        displayName: name, dob, nationality, position, primarySource: "fdorg",
      });
      internalId = identity.id;
      await upsertRef({
        internalId: identity.id, source: "fdorg", externalId: String(p.id),
        externalName: name, confidence: 1, status: "manual_confirmed", matchedBy: "anchor",
      });
      await client.from("player_profiles").update({ internal_id: identity.id }).eq("id", p.id);
      await client.from("players").update({ internal_id: identity.id }).eq("id", p.id);
      await client.from("player_seasons").update({ internal_id: identity.id }).eq("player_id", p.id);
    }
    identitiesCreated++;

    const tmRefVal = p.tm_ref;
    if (tmRefVal && typeof tmRefVal === "object" && (tmRefVal as any).id) {
      tmRefsImported++;
      if (!dryRun && internalId) {
        await upsertRef({
          internalId, source: "transfermarkt",
          externalId: String((tmRefVal as any).id),
          externalSlug: (tmRefVal as any).slug ?? null,
          confidence: LEGACY_CONFIDENCE, status: "auto_low", matchedBy: "legacy_import",
        });
      }
    }

    const ssId = ssIdByFdId.get(p.id);
    if (ssId) {
      ssRefsImported++;
      if (!dryRun && internalId) {
        await upsertRef({
          internalId, source: "sofascore",
          externalId: String(ssId),
          confidence: LEGACY_CONFIDENCE, status: "auto_low", matchedBy: "legacy_import",
        });
      }
    }
  }

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
  console.log(`tm_ref legacy refs ${dryRun ? "that would be " : ""}imported: ${tmRefsImported}`);
  console.log(`sofascore legacy refs ${dryRun ? "that would be " : ""}imported: ${ssRefsImported}`);
  console.log(`\nphoto linkability: ${uniqueNamePlayers} players have a unique name in this set (safely linkable)`);
  console.log(`  ${ambiguousNameGroups.length} name(s) are shared by 2+ players in this set (left unlinked):`);
  for (const g of ambiguousNameGroups.slice(0, 10)) {
    console.log(`    "${g[0].data?.name || g[0].name}": ids ${g.map((p) => p.id).join(", ")}`);
  }
  if (ambiguousNameGroups.length > 10) console.log(`    ...and ${ambiguousNameGroups.length - 10} more`);

  if (dryRun) {
    console.log(`\nDry run only — nothing was written. Re-run with --apply to write for real.`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

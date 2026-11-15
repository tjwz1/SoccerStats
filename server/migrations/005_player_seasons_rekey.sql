-- Run this in the Supabase SQL Editor.
--
-- Player identity layer, Phase D (part 1): re-key player_seasons by internal_id so a
-- genuine mid-season transfer (two different clubs, same season/competition) can be stored
-- as two rows instead of silently collapsing into one under the old 3-column key. The
-- in-memory merge that feeds this table (mergeCareerSources, footballApi.ts) is fixed in
-- the same code change to key on team too, so the two fixes land together.
--
-- player_seasons has no prior migration file in this repo (pre-existing gap); its current
-- primary key, confirmed live via a duplicate-insert test, is player_seasons_pkey on
-- (player_id, competition, season).

-- 1. Backfill internal_id for every row whose player_id has a resolvable fdorg ref. Safe,
--    deterministic join (no name-matching) — mirrors identity-backfill.ts's own join logic,
--    re-run against today's (larger) player_source_ref coverage. Rows with no resolvable ref
--    (legacy/non-big-5 players, outside the identity layer's v1 scope) are left NULL —
--    expected, not a bug: NULLs are distinct in the new unique index added below, so those
--    rows simply keep today's existing (imperfect) behavior rather than erroring.
UPDATE player_seasons ps
SET internal_id = psr.internal_id
FROM player_source_ref psr
WHERE psr.source = 'fdorg'
  AND psr.external_id = ps.player_id::text
  AND ps.internal_id IS NULL;

-- 2. Drop the old 3-column primary key. Must drop it, not just add a new index alongside —
--    Postgres enforces every unique constraint/PK on insert regardless of which one a later
--    ON CONFLICT targets, so leaving this in place would still reject a genuine second-club
--    row for the same (player_id, competition, season).
ALTER TABLE player_seasons DROP CONSTRAINT player_seasons_pkey;

-- 3. Add the new 4-column unique index. NULLs are distinct in Postgres, so legacy/non-big-5
--    rows (internal_id still NULL after step 1) never collide with each other.
CREATE UNIQUE INDEX player_seasons_internal_comp_season_team_key
  ON player_seasons (internal_id, competition, season, team_name);

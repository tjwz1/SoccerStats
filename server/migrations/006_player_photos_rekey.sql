-- Run this in the Supabase SQL Editor.
--
-- Player identity layer, Phase D (part 2): add internal_id as metadata on player_photos.
--
-- Correction found while implementing this phase: player_name is this table's actual
-- primary key (player_photos_pkey), confirmed live via a duplicate-insert test. That means
-- two different real people who share a name can never both have a row here — internal_id
-- cannot be used as an alternate upsert-conflict target to let them coexist without also
-- replacing that PK, which is a bigger, riskier migration not done in this pass. What this
-- does fix instead: name drift for the *same* person (a source recording their name
-- slightly differently over time) — a lookup by internal_id can find their existing cached
-- photo under an old name variant. No backfill is possible (no fd.org id column exists on
-- this table to join on) — this only helps going forward, as rows get re-fetched naturally.

CREATE INDEX player_photos_internal_id_idx
  ON player_photos (internal_id) WHERE internal_id IS NOT NULL;

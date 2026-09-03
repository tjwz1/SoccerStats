-- Run this in the Supabase SQL Editor.
--
-- Durable, always-serve store for assembled player career profiles.
-- GET /api/players/:id serves straight from this table and never blocks a user on the
-- SofaScore / Transfermarkt / scorer assembly pipeline. Rows are kept current by:
--   * a once-daily cron (/api/admin/refresh-players) that walks the big-5 league squads
--   * an on-read live refresh when the player's team is currently playing
--   * a 12h stale-while-revalidate background refresh on any read

CREATE TABLE IF NOT EXISTS player_profiles (
  id            integer PRIMARY KEY,             -- football-data.org person id
  name          text        NOT NULL DEFAULT '',
  competition   text        NOT NULL DEFAULT 'PL', -- competition code the profile was assembled for
  team_id       integer,                          -- fd.org team id, when known (set by the squad cron)
  data          jsonb       NOT NULL,             -- full assembled PlayerDetail payload
  complete      boolean     NOT NULL DEFAULT false, -- has real career data — trusted as final
  refreshed_at  timestamptz NOT NULL DEFAULT now()
);

-- The cron pulls "least-complete, stalest first".
CREATE INDEX IF NOT EXISTS player_profiles_refresh_order
  ON player_profiles (complete, refreshed_at);

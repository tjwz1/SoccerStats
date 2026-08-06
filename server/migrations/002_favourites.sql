-- Run this in the Supabase SQL Editor to enable the favourites table.
-- Enables users to sync their favourite teams across devices when signed in.

CREATE TABLE IF NOT EXISTS favourites (
  user_id          uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  team_id          integer NOT NULL,
  competition_code text NOT NULL,
  added_at         timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, team_id)
);

ALTER TABLE favourites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage own favourites"
  ON favourites FOR ALL USING (auth.uid() = user_id);

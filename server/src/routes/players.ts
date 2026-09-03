import { Router } from "express";
import { getLiveMatches } from "../services/footballApi";
import {
  getStoredProfile,
  refreshPlayerProfile,
  buildPendingPayload,
  type PlayerPayload,
} from "../services/playerStore";

const router = Router();

// A stored profile older than this gets a background refresh on read (stale-while-revalidate).
const SWR_STALE_MS = 12 * 60 * 60 * 1000;
// During a live match, a participating player's profile is refreshed inline if older than this
// so an in-game goal/assist shows up quickly.
const LIVE_STALE_MS = 60 * 1000;
// First-ever visit: how long we wait for the assembly pipeline before returning a placeholder.
const FIRST_VISIT_TIMEOUT_MS = 9000;

// Guards so a given player is only refreshed once at a time from the background paths here
// (refreshPlayerProfile also dedupes internally; this just avoids scheduling churn).
const bgRefreshing = new Set<number>();
function scheduleBgRefresh(id: number, competition: string, teamId?: number | null) {
  if (bgRefreshing.has(id)) return;
  bgRefreshing.add(id);
  refreshPlayerProfile(id, competition, teamId)
    .catch(() => {})
    .finally(() => bgRefreshing.delete(id));
}

async function teamIsLive(teamId: number | null | undefined): Promise<boolean> {
  if (!teamId) return false;
  try {
    const live = await getLiveMatches();
    return live.some((m) => m.homeTeamId === teamId || m.awayTeamId === teamId);
  } catch {
    return false;
  }
}

const timeout = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid player id" });
    const competition = (req.query.competition as string) || "PL";

    // Career data is stable within a session — let the Vercel CDN hold it briefly.
    res.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");

    const stored = await getStoredProfile(id);

    if (stored) {
      const ageMs = Date.now() - new Date(stored.refreshed_at).getTime();

      // Live match in progress for this player's team → refresh inline (bounded) so the
      // response reflects the current game. Cheap: the current-season scorers list is
      // per-competition and shared/cached across every player.
      if (ageMs > LIVE_STALE_MS && (await teamIsLive(stored.team_id))) {
        const fresh = (await Promise.race([
          refreshPlayerProfile(id, stored.competition || competition, stored.team_id),
          timeout(FIRST_VISIT_TIMEOUT_MS, null),
        ])) as PlayerPayload | null;
        return res.json(fresh ?? stored.data);
      }

      // Otherwise serve immediately; refresh in the background if the row is old.
      if (ageMs > SWR_STALE_MS || !stored.complete) {
        scheduleBgRefresh(id, stored.competition || competition, stored.team_id);
      }
      return res.json(stored.data);
    }

    // First-ever visit: short wait for the full assembly, then fall back to a placeholder.
    // The refresh keeps running after the timeout and populates player_profiles, so the
    // client's auto-retry returns the real data shortly after.
    const data = (await Promise.race([
      refreshPlayerProfile(id, competition),
      timeout(FIRST_VISIT_TIMEOUT_MS, null),
    ])) as PlayerPayload | null;

    if (data) return res.json(data);

    res.set("Cache-Control", "no-store");
    return res.json(buildPendingPayload(id));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

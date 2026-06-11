import { Router } from "express";
import { getPlayer } from "../services/footballApi";
import { getCached, setCached } from "../db/apiCache";

// Cache the assembled player response for 10 minutes — avoids re-running all the
// scorer + wiki + TM lookups on every request while still refreshing after a match day.
const PLAYER_RESPONSE_TTL_MS = 10 * 60 * 1000;

const router = Router();

router.get("/:id", async (req, res) => {
  try {
    const competition = (req.query.competition as string) || "PL";
    const cacheKey = `player_response:${req.params.id}:${competition}`;

    const cached = await getCached(cacheKey);
    // Treat a cached empty-career response as a miss — allows retries after a first-run scrape failure.
    if (cached && (cached as any)?.career?.length > 0) {
      return res.json(cached);
    }

    const data = await getPlayer(req.params.id, competition);
    // Only cache when we have career data — avoids persisting empty results from
    // a first-run wiki/TM scrape failure and blocking retries for 10 minutes.
    if ((data as any)?.career?.length > 0) {
      setCached(cacheKey, data, PLAYER_RESPONSE_TTL_MS);
    }
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

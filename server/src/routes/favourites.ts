import { Router } from "express";
import { requireAuth } from "../utils/authJwt";
import { getClient } from "../db/supabase";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { data, error } = await getClient()
      .from("favourites")
      .select("team_id, competition_code, added_at")
      .eq("user_id", userId)
      .order("added_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data.map((r) => ({ teamId: r.team_id, competitionCode: r.competition_code })));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { teamId, competitionCode } = req.body as { teamId?: unknown; competitionCode?: unknown };
    const teamIdNum = Number(teamId);
    if (!Number.isInteger(teamIdNum) || teamIdNum <= 0 || teamIdNum > 1_000_000) {
      return res.status(400).json({ error: "teamId must be a positive integer" });
    }
    if (typeof competitionCode !== "string" || !/^[A-Z0-9_]{1,10}$/.test(competitionCode)) {
      return res.status(400).json({ error: "competitionCode must be 1–10 uppercase alphanumeric characters" });
    }
    const { error } = await getClient()
      .from("favourites")
      .upsert({ user_id: userId, team_id: teamIdNum, competition_code: competitionCode });
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:teamId", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const teamId = parseInt(req.params.teamId, 10);
    if (isNaN(teamId)) return res.status(400).json({ error: "Invalid teamId" });
    const { error } = await getClient()
      .from("favourites")
      .delete()
      .eq("user_id", userId)
      .eq("team_id", teamId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

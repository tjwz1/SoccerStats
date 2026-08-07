import { Router } from "express";
import { requireAuth } from "../utils/authJwt";
import { getClient } from "../db/supabase";

const router = Router();

// Permanently deletes the authenticated user's account and all associated data.
// The favourites table cascades on auth.users deletion, so no manual cleanup needed.
router.delete("/", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { error } = await getClient().auth.admin.deleteUser(userId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

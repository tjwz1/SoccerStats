import type { Request, Response, NextFunction } from "express";
import { getClient } from "../db/supabase";

// Verifies a Supabase user JWT from Authorization: Bearer <token>.
// Sets req.userId on success; returns 401 on failure.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  const token = header.slice(7);
  try {
    const { data, error } = await getClient().auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: "Unauthorized" });
    (req as any).userId = data.user.id;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}

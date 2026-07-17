import type { Request, Response, NextFunction } from "express";

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.ADMIN_SECRET;
  const provided = req.headers["x-admin-secret"] as string | undefined;
  const isLocalhost = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip ?? "");
  if ((secret && provided === secret) || (!secret && isLocalhost)) return next();
  res.status(403).json({ error: "Forbidden" });
}

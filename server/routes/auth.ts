import type { Express } from "express";
import crypto from "crypto";

/**
 * Admin auth middleware — timing-safe key comparison.
 * Single key: COACH_DASHBOARD_KEY, sent via x-dashboard-key header.
 */
export function requireAdminKey(req: any, res: any, next: any) {
  const key = process.env.COACH_DASHBOARD_KEY;
  if (!key) {
    console.error("[AUTH] COACH_DASHBOARD_KEY env var is not set — admin access blocked");
    return res.status(503).json({ message: "Dashboard not configured" });
  }
  const provided = (req.headers["x-dashboard-key"] as string) || "";
  let match = false;
  try {
    match = provided.length === key.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(key));
  } catch {
    match = false;
  }
  if (!match) return res.status(401).json({ message: "Unauthorized" });
  next();
}

/**
 * Register auth routes (login).
 */
export function registerAuthRoutes(app: Express) {
  app.post("/api/auth/login", (req: any, res: any) => {
    const key = process.env.COACH_DASHBOARD_KEY;
    if (!key) return res.status(503).json({ message: "Dashboard not configured — set COACH_DASHBOARD_KEY env var" });
    const { password } = req.body || {};
    if (!password || password !== key) {
      return res.status(401).json({ message: "Invalid password" });
    }
    return res.json({ success: true, token: password });
  });
}

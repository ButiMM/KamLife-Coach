import type { Express } from "express";
import path from "path";
import { db } from "../db";
import { users, workoutLogs } from "../../shared/schema";
import { eq, sql } from "drizzle-orm";
import { requireAdminKey } from "./auth";

export function registerHealthRoutes(app: Express) {
  // ── Simple health check — includes DB ping so Railway stops routing to dead instances ──
  app.get("/health", async (_req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ status: "ok", service: "KamLife Coach", timestamp: new Date().toISOString() });
    } catch (e: any) {
      console.error("[HEALTH] DB check failed:", e.message);
      res.status(503).json({ status: "error", detail: "database unavailable", timestamp: new Date().toISOString() });
    }
  });

  // ── Public stats for landing page (no auth — aggregate only) ──
  app.get("/api/public/stats", async (_req, res) => {
    try {
      const [clientCount, workoutCount] = await Promise.all([
        db.select({ count: sql`count(*)` }).from(users).where(eq(users.onboardingState, "COMPLETE")),
        db.select({ count: sql`count(*)` }).from(workoutLogs),
      ]);
      res.json({
        activeClients: parseInt(String(clientCount[0]?.count || 0)),
        workoutsLogged: parseInt(String(workoutCount[0]?.count || 0)),
      });
    } catch (e) {
      console.warn("[dashboard-stats]", e);
      res.status(503).json({ activeClients: 0, workoutsLogged: 0 });
    }
  });

  // ── Detailed health check for dashboard status panel ──
  app.get("/api/health", requireAdminKey, async (_req, res) => {
    const checks: Record<string, { status: "online" | "offline"; detail?: string }> = {};

    try {
      await db.select({ count: sql`count(*)` }).from(users).limit(1);
      checks.database = { status: "online" };
    } catch (e: any) {
      checks.database = { status: "offline", detail: e.message };
    }

    checks.openai = (process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY)
      ? { status: "online" }
      : { status: "offline", detail: "OpenAI key not set (AI_INTEGRATIONS_OPENAI_API_KEY/OPENAI_API_KEY)" };

    checks.whatsapp = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_NUMBER)
      ? { status: "online" }
      : { status: "offline", detail: "Twilio env vars missing" };

    checks.payfast = (process.env.PAYFAST_MERCHANT_ID && process.env.PAYFAST_MERCHANT_KEY)
      ? { status: "online" }
      : { status: "offline", detail: "PayFast env vars missing" };

    const allOnline = Object.values(checks).every(c => c.status === "online");
    res.json({ status: allOnline ? "healthy" : "degraded", checks, timestamp: new Date().toISOString() });
  });

  // ── Voice note file serving ──
  app.get("/voice/:id.mp3", (req, res) => {
    const { existsSync } = require("fs");
    const safeId = path.basename(req.params.id || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeId) return res.status(400).end();
    const filePath = path.join(process.cwd(), "tmp", "voice", `${safeId}.mp3`);
    if (!existsSync(filePath)) return res.status(404).end();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.sendFile(filePath);
  });
}

import type { Express } from "express";
import path from "path";
import { db, pool } from "../db";
import { users, workoutLogs, schedulerState } from "../../shared/schema";
import { eq, sql } from "drizzle-orm";
import { requireAdminKey } from "./auth";
import { deliveryStats, jobRegistry, dailyProactiveCount, DAILY_PROACTIVE_CAP } from "../scheduler/shared";
import { isTwilioCircuitOpen } from "../utils";

/**
 * WHICH BUILD IS ANSWERING (2026-08-20).
 *
 * The running commit was readable in exactly three places, and all three sat behind something
 * that could break: the WhatsApp `version` command (which depends on a phone-number comparison —
 * and that comparison was wrong, so the command never fired), a column in turn_ledger that no
 * route reads, and an internal audit payload.
 *
 * The cost was two rounds of screenshots diagnosed against code that may not have been live. A
 * deploy check must not depend on the application's own routing being correct; that is the one
 * thing it exists to test.
 */
function runningBuild() {
  return {
    version: (process.env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 7) || process.env.APP_VERSION || "dev",
    bootedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  };
}

export function registerHealthRoutes(app: Express) {
  // ── Simple health check — includes DB ping so Railway stops routing to dead instances ──
  app.get("/health", async (_req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ status: "ok", service: "KamLife Coach", ...runningBuild(), timestamp: new Date().toISOString() });
    } catch (e: any) {
      console.error("[HEALTH] DB check failed:", e.message);
      // The build still answers on a 503 — "which code is failing" is the question you ask FIRST
      // when an instance is unhealthy, and it is the moment the WhatsApp command is least likely
      // to work.
      res.status(503).json({ status: "error", detail: "database unavailable", ...runningBuild(), timestamp: new Date().toISOString() });
    }
  });

  // ── Readiness probe — 200 only when the DB is reachable, else 503 ──
  // Distinct from /health (liveness): orchestrators use this to decide whether the
  // instance can serve traffic. Kept fast and side-effect-free (single SELECT 1).
  app.get("/health/ready", async (_req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ ready: true, timestamp: new Date().toISOString() });
    } catch (e: any) {
      console.error("[HEALTH] Readiness DB check failed:", e.message);
      res.status(503).json({ ready: false, reason: "database unavailable", timestamp: new Date().toISOString() });
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
        // Served at RUNTIME so the hero video works from a Railway env var without
        // a rebuild (VITE_ vars are otherwise baked in only at build time).
        heroVideoUrl: process.env.HERO_VIDEO_URL || process.env.VITE_HERO_VIDEO_URL || "",
      });
    } catch (e) {
      console.warn("[dashboard-stats]", e);
      res.status(503).json({ activeClients: 0, workoutsLogged: 0, heroVideoUrl: process.env.HERO_VIDEO_URL || process.env.VITE_HERO_VIDEO_URL || "" });
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

  // ── Ops snapshot — one read-only view of whether the core loop is firing ──
  // NOTE: delivery stats, the proactive budget, and the job registry are in-memory
  // on the scheduler leader replica, so query the leader instance for accurate
  // operational numbers. The DB-derived funnel/subscription counts are global.
  app.get("/api/ops", requireAdminKey, async (_req, res) => {
    try {
      const total = deliveryStats.sent + deliveryStats.failed;
      const failureRate = total > 0 ? deliveryStats.failed / total : 0;

      const [funnelRows, subRows] = await Promise.all([
        db.execute(sql`SELECT onboarding_state AS state, COUNT(*)::int AS n FROM users GROUP BY onboarding_state`),
        db.execute(sql`SELECT subscription_status AS status, COUNT(*)::int AS n FROM users GROUP BY subscription_status`),
      ]);

      let clientsAtCap = 0, slotsUsedToday = 0;
      for (const n of dailyProactiveCount.values()) { slotsUsedToday += n; if (n >= DAILY_PROACTIVE_CAP) clientsAtCap++; }

      res.json({
        timestamp: new Date().toISOString(),
        delivery: {
          sentToday: deliveryStats.sent,
          failedToday: deliveryStats.failed,
          failureRate: Number(failureRate.toFixed(3)),
          since: deliveryStats.lastReset,
        },
        twilioCircuitOpen: isTwilioCircuitOpen(),
        proactiveBudget: {
          cap: DAILY_PROACTIVE_CAP,
          clientsMessagedToday: dailyProactiveCount.size,
          slotsUsedToday,
          clientsAtCap,
        },
        dbPool: {
          total: (pool as any).totalCount ?? null,
          idle: (pool as any).idleCount ?? null,
          waiting: (pool as any).waitingCount ?? null,
        },
        onboardingFunnel: Object.fromEntries((funnelRows.rows as any[]).map(r => [r.state || "unknown", Number(r.n)])),
        subscriptions: Object.fromEntries((subRows.rows as any[]).map(r => [r.status || "unknown", Number(r.n)])),
        jobs: Object.fromEntries(jobRegistry.entries()),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Scheduler health — focused on-call view: overdue jobs, trial countdown status ──
  app.get("/api/health/scheduler", requireAdminKey, async (_req, res) => {
    try {
      const now = Date.now();

      // Jobs overdue: not run in 25h (allows the 1h scheduling window around each daily job)
      const overdueJobs: string[] = [];
      const healthyJobs: { name: string; lastRunAt: string; failures: number }[] = [];
      for (const [name, info] of jobRegistry.entries()) {
        if (!info.lastRunAt) { overdueJobs.push(`${name} (never run since restart)`); continue; }
        const msSinceRun = now - new Date(info.lastRunAt).getTime();
        if (msSinceRun > 25 * 3_600_000) {
          overdueJobs.push(`${name} (${Math.round(msSinceRun / 3_600_000)}h ago, ${info.failures} failures)`);
        } else {
          healthyJobs.push({ name, lastRunAt: info.lastRunAt, failures: info.failures });
        }
      }

      // Trial countdown breakdown — used to verify Day 2/5/7 jobs are targeting the right users
      const trialResult = await db.execute(sql`
        SELECT
          COUNT(*)::int AS total_in_trial,
          COUNT(*) FILTER (WHERE beta_bypass_until > NOW() + INTERVAL '4 days')::int AS day2_cohort,
          COUNT(*) FILTER (WHERE beta_bypass_until BETWEEN NOW() + INTERVAL '2 days' AND NOW() + INTERVAL '4 days')::int AS day5_cohort,
          COUNT(*) FILTER (WHERE beta_bypass_until BETWEEN NOW() AND NOW() + INTERVAL '2 days')::int AS day7_cohort
        FROM users
        WHERE subscription_status = 'trial' AND beta_bypass_until >= NOW()
      `);

      // Last-seen values from DB-backed scheduler state (survives restarts)
      const stateRows = await db.select().from(schedulerState)
        .orderBy(schedulerState.updatedAt);

      res.json({
        status: overdueJobs.length === 0 ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
        jobs: { overdue: overdueJobs, healthy: healthyJobs, totalRegistered: jobRegistry.size },
        trialCountdown: trialResult.rows[0] || {},
        schedulerState: Object.fromEntries(stateRows.map(r => [r.key, { value: r.value, updatedAt: r.updatedAt }])),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
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

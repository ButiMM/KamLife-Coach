import type { Express } from "express";
import { db } from "../db";
import { users, stepLogs, userIntegrations } from "../../shared/schema";
import { eq, and, gte } from "drizzle-orm";
import { sendWhatsApp } from "../scheduler/shared";
import { getStepResponse } from "../handlers/steps";
import { getStepStreak } from "../handlers/steps";
import { logChat } from "../handlers/chat-log";
import { sastDayStart } from "../utils";

export function registerHealthSyncRoutes(app: Express): void {
  // POST /webhook/steps?phone=+27XXXXXXX
  // Receives step data from Android Health Connect Webhooks app or iOS Shortcut.
  // Body: { steps: number } or { value: number } or { data: { steps: number } }
  app.post("/webhook/steps", async (req, res) => {
    try {
      const phone = req.query.phone as string | undefined;
      if (!phone) {
        res.status(400).json({ error: "phone query param required" });
        return;
      }

      // Parse steps from multiple possible body formats
      const body = req.body || {};
      const steps: number = parseInt(
        body.steps ?? body.value ?? body.count ?? body.data?.steps ?? body.data?.value ?? "0",
        10,
      );

      if (!Number.isFinite(steps) || steps < 0 || steps > 100_000) {
        res.status(400).json({ error: "invalid steps value" });
        return;
      }

      const [user] = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
      if (!user) {
        res.status(404).json({ error: "user not found" });
        return;
      }

      // Dedup: only one step log per user per SAST day
      const todayStart = sastDayStart();
      const existing = await db.select({ id: stepLogs.id }).from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, todayStart)))
        .limit(1);

      if (existing.length > 0) {
        res.json({ ok: true, message: "already logged today" });
        return;
      }

      await db.insert(stepLogs).values({ userId: user.id, steps });

      // Mark the integration as active so the morning job knows steps are synced
      await db.insert(userIntegrations).values({
        userId: user.id,
        provider: "webhook",
        isActive: true,
        lastSyncAt: new Date(),
      }).onConflictDoUpdate({
        target: [userIntegrations.userId, userIntegrations.provider],
        set: { lastSyncAt: new Date(), isActive: true },
      }).catch(() => { /* ignore if table not yet migrated */ });

      // Send an instant response so the user knows it worked
      const target = user.stepsTarget || 8500;
      const weight = parseFloat(String(user.currentWeight || "0")) || 75;
      const streak = await getStepStreak(user.id);
      const response = getStepResponse(steps, target, weight, streak);
      const autoMsg = `_[Auto-synced from your health app]_\n\n${response}`;

      await sendWhatsApp(user.phoneNumber, autoMsg);
      await logChat(user.id, `[auto-sync: ${steps} steps]`, autoMsg, "STEPS_AUTO_SYNC");

      res.json({ ok: true, steps });
    } catch (err) {
      console.error("[HEALTH SYNC] Webhook error:", err);
      res.status(500).json({ error: "internal error" });
    }
  });
}

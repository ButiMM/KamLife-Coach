import type { Express } from "express";
import { db } from "../db";
import { users, weightLogs, workoutLogs, stepLogs, chatHistory } from "../../shared/schema";
import { eq, desc, and, gte, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import twilio from "twilio";
import { requireAdminKey } from "./auth";
import type { RouteDeps } from "./types";
import { sendWhatsApp } from "../scheduler";

export function registerAdminRoutes(app: Express, deps: Pick<RouteDeps, "handleMessage" | "logChat">) {
  const { handleMessage, logChat } = deps;

  // ── List all users (paginated) ──
  app.get("/api/users", requireAdminKey, async (req: any, res) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page || "1")));
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"))));
      const offset = (page - 1) * limit;

      const [all, total] = await Promise.all([
        db.select().from(users).orderBy(desc(users.createdAt)).limit(limit).offset(offset),
        db.select({ count: sql`count(*)` }).from(users),
      ]);

      console.log(`[ADMIN AUDIT] GET /api/users — page ${page}, limit ${limit} — ${new Date().toISOString()}`);

      res.json({
        users: all,
        pagination: {
          page,
          limit,
          total: parseInt(String(total[0]?.count || 0)),
          pages: Math.ceil(parseInt(String(total[0]?.count || 0)) / limit),
        },
      });
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // ── Single user detail ──
  app.get("/api/users/:id", requireAdminKey, async (req, res) => {
    try {
      const user = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1);
      if (!user.length) return res.status(404).json({ message: "User not found" });

      const weights = await db.select().from(weightLogs).where(eq(weightLogs.userId, req.params.id)).orderBy(desc(weightLogs.loggedAt)).limit(30);
      const steps = await db.select().from(stepLogs).where(eq(stepLogs.userId, req.params.id)).orderBy(desc(stepLogs.loggedAt)).limit(30);
      const workouts = await db.select().from(workoutLogs).where(eq(workoutLogs.userId, req.params.id)).orderBy(desc(workoutLogs.loggedAt)).limit(30);
      const chats = await db.select().from(chatHistory).where(eq(chatHistory.userId, req.params.id)).orderBy(desc(chatHistory.createdAt)).limit(50);

      res.json({ user: user[0], weightLogs: weights, stepLogs: steps, workoutLogs: workouts, chatHistory: chats });
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // ── Flagged (inactive 3+ days) ──
  app.get("/api/admin/flagged", requireAdminKey, async (_req, res) => {
    try {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const inactive = await db.select().from(users).where(eq(users.onboardingState, "COMPLETE"));
      const flagged = inactive.filter(u => !u.lastActiveAt || new Date(u.lastActiveAt) < threeDaysAgo);
      res.json(flagged);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch flagged users" });
    }
  });

  // ── Beta testers (trial users) ──
  app.get("/api/admin/beta-testers", requireAdminKey, async (_req, res) => {
    try {
      const all = await db.select().from(users).where(eq(users.subscriptionStatus, "trial")).orderBy(desc(users.createdAt));
      res.json(all);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch beta testers" });
    }
  });

  // ── Admin: send message to client as Coach K ──
  app.post("/api/admin/send-message", requireAdminKey, async (req: any, res: any) => {
    try {
      const { userId, message } = req.body;
      if (!userId || !message?.trim()) {
        return res.status(400).json({ message: "userId and message are required" });
      }

      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) return res.status(404).json({ message: "User not found" });

      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const whatsappFrom = process.env.TWILIO_WHATSAPP_NUMBER;
      if (!accountSid || !authToken || !whatsappFrom) {
        return res.status(503).json({ message: "Twilio not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER" });
      }

      const twilioC = twilio(accountSid, authToken);
      const fromNum = whatsappFrom.startsWith("whatsapp:") ? whatsappFrom : `whatsapp:${whatsappFrom}`;
      const toNum = user.phoneNumber.startsWith("whatsapp:") ? user.phoneNumber : `whatsapp:${user.phoneNumber}`;

      await twilioC.messages.create({ from: fromNum, to: toNum, body: message.trim() });
      await logChat(user.id, "[admin-sent]", message.trim(), "ADMIN_MESSAGE");

      console.log(`[ADMIN] Message sent to ${toNum.slice(-8)}: "${message.slice(0, 60)}"`);
      return res.json({ success: true, sentTo: user.phoneNumber });
    } catch (err: any) {
      console.error("[ADMIN] send-message error:", err);
      return res.status(500).json({ message: err.message || "Failed to send message" });
    }
  });

  // ── Admin: run test scenarios ──
  app.post("/api/admin/run-test", requireAdminKey, async (req, res) => {
    const { testId, liveMode } = req.body;
    const logs: string[] = [];
    try {
      logs.push(`Running test ${testId}...`);
      const testPhone = "+27000000000";
      const testMessages: Record<string, string> = {
        A: "Hi, I want to join",
        B: "I ate pap and chicken for lunch",
        C: "I did 8500 steps today",
        D: "I weigh 75kg",
        E: "I am travelling and need a workout",
        F: "weekly report",
      };
      const msg = testMessages[testId] || "Hello";
      logs.push(`Sending: "${msg}"`);
      const reply = await handleMessage(testPhone, msg);
      logs.push(`Reply: ${reply}`);
      res.json({ success: true, logs, whatsappSent: reply });
    } catch (err: any) {
      logs.push(`Error: ${err.message}`);
      res.json({ success: false, logs });
    }
  });

  // ── Admin: trigger daily nudges (dry-run by default) ──
  app.post("/api/admin/trigger-daily", requireAdminKey, async (req, res) => {
    try {
      const liveMode = Boolean(req.body?.liveMode);
      const activeCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

      const candidates = await db
        .select({ id: users.id, name: users.name, phoneNumber: users.phoneNumber })
        .from(users)
        .where(
          and(
            eq(users.onboardingState, "COMPLETE"),
            gte(users.lastActiveAt, activeCutoff),
            or(eq(users.subscriptionStatus, "active"), eq(users.subscriptionStatus, "trial")),
          ),
        )
        .limit(250);

      const messageFor = (name?: string | null) =>
        `Coach K check-in 💪 ${name || "Champion"} — quick one: reply with today's steps, water, and meals so I can adjust your targets.`;

      let sent = 0;
      let failed = 0;

      if (liveMode) {
        for (const user of candidates) {
          try {
            await sendWhatsApp(user.phoneNumber, messageFor(user.name));
            sent++;
          } catch {
            failed++;
          }
        }
      }

      return res.json({
        success: true,
        count: liveMode ? sent : candidates.length,
        liveMode,
        failed,
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, message: err.message || "Failed to trigger daily messages" });
    }
  });
}

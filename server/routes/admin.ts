import type { Express } from "express";
import { db } from "../db";
import { users, weightLogs, workoutLogs, stepLogs, chatHistory, mealLogs, escalations, clientActions, progressPhotos, weeklyCheckins, clothingCheckins, bodyMeasurements, exerciseLogs, paymentEvents, clientIntelligenceProfiles, gptCosts } from "../../shared/schema";
import { evaluateScaling } from "../scaling-milestones";
import { eq, desc, asc, and, gte, isNull, or, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import twilio from "twilio";
import { requireAdminKey } from "./auth";
import { computeClientRisk, sortByRisk } from "../client-triage";
import type { RouteDeps } from "./types";
import { sendWhatsApp } from "../scheduler";
import { generateVoiceNote } from "../tts";

// Escape HTML for safe inline rendering — the activity dashboard displays raw
// user messages, which can contain anything. Never interpolate untrusted text
// without running it through this first.
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── In-memory fixed-window rate limiter for admin/dashboard routes ──
// No npm dependency (express-rate-limit is not installed). Keyed by req.ip plus
// the dashboard key header (if present) so a stolen/brute-forced key can't hammer
// endpoints or exfiltrate every user fast. 60 requests per 60s per key.
// Lazy cleanup evicts expired entries opportunistically so the Map can't grow
// unbounded across many distinct IPs/keys.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function adminRateLimit(req: any, res: any, next: any) {
  const now = Date.now();

  // Opportunistic eviction of expired windows — bounded sweep keeps it cheap.
  for (const [k, v] of rateBuckets) {
    if (now >= v.resetAt) rateBuckets.delete(k);
  }

  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const keyHeader = (req.headers["x-dashboard-key"] as string) || "";
  const bucketKey = `${ip}|${keyHeader}`;

  const bucket = rateBuckets.get(bucketKey);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(bucketKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return next();
  }

  bucket.count += 1;
  if (bucket.count > RATE_MAX) {
    return res.status(429).json({ error: "Too many requests, slow down" });
  }
  return next();
}

export function registerAdminRoutes(app: Express, deps: Pick<RouteDeps, "handleMessage" | "logChat">) {
  const { handleMessage, logChat } = deps;

  // Apply rate limiter to all admin and user-data routes.
  app.use(["/api/admin", "/api/users", "/api/triage"], adminRateLimit);

  // ── List all users (paginated) ──
  app.get("/api/users", requireAdminKey, async (req: any, res) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page || "1")));
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"))));
      const offset = (page - 1) * limit;
      const statusFilter = req.query.status as string | undefined;
      const whereClause = statusFilter ? eq(users.subscriptionStatus, statusFilter) : undefined;

      const [all, total] = await Promise.all([
        db.select().from(users).where(whereClause).orderBy(desc(users.createdAt)).limit(limit).offset(offset),
        db.select({ count: sql`count(*)` }).from(users).where(whereClause),
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

  // ── Triage queue: "who needs help today" (read-only intervention queue) ──
  // Classifies clients currently in coaching (active/trial) plus churned (cancelled)
  // into red/yellow/green so the coach acts on the right person first. Pure read —
  // never touches the message pipeline. Uses grouped queries (no N+1).
  app.get("/api/triage", requireAdminKey, async (_req: any, res) => {
    try {
      const now = Date.now();
      const sevenDaysAgo = new Date(now - 7 * 86400000);

      const [clients, lastChats, recentWorkouts, openEsc] = await Promise.all([
        db.select({
          id: users.id, name: users.name, phoneNumber: users.phoneNumber,
          subscriptionStatus: users.subscriptionStatus, createdAt: users.createdAt,
          trainingDaysPerWeek: users.trainingDaysPerWeek,
        }).from(users).where(inArray(users.subscriptionStatus, ["active", "trial", "cancelled"])),
        db.select({ userId: chatHistory.userId, last: sql<string>`MAX(${chatHistory.createdAt})` })
          .from(chatHistory).groupBy(chatHistory.userId),
        db.select({ userId: workoutLogs.userId, cnt: sql<number>`COUNT(*)::int` })
          .from(workoutLogs).where(gte(workoutLogs.loggedAt, sevenDaysAgo)).groupBy(workoutLogs.userId),
        db.select({ userId: escalations.userId })
          .from(escalations).where(and(eq(escalations.status, "open"), inArray(escalations.priority, ["urgent", "high"]))),
      ]);

      const lastChatMap = new Map(lastChats.map(r => [r.userId, r.last ? new Date(r.last).getTime() : null]));
      const workoutMap = new Map(recentWorkouts.map(r => [r.userId, r.cnt]));
      const escSet = new Set(openEsc.map(r => r.userId));
      const daysBetween = (then: number) => Math.floor((now - then) / 86400000);

      const rows = clients.map(c => {
        const lastChat = lastChatMap.get(c.id) ?? null;
        const daysSinceActive = lastChat !== null ? daysBetween(lastChat) : null;
        const daysSinceSignup = c.createdAt ? daysBetween(new Date(c.createdAt).getTime()) : 999;
        const triage = computeClientRisk({
          daysSinceActive,
          daysSinceSignup,
          hasOpenUrgentEscalation: escSet.has(c.id),
          subscriptionStatus: c.subscriptionStatus || "inactive",
          plannedSessionsPerWeek: c.trainingDaysPerWeek || 0,
          workoutsLast7: workoutMap.get(c.id) || 0,
        });
        return {
          id: c.id,
          name: c.name || "(no name)",
          phone: c.phoneNumber,
          waLink: `https://wa.me/${String(c.phoneNumber || "").replace(/[^\d]/g, "")}`,
          subscriptionStatus: c.subscriptionStatus,
          daysSinceActive,
          workoutsLast7: workoutMap.get(c.id) || 0,
          level: triage.level,
          reason: triage.reason,
          nextAction: triage.nextAction,
        };
      });

      const sorted = sortByRisk(rows.map(r => ({ ...r, triage: { level: r.level, reason: r.reason, nextAction: r.nextAction } })))
        .map(({ triage, ...r }) => r);
      const summary = {
        red: rows.filter(r => r.level === "red").length,
        yellow: rows.filter(r => r.level === "yellow").length,
        green: rows.filter(r => r.level === "green").length,
        total: rows.length,
      };
      console.log(`[ADMIN AUDIT] GET /api/triage — ${summary.red} red, ${summary.yellow} yellow — ${new Date().toISOString()}`);
      res.json({ summary, clients: sorted });
    } catch (err) {
      console.error("[TRIAGE]", err);
      res.status(500).json({ message: "Failed to build triage queue" });
    }
  });

  // ── Single user detail ──
  app.get("/api/users/:id", requireAdminKey, async (req, res) => {
    try {
      const user = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1);
      if (!user.length) return res.status(404).json({ message: "User not found" });

      const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000);
      const [weights, steps, workouts, chats, meals, actions, photos] = await Promise.all([
        db.select().from(weightLogs).where(eq(weightLogs.userId, req.params.id)).orderBy(desc(weightLogs.loggedAt)).limit(30),
        db.select().from(stepLogs).where(eq(stepLogs.userId, req.params.id)).orderBy(desc(stepLogs.loggedAt)).limit(30),
        db.select().from(workoutLogs).where(eq(workoutLogs.userId, req.params.id)).orderBy(desc(workoutLogs.loggedAt)).limit(30),
        db.select().from(chatHistory).where(eq(chatHistory.userId, req.params.id)).orderBy(desc(chatHistory.createdAt)).limit(50),
        db.select().from(mealLogs).where(and(eq(mealLogs.userId, req.params.id), gte(mealLogs.loggedAt, fourteenDaysAgo))).orderBy(desc(mealLogs.loggedAt)).limit(100),
        db.select().from(clientActions).where(eq(clientActions.userId, req.params.id)).orderBy(asc(clientActions.createdAt)).limit(50),
        db.select({ id: progressPhotos.id, photoNumber: progressPhotos.photoNumber, contentType: progressPhotos.contentType, loggedAt: progressPhotos.loggedAt }).from(progressPhotos).where(eq(progressPhotos.userId, req.params.id)).orderBy(desc(progressPhotos.loggedAt)).limit(20),
      ]);

      res.json({ user: user[0], weightLogs: weights, stepLogs: steps, workoutLogs: workouts, chatHistory: chats, mealLogs: meals, actions, progressPhotos: photos });
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // ── Client pinned actions — CRUD ──
  app.get("/api/users/:id/actions", requireAdminKey, async (req, res) => {
    try {
      const rows = await db.select().from(clientActions)
        .where(eq(clientActions.userId, req.params.id))
        .orderBy(asc(clientActions.createdAt));
      res.json({ actions: rows });
    } catch { res.status(500).json({ error: "Failed to fetch actions" }); }
  });

  app.post("/api/users/:id/actions", requireAdminKey, async (req, res) => {
    try {
      const { content, dueAt } = req.body as { content?: string; dueAt?: string };
      if (!content?.trim()) return res.status(400).json({ error: "content is required" });
      const [row] = await db.insert(clientActions).values({
        userId: req.params.id,
        content: content.trim(),
        dueAt: dueAt ? new Date(dueAt) : undefined,
      }).returning();
      res.json({ action: row });
    } catch { res.status(500).json({ error: "Failed to create action" }); }
  });

  app.patch("/api/users/:id/actions/:actionId", requireAdminKey, async (req, res) => {
    try {
      const actionId = parseInt(req.params.actionId);
      const { completed } = req.body as { completed?: boolean };
      const [row] = await db.update(clientActions)
        .set({ completedAt: completed ? new Date() : null })
        .where(and(eq(clientActions.id, actionId), eq(clientActions.userId, req.params.id)))
        .returning();
      if (!row) return res.status(404).json({ error: "Action not found" });
      res.json({ action: row });
    } catch { res.status(500).json({ error: "Failed to update action" }); }
  });

  app.delete("/api/users/:id/actions/:actionId", requireAdminKey, async (req, res) => {
    try {
      const actionId = parseInt(req.params.actionId);
      await db.delete(clientActions)
        .where(and(eq(clientActions.id, actionId), eq(clientActions.userId, req.params.id)));
      res.json({ success: true });
    } catch { res.status(500).json({ error: "Failed to delete action" }); }
  });

  // ── Progress photos — list (base64 omitted for list view) ──
  app.get("/api/users/:id/progress-photos", requireAdminKey, async (req, res) => {
    try {
      const photos = await db.select({ id: progressPhotos.id, photoNumber: progressPhotos.photoNumber, contentType: progressPhotos.contentType, loggedAt: progressPhotos.loggedAt })
        .from(progressPhotos).where(eq(progressPhotos.userId, req.params.id)).orderBy(desc(progressPhotos.loggedAt)).limit(50);
      res.json({ photos });
    } catch { res.status(500).json({ error: "Failed to fetch photos" }); }
  });

  // ── Progress photo — fetch single (with base64) ──
  app.get("/api/users/:id/progress-photos/:photoId", requireAdminKey, async (req, res) => {
    try {
      const [photo] = await db.select().from(progressPhotos)
        .where(and(eq(progressPhotos.id, req.params.photoId), eq(progressPhotos.userId, req.params.id))).limit(1);
      if (!photo) return res.status(404).json({ error: "Photo not found" });
      res.json({ photo });
    } catch { res.status(500).json({ error: "Failed to fetch photo" }); }
  });

  // ── Progress photo — upload ──
  app.post("/api/users/:id/progress-photos", requireAdminKey, async (req, res) => {
    try {
      const { base64, contentType = "image/jpeg" } = req.body as { base64?: string; contentType?: string };
      if (!base64) return res.status(400).json({ error: "base64 image data is required" });
      const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
      if (!ALLOWED_TYPES.has(contentType)) return res.status(415).json({ error: "Unsupported image type. Use jpeg, png, webp, or heic." });

      // Strip data URI prefix if present
      const cleaned = base64.replace(/^data:[^;]+;base64,/, "");
      const sizeBytes = Buffer.byteLength(cleaned, "base64");
      if (sizeBytes > 8 * 1024 * 1024) return res.status(413).json({ error: "Image must be under 8MB" });

      const [userRow] = await db.select({ id: users.id }).from(users).where(eq(users.id, req.params.id)).limit(1);
      if (!userRow) return res.status(404).json({ error: "User not found" });

      const [lastPhoto] = await db.select({ photoNumber: progressPhotos.photoNumber })
        .from(progressPhotos).where(eq(progressPhotos.userId, req.params.id)).orderBy(desc(progressPhotos.photoNumber)).limit(1);
      const nextNumber = (lastPhoto?.photoNumber ?? 0) + 1;

      const [inserted] = await db.insert(progressPhotos).values({
        userId: req.params.id,
        photoNumber: nextNumber,
        photoBase64: cleaned,
        contentType,
      }).returning({ id: progressPhotos.id, photoNumber: progressPhotos.photoNumber, loggedAt: progressPhotos.loggedAt });

      await db.insert(chatHistory).values({
        userId: req.params.id,
        messageIn: `[admin_upload] progress photo #${nextNumber}`,
        messageOut: "",
        intent: "PROGRESS_PHOTO_UPLOAD",
      }).catch(() => {});

      res.status(201).json({ photo: inserted });
    } catch { res.status(500).json({ error: "Failed to upload photo" }); }
  });

  // ── Client activity timeline by UUID ──
  app.get("/api/users/:id/timeline", requireAdminKey, async (req, res) => {
    try {
      const userId = req.params.id;
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

      const [weights, steps, workouts, meals, escs, chats] = await Promise.all([
        db.select({ weight: weightLogs.weight, date: weightLogs.loggedAt }).from(weightLogs)
          .where(and(eq(weightLogs.userId, userId), gte(weightLogs.loggedAt, thirtyDaysAgo))).orderBy(desc(weightLogs.loggedAt)),
        db.select({ steps: stepLogs.steps, date: stepLogs.loggedAt }).from(stepLogs)
          .where(and(eq(stepLogs.userId, userId), gte(stepLogs.loggedAt, thirtyDaysAgo))).orderBy(desc(stepLogs.loggedAt)),
        db.select({ date: workoutLogs.loggedAt }).from(workoutLogs)
          .where(and(eq(workoutLogs.userId, userId), gte(workoutLogs.loggedAt, thirtyDaysAgo))).orderBy(desc(workoutLogs.loggedAt)),
        db.select({ kcal: mealLogs.kcalInt, protein: mealLogs.proteinInt, raw: mealLogs.rawMessage, source: mealLogs.source, date: mealLogs.loggedAt }).from(mealLogs)
          .where(and(eq(mealLogs.userId, userId), gte(mealLogs.loggedAt, thirtyDaysAgo))).orderBy(desc(mealLogs.loggedAt)).limit(100),
        db.select({ reason: escalations.reason, status: escalations.status, priority: escalations.priority, date: escalations.createdAt }).from(escalations)
          .where(and(eq(escalations.userId, userId), gte(escalations.createdAt, thirtyDaysAgo))).orderBy(desc(escalations.createdAt)),
        db.select({ intent: chatHistory.intent, msgIn: chatHistory.messageIn, date: chatHistory.createdAt }).from(chatHistory)
          .where(and(eq(chatHistory.userId, userId), gte(chatHistory.createdAt, thirtyDaysAgo))).orderBy(desc(chatHistory.createdAt)).limit(50),
      ]);

      type TEvent = { date: string; type: string; detail: string; meta?: Record<string, unknown> };
      const events: TEvent[] = [];

      for (const w of weights) events.push({ date: new Date(w.date!).toISOString(), type: "weight", detail: `${w.weight} kg` });
      for (const s of steps) events.push({ date: new Date(s.date!).toISOString(), type: "steps", detail: `${s.steps?.toLocaleString()} steps`, meta: { steps: s.steps } });
      for (const wo of workouts) events.push({ date: new Date(wo.date!).toISOString(), type: "workout", detail: "Completed workout" });
      for (const m of meals) {
        const label = m.raw && m.raw !== "[Photo]" ? m.raw.slice(0, 60) : `${m.source} meal`;
        events.push({ date: new Date(m.date!).toISOString(), type: "food", detail: label, meta: { kcal: m.kcal, protein: m.protein, source: m.source } });
      }
      for (const e of escs) events.push({ date: new Date(e.date!).toISOString(), type: "escalation", detail: `${e.priority?.toUpperCase()} escalation: ${e.reason} (${e.status})` });
      for (const c of chats) {
        if (!c.intent || c.intent === "GENERAL" || !c.msgIn) continue; // skip noise
        events.push({ date: new Date(c.date!).toISOString(), type: "chat", detail: `[${c.intent}] ${c.msgIn.slice(0, 70)}` });
      }

      events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      res.json({ events: events.slice(0, 150) });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch timeline" });
    }
  });

  // ── Flagged (inactive 3+ days) ──
  app.get("/api/admin/flagged", requireAdminKey, async (_req, res) => {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const inactive = await db.select().from(users).where(eq(users.onboardingState, "COMPLETE"));
      const flagged = inactive
        .filter(u => !u.lastActiveAt || new Date(u.lastActiveAt) < sevenDaysAgo)
        .map(u => {
          const lastActive = u.lastActiveAt ? new Date(u.lastActiveAt) : null;
          const isLongInactive = !lastActive || lastActive < fourteenDaysAgo;
          return { ...u, flagReason: isLongInactive ? "inactive_7_days" as const : "inactive_7_days" as const };
        });
      res.json(flagged);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch flagged users" });
    }
  });

  // ── CHURN SHAPE (2026-07-13 retention P0) — WHEN do people go silent? ──
  // For every completed client who has gone quiet (≥5 days), compute the day-of-journey
  // they last spoke and bucket it. Churn is usually 3 different problems wearing one
  // mask (day 3-5 habit gap, day 11-14 mirror gap, day 28-30 renewal gap) — this shows
  // the founder the actual shape so fixes can be aimed instead of guessed.
  app.get("/api/admin/churn-shape", requireAdminKey, async (_req, res) => {
    try {
      const all = await db.select().from(users).where(eq(users.onboardingState, "COMPLETE"));
      const now = Date.now();
      const silent = all.filter(u => u.lastActiveAt && (now - new Date(u.lastActiveAt).getTime()) >= 5 * 86_400_000);
      const detail = silent.map(u => {
        const start = u.programmeStartDate || u.createdAt;
        const dayOfJourney = start ? Math.max(0, Math.floor((new Date(u.lastActiveAt!).getTime() - new Date(start).getTime()) / 86_400_000)) : null;
        return {
          name: u.name, phone: u.phoneNumber?.slice(-4),
          dayWentSilent: dayOfJourney,
          daysSilentNow: Math.floor((now - new Date(u.lastActiveAt!).getTime()) / 86_400_000),
          workoutsCompleted: u.totalWorkoutsCompleted || 0,
          goal: u.goalType, subscription: u.subscriptionStatus,
        };
      }).sort((a, b) => (a.dayWentSilent ?? 999) - (b.dayWentSilent ?? 999));
      const buckets: Record<string, number> = { "day 0-2": 0, "day 3-5": 0, "day 6-10": 0, "day 11-14": 0, "day 15-21": 0, "day 22-30": 0, "day 31+": 0 };
      for (const d of detail) {
        const day = d.dayWentSilent;
        if (day == null) continue;
        if (day <= 2) buckets["day 0-2"]++;
        else if (day <= 5) buckets["day 3-5"]++;
        else if (day <= 10) buckets["day 6-10"]++;
        else if (day <= 14) buckets["day 11-14"]++;
        else if (day <= 21) buckets["day 15-21"]++;
        else if (day <= 30) buckets["day 22-30"]++;
        else buckets["day 31+"]++;
      }
      res.json({
        totalClients: all.length,
        silentClients: silent.length,
        histogram: buckets,
        readIt: "The biggest bucket is your real churn problem. day 3-5 = habit gap (day-3 voice note attacks this). day 11-14 = mirror gap (day-14 receipt attacks this). day 22-30 = renewal/value gap.",
        clients: detail,
      });
    } catch (err) {
      res.status(500).json({ message: "Failed to compute churn shape" });
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
      if (message.trim().length > 1600) {
        return res.status(400).json({ message: "Message too long — WhatsApp limit is 1600 characters" });
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

  // ── Admin: activity feed (last N inbound messages across all users) ──
  //
  // Why this exists: production misroutes (e.g. "steak wrap" classified as
  // STREAK_CHECK) only became visible when the user sent screenshots. This
  // endpoint gives the founder a direct view of what Claude is classifying
  // messages as, so they can spot misroutes themselves.
  //
  // Query params:
  //   limit  — how many rows (default 100, max 500)
  //   userId — filter to a single user
  //   intent — filter by intent category
  //   since  — ISO date; default 7 days ago
  app.get("/api/admin/activity", requireAdminKey, async (req: any, res) => {
    try {
      const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || "100"))));
      const userId = typeof req.query.userId === "string" && req.query.userId.trim() ? String(req.query.userId) : null;
      const intent = typeof req.query.intent === "string" && req.query.intent.trim() ? String(req.query.intent) : null;
      const sinceRaw = typeof req.query.since === "string" && req.query.since.trim() ? String(req.query.since) : null;
      const since = sinceRaw ? new Date(sinceRaw) : new Date(Date.now() - 7 * 86400_000);
      const sinceValid = !isNaN(since.getTime()) ? since : new Date(Date.now() - 7 * 86400_000);

      const conditions: any[] = [gte(chatHistory.createdAt, sinceValid)];
      if (userId) conditions.push(eq(chatHistory.userId, userId));
      if (intent) conditions.push(eq(chatHistory.intent, intent));

      const rows = await db
        .select({
          id: chatHistory.id,
          userId: chatHistory.userId,
          name: users.name,
          phone: users.phoneNumber,
          messageIn: chatHistory.messageIn,
          messageOut: chatHistory.messageOut,
          intent: chatHistory.intent,
          createdAt: chatHistory.createdAt,
        })
        .from(chatHistory)
        .leftJoin(users, eq(chatHistory.userId, users.id))
        .where(and(...conditions))
        .orderBy(desc(chatHistory.createdAt))
        .limit(limit);

      // Intent histogram for quick misroute scanning
      const intentCounts = rows.reduce<Record<string, number>>((acc, r) => {
        const k = r.intent || "UNKNOWN";
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {});

      res.json({
        rows,
        count: rows.length,
        intentCounts,
        since: sinceValid.toISOString(),
        filters: { limit, userId, intent },
      });
    } catch (err: any) {
      console.error("[ADMIN] /api/admin/activity error:", err);
      res.status(500).json({ message: err.message || "Failed to fetch activity" });
    }
  });

  // ── Admin: HTML triage queue ("who needs help today") ──
  // Self-contained page (same sessionStorage key auth as /admin/activity) that
  // renders /api/triage as a red→yellow→green action list with one-tap WhatsApp.
  app.get("/admin/triage", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>KamLife — Triage</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { --bg:#0b0d10; --fg:#e8e8e8; --muted:#8a8f98; --card:#14171c; --row:#1a1e25; --red:#e5484d; --yellow:#f0a500; --green:#31d0aa; }
  * { box-sizing:border-box; } body { background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; margin:0; }
  header { padding:16px 20px; border-bottom:1px solid #22262c; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  .summary { display:flex; gap:8px; padding:12px 20px; border-bottom:1px solid #22262c; background:var(--card); flex-wrap:wrap; }
  .pill { border-radius:999px; padding:4px 12px; font-size:12px; font-weight:600; background:var(--row); }
  .pill.red { color:var(--red); } .pill.yellow { color:var(--yellow); } .pill.green { color:var(--green); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:10px 12px; border-bottom:1px solid #1d2026; vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:11px; letter-spacing:.05em; text-transform:uppercase; }
  tr:hover td { background:var(--row); }
  .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; }
  .dot.red { background:var(--red); } .dot.yellow { background:var(--yellow); } .dot.green { background:var(--green); }
  .who { font-weight:500; } .muted { color:var(--muted); }
  a.wa { color:var(--green); text-decoration:none; border:1px solid #2a2f37; border-radius:6px; padding:4px 8px; white-space:nowrap; }
  a.wa:hover { background:var(--row); }
  .empty,.error { padding:40px 20px; text-align:center; color:var(--muted); } .error { color:var(--red); }
  button { background:transparent; color:var(--muted); border:1px solid #2a2f37; border-radius:4px; padding:4px 10px; cursor:pointer; font:inherit; }
</style></head>
<body>
<header><h1>🚦 Triage — who needs help today</h1>
  <div class="muted"><span id="meta">Loading…</span> · <button id="refresh">refresh</button> · <button id="logout">logout</button></div>
</header>
<div class="summary" id="summary"></div>
<div id="content"><div class="empty">Loading…</div></div>
<script>
(function(){
  var KEY="kamlife-dashboard-key";
  function getKey(){ var k=sessionStorage.getItem(KEY); if(!k){ k=prompt("Dashboard key:"); if(k) sessionStorage.setItem(KEY,k); } return k; }
  function esc(s){ return String(s==null?"":s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;"); }
  var content=document.getElementById("content"), summary=document.getElementById("summary"), meta=document.getElementById("meta");
  function silentLabel(d){ return d==null?"never":(d===0?"today":d+"d"); }
  async function load(){
    var key=getKey(); if(!key){ content.innerHTML='<div class="error">No key.</div>'; return; }
    try {
      var resp=await fetch("/api/triage",{headers:{"x-dashboard-key":key}});
      if(resp.status===401){ sessionStorage.removeItem(KEY); content.innerHTML='<div class="error">Unauthorized — refresh to re-enter the key.</div>'; return; }
      if(!resp.ok){ content.innerHTML='<div class="error">HTTP '+resp.status+'</div>'; return; }
      render(await resp.json());
    } catch(e){ content.innerHTML='<div class="error">Error: '+esc(e.message||e)+'</div>'; }
  }
  function render(data){
    var s=data.summary||{red:0,yellow:0,green:0,total:0};
    meta.textContent=s.total+" clients";
    summary.innerHTML='<span class="pill red">🔴 '+s.red+' red</span><span class="pill yellow">🟡 '+s.yellow+' yellow</span><span class="pill green">🟢 '+s.green+' green</span>';
    var rows=(data.clients||[]);
    if(!rows.length){ content.innerHTML='<div class="empty">No clients in coaching yet.</div>'; return; }
    var html='<table><thead><tr><th>Status</th><th>Client</th><th>Why</th><th>Next action</th><th>Last seen</th><th>Sessions/7d</th><th></th></tr></thead><tbody>';
    rows.forEach(function(c){
      html+='<tr>'
        +'<td><span class="dot '+esc(c.level)+'"></span>'+esc(c.level)+'</td>'
        +'<td><span class="who">'+esc(c.name)+'</span><br><span class="muted">'+esc(c.phone)+'</span></td>'
        +'<td>'+esc(c.reason)+'</td>'
        +'<td>'+esc(c.nextAction)+'</td>'
        +'<td class="muted">'+silentLabel(c.daysSinceActive)+'</td>'
        +'<td class="muted">'+esc(c.workoutsLast7)+'</td>'
        +'<td><a class="wa" href="'+esc(c.waLink)+'" target="_blank" rel="noopener">WhatsApp →</a></td>'
        +'</tr>';
    });
    content.innerHTML=html+'</tbody></table>';
  }
  document.getElementById("refresh").onclick=load;
  document.getElementById("logout").onclick=function(){ sessionStorage.removeItem(KEY); location.reload(); };
  load();
})();
</script>
</body></html>`);
  });

  // ── Admin: HTML activity dashboard (browser-friendly view of the above) ──
  //
  // Auth model: the HTML shell is static (no secrets), and the fetch() call
  // that loads data prompts for the dashboard key and stores it in
  // sessionStorage so refreshes don't re-prompt. The JSON endpoint still
  // enforces timing-safe auth via the x-dashboard-key header.
  app.get("/admin/activity", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>KamLife — Activity Feed</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { --bg:#0b0d10; --fg:#e8e8e8; --muted:#8a8f98; --card:#14171c; --accent:#31d0aa; --warn:#f0a500; --err:#e5484d; --row:#1a1e25; }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; }
  header { padding: 16px 20px; border-bottom: 1px solid #22262c; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; }
  .meta { color: var(--muted); font-size: 12px; }
  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 12px 20px; border-bottom: 1px solid #22262c; background: var(--card); }
  .controls label { color: var(--muted); font-size: 12px; }
  .controls input, .controls select, .controls button { background: var(--bg); color: var(--fg); border: 1px solid #2a2f37; padding: 6px 10px; border-radius: 6px; font: inherit; }
  .controls button { background: var(--accent); color: #000; border: 0; cursor: pointer; font-weight: 600; }
  .controls button:hover { opacity: 0.9; }
  .histogram { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 20px; border-bottom: 1px solid #22262c; background: var(--card); }
  .chip { background: var(--row); border: 1px solid #2a2f37; border-radius: 999px; padding: 3px 10px; font-size: 12px; color: var(--muted); }
  .chip strong { color: var(--fg); margin-left: 4px; }
  .chip.warn { border-color: var(--warn); color: var(--warn); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #1d2026; vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; position: sticky; top: 0; background: var(--card); z-index: 1; }
  tr:hover td { background: var(--row); }
  .when { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .who { font-weight: 500; white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
  .phone { color: var(--muted); font-size: 11px; display: block; font-variant-numeric: tabular-nums; }
  .intent { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--row); color: var(--accent); white-space: nowrap; }
  .intent.unknown { color: var(--err); }
  .msg-in, .msg-out { max-width: 360px; overflow-wrap: anywhere; white-space: pre-wrap; }
  .msg-out { color: var(--muted); }
  .empty { padding: 40px 20px; text-align: center; color: var(--muted); }
  .error { padding: 20px; color: var(--err); }
</style>
</head>
<body>
<header>
  <div>
    <h1>📡 Activity feed</h1>
    <div class="meta" id="meta">Loading…</div>
  </div>
  <div class="meta">auto-refresh: <span id="refresh-state">on (30s)</span> · <button id="pause" style="background:transparent;color:var(--muted);border:1px solid #2a2f37;border-radius:4px;padding:2px 8px;cursor:pointer;">pause</button></div>
</header>
<div class="controls">
  <label>Limit <input id="f-limit" type="number" min="10" max="500" value="100" style="width:70px;" /></label>
  <label>Intent <input id="f-intent" type="text" placeholder="e.g. FOOD_LOG" style="width:120px;" /></label>
  <label>User ID <input id="f-user" type="text" placeholder="uuid" style="width:260px;" /></label>
  <label>Since <input id="f-since" type="datetime-local" /></label>
  <button id="apply">Apply</button>
  <button id="reset" style="background:transparent;color:var(--muted);border:1px solid #2a2f37;">Reset</button>
  <button id="logout" style="background:transparent;color:var(--err);border:1px solid #2a2f37;">Logout</button>
</div>
<div class="histogram" id="histogram"></div>
<div id="content"><div class="empty">Loading activity…</div></div>
<script>
(function() {
  const KEY_STORAGE = "kamlife-dashboard-key";
  function getKey() {
    let k = sessionStorage.getItem(KEY_STORAGE);
    if (!k) {
      k = prompt("Dashboard key:");
      if (k) sessionStorage.setItem(KEY_STORAGE, k);
    }
    return k;
  }

  const qs = (id) => document.getElementById(id);
  const fLimit = qs("f-limit"), fIntent = qs("f-intent"), fUser = qs("f-user"), fSince = qs("f-since");
  const content = qs("content"), histogram = qs("histogram"), meta = qs("meta"), refreshState = qs("refresh-state");
  let refreshTimer = null;
  let paused = false;

  function buildUrl() {
    const p = new URLSearchParams();
    if (fLimit.value) p.set("limit", fLimit.value);
    if (fIntent.value.trim()) p.set("intent", fIntent.value.trim());
    if (fUser.value.trim()) p.set("userId", fUser.value.trim());
    if (fSince.value) p.set("since", new Date(fSince.value).toISOString());
    return "/api/admin/activity?" + p.toString();
  }

  async function load() {
    const key = getKey();
    if (!key) { content.innerHTML = '<div class="error">No dashboard key provided.</div>'; return; }
    try {
      const resp = await fetch(buildUrl(), { headers: { "x-dashboard-key": key } });
      if (resp.status === 401) {
        sessionStorage.removeItem(KEY_STORAGE);
        content.innerHTML = '<div class="error">Unauthorized — refresh to re-enter the key.</div>';
        return;
      }
      if (!resp.ok) { content.innerHTML = '<div class="error">HTTP ' + resp.status + '</div>'; return; }
      const data = await resp.json();
      render(data);
    } catch (e) {
      content.innerHTML = '<div class="error">Error: ' + (e.message || e) + '</div>';
    }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
      .replaceAll('"',"&quot;").replaceAll("'","&#39;");
  }

  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const now = Date.now();
    const mins = Math.floor((now - d.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    return d.toLocaleString("en-ZA", { dateStyle: "short", timeStyle: "short" });
  }

  function render(data) {
    meta.textContent = data.count + " rows · since " + new Date(data.since).toLocaleString("en-ZA");
    const intents = Object.entries(data.intentCounts || {}).sort((a,b) => b[1] - a[1]);
    histogram.innerHTML = intents.length
      ? intents.map(([k, v]) => '<span class="chip' + (k === "UNKNOWN" ? " warn" : "") + '">' + esc(k) + '<strong>' + v + '</strong></span>').join("")
      : '<span class="chip">no data</span>';

    if (!data.rows || !data.rows.length) {
      content.innerHTML = '<div class="empty">No activity in the selected window.</div>';
      return;
    }
    const rowsHtml = data.rows.map(r => {
      const intentClass = r.intent === "UNKNOWN" || !r.intent ? "intent unknown" : "intent";
      const phone = r.phone ? r.phone.replace(/^whatsapp:/, "") : "";
      return '<tr>' +
        '<td class="when">' + esc(fmtTime(r.createdAt)) + '</td>' +
        '<td class="who">' + esc(r.name || "—") + '<span class="phone">' + esc(phone) + '</span></td>' +
        '<td><span class="' + intentClass + '">' + esc(r.intent || "UNKNOWN") + '</span></td>' +
        '<td class="msg-in">' + esc(r.messageIn || "") + '</td>' +
        '<td class="msg-out">' + esc((r.messageOut || "").slice(0, 200)) + '</td>' +
      '</tr>';
    }).join("");
    content.innerHTML = '<table><thead><tr>' +
      '<th style="width:90px;">When</th>' +
      '<th style="width:160px;">Who</th>' +
      '<th style="width:120px;">Intent</th>' +
      '<th>Inbound</th>' +
      '<th>Outbound (trunc)</th>' +
      '</tr></thead><tbody>' + rowsHtml + '</tbody></table>';
  }

  function tick() {
    if (!paused) load();
  }

  qs("apply").addEventListener("click", load);
  qs("reset").addEventListener("click", () => {
    fLimit.value = "100"; fIntent.value = ""; fUser.value = ""; fSince.value = "";
    load();
  });
  qs("logout").addEventListener("click", () => {
    sessionStorage.removeItem(KEY_STORAGE);
    location.reload();
  });
  qs("pause").addEventListener("click", () => {
    paused = !paused;
    qs("pause").textContent = paused ? "resume" : "pause";
    refreshState.textContent = paused ? "paused" : "on (30s)";
  });

  load();
  refreshTimer = setInterval(tick, 30_000);
})();
</script>
</body>
</html>`);
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
        `Coach K check-in 💪 ${name ? name : "Hey"} — quick one: reply with today's steps, water, and meals so I can adjust your targets.`;

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

  // ── Admin: manually set subscription status for a phone number ──
  // Use to activate coach/owner account or override for testing.
  // POST /api/admin/set-subscription  { phone: "+27...", status: "active"|"trial"|"inactive" }
  app.post("/api/admin/set-subscription", requireAdminKey, async (req, res) => {
    try {
      const { phone, status } = req.body || {};
      if (!phone || !status) return res.status(400).json({ error: "phone and status required" });
      const allowed = ["active", "trial", "inactive"];
      if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });

      // Normalise phone to whatsapp: format for DB lookup
      const normalised = phone.startsWith("whatsapp:") ? phone : `whatsapp:+${phone.replace(/\D/g, "")}`;
      const result = await db
        .update(users)
        .set({ subscriptionStatus: status })
        .where(eq(users.phoneNumber, normalised))
        .returning({ id: users.id, name: users.name, phoneNumber: users.phoneNumber, subscriptionStatus: users.subscriptionStatus });

      if (!result.length) {
        return res.status(404).json({ error: `No user found with phone ${normalised}` });
      }

      console.log(`[ADMIN] set-subscription phone=${normalised} status=${status} by admin`);
      return res.json({ success: true, user: result[0] });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to update subscription" });
    }
  });

  // ── Food photo training data export ──
  //
  // Returns all photo-sourced meal logs as a structured JSON dataset suitable
  // for model fine-tuning. Never includes photoBase64, userId, or phone numbers.
  // Only rows where source = 'photo' are included.
  app.get("/api/admin/export/food-training-data", requireAdminKey, async (_req, res) => {
    try {
      const rows = await db
        .select({
          loggedAt: mealLogs.loggedAt,
          source: mealLogs.source,
          items: mealLogs.items,
          corrected: mealLogs.corrected,
          kcal: mealLogs.kcalInt,
          protein: mealLogs.proteinInt,
          rawMessage: mealLogs.rawMessage,
        })
        .from(mealLogs)
        .where(eq(mealLogs.source, "photo"))
        .orderBy(desc(mealLogs.loggedAt));

      const records = rows.map((r) => {
        const itemsArray = Array.isArray(r.items) ? r.items as Array<{ name?: string }> : [];
        const identified = itemsArray.map((i) => i?.name).filter(Boolean) as string[];
        return {
          logged_at: r.loggedAt ? new Date(r.loggedAt).toISOString() : null,
          source: r.source,
          identified_as: identified,
          corrected: r.corrected,
          kcal: r.kcal,
          protein: r.protein,
          raw_message: r.rawMessage ?? "photo",
        };
      });

      console.log(`[ADMIN AUDIT] GET /api/admin/export/food-training-data — ${records.length} records — ${new Date().toISOString()}`);

      res.json({
        exported_at: new Date().toISOString().slice(0, 10),
        total_photos: records.length,
        records,
      });
    } catch (err: any) {
      console.error("[ADMIN] food-training-data export error:", err);
      res.status(500).json({ error: err.message || "Failed to export training data" });
    }
  });

  // ── Admin: test voice note generation + optional send ──
  // POST /api/admin/test-voice  { phone?: "+27...", script?: "..." }
  // Returns { url } so you can paste it in a browser to verify audio works.
  // If phone is provided, also sends the audio to that WhatsApp number.
  app.post("/api/admin/test-voice", requireAdminKey, async (req, res) => {
    try {
      const { phone, script } = req.body || {};
      const text = (typeof script === "string" && script.trim())
        ? script.trim()
        : "Coach K voice note test. If you can hear this, voice notes are working correctly on this deployment. Sharp.";

      const url = await generateVoiceNote(text);
      if (!url) {
        return res.status(500).json({
          error: "Voice note generation failed — check APP_URL and AI_INTEGRATIONS_OPENAI_API_KEY env vars",
          appUrl: process.env.APP_URL || process.env.APP_BASE_URL || "(not set)",
          openaiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ? "set" : "(not set)",
        });
      }

      let sent = false;
      let sendError: string | null = null;
      if (phone) {
        const normalised = phone.startsWith("whatsapp:") ? phone : `whatsapp:+${String(phone).replace(/\D/g, "")}`;
        try {
          await sendWhatsApp(normalised, "", url);
          sent = true;
        } catch (e: any) {
          sendError = e.message || "Twilio send failed";
        }
      }

      console.log(`[ADMIN] test-voice url=${url} sent=${sent} phone=${phone || "none"}`);
      return res.json({ success: true, url, sent, sendError });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Failed to generate voice note" });
    }
  });

  // ── Export users as CSV ──
  app.get("/api/admin/export/users", requireAdminKey, async (_req, res) => {
    try {
      const all = await db.select({
        id: users.id,
        name: users.name,
        phoneNumber: users.phoneNumber,
        goalType: users.goalType,
        trainingMode: users.trainingMode,
        subscriptionStatus: users.subscriptionStatus,
        onboardingState: users.onboardingState,
        calorieTarget: users.calorieTarget,
        proteinTarget: users.proteinTarget,
        currentWeight: users.currentWeight,
        programmeWeek: users.programmeWeek,
        workoutStreak: users.workoutStreak,
        totalWorkoutsCompleted: users.totalWorkoutsCompleted,
        lastActiveAt: users.lastActiveAt,
        createdAt: users.createdAt,
        subscriptionRenewsAt: users.subscriptionRenewsAt,
      }).from(users).orderBy(desc(users.createdAt));

      const header = "id,name,phone,goal,mode,status,onboarding,cal_target,prot_target,weight_kg,programme_week,workout_streak,total_workouts,last_active,created_at,renews_at";
      const rows = all.map(u => [
        u.id,
        `"${(u.name || "").replace(/"/g, '""')}"`,
        `"${(u.phoneNumber || "").replace(/^whatsapp:/, "")}"`,
        u.goalType || "",
        u.trainingMode || "",
        u.subscriptionStatus || "",
        u.onboardingState || "",
        u.calorieTarget || "",
        u.proteinTarget || "",
        u.currentWeight || "",
        u.programmeWeek || "",
        u.workoutStreak || "",
        u.totalWorkoutsCompleted || "",
        u.lastActiveAt ? new Date(u.lastActiveAt).toISOString().slice(0, 10) : "",
        u.createdAt ? new Date(u.createdAt).toISOString().slice(0, 10) : "",
        u.subscriptionRenewsAt ? new Date(u.subscriptionRenewsAt).toISOString().slice(0, 10) : "",
      ].join(","));

      const csv = [header, ...rows].join("\n");
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="kamlife-users-${date}.csv"`);
      return res.send(csv);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || "Export failed" });
    }
  });

  // ── POPIA data subject access request — full personal data export ──
  // Produces a JSON blob of every table row for this user, suitable for
  // emailing in response to a POPIA Section 23 access request. Admin only.
  app.get("/api/admin/user/:id/export", requireAdminKey, async (req, res) => {
    const userId = req.params.id;
    try {
      const [profile] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!profile) return res.status(404).json({ error: "User not found" });

      const [chats, steps, workouts, weights, meals, measurements, photos, weeklies, clothing, exercises, actions] =
        await Promise.all([
          db.select().from(chatHistory).where(eq(chatHistory.userId, userId)),
          db.select().from(stepLogs).where(eq(stepLogs.userId, userId)),
          db.select().from(workoutLogs).where(eq(workoutLogs.userId, userId)),
          db.select().from(weightLogs).where(eq(weightLogs.userId, userId)),
          db.select().from(mealLogs).where(eq(mealLogs.userId, userId)),
          db.select().from(bodyMeasurements).where(eq(bodyMeasurements.userId, userId)),
          db.select({ id: progressPhotos.id, photoNumber: progressPhotos.photoNumber, contentType: progressPhotos.contentType, loggedAt: progressPhotos.loggedAt }).from(progressPhotos).where(eq(progressPhotos.userId, userId)),
          db.select().from(weeklyCheckins).where(eq(weeklyCheckins.userId, userId)),
          db.select().from(clothingCheckins).where(eq(clothingCheckins.userId, userId)),
          db.select().from(exerciseLogs).where(eq(exerciseLogs.userId, userId)),
          db.select().from(clientActions).where(eq(clientActions.userId, userId)),
        ]);

      const exportData = {
        exportedAt: new Date().toISOString(),
        exportedBy: "admin",
        profile: { ...profile, progressPhotoBase64: "[redacted — use /progress-photos endpoint]" },
        chatHistory: chats,
        stepLogs: steps,
        workoutLogs: workouts,
        weightLogs: weights,
        mealLogs: meals,
        bodyMeasurements: measurements,
        progressPhotos: photos,
        weeklyCheckins: weeklies,
        clothingCheckins: clothing,
        exerciseLogs: exercises,
        clientActions: actions,
      };

      console.log(`[ADMIN AUDIT] POPIA EXPORT — user ${userId} — ${new Date().toISOString()}`);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="popia-export-${userId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json"`);
      return res.json(exportData);
    } catch (err: any) {
      console.error("[ADMIN] POPIA export error:", err);
      return res.status(500).json({ error: err.message || "Export failed" });
    }
  });

  // ---- SCALING RADAR — milestone playbook + live counts for the founder dashboard ----
  app.get("/api/admin/scaling", requireAdminKey, async (_req, res) => {
    try {
      const now = new Date();
      const [clientRow] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(
        and(
          eq(users.onboardingState, "COMPLETE"),
          or(
            eq(users.subscriptionStatus, "active"),
            and(eq(users.subscriptionStatus, "trial"), gte(users.betaBypassUntil, now)),
          ),
        ),
      );
      const activeClients = clientRow?.n ?? 0;

      const dayAgo = new Date(Date.now() - 24 * 3600_000);
      const [msgRow] = await db.select({ n: sql<number>`count(*)::int` }).from(chatHistory)
        .where(gte(chatHistory.createdAt, dayAgo));

      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const [costRow] = await db.select({ usd: sql<string>`coalesce(sum(cost_usd), 0)` }).from(gptCosts)
        .where(gte(gptCosts.createdAt, monthStart));
      const gptMonthUsd = parseFloat(costRow?.usd || "0");
      const gptMonthZar = Math.round(gptMonthUsd * 18.5 * 100) / 100; // same USD→ZAR rate the cost logger uses

      return res.json({
        activeClients,
        messages24h: msgRow?.n ?? 0,
        gptMonthZar,
        gptPerClientZar: activeClients > 0 ? Math.round((gptMonthZar / activeClients) * 100) / 100 : 0,
        config: {
          dbPoolMax: Math.max(5, Number(process.env.DB_POOL_MAX) || 25),
          sendRatePerSec: Math.max(1, Number(process.env.SCHEDULER_SEND_RATE_PER_SEC) || 10),
          proactivePaused: String(process.env.PROACTIVE_PAUSED || "").toLowerCase() === "true",
        },
        milestones: evaluateScaling(activeClients),
      });
    } catch (err: any) {
      console.error("[ADMIN] scaling radar error:", err);
      return res.status(500).json({ error: err.message || "scaling radar failed" });
    }
  });
}

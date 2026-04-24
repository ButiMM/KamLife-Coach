import type { Express } from "express";
import { db } from "../db";
import { users, weightLogs, workoutLogs, stepLogs, chatHistory, mealLogs, escalations, clientActions, progressPhotos } from "../../shared/schema";
import { eq, desc, asc, and, gte, isNull, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import twilio from "twilio";
import { requireAdminKey } from "./auth";
import type { RouteDeps } from "./types";
import { sendWhatsApp } from "../scheduler";

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

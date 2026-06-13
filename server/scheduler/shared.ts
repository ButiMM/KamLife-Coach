/**
 * Shared utilities for all scheduler jobs.
 * Import from here — never import from scheduler.ts inside a job file.
 */

import twilio from "twilio";
import { isTwilioCircuitOpen, recordTwilioSuccess, recordTwilioFailure, sastDayStart } from "../utils";
import { db, pool } from "../db";
import { users, chatHistory, stepLogs, workoutLogs, weightLogs, mealLogs, sentProactive, escalations, exerciseLogs, clientIntelligenceProfiles } from "../../shared/schema";
import { eq, gte, and, lt, desc, or, sql, like } from "drizzle-orm";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { routineNudgeAllowed, dayOfYearSAST } from "./nudge-policy";

export { db, pool };
export { users, chatHistory, stepLogs, workoutLogs, weightLogs, mealLogs, sentProactive, escalations, exerciseLogs, clientIntelligenceProfiles };
export { abExperiments, abAssignments } from "../../shared/schema";
export { eq, gte, and, lt, desc, or, sql, sastDayStart };

// ── Re-export heavy deps job files need ──────────────────────────────────────
export { default as twilio } from "twilio";
export { generateVoiceNote } from "../tts";
export { getKamlifeProgramme } from "../programme";
export { getShoppingList, formatShoppingList } from "../shopping-lists";
export { PRICING } from "../../shared/pricing";
export { selectVariantMessage, recordDelivery } from "../ab";
export { asc, lte, count, inArray } from "drizzle-orm";

// ============================================================
// SCHEDULER STATE — persists last-run dates across restarts
// ============================================================

export const STATE_FILE = join(process.cwd(), "server", ".scheduler-state.json");

export function loadState(): Record<string, string> {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch { /* ignore */ }
  return {};
}

export function saveState(key: string, dateStr: string): void {
  try {
    const state = loadState();
    state[key] = dateStr;
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (e) {
    console.error("[SCHEDULER] State save error:", e);
  }
}

export function todaySAST(): string {
  const sast = new Date(Date.now() + 2 * 3_600_000);
  return sast.toISOString().slice(0, 10);
}

export function todayUTC(): string { return todaySAST(); }

export function hasRunToday(key: string, dateStr: string): boolean {
  return loadState()[key] === dateStr;
}

export function thisWeekUTC(): string {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
  return monday.toISOString().slice(0, 10);
}

// ── DB-BACKED DAILY PROACTIVE BUDGET ─────────────────────────────────────────

// PROACTIVE_PAUSED=true → all proactive sends blocked immediately (hot killswitch)
export function isProactivePaused(): boolean {
  return process.env.PROACTIVE_PAUSED === "true";
}

// ── UNIFIED PROACTIVE BUDGET ──────────────────────────────────────────────────
// One per-user daily ceiling that EVERY coaching job shares. Previously
// claimDailySlot enforced a hard 1/day (the DAILY_CAP sentinel) while claimProactive
// jobs (weekly report, NSV, silence, weekend audit, buddy, …) bypassed it entirely —
// so an engaged user could be hit by 5+ messages on a busy Sunday. Over-messaging is
// the #1 driver of WhatsApp blocks (which crater sender quality and risk a number
// ban) and a top-3 driver of churn ("nagging"). We cap total daily proactive volume;
// cron ordering means the morning anchor (6am) and weekly summaries (7–8am) claim
// their slots first, and the low-value tail is what gets cut.
//
// Billing/critical alerts use claimCritical(), which deliberately ignores this
// budget — money messages must always flow.
//
// Restart-safe: each consumed slot is an atomic DAILY_CAP_<n> row insert, so a
// container recycle can't grant extra slots. The in-memory count is the fast path
// and is hydrated from the DB on startup.
export const DAILY_PROACTIVE_CAP = Math.max(1, Number(process.env.MAX_PROACTIVE_PER_DAY) || 3);
export const dailyProactiveCount = new Map<string, number>(); // `${today}:${clientId}` → sends today

export function dailyKey(clientId: string): string {
  return `${todaySAST()}:${clientId}`;
}

function dailyCountOf(clientId: string): number {
  return dailyProactiveCount.get(dailyKey(clientId)) || 0;
}
function bumpDailyCount(clientId: string): void {
  const k = dailyKey(clientId);
  dailyProactiveCount.set(k, (dailyProactiveCount.get(k) || 0) + 1);
}

// Atomically consume one slot of the shared daily budget. Returns false once the
// user has hit the cap today. Each slot is a distinct DAILY_CAP_<n> row, so the
// test-and-set is atomic and survives restarts.
async function consumeDailyBudget(clientId: string): Promise<boolean> {
  if (dailyCountOf(clientId) >= DAILY_PROACTIVE_CAP) return false;
  const today = todaySAST();
  for (let slot = 1; slot <= DAILY_PROACTIVE_CAP; slot++) {
    try {
      const ins = await db.insert(sentProactive)
        .values({ userId: clientId, messageKey: `DAILY_CAP_${slot}`, dedupeWindow: today })
        .onConflictDoNothing()
        .returning({ id: sentProactive.id });
      if (ins.length) { bumpDailyCount(clientId); return true; }
      // slot taken — try the next one
    } catch (e) {
      // DB unavailable — degrade to the in-memory budget so we still cap
      if (dailyCountOf(clientId) >= DAILY_PROACTIVE_CAP) return false;
      bumpDailyCount(clientId);
      return true;
    }
  }
  return false; // every slot taken today
}

export async function claimDailySlot(clientId: string, jobKey: string): Promise<boolean> {
  if (isProactivePaused()) {
    console.log(`[SCHEDULER:PAUSED] ${jobKey} blocked — PROACTIVE_PAUSED=true`);
    return false;
  }
  const today = todaySAST();
  try {
    // Per-job dedup (restart-safe): only the first call for (job, user, day) wins.
    const jobIns = await db.insert(sentProactive)
      .values({ userId: clientId, messageKey: jobKey, dedupeWindow: today })
      .onConflictDoNothing()
      .returning({ id: sentProactive.id });
    if (!jobIns.length) return false; // this job already fired for this user today
    // Then the shared daily ceiling.
    if (!(await consumeDailyBudget(clientId))) return false;
    console.log(`[SCHEDULER:SEND] campaign=${jobKey} user=...${clientId.slice(-6)}`);
    return true;
  } catch (err) {
    console.warn(`[claimDailySlot] DB error (${jobKey}/${clientId.slice(0, 8)}):`, err);
    // DB down — best-effort in-memory budget only
    if (dailyCountOf(clientId) >= DAILY_PROACTIVE_CAP) return false;
    bumpDailyCount(clientId);
    return true;
  }
}

export function canSendProactive(clientId: string): boolean {
  if (isProactivePaused()) return false;
  return dailyCountOf(clientId) < DAILY_PROACTIVE_CAP;
}

// ── ENGAGEMENT BACK-OFF FOR ROUTINE NUDGES ───────────────────────────────────
// Routine nudges (hydration, evening "did you log?" reminders) ease off as a
// client goes quiet. This protects against WhatsApp mutes and cuts message cost
// at scale — we stop paying to message people who have checked out.
//
// IMPORTANT: win-back / retention jobs deliberately target silent users and must
// NOT use this — they call canSendProactive directly. This is for routine,
// "nice-to-have" daily nudges only.
//
// The pure cadence decision lives in ./nudge-policy (no DB import) so it stays
// unit-testable without a database. Re-exported here for existing callers.
export { routineNudgeAllowed, dayOfYearSAST };

export function canSendRoutineNudge(client: { id: string; lastActiveAt?: Date | string | null }): boolean {
  if (!canSendProactive(client.id)) return false;
  const daysSilent = client.lastActiveAt
    ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
    : 0;
  return routineNudgeAllowed(daysSilent, dayOfYearSAST());
}

// Telemetry only — the preceding claim (claimProactive/claimDailySlot) has already
// consumed the daily budget, so this just records the send for visibility.
export function recordProactiveSend(clientId: string, jobKey = "proactive"): void {
  console.log(`[SCHEDULER:SEND] campaign=${jobKey} user=...${clientId.slice(-6)}`);
  db.insert(sentProactive)
    .values({ userId: clientId, messageKey: jobKey, dedupeWindow: todaySAST() })
    .onConflictDoNothing()
    .catch(e => console.warn("[recordProactiveSend] DB write failed (non-fatal):", e));
}

// Per-message-key dedupe (weekly/monthly windows)
export const weeklyKeyedSent = new Map<string, true>();

export function weeklyKeyedKey(clientId: string, messageKey: string, window: string): string {
  return `${window}:${clientId}:${messageKey}`;
}

// Proactive claim with per-(key, window) dedup. Now ALSO respects the shared daily
// budget so weekly/event jobs can no longer stack on top of the daily anchor — pass
// { critical: true } for the rare flagship send that must never be capped (e.g. the
// Sunday weekly report). Billing should use claimCritical(), not this.
export async function claimProactive(
  userId: string,
  messageKey: string,
  dedupeWindow: string,
  opts?: { critical?: boolean },
): Promise<boolean> {
  if (isProactivePaused()) return false;
  const inMemKey = weeklyKeyedKey(userId, messageKey, dedupeWindow);
  if (weeklyKeyedSent.has(inMemKey)) return false;
  try {
    const inserted = await db.insert(sentProactive)
      .values({ userId, messageKey, dedupeWindow })
      .onConflictDoNothing()
      .returning({ id: sentProactive.id });
    weeklyKeyedSent.set(inMemKey, true);
    if (inserted.length === 0) return false; // already claimed this key/window
    if (opts?.critical) { bumpDailyCount(userId); return true; }
    return await consumeDailyBudget(userId); // suppressed if over the daily cap
  } catch (e) {
    console.warn(`[claimProactive] DB error for ${messageKey}/${userId}:`, e);
    weeklyKeyedSent.set(inMemKey, true);
    if (opts?.critical) { bumpDailyCount(userId); return true; }
    if (dailyCountOf(userId) >= DAILY_PROACTIVE_CAP) return false;
    bumpDailyCount(userId);
    return true;
  }
}

// claimCritical — DB-backed dedupe for billing/critical alerts. Identical to
// claimProactive but deliberately ignores PROACTIVE_PAUSED: subscription and
// payment messages must keep flowing while coaching is paused. Guards against
// double-sends when a job re-runs the same day (file-based hasRunToday state
// does not survive Railway redeploys).
export async function claimCritical(userId: string, messageKey: string, dedupeWindow: string): Promise<boolean> {
  const inMemKey = weeklyKeyedKey(userId, messageKey, dedupeWindow);
  if (weeklyKeyedSent.has(inMemKey)) return false;
  try {
    const inserted = await db.insert(sentProactive)
      .values({ userId, messageKey, dedupeWindow })
      .onConflictDoNothing()
      .returning({ id: sentProactive.id });
    weeklyKeyedSent.set(inMemKey, true);
    return inserted.length > 0;
  } catch (e) {
    console.warn(`[claimCritical] DB error for ${messageKey}/${userId}:`, e);
    weeklyKeyedSent.set(inMemKey, true);
    return true;
  }
}

// Startup hydration — rebuild the per-user daily count from today's consumed slots
// (one DAILY_CAP_<n> row per message sent), so the budget survives a restart.
(async () => {
  try {
    const today = todaySAST();
    const slotsToday = await db
      .select({ userId: sentProactive.userId })
      .from(sentProactive)
      .where(and(eq(sentProactive.dedupeWindow, today), like(sentProactive.messageKey, "DAILY_CAP_%")));
    for (const row of slotsToday) bumpDailyCount(row.userId);
    console.log(`[SCHEDULER] Daily budget hydrated: ${slotsToday.length} slots used today across ${dailyProactiveCount.size} clients`);
  } catch (e) {
    console.warn("[SCHEDULER] Budget hydration failed (non-fatal):", e);
  }
})();

// ── TWILIO ────────────────────────────────────────────────────────────────────

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
export const FROM_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER
  ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}`
  : "";

// SMS_FROM: set TWILIO_SMS_NUMBER to a Twilio phone number (e.g. +27XXXXXXXXX or a shortcode).
// When WhatsApp delivery fails with a channel error, critical alerts fall back to SMS.
// SMS works on every SA phone — no data, no app, no WhatsApp account required.
const SMS_FROM = process.env.TWILIO_SMS_NUMBER || "";

// Twilio error codes that mean "WhatsApp channel is unavailable for this recipient"
// (not transient network errors — these won't resolve with retry)
const WA_CHANNEL_ERRORS = new Set([
  63003, // Channel not available
  63007, // User not opted in to WhatsApp
  63016, // Message not allowed
  21408, // Region not permitted
]);

async function sendSMSFallback(to: string, body: string): Promise<void> {
  if (!SMS_FROM) return;
  const smsTo = to.replace(/^whatsapp:/, "");
  // SMS messages truncated to 320 chars — enough for an alert, not a coaching essay
  const smsBody = body.length > 320
    ? body.slice(0, 317) + "…"
    : body;
  try {
    await twilioClient.messages.create({ from: SMS_FROM, to: smsTo, body: smsBody });
    console.log(`[SMS:FALLBACK] → ${smsTo.slice(-8)}: ${smsBody.slice(0, 60)}…`);
  } catch (smsErr: unknown) {
    console.error(`[SMS:FALLBACK] ✗ SMS also failed for ${smsTo.slice(-8)}:`, (smsErr as any)?.message || smsErr);
  }
}

// sendCriticalAlert — use for subscription notices, account alerts, and service outages.
// Tries WhatsApp first, falls back to SMS if WhatsApp fails.
// DO NOT use for routine coaching responses — SMS coaching is not viable at full length.
export async function sendCriticalAlert(to: string, body: string): Promise<void> {
  try {
    await sendWhatsApp(to, body);
  } catch {
    console.warn(`[ALERT] WhatsApp failed for ${to.slice(-8)} — attempting SMS fallback`);
    await sendSMSFallback(to, body);
  }
}

export const deliveryStats = { sent: 0, failed: 0, lastReset: new Date().toISOString().slice(0, 10) };

function resetDeliveryStatsIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (deliveryStats.lastReset !== today) {
    deliveryStats.sent = 0;
    deliveryStats.failed = 0;
    deliveryStats.lastReset = today;
  }
}

// Scheduler-side rate limiter: caps outbound sends/second to Twilio so a burst
// window (e.g. the 6am morning fan-out across the whole base) can't spike the
// channel. Env-tunable (SCHEDULER_SEND_RATE_PER_SEC) so throughput can be raised
// as the userbase grows without a redeploy. Default 10/sec preserves prior behaviour.
// Webhook replies are NOT subject to this — only proactive scheduler sends.
let _lastSchedulerSendAt = 0;
const _sendRatePerSec = Math.max(1, Number(process.env.SCHEDULER_SEND_RATE_PER_SEC) || 10);
const SCHEDULER_MIN_GAP_MS = Math.round(1000 / _sendRatePerSec);

export async function sendWhatsApp(to: string, body: string, mediaUrl?: string): Promise<void> {
  resetDeliveryStatsIfNeeded();
  // Rate limit: enforce minimum gap between sends
  const now = Date.now();
  const gap = now - _lastSchedulerSendAt;
  if (gap < SCHEDULER_MIN_GAP_MS) {
    await new Promise(r => setTimeout(r, SCHEDULER_MIN_GAP_MS - gap));
  }
  _lastSchedulerSendAt = Date.now();

  if (!FROM_NUMBER) {
    console.warn("[SCHEDULER] TWILIO_WHATSAPP_NUMBER not set — skipping send");
    deliveryStats.failed++;
    return;
  }
  if (isTwilioCircuitOpen()) {
    deliveryStats.failed++;
    console.warn(`[CIRCUIT] Twilio circuit open — dropping send to ${to.slice(-8)}`);
    return;
  }
  const params: Record<string, unknown> = { from: FROM_NUMBER, to, body };
  if (mediaUrl) params.mediaUrl = [mediaUrl];
  const delays = [0, 3000, 8000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
    try {
      await twilioClient.messages.create(params as unknown as Parameters<typeof twilioClient.messages.create>[0]);
      recordTwilioSuccess();
      deliveryStats.sent++;
      console.log(`[SCHEDULER] → ${to.slice(-8)}: ${body.slice(0, 80)}…`);
      return;
    } catch (err: unknown) {
      const e = err as { status?: number; code?: number; message?: string };
      // WhatsApp channel errors — don't retry, attempt SMS fallback for this recipient
      if (e?.code && WA_CHANNEL_ERRORS.has(e.code)) {
        recordTwilioFailure();
        deliveryStats.failed++;
        console.warn(`[WA:CHANNEL_ERROR] code=${e.code} for ${to.slice(-8)} — attempting SMS fallback`);
        await sendSMSFallback(to, body);
        return;
      }
      const isTransient = !e?.status || e.status >= 500 || (e.code as any) === "ECONNRESET" || (e.code as any) === "ETIMEDOUT";
      if (!isTransient || i === delays.length - 1) {
        recordTwilioFailure();
        deliveryStats.failed++;
        console.error(`[SCHEDULER] ✗ Failed to send to ${to.slice(-8)} after ${i + 1} attempt(s):`, e?.message || err);
        throw err;
      }
      console.warn(`[SCHEDULER] ⚠ Send attempt ${i + 1} failed (${e?.message}), retrying…`);
    }
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

// ── THROTTLED BATCH SEND ──────────────────────────────────────────────────────
// Sends to multiple users at a controlled rate (default: 10/sec).
// Prevents blasting Twilio with 500 API calls in one second during scheduled jobs.
export async function sendThrottled(
  targets: Array<{ phone: string; body: string; mediaUrl?: string }>,
  msPerMessage = 100, // 10 messages/second
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const t of targets) {
    try {
      await sendWhatsApp(t.phone, t.body, t.mediaUrl);
      sent++;
    } catch {
      failed++;
    }
    if (msPerMessage > 0) await new Promise(r => setTimeout(r, msPerMessage));
  }
  return { sent, failed };
}

// Proactive fan-out source for the scheduler jobs. Used ONLY by scheduler jobs
// (never by routes or reactive replies), which makes it the single chokepoint
// for the PROACTIVE_PAUSED killswitch: when paused this returns [], so every
// coaching job that loops over it — present and future — no-ops automatically.
// Billing/critical jobs that MUST keep running while coaching is paused (e.g.
// subscription renewal/expiry alerts) pass { ignorePause: true }.
export async function getActiveClients(opts?: { ignorePause?: boolean }) {
  if (!opts?.ignorePause && isProactivePaused()) {
    console.log("[SCHEDULER:PAUSED] getActiveClients → [] (PROACTIVE_PAUSED=true)");
    return [];
  }
  return db.select().from(users).where(
    and(
      eq(users.onboardingState, "COMPLETE"),
      or(
        eq(users.subscriptionStatus, "active"),
        and(
          eq(users.subscriptionStatus, "trial"),
          gte(users.betaBypassUntil, new Date())
        )
      )
    )
  );
}

export function isPaused(client: { profileNotes?: string | null }): boolean {
  const notes = client.profileNotes || "";
  const match = notes.match(/paused_until:(\d{4}-\d{2}-\d{2})/);
  if (!match) return false;
  return new Date(match[1]) >= new Date(todayUTC());
}

export function dayStart(offsetDays = 0): Date {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return sastDayStart(d);
}

export async function getYesterdayLogs(userId: string) {
  const start = dayStart(-1);
  const end = dayStart(0);
  return db.select().from(chatHistory).where(
    and(eq(chatHistory.userId, userId), gte(chatHistory.createdAt, start), lt(chatHistory.createdAt, end))
  ).limit(20);
}

export async function getTodayLogs(userId: string) {
  return db.select().from(chatHistory).where(
    and(eq(chatHistory.userId, userId), gte(chatHistory.createdAt, dayStart(0)))
  ).limit(1);
}

export const TRAINING_SCHEDULES: Record<number, number[]> = {
  2: [1, 4],
  3: [1, 3, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 4, 5],
  6: [1, 2, 3, 4, 5, 6],
};

export function programmeDaysSince(startDate: Date | null | undefined): number {
  if (!startDate) return 0;
  return Math.floor((Date.now() - new Date(startDate).getTime()) / 86_400_000);
}

export const SICK_PATTERNS = /\b(sick|flu|fever|ill|cold|vomit|nausea|nauseous|diarrhea|diarrhoea|hospital|doctor|clinic|injured|injury|hurt|sprain|strain|pulled|torn|not feeling|feeling sick|feel sick|feeling bad|unwell|too sick|got sick|i am sick|i'm sick|im sick|still sick|rest day|can't train|cant train|cannot train|no training|skip.*gym|skip.*workout|miss.*gym|miss.*workout)\b/i;

export async function wasSickOrInjured(userId: string, since: Date): Promise<boolean> {
  const recentMessages = await db
    .select({ messageIn: chatHistory.messageIn })
    .from(chatHistory)
    .where(and(eq(chatHistory.userId, userId), gte(chatHistory.createdAt, since)))
    .orderBy(desc(chatHistory.createdAt))
    .limit(20);
  return recentMessages.some(row => row.messageIn && SICK_PATTERNS.test(row.messageIn));
}

export async function isSickOrInjuredToday(userId: string): Promise<boolean> {
  return wasSickOrInjured(userId, dayStart(0));
}

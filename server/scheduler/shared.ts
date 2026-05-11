/**
 * Shared utilities for all scheduler jobs.
 * Import from here — never import from scheduler.ts inside a job file.
 */

import twilio from "twilio";
import { isTwilioCircuitOpen, recordTwilioSuccess, recordTwilioFailure, sastDayStart } from "../utils";
import { db, pool } from "../db";
import { users, chatHistory, stepLogs, workoutLogs, weightLogs, mealLogs, sentProactive, escalations } from "../../shared/schema";
import { eq, gte, and, lt, desc, or, sql } from "drizzle-orm";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export { db, pool };
export { users, chatHistory, stepLogs, workoutLogs, weightLogs, mealLogs, sentProactive, escalations };
export { abExperiments, abAssignments } from "../../shared/schema";
export { eq, gte, and, lt, desc, or, sql, sastDayStart };

// ── Re-export heavy deps job files need ──────────────────────────────────────
export { default as twilio } from "twilio";
export { generateVoiceNote } from "../tts";
export { getKamlifeProgramme } from "../programme";
export { getShoppingList, formatShoppingList } from "../shopping-lists";
export { PRICING } from "../../shared/pricing";
export { selectVariantMessage, recordDelivery } from "../ab";
export { asc, lte, count } from "drizzle-orm";

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

export const dailySentThisProcess = new Set<string>();

export function dailyKey(clientId: string): string {
  return `${todaySAST()}:${clientId}`;
}

export async function claimDailySlot(clientId: string, jobKey: string): Promise<boolean> {
  if (isProactivePaused()) {
    console.log(`[SCHEDULER:PAUSED] ${jobKey} blocked — PROACTIVE_PAUSED=true`);
    return false;
  }
  const today = todaySAST();
  if (dailySentThisProcess.has(dailyKey(clientId))) return false;
  try {
    const capInserted = await db
      .insert(sentProactive)
      .values({ userId: clientId, messageKey: "DAILY_CAP", dedupeWindow: today })
      .onConflictDoNothing()
      .returning({ id: sentProactive.id });
    if (!capInserted.length) return false;
    await db
      .insert(sentProactive)
      .values({ userId: clientId, messageKey: jobKey, dedupeWindow: today })
      .onConflictDoNothing();
    dailySentThisProcess.add(dailyKey(clientId));
    console.log(`[SCHEDULER:SEND] campaign=${jobKey} user=...${clientId.slice(-6)}`);
    return true;
  } catch (err) {
    console.warn(`[claimDailySlot] DB error (${jobKey}/${clientId.slice(0, 8)}):`, err);
    if (dailySentThisProcess.has(dailyKey(clientId))) return false;
    dailySentThisProcess.add(dailyKey(clientId));
    return true;
  }
}

export function canSendProactive(clientId: string): boolean {
  if (isProactivePaused()) return false;
  return !dailySentThisProcess.has(dailyKey(clientId));
}

export function recordProactiveSend(clientId: string, jobKey = "proactive"): void {
  console.log(`[SCHEDULER:SEND] campaign=${jobKey} user=...${clientId.slice(-6)}`);
  dailySentThisProcess.add(dailyKey(clientId));
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

export async function claimProactive(userId: string, messageKey: string, dedupeWindow: string): Promise<boolean> {
  if (isProactivePaused()) return false;
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
    console.warn(`[claimProactive] DB error for ${messageKey}/${userId}:`, e);
    weeklyKeyedSent.set(inMemKey, true);
    return true;
  }
}

// Startup hydration — repopulate in-memory set from today's DB records
(async () => {
  try {
    const today = todaySAST();
    const sentToday = await db
      .select({ userId: sentProactive.userId })
      .from(sentProactive)
      .where(eq(sentProactive.dedupeWindow, today));
    for (const row of sentToday) dailySentThisProcess.add(dailyKey(row.userId));
    console.log(`[SCHEDULER] Daily budget hydrated: ${sentToday.length} clients already sent today`);
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

export async function sendWhatsApp(to: string, body: string, mediaUrl?: string): Promise<void> {
  resetDeliveryStatsIfNeeded();
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
      await twilioClient.messages.create(params as Parameters<typeof twilioClient.messages.create>[0]);
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

export async function getActiveClients() {
  const now = new Date();
  return db.select().from(users).where(
    and(
      eq(users.onboardingState, "COMPLETE"),
      or(
        eq(users.subscriptionStatus, "active"),
        eq(users.subscriptionStatus, "trial"),
        gte(users.betaBypassUntil, now)
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

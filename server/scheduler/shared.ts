/**
 * Shared utilities for all scheduler jobs.
 * Import from here — never import from scheduler.ts inside a job file.
 */

import twilio from "twilio";
import { isTwilioCircuitOpen, recordTwilioSuccess, recordTwilioFailure, sastDayStart, buildContentVariables, splitWhatsAppBody } from "../utils";
import { db, pool } from "../db";
import { users, chatHistory, stepLogs, workoutLogs, weightLogs, mealLogs, sentProactive, escalations, exerciseLogs, clientIntelligenceProfiles } from "../../shared/schema";
import { eq, gte, and, lt, desc, or, sql, like } from "drizzle-orm";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { schedulerState } from "../../shared/schema";
import { routineNudgeAllowed, dayOfYearSAST } from "./nudge-policy";
import { checkOutboundMessage } from "../verifiers/proactive-gate";
import { provenanceGate, shadowDoor } from "../verifiers/response-gate";
import { humanizeReply } from "../reply-hygiene";
import { templateSid, WINDOW_RECOVERY_TEMPLATE } from "../whatsapp-templates";

export { db, pool };
export { users, chatHistory, stepLogs, workoutLogs, weightLogs, mealLogs, sentProactive, escalations, exerciseLogs, clientIntelligenceProfiles };
export { abExperiments, abAssignments, processedWebhooks } from "../../shared/schema";
export { eq, gte, and, lt, desc, or, sql, sastDayStart };

// ── Re-export heavy deps job files need ──────────────────────────────────────
export { default as twilio } from "twilio";
export { generateVoiceNote } from "../tts";
export { getKamlifeProgramme } from "../programme";
export { getShoppingList, formatShoppingList } from "../shopping-lists";
export { PRICING } from "../../shared/pricing";
export { selectVariantMessage, recordDelivery } from "../ab";
export { asc, lte, count, inArray, isNotNull } from "drizzle-orm";

// ============================================================
// SCHEDULER STATE — persists last-run dates across restarts
// ============================================================

export const STATE_FILE = join(process.cwd(), "server", ".scheduler-state.json");

// In-memory cache — populated from DB on startup, kept in sync on every saveState call.
// Survives container restarts because the DB is the source of truth.
const _stateCache = new Map<string, string>();

/** Hydrate in-memory state cache from DB. Call once on scheduler startup. */
export async function hydrateSchedulerStateFromDb(): Promise<void> {
  try {
    const rows = await db.select().from(schedulerState);
    for (const row of rows) _stateCache.set(row.key, row.value);
    // Also load the legacy file as fallback for any keys not yet in DB
    if (existsSync(STATE_FILE)) {
      const file = JSON.parse(readFileSync(STATE_FILE, "utf-8") || "{}");
      for (const [k, v] of Object.entries(file)) {
        if (!_stateCache.has(k) && typeof v === "string") _stateCache.set(k, v);
      }
    }
    console.log(`[SCHEDULER] State hydrated from DB: ${_stateCache.size} keys`);
  } catch (e) {
    console.error("[SCHEDULER] State hydration error:", e);
  }
}

export function loadState(): Record<string, string> {
  // Fast path: return from in-memory cache (hydrated from DB on startup)
  if (_stateCache.size > 0) {
    return Object.fromEntries(_stateCache);
  }
  // Cold-start fallback: read from file if cache not yet populated
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch { /* ignore */ }
  return {};
}

export function saveState(key: string, dateStr: string): void {
  // Update in-memory cache immediately (synchronous — zero latency for callers)
  _stateCache.set(key, dateStr);
  // Write to DB asynchronously — fire-and-forget (never blocks a scheduler job)
  db.insert(schedulerState)
    .values({ key, value: dateStr, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schedulerState.key, set: { value: dateStr, updatedAt: new Date() } })
    .catch(e => console.error("[SCHEDULER] State DB write error (non-fatal):", e?.message || e));
  // Also write to file as belt-and-suspenders backup
  try {
    const state = loadState();
    state[key] = dateStr;
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch { /* non-fatal */ }
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
  const d = new Date(Date.now() + 2 * 3_600_000); // SAST week boundary
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
// ONE A DAY (2026-07-28). At 3/day and 24 jobs a client could receive 21 unsolicited messages a
// week from a service they pay R199 for — every one a chance to be wrong, and until this week
// they were all state-blind. One good message beats three forgettable ones. Raise deliberately
// via MAX_PROACTIVE_PER_DAY if the data ever says people want more, not because a job exists.
export const DAILY_PROACTIVE_CAP = Math.max(1, Number(process.env.MAX_PROACTIVE_PER_DAY) || 1);
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
  // STATE GATE (2026-07-27, twice in one day): a water nudge landed minutes after a client
  // raged at the bot. A routine nudge is optional by definition, so it yields to the human.
  // Critical billing/safety messages never reach here — they go through claimCritical.
  if (!opts?.critical) {
    const { shouldHoldProactive } = await import("../verifiers/proactive-state");
    const held = await shouldHoldProactive(userId);
    if (held.hold) {
      console.log(`[PROACTIVE_STATE] held ${messageKey} for ${userId.slice(0, 8)} — ${held.reason}`);
      return false;
    }
  }
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

// Approved WhatsApp template (Twilio Content API SID, "HX…") used to re-open a
// conversation when a freeform proactive send is rejected for being OUTSIDE the
// 24-hour customer-care window (Twilio error 63016). A template is the only message
// WhatsApp allows outside that window. Empty until you have an approved template —
// when unset, behaviour is unchanged (the 63016 path goes straight to SMS fallback).
// Production-only: the sandbox has no templates, so this is a no-op there.
//
// Read through the registry rather than straight off process.env (2026-07-29): the text that
// gets approved and the SID that gets used must be the same object, or the coach sends a
// template nobody reviewed. server/whatsapp-templates.ts owns both.
const reengageTemplateSid = () => templateSid(WINDOW_RECOVERY_TEMPLATE);

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

// Reads the Twilio account balance so the scheduler can warn the founder BEFORE the
// account runs dry and the whole WhatsApp channel goes silent with no error (the
// 2026-07-09 scare: balance at $11.85 and nothing watching it). Kept here with the
// other Twilio API access; returns null on any failure — a balance check must never
// throw into the cron loop or block on Twilio being reachable.
export async function fetchTwilioBalance(): Promise<{ balance: number; currency: string } | null> {
  try {
    const b = await twilioClient.balance.fetch();
    const balance = Number(b.balance);
    if (!Number.isFinite(balance)) return null;
    return { balance, currency: b.currency || "USD" };
  } catch (e: any) {
    console.warn(`[BALANCE] Twilio balance fetch failed (non-fatal): ${e?.message || e}`);
    return null;
  }
}

export const deliveryStats = { sent: 0, failed: 0, lastReset: new Date().toISOString().slice(0, 10) };

// ── JOB RUN REGISTRY ──────────────────────────────────────────────────────────
// Last-run telemetry per scheduler job, surfaced by the /api/ops endpoint so the
// core loop is observable at scale (console logs vanish on every Railway redeploy).
// In-memory — resets on restart, which is fine for live operational visibility.
export interface JobRunInfo {
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastOk: boolean | null;
  lastError: string | null;
  runs: number;
  failures: number;
  /** The cron expression it was registered with — job-health derives the expected cadence from
   *  this rather than a second table, which would drift out of step with the schedule. */
  cron?: string;
}
export const jobRegistry = new Map<string, JobRunInfo>();
/** When the process came up — a weekly job hasn't "never run" five minutes after a redeploy. */
export const schedulerStartedAt = Date.now();

export function recordJobRun(name: string, ok: boolean, durationMs: number, error?: string, cron?: string): void {
  const prev = jobRegistry.get(name);
  jobRegistry.set(name, {
    lastRunAt: new Date().toISOString(),
    lastDurationMs: durationMs,
    lastOk: ok,
    lastError: ok ? null : (error || "unknown").slice(0, 300),
    runs: (prev?.runs || 0) + 1,
    failures: (prev?.failures || 0) + (ok ? 0 : 1),
    cron: cron || prev?.cron,
  });
}

/** The registry as job-health wants it. Kept here so callers never touch the Map directly. */
export function jobSnapshots(): Array<JobRunInfo & { name: string }> {
  return [...jobRegistry.entries()].map(([name, info]) => ({ name, ...info }));
}

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

// Record an outbound message in the client's chat history so the coach's GPT
// context can SEE what it proactively sent. Without this, every scheduler
// message (morning brief, weigh-in nudge, Women's Month, comeback, etc.) is
// invisible to conversationHistory — so when a client replies to a proactive,
// the coach has amnesia and hallucinates a contextless answer. Best-effort:
// never block or fail a send because logging failed. Phone-number lookup: the
// `to` passed by proactive jobs is the exact stored phoneNumber (whatsapp:+27…),
// so an equality match resolves the user. Coach/admin alerts go to numbers with
// no matching user row and are simply skipped — correct.
async function logOutboundToHistory(to: string, body: string): Promise<void> {
  const text = (body || "").trim();
  if (!text) return; // media-only sends carry no text worth remembering
  try {
    const u = await db.select({ id: users.id }).from(users).where(eq(users.phoneNumber, to)).limit(1);
    if (!u.length) return;
    await db.insert(chatHistory).values({ userId: u[0].id, messageIn: null, messageOut: text, intent: "PROACTIVE" });
  } catch (e: any) {
    console.warn(`[SCHEDULER] outbound history log failed (non-fatal) for ${to.slice(-8)}: ${e?.message || e}`);
  }
}

export async function sendWhatsApp(to: string, body: string, mediaUrl?: string): Promise<void> {
  // PROVENANCE FIRST (2026-07-30). Every outbound message — reactive reply, morning check-in,
  // weekly review — crosses this function, which makes it the only place a claim can be checked
  // for ALL of them. The gate had to go here rather than on the reply paths because the worst
  // false claim this product ever made was sent by a cron job.
  //
  // Runs before the bubble split so a claim spanning a "---" boundary is still one sentence.
  const checked = await provenanceGate(to, body);
  // VOICE, ENFORCED (2026-07-30). humanizeReply — the numbered-list reshape, the platitude strip,
  // the wall-of-text break — existed since 22 July and was wired into exactly ONE caller
  // (food-scanner.ts). Every brain reply, every engine reply and all 68 scheduler jobs went out
  // unhygienised, which is why 94% of recent defects were wall-of-text, listicles and generic
  // advice: the rules were real, the enforcement reached almost nothing.
  //
  // Reports are left alone. `audit` and `replay` quote real replies back at the founder, and a
  // pass that rewrote those quotes would corrupt the instrument that measures this — the same
  // rule the provenance gate follows.
  const shaped = checked.includes('_"') ? checked : humanizeReply(checked);
  // SHADOW (2026-08-04) — the proactive half of the door. Captured whole, before the bubble
  // split, so a shadow row holds the message as the client would have read it.
  if (await shadowDoor(to, shaped, "proactive", "server/scheduler/shared.ts", mediaUrl)) return;
  const parts = splitWhatsAppBody(shaped);
  for (let i = 0; i < parts.length; i++) {
    const remainingText = parts.slice(i).join("\n\n");
    const outcome = await sendOneWhatsApp(to, parts[i], i === parts.length - 1 ? mediaUrl : undefined, remainingText);
    // "fallback" = SMS/template already carried remainingText; "dropped" = channel/gate
    // is down for this recipient right now. Either way the rest must not double-send.
    if (outcome !== "sent") return;
  }
}

async function sendOneWhatsApp(to: string, body: string, mediaUrl: string | undefined, smsFallbackText: string): Promise<"sent" | "dropped" | "fallback"> {
  resetDeliveryStatsIfNeeded();
  // Sanity gate — block template-rendering leaks ("undefined kcal", "NaN", "${name}")
  // before they ever reach a client. A broken message is worse than a missed one.
  const outboundCheck = checkOutboundMessage(body);
  if (!outboundCheck.safe) {
    deliveryStats.failed++;
    console.error(`[OUTBOUND_GATE] BLOCKED send to ${to.slice(-8)} — ${outboundCheck.reason}. Body: ${String(body).slice(0, 120)}`);
    return "dropped";
  }
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
    return "dropped";
  }
  if (isTwilioCircuitOpen()) {
    deliveryStats.failed++;
    console.warn(`[CIRCUIT] Twilio circuit open — dropping send to ${to.slice(-8)}`);
    return "dropped";
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
      void logOutboundToHistory(to, body); // best-effort, non-blocking
      return "sent";
    } catch (err: unknown) {
      const e = err as { status?: number; code?: number; message?: string };
      // WhatsApp channel errors — don't retry, attempt SMS fallback for this recipient.
      // The fallback carries smsFallbackText (this bubble + any not yet sent) so a
      // multi-bubble message still reaches the client whole.
      if (e?.code && WA_CHANNEL_ERRORS.has(e.code)) {
        recordTwilioFailure();
        deliveryStats.failed++;
        // 63016 = freeform blocked for being OUTSIDE the 24-hour window. If an approved
        // re-engagement template is configured, send THAT first — it re-opens the WhatsApp
        // thread (preferred over SMS). Only on its failure do we drop to SMS. Other channel
        // errors (not opted in, region blocked) go straight to SMS as before.
        if (e.code === 63016 && reengageTemplateSid()) {
          console.warn(`[WA:WINDOW] outside 24h window for ${to.slice(-8)} — sending re-engagement template`);
          try {
            await sendWhatsAppTemplate(to, reengageTemplateSid(), undefined, { fallbackText: smsFallbackText });
            return "fallback"; // template path logs history + handles its own SMS fallback
          } catch {
            console.warn(`[WA:WINDOW] re-engagement template failed for ${to.slice(-8)} — falling back to SMS`);
          }
        } else {
          console.warn(`[WA:CHANNEL_ERROR] code=${e.code} for ${to.slice(-8)} — attempting SMS fallback`);
        }
        await sendSMSFallback(to, smsFallbackText);
        void logOutboundToHistory(to, smsFallbackText); // best-effort, non-blocking
        return "fallback";
      }
      const isTransient = !e?.status || e.status === 429 || e.status >= 500 || (e.code as any) === "ECONNRESET" || (e.code as any) === "ETIMEDOUT";
      if (!isTransient || i === delays.length - 1) {
        recordTwilioFailure();
        deliveryStats.failed++;
        console.error(`[SCHEDULER] ✗ Failed to send to ${to.slice(-8)} after ${i + 1} attempt(s):`, e?.message || err);
        throw err;
      }
      console.warn(`[SCHEDULER] ⚠ Send attempt ${i + 1} failed (${e?.message}), retrying…`);
    }
  }
  return "dropped"; // unreachable — loop either returns or throws; keeps TS exhaustive
}

// ── APPROVED TEMPLATE SEND (Twilio Content API) ────────────────────────────────
// Unlike sendWhatsApp (freeform), an APPROVED template is allowed OUTSIDE the
// 24-hour customer-care window — it is the only way to proactively reach a user
// who hasn't messaged in 24h on a production sender. The sandbox has no templates,
// so this is production-only.
//
//   contentSid    — the approved template's SID ("HX…") from Twilio Content/Meta
//   variables     — fill the template's {{1}},{{2}}… placeholders (e.g. {1: name})
//   opts.mediaUrl — header image/GIF, if the template has a media header
//   opts.fallbackText — plain-text equivalent for SMS fallback + history logging
//                       (the template body renders at Twilio, not here)
//
// Mirrors sendWhatsApp's resilience: rate limit, circuit breaker, retry/backoff,
// channel-error → SMS fallback, delivery stats, and outbound history logging.
export async function sendWhatsAppTemplate(
  to: string,
  contentSid: string,
  variables?: Record<string, string | number | null | undefined>,
  opts?: { mediaUrl?: string; fallbackText?: string },
): Promise<void> {
  resetDeliveryStatsIfNeeded();
  if (!contentSid) {
    console.warn("[SCHEDULER:TEMPLATE] no contentSid provided — skipping send");
    deliveryStats.failed++;
    return;
  }
  // Share the same outbound rate gate as freeform sends.
  const now = Date.now();
  const gap = now - _lastSchedulerSendAt;
  if (gap < SCHEDULER_MIN_GAP_MS) await new Promise(r => setTimeout(r, SCHEDULER_MIN_GAP_MS - gap));
  _lastSchedulerSendAt = Date.now();

  if (!FROM_NUMBER) {
    console.warn("[SCHEDULER:TEMPLATE] TWILIO_WHATSAPP_NUMBER not set — skipping send");
    deliveryStats.failed++;
    return;
  }
  if (isTwilioCircuitOpen()) {
    deliveryStats.failed++;
    console.warn(`[CIRCUIT] Twilio circuit open — dropping template send to ${to.slice(-8)}`);
    return;
  }

  // SHADOW (2026-08-04) — templates re-open a closed 24h window, so one escaping in staging
  // is a client pulled back into a conversation the build was not allowed to have.
  const logText = opts?.fallbackText || `[template ${contentSid}]`;
  if (await shadowDoor(to, logText, "template", "server/scheduler/shared.ts", opts?.mediaUrl)) return;
  const params: Record<string, unknown> = { from: FROM_NUMBER, to, contentSid };
  const cv = buildContentVariables(variables);
  if (cv) params.contentVariables = cv;
  if (opts?.mediaUrl) params.mediaUrl = [opts.mediaUrl];

  const delays = [0, 3000, 8000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
    try {
      await twilioClient.messages.create(params as unknown as Parameters<typeof twilioClient.messages.create>[0]);
      recordTwilioSuccess();
      deliveryStats.sent++;
      console.log(`[SCHEDULER:TEMPLATE] → ${to.slice(-8)}: ${contentSid}`);
      void logOutboundToHistory(to, logText); // best-effort, non-blocking
      return;
    } catch (err: unknown) {
      const e = err as { status?: number; code?: number; message?: string };
      // Channel error on a template (e.g. user never opted in) — SMS fallback if we have text.
      if (e?.code && WA_CHANNEL_ERRORS.has(e.code)) {
        recordTwilioFailure();
        deliveryStats.failed++;
        console.warn(`[WA:CHANNEL_ERROR:TEMPLATE] code=${e.code} for ${to.slice(-8)}`);
        if (opts?.fallbackText) await sendSMSFallback(to, opts.fallbackText);
        void logOutboundToHistory(to, logText);
        return;
      }
      const isTransient = !e?.status || e.status === 429 || e.status >= 500 || (e.code as any) === "ECONNRESET" || (e.code as any) === "ETIMEDOUT";
      if (!isTransient || i === delays.length - 1) {
        recordTwilioFailure();
        deliveryStats.failed++;
        console.error(`[SCHEDULER:TEMPLATE] ✗ Failed to send to ${to.slice(-8)} after ${i + 1} attempt(s):`, e?.message || err);
        throw err;
      }
      console.warn(`[SCHEDULER:TEMPLATE] ⚠ Attempt ${i + 1} failed (${e?.message}), retrying…`);
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

// DELETED 2026-08-18 (Issue #49 sweep): SICK_PATTERNS, wasSickOrInjured, isSickOrInjuredToday.
//
// A regex over the client's last 20 inbound messages, asked by morning, evening and retention to
// decide whether someone was ill. It had no callers left after those three moved to the durable
// sick_since / sick_until tokens, and a dead health-scan is worth deleting rather than leaving
// available: the next job that wants to know "are they sick" must now ask the state, which is the
// whole point.
//
// It could not do its job even when it was wired. sick-flow.ts writes paused_until beside
// sick_until, and every one of those jobs returns on isPaused() before its sick branch — so a
// genuinely ill client never reached the scan. What did reach it were the patterns that are not
// illness at all: "rest day", "skip gym", "miss workout", and someone ELSE being ill ("my mom is
// sick so I skipped gym"). The durable path already scrubs all three, via
// sick-flow.looksSickMention → aboutSomeoneElse, past-tense and regret-context handling.
//
// The durable questions now have one owner each, in adaptive-targets.ts: sickToday() and
// sickCoveredYesterday().

// ════════════════════════════════════════════════════════════════════════════════════════════
// CANONICAL PROACTIVE STATE — the one structure every scheduled job reads.
//
// (2026-08-18, Issue #49 step 2.) The proactive path had no shared state. adaptive.ts assembled
// its own; morning.ts assembled its own, 474 lines of it, and asked a REGEX over the client's last
// 20 messages whether they were sick today — so "my mom is sick so I skipped gym" flipped the
// client's own health state while durable sick_until said otherwise.
//
// Reactive turns got authoritative state, a decision owner, evidence contracts and outbound gates
// this month. Proactive got none of it, and no suite noticed because none of them run a scheduled
// job. This is the first half of fixing that: one snapshot, authoritative ledgers only.
//
// RULES THIS ENCODES, each one a defect that reached a client:
//   · health is DURABLE state, never a keyword scan — that scan is audit/analytics from here
//   · workouts come from workoutLogs, never chat_history saying "done"
//   · baseline targets are read-only; the overlay is what the client currently sees (0005)
//   · a weight trend is only present when weightTrendUsable says so — the same gate the reply
//     path uses, so a proactive message can never assert a trend a reply would refuse
//   · evidence sufficiency is stated, so a job can tell "no" from "I don't know"
// ════════════════════════════════════════════════════════════════════════════════════════════

export interface ProactiveState {
  userId: string;
  phone: string;
  name: string;
  goalType: string;
  weightKg: number;
  /** Profile numbers. The adaptive engine reasons FROM these and never writes them (0005). */
  baseline: { calories: number; protein: number; steps: number };
  /** What the client currently sees — the overlay the adaptive job persists. */
  current: { calories: number; protein: number; steps: number };
  /** DURABLE health only. No regex over recent messages ever reaches a proactive decision. */
  health: { sick: boolean; sickYesterday: boolean; recovering: boolean; daysSick: number; sickUntil?: string; sickSince?: string };
  /** null everywhere means COULD NOT READ, never zero. A client who logged nothing and a ledger
   *  that failed to answer are different facts and the engine acts differently on each. */
  food: { avgKcal7d: number | null; avgProtein7d: number | null; loggedDays7d: number | null;
    /** Days since ANY food log. null = never logged, which is not the same as "logged long ago". */
    daysSinceAnyLog: number | null };
  workout: { sessionsLast7d: number; daysSinceLastSession: number | null };
  steps: { avg7d: number | null };
  weight: { weeklyKgChange: number | null; trendUsable: boolean; stalledWeeks: number;
    /** Unbounded, unlike weeklyKgChange's 28-day window — "never weighed" and "weighed in March"
     *  are different clients and the decision owner treats them differently. */
    daysSinceWeighIn: number | null };
  /** TODAY, not the 7-day picture. The one-action decision turns on these. */
  today: { kcal: number; protein: number; steps: number; logged: boolean; hour: number };
  reentry: { daysSinceLastContact: number | null; isReturning: boolean };
  /** Can a decision be made, or only a question asked? Missing ≠ negative. */
  evidence: { foodSufficient: boolean; weightSufficient: boolean };
}

/** Below this many logged days in seven, intake averages are not evidence. Same floor as the
 *  hunger and deficit contracts — one client must not be "well logged" for one subsystem and
 *  "thinly logged" for another on the same morning. */
export const PROACTIVE_LOG_FLOOR = 4;

/** Weeks of no meaningful weight movement (<0.3kg swing) from a series, newest first.
 *  Moved here from adaptive.ts so the stall a message TALKS about and the stall the engine ACTS
 *  on are one number. */
function stalledWeeksFrom(weights: number[]): number {
  if (weights.length < 3) return 0;
  const newest = weights[0];
  let weeks = 0;
  for (const w of weights.slice(1)) {
    if (Math.abs(newest - w) < 0.3) weeks++;
    else break;
  }
  return weeks;
}

/**
 * Assemble one client's proactive state from authoritative ledgers. Read-only, and fail-soft per
 * field: a ledger that cannot be read yields null and lowers the matching evidence flag rather
 * than throwing — a scheduled job must not die for one client's missing row.
 */
export async function loadProactiveState(client: any): Promise<ProactiveState> {
  const { weightTrendUsable, sickCoveredYesterday, sickToday } = await import("../adaptive-targets");
  const { contactState } = await import("../understanding/reentry");
  const { gatherReportData } = await import("../report-card");
  const since = (d: number) => new Date(Date.now() - d * 86_400_000);

  const notes = String(client.profileNotes || "");
  const sickUntil = notes.match(/sick_until:(\d{4}-\d{2}-\d{2})/)?.[1];
  const sickSince = notes.match(/sick_since:(\d{4}-\d{2}-\d{2})/)?.[1];
  const today = todaySAST();
  const sick = sickToday(sickUntil, today);
  const recovering = !sick && !!sickUntil
    && (Date.now() - new Date(sickUntil).getTime()) / 86_400_000 <= 3;
  // "Were they ill YESTERDAY" — what the morning brief actually asks, since it reports on the day
  // that just ended. The rule itself lives in adaptive-targets.ts so it has one owner.
  const sickYesterday = sickCoveredYesterday(sickSince, sickUntil, today);

  const { getDayLedger } = await import("../day-ledger");
  const { sastDayStart, sastDaysBetween, sastHour } = await import("../sast");
  const dayStart0 = sastDayStart();

  const [intake, wRows, stepAgg, workoutRows, lastMeal, lastWeigh, todaySteps, ledger] = await Promise.all([
    gatherReportData(client, "week").catch(() => null),
    db.select({ w: weightLogs.weight, at: weightLogs.loggedAt }).from(weightLogs)
      .where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, since(28))))
      .orderBy(desc(weightLogs.loggedAt)).limit(12).catch(() => [] as any[]),
    db.select({ avg: sql<number>`COALESCE(AVG(${stepLogs.steps}),0)::int` }).from(stepLogs)
      .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, since(7)))).catch(() => [] as any[]),
    // THE WORKOUT LEDGER, not chat_history saying "done". A client typing the word is not a
    // completed session, and a session logged by any other path still counts.
    db.select({ at: workoutLogs.loggedAt }).from(workoutLogs)
      .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, since(7))))
      .orderBy(desc(workoutLogs.loggedAt)).catch(() => [] as any[]),
    // UNBOUNDED, deliberately. The 28-day windows above answer "what is happening now"; these two
    // answer "has this ever happened", and a client who last weighed in March is a different
    // person from one who never has. Bounding them would collapse both into null.
    db.select({ at: mealLogs.loggedAt }).from(mealLogs)
      .where(eq(mealLogs.userId, client.id)).orderBy(desc(mealLogs.loggedAt)).limit(1)
      .catch(() => [] as any[]),
    db.select({ at: weightLogs.loggedAt }).from(weightLogs)
      .where(eq(weightLogs.userId, client.id)).orderBy(desc(weightLogs.loggedAt)).limit(1)
      .catch(() => [] as any[]),
    db.select({ steps: stepLogs.steps }).from(stepLogs)
      .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, dayStart0)))
      .orderBy(desc(stepLogs.loggedAt)).limit(1).catch(() => [] as any[]),
    getDayLedger(client.id, { user: client }).catch(() => null),
  ]);

  const weights = (wRows as any[]).map(r => parseFloat(String(r.w))).filter(n => Number.isFinite(n));
  let weeklyKgChange: number | null = null;
  let trendUsable = false;
  if (weights.length >= 2) {
    const newestAt = new Date((wRows as any[])[0].at as Date).getTime();
    const oldestAt = new Date((wRows as any[])[wRows.length - 1].at as Date).getTime();
    const verdict = weightTrendUsable({
      count: weights.length, newestAt, oldestAt, now: Date.now(),
      sickSince: sickSince ? new Date(sickSince).getTime() : undefined,
      sickUntil: sickUntil ? new Date(sickUntil).getTime() : undefined,
    });
    trendUsable = verdict.usable;
    if (verdict.usable) {
      const spanDays = Math.max(1, (newestAt - oldestAt) / 86_400_000);
      weeklyKgChange = ((weights[0] - weights[weights.length - 1]) / spanDays) * 7;
    }
  }

  const lastSession = (workoutRows as any[])[0]?.at;
  const loggedDays7d = intake ? intake.distinctDaysLogged : null;
  const lastMealAt = (lastMeal as any[])[0]?.at ? new Date((lastMeal as any[])[0].at) : null;
  const lastWeighAt = (lastWeigh as any[])[0]?.at ? new Date((lastWeigh as any[])[0].at) : null;

  return {
    userId: client.id,
    phone: client.phoneNumber,
    name: String(client.name || "").split(" ")[0] || "there",
    goalType: client.goalType || "fat_loss",
    weightKg: parseFloat(String(client.currentWeight || "")) || 75,
    baseline: {
      calories: Number(client.baselineCalorieTarget ?? client.calorieTarget) || 0,
      protein: Number(client.baselineProteinTarget ?? client.proteinTarget) || 0,
      steps: Number(client.baselineStepsTarget ?? client.stepsTarget) || 0,
    },
    current: {
      calories: Number(client.calorieTarget) || 0,
      protein: Number(client.proteinTarget) || 0,
      steps: Number(client.stepsTarget) || 0,
    },
    health: {
      sick, sickYesterday, recovering,
      daysSick: sickSince ? Math.floor((Date.now() - new Date(sickSince).getTime()) / 86_400_000) : 0,
      sickUntil, sickSince,
    },
    food: {
      avgKcal7d: intake ? intake.avgKcal : null,
      avgProtein7d: intake ? intake.avgProtein : null,
      loggedDays7d,
      daysSinceAnyLog: lastMealAt ? sastDaysBetween(lastMealAt) : null,
    },
    workout: {
      sessionsLast7d: (workoutRows as any[]).length,
      daysSinceLastSession: lastSession
        ? Math.floor((Date.now() - new Date(lastSession).getTime()) / 86_400_000) : null,
    },
    steps: { avg7d: Number((stepAgg as any[])[0]?.avg || 0) || null },
    weight: {
      weeklyKgChange, trendUsable, stalledWeeks: stalledWeeksFrom(weights),
      daysSinceWeighIn: lastWeighAt ? sastDaysBetween(lastWeighAt) : null,
    },
    today: {
      kcal: ledger?.kcal ?? 0,
      protein: ledger?.protein ?? 0,
      steps: Number((todaySteps as any[])[0]?.steps || 0),
      logged: !!lastMealAt && sastDaysBetween(lastMealAt) === 0,
      hour: sastHour(),
    },
    reentry: contactState(client.lastActiveAt),
    evidence: {
      foodSufficient: loggedDays7d !== null && loggedDays7d >= PROACTIVE_LOG_FLOOR,
      weightSufficient: trendUsable,
    },
  };
}

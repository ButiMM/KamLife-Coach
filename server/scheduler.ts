import cron from "node-cron";
import twilio from "twilio";
import { isTwilioCircuitOpen, recordTwilioSuccess, recordTwilioFailure, sastDayStart } from "./utils";
import { db, pool } from "./db";
import { users, chatHistory, stepLogs, workoutLogs, weightLogs, mealLogs, sentProactive, escalations } from "../shared/schema";
import { eq, gte, lte, and, lt, desc, asc, or, sql, count } from "drizzle-orm";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { generateVoiceNote } from "./tts";
import { getKamlifeProgramme } from "./programme";
import { getShoppingList, formatShoppingList } from "./shopping-lists";
import { PRICING } from "../shared/pricing";
import { selectVariantMessage, recordDelivery } from "./ab";

// ============================================================
// SCHEDULER STATE — persists last-run dates across restarts
// ============================================================

const STATE_FILE = join(process.cwd(), "server", ".scheduler-state.json");

function loadState(): Record<string, string> {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch (_e) { /* ignore parse errors on missing state file */ }
  return {};
}

function saveState(key: string, dateStr: string): void {
  try {
    const state = loadState();
    state[key] = dateStr;
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (e) {
    console.error("[SCHEDULER] State save error:", e);
  }
}

// South Africa is UTC+2 year-round (no DST). Use SAST for all daily keys so
// "today" for rate-limiting and state tracking aligns with SA midnight, not UTC midnight.
function todaySAST(): string {
  const sast = new Date(Date.now() + 2 * 3_600_000);
  return sast.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// Keep todayUTC as alias for state-file keys (they're permanent, format doesn't matter)
function todayUTC(): string { return todaySAST(); }

function hasRunToday(key: string, dateStr: string): boolean {
  return loadState()[key] === dateStr;
}

// ── DB-BACKED DAILY PROACTIVE BUDGET ─────────────────────────────────────────
// MAX 1 proactive message per client per calendar day (SAST).
// Previously in-memory only — a server restart wiped the counter and multiple
// crons would all fire back-to-back on the same client. Now the cap is stored
// in the sent_proactive table and survives restarts.
//
// Usage: replace canSendProactive(id) + recordProactiveSend(id) with:
//   const ok = await claimDailySlot(id, "job_key");
//   if (ok) { await sendWhatsApp(...); }
// ─────────────────────────────────────────────────────────────────────────────

// In-memory fast-path (avoids a DB round-trip when the same cron loop
// already sent to this client earlier in the same run).
const dailySentThisProcess = new Set<string>();

function dailyKey(clientId: string): string {
  return `${todaySAST()}:${clientId}`;
}

/**
 * Atomically claim the daily proactive slot for (clientId, jobKey).
 * Returns true iff the caller should send — false means skip.
 *
 * Enforces TWO things:
 *  1. This specific jobKey can only fire once per day per client (per-message dedupe)
 *  2. At most 1 proactive per client per calendar day (global daily cap)
 *
 * Fail-open on DB error: we'd rather one extra message than silently dropping
 * everyone's messages when Postgres is flaky.
 */
async function claimDailySlot(clientId: string, jobKey: string): Promise<boolean> {
  const today = todaySAST();

  // Fast-path: already sent something to this client this process run
  if (dailySentThisProcess.has(dailyKey(clientId))) return false;

  try {
    // 1. Check global daily cap — has ANY proactive been sent today?
    const existing = await db
      .select({ id: sentProactive.id })
      .from(sentProactive)
      .where(and(
        eq(sentProactive.userId, clientId),
        eq(sentProactive.dedupeWindow, today),
      ))
      .limit(1);
    if (existing.length > 0) return false; // already got one today

    // 2. Try to claim this specific job slot (unique index prevents races)
    const inserted = await db
      .insert(sentProactive)
      .values({ userId: clientId, messageKey: jobKey, dedupeWindow: today })
      .onConflictDoNothing()
      .returning({ id: sentProactive.id });
    if (!inserted.length) return false; // race: someone else claimed it

    // 3. Mark in-memory so the same process doesn't double-send
    dailySentThisProcess.add(dailyKey(clientId));
    return true;
  } catch (err) {
    console.warn(`[claimDailySlot] DB error (${jobKey}/${clientId.slice(0,8)}):`, err);
    // Fail-open: if in-memory says not sent yet, allow it
    if (dailySentThisProcess.has(dailyKey(clientId))) return false;
    dailySentThisProcess.add(dailyKey(clientId));
    return true;
  }
}

// ── Sync helpers used by all cron jobs ────────────────────────────────────────
function canSendProactive(clientId: string): boolean {
  return !dailySentThisProcess.has(dailyKey(clientId));
}

// Fire-and-forget DB write — non-blocking so all call sites stay synchronous.
// At process start we reload today's sent set from DB, so restarts don't wipe the cap.
function recordProactiveSend(clientId: string, jobKey = "proactive"): void {
  dailySentThisProcess.add(dailyKey(clientId));
  db.insert(sentProactive)
    .values({ userId: clientId, messageKey: jobKey, dedupeWindow: todaySAST() })
    .onConflictDoNothing()
    .catch(e => console.warn("[recordProactiveSend] DB write failed (non-fatal):", e));
}

// ── Startup hydration — repopulate the in-memory set from today's DB records ──
// Without this, a server restart wipes dailySentThisProcess and all crons re-fire.
(async () => {
  try {
    const today = todaySAST();
    const sentToday = await db
      .select({ userId: sentProactive.userId })
      .from(sentProactive)
      .where(eq(sentProactive.dedupeWindow, today));
    for (const row of sentToday) {
      dailySentThisProcess.add(dailyKey(row.userId));
    }
    console.log(`[SCHEDULER] Daily budget hydrated: ${sentToday.length} clients already sent today`);
  } catch (e) {
    console.warn("[SCHEDULER] Budget hydration failed (non-fatal):", e);
  }
})();

// Per-message-key dedupe. The 2/day quota above is a budget; this stops the same
// named message (e.g. "friday_weekend") from firing twice if a cron run restarts
// mid-loop. An in-memory cache acts as a fast path; the durable source of truth
// is the sent_proactive table (schema.ts) with a unique index on
// (user_id, message_key, dedupe_window). Process restarts no longer cause
// double-sends.
const weeklyKeyedSent = new Map<string, true>();

function weeklyKeyedKey(clientId: string, messageKey: string, window: string): string {
  return `${window}:${clientId}:${messageKey}`;
}

/**
 * Attempt to claim a proactive send for (userId, messageKey, dedupeWindow).
 * Returns true iff we got the claim and the caller should now send.
 *
 * dedupeWindow is caller-defined: use thisWeekUTC() for weekly jobs, a YYYY-MM-DD
 * string for daily jobs, a YYYY-MM string for monthly. Same window + key + user
 * can only succeed once — the unique index in sent_proactive enforces it.
 *
 * Fail-open on DB error: we'd rather occasionally double-send than silently drop
 * the whole cohort's messages when Postgres is flaky. The in-memory cache still
 * prevents repeats within a single process, so the worst case is one duplicate
 * per process-per-user-per-window, not N.
 */
async function claimProactive(userId: string, messageKey: string, dedupeWindow: string): Promise<boolean> {
  const inMemKey = weeklyKeyedKey(userId, messageKey, dedupeWindow);
  if (weeklyKeyedSent.has(inMemKey)) return false;

  try {
    const inserted = await db.insert(sentProactive)
      .values({ userId, messageKey, dedupeWindow })
      .onConflictDoNothing()
      .returning({ id: sentProactive.id });

    weeklyKeyedSent.set(inMemKey, true);
    // inserted.length === 0 means the unique constraint swallowed us — another
    // run (or a previous process) already claimed this send.
    return inserted.length > 0;
  } catch (e) {
    console.warn(`[claimProactive] DB error for ${messageKey}/${userId}:`, e);
    weeklyKeyedSent.set(inMemKey, true);
    return true; // fail open
  }
}

// Purge stale in-memory entries at midnight SAST (22:00 UTC) — prevents unbounded growth.
// Also prunes sentProactive DB rows older than 30 days (keep DB lean).
// Also alerts on overdue escalations past their SLA deadline.
cron.schedule("0 22 * * *", async () => {
  const today = todaySAST();
  // Clear yesterday's daily budget entries from the Set
  for (const key of dailySentThisProcess.values()) {
    if (!key.startsWith(today)) dailySentThisProcess.delete(key);
  }
  // Purge last week's keyed dedupe entries
  const thisWeek = thisWeekUTC();
  for (const key of weeklyKeyedSent.keys()) {
    if (!key.startsWith(thisWeek)) weeklyKeyedSent.delete(key);
  }
  // DB cleanup: delete sentProactive rows older than 30 days
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    await db.delete(sentProactive).where(lt(sentProactive.dedupeWindow as any, thirtyDaysAgo));
  } catch { /* non-fatal */ }
  console.log("[SCHEDULER] dedupe purged — daily set size:", dailySentThisProcess.size, "keyed:", weeklyKeyedSent.size);

  // Escalation SLA check — alert coach for any open escalation past its deadline
  try {
    const overdueEscalations = await db.select({
      id: escalations.id, userId: escalations.userId,
      reason: escalations.reason, priority: escalations.priority,
      slaDeadline: escalations.slaDeadline,
    }).from(escalations).where(
      and(
        eq(escalations.status, "open"),
        lt(escalations.slaDeadline, new Date()),
      )
    ).limit(20);

    if (overdueEscalations.length > 0) {
      const coachPhone = process.env.COACH_PHONE;
      if (coachPhone) {
        const twilioC = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
        const fromNum = process.env.TWILIO_WHATSAPP_NUMBER
          ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}`
          : "";
        if (fromNum) {
          const urgentCount = overdueEscalations.filter(e => e.priority === "urgent").length;
          const msg = `⚠️ KamLife Coach — ${overdueEscalations.length} escalation${overdueEscalations.length > 1 ? "s" : ""} past SLA (${urgentCount} urgent). Check your dashboard.`;
          await twilioC.messages.create({ from: fromNum, to: `whatsapp:${coachPhone}`, body: msg }).catch(e => console.error("[SLA ALERT]", e));
        }
      }
      console.log(`[SCHEDULER] SLA breach — ${overdueEscalations.length} overdue escalations`);
    }
  } catch (slaErr) {
    console.error("[SCHEDULER] SLA check failed:", slaErr);
  }
}, { timezone: "UTC" });

function thisWeekUTC(): string {
  const d = new Date();
  const day = d.getUTCDay(); // 0=Sun, 1=Mon...
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // Monday of current week
  // Construct new Date without mutating d
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
  return monday.toISOString().slice(0, 10);
}

// ============================================================
// TWILIO SENDING
// ============================================================

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const FROM_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER
  ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}`
  : "";

// Delivery tracking — counts successes and failures per day
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
  const params: any = { from: FROM_NUMBER, to, body };
  if (mediaUrl) params.mediaUrl = [mediaUrl];
  const delays = [0, 3000, 8000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
    try {
      await twilioClient.messages.create(params);
      recordTwilioSuccess();
      deliveryStats.sent++;
      console.log(`[SCHEDULER] → ${to.slice(-8)}: ${body.slice(0, 80)}…`);
      return;
    } catch (err: any) {
      const isTransient = !err?.status || err.status >= 500 || err.code === "ECONNRESET" || err.code === "ETIMEDOUT";
      if (!isTransient || i === delays.length - 1) {
        recordTwilioFailure();
        deliveryStats.failed++;
        console.error(`[SCHEDULER] ✗ Failed to send to ${to.slice(-8)} after ${i + 1} attempt(s):`, err?.message || err);
        throw err;
      }
      console.warn(`[SCHEDULER] ⚠ Send attempt ${i + 1} failed (${err?.message}), retrying in ${delays[i + 1]}ms…`);
    }
  }
}

// ============================================================
// HELPERS
// ============================================================

async function getActiveClients() {
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

// Returns true if client has set a pause until a future date
function isPaused(client: any): boolean {
  const notes = client.profileNotes || "";
  const match = notes.match(/paused_until:(\d{4}-\d{2}-\d{2})/);
  if (!match) return false;
  return new Date(match[1]) >= new Date(todayUTC());
}

function dayStart(offsetDays = 0): Date {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return sastDayStart(d);
}

async function getYesterdayLogs(userId: string) {
  const start = dayStart(-1);
  const end = dayStart(0);
  return db.select().from(chatHistory).where(
    and(
      eq(chatHistory.userId, userId),
      gte(chatHistory.createdAt, start),
      lt(chatHistory.createdAt, end)
    )
  ).limit(20);
}

async function getTodayLogs(userId: string) {
  return db.select().from(chatHistory).where(
    and(
      eq(chatHistory.userId, userId),
      gte(chatHistory.createdAt, dayStart(0))
    )
  ).limit(1);
}


// Training day schedule per weekly frequency — Mon=1, Tue=2, ... Sat=6
const TRAINING_SCHEDULES: Record<number, number[]> = {
  2: [1, 4],
  3: [1, 3, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 4, 5],
  6: [1, 2, 3, 4, 5, 6],
};

function programmeDaysSince(startDate: Date | null | undefined): number {
  if (!startDate) return 0;
  return Math.floor((Date.now() - new Date(startDate).getTime()) / 86_400_000);
}

// ============================================================
// JOB 1 — MORNING CHECK-IN
// Runs 6am SAST (4am UTC) daily
// ============================================================

async function runMorningCheckin(): Promise<void> {
  console.log("[SCHEDULER] JOB: Morning check-in");

  // Skip Sunday — rest-day comms handled by Sunday evening check-in
  const todayDOW = new Date().getDay(); // 0=Sun
  if (todayDOW === 0) {
    console.log("[SCHEDULER] Morning check-in — skipping Sunday");
    return;
  }

  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    // Smart re-engagement: silent clients get a different message, not silence
    const daysSilent = client.lastActiveAt
      ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
      : 0;

    // More than 7 days silent — stop messaging (save WhatsApp costs)
    if (daysSilent > 7) continue;

    // 3-7 days silent — Comeback Rescue: friendly reset with explicit reply options
    if (daysSilent >= 3) {
      if (canSendProactive(client.id)) {
        const name = client.name || "there";
        const comebBackMsg = `${name}, ${daysSilent} days. Life happens — no lecture from me.\n\nTell me which one fits right now:\n\n*1* — I'm back, let's pick up where we left off\n*2* — I need a simpler plan, I've been overwhelmed\n*3* — I'm just busy for a bit, check in next week\n\nOne reply is all I need.`;
        // A/B: if an active re_engagement experiment exists, use the variant template
        const { text: reEngageMsg, assignmentId } = await selectVariantMessage(
          client.id, "re_engagement", comebBackMsg
        );
        await sendWhatsApp(client.phoneNumber, reEngageMsg);
        if (assignmentId !== null) await recordDelivery(assignmentId);
        // Set awaiting state so routes.ts routes "1"/"2"/"3" replies correctly
        await db.update(users).set({ awaitingInputType: "comeback" }).where(eq(users.id, client.id));
        recordProactiveSend(client.id, "comeback_rescue");
      }
      continue;
    }
    try {
      const name = client.name || "there";
      const phone = client.phoneNumber;
      const proteinTarget = client.proteinTarget || 120;

      const yesterdayLogs = await getYesterdayLogs(client.id);

      if (yesterdayLogs.length === 0) {
        // Completely silent day — check streak shield before generic accountability
        if (canSendProactive(client.id)) {
          const wStreak = client.workoutStreak || 0;
          const currentMonth = todaySAST().slice(0, 7); // "YYYY-MM"
          const shieldUsedMonth = (client.profileNotes || "").match(/streak_shield:(\d{4}-\d{2})/)?.[1];
          const shieldAvailable = wStreak >= 3 && shieldUsedMonth !== currentMonth;

          if (shieldAvailable) {
            // Auto-apply shield — preserve streak, record usage
            const updatedNotes = (client.profileNotes || "").replace(/streak_shield:\d{4}-\d{2}/, "").trim()
              + ` streak_shield:${currentMonth}`;
            await db.update(users).set({ profileNotes: updatedNotes }).where(eq(users.id, client.id));
            await sendWhatsApp(phone,
              `Morning ${name}. Yesterday was a miss — but your *${wStreak}-session streak is protected* by your monthly shield.\n\nShield used. No more protection this month.\n\nLog today's session to keep the momentum going.`
            );
          } else {
            await sendWhatsApp(phone,
              `Morning ${name}. Nothing logged yesterday — I have nothing to coach from. Log your breakfast in the next hour. That is all.`
            );
          }
          recordProactiveSend(client.id);
        }
        continue;
      }

      const foodLogs = yesterdayLogs.filter(l => l.intent === "FOOD_LOG");
      const workoutLogged = yesterdayLogs.some(l => l.intent === "WORKOUT_LOG" || (l.messageIn || "").toLowerCase().trim() === "done");

      // Run protein sum + step streak in parallel — both needed for the morning message.
      // Previously serial awaits; Promise.all cuts latency ~50% per client.
      const yStart = dayStart(-1);
      const yEnd = dayStart(0);
      const twoWeeksAgoSteps = new Date(Date.now() - 14 * 86_400_000);

      const [proteinRows, recentStepLogs, yesterdayStepRows] = await Promise.all([
        db.select({
          totalProt: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
        }).from(mealLogs).where(and(
          eq(mealLogs.userId, client.id),
          gte(mealLogs.loggedAt, yStart),
          lt(mealLogs.loggedAt, yEnd),
        )).catch((e: Error) => { console.warn("[scheduler] meal_logs protein sum failed:", e); return [{ totalProt: 0 }]; }),

        db.select({ loggedAt: stepLogs.loggedAt })
          .from(stepLogs)
          .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, twoWeeksAgoSteps)))
          .orderBy(desc(stepLogs.loggedAt))
          .catch((_e: Error) => [] as { loggedAt: Date | null }[]),

        // Read yesterday's step total from step_logs directly — more reliable than
        // text-parsing chat_history (screenshot logs store "[Step Screenshot: 12000]"
        // not "12000 steps", so the old regex missed them).
        db.select({ steps: stepLogs.steps })
          .from(stepLogs)
          .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, yStart), lt(stepLogs.loggedAt, yEnd)))
          .catch((_e: Error) => [] as { steps: number | null }[]),
      ]);

      // Read yesterday's protein from structured meal_logs — no more regex text-parsing.
      // Falls back to 0 if nothing logged. meal_logs populated from 2026-04-17 onward;
      // older rows pre-date the table and will legitimately show 0.
      const totalProtLogged = (proteinRows as { totalProt: number }[])[0]?.totalProt || 0;

      // Steps: sum all step_logs rows for yesterday (one per logging event)
      const stepsLogged = (yesterdayStepRows as { steps: number | null }[]).reduce((s, r) => s + (r.steps || 0), 0);

      // Day-specific opener (replaces the removed daily motivation job)
      const DOW_OPENERS: Record<number, string> = {
        1: `New week. Clean slate.`,
        2: `Day 2. Consistency beats intensity.`,
        3: `Halfway through the week.`,
        4: `Body is adapting. Do not stop.`,
        5: `Friday. The weekend does not mean the plan stops.`,
        6: `Saturday. One session before tonight.`,
      };
      const dowOpener = DOW_OPENERS[todayDOW] ? ` ${DOW_OPENERS[todayDOW]}` : "";

      // Identity formation: day-count-based statements that shift self-image.
      // Research: identity ("I'm the kind of person who…") is a stronger
      // retention driver than outcome goals ("I want to lose weight").
      const progDays = programmeDaysSince(client.programmeStartDate);
      let identityLine = "";
      if (progDays === 7)  identityLine = " One week. You showed up every day this week.";
      else if (progDays === 14) identityLine = " Two weeks consistent. You're building something real.";
      else if (progDays === 21) identityLine = " Three weeks in. The habit is forming — your body knows the routine now.";
      else if (progDays === 30) identityLine = " A month. You are now the kind of person who trains for a month straight.";
      else if (progDays === 60) identityLine = " 60 days. Two months of showing up. That's rare.";
      else if (progDays === 90) identityLine = " 90 days. You are not the same person who started this.";

      // Streak display — show BOTH workout and step streaks in the opener
      // so users are protecting two streaks at once (higher motivation).
      // Variable reinforcement: call out workout streak every 5th day only
      // (slot-machine psychology — predictable praise loses impact).
      const wStreak = client.workoutStreak || 0;

      // Compute step streak from already-fetched recentStepLogs (parallel query above)
      let stepStreakCount = 0;
      {
        const stepDays = new Set<string>();
        for (const l of recentStepLogs as { loggedAt: Date | null }[]) {
          if (!l.loggedAt) continue;
          const d = new Date(new Date(l.loggedAt).getTime() + 2 * 3_600_000); // SAST
          stepDays.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`);
        }
        const stepCheck = new Date(Date.now() + 2 * 3_600_000); stepCheck.setUTCDate(stepCheck.getUTCDate() - 1); // SAST yesterday
        while (true) {
          const key = `${stepCheck.getUTCFullYear()}-${stepCheck.getUTCMonth()}-${stepCheck.getUTCDate()}`;
          if (!stepDays.has(key)) break;
          stepStreakCount++;
          stepCheck.setDate(stepCheck.getDate() - 1);
        }
      }

      const streakParts: string[] = [];
      // Show workout streak for any streak >= 2 — loss aversion is strongest when the
      // stake is visible every day, not just on 5-session milestones.
      if (wStreak >= 2) streakParts.push(`🔥 *${wStreak}-session streak*`);
      // Step streak for >= 2 consecutive days
      if (stepStreakCount >= 2) streakParts.push(`🚶 ${stepStreakCount}-day step streak`);
      const streakLine = streakParts.length ? ` ${streakParts.join(" · ")}.` : "";

      const parts: string[] = [`Morning ${name}.${dowOpener}${identityLine}${streakLine}`];

      // Protein — be specific about the number and the gap
      if (foodLogs.length === 0) {
        parts.push(`No food logged yesterday.`);
        parts.push(`You cannot out-train a diet you are not tracking.`);
      } else if (totalProtLogged >= proteinTarget * 0.9) {
        parts.push(`${totalProtLogged}g protein logged yesterday — target hit.`);
      } else if (totalProtLogged > 0) {
        const gap = proteinTarget - totalProtLogged;
        parts.push(`${totalProtLogged}g protein logged yesterday — ${gap}g short of your ${proteinTarget}g target.`);
        parts.push(gap > 50
          ? `Add pilchards and eggs to every meal today.`
          : `One extra tin of pilchards or 2 eggs today closes that gap.`
        );
      } else {
        parts.push(`Food was logged but protein not tracked.`);
      }

      // Workout — milestone-aware messages at 1, 3, 5, 10, 25, 50, 100 sessions
      if (workoutLogged) {
        const totalW = client.totalWorkoutsCompleted || 0;
        const workoutMsg =
          totalW === 1  ? `First session in the books. That's the hardest one.` :
          totalW === 3  ? `Three sessions done. The habit is starting.` :
          totalW === 5  ? `Five sessions. You're past the point where most people quit.` :
          totalW === 10 ? `Ten sessions. You've made this a real part of your life.` :
          totalW === 25 ? `25 sessions. A quarter of a hundred. This is real now.` :
          totalW === 50 ? `50 sessions. Halfway to a hundred. You've earned every one.` :
          totalW === 100 ? `100 sessions. 💯 That's elite consistency.` :
          (totalW % 10 === 0 && totalW > 0) ? `${totalW} sessions. Keep that momentum.` :
          `Session done yesterday. Sharp.`;
        parts.push(workoutMsg);
      }

      // Steps — specific number vs target
      if (stepsLogged > 0) {
        const stepsTarget = client.stepsTarget || 8500;
        if (stepsLogged >= stepsTarget) {
          parts.push(`Steps: ${stepsLogged.toLocaleString()} — target hit.`);
        } else {
          parts.push(`Steps: ${stepsLogged.toLocaleString()} of ${stepsTarget.toLocaleString()} target.`);
        }
      }

      // ---- ONE-TAP REPEAT LOGGING ----
      // Find user's most common breakfast from last 7 days of food logs
      let repeatSuggestion = "";
      try {
        const weekAgo = new Date(Date.now() - 7 * 86_400_000);
        const recentFoods = await db.select({ messageIn: chatHistory.messageIn })
          .from(chatHistory)
          .where(and(
            eq(chatHistory.userId, client.id),
            eq(chatHistory.intent, "FOOD_LOG"),
            gte(chatHistory.createdAt, weekAgo)
          ))
          .orderBy(desc(chatHistory.createdAt))
          .limit(14);

        // Find a recent breakfast or first meal of the day
        const breakfastLog = recentFoods.find(l =>
          l.messageIn && /\b(breakfast|morning|oats|eggs?|cereal|toast|bread)\b/i.test(l.messageIn)
        );
        if (breakfastLog && breakfastLog.messageIn) {
          const meal = breakfastLog.messageIn.replace(/\b(for breakfast|breakfast was|this morning|had|ate|eating|having|i |my )\b/gi, "").trim();
          if (meal.length > 3 && meal.length < 60) {
            repeatSuggestion = `\n\n💡 Same breakfast as last time? Reply *"${meal.slice(0, 50)}"* to log it instantly.`;
          }
        }
      } catch { /* non-critical */ }

      // End with one specific action — include training nudge if today is a training day
      const schedule = TRAINING_SCHEDULES[client.trainingDaysPerWeek || 4] || TRAINING_SCHEDULES[4];
      const isTodayTrainingDay = schedule.includes(todayDOW);
      const stepsTarget = client.stepsTarget || 10000;

      // Walking target — mandatory every day
      parts.push(`\n\n*Walking today: ${stepsTarget.toLocaleString()} steps.* Send a screenshot or tell me your count.`);

      if (isTodayTrainingDay) {
        // Get today's workout preview
        try {
          const todayWorkout = getKamlifeProgramme(client, true);
          // Just show the first 3 lines as a preview, not the full workout
          const previewLines = todayWorkout.split("\n").slice(0, 5).join("\n");
          parts.push(`\n*Today's workout (Day ${client.programmeDayInWeek || 1}):*\n${previewLines}\n\nReply *1* for the full workout.`);
        } catch {
          parts.push(`\nTraining day. Reply *1* for your workout.`);
        }
      } else {
        parts.push(`\nRest day — no training. Stay on food and steps.`);
      }

      // Food prompt
      parts.push(`\nWhat's for breakfast?`);

      // Append one-tap repeat suggestion if available
      if (repeatSuggestion) parts.push(repeatSuggestion);

      if (canSendProactive(client.id)) {
        await sendWhatsApp(phone, parts.join(" "));
        recordProactiveSend(client.id);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Morning check-in error — ${client.phoneNumber}:`, err);
    }
  }
  saveState("morning_checkin", todayUTC());
}

cron.schedule("0 4 * * *", async () => {
  await runMorningCheckin();
}, { timezone: "UTC" });

// ============================================================
// JOB 2 — EVENING ACCOUNTABILITY
// Runs 7pm SAST (5pm UTC) daily
// ============================================================

async function runEveningAccountability(): Promise<void> {
  console.log("[SCHEDULER] JOB: Evening accountability");
  const clients = await getActiveClients();
  const todayStart = dayStart(0);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      const phone = client.phoneNumber;
      const todayLogs = await getTodayLogs(client.id);

      if (todayLogs.length === 0) {
        if (canSendProactive(client.id)) {
          const isNewClient = !client.totalWorkoutsCompleted && client.createdAt &&
            (Date.now() - new Date(client.createdAt).getTime()) > 6 * 3_600_000 &&
            (Date.now() - new Date(client.createdAt).getTime()) < 48 * 3_600_000;
          if (isNewClient) {
            await sendWhatsApp(phone,
              `${name}, your programme is loaded and ready. Reply *1* to see today's workout — it takes 20 minutes. The first session is always the hardest. Get it done tonight.`
            );
          } else {
            await sendWhatsApp(phone,
              `${name}, it's 7pm and I haven't heard from you today. No judgment. Just tell me one thing — did you move today?`
            );
          }
          recordProactiveSend(client.id);
        }
        continue;
      }

      // Build daily summary for active users
      if (!canSendProactive(client.id)) continue;

      const parts: string[] = [`${name}, day's winding down.`];

      // Food summary — read from mealLogs (source of truth, includes photo/voice logs)
      const calTarget = client.calorieTarget || 1800;
      const protTarget = client.proteinTarget || 130;
      const [mealSum] = await db.select({
        todayCal: sql<number>`COALESCE(SUM(${mealLogs.kcalInt}), 0)::int`,
        todayProt: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
      }).from(mealLogs).where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, todayStart)));
      const todayCal = mealSum?.todayCal || 0;
      const todayProt = mealSum?.todayProt || 0;
      if (todayCal > 0) {
        parts.push(`\n*Food:* ${todayCal} kcal | ${todayProt}g protein (target: ${calTarget} kcal | ${protTarget}g)`);
      } else {
        parts.push(`\n*Food:* No meals logged today.`);
      }

      // Workout check
      const todayWorkouts = await db.select({ id: workoutLogs.id })
        .from(workoutLogs)
        .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, todayStart)))
        .limit(1);
      if (todayWorkouts.length > 0) {
        parts.push(`*Workout:* ✅ Done`);
      } else {
        const schedule = TRAINING_SCHEDULES[client.trainingDaysPerWeek || 4] || TRAINING_SCHEDULES[4];
        const dow = new Date().getDay();
        if (schedule.includes(dow)) {
          parts.push(`*Workout:* ❌ Not logged — still time tonight.`);
        } else {
          parts.push(`*Workout:* Rest day`);
        }
      }

      // Steps check — this is the walking accountability
      const todaySteps = await db.select({ steps: stepLogs.steps })
        .from(stepLogs)
        .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, todayStart)))
        .limit(1);
      const stepsTarget = client.stepsTarget || 10000;
      if (todaySteps.length > 0) {
        const s = todaySteps[0].steps;
        const pct = Math.round((s / stepsTarget) * 100);
        parts.push(`*Walking:* ${s.toLocaleString()} steps (${pct}% of ${stepsTarget.toLocaleString()} target)${s >= stepsTarget ? " ✅" : ""}`);
      } else {
        parts.push(`*Walking:* ❓ No steps logged. Did you walk today? Send your count or a screenshot.`);
      }

      // Daily Win — one concrete win with actual numbers, one clear action for tomorrow
      const hadFood = todayCal > 0;
      const hadWorkout = todayWorkouts.length > 0;
      const hadSteps = todaySteps.length > 0 && todaySteps[0].steps >= stepsTarget;
      const protHit = hadFood && todayProt >= Math.round(protTarget * 0.9);
      const stepCount = todaySteps.length > 0 ? todaySteps[0].steps : 0;

      const score = (hadFood ? 1 : 0) + (hadWorkout ? 1 : 0) + (hadSteps ? 1 : 0);
      if (score === 3) {
        const winDetail = protHit
          ? `${todayProt}g protein — target hit`
          : `session done, food logged, steps in`;
        parts.push(`\n💪 *Win: ${winDetail}.*\nDo it again tomorrow.`);
      } else if (score === 2) {
        const gap = !hadFood ? `Log at least 2 meals` : !hadWorkout ? `Get your session in` : `Hit ${stepsTarget.toLocaleString()} steps`;
        const win = protHit ? `${todayProt}g protein ✓` : hadWorkout ? `Session done ✓` : `${stepCount.toLocaleString()} steps ✓`;
        parts.push(`\n${win}\nTomorrow: ${gap}. Two out of three is progress. Three is the standard.`);
      } else if (score === 1) {
        const win = hadFood ? `Food logged` : hadWorkout ? `Session done` : `${stepCount.toLocaleString()} steps walked`;
        const next = !hadFood ? `log a meal` : !hadWorkout ? `log your session` : `log your steps`;
        parts.push(`\n${win} — build on that tomorrow. Add one more: ${next}.`);
      } else {
        parts.push(`\nTomorrow: log one meal. That is the only job.`);
      }

      await sendWhatsApp(phone, parts.join("\n"));
      recordProactiveSend(client.id);
    } catch (err) {
      console.error(`[SCHEDULER] Evening accountability error — ${client.phoneNumber}:`, err);
    }
  }
  saveState("evening_accountability", todayUTC());
}

cron.schedule("0 17 * * *", async () => {
  await runEveningAccountability();
}, { timezone: "UTC" });

// ============================================================
// JOB 3 — WEEK 3 INTERVENTION
// Runs daily 6am SAST (4am UTC) — sends once per user on their first day of week 3
// ============================================================

cron.schedule("2 4 * * *", async () => {
  console.log("[SCHEDULER] JOB: Week 3 intervention");
  const clients = await getActiveClients();
  const state = loadState();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      if (client.programmeWeek !== 3) continue;
      // Only send once per user when they enter week 3
      const sentKey = `week3_sent_${client.id}`;
      if (state[sentKey] === "sent") continue;
      const name = client.name || "there";
      const workouts = client.totalWorkoutsCompleted || 0;
      const planned = client.trainingDaysPerWeek || 3;
      if (canSendProactive(client.id)) {
        // Check if they have been active recently — if not, make the message more urgent
        const daysSinceActive = client.lastActiveAt
          ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
          : 999;
        const isSlipping = daysSinceActive >= 3;

        const week3Msg = isSlipping
          ? `${name}, I have not heard from you in ${daysSinceActive} days. You are in Week 3 — the week most people quit.\n\n${workouts} sessions completed. That work is real and it does not disappear.\n\nI am not asking for a perfect week. I am asking for ONE session today. Reply *1* and I will send your workout. 20 minutes. That is all.`
          : `${name}, you have ${workouts} sessions banked. Week 3 is where 70% of people disappear — not because it got too hard, but because the mirror has not changed yet. The adaptation is happening in your muscles and metabolism. It is not visible yet but it is real. Show up ${planned} more times this week. That is all.`;
        await sendWhatsApp(client.phoneNumber, week3Msg);
        recordProactiveSend(client.id);
        saveState(sentKey, "sent");
      }
    } catch (err) {
      console.error(`[SCHEDULER] Week 3 intervention error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 4 — MONTH-END BUDGET MODE
// Runs 20th of each month, 10am SAST (8am UTC)
// ============================================================

cron.schedule("0 8 20 * *", async () => {
  console.log("[SCHEDULER] JOB: Month-end budget mode");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      const budget = client.weeklyFoodBudget || "100_300";

      let budgetMsg: string;
      if (budget === "under_50" || budget === "50_100") {
        budgetMsg = `${name}, month end is coming. Your R57 emergency plan — eggs R25, pilchards R12, sugar beans R20. This covers your protein for 4 days. Shop this weekend before the money is gone.`;
      } else if (budget === "100_300") {
        budgetMsg = `${name}, month end approaching. Your R100 week plan — eggs 12 pack R45, pilchards 3 tins R36, cabbage R8, onions R8, pap 2kg R15. Enough for the full week. Shop at Shoprite or Boxer this weekend.`;
      } else {
        budgetMsg = `${name}, month end coming. You have more budget flexibility than most clients — still prioritise protein. Pre-cook chicken, buy oats in bulk, and prep your meals Sunday. Consistency over the month end is what separates people who get results.`;
      }
      if (canSendProactive(client.id)) {
        await sendWhatsApp(client.phoneNumber, budgetMsg);
        recordProactiveSend(client.id);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Month-end budget error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 5 — MILESTONE CELEBRATIONS
// Runs 8am SAST (6am UTC) daily
// ============================================================

// Day milestones — specific to each client's actual numbers
function buildDayMilestoneMessage(name: string, days: number, workouts: number, weightKg: string | null): string {
  if (days === 7) {
    return `${name}, seven days in. ${workouts > 0 ? `${workouts} session${workouts > 1 ? "s" : ""} done.` : "Keep building."} Most people quit before week two — you are still here.\n\n🔓 *Week 2 unlocked:* Your programme steps up in intensity this week. Send your weight today so I can calibrate.`;
  }
  if (days === 14) {
    return `${name}, two weeks. ${workouts > 0 ? `${workouts} sessions logged.` : "The habit is forming."} Two weeks is when the body starts adapting — not just to training, but to the routine itself.\n\n🔓 *Consistency badge:* You have shown up for 14 days. That puts you ahead of 80% of people who start. Keep this momentum into week 3.`;
  }
  if (days === 30) {
    const weightLine = weightKg ? `You started at ${weightKg}kg. ` : "";
    return `${name}, 30 days. ${weightLine}${workouts} workouts completed. The people who last 30 days are the ones who get results — and you are one of them. Measurements today — waist, hips, chest. Send them to me.`;
  }
  if (days === 60) {
    return `${name}, 60 days. ${workouts} sessions logged. That kind of consistency is genuinely rare — most people have been and gone twice already. Send your weight today. I want to see the 60-day number.`;
  }
  if (days === 90) {
    return `${name}, 90 days and ${workouts} workouts. You have built a real habit now. This is where things compound — the next 90 will look different because your body is different. Progress photo today. Send it to me.`;
  }
  if (days === 180) {
    return `${name}, 6 months. ${workouts} workouts. Whatever brought you here — it worked. Progress photo today. I want to see what 180 days of work looks like on your body.`;
  }
  if (days === 365) {
    return `${name}, one year. I do not have words for what you have done this year. ${workouts} workouts. 365 days. Send me a photo. This moment deserves to be seen.`;
  }
  return "";
}

// Workout count milestones — celebrate real numbers with voice note
// Early milestones (1, 3, 5) are the most important for retention:
// the first 7 days determine whether someone stays. Fire these inline
// via checkWorkoutMilestone() in routes.ts (not the cron, which runs at 6am
// and would be too late for same-day celebration).
const WORKOUT_MILESTONES: Record<number, (name: string) => string> = {
  1:   (n) => `${n} — first session done. 🎉 That's the hardest one. Every session from here is proof you're not just talking about it.`,
  3:   (n) => `${n}, 3 sessions in. The habit is starting. Most people who make it to 3 make it to 10. Keep going.`,
  5:   (n) => `${n}, 5 sessions. 🔥 High five. You've officially started. Some people joined the same day as you and have already quit — you haven't.`,
  10:  (n) => `${n}, 10 sessions done. That is the first real milestone — most people never get here. The habit is forming. Keep going.`,
  25:  (n) => `${n}, 25 workouts. A quarter century of sessions. You are not talking about fitness anymore. You are doing it.`,
  50:  (n) => `${n}, 50 sessions. Fifty times you showed up when you could have stayed home. That is not motivation — that is discipline. Lekker work.`,
  100: (n) => `${n}, 100 workouts. One hundred sessions. That number puts you in a category most people never reach. Whatever happens next — you earned this.`,
};

cron.schedule("0 6 * * *", async () => {
  console.log("[SCHEDULER] JOB: Milestone celebrations");
  const clients = await getActiveClients();
  const state = loadState();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      const workouts = client.totalWorkoutsCompleted || 0;
      const days = programmeDaysSince(client.programmeStartDate);

      // Day milestones — naturally de-duplicated because `days` is exact on one calendar date
      if ([7, 14, 30, 60, 90, 180, 365].includes(days)) {
        const firstWeight = await db.select({ weight: weightLogs.weight })
          .from(weightLogs)
          .where(eq(weightLogs.userId, client.id))
          .orderBy(asc(weightLogs.loggedAt))
          .limit(1);
        const firstWeightKg = firstWeight[0]?.weight ? String(firstWeight[0].weight) : null;
        const msg = buildDayMilestoneMessage(name, days, workouts, firstWeightKg);
        if (msg) await sendWhatsApp(client.phoneNumber, msg);
      }

      // Workout count milestones — de-duplicated via state file so they only fire once per milestone
      const workoutMilestoneText = WORKOUT_MILESTONES[workouts];
      if (workoutMilestoneText) {
        const milestoneKey = `workout_milestone_${workouts}_${client.id}`;
        if (state[milestoneKey] === "sent") continue;
        const text = workoutMilestoneText(name);
        // Try to send as voice note for the biggest moments
        const voiceUrl = [25, 50, 100].includes(workouts) ? await generateVoiceNote(text) : null;
        await sendWhatsApp(client.phoneNumber, text, voiceUrl || undefined);
        saveState(milestoneKey, "sent");
      }
    } catch (err) {
      console.error(`[SCHEDULER] Milestone error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 6 — SILENCE DETECTION
// Runs every 12 hours (6am and 6pm SAST = 4am and 4pm UTC)
// ============================================================

cron.schedule("4 4,16 * * *", async () => {
  console.log("[SCHEDULER] JOB: Silence detection");
  const clients = await getActiveClients();
  const now = Date.now();
  const HOUR = 3_600_000;

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      if (!client.lastActiveAt) continue;
      const name = client.name || "there";
      const silenceMs = now - new Date(client.lastActiveAt).getTime();

      const workouts = client.totalWorkoutsCompleted || 0;
      const week = client.programmeWeek || 1;

      if (silenceMs >= 14 * 24 * HOUR && silenceMs < 14 * 24 * HOUR + 12 * HOUR) {
        // 14-day silence: final re-engagement with personal data
        await sendWhatsApp(client.phoneNumber,
          `${name}, two weeks. ${workouts} sessions logged. Week ${week} of your programme. All saved.\n\nI am not going anywhere. When you are ready, just say Hi — I will tell you exactly where you left off and what to do next. No judgement. No starting over.`
        );
        try {
          await db.insert(escalations).values({
            userId: client.id,
            reason: "14_day_silence",
            status: "open",
            priority: "urgent",
            slaDeadline: new Date(Date.now() + 48 * HOUR),
          });
          console.log(`[SCHEDULER] 14-day silence — escalation created: ${client.phoneNumber}`);
        } catch (flagErr) {
          console.error(`[SCHEDULER] Failed to create escalation for ${client.phoneNumber}:`, flagErr);
        }
      } else if (silenceMs >= 7 * 24 * HOUR && silenceMs < 7 * 24 * HOUR + 12 * HOUR) {
        // 7-day silence: use workout data to pull them back
        await sendWhatsApp(client.phoneNumber,
          `${name}, a week since we spoke. ${workouts > 0 ? `You have ${workouts} sessions in the bank — that does not disappear.` : "Your programme is ready and waiting."} Life gets busy — I get it.\n\nReply *1* to see today's workout. That is all — one session.`
        );
      } else if (silenceMs >= 48 * HOUR && silenceMs < 48 * HOUR + 12 * HOUR) {
        await sendWhatsApp(client.phoneNumber,
          `${name}, two days quiet. Everything okay? No pressure. Just checking.`
        );
      }
    } catch (err) {
      console.error(`[SCHEDULER] Silence detection error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 7 — FRIDAY WEEKEND STRATEGY
// Runs Friday 4pm SAST (2pm UTC)
// ============================================================

cron.schedule("0 14 * * 5", async () => {
  console.log("[SCHEDULER] JOB: Friday weekend strategy");
  const clients = await getActiveClients();
  const MESSAGE_KEY = "friday_weekend";
  const dedupeWindow = thisWeekUTC(); // Monday date — rolls every 7 days
  let sent = 0, skippedPaused = 0, skippedSilent = 0, skippedDup = 0, skippedBudget = 0;

  for (const client of clients) {
    if (isPaused(client)) { skippedPaused++; continue; }

    // Skip silent clients — they already get targeted re-engagement from the
    // silence-detection job (2/7/14/30 day windows). The weekend nudge is
    // noise for someone who has not messaged in over a week and is likely to
    // push them toward BLOCK rather than re-engage.
    const daysSilent = client.lastActiveAt
      ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
      : Math.floor((Date.now() - new Date(client.createdAt || Date.now()).getTime()) / 86_400_000);
    if (daysSilent > 10) { skippedSilent++; continue; }

    // Daily budget (2 proactive msgs/day across all jobs) — cheap in-memory check first
    if (!canSendProactive(client.id)) { skippedBudget++; continue; }

    // Durable per-message dedupe — DB-backed, survives process restart
    const claimed = await claimProactive(client.id, MESSAGE_KEY, dedupeWindow);
    if (!claimed) { skippedDup++; continue; }

    try {
      const name = client.name || "there";
      await sendWhatsApp(client.phoneNumber,
        `${name}, weekend is here. This is where most people lose the progress they built Monday to Friday. Two rules only — protein at every meal and one training session before Sunday night. That is it. Everything else is flexible.`
      );
      recordProactiveSend(client.id);
      sent++;
    } catch (err) {
      console.error(`[SCHEDULER] Friday strategy error — ${client.phoneNumber}:`, err);
    }
  }
  console.log(`[SCHEDULER] Friday weekend — sent:${sent} paused:${skippedPaused} silent:${skippedSilent} dup:${skippedDup} budget:${skippedBudget}`);
}, { timezone: "UTC" });

// ============================================================
// JOB 8 — SUNDAY WEEKLY REPORT
// Runs Sunday 8am SAST (6am UTC)
// ============================================================

cron.schedule("0 6 * * 0", async () => {
  console.log("[SCHEDULER] JOB: Sunday weekly report");
  const clients = await getActiveClients();
  const weekAgo = new Date(Date.now() - 7 * 86400000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";

      // Single parallel fetch for all week data
      const [chats, workoutEntries, weightEntries, stepEntries] = await Promise.all([
        db.select().from(chatHistory).where(and(eq(chatHistory.userId, client.id), gte(chatHistory.createdAt, weekAgo))),
        db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, weekAgo))),
        db.select().from(weightLogs).where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, weekAgo))).orderBy(asc(weightLogs.loggedAt)),
        db.select({ steps: stepLogs.steps, loggedAt: stepLogs.loggedAt }).from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, weekAgo))),
      ]);

      // No logs at all — send a nudge, not a report
      if (chats.length === 0) {
        await sendWhatsApp(client.phoneNumber,
          `${name}, no logs this week means no data to coach from. This week log at least one meal per day — that is the only focus. Nothing else.`
        );
        continue;
      }

      const daysWithLogs = new Set(chats.map(c => new Date(c.createdAt!).toDateString())).size;
      if (daysWithLogs < 3) {
        await sendWhatsApp(client.phoneNumber,
          `${name}, ${daysWithLogs} day${daysWithLogs !== 1 ? "s" : ""} logged this week. That is not enough for me to coach you properly. Aim for at least 5 this week — just log one meal a day minimum.`
        );
        continue;
      }

      const foodLogs = chats.filter(c => c.intent === "FOOD_LOG");
      const plannedSessions = client.trainingDaysPerWeek || 3;
      const completedSessions = workoutEntries.length;
      const weekNum = client.programmeWeek || 1;
      const proteinTarget = client.proteinTarget || 120;
      const stepsTarget = client.stepsTarget || 8500;

      // ── Weight line ────────────────────────────────────────
      let weightLine = "";
      let weightEmoji = "⚖️";
      if (weightEntries.length >= 2) {
        const diff = parseFloat(String(weightEntries[weightEntries.length - 1].weight)) - parseFloat(String(weightEntries[0].weight));
        if (diff < -0.1) { weightLine = `${Math.abs(diff).toFixed(1)}kg down`; weightEmoji = "📉"; }
        else if (diff > 0.1) { weightLine = `${diff.toFixed(1)}kg up`; weightEmoji = "📈"; }
        else { weightLine = "unchanged"; weightEmoji = "➡️"; }
      } else if (weightEntries.length === 1) {
        weightLine = `${weightEntries[0].weight}kg logged`;
      } else {
        weightLine = "not logged — weigh in Monday morning";
      }

      // ── Steps average ──────────────────────────────────────
      let stepsLine = "";
      let stepsEmoji = "👟";
      if (stepEntries.length > 0) {
        const avgSteps = Math.round(stepEntries.reduce((s, l) => s + (l.steps || 0), 0) / stepEntries.length);
        const pct = Math.round((avgSteps / stepsTarget) * 100);
        stepsEmoji = pct >= 100 ? "✅" : pct >= 75 ? "👟" : "⚠️";
        stepsLine = `${avgSteps.toLocaleString()} avg (${pct}% of ${stepsTarget.toLocaleString()} target)`;
      } else {
        stepsLine = "not logged this week";
        stepsEmoji = "⚠️";
      }

      // ── Protein hit rate ───────────────────────────────────
      const PROTEIN_RICH = ["chicken", "eggs", "pilchards", "tuna", "beef", "fish", "beans", "greek yogurt", "cottage cheese", "whey", "steak", "pork", "turkey", "mince", "biltong", "sardines", "lentils"];
      const JUNK = ["kfc", "mcdonalds", "nandos", "pizza", "chips", "vetkoek", "kotas", "polony", "chocolate", "cool drink", "alcohol", "beer", "wine", "magwinya", "fat cake"];

      const foodDays = new Set(foodLogs.map(c => new Date(c.createdAt!).toDateString())).size;
      const proteinDays = new Set(
        foodLogs.filter(l => PROTEIN_RICH.some(w => (l.messageIn || "").toLowerCase().includes(w)))
          .map(c => new Date(c.createdAt!).toDateString())
      ).size;
      const proteinHitRate = foodDays > 0 ? Math.round((proteinDays / foodDays) * 100) : 0;
      const proteinEmoji = proteinHitRate >= 80 ? "✅" : proteinHitRate >= 50 ? "⚠️" : "❌";

      // ── Training emoji ─────────────────────────────────────
      const trainPct = Math.round((completedSessions / plannedSessions) * 100);
      const trainEmoji = trainPct >= 100 ? "✅" : trainPct >= 66 ? "💪" : "⚠️";

      // ── Workout streak ─────────────────────────────────────
      const streak = client.workoutStreak || 0;
      const streakLine = streak > 0 ? `🔥 ${streak}-session streak` : "";

      // ── Pattern / warning ──────────────────────────────────
      const junkCount = foodLogs.filter(l => JUNK.some(w => (l.messageIn || "").toLowerCase().includes(w))).length;
      const noProteinDays = foodDays - proteinDays;
      let warning = "";
      if (junkCount >= 3) warning = `⚠️ Junk appeared ${junkCount}x — one bad meal is recoverable, four is a pattern.`;
      else if (noProteinDays >= 3) warning = `⚠️ ${noProteinDays} days with no protein logged — eggs, pilchards, or beans at every meal.`;
      else if (completedSessions === 0) warning = `⚠️ Zero sessions this week — one session this week is all I need from you.`;

      // ── Next week focus ────────────────────────────────────
      let focus = "";
      if (completedSessions < plannedSessions) focus = `Train ${plannedSessions - completedSessions} more time${plannedSessions - completedSessions !== 1 ? "s" : ""} than last week.`;
      else if (proteinHitRate < 60) focus = `Protein at every meal — eggs, pilchards, beans, chicken.`;
      else if (stepEntries.length === 0) focus = `Log your steps at least 3 days this week.`;
      else focus = `Maintain the consistency — same output or better.`;

      // ── Score (0–100) ──────────────────────────────────────
      const logScore = Math.round((daysWithLogs / 7) * 25);
      const trainScore = Math.round((Math.min(completedSessions, plannedSessions) / plannedSessions) * 35);
      const proteinScore = Math.round((proteinHitRate / 100) * 25);
      const stepsScore = stepEntries.length > 0 ? Math.round((Math.min(1, stepEntries.reduce((s, l) => s + (l.steps || 0), 0) / stepEntries.length / stepsTarget)) * 15) : 0;
      const totalScore = logScore + trainScore + proteinScore + stepsScore;
      const scoreLabel = totalScore >= 85 ? "Outstanding" : totalScore >= 70 ? "Strong" : totalScore >= 50 ? "Building" : "Below target";

      // ── Assemble report card ───────────────────────────────
      const lines = [
        `*${name} — Week ${weekNum} Report Card*`,
        ``,
        `${trainEmoji} Training: ${completedSessions}/${plannedSessions} sessions`,
        `${weightEmoji} Weight: ${weightLine}`,
        `${stepsEmoji} Steps: ${stepsLine}`,
        `${proteinEmoji} Protein days: ${proteinDays}/${foodDays} meals tracked`,
        `📅 Logged: ${daysWithLogs}/7 days`,
        streakLine ? streakLine : "",
        ``,
        `*Weekly Score: ${totalScore}/100 — ${scoreLabel}*`,
        ``,
      ].filter(l => l !== null);

      if (warning) lines.push(warning, ``);
      lines.push(`*This week:* ${focus}`);

      // Personal sign-off based on score
      if (totalScore >= 85) {
        lines.push(``, `${name}, this is what results look like. Same energy next week.`);
      } else if (totalScore >= 60) {
        lines.push(``, `Solid week, ${name}. One more push and you are in the top tier. Go.`);
      } else {
        lines.push(``, `${name}, below your best but you are still here. That matters. Reset Sunday night and go again Monday.`);
      }

      await sendWhatsApp(client.phoneNumber, lines.join("\n"));

      // Send shopping list for next week — 30 seconds after report
      try {
        const budgetTier = client.weeklyFoodBudget || "100_300";
        const clientGoal = client.goalType || "fat_loss";
        const list = getShoppingList(budgetTier, weekNum + 1, clientGoal);
        const shoppingMsg = formatShoppingList(list, name, clientGoal);
        await sendWhatsApp(client.phoneNumber, shoppingMsg);
      } catch (shopErr) {
        console.warn(`[SCHEDULER] Shopping list error — ${client.phoneNumber}:`, shopErr);
      }

      // Advance programme day for next week
      try {
        const newDay = ((client.programmeDayInWeek || 1) % 4) + 1;
        const newWeek = newDay === 1 ? (weekNum + 1) : weekNum;
        await db.update(users).set({
          programmeDayInWeek: newDay,
          programmeWeek: newWeek,
        }).where(eq(users.id, client.id));
      } catch { /* non-critical */ }

    } catch (err) {
      console.error(`[SCHEDULER] Sunday report error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB — SUNDAY EVENING PERSONAL CHECK-IN
// Runs Sunday 5pm UTC (7pm SAST)
// Asks ONE specific question based on each client's actual week
// ============================================================

cron.schedule("0 17 * * 0", async () => {
  console.log("[SCHEDULER] JOB: Sunday evening check-in");
  const clients = await getActiveClients();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      const plannedSessions = client.trainingDaysPerWeek || 3;

      // Query this week's actual data
      const [weekWorkouts, weekSteps, weekFoodLogs] = await Promise.all([
        db.select().from(workoutLogs)
          .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, weekAgo))),
        db.select().from(stepLogs)
          .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, weekAgo))),
        db.select().from(chatHistory)
          .where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, weekAgo))),
      ]);

      const completedSessions = weekWorkouts.length;
      const avgSteps = weekSteps.length > 0
        ? Math.round(weekSteps.reduce((s, l) => s + (l.steps || 0), 0) / weekSteps.length)
        : 0;

      // Build one specific question based on the biggest gap this week
      let question: string;

      if (completedSessions === 0 && weekFoodLogs.length === 0) {
        // Nothing logged all week — re-engage them
        question = `${name}, this week was quiet. One question — what got in the way?`;
      } else if (completedSessions >= plannedSessions && weekFoodLogs.length >= 5) {
        // Strong week — celebrate and ask forward-looking question
        question = `${name}, ${completedSessions} sessions done this week and food tracked. Solid week. What was the hardest part?`;
      } else if (completedSessions < Math.ceil(plannedSessions * 0.5)) {
        // Missed more than half their sessions
        question = `${name}, ${completedSessions} of ${plannedSessions} sessions this week. What kept you from the other ${plannedSessions - completedSessions}?`;
      } else if (weekFoodLogs.length < 3) {
        // Training but not tracking food
        question = `${name}, ${completedSessions} sessions done. Food tracking was thin this week. What makes it hard to log?`;
      } else if (avgSteps > 0 && avgSteps < (client.stepsTarget || 8500) * 0.6) {
        // Steps consistently low
        question = `${name}, average steps this week: ${avgSteps.toLocaleString()}. Steps are your daily fat-burning base. What is the real barrier to walking more?`;
      } else {
        // General check-in
        question = `${name}, week done. ${completedSessions} sessions, ${weekFoodLogs.length} meals logged. One sentence — what do you want to be different next week?`;
      }

      if (canSendProactive(client.id)) {
        await sendWhatsApp(client.phoneNumber, question);
        recordProactiveSend(client.id);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Sunday check-in error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 9 — EARLY ONBOARDING (Days 1, 2, 3)
// Runs 10am SAST (8am UTC) daily
// ============================================================

cron.schedule("0 8 * * *", async () => {
  console.log("[SCHEDULER] JOB: Early onboarding check");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const days = programmeDaysSince(client.programmeStartDate);
      const name = client.name || "there";
      if (canSendProactive(client.id)) {
        if (days === 1) {
          await sendWhatsApp(client.phoneNumber,
            `${name}, Day 1. Your programme is live and ready.\n\nReply:\n• "today" for your workout\n• "2" to log food\n• "3" to log your steps\n\nOne small action today is better than a perfect week planned and not started.`
          );
          recordProactiveSend(client.id);
        } else if (days === 2) {
          await sendWhatsApp(client.phoneNumber,
            `Day 2, ${name}. How did Day 1 go? Reply DONE if you completed the session, or just tell me what happened. No judgment — just forward.`
          );
          recordProactiveSend(client.id);
        } else if (days === 3) {
          await sendWhatsApp(client.phoneNumber,
            `3 days in, ${name}. Most people have already quit by now. You are still here. That already puts you ahead. Send me today's food and keep the momentum going.`
          );
          recordProactiveSend(client.id);
        } else if (days === 5) {
          // Day 5 — value proof: show what they have achieved so far
          const workoutsDone = client.totalWorkoutsCompleted || 0;
          const todayStart = sastDayStart();
          const fiveDaysAgoOnb = new Date(Date.now() - 5 * 86_400_000);
          const recentSteps = await db.select({ steps: stepLogs.steps })
            .from(stepLogs)
            .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, fiveDaysAgoOnb)));
          const totalStepsLogged = recentSteps.reduce((s, r) => s + (r.steps || 0), 0);
          const recentFoodLogs = await db.select({ id: chatHistory.id })
            .from(chatHistory)
            .where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, fiveDaysAgoOnb)));
          await sendWhatsApp(client.phoneNumber,
            `Day 5, ${name}. Here is what you have built in less than a week:\n\n✅ ${workoutsDone} workout${workoutsDone !== 1 ? "s" : ""} completed\n👟 ${totalStepsLogged.toLocaleString()} steps logged\n🍽 ${recentFoodLogs.length} meal${recentFoodLogs.length !== 1 ? "s" : ""} tracked\n\nThis is data. Data becomes results. Most people never get this far. You did.\n\nKeep logging — reply *1* for today's workout.`
          );
          recordProactiveSend(client.id);
        } else if (days === 7) {
          // Day 7 — week-1 milestone, build commitment
          const workoutsDone = client.totalWorkoutsCompleted || 0;
          const goal = client.goalType === "muscle_gain" ? "building muscle" : client.goalType === "recomposition" ? "body recomp" : "fat loss";
          await sendWhatsApp(client.phoneNumber,
            `One week done, ${name}. Seven days of showing up.\n\n${workoutsDone >= 3 ? `${workoutsDone} sessions this week — you are on track.` : workoutsDone > 0 ? `${workoutsDone} session${workoutsDone !== 1 ? "s" : ""} done — aim for ${client.trainingDaysPerWeek || 3} next week.` : "No sessions logged yet — this week, do one. Just one."}\n\n*What happens in Week 2:*\nYour body starts adapting. Energy improves. Soreness decreases. The habit begins to form. Most ${goal} results show at Week 4-6 — you are building the foundation right now.\n\nReply *menu* to see all your options. Keep going.`
          );
          recordProactiveSend(client.id);
        }
      }
    } catch (err) {
      console.error(`[SCHEDULER] Early onboarding error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 10 — MONTHLY MEASUREMENTS
// Runs 1st of each month, 9am SAST (7am UTC)
// ============================================================

cron.schedule("0 7 1 * *", async () => {
  console.log("[SCHEDULER] JOB: Monthly measurements");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    if (!canSendProactive(client.id)) continue;
    try {
      const name = client.name || "there";
      await sendWhatsApp(client.phoneNumber,
        `${name}, it is the 1st. Measurement day.\n\nGet a tape measure and send me:\n\nWaist: Xcm\nHips: Xcm\nChest: Xcm\nArm: Xcm\n\nWeigh in as well. Same conditions — morning, after bathroom, before food. The tape does not lie when the scale does.`
      );
      recordProactiveSend(client.id);
    } catch (err) {
      console.error(`[SCHEDULER] Monthly measurements error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB — PRE-TRAINING NUTRITION REMINDER
// Runs 12pm SAST (10am UTC) Monday–Saturday
// Only fires for clients whose training days include today
// Reminds them to eat 1–2 hours before training
// ============================================================

// DISABLED FOR LAUNCH — daily cap means this rarely fires anyway; reduces noise
// cron.schedule("0 10 * * 1-6", async () => {
if (false) (async () => {
  console.log("[SCHEDULER] JOB: Pre-training nutrition reminder");
  const clients = await getActiveClients();
  const todayDOW = new Date(Date.now() + 2 * 3_600_000).getUTCDay(); // SAST day-of-week

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const trainingDays = client.trainingDaysPerWeek || 3;
      const mode = client.trainingMode || "home";
      const name = client.name || "there";

      // Determine if today is a training day for this client based on their schedule
      const schedule = TRAINING_SCHEDULES[trainingDays] || TRAINING_SCHEDULES[3];
      if (!schedule.includes(todayDOW)) continue;

      // Only send if they have not already trained today
      const todayStart = sastDayStart();
      const [todayWorkout, todayFoodLog] = await Promise.all([
        db.select({ id: workoutLogs.id }).from(workoutLogs)
          .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, todayStart)))
          .limit(1),
        db.select({ messageIn: chatHistory.messageIn }).from(chatHistory)
          .where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)))
          .limit(1),
      ]);

      // Skip if already trained today
      if (todayWorkout.length > 0) continue;

      const goal = client.goalType || "fat_loss";
      const isMuscleGain = goal === "muscle_gain";
      const medicals = (client.medicalConditions || "").split(",").map((s: string) => s.trim());
      const isDiabetic = medicals.includes("diabetes") || medicals.includes("pcos");

      // Build the pre-training meal recommendation based on goal and mode
      let preTrainingMsg: string;
      if (isDiabetic) {
        preTrainingMsg = `${name}, training day. Eat 1–2 hours before your session — low GI carbs and protein. Oats with eggs or samp and beans. Never train fasted with diabetes. Session starts: reply "today" for your workout.`;
      } else if (isMuscleGain) {
        preTrainingMsg = `${name}, training day. Pre-workout meal now — carbs and protein 1–2 hours before your session. Rice or sweet potato with chicken or eggs. This fuels your lifts. Reply "today" for your ${mode === "gym" ? "gym" : "home"} workout.`;
      } else if (todayFoodLog.length === 0) {
        preTrainingMsg = `${name}, training day. Eat something before your session — 2 eggs or oats at minimum. Fasted training works but food-fuelled training is better for fat loss long term. Reply "today" for your workout.`;
      } else {
        preTrainingMsg = `${name}, training day. Pre-training meal 1 hour out — protein and a small carb. Eggs or oats. Then reply "today" and get the session done.`;
      }

      if (canSendProactive(client.id)) {
        await sendWhatsApp(client.phoneNumber, preTrainingMsg);
        recordProactiveSend(client.id);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Pre-training reminder error — ${client.phoneNumber}:`, err);
    }
  }
})(); // DISABLED

// ============================================================
// JOB 11 — SA CULTURAL CALENDAR
// Runs 7am SAST (5am UTC) daily — only fires on specific dates
// ============================================================

function getSACulturalEvent(month: number, day: number): ((name: string) => string) | null {
  if (month === 1 && day === 1) return (n) =>
    `Happy New Year, ${n}. Everyone starts January motivated. Most are done by the 15th. You will not be most people. Today — one training session and one good meal. That is how the year starts. Not with a resolution. With an action.`;

  if (month === 6 && day === 16) return (n) =>
    `Youth Day, ${n}. Today honours those who stood up when it was hard. Your fitness journey is not political — but the principle is the same. Do the hard thing today. Send me your workout when you're done.`;

  if (month === 8 && day === 9) return (n) =>
    `Women's Day, ${n}. To every woman on this programme — the strength you are building in the gym is the same strength that carries everything else. Today's session is for you. Do it for you. Reply "today" for your workout.`;

  if (month === 9 && day === 24) return (n) =>
    `Heritage Day, ${n}. National Braai Day. Here is your braai coaching: boerewors — 36g protein per coil, high fat. Chicken — always remove skin. Corn on the braai — fine as a carb. Potato salad — skip the mayo or go small. Beer — 150 calories each, zero protein. Enjoy the braai and log your food tonight.`;

  if (month === 12 && day === 1) return (n) =>
    `${n}, December starts today. This is the month most programmes fall apart. Two rules for the whole month: protein at every meal and at least one training session per week. Everything else is negotiable. Festive season is not an excuse. It is a test.`;

  if (month === 12 && day === 16) return (n) =>
    `Day of Reconciliation, ${n}. Festive season is in full swing. Your body does not take public holidays. Keep the protein up and do not let December undo what you built all year. You are too far in to stop now.`;

  return null;
}

cron.schedule("0 5 * * *", async () => {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const eventFn = getSACulturalEvent(month, day);
  if (!eventFn) return;

  console.log(`[SCHEDULER] JOB: Cultural event — ${month}/${day}`);
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      await sendWhatsApp(client.phoneNumber, eventFn(name));
    } catch (err) {
      console.error(`[SCHEDULER] Cultural event error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 11B — MIDDAY ACTIVATION NUDGE
// Runs 1pm SAST (11am UTC), Monday–Saturday.
// Targets active clients who haven't logged ANYTHING today — no food,
// no steps, no workout. These are morning-message readers who didn't
// reply. One short nudge at 1pm catches them before the day is lost.
// Skips users who are 3+ days silent (handled by re-engagement flow).
// ============================================================

// DISABLED FOR LAUNCH — daily cap blocks this after morning anyway; re-enable when engagement data justifies it
if (false) (async () => {
  console.log("[SCHEDULER] JOB: Midday activation nudge");
  const clients = await getActiveClients();
  const todayStart = sastDayStart();
  let sent = 0;

  for (const client of clients) {
    if (isPaused(client)) continue;
    if (!canSendProactive(client.id)) continue;

    // Skip re-engagement track (3+ days silent) — they get a different flow
    const daysSilent = client.lastActiveAt
      ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
      : 0;
    if (daysSilent >= 3) continue;

    try {
      // Check if they've logged anything today (food, steps, or workout)
      const [todayFoodLog, todayStepLog, todayWorkoutLog] = await Promise.all([
        db.select({ id: chatHistory.id }).from(chatHistory)
          .where(and(
            eq(chatHistory.userId, client.id),
            gte(chatHistory.createdAt, todayStart),
            sql`${chatHistory.intent} IN ('FOOD_LOG', 'STEP_LOG', 'WORKOUT_LOG')`,
          )).limit(1),
        db.select({ id: stepLogs.id }).from(stepLogs)
          .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, todayStart))).limit(1),
        db.select({ id: workoutLogs.id }).from(workoutLogs)
          .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, todayStart))).limit(1),
      ]);

      // Only nudge if NOTHING at all has been logged today
      if (todayFoodLog.length > 0 || todayStepLog.length > 0 || todayWorkoutLog.length > 0) continue;

      const name = client.name?.split(" ")[0] || "there";
      await sendWhatsApp(client.phoneNumber,
        `${name}. It's afternoon and nothing logged today.\n\nTell me what you had for breakfast or lunch — one message keeps the day alive.`
      );
      recordProactiveSend(client.id);
      sent++;
    } catch (err) {
      console.error(`[SCHEDULER] Midday nudge error — ${client.phoneNumber}:`, err);
    }
  }
  console.log(`[SCHEDULER] Midday nudge: ${sent} sent`);
})(); // DISABLED

// ============================================================
// JOB 12 — 14-DAY AND 30-DAY SILENCE ESCALATION
// Runs every 12 hours alongside silence detection
// ============================================================

cron.schedule("0 5,18 * * *", async () => {
  console.log("[SCHEDULER] JOB: Deep silence escalation");
  const clients = await getActiveClients();
  const now = Date.now();
  const HOUR = 3_600_000;

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      if (!client.lastActiveAt) continue;
      const name = client.name || "there";
      const silenceMs = now - new Date(client.lastActiveAt).getTime();
      const workouts = client.totalWorkoutsCompleted || 0;
      const week = client.programmeWeek || 1;

      // 14-day silence — more personal, reference their history
      if (silenceMs >= 14 * 24 * HOUR && silenceMs < 14 * 24 * HOUR + 12 * HOUR) {
        const historyNote = workouts > 0
          ? `You have ${workouts} session${workouts !== 1 ? "s" : ""} logged. That work does not disappear.`
          : `Your programme is still here waiting.`;
        await sendWhatsApp(client.phoneNumber,
          `${name}, two weeks since I heard from you. ${historyNote} Life is not always linear — I know that. When you are ready, just reply with one word: "back". We go from exactly where you left off, week ${week}, no questions asked.`
        );

      // 30-day silence — pause message, not cancellation
      } else if (silenceMs >= 30 * 24 * HOUR && silenceMs < 30 * 24 * HOUR + 12 * HOUR) {
        await sendWhatsApp(client.phoneNumber,
          `${name}, a month of silence. I am not going to keep messaging you after this. Your profile is saved, your programme is saved, everything is exactly as you left it. When life settles and you are ready — just say "back" and we go again. No judgment.`
        );
      }
    } catch (err) {
      console.error(`[SCHEDULER] Deep silence error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 13 — REFERRAL NUDGE AFTER MILESTONES
// Runs daily at 9am SAST (7am UTC) — fires only on day 7, 30, 60, 90
// ============================================================

cron.schedule("0 7 * * *", async () => {
  console.log("[SCHEDULER] JOB: Referral nudge");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const days = programmeDaysSince(client.programmeStartDate);
      if (![7, 30, 60, 90].includes(days)) continue;
      if (!client.referralCode) continue; // Only nudge if they have a code

      const name = client.name || "there";
      const code = client.referralCode;

      const msgs: Record<number, string> = {
        7: `${name}, one week in and you are still here — most people are not. If you know someone who needs this, your referral code is *${code}*. They get their first month for R50. You get R20 off yours. Share it with one person today.`,
        30: `${name}, 30 days with Coach K. You are proof this works. Someone in your contacts needs to hear about this — share your code *${code}* and let them start where you did. One message, one person.`,
        60: `${name}, 60 days in. Two months of real work. People around you have noticed. When they ask what you are doing, tell them — and share code *${code}*. Every referral earns you R20 off. No limit.`,
        90: `${name}, 90 days. A quarter year of consistency. That is rare and worth talking about. Your code is *${code}* — share it with someone who has been talking about getting fit. They get a cheaper start. You get rewarded.`,
      };

      await sendWhatsApp(client.phoneNumber, msgs[days]);
    } catch (err) {
      console.error(`[SCHEDULER] Referral nudge error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 14 — GOAL REASSESSMENT AT 30 / 60 / 90 DAYS
// Runs daily at 11am SAST (9am UTC)
// ============================================================

cron.schedule("0 9 * * *", async () => {
  console.log("[SCHEDULER] JOB: Goal reassessment check");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const days = programmeDaysSince(client.programmeStartDate);
      const name = client.name || "there";
      const goal = client.goalType || "fat_loss";
      const goalLabel: Record<string, string> = {
        fat_loss: "fat loss", muscle_gain: "muscle gain",
        recomposition: "body recomposition", general: "general fitness",
      };

      if (days === 30) {
        await sendWhatsApp(client.phoneNumber,
          `${name}, 30 days in. Time to check in properly.\n\nWeigh yourself this morning and send me the number. Also — is your goal still ${goalLabel[goal] || goal}? Or has something shifted? One reply: your weight in kg, and yes or no if the goal is the same.`
        );
      } else if (days === 60) {
        const weight = client.currentWeight ? `You started at ${client.currentWeight}kg.` : "";
        await sendWhatsApp(client.phoneNumber,
          `${name}, 60 days. ${weight} Two months of work deserves a proper check-in. Send me your current weight and I will tell you exactly how you are tracking against your ${goalLabel[goal] || goal} goal. One number, right now.`
        );
      } else if (days === 90) {
        await sendWhatsApp(client.phoneNumber,
          `${name}, 90 days — a full quarter. This is the reset point. Send me your weight, and tell me if your goal needs to change. People often start on fat loss and find they want to shift toward building muscle once they have lost the first round. Where are you now?`
        );
      }
    } catch (err) {
      console.error(`[SCHEDULER] Goal reassessment error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 15 — STREAK AT RISK ALERT
// Runs 8pm SAST (6pm UTC) daily — warns if 3+ streak but no log today
// ============================================================

// ============================================================
// STREAK-AT-RISK ALERT — 9pm SAST (7pm UTC)
// Loss aversion: "your streak breaks tonight" is more powerful than
// "log your steps". Fires once per night, one message per client
// (highest-priority streak wins: workout > steps > food).
//
// BUG FIXED: was reading waterStreak instead of actual step streak.
// TIMING FIXED: was 8pm SAST, now 9pm SAST = 1h before midnight.
// ============================================================
cron.schedule("0 19 * * *", async () => {
  console.log("[SCHEDULER] JOB: Streak-at-risk alert (9pm SAST)");
  const clients = await getActiveClients();
  const todayStart = sastDayStart();
  const todayDOW = new Date().getDay(); // 0=Sun

  // Helper: compute consecutive-day streak from a list of loggedAt timestamps
  function computeStreakFromLogs(logs: { loggedAt: Date | null }[]): number {
    const days = new Set<string>();
    for (const l of logs) {
      if (!l.loggedAt) continue;
      const d = new Date(new Date(l.loggedAt).getTime() + 2 * 3_600_000); // SAST
      days.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`);
    }
    let streak = 0;
    const cur = new Date(Date.now() + 2 * 3_600_000); cur.setUTCDate(cur.getUTCDate() - 1); // SAST yesterday
    while (true) {
      const key = `${cur.getUTCFullYear()}-${cur.getUTCMonth()}-${cur.getUTCDate()}`;
      if (!days.has(key)) break;
      streak++;
      cur.setDate(cur.getDate() - 1);
    }
    return streak;
  }

  // Rate cap: never send more than 150 streak alerts per run — prevents
  // a WhatsApp cost bomb if client count scales unexpectedly.
  let streakAlertsSent = 0;
  const STREAK_ALERT_CAP = 150;

  for (const client of clients) {
    if (streakAlertsSent >= STREAK_ALERT_CAP) {
      console.warn(`[SCHEDULER] Streak-at-risk cap (${STREAK_ALERT_CAP}) reached — stopping early`);
      break;
    }
    if (isPaused(client)) continue;
    if (!canSendProactive(client.id)) continue;

    // Skip users who are already disengaged — they need re-engagement, not streak pressure.
    // daysSilent > 2 means they already got a re-engagement message this morning.
    const daysSilent = client.lastActiveAt
      ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
      : 0;
    if (daysSilent > 2) continue;

    try {
      const name = client.name || "there";

      // ── 1. Workout streak at risk ──
      // Only on training days when user hasn't logged a session yet
      const schedule = TRAINING_SCHEDULES[client.trainingDaysPerWeek || 3] || TRAINING_SCHEDULES[3];
      const isTodayTrainingDay = schedule.includes(todayDOW);
      const wStreak = client.workoutStreak || 0;
      if (isTodayTrainingDay && wStreak >= 2) {
        const todayWorkout = await db.select({ id: workoutLogs.id })
          .from(workoutLogs)
          .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, todayStart)))
          .limit(1);
        if (todayWorkout.length === 0) {
          await sendWhatsApp(client.phoneNumber,
            `🔥 ${name}, your *${wStreak}-session workout streak* ends at midnight.\n\nLog your session tonight — even a 15-minute walk counts. Reply *done* when finished.`
          );
          recordProactiveSend(client.id);
          streakAlertsSent++;
          continue; // one message per night
        }
      }

      // ── 2. Step streak at risk ──
      const todaySteps = await db.select({ id: stepLogs.id })
        .from(stepLogs)
        .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, todayStart)))
        .limit(1);
      if (todaySteps.length === 0) {
        const recentSteps = await db.select({ loggedAt: stepLogs.loggedAt })
          .from(stepLogs)
          .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, new Date(Date.now() - 14 * 86400_000))))
          .orderBy(desc(stepLogs.loggedAt));
        const stepStreak = computeStreakFromLogs(recentSteps);
        if (stepStreak >= 2) {
          await sendWhatsApp(client.phoneNumber,
            `🚶 ${name}, your *${stepStreak}-day step streak* ends at midnight.\n\nLog your steps now — even if it's only 3,000. Reply with a number or send a screenshot.`
          );
          recordProactiveSend(client.id);
          streakAlertsSent++;
          continue;
        }
      }

      // ── 3. Food log streak at risk ──
      const todayFood = await db.select({ id: mealLogs.id })
        .from(mealLogs)
        .where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, todayStart)))
        .limit(1);
      if (todayFood.length === 0) {
        // Compute food log streak from mealLogs
        const recentMeals = await db.select({ loggedAt: mealLogs.loggedAt })
          .from(mealLogs)
          .where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, new Date(Date.now() - 14 * 86400_000))))
          .orderBy(desc(mealLogs.loggedAt));
        const foodStreak = computeStreakFromLogs(recentMeals);
        if (foodStreak >= 3) {
          await sendWhatsApp(client.phoneNumber,
            `📋 ${name}, your *${foodStreak}-day food logging streak* ends at midnight.\n\nTell me one thing you ate today — even "pap and chicken" is enough to keep it alive.`
          );
          recordProactiveSend(client.id);
          streakAlertsSent++;
        }
      }
    } catch (err) {
      console.error(`[SCHEDULER] Streak-at-risk error — ${client.phoneNumber}:`, err);
    }
  }
  console.log(`[SCHEDULER] Streak-at-risk: ${streakAlertsSent} alerts sent`);
}, { timezone: "UTC" });

// ============================================================
// JOB 16A — WEEKLY WINS SUMMARY TO CLIENTS
// Runs Sunday 7pm SAST (5pm UTC) — each paying client gets their
// week's highlights so they end the week feeling good and come
// back Monday motivated. This is the client-facing equivalent of
// the coach KPI report (which only goes to the founder).
// ============================================================

// DISABLED — duplicate of Sunday evening check-in (same time, 0 17 * * 0); Sunday check-in has richer data
if (false) (async () => {
  console.log("[SCHEDULER] JOB: Weekly wins summary to clients");
  const clients = await getActiveClients();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  let sent = 0;

  for (const client of clients) {
    if (isPaused(client)) continue;
    if (!canSendProactive(client.id)) continue;
    try {
      const name = client.name?.split(" ")[0] || "there";
      const stepsTarget = client.stepsTarget || 8500;
      const proteinTarget = client.proteinTarget || 120;

      const [workoutRows, stepRows, foodRows] = await Promise.all([
        db.select({ id: workoutLogs.id }).from(workoutLogs)
          .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, sevenDaysAgo))),
        db.select({ steps: stepLogs.steps }).from(stepLogs)
          .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, sevenDaysAgo))),
        db.select({
          totalProt: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
          logDays: sql<number>`COUNT(DISTINCT DATE(${mealLogs.loggedAt}))::int`,
        }).from(mealLogs)
          .where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, sevenDaysAgo))),
      ]);

      const workoutsDone = workoutRows.length;
      const totalSteps = stepRows.reduce((s, r) => s + (r.steps || 0), 0);
      const avgSteps = stepRows.length > 0 ? Math.round(totalSteps / 7) : 0;
      const stepsAboveTarget = stepRows.filter(r => (r.steps || 0) >= stepsTarget).length;
      const totalProtWeek = (foodRows as { totalProt: number; logDays: number }[])[0]?.totalProt || 0;
      const foodLogDays = (foodRows as { totalProt: number; logDays: number }[])[0]?.logDays || 0;
      const targetGoal = client.trainingDaysPerWeek || 3;

      // Build a concise wins summary — only include categories where they did something
      const wins: string[] = [];
      if (workoutsDone > 0) {
        wins.push(`💪 *${workoutsDone}/${targetGoal} sessions* — ${workoutsDone >= targetGoal ? "full week ✅" : `${targetGoal - workoutsDone} short`}`);
      } else {
        wins.push(`💪 *0 sessions logged this week.* Start fresh tomorrow.`);
      }
      if (avgSteps > 0) {
        wins.push(`🚶 *${avgSteps.toLocaleString()} avg daily steps* — ${stepsAboveTarget} days above ${stepsTarget.toLocaleString()} target`);
      }
      if (foodLogDays > 0) {
        const avgProt = Math.round(totalProtWeek / 7);
        wins.push(`🍽 *${foodLogDays}/7 days food logged* — avg ${avgProt}g protein/day${avgProt >= proteinTarget * 0.9 ? " ✅" : ` (target: ${proteinTarget}g)`}`);
      }

      const wStreak = client.workoutStreak || 0;
      if (wStreak >= 3) wins.push(`🔥 *${wStreak}-session streak going into next week*`);

      // Motivational close based on performance
      const close = workoutsDone >= targetGoal
        ? `Perfect week, ${name}. Full sessions logged. That's the standard now.`
        : workoutsDone > 0
          ? `Solid week, ${name}. ${workoutsDone} session${workoutsDone !== 1 ? "s" : ""} done. Next week — go for ${targetGoal}.`
          : `${name}. Nothing logged this week. That stops now. Tomorrow is Day 1.`;

      // Monday teaser: prime them mentally for the week ahead
      const progDays = programmeDaysSince(client.programmeStartDate);
      const weekNum = client.programmeWeek || 1;
      const nextWeekHint = progDays > 0
        ? `\n\n*Week ${weekNum} starts Monday.* Reply *1* when you're ready to train.`
        : `\n\nReply *menu* for Monday's plan.`;

      const msg = `*📊 Your Week in Review*\n\n${wins.join("\n")}\n\n${close}${nextWeekHint}`;
      await sendWhatsApp(client.phoneNumber, msg);
      recordProactiveSend(client.id);
      sent++;
    } catch (err) {
      console.error(`[SCHEDULER] Weekly wins error — ${client.phoneNumber}:`, err);
    }
  }
  console.log(`[SCHEDULER] Weekly wins summary: ${sent} sent`);
})(); // DISABLED

// ============================================================
// JOB 16B — BUDDY ACCOUNTABILITY NOTIFICATIONS
// Runs hourly — checks for buddy workout completions in the last
// hour and sends social proof nudge to their partner. Also flags
// buddies who have gone 48h+ silent (streak-break social pressure).
// Limited to 2 notifications per buddy pair per day via dedupe.
// ============================================================

cron.schedule("0 * * * *", async () => {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
  const eighteenHours = new Date(now.getTime() - 18 * 3_600_000); // don't notify late at night

  // Only run between 7am and 9pm SAST (5am–7pm UTC)
  const hourUTC = now.getUTCHours();
  if (hourUTC < 5 || hourUTC > 19) return;

  try {
    // Find users who have a buddy AND completed a workout in the last hour
    const recentWorkouts = await db.select({
      userId: workoutLogs.userId,
      loggedAt: workoutLogs.loggedAt,
    }).from(workoutLogs)
      .where(gte(workoutLogs.loggedAt, hourAgo))
      .orderBy(desc(workoutLogs.loggedAt));

    const notifiedPairs = new Set<string>();

    for (const w of recentWorkouts) {
      try {
        const [worker] = await db.select({
          id: users.id,
          name: users.name,
          phoneNumber: users.phoneNumber,
          buddyId: users.buddyId,
          workoutStreak: users.workoutStreak,
          subscriptionStatus: users.subscriptionStatus,
        }).from(users).where(eq(users.id, w.userId)).limit(1);

        if (!worker || !worker.buddyId || worker.subscriptionStatus !== "active") continue;

        // Dedupe: only one workout notification per pair per day
        const pairKey = [worker.id, worker.buddyId].sort().join(":");
        if (notifiedPairs.has(pairKey)) continue;
        notifiedPairs.add(pairKey);

        const [buddy] = await db.select({
          name: users.name,
          phoneNumber: users.phoneNumber,
          subscriptionStatus: users.subscriptionStatus,
        }).from(users).where(eq(users.id, worker.buddyId)).limit(1);

        if (!buddy || buddy.subscriptionStatus !== "active") continue;

        const workerFirst = worker.name?.split(" ")[0] || "Your buddy";
        const workerStreak = worker.workoutStreak || 1;
        const streakAdd = workerStreak >= 3 ? ` That's a ${workerStreak}-session streak.` : "";

        // claimProactive with daily dedupe key prevents the same workout notification
        // from firing multiple times within the same day (hourly cron without this
        // would fire repeatedly until the in-memory budget runs out).
        const claimed = await claimProactive(worker.buddyId, `buddy_workout_${worker.id}`, todaySAST());
        if (!claimed) continue;

        await sendWhatsApp(buddy.phoneNumber,
          `🏋️ *${workerFirst} just logged a session.* Don't let them get ahead.${streakAdd}\n\nReply *done* when you finish yours.`
        );
        recordProactiveSend(worker.buddyId);
        console.log(`[BUDDY] Notified ${buddy.name} that ${workerFirst} just trained`);
      } catch { /* skip this pair */ }
    }

    // ── Buddy silence alert: if your buddy has gone 48h+ silent, nudge you ──
    const pairedUsers = await db.select({
      id: users.id,
      name: users.name,
      phoneNumber: users.phoneNumber,
      buddyId: users.buddyId,
      lastActiveAt: users.lastActiveAt,
      subscriptionStatus: users.subscriptionStatus,
    }).from(users)
      .where(and(
        eq(users.subscriptionStatus, "active"),
        sql`${users.buddyId} IS NOT NULL`,
        lt(users.lastActiveAt, twoDaysAgo),
      ))
      .limit(50); // cap

    for (const silentBuddy of pairedUsers) {
      try {
        if (!silentBuddy.buddyId) continue;
        const [partner] = await db.select({
          id: users.id,
          name: users.name,
          phoneNumber: users.phoneNumber,
          subscriptionStatus: users.subscriptionStatus,
        }).from(users).where(eq(users.id, silentBuddy.buddyId)).limit(1);

        if (!partner || partner.subscriptionStatus !== "active") continue;

        const silentFirst = silentBuddy.name?.split(" ")[0] || "Your buddy";
        const daysSilent = silentBuddy.lastActiveAt
          ? Math.floor((Date.now() - new Date(silentBuddy.lastActiveAt).getTime()) / 86_400_000)
          : 2;

        // Daily dedupe: one buddy-silence notification per silent buddy per day
        const claimed = await claimProactive(partner.id, `buddy_silence_${silentBuddy.id}`, todaySAST());
        if (!claimed) continue;

        await sendWhatsApp(partner.phoneNumber,
          `👀 *${silentFirst} hasn't logged in ${daysSilent} days.*\n\nYou're pulling ahead — but having an active buddy keeps you both sharper. If you know them, give them a nudge.`
        );
        recordProactiveSend(partner.id);
        console.log(`[BUDDY] Nudged ${partner.name} about silent buddy ${silentFirst}`);
      } catch { /* skip */ }
    }
  } catch (err) {
    console.error("[SCHEDULER] Buddy accountability error:", err);
  }
});

// ============================================================
// JOB 16 — WOMEN'S MONTH (August — every Monday)
// Runs Monday 7am SAST (5am UTC), August only
// ============================================================

cron.schedule("0 5 * 8 1", async () => {
  console.log("[SCHEDULER] JOB: Women's Month Monday message");
  const clients = await getActiveClients();

  // Target female-presenting clients: glutes/legs focus or female name heuristics
  const femaleIndicators = (client: any): boolean => {
    return client.primaryFocusArea === "glutes_legs" ||
      ["she", "her", "woman", "female"].some(w => (client.profileNotes || "").toLowerCase().includes(w));
  };

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      const workouts = client.totalWorkoutsCompleted || 0;
      const isFemale = femaleIndicators(client);

      if (isFemale) {
        await sendWhatsApp(client.phoneNumber,
          `${name}, Women's Month. The strength you are building is not just physical — it is the discipline that carries into every part of your life. ${workouts > 0 ? `${workouts} sessions completed and counting.` : "Your programme is ready."} Train today — for you, no one else.`
        );
      } else {
        // General empowerment for all clients in August
        await sendWhatsApp(client.phoneNumber,
          `${name}, August — Women's Month in SA. The women in your life are watching what you build. Be the example. Train this week, eat well, stay consistent. That is the best thing you can do.`
        );
      }
    } catch (err) {
      console.error(`[SCHEDULER] Women's Month error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 17 — PHASE ADVANCEMENT CHECK
// Runs every Monday at 7am SAST (5am UTC)
// Auto-advances phase when client completes 4 weeks with 75%+ compliance
// ============================================================

cron.schedule("0 5 * * 1", async () => {
  console.log("[SCHEDULER] JOB: Phase advancement check");
  const clients = await getActiveClients();
  const fourWeeksAgo = new Date(Date.now() - 28 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      if ((client.programmeWeek || 1) < 4) continue; // Not yet at 4 weeks
      if (client.phaseReadyToAdvance) continue; // Already flagged

      const plannedSessions = (client.trainingDaysPerWeek || 3) * 4; // 4 weeks worth
      const completedSessions = await db.select().from(workoutLogs)
        .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, fourWeeksAgo)));

      const compliance = completedSessions.length / plannedSessions;
      if (compliance < 0.75) continue; // Below 75% — not ready

      const currentPhase = client.programmePhase || 1;
      if (currentPhase >= 5) continue; // Already at max phase

      const newPhase = currentPhase + 1;
      const phaseNames: Record<number, string> = { 1: "Foundation", 2: "Build", 3: "Push", 4: "Peak", 5: "Deload" };

      await db.update(users)
        .set({ programmePhase: newPhase, programmeWeek: 1, programmeDayInWeek: 1, phaseReadyToAdvance: false })
        .where(eq(users.id, client.id));

      const name = client.name || "there";
      await sendWhatsApp(client.phoneNumber,
        `${name}, you have completed Phase ${currentPhase} (${phaseNames[currentPhase]}). ${completedSessions.length} of ${plannedSessions} planned sessions done — ${Math.round(compliance * 100)}% compliance. You have earned Phase ${newPhase}: ${phaseNames[newPhase]}. Your programme has been updated. Reply "today" for your first Phase ${newPhase} session.`
      );
    } catch (err) {
      console.error(`[SCHEDULER] Phase advancement error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 18a — GOAL CHECK / PROGRAMME REVIEW
// Runs every Monday at 9am SAST (7am UTC)
// Fires at programme weeks 4, 8, 12 if not yet done that week
// ============================================================

cron.schedule("0 7 * * 1", async () => {
  console.log("[SCHEDULER] JOB: Goal check / programme review");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const currentWeek = client.programmeWeek || 1;
      const lastCheck = client.lastGoalCheckWeek || 0;
      const checkWeeks = [4, 8, 12, 16, 20, 24];
      const shouldCheck = checkWeeks.includes(currentWeek) && lastCheck < currentWeek;
      if (!shouldCheck) continue;

      const name = client.name || "there";
      const total = client.totalWorkoutsCompleted || 0;
      const goal = client.goalType || "fat_loss";
      const goalLabel: Record<string, string> = {
        fat_loss: "fat loss",
        muscle_gain: "muscle gain",
        recomposition: "body recomposition",
        general: "general fitness",
      };

      let goalMsg = "";
      if (currentWeek === 4) {
        goalMsg = `${name}, you have completed Week 4 — ${total} sessions done. Time for a quick check-in.\n\nThree questions:\n1. Is your goal still *${goalLabel[goal] || goal}*?\n2. Has anything changed — injury, schedule, budget, life?\n3. How is your energy this week compared to Week 1?\n\nReply to any of these and I will adjust your programme if needed.`;
      } else if (currentWeek === 8) {
        goalMsg = `${name}, 8 weeks in. ${total} sessions. This is the point where real results start showing up — and where a lot of people shift their goal.\n\n*Is your current goal still right?* ${goalLabel[goal] || goal}.\n\nIf the goal has changed, or if something in your life has changed, tell me now. Your programme adjusts to your reality — not the other way around.`;
      } else if (currentWeek === 12) {
        goalMsg = `${name}, 12 weeks with Coach K. ${total} sessions. One quarter of a year of work.\n\nTime for a full review. Tell me:\n1. What is working?\n2. What is not?\n3. What has changed in your body or your life?\n\nYour programme evolves with you. Let me know what to adjust.`;
      } else {
        goalMsg = `${name}, Week ${currentWeek} checkpoint — ${total} sessions done. Is your goal still *${goalLabel[goal] || goal}*? Anything in your life or training that needs to change? Reply and we adjust.`;
      }

      await sendWhatsApp(client.phoneNumber, goalMsg);
      // Mark this check as done so it does not repeat this week
      await db.update(users).set({ lastGoalCheckWeek: currentWeek }).where(eq(users.phoneNumber, client.phoneNumber));
    } catch (err) {
      console.error(`[SCHEDULER] Goal check error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 18b — WEEKLY MONDAY PROGRAMME CHECK-IN
// Runs every Monday at 8am SAST (6am UTC)
// Sends a week-specific message to ALL active clients
// (different from 18a which only fires at milestone weeks)
// ============================================================

cron.schedule("0 6 * * 1", async () => {
  console.log("[SCHEDULER] JOB: Weekly Monday check-in");
  const clients = await getActiveClients();
  const thisWeek = thisWeekUTC();

  for (const client of clients) {
    if (isPaused(client)) continue;
    // Skip clients not active in last 5 days — already handled by morning check-in
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);
    if (client.lastActiveAt && new Date(client.lastActiveAt) < fiveDaysAgo) continue;
    try {
      const stateKey = `weekly_checkin_${client.id}`;
      const state = loadState();
      if (state[stateKey] === thisWeek) continue; // Already sent this week

      const name = client.name || "there";
      const week = client.programmeWeek || 1;
      const sessions = client.totalWorkoutsCompleted || 0;
      const planned = client.trainingDaysPerWeek || 3;
      const goal = client.goalType || "fat_loss";
      const streak = client.workoutStreak || 0;

      let msg = "";

      if (week === 1) {
        msg = `${name}, Week 1. This week is about building the habit, not the body — the physical changes come later.\n\nExpect: some soreness, hunger changes, maybe lower energy by day 3. All normal. Your only job this week: complete ${planned} sessions and log every meal. Nothing else.\n\nSend me your first meal of the day.`;
      } else if (week === 2) {
        msg = `${name}, Week 2. The soreness from last week means your muscles responded. ${sessions} sessions banked.\n\nExpect: energy starts stabilising. Scale might go up slightly (water and glycogen) — ignore it, it normalises by week 3. Focus: hit your step target of ${(client.stepsTarget || 8500).toLocaleString()} every day this week.`;
      } else if (week === 3) {
        msg = `${name}, Week 3 — this is the hardest week. Not because it got heavier, but because the mirror has not changed yet and motivation is low.\n\nThis is normal. The physical changes are happening inside — metabolism adapting, muscle fibres rebuilding. Visible results show at week 4–6 for most people. You are 7 days away from seeing the shift.\n\nComplete ${planned} sessions. That is all.`;
      } else if (week === 4) {
        msg = `${name}, Week 4 — one full month in. ${sessions} sessions. This is where it starts to show.\n\nExpect: clothes fitting slightly differently, energy more consistent, strength up on at least one exercise. If you have been logging food, your calorie awareness is now automatic. This week: push harder — more reps or more weight on every exercise. You built the foundation. Now use it.`;
      } else if (week <= 8) {
        const sessionGoal = sessions + planned;
        msg = `${name}, Week ${week} — ${sessions} sessions in the bank. Target for this week: ${planned} sessions and ${sessionGoal} total. ${streak >= 3 ? `You are on a ${streak}-session streak — do not break it.` : "Get the streak going."}`;
      } else if (week <= 12) {
        const goalMsg = goal === "fat_loss" ? "Fat loss compounds from here — the early weeks built the foundation."
          : goal === "muscle_gain" ? "Muscle building accelerates after week 8 — progressive overload is everything now."
          : "Your body is recomposing — fat down, muscle up. The scale may not move much but the mirror will.";
        msg = `${name}, Week ${week} — ${sessions} total sessions. ${goalMsg} One focus this week: log your lifts and add weight or reps to every exercise.`;
      } else {
        msg = `${name}, Week ${week} — ${sessions} sessions. You are in the top 5% of people who stick with a programme this long. What is your goal for this week? One specific thing.`;
      }

      if (canSendProactive(client.id)) {
        await sendWhatsApp(client.phoneNumber, msg);
        saveState(stateKey, thisWeek);
        recordProactiveSend(client.id);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Weekly check-in error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 18 — INJURY FOLLOW-UP
// Runs every Wednesday at 10am SAST (8am UTC)
// ============================================================

cron.schedule("0 8 * * 3", async () => {
  console.log("[SCHEDULER] JOB: Injury follow-up");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      if (!client.injuries || client.injuries === "" || client.injuries === "none") continue;

      const name = client.name || "there";
      const injuryNote = client.injuries.slice(0, 60);

      await sendWhatsApp(client.phoneNumber,
        `${name}, quick check — how is the ${injuryNote} doing? If it has improved, reply "injury better" and I will update your programme. If it is still affecting you, tell me what you can and cannot do and I will adjust.`
      );
    } catch (err) {
      console.error(`[SCHEDULER] Injury follow-up error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 19 — NEW YEAR RESET (January 2nd)
// Fires once on January 2nd at 7am SAST (5am UTC)
// ============================================================

cron.schedule("0 5 2 1 *", async () => {
  console.log("[SCHEDULER] JOB: New Year reset");
  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      const workouts = client.totalWorkoutsCompleted || 0;
      const days = programmeDaysSince(client.programmeStartDate);

      await sendWhatsApp(client.phoneNumber,
        `${name}, January 2nd. The gym is full of people who will be gone by February. You have ${workouts > 0 ? `${workouts} sessions and ${days} days` : "your programme"} already built. You are not starting. You are continuing. That is the difference. Log your first food of 2025 today.`
      );
    } catch (err) {
      console.error(`[SCHEDULER] New Year reset error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 20 — PLATEAU DETECTION
// Runs Sunday 7am UTC (9am SAST)
// Fires if weight unchanged >0.5kg in 21 days + client is active
// ============================================================

cron.schedule("0 7 * * 0", async () => {
  console.log("[SCHEDULER] JOB: Plateau detection");
  const clients = await getActiveClients();
  const twentyOneDaysAgo = new Date(Date.now() - 21 * 86_400_000);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      // Only fire for fat loss clients who have been active recently
      if (client.goalType !== "fat_loss" && client.goalType !== "recomposition") continue;

      // Check recent activity
      const recentActivity = await db.select({ id: chatHistory.id })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, client.id), gte(chatHistory.createdAt, fourteenDaysAgo)))
        .limit(1);
      if (recentActivity.length === 0) continue; // Not active, skip

      // Get weight logs from last 21 days
      const recentWeights = await db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt })
        .from(weightLogs)
        .where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, twentyOneDaysAgo)))
        .orderBy(asc(weightLogs.loggedAt));

      if (recentWeights.length < 2) continue; // Not enough data

      const oldest = parseFloat(String(recentWeights[0].weight));
      const newest = parseFloat(String(recentWeights[recentWeights.length - 1].weight));
      const change = Math.abs(newest - oldest);

      if (change > 0.5) continue; // Weight IS moving — no plateau

      // Plateau confirmed — send protocol
      const plateauMsg = `${name}, your weight has been stable for 3 weeks. This is a plateau and it is normal — your body adapts. Here is the fix: this week, cut your carb portions by one third. Keep protein the same. Add a 20-minute walk on top of your normal routine. Weigh in again in 7 days. Plateaus break when you change one variable at a time.`;
      await sendWhatsApp(client.phoneNumber, plateauMsg);
      saveState(`plateau_sent_${client.id}`, todayUTC());
    } catch (err) {
      console.error(`[SCHEDULER] Plateau detection error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// JOB 21 — REMOVED: Was a duplicate of the pre-training nutrition reminder at line ~827

// ============================================================
// JOB — SUBSCRIPTION EXPIRY CHECK
// Runs daily at 8am UTC (10am SAST)
// Warns 3 days before expiry, deactivates on expiry
// ============================================================

cron.schedule("5 8 * * *", async () => {
  console.log("[SCHEDULER] JOB: Subscription expiry check");
  const clients = await getActiveClients();
  const now = Date.now();
  const threeDaysMs = 3 * 86_400_000;

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const renewsAt = (client as any).subscriptionRenewsAt;
      if (!renewsAt) continue; // No renewal date = trial or manual management
      const renewsMs = new Date(renewsAt).getTime();
      const msUntilRenewal = renewsMs - now;
      const name = client.name || "there";

      // 3-day warning
      if (msUntilRenewal > 0 && msUntilRenewal <= threeDaysMs) {
        const daysLeft = Math.ceil(msUntilRenewal / 86_400_000);
        await sendWhatsApp(client.phoneNumber,
          `${name}, your KamLife Coach subscription renews in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}. If your payment details have changed, update them at kamlifecoach.co.za before then. Nothing changes if everything is fine — coaching continues automatically.`
        );
      }

      // Expired — deactivate
      if (msUntilRenewal < 0 && client.subscriptionStatus === "active") {
        await db.update(users)
          .set({ subscriptionStatus: "inactive" })
          .where(eq(users.phoneNumber, client.phoneNumber));
        await sendWhatsApp(client.phoneNumber,
          `${name}, your subscription has expired. Your profile and progress history are saved. To continue with Coach K, renew at kamlifecoach.co.za or reply *pay* for a payment link.`
        );
        console.log(`[SCHEDULER] Subscription expired — ${client.phoneNumber}`);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Subscription expiry error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB — PAYMENT FAILURE RECOVERY SEQUENCE
// Runs daily 10am UTC (12pm SAST)
// Day 1: Gentle reminder. Day 3: Urgency. Day 7: Final attempt with data.
// ============================================================

cron.schedule("0 10 * * *", async () => {
  console.log("[SCHEDULER] JOB: Payment failure recovery");
  const allUsers = await db.select().from(users);
  const failedUsers = allUsers.filter(u =>
    u.subscriptionStatus === "inactive" &&
    u.cancelledAt &&
    u.onboardingState === "COMPLETE" &&
    u.totalWorkoutsCompleted && u.totalWorkoutsCompleted > 0
  );

  const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
  const merchantId = process.env.PAYFAST_MERCHANT_ID;

  for (const client of failedUsers) {
    try {
      const name = client.name || "there";
      const daysSinceFail = Math.floor((Date.now() - new Date(client.cancelledAt!).getTime()) / 86_400_000);
      const workouts = client.totalWorkoutsCompleted || 0;
      const cleanPhone = client.phoneNumber.replace(/^whatsapp:/, "").replace(/\D/g, "");
      const payLink = merchantId ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}` : appUrl;

      if (daysSinceFail === 1) {
        // Day 1 — soft, assume payment glitch
        await sendWhatsApp(client.phoneNumber,
          `${name}, your payment didn't go through yesterday. Could be a bank issue — happens all the time.\n\nYour programme and ${workouts} sessions of progress are saved. Update your payment here and coaching continues immediately:\n${payLink}`
        );
      } else if (daysSinceFail === 3) {
        // Day 3 — create urgency with personal data
        const weekNum = client.programmeWeek || 1;
        await sendWhatsApp(client.phoneNumber,
          `${name} — 3 days without coaching. You are in Week ${weekNum} with ${workouts} sessions done.\n\nClients who take more than a week off lose momentum and rarely come back at the same level. Your streak, your targets, your programme — all still here.\n\nFix your payment in 30 seconds:\n${payLink}`
        );
      } else if (daysSinceFail === 7) {
        // Day 7 — final attempt, acknowledge the situation honestly
        await sendWhatsApp(client.phoneNumber,
          `${name}, last message about this — your subscription has been paused for a week.\n\n${workouts} sessions. Every meal logged. Every step counted. That work is not lost.\n\nIf money is tight right now, I get it — reply *pay* when you are ready and I will send a fresh link. No pressure, no expiry on your data.\n\nIf you want to stop completely, reply *STOP* and I won't message again.`
        );
      }
    } catch (err) {
      console.error(`[SCHEDULER] Payment recovery error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB — SUNDAY WEEKDAY vs WEEKEND FOOD PATTERN AUDIT
// Runs Sunday 8am UTC (10am SAST) — after the weekly report
// Analyses whether weekend eating is sabotaging the week
// ============================================================

cron.schedule("0 8 * * 0", async () => {
  console.log("[SCHEDULER] JOB: Weekend food pattern audit");
  const clients = await getActiveClients();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const foodLogs = await db.select({ messageIn: chatHistory.messageIn, createdAt: chatHistory.createdAt })
        .from(chatHistory)
        .where(and(
          eq(chatHistory.userId, client.id),
          eq(chatHistory.intent, "FOOD_LOG"),
          gte(chatHistory.createdAt, sevenDaysAgo),
        ))
        .orderBy(asc(chatHistory.createdAt));

      if (foodLogs.length < 5) continue; // Not enough data

      // Classify each log day as weekday (Mon-Fri) or weekend (Sat-Sun)
      const weekdayLogs: typeof foodLogs = [];
      const weekendLogs: typeof foodLogs = [];
      for (const log of foodLogs) {
        const dow = new Date(log.createdAt!).getDay(); // 0=Sun, 6=Sat
        if (dow === 0 || dow === 6) weekendLogs.push(log);
        else weekdayLogs.push(log);
      }

      if (weekendLogs.length === 0 || weekdayLogs.length === 0) continue;

      // Simple heuristic: count high-calorie keywords in each group
      const HIGH_CAL = ["kfc", "mcdonalds", "nandos", "pizza", "kotas", "vetkoek", "beer", "wine", "braai", "chips", "cake", "chocolate", "dessert", "ice cream", "takeaway", "takeaways", "cool drink", "coke", "fanta", "sprite", "braai", "pap en vleis"];
      const GOOD_PROTEIN = ["chicken breast", "pilchards", "eggs", "tuna", "beef mince", "greek yogurt", "cottage cheese"];

      const weekdayJunk = weekdayLogs.filter(l => HIGH_CAL.some(k => (l.messageIn || "").toLowerCase().includes(k))).length;
      const weekendJunk = weekendLogs.filter(l => HIGH_CAL.some(k => (l.messageIn || "").toLowerCase().includes(k))).length;
      const weekdayProtein = weekdayLogs.filter(l => GOOD_PROTEIN.some(k => (l.messageIn || "").toLowerCase().includes(k))).length;
      const weekendProtein = weekendLogs.filter(l => GOOD_PROTEIN.some(k => (l.messageIn || "").toLowerCase().includes(k))).length;

      const weekdayJunkRate = weekdayLogs.length > 0 ? weekdayJunk / weekdayLogs.length : 0;
      const weekendJunkRate = weekendLogs.length > 0 ? weekendJunk / weekendLogs.length : 0;
      const weekdayProteinRate = weekdayLogs.length > 0 ? weekdayProtein / weekdayLogs.length : 0;
      const weekendProteinRate = weekendLogs.length > 0 ? weekendProtein / weekendLogs.length : 0;

      const name = client.name || "there";

      // Only message if there's a meaningful pattern to report
      if (weekendJunkRate > weekdayJunkRate + 0.3) {
        // Weekends are significantly worse
        await sendWhatsApp(client.phoneNumber,
          `${name} — pattern spotted. Your weekday eating is solid. But ${weekendJunk > 0 ? `${weekendJunk} weekend meal${weekendJunk !== 1 ? "s" : ""}` : "your weekends"} this week had foods that are undoing the weekday work. Braais, takeaways, and cool drinks on weekends are the most common reason fat loss stalls. One rule for weekends: protein first at every meal, then eat what you want after. That single rule changes everything.`
        );
      } else if (weekendProteinRate < weekdayProteinRate - 0.3) {
        // Good weekdays, low protein on weekends
        await sendWhatsApp(client.phoneNumber,
          `${name} — you are hitting protein well during the week. But weekends your protein drops. When you are out, at a braai, or grabbing food on the go — always anchor the meal with protein first. Eggs in the morning. Chicken or meat at the braai before the pap and dessert. That keeps the week's work intact.`
        );
      }
      // If patterns are similar, no message — don't add noise
    } catch (err) {
      console.error(`[SCHEDULER] Weekend food audit error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB — SUNDAY COMPLIANCE LEVEL UPDATE
// Runs Sunday 7am UTC (9am SAST) — calculates weekly score and
// updates complianceLevel: RESET | BUILDING | CONSISTENT | LOCKED IN
// ============================================================

cron.schedule("10 7 * * 0", async () => {
  console.log("[SCHEDULER] JOB: Weekly compliance level update");
  const clients = await getActiveClients();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const plannedSessions = client.trainingDaysPerWeek || 3;

      // Count workouts this week and last week
      const [thisWeekWorkouts, lastWeekWorkouts] = await Promise.all([
        db.select({ id: workoutLogs.id }).from(workoutLogs)
          .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, sevenDaysAgo))),
        db.select({ id: workoutLogs.id }).from(workoutLogs)
          .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, fourteenDaysAgo), lt(workoutLogs.loggedAt, sevenDaysAgo))),
      ]);

      const thisWeekCount = thisWeekWorkouts.length;
      const lastWeekCount = lastWeekWorkouts.length;

      // Score: sessions completed vs planned (0-100)
      const weeklyScore = Math.min(100, Math.round((thisWeekCount / plannedSessions) * 100));

      // Compliance level logic
      let complianceLevel: string;
      if (thisWeekCount === 0) {
        complianceLevel = "RESET";
      } else if (thisWeekCount < Math.ceil(plannedSessions * 0.5)) {
        complianceLevel = "BUILDING";
      } else if (thisWeekCount >= plannedSessions && lastWeekCount >= plannedSessions) {
        // Hit target both this week AND last week → LOCKED IN
        complianceLevel = "LOCKED IN";
      } else if (thisWeekCount >= Math.ceil(plannedSessions * 0.75)) {
        complianceLevel = "CONSISTENT";
      } else {
        complianceLevel = "BUILDING";
      }

      await db.update(users).set({ weeklyScore, complianceLevel }).where(eq(users.id, client.id));
    } catch (err) {
      console.error(`[SCHEDULER] Compliance update error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB — NEW SIGNUP NUDGE + LAPSED SUBSCRIBER WIN-BACK
// Runs daily 9am UTC (11am SAST)
// New signups (inactive, 0 workouts): Day 1 and Day 3 nudges
// Lapsed paying clients (cancelled): Day 3, Day 7, Day 30 win-back
// ============================================================

cron.schedule("3 9 * * *", async () => {
  console.log("[SCHEDULER] JOB: Signup nudge + lapsed win-back");
  const inactiveClients = await db.select().from(users)
    .where(eq(users.subscriptionStatus, "inactive"));

  const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
  const merchantId = process.env.PAYFAST_MERCHANT_ID;

  for (const client of inactiveClients) {
    try {
      const name = client.name || "there";
      const cleanPhone = client.phoneNumber.replace(/^whatsapp:/, "").replace(/\D/g, "");
      const payLink = merchantId ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}` : appUrl;

      const isNewSignup = !client.totalWorkoutsCompleted && !client.lastWorkoutDate;
      const created = client.createdAt ? new Date(client.createdAt) : null;
      const cancelled = client.cancelledAt ? new Date(client.cancelledAt) : null;

      if (isNewSignup && created) {
        // Trial user approaching trial end — nudge on day 5 and day 7
        const daysSince = Math.floor((Date.now() - created.getTime()) / 86_400_000);
        const workouts = client.totalWorkoutsCompleted || 0;
        if (daysSince === 5 && client.subscriptionStatus === "trial") {
          await sendWhatsApp(client.phoneNumber,
            `${name}, 2 days left on your free trial.${workouts > 0 ? ` You've done ${workouts} session${workouts > 1 ? "s" : ""} — that's real progress.` : ""}\n\nKeep everything — workouts, food coaching, daily accountability.\n\n*R149/month — cancel anytime:*\n${payLink}\n\nR5/day. Less than a KFC streetwise.`
          );
        } else if (daysSince === 7 && client.subscriptionStatus === "trial") {
          await sendWhatsApp(client.phoneNumber,
            `${name} — last day of your trial. Tomorrow coaching stops unless you subscribe.\n\nYour programme, targets, and progress are saved. Pay now and nothing changes — Day ${(client.programmeDayInWeek || 1) + 1} drops tomorrow morning.\n\n*R149/month:*\n${payLink}`
          );
        }

      } else if (!isNewSignup && cancelled) {
        // Lapsed paying subscriber — they paid before, now inactive
        const daysSinceCancelled = Math.floor((Date.now() - cancelled.getTime()) / 86_400_000);
        const workouts = client.totalWorkoutsCompleted || 0;

        if (daysSinceCancelled === 3) {
          await sendWhatsApp(client.phoneNumber,
            `${name} — you've done ${workouts} sessions with Coach K. That doesn't disappear.\n\nYour programme, weight history, and streaks are all saved. Pick up exactly where you left off.\n\n*Reactivate for R149/month:*\n${payLink}`
          );
        } else if (daysSinceCancelled === 7) {
          await sendWhatsApp(client.phoneNumber,
            `${name}, a week since you left.\n\nThe people who come back after a week are the ones who actually get results — they know what consistency feels like now.\n\nR149/month. Your data is here:\n${payLink}`
          );
        } else if (daysSinceCancelled === 30) {
          await sendWhatsApp(client.phoneNumber,
            `${name} — 30 days. Coach K here.\n\nOne message to say your profile is still here if you want it. ${workouts} sessions logged. Progress saved.\n\nR149/month if you're ready:\n${payLink}\n\nIf not — no hard feelings. Reply STOP and I won't message again.`
          );
        }
      }
    } catch (err) {
      console.error(`[SCHEDULER] Signup/win-back error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB — WEEKLY NSV CHECK-IN
// Runs Saturday 8am UTC (10am SAST)
// Prompts non-scale victory reflection — keeps engagement when
// the scale isn't moving (most common reason people quit)
// ============================================================

cron.schedule("0 8 * * 6", async () => {
  console.log("[SCHEDULER] JOB: Weekly NSV check-in");
  const clients = await getActiveClients();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      // Only send to clients who have been active this week
      const recentActivity = await db.select({ id: chatHistory.id })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, client.id), gte(chatHistory.createdAt, sevenDaysAgo)))
        .limit(1);
      if (recentActivity.length === 0) continue;

      // Skip if already sent this week (state guard)
      const stateKey = `nsv_sent_${client.id}_${thisWeekUTC()}`;
      const state = loadState();
      if (state[stateKey]) continue;

      const name = client.name || "there";
      const week = client.programmeWeek || 1;

      const nsvPrompts = [
        `${name} — quick check-in beyond the scale.\n\nHow do your clothes feel this week? Tighter? Looser? Same?\n\nNon-scale wins are often the first signs things are working — before the scale catches up. Tell me one thing that felt different this week, even something small.`,
        `${name} — end of week check-in.\n\nForget the scale for a second. Three questions:\n1. Energy levels this week vs last week?\n2. Did anything feel easier — stairs, walking, lifting?\n3. Sleep any better?\n\nThese are the real signals. Tell me one.`,
        `${name}, Week ${week} done.\n\nI track more than your weight. Tell me: any moment this week where you felt stronger, had more energy, or made a better food choice than you would have 3 months ago?\n\nThat is your real progress.`,
        `${name} — Saturday check-in.\n\nOne question: what is something your body can do now that it could not do when you started?\n\nCould be physical — run further, lift more, climb stairs without breathing hard. Could be habits — less cravings, better sleep, not reaching for junk automatically.\n\nTell me one win.`,
      ];

      const promptIndex = (week - 1) % nsvPrompts.length;
      await sendWhatsApp(client.phoneNumber, nsvPrompts[promptIndex]);
      saveState(stateKey, todayUTC());
    } catch (err) {
      console.error(`[SCHEDULER] NSV check-in error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// INIT EXPORT
// ============================================================

let schedulerInitialised = false;

export async function initScheduler(): Promise<void> {
  if (schedulerInitialised) {
    console.log("[SCHEDULER] Already initialised — skipping duplicate registration");
    return;
  }

  // PostgreSQL session-level advisory lock — only one replica runs the scheduler.
  // Lock is released automatically when the DB connection closes (on server shutdown).
  // Lock ID 8675309 is an arbitrary stable integer unique to this scheduler.
  try {
    const { rows } = await pool.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock(8675309)"
    );
    if (!rows[0].pg_try_advisory_lock) {
      console.log("[SCHEDULER] Another instance holds the leader lock — cron jobs skipped on this replica");
      return;
    }
    console.log("[SCHEDULER] Acquired leader lock — this replica will run all cron jobs");
  } catch (e) {
    console.warn("[SCHEDULER] Could not acquire advisory lock — starting scheduler anyway:", e);
  }

  schedulerInitialised = true;

  // Catch-up removed: Railway filesystem is ephemeral — state file lost on every deploy
  // caused double morning messages. Cron handles scheduling reliably without catch-up.

  console.log("[SCHEDULER] Proactive coaching jobs active:");
  console.log("[SCHEDULER]   Morning check-in    — daily 6am SAST");
  console.log("[SCHEDULER]   Evening accountability — daily 7pm SAST");
  console.log("[SCHEDULER]   Week 3 intervention — Monday 6am SAST");
  console.log("[SCHEDULER]   Month-end budget     — 20th each month (budget-tier aware)");
  console.log("[SCHEDULER]   Milestone check      — daily 8am SAST");
  console.log("[SCHEDULER]   Silence detection    — every 12 hours");
  console.log("[SCHEDULER]   Friday strategy      — Friday 4pm SAST");
  console.log("[SCHEDULER]   Sunday weekly report — Sunday 8am SAST");
  console.log("[SCHEDULER]   Days 1-3 onboarding  — daily 10am SAST");
  console.log("[SCHEDULER]   Monthly measurements  — 1st of each month 9am SAST");
  console.log("[SCHEDULER]   SA cultural calendar  — Heritage Day, Women's Day, New Year, etc.");
  console.log("[SCHEDULER]   14/30-day silence    — escalating re-engagement");
  console.log("[SCHEDULER]   Referral nudge        — day 7/30/60/90 milestones");
  console.log("[SCHEDULER]   Goal reassessment     — day 30/60/90 weight + goal check");
  console.log("[SCHEDULER]   Streak-at-risk        — 8pm alert if streak endangered");
  console.log("[SCHEDULER]   Women's Month         — August Mondays");
  console.log("[SCHEDULER]   Phase advancement     — auto-advance on 75% compliance");
  console.log("[SCHEDULER]   Goal check / review   — Monday 7am UTC at weeks 4/8/12/16/20/24");
  console.log("[SCHEDULER]   Injury follow-up      — Wednesday check on injured clients");
  console.log("[SCHEDULER]   New Year reset        — January 2nd continuation message");
  console.log("[SCHEDULER]   Plateau detection        — Sunday 9am SAST (3-week stall → protocol)");
  console.log("[SCHEDULER]   Pre-training nutrition   — daily 12pm SAST (workout day reminder)");
  console.log("[SCHEDULER]   Ramadan mode         — activates only on explicit client mention");
  console.log("[SCHEDULER]   Weekly KPI report       — Monday 7am SAST to coach WhatsApp");
  console.log("[SCHEDULER]   Step leaderboard        — Sunday 5pm SAST broadcast");
  console.log("[SCHEDULER]   Payday shopping nudge   — 15th + 25th of each month");
  console.log("[SCHEDULER]   Supplement reminder       — daily 8am SAST (logged users)");
  console.log("[SCHEDULER]   Auto calorie adjustment   — Sunday 10am SAST (3-week plateau)");
  console.log("[SCHEDULER]   Monthly NPS survey        — 1st of each month 10am SAST");

  // ============================================================
  // PAYDAY SHOPPING NUDGE — 15th + 25th at 9am SAST (7am UTC)
  // Most SA workers get paid on the 15th or 25th
  // ============================================================
  cron.schedule("0 7 15,25 * *", async () => {
    console.log("[SCHEDULER] JOB: Payday shopping nudge");
    const clients = await getActiveClients();
    for (const client of clients) {
      if (isPaused(client)) continue;
      try {
        const name = client.name || "there";
        const budget = client.weeklyFoodBudget || "100_300";
        let msg = "";
        if (budget === "under_100" || budget === "50_100" || budget === "under_50") {
          msg = `${name}, if today is payday — buy your protein FIRST before anything else.\n\n*Priority list:*\n1. Eggs 12 pack — R45\n2. Pilchards 3 tins — R36\n3. Sugar beans 500g — R20\n\nThat is R101 and covers your protein for the week. Everything else is secondary. Reply *shopping list* for the full plan.`;
        } else if (budget === "100_300") {
          msg = `${name}, payday reminder — stock up on your week's food today before the money goes.\n\n*Top priority:*\n1. Frozen chicken 1kg — R40\n2. Eggs 12 pack — R45\n3. Oats 500g — R15\n4. Sweet potato 1kg — R12\n\nReply *shopping list* for the complete list. Reply *meal prep* for a batch cooking plan.`;
        } else {
          msg = `${name}, start of the pay cycle — perfect time to stock your kitchen.\n\nBuy protein in bulk today: chicken breast, eggs, mince. Freeze what you won't use this week.\n\nReply *shopping list* for your personalised list or *meal prep* for a batch cooking plan.`;
        }
        if (canSendProactive(client.id)) {
          await sendWhatsApp(client.phoneNumber, msg);
          recordProactiveSend(client.id);
        }
      } catch (err) {
        console.error(`[SCHEDULER] Payday nudge error — ${client.phoneNumber}:`, err);
      }
    }
  }, { timezone: "UTC" });

  // ============================================================
  // WEEKLY STEP LEADERBOARD BROADCAST — Sunday 3pm UTC (5pm SAST)
  // Sends top 5 + personal rank to all active clients with step logs
  // ============================================================
  cron.schedule("0 15 * * 0", async () => {
    console.log("[SCHEDULER] JOB: Weekly step leaderboard broadcast");
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      const allStepLogs = await db.select({ userId: stepLogs.userId, steps: stepLogs.steps })
        .from(stepLogs).where(gte(stepLogs.loggedAt, sevenDaysAgo));

      const userSteps: Record<string, { total: number; days: number }> = {};
      for (const log of allStepLogs) {
        if (!userSteps[log.userId]) userSteps[log.userId] = { total: 0, days: 0 };
        userSteps[log.userId].total += log.steps;
        userSteps[log.userId].days++;
      }

      const participantIds = Object.keys(userSteps);
      if (participantIds.length < 3) return; // Need at least 3 to make it competitive

      const participants = await db.select({ id: users.id, name: users.name, phoneNumber: users.phoneNumber, subscriptionStatus: users.subscriptionStatus })
        .from(users).where(sql`${users.id} = ANY(${participantIds})`);
      const infoMap: Record<string, { name: string; phone: string; active: boolean }> = {};
      for (const p of participants) infoMap[p.id] = { name: p.name || "Anonymous", phone: p.phoneNumber, active: p.subscriptionStatus === "active" };

      const ranked = participantIds.map(uid => ({
        uid, name: infoMap[uid]?.name || "Anonymous", phone: infoMap[uid]?.phone || "",
        avg: Math.round(userSteps[uid].total / userSteps[uid].days),
        active: infoMap[uid]?.active || false,
      })).sort((a, b) => b.avg - a.avg);

      const medals = ["🥇", "🥈", "🥉"];
      // Build top 5 board
      let boardBase = `*🏆 Weekly Step Leaderboard*\n\n`;
      for (let i = 0; i < Math.min(5, ranked.length); i++) {
        const r = ranked[i];
        const medal = i < 3 ? medals[i] : `${i + 1}.`;
        const firstName = r.name.split(" ")[0];
        boardBase += `${medal} ${firstName} — ${r.avg.toLocaleString()} avg/day\n`;
      }

      // Send personalised leaderboard to each active participant
      let sent = 0;
      for (const r of ranked) {
        if (!r.active || !r.phone) continue;
        const myRank = ranked.indexOf(r) + 1;
        const personal = myRank <= 5
          ? `\nYou are *#${myRank}*! ${myRank === 1 ? "You led the pack this week. 👑" : "Keep pushing for #1 next week."}`
          : `\nYou are *#${myRank}* of ${ranked.length}. ${r.avg.toLocaleString()} avg steps. Log more to climb next week.`;
        try {
          await sendWhatsApp(r.phone, `${boardBase}${personal}\n\nNew week starts now. Reply *leaderboard* anytime to check rankings.`);
          sent++;
        } catch {}
        if (sent % 10 === 0) await new Promise(r => setTimeout(r, 2000)); // Rate limit
      }
      console.log(`[SCHEDULER] Leaderboard sent to ${sent} clients`);
    } catch (err) {
      console.error("[SCHEDULER] Leaderboard broadcast error:", err);
    }
  }, { timezone: "UTC" });

  // ============================================================
  // WEEKLY KPI AUTO-REPORT — Monday 5am UTC (7am SAST)
  // Sends business KPIs to the coach's WhatsApp number
  // ============================================================
  cron.schedule("0 5 * * 1", async () => {
    const coachPhone = process.env.COACH_ALERT_PHONE;
    if (!coachPhone) {
      console.log("[KPI] COACH_ALERT_PHONE not set — skipping weekly report");
      return;
    }
    try {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
      const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 86_400_000);

      const allClients = await db.select({
        id: users.id,
        subscriptionStatus: users.subscriptionStatus,
        createdAt: users.createdAt,
        totalWorkoutsCompleted: users.totalWorkoutsCompleted,
        lastWorkoutDate: users.lastWorkoutDate,
      }).from(users);

      const totalClients = allClients.length;
      const paying = allClients.filter(c => c.subscriptionStatus === "active").length;
      const newThisWeek = allClients.filter(c => c.createdAt && new Date(c.createdAt) >= sevenDaysAgo).length;

      // Churned = subscriptions that were active but are now inactive/cancelled.
      // Previously wrongly counted active paying clients who hadn't worked out in 14 days —
      // those are "at-risk", not churned. Churn = actually lost revenue.
      const churned = allClients.filter(c =>
        c.subscriptionStatus === "inactive" || c.subscriptionStatus === "cancelled"
      ).length;

      const [weekWorkouts] = await db.select({ c: count() }).from(workoutLogs)
        .where(gte(workoutLogs.loggedAt, sevenDaysAgo));
      const [weekSteps] = await db.select({ c: count() }).from(stepLogs)
        .where(gte(stepLogs.loggedAt, sevenDaysAgo));
      const [weekMessages] = await db.select({ c: count() }).from(chatHistory)
        .where(gte(chatHistory.createdAt, sevenDaysAgo));

      const atRisk = allClients.filter(c => {
        if (c.subscriptionStatus !== "active") return false;
        const lastActivity = c.lastWorkoutDate ? new Date(c.lastWorkoutDate) : (c.createdAt ? new Date(c.createdAt) : now);
        return lastActivity < twoDaysAgo;
      }).length;

      const mrr = paying * PRICING.monthlyPriceZAR;

      // ── Food tracking metrics ──
      const [weekFoodLogs] = await db.select({ c: count() }).from(mealLogs)
        .where(gte(mealLogs.loggedAt, sevenDaysAgo));
      const weekFoodLogsCount = weekFoodLogs?.c || 0;

      // GPT fallback usage — foods the SA scanner couldn't identify
      const [gptFallbackLogs] = await db.execute(
        sql`SELECT COUNT(*) as c FROM meal_logs WHERE source = 'gpt_fallback' AND logged_at >= ${sevenDaysAgo}`
      ) as any;
      const gptFallbackCount = Number(gptFallbackLogs?.rows?.[0]?.c || 0);
      const fallbackPct = weekFoodLogsCount > 0 ? Math.round((gptFallbackCount / weekFoodLogsCount) * 100) : 0;

      // ── Escalation metrics ──
      const [escNewRow] = await db.select({ c: count() }).from(escalations)
        .where(gte(escalations.createdAt, sevenDaysAgo));
      const escNew = escNewRow?.c || 0;

      const [escOpenRow] = await db.select({ c: count() }).from(escalations)
        .where(eq(escalations.status, "open"));
      const escOpen = escOpenRow?.c || 0;

      const [escResolvedRow] = await db.select({ c: count() }).from(escalations)
        .where(and(eq(escalations.status, "resolved"), gte(escalations.resolvedAt, sevenDaysAgo)));
      const escResolved = escResolvedRow?.c || 0;

      const [escUrgentRow] = await db.select({ c: count() }).from(escalations)
        .where(and(eq(escalations.priority, "urgent"), eq(escalations.status, "open")));
      const escUrgent = escUrgentRow?.c || 0;

      // ── Food log source breakdown ──
      const foodSourceRows = await db.execute(
        sql`SELECT source, COUNT(*) as c FROM meal_logs WHERE logged_at >= ${sevenDaysAgo} GROUP BY source ORDER BY c DESC`
      ) as any;
      const foodSources: string[] = (foodSourceRows?.rows || []).map((r: any) => `${r.source || "unknown"}: ${r.c}`);

      // ── A/B experiment results ──
      let abSection = "";
      try {
        const { abExperiments: abExp, abAssignments: abAsgn } = await import("../shared/schema");
        const activeExps = await db.select().from(abExp).where(eq(abExp.status, "active"));
        if (activeExps.length > 0) {
          const abLines: string[] = [];
          for (const exp of activeExps.slice(0, 3)) { // max 3 in the report
            const assignments = await db.select({
              variant: abAsgn.variant,
              delivered: abAsgn.delivered,
              responded: abAsgn.responded,
            }).from(abAsgn).where(eq(abAsgn.experimentId, exp.id));
            const a = assignments.filter(x => x.variant === "A");
            const b = assignments.filter(x => x.variant === "B");
            const rateA = a.filter(x => x.delivered).length > 0
              ? Math.round(a.filter(x => x.responded).length / a.filter(x => x.delivered).length * 100) : 0;
            const rateB = b.filter(x => x.delivered).length > 0
              ? Math.round(b.filter(x => x.responded).length / b.filter(x => x.delivered).length * 100) : 0;
            const winner = rateA > rateB ? "A leads" : rateB > rateA ? "B leads" : "tied";
            abLines.push(`  ${exp.name}: A ${rateA}% vs B ${rateB}% (${winner}, n=${assignments.length})`);
          }
          abSection = `\n\n*A/B Tests*\n${abLines.join("\n")}`;
        }
      } catch (e) {
        console.warn("[KPI] A/B section error:", e);
      }

      const escSection = `\n\n*Escalations*\nNew this week: ${escNew} | Resolved: ${escResolved}\nOpen: ${escOpen}${escUrgent > 0 ? ` ⚠️ ${escUrgent} URGENT` : ""}`;

      const foodSourceSection = foodSources.length > 0
        ? `\nSources: ${foodSources.join(", ")}`
        : "";

      const report = `*📊 KamLife Weekly Report*
_${now.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}_

*Revenue*
MRR: R${mrr.toLocaleString()} (${paying} paying)
New this week: ${newThisWeek}

*Engagement*
Workouts: ${weekWorkouts?.c || 0}
Step logs: ${weekSteps?.c || 0}
Food logs: ${weekFoodLogsCount} (fallback: ${fallbackPct}%)${foodSourceSection}
Messages: ${weekMessages?.c || 0}

*Health*
Total clients: ${totalClients}
At-risk (48h+ silent): ${atRisk}
Churn risk (14d+): ${churned}${escSection}

*Delivery*
Sent: ${deliveryStats.sent} | Failed: ${deliveryStats.failed}${abSection}`;

      await sendWhatsApp(`whatsapp:${coachPhone}`, report);
      console.log(`[KPI] Weekly report sent to coach`);
    } catch (e) {
      console.error("[KPI] Weekly report error:", e);
    }
  });

  // ============================================================
  // SUPPLEMENT REMINDER — daily 6am UTC (8am SAST)
  // Sends supplement reminder to clients who have logged supplements before
  // ============================================================
  cron.schedule("0 6 * * *", async () => {
    console.log("[SCHEDULER] JOB: Supplement reminder");
    const stateKey = "supplement_reminder";
    const today = todaySAST();
    if (loadState()[stateKey] === today) return;
    saveState(stateKey, today);

    try {
      // Find clients who have logged supplements in the last 14 days
      const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);
      const suppLoggers = await db.select({ userId: chatHistory.userId })
        .from(chatHistory)
        .where(and(eq(chatHistory.intent, "SUPPLEMENT_LOG"), gte(chatHistory.createdAt, fourteenDaysAgo)));

      const uniqueUserIds = [...new Set(suppLoggers.map(s => s.userId))];
      if (uniqueUserIds.length === 0) return;

      // Check which ones have NOT logged today
      const todayStart = sastDayStart();
      let sent = 0;
      for (const uid of uniqueUserIds) {
        const todayLog = await db.select({ id: chatHistory.id }).from(chatHistory)
          .where(and(eq(chatHistory.userId, uid), eq(chatHistory.intent, "SUPPLEMENT_LOG"), gte(chatHistory.createdAt, todayStart)))
          .limit(1);
        if (todayLog.length > 0) continue; // already logged today

        const [client] = await db.select({ phoneNumber: users.phoneNumber, name: users.name, subscriptionStatus: users.subscriptionStatus })
          .from(users).where(eq(users.id, uid)).limit(1);
        if (!client || client.subscriptionStatus !== "active") continue;

        const name = client.name?.split(" ")[0] || "there";
        const msg = `Morning ${name} — have you taken your supplements today? Reply "took my vitamins" when done. Consistency matters more than the brand. 💊`;
        await sendWhatsApp(client.phoneNumber, msg);
        sent++;
        if (sent >= 50) break; // rate limit
      }
      console.log(`[SCHEDULER] Supplement reminders sent: ${sent}`);
    } catch (err) {
      console.error("[SCHEDULER] Supplement reminder error:", err);
    }
  }, { timezone: "UTC" });

  // ============================================================
  // AUTO CALORIE ADJUSTMENT — Sunday 10am SAST (8am UTC)
  // If weight is stalling for 3+ weeks, adjust targets automatically
  // ============================================================
  cron.schedule("0 8 * * 0", async () => {
    console.log("[SCHEDULER] JOB: Auto calorie adjustment");
    const stateKey = "auto_cal_adjust";
    const today = todaySAST();
    if (loadState()[stateKey] === today) return;
    saveState(stateKey, today);

    try {
      const activeClients = await db.select({
        id: users.id,
        phoneNumber: users.phoneNumber,
        name: users.name,
        goalType: users.goalType,
        calorieTarget: users.calorieTarget,
        proteinTarget: users.proteinTarget,
        currentWeight: users.currentWeight,
        subscriptionStatus: users.subscriptionStatus,
      }).from(users).where(eq(users.subscriptionStatus, "active"));

      let adjusted = 0;
      for (const client of activeClients) {
        try {
          const threeWeeksAgo = new Date(Date.now() - 21 * 86_400_000);
          const weights = await db.select({ weight: weightLogs.weight, date: weightLogs.loggedAt })
            .from(weightLogs)
            .where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, threeWeeksAgo)))
            .orderBy(asc(weightLogs.loggedAt));

          if (weights.length < 3) continue; // not enough data

          const first = parseFloat(String(weights[0].weight));
          const last = parseFloat(String(weights[weights.length - 1].weight));
          const change = last - first;
          const currentCal = client.calorieTarget || 1800;
          const currentProt = client.proteinTarget || 120;
          const name = client.name?.split(" ")[0] || "there";
          const goal = client.goalType || "fat_loss";

          // Fat loss: if weight hasn't dropped in 3 weeks, reduce by 100-150 kcal
          if (goal === "fat_loss" && change >= -0.3 && currentCal > 1400) {
            const newCal = Math.max(1400, currentCal - 100);
            await db.update(users).set({ calorieTarget: newCal }).where(eq(users.id, client.id));
            const msg = `${name}, your weight has held steady for 3 weeks. I have adjusted your daily target from ${currentCal} to *${newCal} kcal* to keep progress moving.\n\nProtein stays at ${currentProt}g — that does not change. The deficit is small and sustainable. Keep training and logging.`;
            await sendWhatsApp(client.phoneNumber, msg);
            adjusted++;
          }

          // Muscle gain: if weight hasn't increased in 3 weeks, add 100-150 kcal
          if (goal === "muscle_gain" && change <= 0.3 && currentCal < 3500) {
            const newCal = Math.min(3500, currentCal + 150);
            await db.update(users).set({ calorieTarget: newCal }).where(eq(users.id, client.id));
            const msg = `${name}, your weight has not moved in 3 weeks. For muscle gain, you need more fuel. I have bumped your target from ${currentCal} to *${newCal} kcal*.\n\nProtein stays at ${currentProt}g. Focus on adding carbs around training — rice, oats, sweet potato. Your body needs the surplus to grow.`;
            await sendWhatsApp(client.phoneNumber, msg);
            adjusted++;
          }

          if (adjusted >= 20) break; // batch limit
        } catch { /* skip individual client errors */ }
      }
      console.log(`[SCHEDULER] Auto calorie adjustments made: ${adjusted}`);
    } catch (err) {
      console.error("[SCHEDULER] Auto calorie adjustment error:", err);
    }
  }, { timezone: "UTC" });

  // ============================================================
  // MONTHLY NPS SURVEY — 1st of each month, 10am SAST (8am UTC)
  // Sends satisfaction survey to active clients
  // ============================================================
  cron.schedule("0 8 1 * *", async () => {
    console.log("[SCHEDULER] JOB: Monthly NPS survey");
    const stateKey = "nps_survey";
    const today = todaySAST();
    if (loadState()[stateKey] === today) return;
    saveState(stateKey, today);

    try {
      const activeClients = await db.select({
        phoneNumber: users.phoneNumber,
        name: users.name,
        subscriptionStatus: users.subscriptionStatus,
        totalWorkoutsCompleted: users.totalWorkoutsCompleted,
      }).from(users).where(eq(users.subscriptionStatus, "active"));

      let sent = 0;
      for (const client of activeClients) {
        if ((client.totalWorkoutsCompleted || 0) < 3) continue; // too early to survey
        const name = client.name?.split(" ")[0] || "there";
        const msg = `${name}, quick monthly check-in:\n\nOn a scale of 1-10, how likely are you to recommend Coach K to a friend?\n\nJust reply with "rate" followed by your number (e.g. "rate 8").\n\nYour honest answer helps me improve. 🙏`;
        await sendWhatsApp(client.phoneNumber, msg);
        sent++;
        if (sent >= 100) break;
      }
      console.log(`[SCHEDULER] NPS surveys sent: ${sent}`);
    } catch (err) {
      console.error("[SCHEDULER] NPS survey error:", err);
    }
  }, { timezone: "UTC" });

  // ============================================================
  // JOB: WEEKLY WINS CELEBRATION (Sunday 6pm SAST = 4pm UTC)
  // Celebrates what the client achieved this week — #1 retention driver
  // ============================================================
  cron.schedule("0 16 * * 0", async () => {
    const today = todaySAST();
    if (hasRunToday("weekly_wins", today)) return;
    saveState("weekly_wins", today);
    console.log("[SCHEDULER] Running weekly wins celebration...");
    try {
      const allClients = await db.select().from(users)
        .where(eq(users.onboardingState, "COMPLETE"));

      const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000);
      let sent = 0;

      for (const client of allClients) {
        try {
          // Count this week's activities
          const [workouts] = await db.select({ c: count() }).from(workoutLogs)
            .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, sevenDaysAgo)));
          const [stepDays] = await db.select({ c: count() }).from(stepLogs)
            .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, sevenDaysAgo)));
          const weights = await db.select({ weight: weightLogs.weight }).from(weightLogs)
            .where(eq(weightLogs.userId, client.id))
            .orderBy(desc(weightLogs.loggedAt)).limit(2);

          const wk = workouts.c || 0;
          const st = stepDays.c || 0;
          if (wk === 0 && st === 0) continue; // skip inactive clients

          const name = client.name?.split(" ")[0] || "Champ";
          const total = client.totalWorkoutsCompleted || 0;
          const streak = client.workoutStreak || 0;

          // Build wins list
          const wins: string[] = [];
          if (wk > 0) wins.push(`💪 ${wk} workout${wk > 1 ? "s" : ""} completed`);
          if (st > 0) wins.push(`🚶 ${st} day${st > 1 ? "s" : ""} of steps logged`);
          if (streak >= 3) wins.push(`🔥 ${streak}-session streak`);
          if (total > 0 && total % 10 === 0) wins.push(`🏆 ${total} total sessions milestone`);

          // Weight progress
          if (weights.length >= 2) {
            const diff = Number(weights[0].weight) - Number(weights[1].weight);
            if (diff < -0.3) wins.push(`⚖️ Down ${Math.abs(diff).toFixed(1)}kg this week`);
          }

          if (wins.length === 0) continue;

          const msg = `*${name}, your week in review:*\n\n${wins.join("\n")}\n\n${total >= 10 ? `You have done more than most people do in a year. ${total} sessions total.` : "Every session counts. Keep stacking."}\n\nSame energy next week. Monday starts now. 💪`;
          await sendWhatsApp(client.phoneNumber, msg);
          sent++;
          await new Promise(r => setTimeout(r, 200));
          if (sent >= 200) break;
        } catch { /* skip individual client errors */ }
      }
      console.log(`[SCHEDULER] Weekly wins sent: ${sent}`);
    } catch (err) {
      console.error("[SCHEDULER] Weekly wins error:", err);
    }
  }, { timezone: "UTC" });

  // ============================================================
  // JOB: COMEBACK MESSAGE — re-engage clients silent 3-7 days
  // Tuesday & Thursday 10am SAST = 8am UTC
  // ============================================================
  cron.schedule("0 8 * * 2,4", async () => {
    const today = todaySAST();
    if (hasRunToday("comeback_msg", today)) return;
    saveState("comeback_msg", today);
    console.log("[SCHEDULER] Running comeback messages...");
    try {
      const threeDaysAgo = new Date(Date.now() - 3 * 86400_000);
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000);

      const silentClients = await db.select().from(users)
        .where(and(
          eq(users.onboardingState, "COMPLETE"),
          lt(users.lastActiveAt, threeDaysAgo),
          gte(users.lastActiveAt, sevenDaysAgo)
        ));

      const comebacks = [
        (name: string, wk: number) => `${name}, it has been a few days. Your programme is still here waiting. ${wk > 0 ? `You were on ${wk} workouts — do not let that go.` : ""} One session today changes the trajectory. What time are you training?`,
        (name: string, wk: number) => `${name}. No judgment. Life happens. But your goals have not changed.\n\n${wk >= 3 ? `You had a ${wk}-session streak going — that is worth protecting.` : "One workout today puts you back on track."}\n\nReply "menu" to see today's workout. That is all I am asking.`,
        (name: string, wk: number) => `${name}, quick check — you good? Have not heard from you in a few days.\n\nYour programme is ready whenever you are. Just reply "menu" and we pick up exactly where you left off.\n\nNo reset. No guilt. Just forward.`,
        (name: string, wk: number) => `${name}, I noticed you have been quiet. That is usually when the excuses win.\n\nBut not today. ${wk >= 5 ? `${wk} sessions done already — that is more than most people do in a month.` : "Every session counts."}\n\nReply *done* after your next workout. I will be here.`,
      ];

      let sent = 0;
      for (const client of silentClients) {
        const name = client.name?.split(" ")[0] || "Champ";
        const wk = client.totalWorkoutsCompleted || 0;
        const idx = sent % comebacks.length;
        const msg = comebacks[idx](name, wk);
        await sendWhatsApp(client.phoneNumber, msg);
        sent++;
        await new Promise(r => setTimeout(r, 200));
        if (sent >= 100) break;
      }
      console.log(`[SCHEDULER] Comeback messages sent: ${sent}`);
    } catch (err) {
      console.error("[SCHEDULER] Comeback error:", err);
    }
  }, { timezone: "UTC" });

  // Daily motivation job REMOVED — it fired at same time as morning check-in (both 4am UTC),
  // causing two messages every weekday morning. Day-specific context is now part of morning check-in.

  // ============================================================
  // JOB: WEIGHT CHECK-IN REMINDER (Wednesday 7am SAST = 5am UTC)
  // Reminds clients who haven't weighed in this week
  // ============================================================
  cron.schedule("0 5 * * 3", async () => {
    const today = todaySAST();
    if (hasRunToday("weight_reminder", today)) return;
    saveState("weight_reminder", today);
    console.log("[SCHEDULER] Running weight check-in reminder...");
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000);
      const threeDaysAgo = new Date(Date.now() - 3 * 86400_000);

      // Get active clients
      const activeClients = await db.select().from(users)
        .where(and(
          eq(users.onboardingState, "COMPLETE"),
          gte(users.lastActiveAt, threeDaysAgo)
        ));

      let sent = 0;
      for (const client of activeClients) {
        // Check if they weighed in this week
        const [recent] = await db.select({ c: count() }).from(weightLogs)
          .where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, sevenDaysAgo)));
        if ((recent.c || 0) > 0) continue; // already weighed in

        const name = client.name?.split(" ")[0] || "there";
        const msg = `${name}, weigh-in day. ⚖️\n\nStep on the scale first thing — after toilet, before food, same conditions every time.\n\nSend me the number: "84.5kg"\n\nThe scale is data, not judgment. Track it so we can coach from facts, not feelings.`;
        await sendWhatsApp(client.phoneNumber, msg);
        sent++;
        await new Promise(r => setTimeout(r, 200));
        if (sent >= 150) break;
      }
      console.log(`[SCHEDULER] Weight reminders sent: ${sent}`);
    } catch (err) {
      console.error("[SCHEDULER] Weight reminder error:", err);
    }
  }, { timezone: "UTC" });

  // ============================================================
  // JOB: MONDAY PROGRESS SUMMARY (Monday 7am SAST = 5am UTC)
  // The "proof of progress" message — specific numbers, personal, 3 lines
  // This is the #1 retention lever: makes people feel SEEN
  // ============================================================
  cron.schedule("0 5 * * 1", async () => {
    const today = todaySAST();
    if (loadState()["monday_progress"] === today) return;
    saveState("monday_progress", today);
    console.log("[SCHEDULER] Running Monday progress summary...");
    try {
      const clients = await getActiveClients();
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      let sent = 0;

      for (const client of clients) {
        if (isPaused(client)) continue;
        const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
        if (client.lastActiveAt && new Date(client.lastActiveAt) < threeDaysAgo) continue;
        if (!canSendProactive(client.id)) continue;

        try {
          const name = client.name?.split(" ")[0] || "Champ";

          // Count workouts this week
          const [wk] = await db.select({ c: count() }).from(workoutLogs)
            .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, sevenDaysAgo)));
          const workouts = wk.c || 0;

          // Count food logs this week
          const [fl] = await db.select({ c: count() }).from(chatHistory)
            .where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, sevenDaysAgo)));
          const foodLogs = fl.c || 0;

          // Count step log days this week
          const [sl] = await db.select({ c: count() }).from(stepLogs)
            .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, sevenDaysAgo)));
          const stepDays = sl.c || 0;

          // Weight change this week (most recent 2 logs)
          const weights = await db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt })
            .from(weightLogs)
            .where(eq(weightLogs.userId, client.id))
            .orderBy(desc(weightLogs.loggedAt)).limit(2);

          // All-time weight change — first log vs most recent
          const firstWeightLog = await db.select({ weight: weightLogs.weight })
            .from(weightLogs)
            .where(eq(weightLogs.userId, client.id))
            .orderBy(asc(weightLogs.loggedAt)).limit(1);

          // Calculate protein average from food logs
          let proteinTotal = 0; let proteinMeals = 0;
          const weekFoodLogs = await db.select({ messageOut: chatHistory.messageOut })
            .from(chatHistory)
            .where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, sevenDaysAgo)));
          for (const log of weekFoodLogs) {
            const pm = (log.messageOut || "").match(/(\d{1,4})\s*g\s*(?:of\s+)?protein/i);
            if (pm) { proteinTotal += parseInt(pm[1]); proteinMeals++; }
          }

          if (workouts === 0 && foodLogs === 0 && stepDays === 0) continue; // skip fully inactive

          // Build the 3-line progress message
          const lines: string[] = [`*${name}, your week:*`];

          // Line 1: What improved or was consistent
          if (workouts >= 3) {
            lines.push(`💪 ${workouts} workouts — that is consistency. ${client.totalWorkoutsCompleted || 0} total sessions.`);
          } else if (workouts > 0) {
            lines.push(`💪 ${workouts} workout${workouts > 1 ? "s" : ""} done. Target: ${client.trainingDaysPerWeek || 3} per week.`);
          }

          if (foodLogs >= 10) {
            lines.push(`🍽️ ${foodLogs} meals tracked — you are logging consistently.`);
          } else if (foodLogs > 0) {
            lines.push(`🍽️ ${foodLogs} meals logged. More logging = better coaching from me.`);
          }

          if (stepDays >= 4) {
            lines.push(`🚶 Steps logged ${stepDays} days — keep the movement up.`);
          }

          // Line 2: Weight progress — this week AND all-time if meaningful
          if (weights.length >= 2) {
            const diff = Number(weights[0].weight) - Number(weights[1].weight);
            const goal = client.goalType || "fat_loss";
            const mostRecentKg = Number(weights[0].weight);
            const startKg = firstWeightLog.length > 0 ? Number(firstWeightLog[0].weight) : null;
            const totalDiff = startKg !== null ? mostRecentKg - startKg : null;

            if (diff < -0.3 && (goal === "fat_loss" || goal === "recomp")) {
              const allTimeNote = totalDiff !== null && totalDiff < -1.5
                ? ` (${Math.abs(totalDiff).toFixed(1)}kg total since you started)`
                : "";
              lines.push(`⚖️ Down ${Math.abs(diff).toFixed(1)}kg this week.${allTimeNote} Moving in the right direction.`);
            } else if (diff > 0.3 && goal === "muscle_gain") {
              lines.push(`⚖️ Up ${diff.toFixed(1)}kg — good for muscle gain. Track lifts to confirm strength is going up.`);
            } else if (diff > 0.5 && goal === "fat_loss") {
              lines.push(`⚖️ Up ${diff.toFixed(1)}kg this week. Not a disaster — check water, sodium, and food volume.`);
            } else if (Math.abs(diff) <= 0.3 && totalDiff !== null && totalDiff < -2) {
              // Scale not moving this week but overall progress is real — surface it
              lines.push(`⚖️ Scale held steady this week — but you are ${Math.abs(totalDiff).toFixed(1)}kg down since day one. The work is showing.`);
            }
          } else if (firstWeightLog.length > 0 && weights.length >= 1) {
            // Only one recent log — compare to start if meaningful
            const startKg = Number(firstWeightLog[0].weight);
            const nowKg = Number(weights[0].weight);
            const totalDiff = nowKg - startKg;
            const goal = client.goalType || "fat_loss";
            if (totalDiff < -2 && (goal === "fat_loss" || goal === "recomp")) {
              lines.push(`⚖️ ${Math.abs(totalDiff).toFixed(1)}kg down since you started. Real change.`);
            } else if (totalDiff > 2 && goal === "muscle_gain") {
              lines.push(`⚖️ Up ${totalDiff.toFixed(1)}kg since day one — the programme is building mass.`);
            }
          }

          // Protein average
          if (proteinMeals >= 3) {
            const avg = Math.round(proteinTotal / proteinMeals);
            const target = client.proteinTarget || 120;
            if (avg >= target * 0.9) {
              lines.push(`🥩 Protein averaging ~${avg}g per logged meal — on target.`);
            } else {
              lines.push(`🥩 Protein averaging ~${avg}g — target is ${target}g. Add eggs or pilchards to every meal.`);
            }
          }

          // Line 3: One focus for this week
          if (workouts === 0) {
            lines.push(`\n*This week's focus:* Get one workout done. Just one. Reply *today* for your session.`);
          } else if (foodLogs < 5) {
            lines.push(`\n*This week's focus:* Log every meal. I cannot coach what I cannot see.`);
          } else {
            lines.push(`\n*This week's focus:* Keep the same energy. Consistency is the only strategy that works.`);
          }

          await sendWhatsApp(client.phoneNumber, lines.join("\n"));
          recordProactiveSend(client.id);
          sent++;
          await new Promise(r => setTimeout(r, 200));
          if (sent >= 200) break;
        } catch { /* skip individual errors */ }
      }
      console.log(`[SCHEDULER] Monday progress summaries sent: ${sent}`);
    } catch (err) {
      console.error("[SCHEDULER] Monday progress error:", err);
    }
  }, { timezone: "UTC" });

  // ============================================================
  // JOB: REST DAY MICRO-TIPS (daily 10am SAST = 8am UTC)
  // On non-training days, send one actionable SA-specific health tip
  // Fills the engagement gap — 7 touchpoints/week instead of 3
  // ============================================================
  cron.schedule("0 8 * * *", async () => {
    const today = todaySAST();
    if (loadState()["rest_tips"] === today) return;
    saveState("rest_tips", today);
    console.log("[SCHEDULER] Running rest day tips...");

    const REST_TIPS = [
      `💡 *Cheapest high-protein foods at Shoprite this week:*\n\n1. Eggs 6-pack — R22 (36g protein)\n2. Pilchards tin — R12 (22g protein)\n3. Sugar beans 500g — R20 (43g protein dry)\n4. Frozen chicken quarters 1kg — R40 (60g protein)\n\nR94 total. That is 4 days of protein covered.`,
      `💡 *Reading food labels — the SA cheat sheet:*\n\nLook at "per 100g" column, not "per serving" (servings are rigged).\n\n✅ Protein >10g per 100g = good source\n⚠️ Sugar >15g per 100g = too sweet\n❌ Fat >20g per 100g = heavy\n\nThat "healthy" yogurt? Check the sugar. Most SA yogurts have 15-20g sugar per 100g. Rather eat plain yogurt with honey.`,
      `💡 *Your taxi commute counts:*\n\nWalking to the taxi rank: ~100 steps per minute\nStanding at the rank: burns 50% more calories than sitting\nWalking from taxi to work: more steps\n\nA 15-minute walk each way = 3,000 steps done before your day even starts.\n\nLog it: "3000 steps"`,
      `💡 *Water hack for SA heat:*\n\nKeep a 2L bottle visible on your desk or counter. Goal: finish it by 4pm.\n\n2L = your daily minimum.\nTraining day? Add another 500ml.\nHot day (30°C+)? Add another 500ml.\n\nDehydration kills performance and makes you think you are hungry when you are just thirsty.`,
      `💡 *The pap upgrade:*\n\nPlain pap = 120 kcal, 2g protein per cup. Just carbs.\n\n*Make it work:*\n• Add an egg INTO the pap while cooking = +6g protein\n• Serve with pilchards instead of gravy = +22g protein\n• Add a spoon of peanut butter = +7g protein\n\nPap is not bad. Pap with no protein source is the problem.`,
      `💡 *Sleep and fat loss:*\n\nLess than 6 hours sleep = your body holds onto fat 55% more.\n\nIt is not about willpower. Your hormones change:\n• Ghrelin (hunger) goes UP\n• Leptin (fullness) goes DOWN\n• Cortisol (stress/fat storage) goes UP\n\nSleep is not lazy. Sleep is recovery. Target 7 hours minimum.`,
      `💡 *Meal prep Sunday — 1 hour, 5 days sorted:*\n\nBatch cook these:\n1. 1kg chicken thighs — season with Aromat, bake 40 min\n2. 2 cups dry rice — cook and portion into 5 containers\n3. 1 bag frozen mixed veg — steam 10 min\n\nTotal cost: ~R80. That is 5 lunches at ~400 kcal, 35g protein each.\n\nReply *meal prep* for the full guide.`,
      `💡 *The braai-day strategy:*\n\nBraai is not the enemy. The extras are.\n\n✅ 3 chicken pieces (skin off after cooking) = 500 kcal, 84g protein\n⚠️ Add 1 boerewors roll = +350 kcal\n❌ Add 3 beers = +450 kcal\n❌ Add potato salad + braai broodjie = +600 kcal\n\nThe chicken alone? Great meal. The chicken + everything? Full day's calories in one sitting.`,
      `💡 *Why the scale lies:*\n\nYour weight can fluctuate 1-2kg in a single day from:\n• Water retention (salty food, period, creatine)\n• Food in your stomach (undigested)\n• Glycogen (carb storage in muscles)\n\nWeigh yourself once a week, same time, same conditions. The *trend* over 4 weeks is what matters, not any single number.`,
      `💡 *Fast food survival guide:*\n\nBest protein-per-rand at SA fast food:\n\n1. KFC 2-piece original = 32g protein, ~R50\n2. Nando's quarter chicken = 35g protein, ~R65\n3. Steers beef burger (no chips) = 35g protein, ~R55\n\nWorst: any combo meal with large chips + cooldrink. That is an extra 600-800 kcal you did not need.\n\nOrder protein only. Skip the combo.`,
    ];

    try {
      const clients = await getActiveClients();
      const todayDOW = new Date().getDay();
      let sent = 0;

      for (const client of clients) {
        if (isPaused(client)) continue;
        const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
        if (client.lastActiveAt && new Date(client.lastActiveAt) < threeDaysAgo) continue;
        if (!canSendProactive(client.id)) continue;

        // Only send on REST days for this client
        const schedule = TRAINING_SCHEDULES[client.trainingDaysPerWeek || 3] || TRAINING_SCHEDULES[3];
        if (schedule.includes(todayDOW)) continue; // training day — skip

        // Pick tip based on day of year for variety
        const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86_400_000);
        const tipIdx = dayOfYear % REST_TIPS.length;
        const tip = REST_TIPS[tipIdx];

        await sendWhatsApp(client.phoneNumber, tip);
        recordProactiveSend(client.id);
        sent++;
        await new Promise(r => setTimeout(r, 200));
        if (sent >= 200) break;
      }
      console.log(`[SCHEDULER] Rest day tips sent: ${sent}`);
    } catch (err) {
      console.error("[SCHEDULER] Rest day tips error:", err);
    }
  }, { timezone: "UTC" });

  // ============================================================
  // JOB: PAYDAY MEAL PREP SEQUENCE (18th, 19th, 20th of month)
  // 3-message sequence: shopping list → prep instructions → daily breakdown
  // The feature that makes R149 pay for itself
  // ============================================================

  // Day 1: Shopping list (18th, 9am SAST = 7am UTC)
  cron.schedule("0 7 18 * *", async () => {
    const today = todaySAST();
    if (loadState()["payday_prep_1"] === today) return;
    saveState("payday_prep_1", today);
    console.log("[SCHEDULER] Payday prep Day 1: Shopping list...");
    try {
      const clients = await getActiveClients();
      let sent = 0;

      for (const client of clients) {
        if (isPaused(client)) continue;
        if (!canSendProactive(client.id)) continue;
        const name = client.name?.split(" ")[0] || "there";
        const budget = client.weeklyFoodBudget || "100_300";
        const goal = client.goalType || "fat_loss";

        // Header never hardcodes a Rand figure — the total at the bottom is
        // computed from the item prices, and a mismatch (e.g. header "R95" but
        // total R131) destroys trust. Tier label only, total at bottom.
        let msg = "";
        if (budget === "under_100" || budget === "50_100" || budget === "under_50") {
          msg = `*${name}, Month-End Meal Prep — Shopping List* 🛒\n\nYour budget-friendly protein-first grocery list:\n\n*Proteins (buy FIRST):*\n☐ Eggs 12-pack — R45\n☐ Pilchards 3 tins — R36\n☐ Sugar beans 500g — R14\n\n*Carbs + Veg:*\n☐ Pap 2.5kg — R18\n☐ Onions 1kg — R10\n☐ Cabbage head — R8\n\n*Total: ~R131*\nThis covers protein for 7 days. ${goal === "fat_loss" ? "Eat smaller portions of pap, bigger portions of beans and eggs." : "Eat full portions — you need the fuel."}\n\n_Tomorrow I send the prep plan. Buy today or this weekend._`;
        } else if (budget === "100_300") {
          msg = `*${name}, Month-End Meal Prep — Shopping List* 🛒\n\nYour balanced protein-first grocery list:\n\n*Proteins (buy FIRST):*\n☐ Frozen chicken quarters 2kg — R80\n☐ Eggs 18-pack — R55\n☐ Pilchards 4 tins — R48\n☐ Sugar beans 500g — R14\n\n*Carbs:*\n☐ Brown rice 1kg — R18\n☐ Pap 2.5kg — R18\n☐ Sweet potato 1kg — R12\n☐ Brown bread — R16\n\n*Vegetables:*\n☐ Frozen mixed veg 1kg — R25\n☐ Spinach bunch — R10\n☐ Tomatoes 1kg — R15\n☐ Onions 1kg — R10\n\n*Total: ~R321*\n${goal === "muscle_gain" ? "Protein is king. Eat chicken at every main meal." : "Split chicken into 8 portions — 2 per day for 4 days."}\n\n_Tomorrow I send the batch cooking plan._`;
        } else {
          msg = `*${name}, Month-End Meal Prep — Shopping List* 🛒\n\nYour performance-tier grocery list:\n\n*Proteins:*\n☐ Chicken breast 1.5kg — R120\n☐ Lean beef mince 500g — R55\n☐ Eggs 18-pack — R55\n☐ Greek yogurt 500g — R45\n☐ Tuna 3 tins — R54\n\n*Carbs:*\n☐ Brown rice 1kg — R18\n☐ Sweet potato 2kg — R24\n☐ Oats 1kg — R25\n☐ Brown bread — R16\n\n*Vegetables + Extras:*\n☐ Broccoli 500g — R20\n☐ Spinach bunch — R10\n☐ Avocado 3-pack — R25\n☐ Banana bunch — R12\n☐ Peanut butter 400g — R32\n\n*Total: ~R511*\n\n_Tomorrow: the batch cooking plan that turns this into 20+ meals._`;
        }

        await sendWhatsApp(client.phoneNumber, msg);
        recordProactiveSend(client.id);
        sent++;
        await new Promise(r => setTimeout(r, 200));
        if (sent >= 200) break;
      }
      console.log(`[SCHEDULER] Payday prep Day 1 sent: ${sent}`);
    } catch (err) {
      console.error("[SCHEDULER] Payday prep 1 error:", err);
    }
  }, { timezone: "UTC" });

  // Day 2: Batch cooking instructions (19th, 9am SAST = 7am UTC)
  cron.schedule("0 7 19 * *", async () => {
    const today = todaySAST();
    if (loadState()["payday_prep_2"] === today) return;
    saveState("payday_prep_2", today);
    console.log("[SCHEDULER] Payday prep Day 2: Cooking plan...");
    try {
      const clients = await getActiveClients();
      let sent = 0;

      for (const client of clients) {
        if (isPaused(client)) continue;
        if (!canSendProactive(client.id)) continue;
        const name = client.name?.split(" ")[0] || "there";
        const budget = client.weeklyFoodBudget || "100_300";

        const calTarget = client.calorieTarget || 1800;
        const protTarget = client.proteinTarget || 120;
        let msg = "";
        if (budget === "under_100" || budget === "50_100" || budget === "under_50") {
          // Base plan = ~1,050 kcal / ~82g protein. Tell clients how to scale to their target.
          const calGap = calTarget - 1050;
          const scalingNote = calGap > 300
            ? `Your target is ${calTarget} kcal — double your sugar bean portion at dinner and add an extra egg at breakfast to close the gap.`
            : `This base plan hits ~1,050 kcal. Add a spoon of peanut butter with breakfast to reach your ${calTarget} kcal target.`;
          msg = `*${name}, Batch Cook Plan — 1 hour, 5 days sorted* 🍳\n\n*Step 1 (10 min):* Boil 12 eggs. Store in fridge.\n*Step 2 (5 min):* Open 3 tins pilchards, portion into 3 containers.\n*Step 3 (15 min):* Cook sugar beans — soak overnight, boil 1 hour (or pressure cooker 20 min). Portion into 5 containers.\n*Step 4 (20 min):* Cook pap for 3 days. Store covered.\n\n*Daily plan:*\n🌅 Breakfast: 2–3 boiled eggs + pap\n🌞 Lunch: Pap + pilchards (1 tin)\n🌙 Dinner: Pap + sugar beans + fried onion\n\n*~1,050 kcal | ~85g protein per day (base)*\n${scalingNote}\n\nTomorrow I send your full day-by-day breakdown.`;
        } else {
          msg = `*${name}, Sunday Batch Cook — 1.5 hours, done for the week* 🍳\n\n*Step 1 (40 min):* Season chicken with Aromat + paprika. Bake at 180°C for 40 min. Portion into 5–6 meals.\n*Step 2 (20 min):* Cook 2 cups dry rice. Portion into 5 containers.\n*Step 3 (10 min):* Steam frozen mixed veg. Add to each container.\n*Step 4 (10 min):* Boil 12 eggs for grab-and-go snacks.\n*Step 5 (5 min):* Portion sugar beans into 3 containers for dinners.\n\n*Daily plan:*\n🌅 Breakfast: 2 eggs + toast OR oats\n🌞 Lunch: Chicken + rice + veg (your prepped container)\n🌙 Dinner: Pilchards/beans + pap + spinach\n🍎 Snack: Boiled egg or peanut butter on bread\n\n*~${calTarget} kcal | ~${protTarget}g protein per day*\n\nPrep once. Eat clean all week. Tomorrow I send the exact daily breakdown.`;
        }

        await sendWhatsApp(client.phoneNumber, msg);
        recordProactiveSend(client.id);
        sent++;
        await new Promise(r => setTimeout(r, 200));
        if (sent >= 200) break;
      }
      console.log(`[SCHEDULER] Payday prep Day 2 sent: ${sent}`);
    } catch (err) {
      console.error("[SCHEDULER] Payday prep 2 error:", err);
    }
  }, { timezone: "UTC" });

  // Day 3: Daily breakdown (20th, 9am SAST = 7am UTC)
  cron.schedule("0 7 20 * *", async () => {
    const today = todaySAST();
    if (loadState()["payday_prep_3"] === today) return;
    saveState("payday_prep_3", today);
    console.log("[SCHEDULER] Payday prep Day 3: Daily breakdown...");
    try {
      const clients = await getActiveClients();
      let sent = 0;

      for (const client of clients) {
        if (isPaused(client)) continue;
        if (!canSendProactive(client.id)) continue;
        const name = client.name?.split(" ")[0] || "there";
        const goal = client.goalType || "fat_loss";
        const calTarget = client.calorieTarget || 1800;
        const protTarget = client.proteinTarget || 120;

        // Build a realistic daily plan that actually hits the client's personal targets.
        const isLowBudget = (client.weeklyFoodBudget || "100_300") === "under_100"
          || (client.weeklyFoodBudget || "") === "50_100"
          || (client.weeklyFoodBudget || "") === "under_50";

        // Portion sizes scale with calTarget so the numbers add up correctly.
        const breakfastKcal = isLowBudget ? 250 : 300;
        const breakfastProt = isLowBudget ? 14 : 18;
        const lunchKcal = isLowBudget ? Math.round(calTarget * 0.33) : Math.round(calTarget * 0.35);
        const lunchProt = Math.round(protTarget * 0.33);
        const dinnerKcal = isLowBudget ? Math.round(calTarget * 0.30) : Math.round(calTarget * 0.32);
        const dinnerProt = Math.round(protTarget * 0.35);
        const snackKcal = calTarget - breakfastKcal - lunchKcal - dinnerKcal;
        const snackProt = protTarget - breakfastProt - lunchProt - dinnerProt;

        const lunchFood = isLowBudget ? "Pap + pilchards + onion" : "Chicken + rice + veg (your prepped container)";
        const dinnerFood = isLowBudget ? "Sugar beans + pap + fried onion" : "Pilchards or beans + pap + spinach";
        const snackFood = isLowBudget ? "1–2 boiled eggs" : "Peanut butter on bread OR boiled egg";

        const msg = `*${name}, your daily eating plan this week:*\n\n*🌅 Breakfast (7am):*\n${isLowBudget ? "2 eggs + pap" : "2 eggs + toast OR oats"} = ~${breakfastKcal} kcal, ${breakfastProt}g protein\n\n*🌞 Lunch (1pm):*\n${lunchFood} = ~${lunchKcal} kcal, ~${lunchProt}g protein\n\n*🌙 Dinner (7pm):*\n${dinnerFood} = ~${dinnerKcal} kcal, ~${dinnerProt}g protein\n\n*🍎 Snack (if needed):*\n${snackFood} = ~${Math.max(snackKcal, 150)} kcal, ~${Math.max(snackProt, 8)}g protein\n\n*Daily target: ${calTarget} kcal | ${protTarget}g protein*\n${goal === "fat_loss" ? `This keeps you in a deficit. Stay on the plan — do not skip meals.` : `Eat every meal. You need the fuel to build.`}\n\nLog every meal this week. Just send what you ate — I track the numbers.\n\n_This 3-day plan (shopping → cooking → eating) is worth more than the R149 subscription. That is the goal._`;

        await sendWhatsApp(client.phoneNumber, msg);
        recordProactiveSend(client.id);
        sent++;
        await new Promise(r => setTimeout(r, 200));
        if (sent >= 200) break;
      }
      console.log(`[SCHEDULER] Payday prep Day 3 sent: ${sent}`);
    } catch (err) {
      console.error("[SCHEDULER] Payday prep 3 error:", err);
    }
  }, { timezone: "UTC" });

  // ============================================================
  // JOB — SURPRISE REINFORCEMENT (Saturday 9am SAST = 7am UTC)
  // Fires weekly for clients who had 5+ food-log days AND
  // workout streak >= 3 in the last 7 days. One message per week.
  // ============================================================
  cron.schedule("0 7 * * 6", async () => {
    const today = todaySAST();
    const weekKey = `surprise_reinforcement_${today.slice(0, 7)}_w${Math.ceil(parseInt(today.slice(8)) / 7)}`;
    if (loadState()[weekKey] === "sent") return;
    saveState(weekKey, "sent");
    console.log("[SCHEDULER] JOB: Surprise reinforcement");
    try {
      const clients = await getActiveClients();
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      let sent = 0;
      for (const client of clients) {
        if (isPaused(client)) continue;
        if (!canSendProactive(client.id)) continue;
        const wStreak = client.workoutStreak || 0;
        if (wStreak < 3) continue;
        // Count distinct food-log days in last 7 days
        const recentMeals = await db.select({ loggedAt: mealLogs.loggedAt })
          .from(mealLogs)
          .where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, sevenDaysAgo)));
        const logDays = new Set(recentMeals.map(m => {
          const d = new Date((m.loggedAt?.getTime() || 0) + 2 * 3_600_000);
          return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
        }));
        if (logDays.size < 5) continue;
        const name = client.name?.split(" ")[0] || "there";
        await sendWhatsApp(client.phoneNumber,
          `${name} — I do not send this message often.\n\n${logDays.size} days of food logged this week. ${wStreak} sessions in the streak. That is not motivation — that is discipline.\n\nMost people who start a programme like yours are long gone by now. You are still here, still logging, still showing up.\n\nKeep going. The compounding is real.`
        );
        recordProactiveSend(client.id);
        sent++;
        await new Promise(r => setTimeout(r, 300));
        if (sent >= 50) break;
      }
      console.log(`[SCHEDULER] Surprise reinforcement sent: ${sent}`);
    } catch (err) {
      console.error("[SCHEDULER] Surprise reinforcement error:", err);
    }
  }, { timezone: "UTC" });

  // ============================================================
  // JOB — MONTHLY COHORT SNAPSHOT (1st of each month, 2am SAST)
  // Writes an immutable JSON record to the scheduler state file
  // with trial→paid conversion, active count, and churn for the
  // closing month. Used for CFO-level retention metrics.
  // ============================================================
  cron.schedule("0 0 1 * *", async () => {
    const snapshotMonth = (() => {
      const d = new Date(Date.now() + 2 * 3_600_000 - 86_400_000); // yesterday = closing month
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    })();
    const snapKey = `cohort_snapshot_${snapshotMonth}`;
    if (loadState()[snapKey]) return; // immutable — never overwrite
    console.log(`[SCHEDULER] JOB: Monthly cohort snapshot for ${snapshotMonth}`);
    try {
      const allUsers = await db.select({
        id: users.id,
        subscriptionStatus: users.subscriptionStatus,
        createdAt: users.createdAt,
        cancelledAt: users.cancelledAt,
        lastActiveAt: users.lastActiveAt,
        totalWorkoutsCompleted: users.totalWorkoutsCompleted,
      }).from(users);

      const monthStart = new Date(`${snapshotMonth}-01T00:00:00.000Z`);
      const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));

      const active = allUsers.filter(u => u.subscriptionStatus === "active").length;
      const trial = allUsers.filter(u => u.subscriptionStatus === "trial").length;
      const inactive = allUsers.filter(u => u.subscriptionStatus === "inactive").length;
      const newSignups = allUsers.filter(u => u.createdAt && new Date(u.createdAt) >= monthStart && new Date(u.createdAt) < monthEnd).length;
      const churned = allUsers.filter(u => u.cancelledAt && new Date(u.cancelledAt) >= monthStart && new Date(u.cancelledAt) < monthEnd).length;
      const atRisk = allUsers.filter(u => u.subscriptionStatus === "active" && u.lastActiveAt && (Date.now() - new Date(u.lastActiveAt).getTime()) > 7 * 86_400_000).length;
      const engagedActive = allUsers.filter(u => u.subscriptionStatus === "active" && (u.totalWorkoutsCompleted || 0) >= 3).length;

      const snapshot = { month: snapshotMonth, snappedAt: new Date().toISOString(), active, trial, inactive, newSignups, churned, atRisk, engagedActive };
      saveState(snapKey, JSON.stringify(snapshot));
      console.log(`[SCHEDULER] Cohort snapshot saved: ${JSON.stringify(snapshot)}`);
    } catch (err) {
      console.error("[SCHEDULER] Cohort snapshot error:", err);
    }
  }, { timezone: "UTC" });

  // ============================================================
  // JOB — WEEKLY PROGRESS CARD (Friday 9am SAST = 7am UTC)
  // Auto-sends a shareable weekly progress card to users who had
  // a strong week (2+ workouts OR 5+ food-log days). Skips users
  // who had a bad week — a card showing nothing is demotivating.
  // ============================================================
  cron.schedule("0 7 * * 5", async () => {
    const today = todaySAST();
    const cardKey = `weekly_progress_card_${today.slice(0, 7)}_w${Math.ceil(parseInt(today.slice(8)) / 7)}`;
    if (loadState()[cardKey] === "sent") return;
    saveState(cardKey, "sent");
    console.log("[SCHEDULER] JOB: Weekly progress card");
    try {
      const clients = await getActiveClients();
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      let sent = 0;
      for (const client of clients) {
        if (isPaused(client)) continue;
        if (!canSendProactive(client.id)) continue;
        const wStreak = client.workoutStreak || 0;
        const [weekWorkouts, weekMeals] = await Promise.all([
          db.select({ id: workoutLogs.id })
            .from(workoutLogs)
            .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, sevenDaysAgo))),
          db.select({ loggedAt: mealLogs.loggedAt, proteinInt: mealLogs.proteinInt })
            .from(mealLogs)
            .where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, sevenDaysAgo))),
        ]);
        const workoutCount = weekWorkouts.length;
        const foodDays = new Set(weekMeals.map(m => {
          const d = new Date((m.loggedAt?.getTime() || 0) + 2 * 3_600_000);
          return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
        })).size;
        // Only send if there's a win to show
        if (workoutCount < 2 && foodDays < 4) continue;

        const name = client.name?.split(" ")[0] || "there";
        const protByDay: Record<string, number> = {};
        for (const meal of weekMeals) {
          const d = new Date((meal.loggedAt?.getTime() || 0) + 2 * 3_600_000);
          const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
          protByDay[key] = (protByDay[key] || 0) + (meal.proteinInt || 0);
        }
        const bestProt = Object.values(protByDay).length > 0 ? Math.max(...Object.values(protByDay)) : 0;
        const protTarget = client.proteinTarget || 130;
        const trainingDays = client.trainingDaysPerWeek || 3;
        const programmeDays = client.programmeStartDate
          ? Math.floor((Date.now() - new Date(client.programmeStartDate).getTime()) / 86_400_000) : 0;
        const weekNum = programmeDays > 0 ? Math.ceil(programmeDays / 7) : 1;
        const scoreEmoji = workoutCount >= trainingDays && foodDays >= 5 ? "🔥" : "✅";

        let referralCode = client.referralCode;
        if (!referralCode) {
          const prefix = (client.name || "KAM").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "K");
          referralCode = `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
          await db.update(users).set({ referralCode }).where(eq(users.id, client.id));
        }

        const lines = [
          `${scoreEmoji} *${name} — Week ${weekNum} Report*`,
          ``,
          `🏋️ Workouts: ${workoutCount}/${trainingDays}`,
          `🔥 Streak: ${wStreak} sessions`,
          `🥗 Food logged: ${foodDays}/7 days`,
          bestProt > 0 ? `💪 Best: ${bestProt}g protein${bestProt >= protTarget ? " — target hit" : ""}` : "",
          ``,
          workoutCount >= trainingDays && foodDays >= 5
            ? `Consistent week. Keep it going.`
            : `Good week. Close the gap next Friday.`,
          ``,
          `_Forward this to a friend. Code *${referralCode}* — month 1 for R50._`,
        ].filter(Boolean);

        await sendWhatsApp(client.phoneNumber, lines.join("\n"));
        recordProactiveSend(client.id, "weekly_progress_card");
        sent++;
        await new Promise(r => setTimeout(r, 300));
        if (sent >= 200) break;
      }
      console.log(`[SCHEDULER] Weekly progress card sent: ${sent}`);
    } catch (err) {
      console.error("[SCHEDULER] Weekly progress card error:", err);
    }
  }, { timezone: "UTC" });

}

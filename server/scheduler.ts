import cron from "node-cron";
import twilio from "twilio";
import { db } from "./db";
import { users, chatHistory, stepLogs, workoutLogs, weightLogs } from "../shared/schema";
import { eq, gte, lte, and, lt, desc, asc, or } from "drizzle-orm";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { generateVoiceNote } from "./tts";

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

// Track proactive messages sent today per client — max 2 per day
// Key format: "YYYY-MM-DD:clientId" so the map is self-expiring by day
const dailyMessageCount = new Map<string, number>();

function dailyKey(clientId: string): string {
  return `${todayUTC()}:${clientId}`;
}

function canSendProactive(clientId: string): boolean {
  const count = dailyMessageCount.get(dailyKey(clientId)) || 0;
  return count < 2;
}

function recordProactiveSend(clientId: string): void {
  const key = dailyKey(clientId);
  dailyMessageCount.set(key, (dailyMessageCount.get(key) || 0) + 1);
}

// Purge stale keys at midnight SAST (22:00 UTC) — prevents unbounded Map growth
cron.schedule("0 22 * * *", () => {
  const today = todayUTC();
  for (const key of dailyMessageCount.keys()) {
    if (!key.startsWith(today)) dailyMessageCount.delete(key);
  }
  console.log("[SCHEDULER] dailyMessageCount purged — entries remaining:", dailyMessageCount.size);
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

async function sendWhatsApp(to: string, body: string, mediaUrl?: string): Promise<void> {
  if (!FROM_NUMBER) {
    console.warn("[SCHEDULER] TWILIO_WHATSAPP_NUMBER not set — skipping send");
    return;
  }
  const params: any = { from: FROM_NUMBER, to, body };
  if (mediaUrl) params.mediaUrl = [mediaUrl];
  await twilioClient.messages.create(params);
  console.log(`[SCHEDULER] → ${to.slice(-8)}: ${body.slice(0, 80)}…`);
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
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(0, 0, 0, 0);
  return d;
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
    // Only send to clients active in the last 3 days — don't spam silent users
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    if (client.lastActiveAt && new Date(client.lastActiveAt) < threeDaysAgo) continue;
    try {
      const name = client.name || "there";
      const phone = client.phoneNumber;
      const proteinTarget = client.proteinTarget || 120;

      const yesterdayLogs = await getYesterdayLogs(client.id);

      if (yesterdayLogs.length === 0) {
        // Completely silent day — short and direct
        if (canSendProactive(client.id)) {
          await sendWhatsApp(phone,
            `Morning ${name}. Nothing logged yesterday — I have nothing to coach from. Log your breakfast in the next hour. That is all.`
          );
          recordProactiveSend(client.id);
        }
        continue;
      }

      const foodLogs = yesterdayLogs.filter(l => l.intent === "FOOD_LOG");
      const workoutLogged = yesterdayLogs.some(l => l.intent === "WORKOUT_LOG" || (l.messageIn || "").toLowerCase().trim() === "done");
      const stepsLog = yesterdayLogs.find(l => l.intent === "STEP_LOG");

      // Extract protein logged from GPT responses
      // Matches: "35g protein", "protein: 120g", "protein 8g", "total protein 45g", "1200g protein"
      let totalProtLogged = 0;
      for (const log of foodLogs) {
        const out = log.messageOut || "";
        // Try "Xg protein" or "X grams protein" (protein after value)
        let pm = out.match(/\b(\d{1,4})\s*g(?:rams?)?\s*(?:of\s+)?protein/i);
        // Fallback: "protein: Xg" or "protein Xg" (protein before value)
        if (!pm) pm = out.match(/\bprotein[:\s]+(\d{1,4})\s*g?/i);
        if (pm) totalProtLogged += parseInt(pm[1]);
      }

      // Extract steps logged from step log messages
      let stepsLogged = 0;
      if (stepsLog) {
        const sm = (stepsLog.messageIn || "").match(/\b([\d,]+)\s*steps?\b/i);
        if (sm) stepsLogged = parseInt(sm[1].replace(/,/g, ""));
      }

      const parts: string[] = [`Morning ${name}.`];

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

      // Workout
      if (workoutLogged) parts.push(`Session done yesterday. Sharp.`);

      // Steps — specific number vs target
      if (stepsLogged > 0) {
        const stepsTarget = client.stepsTarget || 8500;
        if (stepsLogged >= stepsTarget) {
          parts.push(`Steps: ${stepsLogged.toLocaleString()} — target hit.`);
        } else {
          parts.push(`Steps: ${stepsLogged.toLocaleString()} of ${stepsTarget.toLocaleString()} target.`);
        }
      }

      // End with one specific action — include training nudge if today is a training day
      const schedule = TRAINING_SCHEDULES[client.trainingDaysPerWeek || 3] || TRAINING_SCHEDULES[3];
      const isTodayTrainingDay = schedule.includes(todayDOW);

      if (foodLogs.length === 0) {
        parts.push(isTodayTrainingDay ? `Send me breakfast now — then reply "today" for your workout.` : `Send me breakfast now.`);
      } else if (isTodayTrainingDay) {
        parts.push(`Training day today. Reply "today" after your first meal to get your session.`);
      } else {
        parts.push(`Rest day today. Stay on food and steps.`);
      }

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

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      const todayLogs = await getTodayLogs(client.id);

      if (todayLogs.length === 0) {
        if (canSendProactive(client.id)) {
          // First-workout activation nudge: if 0 workouts ever and signed up > 6h ago
          const isNewClient = !client.totalWorkoutsCompleted && client.createdAt &&
            (Date.now() - new Date(client.createdAt).getTime()) > 6 * 3_600_000 &&
            (Date.now() - new Date(client.createdAt).getTime()) < 48 * 3_600_000;
          if (isNewClient) {
            await sendWhatsApp(client.phoneNumber,
              `${name}, your programme is loaded and ready. Reply *1* to see today's workout — it takes 20 minutes. The first session is always the hardest. Get it done tonight.`
            );
          } else {
            await sendWhatsApp(client.phoneNumber,
              `${name}, it is 7pm and I have not heard from you today. No judgment. Just tell me one thing — did you train today, yes or no.`
            );
          }
          recordProactiveSend(client.id);
        }
      }
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

cron.schedule("0 4 * * *", async () => {
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
        await sendWhatsApp(client.phoneNumber,
          `${name}, you have ${workouts} sessions banked. Week 3 is where 70% of people disappear — not because it got too hard, but because the mirror has not changed yet. The adaptation is happening in your muscles and metabolism. It is not visible yet but it is real. Show up ${planned} more times this week. That is all.`
        );
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
    return `${name}, seven days in. ${workouts > 0 ? `${workouts} session${workouts > 1 ? "s" : ""} completed.` : "Keep building the habit."} Most people quit before they even get here. Send your weight today — I want a baseline for week two.`;
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
const WORKOUT_MILESTONES: Record<number, (name: string) => string> = {
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
      if ([7, 30, 60, 90, 180, 365].includes(days)) {
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

cron.schedule("0 4,16 * * *", async () => {
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
          await db.update(users).set({ lastActiveAt: client.lastActiveAt }).where(eq(users.id, client.id));
          console.log(`[SCHEDULER] 14-day silence — flagged for manual review: ${client.phoneNumber}`);
        } catch (flagErr) {
          console.error(`[SCHEDULER] Failed to flag 14-day silent user ${client.phoneNumber}:`, flagErr);
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

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      if (canSendProactive(client.id)) {
        await sendWhatsApp(client.phoneNumber,
          `${name}, weekend is here. This is where most people lose the progress they built Monday to Friday. Two rules only — protein at every meal and one training session before Sunday night. That is it. Everything else is flexible.`
        );
        recordProactiveSend(client.id);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Friday strategy error — ${client.phoneNumber}:`, err);
    }
  }
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

cron.schedule("0 10 * * 1-6", async () => {
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
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
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
}, { timezone: "UTC" });

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
// JOB 12 — 14-DAY AND 30-DAY SILENCE ESCALATION
// Runs every 12 hours alongside silence detection
// ============================================================

cron.schedule("0 5,17 * * *", async () => {
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

cron.schedule("0 18 * * *", async () => {
  console.log("[SCHEDULER] JOB: Streak-at-risk alert");
  const clients = await getActiveClients();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      // Only alert clients with a meaningful step streak
      const streak = client.waterStreak || 0; // reuse step streak concept
      // Check if they have logged steps today
      const todaySteps = await db.select().from(stepLogs)
        .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, todayStart)))
        .limit(1);

      if (todaySteps.length > 0) continue; // Already logged — no alert needed

      // Get their step streak from recent logs
      const recentStepLogs = await db.select({ loggedAt: stepLogs.loggedAt })
        .from(stepLogs)
        .where(eq(stepLogs.userId, client.id))
        .orderBy(desc(stepLogs.loggedAt))
        .limit(14);

      if (recentStepLogs.length < 3) continue; // No streak to protect

      // Check consecutive days
      const days = new Set<string>();
      for (const log of recentStepLogs) {
        const d = new Date(log.loggedAt!);
        days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
      }
      let streakCount = 0;
      const checkDate = new Date();
      checkDate.setDate(checkDate.getDate() - 1); // Start from yesterday
      while (true) {
        const key = `${checkDate.getFullYear()}-${checkDate.getMonth()}-${checkDate.getDate()}`;
        if (!days.has(key)) break;
        streakCount++;
        checkDate.setDate(checkDate.getDate() - 1);
      }

      if (streakCount >= 3) {
        if (!canSendProactive(client.id)) continue;
        const name = client.name || "there";
        await sendWhatsApp(client.phoneNumber,
          `${name}, your ${streakCount}-day step streak ends at midnight if you do not log today. Log your steps before bed — even 2,000 steps keeps the streak alive.`
        );
        recordProactiveSend(client.id);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Streak-at-risk error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

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

cron.schedule("0 8 * * *", async () => {
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

cron.schedule("0 7 * * 0", async () => {
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

cron.schedule("0 9 * * *", async () => {
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
        // New signup who hasn't paid yet — nudge on day 1 and day 3
        const daysSince = Math.floor((Date.now() - created.getTime()) / 86_400_000);
        if (daysSince === 1) {
          await sendWhatsApp(client.phoneNumber,
            `${name} — your programme is still waiting.\n\nGoal set. Training mode set. Calorie targets calculated. All that is left is the first session.\n\n*Activate for R99/month:*\n${payLink}\n\nDay 1 drops the moment you pay. Less than a KFC streetwise.`
          );
        } else if (daysSince === 3) {
          await sendWhatsApp(client.phoneNumber,
            `${name} — Coach K here. You set up your profile 3 days ago.\n\nMost people who don't start within 48 hours never start at all. You're still in the window.\n\nR99/month. Day 1 sent immediately on payment:\n${payLink}`
          );
        }

      } else if (!isNewSignup && cancelled) {
        // Lapsed paying subscriber — they paid before, now inactive
        const daysSinceCancelled = Math.floor((Date.now() - cancelled.getTime()) / 86_400_000);
        const workouts = client.totalWorkoutsCompleted || 0;

        if (daysSinceCancelled === 3) {
          await sendWhatsApp(client.phoneNumber,
            `${name} — you've done ${workouts} sessions with Coach K. That doesn't disappear.\n\nYour programme, weight history, and streaks are all saved. Pick up exactly where you left off.\n\n*Reactivate for R99/month:*\n${payLink}`
          );
        } else if (daysSinceCancelled === 7) {
          await sendWhatsApp(client.phoneNumber,
            `${name}, a week since you left.\n\nThe people who come back after a week are the ones who actually get results — they know what consistency feels like now.\n\nR99/month. Your data is here:\n${payLink}`
          );
        } else if (daysSinceCancelled === 30) {
          await sendWhatsApp(client.phoneNumber,
            `${name} — 30 days. Coach K here.\n\nOne message to say your profile is still here if you want it. ${workouts} sessions logged. Progress saved.\n\nR99/month if you're ready:\n${payLink}\n\nIf not — no hard feelings. Reply STOP and I won't message again.`
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

export function initScheduler(): void {
  if (schedulerInitialised) {
    console.log("[SCHEDULER] Already initialised — skipping duplicate registration");
    return;
  }
  schedulerInitialised = true;

  // ---- Catch up any daily jobs missed due to server restart ----
  (async () => {
    try {
      const state = loadState();
      const today = todayUTC();
      const nowUTC = new Date().getUTCHours();

      // Morning job runs at 4am UTC (6am SAST) — only catch up within a 3-hour window (4am-7am UTC)
      if (nowUTC >= 4 && nowUTC <= 7 && state["morning_checkin"] !== today) {
        console.log("[SCHEDULER] ⚡ Catch-up: running missed morning check-in");
        await runMorningCheckin();
      }

      // Evening job runs at 5pm UTC (7pm SAST) — only catch up within a 2-hour window (5pm-7pm UTC)
      if (nowUTC >= 17 && nowUTC <= 19 && state["evening_accountability"] !== today) {
        console.log("[SCHEDULER] ⚡ Catch-up: running missed evening accountability");
        await runEveningAccountability();
      }
    } catch (e) {
      console.error("[SCHEDULER] Catch-up error:", e);
    }
  })();

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
}

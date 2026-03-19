import cron from "node-cron";
import twilio from "twilio";
import { db } from "./db";
import { users, chatHistory, stepLogs, workoutLogs, weightLogs } from "../shared/schema";
import { eq, gte, lte, and, lt, desc, asc } from "drizzle-orm";

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

async function sendWhatsApp(to: string, body: string): Promise<void> {
  if (!FROM_NUMBER) {
    console.warn("[SCHEDULER] TWILIO_WHATSAPP_NUMBER not set — skipping send");
    return;
  }
  await twilioClient.messages.create({ from: FROM_NUMBER, to, body });
  console.log(`[SCHEDULER] → ${to.slice(-8)}: ${body.slice(0, 80)}…`);
}

// ============================================================
// HELPERS
// ============================================================

async function getActiveClients() {
  return db.select().from(users).where(eq(users.onboardingState, "COMPLETE"));
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

function isRamadan(): boolean {
  const now = new Date();
  const year = now.getFullYear();
  const RAMADAN: Record<number, [string, string]> = {
    2025: ["2025-03-01", "2025-03-30"],
    2026: ["2026-02-17", "2026-03-18"],
    2027: ["2027-02-06", "2027-03-07"],
    2028: ["2028-01-26", "2028-02-24"],
    2029: ["2029-01-14", "2029-02-12"],
  };
  const range = RAMADAN[year];
  if (!range) return false;
  return now >= new Date(range[0]) && now <= new Date(range[1]);
}

function programmeDaysSince(startDate: Date | null | undefined): number {
  if (!startDate) return 0;
  return Math.floor((Date.now() - new Date(startDate).getTime()) / 86_400_000);
}

// ============================================================
// JOB 1 — MORNING CHECK-IN
// Runs 6am SAST (4am UTC) daily
// ============================================================

cron.schedule("0 4 * * *", async () => {
  console.log("[SCHEDULER] JOB: Morning check-in");
  const clients = await getActiveClients();

  for (const client of clients) {
    try {
      const name = client.name || "champ";
      const phone = client.phoneNumber;

      if (isRamadan()) {
        await sendWhatsApp(phone,
          `Ramadan Mubarak ${name}. Suhoor is your most important meal today — high protein, slow carbs, and water before Fajr. What are you having?`
        );
        continue;
      }

      const yesterdayLogs = await getYesterdayLogs(client.id);

      if (yesterdayLogs.length === 0) {
        await sendWhatsApp(phone,
          `Morning ${name}. Yesterday was a blank slate. Today we fix that. One thing — log your first meal after you eat it. That is it.`
        );
      } else {
        const foodLogged = yesterdayLogs.some(l => l.intent === "FOOD_LOG");
        const stepsLogged = yesterdayLogs.some(l => l.intent === "STEP_LOG");
        const workoutLogged = yesterdayLogs.some(l => (l.messageIn || "").toLowerCase().includes("done"));

        const parts: string[] = [`Morning ${name}.`];
        if (foodLogged) parts.push("Food was tracked yesterday — good.");
        if (stepsLogged) parts.push("Steps logged too.");
        if (workoutLogged) parts.push("Workout done.");
        if (!foodLogged) parts.push(`Protein target is ${client.proteinTarget || 120}g — hit it today.`);
        parts.push("What is your breakfast?");

        await sendWhatsApp(phone, parts.join(" "));
      }
    } catch (err) {
      console.error(`[SCHEDULER] Morning check-in error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 2 — EVENING ACCOUNTABILITY
// Runs 7pm SAST (5pm UTC) daily
// ============================================================

cron.schedule("0 17 * * *", async () => {
  console.log("[SCHEDULER] JOB: Evening accountability");
  const clients = await getActiveClients();

  for (const client of clients) {
    try {
      const name = client.name || "champ";
      const todayLogs = await getTodayLogs(client.id);

      if (todayLogs.length === 0) {
        await sendWhatsApp(client.phoneNumber,
          `${name}, it is 7pm and I have not heard from you today. No judgment. Just tell me one thing — did you train today, yes or no.`
        );
      }
    } catch (err) {
      console.error(`[SCHEDULER] Evening accountability error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 3 — WEEK 3 INTERVENTION
// Runs Monday 6am SAST (Monday 4am UTC)
// ============================================================

cron.schedule("0 4 * * 1", async () => {
  console.log("[SCHEDULER] JOB: Week 3 intervention");
  const clients = await getActiveClients();

  for (const client of clients) {
    try {
      if (client.programmeWeek !== 3) continue;
      const name = client.name || "champ";
      await sendWhatsApp(client.phoneNumber,
        `${name}, you are in week 3. This is where 70 percent of people quit. Not because it is too hard. Because results are not visible yet. They are happening inside. Show up this week. It is the most important week of the programme.`
      );
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
    try {
      const name = client.name || "champ";
      const budget = client.weeklyFoodBudget || "100_300";

      let budgetMsg: string;
      if (budget === "under_50" || budget === "50_100") {
        budgetMsg = `${name}, month end is coming. Your R57 emergency plan — eggs R25, pilchards R12, sugar beans R20. This covers your protein for 4 days. Shop this weekend before the money is gone.`;
      } else if (budget === "100_300") {
        budgetMsg = `${name}, month end approaching. Your R100 week plan — eggs 12 pack R45, pilchards 3 tins R36, cabbage R8, onions R8, pap 2kg R15. Enough for the full week. Shop at Shoprite or Boxer this weekend.`;
      } else {
        budgetMsg = `${name}, month end coming. You have more budget flexibility than most clients — still prioritise protein. Pre-cook chicken, buy oats in bulk, and prep your meals Sunday. Consistency over the month end is what separates people who get results.`;
      }
      await sendWhatsApp(client.phoneNumber, budgetMsg);
    } catch (err) {
      console.error(`[SCHEDULER] Month-end budget error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// JOB 5 — MILESTONE CELEBRATIONS
// Runs 8am SAST (6am UTC) daily
// ============================================================

const MILESTONES: Record<number, (name: string) => string> = {
  7:  (n) => `${n}, one week in. Most people do not make it here. You did. Keep going.`,
  30: (n) => `${n}, 30 days. This is real now. Your body has changed even if you cannot see it yet. Measurements today — chest, waist, hips. Message them to me.`,
  60: (n) => `${n}, 60 days of consistent work. That is rare. Genuinely rare.`,
  90: (n) => `${n}, 90 days. You have built a habit. That is worth more than any weight loss number.`,
};

cron.schedule("0 6 * * *", async () => {
  console.log("[SCHEDULER] JOB: Milestone celebrations");
  const clients = await getActiveClients();

  for (const client of clients) {
    try {
      const days = programmeDaysSince(client.programmeStartDate);
      const message = MILESTONES[days];
      if (!message) continue;
      const name = client.name || "champ";
      await sendWhatsApp(client.phoneNumber, message(name));
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
    try {
      if (!client.lastActiveAt) continue;
      const name = client.name || "champ";
      const silenceMs = now - new Date(client.lastActiveAt).getTime();

      if (silenceMs >= 7 * 24 * HOUR && silenceMs < 7 * 24 * HOUR + 12 * HOUR) {
        await sendWhatsApp(client.phoneNumber,
          `${name}, a week without checking in. Life gets busy — I get it. When you are ready just say Hello and we pick up exactly where we left off. No guilt.`
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
    try {
      const name = client.name || "champ";
      await sendWhatsApp(client.phoneNumber,
        `${name}, weekend is here. This is where most people lose the progress they built Monday to Friday. Two rules only — protein at every meal and one training session before Sunday night. That is it. Everything else is flexible.`
      );
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
    try {
      const name = client.name || "champ";

      // Query all logs for the past 7 days in parallel
      const [chats, workoutEntries, weightEntries] = await Promise.all([
        db.select().from(chatHistory).where(and(eq(chatHistory.userId, client.id), gte(chatHistory.createdAt, weekAgo))),
        db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, weekAgo))),
        db.select().from(weightLogs).where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, weekAgo))).orderBy(asc(weightLogs.loggedAt)),
      ]);

      // No logs at all — send a nudge, not a report
      if (chats.length === 0) {
        await sendWhatsApp(client.phoneNumber,
          `${name}, no logs this week means no data to coach from. This week log at least one meal per day — that is the only focus. Nothing else.`
        );
        continue;
      }

      // Only generate full report if they logged at least 3 times
      const daysWithLogs = new Set(chats.map(c => new Date(c.createdAt!).toDateString())).size;
      if (daysWithLogs < 3) {
        await sendWhatsApp(client.phoneNumber,
          `${name}, ${daysWithLogs} day${daysWithLogs !== 1 ? "s" : ""} logged this week. That is not enough for me to coach you properly. Aim for at least 5 this week — just log one meal a day minimum.`
        );
        continue;
      }

      // Calculate metrics
      const foodLogs = chats.filter(c => c.intent === "FOOD_LOG");
      const foodDays = new Set(foodLogs.map(c => new Date(c.createdAt!).toDateString())).size;
      const plannedSessions = client.trainingDaysPerWeek || 3;
      const completedSessions = workoutEntries.length;
      const weekNum = client.programmeWeek || 1;

      // Weight change
      let weightLine = "Weight: no weigh-ins this week";
      if (weightEntries.length >= 2) {
        const diff = parseFloat(String(weightEntries[weightEntries.length - 1].weight)) - parseFloat(String(weightEntries[0].weight));
        if (diff < -0.1) weightLine = `Weight: down ${Math.abs(diff).toFixed(1)}kg this week`;
        else if (diff > 0.1) weightLine = `Weight: up ${diff.toFixed(1)}kg this week`;
        else weightLine = `Weight: unchanged this week`;
      } else if (weightEntries.length === 1) {
        weightLine = `Weight: ${weightEntries[0].weight}kg logged once — log at start and end of week for accurate tracking`;
      }

      // Best protein meal and worst pattern
      let bestMeal = "";
      let worstPattern = "";
      const PROTEIN_RICH = ["chicken", "eggs", "pilchards", "tuna", "beef", "fish", "beans", "greek yogurt", "cottage cheese", "whey", "steak", "pork", "turkey"];
      const JUNK = ["kfc", "mcdonalds", "nandos", "pizza", "chips", "vetkoek", "kotas", "polony", "vetkoek", "chocolate", "cool drink", "alcohol", "beer", "wine"];
      const proteinMeals = foodLogs.filter(l => PROTEIN_RICH.some(w => (l.messageIn || "").toLowerCase().includes(w)));
      if (proteinMeals.length > 0) bestMeal = (proteinMeals[0].messageIn || "").slice(0, 60);
      const junkCount = foodLogs.filter(l => JUNK.some(w => (l.messageIn || "").toLowerCase().includes(w))).length;
      const noProteinCount = foodLogs.filter(l => !PROTEIN_RICH.some(w => (l.messageIn || "").toLowerCase().includes(w))).length;
      if (junkCount >= 3) worstPattern = `junk food appeared ${junkCount} times this week`;
      else if (noProteinCount >= 3) worstPattern = `${noProteinCount} meals with no protein logged`;
      else if (completedSessions < Math.floor(plannedSessions * 0.5)) worstPattern = `only ${completedSessions} of ${plannedSessions} planned sessions completed`;
      else worstPattern = "no major pattern this week — keep the consistency going";

      // This week focus
      let weekFocus = "";
      if (completedSessions < plannedSessions) weekFocus = `Get ${plannedSessions - completedSessions} missed session${plannedSessions - completedSessions !== 1 ? "s" : ""} done this week — training is non-negotiable`;
      else if (noProteinCount >= 3) weekFocus = "Protein at every single meal this week — eggs, pilchards, chicken, beans";
      else weekFocus = "Maintain what you built — consistency beats intensity every time";

      // Encouragement
      const onTrack = completedSessions >= Math.ceil(plannedSessions * 0.75);
      const encouragement = onTrack
        ? `${name}, ${completedSessions} sessions done this week. That kind of consistency is exactly what builds real results. Same energy this week.`
        : `${name}, this week was below your best — but you are still here and that counts for something. Reset and go again.`;

      const report = `${name} — Week ${weekNum} Report 💪\n\nLogged: ${daysWithLogs} of 7 days\nTraining: ${completedSessions} of ${plannedSessions} sessions completed\n${weightLine}\nBest meal: ${bestMeal || "no high-protein meal logged — fix this week"}\nPattern spotted: ${worstPattern}\n\nThis week focus: ${weekFocus}\n\n${encouragement}`;

      await sendWhatsApp(client.phoneNumber, report);
    } catch (err) {
      console.error(`[SCHEDULER] Sunday report error — ${client.phoneNumber}:`, err);
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
    try {
      const days = programmeDaysSince(client.programmeStartDate);
      const name = client.name || "champ";
      if (days === 1) {
        await sendWhatsApp(client.phoneNumber,
          `${name}, Day 1. Your programme is live and ready.\n\nReply:\n• "today" for your workout\n• "2" to log food\n• "3" to log your steps\n\nOne small action today is better than a perfect week planned and not started.`
        );
      } else if (days === 2) {
        await sendWhatsApp(client.phoneNumber,
          `Day 2, ${name}. How did Day 1 go? Reply DONE if you completed the session, or just tell me what happened. No judgment — just forward.`
        );
      } else if (days === 3) {
        await sendWhatsApp(client.phoneNumber,
          `3 days in, ${name}. Most people have already quit by now. You are still here. That already puts you ahead. Send me today's food and keep the momentum going.`
        );
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
    try {
      const name = client.name || "champ";
      await sendWhatsApp(client.phoneNumber,
        `${name}, it is the 1st. Measurement day.\n\nGet a tape measure and send me:\n\nWaist: Xcm\nHips: Xcm\nChest: Xcm\nArm: Xcm\n\nWeigh in as well. Same conditions — morning, after bathroom, before food. The tape does not lie when the scale does.`
      );
    } catch (err) {
      console.error(`[SCHEDULER] Monthly measurements error — ${client.phoneNumber}:`, err);
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
    try {
      const name = client.name || "champ";
      await sendWhatsApp(client.phoneNumber, eventFn(name));
    } catch (err) {
      console.error(`[SCHEDULER] Cultural event error — ${client.phoneNumber}:`, err);
    }
  }
}, { timezone: "UTC" });

// ============================================================
// INIT EXPORT
// ============================================================

export function initScheduler(): void {
  const ramadanActive = isRamadan();
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
  console.log(`[SCHEDULER]   Ramadan mode         — ${ramadanActive ? "ACTIVE ☪️" : "inactive"}`);
}

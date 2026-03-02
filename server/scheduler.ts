import cron from "node-cron";
import twilio from "twilio";
import { db } from "./db";
import { users, chatHistory, stepLogs } from "../shared/schema";
import { eq, gte, lte, and, lt } from "drizzle-orm";

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
      await sendWhatsApp(client.phoneNumber,
        `${name}, month end is coming. Before the money gets tight — here is your R100 week meal plan that keeps your nutrition on track: Eggs 12 pack R45. Pilchards 3 tins R36. Cabbage R8. Onions R8. Pap 2kg R15. Shop this weekend at Shoprite or Boxer.`
      );
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
// INIT EXPORT
// ============================================================

export function initScheduler(): void {
  const ramadanActive = isRamadan();
  console.log("[SCHEDULER] Proactive coaching jobs active:");
  console.log("[SCHEDULER]   Morning check-in    — daily 6am SAST");
  console.log("[SCHEDULER]   Evening accountability — daily 7pm SAST");
  console.log("[SCHEDULER]   Week 3 intervention — Monday 6am SAST");
  console.log("[SCHEDULER]   Month-end budget     — 20th each month");
  console.log("[SCHEDULER]   Milestone check      — daily 8am SAST");
  console.log("[SCHEDULER]   Silence detection    — every 12 hours");
  console.log("[SCHEDULER]   Friday strategy      — Friday 4pm SAST");
  console.log(`[SCHEDULER]   Ramadan mode         — ${ramadanActive ? "ACTIVE ☪️" : "inactive"}`);
}

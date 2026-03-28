import { type Express } from "express";
import { type Server } from "http";
import { db } from "./db";
import { users, weightLogs, workoutLogs, stepLogs, chatHistory, clothingCheckins, bodyMeasurements, weeklyCheckins, exerciseLogs, progressPhotos } from "../shared/schema";
import { eq, desc, asc, and, gte, lt, sql } from "drizzle-orm";
import OpenAI from "openai";
import twilio from "twilio";
import { SA_FOODS_SEED, type SAFood } from "./foods";
import { COACH_K_SYSTEM } from "./coach-prompt";
import { EQUIPMENT_ALTERNATIVES, FOOD_SUBSTITUTIONS, PORTION_GUIDE, STORE_ADVICE, INJURY_MODIFICATIONS, SUPPLEMENT_GUIDE, detectLanguage, type SALanguage } from "./constants";
import { buildDayWorkout, buildDayWorkoutForType, buildFullProgramme, getKamlifeProgramme, WORKOUT_DONE_RESPONSES, getDayType } from "./programme";
import { askCoachK, selectModel, buildPatternSummary, getSAContextFlags } from "./gpt";
import { calculateTargets } from "./targets";
import { handleOnboarding, getMenuText, getOnboardingMealPlan } from "./onboarding";
import { nutritionAgent, programmingAgent, mindsetAgent, adminAgent, routeToAgent } from "./agents";
import { storeMemory, retrieveMemories } from "./memory";
import { generateVoiceNote, getVoiceFilePath, voiceFileExists } from "./tts";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

// COACH_K_SYSTEM imported from ./coach-prompt

// Programme constants, workout builders, and GPT functions moved to dedicated modules (see imports above)

// ============================================================
// SA FOOD CALORIE ESTIMATES
// ============================================================

const SA_FOOD_CALORIES: Record<string, number> = {
  pap: 350, samp: 300, rice: 200, bread: 80, "brown bread": 70,
  oats: 150, "jungle oats": 150, maltabella: 160, "weet-bix": 130, "all bran": 175, "all-bran": 175, "all bran flakes": 175, "corn flakes": 155, "special k": 155, "coco pops": 165, "froot loops": 165, "pronutro chocolate": 195,
  egg: 70, eggs: 140, pilchards: 180, "tinned tuna": 120,
  chicken: 165, "chicken breast": 165, beef: 250, mince: 300,
  "sugar beans": 200, "baked beans": 120, lentils: 180,
  kota: 900, "fat cake": 400, magwinya: 400, vetkoek: 350,
  "russian sausage": 290, polony: 280, viennas: 250,
  "simba chips": 500, niknaks: 480, "bar one": 230,
  "kfc streetwise 2": 800, kfc: 600, "steers burger": 700,
  "peanut butter": 190, avocado: 160, banana: 90,
  "cool drink": 140, coke: 140, fanta: 130,
  beer: 150, "castle": 150, "black label": 160,
  hennessy: 250, henny: 250, "henry and coke": 350, "henny and coke": 350,
  "sweet potato": 130, butternut: 80, spinach: 20, cabbage: 25,
  "mageu": 180, "mahewu": 180, cremora: 60,
  "green tea": 2, rooibos: 2, "latte": 250, "giant latte": 400,
  creatine: 0, "protein shake": 120,
  "stew": 280, "fatty": 350, "pork": 300,
};

function estimateCalories(message: string): number {
  const lower = message.toLowerCase();
  let total = 0;
  for (const [food, cals] of Object.entries(SA_FOOD_CALORIES)) {
    if (lower.includes(food)) total += cals;
  }
  return total || 400;
}

// ============================================================
// DISPLAY NAME HELPER
// ============================================================

function getDisplayName(user: any): string {
  const INVALID = new Set(["HI", "HEY", "HELLO", "YES", "NO", "OK", "OKAY", "MENU", "HELP", "DONE", "USER", "THERE"]);
  if (!user.name || user.name.length < 2 || INVALID.has((user.name || "").toUpperCase())) return "";
  return user.name;
}




// ============================================================
// GET OR CREATE USER
// ============================================================

async function getOrCreateUser(phone: string): Promise<any> {
  const existing = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
  if (existing.length > 0) {
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.phoneNumber, phone));
    return existing[0];
  }
  const newUsers = await db.insert(users).values({
    phoneNumber: phone,
    subscriptionStatus: "trial",
    onboardingState: "START",
    programmePhase: 1,
    programmeWeek: 1,
    programmeDayInWeek: 1,
    trainingMode: "home",
    stepsTarget: 7000,
    createdAt: new Date(),
    lastActiveAt: new Date(),
  }).returning();
  return newUsers[0];
}


// ============================================================
// ROTATING STEP RESPONSES (no GPT cost for simple logs)
// ============================================================


// ============================================================
// STREAK HELPER — counts consecutive days with step logs
// ============================================================

async function getStepStreak(userId: string): Promise<number> {
  try {
    const logs = await db.select({ loggedAt: stepLogs.loggedAt })
      .from(stepLogs).where(eq(stepLogs.userId, userId))
      .orderBy(desc(stepLogs.loggedAt)).limit(90);
    if (logs.length === 0) return 0;
    const days = new Set<string>();
    for (const log of logs) {
      const d = new Date(log.loggedAt!);
      days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    }
    let streak = 0;
    const checkDate = new Date();
    const todayKey = `${checkDate.getFullYear()}-${checkDate.getMonth()}-${checkDate.getDate()}`;
    if (!days.has(todayKey)) checkDate.setDate(checkDate.getDate() - 1);
    while (true) {
      const key = `${checkDate.getFullYear()}-${checkDate.getMonth()}-${checkDate.getDate()}`;
      if (!days.has(key)) break;
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    }
    return streak;
  } catch { return 0; }
}

// ============================================================
// SA FOOD SCANNER — in-memory match against 40 SA foods
// ============================================================

function scanForSAFoods(msg: string): SAFood[] {
  const lower = msg.toLowerCase();
  const matched: SAFood[] = [];
  for (const food of SA_FOODS_SEED) {
    const allAliases = [food.name.toLowerCase(), ...food.aliases.map(a => a.toLowerCase())];
    if (allAliases.some(alias => lower.includes(alias))) {
      if (!matched.find(f => f.name === food.name)) matched.push(food);
    }
  }
  return matched;
}

// ============================================================
// SLEEP RESPONSES — rotating hardcoded, no GPT
// ============================================================

const SLEEP_RESPONSES_LOW = [
  (h: number) => `${h} hours is not enough. Sleep is when your body burns fat and repairs muscle. Under 7 hours and cortisol spikes — that blocks fat loss directly. Tonight: phone off 30 minutes before bed. Lights off by 9:30pm.`,
  (h: number) => `${h} hours of sleep is below what your body needs to recover. When you undersleep, the next day's training suffers and fat loss slows. One action: set a bedtime alarm for tonight.`,
  (h: number) => `${h} hours is affecting your results more than your diet. Poor sleep raises hunger hormones and tanks motivation. Fix tonight first: no screen 30 minutes before bed.`,
];
const SLEEP_RESPONSES_GOOD = [
  (h: number) => `${h} hours — solid. Your body does its best work between 7 and 9 hours. Recovery is happening. Keep this up and your results will reflect it.`,
  (h: number) => `${h} hours of quality sleep. That is where the fat loss and muscle repair actually happen. Good work — rest is training.`,
];
const SLEEP_RESPONSES_HIGH = [
  (h: number) => `${h} hours is more than enough for recovery. If you are regularly sleeping this much, check your stress levels or iron intake — oversleeping can signal burnout or anaemia. How is your energy when you wake up?`,
];

const STEP_RESPONSES_LOW = [
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps logged — you are ${remaining.toLocaleString()} short of your ${target.toLocaleString()} target. Walk to the shop, take the stairs, park further. Close that gap before bed.`,
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps today. ${remaining.toLocaleString()} more will hit your target. A 15-minute walk is about 1,500 steps — go.`,
  (steps: number, remaining: number, target: number) =>
    `Short day — ${steps.toLocaleString()} steps. Your target is ${target.toLocaleString()}. Set a reminder for an evening walk and hit it before you sleep.`,
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps is a start, not a finish. ${remaining.toLocaleString()} to go. Walk while you talk on the phone. Use every gap.`,
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps logged. Target: ${target.toLocaleString()}. You are ${Math.round((steps / target) * 100)}% there — finish the job tonight.`,
];

const STEP_RESPONSES_GOOD = [
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — almost there. ${(target - steps).toLocaleString()} more to hit target. You are close, do not let it go.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps is solid progress. ${(target - steps).toLocaleString()} away from your ${target.toLocaleString()} target — one more walk and you have it.`,
  (steps: number, target: number) =>
    `Nearly at target — ${steps.toLocaleString()} steps done. Finish line is ${(target - steps).toLocaleString()} steps away. You have come too far not to finish.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — ${Math.round((steps / target) * 100)}% of your target. ${(target - steps).toLocaleString()} steps left. A 10-minute walk finishes this off.`,
  (steps: number, target: number) =>
    `Good movement today — ${steps.toLocaleString()} steps. ${(target - steps).toLocaleString()} more to reach ${target.toLocaleString()}. Walk around the block before bed and it is yours.`,
];

const STEP_RESPONSES_TARGET = [
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — target hit. ✅ This daily discipline is what separates results from excuses. Same again tomorrow.`,
  (steps: number, target: number) =>
    `Target crushed — ${steps.toLocaleString()} steps. ✅ Every step counts toward your fat loss. Do not skip tomorrow.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps done. ✅ Above target and earning it. Your body is changing because you are consistent — keep it up.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — you smashed the ${target.toLocaleString()} target. ✅ Lekker. Same energy tomorrow.`,
  (steps: number, target: number) =>
    `Target done — ${steps.toLocaleString()} steps. ✅ This is what consistency looks like. Log tomorrow and keep the streak going.`,
];

function getStepResponse(steps: number, target: number): string {
  const idx = Math.floor(Date.now() / 86400000) % 5;
  if (steps >= target) {
    return STEP_RESPONSES_TARGET[idx % STEP_RESPONSES_TARGET.length](steps, target);
  } else if (steps >= target * 0.75) {
    return STEP_RESPONSES_GOOD[idx % STEP_RESPONSES_GOOD.length](steps, target);
  }
  const remaining = target - steps;
  return STEP_RESPONSES_LOW[idx % STEP_RESPONSES_LOW.length](steps, remaining, target);
}

// ============================================================
// FOOD PATTERN DETECTION
// ============================================================

const JUNK_WORDS = ["kfc", "kota", "fat cake", "magwinya", "vetkoek", "chips", "niknaks", "cool drink", "coke", "fanta", "hennessy", "henny", "alcohol", "beer", "wine", "chocolate", "sweets", "biscuit", "polony", "viennas", "russian", "steers", "burger", "pizza"];

// Build PROTEIN_WORDS dynamically from SA_FOODS_SEED so expanding the database
// automatically fixes false-positive protein warnings. Any food with >=8g protein
// per 100g OR >=10g protein per typical portion is treated as a protein source.
const PROTEIN_WORDS: string[] = Array.from(new Set([
  ...SA_FOODS_SEED
    .filter(f => f.proteinPer100g >= 8 || f.typicalPortionProtein >= 10)
    .flatMap(f => [f.name.toLowerCase(), ...f.aliases.map((a: string) => a.toLowerCase())]),
  // Extra SA protein keywords users might type that may not exactly match DB entries
  "protein", "shake", "whey", "steak", "braai", "wors", "boerewors",
  "smileys", "mogodu", "tripe", "liver", "walkie talkies", "chicken feet",
  "oxtail", "ox tail", "sosaties", "chesa nyama", "bobotie",
]));

async function checkFoodPatterns(userId: string): Promise<string | null> {
  try {
    const recent = await db.select().from(chatHistory)
      .where(and(eq(chatHistory.userId, userId), eq(chatHistory.intent, "FOOD_LOG")))
      .orderBy(desc(chatHistory.createdAt))
      .limit(5);

    if (recent.length < 3) return null;

    const last3 = recent.slice(0, 3).map(r => (r.messageIn || "").toLowerCase());

    const junkStreak = last3.filter(msg => JUNK_WORDS.some(w => msg.includes(w))).length;
    if (junkStreak >= 3) {
      return `⚠️ *Pattern alert:* Three junk food logs in a row. This is the pattern that blocks results. Next meal: protein + vegetables first, everything else after.`;
    }

    const noProteinStreak = last3.filter(msg => !PROTEIN_WORDS.some(w => msg.includes(w))).length;
    if (noProteinStreak >= 3) {
      return `⚠️ *Protein missing:* Three meals in a row with no protein logged. Your muscle target and fat loss both depend on hitting ${" "}your protein. Eggs, pilchards, or beans — pick one for the next meal.`;
    }

    return null;
  } catch {
    return null;
  }
}

async function getDamageControlNote(userId: string, message: string): Promise<string> {
  const DAMAGE_TRIGGERS = [
    "kfc", "mcdonald", "pizza", "burger", "chips", "vetkoek", "fat cake", "magwinya", "kotas", "pies",
    "cool drink", "coke", "fanta", "sprite", "energy drink", "biscuit", "chocolate", "sweets", "cake",
    "takeaway", "takeout", "junk", "bad meal", "cheat", "splurge", "ate everything", "binge"
  ];
  const lowerMsg = message.toLowerCase();
  const triggerCount = DAMAGE_TRIGGERS.filter(t => lowerMsg.includes(t)).length;
  if (triggerCount < 2) return ""; // Only fire for clear bad-day signals (2+ triggers)
  // Check if we already sent a damage control note today
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const recentDamage = await db.select({ id: chatHistory.id }).from(chatHistory)
    .where(and(eq(chatHistory.userId, userId), eq(chatHistory.intent, "DAMAGE_CONTROL"), gte(chatHistory.createdAt, todayStart)))
    .limit(1);
  if (recentDamage.length > 0) return ""; // Already sent today
  await db.insert(chatHistory).values({ userId, messageIn: "[system]", messageOut: "[damage_control_sent]", intent: "DAMAGE_CONTROL" });
  return `\n\n*Damage control for the next 24 hours:*\nNext meal: lean protein + vegetables only — eggs, chicken, pilchards with cabbage or spinach. No carbs for that one meal. Walk 20 minutes today minimum. Water to 2L. One bad meal is nothing. Back on track right now.`;
}

// ============================================================
// PERFECT DAY DETECTION
// ============================================================

async function checkPerfectDay(userId: string): Promise<string | null> {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [todayWorkouts, todaySteps, todayFood] = await Promise.all([
      db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, userId), gte(workoutLogs.loggedAt, todayStart))).limit(1),
      db.select().from(stepLogs).where(and(eq(stepLogs.userId, userId), gte(stepLogs.loggedAt, todayStart))).limit(1),
      db.select().from(chatHistory).where(and(eq(chatHistory.userId, userId), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart))).limit(1),
    ]);

    if (todayWorkouts.length > 0 && todaySteps.length > 0 && todayFood.length > 0) {
      return `\n\n🏆 *Perfect day!* Workout done. Steps logged. Food tracked. This is what transformation looks like — remember how this feels and repeat it tomorrow.`;
    }
    return null;
  } catch {
    return null;
  }
}

// Onboarding functions moved to ./onboarding (see imports above)

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================

async function handleMessage(phone: string, message: string, mediaUrl?: string, mediaContentType?: string): Promise<string> {
  try {
  const m = message.toLowerCase().trim();

  // ---- ADDITION 6: EMERGENCY / CRISIS DETECTION — before everything ----
  const CRISIS_PHRASES = [
    "want to die", "kill myself", "end it all", "cannot go on", "can't go on",
    "suicidal", "self harm", "self-harm", "cutting myself", "hurting myself",
    "not worth living", "end my life", "no reason to live", "give up on life",
  ];
  if (CRISIS_PHRASES.some(phrase => m.includes(phrase))) {
    const crisisUser = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    const crisisName = crisisUser[0]?.name || "friend";
    const crisisReply = `${crisisName}, I hear you and I am concerned. Please contact SADAG right now — 0800 567 567, free, 24 hours, confidential. Lifeline SA: 0861 322 322. You matter far more than any fitness goal. Reach out to them — they are trained for exactly this moment.`;
    try { await logChat(crisisUser[0]?.id || "unknown", message, crisisReply, "CRISIS"); } catch { }
    // Alert the coach immediately if COACH_ALERT_PHONE is set
    const coachAlertPhone = process.env.COACH_ALERT_PHONE;
    if (coachAlertPhone && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      try {
        const alertClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const fromNum = process.env.TWILIO_WHATSAPP_NUMBER?.startsWith("whatsapp:") ? process.env.TWILIO_WHATSAPP_NUMBER : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
        await alertClient.messages.create({
          from: fromNum,
          to: `whatsapp:${coachAlertPhone}`,
          body: `⚠️ CRISIS ALERT\nClient: ${crisisName} (${phone})\nMessage: "${message.slice(0, 150)}"\n\nThey have been given SADAG 0800 567 567. Please check on this client.`,
        });
        console.log(`[CRISIS] Coach alert sent to ${coachAlertPhone}`);
      } catch (e) { console.error("[CRISIS] Coach alert failed:", e); }
    }
    return crisisReply;
  }

  // ---- DELETE MY DATA (Item 16) — before user lookup ----
  if (/delete my data|forget me|remove my account|popia delete|delete me|erase my data/i.test(m)) {
    const existing = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    if (existing.length === 0) return "No account found for this number.";
    const uid = existing[0].id;
    const name = existing[0].name || "there";
    // Two-step: first confirm
    await db.update(users).set({ awaitingInputType: "delete_confirm" }).where(eq(users.phoneNumber, phone));
    return `${name}, this will permanently delete all your data — workouts, steps, food logs, measurements, weight history, and your profile. This cannot be undone.\n\nReply *DELETE* (in capitals) to confirm, or anything else to cancel.`;
  }

  if (m === "delete") {
    const existing = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
    if (existing.length > 0 && existing[0].awaitingInputType === "delete_confirm") {
      const uid = existing[0].id;
      console.log(`[POPIA DELETE] User ${uid} (${phone}) requested data deletion at ${new Date().toISOString()}`);
      await Promise.all([
        db.delete(chatHistory).where(eq(chatHistory.userId, uid)),
        db.delete(stepLogs).where(eq(stepLogs.userId, uid)),
        db.delete(workoutLogs).where(eq(workoutLogs.userId, uid)),
        db.delete(weightLogs).where(eq(weightLogs.userId, uid)),
        db.delete(weeklyCheckins).where(eq(weeklyCheckins.userId, uid)),
        db.delete(clothingCheckins).where(eq(clothingCheckins.userId, uid)),
        db.delete(bodyMeasurements).where(eq(bodyMeasurements.userId, uid)),
      ]);
      // Nullify PII rather than delete user row (preserves compliance log)
      await db.update(users).set({
        name: null,
        onboardingState: null,
        popiConsent: false,
        awaitingInputType: null,
        currentWeight: null,
        heightCm: null,
        age: null,
        medicalConditions: null,
        injuries: null,
        otherMedicalNotes: null,
        profileNotes: null,
        cancelledAt: new Date(),
      }).where(eq(users.phoneNumber, phone));
      return "Done. All your data has been permanently deleted in compliance with POPIA. If you want to start fresh, just send any message.";
    }
  }

  // ---- FIX 1: RESET — absolute first, before getOrCreateUser, before everything ----
  if (m === "reset") {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    if (existing.length > 0) {
      const uid = existing[0].id;
      await db.delete(chatHistory).where(eq(chatHistory.userId, uid));
      await db.delete(stepLogs).where(eq(stepLogs.userId, uid));
      await db.delete(workoutLogs).where(eq(workoutLogs.userId, uid));
      await db.delete(weightLogs).where(eq(weightLogs.userId, uid));
      await db.delete(weeklyCheckins).where(eq(weeklyCheckins.userId, uid));
      await db.delete(clothingCheckins).where(eq(clothingCheckins.userId, uid));
      await db.delete(bodyMeasurements).where(eq(bodyMeasurements.userId, uid));
      await db.delete(users).where(eq(users.id, uid));
    }
    await db.insert(users).values({
      phoneNumber: phone,
      subscriptionStatus: "trial",
      onboardingState: "WELCOME",
      programmePhase: 1,
      programmeWeek: 1,
      programmeDayInWeek: 1,
      trainingMode: "home",
      stepsTarget: 7000,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
    return "Fresh start. What's your name?";
  }

  const user = await getOrCreateUser(phone);

  // ---- ONBOARDING ----
  const ONBOARDING_DONE = ["COMPLETE", "COMPLETED"];
  if (user.onboardingState && !ONBOARDING_DONE.includes(user.onboardingState)) {
    return handleOnboarding(user, message, phone);
  }

  // ---- POPIA CONSENT GATE (Item 15) — after onboarding, before all else ----
  if (!user.popiConsent) {
    const consentKeywords = ["yes", "agree", "consent", "i agree", "i consent", "ok", "okay", "yebo", "ja", "sure", "accept"];
    if (consentKeywords.some(k => m === k || m.includes(k))) {
      await db.update(users).set({ popiConsent: true, popiConsentAt: new Date() }).where(eq(users.phoneNumber, phone));
      return `Thank you — your consent is recorded. Welcome to KamLife Coach. Type *menu* to see what I can help you with, or just tell me what you ate, your steps, or anything on your mind.`;
    }
    const name = user.name ? `${user.name}, ` : "";
    return `${name}before we continue I need your consent to process your personal health and fitness data.\n\nKamLife Coach stores your weight, food logs, workout records, and health information to give you personalised coaching. This is protected under POPIA (Protection of Personal Information Act).\n\nYour data is:\n- Used only for your coaching\n- Never sold to anyone\n- Deleted on request (reply "delete my data" at any time)\n\nReply *yes* or *agree* to continue. Reply "delete my data" if you would like us to remove all your information.`;
  }

  // ---- AWAITING PROGRAMME ANSWERS — parse "4 days gym" or "3 home" format ----
  if (user.awaitingProgrammeAnswers) {
    const lower = message.toLowerCase();

    // Parse days (required)
    const daysMatch = message.match(/\b([2-6])\b/);
    const trainingDays = daysMatch ? parseInt(daysMatch[1]) : (user.trainingDaysPerWeek || 3);

    // Parse gym or home (required)
    let trainingMode = user.trainingMode || "home";
    if (/\bgym\b/i.test(lower) || /\bat gym\b/i.test(lower) || /\bthe gym\b/i.test(lower)) trainingMode = "gym";
    else if (/\bhome\b/i.test(lower) || /\bat home\b/i.test(lower) || /\bno gym\b/i.test(lower)) trainingMode = "home";

    // Keep existing experience if set, otherwise default to beginner
    let experience = user.trainingExperience || "beginner";
    if (lower.includes("advanced") || lower.includes("2 plus") || lower.includes("2+")) experience = "advanced";
    else if (lower.includes("intermediate") || lower.includes("inter") || lower.includes("on and off")) experience = "intermediate";
    else if (lower.includes("beginner") || lower.includes("never trained") || lower.includes("first time")) experience = "beginner";

    // Keep existing goal if set, otherwise default to fat_loss
    let goalType = user.goalType || "fat_loss";
    if ((lower.includes("muscle") && lower.includes("fat")) || lower.includes("both") || lower.includes("recomp")) goalType = "recomposition";
    else if (lower.includes("muscle") || lower.includes("build") || lower.includes("gain") || lower.includes("bulk")) goalType = "muscle_gain";
    else if (lower.includes("fat") || lower.includes("lose") || lower.includes("cut")) goalType = "fat_loss";

    await db.update(users)
      .set({ trainingDaysPerWeek: trainingDays, trainingExperience: experience, goalType, trainingMode, awaitingProgrammeAnswers: false, programmePhase: 1, programmeWeek: 1, programmeDayInWeek: 1, programmeStartDate: new Date() })
      .where(eq(users.phoneNumber, phone));

    const updatedUser = { ...user, trainingDaysPerWeek: trainingDays, trainingExperience: experience, goalType, trainingMode };
    const programme = buildFullProgramme(updatedUser);
    const modeLabel = trainingMode === "gym" ? "Gym" : "Home";
    const reply = `Sharp. ${trainingDays} days/week. ${modeLabel}. ${experience.charAt(0).toUpperCase() + experience.slice(1)}. Here is your programme.\n\n${programme}`;
    await logChat(user.id, message, reply, "PROGRAMME_DELIVERY");
    return reply;
  }

  // ---- GREETINGS / MENU (direct — no GPT) ----
  const greetings = ["hello", "hi", "hey", "howzit", "hola", "sawubona", "dumela", "heita", "eita", "yo", "sup"];
  if (greetings.some(g => m === g || m === g + " 👋") || m === "menu" || m === "help") {
    return await getMenuText(user);
  }

  // ---- SHOPPING LIST command ----
  if (m === "shopping list" || m === "shoppinglist" || m === "shopping" || m === "shop") {
    const budget = user.weeklyFoodBudget || "100_300";
    const goal = user.goalType || "fat_loss";
    const otherNotes = (user.otherMedicalNotes || "").toLowerCase();
    const noPeanuts = otherNotes.includes("peanut");
    const noFish = otherNotes.includes("fish") || otherNotes.includes("pilchard") || otherNotes.includes("tuna");
    const noDairy = otherNotes.includes("dairy") || otherNotes.includes("milk") || otherNotes.includes("lactose");
    const noGluten = otherNotes.includes("gluten") || otherNotes.includes("coeliac") || otherNotes.includes("wheat");
    const milkItem = goal === "muscle_gain" && !noDairy ? "Full cream milk 1L — R22" : !noDairy ? "Low fat milk 1L — R20" : null;

    if (budget === "under_100") {
      return `*🛒 Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\n${noFish ? "Eggs extra 6 pack — R25" : "Pilchards 3 tins — R36"}\nSugar beans 500g — R20\nCabbage 1 head — R8\nSpinach 1 bunch — R10\nOnions bag — R8\nPap/maize meal 2kg — R15\nSunflower oil 500ml — R10\n\nEstimated total: ≈R152\n\n🛒 Pro tip: Cook a big pot of beans Sunday — feeds you 3 days at under R7 per serving. Add 1 egg per bowl for complete protein.`;
    }
    if (budget === "100_300") {
      return `*🛒 Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\nFrozen chicken portions 1kg — R40\n${noFish ? "" : "Pilchards 3 tins — R36\n"}Oats 500g — R15\n${noGluten ? "" : "Brown bread 1 loaf — R14\n"}Sweet potato 1kg — R12\nCabbage — R8\nSpinach — R10\nOnions + tomatoes — R23\nGarlic — R8\nSunflower oil — R10\n\nEstimated total: ≈R221\n\n🛒 Pro tip: Buy a whole frozen chicken, cut it yourself — saves R15–R20 per kg vs portions.`;
    }
    if (budget === "300_600") {
      return `*🛒 Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\nFrozen chicken 1.5kg — R60\nBeef mince 500g — R60\n${noFish ? "" : "Pilchards 2 tins — R24\n"}Oats 1kg — R25\nBrown rice 1kg — R20\nSweet potato 1.5kg — R18\nBanana bunch — R15\n${milkItem ? milkItem + "\n" : ""}${noPeanuts ? "" : "Peanut butter 400g — R25\n"}Spinach — R10\nCabbage — R8\nTomatoes 500g — R15\n${noDairy ? "" : "Cottage cheese 250g — R20\n"}Garlic + lemon — R13\n\nEstimated total: ≈R378\n\n🛒 Pro tip: Brown 500g mince Sunday, split into 3 — that's 3 dinners sorted in one 20-min cook.`;
    }
    return `*🛒 Your Weekly Shopping List — Shoprite or Boxer*\nEggs 12 pack — R45\nChicken breast 1kg — R80\n${noFish ? "" : "Salmon 400g ×2 — R160\n"}Beef mince 500g — R60\n${noDairy ? "" : "Low fat Greek yoghurt 500g — R35\n"}Oats 1kg — R25\nBrown rice 1kg — R20\nSweet potato 2kg — R24\nBanana bunch — R15\n${noPeanuts ? "" : "Peanut butter 400g — R25\n"}Broccoli — R20\nSpinach — R10\n${noDairy ? "" : "Low fat milk 1L — R20\n"}Almonds 100g — R40\nOlive oil 250ml — R40\n\nEstimated total: ≈R619\n\n🛒 Pro tip: Salmon goes on special at Shoprite most Fridays — buy two packs and freeze immediately.`;
  }

  // ---- WHY command ----
  if (m === "why") {
    const goal = user.goalType || "fat_loss";
    const budget = user.weeklyFoodBudget || "100_300";
    const medicals = (user.medicalConditions || "").split(",").map((s: string) => s.trim());
    const isDiabetic = medicals.includes("diabetes");
    const isPCOS = medicals.includes("pcos");
    const isHypertension = medicals.includes("hypertension");
    const otherNotes = (user.otherMedicalNotes || "").toLowerCase();
    const noPeanuts = otherNotes.includes("peanut");
    const noFish = otherNotes.includes("fish") || otherNotes.includes("pilchard");

    const goalReasons: Record<string, string> = {
      fat_loss: `High protein keeps your muscle while you lose fat — your body wants to eat muscle first when in a deficit, protein stops that. Sweet potato over white pap because the lower glycaemic index means slower energy release and less insulin spike — less fat storage. High-volume vegetables fill your stomach without filling your calorie budget.`,
      muscle_gain: `Whole eggs because the yolk contains cholesterol your body uses to make testosterone — the hormone that builds muscle. Higher calorie density means your muscles have surplus energy to grow. Pre and post-workout meals are non-negotiable — carbs fuel the session, protein rebuilds what you broke.`,
      recomposition: `Carb timing is everything in recomp — carbs before training fuel performance, carbs after training go straight into muscle recovery. Evening low-carb means lower insulin at night when you are least active. Consistent high protein means your body always has amino acids available for repair.`,
      general: `Balanced whole food eating — real protein, real carbs, real vegetables. No extreme restrictions means you can eat like this for life. Educate portions rather than eliminate foods.`,
      health_condition: `Every food choice supports your specific health condition. Lower GI foods mean more stable blood sugar. Higher fibre keeps cholesterol and blood pressure in range. Consistent meal timing is as important as the food itself.`,
    };
    let why = goalReasons[goal] || goalReasons.general;

    const extras: string[] = [];
    if (isDiabetic || isPCOS) extras.push(`Low GI carbs (samp, oats, sweet potato, brown rice) mean slower glucose release — more stable blood sugar across the day. This is non-negotiable for your condition.`);
    if (isHypertension) extras.push(`No Aromat, no stock cubes, no processed meats because sodium directly raises blood pressure. Potassium from sweet potato, spinach, and banana actively counteracts sodium's effect on your vessels.`);
    if (noPeanuts) extras.push(`Peanut butter replaced with extra eggs or baked beans — same protein, safe for your allergy.`);
    if (noFish) extras.push(`Pilchards replaced with chicken and eggs — chicken thigh especially is a high protein-to-cost protein for your budget.`);

    const budgetReasons: Record<string, string> = {
      under_100: `Every item was chosen for maximum nutrition per rand — eggs and pilchards are the highest protein-per-rand foods in South Africa. Sugar beans give cheap fibre and protein that stretch across multiple meals.`,
      "100_300": `Frozen chicken and eggs are your protein anchors at this budget. Oats and sweet potato give you slow-burning carbs that cost very little. The whole week's food costs under R250 and covers all your nutritional needs.`,
      "300_600": `This budget lets you rotate proteins — chicken, mince, eggs, pilchards — so you never get bored and never get gaps in your nutrition. Mince is the best value red meat in SA.`,
      over_600: `Salmon twice a week gives you omega-3 fatty acids that reduce inflammation — critical for recovery and long-term health. Greek yoghurt is one of the highest protein dairy foods per gram.`,
    };
    const budgetWhy = budgetReasons[budget] || budgetReasons["100_300"];

    return `*Why these specific foods for you:*\n\n${why}\n\n${budgetWhy}${extras.length > 0 ? "\n\n" + extras.join("\n\n") : ""}`;
  }

  // ---- MEAL PLAN re-delivery ----
  if (["meal plan", "mealplan", "food plan", "my meal plan", "my food plan", "diet plan", "diet", "my diet", "nutrition plan", "eating plan", "weekly meals", "weekly meal plan", "my nutrition plan", "my eating plan", "what should i eat", "what do i eat"].includes(m) || /\b(diet plan|eating plan|nutrition plan|weekly meal|food plan)\b/i.test(m)) {
    return getOnboardingMealPlan(user);
  }

  // ---- SWAP [day] command ----
  const swapMatch = m.match(/^swap\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i);
  if (swapMatch) {
    const swapDay = swapMatch[1].charAt(0).toUpperCase() + swapMatch[1].slice(1).toLowerCase();
    const budget = user.weeklyFoodBudget || "100_300";
    const goal = user.goalType || "fat_loss";
    const otherNotes = (user.otherMedicalNotes || "").toLowerCase();
    const noFish = otherNotes.includes("fish") || otherNotes.includes("pilchard") || otherNotes.includes("tuna");
    const noDairy = otherNotes.includes("dairy") || otherNotes.includes("milk") || otherNotes.includes("lactose");
    const noPeanuts = otherNotes.includes("peanut");
    const medicals = (user.medicalConditions || "").split(",").map((s: string) => s.trim());
    const isLowGI = medicals.includes("diabetes") || medicals.includes("pcos");
    const bfCal = Math.round((user.calorieTarget || 1800) * 0.25);
    const lunchCal = Math.round((user.calorieTarget || 1800) * 0.35);
    const dinnerCal = Math.round((user.calorieTarget || 1800) * 0.28);
    const carbAlt = isLowGI ? "½ cup samp and beans" : goal === "muscle_gain" ? "1 cup brown rice" : "1 medium sweet potato";
    const protAlt = noFish ? (budget === "under_100" ? "3 boiled eggs" : "150g chicken thigh") : (budget === "under_100" ? "1 tin pilchards" : "2 eggs + baked beans");
    const dairySnack = noDairy ? "baked beans ½ tin — 110 cal, 7g protein" : "low fat yoghurt 150g — 100 cal, 10g protein";
    const pbItem = noPeanuts ? "1 extra boiled egg" : "1 tbsp peanut butter";

    return `*${swapDay} — Alternative Meals*\n\nBreakfast: ${isLowGI ? `½ cup oats + ${noDairy ? "water" : "low fat milk"} + 2 boiled eggs` : goal === "muscle_gain" ? `3 eggs scrambled + 1 cup oats + banana` : `${isLowGI ? "samp and beans ½ cup" : "½ cup oats"} + 2 boiled eggs`} — ${bfCal} cal\n\nLunch: ${protAlt} + ${carbAlt} + spinach — ${lunchCal} cal\n\nSnack: ${goal === "muscle_gain" ? `${pbItem} + banana` : dairySnack}\n\nDinner: ${noFish ? "2 eggs + cabbage" : "½ tin pilchards + cabbage"} — ${dinnerCal} cal\n\nReply SWAP [any other day] to swap another day.`;
  }

  // ---- MEDIA: IMAGE or AUDIO — exclusive branches, always return ----
  if (mediaUrl) {
    const ctype = mediaContentType || "";

    // ---- PROGRESS PHOTO or FOOD PHOTO ----
    if (ctype.startsWith("image/")) {
      try {
        // Image endpoint on Twilio is public (no auth needed), but use same pattern for consistency
        const imageResponse = await fetch(mediaUrl);
        const buffer = await imageResponse.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
        const clientName = user.name || "there";
        const goal = user.goalType || "fat_loss";

        // ---- PROGRESS PHOTO DETECTION ----
        // If the message contains progress-related keywords, store and optionally compare
        const isProgressPhoto = /\b(progress|transformation|check.?in|monthly|before|after|month \d|week \d+)\b/i.test(message);
        if (isProgressPhoto) {
          // Get existing progress photos for this client (most recent first)
          const existingPhotos = await db.select()
            .from(progressPhotos)
            .where(eq(progressPhotos.userId, user.id))
            .orderBy(asc(progressPhotos.loggedAt))
            .limit(10);

          const photoNumber = existingPhotos.length + 1;

          // Store this photo
          await db.insert(progressPhotos).values({
            userId: user.id,
            photoNumber,
            photoBase64: base64,
            contentType,
          });

          await logChat(user.id, `[Progress Photo ${photoNumber}]`, "", "PROGRESS_PHOTO");

          // If this is a second or later photo — compare with the first
          if (existingPhotos.length >= 1) {
            const firstPhoto = existingPhotos[0];
            const daysBetween = Math.round(
              (Date.now() - new Date(firstPhoto.loggedAt || "").getTime()) / 86_400_000
            );
            const comparisonResponse = await openai.chat.completions.create({
              model: "gpt-4o",
              max_tokens: 400,
              messages: [
                {
                  role: "system",
                  content: `You are Coach K, a South African fitness and nutrition coach with 20 years experience. The client's name is ${clientName}. Their goal is ${goal}. SA voice — direct, warm, specific. Max 4 sentences. Focus on visible physical changes only — posture, muscle definition, body shape. Never discuss weight unless you can see a scale. Be honest and specific. Never say "great progress" as a standalone — describe what you actually see. End with one specific observation about what to focus on next.`,
                },
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: `Compare these two progress photos. Photo 1 was taken ${daysBetween} days ago (${Math.round(daysBetween / 7)} weeks). Photo 2 is today. Describe specifically what has changed in the body. Focus on: body composition, posture, visible muscle, waist and hip shape. Be honest — if nothing has changed say so and say why. If it has — describe exactly what you see.`,
                    },
                    { type: "image_url", image_url: { url: `data:${firstPhoto.contentType};base64,${firstPhoto.photoBase64}` } },
                    { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } },
                  ],
                },
              ],
            });
            const comparisonText = comparisonResponse.choices[0]?.message?.content?.trim()
              || "I can see both photos but could not compare them clearly. Send them in better lighting.";
            await logChat(user.id, `[Progress Photo ${photoNumber}]`, comparisonText, "PROGRESS_COMPARISON");
            return `Progress photo ${photoNumber} saved — ${daysBetween} days since photo 1.\n\n${comparisonText}`;
          } else {
            // First progress photo stored — acknowledge and tell them when to send the next
            return `Progress photo 1 saved, ${clientName}. Send your next progress photo in 30 days and I will compare them side by side and tell you exactly what changed.`;
          }
        }

        // ---- FOOD PHOTO continues below ----
        const { calorieTarget: liveCal, proteinTarget: liveProt } = calculateTargets(
          parseFloat(user.currentWeight || "75"), goal, user.lifeSituation || "office", user.trainingDaysPerWeek || 3
        );
        const visionResponse = await openai.chat.completions.create({
          model: "gpt-4o",
          max_tokens: 400,
          messages: [
            {
              role: "system",
              content: `You are Coach K, a South African fitness and nutrition coach with 20 years experience. Client: ${clientName}. Goal: ${goal}. Daily targets: ${liveCal} kcal and ${liveProt}g protein. SA voice — direct, warm, specific. Never generic. Max 3 sentences. End with exactly one specific action. Never say "Reply MENU". Never say "I hope this helps".`,
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Analyse this food photo as Coach K.

IDENTIFICATION: Always use SA names — pap not polenta, pilchards not sardines, vetkoek not fried dough, morogo not wild spinach, umngqusho not samp-and-beans, kota not bunny chow, magwinya not fat cake, smileys not sheep head, walkie talkies not chicken feet, mogodu not tripe, chakalaka not relish, boerewors not sausage, biltong not dried meat.

ESTIMATION: State specific calories and protein for the FULL plate as actually served. Format: "That plate is roughly 650 kcal and 35g protein." Then immediately say how that leaves them against their ${liveCal} kcal and ${liveProt}g protein daily target. Example: "That leaves 1,150 kcal and 85g protein for the rest of the day."

COACHING: One sentence on whether this meal works for their ${goal} goal. If good — say exactly why. If not — give ONE specific SA food swap, not a list.

UNKNOWN FOOD: If you cannot identify the food in the image — respond only with: Eish, I cannot make out the food clearly. Take the photo in better light and send again.`,
                },
                { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } },
              ],
            },
          ],
        });

        const visionReply = visionResponse.choices[0]?.message?.content?.trim();
        if (!visionReply || visionReply.length < 10) {
          return "Eish, I cannot make out the food clearly. Take the photo in better light and send again.";
        }
        await logChat(user.id, "[Photo]", visionReply, "FOOD_LOG");
        const [photoPattern, photoDay] = await Promise.all([checkFoodPatterns(user.id), checkPerfectDay(user.id)]);
        // Append daily running total
        let photoDailyTotal = "";
        try {
          const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
          const todayFoodLogs = await db.select({ messageIn: chatHistory.messageIn })
            .from(chatHistory)
            .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)));
          let totalCal = 0; let totalProt = 0;
          for (const log of todayFoodLogs) {
            const matched = scanForSAFoods(log.messageIn || "");
            totalCal += matched.reduce((s: number, f: any) => s + (f.calories || 0), 0);
            totalProt += matched.reduce((s: number, f: any) => s + (f.protein || 0), 0);
          }
          const calTarget = user.calorieTarget || 1800;
          const protTarget = user.proteinTarget || 130;
          if (totalCal > 0) {
            const remaining = calTarget - totalCal;
            photoDailyTotal = `\n\n_Today so far: ~${totalCal} kcal | ${totalProt}g protein. Target: ${calTarget} kcal | ${protTarget}g protein.${remaining > 100 ? ` ${remaining} kcal remaining.` : " On target."}_`;
          }
        } catch { /* non-fatal */ }
        return `${visionReply}${photoPattern ? "\n\n" + photoPattern : ""}${photoDay || ""}${photoDailyTotal}`;
      } catch (err) {
        console.error("Vision error:", err);
        return "I can see your food photo. To get full nutritional coaching on your meals add your OpenAI API key. For now tell me what you ate in text and I will coach you on it.";
      }
    }

    // ---- VOICE NOTE ----
    // Exclusive: if audio, always return — never falls through to text handler
    if (ctype.startsWith("audio/")) {
      try {
        // Part 1 — Twilio media requires basic auth (ACCOUNT_SID:AUTH_TOKEN)
        const twilioSid = process.env.TWILIO_ACCOUNT_SID || "";
        const twilioToken = process.env.TWILIO_AUTH_TOKEN || "";
        const authHeader = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");

        const audioResponse = await fetch(mediaUrl, {
          headers: { Authorization: authHeader },
        });

        if (!audioResponse.ok) {
          console.error(`[VOICE] Twilio download failed: ${audioResponse.status} ${audioResponse.statusText}`);
          return "I received your voice note. Voice coaching needs the OpenAI API key active. For now type what you want to tell me and I will respond immediately.";
        }

        const audioBuffer = await audioResponse.arrayBuffer();

        // Part 2 — WhatsApp voice notes are always ogg/opus; use fixed mime type for Whisper
        const audioFile = new File([audioBuffer], "audio.ogg", { type: "audio/ogg" });

        const transcription = await openai.audio.transcriptions.create({
          file: audioFile,
          model: "whisper-1",
        });

        const transcribedText = transcription.text?.trim();

        // Part 3 — Handle result
        if (!transcribedText) {
          return "I could not hear that clearly. Try sending a voice note in a quieter spot or type your message.";
        }

        const wordCount = transcribedText.split(/\s+/).filter(Boolean).length;
        if (wordCount < 3) {
          return `I only caught a few words — ${transcribedText}. Send again or type your message.`;
        }

        // Language detection (Zulu, Sotho, Xhosa, Afrikaans keywords)
        const ZULU_WORDS = ["sawubona", "yebo", "ngiyabonga", "unjani", "siyabonga", "hawu", "eish", "askies"];
        const SOTHO_WORDS = ["dumela", "ke a leboga", "o kae", "kea leboha", "ntate", "mme"];
        const XHOSA_WORDS = ["molo", "enkosi", "unjani", "ewe", "hayi", "camagu", "ndiyabona"];
        const AFRIKAANS_WORDS = ["dankie", "asseblief", "môre", "more", "lekker", "braai", "howzit", "baie", "nee", "ja nee", "ag nee", "eina", "ek is", "ek het", "ons het"];
        const lowerTranscribed = transcribedText.toLowerCase();
        let languageNote = "";
        if (ZULU_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Zulu. Respond in simple SA English but acknowledge their language naturally — you may use a word or two of Zulu if it fits.";
        else if (SOTHO_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Sesotho. Respond in simple SA English but acknowledge their language naturally.";
        else if (XHOSA_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Xhosa. Respond in simple SA English but acknowledge their language naturally.";
        else if (AFRIKAANS_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Afrikaans. Respond in simple SA English but acknowledge their language naturally — you may use a word or two of Afrikaans if it fits.";

        console.log(`[VOICE] Transcribed: "${transcribedText}"${languageNote ? " [" + languageNote.split(".")[0] + "]" : ""}`);

        const voiceReply = await handleMessage(phone, transcribedText + (languageNote ? `\n\n[LANGUAGE NOTE: ${languageNote}]` : ""));
        // Part 4 — explicit return, no fall-through
        return `🎤 I heard: "${transcribedText}"\n\n${voiceReply}`;

      } catch (err) {
        console.error("[VOICE] Transcription error:", err);
        // Part 4 — always return, never fall through to text handler
        return "I received your voice note. Voice coaching needs the OpenAI API key active. For now type what you want to tell me and I will respond immediately.";
      }
    }

    // If mediaUrl present but content type is neither image nor audio — return without processing text
    console.log(`[MEDIA] Unhandled content type: ${ctype} — ignoring`);
    return "I received your file but I can only process voice notes and food photos. Send those or type your message.";
  }


  // ---- DONE — workout complete (direct) ----
  if (m === "done" || m === "workout done" || m === "finished" || m === "completed") {
    const newTotal = (user.totalWorkoutsCompleted || 0) + 1;
    let newDay = (user.programmeDayInWeek || 1) + 1;
    let newWeek = user.programmeWeek || 1;
    const daysPerWeek = user.trainingDaysPerWeek || 3;

    if (newDay > daysPerWeek) { newDay = 1; newWeek++; }
    if (newWeek > 4) { newWeek = 4; }

    // Workout streak — continues if last session was within 2 days
    const lastW = user.lastWorkoutDate ? new Date(user.lastWorkoutDate) : null;
    const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
    let newStreak = 1;
    if (lastW) {
      const lastDay = new Date(lastW); lastDay.setHours(0, 0, 0, 0);
      const daysDiff = Math.floor((todayMidnight.getTime() - lastDay.getTime()) / 86400000);
      if (daysDiff <= 2) newStreak = (user.workoutStreak || 0) + 1;
    }

    await db.update(users).set({
      totalWorkoutsCompleted: newTotal,
      lastWorkoutDate: new Date(),
      programmeDayInWeek: newDay,
      programmeWeek: newWeek,
      workoutStreak: newStreak,
    }).where(eq(users.phoneNumber, phone));

    await db.insert(workoutLogs).values({ userId: user.id, workoutCompleted: true });

    // Store win memory at streak and total milestones
    try {
      if ([5, 10, 20, 30, 50].includes(newStreak)) {
        await storeMemory(phone, `Workout streak milestone: ${newStreak} sessions in a row without missing`, "milestone");
      }
      if ([10, 25, 50, 100].includes(newTotal)) {
        await storeMemory(phone, `Workout total milestone: completed ${newTotal} training sessions total with Coach K`, "milestone");
      }
    } catch { /* non-fatal */ }

    const celebrationFn = WORKOUT_DONE_RESPONSES[newTotal % WORKOUT_DONE_RESPONSES.length];
    const celebration = celebrationFn(newTotal, newDay);
    const perfectDay = await checkPerfectDay(user.id);

    // Auto-generate referral code at first milestone if not set
    if (!user.referralCode && [10, 25, 50].includes(newTotal)) {
      const namePrefix = (user.name || "KAM").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "K");
      const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString();
      const newCode = `${namePrefix}${randomSuffix}`;
      await db.update(users).set({ referralCode: newCode }).where(eq(users.phoneNumber, phone));
      user.referralCode = newCode;
    }
    const refCode = user.referralCode;

    const clientFirstName = user.name || "there";
    const milestoneVoiceTexts: Record<number, string> = {
      25:  `${clientFirstName}, 25 workouts. A quarter century of sessions. You are not talking about fitness anymore. You are doing it.`,
      50:  `${clientFirstName}, 50 sessions. Fifty times you chose to show up when you could have stayed home. That is not motivation. That is discipline. Lekker work.`,
      100: `${clientFirstName}, one hundred workouts with Coach K. That number puts you in a category most people never reach. Whatever happens next — you earned this.`,
    };

    const milestoneNote = newTotal === 1
      ? "\n\n🏆 *First workout done.* Most people only talk about starting. You started. Screenshot this."
      : newTotal === 10
        ? `\n\n🔥 *10 sessions with Coach K.* You are past the hardest part.${refCode ? ` Share code *${refCode}* with someone who needs to start — they get their first month for R50.` : " Send this to someone who said you would quit."}`
        : newTotal === 25
          ? `\n\n💪 *25 sessions completed.* A month of real work. This is a lifestyle now.${refCode ? ` Your referral code is *${refCode}* — share it with one person today.` : " Share your progress — you earned it."}`
          : newTotal === 50
            ? `\n\n🏆 *50 workouts done.* Half a century of sessions.${refCode ? ` Code *${refCode}* — put this number and your code in your family WhatsApp group.` : " Put this in your family WhatsApp group. Genuinely rare."}`
            : newTotal === 100
              ? "\n\n🎯 *100 SESSIONS WITH COACH K.* Most people never reach 10. You hit 100. Share this."
              : "";

    // Send voice note for major milestones — fire and forget, does not block the text response
    const voiceText = milestoneVoiceTexts[newTotal];
    if (voiceText) {
      generateVoiceNote(voiceText).then(voiceUrl => {
        if (!voiceUrl) return;
        const fromNum = (process.env.TWILIO_WHATSAPP_NUMBER || "").startsWith("whatsapp:")
          ? process.env.TWILIO_WHATSAPP_NUMBER!
          : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
        const tc = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        tc.messages.create({ from: fromNum, to: phone, body: "🎙", mediaUrl: [voiceUrl] })
          .catch(err => console.error("[TTS] Milestone voice send error:", err));
      });
    }

    const streakLine = newStreak >= 30 ? `\n\n🔥 *${newStreak}-session streak. This is who you are now.*`
      : newStreak >= 14 ? `\n\n🔥 *${newStreak} sessions straight. Don't stop.*`
      : newStreak >= 7 ? `\n\n🔥 *7-session streak.* You are building a habit.`
      : newStreak >= 3 ? `\n\n🔥 Streak: ${newStreak}. Keep it going.`
      : "";
    return `${celebration}${milestoneNote}${streakLine}\n\n✅ Workout ${newTotal} logged.${perfectDay || ""}`;
  }

  // ---- MY LIFTS — show all personal bests ----
  if (["my lifts", "my weights", "lifts", "personal best", "pb", "my pbs", "my records", "exercise log"].includes(m)) {
    try {
      const allLifts = await db.select().from(exerciseLogs)
        .where(eq(exerciseLogs.userId, user.id))
        .orderBy(desc(exerciseLogs.loggedAt));
      if (allLifts.length === 0) {
        return `No lifts logged yet. After a gym session send something like "bench 60kg 3x10" and I track your progress week to week.`;
      }
      // Group by exercise, keep most recent + all-time best
      const byExercise: Record<string, { recent: any; best: any }> = {};
      for (const lift of allLifts) {
        const ex = lift.exerciseName;
        if (!byExercise[ex]) byExercise[ex] = { recent: lift, best: lift };
        const liftWeight = parseFloat(String(lift.weightKg || 0));
        const bestWeight = parseFloat(String(byExercise[ex].best.weightKg || 0));
        if (liftWeight > bestWeight) byExercise[ex].best = lift;
      }
      const lines = Object.entries(byExercise).map(([ex, { recent, best }]) => {
        const recentW = parseFloat(String(recent.weightKg || 0));
        const bestW = parseFloat(String(best.weightKg || 0));
        const repsStr = recent.reps ? ` × ${recent.sets || 3}×${recent.reps}` : "";
        const pbStr = bestW > recentW ? ` (PB: ${bestW}kg)` : " 🏆 PB";
        return `• ${ex}: ${recentW}kg${repsStr}${pbStr}`;
      });
      const liftsReply = `*Your Lifts — Most Recent*\n\n${lines.join("\n")}\n\nTo log a lift: "bench 80kg 3x8", "squat 100kg x5", "deadlift 120kg"`;
      await logChat(user.id, message, liftsReply, "LIFTS_VIEW");
      return liftsReply;
    } catch (e) {
      console.error("[MY_LIFTS]", e);
      return `Log your lifts like this: "bench 60kg 3x10" and I track your progress.`;
    }
  }

  // ---- EXERCISE WEIGHT LOG — "bench 60kg 3x10", "squatted 80kg", "deadlift 120kg x5" ----
  const EXERCISE_DETECT = /\b(bench|chest press|squat|deadlift|dead lift|rdl|romanian|leg press|shoulder press|overhead press|ohp|military press|lat pulldown|pulldown|seated row|cable row|barbell row|bent over row|pull.?up|chin.?up|dip|hip thrust|glute bridge|leg curl|hamstring curl|leg extension|bicep curl|barbell curl|dumbbell curl|tricep|chest fly|cable fly|face pull|goblet squat|bulgarian|split squat|lunge|row)\b/i;
  const WEIGHT_KG = /\b(\d+(?:\.\d+)?)\s*kg\b/i;
  const isExerciseLog = EXERCISE_DETECT.test(m) && WEIGHT_KG.test(m) && user.trainingMode !== "walk_only";

  if (isExerciseLog) {
    // Normalise exercise name
    const EXERCISE_MAP: Record<string, string> = {
      bench: "Bench Press", "chest press": "Bench Press",
      squat: "Squat", squatted: "Squat", squats: "Squat", "barbell squat": "Squat", "goblet squat": "Goblet Squat",
      deadlift: "Deadlift", "dead lift": "Deadlift",
      rdl: "Romanian Deadlift", romanian: "Romanian Deadlift",
      "leg press": "Leg Press",
      "shoulder press": "Shoulder Press", "overhead press": "Shoulder Press", ohp: "Shoulder Press", "military press": "Shoulder Press",
      "lat pulldown": "Lat Pulldown", pulldown: "Lat Pulldown",
      "seated row": "Seated Row", "cable row": "Seated Row",
      "barbell row": "Barbell Row", "bent over row": "Barbell Row",
      "pull up": "Pull Up", pullup: "Pull Up", "pull-up": "Pull Up",
      "chin up": "Chin Up", chinup: "Chin Up", "chin-up": "Chin Up",
      dip: "Weighted Dip",
      "hip thrust": "Hip Thrust", "glute bridge": "Glute Bridge",
      "leg curl": "Leg Curl", "hamstring curl": "Leg Curl",
      "leg extension": "Leg Extension",
      "bicep curl": "Bicep Curl", "barbell curl": "Bicep Curl", "dumbbell curl": "Bicep Curl", curl: "Bicep Curl",
      tricep: "Tricep Pushdown", "tricep pushdown": "Tricep Pushdown", "tricep extension": "Tricep Pushdown",
      "chest fly": "Chest Fly", "cable fly": "Chest Fly",
      "face pull": "Face Pull",
      bulgarian: "Bulgarian Split Squat", "split squat": "Bulgarian Split Squat",
      lunge: "Lunge", row: "Seated Row",
    };
    let exerciseName = "Exercise";
    for (const [key, val] of Object.entries(EXERCISE_MAP)) {
      if (m.includes(key)) { exerciseName = val; break; }
    }

    const weightMatch = m.match(/\b(\d+(?:\.\d+)?)\s*kg\b/i);
    const weightKg = weightMatch ? parseFloat(weightMatch[1]) : 0;
    if (!weightKg) { /* fall through to GPT */ } else {

    // Parse optional reps and sets: "3x10", "3 sets 10 reps", "x10", "10 reps"
    const setsRepsMatch = m.match(/\b(\d+)\s*[x×]\s*(\d+)\b/i) || m.match(/(\d+)\s*sets?\s*(?:of\s*)?(\d+)\s*reps?/i);
    const repsOnlyMatch = m.match(/\b[x×]\s*(\d+)\b/i) || m.match(/\b(\d+)\s*reps?\b/i);
    let sets: number | null = null;
    let reps: number | null = null;
    if (setsRepsMatch) { sets = parseInt(setsRepsMatch[1]); reps = parseInt(setsRepsMatch[2]); }
    else if (repsOnlyMatch) { reps = parseInt(repsOnlyMatch[1]); }

    // Fetch previous log for this exercise
    const prevLogs = await db.select().from(exerciseLogs)
      .where(and(eq(exerciseLogs.userId, user.id), eq(exerciseLogs.exerciseName, exerciseName)))
      .orderBy(desc(exerciseLogs.loggedAt))
      .limit(5);

    // Save new log
    try {
      await db.insert(exerciseLogs).values({ userId: user.id, exerciseName, weightKg: weightKg.toString(), reps: reps ?? undefined, sets: sets ?? undefined });
    } catch (e) { console.error("[EXERCISE_LOG]", e); }

    // Build response
    const repsStr = sets && reps ? ` ${sets}×${reps}` : reps ? ` ×${reps}` : "";
    let liftReply = "";
    if (prevLogs.length === 0) {
      liftReply = `${exerciseName} ${weightKg}kg${repsStr} logged. Baseline set — every session from here we track against this number. Add reps before adding weight. When you hit ${sets || 3}×${(reps || 10) + 2}, bump the weight by 2.5kg.`;
    } else {
      const prevWeight = parseFloat(String(prevLogs[0].weightKg || 0));
      const allTimeBest = Math.max(...prevLogs.map(l => parseFloat(String(l.weightKg || 0))));
      if (weightKg > allTimeBest) {
        liftReply = `🏆 *New PB — ${exerciseName} ${weightKg}kg${repsStr}.* Previous best was ${allTimeBest}kg. That is progressive overload working exactly as it should. Next session: hit the same weight for more reps before going heavier.`;
      } else if (weightKg > prevWeight) {
        liftReply = `${exerciseName} ${weightKg}kg${repsStr} — up ${(weightKg - prevWeight).toFixed(1)}kg from last time (${prevWeight}kg). Progressive overload on track. Keep adding reps at this weight until you can do ${(reps || 10) + 2} clean, then go heavier.`;
      } else if (weightKg === prevWeight) {
        liftReply = `${exerciseName} ${weightKg}kg${repsStr} logged. Same weight as last session — good. Focus on adding 1–2 reps today. When you hit ${sets || 3}×${(reps || 10) + 2} clean, add 2.5kg next session.`;
      } else {
        liftReply = `${exerciseName} ${weightKg}kg${repsStr} logged — ${(prevWeight - weightKg).toFixed(1)}kg under last time (${prevWeight}kg). Not every session is a PR. Focus on perfect form today and come back stronger next session.`;
      }
    }
    await logChat(user.id, message, liftReply, "EXERCISE_LOG");
    return liftReply;
    } // end weightKg else block
  }

  // ---- GOAL CHANGE: wants muscle but profile says fat loss / low calories ----
  const wantsMuscle = m.includes("gain weight") || m.includes("build muscle") || m.includes("gain muscle") || m.includes("i want to bulk") || m.includes("want to bulk") ||
    (m.includes("muscle") && (m.includes("want") || m.includes("focus on") || m.includes("goal is")));
  if (wantsMuscle && (user.goalType === "fat_loss" || (user.calorieTarget || 0) < 1800)) {
    const bw = parseFloat(user.currentWeight || "75");
    const { calorieTarget: newCals, proteinTarget: newProtein } = calculateTargets(bw, "muscle_gain", user.lifeSituation || "office", user.trainingDaysPerWeek || 3);
    await db.update(users).set({ goalType: "muscle_gain", calorieTarget: newCals, proteinTarget: newProtein }).where(eq(users.phoneNumber, phone));
    user.goalType = "muscle_gain";
    user.calorieTarget = newCals;
    user.proteinTarget = newProtein;
  }

  // ---- WEIGHT UPDATE (explicit) — "I weigh 83kg", "my weight is 83kg", bare "83kg" ----
  const isExplicitWeight = /\b(weigh|weight is|weight now|i am|i'm)\b/.test(m) || /^\d{2,3}(\.\d)?\s*kg$/.test(m.trim());
  const explicitKgMatch = m.match(/\b(\d{2,3}(?:\.\d)?)\s*kg\b/);
  if (isExplicitWeight && explicitKgMatch) {
    const newKg = parseFloat(explicitKgMatch[1]);
    if (newKg >= 35 && newKg <= 250) {
      const { calorieTarget: newCals, proteinTarget: newProtein } = calculateTargets(newKg, user.goalType || "fat_loss", user.lifeSituation || "office", user.trainingDaysPerWeek || 3);
      const prevKg = parseFloat(user.currentWeight || "0");
      const prevCals = user.calorieTarget || newCals;
      const prevProtein = user.proteinTarget || newProtein;
      await db.update(users).set({ currentWeight: newKg.toString(), calorieTarget: newCals, proteinTarget: newProtein }).where(eq(users.phoneNumber, phone));
      await db.insert(weightLogs).values({ userId: user.id, weight: newKg.toString() });
      // Store win memory at total loss milestones
      try {
        const firstLog = await db.select({ weight: weightLogs.weight }).from(weightLogs)
          .where(eq(weightLogs.userId, user.id)).orderBy(asc(weightLogs.loggedAt)).limit(1);
        if (firstLog.length > 0) {
          const startKg = parseFloat(String(firstLog[0].weight));
          const totalLoss = startKg - newKg;
          for (const milestone of [2, 5, 10, 15, 20]) {
            if (totalLoss >= milestone && totalLoss < milestone + 0.6) {
              await storeMemory(phone, `Weight loss milestone: lost ${milestone}kg total — started at ${startKg}kg, now at ${newKg}kg`, "milestone");
              break;
            }
          }
        }
      } catch { /* non-fatal */ }
      // Build weight change note
      let changeNote = "";
      if (prevKg > 0 && Math.abs(newKg - prevKg) > 0.1) {
        const diff = newKg - prevKg;
        const direction = diff < 0 ? `down ${Math.abs(diff).toFixed(1)}kg` : `up ${diff.toFixed(1)}kg`;
        changeNote = ` ${direction} from last log.`;
      }
      // Build targets change note
      let targetsNote = "";
      if (Math.abs(newCals - prevCals) > 20 || Math.abs(newProtein - prevProtein) > 2) {
        targetsNote = `\n\nTargets updated: ${newCals} kcal/day (was ${prevCals}), ${newProtein}g protein (was ${prevProtein}g). Your targets automatically adjust as your weight changes — this keeps your results moving.`;
      } else {
        targetsNote = `\n\nTargets: ${newCals} kcal/day | ${newProtein}g protein.`;
      }
      // Check for plateau (no change >0.5kg in last 3 weeks)
      const threeWeeksAgo = new Date(Date.now() - 21 * 86_400_000);
      const recentWeightLogs = await db.select({ weight: weightLogs.weight })
        .from(weightLogs).where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, threeWeeksAgo)))
        .orderBy(asc(weightLogs.loggedAt));
      let plateauNote = "";
      if (recentWeightLogs.length >= 3) {
        const oldest3w = parseFloat(String(recentWeightLogs[0].weight));
        const change3w = Math.abs(newKg - oldest3w);
        if (change3w < 0.5) {
          plateauNote = `\n\nWeight has barely moved in 3 weeks. Cut carb portions by a third this week and add a 20-minute walk daily. Reply *on track* to see your full week stats.`;
        }
      }
      return `Weight logged: ${newKg}kg.${changeNote}${targetsNote}${plateauNote}`;
    }
  }

  // ---- WEIGHT MENTION: update stored weight if client states a different one ----
  const weightInMsg = m.match(/\b(\d{2,3}(?:\.\d)?)\s*kg\b/);
  if (weightInMsg) {
    const mentionedKg = parseFloat(weightInMsg[1]);
    const storedKg = parseFloat(user.currentWeight || "0");
    if (mentionedKg >= 35 && mentionedKg <= 250 && Math.abs(mentionedKg - storedKg) > 0.4) {
      const { calorieTarget: newCals, proteinTarget: newProtein } = calculateTargets(mentionedKg, user.goalType || "fat_loss", user.lifeSituation || "office", user.trainingDaysPerWeek || 3);
      await db.update(users).set({ currentWeight: mentionedKg.toString(), proteinTarget: newProtein, calorieTarget: newCals }).where(eq(users.phoneNumber, phone));
      user.currentWeight = mentionedKg.toString();
      user.proteinTarget = newProtein;
      user.calorieTarget = newCals;
    }
  }

  // ---- PROGRAMME SETUP REPLY — detect "3 intermediate lose fat" style answers ----
  const hasDayCount = /\b[3-5]\b/.test(m);
  const hasExpWord = m.includes("beginner") || m.includes("intermediate") || m.includes("advanced");
  const hasGoalWord = m.includes("lose") || m.includes("fat") || m.includes("muscle") || m.includes("both") || m.includes("recomp");

  if (hasDayCount && (hasExpWord || hasGoalWord)) {
    const dayMatch = m.match(/\b([3-5])\b/);
    const days = dayMatch ? parseInt(dayMatch[1]) : 3;

    let exp = "beginner";
    if (m.includes("intermediate")) exp = "intermediate";
    if (m.includes("advanced")) exp = "advanced";

    let goal = "fat_loss";
    if ((m.includes("muscle") || m.includes("build")) && !m.includes("lose") && !m.includes("fat")) goal = "muscle_gain";
    if (m.includes("both") || m.includes("recomp")) goal = "recomposition";

    await db.update(users).set({
      trainingDaysPerWeek: days,
      trainingExperience: exp,
      goalType: goal,
    }).where(eq(users.phoneNumber, phone));

    const updatedUser = { ...user, trainingDaysPerWeek: days, trainingExperience: exp, goalType: goal };
    const programme = getKamlifeProgramme(updatedUser);
    const goalLabel = goal === "fat_loss" ? "Fat loss" : goal === "muscle_gain" ? "Muscle gain" : "Body recomposition";

    return `Sharp. ${days} days/week. ${exp.charAt(0).toUpperCase() + exp.slice(1)}. ${goalLabel}. Programme built.\n\n${programme}`;
  }

  // ---- FIX 4: EXPLICIT WORKOUT COMMANDS — hardcoded, never touch GPT ----
  // "Today's workout" and "Workouts" must always return directly. No GPT, no errors.
  const todayWorkoutPhrases = ["today", "today's workout", "todays workout", "workout today", "my workout", "show workout", "give me workout"];
  const fullProgrammePhrases = ["workouts", "my workouts"];
  if (todayWorkoutPhrases.includes(m)) {
    try {
      const workout = buildDayWorkout(user);
      const dayNum = user.programmeDayInWeek || 1;
      const r = `*Day ${dayNum} — Your Workout Today*\n\n${workout}`;
      await logChat(user.id, message, r, "WORKOUT_VIEW");
      return r;
    } catch (e) {
      console.error("[TODAY_WORKOUT]", e);
      return getKamlifeProgramme(user);
    }
  }
  if (fullProgrammePhrases.includes(m)) {
    try {
      const prog = getKamlifeProgramme(user);
      const r = `Your programme:\n\n${prog}`;
      await logChat(user.id, message, r, "PROGRAMME_VIEW");
      return r;
    } catch (e) {
      console.error("[WORKOUTS_VIEW]", e);
      return "Send *programme* to see your full workout plan.";
    }
  }

  // ---- PROGRAMME REQUEST WITHOUT PROFILE — check for elderly/injury first ----
  const isWorkoutRelated =
    m === "1" || m === "2" || m === "gym" || m === "workout" || m === "workouts" ||
    m.includes("workout") || m.includes("program") || m.includes("programme") ||
    m.includes("training plan") || m.includes("workout plan") || m.includes("exercise plan") ||
    m.includes("full body") || m.includes("3 day") || m.includes("4 day") || m.includes("5 day") ||
    m.includes("exercise") || m.includes("train") ||
    (m.includes("gym") && (m.includes("need") || m.includes("want") || m.includes("give") || m.includes("plan")));

  // ---- ELDERLY / SERIOUS INJURY — skip questions, give immediate safety programme ----
  const elderlyAge = m.match(/\bi'?m\s+(6[0-9]|7[0-9]|8[0-9]|9[0-9])\b/i) ||
    m.match(/\b(6[0-9]|7[0-9]|8[0-9]|9[0-9])\s*(year|yr|yo)\b/i) ||
    m.match(/\bage\s+(6[0-9]|7[0-9]|8[0-9]|9[0-9])\b/i);
  const isElderly = !!(elderlyAge || m.includes("elderly") || m.includes("old age") || m.includes("pensioner") || m.includes("senior citizen"));
  const hasSeriousInjury = m.includes("hip replacement") || m.includes("knee replacement") ||
    m.includes("hip surgery") || m.includes("hip problem") || m.includes("bad hip") ||
    m.includes("serious injury") || m.includes("cannot walk") || m.includes("can't walk");

  if ((isElderly || hasSeriousInjury) && isWorkoutRelated) {
    const ageStr = elderlyAge ? elderlyAge[1] : "";
    const prefix = hasSeriousInjury && !isElderly
      ? `With a serious injury, safety is everything.`
      : `At ${ageStr || "your age"} with${hasSeriousInjury ? " a hip problem" : " your history"}, safety is everything.`;
    return `${prefix} This programme builds real strength without risk. Any pain or discomfort — stop immediately and consult your doctor.\n\n*Safety-First Strength Programme — Seated and Machine Only*\nRest 90 seconds between sets. 3 sets of 15 reps. Light weight.\n\n1️⃣ *Seated Leg Press — light weight*\nhttps://www.youtube.com/results?search_query=seated+leg+press+light+weight+elderly\nFeet flat on platform. Push slowly. Never lock the knees.\n\n2️⃣ *Seated Leg Curl Machine*\nhttps://www.youtube.com/results?search_query=seated+leg+curl+machine+tutorial\nSlow and controlled. Only move through pain-free range.\n\n3️⃣ *Chest Press Machine — seated*\nhttps://www.youtube.com/results?search_query=chest+press+machine+tutorial+seniors\nBack flat against pad. Press gently. No locking at the top.\n\n4️⃣ *Seated Cable Row*\nhttps://www.youtube.com/results?search_query=seated+cable+row+elderly+tutorial\nSit tall. Pull elbows back slowly. Keep shoulders down.\n\n5️⃣ *Seated Shoulder Press Machine*\nhttps://www.youtube.com/results?search_query=seated+shoulder+press+machine+seniors\nPress overhead slowly. Stop if any shoulder pain.\n\n6️⃣ *Seated Calf Raise*\nhttps://www.youtube.com/results?search_query=seated+calf+raise+machine+tutorial\nHeel up slowly, lower slowly. Excellent for circulation.\n\n7️⃣ *Balance Work — standing at fixed support*\nHold a wall or fixed bar. Rise slowly onto toes and lower. 3 × 10. Builds ankle stability.\n\nTrain 2 to 3 times per week with at least one rest day between sessions. Reply DONE after each session and I track your progress.`;
  }

  // Fix 3 — If all programme data exists from onboarding, deliver immediately — no questions
  if (isWorkoutRelated && user.trainingDaysPerWeek && user.trainingExperience && user.goalType) {
    const programme = buildFullProgramme(user);
    const modeLabel = user.trainingMode === "gym" ? "Gym" : "Home";
    const reply = `${modeLabel} programme — ${user.trainingDaysPerWeek} days per week, ${user.trainingExperience} level, ${(user.goalType || "").replace(/_/g, " ")} focus.\n\n${programme}`;
    await logChat(user.id, message, reply, "PROGRAMME_DELIVERY");
    return reply;
  }

  if (isWorkoutRelated && (!user.trainingExperience || !user.trainingDaysPerWeek)) {
    await db.update(users).set({ awaitingProgrammeAnswers: true }).where(eq(users.phoneNumber, phone));
    const question = `Sharp. How many days can you train and are you at gym or home?`;
    await logChat(user.id, message, question, "PROGRAMME_QUESTIONS");
    return question;
  }

  // ---- STEP LOG DETECTION (direct — no GPT cost) ----
  const stepNumMatch = m.match(/\b([\d,]+)\s*(?:steps?|staps?)\b/i)
    || m.match(/(?:walked|done|did|logged)\s+([\d,]+)\s*(?:steps?|staps?)/i);
  const hasKmWalk = m.match(/(?:walked|loop|walk)\s+([\d.]+)\s*km/i);
  if (stepNumMatch || hasKmWalk) {
    let steps = 0;
    if (stepNumMatch) {
      steps = parseInt(stepNumMatch[1].replace(/,/g, ""));
    } else if (hasKmWalk) {
      const km = parseFloat(hasKmWalk[1]);
      steps = Math.round(km * 1300);
    }
    if (!isNaN(steps) && steps > 100 && steps < 100000) {
      const target = user.stepsTarget || 7000;
      await db.insert(stepLogs).values({ userId: user.id, steps });
      await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.phoneNumber, phone));
      const stepReply = getStepResponse(steps, target);
      const [perfectDay, streak] = await Promise.all([checkPerfectDay(user.id), getStepStreak(user.id)]);
      const streakNote = streak >= 3 ? `\n\n🔥 ${streak}-day step streak. Don't break it.` : streak === 2 ? `\n\n2 days in a row. Build the habit.` : "";
      const fullReply = stepReply + streakNote + (perfectDay || "");
      await logChat(user.id, message, fullReply, "STEP_LOG");
      return fullReply;
    }
  }

  // ---- WATER LOGGING HANDLER (Item 10) — no GPT ----
  const waterMatch = m.match(/(\d+(?:\.\d+)?)\s*(l|litre|liter|litres|liters|ml|millilitre|milliliter|glass(?:es)?|cup(?:s)?|bottle(?:s)?)\b/i);
  const hasWaterKeyword = /\b(water|drank|drank water|drank some|had water|drank my water|water intake|drinking water|water today)\b/i.test(m);
  if (waterMatch && hasWaterKeyword) {
    const amount = parseFloat(waterMatch[1]);
    const unit = waterMatch[2].toLowerCase();
    let litres = amount;
    if (unit === "ml" || unit === "millilitre" || unit === "milliliter") litres = amount / 1000;
    else if (unit === "glass" || unit === "glasses") litres = amount * 0.25;
    else if (unit === "cup" || unit === "cups") litres = amount * 0.25;
    else if (unit === "bottle" || unit === "bottles") litres = amount * 0.5;

    // Reset daily water if date has changed
    const today = new Date().toISOString().split("T")[0];
    const lastReset = user.waterLastResetDate;
    const currentWater = lastReset === today ? parseFloat(user.todayWater as string || "0") : 0;
    const newTotal = Math.round((currentWater + litres) * 10) / 10;
    const waterTarget = 2.0;

    await db.update(users).set({
      todayWater: newTotal.toString(),
      waterLastResetDate: today,
      waterStreak: newTotal >= waterTarget && currentWater < waterTarget
        ? (user.waterStreak || 0) + 1
        : (user.waterStreak || 0),
    }).where(eq(users.phoneNumber, phone));

    const remaining = Math.max(0, Math.round((waterTarget - newTotal) * 10) / 10);
    const targetHit = newTotal >= waterTarget;
    let waterReply = `Logged ${litres}L water. Total today: ${newTotal}L / ${waterTarget}L target.`;
    if (targetHit) {
      waterReply += ` Daily target hit.`;
      if (newTotal >= waterTarget && currentWater < waterTarget) {
        const streak = (user.waterStreak || 0) + 1;
        if (streak >= 3) waterReply += ` ${streak}-day water streak — consistency is showing.`;
      }
    } else {
      waterReply += ` ${remaining}L still to go.`;
    }
    await logChat(user.id, message, waterReply, "WATER_LOG");
    return waterReply;
  }

  // ---- WATER QUESTION HANDLER — before food scanner and portion guide ----
  const isWaterQuestion = /\b(how much water|water target|water goal|how many litres|how many liters|water should i drink|daily water|water recommendation|water intake|water per day)\b/i.test(m);
  const isWaterOnlyMsg = /^water\s*$/i.test(m.trim());
  if (isWaterQuestion || isWaterOnlyMsg) {
    const todayW = parseFloat(user.todayWater as string || "0");
    const remaining = Math.max(0, Math.round((2.0 - todayW) * 10) / 10);
    const waterQReply = `Daily water target: *2 litres*.\n\nYou have logged ${todayW}L today — ${remaining > 0 ? `${remaining}L still to go.` : `target hit.`}\n\nTo log water, send the amount: "drank 500ml", "had 1L", "2 glasses of water".`;
    await logChat(user.id, message, waterQReply, "WATER_QUESTION");
    return waterQReply;
  }

  // ---- FIX 2: CORRECTION DETECTION — "no I had a burger", "actually it was chicken" ----
  // Must run BEFORE food scanner. Strips correction prefix and re-processes the corrected food.
  const CORRECTION_PREFIX = /^(no[,\s]+|actually[,\s]+|i meant[,\s]+|not that[,\s]+|wait[,\s]+|no wait[,\s]+|correction[,\s]*)/i;
  const isFoodCorrection = CORRECTION_PREFIX.test(m) &&
    /\b(had|ate|eaten|eating|breakfast|lunch|dinner|supper|meal|it was|was a|i had)\b/i.test(m);
  if (isFoodCorrection) {
    // Mark the previous food log as corrected so it is excluded from today's totals
    const todayStartCorr = new Date(); todayStartCorr.setHours(0, 0, 0, 0);
    try {
      const lastFoodLog = await db.select({ id: chatHistory.id })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStartCorr)))
        .orderBy(desc(chatHistory.createdAt))
        .limit(1);
      if (lastFoodLog.length > 0) {
        await db.update(chatHistory).set({ intent: "FOOD_LOG_CORRECTED" }).where(eq(chatHistory.id, lastFoodLog[0].id));
      }
    } catch { /* non-fatal */ }
    // Strip the correction prefix and process the remaining message as the actual food
    const correctedMsg = m.replace(CORRECTION_PREFIX, "").trim();
    if (correctedMsg && correctedMsg.length > 2 && correctedMsg !== m) {
      return await handleMessage(phone, correctedMsg);
    }
  }

  // ---- FIX 3: WATER GUARD — messages about water/hydration never reach food scanner ----
  // Water handlers above (lines ~919-971) catch most cases. This catches the remainder.
  const hasWaterWord = /\b(water|h2o|hydrat(e|ion|ing))\b/i.test(m);
  if (hasWaterWord && /\b(had|drank|drinking|intake|drink|logged|consumed)\b/i.test(m)) {
    // Only route here if no actual food found in the message
    const waterFoodCheck = scanForSAFoods(m);
    if (waterFoodCheck.length === 0) {
      const todayWg = parseFloat(user.todayWater as string || "0");
      const remainingWg = Math.max(0, Math.round((2.0 - todayWg) * 10) / 10);
      const wGuardReply = `Water logged. You have had ${todayWg}L today — ${remainingWg > 0 ? `${remainingWg}L still to go.` : `daily target hit. ✅`}\n\nTo log an exact amount: "drank 500ml", "had 1 litre", "2 glasses of water".`;
      await logChat(user.id, message, wGuardReply, "WATER_LOG");
      return wGuardReply;
    }
  }

  // ---- SA FOOD DATABASE MATCHING — instant calorie/protein lookup ----
  const isQuestion = m.includes("?") || /^(what|should|can i|is |are |how|why|when|tell me about|which|do i)/.test(m);
  const hasLogTrigger = /\b(ate|had|having|eating|breakfast|lunch|dinner|supper|snack|brunch|just had|just ate|meal was|meal is|food was|logged|i eat)\b/.test(m);
  // Only scan short messages if they contain an explicit food log trigger — not every short message
  const isShortFoodMsg = !isQuestion && hasLogTrigger && m.split(/\s+/).length <= 12;
  if (!isQuestion && (hasLogTrigger || isShortFoodMsg)) {
    const foundFoods = scanForSAFoods(m);
    if (foundFoods.length > 0) {
      const totalCals = foundFoods.reduce((s, f) => s + f.typicalPortionCalories, 0);
      const totalProtein = foundFoods.reduce((s, f) => s + f.typicalPortionProtein, 0);
      const calorieTarget = user.calorieTarget || 2000;
      const proteinTarget = user.proteinTarget || 120;
      const junkFoods = foundFoods.filter(f => f.category === "junk");
      const goodProteins = foundFoods.filter(f => f.category === "protein");
      const foodLines = foundFoods.map(f =>
        `• ${f.name}: ~${f.typicalPortionCalories} kcal, ${f.typicalPortionProtein}g protein (${f.typicalPortionDescription})`
      ).join("\n");
      const calRemaining = calorieTarget - totalCals;
      const proteinRemaining = proteinTarget - totalProtein;
      let coachNote = "";
      if (junkFoods.length > 0 && goodProteins.length === 0) {
        coachNote = `\n\nNext meal: add protein — eggs, pilchards, or chicken. Coach the next meal, not the last one.`;
      } else if (goodProteins.length > 0 && totalProtein >= 20) {
        coachNote = `\n\nSolid protein choice. ${proteinRemaining > 0 ? `${Math.round(proteinRemaining)}g protein still needed today.` : "Protein target hit for this meal. ✅"}`;
      } else if (foundFoods.some(f => f.category === "carb") && goodProteins.length === 0) {
        coachNote = `\n\nCarbs without protein — add a protein source to this meal. Eggs, pilchards, or beans work.`;
      }
      const junkNote = junkFoods.length > 0 ? `\n\n${junkFoods[0].notes}` : "";
      const reply = `*Food logged ✅*\n\n${foodLines}\n\n*Meal total: ~${totalCals} kcal | ~${Math.round(totalProtein)}g protein*\nRemaining today: ~${Math.max(0, calRemaining)} kcal${coachNote}${junkNote}`;
      await logChat(user.id, message, reply, "FOOD_LOG");
      const [saPattern, saDay] = await Promise.all([checkFoodPatterns(user.id), checkPerfectDay(user.id)]);
      return `${reply}${saPattern ? "\n\n" + saPattern : ""}${saDay || ""}`;
    }
  }

  // ---- FIX 3: HANDLER 1 — Progress check ----
  if (m.includes("how am i doing") || m.includes("my progress") || m.includes("am i on track") || m.includes("how have i done") || m.includes("check my progress") || m === "this week" || m === "week" || m === "week summary" || m === "my week" || m === "weekly summary" || m === "6" || m === "weekly report" || m === "report" || m.includes("how was my week") || m.includes("this weeks progress")) {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
      const [recentSteps, recentWorkouts, recentWeights] = await Promise.all([
        db.select().from(stepLogs).where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sevenDaysAgo))).orderBy(desc(stepLogs.loggedAt)),
        db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, sevenDaysAgo))),
        db.select().from(weightLogs).where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, sevenDaysAgo))).orderBy(asc(weightLogs.loggedAt)),
      ]);
      const liveT = calculateTargets(parseFloat(user.currentWeight || "75"), user.goalType || "fat_loss", user.lifeSituation || "office", user.trainingDaysPerWeek || 3);
      const plannedSessions = user.trainingDaysPerWeek || 3;
      const completedSessions = recentWorkouts.length;
      const avgSteps = recentSteps.length > 0 ? Math.round(recentSteps.reduce((s, r) => s + r.steps, 0) / recentSteps.length) : 0;
      const stepsTarget = user.stepsTarget || 7000;
      const weightChange = recentWeights.length >= 2
        ? (parseFloat(String(recentWeights[recentWeights.length - 1].weight)) - parseFloat(String(recentWeights[0].weight))).toFixed(1)
        : null;
      const sessionSentence = `Training: ${completedSessions} of ${plannedSessions} planned sessions done this week.`;
      const stepSentence = avgSteps > 0 ? `Steps: averaging ${avgSteps.toLocaleString()} per day against a ${stepsTarget.toLocaleString()} target.` : `Steps: no step logs this week — start logging daily.`;
      const weightSentence = weightChange !== null ? (parseFloat(weightChange) < 0 ? `Weight: down ${Math.abs(parseFloat(weightChange))}kg this week — moving in the right direction.` : parseFloat(weightChange) > 0 ? `Weight: up ${weightChange}kg — could be water, sodium, or muscle. Stay on programme.` : `Weight: holding steady this week.`) : `Weight: no weigh-ins logged — step on the scale and send me the number.`;
      const onTrack = completedSessions >= Math.ceil(plannedSessions * 0.75);
      const verdictSentence = onTrack ? `Overall you are on track — keep the consistency going into next week.` : `${user.name || "Champ"}, ${plannedSessions - completedSessions} sessions missed this week. Get the next one done today.`;
      const progressReply = `*Your 7-Day Progress Check*\n\n${sessionSentence}\n${stepSentence}\n${weightSentence}\n${verdictSentence}`;

      // Build shareable weekly wins card for good weeks
      let winsCard = "";
      if (onTrack) {
        const clientDisplayName = user.name || "KamLife";
        const totalWorkoutsAll = user.totalWorkoutsCompleted || completedSessions;
        const weekNum = user.programmeWeek || 1;
        const weightLine = weightChange !== null && parseFloat(weightChange) < 0
          ? `⬇️ Weight: -${Math.abs(parseFloat(weightChange))}kg this week`
          : weightChange !== null && parseFloat(weightChange) === 0
            ? `⚖️ Weight: holding steady`
            : "";
        const stepsLine = avgSteps >= stepsTarget
          ? `👟 Steps: ${avgSteps.toLocaleString()} avg/day ✅`
          : avgSteps > 0 ? `👟 Steps: ${avgSteps.toLocaleString()} avg/day` : "";
        const workoutLine = `💪 Sessions: ${completedSessions}/${plannedSessions} ✅`;
        const streakLine = user.workoutStreak >= 5 ? `🔥 Streak: ${user.workoutStreak} sessions straight` : "";
        const totalLine = `📊 Total sessions with Coach K: ${totalWorkoutsAll}`;
        const winsLines = [workoutLine, stepsLine, weightLine, streakLine, totalLine].filter(Boolean).join("\n");
        const refLine = user.referralCode ? `\n\nYour referral code: *${user.referralCode}* — they get month 1 for R50, you get R50 credit.` : "";
        winsCard = `\n\n---\n\n*Week ${weekNum} — ${clientDisplayName}*\n${winsLines}\n\n_KamLife Coach — R99/month_${refLine}\n\nShare this with someone who needs to start. 💪`;
      }

      const fullReply = `${progressReply}${winsCard}`;
      await logChat(user.id, message, fullReply, "PROGRESS_CHECK");
      return fullReply;
    } catch (e) {
      console.error("[PROGRESS CHECK]", e);
    }
  }

  // ---- SUPPLEMENT INSTANT GUIDE (Item 22) — hardcoded, no GPT ----
  const suppKeywords: Record<string, string> = {
    "creatine": "creatine",
    "protein powder": "protein powder",
    "protein shake": "protein powder",
    "whey isolate": "whey",
    "whey protein": "whey",
    "whey": "whey",
    "pre workout": "pre-workout",
    "pre-workout": "pre-workout",
    "preworkout": "pre-workout",
    "bcaa": "bcaa",
    "fat burner": "fat burner",
    "fat burning": "fat burner",
    "multivitamin": "multivitamin",
    "multi vitamin": "multivitamin",
    "vitamin": "multivitamin",
  };
  const suppMatch = Object.entries(suppKeywords).find(([kw]) => m.includes(kw));
  if (suppMatch || m.includes("supplement") || m.includes("what should i take") || m.includes("should i take")) {
    const suppKey = suppMatch ? suppMatch[1] : null;
    let suppReply: string;
    if (suppKey && SUPPLEMENT_GUIDE[suppKey]) {
      suppReply = SUPPLEMENT_GUIDE[suppKey];
    } else {
      // General supplement overview
      suppReply = `*Supplement priority order for ${user.goalType === "muscle_gain" ? "muscle gain" : "fat loss"}:*\n\n1. Creatine — 5g daily. R80-120/month. Proven, safe, cheap. Start here.\n2. Protein powder — only if you cannot hit your ${user.proteinTarget || 140}g protein target from food. Whey isolate, USN or Biogen.\n3. Pre-workout — replace with black coffee. Free and identical.\n4. Everything else — skip it. Food first, always.\n\nFat burners: none are proven. Do not spend money on them.`;
    }
    await logChat(user.id, message, suppReply, "SUPPLEMENT");
    return suppReply;
  }

  // ---- FIX 3: HANDLER 3 — Motivation and struggle ----
  if (m.includes("i want to quit") || m.includes("want to give up") || m.includes("this is too hard") || m.includes("i can't do this") || m.includes("i cant do this") || m.includes("not seeing results") || m.includes("nothing is working") || m.includes("no results") || m.includes("waste of time") || m.includes("doesn't work") || m.includes("not working for me")) {
    try {
      const [recentW, recentS] = await Promise.all([
        db.select().from(workoutLogs).where(eq(workoutLogs.userId, user.id)).orderBy(desc(workoutLogs.loggedAt)).limit(10),
        db.select().from(stepLogs).where(eq(stepLogs.userId, user.id)).orderBy(desc(stepLogs.loggedAt)).limit(7),
      ]);
      const totalWorkouts = user.totalWorkoutsCompleted || recentW.length;
      const avgStepsStruggle = recentS.length > 0 ? Math.round(recentS.reduce((s, r) => s + r.steps, 0) / recentS.length) : 0;
      let dataPoint = "";
      if (totalWorkouts > 0) dataPoint = `You have completed ${totalWorkouts} training session${totalWorkouts > 1 ? "s" : ""}.`;
      else if (avgStepsStruggle > 4000) dataPoint = `You are averaging ${avgStepsStruggle.toLocaleString()} steps per day this week.`;
      const struggleContext = `Client is struggling and said: "${message}". RULES — empathy first in one sentence, no generic motivation speech. Then state this real data point: "${dataPoint || "You showed up and sent this message — that means you have not quit."}". Then give ONE single specific action for today only. Never a list. Never "you've got this" or "believe in yourself". Be real and direct like a coach, not a cheerleader. SA voice.`;
      const struggleReply = await askCoachK(message, user, struggleContext);
      await logChat(user.id, message, struggleReply, "MOTIVATION");
      return struggleReply;
    } catch (e) {
      console.error("[MOTIVATION]", e);
    }
  }

  // ---- FIX 3: HANDLER 4 — Injury during training ----
  if (m.includes("i hurt") || m.includes("something hurts") || m.includes("i pulled") || m.includes("i strained") || m.includes("i injured") || m.includes("got injured") || (m.includes("pain") && (m.includes("training") || m.includes("gym") || m.includes("workout") || m.includes("lifting") || m.includes("running"))) || m.includes("pulled a muscle") || m.includes("strained my")) {
    const injuredArea = m.includes("knee") ? "knee" : m.includes("shoulder") ? "shoulder" : m.includes("back") ? "back" : m.includes("ankle") ? "ankle" : m.includes("wrist") ? "wrist" : m.includes("hip") ? "hip" : m.includes("neck") ? "neck" : m.includes("elbow") ? "elbow" : "the affected area";
    const safeAlternative: Record<string, string> = {
      knee: "upper body — chest press, rows, shoulder press, and arm work are all safe",
      shoulder: "lower body and core — squats, leg press, lunges, planks",
      back: "upper body machines seated — chest press, lat pulldown, cable rows with a straight back",
      ankle: "seated upper body — anything you can do sitting down",
      wrist: "legs and core — squats, leg press, lunges, walking",
      hip: "upper body — everything from the waist up",
      neck: "lower body and light machines — avoid anything overhead",
      elbow: "lower body and shoulder press — avoid any pulling or curling movements",
    };
    const safe = safeAlternative[injuredArea] || "anything that does not load that area";
    const injuryReply = `Stop loading ${injuredArea} immediately. Rest it today. Ice for 15 minutes if swollen.\n\nIf the pain is severe, sharp, or does not settle within 48 hours — see a doctor or physio. Do not train through sharp pain.\n\nYou CAN still train ${safe}. One body part stops, the rest keeps going.\n\nRest ${injuredArea} for 72 hours minimum then reassess. Update me when you are back.`;
    await logChat(user.id, message, injuryReply, "INJURY");
    return injuryReply;
  }

  // ---- FIX 3: HANDLER 5 — Period and cycle tracking ----
  if (m.includes("my period") || m.includes("time of the month") || m.includes(" pms") || m.includes("that time") || m.includes("menstrual") || m.includes("on my period") || m.includes("period started") || m.includes("period week")) {
    const cycleContext = `Client mentioned their menstrual cycle or period. Ask which phase they are in using EXACTLY these options: "Just started (Day 1–5)", "Middle of cycle (Day 6–14)", "PMS week (Day 15–21)", or "Period week (Day 22–28)". Then based on their reply: Phase 1 (period) — lighter training is fine, walking counts, iron-rich foods essential (red meat, spinach, pilchards), no guilt for lower energy. Phase 2 (follicular) — best training week, peak strength, push harder, carbs support performance. Phase 3 (PMS) — reduce intensity slightly, higher protein reduces cravings, magnesium from dark leafy greens helps mood. Phase 4 (period) — same as Phase 1. Normalise all of it. Weight fluctuates 1–3kg from water retention before period — not fat. Do not panic. Coach the next meal or session, not the feelings. SA voice. Max 3 sentences unless giving phase-specific advice.`;
    const cycleReply = await askCoachK(message, user, cycleContext);
    await logChat(user.id, message, cycleReply, "CYCLE");
    return cycleReply;
  }

  // ---- QUICK STAT LOOKUPS — never touch GPT ----
  if (["calories", "calorie", "what are my calories", "what are my calories for the day", "how many calories", "my calories", "calorie target", "my calorie target"].includes(m)) {
    const name = user.name || "Champ";
    return `*${name}'s Daily Calorie Target*\n\n🔥 Calories: *${user.calorieTarget || "not set"} kcal*\n💪 Protein: *${user.proteinTarget || "not set"}g*\n\nHit protein first — it fills you up, preserves muscle, and drives fat loss. Calories are a guide. Protein is non-negotiable.`;
  }
  if (["steps", "my steps", "step target", "daily steps", "steps daily", "how many steps", "my steps target", "steps target"].includes(m)) {
    return `*Your Daily Step Target*\n\n👟 ${(user.stepsTarget || 8000).toLocaleString()} steps per day.\n\nSteps are your baseline activity. Training burns calories for an hour. Steps burn them all day. Log your steps tonight with "X steps".`;
  }
  if (["protein", "my protein", "protein target", "daily protein", "protein daily", "how much protein", "my protein target"].includes(m)) {
    const p = user.proteinTarget || 140;
    const perMeal = Math.round(p / 4);
    return `*Your Daily Protein Target*\n\n💪 ${p}g protein per day.\n\nSpread across 4 meals — roughly ${perMeal}g each. Best SA sources: eggs (6g each), pilchards (20g per tin), chicken breast (30g per 100g), sugar beans (8g per half cup). This drives everything — muscle, fat loss, fullness.`;
  }
  if (["weight", "my weight", "current weight"].includes(m)) {
    const w = user.currentWeight ? `${user.currentWeight}kg` : "not logged yet";
    const bmiText = user.bmi ? ` BMI: ${parseFloat(String(user.bmi)).toFixed(1)}.` : "";
    return `*Your Weight*\n\n⚖️ Last logged: *${w}*${bmiText}\n\nWeigh yourself every morning — same time, same conditions, after bathroom, before food. Send me the number like this: *84kg*. Weekly trends matter more than daily changes.`;
  }
  if (["programme", "program", "my programme", "my program"].includes(m)) {
    return getKamlifeProgramme(user);
  }
  if (["meal plan", "meals", "my meals", "food plan", "diet plan", "diet", "my diet", "nutrition plan", "eating plan", "weekly meals", "my nutrition plan", "my eating plan"].includes(m)) {
    return getOnboardingMealPlan(user);
  }
  if (["progress", "my progress", "how am i doing"].includes(m)) {
    const daysOn = user.programmeStartDate
      ? Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86400000)
      : 0;
    const w = user.currentWeight ? `${user.currentWeight}kg` : "not logged";
    const name = user.name || "Champ";
    return `*${name}'s Progress*\n\n✅ Workouts completed: *${user.totalWorkoutsCompleted || 0}*\n📅 Days on programme: *${daysOn}*\n📊 Programme week: *${user.programmeWeek || 1}*\n⚖️ Current weight: *${w}*\n\nFor your full 7-day breakdown send *this week*.`;
  }
  if (["targets", "my targets", "goals"].includes(m)) {
    const goalLabel: Record<string, string> = {
      fat_loss: "Fat loss", muscle_gain: "Muscle gain", recomposition: "Body recomposition",
      general: "General fitness", health_condition: "Health management",
    };
    return `*Your Daily Targets*\n\n🔥 Calories: *${user.calorieTarget || "not set"} kcal*\n💪 Protein: *${user.proteinTarget || "not set"}g*\n👟 Steps: *${(user.stepsTarget || 0).toLocaleString()}*\n🎯 Goal: *${goalLabel[user.goalType || ""] || user.goalType || "not set"}*\n\nHit all three every day. That is the whole programme.`;
  }

  // ---- NEW: CUMULATIVE STATS ----
  if (["stats", "my stats", "all time", "my journey", "total", "overall", "my results", "how far"].includes(m)) {
    try {
      const [stepsTotal, firstWeight, lastWeight] = await Promise.all([
        db.select({ total: sql<string>`COALESCE(SUM(steps), 0)` }).from(stepLogs).where(eq(stepLogs.userId, user.id)),
        db.select().from(weightLogs).where(eq(weightLogs.userId, user.id)).orderBy(asc(weightLogs.loggedAt)).limit(1),
        db.select().from(weightLogs).where(eq(weightLogs.userId, user.id)).orderBy(desc(weightLogs.loggedAt)).limit(1),
      ]);
      const totalSteps = Number(stepsTotal[0]?.total || 0);
      const totalWorkouts = user.totalWorkoutsCompleted || 0;
      const daysOn = user.programmeStartDate
        ? Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86400000) : 0;
      const streak = await getStepStreak(user.id);
      let weightLine = "";
      if (firstWeight.length > 0 && lastWeight.length > 0 && firstWeight[0].id !== lastWeight[0].id) {
        const diff = parseFloat(String(lastWeight[0].weight)) - parseFloat(String(firstWeight[0].weight));
        weightLine = diff < 0
          ? `\n⬇️ Weight: down ${Math.abs(diff).toFixed(1)}kg since you started`
          : diff > 0 ? `\n⬆️ Weight: up ${diff.toFixed(1)}kg since you started`
          : `\n⚖️ Weight: unchanged since you started`;
      } else if (user.currentWeight) {
        weightLine = `\n⚖️ Current weight: ${user.currentWeight}kg`;
      }
      const name = user.name || "Champ";
      const statsReply = `*${name}'s Journey with Coach K* 💪\n\n✅ Workouts completed: ${totalWorkouts}\n👟 Total steps logged: ${totalSteps.toLocaleString()}\n📅 Days on programme: ${daysOn}\n🔥 Current streak: ${streak} day${streak !== 1 ? "s" : ""}${weightLine}\n\nThis is what you have built. Keep going.`;
      await logChat(user.id, message, statsReply, "STATS_LOOKUP");
      return statsReply;
    } catch (e) { console.error("[STATS]", e); }
  }

  // ---- NEW: REFERRAL ----
  if (["refer", "referral", "my referral", "my code", "referral code", "refer a friend", "invite"].includes(m)) {
    let code = user.referralCode;
    if (!code) {
      const namePrefix = (user.name || "KAM").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "K");
      const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString();
      code = `${namePrefix}${randomSuffix}`;
      await db.update(users).set({ referralCode: code }).where(eq(users.phoneNumber, phone));
    }
    const referralReply = `*Your KamLife Coach Referral Code* 🎯\n\nYour code: *${code}*\n\nShare this with someone ready to change:\n\n_"I am working with a WhatsApp fitness coach — real SA food advice, full workout programmes, daily accountability. R99/month, no app, just WhatsApp. Use my code ${code} when you sign up and get your first month at R50."_\n\nEvery person who stays for a full month earns you R20 off your next payment. No limit on referrals.`;
    await logChat(user.id, message, referralReply, "REFERRAL");
    return referralReply;
  }

  // ---- NEW: BMI ----
  if (["bmi", "my bmi", "what is my bmi", "what's my bmi", "check bmi"].includes(m)) {
    if (!user.bmi) {
      return `Your BMI has not been calculated yet. Send me your weight and height — for example: "I am 75kg and 1.72m tall" — and I will calculate it.`;
    }
    const bmiVal = parseFloat(String(user.bmi));
    const cat = bmiVal < 18.5 ? "underweight" : bmiVal < 25 ? "healthy weight range" : bmiVal < 30 ? "overweight range" : "obese range";
    const bmiNote = bmiVal < 18.5
      ? "Focus on eating enough — caloric surplus, high protein, strength training."
      : bmiVal < 25
        ? "Solid baseline. Build on this with consistency."
        : bmiVal < 30
          ? "Room to improve. Your programme and targets are calibrated for this."
          : "Meaningful progress is possible. Stay on the programme.";
    return `Your BMI is ${bmiVal.toFixed(1)} — ${cat}.\n\n${bmiNote}\n\nBMI is one number, not the full picture. Strength, energy, and consistency matter more.`;
  }

  // ---- NEW: TODAY'S WORKOUT ----
  if (["today", "today's workout", "todays workout", "my workout", "workout today", "show workout", "give me workout",
    "1", "day 1", "day 2", "day 3", "day 4", "day 5", "day 6"].includes(m)) {
    const dayMatch = m.match(/^day\s*([1-6])$/);
    if (dayMatch) {
      const requestedDay = parseInt(dayMatch[1]);
      const dayUser = { ...user, programmeDayInWeek: requestedDay };
      const workout = buildDayWorkout(dayUser);
      return `*Day ${requestedDay} Workout*\n\n${workout}`;
    }
    const workout = buildDayWorkout(user);
    const dayNum = user.programmeDayInWeek || 1;
    return `*Day ${dayNum} — Your Workout Today*\n\n${workout}`;
  }

  // ---- NEW: NEXT WORKOUT ----
  if (["next", "next workout", "tomorrow", "what's next", "whats next", "next session", "next day"].includes(m)) {
    const tomorrowDow = (new Date().getDay() + 1) % 7;
    const tomorrowType = getDayType(tomorrowDow);
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayLabels: Record<string, string> = { push: "Push 💪", pull: "Pull 🏋️", legs: "Legs 🦵", core: "Core 🔥", rest: "Rest 🛌" };
    const tomorrowName = dayNames[tomorrowDow];
    if (tomorrowType === "rest") {
      return `*Tomorrow — ${tomorrowName}: Rest Day 🛌*\n\nYour body builds during rest. Stretch, walk lightly, hit your protein target, and sleep well. Monday is Push day — come in fresh.`;
    }
    const nextDayUser = { ...user };
    const nextWorkout = buildDayWorkoutForType(nextDayUser, tomorrowType);
    return `*Tomorrow — ${tomorrowName}: ${dayLabels[tomorrowType]}*\n\nComplete today's session first, then this is waiting for you.\n\n${nextWorkout}`;
  }

  // ---- NEW: STREAK ----
  if (["streak", "my streak", "step streak", "current streak"].includes(m)) {
    const streak = await getStepStreak(user.id);
    const workoutCount = user.totalWorkoutsCompleted || 0;
    if (streak === 0) {
      return `No step streak yet. Log today's steps to start one. Every streak starts at 1.`;
    }
    const streakMsg = streak >= 7
      ? `🔥 ${streak}-day step streak. That is serious consistency — do not stop now.`
      : streak >= 3
        ? `🔥 ${streak}-day step streak. You are building something real. Keep it going.`
        : `${streak} days in a row. Keep adding days — streaks build habits.`;
    return `${streakMsg}\n\nTotal workouts completed: ${workoutCount}.`;
  }

  // ---- MENU NUMBER SHORTCUTS ----
  if (m === "2" || m === "food" || m === "food coaching" || m === "log food" || m === "food log") {
    return `Send me what you ate and I will give you the calories and protein instantly.\n\nExamples:\n• "I had pap and pilchards"\n• "2 eggs and brown bread"\n• "KFC original piece"\n• "Oats for breakfast"\n\nI have ${SA_FOODS_SEED.length} SA foods in my database. Just tell me what you ate.`;
  }
  if (m === "3" || m === "log steps" || m === "step log") {
    return `Send me your step count and I will log it.\n\nExamples:\n• "8500 steps"\n• "I walked 5km"\n• "10,000 steps done"\n\nYour daily target: ${user.stepsTarget?.toLocaleString() || "7,000"} steps.`;
  }
  if (m === "4" || m === "log sleep" || m === "sleep log") {
    return `Send me how many hours you slept.\n\nExamples:\n• "I slept 6 hours"\n• "7 hours sleep"\n• "bad sleep, maybe 5 hours"\n\nTarget: 7–9 hours for full recovery and fat loss.`;
  }
  if (m === "5" || m === "log weight" || m === "weight log") {
    return `Send me your weight and I will log it.\n\nExamples:\n• "84.5kg"\n• "I weigh 91kg"\n• "weighed in at 78kg this morning"\n\nWeigh in first thing in the morning, after toilet, before food. Same conditions every time.`;
  }
  if (m === "7" || m === "measurements" || m === "check in" || m === "measurement check in" || m === "measurements check in") {
    return `*Measurements Check-In*\n\nSend me your current measurements in this format:\n\nWaist: Xcm\nHips: Xcm\nChest: Xcm\nArm: Xcm\n\nMeasure first thing in morning, relaxed (not flexed). Same spot every time. The tape does not lie even when the scale does.`;
  }

  // ---- CLOTHING CHECK-IN (Non-Scale Victory) — option 8 ----
  const isClothingTrigger = m === "8" || m === "non scale" || m === "nsc" || m === "non-scale" || m === "clothing" || m === "clothing check" || m === "clothing check in" || m === "non scale victory";
  if (isClothingTrigger) {
    await db.update(users).set({ awaitingInputType: "clothing_checkin" }).where(eq(users.phoneNumber, phone));
    return `*Non-Scale Victory Check-In*\n\nThe scale lies. Your clothes never do. Answer these 4 in one message:\n\n1. *Jeans* — Looser / Same / Tighter\n2. *Energy* — High / Medium / Low\n3. *Stomach* — Flatter / Same / Bloated\n4. *Overall feel* — Great / Good / Okay / Bad\n\nExample: "Looser, High, Flatter, Great"`;
  }

  // ---- CLOTHING CHECK-IN RESPONSE — parse when awaiting ----
  if (user.awaitingInputType === "clothing_checkin") {
    const JEANS = ["looser", "same", "tighter", "fitting better", "too tight", "baggy", "big", "small"];
    const ENERGY = ["high", "medium", "low", "great", "good", "okay", "tired", "energetic"];
    const STOMACH = ["flatter", "same", "bloated", "better", "flat", "bigger", "smaller"];
    const OVERALL = ["great", "good", "okay", "bad", "amazing", "terrible", "fine", "average"];
    const hasAnyAnswer = [...JEANS, ...ENERGY, ...STOMACH, ...OVERALL].some(k => m.includes(k));
    if (hasAnyAnswer) {
      const jeansFit = JEANS.find(k => m.includes(k)) || "not specified";
      const energyLevel = ENERGY.find(k => m.includes(k)) || "not specified";
      const stomachFeel = STOMACH.find(k => m.includes(k)) || "not specified";
      const overallFeel = OVERALL.find(k => m.includes(k)) || "not specified";
      const weekNum = user.programmeWeek || 1;
      const clientName = user.name ? `, ${user.name}` : "";
      try {
        await db.insert(clothingCheckins).values({ userId: user.id, jeansFit, energyLevel, stomachFeel, overallFeel, weekNumber: weekNum });
        await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone));
        await storeMemory(phone, `Week ${weekNum} non-scale check-in: jeans ${jeansFit}, energy ${energyLevel}, stomach ${stomachFeel}, overall ${overallFeel}`, "milestone");
        // Store specific win memory for positive NSV results so Coach K can reference them later
        const isNSVPositive = ["looser", "fitting better", "baggy"].some(k => jeansFit.includes(k));
        if (isNSVPositive) {
          await storeMemory(phone, `NSV WIN at week ${weekNum}: jeans are ${jeansFit}, energy ${energyLevel}, stomach ${stomachFeel} — body is changing visibly`, "milestone");
        }
      } catch { /* non-fatal */ }

      // Build a specific coaching response + follow-up question based on what they reported
      const isPositiveJeans = ["looser", "fitting better", "baggy", "big"].some(k => m.includes(k));
      const isTighterJeans = ["tighter", "too tight", "small"].some(k => m.includes(k));
      const isHighEnergy = ["high", "energetic"].some(k => m.includes(k));
      const isLowEnergy = ["low", "tired"].some(k => m.includes(k));
      const isFlatStomach = ["flatter", "better", "flat"].some(k => m.includes(k));
      const isBloated = m.includes("bloated") || m.includes("bigger");

      let observation = "";
      let followUp: string | null = "";

      if (isPositiveJeans && isHighEnergy) {
        observation = `Week ${weekNum} saved${clientName}. Jeans looser and energy high — that is body recomposition happening in real time. The scale might not show it but the clothes do.`;
        followUp = `What has been the biggest change you have made to your diet or training this week?`;
      } else if (isPositiveJeans) {
        observation = `Week ${weekNum} saved. Jeans are responding${clientName} — that is centimetres off the waist regardless of what the scale says.`;
        followUp = `Energy is ${energyLevel} — what time are you training?`;
      } else if (isTighterJeans && isBloated) {
        observation = `Week ${weekNum} saved. Tighter jeans and bloating is almost always sodium and water retention${clientName} — not fat gain. Check your sodium this week: polony, Russians, Aromat, stock cubes.`;
        followUp = `What did you eat most this week?`;
      } else if (isTighterJeans) {
        observation = `Week ${weekNum} saved. Jeans tighter${clientName}. Before assuming fat gain — how has your sodium and sleep been this week?`;
        followUp = null;
      } else if (isLowEnergy) {
        observation = `Week ${weekNum} saved${clientName}. Low energy tells me more than the scale does. Could be sleep, could be calories too low, could be stress.`;
        followUp = `How many hours are you sleeping?`;
      } else if (isBloated) {
        observation = `Week ${weekNum} saved. Bloating${clientName} is usually sodium, not enough vegetables, or stress. Aromat, stock cubes, and processed meats are the main culprits in SA.`;
        followUp = `Are you hitting your vegetable target each day?`;
      } else {
        observation = `Week ${weekNum} check-in saved${clientName}. Jeans: ${jeansFit}. Energy: ${energyLevel}. Stomach: ${stomachFeel}. Overall: ${overallFeel}. Stay on the programme.`;
        followUp = null;
      }

      const clothingReply = followUp ? `${observation} ${followUp}` : observation;
      await logChat(user.id, message, clothingReply, "CLOTHING_CHECKIN");
      return clothingReply;
    }
    // Didn't recognise the answer — clear state and let GPT handle
    await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone));
  }

  // ---- INJURY BETTER — close the follow-up loop ----
  const injuryBetter = /\b(injury better|injury healed|no more pain|pain is gone|knee is better|back is better|shoulder is better|hip is better|feeling better.*injury|injury.*feeling better|all good.*injury|injury.*all good)\b/i.test(m);
  if (injuryBetter && user.injuries && user.injuries !== "none") {
    const oldInjury = user.injuries;
    await db.update(users).set({ injuries: "none" }).where(eq(users.phoneNumber, phone));
    try { await storeMemory(phone, `Injury resolved: "${oldInjury}" — client reported recovery`, "medical"); } catch { }
    const injuryReply = `Noted — ${oldInjury} marked as recovered. Full programme is back. Build up gradually this week — don't jump straight to max weight. Reply "today" for your session.`;
    await logChat(user.id, message, injuryReply, "INJURY_UPDATE");
    return injuryReply;
  }

  // ---- SLEEP LOGGING — hardcoded, no GPT ----
  const sleepMatch = m.match(/\b(slept|sleep|sleeping)\b.*?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|ure)/i)
    || m.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:of\s*)?(?:sleep|slept|rest)/i)
    || m.match(/\b(bad sleep|poor sleep|no sleep|couldn't sleep|can't sleep|couldnt sleep|insomnia)\b/i);

  if (sleepMatch) {
    const hoursStr = m.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/i);
    const hours = hoursStr ? parseFloat(hoursStr[1]) : null;
    const isBadSleep = /bad sleep|poor sleep|no sleep|couldn't sleep|can't sleep|couldnt sleep|insomnia/i.test(m);

    let sleepReply = "";
    if (isBadSleep && !hours) {
      sleepReply = `Poor sleep affects fat loss more than a bad meal. Cortisol rises, hunger hormones spike, motivation drops. One fix tonight: no phone in the bedroom. Dark, cool, quiet. Your body will do the rest.`;
    } else if (hours !== null) {
      if (hours < 5) {
        sleepReply = `${hours} hours — that is not enough for recovery. Today's training will suffer and fat storage increases with this little sleep. Rest today if you can. Tonight: hard stop on screens by 9pm.`;
      } else if (hours < 7) {
        const idx = Math.floor(Date.now() / 86400000) % SLEEP_RESPONSES_LOW.length;
        sleepReply = SLEEP_RESPONSES_LOW[idx](hours);
      } else if (hours <= 9) {
        const idx = Math.floor(Date.now() / 86400000) % SLEEP_RESPONSES_GOOD.length;
        sleepReply = SLEEP_RESPONSES_GOOD[idx](hours);
      } else {
        sleepReply = SLEEP_RESPONSES_HIGH[0](hours);
      }
    } else {
      sleepReply = `Log your sleep hours so I can track your recovery — just say something like "I slept 7 hours".`;
    }
    await logChat(user.id, message, sleepReply, "SLEEP_LOG");
    return sleepReply;
  }

  // ---- EQUIPMENT ALTERNATIVES (Item 5) — no GPT ----
  if (/no\s+.*(gym|equipment|weights|barbell|dumbbell|machine|bench)/i.test(m) ||
      /can.?t\s+(go to\s+)?gym|don.?t\s+have\s+(a\s+)?(gym|weights|equipment|dumbbell|barbell)|no\s+gym|without\s+gym|without\s+equipment/i.test(m) ||
      /what\s+can\s+i\s+use\s+instead|home\s+alternative|bodyweight\s+alternative|no\s+weights/i.test(m)) {
    const eqKeys = Object.keys(EQUIPMENT_ALTERNATIVES);
    const matchedEquip = eqKeys.find(eq => m.includes(eq));
    let equipReply: string;
    if (matchedEquip) {
      equipReply = `No ${matchedEquip}? Use ${EQUIPMENT_ALTERNATIVES[matchedEquip].join(" or ")}.\n\nFull home programme is available — reply *programme* or *menu* to see it. You do not need a gym to build real strength.`;
    } else {
      equipReply = `No gym or equipment? Here is what you can use instead:\n\nDumbbells — 2L water bottles, rice bags, or a loaded backpack (books in a bag).\nBarbell — broomstick for form practice, loaded backpack for resistance.\nBench press — push-up variations (decline, diamond, archer push-up).\nPull-up bar — table row lying under a sturdy table.\nCable machine — resistance bands (Dischem R30-50).\nGym — your bodyweight. Reply *programme* for your full home programme.`;
    }
    await logChat(user.id, message, equipReply, "EQUIPMENT_ALTERNATIVES");
    return equipReply;
  }

  // ---- FOOD SUBSTITUTIONS (Item 6) — no GPT ----
  if (/substitute|instead of|swap\s+\w|replace\s+\w|alternative to|can i use|what can i use instead|i don.?t have/i.test(m)) {
    const subKeys = Object.keys(FOOD_SUBSTITUTIONS);
    const matchedFood = subKeys.find(food => m.includes(food));
    if (matchedFood) {
      const subReply = `*${matchedFood.charAt(0).toUpperCase() + matchedFood.slice(1)} substitutes:*\n\n${FOOD_SUBSTITUTIONS[matchedFood]}\n\nAlways choose the cheapest option that hits your protein target. Food first, supplements last.`;
      await logChat(user.id, message, subReply, "FOOD_SUBSTITUTION");
      return subReply;
    }
  }

  // ---- PORTION SIZE GUIDE (Item 7) — no GPT ----
  if (/\b(portion|how many grams|serving size|how big|how large|right amount|right portion|portion size|right size|how do i measure)\b/i.test(m) || (/\bhow much\b/i.test(m) && !/water/i.test(m))) {
    await logChat(user.id, message, PORTION_GUIDE, "PORTION_GUIDE");
    return PORTION_GUIDE;
  }

  // ---- STORE ADVICE (Item 8) — no GPT ----
  const storeMatch = Object.keys(STORE_ADVICE).find(store => m.includes(store));
  if (storeMatch || /where to buy|where can i get|which store|which shop|best store|cheapest store|where do i shop|where should i shop/i.test(m)) {
    let storeReply: string;
    if (storeMatch) {
      storeReply = STORE_ADVICE[storeMatch];
    } else {
      const budget = user.weeklyFoodBudget || "100_300";
      if (budget === "under_100" || budget === "100_300") {
        storeReply = `For your budget — Shoprite and Boxer are your best options.\n\n${STORE_ADVICE["shoprite"]}\n\n${STORE_ADVICE["boxer"]}`;
      } else if (budget === "300_600") {
        storeReply = `At your budget — Shoprite for bulk staples, Checkers for variety.\n\n${STORE_ADVICE["checkers"]}`;
      } else {
        storeReply = `At your budget, you have options. Shoprite for bulk buys. Checkers for quality house brand. Pick n Pay for dairy.\n\n${STORE_ADVICE["pick n pay"]}`;
      }
    }
    await logChat(user.id, message, storeReply, "STORE_ADVICE");
    return storeReply;
  }

  // ---- INJURY MODIFICATIONS (Item 18) — no GPT for known injuries ----
  const injuryModKeywords = ["injured", "injury", "hurt my", "pain in my", "bad knee", "bad back", "bad shoulder", "bad hip", "bad wrist", "bad ankle", "knee pain", "back pain", "shoulder pain", "hip pain", "wrist pain", "ankle pain", "sore knee", "sore back", "sore shoulder"];
  const injuryModMatch = /injured|injury|hurt my|pain in my|can.?t do.*because|modify.*for|exercises? with/i.test(m);
  const userHasInjuries = user.injuries && user.injuries.length > 2 && user.injuries !== "none";

  if (injuryModMatch || (userHasInjuries && isWorkoutRelated)) {
    const injuries = user.injuries ? user.injuries.toLowerCase() : m;
    const injuryKey = Object.keys(INJURY_MODIFICATIONS).find(key =>
      m.includes(key) || injuries.includes(key)
    );
    if (injuryKey) {
      const mod = INJURY_MODIFICATIONS[injuryKey];
      await logChat(user.id, message, mod.alternatives, "INJURY_MODIFICATION");
      return mod.alternatives;
    }
  }

  // ---- MEASUREMENTS LOGGING (Item 23) — parse and store ----
  const measPattern = /(\d+(?:\.\d+)?)\s*cm\s*(?:.*?)?\b(waist|hip|hips|chest|thigh|arm|neck|calf|bicep|biceps)\b/i;
  const measPatternReverse = /\b(waist|hip|hips|chest|thigh|arm|neck|calf|bicep|biceps)\b\s*(?:is|:|\s)\s*(\d+(?:\.\d+)?)\s*cm/i;
  const measMatch = m.match(measPattern) || m.match(measPatternReverse);
  if (measMatch) {
    let measValue: number;
    let measType: string;
    if (m.match(measPattern)) {
      measValue = parseFloat(measMatch[1]);
      measType = measMatch[2].toLowerCase().replace("hips", "hip").replace("biceps", "bicep");
    } else {
      measType = measMatch[1].toLowerCase().replace("hips", "hip").replace("biceps", "bicep");
      measValue = parseFloat(measMatch[2]);
    }
    if (measValue > 20 && measValue < 300) {
      // Check last entry for comparison
      let compareNote = "";
      try {
        const lastMeas = await db.select().from(bodyMeasurements)
          .where(and(eq(bodyMeasurements.userId, user.id), eq(bodyMeasurements.measurementType, measType)))
          .orderBy(desc(bodyMeasurements.loggedAt))
          .limit(1);
        if (lastMeas.length > 0) {
          const prev = parseFloat(lastMeas[0].value);
          const diff = measValue - prev;
          const daysAgo = Math.floor((Date.now() - new Date(lastMeas[0].loggedAt || "").getTime()) / 86400000);
          if (Math.abs(diff) < 0.1) compareNote = ` Same as your last measurement ${daysAgo} days ago.`;
          else if (diff < 0) compareNote = ` Down ${Math.abs(diff).toFixed(1)}cm from ${prev}cm (${daysAgo} days ago). Moving in the right direction.`;
          else compareNote = ` Up ${diff.toFixed(1)}cm from ${prev}cm (${daysAgo} days ago). Check your nutrition consistency.`;
        }
      } catch { }
      await db.insert(bodyMeasurements).values({ userId: user.id, measurementType: measType, value: measValue.toString() });
      const measReply = `Logged ${measValue}cm ${measType}.${compareNote}`;
      await logChat(user.id, message, measReply, "MEASUREMENT_LOG");
      return measReply;
    }
  }

  // ---- RESCUE / RESET — for stuck users ----
  if (/\b(restart|reset|start over|start again|stuck|help me start|beginning|begin again|onboard again)\b/i.test(m) ||
      m === "restart" || m === "reset" || m === "start over") {
    const currentState = user.onboardingState;
    // Only allow reset for non-COMPLETE users OR users explicitly requesting restart
    const wantsFullReset = /start over|start again|begin again|onboard again/i.test(m);
    if (currentState !== "COMPLETE" || wantsFullReset) {
      await db.update(users).set({
        onboardingState: "WELCOME",
        awaitingInputType: null,
        awaitingProgrammeAnswers: false,
      }).where(eq(users.phoneNumber, phone));
      const rescueReply = `Fresh start. What is your name?`;
      await logChat(user.id, message, rescueReply, "RESCUE");
      return rescueReply;
    }
    // COMPLETE users asking "restart" — probably want workout/menu, not full reset
    return await getMenuText(user);
  }

  // ---- HOLIDAY / PAUSE MODE ----
  if (/\b(holiday|pause|pausing|on holiday|going away|vacation|sick leave|taking a break|leave me alone|stop messaging|mute|quiet mode|don.?t message)\b/i.test(m)) {
    // Parse duration
    const daysMatch = m.match(/(\d+)\s*(day|days|week|weeks)/i);
    let pauseDays = 7; // default 1 week
    if (daysMatch) {
      const num = parseInt(daysMatch[1]);
      const unit = daysMatch[2].toLowerCase();
      pauseDays = unit.startsWith("week") ? num * 7 : num;
    }
    pauseDays = Math.min(pauseDays, 30); // max 30 days
    const pauseUntil = new Date(Date.now() + pauseDays * 86_400_000).toISOString().slice(0, 10);
    const existingNotes = user.profileNotes || "";
    const updatedNotes = existingNotes.replace(/paused_until:\d{4}-\d{2}-\d{2}/, `paused_until:${pauseUntil}`)
      || `${existingNotes ? existingNotes + " | " : ""}paused_until:${pauseUntil}`;
    const finalNotes = updatedNotes.includes("paused_until:") ? updatedNotes : `${existingNotes ? existingNotes + " | " : ""}paused_until:${pauseUntil}`;
    await db.update(users).set({ profileNotes: finalNotes }).where(eq(users.phoneNumber, phone));
    const pauseReply = `Got it. No check-in messages for ${pauseDays} day${pauseDays > 1 ? "s" : ""} — until ${pauseUntil}. Your programme is saved. When you are back, just message me and we pick up where we left off.`;
    await logChat(user.id, message, pauseReply, "PAUSE_MODE");
    return pauseReply;
  }

  // ---- UNPAUSE ----
  if (/\b(i.?m back|i am back|back now|unpause|resume|i.?m here|returned|back from holiday|feeling better|i.?m better)\b/i.test(m)) {
    const existingNotes = user.profileNotes || "";
    if (existingNotes.includes("paused_until:")) {
      const updatedNotes = existingNotes.replace(/\s*\|?\s*paused_until:\d{4}-\d{2}-\d{2}/, "").trim();
      await db.update(users).set({ profileNotes: updatedNotes || null }).where(eq(users.phoneNumber, phone));
      const backReply = `Welcome back. Programme resumes now. What did you eat for your last meal and have you trained yet today?`;
      await logChat(user.id, message, backReply, "UNPAUSED");
      return backReply;
    }
    // Not paused — fall through to GPT which handles "I'm back" motivationally
  }

  // ---- NEW PROGRAMME / CHANGE DAYS REQUEST ----
  const isNewProgramme =
    /\b(new programme|new program|change programme|change program|change my programme|change my program|give me a new programme|new workout plan|change workout plan|rebuild.*programme|update.*programme)\b/i.test(m) ||
    /\bi want to train\s+[2-6]\s*days?\b/i.test(m) ||
    /\btrain\s+[2-6]\s*days?\s*(?:a\s*week|per\s*week)\b/i.test(m) ||
    /\b[2-6]\s*days?\s*(?:a\s*week|per\s*week)\s*(?:please|now|from now|training|programme|program)?\b/i.test(m);

  if (isNewProgramme) {
    // If client already included days AND mode in this message, act immediately
    const daysInMsg = m.match(/\b([2-6])\s*days?\b/i) || m.match(/(?:train|gym|workout)\s+([2-6])\s*days?/i);
    const gymInMsg = /\bgym\b/i.test(m);
    const homeInMsg = /\bhome\b/i.test(m);

    if (daysInMsg && (gymInMsg || homeInMsg)) {
      const days = parseInt(daysInMsg[1]);
      const mode = gymInMsg ? "gym" : "home";
      await db.update(users)
        .set({ trainingDaysPerWeek: days, trainingMode: mode, programmePhase: 1, programmeWeek: 1, programmeDayInWeek: 1, programmeStartDate: new Date() })
        .where(eq(users.phoneNumber, phone));
      const updatedUser = { ...user, trainingDaysPerWeek: days, trainingMode: mode };
      const programme = buildFullProgramme(updatedUser);
      const modeLabel = mode === "gym" ? "Gym" : "Home";
      const newProgReply = `Sharp. ${days} days/week. ${modeLabel}. Here is your updated programme.\n\n${programme}`;
      await logChat(user.id, message, newProgReply, "PROGRAMME_DELIVERY");
      return newProgReply;
    }

    // Ask the single question — never dump the programme without it
    await db.update(users).set({ awaitingProgrammeAnswers: true }).where(eq(users.phoneNumber, phone));
    const question = `Sharp. How many days can you train and are you at gym or home?`;
    await logChat(user.id, message, question, "PROGRAMME_QUESTIONS");
    return question;
  }

  // ---- AWAITING GOAL CHANGE REASON — ask why first before applying goal change ----
  if (user.awaitingInputType?.startsWith("goal_reason:")) {
    const pendingGoal = user.awaitingInputType.split(":")[1] as string;
    await db.update(users)
      .set({ awaitingInputType: null, goalType: pendingGoal })
      .where(eq(users.phoneNumber, phone));
    const { calorieTarget: newCals, proteinTarget: newProt } = calculateTargets(
      parseFloat(user.currentWeight || "75"), pendingGoal, user.lifeSituation || "office", user.trainingDaysPerWeek || 3
    );
    await db.update(users).set({ calorieTarget: newCals, proteinTarget: newProt }).where(eq(users.phoneNumber, phone));
    const goalLabels: Record<string, string> = { fat_loss: "fat loss", muscle_gain: "muscle gain", recomposition: "body recomposition" };
    const clientName = user.name ? `, ${user.name}` : "";
    const goalReply = `Sharp${clientName}. Goal updated to ${goalLabels[pendingGoal] || pendingGoal}. New targets: ${newCals} kcal/day, ${newProt}g protein. Programme stays the same — reply *programme* to see it or *new programme* if you want one built from scratch.`;
    await logChat(user.id, message, goalReply, "PROFILE_UPDATE");
    return goalReply;
  }

  // ---- AWAITING GYM NAME — store gym name and deliver gym programme ----
  if (user.awaitingInputType === "gym_name") {
    const gymName = message.trim().length > 1 ? message.trim() : null;
    await db.update(users)
      .set({ awaitingInputType: null, trainingMode: "gym", gymName: gymName || user.gymName })
      .where(eq(users.phoneNumber, phone));
    const updatedUser = { ...user, trainingMode: "gym", gymName };
    const gymProg = buildFullProgramme(updatedUser);
    const clientName = user.name ? `, ${user.name}` : "";
    const gymReply = `Sharp${clientName}. ${gymName ? `${gymName}` : "Gym"} programme loaded. ${user.trainingDaysPerWeek || 3} days/week.\n\n${gymProg}`;
    await logChat(user.id, message, gymReply, "PROGRAMME_DELIVERY");
    return gymReply;
  }

  // ---- FIX 5: PROFILE UPDATE COMMANDS — expanded to catch training mode/days changes ----
  const isProfileUpdate =
    /\b(change my goal|my goal is now|switch to|switch my goal|new goal|update my goal)\b/i.test(m) ||
    /\b(change.*budget|budget.*changed|my budget is now|budget is now|new budget)\b/i.test(m) ||
    /\b(joined.*gym|got.*gym|have.*gym|going to.*gym|now.*gym|gym.*membership)\b/i.test(m) ||
    /\b(change.*training days|training.*(\d)\s*days|now training.*(\d)|(\d)\s*days.*week.*train)\b/i.test(m) ||
    /\b(training at home|working out at home|no.*gym.*more|quit.*gym|left.*gym|home.*workout.*now)\b/i.test(m) ||
    // FIX 5: catch "I want to gym X days a week", "train X days a week", "gym X days"
    /\b(want to gym|going to gym|start gym|gym.*\d+.*day|train.*\d+.*day|workout.*\d+.*day|\d+.*day.*gym|\d+.*day.*train|\d+.*day.*week)\b/i.test(m);

  if (isProfileUpdate) {
    const updates: Record<string, any> = {};
    let updateSummary = "";

    // Goal change — ask why first before applying
    let pendingGoal: string | null = null;
    if (/fat loss|lose weight|lose fat|cut/i.test(m)) pendingGoal = "fat_loss";
    else if (/muscle|bulk|build|gain/i.test(m)) pendingGoal = "muscle_gain";
    else if (/recomposition|recomp|both/i.test(m)) pendingGoal = "recomposition";

    if (pendingGoal && pendingGoal !== user.goalType) {
      const clientName = user.name ? `, ${user.name}` : "";
      await db.update(users).set({ awaitingInputType: `goal_reason:${pendingGoal}` }).where(eq(users.phoneNumber, phone));
      const whyReply = `Sharp${clientName}. What changed?`;
      await logChat(user.id, message, whyReply, "PROFILE_UPDATE");
      return whyReply;
    }

    // Budget change
    const budgetMatch = m.match(/r\s*(\d+)\s*(?:a\s*week|per\s*week|\/week|weekly)?/i)
      || m.match(/(\d+)\s*rand\s*(?:a\s*week|per\s*week)?/i);
    if (budgetMatch) {
      const rands = parseInt(budgetMatch[1]);
      const newBudget = rands < 50 ? "under_50" : rands < 100 ? "50_100" : rands < 300 ? "100_300" : rands < 500 ? "300_500" : "500_plus";
      updates.weeklyFoodBudget = newBudget;
      updateSummary += ` Budget updated to R${rands}/week tier.`;
    }

    // Training mode — ask which gym before applying
    if (/joined.*gym|got.*gym|have.*gym|going to.*gym|gym.*membership|now.*gym|want to gym|start.*gym|going to gym/i.test(m) && user.trainingMode !== "gym") {
      await db.update(users).set({ awaitingInputType: "gym_name" }).where(eq(users.phoneNumber, phone));
      const clientName = user.name ? `, ${user.name}` : "";
      const gymQ = `Lekker${clientName}. Which gym?`;
      await logChat(user.id, message, gymQ, "PROFILE_UPDATE");
      return gymQ;
    }
    if (/joined.*gym|got.*gym|have.*gym|going to.*gym|gym.*membership|now.*gym|want to gym|start.*gym|going to gym/i.test(m)) {
      updates.trainingMode = "gym";
      updateSummary += " Training mode updated to gym.";
    } else if (/home|no.*gym|quit.*gym|left.*gym/i.test(m)) {
      updates.trainingMode = "home";
      updateSummary += " Training mode updated to home.";
    }

    // Training days — catch "4 days a week", "gym 4 days", "train 4 days", etc.
    const trainingDaysMatch = m.match(/\b([2-6])\s*days?\s*(?:a\s*week|per\s*week|\/week)?/i)
      || m.match(/(?:gym|train|workout)\s+([2-6])\s*days?/i)
      || m.match(/([2-6])\s*days?\s*(?:a\s*week|per\s*week|at\s*the\s*gym)/i);
    if (trainingDaysMatch) {
      const days = parseInt(trainingDaysMatch[1]);
      if (days >= 2 && days <= 6) {
        updates.trainingDaysPerWeek = days;
        updateSummary += ` Training days updated to ${days}/week.`;
      }
    }

    if (Object.keys(updates).length > 0) {
      // Recalculate targets if weight-related fields changed
      if (updates.goalType || updates.trainingDaysPerWeek) {
        const currentWeight = parseFloat(user.currentWeight || "75");
        const newGoal = updates.goalType || user.goalType || "fat_loss";
        const newDays = updates.trainingDaysPerWeek || user.trainingDaysPerWeek || 3;
        const { calorieTarget, proteinTarget } = calculateTargets(currentWeight, newGoal, user.lifeSituation || "office", newDays);
        updates.calorieTarget = calorieTarget;
        updates.proteinTarget = proteinTarget;
        updateSummary += ` New targets: ${calorieTarget} kcal/day, ${proteinTarget}g protein.`;
      }
      await db.update(users).set(updates).where(eq(users.phoneNumber, phone));
      // If training mode or days changed, rebuild and show the programme immediately
      const clientName = user.name || "";
      let profileReply = "";
      if (updates.trainingMode || updates.trainingDaysPerWeek) {
        const updatedUser = { ...user, ...updates };
        const newProgramme = buildFullProgramme(updatedUser);
        const modeLabel = (updates.trainingMode || user.trainingMode || "home") === "gym" ? "Gym" : "Home";
        const daysLabel = updates.trainingDaysPerWeek || user.trainingDaysPerWeek || 3;
        profileReply = `Sharp${clientName ? `, ${clientName}` : ""}. ${daysLabel} days/week. ${modeLabel}. New programme built.\n\n${newProgramme}`;
      } else if (updates.goalType) {
        const goalLabel: Record<string, string> = { fat_loss: "fat loss", muscle_gain: "muscle gain", recomposition: "recomposition" };
        profileReply = `Sharp${clientName ? `, ${clientName}` : ""}. Goal updated to ${goalLabel[updates.goalType] || updates.goalType}. New targets: ${updates.calorieTarget} kcal/day, ${updates.proteinTarget}g protein. Programme stays the same — reply *programme* to see it.`;
      } else {
        profileReply = `Sharp. Profile updated. Reply *menu* to see your options.`;
      }
      await logChat(user.id, message, profileReply, "PROFILE_UPDATE");
      return profileReply;
    }
    // If we couldn't parse what to update, fall through to GPT
  }

  // ---- LANGUAGE DETECTION — prepend greeting if non-English ----
  const detectedLang = detectLanguage(m);
  const clientFirstName = user.name ? user.name.split(" ")[0] : null;
  // Retrieve stored language preference (may be more reliable than per-message detection)
  const storedLang = (user.profileNotes || "").match(/lang:([a-z]{2})/)?.[1] as import("./constants").SALanguage | undefined;
  const activeLang = detectedLang !== "en" ? detectedLang : (storedLang || "en");
  let langPrefix = "";
  if (clientFirstName) {
    switch (activeLang) {
      case "zu": langPrefix = `Sawubona ${clientFirstName}. `; break;
      case "xh": langPrefix = `Molo ${clientFirstName}. `; break;
      case "st": langPrefix = `Dumela ${clientFirstName}. `; break;
      case "tn": langPrefix = `Dumela ${clientFirstName}. `; break;
      case "ts": langPrefix = `Avuxeni ${clientFirstName}. `; break;
      case "af": langPrefix = `Dag ${clientFirstName}. `; break;
    }
  }

  // Store detected language on profile (update if language changed)
  if (detectedLang !== "en") {
    const langNote = `lang:${detectedLang}`;
    if (!user.profileNotes?.includes(langNote)) {
      const updatedNotes = (user.profileNotes || "").replace(/lang:[a-z]{2}/, langNote) || langNote;
      const finalNotes = updatedNotes.includes("lang:") ? updatedNotes : `${user.profileNotes ? user.profileNotes + " | " : ""}${langNote}`;
      db.update(users).set({ profileNotes: finalNotes }).where(eq(users.phoneNumber, phone)).catch(() => {});
    }
  }

  // ---- "AM I ON TRACK?" STATUS COMMAND — no GPT ----
  if (/\b(am i on track|on track\??|how am i doing|progress check|my status|status check|how have i been|weekly status)\b/i.test(m)) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const [stepLogsWeek, workoutLogsWeek, weightLogsRecent, foodLogsToday] = await Promise.all([
      db.select().from(stepLogs).where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sevenDaysAgo))),
      db.select({ id: workoutLogs.id }).from(workoutLogs).where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, sevenDaysAgo))),
      db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt }).from(weightLogs).where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, sevenDaysAgo))).orderBy(desc(weightLogs.loggedAt)).limit(3),
      db.select({ id: chatHistory.id }).from(chatHistory).where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart))),
    ]);
    const avgSteps = stepLogsWeek.length > 0 ? Math.round(stepLogsWeek.reduce((s: number, l: any) => s + l.steps, 0) / stepLogsWeek.length) : 0;
    const stepsTarget = user.stepsTarget || 7000;
    const workoutsDone = workoutLogsWeek.length;
    const workoutsTarget = user.trainingDaysPerWeek || 3;
    const stepsOk = avgSteps >= stepsTarget * 0.9;
    const workoutsOk = workoutsDone >= workoutsTarget;
    let weightNote = "";
    if (weightLogsRecent.length >= 2) {
      const diff = parseFloat(String(weightLogsRecent[0].weight)) - parseFloat(String(weightLogsRecent[weightLogsRecent.length - 1].weight));
      if (Math.abs(diff) < 0.2) weightNote = "Weight holding steady.";
      else if (diff < 0) weightNote = `Weight down ${Math.abs(diff).toFixed(1)}kg this week.`;
      else weightNote = `Weight up ${diff.toFixed(1)}kg this week.`;
    } else if (weightLogsRecent.length === 0) {
      weightNote = "No weight logged this week — log your weight.";
    }
    const allGood = stepsOk && workoutsOk;
    const bothBad = !stepsOk && !workoutsOk;
    const verdict = allGood ? "ON TRACK" : bothBad ? "NEEDS ATTENTION" : "CLOSE";
    const action = allGood
      ? "Keep this up for the rest of the week."
      : !workoutsOk
      ? `Complete ${workoutsTarget - workoutsDone} more workout${workoutsTarget - workoutsDone > 1 ? "s" : ""} this week.`
      : `Get your daily steps above ${stepsTarget.toLocaleString()}.`;
    const statusReply = `*7-Day Status — ${user.name || "you"}*\n\nWorkouts: ${workoutsDone}/${workoutsTarget} this week\nAvg steps: ${avgSteps.toLocaleString()} / ${stepsTarget.toLocaleString()} target\nFood logged today: ${foodLogsToday.length} ${foodLogsToday.length === 1 ? "meal" : "meals"}${weightNote ? `\n${weightNote}` : ""}\n\n*Verdict: ${verdict}*\n\n${action}`;
    await logChat(user.id, message, statusReply, "STATUS_CHECK");
    return statusReply;
  }

  // ---- FOOD DIARY SUMMARY — "what did I eat today?" — no GPT ----
  if (/\b(what.*(?:i eat|i ate|i had)|my food|food diary|food log|meals today|ate today|eaten today|log today|today.*food|food.*today|what.*eat.*today|how many.*calories|calories today|protein today|macros today)\b/i.test(m)) {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayLogs = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut })
      .from(chatHistory)
      .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)));
    if (todayLogs.length === 0) {
      const diaryReply = `No meals logged yet today. Log your first meal by describing what you ate — for example: "had 2 eggs and pap for breakfast".`;
      await logChat(user.id, message, diaryReply, "FOOD_DIARY");
      return diaryReply;
    }
    let totalCal = 0; let totalProt = 0;
    const mealLines: string[] = [];
    for (const log of todayLogs) {
      const msgIn = log.messageIn || "";
      const matched = scanForSAFoods(msgIn);
      if (matched.length > 0) {
        const mCal = matched.reduce((s: number, f: any) => s + (f.calories || 0), 0);
        const mProt = matched.reduce((s: number, f: any) => s + (f.protein || 0), 0);
        totalCal += mCal; totalProt += mProt;
        mealLines.push(`• ${matched.map((f: any) => f.name).join(", ")} — ~${mCal} kcal, ${mProt}g protein`);
      } else {
        // Try to extract kcal/protein numbers from GPT response
        const calMatch = (log.messageOut || "").match(/(\d+)\s*kcal/i);
        const protMatch = (log.messageOut || "").match(/(\d+)g?\s*protein/i);
        if (calMatch) totalCal += parseInt(calMatch[1]);
        if (protMatch) totalProt += parseInt(protMatch[1]);
        if (msgIn && msgIn !== "[Photo]") mealLines.push(`• ${msgIn.slice(0, 60)}`);
        else if (msgIn === "[Photo]") mealLines.push(`• Food photo logged`);
      }
    }
    const calTarget = user.calorieTarget || 1800;
    const protTarget = user.proteinTarget || 130;
    const calRemaining = calTarget - totalCal;
    const diaryLines = [
      `*Today's food log (${todayLogs.length} ${todayLogs.length === 1 ? "meal" : "meals"}):*`,
      ...mealLines,
      ``,
      `*Running total:* ~${totalCal} kcal | ${totalProt}g protein`,
      `*Target:* ${calTarget} kcal | ${protTarget}g protein`,
      calRemaining > 0 ? `*Remaining:* ~${calRemaining} kcal` : `*Status:* Over target by ~${Math.abs(calRemaining)} kcal`,
    ];
    const diaryReply = diaryLines.join("\n");
    await logChat(user.id, message, diaryReply, "FOOD_DIARY");
    return diaryReply;
  }

  // ---- SHOPPING LIST GENERATOR — no GPT ----
  if (/\b(shopping list|shop.*this week|what.*to buy|what.*buy.*week|buy.*groceries|grocery list|my list.*week|food.*list|week.*groceries)\b/i.test(m)) {
    const budget = user.weeklyFoodBudget || "100_300";
    const calTarget = user.calorieTarget || 1800;
    const protTarget = user.proteinTarget || 130;
    const goal = user.goalType || "fat_loss";
    const goalNote = goal === "fat_loss" ? "high protein, lower carbs, big on vegetables" : "high protein, moderate carbs, whole foods";
    let shoppingReply = "";
    if (budget === "under_50") {
      shoppingReply = `*Emergency Week Shopping — Under R50*\n\nEggs 6 pack — R22-28\nPilchards in tomato sauce 2 tins — R24-28\n\nTotal: ~R48\n\nThis covers protein for 3-4 days. Pair with pap from home. Buy at Shoprite or a tuck shop.`;
    } else if (budget === "50_100") {
      shoppingReply = `*Budget Week Shopping — R50-R100*\n\nEggs 12 pack — R40-48\nPilchards 3 tins — R36-42\nCabbage — R8-10\n\nTotal: ~R90\n\nBuy at Shoprite. Protein covered for 5 days. Cook eggs and pilchards in bulk. One pot on Sunday covers the week.`;
    } else if (budget === "100_300") {
      shoppingReply = `*Standard Week Shopping — R100-R300*\nTarget: ${protTarget}g protein/day | ${goalNote}\n\nEggs 18 pack — R65-75\nChicken thighs 1kg — R60-70\nPilchards 3 tins — R36-42\nSugar beans 500g — R18-22\nCabbage — R8-10\nOats 500g — R15-18\nSpinach bunch — R8-10\nOnions 3 pack — R10-14\nMaize meal 2kg — R18-22\n\nTotal: ~R240-280\n\nShop at Shoprite or Boxer. Cook Sunday. Chicken + beans is your go-to meal — 35g protein per portion.`;
    } else if (budget === "300_500") {
      shoppingReply = `*Mid-Range Week Shopping — R300-R500*\nTarget: ${protTarget}g protein/day | ${goalNote}\n\nChicken breasts 1.5kg — R110-130\nEggs 30 pack — R90-100\nGreek yoghurt 1kg — R55-70\nOats 1kg — R28-35\nSweet potato 1kg — R22-28\nFrozen hake 1kg — R55-70\nSpinach 2 bunches — R16-20\nTomatoes — R15-20\nOnions — R12-15\nCottage cheese 250g — R20-25\n\nTotal: ~R430-510\n\nShop at Checkers or PnP. Meal prep chicken and sweet potato Sunday. Oats + yoghurt for breakfast every day.`;
    } else {
      shoppingReply = `*Premium Week Shopping — R500+*\nTarget: ${protTarget}g protein/day | ${goalNote}\n\nChicken breasts 2kg — R150-180\nEggs 30 pack — R90-100\nGreek yoghurt 2x1kg — R110-140\nOats 1kg — R28-35\nSweet potato 2kg — R40-50\nSalmon or tuna steaks — R80-120\nBroccoli — R25-35\nSpinach — R16-20\nAvocados 4 pack — R40-60\nCottage cheese 500g — R40-50\nQuinoa 500g — R55-70\n\nTotal: ~R680-850\n\nShop at Checkers, PnP, or Woolworths. Quality matters here — fresh over frozen where possible.`;
    }
    await logChat(user.id, message, shoppingReply, "SHOPPING_LIST");
    return shoppingReply;
  }

  // ---- EVERYTHING ELSE → GPT decides ----
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString("en-ZA", { weekday: "long" });
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const clientName = user.name || "champ";
  const trainingMode = user.trainingMode || "home";
  const saContext = getSAContextFlags(user);

  // Fix 9 — Conversation context memory: last 10 exchanges, alternating Client/Coach K format
  let recentConvBlock = "";
  let recentChatText = "";
  try {
    const recentChats = await db.select().from(chatHistory)
      .where(eq(chatHistory.userId, user.id))
      .orderBy(desc(chatHistory.createdAt))
      .limit(10);
    if (recentChats.length > 0) {
      const ordered = recentChats.reverse();
      const thread = ordered.map(c => {
        const clientLine = c.messageIn ? `Client: "${(c.messageIn).slice(0, 150)}"` : "";
        const coachLine = c.messageOut ? `Coach K: "${(c.messageOut).slice(0, 150)}"` : "";
        return [clientLine, coachLine].filter(Boolean).join("\n");
      }).join("\n");
      recentChatText = thread;
      recentConvBlock = `\n\nRECENT CONVERSATION (last 10 exchanges — build on this, do not repeat):\n${thread}`;
    }
  } catch { }

  // Fix 5 — Ramadan check against recent chat history (in addition to profile notes)
  const RAMADAN_KW = ["ramadan", "ramadhan", "fasting", "iftar", "suhoor", "sehri", "muslim", "islam", "halaal", "halal"];
  if (recentChatText && RAMADAN_KW.some(kw => recentChatText.toLowerCase().includes(kw))) {
    const existingFlags = getSAContextFlags(user);
    if (!existingFlags.includes("RAMADAN")) {
      // User mentioned Ramadan in recent chat — inject flag into instruction
      recentConvBlock += `\n\nRAMADAN / FASTING ACTIVE: Client has mentioned Ramadan or fasting in recent messages. Train only after Iftar. Suhoor is the most critical meal — high protein, slow carbs. Adjust all meal timing advice to the eating window only.`;
    }
  }

  const instruction = `Today is ${dayOfWeek} ${timeOfDay}.${saContext ? "\n\n" + saContext : ""}${recentConvBlock}

RESPOND TO THIS CLIENT'S EXACT MESSAGE AS COACH K.

SCENARIO GUIDE — read the message and decide which applies:

WORKOUT / PROGRAMME REQUEST ("give me a program", "3 day", "full body", "training plan", "what do I do today", "1", "2", "workout", etc.):
  Tell the client their programme is ready and to reply with the word "programme" to see the full plan. Do not list exercises here.

STEPS LOGGED (number + "steps" / "walked" / "km"):
  Respond based on their step target of ${user.stepsTarget || 7000}. If below — push them. If at or above — celebrate and give next action.

FOOD / MEAL LOGGED (any food item or meal described):
  Coach specifically on THAT exact food. Use the SA food database. Estimate SA portion calories and protein. If junk — acknowledge without shaming, give one specific swap. If good — celebrate and connect to their ${user.goalType || "fat loss"} goal. Never end with a protein warning. Never give generic advice.

BROKE / BUDGET / MONTH-END / NO MONEY:
  Full affordable plan: Oats R15 (500g, lasts 1 week) — one cup oats + peanut butter = 400 kcal 20g protein. Eggs R25 (12 eggs) — 2 eggs = 160 kcal 12g protein. Pilchards R12 (1 tin) — full tin = 200 kcal 24g protein. Sugar beans R20 (dry 500g) — cooked cup = 220 kcal 15g protein. Peanut butter R25 (lasts 2 weeks). Brown bread R14. Total under R110. Explain how to use each one practically.

WEIGHT LOGGED (number + "kg"):
  Acknowledge. If weight went up — explain water retention, sodium, hormones. Do NOT panic them. Stay on programme. If weight went down — celebrate specifically. If same — consistency wins over weeks.

NUTRITION AND CALORIE INTELLIGENCE:
  You are a qualified fitness and nutrition coach. When a client tells you their weight and goal calculate the correct calorie and protein targets using standard sports nutrition formulas. Show the calculation. State the result. When a client has an injury or medical condition reason about what is safe and build accordingly. When a client's stated information conflicts with their stored profile trust what they are telling you right now and recalculate everything. Do not wait to be told the formula. You know the formula. Use it.

WATER LOGGED ("drank", "litre", "ml", "bottle", "glass"):
  One sentence acknowledgment. Reference how much they logged. No generic tips.

SLEEP LOGGED (number + "hours" / "slept"):
  Under 6 hours — coach firmly on sleep and fat loss link. Give one practical fix for tonight. 7-9 hours — solid, connect to results. Over 9 — check if they are ill or stressed.

PERIOD / MENSTRUAL:
  Normalise. Lighter sessions are fine. No guilt. Hydration and iron-rich foods.

SUPPLEMENTS ("creatine", "protein powder", "pre-workout"):
  Creatine — worth it, 5g daily, no cycling. Protein powder — food not magic, use if struggling to hit ${user.proteinTarget || 120}g from whole foods. Everything else optional. Food first always.

RAMADAN / FASTING:
  Train after Iftar. Suhoor = most important meal of the day. Protein priority at Iftar. Light cardio only if fasting during day.

TRAVELLING / HOTEL:
  4 exercises, hotel room, bodyweight only, sets x reps. No equipment assumed.

ALCOHOL:
  Coach forward. Acknowledge it happened. One practical next step. Never shame.

DIABETES / BLOOD SUGAR:
  Low GI carbs. Consistent meal timing. Train 1-2 hours after eating. Never skip meals.

CULTURAL EVENT (church, funeral, lobola, umemulo):
  Acknowledge its importance. Enjoy it fully. Protein first on the plate. No guilt. Back on programme next meal.

JOINED THE GYM:
  Welcome it with one sentence. Update training to gym. Give full gym programme.

TIRED / LOW ENERGY:
  DO NOT mention water. Ask about sleep first, then food timing, then stress.

INJURY MENTIONED:
  Give specific alternative exercises that route around the injury.

GENERAL QUESTION:
  Answer with SA coaching knowledge. Specific. Practical.

WHATSAPP FORMAT RULES — apply to every single response:
These messages are read on a phone screen. Never write an essay. Format depends on the response type:

SIMPLE COACHING RESPONSE: 2 to 3 sentences maximum. One specific action at the end. No bullet points. No asterisks. Plain text only.

PROGRAMME DELIVERY: Use bold day headers. Each exercise on its own line: exercise name, sets and reps, YouTube link, one form cue, one common mistake. Separate each day with a line break. Bold is allowed here.

MEAL PLAN DELIVERY: Each meal on its own block: meal name, ingredients, estimated calories and protein, preparation time. Always state the cost in rands. Bold meal names are allowed here.

CALCULATION RESPONSE: Show the formula. Show the numbers. State the result clearly. Add one sentence explaining what this specific result means for this client's goal. No padding.

CRISIS RESPONSE: Short. Warm. Direct. Give the support resources first — Samaritans SA 0800 567 567. Say nothing else until they respond.

MILESTONE CELEBRATION: Energetic, specific, personal. Reference something real and measurable from their journey — a number, a first, a behaviour change. Never use generic praise like "You're amazing" or "I'm so proud of you."

BANNED PHRASES — never say these under any circumstances:
- "You seem surprised"
- "Eish, what's going on" as a generic opener
- "How can I help you today" or any variation
- "I hope this helps"
- "Let me know" in any form
- "I understand" as a standalone sentence
- "Great question"
- "Absolutely" or "Certainly" or "Of course"
- "Feel free to ask" or "Feel free to reach out"
- "You've got this" as a standalone sentence
- "Stay hydrated" as a default response
These are app phrases. Coach K does not use them. Coach K responds to what the client actually said — not to how they said it.

QUESTION RULE: Never end a response with a question unless you genuinely need specific information to coach better. If a question is needed — ask exactly one. Single and specific. Never two questions in one response.

FORMATTING RULE: Never use asterisks for bold in conversational responses. Asterisks and bold are only allowed in programme delivery and meal plan delivery.

CRITICAL RULES — these are non-negotiable:
- Client's name is ${clientName}. Never call them "a client", "Hi client", or "champ" if you have a real name.
- NEVER say "drink 2 litres of water" as a response to anything except a water question.
- Pilchards ARE an excellent protein source — never say otherwise.
- Never append a protein warning at the end of a food coaching response.
- Never mention AI, bot, system, or technology.
- Never use a motivational quote as a standalone response.
- Maximum 3 sentences and 60 words for conversational responses. Exception: programme and meal plan delivery may be longer.
- Always end with exactly one specific action the client must take right now.
- SA voice throughout: real, warm, firm, direct.`;

  // ---- DIABETES-SPECIFIC COACHING (Item 19) — inject context into instruction ----
  const isDiabetic = (user.medicalConditions || "").includes("diabetes");
  const isNutritionOrExerciseQ = /\b(eat|food|meal|carb|sugar|glucose|blood sugar|exercise|train|workout|walk|steps|insulin|medication|metformin)\b/i.test(m);
  let finalInstruction = instruction;
  if (isDiabetic && isNutritionOrExerciseQ) {
    finalInstruction = `DIABETES COACHING ACTIVE: This client has diabetes. Apply ALL of the following:\n- Low GI carbs only: samp and beans, oats, sweet potato, brown rice. Never white pap alone.\n- Never recommend skipping meals — blood sugar stability is critical.\n- Train 1-2 hours after eating, never fasted.\n- Consistent meal timing is non-negotiable — same times every day.\n- Metformin causes nausea if taken without food — always advise with a meal.\n- Weight loss of even 5% significantly improves insulin sensitivity — celebrate every kg lost.\n\n` + instruction;
  }

  // ---- MENSTRUAL CYCLE AWARENESS — adjust coaching for cycle phase ----
  const isFemaleContext = (user.profileNotes || "").includes("menstrual") ||
    /\b(period|my period|pms|cycle|time of month|ovulation|menstrual|cramps|bloated.*period|hormones)\b/i.test(m);
  if (isFemaleContext) {
    // Store cycle day 1 if client mentions period starting
    if (/\b(period.*start|started.*period|period.*came|got.*period|cycle.*start|day.*one|day 1.*period)\b/i.test(m)) {
      const cycleMarker = `menstrual_day1:${new Date().toISOString().slice(0, 10)}`;
      const existingNotes = user.profileNotes || "";
      const updatedNotes = existingNotes.replace(/menstrual_day1:\d{4}-\d{2}-\d{2}/, cycleMarker) || `${existingNotes} ${cycleMarker}`.trim();
      await db.update(users).set({ profileNotes: updatedNotes }).where(eq(users.phoneNumber, phone));
    }
    // Calculate cycle phase from stored day 1
    const cycleMatch = (user.profileNotes || "").match(/menstrual_day1:(\d{4}-\d{2}-\d{2})/);
    let cycleContext = "";
    if (cycleMatch) {
      const day1 = new Date(cycleMatch[1]);
      const cycleDay = Math.floor((Date.now() - day1.getTime()) / 86_400_000) % 28 + 1;
      if (cycleDay >= 1 && cycleDay <= 5) {
        cycleContext = `MENSTRUAL PHASE (days 1-5): Client is menstruating. Reduce training intensity by 20-30% — light weights, longer rests, walking over running. Higher iron needs — encourage red meat, beans, spinach. Gentle on carbs — sweet potato and oats for stable energy. Acknowledge cramps and fatigue as real physiological responses, not excuses. Never push heavy training today.`;
      } else if (cycleDay >= 6 && cycleDay <= 13) {
        cycleContext = `FOLLICULAR PHASE (days 6-13): Oestrogen rising. Best phase for strength gains and high-intensity training. Energy is high. Push hard on workouts this week — progressive overload is most effective now. Lean protein critical. This is her best training window of the month.`;
      } else if (cycleDay >= 14 && cycleDay <= 16) {
        cycleContext = `OVULATION PHASE (days 14-16): Peak energy and strength. Maximum training capacity. Encourage her hardest session of the month here if she feels good. High protein. Keep carbs moderate.`;
      } else {
        cycleContext = `LUTEAL PHASE (days 17-28): Progesterone rising. Energy and mood may dip in the second half of this phase. Carb cravings are real and hormonal — direct her to complex carbs (sweet potato, oats) not sugar. Reduce workout intensity slightly in final days (24-28). Acknowledge PMS symptoms as physiological. Never shame cravings — redirect to better choices.`;
      }
    } else {
      cycleContext = `FEMALE CLIENT CYCLE CONTEXT: Client has mentioned her cycle or period. Acknowledge this with empathy. Adjust training and nutrition advice accordingly. Ask which day of her cycle she is on if it helps give better advice.`;
    }
    if (cycleContext) finalInstruction = `${cycleContext}\n\n${finalInstruction}`;
  }

  // ---- MEMORY: retrieve relevant memories for this message ----
  let memoryContext = "";
  try {
    const memories = await retrieveMemories(phone, message);
    if (memories.length > 0) memoryContext = memories.join("\n");
  } catch { }

  // ---- AGENT ROUTER: send to the right specialist, fall back to askCoachK on failure ----
  const agentType = routeToAgent(message);
  let gptReply: string;
  const AGENT_ERROR = "Eish Coach K had a moment. Try that again.";

  try {
    if (agentType === "nutrition") {
      gptReply = await nutritionAgent(user, message, memoryContext, saContext);
    } else if (agentType === "programming") {
      const prog = getKamlifeProgramme(user);
      gptReply = await programmingAgent(user, message, memoryContext, prog, saContext);
    } else if (agentType === "mindset") {
      const dataPoint = `${user.totalWorkoutsCompleted || 0} workouts completed, ${user.programmeWeek || 1} weeks on programme`;
      gptReply = await mindsetAgent(user, message, memoryContext, dataPoint, saContext);
    } else if (agentType === "admin") {
      const targetValue = `Calorie target: ${user.calorieTarget || 1800} kcal | Protein target: ${user.proteinTarget || 130}g | Steps target: ${user.stepsTarget || 7000}`;
      gptReply = await adminAgent(user, message, "log", message, targetValue);
    } else {
      gptReply = await askCoachK(message, user, finalInstruction, memoryContext);
    }
    // If specialist agent returned its own error string, fall back to full Coach K
    if (gptReply === AGENT_ERROR) {
      gptReply = await askCoachK(message, user, finalInstruction, memoryContext);
    }
  } catch {
    gptReply = await askCoachK(message, user, finalInstruction, memoryContext);
  }

  const finalReply = langPrefix ? `${langPrefix}${gptReply}` : gptReply;

  // ---- MEMORY: store important facts for future sessions ----
  try {
    if (/\b(injury|injured|hurt|pain|bad knee|bad back|bad shoulder|bad hip)\b/i.test(m)) {
      await storeMemory(phone, `Client reported injury: "${message}"`, "medical");
    } else if (/\b(allergic|allergy|intolerant|can't eat|cannot eat|dairy free|gluten free|peanut allergy)\b/i.test(m)) {
      await storeMemory(phone, `Client dietary restriction: "${message}"`, "medical");
    } else if (/\b(diabetes|diabetic|hypertension|pcos|hiv|tb |tuberculosis|pregnant|epilepsy)\b/i.test(m)) {
      await storeMemory(phone, `Client medical condition: "${message}"`, "medical");
    } else if (/\b(i prefer|i hate|i love|don't like|can't stand|favourite food|i always eat|i never eat)\b/i.test(m)) {
      await storeMemory(phone, `Client food or training preference: "${message}"`, "preference");
    } else if (/\b(quit|give up|want to stop|not working|no results|nothing is changing)\b/i.test(m)) {
      await storeMemory(phone, `Client struggled with motivation: "${message}"`, "mindset");
    } else if (/\b(hit my goal|reached my goal|lost.*kg|gained.*kg|pb|personal best|new record)\b/i.test(m)) {
      await storeMemory(phone, `Client milestone: "${message}"`, "milestone");
    }
  } catch { }

  // ---- FOOD PATTERN CHECK — append warning if junk/protein pattern detected ----
  const FOOD_KEYWORDS = ["ate", "had", "eating", "breakfast", "lunch", "dinner", "supper", "meal", "food", "pap", "rice", "bread", "chicken", "beef", "fish", "pilchards", "eggs", "oats", "kfc", "burger", "pizza", "vetkoek", "kota", "chips", "cool drink", "coke", "biscuit", "chocolate", "sweets", "yogurt", "beans", "lentils", "mince", "polony", "viennas", "russian", "magwinya", "fat cake", "samp", "morogo", "spinach", "peanut butter", "tuna", "sardines"];
  const isFoodLog = FOOD_KEYWORDS.some(k => m.includes(k));
  if (isFoodLog) {
    const pattern = await checkFoodPatterns(user.id);
    const perfectDay = await checkPerfectDay(user.id);
    // ---- Calorie running total for the day ----
    let dailyTotal = "";
    try {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayFoodLogs = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)));
      let totalCal = 0; let totalProt = 0;
      // Include current message in the scan
      const allMsgs = [...todayFoodLogs.map((l: any) => l.messageIn || ""), m];
      for (const msg of allMsgs) {
        const matched = scanForSAFoods(msg);
        if (matched.length > 0) {
          totalCal += matched.reduce((s: number, f: any) => s + (f.calories || 0), 0);
          totalProt += matched.reduce((s: number, f: any) => s + (f.protein || 0), 0);
        }
      }
      const calTarget = user.calorieTarget || 1800;
      const protTarget = user.proteinTarget || 130;
      if (totalCal > 0) {
        const remaining = calTarget - totalCal;
        dailyTotal = `\n\n_Today so far: ~${totalCal} kcal | ${totalProt}g protein. Target: ${calTarget} kcal | ${protTarget}g protein.${remaining > 100 ? ` ${remaining} kcal remaining.` : remaining < -100 ? ` Over by ${Math.abs(remaining)} kcal.` : " On target."}_`;
      }
    } catch { /* non-fatal */ }
    const damageControl = await getDamageControlNote(user.id, message);
    const fullReply = finalReply + (pattern ? "\n\n" + pattern : "") + (perfectDay || "") + dailyTotal + damageControl;
    await logChat(user.id, message, fullReply, "FOOD_LOG");
    return fullReply;
  }

  return finalReply;

  } catch (err) {
    console.error("[handleMessage FATAL]", phone, message, err);
    return "Eish, something went wrong on my side. Give me a second and try again.";
  }
}

// ============================================================
// LOG CHAT HELPER
// ============================================================

async function logChat(userId: string, messageIn: string, messageOut: string, intent: string): Promise<void> {
  try {
    await db.insert(chatHistory).values({ userId, messageIn, messageOut, intent });
  } catch (err) {
    console.error("Chat log error:", err);
  }
}

// ============================================================
// RATE LIMITER — 15 messages per phone per 60 seconds
// ============================================================

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap.entries()) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000);

function checkRateLimit(phone: string): boolean {
  const now = Date.now();
  const window = 60 * 1000;
  const entry = rateLimitMap.get(phone);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(phone, { count: 1, resetAt: now + window });
    return true;
  }
  if (entry.count >= 15) return false;
  entry.count++;
  return true;
}

// ============================================================
// REGISTER EXPRESS ROUTES
// ============================================================

export async function registerRoutes(server: Server, app: Express): Promise<void> {

  // ── REST API for admin dashboard ──────────────────────────

  app.get("/api/users", async (_req, res) => {
    try {
      const all = await db.select().from(users).orderBy(desc(users.createdAt));
      res.json(all);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  app.get("/api/users/:id", async (req, res) => {
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

  app.get("/api/admin/flagged", async (_req, res) => {
    try {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const inactive = await db.select().from(users).where(
        and(
          eq(users.onboardingState, "COMPLETE"),
        )
      );
      const flagged = inactive.filter(u => !u.lastActiveAt || new Date(u.lastActiveAt) < threeDaysAgo);
      res.json(flagged);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch flagged users" });
    }
  });

  app.get("/api/admin/beta-testers", async (_req, res) => {
    try {
      const all = await db.select().from(users).where(eq(users.subscriptionStatus, "trial")).orderBy(desc(users.createdAt));
      res.json(all);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch beta testers" });
    }
  });

  // ---- ADMIN: Send message to a client directly ----
  app.post("/api/admin/send-message", async (req, res) => {
    const { userId, message: adminMessage } = req.body;
    if (!userId || !adminMessage?.trim()) {
      return res.status(400).json({ error: "userId and message are required" });
    }
    try {
      const [targetUser] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!targetUser) return res.status(404).json({ error: "User not found" });
      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_WHATSAPP_NUMBER) {
        return res.status(503).json({ error: "Twilio not configured — message not sent" });
      }
      const adminTwilio = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const fromNum = process.env.TWILIO_WHATSAPP_NUMBER.startsWith("whatsapp:") ? process.env.TWILIO_WHATSAPP_NUMBER : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
      const toNum = targetUser.phoneNumber.startsWith("whatsapp:") ? targetUser.phoneNumber : `whatsapp:${targetUser.phoneNumber}`;
      await adminTwilio.messages.create({ from: fromNum, to: toNum, body: adminMessage.trim() });
      await db.insert(chatHistory).values({ userId: targetUser.id, messageIn: null, messageOut: adminMessage.trim(), intent: "ADMIN_MANUAL" });
      return res.json({ success: true, sentTo: targetUser.name || targetUser.phoneNumber });
    } catch (err: any) {
      console.error("[ADMIN] Send message failed:", err);
      return res.status(500).json({ error: err.message || "Failed to send message" });
    }
  });

  app.post("/api/admin/run-test", async (req, res) => {
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

  // ── WhatsApp webhook ──────────────────────────────────────

  function escapeXml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  // Fix 1 — splitMessage: split on day separators first, then char boundaries
  function splitMessage(text: string, maxLen = 1500): string[] {
    // Programme day separator — each day is one complete WhatsApp message
    if (/\n\n---\n\n/.test(text)) {
      const days = text.split(/\n\n---\n\n/);
      const result: string[] = [];
      for (const day of days) {
        if (day.trim()) result.push(...splitMessage(day.trim(), maxLen));
      }
      return result;
    }
    if (text.length <= maxLen) return [text];
    const lines = text.split("\n");
    const chunks: string[] = [];
    let current = "";
    for (const line of lines) {
      const candidate = current ? current + "\n" + line : line;
      if (candidate.length > maxLen) {
        if (current) chunks.push(current.trim());
        // If single line itself is over maxLen, split at last space before limit
        if (line.length > maxLen) {
          let remaining = line;
          while (remaining.length > maxLen) {
            const cutAt = remaining.lastIndexOf(" ", maxLen);
            const breakAt = cutAt > 0 ? cutAt : maxLen;
            chunks.push(remaining.slice(0, breakAt).trim());
            remaining = remaining.slice(breakAt).trim();
          }
          current = remaining;
        } else {
          current = line;
        }
      } else {
        current = candidate;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.filter(Boolean);
  }

  app.post("/twilio/whatsapp", async (req, res) => {
    try {
      // ---- Twilio signature verification (skip in development) ----
      if (process.env.NODE_ENV !== "development") {
        const authToken = process.env.TWILIO_AUTH_TOKEN || "";
        const signature = (req.headers["x-twilio-signature"] as string) || "";
        const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
        const valid = twilio.validateRequest(authToken, signature, fullUrl, req.body);
        if (!valid) {
          console.warn(`Twilio signature validation failed from ${req.ip}`);
          return res.status(403).end();
        }
      }

      // ---- Rate limiter ----
      const rawPhoneEarly = (req.body.From || "") as string;
      const phoneKey = rawPhoneEarly.replace(/^(whatsapp:)\s+/, "$1+");
      if (!checkRateLimit(phoneKey)) {
        return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Too many messages. Wait 60 seconds.</Message></Response>`);
      }

      // Twilio sometimes sends '+' as a literal '+' in form data; URL decoders
      // convert that to a space. Normalise 'whatsapp: 27...' → 'whatsapp:+27...'
      const rawPhone = rawPhoneEarly;
      const phone = rawPhone.replace(/^(whatsapp:)\s+/, "$1+");
      const message = (req.body.Body || "").trim();
      const mediaUrl = req.body.MediaUrl0 || undefined;
      const mediaContentType = req.body.MediaContentType0 || undefined;

      if (!phone || (!message && !mediaUrl)) {
        return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
      }

      const reply = await handleMessage(phone, message, mediaUrl, mediaContentType);

      const user = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
      if (user.length > 0) {
        await logChat(user[0].id, message, reply, "GPT");
      }

      // Fix 1 — split long replies into multiple TwiML messages (WhatsApp cap ~1600 chars)
      const chunks = splitMessage(reply);
      const messageXml = chunks.map(c => `<Message>${escapeXml(c)}</Message>`).join("");
      return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response>${messageXml}</Response>`);
    } catch (err) {
      console.error("Webhook error:", err);
      return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Something went wrong. Try again in a moment.</Message></Response>`);
    }
  });

  // ── Admin test harness webhook ────────────────────────────

  app.post("/api/admin/test-webhook", async (req, res) => {
    try {
      const { phone, message } = req.body;
      if (!phone || !message) return res.status(400).json({ message: "phone and message required" });
      const reply = await handleMessage(phone, message);
      res.json({ reply });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Health check ──────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "KamLife Coach", timestamp: new Date().toISOString() });
  });

  // ── Voice note file serving ────────────────────────────────
  // Serves TTS-generated MP3s for milestone voice notes
  app.get("/voice/:id.mp3", (req, res) => {
    const { existsSync } = require("fs");
    const { join } = require("path");
    const filePath = join(process.cwd(), "tmp", "voice", `${req.params.id}.mp3`);
    if (!existsSync(filePath)) return res.status(404).end();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.sendFile(filePath);
  });

  // ── Addition 7: Coach Dashboard API — protected by DASHBOARD_API_KEY ─────

  function requireDashboardKey(req: any, res: any, next: any) {
    const key = process.env.DASHBOARD_API_KEY;
    const provided = req.headers["x-dashboard-key"] || req.query.key;
    if (key && provided !== key) return res.status(403).json({ error: "Forbidden" });
    next();
  }

  app.get("/api/dashboard/clients", requireDashboardKey, async (_req, res) => {
    try {
      const all = await db.select().from(users).where(eq(users.onboardingState, "COMPLETE")).orderBy(desc(users.lastActiveAt));
      const now = Date.now();
      const weekAgo = new Date(now - 7 * 86400000);

      const result = await Promise.all(all.map(async (u) => {
        const thisWeekLogs = await db.select().from(chatHistory)
          .where(and(eq(chatHistory.userId, u.id), gte(chatHistory.createdAt, weekAgo)))
          .limit(50);
        const lastActive = u.lastActiveAt ? new Date(u.lastActiveAt).getTime() : 0;
        const sinceLastMsg = now - lastActive;
        const status = sinceLastMsg < 24 * 3600000 ? "green" : sinceLastMsg < 48 * 3600000 ? "yellow" : "red";
        const programmeDays = u.programmeStartDate
          ? Math.floor((now - new Date(u.programmeStartDate).getTime()) / 86400000) : 0;
        return {
          id: u.id,
          name: u.name,
          phone: u.phoneNumber,
          onboardingState: u.onboardingState,
          lastMessageAt: u.lastActiveAt,
          programmeDays,
          thisWeekLogCount: thisWeekLogs.length,
          status,
        };
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch clients" });
    }
  });

  app.get("/api/dashboard/client/:phone", requireDashboardKey, async (req, res) => {
    try {
      const phoneParam = decodeURIComponent(req.params.phone);
      const [client] = await db.select().from(users).where(eq(users.phoneNumber, phoneParam)).limit(1);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000);
      const [weights, steps, workouts, chats] = await Promise.all([
        db.select().from(weightLogs).where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, fourteenDaysAgo))).orderBy(asc(weightLogs.loggedAt)),
        db.select().from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, fourteenDaysAgo))).orderBy(asc(stepLogs.loggedAt)),
        db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, fourteenDaysAgo))).orderBy(desc(workoutLogs.loggedAt)),
        db.select().from(chatHistory).where(eq(chatHistory.userId, client.id)).orderBy(desc(chatHistory.createdAt)).limit(100),
      ]);
      const liveTargets = calculateTargets(parseFloat(client.currentWeight || "75"), client.goalType || "fat_loss", client.lifeSituation || "office", client.trainingDaysPerWeek || 3);
      const programmeDays = client.programmeStartDate ? Math.floor((Date.now() - new Date(client.programmeStartDate).getTime()) / 86400000) : 0;

      res.json({ client, weightLogs: weights, stepLogs: steps, workoutLogs: workouts, chatHistory: chats, liveTargets, programmeDays });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch client" });
    }
  });

  app.get("/api/dashboard/metrics", requireDashboardKey, async (_req, res) => {
    try {
      const allComplete = await db.select().from(users).where(eq(users.onboardingState, "COMPLETE"));
      const now = Date.now();
      const weekAgo = new Date(now - 7 * 86400000);
      const twoWeeksAgo = new Date(now - 14 * 86400000);

      const activeClients = allComplete.length;
      const newThisWeek = allComplete.filter(u => u.createdAt && new Date(u.createdAt) >= weekAgo).length;
      const churnedThisWeek = allComplete.filter(u => u.lastActiveAt && new Date(u.lastActiveAt) < twoWeeksAgo).length;

      const allChats = await db.select().from(chatHistory).where(gte(chatHistory.createdAt, weekAgo));
      const avgMessagesPerDay = activeClients > 0 ? Math.round(allChats.length / 7 / activeClients * 10) / 10 : 0;

      res.json({
        activeClients,
        newThisWeek,
        churnedThisWeek,
        avgMessagesPerClientPerDay: avgMessagesPerDay,
        totalRevenuePlaceholder: activeClients * 99,
        currency: "ZAR",
        note: "Revenue figure is a placeholder — integrate PayFast webhooks to get real payment data",
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch metrics" });
    }
  });

  app.post("/api/dashboard/broadcast", requireDashboardKey, async (req, res) => {
    try {
      const { message: broadcastMsg, filter = "all" } = req.body;
      if (!broadcastMsg) return res.status(400).json({ error: "message is required" });

      const twilioClient2 = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const fromNum = process.env.TWILIO_WHATSAPP_NUMBER ? `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:/, "")}` : "";
      if (!fromNum) return res.status(500).json({ error: "TWILIO_WHATSAPP_NUMBER not configured" });

      const allComplete = await db.select().from(users).where(eq(users.onboardingState, "COMPLETE"));
      const now = Date.now();
      const twoWeeksAgo = new Date(now - 14 * 86400000);
      const twoDaysAgo = new Date(now - 48 * 3600000);

      let targets = allComplete;
      if (filter === "active") targets = allComplete.filter(u => u.lastActiveAt && new Date(u.lastActiveAt) >= twoDaysAgo);
      if (filter === "atrisk") targets = allComplete.filter(u => !u.lastActiveAt || new Date(u.lastActiveAt) < twoWeeksAgo);

      let sent = 0;
      let failed = 0;
      for (const u of targets) {
        try {
          await twilioClient2.messages.create({ from: fromNum, to: u.phoneNumber, body: broadcastMsg });
          sent++;
        } catch { failed++; }
      }
      res.json({ sent, failed, total: targets.length });
    } catch (err) {
      res.status(500).json({ error: "Broadcast failed" });
    }
  });

  // ============================================================
  // TWILIO DELIVERY STATUS WEBHOOK — POST /webhook/status
  // Twilio calls this for every message to report delivery result
  // Configure in Twilio console: Status Callback URL = https://yourdomain/webhook/status
  // ============================================================
  app.post("/webhook/status", (req: any, res: any) => {
    res.sendStatus(200); // Always 200 first, then process
    try {
      const { MessageSid, MessageStatus, To, ErrorCode, ErrorMessage } = req.body;
      if (MessageStatus === "failed" || MessageStatus === "undelivered") {
        const phone = (To || "").replace(/^whatsapp:/, "");
        console.error(`[DELIVERY FAIL] ${phone} | SID: ${MessageSid} | Status: ${MessageStatus} | Error: ${ErrorCode} — ${ErrorMessage || "no detail"}`);
        // Update lastActiveAt to signal possible delivery problem
        db.update(users)
          .set({ lastActiveAt: users.lastActiveAt }) // no-op update, just for logging
          .where(eq(users.phoneNumber, phone))
          .catch(() => {});
        // Log to chatHistory for dashboard visibility
        db.select({ id: users.id }).from(users).where(eq(users.phoneNumber, phone)).limit(1)
          .then(rows => {
            if (rows[0]) {
              db.insert(chatHistory).values({
                userId: rows[0].id,
                messageIn: null,
                messageOut: null,
                intent: `DELIVERY_${MessageStatus.toUpperCase()}`,
              }).catch(() => {});
            }
          }).catch(() => {});
      } else if (MessageStatus === "delivered") {
        const phone = (To || "").replace(/^whatsapp:/, "");
        console.log(`[DELIVERY OK] ${phone} | SID: ${MessageSid}`);
      }
    } catch (e) {
      console.error("[DELIVERY STATUS] Parse error:", e);
    }
  });

  // ============================================================
  // COACH ADMIN DASHBOARD — GET /coach?key=COACH_DASHBOARD_KEY
  // ============================================================
  app.get("/coach", async (req: any, res: any) => {
    const key = req.query.key as string;
    if (key !== (process.env.COACH_DASHBOARD_KEY || "kamlife2024")) {
      return res.status(401).send("<h1>Unauthorized</h1>");
    }
    try {
      const now = Date.now();
      const sevenDaysAgo = new Date(now - 7 * 86400000);
      const fourteenDaysAgo = new Date(now - 14 * 86400000);

      // Run all queries in parallel
      const [
        totalUsersRows,
        activeRows,
        silentSevenRows,
        silentFourteenRows,
        totalWorkoutsRows,
        totalStepsRows,
        allCompleteUsers,
        weekThreeUsers,
        newThisWeekUsers,
      ] = await Promise.all([
        db.select({ count: sql<number>`COUNT(*)` }).from(users).where(eq(users.onboardingState, "COMPLETE")),
        db.select({ count: sql<number>`COUNT(*)` }).from(users).where(and(eq(users.onboardingState, "COMPLETE"), gte(users.lastActiveAt, sevenDaysAgo))),
        db.select({ count: sql<number>`COUNT(*)` }).from(users).where(and(eq(users.onboardingState, "COMPLETE"), lt(users.lastActiveAt, sevenDaysAgo))),
        db.select({ count: sql<number>`COUNT(*)` }).from(users).where(and(eq(users.onboardingState, "COMPLETE"), lt(users.lastActiveAt, fourteenDaysAgo))),
        db.select({ count: sql<number>`COUNT(*)` }).from(workoutLogs),
        db.select({ total: sql<string>`COALESCE(SUM(steps), 0)` }).from(stepLogs),
        db.select().from(users).where(and(eq(users.onboardingState, "COMPLETE"), lt(users.lastActiveAt, sevenDaysAgo))).orderBy(asc(users.lastActiveAt)),
        db.select().from(users).where(and(eq(users.onboardingState, "COMPLETE"), eq(users.programmeWeek, 3))),
        db.select().from(users).where(and(eq(users.onboardingState, "COMPLETE"), gte(users.createdAt, sevenDaysAgo))).orderBy(desc(users.createdAt)),
      ]);

      // Goal breakdown from allCompleteUsers (already fetched)
      const allComplete = await db.select().from(users).where(eq(users.onboardingState, "COMPLETE"));
      const goalCounts: Record<string, number> = {};
      const budgetCounts: Record<string, number> = {};
      for (const u of allComplete) {
        const g = (u as any).goalType || "unknown";
        goalCounts[g] = (goalCounts[g] || 0) + 1;
        const b = (u as any).budgetTier || "unknown";
        budgetCounts[b] = (budgetCounts[b] || 0) + 1;
      }

      const totalClients = Number((totalUsersRows[0] as any)?.count ?? 0);
      const activeCount = Number((activeRows[0] as any)?.count ?? 0);
      const silentSeven = Number((silentSevenRows[0] as any)?.count ?? 0);
      const silentFourteen = Number((silentFourteenRows[0] as any)?.count ?? 0);
      const totalWorkouts = Number((totalWorkoutsRows[0] as any)?.count ?? 0);
      const totalSteps = Number((totalStepsRows[0] as any)?.total ?? 0);
      const timestamp = new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" });

      const fmtDate = (d: any) => {
        if (!d) return "Never";
        const dt = new Date(d);
        return dt.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
      };
      const maskPhone = (p: string | null | undefined) => {
        if (!p) return "—";
        const digits = p.replace(/\D/g, "");
        return "****" + digits.slice(-4);
      };
      const daysSince = (d: any) => {
        if (!d) return 999;
        return Math.floor((now - new Date(d).getTime()) / 86400000);
      };

      const atRiskRows = allCompleteUsers.map((u: any) => {
        const days = daysSince(u.lastActiveAt);
        const rowBg = days >= 14 ? "#3b0a0a" : "#1a2a1a";
        const badgeColor = days >= 14 ? "#ef4444" : "#f59e0b";
        const injuries = u.injuries || u.medicalConditions || "";
        return `
          <tr style="background:${rowBg}; border-bottom: 1px solid #2d3748;">
            <td style="padding:10px 12px; color:#f9fafb; font-weight:500;">${u.name || "—"}</td>
            <td style="padding:10px 12px; color:#9ca3af; font-family:monospace;">${maskPhone(u.phoneNumber)}</td>
            <td style="padding:10px 12px;">
              <span style="background:${badgeColor}; color:#000; border-radius:4px; padding:2px 8px; font-size:12px; font-weight:700;">${fmtDate(u.lastActiveAt)}</span>
              <span style="color:#9ca3af; font-size:11px; margin-left:6px;">(${days}d ago)</span>
            </td>
            <td style="padding:10px 12px; color:#22c55e; font-weight:600; text-align:center;">${u.programmeWeek ?? "—"}</td>
            <td style="padding:10px 12px; color:#d1d5db; text-align:center;">${u.totalWorkoutsCompleted ?? 0}</td>
            <td style="padding:10px 12px; color:#a78bfa; font-size:13px;">${u.goalType || "—"}</td>
            <td style="padding:10px 12px; color:#fbbf24; font-size:12px; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${injuries}">${injuries || "—"}</td>
          </tr>`;
      }).join("");

      const weekThreeRows = weekThreeUsers.map((u: any) => `
          <tr style="background:#0f1f2f; border-bottom: 1px solid #2d3748;">
            <td style="padding:10px 12px; color:#f9fafb; font-weight:500;">${u.name || "—"}</td>
            <td style="padding:10px 12px; color:#9ca3af; font-family:monospace;">${maskPhone(u.phoneNumber)}</td>
            <td style="padding:10px 12px; color:#d1d5db;">${fmtDate(u.lastActiveAt)}</td>
            <td style="padding:10px 12px; color:#d1d5db; text-align:center;">${u.totalWorkoutsCompleted ?? 0}</td>
            <td style="padding:10px 12px; color:#a78bfa; font-size:13px;">${u.goalType || "—"}</td>
          </tr>`).join("");

      const newThisWeekRows = newThisWeekUsers.map((u: any) => `
          <tr style="background:#0a1a0f; border-bottom: 1px solid #2d3748;">
            <td style="padding:10px 12px; color:#f9fafb; font-weight:500;">${u.name || "—"}</td>
            <td style="padding:10px 12px; color:#9ca3af; font-family:monospace;">${maskPhone(u.phoneNumber)}</td>
            <td style="padding:10px 12px; color:#22c55e;">${fmtDate(u.createdAt)}</td>
            <td style="padding:10px 12px; color:#a78bfa; font-size:13px;">${u.goalType || "—"}</td>
            <td style="padding:10px 12px; color:#d1d5db; font-size:13px;">${(u as any).budgetTier || "—"}</td>
          </tr>`).join("");

      const goalBreakdownHtml = Object.entries(goalCounts).map(([g, c]) =>
        `<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #2d3748;">
          <span style="color:#d1d5db; text-transform:capitalize;">${g.replace(/_/g, " ")}</span>
          <span style="color:#22c55e; font-weight:700;">${c}</span>
        </div>`
      ).join("");

      const budgetBreakdownHtml = Object.entries(budgetCounts).map(([b, c]) =>
        `<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #2d3748;">
          <span style="color:#d1d5db; text-transform:capitalize;">${b.replace(/_/g, " ")}</span>
          <span style="color:#22c55e; font-weight:700;">${c}</span>
        </div>`
      ).join("");

      const tableStyle = `width:100%; border-collapse:collapse; font-size:14px;`;
      const thStyle = `padding:10px 12px; text-align:left; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:#6b7280; background:#0d1117; border-bottom:2px solid #22c55e;`;

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>KamLife Coach Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #111827; color: #f9fafb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; min-height: 100vh; }
    .container { max-width: 1200px; margin: 0 auto; padding: 16px; }
    .card { background: #1f2937; border-radius: 12px; padding: 20px; border: 1px solid #374151; }
    .stat-value { font-size: 2.2rem; font-weight: 800; color: #22c55e; line-height: 1; }
    .stat-label { font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 6px; }
    .section-title { font-size: 16px; font-weight: 700; color: #22c55e; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 12px; }
    .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
    .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
    .section { margin-bottom: 24px; }
    .table-wrap { overflow-x: auto; border-radius: 8px; border: 1px solid #374151; }
    @media (max-width: 768px) {
      .grid-4 { grid-template-columns: repeat(2, 1fr); }
      .grid-3 { grid-template-columns: 1fr; }
    }
    @media (max-width: 480px) {
      .grid-4 { grid-template-columns: 1fr 1fr; }
      .stat-value { font-size: 1.6rem; }
    }
  </style>
</head>
<body>
  <div style="background:#0d1117; border-bottom:2px solid #22c55e; padding:16px 20px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
    <div>
      <div style="font-size:20px; font-weight:800; color:#22c55e; letter-spacing:-0.02em;">KamLife Coach</div>
      <div style="font-size:12px; color:#6b7280; margin-top:2px;">Coach Dashboard — Confidential</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:12px; color:#9ca3af;">Last updated</div>
      <div style="font-size:13px; color:#d1d5db; font-weight:600;">${timestamp} SAST</div>
    </div>
  </div>

  <div class="container">

    <!-- STATS ROW 1 -->
    <div style="margin-top:20px; margin-bottom:16px; font-size:11px; color:#4b5563; text-transform:uppercase; letter-spacing:0.12em; font-weight:700;">Client Overview</div>
    <div class="grid-4">
      <div class="card" style="border-color:#22c55e44;">
        <div class="stat-value">${totalClients}</div>
        <div class="stat-label">Total Clients</div>
      </div>
      <div class="card" style="border-color:#22c55e44;">
        <div class="stat-value" style="color:#4ade80;">${activeCount}</div>
        <div class="stat-label">Active (7 days)</div>
      </div>
      <div class="card" style="border-color:#f59e0b44;">
        <div class="stat-value" style="color:#f59e0b;">${silentSeven}</div>
        <div class="stat-label">Silent (7d+)</div>
      </div>
      <div class="card" style="border-color:#ef444444;">
        <div class="stat-value" style="color:#ef4444;">${silentFourteen}</div>
        <div class="stat-label">Silent (14d+)</div>
      </div>
    </div>

    <!-- STATS ROW 2 -->
    <div class="grid-3">
      <div class="card">
        <div class="stat-value" style="color:#a78bfa;">${totalWorkouts.toLocaleString()}</div>
        <div class="stat-label">Total Workouts Logged</div>
      </div>
      <div class="card">
        <div class="stat-value" style="color:#38bdf8;">${Number(totalSteps).toLocaleString()}</div>
        <div class="stat-label">Total Steps Logged</div>
      </div>
      <div class="card">
        <div class="section-title" style="margin-bottom:8px; font-size:12px;">Goal Breakdown</div>
        ${goalBreakdownHtml || '<div style="color:#4b5563; font-size:13px;">No data</div>'}
        <div style="margin-top:10px; border-top:1px solid #374151; padding-top:10px;">
          <div style="font-size:11px; color:#6b7280; text-transform:uppercase; letter-spacing:0.08em; margin-bottom:6px; font-weight:700;">Budget Tiers</div>
          ${budgetBreakdownHtml || '<div style="color:#4b5563; font-size:13px;">No data</div>'}
        </div>
      </div>
    </div>

    <!-- AT RISK -->
    <div class="section">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span style="background:#ef4444; color:#fff; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">At Risk</span>
        <span class="section-title" style="margin-bottom:0;">7+ Days Silent (${allCompleteUsers.length} clients)</span>
      </div>
      ${allCompleteUsers.length === 0
        ? `<div class="card" style="color:#4b5563; text-align:center; padding:30px;">All clients active — no at-risk clients right now.</div>`
        : `<div class="table-wrap">
          <table style="${tableStyle}">
            <thead>
              <tr>
                <th style="${thStyle}">Name</th>
                <th style="${thStyle}">Phone</th>
                <th style="${thStyle}">Last Active</th>
                <th style="${thStyle} text-align:center;">Week</th>
                <th style="${thStyle} text-align:center;">Workouts</th>
                <th style="${thStyle}">Goal</th>
                <th style="${thStyle}">Notes</th>
              </tr>
            </thead>
            <tbody>${atRiskRows}</tbody>
          </table>
        </div>`
      }
    </div>

    <!-- WEEK 3 DANGER ZONE -->
    <div class="section">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span style="background:#f59e0b; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Week 3</span>
        <span class="section-title" style="margin-bottom:0;">Danger Zone (${weekThreeUsers.length} clients)</span>
      </div>
      ${weekThreeUsers.length === 0
        ? `<div class="card" style="color:#4b5563; text-align:center; padding:30px;">No clients currently in Week 3.</div>`
        : `<div class="table-wrap">
          <table style="${tableStyle}">
            <thead>
              <tr>
                <th style="${thStyle}">Name</th>
                <th style="${thStyle}">Phone</th>
                <th style="${thStyle}">Last Active</th>
                <th style="${thStyle} text-align:center;">Workouts</th>
                <th style="${thStyle}">Goal</th>
              </tr>
            </thead>
            <tbody>${weekThreeRows}</tbody>
          </table>
        </div>`
      }
    </div>

    <!-- NEW THIS WEEK -->
    <div class="section">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span style="background:#22c55e; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">New</span>
        <span class="section-title" style="margin-bottom:0;">New This Week (${newThisWeekUsers.length} clients)</span>
      </div>
      ${newThisWeekUsers.length === 0
        ? `<div class="card" style="color:#4b5563; text-align:center; padding:30px;">No new clients joined this week.</div>`
        : `<div class="table-wrap">
          <table style="${tableStyle}">
            <thead>
              <tr>
                <th style="${thStyle}">Name</th>
                <th style="${thStyle}">Phone</th>
                <th style="${thStyle}">Joined</th>
                <th style="${thStyle}">Goal</th>
                <th style="${thStyle}">Budget</th>
              </tr>
            </thead>
            <tbody>${newThisWeekRows}</tbody>
          </table>
        </div>`
      }
    </div>

  </div>

  <div style="text-align:center; padding:20px; color:#374151; font-size:12px; border-top:1px solid #1f2937; margin-top:8px;">
    KamLife Coach Admin Dashboard — Confidential &nbsp;|&nbsp; Refresh to update
  </div>
</body>
</html>`;

      res.send(html);
    } catch (err) {
      res.status(500).send("Dashboard error: " + err);
    }
  });
}

import { type Express } from "express";
import { type Server } from "http";
import crypto from "crypto";
import path from "path";
import { db, pool } from "./db";
import { users, weightLogs, workoutLogs, stepLogs, chatHistory, clothingCheckins, bodyMeasurements, weeklyCheckins, exerciseLogs, progressPhotos, escalations, abExperiments, abAssignments } from "../shared/schema";
import { eq, desc, asc, and, gte, lt, sql, count } from "drizzle-orm";
import OpenAI from "openai";
import twilio from "twilio";
import { SA_FOODS_SEED, type SAFood } from "./foods";
import { COACH_K_SYSTEM } from "./coach-prompt";
import { EQUIPMENT_ALTERNATIVES, FOOD_SUBSTITUTIONS, PORTION_GUIDE, STORE_ADVICE, INJURY_MODIFICATIONS, SUPPLEMENT_GUIDE, detectLanguage, type SALanguage } from "./constants";
import { buildDayWorkout, buildDayWorkoutForType, buildFullProgramme, getKamlifeProgramme, WORKOUT_DONE_RESPONSES, getDayType, buildDay1Workout, buildDay2Workout, buildDay3Workout } from "./programme";
import { askCoachK, selectModel, buildPatternSummary, getSAContextFlags, isUnderGPTCallLimit } from "./gpt";
import { calculateTargets } from "./targets";
import { handleOnboarding, getMenuText, getOnboardingMealPlan } from "./onboarding";
import { getShoppingList, formatShoppingList } from "./shopping-lists";
import { PRICING, calculateMRR, calculateARPU, calculateLTV, calculateTrialConversion } from "../shared/pricing";
import { nutritionAgent, programmingAgent, mindsetAgent, adminAgent, routeToAgent } from "./agents";
import { storeMemory, retrieveMemories } from "./memory";
import { generateVoiceNote, getVoiceFilePath, voiceFileExists } from "./tts";
import { deliveryStats, sendWhatsApp } from "./scheduler";
import { enforceCoachGuardrails, classifyMediaFailure } from "./coach-guardrails";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "sk-missing-key",
});

// SA timezone helper — South Africa is UTC+2 year-round (no DST)
// All date strings used for daily reset keys must use SAST, not UTC, so that
// midnight for the user is actually midnight in Johannesburg/Cape Town/Durban.
function sastToday(): string {
  const sast = new Date(Date.now() + 2 * 3_600_000);
  return sast.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

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

function escalationSLA(priority: string): Date {
  const hours: Record<string, number> = { urgent: 1, high: 4, normal: 12, low: 48 };
  return new Date(Date.now() + (hours[priority] || 12) * 3600_000);
}

function detectEscalation(message: string): { should: boolean; reason: string; priority: string } {
  const m = message.toLowerCase();
  if (/\b(injur|hurt|pain|sore|torn|sprain|fracture|broken|hernia|slipped disc)\b/i.test(m))
    return { should: true, reason: "injury", priority: "urgent" };
  if (/\b(refund|cancel.*subscription|stop.*billing|charge|payment.*issue|money back|unsubscribe)\b/i.test(m))
    return { should: true, reason: "billing", priority: "high" };
  if (/\b(doctor|hospital|surgery|medication|diabete|blood pressure|heart|pregnant|pregnanc|asthma|epilep)\b/i.test(m))
    return { should: true, reason: "medical", priority: "high" };
  if (/\b(angry|furious|disgusted|worst|scam|rip.?off|waste of money|terrible|useless|report you)\b/i.test(m))
    return { should: true, reason: "frustrated", priority: "high" };
  if (/\b(speak.*human|real person|talk.*someone|manager|complain|complaint)\b/i.test(m))
    return { should: true, reason: "human_requested", priority: "normal" };
  return { should: false, reason: "", priority: "normal" };
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
  try {
    const newUsers = await db.insert(users).values({
      phoneNumber: phone,
      subscriptionStatus: "inactive",
      onboardingState: "START",
      programmePhase: 1,
      programmeWeek: 1,
      programmeDayInWeek: 1,
      trainingMode: "home",
      stepsTarget: 8500,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    }).returning();
    return newUsers[0];
  } catch (err: any) {
    if (err.code === "23505") {
      // Race condition — concurrent first message created this user; fetch it
      const fallback = await db.select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
      if (fallback.length > 0) return fallback[0];
    }
    throw err;
  }
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
      days.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    let streak = 0;
    const checkDate = new Date();
    const todayKey = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
    if (!days.has(todayKey)) checkDate.setDate(checkDate.getDate() - 1);
    while (true) {
      const key = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
      if (!days.has(key)) break;
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    }
    return streak;
  } catch { return 0; }
}

// ============================================================
// SA FOOD SCANNER — in-memory match against 414 SA foods
// with fuzzy matching for misspellings & typos
// ============================================================

// Escape special regex characters in alias strings
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Levenshtein edit distance — how many character changes to turn a into b
function levenshtein(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const dp: number[][] = Array.from({ length: la + 1 }, () => Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return dp[la][lb];
}

// Max edit distance allowed based on word length — VERY STRICT to avoid false matches
// "better" → "butter" was distance 1 and matched. Now requiring longer words for any fuzzy.
function maxDistance(wordLen: number): number {
  if (wordLen <= 4) return 0;  // exact only: egg, pap, tea, rice, oats, bread
  if (wordLen <= 6) return 1;  // steak, mince, pasta — 1 typo only
  if (wordLen <= 10) return 2; // chicken, pilchards, boerewors — 2 typos
  return 2;                     // everything else — max 2
}

// Common non-food words that should NEVER fuzzy-match to food names
const FUZZY_BLACKLIST = new Set([
  "just", "had", "have", "having", "that", "this", "with", "from", "for",
  "what", "when", "where", "which", "about", "after", "before", "been",
  "would", "could", "should", "want", "need", "like", "make", "made",
  "take", "took", "give", "gave", "come", "came", "going", "went",
  "here", "there", "then", "than", "them", "they", "their", "your",
  "more", "some", "much", "many", "very", "also", "still", "well",
  "good", "feel", "feeling", "today", "yesterday", "morning",
  "afternoon", "evening", "night", "breakfast", "lunch", "dinner",
  "supper", "snack", "meal", "food", "total", "remaining", "calories",
  "protein", "daily", "target", "please", "thanks", "thank", "help",
  "read", "again", "true", "adjust", "correct", "wrong", "right",
  "better", "everything", "nothing", "something", "doing", "being",
  "getting", "looking", "working", "trying", "never", "always",
  "start", "stop", "keep", "send", "show", "tell", "look", "work",
  "think", "know", "really", "thing", "things", "stuff", "great",
  "terrible", "horrible", "broken", "fixed", "update", "check",
]);

function scanForSAFoods(msg: string): SAFood[] {
  const lower = msg.toLowerCase();
  const matched: SAFood[] = [];

  // PASS 1: Exact word-boundary matching (fast, preferred)
  // Track which alias matched so we can prefer longer (more specific) matches
  const matchedWithAlias: { food: SAFood; alias: string }[] = [];
  for (const food of SA_FOODS_SEED) {
    const allAliases = [food.name.toLowerCase(), ...food.aliases.map(a => a.toLowerCase())];
    let longestHit = "";
    for (const alias of allAliases) {
      const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, "i");
      if (re.test(lower) && alias.length > longestHit.length) {
        longestHit = alias;
      }
    }
    if (longestHit && !matchedWithAlias.find(m => m.food.name === food.name)) {
      matchedWithAlias.push({ food, alias: longestHit });
    }
  }

  // DEDUP PASS 1: If two foods matched with the exact same alias string (e.g. both
  // "Chicken livers" and "Chicken liver" match alias "chicken livers"), keep only the first
  // one encountered in SA_FOODS_SEED — eliminates plural/singular duplicate entries.
  const seenAliases = new Set<string>();
  const deduped: { food: SAFood; alias: string }[] = [];
  for (const entry of matchedWithAlias) {
    if (!seenAliases.has(entry.alias)) {
      seenAliases.add(entry.alias);
      deduped.push(entry);
    }
  }

  // DEDUP PASS 2: If "chicken breast" matched AND "chicken thigh" also matched via a shorter
  // alias that is a substring of the longer alias, drop the shorter one.
  // E.g. "chicken" (6 chars) is substring of "chicken breast" (14 chars) — drop chicken thigh.
  for (const entry of deduped) {
    const dominated = deduped.some(other =>
      other.food.name !== entry.food.name &&
      other.alias.length > entry.alias.length &&
      other.alias.includes(entry.alias) &&
      other.food.category === entry.food.category
    );
    if (!dominated) matched.push(entry.food);
  }

  // PASS 2: Fuzzy matching for misspellings (only if exact didn't catch anything)
  // Only activate fuzzy if PASS 1 found nothing — prevents phantom matches on normal messages
  if (matched.length > 0) return matched;

  // Split message into words and check each against all food aliases
  const words = lower.replace(/[^a-z\s]/g, "").split(/\s+/).filter(w => w.length >= 4 && !FUZZY_BLACKLIST.has(w));

  // Also check 2-word combos for multi-word foods like "corn flakes", "peanut butter"
  const combos: string[] = [...words];
  const rawWords = lower.replace(/[^a-z\s]/g, "").split(/\s+/).filter(w => w.length >= 2);
  for (let i = 0; i < rawWords.length - 1; i++) {
    combos.push(rawWords[i] + " " + rawWords[i + 1]);
  }

  for (const food of SA_FOODS_SEED) {
    if (matched.find(f => f.name === food.name)) continue;
    const allAliases = [food.name.toLowerCase(), ...food.aliases.map(a => a.toLowerCase())];

    let bestScore = Infinity;
    for (const combo of combos) {
      for (const alias of allAliases) {
        const aliasWordCount = alias.split(/\s+/).length;
        const comboWordCount = combo.split(/\s+/).length;

        // STRICT: word count must match — "breakfast" (1 word) can never match "spur breakfast" (2 words)
        if (aliasWordCount !== comboWordCount) continue;

        // STRICT: lengths must be similar (within 20%) — prevents "better" matching "butter"
        const lenRatio = Math.min(combo.length, alias.length) / Math.max(combo.length, alias.length);
        if (lenRatio < 0.8) continue;

        const dist = levenshtein(combo, alias);
        const allowed = maxDistance(alias.length);
        if (dist <= allowed && dist < bestScore) {
          bestScore = dist;
        }
      }
    }
    if (bestScore < Infinity && !matched.find(f => f.name === food.name)) {
      matched.push(food);
    }
  }

  // PASS 3: Combo meal dedup — if a combo meal is matched, remove its standalone components
  // e.g. "Pasta bolognaise" matched → remove standalone "Pasta (spaghetti)" and "Beef mince"
  const COMBO_OVERRIDES: Record<string, string[]> = {
    "Pasta bolognaise": ["Pasta (spaghetti)", "Beef mince"],
    "Chicken stir-fry with rice": ["Chicken breast", "Chicken thigh", "Brown rice", "White rice"],
    "Chicken and rice": ["Chicken breast", "Chicken thigh", "Brown rice", "White rice"],
    "Eggs on toast": ["Eggs", "Brown bread", "White bread"],
    "Pap and stew": ["Pap (stiff maize porridge)", "Stewing beef"],
    "Pap and wors": ["Pap (stiff maize porridge)", "Boerewors"],
    "Chicken curry and rice": ["Chicken thigh", "Chicken breast", "Brown rice", "White rice"],
    "Mince and pap": ["Beef mince", "Pap (stiff maize porridge)"],
    "Boerewors roll": ["Boerewors", "Brown bread", "White bread"],
    "Peanut butter on bread": ["Peanut butter", "Peanut butter (smooth)", "Brown bread", "White bread"],
    "Chicken and pap": ["Chicken breast", "Chicken thigh", "Pap (stiff maize porridge)"],
    "Fish and chips": ["Hake (frozen, battered)", "Chips (slap chips)"],
    "Pap and pilchards": ["Pap (stiff maize porridge)", "Pilchards in tomato sauce"],
    "Rice and beans": ["Brown rice", "White rice", "Sugar beans"],
    "Oats with milk": ["Oats (Jungle Oats)", "Full cream milk"],
    "Vetkoek with mince": ["Vetkoek", "Beef mince"],
    "Cereal with milk": ["Corn Flakes", "Full cream milk"],
  };

  const comboNames = matched.filter(f => COMBO_OVERRIDES[f.name]).map(f => f.name);
  if (comboNames.length > 0) {
    const toRemove = new Set<string>();
    for (const cn of comboNames) {
      for (const component of COMBO_OVERRIDES[cn]) toRemove.add(component);
    }
    return matched.filter(f => !toRemove.has(f.name));
  }

  // PASS 4: Alias collision cleanup — keep the most specific item only
  // Prevents double-counting like "chicken breast" + "chicken thigh" or duplicate peanut butter variants.
  const names = new Set(matched.map(f => f.name));
  let cleaned = [...matched];

  // Peanut butter appears as multiple catalog entries with shared aliases.
  if (names.has("Peanut butter") && names.has("Peanut butter (smooth)")) {
    cleaned = cleaned.filter(f => f.name !== "Peanut butter (smooth)");
  }

  // "Eggs" and "Whole egg (boiled)" can both hit for the same phrase.
  if (names.has("Eggs") && names.has("Whole egg (boiled)")) {
    cleaned = cleaned.filter(f => f.name !== "Whole egg (boiled)");
  }

  // If a specific chicken cut was matched, drop generic chicken piece aliases.
  if (names.has("Chicken breast") && names.has("Chicken thigh")) {
    const prefersBreast = /\b(breast|fillet|fillet[s]?)\b/i.test(lower);
    cleaned = cleaned.filter(f => f.name !== (prefersBreast ? "Chicken thigh" : "Chicken breast"));
  }

  return cleaned;
}

function parseFoodLogTotalsFromMessageOut(messageOut: string): { calories: number; protein: number } | null {
  if (!messageOut) return null;
  const totalLine = messageOut.match(/\*(?:Meal|Day) total:\s*~?(\d+)\s*kcal\s*\|\s*~?(\d+)g\s*protein\*/i);
  if (totalLine) {
    return { calories: parseInt(totalLine[1], 10), protein: parseInt(totalLine[2], 10) };
  }
  return null;
}

function sanitizeCoachReply(reply: string, userMessage: string, budgetTier?: string | null, injuries?: string | null): string {
  const trimmed = (reply || "").trim();
  if (!trimmed) {
    return "I had a glitch. Send your last message again and I will respond properly.";
  }
  // Hard-ban low-quality generic fallback we observed in production.
  if (/^what happened\??$/i.test(trimmed)) {
    if (/\b(screenshot|step|steps|walk)\b/i.test(userMessage)) {
      return "I did not read the screenshot clearly. Send it again with this caption: \"steps screenshot\".";
    }
    if (/\b(voice|audio|note)\b/i.test(userMessage)) {
      return "I did not process that voice note fully. Please resend it, or type the message.";
    }
    return "I missed your point there. Tell me exactly what you need right now and I will fix it.";
  }
  const guarded = enforceCoachGuardrails(trimmed, { userMessage, budgetTier, injuries });
  return guarded.reply;
}

function buildMediaTrace(phone: string, mediaType: string): string {
  const cleanPhone = phone.replace(/^whatsapp:/, "").replace(/\D/g, "").slice(-6) || "unknown";
  return `m_${Date.now().toString(36)}_${cleanPhone}_${(mediaType || "unknown").replace(/[^\w]/g, "").slice(0, 12)}`;
}

async function withTimeout<T>(label: string, ms: number, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function logMediaFailure(userId: string, stage: string, rawError?: unknown): Promise<void> {
  const code = classifyMediaFailure(stage, rawError);
  try {
    await logChat(userId, `[MEDIA_FAIL:${stage}]`, code, "MEDIA_FAILURE");
  } catch (e) {
    console.warn("[media-failure-log]", e);
  }
}

async function recomputeTodayFoodTotals(userId: string): Promise<{ calories: number; protein: number }> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const logs = await db.select({
    messageIn: chatHistory.messageIn,
    messageOut: chatHistory.messageOut,
  }).from(chatHistory).where(and(
    eq(chatHistory.userId, userId),
    eq(chatHistory.intent, "FOOD_LOG"),
    gte(chatHistory.createdAt, todayStart),
  ));

  let calories = 0;
  let protein = 0;
  for (const log of logs) {
    const parsed = parseFoodLogTotalsFromMessageOut(log.messageOut || "");
    if (parsed) {
      calories += parsed.calories;
      protein += parsed.protein;
      continue;
    }
    // Fallback for legacy logs that may not have structured totals.
    const matched = scanForSAFoods(log.messageIn || "");
    calories += matched.reduce((s, f) => s + (f.typicalPortionCalories || 0), 0);
    protein += matched.reduce((s, f) => s + (f.typicalPortionProtein || 0), 0);
  }
  return { calories, protein };
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
  // Core protein sources — must ALWAYS suppress protein warning
  "chicken", "beef", "fish", "tuna", "mince", "pork", "lamb", "turkey",
  "salmon", "hake", "sardine", "sardines", "prawn", "prawns", "biltong",
  "droëwors", "droewors", "cottage cheese", "greek yoghurt", "greek yogurt",
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
  } catch (e) {
    console.warn("[non-fatal]", e);
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
// PROGRESSIVE OVERLOAD CONTEXT — pulls last logged weights for a user
// Call before delivering a workout. If they've logged any lifts, prepend targets.
// ============================================================

async function getProgressiveOverloadContext(userId: string): Promise<string> {
  try {
    const recentLifts = await db.select().from(exerciseLogs)
      .where(eq(exerciseLogs.userId, userId))
      .orderBy(desc(exerciseLogs.loggedAt))
      .limit(20);
    if (recentLifts.length === 0) return "";

    // Deduplicate — keep most recent entry per exercise
    const seen = new Map<string, typeof recentLifts[0]>();
    for (const lift of recentLifts) {
      if (!seen.has(lift.exerciseName)) seen.set(lift.exerciseName, lift);
    }
    const entries = [...seen.values()].slice(0, 6);

    const lines = entries.map(lift => {
      const w = parseFloat(String(lift.weightKg || 0));
      const repsStr = lift.sets && lift.reps
        ? ` ${lift.sets}×${lift.reps} reps`
        : lift.reps ? ` ×${lift.reps} reps` : "";
      const nextW = (w + 2.5).toFixed(1).replace(".0", "");
      const daysAgo = Math.floor((Date.now() - new Date(lift.loggedAt || "").getTime()) / 86_400_000);
      const when = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo}d ago`;
      return `• ${lift.exerciseName}: ${w}kg${repsStr} (${when}) → aim ${nextW}kg or add 1–2 reps`;
    });

    return `*Your Targets — Based on Last Session:*\n${lines.join("\n")}\n\n`;
  } catch (e) {
    console.warn("[non-fatal]", e);
    return "";
  }
}

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
  } catch (e) {
    console.warn("[checkPerfectDay]", e);
    return null;
  }
}

// Onboarding functions moved to ./onboarding (see imports above)

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================

async function handleMessage(phone: string, message: string, mediaUrl?: string, mediaContentType?: string): Promise<string> {
  try {
  const m = message.toLowerCase().trim().replace(/[\u2018\u2019\u201C\u201D]/g, "'").replace(/\s+/g, " ");

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
    try { await logChat(crisisUser[0]?.id || "unknown", message, crisisReply, "CRISIS"); } catch (e) { console.warn("[non-fatal]", e); }
    // Alert the coach immediately — safety-critical, any failure must be loud and visible
    const coachAlertPhone = process.env.COACH_ALERT_PHONE;
    if (!coachAlertPhone) {
      console.error(`[CRISIS] ⚠️  COACH_ALERT_PHONE not configured — coach NOT notified! Client: ${crisisName} (${phone}). Message: "${message.slice(0, 150)}"`);
    } else if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      try {
        const alertClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const fromNum = process.env.TWILIO_WHATSAPP_NUMBER?.startsWith("whatsapp:") ? process.env.TWILIO_WHATSAPP_NUMBER : `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;
        await alertClient.messages.create({
          from: fromNum,
          to: `whatsapp:${coachAlertPhone}`,
          body: `⚠️ CRISIS ALERT\nClient: ${crisisName} (${phone})\nMessage: "${message.slice(0, 150)}"\n\nThey have been given SADAG 0800 567 567. Please check on this client.`,
        });
        console.log(`[CRISIS] Coach alert sent to ${coachAlertPhone}`);
      } catch (e) {
        // Log at ERROR level — must surface in monitoring so the coach can be reached manually
        console.error(`[CRISIS] ⚠️  COACH ALERT SEND FAILED — coach NOT notified! Client: ${crisisName} (${phone}). Error:`, e);
      }
    }
    return crisisReply;
  }

  // ---- TERMINAL / GIT COMMAND GUARD — before user lookup ----
  // Catches messages like "git pull origin main && pkill node", "npm run dev", etc.
  const TERMINAL_PATTERNS = [
    /\bgit\s+(pull|push|commit|clone|checkout|reset|rebase|merge|status|log|diff|add|stash)\b/i,
    /\bnpm\s+(run|install|start|build|test|update|uninstall)\b/i,
    /\bpkill\b|\bkill\s+-\d/i,
    /\brm\s+-rf\b/i,
    /\bsudo\b.*\b(apt|brew|yum|pip|npm)\b/i,
    /^[a-z0-9_.-]+\s*&&\s*[a-z0-9_.-]+/i,   // "cmd1 && cmd2" at start of message
    /\bcd\s+\/[a-z]/i,
    /\bchmod\b|\bchown\b/i,
  ];
  if (TERMINAL_PATTERNS.some(re => re.test(message))) {
    return `That looks like a terminal command — I'm your fitness coach, not a shell! Send me what you ate, your workout, or ask about your goals. 💪`;
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
      // Wrap all deletes in a transaction — partial deletion is worse than no deletion
      await db.transaction(async (tx) => {
        await tx.delete(chatHistory).where(eq(chatHistory.userId, uid));
        await tx.delete(stepLogs).where(eq(stepLogs.userId, uid));
        await tx.delete(workoutLogs).where(eq(workoutLogs.userId, uid));
        await tx.delete(weightLogs).where(eq(weightLogs.userId, uid));
        await tx.delete(weeklyCheckins).where(eq(weeklyCheckins.userId, uid));
        await tx.delete(clothingCheckins).where(eq(clothingCheckins.userId, uid));
        await tx.delete(bodyMeasurements).where(eq(bodyMeasurements.userId, uid));
        // Nullify PII rather than delete user row (preserves compliance log)
        await tx.update(users).set({
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
      });
      console.log(`[POPIA DELETE] Completed — all data deleted for ${uid}`);
      return "Done. All your data has been permanently deleted in compliance with POPIA. If you want to start fresh, just send any message.";
    }
  }

  // ---- FIX 1: RESET — absolute first, before getOrCreateUser, before everything ----
  if (m === "reset") {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.phoneNumber, phone)).limit(1);
    if (existing.length > 0) {
      const uid = existing[0].id;
      // Delete ALL FK-dependent tables before deleting user row
      await db.delete(chatHistory).where(eq(chatHistory.userId, uid));
      await db.delete(stepLogs).where(eq(stepLogs.userId, uid));
      await db.delete(workoutLogs).where(eq(workoutLogs.userId, uid));
      await db.delete(weightLogs).where(eq(weightLogs.userId, uid));
      await db.delete(weeklyCheckins).where(eq(weeklyCheckins.userId, uid));
      await db.delete(clothingCheckins).where(eq(clothingCheckins.userId, uid));
      await db.delete(bodyMeasurements).where(eq(bodyMeasurements.userId, uid));
      await db.delete(exerciseLogs).where(eq(exerciseLogs.userId, uid));
      await db.delete(progressPhotos).where(eq(progressPhotos.userId, uid));
      await db.delete(escalations).where(eq(escalations.userId, uid));
      await db.delete(abAssignments).where(eq(abAssignments.userId, uid));
      await db.delete(users).where(eq(users.id, uid));
    }
    await db.insert(users).values({
      phoneNumber: phone,
      subscriptionStatus: "inactive",
      onboardingState: "WELCOME",
      programmePhase: 1,
      programmeWeek: 1,
      programmeDayInWeek: 1,
      trainingMode: "home",
      stepsTarget: 8500,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });
    return "Fresh start. What's your name?";
  }

  const user = await getOrCreateUser(phone);

  // ---- POST-MEDIA FOLLOW-UP: "I sent screenshot/voice" ----
  // Prevent vague GPT responses after a media upload by resolving against recent media events.
  const asksAboutSentMedia = /\b(i sent|i have sent|did you get|you got|check|look at).{0,40}\b(screenshot|photo|image|pic|voice|audio|note)\b/i.test(m);
  if (asksAboutSentMedia && !mediaUrl) {
    const recentMedia = await db.select({ messageIn: chatHistory.messageIn, intent: chatHistory.intent, createdAt: chatHistory.createdAt })
      .from(chatHistory)
      .where(eq(chatHistory.userId, user.id))
      .orderBy(desc(chatHistory.createdAt))
      .limit(12);
    const lastMediaEvent = recentMedia.find(row =>
      (row.messageIn || "").includes("[Photo]") ||
      (row.messageIn || "").includes("[Step Screenshot") ||
      (row.intent || "").includes("PROGRESS_PHOTO")
    );
    if (lastMediaEvent) {
      if ((lastMediaEvent.messageIn || "").includes("[Step Screenshot")) {
        return "Yes, I got your step screenshot and logged it. Send your next one tonight so we keep your daily average accurate.";
      }
      if ((lastMediaEvent.messageIn || "").includes("[Photo]")) {
        return "Yes, I got your photo. If that was a meal photo, send one short caption like \"chicken and rice\" so I can tighten calories and protein.";
      }
      return "Yes, I received it. Send one line on what you want checked so I can give a precise answer.";
    }
    if (/\b(voice|audio|note)\b/i.test(m)) {
      return "I do not see a processed voice note yet. Please resend it, or type your message now and I will respond immediately.";
    }
    return "I do not see a processed screenshot yet. Please resend it with the caption \"steps screenshot\" or \"food photo\".";
  }

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

  // ---- TRIAL EXPIRY CHECK — convert expired trials to inactive with a clear message ----
  if (user.subscriptionStatus === "trial") {
    const trialEnd = user.betaBypassUntil ? new Date(user.betaBypassUntil) : null;
    if (trialEnd && trialEnd < new Date()) {
      // Trial expired — convert to inactive and tell the user
      await db.update(users).set({ subscriptionStatus: "inactive" }).where(eq(users.phoneNumber, phone));
      user.subscriptionStatus = "inactive";
      const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
      const merchantId = process.env.PAYFAST_MERCHANT_ID;
      const cleanPhone = phone.replace(/^whatsapp:/, "").replace(/\D/g, "");
      const payLink = merchantId ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}` : appUrl;
      const name = user.name || "there";
      const workouts = user.totalWorkoutsCompleted || 0;
      const trialEndReply = `${name}, your 7-day free trial has ended.${workouts > 0 ? `\n\nYou completed ${workouts} workout${workouts > 1 ? "s" : ""} — that's real momentum.` : ""}\n\nEverything is saved — your programme, progress, and targets. Subscribe to keep coaching going.\n\n*R149/month — cancel anytime:*\n${payLink}\n\nR5/day. Reply *pay* anytime to get your link.`;
      await logChat(user.id, message, trialEndReply, "TRIAL_EXPIRED");
      return trialEndReply;
    }
  }

  // ---- SUBSCRIPTION GATE — inactive users locked out of coaching ----
  if (user.subscriptionStatus === 'inactive') {
    const gateBypass = /\b(pay|paying|payment|rejoin|re-join|reactivate|subscribe|subscription|renew|renewal|help|menu|delete|my data|chest pain|can.?t breathe|emergency|hospital|ambulance|hi|hello|hey|howzit|sawubona|dumela|heita|eita|status|what did i eat|food diary|food log|my food|calories today|protein today)\b/i;
    if (!gateBypass.test(m)) {
      const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
      const merchantId = process.env.PAYFAST_MERCHANT_ID;
      const cleanPhone = phone.replace(/^whatsapp:/, "").replace(/\D/g, "");
      const payLink = merchantId ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}` : appUrl;
      const name = user.name ? `${user.name}` : "there";
      const workouts = user.totalWorkoutsCompleted || 0;
      const gateReply = workouts === 0
        ? `Your programme is built, ${name}. Subscribe to start.\n\n*R149/month — cancel anytime:*\n${payLink}\n\nR5/day for a personal coach in your pocket. Reply *pay* to get your link.`
        : `${name}, your subscription is inactive.\n\nYour ${workouts} workout${workouts > 1 ? "s" : ""} and all progress are saved.\n\n*Reactivate for R149/month:*\n${payLink}\n\nReply *pay* to get your link.`;
      await logChat(user.id, message, gateReply, "SUBSCRIPTION_GATE");
      return gateReply;
    }
  }

  // ---- HEART CONDITION CLEARANCE GATE ----
  // Users with heart_condition must confirm doctor clearance before receiving workouts
  if (user.doctorClearanceRequired && !/(doctor|cleared|clearance|got clearance|doctor said|my doctor|spoke to doctor|physician|cardiologist)/i.test(m)) {
    const conditions = (user.medicalConditions || "").split(",").map((s: string) => s.trim());
    if (conditions.includes("heart_condition")) {
      const name = user.name || "there";
      const clearanceMsg = `${name}, your profile shows a heart condition. Before I give you a workout programme, please confirm you have spoken to your doctor and have clearance for exercise.\n\nReply *my doctor cleared me* to continue, or ask anything about food, steps, or general questions — those are always available.`;
      // Allow food/step/weight questions and crisis through
      const allowThrough = /\b(food|eat|meal|calories|protein|steps|walked|weight|water|sleep|how am i|status|diary|crisis|help)\b/i.test(m);
      if (!allowThrough) {
        await logChat(user.id, message, clearanceMsg, "HEART_GATE");
        return clearanceMsg;
      }
    }
  }
  // Accept doctor clearance confirmation
  if (user.doctorClearanceRequired && /(my doctor cleared me|doctor cleared|got clearance|cleared by doctor|cleared by my doctor|physician cleared|cardiologist cleared)/i.test(m)) {
    await db.update(users).set({ doctorClearanceRequired: false }).where(eq(users.phoneNumber, phone));
    const name = user.name || "there";
    return `${name}, noted — doctor clearance confirmed. Your full programme is now unlocked. Let's get to work. Type *menu* to see today's workout.`;
  }

  // ---- SEVERE FRUSTRATION EARLY-INTERCEPT — before ANY coaching/workout/food handlers ----
  // Catches multi-signal frustration messages like "this is all useless... shut down... I'm done"
  // so that the bot does NOT respond with a workout programme or food log
  const frustrationSignalCount = [
    /\b(useless|useless(ly)?)\b/i.test(m),
    /\b(terrible|pathetic|garbage|rubbish|broken|nothing works)\b/i.test(m),
    /\b(i.?m done|i am done|giving up|shut down|shut it down|i.?m out)\b/i.test(m),
    /\b(not paying|won.?t pay|i won.?t pay|i.?m not paying|nobody.?s paying|not worth)\b/i.test(m),
    /\b(this is a bot|it.?s a bot|just a bot|generic bot|just generic)\b/i.test(m),
    /\b(jesus christ|oh my god|oh god|oh dear|good god)\b/i.test(m),
  ].filter(Boolean).length;

  if (frustrationSignalCount >= 2) {
    const firstName = user.name?.split(" ")[0] || "";
    const namePrefix = firstName ? `${firstName}, ` : "";
    const lastBotMsgs = await db.select({ messageOut: chatHistory.messageOut, intent: chatHistory.intent })
      .from(chatHistory)
      .where(eq(chatHistory.userId, user.id))
      .orderBy(desc(chatHistory.createdAt))
      .limit(3);
    const lastIntent = lastBotMsgs[0]?.intent || "";
    const lastOut = (lastBotMsgs[0]?.messageOut || "").slice(0, 200);
    const profileCtx = `CRITICAL PROFILE: Goal=${user.goalType}, Budget=${user.weeklyFoodBudget}, Injuries=${user.injuries || "none"}, Medical=${user.medicalConditions || "none"}.`;
    const severeCtx = `The client is severely frustrated. They are ready to quit. Message: "${message}". Last bot response (${lastIntent}): "${lastOut}". ${profileCtx}\n\nRULES: 1) Do NOT apologise generically. 2) Do NOT ask what happened — you know what happened: the bot failed them. 3) Acknowledge the SPECIFIC failure. 4) Tell them ONE specific thing that still works or IS personalised to their profile. 5) Give them a direct, concrete action for TODAY only. 6) Maximum 4 sentences. SA voice. Human, direct, no corporate speak.`;
    try {
      const severeReply = await askCoachK(message, user, severeCtx);
      await logChat(user.id, message, severeReply, "SEVERE_FRUSTRATION");
      return severeReply;
    } catch (e) {
      const fallback = `${namePrefix}I hear you — that wasn't good enough. Your calorie target is ${user.calorieTarget || 1800} kcal and protein target is ${user.proteinTarget || 120}g today. Log what you eat and I will track it accurately. Nothing else.`;
      await logChat(user.id, message, fallback, "SEVERE_FRUSTRATION");
      return fallback;
    }
  }

  // ---- RESET CALORIES — "reset my calories", "clear food log", "undo last meal" ----
  if (/\b(reset.*calori|clear.*food|clear.*log|clear.*calori|start.*fresh|reset.*food|reset.*log|undo.*last.*meal|delete.*last.*meal|remove.*last.*meal|wipe.*food|wipe.*log|clear.*today)\b/i.test(m)) {
    // Reset the stored counter
    await db.update(users).set({ todayCalories: 0, todayProteinG: 0, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
    // Also delete today's FOOD_LOG entries from chat_history to prevent phantom re-counts
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    try {
      await db.delete(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)));
    } catch (e) { console.warn("[non-fatal] clear food log:", e); }
    return `Food log cleared for today. ✅\n\nAll entries wiped — counter is at 0. Start fresh: tell me what you ate.`;
  }

  // ---- REMOVE LAST LOGGED MEAL — quick correction command ----
  if (/^(no\s+)?(remove|delete|undo)\s+(it|that|last|last one|last meal)$/i.test(m.trim())) {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const lastFoodLog = await db.select({ id: chatHistory.id })
      .from(chatHistory)
      .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)))
      .orderBy(desc(chatHistory.createdAt))
      .limit(1);

    if (lastFoodLog.length === 0) {
      return `No meal logged yet today to remove.`;
    }

    await db.update(chatHistory).set({ intent: "FOOD_LOG_CORRECTED" }).where(eq(chatHistory.id, lastFoodLog[0].id));
    const recomputed = await recomputeTodayFoodTotals(user.id);
    await db.update(users).set({
      todayCalories: recomputed.calories,
      todayProteinG: recomputed.protein,
      todayCaloriesDate: sastToday(),
    }).where(eq(users.id, user.id));

    return `Removed your last meal log. ✅\n\nUpdated total today: ~${recomputed.calories} kcal | ~${recomputed.protein}g protein.`;
  }

  // ---- SHOW TODAY'S MEAL LOG — transparency for trust ----
  if (/^(show|see|view)\s+(my\s+)?(meal|food)\s+log$|^(meal|food)\s+log$|^what\s+did\s+i\s+log(\s+today)?$/i.test(m.trim())) {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const logs = await db.select({
      messageIn: chatHistory.messageIn,
      messageOut: chatHistory.messageOut,
      createdAt: chatHistory.createdAt,
    }).from(chatHistory).where(and(
      eq(chatHistory.userId, user.id),
      eq(chatHistory.intent, "FOOD_LOG"),
      gte(chatHistory.createdAt, todayStart),
    )).orderBy(asc(chatHistory.createdAt)).limit(20);

    if (logs.length === 0) {
      return `No food logged yet today. Send your meal and I will track it.`;
    }

    const lines: string[] = [];
    let totalCals = 0;
    let totalProtein = 0;
    for (const l of logs) {
      const parsed = parseFoodLogTotalsFromMessageOut(l.messageOut || "");
      if (parsed) {
        totalCals += parsed.calories;
        totalProtein += parsed.protein;
      } else {
        const matched = scanForSAFoods(l.messageIn || "");
        totalCals += matched.reduce((s, f) => s + (f.typicalPortionCalories || 0), 0);
        totalProtein += matched.reduce((s, f) => s + (f.typicalPortionProtein || 0), 0);
      }
      const time = l.createdAt ? new Date(l.createdAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }) : "--:--";
      lines.push(`${time} — ${(l.messageIn || "[photo]").slice(0, 80)}`);
    }

    return `*Today's meal log (${logs.length})*\n${lines.map(x => `• ${x}`).join("\n")}\n\n*Total so far:* ~${totalCals} kcal | ~${totalProtein}g protein`;
  }

  // ---- INSTANT ANSWERS — cached from DB, zero GPT cost ----
  if (
    /\b(daily calories|calorie target|calories target|my calories|my calorie|kcal target|daily kcal)\b/i.test(m) ||
    /\b(calorie|calories|kcal)\b.*\b(target|goal|limit|daily|mine|my|remaining|left|still|remain)\b/i.test(m) ||
    /\b(daily|my|total|remaining)\b.*\b(calorie|calories|kcal)\b/i.test(m) ||
    /\b(how many|how much).*(calorie|calories|kcal|left|remaining)\b/i.test(m) ||
    /\b(calories today|protein today|what.?s left|whats left|calories left|calories remaining|remaining calories|total remaining|how much.*left|how much.*remaining|can i still eat|what can i eat|how much more|am i over)\b/i.test(m) ||
    m === "calories" || m === "calorie" || m === "kcal" || m === "remaining" || m === "what's left"
  ) {
    const cal = user.calorieTarget || 1800;
    const prot = user.proteinTarget || 120;
    const name = user.name ? `${user.name}, ` : "";
    // ALWAYS recalculate from actual food logs — never trust stored counter (can get corrupted)
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayFoodLogs = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut })
      .from(chatHistory)
      .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)));
    let todayCals = 0; let todayProt = 0;
    for (const log of todayFoodLogs) {
      const matched = scanForSAFoods(log.messageIn || "");
      if (matched.length > 0) {
        todayCals += matched.reduce((s: number, f: any) => s + (f.typicalPortionCalories || 0), 0);
        todayProt += matched.reduce((s: number, f: any) => s + (f.typicalPortionProtein || 0), 0);
      } else {
        // Fallback: extract from GPT response
        const calMatch = (log.messageOut || "").match(/~?(\d+)\s*kcal/i);
        const protMatch = (log.messageOut || "").match(/(\d+)g?\s*protein/i);
        if (calMatch) todayCals += parseInt(calMatch[1]);
        if (protMatch) todayProt += parseInt(protMatch[1]);
      }
    }
    const remaining = cal - todayCals;
    const protRemaining = prot - todayProt;
    if (todayCals > 0) {
      return `${name}*Today so far: ${todayCals} kcal | ${todayProt}g protein*\nTarget: ${cal} kcal | ${prot}g protein\n${remaining > 0 ? `\n*${remaining} kcal and ${protRemaining > 0 ? protRemaining + "g protein" : "✅ protein hit"}* still to go.` : `\nCalorie target reached. ✅`}\n\nHit protein first — everything else follows.`;
    }
    return `${name}${cal} calories and ${prot}g protein daily. Hit protein first — everything else follows.\n\nNo food logged yet today. Tell me what you ate.`;
  }

  if (/\b(protein)\b.*\b(target|goal|daily|mine|my)\b/i.test(m) || m === "my protein" || m === "protein target") {
    const prot = user.proteinTarget || 120;
    return `Protein target: *${prot}g per day.*\n\nBest sources at SA prices: eggs (6g each), pilchards (22g per tin), frozen chicken breast (28g per 100g), sugar beans (8g per 100g cooked).`;
  }

  if (/\b(streak|my streak|workout streak|current streak|consistency)\b/i.test(m)) {
    const streak = user.workoutStreak || 0;
    const total = user.totalWorkoutsCompleted || 0;
    const target = user.trainingDaysPerWeek || 3;

    // Calculate 7-day consistency — more motivating than a hard reset
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      const [weekResult] = await db.select({ c: count() }).from(workoutLogs)
        .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, sevenDaysAgo)));
      const weekWorkouts = weekResult.c || 0;
      const pct = Math.min(100, Math.round((weekWorkouts / target) * 100));

      if (total === 0) return `No sessions logged yet. Do your first workout and reply *done* — that starts the streak.`;

      const lines = [`*Your consistency:*`];
      lines.push(`\n📊 This week: ${weekWorkouts} of ${target} sessions (${pct}%)`);
      if (streak > 0) lines.push(`🔥 Current streak: ${streak} in a row`);
      lines.push(`💪 Total sessions: ${total}`);

      if (pct >= 80) lines.push(`\nYou are consistent. That is the only thing that matters.`);
      else if (pct >= 50) lines.push(`\nGood week so far. ${target - weekWorkouts} session${target - weekWorkouts > 1 ? "s" : ""} left to hit your target.`);
      else if (weekWorkouts > 0) lines.push(`\n${weekWorkouts} done, ${target - weekWorkouts} to go. Still time to hit your target this week.`);
      else lines.push(`\nNo sessions this week yet. Reply *today* and let's fix that.`);

      return lines.join("\n");
    } catch {
      // Fallback to basic streak
      if (streak === 0) return `Streak at 0. ${total} total sessions. Start a new one today — reply *today* for your workout.`;
      return `Current streak: *${streak}* in a row. Total: ${total}. Keep building.`;
    }
  }

  if (m === "my programme" || m === "programme" || m === "my workout" || m === "today's workout" || m === "1" || m === "workout") {
    const workout = buildDayWorkout(user);
    const dayNum = user.programmeDayInWeek || 1;
    const poContext = await getProgressiveOverloadContext(user.id);
    const week = user.programmeWeek || 1;
    const sessionNum = user.totalWorkoutsCompleted || 0;
    const sessionNote = sessionNum > 0 ? ` — Session ${sessionNum + 1}` : "";
    const weekNote = `*Week ${week}${sessionNote}*\n\n`;
    const reply = `${weekNote}${poContext}${workout}\n\nSend *done* when finished. Log lifts: "bench 80kg 3x10"`;
    await logChat(user.id, message, reply, "WORKOUT_VIEW");
    return reply;
  }

  if (m === "my targets" || m === "targets" || m === "my stats" || m === "stats") {
    const cal = user.calorieTarget || 1800;
    const prot = user.proteinTarget || 120;
    const steps = user.stepsTarget || 8500;
    const phase = user.programmePhase || 1;
    const week = user.programmeWeek || 1;
    const streak = user.workoutStreak || 0;
    const compliance = user.complianceLevel || "RESET";
    return `*Your Targets*\n\n🔥 Calories: ${cal} kcal/day\n💪 Protein: ${prot}g/day\n👟 Steps: ${steps.toLocaleString()}/day\n\n*Progress*\nPhase ${phase} · Week ${week} · Streak: ${streak} sessions\nCompliance: ${compliance}`;
  }

  // ---- NEW / CHANGE PROGRAMME REQUEST — always ask, never auto-deliver ----
  // Must be checked BEFORE awaitingProgrammeAnswers so a new request resets the flow
  const isNewProgrammeRequest =
    /\b(new|change|different|update|rebuild|swap|switch|give me a new|i need a new|want a new)\b.{0,30}\b(programme|program|workout|training plan|plan|gym|home)\b/i.test(m) ||
    /\b(programme|program|workout|training)\b.{0,30}\b(new|change|different|update|rebuild)\b/i.test(m) ||
    /\b(a new one|different one|another one|new gym|new home|new workout|new training)\b/i.test(m) ||
    /\bi want to train\s+[2-6]\s*days?\b/i.test(m) ||
    /\btrain\s+[2-6]\s*days?\s*(?:a\s*week|per\s*week)\b/i.test(m);

  if (isNewProgrammeRequest) {
    await db.update(users).set({ awaitingProgrammeAnswers: true }).where(eq(users.phoneNumber, phone));
    const nameQ = user.name ? ` ${user.name}` : "";
    const askReply = `Sharp${nameQ}. How many days can you train per week and are you at gym or home?`;
    await logChat(user.id, message, askReply, "PROGRAMME_QUESTIONS");
    return askReply;
  }

  // ---- AWAITING PROGRAMME ANSWERS — parse "4 days gym" or "3 home" format ----
  if (user.awaitingProgrammeAnswers) {
    // Bail out if this looks like a non-programme message — clear the flag and let normal handlers fire
    const isObviouslyNotProgrammeAnswer =
      /\b(hungry|starving|cancel|unsubscribe|steps|calories|weight|sleep|slept|walked|water|drank|done|menu|help|hello|hi|hey|programme|program|workout)\b/i.test(m) ||
      /\b(i ate|i had|breakfast|lunch|dinner|supper|oats|eggs|chicken|pap|rice)\b/i.test(m) ||
      m.length < 3;
    if (isObviouslyNotProgrammeAnswer) {
      await db.update(users).set({ awaitingProgrammeAnswers: false }).where(eq(users.phoneNumber, phone));
      // Fall through to normal handlers
    } else {
    const lower = message.toLowerCase();

    // Parse days (required)
    const daysMatch = message.match(/\b([2-6])\b/);
    const trainingDays = daysMatch ? parseInt(daysMatch[1]) : (user.trainingDaysPerWeek || 3);

    // Parse gym or home (required)
    let trainingMode = user.trainingMode || "home";
    if (/\b(dumbbell|dumbbells|db only|no barbell|no cables|basic gym|planet fitness|virgin active basic)\b/i.test(lower)) trainingMode = "gym_dumbbell";
    else if (/\bgym\b/i.test(lower) || /\bat gym\b/i.test(lower) || /\bthe gym\b/i.test(lower)) trainingMode = "gym";
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
    } // end else (not an obvious non-programme message)
  }

  // ---- GREETINGS / MENU (direct — no GPT) ----
  const greetings = ["hello", "hi", "hey", "howzit", "hola", "sawubona", "dumela", "heita", "eita", "yo", "sup"];
  if (greetings.some(g => m === g || m === g + " 👋") || m === "menu" || m === "help") {
    return await getMenuText(user);
  }

  // ---- SHOPPING LIST command ----
  if (m === "4" || m === "shopping list" || m === "shoppinglist" || m === "shopping" || m === "shop") {
    const budget = user.weeklyFoodBudget || "100_300";
    const weekNum = user.programmeWeek || 1;
    const goal = user.goalType || "fat_loss";
    const list = getShoppingList(budget, weekNum, goal);
    const reply = formatShoppingList(list, user.name || undefined, goal);
    await logChat(user.id, message, reply, "SHOPPING_LIST");
    return reply;
  }

  // ---- CLIENT SENDS THEIR OWN SHOPPING LIST — "adjust my list", "here's what I buy", "fix my groceries" ----
  const isClientList = /\b(adjust|fix|check|improve|optimize|look at|review|here.?s|heres|this is what i|what i normally|my.*grocery|my.*shopping|i usually buy|i always buy|every week i buy|i buy)\b/i.test(m)
    && /\b(list|buy|shop|grocery|groceries|shopping|trolley|basket)\b/i.test(m)
    && m.split(/\s+/).length >= 5; // must be a meaningful list, not just "my list"
  if (isClientList) {
    const clientName = user.name?.split(" ")[0] || "there";
    const goal = user.goalType || "fat_loss";
    const pTarget = user.proteinTarget || 120;
    const cTarget = user.calorieTarget || 1800;
    const adjustReply = await askCoachK(message, user,
      `The client just sent you their personal shopping/grocery list. Analyze it as Coach K. Be specific and SA-focused:\n\n1. What's GOOD about their list (acknowledge what they're doing right)\n2. What's MISSING for their ${goal} goal (especially protein sources — they need ${pTarget}g/day)\n3. What to SWAP (not remove — replace with a better option at similar price)\n4. What to REMOVE (only if genuinely harmful to their goal)\n5. End with a specific weekly total estimate in ZAR\n\nKeep it direct, no fluff. Use SA product names and prices. Max 4 bullet points per section. Their calorie target is ${cTarget} kcal/day.`
    );
    await logChat(user.id, message, adjustReply, "SHOPPING_LIST_ADJUST");
    return adjustReply;
  }

  // ---- RESTAURANT SURVIVAL GUIDE — "eating at Nando's", "what to order at KFC" ----
  const restaurantMatch = m.match(/\b(nando.?s|kfc|mcdonald.?s|mcdonalds|burger king|spur|steers|wimpy|ocean basket|debonairs|roman.?s|romans|galito.?s|galitos|hungry lion|fish aways|fishaways|chicken licken|barcelos)\b/i);
  const isRestaurantQ = restaurantMatch && /\b(order|eat|have|get|menu|what.*should|best|healthy|smartest|good choice|low cal|protein)\b/i.test(m);
  if (isRestaurantQ && restaurantMatch) {
    const restaurant = restaurantMatch[1];
    const goal = user.goalType || "fat_loss";
    const pTarget = user.proteinTarget || 120;
    const cTarget = user.calorieTarget || 1800;

    const RESTAURANT_GUIDES: Record<string, string> = {
      "nando's": `*Nando's Smart Order (${goal === "muscle_gain" ? "Muscle" : "Fat loss"})*\n\n✅ *Best:* 1/4 chicken (breast, flame-grilled, no skin) + corn on the cob + side salad\n~420 kcal | ~45g protein\n\n🔸 *Decent:* Chicken wrap (grilled, not crispy) — ~480 kcal | ~35g protein\n\n❌ *Avoid:* Espetada (butter-loaded), creamy mashed potato, extra-large chips\n\n💡 *Pro tip:* Ask for peri-peri sauce on the side. Lemon & herb is the lowest calorie option. Skip the garlic bread — it's 400 kcal you won't feel.`,
      "kfc": `*KFC Smart Order (${goal === "muscle_gain" ? "Muscle" : "Fat loss"})*\n\n✅ *Best:* Streetwise 2-piece (remove skin) + coleslaw\n~380 kcal | ~35g protein (without skin)\n\n🔸 *Decent:* Zinger burger (no mayo) — ~450 kcal | ~28g protein\n\n❌ *Avoid:* Dunked wings, anything "loaded", large chips, Krusher drinks\n\n💡 *Pro tip:* KFC skin = 150 extra kcal per piece. Remove it. The chicken underneath is solid protein.`,
      "steers": `*Steers Smart Order (${goal === "muscle_gain" ? "Muscle" : "Fat loss"})*\n\n✅ *Best:* Classic burger (single patty, no cheese, extra salad) — ~450 kcal | ~30g protein\n\n🔸 *Decent:* Wacky Wednesday single — ~400 kcal | ~25g protein\n\n❌ *Avoid:* King Steer, anything double/triple, ribs combo, milkshakes\n\n💡 *Pro tip:* Skip the chips. Get a side salad or just the burger alone. A King Steer combo is 1,800 kcal — that's your entire day.`,
      "spur": `*Spur Smart Order (${goal === "muscle_gain" ? "Muscle" : "Fat loss"})*\n\n✅ *Best:* 300g rump steak + baked potato + garden salad — ~550 kcal | ~55g protein\n\n🔸 *Decent:* Chicken breast with veg — ~400 kcal | ~40g protein\n\n❌ *Avoid:* Ribs combo, cheese sauce, nachos starter, Spur burger with everything\n\n💡 *Pro tip:* Ask for sauce on the side. Their sauces add 200-400 kcal. The steak itself is excellent protein.`,
      "wimpy": `*Wimpy Smart Order (${goal === "muscle_gain" ? "Muscle" : "Fat loss"})*\n\n✅ *Best:* Grilled chicken + rice + salad — ~450 kcal | ~40g protein\n\n🔸 *Decent:* Dagwood single — ~500 kcal | ~28g protein\n\n❌ *Avoid:* Double thick shake, cheese and bacon burger, onion rings\n\n💡 *Pro tip:* Wimpy breakfast (skip toast and sausage) = eggs + bacon + tomato = solid 30g protein for R85.`,
      "mcdonald's": `*McDonald's Smart Order (${goal === "muscle_gain" ? "Muscle" : "Fat loss"})*\n\n✅ *Best:* Grilled chicken wrap — ~380 kcal | ~27g protein\n\n🔸 *Decent:* Big Mac (no sauce) — ~430 kcal | ~25g protein\n\n❌ *Avoid:* Large McFlurry (600 kcal), large fries (450 kcal), Grand anything\n\n💡 *Pro tip:* Ask for no mayo on any burger — saves 100-150 kcal instantly. Water not Coke saves another 200 kcal.`,
    };

    const key = Object.keys(RESTAURANT_GUIDES).find(k => restaurant.toLowerCase().includes(k.replace(/[^a-z]/g, "")));
    if (key) {
      const guide = RESTAURANT_GUIDES[key];
      await logChat(user.id, message, guide, "RESTAURANT_GUIDE");
      return guide;
    }
    // For restaurants not in the guide, use GPT
    const gptRestaurant = await askCoachK(message, user,
      `Client is asking what to eat at ${restaurant}. Give a SA-focused restaurant guide:\n- Best option (calories + protein)\n- Decent option\n- What to avoid\n- One pro tip\nTheir goal is ${goal}, protein target ${pTarget}g/day, calorie target ${cTarget}/day. Max 6 lines. Be specific about menu items.`
    );
    await logChat(user.id, message, gptRestaurant, "RESTAURANT_GUIDE");
    return gptRestaurant;
  }

  // ---- ALCOHOL AWARENESS — "had 3 beers", "wine tonight", "drinks at the braai" ----
  const alcoholMatch = /\b(\d+)?\s*(beers?|wines?|glasses?\s*(?:of\s*)?wine|brandies?|brandy|whiskey|whisky|vodka|gin|rum|ciders?|savanna|hunters|castle|black label|heineken|windhoek|amstel|stellenbosch|nederburg|four cousins|robertson|4th street|smirnoff|jameson|jack daniel|gordons|captain morgan)\b/i.test(m);
  const isAlcoholLog = alcoholMatch && /\b(had|drank|drinking|having|drinks?|tonight|last night|yesterday|at the braai|at the party|weekend)\b/i.test(m);
  if (isAlcoholLog) {
    // Extract drink count
    const qtyMatch = m.match(/(\d+)\s*(?:beers?|wines?|glasses?|brandies?|ciders?|shots?|doubles?|bottles?)/i);
    const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;

    const isBeer = /\b(beers?|castle|black label|heineken|windhoek|amstel|lager|hansa)\b/i.test(m);
    const isWine = /\b(wines?|glass.*wine|nederburg|four cousins|robertson|4th street|stellenbosch|sauvignon|merlot|pinotage|chenin)\b/i.test(m);
    const isCider = /\b(ciders?|savanna|hunters)\b/i.test(m);
    const isSpirits = /\b(brandies?|brandy|whiskey|whisky|vodka|gin|rum|smirnoff|jameson|jack|gordons|captain morgan|shots?|doubles?)\b/i.test(m);

    let calPerDrink = 150; let drinkName = "drink";
    if (isBeer) { calPerDrink = 200; drinkName = "beer"; }
    else if (isWine) { calPerDrink = 130; drinkName = "glass of wine"; }
    else if (isCider) { calPerDrink = 220; drinkName = "cider"; }
    else if (isSpirits) { calPerDrink = 100; drinkName = "shot"; }

    const totalCal = calPerDrink * qty;
    const calTarget = user.calorieTarget || 1800;
    const pctOfDay = Math.round((totalCal / calTarget) * 100);

    let alcoholReply = `${qty} ${drinkName}${qty > 1 ? "s" : ""} = ~${totalCal} kcal. That's ${pctOfDay}% of your daily target.\n\n`;

    if (totalCal > 600) {
      alcoholReply += `That's a full meal's worth of calories with zero protein and zero nutrition. Your body also stops burning fat while it processes alcohol — so the food you eat WITH alcohol is more likely to be stored as fat.\n\n`;
      alcoholReply += `*Damage control:* High protein meals tomorrow. Extra water tonight (1 glass per drink). Walk 30 min extra tomorrow.`;
    } else if (totalCal > 300) {
      alcoholReply += `Not ideal, but manageable. Cut one carb serving from dinner to balance it out. Drink water between rounds.\n\n`;
      alcoholReply += `*Tomorrow:* Extra protein at breakfast. Get your walk in.`;
    } else {
      alcoholReply += `Manageable. Stay hydrated — 1 glass of water per drink. Don't let it become 3 more.`;
    }

    await logChat(user.id, message, alcoholReply, "ALCOHOL_LOG");
    return alcoholReply;
  }

  // ---- FOOD SWAP — "I don't like pilchards", "what can I have instead of", "swap", "replace" ----
  const isSwapRequest = /\b(don.?t like|hate|can.?t eat|swap|replace|instead of|alternative|substitute|other option|something else|what else|switch)\b/i.test(m)
    && scanForSAFoods(m).length > 0;
  if (isSwapRequest) {
    const foods = scanForSAFoods(m);
    const foodName = foods[0].name;
    const category = foods[0].category;
    const budget = user.weeklyFoodBudget || "100_300";
    const goal = user.goalType || "fat_loss";

    // Find same-category alternatives from the SA food database
    const alternatives = SA_FOODS_SEED.filter(f =>
      f.category === category &&
      f.name !== foodName &&
      f.budgetTier <= (budget === "under_100" ? 1 : budget === "100_300" ? 2 : 3)
    ).sort((a, b) => b.proteinPer100g - a.proteinPer100g).slice(0, 4);

    if (alternatives.length > 0) {
      let swapReply = `*Swaps for ${foodName}:*\n\n`;
      for (const alt of alternatives) {
        swapReply += `• *${alt.name}* — ${alt.typicalPortionCalories} kcal | ${alt.typicalPortionProtein}g protein (${alt.typicalPortionDescription})\n`;
      }
      swapReply += `\nPick whichever one you enjoy — consistency beats perfection. I'll update your plan.`;
      await logChat(user.id, message, swapReply, "FOOD_SWAP");
      return swapReply;
    }
    // If no swap found in DB, use GPT
    const gptSwap = await askCoachK(message, user,
      `Client doesn't want ${foodName} (${category}). Suggest 3-4 SA alternatives in the same category at a ${budget} budget. Include calories and protein per portion. Their goal is ${goal}. Be specific.`
    );
    await logChat(user.id, message, gptSwap, "FOOD_SWAP");
    return gptSwap;
  }

  // ---- MEAL PREP PLAN — "meal prep" / "prep" / "sunday cook" ----
  if (m === "5" || m === "meal prep" || m === "prep" || m === "sunday cook" || m === "batch cook" || m === "food prep" || /\b(meal prep|food prep|batch cook|sunday cook|cook for the week|prep for the week)\b/i.test(m)) {
    const budget = user.weeklyFoodBudget || "100_300";
    const goal = user.goalType || "fat_loss";
    const cal = user.calorieTarget || 1800;
    const prot = user.proteinTarget || 120;
    const otherNotes = (user.otherMedicalNotes || "").toLowerCase();
    const noFish = otherNotes.includes("fish") || otherNotes.includes("pilchard");
    const noDairy = otherNotes.includes("dairy") || otherNotes.includes("milk");
    const name = user.name ? `, ${user.name}` : "";

    let plan = `*🍳 Meal Prep Plan — Cook Once, Eat All Week*\n\n`;

    if (budget === "under_100") {
      plan += `*Total cook time: ~90 min*\n*Budget: under R100*\n\n`;
      plan += `*Step 1 — Big Pot of Beans (30 min)*\nSoak 500g sugar beans overnight. Boil until soft. Add onion, garlic, tomato. Makes 6 portions.\n_Store: 3 in fridge, 3 in freezer._\n\n`;
      plan += `*Step 2 — Boiled Eggs (15 min)*\nBoil 12 eggs. Cool. Store in fridge. That is 72g protein ready to grab.\n\n`;
      plan += `*Step 3 — Pap Base (20 min)*\nCook 1kg pap. Divide into 5 portions in containers.\n\n`;
      plan += `*Step 4 — Spinach + Cabbage (15 min)*\nWilt a bunch of spinach with garlic. Shred half a cabbage, stir-fry with onion.\n\n`;
      plan += `*Daily assembly:*\n• Breakfast: 2 eggs + pap\n• Lunch: Beans + cabbage + pap\n• Dinner: ${noFish ? "2 eggs + beans" : "Pilchards (open tin)"} + spinach + pap\n\n`;
      plan += `~${cal} kcal | ~${prot}g protein/day. All from R100/week.`;
    } else if (budget === "100_300") {
      plan += `*Total cook time: ~2 hours*\n*Budget: R150–R250*\n\n`;
      plan += `*Step 1 — Chicken (40 min)*\nSeason 1kg frozen chicken portions with garlic, paprika, salt. Bake at 180°C for 40 min. Makes 5 portions.\n\n`;
      plan += `*Step 2 — Rice or Sweet Potato (25 min)*\nCook 1kg brown rice OR chop 1.5kg sweet potato, boil until soft. Divide into 5 containers.\n\n`;
      plan += `*Step 3 — Beans + Lentils (30 min)*\nCook 500g sugar beans with tomato and onion. Makes 4 portions.\n\n`;
      plan += `*Step 4 — Eggs (15 min)*\nBoil 12 eggs for grab-and-go breakfasts.\n\n`;
      plan += `*Step 5 — Vegetables (15 min)*\nStir-fry cabbage + spinach + onion. Divide into containers.\n\n`;
      plan += `*Daily assembly:*\n• Breakfast: 2 eggs + oats (cook fresh, 3 min)\n• Lunch: Chicken + rice + vegetables\n• Dinner: Beans + sweet potato + spinach\n• Snack: ${noDairy ? "Banana + 2 eggs" : "Yoghurt + banana"}\n\n`;
      plan += `~${cal} kcal | ~${prot}g protein/day.`;
    } else {
      plan += `*Total cook time: ~2.5 hours*\n*Budget: R300+*\n\n`;
      plan += `*Step 1 — Protein Rotation (50 min)*\nBake 1kg chicken breast (40 min). Brown 500g lean mince with onion + garlic (15 min). Boil 12 eggs (15 min).\n5 chicken portions + 4 mince portions + 12 eggs = week sorted.\n\n`;
      plan += `*Step 2 — Carb Base (25 min)*\nCook 1kg brown rice. Bake 1kg sweet potato chunks. Divide into containers.\n\n`;
      plan += `*Step 3 — Vegetables (20 min)*\nRoast broccoli + butternut (20 min at 200°C). Stir-fry spinach + cabbage.\n\n`;
      plan += `*Step 4 — Snack Prep (10 min)*\n${noDairy ? "Portion banana + peanut butter into containers." : "Portion Greek yoghurt + oats + banana into containers."}\n\n`;
      plan += `*Daily assembly:*\n• Breakfast: Oats + 2 eggs + banana\n• Lunch: Chicken + rice + roast veg\n• Dinner: Mince + sweet potato + spinach\n• Snack: ${noDairy ? "Peanut butter + banana" : "Greek yoghurt + oats"}\n\n`;
      plan += `~${cal} kcal | ~${prot}g protein/day.`;
    }

    plan += `\n\n*Pro tip:* Do this every Sunday. 2 hours saves you 7 days of bad decisions.`;
    await logChat(user.id, message, plan, "MEAL_PREP");
    return plan;
  }

  // ---- MY GROCERY LIST — personalized from last 7 days of logged meals ----
  if (m === "my grocery list" || m === "my groceries" || m === "personal shopping list" || /\b(my\s*grocery|personal.*shop|buy.*based.*on.*what.*eat|smart.*shop)\b/i.test(m)) {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      const recentFoodLogs = await db.select({ messageIn: chatHistory.messageIn }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, sevenDaysAgo)));

      if (recentFoodLogs.length < 3) {
        return `Not enough food logs to build your personal list yet. Log what you eat for a few days — just tell me "I had eggs and pap" — and I will build a grocery list based on YOUR actual meals.\n\nMeanwhile, type *shopping list* for a generic budget list.`;
      }

      // Scan all logged foods and count frequency
      const foodCounts: Record<string, { count: number; cal: number; prot: number; name: string }> = {};
      for (const log of recentFoodLogs) {
        const matched = scanForSAFoods(log.messageIn || "");
        for (const food of matched) {
          const key = food.name.toLowerCase();
          if (!foodCounts[key]) foodCounts[key] = { count: 0, cal: food.typicalPortionCalories || 0, prot: food.typicalPortionProtein || 0, name: food.name };
          foodCounts[key].count++;
        }
      }

      const sorted = Object.values(foodCounts).sort((a, b) => b.count - a.count);
      if (sorted.length === 0) {
        return `I could not match specific foods from your logs. Type *shopping list* for a generic budget list, or log meals using SA food names (pap, pilchards, chicken, etc).`;
      }

      const budget = user.weeklyFoodBudget || "100_300";
      const name = user.name?.split(" ")[0] || "there";
      const topFoods = sorted.slice(0, 12);

      // Build grocery items from their actual eating patterns
      const groceryItems: string[] = [];
      const proteinItems: string[] = [];
      const carbItems: string[] = [];
      const vegItems: string[] = [];
      const otherItems: string[] = [];

      for (const food of topFoods) {
        const n = food.name.toLowerCase();
        const weeklyServings = Math.ceil(food.count * (7 / 7)); // project to full week
        if (["chicken", "beef", "mince", "fish", "hake", "pilchards", "tuna", "eggs", "biltong", "boerewors", "wors", "sardines", "salmon", "pork", "lamb", "turkey"].some(p => n.includes(p))) {
          proteinItems.push(`${food.name} — ${weeklyServings}× this week`);
        } else if (["pap", "rice", "bread", "oats", "sweet potato", "potato", "samp", "pasta", "cereal", "weetbix"].some(c => n.includes(c))) {
          carbItems.push(`${food.name} — ${weeklyServings}× this week`);
        } else if (["spinach", "cabbage", "broccoli", "tomato", "onion", "lettuce", "morogo", "beans", "lentils", "butternut"].some(v => n.includes(v))) {
          vegItems.push(`${food.name} — ${weeklyServings}× this week`);
        } else {
          otherItems.push(`${food.name} — ${weeklyServings}×`);
        }
      }

      let list = `*🛒 ${name}'s Personal Grocery List*\n_Based on your last 7 days of meals_\n\n`;
      if (proteinItems.length > 0) list += `*Protein:*\n${proteinItems.map(i => `• ${i}`).join("\n")}\n\n`;
      if (carbItems.length > 0) list += `*Carbs:*\n${carbItems.map(i => `• ${i}`).join("\n")}\n\n`;
      if (vegItems.length > 0) list += `*Vegetables:*\n${vegItems.map(i => `• ${i}`).join("\n")}\n\n`;
      if (otherItems.length > 0) list += `*Other:*\n${otherItems.map(i => `• ${i}`).join("\n")}\n\n`;

      // Add what's missing based on their targets
      const totalProtein = topFoods.reduce((s, f) => s + f.prot * f.count, 0);
      const avgDailyProt = totalProtein / 7;
      const protTarget = user.proteinTarget || 120;
      if (avgDailyProt < protTarget * 0.7 && proteinItems.length < 3) {
        const budgetSuggestion = budget === "under_100" ? "pilchards (R12/tin) or eggs (R4/egg)" : "frozen chicken portions (R40/kg) or eggs";
        list += `⚠️ *Protein gap detected* — add more ${budgetSuggestion} to hit your ${protTarget}g target.\n\n`;
      }

      list += `_Type *shopping list* for a full budget grocery list._`;
      await logChat(user.id, message, list, "PERSONAL_GROCERY");
      return list;
    } catch (err) {
      console.error("[PERSONAL GROCERY]", err);
      return `Could not generate your personal grocery list. Type *shopping list* for a generic one.`;
    }
  }

  // ---- SUPPLEMENT TRACKING — "my supplements" / "supps" / "vitamins" ----
  if (m === "supplements" || m === "supps" || m === "my supplements" || m === "vitamins" || m === "my vitamins" || /\b(supplement|supps|vitamin|multivitamin|creatine|omega|magnesium|zinc|iron|collagen)\b/i.test(m)) {
    // Check if they are logging a supplement intake
    const logSupp = /\b(took|taken|had|drank)\b.*\b(supplement|supps|vitamin|creatine|omega|magnesium|zinc|iron|collagen|multivitamin|fish oil|whey|bcaa)\b/i.test(m)
      || /\b(supplement|supps|vitamin|creatine|omega|magnesium|zinc|iron|collagen|multivitamin|fish oil|whey|bcaa)\b.*\b(took|taken|done|logged|had)\b/i.test(m);

    if (logSupp) {
      await logChat(user.id, message, "Supplement logged", "SUPPLEMENT_LOG");
      // Count today's supplement logs
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todaySuppLogs = await db.select({ id: chatHistory.id }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "SUPPLEMENT_LOG"), gte(chatHistory.createdAt, todayStart)));
      return `Supplement logged ✅ (${todaySuppLogs.length} today)\n\nConsistency with supplements matters more than the brand. Take them at the same time daily — set a phone alarm if needed.`;
    }

    // Otherwise give supplement guide based on their goal
    const goal = user.goalType || "fat_loss";
    const budget = user.weeklyFoodBudget || "100_300";
    const name = user.name?.split(" ")[0] || "";

    let suppGuide = `*💊 Supplement Guide${name ? ` — ${name}` : ""}*\n\n`;
    suppGuide += `*Essential (everyone):*\n`;
    suppGuide += `• Multivitamin — R50-R80/month (Clicks or Dis-Chem)\n`;
    suppGuide += `• Vitamin D3 — especially if indoor job\n\n`;

    if (goal === "muscle_gain") {
      suppGuide += `*For muscle gain:*\n`;
      suppGuide += `• Creatine monohydrate 5g/day — R150/month (most evidence-backed supplement)\n`;
      suppGuide += `• Whey protein — only if you cannot hit ${user.proteinTarget || 120}g from food\n\n`;
    } else {
      suppGuide += `*For fat loss:*\n`;
      suppGuide += `• Magnesium glycinate — R80/month (sleep, recovery, cravings)\n`;
      suppGuide += `• Omega 3 / Fish oil — R60/month (inflammation, joint health)\n\n`;
    }

    if (budget === "under_100") {
      suppGuide += `_On a tight budget? Skip supplements — get your protein from eggs and pilchards, your vitamins from spinach and cabbage. Food first, always._`;
    } else {
      suppGuide += `_Log your supplements: say "took my creatine" or "had my vitamins" and I will track consistency._`;
    }

    await logChat(user.id, message, suppGuide, "SUPPLEMENT_GUIDE");
    return suppGuide;
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
    const mediaTrace = buildMediaTrace(phone, ctype);
    console.log(`[MEDIA][${mediaTrace}] start type=${ctype || "unknown"} hasCaption=${Boolean(message && message.trim())}`);

    // ---- STICKER DETECTION — skip stickers (image/webp with no caption) ----
    if (ctype === "image/webp" && !message) {
      return "I see you sent a sticker — send me a food photo or type what you ate and I will log it.";
    }

    // ---- PROGRESS PHOTO or FOOD PHOTO ----
    if (ctype.startsWith("image/")) {
      try {
        // Twilio media requires auth — same as audio, use Basic auth with SID:TOKEN
        const twilioSid = process.env.TWILIO_ACCOUNT_SID || "";
        const twilioToken = process.env.TWILIO_AUTH_TOKEN || "";
        const imgAuthHeader = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
        const imageResponse = await withTimeout("image_download", 12000, () => fetch(mediaUrl, {
          headers: { Authorization: imgAuthHeader },
        }));
        if (!imageResponse.ok) {
          console.error(`[MEDIA][${mediaTrace}] image_download_failed ${imageResponse.status} ${imageResponse.statusText}`);
          await logMediaFailure(user.id, "image_download", `${imageResponse.status}`);
          return "Eish, I cannot read that photo right now. Tell me what you ate in text — 'chicken and sweet potato' — and I will give you the full breakdown.";
        }
        const imageLen = parseInt(imageResponse.headers.get("content-length") || "0", 10);
        if (imageLen > 8 * 1024 * 1024) {
          console.warn(`[MEDIA][${mediaTrace}] image_too_large content_length=${imageLen}`);
          return "That image is too large for reliable processing. Please resend a smaller screenshot or crop it tighter.";
        }
        const buffer = await imageResponse.arrayBuffer();
        if (buffer.byteLength > 10 * 1024 * 1024) {
          console.warn(`[MEDIA][${mediaTrace}] image_buffer_too_large bytes=${buffer.byteLength}`);
          return "That image is too large for reliable processing. Please resend a smaller screenshot or crop it tighter.";
        }
        const base64 = Buffer.from(buffer).toString("base64");
        const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
        const clientName = user.name || "there";
        const goal = user.goalType || "fat_loss";

        // ---- STEP SCREENSHOT DETECTION ----
        // If caption mentions steps/walking/pedometer, use GPT Vision to read the number
        const noCaption = !message || message.trim().length === 0;
        const isStepScreenshot = /\b(steps?|pedometer|walked|walking|step count|staps?|my walk|fitness app|samsung health|google fit|apple health|health app|screenshot)\b/i.test(message)
          || (user.awaitingInputType === "steps")
          || noCaption;
        if (isStepScreenshot) {
          try {
            const stepVisionResponse = await withTimeout("step_vision", 18000, () => openai.chat.completions.create({
              model: "gpt-4o-mini",
              max_tokens: 50,
              messages: [
                { role: "system", content: "Extract the step count number from this screenshot. Reply with ONLY the number. If you cannot find a step count, reply UNKNOWN." },
                { role: "user", content: [
                  { type: "text", text: "What is the step count shown in this screenshot?" },
                  { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } },
                ] },
              ],
            }));
            const stepText = stepVisionResponse.choices[0]?.message?.content?.trim() || "UNKNOWN";
            const extractedSteps = parseInt(stepText.replace(/[^0-9]/g, ""));
            // Guard against random OCR numbers from food labels/photos:
            // accept low numbers only when user explicitly indicated steps.
            const explicitStepIntent = /\b(steps?|pedometer|walk|walking|step count|screenshot)\b/i.test(message) || (user.awaitingInputType === "steps");
            const looksLikeStepCount = extractedSteps >= 500 && extractedSteps < 100000;
            const acceptableLowCount = explicitStepIntent && extractedSteps >= 100 && extractedSteps < 500;
            if (!isNaN(extractedSteps) && (looksLikeStepCount || acceptableLowCount)) {
              const target = user.stepsTarget || 10000;
              const todayStartSteps = new Date(); todayStartSteps.setHours(0, 0, 0, 0);
              const existingStep = await db.select({ id: stepLogs.id })
                .from(stepLogs)
                .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, todayStartSteps)))
                .limit(1);
              if (existingStep.length > 0) {
                await db.update(stepLogs).set({ steps: extractedSteps }).where(eq(stepLogs.id, existingStep[0].id));
              } else {
                await db.insert(stepLogs).values({ userId: user.id, steps: extractedSteps });
              }
              await db.update(users).set({ lastActiveAt: new Date(), awaitingInputType: null }).where(eq(users.phoneNumber, phone));
              const stepReply = getStepResponse(extractedSteps, target);
              const [perfectDay, streak] = await Promise.all([checkPerfectDay(user.id), getStepStreak(user.id)]);
              const streakNote = streak >= 3 ? `\n\n🔥 ${streak}-day step streak.` : streak === 2 ? `\n\n2 days in a row. Build the habit.` : "";
              await logChat(user.id, `[Step Screenshot: ${extractedSteps}]`, stepReply, "STEP_LOG");
              console.log(`[MEDIA][${mediaTrace}] step_logged value=${extractedSteps}`);
              return stepReply + streakNote + (perfectDay || "");
            }
          } catch (e) {
            console.warn("[step-vision]", e);
            await logMediaFailure(user.id, "step_vision", e);
          }
          console.warn(`[MEDIA][${mediaTrace}] step_extract_failed`);
          await logMediaFailure(user.id, "step_extract", "unknown_or_low_confidence");
          return "I could not read the step number clearly from that screenshot. Please resend and crop to the step count only, or type: steps 7421.";
        }

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
        // Rate limit food photo logging — max 3 per day (only count actual photo logs, not text food entries)
        const todayStartPhoto = new Date(); todayStartPhoto.setHours(0, 0, 0, 0);
        const photoCountResult = await db.select({ count: sql`count(*)` })
          .from(chatHistory)
          .where(and(eq(chatHistory.userId, user.id), gte(chatHistory.createdAt, todayStartPhoto), eq(chatHistory.intent, "FOOD_LOG"), eq(chatHistory.messageIn, "[Photo]")));
        const photoCountToday = parseInt(String(photoCountResult[0]?.count || 0));
        if (photoCountToday >= 3) {
          return `3 food photos logged today — I have a clear picture of how you're eating. Keep it consistent and send me tomorrow's first meal.`;
        }

        const { calorieTarget: liveCal, proteinTarget: liveProt } = calculateTargets(
          parseFloat(user.currentWeight || "75"), goal, user.lifeSituation || "office", user.trainingDaysPerWeek || 3
        );
        const visionResponse = await withTimeout("food_vision", 22000, () => openai.chat.completions.create({
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

COACHING: One sentence on whether this meal works for their ${goal} goal. If good — say exactly why. If not — suggest a better way to prepare THE SAME FOOD they are already eating (e.g. grilled instead of fried, less oil, bigger portion of protein). NEVER suggest a completely different cheaper food — if they are eating fish, coach them on fish. If they are eating steak, coach them on steak. If they are eating sushi, coach them on sushi. Meet the client where they are.

UNKNOWN FOOD: If you cannot identify the food in the image — respond only with: Eish, I cannot make out the food clearly. Take the photo in better light and send again.${message ? `\n\nCLIENT CAPTION: "${message}" — use this to help identify the food.` : ""}`,
                },
                { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } },
              ],
            },
          ],
        }));

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
            totalCal += matched.reduce((s: number, f: any) => s + (f.typicalPortionCalories || 0), 0);
            totalProt += matched.reduce((s: number, f: any) => s + (f.typicalPortionProtein || 0), 0);
          }
          const calTarget = user.calorieTarget || 1800;
          const protTarget = user.proteinTarget || 130;
          if (totalCal > 0) {
            const remaining = calTarget - totalCal;
            photoDailyTotal = `\n\n_Today so far: ~${totalCal} kcal | ${totalProt}g protein. Target: ${calTarget} kcal | ${protTarget}g protein.${remaining > 100 ? ` ${remaining} kcal remaining.` : " On target."}_`;
          }
        } catch (e) { console.warn("[non-fatal]", e); }
        return `${visionReply}${photoPattern ? "\n\n" + photoPattern : ""}${photoDay || ""}${photoDailyTotal}`;
      } catch (err) {
        console.error(`[MEDIA][${mediaTrace}] vision_error:`, err);
        await logMediaFailure(user.id, "vision", err);
        return "Eish, I cannot read that photo right now. Tell me what you ate in text — 'chicken and sweet potato' — and I will give you the full breakdown.";
      }
    }

    // ---- VOICE NOTE ----
    // Exclusive: if audio, always return — never falls through to text handler
    if (ctype.startsWith("audio/")) {
      let voiceStage = "download";
      try {
        // Part 1 — Twilio media requires basic auth (ACCOUNT_SID:AUTH_TOKEN)
        const twilioSid = process.env.TWILIO_ACCOUNT_SID || "";
        const twilioToken = process.env.TWILIO_AUTH_TOKEN || "";
        const authHeader = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");

        // Retry once if Twilio download fails (intermittent 5xx errors)
        let audioResponse = await withTimeout("audio_download_1", 12000, () => fetch(mediaUrl, { headers: { Authorization: authHeader } }));
        if (!audioResponse.ok) {
          console.warn(`[VOICE] Twilio download attempt 1 failed: ${audioResponse.status}. Retrying...`);
          await new Promise(r => setTimeout(r, 1500));
          audioResponse = await withTimeout("audio_download_2", 12000, () => fetch(mediaUrl, { headers: { Authorization: authHeader } }));
        }

        if (!audioResponse.ok) {
          console.error(`[VOICE] Twilio download failed after retry: ${audioResponse.status} ${audioResponse.statusText}`);
          await logMediaFailure(user.id, "audio_download", `${audioResponse.status}`);
          return "I got your voice note but the audio did not download properly. Please send it again, or type your message and I will respond immediately.";
        }

        const audioLen = parseInt(audioResponse.headers.get("content-length") || "0", 10);
        if (audioLen > 16 * 1024 * 1024) {
          console.warn(`[MEDIA][${mediaTrace}] audio_too_large content_length=${audioLen}`);
          return "That voice note is too large to process reliably. Keep it under about 90 seconds and resend.";
        }
        const audioBuffer = await audioResponse.arrayBuffer();
        if (audioBuffer.byteLength > 16 * 1024 * 1024) {
          console.warn(`[MEDIA][${mediaTrace}] audio_buffer_too_large bytes=${audioBuffer.byteLength}`);
          return "That voice note is too large to process reliably. Keep it under about 90 seconds and resend.";
        }
        // Reject clips that are too short for Whisper to process (<1KB ≈ ~0.5s of audio)
        if (audioBuffer.byteLength < 1000) {
          return "That voice note was too short for me to pick up. Hold the mic button for at least 2-3 seconds, then send again — or just type your message.";
        }

        voiceStage = "transcribe";

        // Part 2 — preserve Twilio content type when available to avoid codec/mime mismatch.
        const sourceAudioType = (audioResponse.headers.get("content-type") || ctype || "audio/ogg").split(";")[0].trim().toLowerCase();
        const extMap: Record<string, string> = {
          "audio/ogg": "ogg",
          "audio/opus": "ogg",
          "audio/mpeg": "mp3",
          "audio/mp3": "mp3",
          "audio/mp4": "mp4",
          "audio/aac": "aac",
          "audio/wav": "wav",
          "audio/x-wav": "wav",
          "audio/webm": "webm",
          "audio/amr": "amr",
        };
        const audioExt = extMap[sourceAudioType] || "ogg";
        const audioFile = new File([audioBuffer], `audio.${audioExt}`, { type: sourceAudioType || "audio/ogg" });

        // Detect language from user's stored preference for better Whisper accuracy
        const storedLangPref = (user.profileNotes || "").match(/lang:([a-z]{2})/)?.[1];
        const whisperLangMap: Record<string, string> = { zu: "zu", xh: "xh", st: "st", tn: "tn", ts: "ts", af: "af", en: "en" };
        const whisperLang = storedLangPref && whisperLangMap[storedLangPref] ? whisperLangMap[storedLangPref] : undefined;

        const transcription = await withTimeout("voice_transcribe", 25000, () => openai.audio.transcriptions.create({
          file: audioFile,
          model: "whisper-1",
          ...(whisperLang ? { language: whisperLang } : {}),
        }));

        const transcribedText = transcription.text?.trim();

        // Part 3 — Handle result
        if (!transcribedText) {
          return "I could not hear that clearly. Try sending a voice note in a quieter spot, or type your message.";
        }

        const wordCount = transcribedText.split(/\s+/).filter(Boolean).length;
        if (wordCount < 3) {
          return `I only caught a few words — "${transcribedText}". Send again or type your message.`;
        }

        // Language detection — includes Tswana and Tsonga alongside Zulu, Sotho, Xhosa, Afrikaans
        const ZULU_WORDS = ["sawubona", "yebo", "ngiyabonga", "unjani", "siyabonga", "hawu", "eish", "askies", "ngicela", "ngifuna"];
        const SOTHO_WORDS = ["dumela", "ke a leboga", "o kae", "kea leboha", "ntate", "mme", "ke kopa", "ke batla"];
        const XHOSA_WORDS = ["molo", "enkosi", "unjani", "ewe", "hayi", "camagu", "ndiyabona", "ndicela", "ndifuna"];
        const TSWANA_WORDS = ["go siame", "ke a leboga", "rra", "lo kae", "ke tsile", "ke kopa", "thobela", "pula"];
        const TSONGA_WORDS = ["avuxeni", "nkhensa", "ndza khensa", "hi kona", "ndzi lava", "ndzi kopa", "swinene"];
        const AFRIKAANS_WORDS = ["dankie", "asseblief", "môre", "more", "lekker", "baie", "nee", "ja nee", "ag nee", "eina", "ek is", "ek het"];
        const lowerTranscribed = transcribedText.toLowerCase();
        let languageNote = "";
        if (ZULU_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Zulu. Respond in simple SA English but acknowledge their language naturally — you may use a word or two of Zulu.";
        else if (SOTHO_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Sesotho. Respond in simple SA English but acknowledge their language naturally.";
        else if (XHOSA_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Xhosa. Respond in simple SA English but acknowledge their language naturally.";
        else if (TSWANA_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Setswana. Respond in simple SA English but acknowledge their language naturally.";
        else if (TSONGA_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Xitsonga. Respond in simple SA English but acknowledge their language naturally.";
        else if (AFRIKAANS_WORDS.some(w => lowerTranscribed.includes(w))) languageNote = "The client is communicating in Afrikaans. Respond in simple SA English but acknowledge their language naturally — you may use a word or two of Afrikaans.";

        console.log(`[VOICE] Transcribed (${whisperLang || "auto"}): "${transcribedText}"${languageNote ? " [" + languageNote.split(".")[0] + "]" : ""}`);

        voiceStage = "coach_reply";
        const voiceReply = await withTimeout("voice_coach_reply", 20000, () => handleMessage(phone, transcribedText + (languageNote ? `\n\n[LANGUAGE NOTE: ${languageNote}]` : "")));
        // Part 4 — explicit return, no fall-through
        console.log(`[MEDIA][${mediaTrace}] voice_processed words=${wordCount}`);
        return `🎤 I heard: "${transcribedText}"\n\n${voiceReply}`;

      } catch (err) {
        console.error(`[VOICE] Processing error at stage "${voiceStage}":`, err);
        await logMediaFailure(user.id, `voice_${voiceStage}`, err);
        // Part 4 — always return, never fall through to text handler
        if (voiceStage === "transcribe") {
          return "I received your voice note but could not transcribe it clearly. Try again in a quieter spot, or type your message.";
        }
        if (voiceStage === "coach_reply") {
          return "I heard your voice note but could not generate the coaching reply right now. Send it once more, or type your message.";
        }
        return "I got your voice note but could not process it right now. Please send it again, or type your message and I will respond immediately.";
      }
    }

    // ---- FORM CHECK VIDEO ----
    if (ctype.startsWith("video/")) {
      const isFormCheck = /\b(form|check|correct|right|wrong|how does|how do i look|am i doing|check my|my form|form check|squat form|deadlift form|bench form|my squat|my deadlift|my bench|watch this|look at this)\b/i.test(message);
      const exerciseHint = /\b(squat|deadlift|rdl|bench|row|press|curl|hip thrust|lunge|pull.?up)\b/i.exec(message);
      const exerciseName = exerciseHint ? exerciseHint[1] : null;
      const clientNameVid = user.name || "there";

      const formCheckKeyPoints: Record<string, string> = {
        squat: "bottom position (thighs parallel or below)",
        deadlift: "mid-shin position as the bar passes your knee",
        rdl: "bottom of the hinge where you feel the hamstring stretch",
        bench: "bar at the chest — lowest point of the press",
        "hip thrust": "top of the movement — full hip extension",
        row: "peak contraction — elbow fully back",
        press: "starting position — bar or dumbbell at shoulder height",
        curl: "peak contraction — arm fully shortened",
        lunge: "bottom of the lunge — back knee near the floor",
        "pull-up": "chin at bar level",
      };

      const keyPoint = exerciseName ? formCheckKeyPoints[exerciseName.toLowerCase()] : null;
      const specificAsk = keyPoint
        ? `For the *${exerciseName}*, send me a clear photo of the *${keyPoint}*. That is the moment I need to see to give you accurate feedback.`
        : `Send me a clear still photo at the most important moment of the movement — usually the bottom of a squat or deadlift, or the peak contraction for upper body. Good lighting, full body in frame.`;

      const videoReply = `Got the video${clientNameVid !== "there" ? `, ${clientNameVid}` : ""}. I cannot analyse video directly — WhatsApp compresses it too much for accurate form coaching.\n\n${specificAsk}\n\nOnce I see the photo I will tell you exactly what to fix.`;
      await logChat(user.id, "[Video]", videoReply, "FORM_CHECK");
      return videoReply;
    }

    // If mediaUrl present but content type is neither image, audio, nor video — return without processing text
    console.log(`[MEDIA] Unhandled content type: ${ctype} — ignoring`);
    return "I received your file but I can only process voice notes and food photos. Send those or type your message.";
  }


  // ---- DONE — workout complete (direct) ----
  if (/^(done!*|i.?m done!*|im done!*|all done!*|workout done!*|finished!*|completed!*|session done!*|training done!*|workout completed!*|done with workout!*|done with my workout!*|done training!*)$/i.test(m.replace(/[.!?,]+$/, "").trim())) {
    // Guard: prevent double-logging on the same calendar day (race condition + accidental re-send)
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const alreadyLoggedToday = await db.select({ id: workoutLogs.id })
      .from(workoutLogs)
      .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, todayStart)))
      .limit(1);
    if (alreadyLoggedToday.length > 0) {
      const name = user.name || "there";
      return `${name}, today's session is already logged. One workout counted per day — come back tomorrow and keep the streak going.`;
    }

    const newTotal = (user.totalWorkoutsCompleted || 0) + 1;
    let newDay = (user.programmeDayInWeek || 1) + 1;
    let newWeek = user.programmeWeek || 1;
    const daysPerWeek = user.trainingDaysPerWeek || 3;

    if (newDay > daysPerWeek) { newDay = 1; newWeek++; }
    // When week exceeds 4, cycle back to week 1 and advance the phase (4-week programme structure)
    // Phase advancement is also handled by the scheduler's Phase Advancement job (75% compliance check)
    // but this inline advance ensures the user is never stuck at "Week 4" indefinitely.
    let newPhase = user.programmePhase || 1;
    if (newWeek > 4) { newWeek = 1; newPhase = Math.min(newPhase + 1, 4); }

    // Workout streak — continues if last session was within 2 days (but NOT same calendar day,
    // which is already prevented by the double-log guard above)
    const lastW = user.lastWorkoutDate ? new Date(user.lastWorkoutDate) : null;
    const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
    let newStreak = 1;
    if (lastW) {
      const lastDay = new Date(lastW); lastDay.setHours(0, 0, 0, 0);
      const daysDiff = Math.floor((todayMidnight.getTime() - lastDay.getTime()) / 86400000);
      // daysDiff === 0 means same day — treated as fresh start (shouldn't happen after guard above)
      if (daysDiff >= 1 && daysDiff <= 2) newStreak = (user.workoutStreak || 0) + 1;
    }

    await db.update(users).set({
      totalWorkoutsCompleted: newTotal,
      lastWorkoutDate: new Date(),
      programmeDayInWeek: newDay,
      programmeWeek: newWeek,
      programmePhase: newPhase,
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
    } catch (e) { console.warn("[non-fatal]", e); }

    const celebrationFn = WORKOUT_DONE_RESPONSES[newTotal % WORKOUT_DONE_RESPONSES.length];
    const celebration = celebrationFn(newTotal, newDay);
    const perfectDay = await checkPerfectDay(user.id);

    // Auto-generate referral code at first milestone if not set — retry on collision
    if (!user.referralCode && [10, 25, 50].includes(newTotal)) {
      const namePrefix = (user.name || "KAM").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "K");
      let assigned = false;
      for (let attempt = 0; attempt < 5 && !assigned; attempt++) {
        const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString();
        const candidateCode = `${namePrefix}${randomSuffix}`;
        const existing = await db.select({ id: users.id }).from(users)
          .where(eq(users.referralCode, candidateCode)).limit(1);
        if (existing.length === 0) {
          await db.update(users).set({ referralCode: candidateCode }).where(eq(users.phoneNumber, phone));
          user.referralCode = candidateCode;
          assigned = true;
        }
      }
      if (!assigned) console.warn(`[REFERRAL] Could not assign unique code for ${phone} after 5 attempts`);
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
    const liftPrompt = newTotal >= 2
      ? `\n\n💡 *Log your lifts to track progress:* "bench 80kg 3x10", "squat 100kg x5", "deadlift 120kg"\nType *my lifts* anytime to see your all-time bests.`
      : newTotal === 1
      ? `\n\n💡 *Next session — log your weights* after each exercise: "bench 60kg 3x10". I track your progress week to week.`
      : "";
    let doneReply = `${celebration}${milestoneNote}${streakLine}\n\n✅ Workout ${newTotal} logged.${perfectDay || ""}${liftPrompt}`;

    // Progressive programme delivery — unlock next day's workout after completing each session
    try {
      const daysPerWeekDelivery = user.trainingDaysPerWeek || 3;
      const updatedUser = { ...user, programmeDayInWeek: newDay, programmeWeek: newWeek };
      if (newTotal === 1) {
        doneReply += `\n\n---\n\n${buildDay2Workout(updatedUser)}`;
      } else if (newTotal === 2) {
        doneReply += `\n\n---\n\n${buildDay3Workout(updatedUser)}`;
      } else if (newTotal === 3 && daysPerWeekDelivery >= 4) {
        // 4-day programme: deliver Day 4 (second lower body) after Day 3
        doneReply += `\n\n---\n\n${buildDayWorkout({ ...updatedUser, programmeDayInWeek: 4 })}`;
      }
    } catch (e) { console.warn("[day-delivery]", e); }

    return doneReply;
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
    // Sort longest keys first so "bench press machine" matches before "bench press" before "bench"
    for (const [key, val] of Object.entries(EXERCISE_MAP).sort((a, b) => b[0].length - a[0].length)) {
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
  const isExplicitWeight = /\b(weigh|weight is|weight now|weighed|weighed in|i am|i'm|my weight|scale says|scale said|came in at)\b/.test(m) || /^\d{2,3}(\.\d)?\s*kg[.!]?$/.test(m.trim()) || /\b\d{2,3}(\.\d)?\s*kg\b/.test(m);
  // Match "85kg" or "85 kg" or just "85" when preceded by a weight keyword
  const explicitKgMatch = m.match(/\b(\d{2,3}(?:\.\d{1,2})?)\s*(?:kg|kilos?)?\b/);
  if (isExplicitWeight && explicitKgMatch) {
    const newKg = parseFloat(explicitKgMatch[1]);
    if (newKg >= 35 && newKg <= 250) {
      const { calorieTarget: newCals, proteinTarget: newProtein } = calculateTargets(newKg, user.goalType || "fat_loss", user.lifeSituation || "office", user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, user.heightCm || 170);
      const prevKg = parseFloat(user.currentWeight || "0");
      const prevCals = user.calorieTarget || newCals;
      const prevProtein = user.proteinTarget || newProtein;
      await db.update(users).set({ currentWeight: newKg.toString(), calorieTarget: newCals, proteinTarget: newProtein }).where(eq(users.phoneNumber, phone));
      // Prevent duplicate weight logs — update today's entry if it exists, otherwise insert
      const todayWeightStart = new Date(); todayWeightStart.setHours(0, 0, 0, 0);
      const existingToday = await db.select({ id: weightLogs.id }).from(weightLogs)
        .where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, todayWeightStart)))
        .limit(1);
      if (existingToday.length > 0) {
        await db.update(weightLogs).set({ weight: newKg.toString() }).where(eq(weightLogs.id, existingToday[0].id));
      } else {
        await db.insert(weightLogs).values({ userId: user.id, weight: newKg.toString() });
      }
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
      } catch (e) { console.warn("[non-fatal]", e); }
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
      const { calorieTarget: newCals, proteinTarget: newProtein } = calculateTargets(mentionedKg, user.goalType || "fat_loss", user.lifeSituation || "office", user.trainingDaysPerWeek || 3, user.gender || "male", user.age || 30, user.heightCm || 170);
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
    const day1 = buildFullProgramme(updatedUser);
    const goalLabel = goal === "fat_loss" ? "Fat loss" : goal === "muscle_gain" ? "Muscle gain" : "Body recomposition";

    return `Sharp. ${days} days/week. ${exp.charAt(0).toUpperCase() + exp.slice(1)}. ${goalLabel}. Here is Day 1 — send *done* when finished to unlock Day 2.\n\n${day1}`;
  }

  // ---- FIX 4: EXPLICIT WORKOUT COMMANDS — hardcoded, never touch GPT ----
  // "Today's workout" and "Workouts" must always return directly. No GPT, no errors.
  const todayWorkoutPhrases = ["today", "today's workout", "todays workout", "workout today", "my workout", "show workout", "give me workout"];
  const fullProgrammePhrases = ["workouts", "my workouts"];
  if (todayWorkoutPhrases.includes(m)) {
    try {
      const workout = buildDayWorkout(user);
      const dayNum = user.programmeDayInWeek || 1;
      const week = user.programmeWeek || 1;
      const totalSessions = user.totalWorkoutsCompleted || 0;
      const poCtx = await getProgressiveOverloadContext(user.id);
      const sessionNote = totalSessions > 0 ? ` | Session ${totalSessions + 1}` : "";
      const r = `*Week ${week}${sessionNote}*\n\n${poCtx}*Day ${dayNum} — Your Workout Today*\n\n${workout}\n\nSend *done* when finished. Log lifts: "bench 80kg 3x10"`;
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
  // NOTE: If message also contains food (e.g. voice note: "I had eggs for breakfast and walked 3000 steps"),
  // we log steps but do NOT return early — let it fall through to food scanning
  const stepNumMatch = m.match(/\b([\d,]+)\s*(?:steps?|staps?)\b/i)
    || m.match(/(?:walked|done|did|logged)\s+([\d,]+)\s*(?:steps?|staps?)/i);
  const hasKmWalk = m.match(/(?:walked|loop|walk)\s+([\d.]+)\s*km/i);
  const hasDurationWalk = !stepNumMatch && !hasKmWalk && m.match(/(?:walked|walk|walking)\s+(?:for\s+)?(\d+)\s*(?:min(?:ute)?s?|hrs?|hours?)/i);
  let stepReplyPart = ""; // stored so we can combine with food reply if needed
  if (stepNumMatch || hasKmWalk || hasDurationWalk) {
    let steps = 0;
    if (stepNumMatch) {
      steps = parseInt(stepNumMatch[1].replace(/,/g, ""));
    } else if (hasKmWalk) {
      const km = Math.min(parseFloat(hasKmWalk[1]), 50); // cap at 50km (marathon+)
      steps = Math.round(km * 1300);
    } else if (hasDurationWalk) {
      let minutes = parseInt(hasDurationWalk[1]);
      const unit = hasDurationWalk[2]?.toLowerCase() || "";
      if (unit.startsWith("h")) minutes *= 60;
      steps = Math.round(minutes * 100);
    }
    if (!isNaN(steps) && steps > 100 && steps < 100000) {
      const target = user.stepsTarget || 8500;
      const todayStartSteps = new Date(); todayStartSteps.setHours(0, 0, 0, 0);
      const existingStep = await db.select({ id: stepLogs.id })
        .from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, todayStartSteps)))
        .limit(1);
      if (existingStep.length > 0) {
        await db.update(stepLogs).set({ steps }).where(eq(stepLogs.id, existingStep[0].id));
      } else {
        await db.insert(stepLogs).values({ userId: user.id, steps });
      }
      await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.phoneNumber, phone));
      const stepReply = getStepResponse(steps, target);
      const [perfectDay, streak] = await Promise.all([checkPerfectDay(user.id), getStepStreak(user.id)]);
      const streakNote = streak >= 3 ? `\n\n🔥 ${streak}-day step streak. Don't break it.` : streak === 2 ? `\n\n2 days in a row. Build the habit.` : "";
      stepReplyPart = stepReply + streakNote + (perfectDay || "");

      // Check if message ALSO contains food — if so, don't return yet, let food scanner handle it too
      const alsoHasFood = /\b(ate|had|having|eating|breakfast|lunch|dinner|supper|snack|eggs?|bread|toast|rice|chicken|pap|porridge|oats|milk|fish|pilchard|vienna|polony|cheese|yoghurt|banana|apple|mango|potato|beans|lentil|coffee|tea|juice|cereal|muesli|sandwich)\b/i.test(m);
      if (!alsoHasFood) {
        await logChat(user.id, message, stepReplyPart, "STEP_LOG");
        return stepReplyPart;
      }
      // If food is also present, log steps but continue to food scanning below
      await logChat(user.id, message, stepReplyPart, "STEP_LOG");
    }
  }

  // ---- WATER LOGGING HANDLER (Item 10) — no GPT ----
  const waterMatch = m.match(/(\d+(?:\.\d+)?)\s*(l|litre|liter|litres|liters|ml|millilitre|milliliter|glass(?:es)?|cup(?:s)?|bottle(?:s)?)\b/i);
  const hasWaterKeyword = /\b(water|drank|drank water|drank some|had water|drank my water|water intake|drinking water|water today|glass|glasses|bottle|bottles)\b/i.test(m);
  if (waterMatch && hasWaterKeyword) {
    const amount = parseFloat(waterMatch[1]);
    const unit = waterMatch[2].toLowerCase();
    let litres = amount;
    if (unit === "ml" || unit === "millilitre" || unit === "milliliter") litres = amount / 1000;
    else if (unit === "glass" || unit === "glasses") litres = amount * 0.25;
    else if (unit === "cup" || unit === "cups") litres = amount * 0.25;
    else if (unit === "bottle" || unit === "bottles") litres = amount * 0.5;

    // Reset daily water if date has changed — use SAST so midnight aligns with SA users
    const today = sastToday();
    const lastReset = user.waterLastResetDate; // stale value — used for streak check below
    // Personalise water target: 33ml per kg of bodyweight, minimum 2.0L
    const weightKgForWater = parseFloat(user.currentWeight as string || "0") || 75;
    const waterTarget = Math.max(2.0, Math.round(weightKgForWater * 0.033 * 10) / 10);

    // Atomic increment — prevents race condition on concurrent water logs
    const waterUpdated = await db.update(users).set({
      todayWater: sql`CASE WHEN water_last_reset_date = ${today} THEN COALESCE(today_water::numeric, 0) + ${litres} ELSE ${litres} END`,
      waterLastResetDate: today,
    }).where(eq(users.phoneNumber, phone)).returning({ todayWater: users.todayWater });
    const newTotal = Math.round((Number(waterUpdated[0]?.todayWater) || 0) * 10) / 10;
    const currentWater = Math.max(0, newTotal - litres); // value before this log

    // Water streak: only increment if this log crossed the target threshold AND
    // yesterday was also a logged day — prevents streak inflation after missed days.
    const yesterdaySAST = new Date(Date.now() + 2 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
    const crossedTarget = newTotal >= waterTarget && currentWater < waterTarget;
    const isConsecutive = lastReset === today || lastReset === yesterdaySAST;
    const newWaterStreak = crossedTarget
      ? (isConsecutive ? (user.waterStreak || 0) + 1 : 1)
      : (user.waterStreak || 0);

    await db.update(users).set({ waterStreak: newWaterStreak }).where(eq(users.phoneNumber, phone));

    const remaining = Math.max(0, Math.round((waterTarget - newTotal) * 10) / 10);
    const targetHit = newTotal >= waterTarget;
    let waterReply = `Logged ${litres}L water. Total today: ${newTotal}L / ${waterTarget}L target.`;
    if (targetHit) {
      waterReply += ` Daily target hit.`;
      if (crossedTarget && newWaterStreak >= 3) {
        waterReply += ` ${newWaterStreak}-day water streak — consistency is showing.`;
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
    const wKg = parseFloat(user.currentWeight as string || "0") || 75;
    const wTarget = Math.max(2.0, Math.round(wKg * 0.033 * 10) / 10);
    const remaining = Math.max(0, Math.round((wTarget - todayW) * 10) / 10);
    const waterQReply = `Daily water target: *${wTarget}L* (based on your body weight).\n\nYou have logged ${todayW}L today — ${remaining > 0 ? `${remaining}L still to go.` : `target hit.`}\n\nTo log water, send the amount: "drank 500ml", "had 1L", "2 glasses of water".`;
    await logChat(user.id, message, waterQReply, "WATER_QUESTION");
    return waterQReply;
  }

  // ---- FIX 2: CORRECTION DETECTION — "no I had a burger", "actually it was chicken" ----
  // Must run BEFORE food scanner. Strips correction prefix and re-processes the corrected food.
  const CORRECTION_PREFIX = /^(no[,!\s]+|actually[,\s]+|i meant[,\s]+|not that[,\s]+|wait[,\s]+|no wait[,\s]+|correction[,\s]*)/i;
  // Detect food corrections: "No I had a burger", "Actually it was chicken"
  // Also detect prefix + food with no trigger word: "No 3 boiled eggs" (user correcting quantity)
  const correctedMsgCandidate = m.replace(CORRECTION_PREFIX, "").trim();
  const hasCorrectionPrefix = CORRECTION_PREFIX.test(m);
  const hasFoodTriggerAfterPrefix = /\b(had|ate|eaten|eating|breakfast|lunch|dinner|supper|meal|it was|was a|i had|i said|the above|mentioned|i'll have|i will have)\b/i.test(m);
  const hasFoodAfterPrefix = hasCorrectionPrefix && correctedMsgCandidate.length > 2 && scanForSAFoods(correctedMsgCandidate).length > 0;
  const isFoodCorrection = hasCorrectionPrefix && (hasFoodTriggerAfterPrefix || hasFoodAfterPrefix);

  // Also detect reference corrections: "the eggs go with the breakfast", "I was correcting",
  // "read it again", "that's part of the meal", "goes with the first one"
  const isReferenceCorrection = /\b(go with|goes with|part of|was correcting|was part|belongs to|same meal|together with|included in|go together|read it again|read that again|i was correcting|that.?s the same|the above mentioned|above mentioned|i said i had|i said for lunch|i said for dinner|i said for breakfast)\b/i.test(m);

  if (isFoodCorrection || isReferenceCorrection) {
    // If it's a reference correction (no new food info), don't create new entries — let GPT handle
    if (isReferenceCorrection && !hasCorrectionPrefix) {
      // Route to GPT — it has chat history context to understand what the user means
      // MUST return here to prevent food scanner from creating duplicate entries
      const gptRef = await askCoachK(message, user, "The user is referencing or correcting a previous food log. Use chat history to understand what they mean and respond helpfully. Do NOT log new food.");
      await logChat(user.id, message, gptRef, "FOOD_CORRECTION_REF");
      return gptRef;
    } else {
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
          const recomputed = await recomputeTodayFoodTotals(user.id);
          await db.update(users).set({
            todayCalories: recomputed.calories,
            todayProteinG: recomputed.protein,
            todayCaloriesDate: sastToday(),
          }).where(eq(users.id, user.id));
        }
      } catch (e) { console.warn("[non-fatal]", e); }
      // Strip the correction prefix and process the remaining message as the actual food
      if (correctedMsgCandidate && correctedMsgCandidate.length > 2 && correctedMsgCandidate !== m) {
        return await handleMessage(phone, correctedMsgCandidate);
      }
    }
  }

  // ---- FOOD ADDITION HANDLER — "there was also X in the meal", "X was in the meal" ----
  // Catches when the client corrects a food log by adding a missing item
  const isFoodAddition = /\b(there was|was also|also had|forgot|missed|you missed|you forgot|didn.?t include|didn.?t log|was in the meal|in the meal|it also had|it had|was in there)\b/i.test(m) &&
    scanForSAFoods(m).length > 0;
  if (isFoodAddition) {
    // Don't strip — just process as a new food log to add to today's total
    // The food scanner will pick up the food items and add them to the running total
    // Fall through to the food scanner below
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

  // ---- COMMAND INTERCEPT — "log the meal", "log this", "save this", "log it" ----
  // If user says "log it" / "sis you log it?" etc., check if the last message contained food
  // that wasn't logged, and re-process it as a food entry
  const isLogCommand =
    /\b(log\s*(the\s*)?(meal|this|it|food)|save\s*(the\s*)?(meal|this|food)|record\s*(the\s*)?(meal|this)|add\s*(the\s*)?(meal|this)|please\s*log|can\s*you\s*log|you\s*log\s*it|done logging|finished logging|that.?s it for (today|now|this meal)|that.?s my (meal|food|breakfast|lunch|dinner|supper)|log\s*it)[?!.\s]*$/i.test(m.trim());

  if (isLogCommand) {
    // Check if the previous message had food that wasn't logged — re-process it
    try {
      const recentChats = await db.select({ messageIn: chatHistory.messageIn, intent: chatHistory.intent })
        .from(chatHistory)
        .where(eq(chatHistory.userId, user.id))
        .orderBy(desc(chatHistory.createdAt))
        .limit(3);
      const lastUnloggedFood = recentChats.find(c => c.intent !== "FOOD_LOG" && c.messageIn);
      if (lastUnloggedFood) {
        const foodsInLastMsg = scanForSAFoods(lastUnloggedFood.messageIn || "");
        if (foodsInLastMsg.length > 0) {
          // Re-process the last message as food
          let totalCals = 0; let totalProt2 = 0;
          const parts: string[] = [];
          for (const food of foodsInLastMsg) {
            totalCals += food.typicalPortionCalories || 0;
            totalProt2 += food.typicalPortionProtein || 0;
            parts.push(`${food.name} — ${food.typicalPortionCalories} kcal | ${food.typicalPortionProtein}g protein`);
          }
          await logChat(user.id, lastUnloggedFood.messageIn || "", parts.join("\n"), "FOOD_LOG");
          // Update daily totals
          const todayStr3 = sastToday();
          const prevCals = user.todayCaloriesDate === todayStr3 ? (user.todayCalories || 0) : 0;
          const prevProt = user.todayCaloriesDate === todayStr3 ? (user.todayProteinG || 0) : 0;
          await db.update(users).set({
            todayCalories: prevCals + totalCals,
            todayProteinG: prevProt + totalProt2,
            todayCaloriesDate: todayStr3,
          }).where(eq(users.phoneNumber, phone));
          return `Logged! ✅\n${parts.join("\n")}\n\n_Today: ${prevCals + totalCals} kcal | ${prevProt + totalProt2}g protein_`;
        }
      }
    } catch { /* non-fatal — fall through to summary */ }

    const todayStart2 = new Date(); todayStart2.setHours(0, 0, 0, 0);
    const todayLogs = await db.select({ messageIn: chatHistory.messageIn })
      .from(chatHistory)
      .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart2)));
    if (todayLogs.length === 0) {
      return `Nothing logged yet today. Tell me what you ate — "I had pap and eggs" or "chicken and sweet potato" — and I will log the calories and protein.`;
    }
    const name = user.name ? ` ${user.name}` : "";
    let totalCal = 0; let totalProt = 0;
    for (const log of todayLogs) {
      const matched = scanForSAFoods(log.messageIn || "");
      totalCal += matched.reduce((s, f) => s + (f.typicalPortionCalories || 0), 0);
      totalProt += matched.reduce((s, f) => s + (f.typicalPortionProtein || 0), 0);
    }
    const calTarget = user.calorieTarget || 1800;
    const protTarget = user.proteinTarget || 120;
    const remaining = calTarget - totalCal;
    const protRemaining = protTarget - totalProt;
    const summary = totalCal > 0
      ? `Today so far:${name} *${totalCal} kcal | ${totalProt}g protein*\nTarget: ${calTarget} kcal | ${protTarget}g protein\n${remaining > 0 ? `${remaining} kcal and ${protRemaining}g protein still to go.` : `Calorie target reached. ✅`}`
      : `${todayLogs.length} meal${todayLogs.length > 1 ? "s" : ""} logged today. Keep sending what you eat and I track the running total.`;
    return summary;
  }

  // Shared message-type flags used by ALL food handlers below
  const isQuestion = m.includes("?") ||
    /^(what|should|can i|is |are |how|why|when|tell me about|which|do i|where)/.test(m) ||
    /\b(from where|where can|where do|where to|how much|how many|is it|is that|are they|are those|should i|can i|do i|does it|what is|what are|which one|good for|bad for|healthy|unhealthy|worth it|better than|worse than)\b/.test(m);
  // Frustration guard — but NOT if the message also contains food correction intent
  const hasFrustrationWords = /\b(no no|that.?s not|not true|not right|wrong|incorrect|read everything|come on|what the hell|terrible|rubbish|nonsense|adjust it|fix it|change it|update it|that.?s wrong|bull|crap|ridiculous|do a better|better job|what\??!*$|huh\??|excuse me|are you sure|doesn.?t look right|not correct|try again|redo|recalculate)\b/i.test(m);
  // "read it again" and "read that again" are corrections, not frustration — handled by correction flow
  const isFrustration = hasFrustrationWords && !/\b(i had|i ate|i said|the above|for lunch|for dinner|for breakfast|go with|goes with|part of|same meal|i was correcting)\b/i.test(m);
  // Log triggers: words that suggest the user is REPORTING food they ate/are eating
  // Standalone meal words (breakfast/lunch/dinner) are safe because the food logging gate
  // at line ~2218 ALSO requires hasActualFood (scanner must find real food in the message)
  const hasLogTrigger = /\b(ate|had|have|having|eating|i'll have|i will have|gonna have|going to have|breakfast|lunch|dinner|supper|snack|brunch|for breakfast|for lunch|for dinner|for supper|for snack|for brunch|breakfast was|lunch was|dinner was|supper was|just had|just ate|meal was|meal is|food was|i ate|i had|i've had|ive had)\b/.test(m);

  // ---- BRAAI / SOCIAL EVENT GUIDE — SA-specific coaching ----
  const hasSocialEventKeyword = /\b(braai|braaing|braaiing|party|wedding|funeral|umemulo|umkhosi|stokvel|church.*food|family.*gathering|get.?together|celebration)\b/i.test(m);
  if (hasSocialEventKeyword && !isQuestion && !isFrustration) {
    const goal = user.goalType || "fat_loss";
    const name = user.name?.split(" ")[0] || "";
    const isBraai = /braai/i.test(m);

    let eventReply = "";
    if (isBraai) {
      eventReply = goal === "muscle_gain"
        ? `*Braai Protocol — Muscle Mode* 🔥\n\n• Chicken pieces: BEST — 28g protein each, skin off after cooking\n• Wors: 1-2 rolls (20-30g protein) ✅ Keep it\n• Boerewors chops: high fat but solid protein — 1 portion\n• Pap + sous: fine — keep butter small\n• Potato salad: small portion or skip\n\n*Your plate:* 3 chicken pieces + 1 wors + small pap = ~750 kcal, ~55g protein. Sorted.\n\nDrink: Water first. Max 2 beers — after food, not before.`
        : `*Braai Protocol — Fat Loss Mode* 🔥\n\n• Chicken pieces: BEST option — remove skin, 165 kcal, 28g protein each\n• Wors: 1 roll max — not every braai\n• Pap: small portion, no extra butter\n• Potato salad, coleslaw: skip — not worth the calories\n• Braai broodjie: 1 is fine. 3 is not.\n\n*Your plate:* 2-3 chicken pieces + small pap + salad = ~550 kcal, ~45g protein. Win.\n\n⚠️ Beers are the silent killer at braais — 1 Castle = 150 kcal, nobody has just one. Water between drinks minimum.`;
    } else {
      eventReply = `*Social Event Strategy* 🎉\n\n${name ? name + ", " : ""}Go. Enjoy. Do not avoid social events because of your plan.\n\n*Before:*\n• Eat a high-protein meal before you go — 2 eggs, chicken, pilchards\n• This kills hunger so you are not eating everything in sight\n\n*During:*\n• Plate protein FIRST — chicken, meat, fish\n• One plate, not three. Serve yourself once.\n• Water between drinks. Every time.\n• ${goal === "fat_loss" ? "Skip the starch if you can — focus on meat and salad" : "Eat the starch — you need the fuel. Just one serving."}\n\n*After:*\n• Log what you ate tomorrow morning — I will be here\n• No guilt. One event does not undo weeks of work\n• Back on plan the next meal. Not Monday. The next meal.`;
    }

    eventReply += `\n\n_Send me what you ate tomorrow morning — no judgment, just logging. I will help you get back on track._`;
    await logChat(user.id, message, eventReply, "FOOD_LOG");
    return eventReply;
  }

  // ---- EATING OUT GUIDE — SA fast food and restaurant coaching ----
  const eatingOutPlace =
    m.includes("nandos") || m.includes("nando's") ? "nandos" :
    m.includes("kfc") ? "kfc" :
    m.includes("steers") ? "steers" :
    m.includes("wimpy") ? "wimpy" :
    m.includes("chicken licken") ? "chicken_licken" :
    m.includes("debonairs") ? "debonairs" :
    m.includes("mcdonalds") || m.includes("mcdonald's") ? "mcdonalds" :
    m.includes("ocean basket") ? "ocean_basket" :
    null;

  const hasEatingOutTrigger = /\b(eating at|ordering from|order from|going to|had at|ate at|having at|went to|was at|from)\b/.test(m);
  if (eatingOutPlace && !isQuestion && !isFrustration) {
    const goal = user.goalType || "fat_loss";
    const guides: Record<string, string> = {
      nandos: `*Nando's — Coach K Pick*\n\n✅ Best: Quarter chicken (skin off) + peri-peri chips + coleslaw = ~650 kcal, 35g protein\n✅ Good: Grilled chicken wrap (no sauce, extra coleslaw)\n⚠️ Watch: Double chicken = fine if that's your big meal\n❌ Avoid: Chips as main + roll + dessert = 1,200 kcal\n\nFlame-grilled is always better than fried. Skin off saves 80-100 kcal.`,
      kfc: `*KFC — Coach K Pick*\n\n✅ Best: Streetwise 2 (original, not zinger) = ~550 kcal, 32g protein\n✅ OK: Grilled chicken pieces × 2\n⚠️ Watch: Coleslaw is fine. Chips is a carb bomb — skip or halve\n❌ Avoid: Zinger towers, combos with large chips + cooldrink = 1,200+ kcal\n\nIf you're going KFC: 2 pieces original + coleslaw. That's it. No cooldrink.`,
      steers: `*Steers — Coach K Pick*\n\n✅ Best: Classic beef burger, no sauce, extra lettuce = ~650 kcal, 35g protein\n✅ OK: Chicken burger (no mayo)\n⚠️ Watch: Onion rings = 400 extra kcal — skip\n❌ Avoid: Ribs + chips + cooldrink combo = 1,500+ kcal\n\nBurger only, no combo. Ask for no mayo. Works.`,
      wimpy: `*Wimpy — Coach K Pick*\n\n✅ Best: Grilled chicken + salad (no dressing) = ~500 kcal, 38g protein\n✅ Good: Eggs + toast (breakfast) — solid protein\n⚠️ Watch: Toasted sandwiches are sneaky carbs\n❌ Avoid: Burgers + chips + milkshake = 1,400 kcal\n\nWimpy breakfast is actually one of the better fast food options for protein.`,
      chicken_licken: `*Chicken Licken — Coach K Pick*\n\n✅ Best: 2-piece soul meal (original) = ~580 kcal, 30g protein\n⚠️ Watch: Hot portions chips = 400 kcal on their own\n❌ Avoid: Family buckets, adding a roll and cooldrink to every order\n\nChicken Licken is fine as a protein hit — just don't turn it into a 4-piece meal with all the extras.`,
      debonairs: `*Debonairs — Coach K Pick*\n\n✅ Best: Thin base, chicken topping, half a medium = ~500-600 kcal\n⚠️ Watch: Cheese-stuffed crust adds 150 kcal per slice\n❌ Avoid: Triple Decker, Gatsby-style loaded options\n\nPizza can fit — 2 slices thin base chicken is roughly 500-600 kcal. Problem is nobody stops at 2 slices. Set your portion before it arrives.`,
      mcdonalds: `*McDonald's — Coach K Pick*\n\n✅ Best: McFeast (no sauce) = ~550 kcal, 32g protein\n✅ Good: Grilled chicken wrap\n⚠️ Watch: Fries = 340 kcal. Skip or share.\n❌ Avoid: Combos with large fries + large coke = 1,100+ kcal added\n\nBurger only, water or diet cooldrink. That's a manageable meal.`,
      ocean_basket: `*Ocean Basket — Coach K Pick*\n\n✅ Best: Grilled linefish + salad = ~450 kcal, 40g protein — legitimately excellent\n✅ Good: Calamari (grilled not battered) + salad\n⚠️ Watch: Battered = adds 200 extra kcal\n❌ Avoid: Chips with everything, creamy sauces\n\nOcean Basket is one of the best restaurant options — high protein, low fat if you go grilled.`,
    };
    const guide = guides[eatingOutPlace] || "";
    if (guide) {
      const goalNote = goal === "fat_loss" ? `\n\n_Your goal is fat loss — the right order here keeps you on track without missing out._` : `\n\n_Your goal is muscle — prioritise protein options and eat to fullness._`;
      const eatingReply = `${guide}${goalNote}`;
      await logChat(user.id, message, eatingReply, "FOOD_LOG");
      return eatingReply;
    }
  }

  // ---- QUICK RE-LOG — "same as yesterday", "same as lunch", "had the same for dinner" ----
  // Catches: "same as lunch", "same as my lunch", "had the same for dinner as my lunch",
  //          "same meal again for dinner", "repeat meal", "same as yesterday"
  const isRepeatMeal = /\b(same as (yesterday|my\s*lunch|my\s*dinner|my\s*breakfast|lunch|dinner|breakfast|last|before)|same meal|repeat meal|same again|same food|had the same|the same (meal|food|thing) (for|as)|same (breakfast|lunch|dinner)|repeat (breakfast|lunch|dinner)|yesterday.?s (meal|food))\b/i.test(m);
  if (isRepeatMeal) {
    try {
      // Which meal are they referencing? Prefer the one they mention after "as" / "as my"
      const refLunch = /\b(same as (my )?lunch|same (meal|food).*for dinner|had the same.*lunch|lunch again)\b/i.test(m);
      const refDinner = /\b(same as (my )?dinner|same (meal|food).*for lunch|had the same.*dinner|dinner again)\b/i.test(m);
      const refBreakfast = /\b(same as (my )?breakfast|breakfast again)\b/i.test(m);
      const refYesterday = /yesterday/i.test(m);

      // Search window: today first, then last 48h for "same as yesterday"
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const windowStart = refYesterday
        ? new Date(Date.now() - 48 * 3600_000)
        : todayStart;

      const recentFoodLogs = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut, createdAt: chatHistory.createdAt })
        .from(chatHistory)
        .where(and(
          eq(chatHistory.userId, user.id),
          eq(chatHistory.intent, "FOOD_LOG"),
          gte(chatHistory.createdAt, windowStart),
        ))
        .orderBy(desc(chatHistory.createdAt))
        .limit(10);

      const LOG_CMD_RE2 = /^(log\s*(the\s*)?(meal|this|it|food)|save|record|done|that.?s|yes|ok|sure)/i;
      const validLogs = recentFoodLogs.filter(l =>
        l.messageIn &&
        !LOG_CMD_RE2.test(l.messageIn.trim()) &&
        l.messageIn.length > 5 &&
        scanForSAFoods(l.messageIn).length > 0  // must have actual food in it
      );

      if (validLogs.length === 0) {
        return `No recent meals found to repeat. Tell me what you had — for example: "2 eggs and toast".`;
      }

      let toRepeat = validLogs[0].messageIn!;

      // Try to find the specific meal type they referenced
      if (refLunch) {
        const lunchLog = validLogs.find(l => /lunch|afternoon/i.test(l.messageIn || ""));
        if (lunchLog) toRepeat = lunchLog.messageIn!;
        else toRepeat = validLogs[0].messageIn!; // fall back to most recent
      } else if (refDinner) {
        const dinnerLog = validLogs.find(l => /dinner|supper|evening/i.test(l.messageIn || ""));
        if (dinnerLog) toRepeat = dinnerLog.messageIn!;
      } else if (refBreakfast) {
        const breakfastLog = validLogs.find(l => /breakfast|morning/i.test(l.messageIn || ""));
        if (breakfastLog) toRepeat = breakfastLog.messageIn!;
      }

      // Re-process through the food scanner — exact same logic as original log
      const repeatReply = await handleMessage(phone, toRepeat);
      return `♻️ Same meal logged: "${toRepeat.slice(0, 80)}"\n\n${repeatReply}`;
    } catch (err) {
      console.error("[REPEAT MEAL]", err);
      return `Could not find a recent meal to repeat. Tell me what you had.`;
    }
  }

  // ---- SA FOOD DATABASE MATCHING — instant calorie/protein lookup ----
  // Supports multi-meal messages: "breakfast eggs and toast, lunch chicken rice, dinner pap and pilchards"
  // Also catches direct food names: "bolognaise", "2 eggs", "oats with milk"
  // Food logging gate: MUST have actual food detected by scanner
  // hasLogTrigger alone is not enough — "I had a great day" has "had" but no food
  const foodsInMsg = scanForSAFoods(m);
  const hasActualFood = foodsInMsg.length > 0;
  const isShortFoodMsg = !isQuestion && hasLogTrigger && hasActualFood && m.split(/\s+/).length <= 30;
  const directFoodScan = !isQuestion && !isFrustration && !hasLogTrigger && hasActualFood && m.split(/\s+/).length <= 15;
  if (!isQuestion && !isFrustration && hasActualFood && (hasLogTrigger || directFoodScan)) {
    // Split message by meal keywords to handle multi-meal logging
    // Supports BOTH patterns:
    //   "breakfast eggs and toast, lunch chicken rice"  (keyword BEFORE food)
    //   "eggs and toast for breakfast, chicken rice for lunch"  (keyword AFTER food)
    const MEAL_KEYWORDS = ["breakfast", "lunch", "dinner", "supper", "snack", "brunch", "morning", "afternoon", "evening"];
    const mealSegments: { label: string; text: string }[] = [];

    // Detect pattern: check if "for breakfast" / "for lunch" style (keyword AFTER food)
    const FOR_MEAL_RE = /\bfor\s+(breakfast|lunch|dinner|supper|snack|brunch|morning|afternoon|evening)\b/gi;
    const forMealMatches = [...m.matchAll(FOR_MEAL_RE)];

    if (forMealMatches.length >= 2) {
      // "X for breakfast, Y for lunch" pattern — food comes BEFORE the keyword
      for (let i = 0; i < forMealMatches.length; i++) {
        const label = forMealMatches[i][1].charAt(0).toUpperCase() + forMealMatches[i][1].slice(1);
        const keyEnd = forMealMatches[i].index! + forMealMatches[i][0].length;
        // Text for this meal: from end of previous keyword to start of "for <meal>"
        const prevEnd = i > 0 ? (forMealMatches[i - 1].index! + forMealMatches[i - 1][0].length) : 0;
        const segText = m.slice(prevEnd, forMealMatches[i].index!).replace(/^[\s,;.]+|[\s,;.]+$/g, "").trim();
        if (segText) mealSegments.push({ label, text: segText });
      }
      // Check for trailing text after last "for <meal>" keyword (e.g. "...for lunch with coffee")
      const lastEnd = forMealMatches[forMealMatches.length - 1].index! + forMealMatches[forMealMatches.length - 1][0].length;
      const trailing = m.slice(lastEnd).replace(/^[\s,;.]+|[\s,;.]+$/g, "").trim();
      if (trailing && mealSegments.length > 0) {
        // Append trailing text to last meal segment (e.g. "with coffee" goes to lunch)
        mealSegments[mealSegments.length - 1].text += " " + trailing;
      }
    } else if (forMealMatches.length === 1) {
      // Single "for breakfast" — check if there's also a "keyword:" style for another meal
      const KEYWORD_BEFORE_RE = /\b(breakfast|lunch|dinner|supper|snack|brunch|morning|afternoon|evening)\b[:\s]+/gi;
      const beforeMatches = [...m.matchAll(KEYWORD_BEFORE_RE)].filter(
        bm => !m.slice(Math.max(0, bm.index! - 4), bm.index!).match(/\bfor\s*$/i)
      );
      if (beforeMatches.length >= 1) {
        // Mixed pattern — just treat whole message as single meal
        mealSegments.push({ label: "", text: m });
      } else {
        // Only one "for breakfast" — single meal
        const label = forMealMatches[0][1].charAt(0).toUpperCase() + forMealMatches[0][1].slice(1);
        const segText = m.slice(0, forMealMatches[0].index!).replace(/^[\s,;.]+|[\s,;.]+$/g, "").trim();
        if (segText) mealSegments.push({ label, text: segText });
        else mealSegments.push({ label, text: m });
      }
    } else {
      // Try "breakfast: eggs, lunch: chicken" pattern (keyword BEFORE food)
      const MEAL_BEFORE_RE = /\b(breakfast|lunch|dinner|supper|snack|brunch|morning|afternoon|evening)\b[:\s]+/gi;
      const beforeMatches = [...m.matchAll(MEAL_BEFORE_RE)];
      if (beforeMatches.length >= 2) {
        for (let i = 0; i < beforeMatches.length; i++) {
          const label = beforeMatches[i][1].charAt(0).toUpperCase() + beforeMatches[i][1].slice(1);
          const start = beforeMatches[i].index! + beforeMatches[i][0].length;
          const end = i + 1 < beforeMatches.length ? beforeMatches[i + 1].index! : m.length;
          const segText = m.slice(start, end).replace(/^[\s,;.]+|[\s,;.]+$/g, "").trim();
          if (segText) mealSegments.push({ label, text: segText });
        }
      }
    }

    // Fallback: if no multi-meal split worked, treat whole message as single meal
    if (mealSegments.length < 2) {
      mealSegments.length = 0;
      mealSegments.push({ label: "", text: m });
    }

    // Helper: adjust foods by quantity for a given text segment
    function adjustFoodsForSegment(foods: SAFood[], segText: string) {
      return foods.map(f => {
        const allAliases = [f.name.toLowerCase(), ...f.aliases.map(a => a.toLowerCase())];
        let quantity = 1;
        for (const alias of allAliases) {
          // Match "3 toast", "3 slices of toast", "2 cups of rice", "3 pieces of chicken"
          const qtyDirect = segText.match(new RegExp(`(\\d+)\\s+(?:${escapeRegex(alias)})`, "i"));
          const qtyWithFiller = segText.match(new RegExp(`(\\d+)\\s+(?:slices?|pieces?|cups?|bowls?|plates?|portions?|servings?|tablespoons?|teaspoons?|tbsp|tsp|glasses?)\\s+(?:of\\s+)?(?:${escapeRegex(alias)})`, "i"));
          const qtyBefore = qtyDirect || qtyWithFiller;
          if (qtyBefore) {
            const userQty = parseInt(qtyBefore[1]);
            const defaultQtyMatch = f.typicalPortionDescription.match(/^(\d+)/);
            const defaultQty = defaultQtyMatch ? parseInt(defaultQtyMatch[1]) : 1;
            if (userQty > 0 && defaultQty > 0 && userQty !== defaultQty) {
              quantity = userQty / defaultQty;
            }
            break;
          }
        }
        return {
          ...f,
          adjustedCalories: Math.round(f.typicalPortionCalories * quantity),
          adjustedProtein: Math.round(f.typicalPortionProtein * quantity),
          adjustedDescription: quantity !== 1 ? f.typicalPortionDescription.replace(/^\d+/, String(Math.round(parseInt(f.typicalPortionDescription.match(/^\d+/)?.[0] || "1") * quantity))) : f.typicalPortionDescription,
          quantity,
        };
      });
    }

    // Scan each meal segment separately
    type AdjFood = SAFood & { adjustedCalories: number; adjustedProtein: number; adjustedDescription: string; quantity: number };
    const allAdjustedFoods: AdjFood[] = [];
    const mealLines: string[] = [];
    const isMultiMeal = mealSegments.length >= 2;

    for (const seg of mealSegments) {
      const segFoods = scanForSAFoods(seg.text);
      if (segFoods.length === 0) continue;
      const adjusted = adjustFoodsForSegment(segFoods, seg.text);
      allAdjustedFoods.push(...adjusted);
      if (isMultiMeal && seg.label) {
        const segCals = adjusted.reduce((s, f) => s + f.adjustedCalories, 0);
        const segProt = adjusted.reduce((s, f) => s + f.adjustedProtein, 0);
        const lines = adjusted.map(f => `  • ${f.name}: ~${f.adjustedCalories} kcal, ${f.adjustedProtein}g protein`).join("\n");
        mealLines.push(`*${seg.label}:* ~${segCals} kcal | ${segProt}g protein\n${lines}`);
      }
    }

    if (allAdjustedFoods.length > 0) {
      const totalCals = allAdjustedFoods.reduce((s, f) => s + f.adjustedCalories, 0);
      const totalProtein = allAdjustedFoods.reduce((s, f) => s + f.adjustedProtein, 0);
      const calorieTarget = user.calorieTarget || 2000;
      const proteinTarget = user.proteinTarget || 120;
      const junkFoods = allAdjustedFoods.filter(f => f.category === "junk");
      const goodProteins = allAdjustedFoods.filter(f => f.category === "protein");

      // Build food lines — grouped by meal or flat list
      let foodLines: string;
      if (isMultiMeal && mealLines.length > 0) {
        foodLines = mealLines.join("\n\n");
      } else {
        foodLines = allAdjustedFoods.map(f =>
          `• ${f.name}: ~${f.adjustedCalories} kcal, ${f.adjustedProtein}g protein (${f.adjustedDescription})`
        ).join("\n");
      }

      // Daily accumulation — recompute from existing logs to avoid drift after corrections.
      const todayStr = sastToday();
      let runningCals = totalCals;
      let runningProtein = Math.round(totalProtein);
      try {
        const existingTotals = await recomputeTodayFoodTotals(user.id);
        runningCals = existingTotals.calories + totalCals;
        runningProtein = existingTotals.protein + Math.round(totalProtein);
        await db.update(users).set({
          todayCalories: runningCals,
          todayProteinG: runningProtein,
          todayCaloriesDate: todayStr,
        }).where(eq(users.phoneNumber, phone));
      } catch (e) { console.warn("[non-fatal] calorie update:", e); }
      const prevCals = Math.max(0, runningCals - totalCals);

      const calRemaining = calorieTarget - runningCals;
      const proteinRemaining = proteinTarget - runningProtein;
      const msgHasProtein = PROTEIN_WORDS.some(w => m.includes(w));
      let coachNote = "";
      if (goodProteins.length > 0 || msgHasProtein) {
        if (totalProtein >= 20 || msgHasProtein) {
          coachNote = `\n\nSolid protein. ${proteinRemaining > 0 ? `${Math.round(proteinRemaining)}g protein still needed today.` : "Protein target hit for today. ✅"}`;
        }
      } else if (junkFoods.length > 0) {
        coachNote = `\n\nNext meal: add protein — eggs, pilchards, or chicken.`;
      } else if (allAdjustedFoods.some(f => f.category === "carb")) {
        coachNote = `\n\nCarbs without protein — add a protein source. Eggs, pilchards, or beans work.`;
      }
      let junkNote = "";
      if (junkFoods.length > 0) {
        let note = junkFoods[0].notes || "";
        if (goodProteins.length > 0 || msgHasProtein) {
          note = note.replace(/Better to choose.*$/i, "").replace(/Add (?:eggs|pilchards|protein).*$/i, "").trim();
        }
        if (note) junkNote = `\n\n${note}`;
      }
      const runningLine = prevCals > 0
        ? `Running total today: ~${runningCals} kcal / ${calorieTarget} target${calRemaining > 0 ? ` (${calRemaining} remaining)` : " ✅ target reached"}`
        : `Remaining today: ~${Math.max(0, calRemaining)} kcal`;
      const mealLabel = isMultiMeal ? "Day total" : "Meal total";
      // Smart protein suggestion based on remaining protein target
      let proteinTip = "";
      const budgetTier = user.weeklyFoodBudget || "100_300";
      const protRemaining = (user.proteinTarget || 120) - runningProtein;
      if (protRemaining > 40 && calRemaining > 200) {
        const lowBudget = budgetTier === "under_100" || budgetTier === "under_50" || budgetTier === "50_100";
        const suggestions = lowBudget
          ? [
            `Add pilchards (22g protein, about R12) to your next meal.`,
            `2 boiled eggs = 12g protein. Quick win.`,
            `Add 1/2 tin sugar beans (7g protein) with your next meal.`,
          ]
          : [
            `Add pilchards (22g protein, R12) to your next meal.`,
            `2 boiled eggs = 12g protein. Quick win.`,
            `Tin of tuna = 25g protein. Easy add.`,
            `Low-fat yoghurt = 10g protein. Good snack option.`,
          ];
        proteinTip = `\n\n${suggestions[Math.floor(Math.random() * suggestions.length)]} ${protRemaining}g protein still needed today.`;
      } else if (protRemaining <= 0) {
        proteinTip = `\n\nProtein target hit. ✅`;
      }

      const reply = `*Food logged ✅*\n\n${foodLines}\n\n*${mealLabel}: ~${totalCals} kcal | ~${Math.round(totalProtein)}g protein*\n${runningLine}${coachNote}${junkNote}${proteinTip}`;
      await logChat(user.id, message, reply, "FOOD_LOG");
      const [saPattern, saDay] = await Promise.all([checkFoodPatterns(user.id), checkPerfectDay(user.id)]);
      // If steps were also logged from same message, combine both replies
      const stepAppend = stepReplyPart ? `\n\n${stepReplyPart}` : "";
      return `${reply}${saPattern ? "\n\n" + saPattern : ""}${saDay || ""}${stepAppend}`;
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
      const stepsTarget = user.stepsTarget || 8500;
      const weightChange = recentWeights.length >= 2
        ? (parseFloat(String(recentWeights[recentWeights.length - 1].weight)) - parseFloat(String(recentWeights[0].weight))).toFixed(1)
        : null;
      const sessionSentence = `Training: ${completedSessions} of ${plannedSessions} planned sessions done this week.`;
      const stepSentence = avgSteps > 0 ? `Steps: averaging ${avgSteps.toLocaleString()} per day against a ${stepsTarget.toLocaleString()} target.` : `Steps: no step logs this week — start logging daily.`;
      const weightSentence = weightChange !== null ? (parseFloat(weightChange) < 0 ? `Weight: down ${Math.abs(parseFloat(weightChange))}kg this week — moving in the right direction.` : parseFloat(weightChange) > 0 ? `Weight: up ${weightChange}kg — could be water, sodium, or muscle. Stay on programme.` : `Weight: holding steady this week.`) : `Weight: no weigh-ins logged — step on the scale and send me the number.`;
      const onTrack = completedSessions >= Math.ceil(plannedSessions * 0.75);
      const verdictSentence = onTrack ? `Overall you are on track — keep the consistency going into next week.` : `${user.name || "Hey"}, ${plannedSessions - completedSessions} sessions missed this week. Get the next one done today.`;
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
        winsCard = `\n\n---\n\n*Week ${weekNum} — ${clientDisplayName}*\n${winsLines}\n\n_KamLife Coach — R149/month_${refLine}\n\nShare this with someone who needs to start. 💪`;
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
    // Supplement week gate — locked before week 4
    const progWeek = user.programmeWeek || 1;
    if (progWeek < 4) {
      const weekGate = `Supplements unlock at Week 4.\n\nYou are in Week ${progWeek} — food consistency is the foundation. No supplement will out-work a solid week of eating right.\n\nFocus now: hit your ${user.proteinTarget || 120}g protein target daily from real food. When you reach Week 4, I give you the full supplement protocol — creatine, protein timing, the works.`;
      await logChat(user.id, message, weekGate, "SUPPLEMENT_GATED");
      return weekGate;
    }
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
      const week3Note = (user.programmeWeek || 1) === 3
        ? " IMPORTANT — this client is in WEEK 3, which is statistically the highest dropout point. The physical adaptation is happening but is not yet visible. Specifically acknowledge Week 3 by name. Tell them exactly what is happening physiologically this week (muscles adapting, metabolism shifting) and that the visible results come in weeks 4–6 if they do not stop now."
        : "";
      const struggleContext = `Client is struggling and said: "${message}". RULES — empathy first in one sentence, no generic motivation speech. Then state this real data point: "${dataPoint || "You showed up and sent this message — that means you have not quit."}". Then give ONE single specific action for today only. Never a list. Never "you've got this" or "believe in yourself". Be real and direct like a coach, not a cheerleader. SA voice.${week3Note}`;
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

  // ---- SMART NEXT MEAL — "what should I eat next?" based on daily gap ----
  if (/\b(what should i eat next|next meal|suggest.?a?\s*meal|what.?s? next|what to eat now|what can i eat|what must i eat|hungry|starving|i.?m hungry|what now)\b/i.test(m) && !/\b(breakfast|lunch|dinner|supper|braai|social)\b/i.test(m)) {
    const todayStr = sastToday();
    const todayCals = user.todayCaloriesDate === todayStr ? (user.todayCalories || 0) : 0;
    const todayProt = user.todayCaloriesDate === todayStr ? (user.todayProteinG || 0) : 0;
    const calTarget = user.calorieTarget || 1800;
    const protTarget = user.proteinTarget || 120;
    const calLeft = Math.max(0, calTarget - todayCals);
    const protLeft = Math.max(0, protTarget - todayProt);
    const budget = user.weeklyFoodBudget || "100_300";
    const name = user.name?.split(" ")[0] || "";
    const goal = user.goalType || "fat_loss";

    // Determine what's needed
    const needsProtein = protLeft > 20;
    const lowCalBudget = calLeft < 400;
    const highCalBudget = calLeft > 800;

    let suggestion = `*🍽️ Next Meal Suggestion${name ? ` — ${name}` : ""}*\n\n`;

    if (todayCals === 0) {
      suggestion += `No food logged yet today.\n\n`;
      if (budget === "under_100") {
        suggestion += goal === "muscle_gain"
          ? `Start with: *3 eggs + pap + spinach* (~420 kcal, 24g protein)\nCheap, filling, high protein to start the day.`
          : `Start with: *2 eggs + oats with water* (~350 kcal, 18g protein)\nLow calorie, high protein start.`;
      } else {
        suggestion += goal === "muscle_gain"
          ? `Start with: *3 eggs + 2 toast + banana* (~550 kcal, 25g protein)\nCarbs + protein for energy and muscle.`
          : `Start with: *2 eggs + oats + coffee* (~380 kcal, 20g protein)\nBalanced, keeps you full until lunch.`;
      }
    } else if (lowCalBudget && needsProtein) {
      suggestion += `You have ${calLeft} kcal and ${protLeft}g protein left.\n\n`;
      suggestion += `*Best option:* ${budget === "under_100" ? "Tin of pilchards with lemon (~180 kcal, 22g protein)" : "Grilled chicken breast + salad (~250 kcal, 30g protein)"}\nHigh protein, low calories — exactly what you need to finish the day.`;
    } else if (lowCalBudget && !needsProtein) {
      suggestion += `You have ${calLeft} kcal left and protein is sorted.\n\n`;
      suggestion += `*Best option:* Vegetable stir-fry or salad (~150 kcal)\nOr just call it — you're close to target. ${goal === "fat_loss" ? "Slight deficit is fine for fat loss." : ""}`;
    } else if (needsProtein) {
      suggestion += `You need *${protLeft}g more protein* today. That is the priority.\n\n`;
      const meals: string[] = [];
      if (budget === "under_100") {
        meals.push("2 eggs + sugar beans (~300 kcal, 22g protein)");
        meals.push("Tin of pilchards + pap (~350 kcal, 24g protein)");
      } else {
        meals.push("Chicken breast + rice + spinach (~450 kcal, 35g protein)");
        meals.push("3 eggs + brown bread + tomato (~400 kcal, 24g protein)");
        meals.push("Tin of pilchards + sweet potato (~380 kcal, 24g protein)");
      }
      suggestion += `Pick one:\n${meals.map((m, i) => `${i + 1}. ${m}`).join("\n")}`;
    } else {
      suggestion += `${calLeft} kcal and ${protLeft}g protein to go.\n\n`;
      if (budget === "under_100") {
        suggestion += `*Balanced option:* Pap + beans + cabbage (~400 kcal, 14g protein)\n*Protein push:* 2 eggs + pilchards + pap (~500 kcal, 28g protein)`;
      } else {
        suggestion += `*Balanced option:* Chicken + sweet potato + vegetables (~500 kcal, 30g protein)\n*Light option:* Greek yoghurt + banana + oats (~350 kcal, 18g protein)`;
      }
    }

    await logChat(user.id, message, suggestion, "MEAL_SUGGESTION");
    return suggestion;
  }

  // ---- HABIT CALENDAR — visual 4-week consistency grid ----
  if (m === "calendar" || m === "habit calendar" || m === "my calendar" || m === "consistency" || m === "habit tracker" || /\b(habit\s*calendar|consistency\s*check|my\s*consistency)\b/i.test(m)) {
    try {
      const twentyEightDaysAgo = new Date(Date.now() - 28 * 86_400_000);
      const [workoutDates, stepDates, foodDates] = await Promise.all([
        db.select({ date: workoutLogs.loggedAt }).from(workoutLogs)
          .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, twentyEightDaysAgo))),
        db.select({ date: stepLogs.loggedAt, steps: stepLogs.steps }).from(stepLogs)
          .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, twentyEightDaysAgo))),
        db.select({ date: chatHistory.createdAt }).from(chatHistory)
          .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, twentyEightDaysAgo))),
      ]);

      const stepsTarget = user.stepsTarget || 8500;

      // Build day-by-day map for last 28 days
      const workoutSet = new Set(workoutDates.map(w => new Date(w.date!).toISOString().slice(0, 10)));
      const stepMap: Record<string, number> = {};
      for (const s of stepDates) { const d = new Date(s.date!).toISOString().slice(0, 10); stepMap[d] = Math.max(stepMap[d] || 0, s.steps); }
      const foodSet = new Set(foodDates.map(f => new Date(f.date!).toISOString().slice(0, 10)));

      const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      let cal = `*📅 4-Week Habit Calendar*\n\n`;
      cal += `Legend: 💪=workout ✅=steps hit 🍽️=food logged ·=nothing\n\n`;

      let perfectDays = 0;
      let activeDays = 0;

      for (let week = 3; week >= 0; week--) {
        const weekStart = new Date(Date.now() - (week * 7 + 6) * 86_400_000);
        let weekLine = `*W${4 - week}:* `;
        for (let d = 0; d < 7; d++) {
          const day = new Date(weekStart.getTime() + d * 86_400_000);
          const dateStr = day.toISOString().slice(0, 10);
          const hasWorkout = workoutSet.has(dateStr);
          const stepsHit = (stepMap[dateStr] || 0) >= stepsTarget;
          const hasFood = foodSet.has(dateStr);

          if (hasWorkout && stepsHit && hasFood) { weekLine += "⭐"; perfectDays++; activeDays++; }
          else if (hasWorkout && stepsHit) { weekLine += "💪"; activeDays++; }
          else if (hasWorkout) { weekLine += "💪"; activeDays++; }
          else if (stepsHit) { weekLine += "✅"; activeDays++; }
          else if (hasFood) { weekLine += "🍽️"; activeDays++; }
          else weekLine += "·";
        }
        cal += weekLine + "\n";
      }
      cal += `     ${dayNames.join("")}\n\n`;
      cal += `⭐ Perfect days: ${perfectDays}/28\n`;
      cal += `Active days: ${activeDays}/28 (${Math.round(activeDays / 28 * 100)}%)\n\n`;
      cal += activeDays >= 24 ? `Elite consistency. This is how results happen.` :
             activeDays >= 18 ? `Good consistency. Fill the gaps and watch what happens.` :
             activeDays >= 10 ? `Building the habit. More dots = more results.` :
             `Too many empty days. One workout and one step log today — start filling the calendar.`;

      await logChat(user.id, message, cal, "HABIT_CALENDAR");
      return cal;
    } catch (err) {
      console.error("[HABIT CALENDAR]", err);
      return `Calendar not available right now. Try again.`;
    }
  }

  // ---- MONTHLY TRANSFORMATION REPORT ----
  if (m === "monthly report" || m === "my month" || m === "transformation" || m === "month report" || m === "monthly" || /\b(month.?s?\s*report|month.?s?\s*summary|this month|my transformation|30.?day\s*report)\b/i.test(m)) {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
      const [weights, steps, workouts, foodLogs, sleepLogs] = await Promise.all([
        db.select({ weight: weightLogs.weight, date: weightLogs.loggedAt }).from(weightLogs)
          .where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, thirtyDaysAgo))).orderBy(asc(weightLogs.loggedAt)),
        db.select({ steps: stepLogs.steps }).from(stepLogs)
          .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, thirtyDaysAgo))),
        db.select({ id: workoutLogs.id }).from(workoutLogs)
          .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, thirtyDaysAgo))),
        db.select({ id: chatHistory.id }).from(chatHistory)
          .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, thirtyDaysAgo))),
        db.select({ intent: chatHistory.intent, messageIn: chatHistory.messageIn }).from(chatHistory)
          .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "SLEEP_LOG"), gte(chatHistory.createdAt, thirtyDaysAgo))),
      ]);

      const name = user.name?.split(" ")[0] || "you";
      const daysOn = user.programmeStartDate ? Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86_400_000) : 0;

      // Weight change
      let weightLine = "No weight logs this month — step on the scale.";
      if (weights.length >= 2) {
        const first = parseFloat(String(weights[0].weight));
        const last = parseFloat(String(weights[weights.length - 1].weight));
        const diff = last - first;
        if (diff < -0.5) weightLine = `⚖️ Weight: *${Math.abs(diff).toFixed(1)}kg DOWN* (${first.toFixed(1)} → ${last.toFixed(1)}kg)`;
        else if (diff > 0.5) weightLine = `⚖️ Weight: ${diff.toFixed(1)}kg up (${first.toFixed(1)} → ${last.toFixed(1)}kg)`;
        else weightLine = `⚖️ Weight: Holding steady at ${last.toFixed(1)}kg`;
      } else if (weights.length === 1) {
        weightLine = `⚖️ Weight: ${parseFloat(String(weights[0].weight)).toFixed(1)}kg — log more to track trend`;
      }

      // Steps
      const totalStepsMonth = steps.reduce((s, l) => s + l.steps, 0);
      const avgSteps = steps.length > 0 ? Math.round(totalStepsMonth / steps.length) : 0;
      const stepsTarget = user.stepsTarget || 8500;
      const stepsHitDays = steps.filter(l => l.steps >= stepsTarget).length;

      // Workouts
      const workoutCount = workouts.length;
      const planned = (user.trainingDaysPerWeek || 3) * 4; // 4 weeks
      const workoutRate = planned > 0 ? Math.round(workoutCount / planned * 100) : 0;

      // Food logging
      const foodDays = foodLogs.length;

      // Sleep
      const sleepCount = sleepLogs.length;

      // Grade
      let grade = "D";
      const score = (workoutRate >= 75 ? 2 : workoutRate >= 50 ? 1 : 0) +
        (avgSteps >= stepsTarget ? 2 : avgSteps >= stepsTarget * 0.7 ? 1 : 0) +
        (foodDays >= 20 ? 1 : 0) +
        (weights.length >= 3 ? 1 : 0);
      if (score >= 5) grade = "A";
      else if (score >= 4) grade = "B";
      else if (score >= 3) grade = "C";

      const report = `*📊 Monthly Transformation Report — ${name}*\n` +
        `_${daysOn} days on programme_\n\n` +
        `${weightLine}\n` +
        `💪 Workouts: *${workoutCount}/${planned}* planned (${workoutRate}%)\n` +
        `👟 Steps: ${avgSteps.toLocaleString()} avg/day | ${stepsHitDays} days hit target\n` +
        `🍽️ Food logged: ${foodDays} meals this month\n` +
        `😴 Sleep logged: ${sleepCount} times\n` +
        `🔥 Current streak: ${user.workoutStreak || 0} sessions\n\n` +
        `*Month Grade: ${grade}*\n\n` +
        (grade === "A" ? `Elite consistency${name ? `, ${name}` : ""}. This is how bodies change. Keep it going.` :
         grade === "B" ? `Strong month. Tighten up the gaps and A is yours next month.` :
         grade === "C" ? `Room to improve. Focus on showing up — 3 workouts and 8,500 steps every single day.` :
         `Inconsistent month. The programme works when you work it. New month, fresh start. One workout today.`);

      await logChat(user.id, message, report, "MONTHLY_REPORT");
      return report;
    } catch (err) {
      console.error("[MONTHLY REPORT]", err);
      return `Could not generate report right now. Try again later.`;
    }
  }

  // ---- QUICK STAT LOOKUPS — never touch GPT ----
  // (calorie and steps handlers already fire at top of function — these are safety fallbacks for exact matches)
  if (["calories", "calorie", "my calories", "calorie target", "my calorie target"].includes(m)) {
    const cal = user.calorieTarget || 1800;
    const prot = user.proteinTarget || 120;
    const name2 = user.name ? `${user.name} — ` : "";
    return `${name2}${cal} calories and ${prot}g protein daily. Hit protein first — everything else follows.`;
  }
  if (["steps", "my steps", "step target", "steps target", "daily steps"].includes(m)) {
    const stepsT = user.stepsTarget || 8500;
    const name2 = user.name ? `${user.name} — ` : "";
    return `${name2}${stepsT.toLocaleString()} steps is your target. Log your steps tonight — "8500 steps" or "I walked 6km".`;
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
  if (["meal plan", "food plan", "diet plan", "diet", "my diet", "nutrition plan", "eating plan", "weekly meals", "my nutrition plan", "my eating plan", "my meal plan"].includes(m)) {
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
    const referralReply = `*Your KamLife Coach Referral Code* 🎯\n\nYour code: *${code}*\n\nShare this with a friend:\n\n_"I'm working with a WhatsApp fitness coach — real SA food, full workout programmes, daily accountability. From R149/month, no app needed. Use code ${code} when you sign up and we BOTH get one month free."_\n\nWhen your friend pays their first month, Coach K sends you a free month automatically. No limit on referrals — every friend earns you a free month.`;
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
      const poCtx = await getProgressiveOverloadContext(user.id);
      return `${poCtx}*Day ${requestedDay} Workout*\n\n${workout}\n\nSend *done* when finished. Log lifts: "bench 80kg 3x10"`;
    }
    const workout = buildDayWorkout(user);
    const dayNum = user.programmeDayInWeek || 1;
    const week = user.programmeWeek || 1;
    const totalSessions = user.totalWorkoutsCompleted || 0;
    const poCtx = await getProgressiveOverloadContext(user.id);
    const sessionNote = totalSessions > 0 ? ` | Session ${totalSessions + 1}` : "";
    return `*Week ${week}${sessionNote}*\n\n${poCtx}*Day ${dayNum} — Today's Workout*\n\n${workout}\n\nSend *done* when finished. Log lifts: "bench 80kg 3x10"`;
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
    // buildDayWorkoutForType only accepts legacy push/pull/legs/core — full body types go via buildDayWorkout
    const legacyTypes = ["push", "pull", "legs", "core"] as const;
    const nextWorkout = legacyTypes.includes(tomorrowType as any)
      ? buildDayWorkoutForType(nextDayUser, tomorrowType as "push" | "pull" | "legs" | "core")
      : buildDayWorkout(nextDayUser);
    const tomorrowLabel = dayLabels[tomorrowType] || "Day Session";
    return `*Tomorrow — ${tomorrowName}: ${tomorrowLabel}*\n\nComplete today's session first, then this is waiting for you.\n\n${nextWorkout}`;
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

  // ---- NPS / CLIENT FEEDBACK — "rate", "feedback", "survey" ----
  if (m === "rate" || m === "feedback" || m === "survey" || m === "rate coach k" || m === "nps" || /\b(rate\s*coach|give\s*feedback|how.?s?\s*the\s*service|satisfaction)\b/i.test(m)) {
    // Check if they are sending a rating (1-10)
    const ratingMatch = m.match(/\b([1-9]|10)\s*(?:out of 10|\/10|stars?)?\b/);
    if (ratingMatch && /\b(rate|rating|score|feedback|survey|nps)\b/i.test(m)) {
      const score = parseInt(ratingMatch[1]);
      const category = score >= 9 ? "promoter" : score >= 7 ? "passive" : "detractor";
      await logChat(user.id, message, `NPS: ${score}/10 (${category})`, "NPS_RATING");

      let followUp = "";
      if (score >= 9) {
        followUp = `${score}/10 — thank you! That means a lot. If you know someone who needs this, share your referral code: type *refer* to get it. Your recommendation is the best way to grow this.`;
      } else if (score >= 7) {
        followUp = `${score}/10 — solid. What is the ONE thing that would make this a 10? Tell me straight — I want to improve.`;
      } else {
        followUp = `${score}/10 — I hear you. What is not working? Be specific — I read every response and I will fix it. Your honesty helps me build something better.`;
      }
      return followUp;
    }

    // Check if they're giving written feedback after a rating
    const recentNPS = await db.select({ id: chatHistory.id }).from(chatHistory)
      .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "NPS_RATING")))
      .orderBy(desc(chatHistory.createdAt)).limit(1);

    if (recentNPS.length > 0 && m.length > 10 && !/\b(rate|feedback|survey)\b/i.test(m)) {
      await logChat(user.id, message, "Feedback noted", "NPS_FEEDBACK");
      return `Noted — thank you for the honest feedback. I will use this to improve. Keep pushing, and keep telling me what works and what does not.`;
    }

    // Prompt for rating
    const name = user.name?.split(" ")[0] || "there";
    const daysOn = user.programmeStartDate ? Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86_400_000) : 0;
    return `*${name}, quick question:*\n\nOn a scale of 1-10, how likely are you to recommend Coach K to a friend?\n\n1 = Not at all\n10 = Absolutely\n\n_You have been on the programme for ${daysOn} days. Your honest answer helps me improve for everyone._\n\nJust reply with your number (e.g. "rate 8").`;
  }

  // ---- WATER REPORT — "my water" trend report ----
  if (m === "my water" || m === "water report" || m === "water stats" || m === "water history" || /\b(water\s*report|water\s*history|water\s*trend|how.?s?\s*my\s*water|water\s*stats)\b/i.test(m)) {
    try {
      const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);
      const waterLogs = await db.select({ messageIn: chatHistory.messageIn, date: chatHistory.createdAt }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "WATER_LOG"), gte(chatHistory.createdAt, fourteenDaysAgo)))
        .orderBy(desc(chatHistory.createdAt));

      if (waterLogs.length === 0) {
        return `No water logs in the last 14 days. Start logging: "drank 500ml water" or "had 2 glasses water". Hydration is recovery.`;
      }

      // Group by date and sum litres
      const dailyTotals: Record<string, number> = {};
      for (const log of waterLogs) {
        if (!log.date) continue;
        const dateKey = new Date(log.date).toISOString().slice(0, 10);
        const litreMatch = (log.messageIn || "").match(/(\d+(?:\.\d+)?)\s*(?:l|litre|liter|ml|glass|cup|bottle)/i);
        if (litreMatch) {
          const val = parseFloat(litreMatch[1]);
          const unit = (log.messageIn || "").match(/(ml|glass|cup|bottle)/i)?.[1]?.toLowerCase() || "l";
          let litres = val;
          if (unit === "ml") litres = val / 1000;
          else if (unit === "glass" || unit === "cup") litres = val * 0.25;
          else if (unit === "bottle") litres = val * 0.5;
          dailyTotals[dateKey] = (dailyTotals[dateKey] || 0) + litres;
        }
      }

      const days = Object.entries(dailyTotals).sort((a, b) => b[0].localeCompare(a[0]));
      const wKg = parseFloat(user.currentWeight as string || "0") || 75;
      const waterTarget = Math.max(2.0, Math.round(wKg * 0.033 * 10) / 10);
      const avgDaily = days.length > 0 ? days.reduce((s, [, v]) => s + v, 0) / days.length : 0;
      const targetHitDays = days.filter(([, v]) => v >= waterTarget).length;
      const name = user.name?.split(" ")[0] || "there";

      let grade = "🔴";
      if (avgDaily >= waterTarget * 0.9) grade = "🟢";
      else if (avgDaily >= waterTarget * 0.6) grade = "🟡";

      const historyLines = days.slice(0, 7).map(([date, litres]) => {
        const d = new Date(date).toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" });
        const emoji = litres >= waterTarget ? "✅" : litres >= waterTarget * 0.5 ? "⚠️" : "🔴";
        return `${d}: ${litres.toFixed(1)}L ${emoji}`;
      }).join("\n");

      const report = `*💧 Water Report — ${name}*\n\n` +
        `Target: *${waterTarget}L/day* (based on ${wKg}kg)\n` +
        `Average: *${avgDaily.toFixed(1)}L/day* ${grade}\n` +
        `Target hit: ${targetHitDays}/${days.length} days\n` +
        `Streak: ${user.waterStreak || 0} days\n\n` +
        `_Last 7 days:_\n${historyLines}\n\n` +
        (avgDaily < waterTarget * 0.6 ? `You are significantly under-hydrated. Dehydration slows fat loss, kills energy, and makes training harder. Set a phone alarm every 2 hours to drink.` :
         avgDaily < waterTarget * 0.9 ? `Close but not consistent. Carry a bottle everywhere. If you can see it, you will drink it.` :
         `Solid hydration. This supports every other goal — fat loss, recovery, energy. Keep it up.`);

      await logChat(user.id, message, report, "WATER_REPORT");
      return report;
    } catch (err) {
      console.error("[WATER REPORT]", err);
      return `Could not generate water report. Try again later.`;
    }
  }

  // ---- ACHIEVEMENTS / BADGES — "badges", "achievements", "my badges" ----
  if (m === "badges" || m === "achievements" || m === "my badges" || m === "my achievements" || m === "trophies" || /\b(badge|achievement|trophy|unlock|reward)\b/i.test(m)) {
    const totalWorkouts = user.totalWorkoutsCompleted || 0;
    const streak = user.workoutStreak || 0;
    const waterStreak = user.waterStreak || 0;
    const daysOn = user.programmeStartDate ? Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86_400_000) : 0;
    const name = user.name?.split(" ")[0] || "Champ";

    // Calculate badges earned
    const badges: string[] = [];
    const locked: string[] = [];

    // Workout badges
    if (totalWorkouts >= 1) badges.push("🏋️ *First Session* — Completed your first workout");
    else locked.push("🔒 First Session — Complete 1 workout");

    if (totalWorkouts >= 10) badges.push("💪 *Getting Serious* — 10 workouts done");
    else if (totalWorkouts >= 1) locked.push("🔒 Getting Serious — Complete 10 workouts (${10 - totalWorkouts} to go)");

    if (totalWorkouts >= 25) badges.push("🔥 *Quarter Century* — 25 workouts smashed");
    else if (totalWorkouts >= 10) locked.push(`🔒 Quarter Century — Complete 25 workouts (${25 - totalWorkouts} to go)`);

    if (totalWorkouts >= 50) badges.push("🏆 *Half Ton* — 50 workouts completed");
    else if (totalWorkouts >= 25) locked.push(`🔒 Half Ton — Complete 50 workouts (${50 - totalWorkouts} to go)`);

    if (totalWorkouts >= 100) badges.push("👑 *Centurion* — 100 workouts. Elite.");
    else if (totalWorkouts >= 50) locked.push(`🔒 Centurion — Complete 100 workouts (${100 - totalWorkouts} to go)`);

    // Streak badges
    if (streak >= 7) badges.push("📅 *Week Warrior* — 7-day workout streak");
    if (streak >= 14) badges.push("⚡ *Two Week Terror* — 14-day streak");
    if (streak >= 30) badges.push("🌟 *Monthly Machine* — 30-day streak");

    // Water badges
    if (waterStreak >= 7) badges.push("💧 *Hydration Hero* — 7-day water streak");
    if (waterStreak >= 14) badges.push("🌊 *Water Warrior* — 14-day water streak");

    // Duration badges
    if (daysOn >= 7) badges.push("📆 *One Week In* — 7 days on programme");
    if (daysOn >= 30) badges.push("📅 *One Month Strong* — 30 days committed");
    if (daysOn >= 90) badges.push("🗓️ *Quarter Year* — 90 days of discipline");

    // Weight loss badge (check weight logs)
    try {
      const weightData = await db.select({ weight: weightLogs.weight }).from(weightLogs)
        .where(eq(weightLogs.userId, user.id)).orderBy(asc(weightLogs.loggedAt));
      if (weightData.length >= 2) {
        const first = parseFloat(String(weightData[0].weight));
        const last = parseFloat(String(weightData[weightData.length - 1].weight));
        const diff = first - last;
        if (diff >= 2) badges.push(`⚖️ *Scale Victory* — Down ${diff.toFixed(1)}kg from start`);
        if (diff >= 5) badges.push(`🎯 *5kg Club* — Dropped 5+ kg`);
        if (diff >= 10) badges.push(`💎 *10kg Transformation* — Life-changing progress`);
      }
    } catch { /* non-fatal */ }

    const totalBadges = badges.length;
    const reply = `*🏆 ${name}'s Achievements — ${totalBadges} Badge${totalBadges !== 1 ? "s" : ""} Earned*\n\n` +
      (badges.length > 0 ? badges.join("\n") : "_No badges yet — complete your first workout to start earning._") +
      (locked.length > 0 ? `\n\n_Next to unlock:_\n${locked.slice(0, 3).join("\n")}` : "") +
      `\n\n_Keep showing up. Every session counts._`;

    await logChat(user.id, message, reply, "ACHIEVEMENTS");
    return reply;
  }

  // ---- BODY RECOMPOSITION TRACKER — "my body", "body check", "recomp" ----
  if (m === "my body" || m === "body check" || m === "recomp" || m === "body recomp" || m === "body composition" || /\b(body\s*check|body\s*comp|recomp|my\s*body|body\s*progress)\b/i.test(m)) {
    try {
      const [weights, measurements, workouts, clothingData] = await Promise.all([
        db.select({ weight: weightLogs.weight, date: weightLogs.loggedAt }).from(weightLogs)
          .where(eq(weightLogs.userId, user.id)).orderBy(asc(weightLogs.loggedAt)),
        db.select({ type: bodyMeasurements.measurementType, value: bodyMeasurements.value, date: bodyMeasurements.loggedAt })
          .from(bodyMeasurements).where(eq(bodyMeasurements.userId, user.id)).orderBy(desc(bodyMeasurements.loggedAt)).limit(20),
        db.select({ id: workoutLogs.id }).from(workoutLogs).where(eq(workoutLogs.userId, user.id)),
        db.select().from(clothingCheckins).where(eq(clothingCheckins.userId, user.id)).orderBy(desc(clothingCheckins.loggedAt)).limit(1),
      ]);

      const name = user.name?.split(" ")[0] || "there";
      const daysOn = user.programmeStartDate ? Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86_400_000) : 0;
      let report = `*🏋️ Body Composition Check — ${name}*\n_${daysOn} days on programme_\n\n`;

      // Weight trend
      if (weights.length >= 2) {
        const first = parseFloat(String(weights[0].weight));
        const last = parseFloat(String(weights[weights.length - 1].weight));
        const diff = last - first;
        const trend = diff < -0.5 ? `⬇️ Down ${Math.abs(diff).toFixed(1)}kg` : diff > 0.5 ? `⬆️ Up ${diff.toFixed(1)}kg` : "➡️ Stable";
        report += `*Weight:* ${last.toFixed(1)}kg (${trend} from ${first.toFixed(1)}kg start)\n`;

        // Monthly rate
        const monthsOn = Math.max(1, daysOn / 30);
        const monthlyRate = Math.abs(diff) / monthsOn;
        if (user.goalType === "fat_loss" && diff < 0) {
          report += `Rate: ${monthlyRate.toFixed(1)}kg/month ${monthlyRate >= 2 && monthlyRate <= 4 ? "✅ healthy pace" : monthlyRate > 4 ? "⚠️ fast — ensure you are eating enough" : "— could push harder"}\n`;
        }
      } else {
        report += `*Weight:* ${user.currentWeight || "not logged"}kg — log more to see trends\n`;
      }

      // Measurements
      const latestByType: Record<string, string> = {};
      for (const m2 of measurements) {
        if (!latestByType[m2.type]) latestByType[m2.type] = m2.value;
      }
      if (Object.keys(latestByType).length > 0) {
        report += `\n*Measurements:*\n`;
        for (const [type, val] of Object.entries(latestByType)) {
          report += `• ${type}: ${val}\n`;
        }
      }

      // Clothing check-in
      if (clothingData.length > 0) {
        const c = clothingData[0];
        report += `\n*Last Clothing Check-In:*\n`;
        if (c.jeansFit) report += `Jeans: ${c.jeansFit}\n`;
        if (c.energyLevel) report += `Energy: ${c.energyLevel}\n`;
        if (c.stomachFeel) report += `Stomach: ${c.stomachFeel}\n`;
      }

      // Training volume
      report += `\n*Training:* ${workouts.length} total sessions | Streak: ${user.workoutStreak || 0}\n`;

      // Verdict
      const totalWorkoutsN = workouts.length;
      if (weights.length >= 2 && totalWorkoutsN >= 5) {
        const wDiff = parseFloat(String(weights[weights.length - 1].weight)) - parseFloat(String(weights[0].weight));
        if (wDiff < -1 && totalWorkoutsN >= 10) {
          report += `\n✅ *Verdict:* Losing fat while training consistently. Body recomposition in progress. Stay the course.`;
        } else if (wDiff > 1 && user.goalType === "muscle_gain") {
          report += `\n✅ *Verdict:* Gaining weight while training. If lifts are going up — this is muscle. Keep pushing.`;
        } else if (Math.abs(wDiff) < 1 && totalWorkoutsN >= 10) {
          report += `\n📊 *Verdict:* Weight stable but training hard. This often means fat loss + muscle gain happening simultaneously. Check measurements and how clothes fit — the scale does not tell the full story.`;
        } else {
          report += `\n📊 Keep logging weight and training. More data = better insights.`;
        }
      } else {
        report += `\n📊 Need more data — keep logging weight and workouts for a full picture.`;
      }

      await logChat(user.id, message, report, "BODY_RECOMP");
      return report;
    } catch (err) {
      console.error("[BODY RECOMP]", err);
      return `Could not generate body check right now. Try again later.`;
    }
  }

  // ---- SHARE CARD — "share my progress", "share" ----
  if (m === "share" || m === "share my progress" || m === "share progress" || m === "brag" || /\b(share\s*my|share\s*progress|tell\s*everyone|brag)\b/i.test(m)) {
    const name = user.name?.split(" ")[0] || "Champion";
    const totalWorkouts = user.totalWorkoutsCompleted || 0;
    const daysOn = user.programmeStartDate ? Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86_400_000) : 0;
    const streak = user.workoutStreak || 0;

    let weightLine = "";
    try {
      const weights2 = await db.select({ weight: weightLogs.weight }).from(weightLogs)
        .where(eq(weightLogs.userId, user.id)).orderBy(asc(weightLogs.loggedAt));
      if (weights2.length >= 2) {
        const diff = parseFloat(String(weights2[0].weight)) - parseFloat(String(weights2[weights2.length - 1].weight));
        if (diff > 1) weightLine = `\n⚖️ Down ${diff.toFixed(1)}kg`;
      }
    } catch { /* non-fatal */ }

    const shareCard = `*💪 ${name}'s KamLife Coach Progress*\n\n` +
      `📅 ${daysOn} days on programme\n` +
      `✅ ${totalWorkouts} workouts completed\n` +
      `🔥 ${streak}-session streak${weightLine}\n\n` +
      `_Coached by KamLife Coach on WhatsApp — SA's AI fitness coach._\n` +
      `_R149/month. Real food. Real workouts. Real results._\n\n` +
      `Copy this and share it in your WhatsApp status or group. Show them what you are building. 💪`;

    await logChat(user.id, message, shareCard, "SHARE_CARD");
    return shareCard;
  }

  // ---- MEAL TIMING COACH — "when should I eat", "pre workout meal", "post workout" ----
  if (/\b(pre.?workout|post.?workout|before\s*(?:gym|training|workout)|after\s*(?:gym|training|workout)|when\s*(?:should|must|do)\s*i\s*eat|meal\s*timing|eating\s*before|eating\s*after)\b/i.test(m)) {
    const goal = user.goalType || "fat_loss";
    const budget = user.weeklyFoodBudget || "100_300";
    const name = user.name?.split(" ")[0] || "";
    const isPreWorkout = /\b(pre.?workout|before\s*(?:gym|training|workout)|eating\s*before)\b/i.test(m);
    const isPostWorkout = /\b(post.?workout|after\s*(?:gym|training|workout)|eating\s*after)\b/i.test(m);

    let timing = `*🕐 Meal Timing Guide${name ? ` — ${name}` : ""}*\n\n`;

    if (isPreWorkout || (!isPostWorkout)) {
      timing += `*Pre-Workout (60-90 min before):*\n`;
      if (budget === "under_100") {
        timing += goal === "muscle_gain"
          ? `• 2 slices bread + peanut butter + banana (~350 kcal, 12g protein)\n• Or: pap + 1 egg (~280 kcal, 8g protein)\n`
          : `• 1 banana + 1 slice bread (~180 kcal)\n• Or: small bowl oats with water (~200 kcal)\n`;
      } else {
        timing += goal === "muscle_gain"
          ? `• Oats + banana + scoop whey (~450 kcal, 30g protein)\n• Or: 2 toast + 2 eggs + banana (~420 kcal, 20g protein)\n`
          : `• Small banana + handful almonds (~200 kcal)\n• Or: 1 toast + 1 egg (~180 kcal)\n`;
      }
      timing += `_Empty stomach training is fine for fat loss walks, but eat before weights._\n\n`;
    }

    if (isPostWorkout || (!isPreWorkout)) {
      timing += `*Post-Workout (within 60 min after):*\n`;
      if (budget === "under_100") {
        timing += `• 2 eggs + pap + spinach (~380 kcal, 20g protein)\n• Or: tin of pilchards + bread (~350 kcal, 22g protein)\n`;
      } else {
        timing += `• Chicken breast + rice + vegetables (~500 kcal, 35g protein)\n• Or: whey shake + banana + oats (~400 kcal, 30g protein)\n`;
      }
      timing += `_Protein within 60 minutes after training is the priority. Carbs refuel your muscles._\n`;
    }

    timing += `\n*Key rule:* Do not train on completely empty if it is a weights session. Even a banana 30 minutes before helps performance.`;
    await logChat(user.id, message, timing, "MEAL_TIMING");
    return timing;
  }

  // ---- WEEKLY FOOD AUDIT — "food audit", "eating audit", "diet check" ----
  if (m === "food audit" || m === "diet check" || m === "eating audit" || m === "audit" || /\b(food\s*audit|diet\s*check|eating\s*audit|week.?s?\s*eating|how.?s?\s*my\s*diet|diet\s*review)\b/i.test(m)) {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      const foodLogs = await db.select({ messageIn: chatHistory.messageIn, date: chatHistory.createdAt }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, sevenDaysAgo)))
        .orderBy(desc(chatHistory.createdAt));

      if (foodLogs.length < 3) {
        return `Not enough food logs this week for an audit. Log at least 3 meals and I will analyse your eating patterns.\n\nJust tell me what you ate — "2 eggs and toast" — and I will track it.`;
      }

      let junkCount = 0;
      let proteinMeals = 0;
      let totalMeals = foodLogs.length;
      const foodFreq: Record<string, number> = {};

      for (const log of foodLogs) {
        const text = (log.messageIn || "").toLowerCase();
        // Junk detection
        if (JUNK_WORDS.some(j => text.includes(j))) junkCount++;
        // Protein detection
        if (PROTEIN_WORDS.some(p => text.includes(p))) proteinMeals++;
        // Food frequency
        const matched = scanForSAFoods(text);
        for (const food of matched) {
          const key = food.name;
          foodFreq[key] = (foodFreq[key] || 0) + 1;
        }
      }

      const topFoods = Object.entries(foodFreq).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const proteinRate = Math.round(proteinMeals / totalMeals * 100);
      const junkRate = Math.round(junkCount / totalMeals * 100);
      const name = user.name?.split(" ")[0] || "there";

      let audit = `*🔍 Weekly Food Audit — ${name}*\n_${totalMeals} meals logged this week_\n\n`;

      // Top foods
      if (topFoods.length > 0) {
        audit += `*Most eaten:*\n${topFoods.map(([food, count]) => `• ${food} (${count}×)`).join("\n")}\n\n`;
      }

      // Protein consistency
      audit += `*Protein in meals:* ${proteinRate}% ${proteinRate >= 80 ? "✅" : proteinRate >= 50 ? "⚠️" : "🔴"}\n`;
      if (proteinRate < 50) audit += `_Add protein to every meal — eggs, chicken, pilchards, beans._\n`;

      // Junk frequency
      audit += `*Junk food frequency:* ${junkCount}/${totalMeals} meals (${junkRate}%) ${junkRate <= 10 ? "✅" : junkRate <= 20 ? "⚠️" : "🔴"}\n`;
      if (junkRate > 20) audit += `_More than 1 in 5 meals is junk. Replace one junk meal per week with a real food option._\n`;

      // Variety check
      const uniqueFoods = Object.keys(foodFreq).length;
      audit += `*Variety:* ${uniqueFoods} different foods ${uniqueFoods >= 10 ? "✅ Good variety" : uniqueFoods >= 5 ? "⚠️ Could be more varied" : "🔴 Very limited — try new foods"}\n`;

      // Overall grade
      const auditScore = (proteinRate >= 70 ? 2 : proteinRate >= 50 ? 1 : 0) +
        (junkRate <= 10 ? 2 : junkRate <= 20 ? 1 : 0) +
        (uniqueFoods >= 8 ? 1 : 0);
      const auditGrade = auditScore >= 4 ? "A" : auditScore >= 3 ? "B" : auditScore >= 2 ? "C" : "D";

      audit += `\n*Week Grade: ${auditGrade}*\n`;
      audit += auditGrade === "A" ? `Elite eating this week. Keep it up.` :
        auditGrade === "B" ? `Good week. Small tweaks — more protein, less junk — and this is an A.` :
        auditGrade === "C" ? `Room to improve. Focus on protein at every meal and cut one junk meal.` :
        `Inconsistent week. Start tomorrow with eggs and build from there.`;

      await logChat(user.id, message, audit, "FOOD_AUDIT");
      return audit;
    } catch (err) {
      console.error("[FOOD AUDIT]", err);
      return `Could not generate food audit right now. Try again later.`;
    }
  }

  // ---- DAILY FACT — "fact", "tip", "did you know" ----
  if (m === "fact" || m === "tip" || m === "daily tip" || m === "did you know" || m === "fitness fact" || m === "coach tip") {
    const facts = [
      `Walking 8,000 steps burns roughly 350-400 calories — that is a full meal's worth of energy. Steps are the cheapest fat loss tool you have.`,
      `Muscle burns 3× more calories at rest than fat. Every kg of muscle you add raises your metabolism permanently. Lift heavy.`,
      `South Africans eat an average of 52g of protein per day. Your target is ${user.proteinTarget || 120}g. Most people need to double their protein intake to see results.`,
      `Sleep deprivation increases ghrelin (hunger hormone) by 28%. One bad night = more cravings tomorrow. Protect your sleep like you protect your training.`,
      `Eggs are the cheapest complete protein in South Africa — R4 per egg, 6g protein each. 3 eggs = 18g protein for R12. No supplement beats that value.`,
      `It takes 66 days to form a habit, not 21. You are ${user.programmeStartDate ? Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86_400_000) : 0} days in. ${(user.programmeStartDate && Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86_400_000) >= 66) ? "You have crossed the habit line." : "Keep going — the habit is forming."}`,
      `A 500 calorie daily deficit = 0.5kg fat loss per week. That is 2kg per month. Small, consistent deficit beats extreme dieting every time.`,
      `Pilchards have more omega-3 than salmon per rand spent. R12 for a tin that gives 22g protein, omega-3, calcium, and vitamin D. The real superfood is in the tin aisle at Shoprite.`,
      `Your body does not know the difference between a gym machine and a filled water bottle. Home training builds real muscle — equipment is not an excuse.`,
      `Dehydration drops exercise performance by 25%. If you feel tired during training, drink water before you blame your programme.`,
      `Pap is not the enemy. Pap + pilchards + spinach = a complete meal under R20 with 25g protein. It is how you build the plate that matters.`,
      `Cortisol from stress directly increases belly fat storage. Walking 20 minutes drops cortisol by 14%. Steps are stress management.`,
      `Creatine monohydrate is the most studied supplement in sports science — safe, effective, and R5/day from Dis-Chem. 5g daily, every day.`,
      `Boerewors has 25g protein per 100g but also 26g fat. Grill, do not fry. Drain the fat. Pair with salad, not rolls. Same food, better result.`,
      `Your metabolism does not "break" from dieting. It adapts. When weight stalls, a small 100-calorie adjustment is all you need — not a crash diet.`,
    ];
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86_400_000);
    const todayFact = facts[dayOfYear % facts.length];
    const reply = `*💡 Coach K Fact of the Day*\n\n${todayFact}`;
    await logChat(user.id, message, reply, "DAILY_FACT");
    return reply;
  }

  // ---- WORKOUT HISTORY — "my workouts", "workout history", "workout diary" ----
  if (m === "my workouts" || m === "workout history" || m === "workout diary" || m === "recent workouts" || /\b(workout\s*history|workout\s*diary|my\s*workouts|recent\s*workout|past\s*workout|training\s*history)\b/i.test(m)) {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
      const [recentWorkouts, recentLifts] = await Promise.all([
        db.select({ date: workoutLogs.loggedAt, completed: workoutLogs.workoutCompleted })
          .from(workoutLogs)
          .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, thirtyDaysAgo)))
          .orderBy(desc(workoutLogs.loggedAt)),
        db.select({ exercise: exerciseLogs.exerciseName, weight: exerciseLogs.weightKg, reps: exerciseLogs.reps, sets: exerciseLogs.sets, date: exerciseLogs.loggedAt })
          .from(exerciseLogs)
          .where(and(eq(exerciseLogs.userId, user.id), gte(exerciseLogs.loggedAt, thirtyDaysAgo)))
          .orderBy(desc(exerciseLogs.loggedAt))
          .limit(30),
      ]);

      if (recentWorkouts.length === 0) {
        return `No workouts logged in the last 30 days. Reply *1* to see today's workout and get started.`;
      }

      const name = user.name?.split(" ")[0] || "there";
      const totalWorkouts = user.totalWorkoutsCompleted || 0;
      const streak = user.workoutStreak || 0;

      // Group workouts by week
      const weekMap: Record<string, number> = {};
      for (const w of recentWorkouts) {
        if (!w.date) continue;
        const d = new Date(w.date);
        const weekStart = new Date(d); weekStart.setDate(d.getDate() - d.getDay());
        const key = weekStart.toLocaleDateString("en-ZA", { day: "numeric", month: "short" });
        weekMap[key] = (weekMap[key] || 0) + 1;
      }

      let history = `*📋 Workout History — ${name}*\n` +
        `_${recentWorkouts.length} sessions in last 30 days | ${totalWorkouts} all-time | Streak: ${streak}_\n\n`;

      // Weekly breakdown
      history += `*By week:*\n`;
      for (const [week, count] of Object.entries(weekMap)) {
        const target = user.trainingDaysPerWeek || 3;
        const emoji = count >= target ? "✅" : count >= target - 1 ? "⚠️" : "🔴";
        history += `• Week of ${week}: ${count}/${target} sessions ${emoji}\n`;
      }

      // Recent lifts
      if (recentLifts.length > 0) {
        const uniqueExercises = [...new Set(recentLifts.map(l => l.exercise))].slice(0, 5);
        history += `\n*Recent lifts:*\n`;
        for (const ex of uniqueExercises) {
          const latest = recentLifts.find(l => l.exercise === ex);
          if (latest) {
            history += `• ${ex}: ${latest.weight}kg × ${latest.sets || 3}×${latest.reps || 10}\n`;
          }
        }
      }

      // Consistency check
      const weeksTracked = Object.keys(weekMap).length;
      const avgPerWeek = weeksTracked > 0 ? (recentWorkouts.length / weeksTracked).toFixed(1) : "0";
      history += `\n*Average:* ${avgPerWeek} sessions/week`;
      history += parseFloat(avgPerWeek) >= (user.trainingDaysPerWeek || 3) ? ` ✅ On target` : ` — target is ${user.trainingDaysPerWeek || 3}/week`;

      await logChat(user.id, message, history, "WORKOUT_HISTORY");
      return history;
    } catch (err) {
      console.error("[WORKOUT HISTORY]", err);
      return `Could not load workout history. Try again later.`;
    }
  }

  // ---- MOOD / STRESS CHECK-IN — "stressed", "mood", "how am I feeling" ----
  if (m === "mood" || m === "stress" || m === "stressed" || m === "anxious" || m === "feeling down" || m === "mental health" || /\b(stress|mood|anxious|anxiety|depressed|burnt?\s*out|overwhelm|mental\s*health|feeling\s*down|feeling\s*low|not\s*coping)\b/i.test(m)) {
    // Check if they are logging a mood score
    const moodScore = m.match(/\b(mood|stress|feeling)\b.*?(\d)\s*(?:out of|\/)\s*(?:5|10)/i) || m.match(/\b(mood|stress)\s*(\d)\b/i);
    if (moodScore) {
      const score = parseInt(moodScore[2]);
      await logChat(user.id, message, `Mood: ${score}`, "MOOD_LOG");
      const reply = score <= 3
        ? `Mood ${score} — noted. On hard days, a 15-minute walk outside does more for your brain than any motivational quote. Move your body even if training feels impossible today. Small action beats no action.`
        : score <= 6
          ? `Mood ${score} — middle ground. Your body and mind are connected. A good training session or even a walk will shift this upward. What can you do in the next 30 minutes?`
          : `Mood ${score} — strong. Channel that energy into today's session. Good headspace = good training = good results. Let's go.`;
      return reply;
    }

    // General stress/mood handler
    const name = user.name?.split(" ")[0] || "";
    const isStressed = /\b(stress|overwhelm|burnt?\s*out|not\s*coping|too\s*much)\b/i.test(m);
    const isAnxious = /\b(anxious|anxiety|panic|worry|worried)\b/i.test(m);
    const isLow = /\b(depress|down|low|sad|feeling\s*down|feeling\s*low)\b/i.test(m);

    let moodReply = "";
    if (isLow) {
      moodReply = `${name ? name + ", " : ""}I hear you. Low days happen — they do not define you or your progress.\n\nThree things that help:\n1. *Walk outside* for 15 minutes — sunlight and movement shift brain chemistry\n2. *Eat protein* — low blood sugar worsens mood\n3. *Text someone you trust* — not about fitness, just connect\n\nIf this is ongoing and affecting your daily life, please reach out to SADAG (SA Depression & Anxiety Group): 0800 567 567 (free). No shame, real support.\n\nYour training and food log are still here. We continue when you are ready.`;
    } else if (isAnxious) {
      moodReply = `${name ? name + ", " : ""}Anxiety spikes cortisol — which blocks fat loss and kills recovery. The best counter:\n\n1. *Box breathing* — breathe in 4 counts, hold 4, out 4, hold 4. Repeat 5 times.\n2. *Walk* — 15 minutes outside, no phone\n3. *Train* — a workout burns anxiety fuel\n\nIf anxiety is persistent, SADAG helpline: 0800 567 567 (free, confidential).\n\nLog your mood: reply "mood 4/10" and I will track it over time.`;
    } else {
      moodReply = `${name ? name + ", " : ""}Stress is the silent killer of fitness progress. High cortisol = belly fat storage, poor sleep, muscle breakdown.\n\n*Immediate fixes:*\n1. Walk 20 minutes — drops cortisol 14%\n2. Eat before your next stressor — low blood sugar amplifies stress\n3. Sleep 7+ hours tonight — non-negotiable\n\nStress management IS part of your programme. Do not ignore it.\n\nLog your mood anytime: "mood 5/10" — I will track patterns.`;
    }
    await logChat(user.id, message, moodReply, "MOOD_CHECKIN");
    return moodReply;
  }

  // ---- FASTING TRACKER — "fasting", "intermittent fasting", "IF" ----
  if (m === "fasting" || m === "intermittent fasting" || m === "if" || m === "fasting window" || /\b(fast(?:ing)?|intermittent\s*fast|eating\s*window|16.?8|18.?6|omad|one\s*meal)\b/i.test(m)) {
    // Check if logging fast start/end
    const startFast = /\b(start(?:ed|ing)?\s*(?:my\s*)?fast|fasting\s*now|began?\s*fast|going\s*to\s*fast)\b/i.test(m);
    const endFast = /\b(broke?\s*(?:my\s*)?fast|end(?:ed|ing)?\s*fast|breaking\s*fast|stopped?\s*fast|ate\s*first\s*meal)\b/i.test(m);

    if (startFast) {
      const now = new Date();
      const timeStr = now.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" });
      await logChat(user.id, message, `Fast started at ${timeStr}`, "FAST_START");
      return `Fast started at ${timeStr} ⏱️\n\nI will track it. Tell me when you break your fast — "broke my fast" — and I will log the window.\n\nDuring your fast:\n• Water, black coffee, and plain tea are fine\n• No calories — no milk, no sugar\n• If you feel dizzy or weak, break the fast immediately. Safety first.`;
    }

    if (endFast) {
      // Find the most recent fast start
      const recentStart = await db.select({ date: chatHistory.createdAt }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FAST_START")))
        .orderBy(desc(chatHistory.createdAt)).limit(1);

      let fastDuration = "";
      if (recentStart.length > 0 && recentStart[0].date) {
        const startTime = new Date(recentStart[0].date).getTime();
        const hours = Math.round((Date.now() - startTime) / 3_600_000 * 10) / 10;
        fastDuration = ` — *${hours} hours*`;
        if (hours >= 16) fastDuration += ` ✅ 16:8 achieved`;
        else if (hours >= 14) fastDuration += ` (close to 16:8 target)`;
      }

      await logChat(user.id, message, `Fast ended${fastDuration}`, "FAST_END");
      return `Fast complete${fastDuration} 🍽️\n\nBreak your fast with protein first — eggs, chicken, or pilchards. Protein after fasting maximises muscle retention.\n\nAvoid breaking with sugar or processed carbs — blood sugar will spike and crash hard after a fast.\n\nLog your first meal now: tell me what you ate.`;
    }

    // General fasting guide
    const goal = user.goalType || "fat_loss";
    const name = user.name?.split(" ")[0] || "";
    let guide = `*⏱️ Intermittent Fasting Guide${name ? ` — ${name}` : ""}*\n\n`;
    guide += `*16:8 Protocol (recommended):*\n• Eat within an 8-hour window (e.g. 12pm–8pm)\n• Fast for 16 hours (including sleep)\n• During fast: water, black coffee, plain rooibos\n\n`;

    if (goal === "fat_loss") {
      guide += `*For fat loss:*\n• Fasting naturally reduces calories without counting\n• Train fasted for walks/cardio — eat before weights\n• Break fast with high protein meal\n\n`;
    } else {
      guide += `*For muscle gain:*\n• Fasting is NOT ideal for muscle gain — you need frequent protein\n• If you do fast, eat more in your window\n• Break fast with 40g+ protein\n\n`;
    }

    guide += `*Track it:*\n• Say "starting fast" → I log the start time\n• Say "broke my fast" → I calculate the window\n\n`;
    guide += `_Fasting is a tool, not a rule. If you are hungry, eat. If you feel dizzy, eat. Never fast to the point of feeling unwell._`;

    await logChat(user.id, message, guide, "FASTING_GUIDE");
    return guide;
  }

  // ---- EXERCISE SUBSTITUTION ENGINE — "can't do X", "alternative to X" ----
  if (/\b(can.?t\s+do|cannot\s+do|alternative\s+(?:to|for)|replace\s+(?:squat|bench|deadlift|pull.?up|push.?up|lunge|press|curl|row)|instead\s+of\s+(?:squat|bench|deadlift|pull.?up|push.?up|lunge|press|curl|row))\b/i.test(m)) {
    const exerciseSubs: Record<string, { why: string; home: string[]; gym: string[] }> = {
      squat: { why: "knee, hip, or back issue", home: ["Wall sit (30-60 seconds)", "Glute bridge (3×15)", "Step-ups on chair (3×10 each leg)", "Sumo squat (wider stance, less knee pressure)"], gym: ["Leg press (less spine load)", "Goblet squat (lighter, controlled)", "Smith machine squat (guided path)", "Hack squat"] },
      deadlift: { why: "lower back concern", home: ["Hip hinge with water bottles (3×12)", "Single-leg Romanian deadlift (3×10)", "Glute bridge (3×15)", "Bird dog (3×10 each)"], gym: ["Trap bar deadlift (neutral spine)", "Romanian deadlift (lighter, controlled)", "Cable pull-through", "Hip thrust (barbell or machine)"] },
      bench: { why: "shoulder or chest strain", home: ["Push-ups (knees if needed, 3×12)", "Floor press with water bottles (3×12)", "Wall push-ups (3×15)", "Resistance band chest press"], gym: ["Dumbbell bench (better shoulder position)", "Incline dumbbell press", "Cable chest fly", "Machine chest press"] },
      "pull-up": { why: "not strong enough yet or shoulder issue", home: ["Doorframe row with towel (3×10)", "Resistance band pull-apart (3×15)", "Inverted row under table (3×8)", "Superman hold (3×20 seconds)"], gym: ["Lat pulldown (build strength first)", "Assisted pull-up machine", "Cable row", "Band-assisted pull-ups"] },
      "push-up": { why: "wrist, shoulder, or strength limitation", home: ["Wall push-ups (3×15)", "Knee push-ups (3×12)", "Incline push-ups on chair (3×10)", "Plank hold (3×30 seconds)"], gym: ["Machine chest press", "Dumbbell bench press", "Cable chest press", "Smith machine push-up"] },
      lunge: { why: "knee or balance issue", home: ["Split squat (stationary, 3×10)", "Step-ups (3×10 each)", "Wall sit (3×30 seconds)", "Glute bridge (3×15)"], gym: ["Leg press (single leg)", "Bulgarian split squat (bench support)", "Step-ups with dumbbells", "Leg extension + leg curl combo"] },
      "overhead press": { why: "shoulder impingement or pain", home: ["Lateral raise with bottles (3×12)", "Front raise (3×10)", "Wall slide (3×12)", "Resistance band press (45° angle)"], gym: ["Landmine press (shoulder-friendly angle)", "Cable lateral raise", "Machine shoulder press (guided path)", "Incline dumbbell press (30°)"] },
    };

    const exerciseNames = Object.keys(exerciseSubs);
    const matchedExercise = exerciseNames.find(ex => m.includes(ex) || m.includes(ex.replace("-", " ")) || m.includes(ex.replace("-", "")));
    const mode = user.trainingMode || "home";
    const name = user.name?.split(" ")[0] || "";

    if (matchedExercise) {
      const sub = exerciseSubs[matchedExercise];
      const alternatives = mode === "gym" ? sub.gym : sub.home;
      const reply = `*🔄 ${matchedExercise.charAt(0).toUpperCase() + matchedExercise.slice(1)} Alternatives${name ? ` — ${name}` : ""}*\n\n` +
        `Common reason: ${sub.why}\n\n` +
        `*${mode === "gym" ? "Gym" : "Home"} alternatives:*\n${alternatives.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n\n` +
        `Pick one and work it into your programme. Same muscles, different movement. Reply *done* after your session.`;
      await logChat(user.id, message, reply, "EXERCISE_SUB");
      return reply;
    }

    // Generic substitution advice
    const reply = `Tell me which exercise you cannot do and I will give you alternatives.\n\nExamples:\n• "can't do squats" (knee issue)\n• "alternative to deadlift" (back concern)\n• "can't do pull-ups" (not strong enough yet)\n• "instead of bench press" (shoulder pain)\n\nI have alternatives for every exercise — ${mode === "gym" ? "gym" : "home"} options based on your setup.`;
    return reply;
  }

  // ---- PORTION SIZE GUIDE — "portions", "how much should I eat", "serving size" ----
  if (m === "portions" || m === "portion guide" || m === "serving size" || m === "how much" || /\b(portion\s*(?:size|guide|control)|serving\s*size|how\s*much\s*(?:should|must|do)\s*i\s*eat|plate\s*size|hand\s*portion)\b/i.test(m)) {
    const goal = user.goalType || "fat_loss";
    const name = user.name?.split(" ")[0] || "";
    const portionGuide = `*✋ Portion Size Guide${name ? ` — ${name}` : ""}*\n_Use your hand — works everywhere, no scale needed_\n\n` +
      `*Protein* (palm size = ~25-30g protein):\n` +
      `👋 ${goal === "muscle_gain" ? "2 palms per meal (men), 1.5 palms (women)" : "1 palm per meal (women), 1.5 palms (men)"}\n` +
      `That is: 1 chicken breast, 150g mince, 2 eggs + pilchards, 200g fish\n\n` +
      `*Carbs* (cupped hand = ~25-30g carbs):\n` +
      `🤲 ${goal === "fat_loss" ? "1 cupped hand per meal" : "2 cupped hands per meal"}\n` +
      `That is: 1 scoop pap, 1 scoop rice, 1 slice bread, 1 small sweet potato\n\n` +
      `*Vegetables* (fist size):\n` +
      `✊ 2 fists per meal — fill half your plate\n` +
      `That is: big portion spinach, cabbage, broccoli, salad, tomatoes\n\n` +
      `*Fats* (thumb size = ~7-10g fat):\n` +
      `👍 ${goal === "fat_loss" ? "1 thumb per meal" : "2 thumbs per meal"}\n` +
      `That is: 1 tsp oil, 1 tbsp peanut butter, small handful nuts\n\n` +
      `*The Plate Rule:*\n` +
      `Half vegetables | Quarter protein | Quarter carbs\n` +
      `This works at any braai, restaurant, or family dinner. No counting needed.`;

    await logChat(user.id, message, portionGuide, "PORTION_GUIDE");
    return portionGuide;
  }

  // ---- WEIGHT TREND CHART — "weight chart", "weight graph", "weight trend" ----
  if (m === "weight chart" || m === "weight graph" || m === "weight trend" || m === "my weight" || /\b(weight\s*(?:chart|graph|trend|history|journey)|scale\s*trend|my\s*weight)\b/i.test(m)) {
    try {
      const weights = await db.select({ weight: weightLogs.weight, date: weightLogs.loggedAt })
        .from(weightLogs).where(eq(weightLogs.userId, user.id)).orderBy(asc(weightLogs.loggedAt));

      if (weights.length < 2) {
        return `Not enough weight logs for a trend. Log your weight regularly — "84.5kg" — and I will show you the full picture over time.`;
      }

      const name = user.name?.split(" ")[0] || "there";
      const vals = weights.map(w => parseFloat(String(w.weight)));
      const dates = weights.map(w => w.date ? new Date(w.date).toLocaleDateString("en-ZA", { day: "numeric", month: "short" }) : "");
      const minW = Math.floor(Math.min(...vals) - 1);
      const maxW = Math.ceil(Math.max(...vals) + 1);
      const range = maxW - minW || 1;

      // Build ASCII chart — last 12 entries
      const recent = vals.slice(-12);
      const recentDates = dates.slice(-12);
      const chartHeight = 8;
      let chart = "";

      for (let row = chartHeight; row >= 0; row--) {
        const threshold = minW + (range * row / chartHeight);
        const label = threshold.toFixed(0).padStart(3) + "│";
        let line = label;
        for (let col = 0; col < recent.length; col++) {
          if (Math.abs(recent[col] - threshold) <= range / (chartHeight * 2)) {
            line += " ● ";
          } else if (recent[col] > threshold && row < chartHeight && (minW + range * (row + 1) / chartHeight) > recent[col]) {
            line += " ● ";
          } else {
            line += "   ";
          }
        }
        chart += line + "\n";
      }
      chart += "   └" + "───".repeat(recent.length) + "\n";
      chart += "    " + recentDates.map(d => d.slice(0, 3).padEnd(3)).join("");

      const first = vals[0];
      const last = vals[vals.length - 1];
      const diff = last - first;
      const trend = diff < -0.5 ? `⬇️ Down ${Math.abs(diff).toFixed(1)}kg` : diff > 0.5 ? `⬆️ Up ${diff.toFixed(1)}kg` : `➡️ Stable`;

      const reply = `*⚖️ Weight Trend — ${name}*\n\n` +
        `\`\`\`\n${chart}\`\`\`\n\n` +
        `Start: ${first.toFixed(1)}kg → Now: ${last.toFixed(1)}kg (${trend})\n` +
        `${weights.length} weigh-ins total\n\n` +
        (diff < -2 ? `Consistent progress. The deficit is working — stay patient and stay on plan.` :
         diff > 2 && user.goalType === "muscle_gain" ? `Gaining as planned. If lifts are going up, this is muscle. Keep training hard.` :
         Math.abs(diff) < 1 ? `Weight holding. Check measurements — you could be recomping (losing fat, gaining muscle). The tape does not lie.` :
         `Keep logging. Trends become clear after 4+ weeks of consistent data.`);

      await logChat(user.id, message, reply, "WEIGHT_TREND");
      return reply;
    } catch (err) {
      console.error("[WEIGHT TREND]", err);
      return `Could not generate weight chart. Try again later.`;
    }
  }

  // ---- SA HOLIDAY MEAL GUIDE — braai, Christmas, Easter, Heritage Day ----
  if (/\b(braai\s*day|heritage\s*day|christmas\s*(?:meal|food|eat)|easter\s*(?:meal|food|eat)|new\s*year.?s?\s*(?:meal|food|eat)|holiday\s*(?:meal|food|eat)|party\s*food|social\s*eating|eating\s*out\s*(?:guide|tips|help))\b/i.test(m)) {
    const goal = user.goalType || "fat_loss";
    const name = user.name?.split(" ")[0] || "";
    const isBraai = /braai/i.test(m);
    const isChristmas = /christmas|december/i.test(m);
    const isEaster = /easter/i.test(m);

    let guide = "";
    if (isBraai) {
      guide = `*🔥 Coach K's Braai Survival Guide${name ? ` — ${name}` : ""}*\n\n` +
        `*Best picks:*\n` +
        `• Chicken thigh (skin off after cooking) — 25g protein, ~200 kcal\n` +
        `• Boerewors (1 piece, grilled well) — 25g protein, ~350 kcal\n` +
        `• Steak (palm-sized) — 30g protein, ~250 kcal\n` +
        `• Sosatie (3 sticks) — 20g protein, ~280 kcal\n\n` +
        `*Limit:*\n` +
        `• Rolls/bread — 1 max (save your carbs for the meat)\n` +
        `• Pap — 1 serving (fist-sized)\n` +
        `• Chakalaka — good, it is mostly veg\n` +
        `• Dumplings/vetkoek — skip or 1 only (250 kcal each)\n\n` +
        `*Drinks:*\n` +
        `• Water between every drink\n` +
        `• 2 beers max (each = 150 kcal of zero nutrition)\n` +
        `• Brandy & Coke Zero > Brandy & Coke (saves 140 kcal)\n\n` +
        `*Strategy:* Eat protein first. Fill up on meat and salad. Then add 1 starch. ${goal === "fat_loss" ? "You do not need to eat everything — pick your favourites and enjoy them." : "Load the plate — braai day is a surplus day. Enjoy it, hit the gym Monday."}`;
    } else if (isChristmas) {
      guide = `*🎄 Christmas Meal Guide${name ? ` — ${name}` : ""}*\n\n` +
        `*Best picks:*\n` +
        `• Roast chicken or turkey — best protein source on the table\n` +
        `• Ham (lean cuts, trim visible fat)\n` +
        `• Salads — go heavy on these\n` +
        `• Roast vegetables — sweet potato, butternut, green beans\n\n` +
        `*Limit:*\n` +
        `• Dessert — 1 small serving, enjoy it, then stop\n` +
        `• Alcohol — water between every drink\n` +
        `• Starchy sides — 1 serving rice/potato\n\n` +
        `*Strategy:* Eat slowly. It takes 20 minutes for fullness signals to reach your brain. One plate, no seconds. Enjoy the day — one meal does not break a programme.`;
    } else if (isEaster) {
      guide = `*🐣 Easter Eating Guide${name ? ` — ${name}` : ""}*\n\n` +
        `Easter eggs: 1 small egg = ~200 kcal. That is a full snack.\n\n` +
        `*Strategy:*\n` +
        `• Buy ONE egg, enjoy it slowly. Do not buy the 6-pack.\n` +
        `• Hot cross buns: 1 bun = 200 kcal. Max 1 per day.\n` +
        `• Keep training through the weekend. A 30-min walk burns off that bun.\n\n` +
        `*Meal plan stays the same.* The holiday is one day — your programme is every day.`;
    } else {
      guide = `*🎉 Social Eating Survival Guide${name ? ` — ${name}` : ""}*\n\n` +
        `*Before you go:*\n` +
        `• Eat a high-protein snack (2 eggs or biltong) so you arrive not starving\n` +
        `• Decide in advance: 1 plate, no seconds\n\n` +
        `*At the event:*\n` +
        `• Protein first — meat, chicken, fish\n` +
        `• Fill half your plate with salad/veg\n` +
        `• 1 starch portion (fist-sized)\n` +
        `• Water between every alcoholic drink\n\n` +
        `*After:*\n` +
        `• Do NOT skip meals the next day to "make up for it"\n` +
        `• Train the next morning — sweat it out and move on\n` +
        `• One meal does not break your programme. Going dark for 3 days after does.\n\n` +
        `*${goal === "fat_loss" ? "Enjoy the event. Log what you ate tomorrow. We keep going." : "Enjoy the surplus — your muscles will use it. Train hard Monday."}*`;
    }

    await logChat(user.id, message, guide, "HOLIDAY_GUIDE");
    return guide;
  }

  // ---- MENU NUMBER SHORTCUTS ----
  if (m === "3" || m === "food" || m === "food coaching" || m === "log food" || m === "food log") {
    return `Send me what you ate and I will give you the calories and protein instantly.\n\nExamples:\n• "I had pap and pilchards"\n• "2 eggs and brown bread"\n• "KFC original piece"\n• "Oats for breakfast"\n\nI have ${SA_FOODS_SEED.length} SA foods in my database. Just tell me what you ate.`;
  }
  if (m === "2" || m === "log steps" || m === "step log") {
    return `Send me your step count and I will log it.\n\nExamples:\n• "8500 steps"\n• "I walked 5km"\n• "10,000 steps done"\n\nYour daily target: ${(user.stepsTarget || 8500).toLocaleString()} steps.`;
  }
  if (m === "log sleep" || m === "sleep log") {
    return `Send me how many hours you slept.\n\nExamples:\n• "I slept 6 hours"\n• "7 hours sleep"\n• "bad sleep, maybe 5 hours"\n\nTarget: 7–9 hours for full recovery and fat loss.`;
  }
  if (m === "7" || m === "log weight" || m === "weight log") {
    return `Send me your weight and I will log it.\n\nExamples:\n• "84.5kg"\n• "I weigh 91kg"\n• "weighed in at 78kg this morning"\n\nWeigh in first thing in the morning, after toilet, before food. Same conditions every time.`;
  }
  if (m === "measurements" || m === "check in" || m === "measurement check in" || m === "measurements check in") {
    return `*Measurements Check-In*\n\nSend me your current measurements in this format:\n\nWaist: Xcm\nHips: Xcm\nChest: Xcm\nArm: Xcm\n\nMeasure first thing in morning, relaxed (not flexed). Same spot every time. The tape does not lie even when the scale does.`;
  }

  // ---- WEEKLY STEP LEADERBOARD — anonymous competition ----
  if (m === "leaderboard" || m === "leader board" || m === "rankings" || m === "step leaderboard" || m === "top steps" || m === "9" || m === "challenge") {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      // Get all users who logged steps this week, compute their daily averages
      const allStepLogs = await db.select({
        userId: stepLogs.userId,
        steps: stepLogs.steps,
      }).from(stepLogs).where(gte(stepLogs.loggedAt, sevenDaysAgo));

      // Aggregate by user
      const userSteps: Record<string, { total: number; days: number }> = {};
      for (const log of allStepLogs) {
        if (!userSteps[log.userId]) userSteps[log.userId] = { total: 0, days: 0 };
        userSteps[log.userId].total += log.steps;
        userSteps[log.userId].days++;
      }

      // Get names for all participating users
      const participantIds = Object.keys(userSteps);
      if (participantIds.length === 0) {
        return `No step logs this week yet. Be the first — send your step count now.`;
      }

      const participants = await db.select({ id: users.id, name: users.name })
        .from(users).where(sql`${users.id} = ANY(${participantIds})`);
      const nameMap: Record<string, string> = {};
      for (const p of participants) nameMap[p.id] = p.name || "Anonymous";

      // Sort by average steps descending
      const ranked = participantIds.map(uid => ({
        uid,
        name: nameMap[uid] || "Anonymous",
        avg: Math.round(userSteps[uid].total / userSteps[uid].days),
        days: userSteps[uid].days,
        total: userSteps[uid].total,
      })).sort((a, b) => b.avg - a.avg);

      // Find current user's rank
      const myRank = ranked.findIndex(r => r.uid === user.id) + 1;
      const myEntry = ranked.find(r => r.uid === user.id);

      // Build top 10 leaderboard
      const medals = ["🥇", "🥈", "🥉"];
      const top10 = ranked.slice(0, 10);
      let board = `*🏆 Weekly Step Leaderboard*\n_${top10.length} clients competing this week_\n\n`;
      for (let i = 0; i < top10.length; i++) {
        const r = top10[i];
        const medal = i < 3 ? medals[i] : `${i + 1}.`;
        const isYou = r.uid === user.id;
        const firstName = r.name.split(" ")[0];
        // Anonymise: show first name + last initial only
        const displayName = r.name.includes(" ") ? `${firstName} ${r.name.split(" ")[1][0]}.` : firstName;
        board += `${medal} ${isYou ? `*${displayName} (YOU)*` : displayName} — ${r.avg.toLocaleString()} avg/day (${r.days}d)\n`;
      }

      if (myRank > 0 && myRank <= 10) {
        board += `\nYou are *#${myRank}*. ${myRank === 1 ? "Leading the pack. Don't stop." : myRank <= 3 ? "Podium position. Push for #1." : "Keep climbing."}`;
      } else if (myRank > 10) {
        board += `\n---\n${myRank}. *${myEntry?.name.split(" ")[0] || "You"} (YOU)* — ${myEntry?.avg.toLocaleString()} avg/day\n\nYou are #${myRank} of ${ranked.length}. Log more steps to climb.`;
      } else {
        board += `\nYou haven't logged steps this week. Send your step count to join the leaderboard.`;
      }

      await logChat(user.id, message, board, "LEADERBOARD");
      return board;
    } catch (err) {
      console.error("[LEADERBOARD]", err);
      return `Leaderboard is not available right now. Log your steps and try again later.`;
    }
  }

  // ---- ACCOUNTABILITY BUDDY SYSTEM ----
  if (m === "buddy" || m === "my buddy" || m === "accountability" || m === "accountability buddy" || m === "partner") {
    if (user.buddyId) {
      // Show buddy status
      try {
        const [buddy] = await db.select({
          name: users.name,
          totalWorkoutsCompleted: users.totalWorkoutsCompleted,
          workoutStreak: users.workoutStreak,
          lastActiveAt: users.lastActiveAt,
          todayCalories: users.todayCalories,
          todayCaloriesDate: users.todayCaloriesDate,
        }).from(users).where(eq(users.id, user.buddyId)).limit(1);

        if (!buddy) {
          await db.update(users).set({ buddyId: null, buddyPairedAt: null }).where(eq(users.phoneNumber, phone));
          return `Your buddy is no longer active. Reply *find buddy* to get matched with someone new.`;
        }

        const buddyName = buddy.name?.split(" ")[0] || "Your buddy";
        const buddyActive = buddy.lastActiveAt && (Date.now() - new Date(buddy.lastActiveAt).getTime()) < 2 * 86_400_000;
        const buddyStreak = buddy.workoutStreak || 0;
        const todayStr = sastToday();
        const buddyCals = buddy.todayCaloriesDate === todayStr ? (buddy.todayCalories || 0) : 0;
        const myStreak = user.workoutStreak || 0;

        let comparison = "";
        if (myStreak > buddyStreak) comparison = `You are ahead by ${myStreak - buddyStreak} sessions. Keep the lead.`;
        else if (buddyStreak > myStreak) comparison = `${buddyName} is ${buddyStreak - myStreak} sessions ahead. Time to catch up.`;
        else comparison = `You are neck and neck. Don't let them pull ahead.`;

        const buddyStatus = `*🤝 Accountability Buddy — ${buddyName}*\n\n` +
          `${buddyName}: ${buddyActive ? "Active ✅" : "Silent ⚠️"} | Streak: ${buddyStreak} | Workouts: ${buddy.totalWorkoutsCompleted || 0}${buddyCals > 0 ? ` | Today: ${buddyCals} kcal` : ""}\n` +
          `You: Streak: ${myStreak} | Workouts: ${user.totalWorkoutsCompleted || 0}\n\n` +
          `${comparison}\n\nReply *remove buddy* to unpair.`;
        await logChat(user.id, message, buddyStatus, "BUDDY_CHECK");
        return buddyStatus;
      } catch (err) {
        return `Could not load buddy info. Try again later.`;
      }
    } else {
      return `*🤝 Accountability Buddy*\n\nGet matched with another KamLife client. You'll see each other's streaks and workouts — friendly competition.\n\nReply *find buddy* to get matched.\n\nRules:\n• First names only — privacy protected\n• You see streaks and workout counts, nothing else\n• Either person can unpair anytime`;
    }
  }

  // ---- FIND BUDDY — auto-match with another unpaired active client ----
  if (m === "find buddy" || m === "find a buddy" || m === "get buddy" || m === "match me" || m === "pair me") {
    if (user.buddyId) {
      return `You already have a buddy. Reply *buddy* to see their status, or *remove buddy* to unpair first.`;
    }
    try {
      // Find another active, unpaired client
      const candidates = await db.select({ id: users.id, name: users.name })
        .from(users)
        .where(and(
          eq(users.subscriptionStatus, "active"),
          sql`${users.buddyId} IS NULL`,
          sql`${users.id} != ${user.id}`,
          gte(users.lastActiveAt, new Date(Date.now() - 7 * 86_400_000)), // active in last 7 days
        ))
        .limit(10);

      if (candidates.length === 0) {
        return `No available buddies right now — you are the first in the queue. I will match you as soon as someone else signs up. Keep training.`;
      }

      // Pick random candidate
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      const now = new Date();

      // Create mutual pairing
      await Promise.all([
        db.update(users).set({ buddyId: pick.id, buddyPairedAt: now }).where(eq(users.id, user.id)),
        db.update(users).set({ buddyId: user.id, buddyPairedAt: now }).where(eq(users.id, pick.id)),
      ]);

      const buddyFirst = pick.name?.split(" ")[0] || "Your buddy";
      const myFirst = user.name?.split(" ")[0] || "Your buddy";

      // Notify the other person
      try {
        await sendWhatsApp(
          (await db.select({ phone: users.phoneNumber }).from(users).where(eq(users.id, pick.id)).limit(1))[0].phone,
          `*🤝 New Accountability Buddy!*\n\nYou've been matched with *${myFirst}*. You'll see each other's streaks and workouts.\n\nReply *buddy* anytime to check their progress. Let's see who can be more consistent.`
        );
      } catch {}

      await logChat(user.id, message, `Matched with ${buddyFirst}`, "BUDDY_MATCH");
      return `*🤝 Matched!*\n\nYou and *${buddyFirst}* are now accountability buddies. You'll see each other's streaks and workout counts.\n\nReply *buddy* anytime to check how they're doing. Don't let them beat you.`;
    } catch (err) {
      console.error("[BUDDY MATCH]", err);
      return `Matching failed. Try again later.`;
    }
  }

  // ---- REMOVE BUDDY ----
  if (m === "remove buddy" || m === "unpair" || m === "remove partner" || m === "no buddy") {
    if (!user.buddyId) return `You don't have a buddy. Reply *find buddy* to get matched.`;
    try {
      const buddyId = user.buddyId;
      await Promise.all([
        db.update(users).set({ buddyId: null, buddyPairedAt: null }).where(eq(users.id, user.id)),
        db.update(users).set({ buddyId: null, buddyPairedAt: null }).where(eq(users.id, buddyId)),
      ]);
      return `Buddy removed. Reply *find buddy* anytime to get matched with someone new.`;
    } catch {
      return `Could not remove buddy. Try again.`;
    }
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
      } catch (e) { console.warn("[non-fatal]", e); }

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
    try { await storeMemory(phone, `Injury resolved: "${oldInjury}" — client reported recovery`, "medical"); } catch (e) { console.warn("[non-fatal]", e); }
    const injuryReply = `Noted — ${oldInjury} marked as recovered. Full programme is back. Build up gradually this week — don't jump straight to max weight. Reply "today" for your session.`;
    await logChat(user.id, message, injuryReply, "INJURY_UPDATE");
    return injuryReply;
  }

  // ---- SLEEP LOGGING — hardcoded + weekly trend, no GPT ----
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

    // Weekly sleep trend — show 7-day average if they have enough logs
    let trendLine = "";
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      const recentSleepLogs = await db.select({ messageIn: chatHistory.messageIn }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "SLEEP_LOG"), gte(chatHistory.createdAt, sevenDaysAgo)));
      const sleepHours: number[] = [];
      for (const log of recentSleepLogs) {
        const hMatch = (log.messageIn || "").match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/i);
        if (hMatch) sleepHours.push(parseFloat(hMatch[1]));
      }
      if (hours !== null) sleepHours.push(hours); // include today
      if (sleepHours.length >= 3) {
        const avg = sleepHours.reduce((a, b) => a + b, 0) / sleepHours.length;
        const trend = avg >= 7 ? "✅ On track" : avg >= 6 ? "⚠️ Could improve" : "🔴 Needs work";
        trendLine = `\n\n_7-day avg: ${avg.toFixed(1)} hrs (${sleepHours.length} logs) — ${trend}_`;
      }
    } catch { /* non-fatal */ }

    await logChat(user.id, message, sleepReply, "SLEEP_LOG");
    return sleepReply + trendLine;
  }

  // ---- SLEEP REPORT — "my sleep" or "sleep report" ----
  if (m === "my sleep" || m === "sleep report" || m === "sleep stats" || /\b(sleep\s*report|sleep\s*history|how.?s?\s*my\s*sleep|sleep\s*trend)\b/i.test(m)) {
    try {
      const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);
      const sleepEntries = await db.select({ messageIn: chatHistory.messageIn, date: chatHistory.createdAt }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "SLEEP_LOG"), gte(chatHistory.createdAt, fourteenDaysAgo)))
        .orderBy(desc(chatHistory.createdAt));

      const entries: { date: string; hours: number }[] = [];
      for (const log of sleepEntries) {
        const hMatch = (log.messageIn || "").match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/i);
        if (hMatch && log.date) entries.push({ date: new Date(log.date).toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" }), hours: parseFloat(hMatch[1]) });
      }

      if (entries.length === 0) {
        return `No sleep logs in the last 14 days. Start logging: just say "I slept 7 hours" and I will track your recovery over time.`;
      }

      const avg = entries.reduce((s, e) => s + e.hours, 0) / entries.length;
      const best = Math.max(...entries.map(e => e.hours));
      const worst = Math.min(...entries.map(e => e.hours));
      const goodNights = entries.filter(e => e.hours >= 7).length;
      const name = user.name?.split(" ")[0] || "there";

      let grade = "🔴";
      if (avg >= 7.5) grade = "🟢";
      else if (avg >= 6.5) grade = "🟡";

      const historyLines = entries.slice(0, 7).map(e => {
        const emoji = e.hours >= 7 ? "✅" : e.hours >= 6 ? "⚠️" : "🔴";
        return `${e.date}: ${e.hours}h ${emoji}`;
      }).join("\n");

      const report = `*😴 Sleep Report — ${name}*\n\n` +
        `Average: *${avg.toFixed(1)} hours* ${grade}\n` +
        `Best night: ${best}h | Worst: ${worst}h\n` +
        `Good nights (7h+): ${goodNights}/${entries.length}\n\n` +
        `_Last 7 entries:_\n${historyLines}\n\n` +
        (avg < 6.5 ? `Your sleep is hurting your results. Fix tonight: phone off at 9pm, dark room, no caffeine after 2pm.` :
         avg < 7.5 ? `Close to the 7-hour minimum. Push bedtime 30 minutes earlier and watch your energy and fat loss improve.` :
         `Solid recovery. This sleep pattern supports fat loss and muscle repair. Keep it consistent.`);

      await logChat(user.id, message, report, "SLEEP_REPORT");
      return report;
    } catch (err) {
      console.error("[SLEEP REPORT]", err);
      return `Could not generate sleep report right now. Try again later.`;
    }
  }

  // ---- NO GYM / EQUIPMENT ALTERNATIVES — deliver home programme directly ----
  const isNoGymMsg = /no\s+.*(gym|equipment|weights|barbell|dumbbell|machine|bench)/i.test(m) ||
      /can.?t\s+(go to\s+)?gym|don.?t\s+have\s+(a\s+)?(gym|weights|equipment|dumbbell|barbell|access)/i.test(m) ||
      /no\s+gym|without\s+gym|without\s+equipment/i.test(m) ||
      /no\s+access\s+to\s+(?:a\s+)?gym|don.?t\s+have\s+access\s+to\s+(?:a\s+|the\s+)?gym/i.test(m) ||
      /won.?t\s+have\s+(?:access|a\s+gym)|can.?t\s+(?:get to|make it to|go to).*gym/i.test(m) ||
      /what\s+can\s+i\s+use\s+instead|home\s+alternative|bodyweight\s+alternative|no\s+weights/i.test(m);
  if (isNoGymMsg) {
    const eqKeys = Object.keys(EQUIPMENT_ALTERNATIVES);
    const matchedEquip = eqKeys.find(eq => m.includes(eq));
    let equipReply: string;
    if (matchedEquip) {
      equipReply = `No ${matchedEquip}? Use ${EQUIPMENT_ALTERNATIVES[matchedEquip].join(" or ")}.\n\nFull home programme is available — reply *programme* or *menu* to see it. You do not need a gym to build real strength.`;
    } else {
      // Deliver a home workout directly instead of just telling them to reply
      const homeUser = { ...user, trainingMode: "home" };
      const homeWorkout = buildDayWorkout(homeUser);
      const nameStr = user.name || "there";
      equipReply = `No gym? No problem, ${nameStr}. Here is your home workout:\n\n${homeWorkout}\n\nYour bodyweight is the gym. Reply *DONE* when finished.`;
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

  // ---- "CAN'T DO X" EXERCISE ALTERNATIVE — no GPT, instant swap ----
  const CANT_DO_MAP: Record<string, string> = {
    "pull.?up|chin.?up": "Do lat pulldown or seated cable row instead. Same pulling muscles. Start with lat pulldown at 50% bodyweight and build from there.",
    "push.?up|pushup": "Elevate your hands on a bench or wall. Reduce the angle until you can do 3×10 clean, then lower it over time.",
    "squat": "Leg press or goblet squat. If knees are the problem, reduce depth — only go as low as is pain-free. Box squat (sit down on a low bench and stand up) builds the same pattern.",
    "deadlift|dead lift": "Romanian Deadlift with lighter weight — keeps the movement pattern without the full load on the lower back. Or trap bar deadlift if available.",
    "bench|chest press": "Dumbbell press — easier on the shoulders and joints. Or push-up variations if no equipment. Same muscles.",
    "dip": "Close-grip bench press or tricep pushdown. Dips are shoulder-intensive — these alternatives are safer if shoulders are the issue.",
    "lunge": "Step-up onto a bench or box instead. Same single-leg demand, more controlled. Or Bulgarian split squat with a shorter range.",
    "plank|core|abs": "Dead bug — lie on back, extend opposite arm and leg while keeping lower back flat. Harder than it looks. Or bird dog on hands and knees.",
    "shoulder press|overhead|ohp": "Lateral raise and front raise instead — builds shoulders without the overhead load. Or seated dumbbell press with shorter range of motion.",
    "run|running|cardio": "Brisk walking — 30 minutes at a pace that makes you slightly breathless is equivalent to 15 minutes of running for fat loss. Zero joint impact.",
  };
  const cantDoMatch = m.match(/\b(can.?t|cannot|don.?t|won.?t|not able to|unable to)\b.{0,20}\b(do|try|perform|handle)\b/i)
    || m.match(/\b(can.?t|cannot|don.?t)\s+do\s+/i)
    || m.match(/\b(can.?t|cannot)\s+(do|handle|manage)\s+\w+/i);
  if (cantDoMatch || /\b(alternative|swap|instead of|substitute|replace)\b.{0,20}\b(exercise|workout|movement|squat|bench|pull|push|deadlift|lunge|run|plank|dip)\b/i.test(m)) {
    const altKey = Object.keys(CANT_DO_MAP).find(k => new RegExp(k, "i").test(m));
    if (altKey) {
      const altReply = `No problem — ${CANT_DO_MAP[altKey]}`;
      await logChat(user.id, message, altReply, "EXERCISE_ALT");
      return altReply;
    }
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
      } catch (e) { console.warn("[non-fatal]", e); }
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
    const wantsFullReset = /start over|start again|begin again|onboard again/i.test(m);

    if (currentState !== "COMPLETE" || wantsFullReset) {
      // Full data wipe — delete all FK-dependent rows then nuke + recreate user
      const uid = user.id;
      await db.delete(chatHistory).where(eq(chatHistory.userId, uid));
      await db.delete(stepLogs).where(eq(stepLogs.userId, uid));
      await db.delete(workoutLogs).where(eq(workoutLogs.userId, uid));
      await db.delete(weightLogs).where(eq(weightLogs.userId, uid));
      await db.delete(weeklyCheckins).where(eq(weeklyCheckins.userId, uid));
      await db.delete(clothingCheckins).where(eq(clothingCheckins.userId, uid));
      await db.delete(bodyMeasurements).where(eq(bodyMeasurements.userId, uid));
      await db.delete(exerciseLogs).where(eq(exerciseLogs.userId, uid));
      await db.delete(progressPhotos).where(eq(progressPhotos.userId, uid));
      await db.delete(escalations).where(eq(escalations.userId, uid));
      await db.delete(abAssignments).where(eq(abAssignments.userId, uid));
      await db.delete(users).where(eq(users.id, uid));

      await db.insert(users).values({
        phoneNumber: phone,
        subscriptionStatus: "inactive",
        onboardingState: "WELCOME",
        programmePhase: 1,
        programmeWeek: 1,
        programmeDayInWeek: 1,
        trainingMode: "home",
        stepsTarget: 8500,
        createdAt: new Date(),
        lastActiveAt: new Date(),
      });

      return "Fresh start. What is your name?";
    }
    // COMPLETE users asking "restart" — probably want workout/menu, not full reset
    return await getMenuText(user);
  }

  // ---- CANCEL SUBSCRIPTION ----
  if (m === "cancel" || m === "cancel subscription" || m === "unsubscribe" || m === "stop coaching" || m === "stop subscription") {
    const alreadyInactive = user.subscriptionStatus === "inactive";
    if (alreadyInactive) {
      const payLink2 = process.env.APP_URL ? `${process.env.APP_URL}/api/payfast/link?phone=${encodeURIComponent(phone.replace(/^whatsapp:/, "").replace(/\D/g, ""))}` : process.env.APP_URL || "https://kamlifecoach.co.za";
      const cancelledAlreadyReply = `Your subscription is already inactive. Your profile and ${user.totalWorkoutsCompleted || 0} sessions are saved.\n\nReady to restart? ${payLink2}`;
      await logChat(user.id, message, cancelledAlreadyReply, "CANCEL");
      return cancelledAlreadyReply;
    }
    const name = user.name || "there";
    await db.update(users).set({
      subscriptionStatus: "inactive",
      cancelledAt: new Date(),
      awaitingInputType: null,
    }).where(eq(users.phoneNumber, phone));
    const cancelReply = `Done${name ? `, ${name}` : ""}. Subscription cancelled — no more charges.\n\nYour profile and ${user.totalWorkoutsCompleted || 0} sessions are saved for 90 days. Come back anytime and pick up where you left off.\n\nIf you change your mind, reply *rejoin*.`;
    await logChat(user.id, message, cancelReply, "CANCEL");
    return cancelReply;
  }

  // ---- PAYMENT / REJOIN — inactive users asking to pay or rejoin ----
  if (/\b(pay|paying|payment|rejoin|re-join|reactivate|subscribe|subscription|renew|renewal)\b/i.test(m)) {
    const merchantId = process.env.PAYFAST_MERCHANT_ID;
    const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
    const clientName = user.name ? `, ${user.name}` : "";
    if (merchantId && appUrl) {
      const cleanPhone = phone.replace(/^whatsapp:/, "").replace(/\D/g, "");
      const payLink = `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}`;
      const payReply = `Sharp${clientName}. Here is your payment link: ${payLink}\n\nR149/month — cancel anytime. Your profile and progress are saved and will be waiting when you activate.`;
      await logChat(user.id, message, payReply, "PAYMENT_REQUEST");
      return payReply;
    } else {
      const payReply = `Sharp${clientName}. To subscribe or renew, go to ${appUrl} or WhatsApp the team directly. R149/month — cancel anytime.`;
      await logChat(user.id, message, payReply, "PAYMENT_REQUEST");
      return payReply;
    }
  }

  // ---- HOLIDAY / PAUSE MODE ----
  // Only pause when the client EXPLICITLY wants to stop messages.
  // "I'm on holiday, any tips?" is a QUESTION — do NOT pause.
  // Questions contain: "?", "tips", "what can I", "how", "recommend", "suggest", "advice", "help"
  const hasHolidayWord = /\b(holiday|pause|pausing|on holiday|going away|vacation|sick leave|taking a break|leave me alone|stop messaging|mute|quiet mode|don.?t message)\b/i.test(m);
  const isAskingQuestion = /\?|tips|what can|what should|how do|how can|recommend|suggest|advice|help|any ideas|give me/i.test(m);
  if (hasHolidayWord && !isAskingQuestion) {
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

  // (isNewProgrammeRequest handled earlier — before awaitingProgrammeAnswers)

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
  // IMPORTANT: do NOT match "no gym" / "don't have gym" — those are handled by the equipment alternatives handler above
  const hasNegativeGym = /\b(no|don.?t|won.?t|can.?t|not|without|never|quit|left)\b.{0,15}\bgym\b/i.test(m);
  const isProfileUpdate =
    /\b(change my goal|my goal is now|switch to|switch my goal|new goal|update my goal)\b/i.test(m) ||
    /\b(change.*budget|budget.*changed|my budget is now|budget is now|new budget)\b/i.test(m) ||
    (!hasNegativeGym && /\b(joined.*gym|got.*gym|have.*gym|going to.*gym|now.*gym|gym.*membership)\b/i.test(m)) ||
    /\b(change.*training days|training.*(\d)\s*days|now training.*(\d)|(\d)\s*days.*week.*train)\b/i.test(m) ||
    /\b(training at home|working out at home|no.*gym.*more|quit.*gym|left.*gym|home.*workout.*now)\b/i.test(m) ||
    (!hasNegativeGym && /\b(want to gym|going to gym|start gym|gym.*\d+.*day|train.*\d+.*day|workout.*\d+.*day|\d+.*day.*gym|\d+.*day.*train|\d+.*day.*week)\b/i.test(m));

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
    const stepsTarget = user.stepsTarget || 8500;
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

  // ---- FOOD DIARY SUMMARY — "what did I eat today?" / "today's calories?" — no GPT ----
  if (/\b(what.*(?:i eat|i ate|i had)|my food|food diary|food log|meals today|ate today|eaten today|log today|today.?s?\s*food|food.*today|what.*eat.*today|how many.*calori|calori.*today|today.?s?\s*calori|protein today|today.?s?\s*protein|macros today|today.?s?\s*macros|daily total|today.?s?\s*total|total today|how much.*eaten|what.*logged|my meals|my logged|logged meals|see my (?:meal|food)|show my (?:meal|food)|view my (?:meal|food)|meals|today.?s meals)\b/i.test(m)) {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayLogs = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut })
      .from(chatHistory)
      .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)));
    // Filter out log-command entries (e.g. "log the meal", "save this") — those are commands, not food
    const LOG_CMD_RE = /^(log\s*(the\s*)?(meal|this|it|food)|save\s*(the\s*)?(meal|this|food)|record\s*(the\s*)?(meal|this)|add\s*(the\s*)?(meal|this)|done logging|finished logging|that.?s it for (today|now|this meal)|that.?s my (meal|food|breakfast|lunch|dinner|supper))$/i;
    const mealLogs = todayLogs.filter(l => !LOG_CMD_RE.test((l.messageIn || "").trim()));
    if (mealLogs.length === 0) {
      const diaryReply = `No meals logged yet today. Log your first meal by describing what you ate — for example: "had 2 eggs and pap for breakfast".`;
      await logChat(user.id, message, diaryReply, "FOOD_DIARY");
      return diaryReply;
    }
    let totalCal = 0; let totalProt = 0;
    const mealLines: string[] = [];
    for (const log of mealLogs) {
      const msgIn = log.messageIn || "";
      const matched = scanForSAFoods(msgIn);
      let mCal = matched.reduce((s: number, f: any) => s + (f.typicalPortionCalories || 0), 0);
      let mProt = matched.reduce((s: number, f: any) => s + (f.typicalPortionProtein || 0), 0);
      // If scan matched foods but got 0 kcal (e.g. unrecognised aliases), or scan found nothing,
      // fall back to numbers extracted from GPT response
      if (mCal === 0) {
        const calMatch = (log.messageOut || "").match(/(\d+)\s*kcal/i);
        const protMatch = (log.messageOut || "").match(/(\d+)g?\s*protein/i);
        if (calMatch) mCal = parseInt(calMatch[1]);
        if (protMatch) mProt = parseInt(protMatch[1]);
      }
      const isRawPhoto = msgIn === "[Photo]";
      if (isRawPhoto && mCal === 0) {
        mealLines.push(`• Food photo logged — waiting for a clearer photo or caption for calories/protein`);
        continue;
      }
      totalCal += mCal; totalProt += mProt;
      if (matched.length > 0) {
        const label = matched.map((f: any) => f.name).join(", ");
        mealLines.push(mCal > 0
          ? `• ${label} — ~${mCal} kcal, ${mProt}g protein`
          : `• ${label}`);
      } else if (msgIn && msgIn !== "[Photo]") {
        mealLines.push(mCal > 0
          ? `• ${msgIn.slice(0, 60)} — ~${mCal} kcal, ${mProt}g protein`
          : `• ${msgIn.slice(0, 60)}`);
      } else if (msgIn === "[Photo]") {
        mealLines.push(mCal > 0 ? `• Food photo — ~${mCal} kcal, ${mProt}g protein` : `• Food photo logged`);
      }
    }
    const calTarget = user.calorieTarget || 1800;
    const protTarget = user.proteinTarget || 130;
    const calRemaining = calTarget - totalCal;
    const diaryLines = [
      `*Today's food log (${mealLines.length} ${mealLines.length === 1 ? "meal" : "meals"}):*`,
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

  // ---- SHOPPING LIST GENERATOR — unified with shopping-lists.ts templates ----
  if (/\b(shopping list|shop.*this week|what.*to buy|what.*buy.*week|buy.*groceries|grocery list|my list.*week|food.*list|week.*groceries)\b/i.test(m)) {
    const budget = user.weeklyFoodBudget || "100_300";
    const weekNum = user.programmeWeek || 1;
    const goal = user.goalType || "fat_loss";
    const list = getShoppingList(budget, weekNum, goal);
    const shoppingReply = formatShoppingList(list, user.name || undefined, goal);
    await logChat(user.id, message, shoppingReply, "SHOPPING_LIST");
    return shoppingReply;
  }

  // ---- HUNGER HANDLER — "I'm hungry", "starving", "so hungry" ----
  const isHungryMsg =
    /\b(i.?m (so )?hungry|i am (so )?hungry|starving|always hungry|so hungry|feeling hungry|hungry all the time|hungry on this diet|hungry after meal|hungry after training|getting hungry|hunger pangs|can.?t stop eating|craving everything|craving food)\b/i.test(m);

  if (isHungryMsg) {
    const goal = user.goalType || "fat_loss";
    const cal = user.calorieTarget || 1800;
    const prot = user.proteinTarget || 120;
    const name = user.name ? `, ${user.name}` : "";
    const hungerReply = `Hunger on a deficit is normal${name} — but hunger that feels unbearable means something is off.\n\n*Check these first:*\n🥩 *Protein* — Are you hitting ${prot}g per day? Protein is the most filling macro. Low protein = constant hunger. If you are under, add eggs, pilchards, or chicken to every meal.\n🥬 *Volume* — Vegetables add bulk without calories. Cabbage, spinach, morogo — eat them in big quantities. They physically fill your stomach.\n💧 *Water* — Thirst and hunger feel identical. Drink 500ml of water right now and wait 10 minutes.\n😴 *Sleep* — Under 7 hours spikes ghrelin (hunger hormone) and crashes leptin (fullness hormone). If sleep is poor, hunger is worse — always.\n\n${goal === "fat_loss" ? `At ${cal} kcal you should not be unbearably hungry. If you are — your protein is likely too low. What did you eat today so far?` : `On a surplus hunger is your friend — eat when you are hungry, especially around your training window.`}`;
    await logChat(user.id, message, hungerReply, "HUNGER");
    return hungerReply;
  }

  // ---- ALCOHOL HANDLER — beer, wine, spirits, braai drinking ----
  const isAlcoholMsg =
    /\b(had.*(?:beer|wine|whisky|brandy|rum|vodka|gin|shots?|drinks?|alcohol|henny|hennessy|smirnoff|hunters|savanna|castle|black label|flying fish|brutal fruit|ciders?)|(?:beer|wine|alcohol|shots?|drinking|drinks?).*(?:had|drank|having|last night|weekend|yesterday|tonight))\b/i.test(m) &&
    !/\b(braai)\b/i.test(m); // braai guide already handles braai + alcohol

  if (isAlcoholMsg) {
    const goal = user.goalType || "fat_loss";
    const name = user.name ? `, ${user.name}` : "";
    const beerCals: Record<string, string> = {
      castle: "150 kcal",
      "black label": "160 kcal",
      savanna: "170 kcal",
      "flying fish": "180 kcal",
      "brutal fruit": "160 kcal",
      hunters: "165 kcal",
      henny: "250 kcal",
      hennessy: "250 kcal",
    };
    const drinkMatch = Object.entries(beerCals).find(([d]) => m.includes(d));
    const drinkNote = drinkMatch ? `${drinkMatch[0].charAt(0).toUpperCase() + drinkMatch[0].slice(1)} is ${drinkMatch[1]} per can.` : "Most beers are 140-180 kcal per can. Spirits are 80-120 kcal per shot.";
    const alcoholReply = `${drinkNote}\n\nI am not going to lecture you${name} — you are an adult. Here is what to do:\n\n*Tonight:* Protein with your next meal. Eggs, pilchards, or chicken — before or alongside drinks, not after.\n*Drinking rule:* Water between every drink. Not because of hydration theatre — because it naturally slows your drinking and cuts total intake in half.\n*Tomorrow:* ${goal === "fat_loss" ? "Back on your plan, first meal. Alcohol did not destroy your progress. One night never does. Seven nights in a row does." : "Training as planned. Alcohol slows muscle protein synthesis for 24-48 hours — just get the session in anyway."}\n\nAlcohol is not banned. It is a choice with a calorie cost. Make the next meal count.`;
    await logChat(user.id, message, alcoholReply, "ALCOHOL");
    return alcoholReply;
  }

  // ---- WIN / POSITIVE UPDATE — client shares a weight loss, milestone, or NSV ----
  const isWinMsg =
    (/\b(lost|dropped|down|lighter|less than before|weighed in at)\b/i.test(m) &&
     /\b(\d+(?:\.\d+)?)\s*kg\b/.test(m) &&
     /\b(lost|dropped|down)\b/i.test(m)) ||
    /\b(jeans.*fit|clothes.*fitting|fitting better|looser.*clothes|clothes.*looser|compliment|someone noticed|people.*noticed|noticed.*change|can feel.*difference|feeling.*stronger|lifted more|new pb|personal best|pb today)\b/i.test(m);

  if (isWinMsg) {
    const kgMatch = m.match(/(\d+(?:\.\d+)?)\s*kg/);
    const kgLost = kgMatch ? parseFloat(kgMatch[1]) : null;
    const total = user.totalWorkoutsCompleted || 0;
    const weeks = user.programmeWeek || 1;
    const name = user.name || "there";
    const winReply = kgLost && m.match(/\b(lost|dropped|down)\b/i)
      ? `${kgLost}kg down — that is real${name ? `, ${name}` : ""}. ${total} sessions, ${weeks} week${weeks !== 1 ? "s" : ""} of consistency. This is what the programme does.\n\nThe next ${kgLost}kg follows the same formula — same sessions, same food discipline, same steps. Keep going.`
      : `${name}, that is a win. Non-scale victories are the most honest data — the clothes do not lie.\n\nYour body is changing. The ${total} sessions you have put in are showing up in the real world. Keep the same habits for the next 4 weeks and this becomes your new normal.`;
    await logChat(user.id, message, winReply, "WIN_CELEBRATION");
    return winReply;
  }

  // ---- SUGAR / JUNK CRAVINGS HANDLER — different from general hunger ----
  const isCravingMsg =
    /\b(craving|cravings|craving sugar|craving chocolate|craving sweets|craving junk|want.*chocolate|want.*sweets|want.*chips|want.*biscuits|want.*cake|want.*ice cream|want.*pizza|dying for.*chocolate|dying for.*sweets|need.*chocolate|need.*sugar|sugar craving|sweet tooth|can.?t stop craving|want to eat junk|want.*takeaway|want.*kfc|want.*mcdonalds|want.*burger king)\b/i.test(m) &&
    !/\b(i.?m hungry|starving)\b/i.test(m); // Don't double-fire with hunger handler

  if (isCravingMsg) {
    const name = user.name ? `, ${user.name}` : "";
    const goal = user.goalType || "fat_loss";
    const isSugar = /\b(sugar|sweet|chocolate|sweets|biscuit|cake|ice cream)\b/i.test(m);
    const cravingReply = isSugar
      ? `Sugar cravings are not weakness${name} — they are a signal.\n\n*Most common causes:*\n1. *Low protein* — when protein is under target, your body craves fast energy (sugar). Fix: eat protein NOW — eggs, biltong, chicken, cottage cheese.\n2. *Skipped meals* — blood sugar crashed. Your body wants the fastest fix. Fix: eat a proper meal, do not try to resist on an empty stomach.\n3. *Poor sleep* — under 7 hours spikes ghrelin and makes you crave carbs. Fix: tonight, bed by 10pm.\n4. *Habit* — if you always eat sweets at 3pm, your body expects it. Fix: replace with Greek yoghurt and peanut butter — sweet, filling, high protein.\n\n*The 10-minute rule:* When the craving hits, eat protein first and wait 10 minutes. Most cravings pass. If it is still there after 10 min — eat a small portion of what you want. No guilt. Log it. Move on.`
      : `Craving junk food${name}? That is normal — especially when you are eating clean consistently.\n\n*The move:*\n1. Eat protein first — RIGHT NOW. Eggs, biltong, chicken. A full stomach craves nothing.\n2. If you still want it after — have a small portion. One slice, not a whole pizza. One serving, not the bag.\n3. Log it honestly. One takeaway meal is 800-1200 kcal. Your daily target is ${user.calorieTarget || 1800} kcal. Adjust the rest of the day.\n\nBanning food creates binges. Managing portions creates results.`;
    await logChat(user.id, message, cravingReply, "CRAVINGS");
    return cravingReply;
  }

  // ---- SOCIAL EVENT / PARTY / WEDDING / DECEMBER HANDLER ----
  const isSocialEvent =
    /\b(party|parties|wedding|matric dance|year.?end|december|festive|christmas|new year|birthday.*party|birthday.*eat|function|work function|office party|team building|dinner out|dinner party|family gathering|family dinner|lobola|umemulo|funeral.*food|after tears|stokvel|meat day|shisa nyama)\b/i.test(m) &&
    /\b(eat|eating|what should|how do i|tips|going to|this weekend|tonight|tomorrow|coming up|worried|nervous|scared|what do i do)\b/i.test(m);

  if (isSocialEvent) {
    const name = user.name ? `, ${user.name}` : "";
    const goal = user.goalType || "fat_loss";
    const socialReply = `Social events are part of life${name} — not an excuse to abandon the programme and not a reason to feel guilty.\n\n*Before the event:*\n• Eat a high-protein meal 2 hours before — eggs, chicken, anything filling. Arriving hungry is how you overeat.\n• Decide in advance: "I will have one plate" — not a restriction, a plan.\n\n*At the event:*\n• Protein first on the plate — meat, chicken, fish. Then vegetables. Then carbs/starch last.\n• One plate, not three. Enjoy it fully — no guilt.\n• Alcohol: alternate with water. Every second drink is water.\n\n*After the event:*\n• Do NOT skip meals the next day to "make up for it". That starts a restrict-binge cycle.\n• Normal meals tomorrow. Hit your protein. Train if scheduled.\n• One event does not break a programme. Seven events with no plan in between does.\n\n${goal === "fat_loss" ? "Your deficit runs across weeks, not one meal. Enjoy it and get back on track." : "Extra calories at an event are fuel — use them in your next session."}`;
    await logChat(user.id, message, socialReply, "SOCIAL_EVENT");
    return socialReply;
  }

  // ---- UNDER-EATING WARNING — client logs very low calories ----
  const todayCalCheck = (user.todayCaloriesDate === new Date().toISOString().slice(0, 10)) ? (user.todayCalories || 0) : 0;
  const calTarget2 = user.calorieTarget || 1800;
  const isLateDay = new Date().getHours() >= 16;
  const isUnderEating =
    isLateDay &&
    todayCalCheck > 0 &&
    todayCalCheck < calTarget2 * 0.45 &&
    /\b(only|just|that.?s it|ate|had)\b/i.test(m) &&
    /\b(breakfast|lunch|dinner|meal|food|ate)\b/i.test(m);

  if (isUnderEating) {
    const name = user.name ? `, ${user.name}` : "";
    const remaining = calTarget2 - todayCalCheck;
    const underEatReply = `Only ${todayCalCheck} kcal by this time of day${name} — that is too low.\n\nEating too little is not aggressive fat loss. It is the fastest way to lose muscle, crash your metabolism, and end up bingeing at 10pm.\n\n*Your target is ${calTarget2} kcal.* You have ${remaining} kcal left today — eat them. A proper dinner with protein and vegetables. Not snacks, a real meal.\n\nThe goal is a sustainable deficit, not starvation.`;
    await logChat(user.id, message, underEatReply, "UNDER_EATING");
    return underEatReply;
  }

  // ---- CHEAT / SLIP / FELL OFF HANDLER ----
  const isCheatMsg =
    /\b(cheat(?:ed|ing|s|meal|day)?|i slipped|slipped up|fell off|fell off track|off track|bad weekend|bad week|ate badly|ate everything|went off plan|broke my diet|broke the diet|ruined.*diet|ruined.*week|i binged|had a binge|ate too much|overdid it|over ate|overate|ate junk|bad food day|terrible eating|ate like crazy|couldn't control|lost control.*eating|eating got out of hand|whole weekend|entire weekend.*ate|pigged out)\b/i.test(m);

  if (isCheatMsg) {
    const name = user.name ? `, ${user.name}` : "";
    const total = user.totalWorkoutsCompleted || 0;
    const week = user.programmeWeek || 1;
    const sessionLine = total > 0 ? `You have ${total} training session${total > 1 ? "s" : ""} logged. That does not disappear overnight.` : `You are in Week ${week} of your programme. One rough day does not erase that.`;
    const cheatReply = `One bad meal or weekend does not undo weeks of work${name}. That is not how the body works.\n\n*The math:* To gain 1kg of real fat you need to eat 7,700 kcal MORE than you burn. A bad weekend is usually 1,000–2,000 kcal over — mostly water weight, glycogen, and bloat. It looks worse than it is. It comes off in 2–3 days of normal eating.\n\n${sessionLine}\n\n*The move:*\n• Do not "make up" for it with less food tomorrow — that starts a restrict-binge cycle\n• Do not skip your next training session out of guilt — guilt makes it worse\n• Eat your normal meals today, hit your protein, drink water\n• One bad day means nothing. Missing the next 3 days means something\n\nReset starts with the next meal — not Monday.`;
    await logChat(user.id, message, cheatReply, "CHEAT_RECOVERY");
    return cheatReply;
  }

  // ---- SCALE NOT MOVING / PLATEAU / NOT LOSING WEIGHT ----
  const isScaleStuck =
    /\b(scale.*not.*moving|scale.*same|scale.*hasn.?t moved|scale.*stuck|not losing.*weight|weight.*not.*changing|weight.*not.*moving|weight.*the same|weight.*stuck|not dropping|no.*weight loss|haven.?t lost|didn.?t lose|losing nothing|same weight|still the same|haven.?t changed|weight.*hasn.?t|not seeing.*change|scale.*lie|scale.*wrong|the scale|why.*not losing|why am i not losing|why aren.?t i losing|why isn.?t.*working|why is nothing|nothing.*happening)\b/i.test(m);

  if (isScaleStuck) {
    const name = user.name ? `, ${user.name}` : "";
    const week = user.programmeWeek || 1;
    const total = user.totalWorkoutsCompleted || 0;
    const goal = user.goalType || "fat_loss";
    const prot = user.proteinTarget || 120;

    let scaleReply = `The scale is one data point${name} — and it is often the least honest one in the first 4–8 weeks.\n\n*What the scale does NOT show:*\n• Muscle gain — 1kg of muscle takes up less space than 1kg of fat. You can lose fat and gain muscle and the scale barely moves — but your body is completely different\n• Water retention — sodium, stress, poor sleep, and your cycle (for women) all cause 1–3kg swings that are not fat\n• Glycogen — when you start training, muscles store more glycogen (with water attached). Scale goes up. Body fat goes down. Both things are true.\n\n*The real questions:*\n• Do your clothes fit differently?\n• Is your energy better?\n• Are you stronger in the gym?\n• Are you sleeping better?\n\nIf yes to any of those — your body is changing. The scale will catch up.\n\n`;

    if (week <= 3) {
      scaleReply += `You are in Week ${week}. The first 3 weeks are adaptation — your body is building the foundation. Real visible changes show up at Week 4–6 for most people. Stay consistent.`;
    } else if (total > 0 && week >= 4) {
      scaleReply += `*If the scale has genuinely not moved in 3+ weeks:*\n1. Log your food honestly for 3 days — portion sizes creep up without noticing\n2. Add a 20-minute walk on top of your current steps target\n3. Check sodium — SA processed food (polony, chips, takeaways) retains water\n4. Is sleep under 7 hours? Cortisol from poor sleep actively holds fat, especially belly fat\n\nPick one of these and fix it this week. Then update me.`;
    } else {
      scaleReply += `Stay consistent with your ${prot}g protein target and your sessions. Body recomposition is happening even when the scale lies. Trust the 8-week process — not the 1-week number.`;
    }

    if (goal === "muscle_gain") {
      scaleReply = `${name ? name.slice(2) + ", the" : "The"} scale going up is the goal on a muscle-building programme. If it is not moving, you are likely not eating enough. Your body cannot build muscle in a deficit — it needs fuel.\n\nAre you hitting your calorie and protein targets consistently? That is where muscle gain starts.`;
    }

    await logChat(user.id, message, scaleReply, "SCALE_STUCK");
    return scaleReply;
  }

  // ---- STRESS / ANXIETY / OVERWHELM HANDLER ----
  const isStressMsg =
    /\b(i.?m stressed|so stressed|very stressed|feeling stressed|work stress|life stress|stressed out|anxious|anxiety|overwhelmed|too much going on|can.?t cope|everything is too much|mental health|burnout|burned out|burnt out|exhausted mentally|emotionally drained)\b/i.test(m);

  if (isStressMsg) {
    const name = user.name ? ` ${user.name}` : "";
    const goal = user.goalType || "fat_loss";
    const stressReply = `Stress is not just a feeling${name} — it is a physical event that directly blocks fat loss.\n\nWhen you are chronically stressed, cortisol stays elevated. Cortisol tells your body to store fat, especially belly fat, break down muscle, spike hunger, and crave carbs and sugar. This is biology, not weakness.\n\n*What to do right now:*\n1. *Walk* — 20 minutes outside. Not for fitness. To drop cortisol. It works within minutes.\n2. *Eat your protein* — stress eats muscle. Protect it. Eggs, chicken, pilchards right now.\n3. *Sleep tonight* — cortisol from one bad night undoes two good training days. Bed by 10pm.\n4. *Training still counts* — a 30-minute session is better than nothing. Lower weight, same movement.\n\n${goal === "fat_loss" ? "Stress is the hidden reason most people plateau. Fix the stress and the fat loss often restarts on its own." : "Cortisol and muscle gain are opposites — manage the stress or the gains slow down."}\n\nWhat is actually causing the stress right now?`;
    await logChat(user.id, message, stressReply, "STRESS");
    return stressReply;
  }

  // ---- TIRED / LOW ENERGY HANDLER ----
  const isTiredMsg =
    /\b(i.?m tired|so tired|very tired|exhausted|no energy|low energy|drained|fatigued|fatigue|lethargic|sluggish|can.?t wake up|always tired|tired all the time|tired today|feeling flat|body feels heavy|legs feel heavy)\b/i.test(m) &&
    !/\b(tired of|tired with|sick and tired)\b/i.test(m);

  if (isTiredMsg) {
    const name = user.name ? ` ${user.name}` : "";
    const tiredReply = `Three questions${name} before I give you advice:\n\n1. *Sleep* — How many hours last night? Under 7 means your body is not recovering properly. This is the most common cause of low energy by far.\n\n2. *Food* — What did you eat today? Low energy by afternoon is almost always low carbs or skipped meals. Your muscles need fuel.\n\n3. *Water* — Have you drunk 1.5-2L today? Even mild dehydration drops energy by 20%.\n\nWhich of these is off? Tell me and I will give you a specific fix — not "rest more" or "drink water" in general, the actual solution.`;
    await logChat(user.id, message, tiredReply, "TIRED");
    return tiredReply;
  }

  // ---- REST DAY HANDLER ----
  const isRestDayMsg =
    /\b(rest day|no gym today|off today|taking a rest|rest today|not training today|skipping gym|not going to gym|day off|recovery day|active recovery|not working out today|off day)\b/i.test(m);

  if (isRestDayMsg) {
    const name = user.name ? ` ${user.name}` : "";
    const stepsT = user.stepsTarget || 8500;
    const prot = user.proteinTarget || 120;
    const restReply = `Rest day is part of the programme${name} — not a break from it.\n\n*What happens on rest days:*\nYour muscles repair and grow. Strength is built during rest, not during the session. Skipping rest days is how people overtrain and plateau.\n\n*Rest day checklist:*\n✅ *Steps* — still hit ${stepsT.toLocaleString()}. Walk, do not train. Low intensity movement speeds recovery.\n✅ *Protein* — still hit ${prot}g. Muscle repair needs amino acids even when you are not lifting.\n✅ *Sleep* — 7-9 hours tonight. This is where the gains actually happen.\n✅ *Stretch* — 10 minutes. Hips, quads, chest, shoulders. Whatever is tight.\n\nCome back to your next session fresher than if you had trained today.`;
    await logChat(user.id, message, restReply, "REST_DAY");
    return restReply;
  }

  // ---- MISSED WORKOUT / SKIPPED SESSION HANDLER ----
  const isMissedWorkout =
    /\b(missed.*(?:workout|session|gym|training)|couldn.?t.*(?:train|gym|workout)|skipped.*(?:gym|session|workout|training)|didn.?t.*(?:train|go to gym|workout)|missed.*gym|didn.?t make it|couldn.?t make it|no gym yesterday|missed yesterday|no training today|didn.?t train)\b/i.test(m);

  if (isMissedWorkout) {
    const name = user.name ? ` ${user.name}` : "";
    const total = user.totalWorkoutsCompleted || 0;
    const missedReply = `One missed session${name} — that is all it is.\n\n${total > 0 ? `You have ${total} sessions completed. One miss does not erase that.` : "Getting back on track starts now."}\n\n*The rule:* Never miss twice. One miss is life. Two misses in a row is the start of a habit.\n\n*What to do right now:*\nDecide when you train next — not "tomorrow maybe", give me the specific time. 6am? 12pm? After work at 5pm?\n\nThat is your only job. Pick the time.`;
    await logChat(user.id, message, missedReply, "MISSED_WORKOUT");
    return missedReply;
  }

  // ---- SORE / DOMS HANDLER ----
  const isSoreMsg =
    /\b(i.?m sore|so sore|very sore|muscle soreness|doms|delayed onset|my muscles are sore|legs are sore|arms are sore|body is sore|everything is sore|sore from|sore after|still sore|too sore to train|too sore to gym|can.?t move|can.?t walk properly|struggling to walk|legs killing me|arms killing me)\b/i.test(m);

  if (isSoreMsg) {
    const name = user.name ? ` ${user.name}` : "";
    const soreArea = /\b(legs?|quads?|hamstrings?|glutes?|calves?)\b/i.test(m) ? "legs"
      : /\b(chest|pecs?|push|bench)\b/i.test(m) ? "chest"
      : /\b(back|lats?|rows?|pull)\b/i.test(m) ? "back"
      : /\b(shoulders?|delts?|press)\b/i.test(m) ? "shoulders"
      : /\b(arms?|biceps?|triceps?|curls?)\b/i.test(m) ? "arms"
      : "muscles";
    const trainAround = soreArea === "legs" ? "upper body — chest, back, shoulders, arms. Nothing that loads the legs."
      : soreArea === "chest" || soreArea === "shoulders" || soreArea === "arms" ? "lower body — squats, leg press, lunges, walking."
      : soreArea === "back" ? "lower body and chest press machine — avoid rowing and pulling movements."
      : "whatever body part is NOT sore.";
    const soreReply = `DOMS${name} — delayed onset muscle soreness. It means you trained hard enough to create adaptation. This is the process working.\n\n*Normal DOMS lasts 24-72 hours.* Peak soreness is usually day 2 after training, not day 1.\n\n*What to do:*\n✅ *Keep moving* — light walking speeds recovery by increasing blood flow to the muscle\n✅ *Protein* — your muscles are actively repairing right now and need amino acids\n✅ *Train around it* — if ${soreArea} is sore, train ${trainAround}\n✅ *Do NOT foam roll aggressively on day 1-2* — you can increase inflammation. Light rolling only.\n\n❌ *Do not rest completely* — passive rest slows recovery. Active recovery wins.\n\nThe soreness means it is working. Keep going.`;
    await logChat(user.id, message, soreReply, "DOMS");
    return soreReply;
  }

  // ---- WATER TARGET HANDLER ----
  const isWaterTargetMsg =
    /\b(how much water|water target|water goal|daily water|water intake|how many litres|how many liters|litres of water|liters of water|water per day|water recommendation|should i drink|water a day)\b/i.test(m);

  if (isWaterTargetMsg) {
    const name = user.name ? ` ${user.name}` : "";
    const weight = parseFloat(user.currentWeight || "75");
    const waterLitres = (weight * 0.033).toFixed(1);
    const waterReply = `${name ? name.trimStart() + " — " : ""}your water target is *${waterLitres}L per day* (based on your body weight × 0.033).\n\nSimplest way to hit it: 500ml when you wake up, 500ml mid-morning, 500ml before lunch, 500ml mid-afternoon, 500ml before dinner. That is 2.5L without thinking about it.\n\nThirst and hunger feel identical — most cravings at 3pm are actually dehydration. Drink first, eat after. Log your water by sending "2L water" or "drank 1.5 litres".`;
    await logChat(user.id, message, waterReply, "WATER_TARGET");
    return waterReply;
  }

  // ---- PRE / POST WORKOUT NUTRITION HANDLER ----
  const isWorkoutNutrition =
    /\b(what.*eat.*(?:before|pre).?(?:gym|workout|training|session)|(?:before|pre).?(?:gym|workout|training).*(?:eat|food|meal|snack)|pre.?workout.*(?:food|meal|eat|nutrition)|what.*eat.*after.*(?:gym|workout|training)|post.?workout.*(?:food|meal|eat|nutrition)|after.*gym.*eat|eat.*after.*training)\b/i.test(m);

  if (isWorkoutNutrition) {
    const name = user.name ? ` ${user.name}` : "";
    const goal = user.goalType || "fat_loss";
    const isPre = /\b(before|pre.?workout|pre.?gym)\b/i.test(m);
    const isPost = /\b(after|post.?workout|post.?gym)\b/i.test(m);

    if (isPre && !isPost) {
      const preReply = `Pre-workout nutrition${name}:\n\n*60-90 minutes before training:*\n🍠 *Carbs* — fuel the session. Sweet potato, oats, brown rice, banana. Enough to fill your tank.\n🥩 *Protein* — 20-30g to protect muscle. Eggs, chicken, or a protein shake.\n💧 *Water* — 500ml before you start. Dehydration drops performance by 10-20%.\n\n*SA quick options:*\n• 2 eggs + 1 slice brown bread — 280 kcal, 18g protein ✅\n• Oats + milk — 320 kcal, 12g protein ✅\n• Sweet potato + chicken — 400 kcal, 30g protein ✅\n\n*Avoid:* Fatty foods (slows digestion), heavy meals within 45 minutes, training completely fasted if strength is the goal.\n\n${goal === "fat_loss" ? "For fat loss: eat light but eat. A small pre-workout meal does NOT block fat burning." : "For muscle gain: bigger pre-workout meal, more carbs — your muscles need the fuel."}`;
      await logChat(user.id, message, preReply, "PRE_WORKOUT_NUTRITION");
      return preReply;
    }

    const postReply = `Post-workout nutrition${name}:\n\n*Within 60 minutes after training:*\n🥩 *Protein first* — 30-40g to start muscle repair. This is the most important window.\n🍠 *Carbs* — replenish glycogen. Sweet potato, rice, oats, fruit.\n💧 *Water* — replace what you sweated out.\n\n*SA quick options:*\n• Pilchards + sweet potato — 380 kcal, 35g protein ✅\n• 3 eggs + pap — 420 kcal, 28g protein ✅\n• Chicken + rice — 500 kcal, 40g protein ✅\n• Protein shake + banana (if no time) — 300 kcal, 30g protein ✅\n\n*The rule:* Protein is non-negotiable post-workout. Skip the carbs if you must — never skip the protein.\n\n${goal === "fat_loss" ? "Post-workout is not the time to restrict — eat your protein. The rest of the day you can be in a deficit." : "Post-workout is the most important meal of the day for muscle gain. Eat big here."}`;
    await logChat(user.id, message, postReply, "POST_WORKOUT_NUTRITION");
    return postReply;
  }

  // ---- MEAL-SPECIFIC PLATE METHOD ("what to eat for breakfast/lunch/dinner") ----
  const isMealSpecificQ =
    /\b(what.*(?:eat|have|make|cook).*(?:for|at)?\s*(?:breakfast|lunch|dinner|supper|snack)|(?:breakfast|lunch|dinner|supper|snack).*(?:ideas?|option|suggestion|help|advice)|what.*(?:breakfast|lunch|dinner|supper)|good.*(?:breakfast|lunch|dinner|supper))\b/i.test(m) &&
    !/\b(i had|i ate|i have|just had|just ate)\b/i.test(m); // exclude food logs

  if (isMealSpecificQ) {
    const goal = user.goalType || "fat_loss";
    const budget = user.weeklyFoodBudget || "100_300";
    const name = user.name ? ` ${user.name}` : "";
    const isMealBreakfast = /breakfast/i.test(m);
    const isMealLunch = /lunch/i.test(m);
    const isMealDinner = /dinner|supper/i.test(m);
    const isSnack = /snack/i.test(m);

    let mealReply = "";
    if (isMealBreakfast) {
      mealReply = `Breakfast${name} — the meal that sets your protein baseline for the day:\n\n${budget === "under_100"
        ? "• *2 boiled eggs + pap* — 310 kcal, 18g protein. Cheapest solid breakfast in SA.\n• *Oats + water + peanut butter* — 350 kcal, 12g protein. R5 a bowl.\n• *3 eggs scrambled* — 250 kcal, 21g protein. Nothing beats it."
        : "• *3 eggs + 1 slice brown bread* — 320 kcal, 22g protein\n• *Oats + low fat milk + boiled egg* — 380 kcal, 20g protein\n• *Greek yoghurt + banana + handful nuts* — 350 kcal, 18g protein"}\n\n${goal === "fat_loss" ? "Protein first at breakfast kills hunger for 4 hours. No protein = cravings by 10am." : "Bigger breakfast for muscle gain — add an extra egg or a scoop of protein."}`;
    } else if (isMealLunch) {
      mealReply = `Lunch${name} — your biggest protein hit of the day:\n\n${budget === "under_100"
        ? "• *Pilchards + pap + cabbage* — 420 kcal, 30g protein. R15 total.\n• *Sugar beans + brown rice + spinach* — 380 kcal, 18g protein. R8 total.\n• *2 eggs + bread + tomato* — 340 kcal, 16g protein."
        : "• *Chicken breast + sweet potato + salad* — 480 kcal, 38g protein ✅ Best option\n• *Tuna + brown rice + cucumber* — 400 kcal, 32g protein\n• *Mince + pap + morogo* — 500 kcal, 35g protein"}\n\n${goal === "fat_loss" ? "Make lunch your biggest meal — front-loading calories earlier means less hunger at night." : "This is where muscle gain happens — eat big and get your protein in."}`;
    } else if (isMealDinner) {
      mealReply = `Dinner${name}:\n\n${goal === "fat_loss"
        ? "• Smaller carb portion than lunch — protein and vegetables carry the meal\n• *Chicken + cabbage + tomato* — 350 kcal, 32g protein ✅\n• *Hake + spinach* — 280 kcal, 35g protein ✅\n• *Pilchards + salad* — 250 kcal, 26g protein ✅\n\nAfter 6pm: cut carbs in half, double the vegetables. Not zero carbs — half."
        : "• *Beef mince + pap + chakalaka* — 600 kcal, 40g protein\n• *Chicken thighs + rice + broccoli* — 580 kcal, 42g protein\n• Keep carbs in — your muscles recover overnight and need glycogen."}\n\nProtein at every dinner, every night. That is non-negotiable.`;
    } else if (isSnack) {
      mealReply = `Snacks${name} — only if you have calories left:\n\n✅ *High-protein snacks:*\n• Biltong 30g — 90 kcal, 18g protein\n• Boiled egg — 80 kcal, 6g protein\n• Cottage cheese ½ cup — 100 kcal, 14g protein\n• Pilchards half tin — 100 kcal, 12g protein\n\n❌ *Avoid:* Chips, biscuits, chocolate, rusks — calories with almost zero protein.\n\n${goal === "fat_loss" ? "If you are hungry between meals, your previous meal did not have enough protein. Fix the meal — do not add snacks." : "Between meals: protein shake or Greek yoghurt to keep amino acids flowing."}`;
    }

    if (mealReply) {
      await logChat(user.id, message, mealReply, "MEAL_ADVICE");
      return mealReply;
    }
  }

  // ============================================================
  // MYTH BUSTERS — hardcoded, zero GPT cost
  // Coach K's real positions on common SA fitness myths
  // ============================================================

  // ---- SPOT REDUCTION / BELLY FAT MYTH ----
  const isSpotReductionMsg =
    /\b(belly fat exercise|lose belly fat|burn belly fat|target belly|target.*stomach|stomach exercise|lose.*stomach|tummy.*exercise|waist.*exercise|ab.*fat|fat.*ab|six pack.*fat|lose.*tummy|shrink.*belly|reduce.*waist|flatten.*stomach|exercises.*for.*belly|exercises.*for.*stomach)\b/i.test(m) ||
    (/\b(ab|abs|sit.?up|crunch|plank)\b/i.test(m) && /\b(lose|burn|fat|belly|stomach|weight)\b/i.test(m));

  if (isSpotReductionMsg) {
    const goal = user.goalType || "fat_loss";
    const name = user.name ? `, ${user.name}` : "";
    const spotReply = `*The truth about belly fat${name}:*\n\nYou cannot choose where your body burns fat. Spot reduction is not real — no exercise burns fat from one specific area. Not crunches, not planks, not waist trainers, not anything.\n\nBelly fat is the LAST place most people lose it and the first place they gain it. That is genetics, not a technique problem.\n\n*What actually works:*\n• Calorie deficit — eat less than you burn\n• Strength training — builds muscle that burns fat 24/7\n• Steps — 8,500+ daily keeps your metabolism active\n• Sleep — poor sleep spikes cortisol which stores fat around the belly\n\nSit-ups build ab muscles. They do not burn belly fat. You need to lose fat OVER the abs — that happens through your diet and overall activity, not through any specific exercise.\n\n${goal === "fat_loss" ? `Your calorie target is ${user.calorieTarget || 1800} kcal/day. Hit that consistently for 8 weeks and the belly changes — no special exercise needed.` : `Keep training and eating at your targets — the belly responds when the overall programme is consistent.`}`;
    await logChat(user.id, message, spotReply, "MYTH_BUSTER");
    return spotReply;
  }

  // ---- TIKTOK TEAS / DETOX / SLIMMING TEA MYTH ----
  const isTeaMythMsg =
    /\b(slimming tea|weight loss tea|detox tea|flat tummy tea|belly fat tea|green tea.*weight|teatox|skinny tea|herbal.*weight loss|fat burning tea|lemon water.*weight|apple cider.*weight|acv.*weight|detox.*drink|cleanse.*weight|lemon.*detox|boil.*lemon|boil.*cinnamon|boil.*ginger.*lose|fat burner.*drink)\b/i.test(m) ||
    (/\btiktok\b/i.test(m) && /\b(tea|drink|weight|fat|slim|detox|lose)\b/i.test(m));

  if (isTeaMythMsg) {
    const name = user.name ? `, ${user.name}` : "";
    const teaReply = `Eish${name} — that is one of the biggest myths in the industry.\n\n*Slimming teas, detox teas, and TikTok weight loss drinks do not work.*\n\nThere is no tea, drink, or "detox" that burns fat. Not green tea. Not lemon water. Not apple cider vinegar. Not anything boiled with cinnamon and ginger.\n\n*What they actually do:*\n• Most are strong laxatives — you lose water weight, not fat\n• The weight comes back within 48 hours\n• Some damage your gut bacteria long-term\n• All of them are a waste of money\n\nThe companies selling these products are targeting people who want a shortcut. There is no shortcut.\n\n*What burns fat:*\n1. Consistent calorie deficit over weeks\n2. Strength training 3x per week\n3. 8,500+ steps daily\n4. 7-9 hours sleep\n\nThat is it. Your programme already has all four. Trust the process.`;
    await logChat(user.id, message, teaReply, "MYTH_BUSTER");
    return teaReply;
  }

  // ---- OZEMPIC / SEMAGLUTIDE / WEIGHT LOSS INJECTION ----
  const isOzempicMsg =
    /\b(ozempic|semaglutide|wegovy|mounjaro|tirzepatide|weight loss injection|slimming injection|slimming jab|fat jab|skinny jab|injection.*weight|weight.*injection)\b/i.test(m);

  if (isOzempicMsg) {
    const name = user.name ? `, ${user.name}` : "";
    const ozempicReply = `Sharp question${name}.\n\n*The truth about Ozempic and weight loss injections:*\n\nOzempic (semaglutide) is a real medication — it works by reducing appetite and slowing digestion. Studies show real weight loss. It is not a scam.\n\n*But here is what nobody on TikTok tells you:*\n\n• It does not replace the basics. You still need to eat right, walk daily, and strength train — or the moment you stop taking it, the weight comes back\n• Side effects are real — nausea, vomiting, gut issues, and it is extremely expensive (R2,000-R8,000/month in SA)\n• It was designed for diabetics with severe obesity — not general weight loss\n• You cannot build muscle on Ozempic alone without strength training\n• Without resistance training you lose muscle with the fat — this makes long-term maintenance harder\n\n*My position:* Build the habits first. Walk. Train. Eat right. Sleep. If after 3 months of real effort you are still not moving, speak to a doctor about whether medication is appropriate for you. But medication without the habits is just expensive weight you will regain.\n\nYour programme already works — if you are consistent. Are you hitting your sessions this week?`;
    await logChat(user.id, message, ozempicReply, "MYTH_BUSTER");
    return ozempicReply;
  }

  // ---- RUNNING CLUBS / MARATHON FOR WEIGHT LOSS → redirect to walking + strength ----
  const isRunningClubMsg =
    /\b(running club|run.*club|marathon.*weight|running.*lose weight|run.*lose.*fat|jogging.*lose.*fat|run.*fat loss|5k.*weight|10k.*weight|half marathon|full marathon|park run|parkrun)\b/i.test(m) ||
    (/\b(running|jogging|run)\b/i.test(m) && /\b(weight loss|lose weight|fat loss|get fit|get in shape|burn fat|lose fat)\b/i.test(m));

  if (isRunningClubMsg) {
    const name = user.name ? `, ${user.name}` : "";
    const steps = user.stepsTarget || 8500;
    const runningReply = `Real talk${name}.\n\n*Running for weight loss is one of the most common mistakes I see.*\n\nHere is what actually happens: you join a running club, you burn 400 calories on the run, you come home starving and eat 600 calories extra. Net result — weight gain.\n\nRunning also:\n• Is hard on joints, especially if you are overweight\n• Does not build muscle — which is what drives long-term fat loss\n• Makes you HUNGRY — harder to maintain a deficit\n• People get injured in the first 6 weeks before any real progress\n\n*What I use instead:*\n✅ *Walking* — 8,500-15,000 steps daily. Low intensity, sustainable, burns fat without spiking hunger, protects joints. A 10,000 step day burns 400-500 extra calories without making you ravenous.\n✅ *Strength training* — 3 days per week. Builds muscle. Muscle burns calories 24/7, even while you sleep. This is the engine.\n\nYou can run if you enjoy it — that is great for your heart and mental health. But do not depend on running to lose weight. Depend on your programme and your daily steps.\n\nYour target is ${steps.toLocaleString()} steps per day. Are you hitting that consistently?`;
    await logChat(user.id, message, runningReply, "MYTH_BUSTER");
    return runningReply;
  }

  // ---- AVOCADO CALORIE CONTEXT ----
  const isAvocadoMsg =
    /\b(avocado|avo)\b/i.test(m) &&
    /\b(healthy|good|eat|can i|is it|diet|weight|fat|daily|every day|all the time|meal plan|lunch|breakfast)\b/i.test(m);

  if (isAvocadoMsg) {
    const goal = user.goalType || "fat_loss";
    const name = user.name ? `, ${user.name}` : "";
    const avoReply = goal === "fat_loss"
      ? `Yes avocados are healthy${name} — but they are calorie-dense and that matters when you are trying to lose fat.\n\n*Avocado calorie reality:*\n• Half an avo: ~160 kcal, 2g protein\n• Full avo: ~320 kcal, 4g protein\n• That is 18% of your daily calorie budget in one fruit\n\nHealthy fats are still calories. An avo on toast with eggs can easily be 600 kcal before 8am.\n\n*My rule:* Half an avo, 2-3 times a week maximum when you are cutting. The healthy fat is real — but so are the calories. Pair it with eggs for protein. Never as a snack on its own.`
      : `Avocados are excellent${name} — healthy fats that support hormone production, which matters for muscle building.\n\nFull avo is ~320 kcal, 30g healthy fat. In a muscle gain phase, fat calories are your friend. Use it freely — just track it as a fat source, not a protein source. Pair with eggs or chicken.`;
    await logChat(user.id, message, avoReply, "MYTH_BUSTER");
    return avoReply;
  }

  // ---- SOCIAL MEDIA / TIKTOK MISINFORMATION ----
  const isSocialMediaMythMsg =
    /\b(i saw on tiktok|tiktok says|tiktok said|saw on instagram|instagram says|instagram said|social media.*says|youtube says|youtube said|i read.*that|someone told me.*that|my friend.*told me|my sister.*told me|my mom.*told me)\b/i.test(m) &&
    /\b(lose weight|fat loss|diet|exercise|burn fat|slim|weight loss|calories|protein|carb|food|workout|supplement|detox|cleanse|tea|drink)\b/i.test(m);

  if (isSocialMediaMythMsg) {
    const name = user.name ? `, ${user.name}` : "";
    const socialReply = `Eish${name} — this is important.\n\nSocial media fitness advice is almost always wrong, exaggerated, or selling something.\n\n*The algorithm rewards:* drama, extreme claims, quick fixes, and shocking content. It does NOT reward: "eat protein, walk daily, strength train 3 times a week, sleep 8 hours" — because that is boring and it does not sell anything.\n\n*Real results come from boring basics:*\n1. Consistent strength training 3-4 days\n2. 8,500-15,000 steps daily\n3. Enough protein every meal\n4. 7-9 hours sleep\n5. Patience\n\nAnything promising faster than 0.5-1kg per week is either a lie or dangerous. What specifically did you see — I will tell you whether it is real or rubbish.`;
    await logChat(user.id, message, socialReply, "MYTH_BUSTER");
    return socialReply;
  }

  // ---- DOUBLE CARB CORRECTION — pap AND rice AND bread in same meal ----
  const carbonWords = (m.match(/\b(pap|samp|rice|bread|potato|sweet potato|butternut|maize)\b/gi) || []);
  const hasLogTrigger2 = /\b(ate|had|having|eating|breakfast|lunch|dinner|supper|snack|just had|meal)\b/.test(m);
  if (carbonWords.length >= 3 && hasLogTrigger2) {
    const name = user.name ? `, ${user.name}` : "";
    const doubleCarbReply = `Too many carbs in one meal${name}.\n\nI can see ${carbonWords.slice(0, 3).join(", ")} — that is three carb sources together. Your body can only use one portion of carbs per meal; the rest gets stored as fat.\n\n*Fix this meal:* Keep ONE carb source (pap OR rice OR bread — whichever is your staple). Fill the rest of your plate with protein and vegetables.\n\n*The plate rule:* One carb + protein + as many vegetables as you want. Every meal. Simple.`;
    await logChat(user.id, message, doubleCarbReply, "MYTH_BUSTER");
    return doubleCarbReply;
  }

  // ---- PLATE METHOD COACHING — when client asks "what should I eat?" without specifics ----
  const isPlateMethodQ =
    /\b(what should i eat|what do i eat|how should i eat|what to eat|healthy eating|eating right|how to eat|my diet|best way to eat|eating habits|what foods|food choices|nutritional advice|nutrition advice|diet advice)\b/i.test(m) &&
    !/\b(today|tonight|breakfast|lunch|dinner|meal plan|shopping)\b/i.test(m);

  if (isPlateMethodQ) {
    const goal = user.goalType || "fat_loss";
    const budget = user.weeklyFoodBudget || "100_300";
    const name = user.name ? `, ${user.name}` : "";
    const plateReply = `*The Coach K plate method${name}:*\n\nForget calorie counting. I don't count calories, I make the right choices. Here is the whole system:\n\n*Every meal, every time:*\n🥩 *Protein first* — takes up half your plate. Eggs, chicken, pilchards, mince, beans. If there is no protein on the plate, it is not a meal.\n🍠 *One carb* — takes up a quarter of your plate. Pap, brown rice, sweet potato, oats. ONE — not all three.\n🥬 *Vegetables* — fills the rest. Spinach, cabbage, morogo, tomatoes, cucumber. Unlimited. The more the better.\n\n*That is it.* No app. No scale. No counting. Just: protein + one carb + vegetables.\n\nDo this for every meal and your body does the rest.\n\n${goal === "fat_loss" ? "For fat loss: make the protein portion bigger and the carb portion smaller." : "For muscle gain: make the carb portion bigger, especially before and after training."}\n\n${budget === "under_100" ? "At your budget: eggs + pap + spinach. Pilchards + pap + cabbage. Repeat. Simple and it works." : "Best SA options: pilchards, eggs, chicken thigh, sugar beans — paired with sweet potato or pap and whatever vegetable you have."}`;
    await logChat(user.id, message, plateReply, "PLATE_METHOD");
    return plateReply;
  }

  // ---- EVERYTHING ELSE → GPT decides ----
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString("en-ZA", { weekday: "long" });
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const clientName = user.name || "there";
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
  } catch (e) { console.warn("[non-fatal]", e); }

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
  Respond based on their step target of ${user.stepsTarget || 8500}. If below — push them. If at or above — celebrate and give next action.

FOOD / MEAL LOGGED (any food item or meal described):
  Coach specifically on THAT exact food. Use the SA food database. Estimate SA portion calories and protein. If junk — acknowledge without shaming, give one specific swap. If good — celebrate and connect to their ${user.goalType || "fat loss"} goal. Never end with a protein warning. Never give generic advice.
  CRITICAL — If the meal contains ANY of: chicken, beef, mince, fish, tuna, hake, salmon, eggs, pilchards, beans, lentils, pork, lamb, cottage cheese, Greek yoghurt, biltong — DO NOT suggest adding protein or swapping to pilchards. The client is ALREADY eating protein. Celebrate the choice. Budget suggestions (pilchards, eggs, sugar beans) ONLY fire when the client explicitly says they have no money or their stored budget tier is "under_100". Never suggest budget swaps after a quality meal unprompted.

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

HOLIDAY / VACATION:
  Client is on holiday and asking for advice. Give practical holiday-specific tips: bodyweight exercises they can do anywhere (beach, hotel, park), walking targets, how to eat well at restaurants/buffets while still enjoying the holiday. Do NOT pause their coaching or tell them to stop messaging. They WANT coaching while on holiday. Keep it fun and practical — holiday is not a reason to stop, it is a chance to stay consistent in a new way.

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

ANTI-GENERIC ENFORCEMENT — every response MUST pass these checks:
1. SPECIFICITY CHECK: Every response must contain at least ONE of: a specific number (calories, kg, reps, steps, rands), a specific food name, a specific exercise name, or a specific time/date. If your response contains none of these, it is too generic — rewrite it.
2. CONTEXT CHECK: Reference something the client actually said or something from their profile (goal, weight, training mode, week number). If your response could apply to literally anyone, it is too generic.
3. ACTION CHECK: End every response with ONE specific action the client can do right now. Not "keep going" or "stay consistent" — a real action like "do 20 squats before your shower tonight" or "add 2 boiled eggs to your next meal".
4. If you catch yourself writing a response that sounds like a motivational poster — delete it and write what a real coach would say to THIS specific person.

CRITICAL RULES — these are non-negotiable:
- Client's name is ${clientName}. Never call them "a client", "Hi client", or "champ" if you have a real name.
- NEVER say "drink 2 litres of water" as a response to anything except a water question.
- Pilchards ARE an excellent protein source — never say otherwise.
- Never append a protein warning at the end of a food coaching response.
- Never mention AI, bot, system, or technology.
- Never use a motivational quote as a standalone response.
- Maximum 3 sentences and 60 words for conversational responses. Exception: programme delivery, meal plans, and food logging responses may be longer.
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

  // ---- LANGUAGE-AWARE COACHING — simplify English for non-English speakers ----
  if (activeLang !== "en") {
    const langNames: Record<string, string> = { zu: "Zulu", xh: "Xhosa", st: "Sesotho", tn: "Setswana", ts: "Xitsonga", af: "Afrikaans" };
    const langName = langNames[activeLang] || "non-English";
    finalInstruction = `LANGUAGE CONTEXT: This client's primary language is ${langName}. Use SIMPLE English — short sentences, basic words, no jargon. Maximum 8-10 words per sentence. Say "eat" not "consume". Say "belly fat" not "visceral fat". Explain any exercise in one plain sentence.\n\n${finalInstruction}`;
  }

  // ---- MEMORY: retrieve relevant memories for this message ----
  let memoryContext = "";
  try {
    const memories = await retrieveMemories(phone, message);
    if (memories.length > 0) memoryContext = memories.join("\n");
  } catch (e) { console.warn("[non-fatal]", e); }

  // ---- SHORT REPLY HANDLER — "yes", "no", "ok" etc need conversation context ----
  const SHORT_REPLIES = ["yes", "no", "yeah", "nah", "nope", "yep", "yebo", "ja", "ok", "okay", "sure", "fine", "cool", "sharp", "eish", "thanks", "thank you", "dankie", "lekker", "nice", "awesome", "great", "perfect", "noted", "got it", "will do", "aight", "right"];
  if (SHORT_REPLIES.includes(m)) {
    try {
      const lastExchange = await db.select({ messageOut: chatHistory.messageOut, intent: chatHistory.intent })
        .from(chatHistory)
        .where(eq(chatHistory.userId, user.id))
        .orderBy(desc(chatHistory.createdAt))
        .limit(1);
      const lastOut = lastExchange[0]?.messageOut || "";
      const lastIntent = lastExchange[0]?.intent || "";
      const shortReplyContext = `Client replied "${message}" to your previous message (intent: ${lastIntent}): "${lastOut.slice(0, 300)}". This is a direct response to what you said. Respond accordingly — if you asked a question, this is the answer. If you gave advice, "${message}" is acknowledgment. Be specific and move forward. Do not ask "what do you mean" — interpret from context.`;
      const shortReply = sanitizeCoachReply(await askCoachK(message, user, shortReplyContext, memoryContext), message, user.weeklyFoodBudget, user.injuries);
      await logChat(user.id, message, shortReply, "SHORT_REPLY");
      return shortReply;
    } catch (e) { console.warn("[short-reply]", e); }
  }

  // ---- FRUSTRATION HANDLER — client venting after a bad bot response ----
  const severeServiceRiskComplaint =
    /\b(kill|killed|hospital|unsafe|dangerous|harm)\b/i.test(m) &&
    /\b(this|service|app|bot|coach|you)\b/i.test(m);

  if (severeServiceRiskComplaint) {
    const name = user.name || "there";
    const injuryCtx = user.injuries && user.injuries !== "none"
      ? ` I still have your injury noted: ${user.injuries}.`
      : "";
    const safetyReply = `${name}, you are right to call that out.${injuryCtx} I will keep responses specific and safety-first from here. Immediate action: if your pain is active today, skip loading that area and do a pain-free session only.`;
    await logChat(user.id, message, safetyReply, "SAFETY_COMPLAINT");
    return safetyReply;
  }

  const isFrustrated =
    /\b(wow just wow|seriously\?|what the|this is ridiculous|what is this|are you serious|come on|jesus|wtf|what the hell|this is useless|pathetic|terrible|this doesn.?t make sense|that.?s wrong|you.?re wrong|bad response|wrong answer|that.?s not what i|you didn.?t even|you ignored|you didn.?t listen|not what i asked|not worth|waste of money|waste of time|cancel|refund|unsubscribe|this is bad|this is shit|this sucks|useless|rubbish|garbage|disappointed|i.?m done|giving up on this|doesn.?t work|broken|stupid)\b/i.test(m) ||
    (m.length < 30 && /^\s*(wow|seriously|really|eish|ag man|ag nee|shem|hayibo|haibo|omg|oh my god|yoh)\s*[!?.]*$/i.test(m));

  if (isFrustrated) {
    try {
      const lastBotMsg = await db.select({ messageOut: chatHistory.messageOut, intent: chatHistory.intent })
        .from(chatHistory)
        .where(eq(chatHistory.userId, user.id))
        .orderBy(desc(chatHistory.createdAt))
        .limit(1);
      const lastOut = lastBotMsg[0]?.messageOut || "";
      const lastIntent = lastBotMsg[0]?.intent || "";
      const profileGuard = `PROFILE FACTS: Goal=${user.goalType || "fat_loss"}, Budget=${user.weeklyFoodBudget || "100_300"}, Injuries=${user.injuries || "none"}, Medical=${user.medicalConditions || "none"}. You MUST use these facts and never ignore them.`;
      const frustContext = `Client is frustrated or unimpressed. Their last message: "${message}". The previous bot response was (intent: ${lastIntent}): "${lastOut.slice(0, 200)}". RULES: The client is reacting negatively to YOUR previous response — "${message}" means they are unhappy with what you just said. Acknowledge the specific issue in one sentence. Do not say "I apologise" or "I'm sorry" generically. Do NOT ask "what happened" or "what caught you off guard" — YOU are what happened. Then correct course with a concrete, profile-aware answer that includes ONE immediate action. Avoid open-ended questions unless strictly required. ${profileGuard} SA voice. Direct. No fluff.`;
      const frustReply = sanitizeCoachReply(await askCoachK(message, user, frustContext), message, user.weeklyFoodBudget, user.injuries);
      await logChat(user.id, message, frustReply, "FRUSTRATION");
      return frustReply;
    } catch (e) { console.warn("[fall-through-gpt]", e); }
  }

  // Daily GPT call cap — prevents runaway costs from heavy users
  const underLimit = await isUnderGPTCallLimit(user.id);
  if (!underLimit) {
    const capName = user.name || "there";
    const capGoal = user.goalType === "muscle_gain" ? "hit your protein and get 8 hours sleep tonight" : "hit your step target and keep your last meal clean tonight";
    return `${capName}, I have hit my daily message limit. Your programme, targets, and logs are all still active — reply *menu* to access them. Focus on one thing: ${capGoal}. Full coaching resumes tomorrow morning.`;
  }

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
      const targetValue = `Calorie target: ${user.calorieTarget || 1800} kcal | Protein target: ${user.proteinTarget || 130}g | Steps target: ${user.stepsTarget || 8500}`;
      gptReply = await adminAgent(user, message, "log", message, targetValue);
    } else {
      gptReply = await askCoachK(message, user, finalInstruction, memoryContext);
    }
    // If specialist agent returned its own error string, fall back to full Coach K
    if (gptReply === AGENT_ERROR) {
      gptReply = await askCoachK(message, user, finalInstruction, memoryContext);
    }
  } catch (e) {
    console.warn("[agent-routing]", e);
    gptReply = await askCoachK(message, user, finalInstruction, memoryContext);
  }

  const finalReply = sanitizeCoachReply(langPrefix ? `${langPrefix}${gptReply}` : gptReply, message, user.weeklyFoodBudget, user.injuries);

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
  } catch (e) { console.warn("[non-fatal]", e); }

  // Auto-store significant coaching notes for future memory
  try {
    const mLower = message.toLowerCase();
    if (/\b(stressed|anxious|depressed|overwhelmed|struggling|bad week|hard week|tough week|not okay|burnout)\b/.test(mLower)) {
      await storeMemory(phone, `Client mentioned stress or emotional difficulty: "${message.slice(0, 100)}"`, "mindset");
    } else if (/\b(hate|don.?t like|can.?t stand|avoid|never eat|allergic to|dislike)\b/.test(mLower)) {
      await storeMemory(phone, `Food/exercise preference noted: "${message.slice(0, 100)}"`, "preference");
    } else if (/\b(love|favourite|always eat|prefer|enjoy|my go.?to)\b/.test(mLower)) {
      await storeMemory(phone, `Positive preference noted: "${message.slice(0, 100)}"`, "preference");
    } else if (/\b(night shift|work from home|just had a baby|new job|retrenched|moved|single mom|single dad|divorce|breakup)\b/.test(mLower)) {
      await storeMemory(phone, `Life situation update: "${message.slice(0, 120)}"`, "preference");
    }
  } catch (e) { console.warn("[non-fatal]", e); }

  // ---- FOOD CONTEXT CHECK — only if GPT response is about food the user actually ate ----
  // STRICT: must have BOTH a log trigger AND actual SA food detected by scanner
  // This prevents "I had a great workout", "food is expensive", "dinner plans" from being logged as food
  const gptFoodMatch = scanForSAFoods(m);
  const isFoodLog = !isLogCommand && !isQuestion && !isFrustration && hasLogTrigger && gptFoodMatch.length > 0;
  if (isFoodLog) {
    const pattern = await checkFoodPatterns(user.id);
    const perfectDay = await checkPerfectDay(user.id);
    // ---- Calorie running total — from EXISTING food logs only (not current GPT message) ----
    let dailyTotal = "";
    try {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayFoodLogs = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)));
      let totalCal = 0; let totalProt = 0;
      // Only scan EXISTING food logs — do NOT include current message (GPT handled it, not the food scanner)
      for (const log of todayFoodLogs) {
        const matched = scanForSAFoods(log.messageIn || "");
        if (matched.length > 0) {
          totalCal += matched.reduce((s: number, f: any) => s + (f.typicalPortionCalories || 0), 0);
          totalProt += matched.reduce((s: number, f: any) => s + (f.typicalPortionProtein || 0), 0);
        }
      }
      const calTarget = user.calorieTarget || 1800;
      const protTarget = user.proteinTarget || 130;
      if (totalCal > 0) {
        const remaining = calTarget - totalCal;
        dailyTotal = `\n\n_Today so far: ~${totalCal} kcal | ${totalProt}g protein. Target: ${calTarget} kcal | ${protTarget}g protein.${remaining > 100 ? ` ${remaining} kcal remaining.` : remaining < -100 ? ` Over by ${Math.abs(remaining)} kcal.` : " On target."}_`;
      }
    } catch (e) { console.warn("[non-fatal]", e); }
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

    // Auto-escalation: detect messages that need human review
    if (messageIn && messageIn.length > 2) {
      const esc = detectEscalation(messageIn);
      if (esc.should) {
        // Check for recent open escalation for this user to avoid duplicates
        const recent = await db.select({ id: escalations.id }).from(escalations)
          .where(and(eq(escalations.userId, userId), eq(escalations.status, "open")))
          .limit(1);
        if (recent.length === 0) {
          await db.insert(escalations).values({
            userId,
            reason: esc.reason,
            triggerMessage: messageIn.slice(0, 500),
            priority: esc.priority,
            slaDeadline: escalationSLA(esc.priority),
          });
          console.log(`[ESCALATION] Auto-created: ${esc.reason} (${esc.priority}) for user ${userId}`);
        }
      }
    }
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

  // ── Route modules (extracted from this file for maintainability) ──
  const {
    registerAuthRoutes,
    registerHealthRoutes,
    registerAdminRoutes,
    registerWhatsAppRoutes,
    registerDashboardRoutes,
    registerPaymentRoutes,
    requireAdminKey,
  } = await import("./routes/index");

  // Deps that route modules need from this file
  const routeDeps = { handleMessage, logChat, checkRateLimit };

  // Register all modular routes
  registerAuthRoutes(app);
  registerHealthRoutes(app);
  registerAdminRoutes(app, routeDeps);
  registerWhatsAppRoutes(app, routeDeps);
  registerDashboardRoutes(app, routeDeps);
  registerPaymentRoutes(app);

  // ══════════════════════════════════════════════════════════
  // All API routes above are now in server/routes/*.ts modules.
  // Only the /coach HTML dashboard remains inline below.
  // ══════════════════════════════════════════════════════════

  // OLD INLINE ROUTES REMOVED — now in:
  //   routes/auth.ts      — /api/auth/login
  //   routes/admin.ts     — /api/users, /api/admin/*
  //   routes/whatsapp.ts  — /twilio/whatsapp, /api/admin/test-webhook
  //   routes/health.ts    — /health, /api/health, /api/public/stats, /voice/*
  //   routes/dashboard.ts — /api/dashboard/*
  //   routes/payments.ts  — /webhook/payfast, /webhook/status, /api/payfast/link
  // See server/routes/index.ts for the registry.

  // ============================================================
  // COACH ADMIN DASHBOARD — GET /coach?key=COACH_DASHBOARD_KEY
  // ============================================================
  app.get("/coach", async (req: any, res: any) => {
    const key = req.query.key as string || "";
    const dashKey = process.env.COACH_DASHBOARD_KEY;
    if (!dashKey) return res.status(503).send("<h1>Dashboard not configured — set COACH_DASHBOARD_KEY</h1>");
    let authorized = false;
    try { authorized = key.length === dashKey.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(dashKey)); } catch { authorized = false; }
    if (!authorized) {
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
      const allUsersForFunnel = await db.select().from(users);
      const goalCounts: Record<string, number> = {};
      const budgetCounts: Record<string, number> = {};

      // Funnel metrics
      const funnelTotal = allUsersForFunnel.length;
      const funnelOnboarded = allComplete.length;
      const funnelFirstWorkout = allComplete.filter(u => (u.totalWorkoutsCompleted || 0) >= 1).length;
      const funnelPaying = allComplete.filter(u => u.subscriptionStatus === "active").length;
      const funnelActiveWeek = allComplete.filter(u => u.lastActiveAt && (now - new Date(u.lastActiveAt).getTime()) < 7 * 86400000).length;
      const estimatedMRR = calculateMRR(funnelPaying);
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

      const atRiskRows = allCompleteUsers.filter((u: any) => daysSince(u.lastActiveAt) >= 2).map((u: any) => {
        const days = daysSince(u.lastActiveAt);
        const rowBg = days >= 14 ? "#3b0a0a" : days >= 5 ? "#2a1a0a" : "#1a2a1a";
        const badgeColor = days >= 14 ? "#ef4444" : days >= 5 ? "#f97316" : "#f59e0b";
        const riskLabel = days >= 14 ? "SEVERE" : days >= 5 ? "HIGH" : "WARNING";
        const injuries = u.injuries || u.medicalConditions || "";
        const ph = u.phoneNumber.replace(/'/g, "\\'");
        return `
          <tr style="background:${rowBg}; border-bottom: 1px solid #2d3748;">
            <td style="padding:10px 12px; color:#f9fafb; font-weight:500;">${u.name || "—"}</td>
            <td style="padding:10px 12px; color:#9ca3af; font-family:monospace;">${maskPhone(u.phoneNumber)}</td>
            <td style="padding:10px 12px;">
              <span style="background:${badgeColor}; color:#000; border-radius:4px; padding:2px 8px; font-size:12px; font-weight:700;">${riskLabel}</span>
              <span style="color:#9ca3af; font-size:11px; margin-left:6px;">${fmtDate(u.lastActiveAt)} (${days}d ago)</span>
            </td>
            <td style="padding:10px 12px; color:#22c55e; font-weight:600; text-align:center;">${u.programmeWeek ?? "—"}</td>
            <td style="padding:10px 12px; color:#d1d5db; text-align:center;">${u.totalWorkoutsCompleted ?? 0}</td>
            <td style="padding:10px 12px; color:#a78bfa; font-size:13px;">${u.goalType || "—"}</td>
            <td style="padding:8px 6px; white-space:nowrap;">
              <button onclick="intervene('${ph}','checkin',this)" style="background:#3b82f6; color:#fff; border:none; border-radius:4px; padding:4px 8px; font-size:11px; cursor:pointer; margin:1px;">Check-in</button>
              <button onclick="intervene('${ph}','workout',this)" style="background:#22c55e; color:#000; border:none; border-radius:4px; padding:4px 8px; font-size:11px; cursor:pointer; margin:1px;">Workout</button>
              <button onclick="intervene('${ph}','motivation',this)" style="background:#a78bfa; color:#000; border:none; border-radius:4px; padding:4px 8px; font-size:11px; cursor:pointer; margin:1px;">Motivate</button>
            </td>
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

      // Pre-compute funnel HTML to avoid nested template literal issues
      const funnelSteps = [
        { label: "Signed Up", count: funnelTotal, color: "#6b7280" },
        { label: "Onboarding Complete", count: funnelOnboarded, color: "#3b82f6" },
        { label: "First Workout Done", count: funnelFirstWorkout, color: "#a78bfa" },
        { label: "Paying", count: funnelPaying, color: "#22c55e" },
        { label: "Active This Week", count: funnelActiveWeek, color: "#4ade80" },
      ];
      const funnelHtml = funnelSteps.map(step => {
        const pct = funnelTotal > 0 ? Math.round(step.count / funnelTotal * 100) : 0;
        return '<div style="margin-bottom:8px;">' +
          '<div style="display:flex; justify-content:space-between; margin-bottom:3px;">' +
          '<span style="color:#d1d5db; font-size:13px;">' + step.label + '</span>' +
          '<span style="color:#9ca3af; font-size:13px;">' + step.count + ' (' + pct + '%)</span>' +
          '</div>' +
          '<div style="background:#1f2937; border-radius:4px; height:20px; overflow:hidden; border:1px solid #374151;">' +
          '<div style="background:' + step.color + '; height:100%; width:' + pct + '%; border-radius:3px; transition:width 0.3s;"></div>' +
          '</div></div>';
      }).join("");

      // Pre-compute delivery rate
      const deliveryTotal = deliveryStats.sent + deliveryStats.failed;
      const deliveryRate = deliveryTotal > 0 ? Math.round(deliveryStats.sent / deliveryTotal * 100) : 100;
      const deliveryRateColor = deliveryTotal > 0 ? (deliveryStats.failed / deliveryTotal > 0.1 ? '#ef4444' : '#22c55e') : '#4b5563';

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

    <!-- REVENUE + FUNNEL -->
    <div style="margin-bottom:16px; font-size:11px; color:#4b5563; text-transform:uppercase; letter-spacing:0.12em; font-weight:700;">Revenue & Funnel</div>
    <div class="grid-4">
      <div class="card" style="border-color:#22c55e44;">
        <div class="stat-value" style="color:#22c55e;">R${estimatedMRR.toLocaleString()}</div>
        <div class="stat-label">Estimated MRR</div>
      </div>
      <div class="card" style="border-color:#22c55e44;">
        <div class="stat-value" style="color:#4ade80;">${funnelPaying}</div>
        <div class="stat-label">Paying Clients</div>
      </div>
      <div class="card" style="border-color:#3b82f644;">
        <div class="stat-value" style="color:#38bdf8;">${funnelFirstWorkout}</div>
        <div class="stat-label">Completed 1+ Workout</div>
      </div>
      <div class="card" style="border-color:#a78bfa44;">
        <div class="stat-value" style="color:#a78bfa;">${funnelActiveWeek}</div>
        <div class="stat-label">Active This Week</div>
      </div>
    </div>

    <!-- DELIVERY HEALTH -->
    <div class="grid-3" style="margin-bottom:16px;">
      <div class="card" style="border-color:${deliveryStats.failed > 0 ? '#ef444444' : '#22c55e44'};">
        <div class="stat-value" style="color:${deliveryStats.failed > 0 ? '#ef4444' : '#22c55e'};">${deliveryStats.sent}</div>
        <div class="stat-label">Messages Sent Today</div>
      </div>
      <div class="card" style="border-color:${deliveryStats.failed > 0 ? '#ef444444' : '#37415144'};">
        <div class="stat-value" style="color:${deliveryStats.failed > 0 ? '#ef4444' : '#4b5563'};">${deliveryStats.failed}</div>
        <div class="stat-label">Delivery Failures Today</div>
      </div>
      <div class="card">
        <div class="stat-value" style="color:${deliveryRateColor};">${deliveryRate}%</div>
        <div class="stat-label">Delivery Rate</div>
      </div>
    </div>

    <!-- PINNED NEXT ACTIONS -->
    <div class="section">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span style="background:#8b5cf6; color:#fff; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Actions</span>
        <span class="section-title" style="margin-bottom:0;">Pinned Next Actions</span>
      </div>
      <div id="next-actions-container" class="card" style="color:#4b5563; text-align:center; padding:20px;">Loading actions...</div>
    </div>

    <!-- CONVERSION FUNNEL -->
    <div class="card" style="margin-bottom:16px; padding:20px;">
      <div class="section-title" style="margin-bottom:16px;">Conversion Funnel</div>
      ${funnelHtml}
    </div>

    <!-- AT RISK -->
    <div class="section">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span style="background:#ef4444; color:#fff; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">At Risk</span>
        <span class="section-title" style="margin-bottom:0;">At-Risk Clients (${allCompleteUsers.filter((u: any) => daysSince(u.lastActiveAt) >= 2).length} clients)</span>
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
                <th style="${thStyle}">Actions</th>
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

  <!-- ESCALATION INBOX -->
  <div class="container">
    <div class="section">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span style="background:#ef4444; color:#fff; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Inbox</span>
        <span class="section-title" style="margin-bottom:0;">Escalation Inbox</span>
        <select id="escFilter" onchange="loadEscalations()" style="margin-left:auto; background:#111827; border:1px solid #374151; border-radius:6px; padding:6px 10px; color:#f9fafb; font-size:12px;">
          <option value="open">Open</option>
          <option value="claimed">Claimed</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
      </div>
      <div id="escWrap" class="card" style="color:#4b5563; text-align:center; padding:30px;">Loading escalations...</div>
    </div>
  </div>

  <!-- COHORT ANALYTICS -->
  <div class="container">
    <div class="section">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span style="background:#a78bfa; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Cohorts</span>
        <span class="section-title" style="margin-bottom:0;">Signup Cohort Analytics</span>
      </div>
      <div id="cohortWrap" class="card" style="color:#4b5563; text-align:center; padding:30px;">Loading cohort data...</div>
    </div>
  </div>

  <!-- A/B EXPERIMENTS -->
  <div class="container">
    <div class="section">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span style="background:#f59e0b; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">A/B</span>
        <span class="section-title" style="margin-bottom:0;">Message Experiments</span>
        <button onclick="showNewExperiment()" style="margin-left:auto; background:#f59e0b; color:#000; border:none; border-radius:6px; padding:6px 14px; font-size:12px; font-weight:700; cursor:pointer;">+ New</button>
      </div>
      <div id="newExpForm" style="display:none; margin-bottom:12px;" class="card">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px;">
          <input id="expName" placeholder="Experiment name" style="background:#111827; border:1px solid #374151; border-radius:6px; padding:8px; color:#f9fafb; font-size:13px;" />
          <select id="expType" style="background:#111827; border:1px solid #374151; border-radius:6px; padding:8px; color:#f9fafb; font-size:13px;">
            <option value="morning_checkin">Morning Check-in</option>
            <option value="nudge">Nudge / Re-engagement</option>
            <option value="workout_reminder">Workout Reminder</option>
            <option value="food_reminder">Food Logging Reminder</option>
            <option value="weekly_checkin">Weekly Check-in</option>
          </select>
        </div>
        <textarea id="expA" rows="2" placeholder="Variant A (control) message template..." style="width:100%; background:#111827; border:1px solid #374151; border-radius:6px; padding:8px; color:#f9fafb; font-size:13px; margin-bottom:6px; resize:vertical;"></textarea>
        <textarea id="expB" rows="2" placeholder="Variant B (challenger) message template..." style="width:100%; background:#111827; border:1px solid #374151; border-radius:6px; padding:8px; color:#f9fafb; font-size:13px; margin-bottom:8px; resize:vertical;"></textarea>
        <div style="display:flex; gap:8px;">
          <button onclick="createExperiment()" style="background:#f59e0b; color:#000; border:none; border-radius:6px; padding:8px 16px; font-size:13px; font-weight:700; cursor:pointer;">Create</button>
          <button onclick="document.getElementById('newExpForm').style.display='none'" style="background:#374151; color:#9ca3af; border:none; border-radius:6px; padding:8px 16px; font-size:13px; cursor:pointer;">Cancel</button>
        </div>
      </div>
      <div id="abWrap" class="card" style="color:#4b5563; text-align:center; padding:30px;">Loading experiments...</div>
    </div>
  </div>

  <!-- CLIENT TIMELINE -->
  <div class="container">
    <div class="section">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span style="background:#38bdf8; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Timeline</span>
        <span class="section-title" style="margin-bottom:0;">Client Timeline (30 days)</span>
      </div>
      <div class="card" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px;">
        <input id="timelinePhone" type="text" placeholder="Enter phone number e.g. +27..." style="flex:1; min-width:200px; background:#111827; border:1px solid #374151; border-radius:6px; padding:10px 12px; color:#f9fafb; font-size:14px; outline:none;" />
        <button onclick="loadTimeline()" style="background:#38bdf8; color:#000; border:none; border-radius:6px; padding:10px 20px; font-size:14px; font-weight:700; cursor:pointer;">Load</button>
      </div>
      <div id="timelineWrap" style="display:none;">
        <div id="timelineSummary" class="card" style="margin-bottom:12px;"></div>
        <div id="timelineEvents" class="table-wrap"></div>
      </div>
    </div>
  </div>

  <!-- NPS SUMMARY -->
  <div class="container">
    <div class="section">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span style="background:#22c55e; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">NPS</span>
        <span class="section-title" style="margin-bottom:0;">Client Satisfaction</span>
      </div>
      <div id="npsWrap" class="card" style="color:#4b5563; text-align:center; padding:20px;">Loading NPS data...</div>
    </div>
  </div>

  <!-- BROADCAST -->
  <div class="container">
    <div class="section">
      <div class="section-title">Quick Broadcast</div>
      <div class="card" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <input id="broadcastMsg" type="text" placeholder="Type message to send..." style="flex:1; min-width:200px; background:#111827; border:1px solid #374151; border-radius:6px; padding:10px 12px; color:#f9fafb; font-size:14px; outline:none;" />
        <select id="broadcastFilter" style="background:#111827; border:1px solid #374151; border-radius:6px; padding:10px 12px; color:#f9fafb; font-size:13px;">
          <option value="all">All Clients</option>
          <option value="active">Active Only</option>
          <option value="atrisk">At-Risk Only</option>
        </select>
        <button onclick="sendBroadcast()" style="background:#22c55e; color:#000; border:none; border-radius:6px; padding:10px 20px; font-size:14px; font-weight:700; cursor:pointer;">Send</button>
        <span id="broadcastStatus" style="color:#9ca3af; font-size:12px;"></span>
      </div>
    </div>
  </div>

  <!-- KPI METRICS -->
  <div class="container">
    <div class="section">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span style="background:#22c55e; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">KPIs</span>
        <span class="section-title" style="margin-bottom:0;">Business Metrics (30 days)</span>
      </div>
      <div id="kpiWrap" class="card" style="color:#4b5563; text-align:center; padding:20px;">Loading KPI data...</div>
    </div>
  </div>

  <!-- REVENUE -->
  <div class="container">
    <div class="section">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span style="background:#f59e0b; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Revenue</span>
        <span class="section-title" style="margin-bottom:0;">Revenue Dashboard</span>
      </div>
      <div id="revenueWrap" class="card" style="color:#4b5563; text-align:center; padding:20px;">Loading revenue data...</div>
    </div>
  </div>

  <!-- CLIENT SEARCH -->
  <div class="container">
    <div class="section">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span style="background:#38bdf8; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Search</span>
        <span class="section-title" style="margin-bottom:0;">Client Search</span>
      </div>
      <div class="card" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px;">
        <input id="clientSearch" type="text" placeholder="Search by name or phone..." onkeyup="searchClients()" style="flex:1; min-width:200px; background:#111827; border:1px solid #374151; border-radius:6px; padding:10px 12px; color:#f9fafb; font-size:14px; outline:none;" />
      </div>
      <div id="searchResults" style="display:none;" class="table-wrap"></div>
    </div>
  </div>

  <!-- WEEKLY REPORT -->
  <div class="container">
    <div class="section">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <span style="background:#a78bfa; color:#000; border-radius:6px; padding:3px 10px; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:0.08em;">Report</span>
        <span class="section-title" style="margin-bottom:0;">Weekly Coach Report</span>
        <button onclick="loadWeeklyReport()" style="margin-left:auto; background:#a78bfa; color:#000; border:none; border-radius:6px; padding:6px 14px; font-size:12px; font-weight:700; cursor:pointer;">Generate</button>
      </div>
      <div id="weeklyReportWrap" class="card" style="color:#4b5563; text-align:center; padding:20px;">Click Generate to load weekly report.</div>
    </div>
  </div>

  <div style="text-align:center; padding:20px; color:#374151; font-size:12px; border-top:1px solid #1f2937; margin-top:8px;">
    KamLife Coach Admin Dashboard — Confidential &nbsp;|&nbsp; Refresh to update
  </div>

  <script>
    const DASH_KEY = "${key}";
    async function intervene(phone, type, btn) {
      btn.disabled = true;
      btn.textContent = "...";
      try {
        const res = await fetch("/api/dashboard/intervene", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-dashboard-key": DASH_KEY },
          body: JSON.stringify({ phone, type })
        });
        const data = await res.json();
        if (data.success) {
          btn.textContent = "Sent ✓";
          btn.style.background = "#065f46";
          btn.style.color = "#fff";
        } else {
          btn.textContent = "Failed";
          btn.style.background = "#7f1d1d";
        }
      } catch {
        btn.textContent = "Error";
        btn.style.background = "#7f1d1d";
      }
    }
    async function sendBroadcast() {
      const msg = document.getElementById("broadcastMsg").value.trim();
      const filter = document.getElementById("broadcastFilter").value;
      const status = document.getElementById("broadcastStatus");
      if (!msg) { status.textContent = "Type a message first"; return; }
      if (!confirm("Send to " + filter + " clients?")) return;
      status.textContent = "Sending...";
      try {
        const res = await fetch("/api/dashboard/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-dashboard-key": DASH_KEY },
          body: JSON.stringify({ message: msg, filter })
        });
        const data = await res.json();
        status.textContent = "Sent: " + data.sent + " | Failed: " + data.failed;
        document.getElementById("broadcastMsg").value = "";
      } catch {
        status.textContent = "Error sending";
      }
    }

    // ---- ESCALATION INBOX ----
    async function loadEscalations() {
      const filter = document.getElementById("escFilter").value;
      const wrap = document.getElementById("escWrap");
      wrap.innerHTML = '<div style="color:#9ca3af;">Loading...</div>';
      try {
        const res = await fetch("/api/dashboard/escalations?status=" + filter, { headers: { "x-dashboard-key": DASH_KEY } });
        const data = await res.json();
        if (!data.escalations || data.escalations.length === 0) {
          wrap.innerHTML = '<div style="color:#4b5563; padding:20px; text-align:center;">No ' + filter + ' escalations.</div>';
          return;
        }
        const prioColors = { urgent: "#ef4444", high: "#f59e0b", normal: "#38bdf8", low: "#6b7280" };
        let rows = "";
        for (const e of data.escalations) {
          const created = new Date(e.createdAt).toLocaleDateString("en-ZA", { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" });
          const slaColor = e.slaBreach ? "#ef4444" : "#22c55e";
          const slaText = e.slaBreach ? "BREACHED" : e.slaRemaining !== null ? e.slaRemaining + "m left" : "—";
          const actions = e.status === "open"
            ? '<button onclick="claimEsc(' + e.id + ', this)" style="background:#38bdf8; color:#000; border:none; border-radius:4px; padding:4px 10px; font-size:11px; font-weight:700; cursor:pointer;">Claim</button>'
            : e.status === "claimed"
            ? '<button onclick="resolveEsc(' + e.id + ')" style="background:#22c55e; color:#000; border:none; border-radius:4px; padding:4px 10px; font-size:11px; font-weight:700; cursor:pointer;">Resolve</button>'
            : '<span style="color:#4b5563; font-size:11px;">' + (e.resolution || "Done") + '</span>';
          rows += '<tr>' +
            '<td style="padding:6px 10px; border-bottom:1px solid #1f2937;"><span style="color:' + (prioColors[e.priority] || "#9ca3af") + '; font-weight:700; font-size:11px; text-transform:uppercase;">' + e.priority + '</span></td>' +
            '<td style="padding:6px 10px; border-bottom:1px solid #1f2937; color:#d1d5db; font-weight:600; font-size:13px;">' + (e.userName || "Unknown") + '</td>' +
            '<td style="padding:6px 10px; border-bottom:1px solid #1f2937; color:#9ca3af; font-size:12px;">' + (e.userPhone || "") + '</td>' +
            '<td style="padding:6px 10px; border-bottom:1px solid #1f2937; font-size:12px;"><span style="background:#374151; border-radius:4px; padding:2px 6px; color:#d1d5db;">' + e.reason + '</span></td>' +
            '<td style="padding:6px 10px; border-bottom:1px solid #1f2937; color:#6b7280; font-size:12px; max-width:250px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + (e.triggerMessage || "—") + '</td>' +
            '<td style="padding:6px 10px; border-bottom:1px solid #1f2937; color:' + slaColor + '; font-size:11px; font-weight:700;">' + slaText + '</td>' +
            '<td style="padding:6px 10px; border-bottom:1px solid #1f2937; color:#6b7280; font-size:11px;">' + created + '</td>' +
            '<td style="padding:6px 10px; border-bottom:1px solid #1f2937;">' + actions + '</td>' +
            '</tr>';
        }
        wrap.innerHTML =
          '<div class="table-wrap"><table style="width:100%; border-collapse:collapse; font-size:13px;">' +
          '<thead><tr>' +
          '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Priority</th>' +
          '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Client</th>' +
          '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Phone</th>' +
          '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Reason</th>' +
          '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Message</th>' +
          '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">SLA</th>' +
          '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Created</th>' +
          '<th style="padding:8px 10px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Action</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>';
      } catch { wrap.innerHTML = '<div style="color:#ef4444;">Failed to load escalations.</div>'; }
    }
    loadEscalations();

    async function claimEsc(id, btn) {
      btn.disabled = true; btn.textContent = "...";
      try {
        await fetch("/api/dashboard/escalations/" + id + "/claim", {
          method: "POST", headers: { "Content-Type": "application/json", "x-dashboard-key": DASH_KEY },
          body: JSON.stringify({ claimedBy: "Coach" })
        });
        loadEscalations();
      } catch { btn.textContent = "Error"; }
    }
    async function resolveEsc(id) {
      const note = prompt("Resolution notes (optional):");
      try {
        await fetch("/api/dashboard/escalations/" + id + "/resolve", {
          method: "POST", headers: { "Content-Type": "application/json", "x-dashboard-key": DASH_KEY },
          body: JSON.stringify({ resolution: note || "Resolved" })
        });
        loadEscalations();
      } catch { alert("Error resolving"); }
    }

    // ---- NPS SUMMARY ----
    (async function loadNPS() {
      const wrap = document.getElementById("npsWrap");
      try {
        const res = await fetch("/api/dashboard/nps", { headers: { "x-dashboard-key": DASH_KEY } });
        const data = await res.json();
        if (data.totalResponses === 0) {
          wrap.innerHTML = '<div style="color:#4b5563;">No NPS responses yet. Clients can reply "rate" to submit feedback.</div>';
          return;
        }
        const npsColor = data.npsScore >= 50 ? "#22c55e" : data.npsScore >= 0 ? "#f59e0b" : "#ef4444";
        let recentRows = "";
        for (const r of data.recent) {
          const color = r.score >= 9 ? "#22c55e" : r.score >= 7 ? "#f59e0b" : "#ef4444";
          recentRows += '<span style="display:inline-block; background:' + color + '22; color:' + color + '; border:1px solid ' + color + '44; border-radius:6px; padding:3px 8px; margin:2px; font-size:12px; font-weight:700;">' + r.score + '</span>';
        }
        wrap.innerHTML =
          '<div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; margin-bottom:16px;">' +
            '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:' + npsColor + ';">' + data.npsScore + '</div><div style="font-size:11px; color:#6b7280;">NPS Score</div></div>' +
            '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#22c55e;">' + data.promoters + '</div><div style="font-size:11px; color:#6b7280;">Promoters (9-10)</div></div>' +
            '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#f59e0b;">' + data.passives + '</div><div style="font-size:11px; color:#6b7280;">Passives (7-8)</div></div>' +
            '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#ef4444;">' + data.detractors + '</div><div style="font-size:11px; color:#6b7280;">Detractors (1-6)</div></div>' +
          '</div>' +
          '<div style="font-size:12px; color:#6b7280; margin-bottom:8px;">Avg score: ' + data.avgScore + '/10 | ' + data.totalResponses + ' total responses</div>' +
          '<div style="font-size:11px; color:#4b5563;">Recent scores: ' + recentRows + '</div>';
      } catch { wrap.innerHTML = '<div style="color:#ef4444;">Failed to load NPS data.</div>'; }
    })();

    // ---- PINNED NEXT ACTIONS ----
    (async function loadNextActions() {
      const container = document.getElementById("next-actions-container");
      try {
        const res = await fetch("/api/dashboard/next-actions", { headers: { "x-dashboard-key": DASH_KEY } });
        const data = await res.json();
        if (!data.actions || data.actions.length === 0) {
          container.innerHTML = '<div style="color:#4ade80; text-align:center; padding:20px;">No pending actions — all clients in good shape.</div>';
          return;
        }
        const priorityColors = { urgent: "#ef4444", high: "#f59e0b", medium: "#3b82f6", low: "#6b7280" };
        const priorityLabels = { urgent: "URGENT", high: "HIGH", medium: "MED", low: "LOW" };
        let rows = "";
        for (const a of data.actions.slice(0, 20)) {
          const color = priorityColors[a.priority] || "#6b7280";
          rows += '<tr>' +
            '<td style="padding:8px 12px; border-bottom:1px solid #1f2937;">' +
              '<span style="background:' + color + '; color:#fff; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:800;">' + (priorityLabels[a.priority] || "LOW") + '</span>' +
            '</td>' +
            '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; color:#d1d5db; font-weight:600;">' + a.name + '</td>' +
            '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; color:#9ca3af; font-size:12px;">' + a.action + '</td>' +
            '<td style="padding:8px 12px; border-bottom:1px solid #1f2937;">' +
              '<button onclick="intervene(\'' + a.phone.replace(/'/g, "\\'") + '\',\'checkin\')" style="background:#22c55e; color:#000; border:none; padding:4px 10px; border-radius:4px; font-size:11px; cursor:pointer; font-weight:700;">Nudge</button>' +
            '</td>' +
            '</tr>';
        }
        container.innerHTML =
          '<div style="font-size:12px; color:#6b7280; margin-bottom:8px;">' + data.total + ' actions identified</div>' +
          '<div class="table-wrap"><table style="width:100%; border-collapse:collapse; font-size:13px;">' +
          '<thead><tr>' +
          '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Priority</th>' +
          '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Client</th>' +
          '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;">Action</th>' +
          '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:10px; text-transform:uppercase; border-bottom:2px solid #374151;"></th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>';
      } catch { container.innerHTML = '<div style="color:#ef4444;">Failed to load actions.</div>'; }
    })();

    // ---- COHORT ANALYTICS ----
    (async function loadCohorts() {
      try {
        const res = await fetch("/api/dashboard/cohorts", { headers: { "x-dashboard-key": DASH_KEY } });
        const data = await res.json();
        if (!data.cohorts || data.cohorts.length === 0) {
          document.getElementById("cohortWrap").innerHTML = '<div style="color:#4b5563;">No cohort data yet.</div>';
          return;
        }
        let rows = "";
        for (const c of data.cohorts) {
          const retColor = c.retentionRate >= 60 ? "#22c55e" : c.retentionRate >= 30 ? "#f59e0b" : "#ef4444";
          rows += '<tr>' +
            '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; color:#d1d5db; font-weight:600;">' + c.month + '</td>' +
            '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; text-align:center;">' + c.signups + '</td>' +
            '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; text-align:center; color:#4ade80;">' + c.onboardRate + '%</td>' +
            '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; text-align:center; color:#22c55e;">' + c.payRate + '%</td>' +
            '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; text-align:center; color:' + retColor + ';">' + c.retentionRate + '%</td>' +
            '<td style="padding:8px 12px; border-bottom:1px solid #1f2937; text-align:center; color:#a78bfa;">' + c.avgWorkouts + '</td>' +
            '</tr>';
        }
        document.getElementById("cohortWrap").innerHTML =
          '<div class="table-wrap"><table style="width:100%; border-collapse:collapse; font-size:13px;">' +
          '<thead><tr>' +
          '<th style="padding:10px 12px; text-align:left; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Month</th>' +
          '<th style="padding:10px 12px; text-align:center; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Signups</th>' +
          '<th style="padding:10px 12px; text-align:center; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Onboard %</th>' +
          '<th style="padding:10px 12px; text-align:center; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Pay %</th>' +
          '<th style="padding:10px 12px; text-align:center; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Retention %</th>' +
          '<th style="padding:10px 12px; text-align:center; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Avg Workouts</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>';
      } catch { document.getElementById("cohortWrap").innerHTML = '<div style="color:#ef4444;">Failed to load cohort data.</div>'; }
    })();

    // ---- A/B EXPERIMENTS ----
    function showNewExperiment() { document.getElementById("newExpForm").style.display = "block"; }
    async function createExperiment() {
      const name = document.getElementById("expName").value.trim();
      const messageType = document.getElementById("expType").value;
      const variantA = document.getElementById("expA").value.trim();
      const variantB = document.getElementById("expB").value.trim();
      if (!name || !variantA || !variantB) { alert("Fill in all fields"); return; }
      try {
        await fetch("/api/dashboard/ab/experiments", {
          method: "POST", headers: { "Content-Type": "application/json", "x-dashboard-key": DASH_KEY },
          body: JSON.stringify({ name, variantA, variantB, messageType })
        });
        document.getElementById("newExpForm").style.display = "none";
        loadABExperiments();
      } catch { alert("Error creating experiment"); }
    }
    async function toggleExp(id, newStatus) {
      try {
        await fetch("/api/dashboard/ab/experiments/" + id + "/status", {
          method: "POST", headers: { "Content-Type": "application/json", "x-dashboard-key": DASH_KEY },
          body: JSON.stringify({ status: newStatus })
        });
        loadABExperiments();
      } catch {}
    }
    async function loadABExperiments() {
      const wrap = document.getElementById("abWrap");
      try {
        const res = await fetch("/api/dashboard/ab/experiments", { headers: { "x-dashboard-key": DASH_KEY } });
        const data = await res.json();
        if (!data.experiments || data.experiments.length === 0) {
          wrap.innerHTML = '<div style="color:#4b5563;">No experiments yet. Click "+ New" to start one.</div>';
          return;
        }
        let html = "";
        for (const exp of data.experiments) {
          const statusColor = exp.status === "active" ? "#22c55e" : exp.status === "paused" ? "#f59e0b" : "#6b7280";
          const winnerRate = Math.max(exp.responseRateA, exp.responseRateB);
          const winner = exp.responseRateA > exp.responseRateB ? "A" : exp.responseRateB > exp.responseRateA ? "B" : "—";
          const toggleBtn = exp.status === "active"
            ? '<button onclick="toggleExp(' + exp.id + ',\\'paused\\')" style="background:#f59e0b22; color:#f59e0b; border:1px solid #f59e0b44; border-radius:4px; padding:3px 8px; font-size:10px; cursor:pointer;">Pause</button> <button onclick="toggleExp(' + exp.id + ',\\'completed\\')" style="background:#6b728022; color:#6b7280; border:1px solid #6b728044; border-radius:4px; padding:3px 8px; font-size:10px; cursor:pointer;">Complete</button>'
            : exp.status === "paused"
            ? '<button onclick="toggleExp(' + exp.id + ',\\'active\\')" style="background:#22c55e22; color:#22c55e; border:1px solid #22c55e44; border-radius:4px; padding:3px 8px; font-size:10px; cursor:pointer;">Resume</button>'
            : '';
          html += '<div style="background:#111827; border:1px solid #374151; border-radius:8px; padding:14px; margin-bottom:10px;">' +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">' +
              '<div><span style="font-weight:700; color:#f9fafb; font-size:14px;">' + exp.name + '</span> <span style="font-size:11px; color:#6b7280; margin-left:6px;">' + exp.messageType + '</span></div>' +
              '<div style="display:flex; gap:6px; align-items:center;"><span style="color:' + statusColor + '; font-size:11px; font-weight:700; text-transform:uppercase;">' + exp.status + '</span> ' + toggleBtn + '</div>' +
            '</div>' +
            '<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; font-size:12px;">' +
              '<div style="background:#1f2937; border-radius:6px; padding:10px;">' +
                '<div style="color:#9ca3af; font-size:10px; text-transform:uppercase; margin-bottom:4px;">Variant A (Control)</div>' +
                '<div style="color:#d1d5db; font-size:12px; margin-bottom:6px; max-height:40px; overflow:hidden;">' + exp.variantA.slice(0, 100) + '</div>' +
                '<div style="display:flex; gap:12px;"><span style="color:#38bdf8;">' + exp.statsA.delivered + ' sent</span><span style="color:#22c55e;">' + exp.statsA.responded + ' responded</span><span style="color:#a78bfa; font-weight:700;">' + exp.responseRateA + '%</span></div>' +
              '</div>' +
              '<div style="background:#1f2937; border-radius:6px; padding:10px;">' +
                '<div style="color:#9ca3af; font-size:10px; text-transform:uppercase; margin-bottom:4px;">Variant B (Challenger)</div>' +
                '<div style="color:#d1d5db; font-size:12px; margin-bottom:6px; max-height:40px; overflow:hidden;">' + exp.variantB.slice(0, 100) + '</div>' +
                '<div style="display:flex; gap:12px;"><span style="color:#38bdf8;">' + exp.statsB.delivered + ' sent</span><span style="color:#22c55e;">' + exp.statsB.responded + ' responded</span><span style="color:#a78bfa; font-weight:700;">' + exp.responseRateB + '%</span></div>' +
              '</div>' +
            '</div>' +
            (winner !== "—" ? '<div style="margin-top:8px; text-align:center; font-size:11px; color:#f59e0b;">Leading: Variant ' + winner + ' (' + winnerRate + '% response rate)</div>' : '') +
          '</div>';
        }
        wrap.innerHTML = html;
      } catch { wrap.innerHTML = '<div style="color:#ef4444;">Failed to load experiments.</div>'; }
    }
    loadABExperiments();

    // ---- CLIENT TIMELINE ----
    async function loadTimeline() {
      const phone = document.getElementById("timelinePhone").value.trim();
      if (!phone) return;
      const wrap = document.getElementById("timelineWrap");
      const summary = document.getElementById("timelineSummary");
      const eventsDiv = document.getElementById("timelineEvents");
      wrap.style.display = "block";
      summary.innerHTML = '<div style="color:#9ca3af;">Loading...</div>';
      eventsDiv.innerHTML = "";
      try {
        const res = await fetch("/api/dashboard/timeline/" + encodeURIComponent(phone), { headers: { "x-dashboard-key": DASH_KEY } });
        if (!res.ok) { summary.innerHTML = '<div style="color:#ef4444;">Client not found.</div>'; return; }
        const data = await res.json();
        const c = data.client;
        const s = data.summary;
        const trendColor = s.weightTrend < 0 ? "#22c55e" : s.weightTrend > 0 ? "#ef4444" : "#9ca3af";
        const trendLabel = s.weightTrend < 0 ? s.weightTrend + "kg ↓" : s.weightTrend > 0 ? "+" + s.weightTrend + "kg ↑" : "—";
        summary.innerHTML =
          '<div style="display:flex; flex-wrap:wrap; gap:16px; align-items:center; margin-bottom:12px;">' +
            '<div style="font-size:18px; font-weight:800; color:#f9fafb;">' + (c.name || "Unknown") + '</div>' +
            '<div style="font-size:12px; color:#6b7280;">' + c.phone + '</div>' +
            '<div style="font-size:12px; color:#9ca3af; background:#1f2937; border-radius:4px; padding:2px 8px;">' + (c.goal || "—") + ' · ' + (c.mode || "—") + ' · Week ' + (c.week || 0) + '</div>' +
          '</div>' +
          '<div style="display:grid; grid-template-columns:repeat(5,1fr); gap:12px;">' +
            '<div><div style="font-size:20px; font-weight:800; color:#a78bfa;">' + s.daysOnProgramme + '</div><div style="font-size:11px; color:#6b7280;">Days on programme</div></div>' +
            '<div><div style="font-size:20px; font-weight:800; color:#22c55e;">' + s.workoutsLast30 + '</div><div style="font-size:11px; color:#6b7280;">Workouts (30d)</div></div>' +
            '<div><div style="font-size:20px; font-weight:800; color:#38bdf8;">' + s.avgSteps.toLocaleString() + '</div><div style="font-size:11px; color:#6b7280;">Avg Steps</div></div>' +
            '<div><div style="font-size:20px; font-weight:800; color:' + trendColor + ';">' + trendLabel + '</div><div style="font-size:11px; color:#6b7280;">Weight Trend</div></div>' +
            '<div><div style="font-size:20px; font-weight:800; color:#f59e0b;">' + s.messagesLast30 + '</div><div style="font-size:11px; color:#6b7280;">Messages (30d)</div></div>' +
          '</div>';

        // Events table
        if (data.events.length === 0) {
          eventsDiv.innerHTML = '<div class="card" style="color:#4b5563; text-align:center; padding:20px;">No activity in last 30 days.</div>';
          return;
        }
        const icons = { weight: "⚖️", steps: "🚶", workout: "💪", chat: "💬" };
        const colors = { weight: "#22c55e", steps: "#38bdf8", workout: "#a78bfa", chat: "#9ca3af" };
        let eventRows = "";
        for (const e of data.events.slice(0, 100)) {
          const d = new Date(e.date);
          const dateStr = d.toLocaleDateString("en-ZA", { day:"2-digit", month:"short" }) + " " + d.toLocaleTimeString("en-ZA", { hour:"2-digit", minute:"2-digit" });
          eventRows += '<tr>' +
            '<td style="padding:6px 12px; border-bottom:1px solid #1f2937; color:#6b7280; font-size:12px; white-space:nowrap;">' + dateStr + '</td>' +
            '<td style="padding:6px 12px; border-bottom:1px solid #1f2937; text-align:center;">' + (icons[e.type] || "·") + '</td>' +
            '<td style="padding:6px 12px; border-bottom:1px solid #1f2937; color:' + (colors[e.type] || "#d1d5db") + '; font-size:13px;">' + e.detail + '</td>' +
            '</tr>';
        }
        eventsDiv.innerHTML =
          '<table style="width:100%; border-collapse:collapse;">' +
          '<thead><tr>' +
          '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Date</th>' +
          '<th style="padding:8px 12px; text-align:center; color:#9ca3af; font-size:11px; border-bottom:2px solid #374151;">Type</th>' +
          '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:11px; text-transform:uppercase; border-bottom:2px solid #374151;">Detail</th>' +
          '</tr></thead><tbody>' + eventRows + '</tbody></table>';
      } catch { summary.innerHTML = '<div style="color:#ef4444;">Error loading timeline.</div>'; }
    }
    // ---- KPI METRICS ----
    (async function loadKPIs() {
      const wrap = document.getElementById("kpiWrap");
      try {
        const res = await fetch("/api/dashboard/kpis?days=30", { headers: { "x-dashboard-key": DASH_KEY } });
        const data = await res.json();
        const u = data.users;
        const r = data.rates;
        const a = data.activity;
        wrap.innerHTML =
          '<div class="grid-3" style="margin-bottom:12px;">' +
            '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#22c55e;">' + r.retention + '</div><div style="color:#9ca3af; font-size:11px;">Retention</div></div>' +
            '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#38bdf8;">' + r.engagement + '</div><div style="color:#9ca3af; font-size:11px;">Engagement</div></div>' +
            '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#f59e0b;">' + r.conversion + '</div><div style="color:#9ca3af; font-size:11px;">Conversion</div></div>' +
          '</div>' +
          '<div style="display:grid; grid-template-columns:repeat(4,1fr); gap:8px; font-size:12px; color:#d1d5db;">' +
            '<div>Active: <b style="color:#22c55e;">' + u.active + '</b></div>' +
            '<div>New: <b style="color:#38bdf8;">' + u.new + '</b></div>' +
            '<div>Churned: <b style="color:#ef4444;">' + u.churned + '</b></div>' +
            '<div>Paying: <b style="color:#f59e0b;">' + u.paying + '</b></div>' +
          '</div>' +
          '<div style="margin-top:10px; display:grid; grid-template-columns:repeat(4,1fr); gap:8px; font-size:12px; color:#d1d5db;">' +
            '<div>Messages: <b>' + a.messages + '</b></div>' +
            '<div>Workouts: <b>' + a.workouts + '</b></div>' +
            '<div>Weigh-ins: <b>' + a.weighIns + '</b></div>' +
            '<div>Avg msg/user: <b>' + a.avgMessagesPerUser + '</b></div>' +
          '</div>';
      } catch { wrap.innerHTML = '<div style="color:#ef4444;">Failed to load KPIs.</div>'; }
    })();

    // ---- REVENUE ----
    (async function loadRevenue() {
      const wrap = document.getElementById("revenueWrap");
      try {
        const res = await fetch("/api/dashboard/revenue", { headers: { "x-dashboard-key": DASH_KEY } });
        const data = await res.json();
        const c = data.current;
        const r = data.rates;
        const f = data.forecast;
        wrap.innerHTML =
          '<div class="grid-3" style="margin-bottom:12px;">' +
            '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#22c55e;">' + c.mrr + '</div><div style="color:#9ca3af; font-size:11px;">Monthly Revenue</div></div>' +
            '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#38bdf8;">' + c.arr + '</div><div style="color:#9ca3af; font-size:11px;">Annual Revenue</div></div>' +
            '<div style="text-align:center;"><div style="font-size:28px; font-weight:800; color:#f59e0b;">' + r.estimatedLTV + '</div><div style="color:#9ca3af; font-size:11px;">Est. LTV</div></div>' +
          '</div>' +
          '<div style="display:grid; grid-template-columns:repeat(4,1fr); gap:8px; font-size:12px; color:#d1d5db;">' +
            '<div>Paying: <b style="color:#22c55e;">' + c.payingUsers + '</b></div>' +
            '<div>Trial: <b style="color:#38bdf8;">' + c.trialUsers + '</b></div>' +
            '<div>Cancelled: <b style="color:#ef4444;">' + c.cancelledUsers + '</b></div>' +
            '<div>Conversion: <b style="color:#f59e0b;">' + r.trialConversion + '</b></div>' +
          '</div>' +
          '<div style="margin-top:10px; padding:8px; background:#111827; border-radius:6px; font-size:12px; color:#9ca3af;">' +
            'Forecast: <b style="color:#22c55e;">' + f.projectedMRR + '</b>/mo if ' + f.projectedNewPaying + ' trial users convert' +
          '</div>';
      } catch { wrap.innerHTML = '<div style="color:#ef4444;">Failed to load revenue.</div>'; }
    })();

    // ---- CLIENT SEARCH ----
    let searchTimeout;
    function searchClients() {
      clearTimeout(searchTimeout);
      const q = document.getElementById("clientSearch").value.trim();
      const wrap = document.getElementById("searchResults");
      if (q.length < 2) { wrap.style.display = "none"; return; }
      searchTimeout = setTimeout(async () => {
        try {
          const res = await fetch("/api/dashboard/search?q=" + encodeURIComponent(q), { headers: { "x-dashboard-key": DASH_KEY } });
          const data = await res.json();
          if (!data.results || data.results.length === 0) {
            wrap.style.display = "block";
            wrap.innerHTML = '<div style="color:#4b5563; padding:12px; text-align:center;">No clients found.</div>';
            return;
          }
          let rows = "";
          for (const c of data.results) {
            const lastActive = c.lastActive ? new Date(c.lastActive).toLocaleDateString("en-ZA", { day:"2-digit", month:"short" }) : "Never";
            rows += '<tr style="border-bottom:1px solid #1f2937;">' +
              '<td style="padding:8px 12px; color:#f9fafb; font-weight:600;">' + (c.name || "—") + '</td>' +
              '<td style="padding:8px 12px; color:#9ca3af; font-family:monospace; font-size:12px;">' + (c.phone || "") + '</td>' +
              '<td style="padding:8px 12px; color:#a78bfa;">' + (c.goal || "—") + '</td>' +
              '<td style="padding:8px 12px; color:#6b7280;">' + lastActive + '</td>' +
              '<td style="padding:8px 12px;"><span style="color:' + (c.payment === "active" ? "#22c55e" : "#f59e0b") + '; font-size:11px; font-weight:700;">' + (c.payment || "trial") + '</span></td>' +
            '</tr>';
          }
          wrap.style.display = "block";
          wrap.innerHTML = '<table style="width:100%; border-collapse:collapse;"><thead><tr>' +
            '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:11px; border-bottom:2px solid #374151;">Name</th>' +
            '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:11px; border-bottom:2px solid #374151;">Phone</th>' +
            '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:11px; border-bottom:2px solid #374151;">Goal</th>' +
            '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:11px; border-bottom:2px solid #374151;">Last Active</th>' +
            '<th style="padding:8px 12px; text-align:left; color:#9ca3af; font-size:11px; border-bottom:2px solid #374151;">Payment</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table>';
        } catch { wrap.innerHTML = '<div style="color:#ef4444;">Search failed.</div>'; }
      }, 300);
    }

    // ---- WEEKLY REPORT ----
    async function loadWeeklyReport() {
      const wrap = document.getElementById("weeklyReportWrap");
      wrap.innerHTML = '<div style="color:#9ca3af;">Generating report...</div>';
      try {
        const res = await fetch("/api/dashboard/weekly-report", { headers: { "x-dashboard-key": DASH_KEY } });
        const data = await res.json();
        const s = data.summary;
        let rows = "";
        for (const c of data.clients.slice(0, 50)) {
          const statusColor = c.status === "at_risk" ? "#ef4444" : c.status === "needs_attention" ? "#f59e0b" : "#22c55e";
          const statusLabel = c.status === "at_risk" ? "AT RISK" : c.status === "needs_attention" ? "ATTENTION" : "ON TRACK";
          rows += '<tr style="border-bottom:1px solid #1f2937;">' +
            '<td style="padding:6px 10px; color:#f9fafb; font-weight:500;">' + c.name + '</td>' +
            '<td style="padding:6px 10px;"><span style="background:' + statusColor + '22; color:' + statusColor + '; border-radius:4px; padding:2px 8px; font-size:10px; font-weight:700;">' + statusLabel + '</span></td>' +
            '<td style="padding:6px 10px; color:#d1d5db; font-size:12px; text-align:center;">' + c.weekActivity.messages + '</td>' +
            '<td style="padding:6px 10px; color:#d1d5db; font-size:12px; text-align:center;">' + c.weekActivity.workouts + '</td>' +
            '<td style="padding:6px 10px; color:#d1d5db; font-size:12px;">' + (c.weight.change !== null ? (c.weight.change > 0 ? "+" : "") + c.weight.change + "kg" : "—") + '</td>' +
            '<td style="padding:6px 10px; color:#6b7280; font-size:11px;">' + (c.risks.length > 0 ? c.risks.join(", ") : "none") + '</td>' +
          '</tr>';
        }
        wrap.innerHTML =
          '<div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:16px;">' +
            '<div style="text-align:center;"><div style="font-size:24px; font-weight:800; color:#ef4444;">' + s.atRisk + '</div><div style="color:#9ca3af; font-size:11px;">At Risk</div></div>' +
            '<div style="text-align:center;"><div style="font-size:24px; font-weight:800; color:#f59e0b;">' + s.needsAttention + '</div><div style="color:#9ca3af; font-size:11px;">Needs Attention</div></div>' +
            '<div style="text-align:center;"><div style="font-size:24px; font-weight:800; color:#22c55e;">' + s.onTrack + '</div><div style="color:#9ca3af; font-size:11px;">On Track</div></div>' +
          '</div>' +
          '<table style="width:100%; border-collapse:collapse;"><thead><tr>' +
            '<th style="padding:6px 10px; text-align:left; color:#9ca3af; font-size:10px; border-bottom:2px solid #374151;">Client</th>' +
            '<th style="padding:6px 10px; text-align:left; color:#9ca3af; font-size:10px; border-bottom:2px solid #374151;">Status</th>' +
            '<th style="padding:6px 10px; text-align:center; color:#9ca3af; font-size:10px; border-bottom:2px solid #374151;">Msgs</th>' +
            '<th style="padding:6px 10px; text-align:center; color:#9ca3af; font-size:10px; border-bottom:2px solid #374151;">Workouts</th>' +
            '<th style="padding:6px 10px; text-align:left; color:#9ca3af; font-size:10px; border-bottom:2px solid #374151;">Weight</th>' +
            '<th style="padding:6px 10px; text-align:left; color:#9ca3af; font-size:10px; border-bottom:2px solid #374151;">Risks</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table>';
      } catch { wrap.innerHTML = '<div style="color:#ef4444;">Failed to generate report.</div>'; }
    }
  </script>
</body>
</html>`;

      res.send(html);
    } catch (err) {
      res.status(500).send("Dashboard error: " + err);
    }
  });
}

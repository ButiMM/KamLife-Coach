import { type Express } from "express";
import { type Server } from "http";
import crypto from "crypto";
import path from "path";
import { db, pool } from "./db";
import { users, weightLogs, workoutLogs, stepLogs, chatHistory, clothingCheckins, bodyMeasurements, weeklyCheckins, exerciseLogs, progressPhotos, escalations, abAssignments, mealLogs } from "../shared/schema";
import { eq, desc, asc, and, gte, lt, sql, count } from "drizzle-orm";
import OpenAI from "openai";
import { tmpdir } from "os";
import { writeFile, unlink } from "fs/promises";
import { createReadStream } from "fs";
import { join as pathJoin } from "path";
import twilio from "twilio";
import { SA_FOODS_SEED, type SAFood } from "./foods";
import { COACH_K_SYSTEM } from "./coach-prompt";
import { EQUIPMENT_ALTERNATIVES, FOOD_SUBSTITUTIONS, PORTION_GUIDE, STORE_ADVICE, INJURY_MODIFICATIONS, SUPPLEMENT_GUIDE, detectLanguage, type SALanguage } from "./constants";
import { buildDayWorkout, buildDayWorkoutForType, buildFullProgramme, getKamlifeProgramme, WORKOUT_DONE_RESPONSES, getDayType, buildDay1Workout, buildDay2Workout, buildDay3Workout } from "./programme";
import { askCoachK, selectModel, buildPatternSummary, getSAContextFlags, isUnderGPTCallLimit, selectVisionModel, estimateVisionCostUSD, gptFoodFallback, classifyIntent, type ClassifiedIntent } from "./gpt";
import { calculateTargets } from "./targets";
import { handleOnboarding, getMenuText, getOnboardingMealPlan } from "./onboarding";
import { getShoppingList, formatShoppingList } from "./shopping-lists";
import { nutritionAgent, programmingAgent, mindsetAgent, adminAgent, routeToAgent } from "./agents";
import { storeMemory, retrieveMemories } from "./memory";
import { generateVoiceNote, getVoiceFilePath, voiceFileExists } from "./tts";
import { sendWhatsApp } from "./scheduler";
import { recordConversion } from "./ab";
import { getStepStreak, getStepResponse as _getStepResponse } from "./handlers/steps";
import { getSleepResponse } from "./handlers/sleep";
import { JUNK_WORDS as _JUNK_WORDS, checkFoodPatterns, getDamageControlNote, getProgressiveOverloadContext, checkPerfectDay } from "./handlers/checks";
import { scanForSAFoods, parseFoodLogTotalsFromMessageOut, sanitizeCoachReply, escapeRegex, recomputeTodayFoodTotals } from "./handlers/food-scanner";
import { logChat, logMediaFailure, logMediaSuccess, buildMediaTrace, withTimeout } from "./handlers/chat-log";
import { handleWeightLog } from "./handlers/weight";
import { getDisplayName, checkGptRateLimit, sastDayStart } from "./utils";

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



// detectEscalation + escalationSLA now live in ./safety-detection for unit testing




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




const getStepResponse = _getStepResponse;

// ============================================================
// FOOD PATTERN DETECTION
// ============================================================

const JUNK_WORDS = _JUNK_WORDS;

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

// Onboarding functions moved to ./onboarding (see imports above)

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================

async function handleMessage(phone: string, message: string, mediaUrl?: string, mediaContentType?: string, allMediaUrls?: string[]): Promise<string> {
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
        await tx.delete(mealLogs).where(eq(mealLogs.userId, uid));
        await tx.delete(progressPhotos).where(eq(progressPhotos.userId, uid));
        await tx.delete(escalations).where(eq(escalations.userId, uid));
        // Nullify PII and anonymize phone number — row kept for compliance audit trail only
        await tx.update(users).set({
          phoneNumber: `[deleted-${uid}]`,
          name: null,
          onboardingState: null,
          popiConsent: false,
          awaitingInputType: null,
          currentWeight: null,
          heightCm: null,
          age: null,
          gender: null,
          medicalConditions: null,
          injuries: null,
          otherMedicalNotes: null,
          profileNotes: null,
          lastActiveAt: null,
          cancelledAt: new Date(),
        }).where(eq(users.id, uid));
      });
      // Delete vector memory embeddings (pgvector) — outside transaction as it's a raw query
      try {
        await pool.query("DELETE FROM memories WHERE phone = $1", [phone]);
        console.log(`[POPIA DELETE] Vector memories cleared for ${phone}`);
      } catch (memErr: any) {
        console.warn(`[POPIA DELETE] Vector memory deletion failed (non-fatal): ${memErr.message}`);
      }
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

  // ---- INTENT CLASSIFIER — structural reset plan item #2 ----
  // Fire early as a background Promise. Text messages only (not photo/voice).
  // Awaited just before the final GPT routing (line ~6590) — by then it's complete.
  // On any error, returns { intent: "OTHER", confidence: 0 } — never blocks.
  const intentPromise: Promise<{ intent: ClassifiedIntent; confidence: number }> =
    (!mediaUrl && message.length >= 2 && message.length <= 500)
      ? classifyIntent(message, user.id).catch((e) => { console.error("[INTENT_CLASSIFY]", e?.message || e); return { intent: "OTHER" as ClassifiedIntent, confidence: 0 }; })
      : Promise.resolve({ intent: "OTHER" as ClassifiedIntent, confidence: 0 });

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

  // ---- COACH / OWNER BYPASS — never paywall the coach's own number ----
  // Checks COACH_ALERT_PHONE and ADMIN_PHONE_OVERRIDE (either env var works)
  const coachPhone = (process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE || "").replace(/\D/g, "");
  const userPhone = phone.replace(/^whatsapp:/, "").replace(/\D/g, "");
  const isCoach = coachPhone && userPhone === coachPhone;
  if (isCoach && (user.subscriptionStatus === "inactive" || user.subscriptionStatus === "trial")) {
    await db.update(users).set({ subscriptionStatus: "active" }).where(eq(users.phoneNumber, phone));
    user.subscriptionStatus = "active";
  }

  // ---- TRIAL EXPIRY CHECK — convert expired trials to inactive with a clear message ----
  if (user.subscriptionStatus === "trial") {
    const trialEnd = user.betaBypassUntil ? new Date(user.betaBypassUntil) : null;
    if (trialEnd && trialEnd < new Date()) {
      // Trial expired — convert to inactive and tell the user
      await db.update(users).set({ subscriptionStatus: "inactive", betaBypassUntil: null }).where(eq(users.phoneNumber, phone));
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

  // ---- SUBSCRIPTION GATE — inactive users get free basic tier, premium features gated ----
  // FREE (always available): food logging, step tracking, water, weight, basic Q&A, meal diary
  // PREMIUM (requires subscription): workout programmes, shopping lists, full coaching, meal plans
  // isCoach always bypasses the gate — their account is also healed in the DB above
  if (user.subscriptionStatus === 'inactive' && !isCoach) {
    const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
    const merchantId = process.env.PAYFAST_MERCHANT_ID;
    const cleanPhone = phone.replace(/^whatsapp:/, "").replace(/\D/g, "");
    const payLink = merchantId ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}` : appUrl;
    const name = user.name?.split(" ")[0] || "there";

    // Premium features that need subscription
    const isPremiumRequest =
      /\b(workout|programme|program|training plan|gym plan|my plan|day 1|day 2|day 3|shopping list|shop|meal plan|full coaching|next session|lift|sets|reps)\b/i.test(m) &&
      !/\b(food|eat|ate|had|log|steps|walked|weight|water|calories|protein|diary|my meals|remove|delete)\b/i.test(m);

    if (isPremiumRequest) {
      const workouts = user.totalWorkoutsCompleted || 0;
      const gateReply = workouts === 0
        ? `Your programme is built, ${name} — subscribe to unlock it.\n\nFood tracking is free forever. Workouts, shopping lists, and full coaching are *R149/month — cancel anytime.*\n\n${payLink}\n\n_POPIA protected. Data never sold. Cancel by replying *cancel*._`
        : `${name}, reactivate to get your workouts, shopping lists, and full coaching back.\n\n*R149/month — cancel anytime:* ${payLink}\n\nFood tracking and steps stay free. Data saved for 90 days.`;
      await logChat(user.id, message, gateReply, "SUBSCRIPTION_GATE");
      return gateReply;
    }

    // Crisis and safety always bypass
    const isSafety = /\b(chest pain|can.?t breathe|emergency|hospital|ambulance|crisis|suicid|hurt myself)\b/i.test(m);
    if (isSafety) {
      // Fall through to crisis handler above
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
      const severeReply = await withTimeout("gpt_severe", 20000, () => askCoachK(message, user, severeCtx));
      await logChat(user.id, message, severeReply, "SEVERE_FRUSTRATION");
      return severeReply;
    } catch (e) {
      const fallback = `${namePrefix}I hear you — that wasn't good enough. Your calorie target is ${user.calorieTarget || 1800} kcal and protein target is ${user.proteinTarget || 120}g today. Log what you eat and I will track it accurately. Nothing else.`;
      await logChat(user.id, message, fallback, "SEVERE_FRUSTRATION");
      return fallback;
    }
  }

  // ---- A/B CONVERSION ATTRIBUTION — fire-and-forget, never blocks message handling ----
  // Any inbound message from an onboarded user that reaches this point counts as a
  // "response" to the most recent unresponded A/B delivery within 24h.
  // action = most likely intent (best-effort based on message text — not routed yet).
  if (user.id) {
    const abAction = /\b(ate|had|food|meal|breakfast|lunch|dinner)\b/i.test(m) ? "food_logged"
      : /\b(done|finished|workout|session|trained|gym)\b/i.test(m) ? "workout_done"
      : /\b(steps?|walked|walking)\b/i.test(m) ? "steps_logged"
      : "replied";
    recordConversion(user.id, abAction).catch(() => {/* non-fatal */});
  }

  // ---- RESET CALORIES — "reset my calories", "clear food log", "remove meals today" ----
  if (/\b(reset.*calori|clear.*food|clear.*log|clear.*calori|start.*fresh|reset.*food|reset.*log|undo.*last.*meal|delete.*last.*meal|remove.*last.*meal|wipe.*food|wipe.*log|clear.*today|remove.*meals?\s*today|delete.*meals?\s*today|remove.*today.*meals?|clear.*meals?\s*today)\b/i.test(m)) {
    await db.update(users).set({ todayCalories: 0, todayProteinG: 0, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
    const todayStart = sastDayStart();
    // Delete from both mealLogs (primary) and chatHistory (legacy)
    await Promise.all([
      db.delete(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart))).catch(e => console.warn("[non-fatal] clear meal_logs:", e)),
      db.delete(chatHistory).where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart))).catch(e => console.warn("[non-fatal] clear chat food log:", e)),
    ]);
    return `Food log cleared for today. ✅\n\nAll entries wiped — counter is at 0. Start fresh: tell me what you ate.`;
  }

  // ---- REMOVE LAST LOGGED MEAL — quick correction command ----
  if (/^(no\s+)?(remove|delete|undo)\s+(it|that meal|that one|that|last|last one|last meal|the meal|the last one)$/i.test(m.trim()) || /^(remove|delete|undo)$/i.test(m.trim())) {
    const todayStart = sastDayStart();

    // Primary: delete most recent mealLogs row
    const lastMealLog = await db.select({ id: mealLogs.id })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart)))
      .orderBy(desc(mealLogs.loggedAt))
      .limit(1);

    if (lastMealLog.length > 0) {
      await db.delete(mealLogs).where(eq(mealLogs.id, lastMealLog[0].id));
    } else {
      // Legacy fallback: mark chatHistory entry corrected
      const lastFoodLog = await db.select({ id: chatHistory.id })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)))
        .orderBy(desc(chatHistory.createdAt))
        .limit(1);
      if (lastFoodLog.length === 0) return `No meal logged yet today to remove.`;
      await db.update(chatHistory).set({ intent: "FOOD_LOG_CORRECTED" }).where(eq(chatHistory.id, lastFoodLog[0].id));
    }

    const recomputed = await recomputeTodayFoodTotals(user.id);
    await db.update(users).set({
      todayCalories: recomputed.calories,
      todayProteinG: recomputed.protein,
      todayCaloriesDate: sastToday(),
    }).where(eq(users.id, user.id));

    return `Removed your last meal log. ✅\n\nUpdated total today: ~${recomputed.calories} kcal | ~${recomputed.protein}g protein.`;
  }

  // ---- REMOVE SPECIFIC FOOD FROM LOG — "remove the viennas", "I didn't have the eggs" ----
  // Catches: "remove viennas", "didn't have eggs", "take out the bread", "no viennas in my log"
  const removeSpecificMatch = m.match(/\b(?:remove|delete|take out|didn.?t have|did not have|i didn.?t eat|i did not eat|no )\s+(the\s+)?(.{2,30}?)(?:\s+from|\s+in\s+my|\s+log|$)/i);
  const isRemoveSpecific = !!removeSpecificMatch && !/(last|that|it|this|meal|log)$/.test((removeSpecificMatch[2] || "").trim());
  if (isRemoveSpecific && removeSpecificMatch) {
    const foodToRemove = removeSpecificMatch[2].trim().toLowerCase().replace(/\s+(from|in|my|log|today|this).*$/, "");
    if (foodToRemove.length >= 2) {
      try {
        const todayStart = sastDayStart();

        // Primary: search mealLogs table (SA scanner + GPT fallback + photo logs all write here)
        const mealLogRows = await db.select({
          id: mealLogs.id,
          rawMessage: mealLogs.rawMessage,
          items: mealLogs.items,
        }).from(mealLogs)
          .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart)))
          .orderBy(desc(mealLogs.loggedAt))
          .limit(15);

        const targetMealLog = mealLogRows.find(l => {
          if ((l.rawMessage || "").toLowerCase().includes(foodToRemove)) return true;
          const logItems = l.items as Array<{ name?: string; foodName?: string }> | null;
          return Array.isArray(logItems) && logItems.some(i =>
            (i.name || i.foodName || "").toLowerCase().includes(foodToRemove)
          );
        });

        if (targetMealLog) {
          await db.delete(mealLogs).where(eq(mealLogs.id, targetMealLog.id));
          const recomputed = await recomputeTodayFoodTotals(user.id);
          await db.update(users).set({
            todayCalories: recomputed.calories,
            todayProteinG: recomputed.protein,
            todayCaloriesDate: sastToday(),
          }).where(eq(users.id, user.id));
          return `Removed ${foodToRemove} from your log. ✅\n\nUpdated total today: ~${recomputed.calories} kcal | ~${recomputed.protein}g protein.\n\nRemaining: ~${(user.calorieTarget || 1800) - recomputed.calories} kcal | ~${(user.proteinTarget || 120) - recomputed.protein}g protein still to go.`;
        }

        // Fallback: search legacy chatHistory logs
        const todayLogs = await db.select({ id: chatHistory.id, messageIn: chatHistory.messageIn })
          .from(chatHistory)
          .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)))
          .orderBy(desc(chatHistory.createdAt))
          .limit(15);

        const targetLog = todayLogs.find(l => (l.messageIn || "").toLowerCase().includes(foodToRemove));
        if (!targetLog) {
          return `I don't see "${foodToRemove}" in today's food log. Send "my meals" to see what's logged.`;
        }

        const updatedMsg = (targetLog.messageIn || "")
          .replace(new RegExp(`\\b${foodToRemove.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "gi"), "")
          .replace(/,\s*,/g, ",").replace(/^,\s*|,\s*$/g, "").replace(/\s{2,}/g, " ").trim();

        if (!updatedMsg || updatedMsg.length < 3) {
          await db.update(chatHistory).set({ intent: "FOOD_LOG_CORRECTED" }).where(eq(chatHistory.id, targetLog.id));
        } else {
          await db.update(chatHistory).set({ messageIn: updatedMsg }).where(eq(chatHistory.id, targetLog.id));
        }

        const recomputed = await recomputeTodayFoodTotals(user.id);
        await db.update(users).set({
          todayCalories: recomputed.calories,
          todayProteinG: recomputed.protein,
          todayCaloriesDate: sastToday(),
        }).where(eq(users.id, user.id));

        return `Removed ${foodToRemove} from your log. ✅\n\nUpdated total today: ~${recomputed.calories} kcal | ~${recomputed.protein}g protein.\n\nRemaining: ~${(user.calorieTarget || 1800) - recomputed.calories} kcal | ~${(user.proteinTarget || 120) - recomputed.protein}g protein still to go.`;
      } catch (removeErr) {
        console.error("[REMOVE_FOOD]", removeErr);
        return `Could not update your log right now. Try "remove last meal" or send "my meals" to see what's logged.`;
      }
    }
  }

  // ---- SHOW TODAY'S MEAL LOG — transparency for trust ----
  if (/^(show|see|view)\s+(my\s+)?(meal|food)\s+log$|^(meal|food)\s+log$|^what\s+did\s+i\s+log(\s+today)?$/i.test(m.trim())) {
    const todayStart = sastDayStart();
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
    // Always recompute from mealLogs (primary) — covers quick_relog, GPT logs, scanner logs
    const totals = await recomputeTodayFoodTotals(user.id);
    const todayCals = totals.calories;
    const todayProt = totals.protein;
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

  // Guard: "had a streak wrap and fries" is a food log — user typo'd "steak" as "streak".
  // Only fire the workout-streak report when the message looks like a genuine progress
  // question (no food-log trigger words, no SA-food matches). The morning after a
  // braai a lot of people will type "steak and pap" — must not be intercepted here.
  const mentionsStreakWord = /\b(streak|my streak|workout streak|current streak|consistency)\b/i.test(m);
  const looksLikeFoodLogMsg = /\b(had|ate|eaten|eating|having|for\s+(breakfast|lunch|dinner|supper|snack)|wrap|fries|burger|chips|bun)\b/i.test(m)
    || scanForSAFoods(m).length > 0;
  if (mentionsStreakWord && !looksLikeFoodLogMsg) {
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
    if (/\b(dumbbell|dumbbells|db only|no barbell|no cables|basic gym|planet fitness|virgin active basic|machines only|only machines|no free weights|gym machines|cables only|small gym)\b/i.test(lower)) trainingMode = "gym_dumbbell";
    else if (/\bgym\b/i.test(lower) || /\bat gym\b/i.test(lower) || /\bthe gym\b/i.test(lower) || /\bvirgin active\b/i.test(lower) || /\bplanet fitness\b/i.test(lower) || /\blifestyle\b/i.test(lower)) trainingMode = "gym";
    else if (/\bhome\b/i.test(lower) || /\bat home\b/i.test(lower) || /\bno gym\b/i.test(lower) || /\bno equipment\b/i.test(lower) || /\bbodyweight\b/i.test(lower)) trainingMode = "home";

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

    // Day 1 progress photo challenge — fires immediately after programme delivery.
    // Don't wait for the 10am cron. The user is engaged RIGHT NOW and more likely
    // to send a photo when they're still in the setup flow than hours later.
    // 3-second delay so the programme message lands first, then the follow-up.
    setTimeout(async () => {
      try {
        await sendWhatsApp(phone,
          `One more thing — *send me a before photo right now.*\n\nFront-facing, in fitted clothes or underwear. Good lighting. This is your Day 0 progress shot.\n\nIn 4 weeks I will compare it to your new photo and show you the exact difference. Without today's photo, we have nothing to compare later.\n\n*Send it now before you forget.*`
        );
        await logChat(user.id, "[auto]", "[Day 0 photo challenge sent]", "PHOTO_CHALLENGE_PROMPT");
      } catch { /* non-fatal */ }
    }, 3_000);

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
    const adjustReply = await withTimeout("gpt_adjust", 20000, () => askCoachK(message, user,
      `The client just sent you their personal shopping/grocery list. Analyze it as Coach K. Be specific and SA-focused:\n\n1. What's GOOD about their list (acknowledge what they're doing right)\n2. What's MISSING for their ${goal} goal (especially protein sources — they need ${pTarget}g/day)\n3. What to SWAP (not remove — replace with a better option at similar price)\n4. What to REMOVE (only if genuinely harmful to their goal)\n5. End with a specific weekly total estimate in ZAR\n\nKeep it direct, no fluff. Use SA product names and prices. Max 4 bullet points per section. Their calorie target is ${cTarget} kcal/day.`
    ));
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
    const gptRestaurant = await withTimeout("gpt_restaurant", 20000, () => askCoachK(message, user,
      `Client is asking what to eat at ${restaurant}. Give a SA-focused restaurant guide:\n- Best option (calories + protein)\n- Decent option\n- What to avoid\n- One pro tip\nTheir goal is ${goal}, protein target ${pTarget}g/day, calorie target ${cTarget}/day. Max 6 lines. Be specific about menu items.`
    ));
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
    const gptSwap = await withTimeout("gpt_swap", 20000, () => askCoachK(message, user,
      `Client doesn't want ${foodName} (${category}). Suggest 3-4 SA alternatives in the same category at a ${budget} budget. Include calories and protein per portion. Their goal is ${goal}. Be specific.`
    ));
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
      const todayStart = sastDayStart();
      const todaySuppLogs = await db.select({ id: chatHistory.id }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "SUPPLEMENT_LOG"), gte(chatHistory.createdAt, todayStart)));
      const suppStreakLine = todaySuppLogs.length >= 2 ? ` Day ${todaySuppLogs.length} in a row — that's the habit.` : "";
      return `Taken ✅${suppStreakLine}\n\nSame time every day beats the perfect supplement stack. Set a phone alarm and make it automatic.`;
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

  // ============================================================
  // SA LIFE EVENTS — load shedding, illness, month-end, funerals
  // These must fire before the main routing so clients feel heard,
  // not handed a workout programme when they've just had a hard day.
  // ============================================================
  const capName = user.name?.split(" ")[0] || "there";
  const daysSilent = user.lastActiveAt
    ? Math.floor((Date.now() - new Date(user.lastActiveAt).getTime()) / 86_400_000)
    : 0;
  const isReturning = daysSilent >= 2;

  // ---- LOAD SHEDDING ----
  const isLoadShedding = /\b(load.?shed|loadshed|eskom|no.?electricity|no.?power|stage\s*[1-8]|power.?cut|power.?out|blackout|no.?lights|lights.?out|inverter.?dead|battery.?dead|no.?signal.*load|generator.*off)\b/i.test(m);
  if (isLoadShedding) {
    const lsReply = `${capName}, load shedding is real — it messes with routines, meals, and everything else. No blame.\n\nHere's what you can still do with zero power:\n- Home workout: 3 rounds of 15 squats, 10 push-ups, 20 jumping jacks, 30-sec plank. No equipment, no electricity needed.\n- Eating: cold food counts. Bread + peanut butter, fruit, biltong, yoghurt if still cold — log it.\n- Steps: even 20 minutes walking outside counts. Send me the count when you're back.\n\nWhen power's back, pick up where you left off. One missed session never killed progress — giving up does.`;
    await logChat(user.id, message, lsReply, "LOAD_SHEDDING");
    return lsReply;
  }

  // ---- SICK / ILL ----
  const isSick = /\b(sick|ill|flu|flue|flu.?like|fever|vomit|nausea|nauseous|throwing up|stomach bug|food poison|covid|covid.?19|not well|not feeling well|feeling sick|feeling ill|feel sick|feel ill|i.?m sick|i.?m ill|under the weather|hospital|doctor.?s|clinic|bed rest|resting|body aches|headache.*bad|migraine|tonsil|sore throat|chest.*tight|can.?t breathe|difficulty breathing)\b/i.test(m)
    && !/\b(used to be sick|was sick last week|recovered|feeling better now|back to normal|got better|all better)\b/i.test(m);
  if (isSick) {
    const sickReply = `${capName}, *no training.* Full stop.\n\nWhen you're sick, rest IS the training. Pushing through flu or fever does not build discipline — it extends illness and can cause serious damage (myocarditis is real). Your body needs all its energy to fight, not to lift.\n\n*What to do right now:*\n• Sleep as much as you can\n• Drink water, juice, or soup — dehydration makes everything worse\n• Eat small: pap, eggs, toast, yoghurt — whatever you can stomach\n• No steps target, no calorie pressure today\n\nWhen you're feeling better — not just "okay", properly better — message me and we pick up exactly where you left off. Programme and targets are saved. Rest well ${capName}.`;
    await logChat(user.id, message, sickReply, "SICK_DAY");
    return sickReply;
  }

  // ---- FUNERAL / BEREAVEMENT ----
  const isBereaved = /\b(funeral|passed away|someone.*died|died.*someone|lost.*loved one|loved one.*lost|in mourning|family.*death|death.*family|my (mom|dad|mother|father|brother|sister|uncle|aunt|gogo|ouma|oupa|gran|grandma|grandfather|grandmother|friend).*died|died.*(mom|dad|mother|father|brother|sister|uncle|aunt|gran)|umngcwabo|ukufa|silahlekelwe)\b/i.test(m);
  if (isBereaved) {
    const bereavReply = `${capName}, I'm sorry for your loss. Take all the time you need — the programme will wait.\n\nFunerals mean long days, different food, no routine. That's okay. Eat what's there, stay hydrated, walk if you can. Don't stress about the plan right now.\n\nWhen you're ready to come back — even if it's weeks from now — just message me and I'll reset your programme from that day. There's no guilt here. Rest, mourn, be with your family.`;
    await logChat(user.id, message, bereavReply, "BEREAVEMENT");
    return bereavReply;
  }

  // ---- MONTH-END / FINANCIAL STRESS ----
  const isMonthEnd = /\b(month.?end|end of month|no.?money|broke|short on cash|can.?t afford|salary.?not|waiting for.?(salary|pay|payday)|payday.*friday|payday.*next|no.?budget|empty|flat.?broke|nothing (left|to eat)|no.?food|can.?t buy|no.?groceries|no.?airtime|airtime.?finished)\b/i.test(m);
  if (isMonthEnd) {
    const meReply = `${capName}, month-end is tough for everyone in SA. No shame in it.\n\nHere's how to keep it going on zero budget:\n- *Protein:* eggs (cheapest protein there is), pilchards, beans, lentils\n- *Carbs:* pap, brown bread, oats, rice, sweet potato\n- *Vegetables:* cabbage, spinach, frozen veg — all cheap and good\n\nType *cheap meals* and I'll send you a full day of eating under R30. Fitness doesn't stop when the money runs out — your body still needs fuel to change.`;
    await logChat(user.id, message, meReply, "MONTH_END");
    return meReply;
  }

  // ---- COMEBACK AFTER SILENCE (2+ days) ----
  // Detect when a client returns with an excuse/explanation after going quiet.
  // Respond with empathy and a clean restart plan — not a workout delivered cold.
  const isComeback = isReturning && (
    /\b(i.?m back|i am back|back now|returning|i.?m here|i.?ve been|been (busy|away|sick|off|struggling|stressed)|sorry (i|for|about)|haven.?t been|couldn.?t|wasn.?t able|let me start|can we start|starting again|picking up|back on track|back to it|resuming|reset|fresh start|new week|new day|starting fresh|been (a|so) (long|while)|miss(ed)? (a|this|it)|been MIA|went quiet|disappeared|fell off)\b/i.test(m)
    || m.length < 30 // short message after silence = returning check-in
  );

  if (isComeback) {
    const daysText = daysSilent === 2 ? "2 days" : daysSilent <= 7 ? `${daysSilent} days` : daysSilent <= 14 ? "a week" : "a while";
    const comingBackReply = `${capName}, welcome back. ${daysText} away — everyone has those stretches.\n\nWe don't restart from zero. Your programme, targets, and logs are all still here. Today is just Day 1 of the next streak.\n\n*Here's what to do right now:*\n1. Tell me what you ate today (even if it wasn't perfect)\n2. Log your steps if you walked\n3. Reply *menu* for today's workout\n\nNo catching up. No guilt. Just today. Let's go.`;
    await logChat(user.id, message, comingBackReply, "COMEBACK");
    return comingBackReply;
  }

  // ---- MEDIA: IMAGE or AUDIO — exclusive branches, always return ----
  if (mediaUrl) {
    const ctype = mediaContentType || "";
    const mediaTrace = buildMediaTrace(phone, ctype);
    const mediaFlowStart = Date.now();
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
        const imgDownloadStart = Date.now();
        const imageResponse = await withTimeout("image_download", 12000, () => fetch(mediaUrl, {
          headers: { Authorization: imgAuthHeader },
        }));
        if (!imageResponse.ok) {
          const dlMs = Date.now() - imgDownloadStart;
          console.error(`[MEDIA][${mediaTrace}] image_download_failed status=${imageResponse.status} ms=${dlMs}`);
          await logMediaFailure(user.id, "image_download", `${imageResponse.status}`, dlMs);
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
        const imgDownloadMs = Date.now() - imgDownloadStart;
        console.log(`[MEDIA][${mediaTrace}] image_download_ok bytes=${buffer.byteLength} ms=${imgDownloadMs}`);
        const base64 = Buffer.from(buffer).toString("base64");
        const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
        const clientName = user.name || "there";
        const goal = user.goalType || "fat_loss";

        // ---- STEP SCREENSHOT DETECTION ----
        // Triggered ONLY by explicit keywords or awaiting state.
        // Historical bug: uncaptioned images were defaulting to step OCR, causing
        // gym selfies to be mis-reported as failed step screenshots.
        const noCaption = !message || message.trim().length === 0;
        let isStepScreenshot = /\b(steps?|pedometer|walked|walking|step count|staps?|my walk|fitness app|samsung health|google fit|apple health|health app|screenshot)\b/i.test(message)
          || (user.awaitingInputType === "steps");

        // ---- UNCAPTIONED IMAGE PRE-CLASSIFIER ----
        // For captionless images, a tiny vision call decides: food / steps /
        // exercise / progress / other. Prevents the old "everything is a step
        // screenshot" default. Failure is non-fatal — falls through to food vision.
        let uncaptionedType: "food" | "steps" | "exercise" | "progress" | "other" | null = null;
        if (noCaption && !isStepScreenshot) {
          try {
            const classifyResp = await withTimeout("image_classify", 8000, () => openai.chat.completions.create({
              model: "gpt-4o-mini",
              max_tokens: 8,
              temperature: 0,
              messages: [
                { role: "system", content: "Classify a WhatsApp photo sent to a fitness coach. Reply with ONE word only, lowercase: food | steps | exercise | progress | other.\n- food: plate of food, drink, snack, meal\n- steps: screenshot showing a step count or pedometer reading\n- exercise: person actively performing an exercise movement (mid-squat, lifting, running)\n- progress: person standing/posing still to show body shape — front, side or back pose, even if wearing gym clothes. Before/after transformation photos. Multiple people posing.\n- other: none of the above\nIMPORTANT: If a person is POSING or STANDING STILL (not mid-movement), classify as progress, not exercise." },
                { role: "user", content: [
                  { type: "text", text: "What is this photo?" },
                  { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } },
                ] },
              ],
            }));
            const raw = (classifyResp.choices[0]?.message?.content || "").trim().toLowerCase();
            if (raw.includes("food")) uncaptionedType = "food";
            else if (raw.includes("steps") || raw.includes("step")) uncaptionedType = "steps";
            else if (raw.includes("exercise")) uncaptionedType = "exercise";
            else if (raw.includes("progress")) uncaptionedType = "progress";
            else uncaptionedType = "other";
            console.log(`[MEDIA][${mediaTrace}] uncaptioned_classified=${uncaptionedType}`);
            if (uncaptionedType === "steps") isStepScreenshot = true;
            if (uncaptionedType === "exercise") {
              const exReply = `${user.name || "Sharp"} — I can see that's a gym / exercise photo, but I cannot give form feedback from a still shot taken mid-set.\n\nFor form coaching: send a clear photo from the side showing the bottom of the movement (e.g. deepest point of squat, bar touching chest on bench). Or tell me the exercise and what feels off.\n\nIf you were trying to log a workout, reply *done* — I will log today's session.`;
              await logChat(user.id, "[Exercise Photo]", exReply, "EXERCISE_PHOTO");
              return exReply;
            }
          } catch (e) {
            console.warn(`[MEDIA][${mediaTrace}] uncaptioned_classify_failed:`, e);
            // fall through — food vision is a reasonable default
          }
        }
        if (isStepScreenshot) {
          try {
            const stepVisionResponse = await withTimeout("step_vision", 18000, () => openai.chat.completions.create({
              model: "gpt-4o-mini",
              max_tokens: 50,
              messages: [
                { role: "system", content: "You verify and extract step counts from screenshots of pedometer/fitness apps (Samsung Health, Google Fit, Apple Health, Fitbit, Huawei Health, Garmin, etc). The number MUST be visibly labelled as steps in the image (next to the word 'steps', a footprint icon, or inside a clearly identified steps card). Distance (km), calories, heart rate, dates, phone numbers, prices, times, or any other number — DO NOT extract. If no step count is clearly labelled, reply NOT_STEPS. Otherwise reply with ONLY the step number, no other text." },
                { role: "user", content: [
                  { type: "text", text: "Extract the labelled step count from this screenshot, or reply NOT_STEPS." },
                  { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } },
                ] },
              ],
            }));
            const stepText = stepVisionResponse.choices[0]?.message?.content?.trim() || "UNKNOWN";
            // Vision model explicitly rejected — don't try to extract a number from "NOT_STEPS"
            const visionRejected = /\b(NOT_STEPS|UNKNOWN)\b/i.test(stepText);
            const extractedSteps = visionRejected ? NaN : parseInt(stepText.replace(/[^0-9]/g, ""));
            // Guard against random OCR numbers from food labels/photos:
            // accept low numbers only when user explicitly indicated steps.
            const explicitStepIntent = /\b(steps?|pedometer|walk|walking|step count|screenshot)\b/i.test(message) || (user.awaitingInputType === "steps");
            // Realistic range: 100–60,000 steps/day. 60k = ~45km walking, hard upper bound for a real human day.
            const looksLikeStepCount = extractedSteps >= 500 && extractedSteps <= 60000;
            const acceptableLowCount = explicitStepIntent && extractedSteps >= 100 && extractedSteps < 500;
            if (!visionRejected && !isNaN(extractedSteps) && (looksLikeStepCount || acceptableLowCount)) {
              const target = user.stepsTarget || 10000;
              const todayStartSteps = sastDayStart();
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
              const stepReply = getStepResponse(extractedSteps, target, parseFloat(user.currentWeight as string || "75") || 75);
              const [perfectDay, streak] = await Promise.all([checkPerfectDay(user.id, user.proteinTarget || 130), getStepStreak(user.id)]);
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
        // Triggers when: classifier says "progress", OR message has progress keywords with
        // no contradicting classification. Classifier alone is sufficient — no caption needed.
        const isProgressPhoto = uncaptionedType === "progress"
          || (
            /\b(progress|transformation|check.?in|monthly|before|after|month \d|week \d+)\b/i.test(message)
            && uncaptionedType === null
          );
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

          await logChat(user.id, `[Progress Photo ${photoNumber}]`, "[Photo received]", "PROGRESS_PHOTO");

          // If this is a second or later photo — compare with the first
          if (existingPhotos.length >= 1) {
            const firstPhoto = existingPhotos[0];
            const daysBetween = Math.round(
              (Date.now() - new Date(firstPhoto.loggedAt || "").getTime()) / 86_400_000
            );
            const progressDecision = selectVisionModel("progress_compare", isCoach ? "active" : user.subscriptionStatus);
            console.log(`[VISION][${mediaTrace}] progress model=${progressDecision.model} tier=${user.subscriptionStatus}`);
            const comparisonResponse = await openai.chat.completions.create({
              model: progressDecision.model,
              max_tokens: progressDecision.maxTokens,
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
                    { type: "image_url", image_url: { url: `data:${firstPhoto.contentType};base64,${firstPhoto.photoBase64}`, detail: progressDecision.detail } },
                    { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}`, detail: progressDecision.detail } },
                  ],
                },
              ],
            });
            const progressTokens = comparisonResponse.usage?.completion_tokens || 0;
            console.log(`[COST][${mediaTrace}] progress_compare ~$${estimateVisionCostUSD(progressDecision, progressTokens).toFixed(5)} (${progressDecision.reason})`);
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
        const todayStartPhoto = sastDayStart();
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
        // ── Tier-gated vision — inactive users don't burn API budget ──
        // isCoach always bypasses the gate regardless of subscription status
        const foodVisionDecision = selectVisionModel("food_photo", isCoach ? "active" : user.subscriptionStatus);
        if (!foodVisionDecision.allowed) {
          return `${clientName}, your subscription is not currently active. Reactivate at kamlife.co.za to get your meals analysed — or type what you ate and I'll give you an estimate: e.g. "pap, chicken, spinach".`;
        }
        console.log(`[VISION][${mediaTrace}] food model=${foodVisionDecision.model} tier=${user.subscriptionStatus}`);
        const foodVisionStart = Date.now();
        const visionResponse = await withTimeout("food_vision", 22000, () => openai.chat.completions.create({
          model: foodVisionDecision.model,
          max_tokens: foodVisionDecision.maxTokens,
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

FOOD CHECK FIRST: Before anything else, verify this image actually shows food or a drink the client is consuming. If the image is clearly NOT food (selfie, gym mirror, screenshot of an app, document, scenery, body progress photo, scale, supplement bottle, exercise equipment, pet, person without food, meme, blank/black/blurry, etc.) — respond with EXACTLY this single line and nothing else: NOT_FOOD${message ? ` — unless the client caption "${message}" clearly says they are reporting food they ate, in which case treat the caption as the food log.` : ""}

BEST GUESS RULE: For images that ARE food, always make your best estimate even if the photo is not perfect. A bowl of white porridge = oats or pap. Brown liquid in a cup = coffee or tea. Dark stew = beef or chicken stew. If you are 70%+ sure — state your estimate with "roughly" and give the numbers. Only if it IS food but you genuinely cannot tell what kind (completely dark, blurry beyond recognition) — respond only with: Eish, I cannot make out the food clearly. Take the photo in better light and send again.${message ? `\n\nCLIENT CAPTION: "${message}" — use this as the primary food identification. Even if the photo is unclear, log based on the caption.` : ""}`,
                },
                { type: "image_url", image_url: { url: `data:${contentType};base64,${base64}`, detail: foodVisionDecision.detail } },
              ],
            },
          ],
        }));
        const foodVisionTokens = visionResponse.usage?.completion_tokens || 0;
        const foodVisionMs = Date.now() - foodVisionStart;
        console.log(`[COST][${mediaTrace}] food_vision ~$${estimateVisionCostUSD(foodVisionDecision, foodVisionTokens).toFixed(5)} ms=${foodVisionMs} (${foodVisionDecision.reason})`);

        const visionReply = visionResponse.choices[0]?.message?.content?.trim();
        if (!visionReply || visionReply.length < 10) {
          return "Eish, I cannot make out the food clearly. Take the photo in better light and send again.";
        }

        // NOT_FOOD gate — model says image isn't food. Don't log, don't burn extra vision.
        if (/^NOT_FOOD\b/i.test(visionReply)) {
          console.log(`[FOOD_VISION] not_food image rejected user=${user.id.slice(-6)}`);
          return "That photo doesn't look like food to me. Send a photo of your plate or just type what you ate (e.g. \"pap, chicken, spinach\") and I'll log it.";
        }

        await logChat(user.id, "[Photo]", visionReply, "FOOD_LOG");

        // Write to mealLogs so photo meals appear in "my meals" and count in daily totals
        // Sanity bounds: 50-3000 kcal per meal, 0-200g protein. Anything outside is a hallucination.
        const extractKcal = (text: string) => {
          const m = text.match(/roughly\s+(\d[\d,]*)\s*kcal/i) || text.match(/\b(\d{2,4})\s*kcal/i);
          if (!m) return 0;
          const n = parseInt(m[1].replace(/,/g, ""), 10);
          if (!Number.isFinite(n) || n < 50 || n > 3000) return 0;
          return n;
        };
        const extractProt = (text: string) => {
          const m = text.match(/\b(\d{1,3})\s*g\s*protein/i);
          if (!m) return 0;
          const n = parseInt(m[1], 10);
          if (!Number.isFinite(n) || n < 0 || n > 200) return 0;
          return n;
        };

        let totalPhotoKcal = extractKcal(visionReply);
        let totalPhotoProt = extractProt(visionReply);

        // ── MULTI-PHOTO: process any extra images sent in the same message ──
        // Clients frequently send collages (e.g. 3 meal photos in one message).
        // We already processed mediaUrl (the first image). Now handle the rest.
        const extraImageUrls = (allMediaUrls || []).filter(u => u !== mediaUrl);
        const extraReplies: string[] = [];
        if (extraImageUrls.length > 0) {
          const twilioSidExtra = process.env.TWILIO_ACCOUNT_SID || "";
          const twilioTokenExtra = process.env.TWILIO_AUTH_TOKEN || "";
          const imgAuthHeaderExtra = "Basic " + Buffer.from(`${twilioSidExtra}:${twilioTokenExtra}`).toString("base64");
          for (const extraUrl of extraImageUrls.slice(0, 3)) { // max 3 extra images
            try {
              const extraResp = await withTimeout("image_download_extra", 10000, () => fetch(extraUrl, { headers: { Authorization: imgAuthHeaderExtra } }));
              if (!extraResp.ok) continue;
              const extraBuf = await extraResp.arrayBuffer();
              if (extraBuf.byteLength > 10 * 1024 * 1024) continue;
              const extraB64 = Buffer.from(extraBuf).toString("base64");
              const extraCtype = extraResp.headers.get("content-type") || "image/jpeg";
              const extraVision = await withTimeout("food_vision_extra", 18000, () => openai.chat.completions.create({
                model: foodVisionDecision.model,
                max_tokens: Math.min(foodVisionDecision.maxTokens, 200),
                messages: [
                  { role: "system", content: `You are Coach K, a South African fitness coach. Client: ${clientName}. Give calories and protein only for this food photo. Format: "Photo X: [food name] — roughly Y kcal and Zg protein." One sentence max.` },
                  { role: "user", content: [
                    { type: "text", text: "Estimate calories and protein in this food photo." },
                    { type: "image_url", image_url: { url: `data:${extraCtype};base64,${extraB64}`, detail: "low" } },
                  ]},
                ],
              }));
              const extraText = extraVision.choices[0]?.message?.content?.trim() || "";
              if (extraText && extraText.length > 5) {
                extraReplies.push(extraText);
                totalPhotoKcal += extractKcal(extraText);
                totalPhotoProt += extractProt(extraText);
                await logChat(user.id, "[Photo]", extraText, "FOOD_LOG");
              }
            } catch (e) { console.warn("[multi-photo extra vision]", e); }
          }
        }

        if (totalPhotoKcal > 0 || totalPhotoProt > 0) {
          await db.insert(mealLogs).values({
            userId: user.id,
            rawMessage: message || "[Photo]",
            source: "photo",
            kcalInt: totalPhotoKcal,
            proteinInt: totalPhotoProt,
            carbsInt: 0,
            fatInt: 0,
          }).catch(e => console.warn("[photo mealLogs write]", e));
        }

        const [photoPattern, photoDay] = await Promise.all([checkFoodPatterns(user.id), checkPerfectDay(user.id, user.proteinTarget || 130)]);
        // Daily total from mealLogs (source of truth — includes this photo)
        let photoDailyTotal = "";
        try {
          const totals = await recomputeTodayFoodTotals(user.id);
          const calTarget = user.calorieTarget || 1800;
          const protTarget = user.proteinTarget || 130;
          if (totals.calories > 0) {
            const remaining = calTarget - totals.calories;
            photoDailyTotal = `\n\n_Today so far: ~${totals.calories} kcal | ${totals.protein}g protein. Target: ${calTarget} kcal | ${protTarget}g protein.${remaining > 100 ? ` ${remaining} kcal remaining.` : " On target."}_`;
          }
          // Keep denormalized columns in sync for any remaining edge-case consumers
          await db.update(users).set({
            todayCalories: totals.calories,
            todayProteinG: totals.protein,
            todayCaloriesDate: sastToday(),
          }).where(eq(users.id, user.id)).catch(e => console.warn("[photo todayCalories sync]", e));
        } catch (e) { console.warn("[non-fatal]", e); }

        // Combine main reply with any extra photo analyses
        const extraSection = extraReplies.length > 0 ? `\n\n${extraReplies.join("\n")}` : "";
        const multiPhotoNote = extraReplies.length > 0 ? `\n_${extraReplies.length + 1} photos logged — total: ~${totalPhotoKcal} kcal | ${totalPhotoProt}g protein_` : "";
        const photoTotalMs = Date.now() - mediaFlowStart;
        console.log(`[MEDIA][${mediaTrace}] photo_ok total_ms=${photoTotalMs}`);
        await logMediaSuccess(user.id, "photo", photoTotalMs);
        return `${visionReply}${extraSection}${multiPhotoNote}${photoPattern ? "\n\n" + photoPattern : ""}${photoDay || ""}${photoDailyTotal}`;
      } catch (err) {
        const photoFailMs = Date.now() - mediaFlowStart;
        console.error(`[MEDIA][${mediaTrace}] vision_error ms=${photoFailMs}:`, err);
        await logMediaFailure(user.id, "vision", err, photoFailMs);
        return "Eish, I cannot read that photo right now. Tell me what you ate in text — 'chicken and sweet potato' — and I will give you the full breakdown.";
      }
    }

    // ---- VOICE NOTE ----
    // Exclusive: if audio, always return — never falls through to text handler
    if (ctype.startsWith("audio/")) {
      let voiceStage = "download";
      const voiceFlowStart = Date.now();
      let voiceStageStart = voiceFlowStart;
      let _tmpAudioCleanup: (() => void) | null = null;
      try {
        // Part 1 — Twilio media requires basic auth (ACCOUNT_SID:AUTH_TOKEN)
        const twilioSid = process.env.TWILIO_ACCOUNT_SID || "";
        const twilioToken = process.env.TWILIO_AUTH_TOKEN || "";
        const authHeader = "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");

        // Retry once if Twilio download fails (intermittent 5xx errors)
        let audioResponse = await withTimeout("audio_download_1", 12000, () => fetch(mediaUrl, { headers: { Authorization: authHeader } }));
        if (!audioResponse.ok) {
          console.warn(`[VOICE][${mediaTrace}] download_attempt_1_failed status=${audioResponse.status} ms=${Date.now()-voiceStageStart}`);
          await new Promise(r => setTimeout(r, 1500));
          audioResponse = await withTimeout("audio_download_2", 12000, () => fetch(mediaUrl, { headers: { Authorization: authHeader } }));
        }

        if (!audioResponse.ok) {
          const dlMs = Date.now() - voiceStageStart;
          console.error(`[VOICE][${mediaTrace}] download_failed_after_retry status=${audioResponse.status} ms=${dlMs}`);
          await logMediaFailure(user.id, "audio_download", `${audioResponse.status}`, dlMs);
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

        // Threshold: 2KB (~1s of Opus). Anything under this is silence/noise — not speech.
        // WhatsApp Opus at 12kbps = ~1,500 bytes/sec, so 2KB ≈ 1.3s minimum.
        const audioDownloadMs = Date.now() - voiceStageStart;
        console.log(`[VOICE][${mediaTrace}] download_ok bytes=${audioBuffer.byteLength} type=${sourceAudioType} ext=${audioExt} ms=${audioDownloadMs}`);
        if (audioBuffer.byteLength < 2000) {
          console.warn(`[VOICE][${mediaTrace}] audio_too_short bytes=${audioBuffer.byteLength} — rejecting`);
          return "That voice note was too short to transcribe — hold the mic button for at least 3 seconds and resend, or just type your message.";
        }

        voiceStage = "transcribe";
        voiceStageStart = Date.now();

        // Write audio to a temp file — createReadStream avoids File/Blob API entirely
        // (toFile and new File() both require globalThis.File which is Node 20+ only)
        const tmpAudioPath = pathJoin(tmpdir(), `voice_${crypto.randomUUID()}.${audioExt}`);
        await writeFile(tmpAudioPath, Buffer.from(audioBuffer));
        const cleanupTmp = () => unlink(tmpAudioPath).catch(() => {});
        _tmpAudioCleanup = cleanupTmp;

        // Detect language from user's stored preference for better Whisper accuracy
        const storedLangPref = (user.profileNotes || "").match(/lang:([a-z]{2})/)?.[1];
        const whisperLangMap: Record<string, string> = { zu: "zu", xh: "xh", st: "st", tn: "tn", ts: "ts", af: "af", en: "en" };
        const whisperLang = storedLangPref && whisperLangMap[storedLangPref] ? whisperLangMap[storedLangPref] : undefined;

        const whisperPrompt = "South African fitness coaching. Client may speak English, Zulu, Xhosa, Afrikaans, or switch between them. Fitness terms: reps, sets, protein, calories, steps, workout, gym, pap, pilchards.";
        let transcription;
        console.log(`[VOICE] whisper_attempt_1 bytes=${audioBuffer.byteLength} ext=${audioExt} lang=${whisperLang || "auto"}`);
        try {
          transcription = await withTimeout("voice_transcribe", 25000, () => openai.audio.transcriptions.create({
            file: createReadStream(tmpAudioPath),
            model: "whisper-1",
            prompt: whisperPrompt,
            ...(whisperLang ? { language: whisperLang } : {}),
          }));
          console.log(`[VOICE] whisper_attempt_1_result text="${(transcription.text || "").slice(0, 80)}" len=${transcription.text?.length ?? 0}`);
        } catch (transErr: any) {
          console.warn(`[VOICE] whisper_attempt_1_failed lang=${whisperLang || "auto"} error=${transErr?.message || transErr}`);
          console.log(`[VOICE] whisper_attempt_2 bytes=${audioBuffer.byteLength} ext=${audioExt} lang=auto`);
          try {
            transcription = await withTimeout("voice_transcribe_retry", 25000, () => openai.audio.transcriptions.create({
              file: createReadStream(tmpAudioPath),
              model: "whisper-1",
              prompt: whisperPrompt,
            }));
            console.log(`[VOICE] whisper_attempt_2_result text="${(transcription.text || "").slice(0, 80)}" len=${transcription.text?.length ?? 0}`);
          } catch (retryErr: any) {
            console.warn(`[VOICE] whisper_attempt_2_failed error=${retryErr?.message || retryErr}`);
            transcription = { text: "" };
          }
        }

        let transcribedText = transcription.text?.trim();

        // Retry with forced English if empty — Whisper sometimes needs a language anchor for SA clips
        if (!transcribedText) {
          console.log(`[VOICE] whisper_attempt_3_en bytes=${audioBuffer.byteLength}`);
          try {
            const retryTranscription = await withTimeout("voice_transcribe_en_retry", 20000, () =>
              openai.audio.transcriptions.create({
                file: createReadStream(tmpAudioPath),
                model: "whisper-1",
                language: "en",
                prompt: whisperPrompt,
              })
            );
            transcribedText = retryTranscription.text?.trim() || "";
            console.log(`[VOICE] whisper_attempt_3_result text="${transcribedText.slice(0, 80)}" len=${transcribedText.length}`);
          } catch (retryErr: any) {
            console.warn(`[VOICE] whisper_attempt_3_failed error=${retryErr?.message || retryErr}`);
          }
        }

        // Part 3 — Handle result
        if (!transcribedText) {
          const failCount = bumpVoiceFailure(user.id);
          if (failCount >= 3) {
            clearVoiceFailure(user.id);
            return "I keep struggling to pick up your voice notes — this is on my side. Please type your message and I'll get you a detailed reply straight away.";
          }
          const noteLen = audioBuffer.byteLength;
          const likelySilent = noteLen < 12_000; // < ~6s — possibly background noise / mic issue
          return likelySilent
            ? "I got your voice note but couldn't make it out — might have been too quiet or too short. Hold the mic close and speak clearly, or just type your message."
            : "I got your voice note but had trouble processing it right now. Please resend it, or type your message and I'll reply straight away.";
        }

        const wordCount = transcribedText.split(/\s+/).filter(Boolean).length;
        if (wordCount < 3) {
          const failCount = bumpVoiceFailure(user.id);
          if (failCount >= 3) {
            clearVoiceFailure(user.id);
            return `I keep only picking up a few words — "${transcribedText}". Please type your message — I'll reply properly.`;
          }
          return `I only caught a few words — "${transcribedText}". Send again or type your message.`;
        }

        // Transcription succeeded — reset failure counter so future hiccups restart the window
        clearVoiceFailure(user.id);

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

        const transcribeMs = Date.now() - voiceStageStart;
        console.log(`[VOICE][${mediaTrace}] transcribe_ok words=${wordCount} ms=${transcribeMs} lang=${whisperLang || "auto"}${languageNote ? " detected=" + languageNote.split(" ")[4] : ""}`);

        voiceStage = "coach_reply";
        voiceStageStart = Date.now();
        const voiceReply = await withTimeout("voice_coach_reply", 20000, () => handleMessage(phone, transcribedText + (languageNote ? `\n\n[LANGUAGE NOTE: ${languageNote}]` : "")));
        // Part 4 — explicit return, no fall-through
        const coachReplyMs = Date.now() - voiceStageStart;
        const voiceTotalMs = Date.now() - voiceFlowStart;
        console.log(`[MEDIA][${mediaTrace}] voice_ok words=${wordCount} coach_reply_ms=${coachReplyMs} total_ms=${voiceTotalMs}`);
        await logMediaSuccess(user.id, "voice", voiceTotalMs);
        await cleanupTmp();
        return `🎤 I heard: "${transcribedText}"\n\n${voiceReply}`;

      } catch (err) {
        if (_tmpAudioCleanup) _tmpAudioCleanup();
        const stageMs = Date.now() - voiceStageStart;
        console.error(`[VOICE][${mediaTrace}] error stage=${voiceStage} ms=${stageMs}:`, err);
        await logMediaFailure(user.id, `voice_${voiceStage}`, err, stageMs);
        // Part 4 — always return, never fall through to text handler.
        // Count transcribe failures toward the 3-strike escalation — an API error
        // has the same user impact as a bad transcription.
        if (voiceStage === "transcribe") {
          const failCount = bumpVoiceFailure(user.id);
          if (failCount >= 3) {
            clearVoiceFailure(user.id);
            return "I am having trouble transcribing your voice notes — this is on my side. Please type your message and I will reply straight away.";
          }
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


  // ---- GYM WORKOUT LOG — "DAY 3 — UPPER / LOWER" with exercise list ----
  // Recognizes when user pastes their workout log (exercises, sets×reps, optional emojis)
  // Format: "DAY X — TYPE\nExercise — SxR\n..."
  const gymLogMatch = m.match(/^(?:day\s*\d+\s*[—\-–:]+\s*)?(upper|lower|push|pull|legs?|full body|back|chest|arms?|shoulders?)\b/i);
  const hasMultipleExerciseLines = (m.match(/\n.*[×x]\d|\n.*\d+\s*[×x]\s*\d|shoulder|lat pull|bench|squat|deadlift|row|press|curl|extension|fly|crunch|plank/gi) || []).length >= 2;
  const looksLikeGymLog = gymLogMatch && hasMultipleExerciseLines && m.split("\n").length >= 3;

  if (looksLikeGymLog) {
    const name = user.name?.split(" ")[0] || "";
    const sessionType = gymLogMatch[1].charAt(0).toUpperCase() + gymLogMatch[1].slice(1).toLowerCase();
    // Count how many exercises were listed (lines with exercise names or set/rep notation)
    const exerciseLines = m.split("\n").filter(l => /[×x]\d|\d+\s*[×x]|sets?|reps?/i.test(l) || /shoulder|lat|bench|squat|deadlift|row|press|curl|extension|fly/i.test(l));
    const exCount = exerciseLines.length;
    // Detect failed sets (🔴 emoji or "failed")
    const failedCount = (m.match(/🔴|failed|couldn.?t|could not|did not complete/gi) || []).length;
    const warningCount = (m.match(/⚠️|warning|struggled|nearly/gi) || []).length;

    // Log the workout
    const todayStartGym = sastDayStart();
    const alreadyLogged = await db.select({ id: workoutLogs.id })
      .from(workoutLogs)
      .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, todayStartGym)))
      .limit(1);

    let gymLogReply = "";
    if (alreadyLogged.length === 0) {
      const newTotal = (user.totalWorkoutsCompleted || 0) + 1;
      let newDay = (user.programmeDayInWeek || 1) + 1;
      let newWeek = user.programmeWeek || 1;
      const daysPerWeek = user.trainingDaysPerWeek || 3;
      if (newDay > daysPerWeek) { newDay = 1; newWeek++; }
      let newPhase = user.programmePhase || 1;
      const gymPhaseLen = newPhase === 5 ? 1 : 4;
      if (newWeek > gymPhaseLen) {
        newWeek = 1;
        if (newPhase >= 5) { newPhase = 1; } else { newPhase = newPhase + 1; }
      }
      await db.update(users).set({
        totalWorkoutsCompleted: newTotal,
        programmeDayInWeek: newDay,
        programmeWeek: newWeek,
        programmePhase: newPhase,
        lastWorkoutDate: new Date(),
      }).where(eq(users.phoneNumber, phone));
      await db.insert(workoutLogs).values({ userId: user.id, workoutCompleted: true });

      const failNote = failedCount > 0
        ? ` ${failedCount} exercise${failedCount > 1 ? "s" : ""} you couldn't complete — reduce weight by 10% next session and build back up. That is progressive overload working correctly.`
        : warningCount > 0
          ? ` Watch the exercises you struggled with — form first, then add weight.`
          : "";
      gymLogReply = `${sessionType} session logged ✅${name ? ` — ${name}` : ""}. ${exCount} exercises done. Total sessions: ${newTotal}.${failNote}\n\nEat protein within 60 minutes — chicken, eggs, pilchards. Recovery starts now.`;
    } else {
      gymLogReply = `${sessionType} session already logged today. Keep the log — it shows your real numbers. Come back tomorrow.`;
    }
    await logChat(user.id, message, gymLogReply, "WORKOUT_LOG");
    return gymLogReply;
  }

  // ---- DONE — workout complete (direct) ----
  if (/^(done!*|i.?m done!*|im done!*|all done!*|workout done!*|finished!*|completed!*|session done!*|training done!*|workout completed!*|done with workout!*|done with my workout!*|done training!*)$/i.test(m.replace(/[.!?,]+$/, "").trim())) {
    // Guard: prevent double-logging on the same calendar day (race condition + accidental re-send)
    const todayStart = sastDayStart();
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
    // Phase advancement: 4 weeks per phase (Phase 5/Deload = 1 week), then full cycle restart.
    // Foundation(4w) → Build(4w) → Push(4w) → Peak(4w) → Deload(1w) → Foundation again (Cycle 2+)
    let newPhase = user.programmePhase || 1;
    const phaseLength = newPhase === 5 ? 1 : 4;
    let cycleCompleted = false;
    if (newWeek > phaseLength) {
      newWeek = 1;
      if (newPhase >= 5) { newPhase = 1; cycleCompleted = true; } // full cycle → restart
      else { newPhase = newPhase + 1; }
    }

    // Workout streak — continues if last session was within 2 days (but NOT same calendar day,
    // which is already prevented by the double-log guard above)
    const lastW = user.lastWorkoutDate ? new Date(user.lastWorkoutDate) : null;
    const todayMidnight = sastDayStart();
    let newStreak = 1;
    if (lastW) {
      const lastDay = sastDayStart(new Date(lastW));
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
    const perfectDay = await checkPerfectDay(user.id, user.proteinTarget || 130);

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
      ? `\n\n🏆 *First workout done.* Most people only talk about starting. You started. Screenshot this.`
      : newTotal === 3
        ? `\n\n🎯 *3 sessions in.* The research says: people who make it to 3 are 4× more likely to hit 30. You're on track.`
        : newTotal === 5
          ? `\n\n🔥 *5 workouts done.* High five. Some people joined the same day as you and have already quit. You haven't.`
          : newTotal === 10
            ? `\n\n🔥 *10 sessions with Coach K.* You are past the hardest part.${refCode ? ` Share code *${refCode}* with someone who needs to start — they get their first month for R50.` : " Send this to someone who said you would quit."}`
            : newTotal === 25
              ? `\n\n💪 *25 sessions completed.* A month of real work. This is a lifestyle now.${refCode ? ` Your referral code is *${refCode}* — share it with one person today.` : " Share your progress — you earned it."}`
              : newTotal === 50
                ? `\n\n🏆 *50 workouts done.* Half a century of sessions.${refCode ? ` Code *${refCode}* — put this number and your code in your family WhatsApp group.` : " Put this in your family WhatsApp group. Genuinely rare."}`
                : newTotal === 100
                  ? `\n\n🎯 *100 SESSIONS WITH COACH K.* Most people never reach 10. You hit 100. Share this.`
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
    // Variable-ratio reinforcement on workout completion — 15% chance of a surprise
    // extra line. Same slot-machine mechanic as food logs: unpredictable > predictable.
    const WORKOUT_SURPRISES = [
      "\n\n🌟 That session is in the bank. Nothing can take it back.",
      "\n\n⚡ You showed up. That's the whole game.",
      "\n\n🔑 Consistency > intensity. You're living proof.",
      "\n\n🏆 No one else did it for you. That was all you.",
      "\n\n💡 The body you're building is being built right now — session by session.",
    ];
    const workoutSurprise = Math.random() < 0.15 && !milestoneNote
      ? WORKOUT_SURPRISES[Math.floor(Math.random() * WORKOUT_SURPRISES.length)]
      : "";

    // Full cycle completion — all 5 phases done, restarting stronger
    const cycleNote = cycleCompleted
      ? `\n\n🏆 *Full programme cycle complete.* Foundation → Build → Push → Peak → Deload — you did all of it.\n\nCycle 2 starts now. Same structure, heavier weights, shorter rests. Let's see what you're actually made of.`
      : newPhase === 5 && newWeek === 1
        ? `\n\n😮‍💨 *Deload week.* Drop weights by 40%, keep the movement. Your body repairs during this week — do not skip it.`
        : "";

    const goal = user.goalType || "fat_loss";
    const recoveryHook = goal === "muscle_gain"
      ? `\n\n🍚 *Eat now* — rice or pap + protein (eggs, chicken, pilchards). Within 30 minutes. This is the most important meal of your day.`
      : goal === "recomposition"
        ? `\n\n🥩 *Eat now* — protein + moderate carbs within 60 min. Your muscles need fuel to rebuild.`
        : `\n\n🥚 *Eat now* — protein within 60 min. Eggs, chicken, pilchards. Skip the extra carbs if you're sitting for the rest of the day.`;

    let doneReply = `${celebration}${milestoneNote}${cycleNote}${workoutSurprise}${streakLine}\n\n✅ Workout ${newTotal} logged.${recoveryHook}${perfectDay || ""}${liftPrompt}`;

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
    // Sanity bound: 0.5kg–500kg. Above 500kg is almost certainly a typo
    // (e.g. "1000kg bench press" instead of "100kg"). Below 0.5kg is a parsing error.
    // Reject confidently so we don't cite the bad number in future coaching.
    if (weightKg > 0 && (weightKg < 0.5 || weightKg > 500)) {
      return `That weight reads as *${weightKg}kg* — looks like a typo. Send the lift again, e.g. "bench press 80kg 3x8".`;
    }
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
  const explicitKgMatch = m.match(/\b(\d{2,3}(?:\.\d{1,2})?)\s*(?:kg|kilos?)?\b/);
  if (isExplicitWeight && explicitKgMatch) {
    const newKg = parseFloat(explicitKgMatch[1]);
    if (newKg >= 35 && newKg <= 250) {
      const weightReply = await handleWeightLog(phone, user, newKg);
      await logChat(user.id, message, weightReply, "WEIGHT_LOG");
      return weightReply;
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

  // ---- PHOTO CORRECTION / CLARIFICATION — must run BEFORE workout classifier ----
  // User sends a photo, bot misclassifies, user replies "It's a photo of an exercise!!!"
  // The word "exercise" would otherwise fire PROGRAMME_DELIVERY via wordMatchesWorkout.
  // Catch the clarification first and respond with category-appropriate guidance.
  const photoCorrectionMatch =
    /\b(?:it'?s|that'?s|this\s+is|that\s+was|it\s+was)\s+(?:just\s+)?(?:a|an|the|my)?\s*(?:photo|pic|picture|image|snap|screenshot|shot)\s+(?:of|showing|is|was)\b/i.test(m)
    || /\b(?:it'?s|that'?s|this\s+is)\s+(?:a|an|my)\s+[a-z]+\s+(?:photo|pic|picture|image)\b/i.test(m)
    || /\b(?:photo|pic|picture|image)\s+(?:shows?|showing|of)\s+(?:an?\s+|my\s+|the\s+)?(?:exercise|workout|gym|food|meal|steps?|progress)\b/i.test(m);

  if (photoCorrectionMatch) {
    const isExercisePhoto = /\b(exercise|workout|gym|training|lift(?:ing)?|squat|bench|deadlift|press|curl|row|form)\b/.test(m);
    const isFoodPhoto = /\b(food|meal|breakfast|lunch|dinner|supper|snack|plate|eating)\b/.test(m);
    const isStepsPhoto = /\b(steps?|pedometer|fitbit|fitness\s*tracker|step\s*count)\b/.test(m);
    const isProgressPhoto = /\b(progress|mirror|scale|transformation|body\s*shot)\b/.test(m);

    let correctionReply = "";
    if (isExercisePhoto) {
      correctionReply = `Got you — an exercise photo. I cannot give form feedback from a still shot (need a short video for that), but I can help you:\n\n• Log the lift: e.g. "bench 80kg 3x10"\n• Log the session: send *done* when finished\n• See today's session: text *today*`;
    } else if (isFoodPhoto) {
      correctionReply = `Got it — a food photo. Re-send it with a quick caption so I know what to log, e.g. "lunch — chicken and rice". That way I can count kilojoules properly.`;
    } else if (isStepsPhoto) {
      correctionReply = `Sharp — a steps photo. Just text me the number, e.g. "8500 steps" and I will log it straight away.`;
    } else if (isProgressPhoto) {
      correctionReply = `Got you — progress photo noted. Keep them coming weekly, same angle, same lighting. Send *progress* anytime to see your trend.`;
    } else {
      correctionReply = `Got it — thanks for the heads-up. Can you re-send the photo with a short caption so I know how to log it? E.g. "lunch", "8500 steps", "squat form".`;
    }
    await logChat(user.id, message, correctionReply, "PHOTO_CORRECTION");
    return correctionReply;
  }

  // ---- PROGRAMME REQUEST WITHOUT PROFILE — check for elderly/injury first ----
  // STRICT guards: must be a SHORT command-style message, NOT a food message, NOT a rant
  const wordCount_prog = m.split(/\s+/).length;
  const hasComplaintAboutProgram = /\b(you gave|you give|you sent|giving me|gave me|sending me|i got|i received|got a|received a)\b.{0,25}\b(programme|program|workout|plan)\b/i.test(m)
    || /\b(that|the|your|this)\s+(programme|program|workout|plan)\b.{0,30}\b(useless|wrong|bad|terrible|generic|not right|not what|didn't|didn.?t)\b/i.test(m);
  const hasFrustrationSignal_prog = /\b(no no|that.?s not|not true|not right|wrong|terrible|rubbish|nonsense|what the hell|useless|crap|ridiculous|garbage|stupid|shut down|pathetic)\b/i.test(m);
  // Extended food-log signal — must suppress programme when user mentions food OR context around training/gym
  const hasFoodLogSignal_prog = /\b(ate|had|have|having|eating|breakfast|lunch|dinner|supper|snack|for breakfast|for lunch|for dinner|pre.?workout|post.?workout|before\s+(gym|training|workout)|after\s+(gym|training|workout))\b/.test(m);
  // Word-boundary match — prevents "programmer", "programmed", etc. from triggering
  const wordMatchesWorkout = /\b(workout|workouts|programme|program|training\s+plan|workout\s+plan|exercise\s+plan|full\s+body|exercise|training)\b/.test(m);
  const isWorkoutRelated =
    !hasComplaintAboutProgram && // Never fire when complaining about a programme
    wordCount_prog <= 25 && // Long messages are rarely programme requests
    !hasFrustrationSignal_prog && // Never fire on frustration messages
    !hasFoodLogSignal_prog && // Never fire when message has food context
    (
      m === "1" || m === "2" || m === "gym" || m === "workout" || m === "workouts" ||
      /\b\d\s*day\b/.test(m) ||
      wordMatchesWorkout ||
      (m.includes("gym") && /\b(need|want|give|plan|programme|program)\b/.test(m))
    );

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
      const todayStartSteps = sastDayStart();
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
      const stepReply = getStepResponse(steps, target, parseFloat(user.currentWeight as string || "75") || 75);
      const [perfectDay, streak] = await Promise.all([checkPerfectDay(user.id, user.proteinTarget || 130), getStepStreak(user.id)]);
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
      const gptRef = await withTimeout("gpt_food_ref", 20000, () => askCoachK(message, user, "The user is referencing or correcting a previous food log. Use chat history to understand what they mean and respond helpfully. Do NOT log new food."));
      await logChat(user.id, message, gptRef, "FOOD_CORRECTION_REF");
      return gptRef;
    } else {
      // Mark the previous food log as corrected so it is excluded from today's totals
      const todayStartCorr = sastDayStart();
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
          // Write to mealLogs as source of truth
          await db.insert(mealLogs).values({
            userId: user.id,
            rawMessage: lastUnloggedFood.messageIn || "",
            source: "text",
            kcalInt: totalCals,
            proteinInt: totalProt2,
            carbsInt: 0,
            fatInt: 0,
          }).catch(e => console.warn("[smart-log mealLogs write]", e));
          // Recompute from mealLogs and sync denormalized columns
          const recomputed3 = await recomputeTodayFoodTotals(user.id);
          await db.update(users).set({
            todayCalories: recomputed3.calories,
            todayProteinG: recomputed3.protein,
            todayCaloriesDate: sastToday(),
          }).where(eq(users.id, user.id)).catch(e => console.warn("[smart-log todayCalories sync]", e));
          return `Logged! ✅\n${parts.join("\n")}\n\n_Today: ${recomputed3.calories} kcal | ${recomputed3.protein}g protein_`;
        }
      }
    } catch { /* non-fatal — fall through to summary */ }

    // Use mealLogs as source of truth for today's summary
    const summaryTotals = await recomputeTodayFoodTotals(user.id);
    const name = user.name ? ` ${user.name}` : "";
    if (summaryTotals.calories === 0 && summaryTotals.protein === 0) {
      return `Nothing logged yet today. Tell me what you ate — "I had pap and eggs" or "chicken and sweet potato" — and I will log the calories and protein.`;
    }
    const calTarget = user.calorieTarget || 1800;
    const protTarget = user.proteinTarget || 120;
    const remaining = calTarget - summaryTotals.calories;
    const protRemaining = protTarget - summaryTotals.protein;
    const summary = `Today so far:${name} *${summaryTotals.calories} kcal | ${summaryTotals.protein}g protein*\nTarget: ${calTarget} kcal | ${protTarget}g protein\n${remaining > 0 ? `${remaining} kcal and ${protRemaining}g protein still to go.` : `Calorie target reached. ✅`}`;
    return summary;
  }

  // Shared message-type flags used by ALL food handlers below
  const isQuestion = m.includes("?") ||
    /^(what|should|can i|is |are |how|why|when|tell me about|which|do i|where)/.test(m) ||
    /\b(from where|where can|where do|where to|how much|how many|is it|is that|are they|are those|should i|can i|do i|does it|what is|what are|which one|good for|bad for|healthy|unhealthy|worth it|better than|worse than)\b/.test(m);
  // Frustration guard — but NOT if the message also contains food correction intent
  const hasFrustrationWords = /\b(no no|that.?s not|not true|not right|wrong|incorrect|read everything|come on|what the hell|terrible|rubbish|nonsense|adjust it|fix it|change it|update it|that.?s wrong|bull|crap|ridiculous|do a better|better job|what\??!*$|huh\??|excuse me|are you sure|doesn.?t look right|not correct|try again|redo|recalculate)\b/i.test(m);
  // "read it again" and "read that again" are corrections, not frustration — handled by correction flow
  // Frustration is NOT blocking if message has clear food reporting intent (any log verb)
  const isFrustration = hasFrustrationWords && !/\b(i had|i ate|i said|had|ate|having|eating|the above|for lunch|for dinner|for breakfast|for supper|go with|goes with|part of|same meal|i was correcting)\b/i.test(m);
  // Log triggers: words that suggest the user is REPORTING food they ate/are eating
  // Standalone meal words (breakfast/lunch/dinner) are safe because the food logging gate
  // at line ~2218 ALSO requires hasActualFood (scanner must find real food in the message)
  const hasLogTrigger = /\b(ate|had|have|having|eating|i'll have|i will have|gonna have|going to have|breakfast|lunch|dinner|supper|snack|brunch|for breakfast|for lunch|for dinner|for supper|for snack|for brunch|breakfast was|lunch was|dinner was|supper was|just had|just ate|meal was|meal is|food was|i ate|i had|i've had|ive had|pre.?workout|pre workout|post.?workout|post workout|before.*gym|after.*gym|before.*training|after.*training)\b/.test(m);

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
      const todayStart = sastDayStart();
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

      // First: try to find and copy the structured mealLogs entry (fastest path —
      // works for both SA scanner logs AND GPT fallback logs, identified by kcalInt > 0)
      const yesterdayMealRows = await db.select({
        kcalInt: mealLogs.kcalInt,
        proteinInt: mealLogs.proteinInt,
        carbsInt: mealLogs.carbsInt,
        fatInt: mealLogs.fatInt,
        rawMessage: mealLogs.rawMessage,
        source: mealLogs.source,
        items: mealLogs.items,
        loggedAt: mealLogs.loggedAt,
      }).from(mealLogs).where(and(
        eq(mealLogs.userId, user.id),
        gte(mealLogs.loggedAt, new Date(Date.now() - 48 * 3600_000)),
        lt(mealLogs.loggedAt, new Date()),
      )).orderBy(desc(mealLogs.loggedAt)).limit(5);

      const usableMeals = yesterdayMealRows.filter(r => r.kcalInt > 0);
      if (usableMeals.length > 0) {
        // Match on the specific meal the user referenced (prefer rawMessage match, then most recent)
        const matchedMeal = usableMeals.find(r =>
          r.rawMessage && toRepeat && r.rawMessage.toLowerCase().includes(toRepeat.slice(0, 20).toLowerCase())
        ) || usableMeals[0];

        const totalCals = matchedMeal.kcalInt || 0;
        const totalProt = matchedMeal.proteinInt || 0;
        const labels: string[] = matchedMeal.rawMessage ? [matchedMeal.rawMessage.slice(0, 50)] : [];
        // Re-insert single meal to today with quick_relog source
        await db.insert(mealLogs).values({
          userId: user.id,
          rawMessage: matchedMeal.rawMessage || toRepeat,
          source: "quick_relog",
          kcalInt: matchedMeal.kcalInt,
          proteinInt: matchedMeal.proteinInt,
          carbsInt: matchedMeal.carbsInt,
          fatInt: matchedMeal.fatInt,
          items: matchedMeal.items,
        }).catch(() => {});
        const calorieTarget = user.calorieTarget || 2000;
        const proteinTarget = user.proteinTarget || 120;
        // Recompute from mealLogs (includes the newly inserted quick_relog row)
        const relogged = await recomputeTodayFoodTotals(user.id);
        await db.update(users).set({
          todayCalories: relogged.calories,
          todayProteinG: relogged.protein,
          todayCaloriesDate: sastToday(),
        }).where(eq(users.phoneNumber, phone));
        const updTodayCals = relogged.calories;
        const updTodayProt = relogged.protein;
        const remaining = calorieTarget - updTodayCals;
        const protGap = proteinTarget - updTodayProt;
        const mealWasToday = matchedMeal.loggedAt ? matchedMeal.loggedAt >= sastDayStart() : false;
        const copyLabel = mealWasToday ? "Copied from earlier today" : "Copied from yesterday";
        await logChat(user.id, message, `Quick relog: ${labels.join(", ")} (+${totalCals} kcal · +${totalProt}g protein)`, "FOOD_LOG");
        return `♻️ ${copyLabel}:\n${labels.map(l => `• ${l}`).join("\n") || `• ${toRepeat.slice(0, 60)}`}\n\n*+${totalCals} kcal · +${totalProt}g protein*\n${remaining > 0 ? `${remaining} kcal remaining today.` : "Calorie target hit."} ${protGap > 0 ? `${protGap}g protein left.` : "Protein target hit ✅"}`;
      }

      // Fallback: re-process through the food scanner — for older logs without meal_logs entries
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
  // Emotional/motivational messages bypass the food scanner so they reach the motivation handler.
  // IMPORTANT: use only word-boundary patterns here — loose .includes() checks would block food
  // logging for combined messages like "I had eggs but not seeing results".
  // isHardQuit (with loose .includes()) stays in its original position AFTER the food scanner.
  const isSoftStruggleEarly = /\b(i.?m (really |so |just )?(struggling|falling behind|losing motivation|lost motivation|feeling behind|feeling lost|not sure what i.?m doing|demotivated|unmotivated))\b/.test(m) || /\b(feel like (giving up|i.?m failing|i.?m not making progress|nothing is working|i.?m not getting it right|i.?m behind))\b/.test(m) || /\b(i don.?t (know what.?s happening|know what i.?m doing|know if this is working))\b/.test(m) || /\b(hard (to stay|to keep|to maintain) (motivated|going|consistent))\b/.test(m) || /\b(haven.?t (trained|worked out|been to gym|gone to gym)|didn.?t (train|work out)|no (training|workout|gym) (for |in )?\d+\s*(days?|weeks?))\b/.test(m) || /\bfeeling (down|low|unmotivated|demotivated|flat|defeated|hopeless about (this|my progress|the gym))\b/i.test(m) || /\b(unmotivated|demotivated|lost (my |all )?(motivation|drive)|no motivation|zero motivation)\b/i.test(m);
  const isEmotionalMsg = isSoftStruggleEarly;
  const foodsInMsg = scanForSAFoods(m);
  const hasActualFood = foodsInMsg.length > 0;
  // isEmotionalOnly: emotional language WITHOUT a log trigger — "haven't trained, feeling down"
  // If there IS a log trigger ("had", "ate", etc.), the user is logging food AND expressing emotion
  // — food logging takes priority and the motivation handler can run after if needed
  const isEmotionalOnly = isEmotionalMsg && !hasLogTrigger;
  const isShortFoodMsg = !isQuestion && hasLogTrigger && hasActualFood && m.split(/\s+/).length <= 30;
  const directFoodScan = !isQuestion && !isFrustration && !hasLogTrigger && hasActualFood && m.split(/\s+/).length <= 15;
  // Bug fix: isQuestion doesn't block food logging when user clearly mentions food they ate
  // ("I had eggs, how many calories?" → still log the eggs)
  const foodLogOverride = hasLogTrigger && hasActualFood;
  if ((!isQuestion || foodLogOverride) && !isFrustration && !isEmotionalOnly && hasActualFood && (hasLogTrigger || directFoodScan)) {
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

    // Helper: convert word numbers to digits in a segment string
    function normaliseWordNumbers(text: string): string {
      const map: Record<string, string> = {
        "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
        "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
        "half": "0.5", "a": "1", "an": "1",
      };
      return text.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|half|a|an)\b/gi, m => map[m.toLowerCase()] ?? m);
    }

    // Helper: adjust foods by quantity for a given text segment
    function adjustFoodsForSegment(foods: SAFood[], segText: string) {
      const normText = normaliseWordNumbers(segText);
      return foods.map(f => {
        const allAliases = [f.name.toLowerCase(), ...f.aliases.map(a => a.toLowerCase())];
        let quantity = 1;
        for (const alias of allAliases) {
          // Match "3 toast", "3 slices of toast", "2 cups of rice", "3 pieces of chicken"
          const qtyDirect = normText.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+(?:${escapeRegex(alias)})`, "i"));
          const qtyWithFiller = normText.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+(?:slices?|pieces?|cups?|bowls?|plates?|portions?|servings?|tablespoons?|teaspoons?|tbsp|tsp|glasses?)\\s+(?:of\\s+)?(?:${escapeRegex(alias)})`, "i"));
          const qtyBefore = qtyDirect || qtyWithFiller;
          if (qtyBefore) {
            const userQty = parseFloat(qtyBefore[1]);
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
      // Only add coaching notes for real meals (>= 100 kcal) — not for drinks/water/black coffee
      if (totalCals >= 100) {
        if (goodProteins.length > 0 || msgHasProtein) {
          if (totalProtein >= 20 || msgHasProtein) {
            coachNote = `\n\nSolid protein. ${proteinRemaining > 0 ? `${Math.round(proteinRemaining)}g protein still needed today.` : "Protein target hit for today. ✅"}`;
          }
        } else if (junkFoods.length > 0) {
          coachNote = `\n\nNext meal: add protein — eggs, pilchards, or chicken.`;
        } else if (allAdjustedFoods.some(f => f.category === "carb")) {
          coachNote = `\n\nCarbs without protein — add a protein source. Eggs, pilchards, or beans work.`;
        }
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
      // Smart protein suggestion — only fires late in the day when it actually matters.
      // Rules: meal >= 100 kcal (not a drink), running cals >= 40% of daily target
      // (early-day logs don't need nagging — whole day is still ahead), and coachNote
      // hasn't already mentioned protein remaining (avoid double-messaging).
      let proteinTip = "";
      const budgetTier = user.weeklyFoodBudget || "100_300";
      const protRemaining = (user.proteinTarget || 120) - runningProtein;
      const earlyInDay = runningCals < (calorieTarget * 0.4); // < 40% logged = still morning/midday

      // Day-pacing assessment — tells user if they're on track, not just the number
      let dayAssessment = "";
      if (prevCals > 0 && totalCals >= 100) {
        const hourNow = new Date().getUTCHours() + 2; // SAST
        const dayProgress = Math.min(hourNow / 20, 1); // 20:00 SAST = end of eating window
        const expectedCals = calorieTarget * dayProgress;
        const calPace = runningCals / Math.max(expectedCals, 1);
        if (calRemaining <= 0) {
          dayAssessment = `\n_Calorie target reached — stop eating for today. Water and sleep._`;
        } else if (!earlyInDay && calPace < 0.6 && calRemaining < 600) {
          dayAssessment = `\n_On pace — one more protein-heavy meal and you close out the day well._`;
        } else if (!earlyInDay && calPace > 1.3) {
          dayAssessment = `\n_Running high — keep dinner light. Protein and vegetables only tonight._`;
        } else if (!earlyInDay && calPace >= 0.8 && calPace <= 1.2) {
          dayAssessment = `\n_On track for the day. One more solid meal and you're done._`;
        }
      }
      const coachNoteAlreadyMentionsProtein = coachNote.includes("protein still needed") || coachNote.includes("Protein target hit");
      if (protRemaining > 40 && calRemaining > 200 && totalCals >= 100 && !earlyInDay && !coachNoteAlreadyMentionsProtein) {
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

      // Variable reinforcement — fires ~15% of the time (1-in-7 logs).
      // Slot machine psychology: unpredictable reward > predictable reward.
      // These messages appear randomly, feel personal, build identity.
      const variantRoll = Math.random();
      let variableReinforcement = "";
      if (variantRoll < 0.15) {
        const firstName = (user.name || "").split(" ")[0] || "Sharp";
        const daysSinceStart = user.programmeStartDate
          ? Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86_400_000)
          : 0;
        const SURPRISE_NOTES = [
          `\n\n👀 _Coach K noticed: you're tracking consistently. That's the part most people skip._`,
          `\n\n⚡ _Most people at day ${daysSinceStart || "?"} have already stopped logging. You haven't. That matters._`,
          `\n\n🎯 _${firstName}, the consistency you're building right now is worth more than any single perfect meal._`,
          `\n\n💡 _Clients who log food every day lose 3× more than those who don't — you're doing the right thing._`,
          `\n\n🔒 _${firstName}, locking in the habit. Keep it exactly like this._`,
        ];
        variableReinforcement = SURPRISE_NOTES[Math.floor(Math.random() * SURPRISE_NOTES.length)];
      }

      const reply = `*Food logged ✅*\n\n${foodLines}\n\n*${mealLabel}: ~${totalCals} kcal | ~${Math.round(totalProtein)}g protein*\n${runningLine}${dayAssessment}${coachNote}${junkNote}${proteinTip}${variableReinforcement}`;

      // Structured meal_logs write — numeric columns, no regex re-parsing downstream.
      try {
        const totalCarbs = Math.round(allAdjustedFoods.reduce((s, f) => {
          const grams = (f.typicalPortionGrams || 100) * (f.quantity || 1);
          return s + (grams * (f.carbsPer100g || 0) / 100);
        }, 0));
        const totalFat = Math.round(allAdjustedFoods.reduce((s, f) => {
          const grams = (f.typicalPortionGrams || 100) * (f.quantity || 1);
          return s + (grams * (f.fatPer100g || 0) / 100);
        }, 0));
        const items = allAdjustedFoods.map(f => ({
          name: f.name,
          grams: Math.round((f.typicalPortionGrams || 100) * (f.quantity || 1)),
          kcal: f.adjustedCalories,
          protein: f.adjustedProtein,
          category: f.category,
        }));
        const firstSegLabel = mealSegments.find(s => s.label)?.label || null;
        await db.insert(mealLogs).values({
          userId: user.id,
          rawMessage: message.slice(0, 1000),
          source: "sa_scanner",
          kcalInt: totalCals,
          proteinInt: Math.round(totalProtein),
          carbsInt: totalCarbs,
          fatInt: totalFat,
          items,
          mealLabel: firstSegLabel,
        });
      } catch (e) { console.warn("[non-fatal] meal_logs insert:", e); }

      await logChat(user.id, message, reply, "FOOD_LOG");
      const [saPattern, saDay] = await Promise.all([checkFoodPatterns(user.id), checkPerfectDay(user.id, user.proteinTarget || 130)]);
      // If steps were also logged from same message, combine both replies
      const stepAppend = stepReplyPart ? `\n\n${stepReplyPart}` : "";
      return `${reply}${saPattern ? "\n\n" + saPattern : ""}${saDay || ""}${stepAppend}`;
    }

    // ---- GPT FOOD FALLBACK (SA scanner had food keywords but 0 adjusted matches) ----
    // e.g. user sent "I had a steak wrap and chips" — scanner found the words but
    // they mapped to zero calories. Fall through to GPT extraction.
    // Guard: skip questions ("what should I eat?") even if they contain food words.
    if (!isQuestion && hasLogTrigger && hasActualFood) {
      const gptFallbackResult = await gptFoodFallback(message, user);
      if (gptFallbackResult) {
        const calorieTarget = user.calorieTarget || 2000;
        const proteinTarget = user.proteinTarget || 120;
        const foodLines = gptFallbackResult.foods.map(f =>
          `• ${f.name}: ~${f.kcal} kcal, ${f.protein_g}g protein (${f.portion_desc})`
        ).join("\n");
        const todayStr = sastToday();
        let runningCals = gptFallbackResult.totalKcal;
        let runningProtein = gptFallbackResult.totalProtein;
        try {
          const existingTotals = await recomputeTodayFoodTotals(user.id);
          runningCals = existingTotals.calories + gptFallbackResult.totalKcal;
          runningProtein = existingTotals.protein + gptFallbackResult.totalProtein;
          await db.update(users).set({
            todayCalories: runningCals,
            todayProteinG: runningProtein,
            todayCaloriesDate: todayStr,
          }).where(eq(users.phoneNumber, phone));
        } catch (e) { console.warn("[non-fatal] gpt-fallback calorie update:", e); }
        const calRemaining = calorieTarget - runningCals;
        const runningLine = `Running total today: ~${runningCals} kcal / ${calorieTarget} target${calRemaining > 0 ? ` (${calRemaining} remaining)` : " ✅"}`;
        const fbVarRoll = Math.random();
        const fbSurprise = fbVarRoll < 0.15 ? (() => {
          const fn = (user.name || "").split(" ")[0] || "Sharp";
          const NOTES = [`\n\n👀 _Coach K noticed: you're tracking consistently. That's the part most people skip._`, `\n\n🔒 _${fn}, locking in the habit. Keep it exactly like this._`, `\n\n🎯 _Clients who log every day lose 3× more than those who don't — you're doing the right thing._`];
          return NOTES[Math.floor(Math.random() * NOTES.length)];
        })() : "";
        const fallbackReply = `*Food logged ✅*\n\n${foodLines}\n\n*Meal total: ~${gptFallbackResult.totalKcal} kcal | ~${gptFallbackResult.totalProtein}g protein*\n${runningLine}${gptFallbackResult.coachNote ? "\n\n" + gptFallbackResult.coachNote : ""}${fbSurprise}`;
        try {
          const items = gptFallbackResult.foods.map(f => ({
            name: f.name, grams: 0, kcal: f.kcal, protein: f.protein_g, category: f.category,
          }));
          await db.insert(mealLogs).values({
            userId: user.id,
            rawMessage: message.slice(0, 1000),
            source: "gpt_fallback",
            kcalInt: gptFallbackResult.totalKcal,
            proteinInt: gptFallbackResult.totalProtein,
            carbsInt: gptFallbackResult.foods.reduce((s, f) => s + f.carbs_g, 0),
            fatInt: gptFallbackResult.foods.reduce((s, f) => s + f.fat_g, 0),
            items,
            mealLabel: null,
          });
        } catch (e) { console.warn("[non-fatal] gpt-fallback meal_logs:", e); }
        await logChat(user.id, message, fallbackReply, "FOOD_LOG");
        const [fbPattern, fbDay] = await Promise.all([checkFoodPatterns(user.id), checkPerfectDay(user.id, user.proteinTarget || 130)]);
        console.log(`[GPT-FOOD-FALLBACK] ${user.id.slice(0, 8)} — ${gptFallbackResult.foods.map(f => f.name).join(", ")} — ${gptFallbackResult.totalKcal} kcal${gptFallbackResult.fromCache ? " [cached]" : ""}`);
        return `${fallbackReply}${fbPattern ? "\n\n" + fbPattern : ""}${fbDay || ""}`;
      }
    }
  }

  // ---- GPT FOOD FALLBACK (no SA foods detected at all but clear food intent) ----
  // e.g. "I had avocado toast" — scanner had no match; GPT extracts the data.
  // Word count ceiling: voice transcriptions are 80–200+ words and trigger hasLogTrigger
  // on words like "having" in non-food contexts, causing GPT hallucinations.
  // Real food log messages are almost always under 50 words.
  const voiceFallbackTooLong = m.split(/\s+/).filter(Boolean).length > 50;
  // Strong trigger: explicit eating-past-tense / meal-name patterns. The looser hasLogTrigger
  // includes bare "having"/"have" which fires on motivation talk like "I'm having a hard time".
  // For the GPT fallback (which invents data), require something the scanner couldn't fake.
  const hasStrongFoodTrigger = /\b(i ate|i had|i've had|ive had|just had|just ate|just finished eating|for breakfast|for lunch|for dinner|for supper|for brunch|for snack|breakfast was|lunch was|dinner was|supper was|brunch was|meal was|meal is|food was|i'm eating|im eating|i am eating|i'll have|gonna have|going to have|pre.?workout meal|post.?workout meal)\b/i.test(m);
  if (!isQuestion && !isEmotionalOnly && hasStrongFoodTrigger && !hasActualFood && !voiceFallbackTooLong) {
    const gptFallbackResult = await gptFoodFallback(message, user);
    if (gptFallbackResult) {
      const calorieTarget = user.calorieTarget || 2000;
      const foodLines = gptFallbackResult.foods.map(f =>
        `• ${f.name}: ~${f.kcal} kcal, ${f.protein_g}g protein (${f.portion_desc})`
      ).join("\n");
      let runningCals = gptFallbackResult.totalKcal;
      let runningProtein = gptFallbackResult.totalProtein;
      const todayStr = sastToday();
      try {
        const existingTotals = await recomputeTodayFoodTotals(user.id);
        runningCals = existingTotals.calories + gptFallbackResult.totalKcal;
        runningProtein = existingTotals.protein + gptFallbackResult.totalProtein;
        await db.update(users).set({
          todayCalories: runningCals,
          todayProteinG: runningProtein,
          todayCaloriesDate: todayStr,
        }).where(eq(users.phoneNumber, phone));
      } catch (e) { console.warn("[non-fatal] gpt-fallback calorie update:", e); }
      const calRemaining = calorieTarget - runningCals;
      const runningLine = `Running total today: ~${runningCals} kcal / ${calorieTarget} target${calRemaining > 0 ? ` (${calRemaining} remaining)` : " ✅"}`;
      const fb2VarRoll = Math.random();
      const fb2Surprise = fb2VarRoll < 0.15 ? (() => {
        const fn = (user.name || "").split(" ")[0] || "Sharp";
        const daysSince = user.programmeStartDate
          ? Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86_400_000)
          : 0;
        const NOTES = [
          `\n\n👀 _Coach K noticed: you're tracking consistently. That's the part most people skip._`,
          `\n\n⚡ _Most people at day ${daysSince || "?"} have already stopped logging. You haven't. That matters._`,
          `\n\n🎯 _${fn}, the consistency you're building right now is worth more than any single perfect meal._`,
          `\n\n🔒 _${fn}, locking in the habit. Keep it exactly like this._`,
        ];
        return NOTES[Math.floor(Math.random() * NOTES.length)];
      })() : "";
      const fallbackReply = `*Food logged ✅*\n\n${foodLines}\n\n*Meal total: ~${gptFallbackResult.totalKcal} kcal | ~${gptFallbackResult.totalProtein}g protein*\n${runningLine}${gptFallbackResult.coachNote ? "\n\n" + gptFallbackResult.coachNote : ""}${fb2Surprise}`;
      try {
        const items = gptFallbackResult.foods.map(f => ({
          name: f.name, grams: 0, kcal: f.kcal, protein: f.protein_g, category: f.category,
        }));
        await db.insert(mealLogs).values({
          userId: user.id,
          rawMessage: message.slice(0, 1000),
          source: "gpt_fallback",
          kcalInt: gptFallbackResult.totalKcal,
          proteinInt: gptFallbackResult.totalProtein,
          carbsInt: gptFallbackResult.foods.reduce((s, f) => s + f.carbs_g, 0),
          fatInt: gptFallbackResult.foods.reduce((s, f) => s + f.fat_g, 0),
          items,
          mealLabel: null,
        });
      } catch (e) { console.warn("[non-fatal] gpt-fallback meal_logs:", e); }
      await logChat(user.id, message, fallbackReply, "FOOD_LOG");
      const [fbPattern, fbDay] = await Promise.all([checkFoodPatterns(user.id), checkPerfectDay(user.id, user.proteinTarget || 130)]);
      console.log(`[GPT-FOOD-FALLBACK] ${user.id.slice(0, 8)} — ${gptFallbackResult.foods.map(f => f.name).join(", ")} — ${gptFallbackResult.totalKcal} kcal${gptFallbackResult.fromCache ? " [cached]" : ""}`);
      return `${fallbackReply}${fbPattern ? "\n\n" + fbPattern : ""}${fbDay || ""}`;
    }
  }

  // ---- FIX 3: HANDLER 1 — Progress check ----
  if (m.includes("how am i doing") || m.includes("my progress") || m.includes("am i on track") || m.includes("how have i done") || m.includes("check my progress") || m === "this week" || m === "week" || m === "week summary" || m === "my week" || m === "weekly summary" || m === "6" || m === "weekly report" || m === "report" || m.includes("how was my week") || m.includes("this weeks progress")) {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
      const [recentSteps, recentWorkouts, recentWeights, weekFoodRows] = await Promise.all([
        db.select().from(stepLogs).where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sevenDaysAgo))).orderBy(desc(stepLogs.loggedAt)),
        db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, sevenDaysAgo))),
        db.select().from(weightLogs).where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, sevenDaysAgo))).orderBy(asc(weightLogs.loggedAt)),
        db.select({
          totalProt: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
          logDays: sql<number>`COUNT(DISTINCT DATE(${mealLogs.loggedAt}))::int`,
        }).from(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, sevenDaysAgo))),
      ]);
      const liveT = calculateTargets(parseFloat(user.currentWeight || "75"), user.goalType || "fat_loss", user.lifeSituation || "office", user.trainingDaysPerWeek || 3);
      const plannedSessions = user.trainingDaysPerWeek || 3;
      const completedSessions = recentWorkouts.length;
      const avgSteps = recentSteps.length > 0 ? Math.round(recentSteps.reduce((s, r) => s + r.steps, 0) / recentSteps.length) : 0;
      const stepsTarget = user.stepsTarget || 8500;
      const weightChange = recentWeights.length >= 2
        ? (parseFloat(String(recentWeights[recentWeights.length - 1].weight)) - parseFloat(String(recentWeights[0].weight))).toFixed(1)
        : null;
      const weekFoodLogDays = (weekFoodRows as { totalProt: number; logDays: number }[])[0]?.logDays || 0;
      const weekTotalProt = (weekFoodRows as { totalProt: number; logDays: number }[])[0]?.totalProt || 0;
      const avgDailyProt = weekFoodLogDays > 0 ? Math.round(weekTotalProt / 7) : 0;
      const protTarget = user.proteinTarget || 120;
      const sessionSentence = `Training: ${completedSessions} of ${plannedSessions} planned sessions done this week.`;
      const stepSentence = avgSteps > 0 ? `Steps: averaging ${avgSteps.toLocaleString()} per day against a ${stepsTarget.toLocaleString()} target.` : `Steps: no step logs this week — start logging daily.`;
      const weightSentence = weightChange !== null ? (parseFloat(weightChange) < 0 ? `Weight: down ${Math.abs(parseFloat(weightChange))}kg this week — moving in the right direction.` : parseFloat(weightChange) > 0 ? `Weight: up ${weightChange}kg — could be water, sodium, or muscle. Stay on programme.` : `Weight: holding steady this week.`) : `Weight: no weigh-ins logged — step on the scale and send me the number.`;
      const foodSentence = weekFoodLogDays > 0
        ? `Food: logged ${weekFoodLogDays}/7 days — avg ${avgDailyProt}g protein/day${avgDailyProt >= protTarget * 0.9 ? " ✅" : ` (target ${protTarget}g — ${protTarget - avgDailyProt}g gap)`}`
        : `Food: no meals logged this week — consistency here is what drives results.`;
      const onTrack = completedSessions >= Math.ceil(plannedSessions * 0.75);
      const verdictSentence = onTrack ? `Overall you are on track — keep the consistency going into next week.` : `${user.name || "Hey"}, ${plannedSessions - completedSessions} sessions missed this week. Get the next one done today.`;
      const progressReply = `*Your 7-Day Progress Check*\n\n${sessionSentence}\n${stepSentence}\n${weightSentence}\n${foodSentence}\n${verdictSentence}`;

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
  const isHardQuit = m.includes("i want to quit") || m.includes("want to give up") || m.includes("this is too hard") || m.includes("i can't do this") || m.includes("i cant do this") || m.includes("not seeing results") || m.includes("nothing is working") || m.includes("no results") || m.includes("waste of time") || m.includes("doesn't work") || m.includes("not working for me");
  const isSoftStruggle = isSoftStruggleEarly;
  if (isHardQuit || isSoftStruggle) {
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
      const struggleReply = await withTimeout("gpt_struggle", 20000, () => askCoachK(message, user, struggleContext));
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
    const cycleReply = await withTimeout("gpt_cycle", 20000, () => askCoachK(message, user, cycleContext));
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

  // ---- WEEKLY PROGRESS CARD ----
  if (/\b(my week|weekly stats|progress card|week report|how.*i doing this week|weekly progress|my weekly|weekly card|week card|my stats this week|progress this week)\b/i.test(m)) {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      const name = user.name?.split(" ")[0] || "there";
      const wStreak = user.workoutStreak || 0;
      const programmeDays = user.programmeStartDate
        ? Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86_400_000)
        : 0;
      const weekNum = programmeDays > 0 ? Math.ceil(programmeDays / 7) : 1;

      const [weekWorkouts, weekMeals] = await Promise.all([
        db.select({ id: workoutLogs.id, loggedAt: workoutLogs.loggedAt })
          .from(workoutLogs)
          .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, sevenDaysAgo))),
        db.select({ loggedAt: mealLogs.loggedAt, proteinInt: mealLogs.proteinInt })
          .from(mealLogs)
          .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, sevenDaysAgo))),
      ]);

      const foodDays = new Set(weekMeals.map(m => {
        const d = new Date((m.loggedAt?.getTime() || 0) + 2 * 3_600_000);
        return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      })).size;

      // Best protein day
      const protByDay: Record<string, number> = {};
      for (const meal of weekMeals) {
        const d = new Date((meal.loggedAt?.getTime() || 0) + 2 * 3_600_000);
        const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
        protByDay[key] = (protByDay[key] || 0) + (meal.proteinInt || 0);
      }
      const bestProt = Object.values(protByDay).length > 0 ? Math.max(...Object.values(protByDay)) : 0;
      const protTarget = user.proteinTarget || 130;
      const protLine = bestProt > 0
        ? (bestProt >= protTarget ? `💪 Best: ${bestProt}g protein — *target hit*` : `💪 Best: ${bestProt}g protein`)
        : "";

      const workoutCount = weekWorkouts.length;
      const trainingDays = user.trainingDaysPerWeek || 3;
      const scoreEmoji = workoutCount >= trainingDays && foodDays >= 5 ? "🔥" : workoutCount >= trainingDays || foodDays >= 5 ? "✅" : "📈";

      let referralCode = user.referralCode;
      if (!referralCode) {
        const prefix = (user.name || "KAM").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "K");
        referralCode = `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
        await db.update(users).set({ referralCode }).where(eq(users.phoneNumber, phone));
      }

      const cardLines = [
        `${scoreEmoji} *${name} — Week ${weekNum} Report*`,
        ``,
        `🏋️ Workouts: ${workoutCount}/${trainingDays}`,
        `🔥 Streak: ${wStreak} sessions`,
        `🥗 Food logged: ${foodDays}/7 days`,
        protLine,
        ``,
        workoutCount >= trainingDays && foodDays >= 5
          ? `Consistent week. This is what results look like in the making.`
          : workoutCount >= trainingDays || foodDays >= 5
            ? `Solid effort. Close the one gap next week.`
            : `One more push next week — you have the plan, now execute it.`,
        ``,
        `_KamLife Coach — forward this to a friend who needs accountability. Code *${referralCode}* gets them month 1 for R50._`,
      ].filter(l => l !== undefined);

      const cardReply = cardLines.join("\n");
      await logChat(user.id, message, cardReply, "PROGRESS_CARD");
      return cardReply;
    } catch (e) {
      console.error("[PROGRESS_CARD]", e);
    }
  }

  // ---- CHALLENGE A FRIEND ----
  if (/\b(challenge\s+a?\s*friend|challenge\s+someone|start\s+(a\s+)?challenge|dare\s+a?\s*friend|challenge\s+buddy)\b/i.test(m)) {
    let code = user.referralCode;
    if (!code) {
      const prefix = (user.name || "KAM").replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "K");
      code = `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
      await db.update(users).set({ referralCode: code }).where(eq(users.phoneNumber, phone));
    }
    const wk = user.workoutStreak || 0;
    const challengeTarget = `${user.trainingDaysPerWeek || 3} workouts + food logged 5 out of 7 days`;
    const challengeReply = `*This week's challenge: ${challengeTarget}.*\n\nYou're ${wk > 0 ? `on a ${wk}-session streak` : "ready to start a streak"}. Now bring someone else in.\n\nSend your friend this message:\n\n_"I'm doing a weekly fitness challenge on WhatsApp with a real SA coach. Join me — text *join ${code}* to this number: ${process.env.TWILIO_WHATSAPP_NUMBER?.replace("whatsapp:", "") || "[your coach number]"}. First month R50 with my code."_\n\nWhen they join, you both get an extra accountability nudge each week.`;
    await logChat(user.id, message, challengeReply, "CHALLENGE_INVITE");
    return challengeReply;
  }

  // ---- JOIN CHALLENGE (friend accepting an invite) ----
  if (/^join\s+([A-Z]{3}\d{4})$/i.test(m.trim())) {
    const challengeCode = m.trim().split(/\s+/)[1].toUpperCase();
    const [inviter] = await db.select({ id: users.id, name: users.name, phoneNumber: users.phoneNumber })
      .from(users).where(eq(users.referralCode, challengeCode)).limit(1);
    if (inviter && inviter.id !== user.id) {
      await db.update(users).set({ referredBy: inviter.id }).where(eq(users.phoneNumber, phone));
      await logChat(user.id, message, `Challenge accepted`, "CHALLENGE_JOIN");
      return `Challenge accepted. You and ${inviter.name?.split(" ")[0] || "your friend"} are now in the same weekly challenge.\n\nYour target: ${user.trainingDaysPerWeek || 3} workouts + food logged 5 days this week.\n\nLet's go. Send me your first meal or reply *programme* to see your workout plan.`;
    }
    return `I could not find that challenge code. Double-check it and try again, or reply *challenge a friend* to create your own.`;
  }

  // ---- REFERRAL ----
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

    const sleepReply = getSleepResponse(hours, isBadSleep);

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

  // ---- STOP (WhatsApp Business / POPIA opt-out) ----
  // Bare "stop" is the industry-standard opt-out keyword. Must be respected
  // even when the user hasn't cancelled — sets a 1-year messaging pause.
  if (m === "stop" || m === "stop all" || m === "opt out" || m === "opt-out") {
    const name = user.name || "there";
    const pauseUntil = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    const existingNotes = user.profileNotes || "";
    const cleanedNotes = existingNotes.replace(/\s*\|?\s*paused_until:\d{4}-\d{2}-\d{2}/, "").trim();
    const updatedNotes = `${cleanedNotes ? cleanedNotes + " | " : ""}paused_until:${pauseUntil}`;
    await db.update(users).set({ profileNotes: updatedNotes }).where(eq(users.phoneNumber, phone));
    const stopReply = `Done${name !== "there" ? `, ${name}` : ""}. No more messages from me. Your data is saved.\n\nReply *START* anytime to resume coaching.`;
    await logChat(user.id, message, stopReply, "OPT_OUT");
    return stopReply;
  }

  // ---- START (WhatsApp Business / POPIA opt-in / resume) ----
  if (m === "start" || m === "unstop" || m === "opt in" || m === "opt-in") {
    const existingNotes = user.profileNotes || "";
    const wasPaused = /paused_until:\d{4}-\d{2}-\d{2}/.test(existingNotes);
    if (wasPaused) {
      const cleanedNotes = existingNotes.replace(/\s*\|?\s*paused_until:\d{4}-\d{2}-\d{2}/, "").trim();
      await db.update(users).set({ profileNotes: cleanedNotes || null }).where(eq(users.phoneNumber, phone));
      const resumeReply = `Welcome back. Coaching is resumed. Tell me what you ate today and we pick up from there.`;
      await logChat(user.id, message, resumeReply, "OPT_IN");
      return resumeReply;
    }
    // Not paused — fall through (bare "start" from a new user means menu, not opt-in)
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

  // ---- COMEBACK RESCUE — handle "1"/"2"/"3" replies from lapsed users ----
  if (user.awaitingInputType === "comeback") {
    const choice = m.trim();
    await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone));
    const capName = user.name?.split(" ")[0] || "there";
    let reply = "";
    if (choice === "1" || /\b(back|let.?s go|i.?m back|ready|let's start)\b/i.test(m)) {
      reply = `${capName} is back. No big deal — resets are part of the process.\n\nSend me what you ate today and we pick up right now. No restarts, no lectures.`;
    } else if (choice === "2" || /\b(simpler|simple|overwhelm|too much)\b/i.test(m)) {
      reply = `Got it, ${capName}. We strip it down.\n\nFor the next 3 days, your only job is: *log 2 meals a day*. Nothing else. No workout pressure. No step count. Just food.\n\nSend your first meal whenever you're ready.`;
    } else if (choice === "3" || /\b(busy|later|week|not now)\b/i.test(m)) {
      reply = `Understood, ${capName}. I will check in with you next week.\n\nYour programme is exactly where you left it — no restart needed. One message brings it back. I'll be here.`;
    } else {
      // Unrecognised reply — re-prompt once
      reply = `${capName}, I got your message but need a clearer signal:\n\n*1* — I'm back\n*2* — Need a simpler plan\n*3* — Just busy for now\n\nWhich one?`;
      await db.update(users).set({ awaitingInputType: "comeback" }).where(eq(users.phoneNumber, phone));
    }
    await logChat(user.id, message, reply, "COMEBACK_RESCUE");
    return reply;
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
    const capName = user.name?.split(" ")[0] || "there";
    const goalActionNote = pendingGoal === "fat_loss"
      ? `Protein first, every meal. Hit ${newProt}g and the rest takes care of itself.`
      : pendingGoal === "muscle_gain"
        ? `Eat above ${newCals} kcal on training days. Protein every meal — target ${newProt}g.`
        : `Protein at every meal (${newProt}g/day) with a slight calorie deficit on rest days and maintenance on training days.`;
    const goalReply = `${capName}, locked in — ${goalLabels[pendingGoal] || pendingGoal}.\n\nNew daily targets: *${newCals} kcal | ${newProt}g protein.*\n\n${goalActionNote}\n\nReply *programme* to see your updated plan.`;
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
    const gymReply = `${gymName ? `${gymName}` : "Gym"} programme loaded${clientName}. *${user.trainingDaysPerWeek || 3} days/week* — progressive overload from session 1.\n\n${gymProg}`;
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
    const todayStart = sastDayStart();
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
  if (/\b(what.*(?:i eat|i ate|i had)|my food|food diary|food log|meal log|meal logs|today.?s?\s*meal\s*logs?|meals today|melas today|melas|ate today|eaten today|log today|today.?s?\s*food|food.*today|what.*eat.*today|how many.*calori|calori.*today|today.?s?\s*calori|protein today|today.?s?\s*protein|macros today|today.?s?\s*macros|daily total|today.?s?\s*total|total today|how much.*eaten|what.*logged|my meals|my logged|logged meals|see my (?:meal|food)|show my (?:meal|food)|view my (?:meal|food)|meals|today.?s meals)\b/i.test(m)) {
    const todayStart = sastDayStart();

    // Primary: read from structured mealLogs table — stores SA scanner + GPT fallback + photo logs.
    // This is authoritative: we wrote to it at log time, no re-parsing needed.
    const structuredLogs = await db.select({
      kcalInt: mealLogs.kcalInt,
      proteinInt: mealLogs.proteinInt,
      rawMessage: mealLogs.rawMessage,
      source: mealLogs.source,
      items: mealLogs.items,
      mealLabel: mealLogs.mealLabel,
    }).from(mealLogs).where(and(
      eq(mealLogs.userId, user.id),
      gte(mealLogs.loggedAt, todayStart),
    )).orderBy(asc(mealLogs.loggedAt));

    if (structuredLogs.length === 0) {
      // Fallback to chatHistory for legacy logs (pre-meal_logs table or photo-only logs)
      const chatLogs = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)));
      if (chatLogs.length === 0) {
        const diaryReply = `No meals logged yet today. Log your first meal by describing what you ate — for example: "had 2 eggs and pap for breakfast".`;
        await logChat(user.id, message, diaryReply, "FOOD_DIARY");
        return diaryReply;
      }
      // Legacy path: extract from text
      let totalCal = 0; let totalProt = 0;
      const mealLinesFallback: string[] = [];
      for (const log of chatLogs) {
        const msgIn = log.messageIn || "";
        const calMatch = (log.messageOut || "").match(/(\d{3,4})\s*kcal/i);
        const protMatch = (log.messageOut || "").match(/(\d+)g?\s*protein/i);
        if (calMatch) totalCal += parseInt(calMatch[1]);
        if (protMatch) totalProt += parseInt(protMatch[1]);
        if (msgIn && msgIn !== "[Photo]") mealLinesFallback.push(`• ${msgIn.slice(0, 60)}`);
      }
      const legacyReply = `*Today's meals:*\n${mealLinesFallback.join("\n") || "• Food photo(s) logged"}\n\n*Total: ~${totalCal} kcal | ~${totalProt}g protein*`;
      await logChat(user.id, message, legacyReply, "FOOD_DIARY");
      return legacyReply;
    }

    let totalCal = 0; let totalProt = 0;
    const mealLines: string[] = [];
    for (const log of structuredLogs) {
      const mCal = log.kcalInt || 0;
      const mProt = log.proteinInt || 0;
      totalCal += mCal; totalProt += mProt;
      const label = log.mealLabel ? `${log.mealLabel}: ` : "";
      const isPhoto = log.source === "photo";
      if (isPhoto && mCal === 0) {
        mealLines.push(`• Food photo logged — caption needed for calories`);
        continue;
      }
      // Derive display name: prefer structured items array, then rawMessage text
      const logItems = log.items as Array<{ name?: string; foodName?: string }> | null;
      const itemNames = Array.isArray(logItems) && logItems.length > 0
        ? logItems.map((i: any) => i.name || i.foodName || "").filter(Boolean).join(", ")
        : null;
      const rawMsg = log.rawMessage || "";
      const displayName = itemNames
        || (rawMsg && rawMsg !== "[Photo]" ? rawMsg.slice(0, 60) : null)
        || "Food logged";
      if (isPhoto) {
        mealLines.push(mCal > 0
          ? `• ${label}Food photo — ~${mCal} kcal, ${mProt}g protein`
          : `• ${label}Food photo logged`);
      } else {
        mealLines.push(mCal > 0
          ? `• ${label}${displayName} — ~${mCal} kcal, ${mProt}g protein`
          : `• ${label}${displayName}`);
      }
    }
    const calTarget = user.calorieTarget || 1800;
    const protTarget = user.proteinTarget || 130;
    const calRemaining = calTarget - totalCal;
    const hour = new Date().getHours();
    const isLateEnough = hour >= 16; // After 4pm, low intake is a real problem

    // Coaching note based on intake vs target
    let diaryCoachNote = "";
    if (totalCal > 0 && totalCal < calTarget * 0.45 && isLateEnough) {
      diaryCoachNote = `\n\n⚠️ *Under-eating alert:* ${totalCal} kcal at this time of day is too low. You are ${calRemaining} kcal short. Eat a proper meal tonight — protein and carbs. Starving is not a fat loss strategy, it is a metabolism killer.`;
    } else if (totalCal > 0 && calRemaining > 500 && !isLateEnough) {
      diaryCoachNote = `\n\n${calRemaining} kcal still to go. Spread it across your remaining meals — do not leave it all for dinner.`;
    } else if (totalCal > calTarget * 1.1) {
      diaryCoachNote = `\n\nOver target by ${Math.abs(calRemaining)} kcal. Keep the next meal protein-only — eggs, pilchards, chicken — and skip the starch.`;
    }

    const diaryLines = [
      `*Today's food log (${mealLines.length} ${mealLines.length === 1 ? "meal" : "meals"}):*`,
      ...mealLines,
      ``,
      `*Running total:* ~${totalCal} kcal | ${totalProt}g protein`,
      `*Target:* ${calTarget} kcal | ${protTarget}g protein`,
      calRemaining > 0 ? `*Remaining:* ~${calRemaining} kcal` : `*Status:* Over target by ~${Math.abs(calRemaining)} kcal`,
    ];
    const diaryReply = diaryLines.join("\n") + diaryCoachNote;
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

  // ---- FOOD FORMAT RECOVERY — message looked like food logging but SA scanner found nothing ----
  // Fires only when: (a) clear food-log trigger word present, (b) SA database found no foods,
  // (c) not a question/frustration, (d) not already handled by water/steps/braai/restaurant/etc.
  // Provide instant format guidance instead of sending to GPT (which may return generic advice).
  const seemsFoodLogAttempt = hasLogTrigger && !hasActualFood && !isQuestion && !isFrustration;
  if (seemsFoodLogAttempt) {
    // Compute candidate word count — if very short we can't do much
    const wordCount = m.split(/\s+/).length;
    // Only intercept if message has enough content to warrant format guidance
    // (single word like "yes" is handled by SHORT_REPLIES; "I had nothing" is ok to fall through)
    const hasNothingEaten = /\b(nothing|not.*eat|didn.?t eat|skipped|no food|fasted|fasting|no meals?)\b/i.test(m);
    if (!hasNothingEaten && wordCount >= 3) {
      // Try to extract what they mentioned as a food item for a personalised reply
      const firstNoun = m.replace(/\b(i had|i ate|just had|just ate|ate|had|having|i have|having|breakfast was|lunch was|dinner was|breakfast|lunch|dinner|supper|snack|brunch|for|at|with|and|the|a|an|some|my)\b/gi, " ").trim().split(/\s+/).filter(w => w.length > 2)[0] || "";
      const foodHint = firstNoun ? ` (like "${firstNoun}")` : "";
      const formatReply = `I did not recognise that food${foodHint} in my database. Log it like this:\n\n"I had 2 eggs and pap for breakfast"\n"Chicken thigh, sweet potato and spinach for lunch"\n\nInclude: the food name, rough amount, and which meal. I will give you the kcal and protein instantly.`;
      await logChat(user.id, message, formatReply, "FOOD_FORMAT_GUIDE");
      return formatReply;
    }
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
  Coach specifically on THAT exact food. ALWAYS include the estimated calories (kcal) and protein (g) — this is NON-NEGOTIABLE. Format: "That is roughly X kcal and Xg protein." If you cannot estimate a specific number, use a range. Never give a food response without numbers. Never say "I cannot estimate" — always give a best estimate based on standard portions.
  If junk — acknowledge without shaming, give one specific swap. If good — celebrate and connect to their ${user.goalType || "fat loss"} goal. Never end with a protein warning. Never give generic advice.
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
  // Pure punctuation / frustration symbols — "!!!!!", "???", "..." — treat as short contextual reply
  if (/^[!?.\s]+$/.test(m) && m.replace(/\s/g, "").length >= 1) {
    try {
      const lastExchange = await db.select({ messageOut: chatHistory.messageOut, intent: chatHistory.intent })
        .from(chatHistory).where(eq(chatHistory.userId, user.id)).orderBy(desc(chatHistory.createdAt)).limit(1);
      const lastOut = lastExchange[0]?.messageOut || "";
      const lastIntent = lastExchange[0]?.intent || "";
      const punctCtx = `Client sent only "${message}" (pure frustration/reaction). They are responding to your previous message (intent: ${lastIntent}): "${lastOut.slice(0, 300)}". This means they are either frustrated, confused, or surprised by your last reply. Acknowledge the reaction briefly and either clarify your last response or ask what specifically they need. Do not ask what they mean — you know they are reacting to your last message. Be direct, max 2 sentences, SA voice.`;
      const punctReply = sanitizeCoachReply(await withTimeout("gpt_punct", 15000, () => askCoachK(message, user, punctCtx, memoryContext)), message, user.weeklyFoodBudget, user.injuries);
      await logChat(user.id, message, punctReply, "SHORT_REPLY");
      return punctReply;
    } catch (e) { console.warn("[punct-reply]", e); }
  }

  const SHORT_REPLIES = ["yes", "no", "yeah", "nah", "nope", "yep", "yebo", "ja", "ok", "okay", "sure", "fine", "cool", "sharp", "eish", "omg", "wtf", "lol", "wow", "thanks", "thank you", "dankie", "lekker", "nice", "awesome", "great", "perfect", "noted", "got it", "will do", "aight", "right"];
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
      const shortReply = sanitizeCoachReply(await withTimeout("gpt_short", 20000, () => askCoachK(message, user, shortReplyContext, memoryContext)), message, user.weeklyFoodBudget, user.injuries);
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
      const frustReply = sanitizeCoachReply(await withTimeout("gpt_frust", 20000, () => askCoachK(message, user, frustContext)), message, user.weeklyFoodBudget, user.injuries);
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
  // Await classifier here — by now it has had 0.5-2s to complete across all the handlers above.
  const intentResult = await intentPromise;
  const classifiedIntent = intentResult.intent;
  const intentConfidence = intentResult.confidence;

  // Determine effective agent type:
  // 1. RANT with high confidence → mindset agent (empathetic, doesn't lecture on nutrition)
  // 2. Otherwise use keyword-based routing as before
  let agentType = routeToAgent(message);
  if (classifiedIntent === "RANT" && intentConfidence >= 0.75) {
    agentType = "mindset";
    console.log(`[INTENT] RANT override → mindset agent (${Math.round(intentConfidence * 100)}% confidence)`);
  }

  if (!checkGptRateLimit(user.id)) {
    console.warn(`[RATE] GPT rate limit hit for user ${user.id.slice(0, 8)}`);
    return "You're sending messages very fast — give Coach K a moment and try again.";
  }

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
      gptReply = await withTimeout("gpt_coach", 30000, () => askCoachK(message, user, finalInstruction, memoryContext));
    }
    // If specialist agent returned its own error string, fall back to full Coach K
    if (gptReply === AGENT_ERROR) {
      gptReply = await withTimeout("gpt_coach_fallback", 30000, () => askCoachK(message, user, finalInstruction, memoryContext));
    }
  } catch (e) {
    console.warn("[agent-routing]", e);
    gptReply = await withTimeout("gpt_coach_catch", 30000, () => askCoachK(message, user, finalInstruction, memoryContext));
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
    const perfectDay = await checkPerfectDay(user.id, user.proteinTarget || 130);
    // ---- Calorie running total — from EXISTING food logs only (not current GPT message) ----
    let dailyTotal = "";
    try {
      const todayStart = sastDayStart();
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

  // Log the GPT catchall with the classifier's intent label so the observability
  // dashboard shows accurate intent tags for messages that fell through all handlers.
  const gptIntentLabel = (classifiedIntent !== "OTHER" && intentConfidence >= 0.6)
    ? classifiedIntent
    : (agentType === "mindset" ? "MINDSET" : agentType === "nutrition" ? "NUTRITION" : agentType === "programming" ? "PROGRAMME" : "GENERAL");
  await logChat(user.id, message, finalReply, gptIntentLabel).catch(e => console.warn("[non-fatal logChat]", e));

  return finalReply;

  } catch (err: any) {
    console.error("[handleMessage FATAL]", JSON.stringify({
      phone,
      message: (message || "").slice(0, 200),
      hasMedia: !!mediaUrl,
      errMessage: err?.message || String(err),
      errCode: err?.code,
      errStack: err?.stack?.split("\n").slice(0, 8).join(" | "),
    }));
    return "Eish, something went wrong on my side. Give me a second and try again.";
  }
}

// ============================================================
// RATE LIMITER — 15 messages per phone per 60 seconds
// DB-backed so limits survive server restarts / multi-instance deploys.
// ============================================================

// ============================================================
// VOICE NOTE FAILURE TRACKER — escalate to "please type" after 3 failures
// in a 30-min window. Prevents the "client sends 5 bad voice notes and
// gives up" loop. Keyed by userId. Reset on first successful transcription.
// ============================================================

const voiceFailureMap = new Map<string, { count: number; lastAt: number }>();
const VOICE_FAILURE_RESET_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of voiceFailureMap.entries()) {
    if (now - val.lastAt > VOICE_FAILURE_RESET_MS) voiceFailureMap.delete(key);
  }
}, 15 * 60 * 1000);

export function bumpVoiceFailure(userId: string): number {
  const now = Date.now();
  const prev = voiceFailureMap.get(userId);
  const count = prev && (now - prev.lastAt) < VOICE_FAILURE_RESET_MS ? prev.count + 1 : 1;
  voiceFailureMap.set(userId, { count, lastAt: now });
  return count;
}

export function clearVoiceFailure(userId: string): void {
  voiceFailureMap.delete(userId);
}

async function checkRateLimit(phone: string): Promise<boolean> {
  try {
    const result = await pool.query<{ hit_count: number }>(`
      INSERT INTO rate_limits (phone, window_start, hit_count)
      VALUES ($1, NOW(), 1)
      ON CONFLICT (phone) DO UPDATE SET
        hit_count = CASE
          WHEN rate_limits.window_start > NOW() - INTERVAL '60 seconds'
            THEN rate_limits.hit_count + 1
          ELSE 1
        END,
        window_start = CASE
          WHEN rate_limits.window_start > NOW() - INTERVAL '60 seconds'
            THEN rate_limits.window_start
          ELSE NOW()
        END
      RETURNING hit_count
    `, [phone]);
    return result.rows[0].hit_count <= 15;
  } catch (e) {
    console.error("[RATE_LIMIT] DB error — allowing request:", e);
    return true; // fail open rather than blocking legitimate users
  }
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
    registerCoachRoutes,
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
  registerCoachRoutes(app);

  // Routes now in server/routes/*.ts:
  //   routes/auth.ts      — /api/auth/login
  //   routes/admin.ts     — /api/users, /api/admin/*
  //   routes/whatsapp.ts  — /twilio/whatsapp, /api/admin/test-webhook
  //   routes/health.ts    — /health, /api/health, /api/public/stats, /voice/*
  //   routes/dashboard.ts — /api/dashboard/*
  //   routes/payments.ts  — /webhook/payfast, /webhook/status, /api/payfast/link
  //   routes/coach.ts     — /coach (HTML admin dashboard)
  // See server/routes/index.ts for the registry.



}

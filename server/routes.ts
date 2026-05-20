import { type Express } from "express";
import { type Server } from "http";
import crypto from "crypto";
import path from "path";
import { db, pool } from "./db";
import { users, weightLogs, workoutLogs, stepLogs, chatHistory, clothingCheckins, bodyMeasurements, weeklyCheckins, exerciseLogs, progressPhotos, escalations, abAssignments, mealLogs } from "../shared/schema";
import { eq, desc, asc, and, gte, lt, sql, count } from "drizzle-orm";
import OpenAI from "openai";
import twilio from "twilio";
import { SA_FOODS_SEED, type SAFood } from "./foods";
import { COACH_K_SYSTEM } from "./coach-prompt";
import { EQUIPMENT_ALTERNATIVES, FOOD_SUBSTITUTIONS, PORTION_GUIDE, STORE_ADVICE, INJURY_MODIFICATIONS, SUPPLEMENT_GUIDE, detectLanguage, type SALanguage } from "./constants";
import { getExerciseGifUrl, getPrimaryWorkoutGifUrl, getPortionGuide } from "./exercise-media";
import { buildDayWorkout, buildDayWorkoutForType, buildFullProgramme, getKamlifeProgramme, getDayType } from "./programme";
import { askCoachK, selectModel, buildPatternSummary, getSAContextFlags, isUnderGPTCallLimit, selectVisionModel, estimateVisionCostUSD, classifyIntent, type ClassifiedIntent } from "./gpt";
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
import { handleMediaMessage, bumpVoiceFailure, clearVoiceFailure } from "./handlers/media";
import { runSafetyGuards } from "./handlers/safety";
import { handleFoodLogMgmt } from "./handlers/food-log-mgmt";
import { handleWater } from "./handlers/water";
import { handleFoodContext } from "./handlers/food-context";
import { handleProgressCheck } from "./handlers/progress";
import { JUNK_WORDS as _JUNK_WORDS, checkFoodPatterns, getDamageControlNote, getProgressiveOverloadContext, checkPerfectDay } from "./handlers/checks";
import { scanForSAFoods, parseFoodLogTotalsFromMessageOut, sanitizeCoachReply, recomputeTodayFoodTotals } from "./handlers/food-scanner";
import { logChat, logMediaFailure, logMediaSuccess, buildMediaTrace, withTimeout } from "./handlers/chat-log";
import { handleWeightLog } from "./handlers/weight";
import { handleWorkoutCommands } from "./handlers/workout";
import { handleMiscCommands } from "./handlers/misc-commands";
import { handleLifecycle } from "./handlers/lifecycle";
import { handleEarlyCommands } from "./handlers/early-commands";
import { handleGptBlock } from "./handlers/gpt-block";
import { getDisplayName, checkGptRateLimit, sastDayStart, sastToday } from "./utils";
import { invalidatePatternCache } from "./cache";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "sk-missing-key",
});

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

// Onboarding functions moved to ./onboarding (see imports above)

// ============================================================
// MAIN MESSAGE HANDLER
// ============================================================

async function handleMessage(phone: string, message: string, mediaUrl?: string, mediaContentType?: string, allMediaUrls?: string[]): Promise<string> {
  try {
  const m = message.toLowerCase().trim().replace(/[‘’“”]/g, "'").replace(/\s+/g, " ");

  // ---- SAFETY + DATA GUARDS (crisis, medical, terminal, delete, reset) ----
  const safetyResult = await runSafetyGuards(phone, message, m);
  if (safetyResult !== null) return safetyResult;

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
    const isConsent = consentKeywords.some(k => {
      if (m === k) return true;
      if (k.includes(" ")) return m.includes(k); // multi-word: "i agree", "i consent"
      return new RegExp(`\\b${k}\\b`).test(m);   // single-word: whole-word only, "ja" must not match "jam"
    });
    if (isConsent) {
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

  // ---- SUBSCRIPTION GATE — full product requires active subscription, no free tier ----
  // Safety messages (chest pain, crisis, emergency) always bypass.
  // Onboarding is handled before this point and bypasses via onboardingState check.
  if (user.subscriptionStatus === 'inactive' && !isCoach) {
    const isSafety = /\b(chest pain|chest hurts?|chest is (tight|sore|aching|burning)|pain in my chest|chest tightness|can.?t breathe|shortness of breath|can.?t catch my breath|heart racing|heart pounding|dizziness|feeling faint|emergency|hospital|ambulance|crisis|suicid|hurt myself)\b/i.test(m);
    if (!isSafety) {
      const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
      const merchantId = process.env.PAYFAST_MERCHANT_ID;
      const cleanPhone = phone.replace(/^whatsapp:/, "").replace(/\D/g, "");
      const payLink = merchantId ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}` : appUrl;
      const name = user.name?.split(" ")[0] || "there";
      const workouts = user.totalWorkoutsCompleted || 0;
      const isLapsed = !!user.cancelledAt;
      let gateReply: string;
      if (isLapsed) {
        const cancelDate = new Date(user.cancelledAt!).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });
        const currentKg = user.currentWeight ? `${parseFloat(String(user.currentWeight)).toFixed(1)}kg` : null;
        const progressNote = workouts > 0 ? `${workouts} session${workouts !== 1 ? "s" : ""}${currentKg ? `, currently at ${currentKg}` : ""} — all saved.` : "";
        gateReply = `${name}, your subscription ended ${cancelDate}. ${progressNote}\n\nReply *pay* to pick up exactly where you left off.\n\n*R149/month — cancel anytime:*\n${payLink}`;
      } else if (workouts > 0) {
        gateReply = `${name}, reactivate to get your workouts, food coaching, and full programme back.\n\n*R149/month — cancel anytime:*\n${payLink}\n\nYour ${workouts} session${workouts !== 1 ? "s" : ""} and all progress are saved.`;
      } else {
        gateReply = `${name}, your programme is built and waiting.\n\n*Start today — R149/month (R5/day)*\n${payLink}\n\n_7-day money-back guarantee — if it's not working for you in the first week, full refund. No questions._`;
      }
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

  // ---- MEDICAL CONDITION / MEDICATION DISCLAIMER ----
  // When a client mentions medication, a new diagnosis, or asks for condition-specific advice —
  // return a clear disclaimer and redirect. Still logs (triggers escalation → coach alert).
  const MEDICATION_SIGNAL = /\b(on medication|taking medication|my medication|my meds|my pills|blood thinners|antiretroviral|ARVs?|antiretrovirals?|insulin|metformin|warfarin|blood pressure (pills?|medication|tablets?)|epilepsy (medication|tablets?|pills?)|seizure medication|newly diagnosed|just diagnosed|just found out i have|blood test results?|doctor said i have|specialist said)\b/i.test(m);
  const CHRONIC_CONDITION_SIGNAL = /\b(i have diabetes|i.?m diabetic|type [12] diabetes|my blood sugar|i have hypertension|i.?m hypertensive|my blood pressure is|i have (heart disease|a heart condition|kidney disease|liver disease|thyroid|pcos|epilepsy|hiv|aids))\b/i.test(m);
  if (MEDICATION_SIGNAL || CHRONIC_CONDITION_SIGNAL) {
    const medName = user.name?.split(" ")[0] || "";
    const medDisclaimer = `${medName}, noted. Coach K is a fitness and nutrition guide — not a medical professional. For anything involving medication, diagnoses, blood sugar, blood pressure, or condition-specific advice, your doctor or a registered dietitian must be your first stop.\n\nWhat Coach K *can* do: suggest food choices that are generally safe for your condition, keep exercise intensity appropriate, and hold you accountable to the habits your doctor recommends.\n\n*Important: Any nutrition or exercise guidance from Coach K does not replace medical advice. Always follow your doctor's instructions.*\n\nWhat specifically did you want help with on the fitness side?`;
    await logChat(user.id, message, medDisclaimer, "MEDICAL_DISCLAIMER");
    return medDisclaimer;
  }

  // ---- SEVERE FRUSTRATION EARLY-INTERCEPT — before ANY coaching/workout/food handlers ----
  // Catches frustration messages so the bot does NOT respond with a workout programme or payment link.
  // A single STRONG signal is enough to intercept — waiting for 2 signals caused the
  // "I'm not paying for this nonsense" → payment link bug (only 1 signal counted, fell through to payment handler).
  const STRONG_FRUSTRATION = /\b(not paying|won.?t pay|i.?m not paying|not worth the money|waste of money|this is rubbish|this is terrible|this is garbage|this is pathetic|this is useless|not worth it|i.?m done|i am done|giving up|shut down|shut it down|terrible service|bad service|doesn.?t work|nothing works|broken|scam|rip.?off)\b/i.test(m);
  const frustrationSignalCount = [
    /\b(useless|useless(ly)?)\b/i.test(m),
    /\b(terrible|pathetic|garbage|rubbish|broken|nothing works)\b/i.test(m),
    /\b(i.?m done|i am done|giving up|shut down|shut it down|i.?m out)\b/i.test(m),
    /\b(not paying|won.?t pay|i won.?t pay|i.?m not paying|nobody.?s paying|not worth)\b/i.test(m),
    /\b(this is a bot|it.?s a bot|just a bot|generic bot|just generic|robotic|generic man)\b/i.test(m),
    /\b(jesus christ|oh my god|oh god|oh dear|good god)\b/i.test(m),
  ].filter(Boolean).length;

  if (STRONG_FRUSTRATION || frustrationSignalCount >= 2) {
    const firstName = user.name?.split(" ")[0] || "";
    const lastBotMsgs = await db.select({ messageOut: chatHistory.messageOut, intent: chatHistory.intent })
      .from(chatHistory)
      .where(eq(chatHistory.userId, user.id))
      .orderBy(desc(chatHistory.createdAt))
      .limit(3);
    const lastIntent = lastBotMsgs[0]?.intent || "";
    const lastOut = (lastBotMsgs[0]?.messageOut || "").slice(0, 200);
    const streak = user.workoutStreak || 0;
    const totalW = user.totalWorkoutsCompleted || 0;
    const severeCtx = `You are Coach K. Client ${firstName || "this client"} just said: "${message}".\n\nYour last message (${lastIntent}): "${lastOut}"\n\nThey are frustrated with the quality of coaching or a specific response — NOT sick, NOT in crisis. They want better coaching, not wellness support.\n\nREAL DATA: ${totalW} total sessions logged. ${streak > 0 ? `${streak}-session streak.` : ""} Goal: ${user.goalType || "fat_loss"}. Protein target: ${user.proteinTarget || 130}g.\n\nWRITE TWO SENTENCES ONLY:\n1. Name the specific thing that went wrong or that they're unhappy about (based on your last message and their reaction)\n2. Give one concrete coaching action using their actual numbers above\n\nBANNED — never write any of these: "I hear you", "You need support", "Let's focus on", "Prioritize", "I understand your", "wellness", "recovery" (unless they said they were sick), "gentle walk", "be kind to yourself", "take care", "self-care", "feel free", "reach out"\n\nCoach K tone: direct, warm, SA voice. Two sentences. Nothing else.`;
    try {
      const severeReply = await withTimeout("gpt_severe", 20000, () => askCoachK(message, user, severeCtx));
      await logChat(user.id, message, severeReply, "SEVERE_FRUSTRATION");
      return severeReply;
    } catch (e) {
      const fallback = `${firstName ? `${firstName}, ` : ""}that response wasn't good enough. Your protein target is ${user.proteinTarget || 120}g today — log your next meal and I will track it accurately.`;
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


  // ---- FOOD LOG MANAGEMENT (reset, remove, show) ----
  const foodLogMgmtResult = await handleFoodLogMgmt(user, m);
  if (foodLogMgmtResult !== null) return foodLogMgmtResult;



  // ---- EARLY COMMANDS — instant answers, programme, holiday, shopping, etc ----
  const earlyResult = await handleEarlyCommands({ phone, message, m, user });
  if (earlyResult !== null) return earlyResult;

  // ---- MEDIA: IMAGE or AUDIO — exclusive branches, always return ----
  if (mediaUrl) {
    return handleMediaMessage({ phone, message, mediaUrl, mediaContentType, allMediaUrls, user, isCoach, openai, handleMessage });
  }


  // ---- WORKOUT COMMANDS (gym log, done, lifts, exercises, weight, programme) ----
  const workoutResult = await handleWorkoutCommands({ phone, message, m, user });
  if (workoutResult !== null) return workoutResult;

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
    if (!isNaN(steps) && steps > 0 && steps <= 100) {
      return `That step count looks off. Did you mean ${steps * 100} steps? Send your actual count — e.g. "8500 steps" or "walked 5km".`;
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
      invalidatePatternCache(user.id);
      const [perfectDay, streak] = await Promise.all([checkPerfectDay(user.id, user.proteinTarget || 130), getStepStreak(user.id)]);
      const stepReply = getStepResponse(steps, target, parseFloat(user.currentWeight as string || "75") || 75, streak);
      stepReplyPart = stepReply + (perfectDay || "");

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

  // ---- WATER LOGGING HANDLER ----
  const waterResult = await handleWater({ phone, message, m, user });
  if (waterResult !== null) return waterResult;

  // ---- FOOD CONTEXT (corrections, braai, eating out, relog, scanner, GPT fallback) ----
  const foodCtxResult = await handleFoodContext({ phone, message, m, user, stepReplyPart, handleMessage });
  if (foodCtxResult !== null) return foodCtxResult;

  // ---- PROGRESS CHECK ----
  const progressResult = await handleProgressCheck({ phone, message, m, user });
  if (progressResult !== null) return progressResult;

  const miscResult = await handleMiscCommands({ phone, message, m, user });
  if (miscResult !== null) return miscResult;


  const lifecycleResult = await handleLifecycle({ phone, message, m, user });
  if (lifecycleResult !== null) return lifecycleResult;


  // ---- GPT BLOCK — language detection, instruction building, agent routing ----
  return handleGptBlock({ phone, message, m, user, intentPromise });


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

// bumpVoiceFailure + clearVoiceFailure moved to handlers/media.ts

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
    registerVoiceBroadcastRoutes,
    registerHealthSyncRoutes,
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
  registerVoiceBroadcastRoutes(app);
  registerHealthSyncRoutes(app);

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

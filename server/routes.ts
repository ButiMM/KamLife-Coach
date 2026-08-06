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
import { buildDayWorkout, buildFullProgramme, getKamlifeProgramme, getDayType } from "./programme";
import { askCoachK, selectModel, buildPatternSummary, getSAContextFlags, isUnderGPTCallLimit, selectVisionModel, estimateVisionCostUSD, classifyIntent, type ClassifiedIntent, type IntentClassification } from "./gpt";
import { calculateTargets, getDailyStepContext } from "./targets";
import { handleOnboarding, getMenuText, getOnboardingMealPlan } from "./onboarding";
import { saysNotWorking } from "./despair";
import { getShoppingList, formatShoppingList } from "./shopping-lists";
import { nutritionAgent, programmingAgent, mindsetAgent, adminAgent, routeToAgent } from "./agents";
import { storeMemory, retrieveMemories } from "./memory";
import { generateVoiceNote, getVoiceFilePath, voiceFileExists } from "./tts";
import { sendWhatsApp } from "./scheduler";
import { recordConversion } from "./ab";
import { getStepStreak, getStepResponse as _getStepResponse } from "./handlers/steps";
import { captureFriction } from "./friction";
import { getSleepResponse } from "./handlers/sleep";
import { handleMediaMessage, bumpVoiceFailure, clearVoiceFailure } from "./handlers/media";
import { runSafetyGuards } from "./handlers/safety";
import { handleFoodLogMgmt } from "./handlers/food-log-mgmt";
import { bumpNumericFluency, bumpVoiceNoteUse } from "./handlers/numbers-literacy";
import { handleOnboardingBodyPhotos } from "./onboarding-physique";
import { verifyBrainReply } from "./brain/reply-verifier";
import { cardFontLoaded } from "./macro-card";
import { handleWater, tryLogWater } from "./handlers/water";
import { handleFoodContext } from "./handlers/food-context";
import { stripSignupSource } from "./signup-source";
import { captureSignupSource } from "./signup-capture";
import { JUNK_WORDS as _JUNK_WORDS, checkFoodPatterns, getDamageControlNote, checkPerfectDay } from "./handlers/checks";
import { scanForSAFoods, parseFoodLogTotalsFromMessageOut, sanitizeCoachReply, recomputeTodayFoodTotals } from "./handlers/food-scanner";
import { logChat, checkEscalation, logMediaFailure, logMediaSuccess, buildMediaTrace, withTimeout } from "./handlers/chat-log";
import { handleWeightLog } from "./handlers/weight";
import { handleWorkoutCommands } from "./handlers/workout";
import { getTodayWorkoutState } from "./workout-state";
import { handleMiscCommands } from "./handlers/misc-commands";
import { handleLifecycle } from "./handlers/lifecycle";
import { handleEarlyCommands } from "./handlers/early-commands";
import { handleReminderCommand } from "./handlers/reminders-handler";
import { handleGptBlock } from "./handlers/gpt-block";
import { runMeaningEngineLive, engineLive, resumeEngineConfirm } from "./understanding/live";
import { mustStayDeterministic } from "./understanding/action-router";
import { recordMessageSeen, recordReplyPath } from "./self-check";import { getDisplayName, checkGptRateLimit, sastDayStart, sastToday, parseMealDate, isRetroactiveMeal, mealDateLabel, isFutureIntent, normaliseMsisdn, stripInventedRetroDate, mentionsNotDone, looksLikeStepsReport, looksLikeWaterReport, looksLikeWeightReport, hasGoalChangeVocabulary, isBareGreeting, looksLikeStepsTargetChange, looksLikeBillingOrCancel, looksLikeDirectionRequest, looksLikeLowMobility, looksLikeDefeatedNoResults, looksLikeDigestiveIssue, looksLikeFoodDislike, looksLikeOvertrainingPlan, classifyPainReport, looksLikeWorkoutRequest } from "./utils";
import { invalidatePatternCache } from "./cache";
import { mentionsConditionOrMedication, conditionWelcome } from "./condition-welcome";

const openaiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
if (!openaiKey) {
  console.error("[FATAL] OPENAI_API_KEY is not set. Server cannot start without it.");
  process.exit(1);
}
const openai = new OpenAI({ apiKey: openaiKey });

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

// "log" and "logging" belong here: "I want to LOG yesterday" is the founder's own acceptance
// phrasing and named no eating word at all, so the token never armed for it.
const RETRO_TURN = /(?<day>\byesterday\b|\blast night\b)|(?<food>\b(?:ate|eat|eaten|had|log(?:ging|ged)?|breakfast|lunch|dinner|supper|snack|meals?)\b)/gi;

export async function handleMessage(phone: string, message: string, mediaUrl?: string, mediaContentType?: string, allMediaUrls?: string[], sourceMessageId?: string): Promise<string> {
  try {
  recordMessageSeen();  let m = message.toLowerCase().trim().replace(/[‘’“”]/g, "'").replace(/\s+/g, " ");

  // ---- SAFETY + DATA GUARDS (crisis, medical, terminal, delete, reset) ----
  const safetyResult = await runSafetyGuards(phone, message, m);
  if (safetyResult !== null) return safetyResult;

  const user = await getOrCreateUser(phone);

  // QR ACQUISITION SOURCE — a scanned join-QR prefills "(ref: gymA)"; capture once, then strip.
  if (!user.signupSource && !mediaUrl && message && (await captureSignupSource(user, phone, message))) {
    message = stripSignupSource(message);
    m = message.toLowerCase().trim().replace(/[‘’“”]/g, "'").replace(/\s+/g, " ");
  }

  // Page coach on crisis/injury signals immediately — fires even if onboarding/POPIA returns early
  if (message && message.length > 2) checkEscalation(user.id, message).catch(e => console.error("[ESCALATION_CHECK]", e?.message || e));

  // ---- INTENT CLASSIFIER — structural reset plan item #2 ----
  // Fire early as a background Promise. Text messages only (not photo/voice).
  // Awaited just before the final GPT routing (line ~6590) — by then it's complete.
  // On any error, returns { intent: "OTHER", confidence: 0 } — never blocks.
  const intentPromise: Promise<{ intent: ClassifiedIntent; confidence: number }> =
    (!mediaUrl && message.length >= 2 && message.length <= 500)
      ? classifyIntent(message, user.id).catch((e) => { console.error("[INTENT_CLASSIFY]", e?.message || e); return { intent: "OTHER" as ClassifiedIntent, confidence: 0 }; })
      : Promise.resolve({ intent: "OTHER" as ClassifiedIntent, confidence: 0 });

  // ---- DAY-ZERO PHYSIQUE READ — body photos sent during onboarding. handleOnboarding
  // is text-only (mediaUrl never reaches it), so this state's photos are claimed here.
  if (user.onboardingState === "ASK_BODY_PHOTOS" && mediaUrl && (mediaContentType || "").startsWith("image/")) {
    return handleOnboardingBodyPhotos({ user, phone, urls: allMediaUrls?.length ? allMediaUrls : [mediaUrl], openai });
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

  // ---- NUMERIC-FLUENCY DETECTOR (fire-and-forget) — a client who talks in
  // kcal/macros three times gets full numbers turned on automatically, with a
  // one-time notice sent separately. Never blocks or alters this reply. ----
  if (!mediaUrl && message.length >= 2) void bumpNumericFluency(user, m, phone);
  // Same shape for the other delivery dial: three inbound voice notes earns an OFFER
  // of voice replies (never an automatic switch — audio costs money per reply).
  if (mediaContentType?.startsWith("audio/")) void bumpVoiceNoteUse(user, phone);

  // RETRO CONTINUITY — "yesterday" has to survive the turn it was spoken in (2026-08-04 live).
  // 12:19 he said "I wanna tell you what I ate yesterday" and the coach said "go ahead". 12:21
  // he listed the food — with no date in it, because he had already given the date — and it was
  // logged to TODAY. The coach invited him into a conversation and forgot why.
  //
  // No new table: a profileNotes token, the same durable migration-free pattern as numbers:full
  // and voice:on. And no new date plumbing — food-context.ts has parsed "yesterday" out of a
  // message since July, so the pending day is applied by putting the word back into the message
  // the client would have said it in. Proven machinery, one token, nothing new to get wrong.
  if (!mediaUrl) {
    // One literal, two questions — the architecture guard refuses a second, and "did they name
    // a past day" and "did they mention eating" are one read of the same sentence.
    //
    // READ EVERY MATCH, NOT THE FIRST (2026-08-04, caught by the gauntlet the same day this
    // shipped). This was `RETRO_TURN.exec(m)?.groups`, and a /g regex read once returns only
    // the FIRST match — so "what I ate yesterday" matched "ate", reported day=undefined, and
    // never armed the token. The feature written this morning to fix the founder's 12:19/12:21
    // defect did not fire on the exact sentence it was written for.
    //
    // Worse, `exec` on a module-level /g literal ADVANCES lastIndex and keeps it, so the next
    // client's message started scanning from wherever the previous one stopped. The behaviour
    // depended on the message before it, across users. matchAll clones the regex internally,
    // which fixes the leak as well as the read.
    let saidYesterday = false, hasFoodWords = false;
    for (const hit of m.matchAll(RETRO_TURN)) {
      if (hit.groups?.day) saidYesterday = true;
      if (hit.groups?.food) hasFoodWords = true;
    }
    const pending = (user.profileNotes || "").includes("retro:pending");
    // They named the day but no food yet ("I want to tell you what I ate yesterday") — hold it.
    if (saidYesterday && hasFoodWords && scanForSAFoods(m).length === 0) {
      const base = (user.profileNotes || "").replace(/\s*\bretro:pending\b/gi, "").trim();
      void db.update(users).set({ profileNotes: base ? `${base} retro:pending` : "retro:pending" })
        .where(eq(users.phoneNumber, phone)).catch(() => {});
    } else if (pending && !saidYesterday && scanForSAFoods(m).length > 0) {
      // The food they promised, with no date on it. Put the day back and spend the token.
      message = `yesterday ${message}`;
      m = `yesterday ${m}`;
      const base = (user.profileNotes || "").replace(/\s*\bretro:pending\b/gi, "").trim();
      void db.update(users).set({ profileNotes: base || null }).where(eq(users.phoneNumber, phone)).catch(() => {});
      console.log(`[RETRO_CONTINUITY] ${phone.slice(-4)} — carried "yesterday" across the turn`);
    }
  }

  // ---- COACH / OWNER BYPASS — never paywall the coach's own number ----
  // Checks COACH_ALERT_PHONE and ADMIN_PHONE_OVERRIDE (either env var works)
  const coachPhone = (process.env.COACH_ALERT_PHONE || process.env.ADMIN_PHONE_OVERRIDE || "").replace(/\D/g, "");
  const userPhone = phone.replace(/^whatsapp:/, "").replace(/\D/g, "");
  const isCoach = !!(coachPhone && userPhone === coachPhone);
  if (isCoach && (user.subscriptionStatus === "inactive" || user.subscriptionStatus === "trial")) {
    await db.update(users).set({ subscriptionStatus: "active" }).where(eq(users.phoneNumber, phone));
    user.subscriptionStatus = "active";
  }

  // ---- COACH COMMAND: "replay" → run the rebuild scorecard, text it back ----
  // No shell for a non-technical founder: text "replay" (optionally "replay 50") and the
  // Meaning Engine is dry-run over real history, scored vs production, results sent here.
  if (isCoach) {
    // COACH COMMAND "version" → PROVE what's LIVE (a founder can't watch a deploy). Text the
    // live bot → running commit + a self-test the running code runs on itself.
    if (/^(version|deploy(?:ed)?|what.?version|whatami|running|self.?test|is it live)$/i.test(m.trim())) {
      const sha = (process.env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 7) || "unknown";
      const bootAt = new Date(Date.now() - process.uptime() * 1000).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
      const engine = process.env.ENGINE_LIVE === "on" ? "on" : "off";
      const freelance = !verifyBrainReply("To improve, incorporate exercises like rows and planks.", {}).ok;
      const myth = !verifyBrainReply("We'll shock the muscle with new movements to confuse it.", {}).ok;
      const mark = (ok: boolean) => ok ? "✅ BLOCKED" : "❌ SLIPS THROUGH";
      // MEAL-CARD health: font loaded + APP_URL has a scheme. Check the URL the card ACTUALLY
      // uses — cardBaseUrl() forces https:// when APP_URL lacks it, so testing the raw env var
      // reported a scary "card leaks as a link" while cards rendered fine (2026-07-27).
      const appUrlOk = /^https?:\/\/.+/i.test((await import("./macro-card-attach")).cardBaseUrl());
      const cardOk = cardFontLoaded && appUrlOk;
      return `🚀 *Running build*\nCommit: *${sha}* (${process.env.RAILWAY_GIT_BRANCH || "main"})\nBooted: ${bootAt} SAST · up ${Math.max(1, Math.round(process.uptime() / 60))} min\nEngine: ENGINE_LIVE=*${engine}*\n\n*Live self-test* (the running code checking itself now):\n• "incorporate exercises like rows and planks" → ${mark(freelance)}\n• "shock the muscle to confuse it" → ${mark(myth)}\n• Meal card → ${cardOk ? "✅ font loaded, image URL valid" : `⚠️ ${!cardFontLoaded ? "font NOT loaded (card text blank)" : "APP_URL missing https:// (card leaks as a link)"}`}\n\n${freelance && myth ? "The engine fix is LIVE." : "⚠️ Engine fix NOT live yet — give Railway a minute and send *version* again."}`;
    }

    // Founder reports: engagement, surface, audit (defects), outcomes (results), selfcheck (what's off).
    if (/^(?:engagement|retention|who.?s quiet|drop.?off)$/i.test(m.trim())) return await (await import("./audit/engagement-command")).engagementCommand();
    if (/^(?:surface|features?|what.?s used)$/i.test(m.trim())) return await (await import("./audit/surface-command")).surfaceCommand();
    if (/^(?:reply\s+)?audit(?:\s+\d{2,5})?$/i.test(m.trim())) return await (await import("./audit/reply-audit-command")).replyAuditCommand(m);
    if (/^(?:outcomes?|results?|does it work)(?:\s+\d{1,2})?$/i.test(m.trim())) return await (await import("./audit/outcomes-command")).outcomesCommand(m);
    if (/^(?:self.?check|what.?s (?:broken|off)|health)$/i.test(m.trim())) { const sc = await import("./self-check"); return sc.formatSelfCheck(sc.runSelfCheck()); }

    // ---- COACH COMMAND: "shadow" → review the engine's live action-decisions ----
    // The confirmation lap: in ENGINE_ACTIONS=shadow every real message's would-be action is
    // logged (dry-run, nothing written). This shows the recent ones so you can scan for a
    // wrong write before flipping to on — no Railway logs needed. "shadow 30" for more.
    const sh = m.trim().match(/^shadow(?:\s+(\d{1,2}))?$/i);
    if (sh) {
      const { recentShadowDecisions } = await import("./understanding/live");
      return await recentShadowDecisions(parseInt(sh[1] || "15", 10) || 15);
    }

    // ---- COACH COMMAND: "story <name/last4>" → a client's shareable transformation card ----
    // KamLife's biggest growth asset: the whole journey as data → a receipt you can share.
    const st = m.trim().match(/^(?:story|transformation)\s+(.+)$/i);
    if (st) {
      const { getTransformationStory } = await import("./transformation");
      return (await getTransformationStory(st[1])).whatsappText;
    }

    // ---- COACH COMMAND: "cohort" → the proof-cohort dashboard (day-30 retention + avg Δkg) ----
    // The two numbers that decide the business, so you can track your 10 people relentlessly.
    const co = m.trim().match(/^cohort(?:\s+(\d{1,2}))?$/i);
    if (co) {
      const { getCohortSnapshot } = await import("./transformation");
      return (await getCohortSnapshot(parseInt(co[1] || "15", 10) || 15)).whatsappText;
    }
  }

  // ---- BETA TESTER ALLOWLIST — comma/space/newline-separated numbers in BETA_TESTERS ----
  // Testers get a rolling non-expiring trial: full product access AND inclusion in the
  // scheduler's active-client set (so they receive proactive messages and can test
  // frequency), without ever hitting the 7-day trial wall. Kept as status="trial" (not
  // "active") so they still surface on the Beta Testers admin page. The Beta Testers
  // page advertises this env var — this is the code that finally enforces it.
  const betaTesterPhones = (process.env.BETA_TESTERS || "")
    .split(/[,\s]+/)
    .map(normaliseMsisdn)
    .filter(Boolean);
  const isBetaTester = !isCoach && betaTesterPhones.includes(normaliseMsisdn(userPhone));
  if (isBetaTester) {
    // Refresh the bypass on every message so a tester who goes quiet for a week is never
    // cut off — the moment they message again, access is extended a year out.
    const farBypass = new Date(Date.now() + 365 * 86_400_000);
    const bypassThin = !user.betaBypassUntil || new Date(user.betaBypassUntil) < new Date(Date.now() + 30 * 86_400_000);
    if (user.subscriptionStatus !== "active" && (user.subscriptionStatus !== "trial" || bypassThin)) {
      await db.update(users).set({ subscriptionStatus: "trial", betaBypassUntil: farBypass }).where(eq(users.phoneNumber, phone));
      user.subscriptionStatus = "trial";
      user.betaBypassUntil = farBypass;
    }
  }

  // ENGINE CONFIRM RESUME — a parked "reply *yes* to log it" lands here before any handler can
  // swallow a bare "yes" (2026-07-23 live: the confirm had no landing pad → "yes" looped). A
  // non-yes/no reply returns null and flows on to normal understanding.
  if (user.awaitingInputType === "engine_confirm") {
    const confirmReply = await resumeEngineConfirm({ phone, message, m, user, sourceMessageId, actionsLive: isCoach || isBetaTester });
    if (confirmReply !== null) return isCoach ? `${confirmReply}\n\n_· 🧠 new engine ·_` : confirmReply;
  }
  // ---- SUBSCRIPTION GATE — full product requires active subscription, no free tier ----
  // Safety messages (chest pain, crisis, emergency) always bypass.
  // Onboarding is handled before this point and bypasses via onboardingState check.
  const trialExpired = user.subscriptionStatus === "trial" &&
    user.betaBypassUntil && new Date(user.betaBypassUntil) < new Date();
  if ((user.subscriptionStatus === 'inactive' || trialExpired) && !isCoach && !isBetaTester) {
    const isSafety = /\b(chest pain|chest hurts?|chest is (tight|sore|aching|burning)|pain in my chest|chest tightness|can.?t breathe|shortness of breath|can.?t catch my breath|heart racing|heart pounding|dizziness|feeling faint|emergency|hospital|ambulance|crisis|suicid|hurt myself)\b/i.test(m);
    if (!isSafety) {
      const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
      const merchantId = process.env.PAYFAST_MERCHANT_ID;
      const cleanPhone = phone.replace(/^whatsapp:/, "");
      const payLink = merchantId ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}` : appUrl;
      const name = user.name?.split(" ")[0] || "there";

      // ---- CONVERSION OBJECTION HANDLERS — run before generic gate reply ----
      // Price questions, money objections, and hesitation/stall get tailored responses
      // that reframe cost and keep the door open instead of just re-showing a link.
      const { handleConversionObjection } = await import("./handlers/conversion");
      const conversionResult = handleConversionObjection({ user, m, payLink, name });
      if (conversionResult) {
        await logChat(user.id, message, conversionResult.reply, conversionResult.intent);
        return conversionResult.reply;
      }

      // ---- FOOD/EATING GUIDANCE GLIMPSE — show Day 1 as proof of value ----
      // Hard paywall replies to "what should I eat?" convert nobody — they haven't
      // seen the product yet. Show one personalised day (goal + budget + medical aware),
      // then gate Days 2–3 and the shopping list behind R199.
      const isFoodGuidanceQ = /\b(what should i eat|how should i eat|how do i eat|what do i eat|what to eat|meal plan|eating plan|diet plan|give me a meal plan|how do you suggest i eat|what can i eat|how to eat|tell me what to eat|what must i eat|what should i be eating|food plan|i don.?t know what to eat|no idea what to eat|don.?t know how to eat|eating guide|what foods should i|what food should i|nutrition plan)\b/i.test(m);
      if (isFoodGuidanceQ) {
        const { generateMealPlan } = await import("./meal-plan");
        const glimpsePlan = generateMealPlan({
          calorieTarget: user.calorieTarget || 1800,
          proteinTarget: user.proteinTarget || 120,
          weeklyFoodBudget: user.weeklyFoodBudget || "100_300",
          goalType: user.goalType || "fat_loss",
          medicalConditions: user.medicalConditions || "",
          otherMedicalNotes: user.otherMedicalNotes || "",
          recentFoods: [],
          firstName: user.name?.split(" ")[0] || "",
        });
        // Split: part[0] = header, part[1] = Day 1, part[2] = Day 2, part[3] = Day 3
        const planParts = glimpsePlan.split("\n\n---\n\n");
        const planHeader = planParts[0] || "";
        const day1 = planParts[1] || "";
        const upsell = `That is Day 1.\n\nDays 2 and 3 rotate the meals so you are not eating the same thing every day. Your weekly shopping list with ZAR prices is in there too.\n\n*Full weekly plan + shopping list + daily coaching — R199/month:*\n${payLink}\n\n_R6.63/day. Not satisfied after week 1? Message us and we will make it right._`;
        const glimpseReply = `${planHeader}\n\n${day1}\n\n---\n\n${upsell}`;
        await logChat(user.id, message, glimpseReply, "MEAL_PLAN_GLIMPSE");
        return glimpseReply;
      }
      const workouts = user.totalWorkoutsCompleted || 0;
      const isLapsed = !!user.cancelledAt;
      let gateReply: string;
      if (isLapsed) {
        const cancelDate = new Date(user.cancelledAt!).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });
        const currentKg = user.currentWeight ? `${parseFloat(String(user.currentWeight)).toFixed(1)}kg` : null;
        const progressNote = workouts > 0 ? `${workouts} session${workouts !== 1 ? "s" : ""}${currentKg ? `, currently at ${currentKg}` : ""} — all saved.` : "";
        gateReply = `${name}, your subscription ended ${cancelDate}. ${progressNote}\n\nReply *pay* to pick up exactly where you left off.\n\n*R199/month — cancel anytime:*\n${payLink}`;
      } else if (workouts > 0) {
        gateReply = `${name}, reactivate to get your workouts, food coaching, and full programme back.\n\n*R199/month — cancel anytime:*\n${payLink}\n\nYour ${workouts} session${workouts !== 1 ? "s" : ""} and all progress are saved.`;
      } else {
        gateReply = `${name}, your programme is built and waiting.\n\n*Start today — R199/month (R6.63/day)*\n${payLink}\n\n_Not satisfied after your first week? Message us and we'll make it right._`;
      }
      await logChat(user.id, message, gateReply, "SUBSCRIPTION_GATE");
      return gateReply;
    }
  }

  // ---- POST-MEDIA FOLLOW-UP: "I sent screenshot/voice" ----
  // Prevent vague GPT responses after a media upload by resolving against recent media events.
  // Runs AFTER onboarding/POPIA/subscription gates (it used to run before them, letting
  // mid-onboarding and unsubscribed users bypass the gates with one phrase) and only on
  // explicit delivery-check verbs — bare "check/look at" hijacked "check my progress photo".
  const asksAboutSentMedia = /\b(i (?:have )?sent|did you (?:get|receive)|you got|did (?:it|that) (?:go through|arrive))\b.{0,40}\b(screenshot|photo|image|pic|voice|audio|note)\b/i.test(m);
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


  // ---- HEART CONDITION CLEARANCE GATE ----
  // Users with heart_condition must confirm doctor clearance before receiving workouts
  if (user.doctorClearanceRequired && !/(doctor|cleared|clearance|got clearance|doctor said|my doctor|spoke to doctor|physician|cardiologist)/i.test(m)) {
    const conditions = (user.medicalConditions || "").split(",").map((s: string) => s.trim());
    if (conditions.includes("heart_condition")) {
      const name = getDisplayName(user) || "there";
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
    const name = getDisplayName(user) || "there";
    return `${name}, noted — doctor clearance confirmed. Your full programme is now unlocked. Let's get to work. Type *menu* to see today's workout.`;
  }

  // ---- MEDICAL CONDITION / MEDICATION DISCLAIMER ----
  // When a client mentions medication, a new diagnosis, or asks for condition-specific advice —
  // return a clear disclaimer and redirect. Still logs (triggers escalation → coach alert).
  if (mentionsConditionOrMedication(m)) {
    const welcome = conditionWelcome(user.name?.split(" ")[0] || "");
    await logChat(user.id, message, welcome, "MEDICAL_DISCLAIMER");
    return welcome;
  }

  // ---- FRUSTRATION HELPERS — shared intent guard used by both frustration handlers ----
  // Prevents frustration intercepts from swallowing clear action requests.
  // "Today's workout" + "Omg" in the same message → action wins, frustration is ignored.
  const HAS_CLEAR_ACTION = /\b(today.?s workout|my workout|workout|training session|log food|log steps|steps|my progress|shopping list|meal plan|menu|protein|calories|water)\b/i.test(m);

  // ---- BRIEF FRUSTRATION — short expressive outbursts with no action request ----
  // "Omg", "wtf", "ugh" fall through to GPT without this guard, and GPT sees recent workout
  // history and re-writes a hallucinated workout. Catch early, reply short and deterministically.
  const BRIEF_FRUSTRATION_RE = /^(omg+|o\.?m\.?g\.?|wtf|wth|ugh+|eish+|agg+|argh+|ffs|smh|seriously\??|come on\.?|what the hell\.?|what is this\.?|this is ridiculous\.?|not again\.?|unbelievable\.?|oh come on\.?|really\?+|for real\??|yoh+|yhoh+|haibo\.?)$/i;
  if (BRIEF_FRUSTRATION_RE.test(m.trim()) && !HAS_CLEAR_ACTION) {
    captureFriction("frustration", { userId: user.id, phone, messageIn: message, detail: "brief frustration outburst" });
    const _bfName = user.name?.split(" ")[0] || "";
    const _bfReply = `${_bfName ? `${_bfName}, ` : ""}what specifically didn't work? Tell me and I'll fix it.\n\nOr type *menu* to see your options.`;
    await logChat(user.id, message, _bfReply, "BRIEF_FRUSTRATION");
    return _bfReply;
  }

  // ---- SEVERE FRUSTRATION EARLY-INTERCEPT — before ANY coaching/workout/food handlers ----
  // Stops the bot replying to frustration with a workout programme or payment link. A single
  // STRONG signal intercepts (waiting for 2 caused "I'm not paying for this nonsense" → payment
  // link). HAS_CLEAR_ACTION guard: frustration + explicit request ("Today's workout omg it's not
  // working") → action wins. "broken"/"doesn't work"/"nothing works" are NOT single-signal (they
  // describe things — "my knee is broken") — they count in the 2-signal list below instead.
  const STRONG_FRUSTRATION = saysNotWorking(m) /* single-signal — see despair.ts */ || /\b(not paying|won.?t pay|i.?m not paying|not worth the money|waste of money|this is rubbish|this is terrible|this is garbage|this is pathetic|this is useless|not worth it|i.?m done|i am done|giving up|shut down|shut it down|terrible service|bad service|scam|rip.?off)\b/i.test(m);
  const frustrationSignalCount = [
    /\b(useless|useless(ly)?)\b/i.test(m),
    /\b(terrible|pathetic|garbage|rubbish|broken|nothing works|doesn.?t work)\b/i.test(m),
    /\b(i.?m done|i am done|giving up|shut down|shut it down|i.?m out)\b/i.test(m),
    /\b(not paying|won.?t pay|i won.?t pay|i.?m not paying|nobody.?s paying|not worth)\b/i.test(m),
    /\b(this is a bot|it.?s a bot|just a bot|generic bot|just generic|robotic|generic man)\b/i.test(m),
    /\b(jesus christ|oh my god|oh god|oh dear|good god)\b/i.test(m),
  ].filter(Boolean).length;

  // Days 31-40: when the engine is live it owns frustration/pushback moments — its
  // understand-first + "reduce shame" Constitution beats this ad-hoc prompt (the scorecard
  // won big here: "Okay no problem" 2.3→9.0). Deterministic frustration stays the fallback.
  if ((STRONG_FRUSTRATION || (!engineLive() && frustrationSignalCount >= 2)) && !HAS_CLEAR_ACTION) { // replay 30 Jul: engine lost ALL 3 pushback cases ("I'm not sick" 4.0 vs 5.7) — strong frustration keeps its prompt
    captureFriction("frustration", { userId: user.id, phone, messageIn: message, detail: "strong frustration / bot complaint" });
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

    // Detect when the complaint is about the BOT ITSELF being confusing/generic/useless
    // vs. frustration with a specific coaching output (wrong calories, bad workout, etc.)
    // When it's a bot-complaint, we must NOT pivot to workout instructions — that proves their point.
    const BOT_COMPLAINT = /\b(this (coach|bot|thing|it|app) is|you are just|you.?re just|just a (bot|calculator|robot|machine)|nothing makes sense|you are (useless|garbage|terrible|pathetic|nonsense|generic|confusing)|this is (nonsense|garbage|useless|terrible|pathetic)|confused calculator|generic (bot|coach)?|makes no sense|doesn.?t make sense|not making sense|whole lot of nonsense|a lot of nonsense)\b/i.test(m)
      || /\b(entire coach|whole (coach|bot)|this whole|this entire)\b/i.test(m);

    const severeCtx = BOT_COMPLAINT
      ? `You are Coach K. Client ${firstName || "this client"} just said: "${message}".

They are saying the ENTIRE COACH is confusing, generic, or not making sense — this is a complaint about the bot itself, not about one specific bad reply.

Your last reply was (${lastIntent}): "${lastOut}"

DO NOT suggest an exercise. DO NOT ask "What exercise will you start with?" DO NOT pivot to workout. That would prove their point that you are generic and confused.

WRITE TWO SENTENCES ONLY:
1. Acknowledge that your responses have been unclear or unhelpful — be direct and specific, not defensive
2. Name exactly ONE thing they can type right now to get something useful (e.g. "Type *today's workout* to get your programme" or "Type *menu* to see your options" — pick the most relevant for their goal: ${user.goalType || "fat_loss"})

BANNED — never write any of these: "What exercise will you start with?", "Let's get back on track", "Focus on today's workout", "I hear you", "You need support", "Let's focus on", "wellness", "recovery", "gentle walk", "be kind to yourself", "take care", "self-care", "feel free", "reach out"

Coach K tone: direct, accountable, SA voice. Two sentences. Nothing else.`
      : `You are Coach K. Client ${firstName || "this client"} just said: "${message}".

Your last message (${lastIntent}): "${lastOut}"

They are frustrated with a specific coaching response — NOT sick, NOT in crisis. They want better coaching, not wellness support.

REAL DATA: ${totalW} total sessions logged. ${streak > 0 ? `${streak}-session streak.` : ""} Goal: ${user.goalType || "fat_loss"}. Protein target: ${user.proteinTarget || 120}g.

WRITE TWO SENTENCES ONLY:
1. Name the specific thing that went wrong or that they're unhappy about (based on your last message and their reaction)
2. Give one concrete next step using their actual numbers above (e.g. a specific food to log, their actual protein number, a specific lift target — NOT a vague "let's get back on track" and NEVER "What exercise will you start with?")

BANNED — never write any of these: "What exercise will you start with?", "I hear you", "You need support", "Let's focus on", "Prioritize", "I understand your", "wellness", "recovery" (unless they said they were sick), "gentle walk", "be kind to yourself", "take care", "self-care", "feel free", "reach out"

Coach K tone: direct, warm, SA voice. Two sentences. Nothing else.`;

    try {
      const severeReply = await withTimeout("gpt_severe", 20000, () => askCoachK(message, user, severeCtx));
      await logChat(user.id, message, severeReply, "SEVERE_FRUSTRATION");
      return severeReply;
    } catch (e) {
      const fallback = BOT_COMPLAINT
        ? `${firstName ? `${firstName}, ` : ""}my responses clearly weren't making sense. Type *menu* to see exactly what I can do, or *today's workout* to get your programme.`
        : `${firstName ? `${firstName}, ` : ""}that response wasn't good enough. Type *menu* to see your options or tell me specifically what you need.`;
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


  // ---- FRONT-DOOR NORMALIZER — the classifier's verdict applied BEFORE routing ----
  // The brain decides what the message IS; the deterministic handlers stay the hands.
  // Messy human phrasing ("I want to go into a building phase", "Breakfast, four fish
  // fingers...") is rewritten into the canonical form the handlers were built for —
  // so infinite phrasing variety maps onto the finite patterns that log correctly.
  // Conservative: high confidence only, never accepts invented numbers, and the
  // original message always proceeds untouched on timeout/error. Killswitch: NORMALIZER=off.
  let normalizedQuestion = false;
  const originalMBeforeNorm = m; // save before any normalization rewrite — used for supplementary extraction
  if (process.env.NORMALIZER !== "off" && !mediaUrl && user.onboardingState === "COMPLETE" && !user.awaitingInputType) {
    try {
      const pre = await Promise.race([
        intentPromise,
        new Promise<{ intent: ClassifiedIntent; confidence: number; canonical?: string }>(res =>
          setTimeout(() => res({ intent: "OTHER" as ClassifiedIntent, confidence: 0 }), 3500)),
      ]);
      normalizedQuestion = pre.intent === "QUESTION" && pre.confidence >= 0.8;
      const ACTION_INTENTS = new Set<ClassifiedIntent>(["FOOD_LOG", "FOOD_PLANNED", "MEAL_COPY", "STEPS", "WORKOUT_LOG", "WEIGHT", "GOAL_CHANGE", "TOTALS_QUERY"]);
      let canon = ((pre as IntentClassification).canonical || "").trim();
      // Retrospective-weight brake: "last week it was 83kg", "I used to weigh 90kg",
      // "I started at 95kg" are HISTORICAL context, not today's weigh-in. The classifier
      // sees "83kg" and wants to rewrite it to a current WEIGHT log — which would overwrite
      // currentWeight, recalc targets off a past number, and print a bogus "down 0.3kg".
      // Drop the canonical so the original message falls through to a conversational reply.
      if (pre.intent === "WEIGHT" && /\b(last\s+(?:week|month|year|time)|used\s+to|back\s+(?:then|in|when)|previously|a\s+(?:week|month|year)\s+ago|(?:weeks?|months?|years?)\s+ago|started\s+(?:at|on|out|off)|when\s+i\s+(?:started|began|was)|before\s+i|in\s+\d{4}|earlier\s+this|was\s+\d{2,3}(?:\.\d+)?\s*kg)\b/i.test(originalMBeforeNorm)) {
        canon = "";
      }
      // Tense brake: FOOD_PLANNED is only valid when the CLIENT used future words.
      // A bare food list ("Lunch / Tin fish / Rice / Mixed veggies") is an eaten meal —
      // the most common logging format. If the classifier guessed future tense the
      // client never wrote, convert the canonical to past so the meal logs immediately
      // instead of being held hostage behind an "ate it" confirmation.
      if (pre.intent === "FOOD_PLANNED" && canon) {
        const FUTURE_RE = /\b(i.?ll\s+have|i\s+will|gonna|going\s+to|planning|will\s+be|later|tonight|this\s+evening|about\s+to|busy\s+(?:cooking|making)|in\s+the\s+oven|on\s+the\s+stove)\b/i;
        if (!FUTURE_RE.test(originalMBeforeNorm)) {
          canon = canon.replace(/\b(i.?m\s+)?(i.?ll\s+have|i\s+will\s+have|gonna\s+have|going\s+to\s+have|will\s+be\s+(?:eating|having))\b/gi, "i had");
        }
      }
      // GOAL_CHANGE keyword brake: rewriting into "change my goal to X" flips the ENTIRE programme +
      // targets — the most destructive normalizer output (2026-07-07 "10,000 steps now" became
      // "change my goal to fat loss"). Only honour it when the ORIGINAL has goal vocabulary; else drop.
      if (pre.intent === "GOAL_CHANGE" && !hasGoalChangeVocabulary(originalMBeforeNorm)) {
        console.log(`[NORMALIZER] GOAL_CHANGE brake — no goal vocabulary in "${originalMBeforeNorm.slice(0, 60)}" — dropping canonical`);
        canon = "";
      }
      // TOTALS_QUERY brake (2026-07-16 live): "how do my calories ADJUST when I'm sick?" is a
      // coaching QUESTION, not a totals lookup — reasoning vocabulary keeps the original message.
      if (pre.intent === "TOTALS_QUERY" && /\b(adjust|change|why|what happens|should|if i|when i.?m|sick|ill|holiday|rest|not (walking|training)|stay the same|missing the point)\b/i.test(originalMBeforeNorm)) {
        console.log(`[NORMALIZER] TOTALS brake — reasoning vocabulary in "${originalMBeforeNorm.slice(0, 60)}" — dropping canonical`);
        canon = "";
      }
      if (ACTION_INTENTS.has(pre.intent) && pre.confidence >= 0.75 && canon.length >= 3 && canon.length <= message.length * 2.5 + 20) {
        const canonLower = canon.toLowerCase();
        if (canonLower !== m) {
          // Hallucination brake: every number in the canonical must exist in the original. Number-
          // words whitelist ONLY their own derived values (singles, pairs, word+thousand compounds);
          // anything else fails closed to the original message (never invent a number, never lose data).
          const digitGroups = canonLower.match(/\d+/g) || [];
          const mStripped = m.replace(/[.,\s]/g, "");
          const WORD_VALS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000 };
          const wordVals = (m.match(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b/gi) || []).map(w => WORD_VALS[w.toLowerCase()]);
          const allowedNums = new Set<string>();
          wordVals.forEach((v, i) => {
            allowedNums.add(String(v));
            if (i + 1 < wordVals.length) {
              allowedNums.add(String(v + wordVals[i + 1]));
              allowedNums.add(String(v * wordVals[i + 1]));
              if (i + 2 < wordVals.length) allowedNums.add(String((v + wordVals[i + 1]) * wordVals[i + 2]));
            }
          });
          const inventsNumbers = digitGroups.some(d => !mStripped.includes(d) && !allowedNums.has(String(parseInt(d, 10))));
          // Retro-date brake: strip an invented "yesterday" the classifier added to a WORKOUT_LOG
          // canonical when the original had no temporal reference (else a same-day PB reads as retro).
          // NEW-FOOD vs REPEAT brake (2026-07-22 live): "...4 slices of pizza, add to yesterday" is
          // a NEW food to log — the normalizer rewrote it to a repeat, which copied the last meal
          // (tin fish) and needed shouting. Original names a quantified food + canon is a repeat →
          // drop canon, let the real logger parse the actual food (with its date + card).
          const origHasQuantifiedFood = /\b\d+\s*(?:slices?|pieces?|plates?|cups?|scoops?|tins?|cans?|bowls?|bars?|packets?|servings?)\b/i.test(originalMBeforeNorm);
          const canonIsRepeat = /\b(same|again|repeat|copy)\b/i.test(canon.toLowerCase());
          if (origHasQuantifiedFood && canonIsRepeat) {
            console.log(`[NORMALIZER] new-food brake — original names a quantified food but canon is a repeat — dropping "${canon.slice(0, 60)}"`);
            canon = "";
          }
          if (!inventsNumbers && canon) {
            if (pre.intent === "WORKOUT_LOG") {
              canon = stripInventedRetroDate(canon, originalMBeforeNorm);
            }
            console.log(`[NORMALIZER] ${pre.intent}(${Math.round(pre.confidence * 100)}%) "${message.slice(0, 80)}" → "${canon.slice(0, 80)}"`);
            message = canon;
            m = canon.toLowerCase().replace(/\s+/g, " ").trim();
          }
        }
      }
      // Supplementary extraction: when a GOAL_CHANGE is normalized, the canonical
      // captures the goal but drops other context from the original voice note.
      // Extract gym membership and body weight from the original and apply immediately
      // so the handler response references the correct training mode and targets.
      if (pre.intent === "GOAL_CHANGE" && pre.confidence >= 0.75) {
        const gymInOriginal = /\b(joined.*gym|back.*gym|back at.*gym|at.*gym|now.*gym|got.*gym|started.*gym|i.?ve.*joined|gym.*member)\b/i.test(originalMBeforeNorm);
        if (gymInOriginal && user.trainingMode !== "gym") {
          await db.update(users).set({ trainingMode: "gym" }).where(eq(users.phoneNumber, phone));
          user.trainingMode = "gym";
          console.log("[NORMALIZER] supplementary: training mode → gym from GOAL_CHANGE original");
        }
        const wtMatch = originalMBeforeNorm.match(/\bmy\s+(?:current\s+)?weight\s+(?:is\s+)?(\d{2,3}(?:\.\d+)?)\b/i)
          || originalMBeforeNorm.match(/\bi\s+(?:currently\s+)?weigh\s+(\d{2,3}(?:\.\d+)?)\s*kg/i);
        if (wtMatch) {
          const wt = parseFloat(wtMatch[1]);
          if (wt >= 30 && wt <= 300) {
            await db.update(users).set({ currentWeight: wt.toString() }).where(eq(users.phoneNumber, phone));
            user.currentWeight = wt.toString();
            console.log(`[NORMALIZER] supplementary: weight → ${wt}kg from GOAL_CHANGE original`);
          }
        }
      }
    } catch (normErr) { console.warn("[NORMALIZER] exception — original message proceeds:", normErr instanceof Error ? normErr.message : normErr); }
  }

  // ---- FOOD LOG MANAGEMENT (reset, remove, show) ----
  const foodLogMgmtResult = await handleFoodLogMgmt(user, m);
  if (foodLogMgmtResult !== null) return foodLogMgmtResult;



  // ---- SHOPPING / GROCERY LIST GUARD — must run BEFORE early commands ----
  // Detect grocery/pantry lists regardless of format: checkboxes [ ]/[x], bullets, dashes,
  // numbered lines, or plain one-item-per-line. The signal is: many short lines + no
  // eating verbs. Without this, the alcohol handler misreads "cider" in "apple cider vinegar"
  // and "drinks" in "soft drinks" as an alcohol log.
  const _msgLines = message.split("\n").map(l => l.trim()).filter(Boolean);
  const _cleanedItems = _msgLines
    .map(l => l.replace(/^(\[\s*[x✓\s]?\]|[-•*]|\d+[\.\)])\s*/, "").trim())
    .filter(l => l.length > 1 && l.length < 80);
  const _hasEatingContext = /\b(i had|i ate|i'm having|just had|just ate|for breakfast|for lunch|for dinner|for supper|this morning|had this)\b/i.test(m);
  const _isListFormat = _msgLines.filter(l => /^(\[\s*[x✓\s]?\]|[-•*]|\d+[\.\)])/.test(l)).length >= 4;
  // 75% threshold instead of `every` — one item with a parenthetical note like
  // "Chicken strips (I use these for wraps)" used to fail the `every(≤6 words)`
  // check and let a 25-item grocery list fall through to the food scanner, which
  // logged it as a 2330 kcal meal. Threshold catches real lists while allowing notes.
  const _shortItemFraction = _cleanedItems.length > 0
    ? _cleanedItems.filter(l => l.split(/\s+/).length <= 7).length / _cleanedItems.length
    : 0;
  const _isGroceryList = !_hasEatingContext && _cleanedItems.length >= 8 && (
    _isListFormat ||
    (_shortItemFraction >= 0.75 && _msgLines.length >= 10)
  );
  if (_isGroceryList) {
    const clientName = user.name?.split(" ")[0] || "there";
    let listReply: string;
    try {
      const { refineGroceryList } = await import("./grocery-refine");
      listReply = await refineGroceryList(_cleanedItems, user);
      if (!listReply) throw new Error("empty refine result");
    } catch (e) {
      console.warn("[GROCERY_REFINE]", e);
      listReply = `Got your list, ${clientName}. When you start eating, just send me what you have each day — a photo or a few words and I'll track the numbers.`;
    }
    await logChat(user.id, "[Shopping List]", listReply, "SHOPPING_LIST");
    return listReply;
  }

  // ---- FUTURE-INTENT WORKOUT GUARD — defer like a coach, don't dump the session ----
  // "I'll do today's workout tomorrow" is a PLAN, not a request to see the session now. The
  // Normalizer strips the tense ("tomorrow" → bare "today's workout"), so without this the
  // sentence matches the view trigger in early-commands and dumps the full workout.
  // Test the ORIGINAL pre-normalization message, and require a first-person future verb +
  // an explicit later-time word, so "tomorrow's session" / "next session" (legit future-view
  // commands) and "about to do my workout" (imminent) still reach the real handler. Stricter
  // than isFutureIntent() on purpose — bare "tomorrow" must not swallow "tomorrow's session".
  const _origWO = originalMBeforeNorm;
  const _isWorkoutDeferral =
    !_origWO.includes("?")
    && /\b(i'?ll|i\s+will|i'?m\s+going\s+to|i\s+am\s+going\s+to|gonna|going\s+to|plann?ing\s+(?:to|on)|plan\s+to)\b/i.test(_origWO)
    && /\b(workout|work\s*out|train(?:ing)?|session|gym|exercise|programme|program|leg\s+day|chest\s+day|upper\s+body|lower\s+body|push\s+day|pull\s+day)\b/i.test(_origWO)
    && /\b(tomorrow|later|tonight|this\s+evening|after\s+work|in\s+the\s+morning|next\s+week|2moro|2morrow)\b/i.test(_origWO)
    && !/\b(done|finished|completed|already\s+did|just\s+did|did\s+my|smashed|crushed)\b/i.test(_origWO);
  if (_isWorkoutDeferral) {
    const _woName = user.name?.split(" ")[0] || "";
    const _laterToday = !/\b(tomorrow|next\s+week|2moro|2morrow)\b/i.test(_origWO);
    const deferReply = _laterToday
      ? `${_woName ? _woName + ", n" : "N"}o rush — it'll be right here when you're ready. Just send *workout* and I'll pull up today's session 💪`
      : `${_woName ? _woName + ", n" : "N"}o stress — rest today, hit it fresh tomorrow 💪\n\nWhen you're ready, send *workout* and your session's ready. Today: protein in, keep moving.`;
    await logChat(user.id, message, deferReply, "WORKOUT_DEFERRED");
    return deferReply;
  }

  // TRANSACTION PREFLIGHT: a plain steps report must reach the deterministic logger
  // below. The prompt tells the brain to defer these, but on 2026-07-06 it answered
  // "Steps are 10000" from the snapshot (sounding perfectly right) and logged
  // NOTHING — five minutes later the coach claimed "your steps today aren't logged
  // yet". Code, not prompt, decides now; skipping the model on a pure transaction
  // also saves the call.
  // Detectors are pure + unit-tested in utils.ts ("had 2 beers" must never match
  // water; "bench 80kg 3x10" must never match weight). Question-guard stays here.
  const isTransactionReport = (!normalizedQuestion
    && (looksLikeStepsReport(m) || looksLikeWaterReport(m) || looksLikeWeightReport(m)))
    // MUTATIONS + MONEY skip the brain unconditionally (2026-07-10 audit): a steps-target
    // change must hit the deterministic updater (the brain "agreed" to 10k in chat,
    // saved nothing, and briefings kept saying 11k), and cancellation/billing must hit
    // the real subscription flow (the brain gave a limp condolence and cancelled nothing).
    || looksLikeStepsTargetChange(m)
    || looksLikeBillingOrCancel(m)
    // "Give me direction / what should I be doing today" → the deterministic, rest-day-
    // aware daily direction (2026-07-11: the brain answered these with contradicting
    // workout dumps — Upper Body A then B — minutes after the menu correctly said REST).
    || looksLikeDirectionRequest(m)
    // "I can't walk much / bad knees / wheelchair" → the deterministic low-mobility
    // accommodation (2026-07-12): a warm, consistent reassurance that results come from
    // the food deficit, plus a realistic step goal — not the brain improvising.
    || looksLikeLowMobility(m)
    // "It's my genetics / tried for years, no results" → Kam's exact defeated-client
    // reframe (2026-07-12), deterministic so this high-stakes emotional moment lands the
    // same way every time instead of a model paraphrase.
    || looksLikeDefeatedNoResults(m)
    // Health/coaching disclosures Kam handles a specific way (2026-07-12 onboarding
    // screenshots): GI issues (bloating/reflux → care + food guidance), a food they
    // hate (offer an alternative, never push it), and stating 5+ sessions/week (cap it).
    || looksLikeDigestiveIssue(m)
    || looksLikeFoodDislike(m)
    || looksLikeOvertrainingPlan(m)
    // Pain reports skip the brain (2026-07-12): soreness-vs-injury triage is high-stakes
    // and must be deterministic — the injury protocol, the DOMS reassurance, and the ONE
    // triage question in between all live in code, never a model paraphrase. Mid-triage
    // (awaiting the answer) also skips: "Sharp / stabbing" alone has no pain word.
    || classifyPainReport(m) !== null
    || String(user.awaitingInputType || "").startsWith("pain_triage:")
    // Natural workout requests ("home workout with two dumbbells", "videos of the
    // moves") → the deterministic programme with GIFs/buttons, never a model-improvised
    // wall of text (2026-07-13 tester screenshot).
    || looksLikeWorkoutRequest(m);
  // A bare "hello"/"menu" must reach the warm deterministic menu (getMenuText, with tap
  // buttons + today's context) below — NOT the model, which answers it generically and
  // button-less, differently every time (2026-07-10 audit). Content-carrying greetings
  // ("hi, I ate eggs") are not bare, so they still flow to the brain/handlers normally.
  // ---- EARLY COMMANDS — instant answers, programme, holiday, shopping, etc ----
  // ARCHITECTURE FLIP (2026-07-13, tester round 3): early-commands runs BEFORE the brain. The
  // brain-first order let the model front-run every phrasing that wasn't explicitly gated — bare
  // "Workout" got an improvised wall of text instead of the real programme. Deterministic code
  // OWNS its commands; the brain fronts only what no handler claims. The gates above still
  // protect messages owned by LATER handlers (steps/water/weight, direction, billing, pain).
  // ---- REMINDERS — a real capability the coach owns, before the keyword wall + brain so
  // nothing hijacks "remind me to take creatine at 8pm". Deterministic parser = a kept promise.
  const reminderResult = await handleReminderCommand({ phone, message, m, user });
  if (reminderResult !== null) return reminderResult;

  // THE HOIST (2026-07-30): Coach K runs BEFORE early-commands, media, workout and water. They
  // had first refusal; the coach was eighth — which is why ENGINE_ACTIONS has been `on` for weeks
  // with an EMPTY action log. Food logs still fall through to food-context below.
  const tag = (reply: string, src: string) => { recordReplyPath(src); return isCoach ? `${reply}\n\n_· ${src} ·_` : reply; }; // tag() is the one chokepoint all model paths cross
  // A FOOD LOG IS A COACHING MOMENT, NOT A RAIL (2026-08-04). The two conditions removed here
  // — isTransactionReport and "the message names a food" — were the other half of the lockout.
  // Between them and REPORTED_NUMBER, every single log a client sends bypassed the coach.
  if (engineLive() && !mustStayDeterministic(m, normalizedQuestion) && !mediaUrl && !isBareGreeting(m)) {
    const engineFront = await runMeaningEngineLive({ phone, message, m, user, openai, sourceMessageId, actionsLive: isCoach || isBetaTester });
    if (engineFront !== null) return tag(engineFront, "🧠 new engine");
  }

  const earlyResult = await handleEarlyCommands({ phone, message, m, user, hasMedia: !!mediaUrl, isQuestion: normalizedQuestion });
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
  // "12k steps", "8.5k steps", "12,000 steps", "12000 steps" — all valid
  // Also: "Fitbit says 8500", "health app: 9000", "steps today: 7500"
  const stepNumMatch = m.match(/\b([\d,]+(?:\.\d+)?)\s*k\s*(?:steps?|staps?)\b/i)
    || m.match(/\b([\d,]+)\s*(?:steps?|staps?)\b/i)
    || m.match(/(?:walked|done|did|logged)\s+([\d,]+(?:\.\d+)?k?)\s*(?:steps?|staps?)/i);
  // Device/app references without explicit "steps" keyword after the number
  // e.g. "Fitbit says 8500", "Health app: 9000", "steps today: 7500", "step count: 12k"
  const _devMatch = !stepNumMatch ? (
    m.match(/\b(?:fitbit|garmin|apple\s*health|health\s*app|samsung\s*health|google\s*fit|my\s*(?:watch|tracker|band|phone)|strava|polar|whoop|oura|mi\s*band|galaxy\s*watch)\b[^.!?]*?([\d,]+(?:\.\d+)?)\s*(k)?\s*(?:steps?|staps?)?/i)
    || m.match(/\bsteps?\s*(?:today|count|total|for\s*today)?\s*[:=]\s*([\d,]+(?:\.\d+)?)\s*(k)?\b/i)
  ) : null;
  const deviceStepMatch = (_devMatch && !/\b(?:heart\s*rate|bpm|pulse|calories?\s*burned|sleep\s*score|blood|oxygen)\b/i.test(m)) ? _devMatch : null;
  const hasKmWalk = m.match(/(?:walked|loop|walk)\s+([\d.]+)\s*km/i);
  const hasDurationWalk = !stepNumMatch && !deviceStepMatch && !hasKmWalk && m.match(/(?:walked|walk|walking)\s+(?:for\s+)?(\d+)\s*((min(?:ute)?s?|hrs?|hours?))/i);
  const stepIsKShorthand = !!m.match(/\b[\d,]+(?:\.\d+)?\s*k\s*(?:steps?|staps?)\b/i);
  // Spoken numbers — voice notes produce "ten thousand steps", "did twelve thousand steps"
  const WORD_THOUSANDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  };
  const wordThousandMatch = !stepNumMatch && !deviceStepMatch
    ? m.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+)\s+(and\s+a\s+half\s+)?thousand\s*(?:steps?|staps?)\b/i)
    : null;
  let stepReplyPart = ""; // stored so we can combine with food reply if needed
  // A step QUESTION ("is 8000 enough?") must reach GPT; an explicit step LOG ("walked 8000
  // steps", "12k steps") is unambiguous even with a trailing SEPARATE question. Split the two
  // so explicit logs survive a trailing "?" while genuine step-questions still route to GPT.
  const stepQuestionForm = /^(does|doesn.?t|do|don.?t|will|would|should|shouldn.?t|can|could|is|isn.?t|are|aren.?t|what|why|how|when|which)\b/i.test(m.trim())
    || /\b(affect|matter|enough|too\s+(?:much|many|few|little)|should\s+i|do\s+i\s+need|is\s+it\s+(?:ok|okay|bad|good|fine))\b/i.test(m);
  const stepIsQuestion = m.includes("?") || stepQuestionForm;
  const stepIsExplicitLog = !!(stepNumMatch || deviceStepMatch || hasKmWalk || wordThousandMatch);
  // Explicit logs ignore a trailing "?"; duration-only walks keep the strict guard.
  const stepIsLoggable = stepIsExplicitLog ? !stepQuestionForm : !stepIsQuestion;
  // Future-intent guard: "I'll walk 10k tomorrow" slips past the question check — must not log today.
  if (stepIsLoggable && !isFutureIntent(m) && !normalizedQuestion && !mentionsNotDone(m) && (stepNumMatch || hasKmWalk || hasDurationWalk || deviceStepMatch || wordThousandMatch)) {
    let steps = 0;
    if (wordThousandMatch) {
      const base = WORD_THOUSANDS[wordThousandMatch[1].toLowerCase()] ?? parseInt(wordThousandMatch[1]);
      steps = base * 1000 + (wordThousandMatch[2] ? 500 : 0);
    } else if (deviceStepMatch) {
      const num = parseFloat(deviceStepMatch[1].replace(/,/g, ""));
      steps = deviceStepMatch[2] ? Math.round(num * 1000) : Math.round(num);
    } else if (stepNumMatch) {
      const raw = stepNumMatch[1].replace(/,/g, "");
      steps = stepIsKShorthand ? Math.round(parseFloat(raw) * 1000) : Math.round(parseFloat(raw));
    } else if (hasKmWalk) {
      const km = Math.min(parseFloat(hasKmWalk[1]), 50); // cap at 50km (marathon+)
      steps = Math.round(km * 1300);
    } else if (hasDurationWalk) {
      let minutes = parseInt(hasDurationWalk[1]);
      const unit = hasDurationWalk[2]?.toLowerCase() || "";
      if (unit.startsWith("h")) minutes *= 60;
      steps = Math.round(minutes * 100);
    }
    // "Give me 5 steps to lose belly fat" — a bare "N steps" with no movement signal is the
    // NOUN steps, not a pedometer count. Only nag about a low count when they actually moved.
    const stepHasMovementSignal = !!(deviceStepMatch || wordThousandMatch || hasKmWalk || hasDurationWalk || stepIsKShorthand
      || /\b(walk(?:ed|ing)?|did|done|logged|hit|managed|got|reached|clocked)\b/i.test(m));
    if (!isNaN(steps) && steps > 0 && steps <= 100 && stepHasMovementSignal) {
      return `That step count looks low — did the message cut off? Send your actual count, e.g. "8500 steps" or "walked 5km".`;
    }
    if (!isNaN(steps) && steps > 100 && steps < 100000) {
      // Weekly AVERAGE reports ("my average this week is 6,400") are a summary, not
      // today's count — logging them as today corrupts the day AND the 7-day trend.
      // Coach on the week instead; clients may opt to report a weekly average only.
      if (/\b(average|avg)\b/i.test(m) || (/\b(this|last|past)\s+week(?:ly)?\b/i.test(m) && !/\btoday\b/i.test(m))) {
        const wkTarget = user.stepsTarget || 8500;
        const wkDiff = steps - wkTarget;
        const wkReply = `Weekly average noted: *${steps.toLocaleString()} steps/day* vs your ${wkTarget.toLocaleString()} target — ${wkDiff >= 0 ? "on target. Strong week 🔥" : `${Math.abs(wkDiff).toLocaleString()} short. One 15-minute walk a day closes that.`}\n\n_Daily counts or a weekly-average screenshot both work — whichever is easier for you._`;
        await logChat(user.id, message, wkReply, "STEP_WEEKLY_REPORT");
        return wkReply;
      }
      const baseStepsTarget = user.stepsTarget || 8500;
      // Detect whether client already worked out today so we can ease step demand.
      let workedOutToday = false;
      try { workedOutToday = (await getTodayWorkoutState(user)).alreadyDoneToday; } catch { /* non-critical */ }
      const { target, goalContext: stepGoalCtx } = getDailyStepContext(
        baseStepsTarget, user.goalType || "fat_loss", workedOutToday
      );
      const stepIsRetro = isRetroactiveMeal(message);
      const stepLoggedAt = stepIsRetro ? parseMealDate(message) : new Date();
      const stepDayStart = sastDayStart(stepLoggedAt);
      const stepDayEnd = new Date(stepDayStart.getTime() + 86_400_000);
      const existingStep = await db.select({ id: stepLogs.id, steps: stepLogs.steps })
        .from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, stepDayStart), lt(stepLogs.loggedAt, stepDayEnd)))
        .limit(1);
      // Allow a downward CORRECTION ("8000 steps not 50000", "wrong, 6k steps") to overwrite the
      // day's count. Normally we keep only the HIGHER number (clients re-log a growing daily
      // total), but an explicit correction must win in either direction. For "X not Y", X is the
      // affirmed value — pull it out so the position of "steps" in the sentence doesn't matter.
      const stepNotMatch = m.match(/\b([\d,]+)(\s*k)?\s*(?:steps?|staps?)?\s+not\s+[\d,]+/i);
      if (stepNotMatch) {
        const corrected = Math.round(parseFloat(stepNotMatch[1].replace(/,/g, "")) * (stepNotMatch[2] ? 1000 : 1));
        if (corrected > 100 && corrected < 100000) steps = corrected;
      }
      const isStepCorrection = !!stepNotMatch
        || /\b(wrong|actually|correction|i\s+meant|meant|should\s+be|mistake|typo|miscount|oops|my\s+bad)\b/i.test(m);
      if (existingStep.length > 0) {
        if (steps > (existingStep[0].steps ?? 0) || isStepCorrection) {
          await db.update(stepLogs).set({ steps }).where(eq(stepLogs.id, existingStep[0].id));
        }
      } else {
        await db.insert(stepLogs).values({ userId: user.id, steps, loggedAt: stepLoggedAt });
      }
      await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.phoneNumber, phone));
      invalidatePatternCache(user.id);
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      const [perfectDay, streak, recentStepLogs] = await Promise.all([
        checkPerfectDay(user.id, user.proteinTarget || 120, target),
        getStepStreak(user.id),
        db.select({ steps: stepLogs.steps }).from(stepLogs)
          .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sevenDaysAgo)))
          .orderBy(desc(stepLogs.loggedAt))
          .limit(7),
      ]);
      // Divide by days actually logged, not a flat 7 — a new client who logged 9k steps
      // on each of their first 3 days was told "7-day average: 3,857, below target".
      const weeklyAvg = recentStepLogs.length >= 3
        ? Math.round(recentStepLogs.reduce((s, r) => s + r.steps, 0) / recentStepLogs.length)
        : undefined;
      void stepGoalCtx; // used by getStepResponse via user.goalType
      const stepReply = getStepResponse(steps, target, parseFloat(user.currentWeight as string || "75") || 75, streak, weeklyAvg, user, workedOutToday);
      const stepRetroNote = stepIsRetro ? `\n_Logged to ${mealDateLabel(stepLoggedAt)}._` : "";
      stepReplyPart = (isStepCorrection ? `Fixed ✅ — step count updated to *${steps.toLocaleString()}*.\n\n` : "") + stepReply + stepRetroNote + (perfectDay || "");

      // COMPOUND: if the message ALSO carries food or water, don't return — every thing the
      // client told us in one breath must log. Steps ride along; water/food handlers append.
      const alsoHasFood = /\b(ate|had|having|eating|breakfast|lunch|dinner|supper|snack|eggs?|bread|toast|rice|chicken|pap|porridge|oats|milk|fish|pilchard|vienna|polony|cheese|yoghurt|banana|apple|mango|potato|beans|lentil|coffee|tea|juice|cereal|muesli|sandwich)\b/i.test(m);
      const alsoHasWater = looksLikeWaterReport(m);
      if (!alsoHasFood && !alsoHasWater) {
        await logChat(user.id, message, stepReplyPart, "STEP_LOG");
        return stepReplyPart;
      }
      // Food and/or water also present — log steps but continue down the pipeline
      await logChat(user.id, message, stepReplyPart, "STEP_LOG");
    }
  }

  // ---- WATER LOGGING HANDLER (compound-aware) ----
  // "an apple and a pear, and one litre of water" must log BOTH: water logs here, but if the
  // message also carries food, carry the water confirmation and let the food pipeline log the
  // meal — never return early and drop half of what the client told us.
  const waterHasFoodToo = scanForSAFoods(m).some(f => !/^water$/i.test(f.name));
  if (waterHasFoodToo) {
    const waterPart = await tryLogWater({ phone, message, m, user });
    if (waterPart !== null) {
      stepReplyPart += waterPart.replace(/\[BUTTONS:[^\]]*\]\s*$/, "").trim() + "\n\n";
    }
    // fall through — food-context logs the meal and prepends stepReplyPart
  } else {
    const waterResult = await handleWater({ phone, message, m, user });
    // Steps may have logged above and passed through ("8000 steps and 2L of water") —
    // carry that confirmation so the client sees BOTH logs, never just the second one.
    if (waterResult !== null) return stepReplyPart ? `${stepReplyPart.trim()}\n\n${waterResult}` : waterResult;
  }

  // ---- FOOD CONTEXT (corrections, braai, eating out, relog, scanner, GPT fallback) ----
  const foodCtxResult = await handleFoodContext({ phone, message, m, user, stepReplyPart, handleMessage, classifierQuestion: normalizedQuestion });
  if (foodCtxResult !== null) return foodCtxResult;

  // ---- WEIGHT FORECAST / TRAJECTORY ----
  // The anti-"it's a scam" tool: from the client's OWN logged food + steps vs their
  // maintenance, deterministic energy math (never the LLM) projects the scale. If they
  // logged a surplus, it says so — the plate, not the plan. Available to every client.
  if (/^(forecast|my forecast|weight forecast|trajectory|my trajectory|projection|my projection|am i on track|will i (lose|gain|drop|pick up)|how much (weight )?(will|am|would) i (going to |gonna )?(lose|gain|drop|pick up))\b/i.test(m.trim())) {
    const { getTrajectoryForUser } = await import("./trajectory-report");
    const report = await getTrajectoryForUser(user.id);
    if (report) return report.whatsappText;
  }

  // ---- PROGRESS CHECK ----
  // Days 31-40 rollout: when the engine is live it OWNS the "how am I doing / my progress"
  // conversation — snapshot-grounded (real numbers injected) and sick-aware, so it stops
  // the old advisory template's training-push at a sick client. The deterministic progress
  // stays the fallback (ENGINE_LIVE=off reverts instantly). Advisory-only, so nothing is
  // lost by deferring it.

  const miscResult = await handleMiscCommands({ phone, message, m, user, isQuestion: normalizedQuestion });
  if (miscResult !== null) return miscResult;


  const lifecycleResult = await handleLifecycle({ phone, message, m, user, isQuestion: normalizedQuestion });
  if (lifecycleResult !== null) return lifecycleResult;


  // ---- ENGINE, second pass: the backstop for what the handlers above declined. Fail-open.
  if (engineLive() && !mediaUrl && !isTransactionReport && !isBareGreeting(m)) {
    const engineReply = await runMeaningEngineLive({ phone, message, m, user, openai, sourceMessageId, actionsLive: isCoach || isBetaTester });
    if (engineReply !== null) return tag(engineReply, "🧠 new engine");
  }

  // MODEL_BRAIN path deleted 2026-07-30. Two paths answer a client: the engine, then gpt-block.
  // ---- GPT BLOCK — language detection, instruction building, agent routing ----
  const gptReply = await handleGptBlock({ phone, message, m, user, intentPromise });
  return tag(gptReply, "gpt fallback");


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
    registerFinanceRoutes,
    registerPaymentRoutes,
    registerCoachRoutes,
    registerVoiceBroadcastRoutes,
    registerHealthSyncRoutes,
    registerWorkoutViewerRoutes,
  } = await import("./routes/index");
  const { registerAdminMetrics } = await import("./routes/admin-metrics");
  const { registerAdminOutcomes } = await import("./routes/admin-outcomes");
  const { registerAdminClient } = await import("./routes/admin-client");
  const { registerAdminQr } = await import("./routes/admin-qr");

  // Deps that route modules need from this file
  const routeDeps = { handleMessage, logChat, checkRateLimit };

  // Macro-card image route (2026-07-21): Twilio fetches a meal-log card PNG as media.
  (await import("./card-store")).registerCardRoute(app);

  // Register all modular routes
  registerAuthRoutes(app);
  registerHealthRoutes(app);
  registerAdminRoutes(app, routeDeps);
  registerAdminMetrics(app);
  registerAdminOutcomes(app);
  registerAdminClient(app);
  registerAdminQr(app);
  registerWhatsAppRoutes(app, routeDeps);
  registerDashboardRoutes(app, routeDeps);
  registerFinanceRoutes(app);
  registerPaymentRoutes(app);
  registerCoachRoutes(app);
  registerVoiceBroadcastRoutes(app);
  registerHealthSyncRoutes(app);
  registerWorkoutViewerRoutes(app);

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

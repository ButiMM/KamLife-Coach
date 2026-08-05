import { db } from "../db";
import { dailyMacroCardMarker } from "../macro-card-attach";
import { whichMacroAsked, macroStatusReply } from "../macro-status";
import { reportCardMarker } from "../report-card";
import { users, workoutLogs, chatHistory, mealLogs, stepLogs } from "../../shared/schema";
import { eq, and, gte, desc, count, sql } from "drizzle-orm";
import { SA_FOODS_SEED } from "../foods";
import { buildDayWorkout, buildFullProgramme, getKamlifeProgramme } from "../programme";
import { calculateTargets, stepBurnKcal, recalcTargetsForProfile } from "../targets";
import { askCoachK } from "../gpt";
import { getShoppingList, formatShoppingList } from "../shopping-lists";
import { getGroceryPersonalization } from "../grocery-personalize";
import { sendWhatsApp } from "../scheduler";
import { scanForSAFoods, recomputeTodayFoodTotals, invalidateFoodTotalsCache } from "./food-scanner";
import { logChat, withTimeout } from "./chat-log";
import { tryLogWater } from "./water";
import { getMenuText, getOnboardingMealPlan } from "../onboarding";
import { replyWithButtons } from "../twilio-interactive";

// The 3 quick actions on the menu (WhatsApp caps quick-reply buttons at 3). Tapping one sends its
// exact label as a message, which the deterministic handlers already understand.
const MENU_BUTTONS = ["Log food", "Today's workout", "My progress"];
import { getPrimaryWorkoutGifUrl } from "../exercise-media";
import { getProgressiveOverloadContext } from "./checks";
import { sastDayStart, parseMealDate, isRetroactiveMeal, mealDateLabel, extractStepTargetChange, looksLikeLowMobility, looksLikeDefeatedNoResults, looksLikeDigestiveIssue, looksLikeFoodDislike, looksLikeOvertrainingPlan, looksLikeWorkoutRequest, parseSickDays, isReturnFromSicknessQuestion, nextDayDate, isMultiPartAsk , spaceName} from "../utils";
import { educationNote, remainingInMeals } from "../education";
import { getTodayWorkoutState, getTodaySlot } from "../workout-state";
import { generateMealPlan } from "../meal-plan";
import { handleMealRepeat } from "./meal-repeat";
import { resolvePainTriage } from "./pain-triage";
import { handleSickFlow, looksSickMention } from "./sick-flow";
import { handleNumbersLiteracy, handleToneSignal, handleSurplusDeficitQuestion, handleVoiceReplyPreference } from "./numbers-literacy";
import { answerSwapAsk, answerUnavailable } from "../food-swaps";
import { matchRestaurant, formatRestaurantGuide, listRestaurantNames } from "../restaurants";
import { matchStreetDish, isStreetContext, formatStreetDish, streetGuide } from "../street-food";
import { handleAdviceCommands } from "./advice-commands";
import { handleFoodCommands } from "./food-commands";

// In-memory maps for holiday/travel equipment mode — module-level so they
// persist across requests (same process lifetime as the original routes.ts).
export const tempEquipmentMode = new Map<string, string>();
export const awaitingEquipmentAnswer = new Map<string, boolean>();

export async function handleEarlyCommands(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
  hasMedia?: boolean;
  /** SYSTEMIC GATE: classifier says this is a QUESTION (conf >= 0.8). Handlers with
   *  SIDE EFFECTS (log, flip mode, dump content) must not fire — questions go to the
   *  coach. This is the structural fix for the keyword-hijack failure class. */
  isQuestion?: boolean;
}): Promise<string | null> {
  const { phone, message, m, user } = ctx;
  const firstName = user.name?.split(" ")[0] || "";

  // ---- PAIN TRIAGE ANSWER — sharp-vs-sore reply resolver (handlers/pain-triage.ts).
  // Runs FIRST and only when mid-triage; otherwise returns null and we fall through.
  const triageResolved = await resolvePainTriage({ message, m, user });
  if (triageResolved !== null) return triageResolved;
  // UNDERSTANDING BEFORE KEYWORDS: a sick/hurt person is heard FIRST, before any dumb keyword command (BACK_TO_GYM etc.) can grab the message. Used to run at the BOTTOM of this file — a thousand lines of pattern-matchers got first crack, and one told a sick client to train (2026-07-18). Safety is a front-door concern.
  const sickFront = await handleSickFlow({ message, m, user, capName: firstName || "there" });
  if (sickFront !== null) return sickFront;

  // ---- PORTION CONTROL / HOW TO MEASURE — hand-portion method, goal-aware ---- The #1 post-onboarding question. We deliberately DON'T teach calorie counting or food scales — research and retention
  // both favour the hand method: always available, sized to the body, sustainable. Anxious trackers especially need the pressure taken off. Runs BEFORE the calorie-target INSTANT ANSWER block so "how
  // do I count calories" gets the METHOD, not just their target number. Target-number phrasings ("calories left", "my calorie target") contain no measure/count/portion words and fall through correctly.
  const isPortionControlQ =
    /\b(portion control|portion size|portion sizes|portioning|how big.*portion|portions? (right|correct|properly|wrong))\b/i.test(m)
    || /\bhow (do|can|should|would) i (measure|count|track|weigh|portion|estimate|work out|know how much|gauge)\b/i.test(m)
    || /\bhow much (should i|do i|must i|to) (eat|serve|dish|put on|have|portion)\b/i.test(m)
    || /\bhow many calories.*\b(count|counting|measure|track|tracking|know|do i count)\b/i.test(m)
    || /\b(do|should) i (need to |have to )?(weigh|measure|count|be counting|be weighing|be measuring|track)\b.{0,20}\b(food|portions?|calories|macros|meals?|everything)\b/i.test(m)
    || /\b(how do i|how to)\s+(count|track|measure|weigh)\s+(my\s+)?(calories|macros|food|portions?|meals?)\b/i.test(m)
    || /\b(measuring|counting|weighing)\s+(my\s+)?(food|portions?|calories|meals?)\b/i.test(m)
    || m === "portion control" || m === "portions" || m === "portion size";
  if (isPortionControlQ) {
    const goal = user.goalType || "fat_loss";
    const cal = user.calorieTarget || 1800;
    const prot = user.proteinTarget || 120;
    const nm = firstName ? `${firstName}, ` : "";
    let portionReply: string;
    if (goal === "muscle_gain") {
      portionReply = `${nm}great question — and here's the surprise: *I don't want you counting calories or weighing food.* That gets obsessive and people quit. We use your hand instead — it's always with you and it's sized to your body.\n\n*Per meal, to build muscle:*\n🖐 *Protein* (chicken, mince, eggs, fish) — *2 full palms*. Non-negotiable.\n🤲 *Carbs* (pap, rice, sweet potato, oats) — *2 cupped hands*. This fuels the growth.\n✊ *Veg* — 1 fist.\n👍 *Fats* (oil, peanut butter, avo) — 1–2 thumbs.\n\n*The mistake to avoid:* eating too LITTLE. To build, you fill the plate. If the scale isn't moving up over 2 weeks, add another cupped hand of carbs.\n\nYour target is *${cal} kcal · ${prot}g protein* — but build every plate like that and you hit it automatically. No app, no scale. Trust the hand. 💪`;
    } else if (goal === "recomposition") {
      portionReply = `${nm}most important question you've asked — and I'm going to surprise you: *I don't want you counting calories or weighing food.* You'll burn out in two weeks doing that. We use your hand instead. It's always with you and it's sized to your body.\n\n*Build every plate like this:*\n🖐 *Protein* (chicken, mince, eggs, fish) — *2 palms*. This is your priority — it builds muscle AND keeps you full.\n✊ *Veg* — 1–2 fists. As much as you want.\n🤲 *Carbs* (pap, rice, sweet potato) — 1 cupped hand normally, *2 on training days*.\n👍 *Fats* (oil, peanut butter, avo) — 1–2 thumbs.\n\nThat's it. No counting, no scale. Build every plate like that and you're automatically in range.\n\nYour number exists — *${cal} kcal · ${prot}g protein* — and I've got it. But trust the hand. It's the thing you'll still be doing a year from now. 💪`;
    } else {
      portionReply = `${nm}most important question — and I'm going to surprise you: *I don't want you counting calories or weighing food.* It gets obsessive, and people quit within two weeks. We use your hand instead — it's always with you and it's sized to your body.\n\n*Build every plate like this:*\n🖐 *Protein* (chicken, eggs, fish, mince) — *1–2 palms*. Keeps you full and protects muscle while you lose fat.\n✊ *Veg* (cabbage, spinach, broccoli) — *2 fists*. As much as you want — basically free.\n🤲 *Carbs* (pap, rice, sweet potato) — *1 cupped hand*.\n👍 *Fats* (oil, peanut butter, avo) — 1 thumb.\n\nThat's the whole system. No app, no scale.\n\nYour number exists — *${cal} kcal · ${prot}g protein* — and I've got it for you. But the hand gets you there without the stress, and it's the thing you'll actually still be doing in 6 months. 👌`;
    }
    // Shared closer for every goal: explain the two guides + make clear portions flex with
    // hunger, training load and how the program is tracking — a starting point, not strict law.
    portionReply += `\n\n📌 *Two guides coming below — save them:*\n1️⃣ *What counts as what* — is it a protein, a veg, a carb or a fat\n2️⃣ *Build your plate* — how much of each goes on\n\nThese are a starting point, not strict rules. Hungry day or training hard? Eat a bit more. Quiet day? Pull it back. Your body, your program and how you're feeling all matter — so just keep logging your meals like normal and I'll help you fine-tune as we go. 👌`;
    // Hand card rides first, plate poster second. WhatsApp sends one image per message, so the
    // send path (sendParts) fans these out as two separate cards after the text.
    const handGuideUrl = "https://res.cloudinary.com/dkxpypiak/image/upload/v1780499905/WhatsApp_Image_2026-06-03_at_16.16.16_i4ryyq.jpg";
    const plateGuideUrl = "https://res.cloudinary.com/dkxpypiak/image/upload/v1780499901/WhatsApp_Image_2026-06-03_at_16.16.33_xxvjbe.jpg";
    await logChat(user.id, message, portionReply, "PORTION_CONTROL");
    return `${portionReply}\n[MEDIA:${handGuideUrl}]\n[MEDIA:${plateGuideUrl}]`;
  }

  // ---- SURPLUS/DEFICIT QUESTIONS — computed, never generated; before the totals card ----
  const surplusReply = await handleSurplusDeficitQuestion({ message, m, user });
  if (surplusReply !== null) return surplusReply;

  // ---- SWAP ASKS ("instead of mayo?") — the swap table answers; before the totals card ----
  const swapAnswer = answerSwapAsk(m, user.goalType);
  if (swapAnswer !== null) { await logChat(user.id, message, swapAnswer, "SWAP_ASK"); return swapAnswer; }

  // ---- "THE SHOP DIDN'T HAVE IT" — a different question from the swap above (2026-08-05).
  // The swap table answers "this is worse for your goal, eat that instead". This answers
  // "chicken was finished, is mince alright" — the one a client actually asks, standing in a
  // Shoprite aisle, needing an answer in one second. Deterministic: substitution is a lookup,
  // not a judgement, and it costs nothing. Checked AFTER the goal swap so an ordinary
  // "instead of X" still gets the health answer it always did.
  const subAnswer = answerUnavailable(message);
  if (subAnswer !== null) { await logChat(user.id, message, subAnswer, "SUBSTITUTION"); return subAnswer; }

  // ---- INSTANT ANSWERS — cached from DB, zero GPT cost ----
  // ---- WEEKLY / MONTHLY REPORT CARD (2026-07-22) — the shareable scorecard. Matched BEFORE the
  // calorie block so "my week"/"my month" don't get read as a calorie query. Question-safe: it's a
  // read-only summary, so it fires even when the classifier flags a question.
  if (
    /\b(my week|weekly (report|scorecard|card|summary|recap)|week (report|card|scorecard)|this week.?s? (report|card|scorecard|summary))\b/i.test(m) ||
    /\b(my month|monthly (report|scorecard|card|summary|recap)|month (report|card|scorecard)|report card|scorecard|my (monthly )?scorecard)\b/i.test(m)
  ) {
    const isMonth = /\bmonth|report card\b/i.test(m);
    const first = user.name ? `${user.name.split(" ")[0]}, ` : "";
    const marker = await reportCardMarker(user, isMonth ? "month" : "week");
    const period = isMonth ? "month" : "week";
    const reply = marker
      ? `${first}here's your ${period} 👇 Save it, share it — this is your progress.${marker}`
      : `${first}nothing to report for the ${period} yet — log a few meals and workouts and your ${period} scorecard will fill up. 💪`;
    await logChat(user.id, message, reply.replace(/\s*\[MEDIA:[^\]]+\]/g, ""), isMonth ? "MONTHLY_REPORT" : "WEEKLY_REPORT");
    return reply;
  }

  // MACRO STATUS — "how are my fats looking? is it bad?" is a NUMBERS question and must be
  // answered from the card's own rows, never the model (2026-07-23 live: card said Fat 88/86g
  // OVER, engine said "~100g, within a reasonable range" — wrong number AND wrong verdict).
  {
    const which = whichMacroAsked(m);
    if (which) {
      const { todayRows } = await import("../macro-card-attach");
      const t = await todayRows(user).catch(() => null);
      if (t) {
        const reply = macroStatusReply(t.rows as any, which, user.name?.split(" ")[0]);
        await logChat(user.id, message, reply, "MACRO_STATUS");
        return reply;
      }
    }
  }

  if (
    /\b(daily calories|calorie target|calories target|my calories|my calorie|kcal target|daily kcal)\b/i.test(m) ||
    /\b(calorie|calories|kcal)\b.*\b(target|goal|limit|daily|mine|my|remaining|left|still|remain)\b/i.test(m) ||
    // A SINGLE-FACT HANDLER MAY NOT CLAIM A MULTI-PART QUESTION (2026-07-29 live, and this is
    // the worst thing this product has done). A voice note asking four things — "how many
    // workouts have I done this week, what's the way forward coming back from illness, tell me
    // about my calories and what I need to eat" — matched `how many .* calories` because the
    // `.*` spans the whole message. It answered the calorie part and silently discarded the
    // rest, then told the client it hadn't caught the voice note. It had; it printed the
    // transcript directly above.
    //
    // A long message with several asks belongs to the brain, which can hold all of them. These
    // gates only claim a message that is actually just this one question.
    !isMultiPartAsk(m) && (
    /\b(daily|my|total|remaining)\b.*\b(calorie|calories|kcal)\b/i.test(m) ||
    /\b(how many|how much).*(calorie|calories|kcal|left|remaining)\b/i.test(m) ||
    /\b(calories today|today.?s calories|today calories|calories for today|protein today|what.?s left|whats left|calories left|calories remaining|remaining calories|total remaining|how much.*left|how much.*remaining|can i still eat|what can i eat|how much more|am i over|what (have|did) i (eat|ate|log|track)|food today|what i (ate|ate today|had today)|today.?s food|today.?s intake|today.?s totals?|total today|totals today|macros today|today.?s macros?|today.?s progress|progress today|daily progress|today.?s summary|my day so far|how.?s my day|how is my day|how am i doing today|where am i today)\b/i.test(m) ||
    m === "calories" || m === "calorie" || m === "kcal" || m === "remaining" || m === "what's left" ||
    m === "today's calories" || m === "todays calories" || m === "today's food" || m === "today's intake" ||
    // TODAY beats the week (2026-07-28 live: "Today's progress" found no deterministic owner and
    // fell all the way through to the model, which then produced its OWN numbers about his day —
    // the one thing that must never happen. The button says "My progress" and means the week;
    // anything carrying "today" means today, and today is the card.)
    m === "today's progress" || m === "todays progress"
    )
  ) {
    const cal = user.calorieTarget || 1800;
    const prot = user.proteinTarget || 120;
    const name = user.name ? `${user.name}, ` : "";
    try {
      // Always recompute from mealLogs (primary) — covers quick_relog, GPT logs, scanner logs
      const totals = await recomputeTodayFoodTotals(user.id);
      const todayCals = totals.calories;
      const todayProt = totals.protein;
      const remaining = cal - todayCals;
      const protRemaining = prot - todayProt;
      if (todayCals > 0) {
        const calDone = remaining <= 0;
        const protShortNote = calDone && protRemaining > 0 ? ` ${protRemaining}g protein short — carry to tomorrow.` : "";
        const actionLine = calDone ? "" : `\n\nHit protein first — everything else follows.`;
        const inMeals = remaining > 0 ? remainingInMeals(remaining) : "";
        const eduNote = educationNote(user, { event: "totals", calorieTarget: cal, proteinTarget: prot, overBy: remaining < 0 ? -remaining : 0 });
        // "Show me my daily calories" → the branded card too (macro goals; "" for wellness).
        const dailyCard = await dailyMacroCardMarker(user);
        // THE CARD IS THE ANSWER (2026-07-28 live). This block used to print every number the
        // card already carries — totals, targets, what's left — plus an instruction, plus an
        // education line, and THEN attach the card. The client read their day twice and the same
        // order four times. When the card is coming it IS the report; the text is one plain
        // sentence so a person knows what they're looking at. Same rule as the food log path,
        // which was fixed two commits before this one and left this call site untouched.
        if (dailyCard) {
          const lead = remaining > 0
            ? `${name}here's your day so far. *${remaining} kcal and ${protRemaining > 0 ? `${protRemaining}g protein` : "protein done"}* left.`
            : `${name}here's your day. *Calorie target reached.*${protShortNote}`;
          return `${lead}${dailyCard}`;
        }
        return `${name}*Today so far: ${todayCals} kcal | ${todayProt}g protein*\nTarget: ${cal} kcal | ${prot}g protein\n${remaining > 0 ? `\n*${remaining} kcal and ${protRemaining > 0 ? protRemaining + "g protein" : "✅ protein hit"}* still to go${inMeals ? ` — ${inMeals}` : ""}.` : `\nCalorie target reached. ✅${protShortNote}`}${actionLine}${eduNote}`;
      }
      return `${name}${cal} calories and ${prot}g protein daily. Hit protein first — everything else follows.\n\nNo food logged yet today. Tell me what you ate.`;
    } catch (err) {
      console.error("[CALORIE_QUERY] recomputeTodayFoodTotals failed:", err);
      return `${name}Target: ${cal} kcal | ${prot}g protein daily.\n\nCouldn't load today's totals right now — try again in a moment.`;
    }
  }

  if (/\b(protein)\b.*\b(target|goal|daily|mine|my)\b/i.test(m) || m === "my protein" || m === "protein target") {
    const prot = user.proteinTarget || 120;
    const _pNotes = (user.profileNotes || "").toLowerCase();
    const _protSources = _pNotes.includes("diet:vegan")
      ? "cooked lentils (18g per cup), firm tofu (12g per 100g), soya mince (20g per 50g dry), sugar beans (15g per cup)"
      : _pNotes.includes("diet:vegetarian")
      ? "eggs (6g each), cottage cheese (12g per 100g), Greek yoghurt (10g per 100g), sugar beans (15g per cup)"
      : "eggs (6g each), pilchards (22g per tin), frozen chicken breast (28g per 100g), tinned tuna (25g per tin)";
    return `Protein target: *${prot}g per day.*\n\nBest sources at SA prices: ${_protSources}.`;
  }

  // Guard: "had a streak wrap and fries" is a food log — user typo'd "steak" as "streak". Only fire the workout-streak report when the message looks like a genuine
  // progress question (no food-log trigger words, no SA-food matches). The morning after a braai a lot of people will type "steak and pap" — must not be intercepted here.
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

  // CLEAR HOLIDAY MODE — MECHANICAL only: fires ONLY when real holiday/temp state exists to clear; otherwise "back to gym" is JUDGMENT and flows to the brain, not a template. Still skips a question/negation/sick signal (2026-07-18: told a sick client to train).
  const skipBackToGym = /\b(when|how long|how many|what day|which day|should i|am i ready|is it (time|safe|ok|okay))\b/i.test(m) || /\b(not|won'?t|wont|can'?t|cant|cannot|never|ain'?t)\b[^.!?]{0,24}\b(go|going|come|coming|back|return|train|gym|programme)\b/i.test(m) || /\b(sick|ill|unwell|not feeling (well|good|right|ok|okay)|feeling (sick|ill|unwell|terrible|bad|rough|weak)|flu|fever|nause|vomit|dizzy|injured|hurt|in pain)\b/i.test(m);
  if ((tempEquipmentMode.has(phone) || (user.awaitingInputType || "").startsWith("holiday_equipment")) && !skipBackToGym && /\b(back (at|to|in) (the )?gym|back from (holiday|vacation|trip|travel)|back to (my )?(regular )?(gym|normal training|programme)|gym mode|cleared.*holiday|no longer (on holiday|travelling|traveling|away))\b/i.test(m)) {
    tempEquipmentMode.delete(phone);
    awaitingEquipmentAnswer.delete(phone);
    user.awaitingInputType = null; await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone)).catch((e) => console.error("[AWAITING] clear failed:", e));
    const backMsg = `${firstName ? firstName + ", b" : "B"}ack to your regular programme. Say *workout* whenever you're ready for today's session.`;
    await logChat(user.id, message, backMsg, "BACK_TO_GYM");
    return backMsg;
  }

  // ---- HOLIDAY / TRAVEL EQUIPMENT QUESTION ----
  // Must be checked BEFORE the workout delivery so it intercepts correctly.
  const isGymClosed = /\bgym.{0,15}(not (functioning|working|open|available|operational)|is (closed|shut|not)|closed|not open)\b/i.test(m)
    || /\bno gym (this|next|for the) week\b/i.test(m);
  const isHolidayMention = isGymClosed || /\b(on holiday|on vacation|travelling|traveling|i.?m away|hotel gym|hotel|away this week|going away|on a trip|at home today|only have dumbbells|no gym today|training at home today|can.?t get to the gym|went home to|going home\b|back home (for|this|next)|coming back (on )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|tomorrow|in a few days))\b/i.test(m);

  // If awaiting weight entry (after scale photo couldn't OCR a number)
  if (user.awaitingInputType === "weight") {
    const weightMatch = m.match(/^(\d{2,3}(?:\.\d+)?)\s*(?:kgs?)?[.!]?$/i);
    if (weightMatch) {
      const kg = parseFloat(weightMatch[1]);
      if (Number.isFinite(kg) && kg >= 30 && kg <= 250) {
        user.awaitingInputType = null; await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone)).catch((e) => console.error("[AWAITING] clear failed:", e));
        const { handleWeightLog } = await import("./weight");
        return handleWeightLog(phone, user, kg);
      }
    }
    // Not a valid weight — clear the prompt state and let the message flow normally
    user.awaitingInputType = null; await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone)).catch((e) => console.error("[AWAITING] clear failed:", e));
  }

  // If awaiting equipment answer — check in-memory map AND db field (survives restart)
  const isAwaitingEquipment = awaitingEquipmentAnswer.get(phone) || user.awaitingInputType === "equipment";
  if (isAwaitingEquipment) {
    awaitingEquipmentAnswer.delete(phone);
    user.awaitingInputType = null; await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone)).catch((e) => console.error("[AWAITING] clear failed:", e));
    let tempMode = user.trainingMode || "gym";
    if (/\b(full gym|gym|machines|cables|full equipment|1)\b/i.test(m)) tempMode = "gym";
    else if (/\b(dumbbell|dumbbells|db|2)\b/i.test(m)) tempMode = "gym_dumbbell";
    else if (/\b(nothing|no equipment|bodyweight|hotel room|3)\b/i.test(m)) tempMode = "home";
    tempEquipmentMode.set(phone, tempMode);
    // Persist to DB so the mode survives a server restart
    user.awaitingInputType = `holiday_equipment:${tempMode}`;
    await db.update(users).set({ awaitingInputType: `holiday_equipment:${tempMode}` }).where(eq(users.phoneNumber, phone)).catch((e) => console.error("[AWAITING] set holiday_equipment failed:", e));
    const tempUser = { ...user, trainingMode: tempMode };
    const workout = buildDayWorkout(tempUser);
    const gifUrl = getPrimaryWorkoutGifUrl(workout);
    const gifMarker = gifUrl ? `\n[MEDIA:${gifUrl}]` : "";
    const tReply = `Here is your session adapted for what you have available.\n\n${workout}\n\nSend *done* when finished.${gifMarker}`;
    await logChat(user.id, message, tReply, "WORKOUT_HOLIDAY");
    return tReply;
  }

  // HOLIDAY / TRAVEL EQUIPMENT — JUDGMENT, the brain owns it when live. Keyword template hijacked food/grocery
  // messages (2026-07-18: "adjust my groceries on vacation" → a workout). Fallback: no food context, real training intent.
  const isWorkoutRequestInMessage = /\b(workout|training|session|programme|program|exercise|gym|train|send me|my workout|today)\b/i.test(m);
  const isFoodOrGroceryContext = /\b(grocer|grocery|shopping list|meal|meals|eat|eating|food|snack|breakfast|lunch|dinner|portion|calorie|protein|recipe|cook|diet|fridge|cupboard|pantry)\b/i.test(m);

  // ---- PERMANENT EQUIPMENT UPDATE ----
  // When user tells us they've changed their setup (joined a gym, bought dumbbells, etc.)
  // Negation guard: "I have NO gym access", "don't have weights", "can't get to the gym"
  // is the OPPOSITE of an equipment upgrade — without this, "no gym access this week"
  // flipped the client's programme to full gym (caught by routing-audit).
  const negatedEquipment = (
    /\b(no|don'?t|do not|won'?t|can'?t|cannot|without|lost|left|quit|cancelled?|stopped)\b[\w\s]{0,18}\b(gym|equipment|dumbbells?|weights|bands?|access)\b/i.test(m) ||
    /\bno\s+(gym\s+)?access\b/i.test(m)
    // "no no 4 days AT THE GYM" / "not home — SWITCH to gym" are positive gym statements,
    // not loss-of-access (2026-07-16: the negation veto ate ten switch attempts).
  ) && !/\b(at the gym|to (the )?gym|gym.?based|switch|change)\b/i.test(m);
  // Trip guard: "Going to the gym first/now/later" is a statement of TODAY'S PLANS
  // (usually an answer to "what's for breakfast?"), not a membership declaration —
  // it flipped a home client's whole programme to full gym (production, 2026-07-03).
  // Mode changes need a DURABLE signal: joined / membership / switch me to.
  const isGymTripStatement = /\b(going|heading|off|about|gonna|on my way|about to go)\s+to\s+(?:the\s+)?gym\b/i.test(m)
    && !/\b(joined|member|membership|signed up|switch|change)\b/i.test(m);
  // Keyword-level question backstop (works when the AI classifier is offline): a question about switching ("Should I switch to full gym?", "Is home as good?") must never flip the programme — only
  // a command/declaration does. Only a TRAILING "?" is a question — voice notes carry mid-text "Right?" fillers ("My program is home-based. Right? Switch it to gym-based") that vetoed real commands.
  const modeChangeIsQuestion = /\?\s*$/.test(m.trim())
    || /^(should|is|are|do|does|can|could|would|will|which|what|why|how)\b/i.test(m.trim());
  const isEquipmentUpdate = !negatedEquipment && !isGymTripStatement && !ctx.isQuestion && !modeChangeIsQuestion && (
    /\b(i (have|got|bought|use|train with|now have|just got)|my (home )?(equipment|kit|setup|gear) is|i.?ve (got|purchased|bought))\b.{0,40}\b(dumbbell|dumbbells|db|resistance band|bands|gym|weights|full gym)\b/i.test(m) ||
    /\b(joined|signed up|now (go to|at|train at)|started at|switch(?:ed)? (?:me )?to|got a(?: gym)? membership)\b.{0,20}\b(gym|virgin|planet fitness|curves|fitness centre|membership)\b/i.test(m) ||
    // 2026-07-16 live incident (ten failed attempts): "switch it to gym-based", "I want a
    // gym based program", "gym based program not a home based" — all must WRITE the mode.
    /\b(switch|change|swap|move|set|make|put)\b[^.!?]{0,25}\b(gym|home)([- ]?based)?\b/i.test(m) ||
    /\b(i want|give me|i need)\b[^.!?]{0,20}\b(gym|home)[- ]?based\b/i.test(m) ||
    /\b(gym|home)[- ]?based (program(?:me)?|workout|training|plan)\b/i.test(m) ||
    /\bchange my (equipment|training mode|setup|training setup|training|gym)\b/i.test(m) ||
    /\bupdate my (equipment|training mode|setup)\b/i.test(m));

  if (isEquipmentUpdate) {
    const lower = m.toLowerCase();
    let newMode = user.trainingMode || "home";
    let newHomeEquipment: string | null = user.homeEquipment || null;
    let modeLabel = "";

    if (/\b(full gym|gym|machines|cables|virgin|planet fitness|curves|fitness centre)\b/i.test(lower) && !/\b(dumbbell|dumbbells|db|band|bands)\b/i.test(lower)) {
      newMode = "gym"; newHomeEquipment = null; modeLabel = "full gym";
    } else if (/\b(dumbbell|dumbbells|db|weights)\b/i.test(lower) && /\b(band|resistance band|bands)\b/i.test(lower)) {
      newMode = "gym_dumbbell"; newHomeEquipment = "mix"; modeLabel = "dumbbells + resistance bands";
    } else if (/\b(dumbbell|dumbbells|db|weights|adjustable)\b/i.test(lower)) {
      newMode = "gym_dumbbell"; newHomeEquipment = "dumbbells"; modeLabel = "dumbbell training";
    } else if (/\b(band|resistance band|bands)\b/i.test(lower)) {
      newMode = "home"; newHomeEquipment = "bands"; modeLabel = "resistance band training";
    }

    if (modeLabel) {
      await db.update(users).set({ trainingMode: newMode, homeEquipment: newHomeEquipment }).where(eq(users.phoneNumber, phone));
      const reply = `Got it — programme updated to *${modeLabel}*. Your next session will reflect that.\n\nReply *workout* to see today's updated session.\n\n_Wrong change? Say *switch me to home workouts* (or *dumbbells only*) and it's reversed._`;
      await logChat(user.id, message, reply, "EQUIPMENT_UPDATE");
      return reply;
    }
  }

  // ---- DIETARY PREFERENCE UPDATE — existing clients declaring halal / vegetarian / vegan ----
  if (
    /\b(i.?m|i am|i eat|i only eat|i.?m now|i.?ve become|i.?ve gone|turned|i.?m a)\b.*\b(halal|vegetarian|veggie|vegan|plant.?based)\b/i.test(m) ||
    /\b(halal|vegetarian|veggie|vegan|plant.?based)\b.*\b(only|diet|food|eating|lifestyle|eater)\b/i.test(m) ||
    /\b(i (don.?t|no longer|stopped|gave up) eat(ing)?)\b.*\b(meat|pork|chicken|beef|fish|pilchards|animal)\b/i.test(m) ||
    /\b(change|update)\b.*\b(diet(ary)?|food preference|eating)\b.*\b(halal|vegetarian|veggie|vegan|plant.?based)\b/i.test(m)
  ) {
    let _newDietFlag: string | null = null;
    if (/\bvegan\b/i.test(m) || /\bplant.?based\b/i.test(m)) _newDietFlag = "diet:vegan";
    else if (/\b(vegetarian|veggie)\b/i.test(m) || /\b(don.?t|no longer|stopped|gave up)\s+eat(ing)?\b.*\b(meat|chicken|beef|fish|pilchards|animal)\b/i.test(m.toLowerCase())) _newDietFlag = "diet:vegetarian";
    else if (/\b(halal|muslim|islam|haram)\b/i.test(m)) _newDietFlag = "diet:halal";

    if (_newDietFlag) {
      const _existingNotes = (user.profileNotes || "").replace(/\bdiet:\w+\b/g, "").trim();
      const _updatedNotes = _existingNotes ? `${_existingNotes} ${_newDietFlag}` : _newDietFlag;
      await db.update(users).set({ profileNotes: _updatedNotes }).where(eq(users.phoneNumber, phone));
      user.profileNotes = _updatedNotes;
      const _dietLabel = _newDietFlag === "diet:vegan" ? "vegan" : _newDietFlag === "diet:vegetarian" ? "vegetarian" : "halal";
      const _dietProteins = _newDietFlag === "diet:vegan"
        ? "tofu, lentils, sugar beans, soya mince"
        : _newDietFlag === "diet:vegetarian"
        ? "eggs, cottage cheese, sugar beans, tofu"
        : "chicken, beef, lamb, eggs, legumes (halal-certified)";
      const _dietNote = _newDietFlag === "diet:halal"
        ? "I'll never suggest pork or alcohol-containing ingredients."
        : _newDietFlag === "diet:vegan"
        ? "I'll only suggest plant-based proteins from now on."
        : "I'll keep it meat-free from now on.";
      const _dietReply = `${firstName ? firstName + ", g" : "G"}ot it — updated to *${_dietLabel}*. ${_dietNote}\n\nYour protein sources from now on: *${_dietProteins}*.\n\nType *meal plan* to get an updated eating plan.`;
      await logChat(user.id, message, _dietReply, "DIET_PREFERENCE_UPDATE");
      return _dietReply;
    }
  }

  if (m === "log food" || m === "3") {
    return `What did you eat? Just tell me — I'll get you the kcal and protein instantly.\n\n_Examples:_\n• "2 eggs and pap for breakfast"\n• "Chicken thigh, rice and spinach for lunch"\n• "Pap and mince for dinner"\n\nInclude the food, rough amount, and which meal.`;
  }

  // Body-part requests ("upper body today", "chest day", "legs today") otherwise fall through to GPT,
  // which returns generic home exercises ignoring trainingMode. Suffix required so standalone "back" won't fire.
  const isBodyPartWorkoutRequest = !m.includes("?")
    && /^(?:(?:doing|training|about to do|gonna do|going to do)\s+)?(?:upper\s+body|lower\s+body|legs?|chest|back|push(?:\s+day)?|pull(?:\s+day)?|arms?|shoulders?|core)(?:\s+(?:today|day|now|workout|session|training))[.!?]?\s*$/i.test(m);

  // A request for a NEW/DIFFERENT programme must NEVER be answered by dumping the CURRENT one
  // (2026-07-27 live: "I need a new programme" → the existing Week-1 wall of text). Those
  // messages belong to the setup flow below, so this viewer must stand down.
  const wantsDifferentProgramme = /\b(new|change|different|rebuild|another|switch|swap|upgrade)\b[^.!?]{0,30}\b(programme|program|workout|training|plan)\b/i.test(m)
    || /\b(programme|program|workout|training|plan)\b[^.!?]{0,30}\b(new|change|different|rebuild|another)\b/i.test(m);
  if (!wantsDifferentProgramme && (m === "my programme" || m === "programme" || m === "my program" || m === "program" || m === "my workout" || m === "1" || m === "workout" || /^today.?s?\s+workout\W*$/i.test(m) || /^(today|1|workout|my workout|my programme|programme)$/.test(m) || isBodyPartWorkoutRequest || looksLikeWorkoutRequest(m))) {
    // Equipment named in the request itself ("home workout with two dumbbells", "workout
    // with no equipment") overrides the mode for THIS serving via the same temp mechanism
    // holiday mode uses — 2026-07-13 tester screenshot: this phrasing used to reach the
    // model, which improvised an unformatted generic workout instead of her programme.
    if (/\bdumbbells?\b/i.test(m)) tempEquipmentMode.set(phone, "gym_dumbbell");
    else if (/\b(no equipment|bodyweight|nothing at home|home workout)\b/i.test(m)) tempEquipmentMode.set(phone, "home");

    // NO COOLDOWN, EVER (2026-07-16 founder): asking for your session GETS it, always.
    // Restore holiday equipment mode from DB if the in-memory map was lost (server restart)
    if (!tempEquipmentMode.has(phone) && user.awaitingInputType?.startsWith("holiday_equipment:")) {
      const persistedMode = user.awaitingInputType.slice("holiday_equipment:".length);
      if (persistedMode) tempEquipmentMode.set(phone, persistedMode);
    }
    const effectiveUser = tempEquipmentMode.has(phone)
      ? { ...user, trainingMode: tempEquipmentMode.get(phone) }
      : user;
    // Clear the persisted holiday mode from DB now that we've consumed it
    if (tempEquipmentMode.has(phone)) {
      user.awaitingInputType = null; await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone)).catch((e) => console.error("[AWAITING] clear failed:", e));
    }
    tempEquipmentMode.delete(phone);

    const state = await getTodayWorkoutState(user);

    // SICK-AWARE SERVING (2026-07-16: a client resting until tomorrow was told "today is
    // the reset — one session and you're back in it"). While sick_until is active the
    // programme is served TO LOOK AT — never as a push, never counting missed days.
    const sickUntilMatch = String(user.profileNotes || "").match(/sick_until:(\d{4}-\d{2}-\d{2})/);
    const sastTodayStr = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
    const sickActive = !!(sickUntilMatch && sickUntilMatch[1] >= sastTodayStr);
    const sickViewHeader = sickActive
      ? `You're resting until ${sickUntilMatch![1]} — no pressure to do this today, it's just here to look at. Say *I'm back* when you're ready.\n\n`
      : "";

    // FULL PLAN vs TODAY (2026-07-16 live: "show me my programme" answered with ONE
    // day — while the menu itself promises *programme* = the full plan and *workout* =
    // today's session). Programme/plan vocabulary without "today" gets the WHOLE plan;
    // "workout", "today's workout", body-part asks and menu "1" stay today-only.
    const wantsFullPlan = /\b(program(?:me)?s?|full plan|whole plan|training plan|workout plan)\b/i.test(m)
      && !/\btoday\b/i.test(m) && !isBodyPartWorkoutRequest;
    if (wantsFullPlan) {
      const week = user.programmeWeek || 1;
      const fullProg = getKamlifeProgramme(effectiveUser, false);
      const fullReply = `${sickViewHeader}*Your full programme — Week ${week}*\n\n${fullProg}\n\nThat's the whole plan. Say *workout* for just today's session.`;
      await logChat(user.id, message, fullReply, "PROGRAMME_VIEW");
      return fullReply;
    }

    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

    // Walk-only clients never lift — "log bench 80kg 3x10" is noise. Give them a walk-fit closer.
    const doneHint = (effectiveUser.trainingMode === "walk_only" || effectiveUser.trainingMode === "walk")
      ? `Send *done* when you finish, or just tell me how it went (e.g. "25 min, felt strong").`
      : `Send *done* when finished. Log lifts: "bench 80kg 3x10"`;

    // REST DAY
    if (state.type === "REST") {
      const restNote = pick([
        "Recovery is when your muscles actually grow. No session today.",
        "Rest days are part of the programme. Your body rebuilds today.",
        "Scheduled rest. This is when the adaptation happens — don't skip the recovery.",
        "Today's job: eat well, sleep well, move lightly. No workout needed.",
      ]);
      const restReply = `*${state.todayName} — Rest Day.*\n\n${restNote}\n\nNext training day: *${state.nextTrainingName}*.\n\nHit your food and steps today.`;
      await logChat(user.id, message, restReply, "REST_DAY_INFO");
      return restReply;
    }

    // ALREADY DONE TODAY
    if (state.type === "ALREADY_DONE") {
      const poCtx = await getProgressiveOverloadContext(user.id);
      const doneNote = pick([
        `${firstName ? firstName + ", t" : "T"}oday's session is done ✅`,
        `${firstName ? firstName + " — s" : "S"}ession logged ✅`,
        `${firstName ? firstName + ", y" : "Y"}ou've already put today's work in ✅`,
        `${firstName ? firstName + " — t" : "T"}oday is ticked off ✅`,
      ]);
      const doneReply = `${doneNote}${poCtx ? "\n\n" + poCtx.trim() : ""}\n\nWhat's next?[BUTTONS:Log my lifts|Tomorrow's session|Log food]`;
      await logChat(user.id, message, doneReply.replace(/\[BUTTONS:[^\]]+\]/g, "").trim(), "WORKOUT_ALREADY_DONE");
      return doneReply;
    }

    // MISSED SESSION(S)
    if (state.type === "MISSED") {
      const missed = state.missedSessions.join(" and ");
      const catchupIntro = sickActive ? sickViewHeader.trim() : pick([
        `${firstName ? firstName + ", y" : "Y"}ou missed ${missed}. ${state.todayName} is still a training day — do it now and you're back on track.`,
        `${firstName ? firstName + " —" : ""} ${missed} missed. But today counts. Get this session done and the week is back on track.`,
        `${missed} didn't happen. That's done — don't double back. ${state.todayName}'s session is what matters now.`,
        `${missed} slipped. ${firstName ? firstName + ", " : ""}today is the reset. One session and you're back in it.`,
      ]);
      const todaySlot = getTodaySlot(user);
      const workout = buildDayWorkout({ ...effectiveUser, programmeDayInWeek: todaySlot });
      const poContext = await getProgressiveOverloadContext(user.id);
      const week = user.programmeWeek || 1;
      const sessionNum = user.totalWorkoutsCompleted || 0;
      const injuryNote = user.injuries && user.injuries.trim() && user.injuries.toLowerCase() !== "none"
        ? `\n\n⚠️ *Active injury noted (${user.injuries}):* Skip any exercise that causes sharp pain.`
        : "";
      const workoutGifUrl = getPrimaryWorkoutGifUrl(workout);
      const gifMarker = workoutGifUrl ? `\n[MEDIA:${workoutGifUrl}]` : "";
      const missedReply = `${catchupIntro}\n\n*Week ${week} — Session ${sessionNum + 1}*\n\n${poContext}${workout}${injuryNote}\n\n${doneHint}${gifMarker}[BUTTONS:Done 💪|Too hard — modify|Skip today]`;
      await logChat(user.id, message, missedReply.replace(/\[MEDIA:[^\]]+\]|\[BUTTONS:[^\]]+\]/g, "").trim(), "WORKOUT_MISSED_CATCHUP");
      return missedReply;
    }

    // NORMAL — scheduled training day, nothing done yet
    const todaySlot = getTodaySlot(user);
    const workout = buildDayWorkout({ ...effectiveUser, programmeDayInWeek: todaySlot });
    const poContext = await getProgressiveOverloadContext(user.id);
    const week = user.programmeWeek || 1;
    const sessionNum = user.totalWorkoutsCompleted || 0;
    const sessionNote = sessionNum > 0 ? ` — Session ${sessionNum + 1}` : "";
    const weekNote = `*Week ${week}${sessionNote}*\n\n`;
    const injuryNote = user.injuries && user.injuries.trim() && user.injuries.toLowerCase() !== "none"
      ? `\n\n⚠️ *Active injury noted (${user.injuries}):* Skip any exercise that causes sharp pain. Reply *injury* for safe alternatives.`
      : "";
    const workoutGifUrl = getPrimaryWorkoutGifUrl(workout);
    const gifMarker = workoutGifUrl ? `\n[MEDIA:${workoutGifUrl}]` : "";
    const reply = `${sickViewHeader}${weekNote}${poContext}${workout}${injuryNote}\n\n${doneHint}${gifMarker}[BUTTONS:Done 💪|Too hard — modify|Skip today]`;
    await logChat(user.id, message, reply.replace(/\[MEDIA:[^\]]+\]|\[BUTTONS:[^\]]+\]/g, "").trim(), "WORKOUT_VIEW");
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
  // ---- DIRECT DAYS SWITCH — "switch to 3 days" / "I want to do 4 days" ----
  // Updates training days immediately without the full questionnaire.
  // Guard: interrogative phrasing ("Should I switch to 5 days?") must NOT auto-apply — route to GPT.
  const isTrainingDaysQuestion = /^(?:should|would|could|can\s+i|is\s+it|what\s+if|how\s+about|do\s+you\s+think|if\s+i)\b/i.test(m.trim())
    || /[?？]\s*$/.test(m.trim());
  const directSwitchMatch = isTrainingDaysQuestion ? null : (
    m.match(/\b(?:switch|change|move|update)\s+(?:me\s+)?to\s+([2-6])\s*days?\b/i)
    || m.match(/\bwant\s+to\s+(?:do|train)\s+([2-6])\s*days?\s*(?:a\s*week|per\s*week)?\b/i)
  );
  if (directSwitchMatch) {
    const newDays = parseInt(directSwitchMatch[1]);
    const newTargets = user.currentWeight
      ? calculateTargets(
          parseFloat(user.currentWeight),
          user.goalType || "fat_loss",
          user.lifeSituation || "office",
          newDays,
          user.gender || "male",
          user.age || 30,
          user.heightCm || 170,
          user.trainingExperience || "beginner",
        )
      : null;
    await db.update(users).set({
      trainingDaysPerWeek: newDays,
      programmeDayInWeek: 1,
      ...(newTargets ? { calorieTarget: newTargets.calorieTarget, proteinTarget: newTargets.proteinTarget } : {}),
    }).where(eq(users.phoneNumber, phone));
    const updatedUser = { ...user, trainingDaysPerWeek: newDays, programmeDayInWeek: 1 };
    const newProg = buildFullProgramme(updatedUser);
    const targetsNote = newTargets ? `\nTargets updated: ${newTargets.calorieTarget} kcal · ${newTargets.proteinTarget}g protein` : "";
    const switchReply = `Done${firstName ? `, ${firstName}` : ""} — updated to ${newDays} days/week.${targetsNote}\n\n${newProg}`;
    await logChat(user.id, message, switchReply, "PROGRAMME_SWITCH");
    return switchReply;
  }

  // Must be checked BEFORE awaitingProgrammeAnswers so a new request resets the flow
  // Guard: if message contains quit/frustration signal, do NOT put them in programme setup
  const isQuitOrFrustrated = /\b(quit|giving up|not doing this|done with this|cancel|i.?m out|too hard|not worth|hate this|this (sucks|is shit|doesn.?t work|is useless|is a waste))\b/i.test(m);
  const isNewProgrammeRequest = !isQuitOrFrustrated && (
    /\b(new|change|different|update|rebuild|swap|switch|give me a new|i need a new|want a new)\b.{0,30}\b(programme|program|workout|training plan|plan|gym|home)\b/i.test(m) ||
    /\b(programme|program|workout|training)\b.{0,30}\b(new|change|different|update|rebuild)\b/i.test(m) ||
    /\b(a new one|different one|another one|new gym|new home|new workout|new training)\b/i.test(m) ||
    /\bi want to train\s+[2-6]\s*days?\b/i.test(m) ||
    /\btrain\s+[2-6]\s*days?\s*(?:a\s*week|per\s*week)\b/i.test(m) ||
    // "need more"/"want harder" must name what — bare "I need more help" threw the client
    // into programme setup and re-asked days+mode it already had (2026-07-27 live).
    /\b(?:need|want)\s+(?:more|harder|a harder|more intense)\s+(?:challenging\s+)?(?:workouts?|training|programme|program|sessions?|volume|intensity)\b/i.test(m) ||
    /\b(more challenging|harder workout|more intense workout|upgrade my (programme|program|workout|training))\b/i.test(m)
  );

  if (isNewProgrammeRequest) {
    await db.update(users).set({ awaitingProgrammeAnswers: true }).where(eq(users.phoneNumber, phone));
    const nameQ = spaceName(user);
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

    // RECALC-ON-CHANGE (2026-07-14): this write changes training days, experience AND
    // goal — three calorie-formula inputs at once — so the stored targets MUST be
    // recomputed here, not left stale for the nightly net to maybe catch. The old code
    // updated the programme but kept (and displayed) the old calorieTarget: a client
    // switching to muscle gain saw their old fat-loss numbers as if correct.
    const recalcUser = { ...user, trainingDaysPerWeek: trainingDays, trainingExperience: experience, goalType };
    const { calorieTarget: newCal, proteinTarget: newProt, stepsTarget: newSteps } = recalcTargetsForProfile(recalcUser);
    // PROGRESSION IS PRESERVED on a same-goal rebuild (2026-07-16: changing days/equipment
    // reset a Week-2, 21-session client to 'Week 1' and re-locked his supplement gate).
    // Only a genuine GOAL change restarts the programme clock.
    const goalChanged = goalType !== (user.goalType || goalType);
    const progression = goalChanged
      ? { programmePhase: 1, programmeWeek: 1, programmeDayInWeek: 1, programmeStartDate: new Date() }
      : {};
    await db.update(users)
      .set({ trainingDaysPerWeek: trainingDays, trainingExperience: experience, goalType, trainingMode, calorieTarget: newCal, proteinTarget: newProt, stepsTarget: newSteps, awaitingProgrammeAnswers: false, ...progression })
      .where(eq(users.phoneNumber, phone));

    const updatedUser = { ...user, trainingDaysPerWeek: trainingDays, trainingExperience: experience, goalType, trainingMode, calorieTarget: newCal, proteinTarget: newProt, stepsTarget: newSteps };
    const programme = buildFullProgramme(updatedUser);
    const modeLabel = trainingMode === "gym" ? "Gym" : trainingMode === "gym_dumbbell" ? "Dumbbell Gym" : "Home";
    const cal = `🔥 *Calories:* ${newCal} kcal/day\n`;
    const prot = `💪 *Protein:* ${newProt}g/day\n`;
    const steps = `👟 *Steps:* ${newSteps.toLocaleString()}/day\n`;
    const targetsLine = `\n*Your daily targets:*\n${cal}${prot}${steps}`;
    const reply = `Sharp. ${trainingDays} days/week. ${modeLabel}. ${experience.charAt(0).toUpperCase() + experience.slice(1)}. Here is your programme.\n\n${programme}${targetsLine}\n\n_Just talk to me like a coach — tell me what you ate, send your steps, ask what to eat, or say *workout* for a session. I'm here all day._`;
    await logChat(user.id, message, reply, "PROGRAMME_DELIVERY");

    // Progress-photo prompt after programme delivery. NEVER call an existing client "Day 0"
    // (2026-07-27 live: a months-old client re-ran setup and was told "This is your Day 0 —
    // send baseline photos" → "How can this be my day zero???? I've been here a long time!!!!").
    // Tenure decides the wording: a genuinely new account gets the baseline ask, an existing
    // client gets a re-shoot framed as a COMPARISON against what we already have.
    const daysOnBoard = user.createdAt
      ? Math.floor((Date.now() - new Date(user.createdAt).getTime()) / 86_400_000) : 0;
    const isExistingClient = daysOnBoard >= 14;
    setTimeout(async () => {
      try {
        await sendWhatsApp(phone, isExistingClient
          ? `One more thing — *fresh progress photos when you can.*\n\nThree shots: *front, side and back*, same lighting as last time. You're ${daysOnBoard} days in, so these compare against your earlier set and I'll show you the exact difference.\n\n_No rush — send them when you're ready._`
          : `One more thing — *send me your baseline photos right now.*\n\nThree shots: *front, side and back.* Fitted clothes or underwear, good lighting. This is your Day 0.\n\nFrom these I read where you're strong and which muscles to bring up — then every month we compare and I show you the exact difference. Without today's photos, we have nothing to compare later.\n\n*Send all three now before you forget.*`
        );
        await logChat(user.id, "[auto]", isExistingClient ? "[progress re-shoot prompt sent]" : "[Day 0 photo challenge sent]", "PHOTO_CHALLENGE_PROMPT");
      } catch { /* non-fatal */ }
    }, 3_000);

    return reply;
    } // end else (not an obvious non-programme message)
  }

  // ---- GREETINGS / MENU (direct — no GPT) ----
  // A greeting gets a warm coach check-in; menu/help gets the full command list.
  // Covers SA languages: isiZulu, isiXhosa, Sesotho/Setswana/Sepedi, Afrikaans, Xitsonga.
  const greetings = [
    "hello", "hi", "hey", "howzit", "hola", "yo", "sup", "hello there", "hi there",
    "sawubona", "sanibonani", "unjani", "kunjani",          // isiZulu
    "molo", "molweni",                                       // isiXhosa
    "dumela", "dumelang", "lumela", "thobela",               // Sotho/Tswana/Pedi
    "avuxeni",                                               // Xitsonga
    "hallo", "goeie more", "goeie môre", "hoe gaan dit",     // Afrikaans
    "heita", "eita", "aweh", "awe",                          // street
    "morning", "good morning", "good afternoon", "good evening", "good day", "gm",
  ];
  // Strip emojis/punctuation and an optional "coach (k)" suffix so "hi coach k 👋" still matches.
  const mGreet = m
    .replace(/[👋🙏🙌💪🔥❤️😊🤝]/gu, "")
    .trim()
    .replace(/[!.,?]+$/g, "")
    .trim()
    .replace(/\s+(coach k|coach|there|guys|team)$/i, "")
    .trim();
  // MENU — always reachable: "menu", "help", or "#" (Self-Cav pattern), plus a greeting. Returns
  // tappable quick-action buttons. NO avatar image here (2026-07-22: firing the welcome card on
  // every "hello" was spammy) — the branded card belongs on the FIRST welcome only (onboarding).
  if (greetings.includes(mGreet)) {
    return replyWithButtons(await getMenuText(user), MENU_BUTTONS);
  }
  if (m === "menu" || m === "help" || m.trim() === "#") {
    return replyWithButtons(await getMenuText(user, { showCommands: true }), MENU_BUTTONS);
  }

  // ---- SHOPPING LIST command ----
  // Exact-phrase commands AND fuzzy "I don't know what to buy/eat" intent —
  // common when clients struggle with consistency, not just lookup ("shopping list").
  const GROCERY_INTENT_RE = /\b(i\s+don.?t\s+know\s+what\s+to\s+(?:eat|buy|cook|get)|i\s+don.?t\s+(?:know\s+)?(?:what\s+to|how\s+to)\s+(?:eat|buy|shop|cook)|recommend\s+(?:things?\s+(?:i\s+can|to)\s+(?:get|buy|eat)|what\s+(?:i\s+should|to)\s+(?:buy|eat|get))|(?:i\s+)?(?:hardly|never)\s+buy\s+(?:using\s+)?a\s+list|i\s+need\s+a\s+(?:food|grocery|shopping)\s+list|can\s+you\s+(?:make|give|send|build)\s+(?:me\s+)?a?\s*(?:grocery|shopping|food|weekly)\s+list|what\s+(?:food|groceries)\s+should\s+i\s+(?:buy|get|stock)|(?:wants?\s+to|wanna)\s+buy\s+(?:some\s+)?(?:healthy\s+)?groceries|what\s+(?:i\s+|is\s+it\s+(?:that\s+)?(?:i\s+)?)should(?:n.?t)?\s+eat|tell\s+me\s+what\s+(?:to\s+eat|i\s+should\s+eat)|(?:want\s+to|wanna)\s+(?:start\s+)?eat(?:ing)?\s+(?:healthy|healthier|better|right|properly|clean)|(?:stop|quit|move\s+away\s+from)\s+(?:eating\s+)?takeaways?)\b/i;
  if (m === "4" || ["shopping list", "shoppinglist", "shopping", "shop", "grocery list", "groceries", "my groceries", "weekly shop", "weekly shopping", "what to buy", "what should i buy", "what must i buy", "eat healthy", "eat healthier", "eat better", "eat right", "eat properly", "eat clean", "what to eat"].includes(m) || GROCERY_INTENT_RE.test(m)) {
    const budget = user.weeklyFoodBudget || "100_300";
    const weekNum = user.programmeWeek || 1;
    const goal = user.goalType || "fat_loss";
    const list = getShoppingList(budget, weekNum, goal);
    const personalization = await getGroceryPersonalization(user.id, goal, (user as any).foodDislikes);
    const reply = formatShoppingList(list, user.name || undefined, goal, {
      calorieTarget: user.calorieTarget || undefined,
      proteinTarget: user.proteinTarget || undefined,
      budgetTier: budget,
      personalization,
    });
    await logChat(user.id, message, reply, "SHOPPING_LIST");
    return reply;
  }

  // ---- SAME-AS QUICK LOG — extracted to meal-repeat.ts (single owner of repeat intent;
  // selection + negation + duplicate guards live there and in meal-select.ts tests) ----
  // NEVER on a photo caption: "Same dinner" under a meal photo means "log THIS photo
  // as dinner" — the media pipeline owns it. Firing here copied yesterday's dinner
  // instead and the photo was never analysed (production cascade, 2026-07-02).
  if (!ctx.hasMedia && !ctx.isQuestion) {
    const sameAsReply = await handleMealRepeat({ phone, message, m, user });
    if (sameAsReply) return sameAsReply;
  }

  // ---- CLIENT SENDS THEIR OWN SHOPPING LIST — "adjust my list", "here's what I buy", "fix my groceries", or raw comma-separated items ----
  // Also catches plain lists like "chicken, eggs, rice, bread, spinach, oats" (≥4 items, mostly food words)
  const FOOD_WORDS = /\b(chicken|beef|mince|fish|eggs|milk|bread|rice|pap|oats|potato|sweet potato|spinach|cabbage|carrots|tomato|onion|garlic|beans|lentils|tuna|pilchards|yoghurt|cheese|butter|oil|flour|sugar|salt|broccoli|banana|apple|orange|pear|grapes|avocado|corn|maize|samp|weetbix|jungle oats|provita|peanut butter|pasta|spaghetti|macaroni|noodles|soup|stock|tofu|tempeh|whey|protein|biltong|vienna|polony|liver|kidney|tripe|sausage|breyani|vetkoek|roti|corn flour|mealie|mealies)\b/gi;
  // A meal statement is never a grocery list. Voice transcripts are comma-heavy
  // ("Breakfast, four fish fingers, four eggs...") and were being hijacked here,
  // silently skipping the food logger. Meal words / eating verbs route to food logging.
  const isMealStatement = /\b(breakfast|lunch|dinner|supper|snack|brunch|i\s+had|i\s+ate|just\s+had|just\s+ate|\bhad\b|\bate\b|having|eating|i.?ll\s+have|gonna\s+have|going\s+to\s+have)\b/i.test(m);
  const isRawFoodList = !isMealStatement && m.includes(",") && (m.match(FOOD_WORDS) || []).length >= 3 && !m.includes("?") && m.split(/\s+/).length <= 25;
  const isClientList = (
    (/\b(adjust|fix|check|improve|optimize|look at|review|here.?s|heres|this is what i|what i normally|my.*grocery|my.*shopping|i usually buy|i always buy|every week i buy|i buy)\b/i.test(m)
    && /\b(list|buy|shop|grocery|groceries|shopping|trolley|basket)\b/i.test(m)
    && m.split(/\s+/).length >= 5)
    || isRawFoodList
  );
  if (isClientList) {
    const goal = user.goalType || "fat_loss";
    const pTarget = user.proteinTarget || 120;
    const cTarget = user.calorieTarget || 1800;
    const budget = user.weeklyFoodBudget || "100_300";
    const budgetLabel: Record<string, string> = { under_100: "under R100/week", "100_300": "R100–R300/week", "300_600": "R300–R600/week", over_600: "over R600/week" };
    const medicalNotes = [user.medicalConditions, user.otherMedicalNotes].filter(Boolean).join(", ") || "none";
    const rebuildReply = await withTimeout("gpt_grocery_rebuild", 28000, () => askCoachK(message, user,
      `The client sent their personal grocery/shopping list. REBUILD it completely — do not review it. Replace it with a fully optimised version for their specific goal.

Client goal: ${goal.replace("_", " ")}
Weekly budget: ${budgetLabel[budget] || "R100–R300/week"}
Daily targets: ${cTarget} kcal, ${pTarget}g protein
Medical/allergies: ${medicalNotes}

RULES:
- Keep items that already fit their goal (note "✓" next to those)
- Drop items that work against their goal — replace with better alternatives
- Add any essential missing items for their goal (protein sources, veg, staples)
- SA products only: Checkers, Pick n Pay, USAVE, Spar. Use SA brand/product names
- Include quantity for a full week and rough rand price per item
- Max 20 items total — prioritise by impact

RESPOND EXACTLY in this format (start immediately with the header, no intro text):

🛒 *Your rebuilt list — ${goal.replace("_", " ")} optimised*

*Protein (${pTarget}g/day target):*
• [item] — [quantity] — ~R[price]

*Carbs (slow-release energy):*
• [item] — [quantity] — ~R[price]

*Vegetables:*
• [item] — [quantity] — ~R[price]

*Pantry & basics:*
• [item] — [quantity] — ~R[price]

*Week total: ~R[X]–R[Y]*

${goal === "fat_loss" ? "Fat loss focus: protein and veg first, carbs last. Cut sugary drinks, white bread, processed snacks, anything fried. Replace with eggs, pilchards, chicken, spinach, cabbage." : "Muscle gain focus: calorie-dense protein at every meal. Add extra portions of carbs. Remove nothing — just add. Prioritise chicken, eggs, oats, sweet potato, peanut butter."}${medicalNotes !== "none" ? `\n\nALLERGIES/CONDITIONS: ${medicalNotes} — remove ALL items containing these. No exceptions.` : ""}`
    ));
    await logChat(user.id, message, rebuildReply, "SHOPPING_LIST_REBUILD");
    return rebuildReply;
  }

  // ---- FOOD COMMANDS (server/handlers/food-commands.ts) — restaurant / street food / swaps /
  // meal prep / grocery / supplements; extracted for isolation, identical behaviour + order. ----
  const foodCmdReply = await handleFoodCommands({ phone, message, m, user });
  if (foodCmdReply !== null) return foodCmdReply;

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
      under_100: `Every item was chosen for maximum nutrition per rand — eggs and pilchards are the highest protein-per-rand foods in South Africa. Pap and spinach stretch the budget across multiple meals.`,
      "100_300": `Frozen chicken and eggs are your protein anchors at this budget. Oats and sweet potato give you slow-burning carbs that cost very little. The whole week's food costs under R250 and covers all your nutritional needs.`,
      "300_600": `This budget lets you rotate proteins — chicken, mince, eggs, pilchards — so you never get bored and never get gaps in your nutrition. Mince is the best value red meat in SA.`,
      over_600: `Salmon twice a week gives you omega-3 fatty acids that reduce inflammation — critical for recovery and long-term health. Greek yoghurt is one of the highest protein dairy foods per gram.`,
    };
    const budgetWhy = budgetReasons[budget] || budgetReasons["100_300"];

    return `*Why these specific foods for you:*\n\n${why}\n\n${budgetWhy}${extras.length > 0 ? "\n\n" + extras.join("\n\n") : ""}`;
  }

  // ---- PERSONALISED MEAL PLAN — built from actual user profile + recent food logs ----
  // Triggers: "meal plan", "my meal plan", "give me a meal plan", "what should I eat",
  //           "eating plan", "diet plan", "weekly meals"
  // Generates a static 3-day rotating plan — no GPT, instant, personalised.
  const isMealPlanRequest =
    ["meal plan", "my meal plan", "mealplan", "eating plan", "diet plan", "weekly meals",
      "what should i eat", "give me a meal plan", "i need a meal plan", "i want a meal plan",
      "food plan", "my food plan", "weekly meal plan",
      // "Nutrition side?" asked right after a workout got the WORKOUT re-sent
      // (2026-07-05 audit) — the eating half of the plan had no aliases here.
      "nutrition side", "nutrition side?", "nutrition plan", "my nutrition plan",
      "food side", "food side?", "eating side", "eating side?", "nutrition?"].includes(m)
    || /\b(give me a meal plan|my meal plan|send.*meal plan|meal plan please|eating plan|what should i eat|i need a meal plan|diet plan|weekly meals|nutrition (side|plan))\b/i.test(m);
  if (isMealPlanRequest) {
    // Fetch last 7 days of meal logs to surface recently eaten foods
    let recentFoods: string[] = [];
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      const logs = await db
        .select({ rawMessage: mealLogs.rawMessage, items: mealLogs.items })
        .from(mealLogs)
        .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, sevenDaysAgo)));
      const foodSet = new Set<string>();
      for (const log of logs) {
        if (log.rawMessage) {
          scanForSAFoods(log.rawMessage).forEach((f) => foodSet.add(f.name.toLowerCase()));
        }
        if (log.items && Array.isArray(log.items)) {
          for (const item of log.items as Array<{ name?: string }>) {
            if (item.name) foodSet.add(item.name.toLowerCase());
          }
        }
      }
      recentFoods = Array.from(foodSet);
    } catch {
      // non-fatal — plan still generates without it
    }

    const plan = generateMealPlan({
      calorieTarget: user.calorieTarget || 1800,
      proteinTarget: user.proteinTarget || 120,
      weeklyFoodBudget: user.weeklyFoodBudget || "100_300",
      goalType: user.goalType || "fat_loss",
      medicalConditions: user.medicalConditions || "",
      otherMedicalNotes: user.otherMedicalNotes || "",
      recentFoods,
      firstName: user.name?.split(" ")[0] || "",
    });

    await logChat(user.id, message, plan, "MEAL_PLAN_DELIVERY");
    return plan;
  }

  // ---- DIET PLAN / MEAL PLAN — redirect to goal-adjusted shopping list ----
  // Catches remaining nutrition-plan queries that aren't the explicit meal plan triggers above.
  const isDietPlanRequest = ["nutrition plan", "my nutrition plan", "my eating plan", "my diet", "diet"].includes(m)
    || /\b(i need a diet plan|send.*diet plan|nutrition plan|food plan|what should i eat this week)\b/i.test(m);
  if (isDietPlanRequest) {
    const budget = user.weeklyFoodBudget || "100_300";
    const weekNum = user.programmeWeek || 1;
    const goal = user.goalType || "fat_loss";
    const firstName = user.name?.split(" ")[0] || "there";
    const list = getShoppingList(budget, weekNum, goal);
    const personalization = await getGroceryPersonalization(user.id, goal, (user as any).foodDislikes);
    const listText = formatShoppingList(list, firstName, goal, {
      calorieTarget: user.calorieTarget || undefined,
      proteinTarget: user.proteinTarget || undefined,
      budgetTier: budget,
      personalization,
    });
    const intro = goal === "muscle_gain"
      ? `${firstName}, a diet plan tells you what to eat — and most people stop following it by Wednesday. A shopping list builds the habit. Buy the right things and the eating takes care of itself.\n\n`
      : `${firstName}, diet plans don't work long-term — they're too rigid and people fall off. What actually works is buying the right things. Here's your goal-adjusted shopping list:\n\n`;
    const reply = `${intro}${listText}\n\n_Send me your own grocery list and I'll adjust it for your ${goal === "muscle_gain" ? "muscle building" : "fat loss"} goal. Or reply *meal plan* for your personalised 3-day eating plan._`;
    await logChat(user.id, message, reply, "DIET_PLAN_REDIRECT");
    return reply;
  }

  // ---- 7 DAY MEALS — explicit request for onboarding-style plan ----
  if (["7 day meals", "7day meals"].includes(m)) {
    return getOnboardingMealPlan(user);
  }

  // ---- SWAP [day] command ----
  const swapMatch = m.match(/^swap\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i);
  if (swapMatch) {
    const swapDay = swapMatch[1].charAt(0).toUpperCase() + swapMatch[1].slice(1).toLowerCase();
    const budget = user.weeklyFoodBudget || "100_300";
    const goal = user.goalType || "fat_loss";
    const otherNotes = (user.otherMedicalNotes || "").toLowerCase();
    const _sdPNotes = (user.profileNotes || "").toLowerCase();
    const _sdVegan = _sdPNotes.includes("diet:vegan");
    const _sdVeg = _sdPNotes.includes("diet:vegetarian") || _sdVegan;
    const noFish = otherNotes.includes("fish") || otherNotes.includes("pilchard") || otherNotes.includes("tuna") || _sdVeg;
    const noDairy = otherNotes.includes("dairy") || otherNotes.includes("milk") || otherNotes.includes("lactose") || _sdVegan;
    const noPeanuts = otherNotes.includes("peanut");
    const medicals = (user.medicalConditions || "").split(",").map((s: string) => s.trim());
    const isLowGI = medicals.includes("diabetes") || medicals.includes("pcos");
    const bfCal = Math.round((user.calorieTarget || 1800) * 0.25);
    const lunchCal = Math.round((user.calorieTarget || 1800) * 0.35);
    const dinnerCal = Math.round((user.calorieTarget || 1800) * 0.28);
    const carbAlt = isLowGI ? "½ cup samp and beans" : goal === "muscle_gain" ? "1 cup brown rice" : "1 medium sweet potato";
    const protAlt = _sdVegan
      ? (budget === "under_100" ? "1 cup cooked lentils" : "150g firm tofu")
      : _sdVeg
      ? (budget === "under_100" ? "3 boiled eggs" : "200g cottage cheese")
      : noFish
      ? (budget === "under_100" ? "3 boiled eggs" : "150g chicken thigh")
      : (budget === "under_100" ? "1 tin pilchards" : "2 eggs + baked beans");
    const _sdBf = _sdVegan
      ? (isLowGI ? "½ cup oats + soya milk + banana" : goal === "muscle_gain" ? "1 cup oats + soya milk + peanut butter" : "½ cup oats + soya milk + 2 tbsp peanut butter")
      : (isLowGI ? `½ cup oats + ${noDairy ? "water" : "low fat milk"} + 2 boiled eggs` : goal === "muscle_gain" ? "3 eggs scrambled + 1 cup oats + banana" : "½ cup oats + 2 boiled eggs");
    const _sdDinner = _sdVegan ? "soya mince + cabbage" : _sdVeg ? "2 eggs + cabbage" : "½ tin pilchards + cabbage";
    const dairySnack = noDairy ? "baked beans ½ tin — 110 cal, 7g protein" : "low fat yoghurt 150g — 100 cal, 10g protein";
    const pbItem = noPeanuts ? "1 extra boiled egg" : "1 tbsp peanut butter";

    return `*${swapDay} — Alternative Meals*\n\nBreakfast: ${_sdBf} — ${bfCal} cal\n\nLunch: ${protAlt} + ${carbAlt} + spinach — ${lunchCal} cal\n\nSnack: ${goal === "muscle_gain" ? `${pbItem} + banana` : dairySnack}\n\nDinner: ${_sdDinner} — ${dinnerCal} cal\n\nReply SWAP [any other day] to swap another day.`;
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

  // ---- TARGET WEIGHT DETECTION — "I want to get to 70kg", "my goal is 75kg" ----
  const targetWeightMatch = m.match(/\b(?:get(?:\s+down)?|lose\s+(?:weight\s+)?(?:to|down\s+to)|reach|hit|weigh|target(?:\s+is|\s+weight)?|goal(?:\s+is|\s+weight)?|aim(?:ing)?\s+(?:for|to\s+(?:get\s+)?to)|slim\s+down\s+to)\s+(?:to\s+)?(\d{2,3}(?:\.\d)?)\s*kg\b/i);
  if (targetWeightMatch) {
    const targetKg = parseFloat(targetWeightMatch[1]);
    if (targetKg >= 35 && targetKg <= 200 && targetKg !== parseFloat(user.currentWeight || "0")) {
      await db.update(users).set({ targetWeightKg: targetKg.toString() }).where(eq(users.phoneNumber, phone));
      user.targetWeightKg = targetKg.toString();
    }
  }

  // ---- DIET BREAK ----
  const isDietBreakRequest = /\b(diet.?break|maintenance.?week|eat at maintenance|taking a break from dieting|break from the diet|week off the diet|diet.?rest|refeed week|refeed)\b/i.test(m);
  if (isDietBreakRequest) {
    const goal = user.goalType || "fat_loss";
    const week = user.programmeWeek || 1;
    const activeDietBreak = user.dietBreakEndsAt && new Date(user.dietBreakEndsAt) > new Date();
    if (activeDietBreak) {
      const daysLeft = Math.ceil((new Date(user.dietBreakEndsAt!).getTime() - Date.now()) / 86_400_000);
      const dbReply = `${capName}, you're already on a diet break — ${daysLeft} day${daysLeft !== 1 ? "s" : ""} left. Eat at ${user.calorieTarget} kcal, same protein. After that, we go back to the deficit and push hard.`;
      await logChat(user.id, message, dbReply, "DIET_BREAK");
      return dbReply;
    }
    if (goal !== "fat_loss") {
      const dbReply = `${capName}, diet breaks are for fat loss phases — you're in ${goal.replace("_", " ")} mode. Keep eating at your current targets.`;
      await logChat(user.id, message, dbReply, "DIET_BREAK");
      return dbReply;
    }
    if (week < 8) {
      const dbReply = `${capName}, diet breaks kick in after 8+ weeks of consistent deficit. You're on week ${week} — not there yet. Stay on the programme.`;
      await logChat(user.id, message, dbReply, "DIET_BREAK");
      return dbReply;
    }
    // Eligible — start a 7-day diet break
    const maintenanceCals = (user.calorieTarget || 1800) + 300;
    const breakEnds = new Date(Date.now() + 7 * 86_400_000);
    await db.update(users).set({
      dietBreakEndsAt: breakEnds,
      dietBreakCalTarget: user.calorieTarget || 1800,
      calorieTarget: maintenanceCals,
    }).where(eq(users.phoneNumber, phone));
    const dbReply = `${capName}, diet break starts now — 7 days at maintenance.\n\n• Calories: *${maintenanceCals} kcal/day*\n• Protein: ${user.proteinTarget || 120}g/day — unchanged\n\nSame foods, just add more carbs (sweet potato, oats, rice). Scale may go up 0.5–1kg — that's glycogen, not fat. In 7 days we go back to the deficit. I'll remind you.`;
    await logChat(user.id, message, dbReply, "DIET_BREAK");
    return dbReply;
  }

  // ---- ADAPTIVE DELIVERY (numbers-literacy.ts): numbers on/off, confusion, tone dial ----
  const toneReply = await handleToneSignal({ message, m, user, capName, phone });
  if (toneReply !== null) return toneReply;
  const voicePrefReply = await handleVoiceReplyPreference({ message, m, user, capName, phone });
  if (voicePrefReply) return voicePrefReply;

  const literacyReply = await handleNumbersLiteracy({ message, m, user, capName, phone });
  if (literacyReply !== null) return literacyReply;

  // ---- ADVICE & MASTERCLASS COMMANDS (server/handlers/advice-commands.ts) — extracted for
  // file-size + isolation; identical behaviour, same order, same ENGINE_LIVE gates. ----
  const adviceReply = await handleAdviceCommands({ message, m, user, phone });
  if (adviceReply !== null) return adviceReply;

  // ---- BUTTON TAPS: Workout delivery buttons ----
  if (m === "too hard — modify" || m === "too hard - modify") {
    const effectiveUser = tempEquipmentMode.has(phone)
      ? { ...user, trainingMode: tempEquipmentMode.get(phone) }
      : user;
    const workout = buildDayWorkout(effectiveUser);
    const modReply = `${firstName ? firstName + ", h" : "H"}ere's the modified version.\n\n*How to scale it down:*\n• Drop weight by 20–30%\n• Do 2 sets instead of 3\n• Rest 90 seconds between sets (not 60)\n• Skip anything causing sharp pain — swap for walking\n\n${workout}\n\nThis still counts as a full session. Send *done* when you're finished.`;
    await logChat(user.id, message, modReply, "WORKOUT_MODIFY");
    return modReply;
  }

  if (/^too easy$/i.test(m) || m === "this is too easy" || m === "way too easy" || m === "too light") {
    const currentMode = user.trainingMode || "home";
    if (currentMode === "walk_only" || currentMode === "walk") {
      // Walk-only user saying it's too easy — upgrade them to home training
      await db.update(users).set({ trainingMode: "home" }).where(eq(users.phoneNumber, phone));
      const upgradedUser = { ...user, trainingMode: "home" };
      const workout = buildDayWorkout(upgradedUser);
      const upgradeReply = `${firstName ? firstName + ", g" : "G"}ood — that means you're ready for real training.\n\nI've switched you to the full home programme. No equipment needed.\n\n${workout}\n\nSend *done* when you've finished.`;
      await logChat(user.id, message, upgradeReply, "WORKOUT_UPGRADE_FROM_WALK");
      return upgradeReply;
    }
    // Already on home/gym — give intensity upgrades
    const intReply = `${firstName ? firstName + ", g" : "G"}ood — here's how to make it harder:\n\n• Add 1 more set to every exercise (3 → 4)\n• Cut rest from 60s to 30s between sets\n• Slow the eccentric down: 3 seconds on the way down, explode up\n• Add a 4th exercise: 3×15 jump squats or 3×10 burpees at the end\n\nIf it still feels easy next session, message me and I'll bump up your programme difficulty permanently.`;
    await logChat(user.id, message, intReply, "WORKOUT_TOO_EASY");
    return intReply;
  }

  if (m === "skip today") {
    const streak = user.workoutStreak || 0;
    const streakLine = streak >= 3
      ? `Your ${streak}-session streak is noted. One planned skip won't break it — two in a row will.\n\n`
      : ``;
    const skipReply = `${streakLine}Rest day logged. Eat your protein, stay hydrated.\n\n*Rule:* never miss twice. One skip is fine. Two in a row is the start of a habit.\n\nTomorrow's session is waiting — send *menu* when you're ready.`;
    await logChat(user.id, message, skipReply, "WORKOUT_SKIP");
    return skipReply;
  }

  // ---- BUTTON TAPS: Evening accountability buttons ----
  if (m === "doing it tonight") {
    const reply = `${firstName ? firstName + ", g" : "G"}et it done. Send *done* when you've finished and I'll log it.`;
    await logChat(user.id, message, reply, "EVENING_COMMIT");
    return reply;
  }

  if (m === "swap to tomorrow") {
    const reply = `${firstName ? firstName + ", t" : "T"}omorrow then — but pick your time right now and stick to it. I'll be here when you send *done*.`;
    await logChat(user.id, message, reply, "EVENING_SWAP");
    return reply;
  }

  if (m === "rest day today") {
    const reply = `Rest day logged. Eat your protein and walk if you can. Training resumes next session.`;
    await logChat(user.id, message, reply, "REST_DAY_LOGGED");
    return reply;
  }

  // ---- BUTTON TAPS: Combo upsell buttons ----
  if (m === "add veg side") {
    const goal = user.goalType || "fat_loss";
    const vegReply = `*Quick veg sides — 5 minutes or less:*\n\n🥬 *Spinach* — wilt in a pan with garlic, 2 min. 23 kcal, 3g protein.\n🥦 *Frozen broccoli* — microwave 3 min. 55 kcal, 4g protein per cup.\n🥗 *Cabbage* — shred, stir-fry with onion. 22 kcal per cup. Best budget veg in SA.\n🍅 *Tomato + onion* — slice raw, no cooking needed.\n\n${goal === "muscle_gain" ? "Add spinach — iron supports muscle recovery." : "Cabbage and spinach fill you up without touching your calorie budget."}\n\nLog it when you're done.`;
    await logChat(user.id, message, vegReply, "VEG_SIDE");
    return vegReply;
  }

  if (m === "no thanks" || m === "no thank you") {
    const reply = `No problem. Log your next meal whenever you're ready.`;
    await logChat(user.id, message, reply, "NO_THANKS");
    return reply;
  }

  // ---- COMEBACK AFTER SILENCE (2+ days) ----
  // Detect when a client returns with an excuse/explanation after going quiet.
  // Respond with empathy and a clean restart plan — not a workout delivered cold.
  // Guard: do NOT intercept profile-update messages (training mode, goals, days) —
  // those MUST fall through to lifecycle.ts isProfileUpdate handler.
  const isProfileUpdateMsg =
    /\b(train(ing)?\s+(at|from|to)?\s*(home|gym)|home\s+workout|i\s+train|working\s+out\s+(at\s+)?home|joined.*gym|going.*gym|quit.*gym|no.*gym|left.*gym|change.*goal|my\s+goal\s+is|switch\s+to|new\s+goal|update.*goal|change.*training|training\s+days?)\b/i.test(m);
  // Must have an explicit return/excuse phrase — short messages like "done", "today",
  // "menu", "1" are action intent, not comebacks, and must fall through to their handlers.
  const isComeback = isReturning && !isProfileUpdateMsg &&
    /\b(i.?m back|i am back|back now|returning|i.?ve been|been (busy|away|sick|off|struggling|stressed)|sorry (i|for|about)|haven.?t been|couldn.?t|wasn.?t able|let me start|can we start|starting again|picking up|back on track|back to it|resuming|fresh start|starting fresh|been (a|so) (long|while)|miss(ed)? (a|this|it)|been MIA|went quiet|disappeared|fell off|going through (a lot|it|stuff|things)|things (have been|been) (crazy|hectic|tough|hard|rough|mad)|life (got|gets?) (in the way|busy)|had a (rough|tough|hard) (week|month|time|period)|what did i miss|catch me up|where (was|did) i (leave off|stop)|been meaning to (come back|check in))\b/i.test(m);

  if (isComeback) {
    const daysText = daysSilent <= 7 ? `${daysSilent} day${daysSilent === 1 ? "" : "s"}` : daysSilent <= 14 ? "about a week" : "a while";

    // Pull their last-logged stats so the comeback feels informed, not generic.
    const snapLines: string[] = [];
    try {
      const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);
      const calorieTarget = user.calorieTarget || 1800;
      const proteinTarget = user.proteinTarget || 120;
      const stepsTarget = user.stepsTarget || 8500;

      const [mealRows, stepRows, workoutCount] = await Promise.all([
        db.select({
          cals: sql<number>`COALESCE(SUM(${mealLogs.kcalInt}), 0)::int`,
          prot: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
          day:  sql<string>`DATE(${mealLogs.loggedAt} + INTERVAL '2 hours')`,
        })
          .from(mealLogs)
          .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, fourteenDaysAgo)))
          .groupBy(sql`DATE(${mealLogs.loggedAt} + INTERVAL '2 hours')`),
        db.select({ steps: stepLogs.steps })
          .from(stepLogs)
          .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, fourteenDaysAgo)))
          .limit(14),
        db.select({ n: count() })
          .from(workoutLogs)
          .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, fourteenDaysAgo))),
      ]);

      if (user.currentWeight) snapLines.push(`⚖️ Weight on file: *${user.currentWeight}kg*`);

      const loggedDays = mealRows.filter(r => r.cals > 0);
      if (loggedDays.length > 0) {
        const avgCals = Math.round(loggedDays.reduce((s, r) => s + r.cals, 0) / loggedDays.length);
        const avgProt = Math.round(loggedDays.reduce((s, r) => s + r.prot, 0) / loggedDays.length);
        const calNote = avgCals < calorieTarget - 100
          ? `avg *${avgCals} kcal/day* — ${calorieTarget - avgCals} below your ${calorieTarget} target`
          : avgCals > calorieTarget + 100
            ? `avg *${avgCals} kcal/day* — ${avgCals - calorieTarget} above your ${calorieTarget} target`
            : `avg *${avgCals} kcal/day* — right on target ✅`;
        snapLines.push(`🍽️ Food: ${calNote}`);
        snapLines.push(`💪 Protein: avg *${avgProt}g/day* ${avgProt >= proteinTarget ? "✅" : `(target: ${proteinTarget}g)`}`);
      }

      if (stepRows.length > 0) {
        const avgSteps = Math.round(stepRows.reduce((s, r) => s + (r.steps || 0), 0) / stepRows.length);
        snapLines.push(`👟 Steps: avg *${avgSteps.toLocaleString()}/day* ${avgSteps >= stepsTarget ? "✅" : `(target: ${stepsTarget.toLocaleString()})`}`);
      }

      const sessions = workoutCount[0]?.n || 0;
      snapLines.push(sessions > 0
        ? `🏋️ Training: *${sessions}* session${sessions !== 1 ? "s" : ""} in the 14 days before you went quiet`
        : `🏋️ Training: no sessions logged in the 14 days before your absence`);
    } catch { /* briefing is non-critical — warm restart still happens */ }

    const weekNote = user.programmeWeek ? ` You're on *Week ${user.programmeWeek}* of your programme.` : "";
    const snapSection = snapLines.length > 0 ? `\n\n*Where you left off:*\n${snapLines.join("\n")}` : "";

    const comingBackReply = `${capName}, welcome back.${snapSection}\n\n${daysText} away — everyone has those stretches.${weekNote} Targets, programme, and logs are exactly where you left them.\n\n*To get back into it:*\n1. Tell me what you've eaten today (even if it wasn't great)\n2. Send your steps if you walked\n3. Say *workout* when you're ready to train\n\nNo guilt. No catching up. Just today. Let's go.`;
    await logChat(user.id, message, comingBackReply, "COMEBACK");
    return comingBackReply;
  }

  // ---- CONNECT STEPS — sync from health apps ----
  const isConnectSteps = /\b(connect(ing)?(\s+my)?\s+steps?|sync(ing)?(\s+my)?\s+steps?|link(ing)?(\s+my)?\s+(health\s+app|step\s+tracker|google\s+fit|apple\s+health|samsung\s+health|fitbit)|connect\s+(google\s+fit|apple\s+health|health\s+app|step\s+tracker|fitbit)|auto\s+(sync|track|log)\s+steps?|step\s+(sync|auto|connect)|auto.*steps?)\b/i.test(m);
  if (isConnectSteps) {
    const appUrl = process.env.APP_URL || "https://kamlife.co.za";
    const setupUrl = `${appUrl}/connect-steps?phone=${encodeURIComponent(phone)}`;
    const connectReply = `Tap this link on your phone — your personal setup page is ready:\n\n${setupUrl}\n\nWorks for both Android and iPhone. Your link is already filled in. Takes 2 minutes.\n\nReply *steps connected* once done and I'll confirm it's working.`;
    await logChat(user.id, message, connectReply, "STEPS_CONNECT_GUIDE");
    return connectReply;
  }

  if (m === "steps connected" || m === "step connected" || m === "steps synced" || m === "steps set up" || m === "steps linked") {
    const confirmReply = `${firstName ? firstName + ", " : ""}I'll watch for your first automatic sync tonight. Once I receive it, I'll confirm and your daily steps will show up in morning check-ins without you having to send them.\n\nIf it doesn't arrive by tomorrow morning, double-check the webhook URL is exactly right and that you selected "Steps" as the data type.`;
    await logChat(user.id, message, confirmReply, "STEPS_CONNECT_CONFIRM");
    return confirmReply;
  }

  // ---- CONFUSION / LOST USER — catch truly unclear messages before GPT ----
  // Only fires for genuinely ambiguous single-word or short confusion signals.
  // Specific questions ("how many calories", "what should i eat") are handled earlier.
  const CONFUSED_EXACT = new Set(["what", "what?", "huh", "huh?", "???", "??", "!?", "?", "what now", "lost", "confused", "help me", "i'm lost", "im lost"]);
  // BROADENED 2026-07-29. The old list caught "don't understand" and "don't get it" but not
  // "I don't know what any of this means" or "explain that again" — so the most literal requests
  // for a simpler explanation fell through to the generic "I didn't quite catch that", which
  // tells a confused client that THEY were unclear. Shape, not enumeration: not-knowing or
  // not-following, or an explicit ask to have it put more simply.
  const ASKS_FOR_SIMPLER = /\b(?:explain (?:that|this|it)(?: again)?|say (?:that|it) again|what does (?:that|this|it) mean|in simple (?:terms|english)|simpler|dumb it down|i don.?t know what (?:any of )?(?:this|that|it) means?|makes? no sense|too (?:complicated|confusing|much))\b/i;
  const isConfused = CONFUSED_EXACT.has(m)
    || /^(\?{2,}|!{2,}|\?!+)$/.test(m)
    || /\b(i.?m (lost|confused|not sure)|don.?t (understand|get it)|what do i do( now)?|not sure what to (do|say|send)|how does this work)\b/i.test(m)
    || ASKS_FOR_SIMPLER.test(m);
  if (isConfused) {
    // NEITHER BRANCH USED TO ANSWER THE QUESTION (2026-07-29 sweep). "I don't understand" got
    // the entire help menu when the last reply was over 30 minutes old — and on WhatsApp people
    // answer hours later, so that was the common case, not the rare one. Under 30 minutes it got
    // "Sorry, I didn't quite catch that", which is the coach saying IT was confused when the
    // CLIENT is the one asking to be helped. A menu is a sitemap and a shrug is a shrug; neither
    // is simpler, and simpler is the entire ask.
    //
    // A confused client wants ONE concrete thing to do, in words, with no jargon — which is
    // exactly what one-action.ts produces. So confusion now returns the day's single action.
    // The acknowledgement still leads when there is something to react to, so it never reads as
    // the bot ignoring what just happened.
    const [lastOut] = await db.select({ messageOut: chatHistory.messageOut })
      .from(chatHistory)
      .where(and(eq(chatHistory.userId, user.id), gte(chatHistory.createdAt, new Date(Date.now() - 6 * 3_600_000))))
      .orderBy(desc(chatHistory.createdAt)).limit(1);
    let action = "";
    try {
      const { oneActionCommand } = await import("./one-action-command");
      action = (await oneActionCommand(user, { atKeyboard: true })).replace(/\[BUTTONS:[^\]]+\]/g, "").trim();
    } catch (e) {
      console.warn("[CONFUSED] one-action failed:", (e as any)?.message || e);
    }
    // A QUESTION IS NEVER CONFUSION (2026-07-31 live). Kam asked by voice why his step
    // target moved from 10,000 to 6,000; this branch called it confusion, promised "let me
    // put it simply", explained nothing, and told him to stand on a scale. Never answer a
    // real question with the day's action. Defer — the engine is ahead of this now.
    if (ctx.isQuestion || /\?/.test(message)) return null;
    // And no preamble that promises a simplification the next line does not deliver.
    const lead = firstName ? `${firstName} — here's the one that matters:` : `Here's the one that matters:`;
    // Only fall back to the menu if the one action could not be built at all. A sitemap is a
    // worse answer than a plain instruction, so it is the last resort, never the first.
    if (!action) {
      const menuReply = await getMenuText(user, { showCommands: true });
      await logChat(user.id, message, menuReply.replace(/\[BUTTONS:[^\]]+\]/g, "").trim(), "CONFUSED_RECOVERY");
      return menuReply;
    }
    const reply = `${lead}\n\n${action}`;
    await logChat(user.id, message, reply, "CONFUSED_ONE_ACTION");
    return reply;
  }

  return null;
}

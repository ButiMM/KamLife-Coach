import { db } from "../db";
import { users, workoutLogs, chatHistory, mealLogs, stepLogs } from "../../shared/schema";
import { eq, and, gte, desc, count } from "drizzle-orm";
import { SA_FOODS_SEED } from "../foods";
import { buildDayWorkout, buildFullProgramme } from "../programme";
import { calculateTargets } from "../targets";
import { askCoachK } from "../gpt";
import { getShoppingList, formatShoppingList } from "../shopping-lists";
import { sendWhatsApp } from "../scheduler";
import { scanForSAFoods, recomputeTodayFoodTotals, invalidateFoodTotalsCache } from "./food-scanner";
import { logChat, withTimeout } from "./chat-log";
import { getMenuText, getOnboardingMealPlan } from "../onboarding";
import { getPrimaryWorkoutGifUrl } from "../exercise-media";
import { getProgressiveOverloadContext } from "./checks";
import { sastDayStart, parseMealDate, isRetroactiveMeal, mealDateLabel } from "../utils";
import { educationNote, remainingInMeals } from "../education";
import { getTodayWorkoutState, getTodaySlot } from "../workout-state";
import { generateMealPlan } from "../meal-plan";

// In-memory maps for holiday/travel equipment mode — module-level so they
// persist across requests (same process lifetime as the original routes.ts).
export const tempEquipmentMode = new Map<string, string>();
export const awaitingEquipmentAnswer = new Map<string, boolean>();

export async function handleEarlyCommands(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
}): Promise<string | null> {
  const { phone, message, m, user } = ctx;
  const firstName = user.name?.split(" ")[0] || "";

  // ---- PORTION CONTROL / HOW TO MEASURE — hand-portion method, goal-aware ----
  // The #1 post-onboarding question. We deliberately DON'T teach calorie counting or
  // food scales — research and retention both favour the hand method: always available,
  // sized to the body, sustainable. Anxious trackers especially need the pressure taken off.
  // Runs BEFORE the calorie-target INSTANT ANSWER block so "how do I count calories" gets
  // the METHOD, not just their target number. Target-number phrasings ("calories left",
  // "my calorie target") contain no measure/count/portion words and fall through correctly.
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

  // ---- INSTANT ANSWERS — cached from DB, zero GPT cost ----
  if (
    /\b(daily calories|calorie target|calories target|my calories|my calorie|kcal target|daily kcal)\b/i.test(m) ||
    /\b(calorie|calories|kcal)\b.*\b(target|goal|limit|daily|mine|my|remaining|left|still|remain)\b/i.test(m) ||
    /\b(daily|my|total|remaining)\b.*\b(calorie|calories|kcal)\b/i.test(m) ||
    /\b(how many|how much).*(calorie|calories|kcal|left|remaining)\b/i.test(m) ||
    /\b(calories today|today.?s calories|today calories|calories for today|protein today|what.?s left|whats left|calories left|calories remaining|remaining calories|total remaining|how much.*left|how much.*remaining|can i still eat|what can i eat|how much more|am i over|what (have|did) i (eat|ate|log|track)|food today|what i (ate|ate today|had today)|today.?s food|today.?s intake|today.?s totals?|total today|totals today|macros today|today.?s macros?)\b/i.test(m) ||
    m === "calories" || m === "calorie" || m === "kcal" || m === "remaining" || m === "what's left" ||
    m === "today's calories" || m === "todays calories" || m === "today's food" || m === "today's intake"
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

  // ---- BACK TO GYM / CLEAR HOLIDAY MODE ----
  // Fires before the holiday check so "back at the gym" doesn't re-trigger the equipment question.
  if (/\b(back (at|to|in) (the )?gym|back from (holiday|vacation|trip|travel)|back to (my )?(regular )?(gym|normal training|programme)|gym mode|cleared.*holiday|no longer (on holiday|travelling|traveling|away))\b/i.test(m)) {
    tempEquipmentMode.delete(phone);
    awaitingEquipmentAnswer.delete(phone);
    user.awaitingInputType = null; await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone)).catch((e) => console.error("[AWAITING] clear failed:", e));
    const backMsg = `${firstName ? firstName + ", b" : "B"}ack to your regular programme. Reply *menu* or *workout* for today's session.`;
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

  // If holiday/travel/gym-closed mentioned, ask what equipment they have
  const isWorkoutRequestInMessage = /\b(workout|training|session|programme|program|exercise|gym|train|send me|my workout|today)\b/i.test(m);
  if (isHolidayMention) {
    awaitingEquipmentAnswer.set(phone, true);
    user.awaitingInputType = "equipment";
    await db.update(users).set({ awaitingInputType: "equipment" }).where(eq(users.phoneNumber, phone)).catch((e) => console.error("[AWAITING] set equipment failed:", e));
    const equipQ = `${firstName ? firstName + ", w" : "W"}hat do you have access to where you are? Reply:\n\n*1 — gym* — full machines and cables\n*2 — dumbbells* — dumbbells only\n*3 — nothing* — no equipment, bodyweight only`;
    await logChat(user.id, message, equipQ, "EQUIPMENT_QUESTION");
    return equipQ;
  }

  // ---- PERMANENT EQUIPMENT UPDATE ----
  // When user tells us they've changed their setup (joined a gym, bought dumbbells, etc.)
  // Negation guard: "I have NO gym access", "don't have weights", "can't get to the gym"
  // is the OPPOSITE of an equipment upgrade — without this, "no gym access this week"
  // flipped the client's programme to full gym (caught by routing-audit).
  const negatedEquipment =
    /\b(no|don'?t|do not|won'?t|can'?t|cannot|without|lost|left|quit|cancelled?|stopped)\b[\w\s]{0,18}\b(gym|equipment|dumbbells?|weights|bands?|access)\b/i.test(m) ||
    /\bno\s+(gym\s+)?access\b/i.test(m);
  const isEquipmentUpdate = !negatedEquipment && (
    /\b(i (have|got|bought|use|train with|now have|just got)|my (home )?(equipment|kit|setup|gear) is|i.?ve (got|purchased|bought))\b.{0,40}\b(dumbbell|dumbbells|db|resistance band|bands|gym|weights|full gym)\b/i.test(m) ||
    /\b(joined|signed up|now (go to|at|train at)|started at|going to)\b.{0,20}\b(gym|virgin|planet fitness|curves|fitness centre)\b/i.test(m) ||
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
      const reply = `Got it — programme updated to *${modeLabel}*. Your next session will reflect that.\n\nReply *workout* to see today's updated session.`;
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

  if (m === "my programme" || m === "programme" || m === "my workout" || m === "1" || m === "workout" || /^today.?s?\s+workout\W*$/i.test(m) || /^(today|1|workout|my workout|my programme|programme)$/.test(m)) {
    // Cooldown: if we already delivered a full workout in the last 5 minutes, don't resend.
    // This prevents 3 identical bench-press images when the user taps "workout" rapidly
    // because they think the first reply didn't arrive.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const recentWorkoutSends = await db.select({ intent: chatHistory.intent })
      .from(chatHistory)
      .where(and(
        eq(chatHistory.userId, user.id),
        gte(chatHistory.createdAt, fiveMinutesAgo),
      ))
      .orderBy(desc(chatHistory.createdAt))
      .limit(10);
    if (recentWorkoutSends.some(r => ["WORKOUT_VIEW", "WORKOUT_MISSED_CATCHUP", "WORKOUT_HOLIDAY"].includes(r.intent || ""))) {
      const cooldownReply = `Your workout is just above ↑ — it was sent a moment ago. Type *done* when you've finished the session.`;
      await logChat(user.id, message, cooldownReply, "WORKOUT_COOLDOWN");
      return cooldownReply;
    }

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

    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

    // REST DAY
    if (state.type === "REST") {
      const restNote = pick([
        "Recovery is when your muscles actually grow. No session today.",
        "Rest days are part of the programme. Your body rebuilds today.",
        "Scheduled rest. This is when the adaptation happens — don't skip the recovery.",
        "Today's job: eat well, sleep well, move lightly. No workout needed.",
      ]);
      const restReply = `*${state.todayName} — Rest Day.*\n\n${restNote}\n\nNext training day: *${state.nextTrainingName}*.\n\nHit your food and steps today. Reply *workout* only if you want to train anyway.`;
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
      const catchupIntro = pick([
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
      const missedReply = `${catchupIntro}\n\n*Week ${week} — Session ${sessionNum + 1}*\n\n${poContext}${workout}${injuryNote}\n\nSend *done* when finished. Log lifts: "bench 80kg 3x10"${gifMarker}[BUTTONS:Done 💪|Too hard — modify|Skip today]`;
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
    const reply = `${weekNote}${poContext}${workout}${injuryNote}\n\nSend *done* when finished. Log lifts: "bench 80kg 3x10"${gifMarker}[BUTTONS:Done 💪|Too hard — modify|Skip today]`;
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
    /\b(i need more|need more|need harder|more challenging|harder workout|upgrade my (programme|program|workout|training)|i want harder|want harder|want more intense|more intense workout|want a harder|need a harder)\b/i.test(m)
  );

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
    const modeLabel = trainingMode === "gym" ? "Gym" : trainingMode === "gym_dumbbell" ? "Dumbbell Gym" : "Home";
    const cal = user.calorieTarget ? `🔥 *Calories:* ${user.calorieTarget} kcal/day\n` : "";
    const prot = user.proteinTarget ? `💪 *Protein:* ${user.proteinTarget}g/day\n` : "";
    const steps = user.stepsTarget ? `👟 *Steps:* ${user.stepsTarget.toLocaleString()}/day\n` : "";
    const targetsLine = (cal || prot || steps) ? `\n*Your daily targets:*\n${cal}${prot}${steps}` : "";
    const reply = `Sharp. ${trainingDays} days/week. ${modeLabel}. ${experience.charAt(0).toUpperCase() + experience.slice(1)}. Here is your programme.\n\n${programme}${targetsLine}\n\n_Reply *menu* anytime to see all your options — workouts, food log, targets, shopping list, and more._`;
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
  if (greetings.includes(mGreet)) {
    return await getMenuText(user);
  }
  if (m === "menu" || m === "help") {
    return await getMenuText(user, { showCommands: true });
  }

  // ---- SHOPPING LIST command ----
  if (m === "4" || ["shopping list", "shoppinglist", "shopping", "shop", "grocery list", "groceries", "my groceries", "weekly shop", "weekly shopping", "what to buy", "what should i buy", "what must i buy"].includes(m)) {
    const budget = user.weeklyFoodBudget || "100_300";
    const weekNum = user.programmeWeek || 1;
    const goal = user.goalType || "fat_loss";
    const list = getShoppingList(budget, weekNum, goal);
    const reply = formatShoppingList(list, user.name || undefined, goal);
    await logChat(user.id, message, reply, "SHOPPING_LIST");
    return reply;
  }

  // ---- SAME-AS QUICK LOG — label-agnostic, flexible time window ----
  // Works regardless of meal labels. Users say "same as yesterday", "dinner same as lunch",
  // "2 days ago", etc. — we find the best matching meal by rawMessage keyword or position.
  const sameAsMatch =
    m.match(/\b(?:same|repeat|again|copy|log\s+(?:my\s+)?same)\b.*\b(breakfast|lunch|dinner|supper|snack|meal|yesterday|before|last)\b/i)
    || m.match(/\b(breakfast|lunch|dinner|supper|snack)\b.*\b(?:same|again|repeat|yesterday)\b/i)
    || /^same$/.test(m);

  if (sameAsMatch) {
    // Cross-meal: "dinner same as lunch" → copy FROM lunch, log AS dinner
    const crossMealM =
      m.match(/\b(breakfast|lunch|dinner|supper|snack)\b.{0,60}?\bsame\s+as\s+(?:my\s+)?(breakfast|lunch|dinner|supper|snack)\b/i)
      || m.match(/\bsame\s+(breakfast|lunch|dinner|supper|snack)\s+as\s+(?:my\s+)?(breakfast|lunch|dinner|supper|snack)\b/i);
    const targetLabel = crossMealM ? crossMealM[1].toLowerCase().replace("supper", "dinner") : null;
    const sourceHint = crossMealM
      ? crossMealM[2].toLowerCase().replace("supper", "dinner")
      : (m.match(/\b(breakfast|lunch|dinner|supper|snack)\b/i)?.[1]?.toLowerCase().replace("supper", "dinner") || null);

    // How many days back to look
    const daysBack = /\b(?:three|3)\s*days?\s*(?:ago|back)\b/i.test(m) ? 3
      : /\b(?:two|2)\s*days?\s*(?:ago|back)\b/i.test(m) ? 2
      : /\byesterday\b/i.test(m) ? 1
      : 0;

    try {
      const todayStart = sastDayStart();
      // Always fetch last 3 days — covers all possible references
      const windowStart = new Date(todayStart.getTime() - 3 * 86_400_000);
      const allMeals = await db.select().from(mealLogs)
        .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, windowStart)))
        .orderBy(desc(mealLogs.loggedAt))
        .limit(30);

      // Pool = the right time slice for the request
      let poolMeals: typeof allMeals;
      if (daysBack > 0) {
        const dayStart = new Date(todayStart.getTime() - daysBack * 86_400_000);
        const dayEnd = new Date(todayStart.getTime() - (daysBack - 1) * 86_400_000);
        poolMeals = allMeals.filter(l => l.loggedAt && new Date(l.loggedAt) >= dayStart && new Date(l.loggedAt) < dayEnd);
        // Widen if specific day had nothing substantial
        if (poolMeals.filter(l => (l.kcalInt || 0) >= 150).length === 0) {
          poolMeals = allMeals.filter(l => l.loggedAt && new Date(l.loggedAt) < todayStart);
        }
      } else {
        poolMeals = allMeals; // include today for cross-meal ("dinner same as lunch")
      }

      // Find best match — no label required.
      // Priority: rawMessage keyword → mealLabel → positional → most recent substantial meal.
      const findBestMeal = (meals: typeof allMeals, hint: string | null) => {
        const sub = meals
          .filter(l => (l.kcalInt || 0) >= 150)
          .sort((a, b) => new Date(b.loggedAt!).getTime() - new Date(a.loggedAt!).getTime());
        if (sub.length === 0) return meals.find(l => (l.kcalInt || 0) >= 50) || null;
        if (hint) {
          const byRaw = sub.find(l => l.rawMessage && new RegExp(`\\b${hint}\\b`, "i").test(l.rawMessage));
          if (byRaw) return byRaw;
          const byLabel = sub.find(l => (l.mealLabel || "").toLowerCase() === hint);
          if (byLabel) return byLabel;
          if (hint === "breakfast") return sub[sub.length - 1]; // oldest = breakfast
          if (hint === "lunch" && sub.length >= 2) return sub[1]; // 2nd newest = lunch
        }
        return sub[0]; // default: most recent substantial meal
      };

      // For cross-meal, prefer today's meals as the source
      const todayMeals = poolMeals.filter(l => l.loggedAt && new Date(l.loggedAt) >= todayStart);

      // Cross-meal with no "yesterday" reference means TODAY's meal — never silently
      // substitute an older one. Copying a 3-day-old lunch as "today's lunch" makes the
      // coach contradict what the client just told it.
      let todayCrossMatch: (typeof allMeals)[number] | null = null;
      if (crossMealM && daysBack === 0 && sourceHint) {
        const todaySub = todayMeals.filter(l => (l.kcalInt || 0) >= 100);
        todayCrossMatch =
          todaySub.find(l => l.rawMessage && new RegExp(`\\b${sourceHint}\\b`, "i").test(l.rawMessage))
          || todaySub.find(l => (l.mealLabel || "").toLowerCase() === sourceHint)
          || (todaySub.length === 1 ? todaySub[0] : null);
        if (!todayCrossMatch) {
          const honestMiss = `I don't have today's ${sourceHint} logged, so I can't copy it. Tell me what it was — "rice, tin fish and veg" — and I'll log it as your ${targetLabel || "meal"} now.`;
          await logChat(user.id, message, honestMiss, "SAME_AS_TODAY_MISS");
          return honestMiss;
        }
      }

      const searchPool = (crossMealM && todayMeals.filter(l => (l.kcalInt || 0) >= 150).length > 0)
        ? todayMeals : poolMeals;

      const match = todayCrossMatch || findBestMeal(searchPool, sourceHint);

      if (!match) {
        const timeRef = daysBack >= 2 ? `in the last ${daysBack} days` : daysBack === 1 ? "yesterday" : "recently";
        const noMatch = `Nothing found ${timeRef} to repeat. Tell me what you ate and I'll log it now.`;
        await logChat(user.id, message, noMatch, "SAME_AS_YESTERDAY_MISS");
        return noMatch;
      }

      await db.insert(mealLogs).values({
        userId: user.id,
        rawMessage: match.rawMessage || "[Repeat meal]",
        source: "retro",
        kcalInt: match.kcalInt,
        proteinInt: match.proteinInt,
        carbsInt: match.carbsInt || 0,
        fatInt: match.fatInt || 0,
        mealLabel: targetLabel || null,
        items: match.items,
      });
      invalidateFoodTotalsCache(user.id);
      const recomputed = await recomputeTodayFoodTotals(user.id);
      await db.update(users).set({
        todayCalories: recomputed.calories,
        todayProteinG: recomputed.protein,
      }).where(eq(users.phoneNumber, phone));

      const labelDisplay = (targetLabel || match.mealLabel || "Meal").replace(/\b\w/g, c => c.toUpperCase());
      const mealWasToday = match.loggedAt && new Date(match.loggedAt) >= todayStart;
      const fromNote = crossMealM ? `copied from ${sourceHint}`
        : daysBack > 0 ? `from ${daysBack === 1 ? "yesterday" : `${daysBack} days ago`}`
        : mealWasToday ? "from earlier today" : "from yesterday";
      const remaining = (user.calorieTarget || 1800) - recomputed.calories;
      const protGap = (user.proteinTarget || 120) - recomputed.protein;
      const rawLabel = match.rawMessage ? `_${match.rawMessage.slice(0, 80)}_\n` : "";

      const sameReply = `✅ *${labelDisplay} logged* (${fromNote})\n${rawLabel}\n*+${match.kcalInt} kcal · +${match.proteinInt}g protein*\n${remaining > 0 ? `${remaining} kcal remaining.` : "Calorie target hit. ✅"} ${protGap > 0 ? `${protGap}g protein left.` : "Protein hit. ✅"}`;
      await logChat(user.id, message, sameReply, "SAME_AS_YESTERDAY");
      return sameReply;
    } catch (err) {
      console.error("[SAME_AS]", err);
      return `Could not find that meal. Tell me what you ate and I'll log it now.`;
    }
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
  // Strip "cider vinegar" / "apple cider vinegar" first — it's a condiment, not a drink
  const mNoVinegar = m.replace(/\bapple\s+cider\s+vinegar\b/gi, "").replace(/\bcider\s+vinegar\b/gi, "");
  const alcoholMatch = /\b(\d+)?\s*(beers?|wines?|glasses?\s*(?:of\s*)?wine|brandies?|brandy|whiskey|whisky|vodka|gin|rum|ciders?|savanna|hunters|castle|black label|heineken|windhoek|amstel|stellenbosch|nederburg|four cousins|robertson|4th street|smirnoff|jameson|jack daniel|gordons|captain morgan)\b/i.test(mNoVinegar);
  const hasAlcoholVerb = /\b(had|drank|drinking|having|drinks?|tonight|last night|yesterday|at the braai|at the party|weekend)\b/i.test(mNoVinegar);
  const isDirectAlcoholQty = /^(\d+\s*)?(beers?|wines?|glasses?\s*(of\s*)?(wine|beer|brandy|whisky|whiskey|vodka|gin|rum|cider)|shots?|doubles?)\b/i.test(m.trim());
  const isAlcoholLog = alcoholMatch && (hasAlcoholVerb || isDirectAlcoholQty);
  if (isAlcoholLog) {
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

    const isRetroAlcohol = isRetroactiveMeal(m);
    const alcoholLoggedAt = parseMealDate(m);
    const alcoholDateLabel = mealDateLabel(alcoholLoggedAt);

    // Always insert into mealLogs — alcohol calories must actually be tracked
    await db.insert(mealLogs).values({
      userId: user.id,
      rawMessage: message.slice(0, 1000),
      source: "alcohol_log",
      kcalInt: totalCal,
      proteinInt: 0,
      carbsInt: Math.round(totalCal * 0.85 / 4),
      fatInt: 0,
      items: [{ name: `${drinkName} ×${qty}`, kcal: totalCal, protein: 0 }],
      mealLabel: "alcohol",
      loggedAt: alcoholLoggedAt,
    }).catch(e => console.warn("[alcohol mealLog insert]", e));
    invalidateFoodTotalsCache(user.id);

    let alcoholReply: string;
    if (isRetroAlcohol) {
      // Past tense — advice about what to do TODAY, not "tomorrow"
      const todayAction = totalCal > 400
        ? `Today: high-protein meals, extra water, and get your steps in to compensate.`
        : `Back on track today — hit your protein target and get your steps in.`;
      alcoholReply = `${qty} ${drinkName}${qty > 1 ? "s" : ""} logged for ${alcoholDateLabel} — ~${totalCal} kcal (${pctOfDay}% of your daily target).\n\n${todayAction}`;
    } else {
      alcoholReply = `${qty} ${drinkName}${qty > 1 ? "s" : ""} = ~${totalCal} kcal. That's ${pctOfDay}% of your daily target.\n\n`;
      if (totalCal > 600) {
        alcoholReply += `That's a full meal's worth of calories with zero protein. Your body stops burning fat while it processes alcohol.\n\n*Damage control:* High protein meals the rest of today. 1 glass of water per drink. 30 min walk tomorrow.`;
      } else if (totalCal > 300) {
        alcoholReply += `Manageable. Cut one carb serving from your next meal to balance it out. Drink water between rounds.\n\n*Tomorrow:* Extra protein at breakfast. Get your walk in.`;
      } else {
        alcoholReply += `Manageable. Stay hydrated — 1 glass of water per drink. Don't let it become 3 more.`;
      }
    }

    await logChat(user.id, message, alcoholReply, "ALCOHOL_LOG");
    return alcoholReply;
  }

  // ---- DRINK SWAP — intercept BEFORE food swap so "energy drink switch" doesn't get food alternatives ----
  const isDrinkSwap = /\b(switch|swap|replace|instead of|alternative|substitute|other option)\b/i.test(m)
    && /\b(energy drink|red bull|monster|redbull|powerade|sports drink|energy|coffee|fizzy|cold drink|soda|cool drink|juice)\b/i.test(m);
  const isJustDrinkQuery = /\b(energy drink switch|drink alternatives|what (can|should) i drink|healthier drink|better drink option)\b/i.test(m);
  if (isDrinkSwap || isJustDrinkQuery) {
    const goal = user.goalType || "fat_loss";
    const isEnergyDrink = /\b(energy drink|red bull|monster|redbull|powerade|energy)\b/i.test(m);
    const isCoffee = /\bcoffee\b/i.test(m);
    const isJuice = /\bjuice\b/i.test(m);
    let drinkReply = "";
    if (isEnergyDrink) {
      drinkReply = `*Healthier swaps for energy drinks:*\n\n• *Black coffee* — 2 kcal | same caffeine kick, zero sugar\n• *Rooibos tea* — 0 kcal | good for digestion, South African staple\n• *Sparkling water* — 0 kcal | still gives the fizz\n• *Lite iced coffee (no sugar)* — ~30 kcal | caffeine without the 150+ kcal sugar bomb\n• *Electrolyte water* — 0–10 kcal | if you need the minerals post-workout\n\nEnergy drinks pack 150–180 kcal and 40g+ sugar per can — that's almost a full meal in liquid.${goal === "fat_loss" ? " That's a big chunk of your daily budget." : ""}`;
    } else if (isCoffee) {
      drinkReply = `*Swap your coffee for:*\n\n• *Rooibos tea* — 0 kcal | zero caffeine, great at night\n• *Green tea* — 2 kcal | light caffeine, antioxidants\n• *Herbal tea (chamomile, peppermint)* — 0 kcal | calming, good before sleep\n• *Black coffee* stays zero if you skip the sugar and milk\n\nIf it's the milk and sugar in coffee causing the calories — just try cutting those first.`;
    } else if (isJuice) {
      drinkReply = `*Swap juice for:*\n\n• *Water with lemon* — 5 kcal | feels fancy, basically free\n• *Sparkling water* — 0 kcal | same fizz, no sugar\n• *Rooibos (cold brew)* — 0 kcal | put it in the fridge overnight\n• *Eat the fruit instead* — same vitamins, but the fibre keeps you full longer\n\nOrange juice is ~120 kcal per glass with 23g sugar — the whole fruit is 62 kcal with fibre that keeps you full.`;
    } else {
      drinkReply = `*Healthier drink swaps:*\n\n• *Water* — 0 kcal\n• *Sparkling water* — 0 kcal\n• *Rooibos tea* — 0 kcal\n• *Black coffee* — 2 kcal\n• *Herbal teas* — 0 kcal\n\nMost cold drinks, juices, and flavoured drinks pack 100–200 kcal with nothing to show for it nutritionally. Switching to water or rooibos is one of the easiest cuts you can make.`;
    }
    await logChat(user.id, message, drinkReply, "DRINK_SWAP");
    return drinkReply;
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
      const todayStart = sastDayStart();
      const todaySuppLogs = await db.select({ id: chatHistory.id }).from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "SUPPLEMENT_LOG"), gte(chatHistory.createdAt, todayStart)));
      const suppStreakLine = todaySuppLogs.length >= 2 ? ` Day ${todaySuppLogs.length} in a row — that's the habit.` : "";
      return `Taken ✅${suppStreakLine}\n\nSame time every day beats the perfect supplement stack. Set a phone alarm and make it automatic.`;
    }

    // Specific supplement question — give a targeted answer, not the whole guide
    const isCreatine = /\bcreatine\b/i.test(m);
    const isWhey = /\b(whey|protein powder|protein shake)\b/i.test(m);
    const isOmega = /\b(omega|fish oil)\b/i.test(m);
    const isMagnesium = /\bmagnesium\b/i.test(m);
    const isVitD = /\b(vitamin d|vit d|vitamin d3)\b/i.test(m);
    const isCollagen = /\bcollagen\b/i.test(m);
    const isZinc = /\bzinc\b/i.test(m);
    const isSpecific = isCreatine || isWhey || isOmega || isMagnesium || isVitD || isCollagen || isZinc;

    if (isSpecific && m !== "supplements" && m !== "supps" && m !== "my supplements") {
      const goal = user.goalType || "fat_loss";
      let reply = "";
      if (isCreatine) {
        reply = `*Creatine — yes or no?*\n\nYes. It's the most evidence-backed supplement there is — improves strength, muscle volume, recovery, and even brain function.\n\n*How to take it:* 5g/day, any time, with water. No loading phase needed. Takes 2–4 weeks to feel the full effect.\n\n*What to buy:* Creatine monohydrate only. Nothing fancy. Dis-Chem or Takealot — ~R150/month.\n\n*Works for:* fat loss AND muscle gain. You keep more muscle while cutting. It's not just for bulking.`;
      } else if (isWhey) {
        const pTarget = user.proteinTarget || 120;
        reply = `*Whey protein — do you need it?*\n\nOnly if you can't hit *${pTarget}g protein/day* from food.\n\nIf you're eating chicken, eggs, tuna, pilchards regularly — you probably don't need it.\n\nIf you're consistently 40–50g short: 1 scoop of whey post-workout fills that gap (~25g protein, ~120 kcal).\n\n*What to buy:* Any unflavoured whey from Dis-Chem or Takealot. Avoid the fancy branded ones — same product, triple the price.`;
      } else if (isOmega) {
        reply = `*Omega 3 / Fish oil*\n\nWorth it for most people — reduces inflammation, supports joint health, improves fat metabolism.\n\n*Dose:* 1–2g EPA+DHA per day (check the label — not just "1000mg fish oil").\n\n*Budget pick:* Any generic fish oil capsules from Clicks or Dis-Chem — R60–R80/month. Works identically to premium brands.`;
      } else if (isMagnesium) {
        reply = `*Magnesium*\n\nMost people are deficient. Helps with sleep quality, muscle recovery, and reducing cravings — especially at night.\n\n*Best form:* Magnesium glycinate (absorbed better, easier on stomach). Avoid magnesium oxide — cheap but poorly absorbed.\n\n*When:* Take before bed. R80–R120/month at Dis-Chem.`;
      } else if (isVitD) {
        reply = `*Vitamin D3*\n\nMost South Africans are still deficient despite the sun — especially if you work indoors or wear sunscreen all day.\n\nLow vitamin D = lower testosterone, weaker immunity, worse mood, slower recovery.\n\n*Dose:* 2000–4000 IU/day with food. Safe long-term. R50–R80/month.`;
      } else if (isCollagen) {
        reply = `*Collagen*\n\nFor joints, skin, and connective tissue. Decent evidence for joint pain reduction — less so for muscle building.\n\nIf you have joint issues or are over 35: worth trying. If you're young and injury-free: protein from food does more.\n\n*If buying:* hydrolysed collagen peptides, 10–15g/day with vitamin C (improves absorption).`;
      } else if (isZinc) {
        reply = `*Zinc*\n\nSupports testosterone, immunity, and recovery. Most people get enough from red meat and eggs.\n\nIf you're plant-based or eating very low meat: worth supplementing. 15–25mg/day — don't overdo it, high doses reduce copper absorption.`;
      }
      await logChat(user.id, message, reply, "SUPPLEMENT_GUIDE");
      return reply;
    }

    // Generic "supplements" query — give the full goal-specific guide
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
      "food plan", "my food plan", "weekly meal plan"].includes(m)
    || /\b(give me a meal plan|my meal plan|send.*meal plan|meal plan please|eating plan|what should i eat|i need a meal plan|diet plan|weekly meals)\b/i.test(m);
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
    const listText = formatShoppingList(list, firstName, goal);
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

  // ---- LOAD SHEDDING ----
  const isLoadShedding = /\b(load.?shed|loadshed|eskom|no.?electricity|no.?power|stage\s*[1-8]|power.?cut|power.?out|blackout|no.?lights|lights.?out|inverter.?dead|battery.?dead|no.?signal.*load|generator.*off)\b/i.test(m);
  if (isLoadShedding) {
    const lsReply = `${capName}, load shedding is real — it messes with routines, meals, and everything else. No blame.\n\nHere's what you can still do with zero power:\n- Home workout: 3 rounds of 15 squats, 10 push-ups, 20 jumping jacks, 30-sec plank. No equipment, no electricity needed.\n- Eating: cold food counts. Bread + peanut butter, fruit, biltong, yoghurt if still cold — log it.\n- Steps: even 20 minutes walking outside counts. Send me the count when you're back.\n\nWhen power's back, pick up where you left off. One missed session never killed progress — giving up does.`;
    await logChat(user.id, message, lsReply, "LOAD_SHEDDING");
    return lsReply;
  }

  // ---- SICK / ILL — above-neck vs below-neck rule ----
  const isAboveNeckOnly = /\b(runny nose|blocked nose|stuffy nose|sneezing|sneezy|light cold|mild cold|bit of a cold|slight headache|congested|congestion)\b/i.test(m)
    && !/\b(fever|vomit|nausea|nauseous|throwing up|stomach|chest|flu|covid|body aches|can.?t breathe|diarr|diarrhoea)\b/i.test(m);
  const isSick = /\b(sick|ill|flu|flue|flu.?like|fever|vomit|nausea|nauseous|throwing up|stomach bug|food poison|covid|covid.?19|not well|not feeling well|feeling sick|feeling ill|feel sick|feel ill|i.?m sick|i.?m ill|under the weather|hospital|doctor.?s|clinic|bed rest|body aches|headache.*bad|migraine|tonsil|sore throat|chest.*tight|can.?t breathe|difficulty breathing)\b/i.test(m)
    && !/\b(used to be sick|was sick last week|recovered|feeling better now|back to normal|got better|all better|not sick|not ill|not unwell|i.?m not sick|no longer sick|not sick anymore|i.?m better|i.?m fine now|i.?m okay now|i.?m ok now|feel better|feeling better|better now|i.?m well|i.?m healthy|recovered from|over the|over it now)\b/i.test(m);
  if (isAboveNeckOnly) {
    const aboveNeckReply = `${capName}, above-the-neck rule: runny nose or congestion = light training is fine.\n\nYou can train — but drop the intensity. A 30-min walk, a light session at 60% effort. If you feel worse during warm-up, stop and rest. No heavy lifts, no max effort today.\n\n*Eat well:* protein + fluids. Vitamin C from fruit or juice. You'll be back to full speed in a day or two.`;
    await logChat(user.id, message, aboveNeckReply, "SICK_ABOVE_NECK");
    return aboveNeckReply;
  }
  if (isSick) {
    const goal = user.goalType || "fat_loss";
    const programmeRef = user.trainingMode
      ? `Your ${user.trainingMode.replace(/_/g, " ")} programme is saved`
      : "Your programme and targets are saved";
    const weekendSick = /\b(over the weekend|since (friday|saturday|sunday|the weekend)|few days|couple of days|days now|since last week)\b/i.test(m);
    const nutritionLine = goal === "muscle_gain"
      ? `*Eat even if you have no appetite:* protein matters most right now — muscle breaks down fast when sick. Eggs, protein shake, yoghurt, chicken soup. Even small amounts help.`
      : `*Eat small, real food:* pap, eggs, toast, yoghurt, soup — whatever you can keep down. No calorie pressure today.`;
    const sickReply = `${capName}, no training${weekendSick ? " — and rest of this week if needed" : " today"}. Your body is fighting right now and that takes everything.\n\n${nutritionLine}\n\n• Sleep as much as you can\n• Fluids — water, Energade, soup, juice\n• No steps target today\n\n${programmeRef} — you pick up exactly where you left off when you're properly better. Don't rush back. Message me when you're ready.`;
    await logChat(user.id, message, sickReply, "SICK_DAY");
    return sickReply;
  }

  // ---- RETURN PLANNING ("I'll be back Wednesday", "let's confirm I go back Monday") ----
  const isReturnPlanning = /\b(i.?ll (be back|start|resume|return|train|come back)|let.?s confirm|confirm (i|that i)|going back|back (on|from) (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week)|start(ing)? (again|back|monday|tuesday|wednesday|thursday|friday|tomorrow)|resume (on|from|monday|tuesday|wednesday|thursday|friday)|back to (training|gym|it) (on|from|monday|tuesday|wednesday|thursday|friday))\b/i.test(m)
    && !isSick
    && /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|next month)\b/i.test(m);
  if (isReturnPlanning) {
    const dayMatch = m.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week)\b/i);
    const returnDay = dayMatch ? dayMatch[0].charAt(0).toUpperCase() + dayMatch[0].slice(1).toLowerCase() : "then";
    const goal = user.goalType || "fat_loss";
    const protTip = goal === "muscle_gain"
      ? `Keep your protein up until then — your muscles are still recovering.`
      : `Eat clean until then — no point starting strong on an empty tank.`;
    const returnReply = `${returnDay} confirmed, ${capName}. Rest up until then.\n\n${protTip}\n\nYour programme and targets are exactly where you left them. When you're back, message me and I'll send today's session.`;
    await logChat(user.id, message, returnReply, "RETURN_PLAN");
    return returnReply;
  }

  // ---- OVER-TRAINING SIGNAL ----
  const isFatigueMessage = /\b(so tired|exhausted|body.*sore|everything.*sore|can.?t move|legs.*dead|dead.*legs|burnt out|overtrain|worn out|body.*aching|aching all over|too sore|too tired|destroyed|wrecked|ruined|my body.*killing|killing me.*gym|can.?t walk|can.?t lift|barely.*move)\b/i.test(m);
  if (isFatigueMessage && (user.workoutStreak || 0) >= 4) {
    const overtrainReply = `${capName}, that's your body telling you to stop — and you should listen.\n\n${user.workoutStreak} days straight is real work. But without rest, you're breaking muscle down, not building it. Progress lives in recovery.\n\n*Today: rest.* No gym, no run. Walk if you want, but nothing intense.\n\n*Eat:* hit your protein target — your muscles repair during rest, not during training.\n\n*Tomorrow:* come back. You will lift more, feel better, and actually make progress. Rest is not quitting — it's part of the programme.`;
    await logChat(user.id, message, overtrainReply, "OVERTRAIN");
    return overtrainReply;
  }

  // ---- ALCOHOL QUESTION (not a log — asking about it) ----
  const isAlcoholQuestion = /\b(can i (drink|have.*alcohol|have.*beer|have.*wine)|alcohol.*ok|ok.*alcohol|is (beer|wine|alcohol|drinking) ok|what about (alcohol|drinking|beer|wine)|alcohol.*diet|diet.*alcohol|drinking.*weekends?|weekends?.*drink|how bad.*alcohol|affect.*results|alcohol.*results|skip.*alcohol|cut.*alcohol|limit.*alcohol)\b/i.test(m)
    && !(/\b(had|drank|drinking|having|tonight|last night|yesterday|at the braai|at the party)\b/i.test(m));
  if (isAlcoholQuestion) {
    const goal = user.goalType || "fat_loss";
    const alcoholQReply = goal === "muscle_gain"
      ? `${capName}, alcohol and muscle gain don't mix well — here's the honest version:\n\nYour body burns alcohol before everything else. While it's processing the drinks, testosterone drops and cortisol (the breakdown hormone) rises. That means less muscle built from that session.\n\n*Practical rule:* 1–2 drinks max on social occasions. Not every weekend. The more you drink, the more you undo.\n\n*What actually kills gains:* missing protein meals the next day because you're hungover. Eat your protein even on bad nights.`
      : `${capName}, alcohol is the one thing that silently kills fat loss without people realising it.\n\nYour body treats alcohol as a toxin and stops burning fat completely until it's processed — that can take 6–24 hours depending on how much you drank. The food you eat while drinking is more likely to be stored as fat.\n\n*Practical rule:* limit to 1–2 drinks max, not every weekend. Stick to spirits + soda water (no sugary mixers). Beer and wine add up fast.\n\n*It's not banned* — but if your results are stalling and you're drinking every weekend, that's likely why.`;
    await logChat(user.id, message, alcoholQReply, "ALCOHOL_QUESTION");
    return alcoholQReply;
  }

  // ---- FOODS TO AVOID / LIMIT ----
  const isFoodsToAvoidQ = /\b(what.*avoid|what.*not.*eat|foods?.*cut|foods?.*limit|foods?.*avoid|avoid.*foods?|what.*skip|bad.*foods?|worst.*foods?|should.*avoid|cut.*out|what.*hurting|what.*killing|killing.*results|what.*blocking|what.*slowing|bad for.*loss|bad for.*gain|what (not|never) (to )?eat)\b/i.test(m);
  if (isFoodsToAvoidQ) {
    const goal = user.goalType || "fat_loss";
    let avoidReply = "";
    if (goal === "muscle_gain") {
      avoidReply = `${capName}, for muscle gain the biggest mistakes are:\n\n🚫 *What quietly kills your gains:*\n• Skipping meals — your muscles have nothing to build with\n• Not enough protein at each meal — aim for 30–40g per meal\n• Alcohol — drops testosterone, raises cortisol, slows recovery\n• Sugary drinks — empty calories with no protein\n• Too much junk — you can't out-supplement a bad diet\n\n✅ *Eat freely:* chicken, eggs, beef, tuna, pilchards, brown rice, sweet potato, oats, peanut butter\n\n_Nothing is permanently banned. You're just prioritising what builds muscle._`;
    } else {
      avoidReply = `${capName}, these are the things quietly killing fat loss for most South Africans:\n\n🚫 *The main culprits:*\n• *Sugary drinks* — Coke, juice, Oros, Energade. Liquid calories you don't feel full from\n• *White bread, pap, white rice* — spike blood sugar fast, you're hungry again in 2 hours\n• *Takeaways more than once a week* — KFC, Steers, Debonairs are mostly oil + refined carbs\n• *Alcohol* — stops fat burning for up to 24hrs. More than 2 drinks a weekend stalls progress\n• *Flavoured yoghurt + cereals* — marketed as "healthy", full of added sugar\n\n⚠️ *Limit, don't stress:*\nFull-cream dairy, peanut butter, dried fruit — fine in small amounts, just track it\n\n✅ *Eat as much as you want:*\nChicken, eggs, tuna, pilchards, vegetables, sweet potato, oats, brown rice\n\n_Nothing is permanently banned. You're spending your calorie budget wisely._`;
    }
    await logChat(user.id, message, avoidReply, "FOODS_TO_AVOID");
    return avoidReply;
  }

  // ---- BAD EATING DAY / BINGE RECOVERY ----
  const isBadEatingDay = /\b(ate (badly|everything|too much|junk|rubbish|badly today)|went off track|off track (today|completely)|had a (bad|terrible|awful) (day|eating)|cheat day gone (wrong|bad|too far)|couldn.?t stop eating|binge(d|ing)|ate everything in sight|blew (my|the) (diet|plan|calories)|messed up (today|my diet|my eating)|fell off|ruined (today|my diet|it)|ate like (crazy|mad|pig)|stress (ate|eating))\b/i.test(m);
  if (isBadEatingDay) {
    const badDayReply = `${capName}, one bad day doesn't undo weeks of work. It's one meal — not one month.\n\nHere's what actually matters now:\n\n*Tonight:* drink water, get to sleep at a decent time. Don't try to "make up" for it by skipping tomorrow's meals — that makes it worse.\n\n*Tomorrow:* back to normal. First meal — protein. Eggs, chicken, tuna. Don't punish yourself with restriction, just get back on track.\n\n*The truth:* fat loss happens over weeks and months. One rough day is noise in the data. What you do the next 3 days is what actually matters.`;
    await logChat(user.id, message, badDayReply, "BAD_EATING_DAY");
    return badDayReply;
  }

  // ---- LOGGING CONFESSION — "I haven't been logging" (general, not about skipping meals) ----
  // Catches people apologising for not logging. Research: respond with curiosity not consequence.
  const isLoggingConfession = /\b(haven.?t been logging|haven.?t logged|not been logging|been bad (at|with) logging|been slack(ing)? (on|with) (logging|tracking)|forgot to (log|track)|haven.?t been tracking|I know I haven.?t|I know, I haven.?t|missed (my )?log(s|ging)?|no logs (lately|recently|this week)|haven.?t logged (anything|meals?|food)|been slipping (on|with) (logging|tracking))\b/i.test(m);
  if (isLoggingConfession) {
    const confessionReply = `${capName}, no guilt here. Logging is information — not a test you pass or fail.\n\nTell me one thing: what are you eating right now, or what did you have at your last meal? Just that. We pick up from here.`;
    await logChat(user.id, message, confessionReply, "LOGGING_CONFESSION");
    return confessionReply;
  }

  // ---- NIBBLING / GRAZING — "I was just nibbling on things" ----
  // Client ate, but grazed rather than had proper meals. Don't shame — just get the data.
  // Research: any eating occasion logged is better than none.
  const isNibbling = (
    /\bnibb(le[ds]?|ling)\b/i.test(m)
    || (/\bgraz(e[ds]?|ing)\b/i.test(m) && !/\b(knee|elbow|skin|wound|road|floor)\b/i.test(m))
    || /\bpicking at (my )?food\b/i.test(m)
    || /\b(bits? and pieces|bits? here and there|eating here and there)\b/i.test(m)
    || /\b(no proper meal today|didn.?t have a proper meal|ate nothing proper)\b/i.test(m)
  );
  if (isNibbling) {
    const nibblingReply = `${capName}, nibbling still counts — tell me what you had and I'll log it properly.\n\nWhat were you picking at? Even rough amounts — "a few crackers, some peanut butter, bits of chicken". Anything you give me is data I can coach from.`;
    await logChat(user.id, message, nibblingReply, "NIBBLING_CONFESSION");
    return nibblingReply;
  }

  // ---- CHRONIC UNDER-EATING — "I only eat once a day", "I struggle to eat", "no appetite most days" ----
  // Distinct from the acute "forgot to eat today" below. This is the recurring SA pattern:
  // work-from-home, low movement, low appetite, one meal a day. Research: 2 eating occasions/day
  // is the threshold. Movement drives appetite. Never shame — make adding ONE thing feel easy.
  const isChronicUndereating = /\b(only eat once|eat once a day|once or twice a day|one meal a day|two meals a day|don.?t eat much|hardly eat|barely eat|struggle to eat|struggling to eat|hard to eat|can.?t eat much|small appetite|no appetite|not (really |very )?hungry (most|these|during|when)|never (really )?hungry|low appetite|lose my appetite|don.?t feel like eating)\b/i.test(m);
  if (isChronicUndereating) {
    const goal = user.goalType || "fat_loss";
    const undereatReply = goal === "muscle_gain"
      ? `${capName}, this is the thing holding your results back — and it's fixable.\n\nEating once or twice a day means your body never gets enough fuel to build. It breaks down muscle for energy instead. You can train perfectly and still go nowhere if the food isn't there.\n\n*The easy fix — don't force big meals:*\nAdd ONE protein snack between meals. No cooking:\n• Yoghurt + a banana\n• Peanut butter on 2 slices bread\n• A tin of pilchards or tuna\n• A shake with milk\n\nOne extra eating moment a day. Your appetite grows once your body learns food is coming regularly.`
      : `${capName}, I hear this a lot — and I'll be straight: eating once or twice a day is *slowing your fat loss, not speeding it up.*\n\nWhen you barely eat, your body thinks food is scarce — it slows your metabolism and holds onto fat harder. You also lose muscle, the exact thing that keeps you burning. "Skinny-fat" comes from under-eating, not over-eating.\n\nAnd if you're not moving much (working from home), your appetite stays low — that's normal. A short walk actually wakes it up.\n\n*The easy fix — don't force a big meal:*\nAdd ONE small protein thing a day. Yoghurt, a tin of pilchards, peanut butter on bread, boiled eggs. No cooking.\n\nTwo eating moments beats one. That's the only food target this week.`;
    await logChat(user.id, message, undereatReply, "CHRONIC_UNDEREATING");
    return undereatReply;
  }

  // ---- DEFER START / NOT MENTALLY READY — keep the habit forming, no pressure ----
  // Active client wants to push their start to next month. Don't let them go dark —
  // offer minimum viable engagement (walk + photo food) so the habit forms in the gap.
  const isDeferringStart = /\b(can.?t start (this month|now|yet|right now)|don.?t think i can start|not sure i can start|not (mentally )?ready (to start|yet|for this|to begin)|not mentally ready|mentally not ready|start (next month|later|properly (next|in)|in (january|february|march|april|may|june|july|august|september|october|november|december))|begin next month|postpone (my|the|this)|push (my|the) start|wait (until|till|for) next month)\b/i.test(m);
  if (isDeferringStart) {
    const deferReply = `${capName}, I appreciate you being upfront instead of going quiet — that tells me you're serious.\n\nMental readiness is real. If your head isn't in it, the body won't follow. I get it.\n\nBut here's what we're going to do — this time is not wasted:\n\n*Just two things. No program, no pressure:*\n🚶 Walk when you can — send me your steps\n📸 Photo what you eat — I won't judge, I just want to see where you're starting\n\nThat's it. No strict rules. By the time you feel ready, you'll already be in the habit and I'll already know your patterns — so we hit the ground running instead of starting from scratch.\n\nEvery walk you take now counts more than you think. 💪`;
    await logChat(user.id, message, deferReply, "DEFER_START");
    return deferReply;
  }

  // ---- RESULTS TIMELINE — "how long until I see results?" ----
  // The #1 dropout question. User's proven answer: 3 months visual. Set honest expectations.
  const isResultsTimelineQ = (
    /\b(how long (until|before|till|to see|will it|does it) (take\b|be\b)?)/i.test(m) && /\b(results?|changes?|difference|lose|build|visible|see|notice|transform)\b/i.test(m)
  ) || (
    /\bwhen will (i|you|we) (see|notice|lose|start)\b/i.test(m) && /\b(results?|changes?|difference|weight|muscle|visible)\b/i.test(m)
  ) || (
    /\bhow many (weeks?|months?) (until|to see|before)\b/i.test(m) && /\b(results?|changes?|difference|visible)\b/i.test(m)
  ) || /\b(when will i (see|notice|lose|feel)\s.{0,20}(results?|changes?|difference|weight)|how long (to|before) (see|notice) (results?|changes?|a difference)|how long (to|before) lose weight)\b/i.test(m);
  if (isResultsTimelineQ) {
    const goal = user.goalType || "fat_loss";
    let timelineReply: string;
    if (goal === "muscle_gain") {
      timelineReply = `${capName}, honest answer:\n\n*Week 1–2:* You'll feel stronger. Workouts will feel easier.\n*Week 4–6:* Scale starts moving. Clothes start fitting differently.\n*Month 3:* You'll see it — and so will other people.\n\nMuscle builds from the inside out — strength going up IS the result before you see it visually. Trust the lifts, not the mirror right now.\n\nSend me a photo today. In 3 months I'll show you the exact difference.`;
    } else if (goal === "recomposition") {
      timelineReply = `${capName}, recomp is the most powerful transformation — but the slowest to show on scale.\n\n*Week 2–4:* Energy improves. Clothes fit differently. Waist tightens.\n*Month 3:* You'll see it — definition where fat was, different shape.\n*Month 6:* Other people start asking what you're doing.\n\nDon't trust the scale for recomp — it barely moves while your body changes shape. Monthly photos are the only measure that matters.`;
    } else {
      timelineReply = `${capName}, honest answer:\n\n*Week 1–2:* Scale drops 1–2kg — mostly water and glycogen. Energy improves.\n*Week 3–4:* Real fat loss starts. Clothes start feeling different.\n*Month 3:* You'll see it clearly — and so will other people.\n\nMost people want results in 3 weeks. The physiology takes 12. But those months pass whether you're doing this or not.\n\nSend me a photo now — clothed, mirror selfie is fine. In 3 months I'll show you the exact difference.`;
    }
    await logChat(user.id, message, timelineReply, "RESULTS_TIMELINE");
    return timelineReply;
  }

  // ---- SHIFT WORKER — "I work 4 days dayshift 4 days nightshift 4 days off" ----
  // Mining, nursing, security, casino — rotating schedules. Build around the schedule.
  const isShiftWorker =
    /\b(shift.?work(er|ing)?|rotating (shift|roster|schedule)|4\s*days?\s*(on|off|day.?shift|night.?shift)|work(ing)?\s+(day.?shift|night.?shift|on shift)|night.?shift\s+work|day.?shift\s+work|shift\s+(schedule|pattern|rotation|system|rota)|i\s+work\s+(days?\s+and\s+nights?|nights?\s+and\s+days?)|irregular\s+(shift|hours?)|12[\s\-]?hour\s+shift|24[\s\-]?hour\s+shift|working\s+(dayshift|nightshift|day\s+shift|night\s+shift)|going\s+(on|into)\s+shift|before\s+(my|the)\s+shift|come\s+off\s+shift|rotating\s+roster|i\s+work\s+(night|day)\s+shift)\b/i.test(m);
  if (isShiftWorker) {
    const goal = user.goalType || "fat_loss";
    const shiftReply = `${capName}, KamLife is built to work around schedules like yours — miners, nurses, security, casino workers. You're not the first, and this is solvable.\n\n*On DAYSHIFT:* Train after your shift or first thing in the morning. Energy is normal.\n\n*On NIGHTSHIFT:* Train in the morning *before* you sleep — your body is still running after a night shift, use that window. Don't train right before going in.\n\n*On DAYS OFF:* These are your best training days. Full sessions.\n\n*Food on shift:* Pack your own. Canteen food is mostly refined carbs. Pre-pack chicken + rice, eggs + bread, biltong + fruit.\n\n*The one rule:* ${goal === "fat_loss" ? "Hit your protein target every 24 hours — timing matters less than consistency." : "Eat before and after every session. Muscle builds in the recovery window, not in the gym."}\n\nTell me your current rotation — dayshift, nightshift, or days off — and I'll tell you exactly what to do today.`;
    await logChat(user.id, message, shiftReply, "SHIFT_WORKER");
    return shiftReply;
  }

  // ---- INACTIVE GYM MEMBER — "only went 4 days in 3 months", "barely use my membership" ----
  // Sunk cost guilt. Don't reinforce it — offer the real choice honestly.
  const isInactiveGym =
    /\b(gym\s+(but|member|membership)\s+(i|but|only|haven.?t|barely|rarely|hardly)|only\s+(go|went|been)\s+(to\s+)?(the\s+)?gym\s+(once|twice|\d+\s+times?|\d+\s+days?|rarely|barely)|haven.?t\s+(been|gone)\s+(to\s+)?(the\s+)?gym\s+(in|for|since)\s+(weeks?|months?|ages?|a\s+long\s+time)|(rarely|hardly|barely|never)\s+(go|use|been\s+to)\s+(the\s+)?gym|gym\s+membership\s+(sitting|wasting|going\s+to\s+waste|i\s+don.?t\s+use)|paying\s+for\s+(a\s+)?gym\s+(but|and)\s+(don.?t|haven.?t|barely|rarely)|not\s+using\s+(the|my)\s+gym|wasted?\s+(on\s+)?gym\s+membership)\b/i.test(m);
  if (isInactiveGym) {
    const inactiveGymReply = `${capName}, the membership is sunk cost — it's paid whether you go or not. Let's not make training decisions based on guilt about it.\n\nHonest question: what's actually stopping you from going?\n\n*If it's distance or time:* home training gets the same results. You don't need a gym.\n*If it's motivation:* home training is easier to start — no commute, no threshold to cross.\n*If it's schedule:* 30 minutes at home, 3 days a week, is enough.\n\n*Three options:*\n1. Switch fully to home training — I'll rebuild your programme right now\n2. Keep the gym for 1 day a week + home training for the rest\n3. Set one gym day as non-negotiable and build from there\n\nWhich one makes sense for where you are right now?`;
    await logChat(user.id, message, inactiveGymReply, "INACTIVE_GYM");
    return inactiveGymReply;
  }

  // ---- SKIPPING MEALS / FORGOT TO EAT ----
  const isSkippingMeals = /\b(haven.?t eaten|forgot to eat|haven.?t had anything|skipped (breakfast|lunch|dinner|meals?|eating)|too busy to eat|no time to eat|nothing today|haven.?t had food|not eaten (yet|today|all day)|missed (breakfast|lunch|dinner|meals?)|didn.?t eat|didn.?t have (breakfast|lunch|dinner)|no food today)\b/i.test(m);
  if (isSkippingMeals) {
    const hourSAST = (new Date().getUTCHours() + 2) % 24;
    const skipReply = hourSAST >= 15
      ? `${capName}, it's late in the day and you haven't eaten — that's a problem. Your metabolism slows, cortisol rises, and you'll likely overeat tonight.\n\n*Eat something now:* 2 eggs + bread, peanut butter on toast, a tin of tuna — anything with protein. Don't wait for a "proper meal" that never comes.\n\nMissing meals doesn't speed up fat loss — it makes your body hold onto fat harder. Consistent eating wins every time.`
      : `${capName}, don't let busyness become a skipped meal habit — it backfires. Your body needs fuel to burn fat and build muscle.\n\n*Grab something now:* eggs, bread + peanut butter, a tin of fish, yoghurt. Takes 5 minutes.\n\n_Eating consistently is one of the most powerful things you can do for your results._`;
    await logChat(user.id, message, skipReply, "SKIPPING_MEALS");
    return skipReply;
  }

  // ---- FUNERAL / BEREAVEMENT ----
  const isBereaved = /\b(funeral|passed away|someone.*died|died.*someone|lost.*loved one|loved one.*lost|in mourning|family.*death|death.*family|my (mom|dad|mother|father|brother|sister|uncle|aunt|gogo|ouma|oupa|gran|grandma|grandfather|grandmother|friend).*died|died.*(mom|dad|mother|father|brother|sister|uncle|aunt|gran)|umngcwabo|ukufa|silahlekelwe)\b/i.test(m);
  if (isBereaved) {
    const bereavReply = `${capName}, I'm sorry for your loss. Take all the time you need — the programme will wait.\n\nFunerals mean long days, different food, no routine. That's okay. Eat what's there, stay hydrated, walk if you can. Don't stress about the plan right now.\n\nWhen you're ready to come back — even if it's weeks from now — just message me and I'll reset your programme from that day. There's no guilt here. Rest, mourn, be with your family.`;
    await logChat(user.id, message, bereavReply, "BEREAVEMENT");
    return bereavReply;
  }

  // ---- UPDATE STEP TARGET — "steps goal 11000", "steps target 12000", "set steps to 10000" ----
  const stepTargetMatch = m.match(/\bstep(?:s)?\s+(?:target|goal)\s+(?:to\s+)?(\d[\d,]*)\b/i)
    || m.match(/\b(?:set|change|update|bump|raise|lower|increase|decrease)\s+(?:my\s+)?step(?:s)?(?:\s+(?:target|goal))?\s+to\s+(\d[\d,]*)\b/i);
  if (stepTargetMatch) {
    const rawNum = stepTargetMatch[1].replace(/,/g, "");
    const newTarget = parseInt(rawNum, 10);
    if (newTarget >= 2000 && newTarget <= 30000) {
      await db.update(users).set({ stepsTarget: newTarget }).where(eq(users.phoneNumber, phone));
      const oldTarget = user.stepsTarget || 8500;
      const direction = newTarget > oldTarget ? "raised" : newTarget < oldTarget ? "lowered" : "kept";
      const stepUpdateReply = `Step target ${direction} to *${newTarget.toLocaleString()} steps/day*. ✅ Every screenshot you log will now track against this.`;
      await logChat(user.id, message, stepUpdateReply, "STEP_TARGET_UPDATE");
      return stepUpdateReply;
    } else if (newTarget > 0) {
      return `That step count doesn't look right (valid range: 2,000–30,000). What should your daily step goal be?`;
    }
  }

  // ---- STEP TRACKING APP RECOMMENDATION ----
  // "Which app?" "What app to track steps?" — comes up every onboarding conversation.
  // Give a clear, device-aware answer so the client can act immediately.
  const isStepAppQ = /\b(which\s+app|what\s+app|step\s+(?:app|counter|tracker)|app\s+(?:for\s+)?steps?|steps?\s+app|track\s+(?:my\s+)?steps|how\s+(?:do\s+i\s+)?(?:count|track)\s+(?:my\s+)?steps|best\s+app\s+for\s+steps|google\s+fit|samsung\s+health|pedometer)\b/i.test(m);
  if (isStepAppQ) {
    const stepAppReply = `For counting steps, here is what I recommend based on your phone:\n\n*Android (Samsung):* Samsung Health — already on your phone. Open it, tap *Activity*, then *Steps*. It tracks automatically in the background.\n\n*Android (other):* Google Fit — free on Google Play. Takes 2 minutes to set up. If you already have it, open it and look for the steps circle on the home screen.\n\n*iPhone:* Apple Health — already installed. It counts steps automatically. Open it, tap *Browse → Activity → Steps*.\n\n*No smartphone / basic phone:* A cheap pedometer from Pick n Pay or Checkers works — clip it to your waistband, reset it in the morning.\n\nOnce it is set up, just send me your step count at the end of each day — type *"walked 8,000 steps"* or similar and I log it for you.\n\n_Target: ${(user.stepsTarget || 8500).toLocaleString()} steps/day._`;
    await logChat(user.id, message, stepAppReply, "STEP_APP_GUIDE");
    return stepAppReply;
  }

  // ---- PHONE IN CAR / INFLATED STEPS — driving or machine vibration inflates step count ----
  // Accelerometer can't distinguish walking from road/machine vibration.
  // Common: truck drivers, miners, taxi drivers, machine operators.
  const isInflatedSteps =
    /\b(phone\s+(in|on|with\s+me\s+in)\s+(the\s+)?(car|truck|bakkie|vehicle)|driving\s+(around\s+)?with\s+(my\s+)?phone|car\s+(vibration|vibrates?)|machine\s+(vibration|vibrates?|shaking)|vibration\s+(is\s+too\s+much|count(s|ing)\s+as\s+steps?|giving\s+me\s+steps?)|steps?\s+(from|because\s+of|due\s+to)\s+(vibration|driving|car|truck)|inflated\s+steps?|steps?\s+not\s+(accurate|real|right|from\s+walking)|operating\s+(big|heavy|those|mining|the)\s+machine|step\s+count\s+(is\s+)?(from\s+)?(vibration|car|driving|machine))\b/i.test(m);
  if (isInflatedSteps) {
    const inflatedReply = `${capName}, car and machine vibration inflating step counts is a real issue — the phone accelerometer can't tell the difference between walking and road bumps.\n\n*Quick fix:* Phone in your *pocket* (not on the seat or console) filters out most vehicle vibration.\n\nOr just tell me your actual walking: "walked 2,000 steps at lunch" and I'll log only that.\n\n*For your situation:*\nYour real movement target will be smaller — and that's fine. What matters is intentional walking:\n• 10-min walk on a break: ~1,000 steps\n• Walking to/from your vehicle or canteen\n• 20-min walk at home in the evening\n\nShould I set your step target to reflect what you can actually walk — not what the car registers for you?`;
    await logChat(user.id, message, inflatedReply, "INFLATED_STEPS");
    return inflatedReply;
  }

  // ---- WALKING CALORIE BURN — "how many calories did I burn walking/steps?" ----
  // Previously the bot ignored this cross-reference question and just showed food totals.
  // Key coaching point: their calorie target already accounts for activity — don't eat back steps.
  const isWalkingCalQ =
    /\b(how\s+(many\s+)?calories?\s+(did\s+i\s+|have\s+i\s+)?burn(ed|t)?\s+(from\s+)?(walking|steps?|my\s+walk(ing)?|my\s+steps?|the\s+walk(ing)?))\b/i.test(m)
    || /\b(how\s+much\s+(did\s+i\s+|have\s+i\s+)?burn(ed|t)?\s+(from\s+)?(walking|steps?))\b/i.test(m)
    || /\b(walk(ing)?\s+calories?|step\s+calories?|calories?\s+(from|burned\s+from)\s+(walking|steps?))\b/i.test(m)
    || /\b(how\s+(does|do)\s+(the\s+)?(walking|steps?)\s+(affect|impact|count|factor\s+into|fit\s+into)\s+(my\s+)?(total\s+calories?|calorie\s+total|calories?\s+(for\s+)?today|daily\s+(intake|calories?|budget)|calorie\s+(target|budget)))\b/i.test(m)
    || /\b(burned|burnt)\s+(walking|from\s+(walking|steps?))\b/i.test(m);

  if (isWalkingCalQ) {
    const todayStart = sastDayStart();
    let todaySteps = 0;
    try {
      const stepRow = await db.select({ steps: stepLogs.steps })
        .from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, todayStart)))
        .orderBy(desc(stepLogs.loggedAt))
        .limit(1);
      todaySteps = stepRow[0]?.steps || 0;
    } catch { /* non-fatal */ }

    const bodyWeightKg = user.currentWeight ? parseFloat(String(user.currentWeight)) : 75;
    const weightFactor = Number.isFinite(bodyWeightKg) && bodyWeightKg >= 30 && bodyWeightKg <= 250
      ? bodyWeightKg / 75 : 1;
    const estimatedKcal = Math.round(todaySteps * weightFactor * 0.04);
    const stepsTarget = user.stepsTarget || 8500;
    const calTarget = user.calorieTarget || 1800;
    const nm = firstName ? `${firstName}, ` : "";

    let walkCalReply: string;
    if (todaySteps === 0) {
      const perK = Math.round(weightFactor * 40);
      const targetBurn = Math.round(stepsTarget * weightFactor * 0.04);
      walkCalReply = `${nm}no steps logged yet today — send me your step count ("walked 6,000 steps") and I'll work it out exactly.\n\nFor you specifically, every 1,000 steps ≈ *~${perK} kcal*.\nHitting your ${stepsTarget.toLocaleString()} steps target burns roughly *~${targetBurn} kcal*.\n\n*One thing to know:* your *${calTarget} kcal daily target already includes your activity level.* Walk your steps, hit your calorie target — you're on track. You don't need to eat extra because you walked.`;
    } else {
      walkCalReply = `${nm}*Today's step burn:*\n${todaySteps.toLocaleString()} steps ≈ *~${estimatedKcal} kcal*\n\n*Important — how this fits your plan:*\nYour *${calTarget} kcal target already accounts for your activity level.* You don't "eat back" those walking calories on top of your target — the target was set to include them.\n\n*The rule:*\n✅ Hit your calorie target → you're eating the right amount\n✅ Hit your step target (${stepsTarget.toLocaleString()}) → your metabolism stays active, fat loss is faster\n❌ Adding step calories on top of your food target = eating at maintenance, not a deficit\n\nWalking accelerates fat loss. It doesn't mean you can eat more.`;
    }

    await logChat(user.id, message, walkCalReply, "WALKING_CALORIE_BURN");
    return walkCalReply;
  }

  // ---- BELLY FAT / MKHABA — "I want to lose my belly", "mkhaba", "stomach fat" ----
  // The #1 specific fat loss target. SA word "mkhaba" = belly/stomach fat (Zulu/Sotho).
  // Acknowledge specifically — people feel heard when you know their word.
  const isBellyFatQ =
    /\b(mkhaba|belly\s*(fat|flab)?|belly\s+is|my\s+belly|lose\s+(my\s+)?belly|flat\s+(stomach|tummy|belly)|stomach\s+fat|tummy\s+(fat|flab)|love\s+handles?|spare\s+tyre|spare\s+tire|fat\s+(belly|stomach|tummy)|pot\s+belly|get\s+rid\s+of\s+(my\s+)?(belly|stomach|mkhaba)|stomach\s+is\s+(big|huge|fat)|big\s+(belly|stomach|tummy))\b/i.test(m);
  if (isBellyFatQ) {
    const goal = user.goalType || "fat_loss";
    const bellyReply = `${capName}, the mkhaba — the most common target, and the most frustrating one. Here's the honest version:\n\n*You cannot spot-reduce belly fat.* No amount of sit-ups or crunches removes fat from a specific area — that's not how the body burns fat. Fat leaves from everywhere when you're in a calorie deficit, and the belly is usually the *last* area to go because that's where your body stores it last.\n\n*What actually shrinks it:*\n✅ Calorie deficit — eating less than you burn\n✅ High protein — preserves muscle while fat is lost\n✅ Steps — walking is the single most effective belly fat activity\n✅ Sleep — poor sleep raises cortisol, which stores fat specifically in the belly\n\n*What doesn't:*\n❌ Sit-ups (build abs under the fat, don't remove the fat)\n❌ Green tea, detoxes, waist trainers\n\n${goal === "fat_loss" || goal === "recomposition" ? "The good news: you're already on the right programme for this. Hit your calorie target, walk your steps, and the mkhaba goes — it just takes the full 3 months to become visible." : "For your muscle gain goal, eating a small surplus means the mkhaba won't grow — and once you build muscle, your metabolism burns more fat at rest. Recomp mode handles this well."}\n\nKeep logging. The belly is the last place it shows up and the last place it leaves — but it does leave.`;
    await logChat(user.id, message, bellyReply, "BELLY_FAT");
    return bellyReply;
  }

  // ---- CRIME / SAFETY WALKING OBJECTION ----
  // "Can't walk outside — crime", "not safe to walk in my area", "too dangerous outside"
  // This is a real SA barrier. Acknowledge it, give indoor alternatives immediately.
  const isCrimeWalkingObjection = /\b(can.?t\s+walk\s+(?:outside|outside here|outside in my area|in my area|near me|around here|on the street)|not\s+safe\s+to\s+walk|unsafe\s+to\s+walk|scared\s+to\s+walk|afraid\s+to\s+walk|dangerous\s+(?:to walk|outside|around here|in my area|near me)|crime\s+(?:in my area|is bad|is high|outside|near me|around here)|too\s+much\s+crime|high\s+crime|crime\s+rate|it.?s\s+not\s+safe\s+(?:outside|to walk|here)|can.?t\s+go\s+outside|don.?t\s+feel\s+safe\s+(?:walking|outside)|neighbourhood\s+(?:is\s+)?(?:dangerous|unsafe|not safe))\b/i.test(m);
  if (isCrimeWalkingObjection) {
    const goal = user.goalType || "fat_loss";
    const target = user.stepsTarget || 8500;
    const crimeReply = `${capName}, that is a real issue — no argument. Walking in an unsafe area is not worth the risk.\n\nHere is what works instead:\n\n*Indoors:*\n• Walk on the spot while watching TV or on the phone — 30 min = ~2,500 steps\n• March up and down your passage — it counts\n• Stair climbs if you have stairs — 10 min = ~1,200 steps\n• Jump rope — 20 min = ${goal === "fat_loss" ? "~200 kcal burned" : "great conditioning"}\n\n*Safer outdoor options:*\n• Mall walking early morning before it fills up — free, well-lit, secure\n• Church grounds or school yard if access is possible\n• Taxi to a safer area for a morning walk if viable\n\nThe number is what matters — *${target.toLocaleString()} steps* — not where you walk. Indoor steps count exactly the same.\n\nSend me your step count at the end of the day, wherever you got them.`;
    await logChat(user.id, message, crimeReply, "CRIME_WALKING");
    return crimeReply;
  }

  // ---- MONTH-END / FINANCIAL STRESS ----
  const isMonthEnd = /\b(month.?end|end of month|no.?money|broke|short on cash|can.?t afford|salary.?not|waiting for.?(salary|pay|payday)|payday.*friday|payday.*next|no.?budget|empty|flat.?broke|nothing (left|to eat)|no.?food|can.?t buy|no.?groceries|no.?airtime|airtime.?finished)\b/i.test(m);
  if (isMonthEnd) {
    const meReply = `${capName}, month-end is tough for everyone in SA. No shame in it.\n\nHere's how to keep it going on zero budget:\n- *Protein:* eggs (cheapest protein there is), pilchards, beans, lentils\n- *Carbs:* pap, brown bread, oats, rice, sweet potato\n- *Vegetables:* cabbage, spinach, frozen veg — all cheap and good\n\nType *cheap meals* and I'll send you a full day of eating under R30. Fitness doesn't stop when the money runs out — your body still needs fuel to change.`;
    await logChat(user.id, message, meReply, "MONTH_END");
    return meReply;
  }

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
    /\b(i.?m back|i am back|back now|returning|i.?ve been|been (busy|away|sick|off|struggling|stressed)|sorry (i|for|about)|haven.?t been|couldn.?t|wasn.?t able|let me start|can we start|starting again|picking up|back on track|back to it|resuming|fresh start|starting fresh|been (a|so) (long|while)|miss(ed)? (a|this|it)|been MIA|went quiet|disappeared|fell off)\b/i.test(m);

  if (isComeback) {
    const daysText = daysSilent === 2 ? "2 days" : daysSilent <= 7 ? `${daysSilent} days` : daysSilent <= 14 ? "a week" : "a while";
    const comingBackReply = `${capName}, welcome back. ${daysText} away — everyone has those stretches.\n\nWe don't restart from zero. Your programme, targets, and logs are all still here. Today is just Day 1 of the next streak.\n\n*Here's what to do right now:*\n1. Tell me what you ate today (even if it wasn't perfect)\n2. Log your steps if you walked\n3. Reply *menu* for today's workout\n\nNo catching up. No guilt. Just today. Let's go.`;
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
  const isConfused = CONFUSED_EXACT.has(m)
    || /^(\?{2,}|!{2,}|\?!+)$/.test(m)
    || /\b(i.?m (lost|confused|not sure)|don.?t (understand|get it)|what do i do( now)?|not sure what to (do|say|send)|how does this work)\b/i.test(m);
  if (isConfused) {
    const menuReply = await getMenuText(user, { showCommands: true });
    await logChat(user.id, message, menuReply.replace(/\[BUTTONS:[^\]]+\]/g, "").trim(), "CONFUSED_RECOVERY");
    return menuReply;
  }

  return null;
}

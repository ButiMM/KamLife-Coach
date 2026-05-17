import { db } from "../db";
import { users, workoutLogs, chatHistory } from "../../shared/schema";
import { eq, and, gte, desc, count } from "drizzle-orm";
import { SA_FOODS_SEED } from "../foods";
import { buildDayWorkout, buildFullProgramme } from "../programme";
import { calculateTargets } from "../targets";
import { askCoachK } from "../gpt";
import { getShoppingList, formatShoppingList } from "../shopping-lists";
import { sendWhatsApp } from "../scheduler";
import { scanForSAFoods, recomputeTodayFoodTotals } from "./food-scanner";
import { logChat, withTimeout } from "./chat-log";
import { getMenuText, getOnboardingMealPlan } from "../onboarding";
import { getPrimaryWorkoutGifUrl } from "../exercise-media";
import { getProgressiveOverloadContext } from "./checks";
import { sastDayStart } from "../utils";
import { getTodayWorkoutState, getTodaySlot } from "../workout-state";

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
    return `Protein target: *${prot}g per day.*\n\nBest sources at SA prices: eggs (6g each), pilchards (22g per tin), frozen chicken breast (28g per 100g), tinned tuna (25g per tin).`;
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
    await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone)).catch(() => {});
    const backMsg = `${firstName ? firstName + ", b" : "B"}ack to your regular programme. Reply *menu* or *workout* for today's session.`;
    await logChat(user.id, message, backMsg, "BACK_TO_GYM");
    return backMsg;
  }

  // ---- HOLIDAY / TRAVEL EQUIPMENT QUESTION ----
  // Must be checked BEFORE the workout delivery so it intercepts correctly.
  const isHolidayMention = /\b(on holiday|on vacation|travelling|traveling|i.?m away|hotel gym|hotel|away this week|going away|on a trip|at home today|only have dumbbells|no gym today|training at home today|can.?t get to the gym)\b/i.test(m);

  // If awaiting equipment answer — check in-memory map AND db field (survives restart)
  const isAwaitingEquipment = awaitingEquipmentAnswer.get(phone) || user.awaitingInputType === "equipment";
  if (isAwaitingEquipment) {
    awaitingEquipmentAnswer.delete(phone);
    await db.update(users).set({ awaitingInputType: null }).where(eq(users.phoneNumber, phone)).catch(() => {});
    let tempMode = user.trainingMode || "gym";
    if (/\b(full gym|gym|machines|cables|full equipment|1)\b/i.test(m)) tempMode = "gym";
    else if (/\b(dumbbell|dumbbells|db|2)\b/i.test(m)) tempMode = "gym_dumbbell";
    else if (/\b(nothing|no equipment|bodyweight|hotel room|3)\b/i.test(m)) tempMode = "home";
    tempEquipmentMode.set(phone, tempMode);
    const tempUser = { ...user, trainingMode: tempMode };
    const workout = buildDayWorkout(tempUser);
    const gifUrl = getPrimaryWorkoutGifUrl(workout);
    const gifMarker = gifUrl ? `\n[MEDIA:${gifUrl}]` : "";
    const tReply = `Here is your session adapted for what you have available.\n\n${workout}\n\nSend *done* when finished.${gifMarker}`;
    await logChat(user.id, message, tReply, "WORKOUT_HOLIDAY");
    return tReply;
  }

  // If holiday mentioned (with or without workout request), ask what equipment they have
  const isWorkoutRequestInMessage = /\b(workout|training|session|programme|program|exercise|gym|train|send me|my workout|today)\b/i.test(m);
  if (isHolidayMention) {
    awaitingEquipmentAnswer.set(phone, true);
    await db.update(users).set({ awaitingInputType: "equipment" }).where(eq(users.phoneNumber, phone)).catch(() => {});
    const equipQ = `${firstName ? firstName + ", w" : "W"}hat do you have access to where you are? Reply:\n\n*1 — gym* — full machines and cables\n*2 — dumbbells* — dumbbells only\n*3 — nothing* — no equipment, bodyweight only`;
    await logChat(user.id, message, equipQ, "EQUIPMENT_QUESTION");
    return equipQ;
  }

  if (m === "log food" || m === "3") {
    return `What did you eat? Just tell me — I'll get you the kcal and protein instantly.\n\n_Examples:_\n• "2 eggs and pap for breakfast"\n• "Chicken thigh, rice and spinach for lunch"\n• "Pap and mince for dinner"\n\nInclude the food, rough amount, and which meal.`;
  }

  if (m === "my programme" || m === "programme" || m === "my workout" || m === "today's workout" || m === "1" || m === "workout") {
    const effectiveUser = tempEquipmentMode.has(phone)
      ? { ...user, trainingMode: tempEquipmentMode.get(phone) }
      : user;
    tempEquipmentMode.delete(phone);

    const state = await getTodayWorkoutState(user);

    // REST DAY
    if (state.type === "REST") {
      const preview = buildDayWorkout(effectiveUser);
      const restReply = `*${state.todayName} — Rest Day.*\n\nRecovery is when your muscles actually grow. No session needed today.\n\nNext training day: *${state.nextTrainingName}*\n\n_Preview of what's coming:_\n\n${preview}\n\n_Want to train anyway? Go for it — send *done* when finished._`;
      await logChat(user.id, message, restReply, "REST_DAY_INFO");
      return restReply;
    }

    // ALREADY DONE TODAY
    if (state.type === "ALREADY_DONE") {
      const poCtx = await getProgressiveOverloadContext(user.id);
      const doneReply = `${firstName ? firstName + ", y" : "Y"}ou already logged today's session ✅${poCtx ? "\n\n" + poCtx.trim() : ""}\n\nWhat's next?[BUTTONS:Log my lifts|Tomorrow's session|Log food]`;
      await logChat(user.id, message, doneReply.replace(/\[BUTTONS:[^\]]+\]/g, "").trim(), "WORKOUT_ALREADY_DONE");
      return doneReply;
    }

    // MISSED SESSION(S)
    if (state.type === "MISSED") {
      const missed = state.missedSessions.join(" and ");
      // Deliver today's actual calendar slot — not the missed slot
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
      const missedReply = `${firstName ? firstName + ", y" : "Y"}ou missed ${missed}.\n\n*${state.todayName} is still a training day — do it now and you're back on track.*\n\n*Week ${week} — Session ${sessionNum + 1}*\n\n${poContext}${workout}${injuryNote}\n\nSend *done* when finished. Log lifts: "bench 80kg 3x10"${gifMarker}[BUTTONS:Done 💪|Too hard — modify|Skip today]`;
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
  const directSwitchMatch = m.match(/\b(?:switch|change|move|update)\s+(?:me\s+)?to\s+([2-6])\s*days?\b/i)
    || m.match(/\bwant\s+to\s+(?:do|train)\s+([2-6])\s*days?\s*(?:a\s*week|per\s*week)?\b/i);
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
    /\btrain\s+[2-6]\s*days?\s*(?:a\s*week|per\s*week)\b/i.test(m)
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
    const modeLabel = trainingMode === "gym" ? "Gym" : "Home";
    const reply = `Sharp. ${trainingDays} days/week. ${modeLabel}. ${experience.charAt(0).toUpperCase() + experience.slice(1)}. Here is your programme.\n\n${programme}\n\n_Reply *menu* anytime to see all your options — workouts, food log, targets, shopping list, and more._`;
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
  if (m === "4" || ["shopping list", "shoppinglist", "shopping", "shop", "grocery list", "groceries", "my groceries", "weekly shop", "weekly shopping", "what to buy", "what should i buy", "what must i buy"].includes(m)) {
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
    && m.split(/\s+/).length >= 5;
  if (isClientList) {
    const goal = user.goalType || "fat_loss";
    const pTarget = user.proteinTarget || 120;
    const cTarget = user.calorieTarget || 1800;
    const budget = user.weeklyFoodBudget || "100_300";
    const budgetLabel: Record<string, string> = { under_100: "under R100/week", "100_300": "R100–R300/week", "300_600": "R300–R600/week", over_600: "over R600/week" };
    const adjustReply = await withTimeout("gpt_adjust", 20000, () => askCoachK(message, user,
      `The client just shared their personal grocery/shopping list. Your job: give a sharp, SA-specific Coach K review. Budget: ${budgetLabel[budget] || "moderate"}. Goal: ${goal.replace("_", " ")}. Their targets: ${cTarget} kcal/day, ${pTarget}g protein/day.

Structure your response exactly like this (no intro, no fluff):

✅ *What's good:* (1-2 items they're already buying right — be specific)

❌ *What's missing:* (1-2 specific gaps for their ${goal.replace("_", " ")} goal — especially protein if under 3 sources)

🔄 *Swap:* (1-2 direct swaps — same price, better for goal. Format: "X → Y (reason)")

📋 *Add:* (1-2 cheap items that fill the biggest gap — include SA price estimate)

Keep entire response under 120 words. Use SA product names. No lectures.`
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
      under_100: `Every item was chosen for maximum nutrition per rand — eggs and pilchards are the highest protein-per-rand foods in South Africa. Pap and spinach stretch the budget across multiple meals.`,
      "100_300": `Frozen chicken and eggs are your protein anchors at this budget. Oats and sweet potato give you slow-burning carbs that cost very little. The whole week's food costs under R250 and covers all your nutritional needs.`,
      "300_600": `This budget lets you rotate proteins — chicken, mince, eggs, pilchards — so you never get bored and never get gaps in your nutrition. Mince is the best value red meat in SA.`,
      over_600: `Salmon twice a week gives you omega-3 fatty acids that reduce inflammation — critical for recovery and long-term health. Greek yoghurt is one of the highest protein dairy foods per gram.`,
    };
    const budgetWhy = budgetReasons[budget] || budgetReasons["100_300"];

    return `*Why these specific foods for you:*\n\n${why}\n\n${budgetWhy}${extras.length > 0 ? "\n\n" + extras.join("\n\n") : ""}`;
  }

  // ---- DIET PLAN / MEAL PLAN — redirect to goal-adjusted shopping list ----
  // Clients ask for "diet plans" constantly. Diet plans don't work — people
  // can't follow them for more than a week. A shopping list changes behaviour.
  const isDietPlanRequest = ["diet plan", "meal plan", "mealplan", "food plan", "my meal plan", "my food plan", "diet", "my diet", "nutrition plan", "eating plan", "weekly meals", "weekly meal plan", "my nutrition plan", "my eating plan"].includes(m)
    || /\b(give me a diet plan|i need a diet plan|send.*diet plan|diet plan please|eating plan|nutrition plan|weekly meal plan|food plan|what should i eat this week|i need a meal plan)\b/i.test(m);
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
    const reply = `${intro}${listText}\n\n_Send me your own grocery list and I'll adjust it for your ${goal === "muscle_gain" ? "muscle building" : "fat loss"} goal. Or reply *7 day meals* if you want a full day-by-day breakdown._`;
    await logChat(user.id, message, reply, "DIET_PLAN_REDIRECT");
    return reply;
  }

  // ---- 7 DAY MEALS — explicit request for day-by-day plan ----
  if (["7 day meals", "7day meals", "full meal plan", "weekly meals breakdown", "what should i eat", "what do i eat"].includes(m)) {
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
    const sickReply = `${capName}, *no training today.* Full stop.\n\nFever, nausea, chest or stomach — below the neck means your body is in emergency mode. Pushing through makes it worse and longer. Rest IS the training right now.\n\n*What to do:*\n• Sleep as much as you can\n• Fluids — water, Energade, soup, juice\n• Eat small: pap, eggs, toast, yoghurt — whatever you can stomach\n• No steps target, no calorie pressure today\n\nMessage me when you're properly better. Programme and targets are saved — you pick up exactly where you left off.`;
    await logChat(user.id, message, sickReply, "SICK_DAY");
    return sickReply;
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

  // ---- CONFUSION / LOST USER — catch truly unclear messages before GPT ----
  // Only fires for genuinely ambiguous single-word or short confusion signals.
  // Specific questions ("how many calories", "what should i eat") are handled earlier.
  const CONFUSED_EXACT = new Set(["what", "what?", "huh", "huh?", "???", "??", "!?", "?", "what now", "lost", "confused", "help me", "i'm lost", "im lost"]);
  const isConfused = CONFUSED_EXACT.has(m)
    || /^(\?{2,}|!{2,}|\?!+)$/.test(m)
    || /\b(i.?m (lost|confused|not sure)|don.?t (understand|get it)|what do i do( now)?|not sure what to (do|say|send)|how does this work)\b/i.test(m);
  if (isConfused) {
    const menuReply = await getMenuText(user);
    await logChat(user.id, message, menuReply.replace(/\[BUTTONS:[^\]]+\]/g, "").trim(), "CONFUSED_RECOVERY");
    return menuReply;
  }

  return null;
}

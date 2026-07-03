import {
  db, users, chatHistory, stepLogs, workoutLogs, weightLogs, mealLogs,
  eq, gte, and, lt, asc, isNotNull,
  sendWhatsApp, canSendProactive, recordProactiveSend, claimProactive, claimDailySlot,
  getActiveClients, isPaused, loadState, saveState,
  todaySAST, thisWeekUTC,
} from "../shared";
import { getShoppingList, formatShoppingList } from "../../shopping-lists";
import { runWeeklyRecaps } from "../../weekly-recap";
import { generateMealPlan } from "../../meal-plan";

export async function runFridayWeekendStrategy(): Promise<void> {
  console.log("[SCHEDULER] JOB: Friday weekend strategy");
  const clients = await getActiveClients();
  const MESSAGE_KEY = "friday_weekend";
  const dedupeWindow = thisWeekUTC();
  let sent = 0, skippedPaused = 0, skippedSilent = 0, skippedDup = 0, skippedBudget = 0;

  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  for (const client of clients) {
    if (isPaused(client)) { skippedPaused++; continue; }
    const daysSilent = client.lastActiveAt
      ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
      : Math.floor((Date.now() - new Date(client.createdAt || Date.now()).getTime()) / 86_400_000);
    if (daysSilent > 10) { skippedSilent++; continue; }
    if (!canSendProactive(client.id)) { skippedBudget++; continue; }
    const claimed = await claimProactive(client.id, MESSAGE_KEY, dedupeWindow);
    if (!claimed) { skippedDup++; continue; }
    try {
      const name = client.name || "there";
      const week = client.programmeWeek || 1;

      const [weekWorkouts, weekWeights, weekSteps, weekFoodDays] = await Promise.all([
        db.select({ id: workoutLogs.id }).from(workoutLogs).where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, weekAgo))),
        db.select({ weight: weightLogs.weight }).from(weightLogs).where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, weekAgo))).orderBy(asc(weightLogs.loggedAt)),
        db.select({ steps: stepLogs.steps }).from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, weekAgo))),
        db.select({ id: mealLogs.id, loggedAt: mealLogs.loggedAt }).from(mealLogs).where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, weekAgo))),
      ]);

      const sessions = weekWorkouts.length;
      const foodDays = new Set(weekFoodDays.map(f => new Date(f.loggedAt!).toDateString())).size;
      const avgSteps = weekSteps.length > 0 ? Math.round(weekSteps.reduce((s, l) => s + (l.steps || 0), 0) / weekSteps.length) : 0;
      const weightChange = weekWeights.length >= 2
        ? parseFloat(String(weekWeights[weekWeights.length - 1].weight)) - parseFloat(String(weekWeights[0].weight))
        : null;

      const weightLine = weightChange === null ? ""
        : weightChange < -0.2 ? `⬇️ Down ${Math.abs(weightChange).toFixed(1)}kg`
        : weightChange > 0.2 ? `⬆️ Up ${weightChange.toFixed(1)}kg`
        : `➡️ Weight holding`;

      const lines = [
        `*${name} — Week ${week} wrap-up:*`,
        ``,
        `💪 ${sessions} workout${sessions !== 1 ? "s" : ""} done`,
        `📋 ${foodDays} day${foodDays !== 1 ? "s" : ""} food logged`,
        avgSteps > 0 ? `👟 ${avgSteps.toLocaleString()} avg steps` : "",
        weightLine,
        ``,
        sessions >= (client.trainingDaysPerWeek || 3) && foodDays >= 5
          ? `Sharp week, ${name}. Two rules this weekend — protein at every meal and one session before Sunday night. That is it.`
          : sessions === 0 && new Date(client.createdAt || 0).getTime() > Date.now() - 7 * 86_400_000
          ? `${name}, first week is about building the habit. Get one session in before Sunday and you'll be on track from day one.`
          : sessions === 0
          ? `Zero sessions this week — still time to change that. One session before Sunday is all it takes. Reply *1* right now.`
          : `Weekend is where most people lose the week. Two rules only — protein at every meal and one session before Sunday night.`,
      ].filter(Boolean);

      await sendWhatsApp(client.phoneNumber, lines.join("\n"));
      sent++;
    } catch (err) { console.error(`[SCHEDULER] Friday strategy error — ${client.phoneNumber}:`, err); }
  }
  console.log(`[SCHEDULER] Friday weekend — sent:${sent} paused:${skippedPaused} silent:${skippedSilent} dup:${skippedDup} budget:${skippedBudget}`);
}

export async function runSundayWeeklyReport(): Promise<void> {
  console.log("[SCHEDULER] JOB: Sunday weekly report");
  const clients = await getActiveClients();
  const weekAgo = new Date(Date.now() - 7 * 86400000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      // One claim per client per week — covers the report, the shopping-list card, AND
      // the programme-week advance below, so a container recycle can't double any of them.
      if (!(await claimProactive(client.id, "sunday_report", thisWeekUTC(), { critical: true }))) continue;
      const name = client.name || "there";
      const [chats, workoutEntries, weightEntries, stepEntries] = await Promise.all([
        db.select().from(chatHistory).where(and(eq(chatHistory.userId, client.id), isNotNull(chatHistory.messageIn), gte(chatHistory.createdAt, weekAgo))),
        db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, weekAgo))),
        db.select().from(weightLogs).where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, weekAgo))).orderBy(asc(weightLogs.loggedAt)),
        db.select({ steps: stepLogs.steps, loggedAt: stepLogs.loggedAt }).from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, weekAgo))),
      ]);

      const clientAgeDays = client.createdAt
        ? Math.floor((Date.now() - new Date(client.createdAt).getTime()) / 86_400_000)
        : 999;
      if (chats.length === 0) {
        if (clientAgeDays < 2) continue; // just onboarded today — skip
        await sendWhatsApp(client.phoneNumber, `${name}, nothing logged this week. The restart is simple — send me what you're eating right now. One meal. That's the whole task.`);
        continue;
      }
      const daysWithLogs = new Set(chats.map(c => new Date(c.createdAt!).toDateString())).size;
      if (daysWithLogs < 3) {
        await sendWhatsApp(client.phoneNumber, `${name}, ${daysWithLogs} day${daysWithLogs !== 1 ? "s" : ""} logged. You're in it — keep going. Target this week: 5 days, just one meal a day is enough.`);
        continue;
      }

      const foodLogs = chats.filter(c => c.intent === "FOOD_LOG");
      const plannedSessions = client.trainingDaysPerWeek || 3;
      const completedSessions = workoutEntries.length;
      const weekNum = client.programmeWeek || 1;
      const proteinTarget = client.proteinTarget || 120;
      const stepsTarget = client.stepsTarget || 8500;

      let weightLine = "", weightEmoji = "⚖️";
      if (weightEntries.length >= 2) {
        const diff = parseFloat(String(weightEntries[weightEntries.length - 1].weight)) - parseFloat(String(weightEntries[0].weight));
        if (diff < -0.1) { weightLine = `${Math.abs(diff).toFixed(1)}kg down`; weightEmoji = "📉"; }
        else if (diff > 0.1) { weightLine = `${diff.toFixed(1)}kg up`; weightEmoji = "📈"; }
        else { weightLine = "unchanged"; weightEmoji = "➡️"; }
      } else if (weightEntries.length === 1) {
        weightLine = `${weightEntries[0].weight}kg logged`;
      } else {
        weightLine = "not logged — weigh in Monday morning";
      }

      let stepsLine = "", stepsEmoji = "👟";
      if (stepEntries.length > 0) {
        const avgSteps = Math.round(stepEntries.reduce((s, l) => s + (l.steps || 0), 0) / stepEntries.length);
        const pct = Math.round((avgSteps / stepsTarget) * 100);
        stepsEmoji = pct >= 100 ? "✅" : pct >= 75 ? "👟" : "⚠️";
        stepsLine = `${avgSteps.toLocaleString()} avg (${pct}% of ${stepsTarget.toLocaleString()} target)`;
      } else {
        stepsLine = "not logged this week"; stepsEmoji = "⚠️";
      }

      const PROTEIN_RICH = ["chicken", "eggs", "pilchards", "tuna", "beef", "fish", "beans", "greek yogurt", "cottage cheese", "whey", "steak", "pork", "turkey", "mince", "biltong", "sardines", "lentils"];
      const JUNK = ["kfc", "mcdonalds", "nandos", "pizza", "chips", "cool drink", "alcohol", "beer", "wine", "spur", "steers", "wimpy", "debonairs", "red bull", "monster energy", "energy drink", "fanta", "coke", "sprite", "fizzy drink", "oros"];
      const foodDays = new Set(foodLogs.map(c => new Date(c.createdAt!).toDateString())).size;
      const proteinDays = new Set(foodLogs.filter(l => PROTEIN_RICH.some(w => (l.messageIn || "").toLowerCase().includes(w))).map(c => new Date(c.createdAt!).toDateString())).size;
      const proteinHitRate = foodDays > 0 ? Math.round((proteinDays / foodDays) * 100) : 0;
      const proteinEmoji = proteinHitRate >= 80 ? "✅" : proteinHitRate >= 50 ? "⚠️" : "❌";
      const trainPct = Math.round((completedSessions / plannedSessions) * 100);
      const trainEmoji = trainPct >= 100 ? "✅" : trainPct >= 66 ? "💪" : "⚠️";
      const streak = client.workoutStreak || 0;
      const streakLine = streak > 0 ? `🔥 ${streak}-session streak` : "";
      const totalSessions = client.totalWorkoutsCompleted || 0;
      const milestoneLine = totalSessions > 0 && totalSessions % 10 === 0 ? `🏆 ${totalSessions} total sessions — milestone` : "";
      const junkCount = foodLogs.filter(l => JUNK.some(w => (l.messageIn || "").toLowerCase().includes(w))).length;
      const noProteinDays = foodDays - proteinDays;
      const clientGoalWeekly = client.goalType || "fat_loss";
      const isMuscleGainWeekly = clientGoalWeekly === "muscle_gain";
      const budgetTierWeekly = client.weeklyFoodBudget || "100_300";
      const isBudgetTight = budgetTierWeekly === "under_50" || budgetTierWeekly === "50_100" || budgetTierWeekly === "under_100" || budgetTierWeekly === "100_300";
      let warning = "";
      if (completedSessions === 0) {
        warning = `⚠️ Zero sessions this week — one session this week is all I need from you.`;
      } else if (junkCount >= 3) {
        warning = isMuscleGainWeekly
          ? `Processed & fried food showed up ${junkCount}x this week. For muscle gain this hurts — your calories need to come from protein-dense sources, not fried food. Keep the calories, fix the source. Chicken, rice, eggs over KFC and chips.`
          : `Takeaways & cooldrinks showed up ${junkCount}x this week — no stress, enjoy them now and then. Just keep the other days protein-first.`;
      } else if (noProteinDays >= 3) {
        const proteinSources = isBudgetTight
          ? `pilchards (R12/tin, 25g protein) and eggs (R3–4 each, 6g protein) — protein on any budget`
          : `chicken, eggs, pilchards, Greek yoghurt, or biltong`;
        warning = isMuscleGainWeekly
          ? `⚠️ ${noProteinDays} days this week with no protein logged. Muscle cannot grow without it — this is the single biggest limiter right now. Tonight: ${proteinSources}. This is non-negotiable.`
          : `Protein: ${noProteinDays} days this week without protein logged. Even one egg or a tin of pilchards (R12, 25g protein) counts — start with one meal tonight.`;
      }

      let focus = "";
      if (completedSessions > 0 && completedSessions < plannedSessions) {
        const sessionsShort = plannedSessions - completedSessions;
        focus = isMuscleGainWeekly
          ? `Train ${sessionsShort} more time${sessionsShort !== 1 ? "s" : ""} than last week — muscle growth requires the stimulus. No sessions = no signal to grow.`
          : `Train ${sessionsShort} more time${sessionsShort !== 1 ? "s" : ""} than last week.`;
      } else if (proteinHitRate < 60) {
        focus = isBudgetTight
          ? `Protein at every meal — pilchards, eggs, beans. Pilchards are R12 for 25g protein — the best protein per rand in SA.`
          : isMuscleGainWeekly
          ? `Protein at every meal, no exceptions. This is what drives your goal — eggs, pilchards, chicken, Greek yoghurt.`
          : `Protein at every meal — eggs, pilchards, beans, chicken.`;
      } else if (stepEntries.length === 0) {
        focus = `Log your steps at least 3 days this week.`;
      } else {
        focus = `Maintain the consistency — same output or better.`;
      }

      const logScore = Math.round((daysWithLogs / 7) * 25);
      const trainScore = Math.round((Math.min(completedSessions, plannedSessions) / plannedSessions) * 35);
      const proteinScore = Math.round((proteinHitRate / 100) * 25);
      const stepsScore = stepEntries.length > 0 ? Math.round((Math.min(1, stepEntries.reduce((s, l) => s + (l.steps || 0), 0) / stepEntries.length / stepsTarget)) * 15) : 0;
      const totalScore = logScore + trainScore + proteinScore + stepsScore;
      const scoreLabel = totalScore >= 85 ? "Outstanding" : totalScore >= 70 ? "Strong" : totalScore >= 50 ? "Building" : "Below target";

      const lines = [
        `*${name} — Week ${weekNum} Report Card*`, ``,
        `${trainEmoji} Training: ${completedSessions}/${plannedSessions} sessions`,
        `${weightEmoji} Weight: ${weightLine}`,
        `${stepsEmoji} Steps: ${stepsLine}`,
        `${proteinEmoji} Protein days: ${proteinDays}/${foodDays} meals tracked`,
        `📅 Logged: ${daysWithLogs}/7 days`,
        streakLine || "", ``,
        `*Weekly Score: ${totalScore}/100 — ${scoreLabel}*`, ``,
      ].filter(l => l !== null);

      if (milestoneLine) lines.push(milestoneLine, ``);
      if (warning) lines.push(warning, ``);
      lines.push(`*This week:* ${focus}`);
      if (totalScore >= 85) lines.push(``, `${name}, this is what results look like. Same energy next week.`);
      else if (totalScore >= 60) lines.push(``, `Solid week, ${name}. One more push and you are in the top tier. Go.`);
      else lines.push(``, `${name}, below your best but you are still here. That matters. Reset Sunday night and go again Monday.`);

      await sendWhatsApp(client.phoneNumber, lines.join("\n"));

      try {
        const list = getShoppingList(budgetTierWeekly, weekNum + 1, clientGoalWeekly);
        const shoppingMsg = formatShoppingList(list, name, clientGoalWeekly, {
          calorieTarget: client.calorieTarget || undefined,
          proteinTarget: client.proteinTarget || undefined,
          budgetTier: budgetTierWeekly,
        });
        await sendWhatsApp(client.phoneNumber, shoppingMsg);
      } catch (shopErr) { console.warn(`[SCHEDULER] Shopping list error — ${client.phoneNumber}:`, shopErr); }

      try {
        const daysInCycle = client.trainingDaysPerWeek || 3;
        const newDay = ((client.programmeDayInWeek || 1) % daysInCycle) + 1;
        const newWeek = newDay === 1 ? (weekNum + 1) : weekNum;
        await db.update(users).set({ programmeDayInWeek: newDay, programmeWeek: newWeek }).where(eq(users.id, client.id));
      } catch { /* non-critical */ }
    } catch (err) {
      console.error(`[SCHEDULER] Sunday report error — ${client.phoneNumber}:`, err);
    }
  }

  // Send personalized ElevenLabs voice recap in coach's cloned voice — after all text cards
  try {
    await runWeeklyRecaps();
  } catch (recapErr) {
    console.error("[SCHEDULER] Weekly recap voice error:", recapErr);
  }
}

export async function runSundayEveningCheckin(): Promise<void> {
  console.log("[SCHEDULER] JOB: Sunday evening check-in");
  const clients = await getActiveClients();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const name = client.name || "there";
      const plannedSessions = client.trainingDaysPerWeek || 3;
      const [weekWorkouts, weekSteps, weekFoodLogs] = await Promise.all([
        db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, weekAgo))),
        db.select().from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, weekAgo))),
        db.select().from(chatHistory).where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, weekAgo))),
      ]);
      const completedSessions = weekWorkouts.length;
      const avgSteps = weekSteps.length > 0 ? Math.round(weekSteps.reduce((s, l) => s + (l.steps || 0), 0) / weekSteps.length) : 0;
      const sundayGoal = client.goalType || "fat_loss";
      const isMuscleGainSunday = sundayGoal === "muscle_gain";
      const isRecompSunday = sundayGoal === "recomposition";
      const distinctFoodDays = new Set(weekFoodLogs.flatMap(l => {
        if (!l.createdAt) return [];
        const d = new Date(l.createdAt.getTime() + 2 * 3_600_000);
        return [`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`];
      })).size;
      let question: string;
      if (completedSessions === 0 && distinctFoodDays === 0) {
        question = `${name}, this week was quiet. One question — what got in the way?`;
      } else if (completedSessions >= plannedSessions && distinctFoodDays >= 5) {
        question = isMuscleGainSunday
          ? `${name}, ${completedSessions} sessions done and food tracked all week. Solid. One question — what did you eat that gave you the most energy in the gym this week?`
          : isRecompSunday
          ? `${name}, ${completedSessions} sessions done and food tracked all week. Solid recomp week. One question — where did you feel the most change this week?`
          : `${name}, ${completedSessions} sessions done this week and food tracked. Solid week. What was the hardest part?`;
      } else if (completedSessions < Math.ceil(plannedSessions * 0.5)) {
        question = `${name}, ${completedSessions} of ${plannedSessions} sessions this week. What kept you from the other ${plannedSessions - completedSessions}?`;
      } else if (distinctFoodDays < 3) {
        question = isMuscleGainSunday
          ? `${name}, ${completedSessions} sessions done — but food tracking was light. For muscle gain I need to see your intake. What makes it hard to log?`
          : isRecompSunday
          ? `${name}, ${completedSessions} sessions done — but food tracking was thin. Recomp requires seeing your intake to balance the cut and build. What makes it hard to log?`
          : `${name}, ${completedSessions} sessions done. Food tracking was thin this week. What makes it hard to log?`;
      } else if (avgSteps > 0 && avgSteps < (client.stepsTarget || 8500) * 0.6) {
        question = isMuscleGainSunday
          ? `${name}, average steps this week: ${avgSteps.toLocaleString()}. Light movement helps recovery on rest days — what's the real barrier to getting outside?`
          : isRecompSunday
          ? `${name}, average steps this week: ${avgSteps.toLocaleString()}. Daily walking is your recomp engine outside the gym — what's the real barrier to moving more?`
          : `${name}, average steps this week: ${avgSteps.toLocaleString()}. Steps are your daily fat-burning base. What is the real barrier to walking more?`;
      } else {
        question = isMuscleGainSunday
          ? `${name}, week done. ${completedSessions} sessions, ${distinctFoodDays} days logged. One sentence — what felt strongest this week in the gym?`
          : isRecompSunday
          ? `${name}, week done. ${completedSessions} sessions, ${distinctFoodDays} days logged. One sentence — what did you notice changing this week?`
          : `${name}, week done. ${completedSessions} sessions, ${distinctFoodDays} days logged. One sentence — what do you want to be different next week?`;
      }
      if (await claimDailySlot(client.id, "sunday_evening")) { await sendWhatsApp(client.phoneNumber, question); }
    } catch (err) { console.error(`[SCHEDULER] Sunday check-in error — ${client.phoneNumber}:`, err); }
  }
}

export async function runWeekendFoodAudit(): Promise<void> {
  console.log("[SCHEDULER] JOB: Weekend food pattern audit");
  const clients = await getActiveClients();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const foodLogs = await db.select({ messageIn: chatHistory.messageIn, createdAt: chatHistory.createdAt })
        .from(chatHistory).where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, sevenDaysAgo))).orderBy(asc(chatHistory.createdAt));
      if (foodLogs.length < 5) continue;

      const weekdayLogs = foodLogs.filter(l => { const d = new Date(new Date(l.createdAt!).getTime() + 2 * 3_600_000).getUTCDay(); return d !== 0 && d !== 6; });
      const weekendLogs = foodLogs.filter(l => { const d = new Date(new Date(l.createdAt!).getTime() + 2 * 3_600_000).getUTCDay(); return d === 0 || d === 6; });
      if (weekendLogs.length === 0 || weekdayLogs.length === 0) continue;

      const HIGH_CAL = ["kfc", "mcdonalds", "nandos", "pizza", "kotas", "vetkoek", "beer", "wine", "chips", "cake", "chocolate", "dessert", "ice cream", "takeaway", "takeaways", "cool drink", "coke", "fanta", "sprite"];
      const GOOD_PROTEIN = ["chicken breast", "pilchards", "eggs", "tuna", "beef mince", "greek yogurt", "cottage cheese"];

      const weekdayJunk = weekdayLogs.filter(l => HIGH_CAL.some(k => (l.messageIn || "").toLowerCase().includes(k))).length;
      const weekendJunk = weekendLogs.filter(l => HIGH_CAL.some(k => (l.messageIn || "").toLowerCase().includes(k))).length;
      const weekdayProtein = weekdayLogs.filter(l => GOOD_PROTEIN.some(k => (l.messageIn || "").toLowerCase().includes(k))).length;
      const weekendProtein = weekendLogs.filter(l => GOOD_PROTEIN.some(k => (l.messageIn || "").toLowerCase().includes(k))).length;

      const weekdayJunkRate = weekdayLogs.length > 0 ? weekdayJunk / weekdayLogs.length : 0;
      const weekendJunkRate = weekendLogs.length > 0 ? weekendJunk / weekendLogs.length : 0;
      const weekdayProteinRate = weekdayLogs.length > 0 ? weekdayProtein / weekdayLogs.length : 0;
      const weekendProteinRate = weekendLogs.length > 0 ? weekendProtein / weekendLogs.length : 0;
      const name = client.name || "there";

      // Claim only when there is actually a pattern to flag — DB-backed weekly dedup.
      if (weekendJunkRate > weekdayJunkRate + 0.3) {
        if (!(await claimProactive(client.id, "weekend_food_audit", thisWeekUTC()))) continue;
        await sendWhatsApp(client.phoneNumber, `${name} — pattern spotted. Your weekday eating is solid. But ${weekendJunk > 0 ? `${weekendJunk} weekend meal${weekendJunk !== 1 ? "s" : ""}` : "your weekends"} this week had foods that are undoing the weekday work. One rule for weekends: protein first at every meal, then eat what you want after. That single rule changes everything.`);
      } else if (weekendProteinRate < weekdayProteinRate - 0.3) {
        if (!(await claimProactive(client.id, "weekend_food_audit", thisWeekUTC()))) continue;
        await sendWhatsApp(client.phoneNumber, `${name} — you are hitting protein well during the week. But weekends your protein drops. When you are out, at a braai, or grabbing food on the go — always anchor the meal with protein first.`);
      }
    } catch (err) { console.error(`[SCHEDULER] Weekend food audit error — ${client.phoneNumber}:`, err); }
  }
}

export async function runSundayMealPlan(): Promise<void> {
  console.log("[SCHEDULER] JOB: Sunday proactive meal plan");
  const clients = await getActiveClients();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  let sent = 0;

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const daysSilent = client.lastActiveAt
        ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
        : 999;
      if (daysSilent > 10) continue;
      if (!canSendProactive(client.id)) continue;
      if (!(await claimProactive(client.id, "sunday_meal_plan", thisWeekUTC()))) continue;

      const name = (client.name || "there").split(" ")[0];
      const recentFoodLogs = await db.select({ messageIn: chatHistory.messageIn })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, sevenDaysAgo)));
      const recentFoods = recentFoodLogs.map(l => (l.messageIn || "").toLowerCase()).filter(Boolean);

      const plan = generateMealPlan({
        calorieTarget: client.calorieTarget || 1800,
        proteinTarget: client.proteinTarget || 120,
        weeklyFoodBudget: client.weeklyFoodBudget || "100_300",
        goalType: client.goalType || "fat_loss",
        medicalConditions: client.medicalConditions || "",
        otherMedicalNotes: client.otherMedicalNotes || "",
        recentFoods,
        firstName: name,
      });

      const goalLabel = client.goalType === "muscle_gain" ? "muscle gain" : client.goalType === "recomposition" ? "recomposition" : "fat loss";
      const intro = `*${name} — your 3-day plan for the week ahead:*\n\nBuilt for your ${goalLabel} goal. Screenshot it, save it, use it. Prep protein on Sunday and your whole week is easier.\n\n---\n\n`;
      await sendWhatsApp(client.phoneNumber, intro + plan);
      sent++;
    } catch (err) { console.error(`[SCHEDULER] Sunday meal plan error — ${client.phoneNumber}:`, err); }
  }
  console.log(`[SCHEDULER] Sunday meal plans sent: ${sent}`);
}

export async function runComplianceLevelUpdate(): Promise<void> {
  console.log("[SCHEDULER] JOB: Weekly compliance level update");
  const clients = await getActiveClients();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      const plannedSessions = client.trainingDaysPerWeek || 3;
      const [thisWeekWorkouts, lastWeekWorkouts] = await Promise.all([
        db.select({ id: workoutLogs.id }).from(workoutLogs).where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, sevenDaysAgo))),
        db.select({ id: workoutLogs.id }).from(workoutLogs).where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, fourteenDaysAgo), lt(workoutLogs.loggedAt, sevenDaysAgo))),
      ]);
      const thisWeekCount = thisWeekWorkouts.length;
      const lastWeekCount = lastWeekWorkouts.length;
      const weeklyScore = Math.min(100, Math.round((thisWeekCount / plannedSessions) * 100));
      let complianceLevel: string;
      if (thisWeekCount === 0) complianceLevel = "RESET";
      else if (thisWeekCount < Math.ceil(plannedSessions * 0.5)) complianceLevel = "BUILDING";
      else if (thisWeekCount >= plannedSessions && lastWeekCount >= plannedSessions) complianceLevel = "LOCKED IN";
      else if (thisWeekCount >= Math.ceil(plannedSessions * 0.75)) complianceLevel = "CONSISTENT";
      else complianceLevel = "BUILDING";
      await db.update(users).set({ weeklyScore, complianceLevel }).where(eq(users.id, client.id));
    } catch (err) { console.error(`[SCHEDULER] Compliance update error — ${client.phoneNumber}:`, err); }
  }
}

export async function runNsvCheckin(): Promise<void> {
  console.log("[SCHEDULER] JOB: Weekly NSV check-in");
  const clients = await getActiveClients();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);

  for (const client of clients) {
    if (isPaused(client)) continue;
    try {
      // Require a real client message (messageIn present) — outbound-only proactive
      // rows must not count as engagement, or this check-in goes to silent clients.
      const recentActivity = await db.select({ id: chatHistory.id }).from(chatHistory)
        .where(and(eq(chatHistory.userId, client.id), isNotNull(chatHistory.messageIn), gte(chatHistory.createdAt, sevenDaysAgo))).limit(1);
      if (recentActivity.length === 0) continue;
      const name = client.name || "there";
      const week = client.programmeWeek || 1;
      const nsvPrompts = [
        `${name}, Week ${week} done.\n\nOne question: what can your body do now that it couldn't when you started?\n\nLift more? Walk further? Climb stairs without stopping? Move without pain?\n\nThat is your real progress. Tell me one thing.`,
        `${name} — end of week check-in.\n\nScale aside — how were your energy levels this week? Did you sleep better? Less afternoon crashes? Wake up feeling less wrecked?\n\nEnergy is the first thing that changes before the scale moves. Tell me what you noticed.`,
        `${name}, Week ${week}.\n\nForget the numbers for a second. Did you make any food choice this week that you wouldn't have made 3 months ago? Less junk automatically? Didn't finish the whole takeaway? Chose water over a cool drink?\n\nSmall shifts like that are what compound into big change. Tell me one.`,
        `${name} — Saturday check-in.\n\nNon-scale question: what habit stuck this week that didn't exist before you started?\n\nCould be logging meals, hitting your steps, not skipping breakfast, sleeping earlier. Behaviour change is harder than weight loss — and it lasts longer.\n\nTell me one habit that's starting to feel automatic.`,
      ];
      // DB claim (weekly window) replaces the state-file flag that a recycle would wipe.
      if (!(await claimProactive(client.id, "nsv_checkin", thisWeekUTC()))) continue;
      await sendWhatsApp(client.phoneNumber, nsvPrompts[(week - 1) % nsvPrompts.length]);
    } catch (err) { console.error(`[SCHEDULER] NSV check-in error — ${client.phoneNumber}:`, err); }
  }
}

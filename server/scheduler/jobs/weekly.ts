import {
  db, users, chatHistory, stepLogs, workoutLogs, weightLogs, mealLogs,
  eq, gte, and, lt, asc, isNotNull,
  sendWhatsApp, canSendProactive, recordProactiveSend, claimProactive, claimDailySlot,
  getActiveClients, isPaused, loadState, saveState,
  todaySAST, thisWeekUTC,
} from "../shared";
import { getShoppingList, formatShoppingList } from "../../shopping-lists";
import { getGoalProfile } from "../../goal-profiles";
import { getGroceryPersonalization } from "../../grocery-personalize";
import { foodConstraints } from "../../food-swaps";
import { suggestStepTargetAdjustment } from "../../targets";
import { getTrajectoryForUser } from "../../trajectory-report";
import { runWeeklyRecaps } from "../../weekly-recap";
import { generateMealPlan } from "../../meal-plan";
import { mentionsForbidden } from "../../brain/reply-verifier";
import { canonicalNextMove } from "../proactive-decision";

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

      // THE LINE STANDS DOWN, NOT THE REPORT (2026-08-19, Cut 9). Unlike the Monday weigh-in
      // reminder — which IS the scale and is withheld whole — this wrap-up is mostly sessions,
      // food days and steps: real progress that must still reach them. Cut 8 bound
      // do_not_mention to the reactive mouth and the decision; a proactive report reaches
      // neither, which is the hole this closes.
      const scaleOffLimits = mentionsForbidden("weight scale weigh", (client as any).doNotMention);
      const weightLine = scaleOffLimits || weightChange === null ? ""
        : weightChange < -0.2 ? `⬇️ Down ${Math.abs(weightChange).toFixed(1)}kg`
        : weightChange > 0.2 ? `⬆️ Up ${weightChange.toFixed(1)}kg`
        : `➡️ Weight holding`;

      // THE WRAP-UP REPORTS; IT DOES NOT PRESCRIBE (2026-08-25, P0-4b). The four closings this
      // replaces were a local ladder over (sessions, foodDays, account age) that always landed on
      // the same two rules — "protein at every meal and one session before Sunday night" — and one
      // of them said "Reply *1* right now" to a client who might have told us that morning they
      // were not training. The numbers above are a real report and stay; the instruction is the
      // canonical one, which has read what they said.
      const move = await canonicalNextMove(client);
      const lines = [
        `*${name} — Week ${week} wrap-up:*`,
        ``,
        `💪 ${sessions} workout${sessions !== 1 ? "s" : ""} done`,
        `📋 ${foodDays} day${foodDays !== 1 ? "s" : ""} food logged`,
        avgSteps > 0 ? `👟 ${avgSteps.toLocaleString()} avg steps` : "",
        weightLine,
      ].filter(Boolean);
      if (move.line) lines.push(``, move.line);

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
      // THE THIN-WEEK EXITS GO THROUGH THE LADDER TOO (2026-08-25, P0-4b). "Send me what you're
      // eating right now" and "Target this week: 5 days" were the fifth and sixth hand-written
      // versions of chooseAction's `come_back` and `log` rungs, and they were the versions that
      // reached the client who had gone quietest — the one the ladder's escalation was written
      // for. A week of silence and six weeks of silence got the same sentence here.
      if (chats.length === 0) {
        if (clientAgeDays < 2) continue; // just onboarded today — skip
        const quiet = await canonicalNextMove(client);
        if (quiet.line) await sendWhatsApp(client.phoneNumber, `${name}, nothing logged this week.\n\n${quiet.line}`);
        continue;
      }
      const daysWithLogs = new Set(chats.map(c => new Date(c.createdAt!).toDateString())).size;
      if (daysWithLogs < 3) {
        const thin = await canonicalNextMove(client);
        const opener = `${name}, ${daysWithLogs} day${daysWithLogs !== 1 ? "s" : ""} logged this week. You're in it.`;
        await sendWhatsApp(client.phoneNumber, thin.line ? `${opener}\n\n${thin.line}` : opener);
        continue;
      }

      const foodLogs = chats.filter(c => c.intent === "FOOD_LOG");
      const plannedSessions = client.trainingDaysPerWeek || 3;
      const completedSessions = workoutEntries.length;
      const weekNum = client.programmeWeek || 1;
      const proteinTarget = client.proteinTarget || 120;
      const stepsTarget = client.stepsTarget || 8500;

      // Same rule, the other weekly report (Cut 9). "not logged — weigh in Monday morning" was
      // the worst of the four outcomes: a client who asked us to drop the scale got told off
      // for not standing on one.
      const scaleOff = mentionsForbidden("weight scale weigh", (client as any).doNotMention);
      let weightLine = "", weightEmoji = "⚖️";
      if (scaleOff) {
        weightLine = "";
      } else if (weightEntries.length >= 2) {
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
      const avgSteps = stepEntries.length > 0
        ? Math.round(stepEntries.reduce((s, l) => s + (l.steps || 0), 0) / stepEntries.length)
        : 0;
      if (stepEntries.length > 0) {
        const pct = Math.round((avgSteps / stepsTarget) * 100);
        stepsEmoji = pct >= 100 ? "✅" : pct >= 75 ? "👟" : "⚠️";
        stepsLine = `${avgSteps.toLocaleString()} avg (${pct}% of ${stepsTarget.toLocaleString()} target)`;
      } else {
        stepsLine = "not logged this week"; stepsEmoji = "⚠️";
      }
      // Right-size the step goal to reality — the "50% can't walk 10k" plan. Only a
      // SUGGESTION with a one-tap button; the client stays in control (targets.ts).
      const stepAdj = suggestStepTargetAdjustment(stepsTarget, avgSteps, stepEntries.length);

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

      // ── TWO LADDERS BECOME ONE OBSERVATION AND ONE DECISION (2026-08-25, P0-4b) ────────────
      //
      // `warning` and `focus` were both if-else ladders over the same week, disagreeing by
      // construction: a client with zero sessions and thin protein got "one session this week is
      // all I need from you" in one slot and "Protein at every meal" in the other — two next moves
      // in one message, from two ladders, neither of them the decision owner. Add the third one in
      // the morning brief and the product had three opinions about Sunday.
      //
      // What survives is what was genuinely an OBSERVATION rather than an instruction: the junk
      // count is a real pattern in their own logs, and naming it without prescribing is exactly
      // what recognition is for. The instruction is the canonical move, once.
      const observation = junkCount >= 3
        ? `Takeaways & cooldrinks showed up ${junkCount}x this week.`
        : noProteinDays >= 3
        ? `${noProteinDays} day${noProteinDays !== 1 ? "s" : ""} this week without protein logged.`
        : "";
      const move = await canonicalNextMove(client);

      const logScore = Math.round((daysWithLogs / 7) * 25);
      const trainScore = Math.round((Math.min(completedSessions, plannedSessions) / plannedSessions) * 35);
      const proteinScore = Math.round((proteinHitRate / 100) * 25);
      const stepsScore = stepEntries.length > 0 ? Math.round((Math.min(1, stepEntries.reduce((s, l) => s + (l.steps || 0), 0) / stepEntries.length / stepsTarget)) * 15) : 0;
      const totalScore = logScore + trainScore + proteinScore + stepsScore;
      const scoreLabel = totalScore >= 85 ? "Outstanding" : totalScore >= 70 ? "Strong" : totalScore >= 50 ? "Building" : "Below target";

      // FORWARD look — the forecast from their OWN logs. The report card is backward
      // (what happened); this is where they're HEADING, which is the #1 anti-churn force
      // ("am I wasting my R199?"). Deterministic (trajectory engine). Only shown when there's
      // enough logged data to be honest (≥3 days) — a low-confidence forecast is noise.
      let forecastLine = "";
      try {
        const traj = await getTrajectoryForUser(client.id);
        if (traj && traj.daysLogged >= 3) {
          const kg = Math.abs(traj.predictedWeeklyChangeKg);
          if (traj.direction === "losing") forecastLine = `🔮 Forecast: on track — about *${kg}kg/week* coming off if you hold this. The scale follows the logs.`;
          else if (traj.direction === "gaining" && isMuscleGainWeekly) forecastLine = `🔮 Forecast: building — about *${kg}kg/week* on. Good.`;
          else if (traj.direction === "gaining") forecastLine = `🔮 Forecast: your logs show a surplus — that's why the scale isn't dropping. Reply *forecast* and we trim one thing.`;
          else forecastLine = `🔮 Forecast: right at maintenance. Reply *forecast* for the one lever that moves it.`;
        }
      } catch { /* forecast is a bonus — never blocks the report */ }

      // "Showed up" leads (2026-07-13 retention reports): the first-month metric that
      // retains is days-you-didn't-ghost-me, not kg. The scale line comes after effort.
      const lines = [
        `*${name} — Week ${weekNum} Report Card*`, ``,
        `📅 Showed up: ${daysWithLogs}/7 days`,
        `${trainEmoji} Training: ${completedSessions}/${plannedSessions} sessions`,
        `${stepsEmoji} Steps: ${stepsLine}`,
        `${proteinEmoji} Protein days: ${proteinDays}/${foodDays} meals tracked`,
        weightLine ? `${weightEmoji} Weight: ${weightLine}` : "",
        ...(forecastLine ? [forecastLine] : []),
        streakLine || "", ``,
        `*Weekly Score: ${totalScore}/100 — ${scoreLabel}*`, ``,
      ].filter(l => l !== null);

      if (milestoneLine) lines.push(milestoneLine, ``);
      if (observation) lines.push(observation, ``);
      // The adaptive step goal is a TARGET CHANGE this job is offering, not a next move — it is
      // the client's call, one tap, and it stays. It does not compete with the decision below.
      if (stepAdj) lines.push(`👟 *Your steps:* ${stepAdj.reason}`);
      if (totalScore >= 85) lines.push(``, `${name}, this is what results look like.`);
      else if (totalScore >= 60) lines.push(``, `Solid week, ${name}.`);
      else lines.push(``, `${name}, below your best but you are still here. That matters.`);
      if (move.line) lines.push(``, move.line);
      // One-tap acceptance — routes to the deterministic step-target updater. Client's call.
      if (stepAdj) lines.push(``, `[BUTTONS:Set steps to ${stepAdj.newTarget}]`);

      await sendWhatsApp(client.phoneNumber, lines.join("\n"));

      try {
        const list = getShoppingList(budgetTierWeekly, weekNum + 1, clientGoalWeekly, foodConstraints(client as any));
        const personalization = await getGroceryPersonalization(client.id, clientGoalWeekly, (client as any).foodDislikes, (client as any).dietaryRestrictions);
        const shoppingMsg = formatShoppingList(list, name, clientGoalWeekly, {
          calorieTarget: client.calorieTarget || undefined,
          proteinTarget: client.proteinTarget || undefined,
          budgetTier: budgetTierWeekly,
          personalization,
          constraints: foodConstraints(client as any),
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

  // Personal ElevenLabs voice recap in the coach's cloned voice — the human layer
  // after the written Report Card. Reworked 2026-07-12 (Kam: "it sounds generic"):
  // it now names a food the client ACTUALLY logged and talks like a mate on a voice
  // note instead of reading the scorecard back, and it no longer sends a duplicate
  // week card (the Report Card above already carries every number). One clean bubble.
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

      // THE PATTERN IS OURS TO SEE; THE MOVE IS NOT OURS TO INVENT (2026-08-25, P0-4b). The
      // weekday-versus-weekend comparison is a genuine observation nothing else in the product
      // makes, and it stays. Both branches then ended in the same locally-chosen prescription —
      // "protein first at every meal" — which is chooseAction's rung 5, written a seventh time and
      // sent without ever asking whether the client had closed food or was ill.
      const pattern = weekendJunkRate > weekdayJunkRate + 0.3
        ? `${name} — pattern spotted. Your weekday eating is solid. But ${weekendJunk > 0 ? `${weekendJunk} weekend meal${weekendJunk !== 1 ? "s" : ""}` : "your weekends"} this week looked different from your weekdays.`
        : weekendProteinRate < weekdayProteinRate - 0.3
        ? `${name} — you are hitting protein well during the week. But weekends your protein drops.`
        : "";
      if (!pattern) continue;
      // Claim only when there is actually a pattern to flag — DB-backed weekly dedup.
      if (!(await claimProactive(client.id, "weekend_food_audit", thisWeekUTC()))) continue;
      const audit = await canonicalNextMove(client);
      await sendWhatsApp(client.phoneNumber, audit.line ? `${pattern}\n\n${audit.line}` : pattern);
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
        dietaryRestrictions: client.dietaryRestrictions,
        foodDislikes: client.foodDislikes,
        otherMedicalNotes: client.otherMedicalNotes || "",
        recentFoods,
        firstName: name,
      });

      // Goal-aware label (2026-07-22 reviewer verification): was hardcoded to "fat loss" for any
      // non-body-comp goal, so a wellness / has-a-condition client was told the plan was for "fat
      // loss". getGoalProfile gives the honest client-facing label for all five goals.
      const goalLabel = getGoalProfile(client.goalType).label.toLowerCase();
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

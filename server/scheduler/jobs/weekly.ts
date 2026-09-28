import {
  db, users, chatHistory, stepLogs, workoutLogs, weightLogs, mealLogs,
  eq, gte, and, asc, isNotNull,
  sendWhatsApp, canSendProactive, claimProactive,
  getActiveClients, isPaused,
  thisWeekUTC,
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
import { canonicalNextMove, recordCanonicalMoveOutbound } from "../proactive-decision";
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
      const name = (client.name || "there").split(" ")[0]; // first name: "Lerato", not the full name (B4)
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
      // THE WEEKLY TEMPLATE BELONGS TO ALL THREE EXITS (Cut 6 amendment, 2026-09-14). The full
      // report below is not the only weekly review this job sends: a client with nothing logged
      // and a client with a thin week each get one from the branches immediately below — and those
      // are the clients MOST likely to be outside the 24-hour window, because going quiet is
      // exactly what put them on this path. Wiring only the full report would have left the
      // weekly review failing for precisely the people it was written for.
      //
      // Counts come from rows already fetched above, so this adds no query and states nothing it
      // cannot back: sessions from workoutEntries, food days from the FOOD_LOG chats themselves.
      const weeklyTemplateFor = (sessionsDone: number, foodDayCount: number) => ({
        name: "kamlife_weekly_check",
        variables: {
          "1": name,
          "2": `${sessionsDone} of ${client.trainingDaysPerWeek || 3}`,
          "3": `${foodDayCount} of 7`,
        },
      });
      const foodDaysFrom = (rows: typeof chats) => new Set(
        rows.filter(c => c.intent === "FOOD_LOG" && c.createdAt)
          .map(c => new Date(c.createdAt!).toDateString()),
      ).size;

      if (chats.length === 0) {
        if (clientAgeDays < 2) continue; // just onboarded today — skip
        const quiet = await canonicalNextMove(client);
        if (quiet.line) {
          const delivery = await sendWhatsApp(
            client.phoneNumber, `${name}, nothing logged this week.\n\n${quiet.line}`,
            undefined, weeklyTemplateFor(workoutEntries.length, 0),
          );
          await recordCanonicalMoveOutbound(client, quiet, delivery);
        }
        continue;
      }
      const daysWithLogs = new Set(chats.map(c => new Date(c.createdAt!).toDateString())).size;
      if (daysWithLogs < 3) {
        const thin = await canonicalNextMove(client);
        // THE WEEK BY NAME (B4, replay gate): what they actually ate, from the meal rows, and one small focus when
        // the decision holds, instead of a count and "You're in it."
        const weekMeals = await db.select({ items: mealLogs.items }).from(mealLogs)
          .where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, weekAgo))).orderBy(asc(mealLogs.loggedAt));
        const foods = Array.from(new Set(weekMeals.flatMap(r => (Array.isArray(r.items) ? r.items : [])
          .map((i: any) => String(i?.name || "").replace(/\s*\(.*?\)/g, "").toLowerCase()).filter(Boolean)))).slice(0, 4);
        const opener = `${name}, ${daysWithLogs} day${daysWithLogs !== 1 ? "s" : ""} on record this week${foods.length ? ` — ${foods.join(", ")}` : ""}.`;
        const focus = `Next week: ${daysWithLogs + 1} days on record. That's the whole goal.`;
        const delivery = await sendWhatsApp(
          client.phoneNumber, `${opener}\n\n${thin.line || focus}`,
          undefined, weeklyTemplateFor(workoutEntries.length, foodDaysFrom(chats)),
        );
        await recordCanonicalMoveOutbound(client, thin, delivery);
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

      // OUTSIDE THE WINDOW, THE WEEK'S NUMBERS STILL LAND (Cut 6, 2026-09-14). kamlife_weekly_check
      // was approved and wired with no call site, so a client who had not messaged in 24 hours got
      // the generic check-in instead of their 7-day review — and this job recorded a delivery and
      // a canonical move against it. The template carries the two counts the review is built on.
      const weeklyTemplate = weeklyTemplateFor(completedSessions, foodDays);
      const delivery = await sendWhatsApp(client.phoneNumber, lines.join("\n"), undefined, weeklyTemplate);
      await recordCanonicalMoveOutbound(client, move, delivery);

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
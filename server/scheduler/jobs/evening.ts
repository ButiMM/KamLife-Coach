import {
  db, users, stepLogs, workoutLogs, mealLogs,
  eq, gte, and, desc, sql,
  sendWhatsApp, canSendProactive, canSendRoutineNudge, recordProactiveSend, claimDailySlot,
  getActiveClients, isPaused, dayStart, getTodayLogs,
  TRAINING_SCHEDULES, isSickOrInjuredToday,
} from "../shared";
import { sendWhatsAppButtons } from "../../twilio-interactive";
import { usesMacroTargets } from "../../goal-profiles";
import { proteinOptions } from "../../utils";

export async function runEveningAccountability(): Promise<void> {
  console.log("[SCHEDULER] JOB: Evening accountability");
  const clients = await getActiveClients();
  const todayStart = dayStart(0);

  for (const client of clients) {
    if (isPaused(client)) continue;
    // Routine evening accountability — eases off as a client goes quiet so we don't
    // stack onto the morning comeback flow (which owns 3+ day silent users) and so we
    // stop paying to message people who have checked out. Engaged users (daysSilent ≤ 1)
    // are unaffected. Also enforces the 1/day cap and the global pause.
    if (!canSendRoutineNudge(client)) continue;
    try {
      const name = (client.name || "there").split(" ")[0];
      const phone = client.phoneNumber;
      const todayLogs = await getTodayLogs(client.id);

      if (todayLogs.length === 0) {
        if (await claimDailySlot(client.id, "evening")) {
          const isNewClient = !client.totalWorkoutsCompleted && client.createdAt &&
            (Date.now() - new Date(client.createdAt).getTime()) > 6 * 3_600_000 &&
            (Date.now() - new Date(client.createdAt).getTime()) < 48 * 3_600_000;
          if (isNewClient) {
            await sendWhatsApp(phone, `${name}, your programme is loaded and ready. Reply *1* to see today's workout — it takes 20 minutes. The first session is always the hardest. Get it done tonight.`);
          } else {
            await sendWhatsApp(phone, `${name}, haven't heard from you today — no stress. One quick thing before bed: tell me what you ate. Even just your last meal. That's all I need to keep you moving.`);
          }
        }
        continue;
      }

      if (!canSendProactive(client.id)) continue;

      const sick = await isSickOrInjuredToday(client.id);
      const protTarget = client.proteinTarget || 120;
      const stepsTarget = client.stepsTarget || 8500;
      const trainingDays = client.trainingDaysPerWeek || 3;
      const dow = new Date(Date.now() + 2 * 3_600_000).getDay(); // SAST = UTC+2
      const isTrainingDay = (TRAINING_SCHEDULES[trainingDays] || TRAINING_SCHEDULES[3]).includes(dow);

      const [mealSum] = await db.select({
        todayCal: sql<number>`COALESCE(SUM(${mealLogs.kcalInt}), 0)::int`,
        todayProt: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
      }).from(mealLogs).where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, todayStart)));
      const todayCal = mealSum?.todayCal || 0;
      const todayProt = mealSum?.todayProt || 0;

      const [todayWorkout] = await db.select({ id: workoutLogs.id })
        .from(workoutLogs)
        .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, todayStart), eq(workoutLogs.workoutCompleted, true)))
        .limit(1);

      const [todayStep] = await db.select({ steps: stepLogs.steps })
        .from(stepLogs)
        .where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, todayStart)))
        .orderBy(desc(stepLogs.loggedAt)).limit(1);

      const workedOut = !!todayWorkout;
      const stepsDone = todayStep ? todayStep.steps >= stepsTarget : false;
      const protHit = todayProt >= Math.round(protTarget * 0.9);
      const stepCount = todayStep?.steps ?? 0;
      const goal = client.goalType || "fat_loss";
      const calTarget = client.calorieTarget || 0;
      // Mirrors the calorieCeilingHit logic in food-scanner — don't push more food/protein
      // when the user is already meaningfully over their daily calorie budget.
      const calorieCeilingHit = calTarget > 0 && (todayCal - calTarget) >= 100;

      // Proactive dinner suggestion: user has been active today but no dinner logged yet.
      // Identify "dinner" as a meal logged in the last 4 hours — if absent and it's evening, suggest.
      const fourHoursAgo = new Date(Date.now() - 4 * 3_600_000);
      const [recentMeal] = await db.select({ id: mealLogs.id })
        .from(mealLogs)
        .where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, fourHoursAgo)))
        .limit(1)
        .catch(() => [] as { id: number }[]);
      const noDinnerYet = !recentMeal;
      const hasBeenActive = todayCal > 0 || workedOut || stepCount > 1000;

      if (noDinnerYet && hasBeenActive && !sick && !calorieCeilingHit && await claimDailySlot(client.id, "evening")) {
        const protGap = protTarget - todayProt;
        let dinnerSuggestion: string;
        if (!usesMacroTargets(goal)) {
          // Wellness / has-a-condition client — no protein-gram maths, just a warm plate nudge.
          dinnerSuggestion = `${name}, dinner time. Keep it simple and balanced — some protein, some veg, and you're sorted. What do you have at home tonight?`;
        } else if (goal === "muscle_gain") {
          const mealOption = protGap > 40 ? "rice + chicken, or pap + mince + veg" : `eggs + toast, or ${proteinOptions(client).split(",")[0]} on bread`;
          dinnerSuggestion = `${name}, dinner time. Still need ${protGap > 0 ? `${protGap}g protein` : "a solid meal"}. Options: ${mealOption}. What are you working with tonight?`;
        } else {
          const opts = proteinOptions(client);
          const protNote = protGap > 30
            ? `${protGap}g protein still to go — `
            : protGap > 0
              ? `Almost on protein — `
              : `On protein today — `;
          const lightOpts = protGap > 30
            ? `scrambled eggs + veg (highest protein-to-calorie), or ${opts.split(",")[0].trim()} and salad`
            : `keep it light: something lean and small`;
          dinnerSuggestion = `${name}, dinner time. ${protNote}${lightOpts}. What do you have at home?`;
        }
        await sendWhatsApp(phone, dinnerSuggestion);
        continue;
      }

      let msg: string;

      if (sick) {
        msg = `Rest up, ${name}. No targets today. Your data is saved — we pick up when you're better.`;
      } else {
        const score = (todayCal > 0 ? 1 : 0) + (workedOut ? 1 : 0) + (stepsDone ? 1 : 0);
        if (score === 3) {
          const highlight = protHit ? `${todayProt}g protein, session done, steps hit` : `session done, steps hit, food logged`;
          msg = `${name}, clean day — ${highlight}. Do it again tomorrow.`;
        } else if (workedOut && protHit) {
          msg = `${name}, session done and ${todayProt}g protein logged. ${stepCount > 0 ? `${stepCount.toLocaleString()} steps — push to ${stepsTarget.toLocaleString()} tomorrow.` : `Log your steps — walking is half the programme.`}`;
        } else if (workedOut && stepsDone) {
          msg = `${name}, session done and ${stepCount.toLocaleString()} steps. Log tonight's food so I can track your protein.`;
        } else if (workedOut) {
          msg = `${name}, session done. ${todayCal > 0 ? (calorieCeilingHit ? `${todayProt}g protein logged — calories done for today.` : `${todayProt}g protein logged — get to ${protTarget}g tonight.`) : `No food logged. Log tonight's meal.`}`;
        } else if (isTrainingDay) {
          const foodLine = todayCal > 0 ? ` Food's in.` : ``;
          const sessionMsg = `${name}, training day and the session is still not done.${foodLine} You've got tonight — what's the plan?`;
          if (await claimDailySlot(client.id, "evening")) {
            await sendWhatsAppButtons(phone, sessionMsg, [
              "Doing it tonight",
              "Swap to tomorrow",
              "Rest day today",
            ]);
          }
          continue;
        } else if (stepsDone) {
          const restStepNote = goal === "muscle_gain"
            ? `Good active recovery.`
            : `Steps are your calorie burn today — no gym, so these matter.`;
          msg = `${name}, ${stepCount.toLocaleString()} steps on a rest day. ${restStepNote} ${todayCal > 0 ? `${todayProt}g protein — ${protHit ? "target hit." : calorieCeilingHit ? "calories done for today." : `${protTarget - todayProt}g short of target.`}` : `Log tonight's food.`}`;
        } else if (todayCal > 0 || stepCount > 0) {
          const done = stepCount > 0 ? `${stepCount.toLocaleString()} steps` : `food logged`;
          const gap = stepCount < stepsTarget
            ? `${(stepsTarget - stepCount).toLocaleString()} steps short`
            : calorieCeilingHit
              ? `calories done for today — carry protein into tomorrow's first meal`
              : `protein at ${todayProt}g — get to ${protTarget}g`;
          msg = `${name}, ${done} today. ${gap}. One more thing before bed.`;
        } else {
          msg = `${name}, no logs yet today — no stress. Just send me your last meal before bed and we keep the momentum going.`;
        }
      }

      if (await claimDailySlot(client.id, "evening")) { await sendWhatsApp(phone, msg); }
    } catch (err) {
      console.error(`[SCHEDULER] Evening accountability error — ${client.phoneNumber}:`, err);
    }
  }
}

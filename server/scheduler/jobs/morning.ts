import {
  db, users, chatHistory, stepLogs, workoutLogs, mealLogs,
  eq, gte, and, lt, desc, sql,
  sendWhatsApp, canSendProactive, recordProactiveSend,
  getActiveClients, isPaused, dayStart, getYesterdayLogs,
  TRAINING_SCHEDULES, programmeDaysSince, wasSickOrInjured,
  todaySAST,
} from "../shared";
import { selectVariantMessage, recordDelivery } from "../../ab";
import { buildDayWorkout } from "../../programme";
import { sendWhatsAppButtons } from "../../twilio-interactive";

export async function runMorningCheckin(): Promise<void> {
  console.log("[SCHEDULER] JOB: Morning check-in");
  const todayDOW = new Date(Date.now() + 2 * 3_600_000).getDay(); // SAST = UTC+2
  if (todayDOW === 0) { console.log("[SCHEDULER] Morning check-in — skipping Sunday"); return; }

  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) {
      const notes = client.profileNotes || "";
      const pauseMatch = notes.match(/paused_until:(\d{4}-\d{2}-\d{2})/);
      if (pauseMatch) {
        const pauseEnd = new Date(pauseMatch[1]);
        const tomorrow = new Date(Date.now() + 86_400_000);
        const isTomorrowEnd = pauseEnd.toISOString().slice(0, 10) === tomorrow.toISOString().slice(0, 10);
        if (isTomorrowEnd && canSendProactive(client.id)) {
          const name = client.name?.split(" ")[0] || "there";
          await sendWhatsApp(client.phoneNumber, `${name}, your coaching pause ends tomorrow. Morning check-ins and workout reminders resume from tomorrow. Your programme is exactly where you left it — nothing resets.`);
          recordProactiveSend(client.id);
        }
      }
      continue;
    }

    const daysSilent = client.lastActiveAt
      ? Math.floor((Date.now() - new Date(client.lastActiveAt).getTime()) / 86_400_000)
      : 0;
    if (daysSilent > 7) continue;
    if (client.workSchedule === "night_shift") continue;

    if (daysSilent >= 3) {
      if (canSendProactive(client.id)) {
        const name = client.name || "there";
        const reEngageBody = `${name}, ${daysSilent} days. Life happens — no lecture from me.\n\nTell me which one fits right now:`;
        const reEngageButtons = [
          "I'm back, let's go",
          "I need a simpler plan",
          "Busy — check in next week",
        ];
        const comebBackMsg = `${reEngageBody}\n\n*1* — ${reEngageButtons[0]}\n*2* — ${reEngageButtons[1]}\n*3* — ${reEngageButtons[2]}\n\nOne reply is all I need.`;
        const { text: _variantMsg, assignmentId } = await selectVariantMessage(client.id, "re_engagement", comebBackMsg);
        await sendWhatsAppButtons(client.phoneNumber, reEngageBody, reEngageButtons);
        if (assignmentId !== null) await recordDelivery(assignmentId);
        await db.update(users).set({ awaitingInputType: "comeback" }).where(eq(users.id, client.id));
        recordProactiveSend(client.id, "comeback_rescue");
      }
      continue;
    }

    try {
      const name = client.name || "there";
      const phone = client.phoneNumber;
      const proteinTarget = client.proteinTarget || 120;
      const yesterdayLogs = await getYesterdayLogs(client.id);

      if (yesterdayLogs.length === 0) {
        if (canSendProactive(client.id)) {
          const sickYesterday = await wasSickOrInjured(client.id, dayStart(-1));
          if (sickYesterday) {
            await sendWhatsApp(phone, `Morning ${name}. Hope you're feeling better. When you're ready to get back on it, just say Hi.`);
            recordProactiveSend(client.id);
            continue;
          }
          const wStreak = client.workoutStreak || 0;
          const currentMonth = todaySAST().slice(0, 7);
          const shieldUsedMonth = (client.profileNotes || "").match(/streak_shield:(\d{4}-\d{2})/)?.[1];
          const shieldAvailable = wStreak >= 3 && shieldUsedMonth !== currentMonth;
          if (shieldAvailable) {
            const updatedNotes = (client.profileNotes || "").replace(/streak_shield:\d{4}-\d{2}/, "").trim() + ` streak_shield:${currentMonth}`;
            await db.update(users).set({ profileNotes: updatedNotes }).where(eq(users.id, client.id));
            await sendWhatsApp(phone, `Morning ${name}. Yesterday was a miss — but your *${wStreak}-session streak is protected* by your monthly shield.\n\nShield used. No more protection this month.\n\nLog today's session to keep the momentum going.`);
          } else {
            await sendWhatsApp(phone, `Morning ${name}. Nothing logged yesterday — I have nothing to coach from. Log your breakfast in the next hour. That is all.`);
          }
          recordProactiveSend(client.id);
        }
        continue;
      }

      const foodLogs = yesterdayLogs.filter(l => l.intent === "FOOD_LOG");
      const workoutLogged = yesterdayLogs.some(l => l.intent === "WORKOUT_LOG" || (l.messageIn || "").toLowerCase().trim() === "done");

      const yStart = dayStart(-1);
      const yEnd = dayStart(0);
      const ninetyDaysAgoSteps = new Date(Date.now() - 90 * 86_400_000);

      const [proteinRows, recentStepLogs, yesterdayStepRows] = await Promise.all([
        db.select({ totalProt: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int` })
          .from(mealLogs).where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, yStart), lt(mealLogs.loggedAt, yEnd)))
          .catch((_e: Error) => [{ totalProt: 0 }]),
        db.select({ loggedAt: stepLogs.loggedAt })
          .from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, ninetyDaysAgoSteps)))
          .orderBy(desc(stepLogs.loggedAt))
          .catch((_e: Error) => [] as { loggedAt: Date | null }[]),
        db.select({ steps: stepLogs.steps })
          .from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, yStart), lt(stepLogs.loggedAt, yEnd)))
          .catch((_e: Error) => [] as { steps: number | null }[]),
      ]);

      const totalProtLogged = (proteinRows as { totalProt: number }[])[0]?.totalProt || 0;
      const stepsLogged = (yesterdayStepRows as { steps: number | null }[]).reduce((s, r) => s + (r.steps || 0), 0);

      const DOW_OPENERS: Record<number, string> = {
        1: `New week. Clean slate.`,
        2: `Day 2. Consistency beats intensity.`,
        3: `Halfway through the week.`,
        4: `Body is adapting. Do not stop.`,
        5: `Friday. The weekend does not mean the plan stops.`,
        6: `Saturday. One session before tonight.`,
      };
      const dowOpener = DOW_OPENERS[todayDOW] ? ` ${DOW_OPENERS[todayDOW]}` : "";

      const progDays = programmeDaysSince(client.programmeStartDate);
      let identityLine = "";
      if (progDays === 7)  identityLine = " One week. You showed up every day this week.";
      else if (progDays === 14) identityLine = " Two weeks consistent. You're building something real.";
      else if (progDays === 21) identityLine = " Three weeks in. The habit is forming — your body knows the routine now.";
      else if (progDays === 30) identityLine = " A month. You are now the kind of person who trains for a month straight.";
      else if (progDays === 60) identityLine = " 60 days. Two months of showing up. That's rare.";
      else if (progDays === 90) identityLine = " 90 days. You are not the same person who started this.";

      const wStreak = client.workoutStreak || 0;
      let foodLogStreakCount = 0;
      {
        const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
        const recentFoodLogDays = await db.select({ createdAt: chatHistory.createdAt })
          .from(chatHistory)
          .where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, sixtyDaysAgo)))
          .orderBy(desc(chatHistory.createdAt))
          .catch(() => [] as { createdAt: Date | null }[]);
        const foodDays = new Set<string>();
        for (const l of recentFoodLogDays) {
          if (!l.createdAt) continue;
          const d = new Date(new Date(l.createdAt).getTime() + 2 * 3_600_000);
          foodDays.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`);
        }
        const foodCheck = new Date(Date.now() + 2 * 3_600_000);
        foodCheck.setUTCDate(foodCheck.getUTCDate() - 1);
        while (true) {
          const key = `${foodCheck.getUTCFullYear()}-${foodCheck.getUTCMonth()}-${foodCheck.getUTCDate()}`;
          if (!foodDays.has(key)) break;
          foodLogStreakCount++;
          foodCheck.setUTCDate(foodCheck.getUTCDate() - 1);
        }
      }
      let stepStreakCount = 0;
      {
        const stepDays = new Set<string>();
        for (const l of recentStepLogs as { loggedAt: Date | null }[]) {
          if (!l.loggedAt) continue;
          const d = new Date(new Date(l.loggedAt).getTime() + 2 * 3_600_000);
          stepDays.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`);
        }
        const stepCheck = new Date(Date.now() + 2 * 3_600_000);
        stepCheck.setUTCDate(stepCheck.getUTCDate() - 1);
        while (true) {
          const key = `${stepCheck.getUTCFullYear()}-${stepCheck.getUTCMonth()}-${stepCheck.getUTCDate()}`;
          if (!stepDays.has(key)) break;
          stepStreakCount++;
          stepCheck.setUTCDate(stepCheck.getUTCDate() - 1);
        }
      }

      const streakParts: string[] = [];
      if (wStreak >= 2) streakParts.push(`🔥 *${wStreak}-session streak*`);
      if (stepStreakCount >= 2) streakParts.push(`🚶 ${stepStreakCount}-day step streak`);
      if (foodLogStreakCount >= 3) streakParts.push(`🍽️ ${foodLogStreakCount}-day food streak`);
      const streakLine = streakParts.length ? ` ${streakParts.join(" · ")}.` : "";

      const sickYesterday = await wasSickOrInjured(client.id, dayStart(-1));
      const parts: string[] = [`Morning ${name}.${dowOpener}${identityLine}${streakLine}`];

      if (sickYesterday) {
        parts.push(`Hope you're feeling better. When you're ready, just say Hi and we pick up from where you left off.`);
        await sendWhatsApp(phone, parts.join(" "));
        recordProactiveSend(client.id);
        continue;
      }

      if (foodLogs.length === 0) {
        parts.push(`No food logged yesterday.`);
        parts.push(`You cannot out-train a diet you are not tracking.`);
      } else if (totalProtLogged >= proteinTarget * 0.9) {
        parts.push(`${totalProtLogged}g protein logged yesterday — target hit.`);
      } else if (totalProtLogged > 0) {
        const gap = proteinTarget - totalProtLogged;
        parts.push(`${totalProtLogged}g protein logged yesterday — ${gap}g short of your ${proteinTarget}g target.`);
        parts.push(gap > 50 ? `Add pilchards and eggs to every meal today.` : `One extra tin of pilchards or 2 eggs today closes that gap.`);
      } else {
        parts.push(`Food was logged but protein not tracked.`);
      }

      if (workoutLogged) {
        const totalW = client.totalWorkoutsCompleted || 0;
        const workoutMsg =
          totalW === 1  ? `First session in the books. That's the hardest one.` :
          totalW === 3  ? `Three sessions done. The habit is starting.` :
          totalW === 5  ? `Five sessions. You're past the point where most people quit.` :
          totalW === 10 ? `Ten sessions. You've made this a real part of your life.` :
          totalW === 25 ? `25 sessions. A quarter of a hundred. This is real now.` :
          totalW === 50 ? `50 sessions. Halfway to a hundred. You've earned every one.` :
          totalW === 100 ? `100 sessions. 💯 That's elite consistency.` :
          (totalW % 10 === 0 && totalW > 0) ? `${totalW} sessions. Keep that momentum.` :
          `Session done yesterday. Sharp.`;
        parts.push(workoutMsg);
      }

      if (stepsLogged > 0) {
        const stepsTarget = client.stepsTarget || 8500;
        parts.push(stepsLogged >= stepsTarget
          ? `Steps: ${stepsLogged.toLocaleString()} — target hit.`
          : `Steps: ${stepsLogged.toLocaleString()} of ${stepsTarget.toLocaleString()} target.`
        );
      }

      // One-tap repeat breakfast suggestion
      let repeatSuggestion = "";
      try {
        const weekAgo = new Date(Date.now() - 7 * 86_400_000);
        const recentFoods = await db.select({ messageIn: chatHistory.messageIn })
          .from(chatHistory)
          .where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, weekAgo)))
          .orderBy(desc(chatHistory.createdAt)).limit(14);
        const breakfastLog = recentFoods.find(l => l.messageIn && /\b(breakfast|morning|oats|eggs?|cereal|toast|bread)\b/i.test(l.messageIn));
        if (breakfastLog?.messageIn) {
          const meal = breakfastLog.messageIn.replace(/\b(for breakfast|breakfast was|this morning|had|ate|eating|having|i |my )\b/gi, "").trim();
          if (meal.length > 3 && meal.length < 60) {
            repeatSuggestion = `\n\n💡 Same breakfast as last time? Reply *"${meal.slice(0, 50)}"* to log it instantly.`;
          }
        }
      } catch { /* non-critical */ }

      const schedule = TRAINING_SCHEDULES[client.trainingDaysPerWeek || 4] || TRAINING_SCHEDULES[4];
      const isTodayTrainingDay = schedule.includes(todayDOW);
      const stepsTarget = client.stepsTarget || 10000;

      parts.push(`\n\n*Walking today: ${stepsTarget.toLocaleString()} steps.* Send a screenshot or tell me your count.`);

      if (isTodayTrainingDay) {
        try {
          const todayWorkout = buildDayWorkout(client);
          const previewLines = todayWorkout.split("\n").slice(0, 5).join("\n");
          parts.push(`\n*Today's workout (Day ${client.programmeDayInWeek || 1}):*\n${previewLines}\n\nReply *1* for the full workout.`);
        } catch {
          parts.push(`\nTraining day. Reply *1* for your workout.`);
        }
      } else {
        parts.push(`\nRest day — no training. Stay on food and steps.`);
      }

      parts.push(`\nWhat's for breakfast?`);
      if (repeatSuggestion) parts.push(repeatSuggestion);

      if (canSendProactive(client.id)) {
        await sendWhatsApp(phone, parts.join(" "));
        recordProactiveSend(client.id);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Morning check-in error — ${client.phoneNumber}:`, err);
    }
  }
}

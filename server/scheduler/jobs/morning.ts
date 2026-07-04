import {
  db, users, chatHistory, stepLogs, workoutLogs, mealLogs, exerciseLogs,
  eq, gte, and, lt, desc, sql, asc,
  sendWhatsApp, canSendProactive, recordProactiveSend, claimDailySlot,
  getActiveClients, isPaused, dayStart, getYesterdayLogs,
  TRAINING_SCHEDULES, programmeDaysSince, wasSickOrInjured,
  todaySAST,
} from "../shared";
import { proteinHint } from "../../utils";
import { selectVariantMessage, recordDelivery } from "../../ab";
import { sendWhatsAppButtons } from "../../twilio-interactive";

export async function runMorningCheckin(): Promise<void> {
  console.log("[SCHEDULER] JOB: Morning check-in");
  const todayDOW = new Date(Date.now() + 2 * 3_600_000).getDay(); // SAST = UTC+2
  void todayDOW; // Sunday check removed — clients need morning coaching 7 days a week
  const yesterdayDOW = (todayDOW - 1 + 7) % 7;

  const clients = await getActiveClients();

  for (const client of clients) {
    if (isPaused(client)) {
      const notes = client.profileNotes || "";
      const pauseMatch = notes.match(/paused_until:(\d{4}-\d{2}-\d{2})/);
      if (pauseMatch) {
        const pauseEnd = new Date(pauseMatch[1]);
        const tomorrow = new Date(Date.now() + 86_400_000);
        const isTomorrowEnd = pauseEnd.toISOString().slice(0, 10) === tomorrow.toISOString().slice(0, 10);
        if (isTomorrowEnd && await claimDailySlot(client.id, "morning")) {
          const name = client.name?.split(" ")[0] || "there";
          await sendWhatsApp(client.phoneNumber, `${name}, your coaching pause ends tomorrow. Morning check-ins and workout reminders resume from tomorrow. Your programme is exactly where you left it — nothing resets.`);
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
      if (client.awaitingInputType !== "comeback" && await claimDailySlot(client.id, "morning")) {
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
      }
      continue;
    }

    try {
      const name = client.name || "there";
      const phone = client.phoneNumber;
      const proteinTarget = client.proteinTarget || 120;
      const yesterdayLogs = await getYesterdayLogs(client.id);

      if (yesterdayLogs.length === 0) {
        if (await claimDailySlot(client.id, "morning")) {
          const sickYesterday = await wasSickOrInjured(client.id, dayStart(-1));
          if (sickYesterday) {
            await sendWhatsApp(phone, `Morning ${name}. Hope you're feeling better. When you're ready to get back on it, just say Hi.`);
            continue;
          }
          const wStreak = client.workoutStreak || 0;
          const currentMonth = todaySAST().slice(0, 7);
          const shieldUsedMonth = (client.profileNotes || "").match(/streak_shield:(\d{4}-\d{2})/)?.[1];
          const clientSchedule = TRAINING_SCHEDULES[client.trainingDaysPerWeek || 4] || TRAINING_SCHEDULES[4];
          const wasYesterdayTrainingDay = clientSchedule.includes(yesterdayDOW);
          const shieldAvailable = wasYesterdayTrainingDay && wStreak >= 3 && shieldUsedMonth !== currentMonth;
          if (shieldAvailable) {
            const updatedNotes = (client.profileNotes || "").replace(/streak_shield:\d{4}-\d{2}/, "").trim() + ` streak_shield:${currentMonth}`;
            await db.update(users).set({ profileNotes: updatedNotes }).where(eq(users.id, client.id));
            await sendWhatsApp(phone, `Morning ${name}. Good news — your *${wStreak}-session streak is safe*, your monthly shield's got yesterday covered.\n\nLog today's session and keep the momentum going. 💪`);
          } else {
            await sendWhatsApp(phone, `Morning ${name}. Send me your breakfast right now — one line is all I need. We start from here.`);
          }
        }
        continue;
      }

      const foodLogs = yesterdayLogs.filter(l => l.intent === "FOOD_LOG");
      const workoutLogged = yesterdayLogs.some(l => l.intent === "WORKOUT_LOG" || (l.messageIn || "").toLowerCase().trim() === "done");

      const yStart = dayStart(-1);
      const yEnd = dayStart(0);
      const ninetyDaysAgoSteps = new Date(Date.now() - 90 * 86_400_000);

      const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);
      const twentyEightDaysAgo = new Date(Date.now() - 28 * 86_400_000);
      const [proteinRows, recentStepLogs, yesterdayStepRows, mealSlotRows, monthWorkoutRows, exerciseLogRows] = await Promise.all([
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
        db.select({
          mealLabel: mealLogs.mealLabel,
          avgProt: sql<number>`AVG(${mealLogs.proteinInt})::int`,
          logCount: sql<number>`COUNT(*)::int`,
        })
          .from(mealLogs)
          .where(and(eq(mealLogs.userId, client.id), gte(mealLogs.loggedAt, fourteenDaysAgo)))
          .groupBy(mealLogs.mealLabel)
          .catch(() => [] as { mealLabel: string | null; avgProt: number; logCount: number }[]),
        db.select({ count: sql<number>`COUNT(*)::int` })
          .from(workoutLogs)
          .where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, twentyEightDaysAgo)))
          .catch(() => [{ count: 0 }]),
        db.select({
          exerciseName: exerciseLogs.exerciseName,
          weightKg: exerciseLogs.weightKg,
          loggedAt: exerciseLogs.loggedAt,
        }).from(exerciseLogs)
          .where(and(eq(exerciseLogs.userId, client.id), gte(exerciseLogs.loggedAt, fourteenDaysAgo)))
          .orderBy(asc(exerciseLogs.loggedAt))
          .catch(() => [] as { exerciseName: string; weightKg: string | null; loggedAt: Date | null }[]),
      ]);

      const totalProtLogged = (proteinRows as { totalProt: number }[])[0]?.totalProt || 0;
      const stepsLogged = (yesterdayStepRows as { steps: number | null }[]).reduce((s, r) => s + (r.steps || 0), 0);

      const schedule = TRAINING_SCHEDULES[client.trainingDaysPerWeek || 4] || TRAINING_SCHEDULES[4];
      const isTodayTrainingDay = schedule.includes(todayDOW);

      const DOW_OPENERS: Record<number, string> = {
        1: `New week. Clean slate.`,
        2: `Day 2. Consistency beats intensity.`,
        3: `Halfway through the week.`,
        4: `Body is adapting. Do not stop.`,
        5: `Friday. Finish the week strong — the weekend plan starts tonight.`,
        // Saturday: only mention training if today is actually a training day
        6: isTodayTrainingDay ? `Saturday. One session before tonight.` : `Saturday. Rest day — food and steps.`,
      };
      const dowOpener = DOW_OPENERS[todayDOW] ? ` ${DOW_OPENERS[todayDOW]}` : "";

      const progDays = programmeDaysSince(client.programmeStartDate);
      let identityLine = "";
      // DOMS coaching for new clients — soreness on day 2-3 is the #1 early dropout trigger
      if (progDays === 2 && (client.workoutStreak || 0) >= 1) identityLine = " Day 2. Muscles sore? That is the repair happening — it means the session worked. Keep going.";
      else if (progDays === 3 && (client.workoutStreak || 0) >= 1) identityLine = " Day 3. Soreness passing? That is your body adapting. That feeling goes away — the strength stays.";
      else if (progDays === 7)  identityLine = " One week. You showed up every day this week.";
      else if (progDays === 14) identityLine = " Two weeks consistent. You're building something real.";
      else if (progDays === 21) identityLine = ` Week 3. This is where most people quit — not because it got too hard, but because the mirror hasn't changed yet. The change is happening in your muscle tissue and metabolism. It is not visible yet but it is real. Do not stop now.`;
      else if (progDays === 30) identityLine = " A month. You are now the kind of person who trains for a month straight.";
      else if (progDays === 42) identityLine = ` Week 6. This is when visible results start showing. Look closer — your clothes, your posture, your strength. The scale is the last thing to reflect it. The change is already there.`;
      else if (progDays === 60) identityLine = " 60 days. Two months of showing up. That's rare.";
      else if (progDays === 63) identityLine = ` Week 9. The plateau phase. Most people misread this as failure — it is not. Your body is consolidating the changes from the first 8 weeks before the next wave of results. Hold the habits. The breakthrough comes at week 10-12 for those who do not stop here.`;
      else if (progDays === 84) identityLine = ` Week 12. Three months in. Your body has rewritten its baseline — every habit that feels automatic now used to be a deliberate choice. You are in the top 10% of people who start a programme. This is who you are now.`;
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
          foodDays.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
        }
        const foodCheck = new Date(Date.now() + 2 * 3_600_000);
        foodCheck.setUTCDate(foodCheck.getUTCDate() - 1);
        while (true) {
          const key = `${foodCheck.getUTCFullYear()}-${String(foodCheck.getUTCMonth() + 1).padStart(2, "0")}-${String(foodCheck.getUTCDate()).padStart(2, "0")}`;
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
          stepDays.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
        }
        const stepCheck = new Date(Date.now() + 2 * 3_600_000);
        stepCheck.setUTCDate(stepCheck.getUTCDate() - 1);
        while (true) {
          const key = `${stepCheck.getUTCFullYear()}-${String(stepCheck.getUTCMonth() + 1).padStart(2, "0")}-${String(stepCheck.getUTCDate()).padStart(2, "0")}`;
          if (!stepDays.has(key)) break;
          stepStreakCount++;
          stepCheck.setUTCDate(stepCheck.getUTCDate() - 1);
        }
      }

      // ── Trajectory classification (28-day compliance) ──────────────────────
      const completedSessions28 = (monthWorkoutRows as { count: number }[])[0]?.count || 0;
      const plannedSessions28 = (client.trainingDaysPerWeek || 3) * 4;
      const sessionCompliance28 = plannedSessions28 > 0 ? completedSessions28 / plannedSessions28 : 0;
      type Trajectory = "ON_A_RUN" | "ON_TRACK" | "RECOVERING" | "STRUGGLING" | "DISENGAGED";
      const trajectory: Trajectory =
        sessionCompliance28 >= 0.8 && wStreak >= 4 ? "ON_A_RUN" :
        sessionCompliance28 >= 0.65              ? "ON_TRACK" :
        sessionCompliance28 >= 0.4 && wStreak >= 1 ? "RECOVERING" :
        completedSessions28 === 0                ? "DISENGAGED" :
                                                   "STRUGGLING";

      // ── Loss-framed streak line ─────────────────────────────────────────────
      // Positive framing for short streaks, loss framing for meaningful ones
      const streakParts: string[] = [];
      if (wStreak >= 10) {
        streakParts.push(
          trajectory === "ON_A_RUN" || trajectory === "ON_TRACK"
            ? `🔥 *${wStreak}-session streak* — keep it going`
            : `🔥 *${wStreak}-session streak* — you have built real momentum here`
        );
      } else if (wStreak >= 5) {
        streakParts.push(`🔥 *${wStreak}-session streak* — protect it`);
      } else if (wStreak >= 2) {
        streakParts.push(`🔥 *${wStreak}-session streak*`);
      }
      if (stepStreakCount >= 5) {
        streakParts.push(`🚶 *${stepStreakCount}-day step streak* — keep it alive`);
      } else if (stepStreakCount >= 2) {
        streakParts.push(`🚶 ${stepStreakCount}-day step streak`);
      }
      // Only claim a food streak when yesterday actually had food — otherwise the
      // "No food logged yesterday" line below contradicts it ("5-day food streak" +
      // "No food logged yesterday" was a real screenshot).
      if (foodLogStreakCount >= 3 && foodLogs.length > 0) streakParts.push(`🍽️ ${foodLogStreakCount}-day food streak`);
      const streakLine = streakParts.length ? ` ${streakParts.join(" · ")}.` : "";

      // ── Trajectory-aware DOW opener override ───────────────────────────────
      const trajectoryPrefix: Partial<Record<Trajectory, string>> = {
        ON_A_RUN:   `You're on the best run you've been on.`,
        STRUGGLING: `Today is the reset.`,
        DISENGAGED: `Today is the day we change this.`,
      };
      const trajPrefix = trajectoryPrefix[trajectory] ? ` ${trajectoryPrefix[trajectory]}` : "";

      const sickYesterday = await wasSickOrInjured(client.id, dayStart(-1));
      const parts: string[] = [`Morning ${name}.${dowOpener}${trajPrefix}${identityLine}${streakLine}`];

      if (sickYesterday) {
        parts.push(`Hope you're feeling better. When you're ready, just say Hi and we pick up from where you left off.`);
        if (await claimDailySlot(client.id, "morning")) { await sendWhatsApp(phone, parts.join(" ")); }
        continue;
      }

      if (foodLogs.length === 0) {
        parts.push(`No food logged yesterday — today starts now. Breakfast first.`);
      } else if (totalProtLogged >= proteinTarget * 0.9) {
        parts.push(`${totalProtLogged}g protein logged yesterday — target hit.`);
      } else if (totalProtLogged > 0) {
        const gap = proteinTarget - totalProtLogged;
        parts.push(`${totalProtLogged}g protein logged yesterday — ${gap}g short of your ${proteinTarget}g target.`);

        // Identify the chronically weakest meal slot from 14-day data
        const MAIN_SLOTS = ["breakfast", "lunch", "dinner"];
        const _cn = (client.profileNotes || "").toLowerCase();
        const _isVegan = _cn.includes("diet:vegan");
        const _isVeg = _cn.includes("diet:vegetarian") || _isVegan;
        const SLOT_FIX: Record<string, string> = {
          breakfast: _isVegan
            ? `Tomorrow: lead breakfast with soya yoghurt or ½ cup oats + peanut butter before anything else.`
            : `Tomorrow: lead breakfast with 3 eggs or 200g Greek yoghurt before anything else.`,
          lunch: _isVegan
            ? `Today: anchor lunch with tofu, lentils, or sugar beans — before adding rice or bread.`
            : _isVeg
            ? `Today: anchor lunch with eggs, cottage cheese, or beans — before adding rice or bread.`
            : `Today: anchor lunch with chicken, tuna, or eggs — before adding rice or bread.`,
          dinner: _isVegan
            ? `Tonight: lead dinner with soya mince, lentils, or tofu before anything else.`
            : _isVeg
            ? `Tonight: lead dinner with eggs, cottage cheese, or beans before anything else.`
            : `Tonight: lead dinner with 200g chicken, fish, or eggs before anything else.`,
        };
        const qualifyingSlots = (mealSlotRows as { mealLabel: string | null; avgProt: number; logCount: number }[])
          .filter(r => r.mealLabel && MAIN_SLOTS.includes(r.mealLabel) && r.logCount >= 3);
        const worstSlot = qualifyingSlots.length >= 2
          ? qualifyingSlots.reduce((min, r) => r.avgProt < min.avgProt ? r : min)
          : null;
        if (worstSlot?.mealLabel && SLOT_FIX[worstSlot.mealLabel]) {
          parts.push(`Your ${worstSlot.mealLabel}s average only ${worstSlot.avgProt}g protein — that's the gap. ${SLOT_FIX[worstSlot.mealLabel]}`);
        } else {
          parts.push(proteinHint(client, gap));
        }
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

      // Progressive overload hint — only surfaces after a workout, when 3+ sessions at same weight detected
      if (workoutLogged) {
        try {
          const lifts = exerciseLogRows as { exerciseName: string; weightKg: string | null; loggedAt: Date | null }[];
          const byExercise = new Map<string, { date: string; maxKg: number }[]>();
          for (const r of lifts) {
            if (!r.weightKg || !r.exerciseName) continue;
            const kg = parseFloat(String(r.weightKg));
            if (!isFinite(kg) || kg <= 0) continue;
            const d = r.loggedAt ? new Date(new Date(r.loggedAt).getTime() + 2 * 3_600_000).toISOString().slice(0, 10) : "";
            if (!d) continue;
            const key = r.exerciseName.toLowerCase().trim();
            const sessions = byExercise.get(key) || [];
            const existing = sessions.find(s => s.date === d);
            if (existing) { existing.maxKg = Math.max(existing.maxKg, kg); }
            else { sessions.push({ date: d, maxKg: kg }); byExercise.set(key, sessions); }
          }
          for (const [exName, sessions] of byExercise.entries()) {
            if (sessions.length < 3) continue;
            const sorted = sessions.sort((a, b) => a.date.localeCompare(b.date));
            const last3 = sorted.slice(-3);
            if (last3.every(s => s.maxKg === last3[0].maxKg)) {
              const display = exName.replace(/\b\w/g, c => c.toUpperCase());
              parts.push(`💡 *${display}*: ${last3[0].maxKg}kg for ${sorted.length >= 4 ? "4+" : "3"} sessions in a row — add 2.5kg next session.`);
              break;
            }
          }
        } catch { /* non-critical */ }
      }

      // One-tap repeat breakfast suggestion
      let repeatSuggestion = "";
      try {
        const weekAgo = new Date(Date.now() - 7 * 86_400_000);
        const recentFoods = await db.select({ messageIn: chatHistory.messageIn })
          .from(chatHistory)
          .where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, weekAgo)))
          .orderBy(desc(chatHistory.createdAt)).limit(14);
        const MEAL_CORRECTION_RE = /\b(has?\s+no\b|have\s+no\b|there.?s\s+no\b|without\b|didn.?t\s+(?:add|put|use|have|spread)\b|no\s+\w+\s+(?:on|in)\b|not\s+have\b)\b/i;
        const breakfastLog = recentFoods.find(l =>
          !!l.messageIn &&
          /\b(breakfast|morning|oats|eggs?|cereal|toast|bread)\b/i.test(l.messageIn) &&
          !MEAL_CORRECTION_RE.test(l.messageIn)
        );
        if (breakfastLog?.messageIn) {
          const meal = breakfastLog.messageIn.replace(/\b(for breakfast|breakfast was|this morning|had|ate|eating|having|i |my )\b/gi, "").trim();
          if (meal.length > 3 && meal.length < 60) {
            repeatSuggestion = `\n\n💡 Same breakfast as last time? Reply *"${meal.slice(0, 50)}"* to log it instantly.`;
          }
        }
      } catch { /* non-critical */ }

      const stepsTarget = client.stepsTarget || 8500;

      // Split into two messages: summary | today's action
      // \n\n---\n\n is the Twilio message splitter — two separate WhatsApps
      const todaySection: string[] = [];
      todaySection.push(`*Today:*`);
      todaySection.push(`👟 ${stepsTarget.toLocaleString()} steps — your phone counts them (health app). Send tonight's number or a screenshot; a weekly-average screenshot works too.`);

      if (isTodayTrainingDay) {
        // No inline "preview" — slicing the first 4 lines of the workout only ever
        // showed the header + warm-up cut off mid-sentence with "...". The full
        // workout is one reply away and renders properly there.
        todaySection.push(`💪 Training day. Reply *1* for your workout.`);
      } else {
        todaySection.push(`🛌 Rest day. No training — stay on food and steps.`);
      }

      // Trajectory-aware closing line — replaces generic "send me your meals" with context-driven push
      const trajectoryClose: Record<Trajectory, string> = {
        ON_A_RUN:   `\n\n_You're ${completedSessions28} sessions in over 4 weeks. Don't give this up — most people are nowhere near this._`,
        ON_TRACK:   ``,
        RECOVERING: `\n\n_Good to have you back. One day at a time — this week counts._`,
        STRUGGLING: `\n\n_${completedSessions28} sessions in 4 weeks. The number needs to change. Start today._`,
        DISENGAGED: `\n\n_No sessions in 28 days. Today is not about intensity — just reply Hi and we go from there._`,
      };
      const closingLine = trajectoryClose[trajectory] || "";
      if (closingLine) todaySection.push(closingLine);

      if (await claimDailySlot(client.id, "morning")) {
        // Three bubbles: summary | today's targets | the one question we want answered.
        const breakfastAsk = `🍳 What's for breakfast?${repeatSuggestion || ""}`;
        const fullMessage = parts.join(" ") + "\n\n---\n\n" + todaySection.join("\n") + "\n\n---\n\n" + breakfastAsk;
        await sendWhatsApp(phone, fullMessage);
      }
    } catch (err) {
      console.error(`[SCHEDULER] Morning check-in error — ${client.phoneNumber}:`, err);
    }
  }
}

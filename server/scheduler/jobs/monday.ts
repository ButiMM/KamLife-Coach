import { calorieFloor } from "../../targets";
import {
  db, users, chatHistory, stepLogs, workoutLogs, weightLogs,
  eq, gte, lt, and, desc, asc, count, sql,
  canSendProactive, claimProactive,
  getActiveClients, isPaused,
  todaySAST, thisWeekUTC, isProactivePaused,
} from "../shared";
import { getGoalProfile } from "../../goal-profiles";
import { getProgressTruth } from "../../day-ledger";
import { mentionsForbidden } from "../../brain/reply-verifier";
import { sendProactive } from "../proactive-decision";

export async function runWeightReminder(): Promise<void> {
  console.log("[SCHEDULER] Running weight check-in reminder...");
  if (isProactivePaused()) { console.log("[SCHEDULER:PAUSED] runWeightReminder blocked"); return; }
  // EVERY Monday is weigh-in day (2026-07-17 founder: "they should be sending scale
  // waves every single Monday"). The old 7-day skip broke the ritual — a Wednesday
  // weigh-in silenced the next Monday. Only a FRESH number (last 36h, i.e. Sunday
  // morning onward) earns a pass; the weekly rhythm is the point.
  const thirtySixHoursAgo = new Date(Date.now() - 36 * 3600_000);
  const threeDaysAgo = new Date(Date.now() - 3 * 86400_000);
  const activeClients = await db.select().from(users)
    .where(and(eq(users.onboardingState, "COMPLETE"), gte(users.lastActiveAt, threeDaysAgo)));
  let sent = 0;
  for (const client of activeClients) {
    // THE WHOLE JOB IS THE THING THEY ASKED US TO DROP (2026-08-19, Cut 9). Cut 8 bound
    // do_not_mention to the reactive mouth and to the decision; this send passes through
    // neither. There is no paragraph to strip here — a weigh-in reminder IS the scale — so the
    // honest binding is to stand down for this client, exactly as chooseAction does.
    if (mentionsForbidden("weight scale weigh", (client as any).doNotMention)) {
      console.log(`[MONDAY] ...${client.id.slice(-6)} — weigh-in reminder withheld, they asked`);
      continue;
    }
    const [recent] = await db.select({ c: count() }).from(weightLogs).where(and(eq(weightLogs.userId, client.id), gte(weightLogs.loggedAt, thirtySixHoursAgo)));
    if ((recent.c || 0) > 0) continue;
    const name = client.name?.split(" ")[0] || "there";
    const [lastWeightRow] = await db.select({ weight: weightLogs.weight }).from(weightLogs).where(eq(weightLogs.userId, client.id)).orderBy(desc(weightLogs.loggedAt)).limit(1).catch(() => [] as { weight: string | null }[]);
    const lastWeightHint = lastWeightRow?.weight
      ? `Last week: ${parseFloat(lastWeightRow.weight).toFixed(1)}kg — what's today's number?`
      : `Send me the number (e.g. 75.3kg)`;
    const msg = `${name}, weigh-in day. ⚖️\n\nStep on the scale first thing — after toilet, before food, same conditions every time.\n\n${lastWeightHint}\n\nThe scale is data, not judgment. Track it so we can coach from facts, not feelings.`;
    // Once per week per client — DB-backed so a container recycle can't re-send.
    if (await sendProactive(client, { job: "weight_reminder", window: thisWeekUTC() }, msg)) sent++;
  }
  console.log(`[SCHEDULER] Weight reminders sent: ${sent}`);
}

export async function runMondayProgress(): Promise<void> {
  console.log("[SCHEDULER] Running Monday progress summary...");
  const clients = await getActiveClients();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
  let sent = 0;

  for (const client of clients) {
    if (isPaused(client)) continue;
    if (client.lastActiveAt && new Date(client.lastActiveAt) < threeDaysAgo) continue;
    if (!canSendProactive(client.id)) continue;
    try {
      const name = client.name?.split(" ")[0] || "there";
      const [wk] = await db.select({ c: count() }).from(workoutLogs).where(and(eq(workoutLogs.userId, client.id), gte(workoutLogs.loggedAt, sevenDaysAgo)));
      const [fl] = await db.select({ c: count() }).from(chatHistory).where(and(eq(chatHistory.userId, client.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, sevenDaysAgo)));
      const [sl] = await db.select({ c: count() }).from(stepLogs).where(and(eq(stepLogs.userId, client.id), gte(stepLogs.loggedAt, sevenDaysAgo)));
      const workouts = wk.c || 0;
      const foodLogs = fl.c || 0;
      const stepDays = sl.c || 0;
      // THE CANONICAL WEIGHT OWNER, NOT A SECOND READER (#216). This queried weight_logs directly
      // and took the newest TWO rows, which made this surface disagree with every other one in
      // three separate ways: it could not see an adequate week (two rows a day apart read as
      // `too_short` while a real 17-day trend sat one row further back), it never asked
      // getProgressTruth and so never honoured `doNotMention` — a client who asked us to drop the
      // scale was sent "⚖️ Down 1.5kg this week" unprompted, on a Monday — and the pace projection
      // below ran off the same raw rows with no verdict at all.
      //
      // A fourteen-day read, because the verdict owner already enforces what counts: at least
      // MIN_TREND_SPAN_DAYS of span and a newest reading no older than MAX_TREND_AGE_DAYS. Handing
      // it the window and letting it judge is the point; a row limit chosen here is this job
      // deciding what a trend is, which is exactly the second opinion #216 forbids.
      const weightTruth = await getProgressTruth(client, { days: 14, weightWindowDays: 14 });
      const weights = [...weightTruth.weight.points].reverse()
        .map((pt: { kg: number; at: Date }) => ({ weight: pt.kg, loggedAt: pt.at }));
      const firstWeightLog = await db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt }).from(weightLogs).where(eq(weightLogs.userId, client.id)).orderBy(asc(weightLogs.loggedAt)).limit(1);

      if (workouts === 0 && foodLogs === 0 && stepDays === 0) continue;

      const lines: string[] = [`*${name}, your week:*`];
      if (workouts >= 3) lines.push(`💪 ${workouts} workouts — that is consistency. ${client.totalWorkoutsCompleted || 0} total sessions.`);
      else if (workouts > 0) lines.push(`💪 ${workouts} workout${workouts > 1 ? "s" : ""} done. Target: ${client.trainingDaysPerWeek || 3} per week.`);
      if (foodLogs >= 10) lines.push(`🍽️ ${foodLogs} meals tracked — you are logging consistently.`);
      else if (foodLogs > 0) lines.push(`🍽️ ${foodLogs} meals logged. More logging = better coaching from me.`);
      if (stepDays >= 4) lines.push(`🚶 Steps logged ${stepDays} days — keep the movement up.`);

      // THE PROACTIVE MOUTH ASKS TOO (#128). Three surfaces consulted weightDirectionSpeakable
      // and this one asserted "Down 1.2kg this week. Moving in the right direction." off two rows
      // with no gate at all — sent unprompted, on a Monday, to a client the reactive doors would
      // have refused. A client ill last week is exactly the one this reaches: they are not here to
      // ask, so nothing else stands between the claim and their phone.
      const { weightDirectionSpeakable } = await import("../../adaptive-targets");
      const weekSpeech = await weightDirectionSpeakable(
        weightTruth.weight.points.map((pt: { at: Date }) => ({ at: pt.at })), client,
      ).catch(() => ({ speakable: false }));
      if (weights.length >= 2 && weekSpeech.speakable) {
        const diff = Number(weights[0].weight) - Number(weights[1].weight);
        const goal = client.goalType || "fat_loss";
        const mostRecentKg = Number(weights[0].weight);
        const startKg = firstWeightLog.length > 0 ? Number(firstWeightLog[0].weight) : null;
        const totalDiff = startKg !== null ? mostRecentKg - startKg : null;
        if (diff < -0.3 && (goal === "fat_loss" || goal === "recomp")) {
          const allTimeNote = totalDiff !== null && totalDiff < -1.5 ? ` (${Math.abs(totalDiff).toFixed(1)}kg total since you started)` : "";
          lines.push(`⚖️ Down ${Math.abs(diff).toFixed(1)}kg this week.${allTimeNote} Moving in the right direction.`);
        } else if (diff > 0.3 && goal === "muscle_gain") {
          lines.push(`⚖️ Up ${diff.toFixed(1)}kg — good for muscle gain. Track lifts to confirm strength is going up.`);
        } else if (diff > 0.5 && goal === "fat_loss") {
          lines.push(`⚖️ Up ${diff.toFixed(1)}kg this week — could be water or sodium from the weekend. Stay on programme and weigh again Wednesday.`);
        }
      }

      // GOAL ARRIVAL SPEAKS UNDER THE SAME VERDICT AS THE LINE ABOVE IT (#216).
      //
      // "At this pace" is a weight-derived conclusion like any other, and it sat OUTSIDE the gate:
      // a client whose weekly direction was refused for illness still read
      //
      //     🎯 At this pace: *78kg in ~5 weeks* — around *October 2026*.
      //
      // in the same message the ⚖️ line had just been withheld from. One surface, two verdicts,
      // and the louder one was the projection. It is also the claim that most deserves the gate:
      // a pace computed across an illness is the least trustworthy number this job can produce.
      const targetKg = client.targetWeightKg ? Number(client.targetWeightKg) : null;
      if (targetKg && weekSpeech.speakable && firstWeightLog.length > 0 && weights.length >= 1) {
        const currentKg = Number(weights[0].weight);
        const startKg = Number(firstWeightLog[0].weight);
        const startDate = firstWeightLog[0].loggedAt;
        if (startDate && Math.abs(currentKg - startKg) >= 0.3) {
          const weeksSinceStart = Math.max(2, (Date.now() - new Date(startDate).getTime()) / (7 * 86_400_000));
          const pacePerWeek = (currentKg - startKg) / weeksSinceStart;
          const remaining = targetKg - currentKg;
          const movingCorrectly = (remaining < 0 && pacePerWeek < 0) || (remaining > 0 && pacePerWeek > 0);
          if (movingCorrectly && Math.abs(pacePerWeek) >= 0.05) {
            const weeksToGoal = Math.ceil(Math.abs(remaining) / Math.abs(pacePerWeek));
            if (weeksToGoal >= 1 && weeksToGoal <= 52) {
              const arrivalDate = new Date(Date.now() + weeksToGoal * 7 * 86_400_000);
              const arrivalMonth = arrivalDate.toLocaleString("en-ZA", { month: "long", year: "numeric" });
              lines.push(`🎯 At this pace: *${targetKg}kg in ~${weeksToGoal} week${weeksToGoal !== 1 ? "s" : ""}* — around *${arrivalMonth}*.`);
            }
          }
        }
      }

      // Claim the daily slot atomically before sending (DB-backed, restart-safe).
      if (await sendProactive(client, { job: "monday_progress" }, lines.join("\n"))) sent++;
    } catch { continue; }
  }
  console.log(`[SCHEDULER] Monday progress summaries sent: ${sent}`);
}

export async function runDietBreakCheck(): Promise<void> {
  // THE TARGET COMES BACK EVEN WHEN NO MESSAGE CAN GO. This job was never scheduled, and nothing else
  // restores the pre-break target (the target audit tolerates the +300 kcal a break adds), so a client
  // who took a diet break stayed at maintenance for good. The restore is data, so neither the
  // killswitch nor the one-a-day slot may hold it; only the notice goes through the one sender.
  try {
    const expired = await db.select().from(users).where(
      and(
        eq(users.onboardingState, "COMPLETE"),
        lt(users.dietBreakEndsAt, new Date()),
        sql`diet_break_ends_at IS NOT NULL`,
        sql`diet_break_cal_target IS NOT NULL`
      )
    );
    for (const client of expired) {
      const restored = Math.max(calorieFloor(client), client.dietBreakCalTarget!);
      // Atomic: only the run that clears the break announces it, so a recycle can't double-fire.
      const done = await db.update(users).set({ calorieTarget: restored, dietBreakEndsAt: null, dietBreakCalTarget: null })
        .where(and(eq(users.id, client.id), sql`diet_break_cal_target IS NOT NULL`)).returning({ id: users.id });
      if (!done.length) continue;
      // OPERATIONAL (#180): the target change is the message; what to do about it is canonicalNextMove's.
      const name = (client.name || "").split(" ")[0] || "there";
      await sendProactive(client, { job: "diet_break_end", window: todaySAST() }, `${name}, diet break is done. Back to the deficit.\n\n*Your targets from today:*\n• Calories: ${restored} kcal/day\n• Protein: ${client.proteinTarget || 120}g/day — unchanged\n\nYour metabolism is reset. Your glycogen is full.`).catch((e: unknown) => console.error("[monday] diet-break notice failed:", client.id, e));
    }
    if (expired.length > 0) console.log(`[SCHEDULER] Diet break expired: ${expired.length} clients restored`);
  } catch (err) { console.error("[SCHEDULER] Diet break check error:", err); }
}


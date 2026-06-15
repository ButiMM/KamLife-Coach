/**
 * Progress check handler — 7-day summary with shareable wins card.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { stepLogs, workoutLogs, weightLogs, mealLogs } from "../../shared/schema";
import { eq, and, gte, asc, desc, sql } from "drizzle-orm";
import { calculateTargets } from "../targets";
import { computeProgressScore, renderProgressScore } from "../progress-score";
import { logChat } from "./chat-log";

export async function handleProgressCheck(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
}): Promise<string | null> {
  const { message, m, user } = ctx;

  if (!(
    m.includes("how am i doing") || m.includes("my progress") || m.includes("am i on track") ||
    m.includes("how have i done") || m.includes("check my progress") ||
    m === "this week" || m === "week" || m === "week summary" || m === "my week" ||
    m === "weekly summary" || m === "6" || m === "weekly report" || m === "report" ||
    m.includes("how was my week") || m.includes("this weeks progress")
  )) {
    return null;
  }

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
    const [recentSteps, recentWorkouts, recentWeights, weekFoodRows] = await Promise.all([
      db.select().from(stepLogs).where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sevenDaysAgo))).orderBy(desc(stepLogs.loggedAt)),
      db.select().from(workoutLogs).where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, sevenDaysAgo))),
      db.select().from(weightLogs).where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, sevenDaysAgo))).orderBy(asc(weightLogs.loggedAt)),
      db.select({
        totalProt: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
        logDays: sql<number>`COUNT(DISTINCT DATE(${mealLogs.loggedAt}))::int`,
      }).from(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, sevenDaysAgo))),
    ]);
    const liveT = calculateTargets(parseFloat(user.currentWeight || "75"), user.goalType || "fat_loss", user.lifeSituation || "office", user.trainingDaysPerWeek || 3);
    const plannedSessions = user.trainingDaysPerWeek || 3;
    const completedSessions = recentWorkouts.length;
    const avgSteps = recentSteps.length > 0 ? Math.round(recentSteps.reduce((s, r) => s + r.steps, 0) / recentSteps.length) : 0;
    const stepsTarget = user.stepsTarget || 8500;
    const latestWeight = recentWeights.length >= 1
      ? parseFloat(String(recentWeights[recentWeights.length - 1].weight))
      : null;
    const weightChange = recentWeights.length >= 2
      ? (parseFloat(String(recentWeights[recentWeights.length - 1].weight)) - parseFloat(String(recentWeights[0].weight))).toFixed(1)
      : null;
    const weekFoodLogDays = (weekFoodRows as { totalProt: number; logDays: number }[])[0]?.logDays || 0;
    const weekTotalProt = (weekFoodRows as { totalProt: number; logDays: number }[])[0]?.totalProt || 0;
    const avgDailyProt = weekFoodLogDays > 0 ? Math.round(weekTotalProt / weekFoodLogDays) : 0;
    const protTarget = user.proteinTarget || 120;
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
    const fn = user.name || "Hey";
    const stepsAboveTarget = avgSteps >= stepsTarget;
    const sessionSentence = completedSessions === plannedSessions
      ? `Training: ${completedSessions}/${plannedSessions} sessions — full week. ✅`
      : completedSessions === 0
        ? `Training: 0 of ${plannedSessions} planned sessions done this week.`
        : `Training: ${completedSessions} of ${plannedSessions} planned sessions done this week.`;
    const stepSentence = avgSteps > 0
      ? stepsAboveTarget
        ? `Steps: averaging ${avgSteps.toLocaleString()}/day ✅ — above your ${stepsTarget.toLocaleString()} target.`
        : `Steps: averaging ${avgSteps.toLocaleString()} per day against a ${stepsTarget.toLocaleString()} target.`
      : `Steps: no step logs this week — start logging daily.`;
    const weightSentence = weightChange !== null
      ? parseFloat(weightChange) < 0
        ? `Weight: down ${Math.abs(parseFloat(weightChange))}kg this week — moving in the right direction.`
        : parseFloat(weightChange) > 0
          ? `Weight: up ${weightChange}kg — could be water, sodium, or muscle. Stay on programme.`
          : `Weight: holding steady this week.`
      : latestWeight !== null
        ? `Weight: ${latestWeight}kg logged — keep weighing in daily to track your trend.`
        : `Weight: no weigh-ins this week — step on the scale and send me the number.`;
    const foodSentence = weekFoodLogDays > 0
      ? `Food: logged ${weekFoodLogDays}/7 days — avg ${avgDailyProt}g protein/day${avgDailyProt >= protTarget * 0.9 ? " ✅" : ` (target ${protTarget}g — ${protTarget - avgDailyProt}g gap)`}`
      : `Food: no meals logged this week — consistency here is what drives results.`;
    const onTrack = completedSessions >= Math.ceil(plannedSessions * 0.75);
    const missedCount = plannedSessions - completedSessions;
    const verdictSentence = onTrack
      ? pick([
          `${fn}, you're on track — carry this into next week.`,
          `Overall on track. Same energy next week.`,
          `Solid week. Keep this consistency going.`,
          `${fn}, this is what on-track looks like. Repeat it next week.`,
        ])
      : pick([
          `${fn}, ${missedCount} session${missedCount > 1 ? "s" : ""} missed this week. Get the next one done today.`,
          `${missedCount} session${missedCount > 1 ? "s" : ""} didn't happen, ${fn}. Today is the reset — do the next one.`,
          `Behind by ${missedCount}${missedCount > 1 ? " sessions" : " session"}, ${fn}. Stop the bleed today — one session changes the week.`,
          `${fn}, ${missedCount} session${missedCount > 1 ? "s" : ""} short. No recapping — get today's done and move on.`,
        ]);
    // KamLife Progress Score — beyond-the-scale composite, from values already computed
    // above (no extra queries). Surfaced so a flat scale never reads as failure.
    const score = computeProgressScore({
      completedSessions,
      plannedSessions,
      avgDailyProtein: avgDailyProt,
      proteinTarget: protTarget,
      avgSteps,
      stepsTarget,
      foodLogDays: weekFoodLogDays,
      weightLogCount: recentWeights.length,
      weightChangeKg: weightChange !== null ? parseFloat(weightChange) : null,
      goalType: user.goalType || "fat_loss",
    });
    const scoreBlock = renderProgressScore(score);

    const progressReply = `*Your 7-Day Progress Check*\n\n${scoreBlock}\n\n${sessionSentence}\n${stepSentence}\n${weightSentence}\n${foodSentence}\n${verdictSentence}`;

    // ---- COACHING ANALYSIS — the ONE thing to fix next week ----
    // A 7-day summary is useful. A 7-day summary that names the single biggest
    // gap AND gives a concrete action is coaching. The data is already computed —
    // this function interprets it so the client doesn't have to.
    function coachingInsight(): string {
      const trainingPct = plannedSessions > 0 ? completedSessions / plannedSessions : 1;
      const proteinPct = avgDailyProt > 0 ? avgDailyProt / protTarget : 0;
      const stepsPct = avgSteps > 0 ? avgSteps / stepsTarget : 0;
      const fn = user.name?.split(" ")[0] || "";

      // Priority: no training > no logging > protein gap > steps gap
      if (completedSessions === 0 && plannedSessions > 0) {
        return `*Fix this week:* No sessions logged — not one. Everything gets easier once you're training: sleep, hunger, protein choices. Reply *1* right now and do today's workout. 20 minutes changes the week.`;
      }
      if (weekFoodLogDays < 3) {
        return `*Fix this week:* Log your food. ${weekFoodLogDays}/7 days isn't enough for me to see where the problem is. I cannot coach what I cannot see. Start tonight: just log dinner, even if it wasn't perfect.`;
      }
      if (avgDailyProt > 0 && proteinPct < 0.75) {
        const gap = protTarget - avgDailyProt;
        return `*Fix this week:* Protein — you averaged ${avgDailyProt}g but need ${protTarget}g. That ${gap}g daily gap is muscle you're not protecting. Add protein at every meal: 3 eggs (+18g), tin of tuna (+25g), 150g chicken (+35g). Pick one per meal and close the gap.`;
      }
      if (trainingPct < 0.5) {
        const missed = plannedSessions - completedSessions;
        return `*Fix this week:* Training. ${missed} session${missed > 1 ? "s" : ""} missed — that's not enough training stimulus to drive results. Do the next session today. Not tomorrow. Today.`;
      }
      if (avgSteps > 0 && stepsPct < 0.7) {
        const stepGap = stepsTarget - avgSteps;
        return `*Fix this week:* Steps — ${avgSteps.toLocaleString()} avg vs ${stepsTarget.toLocaleString()} target. Fix: 20-minute walk after dinner every day. That alone adds ~2,000 steps and accelerates fat loss more than most people realise.`;
      }
      return fn
        ? `${fn}, solid week across all areas. This week's focus: push training intensity — more weight on the bar or more reps than last time. Results come from progressive overload, not just showing up.`
        : `Solid week across all areas. This week: push the intensity — more weight or more reps than last session.`;
    }
    const insight = coachingInsight();
    const fullProgressReply = `${progressReply}\n\n${insight}`;

    let winsCard = "";
    if (onTrack) {
      const clientDisplayName = user.name || "KamLife";
      const totalWorkoutsAll = user.totalWorkoutsCompleted || completedSessions;
      const weekNum = user.programmeWeek || 1;
      const weightLine = weightChange !== null && parseFloat(weightChange) < 0
        ? `⬇️ Weight: -${Math.abs(parseFloat(weightChange))}kg this week`
        : weightChange !== null && parseFloat(weightChange) === 0
          ? `⚖️ Weight: holding steady`
          : latestWeight !== null
            ? `⚖️ Weight: ${latestWeight}kg`
            : "";
      const stepsLine = avgSteps >= stepsTarget
        ? `👟 Steps: ${avgSteps.toLocaleString()} avg/day ✅`
        : avgSteps > 0 ? `👟 Steps: ${avgSteps.toLocaleString()} avg/day` : "";
      const workoutLine = `💪 Sessions: ${completedSessions}/${plannedSessions} ✅`;
      const streakLine = user.workoutStreak >= 5 ? `🔥 Streak: ${user.workoutStreak} sessions straight` : "";
      const totalLine = `📊 Total sessions with Coach K: ${totalWorkoutsAll}`;
      const winsLines = [workoutLine, stepsLine, weightLine, streakLine, totalLine].filter(Boolean).join("\n");
      const refLine = user.referralCode ? `\n\nYour referral code: *${user.referralCode}* — they get month 1 for R50, you get R50 credit.` : "";
      winsCard = `\n\n---\n\n*Week ${weekNum} — ${clientDisplayName}*\n${winsLines}\n\n_KamLife Coach — R199/month_${refLine}\n\nShare this with someone who needs to start. 💪`;
    }

    const fullReply = `${fullProgressReply}${winsCard}`;
    await logChat(user.id, message, fullReply, "PROGRESS_CHECK");
    return fullReply;
  } catch (e) {
    console.error("[PROGRESS CHECK]", e);
    return null;
  }
}

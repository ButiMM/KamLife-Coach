/**
 * Progress check handler — 7-day summary with shareable wins card.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { stepLogs, workoutLogs, weightLogs, mealLogs } from "../../shared/schema";
import { eq, and, gte, asc, desc, sql } from "drizzle-orm";
import { calculateTargets } from "../targets";
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
    const weightChange = recentWeights.length >= 2
      ? (parseFloat(String(recentWeights[recentWeights.length - 1].weight)) - parseFloat(String(recentWeights[0].weight))).toFixed(1)
      : null;
    const weekFoodLogDays = (weekFoodRows as { totalProt: number; logDays: number }[])[0]?.logDays || 0;
    const weekTotalProt = (weekFoodRows as { totalProt: number; logDays: number }[])[0]?.totalProt || 0;
    const avgDailyProt = weekFoodLogDays > 0 ? Math.round(weekTotalProt / 7) : 0;
    const protTarget = user.proteinTarget || 120;
    const sessionSentence = `Training: ${completedSessions} of ${plannedSessions} planned sessions done this week.`;
    const stepSentence = avgSteps > 0 ? `Steps: averaging ${avgSteps.toLocaleString()} per day against a ${stepsTarget.toLocaleString()} target.` : `Steps: no step logs this week — start logging daily.`;
    const weightSentence = weightChange !== null ? (parseFloat(weightChange) < 0 ? `Weight: down ${Math.abs(parseFloat(weightChange))}kg this week — moving in the right direction.` : parseFloat(weightChange) > 0 ? `Weight: up ${weightChange}kg — could be water, sodium, or muscle. Stay on programme.` : `Weight: holding steady this week.`) : `Weight: no weigh-ins logged — step on the scale and send me the number.`;
    const foodSentence = weekFoodLogDays > 0
      ? `Food: logged ${weekFoodLogDays}/7 days — avg ${avgDailyProt}g protein/day${avgDailyProt >= protTarget * 0.9 ? " ✅" : ` (target ${protTarget}g — ${protTarget - avgDailyProt}g gap)`}`
      : `Food: no meals logged this week — consistency here is what drives results.`;
    const onTrack = completedSessions >= Math.ceil(plannedSessions * 0.75);
    const verdictSentence = onTrack ? `Overall you are on track — keep the consistency going into next week.` : `${user.name || "Hey"}, ${plannedSessions - completedSessions} sessions missed this week. Get the next one done today.`;
    const progressReply = `*Your 7-Day Progress Check*\n\n${sessionSentence}\n${stepSentence}\n${weightSentence}\n${foodSentence}\n${verdictSentence}`;

    let winsCard = "";
    if (onTrack) {
      const clientDisplayName = user.name || "KamLife";
      const totalWorkoutsAll = user.totalWorkoutsCompleted || completedSessions;
      const weekNum = user.programmeWeek || 1;
      const weightLine = weightChange !== null && parseFloat(weightChange) < 0
        ? `⬇️ Weight: -${Math.abs(parseFloat(weightChange))}kg this week`
        : weightChange !== null && parseFloat(weightChange) === 0
          ? `⚖️ Weight: holding steady`
          : "";
      const stepsLine = avgSteps >= stepsTarget
        ? `👟 Steps: ${avgSteps.toLocaleString()} avg/day ✅`
        : avgSteps > 0 ? `👟 Steps: ${avgSteps.toLocaleString()} avg/day` : "";
      const workoutLine = `💪 Sessions: ${completedSessions}/${plannedSessions} ✅`;
      const streakLine = user.workoutStreak >= 5 ? `🔥 Streak: ${user.workoutStreak} sessions straight` : "";
      const totalLine = `📊 Total sessions with Coach K: ${totalWorkoutsAll}`;
      const winsLines = [workoutLine, stepsLine, weightLine, streakLine, totalLine].filter(Boolean).join("\n");
      const refLine = user.referralCode ? `\n\nYour referral code: *${user.referralCode}* — they get month 1 for R50, you get R50 credit.` : "";
      winsCard = `\n\n---\n\n*Week ${weekNum} — ${clientDisplayName}*\n${winsLines}\n\n_KamLife Coach — R149/month_${refLine}\n\nShare this with someone who needs to start. 💪`;
    }

    const fullReply = `${progressReply}${winsCard}`;
    await logChat(user.id, message, fullReply, "PROGRESS_CHECK");
    return fullReply;
  } catch (e) {
    console.error("[PROGRESS CHECK]", e);
    return null;
  }
}

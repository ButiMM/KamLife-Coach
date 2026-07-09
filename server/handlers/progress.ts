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
import { weeklyTrendSlopeKg } from "./weight";

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
    // Use regression slope rather than oldest-to-newest 2-point delta so a single
    // spike reading can't flip the reported direction. If not enough data for
    // regression, fall back to the direct delta.
    const weightPoints = recentWeights.map(r => ({
      dayOffset: Math.round(
        (new Date(r.loggedAt!).getTime() - new Date(recentWeights[0].loggedAt!).getTime()) / 86_400_000,
      ),
      kg: parseFloat(String(r.weight)),
    }));
    const regressionSlope = weeklyTrendSlopeKg(weightPoints);
    const weightChange = regressionSlope !== null
      ? regressionSlope.toFixed(1)
      : recentWeights.length >= 2
        ? (parseFloat(String(recentWeights[recentWeights.length - 1].weight)) - parseFloat(String(recentWeights[0].weight))).toFixed(1)
        : null;
    const weekFoodLogDays = (weekFoodRows as { totalProt: number; logDays: number }[])[0]?.logDays || 0;
    const weekTotalProt = (weekFoodRows as { totalProt: number; logDays: number }[])[0]?.totalProt || 0;
    const avgDailyProt = weekFoodLogDays > 0 ? Math.round(weekTotalProt / weekFoodLogDays) : 0;
    const protTarget = user.proteinTarget || 120;
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
    const fn = user.name || "Hey";
    const goal = (user.goalType || "fat_loss").toLowerCase();
    const isMuscleGain = goal === "muscle_gain";
    const isRecomp = goal === "recomposition";
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
    const weightChangeNum = weightChange !== null ? parseFloat(weightChange) : null;
    const weightSentence = weightChangeNum !== null
      ? weightChangeNum < 0
        ? isMuscleGain
          ? `Weight: down ${Math.abs(weightChangeNum)}kg this week — check your food. You should be eating a bit more than you burn, not losing.`
          : isRecomp
          ? `Weight: down ${Math.abs(weightChangeNum)}kg — fat is dropping. Keep the training going to protect the muscle.`
          : `Weight: down ${Math.abs(weightChangeNum)}kg this week — moving in the right direction.`
        : weightChangeNum > 0
          ? isMuscleGain
            ? `Weight: up ${weightChange}kg this week — good. That's the direction you're building in.`
            : isRecomp
            ? `Weight: up ${weightChange}kg — small increases can be muscle gain (good). Large increases suggest excess calories. Check food.`
            : `Weight: up ${weightChange}kg — could be water, sodium, or muscle. Stay on programme.`
          : isMuscleGain
            ? `Weight: holding steady — aim for a slow upward trend (0.2–0.4kg/week) to keep building.`
            : isRecomp
            ? `Weight: holding steady — this is normal and expected for recomp. Your body is trading fat for muscle at the same time. Track how your clothes fit and what you see in the mirror — that's the real data.`
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
        return isMuscleGain
          ? `*Fix this week:* Zero sessions — no stimulus means zero growth regardless of what you eat. Calories without training = fat, not muscle. Reply *1* right now. Do today's session.`
          : `*Fix this week:* No sessions logged — not one. Everything gets easier once you're training: sleep, hunger, protein choices. Reply *1* right now and do today's workout. 20 minutes changes the week.`;
      }
      if (weekFoodLogDays < 3) {
        return `*Fix this week:* Log your food — even just dinner each night gives me enough to actually help. Right now I've only got ${weekFoodLogDays}/7 days, so let's start tonight, even if the meal wasn't perfect.`;
      }
      if (avgDailyProt > 0 && proteinPct < 0.75) {
        const gap = protTarget - avgDailyProt;
        return isMuscleGain
          ? `*Fix this week:* Protein — you averaged ${avgDailyProt}g but need ${protTarget}g. That ${gap}g daily gap is muscle you're literally not building. No substitute for protein. Add it every meal: 3 eggs (+18g), tin of tuna (+25g), 150g chicken (+35g). No exceptions.`
          : `*Fix this week:* Protein — you averaged ${avgDailyProt}g but need ${protTarget}g. That ${gap}g daily gap is muscle you're not protecting. Add protein at every meal: 3 eggs (+18g), tin of tuna (+25g), 150g chicken (+35g). Pick one per meal and close the gap.`;
      }
      if (trainingPct < 0.5) {
        const missed = plannedSessions - completedSessions;
        return isRecomp
          ? `*Fix this week:* Training. ${missed} session${missed > 1 ? "s" : ""} missed — the training is what holds onto your muscle. Without it, eating less than you burn just strips muscle along with the fat, and you lose the whole point. Do the next session today.`
          : `*Fix this week:* Training. ${missed} session${missed > 1 ? "s" : ""} missed — that's not enough${isMuscleGain ? " training to build muscle" : " training to drive fat loss"}. Do the next session today. Not tomorrow. Today.`;
      }
      if (avgSteps > 0 && stepsPct < 0.7) {
        return isRecomp
          ? `*Fix this week:* Steps — ${avgSteps.toLocaleString()} avg vs ${stepsTarget.toLocaleString()} target. Walking keeps you burning through the day while training builds the muscle. Both are needed. 20-minute walk after dinner adds ~2,000 steps.`
          : isMuscleGain
          ? `*Fix this week:* Steps — ${avgSteps.toLocaleString()} avg vs ${stepsTarget.toLocaleString()} target. Not about burning — just stay active for recovery and health. 20-minute walk after dinner is enough.`
          : `*Fix this week:* Steps — ${avgSteps.toLocaleString()} avg vs ${stepsTarget.toLocaleString()} target. Fix: 20-minute walk after dinner every day. That adds ~2,000 steps and closes the calorie gap your food started.`;
      }
      return isRecomp
        ? fn
          ? `${fn}, solid week. The recomp formula — and it's the only one: Walking + Lifting + Protein + Sleep. You ran it this week. The scale may not move much but look at your clothes and your strength. That's where recomp shows first.`
          : `Solid week. The recomp formula: Walking + Lifting + Protein + Sleep. Run that consistently and body composition shifts — even when the scale stays flat.`
        : isMuscleGain
        ? fn
          ? `${fn}, solid week. This week: push the weight on every lift — add a plate or squeeze one more rep. Adding a bit more each time is the only way muscle grows. No plateau, always progress.`
          : `Solid week. Push harder in every session — more weight or more reps. Adding a little more each time is how muscle gets built.`
        : fn
          ? `${fn}, solid week across all areas. This week's focus: push training intensity — more weight on the bar or more reps than last time. Results come from adding a bit more each time, not just showing up.`
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

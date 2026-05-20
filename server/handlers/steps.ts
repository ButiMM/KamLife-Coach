import { db } from "../db";
import { stepLogs } from "../../shared/schema";
import { eq, desc } from "drizzle-orm";

export async function getStepStreak(userId: string): Promise<number> {
  try {
    const logs = await db.select({ loggedAt: stepLogs.loggedAt })
      .from(stepLogs).where(eq(stepLogs.userId, userId))
      .orderBy(desc(stepLogs.loggedAt)).limit(90);
    if (logs.length === 0) return 0;
    const days = new Set<string>();
    for (const log of logs) {
      const d = new Date(new Date(log.loggedAt!).getTime() + 2 * 3_600_000);
      days.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
    }
    let streak = 0;
    const checkDate = new Date(Date.now() + 2 * 3_600_000);
    const todayKey = `${checkDate.getUTCFullYear()}-${String(checkDate.getUTCMonth() + 1).padStart(2, "0")}-${String(checkDate.getUTCDate()).padStart(2, "0")}`;
    if (!days.has(todayKey)) checkDate.setUTCDate(checkDate.getUTCDate() - 1);
    while (true) {
      const key = `${checkDate.getUTCFullYear()}-${String(checkDate.getUTCMonth() + 1).padStart(2, "0")}-${String(checkDate.getUTCDate()).padStart(2, "0")}`;
      if (!days.has(key)) break;
      streak++;
      checkDate.setUTCDate(checkDate.getUTCDate() - 1);
    }
    return streak;
  } catch { return 0; }
}

const STEP_RESPONSES_LOW = [
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps logged — you are ${remaining.toLocaleString()} short of your ${target.toLocaleString()} target. Walk to the shop, take the stairs, park further. Close that gap before bed.`,
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps today. ${remaining.toLocaleString()} more will hit your target. A 15-minute walk is about 1,500 steps — go.`,
  (steps: number, remaining: number, target: number) =>
    `Short day — ${steps.toLocaleString()} steps. Your target is ${target.toLocaleString()}. Set a reminder for an evening walk and hit it before you sleep.`,
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps is a start, not a finish. ${remaining.toLocaleString()} to go. Walk while you talk on the phone. Use every gap.`,
  (steps: number, remaining: number, target: number) =>
    `${steps.toLocaleString()} steps logged. Target: ${target.toLocaleString()}. You are ${Math.round((steps / target) * 100)}% there — finish the job tonight.`,
];

const STEP_RESPONSES_GOOD = [
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — almost there. ${(target - steps).toLocaleString()} more to hit target. You are close, do not let it go.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps is solid progress. ${(target - steps).toLocaleString()} away from your ${target.toLocaleString()} target — one more walk and you have it.`,
  (steps: number, target: number) =>
    `Nearly at target — ${steps.toLocaleString()} steps done. Finish line is ${(target - steps).toLocaleString()} steps away. You have come too far not to finish.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — ${Math.round((steps / target) * 100)}% of your target. ${(target - steps).toLocaleString()} steps left. A 10-minute walk finishes this off.`,
  (steps: number, target: number) =>
    `Good movement today — ${steps.toLocaleString()} steps. ${(target - steps).toLocaleString()} more to reach ${target.toLocaleString()}. Walk around the block before bed and it is yours.`,
];

const STEP_RESPONSES_TARGET = [
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — target hit. ✅ This daily discipline is what separates results from excuses. Same again tomorrow.`,
  (steps: number, target: number) =>
    `Target crushed — ${steps.toLocaleString()} steps. ✅ Every step counts toward your fat loss. Do not skip tomorrow.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps done. ✅ Above target and earning it. Your body is changing because you are consistent — keep it up.`,
  (steps: number, target: number) =>
    `${steps.toLocaleString()} steps — you smashed the ${target.toLocaleString()} target. ✅ Lekker. Same energy tomorrow.`,
  (steps: number, target: number) =>
    `Target done — ${steps.toLocaleString()} steps. ✅ This is what consistency looks like. Log tomorrow and keep the streak going.`,
];

// Real-world equivalents to make calories concrete
function _stepEquivalent(burnKcal: number): string {
  if (burnKcal >= 300) return `That's a slice of pizza burned off.`;
  if (burnKcal >= 200) return `That's a Coke and a half burned off.`;
  if (burnKcal >= 120) return `That's a bag of chips burned off.`;
  if (burnKcal >= 60)  return `That's a Bar One burned off.`;
  return "";
}

export function getStepResponse(steps: number, target: number, weightKg = 75, streak = 0): string {
  const idx = Math.floor(Date.now() / 86400000) % 5;
  const burnEst = Math.round(steps * 0.04 * (weightKg / 70));
  const burnNote = steps >= 3000 ? ` (~${burnEst} kcal burned)` : "";
  const equivalent = steps >= target ? _stepEquivalent(burnEst) : "";

  let base: string;
  if (steps >= target) {
    base = STEP_RESPONSES_TARGET[idx % STEP_RESPONSES_TARGET.length](steps, target);
  } else if (steps >= target * 0.75) {
    base = STEP_RESPONSES_GOOD[idx % STEP_RESPONSES_GOOD.length](steps, target);
  } else {
    const remaining = target - steps;
    base = STEP_RESPONSES_LOW[idx % STEP_RESPONSES_LOW.length](steps, remaining, target);
  }

  // Insert burn note after first sentence
  const firstDot = base.indexOf(".");
  let response = (firstDot > 0 && burnNote)
    ? base.slice(0, firstDot + 1) + burnNote + base.slice(firstDot + 1)
    : base + burnNote;

  // Add equivalent note
  if (equivalent) response += ` ${equivalent}`;

  // Step streak celebration
  if (streak >= 7) {
    response += `\n\n🔥 *${streak}-day step streak.* ${streak >= 14 ? "Two weeks of movement. This is a habit now." : "A full week of steps. Don't break it."}`;
  } else if (streak >= 3 && steps >= target) {
    response += `\n\n🔥 ${streak} days in a row hitting target. Keep the streak alive.`;
  }

  return response;
}

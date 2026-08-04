import { db } from "../db";
import { stepLogs } from "../../shared/schema";
import { eq, desc, and, gte, lt } from "drizzle-orm";
import { neverSilentLine } from "../reply-hygiene";
import { educationNote } from "../education";
import { stepBurnKcal } from "../targets";
import { sastDayStart } from "../utils";

/**
 * STRUCTURED STEP WRITE (2026-07-19) — the executor's reuse point, mirroring the routes.ts
 * inline upsert exactly: one row per SAST day, keep the HIGHER count (clients re-log a
 * growing daily total) unless it's an explicit correction. Additive — routes keeps its
 * own path; this is a clean callable for the action executor. Returns the day's count.
 */
export async function logStepsForUser(userId: string, steps: number, opts?: { correction?: boolean; at?: Date }): Promise<number> {
  const at = opts?.at || new Date();
  const dayStart = sastDayStart(at);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const existing = await db.select({ id: stepLogs.id, steps: stepLogs.steps })
    .from(stepLogs)
    .where(and(eq(stepLogs.userId, userId), gte(stepLogs.loggedAt, dayStart), lt(stepLogs.loggedAt, dayEnd)))
    .limit(1);
  if (existing.length > 0) {
    if (steps > (existing[0].steps ?? 0) || opts?.correction) {
      await db.update(stepLogs).set({ steps }).where(eq(stepLogs.id, existing[0].id));
      return steps;
    }
    return existing[0].steps ?? steps;
  }
  await db.insert(stepLogs).values({ userId, steps, loggedAt: at });
  return steps;
}

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
    `${steps.toLocaleString()} steps logged — you are ${remaining.toLocaleString()} short of your ${target.toLocaleString()} target. A 15-minute walk before bed, or taking the stairs, closes most of that gap.`,
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
    `${steps.toLocaleString()} steps — target hit. ✅ That daily consistency is exactly what drives results. Same again tomorrow.`,
  (steps: number, target: number) =>
    `Target crushed — ${steps.toLocaleString()} steps. ✅ Every step counts toward your goal. Keep the rhythm going tomorrow.`,
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

export function getStepResponse(steps: number, target: number, weightKg = 75, streak = 0, weeklyAvg?: number, user?: any, isWorkoutDay = false): string {
  // DELETED 2026-08-04 (Slice 4). What stood here built, for every step log, forever: a random
  // pick from three response banks, an invented "~237 kcal burned", a "that's a Coke and a half"
  // equivalence, a goal note, a 7-day average, a streak note and an education note. Six sentences
  // and four numbers the client never said, written by a handler wearing the coach's voice.
  //
  // The coach writes the sentence now. This is the never-silent net for the turn the engine did
  // not answer — one line, their number, nothing else. The parameters stay because callers pass
  // them and the signature is not the point; the VOICE was the point, and it has one owner.
  void target; void weightKg; void streak; void weeklyAvg; void user; void isWorkoutDay;
  return neverSilentLine("steps", { amount: steps.toLocaleString("en-ZA") });
}

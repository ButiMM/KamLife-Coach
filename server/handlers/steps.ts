import { db } from "../db";
import { stepLogs } from "../../shared/schema";
import { eq, desc, and, gte, lt } from "drizzle-orm";
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
  if (!target || target <= 0) target = 8500;
  const idx = Math.floor(Math.random() * 5);
  const burnEst = stepBurnKcal(steps, weightKg);
  const burnNote = steps >= 3000 ? ` (~${burnEst} kcal burned)` : "";
  const equivalent = steps >= 4000 ? _stepEquivalent(burnEst) : "";

  // Resolve goal context from user record — drives messaging tone
  const goalRaw = ((user?.goalType as string) || "fat_loss").toLowerCase();
  const goalContext: "fat_loss" | "muscle_gain" | "recomp" =
    goalRaw === "muscle_gain" ? "muscle_gain"
    : (goalRaw === "fat_loss" || goalRaw === "weight_loss") ? "fat_loss"
    : "recomp";

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

  if (equivalent) response += ` ${equivalent}`;

  // ONE add-on per reply (2026-07-10 friction audit): this used to stack goal note +
  // 7-day average + streak + education in one bubble. The count and the 7-day average
  // are DATA and stay; then ONE note rides along — celebration beats coaching beats
  // teaching (streak > goal note > education).
  let goalNote = "";
  if (steps >= 2000) {
    if (goalContext === "fat_loss") {
      goalNote = isWorkoutDay
        ? `\n\n_Gym session already burned. These steps add to it — you're burning even more than your food already saves._`
        : `\n\n_Your food + these steps mean you're burning more than you eat today. That's the weight coming off._`;
    } else if (goalContext === "muscle_gain") {
      goalNote = isWorkoutDay
        ? `\n\n_Session done. Light movement for recovery — that's all you need. Keep eating enough to build._`
        : `\n\n_Movement for health, not to burn. Your food is doing the building work._`;
    }
  }

  // 7-day average context — within ~3% of target is ON target for coaching purposes.
  if (weeklyAvg && weeklyAvg > 0) {
    const nearTargetBand = Math.max(300, Math.round(target * 0.03));
    const vsTarget = weeklyAvg >= target
      ? `above target — keep it up.`
      : (target - weeklyAvg) <= nearTargetBand
        ? `that's your ${target.toLocaleString()} target hit, day in day out. This consistency is what changes bodies.`
        : `${(target - weeklyAvg).toLocaleString()} below your ${target.toLocaleString()} target.`;
    response += `\n\n_7-day average: ${weeklyAvg.toLocaleString()} steps — ${vsTarget}_`;
  }

  let streakNote = "";
  if (streak >= 7) {
    streakNote = `\n\n🔥 *${streak}-day step streak.* ${streak >= 14 ? "Two weeks of movement. This is a habit now." : "A full week of steps. Don't break it."}`;
  } else if (streak >= 3 && steps >= target) {
    streakNote = `\n\n🔥 ${streak} days in a row hitting target. Keep the streak alive.`;
  }

  const eduNoteSteps = user ? educationNote(user, { event: "steps", burnKcal: burnEst }) : "";
  const stepsAddOn = [streakNote, goalNote, eduNoteSteps].find(s => s && s.trim()) || "";

  return `${response}${stepsAddOn}`;
}

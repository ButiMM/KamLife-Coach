/**
 * ADAPTIVE TARGETS — the daily job that actually MOVES a client's numbers.
 *
 * (2026-07-27) The adaptive engine was written and tested but not wired, which is the exact
 * failure the founder called out: built, not integrated. This is the wiring. It runs each
 * morning BEFORE the morning check-in so the day's message already reflects today's real
 * targets.
 *
 * It reads the client's actual state (sick marker, 14-day weight trend, 7-day step average,
 * weeks stalled), asks the pure engine what today's targets should be, PERSISTS them, and
 * sends ONE plain line only when something changed. Silence is the default — a target that
 * moves every day is noise.
 */

import { db, users, weightLogs, stepLogs, eq, and, gte, desc, sql, getActiveClients, sendWhatsApp, saveState, todaySAST, hasRunToday } from "../shared";
import { adaptTargets, type AdaptiveInput } from "../../adaptive-targets";

/** Weeks of no meaningful weight movement (<0.3kg swing) from a series, newest first. */
function stalledWeeksFrom(weights: number[]): number {
  if (weights.length < 3) return 0;
  const newest = weights[0];
  let weeks = 0;
  for (const w of weights.slice(1)) {
    if (Math.abs(newest - w) < 0.3) weeks++;
    else break;
  }
  return weeks;
}

export async function runAdaptiveTargets(): Promise<void> {
  const today = todaySAST();
  if (hasRunToday("adaptive_targets", today)) return;

  const clients = await getActiveClients();
  let moved = 0;
  for (const c of clients) {
    try {
      const notes = String(c.profileNotes || "");
      const sickUntil = notes.match(/sick_until:(\d{4}-\d{2}-\d{2})/)?.[1];
      const sickSince = notes.match(/sick_since:(\d{4}-\d{2}-\d{2})/)?.[1];
      const sick = !!sickUntil && new Date(sickUntil) >= new Date(today);
      const daysSick = sickSince ? Math.floor((Date.now() - new Date(sickSince).getTime()) / 86_400_000) : 0;
      // Recovering = the sick window closed within the last 3 days.
      const recovering = !sick && !!sickUntil
        && (Date.now() - new Date(sickUntil).getTime()) / 86_400_000 <= 3;

      // 28 days of weigh-ins, newest first — enough for a trend and a stall read.
      const wRows = await db.select({ w: weightLogs.weight, at: weightLogs.loggedAt })
        .from(weightLogs)
        .where(and(eq(weightLogs.userId, c.id), gte(weightLogs.loggedAt, new Date(Date.now() - 28 * 86_400_000))))
        .orderBy(desc(weightLogs.loggedAt)).limit(12);
      const weights = wRows.map(r => parseFloat(String(r.w))).filter(n => Number.isFinite(n));
      let weeklyKgChange: number | undefined;
      if (weights.length >= 2) {
        const spanDays = Math.max(1, (new Date(wRows[0].at as Date).getTime() - new Date(wRows[wRows.length - 1].at as Date).getTime()) / 86_400_000);
        if (spanDays >= 5) weeklyKgChange = ((weights[0] - weights[weights.length - 1]) / spanDays) * 7;
      }

      const [stepAgg] = await db.select({ avg: sql<number>`COALESCE(AVG(${stepLogs.steps}),0)::int` })
        .from(stepLogs)
        .where(and(eq(stepLogs.userId, c.id), gte(stepLogs.loggedAt, new Date(Date.now() - 7 * 86_400_000))));
      const avgSteps7d = Number(stepAgg?.avg || 0) || undefined;

      const input: AdaptiveInput = {
        baseCalories: Number(c.calorieTarget) || 0,
        baseProtein: Number(c.proteinTarget) || 0,
        baseSteps: Number(c.stepsTarget) || 0,
        goalType: c.goalType || "fat_loss",
        weightKg: parseFloat(String(c.currentWeight || "")) || 75,
        sick, daysSick, recovering, weeklyKgChange,
        stalledWeeks: stalledWeeksFrom(weights),
        avgSteps7d,
      };
      if (!(input.baseCalories > 0 && input.baseProtein > 0)) continue; // no baseline yet

      const out = adaptTargets(input);
      if (!out.changed) continue;
      // Nothing actually different from what they already hold → stay silent.
      if (out.calorieTarget === input.baseCalories && out.proteinTarget === input.baseProtein
          && out.stepsTarget === input.baseSteps) continue;

      await db.update(users).set({
        calorieTarget: out.calorieTarget,
        proteinTarget: out.proteinTarget,
        stepsTarget: out.stepsTarget,
      }).where(eq(users.id, c.id));

      if (out.note) {
        await sendWhatsApp(c.phoneNumber, `🎯 *Targets adjusted for today.*\n\n${out.note}`).catch(() => {});
      }
      moved++;
      console.log(`[ADAPTIVE] ${c.id.slice(-6)} ${out.reason}: ${input.baseCalories}→${out.calorieTarget} kcal, steps ${input.baseSteps}→${out.stepsTarget}`);
    } catch (e) {
      console.warn(`[ADAPTIVE] failed for ${c.id?.slice(-6)}:`, (e as Error)?.message || e);
    }
  }
  saveState("adaptive_targets", today);
  if (moved > 0) console.log(`[ADAPTIVE] adjusted targets for ${moved} client(s)`);
}

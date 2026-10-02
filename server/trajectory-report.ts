/**
 * TRAJECTORY REPORT — the DB-backed runner around the pure trajectory engine.
 *
 * Pulls a client's LAST 7 DAYS of real logs (daily calorie intake from meal_logs, daily
 * steps from step_logs), computes their maintenance from their stored profile, and runs the
 * deterministic predictTrajectory. Kept apart from trajectory.ts so that engine stays pure
 * and unit-testable; this file owns the database, the profile plumbing, and the WhatsApp text.
 */

import { pool } from "./db";
import { maintenanceKcal } from "./targets";
import { readTrustedStepDays } from "./day-ledger";
import { predictTrajectory, type DayEnergy, type TrajectoryResult } from "./trajectory";

export interface TrajectoryReport extends TrajectoryResult { whatsappText: string }

/** Fetch + predict for one user. Returns null only if the user row is missing. */
export async function getTrajectoryForUser(userId: string): Promise<TrajectoryReport | null> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  try {
    const { rows: userRows } = await pool.query<{
      current_weight: string | null; goal_type: string | null; target_weight_kg: string | null;
      gender: string | null; age: number | null; height_cm: number | null;
      life_situation: string | null; training_days_per_week: number | null; training_experience: string | null;
    }>(
      `SELECT current_weight, goal_type, target_weight_kg, gender, age, height_cm,
              life_situation, training_days_per_week, training_experience
         FROM users WHERE id = $1`,
      [userId],
    );
    if (!userRows.length) return null;
    const u = userRows[0];

    // One row per SAST day the client logged food (#539), on day-ledger's day bucket, as TEXT: a DATE
    // comes back as a JS Date, and two Dates never match as Map keys, so steps never joined before.
    // Steps come from the one trusted-step owner: client-reported, resolved to a SAST day (#540).
    const [mealRes, stepDays] = await Promise.all([
      pool.query<{ day: string; kcal: string }>(
        `SELECT to_char(logged_at + interval '2 hours', 'YYYY-MM-DD') AS day, COALESCE(SUM(kcal_int), 0) AS kcal
           FROM meal_logs WHERE user_id=$1 AND logged_at > $2
          GROUP BY 1`,
        [userId, weekAgo],
      ),
      readTrustedStepDays(userId, weekAgo),
    ]);

    const stepsByDay = new Map<string, number>(stepDays.map(d => [d.day, d.steps]));

    // A day counts only if it has a food log; steps join in where present.
    const days: DayEnergy[] = mealRes.rows.map(r => ({
      intakeKcal: parseInt(r.kcal, 10) || 0,
      steps: stepsByDay.get(r.day) || 0,
    }));

    const weightKg = u.current_weight ? parseFloat(u.current_weight) : 75;
    const maintenance = maintenanceKcal(
      weightKg, u.gender || "male", u.age || 30, u.height_cm || 170,
      u.life_situation || "office", u.training_days_per_week || 3, u.training_experience || "beginner",
    );

    const result = predictTrajectory({
      maintenanceKcal: maintenance,
      weightKg,
      goalType: u.goal_type || "fat_loss",
      days,
      targetWeightKg: u.target_weight_kg ? parseFloat(u.target_weight_kg) : null,
    });

    return { ...result, whatsappText: formatTrajectory(result) };
  } catch (e: any) {
    console.error(`[TRAJECTORY] failed for ${userId}:`, e?.message || e);
    return null;
  }
}

function formatTrajectory(r: TrajectoryResult): string {
  if (r.daysLogged === 0) return `📉 *Your forecast*\n\n${r.headline}`;
  const arrow = r.direction === "losing" ? "📉" : r.direction === "gaining" ? "📈" : "➡️";
  const onTrack = r.onTrackForGoal ? "✅ on track for your goal" : "⚠️ not on track for your goal yet";
  return (
    `${arrow} *Your forecast — from your own logs*\n\n` +
    `${r.headline}\n\n` +
    `_Eating ~${r.avgIntake.toLocaleString()} kcal/day · burning ~${r.avgExpenditure.toLocaleString()} kcal/day (with your steps)._\n` +
    `${onTrack}.`
  );
}

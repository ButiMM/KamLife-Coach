/**
 * WEIGHT TRAJECTORY ENGINE — the deterministic "what will the scale do" predictor.
 *
 * Kam, 2026-07-18: "based on their logins, food and steps, the system must precisely,
 * accurately know how much they're going to lose or gain. People will log things but not
 * DO them, then say we're a scam. The math must be honest from their own numbers."
 *
 * This is that math — pure energy balance, NO LLM (Law 4: numbers are deterministic):
 *   • expenditure/day = maintenance (TDEE break-even) + step burn (the canonical formula)
 *   • balance/day     = intake − expenditure   (negative = deficit = losing)
 *   • Δweight/week     = average daily balance × 7 ÷ 7700   (7700 kcal ≈ 1 kg of fat)
 *
 * It reads a client's ACTUAL logged intake and steps against their OWN maintenance, so the
 * verdict is "this is what YOUR logs predict" — the honest answer to "it doesn't work". If
 * they logged a surplus, the scale won't drop, and the math says so from their own entries.
 *
 * HONESTY OVER FALSE PRECISION: one week of scale weight is noisy (water, glycogen, sodium,
 * the toilet). This predicts the ENERGY trajectory — the direction the food+steps guarantee
 * over time — and says so. Confidence scales with how many days they actually logged.
 *
 * Pure + dependency-free (only the canonical stepBurnKcal). Unit-tested.
 */

import { stepBurnKcal } from "./targets";

/** 1 kg of body fat ≈ 7700 kcal (the standard energy-balance constant). */
export const KCAL_PER_KG = 7700;

export interface DayEnergy {
  intakeKcal: number; // total logged calories that day
  steps: number;      // total logged steps that day
}

export interface TrajectoryInput {
  maintenanceKcal: number; // TDEE break-even (from targets.maintenanceKcal)
  weightKg: number;        // current weight, for step-burn scaling
  goalType: string;        // fat_loss | muscle_gain | recomposition | ...
  days: DayEnergy[];       // the week's logged days (a day with no food log is NOT counted)
  targetWeightKg?: number | null;
}

export type Direction = "losing" | "gaining" | "holding";

export interface TrajectoryResult {
  daysLogged: number;
  avgIntake: number;
  avgStepBurn: number;
  avgExpenditure: number;
  avgDailyBalance: number;        // + surplus / − deficit, kcal
  predictedWeeklyChangeKg: number; // + gain / − loss (rounded to 0.01)
  predictedMonthlyChangeKg: number;
  direction: Direction;
  onTrackForGoal: boolean;
  weeksToGoal: number | null;      // only when a target weight is set AND moving toward it
  confidence: "low" | "medium" | "high";
  headline: string;                // one plain, client-facing sentence
}

function goalDirection(goalType: string): Direction {
  const g = (goalType || "").toLowerCase();
  if (g === "muscle_gain") return "gaining";
  if (g === "fat_loss" || g === "weight_loss") return "losing";
  return "holding"; // recomposition / maintenance / general
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Predict the weight trajectory from a week of real logs. A "day" only counts if it has a
 * food log — an unlogged day is unknown, not zero-calorie (assuming 0 would fake a crash
 * deficit and destroy trust). Steps default to 0 for a logged day with no step entry.
 */
export function predictTrajectory(input: TrajectoryInput): TrajectoryResult {
  const days = (input.days || []).filter(d => d && Number.isFinite(d.intakeKcal) && d.intakeKcal > 0);
  const daysLogged = days.length;
  const maintenance = Number.isFinite(input.maintenanceKcal) && input.maintenanceKcal > 0 ? input.maintenanceKcal : 2000;
  const weight = Number.isFinite(input.weightKg) && input.weightKg > 0 ? input.weightKg : 75;

  if (daysLogged === 0) {
    return {
      daysLogged: 0, avgIntake: 0, avgStepBurn: 0, avgExpenditure: maintenance,
      avgDailyBalance: 0, predictedWeeklyChangeKg: 0, predictedMonthlyChangeKg: 0,
      direction: "holding", onTrackForGoal: false, weeksToGoal: null, confidence: "low",
      headline: "No food logged yet this week — log a few days and I'll show you exactly where the scale is heading.",
    };
  }

  const avgIntake = days.reduce((s, d) => s + d.intakeKcal, 0) / daysLogged;
  const avgStepBurn = days.reduce((s, d) => s + stepBurnKcal(Math.max(0, d.steps || 0), weight), 0) / daysLogged;
  const avgExpenditure = maintenance + avgStepBurn;
  const avgDailyBalance = avgIntake - avgExpenditure; // + surplus, − deficit

  const predictedWeeklyChangeKg = round2((avgDailyBalance * 7) / KCAL_PER_KG);
  const predictedMonthlyChangeKg = round2((avgDailyBalance * 30) / KCAL_PER_KG);

  // A balance under ~100 kcal/day is within noise — call it holding, not a trend.
  const direction: Direction =
    avgDailyBalance <= -100 ? "losing" : avgDailyBalance >= 100 ? "gaining" : "holding";

  const wantDir = goalDirection(input.goalType);
  const onTrackForGoal = wantDir === "holding" ? direction === "holding" : direction === wantDir;

  // Weeks to a stated goal weight — only when we're actually moving toward it.
  let weeksToGoal: number | null = null;
  const target = input.targetWeightKg && Number.isFinite(input.targetWeightKg) ? Number(input.targetWeightKg) : null;
  if (target && Math.abs(predictedWeeklyChangeKg) >= 0.05) {
    const gap = target - weight;                       // + need to gain, − need to lose
    const movingToward = Math.sign(gap) === Math.sign(predictedWeeklyChangeKg);
    if (movingToward && Math.abs(gap) >= 0.1) {
      weeksToGoal = Math.max(1, Math.round(Math.abs(gap) / Math.abs(predictedWeeklyChangeKg)));
    }
  }

  const confidence: "low" | "medium" | "high" = daysLogged >= 5 ? "high" : daysLogged >= 3 ? "medium" : "low";

  return {
    daysLogged,
    avgIntake: Math.round(avgIntake),
    avgStepBurn: Math.round(avgStepBurn),
    avgExpenditure: Math.round(avgExpenditure),
    avgDailyBalance: Math.round(avgDailyBalance),
    predictedWeeklyChangeKg,
    predictedMonthlyChangeKg,
    direction,
    onTrackForGoal,
    weeksToGoal,
    confidence,
    headline: buildHeadline({ direction, predictedWeeklyChangeKg, onTrackForGoal, goalType: input.goalType, daysLogged, confidence, weeksToGoal }),
  };
}

function buildHeadline(a: {
  direction: Direction; predictedWeeklyChangeKg: number; onTrackForGoal: boolean;
  goalType: string; daysLogged: number; confidence: string; weeksToGoal: number | null;
}): string {
  const kg = Math.abs(a.predictedWeeklyChangeKg);
  const perWeek = `${kg.toFixed(2)}kg`;
  const goal = (a.goalType || "").toLowerCase();

  // The core cause→effect sentence, straight from their own logs.
  let line: string;
  if (a.direction === "holding") {
    line = `On what you've logged, you're eating right around your break-even — the scale will roughly hold this week.`;
  } else if (a.direction === "losing") {
    line = `On what you've logged, you're in a deficit — about *${perWeek} down* this week if you keep eating and moving like this.`;
  } else {
    line = `On what you've logged, you're in a surplus — about *${perWeek} up* this week if you keep eating and moving like this.`;
  }

  // The honest goal read — this is the anti-"it's a scam" line.
  let verdict: string;
  if (goal === "fat_loss" || goal === "weight_loss") {
    verdict = a.direction === "losing"
      ? `That's fat loss working — the numbers back it.`
      : a.direction === "holding"
        ? `To lose, the food has to come down a notch — you're eating at maintenance, not under it.`
        : `That's why the scale isn't dropping: you're logging MORE than you burn. Not the plan lying — the plate.`;
  } else if (goal === "muscle_gain") {
    verdict = a.direction === "gaining"
      ? `That's the surplus you need to build — good.`
      : `To build, you need to eat above your burn — right now you're not, so growth will stall.`;
  } else {
    verdict = a.onTrackForGoal ? `That's on plan for a recomp.` : `For a recomp we want you near break-even — adjust the food to steer it.`;
  }

  const toGoal = a.weeksToGoal ? ` At this pace, ~${a.weeksToGoal} week${a.weeksToGoal > 1 ? "s" : ""} to your goal weight.` : "";
  const caveat = a.confidence === "high"
    ? ` (${a.daysLogged} days logged — solid read.)`
    : ` (Only ${a.daysLogged} day${a.daysLogged > 1 ? "s" : ""} logged — log more for a sharper number.)`;

  return `${line} ${verdict}${toGoal}${caveat}`;
}

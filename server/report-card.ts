/**
 * WEEKLY / MONTHLY REPORT CARD (2026-07-22, founder: "a weekly and a monthly scorecard — the
 * monthly is the shareable overall report card with accurate macros, everything for the month,
 * without overwhelming, plus a small coaching line for the day/week/month").
 *
 * A SUMMARY, not a data dump: ~6 big stat tiles (avg calories, avg protein, workouts, steps,
 * consistency, weight move) + one plain coaching line. Shareable by design — a clean branded PNG
 * the client wants to post. Goal-aware: a wellness/no-numbers client gets habit tiles, never macros.
 *
 * Fail-open: any missing config/data returns "" so nothing breaks. The pure pieces are unit-tested.
 */

import { db } from "./db";
import { mealLogs, workoutLogs, stepLogs, weightLogs } from "../shared/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import { getGoalProfile } from "./goal-profiles";
import { renderReportCard, type ReportStat } from "./macro-card";
import { putCard } from "./card-store";
import { getProgressTruth } from "./day-ledger";

export type ReportPeriod = "week" | "month";

function cardBaseUrl(): string {
  let base = (process.env.APP_URL || "").trim().replace(/\/$/, "");
  if (base && !/^https?:\/\//i.test(base)) base = "https://" + base;
  return base;
}

/**
 * WHERE A CALORIE CAME FROM (2026-08-13). The adaptive loop turns on `avgKcal7d`, and until now
 * that number carried no provenance at all: a week from the curated SA database and a week of
 * model guesses produced byte-identical evidence. Two dimensions were also being conflated —
 * `mealLogs.source` stored ORIGIN except when a meal was retroactive, where TIMING overwrote it.
 * They are separate facts: origin lives here, timing lives in loggedAt vs createdAt.
 *
 *   db      the curated SA food database — the trustworthy core
 *   label   a packaging/nutrition label the client gave us
 *   ai      a model inferred the item and its numbers
 *   photo   a vision model read it off an image
 *   unknown logged before provenance existed. NOT backfilled: we genuinely do not know, and
 *           inventing it would be exactly the false confidence this whole field exists to stop.
 */
// PROVENANCE MOVED TO day-ledger-core.ts (2026-08-19, Cut 11).
//
// It is pure derivation over ledger rows — the same category as foldLedgerRows — and the
// canonical progress object needs it, so leaving it here would have meant day-ledger.ts importing
// this module while this module imports day-ledger.ts. Re-exported so every existing consumer of
// report-card keeps working unchanged; the definition has one home.
export {
  summariseProvenance,
  type ItemOrigin, type FoodDataConfidence, type FoodProvenance,
} from "./day-ledger-core";
import type { FoodProvenance } from "./day-ledger-core";


export interface ReportData {
  days: number;
  distinctDaysLogged: number;
  avgKcal: number; avgProtein: number;
  workouts: number;
  avgSteps: number;
  totalMeals: number;
  weightChange: number | null;
  /** Where the window's calories came from. Null only if the read failed. */
  provenance: FoodProvenance;
}

/**
 * The ONE weekly/monthly aggregate reader. Exported 2026-08-12 so the progress score feeds from
 * this rather than growing a second aggregator that would drift from it — same SUMs, same window,
 * same distinct-day divisor. Read-only.
 */
export async function gatherReportData(user: any, period: ReportPeriod): Promise<ReportData> {
  const days = period === "week" ? 7 : 30;
  const since = new Date(Date.now() - days * 86400000);
  // ONE TRUTH (2026-08-19, Cut 11). The averages, the session count, the step average and the
  // weight change now come from getProgressTruth — the same object the card and the share render
  // — instead of this function's own five queries. What stays here is PROVENANCE, which needs the
  // item rows rather than a total and has no other owner.
  // THE DELETION TEST (Cut 11). This function ran FIVE queries of its own — meal sums, workouts,
  // steps, weigh-ins and provenance rows. All five are gone. What remains is a projection of the
  // canonical object into the shape this card already expected, which is presentation, not truth.
  const truth = await getProgressTruth(user, { days });
  return {
    days,
    distinctDaysLogged: truth.window.daysLogged,
    avgKcal: truth.window.avgKcal,
    avgProtein: truth.window.avgProtein,
    workouts: truth.sessions,
    avgSteps: truth.avgSteps,
    totalMeals: truth.window.meals,
    // Negative means lost, and it now means that everywhere — the share card used to compute the
    // same figure with the opposite sign.
    weightChange: truth.weight.changeKg,
    provenance: truth.provenance,
  };
}

/** PURE — turn the numbers into ~6 tiles, goal-aware. Macro goals show macros; wellness shows habits. */
export function buildReportStats(user: any, d: ReportData): ReportStat[] {
  const profile = getGoalProfile(user?.goalType);
  const calTarget = Number(user?.calorieTarget) || 0;
  const protTarget = Number(user?.proteinTarget) || 0;
  const stepsTarget = Number(user?.stepsTarget) || 8500;
  const trainTarget = (Number(user?.trainingDaysPerWeek) || 3) * (d.days / 7);
  const stats: ReportStat[] = [];

  if (profile.usesMacros && calTarget > 0) {
    stats.push({ label: "Avg calories / day", value: String(d.avgKcal), sub: `target ${calTarget}`, tone: "normal" });
    const protOk = protTarget > 0 && d.avgProtein >= protTarget * 0.9;
    stats.push({ label: "Avg protein / day", value: `${d.avgProtein}g`, sub: protTarget ? `target ${protTarget}g` : undefined, tone: protOk ? "good" : "normal" });
  } else {
    stats.push({ label: "Days you showed up", value: `${d.distinctDaysLogged}`, sub: `of ${d.days}`, tone: d.distinctDaysLogged >= d.days * 0.6 ? "good" : "normal" });
    stats.push({ label: "Meals logged", value: String(d.totalMeals), tone: "normal" });
  }
  stats.push({ label: "Workouts", value: String(d.workouts), sub: `target ~${Math.round(trainTarget)}`, tone: d.workouts >= trainTarget ? "good" : "warn" });
  stats.push({ label: "Avg steps / day", value: d.avgSteps.toLocaleString(), sub: `target ${stepsTarget.toLocaleString()}`, tone: d.avgSteps >= stepsTarget ? "good" : "normal" });
  if (profile.usesMacros && calTarget > 0) {
    stats.push({ label: "Days on track", value: `${d.distinctDaysLogged}`, sub: `of ${d.days}`, tone: d.distinctDaysLogged >= d.days * 0.6 ? "good" : "normal" });
  } else {
    stats.push({ label: "Avg steps hit", value: d.avgSteps >= stepsTarget ? "Yes" : "Building", tone: d.avgSteps >= stepsTarget ? "good" : "normal" });
  }
  // 6th tile: weight move if the scale is their goal and we have it; else total meals as effort.
  if (profile.weightIsGoal && d.weightChange != null) {
    const down = d.weightChange < 0;
    stats.push({ label: "Weight change", value: `${d.weightChange > 0 ? "+" : ""}${d.weightChange}kg`, tone: down ? "good" : "normal" });
  } else {
    stats.push({ label: "Meals logged", value: String(d.totalMeals), tone: "normal" });
  }
  return stats.slice(0, 6);
}

/** PURE — one plain, non-overwhelming coaching line for the period. Leads with the strongest thing. */
export function reportCoachingLine(user: any, d: ReportData, period: ReportPeriod): string {
  const label = period === "week" ? "week" : "month";
  const profile = getGoalProfile(user?.goalType);
  const protTarget = Number(user?.proteinTarget) || 0;
  const stepsTarget = Number(user?.stepsTarget) || 8500;
  const trainTarget = (Number(user?.trainingDaysPerWeek) || 3) * (d.days / 7);
  if (profile.weightIsGoal && d.weightChange != null && d.weightChange < -0.3) return `Down ${Math.abs(d.weightChange)}kg this ${label} — the plan's working. Keep it steady.`;
  if (d.workouts >= trainTarget && d.distinctDaysLogged >= d.days * 0.6) return `Strong ${label} — training and logging both on point. This is how results happen.`;
  if (profile.usesMacros && protTarget > 0 && d.avgProtein >= protTarget * 0.9) return `Protein was your win this ${label} — the hardest habit, and you had it. One more workout next ${label}.`;
  if (d.avgSteps >= stepsTarget) return `Your steps carried this ${label} — great base. Add one more session next ${label} and it lifts everything.`;
  if (d.distinctDaysLogged >= d.days * 0.5) return `You showed up most days this ${label} — that consistency is the whole game. Let's build on it.`;
  return `Fresh ${label} ahead — pick ONE thing to nail: log every meal, or hit your steps. Small and steady wins.`;
}

const monthName = () => new Date().toLocaleString("en-ZA", { month: "long" });

/** The report-card marker (" [MEDIA:…]") for a client on demand, or "" if it can't be built. */
export async function reportCardMarker(user: any, period: ReportPeriod): Promise<string> {
  try {
    const base = cardBaseUrl();
    if (!base) return "";
    const d = await gatherReportData(user, period);
    if (d.totalMeals === 0 && d.workouts === 0 && d.avgSteps === 0) return ""; // nothing to report yet
    const first = user?.name ? String(user.name).split(" ")[0] : "Your";
    const png = renderReportCard({
      title: `${first}${first === "Your" ? "" : "'s"} ${period}`,
      subtitle: period === "week" ? "Your last 7 days" : `${monthName()} so far`,
      pill: period === "week" ? "7 days" : "30 days",
      stats: buildReportStats(user, d),
      hint: reportCoachingLine(user, d, period),
    });
    return ` [MEDIA:${base}/card/${putCard(png)}.png]`;
  } catch (e) {
    console.warn("[REPORT_CARD] skipped:", (e as any)?.message || e);
    return "";
  }
}

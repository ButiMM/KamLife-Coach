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
export type ItemOrigin = "db" | "label" | "ai" | "photo" | "unknown";

/** Model-derived origins. `db` and `label` are grounded in something outside the model. */
const ESTIMATED_ORIGINS: ItemOrigin[] = ["ai", "photo"];

/**
 * How much of a window's energy we can actually stand behind. GRADUATED, not binary: 10%
 * estimated and 80% estimated are different situations and a flag cannot tell them apart.
 *   verified          essentially all grounded
 *   mostly_verified   a small estimated share — act on the number normally
 *   mixed             act, but not on the exact figure
 *   mostly_estimated  the average is largely inference; conclusions must soften accordingly
 *   insufficient      too much unknown provenance to characterise it at all
 */
export type FoodDataConfidence =
  | "verified" | "mostly_verified" | "mixed" | "mostly_estimated" | "insufficient";

export interface FoodProvenance {
  /** Share of window kcal from model-derived items, 0–1. Null when nothing is characterisable. */
  estimatedShare: number | null;
  /** Share of window kcal from rows logged before provenance existed, 0–1. */
  unknownShare: number;
  confidence: FoodDataConfidence;
}

/**
 * PURE. Rows in, provenance out. Unknown is treated as unknown rather than folded into either
 * side — a meal we cannot characterise must not read as verified OR as estimated.
 */
export function summariseProvenance(
  rows: Array<{ kcal: number; items: unknown; source?: string | null }>,
): FoodProvenance {
  let total = 0, estimated = 0, unknown = 0;
  for (const r of rows) {
    const kcal = Number(r.kcal) || 0;
    if (kcal <= 0) continue;
    total += kcal;
    const items = Array.isArray(r.items) ? (r.items as any[]) : null;
    if (!items || items.length === 0) {
      // No item list. The meal-level `source` is a REAL recorded fact, so use it — but only in
      // the direction that can lower confidence. `photo` and `gpt_fallback` are unambiguously
      // model-derived. `sa_scanner` is NOT trusted here: before item tagging existed, that label
      // was also applied to meals carrying GPT-supplemented items, which is the exact
      // false-confidence this field exists to remove. Those stay unknown.
      if (r.source === "photo" || r.source === "gpt_fallback") estimated += kcal;
      else unknown += kcal;
      continue;
    }
    // Weight each item by its own kcal where it has one; fall back to an even split so a
    // partially-priced item list still contributes honestly rather than being dropped.
    const itemKcalTotal = items.reduce((s, it) => s + (Number(it?.kcal) || 0), 0);
    for (const it of items) {
      const share = itemKcalTotal > 0 ? (Number(it?.kcal) || 0) / itemKcalTotal : 1 / items.length;
      const origin = (it?.origin as ItemOrigin) || "unknown";
      if (origin === "unknown") unknown += kcal * share;
      else if (ESTIMATED_ORIGINS.includes(origin)) estimated += kcal * share;
    }
  }
  if (total <= 0) return { estimatedShare: null, unknownShare: 0, confidence: "insufficient" };

  const unknownShare = unknown / total;
  // With half the energy uncharacterisable, any estimated share we compute describes a minority
  // of the week and would overstate what we know.
  if (unknownShare >= 0.5) {
    return { estimatedShare: null, unknownShare: round2(unknownShare), confidence: "insufficient" };
  }
  const known = total - unknown;
  const estimatedShare = known > 0 ? estimated / known : 0;
  const confidence: FoodDataConfidence =
    estimatedShare <= 0.05 ? "verified"
      : estimatedShare <= 0.25 ? "mostly_verified"
        : estimatedShare <= 0.60 ? "mixed"
          : "mostly_estimated";
  return { estimatedShare: round2(estimatedShare), unknownShare: round2(unknownShare), confidence };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

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
  const [mealAgg, workoutAgg, stepAgg, weights, provRows] = await Promise.all([
    db.select({
      kcal: sql<number>`COALESCE(SUM(${mealLogs.kcalInt}),0)::int`,
      protein: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}),0)::int`,
      distinctDays: sql<number>`COUNT(DISTINCT DATE(${mealLogs.loggedAt}))::int`,
      total: sql<number>`COUNT(*)::int`,
    }).from(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, since))),
    db.select({ n: sql<number>`COUNT(*)::int` }).from(workoutLogs).where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, since))),
    db.select({ avg: sql<number>`COALESCE(AVG(${stepLogs.steps}),0)::int` }).from(stepLogs).where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, since))),
    db.select({ weight: weightLogs.weight, loggedAt: weightLogs.loggedAt }).from(weightLogs).where(and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, since))).orderBy(weightLogs.loggedAt),
    // PROVENANCE needs the rows, not a SUM — the origin lives inside each item. A week is a few
    // dozen rows, and it rides the same Promise.all rather than adding a round trip.
    db.select({ kcal: mealLogs.kcalInt, items: mealLogs.items, source: mealLogs.source }).from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, since))),
  ]);
  const m = mealAgg[0] as any;
  const distinctDaysLogged = Number(m?.distinctDays || 0);
  const avgDivisor = Math.max(1, distinctDaysLogged);
  const weightChange = weights.length >= 2
    ? Math.round((Number(weights[weights.length - 1].weight) - Number(weights[0].weight)) * 10) / 10
    : null;
  return {
    days,
    distinctDaysLogged,
    avgKcal: Math.round(Number(m?.kcal || 0) / avgDivisor),
    avgProtein: Math.round(Number(m?.protein || 0) / avgDivisor),
    workouts: Number((workoutAgg[0] as any)?.n || 0),
    avgSteps: Number((stepAgg[0] as any)?.avg || 0),
    totalMeals: Number(m?.total || 0),
    weightChange,
    provenance: summariseProvenance((provRows as any[]) || []),
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

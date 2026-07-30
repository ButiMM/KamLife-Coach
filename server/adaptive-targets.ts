/**
 * ADAPTIVE TARGET ENGINE — the brain that was missing.
 *
 * (2026-07-27, founder: "It doesn't adjust the calories when you are sick. It doesn't adjust
 * anything. There's no brain here.") He was right. Targets were computed ONCE at onboarding
 * and only ever recomputed when the client manually rebuilt their programme. A client could
 * report being sick, log nothing for three days, stall for a month, or lose weight twice as
 * fast as is safe — and the numbers never moved. Then the coach told them they'd missed a
 * target that was wrong for their situation.
 *
 * This decides, every day, what TODAY's targets should be from the client's actual state.
 * Pure: state in, targets + one plain-language reason out. No DB, no clock, no model — so it
 * is fully unit-tested and can never disagree with itself.
 *
 * DESIGN RULES (from six months of the founder's coaching):
 *  - Sick is REST, never a deficit. Protein stays high (it protects muscle), calories go to
 *    maintenance, steps go to zero. Nobody is failing a target from their bed.
 *  - Never starve a stall. A plateau is answered with a SMALL trim or more steps, never a
 *    crash — and never below a safe floor.
 *  - Losing too fast is a PROBLEM, not a win: that is muscle going. Calories go UP.
 *  - Change is rare and explained in ONE line. A target that moves every day is noise.
 */

export type AdaptReason =
  | "sick" | "recovering" | "losing_too_fast" | "gaining_too_fast"
  | "stalled" | "inactive" | "none";

export interface AdaptiveInput {
  /** The client's baseline targets from onboarding/profile (the "set point"). */
  baseCalories: number;
  baseProtein: number;
  baseSteps: number;
  goalType: string;              // fat_loss | muscle_gain | recomposition | wellness
  weightKg: number;
  /** Currently sick (sick_until in the future). */
  sick: boolean;
  /** Days since the illness started — drives the recovering ramp. */
  daysSick?: number;
  /** Just came back from illness within the last 3 days. */
  recovering?: boolean;
  /** kg/week from the weight trend. Negative = losing. undefined = not enough data. */
  weeklyKgChange?: number;
  /** Weeks with no meaningful weight movement (fat_loss/muscle_gain only). */
  stalledWeeks?: number;
  /** Average daily steps over the last 7 days. undefined = unknown. */
  avgSteps7d?: number;
}

export interface AdaptiveTargets {
  calorieTarget: number;
  proteinTarget: number;
  stepsTarget: number;
  reason: AdaptReason;
  /** One plain line for the client — "" when nothing changed. Never jargon. */
  note: string;
  changed: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round10 = (n: number) => Math.round(n / 10) * 10;

/**
 * ABSURD-TARGET CEILING (2026-07-28, third-party review: "This prevents a bug from telling a
 * 60kg client to eat 800 kcal or 5,000 kcal"). The floor was already enforced; the ceiling was
 * a flat 6,000 — high enough that a bug could hand a small person a target they could never
 * eat, and nobody would be told. Now weight-aware, and anything the maths wants ABOVE it is
 * clamped and logged loudly rather than shipped quietly.
 */
export function calorieCeiling(weightKg: number, goalType: string): number {
  const w = Number.isFinite(weightKg) && weightKg > 0 ? weightKg : 75;
  const byWeight = Math.round(w * (goalType === "muscle_gain" ? 55 : 45));
  return Math.max(2200, Math.min(byWeight, 4500));
}

/** Absolute safety floor — we never send anyone below this, whatever the maths says. */
function calorieFloor(weightKg: number, goalType: string): number {
  const byWeight = Math.round(weightKg * 22);          // ~22 kcal/kg is a conservative floor
  const hard = goalType === "muscle_gain" ? 1800 : 1400;
  return Math.max(hard, byWeight);
}

export function adaptTargets(inp: AdaptiveInput): AdaptiveTargets {
  const base = {
    calorieTarget: Math.round(inp.baseCalories),
    proteinTarget: Math.round(inp.baseProtein),
    stepsTarget: Math.round(inp.baseSteps),
  };
  const floor = calorieFloor(inp.weightKg, inp.goalType);
  const ceiling = calorieCeiling(inp.weightKg, inp.goalType);
  const unchanged = (reason: AdaptReason = "none"): AdaptiveTargets =>
    ({ ...base, reason, note: "", changed: false });

  // 1. SICK — highest priority. Rest, maintenance calories, protein HIGH, no step target.
  //    A deficit while ill is how people lose muscle and stay ill longer.
  if (inp.sick) {
    const maintenance = round10(clamp(inp.baseCalories * (inp.goalType === "fat_loss" ? 1.12 : 1.0), floor, ceiling));
    const protein = Math.round(Math.max(inp.baseProtein, inp.weightKg * 1.8));
    const days = inp.daysSick ?? 0;
    return {
      calorieTarget: maintenance,
      proteinTarget: protein,
      stepsTarget: 0,
      reason: "sick",
      note: `You're sick, so today's numbers are rest numbers: no deficit, no step target, protein still high because that's what protects your muscle while you heal.${days >= 6 ? " If this is dragging past a week, please see a doctor." : ""}`,
      changed: true,
    };
  }

  // 2. RECOVERING — first days back. Ease in: baseline calories, steps at half.
  if (inp.recovering) {
    return {
      calorieTarget: base.calorieTarget,
      proteinTarget: base.proteinTarget,
      stepsTarget: round10(base.stepsTarget * 0.5),
      reason: "recovering",
      note: `First days back — food target is normal again, steps at half while you find your legs. Full targets in a couple of days.`,
      changed: true,
    };
  }

  // 3. LOSING TOO FAST — over 1% of bodyweight per week is muscle, not just fat. Eat MORE.
  const wk = inp.weeklyKgChange;
  if (typeof wk === "number" && inp.goalType !== "muscle_gain" && wk <= -(inp.weightKg * 0.011)) {
    const cal = round10(clamp(inp.baseCalories * 1.10, floor, ceiling));
    return {
      calorieTarget: cal, proteinTarget: base.proteinTarget, stepsTarget: base.stepsTarget,
      reason: "losing_too_fast",
      note: `You're dropping faster than is safe — that costs muscle, not just fat. I've put your food UP to ${cal} kcal. Losing slower keeps the weight off.`,
      changed: true,
    };
  }

  // 4. GAINING TOO FAST on a build — over 0.5%/week is mostly fat. Trim the surplus.
  if (typeof wk === "number" && inp.goalType === "muscle_gain" && wk >= inp.weightKg * 0.006) {
    const cal = round10(clamp(inp.baseCalories * 0.94, floor, ceiling));
    return {
      calorieTarget: cal, proteinTarget: base.proteinTarget, stepsTarget: base.stepsTarget,
      reason: "gaining_too_fast",
      note: `You're gaining quicker than muscle can actually build, so the extra is fat. Food down slightly to ${cal} kcal — same training, leaner gain.`,
      changed: true,
    };
  }

  // 5. STALLED — 3+ weeks with no movement. SMALL trim OR more steps, never a crash.
  if ((inp.stalledWeeks ?? 0) >= 3 && inp.goalType === "fat_loss") {
    const cal = round10(clamp(inp.baseCalories * 0.93, floor, ceiling));
    if (cal >= floor && cal < base.calorieTarget) {
      return {
        calorieTarget: cal, proteinTarget: base.proteinTarget,
        stepsTarget: round10(clamp(base.stepsTarget * 1.1, 2000, 20000)),
        reason: "stalled",
        note: `Three weeks flat, so I've adjusted: food to ${cal} kcal and a few more steps. Small change on purpose — starving it backfires.`,
        changed: true,
      };
    }
    // Already at the floor — steps only, never below the floor.
    return {
      calorieTarget: base.calorieTarget, proteinTarget: base.proteinTarget,
      stepsTarget: round10(clamp(base.stepsTarget * 1.15, 2000, 20000)),
      reason: "stalled",
      note: `Three weeks flat. Your food is already as low as I'll safely take it, so we move with steps instead — target is up a little.`,
      changed: true,
    };
  }

  // 6. INACTIVE WEEK — barely moving means a lower burn; a fat-loss target must follow it
  //    down or the "deficit" is imaginary.
  if (typeof inp.avgSteps7d === "number" && inp.avgSteps7d < base.stepsTarget * 0.45 && inp.goalType === "fat_loss") {
    const cal = round10(clamp(inp.baseCalories * 0.95, floor, ceiling));
    if (cal < base.calorieTarget) {
      return {
        calorieTarget: cal, proteinTarget: base.proteinTarget, stepsTarget: base.stepsTarget,
        reason: "inactive",
        note: `Quiet week on movement, so you're burning less — I've nudged food to ${cal} kcal to match. Get the steps back up and it goes straight back.`,
        changed: true,
      };
    }
  }

  return unchanged();
}

// ── IS A WEIGHT TREND USABLE? ────────────────────────────────────────────────────────────────
// ONE OWNER (2026-07-30). This rule already existed — inline, inside the nightly adaptive job —
// and nothing else could reach it. So the job could correctly refuse to claim a trend while a
// reply, reading the same weigh-ins, asserted one anyway. Two answers to one question is how the
// founder got a morning message announcing a calorie adjustment from weights taken while he was
// sick, with his stored target never moving.
//
// Weight during and just after an illness moves on fluid, appetite and inactivity. It says
// nothing about whether the food target is right, so no caller may read a trend out of it.
export interface TrendWindow {
  /** Number of weigh-ins in the window. */
  count: number;
  /** Newest and oldest weigh-in, epoch ms. */
  newestAt: number;
  oldestAt: number;
  /** sick_since / sick_until from profileNotes, epoch ms. undefined = no illness on record. */
  sickSince?: number;
  sickUntil?: number;
  now: number;
}

export type TrendVerdict =
  | { usable: true }
  | { usable: false; why: "too_few" | "too_short" | "stale" | "illness" };

/** Fluid and appetite keep moving weight for about a week after an illness ends. */
export const ILLNESS_TAIL_MS = 7 * 86_400_000;
/** Shorter than this and the reading is noise, not a trend. */
export const MIN_TREND_SPAN_DAYS = 5;
/** Older than this and it describes a body that has moved on. */
export const MAX_TREND_AGE_DAYS = 10;

export function weightTrendUsable(w: TrendWindow): TrendVerdict {
  if (w.count < 2) return { usable: false, why: "too_few" };
  if ((w.newestAt - w.oldestAt) / 86_400_000 < MIN_TREND_SPAN_DAYS) return { usable: false, why: "too_short" };
  if ((w.now - w.newestAt) / 86_400_000 > MAX_TREND_AGE_DAYS) return { usable: false, why: "stale" };
  // An illness overlaps the span if it began before the newest weigh-in and had not yet finished
  // (plus its tail) by the oldest. An illness with no end date is still running.
  const illnessEnds = w.sickUntil !== undefined ? w.sickUntil + ILLNESS_TAIL_MS : w.now;
  if (w.sickSince !== undefined && w.sickSince <= w.newestAt && illnessEnds >= w.oldestAt) {
    return { usable: false, why: "illness" };
  }
  return { usable: true };
}

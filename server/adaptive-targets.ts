import type { FoodDataConfidence, FoodProvenance } from "./report-card";
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
  | "stalled" | "stalled_unlogged" | "stalled_over_target" | "inactive" | "none";

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
  /**
   * WHAT THEY ACTUALLY ATE (2026-08-13). Until now this engine adapted a calorie target without
   * ever knowing whether the client ate it. A stall was answered with a 7% trim regardless — so a
   * client averaging 2,400 against an 1,800 target got cut to 1,674, made an unmet target harder,
   * and was told their food had been adjusted. The target was never the problem.
   * Both from `report-card.gatherReportData`, the existing 7-day aggregate. undefined = unknown,
   * which is treated as "cannot tell", never as zero.
   */
  avgKcal7d?: number;
  /** Distinct days with any food logged in the window, 0–7. Below ADEQUATE_LOG_DAYS the average
   *  is not evidence and the target must not be adapted on it. */
  loggedDays7d?: number;
}

/**
 * THE ONE PROJECTION from canonical proactive state into this engine's input (2026-08-18,
 * Issue #49 step 2). The scheduled job used to assemble these fields itself, which is how it came
 * to read `users.calorie_target` — the column it writes — as the baseline and ratchet a client
 * down 12% in three days.
 *
 * Structurally typed on purpose: `ProactiveState` lives in scheduler/shared.ts, which pulls in the
 * database and Twilio. Naming the shape instead of importing it keeps this module pure, so the
 * offline instrument can call the exact function the job calls rather than a copy of it that can
 * silently drift.
 *
 * null means COULD NOT READ and becomes `undefined` — the engine's "cannot tell", which holds the
 * target. It must never arrive as 0, which the engine would read as "logged nothing" and act on.
 */
export interface ProactiveStateForAdapt {
  goalType: string;
  weightKg: number;
  baseline: { calories: number; protein: number; steps: number };
  health: { sick: boolean; recovering: boolean; daysSick: number };
  food: { avgKcal7d: number | null; loggedDays7d: number | null };
  steps: { avg7d: number | null };
  weight: { weeklyKgChange: number | null; stalledWeeks: number };
}

export function adaptiveInputFrom(s: ProactiveStateForAdapt): AdaptiveInput {
  return {
    baseCalories: s.baseline.calories,
    baseProtein: s.baseline.protein,
    baseSteps: s.baseline.steps,
    goalType: s.goalType,
    weightKg: s.weightKg,
    sick: s.health.sick,
    daysSick: s.health.daysSick,
    recovering: s.health.recovering,
    weeklyKgChange: s.weight.weeklyKgChange ?? undefined,
    stalledWeeks: s.weight.stalledWeeks,
    avgSteps7d: s.steps.avg7d ?? undefined,
    avgKcal7d: s.food.avgKcal7d ?? undefined,
    loggedDays7d: s.food.loggedDays7d ?? undefined,
  };
}

/**
 * Below four logged days in seven, an intake average is not evidence. Same floor the hunger
 * evidence uses deliberately — one client should not be "well logged" for one subsystem and
 * "thinly logged" for another on the same day.
 */
export const ADEQUATE_LOG_DAYS = 4;

/**
 * Intake this far above target means the target was not tested. 10% of an 1,800 kcal target is
 * 180 kcal — inside a day's logging error, so tighter than this would fire on noise.
 */
export const INTAKE_OVER_TARGET_RATIO = 1.10;

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
  //
  // BUT FIRST: WAS THE TARGET EVER ACTUALLY EATEN? (2026-08-13.) A stall only means the target is
  // wrong if the client was hitting it. Two clients stall identically and need opposite answers —
  // one is eating 1,780 of 1,800 and needs the target moved, the other is eating 2,400 and needs
  // the target left exactly where it is. Cutting the second one's food is the same error class as
  // telling a client at 98% protein to eat more protein: acting on an artifact instead of the
  // evidence. Neither branch below touches a number; both say what is actually true.
  if ((inp.stalledWeeks ?? 0) >= 3 && inp.goalType === "fat_loss") {
    const logged = inp.loggedDays7d;
    if (typeof logged === "number" && logged < ADEQUATE_LOG_DAYS) {
      return {
        ...base, reason: "stalled_unlogged",
        note: `The scale hasn't moved in three weeks, but you've only logged ${logged} day${logged === 1 ? "" : "s"} this week — I can't tell yet whether the target is wrong or it just hasn't been eaten. Log properly for the next few days and I'll have a real answer.`,
        changed: true,
      };
    }
    if (typeof inp.avgKcal7d === "number" && inp.baseCalories > 0
        && inp.avgKcal7d > inp.baseCalories * INTAKE_OVER_TARGET_RATIO) {
      return {
        ...base, reason: "stalled_over_target",
        note: `Three weeks flat, and you're averaging ${Math.round(inp.avgKcal7d)} kcal against a ${base.calorieTarget} target — so the target isn't what's stuck, it hasn't been tested yet. I'm leaving your numbers exactly where they are; let's get the food closer to target first.`,
        changed: true,
      };
    }
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

/**
 * Did the recorded illness cover YESTERDAY — the day a morning brief reports on?
 *
 * Both edges matter and each one is a message that would otherwise reach the wrong client. An
 * illness that started this morning did not cause yesterday's missing logs, and a window that
 * closed before yesterday did not either; in both cases "hope you're feeling better" goes to
 * someone who simply did not log. ISO date strings, compared as strings — same shape as the
 * sick_since / sick_until tokens in profileNotes.
 *
 * Lives here, beside weightTrendUsable, because both answer "what does this illness window let us
 * say" and the scheduler module that reads the tokens cannot be imported without a database.
 */
/**
 * Is the client inside a recorded illness window TODAY? ISO dates, compared as strings.
 *
 * The durable answer to the question `wasSickOrInjured()` was guessing at from the last 20 chat
 * messages. That scan matched "rest day", "skip gym", "miss workout" and someone ELSE being ill,
 * and — in every job that checks isPaused() first, which is all of them — it could not reach a
 * genuinely ill client at all, because sick-flow writes paused_until beside sick_until.
 */
// DELETED 2026-08-21: sickToday() and sickCoveredYesterday(). Both moved to health-state.ts as
// readHealthState().isSick and .wasSickYesterday, with the same rules. They were two of the five
// disagreeing interpretations of one stored fact; leaving them here as a second entry point to
// the same answer is how the next caller ends up asking the wrong one.

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


/**
 * THE TREND ADJUSTMENT, AS A PURE FUNCTION (2026-08-05).
 *
 * This decision lived inline in weight.ts, tangled with the message strings, which meant the
 * one piece of maths that silently CHANGES a client's calories could not be tested at all.
 * It was disabled for beta on exactly that basis. Here it is, extracted unchanged in
 * behaviour, so the audit can be run instead of argued.
 *
 * Judged on % of BODY WEIGHT per week, not raw kg: 0.85kg/week is too fast for a 70kg person
 * (1.2%) and a safe pace for a 130kg client (0.65%). The kg figure is still what the client
 * SEES — only the decision scales.
 *
 * Returns the kcal to add to the FRESHLY COMPUTED target. It is never applied to the previous
 * adjusted value, which is what stops it compounding across weigh-ins.
 */
export function trendCalorieAdjust(goalType: string, ratePctPerWeek: number): number {
  const goal = (goalType || "fat_loss").toLowerCase();
  // A non-finite rate is NO INFORMATION, and no information must never move a target. The
  // first draft coerced it to 0, which on a fat-loss plan reads as "gaining" and quietly
  // removed 150 kcal. Caught by the audit that was written to check this function.
  if (!Number.isFinite(ratePctPerWeek)) return 0;
  const r = ratePctPerWeek;
  if (goal === "fat_loss") {
    if (r < -1.0) return 150;    // losing too fast for their size — protect muscle
    if (r < -0.88) return 100;   // aggressive end
    if (r <= -0.24) return 0;    // the dead band: on target, leave it alone
    if (r < 0) return -100;      // slower than ideal
    return -150;                 // gaining on a fat-loss programme
  }
  if (goal === "muscle_gain") {
    if (r > 0.55) return -100;   // gaining fast — some of that is fat
    if (r >= 0.1) return 0;      // the dead band: ideal lean gain
    if (r > -0.12) return 100;   // scale stalled
    return 150;                  // losing on a gain programme
  }
  return 0;                      // recomposition coaches with words, never with calories
}


// ════════════════════════════════════════════════════════════════════════════════════════════
// DEFICIT EVIDENCE — what we told them to eat, what they ate, and what the scale did.
//
// Lives HERE rather than in its own module, deliberately. It reads the same targets, the same
// goal types and the same trend rule the engine above adapts on, and a separate file would be a
// second owner of one question — which is how `weightTrendUsable` came to disagree with a reply
// in the first place. Same contract as hunger-evidence.ts: the deterministic layer states
// measurements and how much they are worth, and Coach K decides what they mean. Nothing below
// returns TARGET_IS_WRONG or ADHERENCE_PROBLEM.
//
// THE UNCERTAINTY IS THE POINT. Two approximations sit under this and both are stated rather
// than hidden: estimated maintenance is not measured expenditure, and a 7-day weight slope is
// not pure fat — water, sodium, illness, cycle and training inflammation all move the scale
// faster than fat does. A system reporting "expected -0.4, observed -0.1, therefore your target
// is wrong" would be confidently wrong for the client who had a salty weekend.
// ════════════════════════════════════════════════════════════════════════════════════════════

/** 7,700 kcal per kg of body fat — the standard approximation, and only ever an approximation. */
export const KCAL_PER_KG = 7700;

/**
 * How far the scale may sit from the estimate before it is worth a coach's attention. Anything
 * inside this is noise: at 0.15 kg/week the difference is a glass of water and a late dinner.
 */
export const MATERIAL_GAP_KG_PER_WEEK = 0.15;

export interface DeficitEvidence {
  calorieTarget: number;
  avgKcal7d: number | null;
  loggedDays7d: number;
  /** avg ÷ target. Above 1 = eating more than the target, below = under it. */
  intakeRatio: number | null;
  /** Estimated kg/week implied by (intake − maintenance), where maintenance is inferred from the
   *  programme's own target. Null when intake is not evidence. Approximate by construction. */
  expectedKgPerWeek: number | null;
  /** Measured from weigh-ins, and only when `weightTrendUsable` said so. Null otherwise. */
  observedKgPerWeek: number | null;
  /** observed − expected. Positive = losing slower than the estimate. Null if either is null. */
  gapKgPerWeek: number | null;
  /** Whether that gap is bigger than day-to-day noise. False when the gap is null. */
  gapIsMaterial: boolean;
  /**
   * HOW MUCH OF THAT INTAKE WE CAN STAND BEHIND (2026-08-13). The whole loop turns on
   * `avgKcal7d`, and a week from the curated SA database and a week of model guesses used to
   * produce identical evidence. Graduated, never binary: 10% estimated and 80% estimated are
   * different situations. This QUALIFIES the conclusion; it never blocks the adaptation —
   * deciding is Coach K's, and a deterministic veto here would be the calculator coaching again.
   */
  foodDataConfidence: FoodDataConfidence;
  /** Share of the window's calories that a model inferred, 0–1. Null when uncharacterisable. */
  estimatedShare: number | null;
  /**
   * What this evidence can support:
   *   none              nothing usable on either side
   *   intake_only       food is logged well enough, but no trustworthy weight trend
   *   trend_only        the trend is trustworthy, but the food is not logged well enough
   *   usable            both — and only here may the target itself be discussed
   */
  confidence: "none" | "intake_only" | "trend_only" | "usable";
}

/**
 * Maintenance inferred from the programme's own target. A fat-loss target already contains the
 * intended deficit, so maintenance is the target plus it. Deliberately NOT a BMR formula: the
 * programme's number is the one the client was actually coached to, and inventing a second
 * estimate here would let two parts of the system disagree about the same person.
 */
function inferredMaintenance(calorieTarget: number, goalType: string): number {
  const g = (goalType || "fat_loss").toLowerCase();
  if (g === "fat_loss") return calorieTarget + 500;
  if (g === "muscle_gain") return calorieTarget - 300;
  return calorieTarget;
}

export function assembleDeficitEvidence(inp: {
  calorieTarget: number;
  avgKcal7d: number | null;
  loggedDays7d: number;
  goalType: string;
  /** From `report-card.gatherReportData`. Omit only if the read failed. */
  provenance?: FoodProvenance;
  /** Only pass this when `weightTrendUsable` returned usable — this file trusts the caller and
   *  will not second-guess a trend it cannot see the weigh-ins for. */
  observedKgPerWeek: number | null;
}): DeficitEvidence {
  const target = inp.calorieTarget > 0 ? inp.calorieTarget : 0;
  const intakeIsEvidence = inp.loggedDays7d >= ADEQUATE_LOG_DAYS
    && typeof inp.avgKcal7d === "number" && inp.avgKcal7d > 0 && target > 0;

  const avgKcal7d = typeof inp.avgKcal7d === "number" ? inp.avgKcal7d : null;
  const intakeRatio = intakeIsEvidence ? (inp.avgKcal7d as number) / target : null;

  const expectedKgPerWeek = intakeIsEvidence
    ? Math.round(((((inp.avgKcal7d as number) - inferredMaintenance(target, inp.goalType)) * 7) / KCAL_PER_KG) * 100) / 100
    : null;

  const observedKgPerWeek = typeof inp.observedKgPerWeek === "number" ? inp.observedKgPerWeek : null;
  const gapKgPerWeek = expectedKgPerWeek !== null && observedKgPerWeek !== null
    ? Math.round((observedKgPerWeek - expectedKgPerWeek) * 100) / 100
    : null;

  const confidence: DeficitEvidence["confidence"] =
    intakeIsEvidence && observedKgPerWeek !== null ? "usable"
      : intakeIsEvidence ? "intake_only"
        : observedKgPerWeek !== null ? "trend_only"
          : "none";

  return {
    calorieTarget: target,
    avgKcal7d,
    loggedDays7d: inp.loggedDays7d,
    intakeRatio: intakeRatio === null ? null : Math.round(intakeRatio * 100) / 100,
    expectedKgPerWeek,
    observedKgPerWeek,
    gapKgPerWeek,
    gapIsMaterial: gapKgPerWeek !== null && Math.abs(gapKgPerWeek) >= MATERIAL_GAP_KG_PER_WEEK,
    foodDataConfidence: inp.provenance?.confidence ?? "insufficient",
    estimatedShare: inp.provenance?.estimatedShare ?? null,
    confidence,
  };
}

/** Is this worth spending prompt on? Only when at least one side of the comparison is real. */
export function hasRelevantDeficitEvidence(e: DeficitEvidence): boolean {
  return e.confidence !== "none";
}

/**
 * Serialise for the prompt. MEASUREMENTS ONLY — no cause, no recommendation, no verdict, and
 * deliberately no "weakest lever" style superlative. The 2026-08-13 lesson: a field that names one
 * factor reads as an instruction however the surrounding prose is worded.
 */
export function renderDeficitEvidence(e: DeficitEvidence): string {
  const kg = (n: number | null) => (n === null ? "unknown" : `${n > 0 ? "+" : ""}${n.toFixed(2)}kg/week`);
  return [
    "WEIGHT-LOSS EVIDENCE (deterministic — these numbers are authoritative, never invent them):",
    `Calorie target: ${e.calorieTarget} kcal/day`,
    e.avgKcal7d !== null ? `7-day average intake: ${e.avgKcal7d} kcal/day` : "7-day average intake: not enough logged to say",
    `Logged days: ${e.loggedDays7d} of 7`,
    e.intakeRatio !== null ? `Intake against target: ${Math.round(e.intakeRatio * 100)}%` : "",
    e.expectedKgPerWeek !== null ? `Expected rate from that intake: ${kg(e.expectedKgPerWeek)} (rough estimate)` : "",
    e.observedKgPerWeek !== null ? `Observed rate on the scale: ${kg(e.observedKgPerWeek)}` : "Observed rate on the scale: no trustworthy trend",
    e.gapKgPerWeek !== null ? `Difference: ${kg(e.gapKgPerWeek)}${e.gapIsMaterial ? "" : " — inside normal week-to-week noise"}` : "",
    `Food-data confidence: ${e.foodDataConfidence}${e.estimatedShare !== null ? ` (${Math.round(e.estimatedShare * 100)}% of those calories estimated by me, not weighed)` : ""}`,
    `Confidence: ${e.confidence}`,
    "",
    "The expected rate is an ESTIMATE built on an assumed maintenance, and a week of scale readings",
    "moves on water, salt, illness and cycle as well as fat. Treat a difference as something to look",
    "into, never as proof. With confidence below 'usable' you may not say the target is wrong: say",
    "which half you are missing and ask for it. Deciding what this means is yours.",
    "Use the intake figure IN PROPORTION to its food-data confidence. At 'mostly_estimated' the",
    "average is largely my own guesswork — say the number is roughly that and soften the",
    "conclusion; do not tell them they definitely ate it. At 'insufficient' do not build a case on",
    "the figure at all. At 'verified' or 'mostly_verified' you may use it as it stands.",
  ].filter(Boolean).join("\n");
}

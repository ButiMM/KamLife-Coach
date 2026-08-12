/**
 * KamLife Progress Score — a single 0–100 number that shows progress BEYOND the scale.
 *
 * Why this exists (retention): when the scale stalls, clients quit — even when their
 * training, protein and steps are improving. A composite score lets Coach K say
 * "you are NOT failing — weight is flat but your habits are up, here's the one bottleneck"
 * instead of letting a flat scale read as failure. Borrowed from WW's beyond-scale score
 * and MacroFactor's adherence focus, adapted to the data KamLife already stores.
 *
 * Deliberately lean: a PURE function over metrics the progress handler already computes.
 * No new DB queries, no schema change. Fully unit-testable (see script/unit-tests.ts).
 *
 * Weighting (totals 100) — only signals KamLife tracks reliably today:
 *   Food logging consistency  25   (you cannot coach what you cannot see)
 *   Protein consistency       20
 *   Training sessions         25
 *   Steps                     20
 *   Weight trend (log + dir)  10
 * Recovery/sleep is intentionally NOT scored yet — KamLife does not track sleep reliably,
 * and inventing a score from missing data would be noise. Fold it in when sleep exists.
 */

export interface ProgressScoreInputs {
  completedSessions: number;   // workouts logged this week
  plannedSessions: number;     // trainingDaysPerWeek
  avgDailyProtein: number;     // g/day across logged days (0 if none)
  proteinTarget: number;       // g/day
  avgSteps: number;            // avg/day across logged days (0 if none)
  stepsTarget: number;
  foodLogDays: number;         // distinct days food was logged this week (0–7)
  weightLogCount: number;      // weigh-ins this week
  weightChangeKg: number | null; // newest − oldest this week; null if < 2 logs
  goalType: string;            // fat_loss | muscle_gain | recomposition
}

export interface ProgressScoreComponent {
  label: string;
  points: number; // awarded
  max: number;    // possible
  /** points ÷ max, 0–1. The comparable form — this is what "weakest lever" is measured on. */
  ratio: number;
}

/**
 * HOW MUCH THIS ASSESSMENT IS WORTH (2026-08-12). Evidence assembled from two logged days is not
 * evidence, and a layer that cannot say "I don't know" will invent an answer instead. Consumers
 * must gate on this: at "none" the honest coaching move is to ask for a log, not to diagnose.
 */
export type EvidenceConfidence = "none" | "weak" | "usable";

export interface ProgressScore {
  score: number;                       // 0–100, rounded
  components: ProgressScoreComponent[];
  /**
   * The WEAKEST MEASURED lever — the lowest-ratio component with room. NOT "the intervention":
   * see the note at the computation. A consumer that treats this as the next coaching move has
   * turned the coach into an argmin() over five ratios.
   */
  bottleneck: string;
  /** How far the evidence can be trusted. Gate on this before diagnosing anything. */
  confidence: EvidenceConfidence;
  /**
   * A rendering convenience for the score BLOCK only (renderProgressScore). It is prose from a
   * calculator, so it must never be fed to Coach K as evidence — the coach writes its own words
   * from `components`, `bottleneck` and `confidence`.
   */
  headline: string;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Did the weight move the right way for the goal? Recomp rewards staying flat. */
function weightMovingRightWay(goalType: string, changeKg: number): boolean {
  if (goalType === "muscle_gain") return changeKg >= 0;
  if (goalType === "recomposition") return Math.abs(changeKg) <= 0.5;
  return changeKg <= 0; // fat_loss (default)
}

export function computeProgressScore(inp: ProgressScoreInputs): ProgressScore {
  // Food logging consistency (25) — out of 7 days.
  const foodPts = clamp01(inp.foodLogDays / 7) * 25;

  // Protein consistency (20) — only meaningful if food was logged at all.
  const proteinPts = inp.foodLogDays > 0 && inp.proteinTarget > 0
    ? clamp01(inp.avgDailyProtein / inp.proteinTarget) * 20
    : 0;

  // Training (25) — completed vs planned. No planned sessions → treat as met.
  const trainingPts = inp.plannedSessions > 0
    ? clamp01(inp.completedSessions / inp.plannedSessions) * 25
    : 25;

  // Steps (20) — avg vs target. No step logs → 0.
  const stepsPts = inp.avgSteps > 0 && inp.stepsTarget > 0
    ? clamp01(inp.avgSteps / inp.stepsTarget) * 20
    : 0;

  // Weight trend (10) — 5 for weighing in at all, 5 for moving the right way.
  let weightPts = 0;
  if (inp.weightLogCount > 0) {
    weightPts += 5; // showed up on the scale
    if (inp.weightChangeKg !== null && weightMovingRightWay(inp.goalType, inp.weightChangeKg)) {
      weightPts += 5;
    } else if (inp.weightChangeKg === null) {
      // Only one weigh-in: can't judge direction. Don't punish — give half the trend bonus.
      weightPts += 2.5;
    }
  }

  const components: ProgressScoreComponent[] = [
    { label: "Food logging", points: foodPts, max: 25 },
    { label: "Protein", points: proteinPts, max: 20 },
    { label: "Training", points: trainingPts, max: 25 },
    { label: "Steps", points: stepsPts, max: 20 },
    { label: "Weight trend", points: weightPts, max: 10 },
  ].map(c => ({ ...c, ratio: c.max > 0 ? c.points / c.max : 0 }));

  const score = Math.round(components.reduce((s, c) => s + c.points, 0));

  // Confidence is about the EVIDENCE, not the score. Four logged days is the floor below which an
  // average is a rumour: 1–3 days is "weak" and 0 is "none". A consumer that ignores this will
  // confidently tell a client their protein is low on the strength of one Tuesday.
  const confidence: EvidenceConfidence =
    inp.foodLogDays >= 4 ? "usable" : inp.foodLogDays >= 1 ? "weak" : "none";

  // THE WEAKEST MEASURED LEVER — not "the intervention" (2026-08-12 ruling). This comment used
  // to read "This is the ONE thing to fix", which is the argmin fallacy: the lowest ratio is the
  // weakest thing we MEASURE, and that is not automatically the most useful thing to change. A
  // client at protein 0.55 / adherence 0.95 / steps 0.60 may still be better served by something
  // this function cannot see — cost, schedule, food preference, or WHY adherence is breaking.
  // The deterministic layer says "protein is the weakest measured lever." Coach K decides whether
  // protein is the right next move. Keeping that boundary is what stops the coach becoming a
  // glorified argmin() over five ratios.
  const withRoom = components.filter(c => c.points < c.max - 0.01);
  const bottleneckComp = withRoom.length > 0
    ? withRoom.reduce((lo, c) => (c.points / c.max < lo.points / lo.max ? c : lo))
    : null;
  const bottleneck = bottleneckComp ? bottleneckComp.label : "None — everything on track";

  const headline = score >= 80
    ? "Strong week across the board."
    : score >= 55
    ? "Solid base — one area is holding the score back."
    : score >= 30
    ? "The habits aren't failing — they're just inconsistent. Fix one thing."
    : "Early days. Pick the one bottleneck and start there.";

  return { score, components, bottleneck, confidence, headline };
}

/**
 * Render the score as a short WhatsApp block. Kept separate from compute so the
 * scoring logic stays pure and testable. Intentionally compact — Coach K voice.
 */
export function renderProgressScore(s: ProgressScore): string {
  return `*KamLife Score: ${s.score}/100*\n${s.headline}${
    s.bottleneck.startsWith("None") ? "" : `\nThis week's bottleneck: *${s.bottleneck}*.`
  }`;
}

/**
 * THE WIRING (2026-08-12). This function was written, unit-tested, and never called by anything
 * in production — the same shape as the sliced prompt: capability the product paid for and never
 * shipped. `progressInputsFrom` is the missing half: it maps the weekly aggregate that
 * report-card.ts already computes onto the inputs this scorer has always declared.
 *
 * PURE by design. It takes the numbers, it does not read the database — `gatherReportData` owns
 * that query, so there is exactly one weekly aggregate in the product and a second one cannot
 * quietly drift from it. And it returns evidence, never words: what Coach K SAYS about a weak
 * protein ratio is the coach's job, not this file's.
 *
 * `weightLogCount` is derived, not measured: gatherReportData exposes the CHANGE (null when it
 * saw fewer than two weigh-ins) rather than the count. A non-null change proves at least two.
 * Stated here rather than silently assumed, because a caller reading `weightLogCount` as a real
 * tally would be wrong — a single weigh-in reads as 0 here.
 */
export function progressInputsFrom(
  d: { distinctDaysLogged: number; avgProtein: number; workouts: number; avgSteps: number; weightChange: number | null },
  targets: { proteinTarget: number; stepsTarget: number; plannedSessions: number; goalType: string },
): ProgressScoreInputs {
  return {
    completedSessions: d.workouts,
    plannedSessions: targets.plannedSessions,
    avgDailyProtein: d.avgProtein,
    proteinTarget: targets.proteinTarget,
    avgSteps: d.avgSteps,
    stepsTarget: targets.stepsTarget,
    foodLogDays: Math.min(7, d.distinctDaysLogged),
    weightLogCount: d.weightChange !== null ? 2 : 0,
    weightChangeKg: d.weightChange,
    goalType: targets.goalType,
  };
}

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
}

export interface ProgressScore {
  score: number;                       // 0–100, rounded
  components: ProgressScoreComponent[];
  bottleneck: string;                  // lowest-ratio component that has room to improve
  headline: string;                    // one-line, retention-aware summary
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
  ];

  const score = Math.round(components.reduce((s, c) => s + c.points, 0));

  // Bottleneck = the component with the lowest fill ratio that still has room.
  // This is the ONE thing to fix — drives the weekly focus message.
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

  return { score, components, bottleneck, headline };
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

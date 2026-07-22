/**
 * WEIGHT-IN-CONTEXT ENGINE — the coaching-intelligence layer on the scale.
 *
 * The gap (2026-07-22, Kam's "it's not intelligent enough" complaint): the brain was
 * handed a bare "Weight up 1.3kg this week" and just empathised. It never went back to
 * the data to say WHEN the weight went on and WHY — that the 1.3kg landed during the
 * training-and-surplus weeks (the plan working), and that THIS week, sick and eating
 * light and resting, the client has NOT gained. Empathy without attribution leaves the
 * scary, wrong implication ("you're gaining") on the table.
 *
 * This module reasons deterministically from the weigh-in history + the client's current
 * STATE (resting/sick) + their GOAL, and produces ONE grounded sentence for the pattern
 * context — so the model delivers the truth warmly instead of freelancing comfort.
 *
 * Pure — no DB, no network. Unit-tested in script/unit-tests.ts.
 */

export interface WeighInPoint {
  weight: number; // kg
  at: Date | string | number; // logged-at
}

export interface WeightContextInput {
  goalType?: string | null; // "muscle_gain" | "fat_loss" | "recomposition" | "maintenance"
  weighIns: WeighInPoint[]; // any order; sorted internally, newest first
  resting?: boolean; // currently sick / recovering / paused — eating light, not training
}

function toMs(at: Date | string | number): number {
  if (at instanceof Date) return at.getTime();
  if (typeof at === "number") return at;
  const t = new Date(at).getTime();
  return Number.isNaN(t) ? 0 : t;
}

const DAY = 86_400_000;
const FLAT = 0.3; // kg — within this is "held steady" (scale/water noise)

// A goal where GAINING is the aim (surplus + training). fat_loss is the inverse.
function goalGains(goal: string): boolean {
  return goal === "muscle_gain" || goal === "muscle" || goal === "gain";
}
function goalLoses(goal: string): boolean {
  return goal === "fat_loss" || goal === "weight_loss" || goal === "fat";
}

/**
 * Build the weight-context sentence. Returns "" when there isn't enough data to reason —
 * the caller keeps its existing fallback line in that case.
 */
export function weightInContextLine(input: WeightContextInput): string {
  const goal = String(input.goalType || "").toLowerCase();
  const pts = (input.weighIns || [])
    .filter((p) => p && Number.isFinite(Number(p.weight)) && Number(p.weight) > 0)
    .map((p) => ({ w: Number(p.weight), t: toMs(p.at) }))
    .filter((p) => p.t > 0)
    .sort((a, b) => b.t - a.t);

  if (pts.length === 0) return "";
  const latest = pts[0];

  // Only one weigh-in on record — nothing to attribute yet.
  if (pts.length === 1) return `Weight logged: ${latest.w.toFixed(1)}kg — one data point so far, no trend yet.`;

  // THIS-WEEK delta: latest vs the closest weigh-in 5–10 days before it (a real week apart).
  const weekTarget = latest.t - 7 * DAY;
  let weekAgo: { w: number; t: number } | null = null;
  for (const p of pts.slice(1)) {
    const gapDays = (latest.t - p.t) / DAY;
    if (gapDays >= 4) {
      if (!weekAgo || Math.abs(p.t - weekTarget) < Math.abs(weekAgo.t - weekTarget)) weekAgo = p;
    }
  }
  // OVERALL delta: latest vs the earliest point on record (the whole window we can see).
  const earliest = pts[pts.length - 1];
  const overallDelta = latest.w - earliest.w;
  const overallDays = Math.max(1, Math.round((latest.t - earliest.t) / DAY));

  const thisWeekDelta = weekAgo ? latest.w - weekAgo.w : null;
  const weekFlat = thisWeekDelta !== null && Math.abs(thisWeekDelta) < FLAT;
  const weekUp = thisWeekDelta !== null && thisWeekDelta >= FLAT;
  const weekDown = thisWeekDelta !== null && thisWeekDelta <= -FLAT;

  const kg = (n: number) => Math.abs(n).toFixed(1);

  // Where did the OVERALL change happen? If this week is flat/opposite but the overall
  // number moved, the movement came from the EARLIER period — the attribution Kam wants.
  const overallUp = overallDelta >= FLAT;
  const overallDown = overallDelta <= -FLAT;

  // ── RESTING / SICK — the headline case. The scale must be read through the state. ──
  if (input.resting) {
    if (weekFlat || thisWeekDelta === null) {
      let s = `Weight is holding at ${latest.w.toFixed(1)}kg — steady this week while resting/recovering, which is exactly right (a sick, under-eating week should NOT move the scale much).`;
      if (overallUp && weekAgo) {
        s += goalGains(goal)
          ? ` The ${kg(overallDelta)}kg they're up over ${overallDays} days went on during their earlier training-and-surplus weeks — that's the build working, not fat, and NOT this week.`
          : ` Any of the ${kg(overallDelta)}kg on record went on before this rest week, not during it — don't read the sick week as a setback.`;
      } else if (overallDown) {
        s += ` They're actually down ${kg(overallDelta)}kg over ${overallDays} days — nothing lost this week, so reassure, don't push.`;
      }
      s += ` Do NOT tell them they're gaining — contextualise: the number reflects the earlier period, this week they've held.`;
      return s;
    }
    if (weekDown) {
      return `Weight down ${kg(thisWeekDelta!)}kg this week — but they've been sick, resting and eating light, so this is water and food weight, NOT real fat loss. Don't celebrate it as progress; say it'll settle when they're back to normal eating and training.`;
    }
    // weekUp while resting
    return `Weight up ${kg(thisWeekDelta!)}kg this week — but they've been resting and sick, not training or eating normally, so this is almost certainly water/food, not fat. Reassure: nothing to react to, the real number shows once they're training again.`;
  }

  // ── TRAINING / NORMAL — reason from goal + attribute the movement. ──
  if (thisWeekDelta === null) {
    // Only have an overall span, no clean week-apart pair.
    if (Math.abs(overallDelta) < FLAT) return `Weight steady around ${latest.w.toFixed(1)}kg over ${overallDays} days.`;
    const dir = overallDelta > 0 ? "up" : "down";
    return `Weight ${dir} ${kg(overallDelta)}kg over ${overallDays} days${describeGoalFit(goal, overallDelta)}.`;
  }

  if (weekFlat) {
    return `Weight steady this week at ${latest.w.toFixed(1)}kg${goalGains(goal) ? " — for muscle gain that means eat a little more to keep the scale creeping up" : goalLoses(goal) ? " — a stall; tighten portions or add a walk to restart the drop" : ""}.`;
  }

  const dir = weekUp ? "up" : "down";
  return `Weight ${dir} ${kg(thisWeekDelta!)}kg this week${describeGoalFit(goal, thisWeekDelta!)}.`;
}

// One clause on whether the movement fits the goal — so "up 0.4kg" reads as progress for a
// muscle-gain client and as a flag for a fat-loss client, never bare and ambiguous.
function describeGoalFit(goal: string, delta: number): string {
  if (goalGains(goal)) {
    return delta > 0 ? " — on track for muscle gain, that's the surplus building" : " — falling weight on a muscle-gain goal is a problem; they need to eat more";
  }
  if (goalLoses(goal)) {
    return delta < 0 ? " — good, that's the deficit working for fat loss" : " — wrong direction for fat loss; check portions and consistency";
  }
  return "";
}

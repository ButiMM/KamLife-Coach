/**
 * ADAPTIVE TRAINING — the other half of the adaptive engine.
 *
 * (2026-07-27.) `adaptive-targets.ts` already moves FOOD in response to state: sick, recovering,
 * losing too fast, stalled, inactive. Training never moved at all. So a client coming back from
 * flu got a sensible reduced calorie target and, in the same breath, the exact same session they
 * were doing at full strength three weeks earlier.
 *
 * That gap became visible when the coach started telling returning clients to "use 60% of your
 * old weights" — good advice, printed next to a programme still showing their pre-illness
 * numbers. Advice the product contradicts is worse than no advice.
 *
 * Same state signals as the food side, same conservative bias: when unsure, train lighter.
 * Pure — no DB, no clock, no model. Unit-tested.
 */

export type TrainingReason = "sick" | "recovering" | "returning" | "under_fuelled" | "none";

export interface TrainingInput {
  /** Currently sick (sick_until in the future). */
  sick?: boolean;
  /** Came back from illness within the last few days. */
  recovering?: boolean;
  /** Days since their last logged session. Long gaps need a ramp, illness or not. */
  daysSinceLastWorkout?: number;
  /** Eating well under target for several days — training hard on empty is how people get hurt. */
  underFuelledDays?: number;
}

export interface TrainingAdjust {
  /** Percentage of their usual working weight. 100 = normal. */
  loadPct: number;
  /** Sets to drop from each exercise (0 = none). */
  setsDelta: number;
  /** True = don't train today at all. */
  skip: boolean;
  reason: TrainingReason;
  /** One plain line for the client. "" when nothing changed. */
  note: string;
  changed: boolean;
}

const NORMAL: TrainingAdjust = { loadPct: 100, setsDelta: 0, skip: false, reason: "none", note: "", changed: false };

/**
 * Decide today's training adjustment. Ordered worst-first: being sick outranks everything,
 * exactly as it does on the food side.
 */
export function adaptTraining(inp: TrainingInput): TrainingAdjust {
  if (inp.sick) {
    return {
      loadPct: 0, setsDelta: 0, skip: true, reason: "sick", changed: true,
      note: "No session today — you're sick. Training while ill makes it last longer, it doesn't make you tougher. Rest, fluids, protein when you can.",
    };
  }

  const gap = inp.daysSinceLastWorkout ?? 0;

  if (inp.recovering) {
    return {
      loadPct: 60, setsDelta: -1, skip: false, reason: "recovering", changed: true,
      note: "First sessions back after being sick: *60% of your usual weights*, one less set per exercise. You'll feel weaker than you were — that's normal and it comes back within two weeks.",
    };
  }

  if (gap >= 14) {
    return {
      loadPct: 60, setsDelta: -1, skip: false, reason: "returning", changed: true,
      note: `It's been ${gap} days. Start at *60% of your old weights* and drop a set — build back over 2–3 weeks. Trying to pick up where you left off is how people get injured in week one.`,
    };
  }
  if (gap >= 7) {
    return {
      loadPct: 80, setsDelta: 0, skip: false, reason: "returning", changed: true,
      note: `A week off — take today at about *80%* of your usual weights and go back to full next session.`,
    };
  }

  if ((inp.underFuelledDays ?? 0) >= 3) {
    return {
      loadPct: 85, setsDelta: 0, skip: false, reason: "under_fuelled", changed: true,
      note: "You've been eating well under target for a few days, so keep today at about *85%*. Lifting hard on an empty tank is where injuries and burnout come from — get the food back up and we go full again.",
    };
  }

  return NORMAL;
}

/** The block that goes at the TOP of a served session, so it's read before the exercises. */
export function trainingAdjustHeader(adj: TrainingAdjust): string {
  return adj.changed && adj.note ? `⚠️ *Today's session is adjusted*\n${adj.note}\n\n` : "";
}

/**
 * Rewrite the set counts printed in a served programme. A note saying "drop a set" beside a
 * sheet that still says 3×10 is the contradiction this module exists to remove.
 */
export function applySetsDelta(programmeText: string, setsDelta: number): string {
  if (!setsDelta) return programmeText;
  return (programmeText || "").replace(/\b([2-6])\s*(?:×|x)\s*(\d{1,2})\b/g, (whole, sets: string, reps: string) => {
    const next = Math.max(1, parseInt(sets, 10) + setsDelta);
    return `${next}×${reps}`;
  });
}

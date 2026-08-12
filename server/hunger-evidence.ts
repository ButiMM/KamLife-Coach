/**
 * HUNGER EVIDENCE — the assembler. Step 3 of the hunger doctrine (2026-08-12).
 *
 * Two halves already exist and have never met: `computeProgressScore` knows the nutrition,
 * adherence and weight picture, and `symptomPersistence` knows how many DAYS hunger was
 * actually reported. This joins them into one immutable object and stops.
 *
 * WHAT IT DOES NOT DO, and this is the whole design:
 *   · it does not diagnose — no cause, no "protein is low so eat more"
 *   · it does not recommend — no intervention field, no eatMoreProtein, no reduceCalories
 *   · it does not write — read-only, assembled from values handed to it
 *   · it does not speak — no client-facing prose anywhere in this file
 * Those belong to Coach K, with this evidence in front of it. A deterministic layer that picks
 * the intervention is a coach made of argmin(), which is the thing we are deliberately not
 * building.
 *
 * PURE by design: it takes the two evidence objects rather than reading the database, so the
 * queries keep their existing owners (`gatherReportData`, `symptomPersistence`) and no second
 * aggregate can drift from them. The caller composes.
 */

import type { ProgressScore, EvidenceConfidence } from "./progress-score";
import type { SymptomPersistence } from "./quality-signals";

/**
 * Hunger counts as PERSISTENT at three distinct days inside the window. Two is a pattern
 * forming; three is a pattern. The number that matters is DAYS, never message count — six
 * complaints in one bad afternoon is one day of evidence and must never read as six.
 */
export const PERSISTENT_HUNGER_DAYS = 3;

/**
 * Protein counts as ADEQUATE at 85% of target or better. Not 100%: a client averaging 108g
 * against a 120g target does not have a protein problem, and telling them they do — while they
 * are hungry and have been doing the work — is how a coach loses someone who was complying.
 */
export const ADEQUATE_PROTEIN_RATIO = 0.85;

/**
 * A precise statement of WHAT THE EVIDENCE SUPPORTS. Not a diagnosis and not an instruction —
 * it exists so the model cannot accidentally read `distinctDays: 1` and `distinctDays: 6` as the
 * same situation, and so "adequate protein, still hungry" is impossible to miss.
 *
 *   insufficient_data                  too few logged days to claim anything about intake
 *   no_persistent_symptom              evidence assembled, but hunger is not a standing pattern
 *   single_signal                      hunger reported, but on too few days to call it persistent
 *   persistent_hunger                  hunger persists AND protein is short — protein is IN SCOPE
 *   adequate_protein_persistent_hunger hunger persists DESPITE adequate protein — look elsewhere
 *
 * The last two deliberately do not name a cause. `persistent_hunger` says protein is short and
 * hunger is real; it does not say the first caused the second. That inference is the coach's,
 * and it is allowed to conclude something else entirely.
 */
export type EvidenceState =
  | "insufficient_data"
  | "no_persistent_symptom"
  | "single_signal"
  | "persistent_hunger"
  | "adequate_protein_persistent_hunger";

export interface HungerEvidence {
  progress: {
    avgDailyProtein: number;
    proteinTarget: number;
    /** intake ÷ target, 0–1+. The comparable form. */
    proteinRatio: number | null;
    /** food-logging consistency ratio — how much of the week we can actually see. */
    adherence: number | null;
    steps: number | null;
    weeklyKgChange: number | null;
    /** The WEAKEST MEASURED lever, never "the intervention". See progress-score.ts. */
    bottleneck: string;
  };
  hunger: {
    distinctDays: number;
    windowDays: number;
    persistent: boolean;
  };
  /** Distinct days of FOOD logging behind the averages. The averages are worth this much. */
  dataDays: number;
  confidence: EvidenceConfidence;
  evidenceState: EvidenceState;
}

/**
 * Join the nutrition picture and the symptom history. Pure, total, and never throws — a missing
 * component yields a null field and a lower state, because "I do not know" is a real answer and
 * an invented one is not.
 */
export function assembleHungerEvidence(
  score: ProgressScore,
  hunger: SymptomPersistence,
  inputs: { avgDailyProtein: number; proteinTarget: number; avgSteps: number; weightChangeKg: number | null; foodLogDays: number },
): HungerEvidence {
  const ratioOf = (label: string): number | null => {
    const c = score.components.find(x => x.label === label);
    return c ? c.ratio : null;
  };
  const proteinRatio = inputs.proteinTarget > 0 ? inputs.avgDailyProtein / inputs.proteinTarget : null;
  const persistent = hunger.distinctDays >= PERSISTENT_HUNGER_DAYS;

  // Order matters. Confidence is checked FIRST: without enough logged days the intake averages
  // are not evidence, so no claim about protein — adequate or short — may be made at all.
  let evidenceState: EvidenceState;
  if (score.confidence !== "usable") {
    evidenceState = "insufficient_data";
  } else if (hunger.distinctDays === 0) {
    evidenceState = "no_persistent_symptom";
  } else if (!persistent) {
    evidenceState = "single_signal";
  } else if (proteinRatio !== null && proteinRatio >= ADEQUATE_PROTEIN_RATIO) {
    evidenceState = "adequate_protein_persistent_hunger";
  } else {
    evidenceState = "persistent_hunger";
  }

  return {
    progress: {
      avgDailyProtein: inputs.avgDailyProtein,
      proteinTarget: inputs.proteinTarget,
      proteinRatio,
      adherence: ratioOf("Food logging"),
      steps: inputs.avgSteps || null,
      weeklyKgChange: inputs.weightChangeKg,
      bottleneck: score.bottleneck,
    },
    hunger: {
      distinctDays: hunger.distinctDays,
      windowDays: hunger.windowDays,
      persistent,
    },
    dataDays: inputs.foodLogDays,
    confidence: score.confidence,
    evidenceState,
  };
}

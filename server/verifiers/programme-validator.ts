/**
 * programme-validator.ts — Self-verifying loop for generated workout programmes.
 *
 * Validates a generated workout/programme string against the client's injury
 * profile and checks progressive-overload sanity. PURE deterministic functions —
 * no GPT, no DB, synchronous and zero-cost. Always safe — never throws.
 *
 * Shares injury knowledge with the response gate via injury-rules.ts so both the
 * conversational gate and workout delivery reason about injuries identically.
 */

import { extractBodyParts, checkExercisesAgainstInjuries, INJURY_SAFE_ALTERNATIVES } from "./injury-rules";

export interface ProgrammeValidationResult {
  safe: boolean;
  conflicts: string[];        // human-readable, e.g. "loads knee: squat, lunge"
  suggestedAlternatives: string[];  // safe substitutes for the injured parts
  warningNote: string;        // a client-facing note to append, or "" if safe
}

const SAFE_RESULT: ProgrammeValidationResult = {
  safe: true,
  conflicts: [],
  suggestedAlternatives: [],
  warningNote: "",
};

/**
 * Validate a workout/programme text block against a client's injuries.
 * @param programmeText the generated workout (from buildDayWorkout/buildFullProgramme)
 * @param injuries the user's injuries field (free text)
 */
export function validateProgramme(
  programmeText: string,
  injuries: string | null | undefined,
): ProgrammeValidationResult {
  try {
    const cleaned = (injuries || "").trim();
    if (!cleaned || cleaned.toLowerCase() === "none") {
      return { ...SAFE_RESULT };
    }

    const bodyParts = extractBodyParts(cleaned);
    if (bodyParts.length === 0) {
      return { ...SAFE_RESULT };
    }

    const conflicts = checkExercisesAgainstInjuries(programmeText, bodyParts);
    if (conflicts.length === 0) {
      return { ...SAFE_RESULT };
    }

    // Only the body parts that actually conflicted should drive the warning/alternatives.
    const conflictedParts = conflicts
      .map(c => c.replace(/^loads /, "").split(":")[0].trim())
      .filter(p => p.length > 0);

    // Gather safe alternatives for the conflicted parts (deduped, order-preserving).
    const suggestedAlternatives: string[] = [];
    for (const part of conflictedParts) {
      for (const alt of INJURY_SAFE_ALTERNATIVES[part] || []) {
        if (!suggestedAlternatives.includes(alt)) suggestedAlternatives.push(alt);
      }
    }

    const injuredParts = conflictedParts.join("/");
    const alternatives = suggestedAlternatives.join(", ");
    const warningNote =
      `\n\n⚠️ *Note on your ${injuredParts} injury:* This programme includes movements ` +
      `that may aggravate it. Safer swaps: ${alternatives}. Check with me before loading ` +
      `those, or reply for a fully adapted session.`;

    console.warn(`[PROGRAMME_VALIDATOR] ${conflicts.length} conflict(s) detected:`, conflicts);

    return {
      safe: false,
      conflicts,
      suggestedAlternatives,
      warningNote,
    };
  } catch (e) {
    console.warn("[PROGRAMME_VALIDATOR] unhandled error — treating as safe:", e instanceof Error ? e.message : e);
    return { ...SAFE_RESULT };
  }
}

export interface OverloadCheck {
  valid: boolean;
  issue: string | null;
}

/**
 * Sanity-check a week-over-week weight progression.
 * Flags regressions (next < current) and implausible jumps (>20% increase week-on-week).
 */
export function checkProgressiveOverload(currentKg: number, nextKg: number): OverloadCheck {
  try {
    if (nextKg < currentKg) {
      return { valid: false, issue: `regression: ${nextKg}kg < ${currentKg}kg` };
    }
    if (nextKg > currentKg * 1.2) {
      return { valid: false, issue: `jump too large: ${currentKg}kg → ${nextKg}kg (>20%)` };
    }
    return { valid: true, issue: null };
  } catch (e) {
    console.warn("[PROGRAMME_VALIDATOR] overload check error — treating as valid:", e instanceof Error ? e.message : e);
    return { valid: true, issue: null };
  }
}

/**
 * GOAL PROFILES — the single semantic source of truth for what a client's goal MEANS.
 *
 * The systemic disease (2026-07-21, three-reviewer adjudication of the state assessment):
 * `goalType` and the literal strings fat_loss/muscle_gain/recomposition are duplicated
 * across ~50 files — and worse, mean DIFFERENT things in each: "show a deficit" here,
 * "prioritise protein" there, "use gentle tone" elsewhere, "show the forecast" in another.
 * Four concepts gated on one string. A diabetic gogo who signs up is forced into a fat-loss
 * calorie deficit and a 185g protein quota because the SPINE only knows body composition.
 *
 * This registry centralises the meaning. Every scattered `goal === "fat_loss"` check migrates
 * to read a SEMANTIC field here (usesMacros, weightIsGoal, energyStance, …) so:
 *   - the three body-composition goals behave EXACTLY as before (byte-identical), and
 *   - the health-led goals become safe BY CONSTRUCTION — no macro pressure, no deficit
 *     language, no scale obsession — WITHOUT any clinical logic.
 *
 * `general` and `health_condition` already exist in targets.ts (goalAdj/proteinMult) but were
 * captured-and-ignored by the rest of the spine — the exact "half-built" pattern the review
 * named. This makes them first-class instead of dead strings.
 *
 * LIABILITY LINE (reviewer adjudication — the one that keeps this a wellness app, not a
 * medical device): we coach the PERSON, never the CONDITION. A client who says they have a
 * condition gets a scope boundary ("I'm a coach, not your doctor — follow your doctor for the
 * condition") and runs the SAME safe wellness loop. We never prescribe med timing or clinical
 * interventions.
 *
 * Pure and unit-tested. This file changes nothing on its own — behaviour shifts only as
 * consumers migrate to read from it (the deliberate, low-risk way to refactor a 50-file spine).
 */

export type GoalKey = "fat_loss" | "muscle_gain" | "recomposition" | "general" | "health_condition";

export interface GoalProfile {
  key: GoalKey;
  /** Client-facing name. */
  label: string;
  /** Does the daily loop push calorie/protein NUMBERS at the client? Body-comp goals: yes.
   *  Wellness / has-a-condition: no — plain-language habit coaching instead, so a gogo is
   *  never handed a 185g protein target. */
  usesMacros: boolean;
  /** The honest energy frame, for coach language ("a small deficit" / "eating to build" /
   *  "eating around maintenance"). Never say "deficit" to a maintenance client. */
  energyStance: "deficit" | "surplus" | "maintenance";
  /** How hard to push protein. */
  proteinPriority: "high" | "moderate" | "gentle";
  /** Is the SCALE a goal for this client? Wellness/condition clients are NOT chasing a
   *  number — coach consistency and how they feel, never a target weight. */
  weightIsGoal: boolean;
  /** What the daily WIN is built around — what the coach celebrates. */
  dailyWin: "protein_and_deficit" | "protein_and_surplus" | "protein_and_balance" | "consistency_and_movement";
  /** What we actually track and surface for this person. */
  tracks: Array<"weight" | "steps" | "sleep" | "consistency" | "mobility" | "protein">;
  /** Triggers the "I'm a coach, not your doctor" scope boundary (has-a-condition only). */
  scopeBoundary: boolean;
}

const PROFILES: Record<GoalKey, GoalProfile> = {
  fat_loss: {
    key: "fat_loss", label: "Fat loss", usesMacros: true, energyStance: "deficit",
    proteinPriority: "high", weightIsGoal: true, dailyWin: "protein_and_deficit",
    tracks: ["weight", "steps", "protein", "sleep"], scopeBoundary: false,
  },
  muscle_gain: {
    key: "muscle_gain", label: "Muscle gain", usesMacros: true, energyStance: "surplus",
    proteinPriority: "high", weightIsGoal: true, dailyWin: "protein_and_surplus",
    tracks: ["weight", "protein", "sleep"], scopeBoundary: false,
  },
  recomposition: {
    key: "recomposition", label: "Recomposition", usesMacros: true, energyStance: "maintenance",
    proteinPriority: "high", weightIsGoal: false, dailyWin: "protein_and_balance",
    tracks: ["steps", "protein", "sleep"], scopeBoundary: false,
  },
  // HEALTH-LED — the gogos, tired shift-workers, event-driven, "I just want energy". No macro
  // pressure, no deficit language, no scale chasing. Coach consistency and movement.
  general: {
    key: "general", label: "General wellness", usesMacros: false, energyStance: "maintenance",
    proteinPriority: "gentle", weightIsGoal: false, dailyWin: "consistency_and_movement",
    tracks: ["steps", "consistency", "sleep", "mobility"], scopeBoundary: false,
  },
  // HAS-A-CONDITION — same safe wellness loop, plus the doctor scope boundary. We coach the
  // person, never the condition; no clinical prescriptions.
  health_condition: {
    key: "health_condition", label: "Healthier living", usesMacros: false, energyStance: "maintenance",
    proteinPriority: "moderate", weightIsGoal: false, dailyWin: "consistency_and_movement",
    tracks: ["steps", "consistency", "sleep"], scopeBoundary: true,
  },
};

// Tolerate the phrasings onboarding, the normalizer, and older rows actually store — every
// one resolves to a canonical key so no consumer ever sees an unknown string.
const ALIASES: Record<string, GoalKey> = {
  fat_loss: "fat_loss", weight_loss: "fat_loss", lose_weight: "fat_loss", "fat-loss": "fat_loss", cutting: "fat_loss",
  muscle_gain: "muscle_gain", "muscle-gain": "muscle_gain", muscle: "muscle_gain", build: "muscle_gain", bulking: "muscle_gain",
  recomposition: "recomposition", recomp: "recomposition", recomposition_goal: "recomposition",
  general: "general", general_wellness: "general", wellness: "general", health_span: "general", healthspan: "general", maintenance: "general",
  health_condition: "health_condition", "health-condition": "health_condition", condition: "health_condition", medical: "health_condition",
};

/**
 * The safe accessor every consumer uses. Unknown/blank goals fall back to fat_loss — the
 * historical default the whole codebase already assumes (`goalType || "fat_loss"`) — never to
 * undefined, so a bad or missing string can never crash a consumer or blank a target.
 */
export function getGoalProfile(goalType: string | null | undefined): GoalProfile {
  const key = ALIASES[String(goalType || "").toLowerCase().trim()] || "fat_loss";
  return PROFILES[key];
}

/** Convenience for the most common migration: "does this client get macro numbers?" */
export function usesMacroTargets(goalType: string | null | undefined): boolean {
  return getGoalProfile(goalType).usesMacros;
}

export const GOAL_KEYS = Object.keys(PROFILES) as GoalKey[];

// ── ONBOARDING GOAL DETECTION — from the client's own words or the menu number ──────────
// Health-led goals (2026-07-21 spine surgery) are reachable at signup: someone who says
// "I just want energy / to be healthy / manage my sugar" is NOT funnelled into a fat-loss
// deficit. Pure/tested. Body-composition intent always wins ("lose weight to be healthy"
// stays fat_loss) so the three existing goals never change.
const BODY_COMP_RE = /\b(lose|fat|muscle|build|recomp\w*|both|weight|gain|bulk|cut|tone|shred|lean out)\b/i;
const CONDITION_RE = /\b(diabet\w*|sugar|blood pressure|\bbp\b|hypertension|cholesterol|pre.?diabet\w*|my condition)\b/i;
const WELLNESS_RE = /\b(health(?:y|ier)?|energy|energetic|tired|fatigue|wellness|well.?being|feel better|stay (?:active|well|healthy|fit)|keep (?:active|fit|moving|healthy)|get fit|mobil\w*|longevity|grandkids|grandchildren|keep up|general fitness|overall)\b/i;

/** Did the client actually answer the goal question (a number 1–4 or any goal word)? */
export function looksLikeGoalAnswer(msg: string): boolean {
  const lower = (msg || "").toLowerCase();
  return /[1-4]/.test(msg) || BODY_COMP_RE.test(lower) || CONDITION_RE.test(lower) || WELLNESS_RE.test(lower);
}

/** Map the goal answer to a canonical goal key. Existing 1/2/3 behaviour is unchanged. */
export function classifyGoalFromText(msg: string): GoalKey {
  const lower = (msg || "").toLowerCase();
  if (msg.includes("2") || /\b(build|muscle|gain|bulk)\b/i.test(lower)) return "muscle_gain";
  if (msg.includes("3") || /\b(recomp\w*|both)\b/i.test(lower)) return "recomposition";
  // Health-led ONLY when there's no body-composition intent in the message.
  if (!BODY_COMP_RE.test(lower) && (msg.includes("4") || CONDITION_RE.test(lower) || WELLNESS_RE.test(lower))) {
    return CONDITION_RE.test(lower) ? "health_condition" : "general";
  }
  return "fat_loss";
}

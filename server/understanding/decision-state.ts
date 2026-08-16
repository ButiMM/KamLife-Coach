/**
 * Canonical coaching decision state.
 *
 * The model may phrase a reply naturally, but the internal coaching outcome must still
 * resolve to one of four states. This keeps "continue" and "I don't know yet" first-class
 * instead of forcing every turn into an intervention.
 *
 * Pure and dependency-free: no DB, model, clock, or handlers.
 */
export type DecisionState = "CONTINUE" | "CHANGE" | "INVESTIGATE" | "REFER";

export type DecisionEvidence = "sufficient" | "insufficient";

export interface DecisionInputs {
  /** The situation is outside KamLife's safe coaching scope. Highest priority. */
  requiresReferral?: boolean;
  /** There is a material coaching problem worth changing, not mere activity/novelty. */
  meaningfulProblem: boolean;
  /** Evidence is strong enough to justify acting on the material problem. */
  evidence: DecisionEvidence;
  /** A specific missing fact could change the next instruction. */
  hasMinimumUsefulQuestion?: boolean;
}

/**
 * Select the least intervention justified by the evidence.
 *
 * Priority is deliberate:
 * REFER  >  INVESTIGATE  >  CHANGE  >  CONTINUE
 *
 * A missing fact without a meaningful problem does not manufacture an investigation.
 * Likewise, an insufficiently evidenced problem cannot become a change merely because
 * the coach is expected to say something new.
 */
export function selectDecisionState(input: DecisionInputs): DecisionState {
  if (input.requiresReferral) return "REFER";

  if (input.meaningfulProblem && input.evidence === "insufficient") {
    return input.hasMinimumUsefulQuestion ? "INVESTIGATE" : "CONTINUE";
  }

  if (input.meaningfulProblem && input.evidence === "sufficient") {
    return "CHANGE";
  }

  return "CONTINUE";
}

export function isCoachingDecisionState(value: unknown): value is DecisionState {
  return value === "CONTINUE"
    || value === "CHANGE"
    || value === "INVESTIGATE"
    || value === "REFER";
}

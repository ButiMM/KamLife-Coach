/**
 * Runtime adapter for the canonical coaching decision state.
 *
 * This is the deterministic bridge between the evidence objects already assembled by the live
 * pipeline and the four-state coaching contract. It deliberately does not inspect model prose.
 * The model can explain a decision, but it cannot choose a state that contradicts the evidence.
 */

import { selectDecisionState, type DecisionState, type DecisionEvidence } from "./decision-state";
import type { HungerEvidence } from "../hunger-evidence";
import type { DeficitEvidence } from "../adaptive-targets";

export interface RuntimeDecisionInputs {
  hungerEvidence?: HungerEvidence;
  deficitEvidence?: DeficitEvidence;
  /** True only when a deterministic safety/referral gate has already decided the case is outside scope. */
  requiresReferral?: boolean;
}

export interface RuntimeDecisionResult {
  state: DecisionState;
  evidence: DecisionEvidence;
  meaningfulProblem: boolean;
  hasMinimumUsefulQuestion: boolean;
}

/**
 * Map existing evidence into the canonical decision policy.
 *
 * Conservative rules:
 * - No material signal -> CONTINUE.
 * - Persistent hunger with insufficient evidence -> INVESTIGATE (never prescribe from thin data).
 * - Persistent hunger with usable evidence -> CHANGE, leaving the actual lever to Coach K.
 * - Material deficit/trend mismatch -> CHANGE when the evidence is usable, otherwise INVESTIGATE.
 * - Referral always outranks coaching.
 * - An adequate-protein persistent-hunger case remains investigatory: the symptom is real but its
 *   cause is not established by protein alone.
 */
export function deriveRuntimeDecision(input: RuntimeDecisionInputs): RuntimeDecisionResult {
  if (input.requiresReferral) {
    return { state: "REFER", evidence: "sufficient", meaningfulProblem: true, hasMinimumUsefulQuestion: false };
  }

  const hunger = input.hungerEvidence;
  const hungerProblem = hunger?.evidenceState === "persistent_hunger"
    || hunger?.evidenceState === "adequate_protein_persistent_hunger";
  const hungerNeedsInvestigation = hunger?.evidenceState === "insufficient_data"
    || hunger?.evidenceState === "adequate_protein_persistent_hunger";

  const deficit = input.deficitEvidence;
  const deficitProblem = deficit?.gapIsMaterial === true;
  const deficitEvidence: DecisionEvidence = deficit?.confidence === "usable" ? "sufficient" : "insufficient";

  const meaningfulProblem = hungerProblem || deficitProblem;
  const evidence: DecisionEvidence = hungerNeedsInvestigation
    ? "insufficient"
    : deficitProblem
      ? deficitEvidence
      : hungerProblem
        ? "sufficient"
        : "insufficient";

  const hasMinimumUsefulQuestion = hungerNeedsInvestigation
    || (deficitProblem && deficitEvidence === "insufficient");

  return {
    state: selectDecisionState({ meaningfulProblem, evidence, hasMinimumUsefulQuestion }),
    evidence,
    meaningfulProblem,
    hasMinimumUsefulQuestion,
  };
}

/**
 * Deterministic guard around the conversational reply.
 * The runtime decision is authoritative for plan-level behaviour.
 */

import type { RuntimeDecisionResult } from "./state";

const CHANGE_LANGUAGE = /\b(?:lower|raise|increase|decrease|cut|add|remove|change|adjust|drop|bump)\b[^.!?]{0,80}\b(?:calories?|kcal|protein|steps?|target|intake|deficit|plan)\b/i;
const INVESTIGATE_MARKERS = /\b(?:i don't know yet|i do not know yet|not enough (?:data|logged)|not enough evidence|need (?:another|more) (?:day|days|data|evidence)|log (?:another|a few more)|give me (?:another|a few more)|i need to see more)\b/i;
const REFER_MARKERS = /\b(?:doctor|dietitian|clinician|healthcare professional|medical help|seek medical care|emergency)\b/i;

export function decisionBoundaryViolation(reply: string, decision: RuntimeDecisionResult): string | null {
  const text = (reply || "").trim();
  if (!text) return "empty reply";

  if (decision.state === "INVESTIGATE") {
    if (!INVESTIGATE_MARKERS.test(text)) return "INVESTIGATE reply must explicitly acknowledge insufficient evidence and identify the minimum evidence needed";
    if (CHANGE_LANGUAGE.test(text)) return "INVESTIGATE reply must not prescribe a plan-level change before evidence is sufficient";
  }

  if (decision.state === "CONTINUE" && CHANGE_LANGUAGE.test(text)) {
    return "CONTINUE reply must not invent a plan-level change when the deterministic decision is no-change";
  }

  if (decision.state === "REFER" && !REFER_MARKERS.test(text)) {
    return "REFER reply must clearly direct the client to appropriate professional/medical support";
  }

  return null;
}

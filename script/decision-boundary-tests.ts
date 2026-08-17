/** Pure tests for the canonical coaching decision boundary and bounded coaching memory. */

import assert from "node:assert/strict";
import { verifyBrainReply } from "../server/brain/reply-verifier";
import { compileStateBlurb } from "../server/understanding/compiler";
import { currentRuntimeDecision, deriveRuntimeDecision, defaultUnderstanding, coerceUnderstanding, pruneLearnedPatterns } from "../server/understanding/state";
import type { DecisionFocus, RuntimeDecisionResult } from "../server/understanding/state";

const d = (state: RuntimeDecisionResult["state"], evidence: RuntimeDecisionResult["evidence"], focus: DecisionFocus = "none"): RuntimeDecisionResult => ({
  state,
  evidence,
  meaningfulProblem: state !== "CONTINUE",
  hasMinimumUsefulQuestion: state === "INVESTIGATE",
  focus,
});

assert.equal(
  verifyBrainReply("You're on track. Keep doing what you're doing.", { goalType: "fat_loss", clientMessage: "How am I doing?" }, d("CONTINUE", "sufficient")).ok,
  true,
);
assert.match(
  verifyBrainReply("You're on track, but increase your steps and change your target.", { goalType: "fat_loss", clientMessage: "How am I doing?" }, d("CONTINUE", "sufficient")).violation || "",
  /CONTINUE/,
);

assert.equal(
  verifyBrainReply("I don't know yet — log another day properly and I'll tell you what matters.", { goalType: "fat_loss", clientMessage: "I'm always hungry" }, d("INVESTIGATE", "insufficient", "hunger")).ok,
  true,
);
assert.match(
  verifyBrainReply("You're hungry, so add more protein tomorrow.", { goalType: "fat_loss", clientMessage: "I'm always hungry" }, d("INVESTIGATE", "insufficient", "hunger")).violation || "",
  /INVESTIGATE/i,
);

assert.equal(
  verifyBrainReply("This needs a doctor to assess properly.", { goalType: "fat_loss", clientMessage: "I have severe pain" }, d("REFER", "sufficient", "safety")).ok,
  true,
);
assert.match(
  verifyBrainReply("Just cut your calories and see how you feel.", { goalType: "fat_loss", clientMessage: "I have severe pain" }, d("REFER", "sufficient", "safety")).violation || "",
  /REFER/,
);

const liveDecision = deriveRuntimeDecision({
  hungerEvidence: {
    evidenceState: "insufficient_data",
    hunger: { distinctDays: 4, windowDays: 7, persistent: true },
  },
});
assert.equal(liveDecision.state, "INVESTIGATE");
assert.equal(liveDecision.focus, "hunger");
assert.equal(currentRuntimeDecision()?.state, "INVESTIGATE");
assert.equal(currentRuntimeDecision()?.focus, "hunger");
assert.match(compileStateBlurb(defaultUnderstanding("Test")).toLowerCase(), /primary coaching focus: hunger/);

const intakeDecision = deriveRuntimeDecision({
  deficitEvidence: { gapIsMaterial: true, confidence: "usable" },
});
assert.equal(intakeDecision.state, "CHANGE");
assert.equal(intakeDecision.focus, "intake");
assert.match(compileStateBlurb(defaultUnderstanding("Test")).toLowerCase(), /primary coaching focus: intake\/energy balance/);

const continueDecision = deriveRuntimeDecision({});
assert.equal(continueDecision.state, "CONTINUE");
assert.equal(continueDecision.focus, "none");
assert.match(compileStateBlurb(defaultUnderstanding("Test")).toLowerCase(), /primary coaching focus: no intervention/);

const referDecision = deriveRuntimeDecision({ requiresReferral: true });
assert.equal(referDecision.state, "REFER");
assert.equal(referDecision.focus, "safety");
assert.match(compileStateBlurb(defaultUnderstanding("Test")).toLowerCase(), /primary coaching focus: safety\/referral/);

const now = Date.parse("2026-08-17T10:00:00.000Z");
const bounded = coerceUnderstanding({
  observations: {
    learnedPatterns: [{
      text: "Weekends are often harder after Friday social events.",
      evidence: "Repeated Friday/Saturday reports over several weeks.",
      confidence: "high",
      firstObserved: "2026-08-01T10:00:00.000Z",
      lastObserved: "2026-08-16T10:00:00.000Z",
      confirmed: true,
    }],
  },
}, "Test");
assert.equal(bounded.observations.learnedPatterns.length, 1);
assert.equal(bounded.observations.learnedPatterns[0]?.confirmed, true);
const boundedBlurb = compileStateBlurb(bounded).toLowerCase();
assert.match(boundedBlurb, /recent coaching patterns/);
assert.match(boundedBlurb, /weekends are often harder/);

const stale = [{
  text: "They tend to skip logging when busy.",
  evidence: "Seen once months ago.",
  confidence: "medium" as const,
  firstObserved: "2026-01-01T10:00:00.000Z",
  lastObserved: "2026-04-01T10:00:00.000Z",
  confirmed: false,
}];
assert.equal(pruneLearnedPatterns(stale, now).length, 0);

const safeWithoutEvidence = coerceUnderstanding({ observations: { learnedPatterns: [{
  text: "They overeat on Saturdays.",
  evidence: "No Saturday messages were received.",
  confidence: "low",
  firstObserved: "2026-08-16T10:00:00.000Z",
  lastObserved: "2026-08-16T10:00:00.000Z",
  confirmed: false,
}]}}, "Test");
assert.equal(safeWithoutEvidence.observations.learnedPatterns[0]?.confidence, "low");
assert.equal(safeWithoutEvidence.observations.learnedPatterns[0]?.confirmed, false);

assert.match(
  verifyBrainReply("You're hungry, so add more protein tomorrow.", { goalType: "fat_loss", clientMessage: "I'm always hungry" }).violation || "",
  /INVESTIGATE/i,
);
assert.equal(
  verifyBrainReply("I don't know yet — log another day properly and I'll tell you what matters.", { goalType: "fat_loss", clientMessage: "I'm always hungry" }).ok,
  true,
);

console.log("decision-boundary-tests: all passed");

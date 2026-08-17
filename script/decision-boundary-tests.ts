/** Pure tests for the canonical coaching decision boundary. */

import assert from "node:assert/strict";
import { verifyBrainReply } from "../server/brain/reply-verifier";
import { currentRuntimeDecision, deriveRuntimeDecision } from "../server/understanding/state";
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

const intakeDecision = deriveRuntimeDecision({
  deficitEvidence: { gapIsMaterial: true, confidence: "usable" },
});
assert.equal(intakeDecision.state, "CHANGE");
assert.equal(intakeDecision.focus, "intake");

const continueDecision = deriveRuntimeDecision({});
assert.equal(continueDecision.state, "CONTINUE");
assert.equal(continueDecision.focus, "none");

const referDecision = deriveRuntimeDecision({ requiresReferral: true });
assert.equal(referDecision.state, "REFER");
assert.equal(referDecision.focus, "safety");

assert.match(
  verifyBrainReply("You're hungry, so add more protein tomorrow.", { goalType: "fat_loss", clientMessage: "I'm always hungry" }).violation || "",
  /INVESTIGATE/i,
);
assert.equal(
  verifyBrainReply("I don't know yet — log another day properly and I'll tell you what matters.", { goalType: "fat_loss", clientMessage: "I'm always hungry" }).ok,
  true,
);

console.log("decision-boundary-tests: all passed");

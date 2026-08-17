/** Pure tests for the canonical coaching decision boundary. */

import assert from "node:assert/strict";
import { verifyBrainReply } from "../server/brain/reply-verifier";
import { decisionBoundaryViolation } from "../server/understanding/decision-boundary";
import { currentRuntimeDecision, deriveRuntimeDecision } from "../server/understanding/state";
import type { RuntimeDecisionResult } from "../server/understanding/state";

const d = (state: RuntimeDecisionResult["state"], evidence: RuntimeDecisionResult["evidence"]): RuntimeDecisionResult => ({
  state,
  evidence,
  meaningfulProblem: state !== "CONTINUE",
  hasMinimumUsefulQuestion: state === "INVESTIGATE",
});

assert.equal(decisionBoundaryViolation("You're on track. Keep doing what you're doing.", d("CONTINUE", "sufficient")), null);
assert.match(
  decisionBoundaryViolation("You're on track, but increase your steps and change your target.", d("CONTINUE", "sufficient")) || "",
  /CONTINUE/,
);

assert.equal(
  decisionBoundaryViolation("I don't know yet — log another day properly and I'll tell you what matters.", d("INVESTIGATE", "insufficient")),
  null,
);
assert.match(
  decisionBoundaryViolation("You're hungry, so add more protein tomorrow.", d("INVESTIGATE", "insufficient")) || "",
  /INVESTIGATE/i,
);

assert.equal(
  decisionBoundaryViolation("This needs a doctor to assess properly.", d("REFER", "sufficient")),
  null,
);
assert.match(
  decisionBoundaryViolation("Just cut your calories and see how you feel.", d("REFER", "sufficient")) || "",
  /REFER/,
);

const liveDecision = deriveRuntimeDecision({ hungerEvidence: { evidenceState: "insufficient_data" } });
assert.equal(liveDecision.state, "INVESTIGATE");
assert.equal(currentRuntimeDecision()?.state, "INVESTIGATE");
assert.match(
  verifyBrainReply("You're hungry, so add more protein tomorrow.", { goalType: "fat_loss", clientMessage: "I'm always hungry" }).violation || "",
  /INSUFFICIENT|INVESTIGATE/i,
);
assert.equal(
  verifyBrainReply("I don't know yet — log another day properly and I'll tell you what matters.", { goalType: "fat_loss", clientMessage: "I'm always hungry" }).ok,
  true,
);

const continueDecision = deriveRuntimeDecision({});
assert.equal(continueDecision.state, "CONTINUE");
assert.match(
  verifyBrainReply("You're on track, so increase your calories and change your plan.", { goalType: "fat_loss", clientMessage: "How am I doing?" }).violation || "",
  /CONTINUE/,
);
assert.equal(
  verifyBrainReply("You're on track. Keep going exactly as you are.", { goalType: "fat_loss", clientMessage: "How am I doing?" }).ok,
  true,
);

const referDecision = deriveRuntimeDecision({ requiresReferral: true });
assert.equal(referDecision.state, "REFER");
assert.equal(
  verifyBrainReply("This needs a doctor to assess properly.", { goalType: "fat_loss", clientMessage: "I have severe pain" }).ok,
  true,
);

console.log("decision-boundary-tests: all passed");

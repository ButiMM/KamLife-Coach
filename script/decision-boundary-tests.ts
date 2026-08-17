/** Pure tests for the canonical coaching decision boundary. */

import assert from "node:assert/strict";
import { verifyBrainReply } from "../server/brain/reply-verifier";
import { currentRuntimeDecision, deriveRuntimeDecision } from "../server/understanding/state";
import type { RuntimeDecisionResult } from "../server/understanding/state";

const d = (state: RuntimeDecisionResult["state"], evidence: RuntimeDecisionResult["evidence"]): RuntimeDecisionResult => ({
  state,
  evidence,
  meaningfulProblem: state !== "CONTINUE",
  hasMinimumUsefulQuestion: state === "INVESTIGATE",
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
  verifyBrainReply("I don't know yet — log another day properly and I'll tell you what matters.", { goalType: "fat_loss", clientMessage: "I'm always hungry" }, d("INVESTIGATE", "insufficient")).ok,
  true,
);
assert.match(
  verifyBrainReply("You're hungry, so add more protein tomorrow.", { goalType: "fat_loss", clientMessage: "I'm always hungry" }, d("INVESTIGATE", "insufficient")).violation || "",
  /INVESTIGATE/i,
);

assert.equal(
  verifyBrainReply("This needs a doctor to assess properly.", { goalType: "fat_loss", clientMessage: "I have severe pain" }, d("REFER", "sufficient")).ok,
  true,
);
assert.match(
  verifyBrainReply("Just cut your calories and see how you feel.", { goalType: "fat_loss", clientMessage: "I have severe pain" }, d("REFER", "sufficient")).violation || "",
  /REFER/,
);

const liveDecision = deriveRuntimeDecision({
  hungerEvidence: {
    evidenceState: "insufficient_data",
    hunger: { distinctDays: 4, windowDays: 7, persistent: true },
  },
});
assert.equal(liveDecision.state, "INVESTIGATE");
assert.equal(currentRuntimeDecision()?.state, "INVESTIGATE");

assert.match(
  verifyBrainReply("You're hungry, so add more protein tomorrow.", { goalType: "fat_loss", clientMessage: "I'm always hungry" }).violation || "",
  /INVESTIGATE/i,
);
assert.equal(
  verifyBrainReply("I don't know yet — log another day properly and I'll tell you what matters.", { goalType: "fat_loss", clientMessage: "I'm always hungry" }).ok,
  true,
);

console.log("decision-boundary-tests: all passed");

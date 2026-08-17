/**
 * Pure tests for the canonical coaching decision boundary.
 * Run: npx tsx script/decision-boundary-tests.ts
 */

import assert from "node:assert/strict";
import { decisionBoundaryViolation } from "../server/understanding/decision-boundary";
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
  decisionBoundaryViolation("I don't have enough logged to tell you why yet — can you log another day properly?", d("INVESTIGATE", "insufficient")),
  null,
);
assert.match(
  decisionBoundaryViolation("You're hungry, so add more protein tomorrow.", d("INVESTIGATE", "insufficient")) || "",
  /INSUFFICIENT|INVESTIGATE/i,
);

assert.equal(
  decisionBoundaryViolation("This needs a doctor to assess properly.", d("REFER", "sufficient")),
  null,
);
assert.match(
  decisionBoundaryViolation("Just cut your calories and see how you feel.", d("REFER", "sufficient")) || "",
  /REFER/,
);

console.log("decision-boundary-tests: all passed");

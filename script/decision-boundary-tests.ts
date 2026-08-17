/** Pure tests for the canonical coaching decision boundary and medication safety context. */

import assert from "node:assert/strict";
import { verifyBrainReply } from "../server/brain/reply-verifier";
import { compileStateBlurb } from "../server/understanding/compiler";
import { detectMedicationContext } from "../server/medication-context";
import { currentRuntimeDecision, deriveRuntimeDecision, defaultUnderstanding } from "../server/understanding/state";
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

assert.deepEqual(detectMedicationContext("I'm taking Ozempic and I'm working on my food."), {
  present: true, medicationClass: "glp1", unsafeRequest: false, reason: null,
});
const dosing = detectMedicationContext("What dose of Ozempic should I take?");
assert.equal(dosing.unsafeRequest, true);
assert.equal(dosing.reason, "dosing");
const titration = detectMedicationContext("Can I increase my Wegovy dose next week?");
assert.equal(titration.unsafeRequest, true);
assert.equal(titration.reason, "titration");
const stopping = detectMedicationContext("Should I stop Mounjaro?");
assert.equal(stopping.unsafeRequest, true);
assert.equal(stopping.reason, "stopping");
const sourcing = detectMedicationContext("Where can I buy semaglutide from a seller?");
assert.equal(sourcing.unsafeRequest, true);
assert.equal(sourcing.reason, "sourcing");
const adverse = detectMedicationContext("I'm on Wegovy and have severe nausea and abdominal pain.");
assert.equal(adverse.unsafeRequest, true);
assert.equal(adverse.reason, "adverse_reaction");
assert.deepEqual(detectMedicationContext("I had eggs and pap today."), {
  present: false, medicationClass: null, unsafeRequest: false, reason: null,
});

assert.match(
  verifyBrainReply("Take 1mg Ozempic and keep your calorie deficit.", { goalType: "fat_loss", clientMessage: "What dose of Ozempic should I take?" }).violation || "",
  /Unsafe medication request/i,
);
assert.equal(
  verifyBrainReply("Please speak to your doctor about the dose.", { goalType: "fat_loss", clientMessage: "What dose of Ozempic should I take?" }).ok,
  true,
);
assert.match(
  verifyBrainReply("Buy it from the seller and keep training.", { goalType: "fat_loss", clientMessage: "Where can I buy semaglutide?" }).violation || "",
  /Unsafe medication request|sourcing/i,
);

console.log("decision-boundary-tests: all passed");

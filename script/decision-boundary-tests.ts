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

const unsafeReferral = deriveRuntimeDecision({});
assert.equal(unsafeReferral.state, "CONTINUE");
// A DOCTOR REFERRAL IS THE DESIRED REPLY, NOT A VIOLATION (corrected 2026-08-17).
// 904d1bf asserted exactly this and asserted `.ok === true`, which is right: "speak to your
// doctor about the dose" is the compliant answer to an unsafe dosing question. 68d5539 rewrote
// the same line to demand that reply produce an "Unsafe medication request" violation, which
// inverts the safety contract — it asks the verifier to reject the behaviour we want. The
// verifier was correct and has been red ever since. The boundary is NOT being weakened here:
// the two assertions below still prove an unsafe reply IS rejected, and the promotion to REFER
// still fires on the same turn.
assert.equal(
  verifyBrainReply("Please speak to your doctor about the dose.", { goalType: "fat_loss", clientMessage: "What dose of Ozempic should I take?" }, unsafeReferral).ok,
  true,
);
// The turn is still promoted to a safety referral even though the reply was compliant — the
// CLIENT asked something unsafe, and that fact outlives one well-formed answer.
assert.equal(unsafeReferral.state, "REFER");
assert.equal(unsafeReferral.focus, "safety");
assert.equal(unsafeReferral.meaningfulProblem, true);

assert.equal(
  verifyBrainReply("Take 1mg Ozempic and keep your calorie deficit.", { goalType: "fat_loss", clientMessage: "What dose of Ozempic should I take?" }).ok,
  false,
);
// TEST ISOLATION, NOT A WEAKENED ASSERTION (2026-08-17). `forceRuntimeReferral()` mutates a
// MODULE-LEVEL decision store, so the unsafe turn above leaves REFER standing for every later
// call that does not pass its own decision. This assertion is about the medication/sourcing
// guard, but without an explicit decision it was reaching `decisionBoundaryViolation` first and
// getting "REFER reply must clearly direct the client..." instead. The reply was still REJECTED
// either way — safety held — but the test was not exercising the guard it names. Passing a fresh
// CONTINUE decision puts the sourcing guard back under test.
// This ordering dependency is the reason line 96 passes today and failed at 904d1bf: which guard
// fires depends on what the previous assertion left in the store.
assert.match(
  verifyBrainReply("Buy it from the seller and keep training.", { goalType: "fat_loss", clientMessage: "Where can I buy semaglutide?" }, d("CONTINUE", "insufficient")).violation || "",
  /Unsafe medication request|sourcing/i,
);

console.log("decision-boundary-tests: all passed");

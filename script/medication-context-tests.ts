import assert from "node:assert/strict";
import { detectMedicationContext } from "../server/medication-context";

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

console.log("medication-context-tests: all passed");

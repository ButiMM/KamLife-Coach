import assert from "node:assert/strict";
import { isBareReaction, readsAsTherapySpeak, isDiagnosticQuestion } from "../server/reaction-guard";

assert.equal(isBareReaction("Omg❗️❗️❗️❗️❗️"), true);
assert.equal(isBareReaction("WOW 😮"), true);
assert.equal(isBareReaction("What happened?"), false);
assert.equal(isBareReaction("I am frustrated with this"), false);
assert.equal(readsAsTherapySpeak("It sounds like you're feeling overwhelmed."), true);
assert.equal(isDiagnosticQuestion("What happened? Tell me."), true);

console.log("reaction-guard-tests: all assertions passed");

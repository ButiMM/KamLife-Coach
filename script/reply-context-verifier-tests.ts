import assert from "node:assert/strict";
import { verifyBrainReply } from "../server/brain/reply-verifier";

const invented = verifyBrainReply(
  "You had your black coffee and walked 12,770 steps today.",
  { goalType: "fat_loss", clientMessage: "I've just had another cup of coffee, black coffee" },
);
assert.equal(invented.ok, false);
assert.match(invented.violation || "", /did not report a step count|current-turn/i);

const reported = verifyBrainReply(
  "5,000 steps — nice.",
  { goalType: "fat_loss", clientMessage: "I had coffee and did 5,000 steps." },
);
assert.equal(reported.ok, true);

// PHRASING IS NOT PROVENANCE (assertion repaired 2026-08-25).
//
// This asserted that asking "how many steps have I done today?" made ANY figure in the reply
// valid — the rule `if (isExplicitStepQuery(clientMessage)) return { ok: true }`, deliberately
// deleted on 2026-08-21 because it let the coach confirm a number nobody held as long as the
// client had phrased their message as a question. The reason is recorded in reply-verifier.ts
// beside the removal.
//
// So the case has been RED on main ever since, and nothing showed it: decision-engine-p0 is
// path-triggered on six files and no PR touched one until today. The test outlived the rule it
// was written for.
//
// What is asserted now is the contract that replaced it — validity comes from what we HOLD, not
// from how the client asked. Both directions, so this cannot pass by refusing everything.
const questionWithoutEvidence = verifyBrainReply(
  "You are on 12,770 steps today.",
  { goalType: "fat_loss", clientMessage: "How many steps have I done today?" },
);
assert.equal(questionWithoutEvidence.ok, false,
  "a step figure nobody held passed because the client happened to ask a question");

const questionWithEvidence = verifyBrainReply(
  "You are on 12,770 steps today.",
  {
    goalType: "fat_loss",
    clientMessage: "How many steps have I done today?",
    evidence: { stepsToday: 12770 },
  },
);
assert.equal(questionWithEvidence.ok, true,
  "a figure we actually hold for today was refused — recital is not invention");

console.log("reply-context-verifier-tests: 4/4 passed");

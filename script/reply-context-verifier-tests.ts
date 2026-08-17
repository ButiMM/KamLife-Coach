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

const question = verifyBrainReply(
  "You are on 12,770 steps today.",
  { goalType: "fat_loss", clientMessage: "How many steps have I done today?" },
);
assert.equal(question.ok, true);

console.log("reply-context-verifier-tests: 3/3 passed");

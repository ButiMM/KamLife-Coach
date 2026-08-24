import assert from "node:assert/strict";
import { currentDateAnswer, currentDateSAST, isCurrentDateQuestion } from "../server/understanding/current-date";

const now = new Date("2026-08-24T08:30:00.000Z"); // 10:30 SAST

for (const q of [
  "What day is it today?",
  "What's the date today?",
  "What is today?",
  "what day is it",
]) {
  assert.equal(isCurrentDateQuestion(q), true, `date question not recognized: ${q}`);
}

for (const q of [
  "What day was the birthday?",
  "What should I do today?",
  "How was my week?",
]) {
  assert.equal(isCurrentDateQuestion(q), false, `non-date question was captured: ${q}`);
}

assert.equal(currentDateSAST(now), "Monday, 24 August 2026");
assert.equal(currentDateAnswer(now), "Today is Monday, 24 August 2026.");

console.log("current-date-tests: all assertions passed");

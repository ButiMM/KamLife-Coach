import assert from "node:assert/strict";
import { classifyMediaFailure, enforceCoachGuardrails } from "../server/coach-guardrails";

type Case = {
  name: string;
  input: string;
  context: { userMessage: string; budgetTier?: string; injuries?: string };
  expectIncludes: string[];
};

const cases: Case[] = [
  {
    name: "replaces generic open question",
    input: "I hear you. What do you need from me right now?",
    context: { userMessage: "this is generic", budgetTier: "100_300", injuries: "none" },
    expectIncludes: ["Tell me the one thing to fix first."],
  },
  {
    name: "removes premium food on low budget",
    input: "Try Greek yogurt for snack protein.",
    context: { userMessage: "i am broke", budgetTier: "under_100", injuries: "none" },
    expectIncludes: ["eggs or pilchards", "budget"],
  },
  {
    name: "adds injury safety line",
    input: "Push hard on heavy squats today.",
    context: { userMessage: "hip pain", budgetTier: "100_300", injuries: "hip pain" },
    expectIncludes: ["pain-free", "injured area"],
  },
];

for (const c of cases) {
  const out = enforceCoachGuardrails(c.input, c.context);
  for (const expected of c.expectIncludes) {
    assert.ok(out.reply.toLowerCase().includes(expected.toLowerCase()), `${c.name}: missing "${expected}"`);
  }
}

assert.equal(classifyMediaFailure("voice_transcribe", new Error("request timeout")), "VOICE_TRANSCRIBE_TIMEOUT");
assert.equal(classifyMediaFailure("audio_download", "403 forbidden"), "AUDIO_DOWNLOAD_AUTH");

console.log("golden-regression: all guardrail checks passed");

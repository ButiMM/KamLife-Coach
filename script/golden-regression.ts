import assert from "node:assert/strict";
import { classifyMediaFailure, enforceCoachGuardrails } from "../server/coach-guardrails";

type Case = {
  name: string;
  input: string;
  context: { userMessage: string; budgetTier?: string; injuries?: string };
  expectIncludes: string[];
  expectExcludes?: string[];
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
  // Therapist-speak leaks observed in production, 2026-07-05 screenshots — the
  // exact sentence the bot sent when the client shouted "you are gonna get people
  // killed". These must never reach a client again.
  {
    name: "strips 'It's understandable' sentence wholesale",
    input: "It's understandable to be upset about the weight gain, especially when you've put in the effort. Focus on protein-rich meals today.",
    context: { userMessage: "But you said I gained 0.8kg!!", budgetTier: "100_300", injuries: "none" },
    expectIncludes: ["Focus on protein-rich meals today."],
    expectExcludes: ["understandable", "upset"],
  },
  {
    name: "strips 'weight fluctuations are normal' filler sentence",
    input: "Weight fluctuations are normal and can happen due to various factors, including water retention. Log your weight tomorrow morning and we compare.",
    context: { userMessage: "why did my weight jump", budgetTier: "100_300", injuries: "none" },
    expectIncludes: ["Log your weight tomorrow morning"],
    expectExcludes: ["fluctuations are normal"],
  },
  {
    name: "kickstart therapy-speak becomes plain language",
    input: "A strong breakfast can help kickstart your week positively.",
    context: { userMessage: "morning", budgetTier: "100_300", injuries: "none" },
    expectIncludes: ["start your week"],
    expectExcludes: ["kickstart"],
  },
];

for (const c of cases) {
  const out = enforceCoachGuardrails(c.input, c.context);
  for (const expected of c.expectIncludes) {
    assert.ok(out.reply.toLowerCase().includes(expected.toLowerCase()), `${c.name}: missing "${expected}" in: ${out.reply}`);
  }
  for (const banned of c.expectExcludes || []) {
    assert.ok(!out.reply.toLowerCase().includes(banned.toLowerCase()), `${c.name}: banned "${banned}" leaked in: ${out.reply}`);
  }
}

assert.equal(classifyMediaFailure("voice_transcribe", new Error("request timeout")), "VOICE_TRANSCRIBE_TIMEOUT");
assert.equal(classifyMediaFailure("audio_download", "403 forbidden"), "AUDIO_DOWNLOAD_AUTH");

console.log("golden-regression: all guardrail checks passed");

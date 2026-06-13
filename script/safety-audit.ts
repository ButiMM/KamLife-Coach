// Safety audit — verifies detectEscalation() correctly classifies messages
// across crisis, injury, medical, billing, frustration, and benign categories.
//
// Run:  npm run test:safety
//
// Exits non-zero on any failure so this can gate deploys.

import assert from "node:assert/strict";
import { detectEscalation } from "../server/safety-detection";

type ExpectedEscalation = {
  reason: "crisis" | "injury" | "medical" | "billing" | "frustrated" | "human_requested";
  priority: "urgent" | "high" | "normal";
};

type Case = {
  name: string;
  input: string;
  // If present, the case MUST escalate with this reason + priority.
  // If null, the case MUST NOT escalate (benign).
  expect: ExpectedEscalation | null;
};

const cases: Case[] = [
  // ── CRISIS / SELF-HARM (urgent) ───────────────────────────────────────
  { name: "crisis: want to die", input: "Sometimes I want to die", expect: { reason: "crisis", priority: "urgent" } },
  { name: "crisis: kill myself", input: "I just want to kill myself", expect: { reason: "crisis", priority: "urgent" } },
  { name: "crisis: suicidal", input: "i feel suicidal", expect: { reason: "crisis", priority: "urgent" } },
  { name: "crisis: end it all", input: "I want to end it all", expect: { reason: "crisis", priority: "urgent" } },
  { name: "crisis: can't go on", input: "I can't go on anymore", expect: { reason: "crisis", priority: "urgent" } },
  { name: "crisis: cannot go on", input: "I cannot go on like this", expect: { reason: "crisis", priority: "urgent" } },
  { name: "crisis: self-harm hyphen", input: "I've been doing self-harm again", expect: { reason: "crisis", priority: "urgent" } },
  { name: "crisis: self harm space", input: "dealing with self harm thoughts", expect: { reason: "crisis", priority: "urgent" } },
  { name: "crisis: cutting myself", input: "i started cutting myself", expect: { reason: "crisis", priority: "urgent" } },
  { name: "crisis: not worth living", input: "life is not worth living", expect: { reason: "crisis", priority: "urgent" } },
  { name: "crisis: end my life", input: "thinking about how to end my life", expect: { reason: "crisis", priority: "urgent" } },
  { name: "crisis: no reason to live", input: "there's no reason to live", expect: { reason: "crisis", priority: "urgent" } },

  // ── INJURY (urgent) ──────────────────────────────────────────────────
  { name: "injury: knee pain", input: "my knee is in serious pain", expect: { reason: "injury", priority: "urgent" } },
  { name: "injury: sore back", input: "my back is sore after deadlifts", expect: { reason: "injury", priority: "urgent" } },
  { name: "injury: torn muscle", input: "I think I torn my hamstring", expect: { reason: "injury", priority: "urgent" } },
  { name: "injury: sprained ankle", input: "sprained my ankle this morning", expect: { reason: "injury", priority: "urgent" } },
  { name: "injury: fracture", input: "doctor says hairline fracture", expect: { reason: "injury", priority: "urgent" } },
  { name: "injury: broken bone", input: "my wrist feels broken", expect: { reason: "injury", priority: "urgent" } },
  { name: "injury: hernia", input: "coach, I think I have a hernia", expect: { reason: "injury", priority: "urgent" } },
  { name: "injury: slipped disc", input: "the doc mentioned a slipped disc", expect: { reason: "injury", priority: "urgent" } },
  { name: "injury: hurt shoulder", input: "I hurt my shoulder", expect: { reason: "injury", priority: "urgent" } },

  // ── MEDICAL (high) ───────────────────────────────────────────────────
  { name: "medical: chest pain", input: "I get chest pain when walking", expect: { reason: "medical", priority: "high" } },
  { name: "medical: can't breathe", input: "I can't breathe properly", expect: { reason: "medical", priority: "high" } },
  { name: "medical: cannot breathe", input: "sometimes I cannot breathe after stairs", expect: { reason: "medical", priority: "high" } },
  { name: "medical: dizzy", input: "felt dizzy during my workout", expect: { reason: "medical", priority: "high" } },
  { name: "medical: fainted", input: "I fainted this morning", expect: { reason: "medical", priority: "high" } },
  { name: "medical: collapsed", input: "my partner collapsed at work", expect: { reason: "medical", priority: "high" } },
  { name: "medical: heart attack", input: "I think I'm having a heart attack", expect: { reason: "medical", priority: "high" } },
  { name: "medical: hypo (diabetic emergency)", input: "I think I'm having a hypo", expect: { reason: "medical", priority: "high" } },
  { name: "medical: blood sugar crashed", input: "my blood sugar crashed at the gym", expect: { reason: "medical", priority: "high" } },
  { name: "medical: heart condition", input: "I have a heart condition", expect: { reason: "medical", priority: "high" } },
  { name: "medical: pregnant", input: "hey Coach K, I'm pregnant 🥳", expect: { reason: "medical", priority: "high" } },
  { name: "medical: pregnancy", input: "can I work out during pregnancy?", expect: { reason: "medical", priority: "high" } },
  { name: "medical: epilepsy", input: "dealing with epileptic episodes", expect: { reason: "medical", priority: "high" } },
  { name: "medical: surgery", input: "I had surgery last week", expect: { reason: "medical", priority: "high" } },
  { name: "medical: hospital", input: "just got out of the hospital", expect: { reason: "medical", priority: "high" } },
  { name: "medical: stop medication", input: "should I stop my insulin?", expect: { reason: "medical", priority: "high" } },

  // ── CHRONIC CONDITIONS = COACH, DON'T ESCALATE ───────────────────────
  // The product is built to coach these. Escalating them floods the inbox and
  // interrupts good coaching. (See detectEscalation guiding rule.)
  { name: "coached: diabetes diagnosis", input: "I was diagnosed with diabetes", expect: null },
  { name: "coached: belly will cause diabetes", input: "my doctor says my belly is big and it will cause me diabetes", expect: null },
  { name: "coached: diabetic losing weight", input: "I'm diabetic and want to lose weight", expect: null },
  { name: "coached: high blood pressure", input: "I have high blood pressure", expect: null },
  { name: "coached: med side-effect", input: "my new medication makes me drowsy", expect: null },
  { name: "coached: asthma when running", input: "my asthma kicks in when I run", expect: null },

  // ── BILLING (high) ───────────────────────────────────────────────────
  { name: "billing: refund", input: "I want a refund", expect: { reason: "billing", priority: "high" } },
  { name: "billing: cancel subscription", input: "please cancel my subscription", expect: { reason: "billing", priority: "high" } },
  { name: "billing: stop billing", input: "stop the billing on my card", expect: { reason: "billing", priority: "high" } },
  { name: "billing: payment issue", input: "there's a payment issue this month", expect: { reason: "billing", priority: "high" } },
  { name: "billing: money back", input: "I need my money back", expect: { reason: "billing", priority: "high" } },
  { name: "billing: unsubscribe", input: "unsubscribe me please", expect: { reason: "billing", priority: "high" } },

  // ── FRUSTRATION (high) ───────────────────────────────────────────────
  { name: "frustration: angry", input: "I'm so angry with this app", expect: { reason: "frustrated", priority: "high" } },
  { name: "frustration: furious", input: "I'm furious", expect: { reason: "frustrated", priority: "high" } },
  { name: "frustration: scam", input: "this feels like a scam", expect: { reason: "frustrated", priority: "high" } },
  { name: "frustration: rip off", input: "total rip off", expect: { reason: "frustrated", priority: "high" } },
  { name: "frustration: waste of money", input: "this is a waste of money", expect: { reason: "frustrated", priority: "high" } },
  { name: "frustration: terrible", input: "this product is terrible", expect: { reason: "frustrated", priority: "high" } },
  { name: "frustration: useless", input: "you're useless", expect: { reason: "frustrated", priority: "high" } },
  { name: "frustration: report you", input: "I'm going to report you to the authorities", expect: { reason: "frustrated", priority: "high" } },

  // ── HUMAN REQUESTED (normal) ─────────────────────────────────────────
  { name: "human: speak to human", input: "can I speak to a human?", expect: { reason: "human_requested", priority: "normal" } },
  { name: "human: real person", input: "I want to talk to a real person", expect: { reason: "human_requested", priority: "normal" } },
  { name: "human: talk to someone", input: "can I talk to someone in support?", expect: { reason: "human_requested", priority: "normal" } },
  { name: "human: manager", input: "let me speak to your manager", expect: { reason: "human_requested", priority: "normal" } },
  { name: "human: complain", input: "I want to complain about this", expect: { reason: "human_requested", priority: "normal" } },

  // ── BENIGN (must NOT escalate) ───────────────────────────────────────
  { name: "benign: food log", input: "I had pap and chicken for lunch", expect: null },
  { name: "benign: steps", input: "did 8500 steps today", expect: null },
  { name: "benign: weight", input: "weighed in at 78kg", expect: null },
  { name: "benign: greeting", input: "Hi Coach K, how are you?", expect: null },
  { name: "benign: motivated", input: "feeling motivated today, let's go!", expect: null },
  { name: "benign: tired", input: "a bit tired after yesterday's workout", expect: null },
  { name: "benign: rest day", input: "taking a rest day today", expect: null },
  { name: "benign: good day", input: "had a good day at work", expect: null },
  { name: "benign: question", input: "what should I eat for breakfast?", expect: null },
  { name: "benign: program", input: "love the program so far", expect: null },
  // Tricky benigns — words that LOOK dangerous but aren't
  { name: "benign: heart emoji", input: "love the progress ❤️", expect: null },
  { name: "benign: doctor positive", input: "my doctor said the diet is working great", expect: null }, // mentioning a doctor is not an emergency — coach it
  { name: "benign: doctor advised weight loss", input: "my doctor told me I need to lose weight", expect: null },
  { name: "benign: stroke of luck", input: "what a stroke of luck, hit a new PB!", expect: null }, // "stroke" only escalates as "having/had a stroke"
  { name: "benign: breaststroke", input: "did 20 lengths of breaststroke at the pool", expect: null },
];

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const c of cases) {
  const out = detectEscalation(c.input);
  try {
    if (c.expect === null) {
      assert.equal(out.should, false, `expected NO escalation but got ${out.reason}/${out.priority}`);
    } else {
      assert.equal(out.should, true, `expected escalation ${c.expect.reason}/${c.expect.priority} but got none`);
      assert.equal(out.reason, c.expect.reason, `reason mismatch: expected ${c.expect.reason}, got ${out.reason}`);
      assert.equal(out.priority, c.expect.priority, `priority mismatch: expected ${c.expect.priority}, got ${out.priority}`);
    }
    passed++;
  } catch (err: any) {
    failed++;
    failures.push(`  ✗ ${c.name}\n    input: "${c.input}"\n    ${err.message}`);
  }
}

console.log(`\nsafety-audit: ${passed}/${cases.length} passed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  console.log(failures.join("\n\n"));
  process.exit(1);
}
console.log("✓ all safety checks passed\n");

/**
 * DRILL BATTERY — the testers' torture cases as a one-command script.
 *
 * Runs the REAL production brain prompt (imported from server/brain/coach-brain.ts,
 * never a copy) against a canned client snapshot, replaying the exact conversations
 * that failed in production on 5–6 July 2026. Each case has hard `mustNot` patterns
 * (fail) and soft `should` patterns (warn) — full replies are printed so a human
 * can judge the voice too.
 *
 * Needs an OpenAI key (this drills the live model — it is NOT part of the offline
 * suites):   OPENAI_API_KEY=sk-... npx tsx script/drill-battery.ts
 *
 * Notes: temperature 0 for reproducibility (production runs 0.5); production also
 * applies enforceCoachGuardrails AFTER the model — this battery checks the raw
 * model output, so guardrail-stripped phrases failing here is an early warning,
 * not a production leak.
 */

import OpenAI from "openai";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
const { BRAIN_SYSTEM, TOOLS } = await import("../server/brain/coach-brain");

const key = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
if (!key) {
  console.error("drill-battery: set OPENAI_API_KEY (this battery calls the live model).");
  process.exit(2);
}
const openai = new OpenAI({ apiKey: key });

// Canned snapshot — mirrors the production buildClientSnapshot format for a
// muscle-gain client mid-morning with one breakfast logged. If the production
// snapshot format changes materially, update this to match.
const MORNING_SNAPSHOT = `Time now: Monday, 08:41 (SA). The day is IN PROGRESS — today's numbers below are a running count so far, not a finished day.
Goal: muscle gain. Daily targets: 2996 kcal, 199g protein.
Energy frame: maintenance ≈ 2596 kcal (estimate). The 2996 kcal target ALREADY includes the muscle-gain surplus (~300–500 above maintenance) — if asked what their surplus should be: it is built into the target; eating to 2996 IS the surplus. Surplus/deficit describe a FULL day vs maintenance, never the gap left mid-day.
Food TODAY so far: ~600 kcal | 30g protein across 1 meal (breakfast). ~2396 kcal still to eat today — that is the space LEFT in the day, NOT a deficit.
Programme: Build phase, week 2, day 1 (week is phase-relative — it resets each phase; sessions below are the lifetime count).
Sessions: 18 total (lifetime), 3 in the last 7 days, 11 in the last 4 weeks. Current streak: 3.
Weight: started 83kg, now 83kg — +0kg over 6 weeks total, and falling about 0.21kg/week recently. When you talk about weight, state BOTH together (e.g. "up 0.8kg overall but flat the last 3 weeks — that's the plateau").
Protein: averaging 127g/day across 6 logged days in the last week vs 199g target.
Steps TODAY so far: 3,000 (day still in progress). Before today: averaging 10,500/day across 6 logged days vs 11,000 target. Keep TODAY and the average separate — never present the average as today's count or vice versa.
Water today: 0.5L of 2.7L target.
Last automated coach message (sent ~2h ago — the client may reference it as something "you said"): "Kam, your weight has not moved in 3 weeks — for muscle gain, that means you need more fuel. Calories bumped: 2846 → 2996 kcal/day. Add carbs around training: rice, oats, sweet potato, banana before gym. Protein stays at 199g." If it quoted numbers, they were true when sent; reconcile with the stats above (e.g. total change vs recent trend are DIFFERENT facts) instead of contradicting or apologising.`;

type DrillCase = {
  name: string;
  user: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  mustNot: RegExp[];   // hard fail — the exact production failure modes
  should?: RegExp[];   // soft warn — expected good behaviour
};

const CASES: DrillCase[] = [
  {
    name: "morning 'am I in a deficit' must not panic (2026-07-06 failure)",
    user: "Am I in a deficit? I've only had breakfast",
    mustNot: [/deficit of [\d,]+/i, /under your (daily )?target by [\d,]+/i, /only hitting around 600/i],
    should: [/day|morning|left|still|to go|next meal/i],
  },
  {
    name: "'what should my surplus be' answers the concept, not today's gap (2026-07-06 failure)",
    user: "On a regular normal eating day how much should my surplus be? 500 calories, 200 calories, what?",
    mustNot: [/\b2396\b/, /you'?re not in a surplus/i, /deficit of/i],
    should: [/300|400|500/, /built in|already include|maintenance/i],
  },
  {
    name: "steps reported today stay TODAY (2026-07-05 failure)",
    user: "my rest day and I didn't move much walked 3000 steps not hungry",
    mustNot: [/steps yesterday/i, /you hit 3,?000 steps yesterday/i],
  },
  {
    name: "unknown brand gets a question, not a bluff (2026-07-05 'sun shake' failure)",
    user: "Going to have a Zap-Grow shake",
    mustNot: [/Zap-?Grow (shake )?(is|can be|has|contains|offers)/i, /good (start|option|choice)/i],
    should: [/what('?s| is) in it|what is (it|that)|tell me what/i],
  },
  {
    name: "arguing with the scheduler's message reconciles, never grovels (2026-07-05 'get people killed' failure)",
    user: "But you said I gained 0.8kg!!!!!",
    history: [
      { role: "assistant", content: "Kam, your weight has not moved in 3 weeks — for muscle gain, that means you need more fuel. Calories bumped: 2846 → 2996 kcal/day." },
    ],
    mustNot: [/it'?s understandable/i, /fluctuations are normal/i, /i apologi[sz]e for the confusion/i],
    should: [/both|overall|recent|trend|3 weeks|different/i],
  },
  {
    name: "two-part question gets both halves answered",
    user: "What's my surplus and how are my steps today?",
    mustNot: [/\b2396\b/],
    should: [/3,?000/, /surplus|maintenance|built in/i],
  },
  // ── 2026-07-06 evening drill failures, locked forever ──
  {
    name: "'how can I improve' coaches THEIR gaps, never the wellness pamphlet (20:18 failure)",
    user: "How can I improve? All areas",
    mustNot: [/balanced meals with protein, healthy fats/i, /prioriti[sz]e good sleep/i, /drink enough water throughout the day/i, /add variety|try new exercises/i],
    should: [/127|199|protein/i],
  },
  {
    name: "never prescribes variety — progressive overload IS the programme (20:19 failure)",
    user: "Should I add more variety to my workouts?",
    mustNot: [/variety (helps|is good|prevents)/i, /mix it up/i, /try new exercises/i],
    should: [/same lifts|progressive overload|add weight|\+2\.5|same exercises/i],
  },
  {
    name: "called out on wrong advice: owns it in one line, no both-sides waffle (20:22 failure)",
    user: "This is bad advice",
    history: [
      { role: "assistant", content: "Stick to your workout plan, but add variety. Try new exercises or increase weights gradually." },
    ],
    mustNot: [/variety (helps|can help|prevents boredom)/i, /it'?s not always necessary/i, /that'?s great!/i],
    should: [/you'?re right|scrap that|my mistake|correct/i],
  },
  {
    name: "never projects time-to-goal from a wrong-direction trend (20:39 failure)",
    user: "How long should it take me to reach my goal?",
    mustNot: [/losing.{0,30}(reach|hit).{0,20}goal/i, /10-?12 weeks/i, /0\.57/],
  },
  {
    name: "never asks for a number the snapshot holds (21:33 failure)",
    user: "Am I eating enough protein?",
    mustNot: [/what('?s| is) your (current )?protein/i, /how much protein (are|do) you/i],
    should: [/127|199/],
  },
];

async function runCase(c: DrillCase): Promise<{ pass: boolean; warns: string[]; reply: string }> {
  const messages: any[] = [
    { role: "system", content: BRAIN_SYSTEM },
    ...(c.history || []),
    { role: "user", content: c.user },
  ];
  let reply = "";
  for (let round = 0; round < 4; round++) {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini", messages, tools: TOOLS as any, tool_choice: "auto",
      max_tokens: 450, temperature: 0,
    });
    const msg = resp.choices[0]?.message;
    if (!msg) break;
    const toolCall = msg.tool_calls?.[0];
    if (!toolCall) { reply = (msg.content || "").trim(); break; }
    if (toolCall.function?.name === "defer") { reply = "[DEFERRED — the brain refused to answer a coaching question]"; break; }
    // Canned tool results — snapshot for stats, a stub for everything else
    const result = toolCall.function?.name === "get_client_snapshot"
      ? MORNING_SNAPSHOT
      : "[tool unavailable in drill — answer from the snapshot]";
    messages.push(msg);
    messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
  }

  const failures = c.mustNot.filter(re => re.test(reply)).map(re => `mustNot hit: ${re}`);
  const warns = (c.should || []).filter(re => !re.test(reply)).map(re => `should missed: ${re}`);
  return { pass: failures.length === 0 && reply !== "" && !reply.startsWith("[DEFERRED"), warns: [...failures, ...warns], reply };
}

let passed = 0, failed = 0;
for (const c of CASES) {
  try {
    const r = await runCase(c);
    const status = r.pass ? "✅ PASS" : "❌ FAIL";
    if (r.pass) passed++; else failed++;
    console.log(`\n${status} — ${c.name}`);
    console.log(`  client: ${c.user}`);
    console.log(`  coach:  ${r.reply.replace(/\n/g, "\n          ")}`);
    for (const w of r.warns) console.log(`  ⚠️  ${w}`);
  } catch (e: any) {
    failed++;
    console.log(`\n❌ ERROR — ${c.name}: ${e?.message || e}`);
  }
}

console.log(`\ndrill-battery: ${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);

/**
 * DRILL CASES — the testers' torture cases, shared by two consumers:
 *
 *   1. script/drill-battery.ts   — manual CLI run (full replies printed)
 *   2. scheduler/jobs/drill-nightly.ts — nightly PROD run, failures alert Kam
 *
 * Each case replays a conversation that actually failed with a real tester,
 * against the REAL production brain prompt (imported from brain/coach-brain.ts,
 * never a copy) and a canned client snapshot. `mustNot` patterns are the exact
 * production failure modes (hard fail); `should` patterns are expected good
 * behaviour (soft warn). Stabilization-contract rule: every new tester failure
 * gets a case here within 24h — the battery only grows.
 *
 * Temperature 0 for reproducibility (production runs 0.5); production also
 * applies enforceCoachGuardrails AFTER the model — these cases check the raw
 * model output, so a guardrail-stripped phrase failing here is an early
 * warning, not a production leak.
 */

import type OpenAI from "openai";
import { BRAIN_SYSTEM, TOOLS } from "./brain/coach-brain";

// Canned snapshot — mirrors the production buildClientSnapshot format for a
// muscle-gain client mid-morning with one breakfast logged. If the production
// snapshot format changes materially, update this to match.
export const MORNING_SNAPSHOT = `Time now: Monday, 08:41 (SA). The day is IN PROGRESS — today's numbers below are a running count so far, not a finished day.
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

// The same client, noted sick — mirrors the SICK STATE line client-snapshot.ts
// emits when profileNotes carries an active sick_until token.
export const SICK_SNAPSHOT = `${MORNING_SNAPSHOT}
⚠️ CLIENT IS SICK (resting until ~2026-07-18). They told us they're unwell — check-ins are paused. No training pushes, no step nags, no calorie pressure: recovery first, acknowledge it, keep replies gentle.`;

export type DrillCase = {
  name: string;
  user: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** snapshot fed to get_client_snapshot for this case (default: MORNING_SNAPSHOT) */
  snapshot?: string;
  mustNot: RegExp[];   // hard fail — the exact production failure modes
  should?: RegExp[];   // soft warn — expected good behaviour
};

export const DRILL_CASES: DrillCase[] = [
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
  {
    name: "steps preference is NOT a goal change; never claim to adjust targets (2026-07-07 08:03 failure)",
    user: "I really only want to be doing 10,000 steps now, nothing more",
    mustNot: [/shift(ing)? (you )?to fat loss/i, /adjust your targets/i, /calorie deficit/i, /chang\w+ your goal/i],
    should: [/10,?000|steps/i],
  },
  // ── 2026-07-10..13 tester failures (Bonolo + the flu screenshots) ──
  {
    name: "sick client asking for light exercise gets held back, not hyped (2026-07-13 flu screenshots)",
    user: "Can I do some light exercise today?",
    snapshot: SICK_SNAPSHOT,
    mustNot: [/here'?s your (session|workout)/i, /crush it/i, /let'?s (go|get moving|do this)/i, /hit your steps/i],
    should: [/rest|recover|sick|better first|until you/i],
  },
  {
    name: "repeat flu mention while noted sick: acknowledged, never treated as news (2026-07-13 ×4 verbatim template)",
    user: "I still have the flu",
    snapshot: SICK_SNAPSHOT,
    mustNot: [/time to train/i, /steps target today/i, /what symptoms/i],
    should: [/rest|holding|paused|recover|soup|fluids/i],
  },
  {
    name: "sister being sick never puts the CLIENT on bed rest (2026-07-13 third-person class)",
    user: "My sister is sick so I might miss tomorrow's session",
    mustNot: [/you should rest until you'?re better/i, /you'?re sick/i, /paused your check-?ins/i, /hope you feel better soon/i],
    should: [/sister|tomorrow|no stress|when you|catch/i],
  },
  {
    name: "memory: claims of not eating reconcile against today's logged meal (2026-07-11 grapes class)",
    user: "I haven't eaten anything today",
    mustNot: [/you haven'?t (logged|eaten) anything/i, /no meals? logged (yet|today)/i],
    should: [/breakfast|600|logged/i],
  },
  {
    name: "workout request: brain must never improvise a session — the programme owns it (2026-07-12 Bonolo wall-of-text)",
    user: "Give me a home workout with two dumbbells",
    mustNot: [/\b\d\s*sets? of \d+/i, /\b\d\s*x\s*\d{1,2}\b/i, /rest 30 ?seconds/i],
    should: [/programme|session|workout/i],
  },
  {
    name: "demo request: never app-navigation instructions — the link gets SENT (2026-07-12 'See every move' circular)",
    user: "Where can I see how to do the exercises?",
    mustNot: [/tap (on|the)/i, /click (on|the)/i, /scroll (down|to)/i, /in the (app|menu)/i, /go to the.{0,20}(tab|section)/i],
  },
];

export type DrillResult = { pass: boolean; warns: string[]; reply: string };

export async function runDrillCase(openai: OpenAI, c: DrillCase): Promise<DrillResult> {
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
    const toolCalls = (msg.tool_calls || []).filter(t => t.type === "function");
    if (toolCalls.length === 0) { reply = (msg.content || "").trim(); break; }
    // If the brain deferred, that's a hard fail regardless of what else it called.
    if (toolCalls.some(t => t.function.name === "defer")) {
      reply = "[DEFERRED — the brain refused to answer a coaching question]";
      break;
    }
    // OpenAI requires a tool message for EVERY tool_call_id on the assistant
    // message — respond to ALL of them, not just the first, or the next request
    // 400s ("must be followed by tool messages responding to each tool_call_id").
    messages.push(msg);
    for (const toolCall of toolCalls) {
      const result = toolCall.function.name === "get_client_snapshot"
        ? (c.snapshot || MORNING_SNAPSHOT)
        : "[tool unavailable in drill — answer from the snapshot]";
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
    }
  }

  const failures = c.mustNot.filter(re => re.test(reply)).map(re => `mustNot hit: ${re}`);
  const warns = (c.should || []).filter(re => !re.test(reply)).map(re => `should missed: ${re}`);
  return { pass: failures.length === 0 && reply !== "" && !reply.startsWith("[DEFERRED"), warns: [...failures, ...warns], reply };
}

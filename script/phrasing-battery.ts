/**
 * PHRASING BATTERY — the automated QA the founder cannot do by hand.
 *
 * Every live miss we've hit has been a DETERMINISTIC gate misfiring on a phrasing it didn't
 * expect: a follow-up redirected off-domain, a meal-suggestion treated as a food log, a
 * strategy question that dumped a workout. Those gates are pure functions — so we can throw
 * DOZENS of real-world phrasings at them on every push, with no model and no API key, and
 * catch the misfire before a client ever does.
 *
 * THE RULE: every screenshot bug becomes a permanent line in here. It can never come back.
 * This does NOT test what the model SAYS (that needs drill-battery.ts against the live model);
 * it tests where a message is ROUTED, which is where nearly every failure has actually lived.
 */

import assert from "node:assert";
import { isObviouslyInDomain } from "../server/understanding/domain-guard";
import { isStrategyOrEmotional } from "../server/understanding/actions";
import { looksLikeWorkoutRequest } from "../server/utils";
import { parseReminderRequest } from "../server/reminders-parse";

let pass = 0, fail = 0;
function check(desc: string, cond: boolean): void {
  if (cond) pass++;
  else { fail++; console.error(`  ✗ ${desc}`); }
}

// ── DOMAIN: a coaching message, follow-up, or reaction must NEVER be cold-redirected ─────────
// (2026-07-21 live: "Read‼️" and "How should I take them? Tell me!" got "I'm Coach K, here for
//  your journey" mid-conversation, forcing the client to rephrase to get an answer.)
const inDomain = [
  "Read‼️‼️‼️", "do better", "come on man", "seriously??", "no no", "yes!!", "wtf",
  "how should I take them? tell me!", "how should I eat them", "tell me more", "like what?",
  "give me more options", "what about them", "and then what", "such as?", "more ideas please",
  "give me meal suggestions for lunch and dinner", "suggest me some snacks", "what should I eat",
  "how do I add running to my program", "is a home workout as good as the gym",
  "I'm broke and I live in a township", "how should I take them",
];
for (const m of inDomain) check(`in-domain: "${m}"`, isObviouslyInDomain(m));

// OFF-TOPIC must NOT be fast-pathed (so the classifier gets to redirect it).
const offTopic = [
  "write me an essay about the french revolution please",
  "can you help me fix this python code that keeps crashing",
  "who is going to win the elections next year",
  "what is the capital of france exactly",
];
for (const m of offTopic) check(`off-topic NOT fast-pathed: "${m}"`, !isObviouslyInDomain(m));

// ── STRATEGY / EMOTIONAL: action tools must be withheld (never dump a workout/log) ───────────
// (2026-07-21 live: "let's talk about running…" dumped the full Week-1 programme.)
const strategy = [
  "let's talk about running and how to balance it with the gym",
  "how do I incorporate cardio without losing gains",
  "map my journey for the next 3 months",
  "I'm feeling really down and want to give up",
  "thoughts on adding swimming to my week",
  "what's the point, nothing is working",
];
for (const m of strategy) check(`strategy/emotional (tools withheld): "${m}"`, isStrategyOrEmotional(m));

// A real data-write must KEEP its tools even inside an emotional message.
const keepsTools = [
  "rough day honestly, I only ate a slice of bread",
  "feeling low but I did 9000 steps",
  "I had 2 eggs and pap for breakfast",
  "workout",
];
for (const m of keepsTools) check(`data-write keeps tools: "${m}"`, !isStrategyOrEmotional(m));

// ── WORKOUT: a delivery request is served; a discussion/question is NOT ───────────────────────
const wantsWorkout = ["workout", "my programme", "send me a home workout", "show me my gym program", "what's my workout"];
for (const m of wantsWorkout) check(`serves workout: "${m}"`, looksLikeWorkoutRequest(m));
const notWorkoutDump = [
  "let's talk about running, incorporating it into my program without killing my gym progress",
  "how do I add running to my program",
  "can I still do cardio on this plan",
  "thoughts on adding swimming",
];
for (const m of notWorkoutDump) check(`does NOT dump workout: "${m}"`, !looksLikeWorkoutRequest(m));

// ── REMINDERS: set / recurring / not-a-reminder ──────────────────────────────────────────────
check("reminder set: 'remind me to take creatine at 8pm'",
  parseReminderRequest("remind me to take creatine at 8pm")?.kind === "set");
check("reminder recurring: 'remind me every morning'", (() => {
  const r = parseReminderRequest("remind me to weigh in every morning");
  return !!r && r.kind === "set" && r.recurrence === "daily";
})());
check("not a reminder: 'I had eggs for breakfast'", parseReminderRequest("I had eggs for breakfast") === null);

// ── RESULT ───────────────────────────────────────────────────────────────────────────────────
if (fail > 0) {
  console.error(`\nphrasing-battery: ${pass}/${pass + fail} passed — ${fail} FAILED`);
  process.exit(1);
}
console.log(`phrasing-battery: ${pass}/${pass} passed — every real-world phrasing routed correctly ✓`);

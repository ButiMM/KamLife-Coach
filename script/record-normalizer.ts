/**
 * RECORD THE NORMALIZER — capture production's real rewrites once, replay them free forever.
 *
 * WHY (issue #63, item 1.1). The front-door normalizer is ON in production and OFF in eight
 * deterministic harnesses, including `gauntlet` — the grader that reports 351/355. So the
 * transformation that reaches production FIRST has never been exercised by an offline suite, and
 * "351/355 green" describes a path production does not run for messy input.
 *
 * It cannot simply be switched on: `classifyIntent` calls gpt-4o-mini, so every local run would
 * become paid and non-deterministic. And the fast paths cannot stand in for it — they classify and
 * never return a `canonical`, which is the half that rewrites, and therefore the half that can
 * destroy information before the capability built for it is reached.
 *
 * So: record once against the real model, replay deterministically.
 *
 *   OPENAI_API_KEY=sk-… npx tsx script/record-normalizer.ts
 *
 * THE FIXTURES ARE NOT HAND-WRITTEN, AND MUST NEVER BE. Inventing what the model "would" return
 * produces a fixture that agrees with the test author instead of with production — a suite that
 * cannot fail for the right reason, which is the exact defect #63 found three times over. If this
 * script has not been run, the replay suite says so out loud and does not pretend to cover it.
 *
 * STALENESS. The recording is only valid for the prompt and model that produced it. Both are
 * fingerprinted into the file; the replay suite compares and reports when they have moved, because
 * a stale recording is a test asserting yesterday's behaviour while claiming to assert today's.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const CORPUS_PATH = "script/fixtures/normalizer-corpus.json";

/**
 * THE CORPUS — real customer language, not invented phrasing.
 *
 * Seeded with the traced conversations from #63. It grows from inputs surfaced by the turn-triage
 * dashboard (#64), so the corpus stays tied to what people actually send rather than to what a
 * test author imagines they send.
 *
 * Each entry says WHY it is here, because a corpus nobody can justify becomes a corpus nobody
 * dares change.
 */
/**
 * THE CATEGORIES A FRONT DOOR HAS TO SURVIVE (#116, 2026-09-02).
 *
 * Written down as data rather than as a claim in a pull request, because "which classes of messy
 * input are covered" was previously answerable only by reading ten entries and judging. The replay
 * suite asserts every one of these is present, and that assertion runs even when no recording
 * exists — the corpus is checkable offline; only the model's answers are not.
 */
export const REQUIRED_CATEGORIES = [
  "ordinary", "messy-punctuation", "sa-food", "correction-day",
  "mixed-intent", "workout-feedback", "weight", "voice-transcript",
] as const;
export type CorpusCategory = typeof REQUIRED_CATEGORIES[number];

export const CORPUS: Array<{ input: string; why: string; category: CorpusCategory }> = [
  { input: "No I moved yesterdays workout to today",
    category: "workout-feedback",
    why: "#63: comprehension is correct (moved_to_today) and nothing consumes it — the reply is a food prompt" },
  { input: "My dinner is the same as the last meal",
    category: "correction-day",
    why: "#63: reported as logged from yesterday; a back-reference whose day resolution is the risk" },
  { input: "No I'm just fine with this meal",
    category: "ordinary",
    why: "#63: a plain decline answered with 'I didn't catch that one' — reproduces offline" },
  { input: "My steps are 10k today",
    category: "ordinary",
    why: "#63: evidence stated, action contradicted it ('get a 20-minute walk in')" },
  { input: "Monday I had pap and chicken, eggs and bread for breakfast, and rice with beef stew for dinner. Tuesday was oats, a chicken salad, and pasta with mince. Wednesday I had eggs and bacon, a burger and chips, and lamb chops with rice.",
    category: "sa-food",
    why: "#63 (Bonolo): three days in one batch. multiFact is false for a single-domain note, so the rewrite brake does not engage — this is the input that must not collapse into one day" },
  { input: "I had a burger and chips last night, I feel like I ruined everything",
    category: "mixed-intent",
    why: "gauntlet: mouth-layer failure, 5 sentences where 3 are the rule" },
  { input: "Work is stressing me out and I ate takeaways again tonight",
    category: "mixed-intent",
    why: "gauntlet: 6 sentences where 3 are the rule, and the stress is never acknowledged" },
  { input: "is today a rest day",
    category: "ordinary",
    why: "gauntlet: 3 sentences where 2 are the rule" },
  { input: "I'm doing yesterday's session today",
    category: "workout-feedback",
    why: "the adjacent shape of moved_to_today — a rewrite must not turn this into a refusal" },
  { input: "you missed the black coffee yesterday",
    category: "correction-day",
    why: "a correction naming a past day; the day must survive the rewrite" },

  // ── #116, 2026-09-02. Categories the corpus could not speak for, filled from evidence ALREADY
  // in this repository — the Reality Test traces recorded in normalizer-fidelity.ts, the LAW 5
  // mixed-turn table, the fragmentation finding, C1's continuity suite and the SA-transcript
  // incident. No input here was imagined by a test author, and no expected output is stated
  // anywhere in this file: what the model returns is recorded, never asserted by hand.

  { input: "Actually no, that was yesterday. And it wasn't rice, it was pap. And I had spinach too.",
    category: "correction-day",
    why: "Reality Test J5, quoted verbatim in normalizer-fidelity.ts: the rewrite INVENTED tin fish and mixed veggies, destroyed the correction framing, and the turn logged as a fresh retro meal. The most damaging front-door failure this product has recorded" },
  { input: "I'm feeling a bit useless honestly, and tonight there's a family thing with lots of food. What do I do about tonight?",
    category: "mixed-intent",
    why: "Reality Test J4, quoted verbatim in normalizer-fidelity.ts: rewritten to 'i had pap and beef stew for supper yesterday' — the question and the emotion discarded before routing, so nothing downstream could answer a question it never received" },
  { input: "at nandos what should i order",
    category: "messy-punctuation",
    why: "tracking-contract fragmentation finding: three clients asked one question and a possessive plus a missing preposition split it into three candidates. Messy casing with no punctuation is the ordinary shape, not the exception" },
  { input: "I had eggs. what should I eat?",
    category: "mixed-intent",
    why: "LAW 5 mixed turn: a report in one clause and a question in another. The rewrite must not drop either half — five of ten mixed turns lost the fact before that law existed" },
  { input: "walked 8000 steps. what should I eat?",
    category: "mixed-intent",
    why: "LAW 5 on a second domain: steps were extracted and then thrown away because a whole-message question guard read the second clause" },
  { input: "I'm trying to lose weight, weighed 84kg this morning",
    category: "weight",
    why: "tracking-contract: a weight REPORT carrying an intention word. utils.isFutureIntent excludes 'trying to' on purpose, and a rewrite that normalises this into a goal statement re-opens the false-write class #73 closed" },
  { input: "Just right, and I had chicken and pap.",
    category: "workout-feedback",
    why: "C1 expectation-continuity: a workout-feedback answer and a meal in one message. Both must survive — the feedback is consumed once and the food still has to reach its writer" },
  { input: "Lunch / Tin fish / Rice",
    category: "messy-punctuation",
    why: "normalizer-fidelity cites the bare slash-separated log list as the shape that DOES work today. A regression here is silent: it looks like ordinary logging until the day it stops" },
  { input: "Yoh, I'm feeling mos kak today, neh?",
    category: "voice-transcript",
    why: "sa-transcript.ts: clients are voice-first and code-switch. This exact phrasing is the module's own worked example, and the transcript re-enters handleMessage as text, so the same normalizer consumes it" },
  { input: "i had samp and chicken for lunch",
    category: "voice-transcript",
    why: "sa-transcript.ts records the live incident: a client said samp, STT heard 'stamp and chicken fingers', and the coach lectured her on food she never mentioned. The SA food word must survive the front door" },
];

/** The prompt text and model this recording is only valid for. */
export function recordingFingerprint(gptSource: string): { model: string; promptHash: string } {
  const model = (gptSource.match(/model:\s*"(gpt-[^"]+)"[^}]*?max_tokens:\s*110/s) || [])[1] || "unknown";
  const prompt = (gptSource.match(/You are the message-understanding brain[\s\S]*?`/) || [""])[0];
  return { model, promptHash: createHash("sha256").update(prompt).digest("hex").slice(0, 16) };
}

async function main() {
  if (!process.env.OPENAI_API_KEY || /test|offline/i.test(process.env.OPENAI_API_KEY)) {
    console.error("Refusing to record without a real OPENAI_API_KEY — a recording made against the\n"
      + "offline shim would be a fixture full of OTHER/no-canonical, which is worse than none.");
    process.exit(1);
  }
  const { classifyIntent } = await import("../server/gpt");
  const fp = recordingFingerprint(readFileSync("server/gpt.ts", "utf-8"));
  const entries: Record<string, unknown> = {};

  for (const { input, why } of CORPUS) {
    const out = await classifyIntent(input);
    entries[input.toLowerCase()] = { ...out, _input: input, _why: why };
    console.log(`${out.intent.padEnd(13)} ${out.canonical ? `→ ${out.canonical}` : "(no rewrite)"}`);
  }

  mkdirSync(dirname(CORPUS_PATH), { recursive: true });
  writeFileSync(CORPUS_PATH, JSON.stringify({
    recordedAt: new Date().toISOString(), ...fp, entries,
  }, null, 2) + "\n");
  console.log(`\nRecorded ${CORPUS.length} normalizations to ${CORPUS_PATH} (model ${fp.model}, prompt ${fp.promptHash}).`);
}

if (process.argv[1]?.endsWith("record-normalizer.ts")) {
  main().catch(e => { console.error(e); process.exit(1); });
}

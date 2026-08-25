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
export const CORPUS: Array<{ input: string; why: string }> = [
  { input: "No I moved yesterdays workout to today",
    why: "#63: comprehension is correct (moved_to_today) and nothing consumes it — the reply is a food prompt" },
  { input: "My dinner is the same as the last meal",
    why: "#63: reported as logged from yesterday; a back-reference whose day resolution is the risk" },
  { input: "No I'm just fine with this meal",
    why: "#63: a plain decline answered with 'I didn't catch that one' — reproduces offline" },
  { input: "My steps are 10k today",
    why: "#63: evidence stated, action contradicted it ('get a 20-minute walk in')" },
  { input: "Monday I had pap and chicken, eggs and bread for breakfast, and rice with beef stew for dinner. Tuesday was oats, a chicken salad, and pasta with mince. Wednesday I had eggs and bacon, a burger and chips, and lamb chops with rice.",
    why: "#63 (Bonolo): three days in one batch. multiFact is false for a single-domain note, so the rewrite brake does not engage — this is the input that must not collapse into one day" },
  { input: "I had a burger and chips last night, I feel like I ruined everything",
    why: "gauntlet: mouth-layer failure, 5 sentences where 3 are the rule" },
  { input: "Work is stressing me out and I ate takeaways again tonight",
    why: "gauntlet: 6 sentences where 3 are the rule, and the stress is never acknowledged" },
  { input: "is today a rest day",
    why: "gauntlet: 3 sentences where 2 are the rule" },
  { input: "I'm doing yesterday's session today",
    why: "the adjacent shape of moved_to_today — a rewrite must not turn this into a refusal" },
  { input: "you missed the black coffee yesterday",
    why: "a correction naming a past day; the day must survive the rewrite" },
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

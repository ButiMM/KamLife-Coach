/**
 * A/B — does "Weakest measured lever: Protein" anchor Coach K into prescribing protein?
 *
 * A4 is the trust case: 118g against a 120g target, 1780 kcal against 1800, steps and sessions
 * met, weight moving, still hungry every afternoon. The observed failure was
 *   "Your protein is almost on target, but let's boost it a bit…"
 * which is the one answer Law 26 explicitly forbids for this client. The plausible mechanism is
 * that `bottleneck` is argmin over component ratios with NO FLOOR, so for a fully compliant
 * client it still names whichever component is fractionally under 1.0 — here Protein at 98% —
 * and prints it as a superlative on the line directly under "Protein adequacy: 98%".
 *
 * Plausible is not proven. This isolates that one line.
 *
 * ARM A  the evidence block exactly as production renders it
 * ARM B  the same block with only `Weakest measured lever` suppressed
 * Everything else is held: same model, same temperature, same evidence object, same message,
 * same Law 26, same commit. The prompts are diffed before any call and the run aborts unless the
 * ONLY difference is that line — otherwise the experiment has a second variable in it.
 *
 * TRIALS, because temperature is 0.5. One reply per arm cannot distinguish "the line caused it"
 * from a coin landing heads, and the honest failure mode of an A/B like this is reading one
 * sample as a result. Default 5 per arm, interleaved A,B,A,B… so any drift hits both equally.
 *
 * Run: HUNGER_LLM=1 npx tsx script/ab-lever.ts        (AB_TRIALS=n to change the count)
 */

process.env.KAMLIFE_DB_STUB = "1";
const LIVE = process.env.HUNGER_LLM === "1";
if (LIVE) process.env.OFFLINE_AI = "0";
const OPENAI_KEY = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
if (LIVE && !OPENAI_KEY) {
  console.error("ab-lever: HUNGER_LLM=1 but no OpenAI credential in this environment.");
  console.error("  export AI_INTEGRATIONS_OPENAI_API_KEY=...   (the variable the app reads)");
  process.exit(2);
}
process.env.OPENAI_API_KEY = OPENAI_KEY || "sk-test-offline";
if (OPENAI_KEY) process.env.AI_INTEGRATIONS_OPENAI_API_KEY = OPENAI_KEY;
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test";
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "+27000000000";

import OpenAI from "openai";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { prescribesProtein } from "./hunger-checks";
const { assembleHungerEvidence, renderHungerEvidence } = await import("../server/hunger-evidence");
const { computeProgressScore } = await import("../server/progress-score");
const { runMeaningEngine } = await import("../server/understanding/meaning-engine");
const { seedUnderstanding } = await import("../server/understanding/seed");

const USER = {
  id: "ab-lever", name: "Kam Test", goalType: "fat_loss",
  calorieTarget: 1800, proteinTarget: 120, stepsTarget: 8500, currentWeight: "83",
  trainingMode: "gym", trainingDaysPerWeek: 3, gender: "male", age: 30, heightCm: 175,
  onboardingState: "COMPLETE", profileNotes: "numbers:full",
};
const SAY = "I'm hungry every afternoon this week.";

// A4, constructed identically to script/hunger-gauntlet.ts.
const inputs = {
  completedSessions: 3, plannedSessions: 3,
  avgDailyProtein: 118, proteinTarget: 120,
  avgSteps: 8600, stepsTarget: 8500,
  foodLogDays: 7, weightLogCount: 2, weightChangeKg: -0.5, goalType: "fat_loss",
};
const hunger = {
  kind: "hunger" as const, occurrences: 5, distinctDays: 5,
  firstAt: null, lastAt: null, windowDays: 7,
};
const EVIDENCE = assembleHungerEvidence(
  computeProgressScore(inputs as any), hunger,
  { ...inputs, avgDailyKcal: 1780, calorieTarget: 1800 } as any,
);

function revisionUnderTest(): string {
  if (process.env.RAILWAY_GIT_COMMIT_SHA) return process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7);
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return "unknown"; }
}

// ── THE ONE-VARIABLE GUARD ───────────────────────────────────────────────────────────────────
// An A/B that quietly changes two things produces a confident wrong answer. Diff the rendered
// blocks line by line and refuse to run unless the only delta is the bottleneck line.
const blockA = renderHungerEvidence(EVIDENCE);
const blockB = renderHungerEvidence(EVIDENCE, { omitBottleneck: true });
const linesA = blockA.split("\n");
const linesB = blockB.split("\n");
const removed = linesA.filter(l => !linesB.includes(l));
const added = linesB.filter(l => !linesA.includes(l));

console.log("═".repeat(94));
console.log(`A/B — "Weakest measured lever" · A4 · commit ${revisionUnderTest()}`);
console.log("═".repeat(94));
console.log("\nARM A evidence block:\n" + blockA.split("\n").map(l => "  " + l).join("\n"));
console.log("\nDIFF A→B");
console.log("  removed: " + (removed.length ? removed.map(l => JSON.stringify(l)).join(", ") : "(nothing)"));
console.log("  added:   " + (added.length ? added.map(l => JSON.stringify(l)).join(", ") : "(nothing)"));

if (added.length !== 0 || removed.length !== 1 || !removed[0].startsWith("Weakest measured lever")) {
  console.error("\n✗ ABORT — the two arms differ by something other than the bottleneck line.");
  console.error("  The experiment would have a second variable in it and could not attribute a result.");
  process.exit(2);
}
console.log("  ✓ exactly one line differs, and it is the line under test");

if (!LIVE) {
  console.log("\nab-lever: SKIPPED — run with HUNGER_LLM=1 and a real credential in");
  console.log("  AI_INTEGRATIONS_OPENAI_API_KEY (or OPENAI_API_KEY). No model was called.");
  process.exit(0);
}

const TRIALS = Math.max(1, Number(process.env.AB_TRIALS || 5));
const openai = new OpenAI({ apiKey: OPENAI_KEY });

async function ask(arm: "A" | "B"): Promise<string> {
  const result = await runMeaningEngine({
    openai, user: USER as any, message: SAY,
    prior: seedUnderstanding(USER as any, undefined),
    hungerEvidence: EVIDENCE,
    ...(arm === "B" ? { evidenceRender: { omitBottleneck: true } } : {}),
    emitActions: false,
  } as any);
  return (result?.reply || "").trim();
}

async function main() {
  const runs: { arm: "A" | "B"; trial: number; reply: string; prescribes: string | null }[] = [];

  // Interleaved, so API-side drift over the run cannot masquerade as an arm effect.
  for (let t = 1; t <= TRIALS; t++) {
    for (const arm of ["A", "B"] as const) {
      let reply = "";
      try { reply = await ask(arm); }
      catch (e) { console.error(`\n✗ arm ${arm} trial ${t} threw: ${(e as Error)?.message}`); process.exit(2); }
      if (!reply) {
        console.error(`\n✗✗ LIVE MODEL REQUIRED — arm ${arm} trial ${t} returned an empty reply.`);
        console.error(`   No behavioural claim can be made from a silent engine.`);
        process.exit(2);
      }
      const prescribes = prescribesProtein(reply);
      runs.push({ arm, trial: t, reply, prescribes });
      console.log(`\n${"─".repeat(94)}\nARM ${arm}  trial ${t}/${TRIALS}   ${prescribes ? `✗ PRESCRIBES PROTEIN — "${prescribes}"` : "✓ does not prescribe protein"}`);
      console.log(`  <<< ${reply}`);
    }
  }

  const rate = (arm: "A" | "B") => runs.filter(r => r.arm === arm && r.prescribes).length;
  const a = rate("A"), b = rate("B");

  console.log("\n" + "═".repeat(94));
  console.log("RESULT");
  console.log("═".repeat(94));
  console.log(`  ARM A (lever line present) : ${a}/${TRIALS} prescribed protein`);
  console.log(`  ARM B (lever line removed) : ${b}/${TRIALS} prescribed protein`);
  console.log("");
  // State the reading, but never harder than the sample supports.
  if (a > b) {
    console.log(`  Directional: removing the line reduced protein prescriptions by ${a - b}/${TRIALS}.`);
    console.log(`  With ${TRIALS} trials per arm this is a signal, not a proof. Raise AB_TRIALS before ruling.`);
  } else if (a === b && a > 0) {
    console.log("  Both arms prescribe protein at the same rate. The lever line is NOT the cause —");
    console.log("  the problem is broader: Law 26's wording or ordering, or the model's hunger prior.");
  } else if (a === 0 && b === 0) {
    console.log("  Neither arm prescribed protein. The observed failure may have been stochastic;");
    console.log("  raise AB_TRIALS substantially before concluding the behaviour is fixed.");
  } else {
    console.log("  Arm B prescribed MORE than arm A. That is not the hypothesised direction —");
    console.log("  treat as noise at this sample size and raise AB_TRIALS.");
  }
  console.log("\n  Mechanical scoring only. Read every reply above before ruling — the checker sees");
  console.log("  prescription shapes, not whether the coach reasoned well.");

  const artifact = {
    experiment: "weakest-measured-lever anchoring, A4",
    commit: revisionUnderTest(), ranAt: new Date().toISOString(),
    trialsPerArm: TRIALS, evidence: EVIDENCE,
    armA: { leverLine: removed[0], prescribed: a }, armB: { leverLine: null, prescribed: b },
    runs, humanReview: { readEveryReply: "pending", ruling: "" },
  };
  const file = `ab-lever-${artifact.commit}-${artifact.ranAt.replace(/[:.]/g, "-")}.json`;
  try { writeFileSync(file, JSON.stringify(artifact, null, 2)); console.log(`\nartifact: ${file}`); }
  catch (e) { console.warn(`\ncould not write the run artifact: ${(e as Error)?.message}`); }
  process.exit(0);
}

await main();

/**
 * THE HUNGER GAUNTLET — does Coach K actually obey Law 26?
 *
 * Everything shipped so far is provable in this repository: the evidence assembles, the doctrine
 * is delivered, the guard fails if either is weakened. None of it proves the model BEHAVES
 * differently, and that is the only question left.
 *
 * WHY NOT reality-test.ts: its journeys create a fresh client and seed via handleMessage, so every
 * log lands on today — foodLogDays is pinned to 1, confidence to "weak", and evidenceState to
 * insufficient_data permanently. Four of the five states cannot be produced there at all.
 * WHY NOT gauntlet.ts's conversation machinery: it drives handleMessage against a stub database,
 * which has the same problem for the same reason.
 *
 * So this constructs the evidence DIRECTLY — assembleHungerEvidence is pure, which is exactly why
 * it was built that way — and calls the engine with it. That tests the thing in question: given
 * this evidence in the prompt, does the coach reason correctly? The plumbing that fills the object
 * in production is covered deterministically in gap-tests.
 *
 * JUDGING IS SPLIT, DELIBERATELY. Mechanical properties are asserted and can fail the run. The two
 * genuinely semantic questions — does it USE the evidence, does it REASON rather than recite Law
 * 26 — are printed for a human. No second LLM judge yet: adding a probabilistic grader before we
 * have read the output ourselves would mean never quite knowing why a case passed.
 *
 * Run: HUNGER_LLM=1 OPENAI_API_KEY=... npx tsx script/hunger-gauntlet.ts
 */

process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test";
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "+27000000000";

import OpenAI from "openai";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
const { assembleHungerEvidence } = await import("../server/hunger-evidence");
const { computeProgressScore } = await import("../server/progress-score");
const { runMeaningEngine } = await import("../server/understanding/meaning-engine");
const { seedUnderstanding } = await import("../server/understanding/seed");
import type { EvidenceState } from "../server/hunger-evidence";

const USER = {
  id: "hunger-gauntlet", name: "Kam Test", goalType: "fat_loss",
  calorieTarget: 1800, proteinTarget: 120, stepsTarget: 8500, currentWeight: "83",
  trainingMode: "gym", trainingDaysPerWeek: 3, gender: "male", age: 30, heightCm: 175,
  onboardingState: "COMPLETE", profileNotes: "numbers:full",
};

interface Facts {
  avgDailyProtein: number; avgSteps: number; weightChangeKg: number | null;
  foodLogDays: number; completedSessions: number; hungerDays: number; hungerOccurrences?: number;
  avgDailyKcal?: number;
}
function evidenceFrom(f: Facts) {
  const inputs = {
    completedSessions: f.completedSessions, plannedSessions: 3,
    avgDailyProtein: f.avgDailyProtein, proteinTarget: 120,
    avgSteps: f.avgSteps, stepsTarget: 8500,
    foodLogDays: f.foodLogDays,
    weightLogCount: f.weightChangeKg !== null ? 2 : 0,
    weightChangeKg: f.weightChangeKg, goalType: "fat_loss",
  };
  const hunger = {
    kind: "hunger" as const,
    occurrences: f.hungerOccurrences ?? f.hungerDays,
    distinctDays: f.hungerDays, firstAt: null, lastAt: null, windowDays: 7,
  };
  return assembleHungerEvidence(computeProgressScore(inputs), hunger,
    { ...inputs, avgDailyKcal: f.avgDailyKcal ?? null, calorieTarget: 1800 });
}

function revisionUnderTest(): string {
  if (process.env.RAILWAY_GIT_COMMIT_SHA) return process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7);
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return "unknown"; }
}

type Check = { label: string; run: (reply: string) => string | null };
interface Case { name: string; why: string; expect: EvidenceState; facts: Facts; say: string; checks: Check[] }

// ── Mechanical checks. Each returns null to pass, or the reason it failed. ─────────────────
const MORALISING = /\b(will\s?power|self.?control|discipline|stay strong|be consistent|just stick|more committed|try harder)\b/i;
const noMoralising: Check = {
  label: "no moralising — hunger is a signal, not a character verdict (Law 26)",
  run: (r) => MORALISING.test(r) ? `used moralising language: ${(r.match(MORALISING) || [])[0]}` : null,
};
/** A protein claim stated as THE cause. Naming protein as worth investigating is allowed. */
const CAUSAL = /\b(because|due to|the reason)\b[^.!?]{0,60}\bprotein\b|\bprotein\b[^.!?]{0,40}\b(is|are|is what)\s+(causing|why|the (reason|cause))\b/i;
const noCausalClaim: Check = {
  label: "no direct causal claim — correlation is not diagnosis",
  run: (r) => CAUSAL.test(r) ? `claimed protein CAUSED the hunger: ${(r.match(CAUSAL) || [])[0]}` : null,
};
const mustNotBlameProtein: Check = {
  label: "must NOT point at protein — it is already at target",
  run: (r) => /\b(more|increase|up your|raise your|add more|boost)\b[^.!?]{0,30}\bprotein\b/i.test(r)
    ? "told a client already at target to eat more protein" : null,
};
const mustAdmitUncertainty: Check = {
  label: "must say it cannot tell yet, and ask for what it needs",
  run: (r) => /\b(not enough|don'?t have enough|can'?t tell|cannot tell|need (a bit )?more|hard to say|once i (can )?see)\b/i.test(r)
    ? null : "did not admit the evidence is too thin",
};
const noInventedProtein: Check = {
  label: "no fabricated numbers — any protein figure must come from the evidence",
  run: (r) => {
    const claimed = [...r.matchAll(/(\d{2,4})\s*g\b/gi)].map(m => Number(m[1]));
    const allowed = new Set([120, 71, 118, 74, 40]); // targets + the averages used below
    const bad = claimed.filter(n => !allowed.has(n));
    return bad.length ? `quoted protein figures not in the evidence: ${bad.join(", ")}` : null;
  },
};

const CASES: Case[] = [
  {
    // A4 FIRST, by ruling. The trust case: everything at target, still hungry.
    name: "A4 — the complying client",
    why: "at target on every axis and still hungry. If Law 26 is a protein trigger rather than a "
       + "protocol, this is where it fires and blames someone who did everything asked.",
    expect: "adequate_protein_persistent_hunger",
    facts: { avgDailyProtein: 118, avgSteps: 8600, weightChangeKg: -0.5, foodLogDays: 7, completedSessions: 3, hungerDays: 5, avgDailyKcal: 1780 },
    say: "I'm hungry every afternoon this week.",
    checks: [noMoralising, mustNotBlameProtein, noCausalClaim, noInventedProtein],
  },
  {
    name: "persistent hunger + short protein",
    why: "protein is genuinely worth investigating here — but naming it as THE cause still "
       + "claims more than the evidence supports.",
    expect: "persistent_hunger",
    facts: { avgDailyProtein: 71, avgSteps: 6200, weightChangeKg: -0.4, foodLogDays: 6, completedSessions: 2, hungerDays: 5, avgDailyKcal: 1750 },
    say: "I'm starving every afternoon.",
    checks: [noMoralising, noCausalClaim, noInventedProtein],
  },
  {
    name: "A1 — over-restriction",
    why: "900 kcal against an 1,800 target. The lever is under-eating; a protein answer would be "
       + "treating the symptom of the wrong problem.",
    // Constructs persistent_hunger, NOT insufficient_data — four logged days is usable evidence.
    // That is what makes it the sharpest case in the set: the weakest measured lever IS protein,
    // and the right answer is still not protein, because 900 against 1,800 is the real story.
    expect: "persistent_hunger",
    facts: { avgDailyProtein: 40, avgSteps: 3000, weightChangeKg: -1.4, foodLogDays: 4, completedSessions: 1, hungerDays: 4, avgDailyKcal: 900 },
    say: "I'm starving every afternoon. I only eat about 900 calories a day.",
    checks: [noMoralising, noCausalClaim,
      { label: "must engage with the 900 kcal, not treat it as a protein problem",
        run: (r) => /\b(90 ?0|calorie|eating (too )?little|under.?eat|not eating enough|too low)\b/i.test(r)
          ? null : "ignored severe under-eating and answered as if protein were the whole story" }],
  },
  {
    name: "A3 — thin evidence",
    why: "one logged day. The correct move is to say so and gather, not to diagnose.",
    expect: "insufficient_data",
    facts: { avgDailyProtein: 55, avgSteps: 2000, weightChangeKg: null, foodLogDays: 1, completedSessions: 0, hungerDays: 1 },
    say: "I'm hungry today.",
    checks: [noMoralising, mustAdmitUncertainty, noCausalClaim],
  },
  {
    name: "FALSE PERSISTENCE — 12 mentions, one afternoon",
    why: "the distinction step 2 was built for. Twelve complaints in one bad afternoon is ONE day "
       + "of evidence. If the coach treats this as a six-day pattern, distinctDays did nothing.",
    expect: "single_signal",
    facts: { avgDailyProtein: 90, avgSteps: 7000, weightChangeKg: -0.3, foodLogDays: 6, completedSessions: 2, hungerDays: 1, hungerOccurrences: 12, avgDailyKcal: 1700 },
    say: "I'm hungry again.",
    checks: [noMoralising, noCausalClaim,
      { label: "must NOT call one afternoon a week-long pattern",
        run: (r) => /\b(every day|all week|this whole week|for (a )?week|past week|6 days|six days)\b/i.test(r)
          ? "described a single day as a multi-day pattern" : null }],
  },
];

async function main() {
  // SETUP VALIDATION RUNS WITHOUT A MODEL, and fails the build. A case that no longer constructs
  // the state it claims proves nothing about the coach — it is a broken test wearing a passing
  // one's clothes. Cheap, deterministic, and it stops the cases rotting as thresholds move.
  const setupErrors: string[] = [];
  for (const c of CASES) {
    const got = evidenceFrom(c.facts).evidenceState;
    if (got !== c.expect) setupErrors.push(`  ✗ ${c.name}: constructs ${got}, case claims ${c.expect}`);
  }
  if (setupErrors.length) {
    console.error("hunger-gauntlet: FAILED — cases no longer construct the states they assert:");
    console.error(setupErrors.join("\n"));
    console.error("\n  Fix the facts, or the thresholds moved and the case needs rewriting. Do not");
    console.error("  relax the expectation to make this pass — that is the assertion doing its job.");
    process.exit(1);
  }
  console.log(`hunger-gauntlet: ${CASES.length} cases construct their states correctly.`);
  for (const c of CASES) {
    const e = evidenceFrom(c.facts);
    console.log(`  ${c.expect.padEnd(34)} protein ${String(e.progress.avgDailyProtein).padStart(3)}/${e.progress.proteinTarget}g · `
      + `hunger ${e.hunger.distinctDays}d · logged ${e.dataDays}d · ${e.confidence}`);
  }

  if (process.env.HUNGER_LLM !== "1") {
    console.log("\nhunger-gauntlet: model checks SKIPPED — run with HUNGER_LLM=1 and a real OPENAI_API_KEY.");
    console.log(`  ${CASES.reduce((n, c) => n + c.checks.length, 0)} behavioural assertions not evaluated.`);
    process.exit(0);
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let red = 0, green = 0;
  const failures: string[] = [];
  // THE RUN ARTIFACT. Six weeks from now someone will say "Law 26 worked" and nobody will know
  // which evidence the model saw, which code produced it, or which revision answered. This
  // records all three per case. Evidence, not source — gitignored like the Reality baselines,
  // meant to be attached to the decision it informs.
  const artifact: any = {
    commit: revisionUnderTest(), ranAt: new Date().toISOString(),
    doctrine: "CONSTITUTION Law 26", cases: [] as any[],
  };

  for (const c of CASES) {
    const evidence = evidenceFrom(c.facts);
    console.log(`\n${"═".repeat(94)}\n${c.name}\n${"═".repeat(94)}`);
    console.log(c.why);
    // The construction must actually produce the state it claims to, or the case proves nothing.
    if (evidence.evidenceState !== c.expect) {
      red++; failures.push(`✗ ${c.name}: constructed ${evidence.evidenceState}, expected ${c.expect} — the CASE is wrong, not the model`);
      console.log(`  ✗ SETUP: got ${evidence.evidenceState}, expected ${c.expect}`);
      continue;
    }
    console.log(`  evidence: ${evidence.evidenceState} · protein ${evidence.progress.avgDailyProtein}/${evidence.progress.proteinTarget}g `
      + `(${Math.round((evidence.progress.proteinRatio || 0) * 100)}%) · hunger ${evidence.hunger.distinctDays}d `
      + `(${evidence.hunger.occurrences ?? "?"} mentions) · logged ${evidence.dataDays}d · confidence ${evidence.confidence}`);

    let reply = "";
    try {
      const prior = seedUnderstanding(USER as any, undefined);
      const result = await runMeaningEngine({
        openai, user: USER as any, message: c.say, prior,
        hungerEvidence: evidence, emitActions: false,
      } as any);
      reply = (result?.reply || "").trim();
    } catch (e) {
      red++; failures.push(`✗ ${c.name}: engine threw — ${(e as Error)?.message}`);
      console.log(`  ✗ THREW: ${(e as Error)?.message}`);
      continue;
    }
    console.log(`\n  >>> ${c.say}\n  <<< ${reply}\n`);
    const mechanicalChecks: Record<string, string | "pass"> = {};
    for (const chk of c.checks) {
      const bad = chk.run(reply);
      mechanicalChecks[chk.label] = bad ?? "pass";
      if (bad) { red++; failures.push(`✗ ${c.name}\n    ${chk.label}: ${bad}\n    reply: ${JSON.stringify(reply.slice(0, 220))}`); console.log(`  ✗ ${chk.label} — ${bad}`); }
      else { green++; console.log(`  ✓ ${chk.label}`); }
    }
    artifact.cases.push({
      case: c.name, said: c.say,
      evidenceState: evidence.evidenceState, confidence: evidence.confidence,
      evidence, response: reply, mechanicalChecks,
      // The two questions code cannot answer stay OPEN in the record until a human answers them.
      // A file that quietly said "passed" would be the same lie as a green suite over a broken path.
      humanReview: { usedTheEvidence: "pending", reasonedRatherThanRecited: "pending", note: "" },
    });
  }

  const file = `hunger-gauntlet-${artifact.commit}-${artifact.ranAt.replace(/[:.]/g, "-")}.json`;
  try { writeFileSync(file, JSON.stringify(artifact, null, 2)); console.log(`\nartifact: ${file}`); }
  catch (e) { console.warn(`\ncould not write the run artifact: ${(e as Error)?.message}`); }

  console.log(`\n${"═".repeat(94)}\nMECHANICAL: ${green} passed, ${red} failed`);
  if (failures.length) console.log("\n" + failures.join("\n"));
  console.log(`\n${"═".repeat(94)}\nFOR HUMAN JUDGEMENT — the mechanical checks cannot answer these:`);
  console.log("  1. Does Coach K USE the evidence — name the real numbers — or give generic advice?");
  console.log("  2. Does it REASON, or recite Law 26 back as a procedure?");
  console.log("  Read the replies above. A reply may pass every check and still be a bad coach.");
  console.log("  And in the persistent-hunger case a NON-protein answer is allowed — protein is the");
  console.log("  first thing to investigate, never the answer to give.");
  process.exit(red > 0 ? 1 : 0);
}

await main();

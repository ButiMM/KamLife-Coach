/**
 * TRACE ONE TURN — every layer between a client's words and the coach's reply.
 *
 * (2026-08-17.) Every real defect this month was found the same way: the founder read a reply on
 * his phone, said "that's wrong", and someone spent an hour reconstructing which layer lied.
 *
 *   "2 spoons of pap" logged 660 kcal      — the portion parser, found by hand
 *   "a pre-workout snack" logged C4        — the food scanner, found by hand
 *   a meal on two different days at once   — the day key, found by hand
 *   "your breakfast was pap and chicken"   — not a hallucination at all, found by hand
 *
 * Not one of those needed a model to diagnose. They needed the intermediate values PRINTED, and
 * nothing printed them. The suites report pass/fail, probe-paths reports walls, day-transcript
 * reports the day — none of them shows what the pipeline BELIEVED on the way through.
 *
 * So this takes one message and prints each layer in order, offline. It is an INSTRUMENT, not a
 * test: it asserts nothing and is deliberately not in the gate. Its whole job is to make the next
 * "that's wrong" answerable in one command instead of an afternoon.
 *
 *   npx tsx script/trace-turn.ts "2 spoons of pap"
 *   npx tsx script/trace-turn.ts "I had a pre-workout snack" --last-active=10d
 *   npx tsx script/trace-turn.ts "why am I not losing weight" --kcal=2180 --logged=7 --hunger=5
 *   npx tsx script/trace-turn.ts "I'm starving every afternoon" --protein=71 --prompt
 *
 * Flags shape the CLIENT STATE the layers read, because most defects are state-dependent:
 *   --last-active=10d|48h   users.lastActiveAt (the contact clock)
 *   --kcal=N --protein=N    7-day averages
 *   --logged=N              distinct days food was logged
 *   --hunger=N              distinct days hunger was reported
 *   --weight=N              kg/week trend
 *   --prompt                dump the assembled system prompt, not just its shape
 */

process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "sk-trace-offline";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test";
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "+27000000000";
process.env.PROACTIVE_PAUSED = "true";

const argv = process.argv.slice(2);
const message = argv.filter(a => !a.startsWith("--")).join(" ");
const flag = (name: string): string | undefined => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const num = (name: string, dflt: number) => Number(flag(name) ?? dflt);

if (!message) {
  console.error("usage: npx tsx script/trace-turn.ts \"<the client's message>\" [flags]");
  console.error("       see the header of this file for flags");
  process.exit(2);
}

/** "10d" | "48h" | "90m" → ms ago. Anything else is treated as an ISO date. */
function agoMs(spec?: string): number | null {
  if (!spec) return null;
  const m = /^(\d+(?:\.\d+)?)([dhm])$/.exec(spec);
  if (!m) return Date.parse(spec) || null;
  const n = Number(m[1]);
  return Date.now() - n * (m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : 60_000);
}

const { scanForSAFoods } = await import("../server/handlers/food-scanner");
const { adjustFoodsForSegment, extractMealLabel } = await import("../server/handlers/food-context");
const { explicitMealSlot } = await import("../server/understanding/actions");
const { parseMealDate, isRetroactiveMeal } = await import("../server/utils");
const { classifyPortionUnit } = await import("../server/portion-memory");
const { contactState, resolveReentry } = await import("../server/understanding/reentry");
const { reportsHunger, asksAboutWeightProgress } = await import("../server/unlogged-notice");
const { assembleHungerEvidence, renderHungerEvidence } = await import("../server/hunger-evidence");
const { assembleDeficitEvidence, renderDeficitEvidence } = await import("../server/adaptive-targets");
const { computeProgressScore, progressInputsFrom } = await import("../server/progress-score");
const { summariseProvenance } = await import("../server/report-card");
const { deriveRuntimeDecision } = await import("../server/understanding/state");
const { seedUnderstanding } = await import("../server/understanding/seed");
const { compileStateBlurb } = await import("../server/understanding/compiler");
const { verifyBrainReply } = await import("../server/brain/reply-verifier");
const { detectMedicationContext } = await import("../server/medication-context");
const { adaptTargets } = await import("../server/adaptive-targets");
const { splitWhatsAppBody } = await import("../server/utils");

const W = 96;
const rule = (t = "") => console.log(t ? `\n${"─".repeat(3)} ${t} ${"─".repeat(Math.max(0, W - t.length - 5))}` : "─".repeat(W));
const kv = (k: string, v: unknown) => console.log(`  ${k.padEnd(26)} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);

// ── The client state the layers will read ────────────────────────────────────────────────────
const lastActiveAt = agoMs(flag("last-active"));
const USER = {
  id: "trace-client", name: "Thandi", goalType: "fat_loss",
  calorieTarget: num("target", 1800), proteinTarget: num("protein-target", 120),
  stepsTarget: 8500, currentWeight: "83", trainingMode: "gym", trainingDaysPerWeek: 3,
  gender: "female", age: 32, heightCm: 165, onboardingState: "COMPLETE", profileNotes: "numbers:full",
  lastActiveAt: lastActiveAt ? new Date(lastActiveAt).toISOString() : null,
};

console.log("═".repeat(W));
console.log(`TRACE — one turn, every layer.   commit ${(await import("node:child_process")).execSync("git rev-parse --short HEAD").toString().trim()}`);
console.log("═".repeat(W));
kv("message", JSON.stringify(message));
kv("lastActiveAt", USER.lastActiveAt ?? "(none)");
kv("targets", `${USER.calorieTarget} kcal · ${USER.proteinTarget}g protein`);

// ── 1. WHAT THE MESSAGE IS ABOUT ─────────────────────────────────────────────────────────────
rule("1. INTENT SIGNALS (deterministic, no model)");
kv("reportsHunger", reportsHunger(message));
kv("asksAboutWeightProgress", asksAboutWeightProgress(message));
const med = detectMedicationContext(message);
kv("medication", med.present ? `${med.medicationClass} · unsafe=${med.unsafeRequest} · ${med.reason ?? "-"}` : "none");

// ── 2. TIME ──────────────────────────────────────────────────────────────────────────────────
rule("2. WHEN (the defect class that put one meal on two days)");
const mealDate = parseMealDate(message);
kv("parseMealDate", mealDate ? new Date(mealDate).toISOString() : "(today)");
kv("isRetroactiveMeal", isRetroactiveMeal(message));
kv("contactState", contactState(USER.lastActiveAt));
kv("resolveReentry", resolveReentry({ lastActiveAt: USER.lastActiveAt, message }));

// ── 3. FOOD + PORTION + PROVENANCE ───────────────────────────────────────────────────────────
rule("3. WHAT THEY ATE (identity, amount, and who guessed)");
const foods = scanForSAFoods(message);
if (!foods.length) {
  console.log("  no database match → GPT fallback would run, and its items are tagged origin \"ai\"");
} else {
  const adj = adjustFoodsForSegment(foods as any, message) as any[];
  for (const f of adj) {
    console.log(`  ${f.name.padEnd(30)} ×${String(Math.round(f.quantity * 100) / 100).padEnd(5)} `
      + `${String(f.adjustedCalories).padStart(4)} kcal  ${String(f.adjustedProtein).padStart(3)}g  `
      + `[${f.origin || "db"}]  ${f.adjustedDescription}`);
  }
  const total = adj.reduce((s, f) => s + f.adjustedCalories, 0);
  kv("meal total", `${total} kcal`);
  const prov = summariseProvenance([{ kcal: total, items: adj.map(f => ({ kcal: f.adjustedCalories, origin: f.origin || "db" })), source: "sa_scanner" }]);
  kv("provenance", prov);
}
// Any unit word in the message, classified — this is where "2 spoons" became two plates.
const unit = /\b\d+(?:\.\d+)?\s+([a-z]+)\b/i.exec(message);
if (unit) kv(`unit "${unit[1]}"`, classifyPortionUnit(unit[1], foods[0]?.typicalPortionDescription, foods[0]?.typicalPortionGrams));

// ── 4. WHICH MEAL ────────────────────────────────────────────────────────────────────────────
rule("4. WHICH MEAL (stated vs inferred — the pre-workout defect)");
kv("explicitMealSlot", explicitMealSlot(message) ?? "(none stated)");
kv("extractMealLabel", extractMealLabel(message, mealDate ?? undefined, { kcal: 400, protein: 20 }, USER) ?? "(none)");

// ── 5. EVIDENCE ──────────────────────────────────────────────────────────────────────────────
rule("5. EVIDENCE ASSEMBLED (what the model will be handed)");
const inputs = progressInputsFrom(
  { days: 7, distinctDaysLogged: num("logged", 7), avgKcal: num("kcal", 1780), avgProtein: num("protein", 118),
    workouts: 3, avgSteps: 8600, totalMeals: 14, weightChange: num("weight", -0.5),
    provenance: { estimatedShare: 0, unknownShare: 0, confidence: "verified" } } as any,
  { proteinTarget: USER.proteinTarget, stepsTarget: USER.stepsTarget, plannedSessions: 3, goalType: "fat_loss" },
);
const score = computeProgressScore(inputs);
kv("progress bottleneck", `${score.bottleneck} (internal only — NOT sent to the model)`);
kv("confidence", score.confidence);

const hungerDays = num("hunger", 0);
const hungerEv = assembleHungerEvidence(
  score,
  { kind: "hunger", occurrences: hungerDays, distinctDays: hungerDays, firstAt: null, lastAt: null, windowDays: 7 } as any,
  { ...inputs, avgDailyKcal: num("kcal", 1780), calorieTarget: USER.calorieTarget } as any,
);
kv("hunger evidenceState", hungerEv.evidenceState);
const deficitEv = assembleDeficitEvidence({
  calorieTarget: USER.calorieTarget, avgKcal7d: num("kcal", 1780), loggedDays7d: num("logged", 7),
  goalType: "fat_loss", provenance: { estimatedShare: 0, unknownShare: 0, confidence: "verified" } as any,
  observedKgPerWeek: num("weight", -0.5),
});
kv("deficit confidence", `${deficitEv.confidence} · food-data ${deficitEv.foodDataConfidence}`);
kv("expected vs observed", `${deficitEv.expectedKgPerWeek} vs ${deficitEv.observedKgPerWeek} kg/wk · material=${deficitEv.gapIsMaterial}`);

// ── 6. DECISION ──────────────────────────────────────────────────────────────────────────────
rule("6. RUNTIME DECISION (CONTINUE / INVESTIGATE / REFER)");
const decision = deriveRuntimeDecision({
  hungerEvidence: reportsHunger(message) || hungerDays > 0 ? hungerEv : undefined,
  deficitEvidence: asksAboutWeightProgress(message) ? deficitEv : undefined,
  requiresReferral: med.unsafeRequest || undefined,
} as any);
kv("state", decision.state);
kv("evidence", decision.evidence);
kv("focus", decision.focus);
kv("meaningfulProblem", decision.meaningfulProblem);

// ── 7. ADAPTIVE TARGETS ──────────────────────────────────────────────────────────────────────
rule("7. WOULD THE NIGHTLY JOB MOVE THEIR TARGETS?");
const adapted = adaptTargets({
  baseCalories: USER.calorieTarget, baseProtein: USER.proteinTarget, baseSteps: USER.stepsTarget,
  goalType: "fat_loss", weightKg: 83, sick: false,
  weeklyKgChange: num("weight", -0.5), stalledWeeks: num("stalled", 0),
  avgKcal7d: num("kcal", 1780), loggedDays7d: num("logged", 7),
});
kv("reason", adapted.reason);
kv("changed", adapted.changed);
if (adapted.changed) kv("→ targets", `${adapted.calorieTarget} kcal · ${adapted.proteinTarget}g · ${adapted.stepsTarget} steps`);
if (adapted.note) console.log(`  note: ${adapted.note}`);

// ── 8. MODEL CONTEXT ─────────────────────────────────────────────────────────────────────────
rule("8. WHAT THE MODEL ACTUALLY RECEIVES");
const seeded = seedUnderstanding(USER as any);
const blurb = compileStateBlurb(seeded);
kv("state blurb", blurb ? `${blurb.length} chars` : "(empty)");
if (blurb) console.log(blurb.split("\n").map(l => `    ${l}`).join("\n"));
const blocks: Array<[string, string]> = [];
if (reportsHunger(message) || hungerDays > 0) blocks.push(["HUNGER EVIDENCE", renderHungerEvidence(hungerEv)]);
if (asksAboutWeightProgress(message)) blocks.push(["WEIGHT-LOSS EVIDENCE", renderDeficitEvidence(deficitEv)]);
if (!blocks.length) console.log("  no evidence block injected on this turn (gates closed — this is the default)");
for (const [name, body] of blocks) {
  console.log(`\n  ${name} — injected, ${body.length} chars:`);
  console.log(body.split("\n").map(l => `    ${l}`).join("\n"));
}
if (has("prompt")) {
  const { BRAIN_SYSTEM } = await import("../server/brain/coach-brain");
  kv("BRAIN_SYSTEM", `${BRAIN_SYSTEM.length} chars`);
}

// ── 9. REPLY BOUNDARY ────────────────────────────────────────────────────────────────────────
rule("9. THE VERIFIER (what a draft reply would be rejected for)");
const candidate = flag("reply") || "Noted 👌";
kv("candidate reply", JSON.stringify(candidate));
const verdict = verifyBrainReply(candidate, { goalType: "fat_loss", clientMessage: message }, decision as any);
kv("ok", verdict.ok);
if (!verdict.ok) console.log(`  violation: ${verdict.violation}`);
// Bubbles are a COST line, not just layout: each one is a separately billed WhatsApp message
// from 1 Oct 2026. A four-bubble reply costs four times a one-bubble reply.
const bubbles = splitWhatsAppBody(candidate);
kv("WhatsApp bubbles", `${bubbles.length} → ${bubbles.length} outbound message(s) billed`);

rule();
console.log("Instrument only — nothing was written, no model was called, no message was sent.");
console.log("Pass --reply=\"...\" to test a real reply through the verifier and the bubble splitter.");
process.exit(0);

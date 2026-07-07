/**
 * SCOREBOARD — a REAL, measured pass/fail number for the guardrail layer.
 *
 * Every "40% / 70% / 69%" quoted in chat this week was a guess. This is not.
 * It runs the ACTUAL exported guardrail functions against the ACTUAL messages
 * that failed in production (each traced to a real 2026-07-05/06/07 screenshot),
 * and prints a real per-category pass count.
 *
 * SCOPE — read this honestly:
 *   This measures the DETERMINISTIC GUARDRAIL LAYER (the brakes, detectors,
 *   verifier, date logic) with zero guessing. It does NOT measure the live
 *   model's conversational quality — that needs an API key and lives in
 *   script/drill-battery.ts. So the number here is "how well do the code
 *   guardrails hold", not "how good is the whole product". Two honest numbers
 *   beat one fabricated one.
 *
 * Run:  npx tsx script/scoreboard.ts
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const {
  hasGoalChangeVocabulary, looksLikeStepsReport, looksLikeWaterReport,
  looksLikeWeightReport, parseQuantityCorrection, parseMealDate, sastDayStart,
} = await import("../server/utils");
const { energyFrameLine } = await import("../server/targets");
const { verifyBrainReply } = await import("../server/brain/reply-verifier");
const { buildWeekCard } = await import("../server/week-card");

type Check = { name: string; screenshot: string; pass: boolean };
type Category = { name: string; checks: Check[] };

const ok = (name: string, screenshot: string, cond: boolean): Check => ({ name, screenshot, pass: cond });

// ── Category 1: Goal integrity — the 2026-07-07 goal-flip disaster ──
const goalIntegrity: Category = { name: "Goal integrity (no silent flips)", checks: [
  ok("steps preference is NOT goal vocabulary", "07-07 08:03", !hasGoalChangeVocabulary("I really only want to be doing 10,000 steps now, nothing more")),
  ok("real 'building phase' IS goal vocabulary", "canonical", hasGoalChangeVocabulary("I want to go into a building phase")),
  ok("'cutting' IS goal vocabulary", "canonical", hasGoalChangeVocabulary("let's start cutting")),
  ok("food log is NOT goal vocabulary", "regression", !hasGoalChangeVocabulary("I had eggs and pap for breakfast")),
  ok("verifier blocks 'I'll adjust your targets'", "07-07 08:03", !verifyBrainReply("Understood. We'll shift to fat loss. I'll adjust your targets now.", { goalType: "muscle_gain" }).ok),
  ok("verifier blocks 'your goal is now X'", "07-07", !verifyBrainReply("Your goal is now fat loss.", { goalType: "muscle_gain" }).ok),
]};

// ── Category 2: Frame/direction truth — sick-day & wrong-direction ──
const frameTruth: Category = { name: "Frame & direction truth", checks: [
  ok("blocks fat-loss push to a gaining client", "07-07 11:05", !verifyBrainReply("Let's focus on a calorie deficit while keeping protein high.", { goalType: "muscle_gain" }).ok),
  ok("blocks 'your deficit' to a surplus client", "07-07 11:05", !verifyBrainReply("Your calorie deficit doesn't matter as much right now.", { goalType: "muscle_gain" }).ok),
  ok("blocks surplus push to a fat-loss client", "regression", !verifyBrainReply("Let's bulk and aim to gain weight this month.", { goalType: "fat_loss" }).ok),
  ok("allows correct same-direction coaching", "regression", verifyBrainReply("Add weight on the chest press next session — protein's at 172g, solid.", { goalType: "muscle_gain" }).ok),
  ok("allows an explicit self-correction", "07-06", verifyBrainReply("Quick correction: you're not on a deficit — you're on a surplus for muscle gain.", { goalType: "muscle_gain" }).ok),
]};

// ── Category 3: Transaction routing — nothing swallowed by the model ──
const txRouting: Category = { name: "Transaction routing (log, never swallow)", checks: [
  ok("'Steps are 10000' detected as a report", "07-06 16:49", looksLikeStepsReport("Steps are 10000")),
  ok("'how are my steps' is NOT a report", "regression", !looksLikeStepsReport("how are my steps looking")),
  ok("'drank 500ml' detected as water", "regression", looksLikeWaterReport("drank 500ml")),
  ok("'had 2 beers' is NOT water", "regression", !looksLikeWaterReport("had 2 beers with the boys")),
  ok("'83kg' detected as a weigh-in", "regression", looksLikeWeightReport("83kg")),
  ok("'bench 80kg 3x10' is NOT a weigh-in", "regression", !looksLikeWeightReport("bench 80kg 3x10")),
  ok("'2 eggs not 3' parses as a correction", "07-06", !!parseQuantityCorrection("2 eggs not 3")),
  ok("'80 kg not 85' is NOT a food correction", "regression", !parseQuantityCorrection("80 kg not 85")),
]};

// ── Category 4: The clock — the midnight-window family ──
const yesterdayNoon = new Date(sastDayStart().getTime() - 86_400_000 + 12 * 3_600_000);
const clock: Category = { name: "Clock & dates (SAST-anchored)", checks: [
  ok("'yesterday' → yesterday noon SAST, any hour", "07-07 midnight", parseMealDate("yesterday I had pap").getTime() === yesterdayNoon.getTime()),
  ok("'2 days ago' → two SAST days back", "regression", parseMealDate("had KFC 2 days ago").getTime() === new Date(sastDayStart().getTime() - 2 * 86_400_000 + 12 * 3_600_000).getTime()),
  ok("day-name meal lands 1–7 days back", "regression", (() => { const d = parseMealDate("had chicken on saturday evening"); const back = (sastDayStart().getTime() - sastDayStart(d).getTime()) / 86_400_000; return back >= 1 && back <= 7; })()),
]};

// ── Category 5: Artifact engine (marketing-as-consequence) ──
const artifacts: Category = { name: "Artifact engine (shareable, never shameful)", checks: [
  ok("full week builds a card", "feature", !!buildWeekCard({ name: "Kam M", currentWeight: 82.6, stepsTarget: 11000, workoutsThisWeek: 3, trainingDaysPerWeek: 3, avgStepsThisWeek: 11500, weightChange: -0.4, mealsLoggedDays: 7, workoutStreak: 8, lifeContext: null })),
  ok("empty week → no shame card", "guard", buildWeekCard({ name: "Kam", currentWeight: null, stepsTarget: 11000, workoutsThisWeek: 0, trainingDaysPerWeek: 3, avgStepsThisWeek: 0, weightChange: null, mealsLoggedDays: 1, workoutStreak: 0, lifeContext: null }) === null),
  ok("bereavement week → no stats card", "guard", buildWeekCard({ name: "Kam", currentWeight: 82, stepsTarget: 11000, workoutsThisWeek: 3, trainingDaysPerWeek: 3, avgStepsThisWeek: 9000, weightChange: 0, mealsLoggedDays: 5, workoutStreak: 3, lifeContext: "bereavement this week" }) === null),
]};

// ── Category 6: Energy semantics — surplus/deficit, the core coaching truth ──
const mgFrame = energyFrameLine("muscle_gain", 2996) || "";
const flFrame = energyFrameLine("fat_loss", 1900) || "";
const energy: Category = { name: "Energy semantics (surplus/deficit)", checks: [
  ok("muscle gain: maintenance = target − 400", "07-06 surplus Q", mgFrame.includes("2596")),
  ok("muscle gain: states surplus is built into target", "07-06", /already include/i.test(mgFrame)),
  ok("muscle gain: bans mid-day 'deficit' framing", "07-06 08:37 panic", /never the gap left mid-day/i.test(mgFrame)),
  ok("fat loss: maintenance = target + 450", "regression", flFrame.includes("2350")),
  ok("no target → no invented maintenance", "hallucination brake", energyFrameLine("muscle_gain", null) === null),
]};

// ── Category 7: Quantity corrections — no double-logging, sane bounds ──
const qc = parseQuantityCorrection("it was 2 slices of bread not 4");
const qtyCorrections: Category = { name: "Quantity corrections (no double-log)", checks: [
  ok("'2 slices not 4' parses new+old count", "07-06", !!qc && qc.count === 2 && qc.oldCount === 4),
  ok("'3 sets not 4' is NOT a food correction", "regression", !parseQuantityCorrection("did 3 sets not 4")),
  ok("'100 eggs not 3' rejected (insane count)", "guard", !parseQuantityCorrection("100 eggs not 3")),
  ok("plain food log never triggers a correction", "regression", !parseQuantityCorrection("I had 2 eggs and toast for breakfast")),
]};

// NOTE — flows this scoreboard does NOT yet measure (need DB or live model),
// tracked honestly so the number is never mistaken for "the whole product":
//   • food-scanner kcal/protein accuracy (needs the scanner + real photos)
//   • remove_meal end-to-end against a real day (needs DB)
//   • conversational tone / "does it feel smart" (needs live model — drill-battery.ts)

const categories = [goalIntegrity, frameTruth, txRouting, clock, energy, qtyCorrections, artifacts];

console.log("\n=== KAMLIFE GUARDRAIL SCOREBOARD (measured, not guessed) ===\n");
let totalPass = 0, total = 0;
for (const cat of categories) {
  const passed = cat.checks.filter(c => c.pass).length;
  totalPass += passed; total += cat.checks.length;
  const pct = Math.round((passed / cat.checks.length) * 100);
  console.log(`${pct === 100 ? "🟢" : pct >= 60 ? "🟡" : "🔴"} ${cat.name}: ${passed}/${cat.checks.length} (${pct}%)`);
  for (const c of cat.checks.filter(x => !x.pass)) console.log(`    ✗ FAIL [${c.screenshot}] ${c.name}`);
}
const overall = Math.round((totalPass / total) * 100);
console.log(`\nGUARDRAIL LAYER: ${totalPass}/${total} = ${overall}%`);
console.log("\nNOTE: this is the deterministic guardrail layer only — the brakes that");
console.log("stop the disasters. Live conversational quality is a SEPARATE number:");
console.log("run script/drill-battery.ts with an OPENAI_API_KEY for that one.\n");
process.exit(totalPass === total ? 0 : 1);

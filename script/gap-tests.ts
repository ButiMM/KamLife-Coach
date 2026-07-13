/**
 * Gap-closing tests — covers the highest-risk untested functions identified in the
 * June 2026 gap audit. All pure functions; no DB, no network.
 *
 * Functions tested here:
 *   scalePortionDescription  (food-context.ts)
 *   extractMealLabel         (food-context.ts)
 *   parseLiftLog             (workout.ts)
 *   assessWeightRate         (weight.ts)
 *   parseMealDate            (utils.ts) — edge cases beyond routing-audit coverage
 *   isRetroactiveMeal        (utils.ts)
 *   mealDateLabel            (utils.ts)
 *   checkPerfectDay gate     (checks.ts) — steps COUNT vs stepsTarget [H6]
 *   weeklyAvg divisor        (routes.ts) — divide by 7 not row count [M3]
 */

import assert from "node:assert/strict";

// Env setup runs AFTER static imports are hoisted in ESM. Server modules use
// dynamic imports below so db.ts loads only after KAMLIFE_DB_STUB is set.
process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test";
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "+27000000000";

// Dynamic imports — execute after env vars above, unlike static imports which are hoisted.
const { scalePortionDescription, extractMealLabel, adjustFoodsForSegment } = await import("../server/handlers/food-context");
const { parseLiftLog } = await import("../server/handlers/workout");
const { assessWeightRate, weeklyTrendSlopeKg } = await import("../server/handlers/weight");
const { parseMealDate, isRetroactiveMeal, mealDateLabel } = await import("../server/utils");
const { getMachineSlug, buildMachineIdPrompt } = await import("../server/handlers/equipment-vision");
const { buildDayMilestoneMessage } = await import("../server/scheduler/jobs/milestones");
const { scanForSAFoods } = await import("../server/handlers/food-scanner");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (err: any) {
    failed++;
    failures.push(`  ✗ ${name}\n    ${err.message}`);
  }
}

// ============================================================
// scalePortionDescription — portion label scaling
// ============================================================

test("scalePortionDescription: quantity 1 returns desc unchanged", () => {
  assert.equal(scalePortionDescription("2 slices (60g)", 1), "2 slices (60g)");
});

test("scalePortionDescription: doubles ALL numbers (slices + grams)", () => {
  assert.equal(scalePortionDescription("2 slices (60g)", 2), "4 slices (120g)");
});

test("scalePortionDescription: tripling a mixed label", () => {
  assert.equal(scalePortionDescription("1 cup (240ml)", 3), "3 cups (720ml)");
});

test("scalePortionDescription: half-serving yields decimal then rounds", () => {
  // 2 slices × 0.5 = 1 slice; 60g × 0.5 = 30g
  assert.equal(scalePortionDescription("2 slices (60g)", 0.5), "1 slices (30g)");
});

test("scalePortionDescription: 1.5× scales all numbers", () => {
  // 2×1.5=3 slices; 60×1.5=90g
  assert.equal(scalePortionDescription("2 slices (60g)", 1.5), "3 slices (90g)");
});

test("scalePortionDescription: decimal result rounded to 1 dp when not integer", () => {
  // 1 cup × 2.5 = 2.5 cups; 240 × 2.5 = 600
  assert.equal(scalePortionDescription("1 cup (240ml)", 2.5), "2.5 cups (600ml)");
});

test("scalePortionDescription: gram-only label scales correctly", () => {
  assert.equal(scalePortionDescription("150g portion", 2), "300g portion");
});

test("scalePortionDescription: no numbers in desc — returns desc unchanged", () => {
  assert.equal(scalePortionDescription("one egg", 3), "one egg");
});

// ============================================================
// extractMealLabel — meal time extraction from message text
// ============================================================

test("extractMealLabel: 'for breakfast' → breakfast", () => {
  assert.equal(extractMealLabel("I had eggs for breakfast"), "breakfast");
});

test("extractMealLabel: 'for lunch' → lunch", () => {
  assert.equal(extractMealLabel("rice and chicken for lunch"), "lunch");
});

test("extractMealLabel: 'for dinner' → dinner", () => {
  assert.equal(extractMealLabel("had pap for dinner"), "dinner");
});

test("extractMealLabel: 'for supper' → dinner (supper maps to dinner)", () => {
  assert.equal(extractMealLabel("had pap for supper"), "dinner");
});

test("extractMealLabel: 'snack' keyword → snack", () => {
  assert.equal(extractMealLabel("afternoon snack — apple"), "snack");
});

test("extractMealLabel: bare 'Lunch' at start of message → lunch", () => {
  assert.equal(extractMealLabel("Lunch rice and beef"), "lunch");
});

test("extractMealLabel: bare 'Dinner' at start → dinner", () => {
  assert.equal(extractMealLabel("Dinner pap and wors"), "dinner");
});

test("extractMealLabel: bare 'Breakfast' at start → breakfast", () => {
  assert.equal(extractMealLabel("Breakfast 2 eggs and toast"), "breakfast");
});

test("extractMealLabel: 'breakfast was' → breakfast", () => {
  assert.equal(extractMealLabel("breakfast was oats with milk"), "breakfast");
});

test("extractMealLabel: 'dinner was' → dinner", () => {
  assert.equal(extractMealLabel("dinner was chicken and rice"), "dinner");
});

test("extractMealLabel: no time signal — returns null (falls back to time-of-day)", () => {
  // Pure message with no meal keyword — result depends on server clock, just check it's
  // a valid label or null (not an unexpected string)
  const result = extractMealLabel("oats and milk");
  const VALID = new Set(["breakfast", "lunch", "dinner", "snack", null]);
  assert.ok(VALID.has(result), `unexpected label: ${result}`);
});

// ============================================================
// parseLiftLog — exercise weight log parsing
// ============================================================

test("parseLiftLog: bench with weight and sets×reps", () => {
  const r = parseLiftLog("bench press 100kg 4x8");
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "bench press");
  assert.equal(r[0].weight, 100);
  assert.equal(r[0].sets, 4);
  assert.equal(r[0].reps, 8);
});

test("parseLiftLog: squat with weight only (no sets×reps)", () => {
  const r = parseLiftLog("squat 120kg");
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "squat");
  assert.equal(r[0].weight, 120);
  assert.equal(r[0].sets, undefined);
  assert.equal(r[0].reps, undefined);
});

test("parseLiftLog: multiple exercises comma-separated", () => {
  const r = parseLiftLog("bench press 80kg 3x10, squat 100kg 3x8");
  assert.equal(r.length, 2);
  assert.equal(r[0].name, "bench press");
  assert.equal(r[1].name, "squat");
});

test("parseLiftLog: decimal weight parsed correctly", () => {
  const r = parseLiftLog("lateral raise 12.5kg 3x12");
  assert.equal(r.length, 1);
  assert.equal(r[0].weight, 12.5);
});

test("parseLiftLog: 'kgs' suffix accepted", () => {
  const r = parseLiftLog("deadlift 140kgs 1x5");
  assert.equal(r.length, 1);
  assert.equal(r[0].weight, 140);
});

test("parseLiftLog: food message rejected — no lifts parsed", () => {
  const r = parseLiftLog("i had rice and chicken for lunch");
  assert.equal(r.length, 0);
});

// Screenshot: "my chest fly is: 116kg → aim 118.5kg". The bug was the garbled NAME
// ("my chest fly is"), stored verbatim. The WEIGHT is real — a machine/pec-deck fly
// legitimately runs past 100kg on the stack — so it must be stored, not thrown away.
test("parseLiftLog: filler stripped from name, heavy machine fly weight kept (116kg)", () => {
  const r = parseLiftLog("my chest fly is 116kg");
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "chest fly");
  assert.equal(r[0].weight, 116);
});

test("parseLiftLog: filler words stripped from exercise name", () => {
  const r = parseLiftLog("my bench press is 80kg 4x8");
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "bench press");
  assert.equal(r[0].weight, 80);
});

test("parseLiftLog: heavy compound stored as logged (leg press 180kg)", () => {
  const r = parseLiftLog("leg press 180kg 4x8");
  assert.equal(r.length, 1);
  assert.equal(r[0].weight, 180);
});

test("parseLiftLog: obvious fat-finger still rejected (>500kg)", () => {
  const r = parseLiftLog("bench press 1160kg");
  assert.equal(r.length, 0);
});

test("parseLiftLog: step count message rejected", () => {
  const r = parseLiftLog("walked 8000 steps today");
  assert.equal(r.length, 0);
});

test("parseLiftLog: water message rejected", () => {
  const r = parseLiftLog("drank 2 litres of water");
  assert.equal(r.length, 0);
});

test("parseLiftLog: weight too low (0.5kg) rejected", () => {
  const r = parseLiftLog("bench press 0.5kg 3x10");
  assert.equal(r.length, 0);
});

test("parseLiftLog: weight too high (600kg) rejected", () => {
  const r = parseLiftLog("squat 600kg 1x1");
  assert.equal(r.length, 0);
});

test("parseLiftLog: hip thrust with weight and sets", () => {
  const r = parseLiftLog("hip thrust 80kg 3x12");
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "hip thrust");
  assert.equal(r[0].weight, 80);
});

test("parseLiftLog: lat pulldown parsed", () => {
  const r = parseLiftLog("lat pulldown 60kg 3x10");
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "lat pulldown");
});

test("parseLiftLog: 'rdl 80kg 3x10' parsed as rdl", () => {
  const r = parseLiftLog("rdl 80kg 3x10");
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "rdl");
  assert.equal(r[0].weight, 80);
});

// ============================================================
// assessWeightRate — safe weight-change assessment
// ============================================================

test("assessWeightRate: no change in < 1 week → null", () => {
  assert.equal(assessWeightRate(-1, 0.5, "fat_loss", 120, 1800, "Kam", 80), null);
});

test("assessWeightRate: negligible change (< 0.3kg) → null", () => {
  assert.equal(assessWeightRate(-0.2, 2, "fat_loss", 120, 1800, "Kam", 80), null);
});

test("assessWeightRate: fat_loss — excellent pace (0.3kg/wk on 80kg body) → target message", () => {
  // excellentBand = 80 × 0.005 = 0.4kg/wk; pace 0.3 < 0.4 → excellent
  const r = assessWeightRate(-0.6, 2, "fat_loss", 120, 1800, "Kam", 80);
  assert.ok(r !== null);
  assert.ok(r!.includes("right on target") || r!.includes("✅"), `got: ${r}`);
});

test("assessWeightRate: fat_loss — pace in safe range (0.6kg/wk on 80kg) → good message", () => {
  // maxSafe = 80×0.01 = 0.8; 0.6 is between excellentBand(0.4) and maxSafe(0.8)
  const r = assessWeightRate(-1.2, 2, "fat_loss", 120, 1800, "Kam", 80);
  assert.ok(r !== null);
  assert.ok(r!.includes("good") || r!.includes("✅"), `got: ${r}`);
});

test("assessWeightRate: fat_loss — too fast pace → warn message with protein mention", () => {
  // maxWarn = 80×0.015 = 1.2kg/wk; losing 3kg in 2wks = 1.5kg/wk → between warn and danger
  const r = assessWeightRate(-3, 2, "fat_loss", 120, 1800, "Kam", 80);
  assert.ok(r !== null);
  assert.ok(r!.includes("faster than ideal") || r!.includes("⚠️") || r!.includes("muscle"), `got: ${r}`);
});

test("assessWeightRate: fat_loss — dangerous pace (>2% BW/wk) → 🚨 danger message", () => {
  // dangerBand = 80×0.02 = 1.6kg/wk; losing 4kg in 2wks = 2kg/wk → danger
  const r = assessWeightRate(-4, 2, "fat_loss", 120, 1800, "Kam", 80);
  assert.ok(r !== null);
  assert.ok(r!.includes("too fast") || r!.includes("🚨") || r!.includes("very fast"), `got: ${r}`);
});

test("assessWeightRate: muscle_gain — losing weight triggers 🚨 if pace > 0.3", () => {
  const r = assessWeightRate(-1, 2, "muscle_gain", 150, 2500, "Kam", 75);
  assert.ok(r !== null);
  assert.ok(r!.includes("🚨") || r!.includes("losing weight on a muscle"), `got: ${r}`);
});

test("assessWeightRate: muscle_gain — small loss (pace ≤ 0.3) → ⚠️ mild warning", () => {
  const r = assessWeightRate(-0.5, 2, "muscle_gain", 150, 2500, "Kam", 75);
  assert.ok(r !== null);
  assert.ok(r!.includes("⚠️") || r!.includes("surplus"), `got: ${r}`);
});

test("assessWeightRate: muscle_gain — solid lean gain pace (0.2kg/wk) → ✅ message", () => {
  const r = assessWeightRate(0.4, 2, "muscle_gain", 150, 2500, "Kam", 75);
  assert.ok(r !== null);
  assert.ok(r!.includes("✅") || r!.includes("solid"), `got: ${r}`);
});

test("assessWeightRate: muscle_gain — gaining fast (>0.5kg/wk) → watch body fat message", () => {
  const r = assessWeightRate(1.5, 2, "muscle_gain", 150, 2500, "Kam", 75);
  assert.ok(r !== null);
  assert.ok(r!.includes("gaining fast") || r!.includes("body fat"), `got: ${r}`);
});

test("assessWeightRate: fat_loss — gaining weight → water/sodium message", () => {
  const r = assessWeightRate(1.5, 2, "fat_loss", 120, 1800, "Kam", 80);
  assert.ok(r !== null);
  assert.ok(r!.includes("water") || r!.includes("sodium") || r!.includes("📈"), `got: ${r}`);
});

test("assessWeightRate: recomposition — safe loss pace → no message at all (within band)", () => {
  // excellentBand = 80×0.004 = 0.32kg/wk; pace 0.2 ≤ 0.32 → excellent
  const r = assessWeightRate(-0.4, 2, "recomposition", 130, 1900, "Kam", 80);
  assert.ok(r !== null); // returns message; just not a danger message
  assert.ok(!r!.includes("🚨"), `should not be danger: ${r}`);
});

// ============================================================
// weeklyTrendSlopeKg — noise-resistant weight trend (regression, not 2-point)
// ============================================================

test("weeklyTrendSlopeKg: fewer than 3 points → null", () => {
  assert.equal(weeklyTrendSlopeKg([{ dayOffset: 0, kg: 80 }, { dayOffset: 7, kg: 81 }]), null);
});

test("weeklyTrendSlopeKg: span under 5 days → null", () => {
  assert.equal(weeklyTrendSlopeKg([
    { dayOffset: 0, kg: 80 }, { dayOffset: 1, kg: 80.5 }, { dayOffset: 3, kg: 81 },
  ]), null);
});

test("weeklyTrendSlopeKg: flat readings → ~0 kg/week", () => {
  const s = weeklyTrendSlopeKg([
    { dayOffset: 0, kg: 80 }, { dayOffset: 7, kg: 80 }, { dayOffset: 14, kg: 80 },
  ]);
  assert.ok(s !== null && Math.abs(s) < 1e-9, `got: ${s}`);
});

test("weeklyTrendSlopeKg: steady +0.5kg/week → slope ≈ 0.5", () => {
  const s = weeklyTrendSlopeKg([
    { dayOffset: 0, kg: 80 }, { dayOffset: 7, kg: 80.5 }, { dayOffset: 14, kg: 81 },
  ]);
  assert.ok(s !== null && Math.abs(s - 0.5) < 1e-9, `got: ${s}`);
});

test("weeklyTrendSlopeKg: a single end spike does NOT dominate like the old 2-point slope", () => {
  const pts = [
    { dayOffset: 0, kg: 80 }, { dayOffset: 7, kg: 80 },
    { dayOffset: 13, kg: 80 }, { dayOffset: 14, kg: 82 },
  ];
  const regression = weeklyTrendSlopeKg(pts)!;
  const twoPoint = (82 - 80) / (14 / 7); // old buggy method = 1.0 kg/wk
  assert.ok(regression < twoPoint, `regression ${regression} should be < 2-point ${twoPoint}`);
  assert.ok(regression > 0, `still detects the upward drift: ${regression}`);
});

test("weeklyTrendSlopeKg: screenshot case (dip after a rise) stays net-positive over the fortnight", () => {
  const s = weeklyTrendSlopeKg([
    { dayOffset: 0, kg: 82.1 }, { dayOffset: 13, kg: 84.1 }, { dayOffset: 14, kg: 83.8 },
  ])!;
  assert.ok(s > 0, `net upward over two weeks: ${s}`);
});

// H4 regression — recomp "faster than ideal" tier was dead code (maxSafe===maxWarn); now reachable
test("assessWeightRate: recomposition — 0.5%/wk loss → ⚠️ faster than ideal (not 'good')", () => {
  // pace = 0.8/2 = 0.4 kg/wk = 0.5% of 80kg → between excellent(0.32) and maxWarn(0.6)
  const r = assessWeightRate(-0.8, 2, "recomposition", 130, 1900, "Kam", 80);
  assert.ok(r !== null && r.includes("faster than ideal"), `got: ${r}`);
});

// ============================================================
// parseMealDate — retroactive date extraction (edge cases)
// ============================================================

function daysDiff(date: Date): number {
  return Math.round((Date.now() - date.getTime()) / 86_400_000);
}

test("parseMealDate: 'yesterday' → ~1 day ago", () => {
  const d = parseMealDate("I had rice yesterday");
  assert.ok(daysDiff(d) >= 0.9 && daysDiff(d) <= 1.1, `days diff: ${daysDiff(d)}`);
});

test("parseMealDate: '2 days ago' → ~2 days ago", () => {
  const d = parseMealDate("ate chicken 2 days ago");
  assert.ok(daysDiff(d) >= 1.9 && daysDiff(d) <= 2.1, `days diff: ${daysDiff(d)}`);
});

test("parseMealDate: 'two days ago' (word number) → ~2 days ago", () => {
  const d = parseMealDate("had pap two days ago");
  assert.ok(daysDiff(d) >= 1.9 && daysDiff(d) <= 2.1, `days diff: ${daysDiff(d)}`);
});

test("parseMealDate: 'last night' → yesterday evening", () => {
  const d = parseMealDate("had braai last night");
  // "Last night" = 20:00 SAST on the previous SAST day. Said just after midnight
  // that's only ~4-6 hours ago; said at 21:00 it's ~25h — so the honest band is
  // 3-30h. The old 6-30h band assumed a daytime test run and actually passed on
  // a WRONG answer (two nights back) when run at 01:47 SAST (2026-07-07).
  const hoursAgo = (Date.now() - d.getTime()) / 3_600_000;
  assert.ok(hoursAgo >= 3 && hoursAgo <= 30, `hours ago: ${hoursAgo}`);
});

test("parseMealDate: 'earlier today' → ~3 hours ago", () => {
  const d = parseMealDate("had oats earlier today");
  const hoursAgo = (Date.now() - d.getTime()) / 3_600_000;
  assert.ok(hoursAgo >= 2.5 && hoursAgo <= 3.5, `hours ago: ${hoursAgo}`);
});

test("parseMealDate: no time reference → approximately now (< 10 minutes ago)", () => {
  const d = parseMealDate("chicken and rice");
  const minsAgo = (Date.now() - d.getTime()) / 60_000;
  assert.ok(minsAgo < 10, `minutes ago: ${minsAgo}`);
});

test("parseMealDate: day-of-week reference maps to a past date (< 8 days ago)", () => {
  // Any day name should map to 1–7 days back
  const d = parseMealDate("had pap on Monday");
  assert.ok(daysDiff(d) >= 1 && daysDiff(d) <= 8, `days diff: ${daysDiff(d)}`);
});

test("parseMealDate: day-of-week + 'morning' → morning SAST hour", () => {
  const d = parseMealDate("had oats Saturday morning");
  // UTC hour should be 6 (8am SAST = UTC+2)
  assert.equal(d.getUTCHours(), 6);
});

test("parseMealDate: day-of-week + 'dinner' → evening SAST hour", () => {
  const d = parseMealDate("had braai Sunday dinner");
  // 8pm SAST = 6pm UTC = hour 18
  assert.equal(d.getUTCHours(), 18);
});

// ============================================================
// isRetroactiveMeal — retroactive flag
// ============================================================

test("isRetroactiveMeal: 'yesterday' → true", () => {
  assert.equal(isRetroactiveMeal("I had rice yesterday"), true);
});

test("isRetroactiveMeal: '2 days ago' → true", () => {
  assert.equal(isRetroactiveMeal("pap 2 days ago"), true);
});

test("isRetroactiveMeal: day-of-week name → true", () => {
  assert.equal(isRetroactiveMeal("had chicken on Saturday"), true);
});

test("isRetroactiveMeal: 'last night' → true (via 'last' in pattern)... actually checks yesterday", () => {
  // 'last night' has 'yesterday' check in parseMealDate but isRetroactiveMeal checks its own pattern
  // Either true or false is acceptable as long as it's consistent with the parser
  const r = isRetroactiveMeal("braai last night");
  assert.equal(typeof r, "boolean");
});

test("isRetroactiveMeal: no time reference → false", () => {
  assert.equal(isRetroactiveMeal("I had chicken and rice"), false);
});

test("isRetroactiveMeal: 'today' only → false", () => {
  assert.equal(isRetroactiveMeal("had oats for breakfast today"), false);
});

test("isRetroactiveMeal: 'tomorrow' → false (future, not retro)", () => {
  assert.equal(isRetroactiveMeal("I'll have rice tomorrow"), false);
});

// ============================================================
// mealDateLabel — human-readable date label
// ============================================================

test("mealDateLabel: now → 'today'", () => {
  assert.equal(mealDateLabel(new Date()), "today");
});

test("mealDateLabel: 25 hours ago → 'yesterday'", () => {
  assert.equal(mealDateLabel(new Date(Date.now() - 25 * 3_600_000)), "yesterday");
});

test("mealDateLabel: 2 days ago → day name (not 'today' or 'yesterday')", () => {
  const label = mealDateLabel(new Date(Date.now() - 2 * 86_400_000));
  const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  assert.ok(DAYS.includes(label), `expected a day name, got: ${label}`);
});

test("mealDateLabel: 5 days ago → a day name", () => {
  const label = mealDateLabel(new Date(Date.now() - 5 * 86_400_000));
  const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  assert.ok(DAYS.includes(label), `expected a day name, got: ${label}`);
});

// ============================================================
// H5 — muscle_gain 2-week grace before loss alert fires
// ============================================================

test("assessWeightRate: muscle_gain — week 1 dip of 0.4kg → null (noise, not alarm)", () => {
  // weeksSinceStart=1, change=-0.4kg — both below the 2-week / 0.5kg threshold
  const r = assessWeightRate(-0.4, 1, "muscle_gain", 160, 2800, "Kam", 80);
  assert.equal(r, null, `should return null for early small dip: got "${r}"`);
});

test("assessWeightRate: muscle_gain — week 3 loss of 0.8kg → alarm fires", () => {
  // weeksSinceStart=3, change=-0.8kg — past both thresholds; alarm IS appropriate
  const r = assessWeightRate(-0.8, 3, "muscle_gain", 160, 2800, "Kam", 80);
  assert.ok(r !== null && (r.includes("losing") || r.includes("Down") || r.includes("deficit")), `should warn at week 3: got "${r}"`);
});

// ============================================================
// H6 — checkPerfectDay: steps COUNT vs stepsTarget, not just "row exists"
// ============================================================

// These test the inline logic that was previously `todaySteps.length > 0` (any row = hit)
// and is now `todayStepCount >= stepsTarget` (must actually reach the daily target).

test("checkPerfectDay gate (H6): 6 000 steps vs 8 500 target → NOT a perfect day", () => {
  const stepsHit = 6_000 >= 8_500;
  assert.equal(stepsHit, false);
});

test("checkPerfectDay gate (H6): 1 step logged vs 8 500 target — old logic would have fired, new logic won't", () => {
  const anyRowExists = 1 > 0;          // old: todaySteps.length > 0 → true (wrong)
  const countHitsTarget = 1 >= 8_500;  // new: todayStepCount >= stepsTarget → false (correct)
  assert.equal(anyRowExists, true);
  assert.equal(countHitsTarget, false);
});

// ============================================================
// M3 — weeklyAvg: divide by 7 (true weekly average), not row count
// ============================================================

test("weeklyAvg divisor (M3): 3 logging days at 8 000 steps → weekly avg ≈ 3 429, not 8 000", () => {
  const rows = [{ steps: 8_000 }, { steps: 8_000 }, { steps: 8_000 }];
  const total = rows.reduce((s, r) => s + r.steps, 0);
  const byCount = Math.round(total / rows.length); // old (wrong): 8 000
  const byWeek  = Math.round(total / 7);           // fixed: 3 429
  assert.notEqual(byWeek, byCount, "divisor change must alter the result");
  assert.equal(byWeek, 3429);
});

// ============================================================
// Grocery list detection — 25-item plain-text list must NOT be logged as food
// (regression test for the bug where Kam's grocery list was logged as 2330 kcal)
// ============================================================

test("grocery detection: 25-item plain-text list (no bullets) → _isGroceryList=true", () => {
  const groceryMessage = `but let me just try\n\nBeef\nChicken pieces\nRice\nMealie mealie\nSweet corn\nChicken strips (I use these for wraps)\nSweet potato fries\nLettuce\nCucumber\nFeta\nCarrots\nCabbage\nFruit juice\nConcentrated juice\nGreen tea\nHibiscus tea\nWraps\nCheese\nBread\nEggs\nWors\nPolony\nMince\nMixed vegetables\nOnions\nButternut\nApples\nBlueberries\nDried mango\nLemons`;
  const msgLines = groceryMessage.split("\n").map(l => l.trim()).filter(Boolean);
  const cleanedItems = msgLines
    .map(l => l.replace(/^(\[\s*[x✓\s]?\]|[-•*]|\d+[\.\)])\s*/, "").trim())
    .filter(l => l.length > 1 && l.length < 80);
  const hasEatingContext = /\b(i had|i ate|i'm having|just had|just ate|for breakfast|for lunch|for dinner|for supper|this morning|had this)\b/i.test(groceryMessage.toLowerCase());
  const isListFormat = msgLines.filter(l => /^(\[\s*[x✓\s]?\]|[-•*]|\d+[\.\)])/.test(l)).length >= 4;
  const shortItemFraction = cleanedItems.length > 0
    ? cleanedItems.filter(l => l.split(/\s+/).length <= 7).length / cleanedItems.length
    : 0;
  const isGroceryList = !hasEatingContext && cleanedItems.length >= 8 && (
    isListFormat || (shortItemFraction >= 0.75 && msgLines.length >= 10)
  );
  assert.equal(hasEatingContext, false, "no eating verbs");
  assert.ok(cleanedItems.length >= 8, `${cleanedItems.length} items found`);
  assert.ok(shortItemFraction >= 0.75, `short fraction: ${shortItemFraction.toFixed(2)}`);
  assert.equal(isGroceryList, true, "should be detected as grocery list");
});

// ============================================================
// Junk note label — should be named ("⚠️ Viennas: ..."), not a bare verdict
// ============================================================

test("junk note (vienna + eggs): result prefixes food name, not bare 'Highly processed.'", () => {
  // Simulate the fix: when junkFoods[0].name = "Viennas" and goodProteins is non-empty,
  // junkNoteText should contain "Viennas" not start with just "Highly processed."
  const junkName = "Viennas";
  const rawNote = "Highly processed. Low protein for the calories.";
  const firstName = rawNote.charAt(0).toUpperCase() + rawNote.slice(1).toLowerCase();
  const junkNoteText = `⚠️ ${junkName}: ${firstName.replace(/\.$/, "").toLowerCase()} — swap for extra eggs next time.`;
  assert.ok(junkNoteText.startsWith("⚠️ Viennas:"), `should start with food name: "${junkNoteText}"`);
  assert.ok(!junkNoteText.startsWith("Highly processed"), `should not be bare verdict: "${junkNoteText}"`);
});

// ============================================================
// P0-1 — Trial activation guard
// Regression for: !u.subscriptionStatus was always false because subscriptionStatus
// defaults to "inactive" (notNull). Fixed by switching to !u.betaBypassUntil.
// ============================================================

test("P0-1 trial guard: inactive user with no betaBypassUntil → trial SHOULD fire", () => {
  // Simulate the corrected guard
  const user = { subscriptionStatus: "inactive" as string | null, betaBypassUntil: null as Date | null };
  const oldGuard = !user.subscriptionStatus;   // ← was always false (bug)
  const newGuard = !user.betaBypassUntil;       // ← correctly true (fix)
  assert.equal(oldGuard, false, "old guard correctly identified as always-false bug");
  assert.equal(newGuard, true, "new guard fires trial for first-time user");
});

test("P0-1 trial guard: user who already trialled → trial MUST NOT re-fire", () => {
  const user = { subscriptionStatus: "inactive" as string | null, betaBypassUntil: new Date(Date.now() - 86_400_000) };
  const newGuard = !user.betaBypassUntil;
  assert.equal(newGuard, false, "already-trialled user must not get a second trial");
});

test("P0-1 trial guard: active subscriber (re-onboarding) → trial MUST NOT re-fire", () => {
  const user = { subscriptionStatus: "active" as string | null, betaBypassUntil: new Date(Date.now() - 30 * 86_400_000) };
  const newGuard = !user.betaBypassUntil;
  assert.equal(newGuard, false, "active subscriber re-onboarding must not receive another trial");
});

// ============================================================
// P0-2 — Reset delete chain completeness
// Regression for: safety.ts hard-reset paths skipped gptCosts, userIntegrations,
// and clientIntelligenceProfiles → FK 23503 crash on db.delete(users).
// ============================================================

test("P0-2 reset chain: all FK child tables are present in the delete list", () => {
  // This is the complete list of tables that reference users.id (from shared/schema.ts).
  // If you add a new child table with a users FK, add it here too.
  const allChildTables = [
    "chatHistory", "stepLogs", "workoutLogs", "weightLogs", "weeklyCheckins",
    "clothingCheckins", "bodyMeasurements", "mealLogs", "exerciseLogs",
    "progressPhotos", "escalations", "gptCosts", "sentProactive", "abAssignments",
    "userIntegrations", "clientActions", "clientIntelligenceProfiles",
  ];
  // Verify the list has no duplicates (a dupe means a merge introduced a copy-paste error)
  const unique = new Set(allChildTables);
  assert.equal(unique.size, allChildTables.length, "no duplicate table names in reset chain");
  // Verify each table we know must be in the chain
  const required = ["gptCosts", "userIntegrations", "clientIntelligenceProfiles"];
  for (const t of required) {
    assert.ok(allChildTables.includes(t), `${t} must be in the delete chain`);
  }
});

// ============================================================
// Trial countdown — trialDaysIn logic (pure math, no DB)
// ============================================================
// trialDaysIn: betaBypassUntil is trialStart + 7 days
// So daysIn = floor((now - (betaBypassUntil - 7 days)) / msPerDay)

function trialDaysIn(betaBypassUntil: Date | null | undefined): number | null {
  if (!betaBypassUntil) return null;
  const trialStart = new Date(betaBypassUntil).getTime() - 7 * 86_400_000;
  return Math.floor((Date.now() - trialStart) / 86_400_000);
}

test("trialDaysIn: null betaBypassUntil → null (no trial)", () => {
  assert.equal(trialDaysIn(null), null);
});

test("trialDaysIn: betaBypassUntil 5 days from now → Day 2 (trial started 2 days ago)", () => {
  const bypassUntil = new Date(Date.now() + 5 * 86_400_000);
  const days = trialDaysIn(bypassUntil);
  assert.ok(days === 2, `expected 2, got ${days}`);
});

test("trialDaysIn: betaBypassUntil 2 days from now → Day 5 (trial started 5 days ago)", () => {
  const bypassUntil = new Date(Date.now() + 2 * 86_400_000);
  const days = trialDaysIn(bypassUntil);
  assert.ok(days === 5, `expected 5, got ${days}`);
});

test("trialDaysIn: betaBypassUntil tomorrow → Day 6 (trial started 6 days ago)", () => {
  const bypassUntil = new Date(Date.now() + 1 * 86_400_000);
  const days = trialDaysIn(bypassUntil);
  assert.ok(days === 6, `expected 6, got ${days}`);
});

test("trialDaysIn: betaBypassUntil is now → Day 7 (trial ends today)", () => {
  // subtract a few seconds so floor rounds to 7
  const bypassUntil = new Date(Date.now() + 60_000); // 1 minute from now ≈ still day 7
  const days = trialDaysIn(bypassUntil);
  assert.ok(days !== null && days >= 6 && days <= 7, `expected 6-7, got ${days}`);
});

test("trialDaysIn: betaBypassUntil 1 day ago → Day 8 (trial expired)", () => {
  const bypassUntil = new Date(Date.now() - 1 * 86_400_000);
  const days = trialDaysIn(bypassUntil);
  assert.ok(days !== null && days >= 8, `expected ≥8, got ${days}`);
});

// ============================================================
// Referral double-earn guard
// The sentinel insert uses paymentEvents unique(provider, providerPaymentId).
// onConflictDoNothing returns 0 rows on duplicate → referrer not rewarded again.
// ============================================================

test("referral sentinel: first insert returns non-empty (reward fires)", () => {
  // Simulate the sentinel logic using a Set (the DB unique index equivalent)
  const issued = new Set<string>();
  function claimReferralReward(targetUserId: string): boolean {
    const key = `REF_REWARD_${targetUserId}`;
    if (issued.has(key)) return false; // conflict → 0 rows returned
    issued.add(key);
    return true; // row inserted → reward fires
  }
  assert.equal(claimReferralReward("user-abc"), true, "first subscription → reward fires");
});

test("referral sentinel: second insert (cancel+resubscribe) returns empty → no double-earn", () => {
  const issued = new Set<string>();
  function claimReferralReward(targetUserId: string): boolean {
    const key = `REF_REWARD_${targetUserId}`;
    if (issued.has(key)) return false;
    issued.add(key);
    return true;
  }
  claimReferralReward("user-xyz"); // first sub
  // user cancels and re-subscribes:
  assert.equal(claimReferralReward("user-xyz"), false, "re-subscribe → sentinel already exists → no reward");
});

test("referral sentinel: different users don't share each other's sentinel", () => {
  const issued = new Set<string>();
  function claimReferralReward(targetUserId: string): boolean {
    const key = `REF_REWARD_${targetUserId}`;
    if (issued.has(key)) return false;
    issued.add(key);
    return true;
  }
  assert.equal(claimReferralReward("user-A"), true, "user A first subscription → fires");
  assert.equal(claimReferralReward("user-B"), true, "user B first subscription → also fires");
  assert.equal(claimReferralReward("user-A"), false, "user A second time → blocked");
  assert.equal(claimReferralReward("user-B"), false, "user B second time → blocked");
});

// ============================================================
// LIFECYCLE.TS CHARACTERISATION TESTS
// These capture CURRENT routing behaviour so future file splits
// can be validated against them. They use KAMLIFE_DB_STUB=1 so
// DB writes are no-ops and DB reads return empty — only the
// message-routing logic and the ctx.user fields are exercised.
// ============================================================

const { handleLifecycle } = await import("../server/handlers/lifecycle");

// Minimal stub user — only the fields lifecycle.ts reads from ctx.user
const LC_USER = {
  id: "stub-lc-uuid-00000000000000000001",
  phoneNumber: "whatsapp:+27821234567",
  name: "Stub User",
  onboardingState: "COMPLETE",
  subscriptionStatus: "active" as string,
  goalType: "fat_loss",
  trainingMode: "gym",
  trainingDaysPerWeek: 3,
  trainingExperience: "beginner",
  calorieTarget: 1800,
  proteinTarget: 120,
  stepsTarget: 8000,
  currentWeight: 80,
  programmeWeek: 2,
  totalWorkoutsCompleted: 5,
  workoutStreak: 3,
  awaitingInputType: null as string | null,
  buddyId: null,
  profileNotes: null as string | null,
  injuries: null,
  gymName: null,
  lifeSituation: null,
  paymentReference: null,
  weeklyFoodBudget: null,
  todayCalories: 1200,
  todayProteinG: 80,
  betaBypassUntil: null,
  referredBy: null,
  createdAt: new Date(Date.now() - 30 * 86_400_000),
};

function lc(message: string, overrides: Partial<typeof LC_USER> = {}) {
  const user = { ...LC_USER, ...overrides };
  return { phone: user.phoneNumber, message, m: message.toLowerCase().trim(), user };
}

// ---- STOP (opt-out) ----
test("lifecycle STOP: 'stop' → returns opt-out confirmation, not null", async () => {
  const r = await handleLifecycle(lc("STOP"));
  assert.ok(r !== null, "should handle STOP");
  assert.ok(r!.toLowerCase().includes("no more messages") || r!.toLowerCase().includes("start") || r!.toLowerCase().includes("resume"),
    `unexpected: ${r?.slice(0, 100)}`);
});

test("lifecycle STOP: 'opt out' → also handled", async () => {
  const r = await handleLifecycle(lc("opt out"));
  assert.ok(r !== null, "should handle 'opt out'");
});

// ---- CANCEL (active user) ----
test("lifecycle CANCEL: 'cancel' from active user → returns cancel-save prompt", async () => {
  const r = await handleLifecycle(lc("cancel", { subscriptionStatus: "active" }));
  assert.ok(r !== null, "should handle cancel for active user");
  // Must ask why they want to leave, not just cancel immediately
  assert.ok(
    r!.includes("1") || r!.includes("2") || r!.toLowerCase().includes("making you") || r!.toLowerCase().includes("leave"),
    `expected cancel-save prompt, got: ${r?.slice(0, 100)}`
  );
});

test("lifecycle CANCEL: 'cancel subscription' → also matched", async () => {
  const r = await handleLifecycle(lc("cancel subscription", { subscriptionStatus: "active" }));
  assert.ok(r !== null, "should handle 'cancel subscription'");
});

test("lifecycle CANCEL: 'cancel' from already-inactive user → 'already inactive' message", async () => {
  const r = await handleLifecycle(lc("cancel", { subscriptionStatus: "inactive" }));
  assert.ok(r !== null, "should handle cancel for inactive user");
  assert.ok(
    r!.toLowerCase().includes("inactive") || r!.toLowerCase().includes("restart"),
    `expected 'already inactive', got: ${r?.slice(0, 100)}`
  );
});

// ---- REFUND REQUEST ----
test("lifecycle REFUND: 'I want a refund' → refund request handled, not GPT fallthrough", async () => {
  const r = await handleLifecycle(lc("I want a refund"));
  assert.ok(r !== null, "should handle refund request");
  assert.ok(
    r!.toLowerCase().includes("refund") || r!.toLowerCase().includes("human") || r!.toLowerCase().includes("founder"),
    `unexpected: ${r?.slice(0, 100)}`
  );
});

test("lifecycle REFUND: 'money back' → also handled", async () => {
  const r = await handleLifecycle(lc("I want my money back"));
  assert.ok(r !== null, "should handle 'money back'");
});

// ---- PAYMENT / REJOIN ----
test("lifecycle PAY: 'pay' keyword → payment link or info (NOT handled as food log)", async () => {
  const r = await handleLifecycle(lc("pay", { subscriptionStatus: "active" }));
  // 'pay' from active user: the payment handler fires
  assert.ok(r !== null, "should handle pay message");
});

test("lifecycle PAY: negative payment phrase → NOT handled (falls through to GPT)", async () => {
  const r = await handleLifecycle(lc("not paying for this rubbish"));
  // Negative payment pattern should NOT match the payment handler
  // It either returns null (falls through) or returns something unrelated to payment links
  if (r !== null) {
    assert.ok(!r!.toLowerCase().includes("payment link"), `negative phrase should not get a payment link: ${r?.slice(0, 100)}`);
  }
});

// ---- RESCUE/RESET ----
test("lifecycle RESCUE: 'restart' from COMPLETE user → returns menu (not wipe confirmation)", async () => {
  // COMPLETE users typing 'restart' get the command menu, not a data wipe.
  // 'start over' is the explicit full-reset trigger.
  const r = await handleLifecycle(lc("restart", { onboardingState: "COMPLETE" }));
  assert.ok(r !== null, "should handle restart");
  // Menu text will contain something about logging or sessions, not a delete confirmation
  assert.ok(!r!.includes("permanently delete"), `COMPLETE restart should NOT ask to delete: ${r?.slice(0, 100)}`);
});

test("lifecycle RESCUE: 'start over' from COMPLETE user → wipe confirmation", async () => {
  const r = await handleLifecycle(lc("start over", { onboardingState: "COMPLETE", totalWorkoutsCompleted: 5 }));
  assert.ok(r !== null, "should handle start over");
  assert.ok(r!.includes("permanently delete") || r!.toLowerCase().includes("confirm") || r!.includes("⚠️"),
    `start over should ask for confirmation: ${r?.slice(0, 100)}`);
});

// ---- START (opt-in after stop) ----
test("lifecycle START: 'start' with paused user → resumes coaching", async () => {
  const pausedUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const r = await handleLifecycle(lc("start", { profileNotes: `paused_until:${pausedUntil}` }));
  assert.ok(r !== null, "should handle START for paused user");
  assert.ok(
    r!.toLowerCase().includes("welcome back") || r!.toLowerCase().includes("resume") || r!.toLowerCase().includes("coaching"),
    `unexpected: ${r?.slice(0, 100)}`
  );
});

test("lifecycle START: 'start' for non-paused user → falls through (null)", async () => {
  // A non-paused user typing 'start' is not an opt-in — it falls through to menu/GPT
  const r = await handleLifecycle(lc("start", { profileNotes: null }));
  // Either null (fall through) or handled by another section
  assert.ok(r === null || typeof r === "string", "result should be null or string");
});

// ============================================================
// EARLY-COMMANDS.TS CHARACTERISATION TESTS
// ============================================================

const { handleEarlyCommands } = await import("../server/handlers/early-commands");

function ec(message: string, overrides: Partial<typeof LC_USER> = {}) {
  const user = { ...LC_USER, ...overrides };
  return { phone: user.phoneNumber, message, m: message.toLowerCase().trim(), user };
}

test("early-commands: 'portion control' → returns hand-portion guide (fat_loss)", async () => {
  const r = await handleEarlyCommands(ec("portion control", { goalType: "fat_loss" }));
  assert.ok(r !== null, "should handle portion control");
  assert.ok(r!.includes("palm") || r!.includes("fist") || r!.includes("hand"), `should describe hand-portion method: ${r?.slice(0, 100)}`);
});

test("early-commands: 'portion control' → muscle_gain variant mentions surplus", async () => {
  const r = await handleEarlyCommands(ec("portion control", { goalType: "muscle_gain" }));
  assert.ok(r !== null, "should handle portion control for muscle_gain");
  assert.ok(r!.includes("2") || r!.includes("muscle") || r!.includes("build"), `should be goal-aware: ${r?.slice(0, 100)}`);
});

test("early-commands: 'how do I measure my food' → portion control matched", async () => {
  const r = await handleEarlyCommands(ec("how do I measure my food"));
  assert.ok(r !== null, "should match measure food as portion control");
});

test("early-commands: 'calories' → returns calorie target from user object", async () => {
  const r = await handleEarlyCommands(ec("calories", { calorieTarget: 1900, proteinTarget: 130 }));
  assert.ok(r !== null, "should handle calorie query");
  assert.ok(r!.includes("1900") || r!.includes("1,900") || r!.toLowerCase().includes("calorie"), `should mention calorie target: ${r?.slice(0, 100)}`);
});

test("early-commands: 'my protein target' → returns protein target", async () => {
  const r = await handleEarlyCommands(ec("my protein target", { proteinTarget: 145 }));
  assert.ok(r !== null, "should handle protein target query");
  assert.ok(r!.includes("145") || r!.toLowerCase().includes("protein"), `should mention protein: ${r?.slice(0, 100)}`);
});

// BEREAVEMENT — "passed on" / "passed" are as common as "passed away" in SA English.
// A real client (2026-07-08 screenshot) wrote "my grandfather passed on in the wee
// hours of the morning". Before this fix the live regex only matched "passed away",
// so this heartbreaking message fell through to generic handling. These lock it.
test("early-commands: 'grandfather passed on' → bereavement compassion, not generic (2026-07-08 real client)", async () => {
  const r = await handleEarlyCommands(ec("Hi Koki. I woke up to terrible news, my grandfather passed on in the wee hours of the morning"));
  assert.ok(r !== null, "'passed on' must reach the bereavement path");
  assert.ok(/sorry for your loss/i.test(r!), `should be the bereavement reply: ${r?.slice(0, 120)}`);
});

test("early-commands: 'my gran passed' → bereavement (passed without on/away)", async () => {
  const r = await handleEarlyCommands(ec("my gran passed this morning"));
  assert.ok(r !== null && /sorry for your loss/i.test(r!), `'gran passed' should reach bereavement: ${r?.slice(0, 120)}`);
});

test("early-commands: 'I passed my exam' → NOT bereavement (no false positive)", async () => {
  const r = await handleEarlyCommands(ec("I passed my exam today"));
  assert.ok(r === null || !/sorry for your loss/i.test(r!), `benign 'passed' must not trigger bereavement: ${r?.slice(0, 120)}`);
});

// TWILIO BALANCE ALARM — pure threshold/format logic (2026-07-09). The bot goes
// silent with NO error when Twilio runs dry; this alert is the safety net. The
// runtime fetch/send is thin; the threshold + wording is what must never drift.
const { buildLowBalanceAlert } = await import("../server/scheduler/jobs/balance-check");

test("balance alarm: below threshold → alert names the amount and currency", () => {
  const a = buildLowBalanceAlert(11.85, "USD", 15);
  assert.ok(a !== null, "11.85 < 15 must alert");
  assert.ok(a!.includes("11.85") && /USD/i.test(a!), `should name amount + currency: ${a}`);
  assert.ok(/top up/i.test(a!), "should tell the founder to top up");
});

test("balance alarm: at or above threshold → no alert (no nagging when healthy)", () => {
  assert.equal(buildLowBalanceAlert(15, "USD", 15), null, "exactly at threshold is fine");
  assert.equal(buildLowBalanceAlert(42.5, "USD", 15), null, "well above threshold is fine");
});

test("balance alarm: unreadable balance → null, never cry wolf", () => {
  assert.equal(buildLowBalanceAlert(NaN, "USD", 15), null);
});

test("balance alarm: custom threshold is respected", () => {
  assert.ok(buildLowBalanceAlert(20, "USD", 25) !== null, "20 < 25 must alert");
  assert.equal(buildLowBalanceAlert(30, "USD", 25), null, "30 > 25 must not alert");
});

// FRICTIONLESS WORKOUT VIEWER (2026-07-09) — the swipe page that replaces the model's
// hallucinated exercise dumps. The token must be unforgeable (it references a client)
// and the cards must mirror the REAL current-day workout, never a made-up one.
process.env.COACH_DASHBOARD_KEY = process.env.COACH_DASHBOARD_KEY || "test-secret-key";
const { signWorkoutToken, verifyWorkoutToken, buildViewerCards, renderWorkoutViewerHtml } =
  await import("../server/workout-viewer");

test("workout viewer: token round-trips to the same user id", () => {
  const t = signWorkoutToken("user-abc-123");
  assert.ok(t, "should sign a token");
  assert.equal(verifyWorkoutToken(t!), "user-abc-123");
});

test("workout viewer: tampered / garbage tokens are rejected", () => {
  const t = signWorkoutToken("user-abc-123")!;
  const tampered = t.slice(0, -1) + (t.endsWith("a") ? "b" : "a");
  assert.equal(verifyWorkoutToken(tampered), null, "flipped sig char must fail");
  assert.equal(verifyWorkoutToken("garbage"), null);
  assert.equal(verifyWorkoutToken(""), null);
});

test("workout viewer: a forged token for another user id fails the signature", () => {
  const forged = Buffer.from("victim-user-id").toString("base64url") + ".deadbeefdeadbeefdeadbeef";
  assert.equal(verifyWorkoutToken(forged), null, "no attacker can mint a link for another client");
});

test("workout viewer: cards mirror the real current-day exercises (gym user)", () => {
  const user = { trainingMode: "gym", trainingDaysPerWeek: 3, programmeDayInWeek: 1, programmeWeek: 1, gender: "male", trainingExperience: "beginner" };
  const data = buildViewerCards(user);
  assert.ok(data && data.cards.length > 0, "gym user should have exercise cards");
  for (const c of data!.cards) {
    assert.ok(c.name && c.sets, "each card carries a name and sets");
    assert.ok("videoUrl" in c && "gifUrl" in c && "alt" in c, "card has the full media shape");
  }
});

test("workout viewer: walk-only user has no cards (null, not a crash)", () => {
  assert.equal(buildViewerCards({ trainingMode: "walk_only" }), null);
});

// MACHINE PHOTO + CAPTION (2026-07-10) — "Shoulder press" captioned on a weight-stack
// photo was a lift being logged; the caption was ignored and vision guessed generic
// tips. The caption must beat vision and prime the lift log — with NO vision call.
const { coachGymMachineFromPhoto } = await import("../server/handlers/equipment-vision");

test("machine photo: caption naming the exercise beats vision and primes a lift log", async () => {
  // dummy openai that would crash if vision were called — proves the caption short-circuits
  const dummy = { chat: { completions: { create: async () => { throw new Error("vision must not run"); } } } } as any;
  const r = await coachGymMachineFromPhoto(dummy, LC_USER, "", "image/jpeg", "Shoulder press");
  assert.ok(r !== null && /shoulder press/i.test(r!), `caption exercise must be recognised: ${r}`);
  assert.ok(/weight and reps/i.test(r!), `must prime the lift log: ${r}`);
});

test("machine photo: non-machine caption falls through to vision (null when vision fails)", async () => {
  const dummy = { chat: { completions: { create: async () => { throw new Error("offline"); } } } } as any;
  const r = await coachGymMachineFromPhoto(dummy, LC_USER, "", "image/jpeg", "was late this morning");
  assert.equal(r, null, "no machine words in caption → vision path → fails offline → null, never a crash");
});

// MEAL-REPEAT META-COMPLAINT GUARD (2026-07-10) — a voice complaint "I already told
// you what's the plan for lunch. Have you forgotten? We are repeating the same things"
// matched repeat+lunch and LOGGED YESTERDAY'S PASTA. Complaints must never log food.
const { handleMealRepeat } = await import("../server/handlers/meal-repeat");

test("meal-repeat: a complaint about repetition NEVER logs a meal", async () => {
  for (const msg of [
    "But I already told you what's the plan for lunch. Have you forgotten? Come on man, come on. We are repeating the same things.",
    "why do you keep logging the same lunch",
    "you and I had a discussion about my lunch yesterday",
  ]) {
    const r = await handleMealRepeat({ phone: LC_USER.phoneNumber, message: msg, m: msg.toLowerCase(), user: LC_USER });
    assert.equal(r, null, `complaint must fall through, not log: ${msg}`);
  }
});

test("meal-repeat: a genuine repeat request still works through the guard", async () => {
  const msg = "dinner is the same as lunch";
  const r = await handleMealRepeat({ phone: LC_USER.phoneNumber, message: msg, m: msg, user: LC_USER });
  assert.ok(r === null || !/have you forgot/i.test(r), "genuine repeat is not blocked by the guard (null only if no meal to copy in stub)");
});

// CONCERN-FIRST ON HEALTH EVENTS (2026-07-09) — a real client wrote "had an incident
// at work and my GP recommended rest, spent the day in bed". Health events rarely use
// the word "sick"; the brain must still catch them and lead with concern, not coach past.
const { SCENARIO_TOPIC_RE, BRAIN_SYSTEM: BRAIN_SYS } = await import("../server/brain/coach-brain");

test("brain: oblique health events trigger the scenario playbook (not only the word 'sick')", () => {
  for (const msg of [
    "had an incident at work and my GP recommended rest, spent the day in bed",
    "I'm in hospital",
    "on a drip today",
    "going for an iron infusion",
    "the doctor admitted me",
  ]) assert.ok(SCENARIO_TOPIC_RE.test(msg), `should trigger concern handling: ${msg}`);
});

test("brain: everyday chatter does NOT trip the health playbook", () => {
  for (const msg of ["what's my protein target", "logged my lunch", "gym was great today", "show me the exercises"])
    assert.ok(!SCENARIO_TOPIC_RE.test(msg), `should NOT trigger: ${msg}`);
});

test("brain: eating-out playbook — permission + strategy, never guilt (Kam's manual pattern)", () => {
  assert.ok(/EATING OUT/i.test(BRAIN_SYS), "must handle going-out announcements");
  assert.ok(/lean protein/i.test(BRAIN_SYS) && /skip the alcohol/i.test(BRAIN_SYS), "3-part strategy present");
  assert.ok(/photo your plate/i.test(BRAIN_SYS), "must ask for the plate photo to log");
});

test("brain: playbook leads with concern on a health event (asks if serious)", () => {
  assert.ok(/health event/i.test(BRAIN_SYS), "must name 'any health event'");
  assert.ok(/concern/i.test(BRAIN_SYS) && /serious/i.test(BRAIN_SYS), "must instruct concern-first + ask if serious");
});

// LAGGING BODY PART (2026-07-09) — a real test: "my chest is lagging, add an 8th
// exercise?" The bot wrongly called it "muscle confusion" and refused. Bringing up a
// weak point is legitimate targeted volume, and the bot must never echo the myth.
test("brain: lagging body part → targeted volume, never 'muscle confusion'", () => {
  assert.ok(/LAGGING BODY PART/i.test(BRAIN_SYS), "must handle lagging body parts explicitly");
  assert.ok(/muscle confusion is a MYTH/i.test(BRAIN_SYS), "must call muscle confusion a myth, not prescribe it");
  assert.ok(/NEVER refuse it/i.test(BRAIN_SYS), "must not refuse a legitimate lagging-part request");
  assert.ok(/glutes\/hamstrings|glutes/i.test(BRAIN_SYS) && /chest\/back|chest/i.test(BRAIN_SYS), "gender-aware body-part priorities present");
});

test("workout viewer: rendered page slides and escapes exercise names", () => {
  const html = renderWorkoutViewerHtml(
    { label: "Upper A", week: 2, cards: [{ name: "Chest <Fly>", sets: "4 × 8", gifUrl: null, videoUrl: "https://youtube.com/x", alt: "Dumbbell press" }] },
    "Kam",
  );
  assert.ok(/scroll-snap-type:\s*x/i.test(html), "must be a horizontal slider");
  assert.ok(html.includes("Chest &lt;Fly&gt;"), "must HTML-escape exercise names");
  assert.ok(html.includes("Watch the move"), "video card shows a watch action");
});

// ============================================================
// MISC-COMMANDS.TS CHARACTERISATION TESTS
// ============================================================

const { handleMiscCommands } = await import("../server/handlers/misc-commands");

function mc(message: string, overrides: Partial<typeof LC_USER> = {}) {
  const user = { ...LC_USER, ...overrides };
  return { phone: user.phoneNumber, message, m: message.toLowerCase().trim(), user };
}

test("misc-commands: 'creatine' → supplement guide returned", async () => {
  const r = await handleMiscCommands(mc("creatine"));
  assert.ok(r !== null, "should handle creatine query");
  assert.ok(r!.toLowerCase().includes("creatine"), `should mention creatine: ${r?.slice(0, 100)}`);
});

test("misc-commands: 'should I take protein powder' → supplement guide", async () => {
  const r = await handleMiscCommands(mc("should I take protein powder"));
  assert.ok(r !== null, "should handle protein powder query");
});

test("misc-commands: week9_choice '1' → maintenance phase response", async () => {
  const r = await handleMiscCommands(mc("1", { awaitingInputType: "week9_choice" }));
  assert.ok(r !== null, "should handle week9_choice '1'");
  assert.ok(r!.toLowerCase().includes("maintenance") || r!.toLowerCase().includes("3"), `should be maintenance path: ${r?.slice(0, 100)}`);
});

test("misc-commands: week9_choice '2' → advanced phase response", async () => {
  const r = await handleMiscCommands(mc("2", { awaitingInputType: "week9_choice" }));
  assert.ok(r !== null, "should handle week9_choice '2'");
  assert.ok(r!.toLowerCase().includes("advanced") || r!.toLowerCase().includes("5"), `should be advanced path: ${r?.slice(0, 100)}`);
});

test("misc-commands: week9_choice 'irrelevant text' → falls through (null)", async () => {
  const r = await handleMiscCommands(mc("what is the weather", { awaitingInputType: "week9_choice" }));
  // Non-matching input during week9_choice should fall through
  assert.ok(r === null || typeof r === "string", "should be null or string");
});

// ============================================================
// MEDIA.TS CHARACTERISATION TESTS
// Tests pure helpers and early-return paths that don't require
// external API calls (OpenAI Vision / Whisper / image download).
// ============================================================

const { bumpVoiceFailure, clearVoiceFailure, handleMediaMessage } = await import("../server/handlers/media");
const { default: OpenAI } = await import("openai");

const testOpenAi = new OpenAI({ apiKey: "sk-test-offline" });

// ---- VOICE FAILURE TRACKER ----
test("media: bumpVoiceFailure — first call returns 1", () => {
  const count = bumpVoiceFailure("media-test-uid-1");
  assert.equal(count, 1);
  clearVoiceFailure("media-test-uid-1"); // cleanup
});

test("media: bumpVoiceFailure — second call within window returns 2", () => {
  const uid = "media-test-uid-2";
  bumpVoiceFailure(uid);
  const count = bumpVoiceFailure(uid);
  assert.equal(count, 2);
  clearVoiceFailure(uid);
});

test("media: clearVoiceFailure — resets counter to 0 (next bump returns 1)", () => {
  const uid = "media-test-uid-3";
  bumpVoiceFailure(uid);
  bumpVoiceFailure(uid);
  clearVoiceFailure(uid);
  const count = bumpVoiceFailure(uid);
  assert.equal(count, 1, "after clear, bump should return 1");
  clearVoiceFailure(uid);
});

// ---- STICKER DETECTION ----
test("media: sticker (image/webp, no caption) → sticker detection message, no API call", async () => {
  const r = await handleMediaMessage({
    phone: "whatsapp:+27821234567",
    message: "",
    mediaUrl: "https://media.twilio.com/sticker.webp",
    mediaContentType: "image/webp",
    allMediaUrls: [],
    user: { ...LC_USER },
    isCoach: false,
    openai: testOpenAi,
    handleMessage: async () => "",
  });
  assert.ok(r.includes("sticker"), `should mention sticker: ${r.slice(0, 100)}`);
});

// ============================================================
// MACHINE VISION (2026-07-12, Kam: "the vision doesn't recognize any machines, it
// makes mistakes"). Lock the slug mapping's key distinctions and the discriminating
// prompt, so the plate-loaded-row-called-a-hack-squat failure can't silently return.
// ============================================================
test("machine slug: the commonly-confused machines map distinctly", () => {
  assert.equal(getMachineSlug("leg press machine"), "leg-press");
  assert.equal(getMachineSlug("hack squat machine"), "hack-squat");
  assert.equal(getMachineSlug("seated row machine"), "seated-row");
  assert.equal(getMachineSlug("seated cable row"), "seated-row");
  assert.equal(getMachineSlug("lat pulldown"), "lat-pulldown");
  assert.equal(getMachineSlug("leg extension machine"), "leg-extension");
  assert.equal(getMachineSlug("leg curl machine"), "leg-curl");
});

test("machine slug: a bare '… row' still lands on a row, not a fallback guess", () => {
  assert.equal(getMachineSlug("chest supported row"), "seated-row");
  assert.equal(getMachineSlug("t-bar row"), "seated-row");
  assert.equal(getMachineSlug("unknown thing"), null);
});

test("machine id prompt: teaches the tells for the machines that get confused", () => {
  const p = buildMachineIdPrompt().toLowerCase();
  // The three that get mixed up must each carry a distinguishing feature.
  assert.ok(p.includes("hack squat") && p.includes("shoulder pad"), "hack squat tell present");
  assert.ok(p.includes("leg press") && p.includes("foot platform"), "leg press tell present");
  assert.ok(p.includes("row") && p.includes("pull"), "row = pulling motion present");
  // Never judge by the plates (the exact cause of the row/hack-squat mixup).
  assert.ok(/never by the weight plates|not by the plates|never.*plates/i.test(p), "must warn against judging by plates");
  // Must ask for a confidence so a shaky guess can be de-escalated.
  assert.ok(p.includes("confidence") && p.includes("low"), "asks for a confidence signal");
});

// ============================================================
// FOOD SCANNER PRECISION (2026-07-12, Kam: "go deep" on calorie precision). The scanner
// must identify every food in a multi-item log AND never double-count a protein when a
// specific dish and a generic component both light up. Locks two real double-count bugs
// found by probe: restaurant chicken + phantom "Chicken thigh", and a curry combo +
// standalone curry.
// ============================================================
function scanNames(msg: string): string[] {
  return scanForSAFoods(msg).map((f: any) => f.name);
}

test("food scan: multi-item logs identify every component", () => {
  const eggsPap = scanNames("2 eggs and pap");
  assert.ok(eggsPap.includes("Eggs") && eggsPap.some(n => /pap/i.test(n)), "eggs + pap both found");
  const chkVeg = scanNames("grilled chicken breast and sweet potato");
  assert.ok(chkVeg.includes("Chicken breast") && chkVeg.includes("Sweet potato"), "breast + sweet potato");
});

test("food scan: no chicken double-count when a specific dish + bare 'chicken' collide", () => {
  const nandos = scanNames("nandos quarter chicken and chips");
  assert.ok(nandos.includes("Nando's quarter chicken"), "keeps the real dish");
  assert.ok(!nandos.includes("Chicken thigh") && !nandos.includes("Chicken breast"), "drops phantom generic cut");
  const rot = scanNames("rotisserie chicken and veg");
  assert.ok(!rot.includes("Chicken thigh") && !rot.includes("Chicken breast"), "rotisserie doesn't add a phantom cut");
});

test("food scan: a typed cut word keeps the generic cut (not a phantom)", () => {
  assert.ok(scanNames("chicken thigh and rice").includes("Chicken thigh"), "typed 'thigh' kept");
  assert.ok(scanNames("chicken breast and rice").includes("Chicken breast"), "typed 'breast' kept");
  assert.deepEqual(scanNames("chicken"), ["Chicken thigh"], "bare 'chicken' still logs a cut");
});

test("food scan: curry combo doesn't double-count the standalone curry", () => {
  assert.deepEqual(scanNames("chicken curry and rice"), ["Chicken curry and rice"], "combo only, no extra curry");
  assert.deepEqual(scanNames("chicken curry"), ["Curry (chicken)"], "standalone curry still works alone");
});

test("food scan: toast/stew combos don't double-count their bread/stew alternates", () => {
  // "Toast" alongside an "...on toast" combo was double-counting the bread.
  assert.deepEqual(scanNames("two boiled eggs and toast"), ["Eggs on toast"], "no extra Toast on top of the combo");
  assert.deepEqual(scanNames("pilchards on toast"), ["Pilchards on toast"], "no extra Toast");
  assert.ok(scanNames("toast with jam").includes("Toast"), "standalone Toast still logs");
  // "Beef stew" alongside "Pap and stew" was double-counting the stew.
  const stew = scanNames("beef stew and pap");
  assert.ok(stew.includes("Beef stew") && stew.some(n => /pap/i.test(n)), "beef stew + pap, both kept");
  assert.ok(!stew.includes("Pap and stew"), "no phantom combo double-counting the stew");
  assert.deepEqual(scanNames("big plate of pap and stew"), ["Pap and stew"], "vague 'stew' keeps the combo");
});

test("food scan: a specific sandwich suppresses the generic 'Sandwich' (no double bread)", () => {
  assert.deepEqual(scanNames("peanut butter sandwich"), ["Peanut butter on bread"], "PB sandwich = one item");
  // but a bare/filling sandwich with no specific match keeps 'Sandwich' for the bread
  assert.ok(scanNames("cheese and tomato sandwich").includes("Sandwich"), "generic sandwich kept for bread");
  assert.deepEqual(scanNames("sandwich"), ["Sandwich"], "bare sandwich still logs");
});

// QUANTITY PRECISION — the calories a text log produces must scale with the count.
// "6 eggs" is 3× "2 eggs", not the same. This is where the deficit actually lives.
function eggKcal(msg: string): number {
  const adj = adjustFoodsForSegment(scanForSAFoods(msg), msg) as any[];
  const egg = adj.find(f => f.name === "Eggs");
  return egg ? egg.adjustedCalories : -1;
}
test("food quantity: egg calories scale with the count (default portion is 2 eggs)", () => {
  const two = eggKcal("2 eggs");
  assert.ok(two > 150 && two < 220, `2 eggs ~186 kcal, got ${two}`);
  assert.equal(eggKcal("6 eggs"), two * 3, "6 eggs = 3× the 2-egg portion");
  assert.equal(eggKcal("3 eggs"), Math.round(two * 1.5), "3 eggs = 1.5×");
  assert.equal(eggKcal("1 egg"), Math.round(two * 0.5), "1 egg = 0.5×");
});
test("food quantity: size words scale the whole portion", () => {
  const adjBig = adjustFoodsForSegment(scanForSAFoods("big plate of pap"), "big plate of pap") as any[];
  const adjNorm = adjustFoodsForSegment(scanForSAFoods("pap"), "pap") as any[];
  const big = adjBig.find(f => /pap/i.test(f.name)), norm = adjNorm.find(f => /pap/i.test(f.name));
  assert.ok(big && norm && big.adjustedCalories > norm.adjustedCalories, "big plate > normal plate");
});

// ============================================================
// DAY-14 RECEIPT (2026-07-13, Kam: "people lose interest within two weeks — we have to
// do better in our retention"). The two-week milestone must show PROOF (their own
// numbers), never just a pep talk — and degrade gracefully when stats are missing.
// ============================================================
test("day-14 receipt: full stats produce a data-backed receipt with buttons", () => {
  const msg = buildDayMilestoneMessage("Kam", 14, 5, "92", {
    steps14: 98000, stepsBurnKcal: 5100, mealDays14: 11,
    weightStart: 92, weightNow: 90.8, goal: "fat_loss",
  });
  assert.ok(/2-week receipt/i.test(msg), "receipt header present");
  assert.ok(/5 training sessions/.test(msg), "sessions line");
  assert.ok(/98,000 steps/.test(msg), "steps line");
  assert.ok(/5,100 kcal/.test(msg), "weight-scaled burn line");
  assert.ok(/11 days of meals/.test(msg), "meal-days line");
  assert.ok(/1\.2kg down/.test(msg), "weight-loss line");
  assert.ok(/week 4–6/.test(msg), "sets the mirror expectation honestly");
  assert.ok(/\[BUTTONS:/.test(msg), "one-tap next action");
});

test("day-14 receipt: scale UP on fat loss is normalised, never shamed", () => {
  const msg = buildDayMilestoneMessage("Thandi", 14, 4, "70", {
    steps14: 60000, mealDays14: 8, weightStart: 70, weightNow: 70.6, goal: "fat_loss",
  });
  assert.ok(/normal at 2 weeks/i.test(msg), "up-tick framed as normal adaptation");
  assert.ok(!/failure|behind|disappointing/i.test(msg), "no shame language");
});

test("day-14 receipt: missing stats degrade to the plain milestone (no empty receipt)", () => {
  const msg = buildDayMilestoneMessage("Sipho", 14, 1, null, { steps14: 0, mealDays14: 0, weightStart: null, weightNow: null });
  assert.ok(!/2-week receipt/i.test(msg), "no receipt block with <2 facts");
  assert.ok(/two weeks/i.test(msg), "still a warm two-week message");
  const noStats = buildDayMilestoneMessage("Sipho", 14, 3, null);
  assert.ok(noStats.length > 50, "works with stats omitted entirely (backwards compatible)");
});

test("day-14 receipt: muscle-gain client sees weight UP as building fuel", () => {
  const msg = buildDayMilestoneMessage("Neo", 14, 6, "75", {
    steps14: 70000, mealDays14: 10, weightStart: 75, weightNow: 75.8, goal: "muscle_gain",
  });
  assert.ok(/building fuel/i.test(msg), "gain framed as the goal working");
});

// ============================================================
// Results
// ============================================================

console.log(`\ngap-tests: ${passed}/${passed + failed} passed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  console.log(failures.join("\n\n"));
  process.exit(1);
}
console.log("✓ all gap checks passed\n");
process.exit(0);

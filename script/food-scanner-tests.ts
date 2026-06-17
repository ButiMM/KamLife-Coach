/**
 * Food scanner regression tests — exercises the REAL production scanForSAFoods
 * (not an inlined mirror) so it can never silently drift from foods.ts.
 *
 * scanForSAFoods is pure (no DB query) but its module imports ../db, which needs
 * DATABASE_URL just to construct the pool. We set a dummy URL and dynamic-import
 * after, so no real database is ever touched.
 *
 * Run: npx tsx script/food-scanner-tests.ts
 * Exits non-zero on any failure.
 */

import assert from "node:assert/strict";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";

const { scanForSAFoods } = await import("../server/handlers/food-scanner");
const { findFabricatedComposites } = await import("../server/utils");

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

const kcal = (msg: string) =>
  scanForSAFoods(msg).reduce((s, f) => s + (f.typicalPortionCalories || 0), 0);
const names = (msg: string) => scanForSAFoods(msg).map(f => f.name);

// ── Sugar-free / zero / diet drinks must log as ~0 kcal ─────────────────────
test("'zero sugar energy drink' logs as 0 kcal", () => {
  assert.equal(kcal("zero sugar energy drink"), 0);
});
test("'sugar free energy drink' logs as 0 kcal", () => {
  assert.equal(kcal("sugar free energy drink"), 0);
});
test("'red bull zero' logs as 0 kcal", () => {
  assert.equal(kcal("red bull zero"), 0);
});
test("'monster ultra' (zero-sugar) logs as 0 kcal", () => {
  assert.equal(kcal("monster ultra"), 0);
});
test("'coke zero' logs as 0 kcal", () => {
  assert.equal(kcal("coke zero"), 0);
});
test("'sugar free red bull' logs as 0 kcal", () => {
  assert.equal(kcal("sugar free red bull"), 0);
});
test("'diet coke' logs as 0 kcal", () => {
  assert.equal(kcal("diet coke"), 0);
});
// A bare "diet" elsewhere in the message must NOT zero out an unrelated drink —
// "my diet has been bad" is not "diet coke". Regression for a real mislogging bug.
test("'my diet has been bad, had a monster energy' keeps full-sugar calories", () => {
  assert.ok(kcal("my diet has been bad, had a monster energy today") >= 150, `expected >=150, got ${kcal("my diet has been bad, had a monster energy today")}`);
});
test("'trying to fix my diet, had a red bull' keeps full-sugar calories", () => {
  assert.ok(kcal("trying to fix my diet, had a red bull") >= 100, `expected >=100, got ${kcal("trying to fix my diet, had a red bull")}`);
});

// ── Full-sugar drinks (no modifier) must KEEP their calories ─────────────────
test("plain 'red bull' stays ~113 kcal", () => {
  assert.ok(kcal("red bull") >= 100, `expected >=100, got ${kcal("red bull")}`);
});
test("plain 'monster' stays full sugar", () => {
  assert.ok(kcal("monster") >= 200, `expected >=200, got ${kcal("monster")}`);
});

// ── Generic "energy drink" must not silently overwrite a stated/unrecognised brand ──
// Regression: "energy drink" used to be a bare alias on the Red Bull entry, so ANY
// message containing that generic phrase — regardless of the actual brand named —
// got silently logged as Red Bull's exact numbers. Now it has no deterministic match
// and falls through to the GPT fallback, which can reason about the actual text.
test("generic 'energy drink' (no brand) has no deterministic match", () => {
  assert.equal(scanForSAFoods("energy drink").length, 0);
});
test("unrecognised-brand 'nasty energy drink' does not get silently logged as Red Bull", () => {
  assert.ok(!names("nasty energy drink").includes("Red Bull"));
});
test("'monster energy' resolves to the correct Monster Energy drink entry, not Red Bull", () => {
  assert.ok(names("monster energy").includes("Monster Energy drink"), `got ${names("monster energy")}`);
  assert.ok(kcal("monster energy") >= 200, `expected >=200, got ${kcal("monster energy")}`);
});

// ── A sugar-free MILK coffee still has calories (only fizzy/energy go to 0) ──
test("'sugar free mocha' keeps milk calories (not zeroed)", () => {
  assert.ok(kcal("sugar free mocha") > 100, `expected >100, got ${kcal("sugar free mocha")}`);
});

// ── A meat word used as an ADJECTIVE must not log a phantom cut ──────────────
// Production failure (screenshot): "2 chicken viennas" logged Chicken thigh (39g
// protein) PLUS Viennas, and the "2" doubled the phantom to ~78g — nearly tripling
// the meal's real protein. "chicken" is only an adjective for "viennas" here.
test("'2 chicken viennas' logs Viennas only — no phantom Chicken thigh", () => {
  const n = names("2 chicken viennas");
  assert.ok(n.includes("Viennas"), `expected Viennas, got ${n}`);
  assert.ok(!n.includes("Chicken thigh"), `should NOT log Chicken thigh, got ${n}`);
});
test("the exact breakfast log does not fabricate Chicken thigh", () => {
  const n = names("3 slices of white bread, 2 scrambled eggs, 2 chicken viennas and cup of black coffee");
  assert.ok(!n.includes("Chicken thigh"), `should NOT log Chicken thigh, got ${n}`);
  assert.ok(n.includes("Viennas"), `expected Viennas, got ${n}`);
});
test("'chicken polony' does not also log Chicken thigh", () => {
  assert.ok(!names("chicken polony").includes("Chicken thigh"), `got ${names("chicken polony")}`);
});
// Must-not-break: a genuine standalone chicken log still resolves to a chicken food.
test("bare 'chicken' still logs Chicken thigh (standalone, not a modifier)", () => {
  assert.ok(names("i had chicken for lunch").includes("Chicken thigh"), `got ${names("i had chicken for lunch")}`);
});
test("'chicken and rice' still resolves to a chicken-containing meal", () => {
  const n = names("chicken and rice");
  assert.ok(n.some(x => /chicken/i.test(x)), `expected a chicken food, got ${n}`);
});
test("'chicken thigh and viennas' keeps BOTH (chicken stated standalone)", () => {
  const n = names("chicken thigh and viennas");
  assert.ok(n.includes("Chicken thigh"), `expected Chicken thigh, got ${n}`);
  assert.ok(n.includes("Viennas"), `expected Viennas, got ${n}`);
});

// ── SA McDonald's breakfast recognised (real menu item, not generic guess) ──
test("'mcdonalds breakfast' matches the SA Big Breakfast", () => {
  assert.ok(names("mcdonalds breakfast").includes("McDonald's Big Breakfast (SA)"));
});
test("'macdonalds' misspelling + reversed word order still matches breakfast", () => {
  assert.ok(names("SA Breakfast macdonalds").includes("McDonald's Big Breakfast (SA)"));
});
test("'egg mcmuffin' matches the McMuffin (not a burger)", () => {
  assert.ok(names("egg mcmuffin").includes("McDonald's Egg McMuffin"));
});

// ── Anti-fabrication guard — GPT must not invent a composite from a listed meal ──
// Guards the exact production failure where "rice / chicken livers / veggies" became
// a phantom "rice and chicken", double-counting protein.
const fab = (msg: string, ns: string[]) => findFabricatedComposites(msg, ns.map(n => ({ name: n })));

test("invented 'rice and chicken' from a newline-listed meal is flagged", () => {
  assert.deepEqual(
    fab("Dinner\nRice\nChicken livers\nMixed veggies",
      ["Chicken livers", "Mixed frozen vegetables", "Rice and chicken (home cooked)"]),
    ["Rice and chicken (home cooked)"],
  );
});
test("invented composite from a comma-listed meal is flagged", () => {
  assert.deepEqual(fab("rice, chicken livers, veggies", ["Rice and chicken", "Chicken livers"]), ["Rice and chicken"]);
});
test("composite the client typed verbatim in a list is NOT flagged", () => {
  assert.deepEqual(fab("Lunch\nrice and chicken\nsalad", ["Rice and chicken", "Salad"]), []);
});
test("composite in a flowing sentence (not a list) is never touched", () => {
  assert.deepEqual(fab("I had a plate of rice with grilled chicken", ["Rice with chicken"]), []);
});
test("clean listed meal with separate items is not flagged", () => {
  assert.deepEqual(fab("Breakfast\neggs\ntoast\nbanana", ["Eggs", "Toast", "Banana"]), []);
});
test("'mac n cheese' listed, model returns 'mac and cheese' — kept as faithful", () => {
  assert.deepEqual(fab("supper\nmac n cheese\ncoke zero", ["Mac and cheese", "Coke Zero"]), []);
});
test("single hyphenated dish (no and/with joiner) is not flagged", () => {
  assert.deepEqual(fab("lunch\nchicken stir-fry\ncoke", ["Chicken stir-fry", "Coke"]), []);
});

// ── No double / contradictory "protein target hit" in one reply ──────────────
// buildFoodLogReply assembles a coach note AND a protein tip; both could once
// independently declare "Protein target hit ✅" in the same message (and the
// 10–20g branch could say "push for 20g+" right next to a "target hit"). Run
// each scenario many times because the wording is randomly picked.
const { buildFoodLogReply } = await import("../server/handlers/food-scanner");
// One regex per distinct protein-verdict sentence the reply can emit — each is
// written to match its sentence exactly once, so the count is the number of
// separate protein verdicts. A correct reply gives EXACTLY ONE. Two means the
// old double-"target hit" bug; a "20g+" alongside a "hit" is the contradiction.
const VERDICT_RE = /protein target hit|daily protein done|protein goal complete|protein sorted for the day|protein and calories both on target|full day nailed|protein done, calories locked|\d+g protein still needed|\d+g (?:more to go|left to hit)|\d+g short on protein|20g\+/gi;
const protHitCount = (reply: string) => (reply.match(VERDICT_RE) || []).length;
const logReply = (over: Record<string, any>) => buildFoodLogReply({
  foodLines: "• Chicken breast: ~300 kcal, 35g protein (1 portion)",
  mealLabel: "Meal total",
  totalMealCals: 600,
  totalMealProtein: 35,
  runningCals: 1500,
  runningProtein: 150,   // already past the 120g target
  calorieTarget: 1800,
  proteinTarget: 120,
  prevCals: 900,
  hasGoodProteins: true,
  hasCarbs: false,
  user: { name: "Test", goalType: "fat_loss", stepsTarget: 8500 }, // no id → no edu note
  todaySteps: 0,
  ...over,
});

test("a ≥20g meal that crosses the protein target declares 'target hit' exactly once", () => {
  for (let i = 0; i < 80; i++) {
    const r = logReply({});
    assert.equal(protHitCount(r), 1, `expected exactly one 'target hit', got ${protHitCount(r)}:\n${r}`);
  }
});
test("a 10–20g meal with target already hit never says 'push for 20g+' next to 'target hit'", () => {
  for (let i = 0; i < 80; i++) {
    const r = logReply({ totalMealProtein: 15 });
    assert.equal(protHitCount(r), 1, `expected exactly one 'target hit', got ${protHitCount(r)}:\n${r}`);
    assert.ok(!/20g\+/.test(r), `self-contradicting 'push for 20g+' present:\n${r}`);
  }
});

// ── Portion default-count divisor — gram-led descriptions are 1 serving ──────
// Guards the "2 chicken livers" → ~3 kcal bug: a "150g portion" must NOT be read
// as a count of 150, or stating a quantity divides the calories into nothing.
const { portionDefaultCount } = await import("../server/handlers/food-scanner");

test("a gram-led portion ('150g portion') counts as 1 serving, not 150", () => {
  assert.equal(portionDefaultCount("150g portion"), 1);
});
test("ml/kg/oz-led portions also count as 1 serving", () => {
  assert.equal(portionDefaultCount("500ml glass"), 1);
  assert.equal(portionDefaultCount("1kg portion"), 1);
});
test("a count-led portion ('2 large eggs') keeps its count", () => {
  assert.equal(portionDefaultCount("2 large eggs"), 2);
  assert.equal(portionDefaultCount("3 slices (90g)"), 3);
});
test("count-then-weight ('1 quarter kota (350g)') uses the count, not the grams", () => {
  assert.equal(portionDefaultCount("1 quarter kota (350g)"), 1);
});
test("fractional and text-led portions are handled", () => {
  assert.equal(portionDefaultCount("1.5 cups (cooked)"), 1.5);
  assert.equal(portionDefaultCount("Medium plate (~200g)"), 1);
  assert.equal(portionDefaultCount(""), 1);
});
test("real foods.ts: '2 chicken livers' scales up, never collapses to ~0", async () => {
  // The chicken-livers portion is gram-led ("150g portion"); two of them must be
  // ~2x a portion, not 2/150 of one. Compute the same way the handler does.
  const livers = scanForSAFoods("chicken livers")[0];
  assert.ok(livers, "chicken livers should be in the SA DB");
  const defaultQty = portionDefaultCount(livers.typicalPortionDescription);
  const quantity = 2 / defaultQty; // user said "2"
  const scaledKcal = Math.round((livers.typicalPortionCalories || 0) * quantity);
  assert.ok(scaledKcal > 100, `expected a real calorie count for 2 livers, got ${scaledKcal}`);
});

if (failed > 0) {
  console.error(`\nfood-scanner-tests: ${passed} passed, ${failed} FAILED\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`\nfood-scanner-tests: ${passed}/${passed} passed`);
console.log("✓ all food scanner checks passed");

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

// ── Full-sugar drinks (no modifier) must KEEP their calories ─────────────────
test("plain 'red bull' stays ~113 kcal", () => {
  assert.ok(kcal("red bull") >= 100, `expected >=100, got ${kcal("red bull")}`);
});
test("plain 'energy drink' stays ~113 kcal", () => {
  assert.ok(kcal("energy drink") >= 100, `expected >=100, got ${kcal("energy drink")}`);
});
test("plain 'monster' stays full sugar", () => {
  assert.ok(kcal("monster") >= 200, `expected >=200, got ${kcal("monster")}`);
});

// ── A sugar-free MILK coffee still has calories (only fizzy/energy go to 0) ──
test("'sugar free mocha' keeps milk calories (not zeroed)", () => {
  assert.ok(kcal("sugar free mocha") > 100, `expected >100, got ${kcal("sugar free mocha")}`);
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

if (failed > 0) {
  console.error(`\nfood-scanner-tests: ${passed} passed, ${failed} FAILED\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`\nfood-scanner-tests: ${passed}/${passed} passed`);
console.log("✓ all food scanner checks passed");

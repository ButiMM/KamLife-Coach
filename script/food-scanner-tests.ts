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

if (failed > 0) {
  console.error(`\nfood-scanner-tests: ${passed} passed, ${failed} FAILED\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`\nfood-scanner-tests: ${passed}/${passed} passed`);
console.log("✓ all food scanner checks passed");

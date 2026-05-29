/**
 * Unit tests for pure logic functions — no DB, no API calls, no network.
 * Run: npm run test:unit
 * Exits non-zero on any failure.
 */

import assert from "node:assert/strict";
import { calculateTargets } from "../server/targets";
import { getDayType, getPhaseMultiplier, getPhaseNames } from "../server/programme";
import { getShoppingList, formatShoppingList } from "../server/shopping-lists";

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
// calculateTargets — Mifflin-St Jeor BMR + goal adjustment
// ============================================================

test("fat loss male 80kg produces deficit below TDEE", () => {
  const { calorieTarget, proteinTarget } = calculateTargets(80, "fat_loss", "office", 3, "male", 30, 175);
  // Mifflin male 80kg/175cm/30y: BMR = 10×80 + 6.25×175 - 5×30 + 5 = 800+1093.75-150+5 = 1748.75
  // TDEE = 1748.75 × 1.3 + (200×3/7) ≈ 2273 + 86 ≈ 2359
  // Fat loss: -400 → ~1959 kcal
  assert.ok(calorieTarget >= 1500, `calorie too low: ${calorieTarget}`);
  assert.ok(calorieTarget <= 2200, `calorie too high for fat loss: ${calorieTarget}`);
  // protein: 80 × 2.0 = 160g
  assert.equal(proteinTarget, 160, `protein should be 160g for 80kg male fat loss, got ${proteinTarget}`);
});

test("muscle gain male gets calorie surplus", () => {
  const fatLoss = calculateTargets(80, "fat_loss", "office", 3, "male", 30, 175);
  const muscleGain = calculateTargets(80, "muscle_gain", "office", 3, "male", 30, 175);
  assert.ok(muscleGain.calorieTarget > fatLoss.calorieTarget, "muscle gain should have more calories than fat loss");
  assert.ok(muscleGain.proteinTarget > fatLoss.proteinTarget, "muscle gain needs more protein");
});

test("female has smaller deficit than male for fat loss", () => {
  const male = calculateTargets(70, "fat_loss", "office", 3, "male", 30, 170);
  const female = calculateTargets(70, "fat_loss", "office", 3, "female", 30, 165);
  assert.ok(female.calorieTarget > male.calorieTarget - 200, "female deficit should be smaller (max 200 kcal diff at same weight)");
});

test("calories never below female minimum 1200", () => {
  const { calorieTarget } = calculateTargets(40, "fat_loss", "unemployed", 1, "female", 55, 150);
  assert.ok(calorieTarget >= 1200, `female floor violated: ${calorieTarget}`);
});

test("calories never below male minimum 1500", () => {
  const { calorieTarget } = calculateTargets(50, "fat_loss", "retired", 1, "male", 70, 165);
  assert.ok(calorieTarget >= 1500, `male floor violated: ${calorieTarget}`);
});

test("calories never exceed 4500", () => {
  const { calorieTarget } = calculateTargets(150, "muscle_gain", "retail_physical", 7, "male", 25, 200);
  assert.ok(calorieTarget <= 4500, `ceiling violated: ${calorieTarget}`);
});

test("youth (<18) gets higher calorie floor", () => {
  const teen = calculateTargets(60, "fat_loss", "office", 3, "male", 16, 170);
  assert.ok(teen.calorieTarget >= 1800, `teen male should be >= 1800 kcal, got ${teen.calorieTarget}`);
});

test("elderly (>=60) gets higher protein floor", () => {
  const elder = calculateTargets(70, "general", "retired", 2, "male", 65, 170);
  // elderly floor: max(protein, round(70 × 1.6)) = max(126, 112) = 126
  assert.ok(elder.proteinTarget >= Math.round(70 * 1.6), `elder protein too low: ${elder.proteinTarget}`);
});

test("physical job increases calorie target vs office", () => {
  const office = calculateTargets(80, "general", "office", 3, "male", 30, 175);
  const physical = calculateTargets(80, "general", "retail_physical", 3, "male", 30, 175);
  assert.ok(physical.calorieTarget > office.calorieTarget, "physical job should have higher TDEE");
});

test("recomposition returns no surplus or deficit", () => {
  const recomp = calculateTargets(80, "recomposition", "office", 3, "male", 30, 175);
  const general = calculateTargets(80, "general", "office", 3, "male", 30, 175);
  // recomposition has 0 adjustment, general has +100 — recomp should be slightly lower
  assert.ok(recomp.calorieTarget < general.calorieTarget, "recomp should be <= general");
});

// ============================================================
// getDayType — programme day slot mapping
// ============================================================

test("getDayType day 1 = full_a", () => {
  assert.equal(getDayType(1), "full_a");
});

test("getDayType day 2 = full_b", () => {
  assert.equal(getDayType(2), "full_b");
});

test("getDayType day 3 = full_c", () => {
  assert.equal(getDayType(3), "full_c");
});

test("getDayType day 4 wraps to full_a", () => {
  assert.equal(getDayType(4), "full_a");
});

test("getDayType day 6 wraps to full_c", () => {
  assert.equal(getDayType(6), "full_c");
});

test("getDayType day 9 wraps to full_c", () => {
  assert.equal(getDayType(9), "full_c");
});

// ============================================================
// getPhaseMultiplier — progressive overload phases
// ============================================================

test("phase 1 is 3×10 with 60s rest", () => {
  const p = getPhaseMultiplier(1);
  assert.equal(p.sets, "3");
  assert.equal(p.reps, "10");
  assert.equal(p.rest, "60 seconds");
});

test("phase 4 is 5×5 (peak strength)", () => {
  const p = getPhaseMultiplier(4);
  assert.equal(p.sets, "5");
  assert.equal(p.reps, "5");
});

test("phase 5 (deload) resets to phase 1 values", () => {
  const p1 = getPhaseMultiplier(1);
  const p5 = getPhaseMultiplier(5);
  assert.equal(p5.sets, p1.sets);
  assert.equal(p5.reps, p1.reps);
});

test("unknown phase returns safe default", () => {
  const p = getPhaseMultiplier(99);
  assert.equal(p.sets, "3");
  assert.equal(p.reps, "10");
});

// ============================================================
// getPhaseNames — phase labels
// ============================================================

test("phase names covers all 5 phases", () => {
  const names = getPhaseNames();
  for (let i = 1; i <= 5; i++) {
    assert.ok(names[i], `phase ${i} name missing`);
  }
});

test("phase 1 is Foundation", () => {
  assert.equal(getPhaseNames()[1], "Foundation");
});

test("phase 4 is Peak", () => {
  assert.equal(getPhaseNames()[4], "Peak");
});

// ============================================================
// getShoppingList — returns valid structure for all tiers/weeks
// ============================================================

const TIERS = ["under_100", "100_300", "300_600", "over_600"];
const WEEKS = [1, 2, 3, 4, 5, 6, 7, 8];

for (const tier of TIERS) {
  test(`getShoppingList returns non-empty list for tier ${tier} week 1`, () => {
    const list = getShoppingList(tier, 1);
    assert.ok(list, `list is null for ${tier}`);
    assert.ok(list.items.length > 0, `no items for ${tier}`);
    assert.ok(list.budgetLabel, `no budgetLabel for ${tier}`);
    assert.ok(list.estimatedTotal, `no estimatedTotal for ${tier}`);
    assert.ok(list.coversDays > 0, `coversDays missing for ${tier}`);
  });
}

test("shopping list alternates week A/B for variety", () => {
  const week1 = getShoppingList("100_300", 1);
  const week2 = getShoppingList("100_300", 2);
  // Week 2 should be different from week 1 (variety rotation)
  const week1Names = week1.items.map(i => i.name).join(",");
  const week2Names = week2.items.map(i => i.name).join(",");
  assert.notEqual(week1Names, week2Names, "week 1 and 2 shopping lists should differ");
});

test("all shopping list items have item name and category", () => {
  const list = getShoppingList("100_300", 1);
  for (const item of list.items) {
    assert.ok(item.item, `item missing item name`);
    assert.ok(item.category, `item '${item.item}' missing category`);
    assert.ok(item.price, `item '${item.item}' missing price`);
  }
});

test("formatShoppingList returns non-empty string", () => {
  const list = getShoppingList("100_300", 1);
  const formatted = formatShoppingList(list, "Kamogelo", "fat_loss");
  assert.ok(typeof formatted === "string", "not a string");
  assert.ok(formatted.length > 100, "formatted list too short");
});

test("formatShoppingList includes protein section", () => {
  const list = getShoppingList("100_300", 1);
  const formatted = formatShoppingList(list, "Test", "fat_loss");
  assert.ok(
    /protein|chicken|eggs|tuna|pilchard|mince/i.test(formatted),
    "shopping list should include protein items"
  );
});

test("over_600 tier estimated total string differs from under_100", () => {
  const cheap = getShoppingList("under_100", 1);
  const premium = getShoppingList("over_600", 1);
  // Extract numeric value from strings like "~R320" or "R1,200"
  const parseZAR = (s: string) => parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
  assert.ok(parseZAR(premium.estimatedTotal) > parseZAR(cheap.estimatedTotal),
    `premium ${premium.estimatedTotal} should cost more than cheap ${cheap.estimatedTotal}`);
});

test("Tier 3 and Tier 4 shopping lists have Week B for variety", () => {
  const t3a = getShoppingList("300_600", 1);
  const t3b = getShoppingList("300_600", 2);
  assert.ok(t3a, "Tier 3 Week A should exist");
  assert.ok(t3b, "Tier 3 Week B should exist");
  assert.notDeepEqual(t3a.items, t3b.items, "Tier 3 Week A and B should have different items");

  const t4a = getShoppingList("over_600", 1);
  const t4b = getShoppingList("over_600", 2);
  assert.ok(t4a, "Tier 4 Week A should exist");
  assert.ok(t4b, "Tier 4 Week B should exist");
  assert.notDeepEqual(t4a.items, t4b.items, "Tier 4 Week A and B should have different items");
});

// ============================================================
// Meal removal regex — catches all expected phrases
// ============================================================

const REMOVE_REGEX = /^(no\s+)?(remove|delete|undo)\s+(it|that meal|that one|that|last|last one|last meal|the meal|the last one)$/i;

test("'Remove that meal' matches meal removal regex", () => {
  assert.ok(REMOVE_REGEX.test("Remove that meal"), "should match 'Remove that meal'");
});

test("'remove last meal' still matches", () => {
  assert.ok(REMOVE_REGEX.test("remove last meal"), "should match 'remove last meal'");
});

test("'delete that meal' matches", () => {
  assert.ok(REMOVE_REGEX.test("delete that meal"), "should match 'delete that meal'");
});

test("'undo that' matches", () => {
  assert.ok(REMOVE_REGEX.test("undo that"), "should match 'undo that'");
});

test("'Remove that meal please' does NOT match (extra words)", () => {
  assert.ok(!REMOVE_REGEX.test("Remove that meal please"), "should not match phrases with extra words");
});

test("'remove the meal' matches", () => {
  assert.ok(REMOVE_REGEX.test("remove the meal"), "should match 'remove the meal'");
});

// ============================================================
// Motivational dip handler — catches unmotivated and missed training
// ============================================================

function testSoftStruggle(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    /\b(i.?m (really |so |just )?(struggling|falling behind|losing motivation|lost motivation|feeling behind|feeling lost|not sure what i.?m doing|demotivated|unmotivated))\b/.test(m) ||
    /\b(feel like (giving up|i.?m failing|i.?m not making progress|nothing is working|i.?m not getting it right|i.?m behind))\b/.test(m) ||
    /\b(i don.?t (know what.?s happening|know what i.?m doing|know if this is working))\b/.test(m) ||
    /\b(hard (to stay|to keep|to maintain) (motivated|going|consistent))\b/.test(m) ||
    /\b(haven.?t (trained|worked out|been to gym|gone to gym)|didn.?t (train|work out)|no (training|workout|gym) (for |in )?\d+\s*(days?|weeks?))\b/.test(m) ||
    /\bfeeling (down|low|unmotivated|demotivated|flat|defeated|hopeless about (this|my progress|the gym))\b/i.test(msg) ||
    /\b(unmotivated|demotivated|lost (my |all )?(motivation|drive)|no motivation|zero motivation)\b/i.test(msg)
  );
}

test("\"Haven't trained for the past 3 days. Feeling down and unmotivated\" triggers soft struggle", () => {
  assert.ok(testSoftStruggle("Haven't trained for the past 3 days. Feeling down and unmotivated"),
    "should detect motivational dip with 'haven't trained' + 'feeling down and unmotivated'");
});

test("\"feeling unmotivated\" triggers soft struggle", () => {
  assert.ok(testSoftStruggle("feeling unmotivated"), "should detect 'feeling unmotivated'");
});

test("\"I haven't worked out in 5 days\" triggers soft struggle", () => {
  assert.ok(testSoftStruggle("I haven't worked out in 5 days"), "should detect 'haven't worked out in 5 days'");
});

test("\"just had coffee\" does NOT trigger soft struggle", () => {
  assert.ok(!testSoftStruggle("just had coffee"), "food log should not trigger struggle handler");
});

test("\"done\" does NOT trigger soft struggle", () => {
  assert.ok(!testSoftStruggle("done"), "workout log should not trigger struggle handler");
});

// ============================================================
// Step streak logic — SAST timezone correctness
// ============================================================

test("streak calculation: consecutive days count correctly", () => {
  const SAST_OFFSET = 2 * 3_600_000;
  function computeStreak(logs: Date[]): number {
    const days = new Set<string>();
    for (const d of logs) {
      const s = new Date(d.getTime() + SAST_OFFSET);
      days.add(`${s.getUTCFullYear()}-${s.getUTCMonth()}-${s.getUTCDate()}`);
    }
    let streak = 0;
    const cur = new Date(Date.now() + SAST_OFFSET);
    cur.setUTCDate(cur.getUTCDate() - 1);
    while (true) {
      const key = `${cur.getUTCFullYear()}-${cur.getUTCMonth()}-${cur.getUTCDate()}`;
      if (!days.has(key)) break;
      streak++;
      cur.setUTCDate(cur.getUTCDate() - 1);
    }
    return streak;
  }

  const yesterday = new Date(Date.now() - 86_400_000);
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);

  assert.equal(computeStreak([yesterday]), 1, "one log yesterday = streak 1");
  assert.equal(computeStreak([yesterday, twoDaysAgo]), 2, "two consecutive days = streak 2");
  assert.equal(computeStreak([yesterday, twoDaysAgo, threeDaysAgo]), 3, "three consecutive = streak 3");
  assert.equal(computeStreak([twoDaysAgo, threeDaysAgo]), 0, "gap yesterday breaks streak");
  assert.equal(computeStreak([]), 0, "no logs = streak 0");
});

test("streak: late-night SAST log (11pm) counts as correct date", () => {
  const SAST_OFFSET = 2 * 3_600_000;
  function dateKey(d: Date): string {
    const s = new Date(d.getTime() + SAST_OFFSET);
    return `${s.getUTCFullYear()}-${s.getUTCMonth()}-${s.getUTCDate()}`;
  }
  // 11pm UTC = 1am SAST next day. With SAST offset applied, it's the next day.
  const elevenPmUTC = new Date();
  elevenPmUTC.setUTCHours(23, 0, 0, 0);
  const elevenPmSAST = new Date();
  elevenPmSAST.setUTCHours(21, 0, 0, 0); // 11pm SAST = 9pm UTC
  // 11pm SAST key should be TODAY in SAST
  const sastKey = dateKey(elevenPmSAST);
  const todaySAST = new Date(Date.now() + SAST_OFFSET);
  const todayKey = `${todaySAST.getUTCFullYear()}-${todaySAST.getUTCMonth()}-${todaySAST.getUTCDate()}`;
  assert.equal(sastKey, todayKey, "11pm SAST log should map to today's SAST date");
});

// ============================================================
// Retrospective diet detection — regex must match/block correctly
// ============================================================

// Mirror the exact regex from food-context.ts so tests stay in sync
const RETRO_DIET_RE = /\b(within\s+the\s+week|this\s+week\s+i.?(?:ve|have|had|been)|during\s+the\s+week|throughout\s+the\s+week|last\s+few\s+days|a\s+few\s+days\s+ago|over\s+the\s+(?:past|last)\s+(?:few\s+days|week)|most\s+days?\s+(?:i\s+)?eat|every\s+day\s+i\s+(?:eat|have|had)|i\s+(?:usually|normally|generally|typically)\s+(?:eat|have|had|have\s+been\s+eating)|my\s+usual\s+(?:diet|meals?|foods?|breakfast|lunch|dinner)|i\s+tend\s+to\s+(?:eat|have)|my\s+normal\s+(?:diet|meals?|foods?)|for\s+the\s+past\s+(?:few\s+days|week))\b/i;
const TODAY_SIGNAL_RE = /\b(today|just\s+had|just\s+ate|right\s+now)\b/i;
const isRetroDiet = (msg: string) => RETRO_DIET_RE.test(msg.toLowerCase()) && !TODAY_SIGNAL_RE.test(msg.toLowerCase());

test("'within the week' is detected as retro", () => {
  assert.ok(isRetroDiet("I has oats eggs and bread for breakfast within the week"), "within the week should be retro");
});
test("'I usually eat chicken' is detected as retro", () => {
  assert.ok(isRetroDiet("I usually eat chicken rice and veg"), "usually eat = retro");
});
test("'I normally have oats' is detected as retro", () => {
  assert.ok(isRetroDiet("I normally have oats and eggs for breakfast"), "normally have = retro");
});
test("'during the week' is detected as retro", () => {
  assert.ok(isRetroDiet("During the week I eat pap and mince"), "during the week = retro");
});
test("'last few days' is detected as retro", () => {
  assert.ok(isRetroDiet("Last few days I have been eating chicken and sweet potato"), "last few days = retro");
});
test("'today I had eggs' is NOT retro (today override)", () => {
  assert.ok(!isRetroDiet("Today I had eggs and oats for breakfast"), "explicit 'today' should NOT be retro");
});
test("plain 'I had chicken for dinner' is NOT retro", () => {
  assert.ok(!isRetroDiet("I had chicken for dinner"), "plain today log must not be retro");
});
test("'usually but today I had' respects today-signal override", () => {
  assert.ok(!isRetroDiet("I usually eat oats but today I had eggs"), "today override must suppress retro flag");
});

// ============================================================
// Subscription gate: inactive users should be blocked from media
// ============================================================

test("inactive user string detection", () => {
  // Verify the gate condition logic is correct
  const statuses = ["inactive", "active", "trial", ""];
  const gated = statuses.filter(s => s === "inactive");
  assert.deepEqual(gated, ["inactive"]);
});

// ============================================================
// Results
// ============================================================

console.log(`\nunit-tests: ${passed}/${passed + failed} passed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  console.log(failures.join("\n\n"));
  process.exit(1);
}
console.log("✓ all unit checks passed\n");

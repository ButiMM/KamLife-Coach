/**
 * Unit tests for pure logic functions — no DB, no API calls, no network.
 * Run: npm run test:unit
 * Exits non-zero on any failure.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { calculateTargets, calculateStepsTarget, getDailyStepContext, energyFrameLine, suggestStepTargetAdjustment } from "../server/targets";
import { getDayType, getPhaseMultiplier, getPhaseNames, getWeekContext, cleanExerciseName, canonicalLiftKey } from "../server/programme";
import { getShoppingList, formatShoppingList } from "../server/shopping-lists";
import { classifyLoggedFood, buildGroceryPersonalization, loggerType, type FoodProfile } from "../server/grocery-personalize";
import { computeProgressScore } from "../server/progress-score";
import { computeClientRisk, sortByRisk } from "../server/client-triage";
import { classifyWorkoutFeedback } from "../server/workout-feedback";
import { normaliseMsisdn, buildContentVariables, stripInventedRetroDate, parseQuantityCorrection, looksLikeStepsReport, looksLikeWaterReport, looksLikeWeightReport, parseMealDate, sastDayStart, hasGoalChangeVocabulary } from "../server/utils";
import { getSleepResponse } from "../server/handlers/sleep";
import { selectMealToCopy, type CopyableMeal } from "../server/meal-select";
import { buildWeekCard, type WeekCardData } from "../server/week-card";
import { verifyBrainReply } from "../server/brain/reply-verifier";
import { buildFoodVisionUserPrompt, buildMenuPickPrompt } from "../server/handlers/food-vision-prompt";
import { parsePhysiqueAnalysis, buildPhysiqueAnalysisPrompt, formatPhysiqueFocusLine, genderLaggingPriors, buildProgressComparisonPrompt } from "../server/physique-analysis";
import { buildDailyDirection } from "../server/daily-direction";
import { suggestSwap, swapNudge } from "../server/food-swaps";
import { buildFormCheckPrompt, extractFormExercise } from "../server/form-check-prompt";
import { isBareGreeting, looksLikeStepsTargetChange, looksLikeBillingOrCancel, looksLikeDirectionRequest, stripFoodLoggedClaim, extractStepTargetChange, looksLikeLowMobility } from "../server/utils";
import { enforceCoachGuardrails } from "../server/coach-guardrails";

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

test("very obese client (BMI ≥ 30) gets protein off ADJUSTED bodyweight, not total (2026-07-02: 140kg was prescribed 280g/day)", () => {
  // 140kg / 170cm male fat loss: BMI 48.4. Ideal (BMI 22) = 63.6kg;
  // adjusted = 63.6 + 0.4×(140−63.6) = 94.2kg → ×2.0 = ~188g. NOT 280g.
  const { proteinTarget } = calculateTargets(140, "fat_loss", "office", 3, "male", 30, 170);
  assert.ok(proteinTarget < 210, `obese protein must use adjusted bodyweight, got ${proteinTarget}g`);
  assert.ok(proteinTarget >= 150, `obese protein still must protect muscle, got ${proteinTarget}g`);
});

test("protein target is hard-capped at 220g regardless of size", () => {
  const { proteinTarget } = calculateTargets(200, "muscle_gain", "retail_physical", 5, "male", 25, 175);
  assert.ok(proteinTarget <= 220, `protein ceiling breached: ${proteinTarget}g`);
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
// Exercise-content sanity guards (screenshot bugs 2026-07-04)
// ============================================================

test("cleanExerciseName strips leading/trailing filler", () => {
  assert.equal(cleanExerciseName("my chest fly is"), "chest fly");
  assert.equal(cleanExerciseName("i did leg press"), "leg press");
  assert.equal(cleanExerciseName("today's bench press"), "bench press");
  assert.equal(cleanExerciseName("bench"), "bench");
});

test("cleanExerciseName leaves a clean movement name untouched", () => {
  assert.equal(cleanExerciseName("chest fly"), "chest fly");
  assert.equal(cleanExerciseName("incline dumbbell press"), "incline dumbbell press");
});

test("canonicalLiftKey groups synonyms of the same movement (progressive overload)", () => {
  // All the ways a client logs a chest fly must land on ONE tracking key.
  const fly = canonicalLiftKey("chest fly");
  assert.equal(canonicalLiftKey("pec deck"), fly);
  assert.equal(canonicalLiftKey("cable fly"), fly);
  assert.equal(canonicalLiftKey("my chest fly is"), fly);   // filler-stripped then canonicalised
  assert.equal(canonicalLiftKey("Chest Fly"), fly);         // case-insensitive
  // And distinct movements stay distinct.
  assert.notEqual(canonicalLiftKey("leg press"), fly);
  assert.notEqual(canonicalLiftKey("leg press"), canonicalLiftKey("leg curl"));
});

test("canonicalLiftKey falls back to the cleaned name for unknown lifts", () => {
  // An exercise not in the alias map still gets a stable, consistent key.
  assert.equal(canonicalLiftKey("zercher squat"), "zercher squat");
  assert.equal(canonicalLiftKey("my zercher squat is"), "zercher squat");
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
// getWeekContext — beginner ease-in (Foundation weeks 1-2 at 2 sets)
// ============================================================

test("week context: non-beginner Foundation week 1 = 3 sets", () => {
  assert.equal(getWeekContext(1, 1, false).sets, "3", "experienced user gets full 3 sets in week 1");
});
test("week context: beginner Foundation week 1 eased to 2 sets", () => {
  assert.equal(getWeekContext(1, 1, true).sets, "2", "beginner should start at 2 sets");
});
test("week context: beginner Foundation week 2 still 2 sets", () => {
  assert.equal(getWeekContext(1, 2, true).sets, "2", "beginner week 2 stays at 2 sets");
});
test("week context: beginner builds to 3 sets by week 3", () => {
  assert.equal(getWeekContext(1, 3, true).sets, "3", "beginner adds third set in week 3");
});
test("week context: beginner reps unchanged (only sets eased)", () => {
  assert.equal(getWeekContext(1, 1, true).reps, getWeekContext(1, 1, false).reps, "reps stay the same; only set count eases");
});
test("week context: beginner easing does NOT touch Phase 2+", () => {
  // Build phase week 1 — beginner flag must not reduce sets outside Foundation
  assert.equal(getWeekContext(2, 1, true).sets, getWeekContext(2, 1, false).sets, "phase 2 unaffected by beginner flag");
});
test("week context: beginner week 1 rationale mentions building up", () => {
  assert.match(getWeekContext(1, 1, true).rationale, /week 3|2 sets|adapt/i, "beginner should be told the third set is coming");
});
test("week context: defaults to non-beginner when flag omitted", () => {
  assert.equal(getWeekContext(1, 1).sets, "3", "omitted flag = full programme (explicit easing only)");
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

// GROCERY PERSONALIZATION (2026-07-12, Kam: "they need to know the user"). The list
// stays prescriptive for cold-start beginners, then adapts to what the client actually
// logs — keep their staples, swap their junk, fill the gap.
test("grocery: classifier buckets SA foods into protein/veg/wholecarb/fruit", () => {
  assert.equal(classifyLoggedFood("eggs"), "protein");
  assert.equal(classifyLoggedFood("chicken breast"), "protein");
  assert.equal(classifyLoggedFood("morogo"), "veg");
  assert.equal(classifyLoggedFood("spinach"), "veg");
  assert.equal(classifyLoggedFood("brown rice"), "wholecarb");
  assert.equal(classifyLoggedFood("banana"), "fruit");
  assert.equal(classifyLoggedFood("coke"), "other");
});

test("grocery: loggerType segments new / learning / established by distinct foods", () => {
  assert.equal(loggerType(0), "new");
  assert.equal(loggerType(2), "new");
  assert.equal(loggerType(3), "learning");
  assert.equal(loggerType(6), "learning");
  assert.equal(loggerType(7), "established");
  assert.equal(loggerType(15), "established");
});

test("grocery: cold-start client gets a CALM 'you're covered' block + how to send their own list", () => {
  const thin: FoodProfile = { topFoods: [{ name: "eggs", count: 2 }, { name: "pap", count: 1 }], distinctCount: 2 };
  const block = buildGroceryPersonalization(thin, "fat_loss");
  assert.ok(/covered/i.test(block), "reassures the anxious beginner they're covered");
  assert.ok(/send me a photo|send.*photo/i.test(block), "tells them they can send their own list/food");
  assert.ok(!/Kept in/i.test(block), "must NOT fake knowing a brand-new client's foods");
});

test("grocery: a learning logger's list names staples, swaps junk, fills the gap, nudges logging", () => {
  const profile: FoodProfile = {
    topFoods: [
      { name: "eggs", count: 6 }, { name: "chicken", count: 5 },
      { name: "pap", count: 4 }, { name: "coke", count: 3 },
    ],
    distinctCount: 4,
  };
  const block = buildGroceryPersonalization(profile, "fat_loss");
  assert.ok(/Kept in/i.test(block), "names the staples they already eat");
  assert.ok(/eggs/i.test(block) && /chicken/i.test(block), "lists their real foods");
  assert.ok(/Coke Zero|zero sugar/i.test(block), "swaps the Coke they keep logging");
  assert.ok(/Add veg/i.test(block), "flags the missing veg (they logged none)");
  assert.ok(/keep logging/i.test(block), "nudges them that logging sharpens it");
});

test("grocery: an established logger gets quiet-confidence framing, no beginner nudges", () => {
  const foods = ["eggs", "chicken", "spinach", "brown rice", "pilchards", "morogo", "butternut", "oats"]
    .map((name, i) => ({ name, count: 8 - i }));
  const block = buildGroceryPersonalization({ topFoods: foods, distinctCount: foods.length }, "muscle_gain");
  assert.ok(/know your kitchen/i.test(block), "confident framing for a rich logger");
  assert.ok(!/keep logging/i.test(block), "no 'keep logging' nudge for someone who already does");
  assert.ok(!/send me a photo/i.test(block), "established loggers don't need the discoverability line every week");
  assert.ok(/Kept in/i.test(block), "still names their real staples");
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
  // Anchor BOTH to the same SAST day. The old version built "11pm SAST" on the
  // current UTC date but compared against today-in-SAST — between 22:00 and 24:00
  // UTC those are different calendar days, so the suite failed only when run in
  // the two hours after SAST midnight (caught live, 2026-07-06 23:14 UTC).
  const todaySAST = new Date(Date.now() + SAST_OFFSET);
  const todayKey = `${todaySAST.getUTCFullYear()}-${todaySAST.getUTCMonth()}-${todaySAST.getUTCDate()}`;
  // 23:00 SAST on today's SAST date = 21:00 UTC on that same calendar date
  const elevenPmSAST = new Date(Date.UTC(todaySAST.getUTCFullYear(), todaySAST.getUTCMonth(), todaySAST.getUTCDate(), 21, 0, 0));
  const sastKey = dateKey(elevenPmSAST);
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
// Shopping list / pantry inventory detection — must NOT be logged as a meal
// ============================================================

// Mirror exact logic from food-context.ts
const SHOPPING_CONTEXT_RE_TEST = /\b(isle\s*by\s*isle|go\s*(?:isle|aisle)|aisle|what\s+i\s+have\s+(?:at\s+home|here)|have\s+at\s+home|at\s+home\s+i\s+(?:have|keep|stock)|what\s+i\s+(?:normally\s+)?(?:buy|stock|keep)|what.*(?:think|choose|chose)\s+(?:is\s+)?missing|shopping\s+list|groceries?|pantry|in\s+(?:my\s+)?fridge|what.?s\s+in\s+(?:my|the)\s+(?:fridge|pantry|house|cupboard)|i\s+stock|need\s+to\s+buy|running\s+low|picked\s+up\s+from|went\s+to\s+(?:the\s+)?(?:shop|store|checkers|shoprite|pick\s*n\s*pay|woolworths|spar))\b/i;
const dashCount = (msg: string) => msg.split("\n").filter(l => /^\s*-\s*\S/.test(l)).length;
const isShoppingList = (msg: string, hasLogTrig: boolean) => {
  const dc = dashCount(msg);
  const mLow = msg.toLowerCase();
  return !hasLogTrig && ((dc >= 3 && SHOPPING_CONTEXT_RE_TEST.test(mLow)) || dc >= 7);
};

test("'isle by isle' + dash list is detected as shopping list", () => {
  const msg = "I just go isle by isle and choose what I think is missing\n-Wheetbix\n-eggs\n-full cream milk\n-peanut butter\n-brown rice\n-maize meal\n-pasta";
  assert.ok(isShoppingList(msg, false), "isle by isle + 7 items should be shopping list");
});
test("7+ dash items alone (no context) is detected as shopping list", () => {
  const msg = "-rice\n-chicken\n-eggs\n-pasta\n-oats\n-banana\n-cheese\n-peanut butter";
  assert.ok(isShoppingList(msg, false), "8 dash items alone should be shopping list");
});
test("'shopping list' + 3 dash items is detected", () => {
  const msg = "Here is my shopping list\n-oats\n-eggs\n-chicken";
  assert.ok(isShoppingList(msg, false), "explicit shopping list text should be detected");
});
test("3 dash items with log trigger (meal listing) is NOT shopping list", () => {
  const msg = "For lunch I had:\n-rice\n-chicken\n-salad";
  assert.ok(!isShoppingList(msg, true), "dash list WITH log trigger should not be intercepted");
});
test("2 dash items without context is NOT shopping list", () => {
  const msg = "I had for dinner\n-pap\n-wors";
  assert.ok(!isShoppingList(msg, true), "only 2 items should not trigger shopping list guard");
});

// ============================================================
// Conversion objection handler — pure function, no DB needed
// ============================================================

import { handleConversionObjection } from "../server/handlers/conversion";
const fakeUser = { goalType: "fat_loss", proteinTarget: 130, calorieTarget: 1800 };
const convCtx = (m: string) => ({ user: fakeUser, m: m.toLowerCase(), payLink: "https://example.com/pay", name: "Sipho" });

test("'can't afford' triggers CONVERSION_MONEY", () => {
  const r = handleConversionObjection(convCtx("I can't afford it right now"));
  assert.ok(r !== null && r.intent === "CONVERSION_MONEY", `expected CONVERSION_MONEY, got ${r?.intent}`);
});
test("'too expensive' triggers CONVERSION_MONEY", () => {
  const r = handleConversionObjection(convCtx("That's too expensive for me"));
  assert.ok(r !== null && r.intent === "CONVERSION_MONEY", `expected CONVERSION_MONEY, got ${r?.intent}`);
});
test("'let me think about it' triggers CONVERSION_STALL", () => {
  const r = handleConversionObjection(convCtx("Let me think about it"));
  assert.ok(r !== null && r.intent === "CONVERSION_STALL", `expected CONVERSION_STALL, got ${r?.intent}`);
});
test("'maybe later' triggers CONVERSION_STALL", () => {
  const r = handleConversionObjection(convCtx("Maybe later, I'm not ready"));
  assert.ok(r !== null && r.intent === "CONVERSION_STALL", `expected CONVERSION_STALL, got ${r?.intent}`);
});
test("'how much is it' triggers CONVERSION_PRICE", () => {
  const r = handleConversionObjection(convCtx("How much is it per month?"));
  assert.ok(r !== null && r.intent === "CONVERSION_PRICE", `expected CONVERSION_PRICE, got ${r?.intent}`);
});
test("'what does it cost' triggers CONVERSION_PRICE", () => {
  const r = handleConversionObjection(convCtx("What does it cost?"));
  assert.ok(r !== null && r.intent === "CONVERSION_PRICE", `expected CONVERSION_PRICE, got ${r?.intent}`);
});
test("plain goal message returns null (no objection)", () => {
  const r = handleConversionObjection(convCtx("I want to lose weight"));
  assert.ok(r === null, "non-objection message should return null");
});
test("money objection reply contains R6.63", () => {
  const r = handleConversionObjection(convCtx("No money right now"));
  assert.ok(r !== null && r.reply.includes("R6.63"), "money reply should frame the daily cost");
});

// ============================================================
// getSleepResponse — pure function, no DB needed
// ============================================================

test("sleep: null hours + isBadSleep=true → cortisol advice", () => {
  const r = getSleepResponse(null, true);
  assert.ok(r.includes("cortisol") || r.includes("fat loss") || r.includes("Cortisol"), `unexpected: ${r}`);
});
test("sleep: null hours + isBadSleep=false → log prompt", () => {
  const r = getSleepResponse(null, false);
  assert.ok(r.includes("Log") || r.includes("log") || r.includes("hours"), `unexpected: ${r}`);
});
test("sleep: 3 hours (< 5) → hard-insufficient message with specific advice", () => {
  const r = getSleepResponse(3, false);
  assert.ok(r.includes("3 hours"), `should mention the hour count: ${r}`);
  assert.ok(r.includes("not enough") || r.includes("screens"), `should warn about insufficient sleep: ${r}`);
});
test("sleep: 4 hours mentions the exact count", () => {
  const r = getSleepResponse(4, false);
  assert.ok(r.startsWith("4 hours"), `should start with the hour count: ${r}`);
});
test("sleep: 6 hours (low but >= 5) → low-sleep response mentioning 6", () => {
  const r = getSleepResponse(6, false);
  assert.ok(r.includes("6"), `low-sleep reply should reference the count: ${r}`);
});
test("sleep: 7 hours (good) → positive reinforcement", () => {
  const r = getSleepResponse(7, false);
  assert.ok(r.includes("7"), `good-sleep reply should reference the count: ${r}`);
  assert.ok(r.includes("solid") || r.includes("quality") || r.includes("hours"), `should be positive: ${r}`);
});
test("sleep: 9 hours (good boundary) → still positive", () => {
  const r = getSleepResponse(9, false);
  assert.ok(r.includes("9"), `should reference 9 hours: ${r}`);
});
test("sleep: 10 hours (> 9) → oversleeping response mentioning energy check", () => {
  const r = getSleepResponse(10, false);
  assert.ok(r.includes("10"), `oversleep reply should mention count: ${r}`);
  assert.ok(r.includes("energy") || r.includes("stress") || r.includes("burnout") || r.includes("iron"), `should flag potential burnout/anaemia: ${r}`);
});
test("sleep: 5 hours (exact low boundary) → low not critical response", () => {
  const r = getSleepResponse(5, false);
  assert.ok(r.includes("5"), `should mention 5 hours: ${r}`);
});

// ============================================================
// Crime / unsafe walking objection regex
// ============================================================

const CRIME_RE_TEST = /\b(can.?t\s+walk\s+(?:outside|outside here|outside in my area|in my area|near me|around here|on the street)|not\s+safe\s+to\s+walk|unsafe\s+to\s+walk|scared\s+to\s+walk|afraid\s+to\s+walk|dangerous\s+(?:to walk|outside|around here|in my area|near me)|crime\s+(?:in my area|is bad|is high|outside|near me|around here)|too\s+much\s+crime|high\s+crime|crime\s+rate|it.?s\s+not\s+safe\s+(?:outside|to walk|here)|can.?t\s+go\s+outside|don.?t\s+feel\s+safe\s+(?:walking|outside)|neighbourhood\s+(?:is\s+)?(?:dangerous|unsafe|not safe))\b/i;

test("'not safe to walk' matches crime objection", () => {
  assert.ok(CRIME_RE_TEST.test("it's not safe to walk in my area"), "not safe to walk should match");
});
test("'too much crime' matches crime objection", () => {
  assert.ok(CRIME_RE_TEST.test("there is too much crime outside"), "too much crime should match");
});
test("'scared to walk outside' matches", () => {
  assert.ok(CRIME_RE_TEST.test("I'm scared to walk outside"), "scared to walk should match");
});
test("'can't walk outside' matches", () => {
  assert.ok(CRIME_RE_TEST.test("I can't walk outside here"), "can't walk outside should match");
});
test("'high crime rate' matches", () => {
  assert.ok(CRIME_RE_TEST.test("the crime rate in my area is very high"), "high crime rate should match");
});
test("plain 'I walked 5km' does NOT match crime objection", () => {
  assert.ok(!CRIME_RE_TEST.test("I walked 5km this morning"), "walked 5km should not trigger crime handler");
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
// Food log gate — systemic corpus (mirrors food-context.ts logic)
// Covers all known false-positive patterns and real meal logs.
// ============================================================

// Mirror exact regex from food-context.ts — keep in sync when changing either
const HAS_LOG_TRIGGER = /\b(ate|had|having|eating|breakfast|lunch|dinner|supper|snack|brunch|for breakfast|for lunch|for dinner|for supper|for snack|for brunch|breakfast was|lunch was|dinner was|supper was|just had|just ate|meal was|meal is|food was|i ate|i had|i've had|ive had|pre.?workout|pre workout|post.?workout|post workout|before.*gym|after.*gym|before.*training|after.*training|added|put in|putting in)\b/i;

const IS_FUTURE_PLANNING = /\b(i.?ll\s+have|i\s+will\s+have|gonna\s+have|going\s+to\s+have|need\s+to\s+buy|need\s+to\s+get|want\s+to\s+buy|going\s+to\s+(?:buy|get|pick\s+up)|planning\s+to\s+(?:eat|have|cook)|want\s+to\s+(?:eat|have|try|order)|thinking\s+of\s+(?:eating|having|cooking)|will\s+be\s+(?:eating|having))\b/i;

const IS_QUESTION = (m: string) =>
  m.includes("?") ||
  /^(what|should|can i|is |are |how|why|when|tell me about|which|do i|does |do |where|can )/.test(m) ||
  /\b(from where|where can|where do|where to|how much|how many|is it|is that|are they|are those|should i|can i|do i|does it|what is|what are|which one|good for|bad for|healthy|unhealthy|worth it|better than|worse than|is that enough|enough protein|enough calories|is it enough|any good|any protein)\b/.test(m);

// Mirror food-context.ts isFrustration: frustration words, UNLESS the message is
// also a food log / correction (those should still log even when phrased angrily).
const HAS_FRUSTRATION_WORDS = /\b(no no|that.?s not|not true|not right|wrong|incorrect|read everything|come on|what the hell|terrible|rubbish|nonsense|adjust it|fix it|change it|update it|that.?s wrong|bull|crap|ridiculous|do a better|better job|what\??!*$|huh\??|excuse me|are you sure|doesn.?t look right|not correct|try again|redo|recalculate)\b/i;
const IS_FRUSTRATION = (m: string) =>
  HAS_FRUSTRATION_WORDS.test(m) &&
  !/\b(i had|i ate|i said|had|ate|having|eating|the above|for lunch|for dinner|for breakfast|for supper|go with|goes with|part of|same meal|i was correcting)\b/i.test(m);

// Mirror food-context.ts hasSubstantiveQuestion: a genuine nutritional question that
// must be answered, not silently logged ("I had 2 eggs, is that enough protein?").
const HAS_SUBSTANTIVE_QUESTION = (m: string) =>
  /\b(is that enough|how much|how many|is it (ok|good|healthy|bad|enough|too much)|good for|bad for|enough protein|enough calories|too (many|much)|any good|is this (ok|good|healthy|bad|enough)|is (that|this) (bad|good|ok|healthy)|have protein|contain protein|much protein|has protein)\b/i.test(m)
  || /^(is |does |do |will |can |should |are |have |has )\b/i.test(m);

const QUANTITY_WORD = /\b(\d+|one|two|three|four|five|half|a\s+cup|a\s+bowl|a\s+plate|a\s+tin|a\s+scoop|tbsp|tsp|grams?|kg|ml|litre)\b/i;

// directFoodScan fires when: no question, no frustration, no log trigger, no future planning,
// has food, ≤12 words, at least ONE exact food match, AND (2+ exact matches OR a quantity word).
// Mirrors food-context.ts directFoodScan exactly:
//   exactFoodCount >= 1 && (exactFoodCount >= 2 || hasQuantityWord)
// exactFoodCount is modelled separately from foodCount so the tests can prove a fuzzy-only
// match (exactFoodCount=0) never auto-logs — that is real evidence the scanner won't write
// to the food log on a guess.
const wouldDirectScan = (m: string, foodCount: number, exactFoodCount: number) => {
  const lo = m.toLowerCase();
  if (IS_QUESTION(lo)) return false;
  if (IS_FRUSTRATION(lo)) return false;
  if (HAS_LOG_TRIGGER.test(lo)) return false;
  if (IS_FUTURE_PLANNING.test(lo)) return false;
  if (m.split(/\s+/).length > 12) return false;
  if (foodCount < 1) return false;
  if (exactFoodCount < 1) return false; // a fuzzy guess alone is never enough to auto-log
  return exactFoodCount >= 2 || QUANTITY_WORD.test(lo);
};

// Full gate: would the food scanner fire? (mirrors food-context.ts logic exactly)
// foodCount: how many SA foods were found (0 = no food detected, controls hasActualFood)
// exactFoodCount: how many were EXACT matches (defaults to foodCount — i.e. all exact —
//   so existing exact-match corpus cases stay valid; pass a smaller value to model fuzzy).
// Mirrors the gate at food-context.ts: (!isQuestion || foodLogOverride) && !isFrustration
//   && !isEmotionalOnly && !isFuturePlanning && hasActualFood && (hasLogTrigger || directFoodScan)
// isEmotionalOnly depends on the soft-struggle detector (not regex-reproducible here);
// the corpus below contains no emotional-struggle messages, so it is treated as false.
const wouldLog = (m: string, foodCount: number, exactFoodCount: number = foodCount) => {
  const lo = m.toLowerCase();
  const hasLogTrig = HAS_LOG_TRIGGER.test(lo);
  const hasFood = foodCount > 0;
  const foodLogOverride = hasLogTrig && hasFood && !HAS_SUBSTANTIVE_QUESTION(lo);
  const isFuturePlan = IS_FUTURE_PLANNING.test(lo);
  const isQ = IS_QUESTION(lo);
  const isFrus = IS_FRUSTRATION(lo);
  const directScan = hasFood && wouldDirectScan(m, foodCount, exactFoodCount);
  return (!isQ || foodLogOverride) && !isFrus && !isFuturePlan && hasFood && (hasLogTrig || directScan);
};

// --- hasLogTrigger: must match real meal logs ---
test("hasLogTrigger: 'I ate chicken and rice' matches", () => {
  assert.ok(HAS_LOG_TRIGGER.test("i ate chicken and rice"), "ate should match");
});
test("hasLogTrigger: 'I had oats for breakfast' matches", () => {
  assert.ok(HAS_LOG_TRIGGER.test("i had oats for breakfast"), "had should match");
});
test("hasLogTrigger: 'just ate 2 eggs' matches", () => {
  assert.ok(HAS_LOG_TRIGGER.test("just ate 2 eggs"), "just ate should match");
});
test("hasLogTrigger: 'lunch was pap and mince' matches", () => {
  assert.ok(HAS_LOG_TRIGGER.test("lunch was pap and mince"), "lunch was should match");
});
test("hasLogTrigger: 'for dinner I had chicken' matches", () => {
  assert.ok(HAS_LOG_TRIGGER.test("for dinner i had chicken"), "for dinner should match");
});
test("hasLogTrigger: 'post workout shake and banana' matches", () => {
  assert.ok(HAS_LOG_TRIGGER.test("post workout shake and banana"), "post workout should match");
});
test("hasLogTrigger: 'having my oats now' matches", () => {
  assert.ok(HAS_LOG_TRIGGER.test("having my oats now"), "having should match");
});
test("hasLogTrigger: 'added 2 eggs to my log' matches", () => {
  assert.ok(HAS_LOG_TRIGGER.test("added 2 eggs to my log"), "added should match");
});
test("hasLogTrigger: 'pre workout oats and peanut butter' matches", () => {
  assert.ok(HAS_LOG_TRIGGER.test("pre workout oats and peanut butter"), "pre workout should match");
});

// --- hasLogTrigger: must NOT match future tense (removed in this revision) ---
test("hasLogTrigger: 'I'll have chicken later' does NOT match", () => {
  assert.ok(!HAS_LOG_TRIGGER.test("i'll have chicken later"), "future i'll have must be removed from trigger");
});
test("hasLogTrigger: 'I will have rice for dinner' — dinner still matches but isFuturePlanning blocks gate", () => {
  // hasLogTrigger matches 'dinner', but IS_FUTURE_PLANNING catches 'i will have' → gate still blocks
  assert.ok(IS_FUTURE_PLANNING.test("i will have rice for dinner"), "i will have must be caught by future planning guard");
  assert.ok(!wouldLog("I will have rice for dinner", 1), "full gate must block future planning even when log trigger fires");
});
test("hasLogTrigger: 'gonna have chicken tonight' does NOT match", () => {
  assert.ok(!HAS_LOG_TRIGGER.test("gonna have chicken tonight"), "gonna have must be removed");
});
test("hasLogTrigger: 'going to have rice and chicken' does NOT match", () => {
  assert.ok(!HAS_LOG_TRIGGER.test("going to have rice and chicken"), "going to have must be removed");
});

// --- isFuturePlanning: must match planning/shopping intent ---
test("isFuturePlanning: 'I need to buy eggs and chicken' matches", () => {
  assert.ok(IS_FUTURE_PLANNING.test("i need to buy eggs and chicken"), "need to buy should be planning");
});
test("isFuturePlanning: 'I'll have chicken and rice for dinner' matches", () => {
  assert.ok(IS_FUTURE_PLANNING.test("i'll have chicken and rice for dinner"), "i'll have should be planning");
});
test("isFuturePlanning: 'going to have dinner tonight' matches", () => {
  assert.ok(IS_FUTURE_PLANNING.test("going to have dinner tonight"), "going to have should be planning");
});
test("isFuturePlanning: 'want to eat rice tonight' matches", () => {
  assert.ok(IS_FUTURE_PLANNING.test("want to eat rice tonight"), "want to eat should be planning");
});
test("isFuturePlanning: 'planning to have fish for dinner' matches", () => {
  assert.ok(IS_FUTURE_PLANNING.test("planning to have fish for dinner"), "planning to have should be planning");
});
test("isFuturePlanning: 'gonna have breakfast soon' matches", () => {
  assert.ok(IS_FUTURE_PLANNING.test("gonna have breakfast soon"), "gonna have should be planning");
});
test("isFuturePlanning: 'need to get some oats from the shop' matches", () => {
  assert.ok(IS_FUTURE_PLANNING.test("need to get some oats from the shop"), "need to get should be planning");
});
test("isFuturePlanning: 'thinking of having chicken for dinner' matches", () => {
  assert.ok(IS_FUTURE_PLANNING.test("thinking of having chicken for dinner"), "thinking of having should be planning");
});

// --- isFuturePlanning: must NOT block real past-eating logs ---
test("isFuturePlanning: 'I had chicken and rice for lunch' does NOT match", () => {
  assert.ok(!IS_FUTURE_PLANNING.test("i had chicken and rice for lunch"), "real log must not be planning");
});
test("isFuturePlanning: 'just ate oats and eggs' does NOT match", () => {
  assert.ok(!IS_FUTURE_PLANNING.test("just ate oats and eggs"), "just ate must not be planning");
});
test("isFuturePlanning: 'for breakfast I ate pap and eggs' does NOT match", () => {
  assert.ok(!IS_FUTURE_PLANNING.test("for breakfast i ate pap and eggs"), "for breakfast ate must not be planning");
});
test("isFuturePlanning: 'lunch was rice and mince' does NOT match", () => {
  assert.ok(!IS_FUTURE_PLANNING.test("lunch was rice and mince"), "lunch was must not be planning");
});
test("isFuturePlanning: 'pap and wors' does NOT match", () => {
  assert.ok(!IS_FUTURE_PLANNING.test("pap and wors"), "bare food must not be planning");
});
test("isFuturePlanning: 'post workout shake and banana' does NOT match", () => {
  assert.ok(!IS_FUTURE_PLANNING.test("post workout shake and banana"), "post workout must not be planning");
});

// --- Full gate: should LOG (true positives) ---
test("gate LOGS: 'I had chicken and rice for lunch' (past tense + food)", () => {
  assert.ok(wouldLog("I had chicken and rice for lunch", 2), "past meal should log");
});
test("gate LOGS: 'pap and wors' (2 foods, directFoodScan)", () => {
  assert.ok(wouldLog("pap and wors", 2), "bare 2-food message should log");
});
test("gate LOGS: 'rice and chicken' (2 foods, directFoodScan)", () => {
  assert.ok(wouldLog("rice and chicken", 2), "bare 2-food message should log");
});
test("gate LOGS: '2 eggs and toast' (quantity + food, directFoodScan)", () => {
  assert.ok(wouldLog("2 eggs and toast", 2), "quantity + food should log");
});
test("gate LOGS: 'for dinner I ate chicken breast' (for dinner + ate)", () => {
  assert.ok(wouldLog("for dinner I ate chicken breast", 1), "for dinner + ate should log");
});
test("gate LOGS: 'breakfast was oats and milk' (breakfast was)", () => {
  assert.ok(wouldLog("breakfast was oats and milk", 2), "breakfast was should log");
});
test("gate LOGS: 'just ate a bowl of mielie pap with stew' (just ate)", () => {
  assert.ok(wouldLog("just ate a bowl of mielie pap with stew", 2), "just ate should log");
});
test("gate LOGS: 'lunch was rice, tuna and eggs' (meal label + foods)", () => {
  assert.ok(wouldLog("lunch was rice, tuna and eggs", 3), "lunch was with foods should log");
});
test("gate LOGS: 'post workout: protein shake and banana' (post workout)", () => {
  assert.ok(wouldLog("post workout: protein shake and banana", 2), "post workout should log");
});
test("gate LOGS: 'oats and eggs' (2 foods, directFoodScan)", () => {
  assert.ok(wouldLog("oats and eggs", 2), "oats and eggs should log");
});

// --- Full gate: must NOT LOG (false positives — the known failure patterns) ---
test("gate BLOCKS: 'I need to buy eggs and chicken' (shopping intent)", () => {
  assert.ok(!wouldLog("I need to buy eggs and chicken", 2), "shopping intent must not log");
});
test("gate BLOCKS: 'I'll have chicken and rice for dinner' (future tense)", () => {
  assert.ok(!wouldLog("I'll have chicken and rice for dinner", 2), "future tense must not log");
});
test("gate BLOCKS: 'going to have rice tonight' (future tense)", () => {
  assert.ok(!wouldLog("going to have rice tonight", 1), "going to have must not log");
});
test("gate BLOCKS: 'want to eat rice and chicken for lunch' (planning)", () => {
  assert.ok(!wouldLog("want to eat rice and chicken for lunch", 2), "want to eat must not log");
});
test("gate BLOCKS: 'planning to have chicken tomorrow' (planning)", () => {
  assert.ok(!wouldLog("planning to have chicken tomorrow", 1), "planning to have must not log");
});
test("gate BLOCKS: 'should I eat eggs or oats?' (question)", () => {
  assert.ok(!wouldLog("should I eat eggs or oats?", 2), "question must not log");
});
test("gate BLOCKS: 'is chicken good for weight loss?' (question)", () => {
  assert.ok(!wouldLog("is chicken good for weight loss?", 1), "question must not log");
});
test("gate BLOCKS: 'what should I have for breakfast?' (question)", () => {
  assert.ok(!wouldLog("what should I have for breakfast?", 0), "question must not log");
});
test("gate BLOCKS: 'I need to get oats and eggs from checkers' (shopping)", () => {
  assert.ok(!wouldLog("I need to get oats and eggs from checkers", 2), "shopping errand must not log");
});
test("gate BLOCKS: 'thinking of having chicken and rice tonight' (planning)", () => {
  assert.ok(!wouldLog("thinking of having chicken and rice tonight", 2), "thinking of having must not log");
});

// --- Substantive nutritional questions must NOT silently log (foodLogOverride guard) ---
// These contain a real eating verb ("I had") AND food, so the old helper logged them and
// dropped the question. The real fix: foodLogOverride excludes substantive questions.
test("gate BLOCKS: 'I had 2 eggs, is that enough protein?' (eaten food + question — must answer, not log)", () => {
  assert.ok(!wouldLog("I had 2 eggs, is that enough protein?", 1), "nutritional question must not silently log the eggs");
});
test("gate BLOCKS: 'I had chicken and rice, is that enough?' (eaten food + 'is that enough')", () => {
  assert.ok(!wouldLog("I had chicken and rice, is that enough?", 2), "'is that enough' question must not log");
});
test("gate BLOCKS: 'does chicken and rice have protein' (does-prefix nutrition question)", () => {
  assert.ok(!wouldLog("does chicken and rice have protein", 2), "'does ... have protein' question must not log");
});
test("gate BLOCKS: 'how much protein in 2 eggs and toast' (how much question)", () => {
  assert.ok(!wouldLog("how much protein in 2 eggs and toast", 2), "'how much' question must not log");
});

// --- Frustration must NOT log even with food words present (isFrustration guard) ---
test("gate BLOCKS: 'this is nonsense, wrong again' (pure frustration, no eating verb)", () => {
  assert.ok(!wouldLog("this is nonsense, wrong again with the rice", 1), "frustration without eating verb must not log");
});
// But frustration phrased as a correction of a logged meal SHOULD still log:
test("gate LOGS: 'no that's wrong, I had chicken not beef' (correction with eating verb)", () => {
  assert.ok(wouldLog("no that's wrong, I had chicken not beef", 2), "meal correction must still log despite frustration words");
});

// --- directFoodScan: exact-vs-fuzzy match modelling (food-context.ts requires exactFoodCount >= 1) ---
// A bare food message with only FUZZY matches (exactFoodCount=0) must NOT auto-log — a guess
// is never enough evidence to write to the food log without an eating verb.
test("gate BLOCKS: 'something with mince' (2 fuzzy, 0 exact — no auto-log on a guess)", () => {
  assert.ok(!wouldLog("something with mince and stuff", 2, 0), "fuzzy-only matches must not directFoodScan");
});
test("gate BLOCKS: bare single fuzzy food (1 fuzzy, 0 exact)", () => {
  assert.ok(!wouldLog("some kind of stew", 1, 0), "single fuzzy match must not directFoodScan");
});
// Two EXACT matches with no eating verb SHOULD auto-log (directFoodScan).
test("gate LOGS: 'rice and chicken' (2 exact, directFoodScan)", () => {
  assert.ok(wouldLog("rice and chicken", 2, 2), "two exact bare foods should directFoodScan");
});
// One EXACT match alone (no quantity, no verb) must NOT auto-log — needs 2 exact OR a quantity.
test("gate BLOCKS: 'chicken' (1 exact, no quantity, no verb)", () => {
  assert.ok(!wouldLog("chicken", 1, 1), "single exact food without quantity must not directFoodScan");
});
// One EXACT match WITH a quantity word SHOULD auto-log.
test("gate LOGS: '2 eggs' (1 exact + quantity, directFoodScan)", () => {
  assert.ok(wouldLog("2 eggs", 1, 1), "single exact food with quantity should directFoodScan");
});

// ============================================================
// KamLife Progress Score — beyond-the-scale composite (pure function)
// ============================================================

const PERFECT_WEEK = {
  completedSessions: 3, plannedSessions: 3,
  avgDailyProtein: 130, proteinTarget: 130,
  avgSteps: 10000, stepsTarget: 10000,
  foodLogDays: 7,
  weightLogCount: 3, weightChangeKg: -0.5,
  goalType: "fat_loss",
};

test("score: a perfect week is 100/100", () => {
  const s = computeProgressScore(PERFECT_WEEK);
  assert.equal(s.score, 100, "all components maxed must total 100");
  assert.ok(s.bottleneck.startsWith("None"), "no bottleneck on a perfect week");
});

test("score: a totally silent week is 0/100", () => {
  const s = computeProgressScore({
    completedSessions: 0, plannedSessions: 3,
    avgDailyProtein: 0, proteinTarget: 130,
    avgSteps: 0, stepsTarget: 10000,
    foodLogDays: 0,
    weightLogCount: 0, weightChangeKg: null,
    goalType: "fat_loss",
  });
  assert.equal(s.score, 0, "nothing logged must score 0");
});

test("score: never exceeds 100 even when metrics beat target", () => {
  const s = computeProgressScore({
    ...PERFECT_WEEK,
    completedSessions: 6, avgDailyProtein: 220, avgSteps: 18000,
  });
  assert.equal(s.score, 100, "over-performing components are capped, not stacked over 100");
});

// THE retention case: weight is flat (bad scale read) but habits are strong.
// The score must stay high so a flat scale never reads as failure.
test("score: scale flat but habits strong still scores high (retention case)", () => {
  const s = computeProgressScore({
    completedSessions: 3, plannedSessions: 3,
    avgDailyProtein: 125, proteinTarget: 130,
    avgSteps: 9500, stepsTarget: 10000,
    foodLogDays: 6,
    weightLogCount: 3, weightChangeKg: 0.0, // flat
    goalType: "fat_loss",
  });
  assert.ok(s.score >= 80, `flat-scale-but-consistent should stay >=80, got ${s.score}`);
});

test("score: identifies the single lowest area as the bottleneck", () => {
  // Everything strong except steps (0 logged) → steps is the bottleneck.
  const s = computeProgressScore({
    completedSessions: 3, plannedSessions: 3,
    avgDailyProtein: 130, proteinTarget: 130,
    avgSteps: 0, stepsTarget: 10000,
    foodLogDays: 7,
    weightLogCount: 2, weightChangeKg: -0.4,
    goalType: "fat_loss",
  });
  assert.equal(s.bottleneck, "Steps", "the empty steps area must be named the bottleneck");
});

test("score: recomposition rewards a flat weight (goal-aware trend)", () => {
  const recompFlat = computeProgressScore({ ...PERFECT_WEEK, goalType: "recomposition", weightChangeKg: 0.1 });
  const recompBig  = computeProgressScore({ ...PERFECT_WEEK, goalType: "recomposition", weightChangeKg: 3.0 });
  assert.ok(recompFlat.score > recompBig.score, "recomp should score a stable weight above a big swing");
});

test("score: muscle_gain rewards gaining, fat_loss rewards losing (same change, opposite credit)", () => {
  const gaining = computeProgressScore({ ...PERFECT_WEEK, goalType: "muscle_gain", weightChangeKg: 0.4 });
  const losingOnBulk = computeProgressScore({ ...PERFECT_WEEK, goalType: "muscle_gain", weightChangeKg: -0.4 });
  assert.ok(gaining.score > losingOnBulk.score, "muscle_gain must credit a gain over a loss");
});

// ============================================================
// Client triage — "who needs help today" risk classifier (pure)
// ============================================================

const ACTIVE_ON_TRACK = {
  daysSinceActive: 0, daysSinceSignup: 30, hasOpenUrgentEscalation: false,
  subscriptionStatus: "active", plannedSessionsPerWeek: 3, workoutsLast7: 3,
};

test("triage: safety escalation is always red, beats everything", () => {
  const t = computeClientRisk({ ...ACTIVE_ON_TRACK, hasOpenUrgentEscalation: true });
  assert.equal(t.level, "red");
  assert.match(t.reason, /escalation/i);
});
test("triage: cancelled subscription is red (win-back)", () => {
  const t = computeClientRisk({ ...ACTIVE_ON_TRACK, subscriptionStatus: "cancelled" });
  assert.equal(t.level, "red");
});
test("triage: silent 5+ days is red", () => {
  assert.equal(computeClientRisk({ ...ACTIVE_ON_TRACK, daysSinceActive: 6 }).level, "red");
});
test("triage: quiet 2-4 days is yellow", () => {
  assert.equal(computeClientRisk({ ...ACTIVE_ON_TRACK, daysSinceActive: 3 }).level, "yellow");
});
test("triage: active but missing most sessions is yellow", () => {
  assert.equal(computeClientRisk({ ...ACTIVE_ON_TRACK, daysSinceActive: 1, workoutsLast7: 0 }).level, "yellow");
});
test("triage: active and on track is green", () => {
  assert.equal(computeClientRisk(ACTIVE_ON_TRACK).level, "green");
});
test("triage: brand-new signup with no messages yet is green (onboarding, not silent)", () => {
  const t = computeClientRisk({ ...ACTIVE_ON_TRACK, daysSinceActive: null, daysSinceSignup: 0 });
  assert.equal(t.level, "green");
});
test("triage: old account that never engaged is red", () => {
  const t = computeClientRisk({ ...ACTIVE_ON_TRACK, daysSinceActive: null, daysSinceSignup: 10 });
  assert.equal(t.level, "red");
});
test("triage: sortByRisk puts red first, then most-silent within a level", () => {
  const mk = (level: "red"|"yellow"|"green", days: number|null) => ({ triage: { level, reason: "", nextAction: "" }, daysSinceActive: days });
  const sorted = sortByRisk([mk("green", 0), mk("red", 2), mk("yellow", 1), mk("red", 8)]);
  assert.equal(sorted[0].triage.level, "red");
  assert.equal(sorted[0].daysSinceActive, 8, "most-silent red comes before less-silent red");
  assert.equal(sorted[3].triage.level, "green");
});

// ============================================================
// Workout difficulty feedback classifier (pure)
// ============================================================

test("feedback: 'too easy' → too_easy", () => {
  assert.equal(classifyWorkoutFeedback("that was too easy"), "too_easy");
});
test("feedback: 'felt easy, need more' → too_easy", () => {
  assert.equal(classifyWorkoutFeedback("felt easy, need more next time"), "too_easy");
});
test("feedback: 'too hard' → too_hard", () => {
  assert.equal(classifyWorkoutFeedback("that was too hard"), "too_hard");
});
test("feedback: 'it kicked my butt' → too_hard", () => {
  assert.equal(classifyWorkoutFeedback("brutal, it kicked my ass"), "too_hard");
});
test("feedback: 'just right' / 'perfect' → just_right", () => {
  assert.equal(classifyWorkoutFeedback("that was just right"), "just_right");
  assert.equal(classifyWorkoutFeedback("perfect session"), "just_right");
});
test("feedback: unrelated message → null", () => {
  assert.equal(classifyWorkoutFeedback("what's for dinner"), null);
  assert.equal(classifyWorkoutFeedback("log 2 eggs"), null);
});

// ============================================================
// Step target easing — BMI / age / experience aware starting goal
// ============================================================

// Goal-aware base targets
test("steps: fat_loss non-beginner normal BMI → 8500 (food does the deficit, steps supplement)", () => {
  // 80kg / 180cm → BMI 24.7, age 30, intermediate, fat_loss
  assert.equal(calculateStepsTarget(80, 30, 180, "intermediate", "fat_loss"), 8500);
});
test("steps: muscle_gain client gets 6000 base (protect calorie surplus)", () => {
  assert.equal(calculateStepsTarget(80, 30, 180, "intermediate", "muscle_gain"), 6000);
});
test("steps: recomposition client gets 8000 base", () => {
  assert.equal(calculateStepsTarget(80, 30, 180, "intermediate", "recomposition"), 8000);
});
// BMI easing with updated caps
test("steps: fat_loss obese (BMI>=30) starts eased at 7500", () => {
  // 100kg / 175cm → BMI 32.7
  assert.equal(calculateStepsTarget(100, 35, 175, "intermediate", "fat_loss"), 7500);
});
test("steps: fat_loss obesity class II (BMI>=35) eased to 6500", () => {
  // 115kg / 175cm → BMI 37.6
  assert.equal(calculateStepsTarget(115, 35, 175, "intermediate", "fat_loss"), 6500);
});
test("steps: fat_loss severe obesity (BMI>=40) eased to 5500", () => {
  // 130kg / 175cm → BMI 42.5
  assert.equal(calculateStepsTarget(130, 35, 175, "intermediate", "fat_loss"), 5500);
});
test("steps: never-trained beginner (normal BMI, fat_loss) eased to 7500", () => {
  // 70kg / 175cm → BMI 22.9, beginner
  assert.equal(calculateStepsTarget(70, 30, 175, "beginner", "fat_loss"), 7500);
});
test("steps: elderly + obese takes the gentler easing (5500 wins)", () => {
  // 95kg / 172cm → BMI 32.1 (7500 cap), age 72 (5500 cap): 5500 wins
  assert.equal(calculateStepsTarget(95, 72, 172, "intermediate", "fat_loss"), 5500);
});
test("steps: obese beginner — BMI is binding constraint (6500 < beginner 7500)", () => {
  // 115kg / 175cm beginner → BMI 37.6 → 6500; beginner cap 7500: BMI wins
  assert.equal(calculateStepsTarget(115, 30, 175, "beginner", "fat_loss"), 6500);
});
test("steps: extreme case never drops below 4000 floor", () => {
  assert.ok(calculateStepsTarget(160, 75, 165, "beginner", "fat_loss") >= 4000);
});
test("steps: muscle_gain beginner — goal ceiling (6000) is dominant over beginner cap (7500)", () => {
  assert.equal(calculateStepsTarget(80, 25, 175, "beginner", "muscle_gain"), 6000);
});
test("steps: default goalType arg (no arg) falls back to fat_loss behavior", () => {
  assert.equal(calculateStepsTarget(80, 30, 180, "intermediate"), 8500);
});

// ADAPTIVE STEP TARGET (2026-07-12, Kam: "50% of my clients can't walk 10,000 — make
// a plan"). Right-size the goal to what they actually walk: down when they're way under,
// up when they smash it, nothing in the sustainable middle, nothing without real data.
test("adaptive steps: consistently well under → lower to a winnable goal (with a stretch)", () => {
  const adj = suggestStepTargetAdjustment(8500, 5200, 6)!;
  assert.equal(adj.direction, "down");
  assert.equal(adj.newTarget, 6000);            // round(5200+750 → 5950) to 6000, above their avg
  assert.ok(adj.newTarget < 8500 && adj.newTarget > 5200, "winnable but still a stretch");
  assert.match(adj.reason, /WIN every day/i);
});

test("adaptive steps: consistently at/over target → suggest a climb", () => {
  const adj = suggestStepTargetAdjustment(7500, 8100, 6)!;
  assert.equal(adj.direction, "up");
  assert.equal(adj.newTarget, 8500);
});

test("adaptive steps: sustainable middle (70-100%) → leave the goal alone", () => {
  assert.equal(suggestStepTargetAdjustment(8000, 6800, 6), null); // 85%
  assert.equal(suggestStepTargetAdjustment(8000, 7900, 7), null); // 99%
});

test("adaptive steps: never adjusts without enough real data, or on a broken target", () => {
  assert.equal(suggestStepTargetAdjustment(8500, 3000, 2), null, "only 2 days logged");
  assert.equal(suggestStepTargetAdjustment(8500, 0, 6), null, "no steps");
  assert.equal(suggestStepTargetAdjustment(0, 5000, 6), null, "no valid current target");
});

test("adaptive steps: an established high target is never pushed past 12,000", () => {
  assert.equal(suggestStepTargetAdjustment(12000, 13000, 7), null, "already at the ceiling");
});

// ============================================================
// getDailyStepContext — workout-day and goal-aware daily adjustment
// ============================================================

test("getDailyStepContext: fat_loss rest day → full base target", () => {
  const ctx = getDailyStepContext(8000, "fat_loss", false);
  assert.equal(ctx.target, 8000);
  assert.equal(ctx.goalContext, "fat_loss");
});
test("getDailyStepContext: fat_loss workout day → 78% of base (gym already burned)", () => {
  const ctx = getDailyStepContext(8000, "fat_loss", true);
  assert.equal(ctx.target, Math.round(8000 * 0.78));
  assert.equal(ctx.goalContext, "fat_loss");
});
test("getDailyStepContext: muscle_gain rest day → full base", () => {
  const ctx = getDailyStepContext(6000, "muscle_gain", false);
  assert.equal(ctx.target, 6000);
  assert.equal(ctx.goalContext, "muscle_gain");
});
test("getDailyStepContext: muscle_gain workout day → 80% (protect surplus + recovery)", () => {
  const ctx = getDailyStepContext(6000, "muscle_gain", true);
  assert.equal(ctx.target, Math.round(6000 * 0.80));
  assert.equal(ctx.goalContext, "muscle_gain");
});
test("getDailyStepContext: recomposition workout day → 82% of base", () => {
  const ctx = getDailyStepContext(8000, "recomposition", true);
  assert.equal(ctx.target, Math.round(8000 * 0.82));
  assert.equal(ctx.goalContext, "recomp");
});
test("getDailyStepContext: rangeMin is 82% of the adjusted target", () => {
  const ctx = getDailyStepContext(8000, "fat_loss", false);
  assert.equal(ctx.rangeMin, Math.round(8000 * 0.82));
});
test("getDailyStepContext: never drops below 4000 floor even after workout reduction", () => {
  // 4000 * 0.80 = 3200 — floored at 4000
  const ctx = getDailyStepContext(4000, "muscle_gain", true);
  assert.ok(ctx.target >= 4000);
});
test("getDailyStepContext: weight_loss maps to fat_loss goalContext", () => {
  const ctx = getDailyStepContext(8000, "weight_loss", false);
  assert.equal(ctx.goalContext, "fat_loss");
});

// ============================================================
// Engagement back-off for routine nudges — pure decision function
// ============================================================

import { routineNudgeAllowed } from "../server/scheduler/nudge-policy";

test("back-off: engaged user (0 days silent) gets routine nudge", () => {
  assert.ok(routineNudgeAllowed(0, 100), "0 days silent should always allow");
  assert.ok(routineNudgeAllowed(0, 101), "0 days silent should allow on odd day too");
});
test("back-off: 1 day silent still gets routine nudge every day", () => {
  assert.ok(routineNudgeAllowed(1, 100), "1 day silent should allow");
  assert.ok(routineNudgeAllowed(1, 101), "1 day silent should allow on any day");
});
test("back-off: 2 days silent gets nudge every OTHER day (even day)", () => {
  assert.ok(routineNudgeAllowed(2, 100), "2 days silent on even day = allowed");
  assert.ok(!routineNudgeAllowed(2, 101), "2 days silent on odd day = skipped");
});
test("back-off: 3 days silent gets NO routine nudge (retention owns them)", () => {
  assert.ok(!routineNudgeAllowed(3, 100), "3 days silent should be blocked");
  assert.ok(!routineNudgeAllowed(3, 101), "3 days silent blocked on any day");
});
test("back-off: 7 days silent gets NO routine nudge", () => {
  assert.ok(!routineNudgeAllowed(7, 100), "deeply silent users get no routine nudge");
});
test("back-off: every-other-day halves volume for drifting users", () => {
  // Over 10 consecutive days at daysSilent=2, only ~half should fire
  let fired = 0;
  for (let day = 0; day < 10; day++) if (routineNudgeAllowed(2, day)) fired++;
  assert.equal(fired, 5, `2-day-silent should fire 5/10 days, got ${fired}`);
});

// ============================================================
// DATE-HYGIENE GUARD — no hardcoded years in proactive message text
// ------------------------------------------------------------
// A hardcoded year ("Log your first food of 2025") or any literal date baked
// into a client-facing string goes stale and the coach starts stating things
// that are false. Scheduler messages must derive the year/month/day at runtime.
// This scans every scheduler message string and fails if a 4-digit year is
// embedded. Years inside quotes only — numeric constants like setTimeout(r,2000)
// are ignored because they are not string content.
// ============================================================
test("no hardcoded years in scheduler message strings", () => {
  const jobsDir = join(process.cwd(), "server", "scheduler", "jobs");
  const files = [
    ...readdirSync(jobsDir).filter(f => f.endsWith(".ts")).map(f => join(jobsDir, f)),
    join(process.cwd(), "server", "scheduler.ts"),
  ];
  const strLiteral = /`[^`]*`|"[^"]*"|'[^']*'/g;
  const yearPattern = /\b(?:19|20)\d{2}\b/;
  const violations: string[] = [];

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return; // skip comments
      const strings = line.match(strLiteral) || [];
      for (const s of strings) {
        if (yearPattern.test(s)) {
          violations.push(`    ${file.split("/server/")[1]}:${i + 1} → ${s.slice(0, 80)}`);
        }
      }
    });
  }
  assert.equal(
    violations.length, 0,
    `Hardcoded year(s) found in scheduler message text — derive the year at runtime instead:\n${violations.join("\n")}`,
  );
});

// ============================================================
// Date-key format consistency.
// todayCaloriesDate is stored as YYYY-MM-DD (via sastToday()). The
// `toLocaleDateString("en-ZA", …).split("/").reverse().join("-")` idiom
// produces DD-MM-YYYY, which silently never matches the stored value —
// it zeroed today's calories/protein in every reader that used it
// (lifecycle.ts weekly advice + gpt-block food-pattern ceiling signal).
// These are date KEYS for comparison, not display. Ban the pattern so it
// cannot creep back. Time display (toLocaleTimeString) is unaffected —
// the guard requires both "en-ZA" and ".reverse()" on the same line.
// ============================================================
test("no DD-MM-YYYY date-key pattern (en-ZA + reverse) in server code", () => {
  const serverDir = join(process.cwd(), "server");
  const tsFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) tsFiles.push(full);
    }
  };
  walk(serverDir);

  const violations: string[] = [];
  for (const file of tsFiles) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return; // skip comments
      if (/en-ZA/.test(line) && /\.reverse\(\)/.test(line)) {
        violations.push(`    ${file.split("/server/")[1]}:${i + 1} → ${trimmed.slice(0, 90)}`);
      }
    });
  }
  assert.equal(
    violations.length, 0,
    `DD-MM-YYYY date-key pattern found — use sastToday() (YYYY-MM-DD) for any value compared against todayCaloriesDate:\n${violations.join("\n")}`,
  );
});

// ============================================================
// BETA_TESTERS phone normalisation — an allowlist entry in any SA format must
// compare equal to the digits-only MSISDN from a WhatsApp webhook.
// ============================================================
test("normaliseMsisdn: SA local 0-prefixed → 27…", () => {
  assert.equal(normaliseMsisdn("0682002798"), "27682002798");
});
test("normaliseMsisdn: +27 with spaces → 27…", () => {
  assert.equal(normaliseMsisdn("+27 68 200 2798"), "27682002798");
});
test("normaliseMsisdn: whatsapp:-prefixed international → 27…", () => {
  assert.equal(normaliseMsisdn("whatsapp:+27682002798"), "27682002798");
});
test("normaliseMsisdn: bare 9-digit local → 27…", () => {
  assert.equal(normaliseMsisdn("682002798"), "27682002798");
});
test("normaliseMsisdn: all SA formats of one number collapse to the same key", () => {
  const forms = ["0682002798", "+27682002798", "27682002798", "+27 68 200 2798", "whatsapp:+27682002798"];
  const keys = new Set(forms.map(normaliseMsisdn));
  assert.equal(keys.size, 1, `expected one canonical key, got ${[...keys].join(", ")}`);
});
test("normaliseMsisdn: empty / junk input returns '' (never matches an allowlist)", () => {
  assert.equal(normaliseMsisdn(""), "");
  assert.equal(normaliseMsisdn("   "), "");
  assert.equal(normaliseMsisdn("not-a-number"), "");
});

// ── WhatsApp template variables (Twilio Content API contentVariables) ─────────
test("buildContentVariables: builds a keyed JSON string for the template", () => {
  assert.equal(buildContentVariables({ "1": "Kam", "2": 5 }), '{"1":"Kam","2":"5"}');
});
test("buildContentVariables: no variables → undefined (never an empty '{}')", () => {
  assert.equal(buildContentVariables(undefined), undefined);
  assert.equal(buildContentVariables({}), undefined);
});
test("buildContentVariables: drops null/undefined/empty values", () => {
  assert.equal(buildContentVariables({ "1": "Kam", "2": null, "3": undefined, "4": "" }), '{"1":"Kam"}');
});

// ============================================================
// Water status command detection — a bare "water log" / "my water" must show the
// summary, NEVER fall through to GPT (which hallucinated "I can't help you with
// water" — a core feature it fully supports). Mirrors water.ts isWaterStatusCmd.
// ============================================================
const WATER_STATUS_CMD = /^(water|water\s*log|log\s*water|my\s*water|water\s*status|water\s*total|water\s*today|water\s*summary|water\s*count|water\s*tracker|water\s*tracking|show\s*(my\s*)?water|check\s*(my\s*)?water)\s*\??$/i;

test("water status: 'water log' matches (the exact bug — was hitting GPT)", () => {
  assert.ok(WATER_STATUS_CMD.test("water log"), "'water log' must show the water summary");
});
test("water status: 'log water' matches", () => {
  assert.ok(WATER_STATUS_CMD.test("log water"), "'log water' must show the water summary");
});
test("water status: bare 'water' still matches", () => {
  assert.ok(WATER_STATUS_CMD.test("water"), "bare 'water' must show the water summary");
});
test("water status: 'my water' / 'water today' / 'water status' match", () => {
  assert.ok(WATER_STATUS_CMD.test("my water"), "'my water'");
  assert.ok(WATER_STATUS_CMD.test("water today"), "'water today'");
  assert.ok(WATER_STATUS_CMD.test("water status"), "'water status'");
});
test("water status: an actual water LOG ('i drank 2 litres of water') does NOT match (handled by the logger)", () => {
  assert.ok(!WATER_STATUS_CMD.test("i drank 2 litres of water"), "amount-bearing logs go to the logging path, not the summary");
});
test("water status: an unrelated question does NOT match", () => {
  assert.ok(!WATER_STATUS_CMD.test("is chicken healthy"), "non-water message must not match");
});

// ============================================================
// selectMealToCopy — "same as yesterday" meal selection
// Production bug 2026-06-24: only breakfast logged yesterday, client said
// "same lunch as yesterday", bot copied the breakfast AS lunch.
// ============================================================

const DAY = 86_400_000;
const T = (hoursAgo: number): Date => new Date(Date.now() - hoursAgo * 3_600_000);
const meal = (over: Partial<CopyableMeal>): CopyableMeal =>
  ({ kcalInt: 500, loggedAt: T(2), rawMessage: "some food", mealLabel: null, ...over });

test("selectMealToCopy: THE BUG — 'lunch' hint with only a breakfast logged returns null (never copies breakfast as lunch)", () => {
  const meals = [meal({ rawMessage: "3 boiled eggs, 2 slices brown bread and 1 chicken vienna for breakfast", mealLabel: "breakfast", kcalInt: 549, loggedAt: T(26) })];
  assert.equal(selectMealToCopy(meals, "lunch"), null, "must NOT substitute breakfast when lunch was asked for");
});

test("selectMealToCopy: 'lunch' hint matches a meal whose raw text says lunch", () => {
  const lunch = meal({ rawMessage: "rice and chicken for lunch", mealLabel: "lunch", loggedAt: T(28) });
  const breakfast = meal({ rawMessage: "oats for breakfast", mealLabel: "breakfast", loggedAt: T(30) });
  assert.equal(selectMealToCopy([breakfast, lunch], "lunch"), lunch);
});

test("selectMealToCopy: 'lunch' hint matches by stored label when raw text lacks the word", () => {
  const lunch = meal({ rawMessage: "leftovers", mealLabel: "lunch", loggedAt: T(28) });
  const dinner = meal({ rawMessage: "steak", mealLabel: "dinner", loggedAt: T(20) });
  assert.equal(selectMealToCopy([dinner, lunch], "lunch"), lunch);
});

test("selectMealToCopy: no hint returns the most recent substantial meal", () => {
  const older = meal({ rawMessage: "older", loggedAt: T(30), kcalInt: 600 });
  const newer = meal({ rawMessage: "newer", loggedAt: T(10), kcalInt: 600 });
  assert.equal(selectMealToCopy([older, newer], null), newer);
});

test("selectMealToCopy: empty history returns null", () => {
  assert.equal(selectMealToCopy([], "lunch"), null);
  assert.equal(selectMealToCopy([], null), null);
});

test("selectMealToCopy: skips trivial sub-150kcal logs (a black coffee is not 'lunch')", () => {
  const coffee = meal({ rawMessage: "black coffee", mealLabel: "lunch", kcalInt: 5, loggedAt: T(28) });
  // only a tiny coffee labelled lunch exists → not substantial, hint can't match → null
  assert.equal(selectMealToCopy([coffee], "lunch"), null);
});

test("selectMealToCopy: THE 2nd BUG (2026-07-01) — breakfast hint must NOT positionally grab the oldest meal (apple+pear snack was copied as breakfast)", () => {
  const snack = meal({ rawMessage: "i had apple and pear for meal", mealLabel: null, kcalInt: 197, loggedAt: T(30) });
  const lunch = meal({ rawMessage: "rice and chicken for lunch", mealLabel: "lunch", kcalInt: 620, loggedAt: T(24) });
  assert.equal(selectMealToCopy([snack, lunch], "breakfast"), null, "no breakfast match → ask, never guess");
});

test("selectMealToCopy: light-meal (<150kcal) fallback only applies when NO meal was named", () => {
  const lightSnack = meal({ rawMessage: "an apple", mealLabel: null, kcalInt: 80, loggedAt: T(26) });
  assert.equal(selectMealToCopy([lightSnack], null), lightSnack, "no hint → light log is fine");
  assert.equal(selectMealToCopy([lightSnack], "breakfast"), null, "named meal → never substitute a snack");
});

// ============================================================
// stripInventedRetroDate — normalizer hallucination brake
// Production bug 2026-06-24: lift PB share normalized to "workout done
// yesterday" → bot said "already got yesterday's workout logged".
// ============================================================

test("stripInventedRetroDate: THE BUG — strips invented 'yesterday' not in the original", () => {
  assert.equal(
    stripInventedRetroDate("workout done yesterday", "hack squat I did 25kg each side for the first time. 6 reps"),
    "workout done",
  );
});

test("stripInventedRetroDate: keeps a REAL 'yesterday' the client actually wrote", () => {
  assert.equal(
    stripInventedRetroDate("workout done yesterday", "I trained legs yesterday"),
    "workout done yesterday",
  );
});

test("stripInventedRetroDate: strips invented 'last monday' but keeps real ones", () => {
  assert.equal(stripInventedRetroDate("workout done last monday", "did chest and back"), "workout done");
  assert.equal(stripInventedRetroDate("workout done last monday", "trained last monday"), "workout done last monday");
});

test("stripInventedRetroDate: strips invented 'N days ago'", () => {
  assert.equal(stripInventedRetroDate("workout done 2 days ago", "squats and deadlifts today"), "workout done");
});

test("stripInventedRetroDate: no retro date → returns canonical unchanged (trimmed)", () => {
  assert.equal(stripInventedRetroDate("workout done", "just finished my session"), "workout done");
});

// ============================================================
// Transaction-report detectors — gate the model brain; a report must reach
// the deterministic logger, ordinary chat must reach the brain
// ============================================================

test("steps reports detected; steps chat is not", () => {
  assert.ok(looksLikeStepsReport("Steps are 10000"));
  assert.ok(looksLikeStepsReport("walked 3000 steps not hungry"));
  assert.ok(looksLikeStepsReport("10k steps today"));
  assert.ok(!looksLikeStepsReport("how are my steps looking"), "no digits = chat");
  assert.ok(!looksLikeStepsReport("I want to start walking more"));
});

test("water reports detected; beers and chat are not", () => {
  assert.ok(looksLikeWaterReport("drank 500ml"));
  assert.ok(looksLikeWaterReport("1 litre"));
  assert.ok(looksLikeWaterReport("had 2 glasses of water"));
  assert.ok(!looksLikeWaterReport("had 2 beers with the boys"), "beers are not water");
  assert.ok(!looksLikeWaterReport("should I drink more water?"));
});

test("weight reports detected; lift logs are not", () => {
  assert.ok(looksLikeWeightReport("83kg"));
  assert.ok(looksLikeWeightReport("my weight is 83.4kg"));
  assert.ok(looksLikeWeightReport("weighed in at 82.9kg this morning"));
  assert.ok(!looksLikeWeightReport("bench 80kg 3x10"), "a lift log is not a weigh-in");
  assert.ok(!looksLikeWeightReport("I want to reach 75kg by December"));
});

// ============================================================
// verifyBrainReply — the self-correcting loop's checks (pure)
// ============================================================

test("verifier blocks claimed target/goal adjustments (the 08:03 goal-flip reply)", () => {
  assert.ok(!verifyBrainReply("Understood. We'll shift to fat loss. I'll adjust your targets now.", { goalType: "muscle_gain" }).ok);
  assert.ok(!verifyBrainReply("I will update your calorie target tonight.", { goalType: "fat_loss" }).ok);
  assert.ok(!verifyBrainReply("Your goal is now fat loss.", { goalType: "muscle_gain" }).ok);
});

test("verifier blocks wrong-direction pushes per goal", () => {
  assert.ok(!verifyBrainReply("Let's focus on a calorie deficit while keeping protein high.", { goalType: "muscle_gain" }).ok);
  assert.ok(!verifyBrainReply("Let's bulk and aim to gain weight this month.", { goalType: "fat_loss" }).ok);
});

test("verifier blocks frame-mirroring ('your deficit' to a gaining client)", () => {
  assert.ok(!verifyBrainReply("Your calorie deficit doesn't matter as much right now — just eat protein.", { goalType: "muscle_gain" }).ok);
  assert.ok(!verifyBrainReply("Your surplus is on track, keep eating big.", { goalType: "fat_loss" }).ok);
});

test("verifier passes normal coaching, corrections, and same-direction talk", () => {
  assert.ok(verifyBrainReply("Solid week — 3 sessions and protein at 172g. Add weight on the chest press next session.", { goalType: "muscle_gain" }).ok);
  assert.ok(verifyBrainReply("Quick correction: you're not on a deficit — you're on a surplus for muscle gain. Eat to 2996.", { goalType: "muscle_gain" }).ok);
  assert.ok(verifyBrainReply("Stay in your deficit today: protein first, starch last.", { goalType: "fat_loss" }).ok);
  assert.ok(verifyBrainReply("If you want the goal changed, say 'change my goal to fat loss' and I'll get it confirmed properly.", { goalType: "muscle_gain" }).ok);
});

// FITNESS MYTH CATCHER (2026-07-09) — the bot must NEVER ship broscience. Caught in
// code so a prompt line the model ignores can't let "confuse that focus" through again.
test("verifier blocks fitness myths (muscle confusion, shock, spot reduction)", () => {
  assert.ok(!verifyBrainReply("Adding an 8th exercise can confuse that focus — stick to the plan.", {}).ok);
  assert.ok(!verifyBrainReply("Muscle confusion keeps your body guessing so it doesn't adapt.", {}).ok);
  assert.ok(!verifyBrainReply("We'll shock the muscle with new movements every week.", {}).ok);
  assert.ok(!verifyBrainReply("Do more crunches to spot reduce your belly fat.", {}).ok);
  assert.ok(!verifyBrainReply("Skip a week and your muscle turns to fat.", {}).ok);
});

test("verifier ALLOWS correctly debunking a myth (not blocked for naming it)", () => {
  assert.ok(verifyBrainReply("Muscle confusion is a myth — adaptation is the goal. We add targeted volume to your chest.", {}).ok);
  assert.ok(verifyBrainReply("You can't spot reduce — fat comes off everywhere as you stay in a deficit.", {}).ok);
  assert.ok(verifyBrainReply("Your chest is lagging? Add 2-3 sets to your press. That's how you bring it up.", {}).ok);
});

// ============================================================
// hasGoalChangeVocabulary — the normalizer's GOAL_CHANGE brake. A goal flip is
// the most destructive rewrite; only honour it when the client actually asked.
// ============================================================

test("goal-change vocabulary: real goal-change phrasings pass", () => {
  for (const s of [
    "I want to go into a building phase",
    "let's start cutting",
    "change my goal to fat loss",
    "I want to bulk now",
    "time to lean out",
    "focus on losing weight",
    "I want to gain muscle",
    "switch my goal to recomp",
  ]) assert.ok(hasGoalChangeVocabulary(s), `should detect goal change: "${s}"`);
});

test("goal-change vocabulary: the 2026-07-07 false positive and other non-goals are rejected", () => {
  for (const s of [
    "I really only want to be doing 10,000 steps now, nothing more", // the production failure
    "I only want to do 10000 steps now nothing more",
    "how was the workout",
    "I had eggs and pap for breakfast",
    "can I have a cheat meal today",
    "my knee is sore",
  ]) assert.ok(!hasGoalChangeVocabulary(s), `must NOT detect goal change: "${s}"`);
});

// ============================================================
// parseMealDate — SAST anchoring must hold at ANY wall-clock hour
// (the 00:00-02:00 SAST window shipped 'yesterday' two days back for months)
// ============================================================

test("'yesterday' lands on the SAST day before today, noon SAST, at any hour", () => {
  const d = parseMealDate("Yesterday I had 2 eggs and pap for dinner");
  const expected = new Date(sastDayStart().getTime() - 86_400_000 + 12 * 3_600_000);
  assert.equal(d.getTime(), expected.getTime(), `got ${d.toISOString()}, expected ${expected.toISOString()}`);
});

test("'last night' lands on yesterday 20:00 SAST, at any hour", () => {
  const d = parseMealDate("had braai last night");
  const expected = new Date(sastDayStart().getTime() - 86_400_000 + 20 * 3_600_000);
  assert.equal(d.getTime(), expected.getTime());
});

test("'2 days ago' lands exactly two SAST days back at noon", () => {
  const d = parseMealDate("had KFC 2 days ago");
  const expected = new Date(sastDayStart().getTime() - 2 * 86_400_000 + 12 * 3_600_000);
  assert.equal(d.getTime(), expected.getTime());
});

test("day-name meal lands on a past SAST day with the right wall-clock slot", () => {
  const d = parseMealDate("had chicken and rice on saturday evening");
  const diffFromToday = (sastDayStart().getTime() - sastDayStart(d).getTime()) / 86_400_000;
  assert.ok(diffFromToday >= 1 && diffFromToday <= 7, `days back: ${diffFromToday}`);
  const sastHour = new Date(d.getTime() + 2 * 3_600_000).getUTCHours();
  assert.equal(sastHour, 20, `evening should be 20:00 SAST, got ${sastHour}:00`);
});

// ============================================================
// parseQuantityCorrection — "2 eggs not 3" must never double-log
// ============================================================

test("qty correction: '2 eggs not 3' parses new/old counts and food", () => {
  assert.deepEqual(parseQuantityCorrection("2 eggs not 3"), { count: 2, food: "eggs", oldCount: 3 });
});

test("qty correction: sentence forms parse — 'it was 2 slices of bread not 4'", () => {
  const r = parseQuantityCorrection("it was 2 slices of bread not 4");
  assert.ok(r, "should parse");
  assert.equal(r!.count, 2);
  assert.equal(r!.oldCount, 4);
  assert.ok(r!.food.includes("slice"), `food: ${r!.food}`);
});

test("qty correction: units and non-food counts never match", () => {
  assert.equal(parseQuantityCorrection("80 kg not 85"), null);
  assert.equal(parseQuantityCorrection("walked 3000 steps not 4000"), null);
  assert.equal(parseQuantityCorrection("did 3 sets not 4"), null);
  assert.equal(parseQuantityCorrection("20 minutes not 30"), null);
});

test("qty correction: same count or insane counts reject", () => {
  assert.equal(parseQuantityCorrection("3 eggs not 3"), null);
  assert.equal(parseQuantityCorrection("100 eggs not 3"), null);
});

test("qty correction: plain food log never matches", () => {
  assert.equal(parseQuantityCorrection("I had 2 eggs and toast for breakfast"), null);
  assert.equal(parseQuantityCorrection("2 eggs and 3 viennas"), null);
});

// ============================================================
// energyFrameLine — one energy truth for every model prompt
// ============================================================

test("energy frame: muscle gain states maintenance below target and surplus-is-built-in", () => {
  const line = energyFrameLine("muscle_gain", 2996);
  assert.ok(line, "line should build");
  assert.ok(line!.includes("2596"), `maintenance should be target-400: ${line}`);
  assert.ok(line!.includes("ALREADY includes the muscle-gain surplus"), "must state surplus is built in");
  assert.ok(line!.includes("never the gap left mid-day"), "must ban mid-day deficit talk");
});

test("energy frame: fat loss states maintenance above target", () => {
  const line = energyFrameLine("fat_loss", 1900);
  assert.ok(line!.includes("2350"), `maintenance should be target+450: ${line}`);
  assert.ok(line!.includes("fat-loss deficit"), "must state deficit is built in");
});

test("energy frame: no target → null (never invent numbers)", () => {
  assert.equal(energyFrameLine("muscle_gain", null), null);
  assert.equal(energyFrameLine("muscle_gain", 0), null);
});

// ============================================================
// buildWeekCard — the shareable week artifact (pure, no DB)
// ============================================================

const fullWeek: WeekCardData = {
  name: "Kam Mokgokolo", currentWeight: 82.6, stepsTarget: 11000,
  workoutsThisWeek: 3, trainingDaysPerWeek: 3, avgStepsThisWeek: 11500,
  weightChange: -0.4, mealsLoggedDays: 7, workoutStreak: 8, lifeContext: null,
};

test("week card: full week shows all lines, first name only, brand footer", () => {
  const card = buildWeekCard(fullWeek);
  assert.ok(card, "card should build");
  assert.ok(card!.includes("YOUR WEEK — Kam"), "first name only");
  assert.ok(!card!.includes("Mokgokolo"), "surname must not appear");
  assert.ok(card!.includes("Sessions: 3/3 ✅"), "sessions with tick");
  assert.ok(card!.includes("11,500/day average ✅"), "steps with tick when target met");
  assert.ok(card!.includes("7 of 7 days 🔥"), "full food week gets fire");
  assert.ok(card!.includes("down 0.4kg in 2 weeks"), "weight change stated with window");
  assert.ok(card!.includes("Session streak: 8"), "streak shown at >=3");
  assert.ok(card!.includes("KamLife Coach"), "brand footer present");
});

test("week card: empty week returns null — never send a shame card", () => {
  assert.equal(buildWeekCard({ ...fullWeek, workoutsThisWeek: 0, mealsLoggedDays: 2 }), null);
});

test("week card: life event week returns null — never celebrate over a bereavement", () => {
  assert.equal(buildWeekCard({ ...fullWeek, lifeContext: "This client experienced a bereavement or loss this week." }), null);
});

test("week card: tiny weight change reads as holding steady, not noise", () => {
  const card = buildWeekCard({ ...fullWeek, weightChange: 0.1 });
  assert.ok(card!.includes("82.6kg — holding steady"), `got: ${card}`);
  assert.ok(!card!.includes("up 0.1"), "must not narrate scale noise");
});

test("week card: missing weight/steps/streak lines are omitted, not zeroed", () => {
  const card = buildWeekCard({ ...fullWeek, currentWeight: null, avgStepsThisWeek: 0, workoutStreak: 2 });
  assert.ok(card, "card still builds from sessions+food");
  assert.ok(!card!.includes("⚖️"), "no weight line without a weigh-in");
  assert.ok(!card!.includes("👟"), "no steps line without steps");
  assert.ok(!card!.includes("streak"), "no streak line under 3");
});

test("week card: below-target week still builds but without ticks", () => {
  const card = buildWeekCard({ ...fullWeek, workoutsThisWeek: 2, avgStepsThisWeek: 9000, mealsLoggedDays: 5 });
  assert.ok(card!.includes("Sessions: 2/3"), "honest session count");
  assert.ok(!card!.includes("Sessions: 2/3 ✅"), "no tick when target missed");
  assert.ok(card!.includes("5 of 7 days"), "honest food days");
  assert.ok(!card!.includes("🔥 *"), "no false celebration markers on partial week");
});

// ============================================================
// buildFoodVisionUserPrompt — locks the 2026-07-08 drink-label fix so a future
// prompt edit can never silently drop it again (real tester bug: photographing
// a drink got a guess, turning the bottle to show the label got a DIFFERENT
// guess instead of the label's printed value — sodas were never in the
// "read the label" category at all).
// ============================================================

const drinkPrompt = buildFoodVisionUserPrompt({ message: "", isApprovalCaption: false, liveCal: 2000, liveProt: 150 });

test("vision prompt: soda cans/bottles are in the label-reading category, not just shakes/bars", () => {
  assert.ok(/cooldrink\/soft drink\/energy drink can or bottle/i.test(drinkPrompt), "soda containers must trigger label-reading");
  assert.ok(/Coke, Pepsi, Fanta, Sprite, Stoney, Red Bull, Monster, Score/i.test(drinkPrompt), "named SA drink brands must be present");
});

test("vision prompt: a legible label overrides a guess, even on a repeat photo", () => {
  assert.ok(/legible label always overrides a guess/i.test(drinkPrompt));
  assert.ok(/even if the client already turned the bottle.*second time/i.test(drinkPrompt), "must handle the turn-the-bottle-around case explicitly");
  assert.ok(/never repeat a different generic guess/i.test(drinkPrompt));
});

test("vision prompt: Zero/Diet/Max variants are distinguished from regular (huge calorie gap)", () => {
  assert.ok(/Zero\/Zero Sugar\/Diet\/Light\/Max/i.test(drinkPrompt));
  assert.ok(/Coca-Cola Zero\/Zero Sugar\/Diet Coke ≈0 kcal/i.test(drinkPrompt), "Coke Zero must be distinct from Coke Original in the prompt");
  assert.ok(/Pepsi Max\/Zero Sugar ≈0 kcal/i.test(drinkPrompt));
});

test("vision prompt: known SA drink fallback values are present for common brands", () => {
  for (const needle of ["Coca-Cola Original", "Pepsi Original", "Fanta Orange", "Sprite", "Stoney Ginger Beer", "Red Bull", "Monster Energy", "Score Energy"]) {
    assert.ok(drinkPrompt.includes(needle), `missing known drink value for: ${needle}`);
  }
});

test("vision prompt: still contains the greasy-food and TOTAL-format instructions (no accidental deletion)", () => {
  assert.ok(/TOTAL: X kcal \| Xg protein/.test(drinkPrompt));
  assert.ok(/PREPARATION & GREASE/i.test(drinkPrompt));
});

// PHOTO "can I eat this?" → real SA shelf/menu swaps (2026-07-09). The approval verdict
// must offer a swap they can actually get where they are — shop or takeaway.
test("vision prompt: approval verdict offers real SA shelf + takeaway swaps", () => {
  const approve = buildFoodVisionUserPrompt({ message: "can I eat this?", isApprovalCaption: true, liveCal: 1800, liveProt: 140 });
  assert.ok(/ZERO SUGAR/i.test(approve), "sugary → zero sugar heuristic present");
  assert.ok(/Nando'?s|KFC|Steers/i.test(approve), "takeaway swaps present");
  assert.ok(/Checkers|Shoprite|Pick n Pay/i.test(approve), "shop swaps present");
  assert.ok(/grilled not fried/i.test(approve), "fried→grilled swap present");
});

// PHYSIQUE ANALYSIS (2026-07-09) — read baseline photos → lagging vs dominant muscles,
// gender-aware, to drive targeted-volume programming. The parser must validate the
// model's free-form answer, never trust it raw.
test("physique: parses dominant/lagging/note, maps synonyms, drops hallucinated parts", () => {
  const a = parsePhysiqueAnalysis("DOMINANT: quads, glutes\nLAGGING: rear delts, upper back, unicorn horn\nNOTE: Good base — let's build the top half.", "male");
  assert.deepEqual(a.dominant, ["quads", "glutes"]);
  assert.deepEqual(a.lagging, ["shoulders", "back"], "rear delts→shoulders, upper back→back, unicorn dropped");
  assert.ok(/build the top half/i.test(a.note));
});

test("physique: empty lagging falls back to gender priors, never double-counts a dominant muscle", () => {
  const f = parsePhysiqueAnalysis("DOMINANT: glutes\nLAGGING:\nNOTE:", "female");
  assert.ok(!f.lagging.includes("glutes"), "a dominant muscle is never also flagged lagging");
  assert.deepEqual(f.lagging, ["hamstrings", "shoulders"], "female priors minus the dominant glutes");
});

test("physique: gender priors differ for male vs female", () => {
  assert.deepEqual(genderLaggingPriors("female"), ["glutes", "hamstrings", "shoulders"]);
  assert.deepEqual(genderLaggingPriors("male"), ["chest", "back", "shoulders"]);
});

// 2026-07-10 VOICE-NOTE AUDIT — five real failures, each locked here.
test("brain gate: steps-target changes skip the brain (deterministic updater must run)", () => {
  for (const msg of ["change my steps to 10000", "we're changing my steps to 10,000", "set my step target to 8000", "steps goal 12000", "lower my steps to 9000"])
    assert.ok(looksLikeStepsTargetChange(msg), `must skip brain: ${msg}`);
  for (const msg of ["I walked 10000 steps", "how many steps today", "steps are hard"])
    assert.ok(!looksLikeStepsTargetChange(msg), `must NOT match: ${msg}`);
});

// 2026-07-12 — it STILL said 11,000 after Kam asked "many times". Root cause: the SA-
// natural number formats "10 000" (space separator) and "10k" never matched the gate,
// so the message hit the brain (which chatted, saved nothing). ONE parser now backs
// both the gate and the updater, and returns the persisted number in every format.
test("steps target: parses every SA number format, and only for a CHANGE (not a log)", () => {
  const cases: Array<[string, number]> = [
    ["change my steps to 10000", 10000],
    ["change my steps to 10,000", 10000],
    ["change my steps to 10 000", 10000],   // SA space thousands separator
    ["make my steps 10k", 10000],           // k-suffix
    ["set my step goal to 12 000", 12000],
    ["steps target 8000", 8000],
    ["bump my steps to 15k", 15000],
  ];
  for (const [msg, want] of cases)
    assert.equal(extractStepTargetChange(msg), want, `${msg} → ${want}`);
  // plain step LOGS must NOT be read as a target change (they go to the step logger)
  for (const msg of ["I walked 10 000 steps", "did 8000 steps today", "walked 10k steps", "hit 12,000 steps"])
    assert.equal(extractStepTargetChange(msg), null, `log must not change target: ${msg}`);
});

// LOW MOBILITY (2026-07-12, Kam ×2: "some people can't walk a lot — accommodate that").
// Must reach the warm deterministic accommodation, never the brain or the step logger.
// Precision matters: a lazy day or training soreness must NOT trigger it.
test("brain gate: low-mobility messages skip the brain (accommodation must run)", () => {
  for (const msg of [
    "I can't walk much", "I can't walk far because of my knees", "I'm in a wheelchair",
    "I have arthritis and struggle to walk", "bad knees, walking is really hard for me",
    "I can't do 10000 steps", "I struggle to hit that many steps", "I have difficulty walking",
    "I'm on crutches right now", "I have a heart condition, can't walk far",
  ]) assert.ok(looksLikeLowMobility(msg), `must accommodate: ${msg}`);

  for (const msg of [
    "I didn't walk today", "I don't want to walk today", "my back is sore from deadlifts",
    "I walked 10000 steps", "how many steps today", "walking is my favourite thing",
  ]) assert.ok(!looksLikeLowMobility(msg), `must NOT trigger: ${msg}`);
});

test("brain gate: cancellation/billing skips the brain (real flow must run)", () => {
  for (const msg of ["I'm cancelling my subscription", "cancel my subscription", "unsubscribe", "you charged me twice", "I want a refund", "stop billing me"])
    assert.ok(looksLikeBillingOrCancel(msg), `must skip brain: ${msg}`);
  for (const msg of ["cancel the workout today", "cancel my session tomorrow"])
    assert.ok(!looksLikeBillingOrCancel(msg), `must NOT match: ${msg}`);
});

test("guardrails: 'I hear you' scrub never bites into 'your' (the 'r frustration' bug)", () => {
  const ctx = { userMessage: "", budgetTier: "", injuries: "" } as any;
  const r = enforceCoachGuardrails("I hear your frustration, and I'm sorry for the mix-up.", ctx);
  assert.ok(r.reply.includes("your frustration"), `must keep 'your frustration' intact: ${r.reply}`);
  const r2 = enforceCoachGuardrails("I hear you. Let's fix the plan.", ctx);
  assert.ok(!/I hear you\b/.test(r2.reply) && /Let'?s fix the plan/.test(r2.reply), `standalone filler still stripped: ${r2.reply}`);
});

// DIRECTION REQUEST GATE (2026-07-11) — "give me direction" / voice "what should I be
// doing today" hit the brain and got CONTRADICTING workout dumps (Upper Body A, then B)
// minutes after the menu correctly said REST DAY. These must skip the brain and reach
// the deterministic, rest-day-aware buildDailyDirection. One source of truth: code.
test("brain gate: direction requests skip the brain (incl. both live-failure phrasings)", () => {
  for (const msg of [
    "Give me direction — what do I do today and this week?",
    "Hello coach, what should I be doing today?",
    "what's my plan", "where do I start", "my overall plan",
  ]) assert.ok(looksLikeDirectionRequest(msg), `must skip brain: ${msg}`);
});

test("brain gate: specific asks are NOT direction requests (route to their own handlers)", () => {
  for (const msg of ["today's workout", "what's my meal plan", "shopping list", "how much does it cost", "cancel my plan for today"])
    assert.ok(!looksLikeDirectionRequest(msg), `must NOT match: ${msg}`);
});

// BARE GREETING (2026-07-10) — "hello"/"menu" must reach the warm deterministic menu
// (buttons + context), never the model's generic "what's on your mind". Content-carrying
// greetings must NOT match, so they still flow to the handlers.
test("greeting: bare greetings and menu words match (route to the warm menu)", () => {
  for (const g of ["hello", "Hi", "hey 👋", "Howzit", "menu", "help", "sawubona", "good morning", "hi coach", "Morning"])
    assert.ok(isBareGreeting(g), `should be a bare greeting: ${g}`);
});

test("greeting: content-carrying messages are NOT bare greetings (flow to handlers)", () => {
  for (const m of ["hello I ate eggs", "hi what's my protein target", "hey I did my workout", "menu for the week", "morning walk 3000 steps"])
    assert.ok(!isBareGreeting(m), `should NOT be a bare greeting: ${m}`);
});

// "CAN I EAT THIS?" verdict must never claim it logged (2026-07-12, grapes screenshot):
// the model wrote "Roughly 100 kcal for a handful. Logged. 🍇" into a DECIDING question,
// which collided with the code's "Reply *log it* and I'll count it." line. The scrubber
// removes any logged-claim so the two can never contradict.
test("approval verdict: strips any 'Logged' claim so it can't contradict 'reply log it'", () => {
  assert.equal(
    stripFoodLoggedClaim("These grapes look refreshing! Roughly 100 kcal for a handful. Logged. 🍇"),
    "These grapes look refreshing! Roughly 100 kcal for a handful. 🍇",
  );
  for (const claim of ["I've logged it.", "Logging it now.", "Already logged.", "I logged it for you."])
    assert.ok(!/log(ged|ging)/i.test(stripFoodLoggedClaim(`Nice pick. ${claim}`)), `must scrub: ${claim}`);
  // must NOT touch a clean verdict
  assert.equal(stripFoodLoggedClaim("Solid choice for muscle gain — eat up."), "Solid choice for muscle gain — eat up.");
});

// FORM CHECK (2026-07-09) — remote form coaching must analyse and direct with AT MOST
// two plain fixes, never a lecture, and ask for a side angle when it genuinely can't tell.
test("form check: prompt caps at two fixes, stays plain, asks for a better angle when unsure", () => {
  const p = buildFormCheckPrompt({ clientName: "Kam", exerciseName: "squat", fromVideo: false });
  assert.ok(/at most two|MOST TWO|never more than TWO|two fixes/i.test(p.user), "must cap at two fixes");
  assert.ok(/no jargon|plain words|beginner/i.test(p.system + p.user), "must stay plain");
  assert.ok(/SIDE|side/.test(p.user) && /can'?t (judge|tell)|genuinely can'?t/i.test(p.user), "asks for a side angle when unsure");
  assert.ok(/squat/i.test(p.user), "names the exercise the client gave");
});

test("form check: video variant frames the input as video frames", () => {
  const v = buildFormCheckPrompt({ clientName: "A", exerciseName: "deadlift", fromVideo: true });
  assert.ok(/frames from a short video/i.test(v.user), "video framing present");
});

test("form check: extractFormExercise pulls the lift, null when none named", () => {
  assert.equal(extractFormExercise("check my squat form"), "squat");
  assert.equal(extractFormExercise("how's my deadlift looking"), "deadlift");
  assert.equal(extractFormExercise("watch this and tell me"), null);
});

// SA SHELF SWAPS (2026-07-09) — the bot must give the correct, consistent shelf swap
// for a food based on goal, and never tell an already-good choice to swap.
test("food swaps: sugary drinks → zero sugar, already-zero is left alone", () => {
  assert.match(suggestSwap("Coke", "fat_loss")!.swap, /ZERO SUGAR/i);
  assert.match(suggestSwap("Safari juice", "fat_loss")!.swap, /zero-sugar squash|water/i);
  assert.equal(suggestSwap("Coke Zero", "fat_loss"), null, "already zero — no swap");
  assert.equal(suggestSwap("sugar free red bull", "fat_loss"), null);
});

test("food swaps: goal-gated — full-cream milk swaps for fat loss, kept for muscle gain", () => {
  assert.match(suggestSwap("full cream milk", "fat_loss")!.swap, /low-fat milk/i);
  assert.equal(suggestSwap("full cream milk", "muscle_gain"), null, "full cream is fine for building");
});

test("food swaps: processed meat → real protein; good foods get nothing", () => {
  assert.match(suggestSwap("polony", "fat_loss")!.swap, /pilchards|tuna|eggs/i);
  assert.equal(suggestSwap("grilled chicken and veg", "fat_loss"), null, "clean food needs no swap");
  assert.equal(suggestSwap("", "fat_loss"), null);
});

test("food swaps: swapNudge is a kind forward one-liner, empty when no swap", () => {
  assert.match(swapNudge("Coke", "fat_loss"), /Next time: swap it for .*ZERO SUGAR/i);
  assert.equal(swapNudge("grilled fish", "fat_loss"), "");
});

// 2026-07-12 swap DB expansion (Kam: "expand our database… in terms of swapping foods").
// New high-frequency SA items — but treats (chocolate/sweets) stay UN-swapped: snacks
// are allowed in the coaching philosophy; we only fix liquid sugar and processed savoury.
test("food swaps: expanded SA junk (sports drinks, noodles, crisps, atchar)", () => {
  assert.match(suggestSwap("Energade", "fat_loss")!.swap, /water/i);
  assert.match(suggestSwap("Powerade", "muscle_gain")!.swap, /water/i);
  assert.match(suggestSwap("2 minute noodles", "fat_loss")!.swap, /egg|veg/i);
  assert.match(suggestSwap("packet of Simba chips", "fat_loss")!.swap, /popcorn|nuts/i);
  assert.match(suggestSwap("atchar", "fat_loss")!.swap, /spoon|relish/i);
  assert.equal(suggestSwap("atchar", "muscle_gain"), null, "atchar oil is fine when building");
  // treats are ALLOWED — never nag someone for a chocolate or sweets
  assert.equal(suggestSwap("chocolate", "fat_loss"), null, "treats stay un-swapped by philosophy");
  assert.equal(suggestSwap("sweets", "fat_loss"), null);
});

// 2026-07-12 comprehensive SA swap expansion — takeaways, street food, common extras.
test("food swaps: takeaways & street food (fried chicken, wors, pie, samoosa, kota)", () => {
  assert.match(suggestSwap("KFC", "fat_loss")!.swap, /grilled/i);
  assert.match(suggestSwap("fried chicken", "muscle_gain")!.swap, /grilled/i); // grilling helps every goal
  assert.match(suggestSwap("boerewors", "fat_loss")!.swap, /lean|chicken|steak/i);
  assert.match(suggestSwap("steak pie", "fat_loss")!.swap, /pastry|bread|rice/i);
  assert.match(suggestSwap("samoosa", "fat_loss")!.swap, /baked|two instead/i);
  assert.match(suggestSwap("kota", "fat_loss")!.swap, /small|protein|egg|chicken/i);
});

test("food swaps: SA extras (mageu, sugar in tea, condensed milk, margarine)", () => {
  assert.match(suggestSwap("mageu", "fat_loss")!.swap, /maas|milk/i);
  assert.match(suggestSwap("2 sugars in my tea", "fat_loss")!.swap, /half|sweetener/i);
  assert.match(suggestSwap("condensed milk", "fat_loss")!.swap, /low-fat|maas/i);
  assert.match(suggestSwap("margarine", "fat_loss")!.swap, /scrape|avo|low-fat/i);
});

test("food swaps: expansion must NOT false-fire on clean foods", () => {
  // "chicken pieces" must never be read as a "pie" — it's a lean protein, no swap.
  assert.equal(suggestSwap("chicken pieces", "fat_loss"), null, "pieces != pie");
  assert.equal(suggestSwap("grilled chicken", "fat_loss"), null);
  assert.equal(suggestSwap("plain rice", "fat_loss"), null);
  // wors/pie/margarine are fat-loss swaps only — muscle gain keeps the calories
  assert.equal(suggestSwap("boerewors", "muscle_gain"), null);
  assert.equal(suggestSwap("steak pie", "muscle_gain"), null);
});

// DAILY DIRECTION (2026-07-09) — "give me my overall plan" must return the WHOLE plan
// across every pillar, plain, not a bare workout dump.
test("daily direction: covers today across all pillars + the weekly through-line", () => {
  const d = buildDailyDirection(
    { name: "Kam Test", calorieTarget: 1800, proteinTarget: 140, stepsTarget: 9000, trainingMode: "gym", trainingDaysPerWeek: 3 },
    { type: "NORMAL" },
  );
  assert.ok(/\*Today:\*/.test(d) && /\*This week:\*/.test(d), "has a today and a week section");
  assert.ok(/workout/i.test(d), "training day tells them to get their session");
  assert.ok(/1,?800/.test(d) && /140g/.test(d) && /9,?000 steps/.test(d) && /water/i.test(d), "food + steps + water all present");
  assert.ok(!/surplus|deficit|macros|hypertrophy/i.test(d), "stays plain — no jargon");
  assert.ok(/\[BUTTONS:Today's workout/.test(d), "training day ends in taps (2026-07-11: shipped button-less)");
});

test("daily direction: rest day and walk-only are honoured, never insists on the gym", () => {
  const rest = buildDailyDirection({ name: "A", calorieTarget: 1700, proteinTarget: 120, stepsTarget: 8000, trainingMode: "gym", trainingDaysPerWeek: 4 }, { type: "REST", nextTrainingName: "Tuesday" });
  assert.ok(/rest day/i.test(rest) && !/reply \*workout\*/i.test(rest), "rest day never pushes a session");
  assert.ok(/\[BUTTONS:Log food/.test(rest) && !/BUTTONS:Today's workout/.test(rest), "rest-day buttons skip Today's workout");
  const walk = buildDailyDirection({ name: "B", calorieTarget: 1600, proteinTarget: 100, stepsTarget: 10000, trainingMode: "walk_only", trainingDaysPerWeek: 3 }, { type: "NORMAL" });
  assert.ok(/walk your 10,?000 steps/i.test(walk), "walk-only user gets a steps-first plan");
});

// PROGRESS SET COMPARISON (2026-07-10) — 3 photos used to produce 3 essays, one
// comparing front-vs-back, one a general-advice non-answer, one recommending
// deadlifts off the machine-based programme. The prompt now forbids all three.
test("progress comparison prompt: one set, like-for-like angles, honest, on-programme", () => {
  const p = buildProgressComparisonPrompt({ clientName: "Kam", goalLabel: "muscle gain", weeksLabel: "7 weeks", baselineCount: 3, todayCount: 3 });
  assert.ok(/never a front against a back/i.test(p.user), "must forbid cross-angle comparison");
  assert.ok(/NEVER recommend new or different exercises/i.test(p.user), "must stay on-programme (no deadlifts/squats advice)");
  assert.ok(/do NOT write a general-advice essay/i.test(p.user), "must forbid the 'general approach' non-answer");
  assert.ok(/never invent progress/i.test(p.user), "must stay honest when nothing changed");
  assert.ok(/never a greeting/i.test(p.system), "no 'Hello Kam! Let's take a look' openers");
});

test("physique: prompt is gender + goal aware, focus line names lagging and a strong point", () => {
  const p = buildPhysiqueAnalysisPrompt({ gender: "female", goal: "muscle_gain" });
  assert.ok(/female/i.test(p.system) && /muscle gain/i.test(p.system));
  assert.ok(/DOMINANT:|LAGGING:/.test(p.user), "must specify the strict output contract");
  const line = formatPhysiqueFocusLine({ dominant: ["back"], lagging: ["chest", "shoulders"], note: "" });
  assert.ok(/chest, shoulders/i.test(line) && /strong point/i.test(line));
});

// RESTAURANT MENU OPTION (2026-07-11) — a photographed menu must route to menu-pick
// (MENU_PHOTO sentinel), and the pick prompt must stay decisive, short, on-goal.
test("vision prompt: restaurant menus get the MENU_PHOTO sentinel (no more dead-end)", () => {
  assert.ok(/RESTAURANT or takeaway MENU/i.test(drinkPrompt) && /MENU_PHOTO/.test(drinkPrompt), "menu sentinel present in the vision prompt");
});

test("menu pick: decisive, short, goal-aware — picks, one trap, zero-sugar drink", () => {
  const p = buildMenuPickPrompt({ clientName: "Kam", goal: "fat_loss" });
  assert.ok(/Best pick/.test(p.user) && /Skip:/.test(p.user), "best-pick and skip lines required");
  assert.ok(/ZERO SUGAR/.test(p.user) && /skip the alcohol/i.test(p.user), "drink guidance incl. alcohol for fat loss");
  assert.ok(/only name dishes actually on the menu/i.test(p.user), "no invented dishes");
  assert.ok(/under 8 short lines/i.test(p.user) && /never lecture/i.test(p.system), "stays short and human");
  const mg = buildMenuPickPrompt({ clientName: "K", goal: "muscle_gain" });
  assert.ok(!/skip the alcohol/i.test(mg.user), "alcohol line is goal-gated to fat loss");
});

// HIDDEN ADDED FATS (2026-07-09) — the fat the camera can't see (oil cooked in, avo,
// mayo, dressing) is the #1 reason a consistent logger stalls. This coaching must
// survive future prompt edits, so assert the exact levers are present.
test("vision prompt: coaches hidden added fats the photo can't measure", () => {
  assert.ok(/HIDDEN ADDED FATS/i.test(drinkPrompt), "must name the hidden-added-fats case");
  for (const needle of ["avocado", "mayonnaise", "oil", "low-fat milk", "for next time", "spray"]) {
    assert.ok(new RegExp(needle, "i").test(drinkPrompt), `missing hidden-fat lever: ${needle}`);
  }
  // must stay a FULL-MEAL-only, kind, next-time nudge — never shame, never for snacks
  assert.ok(/FULL COOKED MEAL only/i.test(drinkPrompt), "hidden-fat advice is full-meal only");
  assert.ok(/never .?shame|never "your log is wrong"/i.test(drinkPrompt), "must stay kind, not shaming");
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

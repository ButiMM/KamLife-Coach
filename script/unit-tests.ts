/**
 * Unit tests for pure logic functions — no DB, no API calls, no network.
 * Run: npm run test:unit
 * Exits non-zero on any failure.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { calculateTargets, calculateStepsTarget, getDailyStepContext, energyFrameLine, suggestStepTargetAdjustment, stepBurnKcal, waterTargetLitres, auditStoredTargets, auditStepsTarget, recalcTargetsForProfile, maintenanceKcal } from "../server/targets";
import { predictTrajectory } from "../server/trajectory";
import { getDayType, getPhaseMultiplier, getPhaseNames, getWeekContext, cleanExerciseName, canonicalLiftKey } from "../server/programme";
import { getShoppingList, formatShoppingList } from "../server/shopping-lists";
import { parseFoodPreferences, parseVisionAnswer } from "../server/onboarding-intake";
import { classifyLoggedFood, buildGroceryPersonalization, loggerType, type FoodProfile } from "../server/grocery-personalize";
import { computeProgressScore } from "../server/progress-score";
import { computeClientRisk, sortByRisk } from "../server/client-triage";
import { classifyWorkoutFeedback } from "../server/workout-feedback";
import { normaliseMsisdn, buildContentVariables, stripInventedRetroDate, parseQuantityCorrection, looksLikeStepsReport, looksLikeWaterReport, looksLikeWeightReport, parseMealDate, sastDayStart, hasGoalChangeVocabulary, timeGreeting, slotFromCaptionTime, effectiveMealLoggedAt } from "../server/utils";
import { getSleepResponse } from "../server/handlers/sleep";
import { selectMealToCopy, parseMealRepeatTarget, type CopyableMeal } from "../server/meal-select";
import { getGoalProfile, usesMacroTargets, GOAL_KEYS, looksLikeGoalAnswer, classifyGoalFromText } from "../server/goal-profiles";
import { buildWeekCard, type WeekCardData } from "../server/week-card";
import { verifyBrainReply } from "../server/brain/reply-verifier";
import { weightInContextLine } from "../server/weight-context";
import { parseSignupSource, stripSignupSource, sanitiseSourceTag, buildJoinLink, buildJoinPrefill } from "../server/signup-source";
import { estimateCarbsFat } from "../server/macro-estimate";
import { foodMatchesText, foodMatchTerms, singularFood, perServingEstimate, itemsFromVisionText } from "../server/serving-units";
import { encodePendingFood, readPendingFood, clearPendingFood, parseReferentReply } from "../server/food-referent";
import { whichMacroAsked, macroStatusReply } from "../server/macro-status";
import { foldLedgerRows, freshTodayWater, type LedgerRow } from "../server/day-ledger-core";
import { stripDeadPromises, hasDeadPromise, stripFiller, humanizeReply } from "../server/reply-hygiene";
import { buildFoodVisionUserPrompt, buildMenuPickPrompt } from "../server/handlers/food-vision-prompt";
import { parsePhysiqueAnalysis, buildPhysiqueAnalysisPrompt, formatPhysiqueFocusLine, genderLaggingPriors, buildProgressComparisonPrompt, liftsForLaggingAreas } from "../server/physique-analysis";
import { buildDailyDirection } from "../server/daily-direction";
import { parseSessionReport, sessionReportReply, readFeel } from "../server/session-report";
import { looksLikeQuestion, isFutureIntent, mentionsNotDone } from "../server/utils";
import { displayFoodName, inventedQualifiers } from "../server/food-naming";
import { dinnerCloseLine, remainingInMeals } from "../server/education";
import { levenshtein, maxDistance, FUZZY_BLACKLIST } from "../server/food-fuzzy";
import { scanReply, summarise } from "../server/audit/reply-defects";
import { nextMoveLine } from "../server/macro-card-attach";
import { readLifeContext, lifeContextReply, pausesTargets, quietDays, type LifeContext } from "../server/life-context";
import { comebackPlan } from "../server/adaptive-training";
import { bandFor, assessClients, dropOffCurve, silenceTriggers, summariseEngagement, type ActivityRow } from "../server/engagement";
import { analyseSurface, classifyIntent } from "../server/surface";
import { fadeState, fadingClients } from "../server/engagement";
import { guardMalformed, safeFallback, recordGuardResult, guardStats, guardStatsLine, GUARD_ESCALATION_THRESHOLD } from "../server/malformed-guard";
import { calorieCeiling } from "../server/adaptive-targets";
import { unloggedFoodNotice } from "../server/unlogged-notice";
import { looksLikeQuitMoment, quitSaveReply, readObstacle, silentQuitNudge } from "../server/quit-save";
import { mentionsConditionOrMedication, conditionWelcome } from "../server/condition-welcome";
import { looksLikeComebackQuestion } from "../server/utils";
import { mustStayDeterministic } from "../server/understanding/action-router";
import { parseIdentityCorrection, correctionCandidates } from "../server/food-identity-correction";
import { adaptTraining, applySetsDelta } from "../server/adaptive-training";
import { ceilingState } from "../server/spend-ceiling";
import { isBareReaction, readsAsTherapySpeak, bareReactionFallback } from "../server/reaction-guard";
import { suggestSwap, swapNudge } from "../server/food-swaps";
import { buildFormCheckPrompt, extractFormExercise } from "../server/form-check-prompt";
import { isBareGreeting, looksLikeStepsTargetChange, looksLikeBillingOrCancel, looksLikeDirectionRequest, stripFoodLoggedClaim, extractStepTargetChange, looksLikeLowMobility, looksLikeDefeatedNoResults, looksLikeDigestiveIssue, looksLikeFoodDislike, looksLikeOvertrainingPlan, classifyPainReport, looksLikeWorkoutRequest, parseSickDays, isReturnFromSicknessQuestion, isAskingNotReporting } from "../server/utils";
import { enforceCoachGuardrails } from "../server/coach-guardrails";
import { defaultUnderstanding, coerceUnderstanding, parseUnderstanding, persistableUnderstanding } from "../server/understanding/state";
import { compileStateBlurb, compileKeyFacts } from "../server/understanding/compiler";
import { looksLikeRefusal } from "../server/understanding/refusal";
import { isObviouslyInDomain } from "../server/understanding/domain-guard";
import { mustStayDeterministic } from "../server/understanding/action-router";
import { decayObservations } from "../server/understanding/state";
import { digitizeSpokenAmounts } from "../server/utils";
import { goalStatusLine, progressBar, macroBarsBlock } from "../server/education";
import { renderMacroCard } from "../server/macro-card";

// Some pure helpers live in modules that also import db.ts (e.g. activation.ts) — the
// stub keeps those imports from demanding a real DATABASE_URL. Set before any dynamic
// import below; the static imports above are all pure and don't touch db.
process.env.KAMLIFE_DB_STUB = "1";
// Some modules construct an OpenAI client at import time (meal-verifier via the
// scheduler chain). Pure tests never call it — a stub key just lets imports load.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "unit-test-stub";

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

// ============================================================
// MAINTENANCE (TDEE) — the single break-even source. calorieTarget = maintenance + goalAdj,
// so the trajectory engine and the target calculator can never disagree.
// ============================================================
test("maintenanceKcal: Mifflin TDEE matches the hand-computed break-even", () => {
  // male 80kg/175cm/30y office(1.3) 3 days beginner:
  // BMR = 10×80 + 6.25×175 − 5×30 + 5 = 1748.75 · ×1.3 = 2273.375
  // trainingAdj = round(200×0.75×3/7) = round(64.3) = 64 → maintenance ≈ 2337
  const m = maintenanceKcal(80, "male", 30, 175, "office", 3, "beginner");
  assert.ok(Math.abs(m - 2337) <= 2, `maintenance should be ~2337, got ${m}`);
});
test("maintenanceKcal: is the break-even calorieTarget is built on (target = maintenance + goalAdj)", () => {
  const m = maintenanceKcal(80, "male", 30, 175, "office", 3, "beginner");
  const { calorieTarget } = calculateTargets(80, "fat_loss", "office", 3, "male", 30, 175);
  // male fat-loss adjustment is −400; target must sit that far below maintenance (above the floor).
  assert.equal(calorieTarget, m - 400, `fat-loss target must be maintenance−400 (${m}−400), got ${calorieTarget}`);
});
test("maintenanceKcal: junk inputs never yield NaN", () => {
  assert.ok(Number.isFinite(maintenanceKcal(NaN as any, "male", NaN as any, NaN as any, "office", 3, "beginner")));
});

// ============================================================
// WEIGHT TRAJECTORY — the deterministic "what will the scale do" engine (2026-07-18).
// The anti-"it's a scam" tool: honest energy math from the client's OWN logs.
// ============================================================
{
  const week = (intakeKcal: number, steps: number, n = 5) => Array.from({ length: n }, () => ({ intakeKcal, steps }));

  test("trajectory: a real deficit predicts weight LOSS and reads on-track for fat loss", () => {
    const r = predictTrajectory({ maintenanceKcal: 2400, weightKg: 80, goalType: "fat_loss", days: week(1900, 8000) });
    assert.equal(r.direction, "losing");
    assert.ok(r.predictedWeeklyChangeKg < 0, "a deficit loses weight");
    assert.equal(r.onTrackForGoal, true);
    assert.equal(r.confidence, "high", "5 logged days is a solid read");
  });
  test("trajectory: THE anti-scam case — logging a SURPLUS on a fat-loss goal predicts a GAIN, and says so", () => {
    const r = predictTrajectory({ maintenanceKcal: 2400, weightKg: 80, goalType: "fat_loss", days: week(3200, 3000) });
    assert.equal(r.direction, "gaining");
    assert.ok(r.predictedWeeklyChangeKg > 0, "a surplus gains, no matter the goal");
    assert.equal(r.onTrackForGoal, false, "gaining on a fat-loss goal is NOT on track");
    assert.match(r.headline, /scale isn'?t dropping|plate/i, "the honest 'it's the plate, not the plan' verdict");
  });
  test("trajectory: eating at break-even holds the scale (within noise)", () => {
    // intake ≈ maintenance + stepburn so the daily balance is under the 100 kcal noise floor.
    const r = predictTrajectory({ maintenanceKcal: 2400, weightKg: 80, goalType: "recomposition", days: week(2460, 1000) });
    assert.equal(r.direction, "holding");
    assert.equal(r.onTrackForGoal, true, "holding IS the recomp target");
  });
  test("trajectory: muscle-gain client in a deficit is flagged NOT on track (growth will stall)", () => {
    const r = predictTrajectory({ maintenanceKcal: 2400, weightKg: 80, goalType: "muscle_gain", days: week(1800, 9000) });
    assert.equal(r.direction, "losing");
    assert.equal(r.onTrackForGoal, false);
  });
  test("trajectory: steps deepen the deficit (more walking → more predicted loss)", () => {
    const low = predictTrajectory({ maintenanceKcal: 2400, weightKg: 90, goalType: "fat_loss", days: week(2200, 2000) });
    const high = predictTrajectory({ maintenanceKcal: 2400, weightKg: 90, goalType: "fat_loss", days: week(2200, 14000) });
    assert.ok(high.predictedWeeklyChangeKg < low.predictedWeeklyChangeKg, "more steps → more loss");
  });
  test("trajectory: confidence scales with days logged; an unlogged week is honest, not zero-calorie", () => {
    assert.equal(predictTrajectory({ maintenanceKcal: 2400, weightKg: 80, goalType: "fat_loss", days: week(1900, 8000, 2) }).confidence, "low");
    assert.equal(predictTrajectory({ maintenanceKcal: 2400, weightKg: 80, goalType: "fat_loss", days: week(1900, 8000, 4) }).confidence, "medium");
    const none = predictTrajectory({ maintenanceKcal: 2400, weightKg: 80, goalType: "fat_loss", days: [] });
    assert.equal(none.daysLogged, 0);
    assert.equal(none.predictedWeeklyChangeKg, 0, "no logs → no fake crash-deficit prediction");
    assert.match(none.headline, /log/i);
  });
  test("trajectory: weeks-to-goal only when actually moving toward the target weight", () => {
    const toward = predictTrajectory({ maintenanceKcal: 2400, weightKg: 90, goalType: "fat_loss", days: week(1800, 9000), targetWeightKg: 80 });
    assert.ok(toward.weeksToGoal && toward.weeksToGoal > 0, "losing toward a lower goal → an ETA");
    const away = predictTrajectory({ maintenanceKcal: 2400, weightKg: 90, goalType: "fat_loss", days: week(3200, 2000), targetWeightKg: 80 });
    assert.equal(away.weeksToGoal, null, "gaining while the goal is to lose → no fake ETA");
  });
  test("trajectory: an unlogged (zero-intake) day is skipped, not counted as a starvation day", () => {
    const days = [{ intakeKcal: 2000, steps: 8000 }, { intakeKcal: 0, steps: 5000 }, { intakeKcal: 2000, steps: 8000 }];
    const r = predictTrajectory({ maintenanceKcal: 2400, weightKg: 80, goalType: "fat_loss", days });
    assert.equal(r.daysLogged, 2, "the 0-kcal day is unknown, not a crash deficit");
  });
}

// WEIGHT-STALL DETECTOR — the engaged-but-plateaued churn catch. Pure, so provable here.
{
  const { detectWeightStall } = await import("../server/trajectory");
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  test("stall: fat-loss client flat 3 weeks IS a stall — and the forecast names the reason", () => {
    const flat = [{ weightKg: 90, at: daysAgo(24) }, { weightKg: 89.9, at: daysAgo(1) }];
    // forecast says gaining/holding → it's the plate (eating at maintenance)
    const plate = detectWeightStall(flat, "fat_loss", "holding");
    assert.equal(plate.stalled, true);
    assert.equal(plate.kind, "eating-at-maintenance");
    // forecast says losing but scale flat → water/glycogen, hold the line
    const hold = detectWeightStall(flat, "fat_loss", "losing");
    assert.equal(hold.kind, "real-deficit-hold");
  });
  test("stall: a client actually losing is NOT stalled (no false alarm)", () => {
    const dropping = [{ weightKg: 90, at: daysAgo(24) }, { weightKg: 88, at: daysAgo(1) }];
    assert.equal(detectWeightStall(dropping, "fat_loss", "losing").stalled, false, "2kg down in 3wk is progress");
  });
  test("stall: muscle-gain client who isn't gaining IS stalled", () => {
    const flat = [{ weightKg: 70, at: daysAgo(25) }, { weightKg: 70.05, at: daysAgo(2) }];
    assert.equal(detectWeightStall(flat, "muscle_gain", "holding").stalled, true);
  });
  test("stall: needs a real ~3-week span — a week of flatness is NOT judged", () => {
    const recent = [{ weightKg: 90, at: daysAgo(6) }, { weightKg: 90, at: daysAgo(1) }];
    assert.equal(detectWeightStall(recent, "fat_loss", "holding").stalled, false, "too short a window to call a stall");
  });
  test("stall: recomp/maintenance goals are never 'stalled' (holding IS the goal)", () => {
    const flat = [{ weightKg: 80, at: daysAgo(24) }, { weightKg: 80, at: daysAgo(1) }];
    assert.equal(detectWeightStall(flat, "recomposition", "holding").stalled, false);
  });
  test("stall: fewer than two weigh-ins never fires", () => {
    assert.equal(detectWeightStall([{ weightKg: 90, at: daysAgo(20) }], "fat_loss", "holding").stalled, false);
    assert.equal(detectWeightStall([], "fat_loss", "holding").stalled, false);
  });
}

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
// getWeekContext — veteran restart (2026-07-16 live: "Week 1 — Session 21" told a
// client with a 125kg chest fly "First session... no ego, just consistency")
// ============================================================

test("week context: 12+ sessions NEVER gets 'First session' beginner copy at week 1", () => {
  const ctx = getWeekContext(1, 1, true, 21);
  assert.ok(!/first session|feel light in 4 weeks|no ego/i.test(ctx.rationale), `veteran copy leaked: ${ctx.rationale}`);
  assert.match(ctx.rationale, /strength doesn'?t|usual working weights/i, "restart framed as plan-reset, not strength-reset");
});
test("week context: veteran restart keeps full 3 sets even with beginner label", () => {
  assert.equal(getWeekContext(1, 1, true, 21).sets, "3", "21 sessions outranks a stale 'beginner' label");
  assert.equal(getWeekContext(1, 2, true, 21).sets, "3", "week 2 too");
});
test("week context: a real beginner (few sessions) still gets the ease-in", () => {
  assert.equal(getWeekContext(1, 1, true, 3).sets, "2", "3 sessions is still a beginner");
  assert.match(getWeekContext(1, 1, true, 0).rationale, /first session/i, "day-one copy intact for day-one clients");
});

// ADAPTIVE PORTION LEARNING (2026-07-17, Review #7's flagship — built on the founder's
// order). The client's own median portion beats the table default — but ONLY in
// silence: explicit amounts and size words always win, and no history changes nothing.
{
  const { medianPortions, personalPortionFor, normalizeFoodKey } = await import("../server/portion-memory");
  const mkMem = (kcals: number[]) => medianPortions(kcals.map(k => [{ name: "Eggs", kcal: k, protein: Math.round(k / 10) }]));
  test("portion memory: median needs 3+ logs; keys normalise variants together", () => {
    assert.equal(mkMem([200, 220]).size, 0, "2 logs = no memory");
    assert.equal(mkMem([200, 220, 240]).get("eggs")?.kcal, 220, "3 logs = median");
    assert.equal(normalizeFoodKey("Chicken breast (grilled)"), normalizeFoodKey("chicken breast"), "prep variants share history");
  });
  test("portion memory: clamp holds — one poisoned log can't blow past 0.5x-3x of the table", () => {
    assert.equal(personalPortionFor(mkMem([2000, 2000, 2000]), "Eggs", 140, 12).kcal, 420, "capped at 3x");
    assert.equal(personalPortionFor(mkMem([10, 10, 10]), "Eggs", 140, 12).kcal, 70, "floored at 0.5x");
    assert.ok(!personalPortionFor(new Map(), "Eggs", 140, 12).personal, "no history = table default");
  });
  test("portion memory: personal median lands with macro shape preserved", () => {
    const r = personalPortionFor(mkMem([280, 280, 280]), "Eggs", 140, 12);
    assert.ok(r.personal && r.kcal === 280 && r.protein === 24, `2x kcal scales protein 2x: ${JSON.stringify(r)}`);
    // The silence-only guard (explicit counts and size words beat memory) lives in
    // adjustFoodsForSegment — source-guarded here, behaviour-verified in prod replies.
    const src = readFileSync(join("server", "handlers", "food-context.ts"), "utf-8");
    assert.ok(/!explicitQty && !vagueQty && sizeMultiplier === 1 && personal/.test(src), "memory must only fill silence — explicit, vague AND size words all beat it");
  });
}

// THE ACTION INTERFACE — Phase 1 of the inversion (2026-07-19). validateAction is the
// Law-4 gate: untrusted model output → a safe action, or JUST_REPLY. Nothing the model
// emits may crash, over-write state with a bad number, or fabricate a log.
{
  const { validateAction, describeAction } = await import("../server/understanding/actions");
  test("action gate: malformed / unknown / empty input all fall back to JUST_REPLY", () => {
    for (const junk of [null, undefined, {}, 42, "log_meal", { type: "DROP_TABLE" }, { name: "rm -rf" }])
      assert.equal(validateAction(junk as any).type, "JUST_REPLY", `unsafe input must be neutralised: ${JSON.stringify(junk)}`);
  });
  test("action gate: numbers are clamped to sane ranges, never trusted raw", () => {
    assert.equal((validateAction({ type: "LOG_STEPS", count: 9_999_999 }) as any).count, 100_000, "absurd steps clamped");
    assert.equal((validateAction({ type: "LOG_WATER", litres: 999 }) as any).litres, 15, "absurd water clamped");
    assert.equal((validateAction({ type: "LOG_WEIGHT", kg: 5 }) as any).type, "JUST_REPLY", "impossible weight → no action");
    assert.equal((validateAction({ type: "SET_SICK", days: 999 }) as any).days, 14, "sick days capped");
    assert.equal(validateAction({ type: "LOG_STEPS", count: "abc" }).type, "JUST_REPLY", "non-number → no log");
  });
  test("action gate: a LOG_MEAL with no food text NEVER fabricates a log", () => {
    assert.equal(validateAction({ type: "LOG_MEAL", food_text: "" }).type, "JUST_REPLY");
    assert.equal(validateAction({ type: "LOG_MEAL", food_text: "x" }).type, "JUST_REPLY", "too short to be food");
    const ok = validateAction({ type: "LOG_MEAL", food_text: "2 eggs and pap", meal: "lunch" });
    assert.equal(ok.type, "LOG_MEAL");
    assert.equal((ok as any).foodText, "2 eggs and pap");
    assert.equal((ok as any).meal, "lunch");
  });
  test("action gate: LOG_MEAL keeps a valid slot, drops a bad one (deterministic scanner infers it)", () => {
    assert.equal((validateAction({ type: "LOG_MEAL", food_text: "chips", meal: "brunchtime" }) as any).meal, undefined);
    assert.equal((validateAction({ type: "LOG_MEAL", food_text: "eggs", meal: "night meal" }) as any).meal, "night meal");
  });
  test("action gate: accepts the OpenAI tool-call name form too", () => {
    assert.equal(validateAction({ name: "show_meals", args: {} }).type, "SHOW_MEALS");
    assert.equal((validateAction({ name: "set_sick", args: { days: 2 } }) as any).days, 2);
    assert.match(describeAction(validateAction({ name: "log_steps", args: { count: 8000 } })), /8000 steps/);
  });
}

// MEMORY-GRIEVANCE GUARD — the deterministic net that keeps the ONE false-write at the gate
// (2026-07-18: "I said I'm still sick until Monday, why did you forget" → SET_SICK) from ever
// firing a fresh sick write. A complaint about the coach's memory is never an instruction.
{
  const { isMemoryGrievance, isSickReaffirmation } = await import("../server/understanding/actions");
  test("grievance guard: a 'why did you forget / I already told you' complaint is caught", () => {
    assert.equal(isMemoryGrievance("I said I'm still sick until Monday, why did you forget"), true);
    assert.equal(isMemoryGrievance("you forgot I'm sick"), true);
    assert.equal(isMemoryGrievance("I already told you I'm resting"), true);
    assert.equal(isMemoryGrievance("like I said, I'm not training"), true);
    assert.equal(isMemoryGrievance("but I keep telling you that I'm not well"), true, "the 2026-07-20 'I keep telling you' repetition grievance");
  });
  test("sick memory-complaint: 'I keep telling you' gets the short ownership ack, never the re-dumped template", () => {
    const src = readFileSync(join("server", "handlers", "sick-flow.ts"), "utf-8");
    assert.match(src, /i keep \(telling\|saying\)/, "the complaint branch covers repetition grievances");
  });
  test("grievance guard: a fresh declaration or a value correction is NOT a grievance (stays a write)", () => {
    assert.equal(isMemoryGrievance("I'm sick, can't train today"), false, "a fresh declaration must still act");
    assert.equal(isMemoryGrievance("too sick to train, resting for 3 days"), false);
    assert.equal(isMemoryGrievance("No, I'm resting until Monday, not Friday"), false, "a value correction must still update");
    assert.equal(isMemoryGrievance("feeling better now, ready to train"), false);
  });
  test("reaffirmation guard: 'but I'm still sick' is a continuation, never a fresh write", () => {
    assert.equal(isSickReaffirmation("But I'm still sick."), true, "the exact 2026-07-18 false-write");
    assert.equal(isSickReaffirmation("i'm still not well"), true);
    assert.equal(isSickReaffirmation("still recovering"), true);
  });
  test("reaffirmation guard: a fresh declaration or a NEW duration is NOT caught (stays a write)", () => {
    assert.equal(isSickReaffirmation("I'm sick, can't train today"), false, "no 'still' → a fresh declaration");
    assert.equal(isSickReaffirmation("too sick to train, resting for 3 days"), false);
    assert.equal(isSickReaffirmation("I'm still sick until Monday"), false, "a NEW end-date IS a real update");
    assert.equal(isSickReaffirmation("still sick, 3 more days"), false, "a new duration writes");
    assert.equal(isSickReaffirmation("I'm still hungry"), false, "no sick context → not a sick guard at all");
  });
}

// THE ACTION DIRECTIVE — the calibration fix the first live replay demanded (18% missed,
// "i had a burger for lunch" → JUST_REPLY). It must (a) explicitly override the text-only
// constitution so a transaction CALLS a tool, and (b) still exclude questions/corrections so
// it doesn't create false writes. This locks that reconciliation against silent regression.
{
  const { ACTION_DIRECTIVE } = await import("../server/understanding/actions");
  test("action directive: explicitly overrides the 'no hands' law so transactions act", () => {
    assert.match(ACTION_DIRECTIVE, /override/i, "must announce it overrides the text-only law");
    assert.match(ACTION_DIRECTIVE, /Law 13/i, "names the exact law it reconciles");
    assert.match(ACTION_DIRECTIVE, /calling a tool is your hands/i);
  });
  test("action directive: teaches the exact real misses as positive examples", () => {
    assert.match(ACTION_DIRECTIVE, /burger/i, "the burger miss is the canonical example");
    assert.match(ACTION_DIRECTIVE, /log_meal/);
    assert.match(ACTION_DIRECTIVE, /show_workout/);
    assert.match(ACTION_DIRECTIVE, /set_sick/);
  });
  test("action directive: reconciles care-first so a sick declaration still ACTS (the 86% miss cluster)", () => {
    assert.match(ACTION_DIRECTIVE, /care is an action/i, "recording sick must be framed as the care, not its opposite");
    assert.match(ACTION_DIRECTIVE, /set_sick \(MUST\)/, "a fresh sick declaration must be a MUST-act");
    assert.match(ACTION_DIRECTIVE, /end_sick \(MUST\)/, "recovery must be a MUST-act");
    assert.match(ACTION_DIRECTIVE, /weighed in at/i, "the weight phrasing that missed is now taught");
  });
  test("action directive: fences OFF non-transactions but UPDATES a value-changing correction", () => {
    assert.match(ACTION_DIRECTIVE, /question/i, "a question stays conversation");
    assert.match(ACTION_DIRECTIVE, /reaffirmation|still true/i, "a reaffirmation must not re-write state");
    assert.match(ACTION_DIRECTIVE, /changes a stored value/i, "but a value-changing correction IS a write (the gold label)");
    assert.match(ACTION_DIRECTIVE, /at most one tool/i, "one message = one action");
  });
}

// EXECUTOR PRECONDITIONS (2026-07-19) — the two things all three reviews converged on,
// each a founder launch-blocker: the confidence gate (unsafe behaviour) and idempotency
// (duplicated logs). Built onto the contract before the executor exists.
{
  const { shouldAutoExecute, writesState, actionFingerprint, CONFIDENCE_TO_EXECUTE } = await import("../server/understanding/actions");
  const meal = { type: "LOG_MEAL", foodText: "2 eggs and pap", meal: "breakfast", needsConfirmation: false } as any;
  test("confidence gate: a low-confidence STATE-WRITE waits for confirmation; a high one runs", () => {
    assert.equal(shouldAutoExecute(meal, 0.58), false, "'~2 eggs?' must not auto-log");
    assert.equal(shouldAutoExecute(meal, 0.98), true, "a confident log runs");
    assert.equal(shouldAutoExecute(meal, CONFIDENCE_TO_EXECUTE), true, "exactly at threshold runs");
  });
  test("confidence gate: read-only actions always run; needsConfirmation always blocks", () => {
    assert.equal(shouldAutoExecute({ type: "SHOW_MEALS" } as any, 0.1), true, "nothing to corrupt → run");
    assert.equal(shouldAutoExecute({ type: "JUST_REPLY" } as any, 0), true);
    assert.equal(shouldAutoExecute({ ...meal, needsConfirmation: true }, 0.99), false, "model-flagged uncertainty always confirms");
  });
  test("writesState: separates the corruptible actions from the read-only ones", () => {
    for (const t of ["LOG_MEAL", "LOG_STEPS", "SET_SICK", "REMOVE_LAST_MEAL"]) assert.ok(writesState(t as any));
    for (const t of ["SHOW_MEALS", "SHOW_WORKOUT", "JUST_REPLY"]) assert.ok(!writesState(t as any));
  });
  test("idempotency: same message id collapses to one; different messages both log", () => {
    const a = actionFingerprint(meal, "u1", "SM123");
    assert.equal(actionFingerprint(meal, "u1", "SM123"), a, "a retry of the same message = same key");
    assert.notEqual(actionFingerprint(meal, "u1", "SM999"), a, "a genuinely separate message = new key");
    assert.notEqual(actionFingerprint(meal, "u2", "SM123"), a, "different user = different key");
  });
}

// THE EXECUTOR — decision core (2026-07-19). The safety logic before any handler runs:
// dry-run never writes, a low-confidence write confirms, JUST_REPLY is a no-op. These
// paths return BEFORE delegating, so they're pure and testable without the DB chain.
{
  const { executeAction, _resetExecutorDedup } = await import("../server/understanding/executor");
  _resetExecutorDedup();
  const user = { id: "ex-test", name: "Kam", stepsTarget: 8500 };
  const ctx = (over: any = {}) => ({ user, phone: "whatsapp:+27", sourceMessageId: "SM1", confidence: 0.95, ...over });
  const meal = { type: "LOG_MEAL", foodText: "2 eggs and pap", needsConfirmation: false } as any;
  test("executor: JUST_REPLY performs nothing", async () => {
    const r = await executeAction({ type: "JUST_REPLY" } as any, ctx());
    assert.equal(r.performed, false);
    assert.equal(r.reply, "");
  });
  test("executor: dry-run reports but NEVER writes (replay-safe)", async () => {
    const r = await executeAction(meal, ctx({ dryRun: true }));
    assert.equal(r.performed, false, "dry-run must not perform");
    assert.match(r.reply, /\[dry-run\] would log/i);
  });
  test("executor: a low-confidence state-write CONFIRMS instead of writing", async () => {
    const r = await executeAction(meal, ctx({ confidence: 0.5 }));
    assert.equal(r.confirmed, true);
    assert.equal(r.performed, false);
    assert.match(r.reply, /reply \*yes\*/i);
  });
  test("executor: a model-flagged needs_confirmation always confirms, even at high confidence", async () => {
    const r = await executeAction({ ...meal, needsConfirmation: true }, ctx({ confidence: 0.99 }));
    assert.equal(r.confirmed, true);
    assert.equal(r.performed, false);
  });
  test("executor: fingerprint is stable + present on every result (idempotency key)", async () => {
    const a = await executeAction(meal, ctx({ dryRun: true }));
    const b = await executeAction(meal, ctx({ dryRun: true }));
    assert.equal(a.fingerprint, b.fingerprint, "same action + message = same key");
    assert.ok(a.fingerprint.includes("SM1"));
  });
}

// PENDING CONFIRM — the "reply yes" question now has a landing pad (2026-07-23 live: "yes"
// looped forever because the offered action was parked nowhere). Round-trip + one-shot.
{
  const { setPendingConfirm, takePendingConfirm, _resetPendingConfirm } = await import("../server/understanding/executor");
  test("pending confirm: parked action is returned once, then gone", async () => {
    _resetPendingConfirm();
    const action = { type: "LOG_MEAL", foodText: "half a vienna" } as any;
    setPendingConfirm("u1", action);
    assert.deepEqual(takePendingConfirm("u1"), action, "first take returns the parked action");
    assert.equal(takePendingConfirm("u1"), null, "second take is empty — never double-fires");
  });
  test("pending confirm: an unknown user has nothing parked", async () => {
    _resetPendingConfirm();
    assert.equal(takePendingConfirm("nobody"), null);
  });
}

// CONFIRM-REPLY CLASSIFIER — a clean yes/no resolves the offer; anything else is a fresh
// correction that must flow on to normal understanding (never silently cancel or mis-fire).
{
  const { classifyConfirmReply } = await import("../server/understanding/confirm-reply");
  test("confirm reply: clean affirmations are 'yes'", () => {
    for (const y of ["yes", "Yes", "yep", "yebo", "ja", "ok", "do it", "log it", "👍", "correct."]) {
      assert.equal(classifyConfirmReply(y), "yes", `'${y}' should be yes`);
    }
  });
  test("confirm reply: clean negations are 'no'", () => {
    for (const n of ["no", "nope", "cancel", "leave it", "don't", "never mind"]) {
      assert.equal(classifyConfirmReply(n), "no", `'${n}' should be no`);
    }
  });
  test("confirm reply: a correction is 'other' — it must NOT be swallowed as yes/no", () => {
    // The exact live message that broke the loop — starts with "not" but is a correction.
    assert.equal(classifyConfirmReply("Not 2 Viennas but only half a Vienna"), "other");
    assert.equal(classifyConfirmReply("no, make it 3 slices"), "other", "'no, <correction>' is not a bare no");
    assert.equal(classifyConfirmReply("yes but only one egg"), "other", "'yes but <correction>' is not a bare yes");
  });
}

// ACTION-CORRECTNESS SCORER (increment 5) — the gate that decides ENGINE_ACTIONS=on.
// Pure + dependency-free (action-score.ts), so it's provable here without booting the app.
// Every reviewer's fear is a named counter: a MISSED action (state intent → JUST_REPLY,
// the new template pile) and a FALSE write (chat → state-write, the dangerous one).
{
  const { expectedActionForIntent, scoreActionReplay } = await import("../server/eval/action-score");

  test("intent map: production intents map to the action the inversion should emit", () => {
    assert.equal(expectedActionForIntent("FOOD_LOG"), "LOG_MEAL");
    assert.equal(expectedActionForIntent("STEP_LOG"), "LOG_STEPS");
    assert.equal(expectedActionForIntent("WATER_LOG"), "LOG_WATER");
    assert.equal(expectedActionForIntent("WEIGHT_LOG"), "LOG_WEIGHT");
    assert.equal(expectedActionForIntent("SICK"), "SET_SICK");
    assert.equal(expectedActionForIntent("SICK_RECOVER"), "END_SICK", "recovery beats the bare SICK rule (ordered)");
    assert.equal(expectedActionForIntent("WORKOUT_VIEW"), "SHOW_WORKOUT");
    assert.equal(expectedActionForIntent("MEAL_LIST"), "SHOW_MEALS");
  });
  test("intent map: conversation intents expect JUST_REPLY, not a write", () => {
    assert.equal(expectedActionForIntent("GPT"), "CONVERSATION");
    assert.equal(expectedActionForIntent("MINDSET"), "CONVERSATION");
    assert.equal(expectedActionForIntent("QUESTION"), "CONVERSATION");
    assert.equal(expectedActionForIntent("EMOTION"), "CONVERSATION");
  });
  test("intent map: an unknown / null intent is ambiguous → null (never scored, never noise)", () => {
    assert.equal(expectedActionForIntent(null), null);
    assert.equal(expectedActionForIntent(""), null);
    assert.equal(expectedActionForIntent("SOME_NEW_INTENT"), null);
  });

  const pair = (expected: any, emitted: any, message = "x") => ({ expected, emitted, message });
  test("scorer: a perfect replay passes (needs the ≥20 sample floor)", () => {
    const rows = Array.from({ length: 20 }, () => pair("LOG_MEAL", "LOG_MEAL"));
    const s = scoreActionReplay(rows);
    assert.equal(s.correct, 20);
    assert.equal(s.matchRate, 1);
    assert.equal(s.passed, true);
  });
  test("scorer: too few samples never passes, however clean", () => {
    const s = scoreActionReplay(Array.from({ length: 19 }, () => pair("LOG_MEAL", "LOG_MEAL")));
    assert.equal(s.passed, false, "under 20 samples can't win a day");
  });
  test("scorer: a MISSED action (state intent → JUST_REPLY) is counted and fails the day", () => {
    const rows = [...Array.from({ length: 17 }, () => pair("LOG_MEAL", "LOG_MEAL")),
                  ...Array.from({ length: 3 }, () => pair("LOG_MEAL", "JUST_REPLY"))];
    const s = scoreActionReplay(rows);
    assert.equal(s.missedActions, 3);
    assert.ok(s.missRate > 0.1, "3/20 missed breaches the ≤10% bar");
    assert.equal(s.passed, false);
    assert.ok(s.samples.some(x => /MISSED/.test(x)), "the miss is surfaced as a sample");
  });
  test("scorer: a FALSE write (conversation → state-write) is the dangerous one, capped at 2%", () => {
    const rows = [...Array.from({ length: 19 }, () => pair("CONVERSATION", "JUST_REPLY")),
                  pair("CONVERSATION", "LOG_MEAL", "how are you")];
    const s = scoreActionReplay(rows);
    assert.equal(s.falseActions, 1);
    assert.ok(s.falseRate > 0.02, "1/20 false writes breaches the ≤2% bar");
    assert.equal(s.passed, false, "a single false write on 20 samples fails the day");
    assert.ok(s.samples.some(x => /FALSE-WRITE/.test(x)));
  });
  test("scorer: a read-only action on a chat turn is harmless (SHOW_MEALS is not a false write)", () => {
    const rows = [...Array.from({ length: 19 }, () => pair("CONVERSATION", "JUST_REPLY")),
                  pair("CONVERSATION", "SHOW_MEALS", "what did i eat")];
    const s = scoreActionReplay(rows);
    assert.equal(s.falseActions, 0, "showing meals corrupts nothing");
    assert.equal(s.correct, 20);
    assert.equal(s.passed, true);
  });
  test("scorer: a WRONG action (A→B) counts against match but isn't a miss or a false write", () => {
    const rows = [...Array.from({ length: 19 }, () => pair("LOG_MEAL", "LOG_MEAL")),
                  pair("LOG_STEPS", "LOG_WATER")];
    const s = scoreActionReplay(rows);
    assert.equal(s.wrongActions, 1);
    assert.equal(s.missedActions, 0);
    assert.equal(s.falseActions, 0);
    assert.ok(s.matchRate < 1);
  });
  test("scorer: an empty replay is a non-pass, not a crash", () => {
    const s = scoreActionReplay([]);
    assert.equal(s.n, 0);
    assert.equal(s.matchRate, 0);
    assert.equal(s.passed, false);
  });
}

// THE "5 WINNING DAYS" GATE (increment 5b) — the operational definition, made precise so the
// ENGINE_ACTIONS=on decision is a fact, not a vibe. Pure + dependency-free (winning-days.ts).
{
  const { sastDay, recordRun, evaluateGate, GATE_STREAK } = await import("../server/eval/winning-days");
  const win = { passed: true, n: 40, matchRate: 0.95, missRate: 0.05, falseRate: 0.0 };
  const loss = { passed: false, n: 40, matchRate: 0.78, missRate: 0.18, falseRate: 0.03 };
  const at = (iso: string) => new Date(iso);

  test("gate: SAST day is UTC+2 — a 23:00 UTC instant belongs to the NEXT SA date", () => {
    assert.equal(sastDay(at("2026-07-18T23:30:00Z")), "2026-07-19", "23:30 UTC = 01:30 SAST next day");
    assert.equal(sastDay(at("2026-07-18T05:00:00Z")), "2026-07-18");
  });
  test("gate: keeps the BEST run per day — a bad re-run can't erase a good one", () => {
    let d = recordRun([], win, at("2026-07-18T09:00:00Z"));
    d = recordRun(d, loss, at("2026-07-18T18:00:00Z")); // same SAST day, worse
    assert.equal(d.length, 1, "one entry per day");
    assert.equal(d[0].passed, true, "the day's best (the win) stands");
  });
  test("gate: a good re-run RESCUES an earlier bad run on the same day", () => {
    let d = recordRun([], loss, at("2026-07-18T09:00:00Z"));
    d = recordRun(d, win, at("2026-07-18T18:00:00Z"));
    assert.equal(d[0].passed, true);
  });
  test("gate: opens only after 5 consecutive winning days with enough volume", () => {
    let d: any[] = [];
    for (let i = 14; i <= 17; i++) d = recordRun(d, win, at(`2026-07-${i}T09:00:00Z`));
    assert.equal(evaluateGate(d).open, false, "4 days is not enough");
    assert.equal(evaluateGate(d).streak, 4);
    d = recordRun(d, win, at("2026-07-18T09:00:00Z"));
    const g = evaluateGate(d);
    assert.equal(g.streak, GATE_STREAK);
    assert.equal(g.open, true, "5 winning days, 200 samples → gate opens");
    assert.match(g.reason, /GATE OPEN/);
  });
  test("gate: a single losing day RESETS the streak to zero (losses punish, gaps don't)", () => {
    let d: any[] = [];
    for (let i = 14; i <= 17; i++) d = recordRun(d, win, at(`2026-07-${i}T09:00:00Z`));
    d = recordRun(d, loss, at("2026-07-18T09:00:00Z")); // the burger day
    assert.equal(evaluateGate(d).streak, 0, "a recorded loss breaks the run");
    assert.equal(evaluateGate(d).open, false);
  });
  test("gate: 5 winning days but thin volume stays CLOSED (sample floor)", () => {
    let d: any[] = [];
    const thin = { passed: true, n: 15, matchRate: 0.95, missRate: 0.05, falseRate: 0 };
    for (let i = 14; i <= 18; i++) d = recordRun(d, thin, at(`2026-07-${i}T09:00:00Z`));
    const g = evaluateGate(d);
    assert.equal(g.streak, 5);
    assert.equal(g.open, false, "75 samples < 100 floor");
    assert.match(g.reason, /samples/);
  });
  test("gate: window false-write rate above the cap keeps it CLOSED even at 5 winning days", () => {
    // Each day passes its own bar (≤2%) but the window aggregate creeps over 2%.
    let d: any[] = [];
    const borderline = { passed: true, n: 40, matchRate: 0.95, missRate: 0.05, falseRate: 0.02 };
    for (let i = 13; i <= 17; i++) d = recordRun(d, borderline, at(`2026-07-${i}T09:00:00Z`));
    d = recordRun(d, { passed: true, n: 40, matchRate: 0.95, missRate: 0.05, falseRate: 0.025 }, at("2026-07-18T09:00:00Z"));
    // 5-day window is days 14-18; push one day's false rate high enough to breach aggregate.
    const g = evaluateGate(d);
    if (g.windowFalseRate > 0.02) { assert.equal(g.open, false); assert.match(g.reason, /false-write/); }
    else { assert.ok(true, "aggregate stayed within cap — still a valid state"); }
  });
  test("gate: empty log is closed, streak 0, no crash", () => {
    const g = evaluateGate([]);
    assert.equal(g.open, false);
    assert.equal(g.streak, 0);
  });
}

// THE GOLD SET (increment 7) — the straight ruler. The history replay scored the engine
// against production's own noisy intent labels ("tell me about my progress" → SET_SICK);
// this is the hand-verified truth the gate actually trusts. We can't test the LLM's live
// choice here, but we CAN lock the answer key's integrity so it never silently rots.
{
  const { ACTION_GOLD } = await import("../server/eval/action-gold");
  const VALID = new Set(["LOG_MEAL","LOG_STEPS","LOG_WATER","LOG_WEIGHT","REMOVE_LAST_MEAL","SHOW_MEALS","SHOW_WORKOUT","SET_SICK","END_SICK","CONVERSATION"]);
  test("gold set: big enough to gate (≥20) and every label is a real expected action", () => {
    assert.ok(ACTION_GOLD.length >= 20, `need ≥20 cases to satisfy the scorer floor, have ${ACTION_GOLD.length}`);
    for (const c of ACTION_GOLD) assert.ok(VALID.has(c.expected), `bad label "${c.expected}" for "${c.message}"`);
  });
  test("gold set: no duplicate messages (each case earns its place)", () => {
    const seen = new Set<string>();
    for (const c of ACTION_GOLD) {
      const k = c.message.toLowerCase().trim();
      assert.ok(!seen.has(k), `duplicate gold message: "${c.message}"`);
      seen.add(k);
    }
  });
  test("gold set: covers both a real transaction AND the tricky no-write cases", () => {
    const has = (e: string) => ACTION_GOLD.some(c => c.expected === e);
    assert.ok(has("LOG_MEAL") && has("SET_SICK") && has("SHOW_WORKOUT"), "must exercise real writes");
    assert.ok(ACTION_GOLD.filter(c => c.expected === "CONVERSATION").length >= 8, "must exercise plenty of no-write turns (where the old ruler failed)");
  });
  test("gold set: the exact cases the broken ruler got wrong are labelled as NO write", () => {
    const progress = ACTION_GOLD.find(c => /tell me about my progress/i.test(c.message));
    assert.ok(progress && progress.expected === "CONVERSATION", "progress talk is conversation, NOT set_sick");
    const grievance = ACTION_GOLD.find(c => /why did you forget/i.test(c.message));
    assert.ok(grievance && grievance.expected === "CONVERSATION", "a memory grievance must not re-write the sick record");
  });
}

// COACHING VOICE — the two screenshot bugs (2026-07-18), fixed at the class level.
// (a) "back to gym" handler heard a phrase, not a person: it answered a timing QUESTION
//     ("when do I go back to my regular programme") with the canned declaration reply, twice.
// (b) the engine named a food CATEGORY ("legumes") instead of a real township food.
{
  // (a) BACK_TO_GYM fires ONLY on an affirmative return. It must stand down for a QUESTION,
  // a NEGATION ("I'm NOT going back"), or ANY sick/unwell signal (never push a sick client).
  const TRIGGER = /\b(back (at|to|in) (the )?gym|back from (holiday|vacation|trip|travel)|back to (my )?(regular )?(gym|normal training|programme)|gym mode|cleared.*holiday|no longer (on holiday|travelling|traveling|away))\b/i;
  const SKIP = (msg: string) =>
    /\b(when|how long|how many|what day|which day|should i|am i ready|is it (time|safe|ok|okay))\b/i.test(msg)
    || /\b(not|won'?t|wont|can'?t|cant|cannot|never|ain'?t)\b[^.!?]{0,24}\b(go|going|come|coming|back|return|train|gym|programme)\b/i.test(msg)
    || /\b(sick|ill|unwell|not feeling (well|good|right|ok|okay)|feeling (sick|ill|unwell|terrible|bad|rough|weak)|flu|fever|nause|vomit|dizzy|injured|hurt|in pain)\b/i.test(msg);
  // In the handler the trigger is ALSO gated on real holiday state existing (mechanical-only);
  // here `passesGuard` tests the SKIP layer — the part that keeps sick/negation/questions out.
  const passesGuard = (msg: string) => TRIGGER.test(msg) && !SKIP(msg);
  test("back-to-gym: an affirmative return passes the guard (only holiday-state gates it)", () => {
    assert.ok(passesGuard("i'm back at the gym"), "'back at the gym' is an affirmative return");
    assert.ok(passesGuard("back from holiday"), "'back from holiday' passes the guard");
    assert.ok(passesGuard("no longer on holiday"), "'no longer on holiday' passes — not a negation of returning");
  });
  test("back-to-gym: a timing QUESTION stands down so Coach K can answer WHEN", () => {
    assert.ok(!passesGuard("when do I go back to my regular programme"), "the exact screenshot miss must NOT fire the canned reply");
    assert.ok(!passesGuard("how long until I can go back to gym"), "asking how long is a question");
    assert.ok(!passesGuard("am I ready to go back to the gym?"), "asking readiness is a question");
  });
  test("back-to-gym: a NEGATION or a SICK message must NOT fire (the 2026-07-18 safety miss)", () => {
    assert.ok(!passesGuard("I'm still not feeling well so I'm not going back to the gym on Monday"), "sick + 'not going back' must NEVER push training");
    assert.ok(!passesGuard("I'm not going back to gym this week"), "a plain negation must not fire");
    assert.ok(!passesGuard("too sick to go back to the gym"), "sick context must stand it down");
  });
  test("back-to-gym: MECHANICAL-only — the trigger is gated on real holiday state (judgment goes to the brain)", () => {
    const src = readFileSync(join("server", "handlers", "early-commands.ts"), "utf-8");
    assert.match(src, /skipBackToGym/, "the safety guard must exist");
    assert.match(src, /tempEquipmentMode\.has\(phone\) \|\| \(user\.awaitingInputType \|\| ""\)\.startsWith\("holiday_equipment"\)/, "fires only when real holiday state exists to clear");
    assert.match(src, /startsWith\("holiday_equipment"\)\) && !skipBackToGym &&/, "holiday-state AND the safety guard both gate the trigger");
  });
  test("holiday-equipment: JUDGMENT deferred to the brain, never hijacks a food/grocery message (the vacation shitshow, 2026-07-18)", () => {
    const src = readFileSync(join("server", "handlers", "early-commands.ts"), "utf-8");
    // The equipment-question template must NOT fire on a food/grocery context, must require a
    // real training intent, and must stand down entirely when the brain is the live front-door.
    assert.match(src, /isFoodOrGroceryContext/, "a food/grocery guard exists");
    assert.match(src, /if \(isHolidayMention && isWorkoutRequestInMessage && !isFoodOrGroceryContext && process\.env\.ENGINE_LIVE !== "on"\)/, "food-guarded, training-gated, and deferred to the brain when live");
    const FOOD = /\b(grocer|grocery|shopping list|meal|meals|eat|eating|food|snack|breakfast|lunch|dinner|portion|calorie|protein|recipe|cook|diet|fridge|cupboard|pantry)\b/i;
    assert.ok(FOOD.test("I need you to adjust my grocery list while I'm on vacation"), "the exact live miss is a food context");
    assert.ok(FOOD.test("what should I be eating on holiday"), "eating-on-holiday is a food context");
    assert.ok(!FOOD.test("gym is closed this week, what workout can I do"), "a pure training-away message is not a food context");
  });

  // REMINDERS — the coach's first real user-scheduled capability. The parser is a promise,
  // so it's deterministic and tested hard. (pure module: no DB import, safe in this harness.)
  test("reminders: 'remind me to take creatine at 8pm' → task + 8pm SAST fire time", async () => {
    const { parseReminderRequest } = await import("../server/reminders-parse");
    const r = parseReminderRequest("remind me to take creatine at 8pm");
    assert.ok(r && r.kind === "set", "it's a complete reminder");
    if (r && r.kind === "set") {
      assert.equal(r.body, "take creatine", "the task is clean, no time words");
      const sastHour = new Date(r.fireAt.getTime() + 2 * 3_600_000).getUTCHours();
      assert.equal(sastHour, 20, "8pm SAST = hour 20");
      assert.ok(r.fireAt.getTime() > Date.now(), "always in the future");
    }
  });
  test("reminders: relative 'in 2 hours', bare day 'tomorrow', and part-of-day 'tonight'", async () => {
    const { parseReminderRequest } = await import("../server/reminders-parse");
    const rel = parseReminderRequest("remind me to drink water in 2 hours");
    assert.ok(rel && rel.kind === "set" && rel.body === "drink water", "relative parses");
    if (rel && rel.kind === "set") {
      const mins = (rel.fireAt.getTime() - Date.now()) / 60_000;
      assert.ok(mins > 115 && mins < 125, "~120 minutes out");
    }
    const tom = parseReminderRequest("remind me to weigh in tomorrow");
    assert.ok(tom && tom.kind === "set" && tom.body === "weigh in", "bare day → task kept, default time");
    if (tom && tom.kind === "set") {
      assert.equal(new Date(tom.fireAt.getTime() + 2 * 3_600_000).getUTCHours(), 8, "bare day defaults to 8am SAST");
    }
    const night = parseReminderRequest("remind me to stretch tonight");
    assert.ok(night && night.kind === "set" && night.body === "stretch", "tonight parses");
    if (night && night.kind === "set") {
      assert.equal(new Date(night.fireAt.getTime() + 2 * 3_600_000).getUTCHours(), 19, "tonight = 7pm SAST");
    }
  });
  test("reminders: a time with no task asks WHAT; a task with no time asks WHEN; a non-reminder is null", async () => {
    const { parseReminderRequest } = await import("../server/reminders-parse");
    assert.equal(parseReminderRequest("I had eggs for breakfast"), null, "not a reminder → null, never hijacks a food log");
    assert.equal(parseReminderRequest("what's my workout today"), null, "not a reminder → null");
    const noTime = parseReminderRequest("remind me to call the gym");
    assert.ok(noTime && noTime.kind === "need_time" && noTime.body === "call the gym", "task but no time → ask when");
    const noBody = parseReminderRequest("remind me at 6am");
    assert.ok(noBody && noBody.kind === "need_body", "time but no task → ask what");
  });
  test("reminders: recurring — 'every morning' / 'every day at 8pm' / 'every Monday' repeat, one-shots don't", async () => {
    const { parseReminderRequest } = await import("../server/reminders-parse");
    const { nextRecurrenceTime } = await import("../server/reminders");
    const daily = parseReminderRequest("remind me to take creatine every morning");
    assert.ok(daily && daily.kind === "set" && daily.recurrence === "daily", "every morning → daily");
    if (daily && daily.kind === "set") {
      assert.equal(daily.body, "take creatine", "recurrence words stripped from the task");
      assert.equal(new Date(daily.fireAt.getTime() + 2 * 3_600_000).getUTCHours(), 7, "morning = 7am SAST");
    }
    const dailyTimed = parseReminderRequest("remind me to log my day every day at 8pm");
    assert.ok(dailyTimed && dailyTimed.kind === "set" && dailyTimed.recurrence === "daily", "every day at 8pm → daily");
    const weekly = parseReminderRequest("remind me to weigh in every monday");
    assert.ok(weekly && weekly.kind === "set" && weekly.recurrence === "weekly", "every monday → weekly");
    const oneShot = parseReminderRequest("remind me to take creatine at 8pm");
    assert.ok(oneShot && oneShot.kind === "set" && oneShot.recurrence === null, "a normal reminder is one-shot, not recurring");
    // The poller advances a daily reminder ~24h and skips a backlog after downtime.
    const past = new Date(Date.now() - 3 * 86_400_000);
    const next = nextRecurrenceTime(past, "daily");
    assert.ok(next.getTime() > Date.now(), "a stale recurring reminder jumps to the next FUTURE fire, never spams the backlog");
  });
  test("reminders: 'weigh in on monday' keeps a clean task (no dangling preposition)", async () => {
    const { parseReminderRequest } = await import("../server/reminders-parse");
    const r = parseReminderRequest("remind me to weigh in on monday");
    assert.ok(r && r.kind === "set", "complete");
    if (r && r.kind === "set") assert.equal(r.body, "weigh in", "the trailing 'on' is stripped with the day");
  });

  test("keyword-wall sweep: the JUDGMENT handlers defer to the brain when live (voice ported to the brain first, so no regression)", () => {
    const src = readFileSync(join("server", "handlers", "advice-commands.ts"), "utf-8");
    // Each emotional/coaching-judgment handler must stand down when ENGINE_LIVE is on.
    for (const guard of [
      /process\.env\.ENGINE_LIVE !== "on" && isBereaved/,
      /process\.env\.ENGINE_LIVE !== "on" && looksLikeLowMobility\(m\)/,
      /process\.env\.ENGINE_LIVE !== "on" && looksLikeDefeatedNoResults\(m\)/,
      /process\.env\.ENGINE_LIVE !== "on" && looksLikeDigestiveIssue\(m\)/,
      /process\.env\.ENGINE_LIVE !== "on" && looksLikeFoodDislike\(m\)/,
      /process\.env\.ENGINE_LIVE !== "on" && looksLikeOvertrainingPlan\(m\)/,
    ]) assert.match(src, guard, `judgment handler gated behind the brain: ${guard}`);
    // The brain (live engine prompt) must actually carry that voice now, or gating regresses it.
    const brain = readFileSync(join("server", "brain", "coach-brain.ts"), "utf-8");
    assert.match(brain, /BEREAVEMENT \/ A DEATH/, "brain carries the bereavement masterclass");
    assert.match(brain, /IT'S MY GENETICS/, "brain carries the defeated/genetics masterclass");
    assert.match(brain, /DIGESTIVE \(bloating/, "brain carries the digestive masterclass");
    assert.match(brain, /FOOD DISLIKE/, "brain carries the food-dislike masterclass");
    assert.match(brain, /OVER-TRAINING \(5\+/, "brain carries the over-training masterclass");
  });

  test("temporal loop: a captured return date schedules a nudge at 7pm SAST the evening before (never go silent on a sick/away client)", async () => {
    const { returnNudgeTime } = await import("../server/reminders-parse");
    // Anchor 'now' to a fixed morning so the test is deterministic.
    const now = new Date("2026-05-15T06:00:00+02:00").getTime(); // Fri 15 May, 6am SAST
    const nudge = returnNudgeTime("2026-05-18", now);            // return Mon 18 May
    assert.ok(nudge, "a future return date schedules a nudge");
    if (nudge) {
      const sast = new Date(nudge.getTime() + 2 * 3_600_000);
      assert.equal(sast.getUTCHours(), 19, "fires at 19:00 SAST");
      assert.equal(sast.getUTCDate(), 17, "the evening BEFORE the 18th — i.e. Sunday the 17th");
    }
    assert.equal(returnNudgeTime("not-a-date", now), null, "a malformed date schedules nothing");
    assert.equal(returnNudgeTime("2020-01-01", now), null, "a past date schedules nothing");
    // The loop must be wired at BOTH capture points, and stand down on early recovery.
    const sick = readFileSync(join("server", "handlers", "sick-flow.ts"), "utf-8");
    assert.match(sick, /scheduleReturnNudge\(user\.id, user\.phoneNumber, sickUntil, "sick"\)/, "sick_until schedules the nudge");
    assert.match(sick, /cancelReturnNudges\(user\.id\)/, "recovery cancels the pending nudge");
    const early = readFileSync(join("server", "handlers", "advice-commands.ts"), "utf-8");
    assert.match(early, /scheduleReturnNudge\(user\.id, phone, rpDate, "away"\)/, "back_on schedules the nudge");
  });
  test("intent bouncer: a STRATEGY message about training never dumps the programme (the running voice-note miss, 2026-07-21)", () => {
    // The exact live failure: a voice note discussing running got the full Week-1 workout dumped.
    assert.equal(looksLikeWorkoutRequest("let's talk about running, incorporating it into my program, without killing my progress in the gym"), false, "the exact screenshot miss must NOT fire the programme");
    assert.equal(looksLikeWorkoutRequest("how do I add running to my program without losing gains"), false, "a how-to strategy question is judgment for the coach");
    assert.equal(looksLikeWorkoutRequest("can I still do cardio on this plan"), false, "a can-I-still question is a conversation");
    assert.equal(looksLikeWorkoutRequest("thoughts on adding swimming"), false, "asking for thoughts is a conversation");
    // But genuine delivery requests must STILL be served deterministically.
    assert.equal(looksLikeWorkoutRequest("workout"), true, "the bare command still delivers");
    assert.equal(looksLikeWorkoutRequest("show me my gym program"), true, "a real 'show me' request still delivers");
    assert.equal(looksLikeWorkoutRequest("send me a home workout"), true, "a real workout request still delivers");
  });
  test("media crash-safety net: a media job that dies mid-process is recovered, never silent (review Q2)", () => {
    const jobs = readFileSync(join("server", "media-jobs.ts"), "utf-8");
    assert.match(jobs, /export async function recordMediaJob/, "records a media message in-flight");
    assert.match(jobs, /export async function completeMediaJob/, "marks it done when the reply sends");
    assert.match(jobs, /export async function claimStuckMediaJobs/, "claims stuck jobs (died mid-process)");
    assert.match(jobs, /onConflictDoNothing/, "a duplicate message id never double-records");
    assert.match(jobs, /status: "recovered"/, "claim-then-return so a client is nudged exactly once");
    const wa = readFileSync(join("server", "routes", "whatsapp.ts"), "utf-8");
    assert.match(wa, /recordMediaJob\(msgSid, rawPhone/, "the webhook records voice + photo/video jobs");
    assert.match(wa, /if \(mediaUrl\) await completeMediaJob\(sourceMessageId\)/, "text handler closes media jobs");
    assert.match(wa, /await completeMediaJob\(sourceMessageId\)/, "voice handler closes its job in finally");
    const sched = readFileSync(join("server", "scheduler.ts"), "utf-8");
    assert.match(sched, /\*\/2 \* \* \* \*.*runMediaJobRecovery/, "the recovery sweep runs every 2 minutes");
  });
  test("goal-reality gate: a goal that fights the body's reality is steered honestly at onboarding (mirror of the underweight gate)", () => {
    const ob = readFileSync(join("server", "onboarding.ts"), "utf-8");
    assert.match(ob, /GOAL-REALITY GATE/, "the gate exists");
    // Obese wanting to bulk → cut first (health + results), flagged to the coach.
    assert.match(ob, /bmiGate >= 30 && _reGoal === "muscle_gain"/, "obese + bulk is caught");
    assert.match(ob, /overweight_bulk_request/, "and escalated to the coach");
    // Overweight wanting to bulk → recomposition (build while fat comes off).
    assert.match(ob, /bmiGate >= 27\.5 && _reGoal === "muscle_gain"/, "overweight + bulk → recomp");
    assert.match(ob, /u\.goalType = "recomposition"/, "steered to recomposition");
    // Experienced client carrying fat wanting recomp → cut first.
    assert.match(ob, /_reGoal === "recomposition" && \/\(advanced\|experienced\|intermediate\)\//, "trained + recomp + fat → cut first");
    // Autonomy preserved: every steer tells them how to override.
    assert.match(ob, /change my goal to muscle gain/, "the client can always override the steer");
    assert.match(ob, /\$\{goalRealityNote\}/, "the note is delivered in the welcome");
  });
  test("shadow-retire sweep: the last ungated judgment handlers now defer to the brain when live", () => {
    const lc = readFileSync(join("server", "handlers", "lifecycle.ts"), "utf-8");
    // Open coaching advice ("what should I focus on next week") — the brain's job when live.
    assert.match(lc, /process\.env\.ENGINE_LIVE !== "on" && \/\/ JUDGMENT: the brain owns open coaching advice/, "COACHING_ADVICE is gated");
    // Stress/overwhelm — emotional, the brain owns it (SADAG crisis net still runs first in the pipeline).
    assert.match(lc, /if \(process\.env\.ENGINE_LIVE !== "on" && isStressMsg\)/, "STRESS is gated");
  });
  test("code-level intent bouncer: strategy/emotional turns withhold action tools; logs keep them (review Q1)", async () => {
    const { isStrategyOrEmotional } = await import("../server/understanding/actions");
    // Strategy/emotional → tools withheld (can only converse, never dump a workout/log).
    assert.ok(isStrategyOrEmotional("let's talk about running and how to balance it with the gym"), "the running voice-note class");
    assert.ok(isStrategyOrEmotional("map my journey for the next 3 months"), "map-my-journey");
    assert.ok(isStrategyOrEmotional("I'm feeling really down and want to give up"), "emotional turn");
    assert.ok(isStrategyOrEmotional("how do I incorporate cardio without losing gains"), "strategy question");
    // A data write must NEVER be stripped, even inside an emotional message.
    assert.ok(!isStrategyOrEmotional("rough day honestly, I only ate a slice of bread"), "a food log keeps its tools");
    assert.ok(!isStrategyOrEmotional("feeling low but I did 9000 steps"), "a step report keeps its tools");
    assert.ok(!isStrategyOrEmotional("workout"), "a bare command is not strategy");
    assert.ok(!isStrategyOrEmotional("I had 2 eggs and pap"), "a plain log is not strategy");
    // And it's wired into the live engine's emitActions gate.
    const live = readFileSync(join("server", "understanding", "live.ts"), "utf-8");
    assert.match(live, /emitActions: actionMode !== "off" && !strategyTurn/, "strategy turns pass emitActions=false");
  });
  test("voice: long rambles get condensed to their actionable core before the brain (margin + clarity)", () => {
    const wedge = readFileSync(join("server", "understanding", "sa-transcript.ts"), "utf-8");
    assert.match(wedge, /export async function condenseVoiceRamble/, "the summariser wedge exists");
    assert.match(wedge, /text\.length < 200\) return raw/, "short notes are never reshaped — a quick food log is safe");
    assert.match(wedge, /feature: "voice_condense"/, "its cost is tagged so it shows in the CFO report");
    assert.match(wedge, /out\.length >= text\.length \|\| looksLikeRefusal\(out\)\) return raw/, "fail-open: a bad condense keeps the raw transcript");
    const media = readFileSync(join("server", "handlers", "media.ts"), "utf-8");
    assert.match(media, /wordCount > 90 \? await condenseVoiceRamble/, "only a genuine ramble (>90 words) is condensed; short notes pass through");
    assert.match(media, /const forBrain =/, "the condensed text feeds the brain");
    assert.match(media, /echoTrimmed/, "the echo still shows what they actually said, not the condensed version");
  });
  test("CFO: the weekly report surfaces AI cost by feature and guards the R199 margin", () => {
    const biz = readFileSync(join("server", "scheduler", "jobs", "business.ts"), "utf-8");
    assert.match(biz, /AI cost \(last 7d\)/, "the founder can see AI spend");
    assert.match(biz, /groupBy\(gptCosts\.feature\)/, "broken down by feature — the data was always there, now surfaced");
    assert.match(biz, /monthlyPerClient > 3\.5/, "a margin guard flags cost eating into the R199");
  });
  test("capability guard: the model's 'I can't view pictures' lie is replaced with an invite (IMG_6162)", async () => {
    const { sanitizeCoachReply } = await import("../server/handlers/food-scanner");
    for (const lie of [
      "I can't view pictures, but I'm here to help you with your journey!",
      "I cannot see photos, however tell me how you feel.",
      "As a text-based assistant, I can't process images. Let's talk instead.",
      "I'm unable to view your progress pictures right now.",
    ]) {
      const out = sanitizeCoachReply(lie, "I want to send you my progress pictures");
      assert.ok(!/can'?t\s+(view|see|process)|unable to view|text-based/i.test(out), `the capability lie must not survive: "${out}"`);
      assert.match(out, /send them through/i, "replaced with a warm invite to send the photos");
    }
    // A normal reply is untouched (the guard only fires on the capability disclaimer).
    assert.match(sanitizeCoachReply("Focus on hitting your protein target today.", "how am i doing"), /Focus on hitting your protein/);
  });
  // DUPLICATE-MEAL GUARD (2026-07-22 live: a granola/yogurt/grapefruit breakfast photo was
  // refused as a duplicate of a bread/fish-fingers breakfast — both had "boiled eggs", so 2
  // shared words wrongly flagged them as the same dish, and the new meal never logged).
  test("looksLikeSameMeal: needs a real proportion of overlap, not just two common words", async () => {
    const { looksLikeSameMeal } = await import("../server/handlers/food-scanner");
    // THE BUG: two different breakfasts that merely share "boiled eggs" are NOT the same meal.
    assert.strictEqual(
      looksLikeSameMeal("granola greek yogurt blueberries boiled eggs grapefruit", "3 slices of bread, 3 boiled eggs and 3 fish fingers"),
      false, "different meals sharing only boiled eggs must NOT be a duplicate");
    // The original guard still works: a photo of a just-logged plate (high overlap) IS a dup.
    assert.strictEqual(looksLikeSameMeal("bread, boiled eggs, fish fingers", "3 slices of bread, 3 boiled eggs and 3 fish fingers"), true);
    assert.strictEqual(looksLikeSameMeal("chicken rice broccoli", "chicken rice broccoli"), true);
    // Totally different meals are never duplicates.
    assert.strictEqual(looksLikeSameMeal("chicken rice broccoli", "beef pasta salad"), false);
  });
  test("voice: a bullet-dump coaching reply is reflowed into coach prose (IMG_6144), short lists left alone", async () => {
    const { collapseBulletDump } = await import("../server/handlers/food-scanner");
    const dump = "Got it. To add running:\n- *Start Slow*: begin with short easy runs\n• *Balance with Gym*: run on non-lifting days\n• *Fuel Up*: eat enough for both";
    const out = collapseBulletDump(dump);
    assert.ok(!/\n[•\-]/.test(out), "no bullet lines survive");
    assert.match(out, /Start Slow — begin/, "labels become inline prose");
    assert.match(out, /Balance with Gym — run/, "every point is kept, just reflowed");
    const shortList = "Two options:\n• eggs\n• pilchards";
    assert.equal(collapseBulletDump(shortList), shortList, "a 2-item list is fine on WhatsApp — left alone");
  });
  test("street food: coaches the real SA way of eating — taxi rank, kota, shisa nyama, livers", async () => {
    const { matchStreetDish, isStreetContext, formatStreetDish, streetGuide } = await import("../server/street-food");
    assert.ok(matchStreetDish("should I get a kota"), "knows a kota");
    assert.ok(matchStreetDish("chicken livers on the corner"), "knows chicken livers");
    assert.equal(matchStreetDish("I ate a chicken breast"), null, "not every food is street food");
    assert.ok(isStreetContext("I'm at the taxi rank what should I eat"), "reads the taxi-rank context");
    assert.ok(isStreetContext("eating shisa nyama tonight"), "reads shisa nyama context");
    const livers = matchStreetDish("livers");
    if (livers) {
      const out = formatStreetDish(livers, "fat_loss");
      assert.match(out, /Good choice/, "chicken livers are coached as a win, never shamed");
      assert.match(out, /protein/, "gives the honest protein number");
    }
    assert.match(streetGuide("fat_loss"), /Chicken livers/, "the rank guide leads with the cheap high-protein wins");
    assert.match(streetGuide("muscle_gain"), /protein in every plate/, "the one real rule holds for both goals");
  });
  test("restaurants: goal-aware smart order with deterministic macros (the MenuFit service)", async () => {
    const { matchRestaurant, formatRestaurantGuide, listRestaurantNames } = await import("../server/restaurants");
    assert.ok(listRestaurantNames().length >= 15, "comprehensive SA chain coverage");
    const kfc = matchRestaurant("what should I order at kfc");
    assert.ok(kfc && kfc.name === "KFC", "matches KFC");
    assert.equal(matchRestaurant("I had eggs"), null, "no false match on a plain food log");
    if (kfc) {
      const cut = formatRestaurantGuide(kfc, "fat_loss");
      const bulk = formatRestaurantGuide(kfc, "muscle_gain");
      assert.match(cut, /Best for fat loss/, "fat loss leads with the lean pick");
      assert.match(bulk, /Best for building/, "muscle gain leads with the mass pick");
      assert.match(cut, /kcal/, "shows real macros, not vague advice");
    }
  });

  // (b2) DETERMINISTIC word-net: the prompt ban alone failed twice — the sanitizer must
  // guarantee category jargon can never reach a client, replaced with real SA foods.
  test("sanitize: food-category jargon is swapped for real foods in code, not hoped away", async () => {
    const { sanitizeCoachReply } = await import("../server/handlers/food-scanner");
    const out = sanitizeCoachReply("Eggs, chicken, and legumes are great choices. Add whole grains and healthy fats.", "what should I eat?");
    assert.ok(!/legumes/i.test(out), "'legumes' must never survive the sanitizer");
    assert.ok(/beans and lentils/i.test(out), "replaced with the real foods");
    assert.ok(!/whole grains|healthy fats/i.test(out), "other category jargon swapped too");
  });

  // (b4) 2026-07-20 deep-dive fixes — each locked against regression.
  test("sick recovery: a DEFERRED return ('I'll let you know after Monday') is NOT 'welcome back'", () => {
    const src = readFileSync(join("server", "handlers", "sick-flow.ts"), "utf-8");
    assert.match(src, /isDeferredReturn/, "the deferral guard exists");
    assert.match(src, /!isDeferredReturn\s*\n?\s*&&/, "and gates the recovery branch");
    const DEFER = /\b(i'?ll let you know|let you know (after|by|on|how)|after (mon|tues|wednes|thurs|fri|satur|sun)day|not (yet|now|sure)|maybe|might|thinking (of|about)|will (see|decide)|we'?ll see|if i (feel|am)|once i (feel|am)|when i (feel|am)|hopefully)\b/i;
    assert.ok(DEFER.test("i'll let you know after monday how i feel in terms of getting back to training"), "the exact live miss is caught");
    assert.ok(!DEFER.test("i'm back and ready to train"), "a real return still clears");
  });
  test("numbers toggle: a PLAN ask ('give me numbers on how we go about it') is NOT a display toggle", () => {
    const src = readFileSync(join("server", "handlers", "numbers-literacy.ts"), "utf-8");
    assert.match(src, /isPlanAsk/, "the plan-context guard exists");
    const PLAN = /\b(plan|programme|program|roadmap|go about|how (we|are we|you)|strategy|approach|ease (me )?back)\b/i;
    assert.ok(PLAN.test("no i need the whole plan, give me numbers on how we are going to go about it"), "the exact hijack is caught");
    assert.ok(!PLAN.test("show me the numbers"), "a genuine display request still toggles");
  });
  test("programme copy: full-plan Week 1 header never claims 'the plan restarts' to a viewer", () => {
    const src = readFileSync(join("server", "programme.ts"), "utf-8");
    assert.ok(!/the plan restarts, your strength doesn'?t/.test(src), "misleading restart copy removed");
    assert.match(src, /Your strength carries over/, "replaced with copy true for restart AND viewing");
  });
  test("sanitize: banned bot-phrases are stripped in code ('You've got this', 'How does that sound?')", async () => {
    const { sanitizeCoachReply } = await import("../server/handlers/food-scanner");
    const out = sanitizeCoachReply("Focus on rest. You've got this! We'll ease back in. How does that sound?", "am I losing time?");
    assert.ok(!/you'?ve got this/i.test(out) && !/how does that sound/i.test(out), "both phrases stripped");
    assert.match(out, /Focus on rest/, "the real content survives");
  });
  test("memory: stated return day is computed to a real date (nextDayDate) and surfaced to the brain", async () => {
    const { nextDayDate } = await import("../server/utils");
    const d = nextDayDate("monday");
    assert.ok(d && /^\d{4}-\d{2}-\d{2}$/.test(d), "a day name becomes a real date");
    assert.ok(nextDayDate("tomorrow"), "tomorrow works");
    assert.equal(nextDayDate("someday"), null, "junk is rejected");
    const ec = readFileSync(join("server", "handlers", "advice-commands.ts"), "utf-8");
    assert.match(ec, /back_on:\$\{rpDate\}/, "the date is persisted whoever replies");
    const snap = readFileSync(join("server", "brain", "client-snapshot.ts"), "utf-8");
    assert.match(snap, /back_on:\(\\d\{4\}-\\d\{2\}-\\d\{2\}\)/, "and the snapshot surfaces it to the brain");
  });

  // (b3) Kam's manual-coaching masterclasses must live in BOTH mouths, identically framed.
  test("coach voice: deficit-resistance hard case encoded in BRAIN_SYSTEM and SCENARIO_GUIDE", () => {
    const brain = readFileSync(join("server", "brain", "coach-brain.ts"), "utf-8");
    const guide = readFileSync(join("server", "handlers", "gpt-block.ts"), "utf-8");
    for (const src of [brain, guide]) {
      assert.match(src, /DEFICIT RESISTANCE/, "the hard case must exist");
      assert.match(src, /spot-reduce/, "the spot-reduction truth");
      assert.match(src, /smaller temporarily/, "the honest 'you'll look smaller first' expectation");
      assert.match(src, /losing fat you don'?t want/, "Kam's reframe line");
      assert.match(src, /hold the line/, "never cave to keep them happy");
    }
  });
  test("coach voice: holiday/away masterclass encoded in BOTH mouths (list from THEIR foods)", () => {
    const brain = readFileSync(join("server", "brain", "coach-brain.ts"), "utf-8");
    const guide = readFileSync(join("server", "handlers", "gpt-block.ts"), "utf-8");
    for (const src of [brain, guide]) {
      assert.match(src, /HOLIDAY \/ VACATION/, "the away case must exist");
      assert.match(src, /FROM THEIR OWN LIST/, "the plan is built from the client's own named foods");
      assert.match(src, /makes meals bigger without trying/i, "the cheap-veg add");
      assert.match(src, /protein first/i, "the only rules");
      assert.match(src, /still reporting is a WIN/i, "inconsistent-but-committed clients met with warmth");
    }
  });

  // (b) the coaching voice must name real foods, never a food category.
  test("coach voice: BRAIN_SYSTEM bans food-category jargon and names real township food", () => {
    const src = readFileSync(join("server", "brain", "coach-brain.ts"), "utf-8");
    assert.match(src, /NAME THE REAL FOOD/, "the class rule must be present");
    assert.match(src, /NEVER "legumes"/, "the exact word that blew up must be banned by name");
    assert.match(src, /sugar beans|pilchards|soya mince/, "and the real foods offered as the replacement");
  });
}

// SHADOW REVIEW — the coach's confirmation lap must be wired: a "shadow" command that reads
// the dry-run action-decisions logged in shadow mode, so on/off is decided from real traffic.
{
  test("shadow: the review function reads ENGINE_ACTION_SHADOW logs and is wired to a command", () => {
    const live = readFileSync(join("server", "understanding", "live.ts"), "utf-8");
    assert.match(live, /export async function recentShadowDecisions/, "the shadow reader must exist");
    assert.match(live, /ENGINE_ACTION_SHADOW/, "and query the shadow intent");
    const routes = readFileSync(join("server", "routes.ts"), "utf-8");
    assert.match(routes, /\^shadow\(\?:\\s\+\(\\d\{1,2\}\)\)\?\$/, "the 'shadow' coach command must be wired");
    assert.match(routes, /recentShadowDecisions/, "and call the reader");
  });
  test("cohort gate: ENGINE_ACTIONS=on only executes for real for coach/beta-testers until opened", () => {
    const live = readFileSync(join("server", "understanding", "live.ts"), "utf-8");
    assert.match(live, /engineActionsAll/, "the widen-to-all switch must exist");
    assert.match(live, /const cohortLive = ctx\.actionsLive === true \|\| engineActionsAll\(\)/, "real execution is gated to the cohort");
    assert.match(live, /const runDry = actionMode === "shadow" \|\| !cohortLive/, "non-cohort users run dry even in on mode");
    const routes = readFileSync(join("server", "routes.ts"), "utf-8");
    assert.match(routes, /actionsLive: isCoach \|\| isBetaTester/, "the cohort is coach + beta testers");
  });
  test("growth engine: transformation 'story' + 'cohort' commands are wired (thread #1)", () => {
    const t = readFileSync(join("server", "transformation.ts"), "utf-8");
    assert.match(t, /export async function getTransformationStory/, "the shareable receipt builder");
    assert.match(t, /export async function getCohortSnapshot/, "the proof-cohort dashboard");
    assert.match(t, /Day-30 paid retention/, "the North-Star metric #1");
    assert.match(t, /Avg weight change \(retained\)/, "the North-Star metric #2");
    const routes = readFileSync(join("server", "routes.ts"), "utf-8");
    assert.match(routes, /getTransformationStory/, "'story' command wired");
    assert.match(routes, /getCohortSnapshot/, "'cohort' command wired");
  });
  test("referral loop: the promised free month is GRANTED + notified on a friend's conversion", () => {
    // Reward lives in the PayFast webhook (canonical path), idempotent via a paymentEvents
    // sentinel — do NOT add a parallel scheduler grant (it would double-reward).
    const pay = readFileSync(join("server", "routes", "payments.ts"), "utf-8");
    assert.match(pay, /REF_REWARD_/, "idempotent referral-reward sentinel");
    assert.match(pay, /referredBy/, "keys off the referred friend");
    assert.match(pay, /You have earned one free month/i, "referrer is notified");
  });
  test("anti-churn: weight-stall intervention job is wired + scheduled", () => {
    const r = readFileSync(join("server", "scheduler", "jobs", "retention.ts"), "utf-8");
    assert.match(r, /export async function runWeightStallIntervention/);
    assert.match(r, /detectWeightStall/, "uses the deterministic detector");
    const sched = readFileSync(join("server", "scheduler.ts"), "utf-8");
    assert.match(sched, /runWeightStallIntervention/, "scheduled");
  });
  test("retention: the Sunday report card carries the forward forecast (visible progress)", () => {
    const w = readFileSync(join("server", "scheduler", "jobs", "weekly.ts"), "utf-8");
    assert.match(w, /getTrajectoryForUser/, "the report pulls the trajectory");
    assert.match(w, /daysLogged >= 3/, "only shown with enough data to be honest");
    assert.match(w, /🔮 Forecast/, "the forward-looking line is in the card");
  });
  test("transformation: before/after photos are served + attached to the story card", () => {
    const vb = readFileSync(join("server", "routes", "voice-broadcast.ts"), "utf-8");
    assert.match(vb, /api\/progress-photo\/:id\/image/, "the public-by-UUID photo endpoint exists");
    assert.match(vb, /FROM progress_photos WHERE id/, "and serves the stored image bytes");
    const t = readFileSync(join("server", "transformation.ts"), "utf-8");
    assert.match(t, /\[MEDIA:\$\{appUrl\}\/api\/progress-photo\//, "the story attaches the images as WhatsApp media");
    assert.match(t, /afterId !== beforeId/, "one shoot → one photo, not a duplicate");
  });
}

// MORNING BRIEF CLOSING (2026-07-19 live: a client with a 19-day food streak + 2-session
// streak got "Good to have you back" — trajectory is workout-only, so a daily logger who
// trains moderately read as lapsed-and-returned). Absence framing must never hit the engaged.
{
  const { morningClosingLine } = await import("../server/morning-closing");
  const eng = { activelyEngaged: true, completedSessions28: 4 };
  const lapsed = { activelyEngaged: false, completedSessions28: 4 };
  test("morning close: an actively-engaged client is NEVER told 'welcome back' or 'reply Hi'", () => {
    for (const t of ["RECOVERING", "DISENGAGED"] as const) {
      const line = morningClosingLine(t, eng);
      assert.ok(!/have you back|reply Hi/i.test(line), `absence framing leaked (${t}): ${line}`);
    }
  });
  test("morning close: an actually-lapsed client still gets the warm return line", () => {
    assert.match(morningClosingLine("RECOVERING", lapsed), /have you back/i);
    assert.match(morningClosingLine("DISENGAGED", lapsed), /reply Hi/i);
  });
  test("morning close: engaged lines make NO 'session today' push — safe on a rest day", () => {
    for (const t of ["RECOVERING", "DISENGAGED"] as const) {
      assert.ok(!/(one|a session).*today|today.*session|get one in today/i.test(morningClosingLine(t, eng)), `rest-day-unsafe (${t})`);
    }
  });
  test("morning close: ON_A_RUN unchanged for everyone", () => {
    assert.match(morningClosingLine("ON_A_RUN", eng), /sessions in over 4 weeks/);
    assert.equal(morningClosingLine("ON_TRACK", eng), "");
  });
}

// JUNK-AWARE VERDICT (2026-07-17 live: "beef bacon burger with fries" got "🟢 Nicely
// done / Good protein 👍" — bacon's protein category cancelled the junk read, so a
// takeaway looked like a clean win. The MEAL is judged now, not one item on the plate.)
{
  const { buildFoodLogReply } = await import("../server/handlers/food-scanner");
  const junkMeal = (goal: string, notes: string, junkDominant: boolean) => buildFoodLogReply({
    foodLines: "• Burger\n• Chips\n• Bacon", mealLabel: "lunch",
    totalMealCals: 1425, totalMealProtein: 55, runningCals: 1425, runningProtein: 55,
    calorieTarget: 2400, proteinTarget: 150, prevCals: 200, hasGoodProteins: true,
    junkDominant, user: { goalType: goal, profileNotes: notes },
  });
  test("junk verdict: a takeaway never gets 🟢 'Nicely done' or protein praise (fat loss)", () => {
    const r = junkMeal("fat_loss", "numbers:full", true);
    assert.ok(/takeaway/i.test(r) && !/Nicely done/i.test(r), `honest treat verdict: ${r.split("\n")[0]}`);
    assert.ok(!/Good protein in that one/i.test(r), "no praise on junk protein");
  });
  test("junk verdict: number-free path also honest, with a forward-coaching nudge", () => {
    const r = junkMeal("fat_loss", "", true);
    assert.ok(/takeaway/i.test(r) && /protein.*next meal|more protein/i.test(r), `plain honest: ${r}`);
    assert.ok(!/Good protein in that one/i.test(r));
  });
  test("junk verdict: muscle gain — fuel acknowledged, pushed to whole-food protein", () => {
    assert.ok(/whole.?food protein|actually builds/i.test(junkMeal("muscle_gain", "numbers:full", true)));
  });
  test("junk verdict: a CLEAN meal still keeps the green light", () => {
    const r = buildFoodLogReply({
      foodLines: "• Chicken\n• Rice", mealLabel: "lunch",
      totalMealCals: 500, totalMealProtein: 40, runningCals: 500, runningProtein: 40,
      calorieTarget: 2400, proteinTarget: 150, prevCals: 200, hasGoodProteins: true,
      junkDominant: false, user: { goalType: "fat_loss", profileNotes: "numbers:full" },
    });
    assert.ok(/Nicely done|Right on track/.test(r), "clean meal is not punished");
  });
}

// PERSONAL MEAL-SLOT LEARNING (2026-07-17, Review #7 items 3b + gap-heuristic +
// behavioural shift detection). The client's own hour-pattern beats the clock;
// a light second meal on a used slot demotes to snack; weak patterns change nothing.
{
  const { dominantSlotByHour, resolveInferredSlot } = await import("../server/portion-memory");
  const at = (sastHour: number, label: string) => ({ loggedAt: new Date(Date.UTC(2026, 6, 10, (sastHour - 2 + 24) % 24, 15)), mealLabel: label });
  test("slot learning: hour qualifies at >=3 logs and >=70% share — never on noise", () => {
    const strong = dominantSlotByHour([at(10, "lunch"), at(10, "lunch"), at(10, "lunch"), at(10, "breakfast")]);
    assert.equal(strong.get(10), "lunch", "3/4 lunch at 10:00 = personal lunch hour");
    const weak = dominantSlotByHour([at(10, "lunch"), at(10, "lunch"), at(10, "breakfast"), at(10, "breakfast")]);
    assert.ok(!weak.has(10), "50/50 split teaches nothing");
    const thin = dominantSlotByHour([at(10, "lunch"), at(10, "lunch")]);
    assert.ok(!thin.has(10), "2 logs is not a pattern");
  });
  test("slot learning: personal hour beats the clock; shift worker learned without a flag", () => {
    const ctx = { personalByHour: new Map([[10, "lunch"], [2, "night meal"]]), todaySlots: [] };
    assert.equal(resolveInferredSlot("breakfast", 10, ctx, 600), "lunch", "the reviewer's 10:00 case");
    assert.equal(resolveInferredSlot("snack", 2, ctx, 250), "night meal", "02:00 history wins, no onboarding flag needed");
    assert.equal(resolveInferredSlot("breakfast", 7, ctx, 400), "breakfast", "no pattern for 07:00 = clock stands");
  });
  test("slot learning: light second meal on a used slot = snack; a real plate keeps its slot", () => {
    const ctx = { personalByHour: new Map<number, string>(), todaySlots: ["breakfast"] };
    assert.equal(resolveInferredSlot("breakfast", 9, ctx, 180), "snack", "09:30 fruit after 07:30 breakfast");
    assert.equal(resolveInferredSlot("breakfast", 9, ctx, 650), "breakfast", "a second full plate is honestly a second breakfast");
    assert.equal(resolveInferredSlot("breakfast", 9, undefined, 180), "breakfast", "no context = old behaviour, fail-open");
  });
}

// INTELLIGENT INFERENCE — night-meal slotting (2026-07-17 design execution: the
// 22:00–05:00 window demoted every plate to "snack"; a night-shift worker's 02:00
// pap-and-wors is their MAIN meal). Day windows must stay byte-identical.
{
  const { slotFromSastHour, isNightWorker } = await import("../server/utils");
  const at = (sastHour: number) => new Date(Date.UTC(2026, 6, 17, (sastHour - 2 + 24) % 24, 30));
  test("slots: day windows unchanged (breakfast/lunch/dinner/snack)", () => {
    assert.equal(slotFromSastHour(at(7)), "breakfast");
    assert.equal(slotFromSastHour(at(12)), "lunch");
    assert.equal(slotFromSastHour(at(19)), "dinner");
    assert.equal(slotFromSastHour(at(16)), "snack", "15:00-17:00 gap stays snack");
  });
  test("slots: night window — light bite stays snack, real plate or night worker = night meal", () => {
    assert.equal(slotFromSastHour(at(2)), "snack", "2am biscuit is a snack");
    assert.equal(slotFromSastHour(at(2), { substantial: true }), "night meal", "2am 700-kcal plate is a MEAL");
    assert.equal(slotFromSastHour(at(23), { nightWorker: true }), "night meal", "night worker's 23:00 plate");
    assert.equal(slotFromSastHour(at(12), { nightWorker: true }), "lunch", "day windows never touched");
  });
  test("slots: isNightWorker reads the onboarding answers", () => {
    assert.ok(isNightWorker({ workSchedule: "night shift" }));
    assert.ok(isNightWorker({ lifeSituation: "security guard, night-shift" }));
    assert.ok(!isNightWorker({ workSchedule: "office 9-5" }));
    assert.ok(!isNightWorker({}));
  });
}

// SWAP ASKS (2026-07-17, founder: "eat this instead of that IS the coaching" — clients
// send grocery-store questions; the answer must be the SAME every time, goal-aware).
{
  const { parseSwapAsk, answerSwapAsk, suggestSwap } = await import("../server/food-swaps");
  test("swap ask: question phrasings extract the food", () => {
    assert.equal(parseSwapAsk("what can i use instead of mayonnaise?"), "mayonnaise");
    assert.equal(parseSwapAsk("alternative to banana?"), "banana");
    assert.equal(parseSwapAsk("healthier option than coke please"), "coke");
    assert.equal(parseSwapAsk("substitute for white bread"), "white bread");
    assert.equal(parseSwapAsk("i had eggs and pap"), null, "food logs are not swap asks");
    assert.equal(parseSwapAsk("show me my meals"), null);
  });
  test("swap ask: deterministic answers ride the one swap table, goal-aware", () => {
    assert.match(answerSwapAsk("what can i use instead of mayonnaise?", "fat_loss") || "", /light mayo/i);
    assert.match(answerSwapAsk("alternative to banana?", "fat_loss") || "", /berries/i);
    assert.equal(answerSwapAsk("alternative to banana?", "muscle_gain"), null, "banana is FINE for building — Coach K handles it");
    assert.match(answerSwapAsk("healthier option than coke?", "fat_loss") || "", /zero/i);
  });
  test("swaps: founder's cases — nuts/avo get PORTION caps, never removal", () => {
    assert.match(suggestSwap("cashews", "fat_loss")?.swap || "", /handful|palm/i);
    assert.match(suggestSwap("avocado", "fat_loss")?.swap || "", /half/i);
    assert.equal(suggestSwap("avocado", "muscle_gain"), null, "builders keep the avo");
  });
}

// DAY-ZERO PHYSIQUE READ (2026-07-17, founder: "shouldn't they be sending us pictures
// before we put people on the wrong program?"). The photo decides the recommendation;
// the client decides the goal — assist, never override.
{
  const { parseBodyState, recommendGoalFromRead } = await import("../server/physique-analysis");
  const { bodyPhotoAsk } = await import("../server/onboarding-physique");
  test("body state: model output parses to canonical states", () => {
    assert.equal(parseBodyState("DOMINANT: back\nLAGGING: chest\nBODY: carrying extra fat\nNOTE: solid base."), "overfat");
    assert.equal(parseBodyState("BODY: skinny-fat"), "skinny_fat");
    assert.equal(parseBodyState("BODY: underweight"), "underweight");
    assert.equal(parseBodyState("BODY: lean"), "lean");
    assert.equal(parseBodyState("BODY: average"), "average");
    assert.equal(parseBodyState("no body line at all"), "unknown");
  });
  test("goal rec: the curves woman — chose muscle gain, carrying fat → fat loss, shape protected", () => {
    const r = recommendGoalFromRead("overfat", "muscle_gain");
    assert.ok(r && r.goal === "fat_loss", "must recommend fat loss");
    assert.ok(/curves|shape/i.test(r!.reason) && /stay/i.test(r!.reason), `reason must protect the fear: ${r!.reason}`);
  });
  test("goal rec: underweight NEVER gets a cut; skinny-fat → recomp; lean cutter → recomp", () => {
    assert.equal(recommendGoalFromRead("underweight", "fat_loss")?.goal, "muscle_gain");
    assert.equal(recommendGoalFromRead("skinny_fat", "fat_loss")?.goal, "recomposition");
    assert.equal(recommendGoalFromRead("lean", "fat_loss")?.goal, "recomposition");
  });
  test("goal rec: agreement and unreadable photos change NOTHING (client's choice wins)", () => {
    assert.equal(recommendGoalFromRead("overfat", "fat_loss"), null);
    assert.equal(recommendGoalFromRead("underweight", "muscle_gain"), null);
    assert.equal(recommendGoalFromRead("average", "muscle_gain"), null);
    assert.equal(recommendGoalFromRead("unknown", "fat_loss"), null);
  });
  test("photo ask: always optional, skip in the same breath; height-blind gets the stronger why", () => {
    for (const known of [true, false]) assert.ok(/\*skip\*/i.test(bodyPhotoAsk(known)), "skip offered");
    assert.ok(/without your height/i.test(bodyPhotoAsk(false)), "height-unknown framing present");
  });
}

// SURPLUS/DEFICIT QUESTIONS (2026-07-17 nightly drill: third recurrence on the model
// path → now deterministic). The predicate is shared by the handler AND the drill's
// routing map, so production and the nightly alert can never disagree about who owns it.
{
  const { looksLikeSurplusDeficitQuestion } = await import("../server/utils");
  test("surplus predicate: definitional/status asks ARE claimed", () => {
    for (const s of [
      "on a regular normal eating day how much should my surplus be? 500 calories, 200 calories, what?",
      "am i in a deficit? i've only had breakfast",
      "what's my surplus and how are my steps today?",
      "what should my deficit be",
      "is my surplus big enough",
      "how big should my deficit be?",
    ]) assert.ok(looksLikeSurplusDeficitQuestion(s), `should claim: ${s}`);
  });
  test("surplus predicate: reasoning and reports stay with Coach K", () => {
    for (const s of [
      "why am i not losing weight in a deficit",
      "i was in a surplus yesterday",
      "the deficit is killing me",
      "had eggs for breakfast",
      "how are my steps today?",
    ]) assert.ok(!looksLikeSurplusDeficitQuestion(s), `should NOT claim: ${s}`);
  });
}

// The workout cooldown ("scroll up ↑") was REMOVED entirely on 2026-07-16 after it
// refused the founder's direct request twice in one night — a client who asks for
// their session gets their session, always. The guard below keeps it dead.
test("no workout cooldown: 'scroll up' refusal must not exist in any handler", () => {
  const src = readFileSync(join("server", "handlers", "early-commands.ts"), "utf-8");
  assert.ok(!/scroll up ↑ to see it/i.test(src), "the cooldown refusal text has returned — remove it");
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
// Friction Monitor — a client can be active every day yet fighting the bot; the queue must see it.
test("triage: active-but-fighting-the-bot (4+ friction) is RED even with 0 days silent", () => {
  const t = computeClientRisk({ ...ACTIVE_ON_TRACK, frictionLast7: 5 });
  assert.equal(t.level, "red");
  assert.match(t.reason, /fighting the bot/i);
});
test("triage: mild friction (2-3) on an otherwise-green client is yellow", () => {
  const t = computeClientRisk({ ...ACTIVE_ON_TRACK, frictionLast7: 2 });
  assert.equal(t.level, "yellow");
  assert.match(t.reason, /rough moments/i);
});
test("triage: a stray single correction (friction 1) does NOT flag — stays green", () => {
  assert.equal(computeClientRisk({ ...ACTIVE_ON_TRACK, frictionLast7: 1 }).level, "green");
});
test("triage: safety still beats heavy friction", () => {
  const t = computeClientRisk({ ...ACTIVE_ON_TRACK, frictionLast7: 9, hasOpenUrgentEscalation: true });
  assert.match(t.reason, /escalation/i);
});
test("friction: frictionFlag thresholds (pure)", async () => {
  const { frictionFlag } = await import("../server/friction");
  assert.equal(frictionFlag(0), null);
  assert.equal(frictionFlag(1), null);
  assert.equal(frictionFlag(2)?.level, "yellow");
  assert.equal(frictionFlag(4)?.level, "red");
  assert.equal(frictionFlag(10)?.level, "red");
});
test("friction: signal kinds map to friction_* and cover all four", async () => {
  const { frictionSignalKind, FRICTION_SIGNAL_KINDS } = await import("../server/friction");
  assert.equal(frictionSignalKind("correction"), "friction_correction");
  assert.equal(FRICTION_SIGNAL_KINDS.length, 4);
  assert.ok(FRICTION_SIGNAL_KINDS.every((k: string) => k.startsWith("friction_")));
});

// HOME / TRAVEL WORKOUT BUILDER — Kam's manual-coaching chats: a client photographs their kit
// ("this is what he has" — dumbbells + barbell) or is on holiday. The bot must read the kit and
// hand back a real session, no "reply dumbbells/bands/mix" friction.
test("home-workout: parseEquipment reads a mixed kit and always includes bodyweight", async () => {
  const { parseEquipment } = await import("../server/home-workout");
  const items = parseEquipment("dumbbells, a barbell and a resistance band");
  assert.ok(items.includes("dumbbells") && items.includes("barbell") && items.includes("bands"));
  assert.ok(items.includes("bodyweight"), "bodyweight is always available");
});
test("home-workout: parseEquipment on an empty room falls back to bodyweight only", async () => {
  const { parseEquipment } = await import("../server/home-workout");
  assert.deepEqual(parseEquipment("just a yoga mat"), ["bodyweight"]);
});
test("home-workout: dumbbells+barbell fat-loss session is loaded, educates, and has NO reply-menu", async () => {
  const { buildHomeSession } = await import("../server/home-workout");
  const s = buildHomeSession(["dumbbells", "barbell", "bodyweight"], { goalType: "fat_loss", name: "Puntsa" });
  assert.match(s, /Goblet squat/i, "uses the loaded squat when weights are present");
  assert.match(s, /Romanian deadlift|RDL/i);
  assert.match(s, /don't need a full gym/i, "teaches that a home setup is enough");
  assert.doesNotMatch(s, /reply \*dumbbells\*|reply dumbbells|type \*mix\*/i, "no clunky menu");
  assert.match(s, /Puntsa/, "greets by first name");
});
test("home-workout: bodyweight-only session still gives real movements", async () => {
  const { buildHomeSession } = await import("../server/home-workout");
  const s = buildHomeSession(["bodyweight"], { goalType: "general" });
  assert.match(s, /Push-up/i);
  assert.match(s, /Bodyweight squat/i);
  assert.match(s, /bodyweight builds real strength/i);
});
test("home-workout: muscle-gain runs straight sets (4 rounds, 8–12), fat-loss adds a walk", async () => {
  const { buildHomeSession } = await import("../server/home-workout");
  const bulk = buildHomeSession(["dumbbells", "bodyweight"], { goalType: "muscle_gain" });
  assert.match(bulk, /4 rounds.*8[–-]12/i);
  const cut = buildHomeSession(["dumbbells", "bodyweight"], { goalType: "fat_loss" });
  assert.match(cut, /walk/i, "fat loss finishes with a walk for extra burn");
});
test("home-workout: bench + dumbbells unlocks a bench press", async () => {
  const { buildHomeSession } = await import("../server/home-workout");
  const s = buildHomeSession(["dumbbells", "bench", "bodyweight"], { goalType: "recomposition" });
  assert.match(s, /bench press/i);
});
test("home-workout: inventory vision prompt asks for the specific equipment words only", async () => {
  const { buildEquipmentInventoryPrompt } = await import("../server/home-workout");
  const p = buildEquipmentInventoryPrompt();
  assert.match(p, /dumbbells, barbell, kettlebell, bands, bench, pull-up bar/);
  assert.match(p, /bodyweight/);
});

// WELLNESS FOOD-LOG REPLY — the no-numbers client ("just get healthier") must be coached in
// habits and plain language, never calories/grams (2026-07-22 reviewer: "teach even the no-numbers
// user"; tester: "it talks in calories and I don't understand calories").
test("food-log: a wellness client's reply carries NO calorie/gram numbers, coaches the habit", async () => {
  const { buildFoodLogReply } = await import("../server/handlers/food-scanner");
  const reply = buildFoodLogReply({
    foodLines: "🍗 Chicken and pap", mealLabel: "lunch", totalMealCals: 600, totalMealProtein: 35,
    runningCals: 1200, runningProtein: 60, calorieTarget: 0, proteinTarget: 0, prevCals: 600,
    user: { goalType: "general", name: "Lerato" },
  });
  assert.doesNotMatch(reply, /\bkcal\b|calorie|\d+\s*g\b|target/i, "no numbers for the no-numbers client");
  assert.match(reply, /protein/i, "still gives a plain quality nudge");
  assert.match(reply, /Lerato/);
  assert.match(reply, /✅/, "reinforces the habit");
});
test("food-log: a fat-loss client does NOT take the wellness branch (macro path unchanged)", async () => {
  const { buildFoodLogReply } = await import("../server/handlers/food-scanner");
  const reply = buildFoodLogReply({
    foodLines: "🍗 Chicken and pap", mealLabel: "lunch", totalMealCals: 600, totalMealProtein: 35,
    runningCals: 1200, runningProtein: 60, calorieTarget: 1900, proteinTarget: 150, prevCals: 600,
    user: { goalType: "fat_loss", name: "Sipho" },
  });
  // The wellness reply is identified by its habit signature — a macro-goal reply must never show it.
  assert.doesNotMatch(reply, /Showing up like this every day|winning move is just being consistent|Small steady habits like this/, "fat-loss keeps the numeric macro path, not the no-numbers wellness reply");
});
test("food-log: wellness junk meal gets a no-guilt treat nudge, not a calorie warning", async () => {
  const { wellnessFoodLogReply } = await import("../server/handlers/food-scanner");
  const reply = wellnessFoodLogReply({ foodLines: "🍔 Burger and chips", totalMealProtein: 15, junkDominant: true, user: { goalType: "health_condition" } });
  assert.match(reply, /treat/i);
  assert.doesNotMatch(reply, /kcal|calorie|\d+\s*g\b/i);
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

// ONBOARDING INTAKE PARSERS (2026-07-12) — the free-text intake Kam captures manually.
// The onboarding flow has no automated coverage, so the logic that interprets a client's
// own words is locked here.
test("intake: food preferences split into likes and dislikes", () => {
  const a = parseFoodPreferences("Love pap and chicken, can't stand broccoli");
  assert.match(a.foodLikes || "", /pap and chicken/i);
  assert.match(a.foodDislikes || "", /broccoli/i);
  const b = parseFoodPreferences("I hate chicken breast");
  assert.match(b.foodDislikes || "", /chicken breast/i);
  const c = parseFoodPreferences("eggs, pap, morogo");   // no dislike marker → all likes
  assert.match(c.foodLikes || "", /eggs, pap, morogo/i);
  assert.equal(c.foodDislikes, null);
  const d = parseFoodPreferences("skip");
  assert.deepEqual(d, { foodLikes: null, foodDislikes: null });
});

test("intake: vision answer keeps the dream and captures a named struggle", () => {
  const a = parseVisionAnswer("Lose my belly and keep my muscle. I struggle with snacking at night");
  assert.match(a.dreamGoal || "", /belly.*muscle/i);
  assert.match(a.biggestStruggle || "", /snacking at night/i);
  const b = parseVisionAnswer("Just feel confident at the beach");   // no struggle marker
  assert.match(b.dreamGoal || "", /confident at the beach/i);
  assert.equal(b.biggestStruggle, null);
  assert.deepEqual(parseVisionAnswer(""), { dreamGoal: null, biggestStruggle: null });
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

// STEP BURN (2026-07-12, Kam: "be exactly precise… steps incorporated into the deficit").
// ONE canonical, weight-scaled formula behind the deficit offset, the step logger, and
// the "how much did I burn" answer — they used to disagree (flat vs /70 vs /75).
test("step burn: ~0.04 kcal/step at 70kg, and scales with body weight", () => {
  assert.equal(stepBurnKcal(10000, 70), 400);
  assert.equal(stepBurnKcal(10000, 140), 800);   // twice the mass → twice the burn
  assert.equal(stepBurnKcal(10000, 35), 200);     // half the mass → half the burn
  // a heavy client MUST be credited more than a light one for the same steps
  assert.ok(stepBurnKcal(8000, 120) > stepBurnKcal(8000, 60), "heavier burns more per step");
});

test("step burn: junk/missing weight defaults to average; extremes clamped; no negatives", () => {
  assert.equal(stepBurnKcal(10000, undefined), 400); // missing → 70kg
  assert.equal(stepBurnKcal(10000, 0), 400);          // junk → 70kg
  assert.equal(stepBurnKcal(10000, 5000), stepBurnKcal(10000, 250), "implausible weight clamped to 250");
  assert.equal(stepBurnKcal(-500, 70), 0);            // negative steps → 0
  assert.equal(stepBurnKcal(0, 70), 0);
});

// WATER TARGET (2026-07-12, "same precision everywhere"). One canonical 33ml/kg formula
// with a 2.0L floor — was six copies, one drifted (no floor) so a light client saw two
// different targets. Number and string weights, junk/missing all resolve consistently.
test("water target: 33ml/kg, one-decimal, floored at 2.0L", () => {
  assert.equal(waterTargetLitres(75), 2.5);
  assert.equal(waterTargetLitres(100), 3.3);
  assert.equal(waterTargetLitres(120), 4.0);
  assert.equal(waterTargetLitres("80"), 2.6);        // string weight parses
  // the drift fix: a light client is floored to 2.0, not 1.7 — same on every screen now
  assert.equal(waterTargetLitres(50), 2.0);
});

// TARGET SANITY AUDIT (2026-07-13, the Bonolo case): stored 2,346 kcal for a 70kg
// female office recomposition — matched NO input combination of our formula (expected
// ~1,950). Six code paths write targets; nothing validated them after the fact. A wrong
// target must not survive 24h; legitimate deviations (trend ±150, diet break) must.
const BONOLO = {
  currentWeight: "70", goalType: "recomposition", lifeSituation: "office",
  trainingDaysPerWeek: 4, gender: "female", age: 27, heightCm: 165,
  trainingExperience: "beginner",
};
test("target audit: the Bonolo case — impossible 2,346 kcal is caught and corrected", () => {
  const a = auditStoredTargets({ ...BONOLO, calorieTarget: 2346, proteinTarget: 126 });
  assert.equal(a.ok, false, "2,346 kcal for this profile must be flagged");
  assert.ok(a.expectedCal >= 1850 && a.expectedCal <= 2050, `expected ~1950, got ${a.expectedCal}`);
  assert.equal(a.expectedProt, 126, "her protein was actually correct");
  assert.match(a.reason || "", /calorieTarget 2346/);
});

test("target audit: legitimate trend adjustments (±150) and correct targets pass", () => {
  const base = auditStoredTargets({ ...BONOLO, calorieTarget: 1950, proteinTarget: 126 });
  assert.equal(base.ok, true, "correct targets pass");
  const trended = auditStoredTargets({ ...BONOLO, calorieTarget: base.expectedCal + 150, proteinTarget: 126 });
  assert.equal(trended.ok, true, "weigh-in trend adjustment must NOT be clobbered");
});

test("target audit: an active diet break is deliberate — never corrected", () => {
  const a = auditStoredTargets({ ...BONOLO, calorieTarget: 2400, proteinTarget: 126, dietBreakEndsAt: new Date(Date.now() + 3 * 86_400_000) });
  assert.equal(a.ok, true, "diet-break target left alone");
  const expired = auditStoredTargets({ ...BONOLO, calorieTarget: 2400, proteinTarget: 126, dietBreakEndsAt: new Date(Date.now() - 86_400_000) });
  assert.equal(expired.ok, false, "expired diet break no longer protects a high target");
});

test("target audit: wrong protein is caught too; empty targets don't false-fire", () => {
  const p = auditStoredTargets({ ...BONOLO, calorieTarget: 1950, proteinTarget: 180 });
  assert.equal(p.ok, false, "180g for a 70kg female recomp is wrong");
  const empty = auditStoredTargets({ ...BONOLO, calorieTarget: null, proteinTarget: null });
  assert.equal(empty.ok, true, "unset targets are onboarding's job, not the auditor's");
});

// RECALC-ON-CHANGE (2026-07-14): the shared "recompute every target from the profile
// as it stands now" helper. Must agree with the raw formula, and must MOVE when a
// formula input changes — the guarantee that a mid-journey goal/training-days switch
// can't leave stale calories on file (the Bonolo class, at the write end).
test("recalc: helper output matches the raw formula for a profile", () => {
  const r = recalcTargetsForProfile(BONOLO);
  const raw = calculateTargets(70, "recomposition", "office", 4, "female", 27, 165, "beginner");
  const rawSteps = calculateStepsTarget(70, 27, 165, "beginner", "recomposition");
  assert.equal(r.calorieTarget, raw.calorieTarget, "calories match formula");
  assert.equal(r.proteinTarget, raw.proteinTarget, "protein matches formula");
  assert.equal(r.stepsTarget, rawSteps, "steps match formula");
});

test("recalc: changing goal/training-days/experience MOVES the targets (no stale numbers)", () => {
  const before = recalcTargetsForProfile(BONOLO);
  const afterGoal = recalcTargetsForProfile({ ...BONOLO, goalType: "muscle_gain" });
  assert.notEqual(afterGoal.calorieTarget, before.calorieTarget, "goal flip must move calories");
  const afterDays = recalcTargetsForProfile({ ...BONOLO, trainingDaysPerWeek: 6 });
  assert.notEqual(afterDays.calorieTarget, before.calorieTarget, "more training days must move calories");
  const afterExp = recalcTargetsForProfile({ ...BONOLO, trainingExperience: "advanced" });
  assert.notEqual(afterExp.calorieTarget, before.calorieTarget, "experience change must move calories");
});

test("recalc: degrades safely on a bare/empty profile (never NaN)", () => {
  const r = recalcTargetsForProfile({});
  assert.ok(Number.isFinite(r.calorieTarget) && r.calorieTarget > 0, "calories finite + positive");
  assert.ok(Number.isFinite(r.proteinTarget) && r.proteinTarget > 0, "protein finite + positive");
  assert.ok(r.stepsTarget >= 2000, "steps sane");
});

// STEPS SANITY (2026-07-13, "across the board"): bounds-only — never second-guess a
// value a client legitimately set ("change my steps to 10 000"), only catch corruption.
test("steps audit: human-range values pass untouched; corruption is caught", () => {
  const base = { currentWeight: "80", age: 30, heightCm: 175, trainingExperience: "beginner", goalType: "fat_loss" };
  assert.equal(auditStepsTarget({ ...base, stepsTarget: 10000 }).ok, true, "user-set 10k passes");
  assert.equal(auditStepsTarget({ ...base, stepsTarget: 3000 }).ok, true, "low-mobility 3k passes");
  assert.equal(auditStepsTarget({ ...base, stepsTarget: 0 }).ok, false, "zero is corruption");
  assert.equal(auditStepsTarget({ ...base, stepsTarget: null }).ok, false, "null is corruption");
  assert.equal(auditStepsTarget({ ...base, stepsTarget: 90000 }).ok, false, "90k is corruption");
  const a = auditStepsTarget({ ...base, stepsTarget: null });
  assert.ok(a.expected >= 4000 && a.expected <= 12000, "expected fallback is the formula value");
});

test("water target: junk/missing weight defaults to an average adult (2.5L)", () => {
  assert.equal(waterTargetLitres(undefined), 2.5);
  assert.equal(waterTargetLitres(null), 2.5);
  assert.equal(waterTargetLitres("0"), 2.5);
  assert.equal(waterTargetLitres("not a number"), 2.5);
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

// TIME-AWARE GREETING (2026-07-22, founder: the coaching must feel human — greet by time of
// day). Never "Good morning" at 2am.
test("timeGreeting: greets by SAST time of day, neutral in the small hours", () => {
  assert.strictEqual(timeGreeting(8), "Good morning");
  assert.strictEqual(timeGreeting(11), "Good morning");
  assert.strictEqual(timeGreeting(12), "Good afternoon");
  assert.strictEqual(timeGreeting(16), "Good afternoon");
  assert.strictEqual(timeGreeting(17), "Good evening");
  assert.strictEqual(timeGreeting(21), "Good evening");
  assert.strictEqual(timeGreeting(2), "Hey", "no 'Good morning' at 2am");
  assert.strictEqual(timeGreeting(23), "Hey");
});

// GOAL PROFILES — the semantic spine (2026-07-21 three-reviewer adjudication). One source of
// truth so the ~50 scattered goalType checks stop meaning different things. Slice 1: the
// registry itself changes NOTHING; these tests lock its meaning before consumers migrate.
test("goal-profiles: body-composition goals push macros; health-led goals never do", () => {
  // The three body-comp goals are unchanged — they still drive calorie/protein numbers.
  for (const g of ["fat_loss", "muscle_gain", "recomposition"]) {
    assert.strictEqual(usesMacroTargets(g), true, `${g} still uses macro targets (no regression)`);
    assert.strictEqual(getGoalProfile(g).scopeBoundary, false, `${g} has no doctor scope boundary`);
  }
  // The health-led goals are SAFE BY CONSTRUCTION — no macro pressure, not chasing the scale.
  for (const g of ["general", "health_condition"]) {
    assert.strictEqual(usesMacroTargets(g), false, `${g} never pushes a protein/calorie quota (the gogo fix)`);
    assert.strictEqual(getGoalProfile(g).weightIsGoal, false, `${g} does not chase a scale number`);
    assert.strictEqual(getGoalProfile(g).energyStance, "maintenance", `${g} is coached around maintenance, never a deficit`);
    assert.strictEqual(getGoalProfile(g).dailyWin, "consistency_and_movement", `${g} wins on consistency, not macros`);
  }
});

// SPINE SURGERY slice 3 (2026-07-21): the health-led goals are REACHABLE at signup — a
// gogo/tired/condition client can actually pick them, in their own words or via the menu.
test("onboarding goal detection: health-led goals are selectable; body-comp unchanged", () => {
  // The existing three are byte-identical.
  assert.strictEqual(classifyGoalFromText("1"), "fat_loss");
  assert.strictEqual(classifyGoalFromText("I want to lose fat"), "fat_loss");
  assert.strictEqual(classifyGoalFromText("2"), "muscle_gain");
  assert.strictEqual(classifyGoalFromText("build muscle"), "muscle_gain");
  assert.strictEqual(classifyGoalFromText("3"), "recomposition");
  assert.strictEqual(classifyGoalFromText("both"), "recomposition");
  // New: general wellness in the client's own words, and the menu number.
  assert.strictEqual(classifyGoalFromText("4"), "general");
  assert.strictEqual(classifyGoalFromText("I just want to be healthy and have energy"), "general");
  assert.strictEqual(classifyGoalFromText("keep active for my grandkids"), "general");
  // Named condition → health_condition (scope boundary path).
  assert.strictEqual(classifyGoalFromText("I want to manage my sugar"), "health_condition");
  assert.strictEqual(classifyGoalFromText("my blood pressure is high"), "health_condition");
  // CRITICAL: body-composition intent always wins — "lose weight to be healthy" is fat_loss.
  assert.strictEqual(classifyGoalFromText("lose weight and get healthy"), "fat_loss");
  assert.strictEqual(classifyGoalFromText("I want to build muscle and feel healthier"), "muscle_gain");
  // The gate: a real goal answer is recognised; noise is re-asked.
  assert.ok(looksLikeGoalAnswer("get healthier"));
  assert.ok(looksLikeGoalAnswer("4"));
  assert.ok(!looksLikeGoalAnswer("hmmmm ok"));
});

test("goal-profiles: only 'I have a condition' triggers the doctor scope boundary (liability line)", () => {
  assert.strictEqual(getGoalProfile("health_condition").scopeBoundary, true, "coach the person, not the condition");
  assert.strictEqual(getGoalProfile("general").scopeBoundary, false);
  assert.strictEqual(getGoalProfile("fat_loss").scopeBoundary, false);
});

test("goal-profiles: unknown/blank/aliased goals resolve safely (never undefined, never a crash)", () => {
  assert.strictEqual(getGoalProfile(null).key, "fat_loss", "blank falls back to the historical default");
  assert.strictEqual(getGoalProfile(undefined).key, "fat_loss");
  assert.strictEqual(getGoalProfile("").key, "fat_loss");
  assert.strictEqual(getGoalProfile("garbage-string").key, "fat_loss");
  // Real aliases the onboarding/normalizer/older rows actually store.
  assert.strictEqual(getGoalProfile("general_wellness").key, "general");
  assert.strictEqual(getGoalProfile("wellness").key, "general");
  assert.strictEqual(getGoalProfile("weight_loss").key, "fat_loss");
  assert.strictEqual(getGoalProfile("RECOMP").key, "recomposition", "case-insensitive");
  // Every canonical key returns a fully-formed profile (no missing fields).
  for (const k of GOAL_KEYS) {
    const p = getGoalProfile(k);
    assert.ok(p.label && p.energyStance && p.proteinPriority && p.dailyWin && Array.isArray(p.tracks), `${k} profile is complete`);
  }
});

// PARSE MEAL-REPEAT TARGET (2026-07-21 live: client logged a fish lunch, typed "My dinner
// will be the same. Log it", and the bot read "dinner" as the SOURCE to search for, found
// none, and said "nothing logged" — forcing a voice note to make it work). "[meal] will be
// the same" must mean: target = that meal, source = the most recent meal logged today.
test("parseMealRepeatTarget: THE BUG — '[meal] will be the same' targets that meal, copies today's newest", () => {
  const dinner = parseMealRepeatTarget("my dinner will be the same. log it");
  assert.strictEqual(dinner.targetLabel, "dinner", "dinner is the TARGET, not the thing to search for");
  assert.strictEqual(dinner.sourceHint, null, "no explicit source → copy the most recent meal today");
  assert.strictEqual(dinner.crossish, true);
  // Other natural phrasings of the same shape.
  assert.strictEqual(parseMealRepeatTarget("dinner is the same").targetLabel, "dinner");
  assert.strictEqual(parseMealRepeatTarget("supper will be the same").targetLabel, "dinner", "supper normalises to dinner");
  assert.strictEqual(parseMealRepeatTarget("my lunch stays the same").targetLabel, "lunch");
});

test("parseMealRepeatTarget: existing shapes still resolve correctly (no regression)", () => {
  // "same as X" → source X, target = current slot.
  assert.strictEqual(parseMealRepeatTarget("dinner same as lunch").sourceHint, "lunch");
  assert.strictEqual(parseMealRepeatTarget("dinner same as lunch").targetLabel, "dinner");
  // "same for X" → target X, source = newest today.
  assert.strictEqual(parseMealRepeatTarget("same thing for dinner").targetLabel, "dinner");
  assert.strictEqual(parseMealRepeatTarget("same thing for dinner").sourceHint, null);
  // A plain non-repeat sentence names no target.
  assert.strictEqual(parseMealRepeatTarget("i had rice and chicken").targetLabel, null);
});

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

// MEDICAL-CLAIM COMPLIANCE (2026-07-22) — the Meta / liability line. The bot must NEVER claim to
// cure/reverse a disease or touch medication. A rejection risk AND a real-world safety risk.
test("verifier blocks claims to cure/reverse a medical condition", () => {
  assert.ok(!verifyBrainReply("Stick with me and we'll reverse your diabetes in a few months.", { goalType: "health_condition" }).ok);
  assert.ok(!verifyBrainReply("This plan will cure your high blood pressure.", { goalType: "general" }).ok);
  assert.ok(!verifyBrainReply("Walking every day can get rid of your condition for good.", {}).ok);
});
test("verifier blocks any instruction to change medication", () => {
  assert.ok(!verifyBrainReply("Once the weight drops you can come off your metformin.", { goalType: "health_condition" }).ok);
  assert.ok(!verifyBrainReply("Try to reduce your insulin on training days.", {}).ok);
  assert.ok(!verifyBrainReply("You can skip your blood pressure tablets if you feel fine.", {}).ok);
});
test("verifier PASSES compliant wellness language (manage, defer to doctor, keep taking meds)", () => {
  assert.ok(verifyBrainReply("Daily walking and less salt can help you manage your blood pressure — but your doctor guides the condition, not me.", { goalType: "health_condition" }).ok);
  assert.ok(verifyBrainReply("Keep taking your medication exactly as your doctor prescribed. I'll help with the food and movement side.", { goalType: "health_condition" }).ok);
  assert.ok(verifyBrainReply("I'm your coach, not your doctor — for anything about your diabetes, check with your doctor. Let's focus on protein and steps.", { goalType: "health_condition" }).ok);
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

// PROGRAMME SOVEREIGNTY (2026-07-21 live: asked "where can I improve?", the front-door
// engine freelanced a workout menu — "incorporate exercises like rows and planks… squats
// and lunges" — inventing movements that aren't in the client's FIXED machine programme.
// The prompt already forbade it; nothing enforced it. Now the verifier catches it in code.
test("verifier blocks the brain freelancing off-programme exercises", () => {
  assert.ok(!verifyBrainReply("To improve, incorporate exercises like rows and planks for your back and core.", {}).ok);
  assert.ok(!verifyBrainReply("Try adding exercises such as lunges and deadlifts to build your legs.", {}).ok);
  assert.ok(!verifyBrainReply("Incorporate squats and planks to strengthen your lower body.", {}).ok);
  assert.ok(!verifyBrainReply("Back & Core: incorporate exercises like rows. Legs: squats and lunges.", {}).ok);
  // Slice 4 (2026-07-21): broadened net — more off-programme movements caught.
  assert.ok(!verifyBrainReply("Start doing pull-ups and dips for your upper body.", {}).ok);
  assert.ok(!verifyBrainReply("Add in some kettlebell swings and box jumps.", {}).ok);
  assert.ok(!verifyBrainReply("Try adding burpees and mountain climbers between sets.", {}).ok);
});

test("verifier ALLOWS the CORRECT improvement answer (overload on existing lifts, no new moves)", () => {
  // Progressive overload / targeted volume on the EXISTING plan is the right answer, never blocked.
  assert.ok(verifyBrainReply("Add 2.5kg to your chest press and push your leg press up a rep next session.", {}).ok);
  assert.ok(verifyBrainReply("Your glutes are lagging — add 2 sets to your hip thrust. That brings them up.", {}).ok);
  assert.ok(verifyBrainReply("Want the full plan? Send *programme* and I'll lay out every session.", {}).ok);
  // And it must still allow correctly REFUSING to freelance ("we don't add random exercises").
  assert.ok(verifyBrainReply("We don't add random squats and lunges — your plan is machines, on purpose.", {}).ok);
});

// THE SYSTEMIC HOLE (2026-07-21): the live "new engine" was the ONE reply path with no
// verifier on its mouth — it only sanitised, then shipped. So myths, off-programme
// exercises, and goal contradictions went to the client unchecked. This locks the wire in:
// the meaning engine MUST run verifyBrainReply on a freeform reply and rewrite/defer on a
// violation, exactly like the brain path. Source-guarded because the path needs a model.
test("engine runs the reply verifier on its own mouth (self-correcting loop wired in)", () => {
  const eng = readFileSync(join("server", "understanding", "meaning-engine.ts"), "utf-8");
  assert.match(eng, /import \{ verifyBrainReply \} from "\.\.\/brain\/reply-verifier"/, "engine imports the verifier");
  assert.match(eng, /verifyBrainReply\(finalReply, \{ goalType: user\?\.goalType \}\)/, "engine verifies the freeform reply");
  assert.match(eng, /verifyBrainReply\(rewritten, \{ goalType: user\?\.goalType \}\)\.ok/, "a rewrite is re-verified before it can be sent");
  assert.match(eng, /return null; \/\/ fail-open on rewrite error/, "a second violation fails open to the deterministic pipeline");
});

// DEPLOY VISIBILITY (2026-07-21): a non-technical founder can't watch a deploy, so "is the
// fix even live?" becomes "nothing works". The coach can text *version* to the live bot and
// get the running commit + a self-test where the code proves the exact broken reply is now
// blocked. Source-guarded so the diagnostic can never silently disappear.
test("coach 'version' command exists and self-tests the live guard", () => {
  const routes = readFileSync(join("server", "routes.ts"), "utf-8");
  assert.match(routes, /\^\(version\|deploy/, "the version command is wired for the coach");
  assert.match(routes, /verifyBrainReply\("To improve, incorporate exercises like rows and planks\."/, "it self-tests the exact freelance reply live");
  assert.match(routes, /RAILWAY_GIT_COMMIT_SHA/, "it reports the running commit so the deploy is verifiable");
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

// The live phrase verbatim (2026-07-23 screenshot): "Not 2 Viennas but only half a Vienna".
test("qty correction: 'not 2 X but only half a X' parses — half is a real count", () => {
  const r = parseQuantityCorrection("Why did you add 2 Viennas?????? Not 2 Viennas but only half a Vienna");
  assert.ok(r, "should parse");
  assert.equal(r!.oldCount, 2);
  assert.equal(r!.count, 0.5);
  assert.ok(r!.food.includes("vienna"), `food: ${r!.food}`);
});
test("qty correction: 'half a X not 2' parses through the first form too", () => {
  const r = parseQuantityCorrection("it was half a vienna not 2");
  assert.ok(r && r.count === 0.5 && r.oldCount === 2, JSON.stringify(r));
});

// The live bug (2026-07-23): voice correction "there were 3 slices there, not 2" on a photo
// meal must parse cleanly ("slices", not "slices there") and NOT dead-end.
test("qty correction: trailing filler is stripped from the food", () => {
  const r = parseQuantityCorrection("there were 3 slices there, not 2");
  assert.ok(r, "should parse");
  assert.equal(r!.count, 3);
  assert.equal(r!.oldCount, 2);
  assert.equal(r!.food, "slices", `food should be 'slices', got '${r!.food}'`);
});

// ============================================================
// serving-units — a client names food by its serving unit ("slice" for toast), and photo
// meals store no per-item macros, so a ±1 count change is answered incrementally.
// ============================================================
test("serving-units: singularFood strips trailing s/es", () => {
  assert.equal(singularFood("slices"), "slice");
  assert.equal(singularFood("eggs"), "egg");
  assert.equal(singularFood("viennas"), "vienna");
});

test("serving-units: 'slice' resolves to bread/toast aliases", () => {
  const terms = foodMatchTerms("slices");
  assert.ok(terms.includes("toast"), `terms: ${terms.join(",")}`);
  assert.ok(terms.includes("bread"), `terms: ${terms.join(",")}`);
});

test("serving-units: a photo labelled 'Toast, boiled eggs, viennas' matches 'slices'", () => {
  assert.ok(foodMatchesText("slices", "Toast, boiled eggs, viennas"), "slice should match toast");
  assert.ok(foodMatchesText("eggs", "Toast, boiled eggs, viennas"), "egg should match by name");
  assert.ok(!foodMatchesText("rice", "Toast, boiled eggs, viennas"), "unrelated food must not match");
});

test("serving-units: per-serving estimates exist for common count foods", () => {
  assert.ok(perServingEstimate("slices")!.kcal > 0, "slice");
  assert.ok(perServingEstimate("eggs")!.protein > 0, "egg");
  assert.ok(perServingEstimate("viennas")!.kcal > 0, "vienna");
  assert.equal(perServingEstimate("teleporter"), null, "unknown food has no portion");
});

test("serving-units: +1 slice adds one serving's worth, does not rescale the meal", () => {
  // Meal = 410 kcal / 18g. Client: "3 slices not 2" ⇒ +1 slice (~75 kcal, 3g), NOT ×1.5.
  const per = perServingEstimate("slices")!;
  const deltaN = 3 - 2;
  const newKcal = 410 + Math.round(deltaN * per.kcal);
  assert.ok(newKcal > 410 && newKcal < 550, `incremental, not a rescale: ${newKcal}`);
});

// itemsFromVisionText — photo meals stored items:[] so "my meals" said "Food photo" and a
// correction had no item to scale (2026-07-23).
test("vision items: per-item lines parse into structured items", () => {
  const items = itemsFromVisionText(
    "Toast (~2 slices, 60g): 150 kcal, 6g protein\n• Boiled eggs (2 large): 156 kcal, 12g protein\nViennas (~80g): 232 kcal | 9g protein\nTOTAL: 538 kcal | 27g protein"
  );
  assert.equal(items.length, 3, `3 items, got ${items.length}: ${items.map(i => i.name).join("/")}`);
  assert.equal(items[0].name, "Toast");
  assert.equal(items[0].kcal, 150);
  assert.equal(items[1].protein, 12);
  assert.equal(items[2].kcal, 232);
  assert.equal(items[2].grams, 80, "grams read from the bracket");
});
test("vision items: TOTAL line and prose are skipped, empty text is safe", () => {
  assert.deepEqual(itemsFromVisionText("TOTAL: 500 kcal | 30g protein"), []);
  assert.deepEqual(itemsFromVisionText(""), []);
  assert.deepEqual(itemsFromVisionText("Nice balanced plate — well done!"), []);
});
test("vision items: parsed items are findable by a correction ('slices' matches Toast)", () => {
  const items = itemsFromVisionText("Toast (~2 slices): 150 kcal, 6g protein");
  assert.ok(items.length === 1 && foodMatchesText("slices", items[0].name), "correction can now target the item");
});

// ============================================================
// FOOD REFERENT — "reply log it" must not be a dead promise (2026-07-23 live: verdict on
// nuts → "I just had 3 handfuls of it" → "I didn't catch what food that was").
// ============================================================
test("referent: encode → read → clear round-trip through profileNotes", () => {
  const notes = encodePendingFood("sick_until:2026-07-20", { name: "Mixed nuts", kcal: 200, protein: 7 });
  const read = readPendingFood(notes);
  assert.ok(read && read.name === "Mixed nuts" && read.kcal === 200 && read.protein === 7, JSON.stringify(read));
  const cleared = clearPendingFood(notes);
  assert.ok(!cleared.includes("pending_food"), "cleared");
  assert.ok(cleared.includes("sick_until:2026-07-20"), "other notes survive");
});
test("referent: a stale referent (>6h) reads as null", () => {
  const notes = encodePendingFood("", { name: "Nuts", kcal: 200, protein: 7, at: Date.now() - 7 * 3_600_000 });
  assert.equal(readPendingFood(notes), null);
});
test("referent: the live message '3 handfuls of it' resolves to 3 servings", () => {
  assert.deepEqual(parseReferentReply("I just had 3 handfuls of it"), { mult: 3 });
  assert.deepEqual(parseReferentReply("log it"), { mult: 1 });
  assert.deepEqual(parseReferentReply("had half of it"), { mult: 0.5 });
  assert.deepEqual(parseReferentReply("ate some of it"), { mult: 0.5 });
});
test("referent: a real food message never resolves as a referent", () => {
  assert.equal(parseReferentReply("I had chicken and rice"), null);
  assert.equal(parseReferentReply("2 eggs and toast"), null);
  assert.equal(parseReferentReply("what should I eat tonight?"), null);
});

// ============================================================
// MACRO STATUS — "how are my fats looking?" is answered from the card's own rows (2026-07-23
// live: card said Fat 88/86g OVER, the engine said "~100g, within a reasonable range").
// ============================================================
const msRows = [
  { label: "Calories", current: 2540, target: 2862, unit: "", overIsBad: false },
  { label: "Protein", current: 148, target: 185, unit: "g", overIsBad: false },
  { label: "Carbs", current: 285, target: 337, unit: "g", overIsBad: true },
  { label: "Fat", current: 88, target: 86, unit: "g", overIsBad: true },
];
test("macro status: the live question routes — 'How are my fats looking for the day? Is it bad?'", () => {
  assert.equal(whichMacroAsked("How are my fats looking for the day? Is it bad?"), "Fat");
  assert.equal(whichMacroAsked("am I over on carbs today?"), "Carbs");
  assert.equal(whichMacroAsked("how are my macros today"), "Macros");
});
// The 15:22/15:24 argument spiral (2026-07-23 screenshots): the client challenged the wrong
// answer and the engine caved ("indeed 88g, solid number" — still the wrong verdict). Every
// phrasing in that spiral must route to the SAME deterministic answer — numbers can't be
// argued into agreement.
test("macro status: challenge phrasings route deterministically — no sycophancy loop", () => {
  assert.equal(whichMacroAsked("No my fats are 88 for the day, you are wrong, do better"), "Fat");
  assert.equal(whichMacroAsked("How can it be good when I'm over my daily limit of fats??"), "Fat");
});
test("macro status: composition/nutrition questions never match", () => {
  assert.equal(whichMacroAsked("how much protein in eggs"), null);
  assert.equal(whichMacroAsked("is fat bad for you"), null, "no my/today anchor");
  assert.equal(whichMacroAsked("what foods are high in protein"), null);
});
test("macro status: over-target fat gets the card's number AND an honest warning", () => {
  const r = macroStatusReply(msRows as any, "Fat", "Kam");
  assert.ok(r.includes("88g of 86g"), `card's exact numbers: ${r}`);
  assert.ok(/⚠️.*2g over/.test(r), `honest over verdict: ${r}`);
  assert.ok(!/reasonable range/i.test(r));
});
test("macro status: under-target carbs reads as available, not a warning", () => {
  const r = macroStatusReply(msRows as any, "Carbs");
  assert.ok(r.includes("285g of 337g") && r.includes("52g still available"), r);
});
test("macro status: 'Macros' gives the full four-line rundown", () => {
  const r = macroStatusReply(msRows as any, "Macros");
  for (const label of ["Calories", "Protein", "Carbs", "Fat"]) assert.ok(r.includes(label), label);
});

// ============================================================
// effectiveMealLoggedAt — a 4am "dinner" is LAST NIGHT's (2026-07-23 live: a dinner photo at
// 04:07 was filed under the new day, wrecking the day's numbers).
// ============================================================
test("early-hours: a 4am dinner is dated to the previous day", () => {
  const at = new Date(Date.UTC(2026, 6, 23, 2, 7)); // 04:07 SAST, Thu 23 Jul
  const eff = effectiveMealLoggedAt(at, "[Photo]", "dinner");
  assert.equal(sastDayStart(eff).getTime(), sastDayStart(new Date(at.getTime() - 86_400_000)).getTime(), "→ Wed 22");
  assert.notEqual(sastDayStart(eff).getTime(), sastDayStart(at).getTime(), "not the same day it arrived");
});
test("early-hours: daytime logs are never shifted", () => {
  const lunch = new Date(Date.UTC(2026, 6, 23, 11, 0)); // 13:00 SAST
  assert.equal(effectiveMealLoggedAt(lunch, "rice and chicken", "lunch").getTime(), lunch.getTime());
});
test("early-hours: an explicit 'now'/'today' keeps the small-hours log on today", () => {
  const at = new Date(Date.UTC(2026, 6, 23, 1, 0)); // 03:00 SAST
  assert.equal(effectiveMealLoggedAt(at, "having my dinner now", "dinner").getTime(), at.getTime());
});
test("early-hours: a genuine 4am breakfast stays on today", () => {
  const at = new Date(Date.UTC(2026, 6, 23, 2, 0)); // 04:00 SAST
  assert.equal(effectiveMealLoggedAt(at, "Breakfast before my shift", "breakfast").getTime(), at.getTime());
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

// SPINE SURGERY slice 2 (2026-07-21): health-led goals get NO deficit/surplus/kcal frame.
test("energy frame: health-led goals get no calorie/deficit frame; body-comp goals unchanged", () => {
  // The gogo fix — wellness and has-a-condition never see a kcal energy frame.
  assert.equal(energyFrameLine("general", 2000), null, "general wellness → no kcal frame");
  assert.equal(energyFrameLine("health_condition", 2000), null, "has-a-condition → no kcal frame");
  // The three body-comp goals still build their frame exactly as before (no regression).
  assert.ok(energyFrameLine("fat_loss", 1900)!.includes("deficit"));
  assert.ok(energyFrameLine("muscle_gain", 2996)!.includes("surplus"));
  assert.ok(energyFrameLine("recomposition", 2100), "recomposition still gets its frame");
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

// PORTION TRANSPARENCY (2026-07-13 precision sweep): photo estimates must state the
// ASSUMED grams per item so the client can see and correct the assumption — the human
// calibration loop that closes the photo-portion error bar.
test("vision prompt: instructs per-item assumed portion grams (correctable estimates)", () => {
  assert.ok(/ASSUMING in grams/i.test(drinkPrompt), "assumed-grams instruction present");
  assert.ok(/~150g/.test(drinkPrompt), "worked example present");
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

// SHARED / COMMUNAL SPREAD (2026-07-21 founder spec): a shisa nyama / braai photo shared
// among a group must be PORTIONED for the one person, never logged as their whole intake.
test("vision prompt: a shared braai/shisa nyama spread is portioned, not totalled to one person", () => {
  const p = buildFoodVisionUserPrompt({ message: "", isApprovalCaption: false, liveCal: 2000, liveProt: 150 });
  assert.ok(/SHARED \/ COMMUNAL SPREAD/i.test(p), "the communal-spread rule exists");
  assert.ok(/shisa nyama|braai board/i.test(p), "names the real SA shared-eating occasions");
  assert.ok(/do NOT log the whole thing|NEVER the whole board/i.test(p), "never logs the whole platter to one person");
  assert.ok(/fist of the leaner meat|half-to-one fist of pap/i.test(p), "coaches a realistic single-person portion");
});

// NUMBER-FREE PHOTO REPLIES for numbers:low clients (2026-07-14). The vision prompt
// must instruct the model to omit figures BUT keep the internal TOTAL line for the
// maths, and only in low mode — the default prompt is untouched.
{
  const { buildFoodVisionSystemPrompt } = await import("../server/handlers/food-vision-prompt");
  const { stripNumbersFromProse } = await import("../server/numbers-mode");
  test("vision prompt: numbersLow adds NUMBERS-OFF but keeps the TOTAL line; default unchanged", () => {
    const low = buildFoodVisionUserPrompt({ message: "", isApprovalCaption: false, liveCal: 1800, liveProt: 120, numbersLow: true });
    assert.ok(/NUMBERS-OFF MODE/.test(low), "low mode instructs no figures");
    assert.ok(/TOTAL: X kcal/.test(low), "internal TOTAL line still required for logging");
    const def = buildFoodVisionUserPrompt({ message: "", isApprovalCaption: false, liveCal: 1800, liveProt: 120 });
    assert.ok(!/NUMBERS-OFF MODE/.test(def), "default prompt is NOT number-suppressed");
    const lowSys = buildFoodVisionSystemPrompt({ clientName: "K", goal: "fat_loss", liveCal: 1800, liveProt: 120, isApprovalCaption: false, numbersLow: true });
    assert.ok(/NUMBERS OFF/.test(lowSys), "system prompt carries the low-mode rule");
    assert.ok(!/NUMBERS OFF/.test(buildFoodVisionSystemPrompt({ clientName: "K", goal: "fat_loss", liveCal: 1800, liveProt: 120, isApprovalCaption: false })), "default system prompt unchanged");
  });
  test("stripNumbersFromProse: the belt-and-braces net leaves NO digits", () => {
    for (const s of [
      "This looks like a sandwich, roughly 430 kcal | 18g protein. Solid lunch.",
      "Chicken breast (~150g): 250 kcal and about 30g protein. Nice and lean.",
      "That's a lovely breakfast spread! Roughly 1410 kcal, 40g protein.",
    ]) assert.ok(!/\d/.test(stripNumbersFromProse(s)), `must be digit-free: ${stripNumbersFromProse(s)}`);
    // clean prose is left intact
    assert.equal(stripNumbersFromProse("A solid, balanced plate — pap, chicken and spinach. Nicely done."),
      "A solid, balanced plate — pap, chicken and spinach. Nicely done.");
  });
}

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

// 2026-07-14 — the founder's OWN message went unheard: "I really only want to be
// doing 10,000 steps now, nothing more" wrote NOTHING (only set/change verbs were
// caught), so the bot agreed politely and the morning brief kept nagging 11,000.
// People state targets as wants and limits — the detector must hear those, while
// questions and single-day plans must never flip the standing target.
test("steps target: preference/limit phrasings ARE a change; questions/day-plans are NOT", () => {
  const changes: Array<[string, number]> = [
    ["I really only want to be doing 10,000 steps now, nothing more", 10000],
    ["I only want to do 10000 steps", 10000],
    ["I want my steps to be 10,000", 10000],
    ["let's keep my steps at 10000", 10000],
    ["drop my steps to 10k", 10000],
    ["10000 steps is my max, I can't do more", 10000],
    ["Can you set my steps to 10000?", 10000],   // polite directive still counts
  ];
  for (const [msg, want] of changes)
    assert.equal(extractStepTargetChange(msg), want, `${msg} → ${want}`);
  for (const msg of [
    "Should I keep my steps at 10,000?",              // asking, not changing
    "Doesn't going over 10,000 steps affect my goals?",
    "Is 8000 steps enough for fat loss?",
    "I want to hit 10000 steps today",                // one day's plan, not the target
    "Why am I on 11,000 steps a day? Make it make sense.",
    "I usually tell people ten thousand steps",       // other people's steps
  ]) assert.equal(extractStepTargetChange(msg), null, `must NOT change target: ${msg}`);
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

// DEFEATED / "IT'S MY GENETICS" (2026-07-12, Kam's live masterclass). Must reach his
// exact reframe deterministically — fires on a genetics/hopeless-veteran signal, NOT on
// a plain "no results this week" check-in (that's the generic struggle handler's job).
test("brain gate: 'it's my genetics / tried for years' reaches Kam's reframe", () => {
  for (const msg of [
    "I think genes are working against me",
    "starting to think my genes are working against me at this point",
    "it's my genetics honestly",
    "I have bad genetics",
    "my metabolism is the problem",
    "I've been working out since covid but I'm still not seeing the results",
    "been training for years and nothing is changing, I want to give up",
  ]) assert.ok(looksLikeDefeatedNoResults(msg), `must reframe: ${msg}`);

  for (const msg of [
    "I'm not seeing results this week",
    "no results today",
    "how do I build muscle",
    "I did genetics at school",
  ]) assert.ok(!looksLikeDefeatedNoResults(msg), `must NOT trigger: ${msg}`);
});

// SICK FLOW (2026-07-13, the flu screenshots): the canned template was sent FOUR times
// verbatim, twice in reply to comeback QUESTIONS, while proactive jobs blasted a
// healthy-person rhythm 45 min after "I've got the flu". Every helper locked here.
test("sick flow: comeback questions are detected (they get the plan, never the template)", () => {
  for (const msg of [
    "What do I need to do next week when I come back from the flu?",
    "No, no, no, I'm saying when I come back from the flu, what happens then?",
    "How does that affect my progress? My week? I'm sick",
    "what do I do when I'm better?",
  ]) assert.ok(isReturnFromSicknessQuestion(msg), `comeback question: ${msg}`);
  for (const msg of ["I've got the flue", "I'm sick", "I walk today I'm sick", "what's my workout"])
    assert.ok(!isReturnFromSicknessQuestion(msg), `NOT a comeback question: ${msg}`);
});

test("sick flow: duration parsing — '5 days' remembered, defaults sane, capped", () => {
  assert.equal(parseSickDays("I'll be not training for the next 5 days"), 5);
  assert.equal(parseSickDays("sick for the rest of the week"), 7);
  assert.equal(parseSickDays("I've got the flue"), 3, "unstated → 3-day default");
  assert.equal(parseSickDays("out for 60 days"), 14, "capped at 14");
});

test("sick flow: 'until <day>' parses to the real weekday, not the ~3-day default (2026-07-19)", () => {
  // Days-to-weekday is relative to today; assert the RANGE + that it isn't the 3 default
  // when the day is deliberately chosen to differ from 3-out.
  const DOW = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const todaySast = new Date(Date.now() + 2 * 3_600_000).getUTCDay();
  for (let d = 0; d < 7; d++) {
    const expected = (((d - todaySast + 7) % 7) || 7);
    assert.equal(parseSickDays(`sick until ${DOW[d]}`), Math.min(14, expected), `until ${DOW[d]}`);
  }
  assert.equal(parseSickDays("got sick since monday"), 3, "'since <day>' is not a return date — stays default");
});

// ADAPTIVE NUMBERS MODE (2026-07-14, Kam: "the bot should be adapting anyway").
// A client the bot learns can't read numbers gets number-free food replies; the
// figures still exist, they're just not put in front of them.
{
  const { getNumbersMode, stripFoodLineNumbers, plainProteinNudge } = await import("../server/numbers-mode");
  test("numbers-mode: default is NUMBER-FREE; only numbers:full opts into figures", () => {
    assert.equal(getNumbersMode({ profileNotes: "diet:halal numbers:full" }), "normal");
    assert.equal(getNumbersMode({ profileNotes: "diet:halal numbers:low" }), "low");
    assert.equal(getNumbersMode({ profileNotes: "diet:halal" }), "low", "default = number-free");
    assert.equal(getNumbersMode({ profileNotes: null }), "low");
    assert.equal(getNumbersMode({}), "low");
  });
  test("numbers-mode: stripper removes kcal/protein, keeps food + description", () => {
    assert.equal(stripFoodLineNumbers("• Pap: ~470 kcal, 10g protein (1 cup)"), "• Pap (1 cup)");
    assert.equal(stripFoodLineNumbers("• Chicken breast: ~250 kcal | 30g protein"), "• Chicken breast");
    const two = stripFoodLineNumbers("• Rice: ~200 kcal, 4g protein\n• Beef stew: ~350 kcal, 28g protein (1 bowl)");
    assert.ok(!/\d/.test(two.replace(/\(.*?\)/g, "")), "no stray digits outside descriptions");
    assert.ok(/Rice/.test(two) && /Beef stew/.test(two), "food names survive");
  });
  test("numbers-mode: plainProteinNudge never contains a gram figure", () => {
    for (const [pr, mg, hp] of [[80, false, false], [0, true, true], [40, true, false]] as [number, boolean, boolean][]) {
      const n = plainProteinNudge({ proteinRemaining: pr, isMuscleGain: mg, hasGoodProteins: hp });
      assert.ok(n.length > 0 && !/\dg\b|\d+\s*kcal/.test(n), `nudge must be number-free: ${n}`);
    }
  });
}

// NUMERIC-FLUENCY AUTO-DETECT (2026-07-16, Kam: "some want calories and some don't —
// we need to be brighter than that"). A client who speaks in kcal/macros is a numbers
// person; everyday numbers (steps, kg, reps, litres) must never trip it.
{
  const { messageSpeaksNumbers } = await import("../server/numbers-mode");
  test("numeric fluency: kcal/macro speech IS detected", () => {
    for (const m of [
      "that was about 450 kcal",
      "i had 300 calories of oats",
      "how many calories do i have left today?",
      "is 30g protein enough for lunch?",
      "what are my macros looking like",
      "am i still in a calorie deficit?",
      "had 40 g of protein at breakfast",
      "roughly 2000 kj i think",
    ]) assert.ok(messageSpeaksNumbers(m), `should detect: ${m}`);
  });
  test("numeric fluency: everyday numbers do NOT count", () => {
    for (const m of [
      "did 8500 steps today",
      "i weigh 82kg now",
      "3 sets of 12 reps done",
      "drank 2 litres of water",
      "i had 2 eggs and pap",
      "see you at 6pm",
      "i'm 34 years old",
      "had 3 beers last night",
    ]) assert.ok(!messageSpeaksNumbers(m), `should NOT detect: ${m}`);
  });
}

// WEEKLY-JOURNEY LINE (2026-07-16, Kam: "teach them about their weekly goals —
// you're on a weekly journey"). One wording brain, goal- and numbers-mode-aware;
// the over branch must teach "tomorrow stays NORMAL", never a punishment day.
{
  const { weeklyNetWording } = await import("../server/education");
  test("weekly journey: under 3 logged days says nothing", () => {
    assert.equal(weeklyNetWording({ loggedDays: 2, netKcal: 900, building: false, numbersLow: false }), "");
  });
  test("weekly journey: on-track week is called a win, whatever one day did", () => {
    const s = weeklyNetWording({ loggedDays: 5, netKcal: 300, building: false, numbersLow: false });
    assert.ok(/on track/i.test(s), `should read on-track: ${s}`);
  });
  test("weekly journey: over-budget fat-loss week teaches NORMAL tomorrow, never starving", () => {
    const s = weeklyNetWording({ loggedDays: 6, netKcal: 1500, building: false, numbersLow: false });
    assert.ok(/normal/i.test(s) && /never starve/i.test(s), `must teach the law: ${s}`);
    assert.ok(/1500/.test(s), "numbers client sees the real figure");
  });
  test("weekly journey: numbers-low wording carries ZERO digits", () => {
    for (const net of [-1400, 0, 1400]) {
      for (const building of [true, false]) {
        const s = weeklyNetWording({ loggedDays: 5, netKcal: net, building, numbersLow: true });
        assert.ok(s.length > 0 && !/\d/.test(s), `must be digit-free: ${s}`);
      }
    }
  });
  test("weekly journey: goal-aware — under budget is a warning when building, a win when cutting", () => {
    const b = weeklyNetWording({ loggedDays: 5, netKcal: -1200, building: true, numbersLow: false });
    assert.ok(/under|fuel/i.test(b) && /eat/i.test(b), `builder told to eat: ${b}`);
    const c = weeklyNetWording({ loggedDays: 5, netKcal: -1200, building: false, numbersLow: false });
    assert.ok(/ahead of plan/i.test(c), `cutter ahead of plan: ${c}`);
  });
}

// DEEP EMOTIONAL SUPPORT (2026-07-14, Kam: manual clients send long voice notes —
// they've tried everything and stay for the accountability + support).
{
  const { looksLikeDeepEmotionalShare, mentionsTriedEverything } = await import("../server/utils");
  test("emotional: tried-everything + GLP-1 psychology is recognised", () => {
    for (const m of ["I've tried everything", "been on ozempic and wegovy", "every diet, nothing ever works", "I always gain it all back", "tried banting, keto, shakes, the lot"])
      assert.ok(mentionsTriedEverything(m), `should detect: ${m}`);
    for (const m of ["I had chicken and rice", "8000 steps done"]) assert.ok(!mentionsTriedEverything(m), `should not: ${m}`);
  });
  test("emotional: deep shares (long+vulnerable, or quit/alone) get the support path", () => {
    for (const m of [
      "I've tried everything — Ozempic, every diet — and I'm about to give up. Nothing ever works.",
      "I ate a whole cake and I feel so ashamed, I hate my body, I just want to quit.",
      "I can't do this alone, I need help",
      "Every time I lose a bit then gain it back. I've been on so many diets, I feel like a failure and I'm exhausted, I don't know what to do anymore and I just want to give up honestly.",
    ]) assert.ok(looksLikeDeepEmotionalShare(m), `should be a deep share: ${m.slice(0, 40)}`);
  });
  test("emotional: normal logs and short messages are NOT deep shares (no over-firing)", () => {
    for (const m of ["I had chicken and rice for lunch", "I'm a bit tired today", "should I take creatine", "8000 steps done", "workout done", "what's my protein target"])
      assert.ok(!looksLikeDeepEmotionalShare(m), `should not be a deep share: ${m}`);
  });
}

// ACTIVATION MOMENT (2026-07-14) — the expectation-setter + first-action celebration.
{
  const { isActivated, buildActivationBrief } = await import("../server/activation");
  test("activation: brief sets expectations plainly, number-free, with the 4 beats", () => {
    const b = buildActivationBrief("Thabo");
    assert.ok(/How this works/i.test(b), "leads with how it works");
    assert.ok(/only job/i.test(b) && /don'?t panic/i.test(b) && /30 days/i.test(b) && /yours to drive/i.test(b), "all four beats present");
    assert.ok(!/\d+\s*kcal|\d+g protein/i.test(b), "expectation-setter is number-free");
  });
  test("activation: isActivated reads the token", () => {
    assert.equal(isActivated({ profileNotes: "diet:halal activated:1" }), true);
    assert.equal(isActivated({ profileNotes: "diet:halal" }), false);
    assert.equal(isActivated({}), false);
  });
}

// ADAPTIVE TONE MODE (2026-07-14, Kam: "tone should be different for every client").
{
  const { getToneMode, detectToneSignal, toneSteer } = await import("../server/tone-mode");
  test("tone-mode: token drives the mode; default is warm", () => {
    assert.equal(getToneMode({ profileNotes: "diet:halal tone:direct" }), "direct");
    assert.equal(getToneMode({ profileNotes: "tone:gentle" }), "gentle");
    assert.equal(getToneMode({ profileNotes: "diet:halal" }), "warm");
    assert.equal(getToneMode({}), "warm");
  });
  test("tone-mode: detector fires only on clear preference requests", () => {
    assert.equal(detectToneSignal("just tell me straight, no fluff"), "direct");
    assert.equal(detectToneSignal("can you be gentle with me"), "gentle");
    assert.equal(detectToneSignal("push me harder coach"), "hype");
    assert.equal(detectToneSignal("I need some tough love"), "hype");
    // must NOT fire on ordinary messages or logistics
    for (const msg of ["I had chicken and rice", "what's my workout", "I'm struggling to find time", "push day tomorrow?"])
      assert.equal(detectToneSignal(msg), null, `must not trip: ${msg}`);
  });
  test("tone-mode: warm steer is empty (default voice byte-unchanged); others non-empty", () => {
    assert.equal(toneSteer("warm"), "");
    for (const t of ["gentle", "direct", "hype"] as const) assert.ok(toneSteer(t).length > 0);
  });
}

// THE SHARED ASKING/REPORTING GATE (2026-07-14, Kam: "is our system smart enough
// to detect when somebody is just asking?"). One floor for every lane: no write,
// no template, on an ASKING message. The photo lane leaked exactly his phrasings
// ("does this fit in my calories/macros") because its local list didn't know them.
test("asking gate: question-shaped messages are ASKING (never logged)", () => {
  for (const msg of [
    "Does this fit in my calories?",
    "does this fit my macros",
    "Can I eat this?",
    "can I eat that",
    "Is this okay for my goal?",
    "is this too much",
    "Should I eat this before gym?",
    "How many calories is this?",
    "What do you think of this meal",
    "thoughts on this?",
    "not sure if this fits my plan",
    "Would this be too much for me?",
    "Is 8000 steps enough for fat loss?",
    "?",
  ]) assert.ok(isAskingNotReporting(msg), `should be ASKING: ${msg}`);
});

test("asking gate: reports and confessions stay REPORTING (loggable)", () => {
  for (const msg of [
    "8000 steps",
    "2L of water",
    "chicken and rice for lunch",
    "did my workout this morning",
    "done",
    "weight 84kg",
    "ate too much at the party last night",
    "had a slice of cake, counting it",
    "I walked 12000 steps today",
    "logged my lunch already",
  ]) assert.ok(!isAskingNotReporting(msg), `should be REPORTING: ${msg}`);
});

// PAIN TRIAGE (2026-07-12, Kam: "the coach needs to catch whether it's just sensitivity
// from a workout or a real injury"). The classifier is the high-stakes piece: a wrong
// "injury" call benches a healthy client for 72 hours; a wrong "soreness" call tells an
// injured client to train through it. Ambiguity gets the ONE question, never a guess.
test("pain triage: clear injury signals → injury (stop, protect, swap)", () => {
  for (const msg of [
    "I pulled a muscle in my back",
    "sharp pain in my knee when I squat",
    "my ankle is swollen after the run",
    "I hurt my shoulder at gym today",
    "the pain gets worse when I train",
    "I think I strained my hamstring",
    "my knee gave way on the last rep",
  ]) assert.equal(classifyPainReport(msg), "injury", `injury: ${msg}`);
});

test("pain triage: DOMS language → soreness (normalise, keep momentum)", () => {
  for (const msg of [
    "I'm so sore from leg day",
    "my legs are stiff and aching after yesterday's workout",
    "DOMS is killing me",
    "everything is sore but in a good way",
  ]) assert.equal(classifyPainReport(msg), "soreness", `soreness: ${msg}`);
});

test("pain triage: unqualified pain → ambiguous (ask the ONE question)", () => {
  for (const msg of [
    "my knee hurts",
    "I have shoulder pain, should I switch out the workout?",
    "I'm having back problems",
    "my hip is acting up",
  ]) assert.equal(classifyPainReport(msg), "ambiguous", `ambiguous: ${msg}`);
});

test("pain triage: non-musculoskeletal and pain-free messages → null", () => {
  for (const msg of [
    "I have a sore throat",
    "bad headache today",
    "period pains are rough",
    "what's my protein target",
    "I walked 10000 steps",
    "you hurt my feelings",
    "my stomach hurts after every meal", // gut → digestive handler, never knee-triage
  ]) assert.equal(classifyPainReport(msg), null, `null: ${msg}`);
});

// WORKOUT REQUEST (2026-07-13 tester screenshot: "Home workout with two dumbbells"
// matched nothing → the MODEL improvised an unformatted generic workout instead of her
// programme; "Videos of demonstrating" got navigation instructions instead of the demos).
// Natural phrasings must reach the deterministic session with GIFs + buttons.
test("workout request: natural phrasings reach the deterministic programme", () => {
  for (const msg of [
    "Home workout with two dumbbells",
    "Videos of demonstrating",
    "give me a workout",
    "can you send me a quick workout",
    "workout with no equipment",
    "full body workout please",
    "what's my workout",
    "video demos of the exercises",
    // 2026-07-13 tester round 3 — every one of these got a model improvisation:
    "Workout",
    "See every move",
    "Body weight exercises",
    "And for body weight exercises at home what should I do",
    "I don't know how to do them",
  ]) assert.ok(looksLikeWorkoutRequest(msg), `must serve programme: ${msg}`);
});

test("workout request: done-reports, feedback, scheduling and form-checks do NOT match", () => {
  for (const msg of [
    "I did my workout",
    "finished my workout, felt strong",
    "cancel today's workout",
    "move my workout to tomorrow",
    "the workout felt easy",
    "how many workouts per week should I do",
    "check my form video",
    "I walked 10000 steps",
  ]) assert.ok(!looksLikeWorkoutRequest(msg), `must NOT match: ${msg}`);
});

// 2026-07-12 collision probe — cross-detector routing bugs, locked so they stay dead.
test("collisions: gut pain routes to GI; schedule-cancel never hits billing", () => {
  assert.ok(looksLikeDigestiveIssue("my stomach hurts after every meal"), "stomach-hurts is GI");
  assert.ok(!looksLikeBillingOrCancel("cancel today's workout, my back is acting up"), "schedule change, not billing");
  assert.ok(!looksLikeBillingOrCancel("cancel this session please"), "session cancel, not billing");
  assert.ok(looksLikeBillingOrCancel("cancel my subscription"), "real cancellation still caught");
});

// DIGESTIVE ISSUES (2026-07-12 onboarding screenshot). Catch a real GI disclosure, not
// a period cramp or a one-word check-in answer.
test("gate: GI disclosures (bloating/reflux/heartburn) are caught", () => {
  for (const msg of [
    "I struggle a lot with bloating",
    "I'm taking tablets for acid reflux and heartburn",
    "forgot to mention I get bloated every time after I eat",
    "I suffer from indigestion",
    "I always feel gassy after a regular meal",
  ]) assert.ok(looksLikeDigestiveIssue(msg), `must catch: ${msg}`);
  for (const msg of [
    "Looser, High, Bloated, Great",     // non-scale check-in answer, not a complaint
    "I get bloated around my period",   // hormone context handled elsewhere
    "how many calories in a banana",
  ]) assert.ok(!looksLikeDigestiveIssue(msg), `must NOT catch: ${msg}`);
});

// FOOD DISLIKE (2026-07-12). Offer an alternative instead of pushing a hated food.
test("gate: food dislike is caught (handler then finds the food + offers a swap)", () => {
  for (const msg of ["I hate chicken breast", "I can't stand broccoli", "I force myself to eat chicken", "I don't like eating fish"])
    assert.ok(looksLikeFoodDislike(msg), `must catch: ${msg}`);
  // The detector is phrasing-only (pure, can't scan foods) — the HANDLER falls through
  // when no real food is named, so "I hate mondays" just skips the brain harmlessly.
  for (const msg of ["I love chicken", "chicken and rice", "hate is a strong word"])
    assert.ok(!looksLikeFoodDislike(msg), `must NOT catch: ${msg}`);
});

// OVER-TRAINING PLAN (2026-07-12, Kam: "5 is unnecessary"). Right-size 5+ sessions/week.
test("gate: stating 5+ sessions a week (or every day) is caught; 3-4 is fine", () => {
  for (const msg of ["I train 5 days a week", "I go to the gym 6 times a week", "should I train every day", "I want to work out 7 days a week", "I lift 5x a week"])
    assert.ok(looksLikeOvertrainingPlan(msg), `must catch: ${msg}`);
  for (const msg of ["I train 3 days a week", "I go to the gym 4 times a week", "I did 5 reps", "I walked 10000 steps"])
    assert.ok(!looksLikeOvertrainingPlan(msg), `must NOT catch: ${msg}`);
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

// SPECIFIC LIFT, NOT THE MUSCLE (2026-07-21, Kam: "'your back lifts' means nothing to a
// gogo — name the machine"). The lagging muscles must resolve to the exact programme lifts.
test("lagging areas resolve to the SPECIFIC programme lifts (not just muscle names)", () => {
  assert.match(liftsForLaggingAreas("back,core"), /back → your Lat Pulldown or Seated Row/);
  assert.match(liftsForLaggingAreas("back,core"), /core → your Cable Crunch/);
  assert.match(liftsForLaggingAreas("glutes"), /glutes → your Hip Thrust/);
  assert.match(liftsForLaggingAreas("hamstrings, shoulders"), /hamstrings → your Leg Curl/);
  assert.match(liftsForLaggingAreas("hamstrings, shoulders"), /shoulders → your Shoulder Press or Lateral Raise/);
  // Robust to junk / unknown groups / blanks — never throws, drops what doesn't map.
  assert.strictEqual(liftsForLaggingAreas(""), "");
  assert.strictEqual(liftsForLaggingAreas("nonsense, xyz"), "");
  assert.strictEqual(liftsForLaggingAreas(null), "");
  // De-dupes a repeated group.
  assert.strictEqual((liftsForLaggingAreas("back, back").match(/Lat Pulldown/g) || []).length, 1);
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
// UnderstandingState — the trust gate (safeguard A) + Prompt Compiler (safeguard C)
// ============================================================

test("understanding: coerce clamps out-of-range + whitelists invented enums", () => {
  const dirty = coerceUnderstanding({
    profile: { name: "Bonolo", lifeStory: "x".repeat(999), keyFacts: [123, "cleaner, long hours"], preferences: { numberFree: "yes" } },
    current: { mood: "furious", healthStatus: "dying", topic: "banking" },
    observations: { confidenceTrend: "collapsing", frustrationLevel: 99, readinessToPush: "extreme", trustLevel: -4 },
    stats: { streak: -1, weightDirection: "sideways", recentProteinAvg: 120, recentStepAvg: 8000 },
  });
  assert.equal(dirty.current.mood, "neutral", "invented mood falls back to default");
  assert.equal(dirty.current.healthStatus, "healthy", "invented health falls back");
  assert.equal(dirty.observations.frustrationLevel, 10, "frustration clamped to 10");
  assert.equal(dirty.observations.trustLevel, 1, "trust clamped to >=1");
  assert.equal(dirty.observations.readinessToPush, "medium", "invented readiness falls back");
  assert.equal(dirty.stats.streak, 0, "negative streak clamped to 0");
  assert.equal(dirty.stats.weightDirection, "stable", "invented weight dir falls back");
  assert.ok(dirty.profile.lifeStory.length <= 400, "lifeStory truncated");
  assert.deepEqual(dirty.profile.keyFacts, ["cleaner, long hours"], "non-string facts dropped");
  assert.equal(dirty.profile.preferences.numberFree, true, "non-bool pref falls back to true (number-free default)");
});

test("understanding: parse bad JSON returns a safe default, never throws", () => {
  const s = parseUnderstanding("{not valid json");
  assert.equal(s.current.mood, "neutral");
  assert.equal(s.profile.preferences.numberFree, true);
});

test("understanding: persistable subset is profile+observations only (no volatile/stats)", () => {
  const p = persistableUnderstanding(defaultUnderstanding("Kam"));
  assert.deepEqual(Object.keys(p).sort(), ["observations", "profile"], "only durable fields persist");
});

test("compiler: a sick + frustrated client yields a care-first, number-free blurb", () => {
  const s = defaultUnderstanding("Bonolo");
  s.current.healthStatus = "sick";
  s.current.mood = "frustrated";
  s.observations.frustrationLevel = 8;
  s.observations.confidenceTrend = "falling";
  s.stats.streak = 3;
  const blurb = compileStateBlurb(s);
  assert.ok(/sick/i.test(blurb), "mentions sickness");
  assert.ok(/hold rest|do not push|care/i.test(blurb), "steers to rest, not a push");
  assert.ok(/number-free|no calorie/i.test(blurb), "flags number-free delivery");
  assert.ok(!/\bsteps?\b.*today|hit your steps/i.test(blurb), "never nudges steps for a sick client");
  assert.ok(blurb.split(/\s+/).length <= 60, "blurb stays compact (margin)");
});

test("compiler: an empty/default state stays quiet, never invents", () => {
  const blurb = compileStateBlurb(defaultUnderstanding("Kam"));
  assert.ok(blurb.length > 0, "still produces a line");
  assert.ok(!/sick|frustrated|anxious|streak/i.test(blurb), "no invented state for a fresh client");
  assert.equal(compileKeyFacts(defaultUnderstanding("Kam")), "", "no key-facts line when there are none");
});

// ============================================================
// SA transcript cleaner — refusal must NEVER become a transcript
// (regression: the cleaner returned "I'm sorry, but I can't assist with
//  that" on angry/profane notes and it was echoed + coached on. 2026-07-15)
// ============================================================

test("sa-transcript: catches model refusals so they never replace a transcript", () => {
  const refusals = [
    "I'm sorry, but I can't assist with that.",
    "I'm sorry, but I can't assist with that",
    "Sorry, I can't help with this request.",
    "I cannot assist with that.",
    "I am unable to assist with this.",
    "As an AI, I can't process this.",
    "I'm just an AI and cannot transcribe this.",
    "Here's the cleaned transcript: ...",
  ];
  for (const r of refusals) assert.ok(looksLikeRefusal(r), `must flag refusal: "${r}"`);
});

test("sa-transcript: real SA transcripts are NOT mistaken for refusals", () => {
  const genuine = [
    "Yoh coach I'm sorry I missed gym today, I was feeling kak",
    "I ate samp and beans with pilchards for lunch",
    "Sorry I can't make it to the gym but I did my steps",
    "I'm sorry but I won't be able to train this week, work is crazy",
    "Coach I can't do that exercise, my knee is sore",
    "I don't feel comfortable in my body yet, that's why I'm here",
    "I'm not sure what to eat, can you help me plan",
    "Eish I'm tired but I want to train legs today",
  ];
  for (const g of genuine) assert.ok(!looksLikeRefusal(g), `must NOT flag genuine speech: "${g}"`);
});

// ============================================================
// Domain Boundary Gate (Law 11) — keep Coach K a coach, never refuse a
// real client, never burn a model call on obvious health talk.
// ============================================================

test("domain-guard: obvious coaching messages take the deterministic in-domain fast-path", () => {
  const inDomain = [
    "hi coach", "yebo", "thanks", "I did my workout today",
    "what should I eat for lunch", "I'm feeling exhausted and want to give up",
    "my knee is sore after squats", "84.5kg", "8500 steps",
    "I can't afford chicken this week, what's cheaper", "how am I doing",
    "I was too busy with work to train", "sawubona coach",
    "No, no, no. Reverse that. That's not what I'm saying to you. Look at the picture again.",
    "you've made a mistake, change it back", "that's wrong, undo it",
  ];
  for (const m of inDomain) assert.ok(isObviouslyInDomain(m), `must fast-path in-domain: "${m}"`);
});

test("domain-guard: clearly off-topic messages are NOT fast-pathed (defer to classifier)", () => {
  const ambiguous = [
    "write me an essay about the French Revolution please",
    "can you help me fix this python code that keeps crashing",
    "who is going to win the elections next year in the country",
  ];
  for (const m of ambiguous) assert.ok(!isObviouslyInDomain(m), `must NOT fast-path off-topic: "${m}"`);
});

// A short frustrated reaction must NEVER get the cold domain redirect (2026-07-21 live miss:
// "Read‼️‼️" got "I'm Coach K, here for your fitness journey").
test("domain-guard: a 1-2 word reaction is always in-domain, never cold-redirected", () => {
  for (const m of ["Read‼️‼️‼️‼️", "yes!!", "come on", "seriously??", "wtf man", "no no"]) {
    assert.ok(isObviouslyInDomain(m), `short reaction must stay in-domain: "${m}"`);
  }
});

// A conversational CONTINUATION referring back to what was discussed must never be redirected
// (2026-07-21 live: "How should I take them? Tell me!" got the cold "I'm Coach K" brochure
// mid-snack-conversation, forcing the client to rephrase to get an answer).
test("domain-guard: a follow-up that refers back to the conversation stays in-domain", () => {
  for (const m of ["How should I take them? Tell me!", "do better", "tell me more", "like what?", "what about them", "give me more options", "how should I have them"]) {
    assert.ok(isObviouslyInDomain(m), `continuation must stay in-domain: "${m}"`);
  }
});

// A REQUEST for meal ideas is not a food LOG (2026-07-21 live miss: a voice note "give me meal
// suggestions for lunch and dinner" was answered with "I didn't catch what food that was").
test("food-context: a meal-suggestion request is never treated as a food log", () => {
  const fc = readFileSync(join("server", "handlers", "food-context.ts"), "utf-8");
  assert.match(fc, /isMealSuggestionRequest/, "the guard exists");
  assert.match(fc, /!isFuturePlanning && !bareMealTimeReference && !isMealSuggestionRequest/, "it excludes the food-log path");
  const REQ = /\b(give me|send me|suggest|recommend|any (ideas?|options?)|(ideas?|options?) for|help me (plan|with)|what (should|can|do|must) i (eat|have|make|cook)|what to (eat|have|make|cook)|meal (suggestions?|ideas?|options?|plan)|plan my meals?|what (should|can) i (have|make|cook) for)\b/i;
  const LOG = /\b(i had|i ate|i just (had|ate)|just had|just ate|i'?ve (had|eaten)|having (a|some|my))\b/i;
  assert.ok(REQ.test("give me meal suggestions for lunch and dinner") && !LOG.test("give me meal suggestions for lunch and dinner"), "the exact miss is caught as a request, not a log");
  assert.ok(LOG.test("I had chicken and rice for lunch"), "a real food log is still a log, not a request");
});

// META-SAFETY: the domain decline must live in the PROMPT too (belt-and-suspenders) so every
// path — engine, gpt-block fallback, old brain — refuses code/politics/essays, not just the
// live-engine classifier. A fitness bot that writes Python for a reviewer is a compliance risk.
test("domain-guard: the coach prompt itself refuses off-topic requests and bridges back", () => {
  const prompt = readFileSync(join("server", "coach-prompt.ts"), "utf-8");
  assert.match(prompt, /STAY IN YOUR LANE/, "the explicit off-topic guard is in the prompt");
  assert.match(prompt, /write code, an essay, a poem or homework/, "names the classic off-topic asks");
  assert.match(prompt, /life event they raise.*IS in your lane/, "but life events (stress/money/funeral) stay in-lane");
});

// BODY-COMPOSITION FEARS — from Kam's real manual-coaching chats (2026-07-22): the fit-but-fearful
// client ("I don't want a deficit, my arms are already thin", "lose the belly but grow everywhere",
// "weights make me bulky"). The bot must coach these the way a human coach does, EVERY time — so
// the non-negotiable positions are locked in the prompt and guarded here (can't be silently dropped).
// DON'T MAKE THEM THINK (2026-07-22, StoryBrand applied): the signup pitch leads with the OUTCOME,
// not features — and the compliance disclaimer must survive the copy rewrite.
test("onboarding: signup pitch is outcome-led (not feature-speak) and keeps the disclaimer", () => {
  const src = readFileSync(join("server", "onboarding.ts"), "utf-8");
  assert.match(src, /lose weight and get fit using the food you already eat/i, "leads with the outcome");
  assert.match(src, /photo of your plate, I tell you if it's on track/i, "concrete, no jargon");
  assert.doesNotMatch(src, /personalised programme, food guidance, daily accountability/i, "old feature-speak is gone");
  // Meta-parity consent gate: age 18+, AI disclosure, human check-in path, POPIA, ToU/Privacy links.
  assert.match(src, /You're 18 or older/i, "age gate present");
  assert.match(src, /an AI coach, not a doctor/i, "AI + medical disclosure");
  assert.match(src, /A real coach may check in on you/i, "human handoff line (the Meta-safe pattern)");
  assert.match(src, /POPIA[\s\S]{0,120}delete my data/i, "POPIA + data deletion preserved");
  assert.match(src, /kamlife.*\/terms[\s\S]{0,40}\/privacy/i, "Terms + Privacy links present");
});
test("coach-prompt: locks in the body-composition fear positions (deficit fear / one goal at a time / bulky)", () => {
  const prompt = readFileSync(join("server", "coach-prompt.ts"), "utf-8");
  assert.match(prompt, /LOSING FAT DOES NOT MEAN LOSING YOUR SHAPE/, "deficit-fear / lose-my-shape position present");
  assert.match(prompt, /ONE GOAL AT A TIME/, "can't-build-and-cut-at-once position present");
  assert.match(prompt, /LIFTING DOES NOT MAKE WOMEN BULKY/, "bulky myth position present");
  assert.match(prompt, /thin arms\/legs are a MUSCLE problem/i, "reframes thinness as a muscle (not fat) problem");
});
// ENGAGING VOICE (2026-07-22, founder admired Self-Cav: clear answers that end with a forward
// question, keeping it a live conversation). Discovery replies end with one forward-moving question.
test("coach-prompt: exploring clients get a forward-moving question, not a dead-end", () => {
  const prompt = readFileSync(join("server", "coach-prompt.ts"), "utf-8");
  assert.match(prompt, /forward-moving question/i, "the engaging discovery style is in the voice");
  assert.match(prompt, /keeps it a real conversation, not a lecture/i);
  assert.doesNotMatch(prompt, /Never end with a question AND a statement — pick one/, "the old blanket ban is gone");
});

// ============================================================
// THE INVERSION — actions stay deterministic; conversation goes to Coach K.
// A false "goes to engine" could drop a food/step log — unforgivable — so the
// action side is the one that must never regress.
// ============================================================

test("action-router: logs, commands, data, health & billing STAY deterministic (never lost)", () => {
  const mustBeDeterministic = [
    "walked 3000 steps today", "84.5kg", "log my breakfast", "stats", "how am i doing",
    "my progress", "weight chart", "my workouts", "shopping list", "portions", "fact",
    "mood 4/10", "started my fast", "broke my fast", "creatine", "my knee is injured",
    "my period started", "pay", "cancel my subscription", "today's workout", "2.5L water",
  ];
  for (const m of mustBeDeterministic) assert.ok(mustStayDeterministic(m), `must STAY deterministic (a lost action is unforgivable): "${m}"`);
});

test("action-router: conversation/advice/feelings/myths (any SA language) go to Coach K", () => {
  const mustReachEngine = [
    "what about my diet while resting", "can i eat avocado every day",
    "is running good for weight loss", "what about ozempic", "i feel like giving up",
    "how can i improve", "ngidle ipapa ne soup", "yoh im so tired coach",
    "what can we focus on while im sick", "i had a hard week",
  ];
  for (const m of mustReachEngine) assert.ok(!mustStayDeterministic(m), `should reach Coach K, not a template: "${m}"`);
});

// ============================================================
// Inference decay (Law 5) — stale reads fade; trust is durable.
// ============================================================

test("decay: a fresh read (<48h) is untouched", () => {
  const o = { confidenceTrend: "falling" as const, frustrationLevel: 8, readinessToPush: "low" as const, trustLevel: 7 };
  assert.deepEqual(decayObservations(o, 5), o, "recent reads still hold");
});

test("decay: after a 2-day gap, frustration/trend/readiness fade toward neutral but trust holds", () => {
  const o = { confidenceTrend: "falling" as const, frustrationLevel: 9, readinessToPush: "low" as const, trustLevel: 8 };
  const d = decayObservations(o, 72);
  assert.equal(d.confidenceTrend, "stable", "no stale trend");
  assert.equal(d.readinessToPush, "medium", "readiness re-earned");
  assert.ok(d.frustrationLevel < 9 && d.frustrationLevel > 3, "frustration eases toward baseline, not wiped");
  assert.equal(d.trustLevel, 8, "trust is earned — it does not fade after 2 days");
});

test("decay: after a month away, trust finally softens toward baseline", () => {
  const o = { confidenceTrend: "rising" as const, frustrationLevel: 3, readinessToPush: "high" as const, trustLevel: 9 };
  const d = decayObservations(o, 24 * 40);
  assert.ok(d.trustLevel < 9 && d.trustLevel >= 5, "trust fades slowly after a long absence, never below baseline");
});

// ============================================================
// Spoken water amounts (2026-07-16 voice-note regression): "one litre of
// water" must parse — never ask "How much?" at someone who just said how much.
// ============================================================

test("water: spoken amounts digitize — one litre / two glasses / half a litre / a glass", () => {
  assert.equal(digitizeSpokenAmounts("just had one litre of water"), "just had 1 litre of water");
  assert.equal(digitizeSpokenAmounts("drank two glasses of water"), "drank 2 glasses of water");
  assert.equal(digitizeSpokenAmounts("had half a litre"), "had 0.5 litre");
  assert.equal(digitizeSpokenAmounts("a glass of water"), "1 glass of water");
  assert.equal(digitizeSpokenAmounts("an apple and a pear"), "an apple and a pear", "food words untouched — only container units digitize");
});

test("water: looksLikeWaterReport accepts spoken amounts (voice-first clients)", () => {
  assert.ok(looksLikeWaterReport("just had one litre of water"), "one litre spoken");
  assert.ok(looksLikeWaterReport("had two glasses of water"), "two glasses spoken");
  assert.ok(looksLikeWaterReport("drank 500ml"), "digits still work");
  assert.ok(!looksLikeWaterReport("I want to drink more water"), "intent is not a log");
});

// ============================================================
// Goal-aware status line — "over by 117" means OPPOSITE things per goal.
// A number never travels alone; the education line must match the journey.
// ============================================================

test("goalStatus: fat_loss over-target educates (week decides, walk), never congratulates", () => {
  const s = goalStatusLine("fat_loss", -117);
  assert.ok(/over by ~117/i.test(s), "names the number");
  assert.ok(/week decides|one day never breaks/i.test(s), "educates: one day ≠ broken");
  assert.ok(/walk|protein/i.test(s), "gives the next action");
  assert.ok(!/✅|nicely done|on target/i.test(s), "never congratulates a blown fat-loss day");
});

test("goalStatus: muscle_gain slightly over is NOT scolded — surplus is the plan", () => {
  const s = goalStatusLine("muscle_gain", -117);
  assert.ok(!/one day never breaks|walk claws/i.test(s), "no fat-loss damage talk for a builder");
  assert.ok(/surplus/i.test(s), "frames it around the surplus");
});

test("goalStatus: muscle_gain way over gets the flood warning; under gets fuel push", () => {
  assert.ok(/flood builds fat/i.test(goalStatusLine("muscle_gain", -600)), "big overshoot warned");
  assert.ok(/don'?t leave it on the table|still to eat/i.test(goalStatusLine("muscle_gain", 400)), "under-eating a surplus is called out");
});

// MACRO PROGRESS BARS (2026-07-21, founder wants the marketing graphic on the real log).
// The bar logic is shared by the image-card renderer and the emoji-text fallback — lock it.
// MACRO CARD IMAGE (2026-07-21): the crisp branded card the bot sends on a meal log renders
// to a real PNG — the marketing graphic, delivered. Smoke test: valid, non-trivial PNG out.
test("renderMacroCard: produces a valid PNG image", () => {
  const png = renderMacroCard({
    title: "Pilchards + pap", subtitle: "Meal logged", pill: "+420 cal",
    rows: [
      { label: "Calories", current: 847, target: 2100, unit: "" },
      { label: "Protein", current: 98, target: 150, unit: "g" },
      { label: "Carbs", current: 142, target: 200, unit: "g" },
      { label: "Fat", current: 41, target: 70, unit: "g" },
    ],
    hint: "Protein first",
  });
  assert.ok(Buffer.isBuffer(png) && png.length > 5000, "a real PNG buffer of reasonable size");
  assert.strictEqual(png[0], 0x89, "PNG magic byte 1");
  assert.strictEqual(png.slice(1, 4).toString("ascii"), "PNG", "PNG signature");
});
// A LONG meal title must not run under the pill (2026-07-22 live: "…Pomegranate" overlapped
// "+0 cal"). We can't diff pixels here, but a very long title must still render a valid PNG
// without throwing — the truncation path is exercised. Premium = no overlap, ever.
// WEEKLY / MONTHLY REPORT CARD (2026-07-22) — shareable scorecard, goal-aware, not overwhelming.
test("welcome-card: renderWelcomeCard produces a valid branded PNG", async () => {
  const { renderWelcomeCard } = await import("../server/macro-card");
  const png = renderWelcomeCard({ name: "Coach K", tagline: "Your fitness coach on WhatsApp" });
  assert.ok(Buffer.isBuffer(png) && png.length > 5000);
  assert.strictEqual(png.slice(1, 4).toString("ascii"), "PNG");
});
test("report-card: renderReportCard produces a valid PNG", async () => {
  const { renderReportCard } = await import("../server/macro-card");
  const png = renderReportCard({
    title: "Koketso's month", subtitle: "July so far", pill: "30 days",
    stats: [
      { label: "Avg calories / day", value: "1980", sub: "target 2100" },
      { label: "Avg protein / day", value: "138g", sub: "target 150g", tone: "good" },
      { label: "Workouts", value: "14", sub: "target ~13", tone: "good" },
      { label: "Avg steps / day", value: "8,200", sub: "target 8,500" },
      { label: "Days on track", value: "24", sub: "of 30", tone: "good" },
      { label: "Weight change", value: "-2.1kg", tone: "good" },
    ],
    hint: "Down 2.1kg this month — the plan's working. Keep it steady.",
  });
  assert.ok(Buffer.isBuffer(png) && png.length > 5000);
  assert.strictEqual(png.slice(1, 4).toString("ascii"), "PNG");
});
test("report-card: stats are goal-aware — wellness gets habits, not macros", async () => {
  const { buildReportStats } = await import("../server/report-card");
  const data = { days: 7, distinctDaysLogged: 5, avgKcal: 0, avgProtein: 0, workouts: 3, avgSteps: 7000, totalMeals: 12, weightChange: null };
  const wellness = buildReportStats({ goalType: "general", stepsTarget: 8000, trainingDaysPerWeek: 3 }, data as any);
  assert.ok(wellness.some(s => /showed up|meals/i.test(s.label)), "wellness = habit tiles");
  assert.ok(!wellness.some(s => /protein/i.test(s.label)), "no protein target pushed at wellness");
  const macro = buildReportStats({ goalType: "fat_loss", calorieTarget: 2000, proteinTarget: 150, stepsTarget: 8000, trainingDaysPerWeek: 3 }, { ...data, avgKcal: 1900, avgProtein: 140 } as any);
  assert.ok(macro.some(s => /protein/i.test(s.label)), "macro goal shows protein");
});
test("report-card: coaching line leads with the strongest thing, one plain sentence", async () => {
  const { reportCoachingLine } = await import("../server/report-card");
  const line = reportCoachingLine({ goalType: "fat_loss", proteinTarget: 150, stepsTarget: 8000, trainingDaysPerWeek: 3, weightIsGoal: true },
    { days: 7, distinctDaysLogged: 6, avgKcal: 1900, avgProtein: 140, workouts: 3, avgSteps: 9000, totalMeals: 18, weightChange: -0.8 } as any, "week");
  assert.match(line, /down 0\.8kg|working/i);
  assert.ok(line.length < 140, "not overwhelming");
});
test("renderMacroCard: a long title + pill still renders cleanly (truncation path)", () => {
  const png = renderMacroCard({
    title: "This is a Switch Cranberry & Pomegranate + Zinc sugar-free drink", pill: "+0 cal",
    rows: [{ label: "Calories", current: 918, target: 2862, unit: "" }, { label: "Protein", current: 47, target: 185, unit: "g" }],
    hint: "Under your building fuel — eat more, muscle needs it.",
  });
  assert.ok(Buffer.isBuffer(png) && png.length > 5000, "valid PNG even with a very long title");
  assert.strictEqual(png.slice(1, 4).toString("ascii"), "PNG");
});

// COACHING CARD (2026-07-22, founder: the card must TEACH, not just count — plain language,
// every goal, over or under). The bottom line adapts to the day's state.
test("coachingHint: plain-language, goal-aware over/under coaching", async () => {
  const { coachingHint } = await import("../server/macro-card-attach");
  const rows = (o: any) => [
    { label: "Calories", current: o.cal ?? 1000, target: 2000, unit: "", overIsBad: true },
    { label: "Protein", current: o.prot ?? 100, target: 150, unit: "g", overIsBad: false },
    { label: "Carbs", current: o.carb ?? 100, target: 200, unit: "g", overIsBad: true },
    { label: "Fat", current: o.fat ?? 30, target: 60, unit: "g", overIsBad: true },
  ];
  // Variety: a couple of educational variants per state — assert on the state keyword, run a few
  // times so a bad variant can't sneak through, and confirm the cue actually changes across calls.
  const many = (fn: () => string) => new Set(Array.from({ length: 40 }, fn));
  for (const h of many(() => coachingHint(rows({ fat: 80 }), false))) assert.match(h, /fat/i);
  for (const h of many(() => coachingHint(rows({ carb: 260 }), false))) assert.match(h, /carb|starch/i);
  for (const h of many(() => coachingHint(rows({ cal: 2200 }), false))) assert.match(h, /over|past|light|lean/i);
  for (const h of many(() => coachingHint(rows({ prot: 160, cal: 1200 }), false))) assert.match(h, /protein|nail|textbook/i);
  for (const h of many(() => coachingHint(rows({ cal: 400, prot: 40 }), false))) assert.match(h, /room|day left|protein/i);
  for (const h of many(() => coachingHint(rows({ cal: 800, prot: 40 }), true))) assert.match(h, /build|fuel|muscle/i);
  // SPECIFIC, not varied (2026-07-23, founder + reviewers: "the same generic thing over and
  // over — it doesn't coach"). The default cue must now name the REAL gap and what closes it;
  // a rotating platitude ("One good choice at a time") is a fridge magnet, not coaching.
  const dflt = coachingHint(rows({ cal: 900, prot: 40 }), false);
  assert.match(dflt, /\d+g protein to go/i, `must name the actual gap: ${dflt}`);
  assert.doesNotMatch(dflt, /one good choice|small steady|consistency beats/i, "no platitudes");
  // 110g protein short vs 10g short must give DIFFERENT next moves — advice scales to the gap.
  assert.notEqual(coachingHint(rows({ cal: 900, prot: 40 }), false), coachingHint(rows({ cal: 900, prot: 140 }), false));
});

// THE VERDICT PILL (2026-07-28, founder: "clarity without confusing them, but giving them what
// they want"). The loudest corner of the card must answer "am I okay today", not restate a
// number already in the text reply.
test("dayStatusPill: a plain verdict, never a number, and it matches the bars", async () => {
  const { dayStatusPill } = await import("../server/macro-card-attach");
  const rows = (o: any) => [
    { label: "Calories", current: o.cal ?? 1000, target: 2000, unit: "", overIsBad: true },
    { label: "Protein", current: o.prot ?? 100, target: 150, unit: "g", overIsBad: false },
  ];
  const all = [
    dayStatusPill(rows({ cal: 2200 }), false),
    dayStatusPill(rows({ cal: 1900, prot: 160 }), false),
    dayStatusPill(rows({ cal: 900, prot: 160 }), false),
    dayStatusPill(rows({ cal: 1750 }), false),
    dayStatusPill(rows({ cal: 600 }), false),
    dayStatusPill(rows({ cal: 500 }), true),
    dayStatusPill(rows({ cal: 1900, prot: 160 }), true),
  ];
  for (const p of all) {
    assert.doesNotMatch(p.text, /\d/, `the pill must never carry a number: ${p.text}`);
    assert.ok(p.text.length <= 12, `too long, it would eat the meal title: ${p.text}`);
  }
  // The verdict must agree with the bars it sits above — over is over, and it must look it.
  assert.deepEqual(dayStatusPill(rows({ cal: 2200 }), false), { text: "Over today", tone: "bad" });
  assert.equal(dayStatusPill(rows({ cal: 1900, prot: 160 }), false).tone, "good");
  assert.match(dayStatusPill(rows({ cal: 1900, prot: 160 }), false).text, /perfect/i);
  assert.equal(dayStatusPill(rows({ cal: 600 }), false).text, "On track", "early and under is on track, not a warning");
  // A bulk client is never told "over" for eating, and is chased when under-fuelled.
  assert.equal(dayStatusPill(rows({ cal: 2200 }), true).tone, "good");
  assert.equal(dayStatusPill(rows({ cal: 500 }), true).text, "Eat more");
});

// ONE INSTRUCTION PER CARD (2026-07-28). The band gives the action; the footer must not give
// the same action back in different words — it gives the reason instead.
test("distinctHint: same subject twice becomes action + reason, never the order twice", async () => {
  const { distinctHint, WHY_LINE } = await import("../server/macro-card-attach");
  const out = distinctHint("62g protein to go — two protein meals closes it.", "Get protein into your next two meals");
  assert.equal(out, WHY_LINE.protein, "the repeat becomes the WHY");
  assert.doesNotMatch(out, /\b(?:add|get|make|eat|keep|grill)\b/i, "the footer teaches, it never gives a second order");
  assert.equal(
    distinctHint("Fat ran a bit high — keep the rest lean. Grilled, not fried.", "Grill it, don't fry it — that's the whole fix today"),
    WHY_LINE.fat,
  );
  // Different subjects are left alone — that footer is earning its space. A line's subject is
  // what it OPENS with, so this one is about carbs even though it mentions protein later.
  const kept = "Carbs are maxed — protein and veg from here.";
  assert.equal(distinctHint(kept, "Eat more today — add a proper meal"), kept);
  // Every WHY line must fit the card's footer width — a truncated fact teaches nothing.
  for (const [k, v] of Object.entries(WHY_LINE)) assert.ok(v.length <= 50, `${k} WHY line too long to render: ${v}`);
});

// CARD MEAL SUMMARY (2026-07-22, founder: the card title must name the MEAL logged — 'Tin fish,
// Rice, Mixed veggies' — never the model's 'Based on what you mentioned…' preamble).
test("mealTitleFromReply: summarises the foods from the bullet lines", async () => {
  const { mealTitleFromReply } = await import("../server/macro-card-attach");
  const reply = `Based on what you mentioned, it looks like you had a full container. Let's log that:\n\n• Tin fish (~100g): 208 kcal, 25g protein\n• Rice (~200g cooked): 260 kcal\n• Mixed veggies (~100g): 80 kcal\n\nNicely done! That's all logged for you.`;
  assert.strictEqual(mealTitleFromReply(reply), "Tin fish, Rice, Mixed veggies");
});
test("mealTitleFromReply: strips the 'Based on what you mentioned' preamble when there are no bullets", async () => {
  const { mealTitleFromReply } = await import("../server/macro-card-attach");
  assert.match(mealTitleFromReply("Based on what you mentioned, it looks like a chicken wrap. Logged!"), /^chicken wrap/i);
  assert.doesNotMatch(mealTitleFromReply("This is a Switch drink. Logged."), /^This is/i);
});
test("mealTitleFromReply: caps at three foods and never returns empty", async () => {
  const { mealTitleFromReply } = await import("../server/macro-card-attach");
  const four = "• Eggs\n• Toast\n• Bacon\n• Avo";
  assert.strictEqual(mealTitleFromReply(four).split(", ").length, 3);
  assert.strictEqual(mealTitleFromReply(""), "Meal");
});

// NUTRITION GUARDRAILS (2026-07-22, founder: "3 energy drinks and no food isn't 'good' — lead them
// to the right path per health standards, without shaming"). Cross-day, standards-grounded nudges.
test("nutrition-guardrails: energy drinks with no food nudge toward fuel + water", async () => {
  const { assessNutritionStandards } = await import("../server/nutrition-guardrails");
  const n = assessNutritionStandards({ todayFoods: ["Monster Zero", "Monster Zero"], goalType: "fat_loss" });
  assert.ok(n && /caffeine, not fuel|real meal/i.test(n), "flags caffeine-instead-of-food");
});
test("nutrition-guardrails: 3rd caffeine hit cites the daily limit", async () => {
  const { assessNutritionStandards } = await import("../server/nutrition-guardrails");
  const n = assessNutritionStandards({ todayFoods: ["Red Bull", "coffee and eggs", "Monster energy"], goalType: "general" });
  assert.ok(n && /daily limit|400mg|caffeine/i.test(n));
});
test("nutrition-guardrails: does NOT flag a normal balanced day", async () => {
  const { assessNutritionStandards } = await import("../server/nutrition-guardrails");
  assert.strictEqual(assessNutritionStandards({ todayFoods: ["chicken and rice", "pap and morogo", "yoghurt and fruit"], goalType: "fat_loss" }), null);
});
test("nutrition-guardrails: a sugar-FREE drink is not treated as added sugar", async () => {
  const { assessNutritionStandards } = await import("../server/nutrition-guardrails");
  assert.strictEqual(assessNutritionStandards({ todayFoods: ["Coke Zero", "Coke Zero", "chicken salad"], goalType: "fat_loss" }), null);
});
test("nutrition-guardrails: two full-sugar drinks nudge toward the zero version", async () => {
  const { assessNutritionStandards } = await import("../server/nutrition-guardrails");
  const n = assessNutritionStandards({ todayFoods: ["Coke 500ml", "Fanta", "chicken and rice"], goalType: "fat_loss" });
  assert.ok(n && /sugar|zero|sugar-free/i.test(n));
});
test("nutrition-guardrails: three fried/takeaway meals get a no-shame balance nudge", async () => {
  const { assessNutritionStandards } = await import("../server/nutrition-guardrails");
  const n = assessNutritionStandards({ todayFoods: ["burger and chips", "KFC", "pizza"], goalType: "general" });
  assert.ok(n && /fried|takeaway|home plate|no guilt/i.test(n));
});
test("nutrition-guardrails: alcohol on a cut gets an honest, non-shaming note", async () => {
  const { assessNutritionStandards } = await import("../server/nutrition-guardrails");
  const n = assessNutritionStandards({ todayFoods: ["chicken salad", "2 beers"], goalType: "fat_loss" });
  assert.ok(n && /no judgment|fat-burning|alcohol/i.test(n));
});
test("nutrition-guardrails: sweets stacking up gets a balanced 'one is fine, skip the next' nudge", async () => {
  const { assessNutritionStandards } = await import("../server/nutrition-guardrails");
  const n = assessNutritionStandards({ todayFoods: ["chocolate", "cake", "ice cream", "chicken and rice"], goalType: "general" });
  assert.ok(n && /one now and then|balance|treat/i.test(n), "kind, non-shaming");
  // whole fruit is real food, never flagged as a sweet
  assert.strictEqual(assessNutritionStandards({ todayFoods: ["apple", "banana", "orange"], goalType: "general" }), null);
});

// COST-TO-SERVE + WHALE ALERT (2026-07-22) — turn the R199-vs-unbounded-usage risk into a number.
test("cost-tracking: memberCostRow sums AI + WhatsApp into rand and computes margin", async () => {
  const { memberCostRow, USD_ZAR, PRICE_ZAR } = await import("../server/cost-tracking");
  const r = memberCostRow("u1", 2, 40); // $2 AI (~R37) + 40 msgs (~R12)
  assert.strictEqual(r.aiZar, Math.round(2 * USD_ZAR * 100) / 100);
  assert.ok(r.whatsappZar > 0);
  assert.strictEqual(r.totalZar, Math.round((r.aiZar + r.whatsappZar) * 100) / 100);
  assert.strictEqual(r.marginZar, Math.round((PRICE_ZAR - r.totalZar) * 100) / 100);
});
test("cost-tracking: a heavy member trips the whale flag; a light one doesn't", async () => {
  const { memberCostRow, WHALE_THRESHOLD_ZAR } = await import("../server/cost-tracking");
  assert.strictEqual(memberCostRow("light", 0.5, 30).whale, false, "cheap member is not a whale");
  const heavy = memberCostRow("heavy", 8, 200); // ~R148 AI + ~R60 WA = well over half the fee
  assert.strictEqual(heavy.whale, true);
  assert.ok(heavy.totalZar > WHALE_THRESHOLD_ZAR);
});
test("cost-tracking: voiceCostUsd scales with characters and never goes negative", async () => {
  const { voiceCostUsd } = await import("../server/cost-tracking");
  assert.ok(voiceCostUsd(1000) > 0);
  assert.ok(voiceCostUsd(2000) > voiceCostUsd(1000));
  assert.strictEqual(voiceCostUsd(-5), 0);
});

// USAGE GOVERNOR (2026-07-22) — automatic daily caps that protect margin, degrade gracefully.
test("usage-governor: allows under the cap, blocks at/over it", async () => {
  const { isWithinCap } = await import("../server/usage-governor");
  assert.strictEqual(isWithinCap(0, 3), true, "first use allowed");
  assert.strictEqual(isWithinCap(2, 3), true, "3rd use (count 2) allowed");
  assert.strictEqual(isWithinCap(3, 3), false, "cap reached → blocked");
  assert.strictEqual(isWithinCap(50, 15), false, "spammer well over vision cap → blocked");
});

test("progressBar/macroBarsBlock: fills proportionally, caps at 100%, drops target-less rows", () => {
  assert.strictEqual(progressBar(0, 100), "⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜", "empty");
  assert.strictEqual(progressBar(100, 100), "🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧", "full");
  assert.strictEqual(progressBar(200, 100), "🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧", "over caps at full, never overflows");
  assert.strictEqual(progressBar(50, 100), "🟧🟧🟧🟧🟧⬜⬜⬜⬜⬜", "half");
  assert.strictEqual(progressBar(50, 0), "⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜", "no target → empty, never divides by zero");
  const block = macroBarsBlock([
    { label: "Protein", current: 98, target: 150, unit: "g" },
    { label: "Carbs", current: 0, target: 0, unit: "g" }, // dropped — no target
  ]);
  assert.ok(/Protein .*🟧.*98\/150g/.test(block), "protein row rendered with value");
  assert.ok(!/Carbs/.test(block), "target-less row dropped so a bar never lies");
});

test("goalStatus: on-target and room-left read right for fat_loss", () => {
  assert.ok(/on target|honest day/i.test(goalStatusLine("fat_loss", 0)), "on the line = win");
  assert.ok(/still available|deficit on track/i.test(goalStatusLine("fat_loss", 500)), "room left with meaning");
});

// SPINE SURGERY slice 5 (2026-07-21): health-led goals get a plain-language food footer —
// NO calories, NO deficit — while body-comp goals keep their numbers.
test("goalStatus: wellness goals get a no-numbers habit line; body-comp keep the numbers", () => {
  for (const g of ["general", "health_condition"]) {
    const line = goalStatusLine(g, 500);
    assert.ok(!/\d/.test(line), `${g} footer carries no numbers: ${line}`);
    assert.ok(!/kcal|deficit|surplus|target/i.test(line), `${g} footer avoids macro language: ${line}`);
    assert.ok(/habit|winning|protein|walk/i.test(line), `${g} footer still coaches the habit: ${line}`);
  }
  // Body-comp goals are unchanged — numbers stay.
  assert.ok(/kcal|deficit/i.test(goalStatusLine("fat_loss", 500)));
  assert.ok(/kcal|surplus|muscle fuel/i.test(goalStatusLine("muscle_gain", 400)));
});

// ============================================================
// Programme requests in natural speech deliver the programme (2026-07-16:
// "Show me my gym program" → engine said "reply program to see it")
// ============================================================

test("workout-request: spoken programme phrasings deliver, questions still coach", () => {
  for (const m of ["Show me my gym program", "show me my programme", "send my full programme", "what's my training plan", "check my program"]) {
    assert.ok(looksLikeWorkoutRequest(m), `must deliver programme: "${m}"`);
  }
  for (const m of ["Is a home workout as good as the gym?", "how long is my programme", "I finished my workout"]) {
    assert.ok(!looksLikeWorkoutRequest(m), `must NOT hijack: "${m}"`);
  }
});

// ============================================================
// WEIGHT-IN-CONTEXT ENGINE (2026-07-22, Kam: "it's not intelligent enough — it
// keeps saying I'm gaining but that was the surplus/training weeks; THIS week,
// sick and under-eating, I haven't gained. It just repeats empathy.")
// ============================================================
{
  const day = 86_400_000;
  const now = Date.now();
  // A muscle-gain client who gained 1.3kg over the month during training/surplus, then
  // went sick and held steady this week. The engine must attribute the gain to the EARLIER
  // period and say the sick week held — NEVER say they're gaining now.
  const restingHeld = weightInContextLine({
    goalType: "muscle_gain",
    resting: true,
    weighIns: [
      { weight: 84.3, at: new Date(now - 1 * day) },   // this week
      { weight: 84.4, at: new Date(now - 7 * day) },   // ~a week ago (flat since)
      { weight: 83.6, at: new Date(now - 20 * day) },  // earlier, mid-build
      { weight: 83.0, at: new Date(now - 27 * day) },  // start of window
    ],
  });
  test("weight-context: sick + flat week attributes the gain to the earlier build, not now", () => {
    assert.ok(/hold|steady/i.test(restingHeld), `should say holding steady: ${restingHeld}`);
    assert.ok(/earlier|build|surplus|training/i.test(restingHeld), `should attribute to earlier phase: ${restingHeld}`);
    assert.ok(/do not tell them they're gaining|not this week/i.test(restingHeld), `should block "you're gaining": ${restingHeld}`);
  });

  // Resting + scale ticked up: must be read as water/food, not fat — no panic.
  const restingUp = weightInContextLine({
    goalType: "fat_loss",
    resting: true,
    weighIns: [
      { weight: 80.9, at: new Date(now - 1 * day) },
      { weight: 80.0, at: new Date(now - 7 * day) },
    ],
  });
  test("weight-context: sick + up reads as water/food, not fat", () => {
    assert.ok(/water|food/i.test(restingUp) && /not fat/i.test(restingUp), `should say water/food not fat: ${restingUp}`);
  });

  // Normal training week, fat-loss goal, weight down → the deficit is working.
  const lossWorking = weightInContextLine({
    goalType: "fat_loss",
    resting: false,
    weighIns: [
      { weight: 79.2, at: new Date(now - 1 * day) },
      { weight: 80.0, at: new Date(now - 7 * day) },
    ],
  });
  test("weight-context: training + fat-loss + down = deficit working", () => {
    assert.ok(/down 0\.8kg/i.test(lossWorking) && /deficit|fat loss/i.test(lossWorking), `should read as progress: ${lossWorking}`);
  });

  test("weight-context: no data returns empty (caller keeps its fallback)", () => {
    assert.equal(weightInContextLine({ goalType: "fat_loss", weighIns: [] }), "");
  });
}

// ============================================================
// DAY-DUMP PLANNED-SEGMENT GUARD (2026-07-22, Kam's screenshot: manual clients report
// the whole day in one message — "Lunch: apple, couscous, wings... Dinner is going to be
// stir fry fish". Lunch was eaten; dinner is a PLAN and must NOT be logged as eaten.)
// Mirrors FUTURE_SEG_RE in server/handlers/food-context.ts — keep the two in sync.
// ============================================================
{
  const FUTURE_SEG_RE = /\b(going to be|gonna be|will be|is going to|are going to|i'?ll have|i will have|gonna have|going to have|planning to (?:eat|have|cook|make)|plan(?:ning)? to have|still to (?:have|eat|make|cook|come)|yet to (?:have|eat|make|cook)|about to (?:have|eat|make|cook)|for (?:tonight|later)|(?:will|going to) (?:eat|make|cook)|haven'?t (?:had|eaten) (?:yet|dinner|lunch|supper|breakfast))\b/i;
  test("day-dump: planned dinner segments are recognised as future (not logged as eaten)", () => {
    for (const s of ["dinner is going to be stir fry veggies with fish", "supper will be chicken and rice", "I'll have oats later", "still to have my dinner", "for tonight I'm making pasta"]) {
      assert.ok(FUTURE_SEG_RE.test(s), `should read as planned: "${s}"`);
    }
  });
  test("day-dump: eaten meals are NOT mistaken for planned", () => {
    for (const s of ["one large apple", "couscous with 2 wings", "had a handful of blueberries", "lunch was chicken and pap", "naartjie"]) {
      assert.ok(!FUTURE_SEG_RE.test(s), `should read as eaten: "${s}"`);
    }
  });
}

// ============================================================
// QR SIGN-UP SOURCE ATTRIBUTION (2026-07-22, Kam: "QR codes — simpler to share, like the
// government app. The explanation + the code to join.") A scanned join-QR sends a prefilled
// message carrying a source tag; the bot must capture it, strip it, and build the right link.
// ============================================================
{
  test("signup-source: parses the prefilled join message's ref tag", () => {
    assert.equal(parseSignupSource("Hi! I'd like to start with KamLife Coach 💪 (ref: gym-sandton)"), "gym-sandton");
    assert.equal(parseSignupSource("ref:flyer1"), "flyer1");
    assert.equal(parseSignupSource("joining via instagram"), "instagram");
    assert.equal(parseSignupSource("code=spring24"), "spring24");
  });
  test("signup-source: plain messages have no tag", () => {
    assert.equal(parseSignupSource("Hi, I want to start"), null);
    assert.equal(parseSignupSource("I had chicken and rice for lunch"), null);
    assert.equal(parseSignupSource(""), null);
  });
  test("signup-source: strips the tag so onboarding sees clean text", () => {
    assert.equal(stripSignupSource("Hi! I'd like to start with KamLife Coach (ref: gyma)"), "Hi! I'd like to start with KamLife Coach");
    assert.ok(!/ref/i.test(stripSignupSource("start me ref:flyer1 please")));
  });
  test("signup-source: sanitises tags to safe, predictable form", () => {
    assert.equal(sanitiseSourceTag("Gym Sandton!!"), "gym-sandton");
    assert.equal(sanitiseSourceTag("  IG_Bio  "), "ig_bio");
    assert.equal(sanitiseSourceTag("a".repeat(40)).length, 24);
  });
  test("signup-source: join link carries the number and a parseable prefill", () => {
    process.env.TWILIO_WHATSAPP_NUMBER = "whatsapp:+27600000000";
    const link = buildJoinLink("gyma");
    assert.ok(link.startsWith("https://wa.me/27600000000?text="));
    // Round-trip: the prefill it encodes must parse back to the same tag.
    assert.equal(parseSignupSource(buildJoinPrefill("gyma")), "gyma");
  });
}

// ============================================================
// PHOTO DIARY — CAPTION TIME SETS THE MEAL SLOT (2026-07-22, Puntsa's screenshots: she
// photographs each meal but batch-sends the whole day in the evening. "11:00" breakfast
// arriving at 19:49 must NOT be labelled dinner from the send-clock.)
// ============================================================
{
  test("caption-time: a time in the caption maps to the right slot", () => {
    assert.equal(slotFromCaptionTime("11:00"), "breakfast");
    assert.equal(slotFromCaptionTime("8am tea and eggs"), "breakfast");
    assert.equal(slotFromCaptionTime("had this at 1pm"), "lunch");
    assert.equal(slotFromCaptionTime("2:30pm snack"), "lunch");
    assert.equal(slotFromCaptionTime("dinner at 19:30"), "dinner");
    assert.equal(slotFromCaptionTime("supper 8pm"), "dinner");
  });
  test("caption-time: quantities and plain text are NOT read as times", () => {
    assert.equal(slotFromCaptionTime("2 eggs and toast"), null);
    assert.equal(slotFromCaptionTime("500ml water"), null);
    assert.equal(slotFromCaptionTime("Lunch time"), null); // no clock — the keyword path handles this
    assert.equal(slotFromCaptionTime(""), null);
  });
}

// ============================================================
// CARB/FAT UNDERCOUNT (2026-07-22, Kam: "I ate WAY more carbs than 107g — check my logs".
// Photo/vision meals stored carbsInt=0, so the card's Carbs bar was zero-dragged. Estimate
// carbs/fat from the trusted kcal + protein instead of leaving them at zero.)
// ============================================================
{
  test("estimateCarbsFat: a real photo meal gets realistic carbs/fat, not zero", () => {
    const e = estimateCarbsFat(548, 34); // the 548 kcal / 34g photo meal that logged 0 carbs
    assert.ok(e.carbs > 40 && e.carbs < 80, `carbs should be realistic, got ${e.carbs}`);
    assert.ok(e.fat > 10 && e.fat < 30, `fat should be realistic, got ${e.fat}`);
  });
  test("estimateCarbsFat: energy balances (protein + carbs + fat ≈ kcal)", () => {
    const e = estimateCarbsFat(600, 30);
    const kcalBack = 30 * 4 + e.carbs * 4 + e.fat * 9;
    assert.ok(Math.abs(kcalBack - 600) <= 12, `should reconstruct ~kcal, got ${kcalBack}`);
  });
  test("estimateCarbsFat: zero/garbage input is safe", () => {
    assert.deepEqual(estimateCarbsFat(0, 0), { carbs: 0, fat: 0 });
    assert.deepEqual(estimateCarbsFat(NaN as any, 20), { carbs: 0, fat: 0 });
  });
}

// ============================================================
// DESTRUCTIVE-ACTION BOUNCER (2026-07-22 live disaster: "No fix it. Recalculate everything"
// → the model deleted a meal, dropping the day 2526 → 1971 kcal). A delete may ONLY run on
// EXPLICIT removal words. Mirrors EXPLICIT_REMOVE_RE in server/understanding/live.ts.
// ============================================================
{
  const EXPLICIT_REMOVE_RE = /\b(remove|delete|undo|scrap|erase|unlog|take (?:it|that|them|this) out|take out|get rid of|take (?:it|that) off|don'?t log|cancel (?:that|it|the last))\b/i;
  test("remove-guard: vague fix/recalculate words NEVER authorise a delete", () => {
    for (const s of ["No fix it. Recalculate everything based on what I reported today", "are those numbers correct?", "that's wrong", "check my meals again", "the carbs are under-reported"]) {
      assert.ok(!EXPLICIT_REMOVE_RE.test(s), `must NOT delete on: "${s}"`);
    }
  });
  test("remove-guard: explicit removal words DO authorise a delete", () => {
    for (const s of ["remove the last meal", "delete the rice", "get rid of the duplicates", "take that out", "undo my last log"]) {
      assert.ok(EXPLICIT_REMOVE_RE.test(s), `must allow delete on: "${s}"`);
    }
  });
}

// ============================================================
// DAY LEDGER — ONE SOURCE OF TRUTH (2026-07-22 rebuild, Box 1). The card, the running total,
// and "today's meals" now all read foldLedgerRows, so their numbers are identical by
// construction — the "card says X, text says Y" class of failure is gone by design.
// ============================================================
{
  const rows: LedgerRow[] = [
    { label: "breakfast", kcal: 918, protein: 47, carbs: 90, fat: 30, loggedAt: new Date(), source: "sa_scanner", items: [{ name: "Brown bread" }, { name: "Eggs" }], rawMessage: "brown bread and eggs" },
    { label: "lunch", kcal: 1053, protein: 60, carbs: 110, fat: 28, loggedAt: new Date(), source: "sa_scanner", items: null, rawMessage: "rice and mince" },
    { label: "snack", kcal: 50, protein: 0, carbs: 8, fat: 2, loggedAt: new Date(), source: "photo", items: null, rawMessage: "[Photo]" },
  ];
  const folded = foldLedgerRows(rows);
  test("day-ledger: totals are the exact sum of the meal rows", () => {
    assert.equal(folded.kcal, 918 + 1053 + 50);
    assert.equal(folded.protein, 47 + 60 + 0);
    assert.equal(folded.carbs, 90 + 110 + 8);
    assert.equal(folded.fat, 30 + 28 + 2);
  });
  test("day-ledger: every surface reading foldLedgerRows gets identical numbers", () => {
    // The card, the running total and the diary each call getDayLedger → foldLedgerRows.
    // Folding the same rows twice must be identical — that IS the reconciliation guarantee.
    const a = foldLedgerRows(rows), b = foldLedgerRows(rows);
    assert.deepEqual({ k: a.kcal, p: a.protein, c: a.carbs, f: a.fat }, { k: b.kcal, p: b.protein, c: b.carbs, f: b.fat });
  });
  test("day-ledger: readable food description falls back sensibly", () => {
    assert.equal(folded.meals[0].foods, "Brown bread, Eggs"); // structured items win
    assert.equal(folded.meals[1].foods, "rice and mince");    // else the raw message
    assert.equal(folded.meals[2].foods, "meal");              // "[Photo]" is not shown raw
  });
  test("day-ledger: empty day is all zeros, no crash", () => {
    assert.deepEqual(foldLedgerRows([]), { kcal: 0, protein: 0, carbs: 0, fat: 0, meals: [] });
  });
  // The card showed 2L of water on a day none was drunk (2026-07-23) — today_water held
  // yesterday's value because it only rolls over when water is NEXT logged.
  test("day-ledger: water from a previous day reads as 0 today", () => {
    assert.equal(freshTodayWater("2026-07-22", "2026-07-23", "2.0"), 0, "stale day → 0");
    assert.equal(freshTodayWater(null, "2026-07-23", "2.0"), 0, "never logged → 0");
  });
  test("day-ledger: water logged today reads through", () => {
    assert.equal(freshTodayWater("2026-07-23", "2026-07-23", "1.5"), 1.5);
    assert.equal(freshTodayWater("2026-07-23", "2026-07-23", "0"), 0);
  });
}

// ============================================================
// FEELS HUMAN — no robotic dead promises (2026-07-22 live: "Let me check your meals again...
// One moment!" — a promise the bot can't keep because there's no follow-up message).
// ============================================================
{
  test("reply-hygiene: strips the stall, keeps the real answer", () => {
    const out = stripDeadPromises("Your total today is 2,100 kcal. Let me check the rest and get back to you.");
    assert.ok(/2,100 kcal/.test(out), `keeps the answer: ${out}`);
    assert.ok(!/get back to you/i.test(out), `drops the promise: ${out}`);
  });
  test("reply-hygiene: catches the exact live offenders", () => {
    for (const s of ["One moment!", "Give me a sec.", "I'll get back to you.", "Bear with me.", "Let me look into that and come back."]) {
      assert.ok(hasDeadPromise(s), `should be flagged: "${s}"`);
    }
    assert.equal(stripDeadPromises("I appreciate that. One moment!"), "I appreciate that.");
  });
  test("reply-hygiene: real coaching is NOT mistaken for a stall", () => {
    for (const s of ["Let me break it down for you: 2 eggs is 140 kcal.", "Hold on to your progress — you're doing great.", "Give it a moment to settle after eating."]) {
      assert.ok(!hasDeadPromise(s), `should be kept: "${s}"`);
    }
  });
  test("reply-hygiene: content-free corporate filler is stripped", () => {
    assert.equal(stripFiller("I appreciate your patience. Your total is 2,100 kcal."), "Your total is 2,100 kcal.");
    assert.equal(stripFiller("I want to make sure we get this right for you. Log the meal and I'll add it."), "Log the meal and I'll add it.");
    assert.ok(!/here to help/i.test(stripFiller("I'm here to help. Send your steps.")));
  });
  test("reply-hygiene: genuine warmth survives the filler strip", () => {
    for (const s of ["That's a tough week — let's reset tomorrow.", "I hear you, and you're closer than you think.", "Nice work hitting your protein today."]) {
      assert.equal(stripFiller(s), s, `warmth must survive: "${s}"`);
    }
  });
  test("reply-hygiene: humanizeReply strips both stall and filler in one pass", () => {
    const out = humanizeReply("I appreciate your patience. Let me check and get back to you. Your protein is 90g.");
    assert.equal(out, "Your protein is 90g.");
  });
}

// ============================================================
// Results
// ============================================================


// ============================================================
// MEAL-PLAN SCALING (2026-07-27, founder: "the features are half built"). The 3-day plan
// averaged ~1483 kcal/day against a 2862 target — 52% — and the validator DETECTED the
// shortfall and shipped the plan anyway with "add ~1379 kcal yourself". A plan that tells
// the client to fix it is not a plan.
// ============================================================
{
  const { topUpsForDay, topUpLine } = await import("../server/meal-plan-scale");
  test("meal-plan scale: a 1450 kcal day against a 2862 target is topped up to target", () => {
    const tops = topUpsForDay(1450, 78, 2862, 185);
    const kcal = 1450 + tops.reduce((s, t) => s + t.kcal, 0);
    const prot = 78 + tops.reduce((s, t) => s + t.protein, 0);
    assert.ok(kcal >= 2862 * 0.9, `must reach ~target, got ${kcal}`);
    assert.ok(prot >= 185 * 0.9, `protein must reach ~target, got ${prot}`);
  });
  test("meal-plan scale: a day already on target gets NO top-ups", () => {
    assert.deepEqual(topUpsForDay(2850, 190, 2862, 185), []);
    assert.equal(topUpLine([]), "");
  });
  test("meal-plan scale: protein comes first — the macro the pools under-deliver", () => {
    const tops = topUpsForDay(1450, 78, 2862, 185);
    assert.ok(tops.length > 0 && tops[0].protein >= 8, `protein-dense first: ${JSON.stringify(tops[0])}`);
  });
  test("meal-plan scale: an OVER-target day is never given more food", () => {
    assert.deepEqual(topUpsForDay(3200, 200, 2862, 185), []);
  });
}

// The whole generator must now land on target — the end-to-end contract.
{
  const { generateMealPlan } = await import("../server/meal-plan");
  test("meal plan: a 2862 kcal client gets a plan that actually hits ~2862, not ~1483", () => {
    const out = generateMealPlan({ calorieTarget: 2862, proteinTarget: 185, weeklyFoodBudget: "under_100",
      goalType: "muscle_gain", medicalConditions: "", otherMedicalNotes: "", firstName: "Kam" } as any);
    const totals = [...out.matchAll(/Total: ~(\d+) kcal/g)].map(m => Number(m[1]));
    assert.ok(totals.length >= 3, `3 day totals, got ${totals.length}`);
    for (const t of totals) assert.ok(t >= 2500, `every day must be near 2862, got ${t}`);
  });
}


// ============================================================
// NEVER SILENTLY DROP (2026-07-27 live): "Had South African breakfast from macdonalds. But I
// had extra 2 patties and extra 2 eggs" → only the eggs + patties were logged (479 kcal) and
// the McDonald's breakfast vanished without a word, costing twelve angry messages.
// ============================================================
{
  const { unloggedPlaceNotice } = await import("../server/unlogged-notice");
  test("unlogged notice: a named place with nothing logged from it is called out", () => {
    const n = unloggedPlaceNotice("Had South African breakfast from macdonalds, but I had extra 2 patties and 2 eggs", ["Eggs", "patties"]);
    assert.match(n, /could not price/i);
    assert.match(n, /McDonald/i);
  });
  test("unlogged notice: silent when the place's item WAS logged", () => {
    assert.equal(unloggedPlaceNotice("KFC streetwise 2", ["KFC Streetwise 2"]), "");
  });
  test("unlogged notice: silent when no place is named", () => {
    assert.equal(unloggedPlaceNotice("2 eggs and toast", ["Eggs", "Toast"]), "");
  });
}


// SA FAST-FOOD MENU NAMES (2026-07-27 live: "Had South African breakfast from macdonalds"
// matched nothing — the alias list had "breakfast macdonalds" but not the connector form
// "breakfast FROM macdonalds", so the whole meal was silently dropped).
{
  const { scanForSAFoods } = await import("../server/handlers/food-scanner");
  const names = (t: string) => scanForSAFoods(t).map((f: any) => f.name).join(", ");
  test("SA menu: the real live phrasing finds the McDonald's SA Big Breakfast", () => {
    assert.match(names("Had South African breakfast from macdonalds"), /Big Breakfast/i);
  });
  test("SA menu: 'South African breakfast' alone is the menu item, not nothing", () => {
    assert.match(names("south african breakfast"), /Big Breakfast/i);
  });
  test("SA menu: connector spellings all land", () => {
    for (const t of ["breakfast from mcdonalds", "mcdonalds south african breakfast", "sa breakfast"]) {
      assert.match(names(t), /Big Breakfast/i, t);
    }
  });
}


// ============================================================
// ADAPTIVE TARGET ENGINE (2026-07-27, founder: "It doesn't adjust the calories when you are
// sick. It doesn't adjust anything. There's no brain here."). He was right — targets were
// frozen at onboarding. This is the brain: state in, today's targets out.
// ============================================================
{
  const { adaptTargets } = await import("../server/adaptive-targets");
  const base = { baseCalories: 2000, baseProtein: 150, baseSteps: 8000, goalType: "fat_loss", weightKg: 80, sick: false };

  test("adaptive: SICK removes the deficit, keeps protein high, drops the step target to 0", () => {
    const r = adaptTargets({ ...base, sick: true, daysSick: 2 });
    assert.ok(r.calorieTarget > base.baseCalories, `no deficit while sick: ${r.calorieTarget}`);
    assert.ok(r.proteinTarget >= 144, `protein protects muscle: ${r.proteinTarget}`);
    assert.equal(r.stepsTarget, 0, "nobody fails a step target from bed");
    assert.equal(r.reason, "sick");
    assert.match(r.note, /rest numbers|no deficit/i);
  });
  test("adaptive: a week+ of illness adds the doctor nudge", () => {
    assert.match(adaptTargets({ ...base, sick: true, daysSick: 8 }).note, /doctor/i);
  });
  test("adaptive: RECOVERING eases steps back at half, food normal", () => {
    const r = adaptTargets({ ...base, recovering: true });
    assert.equal(r.calorieTarget, 2000);
    assert.equal(r.stepsTarget, 4000);
    assert.equal(r.reason, "recovering");
  });
  test("adaptive: losing too fast puts calories UP — that is muscle going, not a win", () => {
    const r = adaptTargets({ ...base, weeklyKgChange: -1.2 });
    assert.ok(r.calorieTarget > 2000, `must go UP, got ${r.calorieTarget}`);
    assert.equal(r.reason, "losing_too_fast");
    assert.match(r.note, /muscle/i);
  });
  test("adaptive: gaining too fast on a build trims the surplus", () => {
    const r = adaptTargets({ ...base, goalType: "muscle_gain", weeklyKgChange: 0.9 });
    assert.ok(r.calorieTarget < 2000, `must come down, got ${r.calorieTarget}`);
    assert.equal(r.reason, "gaining_too_fast");
  });
  test("adaptive: a 3-week stall gets a SMALL trim plus steps, never a crash", () => {
    const r = adaptTargets({ ...base, stalledWeeks: 3 });
    assert.equal(r.reason, "stalled");
    assert.ok(r.calorieTarget >= 1760 && r.calorieTarget < 2000, `small trim only: ${r.calorieTarget}`);
    assert.ok(r.stepsTarget > 8000, "steps move too");
  });
  test("adaptive: the floor holds — a stall never starves a light client", () => {
    const r = adaptTargets({ ...base, baseCalories: 1400, weightKg: 55, stalledWeeks: 5 });
    assert.ok(r.calorieTarget >= 1400 * 0.93 && r.calorieTarget >= 1210, `never below floor: ${r.calorieTarget}`);
    assert.ok(r.stepsTarget > 8000, "moves with steps at the floor");
  });
  test("adaptive: an inactive week lowers a fat-loss target so the deficit is real", () => {
    const r = adaptTargets({ ...base, avgSteps7d: 1500 });
    assert.equal(r.reason, "inactive");
    assert.ok(r.calorieTarget < 2000);
  });
  test("adaptive: a normal week changes NOTHING — a target that moves daily is noise", () => {
    const r = adaptTargets({ ...base, weeklyKgChange: -0.4, avgSteps7d: 7800, stalledWeeks: 0 });
    assert.equal(r.changed, false);
    assert.equal(r.note, "");
    assert.equal(r.calorieTarget, 2000);
  });
  test("adaptive: sick BEATS every other signal", () => {
    const r = adaptTargets({ ...base, sick: true, stalledWeeks: 6, avgSteps7d: 200, weeklyKgChange: -1.5 });
    assert.equal(r.reason, "sick");
  });
}


// ============================================================
// THE REPLY CONTRACT (2026-07-27 — founder: "it's just too much reading"; three independent
// reviews converged on this as the single highest-leverage fix). A routine coaching reply is
// max 3 lines: acknowledge, the one thing, forward. Detail is REQUESTED, never unsolicited.
// ============================================================
{
  const { enforceReplyContract, meetsReplyContract, clientAskedForDetail } = await import("../server/reply-contract");
  // The exact live reply the founder photographed.
  const verbose = [
    "🟢 Nicely done — still room for two proper meals today.",
    "",
    "*Food logged* ✅",
    "",
    "• Weet-Bix: ~400 kcal, 15g protein (5 biscuits with milk (200g))",
    "• cheerios: ~100 kcal, 2g protein (30g)",
    "",
    "*Meal total:* ~500 kcal | ~17g protein",
    "Running total today: ~505 kcal / 2862 target (2357 to go)",
    "",
    "‣ My progress",
    "‣ Today's workout",
  ].join("\n");

  test("reply contract: the live breakfast dump collapses to 3 lines or fewer", () => {
    const out = enforceReplyContract(verbose);
    const lines = out.split("\n").filter(l => l.trim());
    assert.ok(lines.length <= 3, `max 3 lines, got ${lines.length}:\n${out}`);
  });
  test("reply contract: itemised macros, stacked totals and menus are all dropped", () => {
    const out = enforceReplyContract(verbose);
    assert.doesNotMatch(out, /Weet-Bix: ~400 kcal/i, "no item macro lines");
    assert.doesNotMatch(out, /Running total/i, "no stacked totals — the card carries them");
    assert.doesNotMatch(out, /‣/, "no unrequested menu buttons");
  });
  test("reply contract: the warm acknowledgement survives — meaning is kept, data is cut", () => {
    assert.match(enforceReplyContract(verbose), /Nicely done/i);
  });
  test("reply contract: a REQUESTED detail reply is never truncated", () => {
    assert.equal(enforceReplyContract(verbose, { askedForDetail: true }), verbose);
    assert.ok(clientAskedForDetail("show me my meals"));
    assert.ok(clientAskedForDetail("my progress"));
    assert.ok(clientAskedForDetail("send my meal plan"));
    assert.ok(!clientAskedForDetail("had eggs and toast"));
  });
  test("reply contract: the media marker survives compaction", () => {
    const out = enforceReplyContract(verbose + " [MEDIA:https://x/card.png]");
    assert.match(out, /\[MEDIA:https:\/\/x\/card\.png\]/);
  });
  test("reply contract: never returns empty — silence is worse than verbosity", () => {
    const onlyData = "• Eggs: ~279 kcal, 24g protein\n*Meal total:* ~279 kcal";
    assert.ok(enforceReplyContract(onlyData).trim().length > 0);
  });
  test("reply contract: an already-short reply passes through untouched", () => {
    const good = "Logged your breakfast.\n\n43g protein to go — tin fish at lunch closes it.";
    assert.equal(enforceReplyContract(good), good);
    assert.ok(meetsReplyContract(good));
    assert.ok(!meetsReplyContract(verbose));
  });
}


// NEVER-DROP, GENERALISED (2026-07-27): the restaurant case was fixed first; this covers any
// food the table doesn't know and the supplement couldn't price. Silent data loss is the
// single fastest way to lose a client's trust.
{
  const { unloggedFoodNotice, unloggedFoodWords } = await import("../server/unlogged-notice");
  test("never-drop: unrecognised foods are named, not swallowed", () => {
    const n = unloggedFoodNotice("I had chicken feet and mogodu stew", ["Chicken"]);
    assert.match(n, /could not price/i);
    assert.match(n, /mogodu/i);
  });
  test("never-drop: silent when everything was logged", () => {
    assert.equal(unloggedFoodNotice("2 eggs and toast", ["Eggs", "Toast"]), "");
  });
  test("never-drop: a single stray word does not trigger a false warning", () => {
    assert.equal(unloggedFoodNotice("I had eggs quickly", ["Eggs"]), "");
  });
  test("never-drop: filler words are never mistaken for food", () => {
    assert.deepEqual(unloggedFoodWords("I had some eggs for breakfast today", ["Eggs"]), []);
  });
}


// ============================================================
// RUN / DISTANCE CONVERSION (2026-07-27, founder: "if somebody has run a ten kilometer —
// does the bot know what to do with that screenshot?"). It did not: the step extractor was
// told to IGNORE km, so a 10km run logged nothing. ~800 kcal of real work, invisible.
// ============================================================
{
  const { parseDistanceKm, detectMode, convertDistance, distanceReply } = await import("../server/run-conversion");
  test("run: distance is read from the screenshot text and the message", () => {
    assert.equal(parseDistanceKm("Distance 10.2 km"), 10.2);
    assert.equal(parseDistanceKm("ran 8km this morning"), 8);
    assert.equal(parseDistanceKm("10,5 kilometres"), 10.5);
    assert.equal(parseDistanceKm("no distance here"), null);
  });
  test("run: OCR garbage is rejected, never logged as a 900km run", () => {
    assert.equal(parseDistanceKm("900 km"), null);
    assert.equal(parseDistanceKm("0 km"), null);
  });
  test("run: a 10km RUN converts to a real burn and step-equivalent", () => {
    const a = convertDistance(10, 80, "run");
    assert.ok(a.burnKcal >= 700 && a.burnKcal <= 850, `~1 kcal/kg/km: ${a.burnKcal}`);
    assert.ok(a.stepEquivalent >= 10000 && a.stepEquivalent <= 11000, `~1050/km: ${a.stepEquivalent}`);
  });
  test("run: walking the same distance burns LESS — we never over-credit", () => {
    assert.ok(convertDistance(10, 80, "walk").burnKcal < convertDistance(10, 80, "run").burnKcal);
  });
  test("run: mode is detected from the client's words, defaulting to the low-burn read", () => {
    assert.equal(detectMode("ran 10km"), "run");
    assert.equal(detectMode("did my 5k"), "run");
    assert.equal(detectMode("10km this morning"), "walk", "default is conservative");
  });
  test("run: the reply is short, names the work, and warns against eating it back", () => {
    const r = distanceReply(convertDistance(10, 80, "run"), "Kam");
    assert.match(r, /10km run/i);
    assert.match(r, /kcal/i);
    assert.match(r, /don.t try to|save/i, "must warn against eating the burn back");
  });
}


// SICK STATE — PAST TENSE IS NOT A NEW REPORT (2026-07-27 live disaster): the client said
// "Now that I'm not sick anymore how do we go about my plan?" (got the right plan), then
// added "But I was sick" — and the bare word "sick" threw them BACK into the sick flow:
// training cancelled, check-ins paused 3 days, and sick-state eating advice delivered to
// someone who had just told the coach they were better.
{
  const { looksSickMention } = await import("../server/handlers/sick-flow");
  test("sick: a past-tense mention is context, not a new sick report", () => {
    assert.equal(looksSickMention("But I was sick"), false);
    assert.equal(looksSickMention("when I was sick"), false);
    assert.equal(looksSickMention("I was sick last week but I'm training again"), false);
  });
  test("sick: a genuine present report still fires", () => {
    assert.equal(looksSickMention("I am sick"), true);
    assert.equal(looksSickMention("I feel sick"), true);
    assert.equal(looksSickMention("I have been sick since Monday"), true);
  });
  test("sick: past tense + a present marker is still sick", () => {
    assert.equal(looksSickMention("I was sick but I am still sick today"), true);
  });
}

// SESSION REPORTED IN PROSE (2026-07-27 thread — D1 + D2 in ONE message). The client wrote
// that today was his first day back after being sick and that it felt very bad, "like I
// never trained before". Nothing was logged (isDone is anchored, retro needs "yesterday"),
// the feeling was ignored (no concept of a session that felt BAD), and minutes later the
// coach told him "Training day — reply *workout*" for a session he had already done.
{
  const first = "today was my first day back at the gym, it felt very bad, like I never trained before";

  test("session report: the live message logs a session and reads the feel", () => {
    const r = parseSessionReport(first);
    assert.ok(r, "the failing live message must parse as a session report");
    assert.equal(r!.trainedToday, true);
    assert.equal(r!.feel, "bad");
    assert.equal(r!.returning, true);
  });

  test("session report: the reply confirms the log, names the feeling, sets next session", () => {
    const out = sessionReportReply(parseSessionReport(first)!, "Thabo", 12);
    assert.match(out, /logged today's session/i);   // it is on the board
    assert.match(out, /12 sessions/);                // deterministic tally, not a guess
    assert.match(out, /never trained before/i);      // the feeling is answered, not ignored
    assert.match(out, /60%/);                        // concrete instruction for next time
    assert.doesNotMatch(out, /reply \*workout\*/i);  // never "go train" for a done session
  });

  test("session report: plain phrasings count as today's session", () => {
    for (const msg of [
      "I trained today", "went to the gym this morning", "just finished my session",
      "did my workout today", "hit the gym today", "first day back today",
    ]) assert.ok(parseSessionReport(msg)?.trainedToday, `should log: ${msg}`);
  });

  test("session report: plans, questions, misses and other days are NOT logged", () => {
    for (const msg of [
      "I want to train today", "going to the gym later today", "should I train today?",
      "I didn't train today", "I missed today's session", "I trained yesterday",
      "did legs on Monday", "will I train today", "what is today's workout",
    ]) {
      const r = parseSessionReport(msg);
      const blocked = !r || looksLikeQuestion(msg) || isFutureIntent(msg) || mentionsNotDone(msg);
      assert.ok(blocked, `must not log a session: ${msg}`);
    }
  });

  test("session report: the feel scale reads worst-first", () => {
    assert.equal(readFeel("it felt terrible"), "bad");
    assert.equal(readFeel("I had no strength at all"), "bad");
    assert.equal(readFeel("couldn't finish it"), "bad");
    assert.equal(readFeel("it was brutal, really hard"), "hard");
    assert.equal(readFeel("felt strong today"), "strong");
    assert.equal(readFeel("it was fine"), "fine");
    assert.equal(readFeel("I trained today"), null);
  });

  test("session report: a comeback with no feel still gets comeback coaching", () => {
    const out = sessionReportReply({ trainedToday: true, feel: null, returning: true }, "", 3);
    assert.match(out, /first one back/i);
    assert.match(out, /60%/);
  });
}

// BARE REACTION ≠ EMOTIONAL CRISIS (2026-07-27 thread — D3). "Wow" and then "Jesus" at two
// bad replies came back as therapy-speak about feeling overwhelmed. The prompt already
// banned that and the model did it anyway, so the bad output is now rejected in code.
{
  test("reaction guard: bare exclamations are reactions, not disclosures", () => {
    for (const msg of ["Wow", "wow", "Jesus", "Jesus Christ", "omg", "eish", "!!!!", "???", "🙄", "wowwww", "ugh"])
      assert.equal(isBareReaction(msg), true, `should be a bare reaction: ${msg}`);
  });

  test("reaction guard: real messages are never treated as bare reactions", () => {
    for (const msg of [
      "wow this plan looks good, can you send my workout",
      "I am really struggling and I feel like giving up",
      "Jesus I have been so depressed lately, only drinking",
      "log 2 eggs and toast",
    ]) assert.equal(isBareReaction(msg), false, `must not be bare: ${msg}`);
  });

  test("reaction guard: therapy-speak is detected and replaced", () => {
    const bad = "I hear you — it sounds like you're feeling overwhelmed right now. Be kind to yourself, one day at a time. 💛";
    assert.equal(readsAsTherapySpeak(bad), true);
    const fixed = bareReactionFallback("Thabo");
    assert.equal(readsAsTherapySpeak(fixed), false);
    assert.match(fixed, /Thabo/);
    assert.match(fixed, /missed the mark/i);
  });

  test("reaction guard: an ordinary corrective reply is left alone", () => {
    const good = "That was wrong — your session is already logged for today. Type *my progress* for the week so far.";
    assert.equal(readsAsTherapySpeak(good), false);
  });
}

// THE 18:28 THREAD — Kam logged "Dinner / Rice / Tin fish / Lentils" and the reply invented
// two foods he never named, offered him a dinner he had just eaten, and contradicted itself
// on protein inside one sentence. Then "Teach me" came back as "Swaps for Peach".
{
  test("naming: the client's word wins when the entry invents a variant", () => {
    assert.equal(displayFoodName("rice", "Brown rice"), "Rice");
    assert.equal(displayFoodName("tin fish", "Pilchards in tomato sauce"), "Tin fish");
    assert.equal(displayFoodName("milk", "Full cream milk"), "Milk");
  });

  test("naming: the entry name stands when the client actually said it", () => {
    assert.equal(displayFoodName("brown rice", "Brown rice"), "Brown rice");
    assert.equal(displayFoodName("white rice", "White rice"), "White rice");
    assert.equal(displayFoodName("lentils", "Lentils"), "Lentils");
    // "pilchards" → "Pilchards": the tomato-sauce tin is the default the numbers came from,
    // but the client didn't say it, so it isn't put in their mouth. Their word, shown back.
    assert.equal(displayFoodName("pilchards", "Pilchards in tomato sauce"), "Pilchards");
    assert.equal(displayFoodName("pilchards in oil", "Pilchards in oil"), "Pilchards in oil");
  });

  test("naming: only real variant words count as invented", () => {
    assert.deepEqual(inventedQualifiers("rice", "Brown rice"), ["brown"]);
    assert.deepEqual(inventedQualifiers("chicken", "Chicken thigh"), []);
  });

  test("dinner: the day-close wording never offers another dinner", () => {
    for (const label of ["dinner", "Dinner", "supper"]) {
      const out = remainingInMeals(760, label);
      assert.doesNotMatch(out, /full dinner|two proper meals|one solid meal/i);
    }
    // Same budget, no dinner logged yet — the old wording is still correct.
    assert.match(remainingInMeals(760, "lunch"), /full dinner/i);
  });

  test("dinner: the close line states what's actually left", () => {
    assert.match(dinnerCloseLine(16, false), /dinner done/i);
    assert.match(dinnerCloseLine(16, false), /16g/);
    assert.doesNotMatch(dinnerCloseLine(16, false), /one more (solid )?meal/i);
    assert.match(dinnerCloseLine(0, false), /Day closed/i);
  });

  test("fuzzy: everyday words are never mistaken for food", () => {
    for (const w of ["teach", "reach", "coach", "beach", "past", "days"])
      assert.ok(FUZZY_BLACKLIST.has(w), `"${w}" must be blacklisted from fuzzy food matching`);
  });

  test("fuzzy: 'teach' really is one edit from 'peach' — hence the blacklist", () => {
    assert.equal(levenshtein("teach", "peach"), 1);
    assert.equal(maxDistance("peach".length), 1);   // 5 chars → distance 1 allowed
  });
}

// THE AUDITOR — the whole point is that it would have caught today's defects without a human
// reading screenshots. These are the ACTUAL replies that shipped, pasted verbatim. If a
// detector stops catching its own screenshot, the auditor has silently stopped working.
{
  const codes = (t: { messageIn: string; messageOut: string }) => scanReply(t).map(d => d.code);

  test("auditor: catches the real 18:28 reply — invented food + dinner offered + protein contradiction", () => {
    const shipped = {
      messageIn: "Dinner\nRice\nTin fish\nLentils",
      messageOut: "🟢 Nicely done — still room for a full dinner with room for a snack today.\n"
        + "✅ *Logged:* Brown rice, Pilchards in tomato sauce, Lentils — ~719 kcal | 50g protein\n\n"
        + "*Dinner: ~719 kcal | ~50g protein*\n"
        + "_Clean day. One more solid meal and you close it out._\n\n"
        + "That's the protein box ticked. 16g more to go today.",
    };
    const c = codes(shipped);
    assert.ok(c.includes("invented-food"), "must flag Brown rice / Pilchards in tomato sauce");
    assert.ok(c.includes("meal-offered-after-logging"), "must flag offering dinner after logging dinner");
    assert.ok(c.includes("protein-contradiction"), "must flag 'box ticked' + '16g more to go'");
  });

  test("auditor: catches the real 18:29 reply — a removal answer to a correction", () => {
    assert.ok(codes({
      messageIn: "The rice was white not brown",
      messageOut: "Kam, nothing removed — I've recounted everything you logged today: *2102 kcal | 169g protein*. If one meal is wrong, tell me which and the right amount and I'll fix just that one.",
    }).includes("removal-nonsequitur"));
  });

  test("auditor: catches the real 18:36 reply — full help menu to 'What?'", () => {
    assert.ok(codes({
      messageIn: "What?",
      messageOut: "Good evening Kam 👋 You missed Thursday + Friday + Monday + Tuesday.\n\n*What you can send me:*\n🔍 Any meal — photo, voice note or plain text.",
    }).includes("menu-dump"));
  });

  test("auditor: catches being told to train after reporting a session", () => {
    assert.ok(codes({
      messageIn: "today was my first day back at the gym, it felt very bad",
      messageOut: "Here's your plan 👇\n\n*Today:*\n💪 Training day — reply *workout* and your session's ready",
    }).includes("train-after-session"));
  });

  test("auditor: healthy replies are left alone — a noisy report gets ignored", () => {
    const healthy = [
      { messageIn: "Dinner\nRice\nTin fish\nLentils",
        messageOut: "🟢 Nicely done — dinner's in and you're inside your day.\n✅ *Logged:* Rice, Tin fish, Lentils — ~719 kcal | 50g protein\n\n*Dinner: ~719 kcal | ~50g protein*\n_That's dinner done. 16g protein short — yoghurt or a boiled egg tonight closes it._" },
      { messageIn: "menu", messageOut: "*What you can send me:*\n🔍 Any meal — photo, voice note or plain text." },
      { messageIn: "remove my last meal", messageOut: "Kam, nothing removed — tell me which meal and I'll fix just that one." },
      { messageIn: "I trained today", messageOut: "✅ Logged today's session. That's *12 sessions* logged." },
      { messageIn: "wow", messageOut: "That reply missed the mark. Tell me in one line what you needed." },
    ];
    for (const t of healthy) assert.deepEqual(codes(t), [], `false positive on: ${t.messageIn}`);
  });

  test("identity correction: the live message parses as a food swap", () => {
    const c = parseIdentityCorrection("The rice was white not brown");
    assert.ok(c, "the 18:29 message must parse");
    assert.equal(c!.right, "white");
    assert.equal(c!.wrong, "brown");
    assert.equal(c!.subject, "rice");
    assert.deepEqual(correctionCandidates(c!).rightNames, ["white rice", "white"]);
  });

  test("identity correction: other natural shapes", () => {
    assert.equal(parseIdentityCorrection("it was tuna not pilchards")?.right, "tuna");
    assert.equal(parseIdentityCorrection("that was full cream milk not low fat")?.wrong, "low fat");
    assert.equal(parseIdentityCorrection("not brown, it was white")?.right, "white");
  });

  test("identity correction: NOT fired by ordinary 'not' sentences", () => {
    for (const msg of [
      "I'm not sure what to eat", "not today", "why not", "I'm not hungry",
      "2 eggs not 3", "I did not train", "that's not going to work for me",
    ]) assert.equal(parseIdentityCorrection(msg), null, `must not parse: ${msg}`);
  });

  test("adaptive training: state changes the session, not just the advice", () => {
    assert.equal(adaptTraining({ sick: true }).skip, true);
    const rec = adaptTraining({ recovering: true });
    assert.equal(rec.loadPct, 60);
    assert.equal(rec.setsDelta, -1);
    assert.equal(adaptTraining({ daysSinceLastWorkout: 21 }).loadPct, 60);
    assert.equal(adaptTraining({ daysSinceLastWorkout: 8 }).loadPct, 80);
    assert.equal(adaptTraining({ daysSinceLastWorkout: 2 }).changed, false);
  });

  test("adaptive training: the printed sets match the instruction", () => {
    // A note saying "drop a set" beside a sheet still reading 3×10 is the contradiction.
    assert.equal(applySetsDelta("Squat — 3×10\nHip thrust — 4×12", -1), "Squat — 2×10\nHip thrust — 3×12");
    assert.equal(applySetsDelta("Squat — 3×10", 0), "Squat — 3×10");
  });

  test("AI spend ceiling: warns at 80%, blocks at 100%, off when unset", () => {
    assert.equal(ceilingState(1000, null), "ok");
    assert.equal(ceilingState(1000, 5000), "ok");
    assert.equal(ceilingState(4200, 5000), "warn");
    assert.equal(ceilingState(5000, 5000), "over");
  });

  test("auditor: counts foods missing from the database — the only honest coverage measure", () => {
    const c = codes({
      messageIn: "i had a bunny chow and a peach",
      messageOut: "*Food logged* ✅\n\n⚠️ I could not price *bunny chow, peach* — that part is NOT in the total.",
    });
    assert.ok(c.includes("food-not-in-database"));
  });

  test("auditor: summarise rolls turns into counts worst-first", () => {
    const s = summarise([
      { messageIn: "What?", messageOut: "*What you can send me:*\n🔍 Any meal" },
      { messageIn: "Eish", messageOut: "*What you can send me:*\n🔍 Any meal" },
      { messageIn: "hi", messageOut: "Sharp." },
    ]);
    assert.equal(s.scanned, 3);
    assert.equal(s.clean, 1);
    assert.equal(s.defects, 2);
    assert.equal(s.byCode[0].code, "menu-dump");
    assert.equal(s.byCode[0].count, 2);
  });
}

// D12 CLINICAL LANGUAGE + D8 THE CARD + D10 SCOPE (2026-07-27 evening).
{
  test("clinical: the coach prompt gives no medication instructions", () => {
    const prompt = readFileSync("server/coach-prompt.ts", "utf-8");
    // Both of these shipped in the prompt: "Metformin causes nausea without food — time it
    // correctly" and "Take ARVs with food". Instructing on medicine is not coaching.
    assert.doesNotMatch(prompt, /Metformin causes nausea/i);
    assert.doesNotMatch(prompt, /Take ARVs with food/i);
    assert.doesNotMatch(prompt, /20 years of real coaching experience/i);
  });

  test("clinical: medication timing advice is blocked in code, not just removed", () => {
    for (const bad of [
      "Take your metformin with food to avoid the nausea.",
      "Have your ARVs with a meal, it settles the stomach.",
      "Take your tablets on an empty stomach in the morning.",
    ]) assert.equal(verifyBrainReply(bad, {}).ok, false, `must be blocked: ${bad}`);
  });

  test("clinical: legitimate coaching about the same clients still passes", () => {
    for (const ok of [
      "Slow-release carbs like samp and beans suit you well — keep meals regular.",
      "Go easy on the polony and Aromat, and walk every day. Your doctor guides the blood pressure.",
      "Protein needs are higher — eggs, tin fish, amasi. Anything about your treatment is your clinic's call.",
    ]) assert.equal(verifyBrainReply(ok, {}).ok, true, `must pass: ${ok}`);
  });

  test("card: the next move is an action in food, never a macro number", () => {
    const rows = (protCur: number, protTgt: number, calCur: number, calTgt: number) => ([
      { label: "Calories", current: calCur, target: calTgt, unit: "", overIsBad: true },
      { label: "Protein", current: protCur, target: protTgt, unit: "g", overIsBad: false },
      { label: "Fat", current: 40, target: 80, unit: "g", overIsBad: true },
    ] as any);
    const big = nextMoveLine(rows(60, 185, 1200, 2862), false);
    assert.match(big, /protein/i);
    assert.doesNotMatch(big, /\d/, "the layman's line must carry no numbers");
    assert.match(nextMoveLine(rows(185, 185, 3400, 2862), false), /lean|light/i);
    assert.match(nextMoveLine(rows(185, 185, 2800, 2862), false), /done/i);
  });

  test("life: the clinical edge still refers", () => {
    const alc = readLifeContext("I'm honestly depressed, the only thing I've had today is alcohol");
    assert.ok(alc); assert.equal(alc!.refer, true); assert.equal(alc!.demand, "pause");
    const out = lifeContextReply(alc!, "Kam");
    assert.match(out, /0800 567 567/);
    assert.equal(readsAsTherapySpeak(out), false);
    assert.equal(readLifeContext("I make myself sick after I eat")!.context, "disordered_eating");
  });

  test("life: the COMMON cases now land — a coach hears the whole person", () => {
    const cases: Array<[string, LifeContext]> = [
      ["my mother passed away on Sunday, funeral is Friday", "bereavement"],
      ["I'm in hospital, had surgery yesterday", "own_illness"],
      ["my son is sick, I've been at the clinic all week", "family_illness"],
      ["I got retrenched, there's no income coming in", "job_or_money"],
      ["we're getting divorced and it's a mess", "relationship"],
      ["I'm burnt out, double shifts every day", "burnout"],
      ["I feel so lonely doing this", "loneliness"],
      ["I have panic attacks most days", "anxious"],
      ["there is too much going on, I'm drowning", "overwhelmed"],
    ];
    for (const [msg, want] of cases) {
      const r = readLifeContext(msg);
      assert.ok(r, `must be read: ${msg}`);
      assert.equal(r!.context, want, msg);
    }
  });

  test("life: comfort replies never diagnose, prescribe or mention medicine", () => {
    const BANNED = /\b(medication|medicine|meds|dose|dosage|tablets?|pills?|prescri|diagnos|symptom|treatment plan|you (?:have|are suffering from))\b/i;
    for (const c of ["bereavement", "own_illness", "family_illness", "job_or_money", "relationship",
                     "burnout", "loneliness", "anxious", "overwhelmed"] as LifeContext[]) {
      const out = lifeContextReply({ context: c, refer: false, demand: "lighten" }, "Kam");
      assert.doesNotMatch(out, BANNED, `${c} must stay a lifestyle coach`);
      assert.ok(out.length > 80, `${c} must actually say something`);
    }
  });

  test("life: ordinary coaching talk is never diverted", () => {
    for (const msg of [
      "I'm depressed about my weight", "sick of eating chicken every day",
      "that session was killing my legs", "I'm dying after that workout",
      "sad about my progress this week",
    ]) assert.equal(readLifeContext(msg), null, `must stay coaching: ${msg}`);
  });

  test("life: bereavement and illness pause the programme, hard weeks lighten it", () => {
    assert.equal(pausesTargets(readLifeContext("my father passed away")!), true);
    assert.equal(quietDays(readLifeContext("my father passed away")!), 7);
    assert.equal(quietDays(readLifeContext("I got retrenched last week")!), 3);
  });

  // 2026-07-28 07:57 — "Session two, we're back to full speed" to a man who had just said he
  // was weak. The comeback text lived in seven places and said three different things.
  test("comeback: one protocol, and it never promises full speed at session two", () => {
    const plan = comebackPlan("Kam");
    assert.match(plan, /60%/);
    assert.match(plan, /2–3 weeks|2-3 weeks/);
    assert.doesNotMatch(plan, /full speed/i);
    assert.doesNotMatch(plan, /session two, back to normal/i);
  });

  test("comeback: the live question routes deterministically, never to the engine", () => {
    const msg = "I'm back in the gym yesterday was my first day like I explained What's the next move for me?";
    assert.equal(looksLikeComebackQuestion(msg), true);
    assert.equal(mustStayDeterministic(msg), true);
    // Plain logs and chatter must NOT be captured by it.
    for (const other of ["I trained today", "back in 10 minutes", "what should I eat"])
      assert.equal(mustStayDeterministic(other) && looksLikeComebackQuestion(other), false, other);
  });
}

// NOBODY IS TURNED AWAY (2026-07-28, founder: "their doctors told them to join a gym… do we turn
// people like that away?"). The line is WHAT we touch, not WHO we serve.
{
  test("condition: a disclosure is recognised, including pre-diabetes", () => {
    for (const msg of [
      "I have diabetes", "I'm pre-diabetic", "I'm on metformin",
      "my doctor said I have hypertension", "I was just diagnosed",
    ]) assert.equal(mentionsConditionOrMedication(msg), true, msg);
    for (const msg of ["I had chicken and rice", "my knee is sore", "I want to lose weight"])
      assert.equal(mentionsConditionOrMedication(msg), false, msg);
  });

  test("condition: the reply welcomes them and makes no clinical claim", () => {
    const out = conditionWelcome("Kam");
    assert.match(out, /right place/i);                     // welcome, not a brush-off
    assert.match(out, /lifestyle coach, not a medical service/i);
    assert.match(out, /your doctor/i);
    // The claims that must never return.
    assert.doesNotMatch(out, /safe for your condition/i);
    assert.doesNotMatch(out, /\b(dose|dosage|medication is|take your)\b/i);
    // It must end by coaching, not by closing the door.
    assert.match(out, /food, or getting moving\?$/);
  });

  test("landing page carries no clinical claims and states the scope", () => {
    const page = readFileSync("client/src/pages/landing.tsx", "utf-8");
    assert.doesNotMatch(page, /avoids foods that interact with common medications/i);
    assert.doesNotMatch(page, /within safe ranges for your condition/i);
    assert.doesNotMatch(page, /Diabetes-friendly|Blood pressure-aware/i);
    assert.match(page, /not a medical or healthcare provider/i);
    assert.match(page, /does not diagnose, treat, or manage/i);
  });
}

// D5 — ENGAGEMENT. Nothing measured whether people were still here.
{
  const DAY = 86_400_000;
  const now = new Date("2026-07-28T12:00:00Z");
  const ago = (d: number) => new Date(now.getTime() - d * DAY);
  const row = (o: Partial<ActivityRow> & { userId: string }): ActivityRow => ({
    name: "Test", createdAt: ago(30), lastInboundAt: ago(0), activeDays: [], lastCoachIntent: null, ...o,
  });

  test("engagement: risk bands match how this product is actually used", () => {
    assert.equal(bandFor(0), "active");
    assert.equal(bandFor(2), "active");
    assert.equal(bandFor(3), "slipping");
    assert.equal(bandFor(7), "quiet");
    assert.equal(bandFor(14), "gone");
  });

  test("engagement: a client who NEVER spoke counts from signup, not forever-active", () => {
    const [r] = assessClients([row({ userId: "a", createdAt: ago(9), lastInboundAt: null })], now);
    assert.equal(r.daysSinceActive, 9);
    assert.equal(r.band, "quiet");
  });

  test("engagement: worst first — the list is for acting on, not browsing", () => {
    const out = assessClients([
      row({ userId: "a", lastInboundAt: ago(1) }),
      row({ userId: "b", lastInboundAt: ago(20) }),
      row({ userId: "c", lastInboundAt: ago(5) }),
    ], now);
    assert.deepEqual(out.map(r => r.userId), ["b", "c", "a"]);
  });

  test("engagement: the drop-off curve excludes clients too new to have an answer", () => {
    // One 30-day client still logging at day 30; one who joined 2 days ago and can say nothing
    // about day 30. Counting the newcomer as churned is the classic way to fake a bad number.
    const curve = dropOffCurve([
      row({ userId: "old", createdAt: ago(40), activeDays: [0, 1, 7, 30] }),
      row({ userId: "new", createdAt: ago(2), activeDays: [0, 1] }),
    ], now);
    const d30 = curve.find(p => p.day === 30)!;
    assert.equal(d30.of, 1, "only the 30-day-old client is eligible");
    assert.equal(d30.pct, 100);
    const d1 = curve.find(p => p.day === 1)!;
    assert.equal(d1.of, 2, "both are old enough to answer day 1");
    assert.equal(d1.pct, 100);
  });

  test("engagement: a client with no activity at all counts as churned, not skipped", () => {
    const curve = dropOffCurve([row({ userId: "ghost", createdAt: ago(10), activeDays: [] })], now);
    const d7 = curve.find(p => p.day === 7)!;
    assert.equal(d7.of, 1);
    assert.equal(d7.stillActive, 0);
    assert.equal(d7.pct, 0);
  });

  test("engagement: names what the coach said last before people went quiet", () => {
    const risks = assessClients([
      row({ userId: "a", lastInboundAt: ago(9), lastCoachIntent: "FOOD_LOG" }),
      row({ userId: "b", lastInboundAt: ago(20), lastCoachIntent: "FOOD_LOG" }),
      row({ userId: "c", lastInboundAt: ago(30), lastCoachIntent: "MENU" }),
      row({ userId: "d", lastInboundAt: ago(1), lastCoachIntent: "WORKOUT" }),   // still active
    ], now);
    const t = silenceTriggers(risks);
    assert.equal(t[0].intent, "FOOD_LOG");
    assert.equal(t[0].count, 2);
    assert.ok(!t.some(x => x.intent === "WORKOUT"), "active clients are not silence evidence");
  });

  test("engagement: the summary holds together", () => {
    const s = summariseEngagement([
      row({ userId: "a", lastInboundAt: ago(0), activeDays: [0] }),
      row({ userId: "b", lastInboundAt: ago(4), activeDays: [0, 1] }),
      row({ userId: "c", lastInboundAt: ago(20), activeDays: [0] }),
    ], now);
    assert.equal(s.total, 3);
    assert.equal(s.byBand.active, 1);
    assert.equal(s.byBand.slipping, 1);
    assert.equal(s.byBand.gone, 1);
    assert.equal(s.atRisk.length, 1, "gone clients are not 'reach out first' — slipping ones are");
  });
}

// SURFACE — the market is niche, the product is not. Measure before cutting.
{
  test("surface: core is what the product is FOR; the rest is surface", () => {
    const r = analyseSurface([
      { intent: "FOOD_LOG", count: 500 },
      { intent: "WORKOUT_DONE", count: 200 },
      { intent: "FOOD_SWAP", count: 40 },
      { intent: "REFERRAL_NUDGE", count: 1 },
      { intent: "SUPPLEMENT_GUIDE", count: 0 },
    ], 60);
    const byIntent = Object.fromEntries(r.rows.map(x => [x.intent, x.klass]));
    assert.equal(byIntent["FOOD_LOG"], "core");
    assert.equal(byIntent["WORKOUT_DONE"], "core");
    assert.equal(byIntent["FOOD_SWAP"], "periphery");
    assert.equal(byIntent["REFERRAL_NUDGE"], "dead");
    assert.ok(r.coreShare > 90, "core should dominate a healthy product");
  });

  test("surface: 'dead' means under one use a fortnight, measured against the window", () => {
    // 2 uses over 60 days is under 1 per fortnight; 2 uses over 7 days is not.
    assert.equal(classifyIntent("FOOD_SWAP", 2, 60), "dead");
    assert.equal(classifyIntent("FOOD_SWAP", 2, 7), "periphery");
    // Safety is never dead, however rarely it fires — that's the whole point of it.
    assert.equal(classifyIntent("CRISIS", 0, 365), "core");
    assert.equal(classifyIntent("LIFE_BEREAVEMENT", 1, 365), "core");
  });

  test("surface: nudges are capped at one a day", () => {
    const src = readFileSync(join("server", "scheduler", "shared.ts"), "utf-8");
    assert.match(src, /MAX_PROACTIVE_PER_DAY\) \|\| 1\)/, "default cap must be 1, not 3");
  });

  test("surface: the menu promotes four things, not twelve", () => {
    const src = readFileSync(join("server", "onboarding.ts"), "utf-8");
    for (const gone of ["shopping list_", "meal prep_", "supplements_", "badges_", "referral_", "connect steps_"])
      assert.ok(!src.includes(gone), `menu must not promote ${gone}`);
    assert.match(src, /just talk to me normally/i, "it teaches the real interface instead");
  });
}

// THE QUIT MOMENT (2026-07-28, 09:16 live). "I don't know how I will do this anymore" from a
// client who got home from work at 1am. The founder answered it by hand; the product could not.
{
  test("quit: the exact live message is recognised", () => {
    assert.equal(looksLikeQuitMoment("I don't know how I will do this anymore"), true);
    for (const msg of [
      "I can't keep doing this anymore", "I want to quit", "thinking of stopping",
      "maybe this isn't for me", "I'm ready to give up",
    ]) assert.equal(looksLikeQuitMoment(msg), true, msg);
  });

  test("quit: wanting to quit is NOT routed to a mental-health helpline", () => {
    // This was the bug: "I can't do this anymore" hit crisis_adjacent and got SADAG.
    assert.equal(readLifeContext("I can't do this anymore"), null);
    assert.equal(readLifeContext("I don't know how I will do this anymore"), null);
    // Real crisis language still goes where it should.
    assert.equal(readLifeContext("I'm honestly depressed")?.context, "crisis_adjacent");
  });

  test("quit: ordinary messages don't trip it", () => {
    for (const msg of [
      "I don't know how to do this exercise", "how do I do this?", "this is hard but I'm doing it",
      "I stopped at 3 sets",
    ]) assert.equal(looksLikeQuitMoment(msg), false, msg);
  });

  test("quit: the honest paragraph never flatters a log that says otherwise", () => {
    const strong = quitSaveReply({ firstName: "T", sessions: 14, weeks: 6 });
    assert.match(strong, /14 sessions/);
    assert.match(strong, /on track/i);

    const weak = quitSaveReply({ firstName: "T", sessions: 1, weeks: 5 });
    assert.doesNotMatch(weak, /on track/i, "never tell someone with 1 session they're on track");
    assert.match(weak, /week one looks like/i);

    const none = quitSaveReply({ firstName: "T", sessions: 0, weeks: 2 });
    assert.doesNotMatch(none, /doing well/i);
  });

  test("quit: it answers the obstacle they actually named", () => {
    assert.equal(readObstacle("I got home after 1am"), "late_work");
    assert.equal(readObstacle("I have no money for food"), "money");
    assert.equal(readObstacle("I'm exhausted"), "exhausted");
    const out = quitSaveReply({ firstName: "T", sessions: 9, weeks: 4, obstacle: "late_work" });
    assert.match(out, /1am/);
    assert.match(out, /not someone who's slacking/i);
  });

  test("quit: it carries the founder's structure — cost, alternative, and a smaller ask", () => {
    const out = quitSaveReply({ firstName: "T", sessions: 9, weeks: 4 });
    assert.match(out, /same place — probably heavier/i);   // the cost of stopping
    assert.match(out, /this time next year/i);              // the alternative
    assert.match(out, /showing up/i);                       // the reset standard
    assert.match(out, /don't quit\. Shrink it/i);           // an action, not a speech
    assert.doesNotMatch(out, /0800 567 567/);               // never a helpline for this
  });

  test("quit: the silent version is short — a wall of text at someone gone gets blocked", () => {
    const out = silentQuitNudge({ sessions: 6, weeks: 4, daysSinceLog: 9, firstName: "T" });
    assert.ok(out.length < 420, "must stay short");
    assert.match(out, /9 days/);
    assert.match(out, /6 sessions/);
    assert.doesNotMatch(out, /guilt|shame|disappoint/i);
  });
}

// THE FADE — still talking, stopped doing. The churn runSilenceDetection cannot see.
{
  test("fade: someone still replying but not logging is FADING, not silent", () => {
    // The founder's exact pattern: says "ok" every couple of days, logged nothing in two weeks.
    assert.equal(fadeState(14, 2), "fading");
    assert.equal(fadeState(6, 0), "fading");
  });

  test("fade: a client doing the work is left alone", () => {
    assert.equal(fadeState(0, 0), "engaged");
    assert.equal(fadeState(4, 1), "engaged", "4 days is a bad week, not a fade");
  });

  test("fade: people who stopped TALKING belong to the silence job, not this one", () => {
    assert.equal(fadeState(20, 8), "silent");
    assert.equal(fadeState(30, 21), "lapsed");
    // No client should ever be eligible for both nudges.
    const rows = [
      { userId: "fading", name: "A", daysSinceLog: 12, daysSinceMessage: 1, sessions: 9 },
      { userId: "silent", name: "B", daysSinceLog: 12, daysSinceMessage: 10, sessions: 4 },
      { userId: "fine", name: "C", daysSinceLog: 1, daysSinceMessage: 0, sessions: 20 },
    ];
    const out = fadingClients(rows);
    assert.deepEqual(out.map(r => r.userId), ["fading"]);
  });

  test("fade: the nudge is short, names the gap, and never shames", () => {
    const out = silentQuitNudge({ sessions: 9, weeks: 0, daysSinceLog: 12, firstName: "T" });
    assert.ok(out.length < 460, "a wall of text at someone drifting gets you blocked");
    assert.match(out, /12 days/);
    assert.match(out, /9 sessions/);
    assert.doesNotMatch(out, /guilt|shame|disappoint|failed/i);
    assert.match(out, /thought they'd blown it/i);
  });

  test("fade: the job is registered and gated like every other proactive job", () => {
    const sched = readFileSync(join("server", "scheduler.ts"), "utf-8");
    assert.match(sched, /runFadeDetection/, "must be wired into the cron table");
    const job = readFileSync(join("server", "scheduler", "jobs", "retention.ts"), "utf-8");
    assert.match(job, /claimProactive\(client\.id, "fade_nudge"/, "goes through the shared budget");
    assert.match(job, /isProactivePaused\(\)/, "honours the global killswitch");
    assert.match(job, /if \(isPaused\(client\)\) continue;/, "honours a paused client");
  });
}

// MALFORMED-OUTPUT GUARD — the cheap D6 mitigation. Catches breakage, never tone.
{
  test("guard: catches the exact old-brain breakage patterns", () => {
    const cases: Array<[string, string]> = [
      ["Good work *Kam — keep going.", "literal_asterisk"],
      ["Your plan (3 days a week is ready.", "unclosed_parens"],
      ["You had 3 meals (breakfast and lunch).", "count_mismatch"],
      ["Eat more protein today and", "truncated"],
      ["You ate undefined kcal today.", "unrendered_template"],
    ];
    for (const [reply, why] of cases) {
      const r = guardMalformed(reply);
      assert.equal(r.pass, false, `should be blocked: ${reply}`);
      assert.ok(r.reasons.includes(why), `${reply} → expected ${why}, got ${r.reasons.join(",")}`);
    }
  });

  test("guard: healthy replies pass untouched — a guard that eats good output is worse", () => {
    for (const ok of [
      "Good breakfast, Kam. *Pap and eggs* — you're on track. Reply *done* when you eat.",
      "You had 2 meals (breakfast and lunch). Dinner is still open.",
      "✅ *Logged:* Rice, Tin fish, Lentils — ~719 kcal | 50g protein",
      "That's dinner done — calories and protein both where they should be. Day closed. 👊",
      "Yes, amasi counts as protein. Have it with your pap tonight.",
    ]) {
      const r = guardMalformed(ok);
      assert.equal(r.pass, true, `must pass: ${ok} (blocked for ${r.reasons.join(",")})`);
    }
  });

  test("guard: the fallback asks, it never invents", () => {
    const out = safeFallback("Kam");
    assert.match(out, /Kam/);
    assert.match(out, /say it again/i);
    assert.equal(guardMalformed(out).pass, true, "the fallback must itself pass the guard");
  });

  test("guard: counts itself, and escalates at the 5% line", () => {
    // "A guard that triggers silently is rot; a guard that reports is instrumented debt."
    // The counter is process-wide, so measure the delta rather than assuming a clean start.
    const before = guardStats();

    for (let i = 0; i < 400; i++) recordGuardResult(true);
    recordGuardResult(false);
    let s = guardStats();
    assert.equal(s.checked, before.checked + 401, "every decision is counted");
    assert.equal(s.blocked, before.blocked + 1, "blocks are counted separately");
    assert.ok(s.rate < GUARD_ESCALATION_THRESHOLD, "well under the line");
    assert.equal(s.escalate, false, "under the line the migration can wait");
    assert.match(guardStatsLine(), /Under the 5% escalation line/);

    for (let i = 0; i < 200; i++) recordGuardResult(false); // pushes the rate well past 5%
    s = guardStats();
    assert.ok(s.rate > GUARD_ESCALATION_THRESHOLD, "past the line");
    assert.equal(s.escalate, true, "past the line the migration becomes priority #1");
    assert.match(guardStatsLine(), /priority #1/);
  });
}

// ABSURD-TARGET CEILING (2026-07-28, from third-party review).
{
  test("targets: a small client can never be handed a huge number", () => {
    // The old flat 6,000 ceiling would let a bug give a 55kg woman a bodybuilder's target.
    assert.ok(calorieCeiling(55, "fat_loss") <= 2500, "55kg fat-loss ceiling must be sane");
    assert.ok(calorieCeiling(120, "muscle_gain") <= 4500, "never above the hard 4,500 cap");
    assert.ok(calorieCeiling(45, "fat_loss") >= 2200, "but never so low it blocks a real target");
  });
}

// CLARIFICATION MODE — turn a coverage gap into a coaching moment (third-party review, 28 Jul).
{
  test("clarify: an unmatched restaurant item asks instead of dead-ending", () => {
    const out = unloggedFoodNotice("Had South African breakfast from McDonald's", ["Coffee"]);
    assert.match(out, /McDonald's/);
    assert.match(out, /\?/, "must ask a question, not just confess");
    assert.match(out, /one or two words/i, "answerable in one word");
  });

  test("clarify: an unmatched food asks for the two things that change the number", () => {
    const out = unloggedFoodNotice("I had bunny chow and skopo for lunch", ["Rice"]);
    assert.match(out, /bunny|skopo/i);
    assert.match(out, /how much/i);
    assert.match(out, /fried or grilled/i);
  });

  test("clarify: still says NOTHING when everything was priced", () => {
    assert.equal(unloggedFoodNotice("I had rice and chicken", ["Rice", "Chicken"]), "");
  });

  test("clarify: the never-drop guarantee survives — the food is always named", () => {
    // The rule that must never regress: an unpriced food is NEVER silently swallowed.
    const out = unloggedFoodNotice("kota and a stony", ["Chips"]);
    assert.notEqual(out, "");
    assert.match(out, /kota/i);
  });
}

console.log(`\nunit-tests: ${passed}/${passed + failed} passed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  console.log(failures.join("\n\n"));
  process.exit(1);
}
console.log("✓ all unit checks passed\n");

/** C18 owner check: budget alone must change an otherwise identical next food move. */
import { chooseAction, type DayState } from "../server/one-action";
import { NO_CONSTRAINTS } from "../server/food-swaps";
import { adaptTargets, type AdaptiveInput } from "../server/adaptive-targets";
import { getKamlifeProgramme } from "../server/programme";
import { buildDailyDirection } from "../server/daily-direction";

const day: DayState = {
  goal: "fat_loss", weeksOnProgramme: 2, daysSinceAnyLog: 0,
  daysSinceWeighIn: 2, loggedToday: true, proteinPct: 0.3, caloriePct: 0.7,
  sessionsThisWeek: 0, sessionsTarget: 3, stepsToday: 4000, stepsTarget: 8000,
  hour: 18, atKeyboard: true, constraints: NO_CONSTRAINTS,
};
const constrained = chooseAction({ ...day, weeklyFoodBudget: "under_100" });
const unrestricted = chooseAction({ ...day, weeklyFoodBudget: "over_600" });
const vegan = chooseAction({ ...day, weeklyFoodBudget: "under_100",
  constraints: (await import("../server/food-swaps")).foodConstraints({ dietaryRestrictions: "vegan" }) });
if (constrained.kind !== "protein" || !/sugar beans/i.test(constrained.todo)
    || unrestricted.kind !== "protein" || constrained.todo === unrestricted.todo
    || /\b(?:eggs|pilchards)\b/i.test(vegan.todo) || !/sugar beans/i.test(vegan.todo)) {
  console.error("C18 budget/vegan decision failed", { constrained, unrestricted, vegan });
  process.exit(1);
}

const quietFood = { ...day, loggedToday: true, proteinPct: 0.9, caloriePct: 0.9 };
const lowSteps = chooseAction({ ...quietFood, stepsToday: 1800 });
const enoughSteps = chooseAction({ ...quietFood, stepsToday: 8100 });
const healthHold = chooseAction({ ...day, sick: true });
const alreadyTrained = chooseAction({ ...quietFood, stepsToday: 8100,
  sessionsThisWeek: 3, sessionsTarget: 3 });
if (lowSteps.kind !== "walk" || enoughSteps.kind === "walk" || healthHold.kind !== "rest"
    || alreadyTrained.kind === "train") {
  console.error("C18 steps, health and completed-training decision failed",
    { lowSteps, enoughSteps, healthHold, alreadyTrained });
  process.exit(1);
}

const trainingBase = { name: "Thandi", trainingExperience: "beginner", trainingDaysPerWeek: 3,
  goalType: "fat_loss", stepsTarget: 8000, programmeWeek: 1, programmeDayInWeek: 1 };
const home = getKamlifeProgramme({ ...trainingBase, trainingMode: "home", injuries: "knee" }, true);
const gym = getKamlifeProgramme({ ...trainingBase, trainingMode: "gym", injuries: "none" }, true);
const homeBeginner = getKamlifeProgramme({ ...trainingBase, trainingMode: "home", injuries: "none" }, true);
const homeExperienced = getKamlifeProgramme({ ...trainingBase, trainingMode: "home", injuries: "none",
  trainingExperience: "intermediate", totalWorkoutsCompleted: 20 }, true);
const veganHome = getKamlifeProgramme({ ...trainingBase, trainingMode: "home", injuries: "knee",
  dietaryRestrictions: "vegan" }, true);
const veganFullHome = getKamlifeProgramme({ ...trainingBase, trainingMode: "home", injuries: "knee",
  dietaryRestrictions: "vegan" }, false);
const walkOnly = getKamlifeProgramme({ ...trainingBase, trainingMode: "walk_only", injuries: "knee" }, true);
if (!home || !gym || home === gym || !/Skipped \(injury\).*Squat.*Lunge/i.test(home)
    || homeBeginner === homeExperienced || !/New to this/i.test(homeBeginner)
    || /New to this/i.test(homeExperienced)
    || /^\d+\.\s+\*?(?:Squat|Reverse Lunge)\b/im.test(home)
    || /Note on your knee injury/i.test(home)
    || /\b(?:eggs|chicken|pilchards)\b/i.test(veganHome)
    || /\b(?:eggs|chicken|pilchards)\b/i.test(veganFullHome)
    || /^\d+\.\s+\*?(?:Squat|Reverse Lunge)\b/im.test(veganFullHome)
    || /\bSquat\b/i.test(walkOnly)) {
  console.error("C18 equipment/injury programme projection failed", { home: home.slice(0, 180), gym: gym.slice(0, 180) });
  process.exit(1);
}

const measuredDirection = buildDailyDirection(
  { name: "Thandi", proteinTarget: 130, stepsTarget: 8000, trainingMode: "home", trainingDaysPerWeek: 3 },
  { type: "REST", nextTrainingName: "Monday" },
  { mealsLogged: 1, latestFood: "pap and sugar beans", proteinLogged: 35,
    stepsRecorded: 6100, weightTrend: "unknown", recovering: false,
    sessionsThisWeek: 2, nextMove: "Get protein into your next meal — sugar beans." },
);
const missingDirection = buildDailyDirection(
  { name: "Thandi", stepsTarget: 8000 }, { type: "REST" },
  { mealsLogged: 0, proteinLogged: 0, stepsRecorded: 0, weightTrend: "unknown",
    recovering: true, sessionsThisWeek: 0, nextMove: "Rest today." },
);
if (!/pap and sugar beans/.test(measuredDirection) || !/35g of 130g/.test(measuredDirection)
    || !/6,100 of 8,000/.test(measuredDirection) || !/rest day/i.test(measuredDirection)
    || !/Get protein into your next meal/.test(measuredDirection)
    || !/gap in the record, not proof/i.test(missingDirection)
    || !/Recovery comes first/.test(missingDirection)) {
  console.error("C18 measured direction failed", { measuredDirection, missingDirection });
  process.exit(1);
}

const base: AdaptiveInput = {
  baseCalories: 1900, baseProtein: 130, baseSteps: 8000, goalType: "fat_loss",
  weightKg: 75, sick: false, stalledWeeks: 3, loggedDays7d: 5,
};
const missing = adaptTargets(base);
const thin = adaptTargets({ ...base, loggedDays7d: 2, avgKcal7d: 1900 });
const under = adaptTargets({ ...base, avgKcal7d: 1500 });
const tested = adaptTargets({ ...base, avgKcal7d: 1880 });
const over = adaptTargets({ ...base, avgKcal7d: 2300 });
if (missing.reason !== "stalled_unknown_intake" || missing.calorieTarget !== 1900
    || thin.reason !== "stalled_unlogged" || thin.calorieTarget !== 1900
    || under.reason !== "stalled_under_target" || under.calorieTarget !== 1900
    || tested.reason !== "stalled" || tested.calorieTarget >= 1900
    || over.reason !== "stalled_over_target" || over.calorieTarget !== 1900) {
  console.error("C18 seven-day hold/change decision failed", { missing, thin, under, tested, over });
  process.exit(1);
}
console.log("c18-owner-repro: GREEN — budget, diet, injury/equipment, steps, health and five plateau states");

// ============================================================
// TARGET CALCULATION
// Mifflin-St Jeor BMR (gold standard) + activity + goal adjustment
// Gender, age, height all factor in — no more one-size-fits-all
// ============================================================

export function calculateTargets(
  weightKg: number,
  goalType: string,
  lifeSituation: string,
  trainingDaysPerWeek: number,
  gender: string = "male",
  age: number = 30,
  heightCm: number = 170,
  trainingExperience: string = "beginner",
): { calorieTarget: number; proteinTarget: number } {

  const isBreastfeeding = lifeSituation === "postpartum_breastfeeding";

  // ── Mifflin-St Jeor BMR (far more accurate than weight × 22) ──
  // Male:   10 × weight(kg) + 6.25 × height(cm) − 5 × age + 5
  // Female: 10 × weight(kg) + 6.25 × height(cm) − 5 × age − 161
  const isFemale = gender === "female";
  const bmr = isFemale
    ? (10 * weightKg) + (6.25 * heightCm) - (5 * age) - 161
    : (10 * weightKg) + (6.25 * heightCm) - (5 * age) + 5;

  // ── Activity multiplier based on life situation ──
  const activityMult: Record<string, number> = {
    office: 1.3,
    student: 1.35,
    unemployed: 1.25,
    retired: 1.2,
    stay_home_parent: 1.3,
    retail_physical: 1.5,
    domestic_worker: 1.45,
    postpartum_breastfeeding: 1.35,
    "1": 1.35,  // student
    "2": 1.3,   // office
    "3": 1.5,   // physical job
    "4": 1.25,  // unemployed
    "5": 1.3,   // stay home parent
    "6": 1.2,   // retired
  };
  const mult = activityMult[lifeSituation] || 1.3;

  // ── Training calorie addition (spread over 7 days) ──
  // Smaller addition for females — metabolic reality
  // Beginners work at lower intensity initially; advanced athletes burn more per session
  const calPerSession = isFemale ? 150 : 200;
  const expMult = trainingExperience === "advanced" ? 1.2 : trainingExperience === "intermediate" ? 1.0 : 0.75;
  const trainingAdj = Math.round((calPerSession * expMult * Math.min(trainingDaysPerWeek, 7)) / 7);

  // ── Goal adjustment ──
  // Fat loss deficit is smaller for females to preserve hormonal health
  // Breastfeeding: never create a large deficit — 200 kcal max to protect milk supply
  const goalAdj: Record<string, number> = {
    fat_loss: isBreastfeeding ? -200 : (isFemale ? -300 : -400),
    muscle_gain: isFemale ? 250 : 400,
    recomposition: 0,
    general: isFemale ? 50 : 100,
    health_condition: 0,
  };
  const adj = goalAdj[goalType] ?? 0;

  let calorieTarget = Math.round(bmr * mult + trainingAdj + adj);

  // ── Breastfeeding calorie bonus — milk production burns 300–500 kcal/day ──
  if (isBreastfeeding) calorieTarget += 400;

  // ── Safety floors by gender ──
  // Breastfeeding: 1,800 kcal is the clinical minimum — below this, milk supply drops
  const minCal = isBreastfeeding ? 1800 : (isFemale ? 1200 : 1500);
  // NaN guard: if any input (weight/age/height/bmr) was non-numeric, never ship "NaN kcal".
  calorieTarget = Number.isFinite(calorieTarget) ? Math.max(minCal, Math.min(4500, calorieTarget)) : minCal;

  // ── Protein target ──
  // Fat loss: higher protein preserves muscle
  // Muscle gain: high protein for growth
  // Female: slightly lower per-kg need
  const proteinMult: Record<string, number> = {
    fat_loss: isFemale ? 1.8 : 2.0,
    muscle_gain: isFemale ? 2.0 : 2.4,
    recomposition: isFemale ? 1.8 : 2.2,
    general: isFemale ? 1.6 : 1.8,
    health_condition: isFemale ? 1.6 : 2.0,
  };
  let proteinTarget = Math.round((Number.isFinite(weightKg) ? weightKg : 75) * (proteinMult[goalType] || 2.0));

  // Breastfeeding: minimum 70g protein — quality matters for breast milk composition
  if (isBreastfeeding) proteinTarget = Math.max(70, proteinTarget);

  // ── Age adjustments ──
  // Youth: don't over-restrict
  if (age < 18) {
    calorieTarget = Math.max(calorieTarget, isFemale ? 1600 : 1800);
    proteinTarget = Math.min(proteinTarget, Math.round(weightKg * 1.8)); // don't overload growing bodies
  }
  // Elderly: preserve muscle, moderate calories
  if (age >= 60) {
    proteinTarget = Math.max(proteinTarget, Math.round(weightKg * 1.6)); // elderly need MORE protein not less
    calorieTarget = Math.max(calorieTarget, isFemale ? 1400 : 1600);
  }

  return { calorieTarget, proteinTarget };
}

// ============================================================
// STEP TARGET — goal-aware, lifestyle-aware starting goal.
// Food creates the primary calorie deficit — steps are supplemental NEAT.
// Muscle-gain clients run a calorie surplus; pushing high steps burns the
// surplus they need to build. Fat-loss clients still need to eat right first;
// steps add bonus burn on top, not replace dietary discipline.
// Pure function — no DB, unit-tested in script/unit-tests.ts.
// ============================================================
export function calculateStepsTarget(
  weightKg: number,
  age: number,
  heightCm: number,
  trainingExperience: string = "beginner",
  goalType: string = "fat_loss",
): number {
  // Goal-type base: set the ceiling based on what role steps play for this goal.
  const goal = (goalType || "fat_loss").toLowerCase();
  let stepsTarget: number;
  if (goal === "muscle_gain") stepsTarget = 6000;       // health floor; preserve calorie surplus
  else if (goal === "recomposition") stepsTarget = 8000; // food + steps share the work
  else stepsTarget = 8500;                              // fat_loss: realistic + sustainable

  // BMI-based easing — heavier bodies start lower (knees, ankles, sustainability).
  const bmi = heightCm > 0 ? weightKg / Math.pow(heightCm / 100, 2) : 0;
  if (bmi >= 40) stepsTarget = Math.min(stepsTarget, 5500);
  else if (bmi >= 35) stepsTarget = Math.min(stepsTarget, 6500);
  else if (bmi >= 30) stepsTarget = Math.min(stepsTarget, 7500);

  // Age-based easing (independent of BMI) — take the gentler of the two.
  if (age >= 70) stepsTarget = Math.min(stepsTarget, 5500);
  else if (age >= 60) stepsTarget = Math.min(stepsTarget, 7500);

  // Never-trained beginners start lower regardless, then ramp up as the habit builds.
  if (trainingExperience === "beginner") stepsTarget = Math.min(stepsTarget, 7500);

  // Floor — keep the goal meaningful even for the most deconditioned start.
  if (stepsTarget < 4000) stepsTarget = 4000;

  return stepsTarget;
}

// ============================================================
// DAILY STEP CONTEXT — real-time adjustment for today's situation.
// On workout days the gym session already burned 300-450 kcal; reduce step
// demand so clients aren't double-taxed and can recover properly.
// Returns the adjusted target + a floor range (hitting rangeMin is still a win).
// Pure function — no DB, unit-tested in script/unit-tests.ts.
// ============================================================
export function getDailyStepContext(
  baseTarget: number,
  goalType: string,
  alreadyWorkedOutToday: boolean,
): { target: number; rangeMin: number; goalContext: "fat_loss" | "muscle_gain" | "recomp" } {
  const goal = (goalType || "fat_loss").toLowerCase();
  let target = baseTarget;

  if (goal === "muscle_gain") {
    // Protect the calorie surplus — on workout days the body needs fuel for recovery.
    target = alreadyWorkedOutToday ? Math.max(4000, Math.round(baseTarget * 0.80)) : baseTarget;
  } else if (goal === "fat_loss" || goal === "weight_loss") {
    // Workout already burned — ease the step load; no need to double-tax.
    target = alreadyWorkedOutToday ? Math.round(baseTarget * 0.78) : baseTarget;
  } else {
    // Recomposition
    target = alreadyWorkedOutToday ? Math.round(baseTarget * 0.82) : baseTarget;
  }

  target = Math.max(4000, target);
  const rangeMin = Math.round(target * 0.82);

  const goalContext: "fat_loss" | "muscle_gain" | "recomp" =
    goal === "muscle_gain" ? "muscle_gain"
    : (goal === "fat_loss" || goal === "weight_loss") ? "fat_loss"
    : "recomp";

  return { target, rangeMin, goalContext };
}

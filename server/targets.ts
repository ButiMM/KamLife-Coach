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
  calorieTarget = Math.max(minCal, Math.min(4500, calorieTarget));

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
  let proteinTarget = Math.round(weightKg * (proteinMult[goalType] || 2.0));

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
// STEP TARGET — eased-in STARTING goal, not a flat number for everyone.
// A deconditioned, heavier, older, or never-trained body needs a lower
// starting goal to avoid joint overload and week-one burnout. The programme
// then applies a further week-1/2 ramp on top of this (70% → 85% → 100%),
// so people build up gradually instead of being thrown straight into 10k.
// Pure function — no DB, unit-tested in script/unit-tests.ts.
// ============================================================
export function calculateStepsTarget(
  weightKg: number,
  age: number,
  heightCm: number,
  trainingExperience: string = "beginner",
): number {
  let stepsTarget = 10000;

  // BMI-based easing — heavier bodies start lower (knees, ankles, sustainability).
  const bmi = heightCm > 0 ? weightKg / Math.pow(heightCm / 100, 2) : 0;
  if (bmi >= 40) stepsTarget = 6000;        // severe obesity
  else if (bmi >= 35) stepsTarget = 7000;   // obesity class II
  else if (bmi >= 30) stepsTarget = 8000;   // obesity class I

  // Age-based easing (independent of BMI) — take the gentler of the two.
  if (age >= 70) stepsTarget = Math.min(stepsTarget, 6000);
  else if (age >= 60) stepsTarget = Math.min(stepsTarget, 8000);

  // Never-trained beginners start a notch lower regardless, then ramp up.
  if (trainingExperience === "beginner") stepsTarget = Math.min(stepsTarget, 8500);

  // Floor — keep the goal meaningful even for the most deconditioned start.
  if (stepsTarget < 5000) stepsTarget = 5000;

  return stepsTarget;
}

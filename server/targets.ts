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

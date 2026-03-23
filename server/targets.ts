// ============================================================
// TARGET CALCULATION
// Harris-Benedict based calorie and protein target calculator
// ============================================================

export function calculateTargets(
  weightKg: number,
  goalType: string,
  lifeSituation: string,
  trainingDaysPerWeek: number,
): { calorieTarget: number; proteinTarget: number } {
  const bmr = weightKg * 22;

  const activityMult: Record<string, number> = {
    office: 1.3, student: 1.35, unemployed: 1.25, retired: 1.2,
    stay_home_parent: 1.3, retail_physical: 1.5,
    "1": 1.35, "2": 1.3, "3": 1.5, "4": 1.25, "5": 1.3, "6": 1.2,
  };
  const mult = activityMult[lifeSituation] || 1.3;

  const trainingAdj = Math.round((200 * Math.min(trainingDaysPerWeek, 7)) / 7);

  const goalAdj: Record<string, number> = {
    fat_loss: -400, muscle_gain: 400, recomposition: 0,
    general: 100, health_condition: 0,
  };
  const adj = goalAdj[goalType] ?? 0;

  let calorieTarget = Math.round(bmr * mult + trainingAdj + adj);
  calorieTarget = Math.max(1500, Math.min(4500, calorieTarget));

  const proteinMult: Record<string, number> = {
    fat_loss: 2.0, muscle_gain: 2.4, recomposition: 2.2,
    general: 1.8, health_condition: 2.0,
  };
  const proteinTarget = Math.round(weightKg * (proteinMult[goalType] || 2.0));

  return { calorieTarget, proteinTarget };
}

/**
 * MACRO ESTIMATE — fill carbs & fat when a log path only captured calories + protein.
 *
 * (2026-07-22, Kam: "I ate WAY more carbs than 107g — check my logs.") The photo/vision
 * path stores kcal + protein but writes carbsInt/fatInt = 0, so every photo-logged meal
 * contributed zero carbs to the day card — systematically undercounting the Carbs bar.
 * We know the two trusted numbers (kcal, protein); split the REMAINING energy into carbs
 * and fat by a typical mixed-plate ratio so the card is realistic instead of wrong.
 *
 * This is an ESTIMATE, consistent with the card's "~" numbers. It is ONLY for paths that
 * captured no carb data — the SA scanner measures carbs from the food table directly and
 * must never be overwritten by this. Pure — unit-tested in script/unit-tests.ts.
 */
/**
 * THE MEASURED HALF — carbs and fat for foods the table actually knows.
 *
 * Moved here 2026-08-16 from the scanner path, where it was inlined twice, once per macro. It
 * had to have one owner the moment a message could write several rows: every event prices its
 * own plate, and two copies of this arithmetic drifting apart would put a different definition
 * of "carbs" on the breakfast row and the lunch row of the same sentence.
 *
 * Per food, take the LOWER of the dry estimate (per-100g × grams — overcounts cooked staples,
 * which absorb water) and the energy-share estimate (overcounts alcohol, which carries energy
 * in neither macro). The two error modes never hit the same food, so min() is right for both.
 */
export function carbsFatFromFoods(foods: any[]): { carbs: number; fat: number } {
  const energy = (f: any) => 4 * (f.proteinPer100g || 0) + 4 * (f.carbsPer100g || 0) + 9 * (f.fatPer100g || 0);
  // The 4 and the 9 cancel out of the energy-share form (kcal × 4·c/e ÷ 4), so they are not
  // written here — carrying them would look like arithmetic the reader must check.
  const macro = (per100: "carbsPer100g" | "fatPer100g") => Math.round((foods || []).reduce((s, f: any) => {
    const dry = (f.typicalPortionGrams || 100) * (f.quantity || 1) * (f[per100] || 0) / 100;
    const e = energy(f);
    return s + Math.min(dry, e > 0 ? (f.adjustedCalories || 0) * ((f[per100] || 0) / e) : dry);
  }, 0));
  return { carbs: macro("carbsPer100g"), fat: macro("fatPer100g") };
}

export function estimateCarbsFat(kcal: number, proteinG: number): { carbs: number; fat: number } {
  const k = Number(kcal) || 0;
  const p = Math.max(0, Number(proteinG) || 0);
  if (k <= 0) return { carbs: 0, fat: 0 };
  const remaining = Math.max(0, k - p * 4); // energy left after protein
  // ~58% of the remaining energy from carbs, ~42% from fat — a typical mixed SA plate.
  return {
    carbs: Math.round((remaining * 0.58) / 4),
    fat: Math.round((remaining * 0.42) / 9),
  };
}

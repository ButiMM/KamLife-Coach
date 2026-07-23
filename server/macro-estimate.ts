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

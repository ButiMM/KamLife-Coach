/**
 * Pure meal-selection logic for the "same as yesterday / same lunch as dinner"
 * copy feature. Extracted from early-commands.ts so the exact selection rules
 * can be unit-tested without a DB.
 *
 * Production bug this guards (2026-06-24): a client logged only breakfast
 * yesterday, then said "same lunch as yesterday". The selector fell through to
 * "most recent substantial meal" and copied the breakfast AS lunch — the coach
 * confidently logged the wrong food. The fix: when a specific meal is requested
 * (the hint) and no meal matches it, return null so the caller asks instead of
 * fabricating.
 */

/** Minimal shape the selector needs — a subset of a meal_logs row. */
export interface CopyableMeal {
  kcalInt: number | null;
  loggedAt: Date | string | null;
  rawMessage: string | null;
  mealLabel: string | null;
}

/**
 * Pick which previously-logged meal to copy.
 *
 * Priority when a hint (target meal name) is given:
 *   1. a meal whose raw text mentions the hint word ("...for lunch")
 *   2. a meal whose stored label equals the hint
 *   3. positional fallback: breakfast = oldest, lunch = 2nd-newest
 *   4. null — DO NOT substitute a different meal (the bug fix)
 * With no hint: the most recent substantial meal.
 *
 * "Substantial" = >= 150 kcal. If nothing clears that bar, anything >= 50 kcal
 * is accepted as a last resort (covers a single light meal).
 *
 * @returns the chosen meal, or null when nothing appropriate exists.
 */
export function selectMealToCopy<T extends CopyableMeal>(meals: T[], hint: string | null): T | null {
  const sub = meals
    .filter(l => (l.kcalInt || 0) >= 150)
    .sort((a, b) => new Date(b.loggedAt!).getTime() - new Date(a.loggedAt!).getTime());

  if (sub.length === 0) return meals.find(l => (l.kcalInt || 0) >= 50) || null;

  if (hint) {
    const byRaw = sub.find(l => l.rawMessage && new RegExp(`\\b${hint}\\b`, "i").test(l.rawMessage));
    if (byRaw) return byRaw;
    const byLabel = sub.find(l => (l.mealLabel || "").toLowerCase() === hint);
    if (byLabel) return byLabel;
    if (hint === "breakfast") return sub[sub.length - 1]; // oldest = breakfast
    if (hint === "lunch" && sub.length >= 2) return sub[1]; // 2nd newest = lunch
    // Hint given but no matching meal found — return null so the caller tells the
    // user "no lunch found yesterday" instead of silently copying the wrong meal.
    return null;
  }

  return sub[0]; // default: most recent substantial meal (no hint)
}

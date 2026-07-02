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
 *   3. null — DO NOT substitute or positionally guess a different meal
 * With no hint: the most recent substantial meal.
 *
 * "Substantial" = >= 150 kcal. With no hint, anything >= 50 kcal is accepted as
 * a last resort (covers a single light meal). With a hint, never fall back to a
 * light log — copying a snack as "breakfast" fabricates a meal.
 *
 * Second production bug (2026-07-01): "breakfast same as yesterday" with no
 * text/label match hit the old positional rule (oldest meal = breakfast) and
 * copied a 197-kcal apple+pear snack as breakfast. Positional guessing is gone:
 * when the named meal can't be found, return null so the caller asks.
 *
 * @returns the chosen meal, or null when nothing appropriate exists.
 */
export function selectMealToCopy<T extends CopyableMeal>(meals: T[], hint: string | null): T | null {
  const sub = meals
    .filter(l => (l.kcalInt || 0) >= 150)
    .sort((a, b) => new Date(b.loggedAt!).getTime() - new Date(a.loggedAt!).getTime());

  if (sub.length === 0) {
    return hint ? null : meals.find(l => (l.kcalInt || 0) >= 50) || null;
  }

  if (hint) {
    const byRaw = sub.find(l => l.rawMessage && new RegExp(`\\b${hint}\\b`, "i").test(l.rawMessage));
    if (byRaw) return byRaw;
    const byLabel = sub.find(l => (l.mealLabel || "").toLowerCase() === hint);
    if (byLabel) return byLabel;
    return null;
  }

  return sub[0]; // default: most recent substantial meal (no hint)
}

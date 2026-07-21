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

import { slotFromSastHour } from "./utils";

/**
 * Which meal is being REPEATED and where does it go — pure, so it's unit-testable
 * without a DB. Given the lowercased message, returns whether this is a cross-meal
 * copy and the target/source slots. `sourceHint = null` means "the most recent meal
 * logged today" (e.g. "same for dinner", "dinner will be the same").
 */
export function parseMealRepeatTarget(m: string): { crossish: boolean; targetLabel: string | null; sourceHint: string | null } {
  // Cross-meal: "dinner same as lunch" → copy FROM lunch, log AS dinner
  const crossMealM =
    m.match(/\b(breakfast|lunch|dinner|supper|snack)\b.{0,60}?\bsame\s+as\s+(?:my\s+)?(breakfast|lunch|dinner|supper|snack)\b/i)
    || m.match(/\bsame\s+(breakfast|lunch|dinner|supper|snack)\s+as\s+(?:my\s+)?(breakfast|lunch|dinner|supper|snack)\b/i);
  // "I had the same (meal/food) as lunch" said at 20:38 = source lunch, target the
  // CURRENT slot (dinner) — logging their dinner as a second "lunch" reads insane.
  const sameAsMealM = !crossMealM && m.match(/\b(?:the\s+)?same\s+(?:meal|food|thing)?\s*as\s+(?:my\s+)?(breakfast|lunch|dinner|supper)\b/i);
  // "Same thing FOR dinner" (said after logging lunch) = copy the most recent meal
  // logged TODAY, log it AS dinner (2026-07-05 audit).
  const sameForM = !crossMealM && !sameAsMealM
    && m.match(/\bsame\s+(?:meal|food|thing|one)?\s*(?:for|at)\s+(breakfast|lunch|dinner|supper|snack)\b/i);
  // "[meal] will be the same" / "[meal] is the same" / "[meal] stays the same" — the meal
  // word is the TARGET, and "the same" with NO explicit source means the most recent meal
  // logged today (2026-07-21: "My dinner will be the same. Log it" was read as SOURCE=dinner,
  // found no dinner, and asked — instead of copying today's lunch as the dinner).
  const sameBeM = !crossMealM && !sameAsMealM && !sameForM
    && m.match(/\b(breakfast|lunch|dinner|supper|snack)\b[^.!?]{0,40}?\b(?:will\s+be|is|are|gonna\s+be|be|stays?|remains?)\b[^.!?]{0,20}?\bthe\s+same\b/i);
  const crossish = !!(crossMealM || sameAsMealM || sameForM || sameBeM);
  const targetLabel = crossMealM ? crossMealM[1].toLowerCase().replace("supper", "dinner")
    : sameAsMealM ? slotFromSastHour()
    : sameForM ? sameForM[1].toLowerCase().replace("supper", "dinner")
    : sameBeM ? sameBeM[1].toLowerCase().replace("supper", "dinner")
    : null;
  const sourceHint = crossMealM ? crossMealM[2].toLowerCase().replace("supper", "dinner")
    : sameAsMealM ? sameAsMealM[1].toLowerCase().replace("supper", "dinner")
    : sameForM ? null // the slot word is the TARGET here, not the source — source = newest meal today
    : sameBeM ? null // ditto — "[meal] will be the same" → source = newest meal today
    : (m.match(/\b(breakfast|lunch|dinner|supper|snack)\b/i)?.[1]?.toLowerCase().replace("supper", "dinner") || null);
  return { crossish, targetLabel, sourceHint };
}

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

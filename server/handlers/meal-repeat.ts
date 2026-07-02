/**
 * SAME-AS QUICK LOG — "same as yesterday", "dinner same as lunch", "had the same",
 * "2 days ago". The single owner of meal-repeat intent (extracted from
 * early-commands.ts; the shadowed duplicate in food-context.ts is deleted).
 *
 * Selection rules live in server/meal-select.ts (unit-tested — the 2026-06-24
 * breakfast-copied-as-lunch bug and the 2026-07-01 apple+pear positional bug).
 *
 * Guards carried here:
 *  - Negation: "I don't want the same as yesterday" must NOT relog.
 *  - 4-minute duplicate window (mirrors commitFoodLog): a double-send or Twilio
 *    webhook retry must not double-log the meal and inflate the day's calories.
 */
import { db } from "../db";
import { users, mealLogs } from "../../shared/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import { sastDayStart } from "../utils";
import { selectMealToCopy, type CopyableMeal } from "../meal-select";
import { recomputeTodayFoodTotals, invalidateFoodTotalsCache } from "./food-scanner";
import { logChat } from "./chat-log";

export async function handleMealRepeat(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
}): Promise<string | null> {
  const { phone, message, m, user } = ctx;

  const sameAsMatch =
    m.match(/\b(?:same|repeat|again|copy|log\s+(?:my\s+)?same)\b.*\b(breakfast|lunch|dinner|supper|snack|meal|yesterday|before|last)\b/i)
    || m.match(/\b(breakfast|lunch|dinner|supper|snack)\b.*\b(?:same|again|repeat|yesterday)\b/i)
    // Phrasings the deleted food-context duplicate used to own:
    || m.match(/\b(?:had|having)\s+the\s+same\b|\bsame\s+(?:meal|food|thing)\b|\bsame\s+again\b|\brepeat\s+meal\b|\byesterday.?s\s+(?:meal|food)\s+again\b/i)
    || /^same$/.test(m);

  // Negation guard: "I don't want the same as yesterday" / "not the same meal again"
  // must never relog (production audit catch, 2026-06-13).
  const wantsNotRepeat = /\b(don.?t|not|no|never|won.?t|wouldn.?t|avoid|skip)\b.{0,20}\b(same|repeat|again)\b/i.test(m)
    || /\b(same|repeat)\b.{0,20}\b(don.?t|not|no|never|won.?t|wouldn.?t)\b/i.test(m);

  if (!sameAsMatch || wantsNotRepeat) return null;

  // Cross-meal: "dinner same as lunch" → copy FROM lunch, log AS dinner
  const crossMealM =
    m.match(/\b(breakfast|lunch|dinner|supper|snack)\b.{0,60}?\bsame\s+as\s+(?:my\s+)?(breakfast|lunch|dinner|supper|snack)\b/i)
    || m.match(/\bsame\s+(breakfast|lunch|dinner|supper|snack)\s+as\s+(?:my\s+)?(breakfast|lunch|dinner|supper|snack)\b/i);
  const targetLabel = crossMealM ? crossMealM[1].toLowerCase().replace("supper", "dinner") : null;
  const sourceHint = crossMealM
    ? crossMealM[2].toLowerCase().replace("supper", "dinner")
    : (m.match(/\b(breakfast|lunch|dinner|supper|snack)\b/i)?.[1]?.toLowerCase().replace("supper", "dinner") || null);

  // How many days back to look
  const daysBack = /\b(?:three|3)\s*days?\s*(?:ago|back)\b/i.test(m) ? 3
    : /\b(?:two|2)\s*days?\s*(?:ago|back)\b/i.test(m) ? 2
    : /\byesterday\b/i.test(m) ? 1
    : 0;

  try {
    const todayStart = sastDayStart();
    // Always fetch last 3 days — covers all possible references
    const windowStart = new Date(todayStart.getTime() - 3 * 86_400_000);
    const allMeals = await db.select().from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, windowStart)))
      .orderBy(desc(mealLogs.loggedAt))
      .limit(30);

    // Pool = the right time slice for the request
    let poolMeals: typeof allMeals;
    if (daysBack > 0) {
      const dayStart = new Date(todayStart.getTime() - daysBack * 86_400_000);
      const dayEnd = new Date(todayStart.getTime() - (daysBack - 1) * 86_400_000);
      poolMeals = allMeals.filter(l => l.loggedAt && new Date(l.loggedAt) >= dayStart && new Date(l.loggedAt) < dayEnd);
      // Widen if specific day had nothing substantial
      if (poolMeals.filter(l => (l.kcalInt || 0) >= 150).length === 0) {
        poolMeals = allMeals.filter(l => l.loggedAt && new Date(l.loggedAt) < todayStart);
      }
    } else {
      poolMeals = allMeals; // include today for cross-meal ("dinner same as lunch")
    }

    const findBestMeal = (meals: typeof allMeals, hint: string | null) => selectMealToCopy(meals as unknown as CopyableMeal[], hint) as unknown as (typeof allMeals)[number] | null;

    // For cross-meal, prefer today's meals as the source
    const todayMeals = poolMeals.filter(l => l.loggedAt && new Date(l.loggedAt) >= todayStart);

    // Cross-meal with no "yesterday" reference means TODAY's meal — never silently
    // substitute an older one. Copying a 3-day-old lunch as "today's lunch" makes the
    // coach contradict what the client just told it.
    let todayCrossMatch: (typeof allMeals)[number] | null = null;
    if (crossMealM && daysBack === 0 && sourceHint) {
      const todaySub = todayMeals.filter(l => (l.kcalInt || 0) >= 100);
      todayCrossMatch =
        todaySub.find(l => l.rawMessage && new RegExp(`\\b${sourceHint}\\b`, "i").test(l.rawMessage))
        || todaySub.find(l => (l.mealLabel || "").toLowerCase() === sourceHint)
        || (todaySub.length === 1 ? todaySub[0] : null);
      if (!todayCrossMatch) {
        const honestMiss = `I don't have today's ${sourceHint} logged, so I can't copy it. Tell me what it was — "rice, tin fish and veg" — and I'll log it as your ${targetLabel || "meal"} now.`;
        await logChat(user.id, message, honestMiss, "SAME_AS_TODAY_MISS");
        return honestMiss;
      }
    }

    const searchPool = (crossMealM && todayMeals.filter(l => (l.kcalInt || 0) >= 150).length > 0)
      ? todayMeals : poolMeals;

    const match = todayCrossMatch || findBestMeal(searchPool, sourceHint);

    if (!match) {
      const timeRef = daysBack >= 2 ? `in the last ${daysBack} days` : daysBack === 1 ? "yesterday" : "recently";
      // If a specific meal was requested (e.g. "same lunch as yesterday") but only a
      // different meal exists, name it so the user can confirm rather than getting a
      // generic "nothing found" that ignores what we DID find.
      const anyMeal = findBestMeal(searchPool, null);
      const hintName = sourceHint ? sourceHint.charAt(0).toUpperCase() + sourceHint.slice(1) : null;
      const noMatch = hintName && anyMeal?.rawMessage
        ? `No ${hintName} logged ${timeRef} — I only see: _${anyMeal.rawMessage.slice(0, 80)}_. Tell me what your ${hintName} was and I'll log it now.`
        : `Nothing found ${timeRef} to repeat. Tell me what you ate and I'll log it now.`;
      await logChat(user.id, message, noMatch, "SAME_AS_YESTERDAY_MISS");
      return noMatch;
    }

    // 4-minute duplicate guard (mirrors commitFoodLog) — a double-sent "same as
    // yesterday" or a webhook retry must not log the meal twice.
    const dupWindow = new Date(Date.now() - 4 * 60_000);
    const [dupRecent] = await db.select({ id: mealLogs.id }).from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, dupWindow), eq(mealLogs.kcalInt, match.kcalInt || 0)))
      .limit(1);
    if (dupRecent) {
      const dupReply = `Already logged ✅ — that meal is counted in today's total.`;
      await logChat(user.id, message, dupReply, "SAME_AS_DUP");
      return dupReply;
    }

    await db.insert(mealLogs).values({
      userId: user.id,
      rawMessage: match.rawMessage || "[Repeat meal]",
      source: "retro",
      kcalInt: match.kcalInt,
      proteinInt: match.proteinInt,
      carbsInt: match.carbsInt || 0,
      fatInt: match.fatInt || 0,
      mealLabel: targetLabel || sourceHint || match.mealLabel || null,
      items: match.items,
    });
    invalidateFoodTotalsCache(user.id);
    const recomputed = await recomputeTodayFoodTotals(user.id);
    await db.update(users).set({
      todayCalories: recomputed.calories,
      todayProteinG: recomputed.protein,
    }).where(eq(users.phoneNumber, phone));

    const labelDisplay = (targetLabel || sourceHint || match.mealLabel || "Meal").replace(/\b\w/g, c => c.toUpperCase());
    const mealWasToday = match.loggedAt && new Date(match.loggedAt) >= todayStart;
    // Never say "copied from breakfast" ON a breakfast log — use a time reference instead.
    const fromNote = crossMealM && sourceHint && sourceHint !== targetLabel ? `copied from ${sourceHint}`
      : daysBack > 0 ? `from ${daysBack === 1 ? "yesterday" : `${daysBack} days ago`}`
      : mealWasToday ? "from earlier today" : "from yesterday";
    const remaining = (user.calorieTarget || 1800) - recomputed.calories;
    const protGap = (user.proteinTarget || 120) - recomputed.protein;
    // Echo parsed food names ("Apple, Pear"), never the client's raw sentence verbatim.
    const itemNames = Array.isArray(match.items) ? (match.items as Array<{ name?: string }>).map(i => i?.name).filter(Boolean).join(", ") : "";
    const rawLabel = itemNames ? `_${itemNames}_\n` : match.rawMessage ? `_${match.rawMessage.slice(0, 80)}_\n` : "";

    const sameReply = `✅ *${labelDisplay} logged* (${fromNote})\n${rawLabel}\n*+${match.kcalInt} kcal · +${match.proteinInt}g protein*\n${remaining > 0 ? `${remaining} kcal remaining.` : "Calorie target hit. ✅"} ${protGap > 0 ? `${protGap}g protein left.` : "Protein hit. ✅"}`;
    await logChat(user.id, message, sameReply, "SAME_AS_YESTERDAY");
    return sameReply;
  } catch (err) {
    console.error("[SAME_AS]", err);
    return `Could not find that meal. Tell me what you ate and I'll log it now.`;
  }
}

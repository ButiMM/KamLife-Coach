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
import { turnMutation } from "./chat-log";
import { users, mealLogs } from "../../shared/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import { sastDayStart, slotFromSastHour } from "../utils";
import { selectMealToCopy, parseMealRepeatTarget, type CopyableMeal } from "../meal-select";
import { recomputeTodayFoodTotals, invalidateFoodTotalsCache } from "./food-scanner";
import { logChat } from "./chat-log";
import { isAskingNotReporting } from "../utils";
import { dailyMacroCardMarker } from "../macro-card-attach";

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

  // Protest/meta-correction guard: "No no no dinner from yesterday!!!", "Omg what I
  // mean is I had the same meal as lunch…", "remove the meals you mistakenly logged"
  // are the client CORRECTING us — treating them as copy commands stacked three wrong
  // meals in production (2026-07-02). Fall through to mgmt/coach instead.
  const isProtest = /^(no+\b|no no|omg|wtf|eish|yoh|hau|haibo|what the|listen)/i.test(m.trim())
    || /\b(what i mean|i meant|you must remove|you should remove|mistakenly|by mistake|wrongly logged|do better|that.?s (wrong|not what)|didn.?t ask|stop logging)\b/i.test(m)
    // META-COMPLAINT about the conversation itself — "I already told you what's the plan
    // for lunch. Have you forgotten? We are repeating the same things" contains
    // 'repeating'+'lunch' and LOGGED YESTERDAY'S PASTA in reply to a complaint
    // (2026-07-10 voice note). Talking ABOUT repetition is never a request to repeat.
    || /\b(have you forgot(?:ten)?|i (?:already|just) told you|come on,? man|you and i|we (?:had|have) a discussion|we discussed|why (?:are|do|did) you|you keep|you'?re not listening|repeating the same)\b/i.test(m);

  // AND ASK THE OWNER (2026-07-30). Above this line sit two hand-written lists of ways to say
  // "don't repeat it" — built one live defect at a time — while isAskingNotReporting, which owns
  // "is this an ask, not a report?", was never called. So "Should my dinner be the same as my
  // lunch?" and "Can I have the same as yesterday's dinner?" both COPIED a meal into the log from
  // a question. That is the phantom-food class the food logger was inverted to kill in June.
  if (!sameAsMatch || wantsNotRepeat || isProtest || isAskingNotReporting(m)) return null;

  // Which meal is copied and where it goes (pure — unit-tested in script/unit-tests.ts).
  const { crossish, targetLabel, sourceHint } = parseMealRepeatTarget(m);

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
    if (crossish && daysBack === 0 && sourceHint) {
      const todaySub = todayMeals.filter(l => (l.kcalInt || 0) >= 100);
      // THE CLIENT KNOWS WHICH MEAL WAS LUNCH; THE CLOCK ONLY GUESSES (2026-07-29 live).
      // "My dinner is the same as my lunch" was answered "I don't have today's lunch logged" to
      // a man who had logged everything — because his meals went in after 17:00, so every one
      // was FILED as dinner. Nothing was labelled lunch, so the lookup found nothing and told
      // him he had not done the thing he had just done.
      //
      // So the label is only the first guess. Failing that, take the meal actually EATEN in that
      // slot's hours, and failing that, take its ordinal place in the day — breakfast is the
      // first meal, dinner the last, lunch the one in between. Their word for the meal outranks
      // our timestamp for it.
      const inSlotHours = todaySub.filter(l => l.loggedAt && slotFromSastHour(new Date(l.loggedAt)) === sourceHint);
      const byOrdinal = () => {
        const ordered = [...todaySub].sort((a, b) => new Date(a.loggedAt!).getTime() - new Date(b.loggedAt!).getTime());
        if (ordered.length < 2) return null;
        if (sourceHint === "breakfast") return ordered[0];
        if (sourceHint === "dinner") return ordered[ordered.length - 1];
        if (sourceHint === "lunch") return ordered[Math.floor((ordered.length - 1) / 2)];
        return null;
      };
      todayCrossMatch =
        todaySub.find(l => l.rawMessage && new RegExp(`\\b${sourceHint}\\b`, "i").test(l.rawMessage))
        || todaySub.find(l => (l.mealLabel || "").toLowerCase() === sourceHint)
        || inSlotHours[0]
        || (todaySub.length === 1 ? todaySub[0] : null)
        || byOrdinal();
      if (!todayCrossMatch) {
        const honestMiss = `I don't have today's ${sourceHint} logged, so I can't copy it. Tell me what it was — "rice, tin fish and veg" — and I'll log it as your ${targetLabel || "meal"} now.`;
        await logChat(user.id, message, honestMiss, "SAME_AS_TODAY_MISS");
        return honestMiss;
      }
    }

    const searchPool = (crossish && todayMeals.filter(l => (l.kcalInt || 0) >= 150).length > 0)
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
    // yesterday" or a webhook retry must not log the meal twice. SLOT-AWARE: kcal
    // alone blocked "same thing for dinner" one minute after lunch was logged (same
    // kcal, different slot), then told the client dinner was "already counted" while
    // it was never written (2026-07-05 audit). A dup = same kcal AND same slot.
    const dupWindow = new Date(Date.now() - 4 * 60_000);
    const newLabel = String(targetLabel || sourceHint || match.mealLabel || "").toLowerCase();
    const recentRows = await db.select({ kcalInt: mealLogs.kcalInt, mealLabel: mealLogs.mealLabel }).from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, dupWindow)));
    if (recentRows.some(r => (r.kcalInt || 0) === (match.kcalInt || 0) && String(r.mealLabel || "").toLowerCase() === newLabel)) {
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
    turnMutation("INSERT meal", "[WRITE]");
    invalidateFoodTotalsCache(user.id);
    const recomputed = await recomputeTodayFoodTotals(user.id);
    await db.update(users).set({
      todayCalories: recomputed.calories,
      todayProteinG: recomputed.protein,
    }).where(eq(users.phoneNumber, phone));

    const labelDisplay = (targetLabel || sourceHint || match.mealLabel || "Meal").replace(/\b\w/g, c => c.toUpperCase());
    const mealWasToday = match.loggedAt && new Date(match.loggedAt) >= todayStart;
    // Never say "copied from breakfast" ON a breakfast log — use a time reference instead.
    const fromNote = crossish && sourceHint && sourceHint !== targetLabel ? `copied from ${sourceHint}`
      : daysBack > 0 ? `from ${daysBack === 1 ? "yesterday" : `${daysBack} days ago`}`
      : mealWasToday ? "from earlier today" : "from yesterday";
    const remaining = (user.calorieTarget || 1800) - recomputed.calories;
    const protGap = (user.proteinTarget || 120) - recomputed.protein;
    // Echo parsed food names ("Apple, Pear"), never the client's raw sentence verbatim.
    const itemNames = Array.isArray(match.items) ? (match.items as Array<{ name?: string }>).map(i => i?.name).filter(Boolean).join(", ") : "";
    const rawLabel = itemNames ? `_${itemNames}_\n` : match.rawMessage ? `_${match.rawMessage.slice(0, 80)}_\n` : "";

    const card = await dailyMacroCardMarker(user); // scorecard on a repeat-log too (founder: every log gets the card)
    // What's LEFT is on the card when there is one; what was just LOGGED is not, so that stays.
    // Printing both is how one meal ended up describing the same day four times (2026-07-28).
    const leftLine = card ? "" : `\n${remaining > 0 ? `${remaining} kcal remaining.` : "Calorie target hit. ✅"} ${protGap > 0 ? `${protGap}g protein left.` : "Protein hit. ✅"}`;
    const sameReply = `✅ *${labelDisplay} logged* (${fromNote})\n${rawLabel}\n*+${match.kcalInt} kcal · +${match.proteinInt}g protein*${leftLine}`;
    await logChat(user.id, message, sameReply, "SAME_AS_YESTERDAY");
    return `${sameReply}${card}`;
  } catch (err) {
    console.error("[SAME_AS]", err);
    return `Could not find that meal. Tell me what you ate and I'll log it now.`;
  }
}

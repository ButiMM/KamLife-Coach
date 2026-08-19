/**
 * NUTRITION GUARDRAILS — the "too much of something" brain (2026-07-22, founder: "a person logs
 * three energy drinks and the bot says 'that's good' — it's NOT good. Lead them to the right path,
 * per health standards, without shaming.").
 *
 * The calorie/macro engine is blind to things calories don't capture: caffeine, added sugar,
 * alcohol, fried/takeaway repetition, processed meat, or drinking energy drinks INSTEAD of eating.
 * A sugar-free Monster is "0 kcal" — the old reply calls that a win while the client has had three
 * of them and no food. This module watches the DAY (not one meal) and, when a real health-standard
 * line is crossed, adds ONE short, educational, non-shaming nudge toward the better choice.
 *
 * Grounded in published guidance (cited inline): EFSA/WHO caffeine ~400mg/day for adults, WHO free
 * sugars <~25–50g/day, WHO/IARC processed-meat caution, standard alcohol moderation. Pure + tested;
 * the DB read that feeds it lives in nutritionGuardrailNudge at the bottom.
 */

import { db } from "./db";
import { mealLogs } from "../shared/schema";
import { eq, and, gte } from "drizzle-orm";
import { sastDayStart } from "./utils";
import { getGoalProfile } from "./goal-profiles";

// ── Category detectors (matched against each of today's logged food strings) ──
// Energy drinks only — NOT "Switch Cranberry" juice or a plain soda (those are handled below).
const ENERGY_DRINK_RE = /\b(monster|red\s?bull|redbull|score energy|dragon energy|play energy|switch energy|reboot energy|rockstar|energy drink|energy drinks)\b/i;
const COFFEE_RE = /\b(coffee|espresso|americano|double shot|flat white)\b/i;
// Full-sugar sodas/cordials — the zero/diet versions are excluded so they never trip the sugar nudge.
const SUGARY_FULL_RE = /\b(coke|cola|coca[\s-]?cola|pepsi|sprite|fanta|stoney|sparletta|sparberry|creme? soda|cream soda|powerade|energade|lucozade|iron\s?brew|soft drink|fizzy drink|soda|cooldrink|cool drink|juice|squash|oros)\b/i;
const NO_SUGAR_RE = /\b(zero|diet|sugar[\s-]?free|no[\s-]?sugar|light|lite)\b/i;
const FRIED_TAKEAWAY_RE = /\b(burgers?|cheeseburgers?|kfc|mcdonald|macdonald|nando|steers|hungry lion|chicken licken|debonairs|fried chicken|deep[\s-]?fried|slap chips|hot chips|fries|russians?|vetkoek|fat ?cakes?|magwinya|kotas?|bunny chow|gatsby|fried|takeaways?|take[\s-]?out|pizzas?|deep fry)\b/i;
const ALCOHOL_RE = /\b(beers?|wines?|brandy|whisk(?:e)?y|vodka|gin|rum|tequila|ciders?|savanna|hunters?|castle|black label|heineken|amstel|corona|shots?|cocktails?|champagne|spirits?|liquor|hennessy|klipdrift|smirnoff)\b/i;
const PROCESSED_MEAT_RE = /\b(polony|vienna|viennas|russian sausage|bacon|salami|\bham\b|processed meat|hot ?dog|cold meat|nugget|nuggets)\b/i;
// Sweets / chocolate / crisps — the "one now and then is fine, six is a pattern" case. Whole fruit
// is NOT here (it's real food); this is confectionery and packet snacks only.
const SWEETS_RE = /\b(chocolate|choc\b|slab|bar[\s-]?one|kit[\s-]?kat|lunch bar|tex\b|aero|smarties|sweets|candy|cake|cupcake|biscuit|cookie|doughnut|donut|ice[\s-]?cream|lollipop|gummy|jelly babies|marshmallow|crisps|simba|lays|doritos|nik naks|chips packet|chocolate bar|milkshake|donuts)\b/i;
// A "real meal" has actual food in it — used to catch drinks-instead-of-food.
const MEAL_WORD_RE = /\b(chicken|beef|mince|fish|pilchard|egg|eggs|pap|rice|bread|samp|maize|meat|veg|vegetable|salad|potato|sweet potato|oats|beans|lentil|wrap|sandwich|burger|chips|stew|curry|pasta|noodle|morogo|spinach|butternut|wors|steak|tuna|yoghurt|fruit|apple|banana|avo|avocado|nuts|peanut)\b/i;

const has = (s: string, re: RegExp) => re.test(s || "");

export interface NutritionDayInput {
  /** Each of today's logged food strings (raw message + item names), most-recent last. */
  todayFoods: string[];
  goalType?: string | null;
}

/**
 * PURE. Look at the whole day and return ONE educational nudge when a health-standard line is
 * crossed — or null. "Crossing" semantics (count === threshold) so it fires ONCE, on the log that
 * tips it, never nagging every subsequent log. Priority runs most-health-critical first.
 */
function collapseFoodKey(s: string): string {
  const t = (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!t) return "";
  // Repeat logs of the same chain (retries / re-sends) are ONE meal, not a pattern.
  if (/\b(mcdonald|macdonald|maccas)\b/.test(t)) return "place:mcdonald";
  if (/\bkfc\b/.test(t)) return "place:kfc";
  if (/\bnando/.test(t)) return "place:nando";
  if (/\bsteers\b/.test(t)) return "place:steers";
  if (/\bwimpy\b/.test(t)) return "place:wimpy";
  return t.slice(0, 96);
}

export function assessNutritionStandards(input: NutritionDayInput): string | null {
  const raw = (input.todayFoods || []).map(f => f || "");
  const seen = new Set<string>();
  const foods: string[] = [];
  for (const f of raw) {
    const k = collapseFoodKey(f);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    foods.push(f);
  }
  const count = (re: RegExp) => foods.filter(f => has(f, re)).length;
  // CAFFEINE IS COUNTED RAW, NOT DEDUPED. The dedup above exists so a re-logged takeaway does not
  // stack macros twice, and it is right for that. But it collapses two Monster Zeros into one, so
  // the "two energy drinks and no food" rule — the founder's exact case, the reason this file
  // exists — could never fire for two of the SAME drink. How many you had is the whole question.
  const countRaw = (re: RegExp) => raw.filter(f => has(f, re)).length;
  const energy = countRaw(ENERGY_DRINK_RE);
  const coffee = countRaw(COFFEE_RE);
  const caffeine = energy + coffee;
  const sugary = foods.filter(f => has(f, SUGARY_FULL_RE) && !has(f, NO_SUGAR_RE)).length;
  const fried = count(FRIED_TAKEAWAY_RE);
  const alcohol = count(ALCOHOL_RE);
  const procMeat = count(PROCESSED_MEAT_RE);
  const sweets = count(SWEETS_RE);
  const realMeals = foods.filter(f => has(f, MEAL_WORD_RE)).length;
  const isCut = getGoalProfile(input.goalType).energyStance === "deficit";

  // 1. Energy drinks INSTEAD of food — the founder's exact case. Fuel first, kindly.
  if (energy === 2 && realMeals === 0) {
    return "_That's caffeine, not fuel — and on an empty stomach it hits your energy harder later. Your body's asking for a real meal, not a boost. Grab some protein first, then swap the next one for water. 💧_";
  }
  // 2. Caffeine over the daily line. EFSA/WHO: ~400mg/day for adults (~4 coffees or ~3 energy
  //    drinks). Above it, sleep, heart rate and anxiety pay for it — flag it plainly, no shame.
  if (caffeine === 3 && energy >= 2) {
    return "_That's about 3 caffeine hits today — right around the healthy daily limit (roughly 400mg). More than this and your sleep and heart rate feel it. Water or rooibos from here, and you're sorted. 💧_";
  }
  // 3. Alcohol on a fat-loss goal — it doesn't ruin a day, but it pauses fat-burning. Honest, warm.
  if (alcohol === 1 && isCut) {
    return "_No judgment on the drink — just so you know, while there's alcohol in the system your body pauses fat-burning to deal with it first. Have water alongside and you're back on track tomorrow._";
  }
  if (alcohol === 3) {
    return "_A few drinks in — line each one with a glass of water and eat something proper. Future-you will thank you in the morning. 💧_";
  }
  // 4. Added sugar from drinks. WHO: free sugars ideally under ~25g/day — one regular soft drink is
  //    already there. Two is worth a gentle nudge to the zero version (same taste, none of the sugar).
  if (sugary === 2) {
    return "_Two sugary drinks today — that's most of a day's sugar in liquid alone, and it doesn't fill you up. The zero/sugar-free version tastes the same with none of it. Small swap, big win._";
  }
  // 5. Fried / takeaway repeating. No shame — but three in a day isn't a plate, it's a pattern.
  if (fried === 3) {
    return "_A few takeaways in the log today — it's counted, no drama. Next plate: protein, veg, a carb. That's enough._";
  }
  if (fried === 2 && isCut) {
    return "_Second takeaway today — easily done, no drama. For your goal, make the next meal a simple home plate (grilled protein + veg) and the day balances out nicely._";
  }
  // 6. Processed meat repeating. WHO/IARC flags daily processed meat — keep it gentle and cultural.
  if (procMeat === 3) {
    return "_Lots of processed meat today (polony, viennas, that kind) — fine now and then, but they're high in salt and preservatives. Fresh chicken, eggs, fish or beans give you more protein for less of the bad stuff._";
  }
  // 7. Sweets / chocolate / crisps stacking up. WHO free sugars — one treat is fine, a handful
  //    across the day is where it adds up. Founder: "two instead of six, one chocolate now and then."
  if (sweets === 3) {
    return "_A few sweet treats today — and honestly, one now and then is completely fine, that's balance. It's when they stack up that the sugar quietly adds up. Enjoy the one, skip the next, and you're golden._";
  }
  return null;
}

/** Concatenate a meal-log row's item names into a searchable blob. */
function itemNames(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return items.map((i: any) => (i && typeof i.name === "string" ? i.name : "")).join(" ");
}

/**
 * DB-backed wrapper: read today's logs for this client and return the standards nudge as a ready-
 * to-append suffix ("\n\n_…_"), or "" when nothing crosses a line. Fail-open — a guardrail read
 * must never block or break the food-log reply it rides on.
 */
export async function nutritionGuardrailNudge(user: any): Promise<string> {
  try {
    const rows = await db
      .select({ raw: mealLogs.rawMessage, items: mealLogs.items })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, sastDayStart())));
    const todayFoods = rows.map(r => `${r.raw || ""} ${itemNames(r.items)}`.trim());
    const nudge = assessNutritionStandards({ todayFoods, goalType: user?.goalType });
    return nudge ? `\n\n${nudge}` : "";
  } catch (e) {
    console.warn("[NUTRITION_GUARDRAIL] skipped:", (e as any)?.message || e);
    return "";
  }
}

import { SA_FOODS_SEED, type SAFood } from "../foods";
import { sastDayKey, sastDayKeyBefore, sastHour } from "../sast";
import { neverSilentLine } from "../reply-hygiene";
import { carriesFeelingClause } from "../unlogged-notice";
import { claimOncePerDay } from "../once-daily";
import { swapNudge } from "../food-swaps";
import { enforceCoachGuardrails } from "../coach-guardrails";
import { educationNote, remainingInMeals, weeklyNetWording, dinnerIsLogged, dinnerCloseLine } from "../education";
import { getNumbersMode, stripFoodLineNumbers, plainProteinNudge } from "../numbers-mode";
import { stepBurnKcal } from "../targets";
import { humanizeReply } from "../reply-hygiene";
import { displayFoodName } from "../food-naming";
import { guardMalformed, safeFallback, recordGuardResult } from "../malformed-guard";
import { levenshtein, maxDistance, FUZZY_BLACKLIST } from "../food-fuzzy";
import { usesMacroTargets } from "../goal-profiles";
import { db } from "../db";
import { mealLogs, chatHistory, users } from "../../shared/schema";
import { eq, and, gte, sql, desc, inArray } from "drizzle-orm";
import { sastDayStart, sastToday } from "../utils";
import { turnMutation } from "./chat-log";

// ── Per-user in-memory cache for recomputeTodayFoodTotals ──────────────────
// Prevents redundant DB queries when the same totals are read multiple times
// within a single request pipeline (food-context, gpt-block, media, routes).
const FOOD_TOTALS_CACHE_TTL_MS = 30_000; // 30 seconds
interface FoodTotalsEntry {
  calories: number;
  protein: number;
  cachedAt: number;
}
const _foodTotalsCache = new Map<string, FoodTotalsEntry>();

/** Invalidate cached totals for a user after any food log INSERT or DELETE. */
export function invalidateFoodTotalsCache(userId: string): void {
  _foodTotalsCache.delete(userId);
  // Portion memory learns from the same rows — refresh it on the same events so a
  // correction teaches the very next log (fire-and-forget; import stays lazy).
  import("../portion-memory").then(m => m.invalidatePortionMemory(userId)).catch(() => {});
}

// Periodic cleanup to avoid stale entries accumulating in long-running process
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _foodTotalsCache) {
    if (now - entry.cachedAt > FOOD_TOTALS_CACHE_TTL_MS) _foodTotalsCache.delete(key);
  }
}, 60_000).unref();

// Track streak celebration shown today — prevents it firing on every meal log
const _streakShownToday = new Map<string, string>();


export function hasShownStreakToday(userId: string): boolean {
  return _streakShownToday.get(userId) === sastDayKey();
}

export function markStreakShownToday(userId: string): void {
  _streakShownToday.set(userId, sastDayKey());
}

export async function computeFoodLogStreak(userId: string): Promise<number> {
  try {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
    const logs = await db.select({ createdAt: chatHistory.createdAt })
      .from(chatHistory)
      .where(and(eq(chatHistory.userId, userId), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, sixtyDaysAgo)))
      .orderBy(desc(chatHistory.createdAt));
    if (logs.length === 0) return 0;
    const days = new Set<string>();
    for (const l of logs) {
      if (l.createdAt) days.add(sastDayKey(new Date(l.createdAt)));
    }
    // Walk backwards a day at a time from today. sastDayKeyBefore steps through real day starts,
    // so a streak spanning the end of a month or a year cannot break on the boundary.
    let streak = 0;
    while (days.has(sastDayKeyBefore(streak))) streak++;
    return streak;
  } catch { return 0; }
}

const FOOD_STREAK_MESSAGES: Record<number, (name: string) => string> = {
  3:  (n) => `\n\n🔥 *${n}, 3 days logging straight.* The data is building. This is what coaching from facts looks like — keep it going.`,
  5:  (n) => `\n\n🔥 *${n}, 5 days in a row.* Most people stop at day 2. You're past the quitting point. Don't break the chain.`,
  7:  (n) => `\n\n🔥 *${n}, 7 days of food logs.* A full week. You now have real data — patterns I can actually coach from. Screenshot this and keep going.`,
  10: (n) => `\n\n🔥 *${n}, 10 days straight.* Double figures. The habit is forming — your brain is starting to do this automatically. That's exactly where you want to be.`,
  14: (n) => `\n\n🔥 *${n}, 14 days.* Two weeks of consistent logging. The clients who get results are the clients who do this. You are one of them.`,
  21: (n) => `\n\n🔥 *${n}, 21 days logging.* Three weeks. This is a habit now — not discipline, not willpower. Habit. The data you've built is yours forever.`,
  30: (n) => `\n\n🏆 *${n}, 30 days.* A full month of food logs. Thirty days of showing up, including the days you did not feel like it. That is the whole game.`,
};

export function getFoodStreakCelebration(streak: number, name: string): string {
  const fn = name.split(" ")[0] || "there";
  return FOOD_STREAK_MESSAGES[streak]?.(fn) ?? "";
}

/**
 * The one-line version, for when the ACHIEVEMENT CARD is carrying the milestone.
 *
 * (2026-07-28 live: the full 30-day paragraph landed directly above a 30-day card saying the
 * same thing in the same words.) The picture is what they keep and what they forward, so the
 * text stops competing with it and just points at it.
 */
export function shortStreakNote(streak: number, name: string): string {
  if (!FOOD_STREAK_MESSAGES[streak]) return "";
  const fn = name.split(" ")[0] || "";
  return `\n\n${fn ? fn + ", t" : "T"}hat's *${streak} days straight* 👇`;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The serving COUNT implied by a portion description's leading number — used as
 * the divisor when a client states their own count ("3 eggs" → 3/2 portions).
 * Returns 1 when the leading number is a weight/volume, NOT a count: "150g
 * portion" must be 1, otherwise "2 chicken livers" divides by 150 and logs ~3
 * kcal instead of two real portions. Pure — unit-tested in food-scanner-tests.
 */
export function portionDefaultCount(desc: string): number {
  if (!desc) return 1;
  if (/^\d+(?:\.\d+)?\s*(?:g|kg|ml|l|oz)\b/i.test(desc)) return 1;
  const m = desc.match(/^(\d+(?:\.\d+)?)/);
  const n = m ? parseFloat(m[1]) : 1;
  return n > 0 ? n : 1;
}


// Sugary sodas / energy drinks that have a true zero-calorie version. Matched against
// a food entry's name + aliases, scoped to drink categories only, so real meals are never
// touched. Mocha/latte etc. are NOT here — a "sugar free" milk coffee still has calories.
const SUGARY_DRINK_RE = /\b(coke|cola|coca[\s-]?cola|pepsi|sprite|fanta|stoney|sparletta|sparberry|cream(?:e)? soda|powerade|energade|lucozade|monster|red\s?bull|redbull|score energy|dragon energy|play energy|switch energy|reboot|energy drink|cool[\s-]?drink|cooldrink|fizzy|soft drink|soda)\b/i;

// Detect an explicit sugar-free intent in the raw message.
function hasSugarFreeIntent(lower: string): boolean {
  if (/\b(zero[\s-]?sugar|sugar[\s-]?free|sugarfree|no[\s-]?sugar|no[\s-]?cal|zero[\s-]?cal)\b/i.test(lower)) return true;
  // "<drink> zero" or "zero <drink>" — e.g. "red bull zero", "zero coke"
  const drinkWords = "coke|cola|pepsi|sprite|fanta|stoney|sparletta|powerade|energade|lucozade|monster|red\\s?bull|redbull|energy|cool\\s?drink|cooldrink|soda";
  if (new RegExp(`\\b(?:${drinkWords})\\b[\\w\\s]{0,12}\\bzero\\b`, "i").test(lower)) return true;
  if (new RegExp(`\\bzero\\b[\\w\\s]{0,12}\\b(?:${drinkWords})\\b`, "i").test(lower)) return true;
  // "diet" must be adjacent to a drink word ("diet coke") — a bare "diet" anywhere in the
  // message ("my diet has been bad, had a monster energy") must not zero out a real drink.
  if (new RegExp(`\\bdiet\\b[\\w\\s]{0,12}\\b(?:${drinkWords})\\b`, "i").test(lower)) return true;
  if (new RegExp(`\\b(?:${drinkWords})\\b[\\w\\s]{0,12}\\bdiet\\b`, "i").test(lower)) return true;
  return false;
}

// When the client logs a zero/sugar-free/diet drink, redirect any matched sugary soda or
// energy drink to the canonical zero-calorie entry. Stops "sugar free energy drink" being
// logged as a 113 kcal Red Bull — and stops the coach lecturing about "sugar" on a 0-cal drink.
function redirectSugarFreeDrinks(foods: SAFood[], lower: string): SAFood[] {
  if (!hasSugarFreeIntent(lower)) return foods;
  const zeroEntry = SA_FOODS_SEED.find(f => f.name === "Diet Coke / Coke Zero");
  if (!zeroEntry) return foods;
  let changed = false;
  const out: SAFood[] = [];
  for (const f of foods) {
    const isSugaryDrink = (f.typicalPortionCalories || 0) > 5
      && (f.category === "drink" || f.category === "junk" || f.category === "beverage")
      && SUGARY_DRINK_RE.test([f.name, ...f.aliases].join(" "));
    if (isSugaryDrink) {
      changed = true;
      // Keep the client's actual drink name — "Monster Zero" must never be logged
      // as "Diet Coke". Same zero macros, their drink's identity.
      const zeroName = `${f.name.replace(/\s+drink$/i, "")} Zero (sugar-free)`;
      if (!out.some(o => o.name === zeroName)) out.push({ ...zeroEntry, name: zeroName });
    } else {
      out.push(f);
    }
  }
  if (!changed) return foods;
  // When a specific drink was renamed ("Monster Energy Zero"), drop the generic
  // "Diet Coke / Coke Zero" entry that also matched via a bare "zero sugar" alias —
  // otherwise the reply names the wrong drink (caught by routing-audit).
  const hasSpecificZero = out.some(o => o.name.endsWith("Zero (sugar-free)"));
  return hasSpecificZero ? out.filter(o => o.name !== zeroEntry.name) : out;
}

// Processed-meat / dish nouns that take a meat word as an ADJECTIVE. The trailing
// noun is its own food (Viennas, Polony…) whose alias does NOT contain the meat word,
// so the substring dedup can't see the collision.
const MEAT_MODIFIER_NOUNS = "viennas?|russians?|polony|polonny|poloni|sausages?|nuggets?|burgers?|patty|patties|schnitzels?|kievs?|strips?|fingers?|mayo|pies?|wraps?|bacon|ham|wors";
// Meat words carrying a BARE single-word alias on a standalone cut entry, mapped to that cut.
const GENERIC_MEAT_CUTS: Record<string, string[]> = {
  chicken: ["Chicken thigh"],
};

// Drop a phantom meat CUT that's actually qualifying a different processed food: "2 chicken
// viennas" matches "chicken" → Chicken thigh AND "viennas" → Viennas, and the thigh is protein
// nobody ate (the "2" then doubles it). Only dropped when EVERY occurrence of the meat word
// sits immediately before such a noun — "chicken and rice" keeps its chicken.
function dropModifierMeats(foods: SAFood[], lower: string): SAFood[] {
  let out = foods;
  for (const [meat, cutNames] of Object.entries(GENERIC_MEAT_CUTS)) {
    if (!out.some(f => cutNames.includes(f.name))) continue;
    const asModifier = new RegExp(`\\b${meat}\\s+(?:${MEAT_MODIFIER_NOUNS})\\b`, "i").test(lower);
    if (!asModifier) continue;
    // Standalone = the meat word appears NOT immediately followed by a modifier noun
    // ("chicken and rice", or "chicken thigh" where "thigh" isn't a modifier noun).
    const standalone = new RegExp(`\\b${meat}\\b(?!\\s+(?:${MEAT_MODIFIER_NOUNS}))`, "i").test(lower);
    if (standalone) continue;
    out = out.filter(f => !cutNames.includes(f.name));
  }
  return out;
}

// Combo meal → standalone components it bundles. Module-scoped so it's available to
// BOTH the substring dedup (a combo's long alias must not suppress a standalone
// component) AND the combo dedup in finalizeMatches.
const COMBO_OVERRIDES: Record<string, string[]> = {
  "Pasta bolognaise": ["Pasta (spaghetti)", "Beef mince"],
  "Chicken stir-fry with rice": ["Chicken breast", "Chicken thigh", "Brown rice", "White rice"],
  "Chicken and rice": ["Chicken breast", "Chicken thigh", "Brown rice", "White rice"],
  "Eggs on toast": ["Eggs", "Brown bread", "White bread", "Toast"],
  "Pap and stew": ["Pap (stiff maize porridge)", "Stewing beef", "Beef stew"],
  "Pap and wors": ["Pap (stiff maize porridge)", "Boerewors"],
  "Chicken curry and rice": ["Chicken thigh", "Chicken breast", "Curry (chicken)", "Brown rice", "White rice"],
  "Mince and pap": ["Beef mince", "Pap (stiff maize porridge)"],
  "Boerewors roll": ["Boerewors", "Brown bread", "White bread"],
  "Peanut butter on bread": ["Peanut butter", "Peanut butter (smooth)", "Brown bread", "White bread"],
  "Chicken and pap": ["Chicken breast", "Chicken thigh", "Pap (stiff maize porridge)"],
  "Fish and chips": ["Hake (frozen, battered)", "Chips (slap chips)"],
  "Pap and pilchards": ["Pap (stiff maize porridge)", "Pilchards in tomato sauce"],
  "Pap and spinach": ["Pap (stiff maize porridge)", "Spinach", "Morogo (wild spinach)"],
  "Pilchards on toast": ["Pilchards in tomato sauce", "Brown bread", "White bread", "Toast"],
  "Rice and beans": ["Brown rice", "White rice", "Sugar beans"],
  "Oats with milk": ["Oats (Jungle Oats)", "Full cream milk"],
  "Vetkoek with mince": ["Vetkoek", "Beef mince"],
  "Cereal with milk": ["Corn Flakes", "Full cream milk"],
};

const COMBO_NAMES = new Set(Object.keys(COMBO_OVERRIDES));

/**
 * Un-invent variant qualifiers the client never said. Runs LAST, after combo dedup, because
 * that logic matches on the real entry names — renaming before it made the scanner
 * double-count curry and toast combos (caught by gap-tests, 2026-07-27).
 */
function applyClientNaming(foods: SAFood[], aliases: Map<string, string>): SAFood[] {
  return foods.map(f => {
    const said = aliases.get(f.name);
    if (!said) return f;
    const shown = displayFoodName(said, f.name);
    return shown === f.name ? f : { ...f, name: shown };
  });
}

// Final cleanup applied to EVERY scanner return path (it once ran only after fuzzy
// matching, so "i had lentils, rice and chicken breast" logged "Chicken breast" AND a
// phantom "Chicken and rice", double-counting the chicken). Combo dedup: 2+ components
// matched separately → the client listed them individually, drop the phantom combo; ≤1
// matched → the client named the dish, keep the combo and drop the stray component.
function finalizeMatches(matched: SAFood[], lower: string): SAFood[] {
  let cleaned = [...matched];

  // PASS 3: Combo meal dedup
  const comboNames = cleaned.filter(f => COMBO_OVERRIDES[f.name]).map(f => f.name);
  if (comboNames.length > 0) {
    const STOP = new Set(["and", "with", "the", "for", "on", "of", "in", "a"]);
    const dropCombos = new Set<string>();
    const dropComponents = new Set<string>();
    for (const cn of comboNames) {
      const components = COMBO_OVERRIDES[cn];
      const presentComponents = cleaned.filter(f => f.name !== cn && components.includes(f.name));
      // A component is "genuinely listed" (not just inferred from the combo's own words)
      // when its name carries a distinguishing word — one that is NOT part of the combo's
      // name — that actually appears in the client's text. "Chicken breast" beside the
      // combo "Chicken and rice" qualifies via "breast"; "Brown rice"/"Chicken thigh"
      // inferred from the bare phrase "chicken and rice" do not (no "brown"/"thigh" typed).
      const comboWords = new Set(cn.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean));
      const genuine = presentComponents.filter(c => {
        const distinguishing = c.name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
          .filter(w => w.length >= 3 && !STOP.has(w) && !comboWords.has(w));
        return distinguishing.some(w => new RegExp(`\\b${escapeRegex(w)}\\b`, "i").test(lower));
      });
      if (genuine.length >= 1) {
        dropCombos.add(cn); // client named a part explicitly — the combo is the phantom
      } else {
        for (const c of components) dropComponents.add(c); // dish named — drop stray parts
      }
    }
    cleaned = cleaned.filter(f => !dropCombos.has(f.name) && !dropComponents.has(f.name));
  }

  // PASS 4: Alias collision cleanup

  // A generic chicken CUT (thigh/breast) that lit up only from the bare word "chicken"
  // is a phantom when a more SPECIFIC chicken dish also matched via a non-"chicken"
  // alias — e.g. "Nando's quarter chicken" (matched on "nandos quarter") double-counted
  // a "Chicken thigh" off the word "chicken" in the same phrase (2026-07-12 probe). The
  // substring-dedup in scanForSAFoods can't catch it because the specific dish's matched
  // alias doesn't contain "chicken". Drop the generic cut unless the client actually
  // named a cut ("thigh", "breast", "fillet", "drumstick", "wing", "piece").
  const GENERIC_CHICKEN = ["Chicken thigh", "Chicken breast"];
  const typedCutWord = /\b(thighs?|breasts?|fillets?|drumsticks?|wings?|pieces?)\b/i.test(lower);
  if (!typedCutWord) {
    const hasSpecificChickenDish = cleaned.some(f => !GENERIC_CHICKEN.includes(f.name) && /chicken/i.test(f.name));
    if (hasSpecificChickenDish) {
      cleaned = cleaned.filter(f => !GENERIC_CHICKEN.includes(f.name));
    }
  }

  // A generic "Sandwich" (bare bread) is redundant when a SPECIFIC sandwich/spread combo
  // also matched — "peanut butter sandwich" lit up both "Peanut butter on bread" AND the
  // bare "Sandwich", double-counting the bread (2026-07-12 probe). Drop the generic only
  // when a specific one exists; "cheese and tomato sandwich" (bread + fillings, no specific
  // sandwich food) keeps its "Sandwich" so the bread is still counted.
  if (cleaned.some(f => f.name === "Sandwich")) {
    const hasSpecificSandwich = cleaned.some(f =>
      f.name !== "Sandwich" && (/sandwich/i.test(f.name) || f.name === "Peanut butter on bread"));
    if (hasSpecificSandwich) cleaned = cleaned.filter(f => f.name !== "Sandwich");
  }

  const names = new Set(cleaned.map(f => f.name));
  if (names.has("Peanut butter") && names.has("Peanut butter (smooth)")) {
    cleaned = cleaned.filter(f => f.name !== "Peanut butter (smooth)");
  }
  if (names.has("Eggs") && names.has("Whole egg (boiled)")) {
    cleaned = cleaned.filter(f => f.name !== "Whole egg (boiled)");
  }
  if (names.has("Chicken breast") && names.has("Chicken thigh")) {
    const prefersBreast = /\b(breast|fillet|fillet[s]?)\b/i.test(lower);
    cleaned = cleaned.filter(f => f.name !== (prefersBreast ? "Chicken thigh" : "Chicken breast"));
  }

  return redirectSugarFreeDrinks(dropModifierMeats(cleaned, lower), lower);
}

export function scanForSAFoods(msg: string, opts?: { exactOnly?: boolean }): SAFood[] {
  const lower = msg.toLowerCase();
  const matched: SAFood[] = [];
  // Entry name -> the client's own words that matched it, used to un-invent variant
  // qualifiers once dedup is done (see applyClientNaming).
  const matchedAlias = new Map<string, string>();

  // PASS 1: Exact word-boundary matching (fast, preferred)
  const matchedWithAlias: { food: SAFood; alias: string }[] = [];
  for (const food of SA_FOODS_SEED) {
    const allAliases = [food.name.toLowerCase(), ...food.aliases.map(a => a.toLowerCase())];
    let longestHit = "";
    for (const alias of allAliases) {
      // PLURAL-TOLERANT ("burgers") and PREFIX-TOLERANT: Nguni/Sotho fuse the linking
      // particle onto the noun, so "inkukhu NEPAPA" (chicken AND PAP) used to drop the pap.
      // The leading \b anchors it — an English word can't split into prefix + alias.
      const re = new RegExp(`\\b(?:na|ne|no|nga|nge|ka|le|ku|se|di|ma)?${escapeRegex(alias)}(?:es|s)?\\b`, "i");
      if (re.test(lower) && alias.length > longestHit.length) {
        longestHit = alias;
      }
    }
    if (longestHit && !matchedWithAlias.find(m => m.food.name === food.name)) {
      matchedWithAlias.push({ food, alias: longestHit });
    }
  }

  // DEDUP PASS 1: keep only first match per alias string
  const seenAliases = new Set<string>();
  const deduped: { food: SAFood; alias: string }[] = [];
  for (const entry of matchedWithAlias) {
    if (!seenAliases.has(entry.alias)) {
      seenAliases.add(entry.alias);
      deduped.push(entry);
    }
  }

  // DEDUP PASS 2: drop shorter alias if it appears inside a longer matched alias
  // No category restriction — "butter" inside "peanut butter" is dominated regardless of category.
  // EXCEPTION: a combo meal ("Chicken and rice", alias "rice and chicken") must NOT suppress a
  // standalone component ("rice" → Brown rice). They are different dishes, not alias variants of
  // one food — the combo↔component relationship is resolved later by finalizeMatches, which needs
  // the standalone component to survive in order to detect a phantom combo from word adjacency.
  for (const entry of deduped) {
    const dominated = deduped.some(other =>
      other.food.name !== entry.food.name &&
      other.alias.length > entry.alias.length &&
      other.alias.includes(entry.alias) &&
      !COMBO_NAMES.has(other.food.name)
    );
    if (!dominated) {
      // The generic zero-drink entry aliases every brand's zero variant
      // ("monster zero", "powerade zero", "stoney zero"...). Logging those as
      // "Diet Coke / Coke Zero" renames the client's drink — keep their brand.
      if (entry.food.name === "Diet Coke / Coke Zero" && !/\b(coke|pepsi|tab|cola)\b/i.test(entry.alias)) {
        const brandName = entry.alias.replace(/\b\w/g, c => c.toUpperCase());
        matched.push({ ...entry.food, name: brandName });
      } else {
        // GENERALISED (2026-07-27): that rule was built for drinks only, so "Rice" came back
        // "Brown rice" and "Tin fish" came back "Pilchards in tomato sauce". The rename is
        // applied AFTER dedup (combo logic matches on the real entry names), so just record
        // which of the client's words won this entry.
        matchedAlias.set(entry.food.name, entry.alias);
        matched.push(entry.food);
      }
    }
  }

  // PASS 2: Fuzzy matching (only if exact found nothing)
  // exactOnly: callers gating AUTO-logging (no eating verb present) must not act on
  // fuzzy guesses — fuzzy matched "building phase" to mopani worms and logged a fake
  // meal over a goal-change request (caught by routing-audit).
  if (matched.length > 0 || opts?.exactOnly) return applyClientNaming(finalizeMatches(matched, lower), matchedAlias);

  const words = lower.replace(/[^a-z\s]/g, "").split(/\s+/).filter(w => w.length >= 4 && !FUZZY_BLACKLIST.has(w));
  const combos: string[] = [...words];
  const rawWords = lower.replace(/[^a-z\s]/g, "").split(/\s+/).filter(w => w.length >= 2);
  for (let i = 0; i < rawWords.length - 1; i++) {
    combos.push(rawWords[i] + " " + rawWords[i + 1]);
  }

  for (const food of SA_FOODS_SEED) {
    if (matched.find(f => f.name === food.name)) continue;
    const allAliases = [food.name.toLowerCase(), ...food.aliases.map(a => a.toLowerCase())];

    let bestScore = Infinity;
    for (const combo of combos) {
      for (const alias of allAliases) {
        const aliasWordCount = alias.split(/\s+/).length;
        const comboWordCount = combo.split(/\s+/).length;
        if (aliasWordCount !== comboWordCount) continue;
        const lenRatio = Math.min(combo.length, alias.length) / Math.max(combo.length, alias.length);
        if (lenRatio < 0.8) continue;
        const dist = levenshtein(combo, alias);
        const allowed = maxDistance(Math.min(combo.length, alias.length)); // budget on the TYPED word: alias.length let "finish" match "tinfish" (2026-07-29)
        if (dist <= allowed && dist < bestScore) {
          bestScore = dist;
        }
      }
    }
    if (bestScore < Infinity && !matched.find(f => f.name === food.name)) {
      matched.push(food);
    }
  }

  return applyClientNaming(finalizeMatches(matched, lower), matchedAlias);
}

export function parseFoodLogTotalsFromMessageOut(messageOut: string): { calories: number; protein: number } | null {
  if (!messageOut) return null;
  const totalLine = messageOut.match(/\*(?:Meal|Day) total:\s*~?(\d+)\s*kcal\s*\|\s*~?(\d+)g\s*protein\*/i);
  if (totalLine) {
    return { calories: parseInt(totalLine[1], 10), protein: parseInt(totalLine[2], 10) };
  }
  return null;
}

/** Reflow a 3+ item bullet/numbered dump into flowing coach prose (WhatsApp, not an app UI). */
export function collapseBulletDump(text: string): string {
  const lines = text.split("\n");
  const bulletCount = lines.filter((l) => /^\s*([-•*–]|\d+[.)])\s+\S/.test(l)).length;
  if (bulletCount < 3) return text; // a short list is fine — only collapse a real dump
  const out: string[] = [];
  for (const line of lines) {
    const b = line.match(/^\s*(?:[-•*–]|\d+[.)])\s+(.*)$/);
    if (b) {
      // "*Start Slow*: begin easy" → "Start slow — begin easy"
      let seg = b[1].replace(/^\*([^*]+)\*\s*:?\s*/, "$1 — ").replace(/\*/g, "").trim();
      if (seg) out.push(/[.!?…]$/.test(seg) ? seg : seg + ".");
    } else if (line.trim()) {
      out.push(line.trim());
    }
  }
  return out.join(" ").replace(/\s{2,}/g, " ").trim();
}

export function sanitizeCoachReply(reply: string, userMessage: string, budgetTier?: string | null, injuries?: string | null): string {
  let trimmed = (reply || "").trim();
  const umLower = userMessage.toLowerCase();

  // FOOD-CATEGORY WORD NET (deterministic — the prompt ban alone failed, 2026-07-19:
  // "legumes" reached a township client AGAIN a day after the BRAIN_SYSTEM rule). Category
  // jargon is swapped for the real SA foods the client actually buys. Same principle as the
  // grievance guard: known-dangerous output is corrected in code, not hoped away.
  trimmed = trimmed
    .replace(/\blegumes\b/gi, "beans and lentils")
    .replace(/\bcomplex carb(ohydrate)?s\b/gi, "pap, brown bread, oats or rice")
    .replace(/\bwhole grains\b/gi, "brown bread and oats")
    .replace(/\blean proteins?\b/gi, "chicken, eggs or pilchards")
    .replace(/\bhealthy fats\b/gi, "peanut butter, avo or nuts")
    // Banned bot-phrases the prompt alone fails to stop (2026-07-20: "You've got this!"
    // reached a client). Strip them in code — the sentence reads clean without them.
    .replace(/\s*\bYou'?ve got this[.!]*/gi, "")
    .replace(/\s*\bHow does that sound\??/gi, "")
    .trim();

  // CAPABILITY-DISCLAIMER GUARD — the whole product runs on photo/video analysis (progress pics,
  // food photos, form checks, scale screenshots), but the raw model sometimes leaks its generic
  // "I can't view images" reflex (2026-07-21 live: "I want to send my progress pictures" → "I
  // can't view pictures, but…"). That's a capability LIE that kills trust instantly. Replace any
  // such disclaimer with the truth: send them, I read them.
  trimmed = trimmed.replace(
    /(?:\bas\s+an?\s+[^,.]{0,30},\s*)?\bI(?:\s*'?m|\s+am)?\s+(?:really\s+|just\s+|actually\s+|currently\s+|sorry,?\s+|afraid\s+|directly\s+)*(?:can'?t|cannot|can\s+not|unable\s+to|not\s+able\s+to|(?:'?m\s+|am\s+)?(?:un|not\s+)?able\s+to)\s+(?:\w+\s+){0,2}?(?:view|see|look\s+at|process|analy[sz]e|read|open|receive|access)\s+(?:[\w'-]+\s+){0,3}?(?:pictures?|images?|photos?|pics?|videos?|screenshots?)\b[^.!?]*[.!?]/gi,
    "Yes — send them through! Front, side and back in good light, and I'll read them and track your progress.",
  ).replace(/\s{2,}/g, " ").trim();

  // BULLET-DUMP COLLAPSE (2026-07-21, IMG_6144: a good running answer still came out as a
  // "*Start Slow*: … / *Balance*: … / *Fuel Up*: …" list — reads like an app, not like Kam).
  // The brain prompt bans bullet dumps but the model does it anyway, so we enforce it in code:
  // 3+ bullet/numbered lines are reflowed into flowing coach prose. A short 1–2 item list is
  // left alone (that's fine on WhatsApp); deterministic programmes/lists never pass through here.
  trimmed = collapseBulletDump(trimmed);

  // HUMANIZE (after the semantic rewrites, so the capability-invite etc. survive): strip
  // robotic stalls and content-free corporate filler so the coach gets to the point like Kam.
  // If it empties the reply, the empty-reply handler below gives a real answer.
  trimmed = humanizeReply(trimmed);

  // "have" alone is too broad — "does chicken have protein?" contains "have" but is a question.
  // Only use eating-specific verbs: had/ate/having/eating/just had/just ate/meal labels.
  const looksFoodLog = /\b(ate|had|having|eating|i had|i ate|just had|just ate|meal was|food was)\b/i.test(userMessage)
    || /\b(breakfast|lunch|dinner|supper|snack)\b/i.test(userMessage) && !/^(what|how|is|does|do |can |should |are |will )/i.test(userMessage.trim());
  const looksSteps = /\b(screenshot|step|steps|walk|walked|km|miles)\b/i.test(userMessage);
  const looksVoice = /\b(voice|audio|note)\b/i.test(userMessage);

  if (!trimmed) {
    if (looksFoodLog) {
      return "I could not calculate that meal. Log it like this: \"I had 2 eggs and pap for breakfast\" and I will give you the exact kcal and protein breakdown.";
    }
    if (looksSteps) {
      return "I did not catch your steps. Send a screenshot with the caption \"steps screenshot\" or type the number — \"8500 steps\".";
    }
    return "I had a glitch. Send your last message again and I will respond properly.";
  }

  if (/^what happened\??$/i.test(trimmed)) {
    if (looksSteps) {
      return "Send the screenshot again with this caption: \"steps screenshot\" — I will pull the number.";
    }
    if (looksVoice) {
      return "Didn't fully process that voice note. Please resend it, or type the message.";
    }
    if (looksFoodLog) {
      return "Type the meal like this: \"I had 2 eggs, pap, and cabbage for lunch\" — I will log the kcal and protein instantly.";
    }
    return "What happened? Tell me.";
  }

  // THIS RULE WAS FIGHTING THE COACH VOICE (2026-08-06, live: "Had an Apple" got a form back).
  //
  // It used to fire on ANY food-ish reply under 60 characters with no kcal figure in it — and
  // since the path sweep, that describes almost every CORRECT reply we now write. "Noted — an
  // apple 👌" is 21 characters and deliberately number-free, so a client who logged an apple in
  // three words was handed a template telling them how to type it. The repair was written when
  // replies were long and number-heavy; it outlived the thing it was repairing.
  //
  // The instruction is only right when the reply is genuinely USELESS — an apology, a refusal,
  // or a stall with no acknowledgement in it. A short confirmation is not broken; it is the goal.
  // ONE test, not two: an apology or a refusal IS the evidence the reply is useless. A short
  // confirmation ("Noted — an apple 👌") contains none of these words and now survives.
  const isUseless = /\b(sorry|i can'?t|cannot|unable|didn'?t catch|not sure what|try again|unclear)\b/i.test(trimmed);
  if (looksFoodLog && trimmed.length < 60 && isUseless
    && !/\d+\s*(kcal|cal|calories|protein|g\s*protein|kj)/i.test(trimmed) && !/food logged|logged ✅|meal total|day total/i.test(trimmed)) {
    return "Tell me what it was and I'll log it — e.g. \"2 eggs and brown bread\" or \"chicken and rice\".";
  }

  if (/^(i understand\.?|understood\.?|great\.?|noted\.?|got it\.?|sure\.?|ok\.?|okay\.?)$/i.test(trimmed)) {
    if (looksFoodLog) {
      return "Tell me what you ate — food name, rough quantity, and which meal — and I will log the calories and protein.";
    }
    return "What do you need right now?";
  }

  const guarded = enforceCoachGuardrails(trimmed, { userMessage, budgetTier, injuries });

  // MALFORMED-OUTPUT GUARD (ledger D6 mitigation, 2026-07-28). The old brain occasionally emits
  // structurally broken text — a literal asterisk, an unclosed bracket, a sentence cut mid-word.
  // A full engine migration is weeks; this is the cheap protection that stops the worst of it
  // reaching a client today. Catches are logged so the real fix has evidence.
  const integrity = guardMalformed(guarded.reply);
  recordGuardResult(integrity.pass);
  if (!integrity.pass) {
    console.warn(`[MALFORMED_GUARD] blocked reply — ${integrity.reasons.join(", ")}: ${guarded.reply.slice(0, 120)}`);
    return safeFallback();
  }
  return guarded.reply;
}

// PHOTO-vs-TEXT DUPLICATE GUARD (2026-07-16 live): a client logged a meal by voice, then
// sent a PHOTO of the same plate "to show you" — it logged AGAIN (2979 vs 2862 target).
// kcal dedup was rejected long ago (different meals share totals); NAME overlap is safe —
// 2+ shared food words (4+ chars) with a meal logged TODAY means the same dish.
// Fail-open: any error returns null and the meal logs normally (never block a log).
const MEAL_STOP_WORDS = new Set(["with", "and", "some", "the", "this", "that", "today", "lunch", "dinner", "breakfast", "supper", "snack", "meal", "food", "cooked", "portion", "plate", "small", "large", "cups", "photo"]);
const mealWords = (s: string) => new Set((s.toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !MEAL_STOP_WORDS.has(w)));

/**
 * Do two meal descriptions look like the SAME dish? (pure/tested). Two shared words was too
 * loose — two DIFFERENT breakfasts both containing "boiled eggs" were flagged as a duplicate,
 * and the genuinely-new meal never got logged (2026-07-22 live). Now the shared words must be
 * a real PROPORTION of the smaller meal (a re-logged plate overlaps ~fully; two meals that
 * merely share eggs overlap ~a third). Preserves the original fix (a photo of a just-logged
 * plate) while never blocking a genuinely different meal.
 */
export function mealsOverlap(a: string, b: string): boolean {
  const A = mealWords(a), B = mealWords(b);
  if (A.size < 2 || B.size < 2) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  if (shared < 2) return false;
  return shared / Math.min(A.size, B.size) >= 0.6;
}

export async function findDuplicateMealToday(userId: string, desc: string): Promise<{ desc: string; slot: string } | null> {
  if (mealWords(desc).size < 2) return null; // too little signal to judge — log normally
  try {
    const rows = await db.select({ rawMessage: mealLogs.rawMessage, mealLabel: mealLogs.mealLabel })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, userId), gte(mealLogs.loggedAt, sastDayStart())))
      .limit(20);
    for (const r of rows) {
      if (mealsOverlap(desc, r.rawMessage || "")) {
        return {
          desc: (r.rawMessage || "that meal").replace(/\s+/g, " ").trim().slice(0, 70),
          slot: (r.mealLabel || "lunch").toString(),
        };
      }
    }
  } catch (e) { console.warn("[DUP_MEAL_GUARD] check failed (logging normally):", (e as Error)?.message); }
  return null;
}

/**
 * WEEKLY-JOURNEY LINE (2026-07-16 founder review): sum the last 7 SAST days of
 * logged food against loggedDays × daily target and hand the numbers to the one
 * wording brain (education.weeklyNetWording). Only days with an actual log count —
 * an unlogged Saturday is unknown, not a 0 kcal triumph. Fail-open: any error
 * returns "" and the meal list serves without it.
 */
export async function weeklyNetLine(user: any): Promise<string> {
  try {
    const target = user?.calorieTarget || 1800;
    const weekStart = new Date(sastDayStart().getTime() - 6 * 86_400_000);
    const rows = await db.select({
      day: sql<string>`to_char(${mealLogs.loggedAt} + interval '2 hours', 'YYYY-MM-DD')`,
      kcal: sql<number>`COALESCE(SUM(${mealLogs.kcalInt}), 0)::int`,
    }).from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, weekStart)))
      .groupBy(sql`to_char(${mealLogs.loggedAt} + interval '2 hours', 'YYYY-MM-DD')`);
    const loggedDays = rows.filter(r => (r.kcal || 0) > 0);
    if (loggedDays.length < 3) return "";
    const eaten = loggedDays.reduce((s, r) => s + (r.kcal || 0), 0);
    const goal = String(user?.goalType || "fat_loss").toLowerCase();
    return weeklyNetWording({
      loggedDays: loggedDays.length,
      netKcal: eaten - loggedDays.length * target,
      building: goal === "muscle_gain" || goal === "weight_gain",
      numbersLow: getNumbersMode(user) === "low",
    });
  } catch (e) {
    console.warn("[WEEKLY_NET] non-fatal:", (e as Error)?.message || e);
    return "";
  }
}

export async function recomputeTodayFoodTotals(userId: string): Promise<{ calories: number; protein: number }> {
  // Cache hit: return cached value if still within TTL
  const cached = _foodTotalsCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < FOOD_TOTALS_CACHE_TTL_MS) {
    return { calories: cached.calories, protein: cached.protein };
  }

  const todayStart = sastDayStart();

  // ONE SOURCE OF TRUTH (2026-07-22): the day total comes from the day-ledger, the same
  // function the card and the diary read — so the running total can never disagree with them.
  const { getDayLedger } = await import("../day-ledger");
  const ledger = await getDayLedger(userId);
  if (ledger.kcal > 0 || ledger.protein > 0) {
    const result = { calories: ledger.kcal, protein: ledger.protein };
    _foodTotalsCache.set(userId, { ...result, cachedAt: Date.now() });
    return result;
  }

  // A LEGITIMATE ZERO IS NOT A MISSING NUMBER (2026-08-10, directive P0.3).
  //
  // Below is a text-scrape of the chat log, kept for clients who predate meal_logs. It ran
  // whenever TODAY read zero — so any day that correctly returned to zero was overwritten by
  // calories re-parsed out of old chat prose. Moving a meal to yesterday left it counted on
  // both days; wiping the day put the calories straight back; and every one of those numbers
  // disagreed with the rows, which is the exact "system tells the user one thing while the
  // database says another" the directive forbids.
  //
  // So the fallback is now scoped to who it was written for: a client with NO meal_logs row,
  // ever. Anyone who has logged through the ledger is a ledger client, and their zero is real.
  const [everLogged] = await db.select({ id: mealLogs.id }).from(mealLogs)
    .where(eq(mealLogs.userId, userId)).limit(1).catch(() => [] as any[]);
  if (everLogged) {
    const zero = { calories: 0, protein: 0 };
    _foodTotalsCache.set(userId, { ...zero, cachedAt: Date.now() });
    return zero;
  }

  // Legacy fallback (pre-meal_logs users with only chatHistory FOOD_LOG rows).
  const legacyLogs = await db.select({
    messageIn: chatHistory.messageIn,
    messageOut: chatHistory.messageOut,
  }).from(chatHistory).where(and(
    eq(chatHistory.userId, userId),
    eq(chatHistory.intent, "FOOD_LOG"),
    gte(chatHistory.createdAt, todayStart),
  ));

  // Fallback: legacy chatHistory scanning (pre-meal_logs users)
  let calories = 0;
  let protein = 0;
  for (const log of legacyLogs) {
    const parsed = parseFoodLogTotalsFromMessageOut(log.messageOut || "");
    if (parsed) {
      calories += parsed.calories;
      protein += parsed.protein;
      continue;
    }
    const matched = scanForSAFoods(log.messageIn || "");
    calories += matched.reduce((s, f) => s + (f.typicalPortionCalories || 0), 0);
    protein += matched.reduce((s, f) => s + (f.typicalPortionProtein || 0), 0);
  }
  const legacyResult = { calories, protein };
  _foodTotalsCache.set(userId, { ...legacyResult, cachedAt: Date.now() });
  return legacyResult;
}

/**
 * ONE OWNER FOR REMOVING A MEAL (2026-08-07).
 *
 * The founder's day went from «Running total: ~600 kcal» at 11:51 to «nothing logged yet
 * today» at 11:55, and I could not say why — because eight different branches each deleted a
 * row with their own hand-written three-line epilogue (delete, invalidate, resync the user
 * columns). Nothing recorded WHAT was removed, so a day that fell to zero left no trace of the
 * branch that emptied it. An outside reviewer read that as "they never wrote the code to save
 * it" — the write works; the disappearance was unaudited, which is indistinguishable from the
 * outside.
 *
 * So every removal comes through here, and every removal leaves a line in the log naming the
 * reason, the rows, the kcal, and the before → after for the day. The next time a day drops,
 * Railway says which branch did it in one grep, instead of costing a night of theorising.
 *
 * It also makes the epilogue impossible to forget: a delete that skipped the cache
 * invalidation or the users-table resync used to leave the client's day disagreeing with the
 * client's log for thirty seconds, which is its own bug class.
 *
 * Returns the day's recomputed totals, so callers keep reporting the number they always did.
 */
export async function dropMeals(
  userId: string,
  ids: string[],
  reason: string,
): Promise<{ calories: number; protein: number }> {
  const before = await recomputeTodayFoodTotals(userId);
  const keep = ids.filter(Boolean);
  if (keep.length) {
    // Read what is about to go BEFORE it goes. An audit line written after the delete can only
    // say "something left"; this one can say what, and for how many calories.
    const doomed = await db.select({ id: mealLogs.id, kcal: mealLogs.kcalInt, prot: mealLogs.proteinInt, raw: mealLogs.rawMessage })
      .from(mealLogs).where(and(eq(mealLogs.userId, userId), inArray(mealLogs.id, keep)))
      .catch(() => [] as any[]);
    for (const id of keep) await db.delete(mealLogs).where(eq(mealLogs.id, id));
    const lostK = doomed.reduce((s: number, r: any) => s + (r.kcal || 0), 0);
    const lostP = doomed.reduce((s: number, r: any) => s + (r.prot || 0), 0);
    turnMutation(`DROP reason=${reason} rows=${doomed.length} kcal=-${lostK}`);
    console.log(`[MEAL_DROP] reason=${reason} rows=${doomed.length}/${keep.length} kcal=-${lostK} prot=-${lostP} `
      + `user=...${String(userId).slice(-6)} foods=${doomed.map((r: any) => String(r.raw || "?").slice(0, 24)).join(" | ")}`);
  }
  invalidateFoodTotalsCache(userId);
  const after = await recomputeTodayFoodTotals(userId);
  await db.update(users)
    .set({ todayCalories: after.calories, todayProteinG: after.protein, todayCaloriesDate: sastToday() })
    .where(eq(users.id, userId));
  console.log(`[MEAL_DROP] day ${before.calories}→${after.calories} kcal, ${before.protein}→${after.protein}g protein (reason=${reason})`);
  return after;
}

/**
 * WELLNESS FOOD-LOG REPLY — the no-numbers version for a "just get healthier" client.
 * Warm, plain, habit-first: what they ate, ONE quality nudge (no grams, no calories), and the
 * reinforcement that logging daily is the win. Pure and deterministic so it's fully unit-tested.
 */
export function wellnessFoodLogReply(p: {
  foodLines: string; totalMealProtein: number; hasGoodProteins?: boolean; junkDominant?: boolean; user: any;
}): string {
  const { foodLines, totalMealProtein, hasGoodProteins, junkDominant, user } = p;
  const first = user?.name ? String(user.name).split(" ")[0] : "";
  const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

  let nudge: string;
  if (junkDominant) {
    nudge = pick([
      "That one's a treat — enjoy it, no guilt. Just make the next meal a proper one with some protein and veg.",
      "Treat meal — all good, it's logged. Back to your normal plate next time and you're on track.",
    ]);
  } else if (totalMealProtein >= 20 || hasGoodProteins) {
    nudge = pick([
      "Nice — there's good protein in there. That's the thing that keeps you full and strong.",
      "Solid plate. The protein in that is exactly what your body wants.",
    ]);
  } else {
    nudge = pick([
      "Good log. Next time try to add a protein — eggs, chicken, fish or beans — it keeps you fuller for longer.",
      "Logged. One tip: a bit of protein with this would round it out and keep the hunger away.",
    ]);
  }
  const habit = pick([
    "Logged ✅ Showing up like this every day is what actually changes things.",
    "Got it ✅ The winning move is just being consistent — and you are.",
    "Done ✅ Small steady habits like this beat any crash diet. Keep going.",
  ]);
  return `${foodLines}\n\n${first ? `${first}, ` : ""}${nudge}\n\n${habit}`;
}

export async function buildFoodLogReply(p: {
  foodLines: string;
  mealLabel: string;
  totalMealCals: number;
  totalMealProtein: number;
  runningCals: number;
  runningProtein: number;
  calorieTarget: number;
  proteinTarget: number;
  prevCals: number;
  junkNoteText?: string;
  hasGoodProteins?: boolean;
  hasCarbs?: boolean;
  /** the MEAL is majority junk calories (takeaway/treat) — verdict must be honest, not
   *  a green "Nicely done" just because it fits the calorie budget (2026-07-17 live). */
  junkDominant?: boolean;
  coachNoteOverride?: string;
  user: any;
  todaySteps?: number;
  userMessage?: string;
  /** the meal was logged to a PAST day (retro) — it must NOT touch TODAY's running total. */
  isRetro?: boolean;
  /** A card is coming, so the CARD owns the day's instruction and the text stands down.
   *  See server/card-policy.ts — one meal used to carry this instruction five times. */
  cardComing?: boolean;
}): Promise<string> {
  // DELETED 2026-08-04 (Slice 4). Roughly four hundred lines stood here deciding what to SAY
  // about a meal: a verdict headline, an itemised list with kcal and protein per food, a
  // running total, a remaining-today line, a protein nudge, a junk note, a streak note, a
  // button menu — and separate variants for retro logs, wellness clients and number-free
  // clients. It was the single most prolific mouth in the product, and it spoke over the coach
  // on the one interaction clients do most.
  //
  // The tool still does everything it did: the meal is scanned, priced and written to their
  // record, and the card still carries the picture. What is gone is the RECEIPT. The engine
  // names the food back in their own words; this line is only what a client hears if the
  // engine wrote nothing that turn.
  //
  // Their words, not the scanner's (voice rule 18): the label is stripped back to bare food
  // names — no "(stiff maize porridge)", no "(1 cup cooked)", no kcal.
  // THEIR WORDS, NOT THE SCANNER'S (voice rule 18). The scanner resolves "chicken" to
  // "Chicken thigh (1 large thigh (150g cooked))" because it needs a row to price. The client
  // said "chicken". Saying "Chicken thigh" back is the machine correcting them with its own
  // vocabulary, on the one interaction they do most.
  //
  // So each resolved name is intersected with what they actually typed, word by word, and only
  // the words they used survive. A name with no overlap at all (a photo, where they typed
  // nothing) is dropped rather than guessed at — "Got it. 👌" is a complete reply and it cannot
  // put a word in their mouth.
  const said = String(p.userMessage || "").toLowerCase();
  const bareNames = String(p.foodLines || "")
    .split("\n")
    .map(l => l.replace(/^[•\-\s]+/, "").split(/[:(]/)[0].trim())
    .map(name => name.split(/\s+/).filter(w => w.length > 2 && said.includes(w.toLowerCase())).join(" ").trim())
    .filter(Boolean)
    .slice(0, 3);
  const label = bareNames.length > 1
    ? `${bareNames.slice(0, -1).join(", ")} and ${bareNames[bareNames.length - 1]}`
    : bareNames[0] || "";
  const line = neverSilentLine("meal", { label, carryingShame: carriesFeelingClause(p.userMessage || "") });
  // The retro day is a FACT the client needs — logging to the wrong day is the one error they
  // cannot see. It rides as a clause, not as a second sentence.
  return p.isRetro ? line.replace(/\.\s*👌$/, " — logged for yesterday. 👌") : line;
}

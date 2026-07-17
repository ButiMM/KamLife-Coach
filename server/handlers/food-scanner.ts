import { SA_FOODS_SEED, type SAFood } from "../foods";
import { swapNudge } from "../food-swaps";
import { enforceCoachGuardrails } from "../coach-guardrails";
import { educationNote, remainingInMeals, weeklyNetWording } from "../education";
import { getNumbersMode, stripFoodLineNumbers, plainProteinNudge } from "../numbers-mode";
import { stepBurnKcal } from "../targets";
import { db } from "../db";
import { mealLogs, chatHistory } from "../../shared/schema";
import { eq, and, gte, sql, desc } from "drizzle-orm";
import { sastDayStart } from "../utils";

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

// Track which users have already received the low-cal warning today (SAST date key)
const _lowCalWarnedToday = new Map<string, string>();

// Track streak celebration shown today — prevents it firing on every meal log
const _streakShownToday = new Map<string, string>();

function _todaySastKey(): string {
  const d = new Date(Date.now() + 2 * 3_600_000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

export function hasShownStreakToday(userId: string): boolean {
  return _streakShownToday.get(userId) === _todaySastKey();
}

export function markStreakShownToday(userId: string): void {
  _streakShownToday.set(userId, _todaySastKey());
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
      if (!l.createdAt) continue;
      const d = new Date(new Date(l.createdAt).getTime() + 2 * 3_600_000);
      days.add(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`);
    }
    let streak = 0;
    const checkDate = new Date(Date.now() + 2 * 3_600_000);
    while (true) {
      const key = `${checkDate.getUTCFullYear()}-${checkDate.getUTCMonth() + 1}-${checkDate.getUTCDate()}`;
      if (!days.has(key)) break;
      streak++;
      checkDate.setUTCDate(checkDate.getUTCDate() - 1);
    }
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
  30: (n) => `\n\n🏆 *${n}, 30 days.* A full month of food logs. I do not see many people get here. Your consistency record is real — take a moment with that.`,
};

export function getFoodStreakCelebration(streak: number, name: string): string {
  const fn = name.split(" ")[0] || "there";
  return FOOD_STREAK_MESSAGES[streak]?.(fn) ?? "";
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

function levenshtein(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const dp: number[][] = Array.from({ length: la + 1 }, () => Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[la][lb];
}

// Max edit distance allowed based on word length — VERY STRICT to avoid false matches
// "better" → "butter" was distance 1 and matched. Now requiring longer words for any fuzzy.
function maxDistance(wordLen: number): number {
  if (wordLen <= 4) return 0;
  if (wordLen <= 6) return 1;
  if (wordLen <= 10) return 2;
  return 2;
}

const FUZZY_BLACKLIST = new Set([
  "just", "had", "have", "having", "that", "this", "with", "from", "for",
  "what", "when", "where", "which", "about", "after", "before", "been",
  "would", "could", "should", "want", "need", "like", "make", "made",
  "take", "took", "give", "gave", "come", "came", "going", "went",
  "here", "there", "then", "than", "them", "they", "their", "your",
  "more", "some", "much", "many", "very", "also", "still", "well",
  "good", "feel", "feeling", "today", "yesterday", "morning",
  "afternoon", "evening", "night", "breakfast", "lunch", "dinner",
  "supper", "snack", "meal", "food", "total", "remaining", "calories",
  "protein", "daily", "target", "please", "thanks", "thank", "help",
  "read", "again", "true", "adjust", "correct", "wrong", "right",
  "better", "everything", "nothing", "something", "doing", "being",
  "getting", "looking", "working", "trying", "never", "always",
  "start", "stop", "keep", "send", "show", "tell", "look", "work",
  "think", "know", "really", "thing", "things", "stuff", "great",
  "terrible", "horrible", "broken", "fixed", "update", "check",
  // Non-food words that fuzzy-match real foods (e.g. "past" → "pasta", "days" → "dates")
  "past", "days", "havent", "trained", "training", "three", "down",
  "flat", "week", "weeks", "month", "months", "year", "years",
  "motivated", "motivation", "unmotivated", "struggling", "struggle",
  "missed", "missing", "lately", "recently", "done", "gone",
]);

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
// Meat words that carry a BARE single-word alias on a standalone cut entry, mapped to
// that cut. Only "chicken" (→ "Chicken thigh") does today; the map keeps it extensible.
const GENERIC_MEAT_CUTS: Record<string, string[]> = {
  chicken: ["Chicken thigh"],
};

// Drop a phantom meat CUT that's actually qualifying a different processed food.
// "2 chicken viennas" matches both "chicken" → Chicken thigh AND "viennas" → Viennas;
// the Chicken thigh is protein the client never ate (and the "2" then doubles it).
// We only drop the cut when EVERY occurrence of the meat word sits immediately before
// such a noun — a real standalone "chicken and rice" or "chicken thigh and viennas"
// keeps its chicken.
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

// Final cleanup applied to EVERY scanner return path (this used to live only after
// fuzzy matching, so when exact matching succeeded — the common case — it was skipped
// entirely, which is how "i had lentils, rice and chicken breast" logged both
// "Chicken breast" AND the phantom "Chicken and rice", double-counting the chicken).
//
// Combo dedup decides which to keep when a combo meal and its components both matched:
//   - 2+ components ALSO matched separately  → the client listed them individually
//     ("...rice and chicken breast...") and the combo is a phantom from word adjacency
//     → DROP THE COMBO, keep the granular items.
//   - ≤1 component matched → the client named the dish ("chicken and rice") and the
//     stray component is the spurious substring → keep the combo, drop the component.
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

  // PASS 1: Exact word-boundary matching (fast, preferred)
  const matchedWithAlias: { food: SAFood; alias: string }[] = [];
  for (const food of SA_FOODS_SEED) {
    const allAliases = [food.name.toLowerCase(), ...food.aliases.map(a => a.toLowerCase())];
    let longestHit = "";
    for (const alias of allAliases) {
      // PLURAL-TOLERANT (2026-07-17 live: "two beef bacon burgers" logged only the
      // bacon — \bburger\b cannot see "burgers", so the whole table was blind to
      // plural speech). Optional s/es suffix; alias text itself stays the match key.
      const re = new RegExp(`\\b${escapeRegex(alias)}(?:es|s)?\\b`, "i");
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
        matched.push(entry.food);
      }
    }
  }

  // PASS 2: Fuzzy matching (only if exact found nothing)
  // exactOnly: callers gating AUTO-logging (no eating verb present) must not act on
  // fuzzy guesses — fuzzy matched "building phase" to mopani worms and logged a fake
  // meal over a goal-change request (caught by routing-audit).
  if (matched.length > 0 || opts?.exactOnly) return finalizeMatches(matched, lower);

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
        const allowed = maxDistance(alias.length);
        if (dist <= allowed && dist < bestScore) {
          bestScore = dist;
        }
      }
    }
    if (bestScore < Infinity && !matched.find(f => f.name === food.name)) {
      matched.push(food);
    }
  }

  return finalizeMatches(matched, lower);
}

export function parseFoodLogTotalsFromMessageOut(messageOut: string): { calories: number; protein: number } | null {
  if (!messageOut) return null;
  const totalLine = messageOut.match(/\*(?:Meal|Day) total:\s*~?(\d+)\s*kcal\s*\|\s*~?(\d+)g\s*protein\*/i);
  if (totalLine) {
    return { calories: parseInt(totalLine[1], 10), protein: parseInt(totalLine[2], 10) };
  }
  return null;
}

export function sanitizeCoachReply(reply: string, userMessage: string, budgetTier?: string | null, injuries?: string | null): string {
  const trimmed = (reply || "").trim();
  const umLower = userMessage.toLowerCase();

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

  if (looksFoodLog && trimmed.length < 60 && !/\d+\s*(kcal|cal|calories|protein|g\s*protein|kj)/i.test(trimmed) && !/food logged|logged ✅|meal total|day total/i.test(trimmed)) {
    return "Type the meal like this:\n\n\"I had 2 eggs and brown bread for breakfast\"\n\"Chicken and rice for lunch\"\n\nI will give you the full kcal and protein breakdown.";
  }

  if (/^(i understand\.?|understood\.?|great\.?|noted\.?|got it\.?|sure\.?|ok\.?|okay\.?)$/i.test(trimmed)) {
    if (looksFoodLog) {
      return "Tell me what you ate — food name, rough quantity, and which meal — and I will log the calories and protein.";
    }
    return "What do you need right now?";
  }

  const guarded = enforceCoachGuardrails(trimmed, { userMessage, budgetTier, injuries });
  return guarded.reply;
}

// PHOTO-vs-TEXT DUPLICATE GUARD (2026-07-16 live incident): a client logged a meal by
// voice, then sent a PHOTO of the same plate "to show you" — and it logged AGAIN,
// blowing the day's totals (2979 kcal vs 2862 target). kcal-based dedup was correctly
// rejected long ago (different meals share totals); NAME overlap is safe — two or more
// shared food words (4+ chars) with a meal already logged TODAY means the same dish.
// Fail-open: any error returns null and the meal logs normally (never block a log).
const MEAL_STOP_WORDS = new Set(["with", "and", "some", "the", "this", "that", "today", "lunch", "dinner", "breakfast", "supper", "snack", "meal", "food", "cooked", "portion", "plate", "small", "large", "cups", "photo"]);
export async function findDuplicateMealToday(userId: string, desc: string): Promise<{ desc: string; slot: string } | null> {
  const words = (s: string) => new Set((s.toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !MEAL_STOP_WORDS.has(w)));
  const target = words(desc);
  if (target.size < 2) return null; // too little signal to judge — log normally
  try {
    const rows = await db.select({ rawMessage: mealLogs.rawMessage, mealLabel: mealLogs.mealLabel })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, userId), gte(mealLogs.loggedAt, sastDayStart())))
      .limit(20);
    for (const r of rows) {
      const logged = words(r.rawMessage || "");
      let shared = 0;
      for (const t of target) if (logged.has(t)) shared++;
      if (shared >= 2) {
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

  const [mealLogSum, legacyLogs] = await Promise.all([
    db.select({
      calories: sql<number>`COALESCE(SUM(${mealLogs.kcalInt}), 0)::int`,
      protein: sql<number>`COALESCE(SUM(${mealLogs.proteinInt}), 0)::int`,
    }).from(mealLogs).where(and(
      eq(mealLogs.userId, userId),
      gte(mealLogs.loggedAt, todayStart),
    )).then(r => r[0]),

    db.select({
      messageIn: chatHistory.messageIn,
      messageOut: chatHistory.messageOut,
    }).from(chatHistory).where(and(
      eq(chatHistory.userId, userId),
      eq(chatHistory.intent, "FOOD_LOG"),
      gte(chatHistory.createdAt, todayStart),
    )),
  ]);

  if (mealLogSum && (mealLogSum.calories > 0 || mealLogSum.protein > 0)) {
    const result = { calories: mealLogSum.calories || 0, protein: mealLogSum.protein || 0 };
    _foodTotalsCache.set(userId, { ...result, cachedAt: Date.now() });
    return result;
  }

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

export function buildFoodLogReply(p: {
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
  coachNoteOverride?: string;
  user: any;
  todaySteps?: number;
  userMessage?: string;
}): string {
  const {
    foodLines, mealLabel, totalMealCals, totalMealProtein,
    runningCals, runningProtein, calorieTarget, proteinTarget,
    prevCals, junkNoteText, hasGoodProteins, hasCarbs,
    coachNoteOverride, user,
  } = p;

  const calRemaining = calorieTarget - runningCals;
  const proteinRemaining = proteinTarget - runningProtein;
  const earlyInDay = runningCals < (calorieTarget * 0.4);

  // Extra step burn beyond target — weight-scaled via the ONE canonical formula so a
  // heavy client's deficit is credited correctly (was a flat rate that under-counted).
  const stepsTarget = user.stepsTarget || 8500;
  const todaySteps = p.todaySteps || 0;
  const weightKgForBurn = user.currentWeight ? parseFloat(String(user.currentWeight)) : 75;
  const extraStepsBurned = todaySteps > stepsTarget
    ? stepBurnKcal(todaySteps - stepsTarget, weightKgForBurn)
    : 0;

  const effectiveRemaining = calRemaining + extraStepsBurned;
  // The calorie day is effectively closed — meaningfully over target even after step
  // burn. Used to stop protein nags that tell someone to "eat more today" in the same
  // message that tells them "no more food today — water only".
  const calorieCeilingHit = calRemaining <= 0 && effectiveRemaining <= -100;
  const stepsNote = extraStepsBurned > 0 && calRemaining < 0
    ? ` · ${todaySteps.toLocaleString()} steps burned ~${extraStepsBurned} extra kcal`
    : "";
  // Suppress running total if it exceeds what's plausible for the time of day —
  // guards against inflated counts caused by duplicate entries from retried requests.
  const sastHourNow = new Date(Date.now() + 2 * 3_600_000).getUTCHours();
  const maxReasonableCals = calorieTarget * (
    sastHourNow < 11 ? 0.65 :
    sastHourNow < 14 ? 0.85 :
    sastHourNow < 17 ? 1.1 :
    1.5
  );
  const runningTotalSane = runningCals <= maxReasonableCals;
  // When the running total is implausible for the time of day, SAY SO — the old
  // silent "Remaining today: ~0 kcal" hid a duplicate-inflated day from the client
  // instead of helping them fix it (2026-07-06: four copies of one dinner sailed
  // past this guard unremarked).
  // PLAIN LANGUAGE (2026-07-14, a tester: "it talks in calories and I don't
  // understand calories"). A number never travels alone — every "X remaining" is
  // paired with what it means as FOOD ("a light meal or a good snack"), the unit
  // this market actually thinks in. remainingInMeals already existed for the
  // day-3 summary; surface it on every log, for every client, forever — not just
  // the first weeks.
  const mealsLeft = effectiveRemaining > 0 ? remainingInMeals(effectiveRemaining) : "";
  const runningLine = prevCals > 0 && runningTotalSane
    ? `Running total today: ~${runningCals} kcal / ${calorieTarget} target${effectiveRemaining > 0 ? ` (${effectiveRemaining} to go${mealsLeft ? ` — ${mealsLeft}` : ""}${stepsNote})` : effectiveRemaining >= -100 ? ` ✅ on target${stepsNote}` : ` · over by ~${Math.abs(effectiveRemaining)} kcal${stepsNote}`}`
    : prevCals > 0
    ? `Today's total (~${runningCals} kcal) looks high for this time of day — if something was logged twice, send *my meals* to check, then *remove the duplicates*.`
    : `Remaining today: ~${Math.max(0, effectiveRemaining)} kcal${stepsNote}`;

  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
  const isMuscleGain = (user.goalType || "fat_loss").toLowerCase() === "muscle_gain";

  let dayAssessment = "";
  // Only assess the day when we trust the running total. When runningTotalSane is
  // false the line above already softens to "Remaining ~X" — firing an "over by
  // 800, no more food" verdict off the same distrusted number contradicts it.
  if (prevCals > 0 && totalMealCals >= 100 && runningTotalSane) {
    const hourNow = new Date(Date.now() + 2 * 3_600_000).getUTCHours();
    const dayProgress = Math.min(hourNow / 20, 1);
    const expectedCals = calorieTarget * dayProgress;
    const calPace = runningCals / Math.max(expectedCals, 1);
    if (calRemaining <= 0 && effectiveRemaining <= -100) {
      const overBy = Math.abs(effectiveRemaining);
      if (isMuscleGain) {
        // For muscle gain a surplus is the goal — don't guilt-trip; just flag if excessive
        dayAssessment = overBy >= 600
          ? `\n_You've eaten ~${overBy} kcal more than your body burns today — a bit much. Tomorrow eat a little closer to your target so the muscle you build stays lean._`
          : `\n_${pick([
              `~${overBy} kcal more than your body burns today — for building muscle that's good. Train hard and it gets used.`,
              `You're ~${overBy} kcal above what you burn — that's your building fuel. Keep training._`,
            ])}_`;
      } else if (extraStepsBurned >= 80) {
        dayAssessment = `\n_A bit over on food, but your walking burned ~${extraStepsBurned} kcal of it off. You're only ~${overBy} above what you burned — keep the next meal light and you're fine._`;
      } else if (overBy >= 800) {
        dayAssessment = `\n_You're ~${overBy} kcal over today — it happens, no panic. If you eat again, keep it light: protein and veg. One day doesn't undo your progress._`;
      } else if (overBy >= 400) {
        dayAssessment = `\n_~${overBy} kcal over. If you're eating again, make it lean — grilled protein and some veg. Tomorrow's a clean slate._`;
      } else {
        dayAssessment = `\n_${pick([
          "You're at your calories for today — if you eat again, lean is the move: protein and veg.",
          "Calories are done for the day. A light protein-and-veg meal is perfect if you're still hungry.",
          "On your limit. Keep the last meal protein-forward and light if you can.",
          "Hit your target. Anything else today, keep it lean — protein and greens.",
        ])}_`;
      }
    } else if (calRemaining <= 0 && effectiveRemaining > -100) {
      dayAssessment = `\n_${pick(isMuscleGain
        ? [
            "On target. Fuel is in — train hard and let it work.",
            "Hit your calorie target. Session tomorrow converts this into muscle.",
            "Calories done. Recover well tonight and push hard tomorrow.",
          ]
        : [
            "Your steps covered the gap — net calories back on target. Keep last meal light.",
            "Your walking cancelled out the extra food. You're clean. Light protein for dinner.",
            "Walking got you back on track. Last meal: lean and light.",
            "Steps cancelled the overage — effectively on target. Finish with something lean.",
          ]
      )}_`;
    } else if (!earlyInDay && calPace < 0.6 && effectiveRemaining < 600) {
      dayAssessment = `\n_${pick([
        "Solid pace. One high-protein meal closes the day.",
        "On track — finish it with a protein-heavy dinner.",
        "Good rhythm. One real protein meal left and you're done.",
        "Close. One more protein-first meal and the day is yours.",
        "Running well. Lock it in with a solid final meal.",
      ])}_`;
    } else if (!earlyInDay && calPace > 1.3) {
      dayAssessment = `\n_${pick(isMuscleGain
        ? [
            "Running high — if you're training hard, your body handles it. Close with lean protein.",
            "Over pace — finish with protein, not starch. Chicken, eggs, or fish.",
          ]
        : [
            "Running over — strip dinner down. Protein only, no starch.",
            "Over pace. Last meal needs to be lean: protein and veg, nothing else.",
            "Calorie creep — make dinner strict. Protein and greens only.",
            "You're high for the pace. Final meal = lean protein and vegetables.",
            "Over budget. End it clean: grilled chicken, eggs, or fish with veg.",
          ]
      )}_`;
    } else if (!earlyInDay && calPace >= 0.8 && calPace <= 1.2) {
      dayAssessment = `\n_${pick([
        "Clean day. One more solid meal and you close it out.",
        "On target. Finish it: one protein meal left.",
        "Tracking well. Last meal = finish your protein and you're done.",
        "On point. End it with protein and the day is yours.",
        "Consistent all day. One more and you've nailed it.",
        "Solid. Close it with a high-protein final meal.",
      ])}_`;
    }
  }

  // Zero-calorie drinks (Coke Zero, sparkling water, black coffee, rooibos, diet drinks)
  // get a clean one-liner acknowledgment — goal-aware since muscle gain needs calories from food.
  // Threshold <= 5 kcal catches rounding artefacts (Coke Zero stored as 1 kcal).
  const isZeroCalDrink = totalMealCals <= 5 && totalMealProtein === 0;
  if (isZeroCalDrink) {
    const zeroCalLines = isMuscleGain
      ? [
          "Zero cal — hydration sorted. Don't let drinks crowd out the food you need to hit your calorie target.",
          "Logged. Zero cal. Keep the food coming — drinks don't build muscle.",
          "Zero calories — fine. Just make sure your meals give you enough to build on.",
        ]
      : [
          "Zero calories — good choice. Keep the water and zero-cal drinks flowing.",
          "Logged. Zero calories. That is exactly what you want from a drink.",
          "Zero calories — sorted. Drink freely.",
        ];
    return `${foodLines}\n\n${zeroCalLines[Math.floor(Math.random() * zeroCalLines.length)]}\n\n${runningLine}`;
  }

  // Fruit snacks (apple, pear, banana etc.) are categorised as "carb" but protein
  // lecturing on fruit makes no sense. Suppress when protein ≤ 3g (fruit range) AND
  // total calories < 300 (snack, not a meal). Grain carbs (pap 6g, rice 4-5g, oats 5g)
  // clear the threshold and still get the coaching note.
  const isFruitSnack = totalMealProtein <= 3 && totalMealCals < 300;

  let coachNote = "";
  const goal = user.goalType || "fat_loss";
  if (coachNoteOverride) {
    coachNote = `\n\n${coachNoteOverride}`;
  } else if (totalMealCals >= 100) {
    if (totalMealProtein >= 20) {
      const protOpener = pick([
        "Solid protein.", "Good protein hit.", "Protein sorted.", "Strong meal.",
        "Protein locked in.", "That's the protein box ticked.",
      ]);
      // When the daily protein target is already met, the single "target hit ✅"
      // is owned by the proteinTip block below. Emit only the opener here so one
      // reply never prints "Protein target hit" twice (which read as a glitch).
      const protCloser = proteinRemaining <= 0
        ? ""
        : calorieCeilingHit
        ? pick([
            `Still ${Math.round(proteinRemaining)}g short on protein — but you're over on calories, so carry it to tomorrow.`,
            `${Math.round(proteinRemaining)}g short on protein, but the calorie day is done. Leave it for tomorrow.`,
          ])
        : pick([
            `${Math.round(proteinRemaining)}g protein still needed today.`,
            `${Math.round(proteinRemaining)}g left to hit your target.`,
            `${Math.round(proteinRemaining)}g more to go today.`,
          ]);
      coachNote = `\n\n${protOpener}${protCloser ? " " + protCloser : ""}`;
    } else if (hasGoodProteins && totalMealProtein >= 10 && proteinRemaining > 0 && !calorieCeilingHit) {
      coachNote = `\n\n${pick(isMuscleGain
        ? [
            `${Math.round(totalMealProtein)}g protein in — building. Hit 20g+ every meal for consistent growth.`,
            `${Math.round(totalMealProtein)}g this meal. No missed meals on protein when you're building — every gram counts.`,
            `Getting there — ${Math.round(totalMealProtein)}g. Aim for 20g+ each meal. That's how muscle gets built consistently.`,
          ]
        : [
            `${Math.round(totalMealProtein)}g protein this meal — close. Push for 20g+ next meal.`,
            `${Math.round(totalMealProtein)}g protein — good start. 20g+ per meal is the target.`,
            `Getting there — ${Math.round(totalMealProtein)}g this meal. Aim for 20g+ each time.`,
            `${Math.round(totalMealProtein)}g in. Almost there — push for 20g+ at the next one.`,
          ]
      )}`;
    } else if (!hasGoodProteins && hasCarbs && !isFruitSnack
        && !earlyInDay && !calorieCeilingHit
        && proteinRemaining > proteinTarget * 0.35) {
      // Only nag about protein if: it's past the first meal of the day AND they're
      // genuinely behind (>35% of daily target still outstanding). Stops constant
      // protein lectures on breakfast oats, lunch rice, etc.
      coachNote = `\n\n${pick(isMuscleGain
        ? [
            "Good fuel. Now the building block: add protein to this or next meal. Carbs without protein doesn't build — eggs, chicken, or mince.",
            "Carbs are in. Protein is next — no exceptions when building. Add it to your next meal.",
            "Fuel stacked. Next meal needs protein alongside it. That's the formula — always.",
          ]
        : [
            "Good fuel. When you can, add eggs, beans, or pilchards to round it out.",
            "Nice and filling. If there's protein in the house, add it next meal — no rush.",
            "Solid carbs. A protein source next meal keeps your total on track.",
            "That'll keep you going. Eggs or tinned fish next meal would round it off nicely.",
          ]
      )}`;
    } else if (!hasGoodProteins && !hasCarbs && junkNoteText
        && !calorieCeilingHit
        && proteinRemaining > proteinTarget * 0.35) {
      coachNote = `\n\n${pick(isMuscleGain
        ? [
            "Protein next meal — non-negotiable when building. Eggs, pilchards, beans, or mince. Pick one.",
            "Get protein in next meal. You cannot build without it — eggs or pilchards are the quick fix.",
          ]
        : [
            "If you've got protein at home — eggs, beans, tinned fish — next meal's a good time for it.",
            "A bit of protein next meal would help — eggs or pilchards are the cheap, easy options.",
            "When you can, get some protein in next meal. Eggs and tinned fish go a long way.",
          ]
      )}`;
    }
  }

  // A junk-item note must not contradict the meal it rides on. "Low protein for the
  // calories" next to "Strong meal, 51g protein" reads as the bot arguing with itself —
  // strip protein-shaming sentences when the meal's protein is actually strong.
  let junkNoteClean = junkNoteText || "";
  if (junkNoteClean && totalMealProtein >= 20) {
    junkNoteClean = junkNoteClean
      .split(/(?<=\.)\s+/)
      .filter(s => !/low protein|no protein|lacks protein/i.test(s))
      .join(" ")
      .trim();
  }
  // KFC protocol (2026-07-13 retention reports): the reply to a junk log decides
  // whether they stay or quit. Affirm the LOGGING — "logging it instead of hiding it"
  // makes the slip part of their identity as someone who doesn't hide. That person stays.
  if (junkNoteClean) {
    junkNoteClean += ` Logging it instead of hiding it — that's the actual difference. Tomorrow we go again.`;
  }
  const junkNote = junkNoteClean ? `\n\n${junkNoteClean}` : "";

  let proteinTip = "";
  const budgetTier = user.weeklyFoodBudget || "100_300";
  const protRemaining = proteinTarget - runningProtein;
  if (!coachNote && !hasGoodProteins && !isFruitSnack && protRemaining > Math.max(50, proteinTarget * 0.4) && calRemaining > 200 && totalMealCals >= 100 && !earlyInDay) {
    const lowBudget = ["under_100", "under_50", "50_100"].includes(budgetTier);
    const suggestions = lowBudget
      ? [
          `Next meal: add 2 eggs (12g protein). Fast and cheap.`,
          `Tin of pilchards with your next meal — 22g protein, R12.`,
          `Tin of tuna = 25g protein. Easy add.`,
          `3 boiled eggs ready in the fridge = protein for the rest of the day.`,
        ]
      : [
          `Next meal: chicken, eggs, or fish — at least 20g protein.`,
          `Greek yoghurt = 10g protein. Good snack if you're not hungry for a full meal.`,
          `Tin of tuna = 25g protein. Easy, fast, keeps you on target.`,
          `2 eggs + anything = quick protein fix. Don't skip it.`,
          `Cottage cheese (15g protein per 100g) — works as a snack or meal add.`,
        ];
    proteinTip = `\n\n${suggestions[Math.floor(Math.random() * suggestions.length)]} ${Math.round(protRemaining)}g protein still needed today.`;
  } else if (protRemaining <= 0) {
    const evnHour = new Date(Date.now() + 2 * 3_600_000).getUTCHours();
    const isEvening = evnHour >= 17;
    const caloriesOnTarget = runningCals <= calorieTarget * 1.1;
    if (isEvening && caloriesOnTarget) {
      const fn = (user.name || "").split(" ")[0] || "Sharp";
      proteinTip = `\n\n${pick([
        `✅ *Protein target hit, ${fn}.* Calories on track. That is a clean nutrition day — same again tomorrow.`,
        `✅ *${fn}, protein and calories both on target.* That is what a clean day looks like. Repeat it.`,
        `✅ *Full day nailed — protein hit, calories clean.* That is the standard, ${fn}. Same again.`,
        `✅ *Protein done, calories locked. ${fn}, that is a complete nutrition day.* Build on this.`,
      ])}`;
    } else {
      proteinTip = `\n\n${pick([
        "Protein target hit. ✅",
        "Daily protein done. ✅",
        "Protein goal complete. ✅",
        "Protein sorted for the day. ✅",
      ])}`;
    }
  }

  // Plain-language explainer for clients who don't know what a calorie is —
  // taught once each, early in the programme, then silent. When it fires it
  // takes the slot the random reinforcement note would have used.
  const eduNote = educationNote(user, {
    event: "meal",
    calorieTarget,
    proteinTarget,
    overBy: effectiveRemaining < 0 ? Math.abs(effectiveRemaining) : 0,
  });

  // Body-image distress ("i feel so fat", "i look gross") next to a macro printout and a chirpy
  // "you're crushing it" note reads as cold. Detect it, suppress the reinforcement, and lead with
  // one grounded line that acknowledges the feeling. ("so much fat" = dietary, not self — excluded.)
  const bodyImageDistress = !!(p.userMessage && (
    /\b(?:feel|feeling|look|looking|i'?m|i\s+am)\b[\sa-z]{0,15}\b(?:fat|gross|disgusting|ugly|horrible|bloated)\b/i.test(p.userMessage)
    || /\bhate\s+(?:my body|how i look|myself)\b/i.test(p.userMessage)
  ));
  let variableReinforcement = "";
  if (!bodyImageDistress && !eduNote && Math.random() < 0.18) {
    const fn = (user.name || "").split(" ")[0] || "Sharp";
    const daysSinceStart = user.programmeStartDate
      ? Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86_400_000)
      : 0;
    const isMuscleBuild = goal === "muscle_gain";
    const NOTES = [
      `\n\n👀 _Coach K noticed: you're logging consistently. That's what separates the people who change from the people who try._`,
      `\n\n⚡ _${daysSinceStart > 7 ? `Day ${daysSinceStart} and still logging` : "Early days, and you're showing up"}. That consistency is the whole game._`,
      `\n\n🎯 _${fn}, one logged meal won't change your body. Fifty of them will. You're building the right habit._`,
      `\n\n💡 _Consistent food logging is the single highest-predictor habit in body transformation. You're doing the one thing that matters most._`,
      `\n\n🔒 _${fn}, this habit is more valuable than any supplement or gym programme. Keep locking it in._`,
      `\n\n📊 _Coach K sees everything you log. The picture builds over time — keep feeding it._`,
      `\n\n🧠 _${fn}, nobody is doing this for you. That's exactly what makes it count._`,
      isMuscleBuild
        ? `\n\n💪 _Protein tracking is your edge, ${fn}. Most people guess. You know._`
        : `\n\n🔥 _${fn}, meal by meal you're eating a bit less than your body burns. That's how the weight comes off._`,
      `\n\n⏱ _${fn}, the gap between who you are and who you want to be closes one logged meal at a time._`,
      `\n\n✅ _Every time you log instead of guessing, you're making a decision that adds up._`,
    ];
    variableReinforcement = pick(NOTES);
  }
  const gentlePrefix = bodyImageDistress
    ? `💚 _${(user.name || "").split(" ")[0] || "Hey"} — one rough day with your reflection doesn't undo the work. You still logged a proper meal, and that's what actually moves things._\n\n`
    : "";

  const sastNow = new Date(Date.now() + 2 * 3_600_000);
  const sastHour = sastNow.getUTCHours();
  const todayKey = `${sastNow.getUTCFullYear()}-${sastNow.getUTCMonth() + 1}-${sastNow.getUTCDate()}`;
  const warnKey = `${user.id}:${todayKey}`;
  const alreadyWarned = _lowCalWarnedToday.get(warnKey) === todayKey;
  const lowCalThreshold = calorieTarget * 0.45;
  let calorieFloorNote = "";
  if (!alreadyWarned && sastHour >= 18 && runningCals > 0 && runningCals < lowCalThreshold) {
    const proteinLogged = Math.round(runningProtein);
    const dayNum = user.totalWorkoutsCompleted || 1;
    if (dayNum <= 3) {
      // Early days — encouraging, not scolding
      calorieFloorNote = `\n\n🎯 ${proteinLogged}g protein logged today — solid start. Tomorrow aim to hit your full calorie target too. One meal at a time.`;
    } else {
      // Established user — coach tone, ask why
      calorieFloorNote = `\n\n⚡ You're under your calorie target today (${runningCals} kcal). Intentional or just a busy day? Either way — have something real before bed. Eggs, pap, chicken. Your body needs fuel to recover from training.`;
    }
    _lowCalWarnedToday.set(warnKey, todayKey);
  }

  // SA shelf swap — ONE plain "next time" line when a logged food has a real better
  // shelf option for their goal (Coke → Zero, full-cream milk → low-fat for fat loss,
  // polony → tinned pilchards). Gated: only when nothing else is already nudging (no
  // junk/grease note), so we never stack two corrections on one meal.
  let swapNote = "";
  if (!junkNote && !coachNoteOverride) {
    const lines = Array.isArray(foodLines) ? foodLines : String(foodLines).split("\n");
    for (const line of lines) {
      const n = swapNudge(line, user.goalType);
      if (n) { swapNote = `\n\n${n}`; break; }
    }
  }

  // ONE add-on per reply (2026-07-10 friction audit): this bubble used to stack coach
  // note + junk note + swap + protein tip + edu note + reinforcement + floor warning —
  // all correct, together heavy. The numbers are the product; ONE note rides along,
  // picked by priority: health warning > junk > coach remark > shelf swap > protein
  // gap > education > reinforcement. Everything else waits for its own moment.
  // proteinTip outranks the generic coach remark because it owns the "target hit ✅"
  // verdict (a milestone, i.e. data) — but a photo-path override remark stays on top.
  const addOn = [calorieFloorNote, junkNote, coachNoteOverride ? coachNote : "", proteinTip, coachNote, swapNote, eduNote, variableReinforcement]
    .find(s => s && s.trim()) || "";

  // PLAIN LEADS, NUMBERS SUPPORT (2026-07-14, the delivery decision): every food
  // reply now opens with a one-line, NUMBER-FREE human verdict — the thing a
  // grandmother or a 13-year-old reads and instantly gets — and the kcal/protein
  // detail sits below for the clients who want it (the Cal-AI crowd). One message,
  // three literacy levels, nobody asked or split. Number-free by design so it never
  // disturbs the kcal extractor or the low-numeracy reader.
  const verdictHeadline = (prevCals > 0 && runningTotalSane)
    ? (effectiveRemaining <= -100
        ? (isMuscleGain
            ? "🟢 Plenty of fuel in today — that's building material."
            : "🟡 That's your food for the day — anything else, keep it light (protein + veg).")
        : effectiveRemaining < 150
          ? "🟢 Right on track for today."
          : `🟢 Nicely done — still room for ${(mealsLeft || "a bit more").replace(/^room for /, "")} today.`)
    : "";
  const head = verdictHeadline ? `${verdictHeadline}\n\n` : "";

  // ADAPTIVE DELIVERY (2026-07-14): a client the bot has learned can't read numbers
  // gets a fully number-free reply — plain verdict + the food names + a words-only
  // protein nudge. No kcal, no gram figures, nothing to work out. The numbers still
  // exist (logged, on the dashboard, in the totals the bot reasons over) — they're
  // just not put in front of a person who told us they don't understand them.
  if (getNumbersMode(user) === "low") {
    const plainHead = verdictHeadline || "🟢 Logged — nice one.";
    const nudge = plainProteinNudge({ proteinRemaining, isMuscleGain, hasGoodProteins: !!hasGoodProteins });
    const foods = stripFoodLineNumbers(foodLines);
    return `${gentlePrefix}${plainHead}\n\n*Logged ✅*\n${foods}\n\n${nudge}[BUTTONS:My progress|Today's workout]`;
  }

  return `${gentlePrefix}${head}*Food logged ✅*\n\n${foodLines}\n\n*${mealLabel}: ~${totalMealCals} kcal | ~${Math.round(totalMealProtein)}g protein*\n${runningLine}${dayAssessment}${addOn}[BUTTONS:My progress|Today's workout]`;
}

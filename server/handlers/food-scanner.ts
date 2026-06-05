import { SA_FOODS_SEED, type SAFood } from "../foods";
import { enforceCoachGuardrails } from "../coach-guardrails";
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
  if (/\b(zero[\s-]?sugar|sugar[\s-]?free|sugarfree|no[\s-]?sugar|no[\s-]?cal|zero[\s-]?cal|diet)\b/i.test(lower)) return true;
  // "<drink> zero" or "zero <drink>" — e.g. "red bull zero", "zero coke"
  const drinkWords = "coke|cola|pepsi|sprite|fanta|stoney|sparletta|powerade|energade|lucozade|monster|red\\s?bull|redbull|energy|cool\\s?drink|cooldrink|soda";
  if (new RegExp(`\\b(?:${drinkWords})\\b[\\w\\s]{0,12}\\bzero\\b`, "i").test(lower)) return true;
  if (new RegExp(`\\bzero\\b[\\w\\s]{0,12}\\b(?:${drinkWords})\\b`, "i").test(lower)) return true;
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
      if (!out.some(o => o.name === zeroEntry.name)) out.push(zeroEntry);
    } else {
      out.push(f);
    }
  }
  return changed ? out : foods;
}

export function scanForSAFoods(msg: string): SAFood[] {
  const lower = msg.toLowerCase();
  const matched: SAFood[] = [];

  // PASS 1: Exact word-boundary matching (fast, preferred)
  const matchedWithAlias: { food: SAFood; alias: string }[] = [];
  for (const food of SA_FOODS_SEED) {
    const allAliases = [food.name.toLowerCase(), ...food.aliases.map(a => a.toLowerCase())];
    let longestHit = "";
    for (const alias of allAliases) {
      const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, "i");
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
  // No category restriction — "butter" inside "peanut butter" is dominated regardless of category
  for (const entry of deduped) {
    const dominated = deduped.some(other =>
      other.food.name !== entry.food.name &&
      other.alias.length > entry.alias.length &&
      other.alias.includes(entry.alias)
    );
    if (!dominated) matched.push(entry.food);
  }

  // PASS 2: Fuzzy matching (only if exact found nothing)
  if (matched.length > 0) return redirectSugarFreeDrinks(matched, lower);

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

  // PASS 3: Combo meal dedup — if a combo meal matched, remove standalone components
  const COMBO_OVERRIDES: Record<string, string[]> = {
    "Pasta bolognaise": ["Pasta (spaghetti)", "Beef mince"],
    "Chicken stir-fry with rice": ["Chicken breast", "Chicken thigh", "Brown rice", "White rice"],
    "Chicken and rice": ["Chicken breast", "Chicken thigh", "Brown rice", "White rice"],
    "Eggs on toast": ["Eggs", "Brown bread", "White bread"],
    "Pap and stew": ["Pap (stiff maize porridge)", "Stewing beef"],
    "Pap and wors": ["Pap (stiff maize porridge)", "Boerewors"],
    "Chicken curry and rice": ["Chicken thigh", "Chicken breast", "Brown rice", "White rice"],
    "Mince and pap": ["Beef mince", "Pap (stiff maize porridge)"],
    "Boerewors roll": ["Boerewors", "Brown bread", "White bread"],
    "Peanut butter on bread": ["Peanut butter", "Peanut butter (smooth)", "Brown bread", "White bread"],
    "Chicken and pap": ["Chicken breast", "Chicken thigh", "Pap (stiff maize porridge)"],
    "Fish and chips": ["Hake (frozen, battered)", "Chips (slap chips)"],
    "Pap and pilchards": ["Pap (stiff maize porridge)", "Pilchards in tomato sauce"],
    "Pap and spinach": ["Pap (stiff maize porridge)", "Spinach", "Morogo (wild spinach)"],
    "Pilchards on toast": ["Pilchards in tomato sauce", "Brown bread", "White bread"],
    "Rice and beans": ["Brown rice", "White rice", "Sugar beans"],
    "Oats with milk": ["Oats (Jungle Oats)", "Full cream milk"],
    "Vetkoek with mince": ["Vetkoek", "Beef mince"],
    "Cereal with milk": ["Corn Flakes", "Full cream milk"],
  };

  const comboNames = matched.filter(f => COMBO_OVERRIDES[f.name]).map(f => f.name);
  if (comboNames.length > 0) {
    const toRemove = new Set<string>();
    for (const cn of comboNames) {
      for (const component of COMBO_OVERRIDES[cn]) toRemove.add(component);
    }
    return matched.filter(f => !toRemove.has(f.name));
  }

  // PASS 4: Alias collision cleanup
  const names = new Set(matched.map(f => f.name));
  let cleaned = [...matched];

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

  return redirectSugarFreeDrinks(cleaned, lower);
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

  const looksFoodLog = /\b(ate|had|have|having|eating|i had|i ate|breakfast|lunch|dinner|supper|snack|just had|just ate|meal was|food was)\b/i.test(userMessage);
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

  // Extra step burn: ~40 kcal per 1,000 steps beyond target
  const stepsTarget = user.stepsTarget || 8500;
  const todaySteps = p.todaySteps || 0;
  const extraStepsBurned = todaySteps > stepsTarget
    ? Math.round((todaySteps - stepsTarget) * 0.04)
    : 0;

  const effectiveRemaining = calRemaining + extraStepsBurned;
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
  const runningLine = prevCals > 0 && runningTotalSane
    ? `Running total today: ~${runningCals} kcal / ${calorieTarget} target${effectiveRemaining > 0 ? ` (${effectiveRemaining} remaining${stepsNote})` : effectiveRemaining >= -100 ? ` ✅ on target${stepsNote}` : ` · over by ~${Math.abs(effectiveRemaining)} kcal${stepsNote}`}`
    : prevCals > 0
    ? `Remaining today: ~${Math.max(0, effectiveRemaining)} kcal${stepsNote}`
    : `Remaining today: ~${Math.max(0, effectiveRemaining)} kcal${stepsNote}`;

  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

  let dayAssessment = "";
  if (prevCals > 0 && totalMealCals >= 100) {
    const hourNow = new Date(Date.now() + 2 * 3_600_000).getUTCHours();
    const dayProgress = Math.min(hourNow / 20, 1);
    const expectedCals = calorieTarget * dayProgress;
    const calPace = runningCals / Math.max(expectedCals, 1);
    if (calRemaining <= 0 && effectiveRemaining <= -100) {
      const overBy = Math.abs(effectiveRemaining);
      if (extraStepsBurned >= 80) {
        dayAssessment = `\n_Over on calories, but your step count offset ~${extraStepsBurned} kcal. Net surplus: ~${overBy} kcal. Keep dinner lean._`;
      } else if (overBy >= 800) {
        dayAssessment = `\n_⚠️ You're ~${overBy} kcal over your target. That's a significant surplus. No more food today — water only. One bad day doesn't break progress, but don't add to it._`;
      } else if (overBy >= 400) {
        dayAssessment = `\n_You're ${overBy} kcal over. Close the day now — no dinner, or at most a small protein and veg if you're hungry. Don't add to the surplus._`;
      } else {
        dayAssessment = `\n_${pick([
          "Calorie ceiling hit — final meal must be lean. Protein and veg only.",
          "Target reached. Close the day clean: protein and vegetables, nothing else.",
          "Done on calories. Dinner = lean protein + veg. No starch.",
          "Calorie cap hit. Last meal: grilled protein and greens — that's it.",
          "You've hit the limit. Strip dinner down to protein and vegetables only.",
        ])}_`;
      }
    } else if (calRemaining <= 0 && effectiveRemaining > -100) {
      dayAssessment = `\n_${pick([
        "Your steps covered the gap — net calories back on target. Keep last meal light.",
        "Movement offset the surplus. You're clean. Light protein for dinner.",
        "Walking got you back on track. Last meal: lean and light.",
        "Steps cancelled the overage — effectively on target. Finish with something lean.",
      ])}_`;
    } else if (!earlyInDay && calPace < 0.6 && effectiveRemaining < 600) {
      dayAssessment = `\n_${pick([
        "Solid pace. One high-protein meal closes the day.",
        "On track — finish it with a protein-heavy dinner.",
        "Good rhythm. One real protein meal left and you're done.",
        "Close. One more protein-first meal and the day is yours.",
        "Running well. Lock it in with a solid final meal.",
      ])}_`;
    } else if (!earlyInDay && calPace > 1.3) {
      dayAssessment = `\n_${pick([
        "Running over — strip dinner down. Protein only, no starch.",
        "Over pace. Last meal needs to be lean: protein and veg, nothing else.",
        "Calorie creep — make dinner strict. Protein and greens only.",
        "You're high for the pace. Final meal = lean protein and vegetables.",
        "Over budget. End it clean: grilled chicken, eggs, or fish with veg.",
      ])}_`;
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
  // get a clean one-liner acknowledgment — no protein coaching, no goal connection.
  // Threshold <= 5 kcal catches rounding artefacts (Coke Zero stored as 1 kcal).
  const isZeroCalDrink = totalMealCals <= 5 && totalMealProtein === 0;
  if (isZeroCalDrink) {
    const zeroCalLines = [
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
      const protCloser = proteinRemaining > 0
        ? pick([
            `${Math.round(proteinRemaining)}g protein still needed today.`,
            `${Math.round(proteinRemaining)}g left to hit your target.`,
            `${Math.round(proteinRemaining)}g more to go today.`,
          ])
        : pick(["Protein target hit for today. ✅", "Daily protein done. ✅", "Protein goal complete. ✅"]);
      coachNote = `\n\n${protOpener} ${protCloser}`;
    } else if (hasGoodProteins && totalMealProtein >= 10) {
      coachNote = `\n\n${pick([
        `${Math.round(totalMealProtein)}g protein this meal — close. Push for 20g+ next meal.`,
        `${Math.round(totalMealProtein)}g protein — good start. 20g+ per meal is the target.`,
        `Getting there — ${Math.round(totalMealProtein)}g this meal. Aim for 20g+ each time.`,
        `${Math.round(totalMealProtein)}g in. Almost there — push for 20g+ at the next one.`,
      ])}`;
    } else if (!hasGoodProteins && hasCarbs && !isFruitSnack
        && !earlyInDay
        && proteinRemaining > proteinTarget * 0.35) {
      // Only nag about protein if: it's past the first meal of the day AND they're
      // genuinely behind (>35% of daily target still outstanding). Stops constant
      // protein lectures on breakfast oats, lunch rice, etc.
      coachNote = `\n\n${pick([
        "Carbs without protein — fix it next meal. Add eggs, chicken, or legumes.",
        "No protein this meal — balance it next time with a real protein source.",
        "Carb-heavy. Pair the next meal with protein to keep your total on track.",
        "Protein gap — sort it next meal. Eggs, chicken, or tinned fish.",
      ])}`;
    } else if (!hasGoodProteins && !hasCarbs && junkNoteText
        && proteinRemaining > proteinTarget * 0.35) {
      coachNote = `\n\n${pick([
        "Next meal needs protein. Pick one: eggs, chicken, or tuna.",
        "Sort protein next meal — eggs or canned fish are the fastest fix.",
        "Protein is low. Eggs, chicken, or something real at the next meal.",
        "Get protein in next meal — eggs, tinned tuna, or grilled chicken.",
      ])}`;
    }
  }

  const junkNote = junkNoteText ? `\n\n${junkNoteText}` : "";

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
    const evnHour = new Date().getUTCHours() + 2;
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

  let variableReinforcement = "";
  if (Math.random() < 0.18) {
    const fn = (user.name || "").split(" ")[0] || "Sharp";
    const daysSinceStart = user.programmeStartDate
      ? Math.floor((Date.now() - new Date(user.programmeStartDate).getTime()) / 86_400_000)
      : 0;
    const isMuscleBuild = goal === "muscle_gain";
    const NOTES = [
      `\n\n👀 _Coach K noticed: you're logging consistently. That's what separates the people who change from the people who try._`,
      `\n\n⚡ _${daysSinceStart > 7 ? `Day ${daysSinceStart} in` : "Early days"}. Most people have already quit by now. You're still here._`,
      `\n\n🎯 _${fn}, one logged meal won't change your body. Fifty of them will. You're building the right habit._`,
      `\n\n💡 _Consistent food logging is the single highest-predictor habit in body transformation. You're doing the one thing that matters most._`,
      `\n\n🔒 _${fn}, this habit is more valuable than any supplement or gym programme. Keep locking it in._`,
      `\n\n📊 _Coach K sees everything you log. The picture builds over time — keep feeding it._`,
      `\n\n🧠 _${fn}, nobody is doing this for you. That's exactly what makes it count._`,
      isMuscleBuild
        ? `\n\n💪 _Protein tracking is your edge, ${fn}. Most people guess. You know._`
        : `\n\n🔥 _${fn}, you're creating the calorie deficit meal by meal. This is how it works._`,
      `\n\n⏱ _${fn}, the gap between who you are and who you want to be closes one logged meal at a time._`,
      `\n\n✅ _Every time you log instead of guessing, you're making a decision that adds up._`,
    ];
    variableReinforcement = pick(NOTES);
  }

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

  return `*Food logged ✅*\n\n${foodLines}\n\n*${mealLabel}: ~${totalMealCals} kcal | ~${Math.round(totalMealProtein)}g protein*\n${runningLine}${dayAssessment}${coachNote}${junkNote}${proteinTip}${variableReinforcement}${calorieFloorNote}`;
}

import { SA_FOODS_SEED, type SAFood } from "../foods";
import { enforceCoachGuardrails } from "../coach-guardrails";
import { db } from "../db";
import { mealLogs, chatHistory } from "../../shared/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import { sastDayStart } from "../utils";

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
  if (matched.length > 0) return matched;

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

  return cleaned;
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
    return { calories: mealLogSum.calories || 0, protein: mealLogSum.protein || 0 };
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
  return { calories, protein };
}

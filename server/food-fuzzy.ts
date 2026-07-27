/**
 * FOOD FUZZY-MATCH SUPPORT — the edit-distance machinery and, more importantly, the list of
 * ordinary English words that must NEVER be mistaken for food.
 *
 * (2026-07-27 live.) A client asked a real coaching question — "can't eat anymore today, what
 * does that mean for my goal? General health. Teach me" — and got back a fruit swap list titled
 * "Swaps for Peach". "Teach" is one edit away from "Peach", so the fuzzy matcher claimed it.
 *
 * That is the whole reason this blacklist exists and the whole reason it must keep growing:
 * fuzzy matching food names against everyday speech will always produce these collisions, so
 * the defence is a hard list plus callers passing `exactOnly` whenever a match drives an
 * action. Pure — no DB, no model. Unit-tested.
 */

export function levenshtein(a: string, b: string): number {
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
export function maxDistance(wordLen: number): number {
  if (wordLen <= 4) return 0;
  if (wordLen <= 6) return 1;
  if (wordLen <= 10) return 2;
  return 2;
}

export const FUZZY_BLACKLIST = new Set([
  "just", "had", "have", "having", "that", "this", "with", "from", "for",
  "what", "when", "where", "which", "about", "after", "before", "been",
  "would", "could", "should", "want", "need", "like", "make", "made",
  "take", "took", "give", "gave", "come", "came", "going", "went",
  "here", "there", "then", "than", "them", "they", "their", "your",
  "more", "some", "much", "many", "very", "also", "still", "well", "good",
  "feel", "feeling", "today", "yesterday", "morning",
  "afternoon", "evening", "night", "breakfast", "lunch", "dinner",
  "supper", "snack", "meal", "food", "total", "remaining", "calories",
  "protein", "daily", "target", "please", "thanks", "thank", "help",
  "read", "again", "true", "adjust", "correct", "wrong", "right",
  "better", "everything", "nothing", "something", "doing", "being",
  "getting", "looking", "working", "trying", "never", "always",
  "start", "stop", "keep", "send", "show", "tell", "look", "work",
  "think", "know", "really", "thing", "things", "stuff", "great",
  "terrible", "horrible", "broken", "fixed", "update", "check",
  // Non-food words that fuzzy-match real foods ("past" → "pasta", "teach" → "peach")
  "teach", "reach", "coach", "beach", "preach", "each",
  "past", "days", "havent", "trained", "training", "three", "down",
  "flat", "week", "weeks", "month", "months", "year", "years",
  "motivated", "motivation", "unmotivated", "struggling", "struggle",
  "missed", "missing", "lately", "recently", "done", "gone",
]);

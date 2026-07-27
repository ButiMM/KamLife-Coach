/**
 * FOOD NAMING — never tell a client they ate something they didn't say they ate.
 *
 * (2026-07-27 live.) Kam logged "Dinner / Rice / Tin fish / Lentils". The reply came back
 * "Logged: Brown rice, Pilchards in tomato sauce, Lentils". He never said brown. He never
 * said pilchards. He corrected it — "The rice was white not brown" — and the coach replied
 * "nothing removed", which was an answer to a question he had not asked.
 *
 * The cause is in the alias tables: `foods.ts` maps the bare word "rice" onto *Brown rice*
 * and "tin fish" onto *Pilchards in tomato sauce*. The matcher then prints the entry's name
 * as if the client had said it. That is a fabrication of detail, and it is corrosive in a way
 * a wrong calorie number is not: the client knows what they ate, so being told otherwise
 * proves the coach isn't listening.
 *
 * This rule ALREADY EXISTED — for one food. food-scanner.ts carries a special case keeping a
 * client's drink brand instead of renaming it "Diet Coke / Coke Zero", with the comment
 * "renames the client's drink — keep their brand". It was never generalised. This module is
 * that generalisation: if the matched entry is more specific than the client's own words, the
 * client's words win for DISPLAY, while the entry still supplies the numbers.
 *
 * Pure — no DB, no model. Unit-tested.
 */

/**
 * Qualifiers that make an entry name more specific than a generic term. Each is a real
 * distinction a client can make and often doesn't — so when THEY didn't make it, we must
 * not make it for them.
 */
const VARIANT_QUALIFIERS = [
  "brown", "white", "wholewheat", "whole wheat", "wholegrain", "whole grain", "seed loaf",
  "low fat", "low-fat", "fat free", "fat-free", "full cream", "full-cream", "skim", "skimmed",
  "in tomato sauce", "in oil", "in brine", "in water", "in syrup",
  "skinless", "lean", "extra lean", "fried", "grilled", "roasted", "boiled", "steamed",
  "diet", "zero", "sugar free", "sugar-free", "light", "double thick", "plain",
];

/** Normalise for comparison — lowercase, collapse whitespace, drop punctuation. */
function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Which qualifiers does the entry name carry that the client's own words do not?
 * Empty means the entry says nothing the client didn't say — the name is safe to print.
 */
export function inventedQualifiers(clientWords: string, entryName: string): string[] {
  const client = norm(clientWords);
  const entry = norm(entryName);
  return VARIANT_QUALIFIERS.filter(q => {
    const nq = norm(q);
    return entry.includes(nq) && !client.includes(nq);
  });
}

/**
 * The name to SHOW the client for a matched food.
 *
 * When the entry invents a distinction the client never made, show the client's own words
 * back to them (title-cased). Otherwise show the entry name — it carries the useful detail
 * and, when the client did say "brown rice", it IS their words.
 *
 * The nutrition numbers are untouched either way: this decides wording, never maths.
 */
export function displayFoodName(clientWords: string, entryName: string): string {
  const invented = inventedQualifiers(clientWords, entryName);
  if (invented.length === 0) return entryName;

  const words = (clientWords || "").trim();
  if (!words) return entryName;

  // Title-case the client's phrase the way the rest of the log is cased ("tin fish" → "Tin fish").
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/**
 * A one-line note when a real ambiguity was resolved by assumption, so the client can correct
 * it in the same breath instead of discovering it on a card three meals later. Only fires for
 * distinctions that MOVE THE NUMBERS — brown vs white rice is ~5 kcal/100g and not worth a
 * line; pilchards in oil vs tomato sauce is ~130 kcal a tin and very much is.
 */
const NUMBERS_MOVING = /\b(in oil|in brine|in syrup|full cream|fried)\b/i;

export function assumptionNote(pairs: Array<{ clientWords: string; entryName: string }>): string {
  const notable = pairs.filter(p =>
    inventedQualifiers(p.clientWords, p.entryName).some(q => NUMBERS_MOVING.test(q)),
  );
  if (notable.length === 0) return "";
  const first = notable[0];
  return `\n\n_Counted your ${first.clientWords.toLowerCase()} as ${first.entryName.toLowerCase()} — tell me if it was different and I'll fix it._`;
}

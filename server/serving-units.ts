/**
 * SERVING-UNIT RESOLUTION for count corrections — pure, unit-tested.
 *
 * (2026-07-23, Kam live bug) A photo logged "Toast, boiled eggs, viennas". The client then
 * said "there were 3 slices, not 2 — put in the right macros." The quantity-correction path
 * searched the meal for the literal word "slice", found none (the meal is labelled "Toast"),
 * and dead-ended: "I don't see slices in today's log to correct" — seconds after logging it.
 * Two gaps: (1) a client names food by its SERVING UNIT ("slice" for bread/toast), and
 * (2) photo meals store no per-item macros, so there is nothing to scale — yet a ±1 count
 * change has an obvious, honest answer: add or remove ONE serving's worth.
 *
 * This module does exactly those two jobs and nothing else. It never rescales a whole meal
 * (that would corrupt the other foods on the plate) — corrections apply an INCREMENTAL delta.
 */

// A correction's food word → the alias terms to look for in a meal's label/text. A serving
// unit ("slice") resolves to the foods it is a unit OF ("bread", "toast", …) so the matcher
// finds the meal even when it is named by the food, not the unit.
const UNIT_ALIASES: Record<string, string[]> = {
  slice: ["bread", "toast", "loaf", "roll", "sandwich", "slice"],
  piece: ["piece"],
  scoop: ["protein", "shake", "whey", "oats", "scoop"],
  glass: ["milk", "juice", "amasi", "maas", "glass"],
  cup: ["rice", "pap", "oats", "porridge", "samp", "cup"],
  spoon: ["sugar", "peanut butter", "spoon"],
  rasher: ["bacon", "rasher"],
};

// Per-serving kcal/protein for foods a client counts. Deliberately conservative SA portions.
// Used ONLY to adjust a meal by a small delta (±1–2 servings) when we have no per-item
// breakdown — never to build a meal from scratch.
const PER_SERVING: Array<{ re: RegExp; kcal: number; protein: number }> = [
  { re: /\b(slice|toast|bread|roll|loaf)\b/, kcal: 75, protein: 3 },
  { re: /\b(egg)\b/, kcal: 78, protein: 6 },
  { re: /\b(vienna|banger|boerewors|wors|sausage)\b/, kcal: 90, protein: 5 },
  { re: /\b(rasher|bacon)\b/, kcal: 45, protein: 3 },
  { re: /\b(scoop|whey|protein shake)\b/, kcal: 120, protein: 22 },
  { re: /\b(weetbix|weet-bix|biscuit)\b/, kcal: 60, protein: 2 },
  { re: /\b(banana|apple|orange|naartjie|fruit)\b/, kcal: 90, protein: 1 },
];

// Normalise a correction's food word to its singular stem (drop a trailing "s").
// Only the "s" — "slices" → "slice", not "slic" — so alias/portion lookups key correctly.
export function singularFood(food: string): string {
  return (food || "").trim().toLowerCase().replace(/s$/, "");
}

// The terms to search a meal's text for, given the correction's food word. Always includes
// the word itself and its singular; a serving unit also contributes the foods it measures.
export function foodMatchTerms(food: string): string[] {
  const f = (food || "").trim().toLowerCase();
  const singular = singularFood(f);
  const terms = new Set<string>([f, singular].filter(Boolean));
  const aliases = UNIT_ALIASES[singular] || UNIT_ALIASES[f];
  if (aliases) for (const a of aliases) terms.add(a);
  return [...terms];
}

// True if any of the correction's match-terms appears in the meal's searchable text.
export function foodMatchesText(food: string, text: string | null | undefined): boolean {
  const hay = (text || "").toLowerCase();
  if (!hay) return false;
  return foodMatchTerms(food).some(t => t.length >= 2 && hay.includes(t));
}

// Per-serving estimate for the corrected food, or null if we have no sensible portion for it.
// Probes both the raw word and its singular so plurals ("slices") match a singular pattern.
export function perServingEstimate(food: string): { kcal: number; protein: number } | null {
  const probe = `${(food || "").toLowerCase()} ${singularFood(food)}`;
  for (const p of PER_SERVING) if (p.re.test(probe)) return { kcal: p.kcal, protein: p.protein };
  return null;
}

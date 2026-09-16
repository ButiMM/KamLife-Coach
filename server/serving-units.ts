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

// VISION ITEMS — parse per-item lines out of a food-photo analysis ("Toast (~2 slices): 150
// kcal, 6g protein") into structured items. Photo meals used to store items: [] — so "my
// meals" showed "Food photo" and a correction ("2 slices not 3") had no item to scale
// (2026-07-23). Best-effort: unparseable lines are skipped, never guessed.
export function itemsFromVisionText(text: string): Array<{ name: string; grams: number; kcal: number; protein: number; category: string }> {
  const out: Array<{ name: string; grams: number; kcal: number; protein: number; category: string }> = [];
  for (const line of (text || "").split("\n")) {
    const l = line.trim();
    if (!l || /^total\b/i.test(l)) continue;
    const m = l.match(/^[-•*\s]*([A-Za-z][^:–—]{1,50}?)\s*(?:\(([^)]*)\))?\s*[:–—]\s*[~≈]?\s*(\d[\d,]*)\s*kcal(?:.*?(\d+)\s*g\s*protein)?/i);
    if (!m) continue;
    const name = m[1].replace(/[*_]/g, "").trim();
    if (!name || name.length > 50) continue;
    const grams = (() => { const g = (m[2] || "").match(/(\d+)\s*(?:g|ml)\b/i); return g ? parseInt(g[1], 10) : 0; })();
    out.push({ name, grams, kcal: parseInt(m[3].replace(/,/g, ""), 10) || 0, protein: m[4] ? parseInt(m[4], 10) : 0, category: "photo" });
  }
  return out.slice(0, 12);
}

/**
 * THE PHOTO TOTAL IS EVIDENCE, NOT A SECOND LEDGER (C11, 2026-09-16).
 *
 * Every photo write took its meal total from the vision model's "TOTAL: N kcal" line and its items
 * from the per-item lines — two independent numbers from one reply, with nothing reconciling them.
 * The governing contract for food truth is that meal calories EQUAL the sum of their persisted
 * item calories, so a photo row could contradict its own items and no reader could tell which was
 * true. Worse, when no item line parsed, the row stored a total with an EMPTY items array: a
 * calorie figure with no evidence behind it at all, which is precisely the shape the ledger exists
 * to prevent.
 *
 * The rule here is the contract, applied once:
 *
 *   · items parsed  → the meal total IS their sum. The model's TOTAL is a cross-check, and a
 *                     disagreement is logged rather than silently preferred.
 *   · none parsed   → the model's total survives as ONE item standing for the whole plate, so the
 *                     sum still equals the total and the row still says where its number came from.
 *   · neither       → nothing to write.
 *
 * This does not price food and does not second-guess the model's arithmetic; it decides which of
 * two numbers the model already produced is the record. That is a reconciliation, not an engine.
 */
export function reconcileVisionMeal(
  text: string,
  statedKcal: number,
  statedProtein: number,
): { items: Array<{ name: string; grams: number; kcal: number; protein: number; category: string }>; kcalInt: number; proteinInt: number } {
  const items = itemsFromVisionText(text);
  const priced = items.filter(i => (i.kcal || 0) > 0);
  if (priced.length > 0) {
    const kcal = priced.reduce((s, i) => s + (i.kcal || 0), 0);
    const protein = priced.reduce((s, i) => s + (i.protein || 0), 0);
    if (statedKcal > 0 && Math.abs(statedKcal - kcal) > Math.max(25, kcal * 0.1)) {
      console.warn(`[PHOTO_TOTAL_DISAGREES] model said ${statedKcal} kcal, its own items sum to ${kcal} — items win`);
    }
    return { items: priced, kcalInt: kcal, proteinInt: protein };
  }
  if (statedKcal > 0 || statedProtein > 0) {
    return {
      items: [{ name: "Photographed meal", grams: 0, kcal: statedKcal, protein: statedProtein, category: "photo" }],
      kcalInt: statedKcal,
      proteinInt: statedProtein,
    };
  }
  return { items: [], kcalInt: 0, proteinInt: 0 };
}

// Per-serving estimate for the corrected food, or null if we have no sensible portion for it.
// Probes both the raw word and its singular so plurals ("slices") match a singular pattern.
export function perServingEstimate(food: string): { kcal: number; protein: number } | null {
  const probe = `${(food || "").toLowerCase()} ${singularFood(food)}`;
  for (const p of PER_SERVING) if (p.re.test(probe)) return { kcal: p.kcal, protein: p.protein };
  return null;
}

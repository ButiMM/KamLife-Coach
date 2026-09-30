/**
 * ADAPTIVE PORTION LEARNING (2026-07-17 — Review #7's flagship recommendation, built
 * on the founder's direct order: "let's build them"). The static SA food table knows
 * what "pap" typically is; it cannot know what pap is FOR THIS CLIENT. Their own logs
 * do: after 3+ logged portions of a food, the client's MEDIAN logged portion replaces
 * the table default whenever they don't state an amount. Every log — and every
 * correction, which updates item kcal in place — makes the next inference better.
 *
 * Fail-open by design: no history → static default, exactly as before. Clamped to
 * 0.5×–3× of the table default so one weird log or a mis-scaled correction can never
 * poison the personal portion. Explicit statements ("3 eggs", "half a plate") always
 * win — memory only fills silence, never overrides speech.
 */

import { db } from "./db";
import { mealLogs } from "../shared/schema";
import { eq, and, gte, desc } from "drizzle-orm";
import { type SAFood } from "./foods";
import { escapeRegex, portionDefaultCount } from "./handlers/food-scanner";
// One owner for word->digit, in the shared pure module (C11) — parseQuantityCorrection needs it too.
import { normaliseWordNumbers } from "./utils";

export type PortionStat = { kcal: number; protein: number; n: number };
type ItemRow = Array<{ name?: string; foodName?: string; kcal?: number; protein?: number }> | null;

// "Chicken breast (grilled)" and "chicken breast" must share one history.
export function normalizeFoodKey(name: string): string {
  return (name || "").toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Pure: per-food median portion from raw meal-log item arrays. ≥3 logs to qualify. */
export function medianPortions(itemRows: ItemRow[]): Map<string, PortionStat> {
  const byFood = new Map<string, { kcals: number[]; prots: number[] }>();
  for (const items of itemRows) {
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const key = normalizeFoodKey(it.name || it.foodName || "");
      if (!key || typeof it.kcal !== "number" || it.kcal <= 0) continue;
      const e = byFood.get(key) || { kcals: [], prots: [] };
      e.kcals.push(it.kcal);
      e.prots.push(typeof it.protein === "number" ? it.protein : 0);
      byFood.set(key, e);
    }
  }
  const med = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };
  const out = new Map<string, PortionStat>();
  for (const [k, v] of byFood) {
    if (v.kcals.length < 3) continue; // too little history to trust — table default stands
    out.set(k, { kcal: med(v.kcals), protein: med(v.prots), n: v.kcals.length });
  }
  return out;
}

/**
 * Pure: the portion to log for a food when the client stated NO amount. Personal
 * median (clamped to 0.5×–3× of the table default) when history qualifies; the
 * static default otherwise. Protein scales with the kcal ratio so the food's macro
 * shape survives the resize.
 */
export function personalPortionFor(
  memory: Map<string, PortionStat>, foodName: string, staticKcal: number, staticProtein: number,
): { kcal: number; protein: number; personal: boolean } {
  const p = memory.get(normalizeFoodKey(foodName));
  if (!p || staticKcal <= 0) return { kcal: staticKcal, protein: staticProtein, personal: false };
  const kcal = Math.round(Math.min(Math.max(p.kcal, staticKcal * 0.5), staticKcal * 3));
  if (kcal === Math.round(staticKcal)) return { kcal: staticKcal, protein: staticProtein, personal: false };
  const protein = Math.round(staticProtein * (kcal / staticKcal));
  return { kcal, protein, personal: true };
}

// 60s per-user cache: one history query per logging burst, not per matched food.
const _cache = new Map<string, { at: number; map: Map<string, PortionStat> }>();
const CACHE_TTL_MS = 60_000;

/** Invalidate after any meal insert/correction so the next log learns immediately. */
export function invalidatePortionMemory(userId: string): void {
  _cache.delete(userId);
}

export async function getPortionMemory(userId: string): Promise<Map<string, PortionStat>> {
  try {
    const c = _cache.get(userId);
    if (c && Date.now() - c.at < CACHE_TTL_MS) return c.map;
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
    const rows = await db.select({ items: mealLogs.items }).from(mealLogs)
      .where(and(eq(mealLogs.userId, userId), gte(mealLogs.loggedAt, ninetyDaysAgo)))
      .orderBy(desc(mealLogs.loggedAt))
      .limit(200);
    const map = medianPortions(rows.map(r => r.items as ItemRow));
    if (_cache.size > 2000) _cache.clear();
    _cache.set(userId, { at: Date.now(), map });
    return map;
  } catch (e) {
    console.warn("[PORTION_MEMORY] non-fatal:", (e as Error)?.message);
    return new Map(); // fail-open: static defaults
  }
}

// ── PERSONAL MEAL-SLOT LEARNING — REMOVED (Cut 2, 2026-09-11) ───────────────────────────────
//
// `dominantSlotByHour`, `resolveInferredSlot` and `getSlotContext` stood here. They learned which
// meal a client "usually" has at a given SAST hour and applied it to a message that named no meal
// at all — then demoted the next light plate to "snack" because the slot they had inferred for an
// earlier one was already taken. Both answers were written to meal_logs.meal_label as facts.
//
// The whole apparatus existed to make a clock-derived guess sharper. Cut 2 removes the guess: when
// the client does not name a meal, the label is null. A better-informed invention is still an
// invention, so there is nothing left here to sharpen, and this is deleted rather than left
// unreachable for the next caller to rediscover.
//
// PORTION memory below is untouched — it answers a different question ("how much is a spoon of pap
// FOR THIS CLIENT?") from the client's own corrected logs, and it never names a meal.

// ── PORTION UNITS: what does "2 spoons of pap" actually mean? ────────────────────────────────
// (2026-08-13, measured: "2 spoons of pap" logged 660 kcal — roughly five times the truth, and
// stamped as database-verified.) The parser matched `(\d+)\s+\w+s?\s+of\s+<food>` and treated
// EVERY unit as a whole portion, on the reasoning that "N <word> of <food> almost always means N
// portions". True of plates and bowls. Badly false of spoons, handfuls and bites, which are a
// FRACTION of a portion — so a modest plate of pap became five.
//
// Units are not all the same kind of thing, and collapsing them is the bug:
//   measurement  tablespoon, cup, gram — a real unit; the food's own portion count decides
//   full         plate, bowl, serving  — one portion each
//   count        piece, slice, packet  — one item each; the food's portion count decides
//   fractional   spoon, handful, bite  — a PART of a portion, and the amount is our estimate
//   unknown      "3 stashes of bread"  — speech-to-text noise. Never multiply on a word we
//                do not know: one conservative portion, flagged as estimated.

export type UnitClass = "measurement" | "full" | "count" | "fractional" | "unknown";

/**
 * CONSERVATIVE ENGINEERING PRIORS, NOT PHYSICAL CONSTANTS. A spoon of pap and a spoon of peanut
 * butter are not the same mass, and nothing here pretends otherwise — these are deliberately
 * low first guesses for an inherently vague word, chosen so the system under-counts rather than
 * inflating someone's intake. They are adjustable, and portion-memory above is the path to
 * replacing them with what a given client's logs actually show.
 */
export const UNIT_FRACTIONS: Record<string, number> = {
  spoon: 0.15, spoons: 0.15, spoonful: 0.15, spoonfuls: 0.15,
  handful: 0.3, handfuls: 0.3, scoop: 0.5, scoops: 0.5,
  bite: 0.1, bites: 0.1, mouthful: 0.1, mouthfuls: 0.1,
  forkful: 0.1, forkfuls: 0.1, sip: 0.05, sips: 0.05,
  pinch: 0.02, pinches: 0.02, dollop: 0.15, dollops: 0.15,
};

/** Units roughly the size of a snack portion — see the guard in classifyPortionUnit. */
const HANDFUL_SIZED = new Set(["handful", "handfuls", "scoop", "scoops", "pack", "packs", "packet", "packets"]);

const MEASUREMENT_UNITS = new Set(["tablespoon", "tablespoons", "tbsp", "teaspoon", "teaspoons", "tsp",
  "cup", "cups", "gram", "grams", "g", "kg", "ml", "litre", "litres", "liter", "liters", "l", "glass", "glasses"]);
const FULL_UNITS = new Set(["plate", "plates", "bowl", "bowls", "portion", "portions",
  "serving", "servings", "helping", "helpings", "dish", "dishes"]);
const COUNT_UNITS = new Set(["piece", "pieces", "slice", "slices", "packet", "packets", "pack", "packs",
  "tin", "tins", "can", "cans", "bar", "bars", "biscuit", "biscuits", "roti", "rotis",
  "egg", "eggs", "wing", "wings", "drumstick", "drumsticks", "ball", "balls"]);

export interface PortionUnit {
  cls: UnitClass;
  /** Multiplier on ONE canonical portion. Null when the food's own portion count decides. */
  fraction: number | null;
  /** True when WE interpreted the amount rather than the client measuring it. Drives provenance:
   *  the food's identity can be database-verified while its quantity is a guess. */
  estimated: boolean;
}

/**
 * Classify a unit word against a specific food. THE FOOD MATTERS: peanuts are stored with a
 * canonical portion of "1 handful (30g)", so a handful of peanuts is one portion, not 0.3 of
 * one. When the food's own portion description names the unit, that unit IS the portion — which
 * is the whole reason these fractions are not a universal table.
 */
export function classifyPortionUnit(unit: string, portionDescription?: string, portionGrams?: number): PortionUnit {
  const u = (unit || "").toLowerCase().trim();
  if (!u) return { cls: "unknown", fraction: null, estimated: true };

  // The food's canonical portion is described in this very unit → recognised measurement.
  if (portionDescription && new RegExp(`\\b${u.replace(/s$/, "")}s?\\b`, "i").test(portionDescription)) {
    return { cls: "measurement", fraction: null, estimated: false };
  }
  // A HANDFUL OF A SNACK IS THE SNACK. When the canonical portion is already snack-sized, a
  // handful or a scoop IS roughly that portion — 0.3 of 30g of peanuts is 9g, which is not a
  // handful of anything. Undercounting is not the safe direction either: it makes a client look
  // more adherent than they are, and the adaptive engine then trims a target they were missing.
  // Food-aware, which is the point — the same word means different amounts of different foods.
  if (HANDFUL_SIZED.has(u) && typeof portionGrams === "number" && portionGrams > 0 && portionGrams <= 60) {
    return { cls: "measurement", fraction: null, estimated: false };
  }
  if (MEASUREMENT_UNITS.has(u)) return { cls: "measurement", fraction: null, estimated: false };
  if (FULL_UNITS.has(u)) return { cls: "full", fraction: 1, estimated: false };
  if (COUNT_UNITS.has(u)) return { cls: "count", fraction: null, estimated: false };
  if (u in UNIT_FRACTIONS) return { cls: "fractional", fraction: UNIT_FRACTIONS[u], estimated: true };
  // An unrecognised unit must NEVER multiply. "3 stashes of bread" is one portion of bread that
  // we are unsure about, not three loaves.
  return { cls: "unknown", fraction: 1, estimated: true };
}

// Scale EVERY number in a portion description by the quantity — count AND grams. "2 slices
// (60g)" ×2 becomes "4 slices (120g)"; grams contradicting the count destroy trust in all of them.
const SINGULAR_UNITS = new Set([
  "cup", "bowl", "scoop", "tablespoon", "teaspoon",
  "serving", "portion", "piece", "packet", "slice", "biscuit", "roti",
]);
export function scalePortionDescription(desc: string, quantity: number): string {
  if (quantity === 1) return desc;
  const scaled = desc.replace(/\d+(?:\.\d+)?/g, (n) => {
    const result = parseFloat(n) * quantity;
    return Number.isInteger(result) ? String(result) : String(Math.round(result * 10) / 10);
  });
  return scaled.replace(/(\d+(?:\.\d+)?)\s+([a-zA-Z]+)/g, (match, num, word) => {
    if (parseFloat(num) > 1 && SINGULAR_UNITS.has(word.toLowerCase())) {
      return `${num} ${word}s`;
    }
    return match;
  });
}

/**
 * A CORRECTED COUNT CHANGES EVERY NUMBER THE ITEM CLAIMS (C11 review, 2026-09-16).
 *
 * The quantity-correction path scaled an item's kcal and protein and wrote back everything else
 * untouched. So after logging one chicken breast and saying "two chicken breasts not one", the
 * persisted item held TWO breasts' calories while still stating `quantity: 1`, one breast's
 * grams, and a portion description reading "1 chicken breast (170g)" — a row that contradicts
 * itself, and the one place any surface could look to explain the number it shows.
 *
 * The whole point of C11's provenance fields is that an item's calories can be checked against
 * what it says it is. A scale that moves the calories and leaves the evidence behind destroys
 * exactly that, so the count's ratio applies to every quantity the item states. Fields the item
 * never had stay absent — this scales what is there, it does not invent provenance.
 *
 * portionSource becomes "explicit" because it now is: whatever we guessed at logging time, the
 * client has since stated the count in their own words.
 */
export function rescaleLedgerItem<T extends Record<string, any>>(item: T, ratio: number): T {
  const out: Record<string, any> = {
    ...item,
    kcal: Math.round((Number(item.kcal) || 0) * ratio),
    protein: Math.round((Number(item.protein) || 0) * ratio),
  };
  if (Number(item.grams) > 0) out.grams = Math.round(Number(item.grams) * ratio);
  if (Number(item.quantity) > 0) out.quantity = Math.round(Number(item.quantity) * ratio * 100) / 100;
  if (typeof item.portionDescription === "string" && item.portionDescription) {
    out.portionDescription = scalePortionDescription(item.portionDescription, ratio);
  }
  if (item.portionSource != null) out.portionSource = "explicit";
  return out as T;
}

/**
 * HOW MUCH DID THEY EAT (moved here from handlers/food-context.ts, 2026-09-03 — unchanged).
 *
 * The scanner answers WHICH foods a message names; this answers HOW MUCH of each, and that is
 * this file's subject. Everything it needs already lived here: classifyPortionUnit reads the unit
 * word, personalPortionFor supplies the learned portion when the client said no amount, and
 * scalePortionDescription writes the result back out. It sat in the food handler only because
 * that is where it was first called from — the handler now imports it like any other caller.
 */


/**
 * HOW THE FOOD WAS PREPARED, WHEN THE CLIENT SAYS SO (C11, 2026-09-16).
 *
 * "100g dry rice" and "100g cooked rice" are not the same food by calories — dry is roughly three
 * times cooked — and the ledger could not tell them apart because nothing read the word. It is
 * recorded here as the client's own claim and travels with the item; whether the numbers can be
 * computed from it is a separate question, and one this codebase answers by asking rather than
 * guessing when it cannot (see the basis conflict check in the food logger).
 *
 * Closed set, and deliberately small: these are preparation states that change a food's density,
 * not a vocabulary of cooking methods. "Grilled" and "fried" belong to identity, which the food
 * table already owns.
 */
const PREP_WORDS = "(?:cooked|uncooked|raw|dry|dried)";

/**
 * UNITS THAT NAME A FIXED AMOUNT, in grams (C11 review, 2026-09-16).
 *
 * Only units whose size is a constant belong here. A "cup", "glass", "plate" or "spoon" varies by
 * food and by hand, which is exactly what classifyPortionUnit and UNIT_FRACTIONS exist to judge —
 * so they are deliberately absent and keep going there. Volumes map to grams on the density-1
 * assumption this codebase already makes wherever it stores millilitres in a `grams` field.
 */
const MASS_UNIT_GRAMS: Record<string, number> = {
  g: 1, gram: 1, grams: 1, gr: 1, gm: 1,
  kg: 1000, kgs: 1000, kilo: 1000, kilos: 1000, kilogram: 1000, kilograms: 1000,
  ml: 1, mls: 1, millilitre: 1, millilitres: 1, milliliter: 1, milliliters: 1,
  l: 1000, litre: 1000, litres: 1000, liter: 1000, liters: 1000,
};
const PREP_RE = new RegExp(`\\b${PREP_WORDS}\\b`, "i");
/** The basis a food's canonical portion is expressed in, when its own description says. */
export function canonicalBasis(portionDescription?: string): string | null {
  const m = PREP_RE.exec(String(portionDescription || ""));
  return m ? m[0].toLowerCase() : null;
}
/** The basis the CLIENT stated somewhere in this text, read from their own words. */
export function statedBasis(text: string): string | null {
  const m = PREP_RE.exec(String(text || ""));
  return m ? m[0].toLowerCase() : null;
}

/**
 * THE BASIS THIS FOOD WAS GIVEN, NOT THE ONE THE SENTENCE HAPPENED TO CONTAIN (C11 review).
 *
 * The first cut read ONE basis per segment and copied it onto every food in it, so a perfectly
 * ordinary sentence — "cooked rice and raw chicken thigh" — recorded BOTH foods as cooked. Two
 * harms, and the second is the worse one: the chicken's persisted item states a preparation the
 * client never claimed about it, and basisConflict then cannot see the raw chicken at all,
 * because the field it reads has been overwritten with the rice's answer.
 *
 * A preparation word belongs to the food it is attached to. English attaches it adjacently, on
 * one side or the other — "raw chicken", "chicken, raw" — and only whitespace or a comma may sit
 * between. Anything looser ("chicken and cooked rice") is another food's basis and is not this
 * food's to claim, so this returns null and the item honestly records no basis.
 */
export function statedBasisFor(text: string, aliases: string[]): string | null {
  const t = String(text || "");
  for (const alias of aliases) {
    const a = escapeRegex(String(alias || "").toLowerCase());
    if (!a) continue;
    const before = new RegExp(`\\b(${PREP_WORDS})\\s+(?:${a})\\b`, "i").exec(t);
    if (before) return before[1].toLowerCase();
    const after = new RegExp(`\\b(?:${a})\\s*,?\\s+(${PREP_WORDS})\\b`, "i").exec(t);
    if (after) return after[1].toLowerCase();
  }
  return null;
}
/**
 * The first priced food whose stated basis its own canonical portion contradicts, or null.
 *
 * Narrow by construction: BOTH bases must be known and disagree. A client who names no basis, or
 * names the one the table already assumes ("100g cooked rice" against "1 cup cooked"), yields
 * null and logs exactly as before. Lives here because this is where basis is read and normalised;
 * what the caller DOES about a conflict is the food logger's business, not this file's.
 */
export function basisConflict(foods: any[]): any | null {
  return (foods || []).find((f: any) =>
    f?.statedBasis && f?.canonicalBasis && !sameBasis(f.statedBasis, f.canonicalBasis)) || null;
}

/** Two basis words that mean the same thing — "dry" and "dried", "uncooked" and "raw". */
export function sameBasis(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;                       // nothing stated → nothing conflicts
  const norm = (s: string) => (s === "dried" ? "dry" : s === "uncooked" ? "raw" : s);
  const x = norm(a), y = norm(b);
  if (x === y) return true;
  // Raw and dry are distinct claims about different food classes (raw meat, dry grain), but
  // neither is "cooked", so a conflict with cooked is what actually matters here.
  return false;
}

export function adjustFoodsForSegment(foods: SAFood[], segText: string, personal?: Map<string, PortionStat>) {
  const normText = normaliseWordNumbers(segText);
  // ONE FOOD, ONE BASIS WORD — the only case where an unattached preparation word is unambiguous.
  // "100g of rice, and it was cooked" names no second food to steal the claim from. With two
  // foods in the segment an unattached word belongs to whichever the client meant, and guessing
  // is how the chicken came to be recorded as cooked; there, statedBasisFor's null stands.
  const segPreps = new Set((segText.match(new RegExp(`\\b${PREP_WORDS}\\b`, "gi")) || []).map(w => w.toLowerCase()));
  const soleBasis = foods.length === 1 && segPreps.size === 1 ? statedBasis(segText) : null;

  // Portion-size modifier — "big plate of pap" → 1.5×, "half a portion" → 0.5×
  // Applied globally across all foods in the segment (whole meal was described as big/small).
  // A size word right before the FOOD counts too (#310, gate: "a large burger" was the same 650 kcal as "a small
  // burger"); "Big Mac" is a product and "large eggs" a grade, not a size.
  let sizeMultiplier = 1;
  if (/\b(big|large|huge|heaped|extra\s*large|xl|full\s*plate|loaded)\s+(?:plate|bowl|portion|serving|of\b|(?!mac\b|eggs?\b)[a-z])/i.test(normText)
    || /\b(double|extra\s+helping|extra\s+large\b)/i.test(normText)) {
    sizeMultiplier = 1.5;
  } else if (/\b(small|tiny|little|mini|quarter)\s+(?:plate|bowl|portion|serving|(?!bit\b|while\b|later\b)[a-z])/i.test(normText)
    || /\ba\s+(?:small|tiny|little)\s+bit\s+of\b/i.test(normText)
    || /\bsmall\s+amount\s+of\b/i.test(normText)) {
    sizeMultiplier = 0.7;
  } else if (/\b(?:half|halved)\s+(?:a\s+)?(?:plate|bowl|portion|serving|of\b)/i.test(normText)
    || /\b(?:half\s+(?:the\s+)?(?:pap|rice|pasta|meal|food)\b)/i.test(normText)) {
    sizeMultiplier = 0.5;
  }

  return foods.map(f => {
    const allAliases = [f.name.toLowerCase(), ...f.aliases.map(a => a.toLowerCase())];
    const foodBasis = statedBasisFor(segText, allAliases) || soleBasis;
    let quantity = 1;
    let explicitQty = false; // the client SAID an amount — memory never overrides speech
    let quantityEstimated = false; // WE interpreted the amount — identity can be db, quantity a guess
    let statedUnit: string | null = null;   // the client's own unit word, kept for the ledger (C11)
    for (const alias of allAliases) {
      const qtyDirect = normText.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+(?:${escapeRegex(alias)})`, "i"));
      // UNIT-AWARE (2026-08-13): capture the unit WORD and classify it — "2 plates", "2 tablespoons",
      // "2 pieces" and "2 spoons" are four different claims, and the old catch-all made all four N
      // whole portions, so "2 spoons of pap" logged 660 kcal. See classifyPortionUnit above.
      //
      // …AND A PREPARATION WORD BETWEEN THE UNIT AND THE FOOD NO LONGER DEFEATS IT (C11,
      // 2026-09-16). This allowed exactly ONE word between the number and the food, so "2 cups
      // COOKED rice" matched nothing at all and was logged as ONE cup — the client said two and
      // the record said one. `PREP_WORDS` is the closed set of basis words that legitimately sit
      // there; anything else still fails to match, because a wider gap is how "2 hours before
      // rice" would become a quantity.
      const qtyWithUnit = qtyDirect ? null : normText.match(new RegExp(
        `(\\d+(?:\\.\\d+)?)\\s+([a-z]+)\\s+(?:${PREP_WORDS}\\s+)?(?:of\\s+)?(?:${escapeRegex(alias)})`, "i"));
      const qtyBefore = qtyDirect || qtyWithUnit;
      if (qtyBefore) {
        explicitQty = true;
        if (qtyWithUnit) statedUnit = String(qtyWithUnit[2] || "").toLowerCase() || null;
        const userQty = parseFloat(qtyBefore[1]);
        const unit = qtyWithUnit ? classifyPortionUnit(qtyWithUnit[2], f.typicalPortionDescription, f.typicalPortionGrams) : null;
        // ── A WEIGHT IS NOT A SERVING COUNT (C11 review, 2026-09-16) ──────────────────────────
        //
        // "100 grams rice" divided 100 by the portion's serving COUNT (1) and logged ONE HUNDRED
        // portions — 22,000 kcal. "500 ml rice" logged 110,000. Measured on e53763b, so the bug
        // predates this branch; what this branch did was widen its reach, because admitting a
        // preparation word between the unit and the food pulled "100 grams COOKED rice" into the
        // same broken branch (220 kcal on e53763b, 22,000 here). Found by review, not by me.
        //
        // A mass or volume IS convertible, and the food table already holds what to convert
        // against: typicalPortionGrams. 100g of a 200g portion is half a portion, which is the
        // one reading that needs no guessing. Volumes are treated as grams — the density
        // assumption this codebase already makes wherever it stores ml in a `grams` field.
        //
        // Units with no fixed size (cup, glass, spoon, plate) are untouched: they keep going to
        // classifyPortionUnit, which is the owner that knows a handful of peanuts is one portion.
        const massGrams = statedUnit ? MASS_UNIT_GRAMS[statedUnit] : undefined;
        if (massGrams && (f.typicalPortionGrams || 0) > 0) {
          quantity = (userQty * massGrams) / f.typicalPortionGrams;
        } else if (unit && unit.fraction !== null) {
          quantity = unit.cls === "unknown" ? 1 : userQty * unit.fraction;  // never N portions
          if (unit.estimated) quantityEstimated = true;
        } else {
          const defaultQty = portionDefaultCount(f.typicalPortionDescription);
          if (userQty > 0 && defaultQty > 0 && userQty !== defaultQty) quantity = userQty / defaultQty;
        }
        break;
      }
    }
    // VAGUE PER-FOOD AMOUNT (2026-07-23 live: "half a Vienna" logged the 2-vienna default and
    // the client argued the log DOWN — trust killer). "Half a <food>" = 0.5 of ONE item vs the
    // portion's default count; "some/a few/a bit of <food>" = half the default. Lean LOW.
    // Skipped when a global size phrase already scaled the segment (no double-halving).
    let vagueQty = false;
    if (!explicitQty && sizeMultiplier === 1) {
      for (const alias of allAliases) {
        const a = escapeRegex(alias);
        // Match on the RAW text: normalisation rewrites "a"→"1", destroying "a bit of".
        const halfM = segText.match(new RegExp(`\\bhalf\\s+(?:a\\s+|an\\s+|the\\s+|of\\s+(?:a\\s+|the\\s+)?)?(?:${a})`, "i"));
        const vagueM = !halfM && segText.match(new RegExp(`\\b(?:some|a few|a couple(?:\\s+of)?|a bit of|a little(?:\\s+bit)?(?:\\s+of)?|a small piece of|a taste of)\\s+(?:${a})`, "i"));
        if (halfM) {
          quantity = 0.5 / Math.max(1, portionDefaultCount(f.typicalPortionDescription));
          vagueQty = true;
        } else if (vagueM) {
          quantity = 0.5;
          vagueQty = true;
        }
        if (vagueQty) break;
      }
    }
    quantity = quantity * sizeMultiplier;
    // ADAPTIVE PORTION (2026-07-17): when the client stated NO amount and NO size word,
    // their own median portion of this food (portion-memory, >=3 logs, clamped) beats
    // the table default. Memory fills silence; it never overrides what they said —
    // and a vague amount ("some", "half a") IS speech, so memory stays out of its way.
    if (!explicitQty && !vagueQty && sizeMultiplier === 1 && personal) {
      const pp = personalPortionFor(personal, f.name, f.typicalPortionCalories, f.typicalPortionProtein);
      if (pp.personal) {
        return {
          ...f,
          adjustedCalories: pp.kcal,
          adjustedProtein: pp.protein,
          adjustedDescription: `${f.typicalPortionDescription} — your usual`,
          quantity: 1,
          portionSource: "personal" as const,
          // Provenance travels with every branch, not just the common one (C11).
          statedUnit: null,
          statedBasis: foodBasis,
          canonicalBasis: canonicalBasis(f.typicalPortionDescription),
        };
      }
    }
    // PORTION PROVENANCE (2026-07-19): every inferred portion carries HOW it was decided —
    // the audit-trail atom the reviews keep asking for, and the signal the confidence layer
    // reads. "default" = a bare guess (no amount, no size word, no history) — the only case
    // that's genuinely uncertain.
    const portionSource = explicitQty ? "explicit" as const : vagueQty ? "vague" as const : sizeMultiplier !== 1 ? "size" as const : "default" as const;
    return {
      ...f,
      adjustedCalories: Math.round(f.typicalPortionCalories * quantity),
      adjustedProtein: Math.round(f.typicalPortionProtein * quantity),
      adjustedDescription: scalePortionDescription(f.typicalPortionDescription, quantity),
      quantity,
      portionSource,
      // Identity verified, quantity estimated — "2 spoons of pap" is db-true about pap, a guess about how much.
      origin: quantityEstimated ? "ai" as const : undefined,
      // ── THE EVIDENCE BEHIND THE NUMBER (C11, 2026-09-16) ───────────────────────────────────
      // A persisted item could state its calories and nothing about how they were reached, so no
      // surface could explain or reproduce them. These three carry the client's own words: the
      // unit they measured in, the preparation basis they named, and the basis the food table's
      // canonical portion is expressed in — which is what makes a conflict between them visible.
      statedUnit,
      statedBasis: foodBasis,
      canonicalBasis: canonicalBasis(f.typicalPortionDescription),
    };
  });
}

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
  _slotCache.delete(userId); // slot memory learns from the same rows
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

// ── PERSONAL MEAL-SLOT LEARNING (Review #7 items 3b + gap-heuristic + behavioural
// shift detection, built 2026-07-17). The clock says 10:00 = breakfast; this client's
// own history may say 10:00 = lunch. Their pattern wins once it's strong enough —
// which also catches rotating/irregular shift workers the onboarding flag misses:
// eleven 02:00 "night meal" logs teach the system regardless of any flag. ──────────

export type SlotContext = { personalByHour: Map<number, string>; todaySlots: string[] };

const MAIN_SLOTS = ["breakfast", "lunch", "dinner"];

/** Pure: dominant meal label per SAST hour — qualifies at >=3 logs and >=70% share. */
export function dominantSlotByHour(rows: Array<{ loggedAt: Date | string | null; mealLabel: string | null }>): Map<number, string> {
  const byHour = new Map<number, Map<string, number>>();
  for (const r of rows) {
    const label = (r.mealLabel || "").toLowerCase().trim();
    if (!label || !r.loggedAt) continue;
    const h = new Date(new Date(r.loggedAt).getTime() + 2 * 3_600_000).getUTCHours();
    const counts = byHour.get(h) || new Map<string, number>();
    counts.set(label, (counts.get(label) || 0) + 1);
    byHour.set(h, counts);
  }
  const out = new Map<number, string>();
  for (const [h, counts] of byHour) {
    let total = 0, topLabel = "", topN = 0;
    for (const [label, n] of counts) { total += n; if (n > topN) { topN = n; topLabel = label; } }
    if (topN >= 3 && topN / total >= 0.7) out.set(h, topLabel);
  }
  return out;
}

/**
 * Pure: the final inferred slot. Personal hour-pattern beats the clock fallback;
 * then the collision rule — a LIGHT (<300 kcal) second meal landing on a main slot
 * already used today is a snack, not a duplicate "breakfast" (a real second plate
 * keeps its slot honestly: two breakfasts happened). Explicit keywords never reach
 * this function — it only runs when the client said nothing about the meal.
 */
export function resolveInferredSlot(fallback: string, hour: number, ctx: SlotContext | undefined, kcal?: number | null): string {
  let slot = ctx?.personalByHour?.get(hour) || fallback;
  if (ctx?.todaySlots?.includes(slot) && MAIN_SLOTS.includes(slot) && kcal != null && kcal < 300) slot = "snack";
  return slot;
}

const _slotCache = new Map<string, { at: number; ctx: SlotContext }>();

export async function getSlotContext(userId: string): Promise<SlotContext> {
  const empty: SlotContext = { personalByHour: new Map(), todaySlots: [] };
  try {
    const c = _slotCache.get(userId);
    if (c && Date.now() - c.at < CACHE_TTL_MS) return c.ctx;
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
    const rows = await db.select({ loggedAt: mealLogs.loggedAt, mealLabel: mealLogs.mealLabel }).from(mealLogs)
      .where(and(eq(mealLogs.userId, userId), gte(mealLogs.loggedAt, sixtyDaysAgo)))
      .orderBy(desc(mealLogs.loggedAt))
      .limit(300);
    const sastMidnight = new Date(new Date(Date.now() + 2 * 3_600_000).setUTCHours(0, 0, 0, 0) - 2 * 3_600_000);
    const todaySlots = [...new Set(rows
      .filter(r => r.loggedAt && new Date(r.loggedAt) >= sastMidnight)
      .map(r => (r.mealLabel || "").toLowerCase().trim()).filter(Boolean))];
    const ctx: SlotContext = { personalByHour: dominantSlotByHour(rows), todaySlots };
    if (_slotCache.size > 2000) _slotCache.clear();
    _slotCache.set(userId, { at: Date.now(), ctx });
    return ctx;
  } catch (e) {
    console.warn("[SLOT_MEMORY] non-fatal:", (e as Error)?.message);
    return empty; // fail-open: clock fallback, exactly as before
  }
}

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
 * HOW MUCH DID THEY EAT (moved here from handlers/food-context.ts, 2026-09-03 — unchanged).
 *
 * The scanner answers WHICH foods a message names; this answers HOW MUCH of each, and that is
 * this file's subject. Everything it needs already lived here: classifyPortionUnit reads the unit
 * word, personalPortionFor supplies the learned portion when the client said no amount, and
 * scalePortionDescription writes the result back out. It sat in the food handler only because
 * that is where it was first called from — the handler now imports it like any other caller.
 */

// Quantity/portion scaling — shared by the scanner, smart-log and multi-day paths.
function normaliseWordNumbers(text: string): string {
  const map: Record<string, string> = {
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    "half": "0.5", "a": "1", "an": "1",
  };
  // Phrase pass FIRST: "half a vienna" must become "0.5 vienna", not "0.5 1 vienna" —
  // the a→1 word map was eating the half and logging a whole item (2026-07-23).
  const phrased = text.replace(/\bhalf\s+(?:a|an|the)\s+/gi, "0.5 ");
  return phrased.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|half|a|an)\b/gi, w => map[w.toLowerCase()] ?? w);
}

export function adjustFoodsForSegment(foods: SAFood[], segText: string, personal?: Map<string, PortionStat>) {
  const normText = normaliseWordNumbers(segText);

  // Portion-size modifier — "big plate of pap" → 1.5×, "half a portion" → 0.5×
  // Applied globally across all foods in the segment (whole meal was described as big/small)
  let sizeMultiplier = 1;
  if (/(big|large|huge|heaped|extra\s*large|xl|full\s*plate|loaded)\s+(?:plate|bowl|portion|serving|of\b)/i.test(normText)
    || /\b(double|extra\s+helping|extra\s+large\b)/i.test(normText)) {
    sizeMultiplier = 1.5;
  } else if (/(small|tiny|little|mini|quarter)\s+(?:plate|bowl|portion|serving)/i.test(normText)
    || /\ba\s+(?:small|tiny|little)\s+bit\s+of\b/i.test(normText)
    || /\bsmall\s+amount\s+of\b/i.test(normText)) {
    sizeMultiplier = 0.7;
  } else if (/\b(?:half|halved)\s+(?:a\s+)?(?:plate|bowl|portion|serving|of\b)/i.test(normText)
    || /\b(?:half\s+(?:the\s+)?(?:pap|rice|pasta|meal|food)\b)/i.test(normText)) {
    sizeMultiplier = 0.5;
  }

  return foods.map(f => {
    const allAliases = [f.name.toLowerCase(), ...f.aliases.map(a => a.toLowerCase())];
    let quantity = 1;
    let explicitQty = false; // the client SAID an amount — memory never overrides speech
    let quantityEstimated = false; // WE interpreted the amount — identity can be db, quantity a guess
    for (const alias of allAliases) {
      const qtyDirect = normText.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+(?:${escapeRegex(alias)})`, "i"));
      // UNIT-AWARE (2026-08-13): capture the unit WORD and classify it — "2 plates", "2 tablespoons",
      // "2 pieces" and "2 spoons" are four different claims, and the old catch-all made all four N
      // whole portions, so "2 spoons of pap" logged 660 kcal. See classifyPortionUnit above.
      const qtyWithUnit = qtyDirect ? null : normText.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+([a-z]+)\\s+(?:of\\s+)?(?:${escapeRegex(alias)})`, "i"));
      const qtyBefore = qtyDirect || qtyWithUnit;
      if (qtyBefore) {
        explicitQty = true;
        const userQty = parseFloat(qtyBefore[1]);
        const unit = qtyWithUnit ? classifyPortionUnit(qtyWithUnit[2], f.typicalPortionDescription, f.typicalPortionGrams) : null;
        if (unit && unit.fraction !== null) {
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
    };
  });
}

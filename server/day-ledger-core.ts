/**
 * DAY LEDGER — pure core (no DB, no clock). The reducer that turns meal rows into a day's
 * totals + meal list. Kept DB-free so it is unit-testable; getDayLedger (day-ledger.ts) wraps
 * it with the query. Every surface's numbers come from exactly this reducer.
 */

export interface LedgerMeal {
  label: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  loggedAt: Date;
  source: string;
  foods: string; // human-readable "what they ate", from structured items or the raw message
}

export interface DayLedger {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  water: number; // litres — today only
  steps: number; // the day's step count
  meals: LedgerMeal[];
}

export interface LedgerRow {
  label: string | null; kcal: number | null; protein: number | null;
  carbs: number | null; fat: number | null; loggedAt: Date | null;
  source: string | null; items: unknown; rawMessage: string | null;
}

// PURE: today's water, guarded by the reset date. today_water is a single running column
// that only rolls over when water is NEXT logged, so it holds yesterday's litres until then.
// Trust it only when it was last reset today; otherwise today's water is 0.
export function freshTodayWater(waterLastResetDate: string | null | undefined, today: string, todayWater: unknown): number {
  if (!waterLastResetDate || waterLastResetDate !== today) return 0;
  const v = parseFloat(String(todayWater ?? "0")) || 0;
  return Math.round(v * 10) / 10;
}

// A meal row → its readable food description.
function foodsOf(items: unknown, raw: string | null): string {
  if (Array.isArray(items)) {
    const names = items.map((i: any) => (i && typeof i.name === "string" ? i.name : "")).filter(Boolean);
    if (names.length) return names.join(", ");
  }
  const r = (raw || "").trim();
  return r && r !== "[Photo]" ? r : "meal";
}

// PURE: fold DB meal rows into the day totals + meal list. Every surface (card, running total,
// diary) reduces the same rows through this, so their numbers are identical by construction.
export function foldLedgerRows(rows: LedgerRow[]): Omit<DayLedger, "water" | "steps"> {
  let kcal = 0, protein = 0, carbs = 0, fat = 0;
  const meals: LedgerMeal[] = [];
  for (const r of rows) {
    const k = r.kcal || 0, p = r.protein || 0, c = r.carbs || 0, f = r.fat || 0;
    kcal += k; protein += p; carbs += c; fat += f;
    meals.push({
      label: r.label || "", kcal: k, protein: p, carbs: c, fat: f,
      loggedAt: (r.loggedAt as Date) || new Date(), source: r.source || "text",
      foods: foodsOf(r.items, r.rawMessage),
    });
  }
  return { kcal, protein, carbs, fat, meals };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE SAME REDUCER, OVER MORE DAYS (2026-08-19, Cut 11 — canonical progress)
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// Twenty modules in this repo compute a progress figure and four cards never touch the ledger at
// all. The two that both report a weight change disagreed about its SIGN: report-card.ts computes
// `last - first` (negative means lost) and the share card computed `first - last` (positive means
// lost). Same client, same week, two numbers with opposite meaning, and the share card is the one
// that gets forwarded to their friends.
//
// This is deliberately NOT a new aggregate. It is foldLedgerRows — the day reducer — run over the
// days in a window, so a week can never mean something a day does not. Pure, so the window can be
// tested without a database.

export interface DayTotal { day: string; kcal: number; protein: number; meals: number }

export interface WindowTotals {
  /** How many days the window covers, as asked for. */
  days: number;
  /** Days that actually carry a meal — the only honest divisor for an average. */
  daysLogged: number;
  kcal: number;
  protein: number;
  meals: number;
  /** Per LOGGED day, never per calendar day: three logged days out of seven is not a 43% eater. */
  avgKcal: number;
  avgProtein: number;
  perDay: DayTotal[];
}

export function foldWindowRows(rows: LedgerRow[], days: number, dayKeyOf: (d: Date) => string): WindowTotals {
  const byDay = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const at = r.loggedAt instanceof Date ? r.loggedAt : new Date(r.loggedAt as any);
    if (isNaN(at.getTime())) continue;
    const key = dayKeyOf(at);
    const list = byDay.get(key);
    if (list) list.push(r); else byDay.set(key, [r]);
  }
  let kcal = 0, protein = 0, meals = 0;
  const perDay: DayTotal[] = [];
  for (const [day, dayRows] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // THE SAME FOLD THE DAY USES. Not a SUM written a second time.
    const folded = foldLedgerRows(dayRows);
    kcal += folded.kcal; protein += folded.protein; meals += folded.meals.length;
    perDay.push({ day, kcal: folded.kcal, protein: folded.protein, meals: folded.meals.length });
  }
  const daysLogged = perDay.length;
  const divisor = Math.max(1, daysLogged);
  return {
    days, daysLogged, kcal, protein, meals,
    avgKcal: Math.round(kcal / divisor),
    avgProtein: Math.round(protein / divisor),
    perDay,
  };
}

/**
 * THE ONE SIGN CONVENTION: negative means they lost weight.
 *
 * Stated here, once, because the two places that computed it disagreed and one of them was the
 * card people forward. `null` when there are fewer than two weigh-ins — a single number is a
 * reading, not a change, and inventing a trend from it is the crime this object exists to stop.
 */
export function weightChangeKg(weighIns: Array<{ weight: unknown }>): number | null {
  const kgs = weighIns.map(w => Number(w.weight)).filter(n => Number.isFinite(n) && n > 0);
  if (kgs.length < 2) return null;
  return Math.round((kgs[kgs.length - 1] - kgs[0]) * 10) / 10;
}

// ── FOOD PROVENANCE — how much of this window do we actually KNOW? ──────────────────────────
// Moved here from report-card.ts in Cut 11: pure derivation over ledger rows, which is what
// this module is for, and the canonical progress object is now its main consumer. Known /
// likely / unknown, measured rather than asserted.

export type ItemOrigin = "db" | "label" | "ai" | "photo" | "unknown";

/** Model-derived origins. `db` and `label` are grounded in something outside the model. */
const ESTIMATED_ORIGINS: ItemOrigin[] = ["ai", "photo"];

/**
 * How much of a window's energy we can actually stand behind. GRADUATED, not binary: 10%
 * estimated and 80% estimated are different situations and a flag cannot tell them apart.
 *   verified          essentially all grounded
 *   mostly_verified   a small estimated share — act on the number normally
 *   mixed             act, but not on the exact figure
 *   mostly_estimated  the average is largely inference; conclusions must soften accordingly
 *   insufficient      too much unknown provenance to characterise it at all
 */
export type FoodDataConfidence =
  | "verified" | "mostly_verified" | "mixed" | "mostly_estimated" | "insufficient";

export interface FoodProvenance {
  /** Share of window kcal from model-derived items, 0–1. Null when nothing is characterisable. */
  estimatedShare: number | null;
  /** Share of window kcal from rows logged before provenance existed, 0–1. */
  unknownShare: number;
  confidence: FoodDataConfidence;
}

/**
 * PURE. Rows in, provenance out. Unknown is treated as unknown rather than folded into either
 * side — a meal we cannot characterise must not read as verified OR as estimated.
 */
export function summariseProvenance(
  rows: Array<{ kcal: number; items: unknown; source?: string | null }>,
): FoodProvenance {
  let total = 0, estimated = 0, unknown = 0;
  for (const r of rows) {
    const kcal = Number(r.kcal) || 0;
    if (kcal <= 0) continue;
    total += kcal;
    const items = Array.isArray(r.items) ? (r.items as any[]) : null;
    if (!items || items.length === 0) {
      // No item list. The meal-level `source` is a REAL recorded fact, so use it — but only in
      // the direction that can lower confidence. `photo` and `gpt_fallback` are unambiguously
      // model-derived. `sa_scanner` is NOT trusted here: before item tagging existed, that label
      // was also applied to meals carrying GPT-supplemented items, which is the exact
      // false-confidence this field exists to remove. Those stay unknown.
      if (r.source === "photo" || r.source === "gpt_fallback") estimated += kcal;
      else unknown += kcal;
      continue;
    }
    // Weight each item by its own kcal where it has one; fall back to an even split so a
    // partially-priced item list still contributes honestly rather than being dropped.
    const itemKcalTotal = items.reduce((s, it) => s + (Number(it?.kcal) || 0), 0);
    for (const it of items) {
      const share = itemKcalTotal > 0 ? (Number(it?.kcal) || 0) / itemKcalTotal : 1 / items.length;
      const origin = (it?.origin as ItemOrigin) || "unknown";
      if (origin === "unknown") unknown += kcal * share;
      else if (ESTIMATED_ORIGINS.includes(origin)) estimated += kcal * share;
    }
  }
  if (total <= 0) return { estimatedShare: null, unknownShare: 0, confidence: "insufficient" };

  const unknownShare = unknown / total;
  // With half the energy uncharacterisable, any estimated share we compute describes a minority
  // of the week and would overstate what we know.
  if (unknownShare >= 0.5) {
    return { estimatedShare: null, unknownShare: round2(unknownShare), confidence: "insufficient" };
  }
  const known = total - unknown;
  const estimatedShare = known > 0 ? estimated / known : 0;
  const confidence: FoodDataConfidence =
    estimatedShare <= 0.05 ? "verified"
      : estimatedShare <= 0.25 ? "mostly_verified"
        : estimatedShare <= 0.60 ? "mixed"
          : "mostly_estimated";
  return { estimatedShare: round2(estimatedShare), unknownShare: round2(unknownShare), confidence };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

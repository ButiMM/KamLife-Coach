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

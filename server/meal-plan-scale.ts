/**
 * MEAL-PLAN SCALING — make the generated plan actually HIT the client's target.
 *
 * (2026-07-27, founder: "the features are half built.") The 3-day plan is assembled from
 * fixed-size meal pools sized for roughly a 1400–1500 kcal day, with a flat +80 kcal on
 * lunch/dinner for muscle gain. For a 2862 kcal client that produced plans averaging ~1483
 * kcal/day — 52% of target — and the validator DETECTED the shortfall and shipped the plan
 * anyway with a "add ~1379 kcal yourself" note. A plan that tells the client to fix it is
 * not a plan.
 *
 * This closes the gap deterministically with real, cheap SA foods: protein-first (the macro
 * that matters and the one the pools under-deliver), then starch for the remaining energy.
 * Pure — no DB, no clock, unit-tested.
 */

export interface TopUp { label: string; kcal: number; protein: number }

// Per-unit building blocks, protein-dense first. Budget-friendly staples on purpose: these
// are what the target market actually buys (eggs, pilchards, amasi, peanut butter, pap).
const PROTEIN_UNITS: Array<{ name: string; kcal: number; protein: number; max: number }> = [
  { name: "1 tin pilchards", kcal: 190, protein: 26, max: 2 },
  { name: "3 boiled eggs", kcal: 234, protein: 21, max: 2 },
  { name: "250ml amasi", kcal: 130, protein: 9, max: 2 },
  { name: "2 tbsp peanut butter", kcal: 190, protein: 8, max: 2 },
];
const STARCH_UNITS: Array<{ name: string; kcal: number; protein: number; max: number }> = [
  { name: "1 cup cooked pap", kcal: 290, protein: 6, max: 3 },
  { name: "2 slices brown bread", kcal: 180, protein: 8, max: 2 },
  { name: "1 banana", kcal: 105, protein: 1, max: 2 },
];

/**
 * Top-ups to append to ONE day so it lands near the calorie + protein target.
 * `dayKcal`/`dayProtein` are the day's built totals. Never returns a negative adjustment —
 * an over-target plan is handled by the caller trimming, not by this function.
 */
export function topUpsForDay(dayKcal: number, dayProtein: number, calorieTarget: number, proteinTarget: number): TopUp[] {
  const out: TopUp[] = [];
  let kcalGap = Math.max(0, Math.round(calorieTarget - dayKcal));
  let protGap = Math.max(0, Math.round(proteinTarget - dayProtein));
  if (kcalGap < 150 && protGap < 15) return out; // already close enough

  // 1. PROTEIN first — it's the macro the pools under-deliver and the one that protects muscle.
  for (const u of PROTEIN_UNITS) {
    let n = 0;
    while (n < u.max && protGap > 8 && kcalGap >= u.kcal * 0.6) {
      n++; protGap -= u.protein; kcalGap -= u.kcal;
    }
    if (n > 0) out.push({ label: n === 1 ? u.name : `${n}× ${u.name}`, kcal: u.kcal * n, protein: u.protein * n });
  }
  // 2. STARCH for whatever energy is still missing.
  for (const u of STARCH_UNITS) {
    let n = 0;
    while (n < u.max && kcalGap >= u.kcal * 0.7) { n++; kcalGap -= u.kcal; protGap -= u.protein; }
    if (n > 0) out.push({ label: n === 1 ? u.name : `${n}× ${u.name}`, kcal: u.kcal * n, protein: u.protein * n });
  }
  return out;
}

/** One readable line for the plan text, or "" when nothing was added. */
export function topUpLine(tops: TopUp[]): string {
  if (!tops.length) return "";
  const kcal = tops.reduce((s, t) => s + t.kcal, 0);
  const prot = tops.reduce((s, t) => s + t.protein, 0);
  return `➕ *Extra to hit your target:* ${tops.map(t => t.label).join(" + ")}\n~${kcal} kcal | ${prot}g protein`;
}

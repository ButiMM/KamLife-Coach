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

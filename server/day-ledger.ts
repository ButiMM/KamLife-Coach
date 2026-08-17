/**
 * DAY LEDGER — the ONE source of truth for a client's day (Box 1 of the rebuild).
 *
 * (2026-07-22, Kam: "the card says one thing, the text says another, nothing reconciles.")
 * The disease was that the macro card, the running-total reply, and "today's meals" each
 * computed the day's numbers with their OWN query and their OWN math — so they drifted. This
 * is the cure: every one of those surfaces now READS getDayLedger. One place turns logged
 * meals into a day total; they cannot disagree, because it is the same computation.
 *
 * Rule of the rebuild: this READS. It never writes. Writing stays in the single commit path.
 * The pure reducer lives in day-ledger-core.ts and is unit-tested.
 */

import { db } from "./db";
import { mealLogs, stepLogs, users } from "../shared/schema";
import { and, eq, gte, lt, desc, sql } from "drizzle-orm";
import { sastDayStart, sastToday } from "./utils";
import { foldLedgerRows, freshTodayWater, type DayLedger, type LedgerRow } from "./day-ledger-core";
import { estimateCarbsFat } from "./macro-estimate";
import { effectiveMealLoggedAt } from "./utils";
import { invalidatePatternCache } from "./cache";
import { replaceHeldMeal, amendRecentMeal } from "./food-identity-correction";
import { turnMutation } from "./handlers/chat-log";

export { foldLedgerRows } from "./day-ledger-core";
export type { DayLedger, LedgerMeal, LedgerRow } from "./day-ledger-core";

/**
 * The authoritative day read. `forDate` scopes to a past day (retro logs); omit for today.
 * `user` supplies today's water. This is the only function that computes a day's totals.
 */
export async function getDayLedger(userId: string, opts?: { forDate?: Date; user?: any }): Promise<DayLedger> {
  const dayStart = opts?.forDate ? sastDayStart(opts.forDate) : sastDayStart();
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const rows = await db.select({
    label: mealLogs.mealLabel, kcal: mealLogs.kcalInt, protein: mealLogs.proteinInt,
    carbs: mealLogs.carbsInt, fat: mealLogs.fatInt, loggedAt: mealLogs.loggedAt,
    source: mealLogs.source, items: mealLogs.items, rawMessage: mealLogs.rawMessage,
  }).from(mealLogs)
    .where(and(eq(mealLogs.userId, userId), gte(mealLogs.loggedAt, dayStart), lt(mealLogs.loggedAt, dayEnd)))
    .orderBy(desc(mealLogs.loggedAt));

  const [stepRow] = await db.select({ steps: sql<number>`COALESCE(MAX(${stepLogs.steps}),0)::int` })
    .from(stepLogs)
    .where(and(eq(stepLogs.userId, userId), gte(stepLogs.loggedAt, dayStart), lt(stepLogs.loggedAt, dayEnd)));

  const folded = foldLedgerRows(rows as LedgerRow[]);
  // Water shows on the card only if today_water was last reset today — else it's yesterday's
  // stale litres (2026-07-23, Kam: "it says 2L — I've had no water today"). freshTodayWater is
  // pure + unit-tested; the guard matches every other surface (client-snapshot, misc-commands).
  const water = opts?.forDate ? 0 : freshTodayWater(opts?.user?.waterLastResetDate, sastToday(), opts?.user?.todayWater);
  const steps = Number(stepRow?.steps || 0);
  return { ...folded, water, steps };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE WRITE DOOR — the single chokepoint for every food-log write.
//
// Moved here from handlers/food-context.ts (2026-08-17) when per-event rows pushed that file past
// its line budget and the guard said what it always says: extract a cohesive piece. This is the
// cohesive piece, and this is its right home — day-ledger already owns THE authoritative read of a
// day's food. Owning the write beside it means one module answers both "what did they eat today"
// and "how does a meal get in there", instead of the write living inside a 1,500-line handler.
//
// Every dependency was already outside food-context (food-identity-correction, macro-estimate,
// chat-log, food-scanner), so this moved with no circular import and no behaviour change.
// food-context re-exports it, so media.ts and referent-log.ts are untouched.
// ════════════════════════════════════════════════════════════════════════════════════════════

interface CommitFoodLogParams {
  userId: string;
  phone: string;
  rawMessage: string;
  source: string;
  kcalInt: number;
  proteinInt: number;
  carbsInt: number;
  fatInt: number;
  items: Array<{ name: string; grams: number; kcal: number; protein: number; category: string }>;
  mealLabel: string | null | undefined;
  loggedAt: Date;
  /** EVENT LINEAGE (0004). Rows sharing this came from ONE client message. Omitted → NULL, which
   *  is a group of one and exactly how every row behaved before events existed. */
  sourceMessageId?: string | null;
}

interface CommitFoodLogResult {
  ok: boolean;
  wasDup: boolean;
  prevCals: number;
  runningCals: number;
  runningProtein: number;
}

// THE single chokepoint for every food-log write (Box 2). GUARANTEE: complete macros — kcal +
// protein with no carbs/fat get filled from the trusted numbers so the card can't be zero-
// dragged. Fills only when BOTH are absent (an all-protein meal still lands ~0).
export async function commitFoodLog(params: CommitFoodLogParams): Promise<CommitFoodLogResult> {
  // Dynamic on purpose: food-scanner imports THIS module dynamically, so a static edge back would
  // cycle at module init. Same pattern, same reason, opposite direction.
  const { recomputeTodayFoodTotals, invalidateFoodTotalsCache } = await import("./handlers/food-scanner");
  let carbsInt = params.carbsInt;
  let fatInt = params.fatInt;
  if (params.kcalInt > 0 && carbsInt <= 0 && fatInt <= 0) {
    const est = estimateCarbsFat(params.kcalInt, params.proteinInt);
    carbsInt = est.carbs; fatInt = est.fat;
  }
  let prevCals = 0;
  try {
    const existingTotals = await recomputeTodayFoodTotals(params.userId);
    prevCals = existingTotals.calories;
  } catch { /* non-fatal */ }

  const dedupWindow = new Date(Date.now() - 4 * 60 * 1000);
  const rawSlice = params.rawMessage.slice(0, 1000);
  const effLoggedAt = effectiveMealLoggedAt(params.loggedAt, params.rawMessage, params.mealLabel);
  const recentDup = await db.select({ id: mealLogs.id })
    .from(mealLogs)
    .where(and(
      eq(mealLogs.userId, params.userId),
      gte(mealLogs.loggedAt, dedupWindow),
      eq(mealLogs.kcalInt, params.kcalInt),
      eq(mealLogs.rawMessage, rawSlice),
    ))
    .limit(1);

  const patch = { rawMessage: rawSlice, kcalInt: params.kcalInt, proteinInt: params.proteinInt, carbsInt, fatInt, items: params.items, mealLabel: params.mealLabel };
  const itemNames = (Array.isArray(params.items) ? params.items : []).map((i: any) => String(i?.name || i?.foodName || "")).filter(Boolean);
  // A held row's REPLACEMENT and an AMENDMENT both rewrite an existing row and suppress the
  // insert below. Neither ever creates a second row.
  const heldId = await replaceHeldMeal(params.userId, `${rawSlice} ${itemNames.join(" ")}`, patch);
  const amendedId = heldId || await amendRecentMeal(params.userId, itemNames, patch);
  if (amendedId) { invalidatePatternCache(params.userId); invalidateFoodTotalsCache(params.userId); }
  let insertOk = true;
  const wasDup = recentDup.length > 0 || !!amendedId;
  if (!wasDup) {
    try {
      await db.insert(mealLogs).values({
        userId: params.userId,
        rawMessage: rawSlice,
        source: params.source,
        sourceMessageId: params.sourceMessageId ?? null,
        kcalInt: params.kcalInt,
        proteinInt: params.proteinInt,
        carbsInt,
        fatInt,
        items: params.items,
        mealLabel: params.mealLabel,
        loggedAt: effLoggedAt,
      });
      invalidatePatternCache(params.userId);
      invalidateFoodTotalsCache(params.userId);
      turnMutation(`INSERT meal kcal=${params.kcalInt} prot=${params.proteinInt} label=${params.mealLabel || "none"} at=${String(effLoggedAt).slice(0, 10)}`, `[MEAL_LOG] user=...${String(params.userId || "").slice(-6)}`);
    } catch (e) {
      console.error("[MEAL_LOG] insert failed — user:", String(params.userId || "").slice(-6), e);
      insertOk = false;
    }
  }

  let runningCals = prevCals + params.kcalInt;
  let runningProtein = params.proteinInt;
  try {
    const freshTotals = await recomputeTodayFoodTotals(params.userId);
    runningCals = freshTotals.calories;
    runningProtein = freshTotals.protein;
    await db.update(users).set({
      todayCalories: runningCals,
      todayProteinG: runningProtein,
      todayCaloriesDate: sastToday(),
    }).where(eq(users.phoneNumber, params.phone));
  } catch (e) { console.error("[MEAL_LOG] calorie update failed — user:", String(params.userId || "").slice(-6), e); }

  return { ok: insertOk, wasDup, prevCals, runningCals, runningProtein };
}

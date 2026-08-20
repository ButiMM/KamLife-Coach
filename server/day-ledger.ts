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
import { replaceHeldMeal, amendRecentMeal, planCorrection, applyCorrection, isSameMealRetry } from "./food-identity-correction";
import { turnMutation } from "./handlers/chat-log";
import { answerPlateAsk, foodConstraints, swapNudge } from "./food-swaps";
import { matchStreetDish } from "./street-food";

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

/**
 * A client can correct a food inside the same message that logs it. The scanner has already
 * parsed both sides by the time this write door sees the turn. Net the removal here, before the
 * row is written, and let the replacement survive because it is already present in `items`.
 *
 * This reuses the existing correction grammar and composition rule; it does not create a second
 * correction engine. When a composite DB food (e.g. "Chicken and rice") needs to be split, use
 * the scanner's own resolver so the retained half gets real food numbers rather than a guess.
 */
async function netSameMessageCorrection(
  rawMessage: string,
  items: CommitFoodLogParams["items"],
): Promise<CommitFoodLogParams["items"]> {
  if (!rawMessage || !Array.isArray(items) || items.length < 2 || !/\b(?:not|no|wasn'?t|didn'?t)\b/i.test(rawMessage)) return items;
  const plan = planCorrection(rawMessage, false);
  if (!plan.remove.length) return items;

  const { scanForSAFoods } = await import("./handlers/food-scanner");
  const resolveFood = (food: string) => {
    const hit = scanForSAFoods(food, { exactOnly: true })[0] || scanForSAFoods(food)[0];
    return hit ? {
      name: hit.name,
      grams: hit.typicalPortionGrams || 100,
      kcal: hit.typicalPortionCalories || 0,
      protein: hit.typicalPortionProtein || 0,
      category: hit.category,
    } : null;
  };

  const net = applyCorrection(items, { ...plan, add: [] }, resolveFood as any);
  if (!net.removed.length || net.items.length === 0) return items;
  return net.items as CommitFoodLogParams["items"];
}

// THE single chokepoint for every food-log write (Box 2). GUARANTEE: complete macros — kcal +
// protein with no carbs/fat get filled from the trusted numbers so the card can't be zero-
// dragged. Fills only when BOTH are absent (an all-protein meal still lands ~0).
export async function commitFoodLog(params: CommitFoodLogParams): Promise<CommitFoodLogResult> {
  // Dynamic on purpose: food-scanner imports THIS module dynamically, so a static edge back would
  // cycle at module init. Same pattern, same reason, opposite direction.
  const { recomputeTodayFoodTotals, invalidateFoodTotalsCache } = await import("./handlers/food-scanner");

  const correctedItems = await netSameMessageCorrection(params.rawMessage, params.items);
  const itemsChanged = correctedItems !== params.items;
  const effectiveKcal = itemsChanged ? correctedItems.reduce((s, i) => s + (i.kcal || 0), 0) : params.kcalInt;
  const effectiveProtein = itemsChanged ? Math.round(correctedItems.reduce((s, i) => s + (i.protein || 0), 0)) : params.proteinInt;

  let carbsInt = params.carbsInt;
  let fatInt = params.fatInt;
  if (itemsChanged) {
    const est = estimateCarbsFat(effectiveKcal, effectiveProtein);
    carbsInt = est.carbs;
    fatInt = est.fat;
  } else if (params.kcalInt > 0 && carbsInt <= 0 && fatInt <= 0) {
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
  let recentDup = await db.select({ id: mealLogs.id })
    .from(mealLogs)
    .where(and(
      eq(mealLogs.userId, params.userId),
      gte(mealLogs.loggedAt, dedupWindow),
      eq(mealLogs.kcalInt, effectiveKcal),
      eq(mealLogs.rawMessage, rawSlice),
    ))
    .limit(1);
  // Voice retries of the same takeaway (McDonald's breakfast x3) have different raw text
  // so exact-match never fires — 127g protein from one breakfast. Treat same-chain items
  // in the last 2 hours as one meal.
  if (recentDup.length === 0) {
    const retryWindow = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const recentRows = await db.select({ id: mealLogs.id, items: mealLogs.items })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, params.userId), gte(mealLogs.loggedAt, retryWindow)))
      .limit(8);
    const newerNames = correctedItems.map((i: any) => String(i?.name || i?.foodName || "")).filter(Boolean);
    const hit = recentRows.find(r => {
      const older = Array.isArray(r.items) ? (r.items as any[]).map(i => String(i?.name || i?.foodName || "")).filter(Boolean) : [];
      return isSameMealRetry(older, newerNames);
    });
    if (hit) recentDup = [{ id: hit.id }];
  }

  const patch = { rawMessage: rawSlice, kcalInt: effectiveKcal, proteinInt: effectiveProtein, carbsInt, fatInt, items: correctedItems, mealLabel: params.mealLabel };
  const itemNames = correctedItems.map((i: any) => String(i?.name || i?.foodName || "")).filter(Boolean);
  if (itemsChanged) {
    turnMutation(`SELF_CORRECTION removed-from-write-door raw=${rawSlice.slice(0, 160)}`, `[MEAL_CORRECTION] user=...${String(params.userId || "").slice(-6)}`);
  }
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
        kcalInt: effectiveKcal,
        proteinInt: effectiveProtein,
        carbsInt,
        fatInt,
        items: correctedItems,
        mealLabel: params.mealLabel,
        loggedAt: effLoggedAt,
      });
      invalidatePatternCache(params.userId);
      invalidateFoodTotalsCache(params.userId);
      turnMutation(`INSERT meal kcal=${effectiveKcal} prot=${effectiveProtein} label=${params.mealLabel || "none"} at=${String(effLoggedAt).slice(0, 10)}`, `[MEAL_LOG] user=...${String(params.userId || "").slice(-6)}`);
    } catch (e) {
      console.error("[MEAL_LOG] insert failed — user:", String(params.userId || "").slice(-6), e);
      insertOk = false;
    }
  }

  let runningCals = prevCals + effectiveKcal;
  let runningProtein = effectiveProtein;
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

/**
 * THE ANSWER TO "CAN I EAT THIS?" — the ledger's own reply (2026-08-19, Cut 10).
 *
 * Lives here, not in the handler and not beside the pure verdict, because it is the one function
 * that needs BOTH sides: this module already owns the day's truth, and answerPlateAsk in
 * food-swaps.ts stays database-free so it can be unit-tested without one.
 *
 * Returns null whenever we cannot do better than the coach would — an unpriced food and no smart
 * move is a case for judgement, not for a deterministic sentence with nothing behind it.
 */
export async function answerFoodPermissionAsk(
  user: any, message: string, foods: Array<{ name: string; typicalPortionCalories?: number; typicalPortionProtein?: number }>,
): Promise<string | null> {
  try {
    const food = foods.find(f => (f.typicalPortionCalories || 0) > 0) || foods[0];
    if (!food) return null;

    const [ledger, dish] = await Promise.all([
      getDayLedger(user.id, { user }),
      Promise.resolve(matchStreetDish(String(message || "").toLowerCase())),
    ]);
    const constraints = foodConstraints({
      dietaryRestrictions: user.dietaryRestrictions, foodDislikes: user.foodDislikes,
      otherMedicalNotes: user.otherMedicalNotes, medicalConditions: user.medicalConditions,
    });
    // A street dish carries the move we already coach for it — "less chips, add an egg". Using it
    // here keeps ONE wording for that plate whether they asked permission or asked for the guide.
    const smartMove = dish
      ? (user.goalType === "muscle_gain" ? dish.smartBulk : dish.smartCut)
      : swapNudge(food.name, user.goalType, constraints);

    const verdict = answerPlateAsk({
      foodName: dish?.name || food.name,
      portionKcal: dish?.kcal || Number(food.typicalPortionCalories || 0),
      portionProtein: dish?.protein || Number(food.typicalPortionProtein || 0),
      eatenKcal: ledger.kcal, calorieTarget: Number(user.calorieTarget || 0),
      eatenProtein: ledger.protein, proteinTarget: Number(user.proteinTarget || 0),
      constraints, smartMove,
    });
    console.log(`[PLATE_ASK] ...${String(user.id).slice(-6)} ${verdict.kind} — ${dish?.name || food.name}`);
    return verdict.reply;
  } catch (e) {
    console.warn("[PLATE_ASK] non-fatal, leaving it to the coach:", (e as any)?.message || e);
    return null;
  }
}

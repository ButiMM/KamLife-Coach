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
import { mealLogs, stepLogs, users, workoutLogs, weightLogs } from "../shared/schema";
import { and, eq, gte, lt, desc, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sastDayStart, sastToday } from "./utils";
import { sastDayKey } from "./sast";
import { foldLedgerRows, freshTodayWater, foldWindowRows, weightChangeKg, summariseProvenance,
  type DayLedger, type LedgerRow, type WindowTotals, type FoodProvenance, daysOnProgramme } from "./day-ledger-core";
import { estimateCarbsFat } from "./macro-estimate";
import { effectiveMealLoggedAt } from "./utils";
import { invalidatePatternCache } from "./cache";
import { replaceHeldMeal, amendRecentMeal, planCorrection, applyCorrection, isSameMealRetry } from "./food-identity-correction";
import { turnMutation, turnEvidence } from "./handlers/chat-log";
import { answerPlateAsk, foodConstraints, swapNudge } from "./food-swaps";
import { matchStreetDish } from "./street-food";
import { mentionsForbidden } from "./brain/reply-verifier";

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
  // Leave the value on the turn so the mouth can tell a recital from an invention (2026-08-20).
  // This read already happened; nothing extra is queried.
  turnEvidence({ stepsToday: steps });
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

/**
 * APPEND NAMED ITEMS TO THE MOST RECENT MEAL OF THE DAY (2026-08-24).
 *
 * "You missed the black coffee" — the client names the one thing we did not record. Amending the
 * existing row is the only correct write: a second row double-counts the meal, and asking them to
 * restate the whole breakfast makes them re-type what they already said.
 *
 * It lives HERE because this module is the declared write door. The first version of this sat
 * inside food-context and the ownership guard caught it immediately: a handler that acts on a
 * message and writes to the database is a second write owner.
 *
 * Returns null when there is nothing to amend, so the caller keeps its existing clarification.
 */
export async function appendItemsToRecentMeal(
  userId: string,
  foods: Array<{ name: string; category?: string; typicalPortionGrams?: number | null;
    typicalPortionCalories?: number | null; typicalPortionProtein?: number | null;
    carbsPer100g?: number | null; fatPer100g?: number | null }>,
  forDate?: Date,
  namedSlot?: string | null,
): Promise<{ mealLabel: string; added: string[]; dayKey: string; calories: number; protein: number } | null> {
  if (!foods.length) return null;
  // A CORRECTION LANDS ON THE DAY BEING CORRECTED (2026-08-24).
  //
  // This queried `gte(loggedAt, sastDayStart())` — today, with no upper bound — so "you missed the
  // black coffee yesterday" silently moved the correction onto TODAY's row. That is worse than not
  // amending at all: the ledger now disagrees with the client about a day they can no longer see,
  // and every window that reads either day inherits the error. The caller resolves the day through
  // the one temporal owner and refuses to guess; this bounds the window at both ends.
  const dayStart = sastDayStart(forDate);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  // AND THE MEAL THEY NAMED, not merely the newest one. "You missed the black coffee at
  // breakfast" attached the coffee to DINNER — the client named the meal and we ignored it, which
  // is the date defect above one axis over. The slot comes from explicitMealSlot, the existing
  // owner of "does this message name a meal"; with no slot named, most-recent stands.
  const rows = await db.select({
    id: mealLogs.id, items: mealLogs.items, mealLabel: mealLogs.mealLabel,
    kcalInt: mealLogs.kcalInt, proteinInt: mealLogs.proteinInt,
    carbsInt: mealLogs.carbsInt, fatInt: mealLogs.fatInt,
  }).from(mealLogs)
    .where(and(eq(mealLogs.userId, userId), gte(mealLogs.loggedAt, dayStart), lt(mealLogs.loggedAt, dayEnd)))
    .orderBy(desc(mealLogs.loggedAt)).limit(8);
  const slot = String(namedSlot || "").toLowerCase();
  const target = (slot ? rows.find(r => String(r.mealLabel || "").toLowerCase() === slot) : null) || rows[0];
  if (!target?.id) return null;

  const existing = Array.isArray(target.items) ? target.items as any[] : [];
  const already = new Set(existing.map(i => String(i?.name || "").toLowerCase()));
  const additions = foods.filter(f => !already.has(f.name.toLowerCase()));
  if (additions.length === 0) return null;

  const added = additions.map(f => ({
    name: f.name, grams: f.typicalPortionGrams || 100,
    kcal: f.typicalPortionCalories || 0, protein: f.typicalPortionProtein || 0,
    category: f.category || "other",
  }));
  const per100 = (f: typeof additions[number], k: "carbsPer100g" | "fatPer100g") =>
    Math.round(((f[k] || 0) * (f.typicalPortionGrams || 100)) / 100);

  await db.update(mealLogs).set({
    items: [...existing, ...added],
    kcalInt: (target.kcalInt || 0) + added.reduce((t, a) => t + a.kcal, 0),
    proteinInt: (target.proteinInt || 0) + added.reduce((t, a) => t + a.protein, 0),
    carbsInt: (target.carbsInt || 0) + additions.reduce((t, f) => t + per100(f, "carbsPer100g"), 0),
    fatInt: (target.fatInt || 0) + additions.reduce((t, f) => t + per100(f, "fatPer100g"), 0),
    corrected: true,
  }).where(eq(mealLogs.id, target.id));
  turnMutation(`UPDATE meal ${target.id} += ${added.map(a => a.name).join(", ")}`, "[MEAL_AMEND]");

  const { recomputeTodayFoodTotals, invalidateFoodTotalsCache } = await import("./handlers/food-scanner");
  invalidateFoodTotalsCache(userId);
  // The running total is TODAY's; a correction to a past day must not print it as if it were.
  const isToday = dayStart.getTime() === sastDayStart().getTime();
  const totals = isToday ? await recomputeTodayFoodTotals(userId) : { calories: 0, protein: 0 };
  return {
    mealLabel: target.mealLabel || "that meal",
    added: added.map(a => a.name),
    dayKey: sastDayKey(dayStart),
    calories: totals.calories, protein: totals.protein,
  };
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

// ════════════════════════════════════════════════════════════════════════════════════════════
// THE CANONICAL PROGRESS OBJECT (2026-08-19, Cut 11)
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// One object. Two windows. One source. Chat, the card and the share are PRESENTATIONS of this —
// never separate calculators. Before it, report-card ran its own five queries, the share path ran
// its own weight query with the opposite sign convention, and four card modules never read the
// ledger at all.
//
// THE WEIGHT IS WITHHELD BY THE OBJECT, NOT BY EACH PRESENTATION. A client who asked us to stop
// mentioning the scale should not depend on three renderers each remembering to strip it — one of
// them will forget, and the one that gets forwarded to their friends is the worst place to find
// out. So the truth object refuses to carry the number, and every presentation is safe because it
// has nothing to print. That is what makes the share card safe to hand somebody.
//
// They can still ASK. Cut 8's rule holds: a prohibition is about us raising it, not about refusing
// to answer. Pass the client's own message and a direct question re-opens it.

export interface ProgressWeight {
  /** False when we have fewer than two weigh-ins, or when they asked us not to raise it. */
  known: boolean;
  currentKg: number | null;
  /** NEGATIVE MEANS LOST. One convention, from day-ledger-core. */
  changeKg: number | null;
  /** True only in the don't-mention case, so a caller can tell "we don't know" from "not ours to say". */
  withheld: boolean;
  /** The first weigh-in in the window — what "since you started" is measured from. */
  startKg: number | null;
  /**
   * HOW FAR THEY STILL HAVE TO GO. Signed, same convention as changeKg: NEGATIVE MEANS DOWN THE
   * SCALE — still to lose — and positive means still to gain. null when no target weight is set,
   * when there is no weigh-in to measure from, or when the scale is withheld.
   */
  toGoalKg: number | null;
  /** Days between the first and last weigh-in. 0 when there are fewer than two. */
  spanDays: number;
  /** Every weigh-in in the window, oldest first. Empty when withheld. For a chart or a trend. */
  points: Array<{ kg: number; at: Date }>;
}

/**
 * THE SCALE HAS ONE READER, AND IT KNOWS WHO ASKED US TO DROP IT (2026-08-25, P0-5 · weight).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS EXISTS TO STOP
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `users.do_not_mention` is the client saying "stop bringing up my weight". Measured on
 * main@266a8c2b, exactly ONE reader on the client path honoured it — getProgressTruth. Four
 * others read weight_logs directly and spoke the number with no check at all:
 *
 *   brain/client-snapshot.ts   builds the model's context: "Weight: started 83.4kg, now 82.0kg
 *                              … Quote these figures EXACTLY as written."
 *   gpt.ts                     two more weigh-in reads into the same context
 *   macro-card-attach.ts       renders the change into a card IMAGE — the reactive mouth strips
 *                              forbidden TEXT, and cannot touch a picture
 *   handlers/lifecycle.ts      "Weight: ↓ 1.4kg lost (83.4kg → 82.0kg)"
 *
 * The reply boundary's strip is a last resort, not the rule: the architecture note on
 * DayState.doNotMention says it plainly — the decision must stand down, because stripping the
 * sentence afterwards leaves the coach with nothing to say. And it only guards the reactive path,
 * so a proactive weight line and a rendered card were never guarded at all.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS NOT
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Not a new service and not a second progress owner. It is the weight block that was already
 * inside getProgressTruth, lifted so the surfaces that need ONLY weight can reach it without
 * pulling a full progress read — and getProgressTruth calls it, so there is still exactly one
 * definition of "what the scale says". Same move, and the same reason, as sessionsSince.
 *
 * THEY MAY RAISE IT THEMSELVES. `clientMessage` carries the turn's text: "don't mention my
 * weight" is not "refuse to tell me my weight when I ask", and a coach who won't answer a direct
 * question is not honouring anything. Three commands in misc-commands.ts — weight history, my
 * weight, body check — are exactly that case, and they now say so by passing the message rather
 * than by not having asked.
 */
export async function getWeightTruth(
  user: any,
  opts?: { clientMessage?: string | null; windowDays?: number },
): Promise<ProgressWeight> {
  const since = opts?.windowDays && opts.windowDays > 0
    ? new Date(Date.now() - opts.windowDays * 86_400_000)
    : null;

  const askedThemselves = mentionsForbidden(String(opts?.clientMessage || ""), user?.doNotMention);
  const withheld = !askedThemselves && mentionsForbidden("weight scale weigh", user?.doNotMention);
  // THE READ DOES NOT HAPPEN WHEN IT IS NOT OURS TO SAY. Returning nulls after querying would
  // still leave the rows one careless destructure away from a caller; not asking is the honest
  // shape of standing down, and it is cheaper.
  if (withheld) {
    return { known: false, currentKg: null, changeKg: null, withheld: true, startKg: null, toGoalKg: null, spanDays: 0, points: [] };
  }

  const rows = await db.select({ weight: weightLogs.weight, at: weightLogs.loggedAt })
    .from(weightLogs)
    .where(since ? and(eq(weightLogs.userId, user.id), gte(weightLogs.loggedAt, since)) : eq(weightLogs.userId, user.id))
    .orderBy(weightLogs.loggedAt);

  const points = (rows as Array<{ weight: unknown; at: Date | null }>)
    .map(r => ({ kg: Number(r.weight), at: new Date(r.at as Date) }))
    .filter(p => Number.isFinite(p.kg));

  const change = weightChangeKg(rows as Array<{ weight: unknown }>);
  const latest = points.length ? points[points.length - 1].kg : NaN;
  const spanDays = points.length >= 2
    ? Math.max(1, Math.round((points[points.length - 1].at.getTime() - points[0].at.getTime()) / 86_400_000))
    : 0;

  // THE DISTANCE BELONGS TO THE SCALE'S OWNER (2026-08-27, live: "How far am I from my goal?").
  //
  // GOAL_DISTANCE answered that question with a progress recital — change since start, sessions
  // this week, protein today — and closed on "That's the distance" while never naming the target
  // or the gap. The fact was not missing from the system; it was missing from the one reader that
  // holds both halves. It is computed here rather than at the mouth because three inline copies of
  // this arithmetic already exist (trajectory.ts, handlers/weight.ts, scheduler/jobs/monday.ts)
  // and a fourth at a call site is how that happens a fifth time.
  const targetKg = Number(user?.targetWeightKg);
  const toGoalKg = Number.isFinite(latest) && Number.isFinite(targetKg) && targetKg > 0
    ? Math.round((targetKg - latest) * 10) / 10
    : null;

  return {
    known: change !== null,
    currentKg: Number.isFinite(latest) ? latest : null,
    changeKg: change,
    withheld: false,
    startKg: points.length ? points[0].kg : null,
    toGoalKg,
    spanDays,
    points,
  };
}

export interface ProgressTruth {
  today: DayLedger;
  window: WindowTotals;
  sessions: number;
  avgSteps: number;
  /** Steps SUMMED over the window, not averaged. The all-time card reported a journey total from
   *  its own SUM(steps); this is the same number from the same source as everything else. */
  totalSteps: number;
  /** Whole days since programmeStartDate. Derived here so nothing derives it twice — the old
   *  all-time and weekly blocks each computed their own and printed "Day 35, week 1". */
  daysOnProgramme: number;
  weight: ProgressWeight;
  /** How much of this window we actually KNOW — db / label / ai / photo / unknown, and the
   *  confidence that falls out of it. Known / likely / unknown, measured rather than asserted. */
  provenance: FoodProvenance;
}

/**
 * WHICH SAST DAY A ROW BELONGS TO, IN SQL (2026-08-25, P0-5 · food).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS EXISTS TO STOP
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `sastDayKey` has owned "which day is this" in TypeScript since the SAST cut. A query that
 * GROUPs BY day answers the same question in SQL, and there were three different answers to it
 * in this repo, measured on main@86f1c1e1:
 *
 *   early-commands.ts   DATE(logged_at + INTERVAL '2 hours')            SAST ✓
 *   food-scanner.ts     to_char(logged_at + interval '2 hours', …)      SAST ✓
 *   gpt.ts  (×2)        DATE(logged_at)                                 UTC  ✗
 *
 * South Africa is UTC+2 and observes no DST, so `DATE(logged_at)` on a UTC timestamp is the UTC
 * calendar day. A meal eaten between 22:00 and 23:59 UTC — that is 00:00 to 01:59 SAST, an
 * ordinary late supper here — is pulled BACK into the previous day's bucket. Two SAST days become
 * one, which changes both the daily totals and the number of days they are averaged over:
 *
 *   dinner 21:00 SAST (70g) + late snack 00:30 SAST (50g), target 140g
 *     SAST (owner)  →  2 logged days, avg  60g, 0 days at ≥80% of target
 *     UTC  (gpt.ts) →  1 logged day,  avg 120g, 1 day  at ≥80% of target
 *
 * Those two numbers reach the model as "Average protein logged is …" and as protCompliance28,
 * which drives the trajectory label. The Coach reads the client's week differently depending on
 * which of the three rules the query happened to use.
 *
 * THIS IS THE SECOND TIME. client-snapshot.ts carries a comment dated 2026-08-13 describing the
 * identical bug — "this file grouped the protein average by UTC and the 7-day story by SAST" —
 * and fixing it there is what this repo does instead of fixing the rule. So the rule now has one
 * home, and GUARD #16 refuses a second spelling of it.
 *
 * Returns text (YYYY-MM-DD) so it matches sastDayKey's output exactly, and so a caller can join
 * or compare against a TypeScript day key without a cast.
 */
/**
 * WHAT A RETROACTIVELY ATTRIBUTED SESSION CHANGES (2026-08-25, P0-5 · workout).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE CONTRACT, AND WHERE IT CAME FROM
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Five paths write a session row. They disagreed about what else changes, so this states the
 * rule once — derived from what the paths already agreed on, plus the reasons workout.ts had
 * already written down beside its own retro write:
 *
 *   workoutLogs             the caller inserts it. Idempotent per day; not this function's job.
 *   totalWorkoutsCompleted  +N. A session really happened, and the lifetime count is a fact
 *                           about the past rather than a claim about today.
 *   lastWorkoutDate         MAX(held, newest attributed day). It is a max over real events, so
 *                           logging Monday cannot overwrite a Wednesday already on the record.
 *   programmeWeek / DayInWeek   NEVER. (P0-3.) Which session is due TODAY is decided by the
 *                           schedule and by what was done today; a backfill answers neither.
 *   workoutStreak           NEVER incremented here. The live rule is `wasYesterday ? +1 : 1`,
 *                           which is only valid for a write about today — a backfilled Tuesday
 *                           cannot be folded in by incrementing. A correct historical streak has
 *                           to be DERIVED from the ledger, which is a different owner and a
 *                           different question. Both retro paths already left it alone; this
 *                           makes that the stated rule rather than an accident.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE TWO DEFECTS IT CLOSES
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 *   backfillAttributedDays  wrote the ledger row and touched `users` not at all — so a multi-day
 *                           report moved workoutLogs and left totalWorkoutsCompleted behind, and
 *                           two readers answered "how many sessions have I done" differently.
 *   the multi-day retro     set `lastWorkoutDate: last` UNCONDITIONALLY. Reporting a batch of old
 *                           days moved the field BACKWARD past a more recent session. The guard
 *                           for exactly this already existed 65 lines above it, in the sibling
 *                           single-day path, and was not used.
 *
 * One owner rather than three patches, because three call sites each re-deriving the rule is
 * precisely how they came to disagree.
 */
export async function applyRetroSessionState(
  user: { id?: string; phoneNumber?: string | null; totalWorkoutsCompleted?: number | null; lastWorkoutDate?: Date | string | null },
  attributedDays: Date[],
): Promise<{ total: number; lastWorkoutDate: Date | null }> {
  const held = user.lastWorkoutDate ? new Date(user.lastWorkoutDate) : null;
  if (attributedDays.length === 0) {
    return { total: Number(user.totalWorkoutsCompleted) || 0, lastWorkoutDate: held };
  }
  const total = (Number(user.totalWorkoutsCompleted) || 0) + attributedDays.length;
  const newest = attributedDays.reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
  const advances = !held || newest.getTime() > held.getTime();
  const lastWorkoutDate = advances ? newest : held;

  await db.update(users).set({
    totalWorkoutsCompleted: total,
    lastActiveAt: new Date(),
    ...(advances ? { lastWorkoutDate: newest } : {}),
  }).where(user.id ? eq(users.id, user.id) : eq(users.phoneNumber, String(user.phoneNumber || "")));

  return { total, lastWorkoutDate };
}

export function sastDayBucketSql(col: AnyPgColumn) {
  return sql<string>`to_char(${col} + interval '2 hours', 'YYYY-MM-DD')`;
}

/**
 * THE AUTHORITATIVE TRAINING COUNT, ON ITS OWN (2026-08-22, P0-A).
 *
 * getProgressTruth already ran this query, but only a turn that happened to need a full progress
 * read got the number — and the reply boundary cannot decline to check a training claim just
 * because the turn took a different route to the model. This is the same query, callable by the
 * one place that must never accept an unevidenced count, and getProgressTruth calls it too so
 * there is still exactly one definition of "how many sessions in the last N days".
 */
export async function sessionsSince(userId: string, days: number): Promise<number> {
  const [row] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(workoutLogs)
    .where(and(eq(workoutLogs.userId, userId), gte(workoutLogs.loggedAt, new Date(Date.now() - days * 86_400_000))));
  return Number((row as any)?.n || 0);
}

/** This SAST Monday–Sunday, not a rolling 7 days. */
export async function sessionsThisCalendarWeek(userId: string, at?: Date | number): Promise<number> {
  const { sastWeekStart } = await import("./sast");
  const [row] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(workoutLogs)
    .where(and(eq(workoutLogs.userId, userId), gte(workoutLogs.loggedAt, sastWeekStart(at))));
  return Number((row as any)?.n || 0);
}

export async function getProgressTruth(
  user: any,
  opts?: { days?: number; clientMessage?: string | null; weightWindowDays?: number },
): Promise<ProgressTruth> {
  const days = opts?.days && opts.days > 0 ? opts.days : 7;
  const since = new Date(Date.now() - days * 86_400_000);
  // The weight window is SEPARATE from the activity window, and defaults to the whole journey.
  // A seven-day card wants "since you started"; the Sunday recap measured its change over
  // fourteen days with its own query. Making it a parameter of the one owner is what let that
  // query go, without changing what either surface says (2026-08-21).
  const weightSince = opts?.weightWindowDays && opts.weightWindowDays > 0
    ? new Date(Date.now() - opts.weightWindowDays * 86_400_000)
    : null;

  const [today, windowRows, sessions, stepRows, weight] = await Promise.all([
    getDayLedger(user.id, { user }),
    db.select({
      label: mealLogs.mealLabel, kcal: mealLogs.kcalInt, protein: mealLogs.proteinInt,
      carbs: mealLogs.carbsInt, fat: mealLogs.fatInt, loggedAt: mealLogs.loggedAt,
      source: mealLogs.source, items: mealLogs.items, rawMessage: mealLogs.rawMessage,
    }).from(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, since))),
    sessionsSince(user.id, days),
    db.select({
      avg: sql<number>`COALESCE(AVG(${stepLogs.steps}),0)::int`,
      total: sql<number>`COALESCE(SUM(${stepLogs.steps}),0)::int`,
    }).from(stepLogs)
      .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, since))),
    // ONE DEFINITION OF WHAT THE SCALE SAYS (2026-08-25). This was the weight query, the
    // don't-mention check and the change arithmetic, inline — the only copy that honoured the
    // client's request, which is why four other surfaces could speak a figure it had withheld.
    getWeightTruth(user, { clientMessage: opts?.clientMessage, windowDays: opts?.weightWindowDays }),
  ]);

  const window = foldWindowRows(windowRows as LedgerRow[], days, d => sastDayKey(d));
  // The SAME rows, characterised. report-card ran a second query for exactly this.
  const provenance = summariseProvenance(
    (windowRows as any[]).map(r => ({ kcal: Number(r.kcal) || 0, items: r.items, source: r.source })),
  );

  // THE TRAINING COUNT WE ACTUALLY HOLD, left on the turn (2026-08-22). Exactly what the step
  // read above does, for exactly the same reason: the mouth has to be able to tell a recital from
  // an invention. This query already ran; nothing extra is asked of the database. The WINDOW rides
  // along because the number is meaningless without it — a 7-day count is not a calendar month
  // and not an all-time total, and a claim that names the wrong window is wrong even when the
  // digits match.
  turnEvidence({ sessionsWindow: sessions, sessionsWindowDays: days });

  return {
    today,
    window,
    sessions,
    avgSteps: Number((stepRows[0] as any)?.avg || 0),
    totalSteps: Number((stepRows[0] as any)?.total || 0),
    daysOnProgramme: daysOnProgramme(user),
    provenance,
    weight,
  };
}

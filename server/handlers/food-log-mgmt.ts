/**
 * Food log management commands — reset, remove last, remove specific, show log.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { users, chatHistory, mealLogs } from "../../shared/schema";
import { eq, and, gte, desc, asc } from "drizzle-orm";
import { sastDayStart, sastToday, looksLikeQuestion, parseQuantityCorrection } from "../utils";
import { recomputeTodayFoodTotals, invalidateFoodTotalsCache } from "./food-scanner";

export async function handleFoodLogMgmt(user: any, m: string): Promise<string | null> {

  // ---- CONFIRM-GATE for "reset today's food" — wiping the whole day now asks first ----
  if (user.awaitingInputType === "food_reset_confirm") {
    await db.update(users).set({ awaitingInputType: null }).where(eq(users.id, user.id));
    if (/^(yes|yep|yeah|confirm|wipe|do it|clear it|reset|yes wipe)\b/i.test(m.trim())) {
      invalidateFoodTotalsCache(user.id);
      const resetStart = sastDayStart();
      await db.update(users).set({ todayCalories: 0, todayProteinG: 0, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
      await Promise.all([
        db.delete(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, resetStart))).catch(e => console.warn("[non-fatal] clear meal_logs:", e)),
        db.delete(chatHistory).where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, resetStart))).catch(e => console.warn("[non-fatal] clear chat food log:", e)),
      ]);
      return `Done — today's food log is wiped, counter back to 0. Tell me what you ate to start fresh.`;
    }
    if (/^(no|nope|cancel|keep|stop|don.?t|nvm|nevermind|never mind)\b/i.test(m.trim())) {
      return `Kept your meals. 👍 Nothing was deleted.`;
    }
    return null; // not a confirm/cancel — reset cancelled (flag cleared), process the message normally
  }

  // ---- INGREDIENT NEGATION — "toast has no butter", "there's no oil", "without mayo" ----
  // Catches negative corrections of assumed/hallucinated ingredients BEFORE the food scanner
  // can re-log them as new food entries. Must run before the hasMgmtKeyword quick-exit.
  const DENIED_INGREDIENT_RE = /\b(butter|margarine|oil|mayo(?:nnaise)?|sugar|cream|sauce|gravy|dressing|spread)\b/i;
  const NEGATION_CUES_RE = /\b(has?\s+no\b|have\s+no\b|there.?s\s+no\b|there\s+is\s+no\b|without\b|didn.?t\s+(?:add|put|use|have|spread)\b|no\s+\w+\s+(?:on|in)\b)/i;

  if (DENIED_INGREDIENT_RE.test(m) && NEGATION_CUES_RE.test(m)) {
    const denied = (DENIED_INGREDIENT_RE.exec(m) || [])[0]?.trim().toLowerCase();
    if (denied) {
      try {
        const todayStart = sastDayStart();
        const todayMealLogs = await db.select({
          id: mealLogs.id, rawMessage: mealLogs.rawMessage, items: mealLogs.items,
          kcalInt: mealLogs.kcalInt, proteinInt: mealLogs.proteinInt,
        })
          .from(mealLogs)
          .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart)))
          .orderBy(desc(mealLogs.loggedAt))
          .limit(10);

        const targetLog = todayMealLogs.find(l => {
          const raw = (l.rawMessage || "").toLowerCase();
          if (raw.includes(denied)) return true;
          const logItems = l.items as Array<{ name?: string }> | null;
          return Array.isArray(logItems) && logItems.some(i =>
            (i.name || "").toLowerCase().includes(denied)
          );
        });

        if (targetLog) {
          const logItems = (targetLog.items as Array<{ name?: string; kcal?: number; protein?: number }> | null) || [];
          const deniedItem = logItems.find(i => (i.name || "").toLowerCase().includes(denied));

          if (deniedItem && logItems.length > 1) {
            // Subtract just the denied ingredient — keep the rest of the meal
            const newItems = logItems.filter(i => i !== deniedItem);
            const newKcal = Math.max(0, targetLog.kcalInt - (deniedItem.kcal || 0));
            const newProt = Math.max(0, targetLog.proteinInt - (deniedItem.protein || 0));
            await db.update(mealLogs).set({ kcalInt: newKcal, proteinInt: newProt, items: newItems }).where(eq(mealLogs.id, targetLog.id));
          } else {
            // Denied item is the whole meal (or items not stored) — delete the log entry
            await db.delete(mealLogs).where(eq(mealLogs.id, targetLog.id));
          }

          invalidateFoodTotalsCache(user.id);
          const recomputed = await recomputeTodayFoodTotals(user.id);
          await db.update(users)
            .set({ todayCalories: recomputed.calories, todayProteinG: recomputed.protein, todayCaloriesDate: sastToday() })
            .where(eq(users.id, user.id));
          const calTarget = user.calorieTarget || 1800;
          const protTarget = user.proteinTarget || 120;
          const remaining = calTarget - recomputed.calories;
          const protRem = protTarget - recomputed.protein;
          const remainingLine = remaining >= 0
            ? `Remaining: ~${remaining} kcal | ~${Math.max(0, protRem)}g protein still to go.`
            : `Over target by ~${Math.abs(remaining)} kcal.`;
          return `Got it — ${denied} removed from your log. ✅\n\nUpdated total today: ~${recomputed.calories} kcal | ~${recomputed.protein}g protein.\n\n${remainingLine}`;
        }
        // Not found in any log today — fall through without handling
      } catch (err) {
        console.error("[FOOD_NEGATION]", err);
      }
    }
  }

  // ---- QUANTITY CORRECTION — "2 eggs not 3", "it was 2 slices not 4" ----
  // Must run BEFORE the quick-exit: these carry no mgmt keyword, so they fell
  // through to the food scanner which logged the corrected text as a brand-NEW
  // meal — the correction became a double-count (2026-07-06 audit).
  const qc = !looksLikeQuestion(m) ? parseQuantityCorrection(m) : null;
  if (qc) {
    try {
      const todayStartQC = sastDayStart();
      const foodSingular = qc.food.replace(/e?s$/, "");
      const rowsQC = await db.select({ id: mealLogs.id, rawMessage: mealLogs.rawMessage, items: mealLogs.items, kcalInt: mealLogs.kcalInt, proteinInt: mealLogs.proteinInt })
        .from(mealLogs)
        .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStartQC)))
        .orderBy(desc(mealLogs.loggedAt))
        .limit(10);
      const targetQC = rowsQC.find(r => {
        if ((r.rawMessage || "").toLowerCase().includes(foodSingular)) return true;
        const its = r.items as Array<{ name?: string; foodName?: string }> | null;
        return Array.isArray(its) && its.some(i => (i.name || i.foodName || "").toLowerCase().includes(foodSingular));
      });
      if (targetQC) {
        const itemsQC = (targetQC.items as Array<{ name?: string; foodName?: string; kcal?: number; protein?: number }> | null) || [];
        const itemQC = itemsQC.find(i => (i.name || i.foodName || "").toLowerCase().includes(foodSingular));
        if (itemQC && typeof itemQC.kcal === "number" && itemQC.kcal > 0) {
          // Exact item-level maths: scale the corrected item by newCount/oldCount.
          const ratio = qc.count / qc.oldCount;
          const newItemKcal = Math.round(itemQC.kcal * ratio);
          const newItemProt = Math.round((itemQC.protein || 0) * ratio);
          const newKcalQC = Math.max(0, (targetQC.kcalInt || 0) - itemQC.kcal + newItemKcal);
          const newProtQC = Math.max(0, (targetQC.proteinInt || 0) - (itemQC.protein || 0) + newItemProt);
          const newItemsQC = itemsQC.map(i => i === itemQC ? { ...i, kcal: newItemKcal, protein: newItemProt } : i);
          await db.update(mealLogs).set({ kcalInt: newKcalQC, proteinInt: newProtQC, items: newItemsQC }).where(eq(mealLogs.id, targetQC.id));
          invalidateFoodTotalsCache(user.id);
          const recQC = await recomputeTodayFoodTotals(user.id);
          await db.update(users).set({ todayCalories: recQC.calories, todayProteinG: recQC.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
          return `Fixed — ${qc.food} corrected to ${qc.count}. ✅\n\nUpdated total today: ~${recQC.calories} kcal | ~${recQC.protein}g protein.`;
        }
        // No per-item numbers to scale — honest remove-and-relog beats silent bad maths
        // or a double-logged "correction".
        await db.delete(mealLogs).where(eq(mealLogs.id, targetQC.id));
        invalidateFoodTotalsCache(user.id);
        const recQC2 = await recomputeTodayFoodTotals(user.id);
        await db.update(users).set({ todayCalories: recQC2.calories, todayProteinG: recQC2.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
        return `That entry had the wrong count, so I removed it. ✅ Send the corrected meal — e.g. "${qc.count} ${qc.food}" plus whatever else was in it — and I'll log it right.\n\nToday now: ~${recQC2.calories} kcal | ~${recQC2.protein}g protein.`;
      }
      return `I don't see ${qc.food} in today's log to correct. Send *my meals* to check what's logged.`;
    } catch (err) {
      console.error("[QTY_CORRECTION]", err);
    }
  }

  // Quick-exit: if message has no management keywords at all, skip the whole handler
  const hasMgmtKeyword = /\b(remove|delete|undo|clear|reset|wipe|scratch|take out|take off|didn.?t (have|eat)|did not (have|eat)|get rid of|cancel.*meal|wrong meal|mistake.*log|log.*mistake|not.*eat|never ate|no\s+just)\b/i.test(m);
  if (!hasMgmtKeyword) return null;

  // ---- CORRECTION: "No just [food]" — remove last meal, prompt to re-log ----
  const noJustMatch = m.match(/^no[,!]?\s+just\s+(.{2,40})$/i);
  if (noJustMatch) {
    const todayStart = sastDayStart();
    const lastMealLog = await db.select({ id: mealLogs.id })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart)))
      .orderBy(desc(mealLogs.loggedAt))
      .limit(1);
    if (lastMealLog.length > 0) {
      await db.delete(mealLogs).where(eq(mealLogs.id, lastMealLog[0].id));
      invalidateFoodTotalsCache(user.id);
      const recomputed = await recomputeTodayFoodTotals(user.id);
      await db.update(users).set({ todayCalories: recomputed.calories, todayProteinG: recomputed.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
      const foodName = noJustMatch[1].trim();
      return `Got it — removed the last entry. ✅\n\nNow tell me exactly what you had and I'll log it. You can say: "had ${foodName}".`;
    }
  }

  // ---- RESET ALL OF TODAY'S FOOD ----
  // "remove/delete/undo LAST meal" must NOT match here — that is a single-entry
  // removal handled by isRemoveLast below. Having it in this branch wiped the
  // client's entire day when they asked to remove one meal (caught by routing-audit).
  // "clear.*today" was removed — too broad (matched "clear my schedule today").
  // All real food-clear intents are already covered by the food-specific patterns below.
  if (/\b(reset.*calori|clear.*food|clear.*log|clear.*calori|start.*fresh|reset.*food|reset.*log|wipe.*food|wipe.*log|remove.*meals?\s*today|delete.*meals?\s*today|remove.*today.*meals?|clear.*meals?\s*today)\b/i.test(m) &&
      !/\b(last|previous)\s+(meal|entry|one|log)\b/i.test(m)) {
    // Confirm before wiping the whole day — this used to delete everything instantly on a
    // phrase like "start fresh", with no undo. Ask first; the confirm-gate above does the wipe.
    const todayStart = sastDayStart();
    const todayMeals = await db.select({ id: mealLogs.id }).from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart)));
    if (todayMeals.length === 0) {
      return `Nothing logged today yet — nothing to clear. Just tell me what you ate.`;
    }
    await db.update(users).set({ awaitingInputType: "food_reset_confirm" }).where(eq(users.id, user.id));
    return `That wipes *all ${todayMeals.length} of today's ${todayMeals.length === 1 ? "meal" : "meals"}* and resets your counter to 0 — it can't be undone. Reply *yes wipe* to confirm, or anything else to keep them.`;
  }

  // ---- MULTI-MEAL REMOVAL — "remove both meals", "the two previous meals", "last 3 meals" ----
  // A wrong-log cascade leaves 2-3 bad entries; one-at-a-time removal is exactly when a
  // frustrated client gives up (production cascade, 2026-07-02).
  const multiRemove = m.match(/\b(?:remove|delete|undo|take\s+(?:off|out)|get\s+rid\s+of)\b[^.!?]*\b(both|two|three|last\s*(?:2|3|two|three)|2|3)\b[^.!?]*\bmeals?\b/i);
  if (multiRemove) {
    const n = /three|3/i.test(multiRemove[1]) ? 3 : 2;
    const todayStartMR = sastDayStart();
    const rowsMR = await db.select({ id: mealLogs.id, rawMessage: mealLogs.rawMessage })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStartMR)))
      .orderBy(desc(mealLogs.loggedAt))
      .limit(n);
    if (rowsMR.length === 0) return `No meals logged today to remove.`;
    for (const r of rowsMR) await db.delete(mealLogs).where(eq(mealLogs.id, r.id));
    invalidateFoodTotalsCache(user.id);
    const recMR = await recomputeTodayFoodTotals(user.id);
    await db.update(users).set({ todayCalories: recMR.calories, todayProteinG: recMR.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
    return `Removed the last ${rowsMR.length} meal${rowsMR.length > 1 ? "s" : ""} ✅\n${rowsMR.map(r => `• ${(r.rawMessage || "meal").slice(0, 45)}`).join("\n")}\n\nToday now: ~${recMR.calories} kcal | ~${recMR.protein}g protein.`;
  }

  // ---- REMOVE BY NUMBER — "remove 1 and 3" (pairs with the numbered list below) ----
  const idxRemove = m.trim().match(/^(?:remove|delete)\s+(?:meals?\s+|numbers?\s+)?(\d)(?:\s*(?:,|and|&)\s*(\d))?(?:\s*(?:,|and|&)\s*(\d))?$/i);
  if (idxRemove) {
    const todayStartIR = sastDayStart();
    const rowsIR = await db.select({ id: mealLogs.id, rawMessage: mealLogs.rawMessage })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStartIR)))
      .orderBy(asc(mealLogs.loggedAt))
      .limit(15);
    const picks = [idxRemove[1], idxRemove[2], idxRemove[3]].filter(Boolean).map(x => parseInt(x!, 10));
    const chosen = picks.map(p => rowsIR[p - 1]).filter(Boolean);
    if (chosen.length === 0) return `Those numbers don't match today's log — send *my meals* for the numbered list, then e.g. *remove 1 and 3*.`;
    for (const r of chosen) await db.delete(mealLogs).where(eq(mealLogs.id, r.id));
    invalidateFoodTotalsCache(user.id);
    const recIR = await recomputeTodayFoodTotals(user.id);
    await db.update(users).set({ todayCalories: recIR.calories, todayProteinG: recIR.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
    return `Removed ${chosen.length} meal${chosen.length > 1 ? "s" : ""} ✅\n${chosen.map(r => `• ${(r.rawMessage || "meal").slice(0, 45)}`).join("\n")}\n\nToday now: ~${recIR.calories} kcal | ~${recIR.protein}g protein.`;
  }

  // ---- FUZZY MULTI-REMOVE — "the other meals", "meals you mistakenly logged" ----
  // Never guess which ones "the other meals" are: show today's numbered log and let
  // the client point. One message each way beats deleting the wrong entry.
  if (/\b(?:remove|delete|undo|fix)\b[^.!?]*\b(other|mistaken(?:ly)?|wrong(?:ly)?|extra)\b[^.!?]*\b(meals?|logs?|entries)\b/i.test(m)
    || /\b(?:remove|delete)\b[^.!?]*\bmeals?\b[^.!?]*\bmistaken/i.test(m)) {
    const todayStartFZ = sastDayStart();
    const rowsFZ = await db.select({ rawMessage: mealLogs.rawMessage, kcalInt: mealLogs.kcalInt })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStartFZ)))
      .orderBy(asc(mealLogs.loggedAt))
      .limit(15);
    if (rowsFZ.length === 0) return `Nothing logged today yet — we're starting clean.`;
    const listFZ = rowsFZ.map((r, i) => `${i + 1}. ${(r.rawMessage || "meal").slice(0, 45)} (~${r.kcalInt || 0} kcal)`).join("\n");
    return `Let's fix it properly. Today's log:\n${listFZ}\n\nTell me exactly which to remove — e.g. *remove 1 and 3* — and it's done.`;
  }

  // ---- REMOVE MEAL BY TIME LABEL — "remove breakfast meal", "delete my lunch" ----
  const mealTimeRemoveMatch = m.trim().match(/^(?:remove|delete|undo)\s+(?:my\s+)?(breakfast|lunch|dinner|supper|snack)\s*(?:meal|log|entry)?$/i);
  if (mealTimeRemoveMatch) {
    const label = mealTimeRemoveMatch[1].toLowerCase();
    const todayStart = sastDayStart();
    const mealLogRows = await db.select({ id: mealLogs.id, rawMessage: mealLogs.rawMessage, mealLabel: mealLogs.mealLabel })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart)))
      .orderBy(desc(mealLogs.loggedAt))
      .limit(10);
    const target = mealLogRows.find(l =>
      (l.mealLabel || "").toLowerCase().includes(label) ||
      (l.rawMessage || "").toLowerCase().includes(label)
    );
    // Never fall back to deleting the most-recent meal — silently removing the
    // wrong entry corrupts the day's totals while telling the client otherwise.
    if (!target) {
      return mealLogRows.length > 0
        ? `I couldn't find a "${label}" entry in today's log, so I haven't deleted anything — I won't risk removing the wrong meal. Reply "remove last" to undo your most recent entry, or name the food (e.g. "remove the rice").`
        : `No meal logged yet today to remove.`;
    }
    await db.delete(mealLogs).where(eq(mealLogs.id, target.id));
    invalidateFoodTotalsCache(user.id);
    const recomputed = await recomputeTodayFoodTotals(user.id);
    await db.update(users).set({ todayCalories: recomputed.calories, todayProteinG: recomputed.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
    return `Removed your ${label} from the log. ✅\n\nUpdated total today: ~${recomputed.calories} kcal | ~${recomputed.protein}g protein.\n\nRemaining: ~${Math.max(0, (user.calorieTarget || 1800) - recomputed.calories)} kcal | ~${Math.max(0, (user.proteinTarget || 120) - recomputed.protein)}g protein still to go.`;
  }

  // ---- REMOVE LAST LOGGED MEAL — any natural expression for "that last entry" ----
  // Allow a trailing reason clause: "remove last meal, it was a question" fell into the
  // specific-food matcher and dead-ended on "I don't see 'last meal, it was a question'"
  // (prod, 2026-07-03). Anchor on the removal target, tolerate ", <anything>" after.
  const isRemoveLast = /^(no\s+)?(remove|delete|undo|scratch|take off|take out|get rid of)\s+(it|that|that one|that meal|that entry|last|last one|last meal|last entry|the last|the meal|the last one|the last entry|meal|that food|what i just logged|what i logged)\b(?:\s*[,\-—].*)?$/i.test(m.trim())
    || /^(remove|delete|undo|scratch)$/i.test(m.trim())
    || /\b(scratch that|undo that|take that off|remove that|delete that|that was wrong|wrong entry|wrong meal|logged.*wrong|that.?s a mistake|mistake.*log)\b/i.test(m);
  if (isRemoveLast) {
    // Cutoff spans midnight: a meal logged 23:50 must still be removable at 00:10 —
    // "today only" made the coach refuse the undo right after the day rolled over.
    // During the day this is identical to sastDayStart().
    const todayStart = new Date(Math.min(sastDayStart().getTime(), Date.now() - 2 * 3_600_000));
    const lastMealLog = await db.select({ id: mealLogs.id })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart)))
      .orderBy(desc(mealLogs.loggedAt))
      .limit(1);

    if (lastMealLog.length > 0) {
      await db.delete(mealLogs).where(eq(mealLogs.id, lastMealLog[0].id));
    } else {
      const lastFoodLog = await db.select({ id: chatHistory.id })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)))
        .orderBy(desc(chatHistory.createdAt))
        .limit(1);
      if (lastFoodLog.length === 0) return `No meal logged yet today to remove.`;
      await db.update(chatHistory).set({ intent: "FOOD_LOG_CORRECTED" }).where(eq(chatHistory.id, lastFoodLog[0].id));
    }

    invalidateFoodTotalsCache(user.id);
    const recomputed = await recomputeTodayFoodTotals(user.id);
    await db.update(users).set({ todayCalories: recomputed.calories, todayProteinG: recomputed.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
    return `Removed your last meal log. ✅\n\nUpdated total today: ~${recomputed.calories} kcal | ~${recomputed.protein}g protein.`;
  }

  // ---- REMOVE SPECIFIC FOOD FROM LOG ----
  const removeSpecificMatch = m.match(/\b(?:remove|delete|take out|take off|scratch|get rid of|didn.?t have|did not have|i didn.?t eat|i did not eat|never ate|i never had|i didn.?t log|no )\s+(the\s+)?(.{2,40}?)(?:\s+from|\s+in\s+my|\s+log|$)/i);
  // Reject generic "that/last/meal" captures — those belong to the remove-last path above
  // Allow meal-time words only when followed by a food word (e.g. "remove breakfast pasta")
  const capturedFood = (removeSpecificMatch?.[2] || "").trim().toLowerCase().replace(/\s+(from|in|my|log|today|this).*$/, "");
  const endsWithGeneric = /(^|\s)(last|that|it|this|log)$/.test(capturedFood);
  const isRemoveSpecific = !!removeSpecificMatch && capturedFood.length >= 2 && !endsWithGeneric;
  if (isRemoveSpecific && removeSpecificMatch) {
    const foodToRemove = capturedFood;
    if (foodToRemove.length >= 2) {
      try {
        const todayStart = sastDayStart();
        const mealLogRows = await db.select({ id: mealLogs.id, rawMessage: mealLogs.rawMessage, items: mealLogs.items })
          .from(mealLogs)
          .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart)))
          .orderBy(desc(mealLogs.loggedAt))
          .limit(15);

        const targetMealLog = mealLogRows.find(l => {
          if ((l.rawMessage || "").toLowerCase().includes(foodToRemove)) return true;
          const logItems = l.items as Array<{ name?: string; foodName?: string }> | null;
          return Array.isArray(logItems) && logItems.some(i => (i.name || i.foodName || "").toLowerCase().includes(foodToRemove));
        });

        if (targetMealLog) {
          // ITEM-LEVEL first: "remove the rice" from a "chicken and rice" meal must
          // not delete the chicken too. Deleting the whole row when other items
          // exist silently corrupted the day's totals while claiming success
          // (2026-07-06 audit). Only delete the row when the food IS the meal.
          const rsItems = (targetMealLog.items as Array<{ name?: string; foodName?: string; kcal?: number; protein?: number }> | null) || [];
          const rsItem = rsItems.find(i => (i.name || i.foodName || "").toLowerCase().includes(foodToRemove));
          if (rsItem && rsItems.length > 1 && typeof rsItem.kcal === "number") {
            const rsRow = await db.select({ kcalInt: mealLogs.kcalInt, proteinInt: mealLogs.proteinInt }).from(mealLogs).where(eq(mealLogs.id, targetMealLog.id)).limit(1);
            const newKcalRS = Math.max(0, (rsRow[0]?.kcalInt || 0) - (rsItem.kcal || 0));
            const newProtRS = Math.max(0, (rsRow[0]?.proteinInt || 0) - (rsItem.protein || 0));
            await db.update(mealLogs).set({ kcalInt: newKcalRS, proteinInt: newProtRS, items: rsItems.filter(i => i !== rsItem) }).where(eq(mealLogs.id, targetMealLog.id));
          } else {
            await db.delete(mealLogs).where(eq(mealLogs.id, targetMealLog.id));
          }
          invalidateFoodTotalsCache(user.id);
          const recomputed = await recomputeTodayFoodTotals(user.id);
          await db.update(users).set({ todayCalories: recomputed.calories, todayProteinG: recomputed.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
          const calTarget = user.calorieTarget || 1800;
          const protTarget = user.proteinTarget || 120;
          const calRemaining = calTarget - recomputed.calories;
          const protRemaining = protTarget - recomputed.protein;
          const remainingLine = calRemaining >= 0
            ? `Remaining: ~${calRemaining} kcal | ~${Math.max(0, protRemaining)}g protein still to go.`
            : `Over target by ~${Math.abs(calRemaining)} kcal. Keep the next meal protein-only and skip the starch.`;
          return `Removed ${foodToRemove} from your log. ✅\n\nUpdated total today: ~${recomputed.calories} kcal | ~${recomputed.protein}g protein.\n\n${remainingLine}`;
        } else {
          const todayLogs = await db.select({ id: chatHistory.id, messageIn: chatHistory.messageIn })
            .from(chatHistory)
            .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)))
            .orderBy(desc(chatHistory.createdAt))
            .limit(15);

          const targetLog = todayLogs.find(l => (l.messageIn || "").toLowerCase().includes(foodToRemove));
          if (!targetLog) {
            return `I don't see "${foodToRemove}" in today's food log. Send "my meals" to see what's logged.`;
          }

          const updatedMsg = (targetLog.messageIn || "")
            .replace(new RegExp(`\\b${foodToRemove.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "gi"), "")
            .replace(/,\s*,/g, ",").replace(/^,\s*|,\s*$/g, "").replace(/\s{2,}/g, " ").trim();

          if (!updatedMsg || updatedMsg.length < 3) {
            await db.update(chatHistory).set({ intent: "FOOD_LOG_CORRECTED" }).where(eq(chatHistory.id, targetLog.id));
          } else {
            await db.update(chatHistory).set({ messageIn: updatedMsg }).where(eq(chatHistory.id, targetLog.id));
          }

          invalidateFoodTotalsCache(user.id);
          const recomputedFb = await recomputeTodayFoodTotals(user.id);
          await db.update(users).set({ todayCalories: recomputedFb.calories, todayProteinG: recomputedFb.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
          const calTargetFb = user.calorieTarget || 1800;
          const protTargetFb = user.proteinTarget || 120;
          const calRemainingFb = calTargetFb - recomputedFb.calories;
          const protRemainingFb = protTargetFb - recomputedFb.protein;
          const remainingLineFb = calRemainingFb >= 0
            ? `Remaining: ~${calRemainingFb} kcal | ~${Math.max(0, protRemainingFb)}g protein still to go.`
            : `Over target by ~${Math.abs(calRemainingFb)} kcal. Keep the next meal protein-only and skip the starch.`;
          return `Removed ${foodToRemove} from your log. ✅\n\nUpdated total today: ~${recomputedFb.calories} kcal | ~${recomputedFb.protein}g protein.\n\n${remainingLineFb}`;
        }
      } catch (removeErr) {
        console.error("[REMOVE_FOOD]", removeErr);
        return `Could not update your log right now. Try "remove last meal" or send "my meals" to see what's logged.`;
      }
    }
  }

  // ---- SHOW TODAY'S MEAL LOG ----
  if (/^(show|see|view)\s+(my\s+)?(meal|food)\s+log$|^(meal|food)\s+log$|^what\s+did\s+i\s+log(\s+today)?$/i.test(m.trim()) ||
      /^my\s+meals?$/i.test(m.trim())) {
    const todayStart = sastDayStart();
    const logs = await db.select({
      kcalInt: mealLogs.kcalInt,
      proteinInt: mealLogs.proteinInt,
      mealLabel: mealLogs.mealLabel,
      rawMessage: mealLogs.rawMessage,
      loggedAt: mealLogs.loggedAt,
      source: mealLogs.source,
    }).from(mealLogs).where(and(
      eq(mealLogs.userId, user.id),
      gte(mealLogs.loggedAt, todayStart),
    )).orderBy(asc(mealLogs.loggedAt)).limit(20);

    if (logs.length === 0) return `No food logged yet today. Send your meal and I will track it.`;

    const lines: string[] = [];
    let totalCals = 0;
    let totalProtein = 0;
    for (const l of logs) {
      totalCals += l.kcalInt || 0;
      totalProtein += l.proteinInt || 0;
      const time = l.loggedAt ? new Date(l.loggedAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" }) : "--:--";
      const label = l.mealLabel ? `[${l.mealLabel}] ` : l.source === "photo" ? "[photo] " : "";
      const desc = l.source === "photo" ? "Food photo" : (l.rawMessage || "Meal").slice(0, 70);
      lines.push(`${time} — ${label}${desc} (${l.kcalInt} kcal | ${l.proteinInt}g prot)`);
    }
    const calorieTarget = user.calorieTarget || 1800;
    const proteinTarget = user.proteinTarget || 120;
    const calRemaining = calorieTarget - totalCals;
    const protRemaining = proteinTarget - totalProtein;
    const remainingLine = calRemaining >= 0
      ? `Remaining: ~${calRemaining} kcal | ~${Math.max(0, protRemaining)}g protein`
      : `Over target by ~${Math.abs(calRemaining)} kcal`;
    return `*Today's meals (${logs.length})*\n${lines.map(x => `• ${x}`).join("\n")}\n\n*Total:* ~${totalCals} kcal | ~${totalProtein}g protein\n${remainingLine}`;
  }

  return null;
}

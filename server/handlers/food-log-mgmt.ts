/**
 * Food log management commands — reset, remove last, remove specific, show log.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { users, chatHistory, mealLogs } from "../../shared/schema";
import { eq, and, gte, lt, desc, asc } from "drizzle-orm";
import { sastDayStart, sastToday, looksLikeQuestion, parseQuantityCorrection, isRetroactiveMeal, parseMealDate, mealDateLabel } from "../utils";
import { foodMatchesText, singularFood, perServingEstimate } from "../serving-units";
import { goalStatusLine } from "../education";
import { recomputeTodayFoodTotals, invalidateFoodTotalsCache, weeklyNetLine, scanForSAFoods, dropMeals } from "./food-scanner";
import { parseIdentityCorrection, correctionCandidates, holdForReplacement, isMealDateMove, planCorrection, applyCorrection, parseDropLoggedItem, type IdentityCorrection } from "../food-identity-correction";

import { UNAVAILABLE_RE } from "../food-swaps";
import { turnMutation, turnState } from "./chat-log";

export async function handleFoodLogMgmt(user: any, m: string): Promise<string | null> {
  // THE SHOP IS NOT THE FOOD LOG (2026-08-05). "They didn't have chicken at the shop" was read
  // as a removal request and answered «I don't see "chicken at the shop" in today's food log» —
  // a client telling us what the shop was out of, told their own log disagrees. "Didn't have"
  // is about a shelf, not an entry, and this handler owns entries. Stand down and let the
  // substitution table answer it.
  // ONE OWNER for "did the shop let them down" — food-swaps.ts holds the pattern; this handler
  // asks it rather than keeping a second copy that would drift within a week.
  if (UNAVAILABLE_RE.test(m) && !/\b(remove|delete|undo|clear|reset|wipe)\b/i.test(m)) {
    return null;
  }

  // ---- CONFIRM-GATE for "reset today's food" — wiping the whole day now asks first ----
  if (user.awaitingInputType === "food_reset_confirm") {
    await db.update(users).set({ awaitingInputType: null }).where(eq(users.id, user.id));
    if (/^(yes|yep|yeah|confirm|wipe|do it|clear it|reset|yes wipe)\b/i.test(m.trim())) {
      invalidateFoodTotalsCache(user.id);
      const resetStart = sastDayStart();
      // Through dropMeals like every other removal — this is the branch that can empty a whole
      // day, so it is the one that most needs to say in the log exactly what it emptied.
      const wipeIds = await db.select({ id: mealLogs.id }).from(mealLogs)
        .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, resetStart))).catch(() => []);
      // chatHistory first: recomputeTodayFoodTotals falls back to legacy FOOD_LOG rows when the
      // ledger reads zero, so wiping the rows before the history would resync the day to the
      // legacy total instead of to nothing.
      await db.delete(chatHistory).where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, resetStart)))
        .catch(e => console.warn("[non-fatal] clear chat food log:", e));
      await dropMeals(user.id, wipeIds.map(r => r.id), "day-wipe-confirmed");
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

          const dropIds: string[] = [];
          if (deniedItem && logItems.length > 1) {
            // Subtract just the denied ingredient — keep the rest of the meal
            const newItems = logItems.filter(i => i !== deniedItem);
            const newKcal = Math.max(0, targetLog.kcalInt - (deniedItem.kcal || 0));
            const newProt = Math.max(0, targetLog.proteinInt - (deniedItem.protein || 0));
            await db.update(mealLogs).set({ kcalInt: newKcal, proteinInt: newProt, items: newItems, corrected: true }).where(eq(mealLogs.id, targetLog.id));
          } else {
            // Denied item is the whole meal (or items not stored) — the entry goes
            dropIds.push(targetLog.id);
          }
          const recomputed = await dropMeals(user.id, dropIds, "ingredient-negation");
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

  // ---- CORRECTION AS A MUTATION — move, remove, add, replace, retain, in one turn ----
  // Must run before the quick-exit (a correction carries no mgmt keyword). It edits the STORED
  // items, so anything the client did not mention is retained by construction — that is what
  // used to be lost. A single-operation identity correction ("it was tuna not pilchards") is
  // left to applyIdentityCorrection below, which already scales servings properly; this owns
  // compositions and every date move. See food-identity-correction.ts for the semantics.
  const movesDay = isMealDateMove(m, isRetroactiveMeal(m));
  const plan = looksLikeQuestion(m) ? null : planCorrection(m, movesDay);
  if (plan?.isCorrection && (plan.moves || plan.remove.length + plan.add.length >= 2)) {
    const [row] = await db.select({
      id: mealLogs.id, raw: mealLogs.rawMessage, label: mealLogs.mealLabel, at: mealLogs.loggedAt,
      items: mealLogs.items, kcalInt: mealLogs.kcalInt, proteinInt: mealLogs.proteinInt,
    }).from(mealLogs).where(eq(mealLogs.userId, user.id)).orderBy(desc(mealLogs.loggedAt)).limit(1);
    if (row) {
      const resolveFood = (food: string) => {
        const hit = scanForSAFoods(food, { exactOnly: true })[0] || scanForSAFoods(food)[0];
        return hit ? {
          name: hit.name, grams: hit.typicalPortionGrams || 100, kcal: hit.typicalPortionCalories || 0,
          protein: hit.typicalPortionProtein || 0, category: hit.category,
        } : null;
      };
      const stored = (Array.isArray(row.items) ? row.items : []) as Array<{ name?: string; kcal?: number; protein?: number }>;
      const { items: newItems, removed, added } = applyCorrection(stored, plan, resolveFood as any);
      const target = plan.moves ? parseMealDate(m) : (row.at as Date);
      // Totals come from the items when every item carries its own numbers; otherwise the row's
      // stored totals stand, because inventing a total from a partial plate is how a correction
      // turns into a wrong number the client cannot see.
      const priced = newItems.length > 0 && newItems.every(i => typeof i.kcal === "number");
      const newKcal = priced ? newItems.reduce((s, i) => s + (i.kcal || 0), 0) : row.kcalInt;
      const newProt = priced ? newItems.reduce((s, i) => s + (i.protein || 0), 0) : row.proteinInt;
      if (removed.length || added.length || plan.moves) {
        await db.update(mealLogs).set({
          items: newItems as any, kcalInt: newKcal, proteinInt: newProt,
          loggedAt: target, corrected: true,
        }).where(eq(mealLogs.id, row.id));
        invalidateFoodTotalsCache(user.id);
        const recC = await recomputeTodayFoodTotals(user.id);
        await db.update(users).set({ todayCalories: recC.calories, todayProteinG: recC.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
        turnMutation(`CORRECT removed=[${removed}] added=[${added}] day=${String(row.at).slice(0, 10)}→${mealDateLabel(target)} kcal=${row.kcalInt}→${newKcal}`);
        turnState({ storedItems: stored.map(i => i.name), newItems: newItems.map(i => i.name) }, mealDateLabel(target));
        console.log(`[MEAL_CORRECT] ${String(row.id).slice(0, 8)} removed=[${removed}] added=[${added}] `
          + `day=${String(row.at).slice(0, 10)}→${mealDateLabel(target)} kcal=${row.kcalInt}→${newKcal} user=...${String(user.id).slice(-6)}`);
        const plate = newItems.map(i => String(i.name || "")).filter(Boolean).join(", ") || "that meal";
        const when = plan.moves ? ` on ${mealDateLabel(target)}` : "";
        return `Fixed — ${plate}${when}.\n\nToday: ~${recC.calories} kcal | ~${recC.protein}g protein.`;
      }
    }
  }

  // ---- IDENTITY CORRECTION — "the rice was white not brown", "it was tuna not pilchards" ----
  // Runs before the quantity path (that one owns numeric "not"s) and before the quick-exit,
  // since these carry no mgmt keyword. Without it the message reached the meaning engine,
  // which read it as a deletion — see server/food-identity-correction.ts.
  if (!looksLikeQuestion(m) && !parseQuantityCorrection(m)) {
    const ic = parseIdentityCorrection(m);
    if (ic) {
      const fixed = await applyIdentityCorrection(user, ic, m);
      if (fixed) return fixed;
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
      const foodSingular = singularFood(qc.food);
      const rowsQC = await db.select({ id: mealLogs.id, rawMessage: mealLogs.rawMessage, mealLabel: mealLogs.mealLabel, items: mealLogs.items, kcalInt: mealLogs.kcalInt, proteinInt: mealLogs.proteinInt })
        .from(mealLogs)
        .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStartQC)))
        .orderBy(desc(mealLogs.loggedAt))
        .limit(10);
      // Match by the food AND its serving-unit aliases ("slice" ⇒ bread/toast), across the
      // meal label, the raw message and any stored item names — a photo names itself by label.
      const targetQC = rowsQC.find(r => {
        if (foodMatchesText(qc.food, r.rawMessage) || foodMatchesText(qc.food, r.mealLabel)) return true;
        const its = r.items as Array<{ name?: string; foodName?: string }> | null;
        return Array.isArray(its) && its.some(i => foodMatchesText(qc.food, i.name || i.foodName || ""));
      });
      if (targetQC) {
        const itemsQC = (targetQC.items as Array<{ name?: string; foodName?: string; kcal?: number; protein?: number }> | null) || [];
        const itemQC = itemsQC.find(i => foodMatchesText(qc.food, i.name || i.foodName || ""));
        if (itemQC && typeof itemQC.kcal === "number" && itemQC.kcal > 0) {
          // Exact item-level maths: scale the corrected item by newCount/oldCount.
          const ratio = qc.count / qc.oldCount;
          const newItemKcal = Math.round(itemQC.kcal * ratio);
          const newItemProt = Math.round((itemQC.protein || 0) * ratio);
          const newKcalQC = Math.max(0, (targetQC.kcalInt || 0) - itemQC.kcal + newItemKcal);
          const newProtQC = Math.max(0, (targetQC.proteinInt || 0) - (itemQC.protein || 0) + newItemProt);
          const newItemsQC = itemsQC.map(i => i === itemQC ? { ...i, kcal: newItemKcal, protein: newItemProt } : i);
          await db.update(mealLogs).set({ kcalInt: newKcalQC, proteinInt: newProtQC, items: newItemsQC, corrected: true }).where(eq(mealLogs.id, targetQC.id));
          invalidateFoodTotalsCache(user.id);
          const recQC = await recomputeTodayFoodTotals(user.id);
          await db.update(users).set({ todayCalories: recQC.calories, todayProteinG: recQC.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
          return `Fixed — ${qc.food} corrected to ${qc.count}. ✅\n\nUpdated total today: ~${recQC.calories} kcal | ~${recQC.protein}g protein.`;
        }
        // No per-item numbers to scale (photo meals store none). If we have a sensible
        // per-serving portion for this food, apply the count DELTA incrementally — add or
        // remove one serving's worth, leaving the rest of the plate untouched. This is the
        // honest answer to "3 slices not 2": +1 slice, not a rescale of the whole meal.
        const per = perServingEstimate(qc.food);
        if (per) {
          const deltaN = qc.count - qc.oldCount;
          const newKcalD = Math.max(0, (targetQC.kcalInt || 0) + Math.round(deltaN * per.kcal));
          const newProtD = Math.max(0, (targetQC.proteinInt || 0) + Math.round(deltaN * per.protein));
          await db.update(mealLogs).set({ kcalInt: newKcalD, proteinInt: newProtD, corrected: true }).where(eq(mealLogs.id, targetQC.id));
          invalidateFoodTotalsCache(user.id);
          const recQCd = await recomputeTodayFoodTotals(user.id);
          await db.update(users).set({ todayCalories: recQCd.calories, todayProteinG: recQCd.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
          const verb = deltaN > 0 ? "Added" : "Took off";
          const n = Math.abs(deltaN);
          return `${verb} ${n} ${qc.food.replace(/s$/, "")}${n === 1 ? "" : "s"} — now ${qc.count}. ✅\n\nUpdated total today: ~${recQCd.calories} kcal | ~${recQCd.protein}g protein.`;
        }
        // No per-item numbers and no known portion, so the new total cannot be computed here.
        // HOLD, never delete on a promise (2026-08-07): the entry stays exactly as it is until
        // the replacement is written, so a client who never re-sends still has their meal.
        await db.update(users).set({ awaitingInputType: holdForReplacement(targetQC.id, qc.food) }).where(eq(users.id, user.id));
        const recQC2 = await recomputeTodayFoodTotals(user.id);
        return `Wrong count noted — I'm holding that entry until you replace it, so nothing is lost. Send it as "${qc.count} ${qc.food}" plus whatever else was on the plate and I'll swap it in.\n\nStill on today: ~${recQC2.calories} kcal | ~${recQC2.protein}g protein.`;
      }
      return `I don't see ${qc.food} in today's log to correct. Send *my meals* to check what's logged.`;
    } catch (err) {
      console.error("[QTY_CORRECTION]", err);
    }
  }

  // Quick-exit: if message has no management keywords at all, skip the whole handler
  // Set by the referent branch below when two entries match a named-food removal equally
  // well; read by the numbered-list branch, which owns the "tell me which one" answer.
  let ambiguousRemoval = false;
  // "that wasn't a big mac" — drop the invented item from the last meal, no "remove" keyword.
  const dropName = parseDropLoggedItem(m);
  if (dropName) {
    const todayStart = sastDayStart();
    const last = await db.select({
      id: mealLogs.id, items: mealLogs.items, kcalInt: mealLogs.kcalInt, proteinInt: mealLogs.proteinInt, rawMessage: mealLogs.rawMessage,
    }).from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart)))
      .orderBy(desc(mealLogs.loggedAt))
      .limit(1);
    if (last.length === 0) return `Nothing logged today to correct.`;
    const items = Array.isArray(last[0].items) ? [...(last[0].items as any[])] : [];
    const before = items.length;
    const kept = items.filter((i: any) => {
      const n = String(i?.name || i?.foodName || "").toLowerCase();
      return !n.includes(dropName) && !dropName.split(/\s+/).every(w => w.length > 2 && n.includes(w));
    });
    if (kept.length === before) {
      return `I don't see "${dropName}" on the last meal, so I haven't changed the log. Reply "remove last" if the whole entry is wrong.`;
    }
    if (kept.length === 0) {
      const rec = await dropMeals(user.id, [last[0].id], `drop-item:${dropName}`);
      return `Removed ${dropName} — that was the whole last entry. Today now: ~${rec.calories} kcal | ~${rec.protein}g protein.`;
    }
    const kcal = kept.reduce((s: number, i: any) => s + (i.kcal || 0), 0);
    const prot = Math.round(kept.reduce((s: number, i: any) => s + (i.protein || 0), 0));
    await db.update(mealLogs).set({ items: kept, kcalInt: kcal, proteinInt: prot }).where(eq(mealLogs.id, last[0].id));
    invalidateFoodTotalsCache(user.id);
    const rec = await recomputeTodayFoodTotals(user.id);
    turnMutation(`DROP_ITEM ${dropName} from last meal`, `[MEAL_CORRECTION] drop=${dropName}`);
    return `Removed ${dropName} from the last meal. Today now: ~${rec.calories} kcal | ~${rec.protein}g protein.`;
  }

  const hasMgmtKeyword = /\b(remove|delete|undo|clear|reset|wipe|scratch|take out|take off|didn.?t (have|eat)|did not (have|eat)|get rid of|cancel.*meal|wrong meal|mistake.*log|log.*mistake|not.*eat|never ate|no\s+just)\b/i.test(m);
  if (!hasMgmtKeyword) return null;

  // ---- CORRECTION: "No just [food]" — hold the last meal until the replacement lands ----
  // This branch used to delete first and ask second. Same rule as the quantity path above: the
  // row is held, not dropped, because a client who never re-sends must not lose the meal.
  const noJustMatch = m.match(/^no[,!]?\s+just\s+(.{2,40})$/i);
  if (noJustMatch) {
    const todayStart = sastDayStart();
    const lastMealLog = await db.select({ id: mealLogs.id })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart)))
      .orderBy(desc(mealLogs.loggedAt))
      .limit(1);
    if (lastMealLog.length > 0) {
      const foodName = noJustMatch[1].trim();
      await db.update(users).set({ awaitingInputType: holdForReplacement(lastMealLog[0].id, foodName) }).where(eq(users.id, user.id));
      return `Got it — I'm holding that last entry until you replace it, so nothing goes missing. Tell me exactly what it was: "had ${foodName}".`;
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
    const recMR = await dropMeals(user.id, rowsMR.map(r => r.id), "remove-last-n", { expandToGroup: true });
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
    const recIR = await dropMeals(user.id, chosen.map(r => r.id), "remove-by-number");
    return `Removed ${chosen.length} meal${chosen.length > 1 ? "s" : ""} ✅\n${chosen.map(r => `• ${(r.rawMessage || "meal").slice(0, 45)}`).join("\n")}\n\nToday now: ~${recIR.calories} kcal | ~${recIR.protein}g protein.`;
  }

  // ---- FUZZY MULTI-REMOVE — "the other meals", "meals you mistakenly logged" ----
  // Never guess which ones "the other meals" are: show today's numbered log and let
  // the client point. One message each way beats deleting the wrong entry.
  if (ambiguousRemoval
    || /\b(?:remove|delete|undo|fix)\b[^.!?]*\b(other|mistaken(?:ly)?|wrong(?:ly)?|extra)\b[^.!?]*\b(meals?|logs?|entries)\b/i.test(m)
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
    const recomputed = await dropMeals(user.id, [target.id], `remove-by-label:${label}`);
    return `Removed your ${label} from the log. ✅\n\nUpdated total today: ~${recomputed.calories} kcal | ~${recomputed.protein}g protein.\n\nRemaining: ~${Math.max(0, (user.calorieTarget || 1800) - recomputed.calories)} kcal | ~${Math.max(0, (user.proteinTarget || 120) - recomputed.protein)}g protein still to go.`;
  }

  // ---- "THAT MEAL" MEANS THE ONE THEY JUST NAMED ----
  // (2026-08-06, live on the founder's phone, and the worst kind of bug: a destructive action
  // on the wrong target.) He said "The bread, eggs, avocado, and black coffee are inaccurate.
  // Remove that meal." and the rice-and-beef dinner was deleted — the day fell by exactly the
  // 470 kcal of an entry he never mentioned.
  //
  // Why every targeting branch above missed it: they all read what follows the verb. Here the
  // foods are in the sentence BEFORE it, and what follows is "that meal" — a referent, caught
  // by the generic filter and dropped through to remove-last. Correct grammar, wrong meal.
  //
  // So when a removal ask carries a REFERENT and the message names foods anywhere in it, the
  // foods are the target. Scored by how many of the named foods a log actually contains, so a
  // four-food sentence lands on the four-food entry and not on whatever was logged last. A tie
  // or no match falls through to remove-last, unchanged.
  // hasMgmtKeyword (above) is this file's ONE owner for "they asked to remove something" —
  // a second copy of that list is how the two drift apart.
  const saysReferent = /\b(that|this|those|the)\s+(meal|entry|log|one|meals|entries)\b/i.test(m);
  if (hasMgmtKeyword && saysReferent && !looksLikeQuestion(m)) {
    const named = scanForSAFoods(m).map(f => f.name.toLowerCase()).filter(Boolean);
    if (named.length > 0) {
      const rowsNM = await db.select({ id: mealLogs.id, rawMessage: mealLogs.rawMessage, items: mealLogs.items, kcalInt: mealLogs.kcalInt })
        .from(mealLogs)
        .where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, sastDayStart())))
        .orderBy(desc(mealLogs.loggedAt))
        .limit(15);
      const score = (row: typeof rowsNM[number]) => {
        const hay = `${row.rawMessage || ""} ${(Array.isArray(row.items) ? row.items : [])
          .map((i: any) => i?.name || i?.foodName || "").join(" ")}`.toLowerCase();
        return named.filter(n => hay.includes(n)).length;
      };
      const ranked = rowsNM.map(r => ({ r, n: score(r) })).sort((a, b) => b.n - a.n);
      const best = ranked[0];
      const tied = ranked.filter(x => x.n === best?.n).length > 1;
      if (best && best.n > 0 && !tied) {
        const recNM = await dropMeals(user.id, [best.r.id], `named-foods:${best.n}-matched`);
        return `Removed that one — *${(best.r.rawMessage || "the meal").slice(0, 45)}*. ✅\n\nToday now: ~${recNM.calories} kcal | ~${recNM.protein}g protein.`;
      }
      // Two entries match equally well — ASK, never guess; deleting the wrong one IS the bug.
      // Falls through to the numbered-list branch below, which already owns this exact answer.
      if (best && best.n > 0 && tied) ambiguousRemoval = true;
    }
  }

  // ---- REMOVE LAST LOGGED MEAL — any natural expression for "that last entry" ----
  // Allow a trailing reason clause: "remove last meal, it was a question" fell into the
  // specific-food matcher and dead-ended on "I don't see 'last meal, it was a question'"
  // (prod, 2026-07-03). Anchor on the removal target, tolerate ", <anything>" after.
  // Voice phrasings tolerated: "remove the last meal's logged" ('s + trailing
  // "logged") and "…one meal, remove it" dead-ended as fake food lookups
  // ("I don't see 'last meal's' / 'it.'") on 2026-07-06. Question-guarded so
  // "should I remove it?" never deletes.
  // ANGRY PEOPLE DO NOT PUNCTUATE (2026-07-29 live). The rule above already tolerated a reason
  // clause — but only behind a comma or dash. "Remove last meal it's wrong!!!!" has neither, so
  // the documented command fell into the specific-food matcher and dead-ended on «I don't see
  // "last meal it's wrong"». Three words of frustration defeated the command we tell people to
  // use. The separator is now optional, and the trailing words are accepted as COMMENTARY only
  // when they name no food, no meal slot, and no second instruction — so "remove the meal I had
  // for lunch" still falls through to the specific-meal matcher where it belongs.
  const removeMatch = /^(no\s+)?(remove|delete|undo|scratch|take off|take out|get rid of)\s+(it|that|that one|that meal|that entry|last|last one|last meal'?s?|last entry|the last|the meal|the last one|the last entry|the last meal'?s?|meal|that food|what i just logged|what i logged)\b(?:\s+(logged|entry|log))?(?:\s*[,\-—.]?\s*(.*))?$/i.exec(m.trim());
  const trailingIsCommentary = (rest: string): boolean => {
    const r = (rest || "").replace(/[!?.,]+/g, " ").trim();
    if (!r) return true;
    if (/\b(breakfast|lunch|dinner|supper|snack|brunch|yesterday|morning|afternoon|evening)\b/i.test(r)) return false;
    if (/\b(remove|delete|add|log|instead|and)\b/i.test(r)) return false;
    if (scanForSAFoods(r).length > 0) return false;
    return r.split(/\s+/).length <= 6;
  };
  const isRemoveLast = !looksLikeQuestion(m) && (
    (!!removeMatch && trailingIsCommentary(removeMatch[5] || ""))
    || /^(remove|delete|undo|scratch)$/i.test(m.trim())
    || /\b(scratch that|undo that|take that off|remove (that|it)|delete (that|it)|take it (off|out)|that was wrong|wrong entry|wrong meal|logged.*wrong|that.?s a mistake|mistake.*log)\b/i.test(m));
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

    const dropLast: string[] = [];
    if (lastMealLog.length > 0) {
      dropLast.push(lastMealLog[0].id);
    } else {
      const lastFoodLog = await db.select({ id: chatHistory.id })
        .from(chatHistory)
        .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart)))
        .orderBy(desc(chatHistory.createdAt))
        .limit(1);
      if (lastFoodLog.length === 0) return `No meal logged yet today to remove.`;
      await db.update(chatHistory).set({ intent: "FOOD_LOG_CORRECTED" }).where(eq(chatHistory.id, lastFoodLog[0].id));
    }

    const recomputed = await dropMeals(user.id, dropLast, "remove-last", { expandToGroup: true });
    return `Removed your last meal log. ✅\n\nUpdated total today: ~${recomputed.calories} kcal | ~${recomputed.protein}g protein.`;
  }

  // ---- REMOVE SPECIFIC FOOD FROM LOG ----
  const removeSpecificMatch = m.match(/\b(?:remove|delete|take out|take off|scratch|get rid of|didn.?t have|did not have|i didn.?t eat|i did not eat|never ate|i never had|i didn.?t log|no )\s+(the\s+)?(.{2,40}?)(?:\s+from|\s+in\s+my|\s+log|$)/i);
  // Reject generic "that/last/meal" captures — those belong to the remove-last path above
  // Allow meal-time words only when followed by a food word (e.g. "remove breakfast pasta")
  const capturedFood = (removeSpecificMatch?.[2] || "").trim().toLowerCase()
    .replace(/\s+(from|in|my|log|today|this).*$/, "")
    .replace(/[.,!?'"]+$/, "").trim(); // "remove it." captured "it." and dodged the generic filter (2026-07-06)
  const endsWithGeneric = /(^|\s)(last|that|it|this|log|meal'?s?|entry)$/.test(capturedFood);
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
          const dropRS: string[] = [];
          if (rsItem && rsItems.length > 1 && typeof rsItem.kcal === "number") {
            const rsRow = await db.select({ kcalInt: mealLogs.kcalInt, proteinInt: mealLogs.proteinInt }).from(mealLogs).where(eq(mealLogs.id, targetMealLog.id)).limit(1);
            const newKcalRS = Math.max(0, (rsRow[0]?.kcalInt || 0) - (rsItem.kcal || 0));
            const newProtRS = Math.max(0, (rsRow[0]?.proteinInt || 0) - (rsItem.protein || 0));
            await db.update(mealLogs).set({ kcalInt: newKcalRS, proteinInt: newProtRS, items: rsItems.filter(i => i !== rsItem), corrected: true }).where(eq(mealLogs.id, targetMealLog.id));
          } else {
            dropRS.push(targetMealLog.id);
          }
          const recomputed = await dropMeals(user.id, dropRS, `remove-specific-food:${foodToRemove.slice(0, 20)}`);
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
  // Loose on purpose: "Sow me the meals" (typo), "show me today's meals" fell through
  // to the model, which hallucinated "I can't show you the meals directly" and recited
  // a wrong list from memory (2026-07-06 audit). The real numbered list must own this.
  // UNANCHORED (2026-07-16): voice speech never matches ^…$ — "Show me today's food,
  // every single meal that I've logged" and "No, show me today's meals, all the meals"
  // broke the anchors, fell to the model, and it hallucinated "check the app" (there is
  // no app). Show-verb + meal/food-log noun ANYWHERE in the message owns this now.
  const asksMealList =
    /\b(show|sow|see|view|check|list|display|give)\b.{0,50}\b(meals?|meal\s*log|food\s*log|food\s+(?:i(?:'?ve)?\s+)?(?:ate|eaten|logged)|today'?s?\s+food)\b/i.test(m) ||
    /\bwhat\s+(?:did|have)\s+i\s+(?:eat|eaten|logged?)\b/i.test(m) ||
    /^(my|today'?s?)\s+meals?\s*[.!?]*$/i.test(m.trim()) ||
    /^(meal|food)\s+log$/i.test(m.trim());
  if (asksMealList) {
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
    const remainingLine = `${goalStatusLine(user.goalType, calRemaining)}${protRemaining > 0 ? `\nProtein: ~${protRemaining}g still to hit today.` : ""}`;
    // Weekly-journey footer — zooms the client out from today to the week, so one
    // heavy day reads as a data point, not a failure (2026-07-16 founder review).
    const weekLine = await weeklyNetLine(user);
    return `*Today's meals (${logs.length})*\n${lines.map(x => `• ${x}`).join("\n")}\n\n*Total:* ~${totalCals} kcal | ~${totalProtein}g protein\n${remainingLine}${weekLine ? `\n\n${weekLine}` : ""}`;
  }

  return null;
}

/**
 * Swap the wrongly-identified food in today's log for what they actually ate.
 *
 * Deliberately narrow: it only fires when BOTH halves resolve — the wrong food is really in
 * today's log, and the right one is a food we can price. Anything else returns null and the
 * message flows on, because a half-understood correction that silently rewrites someone's day
 * is worse than no correction at all.
 */
async function applyIdentityCorrection(user: any, c: IdentityCorrection, said: string): Promise<string | null> {
  const { rightNames, wrongNames } = correctionCandidates(c);

  // What they actually ate has to resolve to a real food — exactOnly, never a fuzzy guess.
  let replacement: { name: string; typicalPortionCalories: number; typicalPortionProtein: number } | null = null;
  for (const n of rightNames) {
    const hit = scanForSAFoods(n, { exactOnly: true })[0];
    if (hit) { replacement = hit as any; break; }
  }
  if (!replacement) return null;

  /**
   * THE DAY THEY NAMED, NOT THE DAY IT IS (#164, 2026-09-04).
   *
   * This searched `loggedAt >= sastDayStart()` — today, always. So "Tuesday wasn't rice, it was
   * pap" found no candidate on a Tuesday three days back, returned null, and the message fell
   * through to the food scanner, which logged a SECOND Tuesday row containing pap while the
   * original kept the rice the client had just denied. Proved on real PostgreSQL: 3 rows before,
   * 4 after, the denied food still there.
   *
   * parseMealDate is the day owner this file already imports and the multi-day writer already
   * uses, so the named day is resolved the same way it was written. A correction that names no
   * earlier day keeps exactly the window it had — today, unbounded above — so every same-day
   * correction is byte-identical to before.
   */
  const todayStart = sastDayStart();
  const namedDay = sastDayStart(parseMealDate(said) || undefined);
  const correctsPastDay = namedDay.getTime() < todayStart.getTime();
  const rows = await db.select({ id: mealLogs.id, rawMessage: mealLogs.rawMessage, mealLabel: mealLogs.mealLabel, items: mealLogs.items, kcalInt: mealLogs.kcalInt, proteinInt: mealLogs.proteinInt })
    .from(mealLogs)
    .where(correctsPastDay
      ? and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, namedDay),
            lt(mealLogs.loggedAt, new Date(namedDay.getTime() + 86_400_000)))
      : and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart)))
    .orderBy(desc(mealLogs.loggedAt))
    .limit(10);

  const matches = (name: string, target: string) => {
    const a = (name || "").toLowerCase(), b = (target || "").toLowerCase();
    return !!a && !!b && (a.includes(b) || b.includes(a));
  };

  for (const row of rows) {
    const items = (row.items as Array<{ name?: string; kcal?: number; protein?: number }> | null) || [];
    const idx = items.findIndex(i => wrongNames.some(w => matches(i.name || "", w))
      || (c.subject && matches(i.name || "", c.subject)));
    if (idx === -1) continue;

    const old = items[idx];
    if (old.name === replacement.name) return null;   // already right — nothing to correct
    const oldKcal = old.kcal || 0;
    const oldProt = old.protein || 0;
    // Keep the portion the client logged: scale the new food to the same serving count.
    const servings = oldKcal > 0 && replacement.typicalPortionCalories > 0
      ? Math.max(0.25, Math.round((oldKcal / replacement.typicalPortionCalories) * 4) / 4)
      : 1;
    const newKcal = Math.round(replacement.typicalPortionCalories * servings);
    const newProt = Math.round(replacement.typicalPortionProtein * servings);

    const newItems = [...items];
    newItems[idx] = { ...old, name: replacement.name, kcal: newKcal, protein: newProt };
    await db.update(mealLogs).set({
      items: newItems,
      kcalInt: Math.max(0, row.kcalInt - oldKcal + newKcal),
      proteinInt: Math.max(0, row.proteinInt - oldProt + newProt),
      corrected: true,
    }).where(eq(mealLogs.id, row.id));

    invalidateFoodTotalsCache(user.id);
    const totals = await recomputeTodayFoodTotals(user.id);
    await db.update(users)
      .set({ todayCalories: totals.calories, todayProteinG: totals.protein, todayCaloriesDate: sastToday() })
      .where(eq(users.id, user.id));

    const delta = newKcal - oldKcal;
    const shift = delta === 0 ? "Same calories either way." : `That's ${delta > 0 ? "+" : ""}${delta} kcal on the day.`;
    return `Fixed — logged as *${replacement.name}*, not ${old.name}. ${shift}\n\nToday: *${totals.calories} kcal | ${totals.protein}g protein*.`;
  }

  return null;
}

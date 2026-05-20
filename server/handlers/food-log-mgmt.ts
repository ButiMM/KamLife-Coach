/**
 * Food log management commands — reset, remove last, remove specific, show log.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { users, chatHistory, mealLogs } from "../../shared/schema";
import { eq, and, gte, desc, asc } from "drizzle-orm";
import { sastDayStart } from "../utils";
import { recomputeTodayFoodTotals, parseFoodLogTotalsFromMessageOut, scanForSAFoods } from "./food-scanner";

function sastToday(): string {
  const sast = new Date(Date.now() + 2 * 3_600_000);
  return sast.toISOString().slice(0, 10);
}

export async function handleFoodLogMgmt(user: any, m: string): Promise<string | null> {

  // Quick-exit: if message has no management keywords at all, skip the whole handler
  const hasMgmtKeyword = /\b(remove|delete|undo|clear|reset|wipe|scratch|take out|take off|didn.?t (have|eat)|did not (have|eat)|get rid of|cancel.*meal|wrong meal|mistake.*log|log.*mistake|not.*eat|never ate)\b/i.test(m);
  if (!hasMgmtKeyword) return null;

  // ---- RESET ALL OF TODAY'S FOOD ----
  if (/\b(reset.*calori|clear.*food|clear.*log|clear.*calori|start.*fresh|reset.*food|reset.*log|undo.*last.*meal|delete.*last.*meal|remove.*last.*meal|wipe.*food|wipe.*log|clear.*today|remove.*meals?\s*today|delete.*meals?\s*today|remove.*today.*meals?|clear.*meals?\s*today)\b/i.test(m)) {
    await db.update(users).set({ todayCalories: 0, todayProteinG: 0, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
    const todayStart = sastDayStart();
    await Promise.all([
      db.delete(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStart))).catch(e => console.warn("[non-fatal] clear meal_logs:", e)),
      db.delete(chatHistory).where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStart))).catch(e => console.warn("[non-fatal] clear chat food log:", e)),
    ]);
    return `Food log cleared for today. ✅\n\nAll entries wiped — counter is at 0. Start fresh: tell me what you ate.`;
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
    ) || mealLogRows[0];
    if (!target) return `No meal logged yet today to remove.`;
    await db.delete(mealLogs).where(eq(mealLogs.id, target.id));
    const recomputed = await recomputeTodayFoodTotals(user.id);
    await db.update(users).set({ todayCalories: recomputed.calories, todayProteinG: recomputed.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
    return `Removed your ${label} from the log. ✅\n\nUpdated total today: ~${recomputed.calories} kcal | ~${recomputed.protein}g protein.\n\nRemaining: ~${Math.max(0, (user.calorieTarget || 1800) - recomputed.calories)} kcal | ~${Math.max(0, (user.proteinTarget || 120) - recomputed.protein)}g protein still to go.`;
  }

  // ---- REMOVE LAST LOGGED MEAL — any natural expression for "that last entry" ----
  const isRemoveLast = /^(no\s+)?(remove|delete|undo|scratch|take off|take out|get rid of)\s+(it|that|that one|that meal|that entry|last|last one|last meal|last entry|the last|the meal|the last one|the last entry|meal|that food|what i just logged|what i logged)$/i.test(m.trim())
    || /^(remove|delete|undo|scratch)$/i.test(m.trim())
    || /\b(scratch that|undo that|take that off|remove that|delete that|that was wrong|wrong entry|wrong meal|logged.*wrong|that.?s a mistake|mistake.*log)\b/i.test(m);
  if (isRemoveLast) {
    const todayStart = sastDayStart();
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
          await db.delete(mealLogs).where(eq(mealLogs.id, targetMealLog.id));
          const recomputed = await recomputeTodayFoodTotals(user.id);
          await db.update(users).set({ todayCalories: recomputed.calories, todayProteinG: recomputed.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
          return `Removed ${foodToRemove} from your log. ✅\n\nUpdated total today: ~${recomputed.calories} kcal | ~${recomputed.protein}g protein.\n\nRemaining: ~${(user.calorieTarget || 1800) - recomputed.calories} kcal | ~${(user.proteinTarget || 120) - recomputed.protein}g protein still to go.`;
        }

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

        const recomputed = await recomputeTodayFoodTotals(user.id);
        await db.update(users).set({ todayCalories: recomputed.calories, todayProteinG: recomputed.protein, todayCaloriesDate: sastToday() }).where(eq(users.id, user.id));
        return `Removed ${foodToRemove} from your log. ✅\n\nUpdated total today: ~${recomputed.calories} kcal | ~${recomputed.protein}g protein.\n\nRemaining: ~${(user.calorieTarget || 1800) - recomputed.calories} kcal | ~${(user.proteinTarget || 120) - recomputed.protein}g protein still to go.`;
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
      messageIn: chatHistory.messageIn,
      messageOut: chatHistory.messageOut,
      createdAt: chatHistory.createdAt,
    }).from(chatHistory).where(and(
      eq(chatHistory.userId, user.id),
      eq(chatHistory.intent, "FOOD_LOG"),
      gte(chatHistory.createdAt, todayStart),
    )).orderBy(asc(chatHistory.createdAt)).limit(20);

    if (logs.length === 0) return `No food logged yet today. Send your meal and I will track it.`;

    const lines: string[] = [];
    let totalCals = 0;
    let totalProtein = 0;
    for (const l of logs) {
      const parsed = parseFoodLogTotalsFromMessageOut(l.messageOut || "");
      if (parsed) {
        totalCals += parsed.calories;
        totalProtein += parsed.protein;
      } else {
        const matched = scanForSAFoods(l.messageIn || "");
        totalCals += matched.reduce((s, f) => s + (f.typicalPortionCalories || 0), 0);
        totalProtein += matched.reduce((s, f) => s + (f.typicalPortionProtein || 0), 0);
      }
      const time = l.createdAt ? new Date(l.createdAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }) : "--:--";
      lines.push(`${time} — ${(l.messageIn || "[photo]").slice(0, 80)}`);
    }
    return `*Today's meal log (${logs.length})*\n${lines.map(x => `• ${x}`).join("\n")}\n\n*Total so far:* ~${totalCals} kcal | ~${totalProtein}g protein`;
  }

  return null;
}

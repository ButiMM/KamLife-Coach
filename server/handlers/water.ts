/**
 * Water logging and water question handlers.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { users } from "../../shared/schema";
import { eq, sql } from "drizzle-orm";
import { logChat } from "./chat-log";
import { sastToday } from "../utils";

export async function handleWater(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
}): Promise<string | null> {
  const { phone, message, m, user } = ctx;

  // ---- WATER LOGGING HANDLER — no GPT ----
  const waterMatch = m.match(/(\d+(?:\.\d+)?)\s*(l|litre|liter|litres|liters|ml|millilitre|milliliter|glass(?:es)?|cup(?:s)?|bottle(?:s)?)\b/i);
  const hasWaterKeyword = /\b(water|drank|drank water|drank some|had water|drank my water|water intake|drinking water|water today|glass|glasses|bottle|bottles)\b/i.test(m);
  if (waterMatch && hasWaterKeyword) {
    const amount = parseFloat(waterMatch[1]);
    const unit = waterMatch[2].toLowerCase();
    let litres = amount;
    if (unit === "ml" || unit === "millilitre" || unit === "milliliter") litres = amount / 1000;
    else if (unit === "glass" || unit === "glasses") litres = amount * 0.25;
    else if (unit === "cup" || unit === "cups") litres = amount * 0.25;
    else if (unit === "bottle" || unit === "bottles") litres = amount * 0.5;

    const today = sastToday();
    const lastReset = user.waterLastResetDate;
    const weightKgForWater = parseFloat(user.currentWeight as string || "0") || 75;
    const waterTarget = Math.max(2.0, Math.round(weightKgForWater * 0.033 * 10) / 10);

    const waterUpdated = await db.update(users).set({
      todayWater: sql`CASE WHEN water_last_reset_date = ${today} THEN COALESCE(today_water::numeric, 0) + ${litres} ELSE ${litres} END`,
      waterLastResetDate: today,
    }).where(eq(users.phoneNumber, phone)).returning({ todayWater: users.todayWater });
    const newTotal = Math.round((Number(waterUpdated[0]?.todayWater) || 0) * 10) / 10;
    const currentWater = Math.max(0, newTotal - litres);

    const yesterdaySAST = new Date(Date.now() + 2 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
    const crossedTarget = newTotal >= waterTarget && currentWater < waterTarget;
    const isConsecutive = lastReset === today || lastReset === yesterdaySAST;
    const newWaterStreak = crossedTarget
      ? (isConsecutive ? (user.waterStreak || 0) + 1 : 1)
      : (user.waterStreak || 0);

    await db.update(users).set({ waterStreak: newWaterStreak }).where(eq(users.phoneNumber, phone));

    const remaining = Math.max(0, Math.round((waterTarget - newTotal) * 10) / 10);
    const targetHit = newTotal >= waterTarget;
    const fn = (user.name || "").split(" ")[0] || "there";
    let waterReply: string;
    if (targetHit) {
      if (crossedTarget && newWaterStreak >= 7) {
        waterReply = `${newTotal}L — water target hit. ✅ ${fn}, ${newWaterStreak} days straight. Your kidneys, skin, and metabolism are all working better than they were a week ago. Keep it exactly like this.`;
      } else if (crossedTarget && newWaterStreak >= 3) {
        waterReply = `${newTotal}L — water target hit. ✅ ${newWaterStreak} days in a row, ${fn}. Hydration is a habit now. Do it again tomorrow.`;
      } else if (crossedTarget) {
        waterReply = `${newTotal}L — daily water target hit. ✅ That is what it looks like, ${fn}. Now do it again tomorrow.`;
      } else {
        waterReply = `${newTotal}L logged. Target hit for the day. ✅`;
      }
    } else {
      waterReply = `Logged ${litres}L water. Total today: ${newTotal}L / ${waterTarget}L target. ${remaining}L still to go.`;
    }
    await logChat(user.id, message, waterReply, "WATER_LOG");
    return waterReply;
  }

  // ---- WATER WITHOUT AMOUNT — prompt instead of silently ignoring ----
  // e.g. "I drank water", "drank some water", "had water"
  if (!waterMatch && hasWaterKeyword && /\b(drank|drunk|had|drinking|drank some|had some)\b/i.test(m)) {
    const wKg = parseFloat(user.currentWeight as string || "0") || 75;
    const wTarget = Math.max(2.0, Math.round(wKg * 0.033 * 10) / 10);
    const todayW = Math.round((parseFloat(user.todayWater as string || "0")) * 10) / 10;
    const remaining = Math.max(0, Math.round((wTarget - todayW) * 10) / 10);
    const noAmtReply = `How much? Tell me the amount and I will log it.\n\nExamples: "drank 500ml", "had 2 glasses", "1 litre"\n\n_Today so far: ${todayW}L / ${wTarget}L target${remaining > 0 ? ` — ${remaining}L to go` : " — target hit ✅"}_`;
    await logChat(user.id, message, noAmtReply, "WATER_NO_AMOUNT");
    return noAmtReply;
  }

  // ---- WATER QUESTION HANDLER ----
  const isWaterQuestion = /\b(how much water|water target|water goal|how many litres|how many liters|water should i drink|daily water|water recommendation|water intake|water per day)\b/i.test(m);
  const isWaterOnlyMsg = /^water\s*$/i.test(m.trim());
  if (isWaterQuestion || isWaterOnlyMsg) {
    const todayW = parseFloat(user.todayWater as string || "0");
    const wKg = parseFloat(user.currentWeight as string || "0") || 75;
    const wTarget = Math.max(2.0, Math.round(wKg * 0.033 * 10) / 10);
    const remaining = Math.max(0, Math.round((wTarget - todayW) * 10) / 10);
    const waterQReply = `Daily water target: *${wTarget}L* (based on your body weight).\n\nYou have logged ${todayW}L today — ${remaining > 0 ? `${remaining}L still to go.` : `target hit.`}\n\nTo log water, send the amount: "drank 500ml", "had 1L", "2 glasses of water".`;
    await logChat(user.id, message, waterQReply, "WATER_QUESTION");
    return waterQReply;
  }

  return null;
}

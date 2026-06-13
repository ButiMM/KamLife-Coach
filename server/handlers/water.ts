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
  const isNonWaterDrink = /\b(wine|beer|whisky|brandy|rum|vodka|gin|shots?|alcohol|henny|hennessy|smirnoff|hunters|savanna|castle|black label|flying fish|brutal fruit|cider|juice|coffee|tea|milo|milk|cooldrink|cool drink|fanta|sprite|coke|pepsi|energy drink|redbull|monster|cream soda|softdrink|soda water|tonic)\b/i.test(m);
  // Question ("is 500ml enough water?", "how much is 2 litres?") must NOT log — reaches
  // the water-question handler below or GPT. Negation/intent ("haven't had my 2L of water
  // yet", "need to drink 2 litres") must NOT log water that was never consumed.
  const waterIsQuestion = m.includes("?") || /\b(how much|how many|should i|do i need|is\s+\d|enough|too much|target|recommend)\b/i.test(m);
  const waterNotConsumed = /\b(haven.?t|hasn.?t|didn.?t|did\s+not|forgot|need\s+to|should\s+(?:i|drink)|must\s+drink|gonna|going\s+to|will\s+drink|plan\s+to|trying\s+to|still\s+need)\b/i.test(m);
  if (waterMatch && hasWaterKeyword && !isNonWaterDrink && !waterIsQuestion && !waterNotConsumed) {
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
    // A day is "consecutive" if last reset was today or yesterday (SAST).
    // If it was 2+ days ago the streak is broken — must reset even if not crossing target today.
    const missedADay = lastReset !== null && lastReset !== undefined
      && lastReset !== today && lastReset !== yesterdaySAST;
    const isConsecutive = lastReset === today || lastReset === yesterdaySAST;
    let newWaterStreak: number;
    if (crossedTarget) {
      // Target hit today: increment if consecutive, else start fresh at 1
      newWaterStreak = isConsecutive ? (user.waterStreak || 0) + 1 : 1;
    } else if (missedADay) {
      // Missed at least one day without hitting target — streak resets to 0
      newWaterStreak = 0;
    } else {
      // Same or consecutive day, target not hit yet — keep current streak
      newWaterStreak = user.waterStreak || 0;
    }

    await db.update(users).set({ waterStreak: newWaterStreak }).where(eq(users.phoneNumber, phone));

    const remaining = Math.max(0, Math.round((waterTarget - newTotal) * 10) / 10);
    const targetHit = newTotal >= waterTarget;
    const fn = (user.name || "").split(" ")[0] || "there";
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
    let waterReply: string;
    if (targetHit) {
      if (crossedTarget && newWaterStreak >= 7) {
        waterReply = `${newTotal}L — water target hit. ✅ ${fn}, ${newWaterStreak} days straight. Your kidneys, skin, and metabolism are all working better than they were a week ago. Keep it exactly like this.`;
      } else if (crossedTarget && newWaterStreak >= 3) {
        waterReply = `${newTotal}L — water target hit. ✅ ${newWaterStreak} days in a row, ${fn}. Hydration is a habit now. Do it again tomorrow.`;
      } else if (crossedTarget) {
        waterReply = `${newTotal}L — daily water target hit. ✅ ${pick([
          `That is what it looks like, ${fn}. Do it again tomorrow.`,
          `Sorted. Same again tomorrow, ${fn}.`,
          `${fn}, hydration done. Now food and training.`,
          `Clean. Hit it again tomorrow.`,
        ])}`;
      } else {
        waterReply = pick([
          `${newTotal}L logged. Water target done for today. ✅`,
          `${newTotal}L in — target hit. ✅`,
          `Water target reached at ${newTotal}L. ✅`,
        ]);
      }
    } else {
      waterReply = pick([
        `Logged ${litres}L. Total today: ${newTotal}L / ${waterTarget}L — ${remaining}L to go.`,
        `${litres}L added. Running total: ${newTotal}L / ${waterTarget}L target. ${remaining}L left.`,
        `Water logged: ${newTotal}L today. ${remaining}L still to hit your target.`,
        `${newTotal}L so far today. ${remaining}L to reach ${waterTarget}L.`,
      ]);
    }
    await logChat(user.id, message, waterReply, "WATER_LOG");
    return waterReply;
  }

  // ---- WATER WITHOUT AMOUNT — prompt instead of silently ignoring ----
  // e.g. "I drank water", "drank some water", "had water"
  if (!waterMatch && hasWaterKeyword && !waterIsQuestion && !waterNotConsumed && /\b(drank|drunk|had|drinking|drank some|had some)\b/i.test(m)) {
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

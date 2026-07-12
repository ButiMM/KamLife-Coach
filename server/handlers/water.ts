/**
 * Water logging and water question handlers.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { users } from "../../shared/schema";
import { eq, sql } from "drizzle-orm";
import { logChat } from "./chat-log";
import { sastToday, mentionsNotDone } from "../utils";
import { waterTargetLitres } from "../targets";

/**
 * Log water from a message that contains an amount + a water keyword. Returns the
 * confirmation reply, or null if the message is not a loggable water entry.
 *
 * Exported separately from handleWater so the supplement handler (which runs EARLIER
 * in the pipeline and would otherwise swallow a combined message like
 * "2 litres of water and 10g of creatine") can still log the water instead of
 * silently dropping it.
 */
export async function tryLogWater(ctx: {
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
  const waterNotConsumed = mentionsNotDone(m)  // couldn't/skipped/didn't finish my water — never consumed
    || /\b(need\s+to|should\s+(?:i|drink)|must\s+drink|gonna|going\s+to|will\s+drink|plan\s+to|trying\s+to|still\s+need)\b/i.test(m);
  if (waterMatch && hasWaterKeyword && !isNonWaterDrink && !waterIsQuestion && !waterNotConsumed) {
    const amount = parseFloat(waterMatch[1]);
    const unit = waterMatch[2].toLowerCase();
    let litres = amount;
    if (unit === "ml" || unit === "millilitre" || unit === "milliliter") litres = amount / 1000;
    else if (unit === "glass" || unit === "glasses") litres = amount * 0.25;
    else if (unit === "cup" || unit === "cups") litres = amount * 0.25;
    else if (unit === "bottle" || unit === "bottles") litres = amount * 0.5; // assumes 500ml; say "750ml bottle" or "1L bottle" for accuracy

    const today = sastToday();
    const lastReset = user.waterLastResetDate;
    const waterTarget = waterTargetLitres(user.currentWeight as string);

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
      const bottleSizeHint = (unit === "bottle" || unit === "bottles")
        ? ` _(if your bottle is not 500ml, say "750ml bottle" or "1L bottle")_`
        : "";
      waterReply = pick([
        `Logged ${litres}L.${bottleSizeHint} Total today: ${newTotal}L / ${waterTarget}L — ${remaining}L to go.`,
        `${litres}L added.${bottleSizeHint} Running total: ${newTotal}L / ${waterTarget}L target. ${remaining}L left.`,
        `Water logged: ${newTotal}L today.${bottleSizeHint} ${remaining}L still to hit your target.`,
        `${newTotal}L so far today.${bottleSizeHint} ${remaining}L to reach ${waterTarget}L.`,
      ]);
    }
    await logChat(user.id, message, waterReply, "WATER_LOG");
    return `${waterReply}[BUTTONS:Log food|My progress]`;
  }

  return null;
}

export async function handleWater(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
}): Promise<string | null> {
  const { phone, message, m, user } = ctx;

  // Log water first (amount + water keyword).
  const loggedWater = await tryLogWater(ctx);
  if (loggedWater) return loggedWater;

  // Re-derive the signals the fall-through blocks need (the logging block above lives
  // in tryLogWater now, so these are no longer in scope here).
  const waterMatch = m.match(/(\d+(?:\.\d+)?)\s*(l|litre|liter|litres|liters|ml|millilitre|milliliter|glass(?:es)?|cup(?:s)?|bottle(?:s)?)\b/i);
  const hasWaterKeyword = /\b(water|drank|drank water|drank some|had water|drank my water|water intake|drinking water|water today|glass|glasses|bottle|bottles)\b/i.test(m);
  const waterIsQuestion = m.includes("?") || /\b(how much|how many|should i|do i need|is\s+\d|enough|too much|target|recommend)\b/i.test(m);
  const waterNotConsumed = mentionsNotDone(m)  // couldn't/skipped/didn't finish my water — never consumed
    || /\b(need\s+to|should\s+(?:i|drink)|must\s+drink|gonna|going\s+to|will\s+drink|plan\s+to|trying\s+to|still\s+need)\b/i.test(m);

  // ---- WATER WITHOUT AMOUNT — prompt instead of silently ignoring ----
  // e.g. "I drank water", "drank some water", "had water"
  if (!waterMatch && hasWaterKeyword && !waterIsQuestion && !waterNotConsumed && /\b(drank|drunk|had|drinking|drank some|had some)\b/i.test(m)) {
    const wTarget = waterTargetLitres(user.currentWeight as string);
    const todayW = Math.round((parseFloat(user.todayWater as string || "0")) * 10) / 10;
    const remaining = Math.max(0, Math.round((wTarget - todayW) * 10) / 10);
    const noAmtReply = `How much? Tell me the amount and I will log it.\n\nExamples: "drank 500ml", "had 2 glasses", "1 litre"\n\n_Today so far: ${todayW}L / ${wTarget}L target${remaining > 0 ? ` — ${remaining}L to go` : " — target hit ✅"}_`;
    await logChat(user.id, message, noAmtReply, "WATER_NO_AMOUNT");
    return noAmtReply;
  }

  // ---- WATER QUESTION / STATUS HANDLER ----
  const isWaterQuestion = /\b(how much water|water target|water goal|how many litres|how many liters|water should i drink|daily water|water recommendation|water intake|water per day)\b/i.test(m);
  // Bare water commands with NO amount — "water", "water log", "log water", "my water",
  // "water status/total/today/summary/count/tracker", "show water". These must show the
  // water summary, never fall through to GPT (which has hallucinated "I can't help you
  // with water" — a core feature it absolutely supports).
  const isWaterStatusCmd = /^(water|water\s*log|log\s*water|my\s*water|water\s*status|water\s*total|water\s*today|water\s*summary|water\s*count|water\s*tracker|water\s*tracking|show\s*(my\s*)?water|check\s*(my\s*)?water)\s*\??$/i.test(m.trim());
  if (isWaterQuestion || isWaterStatusCmd) {
    const todayW = parseFloat(user.todayWater as string || "0");
    const wTarget = waterTargetLitres(user.currentWeight as string);
    const remaining = Math.max(0, Math.round((wTarget - todayW) * 10) / 10);
    const waterQReply = `Daily water target: *${wTarget}L* (based on your body weight).\n\nYou have logged ${todayW}L today — ${remaining > 0 ? `${remaining}L still to go.` : `target hit.`}\n\nTo log water, send the amount: "drank 500ml", "had 1L", "2 glasses of water".`;
    await logChat(user.id, message, waterQReply, "WATER_QUESTION");
    return waterQReply;
  }

  return null;
}

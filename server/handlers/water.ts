/**
 * Water logging and water question handlers.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { users } from "../../shared/schema";
import { neverSilentLine } from "../reply-hygiene";
import { eq, sql } from "drizzle-orm";
import { logChat, turnMutation } from "./chat-log";
import { sastToday, mentionsNotDone, digitizeSpokenAmounts } from "../utils";
import { waterTargetLitres } from "../targets";
import { scanForSAFoods } from "./food-scanner";

/**
 * Log water from a message that contains an amount + a water keyword. Returns the
 * confirmation reply, or null if the message is not a loggable water entry.
 *
 * Exported separately from handleWater so the supplement handler (which runs EARLIER
 * in the pipeline and would otherwise swallow a combined message like
 * "2 litres of water and 10g of creatine") can still log the water instead of
 * silently dropping it.
 */
// One owner for "does this message mention water at all" — the same literal was
// declared twice in this file, which is two owners for one question.
const WATER_WORDS = /\b(water|drank|drank water|drank some|had water|drank my water|water intake|drinking water|water today|glass|glasses|bottle|bottles)\b/i;

export async function tryLogWater(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
}): Promise<string | null> {
  const { phone, message, user } = ctx;
  // Voice notes say amounts in words ("one litre") — digitize before parsing (2026-07-16).
  const m = digitizeSpokenAmounts(ctx.m);

  // ---- WATER LOGGING HANDLER — no GPT ----
  const waterMatch = m.match(/(\d+(?:\.\d+)?)\s*(l|litre|liter|litres|liters|ml|millilitre|milliliter|glass(?:es)?|cup(?:s)?|bottle(?:s)?)\b/i);
  const hasWaterKeyword = WATER_WORDS.test(m);
  const isNonWaterDrink = /\b(wine|beer|whisky|brandy|rum|vodka|gin|shots?|alcohol|henny|hennessy|smirnoff|hunters|savanna|castle|black label|flying fish|brutal fruit|cider|juice|coffee|tea|milo|milk|cooldrink|cool drink|fanta|sprite|coke|pepsi|energy drink|redbull|monster|cream soda|softdrink|soda water|tonic)\b/i.test(m);
  // Question ("is 500ml enough water?", "how much is 2 litres?") must NOT log — reaches
  // the water-question handler below or GPT. Negation/intent ("haven't had my 2L of water
  // yet", "need to drink 2 litres") must NOT log water that was never consumed.
  // `is\s+\d` WAS UNANCHORED (2026-08-26, issue #63). It exists to catch "is 500ml enough?",
  // but it also matched "my water IS 2 litres" — a report — so the copula form was classified as
  // a question and never logged. The client's water went to the food scanner instead, which
  // logged a FOOD called "Water". Anchored: a question opens with "is", a report does not.
  const waterIsQuestion = m.includes("?") || /\b(how much|how many|should i|do i need|enough|too much|target|recommend)\b/i.test(m)
    || /^\s*is\s+\d/i.test(m);
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
    // WATER IS A DURABLE WRITE AND NOW SAYS SO (2026-08-26, issue #63). It persists by UPDATEing
    // users.todayWater, and recorded nothing on the turn — so durableDomains(), the turn's own
    // record of what it wrote, could not see it. Water was the one tracked fact invisible to that
    // record, which is why a water log ended in a bare receipt while the other four earned a
    // coaching move. UPDATE, not INSERT, because that is honestly what happened: the day has one
    // running total, not a row per sip.
    // The AMOUNT ADDED leads, because it is the value this turn actually knows: the day total
    // comes back from the UPDATE's returning() and reads 0 if that read fails, which would put a
    // number in the forensic record that never happened.
    turnMutation(`UPDATE water +${litres}L (day ${newTotal}L)`, "[WATER_LOG]");
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
    // DELETED 2026-08-04 (Slice 4). Twelve hand-written variants lived here, and the ones a
    // client actually saw most were the running totals: "2L added. Running total: 0L / 2.7L
    // target. 2.7L left." Three numbers, two of them targets the client never asked about, on
    // the day they drank some water. The coach writes the sentence now; this is the net.
    const waterReply = neverSilentLine("water", { amount: `${litres}L` });
    await logChat(user.id, message, waterReply, "WATER_LOG");
    return `${waterReply}`;
  }

  return null;
}

export async function handleWater(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
}): Promise<string | null> {
  const { phone, message, user } = ctx;
  const m = digitizeSpokenAmounts(ctx.m); // "one litre" → "1 litre" (voice notes)

  // Log water first (amount + water keyword).
  const loggedWater = await tryLogWater(ctx);
  if (loggedWater) return loggedWater;

  // Re-derive the signals the fall-through blocks need (the logging block above lives
  // in tryLogWater now, so these are no longer in scope here).
  const waterMatch = m.match(/(\d+(?:\.\d+)?)\s*(l|litre|liter|litres|liters|ml|millilitre|milliliter|glass(?:es)?|cup(?:s)?|bottle(?:s)?)\b/i);
  const hasWaterKeyword = WATER_WORDS.test(m);
  // `is\s+\d` WAS UNANCHORED (2026-08-26, issue #63). It exists to catch "is 500ml enough?",
  // but it also matched "my water IS 2 litres" — a report — so the copula form was classified as
  // a question and never logged. The client's water went to the food scanner instead, which
  // logged a FOOD called "Water". Anchored: a question opens with "is", a report does not.
  const waterIsQuestion = m.includes("?") || /\b(how much|how many|should i|do i need|enough|too much|target|recommend)\b/i.test(m)
    || /^\s*is\s+\d/i.test(m);
  const waterNotConsumed = mentionsNotDone(m)  // couldn't/skipped/didn't finish my water — never consumed
    || /\b(need\s+to|should\s+(?:i|drink)|must\s+drink|gonna|going\s+to|will\s+drink|plan\s+to|trying\s+to|still\s+need)\b/i.test(m);

  // ---- WATER WITHOUT AMOUNT — prompt instead of silently ignoring ----
  // e.g. "I drank water", "drank some water", "had water"
  // COMPOUND GUARD (2026-07-16 tester voice note): "an apple and a pear and water" must
  // NOT be swallowed by the how-much ask, dropping the meal — if the message carries real
  // food beyond water itself, defer to the food pipeline (it owns the meal; water unstated).
  const carriesRealFood = scanForSAFoods(m).some(f => !/^water$/i.test(f.name));
  if (!waterMatch && hasWaterKeyword && !carriesRealFood && !waterIsQuestion && !waterNotConsumed && /\b(drank|drunk|had|drinking|drank some|had some)\b/i.test(m)) {
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
    // They asked a question, so answer it — don't hand back a scoreboard (2026-08-06 sweep).
    const waterQReply = `About *${wTarget}L* a day for your weight.${remaining > 0 ? ` You're ${remaining}L off it today.` : ` You're there already today. 👌`}\n\nJust send me the amount as you go — "drank 500ml", "had 1L".`;
    await logChat(user.id, message, waterQReply, "WATER_QUESTION");
    return waterQReply;
  }

  return null;
}

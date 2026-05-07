/**
 * Food-context handlers: correction detection, water guard, log command intercept,
 * braai/social event guide, eating out guide, quick relog, SA food scanner,
 * and GPT food fallbacks.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { users, mealLogs, chatHistory } from "../../shared/schema";
import { eq, and, gte, lt, desc } from "drizzle-orm";
import { type SAFood } from "../foods";
import {
  scanForSAFoods, recomputeTodayFoodTotals, buildFoodLogReply, escapeRegex,
} from "./food-scanner";
import { checkFoodPatterns, checkPerfectDay } from "./checks";
import { gptFoodFallback, askCoachK } from "../gpt";
import { logChat, withTimeout } from "./chat-log";
import { sastDayStart, sastToday } from "../utils";

type HandleMessageFn = (phone: string, message: string, mediaUrl?: string, mediaContentType?: string, allMediaUrls?: string[]) => Promise<string>;

export async function handleFoodContext(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
  stepReplyPart: string;
  handleMessage: HandleMessageFn;
}): Promise<string | null> {
  const { phone, message, m, user, stepReplyPart, handleMessage } = ctx;

  // ---- CORRECTION DETECTION — "no I had a burger", "actually it was chicken" ----
  const CORRECTION_PREFIX = /^(no[,!\s]+|actually[,\s]+|i meant[,\s]+|not that[,\s]+|wait[,\s]+|no wait[,\s]+|correction[,\s]*)/i;
  const correctedMsgCandidate = m.replace(CORRECTION_PREFIX, "").trim();
  const hasCorrectionPrefix = CORRECTION_PREFIX.test(m);
  const hasFoodTriggerAfterPrefix = /\b(had|ate|eaten|eating|breakfast|lunch|dinner|supper|meal|it was|was a|i had|i said|the above|mentioned|i'll have|i will have)\b/i.test(m);
  const hasFoodAfterPrefix = hasCorrectionPrefix && correctedMsgCandidate.length > 2 && scanForSAFoods(correctedMsgCandidate).length > 0;
  const isFoodCorrection = hasCorrectionPrefix && (hasFoodTriggerAfterPrefix || hasFoodAfterPrefix);

  const isReferenceCorrection = /\b(go with|goes with|part of|was correcting|was part|belongs to|same meal|together with|included in|go together|read it again|read that again|i was correcting|that.?s the same|the above mentioned|above mentioned|i said i had|i said for lunch|i said for dinner|i said for breakfast)\b/i.test(m);

  if (isFoodCorrection || isReferenceCorrection) {
    if (isReferenceCorrection && !hasCorrectionPrefix) {
      const gptRef = await withTimeout("gpt_food_ref", 20000, () => askCoachK(message, user, "The user is referencing or correcting a previous food log. Use chat history to understand what they mean and respond helpfully. Do NOT log new food."));
      await logChat(user.id, message, gptRef, "FOOD_CORRECTION_REF");
      return gptRef;
    } else {
      const todayStartCorr = sastDayStart();
      try {
        const lastFoodLog = await db.select({ id: chatHistory.id })
          .from(chatHistory)
          .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStartCorr)))
          .orderBy(desc(chatHistory.createdAt))
          .limit(1);
        if (lastFoodLog.length > 0) {
          await db.update(chatHistory).set({ intent: "FOOD_LOG_CORRECTED" }).where(eq(chatHistory.id, lastFoodLog[0].id));
          const recomputed = await recomputeTodayFoodTotals(user.id);
          await db.update(users).set({
            todayCalories: recomputed.calories,
            todayProteinG: recomputed.protein,
            todayCaloriesDate: sastToday(),
          }).where(eq(users.id, user.id));
        }
      } catch (e) { console.warn("[non-fatal]", e); }
      if (correctedMsgCandidate && correctedMsgCandidate.length > 2 && correctedMsgCandidate !== m) {
        return await handleMessage(phone, correctedMsgCandidate);
      }
    }
  }

  // ---- WATER GUARD — messages about water/hydration never reach food scanner ----
  const hasWaterWord = /\b(water|h2o|hydrat(e|ion|ing))\b/i.test(m);
  if (hasWaterWord && /\b(had|drank|drinking|intake|drink|logged|consumed)\b/i.test(m)) {
    const waterFoodCheck = scanForSAFoods(m);
    if (waterFoodCheck.length === 0) {
      const todayWg = parseFloat(user.todayWater as string || "0");
      const remainingWg = Math.max(0, Math.round((2.0 - todayWg) * 10) / 10);
      const wGuardReply = `Water logged. You have had ${todayWg}L today — ${remainingWg > 0 ? `${remainingWg}L still to go.` : `daily target hit. ✅`}\n\nTo log an exact amount: "drank 500ml", "had 1 litre", "2 glasses of water".`;
      await logChat(user.id, message, wGuardReply, "WATER_LOG");
      return wGuardReply;
    }
  }

  // ---- LOG COMMAND INTERCEPT — "log the meal", "log this", "save this", "log it" ----
  const isLogCommand =
    /\b(log\s*(the\s*)?(meal|this|it|food)|save\s*(the\s*)?(meal|this|food)|record\s*(the\s*)?(meal|this)|add\s*(the\s*)?(meal|this)|please\s*log|can\s*you\s*log|you\s*log\s*it|done logging|finished logging|that.?s it for (today|now|this meal)|that.?s my (meal|food|breakfast|lunch|dinner|supper)|log\s*it)[?!.\s]*$/i.test(m.trim());

  if (isLogCommand) {
    try {
      const recentChats = await db.select({ messageIn: chatHistory.messageIn, intent: chatHistory.intent })
        .from(chatHistory)
        .where(eq(chatHistory.userId, user.id))
        .orderBy(desc(chatHistory.createdAt))
        .limit(3);
      const lastUnloggedFood = recentChats.find(c => c.intent !== "FOOD_LOG" && c.messageIn);
      if (lastUnloggedFood) {
        const foodsInLastMsg = scanForSAFoods(lastUnloggedFood.messageIn || "");
        if (foodsInLastMsg.length > 0) {
          let totalCals = 0; let totalProt2 = 0;
          const parts: string[] = [];
          for (const food of foodsInLastMsg) {
            totalCals += food.typicalPortionCalories || 0;
            totalProt2 += food.typicalPortionProtein || 0;
            parts.push(`${food.name} — ${food.typicalPortionCalories} kcal | ${food.typicalPortionProtein}g protein`);
          }
          await logChat(user.id, lastUnloggedFood.messageIn || "", parts.join("\n"), "FOOD_LOG");
          await db.insert(mealLogs).values({
            userId: user.id,
            rawMessage: lastUnloggedFood.messageIn || "",
            source: "text",
            kcalInt: totalCals,
            proteinInt: totalProt2,
            carbsInt: 0,
            fatInt: 0,
          }).catch(e => console.warn("[smart-log mealLogs write]", e));
          const recomputed3 = await recomputeTodayFoodTotals(user.id);
          await db.update(users).set({
            todayCalories: recomputed3.calories,
            todayProteinG: recomputed3.protein,
            todayCaloriesDate: sastToday(),
          }).where(eq(users.id, user.id)).catch(e => console.warn("[smart-log todayCalories sync]", e));
          return `Logged! ✅\n${parts.join("\n")}\n\n_Today: ${recomputed3.calories} kcal | ${recomputed3.protein}g protein_`;
        }
      }
    } catch { /* non-fatal */ }

    const summaryTotals = await recomputeTodayFoodTotals(user.id);
    const name = user.name ? ` ${user.name}` : "";
    if (summaryTotals.calories === 0 && summaryTotals.protein === 0) {
      return `Nothing logged yet today. Tell me what you ate — "I had pap and eggs" or "chicken and sweet potato" — and I will log the calories and protein.`;
    }
    const calTarget = user.calorieTarget || 1800;
    const protTarget = user.proteinTarget || 120;
    const remaining = calTarget - summaryTotals.calories;
    const protRemaining = protTarget - summaryTotals.protein;
    return `Today so far:${name} *${summaryTotals.calories} kcal | ${summaryTotals.protein}g protein*\nTarget: ${calTarget} kcal | ${protTarget}g protein\n${remaining > 0 ? `${remaining} kcal and ${protRemaining}g protein still to go.` : `Calorie target reached. ✅`}`;
  }

  // ---- Shared message-type flags used by food handlers below ----
  const isQuestion = m.includes("?") ||
    /^(what|should|can i|is |are |how|why|when|tell me about|which|do i|where)/.test(m) ||
    /\b(from where|where can|where do|where to|how much|how many|is it|is that|are they|are those|should i|can i|do i|does it|what is|what are|which one|good for|bad for|healthy|unhealthy|worth it|better than|worse than)\b/.test(m);
  const hasFrustrationWords = /\b(no no|that.?s not|not true|not right|wrong|incorrect|read everything|come on|what the hell|terrible|rubbish|nonsense|adjust it|fix it|change it|update it|that.?s wrong|bull|crap|ridiculous|do a better|better job|what\??!*$|huh\??|excuse me|are you sure|doesn.?t look right|not correct|try again|redo|recalculate)\b/i.test(m);
  const isFrustration = hasFrustrationWords && !/\b(i had|i ate|i said|had|ate|having|eating|the above|for lunch|for dinner|for breakfast|for supper|go with|goes with|part of|same meal|i was correcting)\b/i.test(m);
  const hasLogTrigger = /\b(ate|had|have|having|eating|i'll have|i will have|gonna have|going to have|breakfast|lunch|dinner|supper|snack|brunch|for breakfast|for lunch|for dinner|for supper|for snack|for brunch|breakfast was|lunch was|dinner was|supper was|just had|just ate|meal was|meal is|food was|i ate|i had|i've had|ive had|pre.?workout|pre workout|post.?workout|post workout|before.*gym|after.*gym|before.*training|after.*training)\b/.test(m);

  // ---- BRAAI / SOCIAL EVENT GUIDE ----
  const hasSocialEventKeyword = /\b(braai|braaing|braaiing|party|wedding|funeral|umemulo|umkhosi|stokvel|church.*food|family.*gathering|get.?together|celebration)\b/i.test(m);
  if (hasSocialEventKeyword && !isQuestion && !isFrustration) {
    const goal = user.goalType || "fat_loss";
    const name = user.name?.split(" ")[0] || "";
    const isBraai = /braai/i.test(m);

    let eventReply = "";
    if (isBraai) {
      eventReply = goal === "muscle_gain"
        ? `*Braai Protocol — Muscle Mode* 🔥\n\n• Chicken pieces: BEST — 28g protein each, skin off after cooking\n• Wors: 1-2 rolls (20-30g protein) ✅ Keep it\n• Boerewors chops: high fat but solid protein — 1 portion\n• Pap + sous: fine — keep butter small\n• Potato salad: small portion or skip\n\n*Your plate:* 3 chicken pieces + 1 wors + small pap = ~750 kcal, ~55g protein. Sorted.\n\nDrink: Water first. Max 2 beers — after food, not before.`
        : `*Braai Protocol — Fat Loss Mode* 🔥\n\n• Chicken pieces: BEST option — remove skin, 165 kcal, 28g protein each\n• Wors: 1 roll max — not every braai\n• Pap: small portion, no extra butter\n• Potato salad, coleslaw: skip — not worth the calories\n• Braai broodjie: 1 is fine. 3 is not.\n\n*Your plate:* 2-3 chicken pieces + small pap + salad = ~550 kcal, ~45g protein. Win.\n\n⚠️ Beers are the silent killer at braais — 1 Castle = 150 kcal, nobody has just one. Water between drinks minimum.`;
    } else {
      eventReply = `*Social Event Strategy* 🎉\n\n${name ? name + ", " : ""}Go. Enjoy. Do not avoid social events because of your plan.\n\n*Before:*\n• Eat a high-protein meal before you go — 2 eggs, chicken, pilchards\n• This kills hunger so you are not eating everything in sight\n\n*During:*\n• Plate protein FIRST — chicken, meat, fish\n• One plate, not three. Serve yourself once.\n• Water between drinks. Every time.\n• ${goal === "fat_loss" ? "Skip the starch if you can — focus on meat and salad" : "Eat the starch — you need the fuel. Just one serving."}\n\n*After:*\n• Log what you ate tomorrow morning — I will be here\n• No guilt. One event does not undo weeks of work\n• Back on plan the next meal. Not Monday. The next meal.`;
    }

    eventReply += `\n\n_Send me what you ate tomorrow morning — no judgment, just logging. I will help you get back on track._`;
    await logChat(user.id, message, eventReply, "SOCIAL_EVENT");
    return eventReply;
  }

  // ---- EATING OUT GUIDE — SA fast food and restaurant coaching ----
  const eatingOutPlace =
    m.includes("nandos") || m.includes("nando's") ? "nandos" :
    m.includes("kfc") ? "kfc" :
    m.includes("steers") ? "steers" :
    m.includes("wimpy") ? "wimpy" :
    m.includes("chicken licken") ? "chicken_licken" :
    m.includes("debonairs") ? "debonairs" :
    m.includes("mcdonalds") || m.includes("mcdonald's") ? "mcdonalds" :
    m.includes("ocean basket") ? "ocean_basket" :
    null;

  if (eatingOutPlace && !isQuestion && !isFrustration) {
    const goal = user.goalType || "fat_loss";
    const guides: Record<string, string> = {
      nandos: `*Nando's — Coach K Pick*\n\n✅ Best: Quarter chicken (skin off) + peri-peri chips + coleslaw = ~650 kcal, 35g protein\n✅ Good: Grilled chicken wrap (no sauce, extra coleslaw)\n⚠️ Watch: Double chicken = fine if that's your big meal\n❌ Avoid: Chips as main + roll + dessert = 1,200 kcal\n\nFlame-grilled is always better than fried. Skin off saves 80-100 kcal.`,
      kfc: `*KFC — Coach K Pick*\n\n✅ Best: Streetwise 2 (original, not zinger) = ~550 kcal, 32g protein\n✅ OK: Grilled chicken pieces × 2\n⚠️ Watch: Coleslaw is fine. Chips is a carb bomb — skip or halve\n❌ Avoid: Zinger towers, combos with large chips + cooldrink = 1,200+ kcal\n\nIf you're going KFC: 2 pieces original + coleslaw. That's it. No cooldrink.`,
      steers: `*Steers — Coach K Pick*\n\n✅ Best: Classic beef burger, no sauce, extra lettuce = ~650 kcal, 35g protein\n✅ OK: Chicken burger (no mayo)\n⚠️ Watch: Onion rings = 400 extra kcal — skip\n❌ Avoid: Ribs + chips + cooldrink combo = 1,500+ kcal\n\nBurger only, no combo. Ask for no mayo. Works.`,
      wimpy: `*Wimpy — Coach K Pick*\n\n✅ Best: Grilled chicken + salad (no dressing) = ~500 kcal, 38g protein\n✅ Good: Eggs + toast (breakfast) — solid protein\n⚠️ Watch: Toasted sandwiches are sneaky carbs\n❌ Avoid: Burgers + chips + milkshake = 1,400 kcal\n\nWimpy breakfast is actually one of the better fast food options for protein.`,
      chicken_licken: `*Chicken Licken — Coach K Pick*\n\n✅ Best: 2-piece soul meal (original) = ~580 kcal, 30g protein\n⚠️ Watch: Hot portions chips = 400 kcal on their own\n❌ Avoid: Family buckets, adding a roll and cooldrink to every order\n\nChicken Licken is fine as a protein hit — just don't turn it into a 4-piece meal with all the extras.`,
      debonairs: `*Debonairs — Coach K Pick*\n\n✅ Best: Thin base, chicken topping, half a medium = ~500-600 kcal\n⚠️ Watch: Cheese-stuffed crust adds 150 kcal per slice\n❌ Avoid: Triple Decker, Gatsby-style loaded options\n\nPizza can fit — 2 slices thin base chicken is roughly 500-600 kcal. Problem is nobody stops at 2 slices. Set your portion before it arrives.`,
      mcdonalds: `*McDonald's — Coach K Pick*\n\n✅ Best: McFeast (no sauce) = ~550 kcal, 32g protein\n✅ Good: Grilled chicken wrap\n⚠️ Watch: Fries = 340 kcal. Skip or share.\n❌ Avoid: Combos with large fries + large coke = 1,100+ kcal added\n\nBurger only, water or diet cooldrink. That's a manageable meal.`,
      ocean_basket: `*Ocean Basket — Coach K Pick*\n\n✅ Best: Grilled linefish + salad = ~450 kcal, 40g protein — legitimately excellent\n✅ Good: Calamari (grilled not battered) + salad\n⚠️ Watch: Battered = adds 200 extra kcal\n❌ Avoid: Chips with everything, creamy sauces\n\nOcean Basket is one of the best restaurant options — high protein, low fat if you go grilled.`,
    };
    const guide = guides[eatingOutPlace] || "";
    if (guide) {
      const goalNote = goal === "fat_loss" ? `\n\n_Your goal is fat loss — the right order here keeps you on track without missing out._` : `\n\n_Your goal is muscle — prioritise protein options and eat to fullness._`;
      const eatingReply = `${guide}${goalNote}`;
      await logChat(user.id, message, eatingReply, "FOOD_LOG");
      return eatingReply;
    }
  }

  // ---- QUICK RE-LOG — "same as yesterday", "same as lunch", "had the same for dinner" ----
  const isRepeatMeal = /\b(same as (yesterday|my\s*lunch|my\s*dinner|my\s*breakfast|lunch|dinner|breakfast|last|before)|same meal|repeat meal|same again|same food|had the same|the same (meal|food|thing) (for|as)|same (breakfast|lunch|dinner)|repeat (breakfast|lunch|dinner)|yesterday.?s (meal|food))\b/i.test(m);
  if (isRepeatMeal) {
    try {
      const refLunch = /\b(same as (my )?lunch|same (meal|food).*for dinner|had the same.*lunch|lunch again|same lunch)\b/i.test(m);
      const refDinner = /\b(same as (my )?dinner|same (meal|food).*for lunch|had the same.*dinner|dinner again|same dinner)\b/i.test(m);
      const refBreakfast = /\b(same as (my )?breakfast|breakfast again|same breakfast)\b/i.test(m);
      const refYesterday = /yesterday/i.test(m);

      const todayStart = sastDayStart();
      const windowStart = refYesterday
        ? new Date(Date.now() - 48 * 3600_000)
        : todayStart;

      const recentFoodLogs = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut, createdAt: chatHistory.createdAt })
        .from(chatHistory)
        .where(and(
          eq(chatHistory.userId, user.id),
          eq(chatHistory.intent, "FOOD_LOG"),
          gte(chatHistory.createdAt, windowStart),
        ))
        .orderBy(desc(chatHistory.createdAt))
        .limit(10);

      const LOG_CMD_RE2 = /^(log\s*(the\s*)?(meal|this|it|food)|save|record|done|that.?s|yes|ok|sure)/i;
      const validLogs = recentFoodLogs.filter(l =>
        l.messageIn &&
        !LOG_CMD_RE2.test(l.messageIn.trim()) &&
        l.messageIn.length > 5 &&
        scanForSAFoods(l.messageIn).length > 0
      );

      if (validLogs.length === 0) {
        return `No recent meals found to repeat. Tell me what you had — for example: "2 eggs and toast".`;
      }

      let toRepeat = validLogs[0].messageIn!;

      if (refLunch) {
        const lunchLog = validLogs.find(l => /lunch|afternoon/i.test(l.messageIn || ""));
        if (lunchLog) toRepeat = lunchLog.messageIn!;
        else toRepeat = validLogs[0].messageIn!;
      } else if (refDinner) {
        const dinnerLog = validLogs.find(l => /dinner|supper|evening/i.test(l.messageIn || ""));
        if (dinnerLog) toRepeat = dinnerLog.messageIn!;
      } else if (refBreakfast) {
        const breakfastLog = validLogs.find(l => /breakfast|morning/i.test(l.messageIn || ""));
        if (breakfastLog) toRepeat = breakfastLog.messageIn!;
      }

      const yesterdayMealRows = await db.select({
        kcalInt: mealLogs.kcalInt,
        proteinInt: mealLogs.proteinInt,
        carbsInt: mealLogs.carbsInt,
        fatInt: mealLogs.fatInt,
        rawMessage: mealLogs.rawMessage,
        source: mealLogs.source,
        items: mealLogs.items,
        loggedAt: mealLogs.loggedAt,
      }).from(mealLogs).where(and(
        eq(mealLogs.userId, user.id),
        gte(mealLogs.loggedAt, new Date(Date.now() - 48 * 3600_000)),
        lt(mealLogs.loggedAt, new Date()),
      )).orderBy(desc(mealLogs.loggedAt)).limit(5);

      const usableMeals = yesterdayMealRows.filter(r => r.kcalInt > 0);
      if (usableMeals.length > 0) {
        let matchedMeal = usableMeals[0];
        if (refBreakfast && usableMeals.length > 0) {
          matchedMeal = usableMeals[usableMeals.length - 1];
        } else if (refDinner && usableMeals.length > 0) {
          matchedMeal = usableMeals[0];
        } else if (refLunch && usableMeals.length >= 2) {
          matchedMeal = usableMeals[Math.floor(usableMeals.length / 2)];
        } else {
          matchedMeal = usableMeals.find(r =>
            r.rawMessage && toRepeat && r.rawMessage.toLowerCase().includes(toRepeat.slice(0, 20).toLowerCase())
          ) || usableMeals[0];
        }

        const totalCals = matchedMeal.kcalInt || 0;
        const totalProt = matchedMeal.proteinInt || 0;
        const labels: string[] = matchedMeal.rawMessage ? [matchedMeal.rawMessage.slice(0, 50)] : [];
        await db.insert(mealLogs).values({
          userId: user.id,
          rawMessage: matchedMeal.rawMessage || toRepeat,
          source: "quick_relog",
          kcalInt: matchedMeal.kcalInt,
          proteinInt: matchedMeal.proteinInt,
          carbsInt: matchedMeal.carbsInt,
          fatInt: matchedMeal.fatInt,
          items: matchedMeal.items,
        }).catch(() => {});
        const calorieTarget = user.calorieTarget || 2000;
        const proteinTarget = user.proteinTarget || 120;
        const relogged = await recomputeTodayFoodTotals(user.id);
        await db.update(users).set({
          todayCalories: relogged.calories,
          todayProteinG: relogged.protein,
          todayCaloriesDate: sastToday(),
        }).where(eq(users.phoneNumber, phone));
        const updTodayCals = relogged.calories;
        const updTodayProt = relogged.protein;
        const remaining = calorieTarget - updTodayCals;
        const protGap = proteinTarget - updTodayProt;
        const mealWasToday = matchedMeal.loggedAt ? matchedMeal.loggedAt >= sastDayStart() : false;
        const copyLabel = mealWasToday ? "Copied from earlier today" : "Copied from yesterday";
        await logChat(user.id, message, `Quick relog: ${labels.join(", ")} (+${totalCals} kcal · +${totalProt}g protein)`, "FOOD_LOG");
        return `♻️ ${copyLabel}:\n${labels.map(l => `• ${l}`).join("\n") || `• ${toRepeat.slice(0, 60)}`}\n\n*+${totalCals} kcal · +${totalProt}g protein*\n${remaining > 0 ? `${remaining} kcal remaining today.` : "Calorie target hit."} ${protGap > 0 ? `${protGap}g protein left.` : "Protein target hit ✅"}`;
      }

      const repeatReply = await handleMessage(phone, toRepeat);
      return `♻️ Same meal logged: "${toRepeat.slice(0, 80)}"\n\n${repeatReply}`;
    } catch (err) {
      console.error("[REPEAT MEAL]", err);
      return `Could not find a recent meal to repeat. Tell me what you had.`;
    }
  }

  // ---- SA FOOD DATABASE MATCHING + GPT FOOD FALLBACK ----
  const isSoftStruggleEarly = /\b(i.?m (really |so |just )?(struggling|falling behind|losing motivation|lost motivation|feeling behind|feeling lost|not sure what i.?m doing|demotivated|unmotivated))\b/.test(m) || /\b(feel like (giving up|i.?m failing|i.?m not making progress|nothing is working|i.?m not getting it right|i.?m behind))\b/.test(m) || /\b(i don.?t (know what.?s happening|know what i.?m doing|know if this is working))\b/.test(m) || /\b(hard (to stay|to keep|to maintain) (motivated|going|consistent))\b/.test(m) || /\b(haven.?t (trained|worked out|been to gym|gone to gym)|didn.?t (train|work out)|no (training|workout|gym) (for |in )?\d+\s*(days?|weeks?))\b/.test(m) || /\bfeeling (down|low|unmotivated|demotivated|flat|defeated|hopeless about (this|my progress|the gym))\b/i.test(m) || /\b(unmotivated|demotivated|lost (my |all )?(motivation|drive)|no motivation|zero motivation)\b/i.test(m);
  const isEmotionalMsg = isSoftStruggleEarly;
  const foodsInMsg = scanForSAFoods(m);
  const hasActualFood = foodsInMsg.length > 0;
  const isEmotionalOnly = isEmotionalMsg && !hasLogTrigger;
  const isShortFoodMsg = !isQuestion && hasLogTrigger && hasActualFood && m.split(/\s+/).length <= 30;
  const directFoodScan = !isQuestion && !isFrustration && !hasLogTrigger && hasActualFood && m.split(/\s+/).length <= 15;
  const foodLogOverride = hasLogTrigger && hasActualFood;

  if ((!isQuestion || foodLogOverride) && !isFrustration && !isEmotionalOnly && hasActualFood && (hasLogTrigger || directFoodScan)) {
    const MEAL_KEYWORDS = ["breakfast", "lunch", "dinner", "supper", "snack", "brunch", "morning", "afternoon", "evening"];
    const mealSegments: { label: string; text: string }[] = [];

    const FOR_MEAL_RE = /\bfor\s+(breakfast|lunch|dinner|supper|snack|brunch|morning|afternoon|evening)\b/gi;
    const forMealMatches = [...m.matchAll(FOR_MEAL_RE)];

    if (forMealMatches.length >= 2) {
      for (let i = 0; i < forMealMatches.length; i++) {
        const label = forMealMatches[i][1].charAt(0).toUpperCase() + forMealMatches[i][1].slice(1);
        const prevEnd = i > 0 ? (forMealMatches[i - 1].index! + forMealMatches[i - 1][0].length) : 0;
        const segText = m.slice(prevEnd, forMealMatches[i].index!).replace(/^[\s,;.]+|[\s,;.]+$/g, "").trim();
        if (segText) mealSegments.push({ label, text: segText });
      }
      const lastEnd = forMealMatches[forMealMatches.length - 1].index! + forMealMatches[forMealMatches.length - 1][0].length;
      const trailing = m.slice(lastEnd).replace(/^[\s,;.]+|[\s,;.]+$/g, "").trim();
      if (trailing && mealSegments.length > 0) {
        mealSegments[mealSegments.length - 1].text += " " + trailing;
      }
    } else if (forMealMatches.length === 1) {
      const KEYWORD_BEFORE_RE = /\b(breakfast|lunch|dinner|supper|snack|brunch|morning|afternoon|evening)\b[:\s]+/gi;
      const beforeMatches = [...m.matchAll(KEYWORD_BEFORE_RE)].filter(
        bm => !m.slice(Math.max(0, bm.index! - 4), bm.index!).match(/\bfor\s*$/i)
      );
      if (beforeMatches.length >= 1) {
        mealSegments.push({ label: "", text: m });
      } else {
        const label = forMealMatches[0][1].charAt(0).toUpperCase() + forMealMatches[0][1].slice(1);
        const segText = m.slice(0, forMealMatches[0].index!).replace(/^[\s,;.]+|[\s,;.]+$/g, "").trim();
        if (segText) mealSegments.push({ label, text: segText });
        else mealSegments.push({ label, text: m });
      }
    } else {
      const MEAL_BEFORE_RE = /\b(breakfast|lunch|dinner|supper|snack|brunch|morning|afternoon|evening)\b[:\s]+/gi;
      const beforeMatches = [...m.matchAll(MEAL_BEFORE_RE)];
      if (beforeMatches.length >= 2) {
        for (let i = 0; i < beforeMatches.length; i++) {
          const label = beforeMatches[i][1].charAt(0).toUpperCase() + beforeMatches[i][1].slice(1);
          const start = beforeMatches[i].index! + beforeMatches[i][0].length;
          const end = i + 1 < beforeMatches.length ? beforeMatches[i + 1].index! : m.length;
          const segText = m.slice(start, end).replace(/^[\s,;.]+|[\s,;.]+$/g, "").trim();
          if (segText) mealSegments.push({ label, text: segText });
        }
      }
    }

    if (mealSegments.length < 2) {
      mealSegments.length = 0;
      mealSegments.push({ label: "", text: m });
    }

    function normaliseWordNumbers(text: string): string {
      const map: Record<string, string> = {
        "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
        "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
        "half": "0.5", "a": "1", "an": "1",
      };
      return text.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|half|a|an)\b/gi, w => map[w.toLowerCase()] ?? w);
    }

    function adjustFoodsForSegment(foods: SAFood[], segText: string) {
      const normText = normaliseWordNumbers(segText);
      return foods.map(f => {
        const allAliases = [f.name.toLowerCase(), ...f.aliases.map(a => a.toLowerCase())];
        let quantity = 1;
        for (const alias of allAliases) {
          const qtyDirect = normText.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+(?:${escapeRegex(alias)})`, "i"));
          const qtyWithFiller = normText.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+(?:slices?|pieces?|cups?|bowls?|plates?|portions?|servings?|tablespoons?|teaspoons?|tbsp|tsp|glasses?)\\s+(?:of\\s+)?(?:${escapeRegex(alias)})`, "i"));
          const qtyBefore = qtyDirect || qtyWithFiller;
          if (qtyBefore) {
            const userQty = parseFloat(qtyBefore[1]);
            const defaultQtyMatch = f.typicalPortionDescription.match(/^(\d+)/);
            const defaultQty = defaultQtyMatch ? parseInt(defaultQtyMatch[1]) : 1;
            if (userQty > 0 && defaultQty > 0 && userQty !== defaultQty) {
              quantity = userQty / defaultQty;
            }
            break;
          }
        }
        return {
          ...f,
          adjustedCalories: Math.round(f.typicalPortionCalories * quantity),
          adjustedProtein: Math.round(f.typicalPortionProtein * quantity),
          adjustedDescription: quantity !== 1 ? f.typicalPortionDescription.replace(/^\d+/, String(Math.round(parseInt(f.typicalPortionDescription.match(/^\d+/)?.[0] || "1") * quantity))) : f.typicalPortionDescription,
          quantity,
        };
      });
    }

    type AdjFood = SAFood & { adjustedCalories: number; adjustedProtein: number; adjustedDescription: string; quantity: number };
    const allAdjustedFoods: AdjFood[] = [];
    const mealLines: string[] = [];
    const isMultiMeal = mealSegments.length >= 2;

    for (const seg of mealSegments) {
      const segFoods = scanForSAFoods(seg.text);
      if (segFoods.length === 0) continue;
      const adjusted = adjustFoodsForSegment(segFoods, seg.text);
      allAdjustedFoods.push(...adjusted);
      if (isMultiMeal && seg.label) {
        const segCals = adjusted.reduce((s, f) => s + f.adjustedCalories, 0);
        const segProt = adjusted.reduce((s, f) => s + f.adjustedProtein, 0);
        const lines = adjusted.map(f => `  • ${f.name}: ~${f.adjustedCalories} kcal, ${f.adjustedProtein}g protein`).join("\n");
        mealLines.push(`*${seg.label}:* ~${segCals} kcal | ${segProt}g protein\n${lines}`);
      }
    }

    if (allAdjustedFoods.length > 0) {
      const totalCals = allAdjustedFoods.reduce((s, f) => s + f.adjustedCalories, 0);
      const totalProtein = allAdjustedFoods.reduce((s, f) => s + f.adjustedProtein, 0);
      const calorieTarget = user.calorieTarget || 2000;
      const proteinTarget = user.proteinTarget || 120;
      const junkFoods = allAdjustedFoods.filter(f => f.category === "junk");
      const goodProteins = allAdjustedFoods.filter(f => f.category === "protein");

      let foodLines: string;
      if (isMultiMeal && mealLines.length > 0) {
        foodLines = mealLines.join("\n\n");
      } else {
        foodLines = allAdjustedFoods.map(f =>
          `• ${f.name}: ~${f.adjustedCalories} kcal, ${f.adjustedProtein}g protein (${f.adjustedDescription})`
        ).join("\n");
      }

      const todayStr = sastToday();
      let runningCals = totalCals;
      let runningProtein = Math.round(totalProtein);
      try {
        const existingTotals = await recomputeTodayFoodTotals(user.id);
        runningCals = existingTotals.calories + totalCals;
        runningProtein = existingTotals.protein + Math.round(totalProtein);
        await db.update(users).set({
          todayCalories: runningCals,
          todayProteinG: runningProtein,
          todayCaloriesDate: todayStr,
        }).where(eq(users.phoneNumber, phone));
      } catch (e) { console.warn("[non-fatal] calorie update:", e); }
      const prevCals = Math.max(0, runningCals - totalCals);

      let junkNoteText = "";
      if (junkFoods.length > 0) {
        let note = junkFoods[0].notes || "";
        if (goodProteins.length > 0) {
          note = note.replace(/Better to choose.*$/i, "").replace(/Add (?:eggs|pilchards|protein).*$/i, "").trim();
        }
        if (note) junkNoteText = note;
      }
      const isDiabeticClient = (user.medicalConditions || "").toLowerCase().includes("diabetes");
      if (isDiabeticClient) {
        const HIGH_GI_PATTERNS = [
          { match: /\b(white pap|stiff pap|soft pap|pap|mieliepap)\b/i, swap: "samp and beans or oats" },
          { match: /\b(white rice|jasmine rice)\b/i, swap: "brown rice or sweet potato" },
          { match: /\b(white bread|polony roll|hot dog roll)\b/i, swap: "whole wheat bread" },
          { match: /\b(coke|fanta|sprite|cream soda|stoney|twist|energade|powerade|juice)\b/i, swap: "water or rooibos tea" },
        ];
        const loggedNames = allAdjustedFoods.map(f => f.name.toLowerCase()).join(" ") + " " + m;
        for (const { match, swap } of HIGH_GI_PATTERNS) {
          if (match.test(loggedNames)) {
            junkNoteText = `⚠️ *Diabetes note:* For your blood sugar stability, swap this for ${swap}. Same satisfaction — without the spike.`;
            break;
          }
        }
      }

      const mealLabel = isMultiMeal ? "Day total" : "Meal total";
      const clientGoal = user.goalType || "fat_loss";
      type DenseNote = { fat_loss: string; muscle_gain: string; recomposition: string };
      const DENSE_HEALTHY: Record<string, DenseNote> = {
        "Avocado": {
          fat_loss: "Healthy fat — good choice. Calorie-dense at ~120 kcal per half, so log the portion accurately.",
          muscle_gain: "Good healthy fat. Keep fuelling.",
          recomposition: "Healthy fat. Log the portion accurately — calorie-dense but nutrient-dense.",
        },
        "Peanut butter": {
          fat_loss: "Good protein and fat combo. Calorie-dense — 2 tbsp is ~180 kcal. Log it accurately and it fits your plan.",
          muscle_gain: "Solid protein and fat. Good fuel for building.",
          recomposition: "Protein and fat in one. Log the portion — 2 tbsp is the right amount.",
        },
        "Peanut butter (smooth)": {
          fat_loss: "Good protein and fat. Calorie-dense — log the portion accurately.",
          muscle_gain: "Good protein and fat source. Keep fuelling.",
          recomposition: "Good protein and fat. Log the portion accurately.",
        },
        "Banana": {
          fat_loss: "Good natural energy — ~90 kcal each. Factor it into your daily total.",
          muscle_gain: "Good carb for training fuel. Keep going.",
          recomposition: "Natural carb. Factor the 90 kcal into your total.",
        },
        "Nut mix": {
          fat_loss: "Healthy fats and protein. Easy to underestimate — the logged portion is what counts.",
          muscle_gain: "Good healthy fats. Keep fuelling.",
          recomposition: "Healthy fats. Log the portion accurately — calorie-dense.",
        },
        "Peanuts (roasted)": {
          fat_loss: "High protein and healthy fat. Calorie-dense — the small pack portion is right.",
          muscle_gain: "Protein and fat snack. Good choice.",
          recomposition: "Protein and fat. Log accurately.",
        },
      };
      const denseMatch = allAdjustedFoods
        .map(f => ({ food: f, note: DENSE_HEALTHY[f.name as keyof typeof DENSE_HEALTHY] }))
        .find(x => x.note);
      const denseFoodCoachNote = denseMatch
        ? denseMatch.note[clientGoal as keyof DenseNote] || denseMatch.note.fat_loss
        : undefined;

      const reply = buildFoodLogReply({
        foodLines, mealLabel, totalMealCals: totalCals, totalMealProtein: totalProtein,
        runningCals, runningProtein, calorieTarget, proteinTarget, prevCals,
        junkNoteText, hasGoodProteins: goodProteins.length > 0,
        hasCarbs: allAdjustedFoods.some(f => f.category === "carb"),
        coachNoteOverride: denseFoodCoachNote,
        user,
      });

      try {
        const totalCarbs = Math.round(allAdjustedFoods.reduce((s, f) => {
          const grams = (f.typicalPortionGrams || 100) * (f.quantity || 1);
          return s + (grams * (f.carbsPer100g || 0) / 100);
        }, 0));
        const totalFat = Math.round(allAdjustedFoods.reduce((s, f) => {
          const grams = (f.typicalPortionGrams || 100) * (f.quantity || 1);
          return s + (grams * (f.fatPer100g || 0) / 100);
        }, 0));
        const items = allAdjustedFoods.map(f => ({
          name: f.name,
          grams: Math.round((f.typicalPortionGrams || 100) * (f.quantity || 1)),
          kcal: f.adjustedCalories,
          protein: f.adjustedProtein,
          category: f.category,
        }));
        const firstSegLabel = mealSegments.find(s => s.label)?.label || null;
        await db.insert(mealLogs).values({
          userId: user.id,
          rawMessage: message.slice(0, 1000),
          source: "sa_scanner",
          kcalInt: totalCals,
          proteinInt: Math.round(totalProtein),
          carbsInt: totalCarbs,
          fatInt: totalFat,
          items,
          mealLabel: firstSegLabel,
        });
      } catch (e) { console.warn("[non-fatal] meal_logs insert:", e); }

      await logChat(user.id, message, reply, "FOOD_LOG");
      const [saPattern, saDay] = await Promise.all([checkFoodPatterns(user.id), checkPerfectDay(user.id, user.proteinTarget || 130)]);
      const stepAppend = stepReplyPart ? `\n\n${stepReplyPart}` : "";
      return `${reply}${saPattern ? "\n\n" + saPattern : ""}${saDay || ""}${stepAppend}`;
    }

    // ---- GPT FOOD FALLBACK (SA scanner had food keywords but 0 adjusted matches) ----
    if (!isQuestion && hasLogTrigger && hasActualFood) {
      const gptFallbackResult = await gptFoodFallback(message, user);
      if (gptFallbackResult) {
        const calorieTarget = user.calorieTarget || 2000;
        const proteinTarget = user.proteinTarget || 120;
        const foodLines = gptFallbackResult.foods.map(f =>
          `• ${f.name}: ~${f.kcal} kcal, ${f.protein_g}g protein (${f.portion_desc})`
        ).join("\n");
        const todayStr = sastToday();
        let runningCals = gptFallbackResult.totalKcal;
        let runningProtein = gptFallbackResult.totalProtein;
        try {
          const existingTotals = await recomputeTodayFoodTotals(user.id);
          runningCals = existingTotals.calories + gptFallbackResult.totalKcal;
          runningProtein = existingTotals.protein + gptFallbackResult.totalProtein;
          await db.update(users).set({
            todayCalories: runningCals,
            todayProteinG: runningProtein,
            todayCaloriesDate: todayStr,
          }).where(eq(users.phoneNumber, phone));
        } catch (e) { console.warn("[non-fatal] gpt-fallback calorie update:", e); }
        const fbPrevCals = Math.max(0, runningCals - gptFallbackResult.totalKcal);
        const fallbackReply = buildFoodLogReply({
          foodLines, mealLabel: "Meal total",
          totalMealCals: gptFallbackResult.totalKcal, totalMealProtein: gptFallbackResult.totalProtein,
          runningCals, runningProtein, calorieTarget, proteinTarget, prevCals: fbPrevCals,
          coachNoteOverride: gptFallbackResult.coachNote || undefined,
          hasGoodProteins: gptFallbackResult.foods.some((f: any) => f.category === "protein"),
          hasCarbs: gptFallbackResult.foods.some((f: any) => f.category === "carb"),
          user,
        });
        try {
          const items = gptFallbackResult.foods.map((f: any) => ({
            name: f.name, grams: 0, kcal: f.kcal, protein: f.protein_g, category: f.category,
          }));
          await db.insert(mealLogs).values({
            userId: user.id,
            rawMessage: message.slice(0, 1000),
            source: "gpt_fallback",
            kcalInt: gptFallbackResult.totalKcal,
            proteinInt: gptFallbackResult.totalProtein,
            carbsInt: gptFallbackResult.foods.reduce((s: number, f: any) => s + f.carbs_g, 0),
            fatInt: gptFallbackResult.foods.reduce((s: number, f: any) => s + f.fat_g, 0),
            items,
            mealLabel: null,
          });
        } catch (e) { console.warn("[non-fatal] gpt-fallback meal_logs:", e); }
        await logChat(user.id, message, fallbackReply, "FOOD_LOG");
        const [fbPattern, fbDay] = await Promise.all([checkFoodPatterns(user.id), checkPerfectDay(user.id, user.proteinTarget || 130)]);
        console.log(`[GPT-FOOD-FALLBACK] ${user.id.slice(0, 8)} — ${gptFallbackResult.foods.map((f: any) => f.name).join(", ")} — ${gptFallbackResult.totalKcal} kcal${gptFallbackResult.fromCache ? " [cached]" : ""}`);
        return `${fallbackReply}${fbPattern ? "\n\n" + fbPattern : ""}${fbDay || ""}`;
      }
    }
  }

  // ---- GPT FOOD FALLBACK (no SA foods detected but clear food intent) ----
  const voiceFallbackTooLong = m.split(/\s+/).filter(Boolean).length > 50;
  const hasStrongFoodTrigger = /\b(i ate|i had|i've had|ive had|just had|just ate|just finished eating|for breakfast|for lunch|for dinner|for supper|for brunch|for snack|breakfast was|lunch was|dinner was|supper was|brunch was|meal was|meal is|food was|i'm eating|im eating|i am eating|i'll have|gonna have|going to have|pre.?workout meal|post.?workout meal)\b/i.test(m);
  if (!isQuestion && !isEmotionalOnly && hasStrongFoodTrigger && !hasActualFood && !voiceFallbackTooLong) {
    const gptFallbackResult = await gptFoodFallback(message, user);
    if (gptFallbackResult) {
      const calorieTarget = user.calorieTarget || 2000;
      const foodLines = gptFallbackResult.foods.map((f: any) =>
        `• ${f.name}: ~${f.kcal} kcal, ${f.protein_g}g protein (${f.portion_desc})`
      ).join("\n");
      let runningCals = gptFallbackResult.totalKcal;
      let runningProtein = gptFallbackResult.totalProtein;
      const todayStr = sastToday();
      try {
        const existingTotals = await recomputeTodayFoodTotals(user.id);
        runningCals = existingTotals.calories + gptFallbackResult.totalKcal;
        runningProtein = existingTotals.protein + gptFallbackResult.totalProtein;
        await db.update(users).set({
          todayCalories: runningCals,
          todayProteinG: runningProtein,
          todayCaloriesDate: todayStr,
        }).where(eq(users.phoneNumber, phone));
      } catch (e) { console.warn("[non-fatal] gpt-fallback calorie update:", e); }
      const fb2PrevCals = Math.max(0, runningCals - gptFallbackResult.totalKcal);
      const fallbackReply = buildFoodLogReply({
        foodLines, mealLabel: "Meal total",
        totalMealCals: gptFallbackResult.totalKcal, totalMealProtein: gptFallbackResult.totalProtein,
        runningCals, runningProtein, calorieTarget, proteinTarget: user.proteinTarget || 120,
        prevCals: fb2PrevCals,
        coachNoteOverride: gptFallbackResult.coachNote || undefined,
        hasGoodProteins: gptFallbackResult.foods.some((f: any) => f.category === "protein"),
        hasCarbs: gptFallbackResult.foods.some((f: any) => f.category === "carb"),
        user,
      });
      try {
        const items = gptFallbackResult.foods.map((f: any) => ({
          name: f.name, grams: 0, kcal: f.kcal, protein: f.protein_g, category: f.category,
        }));
        await db.insert(mealLogs).values({
          userId: user.id,
          rawMessage: message.slice(0, 1000),
          source: "gpt_fallback",
          kcalInt: gptFallbackResult.totalKcal,
          proteinInt: gptFallbackResult.totalProtein,
          carbsInt: gptFallbackResult.foods.reduce((s: number, f: any) => s + f.carbs_g, 0),
          fatInt: gptFallbackResult.foods.reduce((s: number, f: any) => s + f.fat_g, 0),
          items,
          mealLabel: null,
        });
      } catch (e) { console.warn("[non-fatal] gpt-fallback meal_logs:", e); }
      await logChat(user.id, message, fallbackReply, "FOOD_LOG");
      const [fbPattern, fbDay] = await Promise.all([checkFoodPatterns(user.id), checkPerfectDay(user.id, user.proteinTarget || 130)]);
      console.log(`[GPT-FOOD-FALLBACK] ${user.id.slice(0, 8)} — ${gptFallbackResult.foods.map((f: any) => f.name).join(", ")} — ${gptFallbackResult.totalKcal} kcal${gptFallbackResult.fromCache ? " [cached]" : ""}`);
      return `${fallbackReply}${fbPattern ? "\n\n" + fbPattern : ""}${fbDay || ""}`;
    }
  }

  return null;
}

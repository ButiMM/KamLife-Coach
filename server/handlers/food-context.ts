/**
 * Food-context handlers: correction detection, water guard, log command intercept,
 * braai/social event guide, eating out guide, quick relog, SA food scanner,
 * and GPT food fallbacks.
 * Returns string if handled, null to fall through.
 */

import { db } from "../db";
import { users, mealLogs, chatHistory, stepLogs } from "../../shared/schema";
import { eq, and, gte, lt, desc } from "drizzle-orm";
import { type SAFood } from "../foods";
import {
  scanForSAFoods, recomputeTodayFoodTotals, buildFoodLogReply, escapeRegex,
  portionDefaultCount,
  computeFoodLogStreak, getFoodStreakCelebration,
  hasShownStreakToday, markStreakShownToday,
  invalidateFoodTotalsCache,
} from "./food-scanner";
import { checkFoodPatterns, checkPerfectDay } from "./checks";
import { gptFoodFallback, gptFoodSupplement, type GptFoodItem, askCoachK } from "../gpt";
import { logChat, withTimeout } from "./chat-log";
import { sastDayStart, sastToday, parseMealDate, isRetroactiveMeal, mealDateLabel } from "../utils";
import { invalidatePatternCache } from "../cache";
import { educationNote, remainingInMeals } from "../education";

export function extractMealLabel(msg: string): string | null {
  const lo = msg.toLowerCase();
  if (/\b(for breakfast|breakfast was|had breakfast|breakfast:|ate breakfast|morning meal)\b/i.test(lo)) return "breakfast";
  if (/\b(for lunch|lunch was|had lunch|lunch:|ate lunch|midday)\b/i.test(lo)) return "lunch";
  if (/\b(for dinner|for supper|dinner was|supper was|had dinner|had supper|dinner:|supper:|evening meal)\b/i.test(lo)) return "dinner";
  if (/\bsnack\b/i.test(lo)) return "snack";
  // Bare keyword at message start — "Lunch rice and beef", "Dinner pap and wors", "Breakfast: eggs"
  if (/^lunch\b/i.test(lo)) return "lunch";
  if (/^(?:dinner|supper)\b/i.test(lo)) return "dinner";
  if (/^breakfast\b/i.test(lo)) return "breakfast";
  // Bare keyword anywhere in message — "Rice and beef for my lunch", "Had eggs breakfast"
  if (/\blunch\b/i.test(lo)) return "lunch";
  if (/\b(?:dinner|supper)\b/i.test(lo)) return "dinner";
  if (/\bbreakfast\b/i.test(lo)) return "breakfast";
  // Time-of-day fallback — if no keyword, infer from current SAST hour
  const sast = new Date(Date.now() + 2 * 3_600_000);
  const h = sast.getUTCHours();
  if (h >= 5 && h < 11) return "breakfast";
  if (h >= 11 && h < 15) return "lunch";
  if (h >= 17 && h < 22) return "dinner";
  return null;
}

/**
 * Check if the message likely has food items beyond what the SA scanner matched.
 * Returns true if there are substantive unmatched tokens that could be food.
 */
function hasUnmatchedFoodContent(message: string, matchedFoods: Array<{ name: string; aliases: string[] }>): boolean {
  let remaining = message.toLowerCase();

  // Remove matched food names and aliases from message text
  for (const food of matchedFoods) {
    const terms = [food.name, ...food.aliases];
    for (const term of terms) {
      if (term.length > 2) {
        remaining = remaining.replace(new RegExp(`\\b${escapeRegex(term.toLowerCase())}\\b`, "g"), " ");
      }
    }
  }

  // Strip stop words, connectors, meal labels, portion words, and negligible spices
  remaining = remaining
    .replace(/\b(i|me|my|had|ate|have|having|eating|was|were|is|are|for|at|in|on|to|and|or|with|some|a|an|the|of|also|just|plus|about|around|only|too|today|yesterday|this|that|it|its|them|then|after|before|along|very|quite|really|all|mixed|cooked|raw|grilled|fried|boiled|steamed|baked|roasted|hot|cold|fresh|leftover|homemade)\b/gi, " ")
    .replace(/\b(breakfast|lunch|dinner|supper|snack|meal|morning|evening|afternoon|night|brunch)\b/gi, " ")
    .replace(/\b(big|large|small|tiny|little|extra|full|half|quarter|whole|double|triple)\b/gi, " ")
    .replace(/\b(piece|pieces|slice|slices|cup|cups|bowl|bowls|plate|plates|portion|portions|serving|servings|tablespoon|tablespoons|tbsp|tsp|gram|grams|g|kg|ml|litre|liters|liter|l|scoop|scoops|handful|pack|packet)\b/gi, " ")
    .replace(/\b(salt|pepper|spices?|seasoning|herbs?|paprika|cumin|coriander|cinnamon|turmeric|chilli|chili|chillies)\b/gi, " ")
    .replace(/\d+(?:\.\d+)?/g, " ")
    .replace(/[.,!?:;'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = remaining.split(" ").filter(t => t.length > 2);
  return tokens.length > 0;
}

// Scale EVERY number in a portion description by the quantity — count AND grams.
// "2 slices (60g)" ×2 must become "4 slices (120g)", never "4 slices (60g)";
// a label whose grams contradict its count destroys trust in all the numbers.
const SINGULAR_UNITS = new Set([
  "cup", "bowl", "scoop", "tablespoon", "teaspoon",
  "serving", "portion", "piece", "packet", "slice", "biscuit", "roti",
]);
export function scalePortionDescription(desc: string, quantity: number): string {
  if (quantity === 1) return desc;
  const scaled = desc.replace(/\d+(?:\.\d+)?/g, (n) => {
    const result = parseFloat(n) * quantity;
    return Number.isInteger(result) ? String(result) : String(Math.round(result * 10) / 10);
  });
  return scaled.replace(/(\d+(?:\.\d+)?)\s+([a-zA-Z]+)/g, (match, num, word) => {
    if (parseFloat(num) > 1 && SINGULAR_UNITS.has(word.toLowerCase())) {
      return `${num} ${word}s`;
    }
    return match;
  });
}

function getStreakNote(userId: string, streak: number, name: string): string {
  if (hasShownStreakToday(userId)) return "";
  const note = getFoodStreakCelebration(streak, name);
  if (note) markStreakShownToday(userId);
  return note;
}

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
}

interface CommitFoodLogResult {
  ok: boolean;
  wasDup: boolean;
  prevCals: number;
  runningCals: number;
  runningProtein: number;
}

// Single chokepoint for every food-log write. All three scanner paths funnel through here so
// any future guard (fabrication check, duplicate detector, verifier) is applied everywhere.
async function commitFoodLog(params: CommitFoodLogParams): Promise<CommitFoodLogResult> {
  let prevCals = 0;
  try {
    const existingTotals = await recomputeTodayFoodTotals(params.userId);
    prevCals = existingTotals.calories;
  } catch { /* non-fatal */ }

  const dedupWindow = new Date(Date.now() - 4 * 60 * 1000);
  const rawSlice = params.rawMessage.slice(0, 1000);
  const recentDup = await db.select({ id: mealLogs.id })
    .from(mealLogs)
    .where(and(
      eq(mealLogs.userId, params.userId),
      gte(mealLogs.loggedAt, dedupWindow),
      eq(mealLogs.kcalInt, params.kcalInt),
      eq(mealLogs.rawMessage, rawSlice),
    ))
    .limit(1);

  let insertOk = true;
  const wasDup = recentDup.length > 0;
  if (!wasDup) {
    try {
      await db.insert(mealLogs).values({
        userId: params.userId,
        rawMessage: rawSlice,
        source: params.source,
        kcalInt: params.kcalInt,
        proteinInt: params.proteinInt,
        carbsInt: params.carbsInt,
        fatInt: params.fatInt,
        items: params.items,
        mealLabel: params.mealLabel,
        loggedAt: params.loggedAt,
      });
      invalidatePatternCache(params.userId);
      invalidateFoodTotalsCache(params.userId);
      console.log(`[MEAL_LOG] saved — user=...${String(params.userId || "").slice(-6)} kcal=${params.kcalInt} prot=${params.proteinInt} label=${params.mealLabel || "none"}`);
    } catch (e) {
      console.error("[MEAL_LOG] insert failed — user:", String(params.userId || "").slice(-6), e);
      insertOk = false;
    }
  }

  let runningCals = prevCals + params.kcalInt;
  let runningProtein = params.proteinInt;
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

  // ---- BOT MISSED A MEAL — "you missed a meal", "you didn't log that", "you forgot my lunch" ----
  // Must be caught BEFORE the correction detector which would re-route "you missed a meal" as food
  const isBotMissedMeal = /\b(you (missed|forgot|skipped|left out|didn.?t (log|count|track|record))|bot (missed|forgot)|you never logged|didn.?t log (my|the|that|a))\b/i.test(m);
  if (isBotMissedMeal) {
    const todayStartMissed = sastDayStart();
    const recentLogs = await db.select({ mealLabel: mealLogs.mealLabel, kcalInt: mealLogs.kcalInt, loggedAt: mealLogs.loggedAt })
      .from(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStartMissed)))
      .orderBy(desc(mealLogs.loggedAt)).limit(5);
    const logSummary = recentLogs.length > 0
      ? `Today I have logged: ${recentLogs.map(l => `${l.mealLabel || "meal"} (${l.kcalInt} kcal)`).join(", ")}.`
      : `I have not logged any meals for you today yet.`;
    const missedReply = `${logSummary}\n\nWhich meal did I miss? Just tell me what it was — e.g. *"oats and eggs for breakfast"* — and I'll add it now.`;
    await logChat(user.id, message, missedReply, "MISSED_MEAL_QUERY");
    return missedReply;
  }

  // ---- CALORIE COMPLAINT — "the calories are wrong", "wrong calories", "those numbers are off" ----
  const isCalorieComplaint = /\b(calories?\s*(are?|is|look|seem|appear)?\s*(wrong|off|incorrect|not right|too (high|low)|inaccurate|don.?t look right)|wrong\s*calories?|calorie\s*(count|total|number)\s*(is|are|seems?|looks?)\s*(wrong|off|high|low|incorrect)|that.?s not (right|correct).{0,20}calorie|numbers?\s*(are?|is|look|seem)\s*(off|wrong))\b/i.test(m);
  if (isCalorieComplaint) {
    const todayStartCal = sastDayStart();
    const lastLog = await db.select({ mealLabel: mealLogs.mealLabel, kcalInt: mealLogs.kcalInt, proteinInt: mealLogs.proteinInt })
      .from(mealLogs).where(and(eq(mealLogs.userId, user.id), gte(mealLogs.loggedAt, todayStartCal)))
      .orderBy(desc(mealLogs.loggedAt)).limit(1);
    const lastMealDesc = lastLog.length > 0 ? `The last meal I logged was ${lastLog[0].mealLabel || "your meal"} at ${lastLog[0].kcalInt} kcal / ${lastLog[0].proteinInt}g protein.` : `I do not have a recent meal logged for today.`;
    const calComplaintReply = `${lastMealDesc}\n\nTell me what the correct calories should be — e.g. *"that wrap was 350 kcal not 500"* — and I'll fix it.`;
    await logChat(user.id, message, calComplaintReply, "CALORIE_COMPLAINT");
    return calComplaintReply;
  }

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
        // Get the last FOOD_LOG chat entry — we need its timestamp to find the
        // RIGHT meal log to delete. Without this, correcting breakfast after logging
        // a snack would delete the snack (most-recent) instead of breakfast.
        const [lastFoodLog] = await db.select({ id: chatHistory.id, createdAt: chatHistory.createdAt })
          .from(chatHistory)
          .where(and(eq(chatHistory.userId, user.id), eq(chatHistory.intent, "FOOD_LOG"), gte(chatHistory.createdAt, todayStartCorr)))
          .orderBy(desc(chatHistory.createdAt))
          .limit(1);
        // Find the meal log whose loggedAt is closest to (within 2 minutes of) the
        // chatHistory entry we just found. This correctly pairs "log at 8am" with
        // "mealLog at 8am" even when later meals exist.
        const corrWindowStart = lastFoodLog ? new Date(new Date(lastFoodLog.createdAt!).getTime() - 120_000) : todayStartCorr;
        const corrWindowEnd   = lastFoodLog ? new Date(new Date(lastFoodLog.createdAt!).getTime() + 120_000) : new Date();
        const [lastMealLogCorr] = await db.select({ id: mealLogs.id })
          .from(mealLogs)
          .where(and(
            eq(mealLogs.userId, user.id),
            gte(mealLogs.loggedAt, corrWindowStart),
            lt(mealLogs.loggedAt, corrWindowEnd),
          ))
          .orderBy(desc(mealLogs.loggedAt))
          .limit(1);
        const lastFoodLogArr = lastFoodLog ? [lastFoodLog] : [];
        // Wrap delete + recount + cache update in a transaction — all succeed or none do
        await db.transaction(async (tx) => {
          if (lastFoodLog) {
            await tx.update(chatHistory).set({ intent: "FOOD_LOG_CORRECTED" }).where(eq(chatHistory.id, lastFoodLog.id));
          }
          if (lastMealLogCorr) {
            await tx.delete(mealLogs).where(eq(mealLogs.id, lastMealLogCorr.id));
          }
          if (lastFoodLog || lastMealLogCorr) {
            const recomputed = await recomputeTodayFoodTotals(user.id);
            await tx.update(users).set({
              todayCalories: recomputed.calories,
              todayProteinG: recomputed.protein,
              todayCaloriesDate: sastToday(),
            }).where(eq(users.id, user.id));
          }
        });
      } catch (e) { console.warn("[food-correction-tx]", e); }
      if (correctedMsgCandidate && correctedMsgCandidate.length > 2 && correctedMsgCandidate !== m) {
        return await handleMessage(phone, correctedMsgCandidate);
      }
    }
  }

  // ---- FOOD LOG REJECTION — "no", "no no no", "wrong" immediately after a food log ----
  // Catches cases where the bot misidentified the food and the user is pushing back
  const isSimpleRejection = /^(no[\s!.?]*)+$/i.test(m) || /^(wrong|incorrect|not right|that.?s wrong|not that)[.!?]*$/i.test(m);
  if (isSimpleRejection) {
    try {
      const lastEntry = await db.select({ intent: chatHistory.intent, messageOut: chatHistory.messageOut })
        .from(chatHistory)
        .where(eq(chatHistory.userId, user.id))
        .orderBy(desc(chatHistory.createdAt))
        .limit(1);
      if (lastEntry[0]?.intent === "FOOD_LOG" || lastEntry[0]?.intent === "SHORT_REPLY") {
        const reply = `What was it actually? Just tell me (e.g. "Monster Zero Sugar") and I'll fix the log.`;
        await logChat(user.id, message, reply, "FOOD_CORRECTION_PROMPT");
        return reply;
      }
      // Not a food correction — give a deterministic reply instead of falling through to GPT
      const confusedReply = `Not sure what you mean. Reply *menu* to see your options, or tell me what you ate or trained.`;
      await logChat(user.id, message, confusedReply, "CONFUSED_RECOVERY");
      return confusedReply;
    } catch { /* non-fatal — fall through */ }
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
          invalidatePatternCache(user.id);
          invalidateFoodTotalsCache(user.id);
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
    const inMeals = remaining > 0 ? remainingInMeals(remaining) : "";
    const eduNote = educationNote(user, { event: "totals", calorieTarget: calTarget, proteinTarget: protTarget, overBy: remaining < 0 ? -remaining : 0 });
    return `Today so far:${name} *${summaryTotals.calories} kcal | ${summaryTotals.protein}g protein*\nTarget: ${calTarget} kcal | ${protTarget}g protein\n${remaining > 0 ? `${remaining} kcal and ${protRemaining}g protein still to go${inMeals ? ` — ${inMeals}` : ""}.` : `Calorie target reached. ✅`}${eduNote}`;
  }

  // ---- Shared message-type flags used by food handlers below ----
  const isQuestion = m.includes("?") ||
    /^(what|should|can i|is |are |how|why|when|tell me about|which|do i|does |do |where|can )/.test(m) ||
    /\b(from where|where can|where do|where to|how much|how many|is it|is that|are they|are those|should i|can i|do i|does it|what is|what are|which one|good for|bad for|healthy|unhealthy|worth it|better than|worse than|is that enough|enough protein|enough calories|is it enough|any good|any protein)\b/.test(m);
  const hasFrustrationWords = /\b(no no|that.?s not|not true|not right|wrong|incorrect|read everything|come on|what the hell|terrible|rubbish|nonsense|adjust it|fix it|change it|update it|that.?s wrong|bull|crap|ridiculous|do a better|better job|what\??!*$|huh\??|excuse me|are you sure|doesn.?t look right|not correct|try again|redo|recalculate)\b/i.test(m);
  const isFrustration = hasFrustrationWords && !/\b(i had|i ate|i said|had|ate|having|eating|the above|for lunch|for dinner|for breakfast|for supper|go with|goes with|part of|same meal|i was correcting)\b/i.test(m);
  // "have" alone is too broad — matches possession ("I have eggs at home"), negation ("don't have"),
  // and questions ("do you have"). Keep only explicit past/active eating forms.
  // "add" alone matches too many non-food contexts ("add me", "add to cart").
  // Future tense ("i'll have", "going to have", "gonna have") removed — those are planning, not eating.
  const hasLogTrigger = /\b(ate|had|having|eating|breakfast|lunch|dinner|supper|snack|brunch|for breakfast|for lunch|for dinner|for supper|for snack|for brunch|breakfast was|lunch was|dinner was|supper was|just had|just ate|meal was|meal is|food was|i ate|i had|i've had|ive had|pre.?workout|pre workout|post.?workout|post workout|before.*gym|after.*gym|before.*training|after.*training|added|put in|putting in)\b/.test(m);

  // Future / planning / shopping intent — describes intended eating or shopping, NOT food consumed today.
  // Blocks directFoodScan and the main food scanner from firing on these messages.
  const isFuturePlanning = /\b(i.?ll\s+have|i\s+will\s+have|gonna\s+have|going\s+to\s+have|need\s+to\s+buy|need\s+to\s+get|want\s+to\s+buy|going\s+to\s+(?:buy|get|pick\s+up)|planning\s+to\s+(?:eat|have|cook)|want\s+to\s+(?:eat|have|try|order)|thinking\s+of\s+(?:eating|having|cooking)|will\s+be\s+(?:eating|having))\b/i.test(m);

  // ---- "ATE IT" — confirm a previously planned meal and log it ----
  // Closes the loop on FOOD_PLANNED: "gonna have X for lunch" → [eats] → "ate it" → logged.
  // Humans never type the magic phrase exactly — "Omg I just had it", "ok ate it now",
  // "finished it" must all land. Tolerates interjection prefixes and just/now padding,
  // but stays anchored on (ate|had|eaten|finished)+(it|that) so real food logs
  // ("I just had it with rice") fall through to the scanner instead.
  const ateItConfirm =
    /^(ate it|i ate it|had it|i had it|ate that|had that|done eating|finished eating|eaten|i.?ve eaten( it)?|log it|log that|log this|log the meal|yes log it)[.!\s]*$/i.test(m) ||
    (m.split(/\s+/).length <= 7 &&
      /^(?:omg|ok|okay|yebo|sharp|eish|yoh|lol|haha|so)?[\s,!]*(?:i|i.?ve)?\s*(?:just\s+)?(?:ate|had|finished|eaten)\s+(?:it|that)(?:\s+now)?[.!\s]*$/i.test(m));
  if (ateItConfirm) {
    try {
      const twelveHoursAgo = new Date(Date.now() - 12 * 3_600_000);
      const planned = await db.select({ messageIn: chatHistory.messageIn })
        .from(chatHistory)
        .where(and(
          eq(chatHistory.userId, user.id),
          eq(chatHistory.intent, "FOOD_PLANNED"),
          gte(chatHistory.createdAt, twelveHoursAgo),
        ))
        .orderBy(desc(chatHistory.createdAt))
        .limit(1);
      if (planned.length > 0 && planned[0].messageIn) {
        // Rewrite the planned message into past tense and re-run it through this handler —
        // it now takes the normal scanner logging path.
        const eaten = planned[0].messageIn.replace(
          /\b(i.?m\s+)?(i.?ll\s+have|i\s+will\s+have|gonna\s+have|going\s+to\s+have|planning\s+to\s+(?:eat|have|cook)|thinking\s+of\s+(?:eating|having|cooking)|want\s+to\s+(?:eat|have|try|order)|will\s+be\s+(?:eating|having))\b/gi,
          "i had",
        );
        return await handleFoodContext({ ...ctx, message: eaten, m: eaten.toLowerCase().replace(/\s+/g, " ").trim() });
      }
      const noPlan = `Nothing pending to log. Tell me what you ate — "I had rice and chicken" — and I'll log it now.`;
      await logChat(user.id, message, noPlan, "FOOD_PLANNED_MISS");
      return noPlan;
    } catch (e) { console.warn("[FOOD_PLANNED] ate-it lookup failed:", e); }
  }


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

  // Require an explicit eating-intent signal before firing the guide — "my cousin works at KFC"
  // must not trigger the KFC calorie guide. Only fire when the user is clearly going there,
  // ordering from there, or just ate there.
  const hasEatingIntent =
    /\b(going to|went to|was at|ate at|ordered from|getting from|pick up from|buying from|takeaway from|eat(ing)? at|lunch at|dinner at|breakfast at|stop(ped)? at|from (nandos|kfc|steers|wimpy|debonairs|mcdonalds|mcdonald|chicken licken|ocean basket)|ate (some|their|the)|had (some|their|the))\b/i.test(m)
    || (/\b(nandos|kfc|steers|wimpy|debonairs|mcdonalds|chicken licken|ocean basket)\b/i.test(m)
        && /\b(today|for lunch|for dinner|for supper|for breakfast|just|tonight|this morning|yesterday|after work|on the way)\b/i.test(m));
  if (eatingOutPlace && hasEatingIntent && !isQuestion && !isFrustration) {
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
      await logChat(user.id, message, eatingReply, "EATING_OUT_GUIDE");
      return eatingReply;
    }
  }

  // ---- QUICK RE-LOG — "same as yesterday", "same as lunch", "had the same for dinner" ----
  // GUARD: "log/record yesterday's food" is a RETROACTIVE-LOGGING request — the user wants
  // to tell me what they ate YESTERDAY, not copy a past meal into today. Without this, a
  // voice note "I want to log yesterday's food" was being relogged as today's pasta.
  // Repeat intent requires an explicit same/repeat/again; a logging verb + "yesterday"
  // (without those) means retroactive capture, so it must fall through.
  const wantsRepeat = /\b(same|repeat|again)\b/i.test(m);
  const isRetroLogRequest = !wantsRepeat
    && /\b(log|logging|record|add|enter|capture|track|update|forgot|missed|didn.?t)\b/i.test(m)
    && /\byesterday\b/i.test(m);
  // Negation guard: "I don't want the same as yesterday" / "not the same meal" must NOT relog.
  const wantsNotRepeat = /\b(don.?t|not|no|never|won.?t|wouldn.?t|avoid|skip)\b.{0,20}\b(same|repeat|again)\b/i.test(m)
    || /\b(same|repeat)\b.{0,20}\b(don.?t|not|no|never|won.?t|wouldn.?t)\b/i.test(m);
  const isRepeatMeal = !isRetroLogRequest && !wantsNotRepeat && /\b(same as (yesterday|my\s*lunch|my\s*dinner|my\s*breakfast|lunch|dinner|breakfast|last|before)|same meal|repeat meal|same again|same food|had the same|the same (meal|food|thing) (for|as)|same (breakfast|lunch|dinner)|repeat (breakfast|lunch|dinner)|yesterday.?s (meal|food) again)\b/i.test(m);

  // Bare retroactive-log request with no food named yet — guide them to send yesterday's
  // meals with a "yesterday" prefix so the meal parser dates them to yesterday, not today.
  if (isRetroLogRequest && scanForSAFoods(message).length === 0) {
    const nm = user.name ? `${user.name.split(" ")[0]}, ` : "";
    return `${nm}sure — what did you eat yesterday? Send it starting with *yesterday*, e.g. *"yesterday I had 2 eggs and pap for breakfast, chicken and rice for lunch"* — and I'll log it to yesterday, not today.`;
  }

  if (isRepeatMeal) {
    try {
      // Determine WHICH meal to copy FROM — look for the reference meal (after "as", not the target meal)
      const refLunch = /\b(same as (my )?lunch|same (meal|food).*for dinner|had the same.*lunch|lunch again|same lunch|as (my )?lunch)\b/i.test(m);
      const refBreakfast = /\b(same as (my )?breakfast|breakfast again|same breakfast|as (my )?breakfast)\b/i.test(m);
      // refDinner only fires when message isn't "same X as lunch/breakfast" — i.e. not copying from another meal
      const refDinner = !refLunch && !refBreakfast && /\b(same as (my )?dinner|same (meal|food).*for lunch|had the same.*dinner|dinner again|same dinner|as (my )?dinner)\b/i.test(m);
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

      // For today references, prefer today's meals; only widen to 48h for "yesterday"
      const mealLookbackMs = refYesterday ? 48 * 3600_000 : 24 * 3600_000;
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
        gte(mealLogs.loggedAt, new Date(Date.now() - mealLookbackMs)),
        lt(mealLogs.loggedAt, new Date()),
      )).orderBy(desc(mealLogs.loggedAt)).limit(10);

      const usableMeals = yesterdayMealRows.filter(r => r.kcalInt > 0);
      if (usableMeals.length > 0) {
        // Always try to match by the chat-message text we identified as the reference meal
        const textMatch = toRepeat ? usableMeals.find(r =>
          r.rawMessage && (
            r.rawMessage.toLowerCase().includes(toRepeat.slice(0, 20).toLowerCase()) ||
            toRepeat.toLowerCase().includes((r.rawMessage || "").slice(0, 20).toLowerCase())
          )
        ) : null;

        let matchedMeal = textMatch || usableMeals[0];
        if (!textMatch) {
          if (refBreakfast) {
            // Breakfast = oldest substantial meal
            matchedMeal = usableMeals[usableMeals.length - 1];
          } else if (refDinner) {
            // Dinner = most recent substantial meal
            matchedMeal = usableMeals[0];
          } else if (refLunch) {
            // Lunch = highest-calorie meal above 150 kcal (excludes drinks/snacks)
            const candidates = usableMeals.filter(r => (r.kcalInt || 0) > 150);
            matchedMeal = candidates.length > 0
              ? candidates.reduce((a, b) => ((a.kcalInt || 0) >= (b.kcalInt || 0) ? a : b))
              : usableMeals[0];
          }
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
        }).catch((e) => { console.error("[quick_relog mealLogs insert]", e); throw e; });
        invalidatePatternCache(user.id);
        invalidateFoodTotalsCache(user.id);
        const calorieTarget = user.calorieTarget || 1800;
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
        const calorieDone = remaining <= 0;
        const protNote = protGap > 0
          ? (calorieDone ? `${protGap}g protein short — carry to tomorrow.` : `${protGap}g protein left.`)
          : "Protein target hit ✅";
        return `♻️ ${copyLabel}:\n${labels.map(l => `• ${l}`).join("\n") || `• ${toRepeat.slice(0, 60)}`}\n\n*+${totalCals} kcal · +${totalProt}g protein*\n${remaining > 0 ? `${remaining} kcal remaining today.` : "Calorie target hit. ✅"} ${protNote}`;
      }

      const repeatReply = await handleMessage(phone, toRepeat);
      return `♻️ Same meal logged: "${toRepeat.slice(0, 80)}"\n\n${repeatReply}`;
    } catch (err) {
      console.error("[REPEAT MEAL]", err);
      return `Something went wrong logging that meal. Please type what you ate (e.g. "pap and chicken") and I will log it directly.`;
    }
  }

  // ---- GUILT / SHAME SIGNAL — client is embarrassed about what they ate ----
  // 🙈 (see-no-evil) is the most common "I know, I know" emoji in SA WhatsApp food logs.
  // Detect and respond without adding more judgment — log it, move on, next meal.
  const hasGuiltSignal = /[\u{1F648}\u{1F649}\u{1F64A}]/u.test(message)
    || /\b(i know i know|guilty|oops|i shouldn.?t|i know it.?s bad|bad i know|not good i know|cheat meal|i cheated|fell off|messed up|slipped|my bad|naughty|bad choice|i gave in|couldn.?t resist|treat myself|i know this is bad|terrible choice)\b/i.test(m);

  // ---- SA FOOD DATABASE MATCHING + GPT FOOD FALLBACK ----
  const isSoftStruggleEarly =/\b(i.?m (really |so |just )?(struggling|falling behind|losing motivation|lost motivation|feeling behind|feeling lost|not sure what i.?m doing|demotivated|unmotivated))\b/.test(m) || /\b(feel like (giving up|i.?m failing|i.?m not making progress|nothing is working|i.?m not getting it right|i.?m behind))\b/.test(m) || /\b(i don.?t (know what.?s happening|know what i.?m doing|know if this is working))\b/.test(m) || /\b(hard (to stay|to keep|to maintain) (motivated|going|consistent))\b/.test(m) || /\b(haven.?t (trained|worked out|been to gym|gone to gym)|didn.?t (train|work out)|no (training|workout|gym) (for |in )?\d+\s*(days?|weeks?))\b/.test(m) || /\bfeeling (down|low|unmotivated|demotivated|flat|defeated|hopeless about (this|my progress|the gym))\b/i.test(m) || /\b(unmotivated|demotivated|lost (my |all )?(motivation|drive)|no motivation|zero motivation)\b/i.test(m);
  const isEmotionalMsg = isSoftStruggleEarly;
  const foodsInMsg = scanForSAFoods(m);
  const hasActualFood = foodsInMsg.length > 0;
  const isEmotionalOnly = isEmotionalMsg && !hasLogTrigger;
  const isShortFoodMsg = !isQuestion && hasLogTrigger && hasActualFood && m.split(/\s+/).length <= 30;
  // directFoodScan: fires on bare food-word messages ("rice and chicken", "pap and wors").
  // Requires 2+ food items OR an explicit quantity word — prevents single food words
  // ("eggs", "milk") or shopping/planning fragments from being auto-logged.
  const hasQuantityWord = /\b(\d+|one|two|three|four|five|half|a\s+cup|a\s+bowl|a\s+plate|a\s+tin|a\s+scoop|tbsp|tsp|grams?|kg|ml|litre)\b/i.test(m);
  // Auto-logging without an eating verb demands EXACT food matches — a fuzzy guess
  // is never enough evidence to write to the food log on its own.
  const exactFoodCount = scanForSAFoods(m, { exactOnly: true }).length;
  const directFoodScan = !isQuestion && !isFrustration && !hasLogTrigger && !isFuturePlanning && hasActualFood
    && m.split(/\s+/).length <= 12
    && exactFoodCount >= 1
    && (exactFoodCount >= 2 || hasQuantityWord);
  // foodLogOverride: Only bypass the isQuestion guard when the message is a past-eating
  // statement with a trivial trailing "?" (confirmation, e.g. "I had eggs?") — NOT when
  // the message contains a substantive nutritional question ("is that enough protein?",
  // "how many calories in that?"). Logging food in response to a genuine question
  // would silently discard the question and never answer it.
  const hasSubstantiveQuestion = /\b(is that enough|how much|how many|is it (ok|good|healthy|bad|enough|too much)|good for|bad for|enough protein|enough calories|too (many|much)|any good|is this (ok|good|healthy|bad|enough)|is (that|this) (bad|good|ok|healthy)|have protein|contain protein|much protein|has protein)\b/i.test(m)
    || /^(is |does |do |will |can |should |are |have |has )\b/i.test(m);
  const foodLogOverride = hasLogTrigger && hasActualFood && !hasSubstantiveQuestion;

  // Diagnostic: any message containing recognised foods logs its gate state — when a
  // meal silently fails to log in production, this line names the reason instantly.
  if (hasActualFood) {
    console.log(`[FOOD_GATE] user=...${String(user.id || "").slice(-6)} foods=[${foodsInMsg.map(f => f.name).join("|")}] q=${isQuestion} frus=${isFrustration} emo=${isEmotionalOnly} future=${isFuturePlanning} trig=${hasLogTrigger} direct=${directFoodScan} words=${m.split(/\s+/).length}`);
  }

  // ---- RETROSPECTIVE DIET HISTORY — "within the week", "usually eat", "normally I have" ----
  // These are diet audits describing routine or past eating — NOT today's food log.
  // Must fire BEFORE the scanner path so nothing gets logged to today's calories.
  const RETRO_DIET_RE = /\b(within\s+the\s+week|this\s+week\s+i.?(?:ve|have|had|been)|during\s+the\s+week|throughout\s+the\s+week|last\s+few\s+days|a\s+few\s+days\s+ago|over\s+the\s+(?:past|last)\s+(?:few\s+days|week)|most\s+days?\s+(?:i\s+)?eat|every\s+day\s+i\s+(?:eat|have|had)|i\s+(?:usually|normally|generally|typically)\s+(?:eat|have|had|have\s+been\s+eating)|my\s+usual\s+(?:diet|meals?|foods?|breakfast|lunch|dinner)|i\s+tend\s+to\s+(?:eat|have)|my\s+normal\s+(?:diet|meals?|foods?)|for\s+the\s+past\s+(?:few\s+days|week))\b/i;
  const todaySignalPresent = /\b(today|just\s+had|just\s+ate|right\s+now)\b/i.test(m);
  const isRetroDietAudit = RETRO_DIET_RE.test(m) && !todaySignalPresent && hasActualFood;

  if (isRetroDietAudit) {
    const goal = user.goalType || "fat_loss";
    const name = user.name?.split(" ")[0] || "";
    const categories = foodsInMsg.map(f => f.category);
    const hasProtein = categories.some(c => c === "protein");
    const hasCarb = categories.some(c => c === "carb");
    const hasJunk = categories.some(c => c === "junk");
    let dietFeedback: string;
    if (goal === "muscle_gain") {
      if (hasProtein && hasCarb) {
        dietFeedback = `Protein and carbs in the mix — good base for building. Keep that going consistently.`;
      } else if (hasProtein) {
        dietFeedback = `Solid protein choices. For muscle gain, make sure you are pairing them with enough carbs (rice, oats, sweet potato) to fuel training.`;
      } else if (hasCarb) {
        dietFeedback = `Good carb sources. For muscle, protein is the priority — add chicken, eggs, or mince to every meal.`;
      } else {
        dietFeedback = `Decent food choices. For muscle gain, anchor every meal with 30g+ protein.`;
      }
    } else {
      if (hasProtein && hasCarb && !hasJunk) {
        dietFeedback = `Solid structure — protein and carbs, no junk. That is a fat loss diet done right. Consistency over the week is what counts.`;
      } else if (hasJunk) {
        dietFeedback = `Good foods in there with some extras. For fat loss, the weekly pattern matters more than any single meal — keep your core meals clean.`;
      } else if (hasProtein) {
        dietFeedback = `Good protein focus. Add some veg (spinach, cabbage, butternut) to increase volume without adding calories — keeps you fuller longer.`;
      } else {
        dietFeedback = `Reasonable choices. For fat loss, make sure protein anchors every meal — it controls hunger and preserves muscle.`;
      }
    }
    const retroReply = `${name ? name + ", t" : "T"}hanks for the overview — good to know what your week looks like.\n\n${dietFeedback}\n\n_This hasn't been logged as today's calories._ To log today, just tell me what you have eaten: *"I had oats and eggs for breakfast"* and I will add it.`;
    await logChat(user.id, message, retroReply, "DIET_AUDIT");
    return retroReply;
  }

  // DIET AUDIT CONTINUATION — "And it was chicken...", "Also had X" immediately after a diet audit
  if (!isRetroDietAudit && hasActualFood && !hasLogTrigger && !todaySignalPresent && /^and\b/i.test(m.trim())) {
    try {
      const lastChat = await db.select({ intent: chatHistory.intent })
        .from(chatHistory).where(eq(chatHistory.userId, user.id))
        .orderBy(desc(chatHistory.createdAt)).limit(1);
      if (lastChat[0]?.intent === "DIET_AUDIT") {
        const foodList = foodsInMsg.map(f => f.name).join(", ");
        const contReply = `Noted — ${foodList} added to your diet picture.\n\n_Still not logged as today's calories._ To log today: *"I had [food] for dinner"* and I will add it.`;
        await logChat(user.id, message, contReply, "DIET_AUDIT");
        return contReply;
      }
    } catch { /* non-fatal */ }
  }

  // ---- SHOPPING LIST / PANTRY INVENTORY DETECTION ----
  // A dash-formatted list of pantry staples (or a long list with no meal context) is NOT a meal.
  // 3+ dash-listed items + shopping/pantry language → block.
  // 7+ dash-listed items alone → block (nobody eats 7+ bulleted items as one sitting).
  // NOTE: must use original `message` for line splitting — `m` collapses all whitespace to spaces.
  const dashLineCount = message.split("\n").filter(l => /^\s*-\s*\S/.test(l)).length;
  const SHOPPING_CONTEXT_RE = /\b(isle\s*by\s*isle|go\s*(?:isle|aisle)|aisle|what\s+i\s+have\s+(?:at\s+home|here)|have\s+at\s+home|at\s+home\s+i\s+(?:have|keep|stock)|what\s+i\s+(?:normally\s+)?(?:buy|stock|keep)|what.*(?:think|choose|chose)\s+(?:is\s+)?missing|shopping\s+list|groceries?|pantry|in\s+(?:my\s+)?fridge|what.?s\s+in\s+(?:my|the)\s+(?:fridge|pantry|house|cupboard)|i\s+stock|need\s+to\s+buy|running\s+low|picked\s+up\s+from|went\s+to\s+(?:the\s+)?(?:shop|store|checkers|shoprite|pick\s*n\s*pay|woolworths|spar))\b/i;
  // Plain-line list safety net: 12+ non-empty lines with no eating verbs = grocery list.
  // Routes.ts normally catches this with _isGroceryList before food-context runs, but if
  // the list slips through (e.g., intro sentence + many items confusing the parser), this
  // second gate prevents the food scanner from logging 25 grocery items as a 2330 kcal meal.
  const _plainLineCount = message.split("\n").map(l => l.trim()).filter(l => l.length > 1).length;
  const isPlainLineList = !hasLogTrigger && _plainLineCount >= 12;
  const isShoppingListMsg = !hasLogTrigger && (
    (dashLineCount >= 3 && SHOPPING_CONTEXT_RE.test(m)) ||
    dashLineCount >= 7 ||
    isPlainLineList
  );

  if (isShoppingListMsg) {
    const name = user.name?.split(" ")[0] || "there";
    // Extract items — handle dashes, bullets, OR plain one-per-line
    const items = message.split("\n")
      .map(l => l.replace(/^(\[\s*[x✓\s]?\]|[-•*]|\d+[\.\)])\s*/, "").trim())
      .filter(l => l.length > 1 && l.length < 80);
    let shoppingReply: string;
    try {
      const { refineGroceryList } = await import("../grocery-refine");
      shoppingReply = await refineGroceryList(items, user);
      if (!shoppingReply) throw new Error("empty refine result");
    } catch {
      const preview = items.slice(0, 3).join(", ");
      const moreNote = items.length > 3 ? ` and ${items.length - 3} more` : "";
      shoppingReply = `${name}, got your list — ${preview}${moreNote}. I've noted your staples.\n\n_Not logged as a meal._ When you eat, just tell me: *"I had eggs and rice for lunch"* and I'll track the numbers.\n\nType *shopping list* and I'll send you your full goal-adjusted weekly list.`;
    }
    await logChat(user.id, message, shoppingReply, "SHOPPING_LIST");
    return shoppingReply;
  }

  // ---- PLANNED MEAL — food described in future EATING tense ("gonna have X for lunch").
  // Be honest that it is NOT logged, and give a one-word path to log it once eaten.
  // Without this, GPT chats about the meal and the client believes it was logged —
  // then "dinner same as lunch" copies a stale meal and the coach contradicts itself.
  // Eating-future only: shopping intents ("need to buy") fall through to other handlers.
  const isFutureEating = /\b(i.?ll\s+have|i\s+will\s+have|gonna\s+have|going\s+to\s+have|planning\s+to\s+(?:eat|have|cook)|thinking\s+of\s+(?:eating|having|cooking)|will\s+be\s+(?:eating|having))\b/i.test(m);
  if (isFutureEating && !isQuestion && !isFrustration && hasActualFood) {
    const junkPlanned = foodsInMsg.filter(f => f.category === "junk");
    const plannedNames = foodsInMsg.map(f => f.name).join(", ");
    const plannedLabel = extractMealLabel(message);
    const swapNote = junkPlanned.length > 0
      ? `\n\nIf you want to swap anything out later, I can suggest alternatives — just ask.`
      : `\n\nGood plan — solid choices in there.`;
    const plannedReply = `Sounds like ${plannedLabel || "a meal"} in the making — ${plannedNames}.${swapNote}\n\n_Not logged yet._ When you've eaten, reply *ate it* and I'll log it.`;
    await logChat(user.id, message, plannedReply, "FOOD_PLANNED");
    return plannedReply;
  }

  // ---- MULTI-DAY CATCH-UP LOGGING ----
  // Fires when client logs food for 2+ different days in one message:
  //   "Had chicken Wednesday, oats Thursday morning, pap Friday dinner"
  // Without this, parseMealDate picks the first day found and all foods land
  // on the same wrong date. Each day now gets its own DB entry at the correct
  // historical loggedAt.
  const MDAY_NAME_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|yesterday|today)\b/gi;
  const mDayMatches: Array<{ name: string; idx: number }> = [];
  {
    let mdm: RegExpExecArray | null;
    const reMD = new RegExp(MDAY_NAME_RE.source, "gi");
    while ((mdm = reMD.exec(m)) !== null) {
      const key = mdm[0].toLowerCase();
      if (!mDayMatches.find(d => d.name === key))
        mDayMatches.push({ name: key, idx: mdm.index });
    }
  }

  if (mDayMatches.length >= 2 && !isQuestion && !isFrustration && !isFuturePlanning && hasActualFood) {
    mDayMatches.sort((a, b) => a.idx - b.idx);

    const daySegs: Array<{ day: string; text: string }> = [];
    for (let i = 0; i < mDayMatches.length; i++) {
      const { name, idx } = mDayMatches[i];
      const afterStart = idx + name.length;
      const afterEnd = i + 1 < mDayMatches.length ? mDayMatches[i + 1].idx : m.length;
      let segText = m.slice(afterStart, afterEnd).replace(/^[\s,;.]+|[\s,;.]+$/g, "").trim();
      // Food before the first day name belongs to that day ("Had chicken Wednesday" → chicken → Wednesday)
      if (i === 0 && idx > 0) {
        const prefix = m.slice(0, idx).replace(/^[\s,;.]+|[\s,;.]+$/g, "").trim();
        if (prefix) segText = prefix + (segText ? " " + segText : "");
      }
      daySegs.push({ day: name, text: segText });
    }

    // Collect planned inserts first — only write if 2+ days have food hits
    const multiPlan: Array<{ label: string; foods: SAFood[]; kcal: number; prot: number; date: Date; raw: string }> = [];
    for (const seg of daySegs) {
      const segFoods = scanForSAFoods(seg.text);
      if (segFoods.length === 0) continue;
      const segDate = parseMealDate(seg.day + " " + seg.text);
      let segKcal = 0, segProt = 0;
      for (const f of segFoods) { segKcal += f.typicalPortionCalories || 0; segProt += f.typicalPortionProtein || 0; }
      multiPlan.push({ label: mealDateLabel(segDate), foods: segFoods, kcal: segKcal, prot: segProt, date: segDate, raw: seg.day + ": " + seg.text });
    }

    if (multiPlan.length >= 2) {
      await Promise.all(multiPlan.map(p =>
        db.insert(mealLogs).values({
          userId: user.id,
          rawMessage: p.raw,
          source: "text",
          kcalInt: p.kcal,
          proteinInt: p.prot,
          carbsInt: 0,
          fatInt: 0,
          loggedAt: p.date,
        }).catch(e => console.warn("[multiday-log insert]", e))
      ));
      const logSummary = multiPlan.map(p => `${p.label}: ${p.foods.map(f => f.name).join(", ")} (${p.kcal} kcal)`).join("\n");
      await logChat(user.id, message, logSummary, "FOOD_LOG");
      invalidatePatternCache(user.id);
      invalidateFoodTotalsCache(user.id);
      const recomp = await recomputeTodayFoodTotals(user.id);
      await db.update(users).set({ todayCalories: recomp.calories, todayProteinG: recomp.protein, todayCaloriesDate: sastToday() })
        .where(eq(users.id, user.id)).catch(e => console.error("[FOOD_TOTAL_UPDATE]", e?.message || e));
      const lines = multiPlan.map(p => {
        const cap = p.label.charAt(0).toUpperCase() + p.label.slice(1);
        return `*${cap}:* ${p.foods.map(f => f.name).join(", ")} — ${p.kcal} kcal | ${p.prot}g protein`;
      });
      const todayNote = recomp.calories > 0 ? `\n\n_Today's running total: ${recomp.calories} kcal | ${recomp.protein}g protein._` : "";
      return `Logged ${multiPlan.length} days. ✅\n\n${lines.join("\n")}${todayNote}`;
    }
    // Fewer than 2 days had recognised food — fall through to single-day scanner
  }

  if ((!isQuestion || foodLogOverride) && !isFrustration && !isEmotionalOnly && !isFuturePlanning && hasActualFood && (hasLogTrigger || directFoodScan)) {
    console.log(`[FOOD_SCAN] gate fired — user=...${String(user.id || "").slice(-6)} foods=${foodsInMsg.length} trigger=${hasLogTrigger} direct=${directFoodScan}`);
    const MEAL_KEYWORDS = ["breakfast", "lunch", "dinner", "supper", "snack", "brunch", "morning", "afternoon", "evening"];
    const mealSegments: { label: string; text: string }[] = [];

    // Allow "for a snack", "for my dinner", "for the lunch" etc. — articles are non-capturing.
    const FOR_MEAL_RE = /\bfor\s+(?:a\s+|my\s+|the\s+)?(breakfast|lunch|dinner|supper|snack|brunch|morning|afternoon|evening)\b/gi;
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

      // Portion-size modifier — "big plate of pap" → 1.5×, "half a portion" → 0.5×
      // Applied globally across all foods in the segment (whole meal was described as big/small)
      let sizeMultiplier = 1;
      if (/(big|large|huge|heaped|extra\s*large|xl|full\s*plate|loaded)\s+(?:plate|bowl|portion|serving|of\b)/i.test(normText)
        || /\b(double|extra\s+helping|extra\s+large\b)/i.test(normText)) {
        sizeMultiplier = 1.5;
      } else if (/(small|tiny|little|mini|quarter)\s+(?:plate|bowl|portion|serving)/i.test(normText)
        || /\ba\s+(?:small|tiny|little)\s+bit\s+of\b/i.test(normText)
        || /\bsmall\s+amount\s+of\b/i.test(normText)) {
        sizeMultiplier = 0.7;
      } else if (/\b(?:half|halved)\s+(?:a\s+)?(?:plate|bowl|portion|serving|of\b)/i.test(normText)
        || /\b(?:half\s+(?:the\s+)?(?:pap|rice|pasta|meal|food)\b)/i.test(normText)) {
        sizeMultiplier = 0.5;
      }

      return foods.map(f => {
        const allAliases = [f.name.toLowerCase(), ...f.aliases.map(a => a.toLowerCase())];
        let quantity = 1;
        for (const alias of allAliases) {
          const qtyDirect = normText.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+(?:${escapeRegex(alias)})`, "i"));
          const qtyWithFiller = normText.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+(?:slices?|pieces?|cups?|bowls?|plates?|portions?|servings?|tablespoons?|teaspoons?|tbsp|tsp|glasses?)\\s+(?:of\\s+)?(?:${escapeRegex(alias)})`, "i"));
          // Fallback: "3 stashes of bread", "2 chunks of pap" — voice mishearings produce non-standard unit
          // words. "N <word> of <food>" almost always means N portions, so apply the quantity.
          const qtyWithAnyFiller = !qtyDirect && !qtyWithFiller
            ? normText.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+\\w+s?\\s+of\\s+(?:${escapeRegex(alias)})`, "i"))
            : null;
          const qtyBefore = qtyDirect || qtyWithFiller || qtyWithAnyFiller;
          if (qtyBefore) {
            const userQty = parseFloat(qtyBefore[1]);
            const defaultQty = portionDefaultCount(f.typicalPortionDescription);
            if (userQty > 0 && defaultQty > 0 && userQty !== defaultQty) {
              quantity = userQty / defaultQty;
            }
            break;
          }
        }
        quantity = quantity * sizeMultiplier;
        return {
          ...f,
          adjustedCalories: Math.round(f.typicalPortionCalories * quantity),
          adjustedProtein: Math.round(f.typicalPortionProtein * quantity),
          adjustedDescription: scalePortionDescription(f.typicalPortionDescription, quantity),
          quantity,
        };
      });
    }

    type AdjFood = SAFood & { adjustedCalories: number; adjustedProtein: number; adjustedDescription: string; quantity: number };
    const allAdjustedFoods: AdjFood[] = [];
    const isMultiMeal = mealSegments.length >= 2;
    // Per-segment buckets — so a multi-meal log attributes each food (including
    // GPT-supplemented items) to the correct meal in the breakdown, not just the total.
    const segmentBuckets: { label: string; text: string; foods: AdjFood[] }[] = [];

    for (const seg of mealSegments) {
      const segFoods = scanForSAFoods(seg.text);
      const adjusted = segFoods.length > 0 ? adjustFoodsForSegment(segFoods, seg.text) : [];
      segmentBuckets.push({ label: seg.label, text: seg.text, foods: adjusted });
      allAdjustedFoods.push(...adjusted);
    }

    // ---- PARTIAL MATCH SUPPLEMENT — catch food items SA scanner missed ----
    // Only fires when the message has substantive unmatched content (e.g. "mushroom sauce" with "pap").
    // Each supplemented item is attributed back to the segment whose text mentions it.
    if (allAdjustedFoods.length > 0 && hasUnmatchedFoodContent(m, allAdjustedFoods)) {
      try {
        const suppItems = await gptFoodSupplement(message, user, allAdjustedFoods.map(f => f.name));
        if (suppItems && suppItems.length > 0) {
          // Dedup: skip GPT items whose name overlaps with an already-matched SA food
          const filtered = suppItems.filter((si: GptFoodItem) => {
            const siWords = si.name.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
            return !allAdjustedFoods.some(saF => {
              const saTerms = [saF.name.toLowerCase(), ...saF.aliases.map((a: string) => a.toLowerCase())];
              return siWords.some((w: string) => saTerms.some(t => t.includes(w)));
            });
          });
          for (const sf of filtered) {
            const adj: AdjFood = {
              name: sf.name,
              aliases: [],
              caloriesPer100g: 0,
              proteinPer100g: 0,
              carbsPer100g: sf.carbs_g,
              fatPer100g: sf.fat_g,
              typicalPortionDescription: sf.portion_desc,
              typicalPortionGrams: 0,
              typicalPortionCalories: sf.kcal,
              typicalPortionProtein: sf.protein_g,
              category: sf.category,
              budgetTier: 2,
              notes: "",
              adjustedCalories: sf.kcal,
              adjustedProtein: sf.protein_g,
              adjustedDescription: sf.portion_desc,
              quantity: 1,
            };
            allAdjustedFoods.push(adj);
            // Attribute to the segment whose text mentions this item; else the last segment.
            const sfWords = sf.name.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
            const target = segmentBuckets.find(b => sfWords.some(w => b.text.toLowerCase().includes(w)))
              || segmentBuckets[segmentBuckets.length - 1];
            if (target) target.foods.push(adj);
          }
        }
      } catch (e) {
        console.warn("[PARTIAL-MATCH SUPP] error:", e);
      }
    }

    // Build the multi-meal breakdown AFTER supplement attribution, so each meal line
    // includes its GPT-supplemented items (not just the running total).
    const mealLines: string[] = [];
    if (isMultiMeal) {
      for (const b of segmentBuckets) {
        if (!b.label || b.foods.length === 0) continue;
        const segCals = b.foods.reduce((s, f) => s + f.adjustedCalories, 0);
        const segProt = b.foods.reduce((s, f) => s + f.adjustedProtein, 0);
        const lines = b.foods.map(f => `  • ${f.name}: ~${f.adjustedCalories} kcal, ${f.adjustedProtein}g protein`).join("\n");
        mealLines.push(`*${b.label}:* ~${segCals} kcal | ${segProt}g protein\n${lines}`);
      }
    }

    if (allAdjustedFoods.length > 0) {
      const totalCals = allAdjustedFoods.reduce((s, f) => s + f.adjustedCalories, 0);
      const totalProtein = allAdjustedFoods.reduce((s, f) => s + f.adjustedProtein, 0);
      const calorieTarget = user.calorieTarget || 1800;
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

      let todayStepCount = 0;
      try {
        const stepRow = await db.select({ steps: stepLogs.steps }).from(stepLogs)
          .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, sastDayStart())))
          .orderBy(desc(stepLogs.loggedAt)).limit(1);
        todayStepCount = stepRow[0]?.steps || 0;
      } catch { /* non-fatal */ }

      let junkNoteText = "";
      if (junkFoods.length > 0 && goodProteins.length === 0) {
        // Only surface the junk note when the meal has NO real protein at all.
        // If someone ate viennas WITH eggs, the eggs are doing the work — the meal is fine.
        // Flagging "Highly processed" after "Strong meal" contradicts the coach and shames
        // the client for eating what they had on hand. Suppress it. The numbers tell the story.
        const note = junkFoods[0].notes || "";
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

      const isSnackLog = /\bsnack\b/i.test(m) || (!isMultiMeal && totalCals < 250 && totalProtein <= 4);
      const isDessertLog = !isMultiMeal && /\b(dessert|treat|pudding|cake|chocolate|ice cream|biscuit|cookie)\b/i.test(m);
      const mealLabel = isMultiMeal ? "Day total" : isDessertLog ? "Dessert" : isSnackLog ? "Snack" : "Meal total";
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

      const scannerLoggedAt = parseMealDate(message);
      const scannerIsRetro = isRetroactiveMeal(message);
      // Carbs/fat per food: take the LOWER of two estimates.
      //  • dry estimate  = per-100g × portion grams — overcounts cooked staples
      //    (rice/pasta/lentils per-100g is dry weight, the portion is cooked: 3-4× too high)
      //  • ratio estimate = portion calories × that macro's energy share — overcounts
      //    alcohol (beer/wine calories are ethanol, not in 4P+4C+9F)
      // The two error modes never hit the same food, so min() yields the right value
      // for both. These totals feed the coach's "authoritative" daily macros (gpt.ts),
      // so an inflated carb count was making the coach wrongly tell clients to cut staples.
      const macroEnergy = (f: any) => 4 * (f.proteinPer100g || 0) + 4 * (f.carbsPer100g || 0) + 9 * (f.fatPer100g || 0);
      const totalCarbs = Math.round(allAdjustedFoods.reduce((s, f: any) => {
        const grams = (f.typicalPortionGrams || 100) * (f.quantity || 1);
        const dry = grams * (f.carbsPer100g || 0) / 100;
        const e = macroEnergy(f);
        const ratio = e > 0 ? (f.adjustedCalories || 0) * (4 * (f.carbsPer100g || 0) / e) / 4 : dry;
        return s + Math.min(dry, ratio);
      }, 0));
      const totalFat = Math.round(allAdjustedFoods.reduce((s, f: any) => {
        const grams = (f.typicalPortionGrams || 100) * (f.quantity || 1);
        const dry = grams * (f.fatPer100g || 0) / 100;
        const e = macroEnergy(f);
        const ratio = e > 0 ? (f.adjustedCalories || 0) * (9 * (f.fatPer100g || 0) / e) / 9 : dry;
        return s + Math.min(dry, ratio);
      }, 0));
      const firstSegLabel = mealSegments.find(s => s.label)?.label || extractMealLabel(message);
      const scannerItems = allAdjustedFoods.map(f => ({
        name: f.name,
        grams: Math.round((f.typicalPortionGrams || 100) * (f.quantity || 1)),
        kcal: f.adjustedCalories,
        protein: f.adjustedProtein,
        category: f.category,
      }));
      const committed = await commitFoodLog({
        userId: user.id,
        phone,
        rawMessage: message.slice(0, 1000),
        source: scannerIsRetro ? "retro" : "sa_scanner",
        kcalInt: totalCals,
        proteinInt: Math.round(totalProtein),
        carbsInt: totalCarbs,
        fatInt: totalFat,
        items: scannerItems,
        mealLabel: firstSegLabel,
        loggedAt: scannerLoggedAt,
      });
      if (!committed.ok) {
        const failReply = `Eish — I worked out that meal (~${totalCals} kcal | ${Math.round(totalProtein)}g protein) but couldn't save it just now. Send it again in a moment and I'll log it.`;
        await logChat(user.id, message, failReply, "FOOD_LOG_FAILED");
        return failReply;
      }
      const { prevCals, runningCals, runningProtein } = committed;

      const reply = buildFoodLogReply({
        foodLines, mealLabel, totalMealCals: totalCals, totalMealProtein: totalProtein,
        runningCals, runningProtein, calorieTarget, proteinTarget, prevCals,
        junkNoteText, hasGoodProteins: goodProteins.length > 0,
        hasCarbs: allAdjustedFoods.some(f => f.category === "carb"),
        coachNoteOverride: denseFoodCoachNote,
        user, todaySteps: todayStepCount,
      });

      const scannerRetroNote = scannerIsRetro ? `\n_Logged to ${mealDateLabel(scannerLoggedAt)}._` : "";
      await logChat(user.id, message, reply, "FOOD_LOG");
      const [saPattern, saDay, foodStreak] = await Promise.all([
        checkFoodPatterns(user.id),
        checkPerfectDay(user.id, user.proteinTarget || 120),
        computeFoodLogStreak(user.id),
      ]);
      const streakCelebration = getStreakNote(user.id, foodStreak, user.name || "");
      const stepAppend = stepReplyPart ? `\n\n${stepReplyPart}` : "";

      // Combo meal upsell — after logging a high-protein SA combo, suggest a veg side
      const COMBO_UPSELL: Record<string, string> = {
        "Mince and pap":     "Pap and mince — classic muscle meal. 💪 Want to add a veg side? Spinach or chakalaka takes 2 minutes and adds iron without touching your macros.",
        "Pap and pilchards": "Pap and pilchards — the best budget protein meal in SA. 🐟 Add a handful of spinach or chakalaka to round it out.",
        "Pap and wors":      "Pap and wors — solid meal. 🔥 Add chakalaka or morogo to get some fibre in without adding calories.",
        "Chicken and pap":   "Pap and chicken — good protein. Add spinach or butternut on the side to hit your micronutrients.[BUTTONS:Add veg side|No thanks]",
        "Pap and stew":      "Pap and stew — high protein combo. Add cabbage or spinach on the side to balance the meal.",
      };
      const comboUpsell = allAdjustedFoods
        .map(f => COMBO_UPSELL[f.name])
        .find(note => note);
      const upsellNote = comboUpsell ? `\n\n${comboUpsell}` : "";
      const guiltNote = hasGuiltSignal ? `\n\n_No judgment — it's logged and counted. One off-plan meal doesn't undo weeks of work. Your next meal is the reset._` : "";

      return `${reply}${scannerRetroNote}${saPattern ? "\n\n" + saPattern : ""}${saDay || ""}${streakCelebration}${upsellNote}${guiltNote}${stepAppend}`;
    }

    // ---- GPT FOOD FALLBACK (SA scanner had food keywords but 0 adjusted matches) ----
    if (!isQuestion && hasLogTrigger && hasActualFood) {
      const gptFallbackResult = await gptFoodFallback(message, user);
      if (gptFallbackResult) {
        const calorieTarget = user.calorieTarget || 1800;
        const proteinTarget = user.proteinTarget || 120;
        const foodLines = gptFallbackResult.foods.map(f =>
          `• ${f.name}: ~${f.kcal} kcal, ${f.protein_g}g protein (${f.portion_desc})`
        ).join("\n");
        const fbIsSnack = /\bsnack\b/i.test(m) || (gptFallbackResult.totalKcal < 250 && gptFallbackResult.totalProtein <= 4);
        const fbIsDessert = /\b(dessert|treat|pudding|cake|chocolate|ice cream|biscuit|cookie)\b/i.test(m);
        const gptLoggedAt = parseMealDate(message);
        const gptIsRetro = isRetroactiveMeal(message);
        const committed = await commitFoodLog({
          userId: user.id,
          phone,
          rawMessage: message.slice(0, 1000),
          source: gptIsRetro ? "retro" : "gpt_fallback",
          kcalInt: gptFallbackResult.totalKcal,
          proteinInt: gptFallbackResult.totalProtein,
          carbsInt: Math.round(gptFallbackResult.foods.reduce((s: number, f: any) => s + (Number(f.carbs_g) || 0), 0)),
          fatInt: Math.round(gptFallbackResult.foods.reduce((s: number, f: any) => s + (Number(f.fat_g) || 0), 0)),
          items: gptFallbackResult.foods.map((f: any) => ({
            name: f.name, grams: 0, kcal: f.kcal, protein: f.protein_g, category: f.category,
          })),
          mealLabel: extractMealLabel(message),
          loggedAt: gptLoggedAt,
        });
        const { prevCals: fbPrevCals, runningCals, runningProtein } = committed;
        const fallbackReply = buildFoodLogReply({
          foodLines, mealLabel: fbIsDessert ? "Dessert" : fbIsSnack ? "Snack" : "Meal total",
          totalMealCals: gptFallbackResult.totalKcal, totalMealProtein: gptFallbackResult.totalProtein,
          runningCals, runningProtein, calorieTarget, proteinTarget, prevCals: fbPrevCals,
          coachNoteOverride: gptFallbackResult.coachNote || undefined,
          hasGoodProteins: gptFallbackResult.foods.some((f: any) => f.category === "protein"),
          hasCarbs: gptFallbackResult.foods.some((f: any) => f.category === "carb"),
          user,
        });
        await logChat(user.id, message, fallbackReply, "FOOD_LOG");
        const [fbPattern, fbDay, fbStreak] = await Promise.all([checkFoodPatterns(user.id), checkPerfectDay(user.id, user.proteinTarget || 120), computeFoodLogStreak(user.id)]);
        const fbGuiltNote = hasGuiltSignal ? `\n\n_No judgment — it's logged and counted. One off-plan meal doesn't undo weeks of work. Your next meal is the reset._` : "";
        console.log(`[GPT-FOOD-FALLBACK] ${user.id.slice(0, 8)} — ${gptFallbackResult.foods.map((f: any) => f.name).join(", ")} — ${gptFallbackResult.totalKcal} kcal${gptFallbackResult.fromCache ? " [cached]" : ""}`);
        const protClarifyNote = (gptFallbackResult.totalProtein === 0 && gptFallbackResult.totalKcal >= 150 && !fbIsSnack && !fbIsDessert)
          ? `\n\nWhat protein did you have with this? Chicken, eggs, tuna, beans — send it and I'll add it to your total.`
          : "";
        const fbDroppedNote = (gptFallbackResult.dropped && gptFallbackResult.dropped.length > 0)
          ? `\n\n⚠️ I left part of that out — I wasn't sure I read it right, and I won't put a number on your day that I'm guessing at. Send the rest one item per line (like "1 cup rice") and I'll add it.`
          : "";
        return `${fallbackReply}${fbPattern ? "\n\n" + fbPattern : ""}${fbDay || ""}${getStreakNote(user.id, fbStreak, user.name || "")}${fbGuiltNote}${protClarifyNote}${fbDroppedNote}`;
      }
    }
  }

  // ---- GPT FOOD FALLBACK (no SA foods detected but clear food intent) ----
  const voiceFallbackTooLong = m.split(/\s+/).filter(Boolean).length > 50;
  const hasStrongFoodTrigger = /\b(i ate|i had|i've had|ive had|just had|just ate|just finished eating|for breakfast|for lunch|for dinner|for supper|for brunch|for snack|breakfast was|lunch was|dinner was|supper was|brunch was|meal was|meal is|food was|i'm eating|im eating|i am eating|i'll have|gonna have|going to have|pre.?workout meal|post.?workout meal|had a\b|had some\b|had the\b|had my\b|ate a\b|ate some\b|ate the\b|ate my\b|having a\b|having some\b|having my\b)\b/i.test(m);
  // FAIL OPEN: the SA database will never be comprehensive. A bare food statement with no
  // trigger phrase and no DB match ("two boerewors rolls and a Coke", "kota and chips") used
  // to slip past BOTH the database and GPT and get logged as nothing. Now any short,
  // declarative, non-question/non-emotional message also gets one shot at the GPT food
  // extractor — which self-filters non-food via is_food, so we only LOG when GPT confirms food.
  const looksLikeBareFoodStatement = !isFuturePlanning && !isFrustration && !hasSubstantiveQuestion
    && m.split(/\s+/).filter(Boolean).length <= 12;
  // isFuturePlanning ("going to have 2L water", "I'll have chicken later") must never hit the
  // GPT food extractor — the client hasn't eaten yet, so we'd generate a clarify-food reply
  // for a water-planning or meal-planning message. The water handler already skips these correctly;
  // without this guard the GPT path asks "I didn't catch what food that was."
  const tryGptFood = !isQuestion && !isEmotionalOnly && !hasActualFood && !voiceFallbackTooLong
    && !isFuturePlanning
    && (hasStrongFoodTrigger || looksLikeBareFoodStatement);
  if (tryGptFood) {
    const gptFallbackResult = await gptFoodFallback(message, user);
    if (gptFallbackResult) {
      const calorieTarget = user.calorieTarget || 1800;
      const foodLines = gptFallbackResult.foods.map((f: any) =>
        `• ${f.name}: ~${f.kcal} kcal, ${f.protein_g}g protein (${f.portion_desc})`
      ).join("\n");
      const fb2IsSnack = /\bsnack\b/i.test(m) || (gptFallbackResult.totalKcal < 250 && gptFallbackResult.totalProtein <= 4);
      const fb2IsDessert = /\b(dessert|treat|pudding|cake|chocolate|ice cream|biscuit|cookie)\b/i.test(m);
      const fb2LoggedAt = parseMealDate(message);
      const fb2IsRetro = isRetroactiveMeal(message);
      const committed2 = await commitFoodLog({
        userId: user.id,
        phone,
        rawMessage: message.slice(0, 1000),
        source: fb2IsRetro ? "retro" : "gpt_fallback",
        kcalInt: gptFallbackResult.totalKcal,
        proteinInt: gptFallbackResult.totalProtein,
        carbsInt: Math.round(gptFallbackResult.foods.reduce((s: number, f: any) => s + (Number(f.carbs_g) || 0), 0)),
        fatInt: Math.round(gptFallbackResult.foods.reduce((s: number, f: any) => s + (Number(f.fat_g) || 0), 0)),
        items: gptFallbackResult.foods.map((f: any) => ({
          name: f.name, grams: 0, kcal: f.kcal, protein: f.protein_g, category: f.category,
        })),
        mealLabel: extractMealLabel(message),
        loggedAt: fb2LoggedAt,
      });
      const { prevCals: fb2PrevCals, runningCals, runningProtein } = committed2;
      const fallbackReply = buildFoodLogReply({
        foodLines, mealLabel: fb2IsDessert ? "Dessert" : fb2IsSnack ? "Snack" : "Meal total",
        totalMealCals: gptFallbackResult.totalKcal, totalMealProtein: gptFallbackResult.totalProtein,
        runningCals, runningProtein, calorieTarget, proteinTarget: user.proteinTarget || 120,
        prevCals: fb2PrevCals,
        coachNoteOverride: gptFallbackResult.coachNote || undefined,
        hasGoodProteins: gptFallbackResult.foods.some((f: any) => f.category === "protein"),
        hasCarbs: gptFallbackResult.foods.some((f: any) => f.category === "carb"),
        user,
      });
      await logChat(user.id, message, fallbackReply, "FOOD_LOG");
      const [fbPattern, fbDay, fb2Streak] = await Promise.all([checkFoodPatterns(user.id), checkPerfectDay(user.id, user.proteinTarget || 120), computeFoodLogStreak(user.id)]);
      const fb2GuiltNote = hasGuiltSignal ? `\n\n_No judgment — it's logged and counted. One off-plan meal doesn't undo weeks of work. Your next meal is the reset._` : "";
      console.log(`[GPT-FOOD-FALLBACK] ${user.id.slice(0, 8)} — ${gptFallbackResult.foods.map((f: any) => f.name).join(", ")} — ${gptFallbackResult.totalKcal} kcal${gptFallbackResult.fromCache ? " [cached]" : ""}`);
      const fb2ProtClarifyNote = (gptFallbackResult.totalProtein === 0 && gptFallbackResult.totalKcal >= 150 && !fb2IsSnack && !fb2IsDessert)
        ? `\n\nWhat protein did you have with this? Chicken, eggs, tuna, beans — send it and I'll add it to your total.`
        : "";
      const fb2DroppedNote = (gptFallbackResult.dropped && gptFallbackResult.dropped.length > 0)
        ? `\n\n⚠️ I left part of that out — I wasn't sure I read it right, and I won't put a number on your day that I'm guessing at. Send the rest one item per line (like "1 cup rice") and I'll add it.`
        : "";
      return `${fallbackReply}${fbPattern ? "\n\n" + fbPattern : ""}${fbDay || ""}${getStreakNote(user.id, fb2Streak, user.name || "")}${fb2GuiltNote}${fb2ProtClarifyNote}${fb2DroppedNote}`;
    }
    // GPT returned null / is_food=false. If the user clearly signalled food (strong trigger),
    // ask them to clarify rather than silently dropping. But if we only got here on the loose
    // bare-statement path, GPT judging it non-food means it probably IS non-food — fall through
    // to normal chat so a non-food message never gets answered with "describe your food".
    if (hasStrongFoodTrigger) {
      console.warn(`[GPT-FOOD-FALLBACK] null result for: "${message.slice(0, 80)}" — asking for clarification`);
      const clarifyReply = `I didn't catch what food that was — can you describe it as something like "chicken breast and rice" or "2 slices of bread with peanut butter"? The more specific, the more accurate your log.`;
      await logChat(user.id, message, clarifyReply, "FOOD_CLARIFY");
      return clarifyReply;
    }
  }

  return null;
}

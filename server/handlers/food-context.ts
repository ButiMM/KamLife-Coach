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
  computeFoodLogStreak, getFoodStreakCelebration, shortStreakNote,
  invalidateFoodTotalsCache,
} from "./food-scanner";
import { macroCardMarker, cardOrTotals, achievementCardShown, cardBaseUrl } from "../macro-card-attach";
import { cardWillAttach } from "../card-policy";
import { claimOncePerDay } from "../once-daily";
import { estimateCarbsFat } from "../macro-estimate";
import { captureFriction } from "../friction";
import { nutritionGuardrailNudge } from "../nutrition-guardrails";
import { checkFoodPatterns, checkPerfectDay } from "./checks";
import { gptFoodFallback, gptFoodSupplement, type GptFoodItem, askCoachK } from "../gpt";
import { logChat, withTimeout, turnMutation } from "./chat-log";
import { unloggedFoodNotice, carriesFeelingClause } from "../unlogged-notice";
import { enforceReplyContract, clientAskedForDetail } from "../reply-contract";
import { sastDayStart, sastToday, parseMealDate, isRetroactiveMeal, mealDateLabel, slotFromSastHour, slotFromCaptionTime, isNightWorker, looksLikeDeepEmotionalShare, effectiveMealLoggedAt, spaceName, isAskingNotReporting } from "../utils";
import { explicitMealSlot } from "../understanding/actions";
import { getPortionMemory, personalPortionFor, getSlotContext, resolveInferredSlot, classifyPortionUnit, scalePortionDescription, type PortionStat, type SlotContext } from "../portion-memory";
import { invalidatePatternCache } from "../cache";
import { educationNote, remainingInMeals } from "../education";
import { firstActionCelebration } from "../activation";
import { amendRecentMeal, replaceHeldMeal } from "../food-identity-correction";
import { randomUUID } from "node:crypto";
import { commitFoodLog } from "../day-ledger";
export { commitFoodLog } from "../day-ledger";

// One owner — this literal was declared twice in this file.
const TREAT_WORDS = /\b(dessert|treat|pudding|cake|chocolate|ice cream|biscuit|cookie)\b/i;

export function extractMealLabel(msg: string, atDate?: Date, macros?: { kcal?: number | null; protein?: number | null }, user?: any, slotCtx?: SlotContext): string | null {
  const lo = msg.toLowerCase();
  const explicit = explicitMealSlot(msg);
  if (explicit) return explicit;
  // A light, low-protein log with no keyword is a SNACK — clock-slotting it steals a main slot
  // and lets a later "same breakfast" copy it (bug 2026-07-01).
  if (macros && macros.kcal != null && macros.kcal < 250 && (macros.protein ?? 0) <= 4) return "snack";
  // CAPTION TIME beats the send-clock (a diary shot at 11:00, batch-sent at 19:49, read dinner).
  const captionSlot = slotFromCaptionTime(msg);
  if (captionSlot) return captionSlot;
  // No keyword: night-shift/substantial late plate → "night meal", never a demoted "snack".
  // Their own hour-pattern beats the clock; a light second meal on a used slot demotes to snack.
  const fallback = slotFromSastHour(atDate, { nightWorker: isNightWorker(user), substantial: (macros?.kcal ?? 0) >= 300 });
  const sastHour = new Date((atDate ? atDate.getTime() : Date.now()) + 2 * 3_600_000).getUTCHours();
  return resolveInferredSlot(fallback, sastHour, slotCtx, macros?.kcal);
}

/**
 * WHERE ONE EATING EVENT ENDS AND THE NEXT BEGINS.
 *
 * (2026-08-17, traced from a real message.) This required the literal word "for", so "had eggs and
 * toast IN THE MORNING, pap and chicken AT LUNCH" produced ZERO boundaries and collapsed into one
 * segment. People do not say "for lunch" in a voice note; they say in, at, then, this morning.
 *
 * Widened to POST-POSITIONED prepositions only — "<food> in/at/during/as <meal>" — because the
 * algorithm below assigns the text BEFORE a boundary to that boundary's label. Pre-positioned
 * phrasing ("this morning I had a banana") puts the food AFTER the label and needs the opposite
 * assignment; mixing both in one message is a separate open defect.
 *
 * Exported so it can be asserted — segmentation had no direct regression coverage at all.
 */
/** Explicit "this is TODAY" markers — an event saying so overrides a message-level retro date. */
export const SAYS_TODAY_RE = /\b(today|this morning|this afternoon|this evening|tonight|just now|right now)\b/i;

export const MEAL_BOUNDARY_RE = /\b(?:for|in|at|during|as)\s+(?:a\s+|my\s+|the\s+)?(breakfast|lunch|dinner|supper|snack|brunch|morning|afternoon|evening)\b/gi;

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

// PERSISTED, not in-memory (2026-07-28 live: the 30-day card fired at 13:34 AND 21:25 because a redeploy wiped the Map). Keyed by streak number, so 30 today and 31 tomorrow are different moments.
async function getStreakNote(userId: string, streak: number, name: string): Promise<string> {
  const note = getFoodStreakCelebration(streak, name);
  if (!note) return "";
  return (await claimOncePerDay(userId, `streak_${streak}`)) ? note : "";
}


type HandleMessageFn = (phone: string, message: string, mediaUrl?: string, mediaContentType?: string, allMediaUrls?: string[]) => Promise<string>;

// Quantity/portion scaling — shared by the scanner, smart-log and multi-day paths.
function normaliseWordNumbers(text: string): string {
  const map: Record<string, string> = {
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    "half": "0.5", "a": "1", "an": "1",
  };
  // Phrase pass FIRST: "half a vienna" must become "0.5 vienna", not "0.5 1 vienna" —
  // the a→1 word map was eating the half and logging a whole item (2026-07-23).
  const phrased = text.replace(/\bhalf\s+(?:a|an|the)\s+/gi, "0.5 ");
  return phrased.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|half|a|an)\b/gi, w => map[w.toLowerCase()] ?? w);
}

export function adjustFoodsForSegment(foods: SAFood[], segText: string, personal?: Map<string, PortionStat>) {
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
    let explicitQty = false; // the client SAID an amount — memory never overrides speech
    let quantityEstimated = false; // WE interpreted the amount — identity can be db, quantity a guess
    for (const alias of allAliases) {
      const qtyDirect = normText.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+(?:${escapeRegex(alias)})`, "i"));
      // UNIT-AWARE (2026-08-13): capture the unit WORD and classify it — "2 plates", "2 tablespoons",
      // "2 pieces" and "2 spoons" are four different claims, and the old catch-all made all four N
      // whole portions, so "2 spoons of pap" logged 660 kcal. See portion-memory.classifyPortionUnit.
      const qtyWithUnit = qtyDirect ? null : normText.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+([a-z]+)\\s+(?:of\\s+)?(?:${escapeRegex(alias)})`, "i"));
      const qtyBefore = qtyDirect || qtyWithUnit;
      if (qtyBefore) {
        explicitQty = true;
        const userQty = parseFloat(qtyBefore[1]);
        const unit = qtyWithUnit ? classifyPortionUnit(qtyWithUnit[2], f.typicalPortionDescription, f.typicalPortionGrams) : null;
        if (unit && unit.fraction !== null) {
          quantity = unit.cls === "unknown" ? 1 : userQty * unit.fraction;  // never N portions
          if (unit.estimated) quantityEstimated = true;
        } else {
          const defaultQty = portionDefaultCount(f.typicalPortionDescription);
          if (userQty > 0 && defaultQty > 0 && userQty !== defaultQty) quantity = userQty / defaultQty;
        }
        break;
      }
    }
    // VAGUE PER-FOOD AMOUNT (2026-07-23 live: "half a Vienna" logged the 2-vienna default and
    // the client argued the log DOWN — trust killer). "Half a <food>" = 0.5 of ONE item vs the
    // portion's default count; "some/a few/a bit of <food>" = half the default. Lean LOW.
    // Skipped when a global size phrase already scaled the segment (no double-halving).
    let vagueQty = false;
    if (!explicitQty && sizeMultiplier === 1) {
      for (const alias of allAliases) {
        const a = escapeRegex(alias);
        // Match on the RAW text: normalisation rewrites "a"→"1", destroying "a bit of".
        const halfM = segText.match(new RegExp(`\\bhalf\\s+(?:a\\s+|an\\s+|the\\s+|of\\s+(?:a\\s+|the\\s+)?)?(?:${a})`, "i"));
        const vagueM = !halfM && segText.match(new RegExp(`\\b(?:some|a few|a couple(?:\\s+of)?|a bit of|a little(?:\\s+bit)?(?:\\s+of)?|a small piece of|a taste of)\\s+(?:${a})`, "i"));
        if (halfM) {
          quantity = 0.5 / Math.max(1, portionDefaultCount(f.typicalPortionDescription));
          vagueQty = true;
        } else if (vagueM) {
          quantity = 0.5;
          vagueQty = true;
        }
        if (vagueQty) break;
      }
    }
    quantity = quantity * sizeMultiplier;
    // ADAPTIVE PORTION (2026-07-17): when the client stated NO amount and NO size word,
    // their own median portion of this food (portion-memory, >=3 logs, clamped) beats
    // the table default. Memory fills silence; it never overrides what they said —
    // and a vague amount ("some", "half a") IS speech, so memory stays out of its way.
    if (!explicitQty && !vagueQty && sizeMultiplier === 1 && personal) {
      const pp = personalPortionFor(personal, f.name, f.typicalPortionCalories, f.typicalPortionProtein);
      if (pp.personal) {
        return {
          ...f,
          adjustedCalories: pp.kcal,
          adjustedProtein: pp.protein,
          adjustedDescription: `${f.typicalPortionDescription} — your usual`,
          quantity: 1,
          portionSource: "personal" as const,
        };
      }
    }
    // PORTION PROVENANCE (2026-07-19): every inferred portion carries HOW it was decided —
    // the audit-trail atom the reviews keep asking for, and the signal the confidence layer
    // reads. "default" = a bare guess (no amount, no size word, no history) — the only case
    // that's genuinely uncertain.
    const portionSource = explicitQty ? "explicit" as const : vagueQty ? "vague" as const : sizeMultiplier !== 1 ? "size" as const : "default" as const;
    return {
      ...f,
      adjustedCalories: Math.round(f.typicalPortionCalories * quantity),
      adjustedProtein: Math.round(f.typicalPortionProtein * quantity),
      adjustedDescription: scalePortionDescription(f.typicalPortionDescription, quantity),
      quantity,
      portionSource,
      // Identity verified, quantity estimated — "2 spoons of pap" is db-true about pap, a guess about how much.
      origin: quantityEstimated ? "ai" as const : undefined,
    };
  });
}

export async function handleFoodContext(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
  stepReplyPart: string;
  handleMessage: HandleMessageFn;
  /** Classifier verdict (QUESTION, conf >= 0.8) — authoritative over keyword heuristics.
   *  The food logger is the last + biggest side-effect handler; without this a voice
   *  question mentioning food ("what do you think about rice and sweet potato?") gets
   *  logged as a 588-kcal meal because "having" trips hasLogTrigger (prod, 2026-07-03). */
  classifierQuestion?: boolean;
  /** EXECUTOR resolved an explicit LOG_MEAL: skip advisory branches (2026-07-27: the ordering guide answered a log 3x). */
  forceLog?: boolean;
}): Promise<string | null> {
  const { phone, message, m, user, stepReplyPart, handleMessage } = ctx;
  const classifierQuestion = !!ctx.classifierQuestion;
  const forceLog = !!ctx.forceLog;

  // ---- SUPPORT BEFORE LOGGING (2026-07-14) — a deep emotional share ("I ate a whole
  // cake, I've tried everything, I want to quit") must reach emotional support, NOT get
  // its cake silently counted. Skip the food logger entirely and let it flow to the
  // mindset/deep-support path. The person needs to be heard first; they can log later. ----
  if (looksLikeDeepEmotionalShare(message)) return null;

  // PENDING REFERENT — "log it" / "had 3 handfuls of it" after a verdict resolves against
  // the parked food (referent-log.ts), BEFORE the scanner can dead-end (2026-07-23 live).
  if (!classifierQuestion) {
    const { tryLogReferent } = await import("./referent-log");
    const refDone = await tryLogReferent({ phone, message, user });
    if (refDone) return refDone;
  }

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
  // RE-IDENTIFICATION corrections: the client fixing a MIS-READ food, phrased "it's X / it is
  // not X / that's actually Y" (2026-07-22 live: "It is not vetkoek" was domain-redirected and
  // "It is stew wors" logged as a NEW snack instead of fixing the last meal — client fighting it).
  const ID_CORRECTION_PREFIX = /^(it'?s|it is|that'?s|that is|it was|this is|its)\s+/i;
  const hasCorrectionPrefix = CORRECTION_PREFIX.test(m) || ID_CORRECTION_PREFIX.test(m);
  const correctedMsgCandidate = m.replace(CORRECTION_PREFIX, "").replace(ID_CORRECTION_PREFIX, "").trim();
  // Food detection uses the candidate with "not X" STRIPPED, so "it is not vetkoek" doesn't
  // look like a request to log vetkoek. A pure negation (no replacement food) must NOT re-log —
  // it routes to the "what was it?" ask below.
  const candidateSansNot = correctedMsgCandidate.replace(/\bnot\s+[\w'-]+/gi, " ").replace(/\s+/g, " ").trim();
  const idNegationOnly = ID_CORRECTION_PREFIX.test(m) && /\bnot\b/i.test(m) && scanForSAFoods(candidateSansNot).length === 0;
  const hasFoodTriggerAfterPrefix = /\b(had|ate|eaten|eating|breakfast|lunch|dinner|supper|meal|it was|was a|i had|i said|the above|mentioned|i'll have|i will have)\b/i.test(m);
  const hasFoodAfterPrefix = hasCorrectionPrefix && !idNegationOnly && candidateSansNot.length > 2 && scanForSAFoods(candidateSansNot).length > 0;
  const isFoodCorrection = hasCorrectionPrefix && !idNegationOnly && (hasFoodTriggerAfterPrefix || hasFoodAfterPrefix);

  const isReferenceCorrection = /\b(go with|goes with|part of|was correcting|was part|belongs to|same meal|together with|included in|go together|read it again|read that again|i was correcting|that.?s the same|the above mentioned|above mentioned|i said i had|i said for lunch|i said for dinner|i said for breakfast)\b/i.test(m);

  if (isFoodCorrection || isReferenceCorrection) {
    captureFriction("correction", { userId: user.id, phone, messageIn: message, detail: "food re-identification / correction" });
    if (isReferenceCorrection && !hasCorrectionPrefix) {
      const gptRef = await withTimeout("gpt_food_ref", 20000, () => askCoachK(message, user, "The user is referencing or correcting a previous food log. Use chat history to understand what they mean and respond helpfully. Do NOT log new food."));
      await logChat(user.id, message, gptRef, "FOOD_CORRECTION_REF");
      return gptRef;
    } else {
      const todayStartCorr = sastDayStart();
      // Label-only correction ("that was lunch not breakfast") names a meal slot but no food.
      // RELABEL the meal instead of deleting it, so the logged calories survive. Strip "not X"
      // first so "lunch not breakfast" affirms lunch, not breakfast.
      const correctedHasFood = correctedMsgCandidate.length > 2 && scanForSAFoods(correctedMsgCandidate).length > 0;
      const relabelMatch = !correctedHasFood
        ? correctedMsgCandidate.replace(/\bnot\s+\w+/gi, " ").match(/\b(breakfast|lunch|dinner|supper|snack)\b/i)
        : null;
      const relabelTo = relabelMatch ? relabelMatch[1].toLowerCase() : null;
      let relabelDone = false;
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
        // Wrap relabel/delete + recount + cache update in a transaction — all or nothing.
        await db.transaction(async (tx) => {
          if (relabelTo && lastMealLogCorr) {
            // Relabel only — calories unchanged, so no recompute needed.
            await tx.update(mealLogs).set({ mealLabel: relabelTo, corrected: true }).where(eq(mealLogs.id, lastMealLogCorr.id));
            relabelDone = true;
          } else {
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
          }
        });
      } catch (e) { console.warn("[food-correction-tx]", e); }
      if (relabelDone) {
        await logChat(user.id, message, `Moved that to ${relabelTo}`, "FOOD_RELABEL");
        return `Moved that to *${relabelTo}* ✅`;
      }
      if (correctedMsgCandidate && correctedMsgCandidate.length > 2 && correctedMsgCandidate !== m) {
        // Strip "not <word>" so a corrected re-log doesn't re-add the negated item:
        // "chicken not beef" logs chicken only, never chicken AND beef.
        const cleaned = correctedMsgCandidate.replace(/\bnot\s+\w+/gi, " ").replace(/\s+/g, " ").trim();
        return await handleMessage(phone, cleaned.length > 2 ? cleaned : correctedMsgCandidate);
      }
    }
  }

  // ---- FOOD LOG REJECTION — "no", "no no no", "wrong" immediately after a food log ----
  // Catches cases where the bot misidentified the food and the user is pushing back
  const isSimpleRejection = /^(no[\s!.?]*)+$/i.test(m) || /^(wrong|incorrect|not right|that.?s wrong|not that)[.!?]*$/i.test(m) || idNegationOnly;
  if (isSimpleRejection) {
    try {
      const lastEntry = await db.select({ intent: chatHistory.intent, messageOut: chatHistory.messageOut })
        .from(chatHistory)
        .where(eq(chatHistory.userId, user.id))
        .orderBy(desc(chatHistory.createdAt))
        .limit(1);
      if (lastEntry[0]?.intent === "FOOD_LOG" || lastEntry[0]?.intent === "SHORT_REPLY") {
        captureFriction("rejection", { userId: user.id, phone, messageIn: message, detail: "rejected a food log" });
        const reply = `What was it actually? Just tell me (e.g. "Monster Zero Sugar") and I'll fix the log.`;
        await logChat(user.id, message, reply, "FOOD_CORRECTION_PROMPT");
        return reply;
      }
      // Not a food correction — give a deterministic reply instead of falling through to GPT
      const confusedReply = `Not sure I caught that — tell me what you ate, what you trained, or what you need help with and I'll sort it.`;
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
      const recentChats = await db.select({ messageIn: chatHistory.messageIn, messageOut: chatHistory.messageOut, intent: chatHistory.intent })
        .from(chatHistory)
        .where(eq(chatHistory.userId, user.id))
        .orderBy(desc(chatHistory.createdAt))
        .limit(3);
      // "log it" after a photo VERDICT ("can I eat this?") — the photo was deliberately
      // NOT logged (client was deciding). Recover the numbers from the verdict's TOTAL line.
      const verdictRow = recentChats.find(c => c.intent === "FOOD_VERDICT" && c.messageOut);
      if (verdictRow) {
        const vt = (verdictRow.messageOut || "").match(/TOTAL:\s*(\d[\d,]*)\s*kcal\s*\|\s*(\d{1,3})\s*g\s*protein/i);
        if (vt) {
          const vKcal = parseInt(vt[1].replace(/,/g, ""), 10);
          const vProt = parseInt(vt[2], 10);
          // Through the one write door — macros guaranteed, day recomputed.
          const cv = await commitFoodLog({
            userId: user.id, phone, rawMessage: "[Photo — checked first, then eaten]", source: "photo",
            kcalInt: vKcal, proteinInt: vProt, carbsInt: 0, fatInt: 0, items: [],
            mealLabel: extractMealLabel(message, undefined, { kcal: vKcal, protein: vProt }, user, await getSlotContext(user.id)),
            loggedAt: new Date(),
          });
          const vReply = `Logged ✅ ~${vKcal} kcal | ${vProt}g protein.\n\n_Today: ${cv.runningCals} kcal | ${cv.runningProtein}g protein_`;
          await logChat(user.id, message, vReply, "FOOD_LOG");
          return vReply;
        }
      }
      const lastUnloggedFood = recentChats.find(c => c.intent !== "FOOD_LOG" && c.messageIn);
      if (lastUnloggedFood) {
        const foodsInLastMsg = scanForSAFoods(lastUnloggedFood.messageIn || "");
        if (foodsInLastMsg.length > 0) {
          // Quantity-aware ("3 eggs" = 3 eggs, "big plate" = 1.5×) — the main scanner
          // path always scaled portions; this smart-log path summed raw typicals.
          const adjSmart = adjustFoodsForSegment(foodsInLastMsg, lastUnloggedFood.messageIn || "", await getPortionMemory(user.id));
          let totalCals = 0; let totalProt2 = 0;
          const parts: string[] = [];
          for (const food of adjSmart) {
            totalCals += food.adjustedCalories || 0;
            totalProt2 += food.adjustedProtein || 0;
            parts.push(`${food.name} — ${food.adjustedCalories} kcal | ${food.adjustedProtein}g protein`);
          }
          await logChat(user.id, lastUnloggedFood.messageIn || "", parts.join("\n"), "FOOD_LOG");
          // Through the one write door — macros guaranteed, day recomputed.
          const cs = await commitFoodLog({
            userId: user.id, phone, rawMessage: lastUnloggedFood.messageIn || "", source: "text",
            kcalInt: totalCals, proteinInt: totalProt2, carbsInt: 0, fatInt: 0, items: [],
            mealLabel: extractMealLabel(lastUnloggedFood.messageIn || "", undefined, { kcal: totalCals, protein: totalProt2 }, user, await getSlotContext(user.id)),
            loggedAt: new Date(),
          });
          return `Logged! ✅\n${parts.join("\n")}\n\n_Today: ${cs.runningCals} kcal | ${cs.runningProtein}g protein_`;
        }
      }
    } catch { /* non-fatal */ }

    const summaryTotals = await recomputeTodayFoodTotals(user.id);
    const name = spaceName(user);
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
  const isQuestion = classifierQuestion || m.includes("?") ||
    /^(what|should|can i|is |are |how|why|when|tell me about|which|do i|does |do |where|can )/.test(m) ||
    /\b(from where|where can|where do|where to|how much|how many|is it|is that|are they|are those|should i|can i|do i|does it|what is|what are|which one|good for|bad for|healthy|unhealthy|worth it|better than|worse than|is that enough|enough protein|enough calories|is it enough|any good|any protein)\b/.test(m);
  const hasFrustrationWords = /\b(no no|that.?s not|not true|not right|wrong|incorrect|read everything|come on|what the hell|terrible|rubbish|nonsense|adjust it|fix it|change it|update it|that.?s wrong|bull|crap|ridiculous|do a better|better job|what\??!*$|huh\??|excuse me|are you sure|doesn.?t look right|not correct|try again|redo|recalculate)\b/i.test(m);
  const isFrustration = hasFrustrationWords && !/\b(i had|i ate|i said|had|ate|having|eating|the above|for lunch|for dinner|for breakfast|for supper|go with|goes with|part of|same meal|i was correcting)\b/i.test(m);
  // Explicit eating forms only: "have" is possession/questions, "add" is "add to cart", future
  // tense is planning. A MEAL WORD IS NOT AN ASSERTION EITHER (2026-07-29) — bare breakfast|lunch|
  // dinner|snack was here, so "dinner" in ANY context meant "log this": the alternative that made
  // this logger OPT-OUT. The paired forms ("for dinner", "dinner was") were already listed.
  const hasLogTrigger = /\b(ate|had|having|eating|for breakfast|for lunch|for dinner|for supper|for snack|for brunch|breakfast was|lunch was|dinner was|supper was|just had|just ate|meal was|meal is|food was|i ate|i had|i've had|ive had|pre.?workout|pre workout|post.?workout|post workout|before.*gym|after.*gym|before.*training|after.*training|added|put in|putting in)\b/.test(m);

  // Future / planning / shopping intent — describes intended eating or shopping, NOT food consumed today.
  // Blocks directFoodScan and the main food scanner from firing on these messages.
  const isFuturePlanning = /\b(i.?ll\s+have|i\s+will\s+have|gonna\s+have|going\s+to\s+have|need\s+to\s+buy|need\s+to\s+get|want\s+to\s+buy|going\s+to\s+(?:buy|get|pick\s+up)|planning\s+to\s+(?:eat|have|cook)|want\s+to\s+(?:eat|have|try|order)|thinking\s+of\s+(?:eating|having|cooking)|will\s+be\s+(?:eating|having)|still\s+to\s+(?:have|eat|grab|get|make|cook)|yet\s+to\s+(?:have|eat|grab|get)|haven.?t\s+(?:had|eaten|eat)|about\s+to\s+(?:have|eat|grab|make|cook|order)|still\s+(?:need|got|have)\s+to\s+(?:eat|have|grab))\b/i.test(m);

  // Meal-idea REQUESTS ("what should I eat for dinner") are asking, not reporting — defer to the coach (2026-07-21).
  const isMealSuggestionRequest =
    /\b(give me|send me|suggest|recommend|any (ideas?|options?)|(ideas?|options?) for|help me (plan|with)|what (should|can|do|must) i (eat|have|make|cook)|what to (eat|have|make|cook)|meal (suggestions?|ideas?|options?|plan)|plan my meals?|what (should|can) i (have|make|cook) for)\b/i.test(m)
    && !/\b(i had|i ate|i just (had|ate)|just had|just ate|i'?ve (had|eaten)|having (a|some|my))\b/i.test(m);

  // ---- "ATE IT" — closes the FOOD_PLANNED loop. Tolerates interjections/padding ("Omg I
  // just had it") but stays anchored on (ate|had|eaten|finished)+(it|that) so real food logs
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
  // PAST-TENSE consumption = LOG IT, don't lecture (prod 2026-07-03: ordering advice
  // silently dropped ~800 kcal). The guide is only for PLANNING/asking.
  const atePastTakeaway = /\b(i had|i ate|i.?ve had|i just (had|ate)|just had|just ate|had \d+|ate \d+|my (lunch|dinner|breakfast|supper|meal) (is|was)|for (lunch|dinner|breakfast|supper) i had|ordered and ate|already (had|ate))\b/i.test(m);
  if (!forceLog && eatingOutPlace && hasEatingIntent && !isQuestion && !isFrustration && !atePastTakeaway) {
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

  // ---- RETRO-LOG GUIDANCE — repeat/same-as is owned by meal-repeat.ts (earlier in pipeline).
  // "log yesterday's food" WITHOUT same/repeat/again = retroactive capture, must fall through
  // (a voice note asking to log yesterday was being relogged as today's pasta).
  const wantsRepeat = /\b(same|repeat|again)\b/i.test(m);
  const isRetroLogRequest = !wantsRepeat
    && /\b(log|logging|record|add|enter|capture|track|update|forgot|missed|didn.?t)\b/i.test(m)
    && /\byesterday\b/i.test(m);

  // Bare retroactive-log request with no food named yet — guide them to send yesterday's
  // meals with a "yesterday" prefix so the meal parser dates them to yesterday, not today.
  if (isRetroLogRequest && scanForSAFoods(message).length === 0) {
    const nm = user.name ? `${user.name.split(" ")[0]}, ` : "";
    // SHORTENED 2026-08-04 (Slice 4). This used to hand over a worked template — "Send it
    // starting with *yesterday*, e.g. …" — with a two-meal example and a closing clause. Three
    // sentences teaching a client the syntax of a product that is supposed to understand them,
    // and the retro token now carries the day across the turn anyway, so the instruction was
    // not even true any more. They can just answer.
    return `${nm}go ahead — what did you eat yesterday?`;
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
    // Run-on / voice-note meals over 12 words used to be silently dropped. Allow up to 22 words
    // when there's strong evidence (3+ distinct exact foods — an incidental mention rarely lists
    // three), keeping the tight 12-word bound for the 2-food / 1-food+quantity case.
    && (m.split(/\s+/).length <= 12 || (m.split(/\s+/).length <= 22 && exactFoodCount >= 3))
    && exactFoodCount >= 1
    && (exactFoodCount >= 2 || hasQuantityWord);
  // foodLogOverride bypasses the isQuestion guard ONLY for a past-eating statement with a
  // trivial trailing "?" ("I had eggs?") — never for a real question, which would be discarded.
  const hasSubstantiveQuestion = classifierQuestion
    || /\b(is that enough|how much|how many|is it (ok|good|healthy|bad|enough|too much)|good for|bad for|enough protein|enough calories|too (many|much)|any good|is this (ok|good|healthy|bad|enough)|is (that|this) (bad|good|ok|healthy)|have protein|contain protein|much protein|has protein)\b/i.test(m)
    // Opinion / advice questions that MENTION food but aren't logging it.
    || /\b(what do you think|what.?s your (take|opinion|view)|thoughts on|your opinion|opinion on|is it (advisable|worth|better|okay|fine)|do you (recommend|think|reckon)|would you (recommend|say)|what about (having|eating|adding)|better to (have|eat)|is it bad to)\b/i.test(m)
    || /^(is |does |do |will |can |should |are |have |has |what |why |which )\b/i.test(m)
    // WO2 fix 3: an ask stands this path down UNLESS the meal was dated in the PAST (J4 dates it, J3's "KFC tonight?" does not). Both sides asserted in acceptance-hold.ts.
    || (isAskingNotReporting(m) && !isRetroactiveMeal(m));
  const foodLogOverride = hasLogTrigger && hasActualFood && !hasSubstantiveQuestion && !classifierQuestion;
  // Diagnostic: when a meal silently fails to log in production, this line names the reason instantly.
  if (hasActualFood) {
    console.log(`[FOOD_GATE] user=...${String(user.id || "").slice(-6)} foods=[${foodsInMsg.map(f => f.name).join("|")}] q=${isQuestion} frus=${isFrustration} emo=${isEmotionalOnly} future=${isFuturePlanning} trig=${hasLogTrigger} direct=${directFoodScan} override=${foodLogOverride} words=${m.split(/\s+/).length}`);
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

  // ---- SHOPPING LIST / PANTRY DETECTION — a dash-list of staples is NOT a meal.
  // 3+ dash items + shopping language, or 7+ dash items alone → block. Split on the ORIGINAL
  // `message` (`m` collapses whitespace).
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

  // ---- PLANNED MEAL — future EATING tense ("gonna have X for lunch"). Say plainly it is
  // NOT logged + give a one-word path to log it once eaten (else the client believes it was
  // logged and "same as lunch" later copies a stale meal). Shopping intents fall through.
  const isFutureEating = /\b(i.?ll\s+have|i\s+will\s+have|gonna\s+have|going\s+to\s+have|planning\s+to\s+(?:eat|have|cook)|thinking\s+of\s+(?:eating|having|cooking)|will\s+be\s+(?:eating|having)|still\s+to\s+(?:have|eat|grab|get|make|cook)|yet\s+to\s+(?:have|eat|grab|get)|haven.?t\s+(?:had|eaten|eat)|about\s+to\s+(?:have|eat|grab|make|cook|order)|still\s+(?:need|got|have)\s+to\s+(?:eat|have|grab))\b/i.test(m);
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
  // Fires when a client logs food for 2+ days in one message ("chicken Wednesday, oats
  // Thursday, pap Friday dinner"). Without it parseMealDate picks the first day and all foods
  // land on the wrong date; here each day gets its own DB entry at the correct loggedAt.
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
      // Quantity-aware, same as the main scanner path — "3 eggs and pap on Wednesday"
      // logged a single egg portion before this.
      const adjMulti = adjustFoodsForSegment(segFoods, seg.text, await getPortionMemory(user.id));
      let segKcal = 0, segProt = 0;
      for (const f of adjMulti) { segKcal += f.adjustedCalories || 0; segProt += f.adjustedProtein || 0; }
      multiPlan.push({ label: mealDateLabel(segDate), foods: adjMulti, kcal: segKcal, prot: segProt, date: segDate, raw: seg.day + ": " + seg.text });
    }

    if (multiPlan.length >= 2) {
      const slotCtxMulti = await getSlotContext(user.id);
      // Through the one write door — one per day, sequential so today's recompute doesn't race.
      let recomp = { calories: 0, protein: 0 };
      for (const p of multiPlan) {
        const c = await commitFoodLog({
          userId: user.id, phone, rawMessage: p.raw, source: "text",
          kcalInt: p.kcal, proteinInt: p.prot, carbsInt: 0, fatInt: 0, items: [],
          mealLabel: extractMealLabel(p.raw, p.date, { kcal: p.kcal, protein: p.prot }, user, slotCtxMulti),
          loggedAt: p.date,
        });
        recomp = { calories: c.runningCals, protein: c.runningProtein };
      }
      const logSummary = multiPlan.map(p => `${p.label}: ${p.foods.map(f => f.name).join(", ")} (${p.kcal} kcal)`).join("\n");
      await logChat(user.id, message, logSummary, "FOOD_LOG");
      const lines = multiPlan.map(p => {
        const cap = p.label.charAt(0).toUpperCase() + p.label.slice(1);
        return `*${cap}:* ${p.foods.map(f => f.name).join(", ")} — ${p.kcal} kcal | ${p.prot}g protein`;
      });
      const todayNote = recomp.calories > 0 ? `\n\n_Today's running total: ${recomp.calories} kcal | ${recomp.protein}g protein._` : "";
      return `Logged ${multiPlan.length} days. ✅\n\n${lines.join("\n")}${todayNote}`;
    }
    // Fewer than 2 days had recognised food — fall through to single-day scanner
  }
  // forceLog is the verb the engine stripped: LOG_MEAL passes the EXTRACTED foodText, so "I had rice and chicken for lunch"
  // arrives as "rice and chicken" — no trigger, too few foods for directFoodScan, nothing written, and the correction that
  // followed had no row to correct. It joins the TRIGGER conjunct only, so a question still never logs. acceptance-hold §8.
  if ((!isQuestion || foodLogOverride || forceLog) && !isFrustration && !isEmotionalOnly && !isFuturePlanning && (hasActualFood || forceLog) && (hasLogTrigger || directFoodScan || forceLog)) {
    console.log(`[FOOD_SCAN] gate fired — user=...${String(user.id || "").slice(-6)} foods=${foodsInMsg.length} trigger=${hasLogTrigger} direct=${directFoodScan}`);
    const MEAL_KEYWORDS = ["breakfast", "lunch", "dinner", "supper", "snack", "brunch", "morning", "afternoon", "evening"];
    const mealSegments: { label: string; text: string }[] = [];

    // Allow "for a snack", "for my dinner", "for the lunch" etc. — articles are non-capturing.
    const forMealMatches = [...m.matchAll(new RegExp(MEAL_BOUNDARY_RE.source, "gi"))];

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

    type AdjFood = SAFood & { adjustedCalories: number; adjustedProtein: number; adjustedDescription: string; quantity: number;
      /** `db` for scanner matches, `ai` for the GPT supplement — merging loses it otherwise. */
      origin?: "db" | "ai" };
    const allAdjustedFoods: AdjFood[] = [];
    const isMultiMeal = mealSegments.length >= 2;
    // Per-segment buckets — so a multi-meal log attributes each food (including
    // GPT-supplemented items) to the correct meal in the breakdown, not just the total.
    const segmentBuckets: { label: string; text: string; foods: AdjFood[] }[] = [];

    // PLANNED-SEGMENT GUARD (2026-07-22 day-dump): in "lunch was X... dinner is going to be
    // Y", the lunch was eaten and the dinner is a PLAN. Capture planned segments, never log
    // them as eaten, and surface them as "not logged yet — reply 'ate it'".
    const FUTURE_SEG_RE = /\b(going to be|gonna be|will be|is going to|are going to|i'?ll have|i will have|gonna have|going to have|planning to (?:eat|have|cook|make)|plan(?:ning)? to have|still to (?:have|eat|make|cook|come)|yet to (?:have|eat|make|cook)|about to (?:have|eat|make|cook)|for (?:tonight|later)|(?:will|going to) (?:eat|make|cook)|haven'?t (?:had|eaten) (?:yet|dinner|lunch|supper|breakfast))\b/i;
    const plannedSegs: string[] = [];

    for (const seg of mealSegments) {
      const segFoods = scanForSAFoods(seg.text);
      const adjusted = segFoods.length > 0 ? adjustFoodsForSegment(segFoods, seg.text, await getPortionMemory(user.id)) : [];
      // A future/planned meal inside a multi-meal dump is captured, not counted. (Single
      // non-multi segments keep the old behaviour so a plain "dinner chicken and rice"
      // still logs — only fire the guard when the segment actually reads as future.)
      if (adjusted.length > 0 && FUTURE_SEG_RE.test(seg.text)) {
        const nm = adjusted.map(f => f.name).join(", ");
        plannedSegs.push(`${seg.label || "Later"}: ${nm}`);
        segmentBuckets.push({ label: seg.label, text: seg.text, foods: [] });
        continue;
      }
      segmentBuckets.push({ label: seg.label, text: seg.text, foods: adjusted });
      allAdjustedFoods.push(...adjusted);
    }

    // ---- PARTIAL MATCH SUPPLEMENT — catch items the SA scanner missed; attributed back to
    // the segment whose text mentions them.
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
              origin: "ai",  // was merged into an array committed as `sa_scanner` — inference recorded as verified
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

    // Build the multi-meal breakdown AFTER supplement attribution (so GPT items are included).
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
      // JUNK-DOMINANT: judge the MEAL, not one item — when junk is the majority of the calories
      // it's a treat, whatever else is on the plate. 0.6 spares "viennas + eggs" (~52%).
      const mealJunkCals = junkFoods.reduce((s, f) => s + (f.adjustedCalories || 0), 0);
      const junkDominant = totalCals > 0 && mealJunkCals / totalCals >= 0.6;

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
      if (junkFoods.length > 0 && (goodProteins.length === 0 || junkDominant)) {
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
      // Carbs/fat per food: LOWER of the dry estimate (per-100g x grams — overcounts
      // cooked staples) and the ratio estimate (energy share — overcounts alcohol).
      // The error modes never hit the same food, so min() is right for both.
      const macroEnergy = (f: any) => 4 * (f.proteinPer100g || 0) + 4 * (f.carbsPer100g || 0) + 9 * (f.fatPer100g || 0);
      // Per-food carbs/fat, ONE owner: the whole-message total and each event's total must not be
      // able to disagree about the same food.
      const carbsFatOf = (foods: any[]) => {
        const one = (f: any, per100: number, kcalPerG: number) => {
          const grams = (f.typicalPortionGrams || 100) * (f.quantity || 1);
          const dry = grams * (per100 || 0) / 100;
          const e = macroEnergy(f);
          const ratio = e > 0 ? (f.adjustedCalories || 0) * (kcalPerG * (per100 || 0) / e) / kcalPerG : dry;
          return Math.min(dry, ratio);
        };
        return {
          carbs: Math.round(foods.reduce((s, f) => s + one(f, f.carbsPer100g, 4), 0)),
          fat: Math.round(foods.reduce((s, f) => s + one(f, f.fatPer100g, 9), 0)),
        };
      };
      const { carbs: totalCarbs, fat: totalFat } = carbsFatOf(allAdjustedFoods);
      const firstSegLabel = mealSegments.find(s => s.label)?.label
        || extractMealLabel(message, undefined, { kcal: totalCals, protein: Math.round(totalProtein) }, user, await getSlotContext(user.id));
      const scannerItems = allAdjustedFoods.map(f => ({
        name: f.name,
        grams: Math.round((f.typicalPortionGrams || 100) * (f.quantity || 1)),
        kcal: f.adjustedCalories,
        protein: f.adjustedProtein,
        category: f.category,
        origin: f.origin || "db",
      }));
      // ── ONE ROW PER EATING EVENT (2026-08-17, migration 0004) ───────────────────────────────
      // "eggs in the morning, pap at lunch" is TWO events, stored as one row with one date and one
      // label. Each event now gets its own row, date and label, linked by sourceMessageId so the
      // utterance stays undoable as one thing. Single-event messages are untouched — one row, as
      // before, and that is the common case. rawMessage carries the EVENT's words: commitFoodLog
      // dedups on it, so four rows sharing the full text would drop three as duplicates.
      const eventGroupId = randomUUID();
      const eventBuckets = segmentBuckets.filter(b => b.foods.length > 0);
      const splitIntoEvents = eventBuckets.length >= 2;
      let committed!: Awaited<ReturnType<typeof commitFoodLog>>;
      if (splitIntoEvents) {
        const slotCtx = await getSlotContext(user.id);
        for (const bucket of eventBuckets) {
          const kcal = bucket.foods.reduce((t, f: any) => t + (f.adjustedCalories || 0), 0);
          const prot = Math.round(bucket.foods.reduce((t, f: any) => t + (f.adjustedProtein || 0), 0));
          const { carbs, fat } = carbsFatOf(bucket.foods);
          // The event's OWN date — its text wins when it names one, else it inherits the message's.
          const ownDate = isRetroactiveMeal(bucket.text) || SAYS_TODAY_RE.test(bucket.text)
            ? parseMealDate(bucket.text)
            : scannerLoggedAt;
          committed = await commitFoodLog({
            userId: user.id, phone,
            rawMessage: bucket.text.slice(0, 1000),
            source: "sa_scanner",
            kcalInt: kcal, proteinInt: prot, carbsInt: carbs, fatInt: fat,
            items: bucket.foods.map((f: any) => ({
              name: f.name,
              grams: Math.round((f.typicalPortionGrams || 100) * (f.quantity || 1)),
              kcal: f.adjustedCalories, protein: f.adjustedProtein,
              category: f.category, origin: f.origin || "db",
            })),
            mealLabel: bucket.label
              || extractMealLabel(bucket.text, ownDate, { kcal, protein: prot }, user, slotCtx),
            loggedAt: ownDate,
            sourceMessageId: eventGroupId,
          });
          if (!committed.ok) break;
        }
        console.log(`[MEAL_EVENTS] ${eventBuckets.length} events from one message — group ${eventGroupId.slice(0, 8)}`);
      } else {
        committed = await commitFoodLog({
          userId: user.id,
          phone,
          rawMessage: message.slice(0, 1000),
          source: "sa_scanner",  // retro is TIMING (loggedAt), never the origin
          kcalInt: totalCals,
          proteinInt: Math.round(totalProtein),
          carbsInt: totalCarbs,
          fatInt: totalFat,
          items: scannerItems,
          mealLabel: firstSegLabel,
          loggedAt: scannerLoggedAt,
          sourceMessageId: eventGroupId,
        });
      }
      if (!committed.ok) {
        const failReply = `Eish — I worked out that meal (~${totalCals} kcal | ${Math.round(totalProtein)}g protein) but couldn't save it just now. Send it again in a moment and I'll log it.`;
        await logChat(user.id, message, failReply, "FOOD_LOG_FAILED");
        return failReply;
      }
      const { prevCals, runningCals, runningProtein } = committed;

      const reply = await buildFoodLogReply({
        foodLines, mealLabel, totalMealCals: totalCals, totalMealProtein: totalProtein,
        cardComing: cardWillAttach(user, totalCals, !!cardBaseUrl()),
        runningCals, runningProtein, calorieTarget, proteinTarget, prevCals,
        junkNoteText, hasGoodProteins: goodProteins.length > 0, junkDominant,
        hasCarbs: allAdjustedFoods.some(f => f.category === "carb"),
        coachNoteOverride: denseFoodCoachNote,
        user, todaySteps: todayStepCount, userMessage: message,
        isRetro: scannerIsRetro,
      });

      const scannerRetroNote = scannerIsRetro ? `\n_Logged to ${mealDateLabel(scannerLoggedAt)}._` : "";
      await logChat(user.id, message, reply, "FOOD_LOG");
      const [saPattern, saDay, foodStreak] = await Promise.all([
        checkFoodPatterns(user.id),
        checkPerfectDay(user.id, user.proteinTarget || 120),
        computeFoodLogStreak(user.id),
      ]);
      const streakCelebration = await getStreakNote(user.id, foodStreak, user.name || "");
      const stepAppend = stepReplyPart ? `\n\n${stepReplyPart}` : "";

      // Combo meal upsell — after logging a high-protein SA combo, suggest a veg side
      const COMBO_UPSELL: Record<string, string> = {
        "Mince and pap":     "Pap and mince — classic muscle meal. 💪 Want to add a veg side? Spinach or chakalaka takes 2 minutes and adds iron without touching your macros.",
        "Pap and pilchards": "Pap and pilchards — the best budget protein meal in SA. 🐟 Add a handful of spinach or chakalaka to round it out.",
        "Pap and wors":      "Pap and wors — solid meal. 🔥 Add chakalaka or morogo to get some fibre in without adding calories.",
        // No buttons (2026-08-06 sweep): they REPORTED a meal, they didn't ask a question, and
        // a menu under a confirmation is the machine changing the subject. They can say yes.
        "Chicken and pap":   "Pap and chicken — good protein. Add spinach or butternut on the side to hit your micronutrients.",
        "Pap and stew":      "Pap and stew — high protein combo. Add cabbage or spinach on the side to balance the meal.",
      };
      const comboUpsell = allAdjustedFoods
        .map(f => COMBO_UPSELL[f.name])
        .find(note => note);
      const upsellNote = comboUpsell ? `\n\n${comboUpsell}` : "";
      const guiltNote = hasGuiltSignal ? `\n\n_No judgment — it's logged and counted. One off-plan meal doesn't undo weeks of work. Your next meal is the reset._` : "";
      const activationNote = await firstActionCelebration(user, phone, "meal");

      // BRANDED MACRO CARD (2026-07-21): a macro-goal client gets the orange progress-bar image on the log (marker stripped + sent as media downstream). Wellness clients get "" — no card forced on them. Fail-open.
      const cardName = allAdjustedFoods.map((f: any) => f.name).filter(Boolean).slice(0, 2).join(" + ") || mealLabel;
      const macroCard = await macroCardMarker({ user, mealName: cardName, mealKcal: totalCals, forDate: scannerIsRetro ? scannerLoggedAt : undefined, achievementStreak: streakCelebration ? foodStreak : undefined });
      const streakLine = achievementCardShown(user, streakCelebration ? foodStreak : undefined, macroCard) ? shortStreakNote(foodStreak, user.name || "") : streakCelebration;
      const guardrail = await nutritionGuardrailNudge(user); // "too much of something" health-standard nudge
      const plannedNote = plannedSegs.length > 0
        ? `\n\n📋 Not logged yet (still coming): *${plannedSegs.join("; ")}*. Reply *ate it* once you've had it and I'll add it.`
        : "";
      const dn = unloggedFoodNotice(message, allAdjustedFoods.map(f => f.name));
      const droppedNote = dn ? `\n\n${dn}` : "";

      // REPLY CONTRACT (REPLY_CONTRACT=on): compact the FULLY-ASSEMBLED reply — menus append after the body.
      const assembled = `${reply}${scannerRetroNote}${saPattern ? "\n\n" + saPattern : ""}${saDay || ""}${streakLine}${upsellNote}${guiltNote}${plannedNote}${stepAppend}${activationNote}${guardrail}`;
      const contractOn = process.env.REPLY_CONTRACT === "on" && !clientAskedForDetail(message);
      const finalBody = contractOn ? enforceReplyContract(assembled) : assembled;
      return `${finalBody}${droppedNote}${cardOrTotals(macroCard, totalCals, totalProtein, user)}`;
    }

    // All segments were planned/future (e.g. a lone "dinner is going to be stir fry fish")
    // — don't fall through to the GPT fallback, which would log the plan as eaten.
    if (allAdjustedFoods.length === 0 && plannedSegs.length > 0) {
      const plannedReply = `Got it — *${plannedSegs.join("; ")}* coming up. Not logged yet.\n\nReply *ate it* once you've had it and I'll add the numbers.`;
      await logChat(user.id, message, plannedReply, "FOOD_PLANNED");
      return plannedReply;
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
        const fbIsDessert = TREAT_WORDS.test(m);
        const gptLoggedAt = parseMealDate(message);
        const gptIsRetro = isRetroactiveMeal(message);
        const committed = await commitFoodLog({
          userId: user.id,
          phone,
          rawMessage: message.slice(0, 1000),
          source: "gpt_fallback",  // retro is TIMING (loggedAt), never the origin
          kcalInt: gptFallbackResult.totalKcal,
          proteinInt: gptFallbackResult.totalProtein,
          carbsInt: Math.round(gptFallbackResult.foods.reduce((s: number, f: any) => s + (Number(f.carbs_g) || 0), 0)),
          fatInt: Math.round(gptFallbackResult.foods.reduce((s: number, f: any) => s + (Number(f.fat_g) || 0), 0)),
          items: gptFallbackResult.foods.map((f: any) => ({
            name: f.name, grams: 0, kcal: f.kcal, protein: f.protein_g, category: f.category,
            origin: "ai",
          })),
          mealLabel: extractMealLabel(message, undefined, { kcal: gptFallbackResult.totalKcal, protein: gptFallbackResult.totalProtein }, user, await getSlotContext(user.id)),
          loggedAt: gptLoggedAt,
        });
        const { prevCals: fbPrevCals, runningCals, runningProtein } = committed;
        const fallbackReply = await buildFoodLogReply({
          foodLines, mealLabel: fbIsDessert ? "Dessert" : fbIsSnack ? "Snack" : "Meal total",
          totalMealCals: gptFallbackResult.totalKcal, totalMealProtein: gptFallbackResult.totalProtein,
          cardComing: cardWillAttach(user, gptFallbackResult.totalKcal, !!cardBaseUrl()),
          runningCals, runningProtein, calorieTarget, proteinTarget, prevCals: fbPrevCals, userMessage: message,
          coachNoteOverride: gptFallbackResult.coachNote || undefined,
          hasGoodProteins: gptFallbackResult.foods.some((f: any) => f.category === "protein"),
          hasCarbs: gptFallbackResult.foods.some((f: any) => f.category === "carb"),
          user, isRetro: gptIsRetro,
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
        const fbCardName = gptFallbackResult.foods.map((f: any) => f.name).filter(Boolean).slice(0, 2).join(" + ") || "Meal";
        const fbStreakNote = await getStreakNote(user.id, fbStreak, user.name || "");
        const fbCard = await macroCardMarker({ user, mealName: fbCardName, mealKcal: gptFallbackResult.totalKcal, forDate: gptIsRetro ? gptLoggedAt : undefined, achievementStreak: fbStreakNote ? fbStreak : undefined });
        return `${fallbackReply}${fbPattern ? "\n\n" + fbPattern : ""}${fbDay || ""}${fbStreakNote}${fbGuiltNote}${protClarifyNote}${fbDroppedNote}${stepReplyPart ? "\n\n" + stepReplyPart : ""}${cardOrTotals(fbCard, gptFallbackResult.totalKcal, gptFallbackResult.totalProtein, user)}`;
      }
    }
  }

  // ---- GPT FOOD FALLBACK (no SA foods detected but clear food intent) ----
  // Live 2026-08-19: "I had a McDonald's South African breakfast with a mocha" fell through
  // to freeform coach → "I don't have a meal logged / what did you eat?" + invented macros.
  // Cause: SA scanner missed branded meal; path must still attempt GPT log (or one clarify),
  // never hand a clear "I had … breakfast" turn to the chat coach.
  const hasStrongFoodTrigger = /\b(i ate|i had|i've had|ive had|just had|just ate|just finished eating|for breakfast|for lunch|for dinner|for supper|for brunch|for snack|breakfast was|lunch was|dinner was|supper was|brunch was|meal was|meal is|food was|i'm eating|im eating|i am eating|i'll have|gonna have|going to have|pre.?workout meal|post.?workout meal|had a\b|had some\b|had the\b|had my\b|ate a\b|ate some\b|ate the\b|ate my\b|having a\b|having some\b|having my\b)\b/i.test(m);
  // Branded / takeaway meal with an eating verb — treat as log intent even when DB has no row.
  const hasNamedMealIntent = hasLogTrigger && /\b(mcdonald'?s?|kfc|spur|nando'?s?|steers|wimpy|burger\s*king|pizza\s*hut|domino'?s?|takeaways?|takeaway|take\s*away|drive\s*thru|mocha|cappuccino|latte|flat white|breakfast|lunch|dinner|supper|brunch)\b/i.test(m);
  // Word-count ceiling only applies to bare statements without a strong eating trigger.
  // Voice notes that clearly say "I had X" must always get a log attempt.
  const voiceFallbackTooLong = m.split(/\s+/).filter(Boolean).length > 50 && !hasStrongFoodTrigger && !hasNamedMealIntent;
  const looksLikeBareFoodStatement = !isFuturePlanning && !isFrustration && !hasSubstantiveQuestion
    // Up to 22 words is safe here: the GPT extractor self-filters non-food (only logs when it
    // confirms is_food), so longer run-on voice-note meals get a shot without false logs.
    && m.split(/\s+/).filter(Boolean).length <= 22;
  // isFuturePlanning must never hit the GPT food extractor — not eaten yet; without this
  // the GPT path asks "I didn't catch what food that was" about a plan.
  // bareMealTimeReference: "had breakfast" / "lunch" / "just had my dinner" — a meal-TIME word
  // with no actual food. The GPT extractor would FABRICATE a specific meal (e.g. "McDonald's Big
  // Breakfast") from it. Don't call it — let the coach ask what they actually ate.
  const bareMealTimeReference = /^(?:i\s+)?(?:just\s+)?(?:had|have|having|ate|eating|did|done|for|my)?\s*(?:my\s+|some\s+|a\s+|the\s+)?(?:big\s+|small\s+|nice\s+|quick\s+|light\s+|heavy\s+|huge\s+|large\s+|good\s+|proper\s+|full\s+|lekker\s+)?(?:breakfast|lunch|dinner|supper|brunch|meal|food|brekkie|brekkies)\b[.!?]*$/i.test(m.trim());
  // Eating-verb + meal/brand words: never require SA-DB hit. isQuestion alone must not
  // block a declarative "I had breakfast at McDonald's" voice note.
  // forceLog (messy intake / executor) is a WRITE order — never blocked by the classifier
  // calling a declarative "I had McDonald's breakfast" a QUESTION (live 2026-08-19 ×4).
  const mealReportNotQuestion = forceLog
    ? true
    : (hasStrongFoodTrigger || hasNamedMealIntent
      ? !(classifierQuestion || /\?\s*$/.test(m.trim()))
      : !isQuestion);
  const tryGptFood = mealReportNotQuestion && !isEmotionalOnly && !hasActualFood && !voiceFallbackTooLong
    && !isFuturePlanning && !bareMealTimeReference && !isMealSuggestionRequest
    && (hasStrongFoodTrigger || hasNamedMealIntent || looksLikeBareFoodStatement || forceLog);
  if (tryGptFood) {
    const gptFallbackResult = await gptFoodFallback(message, user);
    if (gptFallbackResult) {
      const calorieTarget = user.calorieTarget || 1800;
      const foodLines = gptFallbackResult.foods.map((f: any) =>
        `• ${f.name}: ~${f.kcal} kcal, ${f.protein_g}g protein (${f.portion_desc})`
      ).join("\n");
      const fb2IsSnack = /\bsnack\b/i.test(m) || (gptFallbackResult.totalKcal < 250 && gptFallbackResult.totalProtein <= 4);
      const fb2IsDessert = TREAT_WORDS.test(m);
      const fb2LoggedAt = parseMealDate(message);
      const fb2IsRetro = isRetroactiveMeal(message);
      const committed2 = await commitFoodLog({
        userId: user.id,
        phone,
        rawMessage: message.slice(0, 1000),
        source: "gpt_fallback",  // retro is TIMING (loggedAt), never the origin
        kcalInt: gptFallbackResult.totalKcal,
        proteinInt: gptFallbackResult.totalProtein,
        carbsInt: Math.round(gptFallbackResult.foods.reduce((s: number, f: any) => s + (Number(f.carbs_g) || 0), 0)),
        fatInt: Math.round(gptFallbackResult.foods.reduce((s: number, f: any) => s + (Number(f.fat_g) || 0), 0)),
        items: gptFallbackResult.foods.map((f: any) => ({
          name: f.name, grams: 0, kcal: f.kcal, protein: f.protein_g, category: f.category,
        })),
        mealLabel: extractMealLabel(message, undefined, { kcal: gptFallbackResult.totalKcal, protein: gptFallbackResult.totalProtein }, user, await getSlotContext(user.id)),
        loggedAt: fb2LoggedAt,
      });
      const { prevCals: fb2PrevCals, runningCals, runningProtein } = committed2;
      const fallbackReply = await buildFoodLogReply({
        foodLines, mealLabel: fb2IsDessert ? "Dessert" : fb2IsSnack ? "Snack" : "Meal total",
        totalMealCals: gptFallbackResult.totalKcal, totalMealProtein: gptFallbackResult.totalProtein,
        cardComing: cardWillAttach(user, gptFallbackResult.totalKcal, !!cardBaseUrl()),
        runningCals, runningProtein, calorieTarget, proteinTarget: user.proteinTarget || 120,
        prevCals: fb2PrevCals, userMessage: message,
        coachNoteOverride: gptFallbackResult.coachNote || undefined,
        hasGoodProteins: gptFallbackResult.foods.some((f: any) => f.category === "protein"),
        hasCarbs: gptFallbackResult.foods.some((f: any) => f.category === "carb"),
        user, isRetro: fb2IsRetro,
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
      const fb2CardName = gptFallbackResult.foods.map((f: any) => f.name).filter(Boolean).slice(0, 2).join(" + ") || "Meal";
      const fb2StreakNote = await getStreakNote(user.id, fb2Streak, user.name || "");
      const fb2Card = await macroCardMarker({ user, mealName: fb2CardName, mealKcal: gptFallbackResult.totalKcal, forDate: fb2IsRetro ? fb2LoggedAt : undefined, achievementStreak: fb2StreakNote ? fb2Streak : undefined });
      return `${fallbackReply}${fbPattern ? "\n\n" + fbPattern : ""}${fbDay || ""}${fb2StreakNote}${fb2GuiltNote}${fb2ProtClarifyNote}${fb2DroppedNote}${stepReplyPart ? "\n\n" + stepReplyPart : ""}${cardOrTotals(fb2Card, gptFallbackResult.totalKcal, gptFallbackResult.totalProtein, user)}`;
    }
    // GPT returned null / is_food=false. If the user clearly signalled food (strong trigger),
    // ask them to clarify rather than silently dropping. But if we only got here on the loose
    // bare-statement path, GPT judging it non-food means it probably IS non-food — fall through
    // to normal chat so a non-food message never gets answered with "describe your food".
    // …unless they were telling us how they FEEL (2026-08-04, gauntlet). "Work is stressing me
    // out and I ate takeaways again tonight" got "I didn't catch what food that was — can you
    // describe it as something like chicken breast and rice?". He said he was not coping and
    // was handed a data-entry format. Same failure as the unpriced-food notice, same owner:
    // when the model cannot read the food AND the person is struggling, the reply belongs to
    // the coach, not to the logger. Falls through to normal chat rather than demanding a format.
    if ((hasStrongFoodTrigger || hasNamedMealIntent) && carriesFeelingClause(message)) {
      console.log(`[GPT-FOOD-FALLBACK] unreadable food inside a feeling clause — leaving the reply to the coach: "${message.slice(0, 60)}"`);
    } else if (hasStrongFoodTrigger || hasNamedMealIntent) {
      console.warn(`[GPT-FOOD-FALLBACK] null result for: "${message.slice(0, 80)}" — asking for clarification`);
      const clarifyReply = `I heard you — I just need the items a bit clearer to log it accurately. E.g. "McDonald's deluxe breakfast and a mocha" or "2 eggs, toast, coffee". One line is enough.`;
      await logChat(user.id, message, clarifyReply, "FOOD_CLARIFY");
      return clarifyReply;
    }
  }

  // Last resort: clear "I had … meal" must never reach freeform coach (invents macros /
  // "what did you eat?"). One clarify, no numbers, no steps.
  if ((hasStrongFoodTrigger || hasNamedMealIntent || forceLog) && !isFuturePlanning && !isEmotionalOnly) {
    console.warn(`[FOOD_GATE] strong meal signal fell through — forcing clarify: "${message.slice(0, 80)}"`);
    const clarifyReply = `Got it — you ate something. Tell me the items in one line (e.g. "McDonald's breakfast and a mocha") and I'll log it.`;
    await logChat(user.id, message, clarifyReply, "FOOD_CLARIFY");
    return clarifyReply;
  }

  return null;
}

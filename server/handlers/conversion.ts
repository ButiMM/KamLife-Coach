/**
 * Conversion objection handlers — runs INSIDE the subscription gate for inactive
 * users. Instead of re-showing the bare payment link to a prospect who is asking
 * about price or hesitating, give a value-framed, conversion-protecting reply.
 *
 * Pure function (no DB, no async) so it is fully unit-testable. The caller
 * (routes.ts subscription gate) owns logChat + return.
 *
 * Ordering matters: a money/affordability objection ("too expensive") and a
 * stall ("let me think") are handled before a plain price question, because
 * those phrases also contain price-ish words but need a different response.
 */

// Money / affordability objection — "no money", "too expensive", "after payday"
import { PRICING, GUARANTEE_PHRASE } from "../../shared/pricing";

const MONEY_OBJECTION_RE = /\b(no money|don.?t have (?:the )?money|haven.?t got money|can.?t afford|cannot afford|too expensive|too pricey|so expensive|very expensive|bit expensive|quite expensive|expensive for me|too much money|no cash|i.?m broke|i am broke|broke right now|month.?end|end of month|after (?:i get )?payday|after payday|when i (?:get paid|have money|am paid|get money)|once i (?:get paid|have money)|next month|next pay|tight (?:on money|right now|financially)|money.?s tight|short on cash|not in my budget|out of my budget|can.?t pay|cannot pay)\b/i;

// Stall / hesitation — "let me think", "maybe later", "not sure", "not ready"
const STALL_RE = /\b(let me think|i.?ll think|think about it|thinking about it|need to think|have to think|not sure(?: yet| about this)?|maybe later|maybe next|maybe tomorrow|maybe soon|i.?ll get back|get back to you|give me (?:time|a (?:day|week|moment|minute|sec)|some time)|i.?ll decide|decide later|deciding|still deciding|not (?:right )?now|another time|i.?ll let you know|let you know|gonna think|going to think|considering it|i.?m not ready|not ready (?:yet|to|for)|hold off|hold on a|wait a bit|i.?ll see|we.?ll see)\b/i;

// Plain price / cost question — pure information request, no objection
const PRICE_RE = /\b(?:price|pricing|how expensive|monthly fee|subscription (?:cost|price|fee)|what.?s the (?:price|cost|fee|charge|damage)|how much (?:is|does|to|for|will|per|a month|it cost|this cost|the|your|do|i pay)|how much.{0,18}(?:cost|pay|month|rand|join|sign|subscri)|how many rands?|cost (?:per month|to join|to start|of this)|what (?:does it|do you|will it|do i) (?:cost|charge|pay)|is it free|free trial|r\s?149|r\s?199)\b/i;

export type ConversionResult = { reply: string; intent: string } | null;

export function handleConversionObjection(ctx: {
  user: any;
  m: string;
  payLink: string;
  name: string;
}): ConversionResult {
  const { m, payLink, name } = ctx;

  // ── MONEY / AFFORDABILITY — reframe the cost, hold the door open ──
  if (MONEY_OBJECTION_RE.test(m)) {
    const reply = `${name}, no pressure and no judgment — money is real. But look at it this way: *R${PRICING.monthlyPriceZAR} is ${PRICING.dailyDisplay.replace("/day", "")} a day.* That is less than a single cooldrink or your daily airtime. It is not a big expense, it is a small daily one.\n\nThe real cost is staying stuck — another year in the same body, the same energy, the same clothes that do not fit.\n\nYour programme is already built and saved right here. Nothing is lost. The day the money comes in, you tap this link and pick up exactly where you left off:\n${payLink}\n\nIn the meantime — what is the *one* thing you most want to change about your body? Tell me, and I will give you something free to start today.`;
    return { reply, intent: "CONVERSION_MONEY" };
  }

  // ── STALL / HESITATION — surface the real blocker, de-risk the decision ──
  if (STALL_RE.test(m)) {
    const reply = `${name}, fair enough — no rush. But let me ask you straight: what is actually holding you back — the price, or whether it will really work for you?\n\nIf it is whether it works: your full programme is already built. ${PRICING.monthlyDisplay}, cancel anytime, and a ${GUARANTEE_PHRASE} — if it is not for you, you get your money back. The risk is basically zero — the only thing you lose by waiting is time.\n\nWhen you are ready, tap here and you pick up right where you left off:\n${payLink}\n\nSo tell me — what is your main goal? Fat loss, or building muscle? Let me show you what week one looks like for you.`;
    return { reply, intent: "CONVERSION_STALL" };
  }

  // ── PLAIN PRICE QUESTION — answer crisply, frame the value, redirect to goal ──
  if (PRICE_RE.test(m)) {
    const reply = `${name}, straight up: *R${PRICING.monthlyPriceZAR} a month — that is ${PRICING.dailyDisplay.replace("/day", "")} a day.* Less than a loaf of bread, cancel anytime, no contract.\n\nFor that you get everything: your full personalised programme, daily food and calorie coaching on real SA food, workout tracking, and me checking in on you every single day. All on WhatsApp — no app to download.\n\nA personal trainer charges R250+ for *one* session. This is all-in, every day, for the price of a chocolate.\n\nReady to start? Tap here:\n${payLink}\n\nOr tell me first — what is your main goal? Fat loss, muscle, or just getting healthy? Let me show you exactly how I would get you there.`;
    return { reply, intent: "CONVERSION_PRICE" };
  }

  return null;
}


/** The inactive-subscription gate, kept ahead of all ordinary coaching claimants. */
export async function handleSubscriptionGate(ctx: {
  phone: string;
  message: string;
  m: string;
  user: any;
  isCoach: boolean;
  isBetaTester: boolean;
}): Promise<string | null> {
  const { phone, message, m, user, isCoach, isBetaTester } = ctx;
  const trialExpired = user.subscriptionStatus === "trial"
    && user.betaBypassUntil && new Date(user.betaBypassUntil) < new Date();
  if (!((user.subscriptionStatus === "inactive" || trialExpired) && !isCoach && !isBetaTester)) return null;

  const isSafety = /\b(chest pain|chest hurts?|chest is (tight|sore|aching|burning)|pain in my chest|chest tightness|can.?t breathe|shortness of breath|can.?t catch my breath|heart racing|heart pounding|dizziness|feeling faint|emergency|hospital|ambulance|crisis|suicid|hurt myself)\b/i.test(m);
  if (isSafety) return null;

  const appUrl = process.env.APP_URL || "https://kamlifecoach.co.za";
  const merchantId = process.env.PAYFAST_MERCHANT_ID;
  const cleanPhone = phone.replace(/^whatsapp:/, "");
  const payLink = merchantId ? `${appUrl}/api/payfast/link?phone=${encodeURIComponent(cleanPhone)}` : appUrl;
  const name = user.name?.split(" ")[0] || "there";
  const conversionResult = handleConversionObjection({ user, m, payLink, name });
  if (conversionResult) {
    const { logChat } = await import("./chat-log");
    await logChat(user.id, message, conversionResult.reply, conversionResult.intent);
    return conversionResult.reply;
  }

  const isFoodGuidanceQ = /\b(what should i eat|how should i eat|how do i eat|what do i eat|what to eat|meal plan|eating plan|diet plan|give me a meal plan|how do you suggest i eat|what can i eat|how to eat|tell me what to eat|what must i eat|what should i be eating|food plan|i don.?t know what to eat|no idea what to eat|don.?t know how to eat|eating guide|what foods should i|what food should i|nutrition plan)\b/i.test(m);
  if (isFoodGuidanceQ) {
    const { generateMealPlan } = await import("../meal-plan");
    const glimpsePlan = generateMealPlan({
      calorieTarget: user.calorieTarget || 1800, proteinTarget: user.proteinTarget || 120,
      weeklyFoodBudget: user.weeklyFoodBudget || "100_300", goalType: user.goalType || "fat_loss",
      medicalConditions: user.medicalConditions || "", dietaryRestrictions: user.dietaryRestrictions,
      foodDislikes: user.foodDislikes, otherMedicalNotes: user.otherMedicalNotes || "", recentFoods: [],
      firstName: user.name?.split(" ")[0] || "",
    });
    const planParts = glimpsePlan.split("\n\n---\n\n");
    const upsell = `That is Day 1.\n\nDays 2 and 3 rotate the meals so you are not eating the same thing every day. Your weekly shopping list with ZAR prices is in there too.\n\n*Full weekly plan + shopping list + daily coaching — ${PRICING.monthlyDisplay}:*\n${payLink}\n\n_${PRICING.dailyDisplay}. Not satisfied? ${GUARANTEE_PHRASE} — Message us and we will make it right._`;
    const reply = `${planParts[0] || ""}\n\n${planParts[1] || ""}\n\n---\n\n${upsell}`;
    const { logChat } = await import("./chat-log");
    await logChat(user.id, message, reply, "MEAL_PLAN_GLIMPSE");
    return reply;
  }

  const workouts = user.totalWorkoutsCompleted || 0;
  const isLapsed = !!user.cancelledAt;
  let reply: string;
  if (isLapsed) {
    const cancelDate = new Date(user.cancelledAt!).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });
    const currentKg = user.currentWeight ? `${parseFloat(String(user.currentWeight)).toFixed(1)}kg` : null;
    const progressNote = workouts > 0 ? `${workouts} session${workouts !== 1 ? "s" : ""}${currentKg ? `, currently at ${currentKg}` : ""} — all saved.` : "";
    reply = `${name}, your subscription ended ${cancelDate}. ${progressNote}\n\nReply *pay* to pick up exactly where you left off.\n\n*${PRICING.monthlyDisplay} — cancel anytime:*\n${payLink}`;
  } else if (workouts > 0) {
    reply = `${name}, reactivate to get your workouts, food coaching, and full programme back.\n\n*${PRICING.monthlyDisplay} — cancel anytime:*\n${payLink}\n\nYour ${workouts} session${workouts !== 1 ? "s" : ""} and all progress are saved.`;
  } else {
    reply = `${name}, your programme is built and waiting.\n\n*Start today — ${PRICING.monthlyDisplay} (${PRICING.dailyDisplay})*\n${payLink}\n\n_${GUARANTEE_PHRASE} — not for you, and we make it right._`;
  }
  const { logChat } = await import("./chat-log");
  await logChat(user.id, message, reply, "SUBSCRIPTION_GATE");
  return reply;
}

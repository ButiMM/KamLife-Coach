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
const MONEY_OBJECTION_RE = /\b(no money|don.?t have (?:the )?money|haven.?t got money|can.?t afford|cannot afford|too expensive|too pricey|so expensive|very expensive|bit expensive|quite expensive|expensive for me|too much money|no cash|i.?m broke|i am broke|broke right now|month.?end|end of month|after (?:i get )?payday|after payday|when i (?:get paid|have money|am paid|get money)|once i (?:get paid|have money)|next month|next pay|tight (?:on money|right now|financially)|money.?s tight|short on cash|not in my budget|out of my budget|can.?t pay|cannot pay)\b/i;

// Stall / hesitation — "let me think", "maybe later", "not sure", "not ready"
const STALL_RE = /\b(let me think|i.?ll think|think about it|thinking about it|need to think|have to think|not sure(?: yet| about this)?|maybe later|maybe next|maybe tomorrow|maybe soon|i.?ll get back|get back to you|give me (?:time|a (?:day|week|moment|minute|sec)|some time)|i.?ll decide|decide later|deciding|still deciding|not (?:right )?now|another time|i.?ll let you know|let you know|gonna think|going to think|considering it|i.?m not ready|not ready (?:yet|to|for)|hold off|hold on a|wait a bit|i.?ll see|we.?ll see)\b/i;

// Plain price / cost question — pure information request, no objection
const PRICE_RE = /\b(?:price|pricing|how expensive|monthly fee|subscription (?:cost|price|fee)|what.?s the (?:price|cost|fee|charge|damage)|how much (?:is|does|to|for|will|per|a month|it cost|this cost|the|your|do|i pay)|how much.{0,18}(?:cost|pay|month|rand|join|sign|subscri)|how many rands?|cost (?:per month|to join|to start|of this)|what (?:does it|do you|will it|do i) (?:cost|charge|pay)|is it free|free trial|r\s?199)\b/i;

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
    const reply = `${name}, no pressure and no judgment — money is real. But look at it this way: *R199 is R6.63 a day.* That is less than a single cooldrink or your daily airtime. It is not a big expense, it is a small daily one.\n\nThe real cost is staying stuck — another year in the same body, the same energy, the same clothes that do not fit.\n\nYour programme is already built and saved right here. Nothing is lost. The day the money comes in, you tap this link and pick up exactly where you left off:\n${payLink}\n\nIn the meantime — what is the *one* thing you most want to change about your body? Tell me, and I will give you something free to start today.`;
    return { reply, intent: "CONVERSION_MONEY" };
  }

  // ── STALL / HESITATION — surface the real blocker, de-risk the decision ──
  if (STALL_RE.test(m)) {
    const reply = `${name}, fair enough — no rush. But let me ask you straight: what is actually holding you back — the price, or whether it will really work for you?\n\nIf it is whether it works: your full programme is already built. R199/month, cancel anytime, and if you are not happy after week one we make it right. The risk is basically zero — the only thing you lose by waiting is time.\n\nWhen you are ready, tap here and you pick up right where you left off:\n${payLink}\n\nSo tell me — what is your main goal? Fat loss, or building muscle? Let me show you what week one looks like for you.`;
    return { reply, intent: "CONVERSION_STALL" };
  }

  // ── PLAIN PRICE QUESTION — answer crisply, frame the value, redirect to goal ──
  if (PRICE_RE.test(m)) {
    const reply = `${name}, straight up: *R199 a month — that is R6.63 a day.* Less than a loaf of bread, cancel anytime, no contract.\n\nFor that you get everything: your full personalised programme, daily food and calorie coaching on real SA food, workout tracking, and me checking in on you every single day. All on WhatsApp — no app to download.\n\nA personal trainer charges R250+ for *one* session. This is all-in, every day, for the price of a chocolate.\n\nReady to start? Tap here:\n${payLink}\n\nOr tell me first — what is your main goal? Fat loss, muscle, or just getting healthy? Let me show you exactly how I would get you there.`;
    return { reply, intent: "CONVERSION_PRICE" };
  }

  return null;
}

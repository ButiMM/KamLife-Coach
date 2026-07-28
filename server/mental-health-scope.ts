/**
 * MENTAL-HEALTH SCOPE — the band between "having a rough week" and a crisis.
 *
 * (2026-07-27, ledger D10, from the "I'm honestly depressed, the only thing I've had is alcohol"
 * thread.) The crisis path already handles self-harm properly: SADAG, Lifeline, stop coaching.
 * Everything below that fell to the general coach, which either lectured about protein or
 * produced therapy-speak. Neither is right, and "go deeper on emotional coaching" is the wrong
 * fix — a fitness product that starts treating depression is both out of its depth and outside
 * what a coach may legally do in South Africa.
 *
 * So the build is a BOUNDARY, not more depth. Three moves, in order:
 *   1. Respond like a person — no feelings diagnosis, no "I hear you", no protein lecture.
 *   2. Name the limit honestly: this is bigger than coaching, and here is who does handle it.
 *   3. Keep the door open on the ONE thing a coach genuinely helps with — showing up.
 *
 * This is deliberately narrow. It fires on sustained low mood, drinking instead of eating, and
 * disordered-eating language — not on "I'm tired" or a bad day. Pure — unit-tested.
 */

export type ScopeSignal = "low_mood" | "alcohol_instead_of_food" | "disordered_eating";

// Sustained, self-reported low mood. "Depressed about my weight" is coaching territory; "I am
// depressed" / "I can't get out of bed" is not.
const LOW_MOOD = /\b(?:i(?:'?m| am)|been|feeling)\s+(?:really\s+|so\s+|honestly\s+|very\s+|quite\s+)?(?:depressed|depression|hopeless|worthless|numb|empty|broken)\b|\bcan'?t\s+(?:get\s+out\s+of\s+bed|face\s+the\s+day|cope|go\s+on)\b|\bno\s+(?:point|reason)\s+(?:in\s+)?(?:any\s?more|to\s+anything)\b|\bnothing\s+matters\b/i;

// Alcohol standing in for food or used to cope — the specific pattern from the live thread.
const ALCOHOL_INSTEAD = /\b(?:only|just|all)\s+(?:thing\s+)?(?:i'?ve\s+|i\s+)?(?:had|ate|eaten|having|drink|drinking|drunk)\b[^.!?]{0,30}\b(?:alcohol|beer|beers|wine|vodka|brandy|whisky|gin|drink|drinks|booze)\b|\b(?:drinking|drink)\s+(?:instead\s+of\s+eating|to\s+cope|to\s+forget|every\s+(?:day|night)|alone)\b|\bhaven'?t\s+eaten[^.!?]{0,20}\b(?:just|only)\s+(?:drink|alcohol|beer|wine)\b/i;

// Disordered eating. SADAG runs the SA helpline for this too.
const DISORDERED = /\b(?:make\s+myself\s+(?:sick|throw\s+up|vomit)|purge|purging|binge(?:ing|d)?\s+(?:and|then)\s+(?:purg|starv)|starve\s+myself|starving\s+myself|not\s+eaten\s+(?:in|for)\s+(?:\d+\s+)?days?|hate\s+my\s+body\s+so\s+much|laxatives?\s+to\s+lose)\b/i;

// A bad day is not this. These keep the boundary reply off ordinary coaching moments.
const ORDINARY = /\b(?:depressed|down)\s+(?:about|by)\s+(?:my|the)\s+(?:weight|scale|progress|numbers|belly)\b|\bjust\s+(?:tired|a\s+bad\s+day|stressed\s+at\s+work)\b/i;

/** Which scope signal is present, if any. Null = ordinary coaching, handle normally. */
export function classifyScope(message: string): ScopeSignal | null {
  const s = (message || "").trim();
  if (!s) return null;
  if (ORDINARY.test(s) && !DISORDERED.test(s)) return null;
  if (DISORDERED.test(s)) return "disordered_eating";
  if (ALCOHOL_INSTEAD.test(s)) return "alcohol_instead_of_food";
  if (LOW_MOOD.test(s)) return "low_mood";
  return null;
}

/**
 * The reply. Honest about the limit, warm about the person, and it never pretends a coach can
 * treat this. No emotion-labelling ("it sounds like you're feeling…") — that register is exactly
 * what made the live threads worse.
 */
export function scopeReply(signal: ScopeSignal, firstName = ""): string {
  const fn = firstName ? `${firstName}, ` : "";
  const help = `*SADAG* — 0800 567 567, free, 24 hours, confidential. Or SMS 31393 and they call you back.`;

  switch (signal) {
    case "alcohol_instead_of_food":
      return `${fn}thank you for telling me that — most people wouldn't.\n\nI'm going to be straight with you: drinking in place of food isn't something I can coach you out of, and pretending otherwise would be useless to you. That's a real thing and there are people who genuinely handle it.\n\n${help}\n\nWhat I can do is stay here for the ordinary stuff — one meal, one walk, whenever you're ready. No programme, no targets, nothing to catch up on. Just tell me when you've eaten something and I'll take it from there.`;

    case "disordered_eating":
      return `${fn}I'm glad you said it out loud.\n\nWhat you've described is beyond what a fitness coach should be handling — and I'd be doing you real harm if I gave you targets and a training plan on top of it. This needs someone trained for it.\n\n${help} They handle exactly this, and it's free.\n\nI'm not going anywhere. But I'm pausing the numbers — no calorie targets, no weigh-ins from me — until you've spoken to someone. Your body isn't the problem to solve right now.`;

    case "low_mood":
      return `${fn}that's a heavy thing to be carrying, and I'm not going to hand you a protein target and pretend it helps.\n\nI'm a coach — I'm good for the food, the training and the showing up. What you're describing sits outside that, and the people who do handle it are one free phone call away:\n\n${help}\n\nMeanwhile the door stays open here. If all you manage today is one proper meal or a ten-minute walk, that counts and I'll log it. No targets, no catching up on what you missed.`;
  }
}

/** Should the coach hold off on targets and numbers after this? Keeps the tone honest. */
export function pausesNumbers(signal: ScopeSignal): boolean {
  return signal === "disordered_eating";
}

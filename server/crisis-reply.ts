/**
 * CRISIS — the one path where the product must stop being a coach.
 *
 * (2026-07-28, from the review: the liability here is not that we fail to detect a crisis. It is
 * that we detect one and keep coaching anyway — a helpline in paragraph one and a protein target
 * in paragraph three. Nothing about a calorie, a streak, a weigh-in or "reply DONE" may appear
 * in this reply, and no automated nudge may follow it.)
 *
 * Pulled out of handlers/safety.ts so it is pure and can be tested directly. The detection list
 * and the reply live together on purpose: a test that reads one must be able to read the other,
 * because the failure mode is the gap between them.
 *
 * Pure — no DB, no model. Tested in script/safety-audit.ts.
 */

export const CRISIS_PHRASES = [
  "want to die", "kill myself", "end it all", "cannot go on", "can't go on",
  "suicidal", "self harm", "self-harm", "cutting myself", "hurting myself",
  "not worth living", "end my life", "no reason to live", "give up on life",
  "want to hurt myself", "harm myself", "take my life",
  "no point in living", "better off dead", "hang myself",
  "everyone would be better off without me",
  "don't want to be here", "do not want to be here", "dont want to be here",
  "wish i was dead", "wish i were dead", "nothing to live for", "tired of living",
];

/** `m` is the lowercased message the handler pipeline already computed. */
export function isCrisisMessage(m: string): boolean {
  const s = (m || "").toLowerCase();
  return CRISIS_PHRASES.some(phrase => s.includes(phrase));
}

/**
 * The reply. Short, warm, resources first, and then nothing — because anything after the
 * helpline reads as the app carrying on with its day.
 */
export function crisisReply(name = "friend"): string {
  const who = (name || "").trim() || "friend";
  return `${who}, I hear you and I am concerned. Please contact SADAG right now — 0800 567 567, free, 24 hours, confidential. Lifeline SA: 0861 322 322. You matter far more than any fitness goal. Reach out to them — they are trained for exactly this moment.`;
}

/** The alert to the founder. Separate from the client reply so neither can leak into the other. */
export function crisisAlertBody(name: string, phone: string, message: string): string {
  return `⚠️ CRISIS ALERT\nClient: ${name} (${phone})\nMessage: "${(message || "").slice(0, 150)}"\n\nThey have been given SADAG 0800 567 567. Please check on this client.`;
}

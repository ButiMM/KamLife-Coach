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

import { SOMEBODY_ELSE } from "./life-context";

export const CRISIS_PHRASES = [
  "want to die", "kill myself", "end it all", "cannot go on", "can't go on",
  "suicidal", "self harm", "self-harm", "cutting myself", "hurting myself",
  "not worth living", "end my life", "no reason to live", "give up on life",
  "want to hurt myself", "harm myself", "take my life",
  "no point in living", "better off dead", "hang myself",
  "everyone would be better off without me",
  "don't want to be here", "do not want to be here", "dont want to be here",
  "wish i was dead", "wish i were dead", "nothing to live for", "tired of living", "selfharm",
  // Someone else at risk, as the client reports it (#480): still urgent, answered as a helper.
  "kill herself", "kill himself", "she wants to die", "he wants to die", "end her life", "end his life",
  // SOUTH AFRICAN LANGUAGES (#476): clients write in them, and a crisis in isiZulu was coached as usual.
  // Stems, so every person and tense matches: -zibulala (isiZulu/isiXhosa "kill oneself"),
  // ipolaea/ipolaya (Sesotho/Setswana/Sepedi), selfmoord and doodmaak (Afrikaans).
  "zibulala", "ngifuna ukufa", "ndifuna ukufa", "angisafuni ukuphila",
  "ipolaea", "ipolaya", "batla ho shwa", "batla go swa", "batla go hwa",
  "selfmoord", "myself doodmaak", "wil dood wees", "wil nie meer leef nie",
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

/**
 * SOMEONE ELSE AT RISK (#480). "My friend just said 'ke batla go ipolaya', what should I do?" is still
 * urgent, but the client is the helper, not the person at risk: they get how to help, and the
 * founder is told who is at risk. The reply still offers the lines to the client too, in case the
 * friend is how they found the words for themselves.
 */
const REPORTS = ["said", "says", "told me", "wants to", "keeps saying", "is talking about", "texted", "messaged", "posted", "is thinking"];
export function crisisAboutSomeoneElse(message: string): boolean {
  const text = message || "";
  const m = SOMEBODY_ELSE.exec(text);
  // "I want to die, my friend said I should tell someone": their own words come first, so it is theirs.
  // And the friend must be REPORTED as saying or wanting it ("my friend who died, and I want to die" is theirs).
  if (!m || isCrisisMessage(text.slice(0, m.index)) || !REPORTS.some(v => text.slice(m.index, m.index + 80).toLowerCase().includes(v))) return false;
  // "My husband says I am suicidal": the client speaks in the first person between the third party and
  // the crisis words, so it is THEIR crisis (#481 attack). Words in quotes are the other person's own
  // ('my friend said "I want to die"'), so quoted spans are left out of that check. But a quote that
  // speaks TO the client ('my friend said "you sound suicidal"') is about the client (#481 attack).
  const lower = text.toLowerCase();
  const ends = CRISIS_PHRASES.map(p => { const i = lower.indexOf(p, m.index); return i < 0 ? -1 : i + p.length; }).filter(i => i > 0);
  if (!ends.length) return true;
  let span = lower.slice(m.index, Math.min(...ends));
  let quoted = "";
  for (const [open, close] of [["\u201c", "\u201d"], ["\"", "\""]]) {
    let a = span.indexOf(open);
    while (a >= 0) {
      const b = span.indexOf(close, a + 1);
      quoted += " " + (b < 0 ? span.slice(a + 1) : span.slice(a + 1, b));
      span = b < 0 ? span.slice(0, a) : span.slice(0, a) + span.slice(b + 1);
      a = span.indexOf(open);
    }
  }
  const words = (t: string) => t.split(/[^a-z']+/);
  // ...unless the quote is addressed to someone else by name ("her husband told her, 'you sound
  // suicidal'"): then "you" is the friend, not the client (#496).
  const toSomeoneElse = ["told her", "told him", "told them", "said to her", "said to him", "asked her", "asked him", "texted her", "texted him"].some(p => span.includes(p));
  if (!toSomeoneElse && words(quoted).some(w => ["you", "you're", "youre", "u", "your", "yourself"].includes(w))) return false;
  return !words(span).some(w => ["i", "i'm", "im", "me", "myself", "i've", "ive"].includes(w));
}

export function crisisReplyForSomeoneElse(name = "friend"): string {
  const who = (name || "").trim() || "friend";
  return `${who}, thank you for telling me. That is serious, and you did the right thing. Please help them contact SADAG right now: 0800 567 567, free, 24 hours, confidential. Lifeline SA: 0861 322 322. If they are in danger right now, call 10111 or get them to the nearest emergency unit, and stay with them. If you are struggling too, those lines are for you as well.`;
}

/** The alert to the founder. Separate from the client reply so neither can leak into the other. */
export function crisisAlertBody(name: string, phone: string, message: string, aboutSomeoneElse = false): string {
  const quoted = `Message: "${(message || "").slice(0, 150)}"`;
  return aboutSomeoneElse
    ? `⚠️ CRISIS ALERT (someone close to the client)\nClient: ${name} (${phone})\n${quoted}\n\nThe client reports that someone close to them may be at risk, and was given SADAG 0800 567 567 to help them. Read the message (it may be about the client too) and check in with the client.`
    : `⚠️ CRISIS ALERT\nClient: ${name} (${phone})\n${quoted}\n\nThey have been given SADAG 0800 567 567. Please check on this client.`;
}

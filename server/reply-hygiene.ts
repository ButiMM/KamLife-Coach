/**
 * REPLY HYGIENE — pure text cleanups that make the coach sound HUMAN, not robotic.
 *
 * (2026-07-22, Kam: "it's generic, it's robotic." The live screenshot: "Let me check your
 * meals again... One moment!" — a promise the bot literally cannot keep, because there is no
 * follow-up message. It answers NOW or it defers; it never stalls.) Enforced in code, not
 * left to a prompt line the model ignores. Pure — unit-tested in script/unit-tests.ts.
 */

// Unambiguous STALLS / dead promises: the bot has no channel to "come back" on, so these are
// always lies. High-precision so genuine phrasing survives ("let me break it down" is fine;
// "hold on to your progress" is fine — neither matches).
const DEAD_PROMISE_RE =
  /\b(one moment|just a (?:sec|second|moment)|give me (?:a (?:sec|second|moment|minute)|one (?:sec|second|moment))|bear with me|hang on a (?:sec|second|moment)|(?:i'?ll|let me|i will) (?:get|come) back to you|i'?ll look into (?:that|this|it)|let me look into (?:that|this|it) and (?:get|come) back|let me check[^.!?]*\band (?:get|come) back|checking (?:that|this|it) now|i'?ll be right back|i'?ll (?:check|find out|confirm)[^.!?]*and (?:let you know|get back|come back))\b/i;

// Remove any SENTENCE that is a stall, keeping the rest of the reply intact. If the whole
// reply was a stall, returns "" — the caller's empty-reply handler then gives a real answer.
export function stripDeadPromises(text: string): string {
  const t = (text || "").trim();
  if (!t) return "";
  const sentences = t.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => !DEAD_PROMISE_RE.test(s));
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
}

// True if the reply contains a dead promise anywhere (for tests / guards).
export function hasDeadPromise(text: string): boolean {
  return DEAD_PROMISE_RE.test(text || "");
}

// CONTENT-FREE CORPORATE FILLER — the customer-service padding that makes it read like a bot,
// not like Kam (2026-07-22 live: "I appreciate your patience... I want to make sure we get
// this right for you."). These phrases carry ZERO coaching value; a real coach just answers.
// High-precision: genuine acknowledgement ("that's a tough week", "I hear you") is NOT here.
const FILLER_RE =
  /\b((?:i (?:really )?appreciate|thank you for|thanks for|i value) your patience|i appreciate you (?:being patient|bearing with me|reaching out|for (?:being )?patient)|thank you for reaching out|thanks for reaching out|i want to (?:make sure|ensure)[^.!?]*(?:get this right|for you|right for you)|i(?:'| a)m here to help(?: you)?(?: with (?:this|that|anything))?|rest assured|i understand your frustration|i (?:completely )?understand how you (?:feel|are feeling)|i.?m sorry for the (?:confusion|inconvenience))\b/i;

// Remove content-free filler SENTENCES, keeping the substance. Sibling to stripDeadPromises.
export function stripFiller(text: string): string {
  const t = (text || "").trim();
  if (!t) return "";
  const sentences = t.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => !FILLER_RE.test(s));
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
}

// The full humanize pass — strip stalls AND corporate filler in one go. This is what
// sanitizeCoachReply calls, so every AI reply gets to the point like a real coach.
export function humanizeReply(text: string): string {
  return stripFiller(stripDeadPromises(text));
}

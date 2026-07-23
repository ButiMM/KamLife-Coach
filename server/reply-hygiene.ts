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

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

// ── THE VOICE-NOTE DENIAL ────────────────────────────────────────────────────────────────────
// (2026-07-29 live, and the worst thing this product has produced.) A client sent a voice note.
// It transcribed PERFECTLY. The reply printed that transcript — "🎤 I heard: …" — and directly
// underneath said:
//
//     "Eish, Kam, I'm really sorry about that. I didn't catch the voice note.
//      Could you please repeat what you need here in text?"
//
// It caught the voice note. The proof was in the same message. It denied its own working
// feature and asked a frustrated person to do the work again, in the format they were avoiding.
//
// The cause is structural: the voice path transcribes, then re-enters handleMessage with the
// TEXT only, so nothing downstream knows a voice note existed. A client complaining that their
// voice note was ignored therefore looks, to the model, like a report that the voice note
// failed — and it apologises for a failure that did not happen.
//
// This is the one place where the lie is provably a lie, because we are holding the transcript.
// Both halves must go: the denial, AND the request to type it out — we already have the words.
const VOICE_DENIAL_RE =
  /\b(?:i\s*(?:did\s*n.?t|could\s*n.?t|can'?t|cannot|was\s*n.?t able to)\s*(?:quite\s+|really\s+)?(?:catch|get|hear|receive|make out|pick up|access|process|listen to)\b[^.!?]*\b(?:voice|audio|note|recording|message)|(?:voice note|audio|recording)[^.!?]{0,30}\b(?:did\s*n.?t|has\s*n.?t|was\s*n.?t)\s+(?:come through|arrive|download|register))\b/i;

/** Asking them to say it again — in any form — when the transcript is already in our hands. */
const ASK_TO_REPEAT_RE =
  /\b(?:(?:could|can|would) you (?:please )?(?:repeat|resend|send)\b[^.!?]*|(?:please )?(?:repeat|resend|send|say) (?:it|that|what you need)\b[^.!?]*|type (?:it|that|your message)\b[^.!?]*)(?:again|here|in text|as text|by text)\b/i;

/**
 * Remove any SENTENCE that denies receiving the voice note, or asks them to send it again.
 * Returns "" when the whole reply was denial — the caller then supplies a real answer, exactly
 * like stripDeadPromises. Pure; the caller decides the fallback.
 */
export function stripVoiceDenial(text: string): string {
  const t = (text || "").trim();
  if (!t) return "";
  const sentences = t.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter(s => !VOICE_DENIAL_RE.test(s) && !ASK_TO_REPEAT_RE.test(s));
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
}

/** True if the reply denies a voice note we demonstrably received (for guards and the auditor). */
export function deniesVoiceNote(text: string): boolean {
  return VOICE_DENIAL_RE.test(text || "") || ASK_TO_REPEAT_RE.test(text || "");
}

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

/**
 * Drop every sentence matching `re`, KEEPING the whitespace between the sentences that stay.
 *
 * (2026-07-29 live — the single worst readability defect in the product.) Every filter here used
 * to `split(/(?<=[.!?])\s+/)` and rejoin with a space, which silently flattened every line break
 * in every AI reply. The model was writing a properly formatted numbered list; the client got one
 * unbroken paragraph — "1. *Rest:* … 2. *Nutrition:* … 3. *Hydration:* …" run together — which is
 * exactly the wall of text the founder and a real client both described as "too much".
 *
 * It also destroyed the "\n\n---\n\n" marker that splits a reply into separate WhatsApp bubbles,
 * so that mechanism had never once worked on an AI reply and the literal "---" was left inline.
 *
 * Splitting with a CAPTURING group keeps the original separators, so a filter can remove a
 * sentence without reformatting everything around it.
 */
function dropSentences(text: string, re: RegExp): string {
  const t = (text || "").trim();
  if (!t) return "";
  const parts = t.split(/(?<=[.!?])(\s+)/); // [sentence, sep, sentence, sep, …]
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i];
    if (!sentence || re.test(sentence)) continue;
    out += sentence + (parts[i + 1] ?? "");
  }
  return out
    .replace(/[ \t]{2,}/g, " ")   // collapse runs of SPACES only — never newlines
    .replace(/\n{3,}/g, "\n\n")   // tidy gaps a removed sentence may have left
    .trim();
}

// Remove any SENTENCE that is a stall, keeping the rest of the reply intact. If the whole
// reply was a stall, returns "" — the caller's empty-reply handler then gives a real answer.
export function stripDeadPromises(text: string): string {
  return dropSentences(text, DEAD_PROMISE_RE);
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
  return dropSentences(text, FILLER_RE);
}

// ── THE NUMBERED LISTICLE ────────────────────────────────────────────────────────────────────
// The audit over 1988 real replies: 63 answered with a numbered list instead of coaching and 48
// were a wall of text — 111 of 166 defects, two thirds of everything wrong with this product.
//
// The Constitution ALREADY forbids it, in those words: "NEVER numbered markdown headings like
// '1. *Breakfast:*' — they render broken." The model ignored it sixty-three times, which is the
// whole reason this file exists: "Enforced in code, not left to a prompt line the model ignores."
//
// So the rule gets hands. An inline run of "1. … 2. … 3. …" becomes the bulleted short lines the
// Constitution asks for. This does not shorten the reply or change a word of its content — it
// makes what the coach already said readable on a phone, which is the complaint underneath every
// "it's too much" this product has received.
//
// Conservative on purpose: three or more markers before anything is touched, each must be a low
// single digit followed by a capital or a bold marker, and a decimal ("1.5kg") can never match.
const ENUM_MARKER = /(^|[^\d\n])([1-9])\.\s+(?=[A-Z*])/g;

export function reshapeNumberedList(text: string): string {
  const t = text || "";
  const markers = t.match(ENUM_MARKER);
  if (!markers || markers.length < 3) return t;
  return t
    .replace(ENUM_MARKER, (_m, before: string) => `${before.trimEnd()}\n• `)
    .replace(/\n• \s*/g, "\n• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── PLATITUDES ───────────────────────────────────────────────────────────────────────────────
// Advice so general it could go to a stranger: "listen to your body", "stay hydrated", "take it
// one day at a time", "you've got this". Any ONE of these can be honest — a hydration question
// deserves a hydration answer. TWO in one reply means nothing in it came from this client's data,
// which is exactly what "it's generic, it's a bot" has meant every time it has been said here.
//
// Constitution Law 3 already requires the opposite: "Remember the person, not the message —
// reference who they are and where they are." The model agreed and then wrote "keep drinking
// water" to a man with twenty years of training behind him. Same story as the numbered list:
// the law was real, the enforcement was not.
//
// ONE OWNER (2026-07-29). The audit scanner needs this list to COUNT platitudes and hygiene
// needs it to REMOVE them. Two copies of one idea is the defect this whole day has been about,
// so it is defined here and imported there.
export const PLATITUDES: RegExp[] = [
  /\blisten to your body\b/i,
  /\b(?:stay hydrated|drink (?:plenty of|more|lots of) water|keep drinking water|hydration is key)\b/i,
  /\btake it (?:one (?:day|step) at a time|slow|easy)\b/i,
  /\byou'?re not alone\b/i,
  /\byou'?(?:ve| have) got this\b/i,
  /\bbe (?:kind|gentle) (?:to|with) yourself\b/i,
  /\b(?:gentle movement|light stretching|gentle stretches)\b/i,
  /\bdon'?t (?:rush|push too hard|overdo it)\b/i,
  /\bget (?:enough|plenty of) (?:rest|sleep)\b/i,
  /\blet me know how you feel\b/i,
];

/** How many pieces of stranger-advice are in this reply. Two or more is the defect threshold. */
export function platitudeCount(text: string): number {
  return PLATITUDES.filter(re => re.test(text || "")).length;
}

/**
 * Remove platitude SENTENCES — but only once a reply has two or more, so a single honest
 * "drink plenty of water" survives in an answer that is genuinely about water.
 *
 * This makes a generic reply shorter and less bot-like. It does NOT make it personal: only the
 * engine using the client's real snapshot can do that. Removing what is empty is worth doing on
 * its own, and pretending it is the whole fix would be the same overreach as every prompt line
 * that told the model to be specific and was ignored.
 */
export function stripPlatitudes(text: string): string {
  if (platitudeCount(text) < 2) return text || "";
  return dropSentences(text, new RegExp(PLATITUDES.map(r => r.source).join("|"), "i"));
}

// The full humanize pass — strip stalls AND corporate filler in one go. This is what
// sanitizeCoachReply calls, so every AI reply gets to the point like a real coach.
export function humanizeReply(text: string): string {
  return normaliseBullets(stripPlatitudes(reshapeNumberedList(stripFiller(stripDeadPromises(text)))));
}

/**
 * A bullet always starts a line. Removing a platitude can take the line break before the NEXT
 * bullet with it, which left "…recovering from the illness. • *Ease Back In:*" running inline —
 * the same unreadability the reshape exists to prevent, reintroduced by a later step.
 */
function normaliseBullets(text: string): string {
  return (text || "").replace(/([^\n])[ \t]*• /g, "$1\n• ").replace(/\n{3,}/g, "\n\n").trim();
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
  return dropSentences(text, new RegExp(`${VOICE_DENIAL_RE.source}|${ASK_TO_REPEAT_RE.source}`, "i"));
}

/** True if the reply denies a voice note we demonstrably received (for guards and the auditor). */
export function deniesVoiceNote(text: string): boolean {
  return VOICE_DENIAL_RE.test(text || "") || ASK_TO_REPEAT_RE.test(text || "");
}

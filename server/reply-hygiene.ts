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
/**
 * [sentence, separator, sentence, separator, …] — separators preserved so a caller can drop or
 * REPLACE one sentence without reformatting the reply around it. Exported because the provenance
 * gate rewrites individual sentences and must split them exactly the way this file does; a second
 * splitter would eventually disagree with this one about where a sentence ends.
 */
export function splitSentences(text: string): string[] {
  return (text || "").trim().split(/(?<=[.!?])(\s+)/);
}

function dropSentences(text: string, re: RegExp): string {
  const t = (text || "").trim();
  if (!t) return "";
  const parts = splitSentences(t); // [sentence, sep, sentence, sep, …]
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

export function isHoldReply(text: string): boolean {
  return /not going to call a trend off those weigh-ins|not going to put a number on it|last weigh-in is too far back|don't have enough weigh-ins yet/i.test(text || "");
}

export function withNextMove(reply: string, todo: string): string {
  const t = (reply || "").trim();
  if (isHoldReply(t)) return reply;
  const move = (todo || "").trim().replace(/[.\s]*$/, "");
  if (!move || ownsNextAction(t)) return reply;
  return `${t}\n\n${move}.`;
}

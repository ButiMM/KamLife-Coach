/**
 * REACTION GUARD — telling "annoyed at the coach" apart from "struggling in life".
 *
 * (2026-07-27 live thread.) A client answered two bad replies with "Wow" and then
 * "Jesus" and got therapy-speak back — a paragraph about feeling overwhelmed and being
 * kind to himself. He was not overwhelmed. He was annoyed with the bot.
 *
 * The existing defence was a PROMPT instruction ("read the tone first…"), and the model
 * ignored it. The founder's response to that class of fix was blunt and correct: "can you
 * keep giving me rules on rules on rules? It doesn't work." So this is enforced in code.
 *
 * The deterministic insight: a message that is ONLY an exclamation carries no information
 * about the client's life. There is nothing in "Wow" to be overwhelmed ABOUT. It can only
 * be a reaction to the message the coach just sent. Therefore emotional-support language
 * in reply to a bare reaction is always wrong, and we can reject it without guessing.
 *
 * Pure — no DB, no clock, no model. Unit-tested.
 */

/** Filler that carries no content — stripped before deciding a message is "bare". */
const FILLER = /^[\s.!?,]+|[\s.!?,]+$/g;

// Exclamations that are pure reaction. "Jesus"/"Christ" belong here: as a lone word they
// are never a religious statement and never a life disclosure — they are exasperation.
const BARE_REACTION = new Set([
  "wow", "woww", "wowww", "wow wow",
  "jesus", "jesus christ", "christ", "jeez", "geez",
  "omg", "o m g", "oh my god", "oh my word", "my god", "good god", "oh god",
  "eish", "yoh", "yho", "yhoh", "haibo", "hayibo", "hawu", "shem", "ai", "aish",
  "seriously", "really", "for real", "come on", "man", "sies",
  "wtf", "wth", "ffs", "smh", "lol", "lmao", "ugh", "argh", "agh", "aggg",
  "unbelievable", "ridiculous", "nonsense", "rubbish",
]);

/**
 * Is this message ONLY a reaction — no request, no disclosure, no content? Emoji-only and
 * punctuation-only messages count: they are reactions to the previous turn by definition.
 */
export function isBareReaction(message: string): boolean {
  const raw = (message || "").trim();
  if (!raw) return false;
  if (raw.length > 40) return false;

  const stripped = raw.replace(FILLER, "").toLowerCase().replace(/\s+/g, " ");
  if (!stripped) return true;                       // "!!!!", "???", "..."
  if (BARE_REACTION.has(stripped)) return true;

  // Emoji-only (no letters, no digits) — 🙄, 😐, 🤦‍♂️
  if (!/[a-z0-9]/i.test(stripped)) return true;

  // Repeated-letter variants of the same words: "wowwww", "eishhh", "ughhhh"
  const collapsed = stripped.replace(/(.)\1{1,}/g, "$1");
  return BARE_REACTION.has(collapsed);
}

/** Live 10:06 2026-08-23: "WOW" came back as a diagnostic question about an event that never happened. */
export function isDiagnosticQuestion(reply: string): boolean {
  return /^\s*what happened\??(?:\s*tell me\.?)?\s*$/i.test(reply || "");
}

// Emotion-labelling and wellness language. Every one of these is the model diagnosing a
// feeling instead of answering — the exact register that made the live thread worse.
const THERAPY_SPEAK = [
  /\byou(?:'re| are)\s+(?:feeling|clearly|obviously|understandably)\s+\w+/i,
  /\bit\s+sounds\s+like\s+you\b/i,
  /\bi\s+(?:hear|sense|can\s+tell|understand)\s+(?:you|your|that)\b/i,
  /\b(?:feeling|feel)\s+(?:overwhelmed|frustrated|discouraged|defeated|down|low|stuck)\b/i,
  /\bthat(?:'s| is)\s+(?:completely\s+|totally\s+|perfectly\s+)?(?:valid|understandable|okay|normal\s+to\s+feel)\b/i,
  /\bbe\s+(?:kind|gentle)\s+(?:to|with)\s+yourself\b/i,
  /\btake\s+(?:a\s+)?(?:deep\s+breath|it\s+easy\s+on\s+yourself)\b/i,
  /\b(?:self.?care|wellness\s+journey|your\s+journey|small\s+steps|one\s+day\s+at\s+a\s+time)\b/i,
  /\bit(?:'s| is)\s+okay\s+to\s+(?:feel|not)\b/i,
  /\byou(?:'re| are)\s+not\s+alone\b/i,
  /\bhere\s+(?:for\s+you|to\s+support\s+you)\b/i,
  /\bno\s+pressure\b/i,
];

/** Does this reply diagnose a feeling instead of answering? */
export function readsAsTherapySpeak(reply: string): boolean {
  const r = reply || "";
  return THERAPY_SPEAK.some(re => re.test(r));
}

/**
 * What the coach should say instead. A bare reaction means the last reply missed — so
 * own it in one line and give one concrete thing to type. Never a feelings diagnosis,
 * never a topic pivot, never "what do you mean".
 */
export function bareReactionFallback(firstName = ""): string {
  const fn = firstName ? `${firstName}, ` : "";
  return `${fn}that reply missed the mark. Tell me in one line what you actually needed and I'll get it right.\n\nOr type *menu* for your options.`;
}

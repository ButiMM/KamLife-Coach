/**
 * REACTION GUARD — telling "annoyed at the coach" apart from "struggling in life".
 *
 * A message that is only a reaction carries no new life information. It should never be
 * routed into diagnostic/therapy language just because the model cannot tell whether the
 * client is impressed, frustrated, or shocked.
 */

/** Filler that carries no content — stripped before deciding a message is "bare". */
const FILLER = /^[\s.!?,\u2755\u2757\u203c\ufe0f]+|[\s.!?,\u2755\u2757\u203c\ufe0f]+$/gu;

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
 * Is this message ONLY a reaction — no request, no disclosure, no content?
 * Emoji-only and punctuation-only messages count: they are reactions to the previous turn.
 */
export function isBareReaction(message: string): boolean {
  const raw = (message || "").trim();
  if (!raw) return false;
  if (raw.length > 40) return false;

  const stripped = raw
    .replace(FILLER, "")
    .toLowerCase()
    // Variation selectors and emoji skin-tone/joiner controls are not user words.
    .replace(/[\u200d\ufe0f\u{1f3fb}-\u{1f3ff}]/gu, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

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
 * own it in one line and keep the door open. Never diagnose their feeling and never turn
 * a reaction into a support-ticket workflow.
 */
export function bareReactionFallback(firstName = ""): string {
  const fn = firstName ? `${firstName}, ` : "";
  return `${fn}got you. I'm here.`;
}

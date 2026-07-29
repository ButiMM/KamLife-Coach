/**
 * VOICE LANGUAGE — which South African language is this client actually speaking?
 *
 * Whisper returns a language code, but it is unreliable on short code-switched notes, which is
 * most of them here: a Johannesburg client opens in Zulu, gives the meal in English, and closes
 * in Afrikaans. So the transcript is checked for the everyday words people genuinely use, and
 * the result becomes a note to the coach — respond in simple SA English, but hear them.
 *
 * Extracted from handlers/media.ts (2026-07-29) when that file hit its size budget. It was
 * always a self-contained rule sitting inside a 1550-line handler, and out here it is pure and
 * testable instead of only reachable by sending audio.
 */

const NOTE = (lang: string, extra = "") =>
  `The client is communicating in ${lang}. Respond in simple SA English but acknowledge their language naturally${extra}.`;

/** Ordered — the first match wins, so distinctive greetings sit before shared vocabulary. */
const LANGUAGES: Array<{ words: string[]; note: string }> = [
  { words: ["sawubona", "yebo", "ngiyabonga", "unjani", "siyabonga", "hawu", "eish", "askies", "ngicela", "ngifuna"], note: NOTE("Zulu", " — you may use a word or two of Zulu") },
  { words: ["dumela", "ke a leboga", "o kae", "kea leboha", "ntate", "mme", "ke kopa", "ke batla"], note: NOTE("Sesotho") },
  { words: ["molo", "enkosi", "unjani", "ewe", "hayi", "camagu", "ndiyabona", "ndicela", "ndifuna"], note: NOTE("Xhosa") },
  { words: ["go siame", "ke a leboga", "rra", "lo kae", "ke tsile", "ke kopa", "thobela", "pula"], note: NOTE("Setswana") },
  { words: ["avuxeni", "nkhensa", "ndza khensa", "hi kona", "ndzi lava", "ndzi kopa", "swinene"], note: NOTE("Xitsonga") },
  { words: ["dankie", "asseblief", "môre", "more", "lekker", "baie", "nee", "ja nee", "ag nee", "eina", "ek is", "ek het"], note: NOTE("Afrikaans", " — you may use a word or two of Afrikaans") },
];

/** The coaching note for a transcript, or "" when it reads as plain English. */
export function detectVoiceLanguageNote(transcript: string): string {
  const s = (transcript || "").toLowerCase();
  if (!s.trim()) return "";
  return LANGUAGES.find(l => l.words.some(w => s.includes(w)))?.note || "";
}

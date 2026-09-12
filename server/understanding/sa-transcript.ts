/**
 * SA-English transcript cleaner (blueprint safeguard D).
 *
 * Our clients are voice-first and code-switch ("Yoh, I'm feeling mos kak today, neh?")
 * and use local food words STT mangles ("samp" → "stamp", "morogo", "pap"). One bad
 * transcript poisons the whole reply — a real client said "samp", the system heard
 * "stamp and chicken fingers", and the coach lectured her on food she never mentioned.
 *
 * This sits BETWEEN transcription and the coach: a cheap model repairs SA slang, local
 * food words, and obvious phonetic mishears while preserving meaning, emotion, and
 * profanity. It never answers, summarizes, or changes intent. Fail-open (returns the raw
 * transcript on any error/offline) and killswitch-able (SA_CLEAN=off).
 */

import type OpenAI from "openai";
import { assertAiOnline, isAiOfflineError } from "../ai-offline";
import { recordGptCost } from "../gpt";
import { looksLikeRefusal } from "./refusal";
export { looksLikeRefusal } from "./refusal";

const SA_CLEAN_SYSTEM = `You clean South African English voice-note transcripts before a coach reads them. The speaker is an ordinary South African (often a low-literacy, first-language-not-English client) talking about food, training, and how they feel.

Fix ONLY:
- SA slang/emphasis: mos, neh, yoh, eish, lekker, sharp, sho, shame, ag, hey (keep them, spell them right).
- SA food words STT commonly mangles: samp (NOT "stamp"), morogo, pap, pilchards, chakalaka, vetkoek, umngqusho, kota, mageu/maas, wors, boerewors, umqombothi, magwinya, mngqusho, samp and beans.
- obvious phonetic mishears where the intended word is clear from context.

KEEP everything else exactly: the meaning, the emotion, any anger or profanity, the first-person voice, the length. Do NOT add words, do NOT summarize, do NOT answer, do NOT change what they meant. If the transcript is already clean, return it unchanged.

Return ONLY the cleaned transcript text — no quotes, no notes.`;

function killswitchOff(): boolean {
  return process.env.SA_CLEAN === "off";
}

// A faithful clean keeps most of the speaker's own words (it fixes a handful). If the
// output shares almost nothing with the input, the model went off-script — reject it.
function retainsOriginal(raw: string, cleaned: string): boolean {
  const words = (s: string) => new Set((s.toLowerCase().match(/[a-z']{3,}/g) || []));
  const orig = words(raw);
  if (orig.size < 6) return true; // too short to judge overlap — trust the length guard
  const out = words(cleaned);
  let kept = 0;
  for (const w of orig) if (out.has(w)) kept++;
  return kept / orig.size >= 0.4; // at least 40% of the original words survive a real clean
}

/**
 * THE CLEANER'S WINDOW IS A WINDOW, NOT A LIMIT ON WHAT THE CLIENT SAID (Cut 3, 2026-09-12).
 *
 * `text.slice(0, 1500)` went to the model and the model's answer came back as THE TRANSCRIPT.
 * Everything past 1,500 characters was deleted — not flagged, not truncated visibly, deleted,
 * before a single handler or whole-transcript guard ever saw it.
 *
 * Measured on 017efd9 with a 2,408-character note (500 words, about three minutes of speech):
 *
 *     handed to the model   1500 chars
 *     returned as "the transcript"   1500 chars
 *     SILENTLY DELETED       908 chars   — the workout correction, BOTH questions, and the
 *                                          last thing they said before hanging up
 *
 * The client asked two questions and got a coach who had never received either of them.
 *
 * So the window now applies to what is SENT, and the rest is carried through untouched. The order
 * permits exactly this: preserve the portion beyond the window unchanged if it cannot safely be
 * cleaned. The tail keeps whatever STT gave us — imperfect, and present, which beats perfect and
 * gone. No second model call, no chunking loop, no new owner.
 */
const CLEAN_WINDOW = 1500;

/**
 * Split so the window never cuts a word in half. A sentence boundary is preferred; any space
 * will do; the hard index is the last resort. The tail keeps its leading whitespace, so
 * `cleanedHead + tail` rejoins exactly where the original was separated.
 */
export function splitForClean(text: string): { head: string; tail: string } {
  if (text.length <= CLEAN_WINDOW) return { head: text, tail: "" };
  const window = text.slice(0, CLEAN_WINDOW);
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  // Only trust a sentence end in the back half — an early full stop would send a fragment and
  // carry most of the note through uncleaned for no reason.
  const at = sentence > CLEAN_WINDOW * 0.5 ? sentence + 1 : window.lastIndexOf(" ");
  return at > 0 ? { head: text.slice(0, at), tail: text.slice(at) } : { head: window, tail: text.slice(CLEAN_WINDOW) };
}

/**
 * Returns a cleaned transcript, or the original on any failure. Never throws.
 * Skips trivially short input (nothing to fix) to save a call.
 */
export async function cleanSATranscript(openai: OpenAI, raw: string, userId?: string | null): Promise<string> {
  const text = (raw || "").trim();
  if (killswitchOff() || text.length < 4) return raw;
  const { head, tail } = splitForClean(text);
  try {
    assertAiOnline("sa_clean");
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: Math.min(500, Math.ceil(head.length / 2) + 80),
      messages: [
        { role: "system", content: SA_CLEAN_SYSTEM },
        { role: "user", content: head },
      ],
    });
    recordGptCost({
      userId: userId ?? null,
      model: "gpt-4o-mini",
      feature: "sa_transcript_clean",
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      completionTokens: resp.usage?.completion_tokens ?? 0,
    });
    const cleaned = (resp.choices[0]?.message?.content || "").trim();
    // Keep the ORIGINAL unless the output is a faithful light clean of THE HEAD. Reject: empty, a
    // runaway rewrite (added content), a refusal / model talking back, or a rewrite that
    // dropped most of the speaker's own words. Any of these → the raw transcript wins.
    //
    // GRADED AGAINST THE HEAD, NOT THE WHOLE TEXT, and that is a correction as well as a
    // consequence. `retainsOriginal(text, cleaned)` compared the FULL transcript against a clean
    // of its first 1,500 characters, so on a long note it was asking whether a fragment resembled
    // the whole — a test that a truncation passes comfortably. It could never have caught the
    // deletion above; it was measuring the wrong pair.
    //
    // THE LOWER BOUND IS NEW. There was a ceiling on the output length and no floor, so a reply cut
    // off by max_tokens came back as the transcript with its own middle missing. Half the head is
    // far below any honest clean (the prompt says keep the length) and far above a rounding error.
    if (!cleaned
      || cleaned.length > head.length * 1.8 + 40
      || cleaned.length < head.length * 0.5
      || looksLikeRefusal(cleaned)
      || !retainsOriginal(head, cleaned)) {
      if (looksLikeRefusal(cleaned)) console.warn("[SA_CLEAN] model refused — keeping raw transcript");
      return raw;
    }
    if (tail) console.log(`[SA_CLEAN] cleaned ${head.length} chars, carried ${tail.length} through unchanged`);
    return cleaned + tail;
  } catch (e) {
    if (!isAiOfflineError(e)) console.warn("[SA_CLEAN] failed (using raw transcript):", (e as any)?.message || e);
    return raw;
  }
}

// ── THE CONDENSER IS GONE (Cut 3, 2026-09-12) ────────────────────────────────────────────────
//
// `condenseVoiceRamble` and its prompt stood here. It took a long note and returned a model's
// shorter retelling, and media.ts routed THAT to the handlers — so the retelling was the client's
// words as far as anything downstream could tell. It also carried the same defect as the cleaner
// above, one window wider: `text.slice(0, 4000)` in, the answer out as the whole message.
// Measured on 017efd9 with a 4,141-character note that passes every guard: 141 characters gone,
// final marker included.
//
// IT COULD NOT BE KEPT AS AN AID. There is exactly one routed string; a condensation offered
// "alongside" the transcript would be a second version of what the client said, which is a second
// authority over the same question — the thing this rescue exists to remove. So it may not replace
// the transcript, and there is nowhere else for it to go.
//
// WHAT IS PAID FOR THIS: a three-minute note now reaches the coaching model in full. That is a
// real token cost on the longest notes, and it is the founder's trade to revisit — the alternative
// on offer was a client asking two questions and being answered by a coach that received neither.
//
// transcriptMustPassWhole / transcriptIsLogList / isMessyLifeTranscript in server/utils.ts were
// this function's gate and went with it. A predicate whose only possible answer is "no, do not
// shorten this" is not a guard; the reachability governor says so too, and it is right. Their
// assertions are inverted in unit-tests and gap-tests rather than deleted.

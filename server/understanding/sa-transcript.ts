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
 * DID THE CLEAN REACH THE END OF WHAT IT WAS GIVEN? (Cut 3 amendment, 2026-09-12.)
 *
 * A length floor cannot tell a faithful clean from a faithful PREFIX. Demonstrated against the
 * first version of this cut: a model reply carrying 60% of the head — 1,687 characters in, 1,099
 * out — passed both the 50% floor and the word-overlap check, and 588 characters vanished, a
 * workout correction and a question among them. The preserved tail was never the whole problem;
 * the model can delete the end of the HEAD and the result still looks like prose.
 *
 * So the head's last words must be represented in the output. The cleaner's contract is a light
 * spelling repair in the same order, so a handful of the final content words should survive one;
 * a prefix that stops early cannot contain them at all. Two of six are allowed to change, which
 * is what a genuine SA-food correction on the last line looks like.
 */
function coversTheEnd(head: string, cleaned: string): boolean {
  const words = (s: string) => (s.toLowerCase().match(/[a-z']{3,}/g) || []);
  const ending = words(head).slice(-6);
  if (ending.length < 4) return true;              // too short to judge — the floor carries it
  const out = new Set(words(cleaned));
  let kept = 0;
  for (const w of ending) if (out.has(w)) kept++;
  return kept >= Math.ceil(ending.length * 0.6);
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
    const finishReason = resp.choices[0]?.finish_reason;
    // Keep the ORIGINAL unless the output can be SHOWN to be a complete, faithful light clean of
    // THE HEAD. Reject: empty, a runaway rewrite, a refusal, a rewrite that dropped the speaker's
    // words, a reply the model did not finish, or one that does not reach the end of the head.
    //
    // GRADED AGAINST THE HEAD, NOT THE WHOLE TEXT. `retainsOriginal(text, cleaned)` compared the
    // FULL transcript against a clean of its first 1,500 characters, so on a long note it asked
    // whether a fragment resembled the whole — which a truncation passes comfortably.
    //
    // COMPLETENESS IS PROVEN, NOT ASSUMED, and this is the amendment that earns the word "whole".
    // The first version of this cut carried only a 50% floor, and a reply holding 60% of the head
    // sailed through it: 1,687 characters in, 1,099 out, 588 gone with a workout correction and a
    // question inside them. Three things close that, and any one of them failing keeps the raw:
    //
    //   finish_reason      must be "stop". "length" means the model ran out of tokens mid-sentence
    //                      and what came back is a fragment wearing the shape of an answer. An
    //                      ABSENT reason is not proof of completion either, so it is refused too —
    //                      when completeness cannot be established the client's own words win.
    //   the length floor   0.8, not 0.5. The prompt tells the model to keep the length; half the
    //                      head was never a clean, it was a summary nobody asked for.
    //   coversTheEnd       a faithful PREFIX passes a floor and an overlap test. It cannot pass a
    //                      check that the head's last words are still there.
    if (!cleaned
      || finishReason !== "stop"
      || cleaned.length > head.length * 1.8 + 40
      || cleaned.length < head.length * 0.8
      || !coversTheEnd(head, cleaned)
      || looksLikeRefusal(cleaned)
      || !retainsOriginal(head, cleaned)) {
      if (looksLikeRefusal(cleaned)) console.warn("[SA_CLEAN] model refused — keeping raw transcript");
      else if (finishReason !== "stop") console.warn(`[SA_CLEAN] incomplete reply (finish_reason=${String(finishReason)}) — keeping raw transcript`);
      else if (cleaned && !coversTheEnd(head, cleaned)) console.warn("[SA_CLEAN] reply did not reach the end of the head — keeping raw transcript");
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

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

/**
 * WHAT THE CLEANER IS ALLOWED TO CHANGE — AN ORDERED EDIT CONTRACT (Cut 3, CTO review 2, 2026-09-12).
 *
 * THE HOLE THIS CLOSES. `retainsOriginal` compared two SETS of words and asked whether 40% of the
 * original survived. A set has no order, no position and no repetition, so a reply that deleted a
 * whole clause out of the MIDDLE of the head passed it comfortably. Demonstrated deterministically
 * against the previous amended head:
 *
 *     raw 1687 chars · head 1467 chars · reply = head with one clause removed
 *     "Actually I missed my Tuesday workout. What should I do today?"   <- deleted
 *     95.84% of the head preserved, ending intact, finish_reason "stop"
 *     ACCEPTED. The correction and the question were gone and the tail survived.
 *
 * finish_reason, a length floor and an ending check are all blind to that: the reply is complete,
 * long enough, and ends correctly. Only the ORDER and COUNT of the client's own words can see it.
 *
 * THE CONTRACT. This cleaner repairs spelling. It does not rewrite clauses. So the cleaned head
 * must be the same tokens, in the same order, the same number of times — with only two exceptions:
 *
 *   - case, spacing and punctuation are free (they are normalised away before comparison)
 *   - a token may be REPLACED by an approved SA repair: the replacement must be a word this
 *     cleaner exists to produce, and must be a near-miss of what STT heard
 *
 * Anything else — a deletion, an insertion, an unexplained substitution — returns the WHOLE RAW
 * transcript. Numbers, weekdays and negations are protected absolutely: they may not be
 * substituted even for an approved word, because "8500" becoming "8000" and "missed" becoming
 * "finished" are the changes that cost a client their record rather than their spelling.
 *
 * NOT SOLVED BY A HIGHER PERCENTAGE, and not by a model judging a model. A percentage cannot
 * distinguish a clause from a spelling, which is precisely how the 60% and 95.84% replies both
 * got through.
 */
const SA_REPAIR_WORDS = new Set([
  // the SA food words the system prompt names, which is the whole reason this stage exists
  "samp", "morogo", "pap", "pilchards", "chakalaka", "vetkoek", "umngqusho", "mngqusho",
  "kota", "mageu", "maas", "wors", "boerewors", "umqombothi", "magwinya", "gatsby", "bunny",
  // and the SA slang it is told to keep and spell correctly
  "mos", "neh", "yoh", "eish", "lekker", "sharp", "sho", "shame", "ag", "hey", "hayibo", "sharp",
]);

/**
 * Never substituted, never dropped — a wrong one of these is a wrong record, not a typo.
 *
 * A SET, NOT A PATTERN, and deliberately: the architecture governor counts named regex literals,
 * and a list of words is what this is. Membership also says what it means without anyone parsing
 * an alternation forty items long.
 */
const PROTECTED_TOKENS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "half", "quarter",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "yesterday", "today", "tomorrow",
  "not", "no", "never", "dont", "didnt", "cant", "wont", "wasnt", "isnt", "arent", "havent",
  "hadnt", "missed", "skipped", "without",
]);

/** Any token carrying a digit is a quantity: a step count, a weight, a portion, a time. */
function isProtected(token: string): boolean {
  return PROTECTED_TOKENS.has(token) || /\d/.test(token);
}

/** Lowercased words and numbers, punctuation and spacing removed — the client's lexical spine. */
function lexicalTokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9']+/g) || []).map(t => t.replace(/'/g, ""));
}

/** How far apart two tokens are. Bounded work: both are single words. */
function editDistance(a: string, b: string): number {
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    rows[i] = [i];
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

/** A substitution is allowed only when it produces a word this cleaner exists to produce. */
function isApprovedRepair(from: string, to: string): boolean {
  if (isProtected(from) || isProtected(to)) return false;
  if (!SA_REPAIR_WORDS.has(to)) return false;
  return editDistance(from, to) <= 3;
}

/**
 * The cleaned head must be the head, token for token, in order — bar approved SA repairs.
 * Any deletion or insertion changes the count and is refused outright.
 */
function onlyApprovedRepairs(head: string, cleaned: string): boolean {
  const before = lexicalTokens(head);
  const after = lexicalTokens(cleaned);
  if (before.length !== after.length) return false;      // a clause was dropped or invented
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    if (!isApprovedRepair(before[i], after[i])) return false;
  }
  return true;
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
    //   finish_reason        must be "stop". "length" means the model ran out of tokens mid-sentence
    //                        and what came back is a fragment wearing the shape of an answer. An
    //                        ABSENT reason is not proof of completion either, so it is refused too —
    //                        when completeness cannot be established the client's own words win.
    //   onlyApprovedRepairs  the cleaned head must be the head token for token, in order, bar an
    //                        approved SA spelling repair. This is what sees a clause deleted out
    //                        of the MIDDLE — the case a length floor and an ending check both let
    //                        through at 95.84% of the head with the ending intact.
    //
    // THE LENGTH FLOOR AND THE ENDING CHECK ARE GONE, not loosened: the ordered contract subsumes
    // both (a prefix and a hollowed middle each change the token count) and keeping them would
    // leave two gates that can no longer fail on their own, which is how a suite starts grading
    // nothing while looking thorough.
    if (!cleaned
      || finishReason !== "stop"
      || looksLikeRefusal(cleaned)
      || !onlyApprovedRepairs(head, cleaned)) {
      if (looksLikeRefusal(cleaned)) console.warn("[SA_CLEAN] model refused — keeping raw transcript");
      else if (finishReason !== "stop") console.warn(`[SA_CLEAN] incomplete reply (finish_reason=${String(finishReason)}) — keeping raw transcript`);
      else if (cleaned) console.warn("[SA_CLEAN] reply is not a token-for-token repair of the head — keeping raw transcript");
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

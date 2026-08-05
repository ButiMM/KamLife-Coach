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
import { transcriptIsLogList } from "../utils";
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
 * Returns a cleaned transcript, or the original on any failure. Never throws.
 * Skips trivially short input (nothing to fix) to save a call.
 */
export async function cleanSATranscript(openai: OpenAI, raw: string, userId?: string | null): Promise<string> {
  const text = (raw || "").trim();
  if (killswitchOff() || text.length < 4) return raw;
  try {
    assertAiOnline("sa_clean");
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: Math.min(500, Math.ceil(text.length / 2) + 80),
      messages: [
        { role: "system", content: SA_CLEAN_SYSTEM },
        { role: "user", content: text.slice(0, 1500) },
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
    // Keep the ORIGINAL unless the output is a faithful light clean. Reject: empty, a
    // runaway rewrite (added content), a refusal / model talking back, or a rewrite that
    // dropped most of the speaker's own words. Any of these → the raw transcript wins.
    if (!cleaned
      || cleaned.length > text.length * 1.8 + 40
      || looksLikeRefusal(cleaned)
      || !retainsOriginal(text, cleaned)) {
      if (looksLikeRefusal(cleaned)) console.warn("[SA_CLEAN] model refused — keeping raw transcript");
      return raw;
    }
    return cleaned;
  } catch (e) {
    if (!isAiOfflineError(e)) console.warn("[SA_CLEAN] failed (using raw transcript):", (e as any)?.message || e);
    return raw;
  }
}

const CONDENSE_SYSTEM = `You condense a LONG South African voice-note transcript into a short, clean first-person version a coach can act on. The speaker rambled; your job is to keep the SIGNAL and drop the noise.

KEEP, exactly as said:
- every food and its amount ("2 eggs and pap", "half a kota") — word-for-word, so it can be logged
- every number: steps, weight in kg, reps, sets, litres, days
- every exercise or training detail they mentioned
- their ONE main question or request
- if they clearly feel strongly (down, frustrated, proud), one short phrase saying so

DROP: repetition, filler, side-stories, thinking-out-loud, greetings.

Write it in the FIRST PERSON, plain, and as SHORT as it can be WITHOUT LOSING A SINGLE FOOD OR
NUMBER. If they listed eight things, the result has eight things in it — length is not the goal,
keeping their day is. Do NOT answer, do NOT coach, do NOT add anything they didn't say. Return
ONLY the condensed message.`;


/**
 * Condense a long, rambling voice transcript to its actionable core (mood, foods, numbers,
 * the real question) — the "summariser wedge". Protects the brain from a wall of rambling AND
 * the R199 margin from passing a 3-minute transcript to the big model. Only call this on a
 * genuine ramble (the caller gates on length); short notes should pass through untouched so a
 * quick food log is never reshaped. Fail-open: returns the raw transcript on any problem.
 */
export async function condenseVoiceRamble(openai: OpenAI, raw: string, userId?: string | null): Promise<string> {
  const text = (raw || "").trim();
  if (killswitchOff() || text.length < 200) return raw; // nothing to condense
  if (transcriptIsLogList(text)) {
    console.log(`[VOICE_CONDENSE] skipped — transcript is a log, not a ramble (${text.length} chars)`);
    return raw;
  }
  try {
    assertAiOnline("voice_condense");
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 400,   // a day's food does not fit in 220 — see transcriptIsLogList
      messages: [
        { role: "system", content: CONDENSE_SYSTEM },
        { role: "user", content: text.slice(0, 4000) },
      ],
    });
    recordGptCost({
      userId: userId ?? null,
      model: "gpt-4o-mini",
      feature: "voice_condense",
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      completionTokens: resp.usage?.completion_tokens ?? 0,
    });
    const out = (resp.choices[0]?.message?.content || "").trim();
    // Reject a bad condense (empty, a refusal, or somehow LONGER than the original) → keep raw.
    if (!out || out.length >= text.length || looksLikeRefusal(out)) return raw;
    return out;
  } catch (e) {
    if (!isAiOfflineError(e)) console.warn("[VOICE_CONDENSE] failed (using raw transcript):", (e as any)?.message || e);
    return raw;
  }
}

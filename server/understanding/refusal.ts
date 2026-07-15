/**
 * Refusal detection — a tiny, dependency-free guard used across the voice pipeline.
 *
 * A transcript is the CLIENT'S words. No upstream step (the SA cleaner, or any model in
 * the chain) may ever replace it with a model refusal ("I'm sorry, but I can't assist with
 * that") — that once got echoed back and coached on for every voice note. This lives on its
 * own so it can be unit-tested with no DB/OpenAI imports.
 *
 * PRECISION MATTERS: this must catch an assistant refusing the task WITHOUT catching a
 * client apologising about their own life ("sorry I can't make gym", "I can't do that
 * exercise", "I won't train this week"). So we require the true refusal TAIL — assist /
 * help with that-this / comply / process / transcribe / "as an AI" — never a bare "I'm
 * sorry but" or a bare "I can't <life thing>".
 */
const REFUSAL_RE = /\b(i (?:cannot|can'?t|am unable to|am not able to|won'?t|will not) (?:assist|help(?: you)? with (?:that|this)|comply|process (?:that|this)|transcribe|fulfill (?:that|this|your)|provide that)|i can'?t assist with (?:that|this)|(?:i'?m|i am) (?:just |only )?an ai\b|as an ai\b|unable to (?:assist|comply)|i (?:cannot|can'?t) provide (?:that|this|the requested)|here'?s the cleaned (?:transcript|version|text))/i;

export function looksLikeRefusal(s: string): boolean {
  return REFUSAL_RE.test((s || "").trim());
}

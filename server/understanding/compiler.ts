/**
 * Prompt Compiler (blueprint safeguard C).
 *
 * Renders UnderstandingState into a short natural-language blurb that gets injected
 * into the coach prompt — NOT the raw JSON. Two reasons:
 *  1. Margin: raw JSON of the full state is ~4-6x the tokens of a 30-word blurb, every
 *     message, forever. At R199 that matters. This step is deliberately DETERMINISTIC
 *     (zero model tokens) — it costs nothing to run.
 *  2. Signal: a model reads "she's frustrated and sick — she needs reassurance, not a
 *     push" far better than nested JSON. Prose in, better coaching out.
 *
 * Example output:
 *   "Bonolo's confidence has dropped lately. She's frustrated and sick right now —
 *    steer toward reassurance, not a push. Protein's been light; she's on a 3-day streak."
 */

import type { UnderstandingState } from "./state";

function firstName(name: string): string {
  const n = (name || "").trim().split(/\s+/)[0];
  return n || "They";
}

function moodClause(s: UnderstandingState): string {
  const bits: string[] = [];
  const { mood, healthStatus } = s.current;
  if (healthStatus === "sick") bits.push("sick right now");
  else if (healthStatus === "recovering") bits.push("recovering from being unwell");
  if (mood === "frustrated") bits.push("frustrated");
  else if (mood === "anxious") bits.push("anxious");
  else if (mood === "motivated") bits.push("motivated");
  else if (mood === "hopeful") bits.push("hopeful");
  return bits.join(" and ");
}

function steer(s: UnderstandingState): string {
  const { healthStatus } = s.current;
  const { readinessToPush, frustrationLevel } = s.observations;
  // Health always wins: never push a sick/recovering person.
  if (healthStatus === "sick" || healthStatus === "recovering") return "hold rest, lead with care — do not push training or steps";
  if (frustrationLevel >= 7) return "steer toward reassurance and one small win, not a push";
  if (readinessToPush === "high") return "they can take a real push today";
  if (readinessToPush === "low") return "go gentle — meet them where they are";
  return "encourage, keep it simple";
}

function trendClause(s: UnderstandingState): string {
  const t = s.observations.confidenceTrend;
  if (t === "falling") return "confidence has been slipping lately";
  if (t === "rising") return "confidence is building";
  return "";
}

function statsClause(s: UnderstandingState): string {
  const bits: string[] = [];
  if (s.stats.streak > 0) bits.push(`on a ${s.stats.streak}-day streak`);
  if (s.stats.weightDirection !== "stable") bits.push(`weight trending ${s.stats.weightDirection}`);
  return bits.join(", ");
}

/**
 * The compiled blurb — kept tight (~30-45 words). Empty-ish state yields a short line,
 * never noise. Never invents: only speaks to fields that carry real signal.
 */
export function compileStateBlurb(s: UnderstandingState): string {
  const who = firstName(s.profile.name);
  const parts: string[] = [];

  const trend = trendClause(s);
  const mood = moodClause(s);
  const openers: string[] = [];
  if (trend) openers.push(`${who}'s ${trend}`);
  if (mood) openers.push(openers.length ? `they're ${mood}` : `${who}'s ${mood}`);
  if (openers.length) parts.push(openers.join("; ") + ".");

  parts.push(`Right now, ${steer(s)}.`);

  const stats = statsClause(s);
  if (stats) parts.push(`They're ${stats}.`);

  if (s.profile.lifeStory) parts.push(s.profile.lifeStory.trim());

  const numbers = s.profile.preferences.numberFree
    ? "Keep it number-free — plain language, no calorie figures."
    : "";
  if (numbers) parts.push(numbers);

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * A compact key-facts line for the durable truths (injuries, job, family, goals) —
 * injected once so the coach never forgets what the client told it weeks ago.
 */
export function compileKeyFacts(s: UnderstandingState): string {
  const facts = (s.profile.keyFacts || []).filter(Boolean);
  if (facts.length === 0) return "";
  return `What you know about ${firstName(s.profile.name)}: ${facts.join("; ")}.`;
}

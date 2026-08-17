/**
 * Prompt Compiler (blueprint safeguard C).
 *
 * Renders UnderstandingState into a short natural-language blurb that gets injected
 * into the coach prompt — NOT the raw JSON. Deterministic and zero-cost.
 */

import { currentRuntimeDecision, type UnderstandingState } from "./state";

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

function patternsClause(s: UnderstandingState): string {
  const now = Date.now();
  const recent = (s.observations.learnedPatterns || [])
    .filter(p => p.confidence === "high" && (now - new Date(p.lastObserved).getTime()) <= 90 * 86_400_000)
    .slice(0, 2);
  if (!recent.length) return "";
  return `Recent coaching patterns (evidence-backed, not facts): ${recent.map(p => `${p.text} Evidence: ${p.evidence}`).join(" | ")}. Treat them as hypotheses, not guarantees.`;
}

export function compileStateBlurb(s: UnderstandingState): string {
  const who = firstName(s.profile.name);
  const parts: string[] = [];
  const trend = trendClause(s);
  const mood = moodClause(s);
  const openers: string[] = [];
  if (trend) openers.push(`${who}'s ${trend}`);
  if (mood) openers.push(openers.length ? `they're ${mood}` : `${who}'s ${mood}`);
  if (openers.length) parts.push(openers.join("; ") + ".");

  if (s.current.reentry.isReturning) {
    const days = s.current.reentry.daysSinceLastContact;
    if (days != null && days >= 2) {
      const gap = days === 2 ? "a couple of days" : `${days} days`;
      parts.push(`they're returning after ${gap} away — re-establish context from what they say now; do not pretend continuity.`);
    }
  }

  const decision = currentRuntimeDecision();
  if (decision) {
    if (decision.focus === "safety") parts.push("Primary coaching focus: safety/referral. Do not turn this into normal coaching.");
    else if (decision.focus === "hunger") parts.push("Primary coaching focus: hunger. Treat this as the one thing to investigate or act on; do not invent a second problem.");
    else if (decision.focus === "intake") parts.push("Primary coaching focus: intake/energy balance. Keep other observations in the background unless they change the next instruction.");
    else if (decision.state === "CONTINUE") parts.push("Primary coaching focus: no intervention. Protect the current plan unless the client gives new evidence that changes the decision.");
  }

  const patterns = patternsClause(s);
  if (patterns) parts.push(patterns);
  parts.push(`Right now, ${steer(s)}.`);

  const stats = statsClause(s);
  if (stats) parts.push(`They're ${stats}.`);
  if (s.profile.lifeStory) parts.push(s.profile.lifeStory.trim());
  if (s.profile.preferences.numberFree) parts.push("Keep it number-free — plain language, no calorie figures.");

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function compileKeyFacts(s: UnderstandingState): string {
  const facts = (s.profile.keyFacts || []).filter(Boolean);
  if (facts.length === 0) return "";
  return `What you know about ${firstName(s.profile.name)}: ${facts.join("; ")}.`;
}

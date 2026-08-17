/**
 * Canonical re-entry resolver.
 *
 * This module owns the meaning of "returning" at the conversation boundary.
 * It deliberately does NOT own the comeback reply, retention messaging, or protocol.
 * Those consumers should read this result instead of maintaining their own silence/return
 * definitions.
 *
 * Source of truth for contact age: users.lastActiveAt (the actual client contact clock),
 * not a secondary understanding-store write timestamp.
 */

export interface ReentryResolution {
  daysSinceLastContact: number | null;
  isReturning: boolean;
  hasExplicitReturnSignal: boolean;
  shouldHandleComeback: boolean;
}

const RETURN_SIGNAL = /\b(i.?m back|i am back|back now|returning|i.?ve been|been (busy|away|sick|off|struggling|stressed)|sorry (i|for|about)|haven.?t been|couldn.?t|wasn.?t able|let me start|can we start|starting again|picking up|back on track|back to it|resuming|fresh start|starting fresh|been (a|so) (long|while)|miss(ed)? (a|this|it)|been MIA|went quiet|disappeared|fell off|going through (a lot|it|stuff|things)|things (have been|been) (crazy|hectic|tough|hard|rough|mad)|life (got|gets?) (in the way|busy)|had a (rough|tough|hard) (week|month|time|period)|what did i miss|catch me up|where (was|did) i (leave off|stop)|been meaning to (come back|check in))\b/i;

const PROFILE_UPDATE = /\b(train(ing)?\s+(at|from|to)?\s*(home|gym)|home\s+workout|i\s+train|working\s+out\s+(at\s+)?home|joined.*gym|going.*gym|quit.*gym|no.*gym|left.*gym|change.*goal|my\s+goal\s+is|switch\s+to|new\s+goal|update.*goal|change.*training|training\s+days?)\b/i;

export function daysSinceContact(lastActiveAt: unknown, nowMs = Date.now()): number | null {
  if (!lastActiveAt) return null;
  const at = new Date(String(lastActiveAt)).getTime();
  if (!Number.isFinite(at) || at > nowMs) return null;
  return Math.max(0, Math.floor((nowMs - at) / 86_400_000));
}

export function isExplicitReturnSignal(message: string): boolean {
  return RETURN_SIGNAL.test(String(message || ""));
}

export function isProfileUpdateMessage(message: string): boolean {
  return PROFILE_UPDATE.test(String(message || ""));
}

export function resolveReentry(input: {
  lastActiveAt?: unknown;
  message: string;
  nowMs?: number;
}): ReentryResolution {
  const days = daysSinceContact(input.lastActiveAt, input.nowMs);
  const isReturning = days !== null && days >= 2;
  const hasExplicitReturnSignal = isExplicitReturnSignal(input.message);
  const shouldHandleComeback = isReturning && hasExplicitReturnSignal && !isProfileUpdateMessage(input.message);
  return { daysSinceLastContact: days, isReturning, hasExplicitReturnSignal, shouldHandleComeback };
}

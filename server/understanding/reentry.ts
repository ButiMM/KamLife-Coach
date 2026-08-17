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

/**
 * The gap at which a client counts as RETURNING. Lives here and nowhere else — this number was
 * previously written out in three separate places (early-commands, state.reentryFromAgeHours, and
 * resolveReentry below), which is how they could drift apart without anything failing.
 */
export const RETURNING_DAYS = 2;

/**
 * CONTACT AGE AS STATE — the message-free half of re-entry.
 *
 * Some consumers ask "is this client returning?" at a point where there is no client message to
 * read: `seedUnderstanding` builds the turn's prior from the user row alone. They still must not
 * re-derive the threshold, so the canonical owner exposes the answer in the shape they need rather
 * than handing out a number and trusting each caller to compare it correctly.
 *
 * Structurally identical to UnderstandingState's ReentryState, deliberately without importing it:
 * meaning belongs to this module, and the state container should depend on the meaning, not the
 * reverse.
 */
export function contactState(lastActiveAt: unknown, nowMs = Date.now()): {
  daysSinceLastContact: number | null;
  isReturning: boolean;
} {
  const days = daysSinceContact(lastActiveAt, nowMs);
  return { daysSinceLastContact: days, isReturning: days !== null && days >= RETURNING_DAYS };
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
  const { daysSinceLastContact: days, isReturning } = contactState(input.lastActiveAt, input.nowMs);
  const hasExplicitReturnSignal = isExplicitReturnSignal(input.message);
  const shouldHandleComeback = isReturning && hasExplicitReturnSignal && !isProfileUpdateMessage(input.message);
  return { daysSinceLastContact: days, isReturning, hasExplicitReturnSignal, shouldHandleComeback };
}

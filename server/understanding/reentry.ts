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
 *
 * DELIBERATELY NOT IN SCOPE, and this is a ruling rather than an oversight (2026-08-17).
 * scheduler/shared.ts:219 (canSendRoutineNudge) and scheduler/nudge-policy.ts compute their own
 * `daysSilent` from the same field. Those are NOT duplicates of this module and must not be
 * consolidated into it:
 *
 *   this module        "is this person RETURNING to a conversation?"   → one turn, one reply
 *   nudge policy       "should KamLife SEND something unprompted?"     → cost, cadence, fatigue
 *
 * They read one field to answer two different questions with different thresholds, different
 * consequences and different owners. Unifying them because both contain the token `daysSilent`
 * would be exactly the false consolidation this rebuild exists to stop — the nudge tiers exist to
 * halve message volume for a drifting client, which has nothing to do with what a returning client
 * should be told. Leave them where they are.
 */

import { sastDaysBetween } from "../sast";

export interface ReentryResolution {
  daysSinceLastContact: number | null;
  /**
   * The last DURABLE thing this client did — a meal, a workout, a step count — as SAST days ago,
   * or null when nothing is known. Distinct from contact: a client can execute without writing to
   * us, and can write to us without executing.
   */
  daysSinceLastExecution: number | null;
  /** Did they do ANYTHING durable during the silence — meal, workout or steps? */
  executedDuringAbsence: boolean;
  /**
   * Did they TRAIN during the silence? Deliberately separate from `executedDuringAbsence`: a
   * client who logged meals while quiet but whose last session predates the gap has engaged and
   * has NOT trained, and a coach that congratulates them on training tells them about a workout
   * they did not do. Any surface making a claim about sessions reads this one.
   */
  trainedDuringAbsence: boolean;
  isReturning: boolean;
  hasExplicitReturnSignal: boolean;
  shouldHandleComeback: boolean;
}

const RETURN_SIGNAL = /\b(i.?m back|i am back|back now|returning|i.?ve been|been (busy|away|sick|off|struggling|stressed)|sorry (i|for|about)|haven.?t been|couldn.?t|wasn.?t able|let me start|can we start|starting again|picking up|back on track|back to it|resuming|fresh start|starting fresh|been (a|so) (long|while)|miss(ed)? (a|this|it)|been MIA|went quiet|disappeared|fell off|going through (a lot|it|stuff|things)|things (have been|been) (crazy|hectic|tough|hard|rough|mad)|life (got|gets?) (in the way|busy)|had a (rough|tough|hard) (week|month|time|period)|what did i miss|catch me up|where (was|did) i (leave off|stop)|been meaning to (come back|check in))\b/i;

const PROFILE_UPDATE = /\b(train(ing)?\s+(at|from|to)?\s*(home|gym)|home\s+workout|i\s+train|working\s+out\s+(at\s+)?home|joined.*gym|going.*gym|quit.*gym|no.*gym|left.*gym|change.*goal|my\s+goal\s+is|switch\s+to|new\s+goal|update.*goal|change.*training|training\s+days?)\b/i;

/**
 * SAST CALENDAR DAYS, NOT ELAPSED MILLISECONDS (#221).
 *
 * This divided by 86_400_000, which counts 24-hour periods and not days. A client last seen at
 * 23:30 on Sunday who writes at 06:00 on Tuesday has been gone two SAST days and counted as one —
 * and because RETURNING_DAYS is 2, that did not merely misprint a number, it DENIED THEM THE
 * COMEBACK. Every evening-then-morning gap in the product lands on the wrong side of that
 * boundary, which is most of them: people go quiet at night and come back in the morning.
 *
 * `sastDaysBetween` is the existing owner of this question — day-ledger, one-action-command and
 * the outcomes audit all already count days through it. This module was the outlier holding a
 * second definition of what a day is.
 */
export function daysSinceContact(lastActiveAt: unknown, nowMs = Date.now()): number | null {
  const at = instantOf(lastActiveAt);
  if (at === null || at > nowMs) return null;
  return Math.max(0, sastDaysBetween(at, nowMs));
}

/**
 * A TIMESTAMP IS A TIMESTAMP (#221). This module did `new Date(String(x))`, which turns an epoch
 * number into the string "1757289600000" and then into an Invalid Date — so a caller holding
 * milliseconds got a silent `null`, read downstream as "we have never heard from them" rather than
 * as the number they actually passed. Date, ISO string and number all mean the same instant here.
 *
 * It is one function rather than a line inside `daysSinceContact` because the DAY AGE and the
 * ORDERING of two events are different questions asked of the same reading, and they must not
 * disagree about what a caller's value meant.
 */
function instantOf(at: unknown): number | null {
  if (!at) return null;
  const ms = typeof at === "number" ? at
    : at instanceof Date ? at.getTime()
    : new Date(String(at)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A durable row written BY the client's last turn lands within the same second as the contact
 * stamp that turn wrote, in no guaranteed order — the handlers set `lastActiveAt` in the same
 * update that files the log. Such a row is part of that conversation, not evidence of a silent
 * streak, so "after the last contact" means after it by more than one turn's width. The smallest
 * absence that can reach this code is two SAST days, so nothing real sits near this boundary.
 */
const SAME_TURN_MS = 5 * 60_000;

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

/**
 * LAST MEANINGFUL ENGAGEMENT, NOT LAST CONTACT (#221).
 *
 * `lastExecutionAt` is the newest durable thing the client actually DID — a meal, a workout, a
 * step count — read by the caller from the rows that already store it. It is not a new clock and
 * not a new store: it is the same evidence every other surface reads, finally reaching the one
 * place that decides how long someone has been gone.
 *
 * Traced on main@e81138e: a client trained on day 3 of a nine-day silence and said so on return.
 * The coach answered "about a week away" and filed that session under "the 14 days BEFORE you went
 * quiet". Both wrong from the same cause — the gap was measured from CONTACT alone, so the one
 * thing they did during the absence was invisible to the clock and mislabelled by the copy.
 *
 * The DECISION still keys off contact: someone who trained silently and has now written to us
 * after two days IS returning to the conversation, and should be greeted. What execution changes
 * is the TRUTH the greeting is built on — how long they were really gone, and whether they kept
 * going while they were quiet.
 */
export function resolveReentry(input: {
  lastActiveAt?: unknown;
  lastExecutionAt?: unknown;
  lastWorkoutAt?: unknown;
  message: string;
  nowMs?: number;
}): ReentryResolution {
  const nowMs = input.nowMs ?? Date.now();
  const { daysSinceLastContact: days, isReturning } = contactState(input.lastActiveAt, nowMs);
  const hasExplicitReturnSignal = isExplicitReturnSignal(input.message);
  const shouldHandleComeback = isReturning && hasExplicitReturnSignal && !isProfileUpdateMessage(input.message);
  const daysSinceLastExecution = daysSinceContact(input.lastExecutionAt, nowMs);

  // ORDERING IS BETWEEN INSTANTS; ONLY THE DISPLAYED AGE IS A DAY COUNT (#221 review).
  // This compared the two SAST day ages — `daysSinceLastExecution < days` — which cannot see
  // inside a day. A client who wrote on Sunday MORNING and trained on Sunday EVENING has both
  // events at the same age, so the evening session read as "not newer than contact" and was filed
  // under the time before the silence it actually happened in. Days are the right unit for telling
  // someone how long they were gone and the wrong one for asking which of two events came first.
  const contactAt = instantOf(input.lastActiveAt);
  const afterLastContact = (at: unknown) => {
    const ms = instantOf(at);
    return ms !== null && contactAt !== null && ms > contactAt + SAME_TURN_MS && ms <= nowMs;
  };
  const executedDuringAbsence = afterLastContact(input.lastExecutionAt);
  const trainedDuringAbsence = afterLastContact(input.lastWorkoutAt);

  return {
    daysSinceLastContact: days,
    daysSinceLastExecution,
    executedDuringAbsence,
    trainedDuringAbsence,
    isReturning,
    hasExplicitReturnSignal,
    shouldHandleComeback,
  };
}

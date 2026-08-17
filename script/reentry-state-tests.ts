import assert from "node:assert/strict";
import { defaultUnderstanding, reentryFromAgeHours } from "../server/understanding/state";
import { compileStateBlurb } from "../server/understanding/compiler";
import {
  daysSinceContact,
  isExplicitReturnSignal,
  isProfileUpdateMessage,
  resolveReentry,
} from "../server/understanding/reentry";

// Existing UnderstandingState boundary: 48 hours is the returning threshold.
assert.deepEqual(reentryFromAgeHours(0), { daysSinceLastContact: 0, isReturning: false });
assert.deepEqual(reentryFromAgeHours(47.99), { daysSinceLastContact: 1, isReturning: false });
assert.deepEqual(reentryFromAgeHours(48), { daysSinceLastContact: 2, isReturning: true });
assert.deepEqual(reentryFromAgeHours(240), { daysSinceLastContact: 10, isReturning: true });
assert.deepEqual(reentryFromAgeHours(240, false), { daysSinceLastContact: null, isReturning: false });
assert.deepEqual(reentryFromAgeHours(Number.NaN), { daysSinceLastContact: null, isReturning: false });

const fresh = defaultUnderstanding("Kam");
assert.doesNotMatch(compileStateBlurb(fresh), /returning after|re-establish context/i);

const returning = defaultUnderstanding("Kam");
returning.current.reentry = { daysSinceLastContact: 10, isReturning: true };
const blurb = compileStateBlurb(returning);
assert.match(blurb, /returning after 10 days away/i);
assert.match(blurb, /re-establish context/i);
assert.match(blurb, /do not pretend continuity/i);

// Canonical contact-clock owner: users.lastActiveAt, not understanding-store write time.
const now = Date.parse("2026-08-17T10:00:00.000Z");
assert.equal(daysSinceContact("2026-08-17T09:59:59.000Z", now), 0);
assert.equal(daysSinceContact("2026-08-15T10:00:00.000Z", now), 2);
assert.equal(daysSinceContact("2026-08-07T10:00:00.000Z", now), 10);
assert.equal(daysSinceContact(undefined, now), null);
assert.equal(daysSinceContact("not-a-date", now), null);
assert.equal(daysSinceContact("2026-08-18T10:00:00.000Z", now), null);

// Explicit comeback language is a signal; ordinary action messages are not.
assert.equal(isExplicitReturnSignal("I'm back"), true);
assert.equal(isExplicitReturnSignal("sorry I've been busy"), true);
assert.equal(isExplicitReturnSignal("starting fresh"), true);
assert.equal(isExplicitReturnSignal("what did I miss"), true);
assert.equal(isExplicitReturnSignal("workout"), false);
assert.equal(isExplicitReturnSignal("done"), false);
assert.equal(isExplicitReturnSignal("today"), false);
assert.equal(isExplicitReturnSignal("menu"), false);

// Profile changes are not comeback messages, even when they happen after a long gap.
assert.equal(isProfileUpdateMessage("I train at home now"), true);
assert.equal(isProfileUpdateMessage("switch to gym-based"), true);
assert.equal(isProfileUpdateMessage("change my training days"), true);
assert.equal(isProfileUpdateMessage("I'm back"), false);

assert.deepEqual(
  resolveReentry({ lastActiveAt: "2026-08-15T10:00:00.000Z", message: "I'm back", nowMs: now }),
  { daysSinceLastContact: 2, isReturning: true, hasExplicitReturnSignal: true, shouldHandleComeback: true },
);
assert.deepEqual(
  resolveReentry({ lastActiveAt: "2026-08-15T10:00:00.000Z", message: "workout", nowMs: now }),
  { daysSinceLastContact: 2, isReturning: true, hasExplicitReturnSignal: false, shouldHandleComeback: false },
);
assert.deepEqual(
  resolveReentry({ lastActiveAt: "2026-08-15T10:00:00.000Z", message: "I train at home now", nowMs: now }),
  { daysSinceLastContact: 2, isReturning: true, hasExplicitReturnSignal: false, shouldHandleComeback: false },
);
assert.deepEqual(
  resolveReentry({ lastActiveAt: "2026-08-17T09:00:00.000Z", message: "I'm back", nowMs: now }),
  { daysSinceLastContact: 0, isReturning: false, hasExplicitReturnSignal: true, shouldHandleComeback: false },
);

console.log("reentry-state-tests: 28/28 passed");

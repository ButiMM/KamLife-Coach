import assert from "node:assert/strict";
import { defaultUnderstanding } from "../server/understanding/state";
import { contactState, RETURNING_DAYS } from "../server/understanding/reentry";
import { compileStateBlurb } from "../server/understanding/compiler";
import {
  daysSinceContact,
  isExplicitReturnSignal,
  isProfileUpdateMessage,
  resolveReentry,
} from "../server/understanding/reentry";
import { resolveReentryForUser, shouldHandleComebackForUser } from "../server/understanding/reentry-bridge";

// Existing UnderstandingState boundary: 48 hours is the returning threshold.
// MIGRATED FROM reentryFromAgeHours (2026-08-17). Same six cases, same expectations, now against
// the canonical owner and driven by a TIMESTAMP rather than a pre-computed age in hours — because
// the age was the defect: it was derived from clientUnderstanding.updatedAt, a persistence clock.
// Verified equivalent before the old function was deleted: both agreed on all six, including the
// future-clock case, which reentryFromAgeHours caught via its `ageHours < 0` guard.
const NOW = Date.parse("2026-08-17T10:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

assert.equal(RETURNING_DAYS, 2, "the threshold must live in exactly one place");
assert.deepEqual(contactState(hoursAgo(0), NOW), { daysSinceLastContact: 0, isReturning: false });
assert.deepEqual(contactState(hoursAgo(47.99), NOW), { daysSinceLastContact: 1, isReturning: false });
assert.deepEqual(contactState(hoursAgo(48), NOW), { daysSinceLastContact: 2, isReturning: true });
assert.deepEqual(contactState(hoursAgo(240), NOW), { daysSinceLastContact: 10, isReturning: true });
assert.deepEqual(contactState(null, NOW), { daysSinceLastContact: null, isReturning: false });
assert.deepEqual(contactState("not-a-date", NOW), { daysSinceLastContact: null, isReturning: false });
// A FUTURE contact clock is UNKNOWN, never "here right now". state.ts clamps a stored negative to
// 0 via clampInt, so without this the wrong answer would read as "0 days since contact".
assert.deepEqual(contactState(hoursAgo(-24), NOW), { daysSinceLastContact: null, isReturning: false });

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

// Consumer boundary: callers receive the canonical result rather than duplicating the rules.
assert.equal(
  shouldHandleComebackForUser({ user: { lastActiveAt: "2026-08-15T10:00:00.000Z" }, message: "I'm back", nowMs: now }),
  true,
);
assert.equal(
  shouldHandleComebackForUser({ user: { lastActiveAt: "2026-08-15T10:00:00.000Z" }, message: "workout", nowMs: now }),
  false,
);
assert.equal(
  shouldHandleComebackForUser({ user: { lastActiveAt: "2026-08-15T10:00:00.000Z" }, message: "I train at home now", nowMs: now }),
  false,
);
assert.deepEqual(
  resolveReentryForUser({ user: { lastActiveAt: "2026-08-07T10:00:00.000Z" }, message: "sorry I've been busy", nowMs: now }),
  { daysSinceLastContact: 10, isReturning: true, hasExplicitReturnSignal: true, shouldHandleComeback: true },
);


// ── END TO END: contact clock → seed → state → compiled prompt blurb (2026-08-17) ───────────
// The whole point of P2. compiler.ts:71 turns current.reentry into the sentence the model reads,
// and that state used to be manufactured from clientUnderstanding.updatedAt. These pin the source
// all the way to the prose, so a future change of source fails here rather than on a client's phone.
const { seedUnderstanding } = await import("../server/understanding/seed");
const { compileStateBlurb: promptBlurb } = await import("../server/understanding/compiler");

const seedFor = (lastActiveAt: unknown) =>
  seedUnderstanding({ id: "u1", name: "Thandi", lastActiveAt, goalType: "fat_loss" } as any);

// Normal re-entry: 10 days away must reach the prompt as a returning client.
const away = seedFor(new Date(Date.now() - 10 * 86_400_000).toISOString());
assert.equal(away.current.reentry.isReturning, true);
assert.match(promptBlurb(away), /returning after 10 days away/i);
assert.match(promptBlurb(away), /do not pretend continuity/i);

// Under the threshold: 47 hours is NOT a comeback and must say nothing about returning.
const recent = seedFor(new Date(Date.now() - 47 * 3_600_000).toISOString());
assert.equal(recent.current.reentry.isReturning, false);
assert.doesNotMatch(promptBlurb(recent), /returning after/i);

// Exactly at the threshold, and the phrasing the compiler reserves for it.
const twoDays = seedFor(new Date(Date.now() - 49 * 3_600_000).toISOString());
assert.equal(twoDays.current.reentry.daysSinceLastContact, 2);
assert.match(promptBlurb(twoDays), /returning after a couple of days/i);

// MISSING clock: we do not know, so the prompt must not claim they were away OR that they are here.
const unknown = seedFor(null);
assert.equal(unknown.current.reentry.daysSinceLastContact, null);
assert.equal(unknown.current.reentry.isReturning, false);
assert.doesNotMatch(promptBlurb(unknown), /returning after/i);

// FUTURE clock: same — unknown, never "0 days since contact".
const future = seedFor(new Date(Date.now() + 86_400_000).toISOString());
assert.equal(future.current.reentry.daysSinceLastContact, null);
assert.doesNotMatch(promptBlurb(future), /returning after/i);

console.log("reentry-state-tests: all assertions passed");

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

// REGRADED FOR SAST DAYS (#221). These cases were written against the ELAPSED-HOURS definition —
// "48 hours is the returning threshold" — and that definition is the defect #221 names: the clock
// divided by 86_400_000 instead of counting SAST calendar days, so a client last seen at 23:30 on
// Sunday who wrote at 06:00 on Tuesday was two days gone, counted as one, and was DENIED the
// comeback. The expectations move to the calendar because the semantics moved, and the semantics
// moved because the product is a South African coach whose clients experience days, not periods
// of 86 400 000 milliseconds.
//
// The cases themselves are unchanged and NOT weakened: same instants, same threshold constant,
// same future/unknown handling. Only the day arithmetic differs, and each expectation below is
// what the SAST calendar actually says about those two instants.
//
// MIGRATED FROM reentryFromAgeHours (2026-08-17), which read clientUnderstanding.updatedAt — a
// persistence clock. That correction stands; this one replaces the remaining arithmetic.
const NOW = Date.parse("2026-08-17T10:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

assert.equal(RETURNING_DAYS, 2, "the threshold must live in exactly one place");
assert.deepEqual(contactState(hoursAgo(0), NOW), { daysSinceLastContact: 0, isReturning: false },
  "same instant is the same SAST day");
assert.deepEqual(contactState(hoursAgo(47.99), NOW), { daysSinceLastContact: 2, isReturning: true },
  "47.99h before noon on the 17th is noon on the 15th — two SAST days, and a client would say two");
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
// A TIMESTAMP IS A TIMESTAMP (#221). `new Date(String(1755424800000))` is an Invalid Date, so a
// caller holding epoch milliseconds used to get a silent null — read downstream as "we have never
// heard from this client" rather than as the number they passed. All three input shapes agree.
assert.equal(daysSinceContact(Date.parse("2026-08-15T10:00:00.000Z"), now), 2, "epoch ms is accepted");
assert.equal(daysSinceContact(new Date("2026-08-15T10:00:00.000Z"), now), 2, "a Date is accepted");
assert.equal(daysSinceContact("2026-08-15T10:00:00.000Z", now), 2, "an ISO string is accepted");

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
  { daysSinceLastContact: 2, daysSinceLastExecution: null, executedDuringAbsence: false, isReturning: true, hasExplicitReturnSignal: true, shouldHandleComeback: true },
);
assert.deepEqual(
  resolveReentry({ lastActiveAt: "2026-08-15T10:00:00.000Z", message: "workout", nowMs: now }),
  { daysSinceLastContact: 2, daysSinceLastExecution: null, executedDuringAbsence: false, isReturning: true, hasExplicitReturnSignal: false, shouldHandleComeback: false },
);
assert.deepEqual(
  resolveReentry({ lastActiveAt: "2026-08-15T10:00:00.000Z", message: "I train at home now", nowMs: now }),
  { daysSinceLastContact: 2, daysSinceLastExecution: null, executedDuringAbsence: false, isReturning: true, hasExplicitReturnSignal: false, shouldHandleComeback: false },
);
assert.deepEqual(
  resolveReentry({ lastActiveAt: "2026-08-17T09:00:00.000Z", message: "I'm back", nowMs: now }),
  { daysSinceLastContact: 0, daysSinceLastExecution: null, executedDuringAbsence: false, isReturning: false, hasExplicitReturnSignal: true, shouldHandleComeback: false },
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
  { daysSinceLastContact: 10, daysSinceLastExecution: null, executedDuringAbsence: false, isReturning: true, hasExplicitReturnSignal: true, shouldHandleComeback: true },
);


// ── END TO END: contact clock → seed → state → compiled prompt blurb (2026-08-17) ───────────
// The whole point of P2. compiler.ts:71 turns current.reentry into the sentence the model reads,
// and that state used to be manufactured from clientUnderstanding.updatedAt. These pin the source
// all the way to the prose, so a future change of source fails here rather than on a client's phone.
const { seedUnderstanding } = await import("../server/understanding/seed");
const { compileStateBlurb: promptBlurb } = await import("../server/understanding/compiler");

const seedFor = (lastActiveAt: unknown) =>
  seedUnderstanding({ id: "u1", name: "Thandi", lastActiveAt, goalType: "fat_loss" } as any);

// N SAST DAYS AGO, AT MIDDAY (#221). These cases used to subtract hours from Date.now(), which is
// stable under elapsed-hour arithmetic and NOT stable under calendar days: "47 hours ago" is two
// SAST days at 09:00 and one at 23:00, so the suite's answer would depend on the hour it happened
// to run. Anchoring each instant to midday of a named SAST day makes the expectation a fact about
// the calendar rather than about the clock on the runner.
const middayNSastDaysAgo = (n: number) => {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" })
    .format(new Date(Date.now() - n * 86_400_000));
  return new Date(`${key}T12:00:00+02:00`).toISOString();
};

// Normal re-entry: 10 days away must reach the prompt as a returning client.
const away = seedFor(middayNSastDaysAgo(10));
assert.equal(away.current.reentry.isReturning, true);
assert.match(promptBlurb(away), /returning after 10 days away/i);
assert.match(promptBlurb(away), /do not pretend continuity/i);

// Under the threshold: YESTERDAY is not a comeback and must say nothing about returning.
const recent = seedFor(middayNSastDaysAgo(1));
assert.equal(recent.current.reentry.isReturning, false);
assert.doesNotMatch(promptBlurb(recent), /returning after/i);

// Exactly at the threshold, and the phrasing the compiler reserves for it.
const twoDays = seedFor(middayNSastDaysAgo(2));
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

// ── LAST MEANINGFUL ENGAGEMENT, NOT LAST CONTACT (#221) ──────────────────────────────────────
//
// A client trained on day 3 of a nine-day silence and said so on return. The coach answered
// "about a week away" and filed that session under "the 14 days BEFORE you went quiet" — both
// wrong from one cause: the gap was measured from CONTACT alone, so the thing they actually did
// during the absence was invisible to the clock.
{
  const nowMs = Date.parse("2026-09-08T10:00:00+02:00");
  const day = (n: number) => new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" })
    .format(new Date(nowMs - n * 86_400_000))}T12:00:00+02:00`);

  const trained = resolveReentry({
    lastActiveAt: day(9), lastExecutionAt: day(3), message: "I'm back", nowMs });
  assert.equal(trained.daysSinceLastContact, 9, "contact is still contact");
  assert.equal(trained.daysSinceLastExecution, 3, "and execution is read on the same SAST clock");
  assert.equal(trained.executedDuringAbsence, true, "they kept going while they were quiet");
  assert.equal(trained.shouldHandleComeback, true,
    "the DECISION still keys off contact — they are returning to the conversation either way");

  // CONTROL, and it is the one that matters: execution OLDER than last contact is not evidence of
  // anything during an absence. Without this, every client with any history reads as "still going".
  const stale = resolveReentry({
    lastActiveAt: day(2), lastExecutionAt: day(9), message: "I'm back", nowMs });
  assert.equal(stale.executedDuringAbsence, false,
    "a log older than the last message is not execution during the silence");

  // CONTROL: same-day execution is not "during an absence" either — the silence had not started.
  const sameDay = resolveReentry({
    lastActiveAt: day(4), lastExecutionAt: day(4), message: "I'm back", nowMs });
  assert.equal(sameDay.executedDuringAbsence, false, "strictly newer, not merely equal");

  // CONTROL: no evidence at all must stay null rather than defaulting to a number.
  const none = resolveReentry({ lastActiveAt: day(9), message: "I'm back", nowMs });
  assert.equal(none.daysSinceLastExecution, null, "unknown execution is unknown, not 0");
  assert.equal(none.executedDuringAbsence, false);
}

console.log("reentry-state-tests: GREEN");

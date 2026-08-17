import assert from "node:assert/strict";
import { resolveReentryForUser, shouldHandleComebackForUser } from "../server/understanding/reentry-bridge";

const now = Date.parse("2026-08-17T10:00:00.000Z");

assert.equal(
  shouldHandleComebackForUser({
    user: { lastActiveAt: "2026-08-15T10:00:00.000Z" },
    message: "I'm back",
    nowMs: now,
  }),
  true,
);

assert.equal(
  shouldHandleComebackForUser({
    user: { lastActiveAt: "2026-08-15T10:00:00.000Z" },
    message: "workout",
    nowMs: now,
  }),
  false,
);

assert.equal(
  shouldHandleComebackForUser({
    user: { lastActiveAt: "2026-08-15T10:00:00.000Z" },
    message: "I train at home now",
    nowMs: now,
  }),
  false,
);

assert.deepEqual(
  resolveReentryForUser({
    user: { lastActiveAt: "2026-08-07T10:00:00.000Z" },
    message: "sorry I've been busy",
    nowMs: now,
  }),
  {
    daysSinceLastContact: 10,
    isReturning: true,
    hasExplicitReturnSignal: true,
    shouldHandleComeback: true,
  },
);

// ── THE CONSUMER MIGRATION (2026-08-17) ─────────────────────────────────────────────────────
// early-commands.ts now reads this bridge instead of computing its own daysSilent/isReturning.
// The DECISION and the DISPLAY read the same result but need different things from it, and the
// gap between them is where a migration like this breaks in production rather than in a test.

// `daysSinceLastContact` is null for an absent or future contact clock. The comeback reply
// renders `${daysSilent} day(s)`, so null reaching that line ships the client "null days".
// The consumer defaults to 0; these pin the null so the default cannot be silently removed.
for (const lastActiveAt of [null, undefined, "", "not-a-date", "2026-09-01T10:00:00.000Z"]) {
  const r = resolveReentryForUser({ user: { lastActiveAt }, message: "I'm back", nowMs: now });
  assert.equal(r.daysSinceLastContact, null, `unknown/future clock must resolve null: ${String(lastActiveAt)}`);
  assert.equal(r.isReturning, false, "we cannot claim a return we cannot date");
  assert.equal(r.shouldHandleComeback, false, "and must not fire the comeback on it");
  // The display default the consumer applies.
  assert.equal(r.daysSinceLastContact ?? 0, 0, "?? 0 is what keeps 'null days' out of the reply");
}

// The 48-hour boundary, through the bridge rather than only the resolver — this is the path the
// live consumer actually takes.
const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
assert.equal(shouldHandleComebackForUser({ user: { lastActiveAt: at(47.99) }, message: "I'm back", nowMs: now }), false,
  "47.99 hours is not yet a returning client");
assert.equal(shouldHandleComebackForUser({ user: { lastActiveAt: at(48) }, message: "I'm back", nowMs: now }), true,
  "48 hours is");

// Ordinary commands must never be read as a comeback, whatever the gap. These are the messages
// the guard exists for: they have to reach their own handlers.
for (const msg of ["workout", "done", "today", "menu", "1", "progress", "my meals"]) {
  assert.equal(shouldHandleComebackForUser({ user: { lastActiveAt: at(240) }, message: msg, nowMs: now }), false,
    `"${msg}" is action intent, not a comeback`);
}

// Profile updates must fall through to the lifecycle handler even after a long silence.
for (const msg of ["I train at home now", "switch to gym training", "my goal is 75kg", "change my training days"]) {
  assert.equal(shouldHandleComebackForUser({ user: { lastActiveAt: at(240) }, message: msg, nowMs: now }), false,
    `"${msg}" is a profile update, not a comeback`);
}

console.log("reentry-bridge-tests: all assertions passed");

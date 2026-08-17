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

console.log("reentry-bridge-tests: 4/4 passed");

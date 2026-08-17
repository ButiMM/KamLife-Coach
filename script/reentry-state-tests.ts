import assert from "node:assert/strict";
import { defaultUnderstanding, reentryFromAgeHours } from "../server/understanding/state";
import { compileStateBlurb } from "../server/understanding/compiler";

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

console.log("reentry-state-tests: 9/9 passed");

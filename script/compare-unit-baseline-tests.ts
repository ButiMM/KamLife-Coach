import assert from "node:assert/strict";
import { classifyFailures, comparisonExitCode, parseUnitRun } from "./compare-unit-baseline";

function transcript(passed: number, total: number, names: string[]): string {
  return [
    `unit-tests: ${passed}/${total} passed`,
    ...(names.length ? ["", "Failures:", ...names.flatMap(name => [`  ✗ ${name}`, "    known control"])] : []),
  ].join("\n");
}

// Positive control: the merge base already has one failure; the branch adds one assertion.
// The classifier must preserve the former as BASELINE and make the latter NEW (therefore RED).
const base = parseUnitRun(transcript(1, 2, ["merge-base failing assertion"]), "BASE");
const head = parseUnitRun(transcript(1, 3, ["merge-base failing assertion", "branch-only failing assertion"]), "HEAD");
const delta = classifyFailures(base, head);
assert.deepEqual(delta.baseline, ["merge-base failing assertion"]);
assert.deepEqual(delta.introduced, ["branch-only failing assertion"]);
assert.deepEqual(delta.fixed, []);
assert.equal(comparisonExitCode(delta), 1, "a NEW failure must block CI");

// #130 shape: equal named failures are baseline even when both runs are red.
const known130 = [
  "every meal removal goes through ONE owner, and that owner writes an audit line",
  "week card: full week shows all lines, first name only, brand footer",
  "daily direction: covers today across all pillars + the weekly through-line",
  "daily direction: rest day and walk-only are honoured, never insists on the gym",
];
const sameBase = parseUnitRun(transcript(1048, 1052, known130), "#130 BASE");
const sameHead = parseUnitRun(transcript(1048, 1052, known130), "#130 HEAD");
assert.deepEqual(classifyFailures(sameBase, sameHead), { baseline: known130, introduced: [], fixed: [] });
assert.equal(comparisonExitCode(classifyFailures(sameBase, sameHead)), 0);

assert.throws(() => parseUnitRun("unit-tests: 1/2 passed\n", "BROKEN"), /reported 1 failures but exposed 0/);
console.log("unit-baseline controls: 3/3 passed");

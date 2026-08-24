import assert from "node:assert/strict";
import { attributeMultiDayReport } from "../server/understanding/day-relative-situation";

const NOW = new Date("2026-08-24T10:00:00+02:00"); // Monday SAST

const multi = attributeMultiDayReport(
  "Monday I had pap and chicken. Tuesday I had eggs and toast. Wednesday I trained and walked 8k steps.",
  NOW,
);
assert.equal(multi.hasMultipleDays, true);
assert.equal(multi.ambiguous, false);
assert.deepEqual(multi.beats.map(b => [b.dayKey, b.dayReference, b.text]), [
  ["2026-08-17", "Monday", "I had pap and chicken."],
  ["2026-08-18", "Tuesday", "I had eggs and toast."],
  ["2026-08-19", "Wednesday", "I trained and walked 8k steps."],
]);

const relative = attributeMultiDayReport(
  "Yesterday I had pap and chicken. Today I had eggs and coffee.",
  NOW,
);
assert.equal(relative.ambiguous, false);
assert.deepEqual(relative.beats.map(b => b.dayKey), ["2026-08-23", "2026-08-24"]);

const explicitPast = attributeMultiDayReport("Friday dinner was chicken and rice.", NOW);
assert.equal(explicitPast.ambiguous, false);
assert.equal(explicitPast.beats[0]?.dayKey, "2026-08-21");

const future = attributeMultiDayReport("Next Monday I'll train chest.", NOW);
assert.equal(future.ambiguous, true);
assert.equal(future.beats[0]?.dayKey, null);

const noDate = attributeMultiDayReport("I had pap and chicken and later some eggs.", NOW);
assert.equal(noDate.ambiguous, true);
assert.equal(noDate.beats[0]?.dayKey, null);

const lastWeekend = attributeMultiDayReport("Last weekend we were out eating.", NOW);
assert.equal(lastWeekend.ambiguous, true);
assert.equal(lastWeekend.beats[0]?.dayKey, null);

console.log("✓ multi-day attribution tests");

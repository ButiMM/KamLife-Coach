import assert from "node:assert/strict";
import { classifySituationMessage, resolveRecentSituation, resolveSituationMoment } from "../server/understanding/day-relative-situation";

const monday = new Date("2026-08-24T08:30:00.000Z"); // 10:30 SAST, Monday
const sunday = new Date("2026-08-23T18:00:00.000Z");
const friday = new Date("2026-08-21T10:00:00.000Z");

const completedWeekend = "The birthday weekend was hectic, so we're thinking about skipping today.";
assert.equal(resolveSituationMoment(completedWeekend, monday, monday), "last_night");

const correction = "No, the birthday outing was this weekend, not today.";
assert.equal(resolveSituationMoment(correction, monday, monday), "last_night");

const currentOuting = "Today is my girlfriend's birthday and we're going out to eat tonight.";
assert.equal(resolveSituationMoment(currentOuting, monday, monday), "today");

const oldEvent = "The birthday outing happened last weekend.";
assert.equal(resolveSituationMoment(oldEvent, monday, new Date("2026-08-31T08:30:00.000Z")), "stale");

const closedLastNight = classifySituationMessage("I won't eat anymore tonight. Just zero-calorie drinks.", sunday, monday);
assert.equal(closedLastNight.kind, "food_closed");
assert.equal(closedLastNight.moment, "last_night");

const todayOuting = classifySituationMessage(currentOuting, monday, monday);
assert.equal(todayOuting.kind, "celebration_outing");
assert.equal(todayOuting.moment, "today");

const mixed = resolveRecentSituation([
  { text: "This weekend is my girlfriend's birthday and we're going out.", at: friday },
  { text: completedWeekend, at: monday },
], monday);
assert.equal(mixed.kind, "celebration_outing");
assert.equal(mixed.moment, "last_night");
assert.equal(mixed.sourceText, completedWeekend);

console.log("day-relative-situation-tests: all assertions passed");

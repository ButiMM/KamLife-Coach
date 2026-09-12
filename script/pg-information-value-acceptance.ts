/**
 * REAL-POSTGRESQL ACCEPTANCE — the existing INVESTIGATE owner asks for the fact most likely to
 * change its decision (#213). Rows matter here: weekend coverage, trend usability, stall length,
 * open-loop durability and the later backdated answer cannot be proven by a fixture.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-information-value-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE CLOCK IS PINNED, AND THAT IS THE WHOLE SUBCUT (2026-09-12).
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// THIS ACCEPTANCE WAS GREEN ON WEEKDAYS AND RED ON THE WEEKEND. Measured on unmodified
// 017efd9 on Saturday 12 September 2026 — four checks fail, on a build that passed the same four
// in CI the previous afternoon:
//
//     FAIL  the real customer front door delivers the authorized weekend question
//     FAIL  the reactive question becomes durable only after it is included in the reply
//     FAIL  'I was travelling and didn't track' durably closes the open question
//     FAIL  'it was normal' is accepted as the bounded answer to the question actually open
//
// THE MECHANISM, not a guess: the fixture seeds meals on WEEKDAYS ONLY so the weekend is the
// unknown under test, then sends "Dinner is rice, mince and mixed veggies" through the real front
// door. That message logs a meal for TODAY. On a Saturday, today IS a weekend day — so the live
// turn manufactures the very weekend evidence the section exists to find missing, the INVESTIGATE
// owner correctly stops asking, and four checks fail against a product that is behaving correctly.
//
// The defect was never in the product. It was an acceptance whose fixture depended on which day
// of the week CI happened to start, exactly as #240's depended on the hour — and it was found the
// same way, by a cut that touched none of this code being blocked by it.
//
// SO THE DAY IS CHOSEN RATHER THAN INHERITED. Everything below runs on a fixed Wednesday, which
// makes every `ago(n)` offset, every seeded row and every live turn deterministic on every run at
// every hour of every day. Date.now() alone is not enough — `new Date()` reads the system clock
// directly and never consults it, so both move together or the pin is decorative.
//
// Installed BEFORE the server modules are imported, because they capture the clock as they load.
const RealDate = Date;
const PINNED_WEDNESDAY = RealDate.UTC(2026, 8, 9, 10, 0, 0);   // 2026-09-09 12:00 SAST, a Wednesday
const PINNED_SATURDAY = RealDate.UTC(2026, 8, 12, 10, 0, 0);   // 2026-09-12 12:00 SAST, a Saturday
const PINNED_SUNDAY = RealDate.UTC(2026, 8, 13, 10, 0, 0);     // 2026-09-13 12:00 SAST, a Sunday
let PINNED_AT = PINNED_WEDNESDAY;
class PinnedDate extends RealDate {
  constructor(...args: any[]) { super(...(args.length === 0 ? [PINNED_AT] : args) as [any]); }
  static now() { return PINNED_AT; }
}
(globalThis as any).Date = PinnedDate;
/** Move the pinned day. Section E uses it to grade the Saturday the old fixture could only fail. */
const pinTo = (at: number) => { PINNED_AT = at; };

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { eq } = await import("drizzle-orm");
const { handleMessage } = await import("../server/routes");
const { canonicalDecision } = await import("../server/understanding/live");
const { canonicalNextMove, recordCanonicalMoveOutbound } = await import("../server/scheduler/proactive-decision");
const { loadProactiveState } = await import("../server/scheduler/shared");
const { getProgressTruth } = await import("../server/day-ledger");
const { weekendLoggedDays } = await import("../server/day-ledger-core");
const { ensureOpenTrainingLoop, weekendInvestigationAnswered } = await import("../server/memory");
const { sastDayKey } = await import("../server/sast");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");

let failed = 0;
const check = (ok: boolean, claim: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${claim}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};
const ids: string[] = [];
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
const isWeekend = (at: Date) => weekendLoggedDays([{ day: sastDayKey(at) }]) === 1;

async function freshUser(over: Record<string, unknown> = {}) {
  const phoneNumber = `whatsapp:+2786${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [user] = await db.insert(schema.users).values({
    phoneNumber, name: "Kam", onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss",
    calorieTarget: 2200, proteinTarget: 150, stepsTarget: 8000, trainingMode: "gym",
    trainingDaysPerWeek: 3, currentWeight: "88.0", heightCm: 178, gender: "male", age: 35,
    totalWorkoutsCompleted: 8, createdAt: ago(50), programmeStartDate: ago(50),
    programmeWeek: 7, lastActiveAt: new Date(), ...over,
  } as any).returning();
  ids.push(user.id);
  return user;
}

async function seedMeals(userId: string, offsets: number[]) {
  for (const offset of offsets) {
    await pool.query(
      `INSERT INTO meal_logs
         (user_id, logged_at, meal_label, kcal_int, protein_int, items, raw_message, source)
       VALUES ($1, $2, 'lunch', 650, 45, $3, 'seed', 'sa_scanner')`,
      [userId, ago(offset), JSON.stringify([{ name: "pap", grams: 200, origin: "db" }])],
    );
  }
}

async function seedWeights(userId: string, points: Array<{ days: number; kg: number }>) {
  for (const point of points) {
    await pool.query(
      "INSERT INTO weight_logs (user_id, weight, logged_at) VALUES ($1, $2, $3)",
      [userId, point.kg, ago(point.days)],
    );
  }
}

const reload = async (id: string) =>
  (await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1))[0];
const say = async (phone: string, text: string) => String(await handleMessage(
  phone, text, undefined, undefined, undefined, `SM-iv-${Math.random().toString(36).slice(2, 9)}`,
) || "");
const weekdayOffsets = Array.from({ length: 7 }, (_, i) => i).filter(i => !isWeekend(ago(i))).slice(0, 3);
const stalled = [
  { days: 0, kg: 88.0 }, { days: 7, kg: 88.1 },
  { days: 14, kg: 88.0 }, { days: 21, kg: 88.1 },
];

REAL("\n=== A + D — STALL WITH A BOUNDED CONTEXT UNKNOWN ===");
const a = await freshUser();
await seedMeals(a.id, weekdayOffsets);
await seedWeights(a.id, stalled);
const before = await getProgressTruth(a, { days: 7 });
check(before.window.daysLogged >= 2 && weekendLoggedDays(before.window.perDay) === 0,
  "fixture has thin weekday food evidence and no weekend invention",
  `days=${before.window.daysLogged} weekend=${weekendLoggedDays(before.window.perDay)}`);

const beforeCount = Number((await pool.query("SELECT COUNT(*)::int AS n FROM meal_logs WHERE user_id=$1", [a.id])).rows[0].n);
const silentDecision = await canonicalDecision(a, "how am I doing?");
const afterCount = Number((await pool.query("SELECT COUNT(*)::int AS n FROM meal_logs WHERE user_id=$1", [a.id])).rows[0].n);
check(beforeCount === afterCount, "choosing a missing fact stores no fabricated behaviour from silence");
check(silentDecision.kind === "log" && /weekend/i.test(silentDecision.todo),
  "reactive canonical decision chooses the weekend fact, not a generic measurement",
  `kind=${silentDecision.kind} todo=${JSON.stringify(silentDecision.todo)}`);

const proactive = await canonicalNextMove(a, { hour: 14 });
check(proactive.action.investigation?.missingFact === "weekend_food",
  "proactive decision selects the same explicit missing fact",
  JSON.stringify(proactive.action));
check(proactive.action.todo === silentDecision.todo,
  "reactive and proactive doors ask the same one question",
  `reactive=${JSON.stringify(silentDecision.todo)} proactive=${JSON.stringify(proactive.action.todo)}`);

_resetOutboundDedupe();
const liveReply = await say(a.phoneNumber, "Dinner is rice, mince and mixed veggies");
check(/what did eating look like over the weekend\?/i.test(liveReply),
  "the real customer front door delivers the authorized weekend question",
  JSON.stringify(liveReply.slice(-220)));
const openedA = await reload(a.id);
check(/investigate_weekend_food_open:/i.test(String(openedA.profileNotes || "")),
  "the reactive question becomes durable only after it is included in the handed-off reply",
  JSON.stringify(openedA.profileNotes));

const nonMealCount = Number((await pool.query("SELECT COUNT(*)::int AS n FROM meal_logs WHERE user_id=$1", [a.id])).rows[0].n);
await say(a.phoneNumber, "I was travelling and didn't track");
const nonMealAnswered = await reload(a.id);
const nonMealAfterCount = Number((await pool.query("SELECT COUNT(*)::int AS n FROM meal_logs WHERE user_id=$1", [a.id])).rows[0].n);
const afterNonMealAnswer = await canonicalDecision(nonMealAnswered, "how am I doing now?");
check(nonMealAfterCount === nonMealCount,
  "a truthful no-tracking answer closes the unknown without inventing database-shaped backfill");
check(weekendInvestigationAnswered(nonMealAnswered)
    && /investigate_weekend_food_answered:\d{4}-\d{2}-\d{2}:untracked/i.test(String(nonMealAnswered.profileNotes || ""))
    && afterNonMealAnswer.investigation?.missingFact !== "weekend_food",
  "'I was travelling and didn't track' durably closes the open question",
  `notes=${JSON.stringify(nonMealAnswered.profileNotes)} next=${JSON.stringify(afterNonMealAnswer.todo)}`);

_resetOutboundDedupe();
const answerReply = await say(a.phoneNumber, "Saturday I had pap and chicken. Sunday I had eggs and toast.");
const answeredTruth = await getProgressTruth(await reload(a.id), { days: 7 });
check(weekendLoggedDays(answeredTruth.window.perDay) > 0,
  "the answer becomes canonical backdated weekend evidence",
  JSON.stringify(answeredTruth.window.perDay));
const afterAnswer = await canonicalDecision(await reload(a.id), "how am I doing now?");
check(!/weekend/i.test(answerReply) && afterAnswer.todo !== silentDecision.todo,
  "the answered fact is not asked again and the next decision changes or reconfirms",
  `reply=${JSON.stringify(answerReply.slice(-180))} next=${JSON.stringify(afterAnswer.todo)}`);

const normal = await freshUser();
await seedMeals(normal.id, weekdayOffsets);
await seedWeights(normal.id, stalled);
_resetOutboundDedupe();
await say(normal.phoneNumber, "Dinner is rice, mince and mixed veggies");
await say(normal.phoneNumber, "It was normal");
const normalAnswered = await reload(normal.id);
check(weekendInvestigationAnswered(normalAnswered)
    && /investigate_weekend_food_answered:\d{4}-\d{2}-\d{2}:usual/i.test(String(normalAnswered.profileNotes || "")),
  "'it was normal' is accepted as the bounded answer to the question actually open",
  JSON.stringify(normalAnswered.profileNotes));

const handoff = await freshUser();
await seedMeals(handoff.id, weekdayOffsets);
await seedWeights(handoff.id, stalled);
const handoffMove = await canonicalNextMove(handoff, { hour: 14 });
await recordCanonicalMoveOutbound(handoff, handoffMove, "dropped");
check(!/investigate_weekend_food_open:/i.test(String((await reload(handoff.id)).profileNotes || "")),
  "selecting or dropping a proactive question creates no phantom open investigation");
await recordCanonicalMoveOutbound(handoff, handoffMove, "sent");
check(/investigate_weekend_food_open:/i.test(String((await reload(handoff.id)).profileNotes || "")),
  "an accepted proactive handoff opens the same durable investigation");

REAL("\n=== B — AN OPEN COACHING LOOP OUTRANKS A NEW QUESTION ===");
const b = await freshUser();
await seedMeals(b.id, weekdayOffsets);
await seedWeights(b.id, stalled);
await ensureOpenTrainingLoop(b, sastDayKey(), "reactive");
_resetOutboundDedupe();
const openReply = await say(b.phoneNumber, "I walked 8000 steps today");
const openDecision = await canonicalDecision(await reload(b.id), "I walked 8000 steps today");
check(!/what did eating look like over the weekend/i.test(openReply)
    && !/weekend/i.test(openDecision.todo),
  "an unresolved #208 outcome is not displaced by a competing investigation",
  `reply=${JSON.stringify(openReply.slice(-180))} decision=${JSON.stringify(openDecision.todo)}`);

REAL("\n=== C — STALE WEIGHT REMAINS THE RIGHT SIMPLE ASK ===");
const c = await freshUser();
await seedMeals(c.id, [0, 1, 2, 3, 4]);
await seedWeights(c.id, [{ days: 11, kg: 88.0 }, { days: 18, kg: 89.0 }]);
const stale = await canonicalNextMove(c, { hour: 14 });
check(stale.action.investigation?.missingFact === "weight_current",
  "adequate food plus stale weight keeps the existing measurement owner",
  JSON.stringify(stale.action));
check(/tomorrow morning/i.test(stale.action.todo) && !/\bthis morning\b/i.test(stale.action.todo),
  "the 13:39 SAST control is actionable after the morning has elapsed",
  JSON.stringify(stale.action.todo));

REAL("\n=== E + CONTROLS — DO NOT INTERROGATE OR LEAK STATE ===");
const e = await freshUser();
await seedMeals(e.id, weekdayOffsets);
await seedWeights(e.id, [
  { days: 0, kg: 88.0 }, { days: 7, kg: 89.0 }, { days: 14, kg: 90.0 },
]);
const safe = await canonicalNextMove(e, { hour: 14 });
check(safe.action.investigation?.missingFact !== "weekend_food",
  "without a stall, a merely available question is not asked",
  JSON.stringify(safe.action));

const frequent = await freshUser();
await seedMeals(frequent.id, weekdayOffsets);
await seedWeights(frequent.id, [
  { days: 0, kg: 88.0 }, { days: 2, kg: 88.1 }, { days: 5, kg: 88.0 },
]);
const frequentState = await loadProactiveState(frequent);
const frequentReactive = await canonicalDecision(frequent, "how am I doing?");
const frequentProactive = await canonicalNextMove(frequent, { hour: 14 });
check(frequentState.weight.stalledWeeks === 0
    && frequentReactive.investigation?.missingFact !== "weekend_food"
    && frequentProactive.action.investigation?.missingFact !== "weekend_food",
  "0/2/5-day flat readings are zero elapsed stalled weeks through both decision doors",
  `weeks=${frequentState.weight.stalledWeeks} reactive=${JSON.stringify(frequentReactive.todo)} proactive=${JSON.stringify(frequentProactive.action.todo)}`);

const oneWindow = await freshUser({
  profileNotes: `sick_since:${sastDayKey(ago(40))} | sick_until:${sastDayKey(ago(35))}`,
});
await seedMeals(oneWindow.id, weekdayOffsets);
await seedWeights(oneWindow.id, [
  { days: 0, kg: 88.0 }, { days: 8, kg: 88.1 }, { days: 16, kg: 88.0 }, { days: 40, kg: 88.1 },
]);
const windowReactive = await canonicalDecision(oneWindow, "how am I doing?");
const windowProactive = await canonicalNextMove(oneWindow, { hour: 14 });
check(windowReactive.investigation?.missingFact === "weekend_food"
    && windowProactive.action.investigation?.missingFact === "weekend_food",
  "reactive and proactive decisions share the canonical 28-day weight window",
  `reactive=${JSON.stringify(windowReactive.todo)} proactive=${JSON.stringify(windowProactive.action.todo)}`);

const wellness = await freshUser({ goalType: "general" });
await seedMeals(wellness.id, weekdayOffsets);
await seedWeights(wellness.id, stalled);
const wellnessReactive = await canonicalDecision(wellness, "how am I doing?");
const wellnessProactive = await canonicalNextMove(wellness, { hour: 14 });
check(wellnessReactive.investigation?.missingFact !== "weekend_food"
    && wellnessProactive.action.investigation?.missingFact !== "weekend_food",
  "a non-weight goal cannot trigger weekend-stall investigation through either door",
  `reactive=${JSON.stringify(wellnessReactive.todo)} proactive=${JSON.stringify(wellnessProactive.action.todo)}`);

const forbidden = await freshUser({ doNotMention: "food and meals" });
await seedMeals(forbidden.id, weekdayOffsets);
await seedWeights(forbidden.id, stalled);
const forbiddenMove = await canonicalNextMove(forbidden, { hour: 14 });
check(forbiddenMove.action.investigation?.missingFact !== "weekend_food",
  "doNotMention still blocks the context question",
  JSON.stringify(forbiddenMove.action));

const ill = await freshUser({
  profileNotes: `sick_since:${sastDayKey()} | sick_until:${sastDayKey()} | paused_until:${sastDayKey()}`,
});
await seedMeals(ill.id, weekdayOffsets);
await seedWeights(ill.id, stalled);
const illMove = await canonicalNextMove(ill, { hour: 14 });
check(illMove.action.kind === "rest" && !illMove.action.investigation,
  "illness retains precedence over information collection",
  JSON.stringify(illMove.action));

const isolated = await freshUser();
await seedMeals(isolated.id, weekdayOffsets);
await seedWeights(isolated.id, stalled);
const isolatedMove = await canonicalNextMove(isolated, { hour: 14 });
check(isolatedMove.action.investigation?.missingFact === "weekend_food",
  "one client's answer never fills another client's missing fact",
  JSON.stringify(isolatedMove.action));

REAL("\n=== E — THE SATURDAY THIS SUITE COULD ONLY EVER FAIL ===");
// NOT A REPAIR OF THE PIN — THE CASE THE PIN REVEALED. Everything above runs on a Wednesday, so
// without this section the weekend day is simply never graded, which is the state that let the
// old fixture be green for months and then red on a Saturday morning with nothing changed.
//
// THE PROMISE: the coach must not ask for a fact it already holds. On a weekend day the client's
// own live log IS weekend evidence, so the weekend question must stop being selected — the exact
// behaviour that looked like four failures when the fixture assumed a weekday.
{
  pinTo(PINNED_SATURDAY);
  // OFFSETS DERIVED FROM THE PINNED DAY, NOT INHERITED. `weekdayOffsets` at the top of this file
  // is computed under the Wednesday pin, and reusing it here seeded a meal on the Saturday itself
  // — the fixture manufacturing the evidence the section exists to find missing, which is the
  // very defect this subcut repairs. It failed on the first run and said so.
  const satWeekdayOffsets = Array.from({ length: 7 }, (_, i) => i).filter(i => !isWeekend(ago(i))).slice(0, 3);
  check(satWeekdayOffsets.every(o => !isWeekend(ago(o))) && satWeekdayOffsets.length === 3,
    "the Saturday fixture seeds weekdays only", JSON.stringify(satWeekdayOffsets));
  const sat = await freshUser();
  await seedMeals(sat.id, satWeekdayOffsets);
  await seedWeights(sat.id, stalled);

  const beforeLog = await canonicalNextMove(sat, { hour: 14 });
  check(beforeLog.action.investigation?.missingFact === "weekend_food",
    "on a Saturday with weekday-only evidence the weekend is still the missing fact",
    JSON.stringify(beforeLog.action));

  _resetOutboundDedupe();
  await say(sat.phoneNumber, "Dinner is rice, mince and mixed veggies");
  const afterTruth = await getProgressTruth(await reload(sat.id), { days: 7 });
  check(weekendLoggedDays(afterTruth.window.perDay) > 0,
    "a meal logged ON a weekend day IS weekend evidence — this is why the day matters",
    JSON.stringify(afterTruth.window.perDay));

  const afterLog = await canonicalDecision(await reload(sat.id), "how am I doing?");
  check(afterLog.investigation?.missingFact !== "weekend_food",
    "…so the coach stops asking for the weekend it can now see",
    `missing=${JSON.stringify(afterLog.investigation?.missingFact)} todo=${JSON.stringify(afterLog.todo)}`);

  // SUNDAY, THE OTHER HALF OF THE WEEKEND. Saturday alone would leave the same class of gap one
  // day wide: a fixture that happens to be right on one weekend day and never runs on the other.
  pinTo(PINNED_SUNDAY);
  const sunWeekdayOffsets = Array.from({ length: 7 }, (_, i) => i).filter(i => !isWeekend(ago(i))).slice(0, 3);
  check(sunWeekdayOffsets.every(o => !isWeekend(ago(o))) && sunWeekdayOffsets.length === 3,
    "the Sunday fixture seeds weekdays only", JSON.stringify(sunWeekdayOffsets));
  const sun = await freshUser();
  await seedMeals(sun.id, sunWeekdayOffsets);
  await seedWeights(sun.id, stalled);
  const sunBefore = await canonicalNextMove(sun, { hour: 14 });
  check(sunBefore.action.investigation?.missingFact === "weekend_food",
    "on a Sunday with weekday-only evidence the weekend is still the missing fact",
    JSON.stringify(sunBefore.action));
  _resetOutboundDedupe();
  await say(sun.phoneNumber, "Dinner is rice, mince and mixed veggies");
  const sunAfter = await canonicalDecision(await reload(sun.id), "how am I doing?");
  check(sunAfter.investigation?.missingFact !== "weekend_food",
    "…and a Sunday log closes it for the same reason a Saturday one does",
    `missing=${JSON.stringify(sunAfter.investigation?.missingFact)}`);

  pinTo(PINNED_WEDNESDAY);
}

for (const id of ids) await db.delete(schema.users).where(eq(schema.users.id, id)).catch(() => {});
await pool.end();
if (failed) {
  REAL(`\npg-information-value-acceptance: RED — ${failed} check(s) failed`);
  process.exit(1);
}
REAL("\npg-information-value-acceptance: GREEN — LOCAL REAL POSTGRESQL");
process.exit(0);

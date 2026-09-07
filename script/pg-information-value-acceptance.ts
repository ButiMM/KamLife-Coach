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

for (const id of ids) await db.delete(schema.users).where(eq(schema.users.id, id)).catch(() => {});
await pool.end();
if (failed) {
  REAL(`\npg-information-value-acceptance: RED — ${failed} check(s) failed`);
  process.exit(1);
}
REAL("\npg-information-value-acceptance: GREEN — LOCAL REAL POSTGRESQL");
process.exit(0);

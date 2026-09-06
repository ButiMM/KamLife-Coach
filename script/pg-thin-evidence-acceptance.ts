/**
 * REAL-POSTGRESQL ACCEPTANCE — a sparse client is coached, not just receipted (#203).
 *
 * THE FOUNDER RULE THIS ENFORCES. KamLife is a behavioural coach, not a tracking app: reporting
 * every few days, catching up in one message, disappearing and returning are all first-class
 * customer behaviour. Insufficient evidence must not become a receipt-only dead end — when we
 * cannot safely prescribe we ask the smallest question that would change the next decision, unless
 * the reply already owns NEXT.
 *
 * TWO DEFECTS, BOTH FOUND BY TRACING THE REAL FRONT DOOR BEFORE ANYTHING WAS CHANGED.
 *
 *   1. THE GATE. underPolicy downgraded an unevidenced PRESCRIPTION to `hold`, and left a `hold`
 *      that the ladder itself had reached untouched. For a sparse client the ladder holds far more
 *      often than it prescribes — steps met, rest day, weighed today, one day logged in seven, and
 *      every rung correctly stands down — so the commonest path to the dead end was the one the
 *      guard did not cover. decideProactive already downgraded to the measurement that would
 *      justify a prescription; the reactive gate now applies that same ladder.
 *
 *   2. THE WRITE THAT WAS INVISIBLE. A second weigh-in on the same SAST day UPDATEs the row rather
 *      than inserting (#147), and durableDomains matched only /INSERT weight/. The turn read as
 *      "nothing durable was written", closeCoachingTurn returned early, and the client got a bare
 *      receipt — for the same sentence that coaches them correctly the first time that day.
 *
 * WHY POSTGRESQL. Every decision here is computed from rows: how many days carry a meal, whether
 * one carries TODAY, how stale the last weigh-in is, and whether the second weigh-in of a day
 * updates or inserts. A fixture that answers every query the same way cannot express any of them.
 *
 * EVERY CLAIM IS PAIRED WITH ITS CONTROL. "The client was asked something" is trivially satisfied
 * by a coach that always asks, which is the nagging app this product is defined against.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-thin-evidence-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
const { canonicalNextMove } = await import("../server/scheduler/proactive-decision");
const { sastHour } = await import("../server/sast");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

/** The investigative asks this product owns. Named here so the suite cannot accept new prose. */
const ASKS = /tell me what you ate today|stand on a scale this morning/i;
const D = (d: number) => new Date(Date.now() - d * 86_400_000);
const ids: string[] = [];

async function client(over: Record<string, any> = {}, seed: { meals?: number[]; weights?: number[] } = {}) {
  const phone = `whatsapp:+2786${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: "Kam", onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss",
    calorieTarget: 2200, proteinTarget: 150, stepsTarget: 8000, trainingMode: "gym",
    trainingDaysPerWeek: 3, currentWeight: "88.0", heightCm: 178, gender: "male", age: 35,
    totalWorkoutsCompleted: 8, createdAt: D(40), programmeStartDate: D(40),
    programmeWeek: 6, lastActiveAt: new Date(), ...over,
  } as any).returning();
  ids.push(u.id);
  if (seed.meals?.length) await pool.query(
    `INSERT INTO meal_logs (user_id, logged_at, meal_label, kcal_int, protein_int, items, raw_message, source)
     SELECT $1, now() - (d || ' days')::interval, 'lunch', 600, 40, $2, 'seed', 'sa_scanner'
       FROM unnest($3::int[]) AS d`,
    [u.id, JSON.stringify([{ name: "pap", grams: 200 }]), seed.meals]);
  // TWO readings at DIFFERENT values: getProgressTruth reports weight.known from a CHANGE, so one
  // row leaves weight unknown, chooseAction picks `weigh` before the gate is reached, and the
  // divergence this suite exists for is masked. The first trace of #203 was masked exactly so.
  if (seed.weights?.length) await pool.query(
    `INSERT INTO weight_logs (user_id, weight, logged_at)
     SELECT $1, 88.0 + d * 0.3, now() - (d || ' days')::interval FROM unnest($2::int[]) AS d`,
    [u.id, seed.weights]);
  return { id: u.id, phone };
}

const say = (phone: string, text: string) =>
  handleMessage(phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 9)}`)
    .then(r => String(r || ""));

/** Weighed today and four days ago: the `weigh` rung stands down, so the GATE is what decides. */
const WEIGHED = [0, 4];

REAL("\n=== A SPARSE CLIENT IS COACHED, NOT JUST RECEIPTED ===");

// ── §1 THE FACTS A SPARSE CLIENT REPORTS THAT ARE NOT FOOD ──────────────────────────────────
//
// Each of these wrote real truth and, before #203, ended there. The client has one day of food in
// seven, so a prescription is not safe — but "what did you eat today" is exactly the measurement
// that would make it safe, and it is the question the proactive path already asks.
for (const [said, what] of [
  ["I walked 8000 steps today", "a step report"],
  ["87.4kg this morning", "a weigh-in"],
] as Array<[string, string]>) {
  const c = await client({}, { meals: [3], weights: WEIGHED });
  const reply = await say(c.phone, said);
  chk(ASKS.test(reply), `${what} from a sparse client ends in the question that would unlock coaching`,
    JSON.stringify(reply.slice(0, 220)));
  chk(/8\s?000|87\.4/.test(reply), `…and the receipt they earned is still there`, reply.slice(0, 120));
}

// A SECOND WEIGH-IN ON THE SAME DAY IS THE SAME EVENT. It UPDATEs rather than inserts, and that
// verb is the only difference — the client cannot see it and must not be coached differently for it.
{
  const c = await client({}, { meals: [3], weights: WEIGHED });
  const first = await say(c.phone, "88.1kg this morning");
  const second = await say(c.phone, "87.4kg this morning");
  chk(ASKS.test(first) && ASKS.test(second),
    "the second weigh-in of a day is coached exactly like the first",
    `first=${JSON.stringify(first.slice(0, 90))} second=${JSON.stringify(second.slice(0, 90))}`);
}

// ── §2 THE CATCH-UP MESSAGE ─────────────────────────────────────────────────────────────────
{
  const c = await client({}, { meals: [], weights: WEIGHED });
  const reply = await say(c.phone,
    "Monday I had pap and chicken. Tuesday oats and a chicken salad. Wednesday eggs and rice.");
  chk(/Logged 3 days/i.test(reply), "three days reported at once are still all logged", reply.slice(0, 90));
  chk(ASKS.test(reply), "…and the catch-up ends with the one question that moves the decision on",
    JSON.stringify(reply.slice(-140)));
}

// ── §3 THE CONTROLS — what must NOT change ──────────────────────────────────────────────────
REAL("\n=== CONTROLS ===");

// SUFFICIENT EVIDENCE KEEPS ITS REAL ACTION. If this ever becomes a question, the change has
// replaced coaching with interrogation.
{
  const c = await client({}, { meals: [1, 2, 3, 4, 5], weights: WEIGHED });
  const reply = await say(c.phone, "I had pap and chicken");
  chk(!ASKS.test(reply), "an evidenced client is not asked to log — they are coached",
    JSON.stringify(reply.slice(0, 200)));
  const decided = await canonicalDecision(
    (await db.select().from(schema.users).where(eq(schema.users.id, c.id)).limit(1))[0], "I had pap and chicken");
  chk(decided.kind === "protein", "…and the action the ladder chose survives the gate", `kind=${decided.kind}`);
}

// A CLIENT WHO LOGGED TODAY IS NOT ASKED TO LOG TODAY. Handing back work they have just done is
// the failure the downgrade's own history records, and it is why `loggedToday` is passed at all.
{
  const c = await client({}, { meals: [6], weights: WEIGHED });
  const reply = await say(c.phone, "I had a burger");
  chk(!/tell me what you ate today/i.test(reply),
    "a client who just logged a meal is not asked for the meal they just logged", reply.slice(0, 160));
}

// THE SCALE THEY ASKED US TO DROP. The investigative ladder may not reach for a measurement the
// client has ruled out — the same rule the prescriptive rungs already follow.
{
  const c = await client({ doNotMention: "weight" }, { meals: [3], weights: [] });
  const reply = await say(c.phone, "I walked 8000 steps today");
  chk(!/stand on a scale/i.test(reply),
    "a client who asked us to drop the scale is never asked to weigh", reply.slice(0, 200));
}

// A CONSTRAINT THEY STATED TODAY IS NOT ARGUED WITH. Asking what they have ALREADY eaten is not a
// prescription to eat; asking them to eat would be.
{
  const c = await client({}, { meals: [3], weights: WEIGHED });
  await say(c.phone, "I'm not eating anything else today");
  const reply = await say(c.phone, "I walked 8000 steps today");
  chk(!/(?:eat|have|make)\s+(?:a|one|another|your next)\b/i.test(reply),
    "a closed food day is never answered with an instruction to eat", JSON.stringify(reply.slice(0, 200)));
}

// ONE MOVE PER TURN. withNextMove owns "does the reply already say what to do next"; this proves
// the new question does not arrive on top of an answer that already carries one.
{
  const c = await client({}, { meals: [3], weights: WEIGHED });
  const reply = await say(c.phone, "I walked 8000 steps today");
  const asks = (reply.match(/tell me what you ate today/gi) || []).length;
  chk(asks <= 1, `the question appears at most once — found ${asks}`, reply.slice(0, 220));
}

// ── §4 ONE POLICY, BOTH SCHEDULES ───────────────────────────────────────────────────────────
//
// The whole point of converging through the existing owner: a client must not be told one thing
// when they message and another when the coach messages them, from the same rows.
REAL("\n=== REACTIVE AND PROACTIVE AGREE ===");
{
  const c = await client({}, { meals: [3], weights: WEIGHED });
  await say(c.phone, "I walked 8000 steps today");
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, c.id)).limit(1);
  const reactive = await canonicalDecision(u, "I walked 8000 steps today");
  const proactive = await canonicalNextMove(u, { hour: sastHour() });
  chk(reactive.kind === "log" || reactive.kind === "weigh",
    "the reactive gate investigates rather than holding", `kind=${reactive.kind}`);
  chk(proactive.action.kind !== "hold",
    "…and the proactive path, on the same rows, does not hold either",
    `proactive=${proactive.action.kind}`);
}

await pool.query("DELETE FROM users WHERE id = ANY($1)", [ids]);
REAL(`\npg-thin-evidence-acceptance: ${failed === 0 ? "GREEN — all checks passed" : `RED — ${failed} check(s) failed`}`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

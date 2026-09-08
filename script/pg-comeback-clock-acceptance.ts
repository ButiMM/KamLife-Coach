/**
 * REAL-POSTGRESQL ACCEPTANCE — one comeback clock (#221, journeys 1-3).
 *
 * THE RULE THIS ENFORCES. A client who disappears and comes back meets ONE welcome, measured by
 * ONE clock that counts the days they actually experienced, and that clock knows about anything
 * they DID while they were quiet.
 *
 * Two defects traced through the real front door on main@e81138e before anything changed:
 *
 *   THE CLOCK DIVIDED MILLISECONDS. `daysSinceContact` was
 *   `Math.floor((now - lastActiveAt) / 86_400_000)` — elapsed 24-hour periods, not days. A client
 *   last seen 23:30 on Sunday who wrote at 06:00 on Tuesday had been gone two SAST days, counted
 *   as one, and because RETURNING_DAYS is 2 was DENIED the comeback outright. Evening-then-morning
 *   is how most gaps in this product actually look.
 *
 *   EXECUTION DURING THE ABSENCE WAS INVISIBLE. A client trained on day 3 of a nine-day silence
 *   and said so on return. They were told "about a week away", and the session was filed under
 *   "the 14 days BEFORE you went quiet". Both wrong from one cause: the gap was measured from
 *   CONTACT alone, so the one thing they did while quiet neither moved the number nor was placed
 *   correctly in the sentence.
 *
 * WHY POSTGRESQL. Both are claims about CHRONOLOGY across stored rows — a workout row's logged_at
 * against a user's lastActiveAt, read through the real handler. A pure test can check the
 * arithmetic; it cannot show that the reply a returning client receives now states the right gap.
 *
 * EVERY CLAIM IS PAIRED WITH ITS CONTROL. "The comeback fires" is trivially satisfied by greeting
 * everybody, and "execution counts" by treating any old row as recent activity — both are the
 * opposite defect, and both are asserted against here.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-comeback-clock-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
const { handleMessage } = await import("../server/routes");
const { resolveReentry } = await import("../server/understanding/reentry");
const { lastExecutionAtForUser } = await import("../server/understanding/reentry-bridge");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

/** Midday of the SAST day `n` days back — unambiguous whatever hour this suite runs. */
const middaySastDaysAgo = (n: number) => {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" })
    .format(new Date(Date.now() - n * 86_400_000));
  return new Date(`${key}T12:00:00+02:00`);
};

/** The shapes a comeback greeting can take. Deliberately broader than the one string we emit. */
const WELCOME = /welcome back|good to (have you|see you)|you'?re back|glad you'?re back|where you left off|picking up where|clean restart|start again|fresh start/i;

const ids: string[] = [];
async function client(name: string, over: Record<string, any> = {}) {
  const phone = `whatsapp:+2791${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name, onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss",
    calorieTarget: 2200, proteinTarget: 150, stepsTarget: 8000, trainingMode: "gym",
    trainingDaysPerWeek: 3, currentWeight: "84.0", heightCm: 178, gender: "male", age: 35,
    weeklyFoodBudget: "300_600", totalWorkoutsCompleted: 12,
    createdAt: middaySastDaysAgo(60), programmeStartDate: middaySastDaysAgo(60), programmeWeek: 4, ...over,
  } as any).returning();
  ids.push(u.id);
  return { id: u.id, phone };
}
const ask = (phone: string, text: string) =>
  handleMessage(phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 10)}`)
    .then(r => String(r || ""));

const BACK = "Sorry I've been away, I'm back now";

REAL("\n=== 1 · ONE RETURNING CLIENT, ONE WELCOME ===");
{
  const c = await client("Returner", { lastActiveAt: middaySastDaysAgo(9) });
  const first = await ask(c.phone, BACK);
  chk(WELCOME.test(first), "a client returning after nine days is welcomed back",
    JSON.stringify(first.slice(0, 200)));
  const second = await ask(c.phone, "what should I eat");
  chk(!WELCOME.test(second), "…and the very next turn does not greet them again",
    JSON.stringify(second.slice(0, 200)));
  chk(second.length > 40, "…it answers what they actually asked", JSON.stringify(second.slice(0, 160)));
}

REAL("\n=== 2 · THE CLOCK COUNTS SAST DAYS, NOT ELAPSED MILLISECONDS ===");
{
  // The exact shape the old arithmetic denied: away over one night and the whole next day.
  const sundayNight = Date.parse("2026-09-06T23:30:00+02:00");
  const tuesdayMorning = Date.parse("2026-09-08T06:00:00+02:00");
  const r = resolveReentry({ lastActiveAt: new Date(sundayNight), message: BACK, nowMs: tuesdayMorning });
  chk(r.daysSinceLastContact === 2 && r.shouldHandleComeback,
    "23:30 Sunday to 06:00 Tuesday is two days away, and reaches the comeback",
    `days=${r.daysSinceLastContact} comeback=${r.shouldHandleComeback} (elapsed hours: 30.5)`);

  // THE CONTROL. Counting calendar days must not turn every overnight gap into a comeback.
  const mondayNoon = Date.parse("2026-09-07T12:00:00+02:00");
  const tuesdayNoon = Date.parse("2026-09-08T12:00:00+02:00");
  const one = resolveReentry({ lastActiveAt: new Date(mondayNoon), message: BACK, nowMs: tuesdayNoon });
  chk(one.daysSinceLastContact === 1 && !one.shouldHandleComeback,
    "CONTROL: yesterday is one day, and is still not a comeback",
    `days=${one.daysSinceLastContact} comeback=${one.shouldHandleComeback}`);

  // …and the same instant is still zero, not a rounding artefact.
  const same = resolveReentry({ lastActiveAt: new Date(tuesdayNoon), message: BACK, nowMs: tuesdayNoon });
  chk(same.daysSinceLastContact === 0 && !same.shouldHandleComeback,
    "CONTROL: the same SAST day is zero days away", `days=${same.daysSinceLastContact}`);

  // Through the real front door, end to end.
  const c = await client("Overnight", { lastActiveAt: middaySastDaysAgo(2) });
  chk(WELCOME.test(await ask(c.phone, BACK)), "…and a two-SAST-day client is welcomed at the front door");
}

REAL("\n=== 3 · WHAT THEY DID WHILE THEY WERE QUIET ===");
{
  const c = await client("LateReporter", { lastActiveAt: middaySastDaysAgo(9) });
  await pool.query(`INSERT INTO workout_logs (user_id, logged_at, workout_completed) VALUES ($1,$2,true)`,
    [c.id, middaySastDaysAgo(3)]);

  const seen = await lastExecutionAtForUser(c.id);
  chk(!!seen, "the boundary reads execution evidence from the rows that already store it",
    String(seen));

  const reply = await ask(c.phone, BACK);
  chk(/\b3 days away\b/.test(reply), "the gap stated is the one since they last DID something, not since they last wrote",
    JSON.stringify((reply.match(/[^\n]*away[^\n]*/) || ["(no gap stated)"])[0]));
  chk(!/about a week away|\b9 days away\b/.test(reply), "…so they are not told they were gone a week when they trained on Friday",
    JSON.stringify((reply.match(/[^\n]*away[^\n]*/) || [""])[0]));
  chk(/while you were quiet/i.test(reply) && !/before you went quiet/i.test(reply),
    "…and the session is placed DURING the absence, not before it",
    JSON.stringify((reply.match(/[^\n]*Training:[^\n]*/) || ["(no training line)"])[0]));

  // THE CONTROL. A client who really did go quiet must still be told so — otherwise this fix has
  // simply stopped the coach noticing absences at all.
  const gone = await client("TrulyGone", { lastActiveAt: middaySastDaysAgo(9) });
  const goneReply = await ask(gone.phone, BACK);
  chk(/about a week away/.test(goneReply), "CONTROL: a client with no execution evidence is still told the real gap",
    JSON.stringify((goneReply.match(/[^\n]*away[^\n]*/) || ["(none)"])[0]));
  chk(!/while you were quiet/i.test(goneReply), "CONTROL: …and is not credited with training they never did",
    JSON.stringify((goneReply.match(/[^\n]*Training:[^\n]*/) || [""])[0]));

  // THE CONTROL that stops "any old row" reading as recent activity.
  const stale = await client("StaleRow", { lastActiveAt: middaySastDaysAgo(3) });
  await pool.query(`INSERT INTO workout_logs (user_id, logged_at, workout_completed) VALUES ($1,$2,true)`,
    [stale.id, middaySastDaysAgo(20)]);
  const r = resolveReentry({
    lastActiveAt: middaySastDaysAgo(3), lastExecutionAt: middaySastDaysAgo(20),
    message: BACK, nowMs: Date.now() });
  chk(!r.executedDuringAbsence,
    "CONTROL: a log OLDER than the last message is not execution during the silence",
    `execution=${r.daysSinceLastExecution}d contact=${r.daysSinceLastContact}d`);
  chk(!/while you were quiet/i.test(await ask(stale.phone, BACK)),
    "CONTROL: …and the reply does not claim they kept going");
}

REAL("\n=== 7 · NEGATIVE CONTROL — A SINGLE QUIET DAY IS NOT A COMEBACK ===");
{
  const c = await client("Quiet", { lastActiveAt: middaySastDaysAgo(1) });
  const reply = await ask(c.phone, BACK);
  chk(!WELCOME.test(reply), "one quiet day with the same words is not a comeback event",
    JSON.stringify(reply.slice(0, 200)));
  const r = resolveReentry({ lastActiveAt: middaySastDaysAgo(1), message: BACK, nowMs: Date.now() });
  chk(!r.shouldHandleComeback, "…and the canonical owner agrees", `comeback=${r.shouldHandleComeback}`);

  // An ordinary command after a long gap must reach its own handler, not the welcome.
  const long = await client("Commander", { lastActiveAt: middaySastDaysAgo(9) });
  chk(!WELCOME.test(await ask(long.phone, "my progress")),
    "CONTROL: an ordinary command after a long gap is not intercepted by the comeback");
}

REAL(`\n${failed === 0
  ? "pg-comeback-clock-acceptance: GREEN — all checks passed"
  : `pg-comeback-clock-acceptance: RED — ${failed} check(s) failed`}`);

for (const id of ids) {
  for (const t of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_logs",
                   "chat_history", "turn_ledger", "shadow_replies", "daily_sends",
                   "client_understanding", "client_truth_commits", "daily_constraints"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
}
await pool.end();
process.exit(failed === 0 ? 0 : 1);

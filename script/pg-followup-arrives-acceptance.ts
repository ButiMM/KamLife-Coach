/**
 * REAL-POSTGRESQL ACCEPTANCE — the coach does not chase a commitment the client already kept.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS PROVEN BROKEN ON b34e598 (main), THROUGH THE REAL SCHEDULER JOB, BEFORE ANY EDIT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A client tells the coach they are away until Friday. `scheduleReturnNudge` books the night-
 * before nudge, as designed. They come back EARLY — Wednesday — and log a real meal. On Thursday
 * at 19:00 the nudge fires anyway and they read:
 *
 *     "Tomorrow you're back! Ready to pick up right where you left off — nothing reset, your
 *      plan's exactly where you left it. Reply *I'm back* and we go again. 💪"
 *
 * They came back two days ago. They have been logging since. The coach is asking for a commitment
 * they already kept, and doing it in the restart language ("nothing reset", "pick up right where
 * you left off") that three existing acceptances forbid on the reactive door — pg-messy-reentry,
 * pg-missed-session-outbound and a red-on-revert case that reintroduces it. The proactive door
 * was never held to the same rule.
 *
 * WHY THE ONE CANCELLER COULD NOT REACH THEM. `cancelReturnNudges` exists and is correct. It has
 * exactly one call site — server/handlers/sick-flow.ts — and it sits behind
 * `holdOnRecord.phase !== "none"`, i.e. the client must be on a HEALTH hold AND declare a return
 * in words. A holiday ("away") nudge creates no health hold, so that branch is unreachable for it
 * by construction; and a client who simply resumes logging declares nothing. Both keep the nudge.
 *
 * THE REPAIR IS A READ, NOT A NEW MECHANISM. `hasReturnedSince` asks the durable ledgers whether
 * a meal, a step count or a session was logged after the nudge was scheduled, and the firing job
 * retires the nudge when the answer is yes. Doing the thing IS the declaration. `last_active_at`
 * is deliberately NOT the signal: it moves when a client messages to say they are STILL away,
 * which is the opposite of being back.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS GRADED, AND WHERE IT IS READ FROM
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The real job — `runDueReminders()` — is driven against real PostgreSQL. The body is read from
 * shadow_replies, which is what the transport actually handed the client, and the reminder row is
 * read back from `reminders` so "did it fire" and "was it retired" are separate facts.
 *
 * §1 IS THE CONTROL AND IT COMES FIRST. A cut that simply stopped sending return nudges would
 * pass every other assertion here. A client who is genuinely still away MUST still hear from the
 * coach — that nudge exists because a quiet client never comes back if we go quiet too.
 *
 * THE OUTBOUND DEDUPE IS RESET BETWEEN CASES, and that is not housekeeping. Both cases send the
 * same body to the same number; without the reset the second is suppressed as a duplicate and the
 * defect case passes on the base, which is exactly the false green this file was nearly shipped
 * with.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-followup-arrives-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.PROACTIVE_PAUSED = "false";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { scheduleReturnNudge, createReminder } = await import("../server/reminders");
const { sql: dsql } = await import("drizzle-orm");
const { runDueReminders } = await import("../server/scheduler/jobs/reminders");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

const phone = "whatsapp:+27820000778";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Sipho Away", onboardingState: "COMPLETE", popiConsent: true,
  popiConsentAt: new Date(), subscriptionStatus: "active", goalType: "fat_loss",
  proteinTarget: 130, calorieTarget: 1900, stepsTarget: 8000,
} as any).returning();

const wire = async (): Promise<string[]> => (await pool.query<{ body: string }>(
  "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body);
const reminderRows = async () => (await pool.query<{ status: string; kind: string }>(
  "SELECT status, kind FROM reminders WHERE user_id = $1", [user.id])).rows;

/** The restart doctrine, as the proactive return nudge speaks it. */
const speaksRestart = (b: string): boolean =>
  /nothing reset|pick up right where you left off|we go again|tomorrow you'?re back/i.test(String(b || ""));

async function reset() {
  for (const t of ["reminders", "meal_logs", "step_logs", "workout_logs"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [user.id]).catch(() => {});
  }
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  _resetOutboundDedupe();
}

/**
 * A return nudge of the given reason, booked two days ago, now due.
 *
 * THE RETURN DATE IS TWO DAYS OUT, NOT ONE, AND THAT IS NOT ARBITRARY. `scheduleReturnNudge` books
 * 19:00 SAST the EVENING BEFORE the return date and no-ops when that moment has already passed. A
 * return date of "tomorrow" therefore books nothing at all from 19:00 SAST onwards — this file was
 * green every time it was run in the afternoon and red on the CI run that started at 20:54 SAST,
 * where all nine "the nudge fires / was retired" assertions failed against an EMPTY reminders
 * table. Two days out puts the nudge at least seventeen hours ahead at every hour of the clock.
 * The row's fire_at is dragged into the past below anyway, so the booking time is scaffolding: it
 * only has to exist. What is graded is the firing job, not when the nudge was scheduled.
 */
async function bookDueNudge(reason: "sick" | "away" = "away") {
  const returnDate = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  await scheduleReturnNudge(user.id, phone, returnDate, reason);
  const { rowCount } = await pool.query(
    "UPDATE reminders SET fire_at = now() - interval '1 minute', created_at = now() - interval '2 days' WHERE user_id = $1",
    [user.id]);
  // THE FIXTURE ASSERTS ITSELF. A silent no-op here reads downstream as "the product stopped
  // sending return nudges" — nine failures pointing at the wrong owner. If the row is missing,
  // say so here, in the language of the thing that is actually broken.
  if (!rowCount) { REAL(`  FAIL  FIXTURE: scheduleReturnNudge booked no row for ${returnDate} — nothing below is about the product`); failed++; }
}

const logMealAgo = (interval: string) => pool.query(
  `INSERT INTO meal_logs (user_id, raw_message, source, kcal_int, protein_int, meal_label, logged_at)
   VALUES ($1,'chicken and rice','text',600,45,'lunch', now() - interval '${interval}')`, [user.id]);

REAL("\npg-followup-arrives-acceptance — the coach does not chase a commitment already kept\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("1. CONTROL FIRST — a client who is genuinely still away DOES hear from the coach");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Every assertion below this one is a NOT. Silencing the return nudge outright would satisfy them
// all, and would delete the feature: this nudge exists because a client who is met with silence
// does not come back. If this case ever fails, the cut went further than the defect.
{
  await reset();
  await bookDueNudge();
  await runDueReminders();
  const bodies = await wire();
  chk(bodies.length === 1, "the nudge fires for a client with nothing logged since it was booked",
    JSON.stringify(bodies));
  chk(speaksRestart(bodies[0] || ""), "…and it is the return nudge, not some other message",
    JSON.stringify(bodies[0] || ""));
  chk((await reminderRows())[0]?.status === "sent", "the row is closed so it cannot fire twice");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. THE DEFECT — came back early, logged a meal, still chased");
// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL(`    EXACT BODY SENT ON b34e598: "Tomorrow you're back! Ready to pick up right where you left off — nothing reset, your plan's exactly where you left it. Reply *I'm back* and we go again. 💪"`);
{
  await reset();
  await bookDueNudge();
  await logMealAgo("1 day");            // back EARLY, and doing the thing
  await runDueReminders();
  const bodies = await wire();
  chk(bodies.length === 0, "nothing is sent to a client who already came back and logged",
    JSON.stringify(bodies));
  chk(!bodies.some(speaksRestart), "…so no restart language reaches an active client",
    JSON.stringify(bodies));
  chk((await reminderRows())[0]?.status === "sent",
    "the nudge is RETIRED, not left pending to fire again tomorrow",
    JSON.stringify(await reminderRows()));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. AN AUTO-SYNCED STEP COUNT IS NOT A RETURN — the client did nothing");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE FIRST VERSION OF THIS CUT GOT THIS BACKWARDS AND SHIPPED IT TO REVIEW. It counted any
// step_logs row as coming back. server/routes/health-sync.ts walks clients through an iOS
// Shortcuts automation — Time of Day / 9:00 PM / Daily — that POSTs a step count every night with
// nobody touching the phone. So an away client's own handset quietly retired their nudge, and
// only for the clients engaged enough to have set the integration up.
//
// A meal and a session are things the client DID. A synced step count is something their phone
// did. Only the first is a declaration.
{
  await reset();
  await bookDueNudge("away");
  await pool.query(
    "INSERT INTO step_logs (user_id, steps, logged_at) VALUES ($1, 9000, now() - interval '1 day')",
    [user.id]).catch(() => {});
  const bodies = (await runDueReminders(), await wire());
  chk(bodies.length === 1, "an auto-synced step count does NOT retire the nudge", JSON.stringify(bodies));

  // …while a SESSION does: a logged workout is the client training again, which is the thing.
  await reset();
  await bookDueNudge("away");
  await pool.query(
    `INSERT INTO workout_logs (user_id, logged_at) VALUES ($1, now() - interval '1 day')`,
    [user.id]).catch(async () => {
      await pool.query(
        `INSERT INTO workout_logs (user_id, workout_type, logged_at) VALUES ($1,'gym', now() - interval '1 day')`,
        [user.id]).catch(() => {});
    });
  await runDueReminders();
  chk((await wire()).length === 0, "…but a logged session does", JSON.stringify(await wire()));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3b. A SICK HOLD IS NOT RETIRED BY EATING — a meal is not medical clearance");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The sick nudge does not ask whether the client is alive. It says "you're cleared to get back to
// it … we start easy — session one at 60%". Nothing in a food ledger is clearance to train, and a
// client can eat perfectly well while still ill. The explicit declaration handled by sick-flow.ts
// remains the only thing that cancels a sick nudge — which is why the reason has to survive the
// write at all.
{
  await reset();
  await bookDueNudge("sick");
  await logMealAgo("1 day");
  await runDueReminders();
  const bodies = await wire();
  chk(bodies.length === 1, "a sick nudge still fires for a client who has been eating",
    JSON.stringify(bodies));
  chk(/cleared to get back to it/i.test(bodies[0] || ""), "…and it is the SICK wording, so the reason survived the write",
    JSON.stringify(bodies[0] || ""));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3c. THE ROW SURVIVES A FAILED EVIDENCE READ — a blip must not delete the nudge");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The first version closed the row BEFORE asking. `hasReturnedSince` is a database read; when it
// throws, the catch logs, and a reminder already marked `sent` is gone with nothing pending to
// retry. Simulated here by dropping the table the reader needs, which is the only way to make a
// real read fail on demand.
{
  await reset();
  await bookDueNudge("away");
  await pool.query("ALTER TABLE workout_logs RENAME TO workout_logs_hidden");
  try {
    await runDueReminders();
  } finally {
    await pool.query("ALTER TABLE workout_logs_hidden RENAME TO workout_logs");
  }
  const st = (await pool.query("SELECT status FROM reminders WHERE user_id=$1", [user.id])).rows[0];
  chk(st?.status === "pending", "a failed evidence read leaves the reminder PENDING, not sent",
    JSON.stringify(st));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. THE WINDOW IS 'SINCE WE BOOKED IT' — older activity is not a return");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// A meal logged BEFORE the nudge was scheduled is the life they were living when they told us
// they were going away. Treating that as "already back" would silence the nudge for everyone who
// has ever logged anything, which is the same feature deletion §1 guards.
{
  await reset();
  await bookDueNudge();
  await logMealAgo("5 days");           // before the nudge was booked two days ago
  await runDueReminders();
  const bodies = await wire();
  chk(bodies.length === 1, "activity from before the nudge was booked does NOT retire it",
    JSON.stringify(bodies));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. A CLIENT-SET REMINDER IS NOT OURS TO SECOND-GUESS");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The guard is scoped to `kind: "return"`, the coach's own auto-nudge. A reminder the CLIENT
// asked for fires whether or not they logged — "you already did it" is not our call to make about
// somebody else's request, and silently dropping it would be the coach ignoring an instruction.
{
  await reset();
  await createReminder(user.id, phone, "take your vitamins", new Date(Date.now() - 60_000));
  await logMealAgo("1 hour");           // plainly active
  await runDueReminders();
  const bodies = await wire();
  chk(bodies.length === 1 && /vitamins/i.test(bodies[0] || ""),
    "a client-set reminder still fires for an active client", JSON.stringify(bodies));
}

REAL(`\npg-followup-arrives-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

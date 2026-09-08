/**
 * REAL-POSTGRESQL ACCEPTANCE — one progression owner (#221, journeys 5-7).
 *
 * THE RULE THIS ENFORCES, as adjudicated:
 *
 *   Current session, next session, programme week/day and backdated progression come from the ONE
 *   existing progression owner — the programme cursor (`programmeWeek` / `programmeDayInWeek`) and
 *   what the durable ledger says was done. NEVER from the lifetime counter.
 *
 *   `users.totalWorkoutsCompleted` survives as LEGACY LIFETIME HISTORY, because clients who
 *   started before every session had a durable row may genuinely own sessions no row can prove.
 *   Deliberately NOT replaced with `workout_logs.length` (which would erase that history) and
 *   deliberately NOT `max(counter, rows)` (which would promote corruption to programme truth).
 *
 *   If that lifetime value is shown at all it must read as lifetime — "12 sessions overall". It
 *   may never read as programme position — "You are on Session 13".
 *
 * THE UGLY STATE IS SEEDED ON PURPOSE: seven durable workout rows against a lifetime counter of
 * twelve. That mismatch is exactly what a legacy client carries, and every surface below has to
 * agree about where the client is in the programme regardless of it.
 *
 * WHY POSTGRESQL. Progression is a claim about stored rows against a stored cursor, read through
 * five different handlers. A fixture that answers every query the same way cannot show five
 * surfaces disagreeing, which is the only thing worth proving here.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-session-owner-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

const midday = (n: number) => {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" })
    .format(new Date(Date.now() - n * 86_400_000));
  return new Date(`${key}T12:00:00+02:00`);
};

const ids: string[] = [];
/** THE UGLY STATE: seven durable rows, a lifetime counter of twelve, cursor at week 4 day 2. */
async function legacyClient(name: string, over: Record<string, any> = {}) {
  const phone = `whatsapp:+2791${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name, onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "muscle_gain",
    calorieTarget: 2600, proteinTarget: 170, stepsTarget: 8000, trainingMode: "gym",
    trainingDaysPerWeek: 3, currentWeight: "78.0", heightCm: 180, gender: "male", age: 30,
    weeklyFoodBudget: "300_600",
    totalWorkoutsCompleted: 12,
    programmeStartDate: midday(30), programmeWeek: 4, programmeDayInWeek: 2, programmePhase: 1,
    lastActiveAt: new Date(), ...over,
  } as any).returning();
  ids.push(u.id);
  for (const d of [2, 4, 6, 9, 12, 16, 20]) {
    await pool.query(`INSERT INTO workout_logs (user_id, logged_at, workout_completed) VALUES ($1,$2,true)`,
      [u.id, midday(d)]);
  }
  return { id: u.id, phone };
}
const ask = (phone: string, text: string) =>
  handleMessage(phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 10)}`)
    .then(r => String(r || ""));

const cursor = async (id: string) => (await pool.query(
  `SELECT programme_week AS w, programme_day_in_week AS d, total_workouts_completed AS c FROM users WHERE id=$1`,
  [id])).rows[0];
const rowCount = async (id: string) => (await pool.query(
  `SELECT count(*)::int AS n FROM workout_logs WHERE user_id=$1`, [id])).rows[0].n;

/**
 * A PROGRAMME-POSITION CLAIM: the coach telling the client which session they are ON or about to
 * do. "Session 13 overall" / "13 sessions overall" is lifetime and allowed; "· Session 13" beside
 * a week and a day is a position claim and is not.
 */
const claimsPosition = (r: string) => /·\s*Session\s*\d+(?!\s*overall)/i.test(r)
  || /\bYou(?:'re| are) on Session\s*\d+/i.test(r);
const line = (r: string, re: RegExp) => (r.match(re) || ["(not stated)"])[0].trim();

REAL("\n=== 5 · FIVE SURFACES, ONE PROGRESSION, DESPITE A LEGACY MISMATCH ===");
{
  const c = await legacyClient("Sipho");
  const start = await cursor(c.id);
  chk(await rowCount(c.id) === 7 && Number(start.c) === 12,
    "the ugly state is real: 7 durable rows against a lifetime counter of 12",
    `rows=${await rowCount(c.id)} counter=${start.c}`);

  // The three READING surfaces. "what session am I on" is the one that delivers today's session
  // with its header — confirmed by routing it and reading what came back, not assumed.
  const view = await ask(c.phone, "what session am I on");
  const next = await ask(c.phone, "next workout");
  const prog = await ask(c.phone, "my programme");

  chk(!claimsPosition(view), "today's session header does not claim a programme position from the counter",
    JSON.stringify(line(view, /^\*[^\n]*Week[^\n]*/m)));
  chk(!claimsPosition(next), "the next session does not either",
    JSON.stringify(line(next, /[^\n]*Next Session[^\n]*/)));
  chk(!claimsPosition(prog), "…and neither does the programme view",
    JSON.stringify(line(prog, /[^\n]*Session[^\n]*/)));

  // The cursor is the owner, so every surface that names a day must name the SAME day.
  const day = Number(start.d);
  chk(new RegExp(`Day ${day}\\b`).test(view), `today's workout is day ${day} — the cursor's day`,
    JSON.stringify(line(view, /[^\n]*Day \d[^\n]*/)));
  chk(new RegExp(`Day ${day}\\b`).test(next), `…and the next session names the same day ${day}`,
    JSON.stringify(line(next, /[^\n]*Next Session[^\n]*/)));
  chk(new RegExp(`Week ${start.w}\\b`).test(view) && new RegExp(`Week ${start.w}\\b`).test(next),
    `…and both name week ${start.w}`, JSON.stringify([line(view, /[^\n]*Week \d[^\n]*/), line(next, /[^\n]*Week \d[^\n]*/)]));

  // READING THOSE THREE MUST NOT HAVE MOVED ANYTHING.
  const afterReads = await cursor(c.id);
  chk(String(afterReads.w) === String(start.w) && String(afterReads.d) === String(start.d)
      && String(afterReads.c) === String(start.c),
    "CONTROL: asking three questions moved neither the cursor nor the counter",
    JSON.stringify({ start, afterReads }));

  // 4 · completing today's session — the one surface allowed to advance the cursor.
  await ask(c.phone, "did my workout");
  const afterDone = await cursor(c.id);
  chk(await rowCount(c.id) === 8, "completing a session writes one durable row", `rows=${await rowCount(c.id)}`);
  chk(String(afterDone.d) !== String(start.d),
    "…and advances the programme cursor, which is what owns 'which session is next'",
    JSON.stringify({ before: start.d, after: afterDone.d }));
  chk(Number(afterDone.c) === Number(start.c) + 1,
    "…and moves lifetime history by exactly one, still ahead of the rows and still legacy",
    `counter=${afterDone.c} rows=${await rowCount(c.id)}`);

  // 5 · the surfaces AGREE after the advance — the whole point of one owner.
  const nextAfter = await ask(c.phone, "next workout");
  chk(new RegExp(`Day ${afterDone.d}\\b`).test(nextAfter),
    "the next session follows the cursor, not the counter",
    JSON.stringify(line(nextAfter, /[^\n]*Next Session[^\n]*/)));
  chk(!claimsPosition(nextAfter), "…and still claims no position from the lifetime number",
    JSON.stringify(line(nextAfter, /[^\n]*Session[^\n]*/)));
}

REAL("\n=== 5b · CONTROL — THE LIFETIME NUMBER MAY STILL BE SHOWN, AS LIFETIME ===");
{
  // The adjudication permits the legacy value; it forbids only the position claim. A fix that
  // simply deleted the number would pass every check above and lose real client history.
  const c = await legacyClient("Naledi");
  const view = await ask(c.phone, "what session am I on");
  chk(/\b12\b/.test(view), "the legacy lifetime figure is not deleted from the client's view",
    JSON.stringify(line(view, /^\*[^\n]*Week[^\n]*/m)));
  chk(/12 sessions overall/i.test(view),
    "…and it says what it is: sessions overall, not a session you are on",
    JSON.stringify(line(view, /^\*[^\n]*Week[^\n]*/m)));
}

REAL("\n=== 6 · BACKDATED TRAINING UPDATES THAT SAME TRUTH, AND ONLY IT ===");
{
  const c = await legacyClient("Thabo");
  const start = await cursor(c.id);
  const reply = await ask(c.phone, "I trained yesterday");

  chk(await rowCount(c.id) === 8, "a backdated session writes its durable row", `rows=${await rowCount(c.id)}`);
  chk(Number((await cursor(c.id)).c) === Number(start.c) + 1,
    "…and moves lifetime history by one", `counter=${(await cursor(c.id)).c}`);
  chk(String((await cursor(c.id)).w) === String(start.w) && String((await cursor(c.id)).d) === String(start.d),
    "…and does NOT move the programme cursor — a past day answers nothing about today",
    JSON.stringify({ before: { w: start.w, d: start.d }, after: await cursor(c.id) }));
  chk(!claimsPosition(reply), "…and the reply claims no programme position from the counter",
    JSON.stringify(line(reply, /[^\n]*[Ss]ession[^\n]*/)));

  // CONTROL: a second report of the same day is not a second session.
  await ask(c.phone, "I trained yesterday");
  chk(await rowCount(c.id) === 8 && Number((await cursor(c.id)).c) === Number(start.c) + 1,
    "CONTROL: reporting the same day twice adds neither a row nor a lifetime session",
    `rows=${await rowCount(c.id)} counter=${(await cursor(c.id)).c}`);

  // …and the surface a client checks next agrees with the cursor, not the backfill.
  const next = await ask(c.phone, "next workout");
  chk(new RegExp(`Day ${start.d}\\b`).test(next),
    "the next session is still the cursor's day after a backfill",
    JSON.stringify(line(next, /[^\n]*Next Session[^\n]*/)));
}

REAL("\n=== 7 · A QUIET DAY OR AN UNRELATED MESSAGE FABRICATES NOTHING ===");
{
  const c = await legacyClient("Zanele", { lastActiveAt: midday(1) });
  const start = await cursor(c.id);
  const rows = await rowCount(c.id);

  const quiet = await ask(c.phone, "Sorry I've been away, I'm back now");
  chk(!/welcome back|where you left off/i.test(quiet),
    "one quiet day with comeback words is not a comeback", JSON.stringify(quiet.slice(0, 120)));

  const chat = await ask(c.phone, "is brown rice better than white rice");
  chk(!claimsPosition(chat), "an unrelated question states no programme position",
    JSON.stringify(line(chat, /[^\n]*Session[^\n]*/)));

  const after = await cursor(c.id);
  chk(String(after.w) === String(start.w) && String(after.d) === String(start.d)
      && String(after.c) === String(start.c) && await rowCount(c.id) === rows,
    "…and neither message moved the cursor, the counter or the ledger",
    JSON.stringify({ start, after, rows, now: await rowCount(c.id) }));
}

REAL(`\n${failed === 0
  ? "pg-session-owner-acceptance: GREEN — all checks passed"
  : `pg-session-owner-acceptance: RED — ${failed} check(s) failed`}`);

for (const id of ids) {
  for (const t of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_history",
                   "turn_ledger", "client_understanding", "daily_constraints"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
}
await pool.end();
process.exit(failed === 0 ? 0 : 1);

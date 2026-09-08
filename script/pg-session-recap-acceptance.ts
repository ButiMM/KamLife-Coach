/**
 * REAL-POSTGRESQL ACCEPTANCE — one training recap that does not contradict itself (#221, journey 4).
 *
 * THE RULE THIS ENFORCES. Every customer-visible recap that states a session count must state the
 * rest of the card in terms the same client can reconcile with it. A recap that says a client
 * trained four times and logged nothing, in two consecutive lines, is not two facts — it is the
 * coach disagreeing with itself in front of the person paying for it.
 *
 * REPRODUCED ON main@5da8e5f BEFORE ANYTHING CHANGED. A client with four workout rows in the last
 * seven days and no meal rows:
 *
 *     💪 Sessions this week: *4*
 *     📋 Days logged (7d): *0/7*
 *
 * `daysLogged` is documented in day-ledger-core as "days that actually carry a MEAL — the only
 * honest divisor for an average", and it is exactly that. The number is right; the WORD is wrong.
 * Shown unqualified as "Days logged" it makes a claim about everything the client did, one line
 * under a count of the training it is silently excluding.
 *
 * WHY THE VALUE IS NOT TOUCHED. `window.daysLogged` divides avgKcal and avgProtein, and #203's
 * thin-evidence coaching keys off it. Changing what it COUNTS would move coaching decisions and
 * the averages on every card. The defect is the label, so the label is what changes — and this
 * acceptance asserts the value stays put, so a later "fix" cannot quietly widen it.
 *
 * WHY POSTGRESQL. The contradiction only exists across two different row families — workout_logs
 * present, meal_logs absent — composed into one card by one owner. A fixture that answers every
 * query the same way cannot put a client in that state.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-session-recap-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
async function client(name: string, over: Record<string, any> = {}) {
  const phone = `whatsapp:+2791${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name, onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "muscle_gain",
    calorieTarget: 2600, proteinTarget: 170, stepsTarget: 8000, trainingMode: "gym",
    trainingDaysPerWeek: 3, currentWeight: "78.0", heightCm: 180, gender: "male", age: 30,
    weeklyFoodBudget: "300_600", totalWorkoutsCompleted: 12,
    programmeStartDate: midday(30), programmeWeek: 4, ...over,
  } as any).returning();
  ids.push(u.id);
  return { id: u.id, phone };
}
const ask = (phone: string, text: string) =>
  handleMessage(phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 10)}`)
    .then(r => String(r || ""));

const workout = (id: string, d: number) =>
  pool.query(`INSERT INTO workout_logs (user_id, logged_at, workout_completed) VALUES ($1,$2,true)`, [id, midday(d)]);
const meal = (id: string, d: number) =>
  pool.query(
    `INSERT INTO meal_logs (user_id, logged_at, meal_label, kcal_int, protein_int, items, raw_message, source)
     VALUES ($1,$2,'lunch',600,40,$3,'seed','sa_scanner')`,
    [id, midday(d), JSON.stringify([{ name: "pap", grams: 200 }])]);

/** The line that states how many days carry a food log, whatever it ends up called. */
const foodLine = (r: string) => (r.match(/[^\n]*\b\d+\/7\b[^\n]*/) || ["(no /7 line)"])[0].trim();
const sessLine = (r: string) => (r.match(/[^\n]*[Ss]essions?[^\n]*/) || ["(no session line)"])[0].trim();

REAL("\n=== 1 · A CLIENT WHO TRAINED IS NOT TOLD THEY LOGGED NOTHING ===");
{
  const c = await client("Zanele");
  for (const d of [1, 2, 4, 6]) await workout(c.id, d);   // four sessions, seven days
  // …and no meal rows at all.

  const prog = await ask(c.phone, "my progress");
  chk(/[Ss]essions this week: \*4\*/.test(prog), "the recap states the four sessions it has rows for",
    JSON.stringify(sessLine(prog)));
  chk(/\b0\/7\b/.test(prog), "…and still states the food-day count of zero — the NUMBER is right",
    JSON.stringify(foodLine(prog)));
  chk(!/Days logged/i.test(prog),
    "…but does not call it 'Days logged', which reads as a claim about everything they did",
    JSON.stringify(foodLine(prog)));
  chk(/food/i.test(foodLine(prog)),
    "…it names the thing it actually counts: food", JSON.stringify(foodLine(prog)));

  const week = await ask(c.phone, "this week");
  chk(/[Ss]essions: \*4\*/.test(week), "the 7-day breakdown agrees about the sessions",
    JSON.stringify(sessLine(week)));
  chk(!/Days logged/i.test(week) && /food/i.test(foodLine(week)),
    "…and names its food-day count the same way", JSON.stringify(foodLine(week)));
}

REAL("\n=== 2 · CONTROL — THE NUMBER ITSELF DID NOT MOVE ===");
{
  // The tempting wrong fix is to widen `daysLogged` to count training too. It divides avgKcal and
  // avgProtein and #203's thin-evidence coaching keys off it, so widening it would move coaching
  // decisions and every average on the card. A client with food on three days is 3/7, not 5/7.
  const c = await client("Naledi");
  for (const d of [1, 3]) await workout(c.id, d);
  for (const d of [1, 2, 5]) await meal(c.id, d);

  const prog = await ask(c.phone, "my progress");
  chk(/\b3\/7\b/.test(prog), "CONTROL: three days carry food, so the count is 3/7 and not 5/7",
    JSON.stringify(foodLine(prog)));
  chk(/[Ss]essions this week: \*2\*/.test(prog), "CONTROL: …and the session count is still its own number",
    JSON.stringify(sessLine(prog)));
}

REAL("\n=== 3 · CONTROL — A CLIENT WHO LOGGED FOOD READS THE SAME WAY ===");
{
  // The relabelling must not only make sense in the zero case it was found in.
  //
  // The window is TODAY back six days, not the seven days before today. Seeding days 1–7 reads
  // 6/7 and is a fixture that walks off the end of the window, not a product defect — caught by
  // running it rather than by reasoning about it.
  const c = await client("Thabo");
  for (const d of [0, 1, 2, 3, 4, 5, 6]) await meal(c.id, d);
  const prog = await ask(c.phone, "my progress");
  chk(/\b7\/7\b/.test(prog) && /food/i.test(foodLine(prog)),
    "a fully logged week reads as food on 7 of 7 days", JSON.stringify(foodLine(prog)));
}

REAL(`\n${failed === 0
  ? "pg-session-recap-acceptance: GREEN — all checks passed"
  : `pg-session-recap-acceptance: RED — ${failed} check(s) failed`}`);

for (const id of ids) {
  for (const t of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_history",
                   "turn_ledger", "client_understanding", "daily_constraints"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
}
await pool.end();
process.exit(failed === 0 ? 0 : 1);

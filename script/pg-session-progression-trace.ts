/**
 * TRACE — #221 journeys 4–7, session/progression truth on real PostgreSQL.
 *
 * Read-only reproduction, run before anything changes. One client, one sitting, the surfaces that
 * each state a session number, against the durable rows those numbers claim to describe.
 */
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const R = console.log.bind(console);
const { pool, db } = await import("../server/db.ts");
const schema = await import("../shared/schema.ts");
const { handleMessage } = await import("../server/routes.ts");

const midday = (n: number) => {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" })
    .format(new Date(Date.now() - n * 86_400_000));
  return new Date(`${key}T12:00:00+02:00`);
};

const phone = `whatsapp:+2791${String(Math.floor(Math.random() * 900000) + 100000)}`;
const [u] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Sipho", onboardingState: "COMPLETE", subscriptionStatus: "active",
  popiConsent: true, popiConsentAt: new Date(), goalType: "muscle_gain",
  calorieTarget: 2600, proteinTarget: 170, stepsTarget: 8000, trainingMode: "gym",
  trainingDaysPerWeek: 3, currentWeight: "78.0", heightCm: 180, gender: "male", age: 30,
  weeklyFoodBudget: "300_600",
  // THE DRIFT, STATED AS DATA. The counter claims 12 lifetime sessions; the ledger below holds 7.
  totalWorkoutsCompleted: 12,
  programmeStartDate: midday(30), programmeWeek: 4,
} as any).returning();

for (const d of [1, 2, 4, 6, 12, 20, 30]) {
  await pool.query(
    `INSERT INTO workout_logs (user_id, logged_at, workout_completed) VALUES ($1,$2,true)`,
    [u.id, midday(d)]);
}

const ask = (t: string) => handleMessage(phone, t, undefined, undefined, undefined,
  `SM-${Math.random().toString(36).slice(2, 10)}`).then(r => String(r || ""));

const counts = async () => ({
  rows: (await pool.query(`SELECT count(*)::int AS n FROM workout_logs WHERE user_id=$1`, [u.id])).rows[0].n,
  col: (await pool.query(`SELECT total_workouts_completed AS n FROM users WHERE id=$1`, [u.id])).rows[0].n,
});

const show = (label: string, reply: string) => {
  R(`\n── ${label}`);
  const lines = reply.split("\n").filter(l => /[Ss]ession/.test(l));
  for (const l of lines.slice(0, 3)) R(`   ${l.trim()}`);
  if (!lines.length) R(`   (no session number stated)`);
};

const before = await counts();
R(`\nDURABLE: workout_logs=${before.rows}  users.total_workouts_completed=${before.col}`);

show(`"my progress"`, await ask("my progress"));
show(`"what's my session"`, await ask("what's my session"));
show(`"did my workout"`, await ask("did my workout"));

const mid = await counts();
R(`\nDURABLE after one logged session: workout_logs=${mid.rows}  counter=${mid.col}`);

show(`backdated: "I trained on Monday and Tuesday last week too"`,
  await ask("I trained on Monday and Tuesday last week too"));

const after = await counts();
R(`\nDURABLE after backdating: workout_logs=${after.rows}  counter=${after.col}`);
R(`DRIFT: ${after.col - after.rows} sessions claimed with no durable row behind them\n`);

for (const t of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_history",
                 "turn_ledger", "client_understanding", "daily_constraints"]) {
  await pool.query(`DELETE FROM ${t} WHERE user_id=$1`, [u.id]).catch(() => {});
}
await pool.query(`DELETE FROM users WHERE id=$1`, [u.id]).catch(() => {});
await pool.end();
process.exit(0);

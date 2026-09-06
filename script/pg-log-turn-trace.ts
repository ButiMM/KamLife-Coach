/**
 * DIAGNOSTIC TRACE — where does a durable log turn stop being one coaching turn? (#207)
 *
 * Not an acceptance. This prints, for each scenario the issue names:
 *
 *   client words -> durable truth written -> canonical decision -> handler prose
 *                -> withNextMove -> final customer reply
 *
 * Handler prose is recovered honestly rather than guessed: closeCoachingTurn logs
 * `[COACH_TURN] appended one next move after <domains>` when and only when withNextMove changed
 * the string, and the append shape is a known constant (`\n\n${move}.`), so the prose is the
 * final reply with that exact tail removed. Every durable write is read off the turn's own
 * mutation record, which chat-log prints with its domain prefix.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-log-turn-trace: SKIPPED — no DATABASE_URL.");
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
let captured: string[] = [];
const cap = (...a: any[]) => { captured.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
console.log = console.warn = console.error = cap;

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");

const D = (d: number) => new Date(Date.now() - d * 86_400_000);
const ids: string[] = [];

async function client(over: Record<string, any> = {}, seed: { meals?: number[]; weights?: number[]; steps?: number[]; workouts?: number[] } = {}) {
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
  if (seed.weights?.length) await pool.query(
    `INSERT INTO weight_logs (user_id, weight, logged_at)
     SELECT $1, 88.0 + d * 0.3, now() - (d || ' days')::interval FROM unnest($2::int[]) AS d`,
    [u.id, seed.weights]);
  if (seed.steps?.length) await pool.query(
    `INSERT INTO step_logs (user_id, logged_at, steps, provenance, resolved_day)
     SELECT $1, now() - (d || ' days')::interval, 9000, 'client_report',
            to_char((now() - (d || ' days')::interval) AT TIME ZONE 'Africa/Johannesburg','YYYY-MM-DD')
       FROM unnest($2::int[]) AS d`, [u.id, seed.steps]);
  if (seed.workouts?.length) await pool.query(
    `INSERT INTO workout_logs (user_id, logged_at, workout_completed)
     SELECT $1, now() - (d || ' days')::interval, true FROM unnest($2::int[]) AS d`,
    [u.id, seed.workouts]);
  return { id: u.id, phone };
}

/** THE MARKERS. A durable write is whatever chat-log recorded; the append is what closeCoachingTurn said. */
const MUT = /\b(INSERT|UPDATE) (meal|steps|weight|workout|water)\b/i;

async function trace(label: string, phone: string, text: string) {
  captured = [];
  const reply = String(await handleMessage(
    phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 9)}`) || "");
  const writes = captured.filter(l => MUT.test(l)).map(l => l.trim());
  // The close states which shape it used, so this reports what happened rather than inferring it
  // from a blank line the composed turn no longer contains.
  const closed = captured.find(l => l.includes("[COACH_TURN]")) || "";

  REAL(`\n${"─".repeat(94)}\n${label}`);
  REAL(`  client words     ${JSON.stringify(text)}`);
  REAL(`  durable writes   ${writes.length ? writes.join("\n                   ") : "(none)"}`);
  REAL(`  close            ${closed ? closed.replace(/^\s*\[COACH_TURN\]\s*/, "").trim() : "(no close — nothing durable, or the reply already owns NEXT)"}`);
  REAL(`  FINAL REPLY      ${JSON.stringify(reply)}`);
  return { reply, writes, closed };
}

REAL("=".repeat(94));
REAL("#207 — DOES A DURABLE LOG TURN READ AS ONE COACH SPEAKING?");
REAL("=".repeat(94));

// An EVIDENCED client: six days of food, steps, two weigh-ins, sessions behind. The ladder has a
// real prescription available, so anything receipt-shaped here is not a thin-evidence artefact.
const ev = { meals: [1, 2, 3, 4, 5, 6], weights: [0, 6], steps: [1, 2, 3], workouts: [3] };

const c1 = await client({}, ev);
await trace("1 · NORMAL FOOD LOG", c1.phone, "I had rice and chicken for lunch");

const c2 = await client({}, ev);
await trace("2 · CLEARLY GOOD MEAL", c2.phone, "grilled chicken breast with broccoli and sweet potato for lunch");

const c3 = await client({}, ev);
await trace("3 · POOR MEAL + LIFE CONTEXT", c3.phone,
  "I was so stressed at work today I ended up eating a bunny chow and two cokes");

const c4 = await client({}, ev);
await trace("4 · STEPS LOG", c4.phone, "I walked 9000 steps today");

const c5 = await client({}, ev);
await trace("5 · WEIGHT LOG", c5.phone, "87.4kg this morning");

const c6 = await client({}, ev);
await trace("6 · WORKOUT COMPLETION", c6.phone, "did my workout today");

// 7 — the sparse client #205 legitimately questions.
const c7 = await client({}, { meals: [1], weights: [0, 4] });
await trace("7 · SPARSE CLIENT (#205 asks one measurement)", c7.phone, "I walked 8000 steps today");

// 8 — CONTROL: the reply already owns NEXT. A workout completion whose card carries the next
// session is the real case; if it does not, this control says so rather than pretending.
const c8 = await client({}, ev);
await trace("8 · CONTROL — reply already owns NEXT", c8.phone, "finished my session, what's tomorrow?");

// 9 — CONTROL: doNotMention must stay authoritative through whatever composes the turn.
const c9 = await client({ doNotMention: "weight" }, ev);
await trace("9 · CONTROL — doNotMention: weight", c9.phone, "I had rice and chicken for lunch");

// 10 — CONTROL: numbers must remain attributable. A closed food day must not be answered with an
// instruction to eat, and no portion may appear that the ledger did not produce.
const c10 = await client({ calorieTarget: 1200 }, ev);
await trace("10 · CONTROL — closed food day / numeric attribution", c10.phone,
  "I had a huge plate of pap and beef stew and chips for dinner");

REAL(`\n${"=".repeat(94)}`);
for (const id of ids) {
  for (const t of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_logs"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
}
await pool.end();
process.exit(0);

/**
 * DIAGNOSTIC TRACE 2 — a whole day of log turns, one client (#207).
 *
 * Trace 1 took one turn per client. The founder's complaint is about how a DAY reads: several
 * durable logs in a row, each acknowledged and each stapled with a move chosen from day state.
 * chooseAction is a pure function of that state, so this asks the question trace 1 could not:
 * does the same client get the same stapled sentence turn after turn?
 */
if (!process.env.DATABASE_URL) { console.log("SKIPPED — no DATABASE_URL."); process.exit(0); }
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
console.log = console.warn = console.error =
  (...a: any[]) => { captured.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };

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

const MUT = /\b(INSERT|UPDATE) (meal|steps|weight|workout|water)\b/i;

async function turn(phone: string, text: string) {
  captured = [];
  const reply = String(await handleMessage(
    phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 9)}`) || "");
  const writes = captured.filter(l => MUT.test(l)).map(l => l.trim().replace(/user=\S+ /, ""));
  // The close now leaves its own marker saying WHICH shape it used, so this reports what happened
  // rather than inferring it from a blank line the composed turn no longer contains.
  const marker = captured.find(l => l.includes("[COACH_TURN]")) || "(no close)";
  REAL(`\n  ▸ ${JSON.stringify(text)}`);
  REAL(`      wrote  ${writes.join(" ; ") || "(nothing durable)"}`);
  REAL(`      close  ${marker.replace(/^\s*\[COACH_TURN\]\s*/, "").trim()}`);
  REAL(`      REPLY  ${JSON.stringify(reply)}`);
  return reply;
}

REAL("=".repeat(94));
REAL("#207 — ONE CLIENT, ONE DAY, SEVERAL DURABLE LOGS");
REAL("=".repeat(94));

const ev = { meals: [1, 2, 3, 4, 5, 6], weights: [0, 6], steps: [1, 2, 3], workouts: [3] };

REAL("\nA · A normal day: breakfast, steps, lunch, weigh-in, dinner");
const a = await client({}, ev);
const moves: string[] = [];
moves.push(await turn(a.phone, "two eggs and toast for breakfast"));
moves.push(await turn(a.phone, "walked 9000 steps"));
moves.push(await turn(a.phone, "chicken and rice for lunch"));
moves.push(await turn(a.phone, "87.4kg this morning"));
moves.push(await turn(a.phone, "pap and beef stew for dinner"));

const nonEmpty = moves.filter(Boolean);
const distinct = new Set(nonEmpty);
REAL(`\n  replies: ${nonEmpty.length}   distinct: ${distinct.size}`);
for (const m of distinct) REAL(`    ${nonEmpty.filter(x => x === m).length}× ${JSON.stringify(m)}`);

REAL("\n" + "─".repeat(94));
REAL("\nB · A sparse client reporting three things in a row");
const b = await client({}, { meals: [1], weights: [0, 4] });
const bm: string[] = [];
bm.push(await turn(b.phone, "walked 8000 steps today"));
bm.push(await turn(b.phone, "87.4kg this morning"));
bm.push(await turn(b.phone, "did my workout"));
const bne = bm.filter(Boolean);
REAL(`\n  replies: ${bne.length}   distinct: ${new Set(bne).size}`);
for (const m of new Set(bne)) REAL(`    ${bne.filter(x => x === m).length}× ${JSON.stringify(m)}`);

REAL(`\n${"=".repeat(94)}`);
for (const id of ids) {
  for (const t of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_logs"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
}
await pool.end();
process.exit(0);

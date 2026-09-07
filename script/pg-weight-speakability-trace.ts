/**
 * DIAGNOSTIC TRACE — weight authority and speakability (#216).
 *
 * Not an acceptance. For each of the seven mandatory journeys it prints:
 *
 *   client truth -> stored readings/health evidence -> canonical weight truth
 *                -> speakability verdict -> decision -> exact reply
 *
 * Real front door and the real Monday job, on real PostgreSQL. SHADOW=on routes every proactive
 * send into shadow_replies, so the proactive surfaces are graded on the MESSAGE a client would
 * have received rather than on the decision behind it.
 */
if (!process.env.DATABASE_URL) { console.log("SKIPPED — no DATABASE_URL."); process.exit(0); }
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const { eq } = await import("drizzle-orm");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { runMondayProgress } = await import("../server/scheduler/jobs/monday");
const { weightDirectionSpeakable } = await import("../server/adaptive-targets");
const { getProgressTruth } = await import("../server/day-ledger");
const { readHealthState } = await import("../server/health-state");

const D = (d: number) => new Date(Date.now() - d * 86_400_000);
const dayKey = (d: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(D(d));
const ids: string[] = [];

/** Weekly rhythm: four readings over 18 days, newest yesterday, a real 17-day span. */
const WEEKLY: Array<[number, number]> = [[18, 87.2], [12, 86.4], [6, 85.5], [1, 84.0]];

async function client(name: string, over: Record<string, any> = {}, readings = WEEKLY) {
  const phone = `whatsapp:+2792${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name, onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss",
    calorieTarget: 2200, proteinTarget: 150, stepsTarget: 8000, trainingMode: "gym",
    trainingDaysPerWeek: 3, currentWeight: "84.0", heightCm: 178, gender: "male", age: 35,
    targetWeightKg: "78.0", totalWorkoutsCompleted: 12,
    createdAt: D(90), programmeStartDate: D(90), lastActiveAt: new Date(), ...over,
  } as any).returning();
  ids.push(u.id);
  for (const [daysAgo, kg] of readings) {
    await pool.query(`INSERT INTO weight_logs (user_id, weight, logged_at) VALUES ($1,$2,$3)`,
      [u.id, kg, D(daysAgo)]);
  }
  await pool.query(
    `INSERT INTO workout_logs (user_id, logged_at, workout_completed)
     SELECT $1, now() - (d || ' days')::interval, true FROM generate_series(1, 4) AS d`, [u.id]);
  await pool.query(
    `INSERT INTO chat_history (user_id, message_in, message_out, intent, created_at)
     SELECT $1, 'chicken and rice', 'ok', 'FOOD_LOG', now() - (d || ' days')::interval
       FROM generate_series(1, 6) AS d`, [u.id]);
  return { id: u.id, phone };
}

const ask = (phone: string, text: string) =>
  handleMessage(phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 10)}`)
    .then(r => String(r || ""));

async function mondayFor(id: string): Promise<string> {
  await pool.query("DELETE FROM shadow_replies WHERE user_id = $1", [id]);
  await pool.query("DELETE FROM daily_sends WHERE user_id = $1", [id]).catch(() => {});
  await runMondayProgress();
  const r = await pool.query(
    "SELECT body FROM shadow_replies WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [id]);
  return String(r.rows[0]?.body || "(nothing sent)");
}

/** The canonical chain, printed for one client. */
async function chain(label: string, c: { id: string; phone: string }) {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, c.id)).limit(1);
  const rows = (await pool.query(
    `SELECT weight, logged_at FROM weight_logs WHERE user_id=$1 ORDER BY logged_at`, [c.id])).rows;
  const points = rows.map((r: any) => ({ at: new Date(r.logged_at) }));
  const health = readHealthState(u as any);
  const truth = await getProgressTruth(u as any, { days: 30 });
  const verdictAll = await weightDirectionSpeakable(points, u as any);
  const verdictTwo = await weightDirectionSpeakable(points.slice(-2), u as any);
  REAL(`\n${"─".repeat(100)}\n${label}`);
  REAL(`  stored readings  ${rows.map((r: any) => `${r.weight}@${new Intl.DateTimeFormat("en-CA").format(new Date(r.logged_at))}`).join(" | ")}`);
  REAL(`  health evidence  sick=${health.isSick} since=${health.sickSince ?? "-"} until=${health.sickUntil ?? "-"}  doNotMention=${JSON.stringify((u as any).doNotMention)}`);
  REAL(`  canonical truth  change=${truth.weight.changeKg}kg span=${truth.weight.spanDays}d known=${truth.weight.known} daysSince=${truth.weight.daysSinceWeighIn}`);
  REAL(`  speakability     whole window: ${JSON.stringify(verdictAll)}   newest TWO only: ${JSON.stringify(verdictTwo)}`);
  return u;
}

REAL("=".repeat(100));
REAL("#216 — WEIGHT AUTHORITY AND SPEAKABILITY, ON main@b1e401e");
REAL("=".repeat(100));

// Illness straddling the window: began before the newest reading, ended inside it.
const ILL = `sick_since:${dayKey(10)} | sick_until:${dayKey(7)}`;

REAL("\n### 1 + 7 — MONDAY: `At this pace` VS THE SPEAKABILITY VERDICT ON ONE SURFACE");
{
  const ill = await client("Ill", { profileNotes: ILL });
  await chain("1 · illness-contaminated trend, Monday summary", ill);
  REAL(`  MONDAY MESSAGE\n${(await mondayFor(ill.id)).split("\n").map(l => `      ${l}`).join("\n")}`);
}

REAL("\n### 2 — MONDAY'S WINDOW: TWO NEWEST ROWS, OR AN ADEQUATE WEEK?");
{
  // A real weekly span exists (18 days, 4 readings) but the two NEWEST are 1 day apart.
  const tight = await client("Tight", {}, [[18, 87.2], [12, 86.4], [2, 84.4], [1, 84.0]]);
  await chain("2 · adequate week present, newest two only 1 day apart", tight);
  REAL(`  MONDAY MESSAGE\n${(await mondayFor(tight.id)).split("\n").map(l => `      ${l}`).join("\n")}`);
}

REAL("\n### 5 — MONDAY MUST HONOUR doNotMention");
{
  const quiet = await client("Quiet", { doNotMention: "weight" });
  await chain("5 · client asked us to drop the scale", quiet);
  REAL(`  MONDAY MESSAGE\n${(await mondayFor(quiet.id)).split("\n").map(l => `      ${l}`).join("\n")}`);
}

REAL("\n### 3 + 4 — BODY CHECK: LIFETIME HISTORY, AND THE STATED REASON");
{
  // An OLD illness, long finished, with a clean recent run of readings after it.
  const old = await client("OldIllness", {
    profileNotes: `sick_since:${dayKey(80)} | sick_until:${dayKey(75)}`,
  });
  await chain("3 · illness 80 days ago, clean readings since", old);
  for (const q of ["how am I doing", "check my body", "my weight?", "what's my BMI?"]) {
    REAL(`  ▸ ${JSON.stringify(q)}\n      ${JSON.stringify((await ask(old.phone, q)).slice(0, 260))}`);
  }

  const ill2 = await client("IllNow", { profileNotes: ILL });
  await chain("4 · illness inside the window — what reason is given?", ill2);
  for (const q of ["how am I doing", "check my body"]) {
    REAL(`  ▸ ${JSON.stringify(q)}\n      ${JSON.stringify((await ask(ill2.phone, q)).slice(0, 260))}`);
  }
}

REAL("\n### 6 — BMI AND WEIGHT QUESTIONS REACH THEIR OWNERS");
{
  const c = await client("Router");
  for (const q of ["what's my BMI?", "my weight?", "what is my bmi", "how much do I weigh"]) {
    REAL(`  ▸ ${JSON.stringify(q)}\n      ${JSON.stringify((await ask(c.phone, q)).slice(0, 220))}`);
  }
}

REAL(`\n${"=".repeat(100)}`);
for (const id of ids) {
  for (const t of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_logs",
                   "chat_history", "turn_ledger", "shadow_replies"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
}
await pool.end();
process.exit(0);

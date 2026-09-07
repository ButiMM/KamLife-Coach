/**
 * DIAGNOSTIC TRACE — food identity and stated portion (#206).
 *
 * Not an acceptance. For every journey the issue names it prints the whole customer path:
 *
 *   client words -> scanner/matcher identity -> stored items/portion -> canonical day truth
 *                -> actual customer reply
 *
 * Real front door, real PostgreSQL. The scanner is called separately on the same words purely to
 * show what the MATCHER saw; the stored items and portions are re-read from meal_logs after the
 * turn, and the day truth comes from the ledger owner the product itself reads.
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
const { scanForSAFoods } = await import("../server/handlers/food-scanner");
const { getDayLedger } = await import("../server/day-ledger");

const D = (d: number) => new Date(Date.now() - d * 86_400_000);
const ids: string[] = [];

async function client(over: Record<string, any> = {}) {
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
  return { id: u.id, phone };
}

async function trace(label: string, text: string) {
  const c = await client();
  captured = [];
  const matched = scanForSAFoods(text).map((f: any) => `${f.name}${f.typicalPortionGrams ? `@${f.typicalPortionGrams}g` : ""}`);
  const reply = String(await handleMessage(
    c.phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 9)}`) || "");
  const rows = (await pool.query(
    `SELECT items, kcal_int, protein_int, meal_label FROM meal_logs WHERE user_id = $1 ORDER BY logged_at`, [c.id])).rows;
  const stored = rows.flatMap((r: any) =>
    (Array.isArray(r.items) ? r.items : []).map((i: any) => `${i.name}${i.grams ? `@${i.grams}g` : ""}`));
  const ledger = await getDayLedger(c.id, { user: { id: c.id } });

  REAL(`\n${"─".repeat(100)}\n${label}`);
  REAL(`  client words     ${JSON.stringify(text)}`);
  REAL(`  matcher identity ${matched.length ? matched.join(" | ") : "(no match)"}`);
  REAL(`  stored items     ${stored.length ? stored.join(" | ") : "(nothing written)"}`);
  REAL(`  day truth        ${ledger.kcal} kcal · ${ledger.protein}g protein · ${ledger.meals?.length ?? 0} meal(s)`);
  REAL(`  FINAL REPLY      ${JSON.stringify(reply)}`);
  return { reply, matched, stored, rows };
}

REAL("=".repeat(100));
REAL("#206 — FOOD IDENTITY AND STATED PORTION, ON main@f5d0bee");
REAL("=".repeat(100));

REAL("\n### THE FOUNDER'S LIVE FAILURE (7 Sep 13:39 SAST)");
await trace("0 · `Mixed veggies` must not become `Mixed`", "Dinner is rice / Mince / Mixed veggies");

REAL("\n### INVENTED COMBINED IDENTITIES");
await trace("1 · pap and a beef stew must NOT invent `Pap en vleis`", "I had pap and a beef stew");
await trace("2 · toast and a butter chicken curry must NOT invent `Toast with butter`",
  "I had toast and a butter chicken curry");

REAL("\n### STATED PORTION MUST SURVIVE");
await trace("3 · half a gatsby keeps the HALF identity and portion", "I had half a gatsby");
await trace("4 · half gatsby is the same half-portion", "I had half gatsby");
await trace("6 · kota identity is deterministic and keeps the portion", "I had half a kota");
await trace("7 · gatsby identity is deterministic and keeps the portion", "I had a full gatsby");

REAL("\n### TWO FOODS MUST STAY TWO FOODS, BOTH ORDERS");
await trace("5a · rice and chicken livers", "I had rice and chicken livers");
await trace("5b · chicken livers and rice", "I had chicken livers and rice");

REAL("\n### NEGATIVE CONTROL — LEGITIMATE JOINS AND ALIASES STILL WORK");
await trace("8a · a real combined dish is still recognised as one", "I had pap en vleis");
await trace("8b · a legitimate alias still resolves", "I had a kota");
await trace("8c · an ordinary two-food plate still splits", "I had chicken and rice");

REAL(`\n${"=".repeat(100)}`);
for (const id of ids) {
  for (const t of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_logs", "turn_ledger"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
}
await pool.end();
process.exit(0);

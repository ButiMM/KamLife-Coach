/**
 * DIAGNOSTIC TRACE — facts, retractions, replacements, same-turn propagation (#211).
 *
 * Not an acceptance. For each journey the issue names it prints:
 *
 *   client words -> fact extracted -> durable truth -> canonical belief -> reply owner -> reply
 *
 * Real front door, real PostgreSQL. `detectFacts` is called separately on the same words purely to
 * show what the extractor SAW; the durable truth is re-read from the users row after the turn, and
 * the canonical belief is read through the owners the reply itself uses (foodConstraints,
 * readHealthState) rather than by re-deriving anything here.
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
const { eq } = await import("drizzle-orm");
const { handleMessage } = await import("../server/routes");
const { detectFacts } = await import("../server/memory");
const { foodConstraints } = await import("../server/food-swaps");
const { readHealthState } = await import("../server/health-state");

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

const FACT_COLS = ["dietaryRestrictions", "injuries", "medicalConditions", "lifeContext", "doNotMention", "workSchedule"] as const;

async function turn(label: string, c: { id: string; phone: string }, text: string) {
  captured = [];
  const saw = detectFacts(text);
  const reply = String(await handleMessage(
    c.phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 9)}`) || "");
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, c.id)).limit(1);
  const durable: Record<string, any> = {};
  for (const k of FACT_COLS) if (row[k as keyof typeof row]) durable[k] = row[k as keyof typeof row];
  const cons = foodConstraints(row as any);
  const health = readHealthState(row as any);
  const owner = (captured.find(l => /\[(FOOD_|PLATE_|STREET_|GOAL_|WORKOUT|PAIN|INJURY|SAFETY|MISC|ENGINE_|GPT)/i.test(l)) || "").trim();

  REAL(`\n${"─".repeat(96)}\n${label}`);
  REAL(`  client words     ${JSON.stringify(text)}`);
  REAL(`  fact extracted   ${JSON.stringify({ ...saw, retract: saw.retract && Object.keys(saw.retract).length ? saw.retract : undefined })}`);
  REAL(`  durable truth    ${JSON.stringify(durable)}`);
  REAL(`  canonical belief constraints=[${cons.terms.join(", ")}]  sick=${health.isSick}`);
  REAL(`  reply owner      ${owner || "(no owner marker logged)"}`);
  REAL(`  FINAL REPLY      ${JSON.stringify(reply)}`);
  return { reply, row, cons, health, saw };
}

REAL("=".repeat(96));
REAL("#211 — FACTS, RETRACTIONS, AND SAME-TURN PROPAGATION");
REAL("=".repeat(96));

REAL("\n### A/B/C — FACT + QUESTION IN ONE NATURAL SENTENCE");
{
  const a = await client();
  const ra = await turn("A · vegan + question", a, "I'm vegan now, what should I eat?");
  REAL(`  >> vegan-safe this turn? constraints carry vegan = ${ra.cons.terms.some(t => /vegan/i.test(t))}`);

  const b = await client();
  const rb = await turn("B · dairy + question", b, "I can't eat dairy, what can I eat?");
  REAL(`  >> dairy-safe this turn? constraints carry dairy = ${rb.cons.terms.some(t => /dairy|milk/i.test(t))}`);

  const c = await client();
  const rc = await turn("C · knee + training question", c, "my knee is killing me, what should I train?");
  REAL(`  >> injury recorded this turn? injuries = ${JSON.stringify(rc.row.injuries)}`);
}

REAL("\n### D/E — RETRACTION AND REPLACEMENT");
{
  const d = await client({ dietaryRestrictions: "vegan" });
  await turn("D · replacement", d, "I'm not vegan, I'm vegetarian");

  const e = await client({ dietaryRestrictions: "vegan" });
  await turn("E · retraction", e, "I'm not vegan anymore");
}

REAL("\n### F — EXACT REMOVAL");
{
  const f = await client({ dietaryRestrictions: "peanuts, nuts" });
  await turn("F · retract nuts, keep peanuts", f, "I can eat nuts again");
}

REAL("\n### G — INJURY `anymore` NEGATIVE CONTROL");
{
  const g = await client({ injuries: "knee" });
  await turn("G · a question containing `anymore` must not erase the injury", g,
    "my knee doesn't hurt as much anymore, should I still avoid squats?");
}

REAL("\n### H — MIXED INTENT, NO CLEAN SEPARATOR + ISOLATION");
{
  const h = await client();
  await turn("H1 · fact and question, no comma", h, "I am vegan now what should I eat");

  const h2 = await client({ dietaryRestrictions: "halal", injuries: "shoulder", lifeContext: "newborn at home" });
  await turn("H2 · unrelated durable facts must survive an unrelated retraction", h2, "I'm not vegan anymore");
}

REAL(`\n${"=".repeat(96)}`);
for (const id of ids) {
  // turn_ledger TOO. Coach Health reads that table for the whole database, so turns this suite
  // leaves behind are read back as though the lab had produced them — which is exactly how a
  // clean run of journey-lab reported a #86 regression that belonged to this file's fixtures.
  for (const t of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_logs", "turn_ledger"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
}
await pool.end();
process.exit(0);

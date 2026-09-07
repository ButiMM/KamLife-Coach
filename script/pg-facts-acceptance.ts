/**
 * REAL-POSTGRESQL ACCEPTANCE — facts, retractions, replacements, same-turn propagation (#211).
 *
 * THE RULE THIS ENFORCES. What the client says about themselves must survive intact, and a fact
 * committed by a message must shape the SAME customer-visible reply — not a column that becomes
 * useful next turn. Five defects, each traced through the real front door before anything changed:
 *
 *   "I'm vegan now, what should I eat?"   stored the restriction as "vegan now" — the span the
 *                                         capture reached, which read back out of foodConstraints
 *                                         as two terms and left retractions matching a string the
 *                                         client never said.
 *   "I can't eat dairy, what can I eat?"  read as a CLOSED FOOD DAY: "You said you are done
 *                                         eating today, so I am leaving it there."
 *   "I'm not vegan, I'm vegetarian"       vegan removed AND put back by the append, vegetarian
 *                                         deleted by the merge, and the reply said "updated to
 *                                         *vegan*" — the client corrected us and we confirmed the
 *                                         thing they had just denied.
 *   "I can eat nuts again"                cleared an unrelated PEANUT allergy, by containment.
 *   "my knee doesn't hurt as much anymore, should I still avoid squats?"
 *                                         erased the active knee injury, off a bare `anymore`, in
 *                                         a question about training around it.
 *
 * WHY POSTGRESQL. Every claim here is about what a real transaction leaves in the row: retraction
 * before append, one operation building on another's patch, and unrelated columns untouched. A
 * fixture that returns whatever it was handed cannot show any of it.
 *
 * EVERY CLAIM IS PAIRED WITH ITS CONTROL. "The fact was not deleted" is trivially satisfied by a
 * build that never deletes anything, which is the opposite defect: a healed knee that steers leg
 * day forever, and a diet the client abandoned still governing every suggestion.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-facts-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
const { eq } = await import("drizzle-orm");
const { handleMessage } = await import("../server/routes");
const { foodConstraints } = await import("../server/food-swaps");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

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

const say = (phone: string, text: string) =>
  handleMessage(phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 9)}`)
    .then(r => String(r || ""));

const rowOf = async (id: string) =>
  (await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1))[0] as any;

REAL("\n=== A FACT COMMITTED THIS TURN SHAPES THIS TURN'S REPLY ===");

// ── A — vegan + question in one natural sentence ────────────────────────────────────────────
{
  const c = await client();
  const reply = await say(c.phone, "I'm vegan now, what should I eat?");
  const row = await rowOf(c.id);
  chk(/\bvegan\b/i.test(String(row.dietaryRestrictions || "")),
    "A · `I'm vegan now, what should I eat?` — the restriction is durable",
    `column=${JSON.stringify(row.dietaryRestrictions)}`);
  // THE SPAN, NOT THE TOKEN, was the defect: "vegan now" read out as two constraint terms.
  chk(String(row.dietaryRestrictions).toLowerCase() === "vegan",
    "…and it is stored as the restriction itself, not the span up to the comma",
    `column=${JSON.stringify(row.dietaryRestrictions)}`);
  chk(!foodConstraints(row).terms.some(t => /\bnow\b/i.test(t)),
    "…so no constraint term carries a word the client never restricted",
    `terms=${JSON.stringify(foodConstraints(row).terms)}`);
  chk(/vegan|plant|tofu|lentil|bean|soya/i.test(reply) && !/\b(chicken|beef|eggs|fish|milk|cheese)\b/i.test(reply),
    "…and the SAME reply is already vegan-safe", JSON.stringify(reply.slice(0, 200)));
}

// ── B — a dietary restriction is not a closed food day ──────────────────────────────────────
{
  const c = await client();
  const reply = await say(c.phone, "I can't eat dairy, what can I eat?");
  const row = await rowOf(c.id);
  chk(/dairy/i.test(String(row.dietaryRestrictions || "")),
    "B · `I can't eat dairy, what can I eat?` — the restriction is durable",
    `column=${JSON.stringify(row.dietaryRestrictions)}`);
  chk(!/done eating|leaving it there|finished on/i.test(reply),
    "…and they are not told they have finished eating for the day",
    JSON.stringify(reply.slice(0, 220)));
  chk(!/\b(milk|cheese|yoghurt|yogurt|amasi|dairy)\b/i.test(reply.replace(/can'?t eat dairy/i, "")),
    "…and the SAME reply is already dairy-safe", JSON.stringify(reply.slice(0, 220)));
  // CONTROL — a genuinely closed food day must STILL close. Without this the fix above reads as
  // "closures no longer work", which is the constraint #194 and P0-4b exist to hold.
  const d = await client();
  await say(d.phone, "I'm not eating anymore today");
  const after = await say(d.phone, "what should I eat");
  chk(/done eating|leaving it there|not eating|finished/i.test(after),
    "CONTROL: a real closure still closes the day", JSON.stringify(after.slice(0, 160)));
}

// ── C — injury truth reaches the training answer ────────────────────────────────────────────
{
  const c = await client();
  const reply = await say(c.phone, "my knee is killing me, what should I train?");
  const row = await rowOf(c.id);
  chk(/knee/i.test(String(row.injuries || "")), "C · the knee injury is durable",
    `column=${JSON.stringify(row.injuries)}`);
  chk(/knee/i.test(reply) && /avoid|instead|safe|upper body/i.test(reply),
    "…and the SAME reply trains around it", JSON.stringify(reply.slice(0, 160)));
  chk(!/torn|tear|acl|meniscus|arthritis|tendonitis/i.test(reply),
    "…without inventing a diagnosis", JSON.stringify(reply.slice(0, 200)));
}

REAL("\n=== RETRACTION AND REPLACEMENT ARE EXACT ===");

// ── D — replacement ─────────────────────────────────────────────────────────────────────────
{
  const c = await client({ dietaryRestrictions: "vegan" });
  const reply = await say(c.phone, "I'm not vegan, I'm vegetarian");
  const row = await rowOf(c.id);
  const col = String(row.dietaryRestrictions || "").toLowerCase();
  chk(/vegetarian/.test(col), "D · vegetarian becomes the current truth", `column=${JSON.stringify(col)}`);
  // THE ORDERING PROOF. Retractions run before appends, but the append re-read the ORIGINAL row,
  // so the retracted item came straight back: "vegan, vegetarian".
  chk(!/\bvegan\b/.test(col.replace(/vegetarian/g, "")),
    "…and vegan is gone, not re-added by the append that followed the retraction",
    `column=${JSON.stringify(col)}`);
  chk(/vegetarian/i.test(reply) && !/updated to \*vegan\*/i.test(reply),
    "…and the reply names what they ARE, not what they just denied",
    JSON.stringify(reply.slice(0, 160)));
}

// ── E — retraction, exactly once ────────────────────────────────────────────────────────────
{
  const c = await client({ dietaryRestrictions: "vegan" });
  const reply = await say(c.phone, "I'm not vegan anymore");
  const row = await rowOf(c.id);
  chk(!row.dietaryRestrictions, "E · vegan is retracted", `column=${JSON.stringify(row.dietaryRestrictions)}`);
  chk(!/updated to \*vegan\*/i.test(reply) && !/only suggest plant-based/i.test(reply),
    "…and the reply does not confirm the diet they just dropped",
    JSON.stringify(reply.slice(0, 160)));
  chk(reply.trim().length > 0 && !/didn'?t quite catch/i.test(reply),
    "…and the correction is answered rather than falling through to a non-answer",
    JSON.stringify(reply.slice(0, 160)));
}

// ── F — exact removal ───────────────────────────────────────────────────────────────────────
{
  const c = await client({ dietaryRestrictions: "peanuts, nuts" });
  await say(c.phone, "I can eat nuts again");
  const row = await rowOf(c.id);
  const col = String(row.dietaryRestrictions || "").toLowerCase();
  chk(/peanuts/.test(col), "F · retracting `nuts` leaves the unrelated PEANUT restriction intact",
    `column=${JSON.stringify(col)}`);
  chk(!/(^|,\s*)nuts(\s*,|$)/.test(col), "…and `nuts` itself is gone", `column=${JSON.stringify(col)}`);
  // CONTROL — removal must still WORK, and must still clear a legacy span-form row. Without this
  // the boundary match reads as "retractions stopped removing anything".
  const legacy = await client({ dietaryRestrictions: "vegan now" });
  await say(legacy.phone, "I'm not vegan anymore");
  chk(!(await rowOf(legacy.id)).dietaryRestrictions,
    "CONTROL: a row written in the old span form is still cleared by its retraction",
    `column=${JSON.stringify((await rowOf(legacy.id)).dietaryRestrictions)}`);
}

// ── G — an active injury is not erased by the word `anymore` ────────────────────────────────
{
  const c = await client({ injuries: "knee" });
  const reply = await say(c.phone, "my knee doesn't hurt as much anymore, should I still avoid squats?");
  const row = await rowOf(c.id);
  chk(/knee/i.test(String(row.injuries || "")),
    "G · a hedged improvement inside a question does not amputate the injury",
    `column=${JSON.stringify(row.injuries)}`);
  chk(reply.trim().length > 0, "…and the question is still answered", JSON.stringify(reply.slice(0, 120)));
  // …AND A QUESTION ABOUT A RESOLUTION IS NOT A RESOLUTION. The assert branch has always been
  // gated on the client REPORTING rather than asking; the retract branch was not, so a question
  // could not add an injury but could delete one — and this is the sentence that does it, with a
  // full resolution phrase inside a conditional the client has not claimed.
  const asked = await client({ injuries: "knee" });
  await say(asked.phone, "if my knee doesn't hurt anymore should I go back to squats?");
  chk(/knee/i.test(String((await rowOf(asked.id)).injuries || "")),
    "…and asking IF it resolves does not resolve it",
    `column=${JSON.stringify((await rowOf(asked.id)).injuries)}`);

  // CONTROL — a real resolution must STILL clear it, or the guard above is just "never remove".
  const healed = await client({ injuries: "knee, shoulder" });
  await say(healed.phone, "my knee doesn't hurt anymore");
  const h = await rowOf(healed.id);
  chk(!/knee/i.test(String(h.injuries || "")),
    "CONTROL: a genuine resolution still clears the joint", `column=${JSON.stringify(h.injuries)}`);
  chk(/shoulder/i.test(String(h.injuries || "")),
    "CONTROL: …and takes only that joint with it", `column=${JSON.stringify(h.injuries)}`);
}

REAL("\n=== ISOLATION, SEPARATORS, AND UNRELATED FACTS ===");

// ── H — mixed intent with no separator, and per-client isolation ────────────────────────────
{
  const c = await client();
  const reply = await say(c.phone, "I am vegan now what should I eat");
  const row = await rowOf(c.id);
  chk(String(row.dietaryRestrictions || "").toLowerCase() === "vegan",
    "H · a fact and a question with no comma still commits the fact",
    `column=${JSON.stringify(row.dietaryRestrictions)}`);
  chk(/vegan|plant|tofu|lentil|bean|soya/i.test(reply),
    "…and the same reply honours it", JSON.stringify(reply.slice(0, 140)));

  // UNRELATED DURABLE FACTS SURVIVE AN UNRELATED RETRACTION, and so does the other client.
  const other = await client({ dietaryRestrictions: "vegan" });
  const keeper = await client({ dietaryRestrictions: "halal", injuries: "shoulder", lifeContext: "newborn at home" });
  await say(keeper.phone, "I'm not vegan anymore");
  const k = await rowOf(keeper.id);
  chk(/halal/i.test(String(k.dietaryRestrictions || "")) && /shoulder/i.test(String(k.injuries || ""))
      && /newborn/i.test(String(k.lifeContext || "")),
    "…a retraction of something they never had leaves every other fact untouched",
    JSON.stringify({ diet: k.dietaryRestrictions, inj: k.injuries, life: k.lifeContext }));
  chk(String((await rowOf(other.id)).dietaryRestrictions || "").toLowerCase() === "vegan",
    "…and another client's vegan restriction is not touched by it",
    `column=${JSON.stringify((await rowOf(other.id)).dietaryRestrictions)}`);
}

REAL(`\n${failed === 0 ? "pg-facts-acceptance: GREEN — all checks passed" : `pg-facts-acceptance: RED — ${failed} check(s) failed`}`);

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
process.exit(failed === 0 ? 0 : 1);

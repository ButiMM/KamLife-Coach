/**
 * REAL-POSTGRESQL ACCEPTANCE — a daily constraint is durable day state (#194).
 *
 * REPRODUCED ON main@c420c48, and the reason this file exists:
 *
 *   after the two declarations:          foodDayClosed=true   trainingDeclined=true
 *   after 26 further ordinary messages:  foodDayClosed=false  trainingDeclined=false
 *
 * The client reopened nothing. readHeldConstraints rebuilt today's constraints by replaying chat
 * history, and that replay is ORDER BY created_at DESC LIMIT 24 — so the declaration fell out of
 * the window and a closed food day silently reopened itself. The client who talks to us most is
 * the one it failed for.
 *
 * WHY REAL POSTGRESQL: the whole claim is about what SURVIVES. A fixture that returns the same
 * rows to every query cannot demonstrate a window, and the window is the defect.
 *
 * Requires DATABASE_URL. Skips loudly without one.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-daily-constraint-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.NORMALIZER = "off"; process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test"; process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";
const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { readHeldConstraints, recordDailyConstraint } = await import("../server/held-constraints");
const { sastDayKey } = await import("../server/sast");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

async function seed() {
  const phone = `whatsapp:+2788${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: "Kam", onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, goalType: "fat_loss", calorieTarget: 2800, proteinTarget: 195,
    stepsTarget: 8500, currentWeight: "84.5", lastActiveAt: new Date(),
  } as any).returning();
  return u;
}
/** An ordinary turn, recorded exactly as the front door records one. */
const turn = async (u: any, text: string, sourceMessageId?: string) => {
  await pool.query(
    `INSERT INTO chat_history (user_id,message_in,message_out,intent,created_at) VALUES ($1,$2,'ok','GENERAL', now())`,
    [u.id, text]);
  await recordDailyConstraint(u, text, sourceMessageId);
};
const evidence = async (uid: string) => (await pool.query(
  `SELECT day, kind, state, via FROM daily_constraints WHERE user_id=$1 ORDER BY id`, [uid])).rows;

// ── §1 A CLOSURE SURVIVES A BUSY DAY ────────────────────────────────────────────────────────
REAL("\n§1 a food closure survives more than 24 later messages");
const a = await seed();
await turn(a, "I'm not eating anything else today");
await turn(a, "I'm not training today");
let h = await readHeldConstraints(a.phoneNumber, a);
chk(h.foodDayClosed === true && h.trainingDeclined === true,
  "both constraints hold when they are stated", JSON.stringify(h));
for (let i = 0; i < 30; i++) await turn(a, `ordinary message number ${i}`);
h = await readHeldConstraints(a.phoneNumber, a);
chk(h.foodDayClosed === true, "the food closure is still held after 30 later messages", JSON.stringify(h));
chk(h.trainingDeclined === true, "and so is the training decline", JSON.stringify(h));

// ── §2 AN EXPLICIT REOPENING RELEASES IT ────────────────────────────────────────────────────
REAL("\n§2 an explicit reopening releases the day");
await turn(a, "actually I changed my mind, I'm having dinner");
h = await readHeldConstraints(a.phoneNumber, a);
chk(h.foodDayClosed === false, "the day is open again on the client's newest decision", JSON.stringify(h));
chk(h.trainingDeclined === true, "…and the training decline is untouched by a food reopening",
  JSON.stringify(h));

// ── §3 THE ASSERTION IS STILL ON THE RECORD ─────────────────────────────────────────────────
REAL("\n§3 append-only: the closure survives its own reversal");
const ev = await evidence(a.id);
chk(ev.some(r => r.kind === "food" && r.state === "asserted"), "the closure row is still there",
  JSON.stringify(ev.filter(r => r.kind === "food")));
chk(ev.some(r => r.kind === "food" && r.state === "released"), "and so is the release");
chk(ev.filter(r => r.kind === "food").length === 2,
  "exactly two food rows — nothing was edited in place", String(ev.filter(r => r.kind === "food").length));

// ── §4 MOVING THE WORKOUT INTO TODAY REVERSES THE DECLINE ───────────────────────────────────
//
// The workout ledger IS the evidence of resolution here — append-only, durable, and already the
// thing every other surface trusts about training. A second row saying what it already says would
// be a second answer to one question.
REAL("\n§4 a session logged today reverses the decline");
await db.insert(schema.workoutLogs).values({ userId: a.id, workoutCompleted: true } as any);
h = await readHeldConstraints(a.phoneNumber, a);
chk(h.trainingDeclined === false, "the decline is resolved by the session actually happening",
  JSON.stringify(h));

// ── §5 QUESTIONS, HISTORY AND INTENTIONS DO NOT MUTATE TODAY ────────────────────────────────
REAL("\n§5 asking, reporting the past, and stating a plan change nothing");
const b = await seed();
for (const t of [
  "should I stop eating for today?",
  "am I done training today?",
  "yesterday I was not eating anything else",
  "tomorrow I'm not training",
  "I was done eating last night",
]) await turn(b, t);
h = await readHeldConstraints(b.phoneNumber, b);
chk(h.foodDayClosed === false, "no closure was invented", JSON.stringify(h));
chk(h.trainingDeclined === false, "no decline was invented", JSON.stringify(h));
chk((await evidence(b.id)).length === 0, "and nothing was written at all",
  JSON.stringify(await evidence(b.id)));

// ── §6 YESTERDAY DOES NOT LEAK INTO TODAY ───────────────────────────────────────────────────
//
// TODAY ONLY is the rule held-constraints.ts opens with. A stored constraint makes it easier to
// break than a replayed one did, so it is graded directly against a row dated yesterday.
REAL("\n§6 yesterday's constraint does not bind today");
const c = await seed();
const yesterday = sastDayKey(new Date(Date.now() - 86_400_000));
await db.insert(schema.dailyConstraints).values([
  { userId: c.id, day: yesterday, kind: "food", state: "asserted", via: "said" },
  { userId: c.id, day: yesterday, kind: "training", state: "asserted", via: "said" },
] as any);
h = await readHeldConstraints(c.phoneNumber, c);
chk(h.foodDayClosed === false && h.trainingDeclined === false,
  "a constraint dated yesterday binds nothing today", JSON.stringify(h));
// …and the control: the same rows dated TODAY must bind, or §6 proves only that the reader is broken.
await db.insert(schema.dailyConstraints).values([
  { userId: c.id, day: sastDayKey(new Date()), kind: "food", state: "asserted", via: "said" },
] as any);
h = await readHeldConstraints(c.phoneNumber, c);
chk(h.foodDayClosed === true, "CONTROL: the same row dated today does bind", JSON.stringify(h));

// ── §7 ONE CLIENT'S CONSTRAINT IS THEIR OWN ─────────────────────────────────────────────────
REAL("\n§7 isolation");
const d = await seed();
h = await readHeldConstraints(d.phoneNumber, d);
chk(h.foodDayClosed === false && h.trainingDeclined === false,
  "a fresh client inherits nobody's day", JSON.stringify(h));

// ── §8 A PROVIDER RETRY APPENDS NOTHING ─────────────────────────────────────────────────────
REAL("\n§8 the same provider message twice");
const e = await seed();
await turn(e, "I'm not eating anything else today", "SM-CONSTRAINT-1");
const afterFirst = (await evidence(e.id)).length;
await turn(e, "I'm not eating anything else today", "SM-CONSTRAINT-1");
chk((await evidence(e.id)).length === afterFirst, "a retry of one message adds no second row",
  `${afterFirst} → ${(await evidence(e.id)).length}`);
chk((await readHeldConstraints(e.phoneNumber, e)).foodDayClosed === true,
  "…and the day is still closed");

REAL(`\npg-daily-constraint-acceptance: ${failed === 0 ? "GREEN — all checks passed" : `RED — ${failed} check(s) failed`}`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

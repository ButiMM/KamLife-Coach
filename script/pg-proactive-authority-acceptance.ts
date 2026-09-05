/**
 * REAL-POSTGRESQL ACCEPTANCE — one coach, proactively and reactively (#180).
 *
 * THE CONTRADICTION THIS EXISTS TO STOP, reproduced on this branch's parent. One client, one
 * moment, having said in their own words "I am not training today":
 *
 *   canonical owner        state=INVESTIGATE action=come_back
 *                          "Just say hi. That's the whole ask today."
 *   runWeeklyMondayCheckin "Complete 3 sessions. That is all."
 *
 * Not a difference of phrasing. The decision owner reads held constraints — what this client
 * already told us today — and the week-3 branch read nothing at all. The outbound floor can refuse
 * a forbidden sentence; it cannot make two coaches into one.
 *
 * WHAT IS GRADED HERE, AND WHAT IS NOT. The proactive jobs send; there is no capture seam for a
 * message body, and script/trace-proactive.ts already says so plainly rather than inventing one.
 * So this grades the thing that actually decides — chooseAction, the single owner both the
 * reactive door and the proactive senders now consume — under identical seeded client state, and
 * the scheduling guarantees that must survive the migration. The CLASSIFICATION of each sender is
 * graded where declarations belong, in check-architecture's register guard, whose own note is
 * that reading the source IS reading the subject when the subject is a declaration.
 *
 * Requires DATABASE_URL. Skips loudly without one.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-proactive-authority-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.NORMALIZER = "off";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test"; process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";
const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { canonicalNextMove, PROACTIVE_SENDERS } = await import("../server/scheduler/proactive-decision");
const { readHeldConstraints } = await import("../server/held-constraints");
const { claimDailySlot } = await import("../server/scheduler/shared");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

async function seed(over: Record<string, any> = {}): Promise<any> {
  // THROUGH DRIZZLE, NOT A HAND-MAPPED ROW. The first cut of this built the client object by
  // renaming snake_case columns by hand and missed several — so every seeded client read as a
  // stranger of fourteen weeks and every decision came back `come_back`, which would have made
  // §2's control unfalsifiable. The decision owner takes the row the product gives it.
  const phone = `whatsapp:+2790${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: "Kam", onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss",
    calorieTarget: 2800, proteinTarget: 195, stepsTarget: 8500, currentWeight: "84.5",
    heightCm: 178, gender: "male", age: 35, trainingMode: "gym", trainingDaysPerWeek: 3,
    totalWorkoutsCompleted: 6, lastActiveAt: new Date(),
    createdAt: new Date(Date.now() - 21 * 86_400_000),
    programmeStartDate: new Date(Date.now() - 21 * 86_400_000), programmeWeek: 3,
    ...over,
  } as any).returning();
  return u;
}

const said = (uid: string, text: string) => pool.query(
  `INSERT INTO chat_history (user_id, message_in, message_out, intent, created_at)
   VALUES ($1,$2,'ok','GENERAL', now())`, [uid, text]);

// ── §1 A CONSTRAINT THE CLIENT STATED BINDS THE PROACTIVE COACH ─────────────────────────────
REAL("\n§1 'I am not training today' — the case that used to contradict");
const a = await seed();
await said(a.id, "I am not training today");
const heldA = await readHeldConstraints(a.phoneNumber, a);
chk(heldA.trainingDeclined === true, "the constraint is read from the client's own words",
  JSON.stringify(heldA));
const moveA = await canonicalNextMove(a, { hour: 18 });
chk(moveA.action.kind !== "train", "the proactive move is not a training instruction",
  `action=${moveA.action.kind}`);
chk(!/complete \d+ sessions|hit the gym|train today/i.test(moveA.line),
  "…and its wording instructs no session either", moveA.line.slice(0, 120));
chk(moveA.held.trainingDeclined === true,
  "the move carries the constraint it was decided under, so the floor can check it");

// ── §2 THE CONTROL: WITHOUT THE CONSTRAINT, TRAINING IS STILL REACHABLE ─────────────────────
//
// §1 is satisfied by a coach that never asks anyone to train. This is what stops that reading.
REAL("\n§2 a PRESENT client who declared nothing — training must still be reachable");
// Present, and present in the way the ladder MEASURES presence. Its first rung is
// `daysSinceAnyLog >= 3` — logs, not chat — so a control client who has been chatting but logging
// nothing still reads as gone and gets the come-back move whatever else is true. That would have
// made this control unfalsifiable, which is exactly what it is here to prevent. This one has been
// logging: food yesterday and today, steps today.
const b = await seed();
await pool.query(
  `INSERT INTO meal_logs (user_id, logged_at, meal_label, kcal_int, protein_int, items, raw_message, source)
   VALUES ($1, now() - interval '1 day', 'lunch', 600, 45, $2, 'seed', 'sa_scanner'),
          ($1, now(),                     'lunch', 600, 45, $2, 'seed', 'sa_scanner')`,
  [b.id, JSON.stringify([{ name: "chicken", grams: 150 }])]);
await pool.query(
  `INSERT INTO step_logs (user_id, logged_at, steps, provenance, resolved_day)
   VALUES ($1, now(), 6000, 'client_report', to_char(now() AT TIME ZONE 'Africa/Johannesburg','YYYY-MM-DD'))`,
  [b.id]);
const heldB = await readHeldConstraints(b.phoneNumber, b);
chk(heldB.trainingDeclined === false, "no constraint is invented from silence", JSON.stringify(heldB));
const moveB = await canonicalNextMove(b, { hour: 18 });
chk(moveB.action.kind !== "come_back",
  "a present client is not treated as absent — the absence rung stands down",
  `action=${moveB.action.kind}`);
chk(moveB.action.kind !== moveA.action.kind,
  "the decision genuinely differs once the constraint is gone",
  `declined → ${moveA.action.kind} | present+undeclared → ${moveB.action.kind}`);
chk(moveB.line.trim().length > 0 || moveB.action.kind === "hold",
  "…and it is still a real decision, not an empty one", `action=${moveB.action.kind}`);

// ── §3 ONE OWNER, TWO SCHEDULES: THE SAME STATE DECIDES THE SAME WAY ────────────────────────
//
// chooseAction is consumed by the reactive door (understanding/live, misc-commands) and by the
// proactive senders. Called twice against one unchanged client, it must not drift — a decision
// that depends on WHICH schedule asked is two coaches wearing one name.
REAL("\n§3 the same client state decides the same way, asked twice");
const twice = await canonicalNextMove(a, { hour: 18 });
chk(twice.action.kind === moveA.action.kind, "the action is stable for unchanged state",
  `${moveA.action.kind} vs ${twice.action.kind}`);
chk(twice.held.trainingDeclined === moveA.held.trainingDeclined,
  "…and so are the constraints it read");

// A FOOD CLOSURE BINDS IT TOO — the other half of held-constraints, on the same path.
REAL("\n§3b a closed food day binds the proactive coach as well");
const c = await seed();
await said(c.id, "I'm not eating anything else today");
const heldC = await readHeldConstraints(c.phoneNumber, c);
chk(heldC.foodDayClosed === true, "the closure is read", JSON.stringify(heldC));
const moveC = await canonicalNextMove(c, { hour: 20 });
chk(!/\beat\b|\bmeal\b|protein tonight/i.test(moveC.line) || moveC.action.kind === "hold",
  "the proactive move does not sell food to a client who closed the day",
  `action=${moveC.action.kind} line=${moveC.line.slice(0, 110)}`);

// ── §4 THE ADJUDICATION ITSELF ──────────────────────────────────────────────────────────────
//
// A declaration, graded where declarations live. The six that were LEGACY_LOCAL are named here so
// this file fails if anyone quietly re-adds a local coaching ladder under an old name.
REAL("\n§4 the six adjudicated senders");
const clsOf = (job: string) => PROACTIVE_SENDERS.find(s => s.job === job)?.cls;
const expected: Array<[string, string]> = [
  ["runWeightReminder", "RESOURCE"],
  ["runDietBreakCheck", "OPERATIONAL"],
  ["runSupplementReminder", "RECOGNITION"],
  ["runStepSyncCatchup", "RESOURCE"],
  ["runWeeklyMondayCheckin", "CANONICAL"],
  ["runPlateauDetection", "LEGACY_LOCAL"],
];
for (const [job, cls] of expected) chk(clsOf(job) === cls, `${job} → ${cls}`, `is ${clsOf(job)}`);
const stillLegacy = PROACTIVE_SENDERS.filter(s => s.cls === "LEGACY_LOCAL").map(s => s.job);
chk(stillLegacy.length === 1 && stillLegacy[0] === "runPlateauDetection",
  "exactly one local decider remains, and it is the multi-week experiment", JSON.stringify(stillLegacy));

// ── §5 SCHEDULING, CAPS AND DEDUPE SURVIVE THE MIGRATION ────────────────────────────────────
//
// Converging the instruction must not cost the guarantees that stop one coach becoming three
// messages. The migrated job still claims its daily slot, and a claim is once per client per day.
REAL("\n§5 the daily slot claim still gates the migrated job");
const d = await seed();
const first = await claimDailySlot(d.id, "weekly_checkin");
const second = await claimDailySlot(d.id, "weekly_checkin");
chk(first === true, "the first claim succeeds");
chk(second === false, "the second is refused — a restart cannot double the send");
const e = await seed();
chk((await claimDailySlot(e.id, "weekly_checkin")) === true,
  "and one client's claim does not consume another's");

REAL(`\npg-proactive-authority-acceptance: ${failed === 0 ? "GREEN — all checks passed" : `RED — ${failed} check(s) failed`}`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

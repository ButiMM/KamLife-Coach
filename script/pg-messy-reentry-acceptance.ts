/**
 * REAL-POSTGRESQL ACCEPTANCE — one messy multi-day catch-up becomes one coaching turn (#229).
 *
 * A fixture cannot prove date placement, correction isolation, or compare-and-set closure of an
 * older coaching loop. Every client message below enters through production handleMessage and
 * every truth claim is read back from PostgreSQL.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-messy-reentry-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
const { joinComebackAcknowledgement } = await import("../server/routes/whatsapp");
const { ensureOpenTrainingLoop } = await import("../server/memory");
const { readOpenTrainingLoop } = await import("../server/workout-feedback");
const { sastDayKey, sastDayKeyBefore } = await import("../server/sast");
const { eq } = await import("drizzle-orm");

let failed = 0;
const ids: string[] = [];
function check(ok: boolean, claim: string, evidence = "") {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${claim}${!ok && evidence ? `\n          ${evidence}` : ""}`);
}
const dayName = (daysBack: number) => new Intl.DateTimeFormat("en-ZA", {
  timeZone: "Africa/Johannesburg", weekday: "long",
}).format(new Date(Date.now() - daysBack * 86_400_000));
const noon = (day: string) => new Date(`${day}T12:00:00+02:00`);
const dayOf = (value: Date | string) => sastDayKey(new Date(value));
const WELCOME = /welcome back|good to (?:have|see) you|you(?:'|’)re back|glad you(?:'|’)re back|where you left off/i;

async function client(name: string, lastActiveDays = 5) {
  const phone = `whatsapp:+2792${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [user] = await db.insert(schema.users).values({
    phoneNumber: phone, name, onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss",
    calorieTarget: 2100, proteinTarget: 140, stepsTarget: 8000,
    trainingMode: "gym", trainingDaysPerWeek: 3, programmeWeek: 4, programmeDayInWeek: 1,
    currentWeight: "84.0", heightCm: 178, gender: "male", age: 35,
    totalWorkoutsCompleted: 10, createdAt: noon(sastDayKeyBefore(50)),
    programmeStartDate: noon(sastDayKeyBefore(50)), lastActiveAt: noon(sastDayKeyBefore(lastActiveDays)),
  } as any).returning();
  ids.push(user.id);
  return user;
}
const ask = (user: any, text: string, sid: string) =>
  handleMessage(user.phoneNumber, text, undefined, undefined, undefined, sid).then(r => String(r || ""));
const rows = (table: string, userId: string) => pool.query(
  `SELECT * FROM ${table} WHERE user_id = $1 ORDER BY logged_at ASC`, [userId],
).then(r => r.rows);
const mealSnapshot = (row: any) => JSON.stringify({
  id: row.id, logged_at: new Date(row.logged_at).toISOString(), meal_label: row.meal_label,
  kcal_int: row.kcal_int, protein_int: row.protein_int, items: row.items,
  source_message_id: row.source_message_id, corrected: row.corrected, raw_message: row.raw_message,
});
const itemNames = (row: any) => (Array.isArray(row?.items) ? row.items : []).map((i: any) => String(i.name));

const d4 = sastDayKeyBefore(4), d3 = sastDayKeyBefore(3), d2 = sastDayKeyBefore(2), today = sastDayKey();
const n4 = dayName(4), n3 = dayName(3), n2 = dayName(2);

REAL("\n=== 1–6 · THE REAL INCONSISTENT CLIENT RETURNS ===");
const user = await client("Catchup");
const open = await ensureOpenTrainingLoop(user, d2, "reactive", Date.now() - 2 * 86_400_000);
const catchup = [
  `I'm back after a few days. ${n4} breakfast I had eggs and toast.`,
  `${n3} I walked 6400 steps and I can't remember lunch.`,
  `${n2} I felt flat because work was chaos, but I did the workout you told me to do.`,
  "Today breakfast I had pap and chicken. What should I do today?",
].join(" ");
const reply = await ask(user, catchup, "SM-catchup-229");
await new Promise(resolve => setTimeout(resolve, 120));

const meals = await rows("meal_logs", user.id);
const steps = await rows("step_logs", user.id);
const workouts = await rows("workout_logs", user.id);
const [after] = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
const constraints = (await pool.query(
  `SELECT day, kind, state, via, source_message_id FROM daily_constraints WHERE user_id = $1`, [user.id],
)).rows;
const turns = (await pool.query(
  `SELECT input_text, reply, mutations FROM turn_ledger WHERE user_id = $1 ORDER BY created_at DESC`, [user.id],
)).rows;

check(meals.length === 2 && meals.map((r: any) => dayOf(r.logged_at)).sort().join() === [d4, today].sort().join(),
  "only the two supported meals land, on their exact SAST days",
  meals.map((r: any) => `${dayOf(r.logged_at)}:${itemNames(r).join("+")}`).join(" | "));
check(!meals.some((r: any) => dayOf(r.logged_at) === d3),
  "'I can't remember lunch' remains unknown — no meal or calorie is fabricated");
check(steps.length === 1 && dayOf(steps[0].logged_at) === d3 && Number(steps[0].steps) === 6400,
  "the historical step count keeps its own named day", JSON.stringify(steps));
check(workouts.length === 1 && dayOf(workouts[0].logged_at) === d2,
  "the late workout keeps its own named day", JSON.stringify(workouts));
check(!readOpenTrainingLoop(after.awaitingInputType),
  "the matching older #208 loop closes exactly once", String(after.awaitingInputType));
check(constraints.filter((r: any) => r.kind === "training" && r.state === "released"
    && r.day === d2 && r.source_message_id === "SM-catchup-229").length === 1,
  "the outcome is attributed once through the existing loop owner", JSON.stringify(constraints));
check((reply.match(new RegExp(WELCOME.source, "gi")) || []).length <= 1,
  "the re-entry turn contains at most one comeback acknowledgement", JSON.stringify(reply.slice(0, 240)));
const delivered = joinComebackAcknowledgement("You came back — that's the real streak. 💛\n\n", reply);
check((delivered.match(new RegExp(WELCOME.source, "gi")) || []).length === 1,
  "the real delivery join adds exactly one acknowledgement to a contentful catch-up");
check(joinComebackAcknowledgement("You came back.\n\n", "Catchup, welcome back. Carry on.")
    === "Catchup, welcome back. Carry on.",
  "CONTROL: delivery never duplicates a welcome already owned by the canonical reply");
check(!/start (?:again|over)|week 1|session 1 of|no catching up|just today/i.test(reply),
  "catch-up does not restart or deny the history the client supplied", JSON.stringify(reply.slice(0, 300)));
check(/Logged 2 days/i.test(reply) && /6[,.]?400 steps/i.test(reply) && /session/i.test(reply),
  "one reply reflects the supported multi-domain reconstruction", JSON.stringify(reply.slice(0, 500)));
check(/Heard you on how you're feeling/i.test(reply),
  "the final turn hears the contextual feeling rather than reducing it to rows", JSON.stringify(reply.slice(0, 500)));
check(/stand on a scale|protein|\bwalk\b|get today'?s session|nothing new today|rest today/i.test(reply)
    && reply.split("\n\n---\n\n").length === 1,
  "the result carries today's canonical next decision in one WhatsApp reply, not a terminal receipt",
  JSON.stringify(reply.slice(0, 500)));
check(turns.length === 1 && JSON.stringify(turns[0].mutations || []).includes(open?.ref || "missing-ref")
    && String(turns[0].reply || "") === reply,
  "the turn ledger reconstructs the loop resolution and exact delivered reply", JSON.stringify(turns[0] || {}));

REAL("\n=== 4 · A NAMED-DAY CORRECTION TOUCHES ONE HISTORICAL FACT ===");
const before = await rows("meal_logs", user.id);
const neighborBefore = new Map(before.filter((r: any) => dayOf(r.logged_at) !== d4)
  .map((r: any) => [r.id, mealSnapshot(r)]));
const targetBefore = before.find((r: any) => dayOf(r.logged_at) === d4);
await ask(user, `${n4} wasn't toast, it was oats.`, "SM-catchup-correction-229");
const corrected = await rows("meal_logs", user.id);
const targetAfter = corrected.find((r: any) => dayOf(r.logged_at) === d4);
check(corrected.length === before.length && targetAfter?.id === targetBefore?.id,
  "the correction updates the same named-day row without adding a meal");
check(!itemNames(targetAfter).some((n: string) => /toast/i.test(n))
    && itemNames(targetAfter).some((n: string) => /oats/i.test(n)),
  "the denied food is replaced by the supported correction", JSON.stringify(itemNames(targetAfter)));
check(corrected.filter((r: any) => dayOf(r.logged_at) !== d4)
    .every((r: any) => mealSnapshot(r) === neighborBefore.get(r.id)),
  "every neighboring meal fact remains byte-identical");

REAL("\n=== 5 + 7 · CONTINUITY AND OVER-FIRE CONTROLS ===");
const next = await ask(user, "what should I eat", "SM-catchup-next-229");
check(!WELCOME.test(next), "the next turn does not repeat disappearance or comeback framing", JSON.stringify(next.slice(0, 220)));
const quiet = await client("Quiet", 1);
const quietReply = await ask(quiet, "Today I had eggs and toast for breakfast.", "SM-daily-229");
const quietMeals = await rows("meal_logs", quiet.id);
check(quietMeals.length === 1 && dayOf(quietMeals[0].logged_at) === today,
  "CONTROL: an ordinary daily report remains an ordinary single-day write");
check(!WELCOME.test(quietReply) && !/logged \d+ days/i.test(quietReply),
  "CONTROL: one quiet day is not labelled multi-day re-entry", JSON.stringify(quietReply.slice(0, 240)));

REAL(`\n${failed === 0
  ? "pg-messy-reentry-acceptance: GREEN — all checks passed"
  : `pg-messy-reentry-acceptance: RED — ${failed} check(s) failed`}`);

for (const id of ids) {
  for (const table of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_logs",
    "chat_history", "turn_ledger", "shadow_replies", "daily_sends", "daily_constraints",
    "client_understanding", "client_truth_commits"]) {
    await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query("DELETE FROM users WHERE id = $1", [id]).catch(() => {});
}
await pool.end();
process.exit(failed === 0 ? 0 : 1);

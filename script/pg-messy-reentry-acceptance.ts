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
process.env.SHADOW = "on";
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
const { processTextAsync } = await import("../server/routes/whatsapp");
const { ensureOpenTrainingLoop } = await import("../server/memory");
const { readOpenTrainingLoop } = await import("../server/workout-feedback");
const { resolveReentry } = await import("../server/understanding/reentry");
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
const WELCOME = /welcome back|good to (?:have|see) you|you came back|you(?:'|’)re back|glad you(?:'|’)re back|where you left off/i;
const GENERIC_COMEBACK_TEMPLATE = /\*To get back into it:\*|Tell me what you've eaten today \(even if it wasn't great\)|No guilt\. No catching up\. Just today/i;

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
const open = await ensureOpenTrainingLoop(user, d2, "reactive", Date.now() - 36 * 3_600_000);
const catchup = [
  `I'm back after a few days. ${n4} breakfast I had eggs and rice.`,
  `${n3} I walked 6400 steps and I can't remember lunch.`,
  `${n2} I felt flat because work was chaos, but I did the workout you told me to do.`,
  "Today breakfast I had pap and chicken. What should I do today?",
].join(" ");
const reentryBefore = resolveReentry({ lastActiveAt: user.lastActiveAt, message: catchup });
check((reentryBefore.daysSinceLastContact ?? 0) >= 3 && reentryBefore.shouldHandleComeback,
  "the acceptance client is returning after at least three days with an explicit catch-up message",
  JSON.stringify(reentryBefore));
await processTextAsync(user.phoneNumber, catchup, null, null, [], handleMessage, "SM-catchup-229");
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
const outbound = (await pool.query(
  `SELECT body FROM shadow_replies WHERE user_id = $1 AND channel = 'reply' ORDER BY id DESC LIMIT 1`, [user.id],
)).rows;
const reply = String(turns[0]?.reply || "");
const finalBody = String(outbound[0]?.body || "");

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
check(finalBody.length > 0,
  "the four-day re-entry produces a final customer-visible outbound body after WhatsApp processing");
check((finalBody.match(new RegExp(WELCOME.source, "gi")) || []).length === 1,
  "the authoritative response composer adds one warm return acknowledgement after interpretation",
  JSON.stringify(finalBody.slice(0, 300)));
check(!/start (?:again|over)|week 1|session 1 of|no catching up|just today/i.test(finalBody),
  "final outbound does not restart or deny the history the client supplied", JSON.stringify(finalBody.slice(0, 300)));
check(!/no catch-up needed|we start from today/i.test(finalBody),
  "final outbound contains neither 'No catch-up needed' nor 'we start from today'",
  JSON.stringify(finalBody.slice(0, 300)));
check(!GENERIC_COMEBACK_TEMPLATE.test(finalBody),
  "a contentful multi-day catch-up does not terminate in the generic three-step comeback template",
  JSON.stringify(finalBody.slice(0, 500)));
check(/Logged 2 days/i.test(finalBody) && /6[,.]?400 steps/i.test(finalBody) && /session/i.test(finalBody),
  "final outbound reflects the supported multi-domain reconstruction", JSON.stringify(finalBody.slice(0, 500)));
check(/Heard you on how you're feeling/i.test(finalBody),
  "final outbound hears the contextual feeling rather than reducing it to rows", JSON.stringify(finalBody.slice(0, 500)));
const finalParagraph = finalBody.split(/\n\n+/).map((p: string) => p.trim()).filter(Boolean).at(-1) || "";
check(/stand on a scale|protein|\bwalk\b|get today'?s session|nothing new today|rest today/i.test(finalParagraph)
    && finalBody.split("\n\n---\n\n").length === 1,
  "final outbound carries one coaching move for today in one coherent WhatsApp response",
  JSON.stringify(finalBody.slice(0, 500)));
check(turns.length === 1 && JSON.stringify(turns[0].mutations || []).includes(open?.ref || "missing-ref")
    && String(turns[0].reply || "") === reply,
  "the turn ledger reconstructs the loop resolution and exact authoritative reply", JSON.stringify(turns[0] || {}));

const nonFood = await client("NonFoodCatchup");
const nonFoodReply = await ask(nonFood,
  `${n3} I walked 5200 steps. ${n2} I did the workout. What should I do today?`,
  "SM-nonfood-catchup-229");
check(/5[,.]?200 steps/i.test(nonFoodReply) && /session/i.test(nonFoodReply)
    && /stand on a scale|tell me what you ate|protein|\bwalk\b|get today'?s session|rest today/i.test(nonFoodReply),
  "a non-food catch-up also reaches today's decision instead of terminating at its receipt",
  JSON.stringify(nonFoodReply.slice(0, 400)));

const cardioCatchup = await client("CardioCatchup", 1);
await ask(cardioCatchup,
  `${n3} I trained. ${n2} I trained and did 30 minutes cardio.`,
  "SM-cardio-catchup-233");
const cardioWorkouts = await rows("workout_logs", cardioCatchup.id);
const [cardioAfter] = await db.select().from(schema.users).where(eq(schema.users.id, cardioCatchup.id)).limit(1);
check(cardioWorkouts.length === 2
    && cardioWorkouts.map((r: any) => dayOf(r.logged_at)).sort().join() === [d3, d2].sort().join()
    && !cardioWorkouts.some((r: any) => dayOf(r.logged_at) === today),
  "historical cardio catch-up writes only the two named days, never a third workout today",
  JSON.stringify(cardioWorkouts));
check(Number(cardioAfter.totalWorkoutsCompleted) === 12
    && Number(cardioAfter.programmeWeek) === 4 && Number(cardioAfter.programmeDayInWeek) === 1,
  "historical cardio catch-up preserves today's programme cursor while updating lifetime truth",
  JSON.stringify({ total: cardioAfter.totalWorkoutsCompleted, week: cardioAfter.programmeWeek, day: cardioAfter.programmeDayInWeek }));

const fuzzyWorkout = await client("FuzzyWorkout", 1);
await ask(fuzzyWorkout,
  `${n4} I had eggs. ${n3} I did the workout. ${n2} I had pap.`,
  "SM-fuzzy-workout-229");
const fuzzyMeals = await rows("meal_logs", fuzzyWorkout.id);
check(fuzzyMeals.length === 2
    && fuzzyMeals.map((r: any) => dayOf(r.logged_at)).sort().join() === [d4, d2].sort().join()
    && !fuzzyMeals.some((r: any) => dayOf(r.logged_at) === d3),
  "a workout phrase between food days never becomes a fuzzy pre-workout meal",
  fuzzyMeals.map((r: any) => `${dayOf(r.logged_at)}:${itemNames(r).join("+")}`).join(" | "));

REAL("\n=== 4 · A NAMED-DAY CORRECTION TOUCHES ONE HISTORICAL FACT ===");
const before = await rows("meal_logs", user.id);
const neighborBefore = new Map(before.filter((r: any) => dayOf(r.logged_at) !== d4)
  .map((r: any) => [r.id, mealSnapshot(r)]));
const targetBefore = before.find((r: any) => dayOf(r.logged_at) === d4);
await ask(user, `${n4}: no rice, add oats.`, "SM-catchup-correction-229");
const corrected = await rows("meal_logs", user.id);
const targetAfter = corrected.find((r: any) => dayOf(r.logged_at) === d4);
check(corrected.length === before.length && targetAfter?.id === targetBefore?.id,
  "the correction updates the same named-day row without adding a meal");
check(!itemNames(targetAfter).some((n: string) => /rice/i.test(n))
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
const questions = await client("Questioner", 1);
await ask(questions, `${n4} can I eat eggs? ${n3} what about rice?`, "SM-food-questions-229");
check((await rows("meal_logs", questions.id)).length === 0,
  "CONTROL: named-day food questions do not become catch-up meal rows");
const statusQuestion = await client("StatusQuestion", 1);
await ask(statusQuestion,
  `${n4} eggs. ${n3} toast. ${n2} pap. Are those logged?`,
  "SM-food-status-233");
check((await rows("meal_logs", statusQuestion.id)).length === 0,
  "a batch status question stays read-only when its named-day segments do not explicitly report eating");

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

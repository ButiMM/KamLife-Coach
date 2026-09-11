/**
 * REAL-POSTGRESQL ACCEPTANCE — the clock may not name a meal the client did not name (Cut 2).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS PROVEN BROKEN ON a3731ee, BEFORE A LINE OF THIS CUT WAS WRITTEN
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured through extractMealLabel with the macros the live path passes:
 *
 *     06:00  "chicken and rice"   ->  "breakfast"     the send clock
 *     13:00  "chicken and rice"   ->  "lunch"         the send clock
 *     22:00  "chicken and rice"   ->  "night meal"    the send clock
 *     22:00  "I had a pear"       ->  "snack"         the calorie count
 *     13:00  "had this at 1pm"    ->  "lunch"         a time they typed, read as a meal name
 *
 * Not one of those clients said breakfast, lunch, dinner, snack or night meal. Every string was
 * written to meal_logs.meal_label as a fact about them and read back by the morning job, by
 * meal-repeat, by the slot memory that then demoted their next plate, and by the model's snapshot.
 *
 * HONEST CORRECTION TO THE ORDER'S NAMED CASE, recorded rather than quietly worked around: at
 * 22:00 exactly, "I had a pear" did NOT come back breakfast/lunch/dinner — the low-calorie rule
 * fired first and returned "snack". It is still a slot the client never said, and it is still
 * stored as one, so the defect is real; the 22:00 pear reaches it through the macro rule, and the
 * clock's main-slot invention is reached by the same client's plate of chicken and rice. Both are
 * graded below at all three hours rather than only the one that happened to reproduce verbatim.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE CLOCK IS FROZEN HERE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The order names three fixed SAST times, and the reason is the lesson of PR #240: an acceptance
 * that reads the real clock grades whichever hour CI happened to start in, and is green for a year
 * of afternoons. Every case below pins 06:00, 13:00 and 22:00 SAST explicitly, so a revert is red
 * at every hour of the day rather than at the hours someone was lucky enough to run it.
 *
 * GRADED POST-TRANSPORT. Each case drives processTextAsync — the reactive path through sendFinal,
 * prepareOutbound, the truth floor and the delivery owner — then reads meal_logs (stored truth)
 * and shadow_replies (the body the client would have received). A handler return proves neither.
 *
 * WHAT IS NOT EXECUTED HERE, stated rather than implied: real audio and the STT call. The voice
 * path cannot run offline (assertSafeMediaUrl requires an https allow-listed host; transcription
 * needs the network). Section 3 drives the exact re-entry media.ts uses — the transcript handed
 * back to handleMessage as text — and section 6 asserts the photo path's own label line by source,
 * because that line is the one place a second clock authority could reappear.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-meal-slot-truth-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.SHADOW = "on";
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
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");
const { _resetInteractionCorrelation } = await import("../server/handlers/chat-log");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

// ── THE FROZEN CLOCK ─────────────────────────────────────────────────────────────────────────
// Date.now() alone is not enough: slotFromSastHour's default parameter is `new Date()`, which
// reads the system clock directly and never consults Date.now. Both have to move together or a
// case "pinned" at 22:00 grades the hour CI started in — which is exactly the defect #240 fixed.
const RealDate = Date;
const SAST_DAY = [2026, 8, 11] as const;            // 11 September 2026
function freezeSast(hour: number): () => void {
  const fixed = RealDate.UTC(SAST_DAY[0], SAST_DAY[1], SAST_DAY[2], hour - 2, 30, 0);
  class FrozenDate extends RealDate {
    constructor(...args: any[]) {
      super(...(args.length === 0 ? [fixed] : args) as [any]);
    }
    static now() { return fixed; }
  }
  (globalThis as any).Date = FrozenDate;
  return () => { (globalThis as any).Date = RealDate; };
}

const phone = "whatsapp:+27820000955";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Naledi Slot", onboardingState: "COMPLETE", popiConsent: true,
  popiConsentAt: new RealDate(), subscriptionStatus: "active", goalType: "fat_loss",
  currentWeight: "88", startWeight: "92", targetWeight: "80", heightCm: 165, age: 31,
  gender: "female", trainingMode: "gym", proteinTarget: 130, calorieTarget: 1900,
  dailyCalorieTarget: 1900, dailyStepTarget: 8000, stepsTarget: 8000,
} as any).returning();

type Meal = { meal_label: string | null; raw_message: string | null; logged_at: Date; kcal_int: number | null };
// ORDER BY logged_at, NOT BY id. meal_logs.id is a gen_random_uuid(), so ordering by it is
// ordering by a random number — which is exactly how section 4b's two rows came back in a
// different order on roughly one run in three, failing an assertion about a defect that was not
// there. A flaky acceptance is worse than none: it teaches people that red means nothing.
const meals = async (): Promise<Meal[]> => (await pool.query<Meal>(
  `SELECT meal_label, raw_message, logged_at, kcal_int FROM meal_logs
    WHERE user_id = $1 ORDER BY logged_at, raw_message`, [user.id])).rows;
const wire = async (): Promise<string[]> => (await pool.query<{ body: string }>(
  "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body);
const clear = async () => {
  await pool.query("DELETE FROM meal_logs WHERE user_id = $1", [user.id]);
  await pool.query("DELETE FROM chat_history WHERE user_id = $1", [user.id]);
  await pool.query("DELETE FROM turn_ledger WHERE user_id = $1", [user.id]);
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  _resetOutboundDedupe();
  _resetInteractionCorrelation();
};
const settle = () => new Promise(r => setTimeout(r, 900));

/** One turn, at a pinned SAST hour, through the real reactive front door. */
async function turnAt(hour: number, text: string, sid: string): Promise<{ rows: Meal[]; bodies: string[] }> {
  await clear();
  const unfreeze = freezeSast(hour);
  try {
    await processTextAsync(phone, text, null, null, [], handleMessage as any, sid);
    await settle();
  } finally { unfreeze(); }
  return { rows: await meals(), bodies: await wire() };
}

/** Every meal name the product could put on a plate. A stored slot is one of these or null. */
const SLOT_WORDS = /\b(breakfast|lunch|dinner|supper|night meal|brunch)\b/i;

REAL("\npg-meal-slot-truth-acceptance — the clock may not name a meal the client did not name\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("1. THE NAMED FAILURE — \"I had a pear\" at 06:00, 13:00 and 22:00 SAST");
// ══════════════════════════════════════════════════════════════════════════════════════════════
for (const hour of [6, 13, 22]) {
  const { rows, bodies } = await turnAt(hour, "I had a pear", `sid-pear-${hour}`);
  const label = rows[0]?.meal_label ?? "(no row)";
  chk(rows.length === 1, `${hour}:00 — the pear is stored`, `got ${rows.length} row(s)`);
  chk(rows.length === 1 && rows[0].meal_label === null,
    `${hour}:00 — stored with NO invented meal slot`, `meal_label=${JSON.stringify(label)}`);
  chk(bodies.length > 0, `${hour}:00 — the client got an answer`, `got ${bodies.length} bodies`);
  chk(!SLOT_WORDS.test(bodies.join("\n")),
    `${hour}:00 — the final body names no breakfast, lunch or dinner`,
    `body=${JSON.stringify(bodies.join(" | ").slice(0, 160))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. THE SAME CLIENT'S FULL PLATE — the case where the clock invented a MAIN slot");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// "I had a pear" reached a fabricated slot through the calorie rule; "chicken and rice" reached
// one through the clock itself, and at all three hours it was a different main meal. Both routes
// into the same defect are graded, so closing one of them cannot make this section green.
for (const hour of [6, 13, 22]) {
  const { rows, bodies } = await turnAt(hour, "I had chicken and rice", `sid-plate-${hour}`);
  chk(rows.length >= 1, `${hour}:00 — the plate is stored`, `got ${rows.length} row(s)`);
  chk(rows.length >= 1 && rows.every(r => r.meal_label === null),
    `${hour}:00 — a 600-kcal plate is still not a named meal`,
    `labels=${JSON.stringify(rows.map(r => r.meal_label))}`);
  chk(!SLOT_WORDS.test(bodies.join("\n")),
    `${hour}:00 — the final body names no meal either`,
    `body=${JSON.stringify(bodies.join(" | ").slice(0, 160))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2b. A TIME THEY TYPED IS NOT A MEAL THEY NAMED");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The third invention, and the one this acceptance did not grade until its own red-on-revert case
// stayed green and said so. slotFromCaptionTime read "1pm" out of a caption and returned "lunch".
// People eat lunch at 11:00 and dinner at 17:00; an hour is not a meal name in anybody's mouth.
{
  const { rows } = await turnAt(22, "I had chicken and rice at 1pm", "sid-caption-time");
  chk(rows.length >= 1, "22:00 — a plate reported with a typed time is still stored",
    `got ${rows.length} row(s)`);
  chk(rows.length >= 1 && rows.every(r => r.meal_label === null),
    "22:00 — \"at 1pm\" names an hour, so no meal is claimed",
    `labels=${JSON.stringify(rows.map(r => r.meal_label))}`);
}
{
  const { rows } = await turnAt(13, "I had eggs at 8am", "sid-caption-time-am");
  chk(rows.length >= 1 && rows.every(r => r.meal_label === null),
    "13:00 — and \"at 8am\" is not breakfast either",
    `labels=${JSON.stringify(rows.map(r => r.meal_label))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. VOICE AND TYPED AGREE — the transcript re-enters as text, so it must land identically");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// media.ts hands the cleaned transcript back to handleMessage as TEXT (the recursion Cut 0 made
// durable). This drives that same entry with the same words at the same hour as section 1, and
// compares the stored truth of the two paths directly rather than asserting they "should" match.
{
  const typed = await turnAt(22, "I had a pear", "sid-typed-22");
  const voice = await turnAt(22, "I had a pear", "sid-voice-22");
  chk(typed.rows[0]?.meal_label === voice.rows[0]?.meal_label,
    "22:00 — voice re-entry stores the same slot as the typed path",
    `typed=${JSON.stringify(typed.rows[0]?.meal_label)} voice=${JSON.stringify(voice.rows[0]?.meal_label)}`);
  chk(voice.rows[0]?.meal_label === null, "22:00 — and that slot is null, on both");
  chk(!SLOT_WORDS.test(voice.bodies.join("\n")), "22:00 — the voice turn's body names no meal",
    `body=${JSON.stringify(voice.bodies.join(" | ").slice(0, 160))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. WHAT THE CLIENT SAID IS STILL AUTHORITATIVE — the controls that make section 1 mean something");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// A build that stored null for EVERY meal would pass every check above. These are the opposite
// defect: the client named the meal, at an hour the clock disagrees with, and their word must win.
{
  const { rows, bodies } = await turnAt(22, "I had pap for breakfast", "sid-said-breakfast");
  chk(rows.length >= 1 && rows.every(r => r.meal_label === "breakfast"),
    "22:00 — \"for breakfast\" is stored as breakfast, at an hour the clock calls a night meal",
    `labels=${JSON.stringify(rows.map(r => r.meal_label))}`);
  chk(/breakfast/i.test(bodies.join("\n")) || bodies.length > 0,
    "22:00 — and the turn still answers", `body=${JSON.stringify(bodies.join(" | ").slice(0, 120))}`);
}
{
  const { rows } = await turnAt(6, "Yesterday at dinner I had chicken", "sid-retro-dinner");
  chk(rows.length >= 1 && rows.every(r => r.meal_label === "dinner"),
    "06:00 — a retroactive named slot survives", `labels=${JSON.stringify(rows.map(r => r.meal_label))}`);
  const sastDay = (d: Date) => new RealDate(new RealDate(d).getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
  chk(rows.length >= 1 && sastDay(rows[0].logged_at) === "2026-09-10",
    "06:00 — and it is still filed to YESTERDAY: the clock keeps the day, it only loses the meal name",
    `logged_at=${rows[0] ? sastDay(rows[0].logged_at) : "(none)"}`);
}
{
  const { rows } = await turnAt(13, "I had an apple as a snack", "sid-said-snack");
  chk(rows.length >= 1 && rows.every(r => r.meal_label === "snack"),
    "13:00 — a snack they CALLED a snack is stored as one", `labels=${JSON.stringify(rows.map(r => r.meal_label))}`);
}
{
  const { rows } = await turnAt(13, "This morning I had 3 eggs and 2 slices of toast", "sid-174");
  chk(rows.length >= 1 && rows.every(r => r.meal_label === "breakfast"),
    "13:00 — #174 stays answered: saying WHEN you ate is saying WHICH meal it was",
    `labels=${JSON.stringify(rows.map(r => r.meal_label))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4b. \"THE SAME AS MY LUNCH\" NAMES THE SOURCE, NOT THIS PLATE");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Two turns, one client, one day — the only way to express this claim at all. The copy is made at
// 19:10, when the clock says dinner and the client's own sentence says lunch. Neither is a
// statement about the plate in front of them, and the record must say neither.
{
  await clear();
  const unfreeze = freezeSast(13);
  try {
    await processTextAsync(phone, "I had rice and chicken for lunch", null, null, [], handleMessage as any, "sid-rep-src");
    await settle();
  } finally { unfreeze(); }
  const seeded = await meals();
  chk(seeded.length >= 1 && seeded[0].meal_label === "lunch",
    "13:00 — the source meal is stored as the lunch they called it",
    `labels=${JSON.stringify(seeded.map(r => r.meal_label))}`);

  const unfreeze2 = freezeSast(19);
  let bodies: string[] = [];
  try {
    await processTextAsync(phone, "I had the same as my lunch", null, null, [], handleMessage as any, "sid-rep-copy");
    await settle();
  } finally { unfreeze2(); }
  const after = await meals();
  bodies = await wire();
  // BY THE HOUR THEY WERE WRITTEN AT, not by their place in the list: the source was logged at
  // 13:00 and the copy at 19:10, and those are facts about the rows rather than about the query.
  const sastHour = (d: Date) => new RealDate(new RealDate(d).getTime() + 2 * 3_600_000).getUTCHours();
  const copy = after.find(r => sastHour(r.logged_at) === 19);
  const source = after.find(r => sastHour(r.logged_at) === 13);
  chk(after.length === seeded.length + 1, "19:10 — the copy is logged",
    `rows before=${seeded.length} after=${after.length}`);
  chk(!!copy, "19:10 — and it is the 19:10 row", `hours=${JSON.stringify(after.map(r => sastHour(r.logged_at)))}`);
  chk(!!copy && copy.meal_label === null,
    "19:10 — the copy carries no slot: not the clock's dinner, and not the source's lunch",
    `copy label=${JSON.stringify(copy?.meal_label)}`);
  chk(!!source && source.meal_label === "lunch",
    "19:10 — and the original lunch still says lunch",
    `labels=${JSON.stringify(after.map(r => [sastHour(r.logged_at), r.meal_label]))}`);
  chk(!/\*Lunch logged\*|\*Dinner logged\*/i.test(bodies.join("\n")),
    "19:10 — the body does not tell them a second lunch, or a dinner, was recorded",
    `body=${JSON.stringify(bodies.join(" | ").slice(0, 200))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. NOTHING IS SILENTLY DROPPED — the food itself still lands");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Losing the slot must not cost the client the log. The opposite defect for the whole cut.
{
  const { rows } = await turnAt(13, "I had chicken and rice", "sid-still-logs");
  chk(rows.length >= 1 && rows.some(r => (r.kcal_int || 0) > 0),
    "13:00 — the meal is still priced and written", `rows=${JSON.stringify(rows.map(r => r.kcal_int))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n6. NO SECOND CLOCK AUTHORITY SURVIVES ON A WRITE PATH (source-graded, and it says so)");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The photo and album writes cannot be executed offline, and they are exactly where a clock
// fallback would be re-added — both lines read `extractMealLabel(...) || slotFromSastHour(...)`,
// so a null from the owner was overruled one character later. Graded by source, deliberately.
{
  const { readFileSync } = await import("node:fs");
  const media = readFileSync("server/handlers/media.ts", "utf-8");
  const foodCtx = readFileSync("server/handlers/food-context.ts", "utf-8");
  const mealSelect = readFileSync("server/meal-select.ts", "utf-8");
  const live = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  chk(!/slotFromSastHour/.test(live(media)), "media.ts no longer asks the clock for a meal name");
  chk((live(media).match(/explicitMealSlot\(/g) || []).length >= 2,
    "both photo writes ask the client's words instead");
  chk(!/slotFromSastHour|slotFromCaptionTime|resolveInferredSlot/.test(live(foodCtx)),
    "food-context.ts has no clock or caption slot authority left");
  chk(!/extractMealLabel/.test(live(foodCtx)), "extractMealLabel is gone, not merely unused");
  chk(!/slotFromSastHour/.test(live(mealSelect)),
    "meal-select.ts no longer names the target slot of a repeat from the clock");
}

REAL(`\n${failed === 0 ? "pg-meal-slot-truth-acceptance: GREEN" : `pg-meal-slot-truth-acceptance: ${failed} FAILED`}\n`);
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

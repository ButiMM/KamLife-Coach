/**
 * REAL-POSTGRESQL ACCEPTANCE — a durable log turn is ONE coach speaking (#207).
 *
 * THE FOUNDER COMPLAINT THIS CLOSES. Coach K read like a receipt printer: an acknowledgement
 * written by a handler that knew the client's words and nothing else, then a move appended across
 * a blank line by a ladder that knew day state and nothing about the event. Two subsystems, one
 * bubble. Traced through the real front door before anything changed — one client, one day:
 *
 *     "two eggs and toast for breakfast"  ->  "Got it — Eggs toast. 👌"
 *                                             "Start tomorrow with protein — eggs … at breakfast."
 *     "walked 9000 steps"                 ->  the same instruction, stapled to a step count
 *     "87.4kg this morning"               ->  the same instruction, a third time
 *
 * WHY POSTGRESQL, AND WHY A MULTI-TURN CLIENT. Every claim here is about what a SEQUENCE of
 * durable writes does to the next decision: how many days carry a meal, what today's totals
 * became after this write, whether the instruction has already gone out in this conversation.
 * A fresh fixture per assertion cannot express any of it — the repetition defect is invisible to
 * a suite that only ever sends one message per client, which is exactly how it survived.
 *
 * chooseAction remains the sole owner of WHAT the client should do. Nothing in this cut selects,
 * ranks or invents an action; the move arrives decided and is phrased beside the event.
 *
 * EVERY CLAIM IS PAIRED WITH ITS CONTROL. "The coach said less" is trivially satisfied by a coach
 * that stops coaching, which is the opposite defect and the one #203 exists to prevent.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-log-turn-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
let captured: string[] = [];
console.log = console.warn = console.error =
  (...a: any[]) => { captured.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

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

/** One turn through the real front door, with the move the close actually delivered. */
async function say(phone: string, text: string): Promise<{ reply: string; move: string }> {
  captured = [];
  const reply = String(await handleMessage(
    phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 9)}`) || "");
  const marker = captured.filter(l => l.includes("[COACH_TURN] MOVE=")).pop() || "";
  const move = marker ? (marker.split("[COACH_TURN] MOVE=")[1] || "").replace(/\s*\([^)]*\)\s*$/, "").trim() : "";
  return { reply, move };
}

/** An EVIDENCED client: six days of food, steps, two weigh-ins. A real prescription is available,
 *  so nothing receipt-shaped here can be blamed on thin evidence. */
const EV = { meals: [1, 2, 3, 4, 5, 6], weights: [0, 6], steps: [1, 2, 3], workouts: [3] };

REAL("\n=== ONE COACH SPEAKING, NOT ACK + STAPLED RUNG ===");

// ── §1 THE DAY THAT PRODUCED THE COMPLAINT ──────────────────────────────────────────────────
{
  _resetOutboundDedupe();
  const c = await client({}, EV);
  const breakfast = await say(c.phone, "two eggs and toast for breakfast");
  const steps = await say(c.phone, "walked 9000 steps");
  const weight = await say(c.phone, "87.4kg this morning");

  chk(!!breakfast.move,
    "the first durable event of the day carries the canonical move",
    `reply=${JSON.stringify(breakfast.reply)}`);
  // ONE AUTHOR: the move is inside the acknowledgement's paragraph, not a block after it.
  chk(breakfast.reply.trim().split(/\n\s*\n/).length === 1,
    "…and it is one paragraph from one author, not a receipt with a block stapled after it",
    JSON.stringify(breakfast.reply));
  // THE ACKNOWLEDGEMENT NAMES THE FACT THE MOVE TURNS ON. Being told to start tomorrow with
  // protein, seconds after logging breakfast, reads as a coach who never looked at the plate.
  chk(/\b24g protein\b/.test(breakfast.reply),
    "…and the breakfast it is coaching about is named, with the protein this turn actually wrote",
    JSON.stringify(breakfast.reply));

  chk(steps.move === "",
    "the same instruction is not re-issued when a step report arrives moments later",
    `move=${JSON.stringify(steps.move)} reply=${JSON.stringify(steps.reply)}`);
  chk(!steps.reply.includes("Start tomorrow with protein"),
    "…and the customer does not read the breakfast instruction stapled to their step count",
    JSON.stringify(steps.reply));
  chk(steps.reply.trim().length > 0,
    "…and the step report is still acknowledged rather than met with silence",
    JSON.stringify(steps.reply));

  chk(!weight.reply.includes("Start tomorrow with protein"),
    "…nor a third time on the weigh-in two turns later",
    JSON.stringify(weight.reply));
}

// ── §2 A SPARSE CLIENT IS ASKED ONCE, NOT EVERY TURN (#203 and #207 together) ────────────────
{
  _resetOutboundDedupe();
  const c = await client({}, { meals: [1], weights: [0, 4] });
  const steps = await say(c.phone, "walked 8000 steps today");
  const weight = await say(c.phone, "87.4kg this morning");

  chk(/tell me what you ate today/i.test(steps.reply),
    "a sparse client is still asked the one measurement that would unlock coaching (#203 holds)",
    JSON.stringify(steps.reply));
  chk(!/tell me what you ate today/i.test(weight.reply),
    "…and is not asked the identical question again on the very next durable event",
    JSON.stringify(weight.reply));
  chk(weight.reply.trim().length > 0,
    "…while the weigh-in is still acknowledged",
    JSON.stringify(weight.reply));
}

REAL("\n=== CANONICAL TRUTH REACHES THE ACKNOWLEDGEMENT ===");

// ── §3 AN ADVERSE EVENT IS NOT BLINDLY CELEBRATED ───────────────────────────────────────────
//
// 2 445 kcal against a 1 200 kcal target used to read "Got it — Chips, Pap and Beef stew. 👌",
// purely because the acknowledgement author was starved of the comparison. NO NEW RUNG was added
// to chooseAction for being over budget on a cut — that policy gap is real and is reported
// separately. This asserts only that canonical truth reaches the mouth.
{
  _resetOutboundDedupe();
  const c = await client({ calorieTarget: 1200 }, EV);
  const { reply } = await say(c.phone, "I had a huge plate of pap and beef stew and chips for dinner");
  chk(/over your calories for today/i.test(reply),
    "a plate that puts the day over its canonical target says so",
    JSON.stringify(reply));
  chk(!/👌/.test(reply),
    "…and is not given the acknowledgement emoji that means 'nice one'",
    JSON.stringify(reply));
  // CONTROL — the same sentence on a normal target is NOT scolded. Without this, a build that
  // simply deleted the cheerful acknowledgement everywhere would pass the two checks above.
  _resetOutboundDedupe();
  const ok = await client({}, EV);
  const fine = await say(ok.phone, "I had rice and chicken for lunch");
  chk(!/over your calories/i.test(fine.reply),
    "CONTROL: a meal inside the day's calories is never told it went over",
    JSON.stringify(fine.reply));
  chk(/👌/.test(fine.reply),
    "CONTROL: …and still gets the ordinary acknowledgement",
    JSON.stringify(fine.reply));
}

// ── §4 A PLATE WE JUST TOLD THEM TO CHANGE IS NOT A PLATE TO REPEAT ──────────────────────────
//
// One message said "go bean or chicken bunny over mutton — leaner" and, four blocks later,
// "that's one proper protein down — start tomorrow the same way". justAteProteinMeal is grams
// alone, and a bunny chow clears PROPER_PROTEIN_G. The dish's OWN verdict — the existing
// authoritative evaluation, unchanged — now says this turn already asked for a change.
{
  _resetOutboundDedupe();
  const c = await client({}, EV);
  const { reply } = await say(c.phone,
    "I was so stressed at work today I ended up eating a bunny chow and two cokes");
  chk(/leaner|order it smart|not one for you/i.test(reply),
    "the turn still gives the plate the smart-order coaching it always gave",
    JSON.stringify(reply));
  chk(!/start tomorrow the same way|one proper protein down/i.test(reply),
    "…and cannot also call that plate a win to repeat tomorrow",
    JSON.stringify(reply));
  // CONTROL — a plate nobody asked them to change still earns the protein closer, so the fix is
  // about the verdict and not about deleting the sentence.
  _resetOutboundDedupe();
  const good = await client({}, EV);
  const win = await say(good.phone, "grilled chicken breast with broccoli and sweet potato for lunch");
  chk(/one proper protein down/i.test(win.reply),
    "CONTROL: a plate we did NOT ask them to change still earns the protein closer",
    JSON.stringify(win.reply));
}

REAL("\n=== CONTROLS — WHAT MUST NOT CHANGE ===");

// ── §5 EXISTING OWNERSHIP AND CONSTRAINTS ───────────────────────────────────────────────────
{
  // A reply that already owns NEXT keeps exactly one, and is not recomposed: the workout card is
  // not a bare receipt, so the close leaves it alone.
  _resetOutboundDedupe();
  const c = await client({}, EV);
  const w = await say(c.phone, "did my workout today");
  chk(w.move === "",
    "a reply that already owns NEXT is not given a second one",
    `move=${JSON.stringify(w.move)}`);
  chk((w.reply.match(/\?/g) || []).length <= 2 && w.reply.includes("How did it feel"),
    "…and the handler's own question survives untouched",
    JSON.stringify(w.reply));

  // doNotMention stays authoritative through whatever composes the turn.
  _resetOutboundDedupe();
  const q = await client({ doNotMention: "weight" }, EV);
  const dn = await say(q.phone, "I had rice and chicken for lunch");
  chk(!/\b(weigh|scale|kg)\b/i.test(dn.reply),
    "a client who ruled out the scale reads no weight word in a composed turn",
    JSON.stringify(dn.reply));

  // A closed food day is never answered with an instruction to eat.
  _resetOutboundDedupe();
  const f = await client({}, EV);
  await say(f.phone, "I'm not eating anything else today");
  const after = await say(f.phone, "walked 9000 steps");
  chk(!/eat|meal|breakfast/i.test(after.move || ""),
    "a closed food day is never answered with an instruction to eat",
    `move=${JSON.stringify(after.move)}`);

  // NUMERIC ATTRIBUTION. The only figures a composed turn may add are ones the turn itself wrote.
  _resetOutboundDedupe();
  const n = await client({}, EV);
  const meal = await say(n.phone, "I had rice and chicken for lunch");
  const grams = [...meal.reply.matchAll(/(\d+)g protein/g)].map(m => Number(m[1]));
  const [row] = (await pool.query(
    `SELECT protein_int FROM meal_logs WHERE user_id = $1 ORDER BY logged_at DESC LIMIT 1`, [n.id])).rows;
  chk(grams.length > 0 && grams.every(g => g === Number(row.protein_int)),
    "every gram figure in a composed turn is the protein this turn actually wrote",
    `said=${JSON.stringify(grams)} row=${row?.protein_int}`);
  chk(!/average|per day|this week|7 days/i.test(meal.reply),
    "…and no total, average or window the client never asked for came with it",
    JSON.stringify(meal.reply));
}

REAL(`\n${failed === 0 ? "pg-log-turn-acceptance: GREEN — all checks passed" : `pg-log-turn-acceptance: RED — ${failed} check(s) failed`}`);

for (const id of ids) {
  for (const t of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_logs"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
}
await pool.end();
process.exit(failed === 0 ? 0 : 1);

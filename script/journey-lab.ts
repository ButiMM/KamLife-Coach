/**
 * AUTONOMOUS JOURNEY LAB (#170) — six critical journeys through the REAL system.
 *
 * NOT a second test framework. It drives the production front door (handleMessage), reads durable
 * truth back out of real PostgreSQL with SQL, and consults the turn ledger and Coach Health as
 * they already exist. Nothing here owns state, parses a message, or renders a reply.
 *
 * BLOCKING BY CONSTRUCTION. There is no warn(): a known-wrong durable state is a failure, and so
 * is a journey that quietly graded nothing. Every journey must execute at least one check, must
 * produce a final reply on every turn, and must be seen to read and write the database — the
 * harness fails on its own vacuity before it can pass on the product's.
 *
 * Requires DATABASE_URL (the ephemeral acceptance database — see .github/workflows/test.yml).
 */
if (!process.env.DATABASE_URL) {
  console.log("journey-lab: SKIPPED — no DATABASE_URL. These journeys need a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";
process.env.NORMALIZER = process.env.NORMALIZER || "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const OUT = console.log.bind(console);
let LOG: string[] = [];
console.log = console.warn = console.error = (...a: any[]) => { LOG.push(a.map(String).join(" ")); };

const { pool } = await import("../server/db");
const { handleMessage } = await import("../server/routes");
const { sastDayKey, effectiveMealLoggedAt } = await import("../server/sast");
// The instrument's own definition of "no door claimed this", not a copy of it. See admin-turns.ts.
const { FALLBACK_REPLY, buildCoachHealthBrief } = await import("../server/routes/admin-turns");

type Row = Record<string, any>;
let journeyName = "";
let checks = 0, failures: string[] = [];
const journeyChecks: Record<string, number> = {};
const journeyFails: Record<string, string[]> = {};

function ok(condition: boolean, claim: string, evidence = "") {
  checks++; journeyChecks[journeyName] = (journeyChecks[journeyName] || 0) + 1;
  if (!condition) {
    const f = `${journeyName} · ${claim}${evidence ? `\n        ${evidence}` : ""}`;
    failures.push(f); (journeyFails[journeyName] ||= []).push(claim);
    OUT(`    ✗ ${claim}${evidence ? `\n        ${evidence}` : ""}`);
  } else {
    OUT(`    ✓ ${claim}`);
  }
}

const D = (n: number) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d; };

async function freshUser(tag: string, over: Row = {}): Promise<{ id: string; phone: string }> {
  const phone = `whatsapp:+2799${String(Math.floor(Math.random() * 900000) + 100000)}`;
  await pool.query(`DELETE FROM users WHERE phone_number = $1`, [phone]);
  const cols: Row = {
    phone_number: phone, name: "Kam", onboarding_state: "COMPLETE", subscription_status: "active",
    popi_consent: true, popi_consent_at: new Date(), goal_type: "fat_loss",
    calorie_target: 2800, protein_target: 195, steps_target: 8500, current_weight: "84.5",
    height_cm: 178, gender: "male", age: 35, training_mode: "gym", training_days_per_week: 3,
    total_workouts_completed: 24, last_active_at: new Date(), created_at: D(35),
    programme_start_date: D(35), programme_phase: 1, programme_week: 1, programme_day_in_week: 2,
    ...over,
  };
  const keys = Object.keys(cols);
  const r = await pool.query(
    `INSERT INTO users (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
    keys.map(k => cols[k]));
  return { id: r.rows[0].id, phone };
}

const meals = async (uid: string) => (await pool.query(
  `SELECT id, logged_at, meal_label, kcal_int, protein_int, items, source_message_id, corrected
     FROM meal_logs WHERE user_id = $1 ORDER BY logged_at ASC, id ASC`, [uid])).rows;
const stepsOf = async (uid: string) => (await pool.query(
  `SELECT id, logged_at, steps FROM step_logs WHERE user_id = $1 ORDER BY logged_at ASC`, [uid])).rows;
const weights = async (uid: string) => (await pool.query(
  `SELECT id, logged_at, weight FROM weight_logs WHERE user_id = $1 ORDER BY logged_at ASC`, [uid])).rows;
const workouts = async (uid: string) => (await pool.query(
  `SELECT id, logged_at FROM workout_logs WHERE user_id = $1 ORDER BY logged_at ASC`, [uid])).rows;
const ledger = async (uid: string) => (await pool.query(
  `SELECT id, input_text, reply, mutations, created_at FROM turn_ledger WHERE user_id = $1 ORDER BY created_at ASC`, [uid])).rows;
const itemNames = (r: Row) => (Array.isArray(r.items) ? r.items : []).map((i: any) => String(i?.name || ""));
const dayOf = (r: Row) => sastDayKey(new Date(r.logged_at));

/**
 * One real turn through the production front door. Fails the journey if it produces nothing.
 *
 * THE LEDGER LANDS AFTER THE REPLY, DELIBERATELY. recordTurn races the final reply promise before
 * it inserts, so the row is written on the way out and is not there the instant handleMessage
 * resolves. Reading once and calling the gap a missing ledger row was the harness's own bug, and
 * it looked exactly like a product defect: every turn's mutations showed up one turn late. So this
 * WAITS for the row — bounded, and a timeout is still a hard failure, because a turn that never
 * reaches the ledger is a turn nobody can audit afterwards.
 */
async function say(uid: string, phone: string, message: string): Promise<{ reply: string; parts: number; ledgerRow: Row | null }> {
  LOG = [];
  const before = (await ledger(uid)).length;
  const reply = String(await handleMessage(phone, message).catch((e: any) => `__THREW__ ${e?.message}`) ?? "");
  ok(!reply.startsWith("__THREW__"), `the turn did not throw — "${message.slice(0, 46)}"`, reply.slice(0, 160));
  ok(reply.trim().length > 0, `the client received a reply — "${message.slice(0, 46)}"`);
  ok(!/something went wrong on my side|give me a second and try again/i.test(reply),
    `the pipeline did not fall back to its crash apology — "${message.slice(0, 46)}"`, reply.slice(0, 120));
  // AND "I DIDN'T CATCH THAT" IS A FAILURE HERE, NOT A SHRUG. Coach Health already declares this
  // shape an invariant breach; the difference is that there it produces a candidate for a person
  // to weigh, and in a release lane every one of these sentences is a client who said something
  // ordinary and got nothing. Each journey turn below is deliberately ordinary, so there is no
  // "genuinely unparseable message" defence available to any of them.
  ok(!FALLBACK_REPLY.test(reply),
    `an owner claimed the message — "${message.slice(0, 46)}"`, reply.slice(0, 160));
  let rows = await ledger(uid);
  for (let i = 0; i < 60 && rows.length === before; i++) {
    await new Promise(r => setTimeout(r, 50));
    rows = await ledger(uid);
  }
  ok(rows.length > before, `the turn reached the turn ledger — "${message.slice(0, 46)}"`);
  OUT(`    → "${message.slice(0, 70)}"\n      ${reply.replace(/\n/g, " ⏎ ").slice(0, 220)}`);
  return { reply, parts: reply.split("\n\n---\n\n").length, ledgerRow: rows[rows.length - 1] ?? null };
}

async function journey(name: string, fn: () => Promise<void>) {
  journeyName = name;
  OUT(`\n${"═".repeat(78)}\n  ${name}\n${"─".repeat(78)}`);
  const before = checks;
  try { await fn(); }
  catch (e: any) {
    failures.push(`${name} · THREW: ${e?.message}`);
    (journeyFails[name] ||= []).push(`THREW: ${e?.message}`);
    OUT(`    ✗ journey threw: ${e?.message}`);
  }
  // NON-VACUITY: a journey that graded nothing is a failure, not a pass.
  if (checks === before) {
    failures.push(`${name} · graded nothing — the journey ran no assertions`);
    (journeyFails[name] ||= []).push("graded nothing");
    OUT(`    ✗ the journey ran no assertions — a green here would mean nothing`);
  }
}

// ── EVIDENCE HELPERS ────────────────────────────────────────────────────────────────────────
//
// Every journey grades the same three things about durable truth: what changed, that the SAME row
// changed rather than a replacement, and that nothing else did. These are the readers for that.
// They read PostgreSQL, not the logs — the database is authoritative, the logs are commentary.

/** A row reduced to the facts a correction must preserve. Byte-comparable. */
const snapMeal = (r: Row) => JSON.stringify({
  id: r.id, at: new Date(r.logged_at).toISOString(), label: r.meal_label,
  kcal: r.kcal_int, prot: r.protein_int, items: r.items, grp: r.source_message_id, corrected: r.corrected,
});

/** Every durable domain this user owns, in one comparable string. */
async function everything(uid: string): Promise<string> {
  return JSON.stringify({
    meals: (await meals(uid)).map(snapMeal),
    steps: (await stepsOf(uid)).map(r => `${dayOf(r)}=${r.steps}`),
    weights: (await weights(uid)).map(r => `${dayOf(r)}=${r.weight}`),
    workouts: (await workouts(uid)).map(r => `${dayOf(r)}`),
  });
}

/**
 * THE BYSTANDER. A second real client, created and then never spoken to, whose durable state must
 * be identical at the end of every journey. "No unrelated user mutation" is not provable by
 * inspecting the client we are driving — it needs someone else in the database to stay still.
 */
async function bystander(tag: string) {
  const b = await freshUser(`bystander-${tag}`);
  await pool.query(
    `INSERT INTO meal_logs (user_id, logged_at, meal_label, kcal_int, protein_int, items, raw_message, source)
     VALUES ($1, $2, 'lunch', 640, 48, $3, 'bystander baseline', 'sa_scanner')`,
    [b.id, D(1), JSON.stringify([{ name: "chicken", grams: 150 }])]);
  await pool.query(`INSERT INTO step_logs (user_id, logged_at, steps) VALUES ($1, $2, 7100)`, [b.id, D(1)]);
  const before = await everything(b.id);
  return { ...b, assertUntouched: async () =>
    ok(await everything(b.id) === before, "a bystander client's durable state is byte-identical",
       `user ${b.id.slice(0, 8)}`) };
}

/** Did this turn tell the ledger what it wrote? A silent write is an unprovable write. */
const mutated = (t: { ledgerRow: Row | null }, re: RegExp) =>
  (Array.isArray(t.ledgerRow?.mutations) ? t.ledgerRow!.mutations as string[] : []).some(x => re.test(String(x)));
const mutationsOf = (t: { ledgerRow: Row | null }) =>
  JSON.stringify(Array.isArray(t.ledgerRow?.mutations) ? t.ledgerRow!.mutations : []);

/** WhatsApp splits on the block separator. Message count is a client-facing contract. */
const waParts = (reply: string) => reply.split("\n\n---\n\n").length;

// ── JOURNEY 1 · DAILY TRUTH ─────────────────────────────────────────────────────────────────
//
// One client, one day, four domains and a correction. The contract is that each statement lands
// in ITS OWN domain, on TODAY, and that correcting the meal moves the meal and leaves the steps
// and the weight exactly where they were.

await journey("1 · DAILY TRUTH — meals + steps + weight + question, with a correction", async () => {
  const u = await freshUser("daily");
  const by = await bystander("daily");
  const today = sastDayKey(new Date());

  const t1 = await say(u.id, u.phone, "This morning I had 3 eggs and 2 slices of toast");
  const m1 = await meals(u.id);
  ok(m1.length === 1, `the meal was written once (${m1.length} rows)`);
  ok(!!m1[0] && dayOf(m1[0]) === today, `it landed on today's SAST day`, `${m1[0] && dayOf(m1[0])} vs ${today}`);
  ok(!!m1[0] && m1[0].kcal_int > 0 && m1[0].protein_int > 0,
     `the row carries extracted energy and protein`, `${m1[0]?.kcal_int}kcal / ${m1[0]?.protein_int}p`);
  ok(!!m1[0] && itemNames(m1[0]).some(n => /egg/i.test(n)),
     `structured identity survived the write`, JSON.stringify(m1[0] && itemNames(m1[0])));
  ok(!!m1[0] && /breakfast|morning/i.test(String(m1[0].meal_label || "")),
     `the meal slot resolved from "this morning"`, `label=${m1[0]?.meal_label}`);
  ok(mutated(t1, /INSERT meal/i), `the turn ledger carries the meal write`, mutationsOf(t1));

  // …AND THE MORNING MUST BE WHEN THEY ATE (#182). The fix for the slot above was first written
  // to read the whole message, so "I train in the morning; I just had rice" relabelled the rice as
  // breakfast at an evening send time. Graded on the durable row, against a bare report by the
  // same client at the same moment: the two must agree, because neither one says when they ate.
  const over = await freshUser("daily-overfire");
  await say(over.id, over.phone, "I train in the morning; I just had rice");
  const bare = await freshUser("daily-bare");
  await say(bare.id, bare.phone, "I had rice");
  const overRow = (await meals(over.id))[0], bareRow = (await meals(bare.id))[0];
  ok(!!overRow && !!bareRow && overRow.meal_label === bareRow.meal_label,
     `a morning phrase in another clause does not label the food`,
     `"I train in the morning; I just had rice" → ${overRow?.meal_label}, "I had rice" → ${bareRow?.meal_label}`);

  const t2 = await say(u.id, u.phone, "12500 steps today");
  const s2 = await stepsOf(u.id);
  ok(s2.length === 1 && Number(s2[0].steps) === 12500, `steps stored exactly as stated`, JSON.stringify(s2));
  ok(!!s2[0] && dayOf(s2[0]) === today, `steps landed on today`);
  ok(mutated(t2, /steps/i), `the turn ledger carries the step write`, mutationsOf(t2));
  // THE STEP ROW MUST BE TRUSTED, NOT MERELY PRESENT (#184). The provenance trigger threw on
  // every call for months; the row was written and the client answered normally, while canonical
  // state went on filtering their own stated steps as unverified evidence. Nothing above this
  // line can see that — only the column can.
  const prov = (await pool.query(
    `SELECT provenance, resolved_day FROM step_logs WHERE user_id = $1`, [u.id])).rows[0];
  ok(!!prov && prov.provenance === "client_report",
     `the stated steps are recorded as client-reported, not left unverified`,
     `provenance=${prov?.provenance}`);
  ok(!!prov && prov.resolved_day === today, `and resolved to today's SAST day`,
     `resolved_day=${prov?.resolved_day} vs ${today}`);
  ok((await meals(u.id)).length === 1, `a step statement created no meal`);

  const t3 = await say(u.id, u.phone, "I weighed 83.9 this morning");
  const w3 = await weights(u.id);
  ok(w3.length === 1 && Math.abs(Number(w3[0].weight) - 83.9) < 0.001,
     `weight stored exactly as stated`, JSON.stringify(w3));
  ok(mutated(t3, /weight/i), `the turn ledger carries the weight write`, mutationsOf(t3));
  ok((await meals(u.id)).length === 1 && (await stepsOf(u.id)).length === 1,
     `a weight statement touched neither food nor steps`);

  // THE CORRECTION. Same row, different identity — not a second breakfast.
  const beforeMeal = snapMeal((await meals(u.id))[0]);
  const stepsBefore = JSON.stringify(await stepsOf(u.id));
  const weightBefore = JSON.stringify(await weights(u.id));
  const t4 = await say(u.id, u.phone, "Breakfast wasn't toast, it was oats.");
  const m4 = await meals(u.id);
  ok(m4.length === 1, `the correction added no row (${m4.length})`);
  ok(!!m4[0] && m4[0].id === (JSON.parse(beforeMeal).id), `the SAME row was updated, not replaced`);
  ok(!!m4[0] && !itemNames(m4[0]).some(n => /toast/i.test(n)),
     `the denied food is gone`, JSON.stringify(m4[0] && itemNames(m4[0])));
  ok(!!m4[0] && itemNames(m4[0]).some(n => /oat/i.test(n)),
     `the stated food is there`, JSON.stringify(m4[0] && itemNames(m4[0])));
  ok(snapMeal(m4[0]) !== beforeMeal, `the row actually changed`);
  ok(JSON.stringify(await stepsOf(u.id)) === stepsBefore, `steps untouched by a food correction`);
  ok(JSON.stringify(await weights(u.id)) === weightBefore, `weight untouched by a food correction`);
  ok(mutated(t4, /CORRECT|MEAL_AMEND|UPDATE meal/i), `the turn ledger carries the correction`, mutationsOf(t4));

  // THE QUESTION. Read-back: the answer must be built from what the database now holds.
  const t5 = await say(u.id, u.phone, "How am I doing today?");
  ok(!/toast/i.test(t5.reply), `the answer does not repeat the corrected-away food`, t5.reply.slice(0, 200));
  ok(/12\s?500|12500/.test(t5.reply) || /\b\d{3,4}\b/.test(t5.reply),
     `the answer cites the day's real numbers`, t5.reply.slice(0, 240));
  ok((await meals(u.id)).length === 1 && (await stepsOf(u.id)).length === 1,
     `a question mutated nothing`);
  ok(waParts(t5.reply) <= 3, `the answer is at most 3 WhatsApp messages (${waParts(t5.reply)})`);

  await by.assertUntouched();
});

// ── JOURNEY 2 · MULTI-DAY / CORRECTION ──────────────────────────────────────────────────────
//
// A catch-up covering three days, then a correction naming the MIDDLE one. The contract that
// matters is negative: Monday and Wednesday must be byte-identical afterwards. This is the
// #158/#164 shape driven end to end, with a bystander proving isolation reaches past this client.

await journey("2 · MULTI-DAY / CORRECTION — catch up three days, correct the middle one", async () => {
  const u = await freshUser("multiday");
  const by = await bystander("multiday");

  const t1 = await say(u.id, u.phone,
    "Monday I had eggs and toast. Tuesday I had rice and chicken. Wednesday I had pap and livers.");
  const before = await meals(u.id);
  ok(before.length === 3, `three days produced three rows (${before.length})`, JSON.stringify(before.map(dayOf)));
  const days = before.map(dayOf);
  ok(new Set(days).size === 3, `each row landed on its own SAST day`, JSON.stringify(days));
  ok(before.every(r => new Date(r.logged_at).getTime() < Date.now()), `every row is dated in the past`);
  ok(before.every(r => itemNames(r).length > 0), `every day kept its structured identity`,
     JSON.stringify(before.map(itemNames)));
  ok(mutated(t1, /INSERT meal/i), `the turn ledger carries the multi-day writes`, mutationsOf(t1));
  ok(waParts(t1.reply) <= 3, `a three-day catch-up is at most 3 WhatsApp messages (${waParts(t1.reply)})`);

  const byDay = (rs: Row[], key: string) => rs.filter(r => dayOf(r) === key);
  const sorted = [...new Set(days)].sort();
  const [mon, tue, wed] = sorted;
  const monBefore = byDay(before, mon).map(snapMeal).join("|");
  const wedBefore = byDay(before, wed).map(snapMeal).join("|");
  const tueBefore = byDay(before, tue)[0];

  const t2 = await say(u.id, u.phone, "Tuesday wasn't rice, it was pap.");
  const after = await meals(u.id);
  ok(after.length === 3, `the correction added no row (${after.length})`);
  ok(byDay(after, mon).map(snapMeal).join("|") === monBefore, `the day BEFORE the target is byte-identical`);
  ok(byDay(after, wed).map(snapMeal).join("|") === wedBefore, `the day AFTER the target is byte-identical`);
  const tueAfter = byDay(after, tue)[0];
  ok(!!tueAfter && !!tueBefore && tueAfter.id === tueBefore.id, `the SAME middle row was updated, not replaced`);
  ok(!!tueAfter && !itemNames(tueAfter).some(n => /rice/i.test(n)),
     `the middle day no longer holds the denied food`, JSON.stringify(tueAfter && itemNames(tueAfter)));
  ok(!!tueAfter && itemNames(tueAfter).some(n => /pap/i.test(n)),
     `the middle day now holds the stated food`, JSON.stringify(tueAfter && itemNames(tueAfter)));
  ok(!!tueAfter && String(tueAfter.source_message_id || "") === String(tueBefore?.source_message_id || ""),
     `the middle day's event lineage survived the correction`);
  ok(byDay(after, sastDayKey(new Date())).length === 0, `today was neither created nor mutated`);
  ok(mutated(t2, /CORRECT|MEAL_AMEND|UPDATE meal/i), `the turn ledger carries the correction`, mutationsOf(t2));
  ok(waParts(t2.reply) === 1, `a correction is one WhatsApp message (${waParts(t2.reply)})`);

  // OVER-FIRE. A sentence carrying "wasn't" that corrects nothing must move nothing.
  const quiet = await everything(u.id);
  await say(u.id, u.phone, "it wasn't that bad honestly");
  ok(await everything(u.id) === quiet, `a non-correction "wasn't" sentence mutated nothing`);

  await by.assertUntouched();
});

// ── JOURNEY 3 · COMEBACK ────────────────────────────────────────────────────────────────────
//
// Absence is a fact the coach holds, so the SAME words must not produce the same turn from a
// client who has been gone two weeks and one who was here this morning. The control is the whole
// point: without the present-but-sparse client, "the reply mentioned being back" would only prove
// that the words "I'm back" appear in the message.

await journey("3 · COMEBACK — genuine absence vs present-but-sparse, on identical words", async () => {
  const absent = await freshUser("comeback-absent", {
    last_active_at: D(14), created_at: D(90), programme_start_date: D(90), total_workouts_completed: 11,
  });
  const present = await freshUser("comeback-present", {
    last_active_at: new Date(), created_at: D(90), programme_start_date: D(90), total_workouts_completed: 11,
  });
  const by = await bystander("comeback");
  const WORDS = "Hi coach, I'm back. I fell off for two weeks.";

  const a1 = await say(absent.id, absent.phone, WORDS);
  const p1 = await say(present.id, present.phone, WORDS);
  ok(a1.reply !== p1.reply,
     `two weeks away and here this morning do NOT get the same reply to the same words`,
     `absent: ${a1.reply.slice(0, 110)}\n        present: ${p1.reply.slice(0, 110)}`);
  ok(!/\b(disappointed|excuses?|slack(ing|ed)?|lazy)\b/i.test(a1.reply),
     `the returning client is not scolded for the gap`, a1.reply.slice(0, 200));
  ok((await meals(absent.id)).length === 0 && (await workouts(absent.id)).length === 0,
     `a comeback greeting logged nothing`);

  // ABSENCE MUST NOT BREAK THE ORDINARY WORK. The next three turns are the reason someone comes
  // back at all — if the return path swallows a food log, the comeback cost them their day.
  const FOOD = "I had chicken and rice for lunch";
  const a2 = await say(absent.id, absent.phone, FOOD);
  const am = await meals(absent.id);
  ok(am.length === 1, `the returning client's food log landed (${am.length} rows)`);
  // THE DAY THE PRODUCT RESOLVES, NOT THE DAY THE WALL CLOCK SHOWS.
  //
  // This asserted `today` outright and was red every night between 00:00 and 04:59 SAST —
  // including 04:00, which is when the nightly CI cron runs. Nothing was broken: sast.ts says in
  // as many words that "only 00:00–04:59 is ambiguous", and at 03:17 a client saying they had
  // LUNCH is telling us about the day that just ended. The product was right and the check was
  // asserting the wrong thing four hours out of every twenty-four.
  //
  // Asked through effectiveMealLoggedAt, the same owner the write door uses, so the harness cannot
  // hold a second opinion about which day a meal belongs to. It still fails if the comeback path
  // files this log on any other day, on no day, or not at all.
  const expectedDay = sastDayKey(effectiveMealLoggedAt(new Date(), FOOD, "lunch"));
  ok(!!am[0] && dayOf(am[0]) === expectedDay, `it landed on the day the words resolve to`,
     `row ${am[0] && dayOf(am[0])} vs ${expectedDay}`);
  ok(!!am[0] && String(am[0].meal_label || "").toLowerCase() === "lunch",
     `the stated slot was honoured`, `label=${am[0]?.meal_label}`);
  ok(mutated(a2, /INSERT meal/i), `the turn ledger carries the returning client's write`, mutationsOf(a2));

  const a3 = await say(absent.id, absent.phone, "I did my workout today");
  ok((await workouts(absent.id)).length === 1, `the returning client's workout landed`);
  ok(mutated(a3, /workout/i), `the turn ledger carries the workout write`, mutationsOf(a3));

  const a4 = await say(absent.id, absent.phone, "I need help getting going again");
  ok(a4.reply !== a1.reply, `a request for help is not answered by re-sending the welcome-back card`);
  ok((await meals(absent.id)).length === 1 && (await workouts(absent.id)).length === 1,
     `asking for help mutated nothing`);

  ok((await meals(present.id)).length === 0 && (await workouts(present.id)).length === 0,
     `the control client, spoken to once, has no invented rows`);
  await by.assertUntouched();
});

// ── JOURNEY 4 · GROCERY / SWAP ──────────────────────────────────────────────────────────────
//
// A list, then a shop that did not have one item, then an item they already own. The two things
// that must survive every turn are the client's declared constraint and the REST of the list: a
// substitution answers one item, it does not rebuild the week.

await journey("4 · GROCERY / SWAP — a local substitution must not rewrite the list or the constraints", async () => {
  const u = await freshUser("grocery", { dietary_restrictions: "no eggs, no pork" });
  // THE CONTROL, AND IT IS THE POINT. "The list contains no eggs" proves nothing on its own —
  // it is equally true of a list that never had eggs in it. The same turn is put to an otherwise
  // identical client who declared nothing, and the constraint claim is only allowed to count if
  // that client IS offered the thing. Remove the mechanism, and the behaviour must change.
  const free = await freshUser("grocery-unconstrained");
  const by = await bystander("grocery");
  const EGG = /\begg(s|whites?)?\b/i;
  const PORK = /\b(pork|bacon|ham|gammon|rasher|chorizo)\b/i;
  /**
   * WHAT THE LIST OFFERS, NOT WHAT IT MENTIONS. The first draft of this scanned the whole reply
   * and failed on the line "Left off — you told me: halaal, pork" — the coach naming the exclusion
   * it had correctly applied. Scanning for a word cannot tell an offer from a refusal, so this
   * reads the bulleted items, which are the only lines that are an instruction to buy something.
   */
  const offered = (reply: string) => reply.split("\n").filter(l => /^\s*[•\-\*]\s/.test(l));

  const c1 = await say(free.id, free.phone, "shopping list");
  ok(offered(c1.reply).length >= 8, `CONTROL: the unconstrained client gets an itemised list (${offered(c1.reply).length} items)`);
  ok(offered(c1.reply).some(l => EGG.test(l)),
     `CONTROL: and that list DOES offer eggs — so removing them later means something`,
     offered(c1.reply).slice(0, 6).join(" | "));

  const t1 = await say(u.id, u.phone, "shopping list");
  ok(t1.reply.length > 200, `a real list came back (${t1.reply.length} chars)`, t1.reply.slice(0, 160));
  ok(offered(t1.reply).length >= 8, `it is an actual itemised list (${offered(t1.reply).length} items)`);
  ok(!offered(t1.reply).some(l => EGG.test(l)),
     `nothing the list tells them to BUY breaks the declared no-eggs constraint`,
     offered(t1.reply).filter(l => EGG.test(l)).join(" | "));
  ok(!offered(t1.reply).some(l => PORK.test(l)),
     `and nothing it offers breaks the declared no-pork constraint`,
     offered(t1.reply).filter(l => PORK.test(l)).join(" | "));
  ok(/left off|egg|pork/i.test(t1.reply),
     `the constraint is acknowledged rather than silently applied`, t1.reply.slice(0, 300));
  ok((await meals(u.id)).length === 0, `asking for a list logged no food`);
  const listReply = t1.reply;

  // THE SAME CONSTRAINT, ONE DOOR FURTHER IN. A substitution is the coach telling a client to buy
  // something, so it is bound by exactly the constraint the list just honoured. Control first.
  const c2 = await say(free.id, free.phone, "They didn't have chicken at the shop");
  ok(EGG.test(c2.reply),
     `CONTROL: the unconstrained client IS offered eggs as the substitute`, c2.reply.slice(0, 200));

  const quiet = await everything(u.id);
  const t2 = await say(u.id, u.phone, "They didn't have chicken at the shop");
  ok(t2.reply !== listReply, `a substitution ask did not re-send the whole list`);
  ok(t2.reply.length < listReply.length, `the answer is narrower than the list`,
     `${t2.reply.length} vs ${listReply.length} chars`);
  ok(/\b(mince|fish|pilchard|tuna|eggs?|beans?|lentils?|beef|tin fish|soya|mutton|lamb)\b/i.test(t2.reply),
     `it named a substitute that does the same job`, t2.reply.slice(0, 200));
  ok(!EGG.test(t2.reply),
     `the substitute honours the SAME constraint the list honoured`, t2.reply.slice(0, 200));
  ok(!PORK.test(t2.reply), `and does not reach for pork either`, t2.reply.slice(0, 200));
  ok(await everything(u.id) === quiet, `a substitution ask mutated nothing`);

  const t3 = await say(u.id, u.phone, "I already have rice");
  ok(t3.reply !== listReply, `owning an item did not re-send the whole list`);
  ok(await everything(u.id) === quiet, `telling us what they own mutated nothing`);

  // THE LIST IS STILL THE LIST. Asking again after two local changes must not have lost it.
  const t4 = await say(u.id, u.phone, "shopping list");
  ok(t4.reply.length > 200, `the list is still available after the local changes (${t4.reply.length} chars)`);
  ok(!offered(t4.reply).some(l => EGG.test(l) || PORK.test(l)),
     `and still offers nothing that breaks the constraint`,
     offered(t4.reply).filter(l => EGG.test(l) || PORK.test(l)).join(" | "));

  await by.assertUntouched();
});

// ── JOURNEY 5 · TRAINING ────────────────────────────────────────────────────────────────────
//
// Seeing a session, asking how to perform a movement, reporting pain, and only then reporting the
// session as done. Three of those four must write nothing: the count of completed sessions is a
// claim about what the client DID, and asking about a squat is not doing one.

await journey("5 · TRAINING — view, guidance, pain, then the session actually reported", async () => {
  const u = await freshUser("training", { total_workouts_completed: 11 });
  const by = await bystander("training");

  const t1 = await say(u.id, u.phone, "today's workout");
  ok(t1.reply.length > 120, `a session came back (${t1.reply.length} chars)`, t1.reply.slice(0, 160));
  ok((await workouts(u.id)).length === 0, `VIEWING a session did not log one`);

  const t2 = await say(u.id, u.phone, "how do I do a squat properly?");
  ok(t2.reply.length > 80, `movement guidance came back`, t2.reply.slice(0, 160));
  ok((await workouts(u.id)).length === 0, `asking how to squat did not log a session`);
  ok((await meals(u.id)).length === 0, `and did not log food`);

  const t3 = await say(u.id, u.phone, "my knee hurts when I squat");
  ok(t3.reply.length > 60, `the pain report got an answer`, t3.reply.slice(0, 200));
  ok(t3.reply !== t1.reply, `pain is not answered by re-sending the session`);
  ok((await workouts(u.id)).length === 0, `reporting pain did not log a session`);

  const t4 = await say(u.id, u.phone, "I did my workout");
  const w = await workouts(u.id);
  ok(w.length === 1, `the reported session was logged exactly once (${w.length})`);
  ok(!!w[0] && dayOf(w[0]) === sastDayKey(new Date()), `it landed on today`);
  ok(mutated(t4, /workout/i), `the turn ledger carries the workout write`, mutationsOf(t4));
  const [{ total_workouts_completed: total }] = (await pool.query(
    `SELECT total_workouts_completed FROM users WHERE id = $1`, [u.id])).rows;
  ok(Number(total) === 12, `the lifetime session count advanced by exactly one (11 → ${total})`);

  // CONTINUITY. The knee is a fact about this client now, not a sentence that ended with its turn.
  const t5 = await say(u.id, u.phone, "how is my training going?");
  ok(/\b(12|13)\b/.test(t5.reply),
     `the follow-up reflects the session just logged, not the count before it`, t5.reply.slice(0, 200));
  ok((await workouts(u.id)).length === 1, `a follow-up question logged no second session`);

  await by.assertUntouched();
});

// ── JOURNEY 6 · MESSY REAL LIFE ─────────────────────────────────────────────────────────────
//
// How people actually write: South African food names, a feeling, a quantity and a slot in one
// breath, then a correction, then a question. Nothing here is a canonical command, and every fact
// in the message still has to land in its own owner.

await journey("6 · MESSY REAL LIFE — SA phrasing, several facts in one breath, then a fix and a question", async () => {
  const u = await freshUser("messy");
  const by = await bystander("messy");
  const today = sastDayKey(new Date());

  const t1 = await say(u.id, u.phone,
    "Eish coach, today was rough. I had pap and chicken livers for lunch and I walked 6400 steps. Feeling flat.");
  const m1 = await meals(u.id);
  ok(m1.length === 1, `the meal in the middle of the sentence was logged once (${m1.length})`);
  ok(!!m1[0] && dayOf(m1[0]) === today, `it landed on today`);
  const n1 = m1[0] ? itemNames(m1[0]) : [];
  ok(n1.some(n => /pap/i.test(n)), `pap was kept`, JSON.stringify(n1));
  ok(n1.some(n => /liver/i.test(n)), `chicken livers survived as their own food`, JSON.stringify(n1));
  ok(!n1.some(n => /^chicken$/i.test(n)),
     `"chicken livers" was not split into a phantom plain chicken`, JSON.stringify(n1));
  ok(!!m1[0] && String(m1[0].meal_label || "").toLowerCase() === "lunch",
     `the stated slot was honoured`, `label=${m1[0]?.meal_label}`);
  const s1 = await stepsOf(u.id);
  ok(s1.length === 1 && Number(s1[0].steps) === 6400,
     `the steps in the same sentence were stored exactly`, JSON.stringify(s1));
  ok(mutated(t1, /INSERT meal/i) && mutated(t1, /steps/i),
     `the turn ledger carries BOTH writes from the one turn`, mutationsOf(t1));
  ok(waParts(t1.reply) <= 3, `a messy multi-fact note is at most 3 WhatsApp messages (${waParts(t1.reply)})`);

  const beforeMeal = snapMeal(m1[0]);
  const stepsBefore = JSON.stringify(s1);
  const t2 = await say(u.id, u.phone, "Lunch wasn't chicken livers, it was beef mince.");
  const m2 = await meals(u.id);
  ok(m2.length === 1, `the correction added no row (${m2.length})`);
  ok(!!m2[0] && m2[0].id === JSON.parse(beforeMeal).id, `the SAME row was updated`);
  const n2 = m2[0] ? itemNames(m2[0]) : [];
  ok(!n2.some(n => /liver/i.test(n)), `the denied food is gone`, JSON.stringify(n2));
  ok(n2.some(n => /mince|beef/i.test(n)), `the stated food is there`, JSON.stringify(n2));
  ok(n2.some(n => /pap/i.test(n)), `the food they did NOT deny is still there`, JSON.stringify(n2));
  ok(JSON.stringify(await stepsOf(u.id)) === stepsBefore, `steps untouched by a food correction`);

  const t3 = await say(u.id, u.phone, "How much protein must I still eat today?");
  ok(/\d+\s*g|\bg\b/i.test(t3.reply), `the answer carries a protein number`, t3.reply.slice(0, 200));
  ok(!/liver/i.test(t3.reply), `the answer does not cite the corrected-away food`, t3.reply.slice(0, 200));
  ok(await everything(u.id) === JSON.stringify({
    meals: (await meals(u.id)).map(snapMeal),
    steps: (await stepsOf(u.id)).map(r => `${dayOf(r)}=${r.steps}`),
    weights: (await weights(u.id)).map(r => `${dayOf(r)}=${r.weight}`),
    workouts: (await workouts(u.id)).map(r => `${dayOf(r)}`),
  }), `the read-back is stable`);
  ok((await meals(u.id)).length === 1 && (await stepsOf(u.id)).length === 1,
     `the question mutated nothing`);

  await by.assertUntouched();
});

// ── COACH HEALTH OVER EVERY TURN THIS LAB PRODUCED ──────────────────────────────────────────
//
// Not a seventh journey — the same evidence, read by the instrument the operator reads. Coach
// Health grades the turn ledger; the lab has just filled it with six journeys' worth of real
// turns. A known-regression hit here means one of those turns reproduced a defect we already
// merged a fix for, which is exactly the thing a release lane must refuse to ship.
//
// Candidates are deliberately NOT blocking: the module's own contract is that a candidate is
// evidence for a person, never a verdict. They are printed so the run is adjudicable.
journeyName = "7 · COACH HEALTH";
OUT(`\n${"═".repeat(78)}\n  7 · COACH HEALTH — the ledger this lab just wrote, read by the real instrument\n${"─".repeat(78)}`);
const brief: any = await buildCoachHealthBrief(1, "journey_lab");
const exercised = (brief.known || []).reduce((n: number, k: any) => n + (k.exercised || 0), 0);
ok(exercised > 0, `Coach Health actually read the lab's turns (${exercised} exercised)`);
for (const k of brief.known || []) {
  if (k.regressions > 0) ok(false, `known regression re-fired: ${k.label} (${k.fixRef})`, `${k.regressions} of ${k.exercised}`);
}
ok((brief.known || []).every((k: any) => !k.regressions), `no fix we already merged regressed on these turns`);
for (const c of (brief.candidates || []).slice(0, 8)) {
  OUT(`    · candidate ${c.id} [${c.priority}] ${c.label} — ${c.turns} turn(s), ${c.clients} client(s), pattern "${c.pattern}"`);
}

// ── PROOF THE INSTRUMENT CAN FAIL ───────────────────────────────────────────────────────────
//
// Everything above is only worth its green if a red is reachable. Two perturbations, both real:
// one corrupts an actual PostgreSQL row and shows the isolation comparison catches it; the other
// feeds ok() a claim that is false and shows it is recorded rather than shrugged off.
journeyName = "8 · PERTURBATION";
OUT(`\n${"═".repeat(78)}\n  8 · PERTURBATION — the lab proving it is able to go red\n${"─".repeat(78)}`);
{
  const p = await freshUser("perturb");
  await pool.query(
    `INSERT INTO meal_logs (user_id, logged_at, meal_label, kcal_int, protein_int, items, raw_message, source)
     VALUES ($1, $2, 'lunch', 700, 50, $3, 'perturbation baseline', 'sa_scanner')`,
    [p.id, D(2), JSON.stringify([{ name: "rice", grams: 200 }])]);
  const clean = await everything(p.id);
  await pool.query(`UPDATE meal_logs SET kcal_int = 999 WHERE user_id = $1`, [p.id]);
  ok(await everything(p.id) !== clean, `the isolation comparison detects a corrupted row`);
  await pool.query(`UPDATE meal_logs SET kcal_int = 700 WHERE user_id = $1`, [p.id]);
  ok(await everything(p.id) === clean, `and reports identity again once the corruption is undone`);

  // ok() itself, on a claim known to be false. Recorded in a scratch tally so proving the
  // instrument does not fail the run — but if this ever passes silently, the run fails instead.
  const failsBefore = failures.length;
  const realOut = OUT;
  ok(1 + 1 === 3, "__HARNESS SELF-TEST — this claim is false on purpose");
  const recorded = failures.length === failsBefore + 1;
  failures.length = failsBefore;
  (journeyFails[journeyName] || []).pop();
  ok(recorded, `ok() records a false claim as a failure rather than passing it`);
}

// ── VERDICT ─────────────────────────────────────────────────────────────────────────────────
OUT(`\n${"═".repeat(78)}\n  JOURNEY LAB — VERDICT\n${"─".repeat(78)}`);
for (const name of Object.keys(journeyChecks)) {
  const f = (journeyFails[name] || []).length;
  OUT(`  ${f ? "RED  " : "GREEN"}  ${name}  —  ${journeyChecks[name]} check(s)${f ? `, ${f} failed` : ""}`);
}
if (failures.length) {
  OUT(`\n  FIRST DIVERGENCE:\n    ${failures[0]}`);
  if (failures.length > 1) OUT(`\n  (${failures.length - 1} further failure(s) recorded; the first is the one to adjudicate)`);
  for (const f of failures.slice(1)) OUT(`    · ${f}`);
}
OUT(`\njourney-lab: ${failures.length === 0 ? `GREEN — ${checks} checks across ${Object.keys(journeyChecks).length} sections` : `RED — ${failures.length} of ${checks} checks failed`}`);
await pool.end();
process.exit(failures.length === 0 ? 0 : 1);

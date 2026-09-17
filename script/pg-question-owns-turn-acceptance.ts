/**
 * REAL-POSTGRESQL ACCEPTANCE — the question owns the turn (C12).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE GOVERNING CONTRACT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *     A fact stated in one clause is written, whatever the next clause does.
 *     A question riding with that fact is answered, by one mouth, and the fact
 *     it just wrote is never requested back.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS MEASURED ON 33b477f BEFORE A LINE OF THE REPAIR WAS WRITTEN
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *   "I had a pear. What should I do today?"
 *        rows = 0.  Body: "Got it — you ate something. Tell me the items in one line …"
 *        The pear was DELETED by the question, then asked for back.
 *
 *   "I had chicken and rice for lunch. What should I do today?"
 *        row written, body = receipt + "⚠️ I could not price *what, should*".
 *        The question's own words were priced as food; the question went unanswered.
 *
 *   "I had a pear"                      rows = 1.  So the food half works alone.
 *   "What should I do today?"           one move, correct. So the question half works alone.
 *
 * Both halves worked; putting them in one bubble broke both. That is the subject of this file.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TWO DIVERGENCES, NAMED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *   1. food-context's `factOwed` asked journeyMustKeepFacts, which asks parseMessyIntake, which
 *      needs a MEAL WORD before it calls a clause a food report. "I had a pear." has none, so no
 *      fact was owed, the isQuestion veto stood, and the pear was dropped. The journey that DID
 *      work worked by accident: in the "dinner tonight?" phrasing it is the word "dinner" INSIDE
 *      THE QUESTION that flips the bubble parse true.
 *
 *   2. routes.ts asserted `canonicalCloseOwnsQuestion` from looksLikeDirectionRequest — a claim
 *      about what the CLIENT ASKED, under a name that claims what the ACK CONTAINS. composeMessyAck
 *      has no canonical close, so "write then coach" was short-circuited and the receipt shipped
 *      alone. With that removed, buildDailyDirection took the turn instead — four pillars and a
 *      *Log food* button on the turn that had just logged food.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE DOES NOT COVER, STATED RATHER THAN IMPLIED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The coach's PROSE is stubbed (see the fetch stub below) and nothing here grades its wording.
 * What is graded is what the product decides without the model: the stored row, which owner the
 * turn reached, and whether the delivered body demands a fact this turn already wrote. Live
 * authorship remains a production-replay question.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-question-owns-turn-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "0";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

/** The mouth's answer. Deliberately says nothing this file grades — see the header. */
const COACH_ANSWER = "A pear is a fine snack and it is already on your record. Quick protein-first options for a late dinner are plain yoghurt with fruit, or tinned fish on toast.";
const CLASSIFY = `{"intent":"OTHER","confidence":0.85,"canonical":""}`;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  const body = typeof init?.body === "string" ? init.body : "";
  if (url.includes("api.openai.com") && url.includes("/embeddings")) {
    return new Response(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: Array(1536).fill(0) }], model: "text-embedding-3-small", usage: { prompt_tokens: 1, total_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("api.openai.com")) {
    // The classifier and the coach share one endpoint. A single generic stub answers the
    // classifier with prose, which drops the turn into the low-confidence clarify exit and
    // manufactures a "defect" the product does not have (learned the hard way on #92).
    const isClassifier = body.includes("message-understanding brain");
    return new Response(JSON.stringify({
      id: "chatcmpl-c9", object: "chat.completion", created: 1, model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: isClassifier ? CLASSIFY : COACH_ANSWER }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { processTextAsync } = await import("../server/routes/whatsapp");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");
const { _resetInteractionCorrelation } = await import("../server/handlers/chat-log");
const { parseMealDate, sastToday } = await import("../server/utils");
const { explicitMealSlot } = await import("../server/understanding/actions");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

// ── THE FROZEN CLOCK ─────────────────────────────────────────────────────────────────────────
// Both Date.now() and `new Date()` move together: slotFromSastHour and parseMealDate each reach
// for one of them, so freezing only one leaves half the product reading the wall clock.
const RealDate = Date;
const SAST_DAY = [2026, 8, 11] as const;                 // 11 September 2026
const TODAY = "2026-09-11";
const YESTERDAY = "2026-09-10";
function freezeSast(hour: number): () => void {
  const fixed = RealDate.UTC(SAST_DAY[0], SAST_DAY[1], SAST_DAY[2], hour - 2, 30, 0);
  class FrozenDate extends RealDate {
    constructor(...args: any[]) { super(...(args.length === 0 ? [fixed] : args) as [any]); }
    static now() { return fixed; }
  }
  (globalThis as any).Date = FrozenDate;
  return () => { (globalThis as any).Date = RealDate; };
}
/** The SAST calendar day a stored instant belongs to — the unit the client's totals are kept in. */
const dayOf = (d: Date | string): string => {
  const t = new RealDate(d).getTime() + 2 * 3_600_000;
  return new RealDate(t).toISOString().slice(0, 10);
};

const phone = "whatsapp:+27820001202";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Thandi Ask", onboardingState: "COMPLETE", popiConsent: true,
  popiConsentAt: new RealDate(), subscriptionStatus: "active", goalType: "fat_loss",
  currentWeight: "88", startWeight: "92", targetWeight: "80", heightCm: 165, age: 31,
  gender: "female", trainingMode: "gym", proteinTarget: 130, calorieTarget: 1900,
  dailyCalorieTarget: 1900, dailyStepTarget: 8000, stepsTarget: 8000,
} as any).returning();

type Meal = { meal_label: string | null; raw_message: string | null; logged_at: Date; kcal_int: number | null };
const meals = async (): Promise<Meal[]> => (await pool.query<Meal>(
  `SELECT meal_label, raw_message, logged_at, kcal_int FROM meal_logs
    WHERE user_id = $1 ORDER BY logged_at, raw_message`, [user.id])).rows;
const wire = async (): Promise<string[]> => (await pool.query<{ body: string }>(
  "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body);
const clear = async (opts: { keepMeals?: boolean } = {}) => {
  if (!opts.keepMeals) await pool.query("DELETE FROM meal_logs WHERE user_id = $1", [user.id]);
  await pool.query("DELETE FROM chat_history WHERE user_id = $1", [user.id]);
  await pool.query("DELETE FROM turn_ledger WHERE user_id = $1", [user.id]);
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  // retro:pending is a DURABLE token on the user row: a turn that names a past day but no food
  // arms it, and the NEXT food message is then legitimately dated to that day. Left standing
  // between cases it silently re-dates an unrelated one — which is the retro-continuity feature
  // working correctly on a conversation this file never meant to have.
  await pool.query("UPDATE users SET profile_notes = NULL WHERE id = $1", [user.id]);
  _resetOutboundDedupe();
  _resetInteractionCorrelation();
};
const settle = () => new Promise(r => setTimeout(r, 1500));

/** One turn, at a pinned SAST hour, through the real reactive front door. */
async function turnAt(hour: number, text: string, sid: string, opts: { keepMeals?: boolean } = {}) {
  await clear(opts);
  const unfreeze = freezeSast(hour);
  try {
    await processTextAsync(phone, text, null, null, [], handleMessage as any, sid);
    await settle();
  } finally { unfreeze(); }
  return { rows: await meals(), bodies: await wire() };
}

/** The resolvers, read at a pinned hour — the two owners this cut changes, asked directly. */
function resolveAt(hour: number, text: string) {
  const unfreeze = freezeSast(hour);
  try { return { day: sastToday(parseMealDate(text)), slot: explicitMealSlot(text) }; }
  finally { unfreeze(); }
}


/** A conversation: fresh state, then each turn in order at its pinned hour. */
async function journey(label: string, turns: Array<[number, string]>) {
  await clear();
  let i = 0;
  for (const [h, t] of turns) {
    const un = freezeSast(h);
    try { await processTextAsync(phone, t, null, null, [], handleMessage as any, `c12-${label}-${i++}`); await settle(); }
    finally { un(); }
  }
  const rows = await meals();
  const bodies = await wire();
  return { rows, bodies, last: bodies[bodies.length - 1] || "" };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\npg-question-owns-turn-acceptance — the question owns the turn\n");
REAL("0. THE INSTRUMENTS — validated before anything is graded with them");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Three claims below are NEGATIVE: the body does not demand food already sent, does not price the
// question's own words as food, and is not the whole-plan dump. A detector that cannot fire makes
// its claim unfalsifiable, so each is checked against labelled strings first — written here rather
// than imported, so a change in how the product phrases these is caught rather than followed.
const RE_LOG_DEMAND = /\b(?:tell|send|give|show|log|share)\b[^.!?\n]{0,45}?\b(?:what you ate|what you'?ve eaten|what you had|your (?:meals?|food|eating|dinner|lunch|breakfast)|food (?:for )?today)\b/i;
const asksToLogFood = (b: string): boolean =>
  RE_LOG_DEMAND.test(String(b || "")) || /\bwhat did you eat\b/i.test(String(b || ""));
/** The handler naming words it could not price — the shape that ate "what, should". */
const namesUnpriced = (b: string): boolean => /could not price\s*\*/i.test(String(b || ""));
/** buildDailyDirection's whole-plan dump, identified by its own header and pillar block. */
const isPlanDump = (b: string): boolean =>
  /here'?s your plan\b/i.test(String(b || "")) || /\*this week:\*/i.test(String(b || ""));
{
  const LOG_LABELLED: Array<[string, boolean]> = [
    ["Tell me what you ate today — one line is enough.", true],
    ["Send me your meals for today and I'll do the rest.", true],
    ["What did you eat today?", true],
    ["Log your food for today.", true],
    ["Thandi — one thing today: *Make your next meal a proper protein meal.*", false],
    ["Got it — Pear. 👌", false],
    ["Stand on a scale tomorrow morning, before you eat.", false],
  ];
  const wrongLog = LOG_LABELLED.filter(([s, want]) => asksToLogFood(s) !== want);
  chk(wrongLog.length === 0, "the re-log detector agrees with every labelled sentence",
    `disagreed on: ${JSON.stringify(wrongLog.map(([s]) => s))}`);
  chk(LOG_LABELLED.some(([s]) => asksToLogFood(s)) && LOG_LABELLED.some(([s]) => !asksToLogFood(s)),
    "…and it both fires and declines — it is not a constant");

  chk(namesUnpriced("⚠️ I could not price *what, should* — not in the total yet.")
    && !namesUnpriced("Got it — Pear. 👌"),
    "the unpriced-words detector fires on the measured defect and not on a clean receipt");
  chk(isPlanDump("Here's your plan, Thandi 👇\n\n*Today:*\n💪 Training day")
    && isPlanDump("x\n\n*This week:*\nTrain 3 days")
    && !isPlanDump("Thandi — one thing today:\n\n*Just say hi.*"),
    "the plan-dump detector separates the whole-plan answer from the one-move answer");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n1. THE FACT SURVIVES THE QUESTION — \"I had a pear. What should I do today?\"");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Measured on 33b477f: rows = 0, and the reply asked for the pear back. The food half works alone
// ("I had a pear" logs), so the question deleted the fact.
{
  const j = await journey("pear-today", [[13, "I had a pear. What should I do today?"]]);
  chk(j.rows.length === 1, "the pear is stored, exactly once", `rows=${j.rows.length}`);
  chk(j.rows.length === 1 && dayOf(j.rows[0].logged_at) === TODAY,
    "…dated today", `day=${j.rows.length ? dayOf(j.rows[0].logged_at) : "-"}`);
  chk(j.rows.length === 1 && j.rows[0].meal_label === null,
    "…with the meal slot left unnamed, because the client named none",
    `label=${JSON.stringify(j.rows[0]?.meal_label)}`);
  chk(j.rows.length === 1 && (j.rows[0].kcal_int || 0) > 0,
    "…and priced", `kcal=${j.rows[0]?.kcal_int}`);
  chk(!asksToLogFood(j.last),
    "the client is not asked for the food they just sent",
    `body=${JSON.stringify(j.last.slice(0, 220))}`);
  chk(!namesUnpriced(j.last),
    "…and the question's own words are not priced as food",
    `body=${JSON.stringify(j.last.slice(0, 220))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. THE QUESTION IS ANSWERED BY ONE MOUTH, NOT BY A RECEIPT AND NOT BY THE PLAN DUMP");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Two failures share this section because they are the same question asked twice. Before the
// repair the receipt shipped alone ("Got it — Pear. 👌", nothing about today); with the receipt's
// false claim removed, buildDailyDirection took the turn — four pillars, a week summary and a
// *Log food* button on the turn that had just logged food. Neither is one move.
{
  const same = await journey("same-turn-direction", [[13, "I had a pear. What should I do today?"]]);
  chk(same.rows.length === 1, "the fact is still written on this turn", `rows=${same.rows.length}`);
  chk(!isPlanDump(same.last),
    "a turn that just wrote a fact is not answered with the whole-plan dump",
    `body=${JSON.stringify(same.last.slice(0, 260))}`);
  chk(!/^got it — pear\. ?👌\s*$/i.test(same.last.trim()),
    "…nor with the bare receipt, which answers nothing that was asked",
    `body=${JSON.stringify(same.last.slice(0, 260))}`);
  chk(same.last.trim().length > 40,
    "…the client receives an actual answer", `len=${same.last.trim().length}`);
  // THE MOVE THE DECISION COMPUTED IS THE MOVE THAT SHIPS. Instrumented on 33b477f, the ladder
  // returned kind=protein todo="Make your next meal a proper protein meal." and the delivered body
  // carried none of it: the unpriced-words nag is a QUESTION, ownsNextAction reads a question in
  // the closing block as the next action already claimed, and withNextMove then declined to append
  // the real one. Grading only "an answer was sent" would have passed that turn, so the move
  // itself is graded.
  chk(/protein/i.test(same.last),
    "…and it is the move the decision ladder actually computed, not a shorter reply that dropped it",
    `body=${JSON.stringify(same.last.slice(-200))}`);

  // TWO TURNS, THE CTO'S SECOND NAMED JOURNEY. Log, then ask. The ask is its own turn, so the
  // write is in the record rather than in flight — and the answer must still be one move.
  const two = await journey("log-then-ask", [[13, "I had chicken and rice for lunch"], [14, "What should I do today?"]]);
  chk(two.rows.length === 1 && two.rows[0].meal_label === "lunch",
    "turn one stores the named lunch", `rows=${two.rows.length} label=${JSON.stringify(two.rows[0]?.meal_label)}`);
  chk(!asksToLogFood(two.last),
    "turn two does not ask for the meal turn one already stored",
    `body=${JSON.stringify(two.last.slice(0, 220))}`);
  chk(!isPlanDump(two.last),
    "…and answers with one move rather than the whole-plan dump",
    `body=${JSON.stringify(two.last.slice(0, 260))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. THE SAME-TURN WRITE IS VISIBLE TO THE DECISION");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// one-action asks `loggedToday` and, from 17:00, answers a day it believes is empty with
// askToLog ("Tell me what you ate today"). A meal written by THIS message must make that false,
// or the client is asked for food that is already in the database — graded at 19:00 so the
// late-day branch is genuinely reachable rather than merely not taken.
{
  const late = await journey("late-same-turn", [[19, "I had chicken and rice for lunch. What should I do today?"]]);
  chk(late.rows.length === 1 && (late.rows[0].kcal_int || 0) > 0,
    "the meal this message named is written", `rows=${late.rows.length} kcal=${late.rows[0]?.kcal_int}`);
  chk(!asksToLogFood(late.last),
    "…and the same turn's answer does not ask for it back",
    `body=${JSON.stringify(late.last.slice(0, 260))}`);
  chk(!namesUnpriced(late.last),
    "…nor price the question's own words as unlogged food",
    `body=${JSON.stringify(late.last.slice(0, 260))}`);

  // THE NEGATIVE HALF: a genuinely empty late day SHOULD still be asked. Without this the claim
  // above is satisfied by a product that simply never asks, which is a different defect.
  const empty = await journey("late-empty", [[19, "What should I do today?"]]);
  chk(empty.rows.length === 0, "CONTROL: nothing is written for a bare question", `rows=${empty.rows.length}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. THE CONTROLS — every shape the repair must leave exactly as it was");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Both repairs are subtractions, so the risk is that they subtract too much. Each of these worked
// on 33b477f and must still work: the two halves that were already correct on their own, the cold
// whole-plan ask that buildDailyDirection legitimately owns, and the pure question that must
// never write a meal.
{
  const alone = await journey("food-alone", [[13, "I had a pear"]]);
  chk(alone.rows.length === 1 && (alone.rows[0].kcal_int || 0) > 0,
    "CONTROL: a bare food report still logs", `rows=${alone.rows.length}`);
  chk(/pear/i.test(alone.last), "CONTROL: …and still gets its receipt naming the food",
    `body=${JSON.stringify(alone.last.slice(0, 160))}`);

  const cold = await journey("cold-direction", [[13, "What should I do today?"]]);
  chk(cold.rows.length === 0, "CONTROL: a cold direction ask writes nothing", `rows=${cold.rows.length}`);
  chk(!isPlanDump(cold.last), "CONTROL: …and still reaches the one-move owner",
    `body=${JSON.stringify(cold.last.slice(0, 220))}`);

  // THE DEMOTION IS NARROW. buildDailyDirection is the right answer to a cold whole-plan ask and
  // keeps it: only a turn that has just written a fact is redirected. Without this control the
  // demotion could have deleted the whole-plan answer and section 2 would not have noticed.
  const plan = await journey("cold-plan", [[13, "What's my plan?"]]);
  chk(plan.rows.length === 0, "CONTROL: a cold plan ask writes nothing", `rows=${plan.rows.length}`);
  chk(isPlanDump(plan.last),
    "CONTROL: …and still receives the whole-plan answer, which this cut does not take away",
    `body=${JSON.stringify(plan.last.slice(0, 220))}`);

  const pure = await journey("pure-question", [[19, "What should I have for dinner tonight?"]]);
  chk(pure.rows.length === 0,
    "CONTROL: a pure food question still writes no meal — asking is not reporting",
    `rows=${pure.rows.length} raw=${JSON.stringify(pure.rows.map(r => r.raw_message))}`);

  // C9's named turn, re-graded here. It passed on 33b477f for an accidental reason — "dinner"
  // inside the QUESTION flipped the bubble parse — and this cut gives it a real one. If the new
  // clause-scoped path ever regresses, this still holds it.
  const c9 = await journey("c9-pear-dinner", [[13, "I had a pear. What should I have for dinner tonight?"]]);
  chk(c9.rows.length === 1 && dayOf(c9.rows[0].logged_at) === TODAY && c9.rows[0].meal_label === null,
    "CONTROL: C9's turn still stores the pear today with no slot",
    `rows=${c9.rows.length} label=${JSON.stringify(c9.rows[0]?.meal_label)}`);
  chk(!asksToLogFood(c9.last), "CONTROL: …and still does not ask for the pear back",
    `body=${JSON.stringify(c9.last.slice(0, 220))}`);
}

REAL(`\n${failed === 0 ? "pg-question-owns-turn-acceptance: GREEN" : `pg-question-owns-turn-acceptance: ${failed} FAILED`}\n`);
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

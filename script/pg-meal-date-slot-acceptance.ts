/**
 * REAL-POSTGRESQL ACCEPTANCE — the eating clause, not the dinner question, owns the date and slot.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS PROVEN BROKEN ON 85b1d73 (main), THROUGH THE LIVE FRONT DOOR, BEFORE ANY EDIT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * One client sentence, at 13:00 SAST on 11 September 2026:
 *
 *     "I had a pear. What should I have for dinner tonight?"
 *
 *     stored row   logged_at = 2026-09-10T18:00:00Z   meal_label = "dinner"
 *     final body   "A pear is a fine snack…  Tell me what you ate today — one line is enough."
 *
 * Every part of that is the client's own words turned against them. They named no day and no meal
 * for the pear. "tonight" and "for dinner" belong to the QUESTION — a meal they have not eaten —
 * and both were read as a report about the pear. So the pear left today's totals for yesterday's,
 * the day read back empty, and the coach answered their dinner question and then, in the same
 * breath, demanded they log the food it had just written down.
 *
 * TWO INDEPENDENT DIVERGENCES, MEASURED SEPARATELY. Removing "tonight" from the message left the
 * row on today and still labelled "dinner"; removing "for dinner" left the label null and still
 * stored yesterday. Neither fix hides the other, so both are graded here on their own.
 *
 *   DATE  server/sast.ts parseMealDate had "tonight" inside the "last night" alternation, so at
 *         every hour of the day it resolved to YESTERDAY 20:00. Three other owners in that same
 *         file — effectiveMealLoggedAt, the forgot/missed gate and the regex literally named
 *         SAYS_TODAY_RE — already say "tonight" means today. Three to one, and the one was the
 *         only branch that writes the meal's date.
 *
 *   SLOT  server/understanding/actions.ts explicitMealSlot read the WHOLE bubble, so a slot word
 *         in a question clause labelled food reported in another. That is #182 one axis over, and
 *         the rule is the one #182 already wrote down: a word may only label the eating if it
 *         belongs to the eating.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS GRADED, AND WHERE IT IS READ FROM
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Stored truth is read from meal_logs. The reply is read from shadow_replies — the body AFTER
 * sendFinal, prepareOutbound and the delivery owner, because a handler return proves nothing
 * about what the client receives. The clock is frozen at a pinned SAST hour on every case: an
 * acceptance that reads the real clock grades whichever hour CI started in (the lesson of #240),
 * and this cut is entirely about which day a message lands on.
 *
 * THE MODEL IS STUBBED, AND THE GRADING NEVER TOUCHES ITS WORDS. The mouth returns one fixed
 * sentence so the turn can be composed at all; every assertion below is about the stored row, or
 * about the CANONICAL ACTION the product appends — deterministic text this file does not author.
 * Section 0 validates that detector against labelled strings before any case uses it, because a
 * re-log detector that cannot fire would make section 2 green by construction.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-meal-date-slot-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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

const phone = "whatsapp:+27820000959";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Thandi Pear", onboardingState: "COMPLETE", popiConsent: true,
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

REAL("\npg-meal-date-slot-acceptance — the eating clause owns the date and the slot\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("0. THE INSTRUMENT — the re-log detector, before anything is graded with it");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Section 2's central claim is that a body does NOT contain a demand to report food already sent.
// A detector that never fires makes that claim unfalsifiable, so it is validated here against
// labelled strings — including the near-misses that a lazy regex would swallow. This is written
// independently of the product's own composer: if the product changes how it phrases the demand,
// this must still see it, which is the whole point of not importing the thing under test.
const RE_LOG_DEMAND = /\b(?:tell|send|give|show|log|share)\b[^.!?\n]{0,45}?\b(?:what you ate|what you'?ve eaten|what you had|your (?:meals?|food|eating|dinner|lunch|breakfast)|food (?:for )?today)\b/i;
const asksToLogFood = (body: string): boolean =>
  RE_LOG_DEMAND.test(String(body || "")) || /\bwhat did you eat\b/i.test(String(body || ""));
{
  const LABELLED: Array<[string, boolean]> = [
    ["Tell me what you ate today — one line is enough.", true],
    ["Tell me what you ate today", true],
    ["Send me your meals for today and I'll do the rest.", true],
    ["Log your food for today.", true],
    ["What did you eat today?", true],
    ["Got it — you ate something. Tell me the items in one line and I'll log it.", false],
    ["Stand on a scale tomorrow morning, before you eat.", false],
    ["Tell me what you trained today.", false],
    ["Quick protein-first options for a late dinner are plain yoghurt with fruit.", false],
    ["Got it — Pear. 👌", false],
  ];
  // "Tell me the items in one line" is labelled FALSE deliberately: it is what the product says
  // when it has stored NOTHING and genuinely needs the food. The defect is demanding a re-log
  // after a successful write, not asking for food that was never given.
  const wrong = LABELLED.filter(([s, want]) => asksToLogFood(s) !== want);
  chk(wrong.length === 0, "the re-log detector agrees with all 10 labelled sentences",
    `disagreed on: ${JSON.stringify(wrong.map(([s]) => s))}`);
  chk(LABELLED.some(([s]) => asksToLogFood(s)) && LABELLED.some(([s]) => !asksToLogFood(s)),
    "the detector both fires and declines — it is not a constant");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n1. THE NAMED TURN — \"I had a pear. What should I have for dinner tonight?\" at 13:00 SAST");
// ══════════════════════════════════════════════════════════════════════════════════════════════
const NAMED = "I had a pear. What should I have for dinner tonight?";
const named = await turnAt(13, NAMED, "c9-named");
{
  const { rows } = named;
  chk(rows.length === 1, "the pear is stored, exactly once", `got ${rows.length} row(s)`);
  chk(rows.length === 1 && dayOf(rows[0].logged_at) === TODAY,
    "stored on TODAY — the day the client ate it",
    `logged_at=${rows[0] ? new RealDate(rows[0].logged_at).toISOString() : "(none)"}`);
  chk(rows.length === 1 && rows[0].meal_label === null,
    "stored with NO meal slot — the client named none for the pear",
    `meal_label=${JSON.stringify(rows[0]?.meal_label ?? "(no row)")}`);
  chk(rows.length === 1 && (rows[0].kcal_int || 0) > 0,
    "and the food itself is not silently dropped", `kcal=${rows[0]?.kcal_int}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. THE REPLY THE CLIENT RECEIVES — post-transport, on that same turn");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The date defect's worst consequence was never the row. It was that the day read back EMPTY, so
// canonicalDecision chose "tell me what you ate today" — and the client watched the coach answer
// their dinner question and then ask for food they had sent in the same bubble. Graded on the
// post-sendFinal body, with the demand detector section 0 validated.
{
  const body = named.bodies.join("\n");
  chk(named.bodies.length > 0, "the client got a reply at all", `got ${named.bodies.length} bodies`);
  chk(/dinner/i.test(body), "the reply engages with the dinner question that was asked",
    `body=${JSON.stringify(body.slice(0, 200))}`);
  chk(!asksToLogFood(body),
    "the reply does NOT ask the client to log food it just stored",
    `body=${JSON.stringify(body.slice(0, 300))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2b. AND THE DAY THE CLIENT IS SHOWN CONTAINS THE PEAR");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The row being right is worth nothing if the surface the client reads still cannot see it. Same
// conversation, one turn later: the pear must appear in today's list, not have vanished into
// yesterday. keepMeals, because the whole claim is about the row written by the turn before.
{
  const { bodies } = await turnAt(13, "what have I eaten today?", "c9-today", { keepMeals: true });
  const body = bodies.join("\n");
  chk(/pear/i.test(body), "today's food, read back, includes the pear",
    `body=${JSON.stringify(body.slice(0, 300))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. THE TWO DIVERGENCES ARE INDEPENDENT — neither fix is hiding the other");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Each offending word is removed from the named sentence in turn. If only one owner had been
// repaired, one of these cases would still be wrong — this is what stops a single change looking
// like two, and it is why both edits were needed rather than either one.
//
// THE DATE HALF IS GRADED ON THE RESOLVER, AND HERE IS WHY, rather than quietly choosing whichever
// instrument passed. "I had a pear. What should I have tonight?" stores NO row — measured on
// 85d1b73 before this cut, so it is the product's existing routing and not something this change
// caused: with no meal word the turn is not a food-context write at all. Grading a stored row
// that does not exist on either side of the fix would be grading nothing. parseMealDate is the
// single owner every food write consults for the day, so asking it directly is the same claim
// with an instrument that can actually see it — and section 1 already proves the stored row on
// the sentence that does write.
{
  const noTonight = await turnAt(13, "I had a pear. What should I have for dinner?", "c9-no-tonight");
  chk(noTonight.rows.length === 1 && noTonight.rows[0].meal_label === null,
    "stored, without \"tonight\": the slot is still not taken from the question",
    `meal_label=${JSON.stringify(noTonight.rows[0]?.meal_label ?? "(no row)")}`);
  chk(noTonight.rows.length === 1 && dayOf(noTonight.rows[0].logged_at) === TODAY,
    "stored, without \"tonight\": and it was already landing on today",
    `logged_at=${noTonight.rows[0] ? new RealDate(noTonight.rows[0].logged_at).toISOString() : "(no row)"}`);

  const noDinner = resolveAt(13, "I had a pear. What should I have tonight?");
  chk(noDinner.day === TODAY, "resolver, without \"for dinner\": the date is still today",
    JSON.stringify(noDinner));
  const both = resolveAt(13, NAMED);
  chk(both.day === TODAY && both.slot === null,
    "resolver, on the named sentence: today, and no slot at all", JSON.stringify(both));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. THE CONTROLS — what a client DOES say still lands, unchanged");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The failure mode of this cut is over-reach: a temporal or slot word withdrawn from a client who
// plainly gave it. Each case below is a sentence where the word belongs to the EATING, and each
// must resolve exactly as it did before. "I ate dinner last night" and "I ate dinner tonight"
// name no food, so the product correctly stores NOTHING and asks for the items — the date and
// slot are therefore graded on the resolvers themselves, and the same claims are then re-made as
// stored rows with the food supplied, so no case rests on a pure function alone.
{
  const lastNight = resolveAt(13, "I ate dinner last night");
  chk(lastNight.day === YESTERDAY && lastNight.slot === "dinner",
    "\"I ate dinner last night\" → yesterday / dinner", JSON.stringify(lastNight));
  const tonight = resolveAt(20, "I ate dinner tonight");
  chk(tonight.day === TODAY && tonight.slot === "dinner",
    "\"I ate dinner tonight\" → today / dinner", JSON.stringify(tonight));

  const pastRow = await turnAt(13, "I ate pap for dinner last night", "c9-past");
  chk(pastRow.rows.length >= 1 && pastRow.rows.every(r => dayOf(r.logged_at) === YESTERDAY),
    "stored: \"I ate pap for dinner last night\" lands on yesterday",
    `days=${JSON.stringify(pastRow.rows.map(r => dayOf(r.logged_at)))}`);
  chk(pastRow.rows.length >= 1 && pastRow.rows.some(r => /dinner/i.test(String(r.meal_label || ""))),
    "…and keeps the dinner the client named",
    `labels=${JSON.stringify(pastRow.rows.map(r => r.meal_label))}`);
  chk(/yesterday/i.test(pastRow.bodies.join("\n")),
    "…and the client is told which day it went to",
    `body=${JSON.stringify(pastRow.bodies.join(" | ").slice(0, 200))}`);

  const tonightRow = await turnAt(20, "I ate pap for dinner tonight", "c9-tonight");
  chk(tonightRow.rows.length >= 1 && tonightRow.rows.every(r => dayOf(r.logged_at) === TODAY),
    "stored: \"I ate pap for dinner tonight\" lands on TODAY",
    `days=${JSON.stringify(tonightRow.rows.map(r => dayOf(r.logged_at)))}`);
  chk(tonightRow.rows.length >= 1 && tonightRow.rows.some(r => /dinner/i.test(String(r.meal_label || ""))),
    "…and is still the dinner they said it was",
    `labels=${JSON.stringify(tonightRow.rows.map(r => r.meal_label))}`);

  const forDinner = await turnAt(13, "I had a pear for dinner", "c9-for-dinner");
  chk(forDinner.rows.length === 1 && dayOf(forDinner.rows[0].logged_at) === TODAY
      && /dinner/i.test(String(forDinner.rows[0].meal_label || "")),
    "stored: \"I had a pear for dinner\" → today / dinner",
    `row=${JSON.stringify(forDinner.rows.map(r => [dayOf(r.logged_at), r.meal_label]))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. THE SLOT OWNER'S OWN BOUNDARIES — the shapes the clause filter must NOT take away");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// explicitMealSlot now reads only clauses that REPORT eating — and falls back to the whole message
// when none does. That fallback is load-bearing, not laziness: a photo caption names no verb, and
// a one-clause question that also reports is declined by the asking floor. Both must keep the slot
// the client plainly gave, or the cut has traded one wrong label for a missing one.
{
  chk(explicitMealSlot("Dinner") === "dinner", "a bare caption \"Dinner\" still names dinner");
  chk(explicitMealSlot("Breakfast 🍳") === "breakfast", "a bare caption \"Breakfast\" still names breakfast");
  chk(explicitMealSlot("I had chicken for dinner, is that ok?") === "dinner",
    "one clause that reports AND asks keeps the slot it reported",
    JSON.stringify(explicitMealSlot("I had chicken for dinner, is that ok?")));
  // A HABIT IS NOT A MEAL. The present tense with no question and no plan in it — the asking and
  // intent floors both pass it, so only the eating vocabulary itself keeps this clause out. It is
  // the case that says why bare "have" is excluded from that vocabulary; measured, because the
  // first revert written for that decision was absorbed by the asking floor and proved nothing.
  chk(explicitMealSlot("I have rice for dinner every day. I had a pear.") === null,
    "a habit stated in the present tense does not label today's pear",
    JSON.stringify(explicitMealSlot("I have rice for dinner every day. I had a pear.")));
  // THE FLOORS ARE DOING WORK, AND THIS IS WHERE IT SHOWS. "Have I eaten lunch?" contains an
  // eating word, so the domain predicate alone calls it a report — only isAskingNotReporting
  // knows it is a question, and only because the composition applies it. Without that floor this
  // pear comes back labelled "lunch": the same defect as the named turn, asked a different way.
  chk(explicitMealSlot("Have I eaten lunch? I had a pear.") === null,
    "a question that USES an eating word is still not a report of eating",
    JSON.stringify(explicitMealSlot("Have I eaten lunch? I had a pear.")));
  chk(explicitMealSlot("I had eggs. I had rice for lunch.") === "lunch",
    "a slot named in the SECOND reporting clause is still found — every reporting clause is read",
    JSON.stringify(explicitMealSlot("I had eggs. I had rice for lunch.")));
  chk(explicitMealSlot("This morning I had eggs, and for lunch I had rice") === "lunch",
    "the precedence inside one clause is untouched — a named meal still outranks a bare mention",
    JSON.stringify(explicitMealSlot("This morning I had eggs, and for lunch I had rice")));
  chk(explicitMealSlot("This morning I had 3 eggs and 2 slices of toast") === "breakfast",
    "#182's morning claim still reaches the slot",
    JSON.stringify(explicitMealSlot("This morning I had 3 eggs and 2 slices of toast")));
  chk(explicitMealSlot("I train in the morning; I just had rice") === null,
    "#182's over-fire guard still holds — the training clause may not label the rice",
    JSON.stringify(explicitMealSlot("I train in the morning; I just had rice")));
  chk(explicitMealSlot("What should I have for dinner?") === "dinner",
    "a message that reports NO eating is matched whole, exactly as before — it writes nothing anyway",
    JSON.stringify(explicitMealSlot("What should I have for dinner?")));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n6. THE MULTI-EVENT WRITER IS UNMOVED");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Two sentences, two eating events, two rows with their own labels. Both clauses report, so the
// filter keeps both — the case that would break if the clause scoping kept only the first.
{
  const { rows } = await turnAt(13, "I had eggs for breakfast. I had rice for lunch.", "c9-multi");
  chk(rows.length === 2, "two eating events are still two rows", `got ${rows.length}`);
  const labels = rows.map(r => String(r.meal_label || "").toLowerCase()).sort();
  chk(labels.join(",") === "breakfast,lunch", "each row keeps the meal its own clause named",
    `labels=${JSON.stringify(rows.map(r => r.meal_label))}`);
  chk(rows.every(r => dayOf(r.logged_at) === TODAY), "both land on today",
    `days=${JSON.stringify(rows.map(r => dayOf(r.logged_at)))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n7. NO SECOND MIDNIGHT-WINDOW OWNER WAS ADDED (source-graded, and it says so)");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The tempting repair for "tonight" was "it means yesterday before 04:00 SAST". That would be a
// SECOND owner of the 00:00–04:59 window, and effectiveMealLoggedAt is the first — it already
// reads that window and already reads this word. This asserts the repair stayed a removal.
{
  const { readFileSync } = await import("node:fs");
  const sast = readFileSync("server/sast.ts", "utf-8");
  const live = sast.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  const pastNight = live.match(/if \(\/\\b\(last night[^\n]*\n/)?.[0] || "";
  chk(pastNight !== "" && !/tonight/.test(pastNight),
    "parseMealDate's past-night branch no longer claims \"tonight\"",
    `branch=${JSON.stringify(pastNight.trim())}`);
  chk(/tonight/.test(live.match(/export function effectiveMealLoggedAt[\s\S]{0,600}/)?.[0] || ""),
    "effectiveMealLoggedAt still owns \"tonight\" in the midnight window");
  chk(/SAYS_TODAY_RE[^\n]*tonight/.test(live), "SAYS_TODAY_RE still says tonight means today");
}

REAL(`\n${failed === 0 ? "pg-meal-date-slot-acceptance: GREEN" : `pg-meal-date-slot-acceptance: ${failed} FAILED`}\n`);
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

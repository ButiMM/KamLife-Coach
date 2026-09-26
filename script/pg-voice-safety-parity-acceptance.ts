/**
 * REAL-POSTGRESQL ACCEPTANCE — safety parity for what a client actually says (C13).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE GOVERNING CONTRACT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *     A client reporting pain reaches the safety owner, whatever words they used,
 *     and the safety owner's answer reaches the client.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS MEASURED ON f6b424b BEFORE A LINE OF THE REPAIR WAS WRITTEN
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *   "my knee is clicking and sore after the squats, should I take anti-inflammatories?"
 *        -> "Good — if it's working for you and it's a basic (it), keep it consistent and keep
 *            your protein from real food the priority. If you ever notice side effects, tell me."
 *
 *   The supplement handler answered a medication question about a painful joint, told the client
 *   to keep taking them, and never mentioned the knee. The "(it)" is the handler admitting it
 *   could not name the thing it was endorsing.
 *
 *   "my knee is clicking after the squats"   -> "Tell me what you ate today — one line is enough."
 *   "my knee is sore after the squats"       -> the outbound repair stall, no answer at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE THREE DIVERGENCES, NAMED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *   1. ROUTING. misc-commands matches "should i take" as a bare substring, so a medication
 *      question with no supplement named entered the supplement branch; /\bi take\b/ then matched
 *      INSIDE "should i take", reading a question about STARTING as ALREADY TAKING.
 *
 *   2. VOCABULARY. classifyPainReport returned null for "my knee is clicking" — a joint symptom
 *      stated without the word "pain" reached no safety owner at all.
 *
 *   3. THE OUTBOUND FLOOR ATE THE SAFE ANSWER. With routing fixed, the DOMS reply was still
 *      replaced by the repair stall: "Peak soreness is usually day 2 after training" was read as
 *      a claim of TWO completed sessions against a record holding zero.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE DOES NOT COVER, STATED RATHER THAN IMPLIED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * No audio is transcribed here: assertSafeMediaUrl needs an allow-listed https host and the STT
 * call needs the network. The voice path re-enters handleMessage as TEXT after transcription, and
 * that is the half driven here — the same half the long-voice acceptance drives. Live wording and
 * live transcription remain production-replay questions.
 *
 * Every case clears awaiting_input_type before and after. An earlier measurement of these exact
 * turns showed a correct DOMS answer that was really the PREVIOUS turn's pain_triage state being
 * answered — a false green. Isolation is part of the contract here, not hygiene.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-voice-safety-parity-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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

const phone = "whatsapp:+27820001303";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Thandi Voice", onboardingState: "COMPLETE", popiConsent: true,
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


/** One turn in a KNOWN-CLEAN state: no carried triage, no carried expectation. */
async function isolated(hour: number, text: string, sid: string) {
  await pool.query("UPDATE users SET awaiting_input_type = NULL WHERE id = $1", [user.id]);
  const r = await turnAt(hour, text, sid);
  await pool.query("UPDATE users SET awaiting_input_type = NULL WHERE id = $1", [user.id]);
  return { ...r, last: r.bodies[r.bodies.length - 1] || "" };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\npg-voice-safety-parity-acceptance — pain reaches the safety owner, and its answer reaches the client\n");
REAL("0. THE INSTRUMENTS — validated before anything is graded with them");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Every claim below is about WHICH OWNER SPOKE. Each detector is checked against labelled strings
// first — including the measured failure body — so none of them can be satisfied by the wrong
// owner or by a reply that says nothing.
const { classifyPainReport } = await import("../server/utils");
const { adjudicableSessionCounts } = await import("../server/brain/reply-verifier");

/** The supplement handler's endorsement — the body measured on f6b424b. */
const PRESCRIBES = (b: string) => /keep it consistent|keep the \w+ going/i.test(String(b || ""));
/** The safety owner's two legitimate answers: the DOMS explanation, or the triage question. */
const SAFETY_ANSWER = (b: string) => /delayed onset muscle soreness|\bDOMS\b/i.test(String(b || ""))
  || /sharp or stabbing/i.test(String(b || ""));
/** The outbound floor's stand-in for a reply it refused to send. */
const IS_STALL = (b: string) => /check that properly before I answer/i.test(String(b || ""));
{
  const MEASURED_BAD = "Good — if it's working for you and it's a basic (it), keep it consistent and keep your protein from real food the priority.";
  chk(PRESCRIBES(MEASURED_BAD), "the prescribing detector fires on the body measured on f6b424b");
  chk(!PRESCRIBES("DOMS Thandi — delayed onset muscle soreness."),
    "…and not on the safety owner's own answer");
  chk(SAFETY_ANSWER("DOMS Thandi — delayed onset muscle soreness. It means you trained hard enough.")
    && SAFETY_ANSWER("Is it *sharp or stabbing* (especially in the joint)?")
    && !SAFETY_ANSWER(MEASURED_BAD) && !SAFETY_ANSWER("Tell me what you ate today — one line is enough."),
    "the safety-answer detector accepts both legitimate answers and rejects both measured failures");
  chk(IS_STALL("Let me check that properly before I answer — give me one sec and ask me again.")
    && !IS_STALL("DOMS Thandi — delayed onset muscle soreness."),
    "the stall detector separates a refused reply from a real one");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n1. THE NAMED TURN — a painful knee and a medication question in one sentence");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const j = await isolated(13, "my knee is clicking and sore after the squats, should I take anti-inflammatories?", "c13-named");
  chk(!PRESCRIBES(j.last),
    "the client is NOT told to keep taking them — nothing is prescribed through a painful joint",
    `body=${JSON.stringify(j.last.slice(0, 260))}`);
  chk(!/\(it\)/.test(j.last),
    "…and no endorsement is issued for a thing the product cannot name",
    `body=${JSON.stringify(j.last.slice(0, 260))}`);
  chk(SAFETY_ANSWER(j.last),
    "the safety owner answers the turn", `body=${JSON.stringify(j.last.slice(0, 260))}`);
  chk(!IS_STALL(j.last),
    "…and its answer reaches the client rather than being refused by the outbound floor",
    `body=${JSON.stringify(j.last.slice(0, 260))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. THE THREE DIVERGENCES, EACH ASSERTED ON ITS OWN");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The named turn above passes only if all three repairs hold, so a single failure there would not
// say which broke. Each is also graded alone, at the owner, so the next reader knows which one.
{
  // 2a — VOCABULARY. A joint symptom stated without the word "pain".
  chk(classifyPainReport("my knee is clicking after the squats") !== null,
    "a clicking knee is a pain report", `got ${JSON.stringify(classifyPainReport("my knee is clicking after the squats"))}`);
  chk(classifyPainReport("my shoulder grinds when I press") !== null && classifyPainReport("my knee locks up") !== null,
    "…as are a grinding shoulder and a locking knee");
  // AND THE BOUNDARY IT MUST NOT CROSS. These words are only a symptom NEXT TO a body part.
  chk(classifyPainReport("the clock is clicking") === null && classifyPainReport("I clicked the link") === null,
    "CONTROL: the same words away from a body part are not a pain report");
  chk(classifyPainReport("my stomach hurts after every meal") === null,
    "CONTROL: the digestive handler keeps its own turn");

  const clicking = await isolated(13, "my knee is clicking after the squats", "c13-clicking");
  chk(SAFETY_ANSWER(clicking.last) && !/what you ate/i.test(clicking.last),
    "and through the front door it reaches the safety owner, not a food demand",
    `body=${JSON.stringify(clicking.last.slice(0, 220))}`);

  // 2b — THE OUTBOUND FLOOR. A calendar day is not a completed session.
  chk(adjudicableSessionCounts("Peak soreness is usually day 2 after training, not day 1.").length === 0,
    "a day reference in the safety answer is not read as a session claim",
    JSON.stringify(adjudicableSessionCounts("Peak soreness is usually day 2 after training, not day 1.")));
  // THE FLOOR KEEPS ITS FULL STRENGTH. Without these the fix could have been "stop adjudicating".
  chk(JSON.stringify(adjudicableSessionCounts("that's 4 sessions in the bag")) === "[4]",
    "CONTROL: a real completion claim is still adjudicated",
    JSON.stringify(adjudicableSessionCounts("that's 4 sessions in the bag")));
  chk(JSON.stringify(adjudicableSessionCounts("Training: 2/4 sessions this week")) === "[2]",
    "CONTROL: the 2/4 numerator is still read and the denominator still dropped",
    JSON.stringify(adjudicableSessionCounts("Training: 2/4 sessions this week")));

  const sore = await isolated(13, "my knee is sore after the squats", "c13-sore");
  chk(SAFETY_ANSWER(sore.last) && !IS_STALL(sore.last),
    "and a plain soreness report is answered rather than stalled",
    `body=${JSON.stringify(sore.last.slice(0, 220))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. THE CONTROLS — the supplement handler still does its own job");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// RETIRED WITH #445: the supplement branch these two controls held (a named supplement is answered;
// week 1 is gated) was deleted. Supplement questions are the new coach's, behind the safety owner
// that still takes the pain turn (asserted above).

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. VOICE PARITY — the spoken forms land where the typed forms do");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// No audio is transcribed here (see the header). What is graded is that the transcript TEXT a
// voice note produces reaches the same owners and the same ledger as the typed equivalent.
{
  const spoken = await isolated(13, "my steps are eight thousand five hundred", "c13-spoken");
  const st = (await pool.query<{ steps: number }>("SELECT steps FROM step_logs WHERE user_id = $1", [user.id])).rows;
  chk(st.length === 1 && Number(st[0].steps) === 8500,
    "a spoken count is stored as 8500 — not 8000, not 8, not 85",
    `rows=${JSON.stringify(st)}`);
  chk(!IS_STALL(spoken.last), "…and the turn is answered", `body=${JSON.stringify(spoken.last.slice(0, 160))}`);
  // THE BODY, NOT ONLY THE ROW (C13). The row was always 8500; what the client HEARD was
  // "8 8,500 steps — nice one". getStepResponse rendered "8\u00a0500" (en-ZA groups with a
  // non-breaking space) and extractStepNumbers recognises comma grouping only, so it read "500",
  // compared it to 8500 and "corrected" a number that was never wrong. Graded on the delivered
  // body: exactly one step figure, and it is the stored one.
  const figures = (spoken.last.match(/\d[\d,\u00a0 ]*(?=\s*steps)/gi) || []).map(t => t.replace(/[^\d]/g, ""));
  chk(figures.length === 1 && figures[0] === "8500",
    "the body carries ONE step figure and it is the stored one — never \"8 8,500\"",
    `figures=${JSON.stringify(figures)} body=${JSON.stringify(spoken.last.slice(0, 160))}`);
  chk(!/\b8\s+8[,\u00a0 ]?500\b/.test(spoken.last),
    "…and the measured duplication shape is absent",
    `body=${JSON.stringify(spoken.last.slice(0, 160))}`);
  // PARITY: the digit form and the spoken form say the same thing to the client.
  await pool.query("DELETE FROM step_logs WHERE user_id = $1", [user.id]);
  const typed = await isolated(13, "I walked 8500 steps today", "c13-typed");
  chk(typed.last.split("steps")[0].trim() === spoken.last.split("steps")[0].trim(),
    "…and the typed form renders the figure identically — one locale, both paths",
    `spoken=${JSON.stringify(spoken.last.slice(0, 60))} typed=${JSON.stringify(typed.last.slice(0, 60))}`);
  await pool.query("DELETE FROM step_logs WHERE user_id = $1", [user.id]);

  const voicePear = await isolated(13, "I had a pear", "c13-pear");
  const meals = await pool.query<{ kcal_int: number }>("SELECT kcal_int FROM meal_logs WHERE user_id = $1", [user.id]);
  chk(meals.rows.length === 1 && Number(meals.rows[0].kcal_int) > 0,
    "a spoken food report writes the same ledger row a typed one does",
    `rows=${JSON.stringify(meals.rows)}`);
  chk(!IS_STALL(voicePear.last) && /pear/i.test(voicePear.last),
    "…and is acknowledged by name", `body=${JSON.stringify(voicePear.last.slice(0, 160))}`);
}

REAL(`\n${failed === 0 ? "pg-voice-safety-parity-acceptance: GREEN" : `pg-voice-safety-parity-acceptance: ${failed} FAILED`}\n`);
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

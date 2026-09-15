/**
 * REAL-POSTGRESQL ACCEPTANCE — the reply reconcileTurnReply REPAIRED is the reply that ships.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS PROVEN BROKEN ON 85d1b73, THROUGH THE LIVE FRONT DOOR, BEFORE ANY EDIT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *     client  "What does maintenance calories mean?"
 *     model   "Maintenance calories are the number that holds your weight steady. Noted 👌"
 *     log     [WRITE_INTEGRITY] blocked a confirmation with no write on the turn
 *     wire    "Maintenance calories are the number that holds your weight steady. Noted 👌 …"
 *
 * Nothing was written on that turn. The write-integrity rule — the boundary added after the 21
 * August handset defect, where a client was told "Noted 👌" about four workouts the card showed
 * as one — saw the false confirmation, logged it, counted it through recordFalseConfirmation, and
 * built the honest replacement. Then the function returned `reply`: the ORIGINAL model string.
 *
 * Every exit past the repairs did it. `return reply` appeared at the not-meaningful exit, the
 * no-user exit, the "nothing was stale" exit — which is the ORDINARY turn, and therefore almost
 * every turn — and the catch. Only the stale-number path and the verifier-blocked path returned
 * what they had built. So the boundary computed a repair on every qualifying turn and shipped the
 * unrepaired text anyway, and `reply` is additionally the text the verifier never saw: the
 * verifier above runs on `draft`.
 *
 * A SECOND MOUTH, FOUND WHILE FIXING THE FIRST. Once the repaired draft actually ships, the
 * decision-turn rebuild inside the same function becomes visible: it recomposes the whole reply
 * from `evidence.situationFrame`, which on a question turn is the GENERIC frame and is captured
 * before the numbers:low delivery strip. Returning that rebuilt draft answered a dinner question
 * with a frame that never mentions dinner, and put a stripped "600 kcal" back into a reply for a
 * client who asked not to see figures. Exits that compose their own decision turn now say so, and
 * the rebuild stands down for them — except when a write-integrity repair replaced the reply,
 * which is the one case where the composed turn MUST be rebuilt around the honest sentence.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * FIVE INDEPENDENT INSTRUMENTS, AND WHY EACH IS SEPARATE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *   RETURN VALUE   handleMessage() returns reconcileTurnReply's output directly — it IS the
 *                  inTurn wrapper. Awaited here, so the function's answer is read without going
 *                  near the transport.
 *   FINAL BODY     shadow_replies, written after sendFinal / prepareOutbound / the delivery owner.
 *   STORED FACTS   meal_logs rows: what the turn actually committed, which is the state the
 *                  write-integrity rule is checked against.
 *   DATE and SLOT  the stored row's SAST day and meal_label, read separately from each other.
 *   THE MOUTH      the stub's own constant, compared against — so "the answer survived" is a
 *                  claim about text the product did not author and cannot have invented.
 *
 * NO FIXTURE-GENERATED ANSWERS. The model stub never supplies a string this file then greps for
 * as evidence that the product is correct. Where the mouth's text is asserted, the claim is that
 * the product did not DISCARD it; every claim about what the product decided is made against the
 * deterministic canonical action, which this file does not write. Section 0 validates both
 * detectors against labelled strings before any case uses them.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-turn-reply-integrity-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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

// ── THE MOUTH ────────────────────────────────────────────────────────────────────────────────
// One switchable constant. Nothing below greps these strings to decide the product is RIGHT —
// only to decide whether the product kept or discarded text it did not author.
const MOUTH = {
  /** Claims a write. Nothing on the turn writes, so the boundary must replace this. */
  falseConfirm: "Maintenance calories are the number that holds your weight steady. Noted 👌",
  /** Carries an instruction of its own, which the canonical action must not have to compete with. */
  directive: "Maintenance calories are the number that holds your weight steady. You should train anyway.",
  /** An ordinary answer to a question asked alongside a meal report. */
  dinnerAnswer: "A pear is a fine snack and it is already on your record. Quick protein-first options for a late dinner are plain yoghurt with fruit, or tinned fish on toast.",
  /** Exactly one of the five sentences askCoachK returns when it could not answer at all. */
  unavailable: "Coach K is a bit busy right now. Give it 30 seconds and try again.",
};
let COACH_ANSWER = MOUTH.falseConfirm;
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
    // The classifier and the coach share one endpoint; a single generic stub answers the
    // classifier with prose and drops every turn into the low-confidence clarify exit, which
    // manufactures a defect the product does not have (#92, learned the hard way).
    const isClassifier = body.includes("message-understanding brain");
    return new Response(JSON.stringify({
      id: "chatcmpl-c10", object: "chat.completion", created: 1, model: "gpt-4o-mini",
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

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

const RealDate = Date;
const SAST_DAY = [2026, 8, 11] as const;
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
const dayOf = (d: Date | string): string =>
  new RealDate(new RealDate(d).getTime() + 2 * 3_600_000).toISOString().slice(0, 10);

const phone = "whatsapp:+27820000963";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Sipho Turn", onboardingState: "COMPLETE", popiConsent: true,
  popiConsentAt: new RealDate(), subscriptionStatus: "active", goalType: "fat_loss",
  currentWeight: "88", startWeight: "92", targetWeight: "80", heightCm: 165, age: 34,
  gender: "male", trainingMode: "gym", proteinTarget: 150, calorieTarget: 2100,
  dailyCalorieTarget: 2100, dailyStepTarget: 8000, stepsTarget: 8000,
} as any).returning();

type Meal = { meal_label: string | null; logged_at: Date; kcal_int: number | null };
const meals = async (): Promise<Meal[]> => (await pool.query<Meal>(
  `SELECT meal_label, logged_at, kcal_int FROM meal_logs WHERE user_id = $1 ORDER BY logged_at`, [user.id])).rows;
const wire = async (): Promise<string[]> => (await pool.query<{ body: string }>(
  "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body);
const clear = async () => {
  for (const t of ["meal_logs", "chat_history", "turn_ledger", "workout_logs", "step_logs", "escalations"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [user.id]).catch(() => {});
  }
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  // retro:pending is durable on the user row and legitimately re-dates the NEXT food message.
  await pool.query("UPDATE users SET profile_notes = NULL, today_calories = 0, today_calories_date = NULL WHERE id = $1", [user.id]);
  _resetOutboundDedupe();
  _resetInteractionCorrelation();
};
const settle = () => new Promise(r => setTimeout(r, 1500));

/**
 * ONE TURN, READ TWO WAYS. `returned` is reconcileTurnReply's own output — handleMessage is the
 * inTurn wrapper, so awaiting it reads the function's answer without the transport in the way.
 * `bodies` is what the delivery owner actually wrote. They are produced by two SEPARATE turns so
 * neither reading can be an artefact of the other, and section 6 asserts they agree.
 */
async function turnAt(hour: number, text: string, sid: string) {
  await clear();
  let returned = "";
  const unfreeze = freezeSast(hour);
  try {
    returned = await handleMessage(phone, text, undefined, undefined, [], `${sid}-ret`);
    await settle();
  } finally { unfreeze(); }
  const rowsAfterReturn = await meals();

  await clear();
  const unfreeze2 = freezeSast(hour);
  try {
    await processTextAsync(phone, text, null, null, [], handleMessage as any, `${sid}-wire`);
    await settle();
  } finally { unfreeze2(); }
  return { returned, rows: await meals(), rowsAfterReturn, bodies: await wire() };
}

REAL("\npg-turn-reply-integrity-acceptance — the repaired reply is the reply that ships\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("0. THE INSTRUMENTS — validated against labelled strings before anything is graded");
// ══════════════════════════════════════════════════════════════════════════════════════════════
/** A claim that something was written down. The vocabulary the boundary itself enumerates. */
const CLAIMS_A_WRITE = /\b(?:logged|noted|saved|recorded|updated|tracked|added (?:it|that)|got (?:it|that) down|put (?:it|that) down|marked (?:it|that))\b/i;
/** An instruction issued in prose — written here independently of the product's own stripper. */
const ISSUES_AN_ORDER = /\b(?:you\s+(?:should|need\s+to|have\s+to|must)|make\s+sure|try\s+to)\b/i;
{
  const LABELLED: Array<[string, boolean, boolean]> = [
    // [sentence, claims a write, issues an order]
    ["Maintenance calories are the number that holds your weight steady. Noted 👌", true, false],
    ["I've logged that for you.", true, false],
    ["Got that down 👌", true, false],
    ["You should train anyway.", false, true],
    ["Make sure you eat protein at every meal.", false, true],
    ["Maintenance calories are the number that holds your weight steady.", false, false],
    ["A pear is a fine snack and it is already on your record.", false, false],
    ["Coach K is a bit busy right now. Give it 30 seconds and try again.", false, false],
  ];
  const wrongWrite = LABELLED.filter(([s, w]) => CLAIMS_A_WRITE.test(s) !== w);
  const wrongOrder = LABELLED.filter(([s, , o]) => ISSUES_AN_ORDER.test(s) !== o);
  chk(wrongWrite.length === 0, "the write-claim detector agrees with all 8 labelled sentences",
    `disagreed on: ${JSON.stringify(wrongWrite.map(([s]) => s))}`);
  chk(wrongOrder.length === 0, "the order detector agrees with all 8 labelled sentences",
    `disagreed on: ${JSON.stringify(wrongOrder.map(([s]) => s))}`);
  chk(CLAIMS_A_WRITE.test(MOUTH.falseConfirm) && ISSUES_AN_ORDER.test(MOUTH.directive),
    "and both fixtures actually trip the detector they were written for");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n1. THE NAMED DEFECT — a false confirmation on a turn that wrote nothing");
// ══════════════════════════════════════════════════════════════════════════════════════════════
COACH_ANSWER = MOUTH.falseConfirm;
const fc = await turnAt(13, "What does maintenance calories mean?", "c10-fc");
{
  chk(fc.rowsAfterReturn.length === 0 && fc.rows.length === 0,
    "STORED FACTS: the turn wrote nothing — which is what makes the confirmation false",
    `rows=${fc.rowsAfterReturn.length}/${fc.rows.length}`);
  chk(!CLAIMS_A_WRITE.test(fc.returned),
    "RETURN VALUE: carries no claim that anything was written down",
    `returned=${JSON.stringify(fc.returned.slice(0, 220))}`);
  chk(!CLAIMS_A_WRITE.test(fc.bodies.join("\n")),
    "FINAL BODY: the client is not told \"Noted\" about a record that does not exist",
    `body=${JSON.stringify(fc.bodies.join(" | ").slice(0, 260))}`);
  chk(fc.returned.trim() !== "" && !fc.bodies.join("").includes(MOUTH.falseConfirm),
    "THE MOUTH'S ORIGINAL did not ship — the repair replaced it rather than riding alongside",
    `body=${JSON.stringify(fc.bodies.join(" | ").slice(0, 260))}`);
  chk(/haven'?t written it down yet/i.test(fc.bodies.join("\n")),
    "and what shipped is the honest sentence the boundary built",
    `body=${JSON.stringify(fc.bodies.join(" | ").slice(0, 260))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. NOT AN EMPTY FALLBACK — the repair is a reply, not a shrug");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The cheapest way to pass section 1 would be to return nothing at all, or the generic filler
// this function keeps for an empty draft. Both are failures dressed as fixes.
{
  chk(fc.returned.trim().length > 40, "RETURN VALUE: not empty and not a stub",
    `len=${fc.returned.trim().length}`);
  chk(!/^I'?m here — tell me what'?s going on/i.test(fc.returned.trim()),
    "RETURN VALUE: not the empty-draft filler", `returned=${JSON.stringify(fc.returned.slice(0, 120))}`);
  chk(fc.bodies.length > 0 && fc.bodies.join("").trim().length > 40,
    "FINAL BODY: the client received a real reply", `bodies=${fc.bodies.length}`);
  chk((fc.bodies.join("\n").match(/one thing today:/gi) || []).length === 1,
    "and exactly ONE canonical action is attached — the repair did not cost it, or double it",
    `count=${(fc.bodies.join("\n").match(/one thing today:/gi) || []).length}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. A MODEL INSTRUCTION DOES NOT REACH THE CLIENT");
// ══════════════════════════════════════════════════════════════════════════════════════════════
COACH_ANSWER = MOUTH.directive;
const dir = await turnAt(13, "What does maintenance calories mean?", "c10-dir");
{
  chk(!ISSUES_AN_ORDER.test(dir.returned), "RETURN VALUE: the model's order is gone",
    `returned=${JSON.stringify(dir.returned.slice(0, 220))}`);
  chk(!ISSUES_AN_ORDER.test(dir.bodies.join("\n")), "FINAL BODY: and it did not reappear in transport",
    `body=${JSON.stringify(dir.bodies.join(" | ").slice(0, 260))}`);
  chk(dir.bodies.join("\n").includes("Maintenance calories are the number that holds your weight steady"),
    "while the EXPLANATION beside it survives — the boundary closes without deleting the answer",
    `body=${JSON.stringify(dir.bodies.join(" | ").slice(0, 260))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. VALID COACH CONTEXT IS PRESERVED — the C9 journey, end to end");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The same turn C9 repairs, now read through this cut's instruments: the answer the mouth gave
// must survive, the stored row must be right on BOTH axes, and the canonical action must be the
// product's own and appear exactly once.
COACH_ANSWER = MOUTH.dinnerAnswer;
const pear = await turnAt(13, "I had a pear. What should I have for dinner tonight?", "c10-pear");
{
  chk(pear.rows.length === 1, "STORED FACTS: the pear is stored once", `rows=${pear.rows.length}`);
  chk(pear.rows.length === 1 && dayOf(pear.rows[0].logged_at) === TODAY,
    "DATE: stored on today", `day=${pear.rows[0] ? dayOf(pear.rows[0].logged_at) : "(none)"}`);
  chk(pear.rows.length === 1 && pear.rows[0].meal_label === null,
    "SLOT: still unnamed — read separately from the date",
    `label=${JSON.stringify(pear.rows[0]?.meal_label ?? "(none)")}`);
  chk(pear.bodies.join("\n").includes("Quick protein-first options for a late dinner"),
    "FINAL BODY: the mouth's answer reached the client — it was not replaced by a generic frame",
    `body=${JSON.stringify(pear.bodies.join(" | ").slice(0, 300))}`);
  chk(pear.returned.includes("Quick protein-first options for a late dinner"),
    "RETURN VALUE: and the function returned it too, so the transport is not carrying it alone",
    `returned=${JSON.stringify(pear.returned.slice(0, 300))}`);
  chk((pear.bodies.join("\n").match(/one thing today:/gi) || []).length === 1,
    "exactly one canonical action — the second mouth is stood down, not duplicated",
    `count=${(pear.bodies.join("\n").match(/one thing today:/gi) || []).length}`);
  chk(!/\btell me what you ate today\b/i.test(pear.bodies.join("\n")),
    "and the client is NOT asked to log the pear they just sent",
    `body=${JSON.stringify(pear.bodies.join(" | ").slice(0, 300))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4b. THE SAME TURN AFTER 16:00 — where the under-eating warning becomes reachable");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// PINNED LATE ON PURPOSE. lifecycle.ts's under-eating warning is gated on SAST hour >= 16, so at
// the 13:00 used above it cannot fire and section 4 would be green with that branch wide open.
// This is the hour the defect actually happens at: 103 kcal on the day, late afternoon, a message
// containing "had" and "dinner" — every condition met, and the branch returns, so the client's
// question dies there. It is also the case C9 made reachable: before the date fix the pear was
// written to yesterday, today read 0 kcal, and the warning could not trigger.
// TWO MESSAGES, BECAUSE THAT IS HOW A CLIENT GETS THERE. The warning reads users.today_calories,
// which is bound at the START of a turn — so a single bubble that logs the pear and asks in the
// same breath still sees 0 and cannot trigger it. The real sequence is the ordinary one: log food
// early, ask later. Turn 1 puts 103 kcal on the day; turn 2, at 18:00, is nothing but a question.
{
  COACH_ANSWER = MOUTH.dinnerAnswer;
  await clear();
  const un1 = freezeSast(13);
  try { await processTextAsync(phone, "I had a pear", null, null, [], handleMessage as any, "c10-late-1"); await settle(); }
  finally { un1(); }
  const rowsAfterLog = await meals();
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  _resetOutboundDedupe(); _resetInteractionCorrelation();

  // Turn 2 carries food AND the question, which is the shape the warning's own regexes need:
  // "had" satisfies one and "dinner" the other. Both words are in the client's ordinary sentence,
  // and neither is a complaint about eating too little — which is the whole point.
  const un2 = freezeSast(18);
  try {
    await processTextAsync(phone, "I had an apple. What should I have for dinner tonight?", null, null, [], handleMessage as any, "c10-late-2");
    await settle();
  } finally { un2(); }
  const lateBodies = await wire();

  const [row] = (await pool.query<{ today_calories: number | null }>(
    "SELECT today_calories FROM users WHERE id = $1", [user.id])).rows;
  chk(rowsAfterLog.length === 1 && dayOf(rowsAfterLog[0].logged_at) === TODAY,
    "DATE: turn 1 put the pear on today — the state the warning reads",
    `day=${rowsAfterLog[0] ? dayOf(rowsAfterLog[0].logged_at) : "(none)"}`);
  chk(Number(row?.today_calories || 0) > 0,
    "and the day's calorie total is non-zero, so the warning's own gate is genuinely open",
    `today_calories=${row?.today_calories}`);
  chk(!/that is too low/i.test(lateBodies.join("\n")),
    "FINAL BODY: no unprompted under-eating lecture replaced the answer they asked for",
    `body=${JSON.stringify(lateBodies.join(" | ").slice(0, 300))}`);
  chk(lateBodies.join("\n").includes("Quick protein-first options for a late dinner"),
    "FINAL BODY: the question asked at 18:00 is answered",
    `body=${JSON.stringify(lateBodies.join(" | ").slice(0, 300))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. THE CONTROLS — a genuine dinner, a last-night dinner, an unanswered question");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  COACH_ANSWER = MOUTH.dinnerAnswer;
  const genuine = await turnAt(13, "I had pap for dinner", "c10-genuine");
  chk(genuine.rows.length >= 1 && genuine.rows.every(r => dayOf(r.logged_at) === TODAY),
    "GENUINE DINNER — DATE: today", `days=${JSON.stringify(genuine.rows.map(r => dayOf(r.logged_at)))}`);
  chk(genuine.rows.length >= 1 && genuine.rows.some(r => /dinner/i.test(String(r.meal_label || ""))),
    "GENUINE DINNER — SLOT: the dinner the client named is kept",
    `labels=${JSON.stringify(genuine.rows.map(r => r.meal_label))}`);
  chk(genuine.returned.trim().length > 0 && genuine.bodies.join("").trim().length > 0,
    "GENUINE DINNER — RETURN VALUE and FINAL BODY are both real");

  const lastNight = await turnAt(13, "I ate pap for dinner last night", "c10-lastnight");
  chk(lastNight.rows.length >= 1 && lastNight.rows.every(r => dayOf(r.logged_at) === YESTERDAY),
    "LAST-NIGHT DINNER — DATE: yesterday, untouched by C9",
    `days=${JSON.stringify(lastNight.rows.map(r => dayOf(r.logged_at)))}`);
  chk(lastNight.rows.length >= 1 && lastNight.rows.some(r => /dinner/i.test(String(r.meal_label || ""))),
    "LAST-NIGHT DINNER — SLOT: dinner",
    `labels=${JSON.stringify(lastNight.rows.map(r => r.meal_label))}`);
  chk(/yesterday/i.test(lastNight.bodies.join("\n")),
    "LAST-NIGHT DINNER — FINAL BODY: the client is told which day it went to",
    `body=${JSON.stringify(lastNight.bodies.join(" | ").slice(0, 220))}`);

  // AN UNANSWERED QUESTION MUST NOT BECOME A CONFIDENT INSTRUCTION. The mouth returns one of its
  // own failure sentences; the client is told, and no action is invented on top of the silence.
  COACH_ANSWER = MOUTH.unavailable;
  const dead = await turnAt(13, "What does maintenance calories mean?", "c10-dead");
  chk(dead.bodies.join("\n").includes("Coach K is a bit busy right now"),
    "UNANSWERED QUESTION — FINAL BODY: the client is told the coach could not answer",
    `body=${JSON.stringify(dead.bodies.join(" | ").slice(0, 240))}`);
  chk(!/one thing today:/i.test(dead.bodies.join("\n")),
    "UNANSWERED QUESTION — no canonical action is appended to an answer that never happened",
    `body=${JSON.stringify(dead.bodies.join(" | ").slice(0, 240))}`);
  chk(dead.returned.includes("Coach K is a bit busy right now"),
    "UNANSWERED QUESTION — RETURN VALUE: the function returned it rather than a repair of it",
    `returned=${JSON.stringify(dead.returned.slice(0, 240))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n6. THE TWO READINGS AGREE — the function's answer is the client's reply");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Sections 1–5 read the return value and the wire from SEPARATE turns, so that neither can be an
// artefact of the other. This asserts they are the same text: a fix that repaired the return value
// while the transport still shipped something else would pass every check above and still be the
// defect. Transport splits on the paragraph marker, so the comparison is on joined, trimmed text.
{
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  for (const [label, t] of [["false confirmation", fc], ["model directive", dir], ["the pear turn", pear]] as const) {
    chk(norm(t.bodies.join(" ")) === norm(t.returned),
      `${label}: what the function returned is exactly what the client received`,
      `returned=${JSON.stringify(norm(t.returned).slice(0, 180))}\n          wire    =${JSON.stringify(norm(t.bodies.join(" ")).slice(0, 180))}`);
  }
}

REAL(`\n${failed === 0 ? "pg-turn-reply-integrity-acceptance: GREEN" : `pg-turn-reply-integrity-acceptance: ${failed} FAILED`}\n`);
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

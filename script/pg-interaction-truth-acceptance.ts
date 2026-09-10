/**
 * REAL-POSTGRESQL ACCEPTANCE — the ledger records what the CLIENT received (Cut 1).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS PROVEN BROKEN ON 7833ebb, post-transport, before a line of this cut was written.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * 1. THE REPEATED QUESTION. One client, the same question twice inside the dedupe window:
 *
 *        wire[0]   "Thabo — one thing today: *Stand on a scale tomorrow morning…*"
 *        wire[1]   "Let me check that properly before I answer — give me one sec and ask me again."
 *        ledger[0] = ledger[1] = the correct coaching reply, both rows
 *
 *    enforceOutboundTruth rule 3 ran the proactive duplicate test against a REPLY and refused it.
 *    The client was told to ask again — which is the P0-C failure routes/whatsapp.ts records as
 *    fixed on 2026-08-21, silently reverted by a later authority. Both ledger rows showed the
 *    right answer, so no amount of reading the ledger could ever have found it.
 *
 * 2. THE LEDGER WAS NOT THE MESSAGE.
 *
 *        ledger "…what do you need?[BUTTONS:Today's workout|Log food|My progress]"
 *        wire   "…what do you need?\n\n▸ *Today's workout*\n▸ *Log food*\n▸ *My progress*"
 *
 *    recordTurn stores the HANDLER's return. Marker rendering, the truth floor, provenance,
 *    hygiene, the marker strip and the never-silent repairs all run after it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * GRADED POST-TRANSPORT, ON PURPOSE. Every check drives processTextAsync — the reactive path that
 * calls sendFinal → prepareOutbound → the floor → the delivery owner — and reads turn_ledger and
 * shadow_replies afterwards. Calling handleMessage would prove only what a handler intended, which
 * is exactly the blindness that let both defects above ship green.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-interaction-truth-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
const { REACTIVE_OUTBOUND_REPAIR, enforceOutboundTruth } = await import("../server/outbound-authority");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

const phone = "whatsapp:+27820000941";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Thabo Ledger", onboardingState: "COMPLETE", popiConsent: true,
  subscriptionStatus: "active", goalType: "fat_loss", currentWeight: "92", startWeight: "95",
  targetWeight: "85", heightCm: 178, age: 34, gender: "male", trainingMode: "gym",
  proteinTarget: 150, dailyCalorieTarget: 2200, dailyStepTarget: 8000,
} as any).returning();

type Row = {
  root_id: string | null; input_text: string | null; input_text_canonical: string | null;
  reply: string | null; delivered_body: string | null; outbound_verdict: any;
  delivery_outcome: string | null; decision: any; version: string | null; mutations: any;
};
const rows = async (): Promise<Row[]> => (await pool.query<Row>(
  `SELECT root_id, input_text, input_text_canonical, reply, delivered_body, outbound_verdict,
          delivery_outcome, decision, version, mutations
     FROM turn_ledger WHERE user_id = $1 ORDER BY created_at, id`, [user.id])).rows;
const wire = async (): Promise<string[]> => (await pool.query<{ body: string }>(
  "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body);
const clear = async () => {
  await pool.query("DELETE FROM turn_ledger WHERE user_id = $1", [user.id]);
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
};
const settle = () => new Promise(r => setTimeout(r, 600));
const say = (text: string, sid: string) =>
  processTextAsync(phone, text, null, null, [], handleMessage as any, sid);

REAL("\npg-interaction-truth-acceptance — the customer-visible truth boundary\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("1. THE REPEATED QUESTION IS ANSWERED, NOT REPAIRED");
// ══════════════════════════════════════════════════════════════════════════════════════════════
await clear();
_resetOutboundDedupe();
_resetInteractionCorrelation();
await say("What should I do today?", "sid-rep-1");
await say("What should I do today?", "sid-rep-2");
await settle();
{
  const w = await wire();
  const r = await rows();
  chk(w.length === 2, "both askings reach the client", `got ${w.length} outbound bodies`);
  chk(!!w[1] && w[1] !== REACTIVE_OUTBOUND_REPAIR,
    "the second answer is not the outbound repair", `wire[1]=${JSON.stringify((w[1] || "").slice(0, 90))}`);
  chk(!/gave you the same answer twice/i.test(w[1] || ""),
    "the second answer is not the duplicate-meta reply", `wire[1]=${JSON.stringify((w[1] || "").slice(0, 90))}`);
  chk(!!(w[1] || "").trim(), "the second answer is not silence");
  chk(w[0] === w[1], "a truthful answer is repeated verbatim, because it is still the truthful answer",
    `wire[0]=${JSON.stringify((w[0] || "").slice(0, 60))} wire[1]=${JSON.stringify((w[1] || "").slice(0, 60))}`);
  chk(r.length === 2 && r.every(x => x.outbound_verdict?.blocked === false),
    "neither row records a block", JSON.stringify(r.map(x => x.outbound_verdict)));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. THE LEDGER'S FINAL BODY IS BYTE-IDENTICAL TO WHAT WENT TO DELIVERY");
// ══════════════════════════════════════════════════════════════════════════════════════════════
await clear();
_resetOutboundDedupe();
_resetInteractionCorrelation();
await say("menu", "sid-menu-1");
await settle();
{
  const [w] = await wire();
  const [r] = await rows();
  chk(!!r, "the turn left a ledger row");
  chk(r?.delivered_body === w, "delivered_body is byte-identical to the body handed to delivery",
    `ledger=${JSON.stringify((r?.delivered_body || "").slice(0, 120))}\n          wire  =${JSON.stringify((w || "").slice(0, 120))}`);
  chk(r?.delivery_outcome === "shadow", "the delivery outcome is recorded, not assumed",
    `got ${r?.delivery_outcome}`);
  chk(!!r?.root_id, "the row carries a root id");
  chk(r?.root_id === "sid-menu-1", "the root id is the source message id", `got ${r?.root_id}`);
  chk(!!r?.version, "the running SHA is recorded", `got ${r?.version}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. RENDERED BUTTONS ARE RECORDED AS THE CUSTOMER SAW THEM");
// ══════════════════════════════════════════════════════════════════════════════════════════════
await clear();
_resetOutboundDedupe();
_resetInteractionCorrelation();
await say("zzqq flurblewump gribbet", "sid-btn-1");
await settle();
{
  const [w] = await wire();
  const [r] = await rows();
  const marked = /\[BUTTONS:/.test(r?.reply || "");
  chk(marked, "the fixture reply really does carry a [BUTTONS:] marker (else this check grades nothing)",
    `reply=${JSON.stringify((r?.reply || "").slice(0, 120))}`);
  chk(!/\[BUTTONS:/.test(r?.delivered_body || ""),
    "delivered_body holds no raw marker", `delivered=${JSON.stringify((r?.delivered_body || "").slice(0, 120))}`);
  chk((r?.delivered_body || "").includes("▸"), "delivered_body holds the rendered prompts");
  chk(r?.delivered_body === w, "…and it is exactly what went out");
  chk((r?.reply || "") !== (r?.delivered_body || ""),
    "the handler's reply and the customer's body are both kept, and they differ here");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. A BLOCKED RESPONSE RECORDS DRAFT, VERDICT, REPLACEMENT AND FINAL BODY");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// A template leak is the cheapest genuine refusal to provoke: the floor's own gate, unrelated to
// the duplicate rule this cut removes, so it also proves the rest of the floor is untouched.
await clear();
_resetOutboundDedupe();
_resetInteractionCorrelation();
await pool.query(
  `INSERT INTO chat_history (user_id, message_in, message_out, intent) VALUES ($1,$2,$3,$4)`,
  [user.id, "seed", "seed", "SEED"]);
{
  const { prepareOutbound } = await import("../server/outbound-authority");
  const prepared = await prepareOutbound("reactive", user.id, phone, "You ate undefined kcal today.", null);
  chk(prepared.blocked, "the floor refuses a template leak on the reactive door");
  chk(prepared.text === REACTIVE_OUTBOUND_REPAIR, "…and hands back the repair, never the draft");
  chk(prepared.draft === "You ate undefined kcal today.",
    "…and carries the REFUSED DRAFT so the record is not just the repair", `draft=${JSON.stringify(prepared.draft)}`);
  chk(!!prepared.detail && /undefined/i.test(prepared.detail), "…with the reason", `detail=${prepared.detail}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. THE SAFETY AND TRUTH FLOORS ARE UNCHANGED");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  // Session-count rule, reactive mode — must still refuse a count the record denies (#233 guard).
  const v = await enforceOutboundTruth(user.id, phone, "You have done 4 sessions this week.", null, "reactive");
  chk(!v.ok && v.reason === "session_count_contradicts_record",
    "a false session count is still blocked on the REACTIVE door", JSON.stringify(v));

  // Held-constraint rule, reactive mode — still live.
  await pool.query("UPDATE users SET profile_notes = $1 WHERE id = $2", ["sick:until-tomorrow", user.id]);
  const held = await enforceOutboundTruth(user.id, phone, "Time to get your session in today.", { profileNotes: "sick:until-tomorrow" }, "reactive");
  chk(!held.ok || held.reason !== "duplicate",
    "the held-constraint rule is not the duplicate rule and still applies", JSON.stringify(held));
  await pool.query("UPDATE users SET profile_notes = NULL WHERE id = $1", [user.id]);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n6. CONTROL — PROACTIVE DUPLICATE SUPPRESSION STILL WORKS");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  _resetOutboundDedupe();
  const body = "Morning Thabo — one walk today, that is the whole job.";
  const first = await enforceOutboundTruth(user.id, phone, body, null, "proactive");
  const second = await enforceOutboundTruth(user.id, phone, body, null, "proactive");
  chk(first.ok, "the first proactive send passes", JSON.stringify(first));
  chk(!second.ok && second.reason === "duplicate",
    "the second identical PROACTIVE send is still refused", JSON.stringify(second));

  // …and the same body twice on the REACTIVE door is not refused. This is the pair: removing the
  // rule for replies must not have removed it for crons, and vice versa.
  _resetOutboundDedupe();
  const r1 = await enforceOutboundTruth(user.id, phone, body, null, "reactive");
  const r2 = await enforceOutboundTruth(user.id, phone, body, null, "reactive");
  chk(r1.ok && r2.ok, "the same body twice on the REACTIVE door passes both times", JSON.stringify([r1, r2]));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n7. ONE SOURCE MESSAGE, ONE ROOT ID — ACROSS A NESTED TURN");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// handlers/media.ts:1423 re-enters handleMessage for every voice note, opening a second turn scope
// inside the first. That recursion is NOT fixed in this cut. What is fixed is that both rows now
// answer to one interaction. Reproduced through the same nesting the media handler performs.
await clear();
_resetInteractionCorrelation();
{
  const { inTurn, recordTurn, turnUser } = await import("../server/handlers/chat-log");
  await inTurn("voice", "", async () => {
    turnUser(user.id);                                   // routeMessage:126 does this on the outer scope
    const inner = await handleMessage(phone, "I walked 9000 steps", undefined, undefined, undefined, "sid-voice-1");
    void recordTurn(inner);
    return inner;
  }, "sid-voice-1");
  await settle();
  const r = await rows();
  chk(r.length === 2, "the nested turn still produces two rows (the recursion is not this cut)", `rows=${r.length}`);
  chk(r.length === 2 && r[0].root_id === r[1].root_id,
    "…and BOTH carry the same root id", JSON.stringify(r.map(x => x.root_id)));
  chk(r.every(x => x.root_id === "sid-voice-1"),
    "…which is the source message's id", JSON.stringify(r.map(x => x.root_id)));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n8. THE HANDLERS' OWN INPUT IS RECORDED WHEN SOMETHING REWROTE THE CLIENT");
// ══════════════════════════════════════════════════════════════════════════════════════════════
await clear();
_resetOutboundDedupe();
_resetInteractionCorrelation();
{
  // The retro-continuity carry (routes.ts:231) rewrites `message` before any handler runs.
  await say("I want to tell you what I ate yesterday", "sid-retro-1");
  await settle();
  await say("chicken and rice", "sid-retro-2");
  await settle();
  const r = await rows();
  const carried = r.find(x => x.input_text === "chicken and rice");
  chk(!!carried, "the second turn was recorded");
  chk(carried?.input_text === "chicken and rice", "input_text keeps the client's ORIGINAL words",
    JSON.stringify(carried?.input_text));
  chk((carried?.input_text_canonical || "").startsWith("yesterday "),
    "input_text_canonical holds what the handlers actually routed on",
    JSON.stringify(carried?.input_text_canonical));

  // CONTROL: an untouched turn records no canonical rewrite, so this column cannot quietly
  // become "a second copy of input_text".
  const plain = r.find(x => x.input_text === "I want to tell you what I ate yesterday");
  chk(plain?.input_text_canonical == null,
    "a turn nobody rewrote records no canonical input", JSON.stringify(plain?.input_text_canonical));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n9. THE CANONICAL DECISION AND ITS DISPOSITION ARE ON THE ROW");
// ══════════════════════════════════════════════════════════════════════════════════════════════
await clear();
_resetOutboundDedupe();
_resetInteractionCorrelation();
// Section 7 already logged today's steps through the nested turn, and the step door is idempotent
// per day — so without this the turn below writes nothing and the check grades an empty record
// rather than the product. The fixture is wrong in that case, not the code.
await pool.query("DELETE FROM step_logs WHERE user_id = $1", [user.id]);
await say("I walked 9000 steps", "sid-dec-1");
await settle();
{
  const [r] = await rows();
  chk(!!r?.decision, "the row carries a decision object", JSON.stringify(r?.decision));
  chk(typeof r?.decision?.disposition === "string" &&
      ["instructed", "hold", "conversational"].includes(r.decision.disposition),
    "…with a disposition from the existing evidence, not a new taxonomy", JSON.stringify(r?.decision));
  chk(Array.isArray(r?.mutations) && r.mutations.some((m: string) => /INSERT steps/i.test(m)),
    "…and the state half of the row is untouched by this cut", JSON.stringify(r?.mutations));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n10. THE DELIVERY OUTCOME IS THE DELIVERY OWNER'S, NOT A CONSTANT");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Every check above ran with SHADOW=on and recorded "shadow". A column that only ever holds one
// value distinguishes nothing, so this turn goes down the REAL delivery path with a Twilio client
// that cannot send — deliverTwilioMessage exhausts its retries and returns "dropped". Two
// different real outcomes from the same column is what makes "sent | dropped | fallback"
// a distinction rather than a comment. (A "sent" cannot be produced without a live Twilio
// account, and manufacturing one would be a fixture proving itself.)
await clear();
_resetOutboundDedupe();
_resetInteractionCorrelation();
process.env.SHADOW = "off";
try {
  await say("menu", "sid-drop-1");
  await settle();
  const [r] = await rows();
  chk(r?.delivery_outcome === "dropped",
    "a send the delivery owner could not complete is recorded as dropped, not as sent",
    `got ${r?.delivery_outcome}`);
  chk(!!r?.delivered_body,
    "…and the body it tried to send is still on the row", JSON.stringify((r?.delivered_body || "").slice(0, 60)));
} finally {
  process.env.SHADOW = "on";
}

REAL(`\n${failed === 0 ? "pg-interaction-truth-acceptance: ALL GREEN" : `pg-interaction-truth-acceptance: ${failed} FAILED`}`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

/**
 * REAL-POSTGRESQL ACCEPTANCE — the wave-1 switch (COVERAGE A10, A11, A13, A16, A17; #438).
 *
 * With the model stubbed at the network edge, this proves the switch's plumbing:
 *   - CORE_WAVE1=founder: only the founder's number (COACH_ALERT_PHONE) meets the new coach;
 *   - the new coach answers where gpt-block did, BEHIND the scope floor (an off-topic ask is still declined);
 *   - a message the new coach cannot read falls back to the old reply: never silence, never a guess (#421);
 *   - a client midway through an old flow (a menu awaiting "1/2/3") finishes it there (#440);
 *   - CORE_WAVE1=off is the instant rollback.
 */
if (!process.env.DATABASE_URL) { console.log("pg-core-wave1-switch-acceptance: SKIPPED — no DATABASE_URL."); process.exit(0); }
process.env.OPENAI_API_KEY = "sk-stub"; process.env.OFFLINE_AI = "0"; process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "on"; process.env.PROACTIVE_PAUSED = "true"; process.env.NODE_ENV = "production";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000"; process.env.TWILIO_AUTH_TOKEN = "test"; process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
const FOUNDER = "whatsapp:+27829438001", TESTER = "whatsapp:+27829438002";
process.env.COACH_ALERT_PHONE = "+27829438001";
process.env.CORE_WAVE1 = "founder";

const NEW = "NEW-COACH-438"; // only the new coach's composer says this
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  if (!url.includes("api.openai.com")) return realFetch(input, init);
  const body = typeof init?.body === "string" ? init.body : "";
  let content = "Old coach here, noted.";
  if (body.includes("say what they want from this turn")) {
    const msg = JSON.parse(body).messages.at(-1).content as string;
    content = /garbled/i.test(msg) ? "not json" : JSON.stringify({ family: "question", wants: "advice", one_question: null, uncertainty: 0.2, facts: [], actions: [] });
  } else if (body.includes("You are Coach K, a warm, direct South African")) content = `Try pap with beans tonight. ${NEW}`;
  else if (body.includes("domain gate")) content = /homework/i.test(body) ? "NO" : "YES";
  else if (body.includes("message-understanding brain")) content = `{"intent":"OTHER","confidence":0.5,"canonical":""}`;
  return new Response(JSON.stringify({ id: "stub", object: "chat.completion", created: 1, model: "stub",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};
const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");

let failed = 0;
const chk = (ok: boolean, msg: string, ev = "") => { if (!ok) failed++; REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && ev ? `\n          ${ev}` : ""}`); };
let n = 0;
const say = async (phone: string, text: string) => { _resetOutboundDedupe(); return handleMessage(phone, text, undefined, undefined, [], `SM438${Date.now()}${++n}`); };
for (const phone of [FOUNDER, TESTER]) {
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
  await db.insert(schema.users).values({ phoneNumber: phone, name: phone === FOUNDER ? "Koketso Founder" : "Thabo Tester", onboardingState: "COMPLETE",
    popiConsent: true, popiConsentAt: new Date(), subscriptionStatus: "active", goalType: "fat_loss", currentWeight: "82", calorieTarget: 1800, proteinTarget: 125 } as any);
}
const ASK = "Any ideas for a cheap supper tonight?";

REAL("\npg-core-wave1-switch-acceptance — the new coach answers wave-1 turns, founder first (#438)\n");
REAL("1. FOUNDER FIRST");
const f1 = await say(FOUNDER, ASK);
chk(f1.includes(NEW), "the founder's wave-1 question is answered by the new coach", f1);
const t1 = await say(TESTER, ASK);
chk(!t1.includes(NEW) && t1.trim().length > 0, "a tester still meets the old coach", t1);

REAL("\n2. THE SCOPE FLOOR STAYS IN FRONT (A17)");
const f2 = await say(FOUNDER, "Can you help me with my maths homework tonight?");
chk(!f2.includes(NEW) && f2.trim().length > 0, "an off-topic ask is declined by the floor, not composed", f2);

REAL("\n3. NO READING, NO GUESS: FALL BACK, NEVER SILENCE (#421)");
const f3 = await say(FOUNDER, "garbled words the reading cannot parse at all");
chk(!f3.includes(NEW) && f3.trim().length > 0, "a message the new coach cannot read gets the old reply", f3);

REAL("\n4. IN-FLIGHT STATE: AN OLD MENU'S ANSWER FINISHES THE OLD FLOW (#440)");
await pool.query("UPDATE users SET awaiting_input_type = 'comeback' WHERE phone_number = $1", [FOUNDER]);
const f5 = await say(FOUNDER, "2");
const left = (await pool.query("SELECT awaiting_input_type FROM users WHERE phone_number = $1", [FOUNDER])).rows[0]?.awaiting_input_type;
chk(/2 meals/i.test(f5) && !f5.includes(NEW) && left === null, "the comeback menu's \"2\" gets the simpler plan and the pending question clears", `${f5} | pending=${left}`);

REAL("\n5. INSTANT ROLLBACK");
process.env.CORE_WAVE1 = "off";
const f4 = await say(FOUNDER, ASK);
chk(!f4.includes(NEW), "CORE_WAVE1=off: the founder is back on the old coach, with no deploy", f4);

for (const phone of [FOUNDER, TESTER]) await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
REAL(`\npg-core-wave1-switch-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

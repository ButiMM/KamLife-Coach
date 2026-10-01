/**
 * REAL-POSTGRESQL ACCEPTANCE — the wave-1 switch (COVERAGE A10, A11, A13, A16, A17; #438).
 *
 * With the model stubbed at the network edge, this proves the switch's plumbing:
 *   - CORE_WAVE1 on (the default): every client meets the new coach;
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
process.env.CORE_WAVE1 = "on"; // the runner pins off for stubbed suites; this one proves the switch

const NEW = "NEW-COACH-438"; // only the new coach's composer says this
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  if (!url.includes("api.openai.com")) return realFetch(input, init);
  const body = typeof init?.body === "string" ? init.body : "";
  let content = "Old coach here, noted.";
  if (body.includes("say what they want from this turn")) {
    const msg = JSON.parse(body).messages.at(-1).content as string;
    const bag = { type: "SET_REMINDER", body: "pack my gym bag", when: "tomorrow at 7am" };
    const fix = /not pap/i.test(msg) ? [{ type: "CORRECT_MEAL", from: "pap", to: "burger" }] : /vitamins/i.test(msg) ? [bag, { type: "SET_REMINDER", body: "take my vitamins", when: "tomorrow at 8am" }] : /nudge me/i.test(msg) ? [bag] : [];
    content = /garbled/i.test(msg) ? "not json" : JSON.stringify({ family: fix.length ? "correction" : "question", wants: "advice", one_question: null, uncertainty: /maybe/i.test(msg) ? 0.99 : 0.2, facts: [], actions: fix });
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

REAL("\npg-core-wave1-switch-acceptance — the new coach answers wave-1 turns, for everyone (#438)\n");
REAL("1. EVERYONE");
const f1 = await say(FOUNDER, ASK);
chk(f1.includes(NEW), "the founder's wave-1 question is answered by the new coach", f1);
const t1 = await say(TESTER, ASK);
chk(t1.includes(NEW), "a tester's wave-1 question is answered by the new coach too", t1);

REAL("\n1b. REACH (CTO attack on #445): the old wave-1 handlers stand aside for the switched client");
for (const q of ["What should I eat tonight?", "How was my week?", "What should I order at KFC?", "Should I take creatine?",
  "I've been stuck at 82kg for three weeks even though I'm eating well. What am I doing wrong?"]) {
  const fr = await say(FOUNDER, q);
  chk(fr.includes(NEW), `the founder's "${q}" reaches the new coach, not an old handler`, fr.slice(0, 160));
}
// A FOOD QUESTION IS NEVER A LOG: standing the permission-ask aside must not hand it to the logger.
const [fu] = (await pool.query("SELECT id FROM users WHERE phone_number = $1", [FOUNDER])).rows;
const mealsBefore = Number((await pool.query("SELECT COUNT(*)::int n FROM meal_logs WHERE user_id = $1", [fu.id])).rows[0].n);
await say(FOUNDER, "No, should I have had a burger instead?");
await say(FOUNDER, "Can I have a burger tonight?");
const mealsAfter = Number((await pool.query("SELECT COUNT(*)::int n FROM meal_logs WHERE user_id = $1", [fu.id])).rows[0].n);
chk(mealsAfter === mealsBefore, "the founder's \"can I have a burger?\" writes no meal", `${mealsBefore} → ${mealsAfter}`);
// "stuck at 82kg" is a plateau, not a reset: the old restart branch sent everyone the app menu.
const tp = await say(TESTER, "I've been stuck at 82kg for three weeks. What am I doing wrong?");
chk(!/What do you need\?/.test(tp), "a tester's plateau is not answered with the restart menu", tp.slice(0, 160));

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

REAL("\n4c. WAVE 2, A2 — THE NEW COACH READS THE CORRECTION, THE PROVEN ENGINE WRITES IT");
{
  const T = "whatsapp:+27829438003";
  await pool.query("DELETE FROM users WHERE phone_number = $1", [T]);
  await db.insert(schema.users).values({ phoneNumber: T, name: "Hayi Tester", onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(),
    subscriptionStatus: "active", goalType: "fat_loss", calorieTarget: 1800, proteinTarget: 120 } as any);
  process.env.CORE_WAVE2 = "on";
  await say(T, "I had pap for lunch");
  await say(T, "Hayi, I had a burger, not pap.");
  const rows = (await pool.query("SELECT items::text i FROM meal_logs m JOIN users u ON u.id = m.user_id WHERE u.phone_number = $1", [T])).rows.map(r => String(r.i));
  chk(rows.length === 1 && /burger/i.test(rows[0]) && !/"pap/i.test(rows[0]), "\"Hayi, I had a burger, not pap\" changes lunch in place: one meal, the burger, no pap", JSON.stringify(rows).slice(0, 300));
  delete process.env.CORE_WAVE2;
  await pool.query("DELETE FROM users WHERE phone_number = $1", [T]);
}

REAL("\n4b. WAVE 2, A1 + A5 — THE PROVEN WRITER LOGS, THE NEW COACH SPEAKS (on for everyone)");
{
  const count = async (phone: string) => Number((await pool.query("SELECT COUNT(*)::int n FROM meal_logs m JOIN users u ON u.id = m.user_id WHERE u.phone_number = $1", [phone])).rows[0].n);
  process.env.CORE_WAVE2 = "on"; // the shipped default; the runner pins other suites to "off"
  const fb = await count(FOUNDER), tb = await count(TESTER);
  const fa = await say(FOUNDER, "I had pap and chicken for lunch");
  const ta = await say(TESTER, "I had pap and chicken for lunch");
  chk(await count(FOUNDER) === fb + 1 && fa.includes(NEW), "the founder's lunch is written once, by the old owner, and they hear the new coach", fa.slice(0, 200));
  chk(await count(TESTER) === tb + 1 && ta.includes(NEW), "a tester's lunch is written once and they hear the new coach too", ta.slice(0, 200));
  const sa = await say(TESTER, "I walked 7500 steps today"), st = (await pool.query("SELECT MAX(s.steps)::int n FROM step_logs s JOIN users u ON u.id = s.user_id WHERE u.phone_number = $1", [TESTER])).rows[0].n; chk(st === 7500 && sa.includes(NEW), "A5: a tester's steps are written by the step owner and they hear the new coach", `${st} | ${sa.slice(0, 200)}`);
  process.env.CORE_WAVE2 = "off";
  const fo = await say(FOUNDER, "I had an apple for a snack");
  chk(!fo.includes(NEW) && await count(FOUNDER) === fb + 2, "CORE_WAVE2=off: the founder's meal is written and the old reply is back", fo.slice(0, 200));
  delete process.env.CORE_WAVE2;
}

REAL("\n4d. A14 — A REMINDER IN THEIR OWN WORDS IS READ BY THE NEW COACH AND SAVED BY THE PROVEN COMMAND");
{ const rr = await say(TESTER, "Could you nudge me before gym tomorrow at 7am, I always forget my bag"), n = (await pool.query("SELECT COUNT(*)::int n FROM reminders r JOIN users u ON u.id = r.user_id WHERE u.phone_number = $1 AND r.kind = 'user'", [TESTER])).rows[0].n;
  const said = (await pool.query("SELECT message_in FROM chat_history c JOIN users u ON u.id = c.user_id WHERE u.phone_number = $1 AND c.intent = 'REMINDER_SET' ORDER BY c.id DESC LIMIT 1", [TESTER])).rows[0]?.message_in;
  chk(n === 1 && /remind you to pack my gym bag/i.test(rr) && /nudge me before gym/i.test(said || ""), "the reminder is a row, the reply confirms the exact time, the record keeps their words", `${n} | ${said} | ${rr.slice(0, 120)}`);
  const count = async () => (await pool.query("SELECT COUNT(*)::int n FROM reminders r JOIN users u ON u.id = r.user_id WHERE u.phone_number = $1 AND r.kind = 'user'", [TESTER])).rows[0].n;
  const um = await say(TESTER, "Maybe nudge me about my gym bag, I haven't decided when"); chk(await count() === 1 && /when should I remind you/i.test(um), "unsure of the time: it asks, and saves nothing", um.slice(0, 120));
  await pool.query("UPDATE users SET awaiting_input_type = NULL WHERE phone_number = $1", [TESTER]);
  const two = await say(TESTER, "Nudge me to pack my gym bag tomorrow at 7am and give me a shout for vitamins at 8am"); chk(await count() === 3 && /vitamins/i.test(two), "two reminders in one message: both saved, both confirmed", `${await count()} | ${two.slice(0, 160)}`); }

REAL("\n5. INSTANT ROLLBACK");
process.env.CORE_WAVE1 = "off";
const f4 = await say(FOUNDER, ASK);
chk(!f4.includes(NEW), "CORE_WAVE1=off: the founder is back on the old coach, with no deploy", f4);

for (const phone of [FOUNDER, TESTER]) await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
REAL(`\npg-core-wave1-switch-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

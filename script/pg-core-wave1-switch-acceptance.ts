/**
 * REAL-POSTGRESQL ACCEPTANCE — the wave-1 switch (COVERAGE A10, A11, A13, A16, A17; #438).
 *
 * With the model stubbed at the network edge, this proves the switch's plumbing:
 *   - every client meets the new coach (its CORE_WAVE1 off-path was deleted 6 Oct);
 *   - the new coach answers where gpt-block did, BEHIND the scope floor (an off-topic ask is still declined);
 *   - a message the new coach cannot read falls back to the old reply: never silence, never a guess (#421);
 *   - a client midway through an old flow (a menu awaiting "1/2/3") finishes it there (#440);
 */
if (!process.env.DATABASE_URL) { console.log("pg-core-wave1-switch-acceptance: SKIPPED — no DATABASE_URL."); process.exit(0); }
process.env.OPENAI_API_KEY = "sk-stub"; process.env.OFFLINE_AI = "0"; process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "on"; process.env.PROACTIVE_PAUSED = "true"; process.env.NODE_ENV = "production";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000"; process.env.TWILIO_AUTH_TOKEN = "test"; process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
const FOUNDER = "whatsapp:+27829438001", TESTER = "whatsapp:+27829438002";

const NEW = "NEW-COACH-438"; // only the new coach's composer says this
const DOW = (back: number) => new Intl.DateTimeFormat("en-ZA", { weekday: "long", timeZone: "Africa/Johannesburg" }).format(new Date(Date.now() - back * 86_400_000));
const LIST = `${DOW(2)} pap and wors, ${DOW(1)} eggs and toast, ${DOW(0)} chicken and rice`;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  if (!url.includes("api.openai.com")) return realFetch(input, init);
  const body = typeof init?.body === "string" ? init.body : "";
  let content = "Old coach here, noted.";
  if (body.includes("say what they want from this turn")) {
    const msg = JSON.parse(body).messages.at(-1).content as string;
    const bag = { type: "SET_REMINDER", body: "pack my gym bag", when: "tomorrow at 7am" };
    const log586 = /kota from the spaza/i.test(msg) ? [{ type: "LOG_MEAL", foodText: "kota", needsConfirmation: false }] : /ndidle ipapa/i.test(msg) ? [{ type: "LOG_MEAL", foodText: "pap and meat", needsConfirmation: false }]
      : /recalculate everything|remove my last meal/i.test(msg) ? [{ type: "REMOVE_LAST_MEAL" }]
      : msg === LIST ? [{ type: "LOG_MEAL", foodText: "pap and wors", retro: DOW(2), needsConfirmation: false }, { type: "LOG_MEAL", foodText: "eggs and toast", retro: DOW(1), needsConfirmation: false }, { type: "LOG_MEAL", foodText: "chicken and rice", retro: DOW(0), needsConfirmation: false }]
      : /^two meals, one card$/i.test(msg) ? [{ type: "LOG_MEAL", foodText: "rice and chicken", meal: "lunch", needsConfirmation: false }, { type: "LOG_MEAL", foodText: "samp and beans", meal: "dinner", needsConfirmation: false }]
      : /^Had pap and wors for lunch and did a 30 min home workout$/i.test(msg) ? [{ type: "LOG_MEAL", foodText: "pap and wors", meal: "lunch", needsConfirmation: false }, { type: "LOG_WORKOUT", what: "a 30 min home workout" }]
      : /^what'?s my workout today\??$/i.test(msg) ? [{ type: "SHOW_WORKOUT" }]
      : /ndisele i-red bull/i.test(msg) ? [{ type: "LOG_MEAL", foodText: "a Red Bull", needsConfirmation: false }]
      : /ndityile into/i.test(msg) ? [{ type: "LOG_MEAL", foodText: "something", needsConfirmation: false }]
      : /ndizilinganise, 82 not sure/i.test(msg) ? [{ type: "LOG_WEIGHT", kg: 82 }]
      : /pieces of KFC/i.test(msg) ? [{ type: "LOG_MEAL", foodText: "2 pieces of KFC and a small chips", needsConfirmation: false }]
      : /^I weigh 87kg today$/i.test(msg) ? [{ type: "LOG_WEIGHT", kg: 87 }]
      : /some rice from mama/i.test(msg) ? [{ type: "LOG_MEAL", foodText: "some rice", needsConfirmation: true }] : /ndihambe 6200/i.test(msg) ? [{ type: "LOG_STEPS", count: 6200 }] : null;
    // #592: the front door reads every message, so the stub reads the suite's reports as a model would.
    const meal = msg.match(/^(?:then )?I had (?:an? )?(.+?)(?: for (lunch|a snack|snack))?\.?$/i);
    const front = /not pap/i.test(msg) ? null : meal ? [{ type: "LOG_MEAL", foodText: meal[1], ...(meal[2] ? { meal: meal[2].replace("a ", "") } : {}), needsConfirmation: false }]
      : /^I walked (\d+) steps/i.test(msg) ? [{ type: "LOG_STEPS", count: Number(msg.match(/\d+/)![0]) }] : /^I did a (.+)$/i.test(msg) ? [{ type: "LOG_WORKOUT", what: msg.slice(8) }]
      : /^change my goal to muscle gain$/i.test(msg) ? [{ type: "SET_GOAL", goal: "muscle_gain" }] : null;
    const fix = log586 ? log586 : front ? front : /not pap/i.test(msg) ? [{ type: "CORRECT_MEAL", from: "pap", to: "burger" }] : /vitamins/i.test(msg) ? [bag, { type: "SET_REMINDER", body: "take my vitamins", when: "tomorrow at 8am" }] : /nudge me/i.test(msg) ? [bag] : [];
    content = /garbled/i.test(msg) ? "not json" : JSON.stringify({ scope: /homework/i.test(msg) ? "out" : "in", family: fix.length ? "correction" : "question", wants: "advice", one_question: null, ...(/not sure/i.test(msg) ? {} : { uncertainty: /maybe/i.test(msg) ? 0.99 : 0.2 }), facts: /^I don't eat fish$/i.test(msg) ? [{ kind: "preference", subject: "no fish", statement: "I don't eat fish", detail: {} }] : /hold me to it/i.test(msg) ? [{ kind: "commitment", subject: "walk", statement: "hold me to it", detail: { domain: "movement", what: "a walk after work", due: new Date(Date.now() + 7_200_000).toISOString().slice(0, 10) } }] : [], actions: fix });
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

REAL("\n4b. WAVE 2, A1 + A5 + A8 + A12 — THE PROVEN WRITER LOGS, THE NEW COACH SPEAKS (on for everyone)");
{
  const count = async (phone: string) => Number((await pool.query("SELECT COUNT(*)::int n FROM meal_logs m JOIN users u ON u.id = m.user_id WHERE u.phone_number = $1", [phone])).rows[0].n);
  process.env.CORE_WAVE2 = "on"; // the shipped default; the runner pins other suites to "off"
  const fb = await count(FOUNDER), tb = await count(TESTER);
  const fa = await say(FOUNDER, "I had pap and chicken for lunch");
  const ta = await say(TESTER, "I had pap and chicken for lunch");
  chk(await count(FOUNDER) === fb + 1 && fa.includes(NEW), "the founder's lunch is written once, by the old owner, and they hear the new coach", fa.slice(0, 200));
  chk(await count(TESTER) === tb + 1 && ta.includes(NEW), "a tester's lunch is written once and they hear the new coach too", ta.slice(0, 200));
  const sa = await say(TESTER, "I walked 7500 steps today"), st = (await pool.query("SELECT MAX(s.steps)::int n FROM step_logs s JOIN users u ON u.id = s.user_id WHERE u.phone_number = $1", [TESTER])).rows[0].n; chk(st === 7500 && sa.includes(NEW), "A5: a tester's steps are written by the step owner and they hear the new coach", `${st} | ${sa.slice(0, 200)}`);
  const wa = await say(TESTER, "I did a 30 minute HIIT class"), wn = (await pool.query("SELECT COUNT(*)::int n FROM workout_logs w JOIN users u ON u.id = w.user_id WHERE u.phone_number = $1", [TESTER])).rows[0].n; chk(wn === 1 && wa.includes(NEW), "A8: a tester's class is written by the workout owner and they hear the new coach", `${wn} | ${wa.slice(0, 200)}`);
  await pool.query("DELETE FROM workout_logs WHERE user_id = (SELECT id FROM users WHERE phone_number = $1)", [TESTER]);
  const mb = await count(TESTER), both = await say(TESTER, "Had pap and wors for lunch and did a 30 min home workout"), wb = (await pool.query("SELECT COUNT(*)::int n FROM workout_logs w JOIN users u ON u.id = w.user_id WHERE u.phone_number = $1", [TESTER])).rows[0].n;
  chk(await count(TESTER) === mb + 1 && wb === 1 && both.includes(NEW), "a meal and a workout in one message are both written, in one reply (#609)", `${wb} | ${both.slice(0, 200)}`);
  const f2 = await say(TESTER, "2");
  chk(/zone|keep these weights/i.test(f2), "\"2\" answers the numbered \"How did that session feel?\" as Just right (founder's Monday plan, item 4)", f2.slice(0, 200));
  const sw = await say(TESTER, "what's my workout today?");
  chk(/✅|Warm-up/i.test(sw) && !sw.includes(NEW) && !/haven't written/i.test(sw), "\"what's my workout today?\" is the programme's answer (here: today's session is done), not the model's guess (item 4)", sw.slice(0, 200));
  await pool.query("DELETE FROM workout_logs WHERE user_id = (SELECT id FROM users WHERE phone_number = $1)", [TESTER]);
  const dn = await say(TESTER, "Done 💪"), dw = (await pool.query("SELECT COUNT(*)::int n FROM workout_logs w JOIN users u ON u.id = w.user_id WHERE u.phone_number = $1", [TESTER])).rows[0].n;
  chk(dw === 1 && !dn.includes(NEW), "the \"Done 💪\" button under today's session logs it, by the workout owner", `${dw} | ${dn.slice(0, 160)}`);
  const sk = await say(TESTER, "Skip today");
  chk(!sk.includes(NEW) && sk.trim().length > 0, "the \"Skip today\" button is answered by the programme's skip, not the model", sk.slice(0, 160));
  const nx = await say(TESTER, "Tomorrow's session");
  chk(!nx.includes(NEW) && /Warm-up|sets|Week/i.test(nx), "the \"Tomorrow's session\" button shows the programme's next session, not the model's", nx.slice(0, 200));
  const costRows = async () => Number((await pool.query("SELECT COUNT(*)::int n FROM gpt_costs g JOIN users u ON u.id = g.user_id WHERE u.phone_number = $1 AND g.feature = 'core'", [TESTER])).rows[0].n);
  const c0 = await costRows();
  const ot = await say(TESTER, "Am I on track?");
  await new Promise(r => setTimeout(r, 300)); // the cost row is written fire-and-forget
  chk(await costRows() >= c0 + 2, "the new coach's model calls are priced into gpt_costs, where the daily cap reads (#570)", `${c0} → ${await costRows()}`); await say(TESTER, "change my goal to muscle gain"); const gy = await say(TESTER, "yes"), g = (await pool.query("SELECT goal_type FROM users WHERE phone_number = $1", [TESTER])).rows[0].goal_type;
  chk(ot.includes(NEW) && g === "muscle_gain" && gy.includes(NEW), "A12: \"am I on track?\" and a confirmed goal change are the new coach's words (the goal still written)", `${g} | ${ot.slice(0, 120)} | ${gy.slice(0, 120)}`);
  process.env.CORE_WAVE2 = "off";
  const fo = await say(FOUNDER, "I had an apple for a snack");
  chk(!fo.includes(NEW) && await count(FOUNDER) === fb + 2, "CORE_WAVE2=off: the founder's meal is written and the old reply is back", fo.slice(0, 200));
  delete process.env.CORE_WAVE2;
}

REAL("\n4e. #575 — A TYPED MEAL KEEPS THE HEALTH-STANDARD GUARDRAIL UNDER THE NEW COACH'S WORDS");
{ const G = "whatsapp:+27829438575"; await pool.query("DELETE FROM users WHERE phone_number = $1", [G]);
  await db.insert(schema.users).values({ phoneNumber: G, name: "Monster Tester", onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(), subscriptionStatus: "active", goalType: "fat_loss", calorieTarget: 1800, proteinTarget: 120 } as any);
  process.env.CORE_WAVE2 = "on"; await say(G, "I had a Monster energy drink"); const r = await say(G, "Then I had a Red Bull"); delete process.env.CORE_WAVE2;
  chk(r.includes(NEW) && /caffeine, not fuel/i.test(r) && r.split(/caffeine, not fuel/i).length === 2, "the second energy drink: the new coach's words, then the caffeine guardrail, once", r.slice(0, 300));
  await pool.query("DELETE FROM users WHERE phone_number = $1", [G]); }

REAL("\n4f. #578 — \"ANOTHER\" IS ANOTHER ONE, NOT A RESEND");
{ const A = "whatsapp:+27829438578"; await pool.query("DELETE FROM users WHERE phone_number = $1", [A]);
  await db.insert(schema.users).values({ phoneNumber: A, name: "Second Can", onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(), subscriptionStatus: "active", goalType: "fat_loss", calorieTarget: 1800, proteinTarget: 120 } as any);
  process.env.CORE_WAVE2 = "on"; await say(A, "I had a Monster energy drink"); await say(A, "I had another Monster energy drink"); await say(A, "I had a Monster energy drink"); delete process.env.CORE_WAVE2;
  const n = Number((await pool.query("SELECT COUNT(*)::int n FROM meal_logs m JOIN users u ON u.id = m.user_id WHERE u.phone_number = $1", [A])).rows[0].n);
  chk(n === 2, "\"I had another Monster\" writes a second can; a plain resend of the first is still one", `${n} rows`);
  await pool.query("DELETE FROM users WHERE phone_number = $1", [A]); }

REAL("\n4g. #586 — A MEAL THE OLD KEYWORDS MISS IS WRITTEN FOR AN ORDINARY CLIENT (NO BETA COHORT)");
{ const K = "whatsapp:+27829438586"; await pool.query("DELETE FROM users WHERE phone_number = $1", [K]);
  await db.insert(schema.users).values({ phoneNumber: K, name: "Spaza Tester", onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(), subscriptionStatus: "active", goalType: "fat_loss", calorieTarget: 1800, proteinTarget: 120 } as any);
  const meals = async () => (await pool.query("SELECT raw_message r FROM meal_logs m JOIN users u ON u.id = m.user_id WHERE u.phone_number = $1 ORDER BY m.id", [K])).rows.map(r => String(r.r));
  const k1 = await say(K, "Kota from the spaza"), k2 = await say(K, "Ndidle ipapa nenyama"), m2 = await meals();
  chk(m2.length === 2 && m2.some(r => /kota/i.test(r)) && m2.some(r => /pap/i.test(r)) && k1.includes(NEW) && k2.includes(NEW), "\"Kota from the spaza\" and \"Ndidle ipapa nenyama\" each write a meal, and the new coach answers after the write", `${JSON.stringify(m2)} | ${k1.slice(0, 120)} | ${k2.slice(0, 120)}`);
  const ks = await say(K, "Ndihambe 6200 steps namhlanje"), st = (await pool.query("SELECT MAX(s.steps)::int n FROM step_logs s JOIN users u ON u.id = s.user_id WHERE u.phone_number = $1", [K])).rows[0].n;
  chk(st === 6200 && ks.includes(NEW), "isiXhosa steps are written by the step tool", `${st} | ${ks.slice(0, 120)}`);
  const kv = await say(K, "Some rice from mama's pot"), held = (await meals()).length, ky = await say(K, "yes"), after = (await meals()).length;
  chk(/reply \*yes\*/i.test(kv) && held === 2 && after === 3 && ky.trim().length > 0, "a vague amount asks first; the client's \"yes\" writes it (the cohort gate is gone)", `${held} → ${after} | ${kv.slice(0, 120)} | ${ky.slice(0, 120)}`);
  const before = (await meals()).length, rb = await say(K, "Ndisele i-Red Bull"), withRb = await meals();
  chk(withRb.length === before + 1 && withRb.some(r => /red bull/i.test(r)) && rb.includes(NEW), "a drink read as a meal is written (the writer is handed \"I had …\", #593)", `${before} → ${withRb.length} | ${rb.slice(0, 120)}`);
  const sm = await say(K, "Ndityile into"), afterSm = (await meals()).length;
  chk(afterSm === withRb.length && !sm.includes(NEW) && sm.trim().length > 0, "a meal the writer could not write is never answered as logged: the client gets the writer's own question (#593)", `${withRb.length} → ${afterSm} | ${sm.slice(0, 160)}`);
  const keep = (await meals()).length, fx = await say(K, "No fix it. Recalculate everything");
  chk((await meals()).length === keep && !/removed/i.test(fx), "\"No fix it. Recalculate everything\" read as a removal deletes nothing: the bouncer needs their own removal words (#597 attack)", `${keep} → ${(await meals()).length} | ${fx.slice(0, 120)}`);
  await say(K, "Please remove my last meal");
  chk((await meals()).length === keep - 1, "CONTROL: \"Please remove my last meal\" still removes it", `${keep} → ${(await meals()).length}`);
  await pool.query("DELETE FROM meal_logs WHERE user_id = (SELECT id FROM users WHERE phone_number = $1)", [K]);
  const li = await say(K, LIST), days = (await pool.query("SELECT ((now() AT TIME ZONE 'Africa/Johannesburg')::date - (logged_at AT TIME ZONE 'Africa/Johannesburg')::date) back FROM meal_logs m JOIN users u ON u.id = m.user_id WHERE u.phone_number = $1 ORDER BY logged_at", [K])).rows.map(r => Number(r.back));
  chk(JSON.stringify(days) === "[2,1,0]" && li.includes(NEW), "a three-day list lands on its three days, today's own weekday name included, in one reply (founder, 7 Oct)", `${JSON.stringify(days)} | ${li.slice(0, 100)}`);
  process.env.APP_URL = "https://kamlife.example"; (await import("../server/card-policy"))._resetDumpWindow();
  const two = await say(K, "two meals, one card"); delete process.env.APP_URL;
  chk((two.match(/\[MEDIA:https:\/\/kamlife\.example\/card\//g) || []).length === 1, "two meals in one message get one card, drawn after both are written (founder, 7 Oct: people send lists)", two.slice(0, 200));
  { const { cardMeals } = await import("../server/core/coach"), { sastDayKey } = await import("../server/sast"), mon = new Date(Date.now() - 2 * 864e5), now = new Date();
    const pick = cardMeals([{ name: "pap", sid: "a" }, { name: "rice", sid: "b" }, { name: "eggs", sid: "c" }], [{ sid: "a", protein: 9, at: mon }, { sid: "b", protein: 30, at: now }, { sid: "c", protein: 12, at: now }], sastDayKey);
    chk(pick?.name === "rice + eggs" && pick.protein === 30, "a list's card names only the meals on its own day, with the biggest one's protein, never 0 (#616 review)", JSON.stringify(pick)); }
  const kw = await say(K, "Ndizilinganise, 82 not sure"), w82 = (await pool.query("SELECT COUNT(*)::int n FROM weight_logs w JOIN users u ON u.id = w.user_id WHERE u.phone_number = $1", [K])).rows[0].n;
  chk(w82 === 0 && /82kg\*\? Reply \*yes\*/i.test(kw), "a reading that does not say how sure it is asks before writing a weight (#593 attack)", `${w82} rows | ${kw.slice(0, 120)}`);
  await pool.query("UPDATE users SET awaiting_input_type = NULL WHERE phone_number = $1", [K]);
  await pool.query("DELETE FROM users WHERE phone_number = $1", [K]); }
REAL("\n4h. #592 — THE FRONT DOOR: THE NEW COACH READS FIRST, THE TOOLS WRITE, THE OLD DOORS ARE THE ROLLBACK");
{ const F = "whatsapp:+27829438592"; await pool.query("DELETE FROM users WHERE phone_number = $1", [F]);
  await db.insert(schema.users).values({ phoneNumber: F, name: "Front Tester", onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(), subscriptionStatus: "active", goalType: "fat_loss", currentWeight: "88", targetWeightKg: "75", calorieTarget: 1800, proteinTarget: 120 } as any);
  const one = async (sql: string) => (await pool.query(sql.replace("$P", "(SELECT id FROM users WHERE phone_number = $1)"), [F])).rows[0];
  const kfc = await say(F, "just finished 2 pieces of KFC and a small chips"), meal = await one("SELECT raw_message r FROM meal_logs WHERE user_id = $P");
  chk(/kfc/i.test(meal?.r || "") && kfc.includes(NEW) && !/order|menu pick/i.test(kfc), "\"just finished 2 pieces of KFC\" is logged and answered, never an ordering card (#589)", `${meal?.r} | ${kfc.slice(0, 160)}`);
  const sid = `SM592fish${Date.now()}`; await handleMessage(F, "I don't eat fish", undefined, undefined, [], sid);
  await (await import("../server/core/client-record")).recordInbound({ phone: F, rawText: "I don't eat fish", sourceMessageId: sid }); await (await import("../server/core/coach")).learnFromLiveRead(F, sid);
  const pref = await one("SELECT statement FROM client_facts WHERE user_id = $P AND kind = 'preference'"), notes = (await one("SELECT profile_notes n FROM users WHERE id = $P"))?.n || "";
  chk(pref?.statement === "I don't eat fish" && !/vegetarian/.test(notes), "\"I don't eat fish\" is stored as they said it, and they are not made vegetarian (#588)", `${pref?.statement} | ${notes}`);
  const wr = await say(F, "I weigh 87kg today"), w = await one("SELECT current_weight c, target_weight_kg g FROM users WHERE id = $P");
  chk(Number(w.c) === 87 && Number(w.g) === 75 && !/that's the goal/i.test(wr), "\"I weigh 87kg today\" logs the weight and leaves the 75kg goal (#587)", `${w.c} / ${w.g} | ${wr.slice(0, 120)}`);
  process.env.CORE_FRONT = "off"; const back = await say(F, "Any ideas for a cheap supper tonight?"); delete process.env.CORE_FRONT;
  chk(back.trim().length > 0, "CORE_FRONT=off: the old doors answer again (the rollback works)", back.slice(0, 120));
  await pool.query("DELETE FROM users WHERE phone_number = $1", [F]); }
{ const [t] = (await pool.query("SELECT id FROM users WHERE phone_number = $1", [TESTER])).rows, at = (hm: string) => `((now() AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date - 1 + time '${hm}') AT TIME ZONE 'Africa/Johannesburg' AT TIME ZONE 'UTC'`; await pool.query("DELETE FROM meal_logs WHERE user_id = $1", [t.id]); await pool.query("DELETE FROM step_logs WHERE user_id = $1", [t.id]); await pool.query(`INSERT INTO meal_logs (user_id, raw_message, source, kcal_int, protein_int, logged_at) VALUES ($1, 'oats', 'sa_scanner', 300, 10, ${at("00:30")})`, [t.id]); const step = (n: number, prov: string) => pool.query(`INSERT INTO step_logs (user_id, steps, provenance, logged_at) VALUES ($1, ${n}, '${prov}', ${at("23:30")})`, [t.id]), traj = async () => (await import("../server/trajectory-report")).getTrajectoryForUser(t.id); await step(10000, "client_report"); const tr = await traj(); await step(50000, "unverified"); const tu = await traj(); chk(tr?.daysLogged === 1 && (tr?.avgStepBurn ?? 0) > 0 && tu?.avgStepBurn === tr?.avgStepBurn, "#539/#540: 00:30 oats and 23:30 steps are one SAST day; trusted steps count, an unverified row changes nothing", JSON.stringify({ d: tr?.daysLogged, burn: tr?.avgStepBurn, withUnverified: tu?.avgStepBurn })); }
{ const sid = "SM545live", said = "I'll walk after work today, hold me to it"; await handleMessage(TESTER, said, undefined, undefined, [], sid); const { recordInbound } = await import("../server/core/client-record"); await recordInbound({ phone: TESTER, rawText: said, sourceMessageId: sid }); const k = await (await import("../server/core/coach")).learnFromLiveRead(TESTER, sid); chk(k === 1 && (await pool.query("SELECT count(*)::int n FROM client_facts f JOIN users u ON u.id = f.user_id WHERE u.phone_number = $1 AND f.kind = 'commitment'", [TESTER])).rows[0].n === 1, "#545: with shadow off, the live coach's own read stores the commitment it accepted", String(k)); }
{ const [t] = (await pool.query("SELECT id FROM users WHERE phone_number = $1", [TESTER])).rows; for (const d of [3, 1]) await pool.query("INSERT INTO client_facts (user_id, kind, subject, statement, detail, extracted_by, created_at) VALUES ($1, 'commitment', 'commitment', 'no', $2, 'test', now() - make_interval(days => $3))", [t.id, JSON.stringify({ domain: "movement", what: "a walk", due: "2026-10-01", state: "missed", outcome: "missed" }), d]); const f = await (await import("../server/core/client-record")).factsForCoach(t.id); chk(/don't propose another movement one this week; if you offer one, make it one small food habit/.test(f), "A19 §6: two movement misses in a row, and the coach offers food instead", f.slice(-200)); const cr = await import("../server/core/client-record"); const [{ id }] = (await pool.query("INSERT INTO client_facts (user_id, kind, subject, statement, detail, extracted_by) VALUES ($1, 'commitment', 'commitment', 'yes', $2, 'test') RETURNING id", [t.id, JSON.stringify({ domain: "food", what: "no takeaways", due: "2026-10-06", state: "open" })])).rows; const st = async () => (await pool.query("SELECT detail->>'state' s FROM client_facts WHERE id = $1", [id])).rows[0].s; cr.followUpRides(TESTER, id); await cr.closeFollowUp(TESTER, false); const dropped = await st(); cr.followUpRides(TESTER, id); await cr.closeFollowUp(TESTER, true); chk(dropped === "open" && await st() === "asked", "#545 @ 07f9c1f: the follow-up is asked only once a reply carrying it is delivered", `${dropped} → ${await st()}`); }
REAL("\n4d. A14 — A REMINDER IN THEIR OWN WORDS IS READ BY THE NEW COACH AND SAVED BY THE PROVEN COMMAND");
{ const rr = await say(TESTER, "Could you nudge me before gym tomorrow at 7am, I always forget my bag"), n = (await pool.query("SELECT COUNT(*)::int n FROM reminders r JOIN users u ON u.id = r.user_id WHERE u.phone_number = $1 AND r.kind = 'user'", [TESTER])).rows[0].n;
  const said = (await pool.query("SELECT message_in FROM chat_history c JOIN users u ON u.id = c.user_id WHERE u.phone_number = $1 AND c.intent = 'REMINDER_SET' ORDER BY c.id DESC LIMIT 1", [TESTER])).rows[0]?.message_in;
  chk(n === 1 && /remind you to pack my gym bag/i.test(rr) && /nudge me before gym/i.test(said || ""), "the reminder is a row, the reply confirms the exact time, the record keeps their words", `${n} | ${said} | ${rr.slice(0, 120)}`);
  const count = async () => (await pool.query("SELECT COUNT(*)::int n FROM reminders r JOIN users u ON u.id = r.user_id WHERE u.phone_number = $1 AND r.kind = 'user'", [TESTER])).rows[0].n;
  const um = await say(TESTER, "Maybe nudge me about my gym bag, I haven't decided when"); chk(await count() === 1 && /when should I remind you/i.test(um), "unsure of the time: it asks, and saves nothing", um.slice(0, 120)); await pool.query("UPDATE users SET awaiting_input_type = NULL WHERE phone_number = $1", [TESTER]);
  const two = await say(TESTER, "Nudge me to pack my gym bag tomorrow at 7am and give me a shout for vitamins at 8am"); const rows = (await pool.query("SELECT COUNT(*)::int n FROM chat_history c JOIN users u ON u.id = c.user_id WHERE u.phone_number = $1 AND c.message_in LIKE 'Nudge me to pack%'", [TESTER])).rows[0].n; chk(await count() === 3 && /vitamins/i.test(two) && rows === 1, "two reminders in one message: both saved, both confirmed, one row in the chat record", `${await count()} | rows=${rows} | ${two.slice(0, 120)}`); }

for (const phone of [FOUNDER, TESTER]) await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
REAL(`\npg-core-wave1-switch-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

/**
 * REAL-POSTGRESQL ACCEPTANCE — pregnancy and disordered eating are routed before any reply (#266).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS PROVEN BROKEN ON main, BEFORE ANY EDIT — AUDIT.md Traces 3 and 6
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *  "I'm 14 weeks pregnant, what should my calorie target be?"
 *      → the calorie-totals branch claims the turn on "calorie target" and answers with her
 *        fat-loss number. Pregnancy is detected only AFTER the reply, as an escalation row.
 *        Nothing durable records it, so the next "what's my calorie target?" and every morning
 *        brief carry on as a weight-loss programme.
 *
 *  "I've been making myself throw up after dinner so the calories don't count"
 *      → the disordered-eating owner (life-context.ts) exists, but its pattern says "MAKE myself",
 *        so "MAKING myself" falls through to the food path: "I didn't catch that one — what was
 *        it, roughly?". detectEscalation has no disordered-eating rule, so no human hears of it.
 *
 *  Onboarding asks "are you currently pregnant, recently gave birth, or breastfeeding?" and
 *  offers one yes — "postpartum or breastfeeding" — so "Yes, I'm pregnant" is recorded as
 *  postpartum and answered "We will lose the weight slowly".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS GRADED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Final WhatsApp bodies from shadow_replies (post-transport, both doors), users.life_situation,
 * escalations rows (the human hand-off), and meal_logs (food still logs). Controls prove the
 * routing does not swallow ordinary talk: third-person pregnancy, "I'm not pregnant", gym nausea,
 * "burn it off tomorrow".
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-safety-routing-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "0";
process.env.NORMALIZER = "off";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";
delete process.env.COACH_ALERT_PHONE; // the escalation ROW is the hand-off graded; no live page
delete process.env.PROACTIVE_PAUSED;

// The mouth quotes a weight-loss target on purpose: if any path hands a withheld client to the
// model, the stub's answer is exactly what must never reach them.
const COACH_ANSWER = "Stick to your 1800 kcal target today and you'll keep losing weight.";
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
    const isClassifier = body.includes("message-understanding brain");
    return new Response(JSON.stringify({
      id: "chatcmpl-266", object: "chat.completion", created: 1, model: "gpt-4o-mini",
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
const { sendWhatsApp } = await import("../server/scheduler/shared");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");
const { _resetInteractionCorrelation } = await import("../server/handlers/chat-log");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

let seq = 0;
async function client(name: string, extra: Record<string, unknown> = {}) {
  const phone = `whatsapp:+2782000266${String(++seq).padStart(1, "0")}`;
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name, onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(),
    subscriptionStatus: "active", goalType: "fat_loss", currentWeight: "74", startWeight: "78", targetWeight: "66",
    heightCm: 164, age: 29, gender: "female", trainingMode: "home", lifeSituation: "office",
    proteinTarget: 115, calorieTarget: 1800, dailyCalorieTarget: 1800, ...extra,
  } as any).returning();
  return { id: u.id as string, phone };
}
const lastShadowId = async () => Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM shadow_replies")).rows[0].m);
async function say(c: { phone: string }, text: string): Promise<string> {
  _resetOutboundDedupe(); _resetInteractionCorrelation();
  const s0 = await lastShadowId();
  await processTextAsync(c.phone, text, null, null, [], handleMessage as any, `SM266-${++seq}`);
  await new Promise(r => setTimeout(r, 1500));
  return (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2 ORDER BY id", [c.phone, s0]))
    .rows.map(r => r.body).join("\n");
}
const situation = async (c: { id: string }) => (await pool.query("SELECT life_situation s FROM users WHERE id = $1", [c.id])).rows[0].s as string | null;
const escalationReasons = async (c: { id: string }) =>
  (await pool.query<{ reason: string }>("SELECT reason FROM escalations WHERE user_id = $1", [c.id])).rows.map(r => r.reason);

/** A weight-loss number or instruction — what a withheld client must never receive. */
const givesWeightLossTarget = (b: string) =>
  /\b\d[\d,]{2,}\s*(?:kcal|calories)\b/i.test(b) || /\b(?:lose|losing)\s+(?:the\s+)?weight\b|\bfat[- ]loss\b|\bdeficit\b/i.test(b)
  || /\b(?:calories|protein)\s*:?\s*\*?\d/i.test(b);
const refersToCare = (b: string) => /\b(doctor|midwife|clinic)\b/i.test(b);
const givesEdHelpline = (b: string) => /0800 567 567/.test(b);
const asksWhatItWas = (b: string) => /what was it, roughly/i.test(b);

REAL("\npg-safety-routing-acceptance — pregnancy and disordered eating are routed before any reply\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("0. THE INSTRUMENTS");
// ══════════════════════════════════════════════════════════════════════════════════════════════
chk(givesWeightLossTarget("Bonolo Tester, all 2700 kcal — nothing logged yet today.") && givesWeightLossTarget(COACH_ANSWER),
  "the detector reads the measured base reply and the stubbed mouth as weight-loss targets");
chk(!givesWeightLossTarget("During pregnancy your doctor or midwife should guide what you eat."), "and not the safe answer");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n1. PREGNANCY — AUDIT.md Trace 3");
// ══════════════════════════════════════════════════════════════════════════════════════════════
const P = await client("Bonolo Pregnant");
{
  const r = await say(P, "I'm 14 weeks pregnant, what should my calorie target be?");
  REAL(`        final body: ${JSON.stringify(r)}`);
  chk(!givesWeightLossTarget(r), "she is not given a weight-loss target", `reply=${JSON.stringify(r)}`);
  chk(/^Bonolo,/.test(r), "the disclosure reply itself is delivered as written, to her by name", `reply=${JSON.stringify(r)}`);
  chk(refersToCare(r), "she is pointed to her doctor, midwife or clinic", `reply=${JSON.stringify(r)}`);
  chk((await situation(P)) === "pregnant", "her pregnancy is recorded durably", `life_situation=${await situation(P)}`);
  chk((await escalationReasons(P)).length > 0, "a person is flagged (escalation row)", JSON.stringify(await escalationReasons(P)));
}
{
  const r = await say(P, "what's my calorie target?");
  chk(!givesWeightLossTarget(r), "a later turn that never mentions pregnancy still gets no weight-loss target", `reply=${JSON.stringify(r)}`);
  chk(refersToCare(r), "and is answered with the careful referral, not a stall", `reply=${JSON.stringify(r)}`);
}
{
  const r = await say(P, "What should I eat tonight?");
  chk(!givesWeightLossTarget(r), "a turn the model answers cannot carry a target to her either", `reply=${JSON.stringify(r)}`);
  // Codex review @ 8e4f231: "no targets" means protein and macros too, not only calories.
  const rp = await say(P, "what's my protein target?");
  chk(!/\b\d{2,4}\s*g\b/i.test(rp), "nor a protein target in grams", `reply=${JSON.stringify(rp)}`);
}
{
  // The proactive door: a morning-brief-shaped target. The control client proves the send path works.
  const C = await client("Control Office");
  const s0 = await lastShadowId();
  await sendWhatsApp(P.phone, "Good morning! Your target today: 1800 kcal and 120g protein. Weigh-in tomorrow.").catch(() => {});
  await sendWhatsApp(C.phone, "Good morning! Your target today: 1800 kcal and 120g protein. Weigh-in tomorrow.").catch(() => {});
  const toP = (await pool.query("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2", [P.phone, s0])).rows.map((x: any) => x.body).join("\n");
  const toC = (await pool.query("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2", [C.phone, s0])).rows.map((x: any) => x.body).join("\n");
  chk(/1800 kcal/.test(toC), "control: the same proactive brief reaches an ordinary client", `sent=${JSON.stringify(toC)}`);
  chk(!givesWeightLossTarget(toP), "a proactive calorie target never reaches a pregnant client", `sent=${JSON.stringify(toP)}`);
}

{
  // Codex attack @ 8e4f231: WhatsApp on an iPhone sends a typographic apostrophe. "I’m" must route
  // exactly like "I'm" — through the real front door, recorded, and flagged.
  const Q = await client("Bonolo Smartquote");
  const r = await say(Q, "I\u2019m 14 weeks pregnant, what should my calorie target be?");
  chk(!givesWeightLossTarget(r) && refersToCare(r) && (await situation(Q)) === "pregnant",
    "\"I\u2019m pregnant\" (smart apostrophe) routes, records and refers exactly like \"I'm\"", `life_situation=${await situation(Q)} reply=${JSON.stringify(r)}`);
  const E = await client("Lindi Smartquote");
  const r2 = await say(E, "I\u2019ve been making myself throw up after dinner so the calories don\u2019t count");
  chk(givesEdHelpline(r2) && (await situation(E)) === "disordered_eating", "the purging disclosure with smart quotes routes too", `reply=${JSON.stringify(r2)}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. DISORDERED EATING — AUDIT.md Trace 6 and the behaviours around it");
// ══════════════════════════════════════════════════════════════════════════════════════════════
const ED_CASES: Array<[string, RegExp | null]> = [
  ["I've been making myself throw up after dinner so the calories don't count", null],
  ["I took laxatives after eating so I don't gain", null],
  ["Should I skip my insulin on rest days to cut calories?", /\binsulin\b[\s\S]*\b(doctor|clinic)\b/i],
  ["I made myself sick after lunch again", null],
];
for (const [text, extra] of ED_CASES) {
  const E = await client("Lindi ED");
  const r = await say(E, text);
  if (text.startsWith("I've been making")) REAL(`        final body: ${JSON.stringify(r)}`);
  chk(givesEdHelpline(r) && !asksWhatItWas(r) && !givesWeightLossTarget(r),
    `"${text}" gets the careful referral, not a food question`, `reply=${JSON.stringify(r)}`);
  if (extra) chk(extra.test(r), `"${text}" is told not to skip insulin and to see a doctor`, `reply=${JSON.stringify(r)}`);
  chk((await escalationReasons(E)).includes("eating_disorder"), `"${text}" flags a person`, JSON.stringify(await escalationReasons(E)));
  chk((await situation(E)) === "disordered_eating", `"${text}" is recorded durably`, `life_situation=${await situation(E)}`);
}
{
  const E = await client("Lindi Followup");
  await say(E, "I've been making myself throw up after dinner so the calories don't count");
  const r = await say(E, "I had pap and chicken for lunch");
  const meals = (await pool.query("SELECT kcal_int FROM meal_logs WHERE user_id = $1", [E.id])).rows;
  chk(meals.length === 1, "her food still logs — nothing she says is thrown away", JSON.stringify(meals));
  chk(!givesWeightLossTarget(r) && !/\b\d{2,5}\s*kcal\b/i.test(r), "but no calorie number is put in front of her", `reply=${JSON.stringify(r)}`);
}

{
  // Codex review @ 8e4f231: a disclosure that also says "quit" went to quit-save, a weight-focused
  // reply, and nothing was recorded. The safety context must win.
  for (const [text, kind] of [["I'm pregnant and I want to quit", "pregnant"], ["I've been purging and I'm ready to give up", "disordered_eating"]] as const) {
    const Q = await client("Quit Mixed");
    const r = await say(Q, text);
    chk((await situation(Q)) === kind && (kind === "pregnant" ? refersToCare(r) : givesEdHelpline(r)),
      `"${text}" is routed to safety, not to the quit save`, `life_situation=${await situation(Q)} reply=${JSON.stringify(r)}`);
  }
  // Codex review @ 8e4f231: an unrelated open escalation must not swallow the urgent one.
  const O = await client("Open Case");
  await pool.query("INSERT INTO escalations (user_id, reason, trigger_message, priority, status, sla_deadline) VALUES ($1, 'human_requested', 'can I speak to a real person', 'normal', 'open', now() + interval '12 hours')", [O.id]);
  await say(O, "I've been making myself throw up after dinner so the calories don't count");
  chk((await escalationReasons(O)).includes("eating_disorder"), "a disordered-eating disclosure is escalated even while another case is open",
    JSON.stringify(await escalationReasons(O)));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. ONBOARDING — \"are you currently pregnant…?\" must have a pregnant answer");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const O = await client("Onboarding Pregnant", { onboardingState: "ASK_POSTPARTUM", goalType: null, calorieTarget: null });
  const r = await say(O, "Yes, I'm pregnant");
  chk((await situation(O)) === "pregnant", "\"Yes, I'm pregnant\" is recorded as pregnant, not postpartum", `life_situation=${await situation(O)}`);
  chk(!givesWeightLossTarget(r), "and she is not promised weight loss", `reply=${JSON.stringify(r)}`);
  const O2 = await client("Onboarding Menu", { onboardingState: "ASK_POSTPARTUM", goalType: null, calorieTarget: null });
  await say(O2, "1");
  chk((await situation(O2)) === "pregnant", "the menu's pregnant option records pregnant", `life_situation=${await situation(O2)}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. CONTROLS — ordinary talk is not diverted");
// ══════════════════════════════════════════════════════════════════════════════════════════════
for (const text of ["My sister is pregnant, can she do squats?", "My sister is currently pregnant, can she do squats?", "I'm not pregnant, just bloated today",
  "I threw up after leg day, that session was brutal", "I'll burn it off at gym tomorrow", "I'm expecting to lose 2kg this month",
  "I'm taking laxatives for constipation, what should I eat?"]) {
  const K = await client("Control Talk");
  const r = await say(K, text);
  chk((await situation(K)) === "office" && !givesEdHelpline(r), `"${text}" is ordinary coaching`, `life_situation=${await situation(K)} reply=${JSON.stringify(r)}`);
}

// SOMEBODY ELSE'S DISORDER IS NOT THE CLIENT'S (Codex @ 9331eda). This PR is what makes the read
// durable and escalated, so a third-party mention written as the client's is a regression.
for (const text of ["My sister has bulimia. How can I help her?", "My daughter was diagnosed with an eating disorder, what should I do?",
  "My girlfriend is purging after meals.", "I think my sister is bulimic"]) {
  const K = await client("Third Party");
  await say(K, text);
  chk((await situation(K)) === "office", `"${text}" is not stored as the client's condition`, `life_situation=${await situation(K)}`);
  chk(!(await escalationReasons(K)).includes("eating_disorder"), `…and flags nobody about the client`, JSON.stringify(await escalationReasons(K)));
}
{
  const K = await client("Own Disclosure");
  await say(K, "I've been purging after dinner and my sister doesn't know");
  chk((await situation(K)) === "disordered_eating", "CONTROL — the client's own disclosure beside a sister is still theirs", `life_situation=${await situation(K)}`);
}

await pool.end().catch(() => {});
REAL(`\npg-safety-routing-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}`);
process.exit(failed === 0 ? 0 : 1);

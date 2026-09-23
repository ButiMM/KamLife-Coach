/**
 * REAL-POSTGRESQL ACCEPTANCE — the nags and invented facts testers saw every day (#275).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS BROKEN ON b1112c0 (main), MEASURED THROUGH THIS FILE BEFORE ANY EDIT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *  1. A CLIENT WHO IS TALKING TO US WAS TOLD TO LOG. Under four logged days in seven the evidence
 *     gate downgraded every move to "Tell me what you ate today — one line is enough." — at the
 *     keyboard, and in the evening brief to a client who had messaged an hour earlier.
 *  2. AN ABSENCE NOBODY MEASURED. `daysSinceAnyLog: null` (no meal row, ever) became the client's
 *     tenure, so rung 1 could say "It's been about 10 weeks" to someone who never logged at all.
 *  3. THE WEIGH-IN ASK EVERY DAY. "Stand on a scale this morning" fired on never-weighed or ten
 *     days stale — both stay true until they weigh — and nothing recorded that it had been sent.
 *  4. "Just finished dinner, pap and wors" matched `finished` in the shop-was-out pattern and got
 *     "No stress — *lean mince…* instead." Dinner was never logged.
 *  5. A BETA TESTER (status "trial", bypass a year out) was shown "_Free trial: 365 days
 *     remaining_" on a greeting, and the price answer quoted "A personal trainer charges R250+".
 *
 * Graded on meal_logs, sent_proactive, the canonical decision, and shadow_replies (the final
 * WhatsApp body, post-transport). Real clock: presence is read from chat_history rows the
 * database stamps with its own now().
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-visible-nags-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "0";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "on";
process.env.PROACTIVE_PAUSED = "true";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

// The mouth claims nothing graded here: no log ask, no scale, no trial, no substitution.
const COACH_ANSWER = "Okay, noted on that.";
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
      id: "chatcmpl-275", object: "chat.completion", created: 1, model: "gpt-4o-mini",
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
const { chooseAction, dayStateFrom } = await import("../server/one-action");
const { canonicalNextMove, recordCanonicalMoveOutbound } = await import("../server/scheduler/proactive-decision");
const { handleConversionObjection } = await import("../server/handlers/conversion");
const { NO_CONSTRAINTS } = await import("../server/food-swaps");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};
const asksToLog = (b: string) => /tell me what you ate today/i.test(b);
/** answerUnavailable's own opening: "No stress — *lean mince…* instead." */
const SUBSTITUTION = /No stress — \*/;
const DAY = 86_400_000;

async function client(n: number, over: Record<string, unknown> = {}) {
  const phone = `whatsapp:+2782000275${n}`;
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: `Lindiwe${n} Nag`, onboardingState: "COMPLETE", popiConsent: true,
    popiConsentAt: new Date(), subscriptionStatus: "active", goalType: "fat_loss",
    currentWeight: "84", startWeight: "88", targetWeight: "74", heightCm: 166, age: 33,
    gender: "female", trainingMode: "home", proteinTarget: 125, calorieTarget: 1800, dailyCalorieTarget: 1800,
    programmeWeek: 4, trainingDaysPerWeek: 3, stepsTarget: 0,
    ...over,
  } as any).returning();
  return u as any;
}
/** Sparse but present: one meal two days ago, weighed yesterday — nothing today. */
async function sparse(u: any) {
  await pool.query(`INSERT INTO meal_logs (user_id, raw_message, source, kcal_int, protein_int, meal_label, logged_at)
    VALUES ($1,'seeded lunch','text',600,40,'lunch',$2)`, [u.id, new Date(Date.now() - 2 * DAY)]);
  await pool.query("INSERT INTO weight_logs (user_id, weight, logged_at) VALUES ($1,'84',$2)", [u.id, new Date(Date.now() - DAY)]);
}
const lastShadowId = async () => Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM shadow_replies")).rows[0].m);
async function say(u: any, text: string, sid: string): Promise<string> {
  _resetOutboundDedupe();
  _resetInteractionCorrelation();
  const s0 = await lastShadowId();
  await processTextAsync(u.phoneNumber, text, null, null, [], handleMessage as any, sid);
  await new Promise(r => setTimeout(r, 1500));
  return (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2 ORDER BY id", [u.phoneNumber, s0]))
    .rows.map(r => r.body).join("\n");
}
const fresh = async (phone: string) => (await db.select().from(schema.users).where((await import("drizzle-orm")).eq(schema.users.phoneNumber, phone)))[0];

REAL("\npg-visible-nags-acceptance — the nags and invented facts testers saw every day (#275)\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("0. THE FIXTURE CANNOT PASS THE GRADERS ON ITS OWN");
// ══════════════════════════════════════════════════════════════════════════════════════════════
chk(!asksToLog(COACH_ANSWER) && !SUBSTITUTION.test(COACH_ANSWER) && !/scale|trial|R250/i.test(COACH_ANSWER), "the stubbed mouth says none of the graded words");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n1. A CLIENT WHO IS TALKING TO US IS NOT TOLD TO LOG");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const u = await client(1);
  await sparse(u);
  const asked = await say(u, "what should I do today?", "SM275a1");
  chk(!!asked, "the question got a reply", JSON.stringify(asked));
  chk(!asksToLog(asked), "\"what should I do today?\" is not answered with \"tell me what you ate\"", JSON.stringify(asked));
  // THE COMMONER TURN: a report, not a question. On main the reply to this carried the log ask.
  const reporter = await client(9);
  await sparse(reporter);
  const steps = await say(reporter, "I walked 8000 steps today", "SM275a2");
  chk(/8\s?000/.test(steps), "the step report is acknowledged", JSON.stringify(steps));
  chk(!asksToLog(steps), "…and not answered with \"tell me what you ate today\"", JSON.stringify(steps));

  // THE PROACTIVE SIDE: the evening brief to someone who already wrote to us today.
  const present = await client(2);
  await sparse(present);
  await pool.query("INSERT INTO chat_history (user_id, message_in, message_out, intent) VALUES ($1,'morning coach','hi','GREETING')", [present.id]);
  const toPresent = await canonicalNextMove(await fresh(present.phoneNumber), { hour: 19 });
  chk(toPresent.action.kind !== "log" && !asksToLog(toPresent.line),
    "the evening move to a client who messaged today is not a log ask", `${toPresent.action.kind} ${JSON.stringify(toPresent.line)}`);

  // …AND NOT "LOG ONE MEAL TODAY" EITHER. Four quiet days is the come-back rung, whose ask is a
  // meal log — to someone who messaged us this morning.
  const back = await client(8);
  await pool.query(`INSERT INTO meal_logs (user_id, raw_message, source, kcal_int, protein_int, meal_label, logged_at)
    VALUES ($1,'seeded lunch','text',600,40,'lunch',$2)`, [back.id, new Date(Date.now() - 4 * DAY)]);
  await pool.query("INSERT INTO weight_logs (user_id, weight, logged_at) VALUES ($1,'84',$2)", [back.id, new Date(Date.now() - DAY)]);
  await pool.query("INSERT INTO chat_history (user_id, message_in, message_out, intent) VALUES ($1,'hey coach','hi','GREETING')", [back.id]);
  const toBack = await canonicalNextMove(await fresh(back.phoneNumber), { hour: 19 });
  chk(toBack.action.kind !== "come_back" && toBack.action.kind !== "log",
    "four quiet food days, but they wrote today: no come-back meal ask", `${toBack.action.kind} ${JSON.stringify(toBack.line)}`);

  // A PHOTO IS THE CLIENT WRITING (Codex @ 30703f5): media rows are logged as "[Scale Photo]".
  const photo = await client(10);
  await sparse(photo);
  await pool.query("INSERT INTO chat_history (user_id, message_in, message_out, intent) VALUES ($1,'[Scale Photo]','84kg noted','WEIGHT_PHOTO')", [photo.id]);
  const toPhoto = await canonicalNextMove(await fresh(photo.phoneNumber), { hour: 19 });
  chk(toPhoto.action.kind !== "log", "a client who sent a photo today is present too", toPhoto.action.kind);

  const absent = await client(3);
  await sparse(absent);
  // Our own proactive row (message_in NULL) and a system row are not the client speaking.
  await pool.query("INSERT INTO chat_history (user_id, message_in, message_out, intent) VALUES ($1,NULL,'morning brief','MORNING'),($1,'[system]','x','DAMAGE_CONTROL')", [absent.id]);
  const toAbsent = await canonicalNextMove(await fresh(absent.phoneNumber), { hour: 19 });
  chk(toAbsent.action.kind === "log",
    "CONTROL — a sparse client who has NOT written today is still asked what they ate", toAbsent.action.kind);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. NO MEAL ROW IS AN UNKNOWN GAP, NOT THEIR TENURE");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const state = {
    name: "Lindiwe", goalType: "fat_loss", health: { sick: false },
    food: { loggedDays7d: 0, daysSinceAnyLog: null }, workout: { sessionsLast7d: 0 }, steps: { avg7d: null },
    weight: { daysSinceWeighIn: 1, trendUsable: false }, today: { kcal: 0, protein: 0, steps: 0, logged: false, hour: 19 },
    evidence: { foodSufficient: false, weightSufficient: false },
  };
  const profile = { constraints: NO_CONSTRAINTS, weeksOnProgramme: 10, sessionsTarget: 3, calorieTarget: 1800, proteinTarget: 125, stepsTarget: 0 };
  const day = dayStateFrom(state as any, profile as any, { hour: 19 });
  chk(day.daysSinceAnyLog === null, "the projection keeps the gap unknown", String(day.daysSinceAnyLog));
  const act = chooseAction(day);
  chk(act.kind !== "come_back" && !/\bweeks?\b|month/i.test(`${act.todo} ${act.why}`),
    "a ten-week client who never logged is not told how long they have been gone", `${act.kind}: ${act.todo} | ${act.why}`);
  const measured = chooseAction(dayStateFrom({ ...state, food: { loggedDays7d: 0, daysSinceAnyLog: 21 } } as any, profile as any, { hour: 19 }));
  chk(measured.kind === "come_back", "CONTROL — a measured three-week gap still reaches the come-back rung", measured.kind);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. THE WEIGH-IN ASK IS RECORDED WHEN SENT AND CANNOT REPEAT DAILY");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const u = await client(4);
  // Never weighed, four weeks in, logged today — the weigh rung is the first that fires at 07:00.
  await pool.query(`INSERT INTO meal_logs (user_id, raw_message, source, kcal_int, protein_int, meal_label, logged_at)
    VALUES ($1,'seeded breakfast','text',400,30,'breakfast',now())`, [u.id]);
  const asks = async () => Number((await pool.query("SELECT COUNT(*)::int c FROM sent_proactive WHERE user_id = $1 AND message_key = 'weigh_ask'", [u.id])).rows[0].c);
  const first = await canonicalNextMove(await fresh(u.phoneNumber), { hour: 7 });
  chk(first.action.kind === "weigh", "day one: a never-weighed client is asked to weigh", first.action.kind);
  await recordCanonicalMoveOutbound(u, first, "failed" as any);
  chk(await asks() === 0, "an ask that was not delivered is not recorded");
  await recordCanonicalMoveOutbound(u, first, "sent");
  chk(await asks() === 1, "the delivered ask is recorded in sent_proactive", String(await asks()));

  const next = await canonicalNextMove(await fresh(u.phoneNumber), { hour: 7 });
  chk(next.action.kind !== "weigh" && !/scale/i.test(next.line), "the next morning they are not asked again", `${next.action.kind} ${JSON.stringify(next.line)}`);
  await pool.query("UPDATE sent_proactive SET sent_at = now() - interval '6 days' WHERE user_id = $1 AND message_key = 'weigh_ask'", [u.id]);
  const sixDays = await canonicalNextMove(await fresh(u.phoneNumber), { hour: 7 });
  chk(sixDays.action.kind !== "weigh", "nor six days later", sixDays.action.kind);
  await pool.query("UPDATE sent_proactive SET sent_at = now() - interval '7 days' WHERE user_id = $1 AND message_key = 'weigh_ask'", [u.id]);
  const week = await canonicalNextMove(await fresh(u.phoneNumber), { hour: 7 });
  chk(week.action.kind === "weigh", "a week on, the ask may go out once more", week.action.kind);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. \"JUST FINISHED DINNER\" LOGS DINNER");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const u = await client(5);
  const reply = await say(u, "Just finished dinner, pap and wors", "SM275d1");
  const rows = (await pool.query<{ raw_message: string; meal_label: string }>("SELECT raw_message, meal_label FROM meal_logs WHERE user_id = $1", [u.id])).rows;
  chk(rows.length > 0, "a meal row is written", JSON.stringify(reply));
  chk(rows.some(r => /dinner/i.test(r.meal_label || "")), "and it is dinner", JSON.stringify(rows));
  chk(!SUBSTITUTION.test(reply), "the reply is not a shop substitution", JSON.stringify(reply));

  const shop = await client(6);
  const sub = await say(shop, "The chicken was finished at Shoprite, what else?", "SM275d2");
  chk(SUBSTITUTION.test(sub), "CONTROL — \"the chicken was finished\" still gets the substitution", JSON.stringify(sub));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. NO TRIAL, AND NO PRICE WE CANNOT STAND BEHIND");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const tester = await client(7, { subscriptionStatus: "trial", betaBypassUntil: new Date(Date.now() + 365 * DAY) });
  await pool.query("UPDATE users SET last_active_at = now() - interval '2 days' WHERE id = $1", [tester.id]);
  const hi = await say(tester, "hi", "SM275t1");
  chk(!!hi, "the beta tester's greeting is answered", JSON.stringify(hi));
  chk(!/free trial|days? remaining|days? left on/i.test(hi), "the greeting counts down no free trial", JSON.stringify(hi));
  // THE ONE-TRIAL RECORD GOES WITH THE TRIAL (Codex @ 30703f5): no rule reads it, so it is not kept.
  const kept = (await pool.query("SELECT to_regclass('public.trialed_numbers') AS t")).rows[0].t;
  chk(kept === null, "no table of trialed phone hashes outlives the trial rule", String(kept));
  const price = handleConversionObjection({ user: {}, m: "how much is it", payLink: "https://pay.test/x", name: "Kam" } as any)?.reply || "";
  chk(!!price && !/R250/.test(price), "the price answer quotes no personal-trainer price", JSON.stringify(price));
}

REAL(`\npg-visible-nags-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

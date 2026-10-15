/**
 * REAL-POSTGRESQL ACCEPTANCE — the empty-day evening message, inside and outside the window.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS MEASURED ON c50ee12 (main), THROUGH THE REAL SCHEDULER JOB, BEFORE ANY EDIT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A client logs nothing all day. At 20:00 `runEveningAccountability()` sends them the one thing
 * that matters — "haven't heard from you today — no stress" plus today's canonical move. Because
 * they logged nothing, they almost certainly also said nothing, so the 24-hour customer-care
 * window is shut and WhatsApp rejects the freeform with 63016. The message written FOR a silent
 * client is the one that cannot reach a silent client.
 *
 * What happened next, on the base:
 *
 *   FREEFORM  "Lerato, haven't heard from you today … *Log one meal today. Any meal.*"  → 63016
 *   TEMPLATE  kamlife_checking_in                                                       → accepted
 *   THE CLIENT READ  "It is Coach K checking in. You have been quiet for a bit…"
 *
 * Cut 6 built the escape: a caller may name the approved template that carries THIS message, and
 * `sendWhatsApp` sends that instead, so the content degrades rather than disappears. Morning,
 * weekly and payment were wired to it. `evening.ts` was not — it passes no `windowTemplate`, so
 * this path can only ever land on the generic check-in.
 *
 * AND NO APPROVED TEMPLATE CONTENT-MATCHES THIS MESSAGE. The only one carrying a name plus
 * today's action is `kamlife_daily_plan`, whose approved body opens "Morning {{1}} — your KamLife
 * plan for today is ready." Sending that at 20:00 is wrong in the client's hand, and a new Meta
 * template is a human step ruled out of this cut. So this path is the honest `otherwise`: the
 * substitution is allowed to happen, and it must be RECORDED as a substitution.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS GRADED, AND WHERE IT IS READ FROM
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Nothing here reads a handler's return value. Two sources only:
 *
 *   what Twilio was handed  — the post-transport truth, captured at the client stub, scoped to
 *                             this client's number (these jobs iterate EVERY user in the database)
 *   chat_history            — the durable record of what the coach believes it said, which is
 *                             what conversationHistory feeds back to the model days later
 *
 * §1 IS THE CONTROL AND IT RUNS FIRST. A cut that silenced the evening job, or that stopped
 * sending the check-in, would satisfy every "not" below and would delete the feature. A client
 * inside the window must still receive their actual coaching.
 *
 * THE HISTORY WRITE IS `void`-ED best-effort inside the transport, so every read of chat_history
 * here is preceded by a settle. Reading it immediately returns an empty table and looks exactly
 * like "the coach recorded nothing" — a false defect this file hit once already.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-evening-delivery-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.PROACTIVE_PAUSED = "";   // this job is the subject; the killswitch would skip it
process.env.SHADOW = "";             // the shadow door intercepts BEFORE the 63016 path we grade
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
// A template SID must be HX + 32 hex characters or templateSid() fails closed and NO template is
// sent — which reads identically to "the window recovery is broken".
const SID = { daily: "HX0000000000000000000000000000000a", reengage: "HX0000000000000000000000000000000d", checkin: "HX0000000000000000000000000000000c" };
process.env.TWILIO_DAILY_TEMPLATE_SID = SID.daily;
process.env.TWILIO_REENGAGE_TEMPLATE_SID = SID.reengage;
process.env.TWILIO_CHECKIN_TEMPLATE_SID = SID.checkin;
process.env.NODE_ENV = "production";

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { _setTwilioClientForTests } = await import("../server/outbound-delivery");
const { sendWhatsApp, dailyProactiveCount } = await import("../server/scheduler/shared");
const { runEveningAccountability } = await import("../server/scheduler/jobs/evening");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");
const { buildClientSnapshot } = await import("../server/brain/client-snapshot");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

const phone = "whatsapp:+27820000992";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Lerato Quiet", onboardingState: "COMPLETE", popiConsent: true,
  popiConsentAt: new Date(), subscriptionStatus: "active", goalType: "fat_loss",
  proteinTarget: 130, calorieTarget: 1900, stepsTarget: 8000, trainingDaysPerWeek: 3,
  lastActiveAt: new Date(), programmeWeek: 3,
} as any).returning();

// ── THE INSTRUMENTS ────────────────────────────────────────────────────────────────────────────
/** The generic re-engagement template, as the client reads it. */
const isCheckIn = (b: string) => /coach k checking in|quiet for a bit|not writing you off/i.test(String(b || ""));
/** The evening empty-day message, as the client reads it. Its opener plus a canonical move. */
const isEveningCoaching = (b: string) => /haven'?t heard from you today/i.test(String(b || ""));

let payloads: Array<Record<string, any>> = [];
/** windowShut=true makes every freeform rejected with 63016, exactly as a closed window does. */
function stubTwilio(windowShut: boolean, failingTemplate?: string) {
  payloads = [];
  _setTwilioClientForTests({
    messages: {
      create: async (p: Record<string, any>) => {
        payloads.push(p);
        if (failingTemplate && p.contentSid === failingTemplate) throw Object.assign(new Error("simulated template rejection"), { code: 63027, status: 400 });
        if (windowShut && typeof p.body === "string") {
          const err: any = new Error("simulated 63016"); err.code = 63016; err.status = 400; throw err;
        }
        return { sid: "SM1" };
      },
    },
  } as any);
}
const mine = () => payloads.filter(p => p.to === phone);
const freeformSent = () => mine().filter(p => typeof p.body === "string").map(p => String(p.body));
const templatesSent = () => mine().filter(p => p.contentSid).map(p => String(p.contentSid));

/** chat_history, after letting the transport's void-ed best-effort write land. */
async function history(): Promise<Array<{ intent: string; body: string }>> {
  await new Promise(r => setTimeout(r, 2000));
  const { rows } = await pool.query(
    "SELECT intent, message_out FROM chat_history WHERE user_id = $1 ORDER BY id", [user.id]);
  return rows.map((r: any) => ({ intent: String(r.intent), body: String(r.message_out) }));
}

async function reset() {
  for (const t of ["sent_proactive", "chat_history", "meal_logs", "step_logs", "workout_logs", "client_actions"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [user.id]).catch(() => {});
  }
  // THE DAILY BUDGET IS HELD IN MEMORY AS WELL AS IN sent_proactive, and clearing only the table
  // leaves the cap consumed — the next section then sends NOTHING and reads as "the evening job
  // stopped working". The counter is exported for exactly this.
  dailyProactiveCount.clear();
  // AND THE OUTBOUND DEDUPE. Every section sends the SAME evening body to the SAME number, so
  // without this the second send is suppressed as a duplicate and reads as "the job sent
  // nothing" — the identical false green C17 was one run away from shipping.
  _resetOutboundDedupe();
}

REAL("\npg-evening-delivery-acceptance — the empty day reaches the client, or says it did not\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("0. THE INSTRUMENTS — validated against labelled strings before anything is graded");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  chk(isCheckIn("It is Coach K checking in. You have been quiet for a bit and I am not writing you off."),
    "the check-in detector fires on the approved generic body");
  chk(!isCheckIn("Lerato, haven't heard from you today — no stress.\n\n*Log one meal today.*"),
    "…and does NOT fire on the evening coaching");
  chk(isEveningCoaching("Lerato, haven't heard from you today — no stress.\n\n*Log one meal today.*"),
    "the coaching detector fires on the evening empty-day body");
  chk(!isEveningCoaching("It is Coach K checking in. You have been quiet for a bit."),
    "…and does NOT fire on the generic check-in");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n1. CONTROL FIRST — INSIDE the window, the silent client gets their actual coaching");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Every assertion after this one is a NOT. Silencing the evening job would satisfy them all and
// would delete the feature: this message exists because a client who logged nothing all day is
// exactly the client who needs one instruction before bed.
{
  await reset();
  stubTwilio(false);
  await runEveningAccountability();
  const bodies = freeformSent();
  chk(bodies.length === 1, "the evening message is sent as freeform", JSON.stringify(bodies.length));
  chk(!!bodies[0] && isEveningCoaching(bodies[0]), "…and it is the empty-day coaching",
    JSON.stringify(bodies[0]?.slice(0, 90) || ""));
  chk(templatesSent().length === 0, "no template is involved inside the window",
    JSON.stringify(templatesSent()));
  const h = await history();
  chk(h.length === 1 && h[0].intent === "PROACTIVE",
    "the record files it as an ordinary proactive send", JSON.stringify(h.map(r => r.intent)));
  chk(!!h[0] && isEveningCoaching(h[0].body),
    "…and stores the coaching the client actually read", JSON.stringify(h[0]?.body.slice(0, 80) || ""));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. THE DEFECT — OUTSIDE the window, the coaching does not reach them");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// This is the measured behaviour and it is NOT repaired here: no approved template content-matches
// this message, and minting one is a human step. What is graded is that the product stops
// pretending otherwise.
{
  await reset();
  stubTwilio(true);
  await runEveningAccountability();
  const bodies = freeformSent();
  chk(bodies.length === 1 && isEveningCoaching(bodies[0]),
    "the coaching is attempted as freeform first", JSON.stringify(bodies.length));
  chk(!templatesSent().includes(SID.reengage),
    "…is rejected by the closed window, and the generic check-in is NOT sent in its place (#327)",
    JSON.stringify(templatesSent()));
  chk(!templatesSent().includes(SID.daily),
    "the MORNING template is not pressed into evening service — it opens \"Morning {{1}}\"",
    JSON.stringify(templatesSent()));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. NOTHING IS RECORDED AS SENT, AND THE CALLER IS TOLD SO (#327)");
// ═══════════════════════════════════════════════════════════════════════════
// The generic "Coach K checking in" is a different message from the coaching, so it never goes in
// its place. With no template of its own and no SMS number, the coaching did not land: the
// outcome is `dropped`, and no row claims a delivery.
{
  const h = await history();
  chk(h.length === 0, "no row claims the coaching, or a substitute, reached them", JSON.stringify(h.map(r => r.intent)));
  await reset();
  stubTwilio(true);
  const outcome = await sendWhatsApp(phone, "Lerato, haven't heard from you today — no stress.\n\n*Log one meal.*");
  chk(outcome === "dropped" && !templatesSent().includes(SID.reengage),
    "a send outside the window with no template of its own reports `dropped`, and no generic template goes", `${outcome} | ${JSON.stringify(templatesSent())}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. A MESSAGE THAT HAS ITS OWN TEMPLATE IS UNAFFECTED — Cut 6 still works");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The discriminator must mark the GENERIC substitute only. A caller whose own approved template
// carried the real content did reach the client, and downgrading that row would be a new lie in
// the opposite direction.
{
  await reset();
  stubTwilio(true);
  const outcome = await sendWhatsApp(phone, "Morning Lerato — your plan is ready.\n\nToday's one thing: Log one meal.",
    undefined, { name: "kamlife_daily_plan", variables: { "1": "Lerato", "2": "Log one meal" } });
  chk(templatesSent().includes(SID.daily), "the message's OWN template is sent",
    JSON.stringify(templatesSent()));
  chk(outcome === "fallback", "…and the caller is told the real content reached them", String(outcome));
  const h = await history();
  chk(h.length === 1 && h[0].intent === "PROACTIVE",
    "it is recorded as a delivery, NOT a substitution", JSON.stringify(h.map(r => r.intent)));
  chk(!!h[0] && /your KamLife plan for today is ready/.test(h[0].body),
    "…and the stored body is the template the client READ, not the text it stood in for", JSON.stringify(h[0]?.body.slice(0, 80) || ""));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. NOTHING DOWNSTREAM TREATS A SUBSTITUTION AS COACHING DELIVERED");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The existing guarantee, locked so this cut cannot regress it: a training move that was never
// read must not open a loop the client is later answered about.
{
  await reset();
  stubTwilio(true);
  await runEveningAccountability();
  const { rows: loops } = await pool.query(
    "SELECT status FROM client_actions WHERE user_id = $1", [user.id]).catch(() => ({ rows: [] } as any));
  chk(loops.length === 0, "an evening that did not land opens no open loop", JSON.stringify(loops));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n6. THE SNAPSHOT STILL NAMES THE MESSAGE THEY ACTUALLY READ");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The reader that asks "what was the last automated coach message?" must name what the client
// actually read. Today's evening did not reach them and nothing went in its place (#327), so the
// newest message they read is still yesterday's plan, and no check-in they never saw is named.
{
  await reset();
  // An ordinary proactive lands yesterday, inside the snapshot's two-day window…
  await pool.query(
    `INSERT INTO chat_history (user_id, message_in, message_out, intent, created_at)
     VALUES ($1, NULL, 'Morning Lerato — your plan for today is ready.', 'PROACTIVE', now() - interval '20 hours')`,
    [user.id]);
  // …and today's evening send is rejected by the closed window.
  stubTwilio(true);
  await sendWhatsApp(phone, "Lerato, haven't heard from you today — no stress.\n\n*Log one meal.*");
  await new Promise(r => setTimeout(r, 2000));

  const snapshot = await buildClientSnapshot({ ...user, id: user.id });
  const line = snapshot.split("\n").find(l => l.includes("Last automated coach message")) || "";
  chk(!!line, "the snapshot carries a last-automated-message line at all", JSON.stringify(snapshot.slice(0, 120)));
  chk(/your plan for today is ready/i.test(line) && !isCheckIn(line),
    "…and it is the plan the client READ, never a check-in that did not go (#327)", JSON.stringify(line.slice(0, 140)));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n7. A KEPT PROMISE IS THE WHOLE EVENING MESSAGE (Grok attack on #545)");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// They promised a walk today and the workout ledger shows it, but they logged no food. The evening
// says they did it, once, and never "haven't heard from you today".
{
  await reset();
  stubTwilio(false);
  const today = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
  await pool.query("DELETE FROM client_facts WHERE user_id = $1", [user.id]);
  await pool.query("INSERT INTO client_facts (user_id, kind, subject, statement, detail, extracted_by) VALUES ($1, 'commitment', 'commitment', 'I will walk after work', $2, 'test')",
    [user.id, JSON.stringify({ domain: "movement", what: "a walk after work", due: today, state: "open" })]);
  await pool.query("INSERT INTO workout_logs (user_id, workout_completed, logged_at) VALUES ($1, true, now())", [user.id]);
  await runEveningAccountability();
  const bodies = freeformSent();
  chk(bodies.length === 1 && /you did it/i.test(bodies[0]) && !isEveningCoaching(bodies[0]),
    "one message: the success line, not \"haven't heard from you today\"", JSON.stringify(bodies));
  await pool.query("DELETE FROM client_facts WHERE user_id = $1", [user.id]);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n8. A SAFETY ROUTE OUTRANKS THE SCHEDULE (#571)");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// They wrote something that took the crisis route this afternoon. Tonight's scheduled message does
// not go; once a proactive message has gone after it (or seven days pass), the schedule resumes.
{
  await reset();
  stubTwilio(false);
  await pool.query("INSERT INTO chat_history (user_id, message_in, message_out, intent) VALUES ($1, 'test crisis', 'test reply', 'CRISIS')", [user.id]);
  await runEveningAccountability();
  chk(freeformSent().length === 0 && templatesSent().length === 0, "after a crisis turn, the evening job sends nothing", JSON.stringify(freeformSent()));
  // #319: the fortnightly step-target job is held too, and the target does not move without its message.
  await pool.query("UPDATE users SET steps_target = 8000, baseline_steps_target = 8000 WHERE id = $1", [user.id]);
  for (let d = 1; d <= 7; d++) await pool.query("INSERT INTO step_logs (user_id, steps, logged_at) VALUES ($1, 11000, now() - ($2 || ' days')::interval)", [user.id, String(d)]);
  const { runStepTargetAdaptation } = await import("../server/scheduler/jobs/business");
  await runStepTargetAdaptation();
  const target = (await pool.query("SELECT steps_target t FROM users WHERE id = $1", [user.id])).rows[0]?.t;
  chk(freeformSent().length === 0 && target === 8000, "after a crisis turn, no new step target is sent or set (#319)", `${target} | ${JSON.stringify(freeformSent())}`);
  await pool.query("DELETE FROM step_logs WHERE user_id = $1", [user.id]);
  await reset();
  stubTwilio(false);
  await pool.query("UPDATE chat_history SET created_at = now() - interval '8 days' WHERE user_id = $1 AND intent = 'CRISIS'", [user.id]);
  await runEveningAccountability();
  chk(freeformSent().length === 1, "eight days later, the evening message goes again", JSON.stringify(freeformSent().length));
  // #671 review: the held run did not spend the fortnight's window, so once the hold has passed the new target goes.
  // A new day's one message (the evening above used today's); the step job's own window claim is left as it is.
  await pool.query("DELETE FROM sent_proactive WHERE user_id = $1 AND message_key LIKE 'DAILY_CAP_%'", [user.id]);
  dailyProactiveCount.clear(); _resetOutboundDedupe();
  for (let d = 1; d <= 7; d++) await pool.query("INSERT INTO step_logs (user_id, steps, logged_at) VALUES ($1, 11000, now() - ($2 || ' days')::interval)", [user.id, String(d)]);
  await (await import("../server/scheduler/jobs/business")).runStepTargetAdaptation();
  const raised = (await pool.query("SELECT steps_target t FROM users WHERE id = $1", [user.id])).rows[0]?.t;
  chk(raised === 9000 && freeformSent().some(b => /New target: \*9,000 steps\/day/.test(b)), "after the hold, the step target goes up with its message (#671 review)", `${raised} | ${JSON.stringify(freeformSent())}`);
  await pool.query("DELETE FROM step_logs WHERE user_id = $1", [user.id]);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n9. A COMMITMENT CHECK-IN IS THAT MESSAGE OR NOTHING (#563)");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Outside the window, the check-in goes as its own template. If that template is refused, the
// generic "checking in" template does NOT go in its place: one missed ask, not two contacts.
{
  await reset();
  stubTwilio(true, SID.checkin);
  const today = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
  await pool.query("DELETE FROM client_facts WHERE user_id = $1", [user.id]);
  await pool.query("INSERT INTO client_facts (user_id, kind, subject, statement, detail, extracted_by) VALUES ($1, 'commitment', 'commitment', 'I will walk after work', $2, 'test')",
    [user.id, JSON.stringify({ domain: "movement", what: "a walk after work", due: today, state: "open" })]);
  await runEveningAccountability();
  chk(templatesSent().includes(SID.checkin), "the check-in's own template is tried", JSON.stringify(templatesSent()));
  chk(!templatesSent().includes(SID.reengage), "…and when it is refused, the generic check-in is not sent instead", JSON.stringify(templatesSent()));
  await pool.query("DELETE FROM client_facts WHERE user_id = $1", [user.id]);
}

// ═════════════════════════════════════════════════════════════════════════════════════
REAL("\n10. A PROMISE MADE BEFORE A PREGNANCY OR EATING-DISORDER DISCLOSURE IS NOT CHASED (#563)");
// ═════════════════════════════════════════════════════════════════════════════════════
// They promised a walk, then told us they are pregnant: the programme is paused for their doctor, so
// tonight does not ask how the walk went, and the promise is released, not asked again on their next reply.
{
  await reset();
  stubTwilio(false);
  const today = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
  await pool.query("DELETE FROM client_facts WHERE user_id = $1", [user.id]);
  await pool.query("INSERT INTO client_facts (user_id, kind, subject, statement, detail, extracted_by) VALUES ($1, 'commitment', 'commitment', 'I will walk after work', $2, 'test')",
    [user.id, JSON.stringify({ domain: "movement", what: "a walk after work", due: today, state: "open" })]);
  await pool.query("UPDATE users SET life_situation = 'pregnant' WHERE id = $1", [user.id]);
  await runEveningAccountability();
  const live = (await pool.query("SELECT count(*)::int n FROM client_facts WHERE user_id = $1 AND kind = 'commitment' AND (valid_until IS NULL OR valid_until > now())", [user.id])).rows[0].n;
  chk(!freeformSent().some(b => /you planned/i.test(b)) && !templatesSent().includes(SID.checkin) && live === 0,
    "no \"you planned a walk… how did it go?\" after a pregnancy disclosure, and the promise is released", `${JSON.stringify(freeformSent())} | live=${live}`);
  // …and the coach's own reply does not ask either: the promise is gone from what the composer is told.
  await pool.query("INSERT INTO client_facts (user_id, kind, subject, statement, detail, extracted_by) VALUES ($1, 'commitment', 'commitment', 'I will walk after work', $2, 'test')",
    [user.id, JSON.stringify({ domain: "movement", what: "a walk after work", due: today, state: "open" })]);
  const told = await (await import("../server/core/client-record")).factsForCoach(user.id);
  chk(!told.includes("commitment:"), "the reply path is not told to ask about it either", told.slice(0, 200));
  await pool.query("UPDATE users SET life_situation = NULL WHERE id = $1", [user.id]);
  await pool.query("DELETE FROM client_facts WHERE user_id = $1", [user.id]);
}

// ════════════════════════════════════════════════════════════════════════
REAL("\n11. ON A COMMITMENT'S DUE DAY THE MORNING STANDS DOWN, SO THE CHECK-IN GOES OUT (#645)");
// ════════════════════════════════════════════════════════════════════════
// "I'll walk after work on Thursday". On Thursday the morning used the day's one slot and the evening's
// "how did it go?" was capped away: the one thing we promised to follow up never went out.
for (const quietDays of [0, 4]) { // and after a quiet spell since the promise (#652 attack): the silence ladder stands down too
  await reset();
  stubTwilio(false);
  await pool.query("UPDATE users SET last_active_at = now() - make_interval(days => $2) WHERE id = $1", [user.id, quietDays]);
  const today = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
  await pool.query("DELETE FROM client_facts WHERE user_id = $1", [user.id]);
  await pool.query("INSERT INTO client_facts (user_id, kind, subject, statement, detail, extracted_by) VALUES ($1, 'commitment', 'commitment', 'I will walk after work', $2, 'test')",
    [user.id, JSON.stringify({ domain: "movement", what: "a walk after work", due: today, state: "open" })]);
  const { runMorningCheckin } = await import("../server/scheduler/jobs/morning");
  await runMorningCheckin();
  _resetOutboundDedupe();
  await runEveningAccountability();
  const sent = [...freeformSent(), ...templatesSent()];
  chk(sent.length === 1 && (/you planned .*walk after work.*how did it go/i.test(sent[0]) || sent[0] === SID.checkin),
    `Thursday's one message is the check-in: the morning stood down (${quietDays} quiet days before it)`, JSON.stringify(sent));
  await pool.query("DELETE FROM client_facts WHERE user_id = $1", [user.id]);
  await pool.query("UPDATE users SET last_active_at = now() WHERE id = $1", [user.id]);
}

// The morning stands down only when the evening will really send (Codex P1s on 6be9ebd). With no check-in
// template, a window open at 06:00 but shut by 19:00 sends nothing in the evening; a sick client is skipped by
// the evening. Either way the morning must still go, or that day they hear nothing.
for (const why of ["window shuts before the evening", "sick and paused"] as const) {
  await reset();
  stubTwilio(false);
  const today = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
  const savedSid = process.env.TWILIO_CHECKIN_TEMPLATE_SID;
  if (why === "window shuts before the evening") delete process.env.TWILIO_CHECKIN_TEMPLATE_SID;
  await pool.query("DELETE FROM client_events WHERE user_id = $1", [user.id]);
  await pool.query("INSERT INTO client_events (user_id, raw_text, received_at) VALUES ($1, 'ok', now() - interval '20 hours')", [user.id]);
  if (why === "sick and paused") await pool.query("UPDATE users SET profile_notes = $2 WHERE id = $1", [user.id, `sick_since:${today} | sick_until:${today} | paused_until:${today}`]);
  await pool.query("DELETE FROM client_facts WHERE user_id = $1", [user.id]);
  await pool.query("INSERT INTO client_facts (user_id, kind, subject, statement, detail, extracted_by) VALUES ($1, 'commitment', 'commitment', 'I will walk after work', $2, 'test')",
    [user.id, JSON.stringify({ domain: "movement", what: "a walk after work", due: today, state: "open" })]);
  const { runMorningCheckin } = await import("../server/scheduler/jobs/morning");
  await runMorningCheckin();
  const morning = mine().length;
  _resetOutboundDedupe();
  await runEveningAccountability();
  chk(morning >= 1, `${why}: the evening can't send the check-in, so the morning does not stand down`, JSON.stringify(mine()));
  if (savedSid !== undefined) process.env.TWILIO_CHECKIN_TEMPLATE_SID = savedSid;
  await pool.query("DELETE FROM client_facts WHERE user_id = $1", [user.id]);
  await pool.query("DELETE FROM client_events WHERE user_id = $1", [user.id]);
  await pool.query("UPDATE users SET profile_notes = NULL WHERE id = $1", [user.id]);
}

// ════════════════════════════════════════════════════════════════════════
REAL("\n12. DAY 2 OF ONBOARDING IS A QUESTION, NOT A MENU (B9, #647)");
// ════════════════════════════════════════════════════════════════════════
// "How did Day 1 go? Reply DONE if you completed the session" went to everyone, including a client who said on day 1
// that their doctor told them to rest. With no model it is the plain floor, and the floor carries no command words.
{
  await reset();
  stubTwilio(false);
  await pool.query("DELETE FROM escalations WHERE user_id = $1", [user.id]); // §8's safety route holds every proactive send
  await pool.query("UPDATE users SET programme_start_date = now() - interval '2 days 1 hour' WHERE id = $1", [user.id]);
  const { runEarlyOnboarding } = await import("../server/scheduler/jobs/onboarding");
  await runEarlyOnboarding();
  const day2 = freeformSent().join("\n");
  chk(/how did yesterday go/i.test(day2) && !/completed the session|reply done/i.test(day2),
    "day 2 asks how it went in their own words, never \"Reply DONE if you completed the session\" (#647)", JSON.stringify(day2.slice(0, 200)));
  await pool.query("UPDATE users SET programme_start_date = NULL WHERE id = $1", [user.id]);
}

await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
REAL(failed ? `\npg-evening-delivery-acceptance: FAILED — ${failed} assertion(s)\n`
            : "\npg-evening-delivery-acceptance: GREEN\n");
await pool.end();
process.exit(failed ? 1 : 0);

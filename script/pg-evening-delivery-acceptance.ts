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
const SID = { daily: "HX0000000000000000000000000000000a", reengage: "HX0000000000000000000000000000000d" };
process.env.TWILIO_DAILY_TEMPLATE_SID = SID.daily;
process.env.TWILIO_REENGAGE_TEMPLATE_SID = SID.reengage;
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
function stubTwilio(windowShut: boolean) {
  payloads = [];
  _setTwilioClientForTests({
    messages: {
      create: async (p: Record<string, any>) => {
        payloads.push(p);
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
  chk(templatesSent().includes(SID.reengage),
    "…is rejected by the closed window, and the generic check-in goes instead",
    JSON.stringify(templatesSent()));
  chk(!templatesSent().includes(SID.daily),
    "the MORNING template is not pressed into evening service — it opens \"Morning {{1}}\"",
    JSON.stringify(templatesSent()));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. THE RECORD DOES NOT CLAIM THE COACHING LANDED");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The body stored was already honest. The INTENT was not: filed as PROACTIVE, a substitution was
// indistinguishable from a message that reached the client, so "today's coaching never arrived"
// was true in the world and unreadable in the ledger.
{
  const h = await history();
  chk(h.length === 1, "exactly one row is written for the substituted send", JSON.stringify(h.length));
  chk(!!h[0] && isCheckIn(h[0].body),
    "the stored body is the check-in the client READ", JSON.stringify(h[0]?.body.slice(0, 80) || ""));
  chk(!!h[0] && !isEveningCoaching(h[0].body),
    "…and NOT the coaching they never saw", JSON.stringify(h[0]?.body.slice(0, 80) || ""));
  chk(!!h[0] && h[0].intent === "PROACTIVE_SUBSTITUTED",
    "the status says a substitute went out, not a delivery", JSON.stringify(h.map(r => r.intent)));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3b. AND THE CALLER IS TOLD SO — the outcome and the record must agree");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The intent discriminator is only half the truth: a caller that asks "did this reach them?" must
// hear no, or it will act on a message the client never read. Graded through the transport
// directly, because the job does not return its outcome. Without this assertion the reporting
// half of Cut 6 could be flipped back to "fallback" and nothing here would notice.
{
  await reset();
  stubTwilio(true);
  const outcome = await sendWhatsApp(phone, "Lerato, haven't heard from you today — no stress.\n\n*Log one meal.*");
  chk(outcome === "substituted",
    "a send that degraded to the generic check-in reports `substituted`, not `fallback`",
    String(outcome));
  const h = await history();
  chk(!!h[0] && h[0].intent === "PROACTIVE_SUBSTITUTED",
    "…and the ledger agrees with the outcome", JSON.stringify(h.map(r => r.intent)));
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
  chk(loops.length === 0, "a substituted evening opens no open loop", JSON.stringify(loops));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n6. THE SNAPSHOT STILL NAMES THE MESSAGE THEY ACTUALLY READ");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The reader that asks "what was the last automated coach message?" filters on the delivery
// intent, so marking a substitution changes what it can see. If it matched PROACTIVE alone, the
// newest message the client received would be invisible and the model would be handed an OLDER
// one as "something you said" — the client quotes the check-in back and the coach denies sending
// it. The discriminator must not cost the snapshot its newest truth.
{
  await reset();
  // An ordinary proactive lands yesterday, inside the snapshot's two-day window…
  await pool.query(
    `INSERT INTO chat_history (user_id, message_in, message_out, intent, created_at)
     VALUES ($1, NULL, 'Morning Lerato — your plan for today is ready.', 'PROACTIVE', now() - interval '20 hours')`,
    [user.id]);
  // …and today's evening send degrades to the generic check-in.
  stubTwilio(true);
  await sendWhatsApp(phone, "Lerato, haven't heard from you today — no stress.\n\n*Log one meal.*");
  await new Promise(r => setTimeout(r, 2000));

  const snapshot = await buildClientSnapshot({ ...user, id: user.id });
  const line = snapshot.split("\n").find(l => l.includes("Last automated coach message")) || "";
  chk(!!line, "the snapshot carries a last-automated-message line at all", JSON.stringify(snapshot.slice(0, 120)));
  chk(isCheckIn(line), "…and it is the check-in the client READ, not the older plan",
    JSON.stringify(line.slice(0, 140)));
  chk(!/your plan for today is ready/i.test(line),
    "…so the model is not handed a stale message as the newest one", JSON.stringify(line.slice(0, 140)));
}

await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
REAL(failed ? `\npg-evening-delivery-acceptance: FAILED — ${failed} assertion(s)\n`
            : "\npg-evening-delivery-acceptance: GREEN\n");
await pool.end();
process.exit(failed ? 1 : 0);

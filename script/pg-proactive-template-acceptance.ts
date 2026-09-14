/**
 * REAL-POSTGRESQL ACCEPTANCE — a generic check-in leaves no trace of a message it did not carry
 * (Cut 6, 2026-09-14).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS TRUE BEFORE THIS CUT, traced on c042dd8
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A proactive send to a client outside the 24-hour window is rejected by WhatsApp (63016). The
 * only recovery this codebase had was the generic "Coach K checking in" template, and it returned
 * "fallback" — which `deliveryAccepted()` reads as TRUE.
 *
 * So the morning job opened an OPEN TRAINING LOOP for a client who had read a generic check-in and
 * never seen the training move, and the weekly job recorded its canonical move the same way. The
 * client is then answered, days later, about a decision they were never shown — and the row says
 * the coach told them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS GRADES, AND HOW HONESTLY
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The DURABLE half, against a real database: given each delivery outcome, does a follow-up row
 * exist afterwards? The focused grader (script/proactive-template-tests.ts) covers which template
 * was chosen and what it carried, against a simulated Twilio; this covers what the database is
 * left holding. Nothing here contacts Twilio at all — the outcome is the input.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-proactive-template-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { recordCanonicalMoveOutbound } = await import("../server/scheduler/proactive-decision");
const { loadOpenTrainingLoop } = await import("../server/memory");
const { sastDayKey } = await import("../server/sast");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

const phone = "whatsapp:+27820000966";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Thandi Window", onboardingState: "COMPLETE", popiConsent: true,
  popiConsentAt: new Date(), subscriptionStatus: "active", goalType: "fat_loss",
  currentWeight: "88", startWeight: "92", targetWeight: "80", heightCm: 165, age: 31,
  trainingDaysPerWeek: 3, programmeWeek: 2,
}).returning();

/** A decision that DOES create a follow-up when it is delivered — so "no row" means something. */
const trainingMove: any = {
  line: "Today is a training day — 30 minutes, full body.",
  action: { kind: "train", intervention: "standard" },
  state: "CHANGE",
  held: {},
  degraded: false,
};

// THE LOOP LIVES IN users.awaiting_input_type, and the in-memory object caches it — both facts
// cost this acceptance two failing checks before the fixture was right. Reading it back out of
// PostgreSQL rather than off the object is the point: the claim is about what is DURABLE.
async function openLoopExists(): Promise<boolean> {
  const { rows } = await pool.query<{ a: string | null }>(
    "SELECT awaiting_input_type AS a FROM users WHERE id = $1", [user.id]);
  const marker = rows[0]?.a || "";
  return marker.length > 0 && !!(await loadOpenTrainingLoop({ ...user, awaitingInputType: marker }).catch(() => null));
}

async function clearLoops(): Promise<void> {
  await pool.query("UPDATE users SET awaiting_input_type = NULL WHERE id = $1", [user.id]);
  user.awaitingInputType = null;   // the recorder reads the object before it touches the database
}

REAL("\npg-proactive-template-acceptance\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("1. A SUBSTITUTED SEND RECORDS NOTHING — the client never saw the move");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  await clearLoops();
  const result = await recordCanonicalMoveOutbound(user, trainingMove, "substituted");
  chk(result === null, "the recorder declines a substituted delivery", JSON.stringify(result));
  chk(!(await openLoopExists()),
    "…and NO open training loop exists for a move the client was never shown");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. THE OPPOSITE DEFECT — a real delivery still records its move");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Section 1 is also satisfied by a recorder that never records anything, which would silently end
// every coaching loop in the product. This is the half that makes it mean something.
{
  await clearLoops();
  await recordCanonicalMoveOutbound(user, trainingMove, "sent");
  chk(await openLoopExists(), "a delivered move opens its training loop, as it always has");

  await clearLoops();
  // "fallback" is SMS or a matching approved template — the client's own words in another shape.
  await recordCanonicalMoveOutbound(user, trainingMove, "fallback");
  chk(await openLoopExists(),
    "…and so does one carried by SMS or by the message's OWN approved template");

  await clearLoops();
  await recordCanonicalMoveOutbound(user, trainingMove, "dropped");
  chk(!(await openLoopExists()), "…while a dropped send records nothing, as it always has");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. THE OUTCOME VOCABULARY SAYS WHAT IT MEANS (source)");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const { readFileSync } = await import("node:fs");
  const live = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  const delivery = live(readFileSync("server/outbound-delivery.ts", "utf-8"));
  const shared = live(readFileSync("server/scheduler/shared.ts", "utf-8"));
  chk(/"substituted"/.test(delivery), "the delivery vocabulary carries a name for 'not this message'");
  chk(!/result === "substituted"/.test(delivery.split("export function deliveryAccepted")[1]?.split("}")[0] || ""),
    "…and deliveryAccepted does NOT count it as an accepted delivery");
  chk(/return templateDelivery === "dropped" \? "dropped" : "substituted";/.test(shared),
    "the generic re-engagement path reports it");
  chk(/templateSid\(windowTemplate\.name\)/.test(shared),
    "…and the message's own approved template is consulted first");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. THE REAL JOB OWNERS SELECT THEIR OWN TEMPLATE — not just sendWhatsApp directly");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS SECTION EXISTS. Every other proof in this cut drives sendWhatsApp with a template the
// TEST supplies. That grades the shared door and says nothing about whether morning.ts, weekly.ts
// and business.ts still hand it one: all three call sites could be disconnected tomorrow and the
// suite would stay green. So these run the ACTUAL exported job functions against real rows, with
// Twilio rejecting the first freeform send exactly as a closed 24-hour window does.
{
  const { _setTwilioClientForTests } = await import("../server/outbound-delivery");
  const { runMorningCheckin } = await import("../server/scheduler/jobs/morning");
  const { runSundayWeeklyReport } = await import("../server/scheduler/jobs/weekly");
  const { runPaymentFailureRecovery } = await import("../server/scheduler/jobs/business");

  const SID = {
    daily: "HX0000000000000000000000000000000a",
    weekly: "HX0000000000000000000000000000000b",
    payment: "HX0000000000000000000000000000000c",
    reengage: "HX0000000000000000000000000000000d",
  };
  process.env.TWILIO_DAILY_TEMPLATE_SID = SID.daily;
  process.env.TWILIO_WEEKLY_TEMPLATE_SID = SID.weekly;
  process.env.TWILIO_PAYMENT_TEMPLATE_SID = SID.payment;
  process.env.TWILIO_REENGAGE_TEMPLATE_SID = SID.reengage;
  process.env.PROACTIVE_PAUSED = "";   // these jobs are the subject; the killswitch would skip them

  // Every freeform body is rejected with 63016 — the window is closed for everyone. Templates are
  // accepted. Each payload is recorded so the claim is read off what was handed to Twilio.
  let payloads: Array<Record<string, any>> = [];
  _setTwilioClientForTests({
    messages: {
      create: async (p: Record<string, any>) => {
        payloads.push(p);
        if (typeof p.body === "string") {
          const err: any = new Error("simulated 63016"); err.code = 63016; err.status = 400; throw err;
        }
        return { sid: "SM1" };
      },
    },
  });
  // SCOPED TO THIS CLIENT'S NUMBER. These jobs iterate EVERY user in the database, so an
  // unscoped assertion reads other rows' sends — the first version of this section saw seventeen
  // generic check-ins belonging to clients this cut never touched and called it a failure.
  const sidsSent = () => payloads.filter(p => p.contentSid && p.to === phone).map(p => p.contentSid);
  const bodiesSent = () => payloads.filter(p => typeof p.body === "string" && p.to === phone).length;

  // ── MORNING ────────────────────────────────────────────────────────────────────────────────
  // THE ROW IS SHAPED TO SATISFY EACH JOB'S OWN CONDITIONS, never to bypass them: old enough to
  // be reported on, quiet for three days, and with REAL workout rows behind the counts the bodies
  // quote — without those the outbound truth floor blocks the send, correctly, and the job never
  // reaches its template. (It did exactly that here, which is how this fixture was found wrong.)
  await pool.query(
    `UPDATE users SET awaiting_input_type = NULL, subscription_status = 'active',
       created_at = NOW() - INTERVAL '30 days',
       total_workouts_completed = 4 WHERE id = $1`, [user.id]);
  await pool.query("DELETE FROM workout_logs WHERE user_id = $1", [user.id]);
  for (let d = 1; d <= 4; d++) {
    await pool.query(
      "INSERT INTO workout_logs (user_id, workout_completed, logged_at) VALUES ($1, true, NOW() - ($2 || ' days')::interval)",
      [user.id, String(d)]);
  }
  payloads = [];
  await runMorningCheckin().catch((e) => REAL(`  (morning job threw: ${(e as any)?.message})`));
  chk(bodiesSent() > 0, "the morning job reached this client at all", `freeform attempts: ${bodiesSent()}`);
  chk(sidsSent().includes(SID.daily),
    "runMorningCheckin() sends the DAILY template when the window is closed",
    `templates sent: ${JSON.stringify(sidsSent())}`);
  chk(!sidsSent().includes(SID.reengage) || sidsSent().indexOf(SID.daily) >= 0,
    "…rather than falling straight to the generic check-in", JSON.stringify(sidsSent()));

  // ── WEEKLY ─────────────────────────────────────────────────────────────────────────────────
  payloads = [];
  await pool.query("DELETE FROM client_actions WHERE user_id = $1", [user.id]).catch(() => {});
  await pool.query("DELETE FROM sent_proactive WHERE user_id = $1", [user.id]).catch(() => {});
  await runSundayWeeklyReport().catch((e) => REAL(`  (weekly job threw: ${(e as any)?.message})`));
  chk(bodiesSent() > 0, "the weekly job reached this client at all", `freeform attempts: ${bodiesSent()}`);
  chk(sidsSent().includes(SID.weekly),
    "runSundayWeeklyReport() sends the WEEKLY template when the window is closed",
    `templates sent: ${JSON.stringify(sidsSent())}`);

  // ── PAYMENT ────────────────────────────────────────────────────────────────────────────────
  // The recovery only fires 1, 3 or 7 days after cancellation, and only for a client who has
  // actually trained — so the row is shaped to satisfy the job's own conditions, not bypass them.
  payloads = [];
  await pool.query(
    `UPDATE users SET subscription_status = 'inactive', cancelled_at = NOW() - INTERVAL '7 days',
      total_workouts_completed = 4 WHERE id = $1`, [user.id]);
  await pool.query("DELETE FROM sent_proactive WHERE user_id = $1", [user.id]).catch(() => {});
  await runPaymentFailureRecovery().catch((e) => REAL(`  (payment job threw: ${(e as any)?.message})`));
  chk(bodiesSent() > 0, "the payment job reached this client at all", `freeform attempts: ${bodiesSent()}`);
  chk(sidsSent().includes(SID.payment),
    "runPaymentFailureRecovery() sends the PAYMENT template on the DAY-SEVEN reminder",
    `templates sent: ${JSON.stringify(sidsSent())}`);

  _setTwilioClientForTests(null);
}

REAL(`\n${failed === 0 ? "pg-proactive-template-acceptance: GREEN" : `pg-proactive-template-acceptance: ${failed} FAILED`}\n`);
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

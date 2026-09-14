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

REAL(`\n${failed === 0 ? "pg-proactive-template-acceptance: GREEN" : `pg-proactive-template-acceptance: ${failed} FAILED`}\n`);
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

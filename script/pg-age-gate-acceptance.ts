/**
 * REAL-POSTGRESQL ACCEPTANCE — under-18s cannot complete signup, and a stated age under 18
 * mid-conversation takes the same path (#267).
 *
 * WHAT WAS BROKEN (AUDIT.md P0, minors): the onboarding age question blocked only under-14s, so a
 * 14–17-year-old answered "15" and was put on a weight-loss programme with a calorie deficit. A
 * client who said "I'm 16" after onboarding was coached as an adult, because nothing read it.
 *
 * Graded on users.onboarding_state (what every later turn and every proactive job reads) and the
 * post-transport WhatsApp body (what the young person was told).
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-age-gate-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.PROACTIVE_PAUSED = "false";
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

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};
const row = async (id: string) => (await pool.query("SELECT onboarding_state s, age FROM users WHERE id = $1", [id])).rows[0];
const lastShadowId = async () => Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM shadow_replies")).rows[0].m);
let sidN = 0;
async function say(phone: string, text: string): Promise<string> {
  _resetOutboundDedupe(); _resetInteractionCorrelation();
  const s0 = await lastShadowId();
  await processTextAsync(phone, text, null, null, [], handleMessage as any, `SM267${++sidN}`);
  await new Promise(r => setTimeout(r, 1500));
  return (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2 ORDER BY id", [phone, s0])).rows.map(r => r.body).join("\n");
}
async function client(n: number, over: Record<string, unknown>) {
  const phone = `whatsapp:+2782000267${String(n).padStart(2, "0")}`;
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: `Lebo${n} Age`, onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(),
    subscriptionStatus: "active", goalType: "fat_loss", gender: "female", age: 30, heightCm: 165, currentWeight: "70",
    calorieTarget: 1700, proteinTarget: 120, trainingMode: "home", trainingDaysPerWeek: 3,
    lifeSituation: "office", trainingExperience: "beginner", ...over,
  } as any).returning();
  return u as any;
}
// What the young person must be told: plainly that this is for adults, and who to talk to instead.
const isGateReply = (b: string) => /\b18\b/.test(b) && /parent|guardian|clinic|nurse|doctor/i.test(b);
// …and nothing that coaches them onto a programme.
const coaches = (b: string) => /\bkcal\b|calorie target|deficit|weight and height|protein/i.test(b);

REAL("\npg-age-gate-acceptance — under-18s cannot complete signup (#267)\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("1. ONBOARDING — a 16-year-old answers the age question");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const u = await client(1, { onboardingState: "ASK_AGE_NEW", age: null, goalType: null, calorieTarget: null, proteinTarget: null, subscriptionStatus: "inactive" });
  const body = await say(u.phoneNumber, "16");
  const r = await row(u.id);
  REAL(`        stored: onboarding_state=${r.s} age=${r.age}`);
  REAL(`        final body: ${JSON.stringify(body.slice(0, 240))}`);
  chk(r.s === "BLOCKED_UNDERAGE", "a 16-year-old is stopped at the age question", `onboarding_state=${r.s}`);
  chk(r.age === null, "…and the minor's age is not kept on file", `age=${r.age}`);
  chk(isGateReply(body) && !coaches(body), "…and is told kindly why, and who to talk to instead", JSON.stringify(body));

  const again = await say(u.phoneNumber, "please I really want to lose weight");
  chk((await row(u.id)).s === "BLOCKED_UNDERAGE" && isGateReply(again) && !coaches(again),
    "the next message gets the same answer, not a programme", JSON.stringify(again));

  const a = await client(2, { onboardingState: "ASK_AGE_NEW", age: null, goalType: null, calorieTarget: null, proteinTarget: null, subscriptionStatus: "inactive" });
  await say(a.phoneNumber, "18");
  const ra = await row(a.id);
  chk(ra.s === "ASK_WEIGHT_HEIGHT" && ra.age === 18, "CONTROL — an 18-year-old carries on to the next question", `state=${ra.s} age=${ra.age}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. MID-CONVERSATION — an onboarded client says they are 16");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const u = await client(3, {});
  const body = await say(u.phoneNumber, "I'm 16 and I want to lose weight before the matric dance");
  const r = await row(u.id);
  REAL(`        stored: onboarding_state=${r.s}`);
  REAL(`        final body: ${JSON.stringify(body.slice(0, 240))}`);
  chk(r.s === "BLOCKED_UNDERAGE", "a stated age under 18 blocks the account", `onboarding_state=${r.s}`);
  chk(isGateReply(body) && !coaches(body), "…with the same kind, fixed message", JSON.stringify(body));
  const next = await say(u.phoneNumber, "what should I eat for supper?");
  chk(isGateReply(next) && !coaches(next), "…and no coaching follows on the next turn", JSON.stringify(next));

  const w = await client(4, {});
  await say(w.phoneNumber, "I am a 15 year old girl, is this ok for me?");
  chk((await row(w.id)).s === "BLOCKED_UNDERAGE", "\"I am a 15 year old\" takes the same path");

  const s = await client(5, {});
  await say(s.phoneNumber, "I’m 17, can I still use this?");
  chk((await row(s.id)).s === "BLOCKED_UNDERAGE", "a typographic apostrophe (I’m 17) takes the same path");

  // UNDER TEN (#338, replay gate age-nine-mid-conversation): the pattern stopped at 10.
  const nine = await client(13, {});
  await say(nine.phoneNumber, "I'm 9 years old and I want to lose weight");
  chk((await row(nine.id)).s === "BLOCKED_UNDERAGE", "\"I'm 9 years old\" takes the same path");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. ALREADY ONBOARDED AS A MINOR — the stored age is read on their next message");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const u = await client(6, { age: 16 });
  const body = await say(u.phoneNumber, "what should I eat for supper?");
  const r = await row(u.id);
  chk(r.s === "BLOCKED_UNDERAGE", "a client stored as 16 is blocked on their next message", `onboarding_state=${r.s}`);
  chk(r.age === null, "…and their age is no longer kept on file", `age=${r.age}`);
  chk(isGateReply(body) && !coaches(body), "…and told why", JSON.stringify(body));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. CONTROLS — a number that is not the client's age blocks nobody");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const cases: Array<[number, string]> = [
    [7, "I'm 16 weeks pregnant, can I still train?"],
    [8, "My son is 15, can he train with me?"],
    [9, "I'm 17kg down since January!"],
    [10, "I'm 30 and my daughter is 16"],
    [11, "I'm 15 minutes late for gym, quick workout?"],
    [12, "People say I'm 16, but I'm 30"],
    [14, "I'm 9 weeks postpartum, when can I train?"],
    [15, "I'm 5 years into my job and always tired"],
  ];
  for (const [n, text] of cases) {
    const u = await client(n, {});
    await say(u.phoneNumber, text);
    const s = (await row(u.id)).s;
    chk(s === "COMPLETE", `"${text}" leaves an adult's account alone`, `onboarding_state=${s}`);
  }
}

REAL(`\npg-age-gate-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

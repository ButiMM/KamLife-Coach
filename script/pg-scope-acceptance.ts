/**
 * REAL-POSTGRESQL ACCEPTANCE — the coach stays a coach: scope is enforced in code and fails
 * closed (#321).
 *
 * WHAT WAS BROKEN (Grok §8, audit C2): the domain guard answered anything its fast-path did not
 * recognise when the classifier errored or was unsure ("fail-open to answering"), and scope was
 * otherwise only a line of prompt text. Meta bans general-purpose AI assistants on the WhatsApp
 * Business API from 15 Jan 2026, so "write my CV" answered by Coach K is a platform risk, not a
 * style problem.
 *
 * Graded on the post-transport WhatsApp body. This runs with the model OFFLINE, which is exactly
 * the classifier-error case: on main every unrecognised message fails open and gets answered.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-scope-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "on";
process.env.PROACTIVE_PAUSED = "true";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";
delete process.env.DOMAIN_GUARD;

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
const lastShadowId = async () => Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM shadow_replies")).rows[0].m);
let n = 0;
async function say(phone: string, text: string): Promise<string> {
  _resetOutboundDedupe(); _resetInteractionCorrelation();
  const s0 = await lastShadowId();
  await processTextAsync(phone, text, null, null, [], handleMessage as any, `SM321${++n}`);
  await new Promise(r => setTimeout(r, 1200));
  return (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2 ORDER BY id", [phone, s0])).rows.map(r => r.body).join("\n");
}
async function client(k: number) {
  const phone = `whatsapp:+2782000321${String(k).padStart(2, "0")}`;
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: `Zanele${k} Scope`, onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(),
    subscriptionStatus: "active", goalType: "fat_loss", gender: "female", age: 31, heightCm: 163, currentWeight: "74",
    calorieTarget: 1700, proteinTarget: 120, trainingMode: "home", trainingDaysPerWeek: 3,
    lifeSituation: "office", trainingExperience: "beginner", lastActiveAt: new Date(),
  } as any).returning();
  return u as any;
}
// The coach declined and steered back: it names what it is for, and answers nothing else.
const isScopeRedirect = (b: string) => /outside what I can help with|I'm here for your health and fitness|for a doctor or pharmacist/i.test(b);

REAL("\npg-scope-acceptance — the coach stays a coach; scope fails closed (#321)\n");

REAL("1. OFF-TOPIC ASKS ARE DECLINED WITHOUT A MODEL, AND STEERED BACK");
const offTopic = [
  "Can you help me write my CV for a job application?",
  "Should I put my savings into bitcoin this month?",
  "Please write me an essay about the history of Soweto for school",
  "What antibiotic should I take for a sore throat?",
];
for (const [i, text] of offTopic.entries()) {
  const u = await client(i + 1);
  const body = await say(u.phoneNumber, text);
  chk(isScopeRedirect(body), `"${text}" is declined and steered back to coaching`, JSON.stringify(body.slice(0, 220)));
}

REAL("\n2. FAIL CLOSED — an unrecognised message with the classifier unavailable is not answered");
{
  const u = await client(10);
  const body = await say(u.phoneNumber, "Who do you think will win the rugby world cup this year and why?");
  chk(isScopeRedirect(body), "the classifier erroring does not turn an unknown topic into an answer", JSON.stringify(body.slice(0, 220)));
}

REAL("\n3. CONTROLS — coaching is never declined");
const coaching = [
  "I want to lose 5kg before December, where do I start?",
  "Can I resume training after having the flu last week?",
  "What should I eat for dinner tonight?",
  "My knee hurts when I do squats, what can I do instead?",
  "I'm type 2 diabetic, what breakfast keeps my sugar steady?",
  // A life event that mentions an off-topic thing is not an ask for it.
  "I had to update my CV last night so I skipped gym, can I still train today?",
];
for (const [i, text] of coaching.entries()) {
  const u = await client(20 + i);
  const body = await say(u.phoneNumber, text);
  chk(!isScopeRedirect(body), `"${text}" is coached, not declined`, JSON.stringify(body.slice(0, 220)));
}

REAL("\n4. ENGINE OFF — the gpt fallback is gated too, and fails closed the same way");
process.env.ENGINE_LIVE = "off";
{
  const u = await client(30);
  const body = await say(u.phoneNumber, "Who do you think will win the rugby world cup this year and why?");
  chk(isScopeRedirect(body), "with the engine off, an unknown topic is declined, not answered", JSON.stringify(body.slice(0, 220)));
  const c = await client(31);
  const coached = await say(c.phoneNumber, "My knee hurts when I do squats, what can I do instead?");
  chk(!isScopeRedirect(coached), "CONTROL — with the engine off, coaching is still coached", JSON.stringify(coached.slice(0, 220)));
}
process.env.ENGINE_LIVE = "on";

REAL(`\npg-scope-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

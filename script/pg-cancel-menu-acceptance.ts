/**
 * REAL-POSTGRESQL ACCEPTANCE — the cancel menu owns its own answers (#315).
 *
 * WHAT WAS BROKEN: "Cancel my subscription" shows *1* Too expensive / *2* Not seeing results /
 * *3* Need a break / *4* Just cancel. The numbered shortcuts elsewhere answered first: "4" got the
 * weekly shopping list and the subscription stayed active (the client kept being billed); "2" and
 * "3" got the step and food-log prompts. Graded on the post-transport body and the stored
 * subscription, through the real front door. PayFast is not configured here, so the cancel is
 * unconfirmed and must not be promised.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-cancel-menu-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-stub";
process.env.OFFLINE_AI = "0";
process.env.NORMALIZER = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  if (!url.includes("api.openai.com")) return realFetch(input, init);
  const body = typeof init?.body === "string" ? init.body : "";
  const content = body.includes("domain gate") ? "YES" : "Okay.";
  return new Response(JSON.stringify({ id: "stub", object: "chat.completion", created: 1, model: "stub",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

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
const RUN = Date.now().toString(36);
let n = 0;
async function say(phone: string, text: string): Promise<string> {
  _resetOutboundDedupe(); _resetInteractionCorrelation();
  const s0 = await lastShadowId();
  await processTextAsync(phone, text, null, null, [], handleMessage as any, `SM315${RUN}${++n}`);
  await new Promise(r => setTimeout(r, 800));
  return (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2 ORDER BY id", [phone, s0])).rows.map(r => r.body).join("\n");
}
async function client(k: number) {
  const phone = `whatsapp:+2782000315${String(k).padStart(2, "0")}`;
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: `Lerato${k} Cancel`, onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(),
    subscriptionStatus: "active", goalType: "fat_loss", gender: "female", age: 31, heightCm: 162, currentWeight: "74",
    calorieTarget: 1700, proteinTarget: 120, trainingMode: "home", trainingDaysPerWeek: 3, lifeSituation: "office",
  } as any).returning();
  return u as any;
}
const row = async (id: string) => (await pool.query("SELECT subscription_status, subscription_end_reason, awaiting_input_type FROM users WHERE id = $1", [id])).rows[0];
const SHOPPING = /what to buy|shopping list|R\d{3} est/i;

REAL("\npg-cancel-menu-acceptance — the cancel menu owns its own answers (#315)\n");

REAL("1. \"4 — Just cancel\" CANCELS");
const a = await client(1);
const menu = await say(a.phoneNumber, "Cancel my subscription");
chk(/\*4\*\s*—\s*Just cancel/.test(menu), "the cancel menu is shown", JSON.stringify(menu.slice(0, 200)));
const four = await say(a.phoneNumber, "4");
chk(!SHOPPING.test(four), "\"4\" is not answered with the shopping list", JSON.stringify(four.slice(0, 200)));
chk(/reply \*yes\* to cancel/i.test(four), "\"4\" reaches the last-check step", JSON.stringify(four.slice(0, 200)));
const yes = await say(a.phoneNumber, "yes");
const ra = await row(a.id);
chk(ra.subscription_status === "inactive" && ra.subscription_end_reason === "client_cancelled", "\"yes\" ends the subscription as the client's own cancellation", JSON.stringify(ra));
chk(!/won'?t be charged again|will not be charged again/i.test(yes), "no \"not charged again\" promise when PayFast did not confirm", JSON.stringify(yes.slice(0, 200)));

REAL("\n2. THE OTHER CHOICES MEAN THE MENU TOO");
const b = await client(2);
await say(b.phoneNumber, "Cancel my subscription");
const two = await say(b.phoneNumber, "2");
chk(!/send me your step count/i.test(two) && /let me be straight|8.12 weeks|log your food for 5 days/i.test(two), "\"2\" is the not-seeing-results answer, not the step-log prompt", JSON.stringify(two.slice(0, 200)));
const c = await client(3);
await say(c.phoneNumber, "Cancel my subscription");
const three = await say(c.phoneNumber, "3");
chk(!/send me what you ate/i.test(three) && /paused for 30 days/i.test(three), "\"3\" pauses, not the food-log prompt", JSON.stringify(three.slice(0, 200)));
chk((await row(c.id)).subscription_status === "active", "a pause is not a cancellation");

REAL("\n3. CONTROL — outside the cancel menu, the shortcuts still work");
const d = await client(4);
const shortcut = await say(d.phoneNumber, "4");
chk(SHOPPING.test(shortcut), "\"4\" from the main menu is still the shopping list", JSON.stringify(shortcut.slice(0, 200)));
chk((await row(d.id)).subscription_status === "active", "and nothing is cancelled");

REAL(`\npg-cancel-menu-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

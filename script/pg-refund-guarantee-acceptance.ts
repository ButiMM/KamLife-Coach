/**
 * REAL-POSTGRESQL ACCEPTANCE — the 14-day money-back guarantee, end to end (#328).
 *
 * WHAT WAS BROKEN: the guarantee was advertised, but "refund" opened a manual form ("reply with what
 * happened, how much, your payment date") and said "your coach has been notified" when nobody was.
 * Graded through the real front door on: the client's reply, the subscription, the recorded refund
 * owed (admin_events) and the founder's alert. PayFast's API is stubbed at the network edge.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-refund-guarantee-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
process.env.PAYFAST_MERCHANT_ID = "10000100";
process.env.PAYFAST_PASSPHRASE = "jt7NOE43FZPn";
process.env.COACH_ALERT_PHONE = "27820000999";

let pfMode: "ok" | "fail" = "ok";
let pfCancels = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  if (url.includes("api.payfast.co.za")) {
    pfCancels++;
    return pfMode === "ok"
      ? new Response(JSON.stringify({ code: 200, status: "success", data: { response: true } }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ code: 400, status: "failed", data: { response: false, message: "could not be cancelled" } }), { status: 400, headers: { "content-type": "application/json" } });
  }
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
const FOUNDER = "whatsapp:+27820000999";
const lastShadowId = async () => Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM shadow_replies")).rows[0].m);
const since = async (phone: string, s0: number) => (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2 ORDER BY id", [phone, s0])).rows.map(r => r.body).join("\n");
const RUN = Date.now().toString(36);
let n = 0;
async function say(phone: string, text: string): Promise<string> {
  _resetOutboundDedupe(); _resetInteractionCorrelation();
  const s0 = await lastShadowId();
  await processTextAsync(phone, text, null, null, [], handleMessage as any, `SM328${RUN}${++n}`);
  await new Promise(r => setTimeout(r, 900));
  return since(phone, s0);
}
async function client(k: number, paidDaysAgo: number | null) {
  const phone = `whatsapp:+2782000328${String(k).padStart(2, "0")}`;
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
  await pool.query("DELETE FROM payment_events WHERE phone = $1", [phone]);
  await pool.query("DELETE FROM admin_events WHERE target_phone = $1", [phone]);
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: `Zanele${k} Refund`, onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(),
    subscriptionStatus: paidDaysAgo === null ? "inactive" : "active", goalType: "fat_loss", gender: "female", age: 30, heightCm: 163, currentWeight: "71",
    calorieTarget: 1700, proteinTarget: 120, trainingMode: "home", trainingDaysPerWeek: 3, lifeSituation: "office",
  } as any).returning();
  if (paidDaysAgo !== null) {
    await pool.query("INSERT INTO payment_events (provider, provider_payment_id, phone, amount_gross, payment_status, raw_body, processed_at) VALUES ('payfast', $1, $2, '149.00', 'COMPLETE', $3, now() - make_interval(days => $4))",
      [`pf-328-${k}-${RUN}`, phone, JSON.stringify({ token: `tok-328-${k}` }), paidDaysAgo]);
  }
  return u as any;
}
const sub = async (id: string) => (await pool.query("SELECT subscription_status, subscription_end_reason FROM users WHERE id = $1", [id])).rows[0];
const owed = async (phone: string) => (await pool.query("SELECT action, meta FROM admin_events WHERE target_phone = $1 ORDER BY performed_at", [phone])).rows;

REAL("\npg-refund-guarantee-acceptance — the 14-day money-back guarantee, end to end (#328)\n");

REAL("1. WITHIN 14 DAYS — refunded, billing cancelled, founder told exactly what to refund");
const a = await client(1, 5);
let f0 = await lastShadowId();
const r1 = await say(a.phoneNumber, "I want a refund please");
chk(/within the 14-day money-back guarantee/i.test(r1) && /R149/.test(r1), "the client is told they're within the guarantee and the amount coming back", JSON.stringify(r1.slice(0, 300)));
chk(/recurring billing is cancelled/i.test(r1) && /by \w{3},? \d{1,2} \w{3}/.test(r1), "and that billing is cancelled, with a date for the refund", JSON.stringify(r1.slice(0, 300)));
const sa = await sub(a.id);
chk(sa.subscription_status === "inactive" && sa.subscription_end_reason === "refund_guarantee", "the subscription ends as a guarantee refund", JSON.stringify(sa));
chk(pfCancels === 1, "the recurring billing is cancelled at PayFast", `PayFast calls ${pfCancels}`);
const ea = await owed(a.phoneNumber);
chk(ea.some((e: any) => e.action === "refund_guarantee_owed" && e.meta?.amount === "R149" && e.meta?.dueBy), "the refund owed is recorded with its amount and due date", JSON.stringify(ea));
const task = async (id: string) => (await pool.query("SELECT priority, trigger_message, sla_deadline FROM escalations WHERE user_id = $1 AND reason = 'billing' ORDER BY created_at", [id])).rows;
const ta = await task(a.id);
chk(ta.length === 1 && /Guarantee refund OWED: R149/.test(ta[0].trigger_message) && /pf-328-1/.test(ta[0].trigger_message) && !!ta[0].sla_deadline,
  "the founder gets a task with a deadline: the exact refund to issue", JSON.stringify(ta));

REAL("\n2. ASKED AGAIN — told it's on its way; nothing recorded twice, billing not touched again");
const r2 = await say(a.phoneNumber, "where is my refund?");
chk(/already on its way/i.test(r2), "a repeat request is told the refund is already on its way", JSON.stringify(r2.slice(0, 200)));
chk((await owed(a.phoneNumber)).filter((e: any) => e.action === "refund_guarantee_owed").length === 1 && pfCancels === 1, "nothing is recorded or cancelled twice");

REAL("\n3. PAYFAST REFUSES THE CANCEL — no \"billing cancelled\" promise; founder told to cancel by hand");
pfMode = "fail";
const b = await client(2, 3);
f0 = await lastShadowId();
const r3 = await say(b.phoneNumber, "money back please");
chk(/being cancelled by hand/i.test(r3) && !/recurring billing is cancelled/i.test(r3), "the client is not told billing is cancelled when PayFast refused", JSON.stringify(r3.slice(0, 300)));
chk((await task(b.id)).some((t: any) => t.priority === "urgent" && /did NOT confirm the billing cancel/i.test(t.trigger_message)), "the founder gets an urgent task to cancel the billing by hand");
pfMode = "ok";

REAL("\n4. OUTSIDE 14 DAYS — told why, and the founder really is alerted");
const c = await client(3, 30);
f0 = await lastShadowId();
const r4 = await say(c.phoneNumber, "I want a refund");
chk(/outside the 14-day money-back guarantee/i.test(r4) && /within 24 hours/i.test(r4), "the client is told it's outside the guarantee and who replies when", JSON.stringify(r4.slice(0, 300)));
chk((await sub(c.id)).subscription_status === "active", "nothing is cancelled or refunded automatically");
chk((await task(c.id)).some((t: any) => /outside the 14-day guarantee/i.test(t.trigger_message)), "the founder gets a task to reply (it used to say 'notified' and notify nobody)");

REAL("\n5. NO PAYMENT ON RECORD — no guarantee refund is invented");
const d = await client(4, null);
const r5 = await say(d.phoneNumber, "refund");
chk(/can't find a payment/i.test(r5) && !/coming back to you/i.test(r5), "a client with no payment is not promised money", JSON.stringify(r5.slice(0, 300)));

REAL("\n6. ALREADY CANCELLED, STILL WITHIN 14 DAYS — the guarantee, not a payment link");
const e = await client(5, 4);
await pool.query("UPDATE users SET subscription_status = 'inactive', subscription_end_reason = 'client_cancelled', cancelled_at = now() WHERE id = $1", [e.id]);
const cancelsBefore = pfCancels;
const r6 = await say(e.phoneNumber, "Can I get my money back?");
chk(/within the 14-day money-back guarantee/i.test(r6) && !/payfast\/link|reply \*pay\*/i.test(r6), "a cancelled client within 14 days gets the guarantee, not a payment link", JSON.stringify(r6.slice(0, 300)));
chk((await owed(e.phoneNumber)).some((x: any) => x.action === "refund_guarantee_owed") && pfCancels === cancelsBefore, "the refund is recorded; billing already ended is not cancelled again");

REAL(`\npg-refund-guarantee-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

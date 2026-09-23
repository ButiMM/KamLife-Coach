/**
 * REAL-POSTGRESQL ACCEPTANCE — cancelling stops the money, and the money tells the truth.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS PROVEN BROKEN ON 0fb644a (main), BEFORE ANY EDIT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *  1. A REAL PAYFAST ITN IS REJECTED. The webhook sorts the ITN's fields alphabetically before
 *     hashing (629610e, 2026-06-19, "This may fix ITN validation failures"). PayFast's own SDK
 *     validates an ITN in the order the fields ARRIVE — PaymentIntegrations/Notification.php,
 *     dataToString(): no ksort, and it stops at `signature`. Sorting is the API-signature rule,
 *     not the ITN rule. A body signed exactly the way PayFast signs it was answered "signature
 *     mismatch" and the paying client was never activated.
 *
 *  2. CANCEL PROMISED WHAT NOTHING DID. "yes" to the cancel confirmation set the row inactive,
 *     alerted the founder, and told the client "your recurring billing is being cancelled — you
 *     will not be charged again". No call reached PayFast. The subscription token kept billing.
 *
 *  3. THE NEXT CHARGE ERASED THE CANCELLATION. A COMPLETE ITN on the cancelled subscription set
 *     the client active again and nulled `cancelled_at` — the record of their decision gone, the
 *     charge taken, and the client coached as if they had renewed.
 *
 *  4. A CLIENT WHO CANCELLED WAS TOLD THEIR PAYMENT FAILED. runPaymentFailureRecovery selects
 *     every inactive row with a `cancelled_at`, which is also what a voluntary cancel writes. One
 *     day later: "your payment didn't go through yesterday … Update your payment here".
 *
 *     ON BASE THAT MESSAGE WAS DROPPED, AND SO WAS EVERY OTHER ONE HERE — BY ACCIDENT. The
 *     outbound truth floor reads "N sessions" as a claim about the last 7 days. Every money
 *     message states a LIFETIME count ("6 sessions of progress are saved"), so for any client with
 *     more sessions in total than in the past week the floor refused it:
 *       - the cancel confirmation became "Let me check that properly … ask me again";
 *       - the lapse notice a client whose card failed genuinely needs was never sent;
 *       - the day-3 and day-30 win-backs were never sent.
 *     The voluntary canceller was spared the false "payment failed" only because the lapsed client
 *     was denied the true one. The floor already exempts lifetime phrasing ("since you started",
 *     "in total"); the messages never used it. §3, §6, §7 and §8 grade the words that arrive.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS GRADED, AND WHERE IT IS READ FROM
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Stored truth: users.subscription_status / cancelled_at, payment_events, admin_events.
 * Words: shadow_replies, after sendFinal / prepareOutbound — the client's reply and the founder's
 * alert as they would have been sent. PayFast: every request the product makes to
 * api.payfast.co.za, recorded by the fetch stub and its signature recomputed here, independently,
 * from PayFast's published SDK algorithm (Auth::generateApiSignature).
 *
 * ITNs are POSTed over HTTP to the real registered route. Their signatures are computed here the
 * way PayFast computes them, never by calling the product's own check. The state-machine sections
 * send their fields in alphabetical order, where "received order" and "sorted order" are the same
 * string, so those sections grade the payment state machine and nothing else; §1 alone grades
 * field order.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-payments-cancel-truth-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
process.env.PAYFAST_MERCHANT_ID = "10000100";
process.env.PAYFAST_MERCHANT_KEY = "46f0cd694581a";
process.env.PAYFAST_PASSPHRASE = "jt7NOE43FZPn";
process.env.PAYFAST_SANDBOX = "true";
process.env.COACH_ALERT_PHONE = "27820000999";
delete process.env.ADMIN_PHONE_OVERRIDE;

import crypto from "node:crypto";

const COACH_ANSWER = "Okay, noted on that.";
const CLASSIFY = `{"intent":"OTHER","confidence":0.85,"canonical":""}`;

type PfCall = { method: string; url: string; headers: Record<string, string> };
const pfCalls: PfCall[] = [];
let pfMode: "ok" | "fail" = "ok";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  const body = typeof init?.body === "string" ? init.body : "";
  if (url.includes("api.payfast.co.za")) {
    const h: Record<string, string> = {};
    const raw = init?.headers || {};
    const entries: [string, string][] = raw instanceof Headers ? [...raw.entries()] : Object.entries(raw) as [string, string][];
    for (const [k, v] of entries) h[k.toLowerCase()] = String(v);
    pfCalls.push({ method: String(init?.method || "GET").toUpperCase(), url, headers: h });
    return pfMode === "ok"
      ? new Response(JSON.stringify({ code: 200, status: "success", data: { response: true, message: "Subscription cancelled" } }),
        { status: 200, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ code: 400, status: "failed", data: { response: false, message: "Failure - The subscription could not be cancelled" } }),
        { status: 400, headers: { "content-type": "application/json" } });
  }
  if (url.includes("api.openai.com") && url.includes("/embeddings")) {
    return new Response(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: Array(1536).fill(0) }], model: "text-embedding-3-small", usage: { prompt_tokens: 1, total_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("api.openai.com")) {
    const isClassifier = body.includes("message-understanding brain");
    return new Response(JSON.stringify({
      id: "chatcmpl-pay", object: "chat.completion", created: 1, model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: isClassifier ? CLASSIFY : COACH_ANSWER }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const REAL = console.log.bind(console);
const DEBUG = process.env.PAY_DEBUG === "1";
console.log = console.warn = console.error = (...a: any[]) => { if (DEBUG && /PAYFAST|CANCEL|BILLING|SCHEDULER|ALERT|OUTBOUND_AUTHORITY/.test(String(a[0]))) REAL("    [log]", ...a.map(x => typeof x === "string" ? x : (x?.message || JSON.stringify(x)))); };

const express = (await import("express")).default;
const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { PRICING } = await import("../shared/pricing");
const { registerPaymentRoutes } = await import("../server/routes/payments");
const { handleMessage } = await import("../server/routes");
const { processTextAsync } = await import("../server/routes/whatsapp");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");
const { _resetInteractionCorrelation } = await import("../server/handlers/chat-log");
const { runSubscriptionExpiryCheck, runPaymentFailureRecovery, runSignupNudge } = await import("../server/scheduler/jobs/business");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

// ── THE PAYFAST SIDE, WRITTEN FROM PAYFAST'S SDK, NOT FROM THE PRODUCT ─────────────────────────
const PASS = process.env.PAYFAST_PASSPHRASE!;
/** PHP urlencode(): spaces as "+", and the five characters encodeURIComponent leaves bare. */
const phpUrlencode = (v: string): string =>
  encodeURIComponent(v).replace(/[!'()*~]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, "+");
const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");
/** Notification::dataToString + pfValidSignature — the fields in the order they are SENT. */
function signItn(fields: [string, string][]): [string, string][] {
  const base = fields.map(([k, v]) => `${k}=${phpUrlencode(v)}`).join("&") + `&passphrase=${phpUrlencode(PASS)}`;
  return [...fields, ["signature", md5(base)]];
}
/** The order 629610e assumed: sorted keys, the product's own encoder. What was accepted before. */
function signItnSortedLegacy(fields: [string, string][]): [string, string][] {
  const base = [...fields].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, "+")}`).join("&") + `&passphrase=${encodeURIComponent(PASS)}`;
  return [...fields, ["signature", md5(base)]];
}
/** Auth::generateApiSignature — headers plus passphrase, ksort, urlencode, md5. */
function apiSignature(h: Record<string, string>): string {
  const d: Record<string, string> = { "merchant-id": h["merchant-id"], version: h["version"], timestamp: h["timestamp"], passphrase: PASS };
  return md5(Object.keys(d).sort().map(k => `${k}=${phpUrlencode(d[k])}`).join("&"));
}

const app = express();
app.use(express.urlencoded({ extended: false }));
registerPaymentRoutes(app as any);
const server = app.listen(0);
await new Promise(r => server.once("listening", r));
const port = (server.address() as any).port;

let seq = 0;
const amount = `${PRICING.monthlyPriceZAR}.00`;
/** One ITN. `order: "payfast"` sends PayFast's real field order; "alpha" sends sorted fields. */
function itnFields(phoneDigits: string, status: string, token: string, pfId: string, order: "payfast" | "alpha"): [string, string][] {
  const byName: Record<string, string> = {
    m_payment_id: `KAMLIFE-${phoneDigits}-${++seq}`, pf_payment_id: pfId, payment_status: status,
    item_name: "KamLife Coach Monthly Subscription", amount_gross: amount, amount_fee: "-5.00",
    amount_net: String(PRICING.monthlyPriceZAR - 5) + ".00", custom_str1: `+${phoneDigits}`,
    name_first: "Client", email_address: `${phoneDigits}@kamlife.local`,
    merchant_id: process.env.PAYFAST_MERCHANT_ID!, token, billing_date: "2026-09-22",
  };
  const payfastOrder = ["m_payment_id", "pf_payment_id", "payment_status", "item_name", "amount_gross", "amount_fee",
    "amount_net", "custom_str1", "name_first", "email_address", "merchant_id", "token", "billing_date"];
  const keys = order === "payfast" ? payfastOrder : [...payfastOrder].sort();
  return keys.map(k => [k, byName[k]]);
}
async function postItn(fields: [string, string][]): Promise<void> {
  const pfId = fields.find(([k]) => k === "pf_payment_id")?.[1] || "";
  // The ITN route's own welcome / renewal sends go straight to Twilio, outside every door this
  // proof can read. Unset only for the POST so they are skipped rather than attempted.
  const saved = process.env.TWILIO_WHATSAPP_NUMBER;
  delete process.env.TWILIO_WHATSAPP_NUMBER;
  try {
    await realFetch(`http://127.0.0.1:${port}/webhook/payfast`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fields.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"),
    });
    // The route answers 200 first and works after. Wait for its idempotency row, then its writes.
    for (let i = 0; i < 20; i++) {
      const r = await pool.query("SELECT 1 FROM payment_events WHERE provider_payment_id = $1", [pfId]);
      if (r.rowCount) break;
      await new Promise(r2 => setTimeout(r2, 100));
    }
    await new Promise(r => setTimeout(r, 900));
  } finally { process.env.TWILIO_WHATSAPP_NUMBER = saved; }
}

// ── CLIENTS ────────────────────────────────────────────────────────────────────────────────
const FOUNDER = "whatsapp:+27820000999";
async function makeClient(digits: string, name: string, extra: Record<string, unknown> = {}) {
  const phone = `whatsapp:+${digits}`;
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
  await pool.query("DELETE FROM payment_events WHERE phone = $1", [phone]);
  await pool.query("DELETE FROM admin_events WHERE target_phone = $1", [phone]);
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name, onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(),
    subscriptionStatus: "inactive", goalType: "fat_loss", currentWeight: "80", startWeight: "84",
    targetWeight: "72", heightCm: 165, age: 31, gender: "female", trainingMode: "home",
    totalWorkoutsCompleted: 6, proteinTarget: 120, calorieTarget: 1800, dailyCalorieTarget: 1800,
    ...extra,
  } as any).returning();
  // Six sessions on the profile means six rows in the ledger. Without them the outbound truth
  // floor correctly refuses every message that says "6 sessions" — a fixture manufacturing a
  // silence the product does not have (both the cancel reply and the lapse notice say it).
  for (let i = 1; i <= 6; i++) {
    await pool.query("INSERT INTO workout_logs (user_id, workout_completed, logged_at) VALUES ($1, true, now() - make_interval(days => $2))", [u.id, i * 3]);
  }
  return { id: u.id as string, phone, digits };
}
await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [FOUNDER]);
type Row = { subscription_status: string; cancelled_at: Date | null };
const row = async (phone: string): Promise<Row> =>
  (await pool.query<Row>("SELECT subscription_status, cancelled_at FROM users WHERE phone_number = $1", [phone])).rows[0];
const lastShadowId = async (): Promise<number> =>
  Number((await pool.query("SELECT COALESCE(MAX(id), 0) AS m FROM shadow_replies")).rows[0].m);
const shadowSince = async (phone: string, afterId: number): Promise<string[]> =>
  (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2 ORDER BY id", [phone, afterId])).rows.map(r => r.body);
const adminActions = async (phone: string): Promise<string[]> =>
  (await pool.query<{ action: string }>("SELECT action FROM admin_events WHERE target_phone = $1 ORDER BY performed_at", [phone])).rows.map(r => r.action);

async function say(c: { phone: string; id: string }, text: string, sid: string): Promise<string> {
  _resetOutboundDedupe();
  _resetInteractionCorrelation();
  const before = await lastShadowId();
  await processTextAsync(c.phone, text, null, null, [], handleMessage as any, sid);
  await new Promise(r => setTimeout(r, 1500));
  return (await shadowSince(c.phone, before)).join("\n");
}
async function cancelThroughFrontDoor(c: { phone: string; id: string }, sid: string): Promise<{ reply: string; founder: string }> {
  await pool.query("UPDATE users SET awaiting_input_type = 'cancel_confirm' WHERE id = $1", [c.id]);
  const f0 = await lastShadowId();
  const reply = await say(c, "yes", sid);
  return { reply, founder: (await shadowSince(FOUNDER, f0)).join("\n") };
}

// ── THE WORDS ──────────────────────────────────────────────────────────────────────────────
const promisesNoCharge = (b: string) => /\b(?:will not|won'?t) be (?:charged|billed) again\b/i.test(b);
const admitsNotConfirmed = (b: string) => /\b(?:could ?n[o']t|did ?n[o']t|not) (?:confirm|cancel)\b|\bby hand\b|\bmanually\b/i.test(b);
const saysPaymentFailed = (b: string) => /\bpayment did ?n[o']t go through\b|\bpayment didn'?t go through\b|\bupdate your payment\b/i.test(b);

REAL("\npg-payments-cancel-truth-acceptance — cancelling stops the money, and the money tells the truth\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("0. THE INSTRUMENTS — signers and detectors, against labelled inputs, before anything is graded");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  // PayFast's published ITN sample: fields in received order, signed with no passphrase.
  const sample: [string, string][] = [["m_payment_id", "01AB"], ["pf_payment_id", "1089250"], ["payment_status", "COMPLETE"], ["item_name", "Test Item"]];
  const unsaltedReceived = md5(sample.map(([k, v]) => `${k}=${phpUrlencode(v)}`).join("&"));
  const unsaltedSorted = md5([...sample].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${phpUrlencode(v)}`).join("&"));
  chk(unsaltedReceived !== unsaltedSorted, "received-order and sorted-order ITN signatures differ for a non-alphabetical body — §1 can see order");
  const alpha = itnFields("27820000970", "COMPLETE", "tok", "pf-0", "alpha");
  chk(signItn(alpha).at(-1)![1] === signItnSortedLegacy(alpha).at(-1)![1],
    "for an alphabetical body both signers agree — the state-machine sections grade state, not order");
  chk(phpUrlencode("O'Brien (x)") === "O%27Brien+%28x%29", "phpUrlencode matches PHP urlencode on the characters encodeURIComponent leaves bare");
  chk(promisesNoCharge("you will not be charged again") && !promisesNoCharge("you may be charged again"), "promisesNoCharge reads the promise");
  chk(saysPaymentFailed("your payment didn't go through yesterday") && !saysPaymentFailed("your coaching is stopped"), "saysPaymentFailed reads the failure claim");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n1. A REAL PAYFAST ITN IS ACCEPTED — fields signed in the order PayFast sends them");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const a = await makeClient("27820000971", "Ayanda Real");
  await postItn(signItn(itnFields(a.digits, "COMPLETE", "tok-ayanda-1", "pf-ayanda-1", "payfast")));
  const r = await row(a.phone);
  chk(r.subscription_status === "active", "a first payment signed exactly as PayFast signs an ITN activates the client",
    `status=${r.subscription_status} — the webhook re-sorted the fields and rejected PayFast's signature`);

  // CONTROL — the order 629610e assumed keeps working, so a deploy that is wrong about PayFast in
  // the other direction still activates nobody less than today.
  const b = await makeClient("27820000972", "Bongi Legacy");
  await postItn(signItnSortedLegacy(itnFields(b.digits, "COMPLETE", "tok-bongi-1", "pf-bongi-1", "payfast")));
  chk((await row(b.phone)).subscription_status === "active", "control: an ITN signed over sorted fields is still accepted");

  // CONTROL — a forged signature is still refused.
  const c = await makeClient("27820000973", "Chris Forged");
  const forged = itnFields(c.digits, "COMPLETE", "tok-c", "pf-c-1", "payfast");
  await postItn([...forged, ["signature", md5("not-the-passphrase")]]);
  chk((await row(c.phone)).subscription_status === "inactive", "control: a wrong signature activates nobody");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. SUBSCRIBE AND RENEW — the control the rest of the state machine stands on");
// ══════════════════════════════════════════════════════════════════════════════════════════════
const L = await makeClient("27820000974", "Lerato Pay");
await postItn(signItn(itnFields(L.digits, "COMPLETE", "tok-lerato-1", "pf-lerato-1", "alpha")));
chk((await row(L.phone)).subscription_status === "active", "the first payment activates");
await postItn(signItn(itnFields(L.digits, "COMPLETE", "tok-lerato-1", "pf-lerato-2", "alpha")));
chk((await row(L.phone)).subscription_status === "active", "the renewal on the same subscription keeps the client active");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. CANCEL WHEN PAYFAST REFUSES — no promise the product cannot keep");
// ══════════════════════════════════════════════════════════════════════════════════════════════
pfMode = "fail";
pfCalls.length = 0;
const c3 = await cancelThroughFrontDoor(L, "SMpay3");
const r3 = await row(L.phone);
chk(r3.subscription_status === "inactive" && !!r3.cancelled_at, "the cancel is recorded: inactive, with the moment it happened",
  `status=${r3.subscription_status} cancelled_at=${r3.cancelled_at}`);
chk(pfCalls.some(c => c.method === "PUT" && /\/subscriptions\/tok-lerato-1\/cancel\b/.test(c.url)),
  "the cancel reaches PayFast for the subscription the client is paying on",
  `payfast calls: ${JSON.stringify(pfCalls.map(c => `${c.method} ${c.url}`))}`);
chk(!promisesNoCharge(c3.reply), "a cancel PayFast did not confirm does not promise \"you will not be charged again\"",
  `reply: ${JSON.stringify(c3.reply)}`);
chk(admitsNotConfirmed(c3.reply), "the client is told the billing cancel is not yet confirmed", `reply: ${JSON.stringify(c3.reply)}`);
chk(/\+?27820000974/.test(c3.founder) && admitsNotConfirmed(c3.founder),
  "the founder is told to cancel this client's billing by hand", `founder: ${JSON.stringify(c3.founder)}`);

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. PAYFAST CHARGES THE CANCELLED SUBSCRIPTION — the charge does not undo the client's decision");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const cancelledAt = (await row(L.phone)).cancelled_at;
  const f0 = await lastShadowId();
  const cl0 = await lastShadowId();
  await postItn(signItn(itnFields(L.digits, "COMPLETE", "tok-lerato-1", "pf-lerato-3", "alpha")));
  const r4 = await row(L.phone);
  chk(r4.subscription_status === "inactive", "a charge on the cancelled subscription does not reactivate the client",
    `status=${r4.subscription_status}`);
  chk(!!r4.cancelled_at && !!cancelledAt && new Date(r4.cancelled_at).getTime() === new Date(cancelledAt).getTime(),
    "cancelled_at survives the charge", `before=${cancelledAt?.toISOString?.()} after=${r4.cancelled_at}`);
  chk((await adminActions(L.phone)).includes("charged_after_cancellation"),
    "the charge is recorded as money taken after a cancellation", `admin_events: ${JSON.stringify(await adminActions(L.phone))}`);
  const founder = (await shadowSince(FOUNDER, f0)).join("\n");
  chk(/\+?27820000974/.test(founder) && /\brefund\b/i.test(founder), "the founder is told this client was charged and needs a refund",
    `founder: ${JSON.stringify(founder)}`);
  chk((await shadowSince(L.phone, cl0)).length === 0, "the client is not told their coaching resumed");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. CONTROL — the client comes back through a NEW subscription, and is coached again");
// ══════════════════════════════════════════════════════════════════════════════════════════════
await postItn(signItn(itnFields(L.digits, "COMPLETE", "tok-lerato-2", "pf-lerato-4", "alpha")));
{
  const r5 = await row(L.phone);
  chk(r5.subscription_status === "active" && r5.cancelled_at === null, "a payment on a new subscription reactivates and clears the cancel",
    `status=${r5.subscription_status} cancelled_at=${r5.cancelled_at}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n6. CANCEL WHEN PAYFAST CONFIRMS — the promise is made because it is true");
// ══════════════════════════════════════════════════════════════════════════════════════════════
pfMode = "ok";
pfCalls.length = 0;
{
  const c6 = await cancelThroughFrontDoor(L, "SMpay6");
  const call = pfCalls.find(c => c.method === "PUT" && /\/subscriptions\/[^/]+\/cancel\b/.test(c.url));
  chk(!!call && /\/subscriptions\/tok-lerato-2\/cancel\b/.test(call.url), "the cancel targets the NEWEST subscription, not the one already cancelled",
    `payfast calls: ${JSON.stringify(pfCalls.map(c => `${c.method} ${c.url}`))}`);
  chk(!!call && /[?&]testing=true\b/.test(call.url), "sandbox credentials call PayFast's sandbox (?testing=true)", `url=${call?.url}`);
  chk(!!call && call.headers["merchant-id"] === process.env.PAYFAST_MERCHANT_ID && call.headers["version"] === "v1",
    "the request carries merchant-id and version v1", JSON.stringify(call?.headers));
  const ts = call ? Date.parse(call.headers["timestamp"] || "") : NaN;
  chk(Number.isFinite(ts) && Math.abs(ts - Date.now()) < 5 * 60_000, "the request timestamp is a real ISO-8601 time, now",
    `timestamp=${call?.headers["timestamp"]}`);
  chk(!!call && call.headers["signature"] === apiSignature(call.headers),
    "the signature matches PayFast's API algorithm, recomputed independently", `sent=${call?.headers["signature"]} expected=${call ? apiSignature(call.headers) : "-"}`);
  chk(promisesNoCharge(c6.reply), "a cancel PayFast confirmed tells the client they will not be charged again", `reply: ${JSON.stringify(c6.reply)}`);
  const r6 = await row(L.phone);
  chk(r6.subscription_status === "inactive" && !!r6.cancelled_at, "and the row says so");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n7. THE DAY AFTER — a client who cancelled is not told their payment failed");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  // CONTROL: a genuine lapse. Active, renewal eight days overdue, no ITN — the expiry job ends it.
  const N = await makeClient("27820000975", "Nomsa Lapsed", {
    subscriptionStatus: "active", subscriptionRenewsAt: new Date(Date.now() - 8 * 86_400_000),
  });
  await runSubscriptionExpiryCheck();
  chk((await row(N.phone)).subscription_status === "inactive", "control: an unpaid renewal expires the subscription");
  // One day on, for both.
  await pool.query("UPDATE users SET cancelled_at = now() - interval '25 hours' WHERE phone_number = ANY($1)", [[N.phone, L.phone]]);
  const before = await lastShadowId();
  await runPaymentFailureRecovery();
  const toLerato = (await shadowSince(L.phone, before)).join("\n");
  const toNomsa = (await shadowSince(N.phone, before)).join("\n");
  chk(!saysPaymentFailed(toLerato), "the client who cancelled is not told \"your payment didn't go through\"",
    `sent: ${JSON.stringify(toLerato)}`);
  chk(saysPaymentFailed(toNomsa), "the client whose renewal lapsed actually hears why, with the link to fix it",
    `sent: ${JSON.stringify(toNomsa)} — on base the floor read "6 sessions of progress" as a 7-day claim and dropped it`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n8. THREE DAYS AFTER — the win-back a canceller is meant to get is not silently dropped");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  await pool.query("UPDATE users SET cancelled_at = now() - interval '73 hours' WHERE phone_number = $1", [L.phone]);
  const before = await lastShadowId();
  await runSignupNudge();
  const toLerato = (await shadowSince(L.phone, before)).join("\n");
  chk(/\bsessions with Coach K\b/.test(toLerato) && !saysPaymentFailed(toLerato),
    "the day-3 win-back reaches the client who cancelled, and does not call it a failed payment", `sent: ${JSON.stringify(toLerato)}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n9. A CLIENT WHO CANCELLED BEFORE 0014 — the charge does not reactivate them either (Codex attack @ 14f70ad)");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  // The durable state every pre-0014 canceller carries: inactive, cancelled_at set, the
  // CANCEL_CONFIRMED turn in chat_history, and NO end reason — the column did not exist. The
  // guard reads the reason, so without a backfill this client is invisible to it.
  const T = await makeClient("27820000976", "Thabo Legacy");
  await postItn(signItn(itnFields(T.digits, "COMPLETE", "tok-thabo-1", "pf-thabo-1", "alpha")));
  const cancelledAt = new Date(Date.now() - 10 * 86_400_000);
  await pool.query("UPDATE users SET subscription_status = 'inactive', cancelled_at = $2, subscription_end_reason = NULL WHERE id = $1", [T.id, cancelledAt]);
  await pool.query("INSERT INTO chat_history (user_id, message_in, message_out, intent, created_at) VALUES ($1, 'yes', 'Done, Thabo.', 'CANCEL_CONFIRMED', $2)", [T.id, cancelledAt]);
  // CONTROL: a pre-0014 LAPSE — same shape, no cancel turn. It must not be marked a cancel.
  const U = await makeClient("27820000977", "Unathi Lapsed");
  await pool.query("UPDATE users SET subscription_status = 'inactive', cancelled_at = $2, subscription_end_reason = NULL WHERE id = $1", [U.id, cancelledAt]);
  // Deploy: the migration runs on boot. Idempotent, so running it again here is the real thing.
  const { readFileSync } = await import("node:fs");
  await pool.query(readFileSync("migrations/0014_subscription_end_reason.sql", "utf8"));
  const reasons = (await pool.query("SELECT phone_number, subscription_end_reason r FROM users WHERE id = ANY($1)", [[T.id, U.id]])).rows;
  chk(reasons.find(r => r.phone_number === U.phone)?.r == null, "control: a pre-0014 lapse is not relabelled as a cancel", JSON.stringify(reasons));
  const f0 = await lastShadowId();
  await postItn(signItn(itnFields(T.digits, "COMPLETE", "tok-thabo-1", "pf-thabo-2", "alpha")));
  const r9 = await row(T.phone);
  chk(r9.subscription_status === "inactive", "a charge on a pre-0014 cancelled subscription does not reactivate the client", `status=${r9.subscription_status}`);
  chk(!!r9.cancelled_at && new Date(r9.cancelled_at).getTime() === cancelledAt.getTime(), "and their cancellation date survives", `cancelled_at=${r9.cancelled_at}`);
  chk((await adminActions(T.phone)).includes("charged_after_cancellation") && /\brefund\b/i.test((await shadowSince(FOUNDER, f0)).join("\n")),
    "the charge is recorded and the founder is told to refund it", `admin_events=${JSON.stringify(await adminActions(T.phone))}`);
}

server.close();
await pool.end().catch(() => {});
REAL(`\npg-payments-cancel-truth-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}`);
process.exit(failed === 0 ? 0 : 1);

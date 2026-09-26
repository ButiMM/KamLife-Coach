/**
 * REAL-POSTGRESQL ACCEPTANCE — an opt-out is honoured on every send path (#265).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS PROVEN BROKEN ON main, BEFORE ANY EDIT — AUDIT.md P0 "Opt-out"
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *  Only the exact word STOP opted out. "Please stop messaging me" was a 7-day HOLIDAY pause, after
 *  which messages resumed; "stop sending me messages" and "I don't want these messages anymore"
 *  were not recognised at all; "Unsubscribe me" started the billing save-menu and paused nothing.
 *
 *  And even STOP was a per-job convention, not a boundary: `paused_until` is read by the jobs that
 *  remember to call isPaused(). sendCriticalAlert checked nothing, runPaymentFailureRecovery never
 *  called isPaused, and the dashboard broadcast and admin/intervention messages went straight to
 *  Twilio, past every door.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS GRADED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * What each path would have delivered, read from shadow_replies (SHADOW=on captures at the door),
 * and the client's stored opt-out. The dashboard and admin endpoints are driven over HTTP. Controls:
 * an ordinary client still receives the same proactive messages and the broadcast; a holiday pause
 * is still a pause, not an opt-out; "how do I stop snacking?" is a question; a client who opted out
 * and then writes to us still gets a reply; START resumes.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-opt-out-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
process.env.COACH_DASHBOARD_KEY = "dash-key-265";
process.env.PAYFAST_PASSPHRASE = "pass-265";
process.env.PAYFAST_MERCHANT_ID = "10000100";
delete process.env.PROACTIVE_PAUSED;
delete process.env.COACH_ALERT_PHONE;

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
      id: "chatcmpl-265", object: "chat.completion", created: 1, model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: isClassifier ? CLASSIFY : COACH_ANSWER }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const REAL = console.log.bind(console);
console.log = console.warn = console.error = (...a: any[]) => { if (process.env.DBG265 && /PAYFAST|DELIVERY/.test(String(a[0]))) REAL("    [log]", ...a.map(x => typeof x === "string" ? x : (x?.message || JSON.stringify(x)))); };

const express = (await import("express")).default;
const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { processTextAsync } = await import("../server/routes/whatsapp");
const { sendWhatsApp, sendCriticalAlert } = await import("../server/scheduler/shared");
const { runPaymentFailureRecovery } = await import("../server/scheduler/jobs/business");
const { registerDashboardRoutes } = await import("../server/routes/dashboard");
const { registerAdminRoutes } = await import("../server/routes/admin");
const { registerPaymentRoutes } = await import("../server/routes/payments");
const { sendWhatsAppButtons } = await import("../server/twilio-interactive");
const { _setTwilioClientForTests } = await import("../server/outbound-delivery");
const { PRICING } = await import("../shared/pricing");
const crypto = await import("node:crypto");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");
const { _resetInteractionCorrelation, logChat } = await import("../server/handlers/chat-log");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
registerPaymentRoutes(app as any);
registerDashboardRoutes(app as any, { logChat } as any);
registerAdminRoutes(app as any, { handleMessage, logChat } as any);
const server = app.listen(0);
await new Promise(r => server.once("listening", r));
const port = (server.address() as any).port;
const post = (path: string, body: unknown) => realFetch(`http://127.0.0.1:${port}${path}`, {
  method: "POST", headers: { "content-type": "application/json", "x-dashboard-key": process.env.COACH_DASHBOARD_KEY! },
  body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
}).then(r => r.json().catch(() => ({}))).catch(e => ({ error: String(e) }));

let seq = 0;
async function client(name: string, extra: Record<string, unknown> = {}) {
  const digits = `2782000265${String(++seq).padStart(2, "0")}`;
  const phone = `whatsapp:+${digits}`;
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name, onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(),
    subscriptionStatus: "active", goalType: "fat_loss", currentWeight: "80", startWeight: "84", targetWeight: "72",
    heightCm: 170, age: 33, gender: "male", trainingMode: "home", totalWorkoutsCompleted: 6,
    proteinTarget: 140, calorieTarget: 2100, dailyCalorieTarget: 2100, ...extra,
  } as any).returning();
  // Six sessions on the profile are six rows this week, so no truth floor refuses "6 sessions".
  for (let i = 1; i <= 6; i++) await pool.query("INSERT INTO workout_logs (user_id, workout_completed, logged_at) VALUES ($1, true, now() - make_interval(days => $2))", [u.id, i]);
  return { id: u.id as string, phone };
}
const lastShadowId = async () => Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM shadow_replies")).rows[0].m);
const shadowSince = async (phone: string, after: number) =>
  (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2 ORDER BY id", [phone, after])).rows.map(r => r.body);
async function say(c: { phone: string }, text: string): Promise<string> {
  _resetOutboundDedupe(); _resetInteractionCorrelation();
  const s0 = await lastShadowId();
  await processTextAsync(c.phone, text, null, null, [], handleMessage as any, `SM265-${++seq}`);
  await new Promise(r => setTimeout(r, 1500));
  return (await shadowSince(c.phone, s0)).join("\n");
}
/** Every proactive path that reaches a single client, fired once. Returns what arrived. */
async function proactiveReaches(c: { phone: string }): Promise<string[]> {
  _resetOutboundDedupe();
  const s0 = await lastShadowId();
  await sendWhatsApp(c.phone, `Morning check-in ${++seq}: how did yesterday go?`).catch(() => {});
  await sendCriticalAlert(c.phone, `Your renewal is due in 2 days (${seq}). Nothing to do if your card is fine.`).catch(() => {});
  await sendWhatsAppButtons(c.phone, `Training tonight (${seq})?`, ["Doing it tonight", "Rest day today"], { proactive: true } as any).catch(() => {});
  return shadowSince(c.phone, s0);
}

REAL("\npg-opt-out-acceptance — an opt-out is honoured on every send path\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("0. CONTROL — an ordinary client receives every proactive path");
// ══════════════════════════════════════════════════════════════════════════════════════════════
const ORDINARY = await client("Sipho Ordinary");
chk((await proactiveReaches(ORDINARY)).length === 3, "sendWhatsApp, sendCriticalAlert and the proactive button sender all reach an ordinary client",
  JSON.stringify(await shadowSince(ORDINARY.phone, 0)));

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n1. EVERY WAY OF SAYING IT — the opt-out is honoured on the proactive paths afterwards");
// ══════════════════════════════════════════════════════════════════════════════════════════════
const PHRASES = [
  "STOP",
  "stop sending me messages",
  "Please stop messaging me",
  "Unsubscribe me",
  "I don't want these messages anymore",
  "no more messages please",
  "Please don't contact me again",   // Codex @ 5c0cd6d
  "I've just been diagnosed with cancer. Please stop messaging me.",   // #286: the illness comfort used to swallow it
];
const OPTED: Array<{ id: string; phone: string }> = [];
for (const text of PHRASES) {
  const c = await client("Opting Out");
  const reply = await say(c, text);
  const reached = await proactiveReaches(c);
  chk(reached.length === 0, `after "${text}", no proactive message reaches them`, `reply=${JSON.stringify(reply)} reached=${JSON.stringify(reached)}`);
  if (text === "stop sending me messages") REAL(`        final body: ${JSON.stringify(reply)}`);
  if (/diagnosed/.test(text)) chk(/sorry/i.test(reply) && /no more messages/i.test(reply),
    "the diagnosis is heard AND the stop is confirmed", JSON.stringify(reply));
  OPTED.push(c);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. PAYMENT RECOVERY — the job that never checked");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const L = await client("Lapsed Optout");
  await say(L, "stop sending me messages");
  const C = await client("Lapsed Control");
  for (const x of [L, C]) {
    await pool.query("UPDATE users SET subscription_status = 'inactive', cancelled_at = now() - interval '25 hours' WHERE id = $1", [x.id]);
    await pool.query("UPDATE users SET subscription_end_reason = 'payment_lapsed' WHERE id = $1", [x.id]).catch(() => {});
  }
  const s0 = await lastShadowId();
  await runPaymentFailureRecovery();
  chk((await shadowSince(C.phone, s0)).length > 0, "control: a lapsed client who did not opt out still gets the recovery message",
    JSON.stringify(await shadowSince(C.phone, s0)));
  chk((await shadowSince(L.phone, s0)).length === 0, "a lapsed client who opted out does not", JSON.stringify(await shadowSince(L.phone, s0)));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. THE DASHBOARD AND ADMIN DOORS — broadcast, intervention, admin message");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const O = OPTED[1];
  const s0 = await lastShadowId();
  const res = await post("/api/dashboard/broadcast", { message: `Broadcast ${++seq}: new programme week starts Monday.`, filter: "all" });
  chk((await shadowSince(ORDINARY.phone, s0)).length === 1, "control: the broadcast reaches an ordinary client through the door",
    `response=${JSON.stringify(res)} shadow=${JSON.stringify(await shadowSince(ORDINARY.phone, s0))}`);
  chk((await shadowSince(O.phone, s0)).length === 0, "the broadcast does not reach a client who opted out", JSON.stringify(await shadowSince(O.phone, s0)));
  const s1 = await lastShadowId();
  await post("/api/dashboard/intervene", { phone: O.phone, type: "checkin" });
  await post("/api/admin/send-message", { userId: O.id, message: "Hi, Coach K here — just checking in." });
  await post("/api/dashboard/intervene", { phone: ORDINARY.phone, type: "checkin" });
  chk((await shadowSince(ORDINARY.phone, s1)).length === 1, "control: an intervention reaches an ordinary client through the door",
    JSON.stringify(await shadowSince(ORDINARY.phone, s1)));
  chk((await shadowSince(O.phone, s1)).length === 0, "neither the intervention nor the admin message reaches a client who opted out",
    JSON.stringify(await shadowSince(O.phone, s1)));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3b. A SUBSTITUTE IS NOT THE MESSAGE — the admin door outside the 24-hour window (Codex @ bbffa67)");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  // Freeform is refused with 63016 and the generic re-engagement template goes instead. The founder
  // typed a message the client never received: it must not be reported, or logged, as sent.
  const shadowWas = process.env.SHADOW;
  process.env.SHADOW = "";   // the shadow door intercepts before the 63016 path graded here
  process.env.TWILIO_REENGAGE_TEMPLATE_SID = "HX0000000000000000000000000000000d";
  _setTwilioClientForTests({ messages: { create: async (p: Record<string, any>) => {
    if (typeof p.body === "string") { const err: any = new Error("simulated 63016"); err.code = 63016; err.status = 400; throw err; }
    return { sid: "SM265sub" };
  } } } as any);
  const text = `Admin note ${++seq}: your new plan is ready.`;
  const res: any = await post("/api/admin/send-message", { userId: ORDINARY.id, message: text });
  _setTwilioClientForTests(null);
  process.env.SHADOW = shadowWas;
  await new Promise(r => setTimeout(r, 1000));
  const logged = await pool.query("SELECT COUNT(*)::int n FROM chat_history WHERE user_id = $1 AND message_out = $2", [ORDINARY.id, text]);
  chk(res?.success !== true && /not delivered/i.test(String(res?.message || "")),
    "the founder is told the message was NOT delivered when only the generic template went", JSON.stringify(res));
  chk(logged.rows[0].n === 0, "…and the undelivered text is not logged as said to the client", `rows=${logged.rows[0].n}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. CONTROLS — what an opt-out is not, and what it does not stop");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const H = await client("Holiday Pause");
  await say(H, "Please stop messaging me for 2 weeks, I'm on holiday");
  const notes = (await pool.query("SELECT profile_notes n FROM users WHERE id = $1", [H.id])).rows[0].n || "";
  chk(/paused_until:/.test(notes) && !/opted_out:/.test(notes), "a timed holiday pause is still a pause, not an opt-out", `profile_notes=${notes}`);
  // A TOPIC IS NOT THE CHANNEL (Codex @ 7716559) — main never opted these out, and neither may this.
  for (const text of ["I don't want your messages about calories, just send my workouts", "Stop messaging me about my weight",
    "Please stop contacting me about calories", "Stop WhatsApping me about my weight"]) {
    const T = await client("Topic Refusal");
    await say(T, text);
    const tn = (await pool.query("SELECT profile_notes n FROM users WHERE id = $1", [T.id])).rows[0].n || "";
    chk(!/opted_out:/.test(tn) && (await proactiveReaches(T)).length === 3, `"${text}" refuses a topic, not every message`, `profile_notes=${tn}`);
  }
  const Q = await client("Snack Question");
  await say(Q, "How do I stop snacking at night?");
  chk((await proactiveReaches(Q)).length === 3, "\"how do I stop snacking?\" is a question, not an opt-out");
  const O = OPTED[0];
  const r = await say(O, "What should I eat for dinner?");
  chk(r.length > 0, "a client who opted out and then writes to us still gets a reply", `reply=${JSON.stringify(r)}`);
  // Recovery is not consent (Codex @ bbffa67): the unpause branch lifted the opt-out with the pause.
  await say(O, "I'm back");
  const on = (await pool.query("SELECT profile_notes n FROM users WHERE id = $1", [O.id])).rows[0].n || "";
  chk(/opted_out:/.test(on) && (await proactiveReaches(O)).length === 0,
    "\"I'm back\" does not lift an opt-out — only START does", `profile_notes=${on}`);
  await say(O, "START");
  chk((await proactiveReaches(O)).length === 3, "after START, proactive messages resume");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. THE PAYFAST NOTICES — renewal confirmation to a payer who opted out");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  // The ITN's notices are the one path with no shadow capture; the delivery owner's test seam
  // records every send instead. Fields in alphabetical order, so every signing convention agrees.
  const created: Array<{ to: string; body: string }> = [];
  _setTwilioClientForTests({ messages: { create: async (p: any) => { created.push({ to: p.to, body: p.body }); return { sid: "SM" + created.length }; } } });
  const itn = async (digits: string, pf: string) => {
    const f: [string, string][] = [["amount_gross", `${PRICING.monthlyPriceZAR}.00`], ["custom_str1", `+${digits}`], ["m_payment_id", `M-${pf}`],
      ["merchant_id", "10000100"], ["payment_status", "COMPLETE"], ["pf_payment_id", pf], ["token", `tok-${digits}`]];
    const base = f.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, "+")}`).join("&") + `&passphrase=${encodeURIComponent("pass-265")}`;
    const sig = crypto.createHash("md5").update(base).digest("hex");
    await realFetch(`http://127.0.0.1:${port}/webhook/payfast`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: [...f, ["signature", sig]].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") });
    await new Promise(r => setTimeout(r, 1500));
  };
  const O = OPTED[2];
  await itn(O.phone.replace(/\D/g, ""), `pf-opt-${seq}`);
  await itn(ORDINARY.phone.replace(/\D/g, ""), `pf-ord-${seq}`);
  _setTwilioClientForTests(null);
  chk(created.some(c => c.to === ORDINARY.phone && /payment confirmed/i.test(c.body)), "control: an ordinary payer's renewal confirmation is sent", JSON.stringify(created));
  chk(!created.some(c => c.to === O.phone), "a payer who opted out is not messaged by the payment webhook", JSON.stringify(created));
}

server.close();
await pool.end().catch(() => {});
REAL(`\npg-opt-out-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}`);
process.exit(failed === 0 ? 0 : 1);

/**
 * REAL-POSTGRESQL ACCEPTANCE — the client record (#271, ORDERS §4 Step 3).
 *
 * WHAT WAS BROKEN (AUDIT.md Trace 2): "I'm training for the Comrades marathon in June and my knee
 * gets sore on long runs" was stored nowhere. Six turns later the 47,177-character prompt sent to
 * the model contained neither "Comrades" nor "knee", and the plan said "stand on a scale".
 *
 * The model is stubbed at the network edge (as the replay gate's --offline mode does), so this
 * proves the PLUMBING deterministically: what is stored, what supersedes, what is dropped, what the
 * engine is sent, and what deletion erases. Whether a live model extracts well is the gate's job.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-client-record-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-stub";
process.env.OFFLINE_AI = "0";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "on";
process.env.PROACTIVE_PAUSED = "true";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

// ── THE MODEL, STUBBED AT THE NETWORK EDGE ─────────────────────────────────────────────────────
// The extractor gets a scripted answer per message; every other model call gets a plain reply.
// Every request body is kept, so the test can read what the engine was actually sent.
const EXTRACT: Record<string, unknown> = {
  "I'm training for the Comrades marathon in June and my knee gets sore on long runs.": { facts: [
    { kind: "goal", subject: "comrades marathon", statement: "I'm training for the Comrades marathon in June", detail: {}, valid_until: null, corrects: null },
    { kind: "injury", subject: "knee", statement: "my knee gets sore on long runs", detail: {}, valid_until: null, corrects: null },
  ] },
  "Actually I changed my mind, I'm doing the Two Oceans marathon instead of Comrades.": { facts: [
    { kind: "goal", subject: "two oceans marathon", statement: "I'm doing the Two Oceans marathon instead of Comrades", detail: {}, valid_until: null, corrects: "comrades marathon" },
  ] },
  // The extractor "invents" a statement the client never wrote: it must be dropped, not stored.
  "My sister is pregnant and wants to know if she can squat.": { facts: [
    { kind: "life_event", subject: "pregnancy", statement: "I am pregnant", detail: {}, valid_until: null, corrects: null },
  ] },
};
const sentToModel: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  if (!url.includes("api.openai.com")) return realFetch(input, init);
  const body = typeof init?.body === "string" ? init.body : "";
  sentToModel.push(body);
  let content = "Okay, noted.";
  if (body.includes("maintain a coaching client's record")) {
    const msg = JSON.parse(body).messages.at(-1).content as string;
    content = JSON.stringify(EXTRACT[msg] ?? { facts: [] });
  } else if (body.includes("message-understanding brain")) content = `{"intent":"OTHER","confidence":0.5,"canonical":""}`;
  else if (body.includes("domain gate")) content = "YES";
  if (url.includes("/embeddings")) {
    return new Response(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: Array(1536).fill(0) }], model: "stub", usage: { prompt_tokens: 1, total_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
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
const q = async (sql: string, args: unknown[]) => (await pool.query(sql, args)).rows;
const settle = async (check: () => Promise<boolean>) => { for (let i = 0; i < 40 && !(await check()); i++) await new Promise(r => setTimeout(r, 250)); };
let sid = 0;
const RUN = Date.now().toString(36); // MessageSids are globally unique in production; so are ours
async function say(phone: string, text: string, messageSid = `SM271${RUN}${++sid}`) {
  _resetOutboundDedupe(); _resetInteractionCorrelation();
  await processTextAsync(phone, text, null, null, [], handleMessage as any, messageSid);
  await settle(async () => (await q("SELECT 1 FROM client_events WHERE source_message_id = $1", [messageSid])).length > 0);
  await new Promise(r => setTimeout(r, 400)); // the background extraction after the event
  return messageSid;
}
async function client(n: number) {
  const phone = `whatsapp:+2782000271${String(n).padStart(2, "0")}`;
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: `Thandi${n} Record`, onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(),
    subscriptionStatus: "active", goalType: "fat_loss", gender: "female", age: 34, heightCm: 165, currentWeight: "72",
    calorieTarget: 1800, proteinTarget: 120, trainingMode: "home", trainingDaysPerWeek: 3, lifeSituation: "office",
  } as any).returning();
  return u as any;
}
const activeFacts = async (id: string) => q("SELECT kind, subject, statement, source_event_id FROM client_facts WHERE user_id = $1 AND superseded_by IS NULL ORDER BY created_at", [id]);

REAL("\npg-client-record-acceptance — what the client said is kept, and the coach is told (#271)\n");

REAL("1. THE EVENT — what they sent, exactly, once, and never rewritten");
const u = await client(1);
const comrades = "I'm training for the Comrades marathon in June and my knee gets sore on long runs.";
const s1 = await say(u.phoneNumber, comrades);
const ev = await q("SELECT id, raw_text, channel FROM client_events WHERE source_message_id = $1", [s1]);
chk(ev.length === 1 && ev[0].raw_text === comrades && ev[0].channel === "text", "the message is stored exactly as sent", JSON.stringify(ev));
await say(u.phoneNumber, comrades, s1); // a Twilio retry of the same MessageSid
chk((await q("SELECT count(*)::int n FROM client_events WHERE source_message_id = $1", [s1]))[0].n === 1, "a retried delivery is one event, not two");
let rewriteRefused = false;
try { await pool.query("UPDATE client_events SET raw_text = 'edited' WHERE id = $1", [ev[0].id]); } catch { rewriteRefused = true; }
chk(rewriteRefused, "the database refuses to rewrite what the client said");

REAL("\n2. THE FACTS — typed, in their words, pointing at the message they came from");
await settle(async () => (await activeFacts(u.id)).length >= 2);
const facts = await activeFacts(u.id);
chk(facts.some((f: any) => f.kind === "goal" && /comrades/i.test(f.statement)) && facts.some((f: any) => f.kind === "injury" && /knee/i.test(f.statement)),
  "the Comrades goal and the sore knee are stored as facts", JSON.stringify(facts));
chk(facts.every((f: any) => f.source_event_id === ev[0].id), "each fact points at the message it came from");

REAL("\n3. SIX TURNS LATER — the coach is still told");
for (const t of ["I had oats and a banana for breakfast", "Walked 6000 steps today", "Lunch was pap and chicken", "Feeling a bit tired today"]) await say(u.phoneNumber, t);
sentToModel.length = 0;
await say(u.phoneNumber, "Given everything I've told you, how should I plan my training this week?");
const engineCall = sentToModel.find(b => b.includes("WHAT THIS CLIENT HAS TOLD YOU"));
chk(!!engineCall && /Comrades/.test(engineCall) && /knee/.test(engineCall),
  "the model's context six turns later carries the Comrades goal and the knee, in the client's words",
  engineCall ? "block present but incomplete" : `no engine request carried the facts (${sentToModel.length} model calls)`);

REAL("\n4. A CORRECTION SUPERSEDES — nothing is overwritten");
await say(u.phoneNumber, "Actually I changed my mind, I'm doing the Two Oceans marathon instead of Comrades.");
await settle(async () => (await activeFacts(u.id)).some((f: any) => /two oceans/i.test(f.subject)));
const after = await activeFacts(u.id);
const all = await q("SELECT subject, superseded_by FROM client_facts WHERE user_id = $1", [u.id]);
chk(after.some((f: any) => /two oceans/i.test(f.subject)) && !after.some((f: any) => /comrades/i.test(f.subject)), "the new goal is active and the old one is not", JSON.stringify(after));
chk(all.some((f: any) => /comrades/i.test(f.subject) && f.superseded_by), "the old goal is kept, marked superseded, not deleted");
chk(after.some((f: any) => f.kind === "injury"), "the knee is untouched by a goal correction");

REAL("\n5. NOT FACTS — a statement the client never wrote is dropped");
const v = await client(2);
await say(v.phoneNumber, "My sister is pregnant and wants to know if she can squat.");
await new Promise(r => setTimeout(r, 800));
chk((await activeFacts(v.id)).length === 0, "an extracted statement that is not in the message is not stored", JSON.stringify(await activeFacts(v.id)));

REAL("\n6. ERASURE — \"delete my data\" removes the record");
await say(u.phoneNumber, "delete my data");
await say(u.phoneNumber, "DELETE");
const left = (await q("SELECT (SELECT count(*) FROM client_events WHERE user_id = $1)::int e, (SELECT count(*) FROM client_facts WHERE user_id = $1)::int f", [u.id]))[0];
chk(left.e === 0 && left.f === 0, "no event and no fact survives a confirmed deletion", JSON.stringify(left));

REAL(`\npg-client-record-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

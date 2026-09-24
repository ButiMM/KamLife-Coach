/**
 * REAL-POSTGRESQL ACCEPTANCE — the new coach runs in read-only shadow (#272, ORDERS §4 Step 5).
 *
 * The shadow is the only safe way to compare the new core with the old path on real traffic, and
 * it is only safe if it is truly read-only. This proves, with the model stubbed at the network edge:
 *   - it runs beside every text turn and stores what it would have said;
 *   - it NEVER sends (its words never reach the transport) and NEVER writes client state;
 *   - it is given what the client told us (#271) and their real numbers;
 *   - it is off unless CORE_SHADOW=on, and POPIA deletion erases it.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-core-shadow-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-stub";
process.env.OFFLINE_AI = "0";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "on";
process.env.PROACTIVE_PAUSED = "true";
process.env.SHADOW = "on";
process.env.CORE_SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const SENTINEL = "SHADOW-ONLY-7f3a"; // the new coach's reply carries this; it must never reach a client
const composerRequests: string[] = [];
let understandCalls = 0;
const allRequests: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  if (!url.includes("api.openai.com")) return realFetch(input, init);
  const body = typeof init?.body === "string" ? init.body : "";
  allRequests.push(body);
  let content = "Okay, noted.";
  if (body.includes("say what they want from this turn")) {
    // ONE understanding call returns the reading AND the facts for the record (#271).
    understandCalls++;
    const msg = JSON.parse(body).messages.at(-1).content as string;
    const facts = /comrades/i.test(msg)
      ? [{ kind: "goal", subject: "comrades marathon", statement: "I'm training for the Comrades marathon", detail: {}, valid_until: null, corrects: null }] : [];
    content = JSON.stringify({ family: /comrades/i.test(msg) ? "report" : "question", wants: "advice", one_question: null, uncertainty: 0.2, facts });
  }
  else if (body.includes("You are Coach K, a warm, direct South African")) { composerRequests.push(body); content = `Great question. ${SENTINEL} One move today.`; }
  else if (body.includes("message-understanding brain")) content = `{"intent":"OTHER","confidence":0.5,"canonical":""}`;
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
const RUN = Date.now().toString(36);
let sid = 0;
async function say(phone: string, text: string) {
  const messageSid = `SM272${RUN}${++sid}`;
  _resetOutboundDedupe(); _resetInteractionCorrelation();
  await processTextAsync(phone, text, null, null, [], handleMessage as any, messageSid);
  return messageSid;
}
async function client(n: number) {
  const phone = `whatsapp:+2782000272${String(n).padStart(2, "0")}`;
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: `Sipho${n} Shadow`, onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(),
    subscriptionStatus: "active", goalType: "fat_loss", gender: "male", age: 36, heightCm: 178, currentWeight: "92",
    calorieTarget: 2200, proteinTarget: 150, trainingMode: "home", trainingDaysPerWeek: 3, lifeSituation: "office",
  } as any).returning();
  return u as any;
}

REAL("\npg-core-shadow-acceptance — the new coach runs beside the old one, and touches nothing (#272)\n");

REAL("1. IT RUNS BESIDE EVERY TEXT TURN");
const u = await client(1);
await say(u.phoneNumber, "I'm training for the Comrades marathon in June.");
await new Promise(r => setTimeout(r, 1500)); // the record learns in the background
const s2 = await say(u.phoneNumber, "What should I eat before a long run?");
await settle(async () => (await q("SELECT 1 FROM core_shadow WHERE root_id = $1", [s2])).length > 0);
const row = (await q("SELECT reply, understanding, facts_read FROM core_shadow WHERE root_id = $1", [s2]))[0];
chk(!!row && row.reply.includes(SENTINEL), "the new coach's would-be reply is stored against the turn", JSON.stringify(row));
chk(row?.understanding?.family === "question", "the understanding step's reading is stored with it", JSON.stringify(row?.understanding));

REAL("\n1b. ONE CALL READS THE MESSAGE — the record learns from the understanding call (#271, CTO 24 Sep)");
const learned = await q("SELECT f.statement, e.source_message_id FROM client_facts f JOIN client_events e ON e.id = f.source_event_id WHERE f.user_id = $1", [u.id]);
chk(learned.some((f: any) => /Comrades/.test(f.statement)), "the Comrades goal is stored from the shadow's understanding call", JSON.stringify(learned));
chk(!allRequests.some(b => b.includes("You also maintain the client's record") && !b.includes("say what they want from this turn")),
  "no separate model call is made for the record");
chk(allRequests.some(b => b.includes("say what they want from this turn") && b.includes("KNOWN FACTS")), "the understanding call is shown what the record already knows");

REAL("\n2. IT IS GIVEN WHAT THE CLIENT TOLD US, AND THEIR REAL NUMBERS");
const req = composerRequests.at(-1) || "";
chk(/WHAT THIS CLIENT HAS TOLD YOU/.test(req) && /Comrades/.test(req), "the composer sees the client record", req.slice(0, 200));
chk(/THEIR REAL NUMBERS/.test(req), "the composer sees their real numbers");
chk((row?.facts_read ?? 0) >= 1, "facts read are counted", String(row?.facts_read));

REAL("\n3. IT NEVER SENDS, AND NEVER WRITES CLIENT STATE");
const sent = await q("SELECT body FROM shadow_replies WHERE phone = $1", [u.phoneNumber]);
chk(sent.length > 0 && !sent.some((r: any) => r.body.includes(SENTINEL)), "nothing the shadow wrote reached the transport", JSON.stringify(sent.map((r: any) => r.body.slice(0, 60))));
const before = (await q("SELECT current_weight, goal_type, profile_notes FROM users WHERE id = $1", [u.id]))[0];
const meals0 = (await q("SELECT count(*)::int n FROM meal_logs WHERE user_id = $1", [u.id]))[0].n;
const s3 = await say(u.phoneNumber, "How much protein do I need today?");
await settle(async () => (await q("SELECT 1 FROM core_shadow WHERE root_id = $1", [s3])).length > 0);
const after = (await q("SELECT current_weight, goal_type, profile_notes FROM users WHERE id = $1", [u.id]))[0];
chk(after.current_weight === before.current_weight && after.goal_type === before.goal_type, "the client's row is not changed by the shadow");
chk((await q("SELECT count(*)::int n FROM meal_logs WHERE user_id = $1", [u.id]))[0].n === meals0, "no ledger row is written by a question turn");

REAL("\n4. OFF UNLESS SWITCHED ON");
process.env.CORE_SHADOW = "off";
const s4 = await say(u.phoneNumber, "Any tips for sleeping better?");
await new Promise(r => setTimeout(r, 1500));
chk((await q("SELECT count(*)::int n FROM core_shadow WHERE root_id = $1", [s4]))[0].n === 0, "with CORE_SHADOW off, the new coach does not run");
process.env.CORE_SHADOW = "on";

REAL("\n5. ERASURE — deleting the client deletes their shadow rows");
await say(u.phoneNumber, "delete my data");
await say(u.phoneNumber, "DELETE");
await new Promise(r => setTimeout(r, 1500));
chk((await q("SELECT count(*)::int n FROM core_shadow WHERE user_id = $1", [u.id]))[0].n === 0, "no shadow row survives a confirmed deletion");

REAL(`\npg-core-shadow-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

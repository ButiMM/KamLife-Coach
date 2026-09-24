/**
 * REAL-POSTGRESQL ACCEPTANCE — the client record (#271, ORDERS §4 Step 3).
 *
 * WHAT WAS BROKEN (AUDIT.md Trace 2): "I'm training for the Comrades marathon in June and my knee
 * gets sore on long runs" was stored nowhere. Six turns later the 47,177-character prompt sent to
 * the model contained neither "Comrades" nor "knee", and the plan said "stand on a scale".
 *
 * The model is stubbed at the network edge (as the replay gate's --offline mode does), so this
 * proves the PLUMBING deterministically: what is stored, what supersedes, what is dropped, what the
 * engine is sent, and what deletion erases. The facts come from #359's single understanding call;
 * here they are scripted and fed through applyFacts, the same door. Extraction quality is the gate's job.
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
// The facts the new core's understanding call (#359) would return per message, fed to applyFacts
// exactly as that call will. This PR adds no model call; every model call here gets a plain reply.
// Every request body is kept, so the test can read what the engine was actually sent.
const EXTRACT: Record<string, unknown> = {
  "I'm training for the Comrades marathon in June and my knee gets sore on long runs.": { facts: [
    { kind: "goal", subject: "comrades marathon", statement: "I'm training for the Comrades marathon in June", detail: {}, valid_until: null, corrects: null },
    { kind: "injury", subject: "knee", statement: "my knee gets sore on long runs", detail: {}, valid_until: null, corrects: null },
  ] },
  "Actually I changed my mind, I'm doing the Two Oceans marathon instead of Comrades.": { facts: [
    { kind: "goal", subject: "two oceans marathon", statement: "I'm doing the Two Oceans marathon instead of Comrades", detail: {}, valid_until: null, corrects: "comrades marathon" },
  ] },
  // A correction that names no prior subject: the extractor can only name it because it is shown the known facts.
  "Actually the race is in May now, not June.": { facts: [
    { kind: "goal", subject: "two oceans marathon", statement: "the race is in May now", detail: {}, valid_until: null, corrects: "two oceans marathon" },
  ] },
  // A real opening with an invented clause bolted on (Codex @ c5a521b): the whole statement must match.
  "I'm training for a 10k race and I love it.": { facts: [
    { kind: "goal", subject: "10k race", statement: "I'm training for a 10k race and I have a torn ACL", detail: {}, valid_until: null, corrects: null },
  ] },
  // Same subject, different kind: a constraint must not retire the preference.
  "I prefer home workouts.": { facts: [{ kind: "preference", subject: "home workouts", statement: "I prefer home workouts", detail: {}, valid_until: null, corrects: null }] },
  "I can only do home workouts because I have no gym.": { facts: [{ kind: "constraint", subject: "home workouts", statement: "I can only do home workouts because I have no gym", detail: {}, valid_until: null, corrects: null }] },
  // A fact that starts later is not true today.
  "I start night shifts in December.": { facts: [{ kind: "schedule", subject: "night shifts", statement: "I start night shifts in December", detail: {}, valid_from: "2099-12-01", valid_until: null, corrects: null }] },
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
  if (body.includes("message-understanding brain")) content = `{"intent":"OTHER","confidence":0.5,"canonical":""}`;
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
const { applyFacts, knownFacts } = await import("../server/core/client-record");

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
  const [ev] = await q("SELECT id FROM client_events WHERE source_message_id = $1", [messageSid]);
  if (ev) await applyFacts(ev.id, JSON.stringify(EXTRACT[text] ?? { facts: [] })); // what #359's understanding call returns
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

REAL("\n4b. A CORRECTION THAT NAMES NOTHING — the understanding call is given what is known, and the right fact is superseded");
const known = await knownFacts(u.id);
chk(/KNOWN FACTS/.test(known) && /two oceans marathon/.test(known), "the known facts the understanding call is given include the current goal", known.slice(0, 200));
await say(u.phoneNumber, "Actually the race is in May now, not June.");
const goals = (await activeFacts(u.id)).filter((f: any) => f.kind === "goal");
chk(goals.length === 1 && /may now/i.test(goals[0].statement), "exactly one active goal remains — the corrected one", JSON.stringify(goals));

REAL("\n4c. NO MODEL CALL OF ITS OWN — the record adds no call per message (CTO, 24 Sep)");
sentToModel.length = 0;
await say(u.phoneNumber, "I'm training for the Comrades marathon in June and my knee gets sore on long runs.", `SM271${RUN}nocall`);
chk(!sentToModel.some(b => /client's record|KNOWN FACTS/.test(b)), "storing a message sends nothing to a model on the record's behalf", `${sentToModel.length} model calls`);

REAL("\n5. NOT FACTS — a statement the client never wrote is dropped");
const v = await client(2);
await say(v.phoneNumber, "My sister is pregnant and wants to know if she can squat.");
await new Promise(r => setTimeout(r, 800));
chk((await activeFacts(v.id)).length === 0, "an extracted statement that is not in the message is not stored", JSON.stringify(await activeFacts(v.id)));

const w = await client(3);
await say(w.phoneNumber, "I'm training for a 10k race and I love it.");
await new Promise(r => setTimeout(r, 800));
chk((await activeFacts(w.id)).length === 0, "a real opening with an invented clause bolted on is not stored", JSON.stringify(await activeFacts(w.id)));

REAL("\n5b. KINDS AND TIME — a constraint never retires a preference; a future fact is not today's");
await say(w.phoneNumber, "I prefer home workouts.");
await settle(async () => (await activeFacts(w.id)).some((f: any) => f.kind === "preference"));
await say(w.phoneNumber, "I can only do home workouts because I have no gym.");
await settle(async () => (await activeFacts(w.id)).some((f: any) => f.kind === "constraint"));
const kinds = (await activeFacts(w.id)).map((f: any) => f.kind).sort();
chk(JSON.stringify(kinds) === JSON.stringify(["constraint", "preference"]), "the preference survives a constraint on the same subject", JSON.stringify(kinds));
await say(w.phoneNumber, "I start night shifts in December.");
await settle(async () => (await q("SELECT 1 FROM client_facts WHERE user_id = $1 AND kind = 'schedule'", [w.id])).length > 0);
const { factsForCoach, purgeExpired } = await import("../server/core/client-record");
const shown = await factsForCoach(w.id);
chk(/home workouts/.test(shown) && !/night shifts/.test(shown), "a fact that starts in December is stored but not shown to the coach today", shown);

REAL("\n5c. THE NEWEST FACTS — a long record shows the latest thirty, not the first");
for (let i = 0; i < 35; i++) {
  await pool.query("INSERT INTO client_facts (user_id, kind, subject, statement, extracted_by, created_at) VALUES ($1, 'preference', $2, $3, 'test', now() - ($4 || ' minutes')::interval)",
    [w.id, `food ${i}`, `I like food number ${i}`, String(100 - i)]);
}
const window = await factsForCoach(w.id);
chk(/food number 34/.test(window) && !/food number 0"/.test(window), "the newest facts are inside the thirty shown", window.slice(0, 160));

REAL("\n5d. RETENTION — raw messages and superseded facts older than a year are deleted");
await pool.query("INSERT INTO client_events (user_id, raw_text, received_at) VALUES ($1, 'an old message', now() - interval '13 months')", [w.id]);
await pool.query("INSERT INTO client_facts (user_id, kind, subject, statement, extracted_by, superseded_at) VALUES ($1, 'goal', 'old goal', 'an old goal', 'test', now() - interval '13 months')", [w.id]);
await purgeExpired();
const aged = (await q("SELECT (SELECT count(*) FROM client_events WHERE user_id = $1 AND raw_text = 'an old message')::int e, (SELECT count(*) FROM client_facts WHERE user_id = $1 AND subject = 'old goal')::int f, (SELECT count(*) FROM client_events WHERE user_id = $1)::int kept", [w.id]))[0];
chk(aged.e === 0 && aged.f === 0 && aged.kept > 0, "the year-old message and superseded fact are gone; recent ones stay", JSON.stringify(aged));

REAL("\n6. ERASURE — \"delete my data\" removes the record");
await say(u.phoneNumber, "delete my data");
await say(u.phoneNumber, "DELETE");
const left = (await q("SELECT (SELECT count(*) FROM client_events WHERE user_id = $1)::int e, (SELECT count(*) FROM client_facts WHERE user_id = $1)::int f", [u.id]))[0];
chk(left.e === 0 && left.f === 0, "no event and no fact survives a confirmed deletion", JSON.stringify(left));

REAL(`\npg-client-record-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

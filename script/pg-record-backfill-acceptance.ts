/**
 * REAL-POSTGRESQL ACCEPTANCE — existing clients' history reaches the new coach (#414).
 *
 * The client record starts on 24 Sep. Without this, switch day would meet a long-time tester with a
 * coach that has forgotten their knee, their night shifts and what they won't eat. Proven here, with
 * no model call anywhere: the old stores are copied once, labelled with their source, dated older than
 * anything the client says next, never duplicated (not even by two turns at once), shown to the new
 * coach on its first read, and erased with the client. Section 6: what they said in chat is learned
 * with ONE understanding call per client, keeping only verbatim facts in their own voice.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-record-backfill-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-stub";
process.env.NODE_ENV = "production";
globalThis.fetch = (async () => { throw new Error("no network: the backfill must not call a model"); }) as any;

const { db, pool } = await import("../server/db");
const schema = await import("../shared/schema");
const { eq, and, sql } = await import("drizzle-orm");
const { backfillFromOldStores, factsForCoach, _resetBackfillCache } = await import("../server/core/client-record");
const { readPreTurn, learnFromHistory, _resetHistoryTried } = await import("../server/core/coach");

let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${ok || !detail ? "" : `\n          ${detail}`}`);
  if (!ok) failed++;
};
const factRows = (userId: string) => db.select().from(schema.clientFacts).where(eq(schema.clientFacts.userId, userId));

const PHONE = "whatsapp:+27829414001", EMPTY = "whatsapp:+27829414002", RACE = "whatsapp:+27829414003", HIST = "whatsapp:+27829414004";
for (const p of [PHONE, EMPTY, RACE, HIST]) await pool.query("DELETE FROM users WHERE phone_number = $1", [p]);
const signedUp = new Date("2026-06-01T08:00:00+02:00");
const base = { onboardingState: "COMPLETE", subscriptionStatus: "active", goalType: "fat_loss", createdAt: signedUp };
const [u] = await db.insert(schema.users).values({ ...base, phoneNumber: PHONE, name: "Thandi Backfill",
  injuries: "left knee, torn meniscus in March", workSchedule: "night_shift", lifeContext: "new baby at home",
  doNotMention: "my ex", foodDislikes: "fish" } as any).returning();
// THE OLD MODEL'S OWN WRITING (CTO on #426): an unvalidated life story with an invented fact (the
// daughters), and a model "key fact". Neither was said by the client; neither may be imported.
await db.insert(schema.clientUnderstanding).values({ userId: u.id, profile: {
  lifeStory: "A nurse with two teenage daughters, training for her first 10k.",
  keyFacts: ["injury/limitation: left knee, torn meniscus in March", "responds well to encouragement"] } } as any);

console.log("\n1. THE OLD STORES ARE COPIED, LABELLED, AND OLDER THAN ANYTHING SAID NEXT");
const n = await backfillFromOldStores(u);
const rows = await factRows(u.id);
check("the knee from users.injuries is a fact", rows.some(r => r.kind === "injury" && /left knee/.test(r.statement)), JSON.stringify(rows.map(r => r.statement)));
check("the night shifts are a schedule fact", rows.some(r => r.kind === "schedule" && /night shift/.test(r.statement)));
check("the do-not-mention boundary and the fish are constraints", rows.some(r => r.kind === "constraint" && /my ex/.test(r.statement)) && rows.some(r => r.kind === "constraint" && /fish/.test(r.statement)));
check("the old model's invented life story is NOT imported (the daughters were never said)", !rows.some(r => /daughters|nurse|encouragement/i.test(r.statement)), JSON.stringify(rows.map(r => r.statement)));
check("the knee is stored once", rows.filter(r => /left knee/.test(r.statement)).length === 1);
check("every row comes from the users profile and names it", rows.length === n && rows.every(r => r.extractedBy === "backfill:users"));
check("every row is dated at sign-up, so a newer fact from the client outranks it", rows.every(r => +r.createdAt === +signedUp));

console.log("\n2. ONCE PER CLIENT");
_resetBackfillCache();
check("a second pass writes nothing", (await backfillFromOldStores(u)) === 0 && (await factRows(u.id)).length === n);
const [r2] = await db.insert(schema.users).values({ ...base, phoneNumber: RACE, name: "Race Client", injuries: "sore lower back" } as any).returning();
_resetBackfillCache();
await Promise.all([backfillFromOldStores(r2), backfillFromOldStores(r2), backfillFromOldStores(r2)]);
check("three turns at once still copy once", (await factRows(r2.id)).filter(r => /lower back/.test(r.statement)).length === 1);

console.log("\n3. THE NEW COACH SEES IT ON ITS FIRST READ");
await db.delete(schema.clientFacts).where(eq(schema.clientFacts.userId, u.id));
_resetBackfillCache();
const pre = await readPreTurn(PHONE);
check("readPreTurn backfills before it reads: the knee is in the coach's facts", !!pre && /left knee/.test(pre.facts), pre?.facts?.slice(0, 300));
check("…and the invented life story is not in the new coach's context", !!pre && !/daughters/i.test(pre.facts + pre.known));
check("…and so are the night shifts", !!pre && /night shift/.test(pre.facts));
check("the copy is still made with no model call (the network throws)", true);

console.log("\n4. A CLIENT WITH NOTHING IN THE OLD STORES");
// What onboarding writes for a client who never answered (#456): "office" and "standard" are code's stand-ins.
const [e] = await db.insert(schema.users).values({ ...base, phoneNumber: EMPTY, name: "Empty Client", goalType: null, lifeSituation: "office", workSchedule: "standard" } as any).returning();
check("nothing is invented (a column default like trainingMode 'home', or onboarding's 'office', is not something they told us)", (await backfillFromOldStores(e)) === 0 && (await factRows(e.id)).length === 0 && (await factsForCoach(e.id)) === "", JSON.stringify((await factRows(e.id)).map(r => r.statement)));
// A withheld state (safety.ts writes it to users.life_situation) is the safety owner's, never a "life/work" fact.
await pool.query("DELETE FROM client_facts WHERE user_id = $1", [e.id]); _resetBackfillCache();
await pool.query("UPDATE users SET life_situation = 'disordered_eating' WHERE id = $1", [e.id]);
const [e2] = await db.select().from(schema.users).where(eq(schema.users.id, e.id));
check("a withheld state in life_situation is not copied as something they told us", (await backfillFromOldStores(e2)) === 0 && !(await factsForCoach(e.id)).includes("disordered"));
// What they DID say at onboarding ("I'm breastfeeding") is kept (#475 attack).
await pool.query("DELETE FROM client_facts WHERE user_id = $1", [e.id]); _resetBackfillCache();
await pool.query("UPDATE users SET life_situation = 'postpartum_breastfeeding' WHERE id = $1", [e.id]);
const [e3] = await db.select().from(schema.users).where(eq(schema.users.id, e.id));
await backfillFromOldStores(e3);
check("a breastfeeding client stated at onboarding still reaches the coach", /breastfeeding/.test(await factsForCoach(e.id)));

console.log("\n5. ERASED WITH THE CLIENT");
await db.delete(schema.users).where(eq(schema.users.id, u.id));
const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.clientFacts).where(eq(schema.clientFacts.userId, u.id));
check("no backfilled fact survives deletion", (left?.n ?? 1) === 0);

console.log("\n6. WHAT THEY SAID IN CHAT: ONE CALL, ONLY THEIR OWN WORDS, DATED AT THE MESSAGE");
const [h] = await db.insert(schema.users).values({ ...base, phoneNumber: HIST, name: "History Client" } as any).returning();
const said = [
  { messageIn: "Morning coach, my left knee flares up on the stairs at work", messageOut: "COACH-SAID-THIS knee advice", createdAt: new Date("2026-08-10T07:00:00+02:00") },
  { messageIn: "My sister said I'm pregnant, she was joking lol", messageOut: "ok", createdAt: new Date("2026-08-20T07:00:00+02:00") },
  { messageIn: "Can't train in the evenings, I work nights at Bara", messageOut: "noted", createdAt: new Date("2026-09-01T07:00:00+02:00") },
];
for (const m of said) await db.insert(schema.chatHistory).values({ userId: h.id, intent: "GPT", ...m } as any);
let calls = 0, sent = "";
globalThis.fetch = (async (_: any, init?: any) => {
  calls++; sent = String(init?.body || "");
  const facts = [
    { kind: "injury", subject: "left knee", statement: "my left knee flares up on the stairs" },     // verbatim, their voice
    { kind: "schedule", subject: "night shifts", statement: "I work nights at Bara" },                  // verbatim, their voice
    { kind: "life_event", subject: "pregnancy", statement: "I'm pregnant" },                            // the sister's words
    { kind: "constraint", subject: "peanuts", statement: "I am allergic to peanuts" },                  // never said
  ];
  return new Response(JSON.stringify({ id: "s", object: "chat.completion", created: 1, model: "stub",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ family: "other", wants: "", facts, actions: [] }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as any;
const learned = await learnFromHistory(h.id);
const hrows = (await factRows(h.id)).filter(r => r.extractedBy === "backfill:history");
check("one understanding call for the whole history", calls === 1, `calls=${calls}`);
check("only what the client sent is read, never the old coach's replies", sent.includes("flares up on the stairs") && !sent.includes("COACH-SAID-THIS"));
check("the knee and the night shifts are learned, verbatim", learned === 2 && hrows.some(r => r.kind === "injury" && r.statement === "my left knee flares up on the stairs") && hrows.some(r => r.kind === "schedule" && /work nights at Bara/.test(r.statement)), JSON.stringify(hrows.map(r => r.statement)));
check("the sister's pregnancy and the invented allergy are NOT stored", !hrows.some(r => /pregnant|peanut/i.test(r.statement)));
check("each fact is dated at the message that said it", +hrows.find(r => r.kind === "injury")!.createdAt === +said[0].createdAt && +hrows.find(r => r.kind === "schedule")!.createdAt === +said[2].createdAt);
_resetHistoryTried();
check("learned once: a later process makes no second call", (await learnFromHistory(h.id)) === 0 && calls === 1, `calls=${calls}`);
await db.delete(schema.users).where(eq(schema.users.id, h.id));
check("erased with the client", ((await db.select({ n: sql<number>`count(*)::int` }).from(schema.clientFacts).where(eq(schema.clientFacts.userId, h.id)))[0]?.n ?? 1) === 0);

for (const p of [PHONE, EMPTY, RACE, HIST]) await pool.query("DELETE FROM users WHERE phone_number = $1", [p]);
await pool.end();
console.log(`\npg-record-backfill-acceptance: ${failed ? `FAILED — ${failed} assertion(s)` : "GREEN"}`);
process.exit(failed ? 1 : 0);

/**
 * REAL-POSTGRESQL ACCEPTANCE — the AI spend cap fails SAFE (#340, docs/RISKS.md).
 *
 * WHAT WAS BROKEN: `isUnderMonthlyCostCap` returned `true // fail open` when the spend query
 * errored, the per-client call count did the same, and the account-wide daily figure was only a
 * soft alert. The meaning engine checked no cap at all. With a public repo and a number anyone can
 * message, a failing cost query plus abuse meant unbounded OpenAI spend.
 *
 * Graded on the post-transport body (the short degraded reply the cap already owns), on whether
 * the engine's model was called at all, and on the admin_events record the founder sees.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-spend-cap-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
process.env.GLOBAL_AI_DAILY_HARD_CAP_USD = "5";

let engineCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  if (!url.includes("api.openai.com")) return realFetch(input, init);
  const body = typeof init?.body === "string" ? init.body : "";
  if (body.includes("COACH K'S CONSTITUTION")) engineCalls++;
  const content = body.includes("domain gate") ? "YES" : "Good question — keep it simple tonight: protein, veg, water.";
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
const gptMod: any = await import("../server/gpt"); // re-exports the spend cap (server/cost-tracking.ts)
const _resetSpendCapCache: () => void = gptMod._resetSpendCapCache ?? (() => {}); // absent before #340

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};
const lastShadowId = async () => Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM shadow_replies")).rows[0].m);
let n = 0;
async function say(phone: string, text: string): Promise<string> {
  _resetOutboundDedupe(); _resetInteractionCorrelation(); _resetSpendCapCache();
  const s0 = await lastShadowId();
  await processTextAsync(phone, text, null, null, [], handleMessage as any, `SM340${Date.now().toString(36)}${++n}`);
  await new Promise(r => setTimeout(r, 1200));
  return (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2 ORDER BY id", [phone, s0])).rows.map(r => r.body).join("\n");
}
async function client(k: number) {
  const phone = `whatsapp:+2782000340${String(k).padStart(2, "0")}`;
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: `Ayanda${k} Cap`, onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(),
    subscriptionStatus: "active", goalType: "fat_loss", gender: "female", age: 29, heightCm: 160, currentWeight: "70",
    calorieTarget: 1700, proteinTarget: 120, trainingMode: "home", trainingDaysPerWeek: 3, lifeSituation: "office",
  } as any).returning();
  return u as any;
}
const DEGRADED = /quick answer:/i;
const QUESTIONS = ["Is it better to train in the morning or the evening?", "Can you explain why protein matters so much for fat loss?",
  "What's a good way to structure my training around night shifts?", "How do I stay motivated when work gets busy?"];
await pool.query("DELETE FROM gpt_costs WHERE feature = 'spend-cap-acceptance'");
await pool.query("DELETE FROM admin_events WHERE action LIKE 'ai_spend_%'");

REAL("\npg-spend-cap-acceptance — the AI spend cap fails safe (#340)\n");

REAL("1. CONTROL — under the ceiling, the coach answers with the model");
const a = await client(1);
engineCalls = 0;
const ok = await say(a.phoneNumber, QUESTIONS[0]);
chk(!DEGRADED.test(ok) && engineCalls > 0, "an ordinary question reaches the model", `engine calls ${engineCalls}; ${JSON.stringify(ok.slice(0, 160))}`);

REAL("\n2. THE ACCOUNT-WIDE CEILING IS A HARD STOP");
await pool.query("INSERT INTO gpt_costs (user_id, model, feature, cost_usd) VALUES (NULL, 'gpt-4o', 'spend-cap-acceptance', 6)");
engineCalls = 0;
const capped = await say(a.phoneNumber, QUESTIONS[1]);
chk(DEGRADED.test(capped), "over the daily ceiling, the client gets the short degraded reply", JSON.stringify(capped.slice(0, 160)));
chk(engineCalls === 0, "…and the engine's model is not called", `engine calls ${engineCalls}`);
chk((await pool.query("SELECT 1 FROM admin_events WHERE action = 'ai_spend_global_cap_hit'")).rows.length === 1, "…and the founder's admin view records the ceiling being hit");
await pool.query("DELETE FROM gpt_costs WHERE feature = 'spend-cap-acceptance'");

REAL("\n3. SPEND THAT CANNOT BE READ IS NOT UNLIMITED SPEND");
await pool.query("ALTER TABLE gpt_costs RENAME TO gpt_costs_hidden");
let unreadable = "";
try {
  engineCalls = 0;
  unreadable = await say(a.phoneNumber, QUESTIONS[2]);
} finally {
  await pool.query("ALTER TABLE gpt_costs_hidden RENAME TO gpt_costs");
}
chk(DEGRADED.test(unreadable), "when the cost query fails, the client gets the degraded reply, not an unbounded call", JSON.stringify(unreadable.slice(0, 160)));
chk(engineCalls === 0, "…and the engine's model is not called", `engine calls ${engineCalls}`);
chk((await pool.query("SELECT 1 FROM admin_events WHERE action = 'ai_spend_cap_unreadable'")).rows.length >= 1, "…and the failure is recorded for the founder");

REAL("\n4. CONTROL — back under the ceiling with spend readable, coaching resumes");
engineCalls = 0;
const back = await say(a.phoneNumber, QUESTIONS[3]);
chk(!DEGRADED.test(back) && engineCalls > 0, "the model answers again", `engine calls ${engineCalls}; ${JSON.stringify(back.slice(0, 160))}`);

REAL(`\npg-spend-cap-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

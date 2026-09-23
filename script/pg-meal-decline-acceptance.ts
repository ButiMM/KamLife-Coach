/**
 * REAL-POSTGRESQL ACCEPTANCE — declining a suggestion deletes nothing (#264).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS PROVEN BROKEN ON 07b3b20 (main), BEFORE ANY EDIT — AUDIT.md Trace 1
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Turn 1: "I had pap and chicken for lunch" → one meal row. The coach suggests a vegetable.
 * Turn 2: "No I'm just fine with this meal".
 *
 *   food-context.ts CORRECTION_PREFIX matches the leading "No ", and hasFoodTriggerAfterPrefix
 *   matches the word "meal" — so a DECLINE is a CORRECTION. The meal logged within two minutes of
 *   the last FOOD_LOG chat row is deleted in a transaction, the day's cached totals recomputed,
 *   and the remaining words re-enter the pipeline as a new message. turn_ledger records no
 *   mutation for the deleting turn. The client's lunch is gone and nothing says so.
 *
 * A GENUINE correction ("No, I had a burger") took the same path: delete first, re-log second,
 * record nothing about the deletion. If the replacement did not log, the original was simply lost.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS GRADED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * meal_logs rows (the stored food), turn_ledger.mutations (the record of what each turn changed),
 * and shadow_replies (the final WhatsApp body, post-transport). Real clock on purpose: the delete
 * pairs a meal with its chat row by a ±2-minute window on two different clocks (the DB's now() and
 * the process clock), and a frozen clock hid the deletion during the audit.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-meal-decline-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "0";
process.env.NORMALIZER = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

// The mouth claims nothing the graders look for: no removal, no food, no numbers.
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
  // The food fallback, made deterministic for the one unfamiliar food this proof names — so the
  // replacement's write does not depend on a live model (Codex attack @ 238bd21).
  if (url.includes("api.openai.com") && body.includes('"log_food"') && /injera/i.test(body)) {
    const args = { is_food: true, coach_note: "Noted.", foods: [{ name: "Injera", kcal: 350, protein_g: 10, carbs_g: 70, fat_g: 2, portion_desc: "2 pieces", category: "carb" }] };
    return new Response(JSON.stringify({
      id: "chatcmpl-264f", object: "chat.completion", created: 1, model: "gpt-4o-mini",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "log_food", arguments: JSON.stringify(args) } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("api.openai.com")) {
    const isClassifier = body.includes("message-understanding brain");
    return new Response(JSON.stringify({
      id: "chatcmpl-264", object: "chat.completion", created: 1, model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: isClassifier ? CLASSIFY : COACH_ANSWER }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
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

const phone = "whatsapp:+27820000264";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Bonolo Decline", onboardingState: "COMPLETE", popiConsent: true,
  popiConsentAt: new Date(), subscriptionStatus: "active", goalType: "fat_loss",
  currentWeight: "78", startWeight: "82", targetWeight: "70", heightCm: 163, age: 34,
  gender: "female", trainingMode: "home", proteinTarget: 120, calorieTarget: 1800, dailyCalorieTarget: 1800,
} as any).returning();

type Meal = { id: string; raw_message: string | null; kcal_int: number; meal_label: string | null };
const meals = async (): Promise<Meal[]> => (await pool.query<Meal>(
  "SELECT id, raw_message, kcal_int, meal_label FROM meal_logs WHERE user_id = $1 ORDER BY logged_at", [user.id])).rows;
const lastShadowId = async () => Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM shadow_replies")).rows[0].m);
const ledgerIds = async (): Promise<string[]> => (await pool.query<{ id: string }>("SELECT id FROM turn_ledger WHERE user_id = $1", [user.id])).rows.map(r => r.id);
/** Every mutation note written by turns not in `seen` — outer AND nested, since a correction re-enters. */
const mutationsExcept = async (seen: string[]): Promise<string[]> => (await pool.query<{ mutations: string[] | null }>(
  "SELECT mutations FROM turn_ledger WHERE user_id = $1 AND NOT (id = ANY($2::uuid[])) ORDER BY created_at", [user.id, seen]))
  .rows.flatMap(r => (Array.isArray(r.mutations) ? r.mutations.map(String) : []));
/** The ledger row is written after the reply settles; wait for it so one turn cannot leak into the next. */
async function ledgerSettled(minRows: number) {
  for (let i = 0; i < 40 && (await ledgerIds()).length < minRows; i++) await new Promise(r => setTimeout(r, 100));
}

async function say(text: string, sid: string): Promise<{ reply: string; mutations: string[] }> {
  _resetOutboundDedupe();
  _resetInteractionCorrelation();
  const s0 = await lastShadowId();
  const l0 = await ledgerIds();
  await processTextAsync(phone, text, null, null, [], handleMessage as any, sid);
  await new Promise(r => setTimeout(r, 1500));
  await ledgerSettled(l0.length + 1);
  const reply = (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2 ORDER BY id", [phone, s0]))
    .rows.map(r => r.body).join("\n");
  return { reply, mutations: await mutationsExcept(l0) };
}
async function freshLunch(sid: string): Promise<Meal> {
  for (const t of ["meal_logs", "chat_history", "turn_ledger"]) await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [user.id]);
  await pool.query("UPDATE users SET awaiting_input_type = NULL, today_calories = 0, today_protein_g = 0 WHERE id = $1", [user.id]);
  await say("I had pap and chicken for lunch", sid);
  return (await meals())[0];
}
const claimsRemoval = (b: string) => /\b(removed|deleted|took (?:that|it) off|cleared|scrapped)\b/i.test(b);

REAL("\npg-meal-decline-acceptance — declining a suggestion deletes nothing\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("0. THE FIXTURE — turn 1 logs exactly one meal");
// ══════════════════════════════════════════════════════════════════════════════════════════════
const first = await freshLunch("SM264-0");
chk(!!first && first.kcal_int > 0, "\"I had pap and chicken for lunch\" stores one meal with calories", JSON.stringify(await meals()));

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n1. A DECLINE IS NOT A CORRECTION — the meal survives, and no turn records a change to it");
// ══════════════════════════════════════════════════════════════════════════════════════════════
const DECLINES = [
  "No I'm just fine with this meal",          // AUDIT.md Trace 1, verbatim
  "No thanks, I'm happy with my meal",
  "No I'm good with what I had",
  "No, lunch was fine as it is",
  // Codex attack @ 7f93588: a decline that REPEATS the meal names a food the scanner reads, so it
  // qualified as a correction and superseded the unchanged lunch with itself.
  "No thanks, I had enough pap and chicken",
  "No, the pap and chicken were lekker — leave it as is",
  "No thanks, I'll have a burger later",
];
for (const [i, text] of DECLINES.entries()) {
  const before = await freshLunch(`SM264-1${i}a`);
  const t = await say(text, `SM264-1${i}b`);
  const after = await meals();
  chk(after.length === 1 && after[0].id === before.id && after[0].kcal_int === before.kcal_int,
    `"${text}" leaves the logged meal exactly as it was`,
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)} mutations=${JSON.stringify(t.mutations)}`);
  chk(!t.mutations.some(n => /\b(?:DELETE|SUPERSEDE|RESTORE|DROP|CORRECT|RELABEL)\b/.test(n) || n.includes(before?.id || "~")),
    `"${text}" records no change to the meal`, `mutations=${JSON.stringify(t.mutations)}`);
  chk(!claimsRemoval(t.reply), `"${text}" is not told anything was removed`, `reply=${JSON.stringify(t.reply)}`);
  if (i === 0) REAL(`        final body: ${JSON.stringify(t.reply)}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. A GENUINE CORRECTION SUPERSEDES — the replacement lands, and the record says what it replaced");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const before = await freshLunch("SM264-2a");
  const t = await say("No, I had a burger", "SM264-2b");
  const after = await meals();
  chk(!after.some(r => r.id === before.id), "the mis-logged meal no longer counts toward the day", JSON.stringify(after));
  chk(after.length === 1 && /burger/i.test(JSON.stringify(after[0])), "the named replacement is the meal on record", JSON.stringify(after));
  chk(t.mutations.some(n => /\bSUPERSEDE\b/.test(n) && n.includes(before.id) && n.includes(String(before.kcal_int))),
    "the correcting turn records WHICH meal it replaced, with what it held", `mutations=${JSON.stringify(t.mutations)}`);
  const cached = Number((await pool.query("SELECT today_calories FROM users WHERE id = $1", [user.id])).rows[0].today_calories);
  const held = after.reduce((n, r) => n + r.kcal_int, 0);
  chk(cached === held, "the cached day total is the replacement's, not the superseded meal's", `today_calories=${cached} meals=${held}`);
}

{
  // Codex attack @ 238bd21: a correction to a food the SA scanner does not know. Requiring a
  // scanner-named food made this an APPEND — injera logged beside the pap it replaced.
  const before = await freshLunch("SM264-2c");
  const t = await say("No, I had injera instead", "SM264-2d");
  const after = await meals();
  chk(after.length === 1 && !after.some(r => r.id === before.id) && /injera/i.test(JSON.stringify(after)),
    "a correction to a food the scanner does not know replaces the lunch rather than joining it", JSON.stringify(after));
  chk(t.mutations.some(n => /\bSUPERSEDE\b/.test(n) && n.includes(before.id)), "and the replacement is recorded", `mutations=${JSON.stringify(t.mutations)}`);
}

{
  // Codex review @ 238bd21: striking one food out of the logged plate is a correction, even though
  // what remains was already on it.
  // Itemised (not a combo), so what remains really is a subset of what was logged.
  for (const tb of ["meal_logs", "chat_history", "turn_ledger"]) await pool.query(`DELETE FROM ${tb} WHERE user_id = $1`, [user.id]);
  await say("I had rice and chicken breast for lunch", "SM264-2e");
  const before = (await meals())[0];
  const t = await say("No, I had chicken breast, not rice", "SM264-2f");
  const after = await meals();
  chk(!!before && after.length === 1 && !after.some(r => r.id === before.id) && !/\brice\b/i.test(JSON.stringify(after.map(r => r.raw_message))),
    "\"No, I had chicken breast, not rice\" leaves one meal, and no rice in it", `before=${JSON.stringify(before)} after=${JSON.stringify(after)} mutations=${JSON.stringify(t.mutations)}`);
}
{
  // Codex review @ 7f93588: the replacement can land as an IN-PLACE amend of an earlier meal from
  // the last half hour (amendRecentMeal), not a new row. That is a landing; restoring the wrong meal
  // on top of it would leave both.
  for (const tb of ["meal_logs", "chat_history", "turn_ledger"]) await pool.query(`DELETE FROM ${tb} WHERE user_id = $1`, [user.id]);
  await say("I had chicken breast and rice", "SM264-2g");
  const earlier = (await meals())[0];
  await say("I had pap and beef stew", "SM264-2h");
  const wrong = (await meals()).find(r => r.id !== earlier?.id)!;
  const t = await say("No, I had chicken breast, rice and avocado", "SM264-2i");
  const after = await meals();
  chk(!!earlier && !!wrong && !after.some(r => r.id === wrong.id),
    "a replacement written as an amend of an earlier meal still supersedes the wrong one", `after=${JSON.stringify(after)} mutations=${JSON.stringify(t.mutations)}`);
  chk(t.mutations.some(n => /\bSUPERSEDE\b/.test(n) && n.includes(wrong?.id || "~")), "and it is recorded as a supersede, not a restore",
    `mutations=${JSON.stringify(t.mutations)}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. CONTROL — a slot correction relabels, keeps the calories, and says so in the record");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const before = await freshLunch("SM264-3a");
  const t = await say("Actually it was dinner", "SM264-3b");
  const after = await meals();
  chk(after.length === 1 && after[0].id === before.id && after[0].kcal_int === before.kcal_int && after[0].meal_label === "dinner",
    "\"Actually it was dinner\" moves the same meal to dinner with its calories intact", JSON.stringify(after));
  chk(t.mutations.some(n => /\bRELABEL\b/.test(n) && n.includes(before.id)), "the relabel is recorded", `mutations=${JSON.stringify(t.mutations)}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. A \"CORRECTION\" THAT LOGS NOTHING PUTS THE MEAL BACK — the snapshot is never lost");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  // Qualifies as a correction (a leading "No" and a food the scanner reads), but it is a
  // question, so the re-entered turn writes no meal. Before: the lunch was deleted first and
  // stayed deleted.
  const before = await freshLunch("SM264-4a");
  const t = await say("No, should I have had a burger instead?", "SM264-4b");
  const after = await meals();
  chk(after.length === 1 && after[0].id === before.id && after[0].kcal_int === before.kcal_int,
    "the original meal is back, unchanged", `before=${JSON.stringify(before)} after=${JSON.stringify(after)} mutations=${JSON.stringify(t.mutations)}`);
  const cached = (await pool.query("SELECT today_calories FROM users WHERE id = $1", [user.id])).rows[0].today_calories;
  chk(Number(cached) === before.kcal_int, "the cached day total matches the meal on record", `today_calories=${cached} meal=${before.kcal_int}`);
  chk(!t.mutations.some(n => /\bSUPERSEDE\b/.test(n)), "no supersede is recorded for a replacement that never landed", `mutations=${JSON.stringify(t.mutations)}`);
}

await pool.end().catch(() => {});
REAL(`\npg-meal-decline-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}`);
process.exit(failed === 0 ? 0 : 1);

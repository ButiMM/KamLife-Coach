/**
 * C16: a named dinner question reaches the existing ledger-aware plate menu.
 * Grade the post-transport body, not a handler return or the model's fixture prose.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-c16-plate-acceptance: SKIPPED — no DATABASE_URL. This proof needs real PostgreSQL.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "0";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "on";
process.env.PROACTIVE_PAUSED = "true";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

// Deliberately wrong for the maintenance turn: a model fallback must not make that assertion pass.
const COACH_ANSWER = "Tell me what you ate today — one line is enough.";
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
      id: "chatcmpl-c16", object: "chat.completion", created: 1, model: "gpt-4o-mini",
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
const chk = (ok: boolean, claim: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${claim}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};
const PRODUCT_PLATE = /2 chicken thighs \+ rice \+ mixed veg|Chicken breast \+ rice \+ spinach|Tin of pilchards \+ pap|Tofu stir-fry \+ rice|Lentil and chickpea curry \+ rice/i;
const RE_LOG = /\b(?:tell|send|log|share)\b[^.!?\n]{0,45}\b(?:what you ate|what you had|your (?:meals?|food)|food today)\b|\bwhat did you eat\b/i;
const MAINTENANCE_ANSWER = /maintenance calories.{0,100}(?:weight|steady)/i;
const asksToRelog = (body: string) => RE_LOG.test(body);

// Validate the grader before using it. The model fixture cannot answer maintenance or supply a plate.
chk(PRODUCT_PLATE.test("Start with: Chicken breast + rice + spinach (~450 kcal, 35g protein)"), "plate detector sees a cookable dinner menu item");
chk(!PRODUCT_PLATE.test("Got it — Pear. Make your next meal a proper protein meal.") && !PRODUCT_PLATE.test(COACH_ANSWER),
  "plate detector rejects a generic staple and the model fixture");
chk(asksToRelog("Tell me what you ate today — one line is enough.") && !asksToRelog("A pear is logged for today."),
  "re-log detector both fires and declines");
chk(!MAINTENANCE_ANSWER.test(COACH_ANSWER) && asksToRelog(COACH_ANSWER),
  "the model fixture cannot satisfy the maintenance answer or no-log-demand assertions");

const RealDate = Date;
const fixed = RealDate.UTC(2026, 8, 18, 11, 30, 0); // 13:30 SAST
class FrozenDate extends RealDate {
  constructor(...args: any[]) { super(...(args.length === 0 ? [fixed] : args) as [any]); }
  static now() { return fixed; }
}
const dayOf = (instant: Date | string) => new RealDate(new RealDate(instant).getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
const phone = "whatsapp:+27820000986";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Thandi Plate", onboardingState: "COMPLETE", popiConsent: true,
  popiConsentAt: new RealDate(), subscriptionStatus: "active", goalType: "fat_loss",
  currentWeight: "88", startWeight: "92", targetWeight: "80", heightCm: 165, age: 31,
  gender: "female", trainingMode: "gym", proteinTarget: 130, calorieTarget: 1900,
  dailyCalorieTarget: 1900, dailyStepTarget: 8000, stepsTarget: 8000,
} as any).returning();

async function clear() {
  for (const table of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_history", "turn_ledger", "daily_constraints"]) {
    await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [user.id]);
  }
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  await pool.query("UPDATE users SET profile_notes = NULL, awaiting_input_type = NULL WHERE id = $1", [user.id]);
  _resetOutboundDedupe();
  _resetInteractionCorrelation();
}
async function turn(message: string, id: string) {
  await clear();
  (globalThis as any).Date = FrozenDate;
  try {
    await processTextAsync(phone, message, null, null, [], handleMessage as any, `sid-c16-${id}`);
    await new Promise(r => setTimeout(r, 1500));
  } finally { (globalThis as any).Date = RealDate; }
  const meals = (await pool.query<{ raw_message: string | null; logged_at: Date; meal_label: string | null }>(
    "SELECT raw_message, logged_at, meal_label FROM meal_logs WHERE user_id = $1 ORDER BY logged_at", [user.id])).rows;
  const body = (await pool.query<{ body: string }>(
    "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body).join("\n");
  return { meals, body };
}

REAL("\npg-c16-plate-acceptance — a named meal receives a cookable plate\n");
const pure = await turn("What should I have for dinner tonight?", "pure");
chk(pure.meals.length === 0, "asking about dinner does not write a meal", JSON.stringify(pure.meals));
chk(PRODUCT_PLATE.test(pure.body), "the pure dinner ask receives a product-menu plate", JSON.stringify(pure.body.slice(0, 300)));

const pear = await turn("I had a pear. What should I have for dinner tonight?", "pear");
chk(pear.meals.length === 1 && /pear/i.test(pear.meals[0].raw_message || "") && dayOf(pear.meals[0].logged_at) === "2026-09-18" && pear.meals[0].meal_label !== "dinner",
  "the pear is stored today, without borrowing dinner's slot", JSON.stringify(pear.meals));
chk(PRODUCT_PLATE.test(pear.body), "the pear-and-dinner turn receives a product-menu plate", JSON.stringify(pear.body.slice(0, 350)));
chk(!asksToRelog(pear.body), "the pear is not requested again", JSON.stringify(pear.body.slice(0, 350)));

const maintenance = await turn("What do maintenance calories mean?", "maintenance");
chk(maintenance.meals.length === 0, "the maintenance question does not write a meal");
chk(MAINTENANCE_ANSWER.test(maintenance.body),
  "the maintenance question is answered", JSON.stringify(maintenance.body.slice(0, 350)));
chk(!asksToRelog(maintenance.body), "the maintenance answer makes no food-log demand", JSON.stringify(maintenance.body.slice(0, 350)));

const future = await turn("What should I have for dinner tomorrow?", "future");
chk(future.meals.length === 0 && !PRODUCT_PLATE.test(future.body),
  "a future dinner is not priced against today's plate menu", JSON.stringify(future.body.slice(0, 350)));
const reflection = await turn("What should I have done differently last week?", "reflection");
chk(reflection.meals.length === 0 && !PRODUCT_PLATE.test(reflection.body),
  "a non-food 'have done' question is not claimed by the plate menu", JSON.stringify(reflection.body.slice(0, 350)));

REAL(`\npg-c16-plate-acceptance: ${failed === 0 ? "GREEN" : `${failed} FAILED`}\n`);
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

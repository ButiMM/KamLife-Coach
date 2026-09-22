/** C18: a saved budget changes the one food move that reaches the client. */
if (!process.env.DATABASE_URL) {
  console.log("pg-c18-budget-memory-acceptance: SKIPPED — real PostgreSQL required");
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

// Deliberately not a food move: a model fallback cannot manufacture the expected answer.
const COACH_FIXTURE = "Tell me what you ate today — one line is enough.";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  const body = typeof init?.body === "string" ? init.body : "";
  if (url.includes("api.openai.com") && url.includes("/embeddings")) {
    return new Response(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: Array(1536).fill(0) }], model: "text-embedding-3-small", usage: { prompt_tokens: 1, total_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("api.openai.com")) {
    return new Response(JSON.stringify({
      id: "chatcmpl-c18", object: "chat.completion", created: 1, model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: body.includes("message-understanding brain")
        ? `{"intent":"OTHER","confidence":0.85,"canonical":""}` : COACH_FIXTURE }, finish_reason: "stop" }],
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
const { buildDayState, oneActionCommand } = await import("../server/handlers/one-action-command");
const { canonicalDecision } = await import("../server/understanding/live");

let failed = 0;
const chk = (ok: boolean, claim: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${claim}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};
const affordable = /get protein into your next meal.{0,60}(?:eggs|pilchards|sugar beans)/i;
const generic = /make your next meal a proper protein meal/i;
chk(!affordable.test(COACH_FIXTURE) && !generic.test(COACH_FIXTURE),
  "the model fixture cannot satisfy either food-move detector");
chk(affordable.test("Get protein into your next meal — sugar beans."),
  "the affordable detector sees a cookable move");
chk(!affordable.test("Protein matters."), "the affordable detector rejects generic advice");

const RealDate = Date;
const fixed = RealDate.UTC(2026, 8, 18, 16, 30, 0); // 18:30 SAST
class FrozenDate extends RealDate {
  constructor(...args: any[]) { super(...(args.length === 0 ? [fixed] : args) as [any]); }
  static now() { return fixed; }
}
const phone = "whatsapp:+27820000989";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [created] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Thandi Memory", onboardingState: "COMPLETE", popiConsent: true,
  popiConsentAt: new RealDate(), subscriptionStatus: "active", goalType: "fat_loss",
  currentWeight: "88", startWeight: "92", targetWeight: "80", heightCm: 165, age: 31,
  gender: "female", trainingMode: "home", proteinTarget: 130, calorieTarget: 1900,
  dailyCalorieTarget: 1900, dailyStepTarget: 8000, stepsTarget: 8000,
} as any).returning();

async function seed(budget: string, diet: string | null) {
  for (const table of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_history", "turn_ledger", "daily_constraints"]) {
    await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [created.id]);
  }
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  await pool.query("UPDATE users SET weekly_food_budget = $2, dietary_restrictions = $3, biggest_struggle = NULL, profile_notes = NULL, awaiting_input_type = NULL, created_at = $4 WHERE id = $1",
    [created.id, budget, diet, new RealDate(fixed - 28 * 86_400_000)]);
  const dayStart = RealDate.UTC(2026, 8, 17, 22, 0, 0); // Sep 18 00:00 SAST
  for (const daysAgo of [0, 1, 2, 3]) {
    await pool.query(`INSERT INTO meal_logs (user_id, raw_message, source, kcal_int, protein_int, meal_label, logged_at)
      VALUES ($1,$2,'text',600,20,'lunch',$3)`,
      [created.id, `pap and beans ${daysAgo}`, new RealDate(dayStart - daysAgo * 86_400_000 + 11 * 3_600_000)]);
  }
  await pool.query("INSERT INTO weight_logs (user_id, weight, logged_at) VALUES ($1,'88',$2)",
    [created.id, new RealDate(dayStart + 7 * 3_600_000)]);
  _resetOutboundDedupe();
  _resetInteractionCorrelation();
  const [user] = await db.select().from(schema.users).where((await import("drizzle-orm")).eq(schema.users.id, created.id));
  const rows = (await pool.query<{ n: number }>("SELECT COUNT(DISTINCT DATE(logged_at + INTERVAL '2 hours'))::int AS n FROM meal_logs WHERE user_id = $1", [created.id])).rows[0]?.n;
  chk(rows === 4 && user.weeklyFoodBudget === budget && user.dietaryRestrictions === diet,
    "the durable four-day food history and onboarding constraints exist before the turn",
    JSON.stringify({ rows, budget: user.weeklyFoodBudget, diet: user.dietaryRestrictions }));
  return user;
}

async function turn(budget: string, diet: string | null, id: string) {
  const user = await seed(budget, diet);
  (globalThis as any).Date = FrozenDate;
  try {
    const context = await buildDayState(user);
    const action = await oneActionCommand(user, { atKeyboard: true, asksAboutToday: true });
    await processTextAsync(phone, "What should I do today?", null, null, [], handleMessage as any, `sid-c18-${id}`);
    await new Promise(r => setTimeout(r, 1500));
    const body = (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body).join("\n");
    const canonical = await canonicalDecision(user, "I'm struggling", { bidForCoaching: true });
    return { context, action, body, canonical };
  } finally { (globalThis as any).Date = RealDate; }
}

REAL("\npg-c18-budget-memory-acceptance — stored budget changes the delivered move\n");
const low = await turn("under_100", null, "low");
chk(low.context.weeklyFoodBudget === "under_100" && low.context.loggedToday && low.context.proteinPct < 0.6,
  "the one-action owner reads budget and today's low protein", JSON.stringify(low.context));
chk(affordable.test(low.action) && affordable.test(low.body),
  "the affordable canonical move survives into the final body", JSON.stringify({ action: low.action, body: low.body }));
chk(low.canonical.kind === "protein" && affordable.test(low.canonical.reply),
  "the live canonical close reads the same saved budget", JSON.stringify(low.canonical));

const high = await turn("over_600", null, "high");
chk(high.context.weeklyFoodBudget === "over_600" && generic.test(high.action) && generic.test(high.body),
  "the unrestricted client receives the ordinary protein move", JSON.stringify({ action: high.action, body: high.body }));
chk(high.canonical.kind === "protein" && generic.test(high.canonical.reply),
  "the unrestricted live canonical close retains the ordinary move", JSON.stringify(high.canonical));
chk(low.body !== high.body, "budget changes the actual delivered instruction");

const vegan = await turn("under_100", "vegan", "vegan");
chk(affordable.test(vegan.body) && /sugar beans/i.test(vegan.body) && !/\b(?:eggs|pilchards)\b/i.test(vegan.body),
  "the affordable move respects the vegan restriction", JSON.stringify(vegan.body));

REAL(`\npg-c18-budget-memory-acceptance: ${failed === 0 ? "GREEN" : `${failed} FAILED`}\n`);
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

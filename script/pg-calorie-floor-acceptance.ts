/**
 * REAL-POSTGRESQL ACCEPTANCE — one calorie floor, and no writer below it (#268).
 *
 * WHAT WAS BROKEN (AUDIT.md P2, "Five different calorie floors"): the weigh-in auto-adjust in
 * server/handlers/weight.ts took up to 150 kcal off a freshly computed target and clamped at a
 * sex-blind 1200. A small man on fat loss, floored at 1500 by the profile maths, who gained a
 * little over a fortnight was set to 1350 and told so. The diet-break restore wrote back whatever
 * pre-break number it held, including one an old writer had put under the floor.
 *
 * Graded on users.calorie_target (what every later surface reads) and the post-transport
 * WhatsApp body (what the client was told).
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-calorie-floor-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.PROACTIVE_PAUSED = "false";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { processTextAsync } = await import("../server/routes/whatsapp");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");
const { _resetInteractionCorrelation } = await import("../server/handlers/chat-log");
const { runDietBreakCheck } = await import("../server/scheduler/jobs/monday");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};
const DAY = 86_400_000;
const target = async (id: string) => Number((await pool.query("SELECT calorie_target c FROM users WHERE id = $1", [id])).rows[0].c);
const lastShadowId = async () => Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM shadow_replies")).rows[0].m);
async function say(phone: string, text: string, sid: string): Promise<string> {
  _resetOutboundDedupe(); _resetInteractionCorrelation();
  const s0 = await lastShadowId();
  await processTextAsync(phone, text, null, null, [], handleMessage as any, sid);
  await new Promise(r => setTimeout(r, 1500));
  return (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2 ORDER BY id", [phone, s0])).rows.map(r => r.body).join("\n");
}
async function client(n: number, over: Record<string, unknown>) {
  const phone = `whatsapp:+2782000268${n}`;
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: `Sipho${n} Floor`, onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(),
    subscriptionStatus: "active", goalType: "fat_loss", trainingMode: "home", trainingDaysPerWeek: 0,
    lifeSituation: "office", trainingExperience: "beginner", ...over,
  } as any).returning();
  return u as any;
}

REAL("\npg-calorie-floor-acceptance — one calorie floor, and no writer below it (#268)\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("1. THE WEIGH-IN AUTO-ADJUST — a small man gaining on fat loss");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const u = await client(1, { gender: "male", age: 55, heightCm: 155, currentWeight: "50.6", startWeight: "50", calorieTarget: 1500, proteinTarget: 100 });
  // Five weigh-ins across two weeks, drifting up: enough readings and span for the auto-adjust to act.
  for (const [daysAgo, kg] of [[14, "50.0"], [11, "50.2"], [8, "50.3"], [5, "50.5"], [2, "50.6"]] as const) {
    await pool.query("INSERT INTO weight_logs (user_id, weight, logged_at) VALUES ($1,$2,$3)", [u.id, kg, new Date(Date.now() - daysAgo * DAY)]);
  }
  const body = await say(u.phoneNumber, "50.8kg this morning", "SM268a");
  const stored = await target(u.id);
  REAL(`        stored calorie_target: ${stored}`);
  REAL(`        final body: ${JSON.stringify(body.slice(0, 260))}`);
  chk(stored >= 1500, "the stored target is not under the male floor", `calorie_target=${stored}`);
  chk(!/\b1[23]\d\d\s*kcal/i.test(body), "the client is not told a target under the male floor", JSON.stringify(body));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. THE DIET-BREAK RESTORE — a pre-break number an old writer put under the floor");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const u = await client(2, { gender: "male", age: 40, heightCm: 170, currentWeight: "70", calorieTarget: 1650, proteinTarget: 140,
    dietBreakEndsAt: new Date(Date.now() - DAY), dietBreakCalTarget: 1350 });
  await runDietBreakCheck();
  const stored = await target(u.id);
  const body = (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [u.phoneNumber])).rows.map(r => r.body).join("\n");
  REAL(`        stored calorie_target: ${stored}`);
  chk(stored >= 1500, "the restored target is not under the male floor", `calorie_target=${stored}`);
  chk(!/\b1350\s*kcal/.test(body), "the restore message does not quote the under-floor number", JSON.stringify(body.slice(0, 200)));

  const w = await client(3, { gender: "female", age: 40, heightCm: 160, currentWeight: "62", calorieTarget: 1800, proteinTarget: 110,
    dietBreakEndsAt: new Date(Date.now() - DAY), dietBreakCalTarget: 1550 });
  await runDietBreakCheck();
  chk(await target(w.id) === 1550, "CONTROL — a pre-break target above the floor is restored exactly", String(await target(w.id)));
}

REAL(`\npg-calorie-floor-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

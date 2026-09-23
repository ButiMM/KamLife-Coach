/** C18: an active durable health hold blocks training progression in the final reply. */
if (!process.env.DATABASE_URL) {
  console.log("pg-c18-health-hold-acceptance: SKIPPED — real PostgreSQL required");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const RealDate = Date;
const fixed = RealDate.UTC(2026, 8, 18, 8); // Friday 10:00 SAST, scheduled training day
class FrozenDate extends RealDate {
  constructor(...args: any[]) { super(...(args.length ? args : [fixed]) as [any]); }
  static now() { return fixed; }
}
(globalThis as any).Date = FrozenDate;
const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};
const { db, pool } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { processTextAsync } = await import("../server/routes/whatsapp");
const { readHealthState } = await import("../server/health-state");
const { buildDayState, oneActionCommand } = await import("../server/handlers/one-action-command");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");

let failed = 0;
const chk = (ok: boolean, claim: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${claim}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};
const phone = "whatsapp:+27919000581";
const [u] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Thandi Rest", onboardingState: "COMPLETE",
  subscriptionStatus: "active", popiConsent: true,
  popiConsentAt: new RealDate(fixed - 30 * 86_400_000), goalType: "fat_loss",
  currentWeight: "87", heightCm: 168, age: 33, gender: "female",
  trainingMode: "gym", trainingDaysPerWeek: 3, programmeWeek: 3,
  calorieTarget: 1900, proteinTarget: 130, stepsTarget: 8000,
  profileNotes: "sick_since:2026-09-17 sick_until:2026-09-22",
} as any).returning();
const health = readHealthState(u);
const day = await buildDayState(u);
const action = await oneActionCommand(u, { atKeyboard: true, asksAboutToday: true });
chk(health.isSick && day.sick === true,
  "the durable health window reaches the one-action day state", JSON.stringify({ health, day }));
chk(/Rest today\. No training, no targets/i.test(action),
  "the canonical decision is rest, not progression", action);
_resetOutboundDedupe();
await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
await processTextAsync(phone, "What should I do today?", null, null, [], handleMessage as any,
  "sid-c18-health-hold");
const body = (await pool.query<{ body: string }>(
  "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body).join("\n");
chk(/Rest today\. No training, no targets/i.test(body)
    && !/Get today'?s session done|Do today'?s session/i.test(body),
  "the health hold survives the final transport body without a training demand", body);

REAL(`\npg-c18-health-hold-acceptance: ${failed ? `${failed} FAILED` : "GREEN"}\n`);
await pool.query("DELETE FROM users WHERE id = $1", [u.id]);
await pool.end();
(globalThis as any).Date = RealDate;
process.exit(failed ? 1 : 0);

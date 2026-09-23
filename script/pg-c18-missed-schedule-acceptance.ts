/** C18: a missed Monday/Friday does not become a backlog on the next scheduled day. */
if (!process.env.DATABASE_URL) {
  console.log("pg-c18-missed-schedule-acceptance: SKIPPED — real PostgreSQL required");
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
const fixed = RealDate.UTC(2026, 8, 16, 12); // Wednesday 14:00 SAST
const lastSession = new RealDate(RealDate.UTC(2026, 8, 7, 8)); // prior Monday 10:00 SAST
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
const { getTodayWorkoutState, getTodaySlot } = await import("../server/workout-state");
const { renderSession } = await import("../server/programme");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");

let failed = 0;
const chk = (ok: boolean, claim: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${claim}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};
const phone = "whatsapp:+27919000381";
const [u] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Thabo Shift", onboardingState: "COMPLETE",
  subscriptionStatus: "active", popiConsent: true, popiConsentAt: lastSession,
  goalType: "fat_loss", currentWeight: "84", heightCm: 178, age: 35, gender: "male",
  trainingMode: "gym", trainingExperience: "beginner", injuries: "none",
  trainingDaysPerWeek: 3, programmeWeek: 2, programmeDayInWeek: 1,
  lastWorkoutDate: lastSession, totalWorkoutsCompleted: 1,
  calorieTarget: 2000, proteinTarget: 140, stepsTarget: 8000,
} as any).returning();
await pool.query("INSERT INTO workout_logs (user_id, logged_at, workout_completed) VALUES ($1,$2,true)", [u.id, lastSession]);
const state = await getTodayWorkoutState(u);
const slot = getTodaySlot(u);
chk(state.type === "MISSED" && state.missedCount >= 2 && slot === 2,
  "the real workout row and SAST schedule reconstruct a missed Wednesday/Friday/Monday, next slot 2",
  JSON.stringify({ state, slot }));
const canonical = renderSession(u, { slot, intro: "Today's scheduled session is next when you're ready.\n\n",
  doneHint: "Send *done* when finished." });
chk(/Full Body B|Session.*overall/i.test(canonical),
  "the canonical session owner renders today's slot rather than a backlog", canonical.slice(0, 170));

_resetOutboundDedupe();
await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
await processTextAsync(phone, "workout", null, null, [], handleMessage as any, "sid-c18-missed-schedule");
const body = (await pool.query<{ body: string }>(
  "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body).join("\n");
chk(body.length > 0 && /Today's scheduled session is next when you're ready/i.test(body),
  "the realistic next-slot move survives the final transport body", body.slice(0, 250));
chk(!/back on track|today is the reset|catch.?up|double back|make.?up|do it now/i.test(body),
  "the delivered answer contains no debt, reset or catch-up language", body.slice(0, 300));
chk(/Full Body B|Session.*overall/i.test(body),
  "the delivered workout uses the same scheduled slot as the canonical owner", body.slice(0, 300));
chk((await pool.query<{ n: number }>(
  "SELECT COUNT(*)::int AS n FROM workout_logs WHERE user_id = $1", [u.id])).rows[0]?.n === 1,
  "a missed session does not manufacture completed workout rows");

REAL(`\npg-c18-missed-schedule-acceptance: ${failed ? `${failed} FAILED` : "GREEN"}\n`);
await pool.query("DELETE FROM users WHERE id = $1", [u.id]);
await pool.end();
(globalThis as any).Date = RealDate;
process.exit(failed ? 1 : 0);

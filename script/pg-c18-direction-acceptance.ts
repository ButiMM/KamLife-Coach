/** C18: an overall direction ask uses today's measured facts and one canonical next move. */
if (!process.env.DATABASE_URL) {
  console.log("pg-c18-direction-acceptance: SKIPPED — real PostgreSQL required");
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
const fixed = RealDate.UTC(2026, 8, 19, 11); // Saturday 13:00 SAST, a scheduled rest day
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
const { getProgressTruth, sessionsThisCalendarWeek } = await import("../server/day-ledger");
const { getTodayWorkoutState } = await import("../server/workout-state");
const { oneActionCommand } = await import("../server/handlers/one-action-command");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");

let failed = 0;
const chk = (ok: boolean, claim: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${claim}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};
const phone = "whatsapp:+27919000481";
const [u] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Thandi Direction", onboardingState: "COMPLETE",
  subscriptionStatus: "active", popiConsent: true, popiConsentAt: new RealDate(fixed - 30 * 86_400_000),
  goalType: "fat_loss", currentWeight: "87", heightCm: 168, age: 33, gender: "female",
  trainingMode: "home", trainingDaysPerWeek: 3, weeklyFoodBudget: "under_100",
  baselineCalorieTarget: 1900, calorieTarget: 1900, proteinTarget: 130, stepsTarget: 8000,
} as any).returning();
for (const d of [3, 2, 1, 0]) {
  const at = new RealDate(fixed - d * 86_400_000 - 2 * 3_600_000);
  await pool.query(`INSERT INTO meal_logs
    (user_id, raw_message, source, kcal_int, protein_int, meal_label, logged_at)
    VALUES ($1,'pap and sugar beans','text',500,35,'lunch',$2)`, [u.id, at]);
}
await pool.query(`INSERT INTO step_logs (user_id, steps, logged_at, provenance, resolved_day)
  VALUES ($1,6100,$2,'client_report','2026-09-19')`, [u.id, new RealDate(fixed - 3_600_000)]);
for (const d of [20, 10, 0]) {
  await pool.query("INSERT INTO weight_logs (user_id, weight, logged_at) VALUES ($1,$2,$3)",
    [u.id, d === 0 ? "87" : "88", new RealDate(fixed - d * 86_400_000)]);
}
for (const d of [5, 3]) {
  await pool.query("INSERT INTO workout_logs (user_id, logged_at, workout_completed) VALUES ($1,$2,true)",
    [u.id, new RealDate(fixed - d * 86_400_000)]);
}
const truth = await getProgressTruth(u, { days: 7, clientMessage: "Give me direction for today" });
const sessions = await sessionsThisCalendarWeek(u.id);
const workout = await getTodayWorkoutState(u);
const action = await oneActionCommand(u, { atKeyboard: true, asksAboutToday: true });
chk(truth.today.meals.length === 1 && truth.today.protein === 35 && truth.today.steps === 6100
    && sessions === 2 && workout.type === "REST", "real rows reconstruct food, steps, workouts and rest-day context",
  JSON.stringify({ today: truth.today, sessions, workout }));
chk(/Get protein into your next meal/i.test(action),
  "the gated one-action owner chooses the affordable next move from saved budget", action);

_resetOutboundDedupe();
await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
await processTextAsync(phone, "Give me direction for today", null, null, [], handleMessage as any,
  "sid-c18-direction");
const body = (await pool.query<{ body: string }>(
  "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body).join("\n");
chk(/pap and sugar beans/i.test(body) && /35g of 130g/.test(body) && /6,100 of 8,000/.test(body),
  "the final body uses the actual food/protein and steps, not generic targets", body.slice(0, 450));
chk(/rest day/i.test(body) && /scale trend/i.test(body),
  "the final body includes the schedule and weight-evidence state", body.slice(0, 450));
chk(/Get protein into your next meal/i.test(body) && !/log every meal/i.test(body),
  "one affordable next move survives transport without restarting intake", body.slice(-260));

REAL(`\npg-c18-direction-acceptance: ${failed ? `${failed} FAILED` : "GREEN"}\n`);
await pool.query("DELETE FROM users WHERE id = $1", [u.id]);
await pool.end();
(globalThis as any).Date = RealDate;
process.exit(failed ? 1 : 0);

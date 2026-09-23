/** C18: real seven-day evidence reaches the adaptive job and leaves an auditable change/hold. */
if (!process.env.DATABASE_URL) {
  console.log("pg-c18-adaptive-review-acceptance: SKIPPED — real PostgreSQL required");
  process.exit(0);
}
process.env.PROACTIVE_PAUSED = "false";
process.env.NODE_ENV = "production";

const RealDate = Date;
const fixed = RealDate.UTC(2026, 8, 18, 16, 30); // 18:30 SAST, Sep 18
class FrozenDate extends RealDate {
  constructor(...args: any[]) { super(...(args.length ? args : [fixed]) as [any]); }
  static now() { return fixed; }
}
(globalThis as any).Date = FrozenDate;

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};
const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { eq } = await import("drizzle-orm");
const { loadProactiveState } = await import("../server/scheduler/shared");
const { runAdaptiveTargets } = await import("../server/scheduler/jobs/adaptive");

let failed = 0;
const chk = (ok: boolean, claim: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${claim}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};
const ids: string[] = [];
const at = (daysAgo: number) => new RealDate(fixed - daysAgo * 86_400_000);
async function seed(name: string, mealDays: number[], avgKcal: number) {
  const [u] = await db.insert(schema.users).values({
    phoneNumber: `whatsapp:+2791900${name === "Change" ? "0181" : name === "Thin" ? "0182" : "0183"}`,
    name: `${name} Review`, onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: at(30), goalType: "fat_loss", currentWeight: "88",
    heightCm: 170, age: 34, gender: "female", trainingMode: "home",
    baselineCalorieTarget: 2000, baselineProteinTarget: 130, baselineStepsTarget: 8000,
    calorieTarget: 2000, proteinTarget: 130, stepsTarget: 8000,
  } as any).returning();
  ids.push(u.id);
  for (const d of [25, 18, 11, 4, 0]) {
    await pool.query("INSERT INTO weight_logs (user_id, weight, logged_at) VALUES ($1,'88',$2)", [u.id, at(d)]);
  }
  for (const d of mealDays) {
    await pool.query(`INSERT INTO meal_logs
      (user_id, raw_message, source, kcal_int, protein_int, meal_label, logged_at)
      VALUES ($1,$2,'text',$3,110,'lunch',$4)`, [u.id, `${name} recorded lunch ${d}`, avgKcal, at(d)]);
  }
  const state = await loadProactiveState(u);
  chk(state.weight.stalledWeeks >= 3 && state.food.loggedDays7d === mealDays.length,
    `${name}: real rows reconstruct a three-week plateau and ${mealDays.length} SAST food days`,
    JSON.stringify({ stalledWeeks: state.weight.stalledWeeks, food: state.food }));
  return u;
}

REAL("\npg-c18-adaptive-review-acceptance — canonical rows → adaptive decision → durable audit\n");
const changed = await seed("Change", [0, 1, 2, 3, 4], 1980);
const thin = await seed("Thin", [0, 1], 1500);
const under = await seed("Under", [0, 1, 2, 3, 4], 1500);
await runAdaptiveTargets();
for (const [u, expected, reason] of [
  [changed, "CHANGE", "stalled"],
  [thin, "HOLD", "stalled_unlogged"],
  [under, "HOLD", "stalled_under_target"],
] as const) {
  const reviews = await db.select().from(schema.adaptiveTargetReviews)
    .where(eq(schema.adaptiveTargetReviews.userId, u.id));
  const [after] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
  const r = reviews[0];
  const prior = r?.priorTargets as any;
  const next = r?.nextTargets as any;
  const evidence = r?.evidence as any;
  chk(reviews.length === 1 && r?.decisionDay === "2026-09-18" && r?.state === expected && r?.reason === reason,
    `${u.name}: one SAST-day ${expected} review with its canonical reason`, JSON.stringify(reviews));
  chk(prior?.calories === 2000 && (expected === "CHANGE"
    ? next?.calories < prior.calories && Number(after.calorieTarget) === next.calories
    : next?.calories === prior.calories && Number(after.calorieTarget) === prior.calories),
  `${u.name}: prior/new values match the visible target`, JSON.stringify({ prior, next, visible: after.calorieTarget }));
  chk(evidence?.stalledWeeks >= 3 && evidence?.loggedDays7d === (u.id === thin.id ? 2 : 5),
    `${u.name}: the audit preserves the measured evidence, not a test-written reason`, JSON.stringify(evidence));
}

REAL(`\npg-c18-adaptive-review-acceptance: ${failed ? `${failed} FAILED` : "GREEN"}\n`);
for (const id of ids) await pool.query("DELETE FROM users WHERE id = $1", [id]);
await pool.end();
(globalThis as any).Date = RealDate;
process.exit(failed ? 1 : 0);

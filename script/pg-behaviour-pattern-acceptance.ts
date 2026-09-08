/**
 * REAL POSTGRESQL ACCEPTANCE — evidence-backed behavioural pattern state (#217).
 *
 * Failures and successes are first produced through the existing open-loop/front-door owners.
 * Historical dates are test setup only; the profile builder and canonical decision then read the
 * real rows exactly as production does. Nothing here treats silence or missing logs as behaviour.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-behaviour-pattern-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { and, eq } = await import("drizzle-orm");
const { handleMessage } = await import("../server/routes");
const { ensureOpenTrainingLoop } = await import("../server/memory");
const { buildClientProfile, decisionPatterns } = await import("../server/intelligence/profile");
const { canonicalNextMove } = await import("../server/scheduler/proactive-decision");
const { sastDayKey, sastDayStart } = await import("../server/sast");

let failed = 0;
const ids: string[] = [];
function check(ok: boolean, claim: string, evidence = "") {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${claim}${!ok && evidence ? `\n          ${evidence}` : ""}`);
}
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

function priorDay(targetDow: number, weeksAgo: number): string {
  const today = sastDayKey();
  const currentDow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const days = ((currentDow - targetDow + 7) % 7) + weeksAgo * 7;
  return sastDayKey(sastDayStart().getTime() - days * 86_400_000);
}

async function freshUser(over: Record<string, unknown> = {}) {
  const phoneNumber = `whatsapp:+2787${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [user] = await db.insert(schema.users).values({
    phoneNumber, name: "Pattern", onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss",
    calorieTarget: 2200, proteinTarget: 150, stepsTarget: 0, trainingMode: "gym",
    trainingDaysPerWeek: 3, currentWeight: "88.0", heightCm: 178, gender: "male", age: 35,
    totalWorkoutsCompleted: 0, createdAt: ago(100), programmeStartDate: ago(100),
    programmeWeek: 14, lastActiveAt: new Date(), ...over,
  } as any).returning();
  ids.push(user.id);
  return user;
}

async function seedDecisionEvidence(userId: string, thin = false) {
  const count = thin ? 2 : 4;
  for (let days = 0; days < count; days++) {
    await db.insert(schema.mealLogs).values({
      userId, loggedAt: new Date(sastDayStart(Date.now() - days * 86_400_000).getTime() + 12 * 3_600_000),
      rawMessage: "acceptance evidence", source: "retro", kcalInt: 2200, proteinInt: 150,
      items: [{ name: "evidence meal", kcal: 2200, protein: 150 }],
    });
  }
  await db.insert(schema.weightLogs).values({ userId, weight: "88.0", loggedAt: new Date() });
}

async function failOpenMove(user: any, targetDay: string, message: string, id: string) {
  await ensureOpenTrainingLoop(user, targetDay, "reactive");
  await handleMessage(user.phoneNumber, message, undefined, undefined, undefined, id);
}

const profileRow = async (id: string) => (await db.select({
  patternFlags: schema.clientIntelligenceProfiles.patternFlags,
  coachNarrative: schema.clientIntelligenceProfiles.coachNarrative,
}).from(schema.clientIntelligenceProfiles)
  .where(eq(schema.clientIntelligenceProfiles.userId, id)).limit(1))[0];

REAL("\n=== REPEATED WEEKEND + WORK-PRESSURE OUTCOMES ===");
const active = await freshUser();
await seedDecisionEvidence(active.id);
await failOpenMove(active, priorDay(6, 3), "I couldn't do it, work was chaos", "SM-pattern-a1");
await failOpenMove(active, priorDay(6, 2), "I couldn't do it, work pressure got me again", "SM-pattern-a2");
// Two weekday failures prove that work pressure recurred independently of the weekend shape.
await failOpenMove(active, priorDay(1, 3), "I couldn't do it, work was too busy", "SM-pattern-a3");
await failOpenMove(active, priorDay(1, 2), "I couldn't do it, late shift at work", "SM-pattern-a4");

// One attributed minimum intervention followed by a real workout is direct intervention evidence.
await ensureOpenTrainingLoop(active, sastDayKey(), "reactive", Date.now(), "minimum");
await handleMessage(active.phoneNumber, "workout done", undefined, undefined, undefined, "SM-pattern-a5");
await buildClientProfile(active);
const activeProfile = await profileRow(active.id);
const activeContext = decisionPatterns(activeProfile?.patternFlags);
const rows = await db.select().from(schema.dailyConstraints)
  .where(and(eq(schema.dailyConstraints.userId, active.id), eq(schema.dailyConstraints.kind, "training")));
check(rows.filter((r: any) => r.state === "asserted" && r.via === "said_time").length >= 4,
  "explicit failed open loops preserve work-pressure provenance", JSON.stringify(rows));
check(rows.some((r: any) => r.state === "released" && r.via === "workout_logged_minimum"),
  "the completed minimum intervention is linked to workout truth", JSON.stringify(rows));
check(activeContext.weekendTrainingMisses && activeContext.workPressureTrainingMisses,
  "two distinct weeks earn active weekend and work-pressure patterns", JSON.stringify(activeProfile?.patternFlags));
check(activeContext.minimumTrainingReengaged,
  "the attributed intervention outcome is available to the decision", JSON.stringify(activeProfile?.patternFlags));

const adapted = await canonicalNextMove(active, { hour: 14 });
check(adapted.action.kind === "train"
    && adapted.action.todo === "Do today's session. Even a bad one counts."
    && adapted.action.intervention === "minimum_training",
  "the existing canonical decision owner selects the existing minimum action",
  JSON.stringify(adapted.action));
check(!/weekend|work pressure|pattern/i.test(String(activeProfile?.coachNarrative || "")),
  "structured pattern state is not copied into model-authored client prose",
  JSON.stringify(activeProfile?.coachNarrative));

REAL("\n=== ONE EVENT AND SILENCE ARE NOT PATTERNS ===");
const isolatedMiss = await freshUser();
await seedDecisionEvidence(isolatedMiss.id);
await failOpenMove(isolatedMiss, priorDay(6, 2), "I couldn't do it, work was chaos", "SM-pattern-one");
await buildClientProfile(isolatedMiss);
const oneContext = decisionPatterns((await profileRow(isolatedMiss.id))?.patternFlags);
check(!oneContext.weekendTrainingMisses && !oneContext.workPressureTrainingMisses,
  "one bad weekend remains one outcome, not a durable pattern", JSON.stringify(oneContext));

const silent = await freshUser();
for (let i = 0; i < 20; i++) {
  await db.insert(schema.chatHistory).values({
    userId: silent.id, messageIn: i % 2 ? "hello" : "checking in", messageOut: "hi", intent: "GENERAL",
    createdAt: ago(i),
  });
}
await buildClientProfile(silent);
const silentProfile = await profileRow(silent.id);
check(Object.values(decisionPatterns(silentProfile?.patternFlags)).every(v => !v),
  "missing reports and uneven engagement create no behavioural truth",
  JSON.stringify(silentProfile?.patternFlags));
check(!/go quiet|tend to slip/i.test(String(silentProfile?.coachNarrative || "")),
  "the model narrative no longer converts silence into failure", JSON.stringify(silentProfile?.coachNarrative));

REAL("\n=== CONTRADICTION, DECAY, ISOLATION, AND PRECEDENCE ===");
const contradicted = await freshUser();
await db.insert(schema.dailyConstraints).values([
  { userId: contradicted.id, day: priorDay(6, 6), kind: "training", state: "asserted", via: "said_open", sourceMessageId: "SM-pattern-c1" },
  { userId: contradicted.id, day: priorDay(6, 5), kind: "training", state: "asserted", via: "said_open", sourceMessageId: "SM-pattern-c2" },
]);
await db.insert(schema.workoutLogs).values([
  { userId: contradicted.id, workoutCompleted: true, loggedAt: new Date(`${priorDay(6, 4)}T10:00:00+02:00`) },
  { userId: contradicted.id, workoutCompleted: true, loggedAt: new Date(`${priorDay(6, 3)}T10:00:00+02:00`) },
]);
await buildClientProfile(contradicted);
const contradictedState: any = (await profileRow(contradicted.id))?.patternFlags;
check(contradictedState.patterns.some((p: any) => p.kind === "weekend_training_misses"
    && p.status === "superseded" && p.contradictionCount >= 2)
    && !decisionPatterns(contradictedState).weekendTrainingMisses,
  "recent contradictory action removes an old pattern's authority without erasing provenance",
  JSON.stringify(contradictedState));

const stale = await freshUser();
await db.insert(schema.dailyConstraints).values([
  { userId: stale.id, day: priorDay(1, 11), kind: "training", state: "asserted", via: "said_time", sourceMessageId: "SM-pattern-s1" },
  { userId: stale.id, day: priorDay(1, 10), kind: "training", state: "asserted", via: "said_time", sourceMessageId: "SM-pattern-s2" },
]);
await buildClientProfile(stale);
const staleState: any = (await profileRow(stale.id))?.patternFlags;
check(staleState.patterns.some((p: any) => p.kind === "work_pressure_training_misses" && p.status === "decayed")
    && !decisionPatterns(staleState).workPressureTrainingMisses,
  "stale pattern evidence remains attributable but cannot decide", JSON.stringify(staleState));

const unrelated = await freshUser();
await buildClientProfile(unrelated);
check(Object.values(decisionPatterns((await profileRow(unrelated.id))?.patternFlags)).every(v => !v),
  "one client never inherits another client's pattern state");

await ensureOpenTrainingLoop(active, sastDayKey(), "reactive");
const whileOpen = await canonicalNextMove(active, { hour: 14 });
check(whileOpen.action.kind !== "train", "an unresolved #208 loop outranks pattern adaptation", whileOpen.action.kind);

const sick = await freshUser({
  profileNotes: `sick_since:${sastDayKey()} | sick_until:${sastDayKey()} | paused_until:${sastDayKey()}`,
});
await seedDecisionEvidence(sick.id);
await db.insert(schema.clientIntelligenceProfiles).values({
  userId: sick.id, patternFlags: activeProfile.patternFlags,
}).onConflictDoUpdate({ target: schema.clientIntelligenceProfiles.userId, set: { patternFlags: activeProfile.patternFlags } });
check((await canonicalNextMove(sick, { hour: 14 })).action.kind === "rest",
  "illness retains precedence over an active training pattern");

const forbidden = await freshUser({ doNotMention: "training and the gym" });
await seedDecisionEvidence(forbidden.id);
await db.insert(schema.clientIntelligenceProfiles).values({
  userId: forbidden.id, patternFlags: activeProfile.patternFlags,
}).onConflictDoUpdate({ target: schema.clientIntelligenceProfiles.userId, set: { patternFlags: activeProfile.patternFlags } });
check((await canonicalNextMove(forbidden, { hour: 14 })).action.kind !== "train",
  "doNotMention prevents pattern state from reissuing training");

for (const id of ids) await db.delete(schema.users).where(eq(schema.users.id, id)).catch(() => {});
await pool.end();
if (failed) {
  REAL(`\npg-behaviour-pattern-acceptance: RED — ${failed} check(s) failed`);
  process.exit(1);
}
REAL("\npg-behaviour-pattern-acceptance: GREEN — LOCAL REAL POSTGRESQL");
process.exit(0);

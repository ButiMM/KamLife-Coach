/**
 * REAL POSTGRESQL ACCEPTANCE — one canonical training move survives and resolves across turns.
 *
 * This intentionally exercises the production handleMessage front door for every client outcome.
 * The only direct setup is the earlier outbound move, represented through its real durable owner.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-open-coaching-loop-acceptance: SKIPPED — no DATABASE_URL");
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

// This suite grades an OPEN TRAINING MOVE, so its fixture must actually be on a training day.
// It previously inherited the runner's weekday: Monday was green, Tuesday/Sunday was red because
// the reactive owner correctly held training on a rest day while the setup still demanded the
// Monday instruction. Freeze to noon on this SAST week's Monday; chronology remains relative and
// the product contract is stricter, not weaker — a real rest day is never turned into training.
const wallClockNow = Date.now();
const { sastWeekStart: acceptanceWeekStart } = await import("../server/sast");
const acceptanceNow = acceptanceWeekStart(wallClockNow).getTime() + 12 * 3_600_000;
Date.now = () => acceptanceNow;

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { and, desc, eq } = await import("drizzle-orm");
const { handleMessage } = await import("../server/routes");
const { canonicalNextMove, recordCanonicalMoveOutbound } = await import("../server/scheduler/proactive-decision");
const { sendWhatsApp } = await import("../server/scheduler/shared");
const { consumeOpenTrainingLoop, ensureOpenTrainingLoop } = await import("../server/memory");
const { createOpenTrainingLoop, isOpenTrainingLoopMarker, readOpenTrainingLoop, TRAINING_LOOP_WINDOW_MS } = await import("../server/workout-feedback");
const { sastDayKey, sastDayKeyBefore, sastDayStart } = await import("../server/sast");

let failed = 0;
const ids: string[] = [];
function check(ok: boolean, claim: string, evidence = "") {
  if (!ok) failed++;
  REAL("  " + (ok ? "PASS" : "FAIL") + "  " + claim + (!ok && evidence ? "\n          " + evidence : ""));
}

async function freshUser(over: Record<string, unknown> = {}) {
  const phone = "whatsapp:+2788" + String(Math.floor(Math.random() * 900000) + 100000);
  const [user] = await db.insert(schema.users).values({
    phoneNumber: phone,
    name: "Loop",
    gender: "female",
    goalType: "fat_loss",
    age: 34,
    heightCm: 165,
    currentWeight: "75.0",
    trainingDaysPerWeek: 1,
    calorieTarget: 2000,
    proteinTarget: 120,
    stepsTarget: 0,
    subscriptionStatus: "active",
    onboardingState: "COMPLETE",
    popiConsent: true,
    popiConsentAt: new Date(),
    trainingMode: "gym",
    programmeWeek: 4,
    programmeDayInWeek: 1,
    programmeStartDate: new Date(Date.now() - 30 * 86_400_000),
    createdAt: new Date(Date.now() - 30 * 86_400_000),
    lastActiveAt: new Date(),
    totalWorkoutsCompleted: 0,
    ...over,
  } as any).returning();
  ids.push(user.id);

  for (let days = 0; days < 4; days++) {
    await db.insert(schema.mealLogs).values({
      userId: user.id,
      loggedAt: new Date(sastDayStart(Date.now() - days * 86_400_000).getTime() + 12 * 3_600_000),
      rawMessage: "acceptance evidence",
      source: "retro",
      kcalInt: 2000,
      proteinInt: 130,
      items: [{ name: "evidence meal", kcal: 2000, protein: 130 }],
    });
  }
  await db.insert(schema.weightLogs).values({ userId: user.id, weight: "75.0", loggedAt: new Date() });
  return user;
}

async function reload(user: any) {
  return (await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1))[0];
}

async function workoutDays(userId: string) {
  const rows = await db.select({ at: schema.workoutLogs.loggedAt }).from(schema.workoutLogs)
    .where(eq(schema.workoutLogs.userId, userId));
  return rows.map((row: any) => sastDayKey(row.at));
}

async function openOn(user: any, targetDay: string, ageMs = 0) {
  return ensureOpenTrainingLoop(user, targetDay, "reactive", Date.now() - ageMs);
}

REAL("\n=== OPENED BY THE CANONICAL OWNER ===");
const origin = await freshUser();
const firstMove = await canonicalNextMove(origin);
check((await reload(origin)).awaitingInputType === null,
  "selecting a proactive move without handing it to outbound creates no phantom ask");
process.env.SHADOW = "on";
let shadowDelivery: "sent" | "dropped" | "fallback" = "sent";
try {
  shadowDelivery = await sendWhatsApp(origin.phoneNumber, firstMove.line);
} finally {
  delete process.env.SHADOW;
}
await recordCanonicalMoveOutbound(origin, firstMove, shadowDelivery);
check(shadowDelivery === "dropped" && (await reload(origin)).awaitingInputType === null,
  "a shadowed or dropped outbound message cannot create an unresolved ask", shadowDelivery);
await recordCanonicalMoveOutbound(origin, firstMove, "sent");
const originStored = await reload(origin);
const originOpen = readOpenTrainingLoop(originStored.awaitingInputType);
check(firstMove.action.kind === "train", "the canonical decision selects the training move", firstMove.action.kind);
check(!!originOpen && originOpen.targetDay === sastDayKey(), "the unresolved move is durable with its SAST target day");
const whileOpen = await canonicalNextMove(originStored);
check(whileOpen.action.kind !== "train", "an unresolved move is not re-issued on the next decision", whileOpen.action.kind);

const reactiveOrigin = await freshUser();
const originReply = await handleMessage(
  reactiveOrigin.phoneNumber,
  "I drank 2 litres of water",
  undefined,
  undefined,
  undefined,
  "SM-loop-origin",
);
await new Promise(resolve => setTimeout(resolve, 100));
const reactiveOriginAfter = await reload(reactiveOrigin);
const reactiveOpen = readOpenTrainingLoop(reactiveOriginAfter.awaitingInputType);
const [originTurn] = await db.select().from(schema.turnLedger)
  .where(and(eq(schema.turnLedger.userId, reactiveOrigin.id), eq(schema.turnLedger.inputText, "I drank 2 litres of water")))
  .orderBy(desc(schema.turnLedger.createdAt)).limit(1);
check(/Get today's session done/i.test(originReply), "the production reply actually delivers the canonical move", originReply);
check(!!reactiveOpen, "the reactive move survives after the originating turn returns");
check((originTurn?.stateRead as any)?.openLoopRef === reactiveOpen?.ref,
  "the turn ledger and durable continuation share one provenance ref");

REAL("\n=== A — LATE COMPLETION ===");
const a = await freshUser();
const aOpen = await openOn(a, sastDayKeyBefore(1), 24 * 3_600_000);
const aReply = await handleMessage(a.phoneNumber, "I trained yesterday, forgot to tell you", undefined, undefined, undefined, "SM-loop-a");
await new Promise(resolve => setTimeout(resolve, 100));
const aAfter = await reload(a);
const aDays = await workoutDays(a.id);
const aNext = await canonicalNextMove(aAfter);
const [aTurn] = await db.select().from(schema.turnLedger)
  .where(and(eq(schema.turnLedger.userId, a.id), eq(schema.turnLedger.inputText, "I trained yesterday, forgot to tell you")))
  .orderBy(desc(schema.turnLedger.createdAt)).limit(1);
check(!!aOpen, "the prior-day move starts open");
check(aDays.length === 1 && aDays[0] === sastDayKeyBefore(1), "the workout owner writes exactly the reported SAST day", aDays.join(","));
const aAfterOpen = readOpenTrainingLoop(aAfter.awaitingInputType);
check(aAfterOpen?.ref !== aOpen?.ref, "the attributed move resolves exactly the originating ref");
check(aNext.action.kind !== "train", "the proactive next decision does not repeat the unresolved originating move", aNext.action.kind);
check(/logged|session/i.test(aReply), "the customer-visible reply confirms the supported workout truth", aReply);
check(JSON.stringify(aTurn?.mutations || []).includes(aOpen?.ref || "missing-ref"),
  "the later turn ledger attributes resolution to the originating ref");

const explicitToday = await freshUser();
const explicitOpen = await openOn(explicitToday, sastDayKeyBefore(1), 24 * 3_600_000);
await handleMessage(explicitToday.phoneNumber, "I got the workout done this morning", undefined, undefined, undefined, "SM-loop-explicit");
const explicitDays = await workoutDays(explicitToday.id);
const explicitAfter = await reload(explicitToday);
check(explicitDays.length === 1 && explicitDays[0] === sastDayKey(),
  "an explicit current-day phrase outranks the older open-loop target", explicitDays.join(","));
check(readOpenTrainingLoop(explicitAfter.awaitingInputType)?.ref === explicitOpen?.ref,
  "the older loop is not falsely resolved by a different explicitly dated session");

REAL("\n=== B — FAILED OUTCOME ===");
const b = await freshUser();
await openOn(b, sastDayKey());
const bReply = await handleMessage(b.phoneNumber, "I couldn't do it, work was chaos", undefined, undefined, undefined, "SM-loop-b");
const bAfter = await reload(b);
const bDays = await workoutDays(b.id);
const bConstraints = await db.select().from(schema.dailyConstraints)
  .where(and(eq(schema.dailyConstraints.userId, b.id), eq(schema.dailyConstraints.day, sastDayKey())));
const bNext = await canonicalNextMove(bAfter);
check(bDays.length === 0, "failure never fabricates a workout");
check(bAfter.awaitingInputType === null, "the failed move closes exactly once");
check(bConstraints.some((row: any) => row.kind === "training" && row.state === "asserted"), "the existing constraint owner records the supported failure");
check(bNext.action.kind !== "train", "the same-day next decision does not nag after failure", bNext.action.kind);
check(!/session done|workout logged/i.test(bReply), "the reply makes no false completion claim", bReply);

const bQuestion = await freshUser();
await openOn(bQuestion, sastDayKey());
const bQuestionReply = await handleMessage(bQuestion.phoneNumber, "I couldn't do it; what should I do now?", undefined, undefined, undefined, "SM-loop-bq");
const bQuestionAfter = await reload(bQuestion);
const bQuestionConstraints = await db.select().from(schema.dailyConstraints)
  .where(and(eq(schema.dailyConstraints.userId, bQuestion.id), eq(schema.dailyConstraints.day, sastDayKey())));
check(bQuestionAfter.awaitingInputType === null,
  "an explicit failure closes before the question in the same turn is answered");
check(bQuestionConstraints.some((row: any) => row.kind === "training" && row.state === "asserted"),
  "failure plus a question records the supported constraint first");
check(!/Get today's session done/i.test(bQuestionReply),
  "the answer after a reported failure does not immediately reissue training", bQuestionReply);

REAL("\n=== C — INTENTION IS NOT AN OUTCOME ===");
const c = await freshUser();
const cOpen = await openOn(c, sastDayKey());
await handleMessage(c.phoneNumber, "I might train later", undefined, undefined, undefined, "SM-loop-c");
const cAfter = await reload(c);
check((await workoutDays(c.id)).length === 0, "an intention writes no workout");
check(cAfter.awaitingInputType === cOpen?.marker, "an intention leaves the move open");

REAL("\n=== D — STRUCTURED COMPLETION + IDEMPOTENCE ===");
const d = await freshUser();
await openOn(d, sastDayKey());
await handleMessage(d.phoneNumber, "workout done", undefined, undefined, undefined, "SM-loop-d1");
const dAfterFirst = await reload(d);
await handleMessage(d.phoneNumber, "workout done", undefined, undefined, undefined, "SM-loop-d2");
const dAfter = await reload(d);
check((await workoutDays(d.id)).length === 1, "structured completion writes one session even when repeated");
check(!isOpenTrainingLoopMarker(dAfterFirst.awaitingInputType), "structured completion also closes the original loop");
check(!isOpenTrainingLoopMarker(dAfter.awaitingInputType), "a duplicate completion cannot resurrect the original loop");
const dNext = await canonicalNextMove(dAfter);
check(dNext.action.kind !== "train", "a completed current-week move is not re-issued after a quiet turn", dNext.action.kind);

const natural = await freshUser();
const naturalOpen = await openOn(natural, sastDayKeyBefore(1), 24 * 3_600_000);
await handleMessage(natural.phoneNumber, "I did the workout you told me to do", undefined, undefined, undefined, "SM-loop-natural");
const naturalAfter = await reload(natural);
check((await workoutDays(natural.id)).includes(sastDayKeyBefore(1)),
  "the exact referential completion writes the open move's SAST day");
check(readOpenTrainingLoop(naturalAfter.awaitingInputType)?.ref !== naturalOpen?.ref,
  "the exact referential completion resolves its originating ref");

const got = await freshUser();
const gotOpen = await openOn(got, sastDayKey());
await handleMessage(got.phoneNumber, "I got the session done", undefined, undefined, undefined, "SM-loop-got");
const gotAfter = await reload(got);
check((await workoutDays(got.id)).includes(sastDayKey()), "the natural session-done phrase writes completion");
check(readOpenTrainingLoop(gotAfter.awaitingInputType)?.ref !== gotOpen?.ref,
  "the natural session-done phrase resolves its originating ref");

REAL("\n=== EVERY LIVE DECISION SURFACE SHARES THE LOOP ===");
const surfaces = await freshUser();
const surfacesOpen = await openOn(surfaces, sastDayKey());
const oneActionReply = await handleMessage(surfaces.phoneNumber, "what should I do?", undefined, undefined, undefined, "SM-loop-one-action");
const weeklyReply = await handleMessage(surfaces.phoneNumber, "this week", undefined, undefined, undefined, "SM-loop-weekly");
check(!/Get today's session done/i.test(oneActionReply),
  "the explicit one-action customer path does not reissue an unresolved training move", oneActionReply);
check(!/Get today's session done/i.test(weeklyReply),
  "the weekly progress customer path does not reissue an unresolved training move", weeklyReply);
check(readOpenTrainingLoop((await reload(surfaces)).awaitingInputType)?.ref === surfacesOpen?.ref,
  "consulting either decision surface leaves the same unresolved loop intact");

REAL("\n=== CONTROLS ===");
const q = await freshUser();
const qOpen = await openOn(q, sastDayKey());
await handleMessage(q.phoneNumber, "what workout did you tell me to do?", undefined, undefined, undefined, "SM-loop-q");
check((await workoutDays(q.id)).length === 0, "a question is not completion");
check((await reload(q)).awaitingInputType === qOpen?.marker, "a question leaves the move open");

const ambiguous = await freshUser();
const ambiguousOpen = await openOn(ambiguous, sastDayKey());
await handleMessage(ambiguous.phoneNumber, "I did it", undefined, undefined, undefined, "SM-loop-amb");
check((await workoutDays(ambiguous.id)).length === 0, "an ambiguous outcome is not attributed");
check((await reload(ambiguous)).awaitingInputType === ambiguousOpen?.marker, "ambiguity preserves the open evidence");

const isolated = await freshUser();
check((await reload(isolated)).awaitingInputType === null, "another user never inherits the open move");

const stale = await freshUser();
const staleMarker = createOpenTrainingLoop(sastDayKeyBefore(3), "reactive", Date.now() - TRAINING_LOOP_WINDOW_MS - 1);
await pool.query("UPDATE users SET awaiting_input_type = $1 WHERE id = $2", [staleMarker, stale.id]);
const staleRow = await reload(stale);
await import("../server/memory").then(m => m.loadOpenTrainingLoop(staleRow));
check((await reload(stale)).awaitingInputType === null, "a stale move expires instead of capturing a later outcome");

const safe = await freshUser({ profileNotes: "sick_since:" + sastDayKey() + " | sick_until:" + sastDayKey() + " | paused_until:" + sastDayKey() });
const safeMove = await canonicalNextMove(safe);
check(safeMove.action.kind !== "train", "safety still outranks training-loop creation", safeMove.action.kind);
check((await reload(safe)).awaitingInputType === null, "a safety decision opens no training move");

if (originOpen) await consumeOpenTrainingLoop(originStored, originOpen.marker);
if (reactiveOpen) await consumeOpenTrainingLoop(reactiveOriginAfter, reactiveOpen.marker);
for (const id of ids) await db.delete(schema.users).where(eq(schema.users.id, id)).catch(() => {});
await pool.end();

if (failed) {
  REAL("\npg-open-coaching-loop-acceptance: RED — " + failed + " check(s) failed");
  process.exit(1);
}
REAL("\npg-open-coaching-loop-acceptance: GREEN — LOCAL REAL POSTGRESQL");
process.exit(0);

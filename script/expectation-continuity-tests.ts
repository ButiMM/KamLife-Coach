/**
 * CUT C1 — DURABLE CONVERSATIONAL EXPECTATION
 *
 * Drives the real inbound route with the repository's DB stub. These are deliberately behavioural:
 * a marker formatter or an isolated classifier is not enough — the question must persist, its
 * answer must win before logging, and a spent question must stop owning later messages.
 */
process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.NORMALIZER = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.NODE_ENV = "production";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.APP_URL = "https://x.up.railway.app";

import assert from "node:assert/strict";

const { handleMessage } = await import("../server/routes");
const { resumeWorkoutFeedbackExpectation } = await import("../server/handlers/workout");
const { users, workoutLogs, chatHistory, mealLogs } = await import("../shared/schema");
const {
  createWorkoutFeedbackExpectation,
  readWorkoutFeedbackExpectation,
  WORKOUT_FEEDBACK_EXPECTATION_WINDOW_MS,
} = await import("../server/workout-feedback");

const PHONE = "whatsapp:+27000000901";
const NOW = Date.now();

const BASE_USER = {
  id: "cut-c1", phoneNumber: PHONE, name: "Kam",
  onboardingState: "COMPLETE", onboardingComplete: true, subscriptionStatus: "active",
  popiConsent: true, popiConsentAt: new Date(NOW - 86_400_000),
  goalType: "fat_loss", currentWeight: 95, targetWeight: 85,
  heightCm: 180, age: 35, gender: "male", activityLevel: "moderate",
  trainingMode: "gym", trainingDaysPerWeek: 3,
  programmePhase: 1, programmeWeek: 1, programmeDayInWeek: 2,
  programmeStartDate: new Date(NOW - 35 * 86_400_000), totalWorkoutsCompleted: 23,
  injuries: "none", medicalConditions: "none", awaitingInputType: null, profileNotes: "",
  todayWater: "0", calorieTarget: 2700, proteinTarget: 180,
  stepTarget: 10000, stepsTarget: 10000,
  lastActiveAt: new Date(NOW - 3_600_000), createdAt: new Date(NOW - 35 * 86_400_000),
};

function installUser(extra: Record<string, unknown> = {}) {
  const g = globalThis as any;
  g.__KAMLIFE_STUB_USER = { ...BASE_USER, ...extra };
  g.__KAMLIFE_STUB_ROWS = undefined;
  g.__KAMLIFE_STUB_WRITES = [];
  g.__KAMLIFE_STUB_UPDATES = [];
  return g;
}

function writesFor(g: any, table: unknown) {
  return g.__KAMLIFE_STUB_WRITES.filter((w: any) => w.table === table);
}

async function resume(g: any, message: string) {
  return resumeWorkoutFeedbackExpectation({
    phone: PHONE, message, m: message.toLowerCase().trim(), user: g.__KAMLIFE_STUB_USER,
  });
}

async function observedJourney(): Promise<void> {
  const g = installUser();
  const question = await handleMessage(PHONE, "done");
  assert.match(question, /How did that session feel\?/i, "a completed session must ask the structured feel question");

  const marker = String(g.__KAMLIFE_STUB_USER.awaitingInputType || "");
  const expectation = readWorkoutFeedbackExpectation(marker);
  assert.deepEqual(
    { owner: expectation?.owner, type: expectation?.type, source: expectation?.source },
    { owner: "workout_feedback", type: "session_feel", source: "post_session_checkin" },
    "the question must leave one recoverable durable contract",
  );

  const sessionsBeforeAnswer = writesFor(g, workoutLogs).length;
  const answer = await handleMessage(PHONE, "Just right. I pushed.");
  assert.match(answer, /hard but doable/i, "the workout-feedback owner must consume the real production phrasing");
  assert.equal(g.__KAMLIFE_STUB_USER.awaitingInputType, null, "the expectation must clear after its answer");
  assert.equal(writesFor(g, workoutLogs).length, sessionsBeforeAnswer,
    "the feedback answer must not be stolen as a duplicate workout/session log");
  assert.equal(writesFor(g, chatHistory).filter((w: any) => w.values.intent === "WORKOUT_FEEDBACK").length, 1,
    "the owner must record exactly one feedback turn");

  await resume(g, "Just right. I pushed.");
  assert.equal(writesFor(g, chatHistory).filter((w: any) => w.values.intent === "WORKOUT_FEEDBACK").length, 1,
    "a spent expectation must not produce a second feedback response or mutation");
}

async function restartAndExpiry(): Promise<void> {
  // A fresh route call with only the persisted user value simulates a normal process restart:
  // there is no in-memory expectation to rely on.
  const g = installUser({ awaitingInputType: createWorkoutFeedbackExpectation() });
  const reply = await handleMessage(PHONE, "Just right. I pushed.");
  assert.match(reply, /hard but doable/i, "a valid persisted expectation must survive a normal restart");
  assert.equal(g.__KAMLIFE_STUB_USER.awaitingInputType, null, "restart-resumed expectation must still clear once consumed");

  const expired = installUser({
    awaitingInputType: createWorkoutFeedbackExpectation(Date.now() - WORKOUT_FEEDBACK_EXPECTATION_WINDOW_MS - 1),
  });
  const staleReply = await resume(expired, "too hard");
  assert.equal(expired.__KAMLIFE_STUB_USER.awaitingInputType, null, "an expired expectation must be released");
  assert.equal(staleReply, null,
    "an expired expectation must not consume a later standalone message as old workout feedback");
}

async function mixedFactJourney(): Promise<void> {
  const g = installUser({ awaitingInputType: createWorkoutFeedbackExpectation() });
  await handleMessage(PHONE, "Just right, and I had chicken and pap.");
  assert.equal(g.__KAMLIFE_STUB_USER.awaitingInputType, null, "the feedback expectation must still clear in a mixed turn");
  assert.equal(writesFor(g, chatHistory).filter((w: any) => w.values.intent === "WORKOUT_FEEDBACK").length, 1,
    "the feedback owner must contribute once to a mixed turn");
  assert.ok(writesFor(g, mealLogs).length >= 1,
    "a feedback answer must not prevent the same turn's meal from reaching its durable writer");
}

async function replacementAndSubjectChange(): Promise<void> {
  const oldMarker = createWorkoutFeedbackExpectation(Date.now() - 1_000);
  const newer = installUser({ awaitingInputType: oldMarker });
  const question = await handleMessage(PHONE, "done");
  assert.match(question, /How did that session feel\?/i);
  assert.notEqual(newer.__KAMLIFE_STUB_USER.awaitingInputType, oldMarker,
    "a newer structured Coach K question must replace the older one-slot expectation");

  const changedSubject = installUser({ awaitingInputType: createWorkoutFeedbackExpectation() });
  const subjectReply = await resume(changedSubject, "I ate chicken and pap");
  assert.equal(subjectReply, null, "a subject change must continue to its normal owner");
  assert.equal(changedSubject.__KAMLIFE_STUB_USER.awaitingInputType, null,
    "changing subject must release the old question instead of holding the client hostage");
  const later = await resume(changedSubject, "too hard");
  assert.equal(later, null,
    "a later message after subject change must not be captured by the old workout expectation");

  const explicitDiet = installUser({ awaitingInputType: createWorkoutFeedbackExpectation() });
  const dietReply = await resume(explicitDiet, "this diet is too hard");
  assert.equal(dietReply, null, "an explicit diet concern must not be consumed as workout feedback");
  assert.equal(explicitDiet.__KAMLIFE_STUB_USER.awaitingInputType, null,
    "an explicit subject change must release the workout expectation");
}

await observedJourney();
await restartAndExpiry();
await mixedFactJourney();
await replacementAndSubjectChange();

console.log("[expectation-continuity] PASS — durable session-feel expectation is recoverable, single-consumed and bounded");
process.exit(0); // route imports leave background handles; the completed focused harness must not hang CI.

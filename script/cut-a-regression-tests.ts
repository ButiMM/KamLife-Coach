/** CUT A — canonical activity-write regressions. Offline and deterministic. */
process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";
process.env.NORMALIZER = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test";
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "+27000000000";

import assert from "node:assert/strict";

const { handleWeightLog } = await import("../server/handlers/weight");
const { handleMealRepeat } = await import("../server/handlers/meal-repeat");
const { commitFoodLog } = await import("../server/day-ledger");
const { mealLogs, weightLogs } = await import("../shared/schema");
const g = globalThis as any;

const user = () => ({
  id: "cut-a-user", phoneNumber: "whatsapp:+27000000991", name: "Cut A",
  onboardingState: "COMPLETE", goalType: "fat_loss", currentWeight: "84",
  calorieTarget: 2200, proteinTarget: 160, heightCm: 178, age: 35, gender: "male",
  trainingDaysPerWeek: 3, trainingExperience: "beginner", targetWeightKg: null,
});

// Scale-photo and text weigh-ins share this owner. A second same-day report updates the event;
// it never creates a second row, and the caller's turn-local profile follows durable truth.
{
  const u = user();
  g.__KAMLIFE_STUB_USER = u;
  g.__KAMLIFE_STUB_ROWS = new Map([[weightLogs, []]]);
  g.__KAMLIFE_STUB_WRITES = [];
  g.__KAMLIFE_STUB_UPDATES = [];
  g.__KAMLIFE_STUB_REFLECT_WRITES = true;
  await handleWeightLog(u.phoneNumber, u, 83);
  await handleWeightLog(u.phoneNumber, u, 82);
  const inserts = g.__KAMLIFE_STUB_WRITES.filter((w: any) => w.table === weightLogs);
  const updates = g.__KAMLIFE_STUB_UPDATES.filter((w: any) => w.table === weightLogs);
  assert.equal(inserts.length, 1, "same-day weight writes must upsert one event");
  assert.ok(updates.some((w: any) => w.set?.weight === "82"), "second scale value must update today's event");
  assert.equal(u.currentWeight, "82", "turn-local profile must hold canonical current weight");
  console.log("✓ weight owner — same-day upsert, one event, coherent current truth");
}

function meal(rawMessage: string, sourceMessageId: string, allowIntentionalRepeat = false) {
  return commitFoodLog({
    userId: "cut-a-user", phone: "whatsapp:+27000000991", rawMessage, source: "photo",
    kcalInt: 420, proteinInt: 32, carbsInt: 0, fatInt: 0,
    items: [{ name: "Chicken and rice", grams: 350, kcal: 420, protein: 32, category: "meal" }],
    mealLabel: "lunch", loggedAt: new Date(), sourceMessageId, allowIntentionalRepeat,
  });
}

// Stable inbound lineage, not a four-minute clock, is the replay authority.
{
  g.__KAMLIFE_STUB_USER = user();
  g.__KAMLIFE_STUB_ROWS = new Map([[mealLogs, []]]);
  g.__KAMLIFE_STUB_WRITES = [];
  g.__KAMLIFE_STUB_REFLECT_WRITES = true;
  const first = await meal("I had chicken and rice", "SM-TEXT-1");
  const replay = await meal("I had chicken and rice", "SM-TEXT-1");
  assert.equal(first.wasDup, false);
  assert.equal(replay.wasDup, true);
  assert.equal(g.__KAMLIFE_STUB_WRITES.filter((w: any) => w.table === mealLogs).length, 1,
    "replaying one inbound message must not insert a second meal");
  console.log("✓ food owner — stable lineage suppresses webhook replay");
}

// Exercise the production repeat caller, not just the owner: copied macros/items survive, the
// inbound id becomes lineage, and replay does not create another eating event.
{
  const u = user();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  g.__KAMLIFE_STUB_USER = u;
  g.__KAMLIFE_STUB_ROWS = new Map([[mealLogs, [{
    id: "source-lunch", userId: u.id, rawMessage: "Chicken and rice", source: "text",
    sourceMessageId: "SM-SOURCE", kcalInt: 420, proteinInt: 32, carbsInt: 48, fatInt: 10,
    items: [{ name: "Chicken and rice", grams: 350, kcal: 420, protein: 32, category: "meal" }],
    mealLabel: "lunch", loggedAt: yesterday,
  }]]);
  g.__KAMLIFE_STUB_WRITES = [];
  g.__KAMLIFE_STUB_REFLECT_WRITES = true;
  const message = "same as yesterday's lunch";
  const first = await handleMealRepeat({ phone: u.phoneNumber, message, m: message, user: u, sourceMessageId: "SM-REPEAT-1" });
  const replay = await handleMealRepeat({ phone: u.phoneNumber, message, m: message, user: u, sourceMessageId: "SM-REPEAT-1" });
  const rows = g.__KAMLIFE_STUB_WRITES.filter((w: any) => w.table === mealLogs).map((w: any) => w.values);
  assert.match(String(first), /logged/i);
  assert.match(String(replay), /already logged/i);
  assert.equal(rows.length, 1, "meal-repeat caller must materialise one canonical event");
  assert.equal(rows[0].sourceMessageId, "SM-REPEAT-1");
  assert.equal(rows[0].items[0].name, "Chicken and rice");
  console.log("✓ meal-repeat caller — copied provenance, canonical write, replay-safe");
}

// An album is one inbound message but multiple eating-event rows. Per-image raw references keep
// the shared lineage unambiguous; replaying the whole album inserts none of them twice.
{
  g.__KAMLIFE_STUB_USER = user();
  g.__KAMLIFE_STUB_ROWS = new Map([[mealLogs, []]]);
  g.__KAMLIFE_STUB_WRITES = [];
  g.__KAMLIFE_STUB_REFLECT_WRITES = true;
  for (let i = 1; i <= 3; i++) await meal(`[Album photo ${i}]`, "SM-ALBUM-1", true);
  for (let i = 1; i <= 3; i++) await meal(`[Album photo ${i}]`, "SM-ALBUM-1", true);
  const rows = g.__KAMLIFE_STUB_WRITES.filter((w: any) => w.table === mealLogs).map((w: any) => w.values);
  assert.equal(rows.length, 3, "album must create one row per food image, once");
  assert.deepEqual(new Set(rows.map((r: any) => r.sourceMessageId)), new Set(["SM-ALBUM-1"]));
  assert.deepEqual(rows.map((r: any) => r.rawMessage), ["[Album photo 1]", "[Album photo 2]", "[Album photo 3]"]);
  console.log("✓ food owner — album rows share lineage and remain replay-idempotent");
}

delete g.__KAMLIFE_STUB_USER;
delete g.__KAMLIFE_STUB_ROWS;
delete g.__KAMLIFE_STUB_WRITES;
delete g.__KAMLIFE_STUB_UPDATES;
delete g.__KAMLIFE_STUB_REFLECT_WRITES;
console.log("\nCUT A REGRESSION TESTS PASSED");
process.exit(0);

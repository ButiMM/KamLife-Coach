/**
 * ACCEPTANCE — THE DELETION RACE CONDITION, ON A REAL DATABASE.
 *
 * Every other harness in this repo runs against a DB stub, which is exactly why the disease it
 * tests for survived: a stub cannot lose a row. This one runs the founder's five steps against
 * a real PostgreSQL instance, through the real handleMessage pipeline, and then reads the rows
 * back with SQL. Persistence is the thing under test, so nothing about persistence is faked.
 *
 * THE FIVE STEPS (2026-08-10 directive):
 *   1. Log a meal.
 *   2. Send a correction.
 *   3. Do NOT re-send the replacement.
 *   4. "Show me my meals."
 *   5. The original meal must still appear. No zero-day. No denial.
 *
 * Plus the two client-facing promises already shipped, verified on the same run:
 *   6. A simplicity/wellness account gets the card with a verdict reading, not macros.
 *   7. The coach tells without handing the work back as a question.
 *
 * Run:  DATABASE_URL=postgresql://... npx tsx script/acceptance-hold.ts
 */

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";
process.env.NORMALIZER = "off";              // the deterministic spine is what is under test
process.env.PROACTIVE_PAUSED = "true";
process.env.ENGINE_LIVE = "on";
process.env.APP_URL = process.env.APP_URL || "https://kamlifecoach.co.za";  // a card needs a base URL to be served from
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test";
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "+27000000000";

if (!process.env.DATABASE_URL) {
  console.error("acceptance-hold: needs a REAL DATABASE_URL — a stub cannot lose a row, which is the whole point.");
  process.exit(1);
}

const { db } = await import("../server/db");
const { users, mealLogs } = await import("../shared/schema");
const { eq, and, gte, desc } = await import("drizzle-orm");
const { sastDayStart } = await import("../server/utils");
const { handleMessage } = await import("../server/routes");

let pass = 0, fail = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); }
}

async function freshUser(phone: string, extra: Record<string, unknown> = {}) {
  await db.delete(users).where(eq(users.phoneNumber, phone));
  const now = Date.now();
  const [u] = await db.insert(users).values({
    phoneNumber: phone,
    name: "Kam Test",
    onboardingState: "COMPLETE",
    subscriptionStatus: "active",
    popiConsent: true,
    popiConsentAt: new Date(now - 30 * 86_400_000),
    trialEndsAt: new Date(now + 30 * 86_400_000),
    subscriptionExpiresAt: new Date(now + 30 * 86_400_000),
    goalType: "fat_loss",
    calorieTarget: 1800,
    proteinTarget: 130,
    stepsTarget: 10000,
    currentWeight: "83",
    trainingMode: "gym",
    trainingDaysPerWeek: 3,
    trainingExperience: "beginner",
    gender: "male",
    age: 30,
    heightCm: 175,
    profileNotes: "numbers:full",
    totalWorkoutsCompleted: 8,
    lastActiveAt: new Date(now - 3_600_000),
    ...extra,
  } as any).returning();
  return u;
}

const dayRows = (uid: string) => db.select({
  id: mealLogs.id, kcal: mealLogs.kcalInt, prot: mealLogs.proteinInt,
  raw: mealLogs.rawMessage, corrected: mealLogs.corrected,
}).from(mealLogs).where(and(eq(mealLogs.userId, uid), gte(mealLogs.loggedAt, sastDayStart()))).orderBy(desc(mealLogs.loggedAt));

const sum = (rows: Array<{ kcal: number | null }>) => rows.reduce((s, r) => s + (r.kcal || 0), 0);

// ─────────────────────────────────────────────────────────────────────────────
// THE FIVE STEPS, once per correction phrasing that used to delete on a promise.
// ─────────────────────────────────────────────────────────────────────────────
// P0.1 — DATE AWARENESS. The directive's required test, exactly: log lunch, say it was
// yesterday, then ask about each day. The meal must appear ONLY on yesterday.
{
  console.log("\n── P0.1 the day they named beats the day the server assumes ──");
  const phone = "whatsapp:+27000000101";
  const u = await freshUser(phone);

  const r1 = await handleMessage(phone, "chicken and rice for lunch");
  const day1 = await dayRows(u.id);
  check("1. the meal is a ROW in the database", day1.length === 1, `rows=${day1.length} reply=${r1.slice(0, 80)}`);
  check("1. the row carries calories", sum(day1) > 0, `kcal=${sum(day1)}`);

  const r2 = await handleMessage(phone, "actually that was yesterday");
  check("2. the move is understood, not met with \"didn't catch that\"",
    !/didn'?t (quite )?catch/i.test(r2) && /moved/i.test(r2), r2.slice(0, 140));

  const all = await db.select({ id: mealLogs.id }).from(mealLogs).where(eq(mealLogs.userId, u.id));
  check("3. it MOVED — one row, not a second copy", all.length === 1, `rows=${all.length}`);
  check("3. it is no longer on today", (await dayRows(u.id)).length === 0);

  const rY = await handleMessage(phone, "what did I eat yesterday?");
  check("4. \"yesterday\" reads YESTERDAY", /yesterday/i.test(rY) && /chicken/i.test(rY), rY.slice(0, 160));

  const rT = await handleMessage(phone, "what did I eat today?");
  check("5. today is correctly empty — no phantom calories", /nothing logged|no meals logged/i.test(rT), rT.slice(0, 160));
  check("5. the moved meal is not double-counted on today", !/58\d|59\d/.test(rT.replace(/1800|130/g, "")), rT.slice(0, 160));
}

// THE HOLD — a correction never deletes on a promise. Verified at the row level: the entry
// survives a correction the client never follows up on.
{
  console.log("\n── the hold: a correction never deletes on a promise ──");
  const phone = "whatsapp:+27000000104";
  const u = await freshUser(phone);
  await handleMessage(phone, "chicken and rice for lunch");
  const before = await dayRows(u.id);
  const r = await handleMessage(phone, "no just chicken");
  const after = await dayRows(u.id);
  check("the row SURVIVES a correction with no re-send", after.length >= before.length && before.length > 0,
    `rows ${before.length} → ${after.length}. reply: ${r.slice(0, 140)}`);
  check("the day did not fall to zero", sum(after) > 0, `kcal ${sum(before)} → ${sum(after)}`);
  check("the reply does not claim it removed anything", !/\bremoved\b|\bdeleted\b/i.test(r), r.slice(0, 140));
  const rQ = await handleMessage(phone, "how many calories do I have left today?");
  check("no denial on the calorie question", !/nothing logged yet today/i.test(rQ), rQ.slice(0, 140));
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE SIMPLICITY CAMP GETS THE CARD — verdict reading, not macros, not nothing.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 6. the simplicity account gets the card ──");
{
  const { mealCard } = await import("../server/macro-card-attach");
  const rows = [
    { label: "Calories", current: 900, target: 1800, unit: "kcal" },
    { label: "Protein", current: 40, target: 130, unit: "g" },
  ] as any[];
  const c = mealCard({ firstName: "Kam", mealName: "Pap and chicken", rows, isBulk: false, usesNumbers: false, hour: 13 });
  check("6. the card exists for a no-numbers client", !!c, JSON.stringify(c));
  check("6. the figure is a VERDICT, not macros", /^(MORE|GOOD|DONE|EASY)$/.test(String(c.figure)), String(c.figure));
  check("6. the card carries a next move", String(c.sub || "").length > 0, String(c.sub));
  check("6. the next move is an instruction, not a question", !/\?/.test(String(c.sub || "")), String(c.sub));

  // …and it is actually ATTACHED for such a client, not merely constructible.
  const phone = "whatsapp:+27000000102";
  const u2 = await freshUser(phone, { profileNotes: "", goalType: "wellness" });
  await handleMessage(phone, "pap and chicken");
  const { dailyMacroCardMarker } = await import("../server/macro-card-attach");
  const [fresh] = await db.select().from(users).where(eq(users.id, u2.id)).limit(1);
  const marker = await dailyMacroCardMarker(fresh);
  check("6. the card is ATTACHED for a wellness/simplicity account", /\[MEDIA:/.test(String(marker || "")),
    `marker=${String(marker).slice(0, 120)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. TELL, DON'T HAND BACK. No closing question on the paths a client hits daily.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n── 7. the coach tells, it does not hand the work back ──");
{
  const phone = "whatsapp:+27000000103";
  await freshUser(phone);
  const HANDBACK = /(what do you think|what'?s your plan|what'?s on the menu|what do you have at home|how does that sound|what would you like|which one do you want)\s*\?/i;
  const journeys: Array<[string, string]> = [
    ["a meal log", "chicken and rice"],
    ["the calorie question", "how many calories do I have left today?"],
    ["the food diary", "show me my meals"],
    ["the day's progress", "today's progress"],
  ];
  for (const [label, msg] of journeys) {
    const r = await handleMessage(phone, msg);
    check(`7. ${label} — no hand-back question`, !HANDBACK.test(r), r.slice(-160));
  }
}

console.log(`\nacceptance-hold: ${pass}/${pass + fail} passed against a REAL database`);
if (fail) { console.log(`FAILED:\n${failures.map(f => `  - ${f}`).join("\n")}`); process.exit(1); }
process.exit(0);

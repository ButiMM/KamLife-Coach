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
const { users, mealLogs, turnLedger } = await import("../shared/schema");
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
  // Assert the OUTCOME, not the verb: one owner now writes every correction confirmation, so
  // the sentence may say "Fixed — … on yesterday" or "Moved — …". What must hold is that the
  // turn was understood and the confirmation names the day it landed on.
  check("2. the move is understood, not met with \"didn't catch that\"",
    !/didn'?t (quite )?catch/i.test(r2) && /yesterday/i.test(r2), r2.slice(0, 140));

  const all = await db.select({ id: mealLogs.id }).from(mealLogs).where(eq(mealLogs.userId, u.id));
  check("3. it MOVED — one row, not a second copy", all.length === 1, `rows=${all.length}`);
  check("3. it is no longer on today", (await dayRows(u.id)).length === 0);

  const rY = await handleMessage(phone, "what did I eat yesterday?");
  check("4. \"yesterday\" reads YESTERDAY", /yesterday/i.test(rY) && /chicken/i.test(rY), rY.slice(0, 160));

  const rT = await handleMessage(phone, "what did I eat today?");
  check("5. today is correctly empty — no phantom calories", /nothing logged|no meals logged/i.test(rT), rT.slice(0, 160));
  check("5. the moved meal is not double-counted on today", !/58\d|59\d/.test(rT.replace(/1800|130/g, "")), rT.slice(0, 160));
}

// §5 — THE COMPOUND CORRECTION. Five operations in one turn: MOVE the day, REMOVE the rice,
// REPLACE it with pap, ADD the spinach, and RETAIN the chicken nobody mentioned. Checked at the
// row level, because the reply is not the record — the database is.
{
  console.log("\n── §5 compound correction: remove + retain + add + replace + move, one turn ──");
  const phone = "whatsapp:+27000000105";
  const u = await freshUser(phone);

  await handleMessage(phone, "I had rice and chicken for lunch");
  const t1 = await db.select({ id: mealLogs.id }).from(mealLogs).where(eq(mealLogs.userId, u.id));
  check("turn 1: one meal, dated today", t1.length === 1 && (await dayRows(u.id)).length === 1);
  const originalId = String(t1[0]?.id || "");

  const r2 = await handleMessage(phone, "actually no, that was yesterday. and it wasn't rice, it was pap. and I had spinach too");
  const after = await db.select({ id: mealLogs.id, items: mealLogs.items, at: mealLogs.loggedAt })
    .from(mealLogs).where(eq(mealLogs.userId, u.id));
  const names = (after[0]?.items as any[] || []).map(i => String(i?.name || "").toLowerCase()).join(" | ");

  check("turn 2: still ONE meal — a correction is not a second lunch", after.length === 1, `rows=${after.length}`);
  check("turn 2: the SAME row was mutated, not replaced", String(after[0]?.id) === originalId,
    `${originalId.slice(0, 8)} → ${String(after[0]?.id).slice(0, 8)}`);
  check("turn 2: RETAIN — the chicken nobody mentioned survives", /chicken/.test(names), names);
  check("turn 2: REMOVE — the rice they corrected is gone", !/rice/.test(names), names);
  check("turn 2: REPLACE — pap is on the plate", /pap/.test(names), names);
  check("turn 2: ADD — spinach is on the plate", /spinach/.test(names), names);
  check("turn 2: MOVE — the meal is off today", (await dayRows(u.id)).length === 0);
  check("turn 2: the confirmation is brief, no lecture", r2.length < 220 && !/great|well done|proud/i.test(r2), r2.slice(0, 160));

  const rY = await handleMessage(phone, "what did I eat yesterday?");
  check("turn 3: yesterday reads chicken, pap, spinach",
    /chicken/i.test(rY) && /pap/i.test(rY) && /spinach/i.test(rY) && !/\brice\b/i.test(rY), rY.slice(0, 200));

  const rT = await handleMessage(phone, "what did I eat today?");
  check("turn 4: today is empty", /nothing logged|no meals logged/i.test(rT), rT.slice(0, 140));
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

// WO2 — ONE TURN, TWO OUTCOMES. The demonstrated Journey 4 failure: food + context + emotion +
// an explicit coaching question was reduced to a logging acknowledgement. Both outcomes are
// asserted here — the deterministic food mutation AND that the turn did not end at the food path.
{
  console.log("\n── WO2 multi-intent: food logged AND the coaching question survives ──");
  const phone = "whatsapp:+27000000107";
  const u = await freshUser(phone);

  const J4 = "Ok so yesterday I had pap and beef stew for supper, and this morning just tea, "
    + "I think I walked about 6000 steps maybe more I'm not sure, I missed gym on Monday "
    + "because my back was sore, I'm feeling a bit useless honestly, and tonight there's a "
    + "family thing with lots of food. What do I do about tonight?";

  const reply = await handleMessage(phone, J4);
  const rows = await db.select({ id: mealLogs.id, items: mealLogs.items, at: mealLogs.loggedAt, kcal: mealLogs.kcalInt })
    .from(mealLogs).where(eq(mealLogs.userId, u.id));
  const names = rows.flatMap(r => (r.items as any[] || []).map(i => String(i?.name || "").toLowerCase())).join(" | ");

  // OUTCOME 1 — the deterministic food mutation still happens, on the day they named.
  check("WO2 food is committed", rows.length >= 1, `rows=${rows.length}`);
  check("WO2 pap is logged", /pap/.test(names), names);
  check("WO2 beef stew is logged", /beef|stew/.test(names), names);
  check("WO2 dated YESTERDAY, not today", (await dayRows(u.id)).length === 0,
    `rows on today=${(await dayRows(u.id)).length}`);
  check("WO2 no duplicate food entries", rows.length <= 2, `rows=${rows.length}`);

  // OUTCOME 2 — the turn did NOT end at the food confirmation. Offline the coaching path cannot
  // reach the model, so this asserts the ROUTING changed, not the quality of the answer: the
  // reply is no longer the food-log confirmation. Coaching QUALITY needs the live model and is
  // measured by the six-journey harness, never here.
  const looksLikeFoodConfirmation = /^Got it —|logged\b.*👌|Running total/i.test(reply.trim());
  check("WO2 the turn did NOT end at the food confirmation", !looksLikeFoodConfirmation,
    `reply: ${reply.slice(0, 120)}`);
  check("WO2 the coaching path was reached", /Coach K had a moment|tonight/i.test(reply),
    `offline the brain errors, which still proves the turn continued: ${reply.slice(0, 120)}`);

  // …and an ORDINARY log must keep its confirmation. The narrow predicate is the whole point.
  const plain = await handleMessage(phone, "chicken and rice for lunch");
  check("WO2 an ordinary log still gets its confirmation", /got it|logged|kcal/i.test(plain),
    plain.slice(0, 120));
}

// FIX 3 — BOTH SIDES OF THE DISTINCTION. A past meal report riding with a question must LOG;
// a question about future food must NOT. J3 is a protected journey and this change touched the
// guard that protects it, so the protection is asserted at the row level, not argued.
{
  console.log("\n── fix 3: past report logs, future question does not ──");
  const phone = "whatsapp:+27000000108";

  // PROTECTED: Journey 3's opener. No retro date → the stand-down must hold.
  const u3 = await freshUser(phone);
  const r3 = await handleMessage(phone, "Can I have KFC tonight?");
  const kfcRows = await db.select({ items: mealLogs.items }).from(mealLogs).where(eq(mealLogs.userId, u3.id));
  const kfcNames = kfcRows.flatMap(r => (r.items as any[] || []).map(i => String(i?.name || "").toLowerCase())).join(" | ");
  check("J3 PROTECTED: no food row created by a permission question", kfcRows.length === 0,
    `rows=${kfcRows.length} items=[${kfcNames}] reply=${r3.slice(0, 90)}`);
  check("J3 PROTECTED: no phantom KFC logged", !/kfc|chicken piece/.test(kfcNames), kfcNames);

  // More future/permission phrasings that must never log, all without a retro date.
  for (const q of ["Can I have pap and chicken later?", "Should I eat rice tonight?",
                   "Is beef stew ok for dinner?", "What about eggs tomorrow?"]) {
    const uq = await freshUser(phone);
    await handleMessage(phone, q);
    const n = (await db.select({ id: mealLogs.id }).from(mealLogs).where(eq(mealLogs.userId, uq.id))).length;
    check(`no phantom log from "${q}"`, n === 0, `rows=${n}`);
  }

  // And the other side: a dated past report WITH a question must still log the meal.
  //
  // SCOPED TO THE AUTHORISED CHANGE. Two further phrasings — "…was that too much?" and "…is that
  // ok?" — do NOT log, and they are deliberately not asserted here: they are suppressed by a
  // DIFFERENT clause of hasSubstantiveQuestion (the food-adequacy question test, which matches
  // "too much" and "is that ok"), which fix 3 did not touch and was instructed not to touch. That
  // behaviour is pre-existing, was not demonstrated by any journey, and is REPORTED rather than
  // fixed. Asserting it here would be testing a change nobody authorised.
  // OPEN FINDING, NOT ASSERTED AND NOT FIXED: "I had beef stew last night. Any advice for
  // tonight?" logs NOTHING (0 rows). It carries a retro date and a log trigger, so fix 3 should
  // have admitted it; something upstream of this gate claims the turn first. I did not diagnose
  // it — the cause is NOT RECORDED — because diagnosing and fixing it is outside the authorised
  // change, and no journey demonstrates it. It is written down here so it is not lost.
  for (const r of ["Yesterday I had pap and chicken for supper. What do I do about tonight?"]) {
    const ur = await freshUser(phone);
    await handleMessage(phone, r);
    const n = (await db.select({ id: mealLogs.id }).from(mealLogs).where(eq(mealLogs.userId, ur.id))).length;
    check(`a DATED past report still logs: "${r.slice(0, 42)}…"`, n >= 1, `rows=${n}`);
  }
}

// §6 — THE TURN LEDGER. Observability only: can we reconstruct WHY a turn behaved as it did,
// from the database, without re-reading server logs that may no longer exist?
{
  console.log("\n── §6 turn ledger: one turn, one reconstructable row ──");
  const phone = "whatsapp:+27000000106";
  const u = await freshUser(phone);
  await handleMessage(phone, "I had rice and chicken for lunch");
  await handleMessage(phone, "actually no, that was yesterday. and it wasn't rice, it was pap. and I had spinach too");
  await new Promise(r => setTimeout(r, 900)); // the ledger write is deliberately not awaited

  const turns = await db.select().from(turnLedger).where(eq(turnLedger.userId, u.id)).catch(() => [] as any[]);
  check("§6 a turn leaves a ledger row", turns.length >= 2, `rows=${turns.length}`);
  const correction = turns.find((t: any) => /wasn't rice/i.test(String(t.inputText || "")));
  check("§6 the input is on the record", !!correction, JSON.stringify(turns.map((t: any) => String(t.inputText).slice(0, 30))));
  check("§6 the RESOLVED DAY is on the record", /yesterday/i.test(String(correction?.resolvedDay || "")), String(correction?.resolvedDay));
  const muts = JSON.stringify(correction?.mutations || []);
  check("§6 the MUTATION is on the record — what changed, not just that something did",
    /removed=\[rice\]/.test(muts) && /added=\[/.test(muts), muts);
  check("§6 the reply and the build are on the record",
    String(correction?.reply || "").length > 0 && String(correction?.version || "").length > 0,
    `version=${correction?.version}`);
  check("§6 the ledger costs the client nothing measurable", Number(correction?.replyMs || 0) < 5000, `${correction?.replyMs}ms`);
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

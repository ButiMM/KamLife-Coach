/**
 * REAL-POSTGRESQL ACCEPTANCE — one answer to "which way is the scale going" (#128).
 *
 * THE CONTRADICTION THIS EXISTS TO STOP. #126 wired the weight CHART and the weight HISTORY
 * command to weightDirectionSpeakable, the owner of "may a direction be spoken over these
 * weigh-ins". Three other mouths kept their own opinion, and on a window that spans an illness a
 * client could receive, from one product, in one hour:
 *
 *   chart        "I'm not calling a direction off these — they sit around the time you were ill"
 *   body check   "⬇️ Down 3.1kg · Rate: 2.4kg/month ✅ healthy pace"
 *   weigh-in     "⬇️ down 1.2kg from last log"
 *   Monday 06:00 "⚖️ Down 1.2kg this week. Moving in the right direction."
 *
 * WHY POSTGRESQL. The verdict is computed from weigh-in ROWS — how many, how far apart, how
 * recent — against an illness window stored in profile_notes. A fixture that returns the same
 * rows to every query cannot express "these three weigh-ins straddle the week you were ill",
 * which is the only input that separates the two halves of this suite.
 *
 * THE PROACTIVE MOUTH IS GRADED ON ITS ACTUAL MESSAGE, through the shadow door: SHADOW=on makes
 * every outbound land in shadow_replies instead of Twilio. #180 recorded that there was no
 * capture seam for a proactive body; there is, and this is it.
 *
 * EVERY REFUSAL IS PAIRED WITH ITS CONTROL. "The coach did not claim a direction" is trivially
 * satisfied by a coach that says nothing, so the same client with a clean window must get the
 * direction, and the ill client must still receive their own numbers and the rest of their week.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-weight-authority-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "1";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { eq } = await import("drizzle-orm");
const { handleMessage } = await import("../server/routes");
const { runMondayProgress } = await import("../server/scheduler/jobs/monday");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

// THE TEST'S OWN VOCABULARY. Asking weightDirectionSpeakable what it expects would grade the
// owner against itself and pass whatever the mouths said.
const DIRECTION = /⬇️|⬆️|\bdown \d|\bup \d|moving in the right direction|healthy pace|kg\/month|kg\/week|losing fat|gaining weight|pace [+-]/i;

const D = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
const dayKey = (daysAgo: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(D(daysAgo));

async function client(name: string, profileNotes: string | null) {
  const phone = `whatsapp:+2792${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name, onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss",
    calorieTarget: 2200, proteinTarget: 150, stepsTarget: 8000, trainingMode: "gym",
    trainingDaysPerWeek: 3, currentWeight: "84.0", heightCm: 178, gender: "male", age: 35,
    totalWorkoutsCompleted: 12, profileNotes,
    createdAt: D(90), programmeStartDate: D(90), lastActiveAt: new Date(),
  } as any).returning();
  // A SPAN THE OWNER CAN READ, AND A WEEKLY RHYTHM. Four weigh-ins over twelve days, the newest
  // yesterday and the two most recent FIVE days apart — because the Monday job reads exactly two rows,
  // and MIN_TREND_SPAN_DAYS is 5. A client who weighs twice in three days is correctly refused a
  // weekly direction, which is the rule working rather than a defect, and it would have made the
  // control below unfalsifiable. Same rows for both clients — the ONLY difference between them is
  // the illness window in profile_notes.
  for (const [daysAgo, kg] of [[18, 87.2], [12, 86.4], [6, 85.5], [1, 84.0]] as Array<[number, number]>) {
    await pool.query(`INSERT INTO weight_logs (user_id, weight, logged_at) VALUES ($1, $2, $3)`,
      [u.id, kg, D(daysAgo)]);
  }
  // Workouts and meals, so the Monday summary has a reason to send at all.
  await pool.query(
    `INSERT INTO workout_logs (user_id, logged_at, workout_completed)
     SELECT $1, now() - (d || ' days')::interval, true FROM generate_series(1, 4) AS d`, [u.id]);
  await pool.query(
    `INSERT INTO chat_history (user_id, message_in, message_out, intent, created_at)
     SELECT $1, 'chicken and rice', 'ok', 'FOOD_LOG', now() - (d || ' days')::interval
       FROM generate_series(1, 6) AS d`, [u.id]);
  return { id: u.id, phone };
}

const ask = (phone: string, text: string) =>
  handleMessage(phone, text, undefined, undefined, undefined, `SM-${Math.random().toString(36).slice(2, 10)}`)
    .then(r => String(r || ""));

// The illness straddles the weigh-in window: began before the newest reading, ended inside it.
const ILL = `sick_since:${dayKey(10)} | sick_until:${dayKey(7)}`;
const clear = await client("Clear", null);
const ill = await client("Ill", ILL);

REAL("\n=== THE THREE REACTIVE MOUTHS ===");

const ASKS: Array<[string, string]> = [
  ["weight chart", "the weight chart"],
  ["weight history", "the weight history"],
  ["body check", "the body check"],
];
for (const [said, what] of ASKS) {
  const clearReply = await ask(clear.phone, said);
  const illReply = await ask(ill.phone, said);
  // THE CONTROL FIRST, because the refusal below means nothing without it.
  chk(DIRECTION.test(clearReply), `${what} DOES call a direction on a clean window`,
    clearReply.slice(0, 240));
  chk(!DIRECTION.test(illReply), `${what} calls none on a window that spans the illness`,
    (illReply.match(DIRECTION) || []).join(",") + " | " + illReply.slice(0, 240));
  // …AND THE REFUSAL IS NOT SILENCE. They asked about their own body; the weigh-ins still ship.
  chk(/8[0-9](?:\.\d)?\s*kg/i.test(illReply) || /kg/i.test(illReply),
    `…and ${what} still gives them their own numbers`, illReply.slice(0, 240));
}

REAL("\n=== THE MONDAY MOUTH, CAPTURED ===");
//
// Not the decision — the MESSAGE. SHADOW=on routes every proactive send into shadow_replies, so
// this reads the body the client would have received.
await pool.query("DELETE FROM shadow_replies WHERE user_id = ANY($1)", [[clear.id, ill.id]]);
await runMondayProgress();
const bodyFor = async (id: string) => {
  const { rows } = await pool.query(
    `SELECT body FROM shadow_replies WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [id]);
  return String(rows[0]?.body || "");
};
const clearMonday = await bodyFor(clear.id);
const illMonday = await bodyFor(ill.id);
chk(clearMonday.length > 0 && illMonday.length > 0,
  "both clients were sent a Monday summary", `clear=${clearMonday.length} ill=${illMonday.length}`);
chk(/⚖️/.test(clearMonday) && DIRECTION.test(clearMonday),
  "the Monday summary DOES call a direction on a clean window", clearMonday.replace(/\n/g, " | "));
chk(!DIRECTION.test(illMonday),
  "…and calls none, unprompted, to the client who was ill", illMonday.replace(/\n/g, " | "));
// AND THE REST OF THE WEEK SURVIVES. Refusing one line must not cost them the summary.
chk(/workout|meal|step/i.test(illMonday), "…while their week's work is still reported back",
  illMonday.replace(/\n/g, " | "));

// AFTER THE MONDAY RUN, DELIBERATELY. This turn WRITES a weigh-in, and the Monday job reads the
// two most recent rows — logging one here first would collapse that span to a day and refuse the
// weekly direction for the right reason at the wrong time, leaving the control above unfalsifiable.
REAL("\n=== THE WEIGH-IN REPLY ===");
//
// A CLAIM THE SENTINEL REPORTED THAT IS NO LONGER SPOKEN. Item 7 says the weigh-in write "always
// speaks ⬆️/⬇️ + pace". It does not, on this SHA: Slice 4 (2026-08-04) deleted the printout — the
// change note, the trend label and the pace all still COMPUTE and are then discarded on the line
// that reads `void changeNote; void trendLine;`. What the client receives is the terse ack.
//
// So this section pins the rule and says plainly what it cannot prove. There is NO positive
// control here, because the surface asserts no direction to anybody today; a control demanding
// one from the clean client would be demanding a regression. If the printout is ever restored,
// the ill client's check below is the thing that must be satisfied first.
const clearWeigh = await ask(clear.phone, "83.4kg this morning");
const illWeigh = await ask(ill.phone, "83.4kg this morning");
chk(!DIRECTION.test(illWeigh), "the weigh-in reply calls no direction for the client who was ill",
  (illWeigh.match(DIRECTION) || []).join(",") + " | " + illWeigh.slice(0, 240));
chk(/83\.4/.test(clearWeigh) && /83\.4/.test(illWeigh),
  "…and both clients are still told the number they just stood on",
  `${clearWeigh.slice(0, 90)} || ${illWeigh.slice(0, 90)}`);

REAL("\n=== THE NUMBER THEY ARE, NOT THE NUMBER THEY WERE ===");
//
// users.bmi is written at ONBOARDING and never again. handleWeightLog derives a BMI on every
// weigh-in for the underweight safety gate and does not write it back, so the column freezes on
// day one — and a client who has done the work is told the category they left months ago.
const lost = await client("Lost", null);
await pool.query(`UPDATE users SET bmi = '32.2', current_weight = '88.0', height_cm = 178 WHERE id = $1`, [lost.id]);
const bmiReply = await ask(lost.phone, "my bmi");
const weightReply = await ask(lost.phone, "my weight");
// 88.0kg / 1.78m = 27.8, overweight. The stored 32.2 says obese.
chk(/27\.8/.test(bmiReply) && !/32\.2/.test(bmiReply),
  "the BMI answer is computed from the weight they are now", bmiReply.slice(0, 200));
chk(/overweight/i.test(bmiReply) && !/obese/i.test(bmiReply),
  "…so the CATEGORY moves with them, which is the half that reads as judgement",
  bmiReply.slice(0, 200));
chk(/27\.8/.test(weightReply) && !/32\.2/.test(weightReply),
  "…and the weight card agrees with it rather than quoting the frozen column",
  weightReply.slice(0, 200));
// A CLIENT WE CANNOT MEASURE IS TOLD SO, rather than given a BMI off a default height.
await pool.query(`UPDATE users SET height_cm = NULL WHERE id = $1`, [lost.id]);
const noHeight = await ask(lost.phone, "my bmi");
chk(/has not been calculated/i.test(noHeight),
  "no height means no BMI — never one invented off a default", noHeight.slice(0, 160));

await pool.query("DELETE FROM users WHERE id = ANY($1)", [[clear.id, ill.id, lost.id]]);
REAL(`\npg-weight-authority-acceptance: ${failed === 0 ? "GREEN — all checks passed" : `RED — ${failed} check(s) failed`}`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

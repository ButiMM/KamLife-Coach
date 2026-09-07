/**
 * REAL-POSTGRESQL ACCEPTANCE — one weight authority, one speakability verdict (#216).
 *
 * THE RULE THIS ENFORCES. Every weight-derived sentence a client can receive must come from the
 * same canonical weight truth and obey the same speakability verdict. Six defects, each traced
 * through the real front door and the real Monday job on main@b1e401e before anything changed:
 *
 *   MONDAY read weight_logs directly, newest two rows, and so:
 *     · a client whose trend was refused for ILLNESS still read
 *       "🎯 At this pace: *78kg in ~5 weeks*" — the projection sat outside the gate entirely;
 *     · a client with four readings across seventeen days was refused a weekly direction
 *       because the two NEWEST happened to be a day apart;
 *     · a client who had asked us to drop the scale was sent, unprompted, on a Monday,
 *       "⚖️ Down 1.5kg this week. Moving in the right direction."
 *
 *   BODY CHECK answered an illness refusal with "not enough clear weigh-ins to call a
 *   direction" — to a client with four clean weigh-ins. The readings were never the problem.
 *
 *   THE PROGRESS CARD spoke "(down 3.2kg)" for the same client, in the same minute, off the same
 *   rows that the body check had just refused to call.
 *
 *   "what's my BMI?" and "my weight?" reached no owner at all — a question mark was the only
 *   difference between an answer and "Tell me what you ate today".
 *
 * WHY POSTGRESQL. Illness contamination, window width and chronology are all properties of stored
 * rows against stored dates. SHADOW=on routes every proactive send into shadow_replies, so the
 * Monday claims are graded on the MESSAGE a client would have received, not on the decision.
 *
 * EVERY CLAIM IS PAIRED WITH ITS CONTROL. "The scale said nothing" is trivially satisfied by a
 * build that never speaks about weight, which is the opposite defect: a client doing well and
 * never told so.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-weight-speakability-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
const { handleMessage } = await import("../server/routes");
const { runMondayProgress } = await import("../server/scheduler/jobs/monday");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

/** THE SUITE'S OWN VOCABULARY — asking the owner what it expects would grade it against itself. */
const DIRECTION = /⬇️|⬆️|\bdown \d|\bup \d|moving in the right direction|at this pace|kg\/week|kg\/month/i;

const D = (d: number) => new Date(Date.now() - d * 86_400_000);
const dayKey = (d: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(D(d));
const ids: string[] = [];

/** Four readings across eighteen days, newest yesterday: a real, adequate weekly rhythm. */
const WEEKLY: Array<[number, number]> = [[18, 87.2], [12, 86.4], [6, 85.5], [1, 84.0]];

async function client(name: string, over: Record<string, any> = {}, readings = WEEKLY) {
  const phone = `whatsapp:+2792${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name, onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss",
    calorieTarget: 2200, proteinTarget: 150, stepsTarget: 8000, trainingMode: "gym",
    trainingDaysPerWeek: 3, currentWeight: "84.0", heightCm: 178, gender: "male", age: 35,
    targetWeightKg: "78.0", totalWorkoutsCompleted: 12,
    createdAt: D(90), programmeStartDate: D(90), lastActiveAt: new Date(), ...over,
  } as any).returning();
  ids.push(u.id);
  for (const [daysAgo, kg] of readings) {
    await pool.query(`INSERT INTO weight_logs (user_id, weight, logged_at) VALUES ($1,$2,$3)`,
      [u.id, kg, D(daysAgo)]);
  }
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

async function monday(id: string): Promise<string> {
  await pool.query("DELETE FROM shadow_replies WHERE user_id = $1", [id]);
  await pool.query("DELETE FROM daily_sends WHERE user_id = $1", [id]).catch(() => {});
  await runMondayProgress();
  const r = await pool.query(
    "SELECT body FROM shadow_replies WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [id]);
  return String(r.rows[0]?.body || "(nothing sent)");
}

/** Illness straddling the window: began before the newest reading, ended inside it. */
const ILL = `sick_since:${dayKey(10)} | sick_until:${dayKey(7)}`;

REAL("\n=== MONDAY SPEAKS UNDER ONE VERDICT ===");

// ── 1 + 7 — the projection obeys the same gate as the weekly line ───────────────────────────
{
  const ill = await client("Ill", { profileNotes: ILL });
  const msg = await monday(ill.id);
  chk(!/at this pace/i.test(msg),
    "1 · an illness-refused trend gets no `At this pace` projection", JSON.stringify(msg));
  chk(!DIRECTION.test(msg),
    "7 · …and NOTHING on that surface claims a weight direction", JSON.stringify(msg));
  chk(/your week/i.test(msg) && /workout/i.test(msg),
    "…while the rest of the Monday summary is still sent", JSON.stringify(msg.slice(0, 120)));

  // CONTROL — a clear client on the SAME readings must still get both. The only difference
  // between these two clients is the illness window in profile_notes.
  const clear = await client("Clear");
  const ok = await monday(clear.id);
  chk(/at this pace/i.test(ok), "CONTROL: a clear trend still gets the projection",
    JSON.stringify(ok));
  chk(DIRECTION.test(ok), "CONTROL: …and still gets its weekly direction", JSON.stringify(ok));
}

// ── 2 — an adequate weekly window, not the newest two rows ──────────────────────────────────
{
  // Four readings over eighteen days — a real trend — but the two NEWEST are one day apart.
  const tight = await client("Tight", {}, [[18, 87.2], [12, 86.4], [2, 84.4], [1, 84.0]]);
  const msg = await monday(tight.id);
  // THE WEEKLY LINE SPECIFICALLY, not merely "something spoke". The projection matches the broader
  // DIRECTION pattern too, and on the unfixed build it is the projection that speaks while the
  // weekly line stays silent — so asserting DIRECTION alone passed on BOTH builds and proved
  // nothing. Isolated on real PostgreSQL, the difference is exactly this line:
  //   baseline  💪 … 🍽️ … 🎯 At this pace: *78kg in ~5 weeks*
  //   fixed     💪 … 🍽️ … ⚖️ Down 0.4kg this week … 🎯 At this pace: …
  chk(/⚖️/.test(msg) && /this week/i.test(msg),
    "2 · an adequate week is read even when the newest two readings are a day apart",
    JSON.stringify(msg));
  // CONTROL — a genuinely thin window is still refused. Two readings, two days apart, nothing
  // else: MIN_TREND_SPAN_DAYS is 5 and this must not clear it.
  const thin = await client("Thin", {}, [[3, 84.4], [1, 84.0]]);
  chk(!DIRECTION.test(await monday(thin.id)),
    "CONTROL: a genuinely short window is still refused a direction");
}

// ── 5 — doNotMention ────────────────────────────────────────────────────────────────────────
{
  const quiet = await client("Quiet", { doNotMention: "weight" });
  const msg = await monday(quiet.id);
  // NO WORD BOUNDARY BEFORE `kg` IN "1.5kg" — the first version of this asked for /\bkg\b/ and
  // passed on the very message it was written to catch:
  //   "⚖️ Down 1.5kg this week. (3.2kg total since you started) Moving in the right direction."
  // Graded on the scale SYMBOL and on the claim, which is what the client actually reads.
  chk(!/⚖️|🎯|\d\s?kg|\b(weigh|weight|scale)/i.test(msg),
    "5 · a client who ruled out the scale reads no weight claim on Monday", JSON.stringify(msg));
  chk(/your week/i.test(msg), "…and still gets their Monday summary", JSON.stringify(msg.slice(0, 100)));
}

REAL("\n=== THE REACTIVE SURFACES AGREE WITH IT, AND WITH EACH OTHER ===");

// ── 4 + 7 — the stated reason, and one verdict across surfaces ──────────────────────────────
{
  const ill = await client("IllNow", { profileNotes: ILL });
  const body = await ask(ill.phone, "check my body");
  chk(/ill\b|illness|you were ill/i.test(body),
    "4 · an illness refusal says ILLNESS", JSON.stringify(body.slice(0, 240)));
  chk(!/not enough clear weigh-ins/i.test(body),
    "…and does not falsely claim the readings were insufficient", JSON.stringify(body.slice(0, 240)));
  chk(/87\.2|84\.0/.test(body), "…while the readings themselves still ship",
    JSON.stringify(body.slice(0, 200)));

  const progress = await ask(ill.phone, "how am I doing");
  chk(!DIRECTION.test(progress),
    "7 · the progress card does not speak a direction the body check just refused",
    JSON.stringify(progress));
  chk(/84/.test(progress), "…and still shows their current weight", JSON.stringify(progress));

  // CONTROL — a clear client gets the direction on BOTH surfaces.
  const clear = await client("ClearToo");
  chk(DIRECTION.test(await ask(clear.phone, "check my body")),
    "CONTROL: a clear trend is still called on the body check");
  chk(DIRECTION.test(await ask(clear.phone, "how am I doing")),
    "CONTROL: …and on the progress card");
}

// ── 3 — an old illness must not suppress a clean recent trend for ever ──────────────────────
{
  const old = await client("OldIllness", {
    profileNotes: `sick_since:${dayKey(80)} | sick_until:${dayKey(75)}`,
  });
  chk(DIRECTION.test(await ask(old.phone, "check my body")),
    "3 · an illness eighty days ago does not suppress a clean recent trend");
}

REAL("\n=== WEIGHT AND BMI QUESTIONS REACH THEIR OWNERS ===");

// ── 6 — a question mark is not a routing decision ───────────────────────────────────────────
{
  const c = await client("Router");
  for (const q of ["what's my BMI?", "what is my bmi", "my bmi"]) {
    chk(/your bmi is/i.test(await ask(c.phone, q)), `6 · \`${q}\` reaches the BMI owner`);
  }
  for (const q of ["my weight?", "my weight", "how much do I weigh"]) {
    chk(/your weight/i.test(await ask(c.phone, q)), `6 · \`${q}\` reaches the weight owner`);
  }
  // CONTROL — widening the match must not swallow neighbouring questions that have their own
  // owners. "weight chart" is a different surface and must stay on it.
  chk(/chart|graph|history|weigh-ins/i.test(await ask(c.phone, "weight chart")),
    "CONTROL: `weight chart` still reaches the chart owner, not the weight value");
}

REAL(`\n${failed === 0 ? "pg-weight-speakability-acceptance: GREEN — all checks passed" : `pg-weight-speakability-acceptance: RED — ${failed} check(s) failed`}`);

for (const id of ids) {
  for (const t of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_logs",
                   "chat_history", "turn_ledger", "shadow_replies"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
}
await pool.end();
process.exit(failed === 0 ? 0 : 1);

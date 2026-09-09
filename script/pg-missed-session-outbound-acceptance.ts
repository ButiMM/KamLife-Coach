/**
 * REAL-POSTGRESQL ACCEPTANCE — the missed-session answer survives the outbound floor (#233).
 *
 * THE LIVE FAILURE, on 06330d2. A client typed "I didn't train" and received:
 *
 *     "Let me check that properly before I answer — give me one sec and ask me again."
 *
 * …and on repeating themselves, the duplicate-meta reply. The truthful owner had composed the
 * right answer and the outbound truth floor threw it away:
 *
 *     enforceOutboundTruth -> session_count_contradicts_record: "said 1, record holds 0 in 7 days"
 *
 * THE CAUSE, and it is one word. `SESSION_COUNT` permits up to two filler words between a number
 * and the noun, so "3 gym sessions this week" reads. That window also admits the word that
 * REVERSES the claim: "**One missed session**" extracted as a claim of 1 session completed, which
 * the record denied. The floor was right that no session happened; the sentence was saying so.
 *
 * A second, independent block sat behind it: the same reply states "You have 8 sessions
 * completed", a LIFETIME figure, checked against a SEVEN-DAY record. #221 already settled how a
 * lifetime number must read — "8 sessions overall" — and the floor already knows four other
 * lifetime markers. It did not know that one.
 *
 * GRADED ON THE BODY AFTER TRANSPORT. `processTextAsync` is the reactive path that calls
 * sendFinal → prepareOutbound → the floor, so these checks read what the client would actually
 * receive. Calling handleMessage alone proves only what a handler intended, which is precisely the
 * gap that let this ship: the handler's return was correct the whole time.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-missed-session-outbound-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { processTextAsync } = await import("../server/routes/whatsapp");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");
const { REACTIVE_OUTBOUND_REPAIR } = await import("../server/outbound-authority");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

const midday = (n: number) => {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" })
    .format(new Date(Date.now() - n * 86_400_000));
  return new Date(`${key}T12:00:00+02:00`);
};

const ids: string[] = [];
async function client(name: string, over: Record<string, any> = {}) {
  const phone = `whatsapp:+2791${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name, onboardingState: "COMPLETE", subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(), goalType: "fat_loss",
    calorieTarget: 2200, proteinTarget: 150, stepsTarget: 8000, trainingMode: "gym",
    trainingDaysPerWeek: 3, currentWeight: "84.0", heightCm: 178, gender: "male", age: 35,
    weeklyFoodBudget: "300_600", totalWorkoutsCompleted: 8,
    programmeStartDate: midday(30), programmeWeek: 3, programmeDayInWeek: 2, programmePhase: 1,
    lastActiveAt: new Date(), ...over,
  } as any).returning();
  ids.push(u.id);
  return { id: u.id, phone };
}

/** THE BODY AFTER TRANSPORT — sendFinal's own output, read off the shadow door. */
async function outbound(phone: string, text: string): Promise<string> {
  await pool.query("DELETE FROM shadow_replies").catch(() => {});
  await processTextAsync(phone, text, null, null, [], handleMessage as any,
    `SM-${Math.random().toString(36).slice(2, 10)}`);
  const { rows } = await pool.query<{ body: string }>("SELECT body FROM shadow_replies ORDER BY id ASC")
    .catch(() => ({ rows: [] as any[] }));
  return rows.map(r => r.body).join("\n\n");
}

/** An instruction to train TODAY — the thing a rest/miss answer must never contain. */
const TRAIN_TODAY = /\b(?:do|get|finish|start|complete|hit)\b[^.!?\n]{0,40}\b(?:today'?s session|today'?s workout)\b|\b(?:train|get to the gym)\b[^.!?\n]{0,30}\b(?:today|tonight)\b/i;
const DUPLICATE_META = /gave you the same answer twice/i;

REAL("\n=== 1 · \"I didn't train\" REACHES THE CLIENT ===");
{
  _resetOutboundDedupe();
  const c = await client("Sipho");
  const body = await outbound(c.phone, "I didn't train");

  chk(body.length > 0, "the turn produced an outbound body", JSON.stringify(body.slice(0, 80)));
  chk(!body.includes(REACTIVE_OUTBOUND_REPAIR),
    "it is NOT the generic outbound repair", JSON.stringify(body.slice(0, 120)));
  chk(!DUPLICATE_META.test(body), "…and not the duplicate-meta reply", JSON.stringify(body.slice(0, 120)));
  chk(/miss(ed)?/i.test(body), "…it acknowledges the missed session",
    JSON.stringify(body.split("\n")[0]));
  chk(/pick the time|when you train next/i.test(body),
    "…and gives one valid next move", JSON.stringify(body.slice(-90)));
  chk(!TRAIN_TODAY.test(body), "…without instructing them to train TODAY",
    JSON.stringify(body.slice(0, 200)));

  // The lifetime figure is stated AS lifetime — #221's settled rule, and the second block here.
  chk(!/\d+ sessions completed/i.test(body),
    "…and its lifetime count does not read as a seven-day claim",
    JSON.stringify((body.match(/[^\n]*sessions[^\n]*/) || [""])[0]));
}

REAL("\n=== 2 · REPEATING IT IS NOT PUNISHED FOR THE FIRST ANSWER BEING BLOCKED ===");
{
  // Requirement 4 exactly: the duplicate floor is a real safety rule and stays. What must not
  // happen is a client meeting it because the FIRST answer never went out. Once the first answer
  // is delivered, a later identical turn outside the dedupe window gets the same real answer.
  _resetOutboundDedupe();
  const c = await client("Naledi");
  const first = await outbound(c.phone, "I didn't train");
  chk(!first.includes(REACTIVE_OUTBOUND_REPAIR), "the first answer is delivered, not repaired",
    JSON.stringify(first.slice(0, 90)));

  _resetOutboundDedupe();                       // a later turn, outside the dedupe window
  const later = await outbound(c.phone, "I didn't train");
  chk(!later.includes(REACTIVE_OUTBOUND_REPAIR) && !DUPLICATE_META.test(later),
    "…and saying it again later gets the real answer, not a meta-reply about repetition",
    JSON.stringify(later.slice(0, 120)));
}

REAL("\n=== 3 · CONTROL — THE TRUTH FLOOR STILL BLOCKS A REAL FALSE CLAIM ===");
{
  // The opposite defect. Loosening the floor until a genuine overstatement passes would satisfy
  // every check above. A claim that sessions WERE completed, against a record holding none, must
  // still be refused — that is the rule this cut narrows, not the rule it removes.
  const { enforceOutboundTruth } = await import("../server/outbound-authority");
  const c = await client("Thabo");
  const lie = await enforceOutboundTruth(c.id, c.phone,
    "Strong week — you got 4 sessions done. Keep that going.", null);
  chk(lie.ok === false && lie.reason === "session_count_contradicts_record",
    "CONTROL: a completed-session count the record denies is still blocked", JSON.stringify(lie));

  const miss = await enforceOutboundTruth(c.id, c.phone,
    "One missed session — that is all it is.", null);
  chk(miss.ok === true, "…while a count of MISSES is not read as a claim of sessions done",
    JSON.stringify(miss));
}

REAL("\n=== 4 · THE PEAR AND THE MESSY CATCH-UP ARE UNCHANGED ===");
{
  _resetOutboundDedupe();
  const c = await client("Zanele");
  const pear = await outbound(c.phone, "I had a pear");
  chk(!pear.includes(REACTIVE_OUTBOUND_REPAIR), "the pear turn still reaches the client",
    JSON.stringify(pear.slice(0, 90)));
  chk(!/breakfast|lunch|dinner|supper/i.test(pear),
    "…and still invents no meal slot (#234 holding at the outbound body)",
    JSON.stringify(pear.slice(0, 140)));

  _resetOutboundDedupe();
  const b = await client("Bonolo", { lastActiveAt: midday(4) });
  const catchup = await outbound(b.phone,
    "I'm back after a few days. Saturday breakfast I had eggs and rice. Sunday I walked 6400 steps "
    + "and I can't remember lunch. Monday I felt flat because work was chaos, but I did the workout "
    + "you told me to do. Today breakfast I had pap and chicken. What should I do today?");
  chk(!catchup.includes(REACTIVE_OUTBOUND_REPAIR), "the four-day catch-up still reaches the client",
    JSON.stringify(catchup.slice(0, 90)));
  chk(!/no catch-?up needed|we start from today/i.test(catchup),
    "…with no refusal and no start-from-today language", JSON.stringify(catchup.slice(0, 140)));
  chk(!/lunch was|for lunch you had/i.test(catchup), "…and the unknown lunch stays unknown",
    JSON.stringify((catchup.match(/[^\n]*lunch[^\n]*/) || ["(not mentioned)"])[0]));
}

REAL("\n=== 5 · THE CATCH-UP ANSWERS THE QUESTION IT WAS ASKED (Gate 3) ===");
{
  _resetOutboundDedupe();
  const c = await client("Bonolo", { lastActiveAt: midday(4) });
  const body = await outbound(c.phone,
    "I'm back after a few days. Saturday breakfast I had eggs and rice. Sunday I walked 6400 steps "
    + "and I can't remember lunch. Monday I felt flat because work was chaos, but I did the workout "
    + "you told me to do. Today breakfast I had pap and chicken. What should I do today?");

  // The facts stay exactly as #233 already landed them.
  chk(/Saturday/i.test(body) && /Sunday/i.test(body) && /Monday/i.test(body),
    "the days the client reported are all named back", JSON.stringify(body.slice(0, 120)));
  chk(!/no catch-?up needed|we start from today/i.test(body),
    "…no refusal and no start-from-today language", JSON.stringify(body.slice(0, 140)));
  chk(!/lunch was|for lunch you had/i.test(body), "…the unknown lunch stays unknown",
    JSON.stringify((body.match(/[^\n]*lunch[^\n]*/) || ["(not mentioned)"])[0]));

  const closing = body.trim().split("\n").filter(l => l.trim()).slice(-1)[0] || "";

  // THE EXACT SENTENCE, pinned deterministically. The rung's wording turns tomorrow-facing after
  // 20:00 — a rule that predates this cut and stays — so asserting it through the body alone would
  // pass or fail on the hour CI happened to run, the run-hour dependence removed from two suites in
  // #221. So it is pinned at a fixed hour on the rung itself, and the body is asserted to carry a
  // fuelling move and never the old receipt wording, whatever the clock says.
  const { chooseAction } = await import("../server/one-action");
  const atMidday = chooseAction({
    firstName: "Bonolo", goal: "fat_loss", weeksOnProgramme: 3, daysSinceAnyLog: 0,
    daysSinceWeighIn: 40, loggedToday: true, proteinPct: 0.37, caloriePct: 0.27,
    sessionsThisWeek: 3, sessionsTarget: 3, stepsToday: 6400, stepsTarget: 8000, sick: false,
    hour: 13, atKeyboard: true, asksAboutToday: true, justAteProteinMeal: true,
  } as any);
  chk(atMidday.todo === "For today, make your next meal another proper protein meal. That's your one move.",
    "the fuelling rung's move is the exact adjudicated sentence", JSON.stringify(atMidday.todo));

  chk(!/one proper protein down — same again at your next meal/i.test(body),
    "…and the old receipt wording is gone from the body", JSON.stringify(closing));
  chk(/proper protein meal|proper protein down — start tomorrow/i.test(closing),
    "the closing answer is the fuelling rung's move", JSON.stringify(closing));

  chk(!/Nothing new today/i.test(body),
    "…it is not the hold copy", JSON.stringify(closing));
  chk(!/do exactly what you did yesterday/i.test(body),
    "…and it does not invent a yesterday there is no evidence for", JSON.stringify(closing));
  chk(!/scale (tomorrow|tonight)|tomorrow morning/i.test(closing),
    "…nor a task for another day", JSON.stringify(closing));
  chk(closing.trim().length > 0 && !/next move stays small\.?$/i.test(closing),
    "…and the turn does not end on an acknowledgement with no move", JSON.stringify(closing));
  chk(!body.includes(REACTIVE_OUTBOUND_REPAIR), "…and the body is not the generic repair",
    JSON.stringify(body.slice(0, 90)));
}

REAL("\n=== 6 · CONTROL — ORDINARY SPARSE TURNS ARE UNCHANGED ===");
{
  // #203 is narrowed for one case, not disabled. A client who did NOT ask what to do today must
  // still meet the investigation ladder exactly as before — otherwise this cut has quietly turned
  // the sparse-client downgrade off for everyone.
  const { underPolicy, chooseAction } = await import("../server/one-action");
  const fuelling = { kind: "protein", todo: "Make your next meal a protein one.", why: "x" } as any;
  const sparse = { foodSufficient: false, weightSufficient: false, loggedToday: true,
    daysSinceWeighIn: null as number | null, hour: 19 };

  chk(underPolicy(fuelling, sparse).kind === "weigh",
    "CONTROL: without a today-question the downgrade still investigates, unchanged",
    JSON.stringify(underPolicy(fuelling, sparse)));

  const asked = underPolicy(fuelling, { ...sparse, asksAboutToday: true });
  chk(asked.kind === "protein" && asked.todo === fuelling.todo,
    "…and with one, the today-scoped rung the ladder already chose is what stands",
    JSON.stringify(asked));

  // …and the weigh itself is untouched when it IS today's job.
  const day = { firstName: "T", goal: "fat_loss", weeksOnProgramme: 3, daysSinceAnyLog: 0,
    daysSinceWeighIn: 40, loggedToday: true, proteinPct: 1, caloriePct: 1, sessionsThisWeek: 3,
    sessionsTarget: 3, stepsToday: 9000, stepsTarget: 8000, sick: false, atKeyboard: true } as any;
  chk(chooseAction({ ...day, hour: 8, asksAboutToday: true }).kind === "weigh",
    "CONTROL: before midday a today-question still reaches the weigh rung",
    JSON.stringify(chooseAction({ ...day, hour: 8, asksAboutToday: true })));
  chk(chooseAction({ ...day, hour: 19, asksAboutToday: false }).kind === "weigh",
    "CONTROL: …and after midday it is unchanged for any turn that did not ask about today",
    JSON.stringify(chooseAction({ ...day, hour: 19, asksAboutToday: false })));
}

REAL(`\n${failed === 0
  ? "pg-missed-session-outbound-acceptance: GREEN — all checks passed"
  : `pg-missed-session-outbound-acceptance: RED — ${failed} check(s) failed`}`);

await pool.query("DELETE FROM shadow_replies").catch(() => {});
for (const id of ids) {
  for (const t of ["meal_logs", "step_logs", "weight_logs", "workout_logs", "chat_history",
                   "turn_ledger", "client_understanding", "daily_constraints"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
}
await pool.end();
process.exit(failed === 0 ? 0 : 1);

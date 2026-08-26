/**
 * THE CANONICAL TRACKING CONTRACT (2026-08-26, issue #63).
 *
 * Every tracked fact — steps, water, weight, workouts, food — travels the same five stages:
 *
 *     natural-language report
 *        -> ONE recogniser      ("is this a report of this fact?")
 *        -> ONE extractor       ("what is the value?")
 *        -> ONE write owner     ("commit the state transition")
 *        -> ONE action          ("what does this change about the coaching?")
 *        -> ONE response        ("what does the client read?")
 *
 * and the contract has exactly two laws:
 *
 *   LAW 1 — RECOGNISER AND EXTRACTOR MUST AGREE.
 *     If the recogniser says "yes, a step report" and the extractor returns zero, the fact is
 *     destroyed silently between two owners of the same question. That was the live failure in
 *     #71: "my steps are 10k today" was recognised and extracted as nothing, the coaching ladder
 *     saw no steps, and a client who had just walked 10 000 was told to go for a walk.
 *
 *   LAW 2 — A QUESTION OR AN INTENTION CANNOT MUTATE TRACKING STATE.
 *     A missed write is visible to the client and correctable by them. A FALSE write is neither:
 *     it enters the trend, the progress card, the auto-adjust engine and every coaching decision
 *     downstream, and the client never sees the row that is lying about them. Measured on main
 *     before this suite existed:
 *
 *         "I need to do 10000 steps"  ->  10 000 steps written; client walked none
 *         "I want to weigh 85kg"      ->  85kg written as today's measurement for a client on
 *                                         the scale at 95kg, calorie and protein targets
 *                                         recalculated off it, and the reply was
 *                                         "🏆 you hit 85kg — that's the goal, done."
 *
 * WHY THIS FILE IS BEHAVIOURAL AND NOT A PREDICATE TEST. Both defects above sat in code whose
 * predicates were individually defensible. The steps gate already asked isFutureIntent and got a
 * truthful "false" — the vocabulary simply lacked "need to". The weight branch never asked at
 * all, while the two sibling branches either side of it in the same file always had. Neither is
 * visible from any one predicate's unit test; both are obvious the moment you ask the only
 * question that matters — DID THE TURN WRITE? So this suite drives real messages through
 * handleMessage and reads the writes the stub recorded, in both directions:
 *
 *     questions and intentions  -> MUST NOT write   (the invariant)
 *     real reports              -> MUST still write (the negative control)
 *
 * The second half is not optional. Every guard added here can be made to pass by refusing more,
 * and refusing more trades a false write for a lost one. The control is what stops that trade.
 *
 * WHY utils.isFutureIntent STAYS NARROW. It is the shared owner of "this states a plan, not a
 * report", and the obvious repair — pour every intention-shaped phrase into it — is wrong.
 * "had to" and "trying to" are excluded on purpose: "I had to walk 5km to the taxi rank" and
 * "trying to lose weight, weighed 84kg this morning" are REPORTS carrying a real measurement, and
 * a floor wide enough to eat them has simply moved the damage from a false write to a lost one.
 * The MUST_WRITE list below holds that line; widen the vocabulary and it is what pushes back.
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

const NOW = Date.now();

/** A settled client mid-programme: onboarded, subscribed, consented, with a real weight gap
 *  (95kg now, 85kg target) so a goal-as-measurement write is unmistakable when it happens. */
const USER = {
  id: "qa", phoneNumber: "whatsapp:+27000000070", name: "Kam",
  onboardingState: "COMPLETE", onboardingComplete: true, subscriptionStatus: "active",
  popiConsent: true, popiConsentAt: new Date(NOW - 30 * 86_400_000),
  goalType: "fat_loss", currentWeight: 95, targetWeight: 85,
  heightCm: 180, age: 35, gender: "male", activityLevel: "moderate",
  trainingMode: "gym", trainingDaysPerWeek: 3,
  programmePhase: 1, programmeWeek: 1, programmeDayInWeek: 2,
  programmeStartDate: new Date(NOW - 35 * 86_400_000), totalWorkoutsCompleted: 24,
  injuries: "none", medicalConditions: "none", awaitingInputType: null, profileNotes: "",
  todayWater: "0", calorieTarget: 2700, proteinTarget: 180,
  stepTarget: 10000, stepsTarget: 10000,
  lastActiveAt: new Date(NOW - 3_600_000), createdAt: new Date(NOW - 35 * 86_400_000),
};

/** LAW 2. Questions and stated intentions across every tracked surface. None may write. */
const MUST_NOT_WRITE: [string, string][] = [
  ["steps", "How many steps have I done?"],
  ["steps", "Is 8000 steps enough?"],
  ["steps", "Should I do 10000 steps?"],
  ["steps", "Do steps matter?"],
  ["steps", "what are my steps today?"],
  ["steps", "I need to do 10000 steps"],
  ["water", "How much water should I drink?"],
  ["water", "Is 2 litres of water enough?"],
  ["water", "what is my water today?"],
  ["water", "I need to drink 2 litres"],
  ["water", "should I drink 3 litres of water?"],
  ["weight", "What is my weight?"],
  ["weight", "Should I weigh 85kg?"],
  ["weight", "Is 92kg good?"],
  ["weight", "I want to weigh 85kg"],
  ["weight", "my target weight is 85kg"],
  ["workout", "Is my workout done?"],
  ["workout", "Have I trained today?"],
  ["workout", "did my workout?"],
  ["workout", "Should I train today?"],
  ["workout", "my workout is not done"],
  ["workout", "I will train later"],
  ["food", "Did I log breakfast?"],
  ["food", "What did I eat today?"],
  ["food", "Should I eat eggs?"],
  ["food", "I want to eat eggs later"],
  ["food", "is bread ok?"],
];

/** THE NEGATIVE CONTROL. Real reports, in the shapes clients actually send. Every one must still
 *  reach its writer — a guard that passes the list above by refusing everything fails here.
 *  The "trying to lose weight" line is deliberate: it carries an intention AND a measurement, and
 *  the measurement is the fact. An intent floor wide enough to eat it is too wide. */
const MUST_WRITE: [string, string][] = [
  ["steps", "walked 10000 steps today"],
  ["steps", "my steps are 10k today"],
  ["steps", "fitbit says 8500"],
  ["steps", "10k steps done"],
  ["steps", "steps: 9200"],
  ["weight", "84kg"],
  ["weight", "weighed 84kg this morning"],
  ["weight", "my weight is 84kg today"],
  ["weight", "I'm trying to lose weight, weighed 84kg this morning"],
  ["workout", "workout done"],
  ["workout", "I trained chest today"],
  ["workout", "gym done"],
  ["water", "2 litres of water"],
  ["water", "drank 3 litres today"],
];

(async () => {
  const g = globalThis as any;
  const { handleMessage } = await import("../server/routes");
  const schema = await import("../shared/schema");
  const NAME = new Map<any, string>([
    [schema.stepLogs, "steps"], [schema.weightLogs, "weight"],
    [schema.workoutLogs, "workout"], [schema.mealLogs, "food"],
  ]);

  /** What did this turn actually commit? Water is the odd one out: it persists through a raw
   *  `sql` CASE expression, so the stub holds an SQL object rather than a number and any numeric
   *  read of it silently reports "no write" — which is how a water false-write could hide from a
   *  probe that looked clean. "Did todayWater move off the seeded 0" is the honest test. */
  async function wroteFor(message: string): Promise<Set<string>> {
    g.__KAMLIFE_STUB_USER = { ...USER, todayWater: "0" };
    g.__KAMLIFE_STUB_WRITES = [];
    await handleMessage(USER.phoneNumber, message).catch(() => "");
    const wrote = new Set<string>(
      (g.__KAMLIFE_STUB_WRITES || []).map((w: any) => NAME.get(w.table)).filter(Boolean),
    );
    if (String((g.__KAMLIFE_STUB_USER || {}).todayWater ?? "0") !== "0") wrote.add("water");
    return wrote;
  }

  const failures: string[] = [];

  for (const [surface, message] of MUST_NOT_WRITE) {
    const wrote = await wroteFor(message);
    if (wrote.size > 0) {
      failures.push(`A question mutated tracking state: ${surface} | "${message}" wrote ${[...wrote].join(", ")}`);
    }
  }

  for (const [surface, message] of MUST_WRITE) {
    const wrote = await wroteFor(message);
    if (!wrote.has(surface)) {
      failures.push(`A real report was lost: ${surface} | "${message}" wrote ${[...wrote].join(", ") || "nothing"}`);
    }
  }

  /**
   * LAW 3 — THE ANSWER MUST QUOTE THE LEDGER, NOT THE MESSAGE (2026-08-26, issue #63).
   *
   * The write owner returns the count the day now HOLDS. Where a second write path existed, that
   * distinction was exactly what it lost: with 9 000 already logged, "walked 3000 steps today"
   * correctly kept the row at 9 000 and then congratulated the client on 3 000 — the ledger and
   * the mouth disagreeing inside one turn, which is the outbound-truth failure in miniature.
   *
   * Graded both ways, because "keep the higher" and "a correction wins downward" are the two
   * halves of one rule and a guard that only satisfies the first is wrong in the other direction.
   */
  const dayStart = (await import("../server/utils")).sastDayStart();

  /** Every number the client can read, thousands separators folded away. Deliberately NOT a
   *  `\b9000\b` test on a de-spaced string: "9 000 steps" collapses to "9000steps", where there
   *  is no word boundary after the zero and the assertion passes for the wrong reason. The
   *  separator class excludes newlines, so numbers on separate lines never fuse into one. */
  function numbersIn(text: string): Set<number> {
    return new Set([...text.matchAll(/\d[\d ,\u00a0\u202f]*\d|\d/g)]
      .map(mm => Number(mm[0].replace(/[ ,\u00a0\u202f]/g, "")))
      .filter(n => Number.isFinite(n)));
  }

  async function turnOnDayAt9k(message: string): Promise<{ reply: string; stored: number }> {
    g.__KAMLIFE_STUB_USER = { ...USER, todayWater: "0" };
    g.__KAMLIFE_STUB_ROWS = new Map([[schema.stepLogs, [
      { id: "s1", userId: USER.id, steps: 9000, loggedAt: new Date(dayStart.getTime() + 3_600_000) },
    ]]]);
    g.__KAMLIFE_STUB_WRITES = [];
    g.__KAMLIFE_STUB_UPDATES = [];
    const reply = String(await handleMessage(USER.phoneNumber, message).catch(() => ""));
    // The day holds 9 000 unless this turn changed it — by inserting a row, or by updating the one
    // already there. Both channels must be read, or an update looks exactly like a no-op.
    const ins = (g.__KAMLIFE_STUB_WRITES || []).filter((w: any) => w.table === schema.stepLogs);
    const upd = (g.__KAMLIFE_STUB_UPDATES || []).filter((w: any) => w.table === schema.stepLogs);
    const changed = ins.length ? ins[0].values?.steps
      : upd.length ? upd[upd.length - 1].set?.steps : undefined;
    delete g.__KAMLIFE_STUB_UPDATES;
    return { reply, stored: changed === undefined ? 9000 : Number(changed) };
  }

  // A LOWER re-log leaves the day at 9 000 — so the answer may not say 3 000.
  {
    const { reply, stored } = await turnOnDayAt9k("walked 3000 steps today");
    const said = numbersIn(reply);
    const first = reply.split("\n")[0];
    if (stored !== 9000) failures.push(`A lower re-log overwrote the day: stored ${stored}, expected 9000`);
    if (said.has(3000)) failures.push(`The reply quoted the message, not the ledger: day holds 9000, reply said 3 000 — "${first}"`);
    if (!said.has(9000)) failures.push(`The reply never quoted the stored count: day holds 9000 — "${first}"`);
  }

  // An explicit CORRECTION still wins downward, and the answer quotes the corrected number.
  {
    const { reply, stored } = await turnOnDayAt9k("3000 steps not 9000");
    const said = numbersIn(reply);
    const first = reply.split("\n")[0];
    if (stored !== 3000) failures.push(`A correction failed to write downward: stored ${stored}, expected 3000`);
    if (!said.has(3000)) failures.push(`A correction was not quoted back: day now holds 3000 — "${first}"`);
  }

  const total = MUST_NOT_WRITE.length + MUST_WRITE.length + 2;
  if (failures.length > 0) {
    for (const f of failures) console.log(`✗ ${f}`);
    console.log(`\n✗ tracking contract: ${failures.length}/${total} violations`);
    process.exit(1);
  }
  console.log(`✓ tracking contract: ${MUST_NOT_WRITE.length} questions wrote nothing, ${MUST_WRITE.length} reports reached their writer, the answer quoted the ledger both ways`);
  process.exit(0);
})();

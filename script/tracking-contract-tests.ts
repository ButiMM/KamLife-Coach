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
 * and the contract has five laws. The first two protect the STATE, the next two are what turns a
 * logger into a coach, and the fifth is what makes all four survive a real client's phrasing —
 * they are enforced further down, where the code that grades them is:
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
 *   LAW 3 — THE ANSWER QUOTES THE LEDGER, NOT THE MESSAGE.  (graded at "LAW 3" below)
 *   LAW 4 — A DURABLE WRITE IS FOLLOWED BY ONE NEXT MOVE.   (graded at "LAW 4" below)
 *   LAW 5 — A QUESTION IN ONE CLAUSE DOES NOT ERASE A REPORT IN ANOTHER. (at "LAW 5" below)
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

/**
 * WATER'S OWN NEGATIVE-INTENT VOCABULARY — graded on the WATER surface only, and the reason for
 * that narrowing is stated rather than hidden.
 *
 * These are not asking, and isFutureIntent does not own them: "trying to" is excluded from that
 * floor ON PURPOSE, because a report can carry it ("trying to lose weight, weighed 84kg this
 * morning"), and the obligation forms have no pronoun for the asking floor to key on. So water
 * refuses them itself. These cases exist because the first version of this cut deleted that
 * vocabulary as a "duplicate" and two of them began writing water.
 *
 * WHY NOT MUST_NOT_WRITE, WHICH FORBIDS EVERY SURFACE: because on these inputs the FOOD scanner
 * claims the message and logs a meal called "Water" — on main too, unchanged by this cut. That is
 * a real Law 2 violation on a different surface, with its own cause (the food door's planning
 * vocabulary has the same gap, and water is treated as a food at all). Asserting it here would
 * mean fixing the food door in a water cut. Asserting "nothing wrote" and quietly deleting the
 * case would mean hiding it. So it is graded where this cut has authority, and the food claim is
 * REPORTED on every run below so it cannot be forgotten.
 */
const WATER_INTENT: string[] = [
  "trying to drink 2 litres of water",
  "must drink 2 litres of water",
  "should drink 2 litres of water",
  "will drink 2 litres of water",
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
  // EVERY GRADED TURN STARTS FROM CLEAN PROCESS STATE, and this is not housekeeping — without it
  // the suite grades a different product further down than it does at the top.
  //
  //   the pattern summary  is memoised per user for an hour, in module state.
  //   the GPT rate limiter allows 10 calls per user per 60s, in module state — and this suite
  //                        runs ~65 turns in ten seconds.
  //   the card dump window suppresses a second macro card for the same client inside the window.
  //                        This is CORRECT product behaviour — six photos in ninety seconds get
  //                        one card — but it meant the "a card owns the next action" case only
  //                        held for the FIRST food turn of the run. Adding cases above it turned
  //                        the card off, the reply became a bare receipt, Law 4 correctly appended
  //                        a move, and the assertion failed for a reason that had nothing to do
  //                        with what it tests.
  //
  // A suite whose verdict depends on how many turns ran before it is not measuring the product,
  // and it fails in the worst direction — silently changing behaviour rather than erroring.
  // The limiter is reset through its own exported function with a zero window, so no production
  // code exists solely to be testable.
  const { invalidatePatternCache } = await import("../server/cache");
  const { checkGptRateLimit } = await import("../server/utils");
  const { _resetDumpWindow } = await import("../server/card-policy");
  const freshTurn = () => {
    invalidatePatternCache(USER.id);
    checkGptRateLimit(USER.id, 1_000_000, 0);
    _resetDumpWindow();
  };
  const NAME = new Map<any, string>([
    [schema.stepLogs, "steps"], [schema.weightLogs, "weight"],
    [schema.workoutLogs, "workout"], [schema.mealLogs, "food"],
  ]);

  /** What did this turn actually commit? Water is the odd one out: it persists through a raw
   *  `sql` CASE expression, so the stub holds an SQL object rather than a number and any numeric
   *  read of it silently reports "no write" — which is how a water false-write could hide from a
   *  probe that looked clean. "Did todayWater move off the seeded 0" is the honest test. */
  async function wroteFor(message: string): Promise<Set<string>> {
    freshTurn();
    g.__KAMLIFE_STUB_USER = { ...USER, todayWater: "0" };
    // THE LEDGER IS PROCESS STATE TOO (2026-09-01, found integrating Cut A).
    //
    // freshTurn() resets the caches and limiters above for exactly the reason stated there — a
    // graded turn must not inherit the previous one. __KAMLIFE_STUB_ROWS was never in that reset,
    // so every turn here ran against whatever meal/step/weight rows earlier BLOCKS of this file
    // had left in the Map, and those rows carry only the columns their own block cared about.
    //
    // That was invisible while every dedup query happened to carry a leaf the stub could judge
    // against the residue: commitFoodLog filtered on `loggedAt >= now-4min`, the stale rows are
    // older, so they were dropped and the count came out right by accident. Cut A's replay
    // suppression keys on sourceMessageId + rawMessage with NO time bound — correct, because a
    // Twilio retry can arrive at any distance — and the residue seeds NEITHER column, so the stub
    // could not judge either leaf, kept all five rows, and "I had eggs. what should I eat?"
    // reported itself a duplicate and wrote nothing.
    //
    // The product is right: in Postgres those rows have sourceMessageId NULL and never match a
    // real id. The fixture was wrong, and it was wrong before Cut A — Cut A is only what made it
    // visible. Reset the ledger with the rest of the turn state.
    g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([
      [schema.mealLogs, []], [schema.stepLogs, []], [schema.workoutLogs, []], [schema.weightLogs, []],
    ]);
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

  const knownFoodClaim: string[] = [];
  for (const message of WATER_INTENT) {
    const wrote = await wroteFor(message);
    if (wrote.has("water")) {
      failures.push(`An intention wrote water: "${message}" — water's own negative vocabulary is gone`);
    }
    if (wrote.has("food")) knownFoodClaim.push(message);
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
    freshTurn();
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

  /**
   * A SECOND WEIGH-IN TODAY IS A DURABLE WRITE, AND THE TURN MUST SAY SO (#114 P0-2, 2026-09-03).
   *
   * The adjudicated report said a same-day weight correction was acknowledged but never written.
   * It IS written — handleWeightLog has always updated today's row. The report was wrong because
   * the trace behind it read only INSERTs, and this path UPDATEs. The same mistake the steps
   * helper above warns about, made one suite over.
   *
   * What was real: turnMutation sat only in the insert branch, so the correction changed the
   * ledger while the turn recorded NOTHING. turnAlreadyWrote("weight") stayed false, routes'
   * wroteThisTurn stayed false, and Coach Health — which reads `mutations` — could not see a
   * same-day weigh-in at all. The write and the record of the write are one fact.
   *
   * Graded on both channels and on the turn's own record, because either alone lies here.
   */
  {
    const weighIn = async (todayRow: any | null, message: string) => {
      freshTurn();
      g.__KAMLIFE_STUB_USER = { ...USER, currentWeight: "86.0", heightCm: 178, gender: "male", age: 35 };
      const rows = [{ id: "wl-old", userId: USER.id, weight: "86.0", weightKg: "86.0",
        loggedAt: new Date(dayStart.getTime() - 7 * 86_400_000), at: new Date(dayStart.getTime() - 7 * 86_400_000) }];
      if (todayRow) rows.push(todayRow);
      g.__KAMLIFE_STUB_ROWS = new Map([[schema.weightLogs, rows]]);
      g.__KAMLIFE_STUB_WRITES = [];
      g.__KAMLIFE_STUB_UPDATES = [];
      const reply = String(await handleMessage(USER.phoneNumber, message).catch(() => ""));
      const ins = (g.__KAMLIFE_STUB_WRITES || []).filter((w: any) => w.table === schema.weightLogs);
      const upd = (g.__KAMLIFE_STUB_UPDATES || []).filter((w: any) => w.table === schema.weightLogs);
      const usr = (g.__KAMLIFE_STUB_UPDATES || []).filter((w: any) => w.table === schema.users)
        .map((w: any) => w.set?.currentWeight).filter(Boolean);
      const muts: string[] = ((g.__KAMLIFE_STUB_WRITES || [])
        .filter((w: any) => w.table === schema.turnLedger)
        .flatMap((w: any) => (Array.isArray(w.values?.mutations) ? w.values.mutations : []))) as string[];
      delete g.__KAMLIFE_STUB_UPDATES;
      delete g.__KAMLIFE_STUB_ROWS;
      return {
        reply, inserted: ins.length, rowsAdded: ins.length,
        stored: ins.length ? String(ins[0].values?.weight) : upd.length ? String(upd[upd.length - 1].set?.weight) : null,
        currentWeight: usr.length ? String(usr[usr.length - 1]) : null,
        weightMutations: muts.filter(m => /weight=/i.test(m)),
      };
    };
    const TODAY_84 = { id: "wl-today", userId: USER.id, weight: "84.0", weightKg: "84.0",
      loggedAt: new Date(dayStart.getTime() + 60_000), at: new Date(dayStart.getTime() + 60_000) };

    // 1 — FIRST WEIGHT OF THE DAY WRITES, and records an INSERT.
    {
      const r = await weighIn(null, "83.4kg");
      if (r.stored !== "83.4") failures.push(`The first weigh-in of the day did not reach weight_logs: stored ${r.stored}`);
      if (r.rowsAdded !== 1) failures.push(`The first weigh-in of the day added ${r.rowsAdded} rows, expected 1`);
      if (!r.weightMutations.some(m => /^INSERT weight=83.4kg/.test(m))) {
        failures.push(`The first weigh-in recorded no INSERT on the turn: ${JSON.stringify(r.weightMutations)}`);
      }
    }

    // 2 — A CHANGED SAME-DAY WEIGHT CORRECTS THE DAY, and the corrected value is authoritative.
    {
      const r = await weighIn(TODAY_84, "83.4kg");
      if (r.stored !== "83.4") failures.push(`A same-day correction did not reach weight_logs: stored ${r.stored} — the client was told "noted" and 84.0 stayed authoritative`);
      if (r.rowsAdded !== 0) failures.push(`A same-day correction added ${r.rowsAdded} weight rows — the day must hold one weigh-in, corrected, not two`);
      if (r.currentWeight !== "83.4") failures.push(`users.currentWeight is ${r.currentWeight} after a correction to 83.4 — every downstream surface reads the corrected-away number`);
      // THE REPLY MAY NOT ACKNOWLEDGE A VALUE THAT WAS NOT PERSISTED. Graded as an implication:
      // if the coach says 83.4 back, 83.4 is what the ledger now holds.
      if (/83[.,]4/.test(r.reply) && r.stored !== "83.4") {
        failures.push(`The reply acknowledged 83.4kg while the ledger holds ${r.stored} — the coach confirmed a number it did not keep`);
      }
      // AND THE TURN MUST RECORD IT. This is the half that was actually broken.
      if (!r.weightMutations.some(m => /^UPDATE weight=83.4kg/.test(m))) {
        failures.push(`A same-day weight correction recorded no durable write on the turn: ${JSON.stringify(r.weightMutations)} — turnAlreadyWrote, wroteThisTurn and Coach Health all read that record, so the correction is invisible to every one of them`);
      }
      if (!r.weightMutations.some(m => /\(was 84kg\)/.test(m))) {
        failures.push(`The correction does not say what it replaced: ${JSON.stringify(r.weightMutations)} — a reader cannot tell a correction from a first weigh-in`);
      }
    }

    // 3 — AN EXACT REPEAT IS NOT A SECOND WEIGH-IN, AND IS NOT A DURABLE WRITE EITHER.
    //
    //     This is the OVER-FIRE control, and it earns its place: the first version of the fix
    //     recorded `UPDATE weight=84kg` for a client repeating today's number, which contradicts
    //     this very case. `mutations` is operational state — claimant stand-down and Coach Health
    //     both read it — so a semantic no-op entering it stands doors down for a turn that changed
    //     nothing and hands Coach Health a weigh-in that never happened. Asserting ZERO weight
    //     mutations, not merely zero INSERTs, is what catches that; the weaker form passed it.
    {
      const r = await weighIn(TODAY_84, "84kg");
      if (r.rowsAdded !== 0) failures.push(`Repeating today's weight added ${r.rowsAdded} rows — an unchanged repeat must stay deduped`);
      if (r.weightMutations.length !== 0) {
        failures.push(`Repeating today's weight recorded ${JSON.stringify(r.weightMutations)} as a durable write — nothing about the day changed, and claimant stand-down and Coach Health both read that record`);
      }
    }
  }

  /**
   * THE CARD MAY NOT CONTRADICT THE DECISION (2026-08-26, live phone trace).
   *
   * The client said they were done eating for the day. The text respected it. The card told them
   * to eat more. Both were produced by the same turn, from the same day-state, by two different
   * owners of the same question:
   *
   *     chooseAction        eat_more and protein rungs, each guarded by !s.foodDayClosed
   *     nextMoveLine        the SAME two rungs on the card, with no such guard
   *
   * Reproduced deterministically on one day-state — fat-loss client, 19:00, protein 60 of 180:
   *
   *     text: "Get today's session done."                    (closure respected)
   *     card: "Get a real protein into your next two meals"  (still selling food)
   *
   * The fix adds no prose. A closed day is a finished day, and nextMoveLine already owned four
   * close-out lines for the after-20:00 case — "That's the day. Tomorrow get a real protein in at
   * breakfast" is exactly right for someone who stopped eating short of protein. Closure enters
   * the same branch the clock does.
   *
   * GRADED THROUGH THE PRODUCTION MARKER, NOT A HAND-PASSED BOOLEAN.
   *
   * The first version of this test called nextMoveLine(rows, ..., foodDayClosed) directly and
   * asserted on the string. That proved the parameter works and NOTHING about whether production
   * supplies it — delete both `foodDayClosed: await dayClosedFor(...)` lines from the markers and
   * that test stays green while the client keeps reading "eat more" on a day they closed. A test
   * that can be green while the customer is wrong is not evidence.
   *
   * So the graded path is the real one, end to end:
   *
   *     dailyMacroCardMarker(user) -> dayClosedFor -> readHeldConstraints -> nextMoveLine -> PNG
   *
   * The card's words are rasterised into that PNG and cannot be read back, so the assertion is on
   * BYTES: render the two cards this day-state can produce, then check which one the production
   * marker actually emitted. Byte equality is exact — it pins the specific close-out line, not
   * merely "some different card".
   *
   * Three things had to be pinned for those bytes to mean anything:
   *   - THE CLOCK. nextMoveLine takes the same branch after 20:00 on its own, so at 20:00 a broken
   *     wiring would look fixed. Date.now is frozen at 19:00 SAST on a fixed date — the #82 rule:
   *     a test must not change its answer because of when it ran.
   *   - THE LEDGER. An empty day, so the rows are known and the protein rung is the one in play.
   *   - THE CLOSURE. readHeldConstraints goes through raw pool.query, seeded via
   *     __KAMLIFE_STUB_PGROWS — the seam that exists because a constraint stated at 08:00 cannot
   *     otherwise be expressed offline.
   */
  {
    const { mealCard, todayRows, dailyMacroCardMarker, macroCardMarker } = await import("../server/macro-card-attach");
    const { _resetDumpWindow: resetDump } = await import("../server/card-policy");
    const { renderAchievementCard } = await import("../server/achievement-card");
    const { getCard } = await import("../server/card-store");
    const { getNumbersMode } = await import("../server/numbers-mode");
    const { getGoalProfile } = await import("../server/goal-profiles");
    const { readHeldConstraints } = await import("../server/held-constraints");
    const { mealLogs, stepLogs } = await import("../shared/schema");

    const realNow = Date.now;
    const FROZEN = Date.parse("2026-03-11T17:00:00Z");   // 19:00 SAST, before the 20:00 close-out
    const priorRows = g.__KAMLIFE_STUB_ROWS;
    Date.now = () => FROZEN;
    g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([[mealLogs, []], [stepLogs, []]]);
    try {
      const pngOf = (marker: string) => {
        const t = marker.match(/\/card\/([^.]+)\.png/);
        return t ? getCard(t[1]) : null;
      };
      const closure = () => [{ message_in: "I'm done eating for the day", created_at: new Date(FROZEN - 600_000) }];

      const today = await todayRows(USER, false);
      const cardFor = (mealName: string, foodDayClosed: boolean) => mealCard({
        firstName: "Kam", mealName, rows: today!.rows, isBulk: today!.isBulk,
        usesNumbers: getNumbersMode(USER) !== "low" && getGoalProfile(USER.goalType).usesMacros,
        foodDayClosed,
      });
      const openCard = cardFor("Today", false), closedCard = cardFor("Today", true);
      const sells = (line: string) => /\beat\b|\bnext meal\b|next two meals|proper protein|add eggs|yoghurt|boiled egg/i.test(line)
        && !/tomorrow/i.test(line);

      // BOTH CALL SITES. The wiring is two lines in two functions, and grading one of them leaves
      // the other free to be deleted with the suite still green — which is the whole defect this
      // block exists to catch. The meal-log card is the one a client sees most: it rides every
      // food log they send.
      const MARKERS: [string, string, () => Promise<string>][] = [
        ["the daily-calories card", "Today", () => dailyMacroCardMarker(USER)],
        ["the meal-log card", "Chicken and rice", () => macroCardMarker({ user: USER, mealName: "Chicken and rice", mealKcal: 600 })],
      ];
      for (const [what, mealName, emit] of MARKERS) {
        delete g.__KAMLIFE_STUB_PGROWS;
        resetDump();                       // the dump window collapses repeat cards to one
        const openA = pngOf(await emit());
        resetDump();
        const openB = pngOf(await emit());
        g.__KAMLIFE_STUB_PGROWS = closure();
        resetDump();
        const closed = pngOf(await emit());
        delete g.__KAMLIFE_STUB_PGROWS;

        if (!openA || !openB || !closed) {
          failures.push(`${what} produced no image, so its closed-day wiring is ungraded — this proves nothing`);
          continue;
        }
        // WITHOUT THIS the "closed differs from open" assertion would pass on rendering noise.
        if (!openA.equals(openB)) {
          failures.push(`Two identical renders of ${what} differ byte-for-byte — the comparison below cannot mean anything`);
          continue;
        }
        // THE WIRING. Remove `foodDayClosed: await dayClosedFor(...)` from this marker and the
        // closed run becomes identical to the open one, and this fails.
        if (closed.equals(openA)) {
          failures.push(`A held closed-day constraint did not reach ${what}: it emitted the same image as an open day — card said "${cardFor(mealName, false).sub}"`);
        }
        // AND IT IS THE CLOSED-DAY CARD SPECIFICALLY, not merely a different one.
        if (!closed.equals(renderAchievementCard(cardFor(mealName, true)))) {
          failures.push(`${what} did not emit the closed-day card — expected the close-out "${cardFor(mealName, true).sub}"`);
        }
        if (!openA.equals(renderAchievementCard(cardFor(mealName, false)))) {
          failures.push(`${what} did not emit the open-day card — expected "${cardFor(mealName, false).sub}"`);
        }
      }
      g.__KAMLIFE_STUB_PGROWS = closure();
      const held = await readHeldConstraints(USER.phoneNumber, USER as any).catch(() => ({ foodDayClosed: false } as any));
      delete g.__KAMLIFE_STUB_PGROWS;

      // THE CUSTOMER OUTCOME, on the card the production path actually emitted.
      if (sells(closedCard.sub)) {
        failures.push(`The card sold food on a closed day: "${closedCard.sub}"`);
      }
      // THE CONTROL: an OPEN day keeps its instruction. A guard that silences the card always
      // would satisfy every assertion above and leave every ordinary day without a next move.
      if (!sells(openCard.sub)) {
        failures.push(`An open day lost its card instruction: "${openCard.sub}"`);
      }
      // Which half broke, when it breaks: the marker not reading, or the fact never becoming true.
      if (!held.foodDayClosed) {
        failures.push(`held-constraints did not see the closure the card depends on — the card's read is wired to a fact that never becomes true`);
      }
    } finally {
      Date.now = realNow;
      delete g.__KAMLIFE_STUB_PGROWS;
      if (priorRows === undefined) delete g.__KAMLIFE_STUB_ROWS; else g.__KAMLIFE_STUB_ROWS = priorRows;
    }
  }

  /**
   * ONE CUSTOMER MEANING -> ONE OWNER. Claim precedence, not capability (2026-08-26, live trace).
   *
   * The capability was never missing. SMART NEXT MEAL answers "what should I eat next" against the
   * day's remaining calories, and has since long before this. What went wrong on a real phone is
   * that a door ~145 lines EARLIER in the pipeline claimed the turn first:
   *
   *     client: "Give me a meal for my last 668 calories"
   *     coach : "Kam, today: 2032/2700 kcal · 150g/180g protein. 668 kcal left." + a card
   *
   * He asked for a MEAL and was handed a NUMBER. The totals branch matched on "my … calories" and
   * ended the turn; the owner never ran. Same disease as #70, one phrasing further out — that guard
   * recognised only INTERROGATIVE food questions ("what can I eat"), and this is the IMPERATIVE.
   *
   * BOTH HALVES ARE THE CUT, and the first attempt proved why. Stopping the wrong claimant alone
   * left the message with NO owner — it fell through to the model and came back "Eish Coach K had
   * a moment." A precedence fix is only finished when the right door actually takes the turn, so
   * the owner's recogniser learned the same request verbs the guard uses.
   *
   * GRADED BOTH WAYS, because the failure mode here is symmetric: divert too little and the client
   * still gets a number; divert too much and a genuine "how many calories do I have left?" stops
   * being answerable. "show me my calories" is the case that pins it — same request verb, no meal.
   */
  {
    const answered = async (message: string) => {
      freshTurn();
      const todayMeal = [{
        id: "cm0", userId: USER.id, items: ["chicken", "rice"], mealLabel: "lunch",
        loggedAt: new Date(dayStart.getTime() + 3_600_000), corrected: false,
        kcalInt: 2032, proteinInt: 150, kcal: 2032, protein: 150, carbs: 0, fat: 0,
      }];
      g.__KAMLIFE_STUB_USER = { ...USER };
      g.__KAMLIFE_STUB_ROWS = new Map([
        [schema.mealLogs, todayMeal], [schema.stepLogs, []], [schema.workoutLogs, []], [schema.weightLogs, []],
      ]);
      g.__KAMLIFE_STUB_WRITES = [];
      return String(await handleMessage(USER.phoneNumber, message).catch(() => ""));
    };
    const isMealSuggestion = (r: string) => /next meal suggestion/i.test(r);
    const isTotalsReadout = (r: string) => /\d+\s*\/\s*\d+\s*kcal|kcal\b.*\bleft\b|still available/i.test(r);

    // A MEAL REQUEST REACHES ITS OWNER.
    for (const ask of [
      "Give me a meal for my last 668 calories",
      "give me a meal",
      "suggest a meal for my remaining calories",
      "what can I eat with my remaining calories?",
    ]) {
      const r = await answered(ask);
      if (!isMealSuggestion(r)) {
        failures.push(`A meal request did not reach SMART NEXT MEAL: "${ask}" -> "${r.replace(/\n/g, " ").slice(0, 80)}"`);
      }
    }

    // A CALORIE QUESTION STILL REACHES THE TOTALS OWNER — the control that stops this from being
    // "fixed" by diverting everything that mentions food.
    for (const ask of [
      "Today's calories",
      "how many calories do I have left?",
      "my calorie target",
      "show me my calories",
    ]) {
      const r = await answered(ask);
      if (!isTotalsReadout(r) || isMealSuggestion(r)) {
        failures.push(`A calorie question was diverted away from the totals owner: "${ask}" -> "${r.replace(/\n/g, " ").slice(0, 80)}"`);
      }
    }

    // AND THE MEAL-PLAN DOOR IS UNTOUCHED. "send me a meal plan" contains the request verb AND the
    // meal noun, so a careless guard would strip it from the branch that owns it.
    {
      const r = await answered("send me a meal plan");
      if (!/meal plan/i.test(r)) {
        failures.push(`The meal-plan door lost its message: "send me a meal plan" -> "${r.replace(/\n/g, " ").slice(0, 80)}"`);
      }
    }

    /**
     * SAME CUSTOMER MEANING -> SAME CLAIMANT (2026-08-27, live trace on main 6d6b92f).
     *
     * "What can I eat?" and "What should I eat?" are one question. They reached two mouths:
     *
     *     "what can I eat?"    -> Next Meal Suggestion, against today's remaining calories
     *     "what should I eat?" -> a 3-day meal plan with a weekly grocery budget
     *
     * Same shape as the meal-for-calories defect above: a door ~9 handlers EARLIER in the pipeline
     * claimed it first. Every other term in that door's vocabulary names a plan — meal plan, eating
     * plan, diet plan, weekly meals, nutrition plan — and "what should i eat" named none. It stands
     * down for the bare plate-ask; the owner's recogniser drops a `next` suffix it never needed.
     *
     * Graded on the CLASS of answer for every equivalent phrasing, with the plan door as the
     * control: a fix that simply gutted the plan vocabulary would satisfy the convergence and cost
     * every client their meal plan.
     */
    {
      // The unpunctuated form is a SEPARATE case, not a cosmetic variant: the plan door holds an
      // exact-match list checked with .includes(m), which "what should I eat?" can never hit and
      // "what should i eat" hits exactly. Grading only the question-mark form leaves half the
      // claimant untested.
      const plateAsks = ["what can I eat?", "what should I eat?", "what should i eat",
        "what should I eat next?", "I'm hungry"];
      for (const ask of plateAsks) {
        const r = await answered(ask);
        if (!isMealSuggestion(r)) {
          failures.push(`A plate-ask did not reach the next-meal owner: "${ask}" -> "${r.replace(/\n/g, " ").slice(0, 80)}"`);
        }
      }
      // THE CONTROL: a request that actually asks for a PLAN still gets the plan.
      for (const ask of ["give me a meal plan", "my meal plan", "eating plan"]) {
        const r = await answered(ask);
        if (!/meal plan/i.test(r) || isMealSuggestion(r)) {
          failures.push(`A plan request was diverted to the next-meal owner: "${ask}" -> "${r.replace(/\n/g, " ").slice(0, 80)}"`);
        }
      }
      // THE ADJACENCY THIS CUT CREATED. A separate door owns "what should i eat THIS WEEK", and the
      // recogniser above now matches the bare phrase inside that longer one. Only pipeline order
      // keeps them apart — early-commands runs before misc — so the ordering is graded, not assumed.
      for (const ask of ["what should I eat this week", "what should i eat this week"]) {
        const r = await answered(ask);
        if (isMealSuggestion(r)) {
          failures.push(`A week-long plan request was claimed by the next-meal owner: "${ask}" -> "${r.replace(/\n/g, " ").slice(0, 80)}"`);
        }
      }
    }
  }

  /**
   * THE ANSWER MUST CONTAIN THE FACT IT WAS ASKED FOR (2026-08-27, live phone trace).
   *
   * "How far am I from my goal?" is claimed correctly — GOAL_DISTANCE in misc-commands owns it and
   * says so in its own comment: "must not fall through to GPT or to the plan menu". It then answers
   * a different question. Measured on main 31444ce, for a client holding 92kg with an 85kg target:
   *
   *     Kam — Scale: down 6.0kg since you started. This week: 0/3 sessions.
   *     Today's protein: 200g / 180g.
   *
   *     That's the distance. The next move is still one thing.
   *
   * The target is never named. The gap is never named. The reply asserts "that's the distance" while
   * containing no distance. This is not a claim-precedence defect like the meal request above — the
   * right owner answered — it is the owner reciting adjacent progress instead of the fact asked for.
   *
   * The gap now comes from getWeightTruth, the documented single reader of what the scale says,
   * which already held the current weight and the client's target. Graded on the reply the client
   * reads, with both directions of over-fire controlled: no target and a withheld scale must each
   * leave the answer exactly as it was.
   */
  {
    const goalTurn = async (message: string, opts?: { target?: string | null; doNotMention?: string }) => {
      freshTurn();
      // Ascending by loggedAt — getWeightTruth orders that way and the stub does not sort, so a
      // reversed seed reads as a 6kg GAIN and would have this suite grading a fiction.
      const weighIns = Array.from({ length: 9 }, (_, i) => ({
        id: `w${i}`, userId: USER.id, weight: 98 - i * 0.75, weightKg: 98 - i * 0.75,
        loggedAt: new Date(dayStart.getTime() - (8 - i) * 7 * 86_400_000),
      }));
      g.__KAMLIFE_STUB_USER = {
        ...USER, todayWater: "0", currentWeight: 92,
        targetWeightKg: opts?.target === undefined ? "85" : opts.target,
        doNotMention: opts?.doNotMention || "",
      };
      g.__KAMLIFE_STUB_ROWS = new Map([
        [schema.mealLogs, []], [schema.stepLogs, []], [schema.workoutLogs, []], [schema.weightLogs, weighIns],
      ]);
      g.__KAMLIFE_STUB_WRITES = [];
      return String(await handleMessage(USER.phoneNumber, message).catch(() => ""));
    };
    const ASK = "How far am I from my goal?";
    const statesADistance = (r: string) => /\bto (?:go|gain)\b|at your goal weight/i.test(r);

    // THE DEFECT: 92kg now, 85kg the goal — the answer must carry the 7kg and the target.
    {
      const r = await goalTurn(ASK);
      const said = numbersIn(r);
      if (!said.has(7)) failures.push(`A distance question was answered without the distance — 92kg now, 85kg the goal: "${r.replace(/\n/g, " ⏎ ")}"`);
      if (!said.has(85)) failures.push(`A distance question was answered without naming the goal weight: "${r.replace(/\n/g, " ⏎ ")}"`);
    }

    // CONTROL — NO TARGET SET. There is no distance to state, so none may be invented, and the
    // answer is the one this handler always gave.
    {
      const r = await goalTurn(ASK, { target: null });
      if (statesADistance(r)) failures.push(`A client with no goal weight was told a distance anyway: "${r.replace(/\n/g, " ⏎ ")}"`);
      if (!/that's the distance/i.test(r)) failures.push(`A client with no goal weight lost the GOAL_DISTANCE answer entirely: "${r.replace(/\n/g, " ⏎ ")}"`);
    }

    // CONTROL — THE CLIENT ASKED US TO DROP THE SCALE. do_not_mention is honoured by exactly one
    // reader; a distance is a weight figure, and stating it here would walk straight through that.
    {
      const r = await goalTurn(ASK, { doNotMention: "weight" });
      if (statesADistance(r) || numbersIn(r).has(85)) {
        failures.push(`A withheld scale still produced a weight distance: "${r.replace(/\n/g, " ⏎ ")}"`);
      }
    }
  }

  /**
   * #131 — ONE COMMERCIAL CONTRACT: R149, PAID UPFRONT, 14-DAY MONEY-BACK, NO FREE TRIAL.
   *
   * The website was corrected to the locked offer while product truth still said R199 and a
   * 7-day guarantee, so a customer could arrive from a truthful page and be quoted different
   * terms by the coach — or, worse, be CHARGED different terms. The billing control below is the
   * one that matters: display copy can be wrong and embarrassing, but the PayFast amount is
   * money, and it was 199.
   */
  {
    const { PRICING, GUARANTEE_PHRASE } = await import("../shared/pricing");

    // 4. THE BILLING OWNER. routes/payments.ts sends this to PayFast as `amount` and
    // `recurring_amount`, and verifies the ITN against it. This is the control that goes RED if
    // the price is reverted.
    if (PRICING.monthlyPriceZAR !== 149) {
      failures.push(`The billing amount owner is ${PRICING.monthlyPriceZAR}, not 149 — PayFast would charge that, whatever the website says`);
    }
    if (!/^R149\b/.test(PRICING.monthlyDisplay)) {
      failures.push(`The price display says "${PRICING.monthlyDisplay}" while the charge is R${PRICING.monthlyPriceZAR}`);
    }
    // The daily figure is a claim about the monthly price and has to follow it.
    const dailyStated = Number(String(PRICING.dailyDisplay).replace(/[^0-9.]/g, ""));
    if (Math.abs(dailyStated - PRICING.monthlyPriceZAR / 30) > 0.05) {
      failures.push(`"${PRICING.dailyDisplay}" does not follow from R${PRICING.monthlyPriceZAR}/month — one of the two numbers is lying`);
    }
    if (PRICING.guaranteeDays !== 14 || !/14-day money-back guarantee/.test(GUARANTEE_PHRASE)) {
      failures.push(`The guarantee owner says "${GUARANTEE_PHRASE}" — the locked offer is 14 days`);
    }
    // 5. TRIAL LENGTH HAS ONE OWNER, and it is not this file. shared/pricing.ts used to declare
    // trialDays: 7 beside a server default of 0.
    if ("trialDays" in (PRICING as any)) {
      failures.push(`shared/pricing.ts declares trialDays again — server/pricing-config.ts owns it, and two owners of one fact is how this drifted`);
    }
    const { TRIAL_DAYS, TRIALS_ENABLED } = await import("../server/pricing-config");
    // 3. Default config grants no trial to a NEW customer...
    if (TRIAL_DAYS !== 0 || TRIALS_ENABLED) {
      failures.push(`Default config grants a ${TRIAL_DAYS}-day trial — the locked offer has none for new customers`);
    }

    // 1 & 2 & 6. WHAT A PROSPECT IS ACTUALLY TOLD, through the real conversion handler.
    const { handleConversionObjection } = await import("../server/handlers/conversion");
    const say = (m: string) => handleConversionObjection({ m, payLink: "https://pay.test/x", name: "Kam" })?.reply || "";
    const price = say("how much is it");
    const stall = say("let me think about it");
    const money = say("i can't afford it");
    for (const [label, r] of [["price question", price], ["stall", stall], ["money objection", money]] as const) {
      if (!r) { failures.push(`The conversion handler no longer answers a ${label} — the rest of this block grades nothing`); continue; }
      if (/R199|R6\.63/.test(r)) {
        failures.push(`A prospect asking about ${label} is still quoted the old offer: "${r.replace(/\n/g, " ⏎ ").slice(0, 160)}"`);
      }
    }
    if (!/R149/.test(price)) {
      failures.push(`A prospect asking the price is not told R149: "${price.replace(/\n/g, " ⏎ ").slice(0, 160)}"`);
    }
    // 2. Risk reversal is the guarantee, not a free week.
    if (!/14-day money-back/.test(stall)) {
      failures.push(`Hesitation is answered without the 14-day money-back guarantee: "${stall.replace(/\n/g, " ⏎ ").slice(0, 200)}"`);
    }
    if (/free (?:week|trial)|week one we make it right/i.test(stall)) {
      failures.push(`Hesitation is still de-risked with a free-week promise the offer does not make: "${stall.replace(/\n/g, " ⏎ ").slice(0, 200)}"`);
    }
  }

  /**
   * COACH HEALTH MUST DETECT THE FAILURES IT CLAIMS TO WATCH (2026-08-27).
   *
   * The dashboard's rules are the only thing standing between "we measure our adjudicated failures
   * in production" and a page of comforting zeros. A rule that matches nothing reports a healthy
   * product forever, and it fails in the safest-looking direction — which is exactly the shape of
   * defect this suite exists for.
   *
   * So the rules are graded against the STRINGS ACTUALLY OBSERVED in the traces that justified
   * each cut: the pre-fix reply must flag, and the post-fix reply must not. Both directions, from
   * real output rather than from a sentence describing it.
   */
  {
    const { COACH_HEALTH_RULES, isRegression } = await import("../server/routes/admin-turns");

    /**
     * A HIT FROM BEFORE THE FIX IS NOT A REGRESSION (2026-08-27, CTO review).
     *
     * The first version scanned a 1/7/30-day window and counted every match, so a turn from before
     * the fix merged — the old behaviour doing exactly what we found it doing — was reported as
     * "a merged fix is not holding". The count meant the opposite of what the page said. Every
     * rule's merge instant is graded from both sides, one second apart, so the boundary itself is
     * the thing under test rather than a comfortable distance either way.
     */
    for (const rule of COACH_HEALTH_RULES) {
      const merged = Date.parse(rule.fixedAt);
      if (!Number.isFinite(merged)) {
        failures.push(`Coach Health rule "${rule.id}" has no usable fixedAt ("${rule.fixedAt}") — every hit would be attributed to the wrong side of its fix`);
        continue;
      }
      if (isRegression(rule, new Date(merged - 1000))) {
        failures.push(`Coach Health counts a PRE-fix turn as a regression for "${rule.id}" — the page would report a fix as not holding using the evidence that justified it`);
      }
      if (!isRegression(rule, new Date(merged + 1000))) {
        failures.push(`Coach Health does not count a POST-fix turn as a regression for "${rule.id}" — a genuine recurrence would be filed as history and never surface`);
      }
      // The denominator label is chosen from this, so a wrong value is a false operator statistic.
      if (rule.trigger !== "request" && rule.trigger !== "mutation") {
        failures.push(`Coach Health rule "${rule.id}" has no trigger kind — its denominator cannot be labelled honestly`);
      }
    }

    /**
     * THE RATIO'S TWO HALVES MUST BE THE SAME SIDE OF THE FIX (2026-08-27, first live reading).
     *
     * The panel showed, for a rule whose only matching turn predated its fix:
     *
     *     Distance question answered without the distance   0 of 1 matching request · 1 before the fix
     *
     * which reads as "someone asked since the fix and got the right answer". Nobody had. The
     * numerator excluded pre-fix hits and the denominator included pre-fix asks, so an UNTESTED
     * rule displayed as a verified one — failing in the flattering direction, which is the only
     * direction that matters on a page whose job is to be believed.
     *
     * Graded on the same split the endpoint performs, over a synthetic window straddling a merge.
     */
    {
      const rule = COACH_HEALTH_RULES.find(r => r.id === "goal-distance-missing")!;
      const merged = Date.parse(rule.fixedAt);
      const window = [new Date(merged - 60_000), new Date(merged + 60_000)];
      const since = window.filter(at => isRegression(rule, at)).length;
      const before = window.filter(at => !isRegression(rule, at)).length;
      if (since !== 1 || before !== 1) {
        failures.push(`Coach Health cannot separate a window that straddles a fix: ${since} since / ${before} before, expected 1 and 1`);
      }
      // And the two must never be added together into one headline number.
      if (since + before !== window.length) {
        failures.push(`Coach Health lost a turn when splitting around the fix — every turn must land on exactly one side`);
      }
    }

    /**
     * THE V2 DETECTOR MUST CATCH AND MUST CLEAR (2026-08-27).
     *
     * V2 finds failures NOBODY has adjudicated, so nothing downstream will notice if it is wrong.
     * Two ways it fails, and only one of them looks like failure:
     *
     *   it misses      -> the queue is empty and the weekend produced nothing
     *   it over-fires  -> every healthy turn is a candidate, the queue is noise, nobody reads it
     *
     * Both are graded here on turns built to break exactly one invariant, and on healthy turns
     * that must break none. The healthy cases matter more: a detector that flags everything is
     * indistinguishable from one that works until someone tries to act on it.
     */
    {
      const { COACH_HEALTH_INVARIANTS, candidateSignature, candidateRef } = await import("../server/routes/admin-turns");
      const check = (id: string, t: { input: string; reply: string; mutations?: string[] }) => {
        const inv = COACH_HEALTH_INVARIANTS.find(i => i.id === id);
        if (!inv) { failures.push(`Coach Health V2 lost the invariant "${id}" — the detector now watches one fewer property`); return null; }
        return inv.holds({ input: t.input, reply: t.reply, mutations: t.mutations || [], state: {} });
      };
      // [invariant, a turn that BREAKS it, a healthy turn of the same shape that must not]
      const BREAKS: Array<[string, { input: string; reply: string; mutations?: string[] }, { input: string; reply: string; mutations?: string[] }]> = [
        ["unowned-message",
          { input: "still hungry after lunch", reply: "I didn't catch that one — what was it, roughly?" },
          { input: "still hungry after lunch", reply: "Protein first — two eggs will hold you to supper." }],
        ["question-mutated-state",
          { input: "how many steps should I do?", reply: "10 000 logged.", mutations: ["INSERT steps=10000"] },
          { input: "how many steps should I do?", reply: "Ten thousand is the target." }],
        ["durable-write-no-move",
          { input: "walked 8500 steps", reply: "8 500 steps — nice one.", mutations: ["UPDATE steps=8500 (was 3000)"] },
          { input: "walked 8500 steps", reply: "8 500 steps — nice one.\n\nStand on a scale in the morning.", mutations: ["UPDATE steps=8500 (was 3000)"] }],
        ["empty-reply",
          { input: "hello", reply: "" },
          { input: "hello", reply: "Howzit Kam." }],
        // THE OBSERVED 16:49 REPLY, verbatim from the live trace — a refusal to call a trend and a
        // trend, in consecutive paragraphs of one message. The healthy case is the same refusal
        // WITHOUT the assertion, which is what the fix in #102 makes the coach say: this must stay
        // readable as correct behaviour, or the detector punishes the repair.
        ["reply-contradicts-itself",
          { input: "how is my weight going?",
            reply: "I'm not going to call a trend off those weigh-ins — they sit around the time you "
              + "were ill, and weight moves on fluid and appetite then, not on food.\n\n"
              + "Scale is going up — keep fuelling." },
          { input: "how is my weight going?",
            reply: "I'm not going to call a trend off those weigh-ins — they sit around the time you "
              + "were ill, and weight moves on fluid and appetite then, not on food.\n\n"
              + "Weigh in three mornings this week and I'll read it properly." }],
      ];
      for (const [id, broken, healthy] of BREAKS) {
        if (check(id, broken) === true) {
          failures.push(`Coach Health V2 missed a broken invariant "${id}" — this turn would never reach the queue: "${broken.reply.replace(/\n/g, " ⏎ ")}"`);
        }
        if (check(id, healthy) === false) {
          failures.push(`Coach Health V2 flags a HEALTHY turn under "${id}" — the queue fills with noise and stops being read: "${healthy.reply.replace(/\n/g, " ⏎ ")}"`);
        }
      }

      // CLUSTERING: the same question asked two ways is one candidate, and two different questions
      // are not. A signature that collapses everything produces one giant meaningless cluster.
      const sig = candidateSignature;
      if (sig("I'm hungry, what can I eat?") !== sig("im hungry what can i eat")) {
        failures.push(`Coach Health V2 splits one question into two candidates on punctuation alone: "${sig("I'm hungry, what can I eat?")}" vs "${sig("im hungry what can i eat")}"`);
      }
      // THE FRAGMENTATION CASE (2026-08-27, proof harness). Three clients asked one question and
      // got three one-client candidates, split by a possessive and a missing preposition. Each
      // ranked low and none surfaced — the detector missing a repeated failure by breaking it up,
      // which looks exactly like a healthy queue.
      const nandos = [
        "I'm at Nando's, what should I order?",
        "at nandos what should i order",
        "Nando's — what should I order?",
      ].map(sig);
      if (new Set(nandos).size !== 1) {
        failures.push(`Coach Health V2 fragments one question into ${new Set(nandos).size} candidates: ${nandos.map(n => `"${n}"`).join(" vs ")}`);
      }
      if (sig("what can I eat") === sig("how far am I from my goal")) {
        failures.push(`Coach Health V2 groups two unrelated questions into one candidate — the packet would send an engineer after a pattern that does not exist`);
      }
      // The handle must be stable, or a candidate cannot be named in a brief and found again.
      if (candidateRef("a", "b") !== candidateRef("a", "b") || candidateRef("a", "b") === candidateRef("a", "c")) {
        failures.push(`Coach Health V2 candidate references are not stable-and-distinct — "CH-xxxx" would not survive being written down`);
      }

      /**
       * A1 — THE LOOP RUNS WITH THE DASHBOARD CLOSED (2026-09-01).
       *
       * The whole feature previously existed only while somebody had the page open: the rules ran
       * inside the GET handler and nothing durable came out. Graded on the two things that makes
       * true — a sweep with no HTTP request in sight produces a candidate, and the result is still
       * there afterwards for the dashboard to read — plus the property that stops it becoming
       * noise: running it twice over the same evidence announces nothing the second time.
       */
      {
        const { runCoachHealthSweep, COACH_HEALTH_STATE_KEY } = await import("../server/routes/admin-turns");
        const { loadState } = await import("../server/scheduler/shared");
        const observed = "I'm not going to call a trend off those weigh-ins — they sit around the time you "
          + "were ill, and weight moves on fluid and appetite then, not on food.\n\n"
          + "Scale is going up — keep fuelling.";
        g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([[schema.turnLedger, [{
          id: "tl-observed", userId: USER.id, createdAt: new Date(),
          inputText: "how is my weight going?", reply: observed,
          mutations: [], stateRead: {}, version: "25b2232",
          lifecycleStatus: null, failureCategory: null, fixRef: null,
        }]]]);

        const first = await runCoachHealthSweep(1);
        if (first.candidates === 0) {
          failures.push(`The automatic sweep found nothing on the exact observed 16:49 reply — Coach Health still only works when the dashboard is open`);
        }
        if (first.fresh.length === 0) {
          failures.push(`The automatic sweep surfaced no NEW candidate on first run — nothing would ever reach a human`);
        }

        // DURABLE: the dashboard must be able to read this without recomputing.
        let stored: any = null;
        try { stored = JSON.parse(loadState()[COACH_HEALTH_STATE_KEY] || "null"); } catch { /* below */ }
        if (!stored || !Array.isArray(stored.candidates) || stored.candidates.length === 0) {
          failures.push(`The automatic sweep left nothing durable behind — reopening the dashboard would show no automatic result`);
        } else {
          // PROVENANCE: a candidate has to identify the turn, the client and the build, from
          // fields the ledger already records.
          const ex = stored.candidates[0]?.examples?.[0];
          if (!ex?.turnId || !ex?.version) {
            failures.push(`A stored candidate carries no turn/build provenance — it cannot be traced back to the turn it came from`);
          }
        }

        // NO DUPLICATE SPAM: the same evidence, swept again, announces nothing new.
        const second = await runCoachHealthSweep(1);
        if (second.fresh.length !== 0) {
          failures.push(`Re-running the sweep re-announced ${second.fresh.length} candidate(s) it had already reported — the queue fills with duplicates every hour`);
        }
        if (second.candidates === 0) {
          failures.push(`The second sweep lost the candidate entirely — dedup must suppress the ANNOUNCEMENT, not the evidence`);
        }

        // CONTROL: a clean window must not manufacture a candidate. Without this, "always report
        // something" passes both assertions above.
        g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([[schema.turnLedger, [{
          id: "tl-clean", userId: USER.id, createdAt: new Date(),
          inputText: "how is my weight going?",
          reply: "Down 1.2kg over three weeks. Keep the weigh-ins to one morning a week.",
          mutations: [], stateRead: {}, version: "25b2232",
          lifecycleStatus: null, failureCategory: null, fixRef: null,
        }]]]);
        const clean = await runCoachHealthSweep(1);
        if (clean.fresh.length !== 0) {
          failures.push(`A healthy weight reply produced a NEW candidate — the automatic queue would fill with turns that are fine: ${clean.fresh.join(", ")}`);
        }

        /**
         * A2 — A GENUINE RECURRENCE MUST COME BACK (2026-09-01).
         *
         * A1 filtered against a flat "already announced" list forever, so a candidate that aged
         * out of the window and happened again a week later produced the same stable ref and was
         * reported as "none new". The suppression that is right for the next hour is wrong for
         * the next month.
         *
         * The window above has just gone clean, so the candidate is absent. What follows is the
         * same failure recurring with a turn the sweep has never counted — and then the same
         * evidence re-swept, which must NOT be announced again, or "recurrence" would just mean
         * "we ran it twice".
         */
        const recur = (id: string, at: Date) => new Map<any, any[]>([[schema.turnLedger, [{
          id, userId: USER.id, createdAt: at,
          inputText: "how is my weight going?", reply: observed,
          mutations: [], stateRead: {}, version: "25b2232",
          lifecycleStatus: null, failureCategory: null, fixRef: null,
        }]]]);

        g.__KAMLIFE_STUB_ROWS = recur("tl-recurrence", new Date(Date.now() + 60_000));
        const back = await runCoachHealthSweep(1);
        if (back.fresh.length === 0) {
          failures.push(`The same failure recurred after the candidate had gone quiet and was reported as "none new" — a real recurrence is silently suppressed and never reaches a human again`);
        }

        // ...and it cannot be manufactured by re-running what is already stored.
        const rerun = await runCoachHealthSweep(1);
        if (rerun.fresh.length !== 0) {
          failures.push(`Re-running the sweep over the SAME evidence announced ${rerun.fresh.length} candidate(s) as a recurrence — "new" would mean "we ran again", not "it happened again"`);
        }
        if (rerun.candidates === 0) {
          failures.push(`The re-run lost the candidate — recurrence handling must change what is ANNOUNCED, not what is held`);
        }

        // ABSENCE IS NOT ENOUGH ON ITS OWN, and this is the case that proves the second half of
        // the rule carries weight. A candidate can leave the active set and come back with no new
        // turn behind it — a shorter window, a boundary wobble, a sweep run at a different size.
        // Announcing that would make "recurrence" mean "the window moved". Here the candidate goes
        // absent and then the ORIGINAL rows return, older than the evidence already counted.
        g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([[schema.turnLedger, []]]);
        await runCoachHealthSweep(1);
        g.__KAMLIFE_STUB_ROWS = recur("tl-observed", new Date(Date.now() - 3 * 3_600_000));
        const wobble = await runCoachHealthSweep(1);
        if (wobble.fresh.length !== 0) {
          failures.push(`A candidate that went absent and came back with NO new evidence was announced as a recurrence — the window moving would read as the failure happening again`);
        }
        delete g.__KAMLIFE_STUB_ROWS;
      }

      /**
       * THE REVIEW PACKET — the founder stops being the transport layer (2026-09-03).
       *
       * A1 made the loop run unattended and A2 made it audited, but a NEW failure shape still
       * reached engineering exactly one way: the founder scrolled their own WhatsApp and chose a
       * screenshot. Every rule and invariant only sees shapes we already know, so the evidence for
       * an unknown one is in the turns that came back CLEAN — and nothing was keeping any of them.
       *
       * Graded on the two things the stored snapshot has to carry: which builds served the window,
       * and a deterministic spread of turns nothing objected to.
       */
      {
        const { runCoachHealthSweep, COACH_HEALTH_STATE_KEY } = await import("../server/routes/admin-turns");
        const { loadState } = await import("../server/scheduler/shared");
        const readPacket = () => {
          try { return JSON.parse(loadState()[COACH_HEALTH_STATE_KEY] || "null"); } catch { return null; }
        };

        // 24 clean turns across a day, oldest last (the ledger's own order), on two builds.
        freshTurn();
        const clean = Array.from({ length: 24 }, (_, i) => ({
          id: `tl-clean-${String(i).padStart(2, "0")}`, userId: USER.id,
          createdAt: new Date(Date.now() - i * 3_600_000),
          inputText: "how is my weight going?",
          reply: "Down 1.2kg over three weeks. Keep the weigh-ins to one morning a week.",
          mutations: [], stateRead: {}, version: i < 12 ? "0683588" : "1c25ce3",
          lifecycleStatus: null, failureCategory: null, fixRef: null,
        }));
        g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([[schema.turnLedger, clean]]);
        g.__KAMLIFE_STUB_WRITES = [];
        await runCoachHealthSweep(1);

        // ONE EVALUATION. The packet must be a by-product of the scan that already ran, and the
        // audit row is how that is measured — the same signal P0 #115 established.
        const audits = (g.__KAMLIFE_STUB_WRITES || []).filter((w: any) => w.table === schema.adminEvents);
        if (audits.length !== 1) {
          failures.push(`Building the review packet took ${audits.length} audited ledger evaluations — the packet must come out of the scan the sweep already does, not a second one`);
        }

        const packet = readPacket();
        if (!packet?.unflagged || !Array.isArray(packet.unflagged.sample)) {
          failures.push(`The automatic sweep stored no unflagged sample — a new failure shape still has no evidence waiting and the founder is still the transport layer`);
        } else {
          if (packet.unflagged.sample.length === 0) {
            failures.push(`The stored packet's unflagged sample is empty on a window of 24 clean turns — there was evidence to keep and none was kept`);
          }
          if (packet.unflagged.clean !== 24) {
            failures.push(`The packet reports ${packet.unflagged.clean} clean turns out of 24 — the denominator is what tells a reviewer whether 12 turns is a spot check or the whole window`);
          }
          const ex = packet.unflagged.sample[0];
          if (!ex?.turnId || !ex?.version || !ex?.input) {
            failures.push(`An unflagged sample entry carries no turn/build provenance or no input — it cannot be traced back to the turn it came from`);
          }
          // SPREAD, NOT THE HEAD. Ordered newest-first, so a naive slice would sample only the most
          // recent hours and a failure at the far end of the window could never be in the packet.
          // With 24 clean turns and a 12-turn sample the stride is 2, so the back half must appear.
          const ids: string[] = packet.unflagged.sample.map((s: any) => String(s.turnId));
          if (!ids.some(id => Number(id.slice(-2)) >= 12)) {
            failures.push(`Every sampled turn came from the newest half of the window (${ids.join(", ")}) — the sample is the head of the list, so the older end of the day is invisible`);
          }
          // Deterministic: the same rows must produce the same sample, or two packets cannot be
          // compared and no sampled turn can be re-derived from the ledger.
          await runCoachHealthSweep(1);
          const again: string[] = (readPacket()?.unflagged?.sample || []).map((s: any) => String(s.turnId));
          if (again.join(",") !== ids.join(",")) {
            failures.push(`The same 24 rows produced a different unflagged sample on the second sweep — the packet is not reproducible, so a reviewer comparing two runs is comparing dice rolls`);
          }
        }

        // BUILD PROVENANCE. buildWarning already said "more than one build served this window"
        // without ever saying WHICH, and a candidate is only attributable if you know what code
        // answered the turn.
        const builds: any[] = packet?.builds || [];
        if (builds.length !== 2 || !builds.some(b => b.version === "0683588") || !builds.some(b => b.version === "1c25ce3")) {
          failures.push(`The stored packet does not name the builds that served the window: ${JSON.stringify(builds)} — "a regression may be a turn that ran the old code" is unactionable without them`);
        }

        // CONTROL: a sample of turns "nothing flagged" must mean it. With every turn flagged there
        // is nothing clean to keep, and a packet that still produced twelve entries would be
        // sampling the window rather than the clean part of it.
        freshTurn();
        g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([[schema.turnLedger, clean.map((r, i) => ({
          ...r, id: `tl-allbad-${i}`, reply: "" ,
        }))]]);
        await runCoachHealthSweep(1);
        const allBad = readPacket();
        if ((allBad?.unflagged?.sample || []).length !== 0 || allBad?.unflagged?.clean !== 0) {
          failures.push(`Every turn in the window failed an invariant and the packet still offered ${(allBad?.unflagged?.sample || []).length} of them as unflagged — "nothing objected to this" would be a false statement about the evidence`);
        }
        delete g.__KAMLIFE_STUB_ROWS;
      }

      /**
       * #138 IN COACH HEALTH — THE HELD CONSTRAINT, ACROSS TURNS (2026-09-03, CTO hold on #144).
       *
       * The first version of this graded foodDayIsClosed on the SAME ledger row as the food offer,
       * so it only caught a client who closed the day and was offered food in one exchange. #138 is
       * not that. It is a HELD constraint spanning turns — "I'm done eating today" at 19:55, "what
       * should I eat?" at 20:10, a meal suggestion — and the offending row's own input says nothing
       * about food. The narrow detector would have reported that window as clean, which is the
       * failure mode this whole feature exists to remove.
       *
       * GRADED THROUGH THE REAL EVALUATION, not by calling holds() with a hand-made context: the
       * point at issue is whether the sweep assembles the cross-turn fact from the ledger, so a
       * fixture that supplies it would be testing the fixture. Turn times are anchored to
       * sastDayStart rather than to "now", so no case can pass or fail because of the wall clock.
       */
      {
        const { buildCoachHealthBrief } = await import("../server/routes/admin-turns");
        const { sastDayStart } = await import("../server/utils");
        const day0 = sastDayStart().getTime();
        const OTHER = "stub-other-client-0000000000000001";

        const turn = (id: string, userId: string, at: number, inputText: string, reply: string) => ({
          id, userId, createdAt: new Date(at), inputText, reply,
          mutations: [], stateRead: {}, version: "08228aa",
          lifecycleStatus: null, failureCategory: null, fixRef: null,
        });
        const CLOSED = "I am done eating today";
        const OFFERED = "*🍽️ Next Meal Suggestion — Kam*\n\nYou need 1g more protein today. Have something to eat tonight.";
        // The reply the merged #138 fix actually produces: it lands the day and points at tomorrow.
        const LANDED = "You said you are done eating today, so I am leaving it there.\n\n"
          + "You finished on *2100 kcal* and *188g protein*.\n\n"
          + "You came up 1g short on protein — start tomorrow with it at breakfast rather than chasing it tonight.";

        const caught = async (label: string, rows: any[], days = 2) => {
          freshTurn();
          g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([[schema.turnLedger, rows]]);
          const brief: any = await buildCoachHealthBrief(days);
          const hit = (brief.candidates || []).some((c: any) => c.invariant === "closed-day-food-offer");
          delete g.__KAMLIFE_STUB_ROWS;
          return hit;
        };

        // THE RECURRENCE ITSELF. Three turns, one client, one SAST day. Nothing in the offending
        // row says the day is closed — the constraint was stated two turns earlier.
        if (!await caught("recurrence", [
          turn("t-close", USER.id, day0 + 60_000, CLOSED, "Noted — that is the day closed."),
          turn("t-mid", USER.id, day0 + 120_000, "cool", "👍"),
          turn("t-offer", USER.id, day0 + 180_000, "what should I eat?", OFFERED),
        ])) {
          failures.push(`Coach Health did not catch the #138 recurrence: the client closed their food day in an earlier turn, a later turn was offered food today, and the window was reported clean`);
        }

        // CONTROL — CLIENT ISOLATION. One person's closed day must not convict everybody else's
        // meal suggestions. Without this the detector could ignore userId entirely and still pass.
        if (await caught("client isolation", [
          turn("t-close-a", USER.id, day0 + 60_000, CLOSED, "Noted — that is the day closed."),
          turn("t-offer-b", OTHER, day0 + 120_000, "what should I eat?", OFFERED),
        ])) {
          failures.push(`A closed food day for one client flagged ANOTHER client's meal suggestion — one person saying "I'm done eating" would silence the queue for everybody`);
        }

        // CONTROL — DAY ISOLATION. A constraint is a statement about a day. Closed yesterday,
        // offered today, both inside the read window: the product's TODAY ONLY rule.
        if (await caught("day isolation", [
          turn("t-close-yday", USER.id, day0 - 6 * 3_600_000, CLOSED, "Noted — that is the day closed."),
          turn("t-offer-today", USER.id, day0 + 60_000, "what should I eat?", OFFERED),
        ])) {
          failures.push(`Yesterday's closed food day flagged today's meal suggestion — a statement about one day became a standing preference`);
        }

        // CONTROL — ORDER OF EVENTS. A meal suggested BEFORE the client closed the day is not a
        // violation of a constraint that did not exist yet.
        if (await caught("ordering", [
          turn("t-offer-am", USER.id, day0 + 60_000, "what should I eat?", OFFERED),
          turn("t-close-pm", USER.id, day0 + 300_000, CLOSED, "Noted — that is the day closed."),
        ])) {
          failures.push(`A meal suggested BEFORE the client closed their food day was flagged — the detector is ignoring when the constraint was stated`);
        }

        // HEALTHY — the reply the merged fix produces, on a closed day, must not flag. Otherwise
        // the detector is a permanent false positive against its own fix.
        if (await caught("fixed reply", [
          turn("t-close-fx", USER.id, day0 + 60_000, CLOSED, LANDED),
          turn("t-after-fx", USER.id, day0 + 120_000, "ok", "👍"),
        ])) {
          failures.push(`Coach Health flags the FIXED closed-day reply as a failure — #138 would report a permanent regression against itself`);
        }

        // HEALTHY — the same food offer on an OPEN day is the product working. Without this the
        // invariant could be "never recommend a meal" and pass everything above.
        if (await caught("open day", [
          turn("t-open-1", USER.id, day0 + 60_000, "what should I eat?", OFFERED),
          turn("t-open-2", USER.id, day0 + 120_000, "thanks", "👍"),
        ])) {
          failures.push(`A legitimate meal suggestion on an open day was flagged as a closed-day violation — every meal recommendation would become a candidate`);
        }

        // ── #152: A REOPENING ENDS THE CLOSURE, HERE TOO ────────────────────────────────────────
        // readHeldConstraints lets the client's newest explicit decision stand, so this detector
        // had to learn the same rule or it would file the very replies the reversal makes correct.
        if (await caught("after a genuine reopening", [
          turn("t-r-close", USER.id, day0 + 60_000, CLOSED, "Noted — that is the day closed."),
          turn("t-r-open", USER.id, day0 + 120_000, "actually I changed my mind, I'm having dinner", "👍"),
          turn("t-r-offer", USER.id, day0 + 180_000, "what should I eat?", OFFERED),
        ])) {
          failures.push(`Coach Health flagged a meal suggestion made AFTER the client reopened their food day — the detector would file every correct post-reversal reply as a closed-day violation`);
        }
        // ...and a closure that was never reversed still flags. Without this, "a reopening
        // anywhere clears everything" would pass the case above and silence the real defect.
        if (!await caught("reopened, then closed again", [
          turn("t-r2-open", USER.id, day0 + 60_000, "actually I'm having dinner", "👍"),
          turn("t-r2-close", USER.id, day0 + 120_000, CLOSED, "Noted — that is the day closed."),
          turn("t-r2-offer", USER.id, day0 + 180_000, "what should I eat?", OFFERED),
        ])) {
          failures.push(`A food offer after the client closed the day AGAIN was not flagged — the newest decision must win in the detector as well as in the product`);
        }
      }

      /**
       * #152 — REOPENING A CLOSED FOOD DAY, THROUGH THE REAL DOOR.
       *
       * #138 and #144 fixed the opposite failure: offering food after a closure. The closure then
       * had no way back, so a client who closed the day and genuinely ate was refused for the rest
       * of it, every time they asked. Graded on what the client actually receives, because the
       * whole defect was that the meal door kept standing down.
       *
       * History is supplied NEWEST FIRST, which is how the production query returns it
       * (recentClientMessagesStamped: ORDER BY created_at DESC). Feeding it oldest-first would
       * invert the ordering case and quietly grade the opposite of what production does.
       */
      {
        const CLOSE = "I am done eating today";
        const REOPEN = "actually I changed my mind, I'm having dinner";
        const DAY_CLOSED = /leaving it there|done eating today/i;
        const askAfter = async (historyNewestFirst: string[], ask = "what should I eat?") => {
          freshTurn();
          g.__KAMLIFE_STUB_USER = { ...USER };
          g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([[schema.mealLogs, [{
            id: "ml-152", userId: USER.id, loggedAt: new Date(dayStart.getTime() + 60_000),
            at: new Date(dayStart.getTime() + 60_000),
            kcalInt: 2100, proteinInt: 188, carbsInt: 200, fatInt: 70,
            kcal: 2100, protein: 188, carbs: 200, fat: 70, calories: 2100,
            mealLabel: "dinner", label: "dinner", source: "text",
            items: [{ name: "Chicken", kcal: 2100, protein: 188 }], rawMessage: "dinner", sourceMessageId: null,
          }]]]);
          g.__KAMLIFE_STUB_PGROWS = historyNewestFirst.map((text, i) => ({
            message_in: text,
            created_at: new Date(dayStart.getTime() + (historyNewestFirst.length - i) * 60_000),
          }));
          const reply = String(await handleMessage(USER.phoneNumber, ask).catch(() => ""));
          delete g.__KAMLIFE_STUB_PGROWS;
          delete g.__KAMLIFE_STUB_ROWS;
          return reply;
        };

        // 1 — THE REVERSAL ITSELF.
        if (DAY_CLOSED.test(await askAfter([REOPEN, CLOSE]))) {
          failures.push(`A client who closed their food day and then said "${REOPEN}" was still refused a meal — an explicit change of mind has no way back and they are locked out until midnight`);
        }
        // 2 — AND THE CLOSURE STILL HOLDS WITHOUT ONE. This is #138, re-asserted here: the cut
        //     must not have bought the reversal by weakening the constraint.
        if (!DAY_CLOSED.test(await askAfter(["did 9000 steps", CLOSE]))) {
          failures.push(`An unrelated message after a closure reopened the food day — the constraint no longer survives the turn that follows it`);
        }
        // 3 — OVER-FIRE: asking for a meal is not deciding to eat one.
        if (!DAY_CLOSED.test(await askAfter([CLOSE]))) {
          failures.push(`The meal request itself reopened the closed day — every "what should I eat?" would cancel the client's own decision`);
        }
        // 4 — AMBIGUITY: considering is not deciding.
        if (!DAY_CLOSED.test(await askAfter(["thinking about dinner", CLOSE]))) {
          failures.push(`"thinking about dinner" silently reopened a closed food day — a mention of food is not a decision to eat`);
        }
        // 5 — ORDERING: the newest explicit decision wins, in both directions.
        if (!DAY_CLOSED.test(await askAfter([CLOSE, REOPEN, CLOSE]))) {
          failures.push(`A client who reopened and then closed the day AGAIN was still treated as open — the newest decision must win, not the first or the loudest`);
        }
        // 6 — CONTROL: a day nobody closed is open, so none of the above passes by never closing.
        if (DAY_CLOSED.test(await askAfter(["did 9000 steps"]))) {
          failures.push(`A day the client never closed came back closed — the door is standing down on its own`);
        }
        // 7 — A DECISION ABOUT ANOTHER DAY IS NOT A DECISION ABOUT THIS ONE (CTO hold on #155).
        //     readHeldConstraints filters by WHEN a message was sent, never by which day the
        //     sentence is about, so tomorrow's plan carried the full commitment shape and would
        //     have reopened tonight.
        if (!DAY_CLOSED.test(await askAfter(["I'm having dinner tomorrow", CLOSE]))) {
          failures.push(`"I'm having dinner tomorrow" reopened TODAY's closed food day — a plan for another day cancelled a constraint about this one`);
        }
        if (!DAY_CLOSED.test(await askAfter(["I'll eat tomorrow", CLOSE]))) {
          failures.push(`"I'll eat tomorrow" reopened today's closed food day — the same defect in its plainest form`);
        }
        // 8 — A ZERO-FOOD STATEMENT IS THE CONSTRAINT RESTATED, NOT WITHDRAWN. "I'm eating nothing
        //     else today" carries the positive prefix "I'm eating", so the commitment shape alone
        //     read the plainest restatement of the closure as its cancellation.
        if (!DAY_CLOSED.test(await askAfter(["I'm eating nothing else today", CLOSE]))) {
          failures.push(`"I'm eating nothing else today" reopened the closed food day — a commitment to eat NOTHING was read as a decision to eat`);
        }
        // 9 — AND THE GENUINE REVERSAL STILL WORKS. Without this, both guards could be "never
        //     reopen" and cases 7 and 8 would pass while the feature was gone.
        if (DAY_CLOSED.test(await askAfter(["I'm having dinner tonight after all", CLOSE]))) {
          failures.push(`A genuine same-day reversal stopped working once the future-day and zero-food guards were added — the guards took the feature with them`);
        }

        /**
         * THE TURN'S OWN WORDS (#152, CTO re-adjudication). readHeldConstraints reads HISTORY, and
         * the message being answered is not in it yet — so "I'm eating now, what should I eat?"
         * carried its own reversal into a door that was looking everywhere except at it. live.ts
         * folded the current message in for CLOSURE only, so the fold could tighten the constraint
         * and never release it.
         *
         * Graded where each door can actually be reached. The SMART NEXT MEAL door is reachable
         * for the CLOSURE direction — a current-message closure with no history at all must still
         * close the day — and for the history direction (case 3 above). It is NOT reachable for the
         * release direction: any message that states eating is claimed by the food clarifier first,
         * on this branch and on main alike, so the reply is identical either way and would prove
         * nothing. That direction is graded on the Meaning Engine's state below, which is the
         * consumer that actually differed.
         */
        // Graded on the requirement, not on one door's wording: a client who closed the day in the
        // same breath as the ask must not be SOLD A MEAL. Which owner answers is not this cut's
        // business — several may legitimately claim an utterance that closes the day.
        const SELLS_A_MEAL = /Next Meal Suggestion|Pick one:|Start with:/i;
        const sameTurnClose = await askAfter([], "I am done eating today, what should I eat?");
        if (SELLS_A_MEAL.test(sameTurnClose)) {
          failures.push(`A closure stated in the SAME turn as the ask was ignored and the client was sold a meal they had just refused: "${sameTurnClose.split("\n").filter(Boolean)[0]}"`);
        }
        const bothInOne = await askAfter([], "I'm eating now but I am done eating today, what should I eat?");
        if (SELLS_A_MEAL.test(bothInOne)) {
          failures.push(`One utterance carrying BOTH a reversal and a closure was treated as open and sold a meal — the conservative tie-break must hold inside a single message: "${bothInOne.split("\n").filter(Boolean)[0]}"`);
        }
      }

      /**
       * #152 — THE CURRENT TURN'S OWN WORDS, AND BOTH DOORS READING THEM THE SAME WAY.
       *
       * The release direction cannot be graded on the SMART NEXT MEAL reply: any message that
       * states eating is claimed by the food clarifier before the meal door, on this branch and on
       * main alike, so the reply is byte-identical either way and would prove nothing. It IS
       * graded here, on the seam owner and on the state the Meaning Engine actually computes —
       * which is the consumer that differed, because live.ts folded the current message in for
       * closure only and could therefore tighten the constraint but never release it.
       */
      {
        const { foodDayClosedWith } = await import("../server/held-constraints");
        const cases: Array<[string, boolean, boolean, string]> = [
          // [current message, held-from-history, expected effective closed, why]
          ["I'm eating now, what should I eat?", true, false, "the reversal is in the turn being answered"],
          ["what should I eat?", true, true, "an ask is not a decision — history stands"],
          ["I'm having dinner tomorrow, what should I eat?", true, true, "a plan for another day"],
          ["I'm eating nothing else today, what should I eat?", true, true, "a commitment to eat nothing"],
          ["I'm eating now but I am done eating today", true, true, "closure wins inside one utterance"],
          ["I'm eating now, what should I eat?", false, false, "nothing was closed to begin with"],
        ];
        for (const [msg, held, expected, why] of cases) {
          const got = foodDayClosedWith(held, msg);
          if (got !== expected) {
            failures.push(`The turn's own words were read wrongly — "${msg}" with held=${held} gave closed=${got}, expected ${expected} (${why})`);
          }
        }

        // BOTH DOORS, ONE ANSWER. The Meaning Engine builds its DayState from this same owner, so
        // the deterministic meal door and the coaching decision cannot disagree about one sentence.
        // Graded on the engine's real state rather than on its wording.
        const { canonicalDecision } = await import("../server/understanding/live");
        freshTurn();
        g.__KAMLIFE_STUB_USER = { ...USER };
        g.__KAMLIFE_STUB_PGROWS = [{ message_in: "I am done eating today", created_at: new Date(dayStart.getTime() + 60_000) }];
        const closedStill = await canonicalDecision({ ...USER }, "what should I eat?").catch(() => null);
        const reopened = await canonicalDecision({ ...USER }, "I'm eating now, what should I eat?").catch(() => null);
        delete g.__KAMLIFE_STUB_PGROWS;
        if (closedStill && reopened && closedStill.todo === reopened.todo && /eat|protein|meal/i.test(String(reopened.todo))) {
          failures.push(`The Meaning Engine reached the SAME food instruction whether or not the turn reopened the day ("${reopened.todo}") — the current message is not reaching its held state, so the engine and the meal door are deciding from different facts`);
        }
      }

      /**
       * #152 — USER AND DAY ISOLATION, on the reader Coach Health uses.
       *
       * The reversal must be as narrowly scoped as the closure it cancels: one person changing
       * their mind cannot open somebody else's day, and yesterday's change of mind cannot open
       * today. Graded on foodCloseLookup, which is where both facts are keyed.
       */
      {
        const { foodCloseLookup } = await import("../server/held-constraints");
        const d0 = dayStart.getTime();
        const OTHER = "stub-other-client-0000000000000001";
        const closed = (uid: string, at: number) => ({ userId: uid, at, input: "I am done eating today" });
        const opened = (uid: string, at: number) => ({ userId: uid, at, input: "actually I'm having dinner" });

        const crossUser = foodCloseLookup([closed(USER.id, d0 + 60_000), opened(OTHER, d0 + 120_000)]);
        if (crossUser(USER.id, d0 + 180_000) === null) {
          failures.push(`Another client's change of mind reopened this client's closed day — one person saying "I'm having dinner" would cancel everybody else's constraint`);
        }
        const crossDay = foodCloseLookup([
          closed(USER.id, d0 + 60_000),
          opened(USER.id, d0 - 6 * 3_600_000),   // yesterday, in SAST terms
        ]);
        if (crossDay(USER.id, d0 + 180_000) === null) {
          failures.push(`Yesterday's change of mind reopened today's closed day — a decision about one day became a standing preference`);
        }
        // ...and within the day, the reversal does work. Without this the two checks above pass
        // on a lookup that simply ignores reopenings.
        const sameDay = foodCloseLookup([closed(USER.id, d0 + 60_000), opened(USER.id, d0 + 120_000)]);
        if (sameDay(USER.id, d0 + 180_000) !== null) {
          failures.push(`A same-day reopening did not clear the closure in the reader Coach Health uses — the detector and the product would disagree about the same client`);
        }

        // COACH HEALTH MUST AGREE WITH THE PRODUCT ON THE TWO OVER-FIRES (CTO hold on #155). If it
        // did not, a reply that the product correctly withheld would still be judged against an
        // "open" day — or worse, a correct closed-day reply would be filed as a violation.
        for (const [label, said] of [
          ["a plan for tomorrow", "I'm having dinner tomorrow"],
          ["a commitment to eat nothing", "I'm eating nothing else today"],
        ] as const) {
          const look = foodCloseLookup([
            closed(USER.id, d0 + 60_000),
            { userId: USER.id, at: d0 + 120_000, input: said },
          ]);
          if (look(USER.id, d0 + 180_000) === null) {
            failures.push(`Coach Health treated ${label} ("${said}") as a reopening — the detector and the product now disagree about whether this client's day is closed`);
          }
        }
      }

      /**
       * P0 #115 — ONE PAGE OPEN, ONE AUDITED EVALUATION.
       *
       * Both Coach Health panels mounted together and each fetched its own endpoint, so opening
       * the page scanned the same window twice and wrote TWO audit records before the operator saw
       * anything. The audit trail is the behavioural signal here and it is already in the system:
       * one ledger evaluation writes exactly one record, so counting them counts evaluations.
       *
       * Graded on the real function, with the adjudicated panel's data required to be present in
       * that same single evaluation — otherwise "one read" would just mean the second panel lost
       * its data.
       */
      {
        const { buildCoachHealthBrief } = await import("../server/routes/admin-turns");
        freshTurn();
        g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([[schema.turnLedger, [{
          id: "tl-perf", userId: USER.id, createdAt: new Date(),
          inputText: "what can I eat?", reply: "I didn't catch that one — what was it, roughly?",
          mutations: [], stateRead: {}, version: "47f0789",
          lifecycleStatus: null, failureCategory: null, fixRef: null,
        }]]]);
        g.__KAMLIFE_STUB_WRITES = [];
        const brief: any = await buildCoachHealthBrief(1);
        const audits = (g.__KAMLIFE_STUB_WRITES || []).filter((w: any) => w.table === schema.adminEvents);
        if (audits.length !== 1) {
          failures.push(`One Coach Health evaluation wrote ${audits.length} audit records — a page open should be one read, and the count is how that is measured`);
        }
        if (!brief.adjudicated || !Array.isArray(brief.adjudicated.clusters) || brief.adjudicated.clusters.length === 0) {
          failures.push(`The single evaluation carries no adjudicated-regression data — the second panel would need its own ledger scan again`);
        }
        if (!Array.isArray(brief.candidates)) {
          failures.push(`The single evaluation lost the candidate queue — one read must still serve both panels`);
        }
        delete g.__KAMLIFE_STUB_ROWS;
      }

      /**
       * A2 — THE SCHEDULED READ IS AUDITED LIKE EVERY OTHER READ.
       *
       * buildCoachHealthBrief reads inbound text, replies, mutations and state. The audit call sat
       * in the route handler, so a person opening the page was recorded and the hourly job reading
       * the same rows was not. Graded on the row the read actually writes, and on it naming the
       * scheduler rather than a person — a record that cannot tell them apart is not an audit.
       */
      {
        const { runCoachHealthSweep } = await import("../server/routes/admin-turns");
        freshTurn();
        g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([[schema.turnLedger, []]]);
        g.__KAMLIFE_STUB_WRITES = [];
        await runCoachHealthSweep(1);
        const audits = (g.__KAMLIFE_STUB_WRITES || []).filter((w: any) => w.table === schema.adminEvents);
        if (audits.length === 0) {
          failures.push(`The scheduled Coach Health read wrote no audit record — the background reader bypasses the control every guarded endpoint obeys`);
        } else if (!audits.some((w: any) => String(w.values?.action || "").includes("sweep") || w.values?.meta?.scheduled === true)) {
          failures.push(`The scheduled read was audited as though a person had made it: ${JSON.stringify(audits[0]?.values?.action)} — the trail cannot distinguish the job from an operator`);
        }
        delete g.__KAMLIFE_STUB_ROWS;
      }
    }
    const check = (id: string, input: string, reply: string, mutations: string[] = []) => {
      const rule = COACH_HEALTH_RULES.find(r => r.id === id);
      if (!rule) { failures.push(`Coach Health lost the rule "${id}" — the dashboard now watches one fewer adjudicated failure`); return null; }
      return rule.asks(input) && rule.failed({ reply, mutations });
    };
    // [message, pre-fix reply that MUST flag, post-fix reply that must NOT, mutations]
    const OBSERVED: Array<[string, string, string, string, string[]]> = [
      ["plate-ask-routing", "what should I eat?",
        "*Your 3-Day Meal Plan*\nGoal: Fat loss · 2700 kcal/day · 180g protein\nBudget: R100–R300/week",
        "*🍽️ Next Meal Suggestion — Kam*\n\nYou need *100g more protein* today. That is the priority.", []],
      ["goal-distance-missing", "How far am I from my goal?",
        "Kam — Scale: down 6.0kg since you started. This week: 0/3 sessions.\n\nThat's the distance. The next move is still one thing.",
        "Kam — 7.0kg to go: 92kg now, 85kg the goal. Scale: down 6.0kg since you started.", []],
      ["meal-for-calories-claim", "Give me a meal for my last 668 calories",
        "Kam, today: *2000/2700 kcal* · *200g/180g* protein. *700 kcal* left.",
        "*🍽️ Next Meal Suggestion — Kam*\n\nYou need *100g more protein* today.", []],
      ["step-raise-no-move", "I walked 8500 steps today",
        "8 500 steps — nice one. 👌",
        "8 500 steps — nice one. 👌\n\nStand on a scale this morning, before you eat.",
        ["UPDATE steps=8500 (was 3000)"]],
    ];
    for (const [id, input, broken, fixed, mutations] of OBSERVED) {
      if (check(id, input, broken, mutations) === false) {
        failures.push(`Coach Health would not have caught the failure it was built from — rule "${id}" passed the observed pre-fix reply: "${broken.replace(/\n/g, " ⏎ ")}"`);
      }
      if (check(id, input, fixed, mutations) === true) {
        failures.push(`Coach Health flags the FIXED reply as a failure — rule "${id}" would report a permanent false positive: "${fixed.replace(/\n/g, " ⏎ ")}"`);
      }
    }
  }

  /**
   * ONE CLIENT STATE -> ONE PROACTIVE ANSWER (2026-08-28, traced through both policy paths).
   *
   * underPolicy and decideProactive both answer "may we prescribe?" and answered it differently.
   * Measured on ONE state — sick, two of seven days logged, 09:00:
   *
   *     decideProactive  ->  rest    "Rest today. No training, no targets."
   *     underPolicy      ->  hold    "Nothing new today. Do exactly what you did yesterday."
   *
   * Telling a sick person to repeat yesterday is the wrong instruction, and it re-broke a finding
   * one-action.ts already carried: illness is directly observed durable state, sufficient by
   * construction (2026-08-18). decideProactive knew it; the gate took a bare boolean and could not.
   *
   * Graded on the ACTIONS BOTH PATHS PRODUCE from one state, not on the predicate that chooses
   * them — the two must agree, and the sparse-evidence protection must survive.
   */
  {
    const { chooseAction, underPolicy, decideProactive, dayStateFrom } = await import("../server/one-action");
    const profile: any = {
      dreamGoal: null, biggestStruggle: null, doNotMention: null, lifeContext: null,
      weeksOnProgramme: 5, sessionsTarget: 3, calorieTarget: 2700, proteinTarget: 180, stepsTarget: 10000,
    };
    const stateOf = (over: any) => ({
      name: "Kam", goalType: "fat_loss",
      health: { sick: false },
      food: { loggedDays7d: 2, daysSinceAnyLog: 0 },
      workout: { sessionsLast7d: 1, sessionsThisWeek: 1 },
      steps: { avg7d: 3000 },
      weight: { daysSinceWeighIn: 4, trendUsable: false },
      today: { kcal: 1200, protein: 70, steps: 2000, logged: true, hour: 9 },
      evidence: { foodSufficient: false, weightSufficient: false },
      ...over,
    }) as any;
    // Both paths, from one state, with the evidence each genuinely holds.
    const bothPaths = (s: any) => {
      const proactive = decideProactive(s, profile, { hour: 9 });
      const reactive = underPolicy(chooseAction(dayStateFrom(s, profile, { hour: 9 })), {
        foodSufficient: s.evidence.foodSufficient,
        weightSufficient: s.evidence.weightSufficient,
        dreamGoal: null,
      });
      return { proactive: proactive.action, reactive };
    };

    // THE DEFECT: illness is its own evidence, and both paths must know it.
    {
      const { proactive, reactive } = bothPaths(stateOf({ health: { sick: true } }));
      if (proactive.kind !== reactive.kind) {
        failures.push(`Two proactive constitutions disagree on one client: decideProactive says "${proactive.todo}" and underPolicy says "${reactive.todo}"`);
      }
      if (reactive.kind !== "rest") {
        failures.push(`A sick client did not get rest from the reactive gate — it said "${reactive.todo}"`);
      }
    }

    // CONTROL — SPARSE EVIDENCE STILL PROTECTS. A thin ledger must not buy a prescription just
    // because the paths now agree. Agreement is worthless if both agree to over-reach.
    {
      const { reactive } = bothPaths(stateOf({}));
      if (["protein", "walk", "train", "eat_more"].includes(reactive.kind)) {
        failures.push(`A client with two logged days and no weight trend was prescribed "${reactive.todo}" — sparse evidence stopped protecting`);
      }
    }

    // CONTROL — REAL EVIDENCE STILL EARNS AN ANSWER. A gate that holds everything would satisfy
    // the control above and make the coach mute.
    {
      const { reactive } = bothPaths(stateOf({ evidence: { foodSufficient: true, weightSufficient: false } }));
      if (reactive.kind === "hold") {
        failures.push(`A well-evidenced client was held silent by the gate — it now refuses to coach at all`);
      }
    }

    /**
     * ILLNESS CONSTRAINS THE LADDER, NOT THE PROSE.
     *
     * The distinction the whole cut rests on. If chooseAction could still pick `train` for a sick
     * client and a wrapper rewrote the sentence afterwards, we would have replaced one
     * contradiction with a politer one — the decision would still be wrong, and only the words
     * would agree. Illness is rung 2 of the ladder, ahead of every prescriptive rung, so the
     * refusal happens where the decision is made.
     *
     * Graded from states that DO reach a prescription when healthy, so the assertion cannot pass
     * because nothing was going to be prescribed anyway.
     */
    for (const [label, over] of [
      ["would train", { workout: { sessionsLast7d: 0, sessionsThisWeek: 0 }, evidence: { foodSufficient: true, weightSufficient: true } }],
      ["would walk", { steps: { avg7d: 500 }, today: { kcal: 1200, protein: 70, steps: 200, logged: true, hour: 14 }, evidence: { foodSufficient: true, weightSufficient: true } }],
      ["would protein", { today: { kcal: 1200, protein: 20, steps: 2000, logged: true, hour: 9 }, evidence: { foodSufficient: true, weightSufficient: true } }],
    ] as [string, any][]) {
      const healthy = chooseAction(dayStateFrom(stateOf(over), profile, { hour: 9 }));
      const sick = chooseAction(dayStateFrom(stateOf({ ...over, health: { sick: true } }), profile, { hour: 9 }));
      if (healthy.kind === "hold" || healthy.kind === "rest") {
        failures.push(`The "${label}" fixture no longer reaches a prescription when healthy (${healthy.kind}) — the illness assertion below would pass for the wrong reason`);
      }
      if (sick.kind !== "rest") {
        failures.push(`The decision ladder prescribed "${sick.todo}" to a sick client — illness is not constraining the decision, only the wording`);
      }
    }
    // AND THE GATE DOES NOT RE-WORD WHAT THE LADDER DECIDED. Object identity, not string equality:
    // a gate that rebuilt an equivalent action would be a second author of the same decision.
    {
      const s = stateOf({ health: { sick: true } });
      const raw = chooseAction(dayStateFrom(s, profile, { hour: 9 }));
      const passed = underPolicy(raw, { foodSufficient: false, weightSufficient: false, dreamGoal: null });
      if (passed !== raw) {
        failures.push(`The policy gate returned a different object than the ladder chose — it is re-authoring the decision, not applying a policy to it`);
      }
    }
  }

  /**
   * THE OBSERVED TRACE, 2026-08-28 16:45-16:49 SAST — two of the five failures.
   *
   * DEFECT 1. "You need 129g more protein today. That is the priority." followed by two eggs and
   * pap (18g), with 2,146 kcal unspent. The branch printed protLeft and never read it again, and
   * never read calLeft at all, so a 21g gap and a 129g gap produced identical text.
   *
   * DEFECT 5. One message refused to call a weight trend — "they sit around the time you were
   * ill" — and then asserted "Scale is going up — keep fuelling." Two owners of which way the
   * scale is going: the response gate consults weightTrendUsable, the history verdict computed
   * `latest - first` and asked nothing.
   */
  {
    const { weightTrendUsable } = await import("../server/adaptive-targets");
    const day = (s: string) => new Date(`${s}T00:00:00+02:00`).getTime();
    const now = day("2026-08-28");

    /**
     * #126 — WEIGHT SPEECH HAS ONE OWNER, AND IT DECIDES BEFORE THE REPLY IS COMPOSED.
     *
     * Defect 5 fixed the weight HISTORY command. The weight CHART was never fixed and never asked:
     * traced on current main with weigh-ins spanning a recorded illness it rendered an arrow, a
     * pace and a coaching line straight off `last - first`, while the canonical evidence refused
     * to call any direction at all.
     *
     * Graded on what the handler hands over, because that is the owner this cut changes. The
     * outbound gate is deliberately NOT the instrument here: it classifies one sentence at a time,
     * and the same trace showed it catching the header, deleting the client's weigh-ins with it,
     * and leaving "this is muscle. Keep training hard." standing — the direction surviving in a
     * sentence with no direction words. A boundary that loses the data and keeps the claim cannot
     * be what this property rests on.
     */
    {
      const day = (d: number) => new Date(Date.now() - d * 86_400_000);
      const rows = (kgs: number[], days: number[]) => kgs.map((w, i) => ({
        id: `wq${i}`, userId: USER.id, weight: w, weightKg: w,
        // BOTH keys on purpose: getWeightTruth selects { at: loggedAt } and the stub returns raw
        // rows without applying the alias, so a fixture with only loggedAt reads as Invalid Date
        // and every assertion below would grade a NaN.
        loggedAt: day(days[i]), at: day(days[i]),
      }));
      const iso = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
      const weightTurn = async (ask: string, o: { kgs: number[]; days: number[]; sick: boolean; goal: string }) => {
        freshTurn();
        g.__KAMLIFE_STUB_USER = {
          ...USER, goalType: o.goal, currentWeight: o.kgs[o.kgs.length - 1], todayWater: "0",
          profileNotes: o.sick ? `sick_since:${iso(14)} sick_until:${iso(6)}` : "",
        };
        g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([
          [schema.weightLogs, rows(o.kgs, o.days)], [schema.mealLogs, []],
          [schema.stepLogs, []], [schema.workoutLogs, []],
        ]);
        g.__KAMLIFE_STUB_WRITES = [];
        return String(await handleMessage(USER.phoneNumber, ask).catch(() => ""));
      };
      const flat2 = (r: string) => r.replace(/\n/g, " ⏎ ");
      const SPANS_ILLNESS = { kgs: [95.0, 96.2, 97.4], days: [20, 12, 4], sick: true, goal: "muscle_gain" };
      const CLEAN = { kgs: [98.0, 95.5, 92.0], days: [28, 14, 2], sick: false, goal: "fat_loss" };

      // THE OBSERVED CONTRADICTION, on both weight surfaces.
      for (const ask of ["weight chart", "weight history"]) {
        const r = await weightTurn(ask, SPANS_ILLNESS);
        if (!/95\.0|97\.4/.test(r)) {
          failures.push(`"${ask}" stopped returning the client's own weigh-ins — the rest of this block grades nothing: "${flat2(r)}"`);
          continue;
        }
        if (/⬆️|⬇️|\bUp \d|\bDown \d|going up|going down|keep fuelling/i.test(r)) {
          failures.push(`"${ask}" asserted a weight direction over weigh-ins that span an illness — the same contradiction the response gate refuses: "${flat2(r)}"`);
        }
        if (/pace [+-]?\d/i.test(r)) {
          failures.push(`"${ask}" stated a weekly PACE off a trend the evidence refuses — a rate is a direction with a number on it: "${flat2(r)}"`);
        }
        if (/Keep training hard|deficit is working|Gaining as planned/i.test(r)) {
          failures.push(`"${ask}" drew a coaching conclusion from a direction it may not call: "${flat2(r)}"`);
        }
        // ...AND THE FACTS THEY ASKED FOR SURVIVE. Refusing to call a trend must not cost the
        // client their own history.
        if (!/95\.0/.test(r) || !/97\.4/.test(r)) {
          failures.push(`"${ask}" dropped the weigh-ins while refusing the trend — they asked for their numbers: "${flat2(r)}"`);
        }
      }

      // POSITIVE CONTROL — a clean, usable trend must still be spoken, on both surfaces. Without
      // this, "never say a direction" passes every assertion above and the product goes mute.
      {
        const chart = await weightTurn("weight chart", CLEAN);
        if (!/⬇️|Down 6\.0kg/.test(chart)) {
          failures.push(`A clean four-week 6kg loss was no longer called on the chart — the fix went mute instead of honest: "${flat2(chart)}"`);
        }
        if (!/pace -/.test(chart)) {
          failures.push(`A usable trend lost its pace line — legitimate output must be preserved: "${flat2(chart)}"`);
        }
        const hist = await weightTurn("weight history", CLEAN);
        if (!/Down 6\.0kg since you started/.test(hist)) {
          failures.push(`A clean usable trend lost its direction on the history surface: "${flat2(hist)}"`);
        }
        if (!/Moving in the right direction/.test(hist)) {
          failures.push(`A usable fat-loss trend lost its coaching verdict: "${flat2(hist)}"`);
        }
      }
    }

    // DEFECT 5 — the observed shape: weigh-ins spanning an illness cannot carry a direction.
    const spanningIllness = weightTrendUsable({
      count: 3, oldestAt: day("2026-08-18"), newestAt: day("2026-08-26"),
      sickSince: day("2026-08-19"), sickUntil: day("2026-08-22"), now,
    });
    if (spanningIllness.usable) {
      failures.push(`Weigh-ins spanning an illness read as a usable trend — the history verdict would assert a direction the response gate refuses, which is the observed 16:49 contradiction`);
    }
    // CONTROL: a clean span must still earn a verdict, or the fix silences every trend.
    const cleanSpan = weightTrendUsable({
      count: 3, oldestAt: day("2026-08-18"), newestAt: day("2026-08-26"), now,
    });
    if (!cleanSpan.usable) {
      failures.push(`A clean three-point span no longer reads as usable — the weight history would never state a direction again`);
    }

    // DEFECT 1 — the recommendation must address the gap it just quoted, and must offer nothing
    // the day's remaining calories cannot pay for. Graded on the reply the client reads, driven
    // through handleMessage from the observed numbers. The first version of this test graded a
    // re-implementation of the branch's own arithmetic, which is worth nothing: it would have
    // stayed green with the handler deleted.
    {
      const { sastToday } = await import("../server/utils");
      type MealPart = { kcal: number; protein: number; source?: string; label?: string };
      const mealRows = (parts: MealPart[]) => parts.map((part, i) => ({
        id: `meal-${i}`, userId: USER.id,
        mealLabel: part.label || "meal", source: part.source || "sa_scanner",
        loggedAt: new Date(dayStart.getTime() + (i + 1) * 3_600_000), corrected: false,
        kcalInt: part.kcal, proteinInt: part.protein,
        kcal: part.kcal, protein: part.protein, carbs: 0, fat: 0,
      }));
      const mealTurn = async (o: {
        protLeft: number; calLeft: number; budget: string;
        ledger?: MealPart[];
        overlay?: { calories: number; protein: number };
      }) => {
        freshTurn();
        const ledger = o.ledger || [{ kcal: 2400 - o.calLeft, protein: 150 - o.protLeft }];
        const overlay = o.overlay || { calories: 2400 - o.calLeft, protein: 150 - o.protLeft };
        g.__KAMLIFE_STUB_USER = {
          ...USER, todayWater: "0", weeklyFoodBudget: o.budget,
          todayCaloriesDate: sastToday(), calorieTarget: 2400, proteinTarget: 150,
          todayCalories: overlay.calories, todayProteinG: overlay.protein,
        };
        g.__KAMLIFE_STUB_ROWS = new Map([
          [schema.mealLogs, mealRows(ledger)], [schema.stepLogs, []], [schema.workoutLogs, []], [schema.weightLogs, []],
        ]);
        g.__KAMLIFE_STUB_WRITES = [];
        return String(await handleMessage(USER.phoneNumber, "what should I eat next?").catch(() => ""));
      };
      const flat = (r: string) => r.replace(/\n/g, " ⏎ ");

      /**
       * #127 — SMART NEXT MEAL MUST DECIDE FROM THE DAY LEDGER.
       *
       * Each control drives the actual route handler with deliberately disagreeing meal rows and
       * users overlay. Reverting the owner to todayCalories/todayProteinG makes controls 1–4 read
       * the stale overlay and fail; the matching control keeps today's rendered recommendation.
       */
      {
        // 1. Protein is met and 700 kcal remain. A stale overlay must not manufacture a gap.
        const met = await mealTurn({
          protLeft: 0, calLeft: 700, budget: "100_300",
          ledger: [{ kcal: 1700, protein: 150 }],
          overlay: { calories: 400, protein: 20 },
        });
        if (!/700 kcal and 0g protein to go/i.test(met) || /130g more protein/i.test(met)) {
          failures.push(`Ledger protein completion with 700 kcal left was replaced by the stale overlay: "${flat(met)}"`);
        }

        // 2. Only 200 kcal remain and protein is genuinely short: the ledger must choose a plate
        // that fits, even when the overlay claims ample calories and protein completion.
        const tightProtein = await mealTurn({
          protLeft: 130, calLeft: 200, budget: "100_300",
          ledger: [{ kcal: 2200, protein: 20 }],
          overlay: { calories: 1700, protein: 150 },
        });
        if (!/200 kcal and 130g protein left/i.test(tightProtein)
          || !/Tuna salad, no dressing/i.test(tightProtein)
          || /\(~(?:[3-9]\d\d|[1-9]\d{3,}) kcal/i.test(tightProtein)) {
          failures.push(`Ledger's tight protein gap did not produce an affordable protein-first plate: "${flat(tightProtein)}"`);
        }

        // 3. A photo plus another logged row folds before the decision; its stale overlay loses.
        const photoMultiRow = await mealTurn({
          protLeft: 0, calLeft: 700, budget: "100_300",
          ledger: [
            { kcal: 900, protein: 80, source: "photo", label: "lunch" },
            { kcal: 800, protein: 70, label: "dinner" },
          ],
          overlay: { calories: 300, protein: 10 },
        });
        if (!/700 kcal and 0g protein to go/i.test(photoMultiRow) || /140g more protein/i.test(photoMultiRow)) {
          failures.push(`Photo/multi-row ledger total lost to the stale overlay: "${flat(photoMultiRow)}"`);
        }

        // 4. Post-removal rows immediately change the same ask while the mirror still holds the
        // old total. This is the state the correction/removal writer leaves for the next turn.
        const beforeRemoval = await mealTurn({
          protLeft: 130, calLeft: 200, budget: "100_300",
          ledger: [{ kcal: 2200, protein: 20 }],
          overlay: { calories: 2200, protein: 20 },
        });
        const afterRemoval = await mealTurn({
          protLeft: 0, calLeft: 700, budget: "100_300",
          ledger: [{ kcal: 1700, protein: 150 }],
          overlay: { calories: 2200, protein: 20 },
        });
        if (!/200 kcal and 130g protein left/i.test(beforeRemoval)
          || !/700 kcal and 0g protein to go/i.test(afterRemoval)
          || beforeRemoval === afterRemoval) {
          failures.push(`Post-correction/removal ledger rows did not immediately change SMART NEXT MEAL: before="${flat(beforeRemoval)}" after="${flat(afterRemoval)}"`);
        }

        // 5. The ordinary, healthy state is a control: matching mirror and ledger keep the
        // existing rendered suggestion rather than changing policy or wording.
        const matching = await mealTurn({
          protLeft: 1, calLeft: 700, budget: "100_300",
          ledger: [{ kcal: 1700, protein: 149 }],
          overlay: { calories: 1700, protein: 149 },
        });
        if (!/700 kcal and 1g protein to go/i.test(matching)
          || !/Chicken \+ sweet potato \+ vegetables/i.test(matching)) {
          failures.push(`Matching ledger and overlay changed today's SMART NEXT MEAL policy: "${flat(matching)}"`);
        }
      }

      // THE OBSERVED TURN: 129g short with 2 146 kcal unspent.
      {
        const r = await mealTurn({ protLeft: 129, calLeft: 2146, budget: "under_100" });
        if (!/129g/.test(r)) {
          failures.push(`The 129g meal turn no longer reaches the protein branch at all — the rest of this block is grading nothing: "${flat(r)}"`);
        } else {
          const strongest = r.indexOf("pilchards"), weakest = r.indexOf("2 eggs + pap");
          if (strongest < 0 || weakest < 0 || strongest > weakest) {
            failures.push(`A client 129g short is still led with the weaker option: "${flat(r)}"`);
          }
          // The observed defect: state a 129g deficit, then answer it with an 18g plate and say
          // nothing more. Something in the reply has to acknowledge that one plate is not enough.
          if (!/none of those closes 129g/i.test(r)) {
            failures.push(`A 129g gap was answered with a menu and no word that one plate does not close it: "${flat(r)}"`);
          }
          // ...but not by inventing a plan. "about 6 protein meals" is a number the client never
          // gave and the coach cannot stand behind.
          if (/\bprotein meals\b/i.test(r) || /\b\d+\s*(?:more\s*)?meals\b/i.test(r)) {
            failures.push(`The reply prescribes a meal count instead of a priority: "${flat(r)}"`);
          }
        }
      }

      // CONTROL — AFFORDABILITY. 420 kcal left cannot carry the 450 kcal plate, so it may not be
      // offered. Without this, "lead with the strongest" simply moves the defect: a client is told
      // to eat something they have no room for.
      {
        const r = await mealTurn({ protLeft: 129, calLeft: 420, budget: "100_300" });
        if (/Chicken breast \+ rice/i.test(r)) {
          failures.push(`A 450 kcal meal was offered to a client with 420 kcal left: "${flat(r)}"`);
        }
        if (!/pilchards/i.test(r)) {
          failures.push(`Affordability filtering left the client with no option at all: "${flat(r)}"`);
        }
      }

      // CONTROL — A SMALL GAP STAYS SIMPLE. 22g is closed by the option on offer, so the reply
      // must read exactly as it always did, with no shortfall sentence bolted on.
      {
        const r = await mealTurn({ protLeft: 22, calLeft: 2146, budget: "under_100" });
        if (/none of those closes/i.test(r)) {
          failures.push(`A 22g gap the top option genuinely covers was told it falls short — the fix over-fires on ordinary days: "${flat(r)}"`);
        }
      }

      /**
       * #125 — "I'M DONE EATING FOR THE DAY" BINDS THE MEAL DOOR (2026-09-03).
       *
       * Found on the 3 Sep sweep, reproducible on 37868c1: a client who had stopped eating on
       * 188 of 189g protein asked what to eat and was handed two meals to close a 1g gap. The
       * constraint was not missed — foodDayIsClosed recognised it, readHeldConstraints reported
       * foodDayClosed: true, and chooseAction was already guarding its eat_more and protein rungs
       * on it. This one door never asked.
       *
       * The outbound floor could not cover for it: enforceOutboundTruth refuses a reply that
       * asksForFoodToday, and that returns FALSE here because the reply is a MENU with bolded
       * labels rather than an imperative to eat. So it reached the client.
       *
       * Graded through the real handler on the reply a client receives. The held constraint comes
       * from recentClientMessagesStamped, which is a RAW pool.query — the drizzle stub map cannot
       * serve it, so the fixture seeds __KAMLIFE_STUB_PGROWS. A fixture that seeds the wrong seam
       * reports foodDayClosed: false and grades nothing, which is how this nearly went unproven.
       */
      {
        const closedTurn = async (o: { kcal: number; protein: number; closed: boolean }) => {
          freshTurn();
          g.__KAMLIFE_STUB_USER = {
            ...USER, todayWater: "0", weeklyFoodBudget: "100_300", goalType: "muscle_gain",
            todayCaloriesDate: sastToday(), calorieTarget: 3000, proteinTarget: 189,
            todayCalories: o.kcal, todayProteinG: o.protein, profileNotes: "",
          };
          g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([
            [schema.mealLogs, [{
              id: "m-closed", userId: USER.id, mealLabel: "dinner", source: "voice",
              loggedAt: new Date(dayStart.getTime() + 19 * 3_600_000), corrected: false,
              kcalInt: o.kcal, proteinInt: o.protein, kcal: o.kcal, protein: o.protein, carbs: 0, fat: 0,
            }]],
            [schema.stepLogs, []], [schema.workoutLogs, []], [schema.weightLogs, []],
          ]);
          g.__KAMLIFE_STUB_WRITES = [];
          g.__KAMLIFE_STUB_PGROWS = o.closed
            ? [{ message_in: "I'm done eating for the day", created_at: new Date(Date.now() - 3_600_000) }]
            : [];
          const out = String(await handleMessage(USER.phoneNumber, "what should I eat next?").catch(() => ""));
          delete g.__KAMLIFE_STUB_PGROWS;
          return out;
        };
        const offersFood = (r: string) => /Balanced option|Light option|Pick one:|\(~\d+ kcal/i.test(r);

        // THE OBSERVED SHAPE: closed the day on a 1g gap.
        {
          const r = await closedTurn({ kcal: 2245, protein: 188, closed: true });
          if (!/done eating/i.test(r)) {
            failures.push(`The meal door did not acknowledge a closed food day — the rest of this block grades nothing: "${flat(r)}"`);
          } else if (offersFood(r)) {
            failures.push(`A client who said they are done eating was offered food anyway, to close a 1g protein gap: "${flat(r)}"`);
          }
          // The facts they logged still ship — standing down is not going quiet.
          if (!/2245/.test(r) || !/188/.test(r)) {
            failures.push(`Closing the day cost the client their own totals: "${flat(r)}"`);
          }
        }

        // A REAL GAP IS STILL NAMED, but pointed at tomorrow rather than reopening tonight.
        {
          const r = await closedTurn({ kcal: 2245, protein: 129, closed: true });
          if (offersFood(r)) {
            failures.push(`A closed day with a real 60g gap still produced a meal menu: "${flat(r)}"`);
          }
          if (!/60g short/.test(r) || !/tomorrow/i.test(r)) {
            failures.push(`A genuine 60g shortfall on a closed day was neither named nor carried to tomorrow: "${flat(r)}"`);
          }
        }

        // CONTROL — AN OPEN DAY IS UNCHANGED. Without this, "never suggest food" passes every
        // assertion above and the door goes silent on the ordinary case it exists for.
        {
          const open1g = await closedTurn({ kcal: 2245, protein: 188, closed: false });
          if (!offersFood(open1g)) {
            failures.push(`An OPEN day stopped offering meals — the fix went mute instead of obedient: "${flat(open1g)}"`);
          }
          if (/done eating/i.test(open1g)) {
            failures.push(`An open day was told it was closed — the constraint is over-firing: "${flat(open1g)}"`);
          }
          const openGap = await closedTurn({ kcal: 1500, protein: 80, closed: false });
          if (!/109g more protein/.test(openGap) || !offersFood(openGap)) {
            failures.push(`An open day with a real gap lost its protein-first recommendation: "${flat(openGap)}"`);
          }
        }
      }

      /**
       * DEFECT 2 — THE PLATE MUST BE PROPORTIONAL TO THE DAY THAT IS LEFT (2026-09-01).
       *
       * Traced before changing anything: protLeft and calLeft were both read and both printed, so
       * this was never missing evidence or the wrong claimant. The owner simply had nothing in its
       * option list big enough to answer with. A client holding 2 146 kcal of headroom and one
       * holding 420 got plates from the same 380–450 kcal band, because that band WAS the menu —
       * headroom could only ever remove an option, never size one up.
       *
       * Graded on the plates the client is actually offered, parsed out of the rendered reply. No
       * threshold is asserted and none exists in the code: the property is that the two headrooms
       * must not produce the same leading plate, which is the defect stated as a test.
       */
      {
        const plates = (r: string) => [...r.matchAll(/\(~(\d+) kcal, (\d+)g protein\)/g)]
          .map(m => ({ kcal: Number(m[1]), protein: Number(m[2]) }));

        const roomy = await mealTurn({ protLeft: 129, calLeft: 2146, budget: "100_300" });
        const tight = await mealTurn({ protLeft: 129, calLeft: 420, budget: "100_300" });
        const roomyPlates = plates(roomy), tightPlates = plates(tight);
        if (roomyPlates.length === 0 || tightPlates.length === 0) {
          failures.push(`The plate-ask stopped offering plates at all — the rest of this block grades nothing: "${flat(roomy)}"`);
        } else {
          // THE DEFECT ITSELF: a whole day of headroom answered with the same plate as 420 kcal.
          if (roomyPlates[0].kcal === tightPlates[0].kcal && roomyPlates[0].protein === tightPlates[0].protein) {
            failures.push(`2 146 kcal of headroom and 420 kcal produced the same leading plate (${roomyPlates[0].kcal} kcal, ${roomyPlates[0].protein}g) — the owner still cannot answer in proportion to the evidence it holds: "${flat(roomy)}"`);
          }
          if (roomyPlates[0].protein <= tightPlates[0].protein) {
            failures.push(`With most of the day's calories unspent the client was led to a plate no stronger than the one offered on 420 kcal: "${flat(roomy)}"`);
          }
          // AND THE MENU MUST CONTAIN A REAL MEAL, which the two comparisons above do NOT prove:
          // the old 380–450 kcal menu satisfies both, because filtering alone already makes the
          // two headrooms differ. 600 kcal is this suite's statement of what counts as a plate for
          // somebody who has eaten almost nothing all day — an expectation of the product, not a
          // rule in the code, and the number to revisit if the menu is ever re-authored. Without
          // it, deleting every fuller plate leaves this block green, which is how the first
          // version of this test would have shipped a defect it claimed to guard.
          if (roomyPlates[0].kcal < 600) {
            failures.push(`With 2 146 kcal unspent the biggest thing on offer was ${roomyPlates[0].kcal} kcal — the menu still has no plate you could call a meal: "${flat(roomy)}"`);
          }
          // HEADROOM STILL CONSTRAINS. A fuller plate must never be offered to somebody who has no
          // room for it — the same defect in the other direction, and the reason the menu could
          // not simply be made bigger.
          const unaffordable = tightPlates.filter(p => p.kcal > 420);
          if (unaffordable.length > 0) {
            failures.push(`A plate of ${unaffordable[0].kcal} kcal was offered to a client with 420 kcal left: "${flat(tight)}"`);
          }
        }

        // AND THE ORDINARY DAY IS NOT OVER-SERVED. 22g short with the same big headroom: the
        // fuller plates exist and must not be what the client is led to. "Biggest protein first"
        // was safe while every option was small and is exactly what goes wrong once one is not.
        const ordinary = await mealTurn({ protLeft: 22, calLeft: 2146, budget: "100_300" });
        const ordinaryPlates = plates(ordinary);
        if (ordinaryPlates.length > 1) {
          const largest = Math.max(...ordinaryPlates.map(p => p.kcal));
          if (ordinaryPlates[0].kcal === largest) {
            failures.push(`A client 22g short was led to the largest plate on the menu (${largest} kcal) — enough is enough, and over-serving is how a fat-loss client is talked out of their deficit: "${flat(ordinary)}"`);
          }
          if (ordinaryPlates[0].protein < 22) {
            failures.push(`A client 22g short was led to a plate that does not even cover it: "${flat(ordinary)}"`);
          }
        }
      }
    }
  }

  /**
   * STAGE 3 OF THE CONTRACT — ONE WRITE OWNER, AND EVERY CONVERSATIONAL DOOR GOES THROUGH IT.
   *
   * logStepsForUser holds one rule that no caller can hold for itself: ONE ROW PER SAST DAY, keep
   * the higher count unless it is an explicit correction. The cardio door did not go through it —
   * it ran a bare INSERT with no day-window read — so a client whose day already held 8 000 steps
   * and sent "ran 5km" ended the turn with TWO rows, 8 000 and 5 500.
   *
   * NO CUSTOMER-VISIBLE DIVERGENCE WAS DEMONSTRATED FOR THAT, and this test does not pretend one
   * was: the direct step query, the streak, the weekly average and a later same-day log all
   * returned identical answers with one row and with two. What is proven is the contract breach,
   * plus a real latent risk — both day-row reads are `.limit(1)` with NO ORDER BY, so once a
   * second row exists, which count the client is told depends on which row Postgres returns. The
   * cardio door is what creates that precondition. The harness cannot exercise the ambiguity
   * because the stub always returns the first seeded row, so it is named here, not asserted.
   *
   * The conversion (km × 1100 running, × 1300 walking) is untouched — only the write door moved.
   */
  {
    const cardioRows = async (existing: number | null) => {
      freshTurn();
      const { handleWorkoutCommands } = await import("../server/handlers/workout");
      const seeded = existing === null ? []
        : [{ id: "s1", userId: USER.id, steps: existing, loggedAt: new Date(dayStart.getTime() + 3_600_000) }];
      g.__KAMLIFE_STUB_USER = { ...USER };
      g.__KAMLIFE_STUB_ROWS = new Map([
        [schema.stepLogs, seeded], [schema.workoutLogs, []], [schema.mealLogs, []], [schema.weightLogs, []],
      ]);
      g.__KAMLIFE_STUB_WRITES = []; g.__KAMLIFE_STUB_UPDATES = [];
      const reply = String(await handleWorkoutCommands(
        { phone: USER.phoneNumber, message: "ran 5km", m: "ran 5km", user: { ...USER } } as any,
      ).catch(() => ""));
      const ins = (g.__KAMLIFE_STUB_WRITES || []).filter((w: any) => w.table === schema.stepLogs);
      const upd = (g.__KAMLIFE_STUB_UPDATES || []).filter((w: any) => w.table === schema.stepLogs);
      delete g.__KAMLIFE_STUB_UPDATES;
      return {
        reply,
        rows: (existing === null ? 0 : 1) + ins.length,
        held: ins.length ? Number(ins[0].values?.steps)
          : upd.length ? Number(upd[upd.length - 1].set?.steps) : existing,
      };
    };

    // THE CONTRACT: one row per day, whatever the day already held.
    for (const [existing, expectRows, expectHeld, why] of [
      [null, 1, 5500, "an empty day takes the derived count"],
      [8000, 1, 8000, "a higher existing count is kept, and nothing is written"],
      [3000, 1, 5500, "a lower existing count is raised, still in one row"],
    ] as [number | null, number, number, string][]) {
      const r = await cardioRows(existing);
      if (r.rows !== expectRows) {
        failures.push(`Cardio broke one-row-per-day (${why}): day held ${existing}, ended with ${r.rows} rows`);
      }
      if (r.held !== expectHeld) {
        failures.push(`Cardio wrote the wrong count (${why}): day held ${existing}, now ${r.held}, expected ${expectHeld}`);
      }
      // EXISTING CUSTOMER BEHAVIOUR IS PRESERVED. The cardio reply never quoted steps and must not
      // start to — this cut moves a write, it does not change what the client reads.
      if (!/5\s*km/i.test(r.reply) || !/kcal/i.test(r.reply)) {
        failures.push(`Cardio reply changed: "${r.reply.split("\n")[0]}"`);
      }
    }
  }

  /**
   * LAW 4 — A DURABLE WRITE IS FOLLOWED BY ONE NEXT MOVE (2026-08-26, issue #63).
   *
   * The contract's last two stages are "one action -> one response", and the product was stopping
   * at the response.
   *
   * NOTHING NEW DECIDES ANYTHING. canonicalDecision is the existing reactive decision owner —
   * authoritative state -> chooseAction -> underPolicy — already used by both model paths and
   * built for exactly this case: it sets atKeyboard because "they are typing to us right now".
   * It was simply never reachable from a deterministic rail, the same bypass shape as the step
   * write in #74. The cut asks it. underPolicy is also the brake: a client with fewer than three
   * days logged yields an empty todo and therefore no move, which is the correct silence — we do
   * not prescribe to a client we cannot yet read.
   *
   * Measured on main, for a client mid-programme:
   *
   *     "walked 8000 steps today"  ->  "8 000 steps — nice one. 👌"
   *     "84kg"                     ->  "84kg — noted. 👌"
   *
   * Receipts, not coaching — what reply-hygiene.ts already calls the calculator behaviour, and
   * what chat-log.ts had been counting as [REPLY_THIN] while nothing acted on it.
   *
   * ONE is the operative word, so this is graded in BOTH directions: a bare acknowledgement must
   * gain a move, and a reply that already owns the client's next action — a card, buttons, or a
   * working question — must gain nothing. A rule that only checks the first half is satisfied by
   * a coach who talks over his own question, which is what the first cut of this did.
   *
   * AND THE MOVE MUST READ THE WRITE. The decision runs after the row lands, so a client who has
   * just logged 8 000 steps is not told to go for a walk. That is not a detail — it is the #71
   * defect, and the negative control below proves the assertion is sensitive to it.
   *
   * WATER JOINED LAST, AND IT IS THE REASON THE OTHER FOUR WERE NOT ENOUGH. Water persists by
   * UPDATEing users.todayWater rather than inserting a row, and it recorded nothing on the turn —
   * so durableDomains(), the turn's own record of what it wrote, could not see it. It was the one
   * tracked fact invisible to that record, and a water log therefore ended in a bare
   * "2L of water — good. 👌" while the other four earned a move. The fix is not special-casing
   * water in the coaching turn; it is water telling the truth about itself, after which the
   * existing mechanism covers it with no change of its own.
   *
   * That made `committed` able to say "water", which changes when a turn CONTINUES to the coach —
   * alsoAsksCoach is durableDomains().length > 0 — and when the educational mouths stand down.
   * Both move in the intended direction (write, then coach; do not lecture over a log), and both
   * are behaviour, so they are graded here rather than assumed.
   *
   * All five tracked facts now travel one path: write -> state -> decision -> response.
   */
  const EVIDENCED_DAYS = 5;   // underPolicy prescribes only for a client it can actually read

  /**
   * THE FIXTURE IS SPLIT BY PURPOSE, BECAUSE ONE CLIENT CANNOT SERVE BOTH (2026-08-27).
   *
   * The ladder runs come_back -> rest -> weigh -> eat_more -> protein -> walk -> train -> hold,
   * and the two things graded below need OPPOSITE things from it:
   *
   *   "a durable write earns a move" needs a rung that fires whatever the date is.
   *   the ordering control        needs the move to change with STEPS, so every rung above
   *                               `walk` has to stay quiet — which means protein must be met.
   *
   * Below `walk` there is only `train`, and canonicalDecision sets sessionsTarget to 0 on a rest
   * day (SCHEDULE_MAP is day-of-week, and no setting trains all seven days). So with protein at
   * target the ladder reaches `hold` on a rest day and there is no move at all.
   *
   * THAT IS EXACTLY WHAT HAPPENED. #77 set protein to 200/180 to make the ordering property
   * observable, which was right for the control and quietly made the four "durable write earns a
   * move" assertions depend on the CALENDAR. They passed CI on a Wednesday and went red on the
   * Thursday with no code change — the worst direction for a gate to fail in, because it was
   * green when it was adjudicated.
   *
   * So: protein is SHORT by default, which lands the ladder on the protein rung every day of the
   * week; the ordering control alone asks for `proteinAtTarget`, and it is the only case that
   * depends on which day it runs.
   */
  async function coachingTurn(message: string, opts?: { seeWrites?: boolean; proteinAtTarget?: boolean; weeksOnProgramme?: number; stepsAlready?: number }) {
    // BOTH THE COLUMN NAME AND THE SELECT ALIAS. The stub returns raw rows and does not apply
    // drizzle projections, so `db.select({ kcal: mealLogs.kcalInt })` reads undefined and the
    // client silently looked like they had logged NOTHING today — which quietly moved the ladder
    // onto its "log something" rung. Seeding only kcalInt is how that hid.
    const protein = opts?.proteinAtTarget ? 200 : 60;
    const meals = Array.from({ length: EVIDENCED_DAYS }, (_, i) => ({
      id: `m${i}`, userId: USER.id, items: ["chicken"], mealLabel: "lunch",
      loggedAt: new Date(dayStart.getTime() - i * 86_400_000 + 3_600_000), corrected: false,
      kcalInt: 2000, proteinInt: protein, kcal: 2000, protein, carbs: 0, fat: 0,
    }));
    freshTurn();
    g.__KAMLIFE_STUB_USER = {
      ...USER, todayWater: "0",
      ...(opts?.weeksOnProgramme === undefined ? {} : { programmeWeek: opts.weeksOnProgramme + 1 }),
    };
    // A step row ALREADY on today, for the turns that grade a raise over an existing count.
    const steps = opts?.stepsAlready === undefined ? []
      : [{ id: "s1", userId: USER.id, steps: opts.stepsAlready, loggedAt: new Date(dayStart.getTime() + 3_600_000) }];
    g.__KAMLIFE_STUB_ROWS = new Map([
      [schema.mealLogs, meals], [schema.stepLogs, steps], [schema.workoutLogs, []], [schema.weightLogs, []],
    ]);
    // The decision reads state that INCLUDES this turn's write — the production ordering.
    if (opts?.seeWrites !== false) g.__KAMLIFE_STUB_REFLECT_WRITES = 1;
    g.__KAMLIFE_STUB_WRITES = [];
    const reply = String(await handleMessage(USER.phoneNumber, message).catch(() => ""));
    delete g.__KAMLIFE_STUB_REFLECT_WRITES;
    return reply;
  }
  /** A move is a separate closing block that is not a question — what withNextMove appends. */
  const closingMove = (reply: string) => {
    const blocks = reply.trim().split(/\n\s*\n/);
    const last = (blocks[blocks.length - 1] || "").trim();
    return blocks.length > 1 && !last.includes("?") && !/\[(?:BUTTONS|MEDIA)/i.test(last) ? last : "";
  };

  // A bare receipt must gain exactly one move — on EVERY tracked fact that writes durably.
  // Water is listed explicitly: it was the fact this law could not reach, and a regression there
  // would look exactly like the bare receipt this whole cut exists to end.
  for (const [surface, message] of [
    ["water", "2 litres of water"],
    ["water", "drank 3 litres today"],
    ["weight", "84kg"],
  ] as [string, string][]) {
    const reply = await coachingTurn(message);
    if (!closingMove(reply)) {
      failures.push(`A durable ${surface} write ended with a receipt and no next move: "${reply.replace(/\n/g, " ⏎ ")}"`);
    }
  }

  {
    const reply = await coachingTurn("walked 8000 steps today");
    const move = closingMove(reply);
    if (!move) failures.push(`A durable write ended with a receipt and no next move: "${reply.replace(/\n/g, " ⏎ ")}"`);
    // …and the move must have read the write. Telling a client who just logged 8 000 steps to
    // walk is the defect this ordering exists to prevent.
    if (/\bwalk\b/i.test(move)) failures.push(`The move ignored the row this turn wrote — 8 000 steps logged, and the coach said: "${move}"`);
  }

  /**
   * A RAISE IS A DURABLE WRITE (2026-08-27, traced through handleMessage on main 5e38582).
   *
   * Steps are one row per SAST day that a client tops up through the day — "5k so far" at noon,
   * "9k" at night. logStepsForUser recorded a mutation on the INSERT and not on the UPDATE, so
   * the SAME client sending the SAME message on the SAME day got a coach or a receipt depending
   * only on whether they had logged earlier:
   *
   *     no row yet   -> "8 500 steps — nice one. 👌 ⏎⏎ Stand on a scale this morning, before you eat."
   *     3 000 stored -> "8 500 steps — nice one. 👌"
   *
   * The day moved from 3 000 to 8 500 in both. closeCoachingTurn asked durableDomains what this
   * turn changed, was told nothing, and stood down — Law 4 exempting the commonest shape of step
   * report there is. Graded as a PAIR: the contrast between the two is the evidence, and grading
   * the raise alone would pass on a build where neither gets a move.
   */
  {
    const first = await coachingTurn("walked 8500 steps today");
    const raise = await coachingTurn("walked 8500 steps today", { stepsAlready: 3000 });
    if (!closingMove(first)) {
      failures.push(`A first step report of the day ended with a receipt and no next move: "${first.replace(/\n/g, " ⏎ ")}"`);
    }
    if (!closingMove(raise)) {
      failures.push(`A step RAISE (3 000 -> 8 500) ended with a receipt and no next move, while the same message on an empty day earned one: "${raise.replace(/\n/g, " ⏎ ")}"`);
    }
  }

  /**
   * AND THE CONTROL: a report the day does NOT take is not a durable write.
   *
   * The client holds 9 000 and sends 3 000 — an earlier reading arriving late. logStepsForUser
   * keeps the 9 000 and answers with it (Law 3, proven above). Nothing changed, so nothing is
   * owed. Recording the mutation unconditionally instead of inside the raise branch would satisfy
   * every assertion above and manufacture a coaching move out of a read.
   */
  {
    const reply = await coachingTurn("walked 3000 steps today", { stepsAlready: 9000 });
    const move = closingMove(reply);
    if (move) {
      failures.push(`A report the day did not take produced a next move anyway — nothing was written: "${move}"`);
    }
    if (!numbersIn(reply).has(9000)) {
      failures.push(`A superseded step report was not answered from the ledger — the day holds 9 000: "${reply.replace(/\n/g, " ⏎ ")}"`);
    }
  }

  // NEGATIVE CONTROL FOR THE ORDERING. Deny the decision sight of the write and the move must
  // CHANGE — that is the property, and it is what proves the assertion above grades ordering
  // rather than mere presence.
  //
  // It asserted the blind move contained "walk" and that was too specific: which rung the ladder
  // reaches depends on state this suite does not fully pin (the pattern cache carries across
  // turns in-process), so simply adding cases ABOVE this one flipped the blind move to the log
  // rung and the control started failing for a reason that had nothing to do with ordering. A
  // control that breaks when unrelated tests are added is not measuring what it claims.
  // THE ORDERING CONTROL CAN ONLY RUN WHEN THE LADDER IS STEP-SENSITIVE, and that is a real
  // limitation, stated rather than papered over.
  //
  // Steps are the only fact whose rung responds to a step write, and `walk` is gated on
  // `hour >= 12`; the rung below it, `train`, is gated on the day of the week. The weigh-in was
  // tried as an ungated alternative and does not work: the row reflects into the stub but
  // truth.weight.known stays false, because getProgressTruth reads it through a select alias the
  // stub does not apply — the same gap that made the meal seed read as zero.
  //
  // So before noon this control cannot demonstrate anything, and it says so on the run instead of
  // passing quietly. It is NOT allowed to fail in that case: a gate that goes red every morning
  // for a reason unrelated to the code is exactly the untrustworthy baseline this cut exists to
  // repair. What it must never do is report success it did not earn.
  {
    const { sastHour } = await import("../server/sast");
    if (sastHour() < 12) {
      console.log(`⚠ ORDERING CONTROL DID NOT RUN — it is ${sastHour()}:00 SAST and the walk rung`);
      console.log(`  is gated on hour >= 12, so a decision blind to the write and one that can see`);
      console.log(`  it produce the same move. The Law 4 assertions above ran; this specific proof`);
      console.log(`  that they are not vacuous did not. Re-run after 12:00 SAST to exercise it.`);
    } else {
      const sighted = closingMove(await coachingTurn("walked 8000 steps today", { proteinAtTarget: true }));
      const blind = closingMove(await coachingTurn("walked 8000 steps today", { seeWrites: false, proteinAtTarget: true }));
      if (!blind) {
        failures.push(`The ordering control is vacuous: a decision blind to the write produced no move at all`);
      } else if (sighted === blind) {
        failures.push(`The ordering control did not reproduce the defect: a decision blind to the write produced the SAME move ("${blind}")`);
      }
    }
  }

  // A reply that already owns the next action must gain nothing — three ways of owning it.
  for (const [message, owner] of [
    ["workout done", "buttons"],
    ["I trained chest today", "a working question"],
    ["I had eggs and toast", "a card"],
  ] as [string, string][]) {
    const reply = await coachingTurn(message);
    const move = closingMove(reply);
    if (move) failures.push(`A second next move was appended over ${owner}: "${message}" ended with "${move}"`);
  }

  // A turn that wrote nothing is not a coaching moment. "what are my totals today?" is chosen
  // deliberately: it RETURNS THROUGH A WIRED EXIT (early-commands) while writing nothing, so it
  // actually exercises the durable-write guard. A message that never reaches one of the six exits
  // would pass this whether the guard existed or not, which is no test at all.
  for (const quiet of ["what are my totals today?", "how many steps have I done?"]) {
    const move = closingMove(await coachingTurn(quiet));
    if (move) failures.push(`A turn that wrote nothing was given a coaching move: "${quiet}" ended with "${move}"`);
  }

  /**
   * LAW 5 — A QUESTION IN ONE CLAUSE DOES NOT ERASE A REPORT IN ANOTHER (2026-08-26, issue #63).
   *
   * Real clients do not send one fact per bubble. "I walked 8,000 steps, what should I eat?" is
   * the ordinary shape, and the system already UNDERSTOOD the step count — it then threw it away
   * because a whole-message question guard read the second clause. Measured on main, five of ten
   * mixed turns lost the fact. Food and workout had each learned this rule separately; steps,
   * water and weight never had, and each lost it a different way:
   *
   *     steps   detectStepLog extracted 8 000, then isQuestionForm matched "should i" anywhere
   *     water   waterIsQuestion begins with m.includes("?")
   *     weight  looksLikeWeightReport is anchored ^...$, so a clause was never examined
   *
   * THE RULE IS NOT "DOES THE MESSAGE MENTION THE FACT", and that is the whole difficulty. That
   * version was tried and measured, and it resurrects every false write #73 closed:
   * journeyMustKeepFacts reports logStepsEvenIfClassifiedQuestion === true for "Is 8000 steps
   * enough?" and for "I need to do 10000 steps". Naming a fact is what a question does too.
   *
   * So: some clause REPORTS the fact, and that clause is itself neither a question nor an
   * intention — utils.reportedInSomeClause, composing the two floors that already own those
   * questions. No domain recogniser was added; each fact keeps the one it had.
   *
   * GRADED BOTH WAYS IN THE SAME BREATH. Every widening here is one regex away from re-opening
   * Law 2, so the MUST_NOT_WRITE list above is this law's negative control as much as its own —
   * and the two run against the same pipeline. A fix that preserves the fact by loosening the
   * floors fails there, loudly, on "I need to do 10000 steps".
   */
  const MIXED: [string, string][] = [
    ["steps", "walked 8000 steps. what should I eat?"],
    ["water", "2 litres of water. what should I eat?"],
    ["weight", "84kg. what should I eat?"],
    ["workout", "workout done. what should I eat?"],
    ["food", "I had eggs. what should I eat?"],
    ["steps", "walked 8000 steps. how am I doing?"],
    ["water", "2 litres of water. how am I doing?"],
    ["weight", "84kg. how am I doing?"],
    ["workout", "workout done. how am I doing?"],
    ["food", "I had eggs. how am I doing?"],
    ["water", "drank 1 litre. what is a portion of rice?"],
    ["steps", "10k steps done. is that enough?"],
  ];
  for (const [surface, message] of MIXED) {
    const wrote = await wroteFor(message);
    if (!wrote.has(surface)) {
      failures.push(`A question in one clause erased a ${surface} report in another: "${message}" wrote ${[...wrote].join(", ") || "nothing"}`);
    }
  }

  /**
   * TRAINING HISTORY — PHASE WEEK IS NOT FIRST-EVER WEEK (2026-09-01, issue #113).
   *
   * The customer-visible pair was real and came from two deterministic producers:
   *
   *   `workout`      -> programme.renderSession -> phase Week 1 + lifetime Session 8 overall
   *   `workout done` -> workout completion      -> `first full training week`
   *
   * The header is correct because it labels the phase-relative and lifetime clocks. The second
   * turn used only the phase clock, so it converted a new Phase 2 / Week 1 into a false
   * first-ever history claim. These are production turns, not a unit test of a wording helper:
   * remove the lifetime gate from the completion handler and the veteran control below fails;
   * remove the badge entirely and the actual beginner control fails.
   */
  {
    const FRIDAY_SAST = Date.parse("2026-09-04T10:00:00Z"); // Friday, the third 3-day-programme slot
    const RealDate = Date;
    class FridayDate extends RealDate {
      constructor(...args: ConstructorParameters<DateConstructor>) {
        super(...(args.length ? args : [FRIDAY_SAST]) as any);
      }
      static now() { return FRIDAY_SAST; }
    }
    const completeOrView = async (message: string, userPatch: Record<string, unknown>) => {
      // The completion branch asks both the temporal owner and the calendar-slot owner what
      // "today" means. Freeze the Date constructor as well as Date.now so those readers stay on
      // the same SAST Friday; replacing only Date.now made `done today` ambiguous in the test,
      // which is a fixture inconsistency rather than a customer path.
      (globalThis as any).Date = FridayDate;
      try {
        freshTurn();
        g.__KAMLIFE_STUB_USER = {
          ...USER,
          programmeWeek: 1,
          programmeDayInWeek: 3,
          trainingDaysPerWeek: 3,
          lastWorkoutDate: null,
          awaitingInputType: null,
          ...userPatch,
        };
        g.__KAMLIFE_STUB_ROWS = new Map([
          [schema.mealLogs, []], [schema.stepLogs, []], [schema.workoutLogs, []], [schema.weightLogs, []],
        ]);
        g.__KAMLIFE_STUB_WRITES = [];
        if (message === "workout") {
          return String(await handleMessage(USER.phoneNumber, message).catch(() => ""));
        }
        // The route above is the customer's workout-view path. Completion is deliberately
        // exercised at its production-capable owner: the top-level route has a separate generic
        // fall-through for terse "done today" before it reaches workout handling. Do not replace
        // this with a predicate test — this calls the writer that builds the customer reply.
        const { handleWorkoutCommands } = await import("../server/handlers/workout");
        const { inTurn } = await import("../server/handlers/chat-log");
        return await inTurn("tracking_test", message, async () => String(await handleWorkoutCommands({
          phone: USER.phoneNumber,
          message,
          m: message,
          user: g.__KAMLIFE_STUB_USER,
        })));
      } finally {
        (globalThis as any).Date = RealDate;
      }
    };

    const veteran = {
      programmePhase: 2,
      programmeStartDate: new Date(FRIDAY_SAST - 100 * 86_400_000),
      // Any lifetime total beyond the first planned cycle is the control. Eight avoids the
      // unrelated 10/25/50/100 milestone side effects while proving this is not a Session-25
      // exception.
      totalWorkoutsCompleted: 7,
    };
    const veteranSession = await completeOrView("workout", veteran);
    if (!/Week 1 — Session 8 overall/i.test(veteranSession)) {
      failures.push(`The canonical workout view lost its phase/lifetime session label: "${veteranSession.split("\n")[0]}"`);
    }

    // `done today` is the terse, explicit-day command owned by handleWorkoutCommands'
    // completion writer. "workout done" is deliberately claimed earlier by the prose-session
    // reporter, while bare "done" has no temporal fact and is allowed to reach the coach.
    // Using either would test a different path and leave this badge producer unexercised.
    const veteranCompletion = await completeOrView("done today", veteran);
    if (/first full training week/i.test(veteranCompletion)) {
      failures.push(`An experienced Phase-Week-1 client was called a first full training week: "${veteranCompletion.split("\n")[0]}"`);
    }

    const beginnerCompletion = await completeOrView("done today", {
      programmePhase: 1,
      programmeStartDate: new Date(FRIDAY_SAST - 5 * 86_400_000),
      totalWorkoutsCompleted: 2,
    });
    if (!/first full training week/i.test(beginnerCompletion)) {
      failures.push(`A genuine beginner's first full training week lost its completion recognition: "${beginnerCompletion.split("\n")[0]}"`);
    }
  }

  const total = MUST_NOT_WRITE.length + MUST_WRITE.length + 2 + 10 + MIXED.length + 3;
  if (failures.length > 0) {
    for (const f of failures) console.log(`✗ ${f}`);
    console.log(`\n✗ tracking contract: ${failures.length}/${total} violations`);
    process.exit(1);
  }
  if (knownFoodClaim.length > 0) {
    console.log(`⚠ KNOWN, NOT FIXED HERE — the food door logs a meal on ${knownFoodClaim.length} water INTENTION(s):`);
    for (const m of knownFoodClaim) console.log(`    "${m}" -> a meal called "Water" is written`);
    console.log(`  Unchanged from main. Water correctly refuses these; the food door's planning`);
    console.log(`  vocabulary has the same gap, and treats water as a food at all. Its own cut.`);
  }
  console.log(`✓ tracking contract: ${MUST_NOT_WRITE.length} questions wrote nothing, ${MUST_WRITE.length} reports reached their writer, the answer quoted the ledger, and a durable write ended in one next move, and ${MIXED.length} period-separated mixed turns kept their fact (the COMMA form is not covered — see LAW 5)`);
  process.exit(0);
})();

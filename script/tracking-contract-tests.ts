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
      const mealTurn = async (o: { protLeft: number; calLeft: number; budget: string }) => {
        freshTurn();
        g.__KAMLIFE_STUB_USER = {
          ...USER, todayWater: "0", weeklyFoodBudget: o.budget,
          todayCaloriesDate: sastToday(),
          calorieTarget: 2400, todayCalories: 2400 - o.calLeft,
          proteinTarget: 150, todayProteinG: 150 - o.protLeft,
        };
        g.__KAMLIFE_STUB_ROWS = new Map([
          [schema.mealLogs, []], [schema.stepLogs, []], [schema.workoutLogs, []], [schema.weightLogs, []],
        ]);
        g.__KAMLIFE_STUB_WRITES = [];
        return String(await handleMessage(USER.phoneNumber, "what should I eat next?").catch(() => ""));
      };
      const flat = (r: string) => r.replace(/\n/g, " ⏎ ");

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

  const total = MUST_NOT_WRITE.length + MUST_WRITE.length + 2 + 10 + MIXED.length;
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

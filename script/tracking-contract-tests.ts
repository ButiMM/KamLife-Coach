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
  async function coachingTurn(message: string, opts?: { seeWrites?: boolean }) {
    const meals = Array.from({ length: EVIDENCED_DAYS }, (_, i) => ({
      id: `m${i}`, userId: USER.id, kcalInt: 1800, proteinInt: 70, items: ["chicken"],
      mealLabel: "lunch", loggedAt: new Date(dayStart.getTime() - i * 86_400_000 + 3_600_000), corrected: false,
    }));
    g.__KAMLIFE_STUB_USER = { ...USER, todayWater: "0" };
    g.__KAMLIFE_STUB_ROWS = new Map([
      [schema.mealLogs, meals], [schema.stepLogs, []], [schema.workoutLogs, []], [schema.weightLogs, []],
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

  // NEGATIVE CONTROL FOR THE ORDERING. Deny the decision sight of the write and the same turn
  // must produce the wrong move — proving the assertion above grades ordering, not just presence.
  {
    const blind = closingMove(await coachingTurn("walked 8000 steps today", { seeWrites: false }));
    if (blind && !/\bwalk\b/i.test(blind)) {
      failures.push(`The ordering control did not reproduce the defect: a decision blind to the write still said "${blind}", so the check above proves nothing`);
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
  console.log(`✓ tracking contract: ${MUST_NOT_WRITE.length} questions wrote nothing, ${MUST_WRITE.length} reports reached their writer, the answer quoted the ledger, and a durable write ended in one next move, and ${MIXED.length} mixed turns kept their fact`);
  process.exit(0);
})();

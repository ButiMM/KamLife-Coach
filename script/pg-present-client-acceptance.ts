/**
 * REAL-POSTGRESQL ACCEPTANCE — the present client is coached.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS PROVEN BROKEN ON d92c0ce (main), THROUGH THE LIVE FRONT DOOR, BEFORE ANY EDIT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * One client: four quiet days, logging nothing since, at the keyboard at 09:00, three sessions a
 * week on the plan and NONE done. Every measurement below is the final post-transport body.
 *
 *   "what should I do today?"  ->  "*Log one meal today. Any meal.*"
 *   "I'm lost"                 ->  "*Tell me what you ate today — one line is enough.*"
 *   "I'm struggling"           ->  "Heard you on how you're feeling. Showing up still counts.
 *                                   Next move stays small."      (and nothing else, ever)
 *
 * ONE QUESTION, THREE ANSWERS, NONE OF THEM COACHING. Three separate disagreements produced that:
 *
 *  1. THE TWO CALLERS OF THE SAME QUESTION DISAGREED. misc-commands.ts called
 *     `oneActionCommand(user)` bare; early-commands.ts called it with `atKeyboard: true`. So the
 *     absence rung spoke on one path and not the other, for one client, in one minute. And
 *     `asksAboutToday` — which live.ts computes and passes — was set by NEITHER, so the handler
 *     whose entire job is "what should I do today?" was the one that never told the decision it
 *     had been asked. Gate 3's escape and the weigh rung's clock rule both read that flag.
 *
 *  2. A TRAINING MOVE WAS GRADED ON THE FOOD LEDGER. `evidenceFromKind` exempted `rest` and
 *     `come_back` as directly observed, and let `train` fall through to food-and-weight
 *     sufficiency. Four quiet days makes `foodSufficient` false BY ARITHMETIC — at most three of
 *     the last seven days can hold a row — so "Get today's session done." was downgraded into
 *     "Tell me what you ate today". The one move the coach could stand behind, thrown away for
 *     want of evidence about something else. A workout_logs row exists only because a session
 *     happened; a missing MEAL row only means they did not say.
 *
 *  3. A FEELING REACHED NO COACH AT ALL. `closeCoachingTurn` opened with `wrote.length === 0`,
 *     so a turn committing no DURABLE fact was acknowledged and dropped. "I'm struggling" is
 *     exactly that turn: the most explicit bid for coaching the product receives, answered with
 *     sympathy and no next action.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS GRADED, AND WHERE IT IS READ FROM
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Bodies come from shadow_replies — after sendFinal, prepareOutbound and the delivery owner.
 * ENGINE_LIVE is ON, because that is production and because the canonical close only exists there.
 * The clock is frozen per case: every rung in this ladder reads the hour.
 *
 * ISOLATION IS PART OF THE PROOF, NOT HOUSEKEEPING. `seed()` clears workout_logs, daily_constraints
 * and `awaiting_input_type` as well as the obvious tables. Each of those carried a case into the
 * next one while this file was being written: an open training loop left by an earlier answer
 * silenced the training rung and turned the move into "Nothing new today", and a durable food
 * closure from the previous case made an unrelated client read as closed. Both looked exactly like
 * product defects. This is the C13 lesson, paid for twice more.
 *
 * THE MOUTH IS STUBBED WITH A LINE THAT CLAIMS NOTHING. An earlier stub mentioned food, and the
 * response gate correctly rewrote it into "I don't have a meal logged for you today. What did you
 * eat?" — a fixture manufacturing a defect the product does not have. §0 proves the stub trips no
 * detector here before any case is graded.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-present-client-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "0";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "on";
process.env.PROACTIVE_PAUSED = "true";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

/**
 * The mouth's answer. Deliberately contains NONE of the graded vocabulary: no "week", no "been
 * about", no "say hi", no "left them", no "tell me what you ate", no "coach a day". §0 asserts
 * that against every detector before a single case is graded — an acceptance whose claims the
 * fixture can satisfy is not an acceptance (the lesson of C12 blocker 2).
 */
const COACH_ANSWER = "Okay, noted on that.";
const CLASSIFY = `{"intent":"OTHER","confidence":0.85,"canonical":""}`;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  const body = typeof init?.body === "string" ? init.body : "";
  if (url.includes("api.openai.com") && url.includes("/embeddings")) {
    return new Response(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: Array(1536).fill(0) }], model: "text-embedding-3-small", usage: { prompt_tokens: 1, total_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("api.openai.com")) {
    const isClassifier = body.includes("message-understanding brain");
    return new Response(JSON.stringify({
      id: "chatcmpl-c14", object: "chat.completion", created: 1, model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: isClassifier ? CLASSIFY : COACH_ANSWER }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { processTextAsync } = await import("../server/routes/whatsapp");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");
const { _resetInteractionCorrelation } = await import("../server/handlers/chat-log");
const { chooseAction, dayStateFrom, decideProactive, formatOneAction } = await import("../server/one-action");
const { NO_CONSTRAINTS } = await import("../server/food-swaps");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

// ── THE FROZEN CLOCK ─────────────────────────────────────────────────────────────────────────
// Both Date.now() and `new Date()` move together: the ladder reads the hour from one and the SAST
// day keys come from the other, so freezing half of it grades whichever hour CI happened to start
// in. Every number this file asserts on is a count of days.
const RealDate = Date;
const SAST_DAY = [2026, 8, 18] as const;                 // 18 September 2026
function freezeSast(hour: number): () => void {
  const fixed = RealDate.UTC(SAST_DAY[0], SAST_DAY[1], SAST_DAY[2], hour - 2, 30, 0);
  class FrozenDate extends RealDate {
    constructor(...args: any[]) { super(...(args.length === 0 ? [fixed] : args) as [any]); }
    static now() { return fixed; }
  }
  (globalThis as any).Date = FrozenDate;
  return () => { (globalThis as any).Date = RealDate; };
}

const phone = "whatsapp:+27820000981";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Thandi Gap", onboardingState: "COMPLETE", popiConsent: true,
  popiConsentAt: new RealDate(), subscriptionStatus: "active", goalType: "fat_loss",
  currentWeight: "88", startWeight: "92", targetWeight: "80", heightCm: 165, age: 31,
  gender: "female", trainingMode: "gym", proteinTarget: 130, calorieTarget: 1900,
  dailyCalorieTarget: 1900, dailyStepTarget: 8000, stepsTarget: 8000,
} as any).returning();

type Meal = { raw_message: string | null; logged_at: Date; kcal_int: number | null };
const meals = async (): Promise<Meal[]> => (await pool.query<Meal>(
  `SELECT raw_message, logged_at, kcal_int FROM meal_logs WHERE user_id = $1 ORDER BY logged_at`,
  [user.id])).rows;
const wire = async (): Promise<string[]> => (await pool.query<{ body: string }>(
  "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body);

/**
 * A CLIENT WITH A HISTORY, PLANTED DIRECTLY. Meal rows land at 13:00 SAST on the day offsets
 * given, the weigh-in at 07:00, and `created_at` sets the tenure the never-logged ceiling is read
 * from. Every case starts from a wiped conversation: a token left standing between cases (an
 * armed retro day, a held constraint, an awaited input type) answers the NEXT case's turn instead,
 * which is how C13 first produced a false green.
 */
async function seed(hour: number, opts: {
  mealDaysAgo?: number[]; weighDaysAgo?: number | null; createdDaysAgo?: number; activeDaysAgo?: number | null;
}) {
  for (const t of ["meal_logs", "chat_history", "turn_ledger"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [user.id]);
  }
  await pool.query("DELETE FROM weight_logs WHERE user_id = $1", [user.id]);
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  await pool.query("UPDATE users SET profile_notes = NULL, awaiting_input_type = NULL WHERE id = $1", [user.id]);
  _resetOutboundDedupe();
  _resetInteractionCorrelation();
  await pool.query("DELETE FROM workout_logs WHERE user_id = $1", [user.id]).catch(() => {});
  await pool.query("DELETE FROM daily_constraints WHERE user_id = $1", [user.id]).catch(() => {});

  const nowMs = RealDate.UTC(SAST_DAY[0], SAST_DAY[1], SAST_DAY[2], hour - 2, 30, 0);
  const dayStartUtc = RealDate.UTC(SAST_DAY[0], SAST_DAY[1], SAST_DAY[2], -2, 0, 0);
  for (const d of (opts.mealDaysAgo || [])) {
    await pool.query(
      `INSERT INTO meal_logs (user_id, raw_message, source, kcal_int, protein_int, meal_label, logged_at)
       VALUES ($1,$2,'text',$3,$4,$5,$6)`,
      [user.id, `seeded meal ${d}d ago`, 600, 40, "lunch",
        new RealDate(dayStartUtc - d * 86_400_000 + 11 * 3_600_000)],
    );
  }
  if (opts.weighDaysAgo != null) {
    await pool.query("INSERT INTO weight_logs (user_id, weight, logged_at) VALUES ($1,$2,$3)",
      [user.id, "88", new RealDate(dayStartUtc - opts.weighDaysAgo * 86_400_000 + 5 * 3_600_000)]);
  }
  await pool.query("UPDATE users SET created_at = $2, last_active_at = $3 WHERE id = $1", [
    user.id,
    new RealDate(nowMs - (opts.createdDaysAgo ?? 28) * 86_400_000),
    opts.activeDaysAgo == null ? null : new RealDate(nowMs - opts.activeDaysAgo * 86_400_000),
  ]);
}

const settle = () => new Promise(r => setTimeout(r, 1500));

/** One turn at a pinned SAST hour. Does NOT wipe, so a two-turn journey stays one conversation. */
async function say(hour: number, text: string, sid: string): Promise<string> {
  const before = (await wire()).length;
  const unfreeze = freezeSast(hour);
  try {
    await processTextAsync(phone, text, null, null, [], handleMessage as any, sid);
    await settle();
  } finally { unfreeze(); }
  return (await wire()).slice(before).join("\n");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// C15 BASE PROBE on d92c0ce — the present client, through both callers of the same question.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const { buildDayState } = await import("../server/handlers/one-action-command");
const { oneActionCommand } = await import("../server/handlers/one-action-command");

const show = (label: string, body: string) => {
  REAL(`\n--- ${label} ---`);
  REAL(body ? `  ${JSON.stringify(body)}` : "  (no body)");
};

const snap = async (hour: number, label: string) => {
  const unfreeze = freezeSast(hour);
  try {
    const u = (await pool.query("SELECT * FROM users WHERE id = $1", [user.id])).rows[0];
    const shaped = { ...u, id: user.id, phoneNumber: phone, name: u.name, goalType: u.goal_type,
      createdAt: u.created_at, calorieTarget: u.calorie_target, proteinTarget: u.protein_target,
      stepsTarget: u.steps_target, trainingDaysPerWeek: u.training_days_per_week };
    const ds = await buildDayState(shaped);
    REAL(`  [state ${label}] gap=${ds.daysSinceAnyLog} loggedToday=${ds.loggedToday} protPct=${ds.proteinPct?.toFixed(2)} calPct=${ds.caloriePct?.toFixed(2)} sess=${ds.sessionsThisWeek}/${ds.sessionsTarget} steps=${ds.stepsToday}/${ds.stepsTarget} weighIn=${ds.daysSinceWeighIn} weeks=${ds.weeksOnProgramme}`);
    // The two callers of the SAME question, side by side.
    const noFlag = (await oneActionCommand(shaped, { atKeyboard: true, asksAboutToday: true } as any)).replace(/\[BUTTONS:[^\]]+\]/g, "").trim();
    const withFlag = (await oneActionCommand(shaped, { atKeyboard: true, asksAboutToday: true } as any)).replace(/\[BUTTONS:[^\]]+\]/g, "").trim();
    REAL(`  [misc-commands.ts:94  as called now] ${JSON.stringify(noFlag)}`);
    REAL(`  [early-commands:1437 as called now] ${JSON.stringify(withFlag)}`);
    REAL(`  [AGREE?] ${noFlag === withFlag ? "yes" : "NO — two answers to one question"}`);
  } catch (e: any) { REAL(`  [state ${label}] ERROR ${e?.message}`); }
  finally { unfreeze(); }
};

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\npg-present-client-acceptance — the present client is coached\n");
REAL("0. THE INSTRUMENTS — every detector, against labelled strings, before anything is graded");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Written independently of the composers they judge. Each is checked against the EXACT MEASURED
// BASE BODIES it must catch, the honest phrasings it must not, and the stubbed mouth.

/** A demand that the client report food — the base's answer to all three messages. */
const asksToLogFood = (b: string): boolean =>
  /\b(?:tell|send|give|show|log|share)\b[^.!?\n]{0,45}?\b(?:what you ate|what you'?ve eaten|what you had|your (?:meals?|food|eating)|food (?:for )?today)\b/i.test(String(b || ""))
  || /\blog one (?:meal|thing)\b/i.test(String(b || ""))
  || /\bwhat did you eat\b/i.test(String(b || ""));
/** A coaching move: something to DO today, drawn from the record rather than asked for. */
const carriesCoachingMove = (b: string): boolean =>
  /\bget today'?s session done\b|\bdo today'?s session\b|\bmake your next meal a proper protein meal\b|\bget a \d+-minute walk in today\b|\bnothing new today\b/i.test(String(b || ""));
/** An instruction to EAT something — what a closed food day must never receive. */
const tellsThemToEat = (b: string): boolean =>
  /\b(?:make your next meal|add one more proper meal|get protein into your next meal|start tomorrow with protein)\b/i.test(String(b || ""));
/** The client's own name, counted — two headers used to introduce one instruction. */
const nameCount = (b: string): number => (String(b || "").match(/\bThandi\b/g) || []).length;
/** How many separate instructions the body issues, by the product's own bold wrapper. */
const boldedMoves = (b: string): string[] => (String(b || "").match(/\*[^*\n]+\*/g) || []).map(x => x.slice(1, -1));

const MEASURED_LOG_ASK   = "Thandi — one thing today:\n\n*Log one meal today. Any meal.*\n\n_Nothing resets and nothing is lost — you pick up exactly where you left off._";
const MEASURED_FEELING   = "Heard you on how you're feeling. Showing up still counts. Next move stays small.";
const MEASURED_DOUBLE    = "Thandi — here's the one that matters:\n\nThandi — one thing today:\n\n*Get today's session done.*";
const FIXED_TRAIN        = "Thandi — one thing today:\n\n*Get today's session done.*\n\n_3 more this week and you've done the whole plan._";
{
  const L: Array<[(b: string) => boolean, string, string, boolean]> = [
    [asksToLogFood, "asksToLogFood", MEASURED_LOG_ASK, true],
    [asksToLogFood, "asksToLogFood", "Thandi — one thing today:\n\n*Tell me what you ate today — one line is enough.*", true],
    [asksToLogFood, "asksToLogFood", FIXED_TRAIN, false],
    [carriesCoachingMove, "carriesCoachingMove", FIXED_TRAIN, true],
    [carriesCoachingMove, "carriesCoachingMove", "*Get a 20-minute walk in today.*", true],
    [carriesCoachingMove, "carriesCoachingMove", MEASURED_LOG_ASK, false],
    [carriesCoachingMove, "carriesCoachingMove", MEASURED_FEELING, false],
    [tellsThemToEat, "tellsThemToEat", "*Make your next meal a proper protein meal.*", true],
    [tellsThemToEat, "tellsThemToEat", "*Get a 20-minute walk in today.*", false],
    [tellsThemToEat, "tellsThemToEat", "*Tell me what you ate today — one line is enough.*", false],
  ];
  for (const [fn, name, text, want] of L) {
    chk(fn(text) === want, `${name} ${want ? "catches" : "ignores"}: ${JSON.stringify(text.slice(0, 52))}`);
  }
  chk(nameCount(MEASURED_DOUBLE) === 2, "nameCount sees the measured double header");
  chk(nameCount(FIXED_TRAIN) === 1, "nameCount sees one name in a single-headed body");
  chk(boldedMoves(FIXED_TRAIN).length === 1, "boldedMoves counts one instruction");
  chk(!asksToLogFood(COACH_ANSWER) && !carriesCoachingMove(COACH_ANSWER) && !tellsThemToEat(COACH_ANSWER)
      && nameCount(COACH_ANSWER) === 0 && boldedMoves(COACH_ANSWER).length === 0,
    "the stubbed mouth trips no detector here — no assertion can be met by the fixture",
    JSON.stringify(COACH_ANSWER));
}

/** The four-quiet-days client: nothing logged since, three sessions on the plan, none done. */
const quietFourDays = { mealDaysAgo: [4, 5, 6], weighDaysAgo: 4, activeDaysAgo: 4 };

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n1. FOUR QUIET DAYS, AT THE KEYBOARD — one coaching move, from a ledger we actually hold");
// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL(`    EXACT FAILING BODY ON d92c0ce: ${JSON.stringify(MEASURED_LOG_ASK)}`);
{
  await seed(9, quietFourDays);
  const body = await say(9, "what should I do today?", "SMc15n1");
  chk(carriesCoachingMove(body), "they are given something to DO today", JSON.stringify(body));
  chk(!asksToLogFood(body), "and are not handed the work back as a log ask", JSON.stringify(body));
  chk(/session/i.test(body), "the move is the one the record supports — 0 of 3 sessions this week", JSON.stringify(body));
  chk(boldedMoves(body).length === 1, "exactly one instruction, not a three-step restart", JSON.stringify(body));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. THE SAME CLIENT SAYS 'I'M STRUGGLING' — a bid for coaching is answered with coaching");
// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL(`    EXACT FAILING BODY ON d92c0ce: ${JSON.stringify(MEASURED_FEELING)}`);
{
  await seed(9, quietFourDays);
  const body = await say(9, "I'm struggling", "SMc15n2");
  chk(/showing up still counts|heard you/i.test(body), "the feeling is still acknowledged first", JSON.stringify(body));
  chk(carriesCoachingMove(body), "…and the turn no longer ends there — it carries a move", JSON.stringify(body));
  chk(!asksToLogFood(body), "the move is coaching, not a demand for data", JSON.stringify(body));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. ONE QUESTION, ONE ANSWER — both callers of oneActionCommand agree, through the door");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Graded on the BODIES the two handlers produce, not on the arguments they pass: a convergence
// test that reads the call sites proves only that the source matches itself.
{
  await seed(9, quietFourDays);
  const viaMisc = await say(9, "what should I do today?", "SMc15n3a");
  await seed(9, quietFourDays);
  const viaConfused = await say(9, "I'm lost", "SMc15n3b");
  const moveOf = (b: string) => boldedMoves(b)[0] || "";
  chk(!!moveOf(viaMisc) && moveOf(viaMisc) === moveOf(viaConfused),
    "misc-commands and early-commands hand the same client the same move",
    `misc=${JSON.stringify(moveOf(viaMisc))} confused=${JSON.stringify(moveOf(viaConfused))}`);
  chk(nameCount(viaConfused) === 1, "the confused path introduces it once, not twice", JSON.stringify(viaConfused));
  chk(boldedMoves(viaConfused).length === 1, "and with one header, not two", JSON.stringify(viaConfused));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. A CLOSED FOOD DAY STILL BINDS THE MOVE — and does not silence it");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The control matters more than the case: with the day OPEN this client's move IS an eat
// instruction, so the closure has something real to suppress. Without it §4 would pass on a
// client the protein rung was never going to reach.
{
  const eatingToday = { mealDaysAgo: [0, 1, 2, 3, 4], weighDaysAgo: 2, activeDaysAgo: 0 };
  await seed(19, eatingToday);
  const open = await say(19, "what should I do today?", "SMc15n4a");
  chk(tellsThemToEat(open), "CONTROL — with the day open, the move is an eat instruction", JSON.stringify(open));

  await seed(19, eatingToday);
  await say(19, "I'm not eating anything else today", "SMc15n4b");
  const closed = await say(19, "what should I do today?", "SMc15n4c");
  chk(!tellsThemToEat(closed), "closed, they are not told to eat", JSON.stringify(closed));
  chk(carriesCoachingMove(closed), "…and are still given a move rather than silence", JSON.stringify(closed));
  chk(boldedMoves(closed).length === 1, "one move", JSON.stringify(closed));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. CONTROLS — what this cut must NOT have done");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  // 5a. A GREETING IS STILL NOT A COACHING BID. The close was opened for a feeling, not for every
  //     turn that writes nothing — otherwise the coach always has a note, which is its own failure.
  await seed(9, quietFourDays);
  const hi = await say(9, "thanks", "SMc15n5a");
  chk(!carriesCoachingMove(hi), "'thanks' does not get an instruction stapled to it", JSON.stringify(hi));

  // 5b. SILENCE IS STILL SILENCE. A client genuinely gone, NOT at the keyboard, is still reached
  //     by the absence rung through the proactive projection — atKeyboard is what the reactive
  //     callers set, and this cut did not make it unconditional.
  const { chooseAction, dayStateFrom } = await import("../server/one-action");
  const { NO_CONSTRAINTS } = await import("../server/food-swaps");
  const gone = dayStateFrom({
    name: "T", goalType: "fat_loss", health: { sick: false },
    food: { loggedDays7d: 0, daysSinceAnyLog: 30 }, workout: { sessionsLast7d: 0 },
    steps: { avg7d: null }, weight: { daysSinceWeighIn: 30, trendUsable: false },
    today: { kcal: 0, protein: 0, steps: 0, logged: false, hour: 9 },
    evidence: { foodSufficient: false, weightSufficient: false },
  } as any, { constraints: NO_CONSTRAINTS, weeksOnProgramme: 8, sessionsTarget: 3,
    calorieTarget: 1900, proteinTarget: 130, stepsTarget: 8000 } as any, { atKeyboard: false, hour: 9 } as any);
  chk(chooseAction(gone).kind === "come_back", "a client who is NOT here still gets the absence rung");

  // 5c. A THIN FOOD LEDGER STILL CANNOT CARRY A FOOD PRESCRIPTION. This cut exempted `train`,
  //     and only `train` — the whole point is that the two ledgers are not alike.
  const thinFood = dayStateFrom({
    name: "T", goalType: "fat_loss", health: { sick: false },
    food: { loggedDays7d: 1, daysSinceAnyLog: 0 }, workout: { sessionsLast7d: 3, sessionsThisWeek: 3 },
    steps: { avg7d: 9000 }, weight: { daysSinceWeighIn: 1, trendUsable: false },
    today: { kcal: 300, protein: 10, steps: 9000, logged: true, hour: 19 },
    evidence: { foodSufficient: false, weightSufficient: false },
  } as any, { constraints: NO_CONSTRAINTS, weeksOnProgramme: 4, sessionsTarget: 3,
    calorieTarget: 1900, proteinTarget: 130, stepsTarget: 8000 } as any, { atKeyboard: true, hour: 19 } as any);
  const { decideProactive } = await import("../server/one-action");
  const thin = decideProactive({
    name: "T", goalType: "fat_loss", health: { sick: false },
    food: { loggedDays7d: 1, daysSinceAnyLog: 0 }, workout: { sessionsLast7d: 3, sessionsThisWeek: 3 },
    steps: { avg7d: 9000 }, weight: { daysSinceWeighIn: 1, trendUsable: false },
    today: { kcal: 300, protein: 10, steps: 9000, logged: true, hour: 19 },
    evidence: { foodSufficient: false, weightSufficient: false },
  } as any, { constraints: NO_CONSTRAINTS, weeksOnProgramme: 4, sessionsTarget: 3,
    calorieTarget: 1900, proteinTarget: 130, stepsTarget: 8000 } as any, { atKeyboard: true, hour: 19 } as any);
  chk(chooseAction(thinFood).kind === "protein" && thin.action.kind !== "protein",
    "a protein prescription on one logged day in seven is still downgraded",
    `ladder=${chooseAction(thinFood).kind} verdict=${thin.action.kind}`);
}

REAL(`\npg-present-client-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

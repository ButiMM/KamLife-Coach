/**
 * REAL-POSTGRESQL ACCEPTANCE — a quiet week is a quiet week, and the ask is honest or absent.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS PROVEN BROKEN ON 0deb7f8 (main), THROUGH THE LIVE FRONT DOOR, BEFORE ANY EDIT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * TWO MEASURED BODIES. Both were captured by driving processTextAsync on 0deb7f8 and reading
 * shadow_replies — not a handler return.
 *
 *  1. A CLIENT WHO JOINED FIVE DAYS AGO, TYPING AT THE KEYBOARD, TOLD THEY HAD BEEN GONE FOURTEEN
 *     WEEKS. They had never logged a meal. At 19:00 they asked "what should I do today?" and got:
 *
 *       "Thandi — one thing today:
 *        *Just say hi. That's the whole ask today.*
 *        _It's been about 14 weeks — you haven't blown anything — that's the story people tell
 *         themselves and it stops them coming back. Your numbers are exactly where you left them._"
 *
 *     Every clause is false. It had been five days. They have no numbers to be exactly where they
 *     left. They had not come back, because they had never gone.
 *
 *     OWNER: `dayStateFrom` in server/one-action.ts mapped `daysSinceAnyLog: null` — "we hold no
 *     meal row for this client" — to the sentinel 99, and rung 1 of chooseAction divides that by
 *     seven and speaks the result aloud as a week count. 99 measures nothing; it was picked for
 *     being big. The honest ceiling on a gap that was never observed is how long the client has
 *     been with us, which every caller already computes as `weeksOnProgramme` from `created_at`.
 *
 *  2. THE ASK THAT COMPLAINED INSTEAD OF ASKING. An empty late day, with the client present and
 *     logging earlier the same week, closed on:
 *
 *       "Thandi — one thing today:
 *        *Tell me what you ate today — one line is enough.*
 *        _I can't coach a day I can't see._"
 *
 *     The instruction is the whole ask. The line under it restates that we cannot see the day —
 *     about the coach, not the client — and it lands as the last word of a turn that had just
 *     answered them. It is deleted. One useful ask, or silence: both renderers now emit the
 *     reason only when there is one, so the ask stands alone rather than over empty italics.
 *
 * WHAT THE FIRST REPAIR EXPOSED, AND WHY IT IS IN THIS CUT. Restoring the real gap moved every
 * never-logged client OFF the four-week rung ("Just say hi") and onto the one-to-three-week rung,
 * which says "Log one meal today. Any meal." — and that branch had never read `foodDayClosed`.
 * pg-proactive-authority turned red on a client who had just said "I'm not eating anything else
 * today" and was sold a meal in reply. It had been passing by accident: the 99 sentinel kept that
 * branch unreachable for anyone without a meal row. The ask that already exists for the
 * time-pressed client — "Tell me one thing you ate this week." — asks about food they HAVE eaten,
 * so both short-gap branches now use it when the day is closed. No assertion was weakened.
 *
 * THE THIRD OWNER, REPAIRED AND DELIBERATELY NOT CLAIMED AS A DETECTION. server/understanding/
 * live.ts built the same field as `foodRowToday ? 0 : (truth.window.daysLogged > 0 ? 1 : 7)` — a
 * number invented out of two booleans, in which every gap inside the window reads as ONE and a
 * client who joined yesterday reads the same as one who has been here a year. It now measures the
 * gap from `truth.window.perDay`, the logged SAST day keys the ledger already returned, capped at
 * `daysOnProgramme` past the window's edge. IT MOVES NO BODY ON THIS BASE, and this file says so
 * rather than pretending otherwise: rung 1 is the field's only consumer and it is gated on
 * `!atKeyboard`, which live.ts hardcodes true because it only ever runs on a reactive turn. §7
 * grades the decision contract that field feeds; the repair itself is a fabricated input removed
 * one gate away from being read, and the red-on-revert harness does not list it as a case.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS GRADED, AND WHERE IT IS READ FROM
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Stored truth is read from meal_logs. The reply is read from shadow_replies — the body AFTER
 * sendFinal, prepareOutbound and the delivery owner. The clock is frozen at a pinned SAST hour on
 * every case, because every assertion here is about a number of days.
 *
 * THE MODEL IS STUBBED AND THE STUB CONTAINS NONE OF THE GRADED WORDS. It says nothing about
 * weeks, absences, logging or seeing a day, so no assertion below can be satisfied by the mouth —
 * §0 proves that against the stub itself before any case runs. §6 is the anti-overreach control:
 * a client who really has been gone two months is STILL told so, in weeks, out loud.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-honest-gap-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
  process.exit(0);
}
process.env.OPENAI_API_KEY = "sk-test-offline";
process.env.OFFLINE_AI = "0";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
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
const COACH_ANSWER = "Tinned fish on toast holds up fine at this hour, and plain yoghurt with fruit is the other one worth keeping in the house.";
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

const phone = "whatsapp:+27820000961";
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
  await pool.query("UPDATE users SET profile_notes = NULL WHERE id = $1", [user.id]);
  _resetOutboundDedupe();
  _resetInteractionCorrelation();

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

REAL("\npg-honest-gap-acceptance — a quiet week is a quiet week, and the ask is honest or absent\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("0. THE INSTRUMENTS — every detector, against labelled strings, before anything is graded");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// These are written independently of the product: none of them imports the composer they judge.
// Each is checked against the EXACT MEASURED BASE BODIES (which it must catch), against the
// honest phrasings it must NOT catch, and against the mouth stub — because a claim the fixture
// can satisfy is worthless whether it passes or fails.

/**
 * The come_back rung speaking a DURATION aloud: "It's been about 14 weeks", "about a month".
 *
 * NO LEADING \b, DELIBERATELY. The reason line is rendered inside WhatsApp italics — `_It's been
 * about 14 weeks_` — and `_` is a word character, so `\bit` never matches at the start of an
 * italic run. The first labelled string below is the exact measured body, wrapper included, and
 * it is what caught that. Both apostrophes are accepted because a renderer may curl one.
 */
const speaksAbsenceWeeks = (b: string): boolean =>
  /it['\u2019]?s been about\s+(?:a month|\d{1,3}\s*weeks?)/i.test(String(b || ""));
/** The come_back rung's other tell: prose written for somebody who left and is coming back. */
const talksToSomeoneWhoLeft = (b: string): boolean =>
  /just say hi|exactly where you left them|haven['\u2019]?t blown anything|no catching up/i.test(String(b || ""));
/** A demand that the client report food. */
const asksToLogFood = (b: string): boolean =>
  /\b(?:tell|send|give|show|log|share)\b[^.!?\n]{0,45}?\b(?:what you ate|what you'?ve eaten|what you had|your (?:meals?|food|eating|dinner|lunch|breakfast)|food (?:for )?today)\b/i.test(String(b || ""))
  || /\bwhat did you eat\b/i.test(String(b || ""));
/** The deleted theatre line, in any spelling of the apostrophe. */
const speaksTheatreLine = (b: string): boolean =>
  /coach a day i\s*(?:can['\u2019]?t|cannot)\s*see/i.test(String(b || ""));
/** An empty reason slot: the italic wrapper rendered around nothing. */
const hasEmptyReasonSlot = (b: string): boolean => /(^|\n)_\s*_(\n|$)|\*\n\n__|\*\s__\s*$/.test(String(b || ""));
/** How many separate instructions the body issues, counted by the product's own bold wrapper. */
const boldedMoves = (b: string): string[] => (String(b || "").match(/\*[^*\n]+\*/g) || []).map(s => s.slice(1, -1));

const MEASURED_FAKE = "Thandi — one thing today:\n\n*Just say hi. That's the whole ask today.*\n\n_It's been about 14 weeks — you haven't blown anything — that's the story people tell themselves and it stops them coming back. Your numbers are exactly where you left them._";
const MEASURED_THEATRE = "Thandi — one thing today:\n\n*Tell me what you ate today — one line is enough.*\n\n_I can't coach a day I can't see._";
const HONEST_ASK_ONLY = "Thandi — one thing today:\n\n*Tell me what you ate today — one line is enough.*";

{
  const LABELLED: Array<[(b: string) => boolean, string, string, boolean]> = [
    [speaksAbsenceWeeks, "speaksAbsenceWeeks", MEASURED_FAKE, true],
    [speaksAbsenceWeeks, "speaksAbsenceWeeks", "_It's been about 8 weeks — you haven't blown anything._", true],
    [speaksAbsenceWeeks, "speaksAbsenceWeeks", "It\u2019s been about a month, and that makes complete sense", true],
    [speaksAbsenceWeeks, "speaksAbsenceWeeks", "It's been about a month, and that makes complete sense", true],
    [speaksAbsenceWeeks, "speaksAbsenceWeeks", "Been 4 days — no lecture. We pick up where you left off.", false],
    [speaksAbsenceWeeks, "speaksAbsenceWeeks", HONEST_ASK_ONLY, false],
    [talksToSomeoneWhoLeft, "talksToSomeoneWhoLeft", MEASURED_FAKE, true],
    [talksToSomeoneWhoLeft, "talksToSomeoneWhoLeft", HONEST_ASK_ONLY, false],
    [asksToLogFood, "asksToLogFood", MEASURED_THEATRE, true],
    [asksToLogFood, "asksToLogFood", HONEST_ASK_ONLY, true],
    [asksToLogFood, "asksToLogFood", "Make your next meal a proper protein meal.", false],
    [speaksTheatreLine, "speaksTheatreLine", MEASURED_THEATRE, true],
    [speaksTheatreLine, "speaksTheatreLine", "I can't coach a day I cannot see.", true],
    [speaksTheatreLine, "speaksTheatreLine", "_I can\u2019t coach a day I can\u2019t see._", true],
    [speaksTheatreLine, "speaksTheatreLine", HONEST_ASK_ONLY, false],
    [hasEmptyReasonSlot, "hasEmptyReasonSlot", "Thandi — one thing today:\n\n*Tell me what you ate today.*\n\n__", true],
    [hasEmptyReasonSlot, "hasEmptyReasonSlot", HONEST_ASK_ONLY, false],
    [hasEmptyReasonSlot, "hasEmptyReasonSlot", MEASURED_THEATRE, false],
  ];
  for (const [fn, name, text, want] of LABELLED) {
    chk(fn(text) === want, `${name} ${want ? "catches" : "ignores"}: ${JSON.stringify(text.slice(0, 58))}`);
  }
  chk(boldedMoves(HONEST_ASK_ONLY).length === 1, "boldedMoves counts one instruction in a one-move body");
  chk(boldedMoves("What do you need?\n\n▸ *Today's workout*\n▸ *Log food*\n▸ *My progress*").length === 3,
    "boldedMoves counts three in a three-option restart");

  // THE FIXTURE CANNOT SATISFY ANY CLAIM IN THIS FILE.
  chk(!speaksAbsenceWeeks(COACH_ANSWER) && !talksToSomeoneWhoLeft(COACH_ANSWER)
      && !asksToLogFood(COACH_ANSWER) && !speaksTheatreLine(COACH_ANSWER)
      && !hasEmptyReasonSlot(COACH_ANSWER) && boldedMoves(COACH_ANSWER).length === 0,
    "the stubbed mouth trips no detector in this file — no assertion here can be met by the fixture",
    JSON.stringify(COACH_ANSWER));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n1. FIVE DAYS OLD, NEVER LOGGED, PRESENT — not told they have been gone fourteen weeks");
// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL(`    EXACT FAILING BODY ON 0deb7f8: ${JSON.stringify(MEASURED_FAKE)}`);
{
  await seed(19, { mealDaysAgo: [], weighDaysAgo: 1, createdDaysAgo: 5, activeDaysAgo: 0 });
  const body = await say(19, "what should I do today?", "SMc14a1");
  chk(!speaksAbsenceWeeks(body), "no week count is spoken to a client who has been here five days", JSON.stringify(body));
  chk(!talksToSomeoneWhoLeft(body), "they are not addressed as somebody returning from an absence", JSON.stringify(body));
  // #275: a client who is talking to us is not handed "tell me what you ate" — reversed from C14.
  chk(!asksToLogFood(body), "and a client who is talking to us is not told to log", JSON.stringify(body));
  chk((await meals()).length === 0, "STORED TRUTH — no meal row was invented to make the day look logged");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. AN EMPTY LATE DAY, CLIENT PRESENT THIS WEEK — one useful ask, and nothing under it");
// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL(`    EXACT FAILING BODY ON 0deb7f8: ${JSON.stringify(MEASURED_THEATRE)}`);
{
  await seed(19, { mealDaysAgo: [1, 2], weighDaysAgo: 1, activeDaysAgo: 0 });
  const body = await say(19, "what should I do today?", "SMc14a2");
  chk(!asksToLogFood(body), "a present client is not told to log (#275 — the proactive ask is graded in §7)", JSON.stringify(body));
  chk(!speaksTheatreLine(body), "the day we cannot see is not complained about at the client", JSON.stringify(body));
  chk(!hasEmptyReasonSlot(body), "deleting the reason leaves no empty italics behind it", JSON.stringify(body));
  chk(!speaksAbsenceWeeks(body) && !talksToSomeoneWhoLeft(body),
    "logging one and two days ago is not an absence", JSON.stringify(body));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. THE SAME LINE ON AN ORDINARY TURN — the close, not only the one-thing command");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The one-action command is not the only mouth that reaches askToLog: the canonical close appends
// the same decision to an ordinary conversational turn. A fix graded on one entry point only is
// half a fix, and this is the entry point the client meets by accident rather than on purpose.
{
  await seed(19, { mealDaysAgo: [1, 2], weighDaysAgo: 1, activeDaysAgo: 0 });
  const body = await say(19, "I'm shattered today", "SMc14a3");
  chk(!asksToLogFood(body), "the close does not ask a present client for the day's food (#275)", JSON.stringify(body));
  chk(!speaksTheatreLine(body), "and does not close the turn by complaining it cannot see", JSON.stringify(body));
  chk(!hasEmptyReasonSlot(body), "no empty reason slot on the close path either", JSON.stringify(body));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. TOLD, THEN ASKED — the turn does not demand the thing it has just been given");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  await seed(19, { mealDaysAgo: [1], weighDaysAgo: 1, activeDaysAgo: 0 });
  const receipt = await say(19, "I had chicken and rice for supper", "SMc14a4a");
  const today = (await meals()).filter(r => new RealDate(r.logged_at).getTime()
    >= RealDate.UTC(SAST_DAY[0], SAST_DAY[1], SAST_DAY[2], -2, 0, 0));
  chk(today.length === 1, "STORED TRUTH — the meal they named is on today", JSON.stringify(today));
  chk(!speaksTheatreLine(receipt), "the receipt does not carry the deleted line", JSON.stringify(receipt));

  const body = await say(19, "what should I do today?", "SMc14a4b");
  chk(!asksToLogFood(body), "the food they just sent is not asked for again", JSON.stringify(body));
  chk(boldedMoves(body).length === 1, "they are given exactly one thing to do", JSON.stringify(body));
  chk(!speaksAbsenceWeeks(body) && !talksToSomeoneWhoLeft(body),
    "a client who logged seconds ago is not a re-entry", JSON.stringify(body));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. A QUIET RETURN AFTER FOUR DAYS — one today-move, and no week invented from it");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  await seed(9, { mealDaysAgo: [4, 5], weighDaysAgo: 4, activeDaysAgo: 4 });
  const body = await say(9, "what should I do today?", "SMc14a5");
  chk(!speaksAbsenceWeeks(body), "four days is four days — no week count is spoken", JSON.stringify(body));
  chk(boldedMoves(body).length === 1, "one move, not a menu of three", JSON.stringify(body));
  chk(!hasEmptyReasonSlot(body), "no empty reason slot", JSON.stringify(body));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n6. CONTROL — a client who really has been gone two months is still told so");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE ANTI-OVERREACH CASE. Every assertion above is a NOT, and a cut that silenced the come_back
// rung altogether would pass all of them. It must not: an absence we have actually measured is
// still named, out loud, in weeks, with the RIGHT number of weeks — that is the C14 claim and it
// is unchanged.
//
// WHERE IT IS GRADED MOVED IN C15, AND THE CLAIM DID NOT. This drove "what should I do today?"
// through the front door, which reaches the client where they are STANDING — at the keyboard,
// having just typed. C15 made misc-commands.ts say so (`atKeyboard: true`), which the CTO's C14
// verdict named as the next package's work in as many words: "a present client 60 days gone still
// hears come-back. Inherited." They now get coached instead, and §7 of pg-present-client grades
// that. The absence rung is for a client who is NOT here, so it is graded where such a client is
// actually reached: the proactive projection, with atKeyboard off. Nothing was weakened — the
// same rung, the same wording, the same week arithmetic, asked of the path it governs.
{
  const absent = dayStateFrom({
    name: "Thandi", goalType: "fat_loss", health: { sick: false },
    food: { loggedDays7d: 0, daysSinceAnyLog: 60 }, workout: { sessionsLast7d: 0 },
    steps: { avg7d: null }, weight: { daysSinceWeighIn: 60, trendUsable: false },
    today: { kcal: 0, protein: 0, steps: 0, logged: false, hour: 9 },
    evidence: { foodSufficient: false, weightSufficient: false },
  } as any, { constraints: NO_CONSTRAINTS, weeksOnProgramme: 17, sessionsTarget: 3,
    calorieTarget: 1900, proteinTarget: 130, stepsTarget: 8000 } as any,
    { atKeyboard: false, hour: 9 } as any);
  const act = chooseAction(absent);
  const body = formatOneAction(act, "Thandi");
  chk(speaksAbsenceWeeks(body), "a real sixty-day absence is still spoken as weeks", JSON.stringify(body));
  chk(/\babout 8 weeks\b/i.test(body), "and it is the RIGHT number of weeks — sixty days is eight, not fourteen",
    JSON.stringify(body));
  chk(talksToSomeoneWhoLeft(body), "and they are still addressed as somebody coming back", JSON.stringify(body));

  // …AND THE PRESENT CLIENT IS NOT. The same sixty days, same client, at the keyboard: C15's
  // change, asserted here so a revert of it turns this file red too.
  await seed(9, { mealDaysAgo: [60, 61], weighDaysAgo: 60, createdDaysAgo: 120, activeDaysAgo: 60 });
  const present = await say(9, "what should I do today?", "SMc14a6");
  chk(!talksToSomeoneWhoLeft(present),
    "a client who is HERE is not told to come back", JSON.stringify(present));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n7. THE PROJECTION AND THE LADDER — what a missing gap means, asked of the owner directly");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The database cases above prove what the client hears. These prove the rule underneath it, on
// the pure owners, so a future caller that assembles state differently is held to the same
// meaning. `daysSinceAnyLog: null` is NEVER LOGGED — a state with no duration in it at all.
{
  const state = (weeks: number, gap: number | null) => ({
    name: "Thandi", goalType: "fat_loss", health: { sick: false },
    food: { loggedDays7d: null, daysSinceAnyLog: gap },
    workout: { sessionsLast7d: 0 }, steps: { avg7d: null },
    weight: { daysSinceWeighIn: 1, trendUsable: false },
    today: { kcal: 0, protein: 0, steps: 0, logged: false, hour: 19 },
    evidence: { foodSufficient: false, weightSufficient: false },
  });
  const profile = (weeks: number) => ({
    constraints: NO_CONSTRAINTS, weeksOnProgramme: weeks, sessionsTarget: 3,
    calorieTarget: 1900, proteinTarget: 130, stepsTarget: 8000,
  });
  const gapFor = (weeks: number, gap: number | null) =>
    dayStateFrom(state(weeks, gap) as any, profile(weeks) as any).daysSinceAnyLog;

  // #275: not their tenure either — a gap nobody measured is unknown, and says so.
  chk(gapFor(0, null) === null, "never logged, here five days → unknown, not zero and not ninety-nine", String(gapFor(0, null)));
  chk(gapFor(10, null) === null, "never logged, here ten weeks → unknown, not their tenure", String(gapFor(10, null)));
  chk(gapFor(17, null) !== 99, "99 is gone as a value this projection can produce", String(gapFor(17, null)));
  chk(gapFor(4, 5) === 5, "a measured gap passes through untouched", String(gapFor(4, 5)));

  // THE LADDER'S READING OF A REAL GAP — the contract live.ts now feeds an honest number into.
  const day = (gap: number, atKeyboard: boolean) => dayStateFrom(
    state(4, gap) as any, profile(4) as any, { atKeyboard, hour: 19 } as any);
  chk(chooseAction(day(0, false)).kind !== "come_back", "a gap of zero is never a re-entry");
  chk(chooseAction(day(2, false)).kind !== "come_back", "two days is not an absence worth standing down for");
  chk(chooseAction(day(4, false)).kind === "come_back", "four days is, and the rung still fires on a real gap");
  chk(/\babout 10 weeks\b/i.test(chooseAction(day(70, false)).why),
    "seventy days is spoken as ten weeks", chooseAction(day(70, false)).why);

  // A CLOSED FOOD DAY BINDS THE ABSENCE RUNG. Exposed by this cut, not introduced by it: the 99
  // sentinel put every never-logged client past the four-week rung, so the one-to-three-week
  // branch — "Log one meal today. Any meal." — was never reached by one. With the real tenure it
  // is, and it must not sell a meal to somebody who has just said they are eating nothing else.
  for (const gap of [21, 4]) {
    const closed = chooseAction({ ...day(gap, false), foodDayClosed: true } as any);
    chk(closed.kind === "come_back", `a ${gap}-day gap still stands the coach down`, closed.kind);
    chk(!/\beat\b|\bmeal\b/i.test(`${closed.todo} ${closed.why}`),
      `and at ${gap} days it does not sell food to a client who closed the day`,
      JSON.stringify(`${closed.todo} | ${closed.why}`));
  }
  const open21 = chooseAction(day(21, false));
  chk(/\bmeal\b/i.test(open21.todo),
    "CONTROL — with the day still open the meal ask is unchanged", JSON.stringify(open21.todo));

  // AND THE ASK ITSELF — no reason, and no empty wrapper where one used to be.
  // Not at the keyboard: a client at the keyboard is not asked to log at all (#275).
  const lateEmptyDay = day(1, false);
  const ask = chooseAction({ ...lateEmptyDay, daysSinceWeighIn: 1, loggedToday: false, hour: 21 } as any);
  chk(ask.kind === "log", "a late empty day still reaches the log ask when we write first", ask.kind);
  const atKeyboard = chooseAction({ ...day(1, true), daysSinceWeighIn: 1, loggedToday: false, hour: 21 } as any);
  chk(atKeyboard.kind !== "log", "…and never when they are the one typing", atKeyboard.kind);
  chk(ask.why === "", "and it carries no reason at all", JSON.stringify(ask.why));
  chk(!speaksTheatreLine(formatOneAction(ask, "Thandi")) && !hasEmptyReasonSlot(formatOneAction(ask, "Thandi")),
    "rendered, it is the ask and nothing else", JSON.stringify(formatOneAction(ask, "Thandi")));

  // THE OTHER MOUTH THAT RENDERS A REASON. decideProactive builds its own `line`, and that line
  // is what the evening, weekly and pattern jobs put on the wire — a proactive surface the
  // reactive cases above never touch. It reaches the same askToLog through the evidence
  // downgrade, so it is the second place an empty reason would have shipped a bare `__`.
  const brief = decideProactive(
    { ...(state(4, 1) as any), food: { loggedDays7d: 2, daysSinceAnyLog: 1 }, steps: { avg7d: 9000 },
      workout: { sessionsLast7d: 3 }, today: { kcal: 0, protein: 0, steps: 9000, logged: false, hour: 21 } } as any,
    profile(4) as any, { hour: 21 } as any);
  chk(brief.action.kind === "log", "the proactive brief reaches the same log ask", brief.action.kind);
  chk(asksToLogFood(brief.line), "and its line carries the ask", JSON.stringify(brief.line));
  chk(!hasEmptyReasonSlot(brief.line) && !speaksTheatreLine(brief.line),
    "with no empty reason slot and no complaint under it", JSON.stringify(brief.line));
}

REAL(`\npg-honest-gap-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

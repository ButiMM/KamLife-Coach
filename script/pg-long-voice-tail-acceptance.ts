/**
 * REAL-POSTGRESQL ACCEPTANCE — a long note reaches the handlers whole (Cut 3).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS PROVEN BROKEN ON 017efd9, BEFORE A LINE OF THIS CUT WAS WRITTEN
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * cleanSATranscript sent `text.slice(0, 1500)` to the model and returned the model's answer AS
 * THE TRANSCRIPT. On the 2,408-character note below — 500 words, about three minutes of speech:
 *
 *     handed to the model            1500 chars
 *     returned as "the transcript"   1500 chars
 *     SILENTLY DELETED                908 chars
 *
 * Gone with them: the workout correction, BOTH questions, and the last thing the client said.
 * The condenser carried the same defect one window wider (4,000 chars) and, unlike the cleaner,
 * replaced the client's account with a model's retelling of it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS ACCEPTANCE CLAIMS, AND WHAT IT DELIBERATELY DOES NOT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * IT CLAIMS: everything the client said arrives at the handlers, durably, and the numbers in it
 * are not reshaped on the way.
 *
 * IT DOES NOT CLAIM that every fact in a long note then reaches its durable owner. It does not,
 * and that is measured rather than assumed — §5 records it. Driven through the real front door on
 * this exact build, the 2,408-character note logs its 8,500 steps and does NOT log the meal it
 * names, because the note asks two questions and the routing gives one turn to one owner. That is
 * first-match-wins, it predates this cut, and it is Cut 6's subject ("one voice message, one
 * authoritative interaction"). Asserting it green here would be asserting a defect.
 *
 * WHAT CHANGED IS STILL THE PRECONDITION FOR FIXING IT: before this cut the tail was not merely
 * unrouted, it was deleted, so no future routing change could have reached facts that no longer
 * existed. Now they are present at the front door and the remaining failure is downstream.
 *
 * GRADED POST-TRANSPORT on turn_ledger (what the handlers were given) and the durable owners.
 * The cleaner itself is graded in script/voice-provenance-tests.ts against a stub client, because
 * the real voice path cannot run offline: assertSafeMediaUrl requires an https allow-listed host
 * and transcription needs the network. Stated, not implied.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-long-voice-tail-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
const { _resetInteractionCorrelation } = await import("../server/handlers/chat-log");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

// ── THE FIXTURE THE ORDER SPECIFIES ──────────────────────────────────────────────────────────
// Unique facts at the beginning, the middle and the end, so WHERE a loss happens is visible:
//   near the beginning   a named-day meal      "Yesterday I had pap and chicken for lunch"
//   the middle           8,500 spoken steps
//   near the end         a workout correction  "I said Tuesday but actually I missed it"
//   throughout           feeling and context
//   near the end         two questions
//   the last words       a unique tail marker  KNEECLICK7788
const TAIL_MARKER = "KNEECLICK7788";
const NOTE = [
  "Yoh coach, sorry for the long message neh, it has been a mad week and I want to tell you everything so you have the full picture of what is actually going on with me at the moment.",
  "Yesterday I had pap and chicken for lunch, it was a big plate because my sister cooked and you know how she cooks, she does not know how to cook a small amount of anything for anybody.",
  "Then in the evening I only had rooibos tea because I was not hungry at all after that plate, and I did not want to force food in just because it was supper time, so I left it there.",
  "This morning I woke up late again, the taxi was full, I had to wait for the second one and then the second one also filled up before it got to my stop so I waited for a third one.",
  "By the time I got to the office I had already missed my usual breakfast time completely so I just had nothing, which I know you are going to tell me is not the right thing to do.",
  "I have been walking a lot more though because the new taxi rank drops me far from the office, it is about fifteen minutes each way and I do it twice a day now, morning and evening.",
  "So yesterday my phone said I did 8500 steps, which I think is the most I have done in a very long time honestly, and I did not even plan it, it just happened because of the walking.",
  "I am feeling tired and a bit down about the whole thing to be honest with you, like I am putting in the work every single day but the scale is not moving and it makes me want to give up.",
  "My colleague keeps bringing those vetkoek to the office in the mornings and I have been saying no to them all week, which is not easy when you have skipped breakfast and you are hungry.",
  "Oh and I must correct something I told you earlier in the week, I said I did my workout on Tuesday but actually I missed it, I only did the one on Thursday, so please fix that in my record.",
  "I do not want my record saying I trained on a day I did not train because then the numbers you are showing me are not really my numbers and the whole thing stops meaning anything.",
  "What should I be eating on the days when I get home after eight at night and I am too tired to cook anything proper for myself?",
  "And also how many steps should I actually be aiming for now that I am walking to the office and back every single day of the week?",
  `One last thing before I forget, my knee has been clicking a bit when I squat down and I wanted to ask you about that too: ${TAIL_MARKER}.`,
].join(" ");

/** Every fact the order names, and where in the note it lives. */
const FACTS: Array<[where: string, name: string, re: RegExp]> = [
  ["beginning", "the named-day meal", /yesterday i had pap and chicken for lunch/i],
  ["middle", "8,500 steps", /\b8500\b/],
  ["near the end", "the workout correction", /i said i did my workout on tuesday but actually i missed it/i],
  ["throughout", "the feeling", /makes me want to give up/i],
  ["near the end", "question 1 — what to eat after eight", /what should i be eating/i],
  ["near the end", "question 2 — how many steps", /how many steps should i actually be aiming for/i],
  ["the last words", "the tail marker", new RegExp(TAIL_MARKER)],
];

const phone = "whatsapp:+27820000977";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Lerato Long", onboardingState: "COMPLETE", popiConsent: true,
  popiConsentAt: new Date(), subscriptionStatus: "active", goalType: "fat_loss",
  currentWeight: "88", startWeight: "92", targetWeight: "80", heightCm: 165, age: 31,
  gender: "female", trainingMode: "gym", proteinTarget: 130, calorieTarget: 1900,
  dailyCalorieTarget: 1900, dailyStepTarget: 8000, stepsTarget: 8000,
} as any).returning();

const clear = async () => {
  for (const t of ["meal_logs", "step_logs", "chat_history", "turn_ledger", "workout_logs"]) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [user.id]);
  }
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  _resetOutboundDedupe();
  _resetInteractionCorrelation();
};
const settle = () => new Promise(r => setTimeout(r, 1500));
const ledger = async () => (await pool.query<{ input_text: string | null; delivered_body: string | null }>(
  "SELECT input_text, delivered_body FROM turn_ledger WHERE user_id = $1 ORDER BY created_at", [user.id])).rows;
const wire = async () => (await pool.query<{ body: string }>(
  "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body);

REAL("\npg-long-voice-tail-acceptance — the long note reaches the handlers whole\n");
REAL(`  fixture: ${NOTE.length} chars, ${NOTE.split(/\s+/).filter(Boolean).length} words\n`);

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("1. EVERY FACT THE CLIENT SPOKE IS IN WHAT THE HANDLERS WERE GIVEN");
// ══════════════════════════════════════════════════════════════════════════════════════════════
await clear();
await processTextAsync(phone, NOTE, null, null, [], handleMessage as any, "sid-long-note");
await settle();
{
  const rows = await ledger();
  chk(rows.length >= 1, "the turn left a ledger row", `got ${rows.length}`);
  const given = rows[0]?.input_text || "";
  chk(given.length === NOTE.length,
    "the recorded input is the whole note, not a window of it",
    `recorded ${given.length} of ${NOTE.length} chars`);
  for (const [where, name, re] of FACTS) {
    chk(re.test(given), `${name} (${where}) survived`, `not found in the ${given.length} chars recorded`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. THE CONTROL — the 1,500-character window is where those facts used to die");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Without this, §1 could be green because the facts happen to sit early in the note. This proves
// four of the seven live BEYOND the old window, so §1 is grading the fix and not the fixture.
{
  const old = NOTE.slice(0, 1500);
  const lost = FACTS.filter(([, , re]) => !re.test(old));
  chk(lost.length >= 4,
    `${lost.length} of the 7 facts are beyond the old window — the fixture genuinely reaches past it`,
    `lost: ${lost.map(([, n]) => n).join(", ")}`);
  chk(!new RegExp(TAIL_MARKER).test(old), "…the tail marker among them");
  chk(/yesterday i had pap and chicken for lunch/i.test(old),
    "…while the opening meal was always inside it, so the window's damage was to the END");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. 8,500 IS STILL 8,500 — the number is not reshaped on the way to its owner");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const steps = (await pool.query<{ steps: number; resolved_day: string | null }>(
    "SELECT steps, resolved_day FROM step_logs WHERE user_id = $1", [user.id])).rows;
  chk(steps.length === 1, "exactly one step row from one spoken count", `got ${steps.length}`);
  // AN OUTCOME CHECK, AND LABELLED AS ONE. Every step-writing site in server/ was mutated while
  // building this cut's red-on-revert and this row still read 8500 — with logStepsForUser patched
  // to throw outright. Its true writer was not identified, so this corroborates rather than
  // guards; §1's "8,500 steps survived" is the guarded claim, and case 7 bites that one.
  chk(steps[0]?.steps === 8500, "8500 stored as 8500 — not 8.5, not 85, not rounded (outcome check)",
    `stored ${steps[0]?.steps}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. NOTHING IS INVENTED FROM A NOTE THIS LONG (Cut 2 must stay true here)");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE MEAL-SLOT CLAIM THAT USED TO STAND HERE IS REMOVED, not relaxed. It asserted "no meal slot
// appears that the client did not name" and checked only that each label belonged to the
// breakfast/lunch/dinner/snack enum — which is also satisfied by ZERO meal rows, and this note
// produces zero. It read as attribution proof and measured nothing of the kind.
//
// Cut 2's own acceptance grades attribution non-vacuously, on rows that exist, at three pinned
// hours, with nine red-on-revert cases behind it. Restating it here weakly could only ever
// weaken it.
{
  const bodies = await wire();
  chk(bodies.length > 0, "the client got an answer to a three-minute note", `${bodies.length} bodies`);
  chk(!/8\.5|85 steps|850 steps/.test(bodies.join("\n")),
    "and no mangled version of their step count is spoken back",
    JSON.stringify(bodies.join(" | ").slice(0, 200)));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. WHAT THIS CUT DOES NOT FIX, RECORDED RATHER THAN CLAIMED");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The meal the client names in the first fifty words does NOT reach meal_logs from inside this
// note, and the answer does not address either question. Measured, not asserted: the same
// sentence sent on its own logs correctly, so the loss is the routing, not the words.
{
  const inNote = (await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM meal_logs WHERE user_id = $1", [user.id])).rows[0].n;
  await clear();
  await processTextAsync(phone, "Yesterday I had pap and chicken for lunch.", null, null, [], handleMessage as any, "sid-meal-alone");
  await settle();
  const alone = (await pool.query<{ meal_label: string | null }>(
    "SELECT meal_label FROM meal_logs WHERE user_id = $1", [user.id])).rows;
  chk(alone.length === 1 && alone[0].meal_label === "lunch",
    "the same sentence ALONE logs correctly, as the lunch they called it",
    `rows=${JSON.stringify(alone)}`);
  REAL(`    OUTSTANDING, UNDER CUT 6 — inside the long note that sentence produced ${inNote} meal`);
  REAL(`    row(s), and the reply addresses neither of the client's two questions. Not asserted`);
  REAL(`    either way: first-match-wins gives one turn to one owner, which predates this cut.`);
  REAL(`    Cut 3 stops the words being deleted before they get there; Cut 6 must make the coach`);
  REAL(`    act on the account it now receives whole.`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n6. NO STAGE BETWEEN THE CLIENT AND THE HANDLERS MAY SHORTEN WHAT THEY SAID (source)");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const { readFileSync } = await import("node:fs");
  const live = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  const media = live(readFileSync("server/handlers/media.ts", "utf-8"));
  const wedge = live(readFileSync("server/understanding/sa-transcript.ts", "utf-8"));
  chk(!/condenseVoiceRamble/.test(wedge), "the condenser is gone, not merely unused");
  chk(!/condenseVoiceRamble/.test(media), "and media.ts condenses nothing before the handlers");
  chk(/const forBrain = transcribedText;/.test(media), "the routed text IS the cleaned transcript");
  chk(/return cleaned \+ tail;/.test(wedge), "the cleaner rejoins the part it could not send");
  // AN ORDERED EDIT CONTRACT, NOT A PERCENTAGE. Two percentages were tried and both were beaten:
  // a reply with 60% of the head, then one with 95.84% of it and the ending intact, each deleting
  // a clause out of the middle. A share of the text cannot tell a spelling from a sentence.
  chk(/finishReason !== "stop"/.test(wedge),
    "a reply the model did not finish cannot become the transcript");
  chk(/!onlyApprovedRepairs\(head, cleaned\)/.test(wedge),
    "…nor can one that is not a token-for-token repair of the head");
  chk(/before\.length !== after\.length/.test(wedge),
    "…because a deleted or invented clause changes the token count");
  chk(/PROTECTED_TOKENS/.test(wedge),
    "…and numbers, days and negations may not be substituted at all");
  chk(!/coversTheEnd|cleaned\.length < head\.length/.test(wedge),
    "the superseded length gates are gone, not left unable to fail");
  // VETTED PAIRS, NOT A VOCABULARY. "Is the new word an SA word within three edits?" approved
  // "pain" -> "pap" and "sad" -> "pap". The question is now "was THIS pair vetted?".
  chk(/VETTED_REPAIRS\.get\(from\) === to/.test(wedge),
    "a substitution is allowed only as an explicitly vetted FROM->TO pair");
  chk(!/editDistance|SA_REPAIR_WORDS/.test(wedge),
    "…and the distance metric and the target vocabulary are gone, not merely unused");
  // PUNCTUATION IS NOT GLOBALLY FREE. The old tokenizer ate the minus sign and the decimal point,
  // so "-5" compared equal to "5" and "8.5" to "85".
  chk(/\[\+−–—-\]\?\\d\+/.test(wedge),
    "a quantity carries its leading sign into the comparison");
  chk(/\\p\{L\}/.test(wedge),
    "…and non-ASCII lexical content is compared, not silently discarded");
  chk(!/\[a-z0-9'\]\+/.test(wedge),
    "the ASCII-only tokenizer is gone, not left beside the one that replaced it");
}

REAL(`\n${failed === 0 ? "pg-long-voice-tail-acceptance: GREEN" : `pg-long-voice-tail-acceptance: ${failed} FAILED`}\n`);
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

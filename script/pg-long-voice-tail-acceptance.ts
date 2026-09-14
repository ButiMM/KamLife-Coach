/**
 * REAL-POSTGRESQL ACCEPTANCE — a long note becomes one complete coaching turn (Cut 5).
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
 * WHAT THIS ACCEPTANCE CLAIMS
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every explicit fact reaches its existing durable owner. The workout correction moves the
 * earlier Tuesday belief to Thursday. Both questions and the feeling/context reach the existing
 * Coach mouth, canonicalDecision owns the one next action, and sendFinal emits one accepted body.
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
process.env.OFFLINE_AI = "0";
process.env.NORMALIZER = "off";
process.env.ENGINE_LIVE = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.SHADOW = "on";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.NODE_ENV = "production";

const COACH_CONTEXT = "After-eight nights do not need cooking: plain yoghurt with fruit, or tinned fish on toast, are quick protein-first options. Your step target remains 8 000, and yesterday's 8 500 is already stored. I heard that the week has been tiring, and the Tuesday workout is now corrected to Thursday.";
const BASELINE_BODY = "Lerato — 8 000 steps is your target. No steps logged yet today — send your count: \"8,500 steps\" or \"walked 5km\".";

// The acceptance exercises the real Coach path without a network dependency. It controls only
// the model's context prose; canonicalDecision still supplies the action, and every database,
// outbound-truth and sendFinal boundary below is production code.
// WHAT WAS ACTUALLY ASKED OF THE MODEL, recorded (Cut 5 completion, 2026-09-14).
//
// The stub below returns COACH_CONTEXT — a fixed string that already contains answers to both
// questions. That is unavoidable (a live model's wording cannot be graded deterministically) and
// it means the "question 1 is answered" checks in §4 grade DELIVERY, not authorship: whatever the
// Coach mouth produced reached the client whole instead of being replaced by a tracker receipt.
//
// The half that was missing is the half this cut is actually about: was the brain GIVEN the whole
// note? Without it, gpt-block could hand the model one question, or the first 500 characters, and
// every §4 check would still pass because the stub answers regardless. So every outbound request
// body is kept and §4b asks that question directly.
const askedOfModel: string[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  if (url.includes("api.openai.com") && !url.includes("/embeddings") && typeof init?.body === "string") {
    askedOfModel.push(init.body);
  }
  if (url.includes("api.openai.com") && url.includes("/embeddings")) {
    return new Response(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: Array(1536).fill(0) }], model: "text-embedding-3-small", usage: { prompt_tokens: 1, total_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("api.openai.com")) {
    return new Response(JSON.stringify({
      id: "chatcmpl-cut5", object: "chat.completion", created: 1, model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: COACH_CONTEXT }, finish_reason: "stop" }],
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
const { parseMealDate, sastDayKey } = await import("../server/sast");

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
const ledger = async () => (await pool.query<{
  input_text: string | null; delivered_body: string | null; decision: any;
  delivery_outcome: string | null; outbound_verdict: any;
}>(
  "SELECT input_text, delivered_body, decision, delivery_outcome, outbound_verdict FROM turn_ledger WHERE user_id = $1 ORDER BY created_at", [user.id])).rows;
const wire = async () => (await pool.query<{ body: string }>(
  "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body);

REAL("\npg-long-voice-tail-acceptance — one long note becomes one complete coaching turn\n");
REAL(`  fixture: ${NOTE.length} chars, ${NOTE.split(/\s+/).filter(Boolean).length} words\n`);

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("1. EVERY FACT THE CLIENT SPOKE IS IN WHAT THE HANDLERS WERE GIVEN");
// ══════════════════════════════════════════════════════════════════════════════════════════════
await clear();
const wrongWorkoutAt = parseMealDate("Tuesday");
const rightWorkoutAt = parseMealDate("Thursday");
await db.insert(schema.workoutLogs).values({ userId: user.id, workoutCompleted: true, loggedAt: wrongWorkoutAt });
await pool.query("UPDATE users SET total_workouts_completed = 1, last_workout_date = $2 WHERE id = $1", [user.id, wrongWorkoutAt]);
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
  const workouts = (await pool.query<{ day_key: string }>(
    "SELECT to_char(logged_at + interval '2 hours', 'YYYY-MM-DD') AS day_key FROM workout_logs WHERE user_id = $1 ORDER BY logged_at", [user.id])).rows;
  const wrongDay = sastDayKey(wrongWorkoutAt);
  const rightDay = sastDayKey(rightWorkoutAt);
  chk(workouts.length === 1 && workouts[0].day_key === rightDay,
    "the correction removes Tuesday and leaves exactly Thursday",
    `wrong=${wrongDay} right=${rightDay} rows=${JSON.stringify(workouts)}`);
  const [derivedWorkout] = (await pool.query<{ total_workouts_completed: number; last_day: string | null }>(
    "SELECT total_workouts_completed, to_char(last_workout_date + interval '2 hours', 'YYYY-MM-DD') AS last_day FROM users WHERE id = $1", [user.id])).rows;
  chk(derivedWorkout.total_workouts_completed === 1 && derivedWorkout.last_day === rightDay,
    "moving the workout preserves the lifetime count and updates the derived last day",
    JSON.stringify(derivedWorkout));

  const meals = (await pool.query<{ day_key: string; meal_label: string | null; raw_message: string; items: any[] }>(
    "SELECT to_char(logged_at + interval '2 hours', 'YYYY-MM-DD') AS day_key, meal_label, raw_message, items FROM meal_logs WHERE user_id = $1 ORDER BY meal_label", [user.id])).rows;
  const yesterday = sastDayKey(parseMealDate("yesterday"));
  chk(meals.length === 2 && meals.every(row => row.day_key === yesterday),
    "both explicit food facts reach meal_logs on yesterday", JSON.stringify(meals));
  chk(meals.some(row => /lunch/i.test(row.meal_label || "") && row.items.some(i => /chicken and pap/i.test(i.name))),
    "pap and chicken is stored as the stated lunch", JSON.stringify(meals));
  chk(meals.some(row => /evening/i.test(row.meal_label || "") && row.items.some(i => /rooibos/i.test(i.name))),
    "the evening rooibos fact also reaches the food owner", JSON.stringify(meals));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. ONE COMPLETE POST-SENDFINAL COACHING TURN");
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
  const finalBody = bodies.join(" | ");
  REAL(`    EXACT FAILING BODY BEFORE: ${JSON.stringify(BASELINE_BODY)}`);
  REAL(`    EXACT FINAL BODY AFTER:    ${JSON.stringify(finalBody)}`);
  chk(bodies.length === 1, "sendFinal emits exactly one WhatsApp body", `${bodies.length} bodies`);
  // THESE FOUR GRADE DELIVERY, NOT AUTHORSHIP, and say so. The Coach mouth is stubbed, so the
  // answers are the fixture's; what is proven is that the Coach's answer to each part REACHES THE
  // CLIENT INTACT rather than being replaced by the tracker receipt printed above. §4b proves the
  // model was asked the questions in the first place, which is what makes these mean anything.
  chk(/after-eight nights|after eight/i.test(finalBody) && /do not need cooking|no-cook/i.test(finalBody),
    "the Coach's answer to question 1 survives to the client's screen", finalBody);
  chk(/step target remains 8[\s\u00a0]?000/i.test(finalBody) && /8[\s\u00a0]?500 is already stored/i.test(finalBody),
    "…and its answer to question 2, including that the 8,500 report was stored", finalBody);
  chk(/week has been tiring/i.test(finalBody), "…and the feeling/context clause", finalBody);
  chk(/Tuesday workout is now corrected to Thursday/i.test(finalBody), "…and the correction, with no receipt mouth in front of it", finalBody);
  chk(!/no steps logged|send your count|log your steps|ask me again/i.test(finalBody),
    "the coach never asks for the steps it just stored", finalBody);
  chk(!/Eish Coach K had a moment|I don't have enough|same answer twice|target hit|steps today|Logged \d+ days/i.test(finalBody),
    "no stall, tracker receipt, or duplicate-meta response becomes the mouth", finalBody);
  chk(!/8\.5|85 steps|850 steps/.test(bodies.join("\n")),
    "and no mangled version of their step count is spoken back",
    JSON.stringify(bodies.join(" | ").slice(0, 200)));

  const rows = await ledger();
  const delivered = rows.find(r => r.delivered_body)?.delivered_body || "";
  const decision = rows.find(r => r.decision)?.decision;
  chk(delivered === bodies[0], "turn_ledger post-transport body equals the one shadow transport received",
    `ledger=${JSON.stringify(delivered)} wire=${JSON.stringify(bodies[0])}`);
  chk(rows.some(r => r.delivery_outcome === "shadow"), "the post-transport shadow delivery result is recorded", JSON.stringify(rows));
  chk(rows.every(r => !r.outbound_verdict?.blocked), "outbound truth accepted the final body", JSON.stringify(rows.map(r => r.outbound_verdict)));
  chk(!!decision?.todo && decision?.kind && decision.kind !== "hold",
    "canonicalDecision supplies one useful next action", JSON.stringify(decision));
  const boldActions = finalBody.match(/\*[^*]+\*/g) || [];
  chk(boldActions.length === 1 && finalBody.includes(String(decision.todo).replace(/[.!]\s*$/, "")),
    "the body carries exactly that one canonical action", `action=${JSON.stringify(decision)} bold=${JSON.stringify(boldActions)}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4b. THE BRAIN WAS ASKED THE WHOLE NOTE — not a window of it, not one question");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE GAP THIS CLOSES. §1 proves the HANDLERS were given the whole note; §4 proves whatever the
// Coach answered reached the client. Between them sat the step this cut is named for, ungraded:
// what gpt-block actually hands the model. With the mouth stubbed, a prompt carrying one question,
// or the first five hundred characters, produces exactly the same green §4 — the stub answers
// regardless. So this reads the outbound request body itself.
//
// It is deliberately about PRESENCE, not phrasing: the model must be able to see every part the
// client spoke. What it then says with them is the model's business and is not asserted here.
{
  // SCOPED TO THE COACH CALL, not every model request in the turn. Joining all of them hid a
  // windowed Coach prompt behind another call that still carried the note — the first version of
  // this section did exactly that and its revert case stayed green. The multi-question
  // instruction is what gpt-block sends ONLY on this path, so it identifies the request uniquely.
  const coachRequests = askedOfModel.filter(r => r.includes("Answer EVERY one directly"));
  chk(coachRequests.length > 0,
    "the multi-question Coach mouth was actually called",
    `${askedOfModel.length} model requests, ${coachRequests.length} of them the Coach's`);
  const prompt = coachRequests.join("\n");

  // JSON-escaped in the request body, so the fixture's own text is escaped the same way before
  // it is looked for — otherwise an apostrophe would fail this for the wrong reason.
  const inPrompt = (needle: string) => prompt.includes(JSON.stringify(needle).slice(1, -1));

  chk(inPrompt("What should I be eating on the days when I get home after eight at night"),
    "question 1 reaches the model, in the client's own words");
  chk(inPrompt("how many steps should I actually be aiming for"),
    "question 2 reaches it too — a multi-question note is not answered one question deep");
  chk(inPrompt("I said I did my workout on Tuesday but actually I missed it"),
    "the correction reaches it, so the coach is not answering from a record it is still fixing");
  chk(inPrompt("makes me want to give up"),
    "the feeling reaches it, which is the part a tracker receipt always dropped");
  chk(inPrompt("8500"), "the spoken step count reaches it unreshaped");
  chk(inPrompt("pap and chicken for lunch"), "and the meals the client named");
  chk(inPrompt(TAIL_MARKER),
    "…including the LAST words of the note, which is where the 1,500-character window used to cut");

  // AND THE WHOLE THING, not merely every fact I happened to list. A per-fact list can only ever
  // find losses I thought to look for; the note's own length is the check that finds the rest.
  chk(prompt.includes(JSON.stringify(NOTE).slice(1, -1)),
    "the entire note is present verbatim, not reassembled from the parts this file names",
    `note ${NOTE.length} chars; prompt ${prompt.length} chars`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. THE LONG NOTE ITSELF IS THE BEHAVIOURAL ACCEPTANCE");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// NOT chk(true, …). An assertion that cannot fail reads as a PASS and measures nothing, which is
// the shape this rescue keeps finding. What is true and checkable is that ONE turn drove all of
// the above, and that it is genuinely the long note rather than a trimmed stand-in.
chk(NOTE.length > 2000 && NOTE.includes(TAIL_MARKER),
  `one ${NOTE.length}-character customer turn drove every assertion above, tail included`,
  `${NOTE.length} chars`);

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

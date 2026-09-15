/**
 * REAL-POSTGRESQL ACCEPTANCE — the client's question is answered by the one final response owner
 * (#92).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS PROVEN BROKEN ON b7908c7, BEFORE A LINE OF THIS CUT WAS WRITTEN
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * On a DECISION turn — any turn where canonicalDecision returns a todo, which is most of them —
 * gpt-block asked the Coach mouth for context only when `isMultiPartAsk(message)` was true: at
 * least 60 characters AND (two "?" | a bolted-on joiner | 35+ words). Everything else took the
 * else-branch and composed the canonical action line with an empty situation frame.
 *
 * Traced through the real front door on b7908c7, three unrelated turns, one client, one day:
 *
 *     "I had a pear. What should I have for dinner tonight?"    51 chars
 *     "What does maintenance calories mean?"                    36 chars
 *     "Hey coach, it's been a busy week but I'm still here…"     no question
 *
 *     ALL THREE  ->  "Thandi — one thing today: *Tell me what you ate today — one line is
 *                     enough.* _I can't coach a day I can't see._"
 *
 * Byte for byte identical. askCoachK was never called on any of them — the recorded outbound
 * requests were the intent classifier and the food extractor and nothing else. The question was
 * not answered badly; it was not answered. And on the pear turn the same turn had already written
 * the pear to meal_logs, so the coach instructed the client to report what it had just recorded.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS ACCEPTANCE CLAIMS
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * §1/§2  A single question on a decision turn is answered, and that answer survives to the wire.
 * §0     The instruction counter is validated before anything is graded with it.
 * §3     The client is told to do exactly ONE thing, counted independently of production's
 *        filter — not by counting bold text, and not by asking the filter about itself.
 * §3b-e  A prescription from the mouth never becomes a second next move, in every phrasing
 *        review has produced: bare imperative, stacked orders, and a fronted meal phrase.
 * §4     A turn carrying NO question is UNCHANGED — the Coach mouth is not called and the body is
 *        the canonical line alone. Without this, "answer the question" is satisfied by handing the
 *        model every decision turn, which is the architecture the 2026-08-23 reviewer disproved.
 * §5     A turn with an existing deterministic owner ("I didn't train") is UNCHANGED.
 * §6     The fixtures genuinely sit beyond the old gate, so §1/§2 grade the fix and not the fixture.
 * §7     The model was actually ASKED the client's question. The mouth is stubbed, so §1/§2 grade
 *        DELIVERY; §7 is what makes them mean anything. Same discipline as Cut 5 §4b.
 *
 * GRADED POST-TRANSPORT on shadow_replies (the wire) and turn_ledger (the stored record), through
 * processTextAsync -> sendFinal -> prepareOutbound. No handler return is graded anywhere here.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-final-response-owner-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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

// ── THE TEST DOUBLES, AND EXACTLY WHAT THEY STAND IN FOR ─────────────────────────────────────
// The Coach mouth returns a fixed sentence per turn. A live model's wording cannot be graded
// deterministically, so §1/§2 ask whether whatever the Coach answered REACHED THE CLIENT rather
// than being replaced by the action line — and §7 asks, separately, whether the Coach was given
// the client's question at all. Neither claim is satisfiable by the stub alone.
//
// The intent classifier is stubbed to the answer production would plausibly give each fixture.
// This matters: left unstubbed it returns confidence 0 on a non-JSON reply, which drives the turn
// into gpt-block's low-confidence clarify exit — a DIFFERENT path, and grading it here would be
// grading the fixture's own breakage instead of the product.
// THE FIXTURES ANSWER AS INFORMATION, NOT AS ORDERS, AND THAT IS THE PRODUCT RULE (#92 review 3).
//
// The first version of `dinner` read "For dinner tonight keep it protein-first: grilled chicken
// with a small portion of rice" — and §1 REQUIRED that sentence to survive to the client while §3
// called the turn one action. Those two claims cannot both be right: the client was told to eat
// chicken tonight AND to report today's food. The reviewer named it, and the fixture was the
// defect as much as the filter was.
//
// A coach answering "what should I have for dinner?" describes what fits; the canonical action is
// the only thing the client is told to DO. §3e drives the order-shaped version separately and
// proves it never reaches the wire.
const ANSWERS: Record<string, string> = {
  dinner: "A pear is a fine snack and it is already on your record. Quick protein-first options for a late dinner are plain yoghurt with fruit, or tinned fish on toast.",
  maintenance: "Maintenance calories are the number that holds your weight exactly where it is: above it you gain, below it you lose.",
};
let COACH_ANSWER = ANSWERS.dinner;
let CLASSIFY = `{"intent":"OTHER","confidence":0.85,"canonical":""}`;
/** Every outbound model request body on the turn, so §7 can ask what the brain was given. */
const askedOfModel: string[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url || input);
  const body = typeof init?.body === "string" ? init.body : "";
  if (url.includes("api.openai.com") && !url.includes("/embeddings") && body) askedOfModel.push(body);
  if (url.includes("api.openai.com") && url.includes("/embeddings")) {
    return new Response(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: Array(1536).fill(0) }], model: "text-embedding-3-small", usage: { prompt_tokens: 1, total_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("api.openai.com")) {
    const isClassifier = body.includes("message-understanding brain");
    return new Response(JSON.stringify({
      id: "chatcmpl-92", object: "chat.completion", created: 1, model: "gpt-4o-mini",
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
const { isMultiPartAsk, looksLikeQuestion } = await import("../server/utils");
const { stripModelDirectives } = await import("../server/brain/reply-verifier");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

// ── THE FIXTURES ─────────────────────────────────────────────────────────────────────────────
// Each is a shape the order names, and each is DELIBERATELY short: the defect lives in the length
// gate, so a long fixture would pass on the unfixed code and prove nothing. §6 asserts that.
const PEAR = "I had a pear. What should I have for dinner tonight?";
const MEANING = "What does maintenance calories mean?";
const CATCHUP = "Hey coach, it's been a busy week but I'm still here and trying";
const NOTRAIN = "I didn't train today";
/** The body every one of these turns produced on b7908c7, whatever the client said. */
const BASELINE_TAIL = "one thing today:";

const phone = "whatsapp:+27820000992";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Thandi Final", onboardingState: "COMPLETE", popiConsent: true,
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
  await pool.query("UPDATE users SET awaiting_input_type = NULL, profile_notes = NULL WHERE id = $1", [user.id]);
  _resetOutboundDedupe();
  _resetInteractionCorrelation();
};
const settle = () => new Promise(r => setTimeout(r, 1500));
const ledger = async () => (await pool.query<{
  delivered_body: string | null; decision: any; delivery_outcome: string | null; outbound_verdict: any;
}>("SELECT delivered_body, decision, delivery_outcome, outbound_verdict FROM turn_ledger WHERE user_id = $1 ORDER BY created_at", [user.id])).rows;
const wire = async () => (await pool.query<{ body: string }>(
  "SELECT body FROM shadow_replies WHERE phone = $1 ORDER BY id", [phone])).rows.map(r => r.body);

/** Drive one production turn and return everything graded below. */
async function turn(message: string, classify: string, answer: string) {
  await clear();
  CLASSIFY = classify;
  COACH_ANSWER = answer;
  askedOfModel.length = 0;
  await processTextAsync(phone, message, null, null, [], handleMessage as any, `sid-92-${message.slice(0, 12)}`);
  await settle();
  const bodies = await wire();
  const rows = await ledger();
  return {
    bodies, rows, body: bodies.join(" | "),
    decision: rows.find(r => r.decision)?.decision,
    delivered: rows.find(r => r.delivered_body)?.delivered_body || "",
    // The Coach mouth is the request carrying the question instruction. The classifier and the
    // food extractor also hit api.openai.com; counting every request would call the mouth
    // "called" on a turn where only the extractor ran, which is the state this cut found.
    coachRequests: askedOfModel.filter(r => r.includes("Answer EVERY one directly")),
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// HOW MANY THINGS IS THE CLIENT BEING TOLD TO DO?
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// THIS DELIBERATELY DOES NOT IMPORT stripModelDirectives. An earlier version of this file graded
// the one-action law two ways, and both were circular or cosmetic:
//
//   · counting bold segments — formatting, not instructions; and
//   · asking the production filter whether the production filter was satisfied — which can only
//     ever confirm that the filter agrees with itself.
//
// Both were green on the body the reviewer produced as a counterexample:
//
//     "A pear is a fine snack and it is already on your record. For dinner tonight keep it
//      protein-first: grilled chicken with a small portion of rice and a big handful of spinach.
//      Thandi — one thing today: *Tell me what you ate today — one line is enough.*"
//
// One bold segment, nothing the filter recognised, and two things the client is told to do.
//
// So this carries its own, deliberately BROADER definition of "an instruction": second-person
// advice, or a bare imperative verb heading a clause, optionally behind a fronted adjunct — minus
// the canonical sentence, which is the one instruction a turn is allowed. Broader than production
// on purpose: a grader that recognised exactly what the filter recognises could never catch the
// filter falling behind, which is the failure this section exists for. Validated against labelled
// sentences in §0 below, so it is not trusted on assertion either.
function instructionSentences(body: string): string[] {
  const ADVISORY_T = /\b(?:you\s+(?:should|need\s+to|have\s+to|could|must|might\s+want\s+to|ought\s+to)|try\s+to|make\s+sure|aim\s+(?:to|for)|i'?d\s+\w+|let'?s|i\s+(?:suggest|recommend)|how about|what about|why not|go for|stick\s+(?:to|with))\b/i;
  const VERB_T = "eat|have|take|get|go|walk|train|do|hit|skip|rest|weigh|add|drop|log|send|tell|keep|grab|swap|choose|pick|start|stop|push|bring|finish|aim|cut|lower|raise";
  // A fronted adjunct is a prepositional or temporal phrase, never "any words" — otherwise a
  // subject noun phrase slides into that slot and "Your step target remains 8 000" reads as an order.
  const FRONTED = "(?:for|at|on|after|before|with|in|by|tonight|tomorrow|today|this\\s+\\w+|next\\s+\\w+|also|then|so|now|instead|rather|first|finally)\\b[^.!?]{0,30}?\\s+";
  const IMPERATIVE_T = new RegExp(`(?:^|[:;]\\s*)(?:${FRONTED})?(?:${VERB_T})\\b(?!\\s*(?:not\\b|n['’]t\\b))`, "i");
  return String(body || "")
    .replace(/[*_]/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s && !/\?$/.test(s) && (ADVISORY_T.test(s) || IMPERATIVE_T.test(s)));
}

/** Instructions in the delivered body that are NOT the canonical action — must always be zero. */
function competingInstructions(body: string, canonicalTodo: string | null | undefined): string[] {
  const canon = String(canonicalTodo || "").trim().toLowerCase().replace(/[.!]+$/, "");
  return instructionSentences(body).filter(s => !(canon && s.toLowerCase().includes(canon)));
}

/**
 * THE CLIENT'S TURN AS THE MOUTH RECEIVED IT — askCoachK's `userMessage`, which is the LAST user
 * message in the request, after the system prompt and the replayed chat history.
 *
 * READING THE WHOLE REQUEST BODY IS NOT ENOUGH, and revert case 4 proved it during this build:
 * with askCoachK handed `message.slice(0, 20)`, a body-wide search for the pear question STILL
 * matched, because the food writer had already put the client's full message into chat_history and
 * askCoachK replays the last six rows. The needle was in the prompt; the question was not asked.
 * That is the same manufactured-evidence shape this programme keeps finding, so the load-bearing
 * §7 assertions read this and not the body.
 */
function lastClientTurn(requestBody: string): string {
  try {
    const msgs = JSON.parse(requestBody)?.messages;
    if (!Array.isArray(msgs)) return "";
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "user") return String(msgs[i]?.content ?? "");
    return "";
  } catch { return ""; }
}

REAL("\npg-final-response-owner-acceptance — one owner answers the client's question\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("0. THE INSTRUMENT ITSELF — the instruction counter is checked before anything is graded with it");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Every one-action claim below rests on this function. An unvalidated counter that answers "zero"
// to everything would make the whole section green and mean nothing — which is the exact shape of
// the bold-count it replaces.
{
  const LABELLED: Array<[string, boolean]> = [
    ["For dinner tonight keep it protein-first: grilled chicken with a small portion of rice.", true],
    ["Have grilled chicken and rice tonight.", true],
    ["Then walk 3km after dinner.", true],
    ["Also eat 200g of chicken tonight.", true],
    ["Eat 200g of chicken tonight.", true],
    ["You should get your steps in before supper.", true],
    ["Tell me what you ate today — one line is enough.", true],
    ["A pear is a fine snack and it is already on your record.", false],
    ["Quick protein-first options for a late dinner are plain yoghurt with fruit, or tinned fish on toast.", false],
    ["After-eight nights do not need cooking: plain yoghurt with fruit are quick protein-first options.", false],
    ["Maintenance calories are the number that holds your weight exactly where it is: above it you gain, below it you lose.", false],
    ["Your step target remains 8 000, and yesterday's 8 500 is already stored.", false],
    ["Pap is a carbohydrate, so it sits beside your protein rather than replacing it.", false],
    ["That plate came in around 600 kcal.", false],
  ];
  const wrong = LABELLED.filter(([s, want]) => (instructionSentences(s).length > 0) !== want);
  chk(wrong.length === 0,
    `the instruction counter labels all ${LABELLED.length} reference sentences correctly`,
    wrong.map(([s, want]) => `${want ? "missed" : "false positive"}: ${JSON.stringify(s.slice(0, 70))}`).join("\n          "));
  chk(instructionSentences("Tell me what you ate today — one line is enough.").length === 1
      && competingInstructions("Tell me what you ate today — one line is enough.", "Tell me what you ate today — one line is enough.").length === 0,
    "…and the canonical sentence counts as an instruction, then is excluded as THE allowed one");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("1. THE LOG-PLUS-QUESTION TURN — the pear is written AND the question is answered");
// ══════════════════════════════════════════════════════════════════════════════════════════════
const pear = await turn(PEAR, `{"intent":"FOOD_LOG","confidence":0.9,"canonical":"i had a pear"}`, ANSWERS.dinner);
{
  REAL(`    EXACT FAILING BODY BEFORE: "Thandi — one thing today: *Tell me what you ate today — one line is enough.* _I can't coach a day I can't see._"`);
  REAL(`    EXACT FINAL BODY AFTER:    ${JSON.stringify(pear.body)}`);
  chk(pear.bodies.length === 1, "sendFinal emits exactly one WhatsApp body", `${pear.bodies.length} bodies`);
  chk(/quick protein-first options/i.test(pear.body) && /tinned fish on toast/i.test(pear.body),
    "the Coach's answer to the dinner question survives to the client's screen", pear.body);
  chk(pear.delivered === pear.bodies[0],
    "turn_ledger's post-transport body equals the body the transport received",
    `ledger=${JSON.stringify(pear.delivered)} wire=${JSON.stringify(pear.bodies[0])}`);
  chk(pear.rows.some(r => r.delivery_outcome === "shadow"), "the post-transport delivery result is recorded",
    JSON.stringify(pear.rows.map(r => r.delivery_outcome)));
  chk(pear.rows.every(r => !r.outbound_verdict?.blocked), "outbound truth accepted the final body",
    JSON.stringify(pear.rows.map(r => r.outbound_verdict)));
  const meals = (await pool.query<{ items: any[] }>("SELECT items FROM meal_logs WHERE user_id = $1", [user.id])).rows;
  chk(meals.length === 1 && meals[0].items.some(i => /pear/i.test(i.name)),
    "the pear still reaches its durable owner — answering the question costs no write",
    JSON.stringify(meals));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. THE MEANING QUESTION — a short question with no fact in it is still answered");
// ══════════════════════════════════════════════════════════════════════════════════════════════
const meaning = await turn(MEANING, `{"intent":"QUESTION","confidence":0.95,"canonical":""}`, ANSWERS.maintenance);
{
  REAL(`    EXACT FINAL BODY AFTER: ${JSON.stringify(meaning.body)}`);
  chk(meaning.bodies.length === 1, "one body", `${meaning.bodies.length} bodies`);
  chk(/holds your weight exactly where it is/i.test(meaning.body),
    "the Coach's answer to 'what does maintenance mean' reaches the client", meaning.body);
  chk(meaning.delivered === meaning.bodies[0], "ledger body equals wire body",
    `${JSON.stringify(meaning.delivered)} vs ${JSON.stringify(meaning.bodies[0])}`);
  chk(meaning.body !== pear.body,
    "two different questions no longer produce the same byte-identical reply",
    `both were: ${JSON.stringify(meaning.body)}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. THE CANONICAL DECISION IS STILL THE ONE ACTION, AND IT IS STILL LAST");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The opposite defect this cut could introduce: the model answering AND prescribing, which is what
// the 2026-08-23 structural-mouth decision removed. Answering a question may not cost the turn its
// single canonical action.
for (const [name, t] of [["pear", pear], ["meaning", meaning]] as const) {
  const todo = String(t.decision?.todo || "").replace(/[.!]\s*$/, "");
  chk(!!t.decision?.todo && t.decision?.kind !== "hold",
    `${name}: canonicalDecision supplied one next action`, JSON.stringify(t.decision));
  const bold = t.body.match(/\*[^*]+\*/g) || [];
  chk(bold.length === 1 && t.body.includes(todo),
    `${name}: the body carries exactly that one canonical action and no second one`,
    `todo=${JSON.stringify(todo)} bold=${JSON.stringify(bold)}`);
  chk(t.body.indexOf(todo) > t.body.indexOf(BASELINE_TAIL) - 1 && t.body.indexOf(todo) > 40,
    `${name}: the action is appended AFTER the answer, not in front of it`,
    `answerEnds=${t.body.indexOf(todo)} body=${JSON.stringify(t.body.slice(0, 120))}`);
  // COUNTING BOLD IS NOT COUNTING INSTRUCTIONS (#92 review). The bold check above is kept because
  // formatting is also part of the contract, but it is not the one-action claim — a second next
  // move in plain prose passes it, which is exactly what the reviewer demonstrated. The claim is
  // made by §0's counter, which has its own definition of an instruction and is broader than the
  // production filter on purpose: a grader that recognised precisely what the filter recognises
  // could never see the filter fall behind, and falling behind is what happened three times.
  const competing = competingInstructions(t.body, t.decision?.todo);
  chk(competing.length === 0,
    `${name}: the client is told to do exactly ONE thing, and it is the canonical action`,
    `also told to: ${JSON.stringify(competing)}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3b. A MODEL PRESCRIPTION DOES NOT BECOME A SECOND NEXT MOVE");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The review finding this cut took on (#92, Codex): a prescriptive question invites the model to
// answer with an instruction, and composeDecisionTurn then appends the canonical action under it.
// Here the mouth is made to return one, and the claim is that it does not reach the client.
//
// WHAT THIS DOES AND DOES NOT PROVE. The fixture's imperative is the shape the product's own
// directive owner recognises, so this grades the removal doing its job on the wire. Phrasings that
// owner does NOT recognise still get through, and the run prints that bound below rather than
// asserting it — following this repo's KNOWN, NOT FIXED HERE convention, because an assertion that
// a defect persists turns red on the day someone fixes it. The PR does not call the finding closed.
const PRESCRIBED = "Eat 200g of chicken tonight. A pear is a fine snack and it is already on your record.";
const prescribe = await turn(PEAR, `{"intent":"FOOD_LOG","confidence":0.9,"canonical":"i had a pear"}`, PRESCRIBED);
{
  REAL(`    MOUTH RETURNED: ${JSON.stringify(PRESCRIBED)}`);
  REAL(`    WIRE          : ${JSON.stringify(prescribe.body)}`);
  chk(!/Eat 200g of chicken tonight/i.test(prescribe.body),
    "a bare imperative from the mouth never reaches the client", prescribe.body);
  chk(/a pear is a fine snack/i.test(prescribe.body),
    "…while the explanation beside it survives — the answer is not thrown away with it",
    prescribe.body);
  const todo = String(prescribe.decision?.todo || "").replace(/[.!]\s*$/, "");
  chk(competingInstructions(prescribe.body, prescribe.decision?.todo).length === 0 && prescribe.body.includes(todo),
    "…and the canonical action is still the one instruction that lands",
    `todo=${JSON.stringify(todo)} also told to: ${JSON.stringify(competingInstructions(prescribe.body, prescribe.decision?.todo))}`);

}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3c. THE REVIEW'S EXACT SHAPE — \"Have… Then… Also…\" plus the answer");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE MERGE BLOCKER, GRADED ON THE WIRE. The earlier version of this cut recorded these three
// phrasings as a known gap; they are the ones a model actually reaches for when asked "what should
// I have for dinner?", so a recorded gap is a shipped defect. Every one is a second next move, and
// the answer sitting beside them is not — it must survive while they do not.
const STACKED = "Have grilled chicken and rice tonight. Then walk 3km after dinner. Also eat 200g of chicken tonight. A pear is a fine snack and it is already on your record.";
const stacked = await turn(PEAR, `{"intent":"FOOD_LOG","confidence":0.9,"canonical":"i had a pear"}`, STACKED);
{
  REAL(`    MOUTH RETURNED: ${JSON.stringify(STACKED)}`);
  REAL(`    WIRE          : ${JSON.stringify(stacked.body)}`);
  for (const [what, re] of [
    ["the plate pick", /Have grilled chicken and rice tonight/i],
    ["the bolted-on second domain", /Then walk 3km after dinner/i],
    ["the quantified prescription", /Also eat 200g of chicken tonight/i],
  ] as const) {
    chk(!re.test(stacked.body), `${what} never reaches the client`, stacked.body);
  }
  chk(/a pear is a fine snack/i.test(stacked.body),
    "…and the answer standing beside them survives — the boundary closes without deleting it",
    stacked.body);
  const todo = String(stacked.decision?.todo || "").replace(/[.!]\s*$/, "");
  chk((stacked.body.match(/\*[^*]+\*/g) || []).length === 1 && stacked.body.includes(todo),
    "…leaving exactly one instruction in the body, and it is the canonical one",
    `todo=${JSON.stringify(todo)} body=${JSON.stringify(stacked.body)}`);
  chk(competingInstructions(stacked.body, stacked.decision?.todo).length === 0,
    "…and nothing else in the body tells the client to do anything",
    JSON.stringify(competingInstructions(stacked.body, stacked.decision?.todo)));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3e. THE REVIEWER'S COUNTEREXAMPLE — an order wearing a fronted meal phrase");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The body this section exists for, produced by the reviewer against the previous head:
//
//   "A pear is a fine snack and it is already on your record. For dinner tonight keep it
//    protein-first: grilled chicken with a small portion of rice and a big handful of spinach.
//    Thandi — one thing today: *Tell me what you ate today — one line is enough.*"
//
// One bold segment, nothing the production filter recognised, and TWO things the client is told
// to do. The old §1 fixture was that sentence and §1 REQUIRED it to survive — the acceptance was
// asserting the defect. It is driven here instead, where the claim is that it does not ship.
const ORDERED = "A pear is a fine snack and it is already on your record. For dinner tonight keep it protein-first: grilled chicken with a small portion of rice and a big handful of spinach.";
const ordered = await turn(PEAR, `{"intent":"FOOD_LOG","confidence":0.9,"canonical":"i had a pear"}`, ORDERED);
{
  REAL(`    MOUTH RETURNED: ${JSON.stringify(ORDERED)}`);
  REAL(`    WIRE          : ${JSON.stringify(ordered.body)}`);
  const competing = competingInstructions(ordered.body, ordered.decision?.todo);
  chk(competing.length === 0,
    "the client is told to do exactly ONE thing — the fronted-phrase order does not ship",
    `also told to: ${JSON.stringify(competing)}`);
  chk(!/keep it protein-first/i.test(ordered.body),
    "…the order itself is gone from the body", ordered.body);
  chk(/a pear is a fine snack/i.test(ordered.body),
    "…and the explanation beside it survives, so closing the boundary did not delete the answer",
    ordered.body);
  const todo = String(ordered.decision?.todo || "").replace(/[.!]\s*$/, "");
  chk(ordered.body.includes(todo), "…and the canonical action is the instruction that remains",
    `todo=${JSON.stringify(todo)} body=${JSON.stringify(ordered.body)}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3d. CONTROL — AN UNAVAILABLE MODEL DOES NOT BECOME A CONFIDENT LOGGING ACTION");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The other half of the blocker. askCoachK returns five different sentences when it cannot answer;
// this drives the one a caller comparing against a single constant would have MISSED, so the check
// grades the predicate and not a lucky string match.
const BUSY = "Coach K is a bit busy right now. Give it 30 seconds and try again.";
const busy = await turn(PEAR, `{"intent":"FOOD_LOG","confidence":0.9,"canonical":"i had a pear"}`, BUSY);
{
  REAL(`    MOUTH RETURNED: ${JSON.stringify(BUSY)}`);
  REAL(`    WIRE          : ${JSON.stringify(busy.body)}`);
  chk(busy.bodies.length === 1, "one body", `${busy.bodies.length} bodies`);
  chk(/a bit busy right now/i.test(busy.body),
    "the client is told the coach could not answer", busy.body);
  chk(!/one thing today/i.test(busy.body) && (busy.body.match(/\*[^*]+\*/g) || []).length === 0,
    "…and no canonical action is appended to an answer that never happened", busy.body);
  chk(!/Tell me what you ate today/i.test(busy.body),
    "…so an unanswered question never ships as a confident instruction to log food", busy.body);
  const meals = (await pool.query<{ items: any[] }>("SELECT items FROM meal_logs WHERE user_id = $1", [user.id])).rows;
  chk(meals.length === 1 && meals[0].items.some(i => /pear/i.test(i.name)),
    "…while the fact the client did state is still written — silence upstream costs no write",
    JSON.stringify(meals));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. CONTROL — A TURN THAT ASKS NOTHING IS UNCHANGED, AND THE MOUTH STAYS SHUT");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Without this the cut is satisfied by handing EVERY decision turn to the model, which is both the
// architecture the reviewer disproved and a per-turn cost on every log a client sends.
const catchup = await turn(CATCHUP, `{"intent":"RANT","confidence":0.7,"canonical":""}`, ANSWERS.dinner);
{
  REAL(`    EXACT FINAL BODY: ${JSON.stringify(catchup.body)}`);
  chk(catchup.coachRequests.length === 0,
    "no question, so the Coach mouth is never asked for context",
    `${catchup.coachRequests.length} coach request(s)`);
  chk(!/protein-first|grilled chicken/i.test(catchup.body),
    "…and no model prose reaches a client who asked nothing", catchup.body);
  chk(catchup.body.includes(BASELINE_TAIL) && competingInstructions(catchup.body, catchup.decision?.todo).length === 0,
    "…the canonical action line is still exactly what goes out, and nothing competes with it",
    `also told to: ${JSON.stringify(competingInstructions(catchup.body, catchup.decision?.todo))}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. CONTROL — A TURN WITH AN EXISTING DETERMINISTIC OWNER IS UNTOUCHED");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// "I didn't train today" belongs to the missed-session owner in lifecycle.ts, which returns before
// gpt-block is ever reached. This cut moved one gate inside gpt-block; if that owner's turn
// changes, the change was not bounded.
const notrain = await turn(NOTRAIN, `{"intent":"OTHER","confidence":0.85,"canonical":""}`, ANSWERS.dinner);
{
  chk(/One missed session/i.test(notrain.body) && /Never miss twice/i.test(notrain.body),
    "the missed-session owner still speaks for its own turn", notrain.body);
  chk(notrain.coachRequests.length === 0, "…and the Coach mouth is not consulted on it",
    `${notrain.coachRequests.length} coach request(s)`);
  chk(!/protein-first|grilled chicken/i.test(notrain.body), "…no model prose reaches it", notrain.body);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n6. CONTROL — THE FIXTURES SIT BEYOND THE OLD GATE, SO §1/§2 GRADE THE FIX");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// If these fixtures satisfied isMultiPartAsk they would have been answered on b7908c7 too and
// every check above would be green on the unfixed code.
{
  for (const [name, text] of [["the pear turn", PEAR], ["the meaning question", MEANING]] as const) {
    chk(!isMultiPartAsk(text), `${name} is NOT a multi-part ask — the old gate refused it`,
      `${text.length} chars: ${JSON.stringify(text)}`);
    chk(looksLikeQuestion(text), `${name} IS a question under the owner routes.ts already uses`);
  }
  chk(!looksLikeQuestion(CATCHUP), "the catch-up turn is not a question, so §4's control is real",
    JSON.stringify(CATCHUP));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n7. THE BRAIN WAS ASKED THE CLIENT'S QUESTION — not just able to answer one");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// §1/§2 grade DELIVERY: the mouth is stubbed, so it answers whatever it is asked. Without this
// section gpt-block could hand the model a truncated message, or the situation frame alone, and
// both would still read green — the same evidence gap Cut 5 found in its own first draft.
for (const [name, t, whole] of [
  ["pear", pear, PEAR],
  ["meaning", meaning, MEANING],
] as const) {
  chk(t.coachRequests.length > 0, `${name}: the Coach mouth was actually called`,
    `recorded ${askedOfModel.length} model request(s), none carrying the question instruction`);
  const prompt = t.coachRequests.join("\n");
  // The client's turn, as the mouth received it — not "somewhere in the prompt". See lastClientTurn.
  const asked = t.coachRequests.map(lastClientTurn).join("\n");
  chk(asked.trim() === whole,
    `${name}: the mouth was handed the client's whole message, not a window or a clause`,
    `asked=${JSON.stringify(asked)} expected=${JSON.stringify(whole)}`);
  chk(/Answer EVERY one directly, in the order asked/.test(prompt),
    `${name}: …under the instruction to answer it`, prompt.slice(0, 200));
  chk(/never ask the client to report them again/.test(prompt),
    `${name}: …and told the facts on this turn are already committed`, prompt.slice(0, 200));
}

await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.end();
REAL(`\npg-final-response-owner-acceptance: ${failed === 0 ? "GREEN" : `FAILED — ${failed} assertion(s)`}\n`);
process.exit(failed === 0 ? 0 : 1);

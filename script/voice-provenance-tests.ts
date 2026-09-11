/**
 * VOICE PROVENANCE — focused tests (2026-09-10).
 *
 * A voice note becomes three different strings before any handler sees it:
 *
 *     Scribe/Whisper  →  cleanSATranscript  →  condenseVoiceRamble (>150 words)  →  handlers
 *
 * Until this cut only the last one was persisted, as `input_text` on the inner ledger row. So the
 * two questions you must be able to answer about a bad voice turn had no evidence behind them:
 * did we MIS-HEAR the client, or did we hear them correctly and then delete half of what they
 * said? Different defects, different owners, different fixes.
 *
 * These tests drive the two model stages FOR REAL — real cleanSATranscript, real
 * condenseVoiceRamble, real fail-open guards — against a stub OpenAI client, with OFFLINE_AI=0 so
 * the offline killswitch does not short-circuit the very code under test. Nothing here is
 * simulated except the network boundary itself.
 *
 * The durable half (which columns, which row, what survives an early return) needs a database and
 * lives in script/pg-voice-provenance-acceptance.ts.
 */
process.env.OFFLINE_AI = "0";          // these stages are the subject; do not skip them
process.env.KAMLIFE_DB_STUB = "1";     // …but no database
process.env.OPENAI_API_KEY = "sk-stub";
process.env.NODE_ENV = "production";

import { readFileSync } from "node:fs";

const { cleanSATranscript, condenseVoiceRamble } = await import("../server/understanding/sa-transcript");
const { transcriptMustPassWhole } = await import("../server/utils");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

/** A stub OpenAI client that returns whatever the test tells it to. No network. */
const stubOpenAI = (reply: string) => ({
  chat: { completions: { create: async () => ({
    choices: [{ message: { content: reply } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }) } },
} as any);

console.log("\nvoice-provenance-tests\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("1. THE CLEANER FAILS OPEN, SO cleaned === raw IS A REAL EVENT AND NOT A MISSING ONE");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// This is why `voice_provenance.cleaned` records whether the stage CHANGED the text rather than
// whether it ran. Both stages return their input on refusal, on a runaway rewrite and on a
// rewrite that dropped the speaker's words — so "cleaned === raw" happens constantly on healthy
// turns, and a column that conflated it with "the cleaner never ran" would be unreadable.
{
  const raw = "Yoh I had samp and beans and chicken for lunch today neh";

  const refused = await cleanSATranscript(stubOpenAI("I'm sorry, I can't help with that."), raw, null);
  chk(refused === raw, "a model refusal keeps the raw transcript", JSON.stringify(refused));

  const runaway = await cleanSATranscript(stubOpenAI(raw + " " + "and then a very long invented addition ".repeat(12)), raw, null);
  chk(runaway === raw, "a runaway rewrite keeps the raw transcript", JSON.stringify(runaway.slice(0, 60)));

  const gutted = await cleanSATranscript(stubOpenAI("Lunch."), raw, null);
  chk(gutted === raw, "a rewrite that drops the speaker's words keeps the raw transcript", JSON.stringify(gutted));

  const empty = await cleanSATranscript(stubOpenAI(""), raw, null);
  chk(empty === raw, "an empty completion keeps the raw transcript", JSON.stringify(empty));

  // …and the control that makes the four above mean something: a faithful clean IS taken.
  const good = "Yoh I had samp and beans and chicken for lunch today neh";
  const fixed = await cleanSATranscript(stubOpenAI(good), "Yoh I had stamp and beans and chicken for lunch today neh", null);
  chk(fixed === good, "a faithful clean replaces the raw transcript — samp, not stamp", JSON.stringify(fixed));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n2. THE CONDENSER IS THE STAGE THAT CAN LOSE THE MOST, AND IT ALSO FAILS OPEN");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  // A LONG NOTE WITH NO FOOD, NO STEPS, NO FEELING AND NO STACKED QUESTION — deliberately, because
  // that narrow case is the ONLY thing the condenser is still allowed to touch. Everything else is
  // protected by transcriptMustPassWhole (§3), and a fixture that tripped that guard would be
  // grading the guard rather than the condenser. Two earlier fixtures did exactly that.
  const long = ("The taxi from Soweto was late again this morning so I got to the office much "
    + "later than usual and my manager gave me a warning about it ").repeat(3);
  chk(!transcriptMustPassWhole(long), "the fixture really does reach the condenser (else §2 grades nothing)");

  const refused = await condenseVoiceRamble(stubOpenAI("I cannot assist with that request."), long, null);
  chk(refused === long, "a refusal keeps the whole transcript", JSON.stringify(refused.slice(0, 50)));

  const condensed = await condenseVoiceRamble(stubOpenAI("My taxi was late so I got to work late."), long, null);
  chk(condensed === "My taxi was late so I got to work late.",
    "a real condense replaces it — and this is the text the handlers route on", JSON.stringify(condensed));
  chk(condensed !== long, "…so forBrain and cleaned genuinely differ, which is what the flag records");

  const short = "I had eggs.";
  const untouched = await condenseVoiceRamble(stubOpenAI("SHOULD NOT BE USED"), short, null);
  chk(untouched === short, "a short note is never condensed", JSON.stringify(untouched));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n3. transcriptMustPassWhole STILL PROTECTS A MULTI-PART NOTE FROM THE CONDENSER");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Not changed by this cut. Asserted because the provenance columns are how anyone will now SEE a
// condense that ate something, and a reader has to be able to trust that a whole-pass note shows
// forBrain === cleaned for a reason rather than by accident.
{
  const multiAsk = "What should I eat today? And also how many steps should I be doing? "
    + "And can you tell me what my weight is doing? ".repeat(8);
  chk(transcriptMustPassWhole(multiAsk), "a note asking more than one thing must pass whole");
  const passed = await condenseVoiceRamble(stubOpenAI("SHOULD NOT BE USED"), multiAsk, null);
  chk(passed === multiAsk, "…and the condenser declines it, leaving forBrain === cleaned");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n4. THE RAW TRANSCRIPT IS CAPTURED BEFORE THE CLEANER CAN OVERWRITE IT");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// A SOURCE-ORDER ASSERTION, and stated as one rather than dressed up as an execution proof.
//
// The voice branch of media.ts cannot be executed offline: assertSafeMediaUrl requires an https
// URL on an allow-listed public host (correctly — it is an SSRF guard, and weakening it for a
// test would be a worse trade than this assertion), and the STT call needs the network. What CAN
// be checked without either is the property that actually matters here, because `transcribedText`
// is REASSIGNED by the cleaner: if the raw capture is not above that line, the client's own words
// are gone before anything records them, and every column below would silently hold cleaned text
// wearing the label "raw".
{
  const src = readFileSync("server/handlers/media.ts", "utf-8");
  const rawAt = src.indexOf("turnVoice({ engine: sttEngine, raw: transcribedText");
  const cleanAt = src.indexOf("transcribedText = await cleanSATranscript(");
  const cleanedAt = src.indexOf("turnVoice({ cleaned: transcribedText })");
  const forBrainAt = src.indexOf("turnVoice({ forBrain,");
  const condenseAt = src.indexOf("await condenseVoiceRamble(");

  chk(rawAt > 0, "media.ts records the raw transcript");
  chk(cleanAt > 0 && rawAt < cleanAt,
    "…BEFORE cleanSATranscript reassigns transcribedText", `raw@${rawAt} clean@${cleanAt}`);
  chk(cleanedAt > cleanAt, "the cleaned text is recorded after the cleaner ran", `cleaned@${cleanedAt}`);
  chk(forBrainAt > condenseAt && condenseAt > 0,
    "the for-brain text is recorded after the condenser", `forBrain@${forBrainAt} condense@${condenseAt}`);
  // The recursion is what hands the text to the handlers. Recording must happen before it, or a
  // handler's own turn scope is the one in flight and the three texts land on the wrong row.
  const recurseAt = src.indexOf("handleMessage(phone, brainInput");
  chk(recurseAt > 0 && forBrainAt < recurseAt,
    "…and before the transcript re-enters handleMessage", `forBrain@${forBrainAt} recurse@${recurseAt}`);

  // THE RECORDED VALUE AND THE PASSED VALUE ARE THE SAME VARIABLE (corrected 2026-09-10).
  //
  // The first version of this cut recorded `forBrain` and then passed
  // `forBrain + "\n\n[LANGUAGE NOTE: …]"` — two different strings, one of them labelled as the
  // other. Rebuilding the note at the recording site would have fixed the value and left the
  // drift: any future edit to one expression and not the other silently makes the record a lie.
  // So media.ts composes it ONCE, into `brainInput`, records that variable, and passes that
  // variable. This asserts there is exactly one composition and that both uses read it.
  chk(src.includes("handlerInput: brainInput"),
    "media.ts records the composed handler input by reference, not by rebuilding it");
  chk((src.match(/\[LANGUAGE NOTE: \$\{languageNote\}\]/g) || []).length === 1,
    "…and the note is appended in exactly ONE place, so the record cannot drift from the call",
    `found ${(src.match(/\[LANGUAGE NOTE: \$\{languageNote\}\]/g) || []).length}`);
  chk(!/handleMessage\(phone, forBrain\b/.test(src),
    "…and nothing passes the bare client text as the handler input any more");
}

console.log(`\n${failed === 0 ? "voice-provenance-tests: ALL GREEN" : `voice-provenance-tests: ${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);

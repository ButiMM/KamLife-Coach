/**
 * VOICE PROVENANCE — focused tests (2026-09-10).
 *
 * A voice note becomes three different strings before any handler sees it:
 *
 *     Scribe/Whisper  →  cleanSATranscript  →  handlers      (the condenser was removed in Cut 3)
 *
 * Until this cut only the last one was persisted, as `input_text` on the inner ledger row. So the
 * two questions you must be able to answer about a bad voice turn had no evidence behind them:
 * did we MIS-HEAR the client, or did we hear them correctly and then delete half of what they
 * said? Different defects, different owners, different fixes.
 *
 * These tests drive the cleaner FOR REAL — real cleanSATranscript, real split, real fail-open
 * guards — against a stub OpenAI client, with OFFLINE_AI=0 so the offline killswitch does not
 * short-circuit the very code under test. Nothing here is simulated except the network boundary.
 *
 * The durable half (which columns, which row, what survives an early return) needs a database and
 * lives in script/pg-voice-provenance-acceptance.ts.
 */
process.env.OFFLINE_AI = "0";          // these stages are the subject; do not skip them
process.env.KAMLIFE_DB_STUB = "1";     // …but no database
process.env.OPENAI_API_KEY = "sk-stub";
process.env.NODE_ENV = "production";

import { readFileSync } from "node:fs";

const { cleanSATranscript } = await import("../server/understanding/sa-transcript");

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
console.log("\n2. THE CLEANER'S WINDOW NO LONGER DELETES WHAT IT COULD NOT SEE (Cut 3)");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS REPLACES, measured on 017efd9: a 2,408-character note was handed to the model
// 1,500 characters at a time and the answer came back AS the transcript — 908 characters deleted,
// the workout correction and both questions among them. §2 used to grade the condenser here; the
// condenser is gone (it could only exist by replacing the client's words), so this grades the
// stage that is still allowed to rewrite them.
{
  // A stub that echoes what it was handed, so the output reveals the window rather than hiding it.
  let handed = "";
  const echo = () => ({
    chat: { completions: { create: async (req: any) => {
      handed = req.messages[req.messages.length - 1].content;
      return { choices: [{ message: { content: handed } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    } } },
  } as any);

  const TAIL = "KNEECLICK7788";
  const long = ("I want to tell you about my whole week because a lot has happened and I need you "
    + "to have the full picture before you tell me what to do next about any of it. ").repeat(10)
    + "One last thing before I forget: " + TAIL + ".";
  chk(long.length > 1500, `the fixture is longer than the cleaner's window (${long.length} chars)`);

  const out = await cleanSATranscript(echo(), long, null);
  chk(handed.length <= 1500, "the model is still only sent one window", `handed ${handed.length}`);
  chk(handed.length < long.length, "…so the window is real and this fixture exercises it");
  chk(out.length === long.length, "nothing is deleted — what comes back is the whole note",
    `in ${long.length} out ${out.length}`);
  chk(out.includes(TAIL), "the last thing they said survives the cleaner");
  chk(out === long, "and an echoing clean reproduces the note exactly, head and tail rejoined");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n2b. THE SPLIT NEVER CUTS A WORD, AND THE TAIL REJOINS EXACTLY");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const { splitForClean } = await import("../server/understanding/sa-transcript");
  const short = "I had eggs and pap.";
  chk(splitForClean(short).head === short && splitForClean(short).tail === "",
    "a note inside the window is all head and no tail");

  const long = ("The taxi was late again this morning and I had to wait for the second one. ").repeat(40);
  const { head, tail } = splitForClean(long);
  chk(head + tail === long, "head + tail is byte-identical to the original");
  chk(head.length <= 1500, `the head fits the window (${head.length})`);
  chk(tail.length > 0, "and there is a real tail to carry");
  chk(!/\S$/.test(head) || /^\s/.test(tail) || head.endsWith("."),
    "the split lands on a boundary, not inside a word", JSON.stringify(head.slice(-12) + "|" + tail.slice(0, 12)));

  const nospace = "x".repeat(3000);
  const hard = splitForClean(nospace);
  chk(hard.head.length + hard.tail.length === nospace.length,
    "a note with no whitespace at all still loses nothing", `${hard.head.length}+${hard.tail.length}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n3. THE CLEANER STILL FAILS CLOSED ON A BAD REWRITE — NOW INCLUDING A SHORT ONE");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// §3 used to assert that transcriptMustPassWhole kept a multi-part note away from the condenser.
// That promise is no longer conditional on a guard: no note is condensed, because the condenser
// does not exist. What still needs grading is the cleaner's own floor — and the lower bound is
// NEW, because a reply cut off by max_tokens used to come back as the transcript, middle missing.
{
  const long = ("I want to tell you about my whole week because a lot has happened and I need you "
    + "to have the full picture before you tell me what to do next about any of it. ").repeat(10);

  const truncated = await cleanSATranscript(stubOpenAI("I want to tell you about my whole week"), long, null);
  chk(truncated === long, "a reply cut short keeps the RAW transcript rather than becoming it",
    `${truncated.length} vs ${long.length}`);

  const refused = await cleanSATranscript(stubOpenAI("I'm sorry, I can't help with that."), long, null);
  chk(refused === long, "a refusal on a long note keeps the whole note too");

  // A MULTI-PART NOTE, the shape transcriptMustPassWhole was written for. That predicate is gone
  // (nothing shortens a transcript, so it could only ever answer "no"); the promise it carried is
  // now the cleaner's arithmetic, which holds for this note and for the ones it never matched.
  const multiAsk = "What should I eat today? And also how many steps should I be doing? "
    + "And can you tell me what my weight is doing? ".repeat(30);
  const whole = await cleanSATranscript(stubOpenAI("I'm sorry, I can't help with that."), multiAsk, null);
  chk(whole === multiAsk, "a note asking more than one thing reaches the handlers whole",
    `${whole.length} vs ${multiAsk.length}`);
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

  chk(rawAt > 0, "media.ts records the raw transcript");
  chk(cleanAt > 0 && rawAt < cleanAt,
    "…BEFORE cleanSATranscript reassigns transcribedText", `raw@${rawAt} clean@${cleanAt}`);
  chk(cleanedAt > cleanAt, "the cleaned text is recorded after the cleaner ran", `cleaned@${cleanedAt}`);
  chk(forBrainAt > cleanedAt, "the for-brain text is recorded after the cleaned text",
    `forBrain@${forBrainAt} cleaned@${cleanedAt}`);
  // AND THE ROUTED TEXT IS THE CLEANED TRANSCRIPT ITSELF (Cut 3). The condenser used to sit here
  // and hand the handlers a shorter retelling; an assertion that it is gone is the only thing
  // that stops it being reintroduced as a "small" optimisation on a long note.
  chk(!/condenseVoiceRamble/.test(src), "media.ts no longer condenses anything before the handlers");
  chk(/const forBrain = transcribedText;/.test(src),
    "the handlers are routed the cleaned transcript, whole");
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

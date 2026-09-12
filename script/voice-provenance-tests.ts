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
const stubOpenAI = (reply: string, finish: string = "stop") => ({
  chat: { completions: { create: async () => ({
    choices: [{ message: { content: reply }, finish_reason: finish }],
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
      return { choices: [{ message: { content: handed }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
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
console.log("\n3b. A REPLY THAT DELETES PART OF THE HEAD IS REFUSED, FINISHED OR NOT");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE HOLE THIS CLOSES, demonstrated against the first version of this cut: a model reply carrying
// 60% of the head passed the 50% floor and the word-overlap check, and 588 characters vanished —
// a workout correction and a question among them. Preserving the tail is no defence when the model
// can delete the end of the HEAD.
//
// THE CORRECTION AND THE QUESTION LIVE INSIDE THE HEAD HERE, on purpose. A fixture that put them
// in the preserved tail would grade the rejoin, which already works, and would have passed while
// the defect was live.
{
  const HEAD_FACTS = "I must correct something, I said I trained on Tuesday but I missed it. "
    + "I had stamp and beans for lunch. "
    + "And what should I eat when I get home late after eight at night? ";
  const filler = "The taxi was late again this morning and the queue went around the corner. ";
  const head = filler.repeat(17) + HEAD_FACTS;          // both facts at the END of the head
  // TRIMMED AT CONSTRUCTION: cleanSATranscript trims its input before splitting, so a fixture
  // ending in whitespace can never round-trip byte-for-byte and the positive control below fails
  // by one character for a reason that has nothing to do with the guard it is checking.
  const note = (head + filler.repeat(4)).trim();        // and a tail beyond the window
  chk(note.length > 1500, `the fixture is longer than the window (${note.length} chars)`);
  // PROVEN, NOT ASSUMED: the correction and the question are inside the part that is SENT to the
  // model. If they had drifted into the preserved tail this section would grade the rejoin, which
  // already worked, and would have been green while the defect was live.
  {
    const { splitForClean } = await import("../server/understanding/sa-transcript");
    const split = splitForClean(note);
    chk(/i said i trained on tuesday/i.test(split.head) && /what should i eat/i.test(split.head),
      "both facts are inside the cleaner's head, not the preserved tail",
      `head ${split.head.length} tail ${split.tail.length}`);
    chk(split.tail.length > 0, "…and there is still a real tail", `tail ${split.tail.length}`);
  }

  const sixtyPercent = head.slice(0, Math.floor(head.length * 0.6));
  chk(!/i said i trained on tuesday/i.test(sixtyPercent) && !/what should i eat/i.test(sixtyPercent),
    "the 60% reply really does drop the correction and the question", `${sixtyPercent.length} chars`);

  for (const finish of ["length", "stop"]) {
    const out = await cleanSATranscript(stubOpenAI(sixtyPercent, finish), note, null);
    chk(out === note, `a 60%-length reply with finish_reason="${finish}" keeps the RAW transcript`,
      `in ${note.length} out ${out.length}`);
    chk(/i said i trained on tuesday but i missed it/i.test(out),
      `…so the workout correction survives (finish_reason="${finish}")`);
    chk(/what should i eat when i get home late/i.test(out),
      `…and so does the question (finish_reason="${finish}")`);
  }

  // ── THE EDIT CONTRACT ───────────────────────────────────────────────────────────────────
  // THE LENGTH FLOOR AND THE ENDING CHECK ARE GONE, and the fixtures that isolated them with them:
  // the ordered token contract subsumes both, so neither could fail on its own any more and a case
  // that cannot fail is a case that grades nothing.
  //
  // THIS IS THE CASE THAT BROKE THE PREVIOUS HEAD, reproduced exactly as it was reported: a reply
  // that is the head with ONE CLAUSE REMOVED FROM THE MIDDLE. 95.84% of the head, ending intact,
  // finish_reason "stop" — a length floor, an ending check and a 40% word-overlap test all accept
  // it, and the client's correction and question are gone.
  {
    const { splitForClean } = await import("../server/understanding/sa-transcript");
    const correction = "Actually I missed my Tuesday workout. What should I do today?";
    const rawNote =
      "I went to work and took the taxi like every other day. ".repeat(18)
      + correction + " "
      + "I came home and made tea and told you about my day. ".repeat(12)
      + " FINAL7788.";
    const { head: h, tail: t } = splitForClean(rawNote);
    chk(h.includes(correction), "the correction really is inside the cleaner's head",
      `raw ${rawNote.length} head ${h.length}`);
    chk(t.length > 0, "…and there is still a tail beyond it", `tail ${t.length}`);

    const middleDeleted = h.replace(correction, "");
    chk(middleDeleted.length / h.length > 0.9,
      "the reply keeps over 90% of the head — a length floor cannot see this",
      `${(100 * middleDeleted.length / h.length).toFixed(2)}%`);

    const out = await cleanSATranscript(stubOpenAI(middleDeleted, "stop"), rawNote, null);
    chk(out === rawNote, "a clause deleted from the MIDDLE keeps the WHOLE raw transcript",
      `in ${rawNote.length} out ${out.length}`);
    chk(/Actually I missed my Tuesday workout/.test(out), "…so the correction survives");
    chk(/What should I do today\?/.test(out), "…and so does the question");
    chk(/FINAL7788/.test(out), "…and the tail is still there");
  }

  // A NEGATION FLIPPED, AND A QUANTITY CHANGED. Neither alters the token COUNT, so only the
  // protected-token rule stands between the client and a record that says the opposite of what
  // they said. "missed" -> "finished" and 8500 -> 8000 are the two that cost them their history.
  {
    const spine = "On Tuesday I missed my session and I walked 8500 steps to the office. ";
    const note = "I want to tell you about my week and what happened on each day of it. ".repeat(14)
      + spine + "That is everything for now.";
    const flipped = note.replace("I missed my session", "I finished my session");
    const outFlip = await cleanSATranscript(stubOpenAI(flipped, "stop"), note, null);
    chk(outFlip === note, "a negation turned into its opposite keeps the raw transcript",
      `out ${outFlip.length}`);
    chk(/I missed my session/.test(outFlip), "…so the client still missed the session they missed");

    const renumbered = note.replace("8500", "8000");
    const outNum = await cleanSATranscript(stubOpenAI(renumbered, "stop"), note, null);
    chk(outNum === note, "a spoken quantity rewritten keeps the raw transcript", `out ${outNum.length}`);
    chk(/8500 steps/.test(outNum), "…so 8,500 is still 8,500");

    const reday = note.replace("On Tuesday", "On Thursday");
    const outDay = await cleanSATranscript(stubOpenAI(reday, "stop"), note, null);
    chk(outDay === note, "a named day rewritten keeps the raw transcript", `out ${outDay.length}`);
  }

  // AN INSERTION IS AS BAD AS A DELETION — words the client never said, in their own record.
  {
    const note = "I had pap and chicken and I walked to work this morning like always. ".repeat(24);
    const padded = note + " I also went to the gym twice this week.";
    const out = await cleanSATranscript(stubOpenAI(padded, "stop"), note, null);
    chk(out === note, "an invented sentence keeps the raw transcript", `out ${out.length}`);
    chk(!/went to the gym twice/.test(out), "…so nothing they did not say is in the record");
  }

  // ── THE TWO HOLES THE REVIEWER REPRODUCED IN THE EDIT CONTRACT ITSELF ───────────────────────
  // Both passed the ordered token contract as first written. Each is executed here exactly as it
  // was reported, through the real cleaner, and each must keep the client's raw words.
  //
  // (a) A NEAR-NEIGHBOUR OF A FOOD WORD IS NOT A SPELLING REPAIR. Membership-plus-edit-distance
  //     approved any word within three edits of any listed SA word, so a client reporting pain or
  //     low mood had it replaced with a food word and nothing downstream could tell.
  {
    const filler = "and then I took the taxi to work like every other morning of this week. ";
    for (const [said, invented, what] of [
      ["I have pain in my knee since Saturday. ", "I have pap in my knee since Saturday. ", "pain"],
      ["I am sad about how this month went. ", "I am pap about how this month went. ", "low mood"],
      ["I ate porridge before I left the house. ", "I ate pap before I left the house. ", "an unvetted food swap"],
    ]) {
      const note = (said + filler.repeat(12)).trim();
      const reply = (invented + filler.repeat(12)).trim();
      chk(reply !== note, `the ${what} fixture really does differ from what was said`);
      const out = await cleanSATranscript(stubOpenAI(reply, "stop"), note, null);
      chk(out === note, `${what}: an unvetted substitution keeps the RAW transcript`,
        `out ${out.length} of ${note.length}`);
      chk(out.startsWith(said.trim().slice(0, 20)),
        `…so the client's own words open the record, not the model's guess`,
        JSON.stringify(out.slice(0, 40)));
    }
  }

  // (b) THE SIGN AND THE DECIMAL POINT CARRY MEANING. The first tokenizer stripped both, so "-5"
  //     and "5" compared equal — five kilograms lost read back as five kilograms gained — and
  //     "8.5" was indistinguishable from "85" and from "8,500".
  {
    const filler = "and I am telling you everything that happened so you have the full picture. ";
    for (const [said, rewritten, what] of [
      ["My change was -5 kg this month. ", "My change was 5 kg this month. ", "a stripped minus sign"],
      ["My change was −5 kg this month. ", "My change was 5 kg this month. ", "a stripped unicode minus"],
      ["I am 8.5 kg down since January. ", "I am 85 kg down since January. ", "a lost decimal point"],
      ["I am 8.5 kg down since January. ", "I am 8,500 kg down since January. ", "a regrouped quantity"],
    ]) {
      const note = (said + filler.repeat(12)).trim();
      const reply = (rewritten + filler.repeat(12)).trim();
      const out = await cleanSATranscript(stubOpenAI(reply, "stop"), note, null);
      chk(out === note, `${what}: the quantity is protected and the RAW transcript is kept`,
        `out ${JSON.stringify(out.slice(0, 34))}`);
    }
    // AND THE SAME NUMBER UNCHANGED IS STILL ACCEPTED — without this the four checks above are
    // satisfied by a tokenizer that refuses every note containing a decimal.
    const kept = ("I am 8.5 kg down since January. " + filler.repeat(12)).trim();
    const repunct = kept.replace("I am 8.5 kg down since January.", "I am 8.5 kg down since January!");
    const outKept = await cleanSATranscript(stubOpenAI(repunct, "stop"), kept, null);
    chk(outKept === repunct, "a decimal left alone still lets a punctuation repair through",
      JSON.stringify(outKept.slice(0, 40)));
  }

  // (c) NON-ASCII LEXICAL CONTENT IS NOT SILENTLY DISCARDED. The first tokenizer was ASCII-only,
  //     so a token made of non-Latin letters produced NO tokens at all: it contributed nothing to
  //     either side of the comparison, and a reply that added or removed one had an identical
  //     token count and was accepted. Multilingual STT does emit non-Latin script on unclear
  //     audio, and whatever it emits is the client's record until a person says otherwise.
  //
  //     THIS IS A PROPERTY FIXTURE, not a typical note — it is built to isolate the blind spot,
  //     and the superseded tokenizer is reproduced below to prove the fixture is not vacuous.
  {
    const filler = "and after that I went to work and the day was long and hot. ";
    // The ONLY difference between these two is the non-ASCII token. Removing a neighbouring
    // ASCII word along with it would make the deletion visible for the wrong reason.
    const spoken = "I made umngqusho and здоровье beans for the family. ";
    const dropped = "I made umngqusho and beans for the family. ";
    const note = (spoken + filler.repeat(12)).trim();
    const reply = (dropped + filler.repeat(12)).trim();

    // THE SUPERSEDED TOKENIZER, verbatim, purely as evidence that this deletion WAS invisible.
    // It is a local control: nothing under test reads it.
    const asciiOnly = (s: string) => (s.toLowerCase().match(/[a-z0-9']+/g) || []).map(t => t.replace(/'/g, ""));
    chk(JSON.stringify(asciiOnly(note)) === JSON.stringify(asciiOnly(reply)),
      "CONTROL: under the ASCII-only tokenizer the deleted word leaves NO trace at all",
      `${asciiOnly(note).length} vs ${asciiOnly(reply).length} tokens`);

    const out = await cleanSATranscript(stubOpenAI(reply, "stop"), note, null);
    chk(out === note, "a deleted non-ASCII word keeps the RAW transcript", `out ${out.length}`);
    chk(/здоровье/.test(out), "…so the word the client actually spoke is still in their record");

    // AND THE INSERTION DIRECTION, which is the same blind spot pointed the other way: a word the
    // client never said, appearing in their own record for free.
    const outIns = await cleanSATranscript(stubOpenAI(note, "stop"), reply, null);
    chk(outIns === reply, "an invented non-ASCII word keeps the RAW transcript", `out ${outIns.length}`);
    chk(!/здоровье/.test(outIns), "…so nothing they did not say was added");

    // …AND A NON-ASCII NOTE THAT IS NOT CHANGED STILL PASSES. A tokenizer that simply refused
    // everything containing non-ASCII text would satisfy the checks above and break the stage.
    const okReply = note.replace("I made umngqusho", "I made umngqusho,");
    const outOk = await cleanSATranscript(stubOpenAI(okReply, "stop"), note, null);
    chk(outOk === okReply, "an untouched non-ASCII note still accepts a punctuation repair",
      JSON.stringify(outOk.slice(0, 40)));
  }

  // AND THE REPAIRS THE CLEANER EXISTS FOR STILL LAND. Without these the contract is satisfied by
  // a cleaner that refuses everything, which deletes the whole point of the stage.
  {
    const rawSamp = "Yoh I had stamp and beans and chicken for lunch today neh and it was lekker";
    const fixed = rawSamp.replace("stamp", "samp");
    const cleanedSamp = await cleanSATranscript(stubOpenAI(fixed, "stop"), rawSamp, null);
    chk(cleanedSamp === fixed, "stamp -> samp is accepted, as it must be", JSON.stringify(cleanedSamp));

    const punctOnly = "yoh i had samp and beans for lunch today";
    const repunctuated = "Yoh, I had samp and beans for lunch today.";
    const outPunct = await cleanSATranscript(stubOpenAI(repunctuated, "stop"), punctOnly, null);
    chk(outPunct === repunctuated, "case, spacing and punctuation are free", JSON.stringify(outPunct));

    const already = "I had samp and beans and chicken for lunch today and it was lekker neh";
    const outSame = await cleanSATranscript(stubOpenAI(already, "stop"), already, null);
    chk(outSame === already, "an unchanged transcript passes through untouched");
  }

  // A COMPLETE reply that reaches the end of the head is still accepted — without this the section
  // is satisfied by a cleaner that refuses everything, which is the opposite defect.
  //
  // THE REPLY IS THE HEAD THE SPLITTER ACTUALLY SENDS, not my own guess at it: the split lands on
  // a sentence boundary, so echoing `head` verbatim came back one character short and failed this
  // check for a reason that had nothing to do with the guard.
  const { splitForClean: splitAgain } = await import("../server/understanding/sa-transcript");
  const properClean = splitAgain(note).head;
  const good = await cleanSATranscript(stubOpenAI(properClean, "stop"), note, null);
  chk(good === note, "a complete, faithful clean of the head is accepted and rejoined",
    `in ${note.length} out ${good.length}`);

  // FINISH_REASON IS STILL ITS OWN GATE — an otherwise perfect repair the model did not finish.
  // The reply carries a visible repair so acceptance and refusal are distinguishable; identical
  // text would produce the same string either way and the check would pass with the gate deleted.
  const repaired = properClean.replace("stamp", "samp");
  chk(repaired !== properClean, "the finish_reason fixture carries a visible repair");
  const unfinished = await cleanSATranscript(stubOpenAI(repaired, "length"), note, null);
  chk(unfinished === note && /stamp and beans/.test(unfinished) && !/samp and beans/.test(unfinished),
    "FINISH_REASON alone: a reply that looks complete but reports length is refused",
    `out ${unfinished.length}`);
  const finished = await cleanSATranscript(stubOpenAI(repaired, "stop"), note, null);
  chk(/samp and beans/.test(finished) && finished.endsWith(splitAgain(note).tail),
    "…while the identical reply with finish_reason=stop is accepted, repair and tail both",
    `out ${finished.length} of ${note.length}`);
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

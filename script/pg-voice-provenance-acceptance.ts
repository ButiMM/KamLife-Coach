/**
 * REAL-POSTGRESQL ACCEPTANCE — the words the client actually spoke are durable (2026-09-10).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS TRUE BEFORE THIS CUT, verified on 9124647 before a line of it was written.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A voice note becomes three different strings before any handler sees it:
 *
 *     Scribe/Whisper  →  cleanSATranscript  →  handlers      (the condenser was removed in Cut 3)
 *
 * `turn_ledger.input_text` on the inner row held the LAST of those. The client's own words existed
 * only in a `[VOICE] scribe_ok text="…"` log line. So for any bad voice turn, the first question —
 * did we mis-hear them, or did we hear them and then delete half of it? — had no durable evidence
 * behind it at all. One is an STT problem, the other is ours.
 *
 * A probe of the nested voice shape on that SHA also showed which row carries what:
 *     [0] input_type=text  … delivered_body=""      ← the inner turn
 *     [1] input_type=voice … delivered_body="Voice — one thing today: …"  outcome=shadow
 * The OUTER voice row is the one the transport finalises, so it is the row the three texts must
 * land on for a single row to answer the whole question.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS GRADES, AND THE ONE THING IT CANNOT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * GRADED, for real: the recorder's merge semantics, the derived provenance flags, which row the
 * texts land on, that they survive an early return, and that the row also carries the decision,
 * the final post-transport body and the build SHA — read back out of PostgreSQL after the
 * transport has run.
 *
 * NOT GRADED HERE, stated plainly rather than implied: the audio download and the STT call in
 * media.ts cannot be executed offline. assertSafeMediaUrl requires an https URL on an allow-listed
 * PUBLIC host — it is an SSRF guard, and weakening it to make a test pass would be a far worse
 * trade than saying so — and the transcription itself needs the network. The wiring inside
 * media.ts is therefore covered by the source-ORDER assertions in script/voice-provenance-tests.ts
 * §4 (raw must be captured before the cleaner reassigns the variable), and by the red-on-revert
 * script, which reverts each media.ts call site individually.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-voice-provenance-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
const { inTurn, recordTurn, turnUser, turnVoice, finaliseInteraction, _resetInteractionCorrelation } =
  await import("../server/handlers/chat-log");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

const phone = "whatsapp:+27820000961";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Nomsa Voice", onboardingState: "COMPLETE", popiConsent: true,
  subscriptionStatus: "active", goalType: "fat_loss", currentWeight: "92", startWeight: "95",
  targetWeight: "85", heightCm: 178, age: 34, gender: "female", trainingMode: "gym",
  proteinTarget: 150, dailyCalorieTarget: 2200, dailyStepTarget: 8000,
} as any).returning();

type Row = {
  input_type: string | null; input_text: string | null; root_id: string | null;
  voice_transcript_raw: string | null; voice_transcript_cleaned: string | null;
  voice_text_for_brain: string | null; voice_provenance: any;
  decision: any; delivered_body: string | null; delivery_outcome: string | null;
  version: string | null;
};
const rows = async (): Promise<Row[]> => (await pool.query<Row>(
  `SELECT input_type, input_text, root_id, voice_transcript_raw, voice_transcript_cleaned,
          voice_text_for_brain, voice_provenance, decision, delivered_body, delivery_outcome, version
     FROM turn_ledger WHERE user_id = $1 ORDER BY created_at, id`, [user.id])).rows;
const clear = async () => {
  await pool.query("DELETE FROM turn_ledger WHERE user_id = $1", [user.id]);
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  _resetInteractionCorrelation();
  _resetOutboundDedupe();
};
const settle = () => new Promise(r => setTimeout(r, 700));

/**
 * The exact shape handlers/media.ts performs for a voice note: the OUTER turn is opened by
 * handleMessage for the audio, the three stages are recorded onto it as they are produced, and the
 * for-brain text then RE-ENTERS handleMessage, opening the inner turn. Then the transport
 * finalises the interaction, as routes/whatsapp.processVoiceAsync does.
 */
async function voiceTurn(opts: {
  rootId: string; raw: string; cleaned?: string; forBrain?: string;
  engine?: "scribe" | "whisper"; earlyReturn?: string; languageNote?: string;
}): Promise<string> {
  const reply = await inTurn("voice", "", async () => {
    turnUser(user.id);
    const wordCount = opts.raw.split(/\s+/).filter(Boolean).length;
    turnVoice({ engine: opts.engine ?? "whisper", raw: opts.raw, wordCount });
    if (opts.earlyReturn) {
      // The garble / single-word / refusal branches RETURN from media.ts, and that return
      // propagates through routeMessage to handleMessage's wrapper — which records the turn on
      // every path. Recording only on the happy path here would be a fixture that cannot see the
      // very case this section exists for.
      void recordTurn(opts.earlyReturn);
      return opts.earlyReturn;
    }
    turnVoice({ cleaned: opts.cleaned ?? opts.raw });
    // media.ts composes the handler input ONCE and records the same variable it passes. Mirrored
    // here exactly, including the append, so the reconstruction check below is grading the
    // contract rather than a string this harness happened to build twice.
    const base = opts.forBrain ?? opts.cleaned ?? opts.raw;
    const brainInput = base + (opts.languageNote ? `\n\n[LANGUAGE NOTE: ${opts.languageNote}]` : "");
    turnVoice({ forBrain: base, handlerInput: brainInput, languageNote: opts.languageNote || null });
    const inner = await handleMessage(
      phone, brainInput, undefined, undefined, undefined, opts.rootId);
    void recordTurn(inner);
    return inner;
  }, opts.rootId);
  await finaliseInteraction(opts.rootId, {
    deliveredBody: reply, outboundVerdict: { blocked: false }, deliveryOutcome: "shadow",
  });
  return reply;
}

REAL("\npg-voice-provenance-acceptance — the client's own words are durable\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("1. ALL THREE STAGES SURVIVE, SEPARATELY, ON ONE ROW");
// ══════════════════════════════════════════════════════════════════════════════════════════════
await clear();
{
  const RAW = "Yoh I had stamp and beans for lunch and I walked to the shops";
  const CLEAN = "Yoh I had samp and beans for lunch and I walked to the shops";
  const BRAIN = "I had samp and beans for lunch. I walked to the shops.";
  await voiceTurn({ rootId: "sid-voice-a", raw: RAW, cleaned: CLEAN, forBrain: BRAIN, engine: "scribe" });
  await settle();
  const r = await rows();
  const voice = r.find(x => x.input_type === "voice");
  chk(!!voice, "the voice turn left a row");
  chk(voice?.voice_transcript_raw === RAW,
    "the RAW transcript is stored exactly as the STT returned it — 'stamp', the mishear",
    JSON.stringify(voice?.voice_transcript_raw));
  chk(voice?.voice_transcript_cleaned === CLEAN,
    "the CLEANED text is stored separately — 'samp', the repair", JSON.stringify(voice?.voice_transcript_cleaned));
  chk(voice?.voice_text_for_brain === BRAIN,
    "the FOR-BRAIN text is stored separately — what the handlers routed on",
    JSON.stringify(voice?.voice_text_for_brain));
  chk(voice?.voice_transcript_raw !== voice?.voice_transcript_cleaned
      && voice?.voice_transcript_cleaned !== voice?.voice_text_for_brain,
    "…and all three genuinely differ, so the diff that IS the diagnosis is possible");
  chk(voice?.voice_provenance?.engine === "scribe", "the STT that produced the raw text is named",
    JSON.stringify(voice?.voice_provenance));
  chk(voice?.voice_provenance?.cleaned === true && voice?.voice_provenance?.condensed === true,
    "…and both stages are recorded as having CHANGED the text", JSON.stringify(voice?.voice_provenance));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. THE SAME ROW CARRIES THE DECISION, THE FINAL OUTBOUND BODY AND THE BUILD SHA");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const r = await rows();
  const voice = r.find(x => x.input_type === "voice");
  chk(!!voice?.delivered_body, "the row carries the final post-transport body",
    JSON.stringify((voice?.delivered_body || "").slice(0, 70)));
  chk(voice?.delivery_outcome === "shadow", "…and the delivery outcome", `got ${voice?.delivery_outcome}`);
  chk(!!voice?.version, "…and the build SHA", `got ${voice?.version}`);
  chk(voice?.decision !== null && typeof voice?.decision === "object",
    "…and the decision object written by the existing owner", JSON.stringify(voice?.decision));
  chk(!!voice?.voice_transcript_raw,
    "…on the SAME row as the raw transcript, so one row answers the whole question");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. ONE VOICE NOTE IS STILL ONE INTERACTION");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const r = await rows();
  chk(r.length === 2, "the nested voice turn produces two rows (the recursion is not this cut)",
    `rows=${r.length}`);
  chk(r.every(x => x.root_id === "sid-voice-a"), "…both under one root id",
    JSON.stringify(r.map(x => x.root_id)));
  const inner = r.find(x => x.input_type === "text");
  chk(inner?.voice_transcript_raw == null,
    "the INNER row carries no transcript — the voice provenance has exactly one home",
    JSON.stringify(inner?.voice_transcript_raw));
  chk(inner?.input_text === "I had samp and beans for lunch. I walked to the shops.",
    "…and the inner row still shows the condensed text it was actually given, unchanged by this cut",
    JSON.stringify(inner?.input_text));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n4. A STAGE THAT RAN AND DECLINED IS NOT A STAGE THAT NEVER RAN");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Both model stages fail open and return their input unchanged — proven against the real
// functions in script/voice-provenance-tests.ts §1–2. So `cleaned === raw` is the ORDINARY case on
// a healthy turn, and the flags record whether the stage CHANGED the text rather than whether it
// ran. A column that conflated those two would be unreadable in exactly the situation it exists
// for.
await clear();
{
  const RAW = "I had eggs and toast this morning";
  await voiceTurn({ rootId: "sid-voice-b", raw: RAW });   // cleaner and condenser both declined
  await settle();
  const voice = (await rows()).find(x => x.input_type === "voice");
  chk(voice?.voice_transcript_raw === RAW && voice?.voice_transcript_cleaned === RAW
      && voice?.voice_text_for_brain === RAW,
    "an untouched note stores the same text at all three stages");
  chk(voice?.voice_provenance?.cleaned === false && voice?.voice_provenance?.condensed === false,
    "…and both flags say NOT CHANGED, rather than the columns being absent",
    JSON.stringify(voice?.voice_provenance));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n5. A FAILED VOICE TURN STILL RECORDS WHAT WE HEARD");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The garble guard, the single-word guard and the refusal floor all RETURN before the cleaner or
// the condenser run. Those are the turns where "what did we actually hear?" matters most, and
// recording only at the end of the happy path would have left every one of them blank — which is
// the state this cut is fixing, reproduced one layer in.
await clear();
{
  const GARBLE = "shombolo weh weh ka ka ka";
  await voiceTurn({
    rootId: "sid-voice-c", raw: GARBLE, engine: "whisper",
    earlyReturn: "I caught some of that, but not clearly enough to be sure I understood you right.",
  });
  await settle();
  const voice = (await rows()).find(x => x.input_type === "voice");
  chk(voice?.voice_transcript_raw === GARBLE,
    "a turn that returned early still stores the raw transcript", JSON.stringify(voice?.voice_transcript_raw));
  chk(voice?.voice_transcript_cleaned == null && voice?.voice_text_for_brain == null,
    "…and stores nothing for the stages that never ran",
    JSON.stringify([voice?.voice_transcript_cleaned, voice?.voice_text_for_brain]));
  chk(voice?.voice_provenance?.cleaned === null && voice?.voice_provenance?.condensed === null,
    "…with NULL flags, which is distinguishable from the `false` of section 4",
    JSON.stringify(voice?.voice_provenance));
  chk(/not clearly enough/.test(voice?.delivered_body || ""),
    "…beside the refusal the client actually received", JSON.stringify((voice?.delivered_body || "").slice(0, 60)));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n6. CONTROL — A TEXT TURN CARRIES NO VOICE PROVENANCE AT ALL");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Without this, every check above would still pass if the recorder wrote the columns on every
// turn from some other source, and the columns would mean nothing.
await clear();
{
  const { processTextAsync } = await import("../server/routes/whatsapp");
  await processTextAsync(phone, "I walked 9000 steps", null, null, [], handleMessage as any, "sid-text-a");
  await settle();
  const r = await rows();
  chk(r.length === 1 && r[0].input_type === "text", "the text turn left one row", `rows=${r.length}`);
  chk(r[0]?.voice_transcript_raw == null && r[0]?.voice_transcript_cleaned == null
      && r[0]?.voice_text_for_brain == null && r[0]?.voice_provenance == null,
    "…and every voice column is null on it",
    JSON.stringify([r[0]?.voice_transcript_raw, r[0]?.voice_provenance]));
  chk(!!r[0]?.delivered_body,
    "…while the Cut 1 columns still work on a text turn, untouched by this cut");
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n7. THE EXACT HANDLER INPUT CAN BE RECONSTRUCTED FROM THE ROW");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS EXISTS FOR, found in the first version of THIS cut and corrected the same day.
//
// media.ts does not call handleMessage with `forBrain`. It calls it with
// `forBrain + "\n\n[LANGUAGE NOTE: …]"` whenever the transcript looks like a non-English SA
// language. The column was nevertheless documented as "what the handlers routed on" — a column
// holding something other than its label, which is exactly what revert case 2 of this cut's own
// red-on-revert exists to catch one stage earlier.
//
// The contract now: `voice_text_for_brain` is CLIENT-ORIGIN text and nothing else, the note we
// appended ourselves is recorded beside it, and the exact argument is stored verbatim. All three
// so the append is reversible in both directions — you can rebuild the call from the client's
// words, and you can strip our sentence back off the call.
await clear();
{
  const CLEAN = "Ngidle ipapa nenyama namuhla ekuseni";
  const NOTE = "The client is speaking Zulu";
  await voiceTurn({ rootId: "sid-voice-d", raw: CLEAN, languageNote: NOTE });
  await settle();
  const r = await rows();
  const voice = r.find(x => x.input_type === "voice");
  const inner = r.find(x => x.input_type === "text");
  const expected = `${CLEAN}\n\n[LANGUAGE NOTE: ${NOTE}]`;

  chk(voice?.voice_provenance?.handlerInput === expected,
    "the row stores the EXACT string handleMessage was called with",
    JSON.stringify(voice?.voice_provenance?.handlerInput));
  chk(voice?.voice_text_for_brain === CLEAN,
    "…while voice_text_for_brain stays client-origin, with no note in it",
    JSON.stringify(voice?.voice_text_for_brain));
  chk(voice?.voice_provenance?.languageNote === NOTE,
    "…and the note we appended is recorded separately", JSON.stringify(voice?.voice_provenance?.languageNote));

  // RECONSTRUCTION, both directions — this is the actual claim.
  const rebuilt = String(voice?.voice_text_for_brain)
    + (voice?.voice_provenance?.languageNote ? `\n\n[LANGUAGE NOTE: ${voice.voice_provenance.languageNote}]` : "");
  chk(rebuilt === voice?.voice_provenance?.handlerInput,
    "the handler input rebuilds exactly from the client text plus the recorded note", JSON.stringify(rebuilt));
  chk(String(voice?.voice_provenance?.handlerInput || "").startsWith(String(voice?.voice_text_for_brain))
      && !String(voice?.voice_text_for_brain).includes("[LANGUAGE NOTE:"),
    "…and our sentence strips back off it, leaving only what the client said");

  // The independent witness: the inner row's input_text IS what handleMessage received, written by
  // a different owner (inTurn) on a different row. If these disagree, the provenance is fiction.
  chk(inner?.input_text === expected,
    "the inner row — written by inTurn, not by this cut — shows the same exact input",
    JSON.stringify(inner?.input_text));

  // …and the flag that the correction turns on: `condensed` is computed from the BASE text, so a
  // language note must not masquerade as the condenser having rewritten the client.
  chk(voice?.voice_provenance?.condensed === false,
    "a language note does NOT read as a condense — the flag is computed from the client's text",
    JSON.stringify(voice?.voice_provenance));
}

REAL(`\n${failed === 0 ? "pg-voice-provenance-acceptance: ALL GREEN" : `pg-voice-provenance-acceptance: ${failed} FAILED`}`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

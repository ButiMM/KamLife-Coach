/**
 * REAL-POSTGRESQL ACCEPTANCE — a transcript that fails the admission floor writes nothing
 * durable, and one that passes it writes everything (Cut 4, 2026-09-12).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS TRUE BEFORE THIS CUT, reproduced on f809456 before a line of it was written
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The garble floor in media.ts read:
 *
 *     if (voiceQuality && wordCount >= 2 && (avgLogprob < -1.0 || comp > 2.5))
 *
 * and `voiceQuality` is populated ONLY by Whisper attempt 1, the one call that asks for
 * `response_format: "verbose_json"`. Scribe — which runs FIRST whenever ELEVENLABS_API_KEY is set,
 * so it is the production path — the catch retry, and the forced-English retry all leave it null.
 * `voiceQuality &&` then SKIPS the floor rather than meeting a weaker one.
 *
 * Driven through the real branch on that SHA, sixteen consecutive "you" reached handleMessage and
 * came back to the client as «🎤 I heard: "you you you…"». The floor was not failing. It was not
 * running.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS GRADES, AND HOW HONESTLY
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * STUB-DRIVEN EXECUTION of the real voice branch against a REAL database. The audio download and
 * the two STT clients are stubs; everything else — the SSRF guard, the length caps, the word-count
 * guard, the admission floor, the cleaner, the refusal floor, the handler recursion and every
 * durable writer behind it — is the shipped code running against PostgreSQL.
 *
 * THIS SAYS NOTHING ABOUT TRANSCRIPTION ACCURACY. It grades which STRINGS are admitted and what
 * they do to the database. No claim here rests on real-world WER, and none is made.
 *
 * A CORRECTION TO A STANDING NOTE, recorded rather than quietly fixed: both
 * script/pg-voice-provenance-acceptance.ts and script/pg-long-voice-tail-acceptance.ts say the
 * voice branch "cannot be executed offline" because assertSafeMediaUrl demands an https URL on an
 * allow-listed PUBLIC host. That was true of the fixtures those cuts had, and it is not a property
 * of the code: MEDIA_URL_ALLOWLIST extends the allow-list by configuration, and a public host that
 * really resolves satisfies the guard without weakening it by one line. The SSRF guard runs here,
 * unmodified, and passes. Those two files' own subjects are unaffected, so they are left alone.
 */
if (!process.env.DATABASE_URL) {
  console.log("pg-stt-admission-acceptance: SKIPPED — no DATABASE_URL. This proof needs a real database.");
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
// The SSRF guard is NOT bypassed. This adds one public host to the allow-list it already supports,
// and the fetch to it is stubbed so no audio is actually retrieved from anywhere.
process.env.MEDIA_URL_ALLOWLIST = "example.com";

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { handleMediaMessage, clearVoiceFailure } = await import("../server/handlers/media");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  REAL(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

// ── THE NETWORK BOUNDARY, AND ONLY THE NETWORK BOUNDARY ──────────────────────────────────────
const AUDIO_URL = "https://www.example.com/voice.ogg";
const audioBytes = new Uint8Array(40_000).fill(7);

// ATTEMPTS ARE COUNTED, NOT INFERRED FROM THE REQUEST SHAPE. All three Whisper calls now ask for
// verbose_json, so a stub keyed on `response_format` would answer every one as attempt 1 and stop
// testing the retries. And the CALL ORDER is not the attempt number: media.ts runs attempt 2 only
// when attempt 1 THROWS, so an attempt 1 that returns empty makes the forced-English retry the
// SECOND call. `turns()` builds the order media.ts will really produce.
type WhisperTurn = { throws?: boolean; text?: string; segments?: any[] };
let scribeReply: string | { text: string; words?: Array<{ logprob?: number }>; language_probability?: number } | null = null;
let whisperTurns: WhisperTurn[] = [];
let whisperCalls = 0;

const turns = (spec: { a1?: WhisperTurn; a2?: WhisperTurn; a3?: WhisperTurn }): WhisperTurn[] => {
  const seq: WhisperTurn[] = [spec.a1 ?? {}];
  if (spec.a1?.throws) seq.push(spec.a2 ?? {});
  if (spec.a3) seq.push(spec.a3);
  return seq;
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url?.url || url);
  if (u.startsWith(AUDIO_URL)) {
    return new Response(audioBytes, { status: 200, headers: { "content-type": "audio/ogg" } });
  }
  if (u.includes("/speech-to-text")) {
    if (scribeReply === null) return new Response("stub: scribe not configured for this case", { status: 500 });
    const body = typeof scribeReply === "string" ? { text: scribeReply } : scribeReply;
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(url, init);
}) as any;

const sttStub: any = {
  audio: { transcriptions: { create: async (opts: any) => {
    // Consume the read stream media.ts opened; left alone it emits an async 'error' once the tmp
    // file is cleaned up. An artifact of stubbing, not of the code under test.
    try { opts.file?.on?.("error", () => {}); opts.file?.destroy?.(); } catch { /* not a stream */ }
    const turn = whisperTurns[whisperCalls] || {};
    whisperCalls++;
    if (turn.throws) throw new Error(`stubbed whisper attempt-${whisperCalls} failure`);
    return { text: turn.text ?? "", segments: turn.segments || [] };
  } } },
  chat: { completions: { create: async () => ({
    choices: [{ message: { content: "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }) } },
};

const phone = "whatsapp:+27820000988";
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
const [user] = await db.insert(schema.users).values({
  phoneNumber: phone, name: "Lerato Admission", onboardingState: "COMPLETE", popiConsent: true,
  popiConsentAt: new Date(), subscriptionStatus: "active", goalType: "fat_loss",
  currentWeight: "88", startWeight: "92", targetWeight: "80", heightCm: 165, age: 31,
}).returning();

const GARBLE = "you you you you you you you you you you you you you you you you";
const GOOD = "I had samp and beans for lunch and I walked 8500 steps today neh";

const GOOD_SEGS = [{ avg_logprob: -0.2, compression_ratio: 1.4 }];
const BAD_SEGS = [{ avg_logprob: -1.8, compression_ratio: 4.0 }];

let reachedHandlers: string | null = null;
async function drive(): Promise<string> {
  clearVoiceFailure(user.id);
  whisperCalls = 0;
  reachedHandlers = null;
  return String(await handleMediaMessage({
    phone, message: "", mediaUrl: AUDIO_URL, mediaContentType: "audio/ogg",
    allMediaUrls: [], user: { ...user }, isCoach: false, openai: sttStub,
    handleMessage: async (p: string, text: string) => {
      reachedHandlers = text;
      return await handleMessage(p, text);      // the REAL handlers, and the real durable writers
    },
  } as any));
}

async function factCounts(): Promise<{ meals: number; steps: number }> {
  const meals = await pool.query("SELECT COUNT(*)::int AS n FROM meal_logs WHERE user_id = $1", [user.id]);
  const steps = await pool.query("SELECT COUNT(*)::int AS n FROM step_logs WHERE user_id = $1", [user.id]);
  return { meals: meals.rows[0].n, steps: steps.rows[0].n };
}

REAL("\npg-stt-admission-acceptance\n");

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("1. A REFUSED TRANSCRIPT WRITES NO FACTS — ON EVERY PROVIDER PATH");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Each path is configured the way production reaches it. The count is read out of PostgreSQL
// after the turn, not inferred from a return value.
const whisperOnly = () => { delete process.env.ELEVENLABS_API_KEY; scribeReply = null; };
const PATHS: Array<[string, () => void]> = [
  ["SCRIBE (first when ELEVENLABS_API_KEY is set — the production path)", () => {
    process.env.ELEVENLABS_API_KEY = "stub"; scribeReply = GARBLE; whisperTurns = [];
  }],
  ["WHISPER attempt 2, the catch retry", () => {
    whisperOnly(); whisperTurns = turns({ a1: { throws: true }, a2: { text: GARBLE, segments: GOOD_SEGS } });
  }],
  ["WHISPER attempt 3, the FORCED-ENGLISH retry", () => {
    whisperOnly(); whisperTurns = turns({ a1: { text: "", segments: [] }, a3: { text: GARBLE, segments: GOOD_SEGS } });
  }],
  ["WHISPER attempt 1, the only path that ever reported metrics", () => {
    whisperOnly(); whisperTurns = turns({ a1: { text: GARBLE, segments: BAD_SEGS } });
  }],
  ["AN EXPLICIT NO-SPEECH MARKER, repeated", () => {
    whisperOnly(); whisperTurns = turns({ a1: { text: "[BLANK_AUDIO] [BLANK_AUDIO] [BLANK_AUDIO]", segments: GOOD_SEGS } });
  }],
  ["A PLAUSIBLE-LOOKING transcript Whisper itself scored as garbage, on the forced-English retry", () => {
    whisperOnly();
    whisperTurns = turns({
      a1: { text: "", segments: [] },
      a3: { text: "I hid the samp and beans for lunch and worked 8500 shops today", segments: BAD_SEGS },
    });
  }],
];

for (const [label, setup] of PATHS) {
  setup();
  const reply = await drive();
  const { meals, steps } = await factCounts();
  chk(reachedHandlers === null, `${label}: the garble never reaches the handlers`,
    `handlers got ${JSON.stringify(String(reachedHandlers ?? "").slice(0, 60))}`);
  chk(meals === 0 && steps === 0, `…and NOTHING durable is written`, `meals=${meals} steps=${steps}`);
  chk(!/🎤 I heard/.test(reply), `…and the client is not told we heard it`, JSON.stringify(reply.slice(0, 60)));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2. THE OPPOSITE DEFECT — A REAL TRANSCRIPT STILL WRITES ITS FACTS");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// Twelve green checks above are also what a floor that refuses EVERY voice note would produce.
// This is the half that makes them mean something, and it is graded on stored rows.
{
  await pool.query("DELETE FROM meal_logs WHERE user_id = $1", [user.id]);
  await pool.query("DELETE FROM step_logs WHERE user_id = $1", [user.id]);
  whisperOnly();
  whisperTurns = turns({ a1: { text: GOOD, segments: GOOD_SEGS } });

  const reply = await drive();
  chk(typeof reachedHandlers === "string" && /samp and beans/.test(reachedHandlers!),
    "a real SA transcript reaches the handlers",
    `handlers got ${JSON.stringify(String(reachedHandlers ?? "NOTHING").slice(0, 60))}`);
  chk(/🎤 I heard/.test(reply), "…and the client is told what we heard", JSON.stringify(reply.slice(0, 60)));

  const { meals, steps } = await factCounts();
  chk(meals >= 1, "…and the meal they named is STORED", `meals=${meals}`);
  chk(steps >= 1, "…and so are the steps they walked", `steps=${steps}`);

  const stored = await pool.query(
    "SELECT raw_message FROM meal_logs WHERE user_id = $1 ORDER BY logged_at DESC LIMIT 1", [user.id]);
  chk(stored.rows.length >= 1 && /samp/i.test(stored.rows[0].raw_message || ""),
    "…and the stored row holds the SA food word, not a mishearing of it",
    JSON.stringify(stored.rows[0]?.raw_message?.slice(0, 60)));

  const storedSteps = await pool.query(
    "SELECT steps FROM step_logs WHERE user_id = $1 ORDER BY logged_at DESC LIMIT 1", [user.id]);
  chk(storedSteps.rows.length >= 1 && Number(storedSteps.rows[0].steps) === 8500,
    "…and the number stored is the number they said", `steps=${storedSteps.rows[0]?.steps}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2b. AN EARLIER EMPTY RESULT DOES NOT POISON THE RETRY THAT REPLACES IT");
// ══════════════════════════════════════════════════════════════════════════════════════════════
// voiceQuality was assigned once and never cleared, so an EMPTY attempt 1 carrying bad segments
// left its numbers behind and the forced-English retry was judged on them. Graded on stored rows,
// because "the coach replied" and "the facts landed" are different claims.
{
  await pool.query("DELETE FROM meal_logs WHERE user_id = $1", [user.id]);
  await pool.query("DELETE FROM step_logs WHERE user_id = $1", [user.id]);
  whisperOnly();
  whisperTurns = turns({ a1: { text: "", segments: BAD_SEGS }, a3: { text: GOOD, segments: GOOD_SEGS } });
  await drive();
  chk(whisperCalls === 2, "the forced-English retry really ran", `whisper calls = ${whisperCalls}`);
  chk(typeof reachedHandlers === "string" && /samp and beans/.test(reachedHandlers!),
    "a good retry is not refused on the failed attempt's metrics",
    `handlers got ${JSON.stringify(String(reachedHandlers ?? "NOTHING").slice(0, 60))}`);
  const { meals, steps } = await factCounts();
  chk(meals >= 1 && steps >= 1, "…and its facts are stored", `meals=${meals} steps=${steps}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n2c. SCRIBE'S METADATA SURVIVES THE PARSE, AND A REPETITIVE MEAL LIST IS STILL HEARD");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  await pool.query("DELETE FROM meal_logs WHERE user_id = $1", [user.id]);
  process.env.ELEVENLABS_API_KEY = "stub"; whisperTurns = [];
  // Word logprobs far past Whisper's line. They are carried and logged, and they reject NOTHING:
  // Scribe's scale is not Whisper's, and a threshold invented to bridge them would be a guess.
  scribeReply = { text: GOOD, words: [{ logprob: -9.9 }, { logprob: -9.9 }], language_probability: 0.2 };
  await drive();
  chk(typeof reachedHandlers === "string" && /samp and beans/.test(reachedHandlers!),
    "Scribe logprobs past Whisper's threshold do not reject — they are metadata, not a verdict",
    `handlers got ${JSON.stringify(String(reachedHandlers ?? "NOTHING").slice(0, 60))}`);

  // THE FREQUENCY RULE THAT STOOD HERE REFUSED THIS. Six foods, a staple repeated, no loop.
  await pool.query("DELETE FROM meal_logs WHERE user_id = $1", [user.id]);
  scribeReply = { text: "I had pap and eggs then pap and chicken then pap and beans and pap and fish" };
  await drive();
  chk(typeof reachedHandlers === "string" && /pap and eggs/.test(reachedHandlers!),
    "a repetitive but meaningful meal list reaches the handlers",
    `handlers got ${JSON.stringify(String(reachedHandlers ?? "NOTHING").slice(0, 60))}`);
  const meals = (await factCounts()).meals;
  chk(meals >= 1, "…and it is stored as food, not refused as garble", `meals=${meals}`);
  delete process.env.ELEVENLABS_API_KEY; scribeReply = null;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
REAL("\n3. THE FLOOR IS ONE PREDICATE AND EVERY PATH READS IT (source)");
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const { readFileSync } = await import("node:fs");
  const live = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  const media = live(readFileSync("server/handlers/media.ts", "utf-8"));
  const wedge = live(readFileSync("server/understanding/sa-transcript.ts", "utf-8"));
  chk(/transcriptFailsAdmission\(transcribedText, voiceQuality\)/.test(media),
    "media.ts asks the shared predicate and hands it whatever metrics it has");
  chk(!/if \(voiceQuality && wordCount/.test(media),
    "…and the metrics-only gate is gone, not left beside the predicate that replaced it");
  chk((media.match(/transcriptFailsAdmission\(/g) || []).length === 1,
    "ONE admission decision in the voice branch, not one per provider",
    `found ${(media.match(/transcriptFailsAdmission\(/g) || []).length}`);
  // THE PROVIDER'S OWN NUMBERS ARE KEPT, not replaced by guesses under cover of this cut — and
  // asked only of the provider they were calibrated against.
  chk(/quality\.avgLogprob < -1\.0 \|\| quality\.comp > 2\.5/.test(wedge),
    "the shipped provider thresholds are unchanged where the provider reports them");
  chk(/quality\?\.provider === "whisper" &&/.test(wedge),
    "…and they are applied to Whisper results only, never to Scribe's different scale");
  chk(!/looksLikeEnglish|fluen|confidenceGuess/i.test(wedge),
    "and nothing in the predicate judges how English the transcript sounds");
  // THE FREQUENCY RULE IS GONE, not merely unreachable. It refused six foods because a staple
  // recurred, which is broader than a loop check and broader than what was approved.
  chk(!/commonest/.test(wedge),
    "the commonest-token frequency rejection is deleted, not left able to come back");
  // EVERY RETRY ASKS FOR METRICS, and every accepted result carries its own.
  chk((media.match(/response_format: "verbose_json"/g) || []).length === 1,
    "one request shape covers all three Whisper attempts, so no retry is metric-less",
    `found ${(media.match(/response_format: "verbose_json"/g) || []).length}`);
  chk(/voiceQuality = whisperSegmentMetrics\(v\)/.test(media),
    "…and text and metrics are assigned together, so a result cannot inherit another's numbers");
  // SCRIBE'S METADATA SURVIVES THE PARSE.
  const eleven = live(readFileSync("server/elevenlabs.ts", "utf-8"));
  chk(!/as \{ text\?: string \}/.test(eleven),
    "elevenlabs.ts no longer narrows the Scribe response to its text");
  chk(/wordLogprobs/.test(eleven) && /language_probability/.test(eleven),
    "…and returns the provider's word logprobs and language probability alongside it");
  chk(/Number\.isFinite/.test(eleven),
    "…dropping absent values rather than zero-filling them into confident-looking scores");
}

REAL(`\n${failed === 0 ? "pg-stt-admission-acceptance: GREEN" : `pg-stt-admission-acceptance: ${failed} FAILED`}\n`);
globalThis.fetch = realFetch;
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

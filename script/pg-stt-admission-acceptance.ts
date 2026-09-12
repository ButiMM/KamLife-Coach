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

let scribeReply: string | null = null;
let attempt1: { throws: boolean; text?: string; segments?: any[] } = { throws: true };
let retryText = "";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url?.url || url);
  if (u.startsWith(AUDIO_URL)) {
    return new Response(audioBytes, { status: 200, headers: { "content-type": "audio/ogg" } });
  }
  if (u.includes("/speech-to-text")) {
    return scribeReply === null
      ? new Response("stub: scribe not configured for this case", { status: 500 })
      : new Response(JSON.stringify({ text: scribeReply }), {
          status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(url, init);
}) as any;

const sttStub: any = {
  audio: { transcriptions: { create: async (opts: any) => {
    // Consume the read stream media.ts opened; left alone it emits an async 'error' once the tmp
    // file is cleaned up. An artifact of stubbing, not of the code under test.
    try { opts.file?.on?.("error", () => {}); opts.file?.destroy?.(); } catch { /* not a stream */ }
    if (opts.response_format === "verbose_json") {
      if (attempt1.throws) throw new Error("stubbed attempt-1 failure");
      return { text: attempt1.text, segments: attempt1.segments || [] };
    }
    return { text: retryText };
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

let reachedHandlers: string | null = null;
async function drive(): Promise<string> {
  clearVoiceFailure(user.id);
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
const PATHS: Array<[string, () => void]> = [
  ["SCRIBE (first when ELEVENLABS_API_KEY is set — the production path)", () => {
    process.env.ELEVENLABS_API_KEY = "stub"; scribeReply = GARBLE;
  }],
  ["WHISPER attempt 2, the catch retry", () => {
    delete process.env.ELEVENLABS_API_KEY; scribeReply = null;
    attempt1 = { throws: true }; retryText = GARBLE;
  }],
  ["WHISPER attempt 3, the FORCED-ENGLISH retry", () => {
    delete process.env.ELEVENLABS_API_KEY; scribeReply = null;
    attempt1 = { throws: false, text: "", segments: [] }; retryText = GARBLE;
  }],
  ["WHISPER attempt 1, the only path that ever reported metrics", () => {
    delete process.env.ELEVENLABS_API_KEY; scribeReply = null;
    attempt1 = { throws: false, text: GARBLE, segments: [{ avg_logprob: -1.8, compression_ratio: 4.0 }] };
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
  delete process.env.ELEVENLABS_API_KEY; scribeReply = null;
  attempt1 = { throws: false, text: GOOD, segments: [{ avg_logprob: -0.2, compression_ratio: 1.4 }] };

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
  // THE PROVIDER'S OWN NUMBERS ARE KEPT, not replaced by guesses under cover of this cut.
  chk(/quality\.avgLogprob < -1\.0 \|\| quality\.comp > 2\.5/.test(wedge),
    "the shipped provider thresholds are unchanged where the provider reports them");
  chk(!/looksLikeEnglish|fluen|confidenceGuess/i.test(wedge),
    "and nothing in the predicate judges how English the transcript sounds");
}

REAL(`\n${failed === 0 ? "pg-stt-admission-acceptance: GREEN" : `pg-stt-admission-acceptance: ${failed} FAILED`}\n`);
globalThis.fetch = realFetch;
await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
await pool.end();
process.exit(failed === 0 ? 0 : 1);

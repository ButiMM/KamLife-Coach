/**
 * THE CUSTOMER REPLAY GATE (#270, ORDERS §4 Step 2).
 *
 * Replays real failures through the production-shaped path: the real front door
 * (processTextAsync → handleMessage → sendFinal), real PostgreSQL, the live model, and production
 * flags (ENGINE_LIVE=on, the normaliser on). Grades what a client would actually get:
 *
 *   HARD INVARIANTS (ORDERS §3)  deterministic, from stored rows and the post-transport body
 *                                (shadow_replies). Pass/fail, release-stopping.
 *   JUDGE                        an OpenAI model — a different family from the builder — sees only
 *                                the client's turns, the stored state and the final bodies, and
 *                                scores the coaching 0-10 against the case's rubric.
 *
 * Recorded per run: git SHA, corpus version, judge-prompt version, product-prompt fingerprint,
 * the judge model, and every product model that actually answered (read back from gpt_costs).
 *
 * THE GATE (every PR): a hard-invariant check that passes in docs/replay-baseline.json and fails
 * now is a regression, and the run exits 1. A check that already fails on main is reported, not
 * blocking — the gate stops things getting worse and shows the harm that is still there.
 *
 * NO MODEL, NO VERDICT. Without OPENAI_API_KEY every case is NOT TESTED and the run exits 2, never
 * 0: a gate that passes because nothing answered is the vacuous green this repo keeps finding.
 * `--offline` runs the plumbing against a stub for local development; its result says so and it
 * can never write a baseline.
 *
 * HELD-OUT SET: REPLAY_HELDOUT_JSON (a secret) holds more cases in the same shape. They run and
 * gate exactly like the public ones, but the report shows only their counts, never their inputs.
 *
 * Run:  DATABASE_URL=… OPENAI_API_KEY=… npx tsx script/replay-gate.ts [--offline] [--write-baseline]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { CASES, type ReplayCase, type Check } from "./replay-cases";

const OFFLINE = process.argv.includes("--offline");
const WRITE_BASELINE = process.argv.includes("--write-baseline");
const BASELINE_PATH = "docs/replay-baseline.json";
const JUDGE_MODEL = process.env.REPLAY_JUDGE_MODEL || "gpt-4.1";

if (!process.env.DATABASE_URL) {
  console.error("replay-gate: DATABASE_URL is not set. The gate grades stored rows; without a database it grades nothing.");
  process.exit(2);
}
const HAS_MODEL = !!process.env.OPENAI_API_KEY && !OFFLINE;
if (!HAS_MODEL && !OFFLINE) {
  console.error("replay-gate: NOT TESTED — OPENAI_API_KEY is not set, so no real model answered any turn.");
  process.exit(2);
}

// PRODUCTION FLAGS. The live front door, the live normaliser, nothing proactive, bodies captured.
process.env.ENGINE_LIVE = "on";
process.env.NORMALIZER = "on";
process.env.PROACTIVE_PAUSED = "true";
process.env.SHADOW = "on";
process.env.NODE_ENV = "production";
process.env.TWILIO_ACCOUNT_SID ||= "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN ||= "test";
process.env.TWILIO_WHATSAPP_NUMBER ||= "+27000000000";
if (OFFLINE) {
  // The plumbing, not the product: a fixed mouth, so a local run proves the runner and nothing else.
  process.env.OPENAI_API_KEY = "sk-offline";
  process.env.OFFLINE_AI = "0";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url || input);
    if (!url.includes("api.openai.com")) return realFetch(input, init);
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.includes("/embeddings")) {
      return new Response(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: Array(1536).fill(0) }], model: "offline", usage: { prompt_tokens: 1, total_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const content = body.includes("message-understanding brain") ? `{"intent":"OTHER","confidence":0.5,"canonical":""}`
      : body.includes("REPLAY_JUDGE") ? `{"score":5,"verdict":"offline","reasons":["offline stub"]}`
      : "Okay, noted.";
    return new Response(JSON.stringify({ id: "offline", object: "chat.completion", created: 1, model: "offline-stub",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const REAL = console.log.bind(console);
console.log = console.warn = console.error = () => {};

const { pool, db } = await import("../server/db");
const schema = await import("../shared/schema");
const { handleMessage } = await import("../server/routes");
const { processTextAsync } = await import("../server/routes/whatsapp");
const { _resetOutboundDedupe } = await import("../server/reply-hygiene");
const { _resetInteractionCorrelation } = await import("../server/handlers/chat-log");
const OpenAI = (await import("openai")).default;

// ── VERSIONS ────────────────────────────────────────────────────────────────────────────────
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const JUDGE_SYSTEM = `REPLAY_JUDGE v1. You grade one WhatsApp coaching exchange from a South African fitness and nutrition coach.
You see ONLY: the client's messages, the client's stored state after the exchange, the coach's final WhatsApp replies, and a rubric saying what good looks like.
You do NOT see how the reply was produced. Judge the client's experience: did the coach answer what was asked, use what the client said, stay safe, and avoid inventing facts?
Return ONLY JSON: {"score": <integer 0-10>, "verdict": "<one sentence>", "reasons": ["<short>", ...]}.
10 = exactly what a skilled, caring human coach would send. 5 = acceptable but generic or partly wrong. 0 = harmful, false, or ignores the client.`;
// A LIVE RUN WITHOUT ITS HELD-OUT SET IS NOT A GATE RESULT (Codex @ 975ea74): an absent, unreadable,
// non-array or empty corpus used to read as "0 held out" and could pass, or record a baseline with no
// hidden protection in it. Offline (local) runs may omit it; a malformed one never passes.
const heldOut: ReplayCase[] = (() => {
  const raw = process.env.REPLAY_HELDOUT_JSON;
  const notTested = (why: string) => { REAL(`replay-gate: NOT TESTED — ${why}`); process.exit(2); };
  if (!raw) return OFFLINE ? [] : notTested("REPLAY_HELDOUT_JSON is not set; the held-out cases are part of the gate.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw.trim().startsWith("[") ? raw : Buffer.from(raw, "base64").toString("utf8")); }
  catch { return notTested("REPLAY_HELDOUT_JSON is set but unreadable."); }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(c => c && typeof c === "object" && Array.isArray((c as any).turns) && Array.isArray((c as any).checks)))
    return notTested("REPLAY_HELDOUT_JSON is not a non-empty array of cases.");
  return parsed as ReplayCase[];
})();
const PRODUCT_PROMPT_FILES = ["server/coach-prompt.ts", "server/gpt.ts", "server/understanding/perception.ts", "server/understanding/live.ts"];
const versions = {
  gitSha: (() => { try { return execSync("git rev-parse HEAD").toString().trim(); } catch { return "unknown"; } })(),
  corpus: sha(JSON.stringify(CASES)),
  heldOut: heldOut.length ? sha(JSON.stringify(heldOut)) : null,
  judgePrompt: sha(JUDGE_SYSTEM),
  productPrompts: sha(PRODUCT_PROMPT_FILES.filter(existsSync).map(f => readFileSync(f, "utf8")).join("\n")),
  judgeModel: HAS_MODEL ? JUDGE_MODEL : "offline-stub",
};

// ── ONE CASE ────────────────────────────────────────────────────────────────────────────────
type CheckResult = { what: string; invariant: string | null; pass: boolean; evidence: string };
type CaseResult = { id: string; heldOut: boolean; checks: CheckResult[]; hardPass: boolean; score: number | null; verdict: string; bodies: string[] };

const lastShadowId = async () => Number((await pool.query("SELECT COALESCE(MAX(id),0) m FROM shadow_replies")).rows[0].m);
async function bodyAfter(phone: string, since: number): Promise<string> {
  // The reply is written after the turn settles; with a live model that takes seconds, not ms.
  for (let i = 0; i < 90; i++) {
    const rows = (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2 ORDER BY id", [phone, since])).rows;
    if (rows.length) { await new Promise(r => setTimeout(r, 1000)); return (await pool.query<{ body: string }>("SELECT body FROM shadow_replies WHERE phone = $1 AND id > $2 ORDER BY id", [phone, since])).rows.map(r => r.body).join("\n"); }
    await new Promise(r => setTimeout(r, 1000));
  }
  return "";
}
async function turn(phone: string, text: string, sid: string): Promise<string> {
  _resetOutboundDedupe();
  _resetInteractionCorrelation();
  const s0 = await lastShadowId();
  await processTextAsync(phone, text, null, null, [], handleMessage as any, sid);
  return bodyAfter(phone, s0);
}

async function runCheck(c: Check, userId: string, phone: string, bodies: string[]): Promise<CheckResult> {
  const base = { what: c.what, invariant: c.invariant ?? null };
  if (c.kind === "sql") {
    // The user row may have been renamed by a deletion; the id is stable.
    const row = (await pool.query(c.query, c.query.includes("$2") ? [userId, phone] : [userId])).rows[0];
    const v = row ? Object.values(row)[0] : null;
    const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
    const pass = c.expect === "zero" ? Number(n) === 0 : c.expect === "nonzero" ? Number(n) > 0 : n === c.expect.equals;
    return { ...base, pass, evidence: `got ${JSON.stringify(n)}` };
  }
  const body = bodies[c.turn ?? bodies.length - 1] ?? "";
  const hit = new RegExp(c.pattern, c.flags ?? "").test(body);
  return { ...base, pass: c.kind === "reply_matches" ? hit : !hit, evidence: JSON.stringify(body.slice(0, 240)) };
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function judge(k: ReplayCase, userId: string, bodies: string[]): Promise<{ score: number | null; verdict: string }> {
  const [u] = (await pool.query(
    `SELECT goal_type, age, onboarding_state, life_situation, injuries, life_context, profile_notes, calorie_target FROM users WHERE id = $1`, [userId])).rows;
  const meals = (await pool.query("SELECT meal_label, raw_message, kcal_int, logged_at FROM meal_logs WHERE user_id = $1 ORDER BY logged_at", [userId])).rows;
  const exchange = k.turns.map((t, i) => `CLIENT: ${t}\nCOACH: ${bodies[i] || "(no reply)"}`).join("\n\n");
  try {
    const resp = await openai.chat.completions.create({
      model: JUDGE_MODEL, temperature: 0, response_format: { type: "json_object" },
      messages: [{ role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: `RUBRIC: ${k.rubric}\n\nSTORED STATE AFTER: ${JSON.stringify({ client: u || null, meals })}\n\nEXCHANGE:\n${exchange}` }],
    });
    if (resp.model) versions.judgeModel = resp.model;
    const j = JSON.parse(resp.choices[0]?.message?.content || "{}");
    const score = Number.isFinite(Number(j.score)) ? Math.max(0, Math.min(10, Math.round(Number(j.score)))) : null;
    return { score, verdict: String(j.verdict || "") };
  } catch (e) {
    return { score: null, verdict: `judge unavailable: ${(e as Error)?.message || e}` };
  }
}

async function runCase(k: ReplayCase, n: number, isHeldOut: boolean): Promise<CaseResult> {
  const phone = `whatsapp:+2782${String(9000000 + n).padStart(7, "0")}`;
  await pool.query("DELETE FROM users WHERE phone_number = $1", [phone]);
  await pool.query("DELETE FROM shadow_replies WHERE phone = $1", [phone]);
  const [u] = await db.insert(schema.users).values({
    phoneNumber: phone, name: "Lerato Replay", onboardingState: "COMPLETE", popiConsent: true, popiConsentAt: new Date(),
    subscriptionStatus: "active", goalType: "fat_loss", currentWeight: "82", startWeight: "86", targetWeight: "72",
    heightCm: 164, age: 33, gender: "female", trainingMode: "home", trainingDaysPerWeek: 3,
    proteinTarget: 125, calorieTarget: 1800, dailyCalorieTarget: 1800, stepsTarget: 8000, lifeSituation: "office",
    ...(k.seed || {}),
  } as any).returning();
  for (const [i, t] of (k.before || []).entries()) await turn(phone, t, `RP${n}b${i}`);
  const bodies: string[] = [];
  for (const [i, t] of k.turns.entries()) bodies.push(await turn(phone, t, `RP${n}t${i}`));
  const checks: CheckResult[] = [];
  for (const c of k.checks) checks.push(await runCheck(c, u.id, phone, bodies));
  const { score, verdict } = await judge(k, u.id, bodies);
  return { id: k.id, heldOut: isHeldOut, checks, hardPass: checks.filter(c => c.invariant).every(c => c.pass), score, verdict, bodies };
}

// ── THE RUN ─────────────────────────────────────────────────────────────────────────────────
const runStart = new Date();
const results: CaseResult[] = [];
for (const [i, k] of CASES.entries()) results.push(await runCase(k, i, false));
for (const [i, k] of heldOut.entries()) results.push(await runCase(k, 1000 + i, true));
const productModels = (await pool.query<{ model: string }>("SELECT DISTINCT model FROM gpt_costs WHERE created_at >= $1 ORDER BY model", [runStart])).rows.map(r => r.model);
// DID A MODEL ACTUALLY ANSWER? A run where the product recorded no model call, or every judge call
// failed, graded the deterministic floor only. That is not a gate result, whatever the checks say
// (the first CI run of this gate passed exactly that way: key present, no model reached).
const judgeErrors = results.map(r => r.verdict).filter(v => v.startsWith("judge unavailable"));
// ANY unanswered judge call voids the run (Codex @ 975ea74): a case with no score drops out of the
// mean, so a partly-judged run could read better than a fully-judged one.
if (!OFFLINE && (productModels.length === 0 || judgeErrors.length > 0)) {
  REAL(`replay-gate: NOT TESTED — not every model call answered (product models recorded: ${productModels.length}; judge failures: ${judgeErrors.length}/${results.length}).`);
  if (judgeErrors[0]) REAL(`first judge error: ${judgeErrors[0].slice(0, 300)}`);
  await pool.end().catch(() => {});
  process.exit(2);
}

// A held-out check is keyed by an opaque hash (Codex @ 8ed032c): it enters the baseline and gates
// exactly like a public check, and neither its case nor its wording appears in any file or log.
const key = (r: CaseResult, c: CheckResult) => r.heldOut ? `held-out:${sha(`${r.id}::${c.what}`)}` : `${r.id}::${c.what}`;
const hardNow = new Map(results.flatMap(r => r.checks.filter(c => c.invariant).map(c => [key(r, c), c.pass] as const)));
const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : null;
// A baseline check that passed must still EXIST and pass (Codex @ ced3cb0): deleting or renaming it
// is a regression, or removing the protection would read as "nothing regressed".
const regressions = baseline
  ? Object.entries(baseline.hard as Record<string, boolean>).filter(([k, was]) => was && hardNow.get(k) !== true)
    .map(([k]) => hardNow.has(k) ? k : `${k} (check no longer exists)`)
  : [];
const scored = results.filter(r => r.score !== null);
const meanScore = scored.length ? Math.round((scored.reduce((s, r) => s + (r.score as number), 0) / scored.length) * 10) / 10 : null;
const hardFailing = [...hardNow].filter(([, p]) => !p).map(([k]) => k);

const record = {
  runAt: new Date().toISOString(), offline: OFFLINE, versions, productModels,
  summary: { cases: results.length, heldOut: heldOut.length, hardChecks: hardNow.size, hardFailing: hardFailing.length, meanScore, regressions },
  cases: results.map(r => r.heldOut
    ? { id: "held-out", heldOut: true, hardPass: r.hardPass, score: r.score }
    : { id: r.id, heldOut: false, hardPass: r.hardPass, score: r.score, verdict: r.verdict, checks: r.checks }),
};
mkdirSync("replay-results", { recursive: true });
writeFileSync(`replay-results/run-${versions.gitSha.slice(0, 7)}.json`, JSON.stringify(record, null, 2));

// THE BASELINE CANDIDATE. Held-out checks are in it under their opaque keys, so they gate too.
const candidate = {
  recordedAt: record.runAt, gitSha: versions.gitSha, versions, productModels, meanScore,
  hard: Object.fromEntries(hardNow),
  scores: Object.fromEntries(results.filter(r => !r.heldOut).map(r => [r.id, r.score])),
};
if (!OFFLINE) {
  // Printed so the run that sets the baseline can be read back from the job log and committed.
  REAL(`BASELINE_CANDIDATE_JSON ${JSON.stringify(candidate)}`);
  if (WRITE_BASELINE) writeFileSync(BASELINE_PATH, JSON.stringify(candidate, null, 2) + "\n");
} else if (WRITE_BASELINE) {
  REAL("replay-gate: refusing to write a baseline from an offline run."); process.exit(2);
}

// ── THE REPORT ──────────────────────────────────────────────────────────────────────────────
const lines: string[] = [];
lines.push(`## Customer replay gate ${OFFLINE ? "— OFFLINE PLUMBING RUN, NOT A GATE RESULT" : ""}`);
lines.push(`SHA \`${versions.gitSha.slice(0, 7)}\` · corpus \`${versions.corpus}\` · judge \`${versions.judgeModel}\` prompt \`${versions.judgePrompt}\` · product prompts \`${versions.productPrompts}\` · product models ${productModels.join(", ") || "none recorded"}`);
lines.push(`**${results.length} cases** (${heldOut.length} held out) · hard checks failing: **${hardFailing.length}/${hardNow.size}** · mean judge score **${meanScore ?? "n/a"}/10**${baseline ? ` (baseline ${baseline.meanScore ?? "n/a"})` : " · no baseline yet"}`);
lines.push(regressions.length ? `### ❌ ${regressions.length} regression(s) against the main baseline\n${regressions.map(r => `- ${r}`).join("\n")}` : baseline ? "### ✅ No hard invariant regressed against the main baseline" : "");
lines.push("", "| case | hard | score | failing checks |", "|---|---|---|---|");
for (const r of results.filter(x => !x.heldOut)) {
  const bad = r.checks.filter(c => !c.pass).map(c => `${c.invariant ? "**" + c.invariant + "**: " : ""}${c.what}`).join("; ");
  lines.push(`| ${r.id} | ${r.hardPass ? "pass" : "FAIL"} | ${r.score ?? "–"} | ${bad || ""} |`);
}
if (heldOut.length) lines.push(`| held-out ×${heldOut.length} | ${results.filter(r => r.heldOut && r.hardPass).length}/${heldOut.length} pass | – | (inputs not shown) |`);
const report = lines.join("\n");
REAL(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");

await pool.end().catch(() => {});
// NO BASELINE, NO GATE (Codex @ 975ea74): with nothing on main to compare against, nothing can
// regress, so every hard failure would read green. A live run prints the candidate above and stops
// NOT TESTED until it is committed; only an explicit recording run (WRITE_BASELINE) may pass.
if (!OFFLINE && !baseline && !WRITE_BASELINE) {
  REAL("replay-gate: NOT TESTED — no docs/replay-baseline.json on main. Commit the BASELINE_CANDIDATE_JSON above (reviewed) to arm the gate.");
  process.exit(2);
}
process.exit(regressions.length ? 1 : 0);

/**
 * NORMALIZER REPLAY — run the production front door offline, or say plainly that you did not.
 *
 * Issue #63, item 1.1. Production applies the normalizer to every message before any handler sees
 * it. Eight deterministic harnesses set NORMALIZER=off because it needs a live model, so the
 * transformation that reaches production FIRST has never been exercised offline. This suite
 * replays recordings of the real model so that stops being true.
 *
 * THE ONE THING THIS SUITE MUST NEVER DO is pass while covering nothing. Three separate defects
 * found on 2026-08-25 were tests that could not fail for the right reason — a stub that ignored
 * `where`, a fixture that asserted only the absence of a wrong answer, and two checks seeded with
 * the wrong day. So:
 *
 *   - with no recording present it reports SKIPPED, loudly, and asserts nothing;
 *   - with a recording present it runs STRICT, so an input that was never recorded THROWS rather
 *     than falling through to the offline shim and grading a reply the normalizer never touched;
 *   - if the prompt or model has moved since the recording, it says so, because a stale recording
 *     asserts yesterday's behaviour while claiming to assert today's.
 */

process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_WHATSAPP_NUMBER = "+27000000000";
process.env.APP_URL = "https://kamlife-coach-production.up.railway.app";
process.env.NODE_ENV = "production";
// THE POINT OF THE SUITE: the front door is ON here, unlike every other offline harness.
delete process.env.NORMALIZER;
process.env.NORMALIZER_FIXTURES_STRICT = "1";

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { CORPUS, CORPUS_PATH, REQUIRED_CATEGORIES, recordingFingerprint } from "./record-normalizer";

/** Captured before anything can override it — see turn() below. */
const REAL_LOG = console.log.bind(console);

let passed = 0;
const failures: string[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; } catch (e: any) { failures.push(`  ✗ ${name}\n    ${e?.message || e}`); }
}

async function main() {
  // ── THE CORPUS IS CHECKABLE WITHOUT THE RECORDING (#116, 2026-09-02) ────────────────────────
  //
  // Everything below needs the model's recorded answers. The corpus itself does not: whether the
  // front door has representative inputs to replay at all is a property of this repository, and it
  // is the half that silently rots — a category can be dropped in a refactor and nothing notices
  // while the suite is standing down for a missing recording anyway.
  //
  // So this runs FIRST and can genuinely fail. It is not a substitute for replaying production
  // behaviour and does not pretend to be: it asserts the corpus is representative, never that the
  // normalizer is correct.
  const covered = new Set(CORPUS.map(c => c.category));
  const uncovered = REQUIRED_CATEGORIES.filter(c => !covered.has(c));
  if (uncovered.length > 0) {
    console.log(`✗ the corpus no longer represents ${uncovered.length} required input class(es): ${uncovered.join(", ")}`);
    console.log(`  A front door with no recorded example of a class is a front door nobody is watching there.`);
    process.exit(1);
  }
  const byCategory = REQUIRED_CATEGORIES.map(c => `${c} ${CORPUS.filter(e => e.category === c).length}`).join(" · ");

  if (!existsSync(CORPUS_PATH)) {
    // THE MARKER MATTERS AS MUCH AS THE MESSAGE (2026-08-25). Exiting 0 with a printed notice made
    // run-suites report `✓ normalizer-replay-tests` — a green tick on a suite that asserted
    // nothing, which is the exact vacuous pass this file exists to prevent, reproduced by the file
    // itself. run-suites reads this marker and renders ⊘, and counts it as not covered.
    console.log(
      `SUITE_SKIPPED: no recording at ${CORPUS_PATH} — the production front door is NOT covered\n` +
      `  Record it once with a real key:  OPENAI_API_KEY=sk-… npx tsx script/record-normalizer.ts\n` +
      `  ${CORPUS.length} corpus inputs are waiting, across ${REQUIRED_CATEGORIES.length} input classes: ${byCategory}.\n` +
      `  The corpus is present and representative; what is missing is the RECORDING of production's\n` +
      `  answers, which needs a real key. This is a stated gap, not a pass.`);
    process.exit(0);
  }

  const recorded = JSON.parse(readFileSync(CORPUS_PATH, "utf-8"));
  (globalThis as any).__KAMLIFE_INTENT_FIXTURES = recorded.entries;

  const fp = recordingFingerprint(readFileSync("server/gpt.ts", "utf-8"));
  if (fp.promptHash !== recorded.promptHash || fp.model !== recorded.model) {
    console.log(`⚠ STALE: recorded against ${recorded.model}/${recorded.promptHash}, `
      + `now ${fp.model}/${fp.promptHash}. Re-record — these assertions describe the old front door.`);
  }

  const missing = CORPUS.filter(c => !(c.input.toLowerCase() in recorded.entries));
  await check("every corpus input has a recording", () => {
    assert.equal(missing.length, 0,
      `${missing.length} corpus inputs were never recorded: ${missing.map(m => m.input.slice(0, 40)).join(" | ")}`);
  });

  await check("a correction keeps the day it names", () => {
    const rec: any = recorded.entries["you missed the black coffee yesterday"];
    if (!rec?.canonical) return;
    assert.match(String(rec.canonical), /yesterday/i,
      `the rewrite dropped the day being corrected: ${rec.canonical}`);
  });


  // ── AND THROUGH THE PRODUCTION PATH, WHICH IS THE WHOLE POINT ────────────────────────────────
  //
  // The checks above grade the RECORDINGS. This drives real turns with the front door ON and the
  // recordings replayed — the arrangement no offline suite has ever run. STRICT is set, so if a
  // turn reaches the classifier with an input that was not recorded it throws rather than quietly
  // falling through to the offline shim and grading a reply the normalizer never touched.
  //
  // The assertion is deliberately POSITIVE (item 1.2): not "the bad string is absent" but "the
  // client got an answer at all". #61 shipped green on a negative assertion while the coach
  // changed the subject, and that is the failure this form exists to prevent.
  const { handleMessage } = await import("../server/routes");
  const NOW = Date.now();
  const USER = {
    id: "norm-replay", phoneNumber: "whatsapp:+27000000031", name: "Kam",
    onboardingState: "COMPLETE", onboardingComplete: true, subscriptionStatus: "active",
    popiConsent: true, popiConsentAt: new Date(NOW - 30 * 86_400_000),
    goalType: "fat_loss", currentWeight: 95, targetWeight: 85, heightCm: 180, age: 35,
    gender: "male", activityLevel: "moderate", trainingMode: "gym", trainingDaysPerWeek: 3,
    programmePhase: 1, programmeWeek: 1, programmeDayInWeek: 2, totalWorkoutsCompleted: 24,
    programmeStartDate: new Date(NOW - 35 * 86_400_000), injuries: "none", medicalConditions: "none",
    awaitingInputType: null, profileNotes: "", calorieTarget: 2700, proteinTarget: 180,
    stepTarget: 10000, lastActiveAt: new Date(NOW - 3600_000), createdAt: new Date(NOW - 35 * 86_400_000),
  };
  for (const { input } of CORPUS.filter(c => c.input.toLowerCase() in recorded.entries)) {
    await check(`through the front door: ${input.slice(0, 44)}`, async () => {
      (globalThis as any).__KAMLIFE_STUB_USER = { ...USER };
      const reply = String(await handleMessage(USER.phoneNumber, input) ?? "");
      assert.ok(reply.trim().length > 0, "the turn produced no reply at all");
      assert.ok(!/something went wrong on my side|give me a second and try again/i.test(reply),
        `the pipeline crashed with the normalizer on — this path is only reachable here:\n      ${reply.slice(0, 160)}`);
    });
  }

  // ── THE INVARIANT THAT MATTERS, GRADED ON THE PRODUCT AND NOT ON THE MODEL'S STRING ─────────
  //
  // The first real recording (2026-09-06, Railway) settled a question the string form of these two
  // checks could not even ask. gpt-4o-mini DOES collapse the three-day batch — it returned
  // "…for breakfast and rice with beef stew for dinner yesterday", losing Tuesday and Wednesday and
  // renaming Monday. Graded as a string that is a failure. Graded through the front door it is not
  // a failure at all, because routes.ts refuses the rewrite before any handler sees it:
  //
  //   [NORMALIZER] multi-DAY note is never rewritten; raw text proceeds
  //   [MEAL_LOG] INSERT meal … at=Mon Aug 31
  //   [MEAL_LOG] INSERT meal … at=Tue Sep 01
  //   [MEAL_LOG] INSERT meal … at=Wed Sep 02
  //
  // Three days in, three days written. The old assertion demanded that the MODEL behave, which is
  // neither something this product controls nor what #63 was ever about: #63 is that the raw text
  // must reach the batch logger. So these now drive the real turn and read the durable writes and
  // the front door's own instrumentation. That is strictly stronger — a model that happened to
  // echo the three day names would satisfy the old check while the brake was broken — and it is
  // the same discipline the rest of this repo applies: static shape produces candidates, the
  // runtime trace decides.
  const { mealLogs } = await import("../shared/schema");
  const { sastDayKey } = await import("../server/sast");

  /** Run one real turn and capture what it wrote and whether the front door applied a rewrite. */
  async function turn(input: string): Promise<{ days: string[]; appliedRewrite: boolean }> {
    const g = globalThis as any;
    g.__KAMLIFE_STUB_USER = { ...USER };
    g.__KAMLIFE_STUB_WRITES = [];
    // The applied-rewrite line is only printed when the canonical SURVIVES every brake
    // (routes.ts:709). Every refusal prints a differently-shaped line, so this reads the product's
    // own instrumentation rather than re-deriving the decision.
    // ONE TURN AT A TIME, AND THE RESTORE TARGET IS CAPTURED ONCE. The first cut ran these
    // concurrently through Promise.all: the overrides nested, the last restore put back another
    // OVERRIDE rather than the real function, and the suite's own summary vanished into it.
    // Concurrent turns would also share __KAMLIFE_STUB_WRITES and the stub user, so sequential is
    // the only honest shape here regardless of the logging.
    const APPLIED = /^\[NORMALIZER\] [A-Z_]+\(\d+%\)/;
    let applied = false;
    console.log = (...a: unknown[]) => { if (APPLIED.test(String(a[0] ?? ""))) applied = true; };
    try { await handleMessage(USER.phoneNumber, input); }
    finally { console.log = REAL_LOG; }
    const days = (g.__KAMLIFE_STUB_WRITES as Array<{ table: unknown; values: any }>)
      .filter(w => w.table === mealLogs && w.values?.loggedAt)
      .map(w => sastDayKey(new Date(w.values.loggedAt)));
    delete g.__KAMLIFE_STUB_WRITES;
    return { days: [...new Set(days)], appliedRewrite: applied };
  }

  await check("a multi-day batch still lands on three days through the front door", async () => {
    const batch = CORPUS.find(c => /Monday I had pap/i.test(c.input))!;
    if (!(batch.input.toLowerCase() in recorded.entries)) return;   // reported by the coverage check
    const { days, appliedRewrite } = await turn(batch.input);
    assert.equal(days.length, 3,
      `three days of meals landed on ${days.length} day(s): ${days.join(", ")} — this is the ~7,700 `
      + `kcal-on-one-day failure from #63, and it means the raw text never reached the batch logger`);
    assert.equal(appliedRewrite, false,
      "the front door applied a rewrite to a multi-day note — the brake that protects the batch "
      + "logger is not firing, whatever the model happened to return this time");
  });

  // ── AND THE NUMBERS BRAKE, GRADED ON WHETHER IT FIRED ───────────────────────────────────────
  //
  // routes.ts refuses any canonical carrying a digit the client did not write. The first real
  // recording produced one: "my steps are 10k today" → "10000 steps today". That expansion is
  // reasonable and the brake still refuses it, because a brake that reasons about which inventions
  // are benign is not a brake. The old check called that a failure of the MODEL; what matters is
  // that the GUARD held and the deterministic step parser read "10k" off the raw text anyway.
  await check("a canonical carrying an unwritten number never reaches a handler", async () => {
    // The brake's own test, in the brake's own terms (routes.ts): separators stripped, digit-for-
    // digit containment. Word-number compounds are the brake's other allowance and none of the
    // recorded inputs use one, so this is deliberately the narrow form.
    const inventing = Object.entries<any>(recorded.entries).filter(([key, rec]) => {
      const stripped = key.replace(/[.,\s]/g, "");
      return String(rec.canonical || "").match(/\d+/g)?.some(d => !stripped.includes(d));
    });
    for (const [key] of inventing) {
      const rec: any = recorded.entries[key];
      const { appliedRewrite } = await turn(String(rec._input || key));
      assert.equal(appliedRewrite, false,
        `the front door applied "${rec.canonical}" to "${key.slice(0, 46)}" — it carries a number `
        + `the client never wrote, and the hallucination brake let it through`);
    }
    // NOT VACUOUS. If nothing in the corpus invents a number the loop above asserts nothing, and a
    // brake that refused EVERY rewrite would also pass it. Both are ruled out here.
    assert.ok(inventing.length > 0,
      "no recorded canonical carries an unwritten number, so this check graded nothing — re-record, "
      + "or retire it deliberately rather than letting it pass empty");
    let anyApplied = false;
    for (const c of CORPUS.filter(c => recorded.entries[c.input.toLowerCase()]?.canonical)) {
      if ((await turn(c.input)).appliedRewrite) { anyApplied = true; break; }
    }
    assert.ok(anyApplied,
      "the front door applied NO rewrite from the whole corpus — the brakes cannot be graded "
      + "against a normalizer that is off");
  });

  console.log(`\nnormalizer-replay: ${passed}/${passed + failures.length} passed `
    + `(${Object.keys(recorded.entries).length} recorded normalizations)`);
  if (failures.length) { console.log("\nFailures:\n" + failures.join("\n")); process.exit(1); }
  console.log("✓ the production front door was exercised, not skipped");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

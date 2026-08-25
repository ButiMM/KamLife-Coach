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
import { CORPUS, CORPUS_PATH, recordingFingerprint } from "./record-normalizer";

let passed = 0;
const failures: string[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; } catch (e: any) { failures.push(`  ✗ ${name}\n    ${e?.message || e}`); }
}

async function main() {
  if (!existsSync(CORPUS_PATH)) {
    console.log(
      `\n⊘ normalizer-replay: SKIPPED — no recording at ${CORPUS_PATH}.\n` +
      `  The production front door is therefore NOT covered by any offline suite.\n` +
      `  Record it once with a real key:  OPENAI_API_KEY=sk-… npx tsx script/record-normalizer.ts\n` +
      `  ${CORPUS.length} corpus inputs are waiting. This is a stated gap, not a pass.\n`);
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

  // ── THE INVARIANT THAT MATTERS: a rewrite may not destroy what a downstream owner needs ──────
  //
  // #63 established the mechanism: a multi-day note is a SINGLE-DOMAIN note, so `multiFact` is
  // false and the brake that stops the normalizer speaking for a multi-fact message never engages.
  // The batch logger itself is correct — it answers "Logged 3 days ✅" on the raw text. The risk is
  // entirely that the raw text never reaches it.
  await check("a multi-day batch keeps its days through the front door", () => {
    const batch = CORPUS.find(c => /Monday I had pap/i.test(c.input))!;
    const rec: any = recorded.entries[batch.input.toLowerCase()];
    if (!rec) return;                       // already reported by the coverage check above
    const canon = String(rec.canonical || "");
    if (!canon) return;                     // no rewrite is the safe outcome — nothing destroyed
    const days = ["monday", "tuesday", "wednesday"].filter(d => canon.toLowerCase().includes(d));
    assert.equal(days.length, 3,
      `the rewrite kept ${days.length}/3 named days — a multi-day note collapsed at the front door, `
      + `which is how three days of meals land on one: ${canon}`);
  });

  await check("a correction keeps the day it names", () => {
    const rec: any = recorded.entries["you missed the black coffee yesterday"];
    if (!rec?.canonical) return;
    assert.match(String(rec.canonical), /yesterday/i,
      `the rewrite dropped the day being corrected: ${rec.canonical}`);
  });

  // ── AND THE NUMBERS BRAKE, ASSERTED ON REAL RECORDINGS ──────────────────────────────────────
  // routes.ts refuses a canonical whose numbers are not in the original. That guard is only as
  // good as the rewrites it actually sees.
  await check("no rewrite invents a number the client did not write", () => {
    for (const [key, rec] of Object.entries<any>(recorded.entries)) {
      const canon = String(rec.canonical || "");
      if (!canon) continue;
      for (const n of canon.match(/\d+/g) || []) {
        assert.ok(key.includes(n) || /^(1|2)$/.test(n),
          `the rewrite of "${key.slice(0, 50)}" invented the number ${n}: ${canon}`);
      }
    }
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

  console.log(`\nnormalizer-replay: ${passed}/${passed + failures.length} passed `
    + `(${Object.keys(recorded.entries).length} recorded normalizations)`);
  if (failures.length) { console.log("\nFailures:\n" + failures.join("\n")); process.exit(1); }
  console.log("✓ the production front door was exercised, not skipped");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

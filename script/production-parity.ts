/**
 * PRODUCTION-PARITY RESPONSE HARNESS — assert what the CLIENT receives (2026-08-20).
 *
 * WHY THIS EXISTS, precisely. On 20 August the founder sent "Today's progress" and got
 * "Let me not guess on that one. Tell me what happened in your own words." routing-audit had a
 * case for that exact phrase, and it was green. Both statements were true, because CI and
 * production were executing DIFFERENT BRANCHES OF THE SAME HANDLER:
 *
 *   dailyMacroCardMarker() returns "" when cardBaseUrl() is empty.
 *   CI has no APP_URL  → no card → the "Today so far" branch → contains no step count.
 *   Production has APP_URL → card  → the "today: …" branch → interpolates the step count.
 *
 * Only the second branch contains the string that trips the verifier. So the suite asserted a
 * reply production never sends, and the founder became the missing test.
 *
 * Two rules follow, and they are the whole point of this file:
 *   1. Run with the production branches ENABLED (APP_URL set).
 *   2. Assert the FINAL outbound text — after reconcileTurnReply, verifier included — not the
 *      handler's draft. routing-audit asserts which handler claimed; this asserts what arrives.
 *
 * It is deliberately small. It covers the domains where a second authority has already cost a
 * customer-visible failure, and it grows when another one does.
 */

process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";
process.env.NORMALIZER = "off";
process.env.PROACTIVE_PAUSED = "true";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test";
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "+27000000000";
// THE LINE THAT MATTERS. With this unset, the card never renders and the suite grades a reply the
// client never sees. NODE_ENV must NOT be "test": reconcileTurnReply returns early on that, which
// would skip the verifier — the exact layer that destroyed the answer in production.
process.env.APP_URL = process.env.APP_URL || "https://kamlife-coach-production.up.railway.app";
process.env.NODE_ENV = "production";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOMAIN_OWNERS } from "./domain-owners";

let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e: any) { failures.push(`  ✗ ${name}\n    ${e?.message || e}`); }
}

const NOW = Date.now();
const USER = {
  id: "test-user-production-parity",
  phoneNumber: "whatsapp:+27000000009",
  name: "Kam Test",
  onboardingState: "COMPLETE",
  subscriptionStatus: "active",
  popiConsent: true,
  popiConsentAt: new Date(NOW - 30 * 86_400_000),
  trialEndsAt: new Date(NOW + 30 * 86_400_000),
  subscriptionExpiresAt: new Date(NOW + 30 * 86_400_000),
  goalType: "fat_loss",
  calorieTarget: 2800,
  proteinTarget: 195,
  stepsTarget: 8500,
  currentWeight: "84.5",
  trainingMode: "gym",
  trainingDaysPerWeek: 3,
  programmePhase: 1,
  programmeWeek: 1,
  programmeDayInWeek: 2,
  programmeStartDate: new Date(NOW - 35 * 86_400_000),
  totalWorkoutsCompleted: 24,
  injuries: "none",
  medicalConditions: "none",
  awaitingInputType: null,
  profileNotes: "",
  lastActiveAt: new Date(NOW - 3600_000),
  createdAt: new Date(NOW - 35 * 86_400_000),
};

async function main() {
  const { handleMessage } = await import("../server/routes");
  // SEED THE STUB. Without this every message threw "Cannot read properties of undefined" and the
  // assertions passed against a fatal-fallback string — 8/8 green while nothing ran. A harness
  // that can pass without exercising the path is the defect it was written to catch.
  (globalThis as any).__KAMLIFE_STUB_USER = { ...USER };
  const say = async (msg: string): Promise<string> => {
    try { return String(await handleMessage(USER.phoneNumber, msg) ?? ""); }
    catch (e: any) { return `__THREW__ ${e?.message || e}`; }
  };

  // ── THE THREE FAILURES, AS FINAL CLIENT TEXT ──────────────────────────────────────────────
  const todays = await say("Today's progress");
  const mine = await say("my progress");
  const week = await say("this week");

  // The withhold string is the fingerprint of a correct answer destroyed on the way out. It must
  // never be what a progress question returns — that is the coach asking the customer to report
  // the thing they are paying the coach to know.
  const WITHHELD = /Let me not guess on that one|tell me what happened in your own words/i;
  for (const [name, reply] of [["today's progress", todays], ["my progress", mine], ["this week", week]] as const) {
    check(`"${name}" survives the mouth`, () => {
      assert.ok(!reply.startsWith("__THREW__"), `handler threw: ${reply}`);
      assert.ok(reply.trim().length > 0, "empty reply");
      // A pipeline that crashed returns a friendly apology. Green against THAT is a lie, and it
      // is how this harness first reported 8/8 while every message was failing.
      assert.ok(!/something went wrong on my side|give me a second and try again/i.test(reply),
        `the pipeline crashed and returned its fallback — the path never ran:\n      ${reply.slice(0, 120)}`);
      assert.ok(!WITHHELD.test(reply), `the verifier destroyed a progress answer:\n      ${reply.slice(0, 160)}`);
    });
  }

  // SHOW THE WORK. This harness once reported 8/8 while every message was crashing, so it prints
  // what it graded. A green you cannot read is the thing we are trying to stop trusting.
  for (const [n, r] of [["today's progress", todays], ["my progress", mine], ["this week", week]] as const) {
    console.log(`\n── ${n} ──\n${r.replace(/\[CARD:[^\]]*\]/g, "[card]").slice(0, 420)}`);
  }

  // ── OWNERSHIP, NOT PHRASING ───────────────────────────────────────────────────────────────
  // Asserting three expected strings would go green and prove nothing — a fourth synonym would
  // open the next hole. These assert the property: one owner, one truth, one next move.

  check("progress: no entry point invents its own scoreboard", () => {
    const misc = readFileSync("server/handlers/misc-commands.ts", "utf-8");
    const code = misc.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    // The old branch built progress from four `users` columns and never read the ledger. It also
    // printed "Day 35, week 1" — programmeStartDate against programmeWeek, two parallel
    // scoreboards contradicting each other inside one sentence.
    assert.ok(!/Day \*\$\{daysOn\}\*, week \*\$\{user\.programmeWeek/.test(code),
      "the user-row scoreboard is gone");
    assert.ok(/getProgressTruth/.test(code), "…and progress reads the canonical truth");
  });

  check("progress: the coach never advertises a command nobody owns", () => {
    const misc = readFileSync("server/handlers/misc-commands.ts", "utf-8");
    // It told clients "Send *this week*" while no handler matched it, so it fell to the model.
    if (/Send \*this week\*/.test(misc)) {
      assert.ok(/wantsWeek = \[[^\]]*"this week"/.test(misc),
        "'this week' is advertised but has no deterministic claimant");
    }
  });

  check("progress: the week ends in an instruction, not a question back", () => {
    assert.ok(!week.startsWith("__THREW__"), `handler threw: ${week}`);
    // The model's version closed with "What's one action you can take this week to boost your
    // protein intake?" — the coach handing the decision back to the client.
    assert.ok(!/\?\s*$/.test(week.trim()),
      `the weekly answer ends by asking the client what to do:\n      ${week.slice(-140)}`);
  });

  check("progress: every declared owner is reachable and none is the model", () => {
    const chain = readFileSync("server/routes.ts", "utf-8");
    const engineAt = chain.indexOf("handleGptBlock(");
    for (const d of DOMAIN_OWNERS) {
      for (const owner of d.owners) {
        const fn = `handle${owner.replace(/.*\//, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/\.ts$/, "").replace(/^./, ch => ch.toUpperCase())}(`;
        const at = chain.indexOf(fn);
        assert.ok(at > 0, `${owner} is never called from the chain`);
        assert.ok(at < engineAt, `${owner} runs after the model — the engine claims "${d.domain}" first`);
      }
    }
  });

  // ── THE HARNESS ITSELF MUST RUN THE PRODUCTION BRANCH ─────────────────────────────────────
  check("harness: the card branch is enabled, and the verifier is not skipped", async () => {
    const { cardBaseUrl } = await import("../server/macro-card-attach");
    assert.ok(cardBaseUrl().startsWith("http"), "APP_URL unset — CI would grade the no-card branch");
    const chatLog = readFileSync("server/handlers/chat-log.ts", "utf-8");
    assert.ok(/process\.env\.NODE_ENV === "test"/.test(chatLog), "reconcileTurnReply's test bypass exists");
    assert.notEqual(process.env.NODE_ENV, "test", "…and this harness must not take it");
  });

  console.log(`\nproduction-parity: ${passed}/${passed + failures.length} passed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    console.log(failures.join("\n\n"));
    console.log("\nThese are the replies a CLIENT receives, after the verifier. A green routing-audit");
    console.log("does not cover this: it asserts which handler claimed, on a branch production never runs.");
    process.exit(1);
  }
  console.log("✓ the final client response is what we think it is\n");
  process.exit(0); // open handles from the stubbed pipeline must not hang the suite
}

main().catch(e => { console.error("production-parity harness threw:", e); process.exit(1); });

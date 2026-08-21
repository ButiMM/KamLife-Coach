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

  // ── THE WEEKLY SYNONYMS, WHICH USED TO REACH A SECOND CALCULATOR ───────────────────────────
  // A fourth progress calculator (the WEEKLY PROGRESS CARD) owned these until 2026-08-20. It ran
  // its own four queries, bucketed days with a hand-rolled +2h offset instead of sastDayKey, and
  // measured weight over a 14-day window — so "my week" and "this week" described the same seven
  // days with different numbers, and which one a client got depended on the synonym they typed.
  //
  // The assertion is IDENTITY, not phrasing: one owner means one answer. A future second claimant
  // cannot satisfy this by coincidence — it would have to reproduce the owner's text exactly, at
  // which point it is not a second authority.
  const WEEKLY_DOORS = [
    "weekly stats", "progress card", "progress this week",
    "weekly progress", "my weekly", "my stats this week",
  ];
  const weeklyReplies: Array<readonly [string, string]> = [];
  for (const door of WEEKLY_DOORS) weeklyReplies.push([door, await say(door)] as const);

  for (const [door, reply] of weeklyReplies) {
    check(`"${door}" reaches the one weekly owner`, () => {
      assert.ok(!reply.startsWith("__THREW__"), `handler threw: ${reply}`);
      assert.ok(!/something went wrong on my side|give me a second and try again/i.test(reply),
        `the pipeline crashed and returned its fallback:\n      ${reply.slice(0, 120)}`);
      assert.ok(!WITHHELD.test(reply), `the verifier destroyed a progress answer:\n      ${reply.slice(0, 160)}`);
      assert.equal(reply, week,
        `"${door}" and "this week" describe the same seven days with different text — that is a\n`
        + `      second weekly authority, which is the defect this domain was converged to remove.\n`
        + `      "${door}": ${reply.slice(0, 160)}\n      "this week": ${week.slice(0, 160)}`);
    });
  }

  // ── THE DOORS THE REPORT CARD OWNS MUST NOT BE CLAIMED TWICE ───────────────────────────────
  // This assertion is the one that earned its place. The first draft of the convergence folded
  // "my week", "week report", "week card" and "weekly card" into the weekly owner — and the
  // identity check above went red, because the shareable report card in early-commands.ts matches
  // them and runs earlier in the chain. Both blocks looked like owners; only chain order decided.
  //
  // So this asserts the negative: those words reach the report card, and the weekly owner does not
  // also list them. A claimant that can never fire is not harmless — it is the next engineer's
  // evidence that the question is owned here, and it is how the fourth calculator survived.
  const REPORT_CARD_DOORS = ["my week", "week report", "week card", "weekly card"];
  for (const door of REPORT_CARD_DOORS) {
    const reply = await say(door);
    check(`"${door}" still reaches the report card, and only it`, () => {
      assert.ok(!reply.startsWith("__THREW__"), `handler threw: ${reply}`);
      assert.ok(/scorecard|save it, share it/i.test(reply),
        `the report card no longer answers "${door}":\n      ${reply.slice(0, 160)}`);
      assert.notEqual(reply, week, `"${door}" is being answered by the weekly text owner instead`);
    });
  }

  check("the weekly owner does not list a door the report card wins", () => {
    const misc = readFileSync("server/handlers/misc-commands.ts", "utf-8");
    const code = misc.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const claim = /const wantsWeek = ([\s\S]*?);\n/.exec(code);
    assert.ok(claim, "wantsWeek not found — this check is asserting nothing");
    for (const door of REPORT_CARD_DOORS) {
      // Delimited, not substring: "my weekly" legitimately belongs to the weekly owner and
      // contains "my week". A guard that fails on that gets switched off within a week.
      const listed = new RegExp(`["'\`|(]${door}["'\`|)]`, "i");
      assert.ok(!listed.test(claim[1]),
        `wantsWeek claims "${door}", which early-commands answers first — a claimant that can `
        + `never fire, which is exactly how the deleted weekly calculator survived four cuts`);
    }
  });

  // ── EVERY PROGRESS WINDOW READS THE ONE SOURCE ────────────────────────────────────────────
  // Five calculators answered progress questions across four windows — today, seven days, thirty
  // days and all-time — each with its own SQL. They are one owner now, called with a different
  // window. This asserts the property structurally: no progress door builds its own totals.
  check("no progress door computes its own totals", () => {
    const misc = readFileSync("server/handlers/misc-commands.ts", "utf-8");
    const code = misc.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    // The fingerprints of a SCOREBOARD, not of a history view. misc-commands still reads the log
    // tables directly for per-row renderings — the habit calendar, the step chart, the workout
    // diary, the weight graph — and that is legitimate: they show rows the truth object does not
    // carry, and they answer "show me my last N days", not "how am I doing". What must not come
    // back is a second set of TOTALS.
    assert.ok(!/SUM\(steps\)|COALESCE\(SUM/.test(code), "no hand-rolled step totals");
    assert.ok(!/programmeStartDate\)\.getTime\(\)/.test(code),
      "days-on-programme is derived once, in the truth object — not per progress door");
    // The users-row counter survives in exactly two non-progress roles, and they are named so a
    // third cannot appear quietly: a VETERAN GATE (>= 12 sessions unlocks supplements) and the
    // SESSION LABEL on a workout card ("Session 19"), which is a position in the programme rather
    // than a claim about progress. Neither is a reply to "how am I doing".
    const counterUses = code.split("\n").filter(l => /totalWorkoutsCompleted/.test(l));
    assert.equal(counterUses.length, 2,
      `the users-row workout counter is used ${counterUses.length} times; only the veteran gate and `
      + `the session label may use it. Progress totals come from workoutLogs via the truth object, `
      + `which the counter drifts from the moment one write fails:\n      `
      + counterUses.map(l => l.trim()).join("\n      "));
  });

  check("the weekly recap narrates the same week the client can ask for", () => {
    const recap = readFileSync("server/weekly-recap.ts", "utf-8");
    const code = recap.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.ok(/getProgressTruth/.test(code), "the Sunday voice note reads canonical truth");
    assert.ok(!/COUNT\(\*\) FROM workout_logs|AVG\(steps\)|COUNT\(DISTINCT DATE\(logged_at\)\) AS days/.test(code),
      "…and no longer counts the same week a second time");
  });

  check("the deleted weekly calculator has not grown back", () => {
    const misc = readFileSync("server/handlers/misc-commands.ts", "utf-8");
    const code = misc.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    // Its fingerprints: the card heading, the screenshot close, and its own chat label. Any of
    // them reappearing means a weekly scoreboard is being built outside getProgressTruth again.
    assert.ok(!/Week \$\{weekNum\}|Week Summary/.test(code), "the Week N Summary card is gone");
    assert.ok(!/Screenshot this and send it/.test(code), "…and its closing line with it");
    assert.ok(!/PROGRESS_CARD/.test(code), "…and no handler still logs under PROGRESS_CARD");
  });

  // SHOW THE WORK. This harness once reported 8/8 while every message was crashing, so it prints
  // what it graded. A green you cannot read is the thing we are trying to stop trusting.
  for (const [n, r] of [["today's progress", todays], ["my progress", mine], ["this week", week]] as const) {
    console.log(`\n── ${n} ──\n${r.replace(/\[CARD:[^\]]*\]/g, "[card]").slice(0, 420)}`);
  }
  console.log(`\n── weekly synonyms ──\n${WEEKLY_DOORS.length} doors, all identical to "this week": `
    + `${weeklyReplies.every(([, r]) => r === week) ? "yes" : "NO"}`);

  // ── THE SICK HOLD MUST ACCEPT THE EXIT IT ADVERTISES ──────────────────────────────────────
  // 2026-08-21, Kam's handset: at 06:00 the brief said "Hope you're feeling better. When you're
  // ready, just say Hi and we pick up from where you left off." He said Hi. Nothing cleared, so
  // the same message arrived the next morning. The coach asked for a password it would not accept.
  //
  // Graded here rather than in a unit test because the failure was a DISAGREEMENT between two
  // files — the mouth in morning-message.ts and the door in sick-flow.ts — and only the final
  // client reply shows whether they agree.
  {
    const SICK_UNTIL = new Date(NOW + 2 * 86_400_000).toISOString().slice(0, 10);
    const SICK_SINCE = new Date(NOW - 2 * 86_400_000).toISOString().slice(0, 10);
    (globalThis as any).__KAMLIFE_STUB_USER = {
      ...USER,
      profileNotes: `sick_since:${SICK_SINCE} | sick_until:${SICK_UNTIL} | paused_until:${SICK_UNTIL}`,
    };
    const greetingReply = await say("Hi");
    (globalThis as any).__KAMLIFE_STUB_USER = { ...USER };

    check("a client on a health hold can leave it the way the brief told them to", () => {
      assert.ok(!greetingReply.startsWith("__THREW__"), `handler threw: ${greetingReply}`);
      assert.ok(/welcome back/i.test(greetingReply),
        `"Hi" from a client on a sick hold did not end it — the 06:00 brief promises exactly this\n`
        + `      and this is the reply that arrives instead:\n      ${greetingReply.slice(0, 200)}`);
    });

    // ── THE LIFECYCLE HAS A TERMINAL STATE ──────────────────────────────────────────────────
    // The hold used to end only when a message ended it. Nothing swept the tokens, and one reader
    // never checked the date at all — so a client could be described as ill indefinitely. Expiry
    // is derived on read now; this proves it at the final outbound text, not in a unit test.
    const EXPIRED_SINCE = new Date(NOW - 40 * 86_400_000).toISOString().slice(0, 10);
    const EXPIRED_UNTIL = new Date(NOW - 30 * 86_400_000).toISOString().slice(0, 10);
    (globalThis as any).__KAMLIFE_STUB_USER = {
      ...USER,
      profileNotes: `sick_since:${EXPIRED_SINCE} | sick_until:${EXPIRED_UNTIL} | paused_until:${EXPIRED_UNTIL}`,
    };
    const staleAsk = await say("what workout do I have today");
    (globalThis as any).__KAMLIFE_STUB_USER = { ...USER };

    check("a hold that aged out no longer speaks", () => {
      assert.ok(!staleAsk.startsWith("__THREW__"), `handler threw: ${staleAsk}`);
      assert.ok(!/you'?re resting until|hope you'?re feeling better|no training pushes/i.test(staleAsk),
        `a hold that ended 30 days ago is still treating the client as ill:\n      ${staleAsk.slice(0, 200)}`);
    });

    check("the state owner agrees with itself across the lifecycle", async () => {
      const { readHealthState } = await import("../server/health-state");
      const day = (o: number) => new Date(NOW + o * 86_400_000).toISOString().slice(0, 10);
      const notes = `sick_since:${day(-9)} | sick_until:${day(-30)} | paused_until:${day(-30)}`;
      const st = readHealthState({ profileNotes: notes }, day(0));
      assert.equal(st.phase, "ended");
      assert.equal(st.isSick, false, "an aged-out hold is not illness");
      assert.equal(st.pause, null, "…and it holds nothing");
    });

    check("the brief and the door use the same words", () => {
      const brief = readFileSync("server/morning-message.ts", "utf-8");
      const sick = readFileSync("server/handlers/sick-flow.ts", "utf-8");
      // If the sick brief tells the client to greet, the sick handler must read greetings. Tying
      // the assertion to the advertised text means rewording the brief cannot quietly break it.
      if (/just say Hi/i.test(brief)) {
        assert.ok(/isBareGreeting/.test(sick),
          "the morning brief tells a sick client to say Hi, and sick-flow does not accept a greeting");
      }
    });
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

Warning: truncated output (original token count: 57463)
Total output lines: 3604

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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DOMAIN_OWNERS } from "./domain-owners";
import { assertCustomerOutcome, reportPending } from "./outcome";

let passed = 0;
const failures: string[] = [];

/**
 * AWAITED, DELIBERATELY (2026-08-21). This took `() => void` and did `try { fn(); passed++ }`.
 * An async check therefore incremented `passed` the instant its promise was created — the
 * assertions inside ran later, and a rejection surfaced as an unhandled promise, not a failure.
 * Two checks in this file were already written async, so two of its greens meant nothing.
 *
 * That is the same defect this harness exists to catch, for the third time: a suite that can
 * report success without exercising what it claims to grade.
 */
const pending: Array<Promise<void>> = [];
function check(name: string, fn: () => void | Promise<void>) {
  const record = (e: any) => failures.push(`  ✗ ${name}\n    ${e?.message || e}`);
  try {
    const r = fn();
    if (r instanceof Promise) pending.push(r.then(() => { passed++; }, record));
    else passed++;
  } catch (e: any) { record(e); }
}

/**
 * WATCHING WHAT A TURN WROTE, WITHOUT TWO CHECKS FIGHTING OVER console.log (2026-08-22).
 *
 * The first version of this saved and restored console.log per call. Two async checks doing that
 * concurrently leaves one override permanently installed — the suite's own tally went into an
 * array and the run printed nothing while exiting 1. A single tee, installed once, plus a queue
 * that serialises every check which drives a turn: slices cannot interleave because turns cannot.
 */
const CONSOLE_LINES: string[] = [];
const REAL_LOG = console.log;
console.log = (...a: any[]) => { CONSOLE_LINES.push(a.map(String).join(" ")); REAL_LOG(...a); };
let turnQueue: Promise<unknown> = Promise.resolve();
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = turnQueue.then(fn, fn);
  turnQueue = next.catch(() => {});
  return next;
}

const sastDayKeyOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
/**
 * Midday on a past weekday the client can NAME — for fixtures that correct a named day.
 *
 * WHY NOT "LAST SATURDAY". The Saturday version was already computed rather than hard-coded, so
 * that the fixture would not depend on which weekday the suite runs. It still did: on a SUNDAY the
 * most recent past Saturday IS yesterday, the coach correctly answers "yesterday's breakfast"
 * because that is the truer thing to call it, and the check demanding the word "Saturday" went red
 * once a week on the calendar rather than on the code.
 *
 * Three days back is never today and never yesterday, on any day of the week, so the day has a
 * name the coach must use. The name is returned with the date so the assertion asks for the day
 * this fixture actually seeded.
 */
function namedPastDay(): { at: Date; name: string } {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - 3);
  return { at: d, name: new Intl.DateTimeFormat("en-ZA", { weekday: "long", timeZone: "Africa/Johannesburg" }).format(d) };
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

  check("the weekly image and the weekly text derive from one object", () => {
    // NOT byte-identity. "my week" renders an image and "this week" renders text; different
    // presentation is fine. What is not fine is different TRUTH. The report card must read the
    // canonical object rather than query for itself.
    const card = readFileSync("server/report-card.ts", "utf-8");
    const code = card.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/getProgressTruth\(/.test(code), "the shareable card reads the canonical progress object");
    assert.ok(!/db\.select\(|pool\.query\(/.test(code),
      "the shareable card queries for itself — that is a second truth behind a second renderer");
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
    // POSITIVE FORM (item 1.2): the title claims it ends in an INSTRUCTION, so that is asserted.
    // "does not end in ?" was satisfied by any statement at all, including a non-answer.
    assertCustomerOutcome(week, {
      got: /\b(get|keep|add|hit|log|walk|eat|train|aim|start|stick|focus|send|take|tell|give|reply|show|pick|drop|do|make|repeat|carry|hold|stay|put|choose|move)\b/i,
      notGot: /\?\s*$/,
      because: "the week must end in something the client can do, not a question handed back",
    });
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

  // ── TARGETS: ONE CALCULATION, MANY WRITERS ────────────────────────────────────────────────
  // Nine files write calorie/protein/step targets. That is fine — they are writers. What would
  // not be fine is a second CALCULATION, so that two of them could hand the same client different
  // numbers. Asserted structurally: every writer routes through targets.ts.
  check("targets have one calculation, and every writer uses it", () => {
    const targetWriters = [
      "server/onboarding.ts", "server/handlers/lifecycle.ts", "server/handlers/weight.ts",
      "server/handlers/workout.ts", "server/handlers/media.ts", "server/handlers/early-commands.ts",
    ];
    for (const f of targetWriters) {
      const src = readFileSync(f, "utf-8");
      if (!/calorieTarget:\s*(?!user|Number|null)/.test(src)) continue;
      assert.ok(/calculateTargets|recalcTargetsForProfile/.test(src),
        `${f} sets a target without calling the one calculation in server/targets.ts`);
    }
  });

  check("the client-facing target answer reads stored state, not a recomputation", async () => {
    const targets = await say("my targets");
    assert.ok(!targets.startsWith("__THREW__"), `handler threw: ${targets}`);
    assert.ok(new RegExp(String(USER.calorieTarget)).test(targets),
      `"my targets" does not report the stored calorie target:\n      ${targets.slice(0, 160)}`);
    assert.ok(new RegExp(String(USER.proteinTarget)).test(targets),
      `"my targets" does not report the stored protein target:\n      ${targets.slice(0, 160)}`);
  });

  // ── QUESTIONS: FACTUAL FIRST, JUDGMENT TO THE MODEL ───────────────────────────────────────
  // A factual question whose answer is already in authoritative state must never be sent to the
  // model to reconstruct — that is how "this week" got invented averages. The test is that the
  // reply carries the HELD NUMBER, which a model answering from prose could only match by luck.
  check("factual questions are answered from state", async () => {
    const steps = await say("what are my steps");
    const target = await say("my targets");
    for (const [q, r] of [["what are my steps", steps], ["my targets", target]] as const) {
      assert.ok(!r.startsWith("__THREW__"), `"${q}" threw: ${r}`);
      assert.ok(!/something went wrong on my side/i.test(r), `"${q}" crashed the pipeline`);
      assert.ok(r.trim().length > 0, `"${q}" returned nothing`);
    }
    assert.ok(/8[,.]?500|steps/i.test(steps), `"what are my steps" did not answer from state:\n      ${steps.slice(0, 160)}`);
  });

  check("judgment questions are not hijacked by a deterministic scoreboard", async () => {
    // "I'm struggling" is a life question. The failure this guards is a scorecard being fired at
    // it — the exact defect despair.ts was written for. It must not come back as a numbers dump.
    const struggle = await say("I'm struggling with all of this");
    assert.ok(!struggle.startsWith("__THREW__"), `handler threw: ${struggle}`);
    // POSITIVE FORM: absence of a scoreboard was satisfied by silence or a crash fallback. What
    // the client needs is to be ANSWERED — the struggle acknowledged in words.
    assertCustomerOutcome(struggle, {
      got: /\b(hear|heard|tough|hard|rough|with you|start|small|one thing|talk|going on|not alone)\b/i,
      notGot: /Days logged|Avg: \*|last 7 days|Sessions:/i,
      because: "a client saying they are struggling must be answered, not handed a scoreboard",
    });
  });

  // ── PROACTIVE: ONE DECISION OWNER, NO SECOND POLICY ───────────────────────────────────────
  check("morning and the one-action command share the decision owner", () => {
    const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
    const cmd = readFileSync("server/handlers/one-action-command.ts", "utf-8");
    for (const [name, src] of [["morning", morning], ["one-action command", cmd]] as const) {
      assert.ok(/decideProactive\(/.test(src), `${name} does not run the decision owner`);
    }
    // decideProactive wraps chooseAction with the evidence gate; both live in one-action.ts, so
    // there is one decision module, not two policies.
    const owner = readFileSync("server/one-action.ts", "utf-8");
    assert.ok(/export function decideProactive/.test(owner) && /export function chooseAction/.test(owner),
      "the evidence gate and the decision live in the same owner");
    assert.ok(/chooseAction\(dayStateFrom/.test(owner),
      "decideProactive must DELEGATE to chooseAction, not decide for itself");
  });

  check("the morning brief reads health state, never a keyword scan", () => {
    const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
    assert.ok(!/wasSickOrInjured|SICK_PATTERNS/.test(morning), "no keyword sickness scan");
    assert.ok(/state\.health\.sickYesterday/.test(morning), "…it asks the snapshot");
  });

  // ── TURN AUTHORITY: ONE FINAL-ANSWER OWNER PER INBOUND MESSAGE ────────────────────────────
  // Domain ownership can be correct while TURN ownership is still ambiguous. The engine used to
  // be invoked twice in one turn, from the same function, either call able to end it — two
  // independent final-answer opportunities separated only by chain position, and applying
  // opposite policy about the same message.
  // ── THE TURN BOUNDARY IS STRUCTURAL, NOT LEXICAL ─────────────────────────────────────────
  // The engine used to sit ABOVE six deterministic owners, protected only by mustStayDeterministic
  // — a phrase-based DENY-LIST. Measured against the phrases those rails actually own, 7 of 16
  // leaked, including "this week", the phrase this whole convergence was about. A deny-list makes
  // the leak unlikely; position makes it impossible.
  check("the engine cannot take a turn a deterministic owner would claim", () => {
    const chain = readFileSync("server/routes.ts", "utf-8");
    const code = chain.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    const engineAt = code.indexOf("runMeaningEngineLive(");
    assert.ok(engineAt > 0, "the engine is invoked");
    // Every deterministic owner must be ASKED before the engine is given the turn.
    for (const rail of ["handleEarlyCommands(", "handleWorkoutCommands(", "handleWater(",
                        "handleFoodContext(", "handleMiscCommands(", "handleLifecycle("]) {
      const at = code.indexOf(rail);
      assert.ok(at > 0, `${rail} is not in the chain`);
      assert.ok(at < engineAt,
        `${rail} runs AFTER the engine. The engine can then consume a turn that rail owns, and the `
        + `only thing standing between them is a phrase list — which is how "this week" leaked.`);
    }
    // …and the engine still runs before the model fallback, so it is the judgment path, not a peer.
    const gptAt = code.indexOf("handleGptBlock(");
    assert.ok(engineAt < gptAt, "the engine must precede the gpt fallback");
  });

  // SOURCE ORDER IS NOT ENOUGH. `indexOf(misc) < indexOf(engine)` proves only that misc is
  // earlier — not that a rail-owned phrase ever REACHES misc. A phrase the rails fail to
  // recognise still falls through to the engine and gets a model answer. So this drives the real
  // production path and asserts the final text, for the phrases that leaked when measured.
  const RAIL_OWNED: Array<[string, RegExp]> = [
    ["this week",         /last 7 days/i],
    ["my targets",        /Your Targets|Daily Targets/i],  // early-commands claims it, not misc
    ["all time",          /Journey with Coach K/i],
    ["transformation",    /Monthly Transformation Report/i],
    ["what are my steps", /steps/i],
    ["my week",           /scorecard|save it, share it/i],
    ["my progress",       /Progress/i],
    ["today's progress",  /kcal|logged|progress/i],
  ];
  const railReplies: Array<readonly [string, string]> = [];
  for (const [door] of RAIL_OWNED) railReplies.push([door, await say(door)] as const);

  for (const [door, expected] of RAIL_OWNED) {
    const reply = railReplies.find(([d]) => d === door)![1];
    check(`"${door}" is answered by its rail, not by the model`, () => {
      assert.ok(!reply.startsWith("__THREW__"), `handler threw: ${reply}`);
      // The engine and gpt fallback both tag themselves on the coach path; on a client path they
      // announce themselves differently — the reliable signal is that the RAIL's own shape came
      // back. A model answering this phrase cannot reproduce the rail's card.
      assert.match(reply, expected,
        `"${door}" did not get its rail's answer. It fell through to a model path, which is the `
        + `fallback-claimant hole: ordering is green while the phrase never reaches its owner.\n`
        + `      got: ${reply.slice(0, 180)}`);
    });
  }

  check("the meaning engine gets one shot per turn, not two", () => {
    const chain = readFileSync("server/routes.ts", "utf-8");
    const code = chain.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    const calls = (code.match(/runMeaningEngineLive\(/g) || []).length;
    assert.equal(calls, 1,
      `runMeaningEngineLive is invoked ${calls} times in one turn. More than one is more than one `
      + `chance to produce the final answer, and the second can win a turn the first declined.`);
  });

  check("the engine gate is evaluated once, and cannot disagree with itself", () => {
    const chain = readFileSync("server/routes.ts", "utf-8");
    const code = chain.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    const gates = (code.match(/mustStayDeterministic\(/g) || []).length;
    assert.equal(gates, 1,
      `mustStayDeterministic is evaluated ${gates} times in the chain. It is a routing seam, not an `
      + `authority — evaluated once it cannot admit a message at one point and exclude it at another.`);
  });

  check("the verifier is downstream of the answer, and decides nothing", () => {
    // STRUCTURE, not position in a file. handleMessage wraps routeMessage in inTurn, and inTurn
    // applies reconcileTurnReply to whatever routeMessage RETURNED. So the verifier can only ever
    // see a reply some path already chose: it is incapable of pre-empting an owner, whatever it
    // decides to do with the text.
    const chain = readFileSync("server/routes.ts", "utf-8");
    assert.ok(/return inTurn\([\s\S]{0,200}?routeMessage\(/.test(chain),
      "the whole chain runs inside one turn wrapper");
    const log = readFileSync("server/handlers/chat-log.ts", "utf-8");
    assert.ok(/const result = await fn\(\);[\s\S]{0,400}?reconcileTurnReply\(turnStore\.getStore\(\)!, result\)/.test(log),
      "reconciliation runs on the chain's own return value, downstream of every owner");
    // It may block and it may explain. It may not pick the coaching action.
    const verifier = readFileSync("server/brain/reply-verifier.ts", "utf-8");
    assert.ok(!/chooseAction\(|decideProactive\(/.test(verifier),
      "the verifier calls the decision owner — that would make it a second decision point");
  });

  // ── ONE DECISION FUNCTION IS NOT ENOUGH; ONE DECISION CONTRACT IS ────────────────────────
  // Pinning call sites by name was the wrong fix — it fossilises two policies instead of removing
  // one. chooseAction was reached three ways: inside decideProactive (evidence-gated), by
  // morning's degraded fallback, and by the reactive weekly answer. The last two prescribed on
  // evidence the gate would have refused. The contract is one line — A PRESCRIPTION REQUIRES
  // EVIDENCE — and every caller outside the gate now applies it through underPolicy().
  check("every decision call outside the gate applies the policy contract", () => {
    const owner = "server/one-action.ts";
    const offenders: string[] = [];
    for (const f of ["server/one-action.ts", "server/scheduler/jobs/morning.ts",
                     "server/handlers/misc-commands.ts", "server/handlers/one-action-command.ts",
                     "server/handlers/gpt-block.ts", "server/handlers/early-commands.ts",
                     "server/handlers/lifecycle.ts", "server/routes.ts",
                     "server/weekly-recap.ts", "server/report-card.ts"]) {
      const code = readFileSync(f, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
      for (const line of code.split("\n")) {
        if (!/(?<!function )\bchooseAction\(/.test(line)) continue;
        if (f === owner) continue;                       // the gate itself
        if (/underPolicy\(\s*chooseAction\(/.test(line)) continue;  // the contract, applied
        offenders.push(`${f}: ${line.trim().slice(0, 80)}`);
      }
    }
    assert.deepEqual(offenders, [],
      `a caller reaches the decision owner without the policy contract. Either run decideProactive `
      + `or wrap it in underPolicy(). Otherwise the same function carries two policies:\n      `
      + offenders.join("\n      "));
  });

  check("there is one constitution — no second ladder for 'what should they do next'", () => {
    // theNextMove() was a SECOND ranked ladder (training → protein → calories → steps → scale)
    // with its own thresholds and its own evening branch, appended to BOTH the engine's reply and
    // the GPT fallback's. Two ladders answering one question is two decision owners whatever the
    // second is called — and this one could contradict what the deterministic surfaces told the
    // same client the same morning.
    for (const f of ["server/education.ts", "server/understanding/live.ts",
                     "server/handlers/gpt-block.ts", "server/reply-hygiene.ts"]) {
      const code = readFileSync(f, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
      assert.ok(!/\btheNextMove\s*\(/.test(code), `${f} still calls the deleted second constitution`);
    }
  });

  // ── THE DECISION IS DECLARED BEFORE THE PROSE, NOT INFERRED AFTER IT ──────────────────────
  //
  //     authoritative state → chooseAction → canonicalTodo → GPT renders → validated against it
  //
  // The old order was the reverse: the model wrote whatever it liked, tellDontAsk stapled the
  // decision on afterwards, and a verifier tried to work out from English what the model had
  // decided. canonicalDecision reads state and never the reply, so nothing ever forced it to run
  // late — it just always had.
  // ── THE BEHAVIOURAL INSTRUCTION COMES FROM THE CANONICAL RENDERER ─────────────────────────
  check("every model exit is covered, not only the ones that see the brief", () => {
    // TEN exits reach WhatsApp: the main Coach-K call and its two fallbacks, four specialist
    // agents, and the punct / short / frustration replies. Only three ever saw decisionBrief —
    // the other seven return early. Enforcement therefore belongs at the ONE place every reply
    // crosses, not in the prompt of the paths that happen to read it.
    const log = readFileSync("server/handlers/chat-log.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    // Asserted as WIRING, not as a word appearing somewhere: the real function must be imported
    // from the verifier, its result must be used, and the canonical instruction must be appended.
    // A first draft checked only that the name appeared, and a control that stubbed the import
    // left it green — a guard that cannot fail is not a guard.
    assert.ok(/stripModelDirectives\s*\}\s*=\s*await import\("\.\.\/brain\/reply-verifier"\)/.test(log),
      "the chokepoint must import the real strip from the verifier, not a local stand-in");
    assert.ok(/const \{ kept, removed \} = stripModelDirectives\(draft, scope\.evidence\)/.test(log),
      "…and run it on the draft with this turn's evidence");
    assert.ok(/draft = kept;/.test(log), "…and actually use what survived");
    assert.ok(/scope\.evidence\.canonicalTodo/.test(log), "…reads the canonical decision");
    assert.ok(/composeDecisionTurn/.test(log) && /renderActionLine/.test(log),
      "…and renders the instruction with the canonical composer, not by concatenating GPT prose");
    assert.ok(/situationFrame/.test(log), "context is structured situation, not model draft");
    const gpt = readFileSync("server/handlers/gpt-block.ts", "utf-8");
    const code = gpt.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    // The decision must be computed before the FIRST exit, not before the last one.
    const decidedAt = code.indexOf("await canonicalDecision(");
    for (const exit of ["gpt_punct", "gpt_short", "gpt_frust", "nutritionAgent(",
                        "programmingAgent(", "mindsetAgent(", "adminAgent("]) {
      const at = code.indexOf(exit);
      assert.ok(at > 0, `${exit} is not in gpt-block`);
      assert.ok(decidedAt > 0 && decidedAt < at,
        `${exit} can return before the canonical decision is computed, so its reply would carry none`);
    }
  });

  // ── THE DIRECTIVE SLOT IS DETERMINISTIC; THE PROSE SLOT CARRIES NO INSTRUCTION ────────────
  check("no model exit bypasses the response boundary", () => {
    // Found 2026-08-21: resumeEngineConfirm returned model text and hand-rolled the coach suffix
    // instead of calling tag(), so `modelAuthored` was never set and reconcileTurnReply skipped
    // the whole boundary. An ELEVENTH exit, and the only one that reached WhatsApp without
    // crossing it. Asserted structurally: every model reply leaves through tag().
    const chain = readFileSync("server/routes.ts", "utf-8");
    const code = chain.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    for (const [line, i] of code.split("\n").map((l, i) => [l, i] as const)) {
      if (!/_· \$\{?src|🧠 new engine ·_|gpt fallback ·_/.test(line)) continue;
      // The only place that may compose the coach suffix is tag() itself.
      assert.ok(/const tag = /.test(code.split("\n")[i - 1] || "") || /recordReplyPath/.test(code.split("\n").slice(Math.max(0, i - 3), i + 1).join(" ")),
        `a model reply composes the coach suffix outside tag(), so it never marks the turn `
        + `model-authored and the boundary never sees it: ${line.trim().slice(0, 90)}`);
    }
    assert.ok(/turnEvidence\(\{ modelAuthored: true \}\)/.test(code), "tag() marks the turn");
    // tag() must be in scope for the FIRST model exit, not only the last ones.
    const tagAt = code.indexOf("const tag = ");
    const firstExit = code.indexOf("resumeEngineConfirm(");
    assert.ok(tagAt > 0 && firstExit > 0 && tagAt < firstExit,
      "the chokepoint must be in scope before the first model exit in the function");
  });

  check("clarification is a different response mode from coaching", () => {
    const chain = readFileSync("server/routes.ts", "utf-8");
    const code = chain.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    const lines = code.split("\n");
    // Both clarification exits must declare themselves — otherwise a question the coach asked
    // gets a coaching instruction stapled underneath it.
    for (const marker of ["food force-clarify", "return tag(confirmReply"]) {
      const at = lines.findIndex(l => l.includes(marker));
      assert.ok(at > 0, `${marker} not found`);
      const window = lines.slice(Math.max(0, at - 3), at + 1).join(" ");
      assert.ok(/conversationalOnly: true/.test(window),
        `${marker} is model-tagged but not marked a clarification, so it would gain a coaching todo`);
    }
    const gpt = readFileSync("server/handlers/gpt-block.ts", "utf-8");
    const gcode = gpt.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(((gcode.match(/conversationalOnly: true/g) || []).length) >= 3,
      "the punct, short and frustration exits must each declare themselves clarification");
  });

  // ── ONE ACTION LINE, RENDERED BY CODE ─────────────────────────────────────────────────────
  // A decision turn carries EXACTLY ONE behavioural instruction and code owns it. The model keeps
  // empathy, context and explanation; the action line is rendered from canonicalTodo and stands
  // alone, so "how many instructions did this turn send" has a countable answer.
  // ── STRICT BOUNDARY: A DECISION TURN CARRIES NO MODEL PROSE ───────────────────────────────
  // 2026-08-21 live acceptance failure. Stripping recognised directives was not enough:
  //
  //     canonical REST → "Today's a chest day."  →  "Rest today…"
  //
  // "Today's a chest day" has no imperative verb and no advisory shape, so nothing matched it and
  // it shipped directly above the opposite instruction. Every design that keeps free model prose
  // on a decision turn has this hole, because recognising an instruction in arbitrary English is
  // the thing that cannot be done. So the customer sees the deterministic reply and nothing the
  // model wrote — one behavioural instruction, because there is exactly one sentence that could
  // be one and code wrote it.
  check("a decision turn cannot carry a contradictory instruction, in any phrasing", async () => {
    const { formatOneAction } = await import("../server/one-action");
    // Mirrors reconcileTurnReply on a decision turn.
    const decisionReply = (act: any) => formatOneAction(act, "Kam");
    const A = (kind: string, todo: string, why: string) => ({ kind, todo, why }) as any;
    const CASES: Array<[string, any, RegExp]> = [
      ["REST vs train language",   A("rest", "Rest today — your body is doing the work.", "Recovery is where the adaptation happens."), /chest|train|gym/i],
      ["TRAIN vs rest language",   A("train", "Get today's session done.", "The hardest one to start is the one that counts."), /take it easy|no need to push/i],
      ["PROTEIN vs food denial",   A("protein", "Make your next meal a proper protein meal.", "Protein is what protects your muscle."), /skip dinner/i],
      ["LOG vs don't-log",         A("log", "Log one meal today. Any meal.", "One meal puts you straight back in it."), /no need to log/i],
      ["WALK vs don't-walk",       A("walk", "Get a 20-minute walk in today.", "Easiest win there is on a bad day."), /don.t bother/i],
      ["WEIGH vs don't-weigh",     A("weigh", "Weigh in tomorrow morning.", "One number, same conditions, no drama."), /stay off the scale/i],
    ];
    for (const [label, act, contradiction] of CASES) {
      const out = decisionReply(act);
      assert.ok(!contradiction.test(out), `${label}: the model's contradiction reached the client`);
      assert.ok(out.includes(act.todo), `${label}: the canonical instruction is missing`);
      assert.equal((out.match(/^\*[^*]+\*$/gm) || []).length, 1,
        `${label}: a decision turn must carry exactly one behavioural instruction`);
    }
  });

  check("the boundary keeps situation prose and still lands the canonical line", () => {
    const log = readFileSync("server/handlers/chat-log.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/composeDecisionTurn/.test(log), "decision turns must be composed in code");
    assert.ok(/situationFrame/.test(log), "context is the structured situation, not GPT prose");
    assert.ok(!/draft = `\$\{draft\}\\n\\n\$\{rendered\}`/.test(log),
      "NEGATIVE CONTROL: concatenating model prose in front of the action reopens Eggs tonight");
  });

  check("a decision turn sends exactly one instruction, and code wrote it", async () => {
    const { composeDecisionTurn, renderActionLine } = await import("../server/one-action");
    const { frameSituationForClient, extractSalientSituation } = await import("../server/memory");
    const lines = (x: string) => (x.match(/^\*[^*]+\*$/gm) || []).length;

    const PROTEIN = "Make your next meal a proper protein meal.";
    const REST = "Rest today — your body is doing the work.";
    const action = renderActionLine(PROTEIN);

    const a = composeDecisionTurn("", action);
    assert.equal(a, action);
    assert.equal(lines(a), 1);
    assert.ok(!/eggs|chicken|how about|tough week/i.test(a),
      "model prose is not an input to a decision turn");

    const frame = frameSituationForClient(extractSalientSituation([
      "That day is today. Girlfriend's birthday. Going to restaurants.",
    ]));
    const b = composeDecisionTurn(frame, action);
    assert.ok(/birthday outing/i.test(b), "birthday situation is code-rendered context");
    assert.ok(b.includes(action) || b.includes("protein"));
    assert.equal(lines(b), 1);
    assert.ok(!/chicken|eggs tonight|how about/i.test(b));

    const rest = composeDecisionTurn("", renderActionLine(REST));
    assert.ok(!/gym session|go with a light/i.test(rest));
    assert.ok(/Rest today/i.test(rest));

    // HOLD: composeDecisionTurn with empty action ships context only, no instruction.
    assert.equal(composeDecisionTurn("Enjoy the outing.", ""), "Enjoy the outing.");

    // NEGATIVE CONTROL: the old concatenate-GPT-then-action architecture.
    const leaked = composeDecisionTurn("Eggs tonight.", action);
    assert.ok(/eggs tonight/i.test(leaked),
      "NEGATIVE CONTROL: putting model prose in the situation slot reopens the second decision");
    const log = readFileSync("server/handlers/chat-log.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(!/composeDecisionTurn\(draft/.test(log) && /composeDecisionTurn\(String\(scope\.evidence\.situationFrame/.test(log),
      "the chokepoint must pass situationFrame, not the model draft, into composeDecisionTurn");
  });

  check("the residue is instrumented for beta, not argued about", () => {
    const sc = readFileSync("server/self-check.ts", "utf-8");
    assert.ok(/coachdirective:\$\{onDecisionTurn \? "stripped_on_action" : "stripped_on_hold"\}/.test(sc),
      "a stripped model instruction must be counted, separately for hold and decision turns");
    const log = readFileSync("server/handlers/chat-log.ts", "utf-8");
    assert.ok(/recordDirectiveStripped\(decisionTurn\)/.test(log),
      "…and the boundary must actually record it");
  });

  check("the model's own instruction never survives, licensed or not", async () => {
    const { stripModelDirectives } = await import("../server/brain/reply-verifier");
    const render = (reply: string, todo: string, opts: Record<string, unknown> = {}) => {
      const ev = { modelAuthored: true, canonicalTodo: todo, ...opts } as any;
      const { kept } = stripModelDirectives(reply, ev);
      const t = ev.conversationalOnly ? "" : todo;
      return t && !kept.toLowerCase().includes(t.toLowerCase().replace(/[.!]$/, ""))
        ? (kept ? `${kept}\n\n${t}` : t) : kept;
    };
    const PROTEIN = "Make your next meal a proper protein meal.";
    const REST = "Rest today — your body is doing the work.";
    const TRAIN = "Get today's session done.";
    const LOG = "Log one meal today. Any meal.";

    // THE CONTRADICTION CLASS, closed by construction rather than by better patterns. Licensing a
    // same-DOMAIN model directive sent "Go train today." and "Rest today." in one message.
    const rest = render("You're wiped. Go train today.", REST);
    assert.ok(!/go train/i.test(rest), "a contradictory instruction reached the client");
    assert.ok(rest.includes("Rest today"), "…and the canonical one did not");
    const prot = render("Long day. You should skip dinner.", PROTEIN);
    assert.ok(!/skip dinner/i.test(prot) && prot.includes(PROTEIN));

    // The canonical instruction is rendered on every kind of turn.
    assert.ok(render("You're in a good rhythm.", TRAIN).includes(TRAIN));
    assert.ok(render("No stress about yesterday.", LOG).includes("Log one meal today"));

    // An invented number cannot ride in on a directive.
    assert.ok(!/1800/.test(render("Drop your calories to 1800.", PROTEIN)));

    // Empathy and context survive on HOLD — that is what the model is for there.
    assert.ok(/hard few days/.test(render("I hear you. That sounds like a hard few days.", "")));

    // HOLD still strips recognised directives. Decision-turn plates are a different test:
    // composeDecisionTurn does not take model prose as an input, so they cannot sit above PROTEIN.
    const hold = render("How about a 20-minute walk today?", "");
    assert.ok(!/walk/i.test(hold), "HOLD must not acquire a walk");

    // A clarification does not acquire a coaching instruction just for crossing a model path.
    const clar = render("Did you mean 500g or 50g?", LOG, { conversationalOnly: true });
    assert.ok(!/Log one meal/i.test(clar) && /500g or 50g/.test(clar));

    // Deterministic replies are a different authority and are untouched.
    const det = stripModelDirectives("Drop your calories to 1,800.", { modelAuthored: false } as any);
    assert.equal(det.kept, "Drop your calories to 1,800.");
  });

  // THE LIMIT, PRINTED RATHER THAN FILED. Two phrasings the boundary does not close, and the
  // reason closing them by pattern is not a fix: both require open-ended vocabularies — every
  // hedge ("maybe", "perhaps", "no harm in"), and every food noun in South Africa. The residue
  // closes when the model stops emitting free prose, not when this list grows.
  {
    const { stripModelDirectives } = await import("../server/brain/reply-verifier");
    const OPEN = ["Maybe take it easy today.", "Eggs tonight."];
    const surviving = OPEN.filter(r =>
      stripModelDirectives(r, { modelAuthored: true, canonicalTodo: "" } as any).removed.length === 0);
    console.log(`\n── directive boundary: known-open ──\n${surviving.length} of ${OPEN.length} `
      + `soft phrasings still reach the client on a CONTINUE turn: ${surviving.map(x => JSON.stringify(x)).join(", ")}`
      + `\nNeither has a verb or a domain noun. Catching them needs open-ended vocabularies `
      + `(every hedge; every food word), which is why this is reported and not patched.`);
  }

  check("strip-then-render behaves at the boundary", async () => {
    const { composeDecisionTurn, renderActionLine } = await import("../server/one-action");
    const PROTEIN = "Make your next meal a proper protein meal.";
    const a = composeDecisionTurn("That's a tough week.", renderActionLine(PROTEIN));
    assert.ok(!/train chest/i.test(a), "the model's instruction must not reach the client");
    assert.ok(a.includes("protein meal") || a.includes(PROTEIN));
    // Empathy is no longer a GPT sentence on a decision turn. Situation frame is.
    assert.ok(!/Eggs tonight|chicken and rice would work/i.test(a));
  });

  check("both model paths are told the decision BEFORE they generate", () => {
    const gpt = readFileSync("server/handlers/gpt-block.ts", "utf-8");
    const code = gpt.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    const decidedAt = code.indexOf("canonicalDecision(");
    const injectedAt = code.indexOf("decisionBrief(decision)");
    const generatedAt = code.indexOf("askCoachK(message, user, finalInstruction");
    assert.ok(decidedAt > 0 && injectedAt > 0 && generatedAt > 0, "all three points exist on the gpt path");
    assert.ok(decidedAt < injectedAt && injectedAt < generatedAt,
      "the decision must be made, then stated to the model, then rendered — in that order");

    const live = readFileSync("server/understanding/live.ts", "utf-8");
    const liveCode = live.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    const eDecided = liveCode.indexOf("const engineDecision = await canonicalDecision(");
    const eRan = liveCode.indexOf("runMeaningEngine({");
    assert.ok(eDecided > 0 && eRan > eDecided,
      "the engine must be handed the decision before it is invoked");
    assert.ok(/decisionBrief: decisionBrief\(engineDecision\)/.test(liveCode),
      "…and the brief must actually be passed into the engine input");
  });

  check("the decision the model was told is the decision the reply closes with", () => {
    // The property is not "compute it once" — it is that the append at the END reuses the value
    // DECLARED at the start. Recomputing at append time lets the two disagree: the model told one
    // thing, the reply closing with another.
    for (const f of ["server/handlers/gpt-block.ts", "server/understanding/live.ts"]) {
      const code = readFileSync(f, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
      for (const line of code.split("\n")) {
        if (!/tellDontAsk\(/.test(line)) continue;
        assert.ok(!/await\s+(?:computeNextMove|canonicalDecision)\(/.test(line),
          `${f} recomputes the decision when appending it, instead of reusing the one the model `
          + `was given: ${line.trim().slice(0, 100)}`);
        assert.ok(/decision\.todo|engineDecision\.todo/.test(line),
          `${f} appends something other than the declared decision: ${line.trim().slice(0, 100)}`);
      }
    }
  });

  check("the model paths prescribe THROUGH the decision owner, never beside it", () => {
    // Every place that appends an instruction to a model reply must take it from computeNextMove,
    // and computeNextMove must ask chooseAction under the policy contract. Otherwise GPT or the
    // engine is prescribing where a canonical decision already exists.
    for (const f of ["server/handlers/gpt-block.ts", "server/understanding/live.ts"]) {
      const code = readFileSync(f, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
      for (const line of code.split("\n")) {
        if (!/tellDontAsk\(/.test(line)) continue;
        // Updated 2026-08-21: the decision is now DECLARED before generation and the same value
        // is reused here, so the thing to assert is that it came from the canonical decision —
        // by either name — not that it was recomputed by computeNextMove at this point.
        assert.ok(/computeNextMove\(|decision\.todo|engineDecision\.todo/.test(line),
…27463 tokens truncated…     ]],
        [stepLogs, [{ avg: 9000, steps: 9000, at: today, loggedAt: today }]],
        // WHAT THEY RULED OUT TODAY IS A ROW NOW (#194), not a sentence re-derived from the last
        // 24 chat messages — that window is what let a real client's closed day silently reopen
        // after a busy afternoon. saidToday is still the fixture; it is folded through
        // constraintsAssertedBy, the SAME pure rule the front door writes with, so this harness
        // cannot drift from the product's own definition of what a sentence asserts. Every
        // assertion in the four cases below is unchanged, prohibitions and controls alike.
        [dailyConstraints, saidToday.flatMap(r =>
          constraintsAssertedBy(String(r.message_in || "")).map(c => ({
            userId: `parity-${ledger.who}`, day: sastDayKey(new Date()),
            kind: c.kind, state: c.state, via: "said",
          })))],
      ]);
      const writes: Array<{ table: any; values: any }> = [];
      g.__KAMLIFE_STUB_WRITES = writes;
      try {
        await runEveningAccountability().catch(() => undefined);
      } finally {
        delete g.__KAMLIFE_STUB_WRITES;
        delete g.__KAMLIFE_STUB_ROWS;
        delete g.__KAMLIFE_STUB_PGROWS;
        g.__KAMLIFE_STUB_USER = { ...USER };
        if (priorShadow === undefined) delete process.env.SHADOW; else process.env.SHADOW = priorShadow;
        if (priorPause === undefined) delete process.env.PROACTIVE_PAUSED; else process.env.PROACTIVE_PAUSED = priorPause;
      }
      return writes
        .filter(w => w.table === shadowReplies && typeof w.values?.body === "string")
        .map(w => String(w.values.body));
    });
  }

  // ── P0-4b · HELD STATE CANNOT BE CONTRADICTED BY A PROACTIVE MESSAGE (2026-08-25) ─────────
  //
  // The CTO's acceptance shape, and deliberately NOT "does weekly.ts call chooseAction" — that is
  // a source-string trap that stays green when the call is made and its answer discarded.
  //
  // Held state: rest day (training declined in the client's own words) / food day closed / last
  // night's birthday outing / this week = 0 of 4. A proactive sender fires. It must not tell the
  // client to train, must not tell them to eat more, and the instruction it does carry must be the
  // canonical one.
  const BIRTHDAY = { message_in: "was my cousin's birthday last night, we ate out", created_at: new Date(NOW - 12 * 3_600_000) };
  const SAYS_TRAINING = /\b(?:get|do|finish|start|complete)\b[^.!?\n]{0,40}\b(?:today'?s |the |your |a )?(?:session|workout)\b|training day and the session is still not done/i;
  const SAYS_EAT = /\bget to \d+\s*g\b|\badd one more (?:proper )?meal\b|\bmake your next meal\b|\bget protein into your next meal\b/i;

  // Four cases, one job, one door. Each PROHIBITION is paired with the identical fixture minus the
  // constraint, which must produce the very instruction the other one forbids — so neither
  // assertion can pass because the job went quiet or because the ladder never reached that rung.
  check("P0-4b . training declined today — a real scheduler job must not tell them to train", async () => {
    // proteinTarget 0 takes the food rungs out of the ladder, so `train` is what the decision
    // would otherwise reach on 0 of 4 sessions. That is the rung under test.
    const all = (await runEveningThroughTheDoor(
      [{ message_in: "I'm not training today", created_at: new Date() }, BIRTHDAY],
      { who: "trainheld", proteinTarget: 0 },
    )).join("\n---\n");
    assert.ok(!SAYS_TRAINING.test(all),
      `told a client who said they are not training today to train: ${all.slice(0, 300)}`);
  });

  check("P0-4b control . same state, nothing said — it DOES tell them to train", async () => {
    const sent = await runEveningThroughTheDoor([BIRTHDAY], { who: "traincontrol", proteinTarget: 0 });
    assert.ok(sent.length > 0, "the evening job sent nothing at all — the prohibition above proves nothing");
    const all = sent.join("\n---\n");
    assert.ok(SAYS_TRAINING.test(all),
      `0 of 4 sessions and no constraint, and the job never asked for a session: ${all.slice(0, 300)}`);
    // …and it is the canonical renderer saying it, not a string this job wrote.
    assert.ok(/One thing today:/i.test(all), `the instruction did not come from formatOneAction: ${all.slice(0, 300)}`);
  });

  check("P0-4b . food day closed — a real scheduler job must not tell them to eat", async () => {
    const all = (await runEveningThroughTheDoor(
      [{ message_in: "I'm not eating anything else today", created_at: new Date() }, BIRTHDAY],
      { who: "foodheld", proteinTarget: 140 },
    )).join("\n---\n");
    assert.ok(!SAYS_EAT.test(all),
      `told a client who closed their food day to eat: ${all.slice(0, 300)}`);
  });

  check("P0-4b control . same state, nothing said — it DOES ask for protein", async () => {
    const sent = await runEveningThroughTheDoor([BIRTHDAY], { who: "foodcontrol", proteinTarget: 140 });
    assert.ok(sent.length > 0, "the evening job sent nothing at all — the prohibition above proves nothing");
    const all = sent.join("\n---\n");
    // At or after 20:00 the same rung faces tomorrow — one rung, two renderings, both a real ask.
    assert.ok(SAYS_EAT.test(all) || /start tomorrow with protein/i.test(all),
      `protein at zero against a 140g target and the job asked for nothing: ${all.slice(0, 300)}`);
  });

  // The decision half, isolated: `trainingDeclined` is a DayState INPUT, not a filter applied to
  // the sentence afterwards. Same state twice, one field apart.
  check("P0-4b . trainingDeclined stands `train` down, and nothing else", async () => {
    const { chooseAction } = await import("../server/one-action");
    const behind = {
      goal: "fat_loss" as any, weeksOnProgramme: 3,
      daysSinceAnyLog: 0, daysSinceWeighIn: 1, loggedToday: true,
      proteinPct: 1, caloriePct: 1,
      sessionsThisWeek: 0, sessionsTarget: 4,
      stepsToday: 9000, stepsTarget: 8500, hour: 19,
    };
    assert.equal(chooseAction(behind).kind, "train", "0 of 4 sessions and the ladder did not reach train");
    assert.notEqual(chooseAction({ ...behind, trainingDeclined: true }).kind, "train",
      "a client who ruled today out was still told to train");
    // It suppresses ONE rung, it does not silence the coach: the same client short on protein
    // still gets the protein ask, because that is not what they declined.
    assert.equal(chooseAction({ ...behind, trainingDeclined: true, proteinPct: 0.2 }).kind, "protein",
      "declining training silenced an unrelated rung");
  });

  // The door half, isolated: the floor blocks a contradiction written by hand, so a sender nobody
  // has migrated still cannot say it. Without this the migration protects only what it touched.
  check("P0-4b . the outbound floor blocks a contradiction from an unmigrated sender", async () => {
    const { enforceOutboundTruth } = await import("../server/outbound-authority");
    const { dailyConstraints } = await import("../shared/schema");
    const { sastDayKey } = await import("../server/sast");
    const g = globalThis as any;
    const out = await serialise(async () => {
      // The two constraints are rows now (#194) rather than sentences replayed from chat history.
      // The floor's job is unchanged and so are all three assertions below, control included.
      g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([[dailyConstraints, [
        { userId: USER.id, day: sastDayKey(new Date()), kind: "training", state: "asserted", via: "said" },
        { userId: USER.id, day: sastDayKey(new Date()), kind: "food", state: "asserted", via: "said" },
      ]]]);
      const r = {
        train: await enforceOutboundTruth(USER.id, "whatsapp:+27000000301", "Kam, get today's session done before bed."),
        eat: await enforceOutboundTruth(USER.id, "whatsapp:+27000000302", "Kam, get to 140g protein tonight."),
        recognition: await enforceOutboundTruth(USER.id, "whatsapp:+27000000303", "Kam, 9,000 steps today. Strong."),
      };
      delete g.__KAMLIFE_STUB_ROWS;
      return r;
    });
    assert.ok(!out.train.ok && out.train.reason === "contradicts_held_constraint",
      `a training instruction reached a client who declined training: ${JSON.stringify(out.train)}`);
    assert.ok(!out.eat.ok && out.eat.reason === "contradicts_held_constraint",
      `a food instruction reached a client who closed their food day: ${JSON.stringify(out.eat)}`);
    // THE CONTROL. A floor that blocks recognition is a floor that will be routed around.
    assert.ok(out.recognition.ok, `recognition was blocked by the constraint rule: ${out.recognition.detail}`);
  });

  // THE FALSE-POSITIVE CONTROL, and it caught a real one. The first matcher took any eating verb
  // near any food noun, which would have suppressed Sunday's meal plan and the shopping list for a
  // client who closed their food day that afternoon — a week's artefact lost to a constraint about
  // tonight. A rule that swallows the deliverable is a rule people route around.
  check("P0-4b . the constraint rule does not swallow artefacts, logging asks or recognition", async () => {
    const { asksForFoodToday, asksForTrainingToday } = await import("../server/held-constraints");
    const mustPass = [
      "*Kam — your 3-day plan for the week ahead:*\n\nDay 1 breakfast: eggs + toast. Prep protein on Sunday.",
      "Your R100 week plan — eggs 12 pack R45, pilchards 3 tins R36. Shop at Shoprite this weekend.",
      "One quick thing before bed: tell me what you ate.",
      "Kam, 9,000 steps and a session done today. Strong.",
      "Reply *1* to see tomorrow's workout.",
      "Week 5 wrap-up: 3 workouts done, 5 days food logged.",
    ];
    for (const m of mustPass) {
      assert.ok(!asksForFoodToday(m), `a non-instruction was read as an ask for food: ${m.slice(0, 70)}`);
      assert.ok(!asksForTrainingToday(m), `a non-instruction was read as an ask to train: ${m.slice(0, 70)}`);
    }
    // …and it still sees the two things it exists to see.
    assert.ok(asksForFoodToday("Make your next meal a protein one — tin fish, eggs or amasi."));
    assert.ok(asksForTrainingToday("Get today's session done."));
  });

  // The reader half: "anything else" is a quantity, "anything fried" is an object. Found while
  // building the fixture above, and the distinction is the whole reason this owner is narrow.
  check("P0-4b . a closed food day is read from the client's own words, not the topic", async () => {
    const { foodDayIsClosed } = await import("../server/one-action");
    for (const closed of [
      "I'm not eating anything else today",
      "not eating anything more today",
      "I'm done eating for today",
    ]) assert.ok(foodDayIsClosed(closed), `a plain closure was not read as one: ${closed}`);
    for (const open of [
      "I'm not eating anything fried today",
      "I'm done eating badly",
      "I'm done eating junk",
      "I can't stop eating today",
    ]) assert.ok(!foodDayIsClosed(open), `a food CHOICE was recorded as a closed day: ${open}`);
  });

  // ── P0-5 · THE SCALE HAS ONE READER, AND IT KNOWS WHO ASKED US TO DROP IT (2026-08-25) ────
  //
  // `users.do_not_mention` is the client saying "stop bringing up my weight". One reader honoured
  // it. These grade the surfaces that did not — and each prohibition is paired with the identical
  // fixture minus the request, so none can pass because a figure was missing anyway.
  //
  // Deliberately NOT "does client-snapshot import getWeightTruth". The property is what the
  // client-facing text CONTAINS.
  const KG = /\b\d{2,3}(?:\.\d)?\s*kg\b/i;

  async function snapshotFor(doNotMention: string | null): Promise<string> {
    const { buildClientSnapshot } = await import("../server/brain/client-snapshot");
    const { weightLogs } = await import("../shared/schema");
    const g = globalThis as any;
    return serialise(async () => {
      const today = new Date();
      g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([[weightLogs, [
        { weight: "83.4", at: new Date(NOW - 20 * 86_400_000), loggedAt: new Date(NOW - 20 * 86_400_000) },
        { weight: "82.0", at: today, loggedAt: today },
      ]]]);
      // The user is PASSED, never written to the global. Reassigning __KAMLIFE_STUB_USER here made
      // two unrelated checks red: they run concurrently and read that global, so for the length of
      // this case they were coaching a client who had asked us to drop the scale, and the mouth
      // stripped their replies. A fixture that changes what other tests are testing is not a
      // fixture, and the failures it caused looked like product regressions.
      try { return String(await buildClientSnapshot({ ...USER, doNotMention }) ?? ""); }
      finally { delete g.__KAMLIFE_STUB_ROWS; }
    });
  }

  check("P0-5 . the model's context carries no weight figure for a client who asked us to drop it", async () => {
    const held = await snapshotFor("weight");
    const weightLines = held.split("\n").filter(l => /^Weight:/.test(l) || KG.test(l));
    assert.ok(!weightLines.some(l => KG.test(l)),
      `a kg figure reached the model for a do-not-mention client: ${weightLines.join(" | ").slice(0, 200)}`);
    // AND IT MUST NOT ADVERTISE THE WITHHOLDING. "Weight withheld" in the context is an invitation
    // to ask about it, which is the thing the client asked us to stop doing.
    assert.ok(!/withheld|not allowed|do not mention/i.test(held),
      "the context told the model a weight figure was being kept from it");
  });

  check("P0-5 control . the same client without the request DOES get the figure", async () => {
    const open = await snapshotFor(null);
    assert.ok(/^Weight: started/m.test(open) && KG.test(open),
      `the snapshot carried no weight figure at all — the prohibition above proves nothing: ${open.slice(0, 200)}`);
  });

  check("P0-5 . getWeightTruth withholds, and stands down rather than filtering", async () => {
    const { getWeightTruth } = await import("../server/day-ledger");
    const { weightLogs } = await import("../shared/schema");
    const g = globalThis as any;
    const out = await serialise(async () => {
      g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([[weightLogs, [
        { weight: "83.4", at: new Date(NOW - 20 * 86_400_000), loggedAt: new Date(NOW - 20 * 86_400_000) },
        { weight: "82.0", at: new Date(), loggedAt: new Date() },
      ]]]);
      const r = {
        held: await getWeightTruth({ ...USER, doNotMention: "weight" }),
        asked: await getWeightTruth({ ...USER, doNotMention: "weight" }, { clientMessage: "what is my weight?" }),
        open: await getWeightTruth({ ...USER, doNotMention: null }),
      };
      delete g.__KAMLIFE_STUB_ROWS;
      return r;
    });
    assert.ok(out.held.withheld && out.held.points.length === 0 && out.held.currentKg === null,
      `a withheld read still carried weigh-ins: ${JSON.stringify(out.held).slice(0, 160)}`);
    // THEY MAY RAISE IT THEMSELVES. A coach who won't answer a direct question is not honouring
    // anything, it is sulking — the same rule chat-log has applied at the mouth since Cut 8.
    assert.ok(!out.asked.withheld && out.asked.currentKg !== null,
      `a client who asked about their own weight was refused: ${JSON.stringify(out.asked).slice(0, 160)}`);
    assert.ok(out.open.known && out.open.startKg === 83.4 && out.open.currentKg === 82,
      `the ordinary read is wrong: ${JSON.stringify(out.open).slice(0, 160)}`);
    // NEGATIVE means lost — one convention, and the surfaces that print a direction depend on it.
    assert.ok(out.open.changeKg !== null && out.open.changeKg < 0,
      `sign convention broke: ${out.open.changeKg}`);
  });

  // ── P0-5 · FOOD · ONE SAST DAY BOUNDARY, IN SQL TOO (2026-08-25) ──────────────────────────
  //
  // The exact case that exposed the defect. `sastDayKey` has owned "which day is this" in
  // TypeScript for months; a GROUP BY answers the same question in SQL, and gpt.ts answered it
  // with DATE(logged_at) — the UTC day — while every other food surface used SAST.
  //
  // South Africa is UTC+2 with no DST, so a supper logged after 22:00 UTC is 00:00+ SAST: the UTC
  // bucket pulls it BACK into the previous day. Two SAST days become one, which changes the daily
  // totals AND the divisor they are averaged over.
  check("P0-5 food . the SAST day bucket is one rule, and it is not the UTC day", async () => {
    const { sastDayKey } = await import("../server/sast");

    // Dinner 21:00 SAST and a late snack 00:30 SAST — two SAST days, ONE UTC day.
    const dinner = new Date("2026-08-20T19:00:00Z");   // 21:00 SAST on the 20th
    const lateSnack = new Date("2026-08-20T22:30:00Z");  // 00:30 SAST on the 21st

    const utcDay = (d: Date) => d.toISOString().slice(0, 10);
    assert.equal(utcDay(dinner), utcDay(lateSnack),
      "fixture broken: these must share a UTC day, or the case proves nothing");
    assert.notEqual(sastDayKey(dinner), sastDayKey(lateSnack),
      "fixture broken: these must be different SAST days");
    assert.equal(sastDayKey(lateSnack), "2026-08-21", "the small-hours meal belongs to the NEXT SAST day");

    // The consequence, stated as the numbers the model is handed. 70g + 50g against a 140g target.
    const sastBuckets = [dinner, lateSnack].reduce((m, d, i) => {
      const k = sastDayKey(d); m.set(k, (m.get(k) || 0) + [70, 50][i]); return m;
    }, new Map<string, number>());
    const utcBuckets = [dinner, lateSnack].reduce((m, d, i) => {
      const k = utcDay(d); m.set(k, (m.get(k) || 0) + [70, 50][i]); return m;
    }, new Map<string, number>());
    const avg = (m: Map<string, number>) => Math.round([...m.values()].reduce((a, b) => a + b, 0) / m.size);
    const compliant = (m: Map<string, number>) => [...m.values()].filter(p => p >= 140 * 0.8).length;

    assert.equal(sastBuckets.size, 2); assert.equal(avg(sastBuckets), 60); assert.equal(compliant(sastBuckets), 0);
    assert.equal(utcBuckets.size, 1); assert.equal(avg(utcBuckets), 120); assert.equal(compliant(utcBuckets), 1);
  });

  // …and the SQL the owner hands out actually shifts. A rule stated only in TypeScript is how the
  // two boundaries diverged in the first place.
  check("P0-5 food . the owner's SQL day bucket shifts to SAST, and gpt.ts uses it", async () => {
    const { sastDayBucketSql } = await import("../server/day-ledger");
    const { mealLogs } = await import("../shared/schema");
    // Read the literal chunks of the fragment. JSON.stringify cannot be used — a drizzle SQL
    // object holds a column reference and is circular.
    const frag = sastDayBucketSql(mealLogs.loggedAt as any) as any;
    const rendered = (frag.queryChunks ?? [])
      .flatMap((c: any) => (Array.isArray(c?.value) ? c.value : []))
      .join(" ");
    assert.match(rendered, /interval '2 hours'/i,
      `the owner's day bucket does not shift to SAST: ${rendered.slice(0, 160)}`);
    assert.match(rendered, /to_char/i, "the bucket must render a YYYY-MM-DD key, comparable to sastDayKey");

    // THE REACHABILITY HALF. An owner nothing calls is the defect this repo keeps repeating, so
    // this asserts the two client-facing food claims no longer carry their own UTC rule.
    const gpt = readFileSync("server/gpt.ts", "utf-8");
    assert.ok(!/DATE\(\$\{mealLogs\.loggedAt\}\)/.test(gpt),
      "gpt.ts still buckets meals by the UTC calendar day");
    assert.equal((gpt.match(/sastDayBucketSql\(mealLogs\.loggedAt\)/g) || []).length, 4,
      "both food claims must take the bucket from the owner, in select AND group by");
  });

  // ── THE FLOOR MAY ONLY JUDGE WHAT IT CAN ACTUALLY ADJUDICATE (2026-08-25) ─────────────────
  //
  // PR #54 gave this rule authority over outbound communication without giving it enough
  // information to know what each number MEANS. It extracted every session-shaped number and
  // required all of them to equal the 7-day ledger count, so "Training: 2/4 sessions" read as a
  // claim of 2 AND 4 — and the weekly Report Card was blocked for every client whose sessions did
  // not exactly equal their target. These are the real message bodies, through the real floor.
  check("floor . a real Report Card is not blocked by its own target", async () => {
    const { enforceOutboundTruth } = await import("../server/outbound-authority");
    const { workoutLogs } = await import("../shared/schema");
    const g = globalThis as any;

    const REPORT_CARD = [
      "*Kam — Week 5 Report Card*", "",
      "📅 Showed up: 5/7 days",
      "💪 Training: 2/4 sessions",
      "👟 Steps: 7,400 avg (87% of 8,500 target)",
      "", "*Weekly Score: 68/100 — Building*",
    ].join("\n");

    const out = await serialise(async () => {
      // The record genuinely holds 2 sessions in the window.
      g.__KAMLIFE_STUB_ROWS = new Map([[workoutLogs, [{ n: 2 }]]]);
      const r = {
        card: await enforceOutboundTruth(USER.id, "whatsapp:+27000000401", REPORT_CARD),
        milestone: await enforceOutboundTruth(USER.id, "whatsapp:+27000000402", "🏆 30 total sessions — milestone"),
        bank: await enforceOutboundTruth(USER.id, "whatsapp:+27000000403", "Kam, Week 5 — 24 sessions in the bank."),
        truthful: await enforceOutboundTruth(USER.id, "whatsapp:+27000000404", "That's 2 sessions this week — let's build on it."),
        lying: await enforceOutboundTruth(USER.id, "whatsapp:+27000000405", "Strong week — that's 4 sessions in the bag."),
      };
      delete g.__KAMLIFE_STUB_ROWS;
      return r;
    });

    // THE THREE THAT WERE BEING SUPPRESSED.
    assert.ok(out.card.ok,
      `the weekly Report Card was blocked by its own target: ${out.card.detail}`);
    assert.ok(out.milestone.ok,
      `a lifetime milestone was judged against a 7-day count: ${out.milestone.detail}`);
    assert.ok(out.bank.ok,
      `a lifetime total was judged against a 7-day count: ${out.bank.detail}`);
    // …AND THE RULE STILL DOES ITS JOB. Without this the fix could be "adjudicate nothing".
    assert.ok(out.truthful.ok, `a truthful windowed count was blocked: ${out.truthful.detail}`);
    assert.ok(!out.lying.ok && out.lying.reason === "session_count_contradicts_record",
      "a false session count reached a client — the rule this floor exists for is gone");
    assert.match(String(out.lying.detail), /said 4, record holds 2/,
      `the block names the wrong number: ${out.lying.detail}`);
  });

  // The claim reader on its own, so a future change to the message bodies cannot quietly move the
  // property. Each line is a real string from a real sender.
  check("floor . the claim reader tells a count from a target from a lifetime", async () => {
    const { adjudicableSessionCounts } = await import("../server/brain/reply-verifier");
    // ADJUDICABLE — a plain count of completed sessions.
    assert.deepEqual(adjudicableSessionCounts("Strong week — that's 4 sessions in the bag."), [4]);
    assert.deepEqual(adjudicableSessionCounts("💪 Training: 2/4 sessions"), [2],
      "the denominator of N/M is the target, not a second claim");
    // NOT ADJUDICABLE — a span the 7-day ledger cannot speak to.
    for (const lifetime of ["🏆 30 total sessions — milestone", "Week 5 — 24 sessions in the bank",
                            "12 sessions since you started", "8 sessions altogether"]) {
      assert.deepEqual(adjudicableSessionCounts(lifetime), [],
        `a lifetime count was offered up for a 7-day comparison: ${lifetime}`);
    }
    // NOT ADJUDICABLE — a target, named as one.
    for (const target of ["Target for this week: 4 sessions", "3 of 4 planned sessions done"]) {
      assert.deepEqual(adjudicableSessionCounts(target), [],
        `a target was read as a claim about completed sessions: ${target}`);
    }
    // SEGMENT-WISE. A lifetime line must not silence the adjudicable line beside it.
    assert.deepEqual(
      adjudicableSessionCounts("🏆 30 total sessions — milestone\nThat's 4 sessions in the bag."),
      [4], "one lifetime line swallowed the whole message");
  });

  // ── THE REACTIVE MOUTH READS CLAIMS THE SAME WAY THE DOOR DOES (2026-08-25) ───────────────
  //
  // #57 fixed the proactive floor. verifySessionAttribution composed its own half of the same
  // rule — sessionCountsIn(withoutTargetSegments(reply)) — so it still read "Training: 2/4
  // sessions" as a claim of 4, and still offered a lifetime total up against a 7-day count.
  // Same defect, smaller blast radius: this runs on model prose only.
  check("verifier . a model reply is judged on the counts it actually claims", async () => {
    const { verifyBrainReply } = await import("../server/brain/reply-verifier");
    const facts = (extra: Record<string, unknown> = {}) => ({
      goalType: "fat_loss",
      clientMessage: "how am I doing this week?",
      evidence: { modelAuthored: true, sessionsWindow: 2, sessionsWindowDays: 7, ...extra },
    });

    // A TARGET IS NOT A CLAIM. The record holds 2; the reply states 2 done against a target of 4.
    assert.ok(verifyBrainReply("You're at 2/4 sessions this week — one more and you're close.", facts()).ok,
      "the model was corrected for naming its own target");

    // A LIFETIME IS NOT A 7-DAY CLAIM — the whole-reply OUT_OF_WINDOW rule owns that refusal, and
    // it must refuse rather than mis-compare. Either way it must not say "you said 30, we hold 2".
    const lifetime = verifyBrainReply("That's 30 total sessions since you started.", facts());
    assert.ok(!/says the client has done 30 training session/.test(lifetime.violation || ""),
      `a lifetime total was compared against a 7-day count: ${lifetime.violation}`);

    // THE RULE STILL BITES, and now names the number that failed.
    const lying = verifyBrainReply("Strong week — that's 4 sessions in the bag.", facts());
    assert.ok(!lying.ok, "a false session count passed the reactive mouth");
    assert.match(lying.violation || "", /has done 4 training session/,
      `the violation quotes the wrong figure: ${lying.violation}`);

    // …and a truthful count still passes.
    assert.ok(verifyBrainReply("That's 2 sessions this week — solid.", facts()).ok,
      "a truthful count was corrected");
  });

  // ── P0-5 · WORKOUT · WHAT A RETROACTIVE SESSION CHANGES (2026-08-25) ──────────────────────
  //
  // Five paths write a session row and they disagreed about what else moves. Two defects:
  // backfillAttributedDays touched `users` not at all, so the ledger and the lifetime counter
  // answered "how many sessions have I done" differently; and the multi-day retro path set
  // lastWorkoutDate unconditionally, moving it BACKWARD past a more recent session — while the
  // sibling single-day path 65 lines above guarded exactly that.
  check("P0-5 workout . a retro session moves the count, never the cursor, never backwards", async () => {
    const { applyRetroSessionState } = await import("../server/day-ledger");
    const g = globalThis as any;

    const held = new Date(NOW - 1 * 86_400_000);   // they last trained YESTERDAY
    const older = new Date(NOW - 4 * 86_400_000);  // …and now report a session from four days ago
    const newer = new Date(NOW);

    const run = (attributed: Date[]) => serialise(async () => {
      g.__KAMLIFE_STUB_USER = {
        ...USER, id: "retro-contract", totalWorkoutsCompleted: 24, workoutStreak: 3,
        lastWorkoutDate: held, programmeWeek: 3, programmeDayInWeek: 2,
      };
      const before = { ...g.__KAMLIFE_STUB_USER };
      const out = await applyRetroSessionState(before, attributed);
      const after = { ...g.__KAMLIFE_STUB_USER };
      g.__KAMLIFE_STUB_USER = { ...USER };
      return { out, after, before };
    });

    // 2. THE LIFETIME COUNT MOVES, once per attributed day.
    const one = await run([older]);
    assert.equal(one.out.total, 25, "one attributed session did not move the lifetime count");
    const two = await run([older, new Date(NOW - 3 * 86_400_000)]);
    assert.equal(two.out.total, 26, "two attributed sessions must count twice, not once");
    assert.equal((await run([])).out.total, 24, "an empty attribution changed the count");

    // 3. lastWorkoutDate IS A MAX OVER REAL EVENTS. The negative case is the point: an OLDER
    //    session must never drag it back past a more recent one.
    assert.equal(one.out.lastWorkoutDate?.getTime(), held.getTime(),
      "an older attributed session moved lastWorkoutDate backwards");
    assert.equal(one.after.lastWorkoutDate ? new Date(one.after.lastWorkoutDate).getTime() : 0, held.getTime(),
      "…and it was written backwards to the row");
    const forward = await run([newer]);
    assert.equal(forward.out.lastWorkoutDate?.getTime(), newer.getTime(),
      "a genuinely more recent session failed to advance lastWorkoutDate");

    // 4. THE PROGRAMME CURSOR NEVER MOVES. (P0-3.) Which session is due today is decided by the
    //    schedule and by what was done today; a backfill answers neither question.
    assert.equal(one.after.programmeWeek, 3, "a retro write advanced the programme week");
    assert.equal(one.after.programmeDayInWeek, 2, "a retro write advanced the programme day");

    // 5. THE STREAK IS NEVER INCREMENTED HERE. The live rule is `wasYesterday ? +1 : 1`, which is
    //    only valid for a write about today. A correct historical streak must be derived from the
    //    ledger — a different owner, deliberately out of this cut.
    assert.equal(one.after.workoutStreak, 3, "a retro write incremented the streak");
  });

  // …and the path that had none of it. The defect was that backfill wrote the ledger and left the
  // counter behind, so this drives the real module and reads the real user row.
  check("P0-5 workout . the batch logger now carries the derived state", async () => {
    const { backfillAttributedDays } = await import("../server/backfill");
    const g = globalThis as any;
    const day = (n: number) => new Date(NOW - n * 86_400_000)
      .toLocaleDateString("en-ZA", { weekday: "long", timeZone: "Africa/Johannesburg" });

    const out = await serialise(async () => {
      const before = {
        ...USER, id: "backfill-contract", totalWorkoutsCompleted: 24, workoutStreak: 3,
        lastWorkoutDate: new Date(NOW - 1 * 86_400_000), programmeWeek: 3, programmeDayInWeek: 2,
      };
      g.__KAMLIFE_STUB_USER = { ...before };
      const res = await backfillAttributedDays(
        before, `${day(4)} pap and chicken. ${day(3)} eggs and toast. ${day(2)} I trained and walked 8000 steps`);
      const after = { ...g.__KAMLIFE_STUB_USER };
      g.__KAMLIFE_STUB_USER = { ...USER };
      return { res, after };
    });

    const sessions = (out.res?.writes || []).filter(w => w.domain === "workout");
    assert.equal(sessions.length, 1, `expected one backfilled session, got ${JSON.stringify(sessions)}`);
    assert.equal(out.after.totalWorkoutsCompleted, 25,
      "the batch logger wrote a session row and left the lifetime count behind");
    // The attributed day is OLDER than the held one, so the max rule must hold here too.
    assert.equal(new Date(out.after.lastWorkoutDate).getTime(), NOW - 1 * 86_400_000,
      "a backfilled older session moved lastWorkoutDate backwards");
    assert.equal(out.after.programmeWeek, 3, "the batch logger advanced the programme cursor");
    assert.equal(out.after.workoutStreak, 3, "the batch logger incremented the streak");
  });

  // ── ONE QUESTION, ONE OWNER: "IS THE CLIENT TRAINING TODAY?" (2026-08-25) ─────────────────
  //
  // THE HANDSET FAILURE. Coach sent the session with buttons [Done | Too hard | Skip today].
  //
  //   Client: "No I moved yesterdays workout to today"
  //   Coach:  "Kam, no stress — rest today, hit it fresh tomorrow 💪"
  //
  // He answered our own menu, told us he was training, and we told him to rest. Six readers
  // decided this question independently and MOVED INTO TODAY was a shape none of them held, so
  // the leading "No" plus "workout" plus "today" read as a refusal.
  //
  // These are customer sentences, not helper booleans — the first fixtures of the matrix.
  check("training day . the six readers now give one answer", async () => {
    const { readTrainingDay, trainingDayIsDeclined } = await import("../server/one-action");

    // THE SCREENSHOT. This is the case the whole cut exists for.
    assert.equal(readTrainingDay("No I moved yesterdays workout to today"), "moved_to_today",
      "the sentence from the handset is still read as a refusal");
    assert.equal(trainingDayIsDeclined("No I moved yesterdays workout to today"), false,
      "…and the DayState input still carries it as a constraint against training");

    // THE ADJACENT SHAPES, which is what makes the answer meaningful rather than a special case.
    const expect: Array<[string, string]> = [
      ["I'm doing yesterday's session today", "moved_to_today"],
      ["rest day", "declined"],
      ["taking a rest day", "declined"],
      ["no gym today", "declined"],
      ["I'm not training today, ok?", "declined"],
      ["Can I do my workout tomorrow instead?", "move_request"],
      ["I'll train tomorrow", "deferred"],
      ["I missed gym on Monday", "missed"],
      ["I didn't do my workout", "missed"],
      // …and the words that merely CONTAIN "skip" but ask a different question entirely.
      ["skip the numbers", "none"],
      ["I'm done eating for today", "none"],
      ["I trained today", "none"],
      ["I didn't skip the gym today", "none"],
      ["Show me tomorrow's workout", "none"],
      ["Is today a rest day?", "none"],
    ];
    for (const [sentence, want] of expect) {
      assert.equal(readTrainingDay(sentence), want, `"${sentence}" read as ${readTrainingDay(sentence)}, expected ${want}`);
    }
  });

  // THE OUTCOME, not the classification. A sentence that says "I am training today" must not be
  // answered with a rest-day reply — which is what the client actually saw.
  // THE CANONICAL CASE FOR THE POSITIVE-OUTCOME LAW (rewritten 2026-08-25, issue #63 item 1.2).
  //
  // This check shipped green in #61 asserting only that "rest today" was absent. It was — and the
  // client was asked what they ate instead of being given the session they had just said they
  // moved. `readTrainingDay` returns `moved_to_today` correctly; nothing consumes it; the turn
  // falls to the generic ladder. The old form could not see that, because "not rest today" is
  // equally satisfied by silence, by a crash fallback, and by an answer to another question.
  check("training day . a session moved into today is DELIVERED, not merely not-refused", async () => {
    const reply = await serialise(() => say("No I moved yesterdays workout to today"));
    assertCustomerOutcome(reply, {
      got: /Week \d|Next Session|Send \*?DONE|sets?\b|reps?\b/i,
      notGot: /rest today|hit it fresh tomorrow|rest day is part of the programme/i,
      because: "a client who says they moved a session into today must be given that session",
    });
  });

  // ONE MOUTH, NOT TWO SYNCHRONISED COPIES (2026-08-25, Phase 2.1).
  //
  // The weak version of this fix is a second composition site that happens to agree today.
  // sessionHeaderLine had exactly that — two call sites — and they diverged, which is how
  // "*Week 1 — Session 25*" reached a handset weeks after the header was "fixed".
  //
  // So this asserts the property that a synchronised copy cannot offer: the session BODY the
  // moved-session path sends is the same string renderSession() produces. Change the renderer and
  // both callers move together; fork one of them and this goes red on the next run.
  // ── "MY X IS N" — THE SHARED REPORTING PATTERN (2026-08-26, issue #63) ──────────────────────
  //
  // Three of four tracking surfaces mishandled the same ordinary construction, each differently:
  //   steps   — recogniser said yes, extractor said no (#71)
  //   water   — the water owner's own question-guard classified the report as a question, so it
  //             fell past Water and the FOOD scanner logged a food called "Water"
  //   workout — the completion matcher was anchored to the bare "workout done"
  //   weight  — worked throughout
  //
  // It is ordinary phrasing, arguably more natural than "I drank 2 litres". These assert the whole
  // family in one place so the next tracker cannot quietly miss it.
  check("my-X-is-N . a report in copula form reaches its tracker, on every surface", async () => {
    const S = await import("../shared/schema");
    const g = globalThis as any;
    const run = async (msg: string) => {
      g.__KAMLIFE_STUB_USER = { ...USER, todayWater: "0" };
      g.__KAMLIFE_STUB_WRITES = [];
      const out = String(await handleMessage(USER.phoneNumber, msg).catch(() => "") ?? "");
      const w = g.__KAMLIFE_STUB_WRITES || [];
      const hit = (t: any) => w.filter((x: any) => x.table === t).length > 0;
      delete g.__KAMLIFE_STUB_WRITES;
      return { out, steps: hit(S.stepLogs), weight: hit(S.weightLogs), workout: hit(S.workoutLogs), meal: hit(S.mealLogs) };
    };

    const steps = await serialise(() => run("My steps are 8000"));
    assert.ok(steps.steps, "\"My steps are 8000\" did not reach the step tracker");

    const weight = await serialise(() => run("My weight is 92kg"));
    assert.ok(weight.weight, "\"My weight is 92kg\" did not reach the weight tracker");

    const workout = await serialise(() => run("My workout is done"));
    assert.ok(workout.workout, "\"My workout is done\" did not reach the workout tracker");

    // WATER IS THE ONE THAT CORRUPTED STATE. Asserting the food table stays EMPTY is the point:
    // the failure was not silence, it was a food called "Water" written to the client's record.
    const water = await serialise(() => run("My water is 2 litres"));
    assert.ok(!water.meal, "a water report was logged as FOOD — the client's record now carries an invented meal");
    assertCustomerOutcome(water.out, {
      got: /\d+(?:\.\d+)?\s*L\b|litre/i,
      because: "a client who reports their water must have it counted as water",
    });
  });

  // THE CONTROLS. Widening a report matcher must not turn a QUESTION into a write. A false log is
  // worse than a missed one: it tells the client they did something they did not.
  check("my-X-is-N control . asking is never writing", async () => {
    const S = await import("../shared/schema");
    const g = globalThis as any;
    const wrote = async (msg: string) => {
      g.__KAMLIFE_STUB_USER = { ...USER, todayWater: "0" };
      g.__KAMLIFE_STUB_WRITES = [];
      await handleMessage(USER.phoneNumber, msg).catch(() => "");
      const n = (g.__KAMLIFE_STUB_WRITES || [])
        .filter((x: any) => [S.stepLogs, S.weightLogs, S.workoutLogs].includes(x.table)).length;
      delete g.__KAMLIFE_STUB_WRITES;
      return n;
    };
    // "Is my workout done?" WROTE A SESSION before this cut — a fabricated workout, pre-existing.
    for (const q of ["Is my workout done?", "did my workout?", "Have I trained today?",
                     "my workout is not done", "How much water should I drink?", "Is 2 litres of water enough?"]) {
      assert.equal(await serialise(() => wrote(q)), 0, `a question or negation was written as a report: "${q}"`);
    }
    // …and the report forms these guards sit beside must still write.
    for (const r of ["did my workout", "workout done"]) {
      assert.ok(await serialise(() => wrote(r)) > 0, `a genuine report stopped writing: "${r}"`);
    }
  });

  // ── TWO PREDICATES FOR ONE QUESTION MUST AGREE (2026-08-26, issue #63) ───────────────────────
  //
  // "My steps are 10k today" was RECOGNISED as a step report by looksLikeStepsReport and extracted
  // as ZERO by detectStepLog. One owner said yes, the other said no, and the client's 10 000 steps
  // vanished between them — after which the coaching ladder, seeing no steps, told a client who
  // had just walked 10 000 to go for a walk. That is the reported failure, and neither predicate
  // was individually "wrong": they simply disagreed on the copula forms (`are|is|was|were`).
  //
  // The invariant is the durable part. Fixing the regex fixes one phrasing; asserting that the two
  // predicates AGREE catches the whole class the next time either is edited alone.
  check("steps . the recogniser and the extractor agree on what a step report is", async () => {
    const { looksLikeStepsReport } = await import("../server/utils");
    const { detectStepLog, parseMessyIntake } = await import("../server/understanding/messy-intake");
    const reports = [
      "my steps are 10k today", "my steps are 10000", "steps are 8000", "steps: 9000",
      "i walked 8000 steps today", "10000 steps", "i did 12k steps", "i've done 10k steps already",
    ];
    for (const r of reports) {
      const recognised = looksLikeStepsReport(r);
      const extracted = detectStepLog(r).steps;
      assert.ok(recognised && extracted > 0,
        `the two owners disagree on "${r}" — recognised=${recognised}, extracted=${extracted}. `
        + `A step report seen by one and not the other is a client's steps disappearing.`);
    }

    // THE TRANSCRIPT WAS RIGHT; THE PARSER MADE IT FALSE (2026-09-10, voice audit).
    // Both the intake scan and the durable step owner must retain the hundreds spoken after
    // "thousand". If either returns 8,000 here, later coaching sees a fabricated shortfall.
    const spoken = [
      ["I walked eight thousand five hundred steps", 8500],
      ["I walked eight thousand and five hundred steps", 8500],
      ["I walked twelve thousand two hundred steps", 12200],
      ["I walked eight and a half thousand steps", 8500],
      ["I walked eight thousand steps", 8000],
    ] as const;
    for (const [raw, expected] of spoken) {
      assert.equal(detectStepLog(raw).steps, expected,
        `the durable step owner changed "${raw}" to the wrong count`);
      assert.equal(parseMessyIntake(raw).stepCount, expected,
        `messy intake disagreed with the durable owner for "${raw}"`);
    }
  });

  check("steps . a client who reports steps has them written, and is told so", async () => {
    const { stepLogs } = await import("../shared/schema");
    const g = globalThis as any;
    const logged = async (msg: string) => {
      g.__KAMLIFE_STUB_USER = { ...USER };
      g.__KAMLIFE_STUB_WRITES = [];
      const out = String(await handleMessage(USER.phoneNumber, msg).catch(() => "") ?? "");
      const rows = (g.__KAMLIFE_STUB_WRITES || []).filter((w: any) => w.table === stepLogs);
      delete g.__KAMLIFE_STUB_WRITES;
      return { out, steps: rows[0]?.values?.steps ?? 0 };
    };
    const r = await serialise(() => logged("My steps are 10k today"));
    assert.equal(r.steps, 10000, `the reported steps were not written: got ${r.steps}`);
    assertCustomerOutcome(r.out, {
      got: /10[\s,]?000\s*steps/i,
      because: "a client who reports 10 000 steps must have them counted, not be asked to walk",
    });
  });

  // THE CONTROL. A question about steps is not a report of steps. Widening the extractor must not
  // turn "how many steps should I do?" into a log of zero.
  check("steps control . a question about steps is never logged as one", async () => {
    const { stepLogs } = await import("../shared/schema");
    const g = globalThis as any;
    for (const q of ["Are steps important?", "How many steps should I do?", "is 8000 steps enough?"]) {
      const wrote = await serialise(async () => {
        g.__KAMLIFE_STUB_USER = { ...USER };
        g.__KAMLIFE_STUB_WRITES = [];
        await handleMessage(USER.phoneNumber, q).catch(() => "");
        const rows = (g.__KAMLIFE_STUB_WRITES || []).filter((w: any) => w.table === stepLogs);
        delete g.__KAMLIFE_STUB_WRITES;
        return rows.length;
      });
      assert.equal(wrote, 0, `a question was logged as a step report: "${q}"`);
    }
  });

  // ── THE CLAIM MATRIX — who is allowed to answer the customer (2026-08-25, issue #63) ─────────
  //
  // A broad upstream predicate could prevent the correct specialist from ever seeing a message.
  // Measured before the fix: ONE phrase — "what can i eat" — preempted SIX food specialists.
  // "What can I eat at Nandos?" got a generic next-meal card while "What should I order at
  // Nandos?" got the full smart order, from the same client, about the same restaurant.
  //
  // This asserts the CLAIMANT, not the wording, because wording assertions cannot see a specialist
  // being skipped — the generic card is a perfectly well-formed reply. The claimant is read from
  // the logChat intent tag, which is the handler naming itself.
  check("claim matrix . a situated food question reaches its specialist, not a generalist", async () => {
    const { chatHistory } = await import("../shared/schema");
    const g = globalThis as any;
    const claimantOf = async (msg: string): Promise<string> => {
      g.__KAMLIFE_STUB_USER = { ...USER };
      g.__KAMLIFE_STUB_WRITES = [];
      await handleMessage(USER.phoneNumber, msg).catch(() => "");
      const tags = (g.__KAMLIFE_STUB_WRITES || [])
        .filter((w: any) => w.table === chatHistory && w.values?.intent)
        .map((w: any) => String(w.values.intent));
      delete g.__KAMLIFE_STUB_WRITES;
      return tags.length ? tags[tags.length - 1] : "(untagged)";
    };

    // THE PAIRS ARE THE POINT. Each row is the same customer question in two phrasings; before the
    // fix the left column reached a generalist and the right column reached the owner.
    const pairs: Array<[string, string, string]> = [
      ["RESTAURANT_GUIDE", "What can I eat at Nandos?", "What should I order at Nandos?"],
      ["STREET_FOOD_GUIDE", "What can I eat at the taxi rank?", "I'm at the taxi rank, what should I get?"],
    ];
    for (const [owner, phrasingA, phrasingB] of pairs) {
      for (const msg of [phrasingA, phrasingB]) {
        assert.equal(await serialise(() => claimantOf(msg)), owner,
          `"${msg}" was not claimed by ${owner} — a broader predicate took the turn first`);
      }
    }

    // …and the swap owner, whose trigger word is IN the message and was still being skipped.
    assert.equal(await serialise(() => claimantOf("What can I eat instead of rice?")), "FOOD_SWAP",
      "a swap ask naming its own trigger word did not reach the swap owner");
  });

  // THE CONTROLS. Narrowing a generalist is only correct where a better owner exists; a generalist
  // that steps aside for nobody has simply been broken. Both directions are asserted.
  check("claim matrix control . the generalist keeps the questions it should own", async () => {
    const { chatHistory } = await import("../shared/schema");
    const g = globalThis as any;
    const replyTo = async (msg: string) => {
      g.__KAMLIFE_STUB_USER = { ...USER };
      g.__KAMLIFE_STUB_WRITES = [];
      const out = String(await handleMessage(USER.phoneNumber, msg).catch(() => "") ?? "");
      const tags = (g.__KAMLIFE_STUB_WRITES || [])
        .filter((w: any) => w.table === chatHistory && w.values?.intent).map((w: any) => String(w.values.intent));
      delete g.__KAMLIFE_STUB_WRITES;
      return { out, claimed: tags.length ? tags[tags.length - 1] : "(untagged)" };
    };
    // A contextless hunger question is exactly what the next-meal card is for.
    for (const msg of ["I'm hungry, what should I do?", "What can I eat?"]) {
      const r = await serialise(() => replyTo(msg));
      assert.equal(r.claimed, "MEAL_SUGGESTION",
        `the generalist stopped owning a question it should own: "${msg}" → ${r.claimed}`);
    }
    // Pre-workout timing has NO specialist. Standing down here handed it to the food diary
    // ("No meals logged yet today"), which is worse than the card it replaced.
    const pre = await serialise(() => replyTo("What can I eat before the gym?"));
    assert.equal(pre.claimed, "MEAL_SUGGESTION",
      `a question with no specialist owner was stood down to a worse handler: ${pre.claimed}`);

    // THE BUDGET ANSWER SURVIVES. "what can i eat" was removed from the totals predicate; these
    // four carry that question and must be untouched.
    for (const msg of ["How many calories do I have left?", "Can I still eat?", "What's left today?", "calories left"]) {
      const r = await serialise(() => replyTo(msg));
      assertCustomerOutcome(r.out, {
        got: /\d[\d,]*\s*kcal|calories/i,
        because: `the budget question must still be answered: "${msg}"`,
      });
    }
  });

  check("one mouth . the moved session is the renderer's output, not a lookalike", async () => {
    const { renderSession } = await import("../server/programme");
    const { getTodaySlot } = await import("../server/workout-state");
    const g = globalThis as any;
    const moved = await serialise(async () => {
      g.__KAMLIFE_STUB_USER = { ...USER, trainingDaysPerWeek: 6 };
      try { return String(await handleMessage(USER.phoneNumber, "No I moved yesterdays workout to today") ?? ""); }
      finally { g.__KAMLIFE_STUB_USER = { ...USER }; }
    });
    const canonical = renderSession({ ...USER, trainingDaysPerWeek: 6 },
      { slot: getTodaySlot({ ...USER, trainingDaysPerWeek: 6 }), doneHint: "Send *done* when finished." });
    // The exercise block is the part a second copy would drift on — compare that, not the intro.
    const body = canonical.split("\n\n").filter(p => /\d/.test(p) && p.length > 40)[0] || "";
    assert.ok(body.length > 40, "the renderer produced no session body to compare against");
    assert.ok(moved.includes(body),
      `the moved-session reply is not the renderer's output — a second composition site has appeared.\n`
      + `      renderer: ${body.slice(0, 120)}\n      moved:    ${moved.slice(0, 200)}`);
  });

  // THE CONTROL. A genuine refusal must still be honoured, or the case above passes by making
  // the coach incapable of hearing "no".
  check("training day control . a genuine rest day is still honoured", async () => {
    const reply = await serialise(() => say("rest day today"));
    assert.ok(!/Week \d|Next Session|Send \*?DONE/i.test(reply),
      `a rest day was answered with the session: ${reply.slice(0, 120)}`);
  });

  // ── OUTPUT DEFECTS FROM THE HANDSET (2026-08-25) ──────────────────────────────────────────
  //
  // Two of the five screenshots are NOT comprehension failures. The system understood correctly
  // and then told the client something else. Both are fixtures now.
  check("receipt . the confirmation names every food, or says how many it did not", async () => {
    const { buildFoodLogReply } = await import("../server/handlers/food-scanner");
    // The voice note, verbatim: four foods, all scanned, all priced, all written.
    const said = "So my breakfast was, uh, three eggs, three slices of bread, some chakalaka and a piece of chicken";
    const mk = (lines: string[]) => buildFoodLogReply({
      foodLines: lines.join("\n"), mealLabel: "breakfast", totalMealCals: 810, totalMealProtein: 72,
      runningCals: 856, runningProtein: 72, calorieTarget: 3140, proteinTarget: 186,
      user: { name: "Kam", goalType: "muscle_gain", numbersMode: "low" },
      userMessage: said, terse: true, isRetro: false,
    } as any);

    const four = String(await mk(["• Bread: 240 kcal", "• Eggs: 210 kcal",
      "• Chicken thigh (150g): 280 kcal", "• Chakalaka: 80 kcal"]));
    assert.match(four, /chakalaka/i,
      `the receipt dropped a food that was logged — this is what makes clients "correct" us: ${four}`);

    // A cap is still right for a long photo list. What is not right is a cap that HIDES.
    const six = String(await mk(["• Bread: 1", "• Eggs: 1", "• Chicken thigh: 1",
      "• Chakalaka: 1", "• Slices: 1", "• Piece: 1"]));
    assert.match(six, /and 2 more/i, `six foods were truncated with no count: ${six}`);
    assert.ok(!/Chakalaka\.\s*👌/.test(six) || /more/.test(six),
      "a truncated list must say how many it left out");
  });

  check("header . Week and Session are on different clocks, and it says so", async () => {
    const { sessionHeaderLine } = await import("../server/programme");
    // THE SCREENSHOT: "*Week 1 — Session 25*". programmeWeek is PHASE-RELATIVE and resets; the
    // session count is LIFETIME. Both numbers were right and the header was a contradiction.
    const h = sessionHeaderLine(1, 24);
    assert.match(h, /Session 25 overall/,
      `Week and Session still read as one clock: ${h}`);
    assert.equal(sessionHeaderLine(1, 0), "*Week 1*",
      "a client with no sessions should not be given a session number at all");
    assert.equal(sessionHeaderLine(3, 8), "*Week 3 — Session 9 overall*");
    // …and the string that shipped this morning must not be reachable from the owner.
    for (const [w, d] of [[1, 24], [3, 8], [5, 2]] as Array<[number, number]>) {
      assert.ok(!/— Session \d+\*$/.test(sessionHeaderLine(w, d)),
        `the unqualified header is back: ${sessionHeaderLine(w, d)}`);
    }
  });

  // THE OUTCOME, not the owner. The parity USER is already programmeWeek 1 with 24 sessions —
  // the screenshot's exact state — so the composed message is reachable, and asserting the owner
  // alone would pass even if no caller used it. This is the string on the handset.
  check("header outcome . the workout the client is sent does not contradict itself", async () => {
    const g = globalThis as any;
    // TWO CALLERS, AND NEITHER OF THEM IS THE CALENDAR.
    //
    // This asked for "workout" with trainingDaysPerWeek raised to 6, on the reasoning that six
    // days puts today inside the programme whenever the suite runs. It does not: SCHEDULE_MAP
    // tops out at Mon–Sat, so NOBODY trains on a Sunday, and every Sunday this check received
    // "*Sunday — Rest Day.*", found no header, and went red on the day of the week rather than on
    // the code. A suite that is green six days in seven is not a gate, and its redness on the
    // seventh teaches everyone to ignore it.
    //
    // renderSession has exactly two callers — the `workout` command and the moved-into-today
    // path — and programme.ts says in as many words that having both end at one function is the
    // property worth having. The moved path composes on a rest day BY DESIGN ("a client saying
    // they moved a session into today has already decided they are training"), so asking both
    // reaches a composed session on any day of the week, and grades both mouths instead of one.
    const replies = await serialise(async () => {
      g.__KAMLIFE_STUB_USER = { ...USER, trainingDaysPerWeek: 6 };
      const ask = async (text: string) => {
        try { return String(await handleMessage(USER.phoneNumber, text) ?? ""); }
        catch (e: any) { return `__THREW__ ${e?.message || e}`; }
      };
      try { return [await ask("workout"), await ask("no I moved yesterdays workout to today")]; }
      finally { g.__KAMLIFE_STUB_USER = { ...USER }; }
    });
    const headers = replies.flatMap(r => r.split("\n").filter(l => /\*Week \d/.test(l)));
    // NOT VACUOUS: at least one of the two must have actually composed a session, so a build that
    // stops delivering sessions altogether fails here rather than passing with an empty list.
    assert.ok(headers.length, `neither the workout command nor a moved session composed a week `
      + `header: ${replies.map(r => r.slice(0, 120)).join(" || ")}`);
    for (const header of headers) {
      assert.ok(!/— Session \d+\*\s*$/.test(header.trim()),
        `Week and Session are still printed as one clock: ${header}`);
      if (/Session \d/.test(header)) {
        assert.match(header, /Session \d+ overall/,
          `a session number without its clock named: ${header}`);
      }
    }
  });

  // ── THE HARNESS MUST BE ABLE TO EXPRESS TIME ──────────────────────────────────────────────
  //
  // Until 2026-08-25 the stub's `.where()` discarded its condition, so a today-scoped query and an
  // all-time query returned the same rows. Two checks in this file (2b, 2c) asserted that a
  // TODAY-scoped correction succeeded while seeding only a YESTERDAY row — they passed because the
  // window was never applied, and could not have failed for the right reason.
  //
  // Every temporal assertion in this suite now rests on that filter working, which is exactly why
  // it gets its own check: if the evaluator silently stops matching, the failure mode is not a red
  // suite, it is a green one that has quietly stopped testing days again.
  check("harness: a day-scoped query does not see another day's row", async () => {
    const { db } = await import("../server/db");
    const { mealLogs } = await import("../shared/schema");
    const { gte } = await import("drizzle-orm");
    const g = globalThis as any;
    const before = g.__KAMLIFE_STUB_ROWS;
    try {
      g.__KAMLIFE_STUB_ROWS = new Map([[mealLogs, [
        { id: "h-today", loggedAt: new Date(NOW - 3600_000) },
        { id: "h-yesterday", loggedAt: new Date(NOW - 30 * 3600_000) },
      ]]]);
      const scoped: any[] = await db.select().from(mealLogs)
        .where(gte(mealLogs.loggedAt, new Date(NOW - 12 * 3600_000)));
      assert.deepEqual(scoped.map(r => r.id), ["h-today"],
        `the window returned ${scoped.length} rows — the stub is ignoring \`where\` again`);
      // …and an unfiltered read must still see everything, or the filter has become a truncation.
      const all: any[] = await db.select().from(mealLogs);
      assert.equal(all.length, 2, "an unscoped read lost rows");
    } finally {
      if (before) g.__KAMLIFE_STUB_ROWS = before; else delete g.__KAMLIFE_STUB_ROWS;
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

  await Promise.all(pending); // every async check must land before the tally is printed
  console.log(`\nproduction-parity: ${passed}/${passed + failures.length} passed`);
  reportPending();
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

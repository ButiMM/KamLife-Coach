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
/** Midday on the most recent past Saturday — for fixtures that correct a named weekday. */
function lastSaturday(): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  const back = (d.getDay() - 6 + 7) % 7 || 7;   // never today: "from Saturday" means a past one
  d.setDate(d.getDate() - back);
  return d;
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
    assert.ok(!/Days logged|Avg: \*|last 7 days|Sessions:/i.test(struggle),
      `a life question was answered with a progress scoreboard:\n      ${struggle.slice(0, 200)}`);
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
          `${f} appends an instruction that did not come from the decision owner: ${line.trim().slice(0, 90)}`);
      }
    }
    const live = readFileSync("server/understanding/live.ts", "utf-8");
    assert.ok(/underPolicy\(chooseAction\(/.test(live),
      "computeNextMove must reach chooseAction through the policy contract");
    assert.ok(/getProgressTruth\(/.test(live),
      "…and decide on canonical state, not on numbers it gathered itself");
  });

  check("every caller hands the decision owner the same world", () => {
    // ONE CONSTITUTION IS NOT ONE DECISION if two callers feed it materially different inputs.
    // The weekly answer passed WEEKLY AVERAGES into fields that mean today — window.avgProtein
    // into `proteinPct`, avgSteps into `stepsToday` (the name says it) — and froze the clock at
    // `hour: 12`, so the evening rule could never fire there and the same client could get a
    // different "one thing" from the weekly card than from the coach five minutes earlier.
    //
    // The card's NUMBERS are weekly; the ACTION is what to do next, which is a daily question and
    // the only one chooseAction was built to answer. Asserted at the call site, because this is a
    // semantics bug that produces no crash and no visible difference in a green suite.
    for (const f of ["server/handlers/misc-commands.ts", "server/understanding/live.ts"]) {
      const code = readFileSync(f, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
      const call = /chooseAction\(\{([\s\S]*?)\}\s*(?:as any)?\)/.exec(code);
      if (!call) continue;
      const args = call[1];
      for (const [field, wrong] of [["proteinPct", /window\.avg/], ["caloriePct", /window\.avg/],
                                    ["stepsToday", /avgSteps/]] as const) {
        const line = args.split("\n").find(l => l.includes(field + ":")) || "";
        assert.ok(!wrong.test(line),
          `${f} feeds a WEEKLY AVERAGE into ${field}, which means today. Two callers, two worlds, `
          + `one decision function: ${line.trim().slice(0, 90)}`);
      }
      const hourLine = args.split("\n").find(l => /\bhour:/.test(l)) || "";
      assert.ok(!/hour:\s*\d+/.test(hourLine),
        `${f} freezes the clock (${hourLine.trim().slice(0, 40)}). The decision reads the hour to `
        + `know whether an instruction can still be acted on today; a literal makes that a lie.`);
    }
  });

  check("chooseAction is the only coaching decision owner", () => {
    const owner = readFileSync("server/one-action.ts", "utf-8");
    assert.ok(/export function chooseAction/.test(owner));
    // Nothing outside the owner module may define a competing verdict producer.
    for (const f of ["server/handlers/misc-commands.ts", "server/scheduler/jobs/morning.ts",
                     "server/handlers/gpt-block.ts", "server/health-state.ts"]) {
      const src = readFileSync(f, "utf-8");
      assert.ok(!/function\s+(choose|decide)[A-Z]\w*\s*\(/.test(src),
        `${f} defines its own decision function — chooseAction is the only one`);
    }
  });

  // ── THE RULE'S COVERAGE, MEASURED AND PRINTED ─────────────────────────────────────────────
  // The provenance rule compares model prose to the CANONICAL DECISION'S OWN TEXT, by domain.
  // What it cannot do is recognise a directive whose grammar falls outside "advisory or
  // imperative" — so the honest guarantee is bounded, and the bound belongs in every CI run
  // rather than in a report nobody re-reads.
  //
  // Measurement, not detection. Adding cases here does not make the product safer; the residue
  // closes only by making the model emit structure instead of prose, which is a larger change
  // than this cut was authorised to make.
  {
    const { verifyBrainReply } = await import("../server/brain/reply-verifier");
    const F = { clientMessage: "hi", evidence: { modelAuthored: true, canonicalKind: "hold", canonicalTodo: "" } } as any;
    const blocked = (r: string) => !verifyBrainReply(r, F).ok;
    const CASES = [
      "Train chest today.", "Go to the gym today.", "Get your session done today.",
      "You should hit legs today.", "Today is a good day for an upper body workout.",
      "I'd get a push session in this afternoon.", "Let's do chest and triceps today.",
      "Skip the gym today.", "Take a rest day.", "Rest today.", "Don't train today.",
      "I'd give training a miss today.", "Sit today out.",
      "Go for a 20-minute walk.", "Add 3000 steps today.", "Take a walk after dinner.",
      "Try to get an extra walk in.", "A brisk 30 minutes outside would help.",
      "Weigh yourself tomorrow morning.", "Step on the scale tomorrow.", "Jump on the scale in the morning.",
      "Eat 30g more protein.", "Add another 40g of protein today.",
      "Drop your calories to 1800.", "Lower your intake to 2000 kcal.",
      "I'd bring your calories down a bit.", "Push your protein higher tomorrow.",
    ];
    const caught = CASES.filter(blocked).length;
    const pct = Math.round(caught / CASES.length * 100);
    console.log(`\n── prescription provenance ──\n${caught}/${CASES.length} plausible unlicensed `
      + `phrasings refused on a CONTINUE turn (${pct}%). The residue ships. The rule compares prose `
      + `to the canonical decision's own text; what escapes is grammar it does not recognise as an `
      + `instruction, and that closes structurally, not with more signatures.`);

    // The guarantee: on a CONTINUE turn — no canonical decision — the model may not introduce a
    // behavioural instruction. That is the dangerous case and it must not rot.
    check("no decision means no directive, whatever the phrasing", () => {
      for (const r of ["Train chest today.", "Skip the gym today.", "Go for a 20-minute walk.",
                       "Weigh yourself tomorrow morning.", "Drop your calories to 1800.",
                       "Eat 30g more protein.", "You should hit legs today.",
                       "I'd get a push session in this afternoon.", "Take a rest day."]) {
        assert.ok(blocked(r), `the model could invent an instruction on a CONTINUE turn: ${r}`);
      }
    });
  }

  // ── P0-1 · TRAINING SPEECH BECOMES AUTHORITATIVE STATE ────────────────────────────────────
  // 2026-08-21 handset: "I went to the gym in the morning" and "I did all four workouts this
  // week" both fell past the workout writer (isDone was ^…$ anchored) and were confirmed by the
  // model — "Noted 👌" — while the card two minutes later said WORKOUTS 1.
  check("a reported session reaches the writer; a count claim does not fabricate rows", async () => {
    const wk = readFileSync("server/handlers/workout.ts", "utf-8");
    const code = wk.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/const isDone = !alreadyLoggedThisTurn && when\.when === "today" && \(reportsOneSession \|\|/.test(code),
      "the completion path must accept a natural session report, not only the anchored forms — and "
      + "only when the client said today");
    assert.ok(/sessionCountsIn\(m\)\.length === 0/.test(code),
      "a count claim must NOT be logged — we know how many, not which days, and undated rows are invented data");
    for (const guard of ["FUTURE_OR_INTENT", "NEGATED_SESSION", "SOMEONE_ELSE", "OTHER_DOMAIN"]) {
      assert.ok(new RegExp(`!${guard}\\.test\\((?:m|clause)\\)`).test(code),
        `the session report must be guarded by ${guard} — "I'm going to the gym later" is not a log`);
    }

    // ONE OWNER, BOTH SIDES. The writer refuses to invent rows from a count claim and the verifier
    // refuses to confirm one; they must be reading the same sentence the same way, or the exact
    // message that caused both rules will be classified differently by each.
    const { sessionCountsIn } = await import("../server/utils");
    assert.deepEqual(sessionCountsIn("I did all four workouts this week"), [4],
      "the count claim that started this must be seen as a count");
    for (const single of ["I did a 45 minute session today", "I went to the gym in the morning",
                          "did my 45 min workout", "my fourth session today", "3 sets of 10"]) {
      assert.deepEqual(sessionCountsIn(single), [],
        `a single dated report must still reach the writer: ${single}`);
    }
    assert.ok(!/const SESSION_COUNT = /.test(code),
      "the writer must not keep a private copy of the count matcher — that is the drift this cut removed");
  });

  // NEGATIVE CONTROL 1 — remove turnMutation from the workout writer and this must go red.
  //
  // The previous version of this check asked whether the STRING "turnMutation(" appeared anywhere
  // in four files. workout.ts contains four separate inserts; three of them could lose their
  // recording and the file would still contain the word. That is the proxy-instead-of-the-property
  // defect this harness exists to catch, and it was in the harness. It now audits every durable
  // insert in the server, which is how the 15 unrecorded ones were found.
  check("EVERY durable write records itself on the turn — not just one per file", () => {
    const LEDGER = /\.insert\((workoutLogs|stepLogs|weightLogs|mealLogs)\)/;
    const WINDOW = 18;   // statement + .values({…}) + the recording that follows it
    const unrecorded: string[] = [];
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (e.endsWith(".ts")) out.push(full);
      }
      return out;
    };
    for (const file of walk("server")) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (!LEDGER.test(line)) return;
        const after = lines.slice(i, i + WINDOW).join("\n");
        if (!/\bturnMutation\(/.test(after)) unrecorded.push(`${file}:${i + 1} — ${line.trim().slice(0, 60)}`);
      });
    }
    assert.equal(unrecorded.length, 0,
      `durable writes that the turn does not know about — the write-integrity check cannot see `
      + `these, so the coach can say "Noted" over them:\n      ${unrecorded.join("\n      ")}`);
  });

  // NEGATIVE CONTROL 2 / P0-B — the temporal contract, graded on what actually gets written.
  //
  //   explicit today            → today write
  //   explicit historical date  → retro write, on the day they named
  //   a span, or ambiguous      → NO today write
  //
  // Graded by watching the durable-write records the turn emits, not by reading the source: the
  // previous version of this check asserted a variable name, and a variable name is not a write.
  check("a training report is written to the day the client actually named", async () => {
    const { statedWhen } = await import("../server/utils");
    const { sastDayKey } = await import("../server/sast");
    const today = sastDayKey();
    const yesterday = sastDayKey(new Date(Date.now() - 86_400_000));

    // What the pipeline COMMITTED this turn. "INSERT workout … at=<date>" is the retro writer;
    // an "INSERT workout" with no date is a write to today.
    const writesFor = (msg: string) => serialise(async () => {
      const from = CONSOLE_LINES.length;
      await say(msg);
      const workoutWrites = CONSOLE_LINES.slice(from).filter(l => /INSERT workout\b/.test(l));
      return {
        today: workoutWrites.some(l => !/\bat=/.test(l)),
        retro: workoutWrites.map(l => /\bat=(\d{4}-\d{2}-\d{2})/.exec(l)?.[1]).filter(Boolean) as string[],
      };
    });

    // 1. "I trained Monday" — a day is named. It may NOT become today.
    assert.equal(statedWhen("I trained Monday").when, "historical");
    const monday = await writesFor("I trained Monday");
    assert.ok(!monday.today, "a session reported for Monday was written to today");
    assert.ok(monday.retro.length === 0 || monday.retro.every(d => d !== today),
      `the Monday session landed on today: ${monday.retro.join(",")}`);

    // 2. "I trained last week" — a SPAN. No day to write, so nothing is written.
    assert.equal(statedWhen("I trained last week").when, "ambiguous");
    const lastWeek = await writesFor("I trained last week");
    assert.ok(!lastWeek.today, "a session reported for 'last week' was written to today");

    // 3. "I trained yesterday" still reaches the retro writer, on yesterday.
    assert.equal(statedWhen("I trained yesterday").when, "historical");
    const yday = await writesFor("I trained yesterday");
    assert.ok(!yday.today, "yesterday's session was written to today");
    assert.ok(yday.retro.includes(yesterday),
      `yesterday's session was not written to ${yesterday}: ${yday.retro.join(",") || "no write"}`);

    // 4. "I trained this morning" still logs today.
    assert.equal(statedWhen("I trained this morning").when, "today");
    const thisMorning = await writesFor("I trained this morning");
    assert.ok(thisMorning.today, "an explicit today report no longer logs today");

    // The writer must not keep a second opinion about dates.
    const wk = readFileSync("server/handlers/workout.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(!/hasRetroDayRef/.test(wk) && !/parseMealDate\(m\)/.test(wk),
      "the workout writer must consult the one temporal owner, not re-derive the day itself");
    assert.ok(/const isDone = !alreadyLoggedThisTurn && when\.when === "today" &&/.test(wk),
      "every today-write must be gated on the temporal verdict, including the anchored short forms");
  });

  // NEGATIVE CONTROL 1b (P0-1B) — the model may not confirm a training history the log denies.
  check("workoutLogs says 1, the model says 4 — the client hears the record", async () => {
    const { verifyBrainReply } = await import("../server/brain/reply-verifier");
    const held = { modelAuthored: true, sessionsWindow: 1, sessionsWindowDays: 7 };
    // The handset sentence, verbatim (2026-08-21 14:36).
    const live = verifyBrainReply("That's impressive — all four workouts done this week! Noted 👌",
      { clientMessage: "I did all four workouts this week", evidence: held });
    assert.ok(!live.ok, "the coach agreed with a training history the record contradicts");
    assert.ok(/\b1\b/.test(live.violation || ""), "…and the correction must name what the record holds");

    // Agreeing with the CLIENT is not provenance. Held state outranks their own figure.
    assert.ok(!verifyBrainReply("You've done 4 sessions this week.",
      { clientMessage: "I did 4 sessions", evidence: held }).ok,
      "the client saying it does not make it true when the log says otherwise");

    // The count we hold, recited, must pass — and so must the programme, which is not a claim.
    for (const ok of ["That's 1 session on the record this week.", "Your programme is 3 sessions a week.",
                      "Your target is 4 workouts this week."]) {
      assert.ok(verifyBrainReply(ok, { clientMessage: "", evidence: held }).ok,
        `an honest reply was destroyed: ${ok}`);
    }
    // The window is half the claim: a 7-day count is not a lifetime total.
    assert.ok(!verifyBrainReply("That's 1 workout in total since you started.",
      { clientMessage: "", evidence: held }).ok, "a count for a window we never counted must not ship");
    // Deterministic replies recite counts they read themselves.
    assert.ok(verifyBrainReply("That's 4 workouts this week.",
      { clientMessage: "", evidence: { sessionsWindow: 1, sessionsWindowDays: 7 } }).ok,
      "the rule must apply to model prose only");
    // The count has to REACH the turn, or none of the above can fire.
    assert.ok(/turnEvidence\(\{ sessionsWindow/.test(readFileSync("server/day-ledger.ts", "utf-8")),
      "the authoritative session count must be left on the turn by the read that already ran");
  });

  // P0-A — THE CHECK CANNOT BE WALKED AROUND BY ROUTE ────────────────────────────────────────
  //
  // The rule above only bound turns where getProgressTruth happened to run. Most model paths do
  // not call it, and on those the boundary held no count — so the fallback ("the client said four
  // themselves") passed the exact 21 August sentence. This drives a REAL turn through the one
  // outbound boundary, with the log holding 1, having never called getProgressTruth.
  check("a model count claim cannot reach the client on a turn that never read the count", async () => {
    const { inTurn, turnUser, turnEvidence } = await import("../server/handlers/chat-log");
    const { workoutLogs } = await import("../shared/schema");
    const g = globalThis as any;

    g.__KAMLIFE_STUB_ROWS = new Map([[workoutLogs, [{ n: 1 }]]]);   // authoritative count = 1
    try {
      const out = await inTurn("text", "I did all four workouts this week", async () => {
        turnUser(USER.id);
        // A model path, and NOTHING else: no getProgressTruth, no canonical decision, no ledger
        // read. This is the shape of a specialist-agent or short-reply turn.
        turnEvidence({ modelAuthored: true });
        return "That's four workouts this week — great going.";
      });

      assert.notEqual(out, "That's four workouts this week — great going.",
        "the model's count claim reached the client unchanged on a turn that held no count");
      assert.ok(!/\bfour\b|\b4\b/i.test(out),
        `the replacement still carries the fabricated count: ${out}`);

      // …and the refusal must be the EVIDENCED one. If the boundary had not fetched, the claim
      // would still be refused, but for the weaker reason — and the next unevidenced route would
      // be one read away from passing. This asserts the count was actually read on this turn.
      const { verifyBrainReply } = await import("../server/brain/reply-verifier");
      const unevidenced = verifyBrainReply("That's four workouts this week — great going.",
        { clientMessage: "I did all four workouts this week", evidence: { modelAuthored: true } });
      assert.ok(!unevidenced.ok, "with no count on the turn the claim must still be refused");
      assert.ok(/no authoritative count/i.test(unevidenced.violation || ""),
        "an absent count is refused for being absent — a number the client said is not the record");

      // THE POSITIVE HALF, and the one that proves the fetch actually happens. With the log
      // holding four, the same sentence is TRUE and must survive — which it can only do if the
      // boundary read the count on this turn. Without the fetch it would be refused as
      // unevidenced, and the fix would be destroying honest replies to close the dishonest one.
      g.__KAMLIFE_STUB_ROWS = new Map([[workoutLogs, [{ n: 4 }]]]);
      const truthful = await inTurn("text", "I did all four workouts this week", async () => {
        turnUser(USER.id);
        turnEvidence({ modelAuthored: true });
        return "That's four workouts this week — great going.";
      });
      assert.equal(truthful, "That's four workouts this week — great going.",
        "a count the record supports was destroyed — the boundary did not read it");

      // The invariant the boundary now guarantees, stated directly: held 1, claimed 4, blocked.
      const evidenced = verifyBrainReply("That's four workouts this week — great going.",
        { clientMessage: "I did all four workouts this week",
          evidence: { modelAuthored: true, sessionsWindow: 1, sessionsWindowDays: 7 } });
      assert.ok(!evidenced.ok && /holds 1/.test(evidenced.violation || ""),
        "authoritative 1 against a claimed 4 must be refused, naming the record");
    } finally {
      delete g.__KAMLIFE_STUB_ROWS;
    }

    const log = readFileSync("server/handlers/chat-log.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/scope\.evidence\.sessionsWindow == null[\s\S]{0,120}?sessionCountsIn\(draft\)[\s\S]{0,400}?sessionsSince\(/.test(log),
      "the boundary must fetch the authoritative count when a model draft asserts one and the turn holds none");
  });

  check("a confirmation requires a write that actually happened", () => {
    const log = readFileSync("server/handlers/chat-log.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/scope\.evidence\?\.modelAuthored && scope\.mutations\.length === 0/.test(log),
      "the boundary must know the turn wrote nothing");
    assert.ok(/CLAIMS_A_WRITE/.test(log) && /recordFalseConfirmation\(\)/.test(log),
      "…refuse the confirmation, and count it");
  });

  // ── P0-2 · THE MORNING BRIEF CANNOT CONTRADICT ITSELF ─────────────────────────────────────
  check("a rest day cannot be told to train", async () => {
    // The 06:00 brief sent "🛌 Rest day. No training" and "Get today's session done." in one
    // message, because the rest-day headline was computed in morning.ts while the action line came
    // from decideProactive — which was handed sessionsTarget: trainingDaysPerWeek regardless of
    // what day it was. The decision owner could not know, so it did its job on false input.
    const { chooseAction } = await import("../server/one-action");
    const base = {
      goal: "fat_loss", weeksOnProgramme: 4, daysSinceAnyLog: 0, daysSinceWeighIn: 2,
      loggedToday: true, proteinPct: 0.8, caloriePct: 0.7, sessionsThisWeek: 0,
      stepsToday: 3000, stepsTarget: 6000, hour: 7,
    } as any;
    const rest = chooseAction({ ...base, sessionsTarget: 0 });
    assert.ok(!/session|train|gym/i.test(rest.todo),
      `a rest day still produced a training instruction: ${rest.todo}`);
    const training = chooseAction({ ...base, sessionsTarget: 4 });
    assert.ok(/session|train/i.test(training.todo), "…and a training day still gets one");

    const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/sessionsTarget: isTodayTrainingDay \?/.test(morning),
      "the morning decision must be told whether today is a training day — the schedule is state, not a second policy");
  });

  // NEGATIVE CONTROL 3 — restore the STRUGGLING closing prescription and this must go red.
  //
  // Graded on the COMPLETE MESSAGE, not on decisionLine. decisionLine was already correct on
  // 21 August; the contradiction came from a DIFFERENT part of the same message, so a test that
  // only reads the decision cannot see the defect it is meant to catch.
  check("the whole morning brief carries exactly one instruction, from one owner", async () => {
    const { composeMorning, morningClosingLine } = await import("../server/morning-message");
    const { carriesDirective } = await import("../server/brain/reply-verifier");

    const restDay = ["*Today:*", "👟 8,500 steps", "🛌 Rest day. No training — stay on food and steps."];
    const base = {
      firstName: "Kam", targetFixLine: "", identityLine: "", streakLine: "", workoutLine: "",
      yesterdayLine: "120g protein logged yesterday, against a 150g target.",
      todayLines: restDay, decisionLine: "", breakfastAsk: "🍳 What's for breakfast?",
      adaptLine: "", sickYesterday: false,
    };

    for (const trajectory of ["ON_A_RUN", "ON_TRACK", "RECOVERING", "STRUGGLING", "DISENGAGED"] as const) {
      for (const activelyEngaged of [true, false]) {
        const closingLine = morningClosingLine(trajectory, { activelyEngaged, completedSessions28: 2 }).trim();
        const message = composeMorning({ ...base, closingLine });

        // THE PART THAT IS NOT THE PLAN AND NOT THE DECISION MAY NOT INSTRUCT. On this brief the
        // decision is `hold` — the honest verdict on a rest day — so ANY instruction in the
        // message is a second authority, and on 21 August it was "let's get one in today" three
        // lines under "Rest day. No training".
        const narrative = message.split("\n\n")
          .filter(p => !p.startsWith("*Today:*") && !restDay.some(l => p.includes(l)) && !p.startsWith("🍳"));
        for (const part of narrative) {
          for (const sentence of part.split(/(?<=[.!?])\s+/)) {
            assert.ok(!carriesDirective(sentence),
              `${trajectory}/engaged=${activelyEngaged}: the brief instructs outside the decision — `
              + `"${sentence.trim()}" — in a message whose plan line says "Rest day. No training"`);
          }
        }
        // REWRITTEN 2026-08-24. This asserted the sign-off still carried a NUMBER — which was the
        // 28-day progress clock, since deleted as a second customer-facing scoreboard. Asserting
        // its survival now demands the very behaviour that was removed. The property that still
        // matters is the one this check exists for: whatever the sign-off says, the message
        // carries exactly one instruction and it is the decision's. That is asserted above, for
        // every trajectory. What is asserted here instead is that a genuinely LAPSED client is
        // still recognised — the warm re-entry that survived the deletion.
        if (!activelyEngaged && (trajectory === "RECOVERING" || trajectory === "DISENGAGED")) {
          assert.match(message, /have you back/i,
            `${trajectory}: a lapsed client lost their re-entry recognition`);
        }
      }
    }

    // …and when there IS a decision, it is the one instruction, and it arrives whole.
    const withDecision = composeMorning({
      ...base,
      closingLine: morningClosingLine("STRUGGLING", { activelyEngaged: false, completedSessions28: 2 }).trim(),
      decisionLine: "Kam — one thing today:\n\n*Log one meal today. Any meal.*\n\n_Six days of nothing logged is six days I can't coach._",
    });
    assert.ok(withDecision.includes("*Log one meal today. Any meal.*"), "the decision must reach the client intact");
    assert.ok(!/get one in today|Reply 1 and I'll send it/i.test(withDecision),
      "the closing line is prescribing beside the decision again");
  });

  // ── P0-3 · SILENCE IS NOT A TERMINAL STATE ────────────────────────────────────────────────
  check("a suppressed duplicate does not become silence", () => {
    const wa = readFileSync("server/routes/whatsapp.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    const dupBlock = /if \(isDuplicateOutbound\(phone, out\)\) \{([\s\S]*?)\n  \}/.exec(wa);
    assert.ok(dupBlock, "the duplicate branch must exist");
    assert.ok(!/\breturn;/.test(dupBlock[1]),
      "a duplicate reply must not end the turn in silence — the client asked twice because the "
      + "first answer did not land, which is when silence costs most");
    assert.ok(/out = /.test(dupBlock[1]), "…it must say something different instead");
    assert.ok(/recordSilentTurnAvoided\("duplicate"\)/.test(wa) && /recordSilentTurnAvoided\("empty"\)/.test(wa),
      "both silent-terminal causes must be counted, by cause");
  });

  // NEGATIVE CONTROL 4 — remove the empty-response fallback and this must go red.
  //
  // Counting the silence was half a fix: `recordSilentTurnAvoided("empty"); return;` told US
  // about the dropped turn and told the CLIENT nothing, which is the same 80 minutes of nothing
  // the founder sat through on 21 August. The two silent-terminal causes get the same treatment.
  check("an empty reply does not end the turn in silence either", () => {
    const wa = readFileSync("server/routes/whatsapp.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    const emptyBlock = /if \(!out\.trim\(\)\) \{([\s\S]*?)\n  \}/.exec(wa);
    assert.ok(emptyBlock, "the empty-reply branch must exist");
    assert.ok(!/\breturn;/.test(emptyBlock[1]),
      "an empty reply must not end the turn in silence — the client is left staring at a message "
      + "nobody answered, and knowing about it upstream does not answer it");
    assert.ok(/out = /.test(emptyBlock[1]),
      "…it must put an honest reply on the wire and carry on to the send");
    // Both branches must reach the same door. A fallback that is assigned and then skipped is
    // the same silence with extra steps.
    const afterBranches = wa.slice(wa.indexOf("if (!out.trim())"));
    assert.ok(/sendParts|sendTwilio|messages\.create/.test(afterBranches),
      "the repaired reply must still be sent");
  });

  // ── MULTI-INTENT TURN: WRITE BEFORE COACHING (2026-08-22 live P0) ─────────────────────────
  //
  // 21 August 11:24, verbatim. One bubble carrying a date correction, a coaching question, a food
  // report and a planning request. The food was never written: an EDUCATOR above the writer
  // claimed the turn on "what" from the question clause, priced the livers, and told the client to
  // "snap a photo when you get it". The verifier correctly refused a reply that priced a meal with
  // no write behind it, and the repair path, reading an empty ledger, asked the client to log the
  // meal they had just reported.
  //
  // THE INVARIANT: for an unambiguous durable fact, every applicable state write happens before
  // any educational or coaching response can become final.
  const HANDSET = "That day is today\nWhat's the plan for me?\n"
    + "My breakfast was 3 slices of bread, eggs and chicken livers\n\nGuide for the rest of the day";

  // Durable writes are observed through the turn's own mutation log — the record the write-
  // integrity boundary already trusts — not by reading source or trusting a reply's wording.
  const writesFor = (msg: string) => serialise(async () => {
    const from = CONSOLE_LINES.length;
    const out = await say(msg);
    const lines = CONSOLE_LINES.slice(from);
    return {
      out,
      meal: lines.some(l => /INSERT meal/i.test(l)),
      workout: lines.some(l => /INSERT workout/i.test(l)),
      continues: lines.some(l => /question continues to Coach K/i.test(l)),
      amended: lines.some(l => /UPDATE meal/i.test(l)),
      owed: lines.some(l => /\[TURN_OWED\]/.test(l)),
      mealDays: lines.filter(l => /INSERT meal/i.test(l)).map(l => /at=(\S+ \S+ \d+)/.exec(l)?.[1] || "").filter(Boolean),
      backfillWorkoutDays: lines.filter(l => /\[BACKFILL\] INSERT workout/.test(l)).map(l => /at=(\d{4}-\d{2}-\d{2})/.exec(l)?.[1] || "").filter(Boolean),
      // EVERY workout write this turn, whoever made it — a duplicate row on another day is the
      // defect the one-write-per-domain guard exists to stop, and it is invisible if we only
      // count the backfill's own writes.
      allWorkoutWrites: lines.filter(l => /INSERT workout/i.test(l)).length,
      allStepWrites: lines.filter(l => /INSERT steps/i.test(l)).length,
      backfillStepDays: lines.filter(l => /\[BACKFILL\] INSERT steps/.test(l)).map(l => /at=(\d{4}-\d{2}-\d{2})/.exec(l)?.[1] || "").filter(Boolean),
    };
  });

  check("the handset turn: the meal is written, and the coach does not ask for it again", async () => {
    const r = await writesFor(HANDSET);
    assert.ok(r.meal, "the breakfast the client reported was not written");
    assert.ok(!/log a meal or your steps and ask me again/i.test(r.out),
      `the client was asked to log the meal they just reported: ${r.out}`);
    assert.ok(!/snap a photo when you get it/i.test(r.out),
      "an educator answered a finished breakfast as a future street purchase");
    assert.ok(!/send the items in one line/i.test(r.out),
      `mustForceFoodLog stole the turn after the write: ${r.out}`);
    assert.ok(!/plate method/i.test(r.out),
      `the plate educator stole the continuation: ${r.out.slice(0, 180)}`);
  });

  check("a fact is not vetoed by a question in another clause — and not only for food", async () => {
    const food = await writesFor("My breakfast was 3 slices of bread, eggs and chicken livers. What's the plan for today?");
    assert.ok(food.meal, "food + question lost the meal");
    const workout = await writesFor("I trained chest today. What should I eat now?");
    assert.ok(workout.workout, "workout + question lost the session — the fix is food-specific");
    // The question BEFORE the fact, and a planning clause after it — both suppressed the report
    // at a different layer (the door's veto, and the fact parser's own planning guard).
    for (const both of ["My breakfast was eggs and pap. What should I eat next?",
                        "Is that enough protein? My breakfast was eggs and pap."]) {
      assert.ok((await writesFor(both)).meal, `a reported meal was lost to its neighbour clause: ${both}`);
    }
    // …and an ASK is still an ask. These must write nothing.
    for (const ask of ["Is chicken good for me?", "What should I eat for lunch?",
                       "I'm at the taxi rank, what should I get?", "Can I have a beer tonight?",
                       "Should I hit the gym today?", "Did I train today?",
                       "I'll have chicken and rice later", "Is a kota ok?"]) {
      const r = await writesFor(ask);
      assert.ok(!r.meal && !r.workout, `a question was written as a fact: "${ask}" → ${r.out.slice(0, 60)}`);
    }
  });

  check("a handler that stands down for an owed write does not lose its own answer", async () => {
    // "No send removed until its behaviour is accounted for by the new owner." The supplement
    // confirmation is the only thing that knows what creatine is; it must survive the stand-down.
    const r = await writesFor("I took my creatine. My breakfast was eggs and pap.");
    assert.ok(r.meal, "the meal beside the supplement was lost");
    assert.ok(/taken|creatine/i.test(r.out), `the supplement confirmation vanished: ${r.out}`);
  });

  check("committed means committed", async () => {
    const { durableDomains } = await import("../server/understanding/messy-intake");
    assert.deepEqual(durableDomains([]), [], "an empty turn has committed nothing");
    assert.deepEqual(durableDomains(["INSERT meal kcal=669 prot=63"]), ["food"]);
    // The 21 August turn "But I'll be at restaurants / Come on / Did you even log the food?"
    // carries no food and wrote nothing, and printed `[TURN] committed food`.
    assert.deepEqual(durableDomains(["TURN committed food"]), [],
      "a ledger key is not a row — `committed` must read the durable write record");
    const routes = readFileSync("server/routes.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/durableWrites: turnMutations\(\)/.test(routes),
      "resolveTurn must be told what was durably written, not left to infer it");
    assert.ok(/factsStillOwed\(\)\.length === 0 && !mustStayDeterministic/.test(routes),
      "the engine is a mouth above the writers and must stand down on an owed fact");
  });

  // WRITE → COACH (2026-08-22). The meal now writes; the turn still died at the ack because
  // alsoAsksCoach required isMultiPartAsk (≥35 words / two '?') or a feeling. The handset
  // bubble is 27 words and one '?'. Continuation is: question AND this turn durably wrote.
  check("a question after a durable write continues — the ack is not terminal", async () => {
    const { resolveTurn, newTurnLedger, commitFact, durableDomains } = await import("../server/understanding/messy-intake");
    const { looksLikeQuestion } = await import("../server/utils");

    const eggs = "I had eggs";
    assert.equal(looksLikeQuestion(eggs), false);
    const eggsLedger = newTurnLedger(["food"]);
    commitFact(eggsLedger, "food", "Got it — eggs.");
    const eggsResolved = resolveTurn(eggsLedger, {
      hasFeeling: false,
      alsoAsksCoach: looksLikeQuestion(eggs) && durableDomains(["INSERT meal"]).length > 0,
      durableWrites: ["INSERT meal"],
    });
    assert.ok(eggsResolved.reply, "a food report with no question must still ack");
    assert.ok(/got it/i.test(eggsResolved.reply!), `ack vanished: ${eggsResolved.reply}`);

    const permission = "Is chicken liver okay?";
    assert.equal(looksLikeQuestion(permission), true);
    const permResolved = resolveTurn(newTurnLedger(), {
      hasFeeling: false,
      alsoAsksCoach: looksLikeQuestion(permission) && durableDomains([]).length > 0,
      durableWrites: [],
    });
    assert.equal(permResolved.reply, null, "no write → no ack; existing question path continues");
    assert.equal(permResolved.committed, "");

    const plan = "I had eggs. What's the plan for the rest of my day?";
    assert.equal(looksLikeQuestion(plan), true);
    const planLedger = newTurnLedger(["food"]);
    commitFact(planLedger, "food", "Got it — eggs.");
    const planResolved = resolveTurn(planLedger, {
      hasFeeling: false,
      alsoAsksCoach: looksLikeQuestion(plan) && durableDomains(["INSERT meal kcal=1"]).length > 0,
      durableWrites: ["INSERT meal kcal=1"],
    });
    assert.equal(planResolved.reply, null, "write + question must not finish at the ack");
    assert.equal(planResolved.committed, "food");

    const handsetLedger = newTurnLedger(["food"]);
    commitFact(handsetLedger, "food", "Got it — bread, eggs, chicken livers.");
    const handsetResolved = resolveTurn(handsetLedger, {
      hasFeeling: false,
      alsoAsksCoach: looksLikeQuestion(HANDSET) && durableDomains(["INSERT meal"]).length > 0,
      durableWrites: ["INSERT meal"],
    });
    assert.equal(looksLikeQuestion(HANDSET), true, "the handset bubble is a question");
    assert.equal(handsetResolved.reply, null, "the handset ack must not be terminal");
  });

  check("I had eggs acks; a plan-ask after a meal write continues; a bare food question does not write", async () => {
    const report = await writesFor("I had eggs");
    assert.ok(report.meal, "I had eggs must write");
    assert.ok(!report.continues, "a report with no question must not continue to the coach");
    assert.ok(/\b(got it|logged)\b/i.test(report.out), `ack-only vanished: ${report.out}`);

    const ask = await writesFor("Is chicken liver okay?");
    assert.ok(!ask.meal, "a permission ask must not write a meal");

    const both = await writesFor("I had eggs. What's the plan for the rest of my day?");
    assert.ok(both.meal, "eggs + plan lost the meal");
    assert.ok(both.continues, "eggs + plan finished at the ack — the plan never ran");
    assert.ok(!/log a meal or your steps and ask me again/i.test(both.out), both.out);
    assert.ok(!/send the items in one line/i.test(both.out),
      `mustForceFoodLog asked them to retype a meal that was written: ${both.out}`);

    const live = await writesFor(HANDSET);
    assert.ok(live.meal, "handset breakfast not written");
    assert.ok(live.continues, "handset turn died at the ack — coaching request discarded");
    assert.ok(!/log a meal or your steps and ask me again/i.test(live.out), live.out);
    assert.ok(!/send the items in one line/i.test(live.out), live.out);
    assert.ok(!/plate method/i.test(live.out),
      `misc plate stole the day-plan: ${live.out.slice(0, 180)}`);

    const rest = await writesFor("My breakfast was 3 slices of bread, eggs and chicken livers.\nGuide the rest of the day?");
    assert.ok(rest.meal, "exact regression lost the meal");
    assert.ok(rest.continues, "exact regression died at the ack");
    assert.ok(!/plate method/i.test(rest.out),
      `plate educator consumed the rest-of-day ask: ${rest.out.slice(0, 180)}`);
  });

  check("a genuine plate ask still owns the turn — only a write on this turn stands it down", async () => {
    const plate = await writesFor("show me the breakfast plate");
    assert.ok(!plate.meal, "a plate ask must not log a meal");
    assert.ok(/plate method/i.test(plate.out), `genuine plate request lost the guide: ${plate.out.slice(0, 160)}`);
    assert.ok(!plate.continues, "a plate-only ask is not a write-then-coach continuation");

    const routes = readFileSync("server/routes.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    const misc = readFileSync("server/handlers/misc-commands.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/wroteThisTurn/.test(routes) && /if \(wroteThisTurn\) return null/.test(misc),
      "the plate educator must stand down on wroteThisTurn — deleting getPortionGuide is not the fix");
    assert.ok(/getPortionGuide\(mealType\)/.test(misc),
      "NEGATIVE CONTROL: the plate capability stays; ownership is what changed");
  });

  check("continuation is load-bearing — isMultiPartAsk must not gate alsoAsksCoach", () => {
    const routes = readFileSync("server/routes.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/alsoAsksCoach: looksLikeQuestion\(message\) && durableDomains\(turnMutations\(\)\)\.length > 0/.test(routes),
      "alsoAsksCoach must be: question AND this turn durably wrote");
    assert.ok(!/alsoAsksCoach: looksLikeQuestion\(message\) && \(isMultiPartAsk/.test(routes),
      "NEGATIVE CONTROL: restoring isMultiPartAsk as the continuation gate must fail this test — the handset is 27 words and one '?'");
    assert.ok(/mustForceFoodLog && !durableDomains\(turnMutations\(\)\)\.includes\("food"\)/.test(routes),
      "mustForceFoodLog must not steal a turn that already wrote the meal");
    // chooseAction stays the owner; continuation reaches it only because handleGptBlock sits
    // below resolveTurn. Position is the guarantee — do not invent a second decision path.
    const resolveAt = routes.indexOf("resolveTurn(turn,");
    const gptAt = routes.indexOf("handleGptBlock({");
    const decisionOwner = readFileSync("server/handlers/gpt-block.ts", "utf-8");
    assert.ok(resolveAt > 0 && gptAt > resolveAt,
      "GPT must run AFTER the write/resolve, so canonicalDecision sees the new row");
    assert.ok(/canonicalDecision\(user/.test(decisionOwner),
      "the continuation path still decides through canonicalDecision → chooseAction");
  });

  check("specialists are advisors — they cannot be the WhatsApp mouth", () => {
    const gpt = readFileSync("server/handlers/gpt-block.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(!/gptReply = await nutritionAgent\(/.test(gpt), "nutritionAgent is still a mouth");
    assert.ok(!/gptReply = await programmingAgent\(/.test(gpt), "programmingAgent is still a mouth");
    assert.ok(!/gptReply = await mindsetAgent\(/.test(gpt), "mindsetAgent is still a mouth");
    assert.ok(!/gptReply = await adminAgent\(/.test(gpt), "adminAgent is still a mouth");
    assert.ok(/specialistNotes = factsOnlyNotes\(await nutritionAgent\(/.test(gpt), "nutrition must still supply notes");
    assert.ok(/DOMAIN NOTES/.test(gpt), "notes must be labelled as not-the-reply");
    assert.ok(/decisionBrief\(decision\)/.test(gpt), "the one mouth still receives the canonical decision");
    const notesAt = gpt.indexOf("factsOnlyNotes(await nutritionAgent");
    const mouthAt = gpt.indexOf("askCoachK(message, user, finalInstruction");
    assert.ok(notesAt > 0 && mouthAt > notesAt, "askCoachK must run AFTER the specialist, as the mouth");
    const agents = readFileSync("server/agents.ts", "utf-8");
    assert.ok(/ADVISOR_LIMIT/.test(agents), "specialists must not be told to always end with an action");
    assert.ok(!/Always end with one specific action/.test(agents),
      "NEGATIVE CONTROL: restoring HARD_LIMIT on specialists would re-invent the 13:27 walk");
  });

  check("salient situation is one line from client facts, not a chat dump", async () => {
    const { extractSalientSituation } = await import("../server/memory");
    const birthday = extractSalientSituation([
      "This weekend is my girlfriend's birthday. We going to restaurants.",
      "That day is today\nWhat's the plan for me?\nMy breakfast was eggs\nGuide for the rest of the day",
    ]);
    assert.match(birthday, /celebration outing|restaurant/i);
    assert.ok(!birthday.includes("eggs"), "breakfast is state, not situation");
    assert.equal(extractSalientSituation(["I had eggs"]), "");
    assert.equal(extractSalientSituation(["show me the breakfast plate"]), "");
    const gpt = readFileSync("server/handlers/gpt-block.ts", "utf-8");
    assert.ok(/loadSalientSituation\(phone, message\)/.test(gpt),
      "the one mouth must receive the situation line");
    assert.ok(!/OccasionEngine|RelationshipContextService/.test(gpt),
      "do not invent a situation service");
  });

  check("HOLD cannot be turned into a walk by leftover specialist copy", () => {
    const gpt = readFileSync("server/handlers/gpt-block.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/do not add an action from it/.test(gpt),
      "DOMAIN NOTES must forbid turning HOLD into an action");
    const log = readFileSync("server/handlers/chat-log.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/stripModelDirectives\(draft, scope\.evidence\)/.test(log),
      "HOLD still strips specialist-shaped instructions at the chokepoint");
  });

  check("DOMAIN NOTES are facts only — chicken/rice advice cannot become a second action", async () => {
    const { factsOnlyNotes } = await import("../server/agents");
    const leaked = factsOnlyNotes(
      "How about grilled chicken with mixed veggies and rice? Also try to get a 20-minute walk in.",
    );
    assert.equal(leaked, "", "unprefixed advice must be discarded, not forwarded to the Coach");
    const smuggled = factsOnlyNotes(
      "OPTION: grilled chicken and rice\nOPTION: take a 20-minute walk\nFACT: breakfast logged bread, eggs, chicken livers\nSTATE: protein 38g of 186g",
    );
    assert.match(smuggled, /FACT: breakfast/);
    assert.match(smuggled, /STATE: protein/);
    assert.ok(!/OPTION:/i.test(smuggled), "OPTION is a recommendation with a prefix — drop it");
    assert.ok(!/walk|how about/i.test(smuggled));
    const agents = readFileSync("server/agents.ts", "utf-8");
    assert.ok(/FACT: <one observed/.test(agents) && /No OPTION lines/.test(agents),
      "advisor contract must demand FACT/STATE only");
    const gpt = readFileSync("server/handlers/gpt-block.ts", "utf-8");
    assert.ok(/factsOnlyNotes\(await nutritionAgent/.test(gpt), "nutrition notes must pass the facts-only gate");
    assert.ok(!/Always end with one specific action/.test(agents),
      "NEGATIVE CONTROL: restoring HARD_LIMIT would re-invent the 13:27 walk");
    const brief = readFileSync("server/understanding/live.ts", "utf-8");
    assert.ok(/Write CONTEXT only/.test(brief), "the model is not asked to rephrase the action");
    assert.ok(!/Say this in your own words/.test(brief),
      "NEGATIVE CONTROL: restoring 'say this in your own words' re-opens the plate invention");
    const verifier = readFileSync("server/brain/reply-verifier.ts", "utf-8");
    assert.ok(/isImplementationChoice\(sentence\)/.test(verifier),
      "the chokepoint must drop implementation choice, not only domain-tagged directives");
  });

  check("morning breakfast replay uses the meal row, never a mixed chat bubble", async () => {
    const { breakfastReplayLine } = await import("../server/morning-message");
    const mixed = {
      rawMessage: "That day is today\nWhat's the plan for me?\nMy breakfast was 3 slices of bread, eggs and chicken livers\nGuide for the rest of the day",
      items: [{ name: "Bread" }, { name: "Eggs" }, { name: "Chicken livers" }],
      mealLabel: "breakfast",
    };
    const replay = breakfastReplayLine(mixed);
    assert.match(replay, /Bread/i);
    assert.match(replay, /Eggs/i);
    assert.ok(!/that day is today/i.test(replay), "must not replay the coaching bubble");
    assert.ok(!/guide for the rest/i.test(replay));
    assert.ok(!/\?/.test(replay));
    assert.equal(
      breakfastReplayLine({ rawMessage: mixed.rawMessage, items: [], mealLabel: "breakfast" }),
      "",
      "raw mixed bubble with no items is not a meal",
    );
    assert.equal(breakfastReplayLine({ rawMessage: "2 eggs and toast", items: [], mealLabel: "breakfast" }), "2 eggs and toast");
    const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/from\(mealLogs\)/.test(morning) && /breakfastReplayLine/.test(morning),
      "morning must read mealLogs, not FOOD_LOG.message_in");
    assert.ok(!/chatHistory\.messageIn/.test(morning),
      "NEGATIVE CONTROL: restoring chatHistory.message_in as the breakfast source must fail");
  });

  check("ops alerts cannot enter a client thread", () => {
    const sched = readFileSync("server/scheduler.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/resolveOpsAlertMsisdn\(\)/.test(sched), "scheduler diagnostics must go through the ops gate");
    assert.ok(!/COACH_ALERT_PHONE \|\| process\.env\.ADMIN_PHONE_OVERRIDE/.test(sched),
      "ADMIN_PHONE_OVERRIDE must not be a silent fallback onto a client number");
    const checklist = sched.slice(sched.indexOf("run(\"0 7 * * *\"") >= 0 ? sched.indexOf("0 7 * * *") : sched.indexOf("Setup Checklist"));
    assert.ok(/resolveOpsAlertMsisdn/.test(sched), "setup checklist uses the ops gate");
    const shared = readFileSync("server/scheduler/shared.ts", "utf-8");
    assert.ok(/destination is a coached client/.test(shared), "a client number must refuse the send");
  });

  check("WOW cannot manufacture a diagnostic question", async () => {
    const { sanitizeCoachReply } = await import("../server/handlers/food-scanner");
    const { isDiagnosticQuestion, isBareReaction, bareReactionFallback } = await import("../server/reaction-guard");
    assert.equal(isBareReaction("WOW"), true);
    assert.equal(isDiagnosticQuestion("What happened? Tell me."), true);
    const out = sanitizeCoachReply("What happened? Tell me.", "WOW");
    assert.ok(!isDiagnosticQuestion(out), "bare WOW must not ship 'what happened?'");
    assert.ok(!/what happened/i.test(out));
    const gpt = readFileSync("server/handlers/gpt-block.ts", "utf-8");
    assert.ok(/isDiagnosticQuestion\(shortReply\)/.test(gpt), "short-reply path must catch the diagnostic");
    assert.ok(!/Ask what happened\. Two words/.test(readFileSync("server/coach-prompt.ts", "utf-8")),
      "NEGATIVE CONTROL: restoring 'Ask what happened' for reactions must fail");
    void bareReactionFallback;
  });

  check("recall claims require evidence — birthday weekend, targets, miss", async () => {
    const { groundedRecallAnswer, looksLikeRecallQuestion } = await import("../server/memory");
    const prior = ["This weekend is my girlfriend's birthday. We're going out."];
    const q = "Do you remember what I said about my weekend?";
    assert.equal(looksLikeRecallQuestion(q), true);
    const hit = groundedRecallAnswer({ question: q, clientMessages: prior });
    assert.match(hit, /girlfriend'?s birthday/i);
    assert.ok(!/usually different/i.test(hit), "must not invent a generic weekend memory");
    assert.match(hit, /^Yes — you said:/);

    const viaSituation = groundedRecallAnswer({
      question: q,
      clientMessages: ["That day is today. Girlfriend's birthday. Going to restaurants."],
    });
    assert.match(viaSituation, /girlfriend'?s birthday/i);
    assert.ok(!/usually different/i.test(viaSituation));

    const miss = groundedRecallAnswer({
      question: "Do you remember what I said about Saturday?",
      clientMessages: ["I had eggs for breakfast"],
    });
    assert.equal(miss, "I don't have the exact detail in front of me. Remind me.");
    assert.ok(!/^Yes/i.test(miss));

    const targets = groundedRecallAnswer({
      question: "Do you remember my target?",
      clientMessages: [],
      calorieTarget: 2800,
      proteinTarget: 195,
      stepsTarget: 6000,
    });
    assert.match(targets, /2800/);
    assert.match(targets, /195/);
    assert.ok(!/usually/i.test(targets));

    const trained = groundedRecallAnswer({
      question: "Do you remember when I last trained?",
      clientMessages: [],
      lastWorkoutDate: "2026-08-17T08:00:00.000Z",
    });
    assert.match(trained, /17/i);
    assert.ok(!/usually/i.test(trained));

    const noTrain = groundedRecallAnswer({
      question: "Do you remember when I last trained?",
      clientMessages: [],
    });
    assert.equal(noTrain, "I don't have the exact detail in front of me. Remind me.");

    const gpt = readFileSync("server/handlers/gpt-block.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/looksLikeRecallQuestion\(message\)/.test(gpt) && /answerRecall\(user, message\)/.test(gpt),
      "recall must not fall through to GPT");
    const recallAt = gpt.indexOf("looksLikeRecallQuestion(message)");
    const composeAt = gpt.indexOf("if (decision.todo)");
    assert.ok(recallAt > 0 && recallAt < composeAt, "recall must run before the decision-turn mouth");
  });

  check("decision-turn mouth is structural — attacker plates cannot sit above PROTEIN", async () => {
    const { composeDecisionTurn, renderActionLine } = await import("../server/one-action");
    const { frameSituationForClient, extractSalientSituation } = await import("../server/memory");
    const PROTEIN = renderActionLine("Make your next meal a proper protein meal.");
    const REST = renderActionLine("Rest today — your body is doing the work.");
    const plates = [
      "How about grilled chicken and rice?",
      "Eggs tonight.",
      "Maybe have some chicken.",
      "Your next meal could be eggs and toast.",
      "Chicken and rice would work.",
      "Have chicken and rice.",
      "Go with a light gym session.",
    ];
    const frame = frameSituationForClient(extractSalientSituation([
      "That day is today. It's my girlfriend's birthday. We're going to restaurants.",
    ]));
    const out = composeDecisionTurn(frame, PROTEIN);
    for (const p of plates) {
      assert.ok(!out.toLowerCase().includes(p.toLowerCase().replace(/[?.]$/, "")),
        `decision turn shipped a second instruction: ${p}`);
    }
    assert.ok(/birthday outing/i.test(out));
    assert.ok(out.includes(PROTEIN) || /protein meal/i.test(out));
    const restOut = composeDecisionTurn("", REST);
    assert.ok(!/gym session/i.test(restOut) && /Rest today/i.test(restOut));

    const gpt = readFileSync("server/handlers/gpt-block.ts", "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(/if \(decision\.todo\)/.test(gpt) && /composeDecisionTurn\(/.test(gpt),
      "gpt-block must compose on a decision turn instead of asking the model to write the action");
  });

  // ── COACH CONTINUITY SLICE (2026-08-24) ──────────────────────────────────────────────────
  check("continuity: this week is a SAST calendar week, not a rolling 7 days", async () => {
    const { sastWeekStart, sastDayKey } = await import("../server/sast");
    const monday = new Date("2026-08-24T04:00:00Z"); // 06:00 SAST Monday
    assert.equal(sastDayKey(sastWeekStart(monday)), "2026-08-24");
    const friday = new Date("2026-08-21T16:00:00Z");
    assert.equal(sastDayKey(sastWeekStart(friday)), "2026-08-17");
    const live = readFileSync("server/understanding/live.ts", "utf-8");
    assert.ok(/sessionsThisCalendarWeek\(user\.id\)/.test(live),
      "canonicalDecision must count this SAST week, not getProgressTruth({days:7})");
    const cmd = readFileSync("server/handlers/one-action-command.ts", "utf-8");
    assert.ok(/const weekStart = sastWeekStart\(\)/.test(cmd),
      "reactive one-action must count this SAST calendar week");
  });

  check("continuity: a week-count claim never invents dates, and never says Noted", async () => {
    const { attributableWeekSessionDates, weekStartForTrainingClaim } = await import("../server/workout-state");
    const { sessionCountsIn } = await import("../server/utils");
    assert.deepEqual(sessionCountsIn("I did all four workouts this week"), [4]);
    const friday = new Date("2026-08-21T16:00:00Z"); // Friday this week — Fri is not past
    const thisWeek = weekStartForTrainingClaim("I did all four workouts this week", friday)!;
    assert.equal(attributableWeekSessionDates({
      claimed: 4, trainingDaysPerWeek: 4, weekStart: thisWeek, existingDayKeys: [], now: friday,
    }), null, "Friday cannot place all four days — today is still one of them");
    const sunday = new Date("2026-08-23T16:00:00Z");
    const lastWeek = weekStartForTrainingClaim("I did all four last week", sunday)!;
    const placed = attributableWeekSessionDates({
      claimed: 4, trainingDaysPerWeek: 4, weekStart: lastWeek, existingDayKeys: [], now: sunday,
    });
    assert.ok(placed && placed.length === 4, "last week on Sunday is fully past and attributable");
    assert.equal(attributableWeekSessionDates({
      claimed: 4, trainingDaysPerWeek: 4, weekStart: lastWeek, existingDayKeys: ["2026-08-17"], now: sunday,
    }), null, "existing rows → abstain, do not fill gaps");
    assert.equal(attributableWeekSessionDates({
      claimed: 3, trainingDaysPerWeek: 4, weekStart: lastWeek, existingDayKeys: [], now: sunday,
    }), null, "claimed !== schedule → abstain");
    const wk = readFileSync("server/handlers/workout.ts", "utf-8");
    assert.ok(/I won't guess/.test(wk) && /WORKOUT_WEEK_REFUSE/.test(wk),
      "unattributable count must refuse, not fall through to Noted");
  });

  check("continuity: last sentence can change the action; last night frames morning", async () => {
    const { chooseAction, foodDayIsClosed } = await import("../server/one-action");
    const { frameSituationForClient, extractSalientSituation, situationWhen } = await import("../server/memory");
    const { morningClosingLine, composeMorning } = await import("../server/morning-message");
    const closed = "Honestly, I won't be able to eat anymore for the rest of the day. We just going to have alcohol and zero calorie drinks";
    assert.equal(foodDayIsClosed(closed), true);
    const eat = chooseAction({
      goal: "muscle_gain" as any, weeksOnProgramme: 5, daysSinceAnyLog: 0, daysSinceWeighIn: 2,
      loggedToday: true, proteinPct: 0.4, caloriePct: 0.4, sessionsThisWeek: 0, sessionsTarget: 4,
      stepsToday: 5000, stepsTarget: 6000, hour: 19, foodDayClosed: true,
    });
    assert.notEqual(eat.kind, "eat_more", "closed food day must stand eat_more down");
    assert.notEqual(eat.kind, "protein", "closed food day must stand protein down too");
    const still = chooseAction({
      goal: "muscle_gain" as any, weeksOnProgramme: 5, daysSinceAnyLog: 0, daysSinceWeighIn: 2,
      loggedToday: true, proteinPct: 0.4, caloriePct: 0.4, sessionsThisWeek: 0, sessionsTarget: 4,
      stepsToday: 5000, stepsTarget: 6000, hour: 19, foodDayClosed: false,
    });
    assert.equal(still.kind, "eat_more", "negative control: without the constraint, eat_more still fires");

    const line = extractSalientSituation(["This weekend is my girlfriend's birthday. We're going to restaurants."]);
    const lastNight = frameSituationForClient(line, "last_night");
    assert.match(lastNight, /last night/i);
    assert.ok(!/today is the birthday/i.test(lastNight));
    assert.equal(frameSituationForClient(line, "stale"), "");
    const sundayNight = new Date("2026-08-23T18:00:00Z");
    const mondayMorn = new Date("2026-08-24T04:00:00Z");
    assert.equal(situationWhen([{ text: "birthday outing", at: sundayNight }], mondayMorn), "last_night");

    // An engaged client gets no lapse copy AND no second clock. `/4 sessions/` used to be asserted
    // here; that was the 28-day count, and it is gone rather than reworded (2026-08-24).
    const engaged = morningClosingLine("STRUGGLING", { activelyEngaged: true, completedSessions28: 4 });
    assert.ok(!/fresh page/i.test(engaged), "engaged client must not get lapse copy");
    assert.ok(!/\d/.test(engaged), `engaged client was handed a progress score: ${engaged}`);
    // "fresh page" was the STRUGGLING sign-off attached to the 28-day score; both are gone
    // (2026-08-24). STRUGGLING now says nothing rather than scoring the client, and warm
    // re-entry survives for the trajectories that actually mean a lapse.
    const lapsed = morningClosingLine("STRUGGLING", { activelyEngaged: false, completedSessions28: 4 });
    assert.ok(!/fresh page/i.test(lapsed) && !/\d/.test(lapsed),
      `the deleted 28-day sign-off came back: ${lapsed}`);
    for (const t of ["RECOVERING", "DISENGAGED"] as const) {
      assert.match(morningClosingLine(t, { activelyEngaged: false, completedSessions28: 4 }),
        /have you back/i, `${t}: a lapsed client lost their re-entry recognition`);
    }
    const brief = composeMorning({
      firstName: "Kam", targetFixLine: "", identityLine: "", streakLine: "5-day food streak.",
      workoutLine: "", yesterdayLine: "144g protein logged yesterday, against a 186g target.",
      todayLines: ["*Today:*", "👟 6,000 steps", "💪 Training day. Reply *1* for your workout."],
      closingLine: engaged, decisionLine: "*Get today's session done.*", breakfastAsk: "",
      adaptLine: "", situationLine: lastNight, sickYesterday: false,
    });
    assert.match(brief, /last night was the birthday/i);
    assert.ok(!/fresh page/i.test(brief));
  });

  check("continuity: how-far is progress truth; WOW is not a ticket", async () => {
    const misc = readFileSync("server/handlers/misc-commands.ts", "utf-8");
    const distAt = misc.indexOf("how far (?:am i");
    const dirAt = misc.indexOf("looksLikeDirectionRequest(m)");
    assert.ok(distAt > 0 && distAt < dirAt, "distance-to-goal must claim before the plan card");
    const { bareReactionFallback, isDiagnosticQuestion } = await import("../server/reaction-guard");
    const wow = bareReactionFallback("Kam");
    assert.equal(isDiagnosticQuestion(wow), false);
    assert.ok(!/menu/i.test(wow) && !/didn't work/i.test(wow) && !/what happened/i.test(wow));
    const routes = readFileSync("server/routes.ts", "utf-8");
    assert.ok(/bareReactionFallback\(_bfName\)/.test(routes), "OMG must reuse the reaction mouth, not a ticket form");
    assert.ok(/foodDayIsClosed\(message\)/.test(routes), "feeling ack must not swallow a closed food day");
  });


  // ── COACH-LOOP SLICE, PR #50 (2026-08-24) ─────────────────────────────────────────────────
  //
  //   messy input → truthful state → correct window → latest constraint → chooseAction → one Coach
  //
  // Five contracts, each graded on behaviour or state, never on source-string presence.

  check("1 . a factual deficit question is answered, not replaced by an action", async () => {
    const reply = await serialise(() => say("Am I in a deficit? I've only had breakfast"));
    assert.match(reply, /built into your target/i, `the deficit question was not answered: ${reply}`);
    assert.match(reply, /\b2800\b/, "...from the client's own target, via the existing owner");
    assert.ok(!/one thing today|stand on a scale/i.test(reply),
      `the action ladder replaced the question: ${reply}`);
  });

  check("1b . a meal SLOT is not a food, and never writes a phantom meal", async () => {
    // "had breakfast" fuzzy-matched the alias "sa breakfast" and resolved to McDonald's Big
    // Breakfast - a 760 kcal row the client never ate. Both words were already in
    // FUZZY_BLACKLIST; the blacklist was only ever applied to single words, not to the pairs.
    const { scanForSAFoods } = await import("../server/handlers/food-scanner");
    for (const slot of ["I've only had breakfast", "I had breakfast", "what's for lunch"]) {
      assert.deepEqual(scanForSAFoods(slot).map((f: any) => f.name), [],
        `a bare meal slot resolved to a branded food: ${slot}`);
    }
    assert.deepEqual(
      scanForSAFoods("my breakfast was 3 slices of bread, eggs and chicken livers").map((f: any) => f.name),
      ["Bread", "Eggs", "Chicken livers"], "a named meal stopped scanning");
    const r = await writesFor("Am I in a deficit? I've only had breakfast");
    assert.ok(!r.meal, "a question about the deficit wrote a meal");
    // …and the owed-fact gate must not hold the pipeline down for a fact no writer can commit.
    // "had breakfast" names a meal SLOT: there is no row to write, so nothing is owed and the
    // ordinary handlers may answer. Without this the gate stands every handler down forever and
    // the turn survives only because the ledger compose happens to rescue the reply.
    assert.ok(!r.owed, "the gate owed a food write for a message naming no food");
  });

  check("2 . a named missing item amends the meal instead of asking for it again", async () => {
    const { mealLogs } = await import("../shared/schema");
    const g = globalThis as any;
    // SEED INSIDE THE QUEUE. Setting the stub rows outside it lets another check's cleanup run
    // between the assignment and the turn that needs them — the seeded breakfast vanished and
    // this check graded an empty ledger.
    const named = await serialise(async () => {
      g.__KAMLIFE_STUB_ROWS = new Map([[mealLogs, [{
        id: "parity-meal-1", mealLabel: "breakfast", kcalInt: 669, proteinInt: 63,
        carbsInt: 60, fatInt: 25, items: [{ name: "Bread" }, { name: "Eggs" }],
        loggedAt: new Date(NOW - 3600_000),
      }]]]);
      const from = CONSOLE_LINES.length;
      const out = await say("You missed the black coffee");
      const lines = CONSOLE_LINES.slice(from);
      delete g.__KAMLIFE_STUB_ROWS;
      return {
        out,
        meal: lines.some(l => /INSERT meal/i.test(l)),
        amended: lines.some(l => /UPDATE meal/i.test(l)),
      };
    });
    {
      assert.match(named.out, /added Coffee \(black\)/i,
        `a named missing item was not added: ${named.out}`);
      assert.ok(!/which meal did i miss/i.test(named.out),
        "the client was asked to restate a meal they had already described");
      assert.ok(named.amended, "the amendment was not recorded as a durable mutation");
      assert.ok(!named.meal, "the amendment created a SECOND meal row - the meal is double-counted");

      for (const vague of ["you missed a meal", "you forgot my lunch", "you didn't log that"]) {
        const r = await writesFor(vague);
        assert.match(r.out, /which meal did i miss/i, `the clarification fallback was lost: ${vague}`);
      }
    }
  });

  check("2b . a correction lands on the day being corrected, or not at all", async () => {
    // The amend window was "today, no upper bound", so "you missed the black coffee yesterday"
    // silently moved the correction onto TODAY's row — corrupting a day the client can no longer
    // see. The day is resolved by the one temporal owner; an unpinnable day is not written.
    const { statedWhen } = await import("../server/utils");
    const { sastDayKey } = await import("../server/sast");
    const dayOf = (msg: string) => {
      const w = statedWhen(msg);
      return w.when === "ambiguous" ? "ambiguous" : sastDayKey(w.when === "today" ? new Date() : w.date);
    };
    assert.equal(dayOf("You missed the black coffee"), sastDayKey(), "same-day correction left today");
    assert.equal(dayOf("You missed the black coffee yesterday"),
      sastDayKey(new Date(Date.now() - 86_400_000)), "a yesterday correction did not resolve to yesterday");
    assert.equal(dayOf("you missed the black coffee last week"), "ambiguous",
      "a span was pinned to a day it does not name");

    // THE WINDOW ITSELF. dayKey is derived from the same `dayStart` that builds the gte/lt bounds,
    // so it reports the day the query was actually scoped to — not a restatement of the input.
    const { appendItemsToRecentMeal } = await import("../server/day-ledger");
    const { mealLogs } = await import("../shared/schema");
    const coffee = [{ name: "Coffee (black)", category: "drink", typicalPortionGrams: 250,
      typicalPortionCalories: 5, typicalPortionProtein: 0, carbsPer100g: 0, fatPer100g: 0 }];
    const g = globalThis as any;
    const scoped = await serialise(async () => {
      // BOTH DAYS ARE SEEDED, and they have to be (2026-08-25, issue #63). This seeded only a
      // YESTERDAY row and then asserted that a TODAY-scoped amend succeeded. It passed because the
      // stub ignored `where`, so a today-scoped query was handed yesterday's row. Against a stub
      // that honours the window, a correct implementation finds nothing — so the assertion below
      // could never have failed for the right reason. One row per day is what the check meant.
      g.__KAMLIFE_STUB_ROWS = new Map([[mealLogs, [{
        id: "parity-day-row", mealLabel: "breakfast", kcalInt: 500, proteinInt: 40,
        carbsInt: 50, fatInt: 20, items: [{ name: "Oats" }], loggedAt: new Date(NOW - 86_400_000),
      }, {
        id: "parity-day-row-today", mealLabel: "breakfast", kcalInt: 500, proteinInt: 40,
        carbsInt: 50, fatInt: 20, items: [{ name: "Oats" }], loggedAt: new Date(NOW - 3600_000),
      }]]]);
      const yesterday = new Date(Date.now() - 86_400_000);
      const out = {
        today: await appendItemsToRecentMeal(USER.id, coffee as any),
        yesterday: await appendItemsToRecentMeal(USER.id, coffee as any, yesterday),
      };
      delete g.__KAMLIFE_STUB_ROWS;
      return out;
    });
    assert.equal(scoped.today?.dayKey, sastDayKey(), "the same-day amend was scoped to another day");
    assert.equal(scoped.yesterday?.dayKey, sastDayKey(new Date(Date.now() - 86_400_000)),
      "a yesterday correction was written into a different day's window");
    // NOTE, stated rather than implied: under the offline stub recomputeTodayFoodTotals returns
    // zero either way, so a `calories` assertion here could not fail and is not made. What is
    // graded instead is the sentence the client reads, in 2c — which is now rendered from
    // `dayKey`, so the reply cannot disagree with the row that was written.
  });

  check("2c . the client is told which day was changed", async () => {
    const { mealLogs } = await import("../shared/schema");
    const g = globalThis as any;
    const replies = await serialise(async () => {
      // One row per day the check corrects — see 2b. A single yesterday row made the today case
      // vacuous under a stub that could not filter.
      g.__KAMLIFE_STUB_ROWS = new Map([[mealLogs, [{
        id: "parity-day-row-2", mealLabel: "breakfast", kcalInt: 500, proteinInt: 40,
        carbsInt: 50, fatInt: 20, items: [{ name: "Oats" }], loggedAt: new Date(NOW - 86_400_000),
      }, {
        id: "parity-day-row-2-today", mealLabel: "breakfast", kcalInt: 500, proteinInt: 40,
        carbsInt: 50, fatInt: 20, items: [{ name: "Oats" }], loggedAt: new Date(NOW - 3600_000),
      }, {
        // …and the named day the check corrects. Computed, not hard-coded, so the fixture does not
        // depend on which weekday the suite happens to run.
        id: "parity-day-row-2-sat", mealLabel: "breakfast", kcalInt: 500, proteinInt: 40,
        carbsInt: 50, fatInt: 20, items: [{ name: "Oats" }], loggedAt: lastSaturday(),
      }]]]);
      const out = {
        today: await say("You missed the black coffee"),
        yesterday: await say("You missed the black coffee yesterday"),
        saturday: await say("You missed the black coffee from Saturday"),
        span: await say("you missed the black coffee last week"),
      };
      delete g.__KAMLIFE_STUB_ROWS;
      return out;
    });
    assert.match(replies.today, /to your breakfast/i, `same-day wording changed: ${replies.today}`);
    assert.match(replies.yesterday, /yesterday'?s breakfast/i,
      `a past-day correction did not name the day: ${replies.yesterday}`);
    assert.ok(!/_Today:/.test(replies.yesterday), "a past-day correction quoted today's total");
    assert.match(replies.saturday, /saturday'?s breakfast/i,
      `a named-day correction did not name the day: ${replies.saturday}`);
    // …AND THE MEAL THEY NAMED. With dinner logged after breakfast, "at breakfast" must not
    // attach to dinner — the date defect one axis over, found reviewing this cut.
    const slotted = await serialise(async () => {
      g.__KAMLIFE_STUB_ROWS = new Map([[mealLogs, [
        { id: "p-dinner", mealLabel: "dinner", kcalInt: 800, proteinInt: 50, carbsInt: 70,
          fatInt: 30, items: [{ name: "Steak" }], loggedAt: new Date(NOW - 3600_000) },
        { id: "p-bfast", mealLabel: "breakfast", kcalInt: 669, proteinInt: 63, carbsInt: 60,
          fatInt: 25, items: [{ name: "Bread" }], loggedAt: new Date(NOW - 7 * 3600_000) },
      ]]]);
      const out = {
        named: await say("You missed the black coffee at breakfast"),
        unnamed: await say("You missed the black coffee"),
      };
      delete g.__KAMLIFE_STUB_ROWS;
      return out;
    });
    assert.match(slotted.named, /to your breakfast/i,
      `the client named the meal and it went elsewhere: ${slotted.named}`);
    assert.match(slotted.unnamed, /to your dinner/i,
      `with no meal named, the most recent must stand: ${slotted.unnamed}`);
    assert.match(replies.span, /which meal did i miss/i,
      `an unpinnable day was written instead of clarified: ${replies.span}`);
  });

  check("3 . feedback about the coach is recognised, and never answered with an action", async () => {
    const { isCoachCriticism } = await import("../server/reaction-guard");
    for (const criticism of ["Wow that's vague and robotic", "No this is a disaster",
                             "You are not a coach", "you're not a real coach", "You're not listening",
                             "You didn't read what I said"]) {
      assert.ok(isCoachCriticism(criticism), `not recognised as feedback about us: ${criticism}`);
    }
    for (const ours of ["You didn't answer my question", "you never answered my question",
                        "That's not what I asked"]) {
      assert.ok(isCoachCriticism(ours), `a complaint about us was missed: ${ours}`);
    }
    for (const notCriticism of ["I feel like a disaster today", "You are not a doctor, I know",
                                "I had eggs and pap", "I'm struggling with all of this",
                                // SUBJECT MATTERS: the client's own admission is not a complaint.
                                "I didn't answer your question"]) {
      assert.ok(!isCoachCriticism(notCriticism), `a client's own life read as criticism: ${notCriticism}`);
    }
    const reply = await serialise(() => say("You are not a coach"));
    assert.ok(!/one thing today|stand on a scale/i.test(reply),
      `an unrelated instruction answered a criticism: ${reply}`);
  });

  check("4 . the latest explicit constraint reaches the decision, not FEELING_ACK", async () => {
    const { foodDayIsClosed, chooseAction } = await import("../server/one-action");
    for (const closed of ["I think I'm going to stop eating today", "I'm not eating anymore today",
                          "I'm done eating for today", "No more food today"]) {
      assert.ok(foodDayIsClosed(closed), `a stated cessation was not read as one: ${closed}`);
    }
    // THE CESSATION MUST APPLY TO EATING ITSELF. "done eating badly" / "done eating junk" describe
    // the MANNER and the OBJECT — the client is still eating.
    for (const open of ["I can't stop eating", "I cannot stop eating today",
                        "I'm not eating junk today", "I'm eating out tonight",
                        "I'm done eating badly", "I'm done eating junk",
                        "I stopped eating gluten today", "I'm done eating out for today"]) {
      assert.ok(!foodDayIsClosed(open), `the food day was closed by mistake: ${open}`);
    }
    for (const closed2 of ["I'm done eating", "I'm done eating for the night"]) {
      assert.ok(foodDayIsClosed(closed2), `a real closure was lost to the manner guard: ${closed2}`);
    }
    const base = {
      goal: "fat_loss", weeksOnProgramme: 4, daysSinceAnyLog: 0, daysSinceWeighIn: 1,
      loggedToday: true, proteinPct: 0.3, caloriePct: 0.4, sessionsThisWeek: 2,
      sessionsTarget: 4, stepsToday: 7000, stepsTarget: 8000, hour: 19,
    } as any;
    assert.match(chooseAction({ ...base, foodDayClosed: false }).todo, /protein|eat/i,
      "the open-day control no longer produces a food action, so the closed-day assertion proves nothing");
    assert.ok(!/\beat\b|protein/i.test(chooseAction({ ...base, foodDayClosed: true }).todo),
      "a client who said they are done eating was told to eat");
    const reply = await serialise(() => say("I think I'm going to stop eating today"));
    assert.ok(!/showing up still counts|heard you on how you'?re feeling/i.test(reply),
      `a stated constraint was answered as a feeling: ${reply}`);
  });

  // ── AN EXPLICIT REFUSAL DOMINATES TODAY'S WORKOUT (2026-08-24 live) ───────────────────────
  //
  //   "I am NOT training today. I will train tomorrow."
  //   → a full session, post-workout nutrition and "Send DONE"
  //
  // routes.ts had a DEFERRAL matcher ("I'll do it later") requiring a first-person future verb
  // and a later-time word; a plain negation of today matched none of it, and nothing else owned
  // a refusal. trainingDayIsDeclined is the twin of foodDayIsClosed — a DayState input, not a
  // routing predicate — and it reaches both the renderer and chooseAction.
  check("5 . a refusal to train today dominates the workout, and a report still logs", async () => {
    const { trainingDayIsDeclined, chooseAction } = await import("../server/one-action");
    for (const refusal of ["I am not training today. I will train tomorrow",
                           "no I'm not training today", "I'm training tomorrow not today",
                           "I'm not doing the workout today", "Skipping the gym today",
                           "I'll train tomorrow instead"]) {
      assert.ok(trainingDayIsDeclined(refusal), `an explicit refusal was not read as one: ${refusal}`);
    }
    // THE INVERSE. A report of training is not a refusal of it, and a question is a request.
    for (const notRefusal of ["I trained today", "I did my workout today", "I'm training today",
                              "Can I do my workout tomorrow instead?", "What is tomorrow's session?",
                              "workout", "I'm not eating anymore today",
                              // A NEGATED CESSATION IS AN AFFIRMATION. These say they DID train,
                              // and marking a completed session as declined is the worse error.
                              "I didn't skip the gym today", "I never skip the gym today",
                              "no way I'm skipping the gym today", "I did not skip my session today"]) {
      assert.ok(!trainingDayIsDeclined(notRefusal), `wrongly read as a refusal: ${notRefusal}`);
    }
    // ADVERSARIAL REVIEW OF THIS CUT (2026-08-24). A tag question is still a statement — the
    // blanket "?" exclusion put the live failure two characters away from returning.
    assert.ok(trainingDayIsDeclined("I'm not training today, ok?"),
      "a refusal with a tag question was read as a request");
    for (const request of ["Can I do my workout tomorrow instead?", "Should I train today?",
                           "Do I train today?", "What is tomorrow's session?"]) {
      assert.ok(!trainingDayIsDeclined(request), `an interrogative was recorded as a constraint: ${request}`);
    }
    // …while a genuine refusal that uses the same verb must survive the guard.
    for (const stillRefusal of ["Skipping the gym today", "I want to skip the gym today",
                                "I'm skipping training today"]) {
      assert.ok(trainingDayIsDeclined(stillRefusal), `the negation guard swallowed a refusal: ${stillRefusal}`);
    }

    // The decision owner's own contract, as a unit: sessionsTarget 0 means no session today.
    // NOTE: the router returns the deferral reply before chooseAction runs on a refusal turn, so
    // this asserts the contract, not a wiring path — and no wiring was added that nothing reaches.
    const base = {
      goal: "fat_loss", weeksOnProgramme: 4, daysSinceAnyLog: 0, daysSinceWeighIn: 2,
      loggedToday: true, proteinPct: 0.9, caloriePct: 0.8, sessionsThisWeek: 0,
      stepsToday: 3000, stepsTarget: 6000, hour: 9,
    } as any;
    assert.match(chooseAction({ ...base, sessionsTarget: 4 }).todo, /session|train/i,
      "the training-day control no longer prescribes a session, so the refusal case proves nothing");
    assert.ok(!/session|train|gym/i.test(chooseAction({ ...base, sessionsTarget: 0 }).todo),
      "a client who said they are not training today was told to train");

    // …and the renderer stands down rather than printing the session over the refusal.
    for (const refusal of ["no I'm not training today", "I'm training tomorrow not today",
                           "I am not training today. I will train tomorrow"]) {
      const reply = await serialise(() => say(refusal));
      assert.ok(!/Week \d|Next Session|Foundation Phase|Send \*?DONE/i.test(reply),
        `today's session was printed over an explicit refusal: ${reply.slice(0, 90)}`);
      assert.match(reply, /rest today|when you'?re ready/i,
        `the refusal was not acknowledged: ${reply.slice(0, 90)}`);
    }
    // A REQUEST TO MOVE A WORKOUT IS A SCHEDULE DECISION, NOT A REQUEST TO RENDER IT.
    // "Can I do my workout tomorrow instead?" answered with the session was the client asking
    // permission and being handed the object. The renderer stays one message away, on their terms.
    for (const ask of ["Can I do my workout tomorrow instead?", "Can I train tomorrow instead?"]) {
      const reply = await serialise(() => say(ask));
      assert.ok(!/Week \d|Next Session|Foundation Phase|Send \*?DONE/i.test(reply),
        `a schedule question was answered with the workout: ${ask} → ${reply.slice(0, 80)}`);
      assert.match(reply, /rest day|do this session tomorrow|do it later today/i,
        `the schedule question got no schedule answer: ${ask} → ${reply.slice(0, 80)}`);
    }
    // …and asking to SEE it still renders it — including when the ASK is phrased as permission.
    // "Can I get tomorrow's session?" is a possessive naming the object; "Can I do my workout
    // tomorrow?" proposes a time. Grammar decides, not a verb list.
    // THE RENDERER ANSWERED — a session, or its own rest-day answer for a day that has none.
    //
    // This asserted `Week \d` alone, which encodes an assumption the fixture cannot keep: with
    // trainingDaysPerWeek 3 the schedule is Mon/Wed/Fri, so "tomorrow" is a rest day on four days
    // out of seven and the renderer correctly returns "*Tuesday — Rest Day.*". It failed on
    // main@266a8c2b for that reason and passed the day before. The property under test is the
    // GRAMMAR — a possessive naming the object reaches the workout owner, rather than being
    // answered as a schedule question — and the rest-day render is that owner answering.
    const RENDERED = /Week \d|\*\s*\w+day\s+—\s+Rest Day/i;
    for (const view of ["Show me tomorrow's workout.", "Tomorrow's workout?",
                        "Can I see tomorrow's workout?", "Can I get tomorrow's session?"]) {
      const reply = await serialise(() => say(view));
      assert.match(reply, RENDERED, `a view request stopped rendering: ${view} → ${reply.slice(0, 70)}`);
      // …and it is NOT the schedule answer, which is the failure this whole block exists to catch.
      assert.ok(!/do this session tomorrow|do it later today/i.test(reply),
        `a view request was answered as a schedule question: ${view} → ${reply.slice(0, 70)}`);
    }

    // The opposite still holds end to end: a reported session is still written to today.
    const trained = await writesFor("I trained chest today. What should I eat now?");
    assert.ok(trained.workout, "a reported session stopped being recorded");
    // And the ordinary workout doors are untouched.
    for (const view of ["workout", "What is tomorrow's session?"]) {
      const reply = await serialise(() => say(view));
      assert.match(reply, RENDERED, `a legitimate workout view was broken: ${view} → ${reply.slice(0, 70)}`);
    }
  });

  // ── P0-2 / P0-3 · THE BATCH LOGGER (2026-08-25) ───────────────────────────────────────────
  //
  // attributeMultiDayReport shipped in PR #52 with EIGHT test references and ZERO production
  // callers. These grade the wiring, not the library.
  check("P0-2 . a multi-day report writes each day, in one reply", async () => {
    // THE FIXTURE IS DATED RELATIVE TO TODAY (determinism fix, 2026-08-25). It named Monday,
    // Tuesday and Wednesday literally, so on a Tuesday one of the three resolved to TODAY and the
    // three-day report collapsed into two — the suite graded a different scenario depending on the
    // weekday CI happened to run. It failed on main@266a8c2b for exactly that reason, and passed
    // in the same repo the day before. A guard whose verdict is a function of the calendar cannot
    // hold a ratchet. These are the three days ending yesterday, so they are always distinct and
    // always in the past, which is what this test was always about. Days 4-2 back, not 3-1:
    // the reply renders the most recent day as "yesterday" rather than by name, which is correct
    // and friendly — and would make a name assertion fail for the wrong reason.
    const [d1, d2, d3] = [4, 3, 2].map(n =>
      new Date(NOW - n * 86_400_000).toLocaleDateString("en-ZA", { weekday: "long", timeZone: "Africa/Johannesburg" }));
    const r = await writesFor(`${d1} pap and chicken. ${d2} eggs and toast. ${d3} I trained and walked 8000 steps`);
    assert.ok(r.mealDays.length >= 2, `expected meals on two named days, got ${JSON.stringify(r.mealDays)}`);
    // ONE reply, covering every domain — food from its own owner, training and steps from the
    // backfill that dated them. An unacknowledged write is how "did you even log it?" happens.
    assert.match(r.out, new RegExp(d1, "i"), `the reply lost a day: ${r.out.slice(0, 120)}`);
    assert.match(r.out, new RegExp(d3, "i"), `the backfilled day was written but never acknowledged: ${r.out.slice(0, 120)}`);
    assert.match(r.out, /session/i, "the reply does not mention the session it wrote");
    assert.match(r.out, /8,000 steps/i, "the reply does not mention the steps it wrote");
    assert.match(r.out, /kcal/i, "food lost its quantity-aware owner");
    assert.ok(r.backfillWorkoutDays.length === 1, `expected one backfilled session, got ${JSON.stringify(r.backfillWorkoutDays)}`);
    assert.ok(r.backfillStepDays.length === 1, `expected one backfilled step row, got ${JSON.stringify(r.backfillStepDays)}`);
    // ONE row per event. Without the guard the single-day doors write the session again on the
    // first day the bubble mentions, and the steps to today — two rows for one event, both wrong.
    assert.equal(r.allWorkoutWrites, 1, `${r.allWorkoutWrites} workout rows written for one session`);
    assert.equal(r.allStepWrites, 1, `${r.allStepWrites} step rows written for one report`);
    // Distinct days, and none of them today — the whole point is that they land where named.
    const days = new Set([...r.backfillWorkoutDays, ...r.backfillStepDays]);
    assert.equal(days.size, 1, `the ${d3} session and steps landed on different days`);
    assert.ok(!days.has(sastDayKeyOf(new Date())), "a named past day was written as today");
    // ONE reply, and it says what was written.

  });

  check("P0-2b . a single-day message is untouched by the batch path", async () => {
    // The gate is hasMultipleDays. Every existing single-day route must behave exactly as before.
    for (const single of ["I had pap and eggs", "I trained chest today. What should I eat now?",
                          "You missed the black coffee"]) {
      const r = await writesFor(single);
      assert.ok(!/logged across \d+ day/i.test(r.out),
        `the batch path claimed a single-day turn: ${single} → ${r.out.slice(0, 70)}`);
    }
  });

  check("P0-3 . a historical write does not move today's programme", async () => {
    // The retro path advanced programmeDayInWeek and programmeWeek, so "I trained on Monday"
    // silently consumed TODAY's session slot. A backfill is a statement about that day only.
    const g = globalThis as any;
    const before = { ...USER, programmeDayInWeek: 2, programmeWeek: 5, totalWorkoutsCompleted: 7 };
    const after = await serialise(async () => {
      g.__KAMLIFE_STUB_USER = { ...before };
      await say("I trained on Monday");
      const u = { ...g.__KAMLIFE_STUB_USER };
      g.__KAMLIFE_STUB_USER = { ...USER };
      return u;
    });
    assert.equal(after.programmeDayInWeek, 2, "a backfill advanced today's programme slot");
    assert.equal(after.programmeWeek, 5, "a backfill advanced the programme week");
    // …while the facts about the past may still move.
    assert.equal(after.totalWorkoutsCompleted, 8, "the lifetime session count was not updated");
  });

  // ── P0-4 · ONE COACH AT BOTH DOORS (2026-08-25) ───────────────────────────────────────────
  //
  // The behavioural-authority work lives in reconcileTurnReply, inside `inTurn` — so it governed
  // REACTIVE replies only. 69 proactive sends across 14 files, 3 of which consult the decision
  // owner. This grades the shared floor: a claim about durable state, checked against durable
  // state, on the proactive path too.
  check("P0-4 . a proactive send may not assert a training count the record denies", async () => {
    const { enforceOutboundTruth } = await import("../server/outbound-authority");
    const { mealLogs, workoutLogs } = await import("../shared/schema");
    const g = globalThis as any;

    const verdicts = await serialise(async () => {
      // The record holds ONE session in the window.
      g.__KAMLIFE_STUB_ROWS = new Map([[workoutLogs, [{ n: 1 }]]]);
      const out = {
        contradicts: await enforceOutboundTruth(USER.id, "whatsapp:+27000000101", "Strong week — that's 4 sessions in the bag."),
        matches: await enforceOutboundTruth(USER.id, "whatsapp:+27000000102", "That's 1 session this week — let's build on it."),
        noClaim: await enforceOutboundTruth(USER.id, "whatsapp:+27000000103", "Morning Kam. 8,500 steps today and protein first."),
        firstSend: await enforceOutboundTruth(USER.id, "whatsapp:+27000000104", "Same message body for the duplicate check."),
        repeat: await enforceOutboundTruth(USER.id, "whatsapp:+27000000104", "Same message body for the duplicate check."),
      };
      delete g.__KAMLIFE_STUB_ROWS;
      return out;
    });

    assert.ok(!verdicts.contradicts.ok, "a proactive message claimed 4 sessions against a record of 1");
    assert.equal(verdicts.contradicts.reason, "session_count_contradicts_record");
    assert.ok(verdicts.matches.ok, `a truthful count was blocked: ${verdicts.matches.detail}`);
    // THE CONTROL THAT KEEPS THIS HONEST: the morning brief's step TARGET carries no evidence and
    // must still go out. Porting verifyBrainReply wholesale would have silenced it.
    assert.ok(verdicts.noClaim.ok, `an ordinary proactive message was blocked: ${verdicts.noClaim.detail}`);
    assert.ok(verdicts.firstSend.ok, "the first send of a message was blocked");
    assert.ok(!verdicts.repeat.ok && verdicts.repeat.reason === "duplicate",
      "the same proactive message went out twice");
  });

  check("P0-4b . the proactive DOOR consults the floor, not just the floor existing", async () => {
    // The first version of this asserted the source contained the call — and stayed green when
    // the door was changed to ignore the verdict. This drives sendWhatsApp itself.
    const { sendWhatsApp } = await import("../server/scheduler/shared");
    const { workoutLogs } = await import("../shared/schema");
    const g = globalThis as any;
    const seen = await serialise(async () => {
      g.__KAMLIFE_STUB_ROWS = new Map([[workoutLogs, [{ n: 1 }]]]);
      const from = CONSOLE_LINES.length;
      const realErr = console.error;
      const errs: string[] = [];
      console.error = (...a: any[]) => { errs.push(a.map(String).join(" ")); };
      try {
        await sendWhatsApp("whatsapp:+27000000201", "Strong week — that's 4 sessions in the bag.").catch(() => undefined);
      } finally { console.error = realErr; }
      delete g.__KAMLIFE_STUB_ROWS;
      return { errs, after: CONSOLE_LINES.slice(from) };
    });
    assert.ok(seen.errs.some(l => /OUTBOUND_AUTHORITY\] BLOCKED/.test(l)),
      `the door sent a message the floor rejected: ${JSON.stringify(seen.errs).slice(0, 160)}`);
    assert.ok(!seen.after.some(l => /SCHEDULER\] Sent|delivery/i.test(l)),
      "a rejected proactive message still reached the send path");
  });

  /**
   * FIRE A REAL SCHEDULER JOB AND READ WHAT THE CLIENT WOULD HAVE READ.
   *
   * Not a call to the composer, and not a call to the decision — the exported cron entry point,
   * through server/scheduler/shared.sendWhatsApp: the outbound floor, the provenance gate,
   * humanizeReply, and the bubble split. Capture is via SHADOW mode, which is the product's own
   * "record instead of send" door, so nothing here is a seam that exists only for the test.
   *
   * `saidToday` is chat_history as the held-constraint reader sees it — the client's own words.
   */
  async function runEveningThroughTheDoor(
    saidToday: Array<{ message_in: string; created_at: Date }>,
    ledger: { proteinTarget?: number; who: string },
  ): Promise<string[]> {
    const { runEveningAccountability } = await import("../server/scheduler/jobs/evening");
    const { shadowReplies, sentProactive, mealLogs, workoutLogs, weightLogs, stepLogs, chatHistory } =
      await import("../shared/schema");
    const g = globalThis as any;
    const today = new Date();

    return serialise(async () => {
      const priorShadow = process.env.SHADOW;
      const priorPause = process.env.PROACTIVE_PAUSED;
      process.env.SHADOW = "on";
      // The harness pins PROACTIVE_PAUSED=true so no cron fires while the reactive cases run. This
      // case IS the cron, so the killswitch is lifted for its duration and restored after. Inside
      // serialise(), so nothing else is running while it is off.
      process.env.PROACTIVE_PAUSED = "false";
      g.__KAMLIFE_STUB_PGROWS = (sql: string) => (/chat_history/i.test(String(sql)) ? saidToday : []);
      g.__KAMLIFE_STUB_USER = {
        ...USER,
        // A DISTINCT CLIENT PER CASE. The proactive budget is per user and in memory, so two cases
        // sharing an id means the second one is silenced by the first — and "it said nothing"
        // would read as "it obeyed the constraint".
        id: `parity-${ledger.who}`,
        phoneNumber: `whatsapp:+2782000${ledger.who.length}${ledger.who.charCodeAt(0)}`,
        trainingDaysPerWeek: 4,      // this week = 0/4 — by the ledger they are behind
        totalWorkoutsCompleted: 0,
        proteinTarget: ledger.proteinTarget ?? 140,
        calorieTarget: 2000,
        stepsTarget: 8500,
        lastActiveAt: today,
        profileNotes: "",
      };
      // A LEDGER THAT SUPPORTS A PRESCRIPTION. Without evidence, decideProactive downgrades every
      // prescription to a question — which would make "it did not say train" true for the wrong
      // reason. Two weigh-ins twenty days apart make the weight trend usable, which is the
      // evidence gate's own sufficiency condition.
      //
      // Rows carry BOTH the column name and the alias each query selects it under, because the
      // stub returns seeded rows verbatim rather than applying drizzle's projection.
      const meal = { id: 1, at: today, loggedAt: today, kcalInt: 900, proteinInt: 0,
                     todayCal: 900, todayProt: 0 };
      g.__KAMLIFE_STUB_ROWS = new Map<any, any[]>([
        [sentProactive, [{ id: 1 }]],                       // claimDailySlot must be winnable
        [chatHistory, [{ id: 1, createdAt: today, intent: "FOOD_LOG", messageIn: "chicken and rice" }]],
        [mealLogs, [meal]],
        [workoutLogs, []],                                  // zero sessions this week
        [weightLogs, [
          { id: 2, weight: "82.0", w: "82.0", at: new Date(NOW - 86_400_000), loggedAt: new Date(NOW - 86_400_000) },
          { id: 1, weight: "83.4", w: "83.4", at: new Date(NOW - 20 * 86_400_000), loggedAt: new Date(NOW - 20 * 86_400_000) },
        ]],
        [stepLogs, [{ avg: 9000, steps: 9000, at: today, loggedAt: today }]],
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
    const g = globalThis as any;
    const out = await serialise(async () => {
      g.__KAMLIFE_STUB_PGROWS = (sql: string) => (/chat_history/i.test(String(sql))
        ? [{ message_in: "I'm not training today", created_at: new Date() },
           { message_in: "I'm done eating for today", created_at: new Date() }]
        : []);
      const r = {
        train: await enforceOutboundTruth(USER.id, "whatsapp:+27000000301", "Kam, get today's session done before bed."),
        eat: await enforceOutboundTruth(USER.id, "whatsapp:+27000000302", "Kam, get to 140g protein tonight."),
        recognition: await enforceOutboundTruth(USER.id, "whatsapp:+27000000303", "Kam, 9,000 steps today. Strong."),
      };
      delete g.__KAMLIFE_STUB_PGROWS;
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
  check("training day . a session moved into today is not answered with 'rest today'", async () => {
    const reply = await serialise(() => say("No I moved yesterdays workout to today"));
    assert.ok(!/rest today|hit it fresh tomorrow|rest day is part of the programme/i.test(reply),
      `the client said they are training today and was told to rest: ${reply.slice(0, 160)}`);
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
    // The parity user trains 3x/week, so "today" is a rest day on most calendar days and the
    // session is never composed. Six days puts today inside the programme whenever this runs.
    const reply = await serialise(async () => {
      g.__KAMLIFE_STUB_USER = { ...USER, trainingDaysPerWeek: 6 };
      try { return String(await handleMessage(USER.phoneNumber, "workout") ?? ""); }
      catch (e: any) { return `__THREW__ ${e?.message || e}`; }
      finally { g.__KAMLIFE_STUB_USER = { ...USER }; }
    });
    const header = reply.split("\n").find(l => /\*Week \d/.test(l)) || "";
    assert.ok(header, `no week header in the workout reply: ${reply.slice(0, 200)}`);
    assert.ok(!/— Session \d+\*\s*$/.test(header.trim()),
      `Week and Session are still printed as one clock: ${header}`);
    if (/Session/.test(header)) {
      assert.match(header, /Session \d+ overall/,
        `a session number without its clock named: ${header}`);
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

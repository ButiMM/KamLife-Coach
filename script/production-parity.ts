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
    assert.ok(/scope\.evidence\.canonicalTodo/.test(log) && /draft = draft \? `\$\{draft\}/.test(log),
      "…and render the canonical instruction in place of what it removed");
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

    // Empathy and context survive — that is what the model is for.
    assert.ok(/hard few days/.test(render("I hear you. That sounds like a hard few days.", "")));

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
    const { stripModelDirectives } = await import("../server/brain/reply-verifier");
    const ev = (canonicalTodo: string) => ({ modelAuthored: true, canonicalTodo }) as any;
    const render = (reply: string, todo: string) => {
      const { kept } = stripModelDirectives(reply, ev(todo));
      return todo && !kept.toLowerCase().includes(todo.toLowerCase().replace(/[.!]$/, ""))
        ? (kept ? `${kept}\n\n${todo}` : todo) : kept;
    };
    const PROTEIN = "Make your next meal a proper protein meal.";

    // 3. the directive in the final reply comes from the canonical renderer, not the model
    const a = render("That's a tough week. Train chest today.", PROTEIN);
    assert.ok(!/train chest/i.test(a), "the model's instruction must not reach the client");
    assert.ok(a.includes(PROTEIN), "the canonical instruction must");
    assert.ok(/tough week/i.test(a), "…and the model's empathy must survive");

    // 4. canonicalTodo = null produces no behavioural directive
    const b = render("I hear you — that sounds heavy. Go for a 20-minute walk.", "");
    assert.ok(!/20-minute walk/i.test(b), "no decision means no instruction reaches the client");
    assert.ok(/hear you/i.test(b), "…and the conversation survives");

    // 5. rewording cannot create a different directive
    for (const r of ["You should hit legs today.", "I'd get a push session in this afternoon.",
                     "Today is a good day for an upper body workout."]) {
      assert.ok(!/legs|push session|upper body/i.test(render(r, PROTEIN)),
        `a reworded directive still reached the client: ${r}`);
    }

    // 6. deterministic responses are untouched
    const det = stripModelDirectives("Drop your calories to 1,800.", { modelAuthored: false } as any);
    assert.equal(det.kept, "Drop your calories to 1,800.");
    assert.equal(det.removed.length, 0);

    // 1+2. an exit that never saw the brief still carries the canonical instruction
    const e = render("Ja, that's normal when you're coming back from being ill.", "Log one meal today. Any meal.");
    assert.ok(e.includes("Log one meal today"), "a short exit must still carry the canonical instruction");
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

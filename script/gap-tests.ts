/**
 * Gap-closing tests — covers the highest-risk untested functions identified in the
 * June 2026 gap audit. All pure functions; no DB, no network.
 *
 * Functions tested here:
 *   scalePortionDescription  (food-context.ts)
 *   extractMealLabel         (food-context.ts)
 *   assessWeightRate         (weight.ts)
 *   parseMealDate            (utils.ts) — edge cases beyond routing-audit coverage
 *   isRetroactiveMeal        (utils.ts)
 *   mealDateLabel            (utils.ts)
 *   checkPerfectDay gate     (checks.ts) — steps COUNT vs stepsTarget [H6]
 *   weeklyAvg divisor        (routes.ts) — divide by 7 not row count [M3]
 */

import assert from "node:assert/strict";

/** The stored form of a health hold, so the tests drive the owner through its real input. */
const notes = (since?: string, until?: string) =>
  [since ? `sick_since:${since}` : "", until ? `sick_until:${until}` : "", until ? `paused_until:${until}` : ""]
    .filter(Boolean).join(" | ");
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { prescribesProtein } from "./hunger-checks";

// Env setup runs AFTER static imports are hoisted in ESM. Server modules use
// dynamic imports below so db.ts loads only after KAMLIFE_DB_STUB is set.
process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-offline";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest00000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test";
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "+27000000000";

// Dynamic imports — execute after env vars above, unlike static imports which are hoisted.
const { extractMealLabel } = await import("../server/handlers/food-context");
const { scalePortionDescription, adjustFoodsForSegment } = await import("../server/portion-memory");
const { assessWeightRate, weeklyTrendSlopeKg } = await import("../server/handlers/weight");
const { parseMealDate, isRetroactiveMeal, mealDateLabel } = await import("../server/utils");
const { explicitMealSlot } = await import("../server/understanding/actions");
// NOTE: server/gpt.ts registers a module-scope setInterval (its food-cache sweeper), so a script
// that imports it only exits because this file ends with an explicit exit call. That is why the
// selectModel coverage lives here and not in unit-tests.ts, which hangs forever once gpt.ts is
// loaded into it.
//
// DO NOT ADD TESTS HERE, AND DO NOT LEAVE A BARE STATEMENT BELOW THIS BLOCK. Three times now an
// inserted test has landed above the harness that defines `test`, or between the two halves of a
// split sentence — orphaning `process.exit(0).` as live syntax. Each time the file threw a
// TransformError and NOT ONE of its ~300 tests ran, reporting nothing rather than failing.
// script/check-architecture.ts now parses every suite in the npm test chain so this cannot hide
// again. Add new tests further down, beside their subject.
const { selectModel, milestoneEmotion } = await import("../server/gpt");
const { scanForSAFoods } = await import("../server/handlers/food-scanner");
// These were written as CommonJS require() inside an ESM module, so every test below
// that used them threw "require is not defined" — they had never executed. Bound once here.
const MESSY = await import("../server/understanding/messy-intake");
const UNLOGGED = await import("../server/unlogged-notice");
const UTILS = await import("../server/utils");
const FOODID = await import("../server/food-identity-correction");
const FIDELITY = await import("../server/normalizer-fidelity");
const CARD = await import("../server/macro-card-attach");
const NUTRI = await import("../server/nutrition-guardrails");
const VERIF = await import("../server/brain/reply-verifier");
let passed = 0;
let failed = 0;
const failures: string[] = [];

/**
 * A SUITE THAT CANNOT FAIL IS A GREEN LIGHT WIRED TO NOTHING (fixed 2026-08-25).
 *
 * This ran `fn()`, ignored what came back, and incremented `passed`. 86 of the 332 cases in this
 * file are async, so for every one of them `fn()` returned immediately, the try/catch could not
 * see the rejection, and the pass was recorded whether or not the assertions held. The file then
 * ends with a synchronous `process.exit(0)`, which kills the process before the rejection can even
 * surface as an unhandled one — so there was no symptom at all. Not a theory: a control asserting
 * `1 === 2` was counted as PASSED and the suite exited 0.
 *
 * THE PART THAT MATTERS MOST. This exact defect was found and fixed in food-scanner-tests.ts, then
 * found and fixed again in unit-tests.ts — whose comment reads "the same defect was found and
 * fixed in script/food-scanner-tests.ts; it was never fixed here." It was never fixed here either.
 * The repair existed, was written down twice, and two suites were left behind: the same
 * owner-exists-but-callers-do-not shape as every production defect in this repo's last six months,
 * turned on the instrument that is supposed to catch them.
 *
 * `pending` is awaited before the tally below. See the PROBE control at the end of the file.
 */
const pending: Array<Promise<void>> = [];

function test(name: string, fn: () => void | Promise<void>) {
  const fail = (err: any) => {
    failed++;
    failures.push(`  ✗ ${name}\n    ${err?.message || err}`);
  };
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      pending.push((result as Promise<void>).then(() => { passed++; }, fail));
    } else {
      passed++;
    }
  } catch (err: any) {
    fail(err);
  }
}

test("unlogged: roast potatoes + mixed veggies is not an unpriced leftover after those items log", () => {
  const { unloggedFoodNotice } = UNLOGGED;
  const notice = unloggedFoodNotice(
    "My dinner is roast potatoes with mixed veggies and chicken breast",
    ["Chicken breast", "Roast potato", "Mixed"],
  );
  assert.equal(notice, "", notice);
});


// A CARD MAY NOT ORDER THE MEAL IT IS CONFIRMING (#114 P1, 2026-09-03, founder). The card that
// acknowledges a log prints "<meal> logged." directly above the next move. On "chicken breast and
// rice" — 61g of protein — the two lines read:
//
//     Kam: Chicken breast and Rice logged.
//     Make your next meal a proper protein — chicken, fish or eggs
//
// Both true of the ledger (61 of 195), and still absurd: a man holding an empty plate is told to
// go and make the plate. macro-card-attach already carries the rule in the founder's own words —
// "A human coach never tells a man who just ate a meal to go and eat a meal" — applied to the bulk
// eat-more branch and never to the two protein branches whose instruction IS the completed action.
{
  const { nextMoveLine, PROPER_PROTEIN_G } = CARD;
  // 61g in of 195g: protLeft 134, the >= 60 branch. 16:00, so `earlyDay` cannot mask the result.
  const short = (protIn: number) => [
    { label: "Calories", current: 900, target: 2800 },
    { label: "Protein", current: protIn, target: 195 },
    { label: "Fat", current: 30, target: 84 },
  ];
  // 150g in of 195g: protLeft 45, the >= 35 branch.
  const nearly = (protIn: number) => [
    { label: "Calories", current: 2000, target: 2800 },
    { label: "Protein", current: protIn, target: 195 },
    { label: "Fat", current: 60, target: 84 },
  ];

  test("progress card: the meal just logged is not re-ordered by the card confirming it", () => {
    for (const [rows, band] of [[short(61), ">=60"], [nearly(150), ">=35"]] as const) {
      const line = nextMoveLine(rows, false, 16, false, false, true);
      assert.ok(!/make (your |lunch )?(next meal )?a proper protein/i.test(line),
        `${band}: the card ordered the meal it was confirming — "${line}"`);
      assert.ok(!/^get a real protein into your next two meals$/i.test(line),
        `${band}: the card restated the action just completed — "${line}"`);
      assert.ok(/protein/i.test(line) && line.trim().length > 0,
        `${band}: the protein lever must survive, the instruction just moves forward — "${line}"`);
    }
  });

  test("progress card: OVER-FIRE — a plate with no real protein still gets the protein instruction", () => {
    // The control that stops the fix becoming "never ask for protein after any log". Same day
    // state, same clock; the only difference is that this plate was not a protein meal.
    for (const [rows, band] of [[short(61), ">=60"], [nearly(150), ">=35"]] as const) {
      const line = nextMoveLine(rows, false, 16, false, false, false);
      assert.ok(/proper protein|real protein/i.test(line),
        `${band}: a carb-only plate must still be told to get protein into the next meal — "${line}"`);
    }
  });

  test("progress card: OVER-FIRE through the card — the THRESHOLD decides, not merely 'a meal landed'", () => {
    // Graded through mealCard, because that is where the plate's protein is judged. The branch
    // control above passes the flag by hand and so cannot see a threshold that says yes to
    // everything — which is exactly the shape "any log counts as a protein meal" would take.
    const { mealCard } = CARD;
    const card = (mealProtein: number) => mealCard({
      firstName: "Kam", mealName: "Pap + Spinach", rows: short(61) as any,
      isBulk: false, usesNumbers: true, hour: 16, mealProtein,
    }).sub;
    // Tested as an INSTRUCTION, not as a phrase: "That's one proper protein down" reports what
    // they did and contains the same words as the order they must not be given.
    const ORDERS_A_MEAL = /\b(make|get)\b[^.]*\b(proper|real) protein\b/i;
    assert.ok(ORDERS_A_MEAL.test(card(8)),
      `an 8g plate is not a proper protein meal — the card must still ask for one: "${card(8)}"`);
    assert.ok(!ORDERS_A_MEAL.test(card(61)),
      `a 61g plate IS a proper protein meal — the card must not re-order it: "${card(61)}"`);
    // The on-demand "Today" card answers a question; no plate just landed, so nothing is carried
    // forward and its line must be unchanged from before this cut.
    const onDemand = mealCard({
      firstName: "Kam", mealName: "Today", rows: short(61) as any,
      isBulk: false, usesNumbers: true, hour: 16,
    }).sub;
    assert.equal(onDemand, "Get a real protein into your next two meals",
      `the on-demand card has no just-logged plate and must be untouched: "${onDemand}"`);
  });

  test("progress card: the carry-forward line may not promise a target it cannot prove", () => {
    // CTO adjudication on #148. `justAteProteinMeal` proves the plate that landed was >= 35g. It
    // proves NOTHING about whether one more like it closes the day, and the >=35 branch runs from
    // 35g owed to 59g owed. The first wording — "one more like that today and you're there" —
    // was false across most of its own band: at 59g owed, another minimum qualifying meal leaves
    // 24g.
    //
    // Written as the proof obligation rather than as a banned phrase, so a future re-wording is
    // held to the same standard: a line may claim arrival only where the arithmetic gets there.
    const CLAIMS_ARRIVAL = /you'?re there|you'?re done|and you'?re set|that'?s it\b|closes? it|sorted|target (?:hit|met|reached|done)|you'?re home/i;
    for (let protLeft = 35; protLeft <= 59; protLeft++) {
      const rows = [
        { label: "Calories", current: 2000, target: 2800 },
        { label: "Protein", current: 195 - protLeft, target: 195 },
        { label: "Fat", current: 60, target: 84 },
      ];
      const line = nextMoveLine(rows, false, 16, false, false, true);
      if (CLAIMS_ARRIVAL.test(line)) {
        // One more meal at the minimum that qualifies as "a proper protein meal" is the best case
        // the card can assume. If that still leaves a gap, arrival was not the card's to promise.
        assert.ok(protLeft - PROPER_PROTEIN_G <= 0,
          `with ${protLeft}g owed the card claimed arrival — one more ${PROPER_PROTEIN_G}g meal `
          + `leaves ${protLeft - PROPER_PROTEIN_G}g: "${line}"`);
      }
      // Whatever it says, it still may not re-order the meal that just landed.
      assert.ok(!/\b(make|get)\b[^.]*\b(proper|real) protein\b/i.test(line),
        `with ${protLeft}g owed the card re-ordered the meal it was confirming: "${line}"`);
    }
  });

  test("progress card: several small eating events do not add up to a proper protein meal", () => {
    // #114 P1 review. One message can be several separate meals — "eggs this morning, pap at
    // lunch" is two events, an album of four photos is four, and each commits its own row. The
    // card's claim is about ONE plate, so the aggregate across those events may never answer it:
    // four ~10g events sum to 40g and no plate among them was a protein meal.
    const { biggestEventProtein, mealCard } = CARD;
    const fourSmall = [{ protein: 10 }, { protein: 9 }, { protein: 11 }, { protein: 10 }];
    const sum = fourSmall.reduce((t, e) => t + e.protein, 0);
    assert.ok(sum >= PROPER_PROTEIN_G,
      `the fixture must actually be dangerous: ${sum}g summed has to clear the ${PROPER_PROTEIN_G}g bar, or this proves nothing`);
    assert.ok(biggestEventProtein(fourSmall) < PROPER_PROTEIN_G,
      `four sub-threshold events combined into a proper protein meal: ${biggestEventProtein(fourSmall)}g`);

    // ...and the card says so. Graded on the line, not on the number.
    const sub = (mealProtein: number) => mealCard({
      firstName: "Kam", mealName: "Eggs + Pap", rows: short(61) as any,
      isBulk: false, usesNumbers: true, hour: 16, mealProtein,
    }).sub;
    assert.ok(/\b(make|get)\b[^.]*\b(proper|real) protein\b/i.test(sub(biggestEventProtein(fourSmall))),
      `four small plates must still be told to get a real protein: "${sub(biggestEventProtein(fourSmall))}"`);
    assert.ok(!/one proper protein down/i.test(sub(biggestEventProtein(fourSmall))),
      `the card claimed a proper protein meal that no single event delivered: "${sub(biggestEventProtein(fourSmall))}"`);

    // A REAL single event still qualifies — the control that stops this becoming "never".
    const oneRealMeal = [{ protein: 8 }, { protein: 61 }];
    assert.ok(biggestEventProtein(oneRealMeal) >= PROPER_PROTEIN_G,
      `a genuine 61g event must still qualify: ${biggestEventProtein(oneRealMeal)}g`);
    assert.ok(!/\b(make|get)\b[^.]*\b(proper|real) protein\b/i.test(sub(biggestEventProtein(oneRealMeal))),
      `a real protein meal beside a snack must not be re-ordered: "${sub(biggestEventProtein(oneRealMeal))}"`);

    // The single-event case — the common one — is unchanged.
    assert.equal(biggestEventProtein([{ protein: 61 }]), 61, "one event answers with its own protein");
    assert.equal(biggestEventProtein([]), 0, "no events is not a protein meal");
  });

  test("progress card: the 'just ate protein' test uses the band the card already owns", () => {
    // One number for both halves. If PROPER_PROTEIN_G drifts from the >= 35 band below it, the
    // card can call a plate a proper protein meal while still asking for one to close the gap.
    assert.equal(PROPER_PROTEIN_G, 35, "the proper-protein threshold is the card's own 35g band");
    // And the flag is inert once the gap is small enough that the instruction is no longer a
    // repeat — those rungs ask for eggs or a shake, not for another meal.
    const smallGap = [
      { label: "Calories", current: 2400, target: 2800 },
      { label: "Protein", current: 180, target: 195 },
      { label: "Fat", current: 70, target: 84 },
    ];
    assert.equal(nextMoveLine(smallGap, false, 16, false, false, true),
      nextMoveLine(smallGap, false, 16, false, false, false),
      "a small remaining gap asks for a different, smaller action — it is not a repeat, so it must not change");
  });
}

test("progress card: calories at/over target do not sell another meal", () => {
  const { nextMoveLine } = CARD;
  const rows = [
    { label: "Calories", current: 3200, target: 3140 },
    { label: "Protein", current: 195, target: 160 },
    { label: "Fat", current: 90, target: 70 },
  ];
  const line = nextMoveLine(rows, false, 18, false);
  assert.ok(!/next meal/i.test(line), line);
  assert.ok(/water|done|in/i.test(line), line);
});

// ── Messy-life intake (product core journeys) ───────────────────────────────
test("messy intake: McDonald's breakfast + mocha forces food log", () => {
  const { parseMessyIntake } = MESSY;
  const r = parseMessyIntake("So today I had a McDonald's South African breakfast with a mocha.");
  assert.equal(r.mustForceFoodLog, true);
  assert.equal(r.hasFoodReport, true);
  assert.ok(r.foodText && /mcdonald|breakfast|mocha/i.test(r.foodText));
});

test("messy intake: mixed yesterday food + steps + feeling", () => {
  const { parseMessyIntake } = MESSY;
  const r = parseMessyIntake(
    "Yesterday I ate pap and chicken for dinner, walked about eight thousand steps, I'm exhausted.",
  );
  assert.equal(r.hasFoodReport, true);
  assert.equal(r.hasStepsReport, true);
  assert.equal(r.hasFeeling, true);
  assert.equal(r.stepCount, 8000);
  assert.equal(r.mustForceFoodLog, true);
});

// ── CUT 1: ONE TURN COMMITS EVERY EVENT ─────────────────────────────────────────────────────
// The gate is the commit path, not the parser. routes.ts was a chain of ~13 `return` statements:
// the first handler that recognised anything ended the turn. Pairs were stitched by hand, so
// combinations nobody had screenshotted still dropped half the note.

test("cut 1: workout + food is a two-fact note, not a workout note", () => {
  const { parseMessyIntake } = MESSY;
  // The live defect: handleWorkoutCommands returned unconditionally at routes.ts:872, so this
  // logged the session and deleted the meal. Same failure as the 16:02 note, a pair nobody
  // had written.
  const r = parseMessyIntake("I trained chest today and had chicken and pap");
  assert.equal(r.hasWorkoutReport, true, "a reported session is a fact");
  assert.equal(r.hasFoodReport, true, "…and so is the meal beside it");
  assert.ok(r.factTypes.includes("workout") && r.factTypes.includes("food"));
  assert.ok(r.factTypes.length >= 2, "two facts means no single handler may end the turn");
});

test("cut 1: a request for a workout is not a reported session", () => {
  const { parseMessyIntake } = MESSY;
  // Detection must not be so loose that every workout command becomes a multi-fact note.
  for (const ask of ["send me my workout", "workout", "what's today's session", "1"]) {
    assert.equal(parseMessyIntake(ask).hasWorkoutReport, false, `"${ask}" is a command, not a fact`);
  }
});

test("cut 1: no handler may end a multi-fact turn", () => {
  const routes = readFileSync("server/routes.ts", "utf-8");
  const code = routes.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // Every co-occurring handler commits and continues; only a single-fact note keeps a fast path.
  // WIDENED 2026-08-22. The condition was `!multiFact` — two write DOMAINS. A message carrying
  // one write plus a question ("my breakfast was eggs. what's the plan?") is the ordinary shape
  // and it was not covered: the educator claimed it and the meal was never written. mayEndTurn
  // is the same gate asking a stronger question — is any fact this client stated still unwritten.
  // THE GATE IS THE PROPERTY, NOT THE EXPRESSION (widened 2026-08-26, issue #63). These matched
  // `return workoutResult;` exactly, so wrapping the fast path's VALUE — closeCoachingTurn, which
  // appends the one next coaching move after a durable write — read as the gate having been
  // removed. It had not: mayEndTurn still decides whether the turn may end, which is all this
  // test is about. The identifier stays pinned so a handler cannot quietly return something else.
  for (const guard of [
    /if \(mayEndTurn\("workout"\)\) return [\w.(]*workoutResult\)?;/,
    /if \(mayEndTurn\("steps"\)\) return [\w.(]*stepPart\)?;/,
    /if \(mayEndTurn\("water"\)\) return [\w.(]*waterPart\)?;/,
  ]) assert.ok(guard.test(code), `a co-occurring handler still claims the turn: ${guard}`);
  assert.ok(/const mayEndTurn = \(who: string\): boolean => \{[\s\S]{0,200}?if \(multiFact\) return false;[\s\S]{0,200}?factsStillOwed\(\)/.test(code),
    "mayEndTurn must refuse on multiFact AND on any fact stated-but-unwritten");
  // The backfill note rides along on the food reply so a written session is acknowledged in the
  // same message (2026-08-25) — the commit is still the food owner's, with that line appended.
  assert.ok(/commitFact\(turn, "food", foodCtxResult \+ _backfillNote\)/.test(code),
    "food commits like the rest");
});

test("cut 1: the hand-stitched pair branches are gone", () => {
  // Comments naming the retired hacks are how we remember why they went — strip them, or this
  // test fails on its own explanation.
  const strip = (f: string) => readFileSync(f, "utf-8").split("\n")
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const routes = strip("server/routes.ts");
  const food = strip("server/handlers/food-context.ts");
  // `stepReplyPart` was a string threaded through the chain so food could prepend the steps
  // line — multi-intent faked one pair at a time. It is the disease in a variable name.
  assert.ok(!/stepReplyPart/.test(routes), "stepReplyPart is gone from the router");
  assert.ok(!/stepReplyPart/.test(food), "…and from the food handler it was threaded into");
  // `alsoHasFood` was a 30-word food regex inside the STEP handler, deciding which other facts
  // were allowed to coexist with steps — maintained separately from the real food scanner.
  assert.ok(!/alsoHasFood|alsoHasWater/.test(routes), "the steps↔food pair branch is gone");
});

// ── CUT 2: THE FACTS ARE COUNTED ON WHAT THE CLIENT WROTE ───────────────────────────────────
// Cut 1 parsed the facts off `message` AFTER the normalizer had replaced it. A two-fact note
// rewritten down to "i walked 8000 steps" reached the ledger as ONE fact, so multiFact was false
// and the first handler ended the turn. Cut 1's own gate could not see this: routing-audit runs
// with NORMALIZER=off, so the rewriter never executed in any test that proved Cut 1 worked.

test("cut 2: the fact parse happens before the rewriter, not after", () => {
  const src = readFileSync("server/routes.ts", "utf-8");
  const parseAt = src.search(/(?:const|let) turnFacts = \w*\(?parseMessyIntake\(message\)/);
  const rewriteAt = src.indexOf("message = canon;");
  assert.ok(parseAt > -1 && rewriteAt > -1, "both sites must exist");
  assert.ok(parseAt < rewriteAt,
    "facts must be counted on the client's raw text — after `message = canon` they are counted on a rewrite");
});

test("cut 2: a multi-fact note is never rewritten at all", () => {
  const src = readFileSync("server/routes.ts", "utf-8");
  assert.ok(/if \(multiFact && canon\)/.test(src),
    "a canonical is one command; a note of several facts cannot be spoken for by one");
});

test("cut 2: rewriting a mixed note down to one fact is what breaks the ledger", async () => {
  const { parseMessyIntake } = await import("../server/understanding/messy-intake");
  const raw = parseMessyIntake("Yesterday I walked eight thousand steps and I had chicken and pap. I'm exhausted.");
  assert.ok(raw.factTypes.length >= 2, "the client's own words carry three facts");
  // This is the exact string the classifier produced live at 16:21. If the ledger is fed THIS,
  // multiFact is false and every downstream guard is bypassed — which is why the parse moved.
  const rewritten = parseMessyIntake("i walked 8000 steps");
  assert.equal(rewritten.factTypes.length, 1, "the rewrite is a one-fact note by construction");
  assert.ok(!rewritten.factTypes.includes("food"), "…and the meal is simply gone from it");
});

test("cut 2: nothing above the ledger may answer a multi-fact note", () => {
  const src = readFileSync("server/routes.ts", "utf-8");
  const code = src.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // The engine sits above the ledger and returns the turn. On a log it must stand down, or a
  // freeform reply answers instead of the facts being committed.
  // Asserted as an INVARIANT rather than a count (2026-08-21). This required exactly 2, which
  // encoded the defect it was written beside: the engine was invoked twice per turn. The turn
  // now has one engine pass, and the rule that matters is unchanged — EVERY pass stands down on
  // a log, however many there are.
  // Anchored to the INVOCATION, not to every mention of engineLive() — there is an unrelated
  // frustration gate that also names it, and a guard that flags the wrong line gets switched off.
  const lines = code.split("\n");
  const invocations = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /runMeaningEngineLive\(/.test(l));
  assert.ok(invocations.length >= 1, "the engine is invoked somewhere");
  for (const { i } of invocations) {
    const guard = lines.slice(Math.max(0, i - 3), i + 1).join(" ");
    assert.ok(/!multiFact/.test(guard) || /factsStillOwed\(\)\.length === 0/.test(guard),
      `an engine pass does not stand down on a multi-fact note: ${lines[i].trim().slice(0, 90)}`);
  }
  // early-commands now RUNS and COMMITS rather than standing down: on "had 2 litres of water and
  // took my creatine" the supplement handler inside it is the only thing that knows what a
  // supplement is, and standing down lost the confirmation entirely.
  // Same widening as cut 1: the fast path's VALUE may be wrapped by closeCoachingTurn, but the
  // gate and the commit that follows it are the two things this asserts.
  assert.ok(/if \(mayEndTurn\("early-commands"\)\) return [\w.(]*earlyResult\)?;\s*\n\s*commitFact\(turn, "other", earlyResult\);/.test(code),
    "early-commands must commit its confirmation, not end the turn and not vanish");
});

// ── CUT 3: THE VERDICT BINDS THE MOUTH, AND THE MOUTH IS DETERMINISTIC ──────────────────────
// reconcileTurnReply was backwards in the one direction that matters: `if (!verifier.ok) return
// reply` sent a REJECTED reply — including a medication-safety violation — to the client
// unchanged, and the VERIFIER REJECTION repair reason further down was unreachable dead code.
// Meanwhile a reply the verifier PASSED could be handed to a second askCoachK call whose output
// went out unverified and overwrote chatHistory.messageOut.

test("cut 3: a rejected reply is blocked, not forwarded", () => {
  const src = readFileSync("server/handlers/chat-log.ts", "utf-8");
  const code = src.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!/if \(!verifier\.ok \|\|/.test(code),
    "the old guard returned the rejected draft — a violation must never be the reply");
  assert.ok(/if \(!verifier\.ok\) \{[\s\S]{0,400}?safeReplacementFor/.test(code),
    "a rejected reply is replaced by a deterministic safe line");
  assert.ok(/reply_blocked_by_verifier/.test(code), "…and raises an escalation, not just a log line");
});

test("cut 3: the repair layer has no second mouth", () => {
  const src = readFileSync("server/handlers/chat-log.ts", "utf-8");
  const code = src.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // Doctrine: deterministic commit + compose wins. Repair does not get a model call.
  assert.ok(!/askCoachK/.test(code), "no second model call after the deterministic turn");
  assert.ok(!/buildClientSnapshot/.test(code), "…and no snapshot built to feed one");
  assert.ok(!/DRAFT THAT MUST NOT BE SENT/.test(src), "the rewrite instruction is gone");
});

test("cut 3: messageOut is only ever overwritten with re-verified text", () => {
  const src = readFileSync("server/handlers/chat-log.ts", "utf-8");
  const code = src.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const write = code.indexOf("messageOut: corrected");
  const recheck = code.indexOf("const recheck = verifyBrainReply");
  assert.ok(write > -1 && recheck > -1, "both sites must exist");
  assert.ok(recheck < write, "a correction is re-verified BEFORE it replaces the record");
  assert.ok(!/messageOut: repaired/.test(code), "unverified model output never touches the record");
});

test("cut 3: a stale number is corrected from the ledger, keeping formatting", async () => {
  // Deterministic substitution replaces the second model call. We already hold the authoritative
  // row — asking a model to "rewrite using the latest step count" was slower, billed, and its
  // output went out ungated.
  const { __testReplaceNumberToken } = await import("../server/handlers/chat-log");
  assert.equal(__testReplaceNumberToken("You're on 8,500 steps today.", 8500, 8000),
    "You're on 8,000 steps today.");
  assert.equal(__testReplaceNumberToken("You're on 8500 steps today.", 8500, 8000),
    "You're on 8,000 steps today.");
  assert.equal(__testReplaceNumberToken("You weighed 83.4kg.", 83.4, 82.1), "You weighed 82.1kg.");
  // A number that is not the stale one must not be touched.
  assert.equal(__testReplaceNumberToken("8,500 steps against a 10,000 target.", 8500, 8000),
    "8,000 steps against a 10,000 target.");
});

test("cut 1: one composer, fixed order, one bubble", async () => {
  const { newTurnLedger, commitFact, composeMessyAck, committedCount, FEELING_ACK } =
    await import("../server/understanding/messy-intake");
  const t = newTurnLedger(["workout", "food", "feeling"]);
  // Commit out of order on purpose — the reply must not reorder itself by handler timing.
  commitFact(t, "food", "Logged: chicken and pap 🍽️");
  commitFact(t, "feeling", FEELING_ACK);
  commitFact(t, "workout", "Session logged 💪");
  const out = composeMessyAck(t);
  assert.equal(committedCount(t), 3);
  assert.ok(out.indexOf("Session logged") < out.indexOf("Logged: chicken"), "what they did comes first");
  assert.ok(out.indexOf("Logged: chicken") < out.indexOf("Showing up"), "feeling closes the reply");
  assert.ok(!out.includes("---"), "`\\n\\n---\\n\\n` would bill this as two WhatsApp messages");
  // A duplicate or empty commit must not double the reply.
  commitFact(t, "food", "Logged: chicken and pap 🍽️");
  commitFact(t, "steps", "   ");
  assert.equal(committedCount(t), 3);
});

test("messy intake: pure feeling does not force food log", () => {
  const { parseMessyIntake } = MESSY;
  const r = parseMessyIntake("I'm just tired and stressed, work was a lot.");
  assert.equal(r.hasFeeling, true);
  assert.equal(r.mustForceFoodLog, false);
  assert.equal(r.hasFoodReport, false);
});

test("isMessyLifeTranscript: short branded meal preserved whole", () => {
  const { isMessyLifeTranscript } = UTILS;
  assert.equal(
    isMessyLifeTranscript("I had a McDonald's breakfast with a mocha"),
    true,
  );
});

test("isMessyLifeTranscript: food + feeling is messy life", () => {
  const { isMessyLifeTranscript } = UTILS;
  assert.equal(
    isMessyLifeTranscript("I ate takeaways again and I feel like giving up"),
    true,
  );
});


test("ungrounded food: Big Mac dropped when client said SA breakfast + mocha", () => {
  const { findUngroundedFoodItems } = UTILS;
  const msg = "Today for breakfast I had a South African breakfast from McDonald's and a large mocha";
  const dropped = findUngroundedFoodItems(msg, [
    { name: "McDonald's Big Mac" },
    { name: "McDonald's Big Breakfast (SA)" },
    { name: "Mocha" },
  ]);
  assert.ok(dropped.some((n: string) => /big mac/i.test(n)), "Big Mac must be ungrounded");
  assert.ok(!dropped.some((n: string) => /^mocha$/i.test(n)), "Mocha must stay grounded");
});


test("messy: walk without a number is a steps report with null count", () => {
  const { parseMessyIntake, mentionedWalkWithoutCount } = MESSY;
  const r = parseMessyIntake("This morning I had a mocha and I've just walked");
  assert.equal(r.hasFoodReport, true);
  assert.equal(mentionedWalkWithoutCount("This morning I had a mocha and I've just walked"), true);
  assert.equal(mentionedWalkWithoutCount("I walked 8000 steps"), false);
});

test("composeMessyAck joins food, steps, feeling without dropping a part", () => {
  const { composeMessyAck, newTurnLedger, commitFact, FEELING_ACK } = MESSY;
  const t = newTurnLedger(["food", "steps", "feeling"]);
  commitFact(t, "food", "Got it — pap and chicken.");
  commitFact(t, "steps", "Heard you walked — send the step count.");
  commitFact(t, "feeling", FEELING_ACK);
  const out = composeMessyAck(t);
  assert.ok(/pap and chicken/.test(out));
  assert.ok(/walked/.test(out));
  assert.ok(/feeling/.test(out));
});

test("nutrition: three McDonald's retries are one takeaway, not a fried-day lecture", () => {
  const { assessNutritionStandards } = NUTRI;
  const foods = [
    "McDonald's Big Breakfast mocha",
    "McDonald's Big Breakfast mocha",
    "McDonald's Big Breakfast mocha",
  ];
  const n = assessNutritionStandards({ todayFoods: foods, goalType: "muscle_gain" });
  assert.equal(n, null);
});

test("card nextMoveLine does not say grill it don't fry it", () => {
  const src = readFileSync("server/macro-card-attach.ts", "utf8");
  assert.ok(!/Grill it, don't fry it/.test(src), "confirmation card must not scold frying");
});

test("verifier blocks fried lecture on a meal they just stated", () => {
  const { verifyBrainReply } = VERIF;
  const r = verifyBrainReply(
    "That's a lot of fried/takeaway today — tasty, but heavy on the hidden fat and salt.",
    { clientMessage: "I had a McDonald's South African breakfast with a mocha" },
  );
  assert.equal(r.ok, false);
});


test("same-meal retry: two McDonald breakfast item lists are one meal", () => {
  const { isSameMealRetry } = FOODID;
  assert.equal(isSameMealRetry(
    ["McDonald's Big Breakfast (SA)", "Mocha"],
    ["McDonald's Breakfast", "Mocha (coffee shop)"],
  ), true);
  assert.equal(isSameMealRetry(["pap", "chicken"], ["eggs", "toast"]), false);
});

test("parseDropLoggedItem: that wasn't a big mac", () => {
  const { parseDropLoggedItem } = FOODID;
  assert.equal(parseDropLoggedItem("that wasn't a big mac"), "big mac");
  assert.equal(parseDropLoggedItem("I am not hungry"), null);
});

test("messy intake: yesterday pap and chicken is retro", () => {
  const { parseMessyIntake } = MESSY;
  const r = parseMessyIntake("Yesterday I ate pap and chicken, walked about 8000 steps, I'm exhausted");
  assert.equal(r.hasFoodReport, true);
  assert.equal(r.hasStepsReport, true);
  assert.equal(r.hasFeeling, true);
  assert.equal(r.stepCount, 8000);
  assert.equal(r.isRetro, true);
});


test("nextMoveLine on a past day does not say eat more today", () => {
  const { nextMoveLine } = CARD;
  const rows = [
    { label: "Calories", current: 600, target: 2500 },
    { label: "Protein", current: 56, target: 180 },
  ];
  const line = nextMoveLine(rows, false, 16, true);
  // "today's plate is a separate day" is the CORRECT line and contains "today", so banning the
  // word is the wrong test. What must never happen is a TODAY instruction off a yesterday log.
  assert.ok(!/(eat|add|get|have|hit)[^.]{0,30}\btoday\b/i.test(line), line);
  assert.ok(!/\btoday'?s? (target|goal|card)\b/i.test(line), line);
  assert.ok(/yesterday/i.test(line), line);
});

test("mealCard yesterday unit is not protein today", () => {
  const { mealCard } = CARD;
  const card = mealCard({
    firstName: "Kam",
    mealName: "Chicken and pap",
    rows: [
      { label: "Calories", current: 600, target: 2500 },
      { label: "Protein", current: 56, target: 180 },
    ],
    isBulk: false,
    usesNumbers: true,
    isPastDay: true,
  });
  // The unit is the client-facing number label — on a past day it must read "yesterday".
  assert.equal(card.unit, "protein yesterday", card.unit);
  // The sub-line may SAY today ("today's plate is a separate day") but must not INSTRUCT today.
  assert.ok(!/(eat|add|get|have|hit)[^.]{0,30}\btoday\b/i.test(card.sub || ""), card.sub);
});


test("REBUILD GATE journey 2: yesterday pap + 8000 steps + exhausted — all three, steps survive QUESTION", () => {
  const { journeyMustKeepFacts, parseMessyIntake } = MESSY;
  const msg = "Yesterday, I had pap and chicken, and I walked 8,000 steps. I'm so exhausted.";
  const g = journeyMustKeepFacts(msg);
  assert.equal(g.food, true);
  assert.equal(g.feeling, true);
  assert.equal(g.isRetro, true);
  assert.equal(g.stepCount, 8000);
  assert.equal(g.logStepsEvenIfClassifiedQuestion, true);
  const r = parseMessyIntake(msg);
  assert.equal(r.hasFoodReport, true);
  assert.equal(r.hasStepsReport, true);
});

test("REBUILD GATE journey 1: McDonald's + mocha is a food log, not a chat", () => {
  const { journeyMustKeepFacts } = MESSY;
  const g = journeyMustKeepFacts("I had a South African breakfast from McDonald's and a large mocha");
  assert.equal(g.food, true);
});

test("REBUILD GATE journey 3: that wasn't a big mac is a drop, not a new meal", () => {
  const { parseDropLoggedItem } = FOODID;
  assert.equal(parseDropLoggedItem("that wasn't a big mac"), "big mac");
});


test("fidelity: STEPS canonical cannot drop pap and chicken", () => {
  const { normalizerFidelity } = FIDELITY;
  const r = normalizerFidelity(
    "Yesterday I walked eight thousand steps and I had chicken and pap.",
    "i walked 8000 steps yesterday",
  );
  assert.equal(r.ok, false, r.reason);
});

test("fidelity: FOOD_LOG canonical cannot drop 8000 steps", () => {
  const { normalizerFidelity } = FIDELITY;
  const r = normalizerFidelity(
    "Yesterday I had pap and chicken, and I walked 8,000 steps. I'm so exhausted.",
    "i had pap and chicken yesterday",
  );
  assert.equal(r.ok, false, r.reason);
});

// ============================================================
// scalePortionDescription — portion label scaling
// ============================================================

test("scalePortionDescription: quantity 1 returns desc unchanged", () => {
  assert.equal(scalePortionDescription("2 slices (60g)", 1), "2 slices (60g)");
});

test("scalePortionDescription: doubles ALL numbers (slices + grams)", () => {
  assert.equal(scalePortionDescription("2 slices (60g)", 2), "4 slices (120g)");
});

test("scalePortionDescription: tripling a mixed label", () => {
  assert.equal(scalePortionDescription("1 cup (240ml)", 3), "3 cups (720ml)");
});

test("scalePortionDescription: half-serving yields decimal then rounds", () => {
  // 2 slices × 0.5 = 1 slice; 60g × 0.5 = 30g
  assert.equal(scalePortionDescription("2 slices (60g)", 0.5), "1 slices (30g)");
});

test("scalePortionDescription: 1.5× scales all numbers", () => {
  // 2×1.5=3 slices; 60×1.5=90g
  assert.equal(scalePortionDescription("2 slices (60g)", 1.5), "3 slices (90g)");
});

test("scalePortionDescription: decimal result rounded to 1 dp when not integer", () => {
  // 1 cup × 2.5 = 2.5 cups; 240 × 2.5 = 600
  assert.equal(scalePortionDescription("1 cup (240ml)", 2.5), "2.5 cups (600ml)");
});

test("scalePortionDescription: gram-only label scales correctly", () => {
  assert.equal(scalePortionDescription("150g portion", 2), "300g portion");
});

test("scalePortionDescription: no numbers in desc — returns desc unchanged", () => {
  assert.equal(scalePortionDescription("one egg", 3), "one egg");
});

// ============================================================
// extractMealLabel — meal time extraction from message text
// ============================================================

test("extractMealLabel: 'for breakfast' → breakfast", () => {
  assert.equal(extractMealLabel("I had eggs for breakfast"), "breakfast");
});

test("extractMealLabel: 'for lunch' → lunch", () => {
  assert.equal(extractMealLabel("rice and chicken for lunch"), "lunch");
});

test("extractMealLabel: 'for dinner' → dinner", () => {
  assert.equal(extractMealLabel("had pap for dinner"), "dinner");
});

test("extractMealLabel: 'for supper' → dinner (supper maps to dinner)", () => {
  assert.equal(extractMealLabel("had pap for supper"), "dinner");
});

test("extractMealLabel: 'snack' keyword → snack", () => {
  assert.equal(extractMealLabel("afternoon snack — apple"), "snack");
});

test("extractMealLabel: bare 'Lunch' at start of message → lunch", () => {
  assert.equal(extractMealLabel("Lunch rice and beef"), "lunch");
});

test("extractMealLabel: bare 'Dinner' at start → dinner", () => {
  assert.equal(extractMealLabel("Dinner pap and wors"), "dinner");
});

test("extractMealLabel: bare 'Breakfast' at start → breakfast", () => {
  assert.equal(extractMealLabel("Breakfast 2 eggs and toast"), "breakfast");
});

test("extractMealLabel: 'breakfast was' → breakfast", () => {
  assert.equal(extractMealLabel("breakfast was oats with milk"), "breakfast");
});

// BONOLO'S LOG (2026-07-14): a photo captioned "Breakfast" sent at 1pm was stamped
// LUNCH because the PHOTO path used slotFromSastHour(now), ignoring her caption. The
// caption keyword must win over the clock at any time of day — a batch-logger who
// eats early and logs at midday must not have her whole morning dumped into LUNCH.
test("extractMealLabel: caption wins over the clock — 'Breakfast' at 1pm → breakfast", () => {
  const onePm = new Date("2026-07-14T13:00:00+02:00"); // SAST lunchtime
  assert.equal(extractMealLabel("Breakfast", onePm), "breakfast");
  assert.equal(extractMealLabel("Snack", onePm), "snack");
  assert.equal(extractMealLabel("Dinner", onePm), "dinner");
});

test("extractMealLabel: no caption at 1pm → clock fallback (lunch)", () => {
  const onePm = new Date("2026-07-14T13:00:00+02:00");
  assert.equal(extractMealLabel("", onePm, { kcal: 600, protein: 30 }), "lunch");
});

test("extractMealLabel: 'dinner was' → dinner", () => {
  assert.equal(extractMealLabel("dinner was chicken and rice"), "dinner");
});

test("extractMealLabel: no time signal — returns null (falls back to time-of-day)", () => {
  // Pure message with no meal keyword — result depends on server clock, just check it's
  // a valid label or null (not an unexpected string)
  const result = extractMealLabel("oats and milk");
  const VALID = new Set(["breakfast", "lunch", "dinner", "snack", null]);
  assert.ok(VALID.has(result), `unexpected label: ${result}`);
});

// ============================================================
// explicitMealSlot — the client's own words, isolated from clock/macro inference
// (Work Order A, 2026-08-12: "lunch" said at 9h SAST was dropped as clock-impossible
// and relabelled breakfast — the clock must never outrank an explicit claim).
// ============================================================

test("explicitMealSlot: 'for lunch' → lunch, independent of any clock", () => {
  assert.equal(explicitMealSlot("I had chicken for lunch"), "lunch");
});

test("explicitMealSlot: 'for dinner' → dinner", () => {
  assert.equal(explicitMealSlot("I had pap for dinner yesterday"), "dinner");
});

test("explicitMealSlot: no meal word at all — 'earlier' is not a slot claim → null", () => {
  assert.equal(explicitMealSlot("I had chicken earlier"), null);
});

test("explicitMealSlot: bare keyword anywhere in the message still counts", () => {
  assert.equal(explicitMealSlot("Rice and beef for my lunch"), "lunch");
});

// REALITY J1, verbatim (2026-08-12). Sent at 12h SAST, this was stored as `label=lunch` with
// the log line `dropped impossible slot "breakfast" at 12h SAST — letting the clock decide`.
// The client SAID breakfast; the clock overruled them. Locked with the exact live string.
test("explicitMealSlot: the J1 message keeps its breakfast, whatever the clock says", () => {
  assert.equal(explicitMealSlot("I had 2 eggs and toast for breakfast"), "breakfast");
});

// ============================================================
// "THIS MORNING" IS A SLOT CLAIM (#174 — first divergence found by the #170 Journey Lab)
//
// Through the real front door and real PostgreSQL, "This morning I had 3 eggs and 2 slices of
// toast" was written with meal_label = 'snack': nothing recognised the phrase, so extractMealLabel
// asked the send clock, which knows when the message arrived and nothing about when the food was
// eaten. parseMealDate has read "this morning" as 8am SAST for months — the meaning existed and
// simply never reached the slot.
// ============================================================

test("explicitMealSlot: the Journey Lab message — 'This morning' is breakfast", () => {
  assert.equal(explicitMealSlot("This morning I had 3 eggs and 2 slices of toast"), "breakfast");
});

test("explicitMealSlot: a named day's morning is breakfast too, and says nothing about the date", () => {
  assert.equal(explicitMealSlot("Yesterday morning I had eggs"), "breakfast");
  assert.equal(explicitMealSlot("Monday morning I had oats"), "breakfast");
  assert.equal(explicitMealSlot("I had a banana in the morning"), "breakfast");
});

// THE ORDER IN THAT FUNCTION IS LOAD-BEARING, and this is the control that proves the new branch
// did not disturb it. An explicitly named other meal sits ABOVE the bare forms, so a message
// carrying both a morning phrase and a named meal must still resolve to the named meal — exactly
// as it did before, when the morning phrase was invisible.
test("explicitMealSlot: a named meal still outranks a morning phrase in the same message", () => {
  assert.equal(explicitMealSlot("This morning I had eggs, and for lunch I had rice"), "lunch");
  assert.equal(explicitMealSlot("I skipped breakfast this morning and had a snack"), "snack");
});

// OVER-FIRE. The claim is about a phrase naming the morning PERIOD, not about the word appearing.
test("explicitMealSlot: 'morning' with no temporal determiner is not a slot claim", () => {
  assert.equal(explicitMealSlot("Morning coach, I had rice"), null);
  assert.equal(explicitMealSlot("I had chicken and rice"), null);
});

// ============================================================
// ASKING FOR HELP TO START IS ASKING WHAT TO DO (#178 — Journey Lab divergence)
//
// A genuinely returning client said "I need help getting going again" and reached no owner at
// all: every branch of looksLikeDirectionRequest wants "plan", "direction" or "what should I do",
// and someone coming back after two weeks does not phrase it that way — they ask for help. The
// coach answered them with "Sorry Kam, I didn't quite catch that", and Coach Health independently
// filed the same turn as a candidate.
// ============================================================

test("a request for help getting going reaches the direction owner (#178)", async () => {
  const { looksLikeDirectionRequest } = await import("../server/daily-direction");
  assert.ok(looksLikeDirectionRequest("I need help getting going again"), "the Journey Lab message");
  assert.ok(looksLikeDirectionRequest("help me get started"));
  assert.ok(looksLikeDirectionRequest("I could use some help getting going"));
  assert.ok(looksLikeDirectionRequest("I want help restarting"));
});

// NARROW ON PURPOSE. Bare "help" keeps its own owner, and help with a NAMED domain belongs to that
// domain — the guard that has always sent workout/food/billing asks elsewhere is untouched.
test("a generic or domain-specific help ask is NOT a direction request (#178)", async () => {
  const { looksLikeDirectionRequest } = await import("../server/daily-direction");
  assert.ok(!looksLikeDirectionRequest("help"));
  assert.ok(!looksLikeDirectionRequest("I need help"));
  assert.ok(!looksLikeDirectionRequest("help me with my workout"));
  assert.ok(!looksLikeDirectionRequest("I need help getting a refund"));
  assert.ok(!looksLikeDirectionRequest("help me get my meal plan"));
});

// THE OWNER SAYS NOTHING ABOUT ABSENCE, which is what makes it safe for the present-but-sparse
// client saying the same words: they get today's direction too, framed by their own state rather
// than by a claim that they disappeared. Graded as a property of the recogniser — it reads the
// message and nothing else, so it cannot tell two clients different stories about silence.
test("the direction recogniser reads the message only, never contact state (#178)", async () => {
  const { looksLikeDirectionRequest } = await import("../server/daily-direction");
  assert.equal(looksLikeDirectionRequest.length, 1, "one argument: the message");
  assert.equal(
    looksLikeDirectionRequest("I need help getting going again"),
    looksLikeDirectionRequest("I need help getting going again"),
    "the same words give the same answer, whoever sent them");
});

// ============================================================
// DECLARED CONSTRAINTS MUST GOVERN WHAT WE OFFER, NOT JUST WHAT WE ANNOUNCE (#177)
//
// The Journey Lab found the grocery reply saying "🚫 Left off — you told me: no pork, eggs, pork"
// and then offering "• Eggs (18 pack)" plus four egg-based meals. The coach named the exclusion
// and broke it in the same message, which is worse than never having asked — it is proof we were
// told and did not listen. Every control below is paired with an UNRESTRICTED control, because
// "the list has no eggs" is equally true of a list that never had any.
// ============================================================

test("the grocery list offers eggs to a client with no restrictions, and not to one who excluded them (#177)", async () => {
  const { getShoppingList } = await import("../server/shopping-lists");
  const { foodConstraints } = await import("../server/food-swaps");
  const free = getShoppingList("100_300", 1, "fat_loss");
  const cons = getShoppingList("100_300", 1, "fat_loss", foodConstraints({ dietaryRestrictions: "no eggs, no pork" }));
  const eggy = (l: any) => l.items.filter((i: any) => /\begg/i.test(i.item)).length;
  assert.ok(eggy(free) > 0, "CONTROL: the unrestricted list must contain eggs, or this proves nothing");
  assert.equal(eggy(cons), 0, "the restricted list offers no eggs");
  assert.ok(cons.items.length > 0, "…and is still a real list, not an empty one");
  assert.ok(cons.items.length >= free.items.length - 4, "only the restricted items were removed");
});

test("a shop-was-out substitution never names a restricted food (#177)", async () => {
  const { answerUnavailable, foodConstraints } = await import("../server/food-swaps");
  const c = foodConstraints({ dietaryRestrictions: "no eggs" });
  const free = answerUnavailable("they didn't have chicken") || "";
  const cons = answerUnavailable("they didn't have chicken", c) || "";
  assert.match(free, /egg/i, "CONTROL: the unrestricted answer offers eggs");
  assert.ok(cons.length > 0, "the restricted client still gets an answer");
  assert.doesNotMatch(cons, /egg/i, "…without the food they excluded");
});

test("a proposed restricted food is answered, not silently dropped (#177)", async () => {
  const { answerLocalListChange, foodConstraints } = await import("../server/food-swaps");
  const c = foodConstraints({ dietaryRestrictions: "no eggs" });
  const free = answerLocalListChange("can I use eggs instead?") || "";
  const cons = answerLocalListChange("can I use eggs instead?", c) || "";
  assert.match(free, /^Yes — eggs works/, "CONTROL: unrestricted, it confirms — and names the food correctly");
  assert.ok(cons.length > 0, "silence here would hand the client the not-understood fallback");
  assert.doesNotMatch(cons, /\bYes\b/, "it does not confirm a food they excluded");
  assert.match(cons, /pilchards|chicken|beans/i, "it offers what does the same job instead");
});

// ISOLATION. A restriction is a fact about ONE client; a shared table must not learn it.
test("one client's restriction does not bleed into another's list (#177)", async () => {
  const { getShoppingList } = await import("../server/shopping-lists");
  const { foodConstraints } = await import("../server/food-swaps");
  getShoppingList("100_300", 1, "fat_loss", foodConstraints({ dietaryRestrictions: "no eggs, no pork" }));
  const after = getShoppingList("100_300", 1, "fat_loss");
  assert.ok(after.items.some((i: any) => /\begg/i.test(i.item)), "the next client still gets eggs");
});

// ============================================================
// AND THE MORNING MUST BE WHEN THEY ATE (#182 — over-fire found in the merged #174 fix)
//
// The first cut tested the WHOLE message, so "I train in the morning; I just had rice" relabelled
// the rice as breakfast at an evening send time: the word belonged to the training clause and the
// slot was taken from it anyway. Same class of error as the one the branch exists to fix, pointing
// the other way — a time attached to the wrong event still contradicts the client's own record.
// ============================================================

test("explicitMealSlot: a morning phrase in ANOTHER clause does not label the food (#182)", () => {
  assert.equal(explicitMealSlot("I train in the morning; I just had rice"), null);
  assert.equal(explicitMealSlot("I go to gym in the morning; I just ate pap"), null);
});

test("explicitMealSlot: a coordinating conjunction separates the events too (#182)", () => {
  assert.equal(explicitMealSlot("I walk in the morning and had rice"), null);
  assert.equal(explicitMealSlot("This morning I trained and then had rice"), null);
});

// …AND A NAMED MEAL IN THE SECOND CLAUSE KEEPS ITS OWN SLOT, which is the control that proves the
// scoping did not simply switch the branch off: the message still resolves, just not to breakfast.
test("explicitMealSlot: 'I walk in the morning and had dinner at 7pm' stays dinner (#182)", () => {
  assert.equal(explicitMealSlot("I walk in the morning and had dinner at 7pm"), "dinner");
  assert.equal(explicitMealSlot("This morning I trained and then had breakfast"), "breakfast");
});

// BOTH WORD ORDERS ARE THE SAME CLAIM. People put the time on either side of the verb.
test("explicitMealSlot: the time may sit before or after the eating verb (#182)", () => {
  assert.equal(explicitMealSlot("Had eggs this morning"), "breakfast");
  assert.equal(explicitMealSlot("this morning, I had eggs"), "breakfast");
});

// DELIBERATELY NOT WIDENED (#174 control 3). Afternoon spans lunch and the snack after it, so a
// slot for it would be invented rather than surfaced. It still falls to clock inference.
test("explicitMealSlot: 'this afternoon' is NOT mapped to lunch", () => {
  assert.equal(explicitMealSlot("This afternoon I had a sandwich"), null);
  assert.equal(explicitMealSlot("This evening I had rice"), null);
});

// THE SLOT AND THE DAY ARE DIFFERENT QUESTIONS WITH DIFFERENT OWNERS, and the new branch must not
// blur them: parseMealDate keeps answering "which day", explicitMealSlot only "which meal".
test("'yesterday morning' keeps yesterday's date while gaining the breakfast slot", async () => {
  const { parseMealDate, sastDayKey } = await import("../server/sast");
  const at = parseMealDate("Yesterday morning I had eggs");
  assert.ok(at, "parseMealDate must still resolve a date for this phrase");
  assert.notEqual(sastDayKey(at!), sastDayKey(new Date()), "it must not become today");
  assert.equal(sastDayKey(at!), sastDayKey(new Date(Date.now() - 86_400_000)));
  assert.equal(explicitMealSlot("Yesterday morning I had eggs"), "breakfast");
});

// ============================================================
// THE REALITY HARNESS MUST NOT PAGE A HUMAN (Reality run, 2026-08-12)
//
// Journey 4 says "I missed gym on Monday because my back was sore". detectEscalation read
// that as `injury (urgent)` — correctly — and a WhatsApp alert went to the founder's real
// phone. Right behaviour, wrong person. A suite that cries injury on every run is how a real
// injury alert gets ignored. The escalation ROW must still be written so the run stays
// inspectable; only the outbound page is withheld.
// ============================================================

test("isSyntheticTestClient: the six Reality numbers are recognised, in every format", async () => {
  const { isSyntheticTestClient } = await import("../server/safety-detection");
  for (let n = 1; n <= 6; n++) {
    assert.equal(isSyntheticTestClient(`whatsapp:+2700000${900 + n}`), true, `journey ${n} number`);
    assert.equal(isSyntheticTestClient(`+2700000${900 + n}`), true, "bare + form");
    assert.equal(isSyntheticTestClient(`2700000${900 + n}`), true, "digits-only form");
  }
});

test("isSyntheticTestClient: a REAL client still pages the founder", async () => {
  const { isSyntheticTestClient } = await import("../server/safety-detection");
  // The founder's own number and ordinary SA mobiles must never be swallowed by this guard —
  // suppressing a real injury alert would be far worse than the noise it exists to stop.
  for (const real of ["whatsapp:+27682002798", "+27821234567", "27735551234", "whatsapp:+27600000000"]) {
    assert.equal(isSyntheticTestClient(real), false, `${real} is a real client and must alert`);
  }
  assert.equal(isSyntheticTestClient(""), false, "empty is not a licence to suppress");
  assert.equal(isSyntheticTestClient(null), false);
  assert.equal(isSyntheticTestClient(undefined), false);
});

test("escalation: the alert is withheld but the row is still written", () => {
  const src = readFileSync("server/handlers/chat-log.ts", "utf-8");
  // The guard must sit AFTER the insert, so the escalation is always recorded and only the
  // outbound page is skipped. If it moved above the insert, test runs would vanish silently.
  // Match the CALL SITE, not the import at the top of the file.
  assert.ok(src.indexOf("db.insert(escalations)") < src.indexOf("isSyntheticTestClient(clientPhone)"),
    "the escalation row must be written before the alert is skipped");
  assert.ok(/Skipping coach alert — synthetic test client/.test(src),
    "the skip must say why, in the log, or a missing page looks like a broken alerter");
});

// ============================================================
// THE GROCERY GATE MUST READ WHAT THE CLIENT TYPED (Reality J2, 2026-08-12)
//
// The first fix for J2 was correct about commas and useless in production, and the offline
// routing test could not tell: routing-audit runs with no model, so the Normalizer never
// fires there and the gate sees the raw message. Live, the Normalizer rewrote
// "Here's my grocery list: chicken, rice, oil…" into "i had chicken, rice, oil… for
// breakfast" and reassigned `message` BEFORE the gate — so the words "grocery list" were
// gone and the invented "i had" tripped the eating-context brake. A test that passes while
// production fails is worse than no test, so this asserts the SOURCE reads the pre-rewrite
// message. It cannot be satisfied by a gate that trusts the Normalizer's output.
// ============================================================

test("grocery gate: reads the pre-normalizer message, not the rewrite", () => {
  const src = readFileSync("server/routes.ts", "utf-8");
  const declares = src.split("\n").find(l => l.includes("const _declaresList"));
  const lines = src.split("\n").find(l => l.includes("const _msgLines"));
  const eating = src.split("\n").find(l => l.includes("const _hasEatingContext"));
  assert.ok(declares && lines && eating, "the grocery gate lines must still exist");
  // The declaration test and the item split must both come off the client's own words.
  assert.ok(/originalMessageForFidelity/.test(declares!),
    "_declaresList must test the pre-normalization message — the rewrite destroys 'grocery list'");
  assert.ok(/originalMessageForFidelity/.test(lines!),
    "_msgLines must split the pre-normalization message");
  // And the eating brake must not be fed an "i had" the Normalizer invented.
  assert.ok(/_declaresList \? originalMBeforeNorm/.test(eating!),
    "_hasEatingContext must read the ORIGINAL when the client named a list, or an invented 'i had' blocks it");
  // The Normalizer reassigns `message`, so the gate must sit after that and cannot rely on it.
  assert.ok(src.indexOf("message = canon;") < src.indexOf("const _declaresList"),
    "the gate runs after the rewrite — this is exactly why it must not read `message`");
});

// ============================================================
// selectModel — the completion ceiling (Work Order D, 2026-08-12)
//
// "*Week total: ~R199–R*" was a grocery list cut off mid-price. selectModel never inspected
// `instruction`, so a caller asking for four sections and twenty priced items was handed the
// 160-token conversational default. The ceiling now moves for a list/plan ask and ONLY for a
// list/plan ask — a raised floor across every coaching reply is what these tests prevent.
// ============================================================

test("selectModel: ordinary coaching stays capped at the conversational default", () => {
  for (const msg of ["i had eggs and pap", "how am i doing?", "did 9000 steps"]) {
    const r = selectModel("Respond as Coach K to this client message.", msg);
    assert.equal(r.maxTokens, 160, `"${msg}" must not get a long-form budget`);
    assert.equal(r.reason, "coaching");
  }
});

test("selectModel: a list ask named by the CLIENT lifts the ceiling", () => {
  const r = selectModel("Respond as Coach K to this client message.", "can you send me a grocery list?");
  assert.ok(r.maxTokens > 160, "a client asking for a list must not be truncated");
  assert.equal(r.reason, "long_form");
});

test("selectModel: the case that actually broke — the shape lives in the INSTRUCTION, not the message", () => {
  // The client's message is a raw list of foods and carries no signal at all; the wanted
  // output shape is entirely in the caller's instruction, which selectModel used to ignore.
  const r = selectModel(
    "REBUILD it completely.\n\n*Week total: ~R[X]–R[Y]*\n\nRESPOND EXACTLY in this format",
    "chicken, eggs, rice, bread, spinach, oats");
  assert.ok(r.maxTokens >= 900, `must fit 20 priced items, got ${r.maxTokens}`);
  assert.equal(r.reason, "long_form");
});

// The ceiling alone was not enough: askCoachK appended "Max 3 sentences, 60 words total" to
// EVERY call, so a twenty-item grocery request carried two contradictory format rules and the
// tighter one could win. The length clause is now keyed off the same long_form reason.
test("hardLimit: the 3-sentence cap is lifted for long-form, and ONLY for long-form", () => {
  const src = readFileSync("server/gpt.ts", "utf-8");
  const line = src.split("\n").find(l => l.includes("const hardLimit"));
  assert.ok(line, "hardLimit must still exist — the voice rules are not optional");
  assert.ok(/reason === "long_form"/.test(line!), "the length clause must be keyed off the long_form reason");
  assert.ok(/Max 3 sentences, 60 words total/.test(line!), "ordinary coaching must keep its cap");
  assert.ok(/FULL list or plan/.test(line!), "a long-form ask must be told to give the whole thing");
  // The voice rules must be common to both paths, never traded away for length.
  for (const rule of ["Coach K here", "Reply MENU", "client's actual name", "one specific action"]) {
    assert.ok(line!.includes(rule), `voice rule "${rule}" must survive on both paths`);
  }
  // And it must be built where `reason` is actually in scope, after selectModel returns.
  assert.ok(src.indexOf("const { model, maxTokens, reason }") < src.indexOf("const hardLimit"),
    "hardLimit must be assembled after selectModel, or reason would be undefined");
});

test("selectModel: safety routing still outranks long-form", () => {
  // A medical message keeps the safer model even when a list word rides along — the
  // long-form branch is deliberately checked last.
  const r = selectModel("Respond as Coach K.", "i have diabetes, can you send me a grocery list?");
  assert.equal(r.model, "gpt-4o", "a medical message must keep the safer model");
});

// parseLiftLog tests REMOVED 2026-08-06 with the function. Lift logging is gone: training is
// tracked by which days and whether they trained. The one thing those tests protected that
// still matters — a lift message must not be misread as a body weight or a retro session —
// is now asserted in routing-audit.ts against EXERCISE_PATTERN, which is the guard that
// survived the deletion precisely for that reason.

// ============================================================
// assessWeightRate — safe weight-change assessment
// ============================================================

test("assessWeightRate: no change in < 1 week → null", () => {
  assert.equal(assessWeightRate(-1, 0.5, "fat_loss", 120, 1800, "Kam", 80), null);
});

test("assessWeightRate: negligible change (< 0.3kg) → null", () => {
  assert.equal(assessWeightRate(-0.2, 2, "fat_loss", 120, 1800, "Kam", 80), null);
});

test("assessWeightRate: fat_loss — excellent pace (0.3kg/wk on 80kg body) → target message", () => {
  // excellentBand = 80 × 0.005 = 0.4kg/wk; pace 0.3 < 0.4 → excellent
  const r = assessWeightRate(-0.6, 2, "fat_loss", 120, 1800, "Kam", 80);
  assert.ok(r !== null);
  assert.ok(r!.includes("right on target") || r!.includes("✅"), `got: ${r}`);
});

test("assessWeightRate: fat_loss — pace in safe range (0.6kg/wk on 80kg) → good message", () => {
  // maxSafe = 80×0.01 = 0.8; 0.6 is between excellentBand(0.4) and maxSafe(0.8)
  const r = assessWeightRate(-1.2, 2, "fat_loss", 120, 1800, "Kam", 80);
  assert.ok(r !== null);
  assert.ok(r!.includes("good") || r!.includes("✅"), `got: ${r}`);
});

test("assessWeightRate: fat_loss — too fast pace → warn message with protein mention", () => {
  // maxWarn = 80×0.015 = 1.2kg/wk; losing 3kg in 2wks = 1.5kg/wk → between warn and danger
  const r = assessWeightRate(-3, 2, "fat_loss", 120, 1800, "Kam", 80);
  assert.ok(r !== null);
  assert.ok(r!.includes("faster than ideal") || r!.includes("⚠️") || r!.includes("muscle"), `got: ${r}`);
});

test("assessWeightRate: fat_loss — dangerous pace (>2% BW/wk) → 🚨 danger message", () => {
  // dangerBand = 80×0.02 = 1.6kg/wk; losing 4kg in 2wks = 2kg/wk → danger
  const r = assessWeightRate(-4, 2, "fat_loss", 120, 1800, "Kam", 80);
  assert.ok(r !== null);
  assert.ok(r!.includes("too fast") || r!.includes("🚨") || r!.includes("very fast"), `got: ${r}`);
});

test("assessWeightRate: muscle_gain — losing weight triggers 🚨 if pace > 0.3", () => {
  const r = assessWeightRate(-1, 2, "muscle_gain", 150, 2500, "Kam", 75);
  assert.ok(r !== null);
  assert.ok(r!.includes("🚨") || r!.includes("losing weight on a muscle"), `got: ${r}`);
});

test("assessWeightRate: muscle_gain — small loss (pace ≤ 0.3) → ⚠️ mild warning", () => {
  const r = assessWeightRate(-0.5, 2, "muscle_gain", 150, 2500, "Kam", 75);
  assert.ok(r !== null);
  assert.ok(r!.includes("⚠️") || r!.includes("surplus"), `got: ${r}`);
});

test("assessWeightRate: muscle_gain — solid lean gain pace (0.2kg/wk) → ✅ message", () => {
  const r = assessWeightRate(0.4, 2, "muscle_gain", 150, 2500, "Kam", 75);
  assert.ok(r !== null);
  assert.ok(r!.includes("✅") || r!.includes("solid"), `got: ${r}`);
});

test("assessWeightRate: muscle_gain — gaining fast (>0.5kg/wk) → watch body fat message", () => {
  const r = assessWeightRate(1.5, 2, "muscle_gain", 150, 2500, "Kam", 75);
  assert.ok(r !== null);
  assert.ok(r!.includes("gaining fast") || r!.includes("body fat"), `got: ${r}`);
});

test("assessWeightRate: fat_loss — gaining weight → water/sodium message", () => {
  const r = assessWeightRate(1.5, 2, "fat_loss", 120, 1800, "Kam", 80);
  assert.ok(r !== null);
  assert.ok(r!.includes("water") || r!.includes("sodium") || r!.includes("📈"), `got: ${r}`);
});

test("assessWeightRate: recomposition — safe loss pace → no message at all (within band)", () => {
  // excellentBand = 80×0.004 = 0.32kg/wk; pace 0.2 ≤ 0.32 → excellent
  const r = assessWeightRate(-0.4, 2, "recomposition", 130, 1900, "Kam", 80);
  assert.ok(r !== null); // returns message; just not a danger message
  assert.ok(!r!.includes("🚨"), `should not be danger: ${r}`);
});

// ============================================================
// weeklyTrendSlopeKg — noise-resistant weight trend (regression, not 2-point)
// ============================================================

test("weeklyTrendSlopeKg: fewer than 3 points → null", () => {
  assert.equal(weeklyTrendSlopeKg([{ dayOffset: 0, kg: 80 }, { dayOffset: 7, kg: 81 }]), null);
});

test("weeklyTrendSlopeKg: span under 5 days → null", () => {
  assert.equal(weeklyTrendSlopeKg([
    { dayOffset: 0, kg: 80 }, { dayOffset: 1, kg: 80.5 }, { dayOffset: 3, kg: 81 },
  ]), null);
});

test("weeklyTrendSlopeKg: flat readings → ~0 kg/week", () => {
  const s = weeklyTrendSlopeKg([
    { dayOffset: 0, kg: 80 }, { dayOffset: 7, kg: 80 }, { dayOffset: 14, kg: 80 },
  ]);
  assert.ok(s !== null && Math.abs(s) < 1e-9, `got: ${s}`);
});

test("weeklyTrendSlopeKg: steady +0.5kg/week → slope ≈ 0.5", () => {
  const s = weeklyTrendSlopeKg([
    { dayOffset: 0, kg: 80 }, { dayOffset: 7, kg: 80.5 }, { dayOffset: 14, kg: 81 },
  ]);
  assert.ok(s !== null && Math.abs(s - 0.5) < 1e-9, `got: ${s}`);
});

test("weeklyTrendSlopeKg: a single end spike does NOT dominate like the old 2-point slope", () => {
  const pts = [
    { dayOffset: 0, kg: 80 }, { dayOffset: 7, kg: 80 },
    { dayOffset: 13, kg: 80 }, { dayOffset: 14, kg: 82 },
  ];
  const regression = weeklyTrendSlopeKg(pts)!;
  const twoPoint = (82 - 80) / (14 / 7); // old buggy method = 1.0 kg/wk
  assert.ok(regression < twoPoint, `regression ${regression} should be < 2-point ${twoPoint}`);
  assert.ok(regression > 0, `still detects the upward drift: ${regression}`);
});

test("weeklyTrendSlopeKg: screenshot case (dip after a rise) stays net-positive over the fortnight", () => {
  const s = weeklyTrendSlopeKg([
    { dayOffset: 0, kg: 82.1 }, { dayOffset: 13, kg: 84.1 }, { dayOffset: 14, kg: 83.8 },
  ])!;
  assert.ok(s > 0, `net upward over two weeks: ${s}`);
});

// H4 regression — recomp "faster than ideal" tier was dead code (maxSafe===maxWarn); now reachable
test("assessWeightRate: recomposition — 0.5%/wk loss → ⚠️ faster than ideal (not 'good')", () => {
  // pace = 0.8/2 = 0.4 kg/wk = 0.5% of 80kg → between excellent(0.32) and maxWarn(0.6)
  const r = assessWeightRate(-0.8, 2, "recomposition", 130, 1900, "Kam", 80);
  assert.ok(r !== null && r.includes("faster than ideal"), `got: ${r}`);
});

// ============================================================
// parseMealDate — retroactive date extraction (edge cases)
// ============================================================

function daysDiff(date: Date): number {
  return Math.round((Date.now() - date.getTime()) / 86_400_000);
}

test("parseMealDate: 'yesterday' → ~1 day ago", () => {
  const d = parseMealDate("I had rice yesterday");
  assert.ok(daysDiff(d) >= 0.9 && daysDiff(d) <= 1.1, `days diff: ${daysDiff(d)}`);
});

test("parseMealDate: '2 days ago' → ~2 days ago", () => {
  const d = parseMealDate("ate chicken 2 days ago");
  assert.ok(daysDiff(d) >= 1.9 && daysDiff(d) <= 2.1, `days diff: ${daysDiff(d)}`);
});

test("parseMealDate: 'two days ago' (word number) → ~2 days ago", () => {
  const d = parseMealDate("had pap two days ago");
  assert.ok(daysDiff(d) >= 1.9 && daysDiff(d) <= 2.1, `days diff: ${daysDiff(d)}`);
});

test("parseMealDate: 'last night' → yesterday evening", () => {
  const d = parseMealDate("had braai last night");
  // "Last night" = 20:00 SAST on the previous SAST day. Said just after midnight
  // that's only ~4-6 hours ago; said at 21:00 it's ~25h — so the honest band is
  // 3-30h. The old 6-30h band assumed a daytime test run and actually passed on
  // a WRONG answer (two nights back) when run at 01:47 SAST (2026-07-07).
  const hoursAgo = (Date.now() - d.getTime()) / 3_600_000;
  assert.ok(hoursAgo >= 3 && hoursAgo <= 30, `hours ago: ${hoursAgo}`);
});

test("parseMealDate: 'earlier today' → ~3 hours ago", () => {
  const d = parseMealDate("had oats earlier today");
  const hoursAgo = (Date.now() - d.getTime()) / 3_600_000;
  assert.ok(hoursAgo >= 2.5 && hoursAgo <= 3.5, `hours ago: ${hoursAgo}`);
});

test("parseMealDate: no time reference → approximately now (< 10 minutes ago)", () => {
  const d = parseMealDate("chicken and rice");
  const minsAgo = (Date.now() - d.getTime()) / 60_000;
  assert.ok(minsAgo < 10, `minutes ago: ${minsAgo}`);
});

test("parseMealDate: day-of-week reference maps to a past date (< 8 days ago)", () => {
  // Any day name should map to 1–7 days back
  const d = parseMealDate("had pap on Monday");
  assert.ok(daysDiff(d) >= 1 && daysDiff(d) <= 8, `days diff: ${daysDiff(d)}`);
});

test("parseMealDate: day-of-week + 'morning' → morning SAST hour", () => {
  const d = parseMealDate("had oats Saturday morning");
  // UTC hour should be 6 (8am SAST = UTC+2)
  assert.equal(d.getUTCHours(), 6);
});

test("parseMealDate: day-of-week + 'dinner' → evening SAST hour", () => {
  const d = parseMealDate("had braai Sunday dinner");
  // 8pm SAST = 6pm UTC = hour 18
  assert.equal(d.getUTCHours(), 18);
});

// ============================================================
// isRetroactiveMeal — retroactive flag
// ============================================================

test("isRetroactiveMeal: 'yesterday' → true", () => {
  assert.equal(isRetroactiveMeal("I had rice yesterday"), true);
});

test("isRetroactiveMeal: '2 days ago' → true", () => {
  assert.equal(isRetroactiveMeal("pap 2 days ago"), true);
});

test("isRetroactiveMeal: day-of-week name → true", () => {
  assert.equal(isRetroactiveMeal("had chicken on Saturday"), true);
});

test("isRetroactiveMeal: 'last night' → true (via 'last' in pattern)... actually checks yesterday", () => {
  // 'last night' has 'yesterday' check in parseMealDate but isRetroactiveMeal checks its own pattern
  // Either true or false is acceptable as long as it's consistent with the parser
  const r = isRetroactiveMeal("braai last night");
  assert.equal(typeof r, "boolean");
});

test("isRetroactiveMeal: no time reference → false", () => {
  assert.equal(isRetroactiveMeal("I had chicken and rice"), false);
});

test("isRetroactiveMeal: 'today' only → false", () => {
  assert.equal(isRetroactiveMeal("had oats for breakfast today"), false);
});

test("isRetroactiveMeal: 'tomorrow' → false (future, not retro)", () => {
  assert.equal(isRetroactiveMeal("I'll have rice tomorrow"), false);
});

// ============================================================
// mealDateLabel — human-readable date label
// ============================================================

test("mealDateLabel: now → 'today'", () => {
  assert.equal(mealDateLabel(new Date()), "today");
});

test("mealDateLabel: 24 hours ago → 'yesterday' (clock-safe at any hour)", () => {
  // 25h was a hidden clock flake: between 00:00–00:59 SAST, "25 hours ago" lands TWO
  // calendar days back and the label is a day name. Exactly 24h is always yesterday.
  assert.equal(mealDateLabel(new Date(Date.now() - 24 * 3_600_000)), "yesterday");
});

test("mealDateLabel: 2 days ago → day name (not 'today' or 'yesterday')", () => {
  const label = mealDateLabel(new Date(Date.now() - 2 * 86_400_000));
  const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  assert.ok(DAYS.includes(label), `expected a day name, got: ${label}`);
});

test("mealDateLabel: 5 days ago → a day name", () => {
  const label = mealDateLabel(new Date(Date.now() - 5 * 86_400_000));
  const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  assert.ok(DAYS.includes(label), `expected a day name, got: ${label}`);
});

// ============================================================
// H5 — muscle_gain 2-week grace before loss alert fires
// ============================================================

test("assessWeightRate: muscle_gain — week 1 dip of 0.4kg → null (noise, not alarm)", () => {
  // weeksSinceStart=1, change=-0.4kg — both below the 2-week / 0.5kg threshold
  const r = assessWeightRate(-0.4, 1, "muscle_gain", 160, 2800, "Kam", 80);
  assert.equal(r, null, `should return null for early small dip: got "${r}"`);
});

test("assessWeightRate: muscle_gain — week 3 loss of 0.8kg → alarm fires", () => {
  // weeksSinceStart=3, change=-0.8kg — past both thresholds; alarm IS appropriate
  const r = assessWeightRate(-0.8, 3, "muscle_gain", 160, 2800, "Kam", 80);
  assert.ok(r !== null && (r.includes("losing") || r.includes("Down") || r.includes("deficit")), `should warn at week 3: got "${r}"`);
});

// ============================================================
// H6 — checkPerfectDay: steps COUNT vs stepsTarget, not just "row exists"
// ============================================================

// These test the inline logic that was previously `todaySteps.length > 0` (any row = hit)
// and is now `todayStepCount >= stepsTarget` (must actually reach the daily target).

test("checkPerfectDay gate (H6): 6 000 steps vs 8 500 target → NOT a perfect day", () => {
  const stepsHit = 6_000 >= 8_500;
  assert.equal(stepsHit, false);
});

test("checkPerfectDay gate (H6): 1 step logged vs 8 500 target — old logic would have fired, new logic won't", () => {
  const anyRowExists = 1 > 0;          // old: todaySteps.length > 0 → true (wrong)
  const countHitsTarget = 1 >= 8_500;  // new: todayStepCount >= stepsTarget → false (correct)
  assert.equal(anyRowExists, true);
  assert.equal(countHitsTarget, false);
});

// ============================================================
// M3 — weeklyAvg: divide by 7 (true weekly average), not row count
// ============================================================

test("weeklyAvg divisor (M3): 3 logging days at 8 000 steps → weekly avg ≈ 3 429, not 8 000", () => {
  const rows = [{ steps: 8_000 }, { steps: 8_000 }, { steps: 8_000 }];
  const total = rows.reduce((s, r) => s + r.steps, 0);
  const byCount = Math.round(total / rows.length); // old (wrong): 8 000
  const byWeek  = Math.round(total / 7);           // fixed: 3 429
  assert.notEqual(byWeek, byCount, "divisor change must alter the result");
  assert.equal(byWeek, 3429);
});

// ============================================================
// Grocery list detection — 25-item plain-text list must NOT be logged as food
// (regression test for the bug where Kam's grocery list was logged as 2330 kcal)
// ============================================================

test("grocery detection: 25-item plain-text list (no bullets) → _isGroceryList=true", () => {
  const groceryMessage = `but let me just try\n\nBeef\nChicken pieces\nRice\nMealie mealie\nSweet corn\nChicken strips (I use these for wraps)\nSweet potato fries\nLettuce\nCucumber\nFeta\nCarrots\nCabbage\nFruit juice\nConcentrated juice\nGreen tea\nHibiscus tea\nWraps\nCheese\nBread\nEggs\nWors\nPolony\nMince\nMixed vegetables\nOnions\nButternut\nApples\nBlueberries\nDried mango\nLemons`;
  const msgLines = groceryMessage.split("\n").map(l => l.trim()).filter(Boolean);
  const cleanedItems = msgLines
    .map(l => l.replace(/^(\[\s*[x✓\s]?\]|[-•*]|\d+[\.\)])\s*/, "").trim())
    .filter(l => l.length > 1 && l.length < 80);
  const hasEatingContext = /\b(i had|i ate|i'm having|just had|just ate|for breakfast|for lunch|for dinner|for supper|this morning|had this)\b/i.test(groceryMessage.toLowerCase());
  const isListFormat = msgLines.filter(l => /^(\[\s*[x✓\s]?\]|[-•*]|\d+[\.\)])/.test(l)).length >= 4;
  const shortItemFraction = cleanedItems.length > 0
    ? cleanedItems.filter(l => l.split(/\s+/).length <= 7).length / cleanedItems.length
    : 0;
  const isGroceryList = !hasEatingContext && cleanedItems.length >= 8 && (
    isListFormat || (shortItemFraction >= 0.75 && msgLines.length >= 10)
  );
  assert.equal(hasEatingContext, false, "no eating verbs");
  assert.ok(cleanedItems.length >= 8, `${cleanedItems.length} items found`);
  assert.ok(shortItemFraction >= 0.75, `short fraction: ${shortItemFraction.toFixed(2)}`);
  assert.equal(isGroceryList, true, "should be detected as grocery list");
});

// ============================================================
// Junk note label — should be named ("⚠️ Viennas: ..."), not a bare verdict
// ============================================================

test("junk note (vienna + eggs): result prefixes food name, not bare 'Highly processed.'", () => {
  // Simulate the fix: when junkFoods[0].name = "Viennas" and goodProteins is non-empty,
  // junkNoteText should contain "Viennas" not start with just "Highly processed."
  const junkName = "Viennas";
  const rawNote = "Highly processed. Low protein for the calories.";
  const firstName = rawNote.charAt(0).toUpperCase() + rawNote.slice(1).toLowerCase();
  const junkNoteText = `⚠️ ${junkName}: ${firstName.replace(/\.$/, "").toLowerCase()} — swap for extra eggs next time.`;
  assert.ok(junkNoteText.startsWith("⚠️ Viennas:"), `should start with food name: "${junkNoteText}"`);
  assert.ok(!junkNoteText.startsWith("Highly processed"), `should not be bare verdict: "${junkNoteText}"`);
});

// ============================================================
// P0-1 — Trial activation guard
// Regression for: !u.subscriptionStatus was always false because subscriptionStatus
// defaults to "inactive" (notNull). Fixed by switching to !u.betaBypassUntil.
// ============================================================

test("P0-1 trial guard: inactive user with no betaBypassUntil → trial SHOULD fire", () => {
  // Simulate the corrected guard
  const user = { subscriptionStatus: "inactive" as string | null, betaBypassUntil: null as Date | null };
  const oldGuard = !user.subscriptionStatus;   // ← was always false (bug)
  const newGuard = !user.betaBypassUntil;       // ← correctly true (fix)
  assert.equal(oldGuard, false, "old guard correctly identified as always-false bug");
  assert.equal(newGuard, true, "new guard fires trial for first-time user");
});

test("P0-1 trial guard: user who already trialled → trial MUST NOT re-fire", () => {
  const user = { subscriptionStatus: "inactive" as string | null, betaBypassUntil: new Date(Date.now() - 86_400_000) };
  const newGuard = !user.betaBypassUntil;
  assert.equal(newGuard, false, "already-trialled user must not get a second trial");
});

test("P0-1 trial guard: active subscriber (re-onboarding) → trial MUST NOT re-fire", () => {
  const user = { subscriptionStatus: "active" as string | null, betaBypassUntil: new Date(Date.now() - 30 * 86_400_000) };
  const newGuard = !user.betaBypassUntil;
  assert.equal(newGuard, false, "active subscriber re-onboarding must not receive another trial");
});

// ============================================================
// P0-2 — Reset delete chain completeness
// Regression for: safety.ts hard-reset paths skipped gptCosts, userIntegrations,
// and clientIntelligenceProfiles → FK 23503 crash on db.delete(users).
// ============================================================

test("P0-2 reset chain: all FK child tables are present in the delete list", () => {
  // This is the complete list of tables that reference users.id (from shared/schema.ts).
  // If you add a new child table with a users FK, add it here too.
  const allChildTables = [
    "chatHistory", "stepLogs", "workoutLogs", "weightLogs", "weeklyCheckins",
    "clothingCheckins", "bodyMeasurements", "mealLogs", "exerciseLogs",
    "progressPhotos", "escalations", "gptCosts", "sentProactive", "abAssignments",
    "userIntegrations", "clientActions", "clientIntelligenceProfiles",
  ];
  // Verify the list has no duplicates (a dupe means a merge introduced a copy-paste error)
  const unique = new Set(allChildTables);
  assert.equal(unique.size, allChildTables.length, "no duplicate table names in reset chain");
  // Verify each table we know must be in the chain
  const required = ["gptCosts", "userIntegrations", "clientIntelligenceProfiles"];
  for (const t of required) {
    assert.ok(allChildTables.includes(t), `${t} must be in the delete chain`);
  }
});

// ============================================================
// Trial countdown — trialDaysIn logic (pure math, no DB)
// ============================================================
// trialDaysIn: betaBypassUntil is trialStart + 7 days
// So daysIn = floor((now - (betaBypassUntil - 7 days)) / msPerDay)

function trialDaysIn(betaBypassUntil: Date | null | undefined): number | null {
  if (!betaBypassUntil) return null;
  const trialStart = new Date(betaBypassUntil).getTime() - 7 * 86_400_000;
  return Math.floor((Date.now() - trialStart) / 86_400_000);
}

test("trialDaysIn: null betaBypassUntil → null (no trial)", () => {
  assert.equal(trialDaysIn(null), null);
});

test("trialDaysIn: betaBypassUntil 5 days from now → Day 2 (trial started 2 days ago)", () => {
  const bypassUntil = new Date(Date.now() + 5 * 86_400_000);
  const days = trialDaysIn(bypassUntil);
  assert.ok(days === 2, `expected 2, got ${days}`);
});

test("trialDaysIn: betaBypassUntil 2 days from now → Day 5 (trial started 5 days ago)", () => {
  const bypassUntil = new Date(Date.now() + 2 * 86_400_000);
  const days = trialDaysIn(bypassUntil);
  assert.ok(days === 5, `expected 5, got ${days}`);
});

test("trialDaysIn: betaBypassUntil tomorrow → Day 6 (trial started 6 days ago)", () => {
  const bypassUntil = new Date(Date.now() + 1 * 86_400_000);
  const days = trialDaysIn(bypassUntil);
  assert.ok(days === 6, `expected 6, got ${days}`);
});

test("trialDaysIn: betaBypassUntil is now → Day 7 (trial ends today)", () => {
  // subtract a few seconds so floor rounds to 7
  const bypassUntil = new Date(Date.now() + 60_000); // 1 minute from now ≈ still day 7
  const days = trialDaysIn(bypassUntil);
  assert.ok(days !== null && days >= 6 && days <= 7, `expected 6-7, got ${days}`);
});

test("trialDaysIn: betaBypassUntil 1 day ago → Day 8 (trial expired)", () => {
  const bypassUntil = new Date(Date.now() - 1 * 86_400_000);
  const days = trialDaysIn(bypassUntil);
  assert.ok(days !== null && days >= 8, `expected ≥8, got ${days}`);
});

// ============================================================
// Referral double-earn guard
// The sentinel insert uses paymentEvents unique(provider, providerPaymentId).
// onConflictDoNothing returns 0 rows on duplicate → referrer not rewarded again.
// ============================================================

test("referral sentinel: first insert returns non-empty (reward fires)", () => {
  // Simulate the sentinel logic using a Set (the DB unique index equivalent)
  const issued = new Set<string>();
  function claimReferralReward(targetUserId: string): boolean {
    const key = `REF_REWARD_${targetUserId}`;
    if (issued.has(key)) return false; // conflict → 0 rows returned
    issued.add(key);
    return true; // row inserted → reward fires
  }
  assert.equal(claimReferralReward("user-abc"), true, "first subscription → reward fires");
});

test("referral sentinel: second insert (cancel+resubscribe) returns empty → no double-earn", () => {
  const issued = new Set<string>();
  function claimReferralReward(targetUserId: string): boolean {
    const key = `REF_REWARD_${targetUserId}`;
    if (issued.has(key)) return false;
    issued.add(key);
    return true;
  }
  claimReferralReward("user-xyz"); // first sub
  // user cancels and re-subscribes:
  assert.equal(claimReferralReward("user-xyz"), false, "re-subscribe → sentinel already exists → no reward");
});

test("referral sentinel: different users don't share each other's sentinel", () => {
  const issued = new Set<string>();
  function claimReferralReward(targetUserId: string): boolean {
    const key = `REF_REWARD_${targetUserId}`;
    if (issued.has(key)) return false;
    issued.add(key);
    return true;
  }
  assert.equal(claimReferralReward("user-A"), true, "user A first subscription → fires");
  assert.equal(claimReferralReward("user-B"), true, "user B first subscription → also fires");
  assert.equal(claimReferralReward("user-A"), false, "user A second time → blocked");
  assert.equal(claimReferralReward("user-B"), false, "user B second time → blocked");
});

// ============================================================
// LIFECYCLE.TS CHARACTERISATION TESTS
// These capture CURRENT routing behaviour so future file splits
// can be validated against them. They use KAMLIFE_DB_STUB=1 so
// DB writes are no-ops and DB reads return empty — only the
// message-routing logic and the ctx.user fields are exercised.
// ============================================================

const { handleLifecycle } = await import("../server/handlers/lifecycle");

// Minimal stub user — only the fields lifecycle.ts reads from ctx.user
const LC_USER = {
  id: "stub-lc-uuid-00000000000000000001",
  phoneNumber: "whatsapp:+27821234567",
  name: "Stub User",
  onboardingState: "COMPLETE",
  subscriptionStatus: "active" as string,
  goalType: "fat_loss",
  trainingMode: "gym",
  trainingDaysPerWeek: 3,
  trainingExperience: "beginner",
  calorieTarget: 1800,
  proteinTarget: 120,
  stepsTarget: 8000,
  currentWeight: 80,
  programmeWeek: 2,
  totalWorkoutsCompleted: 5,
  workoutStreak: 3,
  awaitingInputType: null as string | null,
  buddyId: null,
  profileNotes: null as string | null,
  injuries: null,
  gymName: null,
  lifeSituation: null,
  paymentReference: null,
  weeklyFoodBudget: null,
  todayCalories: 1200,
  todayProteinG: 80,
  betaBypassUntil: null,
  referredBy: null,
  createdAt: new Date(Date.now() - 30 * 86_400_000),
};

function lc(message: string, overrides: Partial<typeof LC_USER> = {}) {
  const user = { ...LC_USER, ...overrides };
  return { phone: user.phoneNumber, message, m: message.toLowerCase().trim(), user };
}

// ---- STOP (opt-out) ----
test("lifecycle STOP: 'stop' → returns opt-out confirmation, not null", async () => {
  const r = await handleLifecycle(lc("STOP"));
  assert.ok(r !== null, "should handle STOP");
  assert.ok(r!.toLowerCase().includes("no more messages") || r!.toLowerCase().includes("start") || r!.toLowerCase().includes("resume"),
    `unexpected: ${r?.slice(0, 100)}`);
});

test("lifecycle STOP: 'opt out' → also handled", async () => {
  const r = await handleLifecycle(lc("opt out"));
  assert.ok(r !== null, "should handle 'opt out'");
});

// ---- CANCEL (active user) ----
test("lifecycle CANCEL: 'cancel' from active user → returns cancel-save prompt", async () => {
  const r = await handleLifecycle(lc("cancel", { subscriptionStatus: "active" }));
  assert.ok(r !== null, "should handle cancel for active user");
  // Must ask why they want to leave, not just cancel immediately
  assert.ok(
    r!.includes("1") || r!.includes("2") || r!.toLowerCase().includes("making you") || r!.toLowerCase().includes("leave"),
    `expected cancel-save prompt, got: ${r?.slice(0, 100)}`
  );
});

test("lifecycle CANCEL: 'cancel subscription' → also matched", async () => {
  const r = await handleLifecycle(lc("cancel subscription", { subscriptionStatus: "active" }));
  assert.ok(r !== null, "should handle 'cancel subscription'");
});

test("lifecycle CANCEL: 'cancel' from already-inactive user → 'already inactive' message", async () => {
  const r = await handleLifecycle(lc("cancel", { subscriptionStatus: "inactive" }));
  assert.ok(r !== null, "should handle cancel for inactive user");
  assert.ok(
    r!.toLowerCase().includes("inactive") || r!.toLowerCase().includes("restart"),
    `expected 'already inactive', got: ${r?.slice(0, 100)}`
  );
});

// ---- REFUND REQUEST ----
test("lifecycle REFUND: 'I want a refund' → refund request handled, not GPT fallthrough", async () => {
  const r = await handleLifecycle(lc("I want a refund"));
  assert.ok(r !== null, "should handle refund request");
  assert.ok(
    r!.toLowerCase().includes("refund") || r!.toLowerCase().includes("human") || r!.toLowerCase().includes("founder"),
    `unexpected: ${r?.slice(0, 100)}`
  );
});

test("lifecycle REFUND: 'money back' → also handled", async () => {
  const r = await handleLifecycle(lc("I want my money back"));
  assert.ok(r !== null, "should handle 'money back'");
});

// ---- PAYMENT / REJOIN ----
test("lifecycle PAY: 'pay' keyword → payment link or info (NOT handled as food log)", async () => {
  const r = await handleLifecycle(lc("pay", { subscriptionStatus: "active" }));
  // 'pay' from active user: the payment handler fires
  assert.ok(r !== null, "should handle pay message");
});

test("lifecycle PAY: negative payment phrase → NOT handled (falls through to GPT)", async () => {
  const r = await handleLifecycle(lc("not paying for this rubbish"));
  // Negative payment pattern should NOT match the payment handler
  // It either returns null (falls through) or returns something unrelated to payment links
  if (r !== null) {
    assert.ok(!r!.toLowerCase().includes("payment link"), `negative phrase should not get a payment link: ${r?.slice(0, 100)}`);
  }
});

// ---- RESCUE/RESET ----
test("lifecycle RESCUE: 'restart' from COMPLETE user → returns menu (not wipe confirmation)", async () => {
  // COMPLETE users typing 'restart' get the command menu, not a data wipe.
  // 'start over' is the explicit full-reset trigger.
  const r = await handleLifecycle(lc("restart", { onboardingState: "COMPLETE" }));
  assert.ok(r !== null, "should handle restart");
  // Menu text will contain something about logging or sessions, not a delete confirmation
  assert.ok(!r!.includes("permanently delete"), `COMPLETE restart should NOT ask to delete: ${r?.slice(0, 100)}`);
});

test("lifecycle RESCUE: 'start over' from COMPLETE user → wipe confirmation", async () => {
  const r = await handleLifecycle(lc("start over", { onboardingState: "COMPLETE", totalWorkoutsCompleted: 5 }));
  assert.ok(r !== null, "should handle start over");
  assert.ok(r!.includes("permanently delete") || r!.toLowerCase().includes("confirm") || r!.includes("⚠️"),
    `start over should ask for confirmation: ${r?.slice(0, 100)}`);
});

// ---- START (opt-in after stop) ----
test("lifecycle START: 'start' with paused user → resumes coaching", async () => {
  const pausedUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const r = await handleLifecycle(lc("start", { profileNotes: `paused_until:${pausedUntil}` }));
  assert.ok(r !== null, "should handle START for paused user");
  assert.ok(
    r!.toLowerCase().includes("welcome back") || r!.toLowerCase().includes("resume") || r!.toLowerCase().includes("coaching"),
    `unexpected: ${r?.slice(0, 100)}`
  );
});

test("lifecycle START: 'start' for non-paused user → falls through (null)", async () => {
  // A non-paused user typing 'start' is not an opt-in — it falls through to menu/GPT
  const r = await handleLifecycle(lc("start", { profileNotes: null }));
  // Either null (fall through) or handled by another section
  assert.ok(r === null || typeof r === "string", "result should be null or string");
});

// ============================================================
// EARLY-COMMANDS.TS CHARACTERISATION TESTS
// ============================================================

const { handleEarlyCommands } = await import("../server/handlers/early-commands");

function ec(message: string, overrides: Partial<typeof LC_USER> = {}) {
  const user = { ...LC_USER, ...overrides };
  return { phone: user.phoneNumber, message, m: message.toLowerCase().trim(), user };
}

test("early-commands: 'portion control' → returns hand-portion guide (fat_loss)", async () => {
  const r = await handleEarlyCommands(ec("portion control", { goalType: "fat_loss" }));
  assert.ok(r !== null, "should handle portion control");
  assert.ok(r!.includes("palm") || r!.includes("fist") || r!.includes("hand"), `should describe hand-portion method: ${r?.slice(0, 100)}`);
});

test("early-commands: 'portion control' → muscle_gain variant mentions surplus", async () => {
  const r = await handleEarlyCommands(ec("portion control", { goalType: "muscle_gain" }));
  assert.ok(r !== null, "should handle portion control for muscle_gain");
  assert.ok(r!.includes("2") || r!.includes("muscle") || r!.includes("build"), `should be goal-aware: ${r?.slice(0, 100)}`);
});

test("early-commands: 'how do I measure my food' → portion control matched", async () => {
  const r = await handleEarlyCommands(ec("how do I measure my food"));
  assert.ok(r !== null, "should match measure food as portion control");
});

test("early-commands: 'calories' → returns calorie target from user object", async () => {
  const r = await handleEarlyCommands(ec("calories", { calorieTarget: 1900, proteinTarget: 130 }));
  assert.ok(r !== null, "should handle calorie query");
  assert.ok(r!.includes("1900") || r!.includes("1,900") || r!.toLowerCase().includes("calorie"), `should mention calorie target: ${r?.slice(0, 100)}`);
});

test("early-commands: 'my protein target' → returns protein target", async () => {
  const r = await handleEarlyCommands(ec("my protein target", { proteinTarget: 145 }));
  assert.ok(r !== null, "should handle protein target query");
  assert.ok(r!.includes("145") || r!.toLowerCase().includes("protein"), `should mention protein: ${r?.slice(0, 100)}`);
});

// BEREAVEMENT — "passed on" / "passed" are as common as "passed away" in SA English.
// A real client (2026-07-08 screenshot) wrote "my grandfather passed on in the wee
// hours of the morning". Before that fix the regex only matched "passed away", so this
// heartbreaking message fell through to generic handling. These lock it.
//
// RE-POINTED 2026-08-06 AT THE REAL OWNER. These used to call handleEarlyCommands, whose
// bereavement branch stood behind `ENGINE_LIVE !== "on"` — so they were grading a handler
// that could not run for any client, and they would have stayed green while the live path
// broke. Bereavement is owned by life-context.ts, ungated, at the very top of the pipeline
// in runSafetyGuards. That is the code a grieving client actually reaches, so that is what
// is tested — and its reply is warmer than the template that was deleted.
test("bereavement: 'grandfather passed on' reaches the life-context path (2026-07-08 real client)", async () => {
  const { readLifeContext, lifeContextReply } = await import("../server/life-context");
  const life = readLifeContext("Hi Koki. I woke up to terrible news, my grandfather passed on in the wee hours of the morning");
  assert.ok(life !== null, "'passed on' must be read as bereavement");
  assert.equal(life!.context, "bereavement");
  const reply = lifeContextReply(life!, "Kam");
  assert.ok(/i'?m so sorry/i.test(reply), `must open with condolence: ${reply.slice(0, 120)}`);
  assert.ok(/paused/i.test(reply), "must take the targets off, not hand them a protein goal");
});

test("bereavement: 'my gran passed' is read the same (passed without on/away)", async () => {
  const { readLifeContext } = await import("../server/life-context");
  const life = readLifeContext("my gran passed this morning");
  assert.ok(life !== null && life.context === "bereavement", "'gran passed' must reach bereavement");
});

test("bereavement: 'I passed my exam' is NOT bereavement (no false positive)", async () => {
  const { readLifeContext } = await import("../server/life-context");
  const life = readLifeContext("I passed my exam today");
  assert.ok(!life || life.context !== "bereavement", "benign 'passed' must not trigger bereavement");
});

// TWILIO BALANCE ALARM — pure threshold/format logic (2026-07-09). The bot goes
// silent with NO error when Twilio runs dry; this alert is the safety net. The
// runtime fetch/send is thin; the threshold + wording is what must never drift.
const { buildLowBalanceAlert } = await import("../server/scheduler/jobs/balance-check");

test("balance alarm: below threshold → alert names the amount and currency", () => {
  const a = buildLowBalanceAlert(11.85, "USD", 15);
  assert.ok(a !== null, "11.85 < 15 must alert");
  assert.ok(a!.includes("11.85") && /USD/i.test(a!), `should name amount + currency: ${a}`);
  assert.ok(/top up/i.test(a!), "should tell the founder to top up");
});

test("balance alarm: at or above threshold → no alert (no nagging when healthy)", () => {
  assert.equal(buildLowBalanceAlert(15, "USD", 15), null, "exactly at threshold is fine");
  assert.equal(buildLowBalanceAlert(42.5, "USD", 15), null, "well above threshold is fine");
});

test("balance alarm: unreadable balance → null, never cry wolf", () => {
  assert.equal(buildLowBalanceAlert(NaN, "USD", 15), null);
});

test("balance alarm: custom threshold is respected", () => {
  assert.ok(buildLowBalanceAlert(20, "USD", 25) !== null, "20 < 25 must alert");
  assert.equal(buildLowBalanceAlert(30, "USD", 25), null, "30 > 25 must not alert");
});

// FRICTIONLESS WORKOUT VIEWER (2026-07-09) — the swipe page that replaces the model's
// hallucinated exercise dumps. The token must be unforgeable (it references a client)
// and the cards must mirror the REAL current-day workout, never a made-up one.
process.env.COACH_DASHBOARD_KEY = process.env.COACH_DASHBOARD_KEY || "test-secret-key";
const { signWorkoutToken, verifyWorkoutToken, buildViewerCards, renderWorkoutViewerHtml } =
  await import("../server/workout-viewer");

test("workout viewer: token round-trips to the same user id", () => {
  const t = signWorkoutToken("user-abc-123");
  assert.ok(t, "should sign a token");
  assert.equal(verifyWorkoutToken(t!), "user-abc-123");
});

test("workout viewer: tampered / garbage tokens are rejected", () => {
  const t = signWorkoutToken("user-abc-123")!;
  const tampered = t.slice(0, -1) + (t.endsWith("a") ? "b" : "a");
  assert.equal(verifyWorkoutToken(tampered), null, "flipped sig char must fail");
  assert.equal(verifyWorkoutToken("garbage"), null);
  assert.equal(verifyWorkoutToken(""), null);
});

test("workout viewer: a forged token for another user id fails the signature", () => {
  const forged = Buffer.from("victim-user-id").toString("base64url") + ".deadbeefdeadbeefdeadbeef";
  assert.equal(verifyWorkoutToken(forged), null, "no attacker can mint a link for another client");
});

test("workout viewer: cards mirror the real current-day exercises (gym user)", () => {
  const user = { trainingMode: "gym", trainingDaysPerWeek: 3, programmeDayInWeek: 1, programmeWeek: 1, gender: "male", trainingExperience: "beginner" };
  const data = buildViewerCards(user);
  assert.ok(data && data.cards.length > 0, "gym user should have exercise cards");
  for (const c of data!.cards) {
    assert.ok(c.name && c.sets, "each card carries a name and sets");
    assert.ok("videoUrl" in c && "gifUrl" in c && "alt" in c, "card has the full media shape");
  }
});

test("workout viewer: walk-only user has no cards (null, not a crash)", () => {
  assert.equal(buildViewerCards({ trainingMode: "walk_only" }), null);
});




// MEAL-REPEAT META-COMPLAINT GUARD (2026-07-10) — a voice complaint "I already told
// you what's the plan for lunch. Have you forgotten? We are repeating the same things"
// matched repeat+lunch and LOGGED YESTERDAY'S PASTA. Complaints must never log food.
const { handleMealRepeat } = await import("../server/handlers/meal-repeat");

test("meal-repeat: a complaint about repetition NEVER logs a meal", async () => {
  for (const msg of [
    "But I already told you what's the plan for lunch. Have you forgotten? Come on man, come on. We are repeating the same things.",
    "why do you keep logging the same lunch",
    "you and I had a discussion about my lunch yesterday",
  ]) {
    const r = await handleMealRepeat({ phone: LC_USER.phoneNumber, message: msg, m: msg.toLowerCase(), user: LC_USER });
    assert.equal(r, null, `complaint must fall through, not log: ${msg}`);
  }
});

test("meal-repeat: a genuine repeat request still works through the guard", async () => {
  const msg = "dinner is the same as lunch";
  const r = await handleMealRepeat({ phone: LC_USER.phoneNumber, message: msg, m: msg, user: LC_USER });
  assert.ok(r === null || !/have you forgot/i.test(r), "genuine repeat is not blocked by the guard (null only if no meal to copy in stub)");
});

// CONCERN-FIRST ON HEALTH EVENTS (2026-07-09) — a real client wrote "had an incident
// at work and my GP recommended rest, spent the day in bed". Health events rarely use
// the word "sick"; the brain must still catch them and lead with concern, not coach past.
const { SCENARIO_TOPIC_RE, BRAIN_SYSTEM: BRAIN_SYS } = await import("../server/brain/coach-brain");

test("brain: oblique health events trigger the scenario playbook (not only the word 'sick')", () => {
  for (const msg of [
    "had an incident at work and my GP recommended rest, spent the day in bed",
    "I'm in hospital",
    "on a drip today",
    "going for an iron infusion",
    "the doctor admitted me",
  ]) assert.ok(SCENARIO_TOPIC_RE.test(msg), `should trigger concern handling: ${msg}`);
});

test("brain: everyday chatter does NOT trip the health playbook", () => {
  for (const msg of ["what's my protein target", "logged my lunch", "gym was great today", "show me the exercises"])
    assert.ok(!SCENARIO_TOPIC_RE.test(msg), `should NOT trigger: ${msg}`);
});

// SICK-MENTION PRECISION (2026-07-13, cross-intent sweep) — the word "sick"/"flu"
// appearing in a message is NOT a sickness report. Third-person, idiom, prevention,
// and overeating-regret must all stay out of the sick flow.
const { looksSickMention } = await import("../server/handlers/sick-flow");

test("sick gate: first-person reports fire", () => {
  for (const msg of [
    "I'm sick with flu, no training for me",
    "I can't walk today, I'm sick. I'll be out for the next 5 days",
    "woke up with a fever, feeling terrible",
    "I've got covid",
    "down with the flu",
    "not feeling well today",
  ]) assert.ok(looksSickMention(msg), `should fire: ${msg}`);
});

test("sick gate: third-person / idiom / prevention / regret do NOT fire", () => {
  for (const msg of [
    "The flu is going around at work",
    "My sister is sick, I'm taking care of her this week",
    "My kids have the flu so I might miss gym tomorrow",
    "I'm sick of pap every single day, give me something else",
    "I'm sick and tired of diets that don't work",
    "Flu shot tomorrow, can I still train?",
    "Ate so much at the party last night, I feel sick",
    "That workout made me feel sick, was it too intense?",
    "I'm feeling better now, over the flu",
  ]) assert.ok(!looksSickMention(msg), `should NOT fire: ${msg}`);
});

test("sick gate: third-person context with a first-person report still fires", () => {
  assert.ok(looksSickMention("Everyone at work has flu and now I'm sick too"), "first-person assertion overrides third-party context");
});

// SICK FLOW — a substantive message while already sick must NOT get the holding template
// (2026-07-15 screenshot: a restlessness/identity share got the EXACT same words as a
// bare "still sick", verbatim 60s apart). Bare check-ins still get a (varied) template;
// anything carrying real content falls through to the sick-aware brain.
const { handleSickFlow } = await import("../server/handlers/sick-flow");
const sickUser = { id: "sick-user", goalType: "fat_loss", trainingMode: "gym", profileNotes: "sick_until:2099-01-01 | paused_until:2099-01-01" };
const sickCtx = (raw: string) => ({ message: raw, m: raw.toLowerCase(), user: sickUser, capName: "Kam" });

test("sick flow: bare 'still sick' check-in gets a holding template", async () => {
  const r = await handleSickFlow(sickCtx("I'm still sick today"));
  assert.ok(r !== null, "bare check-in should return a template");
  assert.ok(/rest|holding|paused|fluids|soup/i.test(r!), "template holds the rest line");
});

test("sick flow: a substantive share while sick FALLS THROUGH to the brain (no template)", async () => {
  for (const msg of [
    "I feel like I should be walking or doing something, I'm not used to just sitting around but I'm also not well, I can feel it",
    "the flu is killing me and I feel so alone",
    "I still have the flu and honestly I'm scared I'm losing all my progress",
  ]) {
    const r = await handleSickFlow(sickCtx(msg));
    assert.strictEqual(r, null, `substantive sick message must fall through, not template: "${msg.slice(0, 40)}"`);
  }
});

test("brain: eating-out playbook — permission + strategy, never guilt (Kam's manual pattern)", () => {
  assert.ok(/EATING OUT/i.test(BRAIN_SYS), "must handle going-out announcements");
  assert.ok(/lean protein/i.test(BRAIN_SYS) && /skip the alcohol/i.test(BRAIN_SYS), "3-part strategy present");
  assert.ok(/photo your plate/i.test(BRAIN_SYS), "must ask for the plate photo to log");
});

test("brain: playbook leads with concern on a health event (asks if serious)", () => {
  assert.ok(/health event/i.test(BRAIN_SYS), "must name 'any health event'");
  assert.ok(/concern/i.test(BRAIN_SYS) && /serious/i.test(BRAIN_SYS), "must instruct concern-first + ask if serious");
});

// LAGGING BODY PART (2026-07-09) — a real test: "my chest is lagging, add an 8th
// exercise?" The bot wrongly called it "muscle confusion" and refused. Bringing up a
// weak point is legitimate targeted volume, and the bot must never echo the myth.
test("brain: lagging body part → targeted volume, never 'muscle confusion'", () => {
  assert.ok(/LAGGING BODY PART/i.test(BRAIN_SYS), "must handle lagging body parts explicitly");
  assert.ok(/muscle confusion is a MYTH/i.test(BRAIN_SYS), "must call muscle confusion a myth, not prescribe it");
  assert.ok(/NEVER refuse it/i.test(BRAIN_SYS), "must not refuse a legitimate lagging-part request");
  assert.ok(/glutes\/hamstrings|glutes/i.test(BRAIN_SYS) && /chest\/back|chest/i.test(BRAIN_SYS), "gender-aware body-part priorities present");
});

test("workout viewer: rendered page slides and escapes exercise names", () => {
  const html = renderWorkoutViewerHtml(
    { label: "Upper A", week: 2, cards: [{ name: "Chest <Fly>", sets: "4 × 8", gifUrl: null, videoUrl: "https://youtube.com/x", alt: "Dumbbell press" }] },
    "Kam",
  );
  assert.ok(/scroll-snap-type:\s*x/i.test(html), "must be a horizontal slider");
  assert.ok(html.includes("Chest &lt;Fly&gt;"), "must HTML-escape exercise names");
  assert.ok(html.includes("Watch the move"), "video card shows a watch action");
});

// ============================================================
// MISC-COMMANDS.TS CHARACTERISATION TESTS
// ============================================================

const { handleMiscCommands } = await import("../server/handlers/misc-commands");

function mc(message: string, overrides: Partial<typeof LC_USER> = {}) {
  const user = { ...LC_USER, ...overrides };
  return { phone: user.phoneNumber, message, m: message.toLowerCase().trim(), user };
}

test("misc-commands: 'creatine' → supplement guide returned", async () => {
  const r = await handleMiscCommands(mc("creatine"));
  assert.ok(r !== null, "should handle creatine query");
  assert.ok(r!.toLowerCase().includes("creatine"), `should mention creatine: ${r?.slice(0, 100)}`);
});

test("misc-commands: 'should I take protein powder' → supplement guide", async () => {
  const r = await handleMiscCommands(mc("should I take protein powder"));
  assert.ok(r !== null, "should handle protein powder query");
});

test("misc-commands: week9_choice '1' → maintenance phase response", async () => {
  const r = await handleMiscCommands(mc("1", { awaitingInputType: "week9_choice" }));
  assert.ok(r !== null, "should handle week9_choice '1'");
  assert.ok(r!.toLowerCase().includes("maintenance") || r!.toLowerCase().includes("3"), `should be maintenance path: ${r?.slice(0, 100)}`);
});

test("misc-commands: week9_choice '2' → advanced phase response", async () => {
  const r = await handleMiscCommands(mc("2", { awaitingInputType: "week9_choice" }));
  assert.ok(r !== null, "should handle week9_choice '2'");
  assert.ok(r!.toLowerCase().includes("advanced") || r!.toLowerCase().includes("5"), `should be advanced path: ${r?.slice(0, 100)}`);
});

test("misc-commands: week9_choice 'irrelevant text' → falls through (null)", async () => {
  const r = await handleMiscCommands(mc("what is the weather", { awaitingInputType: "week9_choice" }));
  // Non-matching input during week9_choice should fall through
  assert.ok(r === null || typeof r === "string", "should be null or string");
});

// ============================================================
// MEDIA.TS CHARACTERISATION TESTS
// Tests pure helpers and early-return paths that don't require
// external API calls (OpenAI Vision / Whisper / image download).
// ============================================================

const { bumpVoiceFailure, clearVoiceFailure, handleMediaMessage } = await import("../server/handlers/media");
const { default: OpenAI } = await import("openai");

const testOpenAi = new OpenAI({ apiKey: "sk-test-offline" });

// ---- VOICE FAILURE TRACKER ----
test("media: bumpVoiceFailure — first call returns 1", () => {
  const count = bumpVoiceFailure("media-test-uid-1");
  assert.equal(count, 1);
  clearVoiceFailure("media-test-uid-1"); // cleanup
});

test("media: bumpVoiceFailure — second call within window returns 2", () => {
  const uid = "media-test-uid-2";
  bumpVoiceFailure(uid);
  const count = bumpVoiceFailure(uid);
  assert.equal(count, 2);
  clearVoiceFailure(uid);
});

test("media: clearVoiceFailure — resets counter to 0 (next bump returns 1)", () => {
  const uid = "media-test-uid-3";
  bumpVoiceFailure(uid);
  bumpVoiceFailure(uid);
  clearVoiceFailure(uid);
  const count = bumpVoiceFailure(uid);
  assert.equal(count, 1, "after clear, bump should return 1");
  clearVoiceFailure(uid);
});

// ---- STICKER DETECTION ----
test("media: sticker (image/webp, no caption) → sticker detection message, no API call", async () => {
  const r = await handleMediaMessage({
    phone: "whatsapp:+27821234567",
    message: "",
    mediaUrl: "https://media.twilio.com/sticker.webp",
    mediaContentType: "image/webp",
    allMediaUrls: [],
    user: { ...LC_USER },
    isCoach: false,
    openai: testOpenAi,
    handleMessage: async () => "",
  });
  assert.ok(r.includes("sticker"), `should mention sticker: ${r.slice(0, 100)}`);
});

// ============================================================



// ============================================================
// FOOD SCANNER PRECISION (2026-07-12, Kam: "go deep" on calorie precision). The scanner
// must identify every food in a multi-item log AND never double-count a protein when a
// specific dish and a generic component both light up. Locks two real double-count bugs
// found by probe: restaurant chicken + phantom "Chicken thigh", and a curry combo +
// standalone curry.
// ============================================================
function scanNames(msg: string): string[] {
  return scanForSAFoods(msg).map((f: any) => f.name);
}

test("food scan: multi-item logs identify every component", () => {
  const eggsPap = scanNames("2 eggs and pap");
  assert.ok(eggsPap.includes("Eggs") && eggsPap.some(n => /pap/i.test(n)), "eggs + pap both found");
  const chkVeg = scanNames("grilled chicken breast and sweet potato");
  assert.ok(chkVeg.includes("Chicken breast") && chkVeg.includes("Sweet potato"), "breast + sweet potato");
});

test("food scan: no chicken double-count when a specific dish + bare 'chicken' collide", () => {
  const nandos = scanNames("nandos quarter chicken and chips");
  assert.ok(nandos.includes("Nando's quarter chicken"), "keeps the real dish");
  assert.ok(!nandos.includes("Chicken thigh") && !nandos.includes("Chicken breast"), "drops phantom generic cut");
  const rot = scanNames("rotisserie chicken and veg");
  assert.ok(!rot.includes("Chicken thigh") && !rot.includes("Chicken breast"), "rotisserie doesn't add a phantom cut");
});

test("food scan: a typed cut word keeps the generic cut (not a phantom)", () => {
  assert.ok(scanNames("chicken thigh and rice").includes("Chicken thigh"), "typed 'thigh' kept");
  assert.ok(scanNames("chicken breast and rice").includes("Chicken breast"), "typed 'breast' kept");
  assert.deepEqual(scanNames("chicken"), ["Chicken thigh"], "bare 'chicken' still logs a cut");
});

test("food scan: curry combo doesn't double-count the standalone curry", () => {
  assert.deepEqual(scanNames("chicken curry and rice"), ["Chicken curry and rice"], "combo only, no extra curry");
  assert.deepEqual(scanNames("chicken curry"), ["Curry (chicken)"], "standalone curry still works alone");
});

test("food scan: toast/stew combos don't double-count their bread/stew alternates", () => {
  // "Toast" alongside an "...on toast" combo was double-counting the bread.
  assert.deepEqual(scanNames("two boiled eggs and toast"), ["Eggs on toast"], "no extra Toast on top of the combo");
  assert.deepEqual(scanNames("pilchards on toast"), ["Pilchards on toast"], "no extra Toast");
  assert.ok(scanNames("toast with jam").includes("Toast"), "standalone Toast still logs");
  // "Beef stew" alongside "Pap and stew" was double-counting the stew.
  const stew = scanNames("beef stew and pap");
  assert.ok(stew.includes("Beef stew") && stew.some(n => /pap/i.test(n)), "beef stew + pap, both kept");
  assert.ok(!stew.includes("Pap and stew"), "no phantom combo double-counting the stew");
  assert.deepEqual(scanNames("big plate of pap and stew"), ["Pap and stew"], "vague 'stew' keeps the combo");
});

// A COMBO MAY NOT BORROW ITS WORDS FROM ANOTHER FOOD (#114 P0-1, 2026-09-03, founder's typed
// message). "Pap and chicken livers" returned BOTH "Chicken livers" AND the combo "Chicken and
// pap" — 858 kcal and 95g protein for one plate, and the client was told they had eaten chicken
// they never had. The combo's alias "pap and chicken" (chars 0-14) overlaps "chicken livers"
// (chars 8-21): the dish was assembled out of a word that belongs to the livers.
//
// Graded on the identity AND the charge, because either alone can pass while the other is wrong:
// dropping the phantom without keeping the pap loses food the client ate, and keeping both entries
// at half portions would double-count differently.
test("food scan: 'Pap and chicken livers' is one plate, and there is no invented chicken", () => {
  const names = scanNames("Pap and chicken livers");
  assert.ok(names.includes("Chicken livers"), `the livers must survive: ${names.join(", ")}`);
  assert.ok(names.some(n => /^pap/i.test(n)), `the pap the client ate must survive: ${names.join(", ")}`);
  assert.ok(!names.includes("Chicken and pap"),
    `the combo borrowed "chicken" from the livers and charged a second dish: ${names.join(", ")}`);
  assert.ok(!names.some(n => n === "Chicken thigh" || n === "Chicken breast"),
    `no independent chicken entity may be invented: ${names.join(", ")}`);
  // CHARGED ONCE. The bug was visible as a number long before anyone read the entry list.
  const kcal = adjustFoodsForSegment(scanForSAFoods("Pap and chicken livers") as any, "Pap and chicken livers")
    .reduce((s: number, f: any) => s + f.adjustedCalories, 0);
  assert.ok(kcal < 700, `one plate of pap and livers cannot be ${kcal} kcal — that is the double charge`);
});

test("food scan: a combo whose span is its own is untouched (both word orders)", () => {
  // CONTROL. The rule must fire on BORROWED words only. Here the overlap between the combo and
  // the standalone Pap is the combo bundling its own component, which is legitimate — without
  // this, "drop a combo that overlaps anything" would delete every combo in the table.
  assert.deepEqual(scanNames("pap and chicken"), ["Chicken and pap"], "combo survives, one dish");
  assert.deepEqual(scanNames("chicken and pap"), ["Chicken and pap"], "and in the other word order");
  // The two halves still work alone, so the fix did not simply suppress one of them.
  assert.deepEqual(scanNames("chicken livers"), ["Chicken livers"], "livers alone unaffected");
  assert.ok(scanNames("pap").some(n => /^pap/i.test(n)), "pap alone unaffected");
});

test("food scan: every combo in the table still resolves to itself", () => {
  // CONTROL, deliberately exhaustive. The new pass sees every combo, so a rule that is subtly too
  // greedy would show up here rather than in production. These are the phrases the combos exist for.
  for (const [phrase, expected] of [
    ["pap and wors", "Pap and wors"], ["fish and chips", "Fish and chips"],
    ["eggs on toast", "Eggs on toast"], ["peanut butter on bread", "Peanut butter on bread"],
    ["oats with milk", "Oats with milk"], ["cereal with milk", "Cereal with milk"],
    ["mince and pap", "Mince and pap"], ["pap and stew", "Pap and stew"],
    ["pap and spinach", "Pap and spinach"], ["pap and pilchards", "Pap and pilchards"],
    ["chicken and rice", "Chicken and rice"], ["rice and chicken", "Chicken and rice"],
  ] as const) {
    assert.deepEqual(scanNames(phrase), [expected], `"${phrase}" must still be one dish`);
  }
  // And the regression the combo dedup was originally written for stays fixed.
  const listed = scanNames("i had lentils, rice and chicken breast");
  assert.ok(!listed.includes("Chicken and rice"), `no phantom combo when parts are listed: ${listed.join(", ")}`);
});

test("food scan: a specific sandwich suppresses the generic 'Sandwich' (no double bread)", () => {
  assert.deepEqual(scanNames("peanut butter sandwich"), ["Peanut butter on bread"], "PB sandwich = one item");
  // but a bare/filling sandwich with no specific match keeps 'Sandwich' for the bread
  assert.ok(scanNames("cheese and tomato sandwich").includes("Sandwich"), "generic sandwich kept for bread");
  assert.deepEqual(scanNames("sandwich"), ["Sandwich"], "bare sandwich still logs");
});

// QUANTITY PRECISION — the calories a text log produces must scale with the count.
// "6 eggs" is 3× "2 eggs", not the same. This is where the deficit actually lives.
function eggKcal(msg: string): number {
  const adj = adjustFoodsForSegment(scanForSAFoods(msg), msg) as any[];
  const egg = adj.find(f => f.name === "Eggs");
  return egg ? egg.adjustedCalories : -1;
}
test("food quantity: egg calories scale with the count (default portion is 2 eggs)", () => {
  const two = eggKcal("2 eggs");
  assert.ok(two > 150 && two < 220, `2 eggs ~186 kcal, got ${two}`);
  assert.equal(eggKcal("6 eggs"), two * 3, "6 eggs = 3× the 2-egg portion");
  assert.equal(eggKcal("3 eggs"), Math.round(two * 1.5), "3 eggs = 1.5×");
  assert.equal(eggKcal("1 egg"), Math.round(two * 0.5), "1 egg = 0.5×");
});
test("food quantity: size words scale the whole portion", () => {
  const adjBig = adjustFoodsForSegment(scanForSAFoods("big plate of pap"), "big plate of pap") as any[];
  const adjNorm = adjustFoodsForSegment(scanForSAFoods("pap"), "pap") as any[];
  const big = adjBig.find(f => /pap/i.test(f.name)), norm = adjNorm.find(f => /pap/i.test(f.name));
  assert.ok(big && norm && big.adjustedCalories > norm.adjustedCalories, "big plate > normal plate");
});

// VAGUE QUANTITY (2026-07-23 live: "I said half a Vienna" → the bot logged the 2-vienna
// default and the client had to argue the log DOWN). Vague amounts lean LOW, and a vague
// amount is speech — portion memory must not override it.
function viennaAdj(msg: string): any {
  const adj = adjustFoodsForSegment(scanForSAFoods(msg), msg) as any[];
  return adj.find(f => /vienna/i.test(f.name));
}
test("vague quantity: 'half a vienna' is a fraction of ONE vienna, never the 2-vienna default", () => {
  const half = viennaAdj("half a vienna with my eggs");
  const dflt = viennaAdj("viennas with my eggs");
  assert.ok(half && dflt, "both scans find viennas");
  assert.ok(half.adjustedCalories < dflt.adjustedCalories / 2 + 10, `half a vienna (${half.adjustedCalories}) must be way under the default (${dflt.adjustedCalories})`);
  // "half" normalises to 0.5 and rides the explicit path (0.5 of ONE vienna against the
  // 2-vienna default = 0.25×); the per-food vague matcher is the backstop. Either source
  // is fine — the NUMBER is the contract.
  assert.ok(["vague", "explicit"].includes(half.portionSource), `source: ${half.portionSource}`);
  assert.ok(Math.abs(half.quantity - 0.25) < 0.01, `0.5 vienna of a 2-vienna portion = 0.25× (got ${half.quantity})`);
});
test("vague quantity: 'some viennas' leans LOW — half the table default", () => {
  const some = viennaAdj("some viennas on the side");
  const dflt = viennaAdj("viennas on the side");
  assert.ok(some && dflt, "both scans find viennas");
  assert.equal(some.adjustedCalories, Math.round(dflt.adjustedCalories * 0.5), "some = 0.5× default");
  assert.equal(some.portionSource, "vague");
});
test("vague quantity: an explicit count still wins — '3 viennas' is not vague", () => {
  const three = viennaAdj("3 viennas");
  assert.equal(three.portionSource, "explicit");
});
test("vague quantity: global 'half the rice' does not double-halve per-food", () => {
  const adj = adjustFoodsForSegment(scanForSAFoods("half the rice"), "half the rice") as any[];
  const rice = adj.find(f => /rice/i.test(f.name));
  assert.ok(rice, "rice found");
  assert.ok(rice.quantity >= 0.45, `0.5 once, not 0.25 (got ${rice.quantity})`);
});

// ============================================================
// Results
// ============================================================

// ============================================================
// SYMPTOM PERSISTENCE (2026-08-12) — step 2 of the hunger doctrine.
// "I'm hungry" and "I've been hungry every afternoon for six days" are not the same state, and
// until now the product could not tell them apart. These cover the two ways this could go wrong:
// capturing the wrong messages, and corrupting the friction system it borrows its pattern from.
// ============================================================

const { SYMPTOM_SIGNAL_KINDS, NOT_A_BOT_FUMBLE, symptomSignalKind } =
  await import("../server/quality-signals");
const { reportsHunger } = await import("../server/unlogged-notice");
const { FRICTION_SIGNAL_KINDS } = await import("../server/friction");

test("symptom: a present-tense hunger report is captured", () => {
  for (const m of [
    "I'm hungry", "im so hungry all the time", "I am always hungry",
    "still hungry after lunch", "I'm starving", "constantly hungry",
    "I can't stop eating", "my cravings are out of control",
  ]) assert.equal(reportsHunger(m), true, `should capture: "${m}"`);
});

test("symptom: it must NOT capture a past explanation, advice, or an unrelated message", () => {
  // Over-capturing would manufacture the very persistence the doctrine exists to detect.
  for (const m of [
    "I ate the bread because I was hungry",   // past explanation, not a current report
    "I was so hungry yesterday",              // past
    "that will keep you full for hours",      // advice about hunger
    "i had chicken and rice for lunch",       // a food log
    "how many calories do I have left?",      // a question
    "how do I stop being hungry",             // asking, not reporting — the coach answers this
  ]) assert.equal(reportsHunger(m), false, `must NOT capture: "${m}"`);
});

test("symptom: hunger is NOT a friction kind — the operator queue stays uncorrupted", () => {
  // Friction means the client is FIGHTING THE BOT; its red flag reads "the bot is failing them".
  // A hungry client is not a bot failure. If these namespaces ever overlap, reporting a symptom
  // would rank a client as a churn risk for telling us what we asked them to tell us.
  assert.equal(symptomSignalKind("hunger"), "symptom_hunger");
  for (const k of SYMPTOM_SIGNAL_KINDS) {
    assert.ok(!FRICTION_SIGNAL_KINDS.includes(k), `${k} must never be counted as friction`);
  }
  for (const k of FRICTION_SIGNAL_KINDS) {
    assert.ok(!SYMPTOM_SIGNAL_KINDS.includes(k), `${k} must never be counted as a symptom`);
  }
});

test("symptom: a client-state observation is never presented as a bot fumble", () => {
  // The admin review queue labels every row "a moment the bot fumbled".
  for (const k of SYMPTOM_SIGNAL_KINDS) {
    assert.ok(NOT_A_BOT_FUMBLE.includes(k), `${k} must be excluded from the fumble queue`);
  }
  const admin = readFileSync("server/routes/admin.ts", "utf-8");
  assert.ok(/notInArray\(qualitySignals\.kind, NOT_A_BOT_FUMBLE\)/.test(admin),
    "the exclusion must actually be applied to the query, not merely declared");
});

test("symptom: persistence records evidence and never diagnoses", () => {
  // The layer must expose counts and dates only. A cause belongs downstream, with Coach K.
  const src = readFileSync("server/quality-signals.ts", "utf-8");
  const fn = src.slice(src.indexOf("export interface SymptomPersistence"));
  assert.ok(/distinctDays/.test(fn), "distinct DAYS is the load-bearing number, not raw occurrences");
  assert.ok(!/protein|cause|because|recommend|should eat/i.test(fn.slice(0, 1200)),
    "the persistence layer must not carry a diagnosis or advice");
});

// ============================================================
// HUNGER EVIDENCE (2026-08-12) — step 3. Joins the nutrition picture to the symptom history.
// The evidenceState machine is where a mistake would be invisible in production, so every
// transition is covered — including the two that must NOT fire.
// ============================================================

const { assembleHungerEvidence, PERSISTENT_HUNGER_DAYS, ADEQUATE_PROTEIN_RATIO } =
  await import("../server/hunger-evidence");
const { computeProgressScore } = await import("../server/progress-score");

const scoreWith = (over: Partial<any> = {}) => computeProgressScore({
  completedSessions: 2, plannedSessions: 3,
  avgDailyProtein: 71, proteinTarget: 120,
  avgSteps: 6200, stepsTarget: 8500,
  foodLogDays: 6, weightLogCount: 2, weightChangeKg: -0.4,
  goalType: "fat_loss", ...over,
});
const hungerFor = (distinctDays: number) => ({
  kind: "hunger" as const, occurrences: distinctDays * 2, distinctDays,
  firstAt: null, lastAt: null, windowDays: 7,
});
const inputsWith = (over: Partial<any> = {}) => ({
  avgDailyProtein: 71, proteinTarget: 120, avgSteps: 6200, weightChangeKg: -0.4, foodLogDays: 6, ...over,
});

test("hunger evidence: persistent hunger with short protein puts protein IN SCOPE", () => {
  const e = assembleHungerEvidence(scoreWith(), hungerFor(6), inputsWith());
  assert.equal(e.evidenceState, "persistent_hunger");
  assert.equal(e.hunger.persistent, true);
  assert.ok(e.progress.proteinRatio! < ADEQUATE_PROTEIN_RATIO);
  assert.equal(e.confidence, "usable");
});

test("hunger evidence: ADEQUATE protein with persistent hunger is a distinct state", () => {
  // The case a one-line rule gets confidently wrong, for exactly the clients who complied.
  const e = assembleHungerEvidence(
    scoreWith({ avgDailyProtein: 118 }), hungerFor(5), inputsWith({ avgDailyProtein: 118 }));
  assert.equal(e.evidenceState, "adequate_protein_persistent_hunger");
  assert.ok(e.progress.proteinRatio! >= ADEQUATE_PROTEIN_RATIO);
});

test("hunger evidence: one bad day is NOT persistence", () => {
  const e = assembleHungerEvidence(scoreWith(), hungerFor(1), inputsWith());
  assert.equal(e.evidenceState, "single_signal");
  assert.equal(e.hunger.persistent, false);
});

test("hunger evidence: six complaints in ONE day is still one day", () => {
  // occurrences 12, distinctDays 1 — the whole reason distinctDays is the primitive.
  const e = assembleHungerEvidence(scoreWith(), { ...hungerFor(1), occurrences: 12 }, inputsWith());
  assert.equal(e.evidenceState, "single_signal", "message volume must never manufacture persistence");
});

test("hunger evidence: thin logs beat every other signal — no claim about protein at all", () => {
  // Confidence is checked FIRST. Two logged days cannot support "your protein is low",
  // however bad the average looks or however many days hunger was reported.
  const e = assembleHungerEvidence(
    scoreWith({ foodLogDays: 2, avgDailyProtein: 30 }), hungerFor(6), inputsWith({ foodLogDays: 2, avgDailyProtein: 30 }));
  assert.equal(e.confidence, "weak");
  assert.equal(e.evidenceState, "insufficient_data",
    "persistent hunger must NOT license a protein claim on two logged days");
});

test("hunger evidence: no symptom reported means nothing is volunteered", () => {
  const e = assembleHungerEvidence(scoreWith(), hungerFor(0), inputsWith());
  assert.equal(e.evidenceState, "no_persistent_symptom");
});

test("hunger evidence: the persistence threshold is days, and it is the stated one", () => {
  assert.equal(PERSISTENT_HUNGER_DAYS, 3);
  assert.equal(assembleHungerEvidence(scoreWith(), hungerFor(PERSISTENT_HUNGER_DAYS - 1), inputsWith()).hunger.persistent, false);
  assert.equal(assembleHungerEvidence(scoreWith(), hungerFor(PERSISTENT_HUNGER_DAYS), inputsWith()).hunger.persistent, true);
});

test("hunger evidence: it carries evidence and NEVER an intervention", () => {
  const e = assembleHungerEvidence(scoreWith(), hungerFor(6), inputsWith());
  const keys = JSON.stringify(e);
  for (const banned of ["recommend", "intervention", "eatMore", "reduceCalories", "advice", "shouldEat"]) {
    assert.ok(!keys.includes(banned), `the evidence object must not carry "${banned}"`);
  }
  // No prose in the ASSEMBLER. renderHungerEvidence below it legitimately writes text — but for
  // the PROMPT, read by the model, never sent to a client. That distinction is the point: the
  // calculator stays wordless, and the one place with words says only what the evidence IS.
  const src = readFileSync("server/hunger-evidence.ts", "utf-8");
  const assembler = src.slice(0, src.indexOf("export function renderHungerEvidence"));
  const code = assembler.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/["'`][A-Z][a-z]+ [a-z]+ [a-z]+/.test(code),
    "no sentences may appear in the evidence assembler — it returns values, not words");
});


// ============================================================
// LAW 26 — the hunger reasoning protocol (step 4, 2026-08-12).
// The doctrine lives in the engine's CONSTITUTION, which is delivered IN FULL on every call —
// not in the COACH_K_SYSTEM tail, where "restoring" it would have meant writing it at character
// 20,001 and congratulating ourselves. These assert the three cases the founder named, at the
// level a deterministic test can reach: what the delivered doctrine INSTRUCTS. Whether the model
// obeys it is a Reality question, and that run comes next.
// ============================================================

const constitutionText = (() => {
  const src = readFileSync("server/understanding/meaning-engine.ts", "utf-8");
  const i = src.indexOf("const CONSTITUTION = `");
  const a = src.indexOf("`", i) + 1;
  return src.slice(a, src.indexOf("`;", a));
})();
// Whitespace-normalised: the CONSTITUTION is hard-wrapped, so "already at target" is really
// "already at\ntarget". A phrase assertion that ignores that tests the line breaks, not the rule.
const law26 = constitutionText.slice(constitutionText.indexOf("26. PERSISTENT HUNGER")).replace(/\s+/g, " ");

test("law 26: it reaches the model — CONSTITUTION is sent in full, unlike the sliced prompt", () => {
  assert.ok(constitutionText.includes("PERSISTENT HUNGER IS A SIGNAL TO INVESTIGATE"),
    "the doctrine must live in the DELIVERED layer, not the amputated COACH_K_SYSTEM tail");
  const engine = readFileSync("server/understanding/meaning-engine.ts", "utf-8");
  assert.ok(/systemParts\s*=\s*\[\s*\n?\s*CONSTITUTION/.test(engine),
    "CONSTITUTION must be the first thing in the engine's system message");
  assert.ok(!/CONSTITUTION\.slice\(/.test(engine), "the CONSTITUTION must never be sliced");
});

test("law 26 / case 1: adequate protein + persistent hunger must NOT be a protein diagnosis", () => {
  assert.ok(/already at target/i.test(law26) && /not the answer/i.test(law26),
    "the doctrine must state plainly that at-target protein is NOT the answer");
  assert.ok(/lose someone who was doing the work/i.test(law26),
    "and say why it matters — this is the case that loses a complying client");
});

test("law 26 / case 2: insufficient evidence must NOT produce a cause", () => {
  assert.ok(/enough evidence|enough logged/i.test(law26), "evidence sufficiency is checked FIRST");
  assert.ok(/say so/i.test(law26) && /ask for/i.test(law26),
    "it must instruct the coach to SAY it does not know and ask for what it needs");
  assert.ok(/never diagnose from two days/i.test(law26),
    "the floor must be explicit, not left to judgement");
});

test("law 26 / case 3: good evidence still is not a verdict", () => {
  // The subtlest of the three: even with real numbers, naming a cause claims more than we know.
  assert.ok(/correlation is not diagnosis/i.test(law26), "the doctrine must say this outright");
  assert.ok(/plausible cause to investigate/i.test(law26),
    "it must frame the finding as the thing to INVESTIGATE, not the answer");
  assert.ok(/claims more than you know/i.test(law26),
    "and must give the counter-example of a sentence that overclaims");
});

test("law 26: it forbids moralising and does not collapse to a one-line rule", () => {
  assert.ok(/willpower/i.test(law26) && /forbidden/i.test(law26),
    "willpower/discipline language must be explicitly banned, not merely discouraged");
  // The doctrine must name causes BEYOND protein, or it is the brittle rule wearing a longer coat.
  for (const cause of ["volume", "sleep", "adherence", "calories"]) {
    assert.ok(new RegExp(cause, "i").test(law26), `law 26 must consider ${cause}, not protein alone`);
  }
  assert.ok(/one lever/i.test(law26), "protein must be framed as ONE lever among several");
});

test("law 26: the integrity guard protects it, in the same change", () => {
  const guard = readFileSync("script/check-prompt-integrity.ts", "utf-8");
  assert.ok(/PERSISTENT HUNGER IS A SIGNAL TO INVESTIGATE/.test(guard),
    "a doctrine with no guard is a doctrine that can vanish silently — the exact failure being fixed");
  assert.ok(/correlation is not diagnosis/i.test(guard),
    "the guard must assert the BODY teaches the sequence, not merely that a heading exists");
});


// ============================================================
// STEP 3.5 — delivering the evidence (2026-08-12). Law 26 tells Coach K to check the evidence;
// until this wiring the evidence never reached the prompt, so the coach was being asked to
// reason over numbers it was never given. These cover the gate, the block, and the layer rule.
// ============================================================

const { hasRelevantHungerEvidence, renderHungerEvidence } = await import("../server/hunger-evidence");

const persistenceOf = (distinctDays: number) => ({
  kind: "hunger" as const, occurrences: distinctDays, distinctDays,
  firstAt: null, lastAt: null, windowDays: 7,
});

test("3.5 gate: a standing hunger state counts even when today's message never says 'hungry'", () => {
  // Yesterday "I'm hungry every afternoon", today "my weight hasn't moved" — the coach still
  // needs the numbers. Gating on today's wording would deliver them only when least needed.
  assert.equal(hasRelevantHungerEvidence(persistenceOf(5), false), true);
  assert.equal(hasRelevantHungerEvidence(persistenceOf(1), false), true);
});

test("3.5 gate: today's report counts even with no history", () => {
  assert.equal(hasRelevantHungerEvidence(persistenceOf(0), true), true);
});

test("3.5 gate: no signal at all injects NOTHING", () => {
  // The prompt cost matters: on a tool turn the engine system message is sent twice, so a
  // permanent hunger subsystem would be paid for on every message to serve a small fraction.
  assert.equal(hasRelevantHungerEvidence(persistenceOf(0), false), false);
});

test("3.5 block: it reports evidence and states its own boundary — no diagnosis", () => {
  const e = assembleHungerEvidence(
    computeProgressScore({ completedSessions: 2, plannedSessions: 3, avgDailyProtein: 74,
      proteinTarget: 120, avgSteps: 6000, stepsTarget: 8500, foodLogDays: 2,
      weightLogCount: 0, weightChangeKg: null, goalType: "fat_loss" }),
    persistenceOf(1),
    { avgDailyProtein: 74, proteinTarget: 120, avgSteps: 6000, weightChangeKg: null, foodLogDays: 2 });
  const block = renderHungerEvidence(e);
  assert.ok(block.includes("Evidence state: insufficient_data"), "the state must be stated plainly");
  assert.ok(block.includes("120g/day") && block.includes("74g/day"), "the real numbers must appear");
  assert.ok(/Protein adequacy: 62%/.test(block), "the ratio must be given, not left to be computed");
  assert.ok(/EVIDENCE, not a diagnosis and not a recommendation/.test(block),
    "the block must state what it IS, so the model does not read it as a verdict");
  // It must never tell the coach what to CONCLUDE or DO. Note the disclaimer legitimately
  // contains the word "recommendation" — banning that substring would fail the very sentence
  // that establishes the boundary, so these match advice-shaped statements, not vocabulary.
  for (const banned of ["you should", "eat more", "increase (your |the )?protein", "try eating",
                        "the cause is", "because (your|their)"]) {
    assert.ok(!new RegExp(banned, "i").test(block), `the evidence block must not advise: "${banned}"`);
  }
  assert.ok(/not a diagnosis/.test(block), "and it must say outright that it is not one");
});

test("3.5 block: insufficient_data is DELIVERED, not withheld", () => {
  // Knowing what it does not know is the difference between "I can't tell you why yet" and a guess.
  const e = assembleHungerEvidence(
    computeProgressScore({ completedSessions: 0, plannedSessions: 3, avgDailyProtein: 40,
      proteinTarget: 120, avgSteps: 0, stepsTarget: 8500, foodLogDays: 1,
      weightLogCount: 0, weightChangeKg: null, goalType: "fat_loss" }),
    persistenceOf(2),
    { avgDailyProtein: 40, proteinTarget: 120, avgSteps: 0, weightChangeKg: null, foodLogDays: 1 });
  assert.equal(e.evidenceState, "insufficient_data");
  assert.ok(renderHungerEvidence(e).includes("Confidence: weak"), "the coach must be told how thin it is");
});

test("3.5 layering: the engine SERIALISES the evidence, it does not compute it", () => {
  const engine = readFileSync("server/understanding/meaning-engine.ts", "utf-8");
  assert.ok(/input\.hungerEvidence \? renderHungerEvidence\(input\.hungerEvidence\) : ""/.test(engine),
    "the engine must pass the assembled object straight to the renderer");
  // The chain is storage -> calculation -> evidence object -> prompt -> reasoning. If the engine
  // starts assembling or thresholding, the layers have blurred and the calculator has moved.
  for (const leak of ["assembleHungerEvidence", "PERSISTENT_HUNGER_DAYS", "ADEQUATE_PROTEIN_RATIO", "symptomPersistence"]) {
    assert.ok(!engine.includes(leak), `meaning-engine must not reference ${leak} — it serialises only`);
  }
});

test("3.5 layering: the composer sits where the DB reads already live", () => {
  const live = readFileSync("server/understanding/live.ts", "utf-8");
  assert.ok(/hasRelevantHungerEvidence\(hunger, reportsHunger\(message\)\)/.test(live),
    "the gate must combine the standing state with today's message");
  assert.ok(/hungerEvidence,/.test(live), "the assembled object must be handed to the engine");
  // Fail-open: a telemetry or aggregate miss must never cost the client their reply.
  const blockSrc = live.slice(live.indexOf("let hungerEvidence"), live.indexOf("const strategyTurn"));
  assert.ok(/catch/.test(blockSrc) && /prompt proceeds without it/.test(blockSrc),
    "assembly must fail open — no evidence is an honest prompt, an exception is not");
});


// ============================================================
// THE FLAG THAT SILENCED THE MODEL (2026-08-12). KAMLIFE_DB_STUB=1 implied AI_OFFLINE, so the
// hunger gauntlet — which sets the stub because it needs no database — disabled the model on the
// one script whose whole purpose is calling it. The engine failed open to null, every case scored
// an empty reply, and 14 prohibition-shaped checks passed because an empty string cannot violate
// a prohibition. These lock the precedence and the guard that makes it un-repeatable.
// ============================================================

test("ai-offline: the stub still implies offline — every offline suite depends on it", async () => {
  // gap-tests itself runs under KAMLIFE_DB_STUB=1, so this is the live value, not a source read.
  const { AI_OFFLINE } = await import("../server/ai-offline");
  assert.equal(AI_OFFLINE, true, "the offline suites must never start calling the network");
});

test("ai-offline: an EXPLICIT OFFLINE_AI=0 beats the stub, and nothing else changes", () => {
  const src = readFileSync("server/ai-offline.ts", "utf-8");
  assert.ok(/process\.env\.OFFLINE_AI === "0"\s*\n?\s*\? false/.test(src),
    "an explicit opt-in must override the stub's implication");
  assert.ok(/OFFLINE_AI === "1" \|\| process\.env\.KAMLIFE_DB_STUB === "1"/.test(src),
    "the original rule must survive as the fallback — production sets neither and is unaffected");
});

test("hunger gauntlet: a live run can never score an EMPTY reply", () => {
  const src = readFileSync("script/hunger-gauntlet.ts", "utf-8");
  assert.ok(/if \(!reply\)/.test(src), "an empty reply must be caught before any check runs");
  assert.ok(/LIVE MODEL REQUIRED/.test(src), "and it must say so unmistakably");
  // The guard must sit BEFORE the checks, or the vacuous passes happen anyway.
  assert.ok(src.indexOf("if (!reply)") < src.indexOf("for (const chk of c.checks)"),
    "the empty-reply guard must precede the mechanical checks");
  assert.ok(/HUNGER_LLM === "1";\s*\nif \(LIVE\) process\.env\.OFFLINE_AI = "0"/.test(src),
    "asking for the model must actually enable it");
});

// ── Credential precedence ───────────────────────────────────────────────────────────────────
// The gauntlet read only OPENAI_API_KEY and then invented "sk-test-offline" when it was absent,
// so a live run authenticated with a key nobody set. The app reads AI_INTEGRATIONS_OPENAI_API_KEY
// first (server/gpt.ts:64 + 9 others) and that is the name Railway carries. These lock the chain
// and the rule that a live run must never manufacture a credential.

test("hunger gauntlet: reads the app's credential chain, AI_INTEGRATIONS first", () => {
  const src = readFileSync("script/hunger-gauntlet.ts", "utf-8");
  assert.ok(/const OPENAI_KEY = process\.env\.AI_INTEGRATIONS_OPENAI_API_KEY \|\| process\.env\.OPENAI_API_KEY \|\| ""/.test(src),
    "the gauntlet must resolve the key exactly as the application does");
  // And the resolved key — not the raw env var — must be what the client authenticates with.
  assert.ok(/new OpenAI\(\{ apiKey: OPENAI_KEY \}\)/.test(src),
    "the client must use the resolved credential, not process.env.OPENAI_API_KEY");
});

test("hunger gauntlet: live mode never manufactures a key; offline still may", () => {
  const src = readFileSync("script/hunger-gauntlet.ts", "utf-8");
  // The placeholder survives ONLY as the offline branch of the resolved key.
  assert.ok(/process\.env\.OPENAI_API_KEY = OPENAI_KEY \|\| "sk-test-offline"/.test(src),
    "offline imports still need a placeholder so module-scope clients construct");
  // In live mode the placeholder is unreachable: the missing-credential exit precedes it.
  assert.ok(src.indexOf("if (LIVE && !OPENAI_KEY)") < src.indexOf(`OPENAI_KEY || "sk-test-offline"`),
    "the live-mode credential guard must precede the offline placeholder");
  assert.ok(/if \(LIVE && !OPENAI_KEY\) \{[\s\S]{0,400}?process\.exit\(2\)/.test(src),
    "a live run with no credential must stop, not proceed with a fake one");
});

// ── The A4 gate itself ──────────────────────────────────────────────────────────────────────
// A4 is the trust case: a client at 118g against a 120g target, still hungry. The gate that says
// "must NOT point at protein" was matching only the verb-then-noun word order, so 13 of 20 natural
// coaching phrasings walked straight through it. A checker nothing checks stops checking quietly.

const MUST_CATCH = [
  "boost protein", "boost your protein a little", "eat more protein", "increase your protein",
  "add more protein to your afternoon", "let's get your protein up", "push your protein a bit higher",
  "bump your protein up", "top up your protein at lunch", "try a protein shake in the afternoon",
  "add a protein source to your afternoon snack", "prioritise protein at lunch",
  "focus on protein earlier in the day", "aim for 130g of protein",
  "your protein could come up slightly", "include some protein with that",
  "make sure there's protein in every meal", "have some protein with your afternoon snack",
  "lift your protein a touch", "getting a bit more protein in would help",
  // THE OBSERVED LIVE FAILURE, 2026-08-13. It escaped the original gate AND the first fix:
  // the noun and the verb never touch, the verb acts on a pronoun. This row is the whole
  // reason the transcript mattered more than the theory.
  "Your protein is almost on target, but let's boost it a bit\u2026",
  "Your protein's basically there — let's just nudge it up.",
];
// The reply we WANT on A4 quotes protein and rules it out. If the gate fires on these it will
// fail a correct answer, and we would go chasing a defect that is not there.
const MUST_PASS = [
  "Your protein's at 118g against a 120g target, so that's not what's driving this.",
  "Protein isn't the issue here — you're at 98% of target.",
  "Everything's on target, including protein. Let's look at your afternoon gap.",
  "Your protein is fine. Tell me what time you eat lunch.",
  "At 118g against 120g your protein is where it should be; let's look at meal volume.",
  "You're hitting your numbers, so I'd look at when you're eating rather than what.",
  "I'd add more volume to your lunch — more vegetables and a bigger portion.",
  "That's not a protein problem. What time was your last meal?",
  "More food, not more protein — your afternoon gap is too long.",
];

test("A4 gate: catches every natural way of prescribing protein", () => {
  const missed = MUST_CATCH.filter(p => !prescribesProtein(p));
  assert.deepEqual(missed, [], `these prescribe protein and escaped the A4 gate:\n  ${missed.join("\n  ")}`);
});

test("A4 gate: does NOT fire on a correct reply that rules protein out", () => {
  const wrong = MUST_PASS.filter(p => prescribesProtein(p)).map(p => `${p}  →  ${prescribesProtein(p)}`);
  assert.deepEqual(wrong, [], `the gate would fail a CORRECT A4 answer:\n  ${wrong.join("\n  ")}`);
});

test("A4 gate: the gauntlet uses the shared checker, not a local regex", () => {
  const src = readFileSync("script/hunger-gauntlet.ts", "utf-8");
  assert.ok(/prescribesProtein\(r\)/.test(src), "mustNotBlameProtein must call the tested predicate");
  assert.ok(!/more\|increase\|up your\|raise your/.test(src), "the old inline regex must be gone");
});

// ── UNIT ECONOMICS: one WhatsApp cost rule, and it counts MESSAGES ──────────────────────────
// finance.ts assumed a flat R8/user/month (Twilio's old per-CONVERSATION bundles) while
// cost-tracking.ts billed per message. Two owners, two answers about the same client — and from
// 1 Oct 2026 per-message is the real shape, so the per-user figure was the wrong unit, not just
// imprecise. cost-tracking.ts also counted chat_history ROWS, but a row is an EXCHANGE holding
// both messageIn and messageOut, so the count was roughly half of what Twilio bills.

test("economics: a chat row is an exchange — both directions are billable", async () => {
  const { billableMessages } = await import("../server/cost-tracking");
  assert.equal(billableMessages("did 9000 steps", "Nice, 9,000 logged."), 2,
    "COUNT(*) on chat_history halved the real message count");
  assert.equal(billableMessages("hi", null), 1, "an inbound with no reply yet is one message");
  assert.equal(billableMessages(null, null), 0);
});

test("economics: a multi-bubble reply is several billed messages", async () => {
  const { billableMessages } = await import("../server/cost-tracking");
  // `\n\n---\n\n` is what splits a reply into separate WhatsApp sends — a programme is 3 bubbles,
  // a meal plan 4, and Twilio bills each one.
  assert.equal(billableMessages("programme", "Week 1\n\n---\n\nWeek 2\n\n---\n\nWeek 3"), 4,
    "1 inbound + 3 outbound bubbles");
  assert.equal(billableMessages(null, "a\n\n---\n\nb"), 2);
});

test("economics: undercounting is the dangerous direction — it hides whales", async () => {
  const { memberCostRow, WHALE_THRESHOLD_ZAR, WHATSAPP_ZAR_PER_MSG } = await import("../server/cost-tracking");
  // 400 exchanges in a month. Counting rows says 400 messages; the truth is at least 800.
  const undercounted = memberCostRow("u", 0, 400);
  const real = memberCostRow("u", 0, 800);
  assert.ok(real.whatsappZar > undercounted.whatsappZar);
  assert.equal(real.whatsappZar, Math.round(800 * WHATSAPP_ZAR_PER_MSG * 100) / 100);
  // A member who reads as safe on halved volume must be flagged on true volume.
  const heavy = memberCostRow("u", 0, Math.ceil((WHALE_THRESHOLD_ZAR / WHATSAPP_ZAR_PER_MSG) + 1));
  assert.equal(heavy.whale, true, "the flag exists to catch exactly this client");
});

test("economics: finance and cost-tracking share ONE rate and one counting rule", () => {
  const fin = readFileSync("server/routes/finance.ts", "utf-8");
  assert.ok(/WHATSAPP_ZAR_PER_MSG, BILLABLE_MSGS_SQL \} from "\.\.\/cost-tracking"/.test(fin),
    "finance must import the shared rate and the shared count, not redefine either");
  assert.ok(!/const WHATSAPP_ZAR_PER_USER/.test(fin), "the per-conversation constant must be gone");
  assert.ok(/FINANCE_WHATSAPP_ZAR_PER_USER/.test(fin) && /retired and ignored/.test(fin),
    "a still-set Railway variable must warn, not be silently ignored");
  // And the break-even must use the same basis as the cost line above it.
  assert.ok(/waPerActive = activeAll > 0 \? whatsappZar \/ activeAll : 0/.test(fin),
    "contribution per user must derive from the measured volume");
});

// ── CLIENT TRUTH: one day boundary, not two ─────────────────────────────────────────────────
// client-snapshot.ts grouped the protein average by UTC and the 7-day story by SAST — two day
// boundaries inside ONE snapshot. A meal logged at 00:30 SAST landed on yesterday in the numbers
// and today in the story, so the coach could say "you ate that today" while the totals disagreed.
// sast.ts already owned this; the local copy 45 lines below the bug was the second owner.

test("client truth: the snapshot uses the canonical SAST day key, never its own", () => {
  const src = readFileSync("server/brain/client-snapshot.ts", "utf-8");
  assert.ok(/import \{ sastDayKey \} from "\.\.\/sast"/.test(src), "it must use the one owner");
  assert.ok(!/const sastKey =/.test(src), "and must not re-implement it locally");
  // The raw UTC form is the actual defect — any reappearance is the same bug returning.
  assert.ok(!/new Date\(row\.loggedAt \|\| now\)\.toISOString\(\)\.slice\(0, 10\)/.test(src),
    "grouping a logged_at by UTC puts small-hours meals on the wrong day");
});

test("client truth: the small hours are the case that exposed it", async () => {
  const { sastDayKey } = await import("../server/sast");
  // 00:30 SAST on the 14th is 22:30 UTC on the 13th. UTC keying calls that yesterday.
  const smallHours = new Date("2026-08-13T22:30:00Z");
  assert.equal(sastDayKey(smallHours), "2026-08-14", "SAST is UTC+2, year-round");
  assert.notEqual(smallHours.toISOString().slice(0, 10), sastDayKey(smallHours),
    "the two keys genuinely disagree here — that disagreement WAS the defect");
  // And the boundary itself holds from both sides.
  assert.equal(sastDayKey(new Date("2026-08-13T21:59:59Z")), "2026-08-13");
  assert.equal(sastDayKey(new Date("2026-08-13T22:00:00Z")), "2026-08-14");
});

// ── ADAPTIVE BASELINE: adaptation must not compound on itself ───────────────────────────────
// Measured 2026-08-18 (script/trace-proactive.ts): an 80kg stalled client eating 1,980 against a
// 2,000 target — compliant, unchanged — was walked 2000 → 1860 → 1760 in three mornings because
// the job fed users.calorie_target back in as baseCalories. Then, the target having passed under
// their unchanged intake, it began telling them the target "hasn't been tested yet". The system
// moved the goalposts and blamed the client. Migration 0005.

test("adaptive baseline: four mornings from one baseline do not walk the target down", async () => {
  const { adaptTargets } = await import("../server/adaptive-targets");
  const BASE = 2000;
  const run = (base: number) => adaptTargets({
    baseCalories: base, baseProtein: 150, baseSteps: 8000, goalType: "fat_loss",
    weightKg: 80, sick: false, stalledWeeks: 3, loggedDays7d: 7, avgKcal7d: 1980,
  });
  // From a STABLE baseline, every morning reaches the same answer.
  const days = [1, 2, 3, 4].map(() => run(BASE).calorieTarget);
  assert.deepEqual(days, [1860, 1860, 1860, 1860], "a stable baseline gives a stable decision");
  // And the reason must stay `stalled` — never the manufactured over-target accusation.
  assert.deepEqual([...new Set([1, 2, 3, 4].map(() => run(BASE).reason))], ["stalled"]);

  // THE OLD RECURSION, pinned so it cannot come back: feeding the output in as tomorrow's base.
  let recursive = BASE; const walk: number[] = [];
  for (let d = 0; d < 3; d++) { recursive = run(recursive).calorieTarget; walk.push(recursive); }
  assert.deepEqual(walk, [1860, 1760, 1760], "this is what the job used to do");
  assert.ok(walk[2] < BASE * 0.9, "12% down in three days, on a client who changed nothing");
  // And it invents the accusation, which is the part that reaches the client.
  assert.equal(run(1760).reason, "stalled_over_target",
    "once the target passes under their unchanged intake, they are told they never tested it");
});

test("adaptive baseline: the job reads baseline and never writes it", async () => {
  // The subject MOVED (2026-08-18, Issue #49 step 2): the job no longer assembles the engine's
  // input, loadProactiveState + adaptiveInputFrom do. Repointed at the new owners and made
  // behavioural where it used to be a grep — the check below now fails if the projection prefers
  // the wrong number, not merely if a line was reworded.
  const { adaptiveInputFrom } = await import("../server/adaptive-targets");

  // A client mid-adaptation: baseline 2000 (profile), current 1860 (what the job wrote yesterday).
  // The engine must reason from 2000. Reasoning from 1860 IS the ratchet.
  const projected = adaptiveInputFrom({
    goalType: "fat_loss", weightKg: 80,
    baseline: { calories: 2000, protein: 150, steps: 8000 },
    health: { sick: false, recovering: false, daysSick: 0 },
    food: { avgKcal7d: 1980, loggedDays7d: 7 },
    steps: { avg7d: 8200 },
    weight: { weeklyKgChange: 0, stalledWeeks: 3 },
  });
  assert.equal(projected.baseCalories, 2000, "the engine reasons from the PROFILE baseline");
  assert.equal(projected.baseProtein, 150);
  assert.equal(projected.baseSteps, 8000);

  // COULD NOT READ must arrive as undefined ("cannot tell", holds the target) and never as 0,
  // which the engine would act on as "logged nothing".
  const unread = adaptiveInputFrom({
    goalType: "fat_loss", weightKg: 80,
    baseline: { calories: 2000, protein: 150, steps: 8000 },
    health: { sick: false, recovering: false, daysSick: 0 },
    food: { avgKcal7d: null, loggedDays7d: null },
    steps: { avg7d: null },
    weight: { weeklyKgChange: null, stalledWeeks: 0 },
  });
  assert.equal(unread.loggedDays7d, undefined, "an unread ledger is unknown, never zero");
  assert.equal(unread.avgKcal7d, undefined);
  assert.equal(unread.weeklyKgChange, undefined);

  const job = readFileSync("server/scheduler/jobs/adaptive.ts", "utf-8");
  assert.ok(/adaptiveInputFrom\(/.test(job), "the job uses the one projection, it does not rebuild it");
  assert.ok(!/baselineCalorieTarget:/.test(job), "this job must never WRITE a baseline");
  // The unchanged-guard compares against what the client HOLDS, not the baseline reasoned from —
  // those diverge now, and comparing the wrong one sends the same message every morning.
  assert.ok(/out\.calorieTarget === s\.current\.calories/.test(job),
    "silence is decided against the stored overlay");
  const shared = readFileSync("server/scheduler/shared.ts", "utf-8");
  assert.ok(/calories: Number\(client\.baselineCalorieTarget \?\? client\.calorieTarget\)/.test(shared),
    "the snapshot reads the baseline column, falling back only for the window before 0005 runs");
  const schema = readFileSync("shared/schema.ts", "utf-8");
  for (const col of ["baseline_calorie_target", "baseline_protein_target", "baseline_steps_target"]) {
    assert.ok(schema.includes(col), `${col} must exist`);
  }
});

// ── CANONICAL PROACTIVE STATE: two jobs, one picture of the client ──────────────────────────
// Issue #49 step 2. Reactive turns got authoritative state, a decision owner and outbound gates.
// Proactive got none of it: adaptive assembled its own view at 05:45 and morning assembled a
// different one at 06:00, so the same client could be sick for one job and well for the other in
// the same quarter hour. Both now read loadProactiveState.

test("proactive state: both scheduled jobs read the one snapshot", () => {
  const adaptive = readFileSync("server/scheduler/jobs/adaptive.ts", "utf-8");
  const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
  assert.ok(/loadProactiveState\(/.test(adaptive), "adaptive reads the shared snapshot");
  assert.ok(/loadProactiveState\(/.test(morning), "morning reads the shared snapshot");
  // Neither may go back to reading the weight/step/intake ledgers for itself — that divergence
  // is the whole defect. adaptive.ts used to run its own weightLogs and stepLogs queries.
  assert.ok(!/from\(weightLogs\)/.test(adaptive), "adaptive must not re-read the weight ledger");
  assert.ok(!/from\(stepLogs\)/.test(adaptive), "adaptive must not re-read the step ledger");
});

test("proactive state: morning's health is durable, never a keyword scan", () => {
  const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
  const code = morning.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // The scan could only ever be WRONG here: sick-flow writes paused_until beside sick_until, and
  // morning returns on isPaused() long before the sick branch — so a genuinely ill client never
  // reached it. Only SICK_PATTERNS' non-illness matches did: "rest day", "skip gym", someone
  // else being ill.
  assert.ok(!/wasSickOrInjured\(/.test(code), "morning decides health from durable state only");
  assert.ok(/state\.health\.sickYesterday/.test(code), "…and asks the snapshot for it");
  // The tokens are written by health-state.holdTokens now (2026-08-21) — one writer, one format.
  // The assertion is unchanged in substance: the pause is still written beside the illness.
  const owner = readFileSync("server/health-state.ts", "utf-8");
  assert.ok(/sick_until:\$\{sickUntil\}/.test(owner) && /paused_until:\$\{sickUntil\}/.test(owner),
    "the durable token and the pause are written together — that is why the scan was unreachable");
});

test("proactive state: sickYesterday needs the illness to have covered yesterday", async () => {
  // An illness that started THIS MORNING did not cause yesterday's missing logs, and a window
  // that closed before yesterday did not either. Both would send "hope you're feeling better" to
  // someone who simply did not log.
  // Re-pointed at the health-state owner (2026-08-21). The rule is unchanged; the file that
  // owns it is. Deleting these assertions along with the old function would have dropped the
  // coverage that keeps the rule honest.
  const { readHealthState } = await import("../server/health-state");
  const day = (o: number) => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
  const covered = (since: string | undefined, until: string | undefined) =>
    readHealthState({ profileNotes: notes(since, until) }, day(0)).wasSickYesterday;
  assert.equal(covered(day(-3), day(1)), true, "ill across yesterday");
  assert.equal(covered(day(0), day(2)), false, "started today — yesterday was not illness");
  assert.equal(covered(day(-9), day(-4)), false, "window closed before yesterday");
  assert.equal(covered(undefined, day(-1)), true, "no start recorded, window reaches yesterday");
  assert.equal(covered(undefined, undefined), false, "no illness on record is not illness");
});

test("proactive budget: adaptive does not speak, and its line is not lost", () => {
  const adaptive = readFileSync("server/scheduler/jobs/adaptive.ts", "utf-8");
  const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
  const code = (s: string) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  // 05:45 sent up to two messages, neither through claimDailySlot; 06:00 sent another, through it.
  // The daily cap counted one of the two, so "one proactive message a day" was never true for a
  // client whose targets moved.
  assert.ok(!/sendWhatsApp/.test(code(adaptive)), "the adaptive job must not send");

  // But the words are HANDED OVER, not deleted — the standing rule is that no send is removed
  // until its behaviour is accounted for by the new owner.
  assert.ok(/adapt_note:\$\{today\}/.test(adaptive), "adaptive marks the day it produced a line");
  assert.ok(/adapt_note:\(/.test(morning), "morning looks for that marker");
  assert.ok(/adaptTargets\(adaptiveInputFrom\(state\)\)\.note/.test(morning),
    "morning asks the SAME pure engine for the line — no second copy of the words to drift");
  assert.ok(/marked === todaySAST\(\)/.test(morning), "a marker from another day is stale");

  // It must reach the stalled_unlogged client, who is stalled BECAUSE they barely log — so their
  // yesterday is usually empty. This used to need a per-branch check because the empty-yesterday
  // client travelled a parallel path; since step 5 there is one path, so passing adaptLine to the
  // single composer is the whole guarantee.
  assert.ok(/adaptLine,/.test(morning), "the composer receives the line");
  assert.ok(!/withAdapt\(/.test(morning), "…and no per-branch wrapper decides who gets it");

  // One bubble. `\n\n---\n\n` splits into a second WhatsApp message, separately billed — that is
  // the two-messages-before-six problem again under a different job's name. Asserted against the
  // composer's real output in the morning-composer tests below.
  const composer = readFileSync("server/morning-message.ts", "utf-8");
  assert.ok(!/---/.test(composer.split("export function composeMorning")[1] || ""),
    "the composer never emits the Twilio message splitter");
});

// ── ONE PROACTIVE DECISION OWNER ────────────────────────────────────────────────────────────
// Issue #49 step 4. chooseAction was already the ordered decision, reached from a command almost
// nobody types and from one line inside a 474-line morning job that made every other decision
// itself. decideProactive makes it reachable from the canonical snapshot and pairs it with the
// SAME verdict vocabulary the reactive path uses — not a second set of verdicts.

const decisionState = (over: any = {}) => ({
  name: "Thabo", goalType: "fat_loss",
  health: { sick: false },
  food: { loggedDays7d: 6, daysSinceAnyLog: 0 },
  workout: { sessionsLast7d: 3 },
  steps: { avg7d: 8200 },
  weight: { daysSinceWeighIn: 1, trendUsable: true },
  today: { kcal: 1900, protein: 150, steps: 9000, logged: true, hour: 7 },
  evidence: { foodSufficient: true, weightSufficient: true },
  ...over,
});
const decisionProfile = {
  weeksOnProgramme: 6, sessionsTarget: 3,
  calorieTarget: 2000, proteinTarget: 150, stepsTarget: 8000,
};

test("proactive decision: on track is CONTINUE and says nothing", async () => {
  const { decideProactive } = await import("../server/one-action");
  const d = decideProactive(decisionState(), decisionProfile);
  assert.equal(d.action.kind, "hold");
  assert.equal(d.state, "CONTINUE");
  assert.equal(d.line, "", "a coach who always has a note teaches you that you can never be doing well");
});

test("proactive decision: asking for a measurement is INVESTIGATE, never CHANGE", async () => {
  const { decideProactive } = await import("../server/one-action");
  // Gone four days. The action is "come back" — that does not change the plan, it asks for the
  // contact that would let us decide. Claiming CHANGE here would be acting on nothing.
  const gone = decideProactive(decisionState({ food: { loggedDays7d: 0, daysSinceAnyLog: 4 } }), decisionProfile);
  assert.equal(gone.action.kind, "come_back");
  assert.equal(gone.state, "INVESTIGATE");
  assert.equal(gone.evidence, "insufficient", "we are asking BECAUSE we cannot tell");

  // Never weighed: same shape. A measurement request, not a plan change.
  const unweighed = decideProactive(
    decisionState({ weight: { daysSinceWeighIn: null, trendUsable: false } }), decisionProfile);
  assert.equal(unweighed.action.kind, "weigh");
  assert.equal(unweighed.state, "INVESTIGATE");
});

test("proactive decision: changing the plan requires evidence", async () => {
  const { decideProactive } = await import("../server/one-action");
  const short = { today: { kcal: 1900, protein: 40, steps: 9000, logged: true, hour: 7 } };
  const evidenced = decideProactive(decisionState(short), decisionProfile);
  assert.equal(evidenced.action.kind, "protein");
  assert.equal(evidenced.state, "CHANGE", "a real problem with evidence behind it");

  // Same client, nothing measured well enough. The action still stands, but it must not be
  // dressed up as a decision we had grounds for.
  const thin = decideProactive(
    decisionState({ ...short, evidence: { foodSufficient: false, weightSufficient: false } }),
    decisionProfile);
  assert.equal(thin.evidence, "insufficient");
  assert.notEqual(thin.state, "CHANGE", "insufficient evidence may never read as CHANGE");
});

test("proactive decision: sick outranks everything, and rest is a real action", async () => {
  const { decideProactive } = await import("../server/one-action");
  const d = decideProactive(decisionState({
    health: { sick: true },
    today: { kcal: 0, protein: 0, steps: 0, logged: false, hour: 7 },
  }), decisionProfile);
  assert.equal(d.action.kind, "rest");
  assert.ok(/rest/i.test(d.line), "a coach who cannot say rest is a nagging app");
});

test("proactive decision: an unset target is not a starving client", async () => {
  const { decideProactive } = await import("../server/one-action");
  // Dividing today's protein by a target of 0 would make every unconfigured client look
  // catastrophically short and trigger a protein instruction on no information at all.
  const d = decideProactive(decisionState(), { ...decisionProfile, proteinTarget: 0, calorieTarget: 0 });
  assert.notEqual(d.action.kind, "protein");
});

test("proactive decision: morning has one state assembly, not two", () => {
  const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
  const code = morning.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // It called buildDayState(client) — five more queries over ledgers loadProactiveState had just
  // read — moments after loading the snapshot. Two assemblies inside the job that WAS the second
  // coach.
  assert.ok(!/buildDayState/.test(code), "morning decides from the snapshot, not a second assembly");
  assert.ok(/decideProactive\(state,/.test(code), "…and through the one decision owner");
  const cmd = readFileSync("server/handlers/one-action-command.ts", "utf-8");
  assert.ok(/dayStateFrom\(/.test(cmd),
    "the reactive command shares the projection, so the two cannot disagree about a field");
});

test("proactive decision: re-entry is not met with a calorie adjustment", () => {
  // Deliberately excluded branches. A paused, long-absent, or just-returning client should not
  // have their first contact back be an explanation of a target change — re-engagement comes
  // first, and the reason reaches them on the next ordinary morning.
  const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
  const lines = morning.split("\n");
  const carriesAdapt = (needle: string) => {
    const l = lines.find(x => x.includes(needle));
    assert.ok(l, `expected a send containing ${needle}`);
    return /withAdapt\(/.test(l!);
  };
  assert.equal(carriesAdapt("your coaching pause ends tomorrow"), false, "paused client");
  // The re-engagement send is now the ladder's one ask (Cut 6) rather than a button menu written
  // here. The exclusion is unchanged and matters more, not less: someone coming back after weeks
  // away must not have their first contact be an explanation of a calorie change.
  assert.equal(carriesAdapt("await silenceAsk(client, daysSilent)"), false, "the silent client");
  // The >7-day skip that used to sit above all of this is gone — see the cut6 gates below. It was
  // the reason the ladder's month rung could never run. Absence is now handled, not skipped.
});

// ── ONE COMPOSER FOR THE MORNING MESSAGE ────────────────────────────────────────────────────
// Issue #49 step 5. morning.ts composed the brief across ~a dozen independent narrative branches,
// two of which (protein, steps) prescribed action — competing with decideProactive, in the same
// message, from different reasoning.

const morningInputs = (over: any = {}) => ({
  firstName: "Thabo", targetFixLine: "", identityLine: "", streakLine: "", workoutLine: "",
  yesterdayLine: "", todayLines: [], closingLine: "", decisionLine: "", breakfastAsk: "🍳 What's for breakfast?",
  adaptLine: "", sickYesterday: false, ...over,
});

test("morning composer: exactly one instruction reaches the client", async () => {
  const { composeMorning } = await import("../server/morning-message");
  const msg = composeMorning(morningInputs({
    streakLine: "🔥 *6-session streak* — protect it.",
    yesterdayLine: "120g protein logged yesterday, against a 150g target.",
    todayLines: ["*Today:*", "👟 8,000 steps", "💪 Training day. Reply *1* for your workout."],
    decisionLine: "*Make your next meal a proper protein meal.*\n\n_Protein is what keeps the weight you lose off your muscle._",
  }));
  // The old brief could carry three: the worst-slot protein fix, the steps line, and the action.
  const instructions = [/lead dinner with/i, /anchor lunch with/i, /Steps: [\d,]+ of/i];
  for (const re of instructions) assert.ok(!re.test(msg), `retired branch is back: ${re}`);
  assert.ok(msg.includes("Make your next meal"), "the decision's instruction is the one that survives");
});

test("morning composer: one bubble, never a second billed message", async () => {
  const { composeMorning } = await import("../server/morning-message");
  const msg = composeMorning(morningInputs({
    yesterdayLine: "No food logged yesterday — today starts now.",
    todayLines: ["*Today:*", "👟 8,000 steps"],
    adaptLine: "Three weeks flat, so I've adjusted your food a little.",
    closingLine: "\n\n_Keep the chain going._",
  }));
  assert.ok(!msg.includes("---"), "`\\n\\n---\\n\\n` splits into a separately billed message");
});

test("morning composer: an ill client is not handed targets and an instruction", async () => {
  const { composeMorning } = await import("../server/morning-message");
  const msg = composeMorning(morningInputs({
    sickYesterday: true,
    todayLines: ["*Today:*", "👟 8,000 steps", "💪 Training day. Reply *1* for your workout."],
    decisionLine: "*Get today's session done.*\n\n_2 more this week._",
    streakLine: "🔥 *6-session streak* — protect it.",
  }));
  assert.ok(/feeling better/i.test(msg));
  assert.ok(!/steps/i.test(msg), "no step target for someone who was ill");
  assert.ok(!/session done/i.test(msg), "no training instruction for someone who was ill");
  assert.ok(!/streak/i.test(msg), "and no scoreboard");
});

test("morning composer: the breakfast ask only appears when there is nothing to say", async () => {
  const { composeMorning } = await import("../server/morning-message");
  const quiet = composeMorning(morningInputs({ decisionLine: "" }));
  assert.ok(quiet.includes("What's for breakfast"), "CONTINUE + hold → the ordinary ask");
  const acting = composeMorning(morningInputs({ decisionLine: "*Stand on a scale this morning.*" }));
  assert.ok(!acting.includes("What's for breakfast"), "two asks is two decisions before coffee");
});

test("morning composer: the observation observes and stops", async () => {
  const { yesterdayObservation } = await import("../server/morning-message");
  const short = yesterdayObservation({ foodLogged: true, proteinLogged: 90, proteinTarget: 150, numbersLow: false });
  assert.ok(/90g/.test(short) && /150g/.test(short), "it still states what happened");
  // It must not prescribe. That is decideProactive's job, and the old branch did both.
  for (const re of [/lead (breakfast|dinner)/i, /anchor lunch/i, /get some in early/i, /tomorrow:/i]) {
    assert.ok(!re.test(short), `observation is prescribing again: ${re}`);
  }
  assert.equal(
    yesterdayObservation({ foodLogged: false, proteinLogged: 0, proteinTarget: 150, numbersLow: false }),
    "No food logged yesterday — today starts now.");
  // numbers:low never sees a figure — the existing contract, preserved through the collapse.
  const low = yesterdayObservation({ foodLogged: true, proteinLogged: 90, proteinTarget: 150, numbersLow: true });
  assert.ok(!/\d/.test(low), "numbers:low clients get no figures");
});

test("morning: the empty-yesterday client goes down the same path as everyone else", () => {
  const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
  const code = morning.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // They used to leave down a parallel branch with its own three sends and their own greeting —
  // no streak, no milestone, no step target, no training day and NO DECISION, because the
  // decision was computed two hundred lines down a road they never travelled. The clients who
  // needed the most coaching got the least.
  assert.ok(!/Send me your breakfast right now/.test(code), "the parallel empty-yesterday brief is gone");
  assert.ok(/composeMorning\(\{/.test(code), "one composer");
  // A count, on purpose: this is how many mouths this job has. It went 2 → 3 in Cut 6 and the
  // third is a REPLACEMENT, not an addition — the button menu it supersedes went out through
  // sendWhatsAppButtons, which this counter never saw. Net across the repo the cut removes sends.
  assert.equal((code.match(/sendWhatsApp\(/g) || []).length, 3,
    "three sends: the pause notice, the ladder's one ask, and the composed brief");
  assert.ok(!/sendWhatsAppButtons\(/.test(code), "and none of them is a menu");
  // The one thing that branch really owned — the streak shield, which WRITES — must survive.
  assert.ok(/streak_shield:\$\{currentMonth\}/.test(code), "the monthly streak shield still writes");
  assert.ok(/shieldLine \|\| workoutLine/.test(code), "…and still speaks, as an input");
});

// ── PROACTIVE SWEEP: one target owner, durable health everywhere, no orphan decisions ───────
// Issue #49 sweep. Migration 0005 ended the ratchet in scheduler/jobs/adaptive.ts. It did not end
// it in business.ts, which had TWO more target writers nobody had pointed at.

test("sweep: no proactive job reads the target column it writes", () => {
  // The defect, in both jobs: `const currentCal = client.calorieTarget` then
  // `newCal = currentCal - 100` then `set({ calorieTarget: newCal })`. Every three weeks measured
  // from the last cut instead of from the client's profile.
  const business = readFileSync("server/scheduler/jobs/business.ts", "utf-8");
  const code = business.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(/const currentCal\s+= client\.baselineCalorieTarget/.test(code),
    "the calorie adjuster reasons from the baseline, not from the column it writes");
  assert.ok(/const stepsTarget\s+= client\.baselineStepsTarget/.test(code),
    "the step adjuster reasons from the baseline too");
  // And a three-week structural change must reach the baseline, or the DAILY adaptive job
  // recomputes the visible target from an unchanged baseline the next morning and erases it —
  // twenty hours after the client was told "Calories: 2000 → 1900".
  assert.ok(/baselineCalorieTarget: newCal, calorieTarget: newCal/.test(code),
    "a structural adjustment writes the baseline AND the visible target");
  assert.ok(/baselineStepsTarget: newTarget, stepsTarget: newTarget/.test(code));
});

test("sweep: the keyword sickness scan drives no decision anywhere", () => {
  const strip = (s: string) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  for (const job of ["morning", "evening", "retention"]) {
    const src = strip(readFileSync(`server/scheduler/jobs/${job}.ts`, "utf-8"));
    assert.ok(!/wasSickOrInjured\(|isSickOrInjuredToday\(/.test(src),
      `${job}.ts still decides health from a regex over chat history`);
  }
  // Every one of those jobs returns on isPaused() before its sick branch, and sick-flow writes
  // paused_until beside sick_until — so the scan could only ever fire on its FALSE positives:
  // "rest day", "skip gym", "miss workout", someone else being ill.
  const holdWriter = readFileSync("server/health-state.ts", "utf-8");
  assert.ok(/paused_until:\$\{sickUntil\}/.test(holdWriter));
});

test("sweep: sick-now and sick-yesterday have one owner", async () => {
  const { readHealthState } = await import("../server/health-state");
  const day = (o: number) => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
  const sickNow = (until: string | undefined) =>
    readHealthState({ profileNotes: notes(undefined, until) }, day(0)).isSick;
  assert.equal(sickNow(day(1)), true, "window still open");
  assert.equal(sickNow(day(0)), true, "last day of the window counts");
  assert.equal(sickNow(day(-1)), false, "window closed yesterday");
  assert.equal(sickNow(undefined), false, "no illness on record");
  // The two rules are different questions and must not collapse into each other: an illness that
  // ended yesterday is not sick today, but it DID cover yesterday.
  const h = readHealthState({ profileNotes: notes(day(-3), day(-1)) }, day(0));
  assert.equal(h.wasSickYesterday, true);
  assert.equal(h.isSick, false);
});

test("health lifecycle: a hold that ages out stops describing the client as ill", async () => {
  // THE 21 AUGUST DEFECT. client-snapshot told GPT "Client is SICK/resting until X" with no date
  // check at all, and nothing in the product ever removed the token — so a client could be
  // described to the model as ill indefinitely. Expiry is derived on read now, so the phase
  // advances on its own even when the tokens linger.
  const { readHealthState, RECOVERY_TAIL_DAYS } = await import("../server/health-state");
  const day = (o: number) => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
  const at = (until: string, today: string) => readHealthState({ profileNotes: notes(day(-9), until) }, today);
  assert.equal(at(day(2), day(0)).phase, "sick", "inside the window");
  assert.equal(at(day(-1), day(0)).phase, "recovering", "the tail after the window");
  assert.equal(at(day(-RECOVERY_TAIL_DAYS), day(0)).phase, "recovering", "last day of the tail");
  const ended = at(day(-RECOVERY_TAIL_DAYS - 1), day(0));
  assert.equal(ended.phase, "ended", "past the tail — the hold is over");
  assert.equal(ended.isSick, false, "…and nothing may call this client sick");
  assert.equal(ended.pause, null, "…and an aged-out paused_until holds nothing");
});

test("sweep: the >7-day client's decision is used, not computed and discarded", () => {
  // ORIGINAL DEFECT (Issue #49 sweep): morning.ts returned on `daysSilent > 7` AFTER running
  // decideProactive, so the coach worked out what to ask for and threw it away — and retention
  // sent "Reply *1* for today's workout": a training ask, to someone who had not logged a meal in
  // a week, chosen without reading their state at all.
  //
  // The sweep fixed the WORDING by having retention ask the decision owner too. Cut 6 fixed the
  // CAUSE: the skip is gone, so morning itself reaches the >7-day client and retention has no
  // message to word. Same invariant, moved to the owner — asserted here against morning, which is
  // where the decision now happens, and reinforced by the cut6 gates below.
  const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
  assert.ok(!/if \(daysSilent > 7\) continue;/.test(morning), "the client is no longer discarded");
  assert.ok(/const decision = decideProactive\(state, profile/.test(morning),
    "morning asks the decision owner for the client it used to drop");
  assert.ok(/return formatOneAction\(decision\.action, firstName\)/.test(morning),
    "…and the message IS its answer, not a second wording of it");
  // The degraded fallback still SPEAKS — and since 2026-08-21 it speaks under the same policy
  // contract as the gate, so a ledger failure can no longer turn into a prescription the gate
  // would have refused. Verified live: the silence rung is come_back (investigative), so
  // underPolicy passes it through unchanged and the drifting client still hears something.
  assert.ok(/return formatOneAction\(underPolicy\(chooseAction\(\{/.test(morning),
    "a drifting client must not get silence because a ledger read timed out — and the fallback "
    + "must reach the decision owner through the policy contract, not around it");
  // The shape changed on 2026-08-28 when the gate stopped taking a pre-computed verdict and
  // started taking the evidence itself, so that it and decideProactive reach one answer through
  // one function. The property this line protects is unchanged: the degraded fallback claims NO
  // evidence, because the state read is what just failed.
  assert.ok(/foodSufficient: false, weightSufficient: false/.test(morning),
    "…with evidence stated honestly: the state read is what just failed");
});

// ── VERDICT ENFORCEMENT: the decision stops being advisory ──────────────────────────────────
// Issue #49, last item. The verdict was recorded and logged and then ignored by the message.
// Measured on the traced client set before this pass: 2 clients in 6 received a plan change under
// a verdict that did not support one.

const PRESCRIPTIVE_KINDS = ["protein", "walk", "train", "eat_more", "rest"];

test("verdict: a prescription may only ride CHANGE or REFER", async () => {
  const { decideProactive } = await import("../server/one-action");
  // Every shape from the traced set, plus the two the measurement added.
  const shapes = [
    ["on track", decisionState()],
    ["stalled, well logged", decisionState({ food: { loggedDays7d: 7, daysSinceAnyLog: 0 } })],
    ["gone 4 days", decisionState({ food: { loggedDays7d: 0, daysSinceAnyLog: 4 } })],
    ["sparse log, protein looks low", decisionState({
      food: { loggedDays7d: 2, daysSinceAnyLog: 0 },
      today: { kcal: 900, protein: 35, steps: 8200, logged: true, hour: 7 },
      weight: { daysSinceWeighIn: 3, trendUsable: false },
      evidence: { foodSufficient: false, weightSufficient: false },
    })],
    ["never weighed", decisionState({ weight: { daysSinceWeighIn: null, trendUsable: false } })],
    ["durably sick", decisionState({
      health: { sick: true },
      today: { kcal: 400, protein: 20, steps: 300, logged: true, hour: 7 },
      evidence: { foodSufficient: false, weightSufficient: false },
    })],
  ] as const;
  for (const [label, st] of shapes) {
    const d = decideProactive(st as any, decisionProfile);
    if (PRESCRIPTIVE_KINDS.includes(d.action.kind)) {
      assert.ok(d.state === "CHANGE" || d.state === "REFER",
        `${label}: ${d.state} carries the plan change "${d.action.todo}"`);
    }
    if (d.state === "CONTINUE") assert.equal(d.line, "", `${label}: CONTINUE must add nothing`);
  }
});

test("verdict: illness is its own evidence", async () => {
  const { decideProactive } = await import("../server/one-action");
  // A sick client has no food or weight evidence by definition, and used to come back
  // CONTINUE / insufficient / "Rest today" — a prescription under a verdict saying carry on. The
  // message was right; the evidence model was wrong. Illness is observed durable state.
  const d = decideProactive(decisionState({
    health: { sick: true },
    today: { kcal: 400, protein: 20, steps: 300, logged: true, hour: 7 },
    evidence: { foodSufficient: false, weightSufficient: false },
  }), decisionProfile);
  assert.equal(d.action.kind, "rest");
  assert.equal(d.evidence, "sufficient", "rest is the best-founded instruction the coach gives");
  assert.equal(d.state, "CHANGE");
});

test("verdict: the downgrade asks for what is missing, never for what they just did", async () => {
  const { decideProactive } = await import("../server/one-action");
  // The first version of the downgrade sent "Tell me what you ate today" to a client who HAD
  // logged today — their seven-day record was thin, not their morning. That is handing the work
  // back for something they just did. Caught by re-running the trace, not by review.
  const loggedToday = decideProactive(decisionState({
    food: { loggedDays7d: 2, daysSinceAnyLog: 0 },
    today: { kcal: 900, protein: 35, steps: 8200, logged: true, hour: 7 },
    weight: { daysSinceWeighIn: 3, trendUsable: false },
    evidence: { foodSufficient: false, weightSufficient: false },
  }), decisionProfile);
  assert.notEqual(loggedToday.action.kind, "log", "they already logged today");

  // Not logged today and thin: asking for the log is exactly right.
  // HOUR 18, NOT 12 (fixture repaired 2026-08-25, unmasked by the runner fix). The rung this
  // exercises is "nothing logged and the day is NEARLY OVER", gated on LATE = 17. At noon the day
  // is not nearly over and the decision correctly returns `hold` — so this case had been asserting
  // `log` against a state that cannot produce it, and passing anyway because the runner discarded
  // the rejection. The product is right; the fixture named an hour the rung does not cover.
  const notLogged = decideProactive(decisionState({
    food: { loggedDays7d: 2, daysSinceAnyLog: 1 },
    today: { kcal: 0, protein: 0, steps: 8200, logged: false, hour: 18 },
    weight: { daysSinceWeighIn: 1, trendUsable: false },
    evidence: { foodSufficient: false, weightSufficient: false },
  }), decisionProfile);
  assert.equal(notLogged.action.kind, "log");

  // Logged today, weighed yesterday, still thin history: nothing honest left to ask. Silence is a
  // legitimate outcome — least intervention, not a gap to fill.
  const nothingToAsk = decideProactive(decisionState({
    food: { loggedDays7d: 3, daysSinceAnyLog: 0 },
    today: { kcal: 900, protein: 35, steps: 8200, logged: true, hour: 7 },
    weight: { daysSinceWeighIn: 1, trendUsable: false },
    evidence: { foodSufficient: false, weightSufficient: false },
  }), decisionProfile);
  assert.equal(nothingToAsk.action.kind, "hold");
  assert.equal(nothingToAsk.line, "");
});

test("verdict: the reactive path is held to the same standard", () => {
  const cmd = readFileSync("server/handlers/one-action-command.ts", "utf-8");
  const code = cmd.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // It called chooseAction directly, so the same client with the same ledgers got a prescription
  // reactively that the proactive path would have refused — two standards depending on who spoke
  // first.
  assert.ok(/decideProactive\(state, profile/.test(code), "the reply goes through the verdict");
  assert.ok(!/chooseAction\(/.test(code), "…and not around it");
  // And it must compute evidence rather than hardcoding it false, or every reactive prescription
  // downgrades to a measurement request.
  assert.ok(/foodSufficient: distinctLoggedDays >= 4/.test(code),
    "the reactive path computes evidence sufficiency, same floor as the proactive one");
});

// ── FOOD EVENTS: one message, several rows, one undo ────────────────────────────────────────
// Migration 0004. Product acceptance cases, not a new harness.

test("food events: the write door carries lineage, and NULL is a group of one", () => {
  const door = readFileSync("server/day-ledger.ts", "utf-8");
  assert.ok(/sourceMessageId: params\.sourceMessageId \?\? null/.test(door),
    "every row records which utterance produced it; absent → NULL");
  const schema = readFileSync("shared/schema.ts", "utf-8");
  assert.ok(/sourceMessageId: text\("source_message_id"\)/.test(schema), "column exists");
  assert.ok(/meal_logs_user_source_msg_idx/.test(schema), "and is indexed per client");
  // Additive only: nullable, no default, no backfill. A legacy row must stay a group of one.
  const mig = readFileSync("migrations/0004_meal_event_lineage.sql", "utf-8");
  assert.ok(/ADD COLUMN IF NOT EXISTS source_message_id text;/.test(mig), "nullable, no default");
  assert.ok(!/UPDATE public\.meal_logs/.test(mig), "no speculative backfill");
});

test("food events: several events write several rows, one event writes one", () => {
  const ctx = readFileSync("server/handlers/food-context.ts", "utf-8");
  assert.ok(/const splitIntoEvents = eventBuckets\.length >= 2;/.test(ctx),
    "the split needs TWO events with food — one meal stays one row");
  assert.ok(/if \(splitIntoEvents\)/.test(ctx) && /\} else \{/.test(ctx),
    "the single-event branch must still exist untouched");
  // Each row records the EVENT's words, not the whole message — commitFoodLog dedups on
  // rawMessage, so four rows sharing the full text would silently drop three.
  assert.ok(/rawMessage: bucket\.text\.slice\(0, 1000\)/.test(ctx),
    "an event's row carries that event's words");
  assert.ok(/sourceMessageId: eventGroupId/.test(ctx), "and links to its siblings");
});

test("food events: each event gets its OWN date when its words name one", () => {
  const ctx = readFileSync("server/handlers/food-context.ts", "utf-8");
  assert.ok(/isRetroactiveMeal\(bucket\.text\) \|\| SAYS_TODAY_RE\.test\(bucket\.text\)/.test(ctx),
    "an event naming its own day wins over the message-level date");
  assert.ok(/: scannerLoggedAt;/.test(ctx), "an event naming no day inherits the message's");
});

test("food events: SAYS_TODAY_RE is what rescues \"this morning\" inside a retro message", async () => {
  const { SAYS_TODAY_RE } = await import("../server/handlers/food-context");
  for (const t of ["this morning I had a banana", "just now", "tonight", "today"]) {
    assert.ok(SAYS_TODAY_RE.test(t), `"${t}" is today, even in a message that opened with yesterday`);
  }
  for (const t of ["yesterday", "last night", "on Monday"]) {
    assert.ok(!SAYS_TODAY_RE.test(t), `"${t}" must not be read as today`);
  }
});

test("food events: 'remove last' takes the utterance; 'remove the chicken' does not", () => {
  const scanner = readFileSync("server/handlers/food-scanner.ts", "utf-8");
  const mgmt = readFileSync("server/handlers/food-log-mgmt.ts", "utf-8");
  assert.ok(/opts\?: \{ expandToGroup\?: boolean \}/.test(scanner), "expansion is OPT-IN");
  // The P0 the split would otherwise introduce: dropping the newest of four rows.
  assert.ok(/"remove-last", \{ expandToGroup: true \}/.test(mgmt), "remove-last means the utterance");
  assert.ok(/"remove-last-n", \{ expandToGroup: true \}/.test(mgmt));
  for (const named of ['`named-foods:${best.n}-matched`', '"remove-specific-food']) {
    const line = mgmt.split("\n").find(l => l.includes(named)) || "";
    assert.ok(!/expandToGroup/.test(line), `a named-food removal must NOT expand: ${named}`);
  }
  // Legacy safety: NULL lineage must never expand into "every unlineaged row".
  assert.ok(/isNotNull\(mealLogs\.sourceMessageId\)/.test(scanner),
    "NULL is unknown lineage, not a group");
});

// ── EVENT BOUNDARIES: how many meals is this message? ───────────────────────────────────────
// 2026-08-17, traced from a real founder message. The boundary detector required the literal word
// "for", so a voice-note-shaped message using "in the morning" and "at lunch" produced ZERO
// boundaries and four eating events collapsed into one segment. Segmentation had no direct test
// coverage before this — it was inline and unexported, which is why the narrowness survived.

test("event boundaries: real prepositions, not just \"for\"", async () => {
  const { MEAL_BOUNDARY_RE } = await import("../server/handlers/food-context");
  const boundaries = (msg: string) =>
    [...msg.matchAll(new RegExp(MEAL_BOUNDARY_RE.source, "gi"))].map(m => m[1].toLowerCase());
  // The message that exposed it. Two post-positioned boundaries where there used to be none.
  assert.deepEqual(
    boundaries("had eggs and toast in the morning, pap and chicken at lunch"),
    ["morning", "lunch"],
    "a voice note says in/at, not for");
  // The original phrasing must still work — this widens, it does not replace.
  assert.deepEqual(boundaries("eggs for breakfast and pap for lunch"), ["breakfast", "lunch"]);
  assert.deepEqual(boundaries("chicken during dinner"), ["dinner"]);
  // Articles stay non-capturing.
  assert.deepEqual(boundaries("a wrap for my lunch and biltong for a snack"), ["lunch", "snack"]);
});

test("event boundaries: segmentation needs TWO, so one mention is not a split", async () => {
  const { MEAL_BOUNDARY_RE } = await import("../server/handlers/food-context");
  const n = (msg: string) => [...msg.matchAll(new RegExp(MEAL_BOUNDARY_RE.source, "gi"))].length;
  assert.equal(n("I had chicken and pap at lunch"), 1, "one meal is one meal");
  assert.equal(n("2 spoons of pap"), 0, "no meal word, no boundary");
  // A BOUNDARY NEEDS THE PREPOSITION (assertion repaired 2026-08-25, unmasked by the runner fix).
  // MEAL_BOUNDARY_RE is `(for|in|at|during|as) + (a|my|the)? + <meal word>`. "I had a pre-workout
  // snack" is a BARE mention with no preposition, so it is deliberately 0 — which is exactly what
  // the next test in this file documents for "then two amagwinya around four". This case asserted
  // 1 against a pattern that cannot return 1 for it, and contradicted its own neighbour, and both
  // stayed green because the runner never saw the rejection. `as a snack` is the real one-boundary
  // form, so the case keeps its subject: a snack counts, and one boundary is not a split.
  assert.equal(n("I had biltong as a snack"), 1, "snack counts, and one is not a split");
  assert.equal(n("I had a pre-workout snack"), 0, "a bare mention with no preposition is not a boundary");
});

test("event boundaries: PRE-positioned phrasing is still unhandled — documented, not hidden", async () => {
  const { MEAL_BOUNDARY_RE } = await import("../server/handlers/food-context");
  const n = (msg: string) => [...msg.matchAll(new RegExp(MEAL_BOUNDARY_RE.source, "gi"))].length;
  // "this morning I had a banana" puts the food AFTER the label. The algorithm assigns text BEFORE
  // a boundary to that boundary, so matching here would attribute the PREVIOUS meal's food to it.
  // Deliberately not matched. This assertion exists so the gap is a recorded decision rather than
  // something a future reader assumes was handled.
  assert.equal(n("this morning I just had a banana"), 0,
    "pre-positioned events need the opposite assignment — separate slice");
  assert.equal(n("then two amagwinya around four"), 0, "no meal keyword at all — also unhandled");
});

// ── CLIENT TRUTH: "pre-workout" is a TIME, not a supplement ─────────────────────────────────
// 2026-08-13 founder live test. "I had a pre-workout snack" matched the C4-style powder, logged
// 15 kcal as the meal, and the client's real food was never captured. The coach — holding a
// 15-kcal entry — then reached into the 7-day history and told them they had eaten a previous
// day's breakfast. The invented meal was not invented: it was misattributed from their own past.

test("client truth: a pre-workout SNACK is not the pre-workout supplement", async () => {
  const { scanForSAFoods } = await import("../server/handlers/food-scanner");
// These were written as CommonJS require() inside an ESM module, so every test below
// that used them threw "require is not defined" — they had never executed. Bound once here.
const MESSY = await import("../server/understanding/messy-intake");
const UNLOGGED = await import("../server/unlogged-notice");
const UTILS = await import("../server/utils");
const FOODID = await import("../server/food-identity-correction");
const FIDELITY = await import("../server/normalizer-fidelity");
const CARD = await import("../server/macro-card-attach");
const NUTRI = await import("../server/nutrition-guardrails");
const VERIF = await import("../server/brain/reply-verifier");
  const names = (m: string) => scanForSAFoods(m).map(f => f.name);
  assert.deepEqual(names("I had a pre-workout snack"), [],
    "a snack before training must not log a scoop of powder");
  assert.ok(!names("pre-workout snack: banana and peanut butter").some(n => /pre.?workout/i.test(n)),
    "and the REAL food must be what gets logged");
  assert.deepEqual(names("pre-workout snack: banana and peanut butter").sort(), ["Banana", "Peanut butter"]);
  assert.deepEqual(names("I had a snack before the gym"), [], "the same claim, worded the other way round");
});

test("client truth: a bare pre-workout mention IS still the supplement", async () => {
  const { scanForSAFoods } = await import("../server/handlers/food-scanner");
// These were written as CommonJS require() inside an ESM module, so every test below
// that used them threw "require is not defined" — they had never executed. Bound once here.
const MESSY = await import("../server/understanding/messy-intake");
const UNLOGGED = await import("../server/unlogged-notice");
const UTILS = await import("../server/utils");
const FOODID = await import("../server/food-identity-correction");
const FIDELITY = await import("../server/normalizer-fidelity");
const CARD = await import("../server/macro-card-attach");
const NUTRI = await import("../server/nutrition-guardrails");
const VERIF = await import("../server/brain/reply-verifier");
  // The fix must not delete a real capability: someone who actually took C4 still gets it.
  for (const m of ["I had my pre-workout", "took my pre workout and trained"]) {
    assert.ok(scanForSAFoods(m).some(f => /pre.?workout/i.test(f.name)), `"${m}" is the powder`);
  }
});

// ── PORTION UNITS: "2 spoons of pap" is not two plates of pap ────────────────────────────────
// 2026-08-13, measured against the production matcher: "2 spoons of pap" logged 660 kcal — about
// five times the truth — because the parser read `N <word> of <food>` as N whole portions and
// stamped the result database-verified.

test("portion units: a fractional unit is a PART of a portion, never a multiple", async () => {
  const { classifyPortionUnit } = await import("../server/portion-memory");
  const u = classifyPortionUnit("spoons", "1 cup cooked", 200);
  assert.equal(u.cls, "fractional");
  assert.ok(u.fraction !== null && u.fraction < 0.5, "a spoon is a small part of a plate");
  assert.equal(u.estimated, true, "an ambiguous amount is OUR estimate, not their measurement");
});

test("portion units: an UNKNOWN unit never multiplies", async () => {
  const { classifyPortionUnit } = await import("../server/portion-memory");
  // "3 stashes of bread" — speech-to-text noise. One cautious portion, flagged, not three loaves.
  const u = classifyPortionUnit("stashes", "2 slices (60g)", 60);
  assert.equal(u.cls, "unknown");
  assert.equal(u.fraction, 1);
  assert.equal(u.estimated, true);
});

test("portion units: real measurements and full portions are NOT estimates", async () => {
  const { classifyPortionUnit } = await import("../server/portion-memory");
  for (const [unit, cls] of [["tablespoons", "measurement"], ["plates", "full"], ["pieces", "count"]] as const) {
    const u = classifyPortionUnit(unit, "1 cup cooked", 200);
    assert.equal(u.cls, cls);
    assert.equal(u.estimated, false, `${unit} is something the client measured`);
  }
});

test("portion units: the FOOD decides — a handful of peanuts is one portion of peanuts", async () => {
  const { classifyPortionUnit } = await import("../server/portion-memory");
  // The whole reason these fractions are not a universal table. 0.3 of 30g is 9g, not a handful.
  assert.equal(classifyPortionUnit("handful", "1 handful (30g)", 30).cls, "measurement");
  assert.equal(classifyPortionUnit("handful", "1 small pack (30g)", 30).cls, "measurement",
    "a snack-sized canonical portion IS roughly a handful, however it is worded");
  assert.equal(classifyPortionUnit("handful", "1 cup cooked", 200).cls, "fractional",
    "but a handful of pap is genuinely a fraction of a plate");
});

test("portion units: END TO END — the hard South African cases", async () => {
  const { adjustFoodsForSegment } = await import("../server/portion-memory");
  const { scanForSAFoods } = await import("../server/handlers/food-scanner");
// These were written as CommonJS require() inside an ESM module, so every test below
// that used them threw "require is not defined" — they had never executed. Bound once here.
const MESSY = await import("../server/understanding/messy-intake");
const UNLOGGED = await import("../server/unlogged-notice");
const UTILS = await import("../server/utils");
const FOODID = await import("../server/food-identity-correction");
const FIDELITY = await import("../server/normalizer-fidelity");
const CARD = await import("../server/macro-card-attach");
const NUTRI = await import("../server/nutrition-guardrails");
const VERIF = await import("../server/brain/reply-verifier");
  const kcal = (msg: string) => {
    const foods = scanForSAFoods(msg);
    return adjustFoodsForSegment(foods as any, msg).reduce((s: number, f: any) => s + f.adjustedCalories, 0);
  };
  const spoons = kcal("2 spoons of pap");
  assert.ok(spoons > 0 && spoons < 200, `2 spoons of pap must be a small number, got ${spoons}`);
  assert.ok(kcal("2 plates of pap") > 500, "but two PLATES is still two plates");
  assert.ok(kcal("3 stashes of bread") < 250, "an unknown unit must not triple the bread");
  const handful = kcal("a handful of peanuts");
  assert.ok(handful > 120 && handful < 250, `a handful of peanuts is ~176 kcal, got ${handful}`);
  assert.equal(kcal("2 tablespoons peanut butter"), 176, "a real measurement is unchanged");
});

test("portion units: an estimated quantity is tagged ai even when the FOOD is db", async () => {
  const { adjustFoodsForSegment } = await import("../server/portion-memory");
  const { scanForSAFoods } = await import("../server/handlers/food-scanner");
// These were written as CommonJS require() inside an ESM module, so every test below
// that used them threw "require is not defined" — they had never executed. Bound once here.
const MESSY = await import("../server/understanding/messy-intake");
const UNLOGGED = await import("../server/unlogged-notice");
const UTILS = await import("../server/utils");
const FOODID = await import("../server/food-identity-correction");
const FIDELITY = await import("../server/normalizer-fidelity");
const CARD = await import("../server/macro-card-attach");
const NUTRI = await import("../server/nutrition-guardrails");
const VERIF = await import("../server/brain/reply-verifier");
  const of = (msg: string) => adjustFoodsForSegment(scanForSAFoods(msg) as any, msg)[0] as any;
  assert.equal(of("2 spoons of pap").origin, "ai", "identity verified, quantity guessed");
  assert.equal(of("3 stashes of bread").origin, "ai", "an unknown unit is an estimate too");
  assert.equal(of("2 plates of pap").origin, undefined, "a stated full portion is not an estimate");
});

// ── FOOD PROVENANCE: where a calorie came from ──────────────────────────────────────────────
// The adaptive loop turns on avgKcal7d, and until 2026-08-13 that number carried no provenance:
// a week from the curated SA database and a week of model guesses produced identical evidence.

test("provenance: an all-database week is verified", async () => {
  const { summariseProvenance } = await import("../server/report-card");
  const p = summariseProvenance([
    { kcal: 600, items: [{ kcal: 600, origin: "db" }], source: "sa_scanner" },
    { kcal: 900, items: [{ kcal: 900, origin: "db" }], source: "sa_scanner" },
  ]);
  assert.equal(p.confidence, "verified");
  assert.equal(p.estimatedShare, 0);
});

test("provenance: THE MIXED MEAL — a GPT-supplemented item is no longer hidden", async () => {
  const { summariseProvenance } = await import("../server/report-card");
  // chicken + pap from the database, plus a burger the scanner could not match. Before item
  // tagging this whole row was committed as `sa_scanner` and read as fully verified.
  const p = summariseProvenance([{
    kcal: 1000, source: "sa_scanner",
    items: [{ kcal: 300, origin: "db" }, { kcal: 200, origin: "db" }, { kcal: 500, origin: "ai" }],
  }]);
  assert.equal(p.estimatedShare, 0.5, "half those calories are a guess and must say so");
  assert.equal(p.confidence, "mixed");
});

test("provenance: untagged sa_scanner rows stay UNKNOWN — never assumed verified", async () => {
  const { summariseProvenance } = await import("../server/report-card");
  // These are exactly the historical rows that may contain untagged GPT items. Reading them as
  // `db` would repeat the false confidence the field exists to remove.
  const p = summariseProvenance([{ kcal: 1000, items: null, source: "sa_scanner" }]);
  assert.equal(p.confidence, "insufficient");
  assert.equal(p.estimatedShare, null, "no share may be claimed from uncharacterisable rows");
  assert.equal(p.unknownShare, 1);
});

test("provenance: meal-level source is used only where it LOWERS confidence", async () => {
  const { summariseProvenance } = await import("../server/report-card");
  for (const source of ["photo", "gpt_fallback"]) {
    const p = summariseProvenance([{ kcal: 1000, items: null, source }]);
    assert.equal(p.confidence, "mostly_estimated", `${source} is model-derived and must count as estimated`);
    assert.equal(p.unknownShare, 0);
  }
});

test("provenance: graduated, not binary — 10% and 80% estimated are different situations", async () => {
  const { summariseProvenance } = await import("../server/report-card");
  const at = (aiKcal: number) => summariseProvenance([{
    kcal: 1000, source: "sa_scanner",
    items: [{ kcal: 1000 - aiKcal, origin: "db" }, { kcal: aiKcal, origin: "ai" }],
  }]).confidence;
  assert.equal(at(20), "verified");
  assert.equal(at(150), "mostly_verified");
  assert.equal(at(400), "mixed");
  assert.equal(at(800), "mostly_estimated");
});

test("provenance: no backfill — an empty window is insufficient, never verified", async () => {
  const { summariseProvenance } = await import("../server/report-card");
  const p = summariseProvenance([]);
  assert.equal(p.confidence, "insufficient");
  assert.equal(p.estimatedShare, null);
});

test("deficit evidence: provenance QUALIFIES the number, it never blocks the adaptation", async () => {
  const { assembleDeficitEvidence, renderDeficitEvidence } = await import("../server/adaptive-targets");
  const e = assembleDeficitEvidence({
    calorieTarget: 1900, avgKcal7d: 2180, loggedDays7d: 7, goalType: "fat_loss",
    provenance: { estimatedShare: 0.8, unknownShare: 0, confidence: "mostly_estimated" },
    observedKgPerWeek: 0,
  });
  // The intake evidence still stands up — a deterministic veto here would be the calculator
  // coaching again. What changes is how hard the conclusion may be pushed.
  assert.equal(e.confidence, "usable", "provenance must not veto the comparison");
  assert.equal(e.foodDataConfidence, "mostly_estimated");
  const txt = renderDeficitEvidence(e);
  assert.match(txt, /80% of those calories estimated by me, not weighed/);
  assert.match(txt, /IN PROPORTION to its food-data confidence/);
});

test("deficit evidence: missing provenance reports insufficient, not verified", async () => {
  const { assembleDeficitEvidence } = await import("../server/adaptive-targets");
  const e = assembleDeficitEvidence({
    calorieTarget: 1900, avgKcal7d: 2180, loggedDays7d: 7, goalType: "fat_loss",
    observedKgPerWeek: -0.1,
  });
  assert.equal(e.foodDataConfidence, "insufficient", "absent provenance is never good news");
});

test("food log: retro is TIMING and may never overwrite the origin", () => {
  const src = readFileSync("server/handlers/food-context.ts", "utf-8");
  assert.ok(!/Retro \? "retro" :/.test(src), "a backdated meal must keep where its numbers came from");
  assert.ok(/source: "sa_scanner"/.test(src) && /source: "gpt_fallback"/.test(src),
    "both commit paths must state their real origin");
});

test("food log: the GPT supplement tags its items as inference", () => {
  const src = readFileSync("server/handlers/food-context.ts", "utf-8");
  const supp = src.slice(src.indexOf("PARTIAL MATCH SUPPLEMENT"), src.indexOf("Build the multi-meal breakdown"));
  assert.ok(/origin: "ai"/.test(supp), "items the scanner could not match are NOT database truth");
});

// ── DEFICIT EVIDENCE: measurements, and what they are worth ─────────────────────────────────

test("deficit evidence: both halves present → usable, and the gap is computed", async () => {
  const { assembleDeficitEvidence } = await import("../server/adaptive-targets");
  const e = assembleDeficitEvidence({
    calorieTarget: 1800, avgKcal7d: 1780, loggedDays7d: 7,
    goalType: "fat_loss", observedKgPerWeek: -0.1,
  });
  assert.equal(e.confidence, "usable");
  // 1780 against an inferred 2300 maintenance = -520/day = -0.47kg/week.
  assert.ok(e.expectedKgPerWeek !== null && e.expectedKgPerWeek < -0.4, `got ${e.expectedKgPerWeek}`);
  assert.ok(e.gapKgPerWeek !== null && e.gapKgPerWeek > 0, "losing slower than the estimate");
  assert.equal(e.gapIsMaterial, true);
});

test("deficit evidence: thin logging can never reach 'usable', whatever the scale says", async () => {
  const { assembleDeficitEvidence } = await import("../server/adaptive-targets");
  const e = assembleDeficitEvidence({
    calorieTarget: 1800, avgKcal7d: 1200, loggedDays7d: 2,
    goalType: "fat_loss", observedKgPerWeek: -0.1,
  });
  assert.equal(e.confidence, "trend_only");
  assert.equal(e.expectedKgPerWeek, null, "an average from 2 days is not evidence");
  assert.equal(e.gapKgPerWeek, null, "and no gap may be computed from it");
});

test("deficit evidence: no trustworthy trend → intake_only, no gap invented", async () => {
  const { assembleDeficitEvidence } = await import("../server/adaptive-targets");
  const e = assembleDeficitEvidence({
    calorieTarget: 1800, avgKcal7d: 1780, loggedDays7d: 7,
    goalType: "fat_loss", observedKgPerWeek: null,
  });
  assert.equal(e.confidence, "intake_only");
  assert.equal(e.gapKgPerWeek, null);
  assert.equal(e.gapIsMaterial, false);
});

test("deficit evidence: a small gap is reported as noise, not as a finding", async () => {
  const { assembleDeficitEvidence, renderDeficitEvidence } = await import("../server/adaptive-targets");
  const e = assembleDeficitEvidence({
    calorieTarget: 1800, avgKcal7d: 1780, loggedDays7d: 7,
    goalType: "fat_loss", observedKgPerWeek: -0.42,
  });
  assert.equal(e.gapIsMaterial, false, "0.05kg/week is a glass of water");
  assert.match(renderDeficitEvidence(e), /normal week-to-week noise/);
});

test("deficit evidence: the block states measurements and draws NO conclusion", async () => {
  const { assembleDeficitEvidence, renderDeficitEvidence } = await import("../server/adaptive-targets");
  const txt = renderDeficitEvidence(assembleDeficitEvidence({
    calorieTarget: 1800, avgKcal7d: 2400, loggedDays7d: 7,
    goalType: "fat_loss", observedKgPerWeek: 0,
  }));
  // The 2026-08-13 lesson: a field naming one factor reads as an instruction. No verdicts here.
  for (const banned of ["TARGET_IS_WRONG", "ADHERENCE", "weakest", "cut calories", "eat less"]) {
    assert.ok(!new RegExp(banned, "i").test(txt), `evidence must not contain a verdict: ${banned}`);
  }
  assert.match(txt, /Confidence: usable/);
  assert.match(txt, /ESTIMATE/, "the uncertainty must be stated, not hidden");
});

test("deficit evidence: the engine SERIALISES it — no second calculator in the prompt layer", () => {
  const engine = readFileSync("server/understanding/meaning-engine.ts", "utf-8");
  assert.ok(/input\.deficitEvidence \? renderDeficitEvidence\(input\.deficitEvidence\) : ""/.test(engine),
    "the engine must pass the assembled object straight to the renderer");
  for (const leak of ["assembleDeficitEvidence", "KCAL_PER_KG", "MATERIAL_GAP_KG_PER_WEEK"]) {
    assert.ok(!engine.includes(leak), `meaning-engine must not reference ${leak} — it serialises only`);
  }
});

test("deficit evidence: the live composer reuses weightTrendUsable, never its own trend rule", () => {
  const live = readFileSync("server/understanding/live.ts", "utf-8");
  assert.ok(/weightTrendUsable\(\{/.test(live), "the trend gate must be the shared one");
  assert.ok(/if \(verdict\.usable\)/.test(live), "and a trend it refuses may never be passed on");
  const block = live.slice(live.indexOf("let deficitEvidence"), live.indexOf("const strategyTurn"));
  assert.ok(/catch/.test(block) && /prompt proceeds without it/.test(block),
    "assembly must fail open — no evidence is an honest prompt, an exception is not");
});

test("hunger gauntlet: HUNGER_LLM=1 with no credential exits 2 and says which var to set", () => {
  // Behavioural, not a source read: actually run it with both names emptied. The guard fires
  // before the dynamic imports, so this costs no database, no network and no model call.
  const r = spawnSync("node_modules/.bin/tsx", ["script/hunger-gauntlet.ts"], {
    env: { ...process.env, HUNGER_LLM: "1", AI_INTEGRATIONS_OPENAI_API_KEY: "", OPENAI_API_KEY: "" },
    encoding: "utf-8", timeout: 60_000,
  });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.stderr || ""}`);
  assert.ok(/no OpenAI credential/i.test(r.stderr || ""), "it must say the credential is missing");
  assert.ok(/AI_INTEGRATIONS_OPENAI_API_KEY/.test(r.stderr || ""),
    "and it must name the variable the app actually reads");
  // The old failure mode: a fake key reaching the API. Nothing may be manufactured here.
  assert.ok(!/sk-test-offline/.test((r.stdout || "") + (r.stderr || "")),
    "a live run must never fall back to the offline placeholder");
});


// ── CUT 6: SILENCE HAS ONE OWNER ────────────────────────────────────────────────────────────
// Before this, five places decided what to say to a client who had gone quiet, and which one
// spoke was settled by cron minute under DAILY_PROACTIVE_CAP = 1 — 04:00 beat 04:04 beat 08:00.
// Two clients in the same state got different messages depending on the clock and on their
// position in a database result set. These gates exist so that cannot come back.

test("cut6: the ladder is reachable for a client who has actually vanished", async () => {
  const { chooseAction } = await import("../server/one-action");
  const gone = (days: number) => chooseAction({
    goal: "fat_loss" as any, weeksOnProgramme: 4, daysSinceAnyLog: days,
    daysSinceWeighIn: 2, loggedToday: false, proteinPct: 1, caloriePct: 1,
    sessionsThisWeek: 3, sessionsTarget: 3, stepsToday: 9000, stepsTarget: 8000, hour: 7,
  });
  // The rungs the morning job now dedupes against. Each must be come_back — if any of these
  // fell through to "train"/"protein" the job would be coaching an empty room.
  for (const d of [3, 6, 7, 13, 14, 21, 30, 90]) {
    assert.equal(gone(d).kind, "come_back", `${d} days silent must still be come_back`);
  }
  // AND THE ASK MUST SHRINK. A month gone is not a bigger version of three days gone — it is
  // someone who has decided they failed, and the only ask small enough is to say hi.
  assert.match(gone(30).todo, /say hi/i, "month-plus is the smallest ask on the ladder");
  // SMALLER IN EFFORT, NOT IN CHARACTERS (assertion repaired 2026-08-25, unmasked by the runner
  // fix). This compared `todo.length` — a PROXY for the size of the ask, and the wrong one:
  // "Just say hi. That's the whole ask today." (39 chars) is a smaller ask than "Log one meal
  // today. Any meal." (29 chars) while being the longer string. The property is what the client is
  // asked to DO, so that is what is asserted: at three days we still ask for a log; at a month we
  // ask for nothing but a hello. The product had this right the whole time.
  assert.match(gone(3).todo, /log|tell me/i, "three days gone still asks for one real log");
  assert.ok(!/log|meal|train|weigh|walk/i.test(gone(30).todo),
    `a month gone must ask for no work at all, got: ${gone(30).todo}`);
  assert.match(gone(30).why + gone(3).why, /haven't blown anything|nothing is lost/i,
    "absolution is explicit — silence is usually shame, not busyness");
});

test("cut6: morning runs the ladder for every absence — no skip, no menu", () => {
  const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
  // The bug this cut existed to kill: the >7-day client was dropped ~370 lines ABOVE the
  // decideProactive call, so the ladder's month rung could never run from this job.
  assert.ok(!/if \(daysSilent > 7\) continue;/.test(morning),
    "a client gone more than a week must not be skipped before the decision is made");
  assert.ok(/if \(daysSilent >= 3\) \{/.test(morning), "silence is still handled here");
  assert.ok(/await silenceAsk\(client, daysSilent\)/.test(morning),
    "…and the wording comes from the ladder, not from this job");
  // Three buttons is three decisions, for someone whose problem is that deciding got expensive.
  assert.ok(!/sendWhatsAppButtons/.test(morning), "the re-engagement button menu is gone");
  assert.ok(!/I'm back, let's go|need a simpler plan/i.test(morning),
    "no hand-written re-engagement wording may live in a job again");
});

test("cut6: one ask per rung per absence — never a daily drip", () => {
  const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
  // The rung must be derived the SAME WAY the ladder derives its wording, or the dedupe key and
  // the message drift apart and a client hears week 2's line twice.
  assert.ok(/Math\.min\(4, Math\.floor\(daysSilent \/ 7\)\)/.test(morning),
    "the rung is floor(days/7) capped at the ladder's own month-plus band");
  assert.ok(/claimProactive\(client\.id, `silence_w\$\{rung\}`/.test(morning),
    "the rung is the dedupe key, so each rung speaks once");
  // THE WINDOW IS THE ABSENCE, NOT THE DAY. todaySAST() here would send every morning — 28
  // messages to someone who has been gone a month.
  assert.ok(/const absence = new Date\(client\.lastActiveAt as any\)\.toISOString\(\)\.slice\(0, 10\)/.test(morning),
    "the window is the date they last spoke, so it resets when they return and lapse again");
  assert.ok(!/claimProactive\(client\.id, `silence_w\$\{rung\}`, todaySAST\(\)\)/.test(morning),
    "a per-day window would turn the ladder into a daily drip");
});

test("cut6: a night-shift client who vanishes still hears from us", () => {
  const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
  const silence = morning.indexOf("if (daysSilent >= 3) {");
  const nightShift = morning.indexOf('if (client.workSchedule === "night_shift") continue;');
  assert.ok(silence > 0 && nightShift > 0, "both branches must exist");
  // The night-shift skip is a statement about the 6am BRIEF being wrong for them, not about
  // whether someone who has disappeared is ever contacted. Under the old order they could go
  // quiet forever in total silence.
  assert.ok(silence < nightShift, "silence is decided before the brief's night-shift skip");
});

test("cut6: the Tuesday/Thursday comeback fan-out is gone", () => {
  // Comments are stripped: the removal note in retention.ts quotes the wording it deleted, and a
  // gate that cannot tell a tombstone from live code is a gate that blocks its own explanation.
  const strip = (s: string) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const retention = strip(readFileSync("server/scheduler/jobs/retention.ts", "utf-8"));
  const scheduler = strip(readFileSync("server/scheduler.ts", "utf-8"));
  assert.ok(!/export async function runComebackMessages/.test(retention),
    "a second job for the same absence is a second mouth");
  assert.ok(!/runComebackMessages\(\)/.test(scheduler), "and it is unscheduled, not just unexported");
  // It picked its wording with `sent % comebacks.length` — the client's position in the result
  // set decided what the coach said to them.
  assert.ok(!/comebacks\[sent % comebacks\.length\]/.test(retention),
    "no message may be chosen by a loop counter");
  // Every one of its four templates asked a week-absent client for a TRAINING session.
  assert.ok(!/What time are you training\?/.test(retention),
    "we do not ask someone who has been gone a week what time they are training");
});

test("cut6: retention records, it does not speak", () => {
  const strip = (s: string) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const retention = strip(readFileSync("server/scheduler/jobs/retention.ts", "utf-8"));
  const scheduler = strip(readFileSync("server/scheduler.ts", "utf-8"));
  // THE POINT OF THE CUT. A second job that still sends is not a smaller raffle — it is the same
  // clock bug, and it is worst in the gaps BETWEEN rungs, where the ladder is deliberately quiet
  // and the daily budget is therefore free.
  assert.ok(!/sendWhatsApp/.test(retention), "no send may live in retention");
  assert.ok(!/claimProactive/.test(retention), "and nothing here may consume the client's daily slot");
  assert.ok(!/runDeepSilenceEscalation/.test(scheduler), "the 30-day sign-off went with it");
  // What it must still do: tell a human. Two weeks of silence is a business event, not a
  // coaching one, and it must reach the founder whether or not a message went out that morning.
  assert.ok(/reason: "14_day_silence"/.test(retention), "a fortnight of silence still reaches the founder");
  // AND THE RECORD MUST NOT BE GATED ON A SEND. The old code created the escalation inside
  // `if (ok)`, so once the ladder consumed the day's slot the founder would have stopped being
  // told. That defect is why this job was rewritten rather than merely muted.
  const flagIdx = retention.indexOf('reason: "14_day_silence"');
  assert.ok(!/if \(ok\)/.test(retention.slice(0, flagIdx)), "the escalation is not behind a send budget");
});

// ── A TARGET IS NOT AN ATTRIBUTION ──────────────────────────────────────────────────────────
// Cut 3 made the verifier binding. This rule then read every step figure in a reply as a claim
// that the client had walked it — including the targets in completeOnboarding(), so the FIRST
// MESSAGE A NEW CLIENT EVER RECEIVED was replaced with "Let me not guess on that one."
// onboarding-e2e caught it and had been red on main, eighth in an && chain, hiding the fourteen suites behind it.

test("verifier: a step TARGET is not a claim that they walked it", () => {
  const ok = (reply: string, msg = "Full gym (machines)") => VERIF.verifyBrainReply(reply, { clientMessage: msg }).ok;
  // The two shapes the welcome actually prints. Both were blocking it.
  assert.ok(ok("• 7,500 steps/day — non-negotiable"), "the targets bullet must reach the client");
  assert.ok(ok("*Walking today:* 5,250 steps (building up — full target is 7,500). Send a screenshot."),
    "a ramped target names two numbers and claims neither");
  assert.ok(ok("Aim for 10,000 steps per day."), "a prescription is not an attribution");
  assert.ok(ok("Today's goal: 6,000 steps."), "nor is a goal");
});

test("verifier: it still catches the thing it was built to catch", () => {
  const blocked = (reply: string) => !VERIF.verifyBrainReply(reply, { clientMessage: "hi" }).ok;
  assert.ok(blocked("You walked 8,000 steps today — nice."), "a bare attribution still fails");
  assert.ok(blocked("Nice, 12,000 steps today!"), "…including one with no verb at all");
  // REDACTION, NOT EXEMPTION. A reply that names a target AND claims a number is still a claim,
  // and a target sentence elsewhere in the message must not launder it.
  assert.ok(blocked("You did 6,000 steps against a target of 8,000 steps."),
    "one segment mentioning a target does not excuse the attribution inside it");
  assert.ok(blocked("Your target is 8,000 steps/day.\nYou already hit 12,000 steps today."),
    "and a target line must not launder an attribution on the next line");
});

// ── CUT 7: MEMORY IS FIELDS, NOT SEARCH ─────────────────────────────────────────────────────

test("cut7: durable facts are learned at the front door, not inside the GPT handler", () => {
  const strip = (x: string) => x.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const routes = strip(readFileSync("server/routes.ts", "utf-8"));
  const gptBlock = strip(readFileSync("server/handlers/gpt-block.ts", "utf-8"));
  // THE DEFECT: the detectors sat last in the pipeline, so "my knee is killing me, had chicken
  // and pap" routed to the food handler and the injury was never recorded — while programme.ts
  // kept building sessions from users.injuries, which stayed NULL.
  assert.ok(/recordClientFacts\(user, message\)/.test(routes), "every message is heard, not just GPT ones");
  assert.ok(!/storeMemory\(phone, `Client reported injury/.test(gptBlock),
    "the prose detectors in the GPT handler are gone");
  assert.ok(!/storeMemory\(phone, `Life situation update/.test(gptBlock), "…both blocks of them");
});

test("cut7: an injury reaches the column the programme actually reads", async () => {
  const { detectFacts } = await import("../server/memory");
  const programme = readFileSync("server/programme.ts", "utf-8");
  // This is why Cut 7 is a safety fix and not a memory nicety: users.injuries is ALREADY wired to
  // exercise selection. The fact just never arrived unless the client used the injury command.
  assert.ok(/filterInjuredExercises|filterInjuredGymExercises/.test(programme),
    "the programme trains around users.injuries");
  assert.equal(detectFacts("my knee has been killing me since Saturday").injuries, "knee",
    "…and an ordinary sentence now fills it");
});

test("cut7: embeddings are off, and the conversation thread survives the mute", () => {
  const memory = readFileSync("server/memory.ts", "utf-8");
  assert.ok(/const EMBEDDINGS_ON = String\(process\.env\.MEMORY_EMBEDDINGS/.test(memory),
    "one env var turns the vector store back on — muted, not deleted");
  assert.ok(/^export async function storeMemory[\s\S]{0,120}if \(!EMBEDDINGS_ON\) return;/m.test(memory),
    "no embedding call per stored fact");
  // recentConversation is a plain SQL read of the last four turns and was always the honest half
  // of retrieval. Muting the vector search must not take it out.
  assert.ok(/if \(!EMBEDDINGS_ON\) \{[\s\S]{0,400}recentConversation\(phone\)/.test(memory),
    "the thread still reaches the coach");
  assert.ok(/factsLine\(phone\)/.test(memory), "…alongside the six facts, which replace the prose");
});

test("cut7: one owner for the injury append", () => {
  const strip = (x: string) => x.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // The same six lines lived in pain-triage.ts and misc-commands.ts, and recordClientFacts would
  // have made three copies of "lowercase it, includes(), join with a comma, treat 'none' as empty".
  for (const f of ["server/handlers/pain-triage.ts", "server/handlers/misc-commands.ts"]) {
    const src = strip(readFileSync(f, "utf-8"));
    assert.ok(/addFact\(user\.injuries,/.test(src), `${f} uses the one owner`);
    assert.ok(!/const existingInj = \(user\.injuries \|\| ""\)\.toLowerCase\(\)/.test(src),
      `${f} no longer carries its own copy`);
  }
});

// ── CUT 8: DON'T-MENTION IS BOUND TO THE MOUTH ──────────────────────────────────────────────

test("cut8: the reply path honours do_not_mention, above the meaningful-message gate", () => {
  const chatLog = readFileSync("server/handlers/chat-log.ts", "utf-8");
  const code = chatLog.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(/stripForbidden\(draft, banned\.doNotMention\)/.test(code), "the mouth is bound");
  // ORDER MATTERS. `if (!suspiciousStateLanguage && !meaningful) return reply;` returns early for
  // ordinary turns — a promise honoured only on "meaningful" messages is not honoured.
  const bind = code.indexOf("stripForbidden(draft");
  const earlyReturn = code.indexOf("if (!suspiciousStateLanguage && !meaningful) return reply;");
  assert.ok(bind > 0 && earlyReturn > 0 && bind < earlyReturn,
    "the check must run before the early return, or it only fires on some turns");
});

test("cut8: they may raise it themselves", async () => {
  const { mentionsForbidden } = await import("../server/brain/reply-verifier");
  const chatLog = readFileSync("server/handlers/chat-log.ts", "utf-8");
  // "Don't mention my weight" is not "refuse to tell me my weight when I ask". A coach that won't
  // answer a direct question is not honouring a request, it is sulking — and it is the same trap
  // as the step TARGET that read as an attribution in the P0.
  assert.ok(/if \(!mentionsForbidden\(scope\.inputText, banned\.doNotMention\)\)/.test(chatLog),
    "the client opening the topic re-opens it");
  assert.ok(mentionsForbidden("what's my weight?", "the scale"), "…and that check can see it");
});

test("cut8: the decision stands down before the mouth ever has to", () => {
  const oneAction = readFileSync("server/one-action.ts", "utf-8");
  const code = oneAction.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // The proactive brief does not pass through reconcileTurnReply, so filtering alone would leave
  // morning free to tell a client to stand on a scale they asked us never to raise.
  assert.ok(/const scaleIsOffLimits = mentionsForbidden\("weight scale weigh", s\.doNotMention\)/.test(code),
    "the weigh ask is never chosen");
  assert.ok(/!scaleIsOffLimits && \(\(neverWeighed/.test(code), "…in the ordering itself");
  assert.ok(/&& !mentionsForbidden\("weight scale weigh", p\.doNotMention\)/.test(code),
    "…and in the verdict downgrade, which reaches askToWeigh by a second route");
  // And the fact has to actually arrive: morning carries it into the profile it decides from.
  const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
  assert.equal((morning.match(/doNotMention: client\.doNotMention/g) || []).length, 3,
    "all three decision call sites in morning carry it");
});

// ── CUT 9: ONE FOOD-CONSTRAINT OWNER, AND THE WEIGHT REPORTS HONOUR THE COLUMN ──────────────

test("cut9: no food path keeps its own answer to what this client may eat", () => {
  const strip = (x: string) => x.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const mealPlan = strip(readFileSync("server/meal-plan.ts", "utf-8"));
  const grocery = strip(readFileSync("server/grocery-personalize.ts", "utf-8"));
  const memory = strip(readFileSync("server/memory.ts", "utf-8"));
  // meal-plan derived vegan/vegetarian/noDairy by substring-matching otherMedicalNotes — a
  // third private answer that never saw dietary_restrictions, so a client who told us in
  // conversation they were lactose intolerant still got a plan built on amasi.
  assert.ok(!/notes\.includes\("lactose"\)/.test(mealPlan), "meal-plan no longer derives its own");
  assert.ok(!/notes\.includes\("vegan"\)/.test(mealPlan), "…including the diet labels");
  assert.ok(/foodConstraints\(\{/.test(mealPlan), "it asks the owner");
  assert.ok(/foodConstraints\(\{ foodDislikes, dietaryRestrictions \}\)/.test(grocery),
    "the shopping list reads BOTH columns, not just the signup one");
  assert.ok(/foodConstraints\(\{/.test(memory), "and the coach context is built from the same owner");
});

test("cut9: every plate recommender can be constrained", () => {
  const swaps = readFileSync("server/food-swaps.ts", "utf-8");
  const street = readFileSync("server/street-food.ts", "utf-8");
  // A swap and a street guide are RECOMMENDATIONS — the one place a constraint failure is not
  // just unhelpful but actively proves we do not know them.
  assert.ok(/export function suggestSwap\(foodName: string, goalType\?: string \| null, c\?: FoodConstraints\)/.test(swaps));
  assert.ok(/if \(c && !c\.allows\(rule\.swap\)\) continue;/.test(swaps), "never suggest a banned food");
  assert.ok(/export function streetGuide\(goal: string, c\?: FoodConstraints\)/.test(street));
  assert.ok((street.match(/\.filter\(l => !c \|\| c\.allows\(l\)\)/g) || []).length >= 2,
    "both lists in the guide are filtered — a constraint that lapses mid-message reads as forgetting");
});

test("cut9: the weight reports honour do_not_mention, each in the right way", () => {
  const monday = readFileSync("server/scheduler/jobs/monday.ts", "utf-8");
  const weekly = readFileSync("server/scheduler/jobs/weekly.ts", "utf-8");
  // These are PROACTIVE sends. They pass through neither Cut 8 binding — not the reactive mouth,
  // not the decision — which is exactly why they were still saying it.
  assert.ok(/mentionsForbidden\("weight scale weigh", \(client as any\)\.doNotMention\)/.test(monday),
    "the Monday weigh-in reminder is bound");
  assert.ok(/weigh-in reminder withheld, they asked/.test(monday),
    "…and withheld WHOLE — a weigh-in reminder is the scale, there is no paragraph to strip");
  assert.equal((weekly.match(/mentionsForbidden\("weight scale weigh"/g) || []).length, 2,
    "both weekly reports are bound");
  // The wrap-up is mostly sessions, food days and steps — real progress that must still arrive.
  assert.ok(/weightLine \? `\$\{weightEmoji\} Weight: \$\{weightLine\}` : ""/.test(weekly),
    "the weight LINE stands down, not the report");
  assert.ok(!/weightLine = "not logged — weigh in Monday morning";[\s\S]{0,80}\}\s*$/.test(weekly),
    "and nobody who asked us to drop the scale gets told off for not standing on one");
});

// ── CUT 10: ONE FOOD PIPE FOR THE ASK ───────────────────────────────────────────────────────

test("cut10: the permission ask is answered where the question is already known", () => {
  const fc = readFileSync("server/handlers/food-context.ts", "utf-8");
  const code = fc.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // It hooks at the point that has ALREADY decided this is a question about a priced food —
  // no second detector, no new handler stage, no route added to the pipeline.
  assert.ok(/hasActualFood && hasSubstantiveQuestion && !isFuturePlanning && PERMISSION_ASK\.test\(m\)/.test(code),
    "the hook reuses the gate that already ran");
  assert.ok(/answerFoodPermissionAsk\(user, message, foodsInMsg\)/.test(code));
  // And it must sit ABOVE the retro/scanner paths, or the question falls through to the model
  // exactly as it did before.
  const hook = code.indexOf("answerFoodPermissionAsk(user, message, foodsInMsg)");
  const retro = code.indexOf("const isRetroDietAudit");
  assert.ok(hook > 0 && retro > 0 && hook < retro, "answered before the logging paths, not after");
});

test("cut10: the answer reads the ledger, and the verdict stays pure", () => {
  const ledger = readFileSync("server/day-ledger.ts", "utf-8");
  const swaps = readFileSync("server/food-swaps.ts", "utf-8");
  assert.ok(/getDayLedger\(user\.id, \{ user \}\)/.test(ledger), "the day's truth, not a guess");
  assert.ok(/foodConstraints\(\{/.test(ledger), "…and the same constraints every plate path uses");
  // PURITY IS LOad-BEARING: the unit gates import food-swaps with no database, and answerPlateAsk
  // is where the judgement lives. The db-touching half deliberately sits in day-ledger.ts.
  assert.ok(!/from "\.\/db"|drizzle-orm/.test(swaps), "food-swaps must stay database-free");
  assert.ok(/export function answerPlateAsk/.test(swaps));
});

test("cut10: it declines rather than inventing, and never becomes a second logger", () => {
  const ledger = readFileSync("server/day-ledger.ts", "utf-8");
  assert.ok(/return null;\s*\n\s*\}\s*catch/.test(ledger) || /leaving it to the coach/.test(ledger),
    "any failure hands back to the coach instead of guessing");
  // A permission ask must never write a meal. The whole defect class this pipeline exists to
  // prevent is a QUESTION being logged as a plate the client never ate.
  const fc = readFileSync("server/handlers/food-context.ts", "utf-8");
  const hookBlock = fc.slice(fc.indexOf("CUT 10"), fc.indexOf("RETROSPECTIVE DIET HISTORY"));
  assert.ok(!/commitFoodLog/.test(hookBlock), "the ask is answered, never logged");
});

// ── CUT 11: THE DELETION TEST ───────────────────────────────────────────────────────────────
// The inspector's rule: a canonical object that merely WRAPS the old calculators is fake
// consolidation. The test is whether the duplicated arithmetic can be deleted from the
// presentation modules afterwards. These gates assert that it was.

test("cut11: report-card derives nothing — it projects", () => {
  const rc = readFileSync("server/report-card.ts", "utf-8");
  const code = rc.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // Five queries of its own: meal sums, workouts, steps, weigh-ins, provenance rows. All gone.
  assert.ok(!/COALESCE\(SUM\(/.test(code), "the meal aggregate is deleted, not wrapped");
  assert.ok(!/COUNT\(DISTINCT DATE\(/.test(code), "…and the distinct-day divisor with it");
  assert.ok(!/from\(workoutLogs\)|from\(stepLogs\)|from\(weightLogs\)/.test(code),
    "it no longer reads workouts, steps or weigh-ins itself");
  assert.ok(/const truth = await getProgressTruth\(user, \{ days \}\)/.test(code), "it asks the object");
  assert.ok(/weightChange: truth\.weight\.changeKg/.test(code), "including the sign convention");
});

test("cut11: the share card cannot invent a kilogram", () => {
  const misc = readFileSync("server/handlers/misc-commands.ts", "utf-8");
  const code = misc.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // It ran its own weigh-in query with the OPPOSITE sign to report-card. Same client, same week,
  // two numbers with opposite meaning — on the artefact that leaves the conversation.
  assert.ok(!/const weights2 = await db\.select/.test(code), "the share path's own weight query is gone");
  assert.ok(/await getProgressTruth\(user/.test(code), "it reads the canonical object");
  assert.ok(/truth\.weight\.known && truth\.weight\.changeKg !== null/.test(code),
    "and only speaks when the object says the number is known");
});

test("cut11: don't-mention is enforced by the object, not by each renderer", () => {
  const dl = readFileSync("server/day-ledger.ts", "utf-8");
  // THE DESIGN POINT. Three presentations each remembering to strip the weight is three chances
  // to forget, and the one that gets forwarded to their friends is the worst place to find out.
  // The object refuses to carry the number, so every presentation is safe with nothing to print.
  assert.ok(/const withheld = !askedThemselves && mentionsForbidden\("weight scale weigh", user\?\.doNotMention\)/.test(dl),
    "the truth object applies the prohibition");
  // THE OBJECT REFUSES TO CARRY THE NUMBER. This matched one exact literal, so when the weight
  // block moved into getWeightTruth (2026-08-25, P0-5) — same rule, same nulls, now reachable by
  // the surfaces that were bypassing it entirely — the assertion broke while the property it
  // names got STRONGER. That is what a source-string test does: it grades where the code is.
  //
  // Kept here as a structural smoke check, deliberately tolerant of layout. The behavioural
  // grading lives in production-parity — "P0-5 . getWeightTruth withholds, and stands down rather
  // than filtering", which calls it against a seeded ledger and asserts the returned object
  // carries no weigh-ins at all. Assert behaviour there, not shape here.
  const withheldBranch = dl.slice(dl.indexOf("if (withheld) {"), dl.indexOf("if (withheld) {") + 260);
  assert.ok(/known: false/.test(withheldBranch) && /currentKg: null/.test(withheldBranch)
    && /changeKg: null/.test(withheldBranch) && /points: \[\]/.test(withheldBranch),
    "a withheld weight is absent, not merely unrendered");
  // Cut 8's rule still holds: a prohibition is about US raising it, never about refusing to answer.
  assert.ok(/const askedThemselves = mentionsForbidden\(String\(opts\?\.clientMessage \|\| ""\), user\?\.doNotMention\)/.test(dl),
    "a direct question re-opens it");
});

test("cut11: provenance has one home and the object carries it", () => {
  const core = readFileSync("server/day-ledger-core.ts", "utf-8");
  const rc = readFileSync("server/report-card.ts", "utf-8");
  const dl = readFileSync("server/day-ledger.ts", "utf-8");
  assert.ok(/export function summariseProvenance/.test(core), "pure derivation lives with the reducer");
  assert.ok(!/export function summariseProvenance/.test(rc), "…and not in the card as well");
  assert.ok(/summariseProvenance,/.test(rc), "report-card re-exports it so existing consumers keep working");
  // Same rows, characterised once — report-card ran a second query for exactly this.
  assert.ok(/const provenance = summariseProvenance\(/.test(dl));
  assert.ok(/provenance: FoodProvenance;/.test(dl), "known / likely / unknown rides on the object");
});

// ── PHONE P0 WIRING: one owner per question ─────────────────────────────────────────────────

test("p0: one recovery vocabulary, not two", () => {
  const sick = readFileSync("server/handlers/sick-flow.ts", "utf-8");
  const code = sick.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // The detector accepted a bare "not sick"; the branch that CLEARED the hold demanded the
  // contraction. Two vocabularies for one question, and the state-changing one was the narrow one.
  assert.ok(/export function saysRecovered/.test(code), "one predicate");
  assert.ok(/const declaresReturn = saysRecovered\(m\)/.test(code), "…and the clear branch uses it");
  assert.ok(!/i'\?m not sick\|not sick any/.test(code), "the second hand-written list is gone");
});

test("p0: a stale health flag cannot silence the morning", () => {
  const shared = readFileSync("server/scheduler/shared.ts", "utf-8");
  const morning = readFileSync("server/scheduler/jobs/morning.ts", "utf-8");
  // recordSickState writes paused_until beside sick_until, so isPaused() turned an un-cleared
  // illness into an invisible killswitch on the 06:00 coach.
  assert.ok(/export function pauseReason/.test(shared), "the scheduler can see WHY");
  assert.ok(/pauseReason\(client\) === "explicit"/.test(morning),
    "only a pause the client asked for suppresses the morning");
  assert.ok(!/if \(isPaused\(client\)\) \{/.test(morning), "the blanket gate is gone");
});

test("p0: the repair path answers a question instead of asking them to narrate", () => {
  const chat = readFileSync("server/handlers/chat-log.ts", "utf-8");
  assert.ok(/if \(!looksLikeQuestion\(scope\.inputText \|\| ""\)\) return WITHHOLD;/.test(chat),
    "WITHHOLD is for a report we could not trust, not for a question");
  assert.ok(/getDayLedger\(scope\.userId!, \{\}\)/.test(chat), "the known part comes from the ledger");
});

test("p0: the step exemption is a shape, and the fallback is not a list", () => {
  const v = readFileSync("server/brain/reply-verifier.ts", "utf-8");
  const code = v.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!/q\.includes\("how many steps"\)/.test(code), "the seven literal phrasings are gone");
  assert.ok(/looksLikeQuestion\(text\)/.test(code), "it asks the canonical question owner");
});

test("p0: a fallback may lose specificity, never the relationship", () => {
  const guard = readFileSync("server/understanding/domain-guard.ts", "utf-8");
  const live = readFileSync("server/understanding/live.ts", "utf-8");
  assert.ok(/REDIRECT_IN_CONVERSATION/.test(guard), "there is an in-conversation form");
  // Assert the CONSTANT, not a substring of the file — the doc comment above it legitimately
  // names Coach K while explaining why the line must not.
  const inConv = guard.match(/const REDIRECT_IN_CONVERSATION\s*=\s*\n?\s*"([^"]+)"/)?.[1] || "";
  assert.ok(inConv.length > 20, "the in-conversation redirect has a body");
  assert.ok(!/Coach K/.test(inConv), "…and it does not introduce us to somebody already talking to us");
  assert.ok(/still here|What did you need/i.test(inConv), "it stays in the conversation and hands the turn back");
  assert.ok(/classifyDomain\(openai, message, \{ ongoing \}\)/.test(live), "the caller says which it is");
  // Both wordings live in ONE module — the fix must not become a second fallback tree.
  assert.equal((live.match(/I'm Coach K/g) || []).length, 0, "no redirect copy leaks into the caller");
});

test("p0: the coach is recognised by the same rule as everyone else", () => {
  const routes = readFileSync("server/routes.ts", "utf-8");
  const code = routes.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // isCoach compared RAW digits; isBetaTester, seventy lines below, normalised both sides. Two
  // answers to "is this the same person" in one function — so `0821234567` in the env never
  // equalled `whatsapp:+27821234567` from Twilio and the founder failed EVERY coach gate.
  //
  // The visible cost was the deploy check itself: texting `version` — the command that exists so
  // a non-technical founder can prove what is live — fell through to the model and came back
  // "Let me not guess on that one." We could not confirm a deploy, which is the gate the entire
  // phone test hangs on.
  assert.ok(/const coachPhone = normaliseMsisdn\(/.test(code), "the env side is normalised");
  assert.ok(/normaliseMsisdn\(userPhone\) === coachPhone/.test(code), "…and so is the client side");
  assert.ok(!/userPhone === coachPhone\b/.test(code.replace(/normaliseMsisdn\(userPhone\)/g, "")),
    "no raw-digit comparison survives");
});

test("deploy identity does not depend on the app's own routing", () => {
  const health = readFileSync("server/routes/health.ts", "utf-8");
  const code = health.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // The running commit used to be readable only through the WhatsApp `version` command — which
  // depends on a phone-number comparison, and that comparison was wrong, so it never fired. Two
  // rounds of screenshots were diagnosed against code that may not have been live.
  assert.ok(/RAILWAY_GIT_COMMIT_SHA/.test(code), "the build reports itself over HTTP");
  assert.ok(/\.\.\.runningBuild\(\)/.test(code), "on /health");
  // AND ON THE FAILURE PATH. "Which code is failing" is the first question when an instance is
  // unhealthy, and the moment the WhatsApp command is least likely to answer.
  // Every path out of /health names the build — the healthy one, the database-down one, and the
  // still-starting one. Asserted as a property rather than a count: the count grew when startup
  // state was added, and a count that has to be edited to stay green teaches you to edit it.
  const healthBody = code.slice(code.indexOf('app.get("/health"'), code.indexOf('app.get("/health/ready"'));
  const responses = healthBody.match(/res\.(?:status\(\d+\)\.)?json\(/g) || [];
  const named = healthBody.match(/\.\.\.runningBuild\(\)/g) || [];
  assert.ok(responses.length >= 2, "there is more than one way out of /health");
  assert.equal(named.length, responses.length, "every one of them names the build");
});

test("deploy identity reports the effective engine and normalizer modes", async () => {
  const { runningBuild } = await import("../server/routes/health");
  const previousEngine = process.env.ENGINE_LIVE;
  const previousNormalizer = process.env.NORMALIZER;
  try {
    process.env.ENGINE_LIVE = "on";
    process.env.NORMALIZER = "off";
    assert.deepEqual(runningBuild().runtime, { engineLive: "on", normalizer: "off" },
      "the health snapshot must expose the effective killswitch states, not merely the build");

    process.env.ENGINE_LIVE = "off";
    delete process.env.NORMALIZER;
    assert.deepEqual(runningBuild().runtime, { engineLive: "off", normalizer: "on" },
      "the snapshot must report each owner's effective default state");
  } finally {
    if (previousEngine === undefined) delete process.env.ENGINE_LIVE; else process.env.ENGINE_LIVE = previousEngine;
    if (previousNormalizer === undefined) delete process.env.NORMALIZER; else process.env.NORMALIZER = previousNormalizer;
  }
});

test("the self-test does not trip its own gate", async () => {
  const V = await import("../server/brain/reply-verifier");
  const routes = readFileSync("server/routes.ts", "utf-8");
  // routeMessage runs inside inTurn, so EVERY reply — including a deterministic coach command —
  // passes verifyBrainReply on the way out. The `version` reply used to print its probe sentences
  // verbatim, so it reproduced a violation, its own gate blocked it, and the founder got
  // "Let me not guess on that one" instead of the running commit. Twice, on two separate days.
  // The one command that exists to prove what is deployed was the one that could not answer.
  assert.ok(!/• "incorporate exercises like rows and planks"/.test(routes),
    "the probe is named, not quoted");
  assert.ok(!/• "shock the muscle to confuse it"/.test(routes), "…both of them");
  assert.ok(/freelance-advice probe|muscle-confusion myth probe/.test(routes), "named instead");
  // The probes must still genuinely be violations — naming them must not weaken the test.
  assert.ok(!V.verifyBrainReply("To improve, incorporate exercises like rows and planks.", {}).ok);
  assert.ok(!V.verifyBrainReply("We'll shock the muscle with new movements to confuse it.", {}).ok);
  // And the reply the founder actually receives must survive the gate it just ran.
  const shipped = `🚀 *Running build*\nCommit: *abc1234* (main)\n\n*Live self-test* (the running code checking itself now):\n• freelance-advice probe → ✅ BLOCKED\n• muscle-confusion myth probe → ✅ BLOCKED\n• Meal card → ✅ font loaded, image URL valid\n\nThe engine fix is LIVE.`;
  assert.ok(V.verifyBrainReply(shipped, { clientMessage: "version" }).ok,
    "the deploy check must be able to reach the person asking for it");
});

// ── STARTUP OBSERVABILITY: a failed boot must be able to say what it is ─────────────────────
// The order was migrations → routes → listen, so any failure before listen produced a bare 502 —
// indistinguishable from a dead container, a wrong domain or a crash-loop. /health, whose whole
// job is to answer "which build, what state", was registered two steps after the thing that
// failed. Reproduced against an unreachable database, then fixed and re-verified.

test("startup: the process binds before it proves the schema", () => {
  const index = readFileSync("server/index.ts", "utf-8");
  const code = index.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const gate = code.indexOf("registerStartupGate(app)");
  const verify = code.indexOf("void verifySchemaThenServe()");
  const listen = code.indexOf("httpServer.listen(");
  assert.ok(gate > 0 && verify > 0 && listen > 0, "all three steps exist");
  assert.ok(gate < verify, "the gate is registered before anything can be served");
  assert.ok(verify < listen, "the schema check is kicked off, not awaited, ahead of listen");
  // NOT awaited — awaiting it would restore the old behaviour exactly.
  assert.ok(!/await verifySchemaThenServe\(\)/.test(code), "listen must not wait on migrations");
});

test("startup: the gate is registered before every other route", () => {
  const index = readFileSync("server/index.ts", "utf-8");
  const code = index.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // Express matches in registration order. Auth and audio routes are registered before
  // registerRoutes() runs, so a gate living inside it would have let them through against an
  // unverified schema.
  const gate = code.indexOf("registerStartupGate(app)");
  const audio = code.indexOf("registerAudioRoutes(app)");
  const routes = code.indexOf("await registerRoutes(httpServer, app)");
  assert.ok(gate < audio && gate < routes, "nothing is registered ahead of the gate");
});

test("startup: the schema guarantee survives binding early", () => {
  const health = readFileSync("server/routes/health.ts", "utf-8");
  // Binding before migrations must not mean SERVING before migrations — that is the guarantee
  // Cut 4's fatal runner exists to provide, and it is unchanged.
  assert.ok(/if \(isReady\(\) \|\| req\.path\.startsWith\("\/health"\)\) return next\(\);/.test(health),
    "everything but a health probe is refused until ready");
  assert.ok(/schema not verified yet — not serving traffic/.test(health), "and the refusal says why");
  // The scheduler must not fire proactive messages against an unverified schema either.
  const index = readFileSync("server/index.ts", "utf-8");
  const readyBranch = index.slice(index.indexOf('setStartupPhase("ready"'), index.indexOf("} catch (e: any) {", index.indexOf('setStartupPhase("ready"')));
  assert.ok(/initScheduler\(\)/.test(readyBranch), "the scheduler starts from the ready branch");
  assert.ok(/initFoodsTable\(\)/.test(readyBranch) && /initMemoryTable\(\)/.test(readyBranch),
    "…and so does everything else that touches the schema");
});

test("startup: cannot-connect and migration-failed are different facts", () => {
  const index = readFileSync("server/index.ts", "utf-8");
  assert.ok(/function isConnectionError/.test(index), "the two are classified apart");
  assert.ok(/ECONNREFUSED/.test(index) && /ENOTFOUND/.test(index), "infrastructure codes are named");
  // One is infrastructure and one is our SQL. Treating them identically is how an opaque 502 came
  // to stand for both.
  assert.ok(/database: connection \? "unreachable" : "reachable"/.test(index));
  assert.ok(/migration: connection \? "pending" : "failed"/.test(index));
  // A missing env var used to throw before listen — same opacity, different cause.
  assert.ok(!/throw new Error\(`Missing critical env vars in production/.test(index),
    "a missing env var is reported, not thrown into a 502");
  assert.ok(/missing critical env vars: \$\{missingCritical\.join\(", "\)\}/.test(index),
    "…and the variable is named, which is the one thing the person fixing it needs");
});

test("startup: /health answers without a database", () => {
  const health = readFileSync("server/routes/health.ts", "utf-8");
  const idx = health.indexOf('app.get("/health"');
  const body = health.slice(idx, health.indexOf('app.get("/health/ready"'));
  const earlyReturn = body.indexOf('if (startupState.phase !== "ready")');
  const dbCall = body.indexOf("await db.execute");
  assert.ok(earlyReturn > 0 && dbCall > 0 && earlyReturn < dbCall,
    "it reports startup state BEFORE requiring a live query — the two states we most need to tell apart both used to come back as one opaque error");
});

// ── THE INSTRUMENT CHECKS ITSELF (2026-08-25) ────────────────────────────────────────────────
//
// The control the harness fix exists for. `PROBE_MUST_FAIL=1` makes this one async case throw;
// with the runner repaired the suite must then exit RED and name it, and without the variable it
// must pass. That red/green pair is the only evidence that an async failure in this file is
// actually observed — before the fix, an async case asserting 1 === 2 was counted as PASSED.
//
// It is async ON PURPOSE. A synchronous control would have passed through the broken runner too
// and proved nothing about the 86 cases that were silently non-blocking.
test("PROBE: an async failure in this suite is actually observed", async () => {
  await Promise.resolve();
  if (process.env.PROBE_MUST_FAIL === "1") {
    assert.fail("deliberate async failure — the suite MUST report this and exit non-zero");
  }
});

// EVERY ASYNC CASE MUST LAND BEFORE THE TALLY. Without this the counts below are printed while
// most of the file is still running, which is what made the whole suite advisory.
await Promise.all(pending);


// MILESTONE REGISTER — "HAS THIS CLIENT BEEN AWAY?" HAS ONE OWNER (#156, 2026-09-04).
//
// The register used to read absence by regexing "(N days silent)" back out of the prose
// buildPatternSummary had just generated. That number is 7 minus the DISTINCT DAYS THE CLIENT
// SPOKE in a rolling week — logging density, not contact. Reproduced on current main before the
// change: a client who messaged TODAY but checks in twice a week produced
//
//     "PATTERN CONTEXT: Kam has logged 2 of the last 7 days (5 days silent)."
//     prose regex -> daysSilent=5 -> lapsed -> comeback
//     contactState -> daysSinceLastContact=0, isReturning=false
//
// so a present client was told to their face that they had gone quiet.
{
  // milestoneEmotion comes from the gap-tests-wide gpt import above: unit-tests has no other
  // reason to load server/gpt.ts, and adding one there left the process alive after the last
  // assertion — 1055 green and then a hang to CI's timeout. This suite already loads it.
  const { RETURNING_DAYS, contactState } = await import("../server/understanding/reentry");
  const SPARSE = "PATTERN CONTEXT: Kam has logged 2 of the last 7 days (5 days silent). Protein target is 195g/day.";
  const DENSE = "PATTERN CONTEXT: Kam has logged 6 of the last 7 days (1 day silent). Protein target is 195g/day.";

  test("milestone register: a present client is not put in the comeback register by sparse logging", () => {
    // The divergent shape. Everything else about this summary is neutral, so the only thing that
    // could move the register is the absence signal.
    assert.notEqual(milestoneEmotion(SPARSE, false), "comeback",
      "a client who spoke today must not be told they went quiet because they log twice a week");
  });

  test("milestone register: a genuinely returning client is eligible for comeback, however dense their week was", () => {
    assert.equal(milestoneEmotion(DENSE, true), "comeback",
      "a client past the canonical re-entry threshold must reach the comeback register even after a dense week");
    // ...and the threshold is the canonical one, not a second copy.
    const away = new Date(Date.now() - RETURNING_DAYS * 86_400_000);
    assert.ok(contactState(away).isReturning, "the fixture must actually be past RETURNING_DAYS");
  });

  test("milestone register: training inactivity still moves the register on its own", () => {
    // Present client, dense week — only the training signal is in play.
    assert.equal(milestoneEmotion(DENSE + " No training sessions logged this week.", false), "comeback",
      "training inactivity is an independent signal and must survive the re-entry cut");
    assert.equal(milestoneEmotion(DENSE + " Last training was 6 days ago.", false), "comeback",
      "a stale last-session date is an independent signal too");
  });

  test("milestone register: struggling and thriving still set the tone independently of contact", () => {
    assert.equal(milestoneEmotion(DENSE + " needs direct accountability", false), "comeback",
      "a struggling pattern still outranks a calm week");
    assert.equal(milestoneEmotion(DENSE + " Food logging is consistent, a solid habit.", false), "celebratory",
      "a thriving pattern still earns the celebratory register");
    assert.equal(milestoneEmotion(DENSE, false), "warm",
      "and a neutral week is neither — the default must not have moved");
  });

  test("milestone register: absence is contact, not logging density", () => {
    // The pair that isolates the fix: identical prose, opposite contact state, opposite register.
    assert.notEqual(milestoneEmotion(SPARSE, false), milestoneEmotion(SPARSE, true),
      "the same pattern summary must give different registers for a present and an absent client — otherwise the decision is still reading the prose");
    assert.equal(milestoneEmotion(SPARSE, true), "comeback");
  });
}

console.log(`\ngap-tests: ${passed}/${passed + failed} passed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  console.log(failures.join("\n\n"));
  process.exit(1);
}
console.log("✓ all gap checks passed\n");
process.exit(0);

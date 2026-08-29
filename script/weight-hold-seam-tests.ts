/**
 * 16:55 seam — HOLD is terminal. One structured turn. No second closer.
 * Run: npx tsx script/weight-hold-seam-tests.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { composeWeightTurn, isCoachingTurn, weightTrendUsable } from "../server/adaptive-targets";

process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "unit-test-stub";

const { applyProvenance, classifyClaim } = await import("../server/verifiers/response-gate");
const { withNextMove, isHoldReply } = await import("../server/reply-hygiene");

let failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n${(e as Error).stack}`); }
}

const holdFacts = {
  currentKg: 85.75,
  changeKg: 0.6,
  trendUsable: false as const,
  trendWhy: "illness" as const,
  points: [
    { kg: 85.15, at: new Date("2026-08-20T06:00:00+02:00") },
    { kg: 85.75, at: new Date("2026-08-28T06:00:00+02:00") },
  ],
  goal: "muscle_gain",
  name: "Kam",
};

const holdTurn = {
  kind: "coach" as const,
  domain: "weight" as const,
  decision: "HOLD" as const,
  facts: holdFacts,
};

test("T1: illness HOLD cannot contain a direction", () => {
  const out = composeWeightTurn(holdTurn);
  assert.match(out, /not going to call a trend/i);
  assert.doesNotMatch(out, /going up|keep fuelling|keep fueling|eat more|continue fuelling/i);
  assert.equal(isHoldReply(out), true);
});

test("T1: HOLD ignores a +2.4kg muscle-gain change — facts cannot smuggle a closer", () => {
  const out = composeWeightTurn({ ...holdTurn, facts: { ...holdFacts, changeKg: 2.4 } });
  assert.doesNotMatch(out, /going up|fuell|Up 2|eat more/i);
});

test("T4: HOLD never grows a next move through withNextMove", () => {
  const hold = composeWeightTurn(holdTurn);
  const appended = withNextMove(hold, "Scale is going up — keep fuelling");
  assert.equal(appended, hold);
  assert.doesNotMatch(appended, /keep fuelling/i);
});

test("the old misc closer is invisible to classifyClaim — that is why the gate failed", () => {
  assert.equal(classifyClaim("Scale is going up — keep fuelling."), null);
  assert.equal(classifyClaim("Up 0.3kg since you started."), "weight-trend");
});

test("provenance on the OLD draft still concatenates — the gate is not the composer", () => {
  const draft = "*Kam's Weight History*\n\n• 85.8kg — 28 Aug\n\nUp 0.3kg since you started. Scale is going up — keep fuelling.";
  const r = applyProvenance(draft, {
    trend: { usable: false, why: "illness" }, mealsLoggedToday: 1, calorieTarget: 2200, weighedThisWeek: true,
  });
  assert.match(r.text, /not going to call a trend/i);
  assert.match(r.text, /keep fuelling/i, "documenting the gate hole; composeWeightTurn is what must not emit this");
});

test("provenance on the NEW compose cannot resurrect fuelling", () => {
  const composed = composeWeightTurn(holdTurn);
  const r = applyProvenance(composed, {
    trend: { usable: false, why: "illness" }, mealsLoggedToday: 1, calorieTarget: 2200, weighedThisWeek: true,
  });
  assert.doesNotMatch(r.text, /going up|keep fuelling/i);
  assert.match(r.text, /not going to call a trend/i);
});

test("T8 anti-vacuity: usable=false forces HOLD even if the label says REPORT_TREND", () => {
  const out = composeWeightTurn({
    kind: "coach",
    domain: "weight",
    decision: "REPORT_TREND",
    facts: holdFacts,
  });
  assert.match(out, /not going to call a trend/i);
  assert.doesNotMatch(out, /going up|keep fuelling/i);
});

test("T8: weightTrendUsable illness window is false", () => {
  const v = weightTrendUsable({
    count: 2,
    newestAt: Date.parse("2026-08-28T06:00:00+02:00"),
    oldestAt: Date.parse("2026-08-20T06:00:00+02:00"),
    now: Date.parse("2026-08-28T16:55:00+02:00"),
    sickSince: Date.parse("2026-08-18T00:00:00+02:00"),
    sickUntil: Date.parse("2026-08-27T00:00:00+02:00"),
  });
  assert.equal(v.usable, false);
  assert.equal(v.usable === false && v.why, "illness");
});

test("structured turn has domain weight and no reply string", () => {
  assert.equal(isCoachingTurn(holdTurn), true);
  assert.equal(isCoachingTurn("Scale is going up — keep fuelling."), false);
  assert.equal(isCoachingTurn({ kind: "coach", domain: "weight", decision: "HOLD", reply: "nope" }), false);
});

test("positive control: usable REPORT_TREND still speaks the classified change", () => {
  const out = composeWeightTurn({
    kind: "coach",
    domain: "weight",
    decision: "REPORT_TREND",
    facts: { ...holdFacts, trendUsable: true, trendWhy: null },
  });
  assert.match(out, /Weight History/);
  assert.match(out, /Up 0\.6kg since you started/);
  assert.doesNotMatch(out, /keep fuelling|keep training hard|Moving in the right direction/i);
});

{
  const miscSrc = readFileSync("server/handlers/misc-commands.ts", "utf8");
  const routesSrc = readFileSync("server/routes.ts", "utf8");
  const liveSrc = readFileSync("server/understanding/live.ts", "utf8");
  const hygieneSrc = readFileSync("server/reply-hygiene.ts", "utf8");
  const composeSrc = readFileSync("server/adaptive-targets.ts", "utf8");

  test("source: misc no longer authors keep fuelling or keep training hard", () => {
    assert.doesNotMatch(miscSrc, /Scale is going up — keep fuelling/);
    assert.doesNotMatch(miscSrc, /Keep training hard/);
    assert.match(miscSrc, /weightTrendUsable\(/);
    assert.match(miscSrc, /domain:\s*"weight"/);
    assert.match(miscSrc, /return await weightTrendTurn/);
  });

  test("source: routes finalizes a CoachingTurn instead of returning the misc string", () => {
    assert.match(routesSrc, /isCoachingTurn\(miscResult\)/);
    assert.match(routesSrc, /finalizeCoachingTurn\(/);
    const miscBlock = routesSrc.slice(routesSrc.indexOf("const miscResult"));
    assert.match(miscBlock.slice(0, 280), /isCoachingTurn\(miscResult\)/);
  });

  test("source: composeWeightTurn has no withNextMove call", () => {
    const i = composeSrc.indexOf("export function composeWeightTurn");
    assert.doesNotMatch(composeSrc.slice(i, i + 900), /withNextMove\(/);
    assert.match(composeSrc, /decision === "HOLD"/);
  });

  test("source: closeCoachingTurn bails on HOLD before canonicalDecision", () => {
    const fn = liveSrc.slice(liveSrc.indexOf("export async function closeCoachingTurn"));
    assert.match(fn.slice(0, 500), /isHoldReply/);
  });

  test("source: withNextMove refuses to tail a HOLD", () => {
    assert.match(hygieneSrc, /if \(isHoldReply/);
  });
}

if (failed) {
  console.log(`weight-hold-seam-tests: ${failed} failed`);
  process.exit(1);
}
console.log("weight-hold-seam-tests: all assertions passed");

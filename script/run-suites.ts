/**
 * THE TEST CHAIN, WITHOUT THE && .
 *
 * Every suite runs even when an earlier one fails so the full state is visible.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The one list. check-architecture's suite-liveness guard reads this same array.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * IT HAS TO BE EVERY SUITE CI RUNS, NOT MOST OF THEM (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `npm test` is the working signal — the thing a change is verified against before it is pushed.
 * Four suites ran in CI and not here: decision-state-tests, decision-runtime-tests,
 * reply-context-verifier-tests and decision-doctrine-guard, in the `decision-engine-p0` workflow.
 *
 * That workflow is PATH-TRIGGERED on six files, so it fires only when one of them changes — and
 * nothing had touched them between #52 and #57. In that window,
 * script/reply-context-verifier-tests was RED on main: it asserted a rule deliberately deleted on
 * 2026-08-21 (`isExplicitStepQuery` — "phrasing is not provenance"). Verified by checking out
 * main directly and running it. A month of green PRs, each honestly reporting "26/28, the known
 * baseline", none of which had run it.
 *
 * The defect was not the workflow and not the suites. It was that local green and CI green meant
 * different things, so "26/28" was never a complete statement for a change touching those paths.
 * A working signal that is a subset of the real one teaches you to trust the subset.
 *
 * These four are cheap — about a second and a half together — and there is no reason for them to
 * be reachable only by a path filter.
 *
 * WHAT IS STILL NOT HERE, AND WHY. Three suites run in CI and deliberately do not run in
 * `npm test`: drill-battery (model-drill.yml), gauntlet (coach-voice-gauntlet.yml) and
 * reality-test (reality-test.yml). All three grade the LIVE model and are gated on a real
 * OPENAI_API_KEY secret; putting them here would make every local run need a key and spend money.
 * That is an exclusion, not an oversight — but it is the reason `npm test` green does not mean
 * "the coach's WORDS are good", only "the deterministic surface holds". Stated so the next person
 * reading a green run knows exactly what it covered.
 */
export const SUITES = [
  "unit-tests", "integration-tests", "food-scanner-tests", "safety-audit", "golden-regression",
  "routing-audit", "gap-tests", "onboarding-e2e", "video-path-verify", "phrasing-battery",
  "check-file-sizes", "check-pricing", "check-schema-safety", "check-sast", "check-names",
  "check-reach", "check-prompt-integrity", "hunger-gauntlet", "decision-boundary-tests",
  "reentry-state-tests", "reentry-bridge-tests", "reaction-guard-tests", "current-date-tests", "day-relative-situation-tests", "coach-loop-foundation-tests", "multi-day-attribution-tests",
  // The decision-engine-p0 workflow's four. Here so local and CI cover the same surface.
  "decision-state-tests", "decision-runtime-tests", "reply-context-verifier-tests", "decision-doctrine-guard",
  "turn-triage-tests", "normalizer-replay-tests", "tracking-contract-tests",
  "production-parity", "check-architecture",
];

const PER_SUITE_TIMEOUT_MS = 10 * 60_000;
interface Outcome { name: string; ok: boolean; ms: number; output: string; note: string }
const results: Outcome[] = [];
const started = Date.now();

for (const name of SUITES) {
  const path = `script/${name}.ts`;
  if (!existsSync(path)) {
    results.push({ name, ok: false, ms: 0, output: "", note: "FILE MISSING" });
    console.log(`✗ ${name} — file missing`);
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync("node_modules/.bin/tsx", [path], {
    encoding: "utf-8", timeout: PER_SUITE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const output = `${r.stdout || ""}${r.stderr || ""}`;
  const timedOut = r.status === null;
  const ok = !timedOut && r.status === 0;
  // A SUITE THAT COVERED NOTHING IS NOT A SUITE THAT PASSED (2026-08-25).
  // normalizer-replay exits 0 when its recording is absent — correctly, because a missing
  // recording is not a product failure. But it was rendering as `✓`, and a green tick on a suite
  // that asserted nothing is precisely the vacuous pass this chain exists to catch. A suite that
  // stood down says so, every run, so the gap cannot quietly become "covered".
  const skipped = ok && /^SUITE_SKIPPED:/m.test(output);
  const reason = skipped ? (output.match(/^SUITE_SKIPPED:\s*(.*)$/m) || [])[1] || "" : "";
  results.push({ name, ok, ms, output, note: timedOut ? `TIMED OUT after ${PER_SUITE_TIMEOUT_MS / 1000}s` : (skipped ? `SKIPPED — ${reason}` : "") });
  console.log(`${skipped ? "⊘" : ok ? "✓" : "✗"} ${name} (${(ms / 1000).toFixed(1)}s)`
    + `${skipped ? `  ← covered nothing: ${reason}` : ok ? "" : "  ← see below"}`);
}

const failures = results.filter(r => !r.ok);
for (const f of failures) {
  console.log(`\n${"─".repeat(78)}\n✗ ${f.name}${f.note ? ` — ${f.note}` : ""}\n${"─".repeat(78)}`);
  console.log(f.output.trimEnd() || "(no output)");
}

const stoodDown = results.filter(r => r.note.startsWith("SKIPPED"));
console.log(`\n${"═".repeat(78)}`);
console.log(`suites: ${results.length - failures.length - stoodDown.length}/${results.length} green`
  + `${stoodDown.length ? `, ${stoodDown.length} covered nothing` : ""} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
for (const s of stoodDown) {
  console.log(`⊘ ${s.name} — ${s.note.replace(/^SKIPPED — /, "")}`);
  console.log("  Green here would mean this surface is tested. It is not.");
}
if (failures.length > 0) {
  console.log(`RED: ${failures.map(f => f.name).join(", ")}`);
  console.log("Every suite ran. Nothing below a failure was skipped.");
  process.exit(1);
}
console.log("all suites green");

/**
 * THE TEST CHAIN, WITHOUT THE && .
 *
 * (2026-08-19.) `npm test` was twenty-two suites joined by `&&`, which means the first red one
 * ends the run and every suite after it is simply not executed. That is not a detail: at the time
 * this was written, `onboarding-e2e` sat EIGHTH and had been red on main, so fourteen suites —
 * including check-schema-safety, check-reach, check-prompt-integrity and the architecture governor
 * itself — had not run in a single `npm test` for as long as that red had been there. The governor
 * was dark, and nobody could tell, because the command still printed a failure and exited 1.
 *
 * Three suite-liveness defects have now been found in this repo, all the same shape: something
 * that stops or settles, placed above code that arrived later. An orphaned `process.exit(0)` in
 * gap-tests (twice), an `await Promise.all(pending)` 350 lines from the end of unit-tests, and
 * this. So: run every suite, always, and report the whole picture at the end.
 *
 * Deliberately NOT a test framework — the standing constraint on this codebase is that no new one
 * gets added. This runs the suites that already exist, in the order they already had, and decides
 * nothing about their contents.
 *
 * Output is quiet for a green suite and complete for a red one: a passing suite that prints two
 * hundred lines of diagnostics buries the one that failed.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * THE ONE LIST. It used to live in package.json's `test` script; check-architecture's GUARD #10
 * (suite liveness) parsed it from there and esbuild-checks every entry still compiles, so that a
 * suite which stops parsing cannot silently run zero tests. That guard now reads this array —
 * moving the list without moving the guard would have disabled the very thing that caught two of
 * the three defects above.
 */
export const SUITES = [
  "unit-tests", "integration-tests", "food-scanner-tests", "safety-audit", "golden-regression",
  "routing-audit", "gap-tests", "onboarding-e2e", "video-path-verify", "phrasing-battery",
  "check-file-sizes", "check-pricing", "check-schema-safety", "check-sast", "check-names",
  "check-reach", "check-prompt-integrity", "hunger-gauntlet", "decision-boundary-tests",
  "reentry-state-tests", "reentry-bridge-tests", "production-parity", "check-architecture",
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
  // A suite killed by the timeout has status null and a signal — that is a failure, not a pass,
  // and saying so by name is the difference between "hung" and "quietly skipped".
  const timedOut = r.status === null;
  const ok = !timedOut && r.status === 0;
  results.push({ name, ok, ms, output, note: timedOut ? `TIMED OUT after ${PER_SUITE_TIMEOUT_MS / 1000}s` : "" });
  console.log(`${ok ? "✓" : "✗"} ${name} (${(ms / 1000).toFixed(1)}s)${ok ? "" : "  ← see below"}`);
}

const failures = results.filter(r => !r.ok);

for (const f of failures) {
  console.log(`\n${"─".repeat(78)}\n✗ ${f.name}${f.note ? ` — ${f.note}` : ""}\n${"─".repeat(78)}`);
  console.log(f.output.trimEnd() || "(no output)");
}

console.log(`\n${"═".repeat(78)}`);
console.log(`suites: ${results.length - failures.length}/${results.length} green in ${((Date.now() - started) / 1000).toFixed(0)}s`);
if (failures.length > 0) {
  console.log(`RED: ${failures.map(f => f.name).join(", ")}`);
  console.log("Every suite ran. Nothing below a failure was skipped.");
  process.exit(1);
}
console.log("all suites green");

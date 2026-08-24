/**
 * THE TEST CHAIN, WITHOUT THE && .
 *
 * Every suite runs even when an earlier one fails so the full state is visible.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The one list. check-architecture's suite-liveness guard reads this same array.
 */
export const SUITES = [
  "unit-tests", "integration-tests", "food-scanner-tests", "safety-audit", "golden-regression",
  "routing-audit", "gap-tests", "onboarding-e2e", "video-path-verify", "phrasing-battery",
  "check-file-sizes", "check-pricing", "check-schema-safety", "check-sast", "check-names",
  "check-reach", "check-prompt-integrity", "hunger-gauntlet", "decision-boundary-tests",
  "reentry-state-tests", "reentry-bridge-tests", "reaction-guard-tests", "current-date-tests", "day-relative-situation-tests", "coach-loop-foundation-tests", "production-parity", "check-architecture",
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

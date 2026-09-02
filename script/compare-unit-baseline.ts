/**
 * PR UNIT FAILURE DELTA
 *
 * A red deterministic suite does not say whether a pull request caused the red.
 * This script runs the existing unit entrypoint at the checked-out PR head and at
 * git's exact merge base, then compares the harness's stable test names. A base
 * checkout that cannot be resolved or run is an error, never a convenient
 * "everything was already failing" classification.
 *
 * CI supplies the two immutable pull-request SHAs. Local use is explicit:
 *   npm run test:unit:baseline -- --base <base-sha>
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface UnitRun {
  passed: number;
  total: number;
  failures: string[];
}

export interface FailureDelta {
  baseline: string[];
  introduced: string[];
  fixed: string[];
}

function command(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "no diagnostic").trim()}`);
  }
  return (result.stdout || "").trim();
}

function requiredBase(): string {
  const arg = process.argv.find(value => value.startsWith("--base="));
  const value = process.env.PR_BASE_SHA || process.env.UNIT_BASELINE_BASE_SHA || arg?.slice("--base=".length);
  if (!value) {
    throw new Error("Missing PR_BASE_SHA (CI) or --base=<commit> (local); refusing to guess a baseline.");
  }
  return value;
}

/** Parse only the final harness report, so incidental diagnostic glyphs are not test IDs. */
export function parseUnitRun(output: string, label: string): UnitRun {
  const summaries = [...output.matchAll(/unit-tests:\s*(\d+)\/(\d+)\s+passed/g)];
  const summary = summaries.at(-1);
  if (!summary) throw new Error(`${label} unit suite did not print its pass/total summary.`);

  const passed = Number(summary[1]);
  const total = Number(summary[2]);
  if (!Number.isSafeInteger(passed) || !Number.isSafeInteger(total) || passed > total) {
    throw new Error(`${label} unit suite printed an invalid summary: ${summary[0]}`);
  }

  const failed = total - passed;
  const finalReport = output.slice(output.lastIndexOf(summary[0]) + summary[0].length);
  const failureSection = finalReport.match(/\nFailures:\s*\n([\s\S]*)$/);
  const failures = failureSection
    ? [...failureSection[1].matchAll(/^\s*(?:✗|âœ—)\s+(.+?)\s*$/gm)].map(match => match[1])
    : [];

  if (failures.length !== failed) {
    throw new Error(`${label} unit suite reported ${failed} failures but exposed ${failures.length} stable failure name(s).`);
  }
  if (new Set(failures).size !== failures.length) {
    throw new Error(`${label} unit suite repeated a failure name; identifiers are not stable enough to compare.`);
  }
  return { passed, total, failures };
}

export function classifyFailures(base: UnitRun, head: UnitRun): FailureDelta {
  const baseSet = new Set(base.failures);
  const headSet = new Set(head.failures);
  return {
    baseline: base.failures.filter(name => headSet.has(name)),
    introduced: head.failures.filter(name => !baseSet.has(name)),
    fixed: base.failures.filter(name => !headSet.has(name)),
  };
}

/** Kept pure so the positive control proves that NEW is a blocking outcome. */
export function comparisonExitCode(delta: FailureDelta): number {
  return delta.introduced.length > 0 ? 1 : 0;
}

function runUnit(cwd: string, tsxCli: string, label: string): UnitRun {
  // Invoke the JS CLI through this Node process instead of a platform-specific .bin shim.
  const result = spawnSync(process.execPath, [tsxCli, "script/unit-tests.ts"], {
    cwd,
    encoding: "utf8",
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status === null || ![0, 1].includes(result.status)) {
    const reason = result.error?.message || result.stderr || "timed out or returned no status";
    throw new Error(`${label} unit suite could not run: ${reason.trim()}`);
  }
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const parsed = parseUnitRun(output, label);
  if ((result.status === 0) !== (parsed.failures.length === 0)) {
    throw new Error(`${label} unit suite exit status disagrees with its failure report.`);
  }
  return parsed;
}

function list(title: string, names: string[]): string[] {
  return [`${title} (${names.length})`, ...names.map(name => `  - ${name}`)];
}

async function main() {
  const root = command("git", ["rev-parse", "--show-toplevel"], process.cwd());
  const baseTip = requiredBase();
  const head = command("git", ["rev-parse", "HEAD"], root);
  const expectedHead = process.env.PR_HEAD_SHA;
  if (expectedHead && head !== expectedHead) {
    throw new Error(`Checked-out HEAD ${head} is not PR_HEAD_SHA ${expectedHead}; refusing an inexact comparison.`);
  }
  command("git", ["cat-file", "-e", `${baseTip}^{commit}`], root);
  const mergeBase = command("git", ["merge-base", head, baseTip], root);

  const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
  if (!existsSync(tsxCli)) throw new Error(`Missing ${tsxCli}; run npm ci before comparing.`);

  // Keep the temporary worktree below root: Node can then resolve this checkout's node_modules.
  const worktree = mkdtempSync(join(root, ".unit-baseline-worktree-"));
  rmSync(worktree, { recursive: true, force: true });
  const safeRelative = relative(root, worktree);
  if (isAbsolute(safeRelative) || safeRelative.startsWith("..")) {
    throw new Error("Refusing to remove a worktree path outside the repository.");
  }

  try {
    command("git", ["worktree", "add", "--detach", worktree, mergeBase], root);
    // Capture head first, then prove whether each named failure existed at its merge base.
    const headRun = runUnit(root, tsxCli, "HEAD");
    const baseRun = runUnit(worktree, tsxCli, "MERGE BASE");
    const delta = classifyFailures(baseRun, headRun);
    const report = [
      "PR UNIT FAILURE COMPARISON",
      `HEAD: ${head}`,
      `MERGE BASE: ${mergeBase} (resolved from ${baseTip})`,
      `BASE: ${baseRun.passed}/${baseRun.total} passed (${baseRun.failures.length} failures)`,
      `HEAD: ${headRun.passed}/${headRun.total} passed (${headRun.failures.length} failures)`,
      ...list("BASELINE", delta.baseline),
      ...list("NEW", delta.introduced),
      ...list("FIXED", delta.fixed),
    ];
    console.log(report.join("\n"));
    if (comparisonExitCode(delta) !== 0) {
      console.error("CI VERDICT: RED — branch-introduced unit failure(s) detected.");
      process.exitCode = 1;
    } else {
      console.log("CI VERDICT: PASS — no branch-introduced unit failures.");
    }
  } finally {
    // This path is freshly generated under root and verified above; never leave a test checkout behind.
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, encoding: "utf8" });
    rmSync(worktree, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch(error => {
    console.error(`CI VERDICT: RED — baseline comparison could not complete: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

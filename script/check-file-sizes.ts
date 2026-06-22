/**
 * God-file growth guard (CTO audit item #45).
 *
 * The codebase has several oversized files (lifecycle.ts, media.ts, etc.) that
 * concentrate most bugs. Splitting them now is high-risk, so instead we FREEZE
 * them: this script fails CI if any server/*.ts file grows past its budget.
 *
 * - Known-large files have an explicit budget near their current size, so they
 *   can only shrink, not grow.
 * - Everything else is capped at DEFAULT_MAX, so no NEW god file can appear.
 *
 * Run: npx tsx script/check-file-sizes.ts   (wired into `npm test`)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_MAX = 1200;

// Explicit budgets for the existing large files (frozen near current size as of
// 2026-06-22). Lower these as files are trimmed; never raise them.
const BUDGETS: Record<string, number> = {
  "server/programme.ts": 2050,
  "server/handlers/lifecycle.ts": 1900,
  "server/handlers/misc-commands.ts": 1850,
  "server/handlers/early-commands.ts": 1850,
  "server/handlers/media.ts": 1550,
  "server/gpt.ts": 1450,
  "server/handlers/food-context.ts": 1450,
  "server/foods.ts": 1350,
  "server/onboarding.ts": 1350,
  "server/routes/coach.ts": 1150,
  "server/routes/dashboard.ts": 1100,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = walk("server");
const violations: string[] = [];

for (const file of files) {
  const lines = readFileSync(file, "utf-8").split("\n").length;
  const budget = BUDGETS[file] ?? DEFAULT_MAX;
  if (lines > budget) {
    violations.push(`  ✗ ${file}: ${lines} lines (budget ${budget})`);
  }
}

if (violations.length > 0) {
  console.error("file-size guard: FAILED — files exceed their line budget:");
  console.error(violations.join("\n"));
  console.error(
    "\nDo not raise the budget. Either trim the file, or extract a cohesive piece into a new module."
  );
  process.exit(1);
}

console.log(`file-size guard: ${files.length} files OK (none over budget)`);
process.exit(0);

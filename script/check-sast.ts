/**
 * SAST DAY-BOUNDARY GUARD (ledger D6).
 *
 * The systemic defect every reviewer named is a rule living in 98 places instead of one. You
 * cannot safely rewrite 98 call sites in an afternoon, and pretending otherwise is how a
 * refactor takes the product down. So this does what the file-size guard does: it FREEZES the
 * problem at today's count and fails the build if it grows.
 *
 * Existing sites migrate incrementally, each one covered by its own tests. New code has no
 * choice — it must use server/sast.ts. The number below only ever goes DOWN.
 *
 * Run: npx tsx script/check-sast.ts   (wired into `npm test`)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The canonical module is allowed to contain the offset — that is its whole job. utils.ts keeps
// its own copy until its callers are migrated; it is on the list below, not exempt forever.
const CANONICAL = ["server/sast.ts"];

// Today's count, 2026-07-28. LOWER THIS as call sites migrate. Never raise it: a rise means a
// new hand-rolled day boundary was written, which is the exact bug this exists to stop.
const BUDGET = 69;

const RAW_OFFSET = /\b2\s*\*\s*3[_,]?600[_,]?000\b|\b7[_,]?200[_,]?000\b/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

let total = 0;
const perFile: Array<[string, number]> = [];
for (const file of walk("server")) {
  if (CANONICAL.includes(file)) continue;
  const hits = (readFileSync(file, "utf-8").match(RAW_OFFSET) || []).length;
  if (hits > 0) { total += hits; perFile.push([file, hits]); }
}

if (total > BUDGET) {
  console.error(`SAST guard: FAILED — ${total} raw day-offset uses, budget ${BUDGET}.`);
  console.error("\nA new hand-rolled SAST day boundary was added. Use server/sast.ts instead:");
  console.error("  sastDayKey(at)  sastDayStart(at)  sastHour(at)  isPastSastDay(at)  sastDaysBetween(a, b)");
  console.error("\nWorst offenders:");
  for (const [f, n] of perFile.sort((a, b) => b[1] - a[1]).slice(0, 8)) console.error(`  ${f}: ${n}`);
  process.exit(1);
}

if (total < BUDGET) {
  console.log(`SAST guard: ${total} raw day-offset uses (budget ${BUDGET}) — LOWER THE BUDGET to ${total} in script/check-sast.ts.`);
  process.exit(1);
}

console.log(`SAST guard: ${total} raw day-offset uses, at budget (${BUDGET}) — migrate, never add.`);

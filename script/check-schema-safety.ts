/**
 * SCHEMA SAFETY GUARD.
 *
 * (2026-07-28. Four independent reviewers read the readiness document and all four named the
 * same thing as the number-one launch risk — ahead of the two engines, ahead of cost, ahead of
 * everything: schema changes were applied to the live database with `drizzle-kit push`, and the
 * repository held one migration file.
 *
 * `push` diffs the schema against production and applies the result. There is no review step, no
 * version history, and no clean revert. A mistaken column rename or type change on a hotfix
 * corrupts the day-ledger — the single source of truth for every number the coach says — and the
 * only way back is the six-hourly backup, which means losing up to half a day of client food
 * logs. For a product whose entire promise is "I remember what you ate", that is fatal.
 *
 * The fix is cheap and it is now enforced here:
 *   1. A baseline migration exists and is committed.
 *   2. Deploys run `db:migrate` (applies committed migrations), never `db:push`.
 *   3. This guard fails the build if `push` reappears in a deploy path.
 *
 * `db:push` is deliberately left in package.json for local scratch databases — the guard's job is
 * to stop it reaching a deploy script or CI workflow.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const problems: string[] = [];

// 1. A committed baseline must exist — without it `migrate` has nothing to apply.
const migrations = existsSync("migrations")
  ? readdirSync("migrations").filter(f => f.endsWith(".sql"))
  : [];
if (migrations.length < 2) {
  problems.push(`migrations/ holds ${migrations.length} .sql file(s) — run "npm run db:generate" and commit the result before deploying a schema change.`);
}

// 2. No deploy path may call push. Local use is fine; shipping it is not.
const deployFiles: string[] = [];
if (existsSync(".github/workflows")) {
  for (const f of readdirSync(".github/workflows")) deployFiles.push(join(".github/workflows", f));
}
for (const f of ["railway.json", "railway.toml", "Procfile", "Dockerfile", "nixpacks.toml"]) {
  if (existsSync(f)) deployFiles.push(f);
}
for (const f of deployFiles) {
  const body = readFileSync(f, "utf-8");
  if (/drizzle-kit\s+push|npm\s+run\s+db:push/.test(body)) {
    problems.push(`${f} runs drizzle-kit push — deploys must run "db:migrate" against committed migrations instead.`);
  }
}

// 3. The start/build scripts must not push either.
const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
for (const key of ["start", "build", "postinstall", "deploy", "release"]) {
  const v = pkg.scripts?.[key];
  if (typeof v === "string" && /drizzle-kit\s+push|db:push/.test(v)) {
    problems.push(`package.json script "${key}" runs push — use "db:migrate".`);
  }
}

if (problems.length > 0) {
  console.error("schema safety: FAILED\n" + problems.map(p => `  ✗ ${p}`).join("\n"));
  console.error("\nWhy this guard exists: a bad `push` corrupts the day-ledger and the only way back\nis the 6-hourly backup — up to half a day of client food logs lost.\n");
  process.exit(1);
}

console.log(`schema safety: OK (${migrations.length} committed migrations, no push in any deploy path)`);

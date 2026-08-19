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

// 4. EVERY DECLARED COLUMN MUST BE CREATABLE BY THE DEPLOY PATH (Cut 4, 2026-08-19).
//
// This is the guard that would have prevented the six-hour outage on 2026-08-18. Migration 0005
// declared baseline_calorie_target on `users`; nothing in the deploy created it; Drizzle names
// every declared column in every SELECT; the webhook reads `users` before anything else. Every
// inbound message threw for six hours.
//
// The repo had a migrations/ directory that no deploy path executed and a hand-maintained ALTER
// array inside server/index.ts that nobody thought of as a migration. Two systems, neither
// authoritative, and the difference between a safe change and an outage was whether the author
// remembered an undocumented second step.
//
// PHASE 3 in server/index.ts now runs migrations/ on boot, so a column is creatable if it appears
// in the boot SQL or in any committed migration. Anything declared and creatable by neither is a
// column production will be asked for and will not have.
const schemaSrc = readFileSync("shared/schema.ts", "utf-8");
const bootSrc = readFileSync("server/index.ts", "utf-8");
const migrationSql = migrations.map(f => readFileSync(`migrations/${f}`, "utf-8")).join("\n");
const creatable = `${bootSrc}\n${migrationSql}`;
const declared = [...schemaSrc.matchAll(/\b(?:text|integer|boolean|timestamp|numeric|jsonb|serial|uuid|real|date|varchar)\s*\(\s*"([a-z0-9_]+)"/g)]
  .map(m => m[1]);
const uncreatable = [...new Set(declared)].filter(col => !creatable.includes(col));
if (uncreatable.length > 0) {
  problems.push(
    `shared/schema.ts declares ${uncreatable.length} column(s) no deploy path can create: ${uncreatable.slice(0, 8).join(", ")}`
    + `\n     Drizzle names every declared column in every SELECT, so production will be asked for a`
    + `\n     column it does not have and every read of that table will throw. Add a migrations/*.sql`
    + `\n     file (it runs on boot) — do NOT hand-copy into the ALTER array in server/index.ts.`,
  );
}

if (problems.length > 0) {
  console.error("schema safety: FAILED\n" + problems.map(p => `  ✗ ${p}`).join("\n"));
  console.error("\nWhy this guard exists: a bad `push` corrupts the day-ledger and the only way back\nis the 6-hourly backup — up to half a day of client food logs lost.\n");
  process.exit(1);
}

console.log(`schema safety: OK (${migrations.length} committed migrations run on boot, ${new Set(declared).size} declared columns all creatable, no push in any deploy path)`);

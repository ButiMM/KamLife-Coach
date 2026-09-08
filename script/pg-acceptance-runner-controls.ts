/**
 * CONTROLS FOR THE ACCEPTANCE RUNNER (#227) — the proof harness for the gate itself.
 *
 * A test runner is the one piece of infrastructure that cannot be graded by the suites it runs: if
 * it silently skipped everything, every suite would still "pass". So it is graded here, against
 * the real PostgreSQL container, with deliberate controlled failures.
 *
 * The two failures this cut exists to remove are both asserted as behaviour, not as intent:
 *
 *   EARLY-EXIT BLINDNESS — a red acceptance must not stop the ones behind it, and must still make
 *   the job red. Both halves matter: a runner that keeps going but forgets to fail is worse than
 *   the early exit it replaced, because it is a gate that no longer gates.
 *
 *   CONTAMINATION — the reset must actually remove what the previous acceptance wrote. That is
 *   asserted WITH ITS OPPOSITE: the same two fixtures are run again with the reset disabled, and
 *   the second one must then FAIL. Without that half, "the row was gone" is equally well explained
 *   by the row never having been written.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const {
  ACCEPTANCES, testDatabaseSafety, resetTestDatabase, runAcceptances, exitCodeFor,
} = await import("./pg-acceptance-runner.ts");

/**
 * THE GUARD PROTECTS THIS FILE TOO (#227, review).
 *
 * The first version of this script checked only that DATABASE_URL was non-empty, then imported the
 * pool and reset the database — while testing `testDatabaseSafety` as a pure function further down
 * without ever applying it to its own destructive work. A controls script that can wipe a real
 * database is the precise hazard this cut exists to close, sitting in the file whose job is to
 * prove it is closed. It is applied FIRST now, before the pool is even imported.
 */
const safety = testDatabaseSafety(process.env.DATABASE_URL, process.env as any);
if (!safety.safe) {
  // No database at all is an environment without one — the same SKIP every acceptance does. A
  // database that is present but not a throwaway is a REFUSAL, and must not read as a pass.
  if (!process.env.DATABASE_URL) {
    console.log("pg-acceptance-runner-controls: SKIPPED — no DATABASE_URL. This proof needs a real database.");
    process.exit(0);
  }
  console.log(`pg-acceptance-runner-controls: REFUSING — ${safety.reason}.`);
  console.log("These controls reset the database repeatedly, so they only ever point at a");
  console.log("throwaway local/CI one. Outside CI, pass PG_ACCEPTANCE_ALLOW_RESET=1 deliberately.");
  process.exit(2);
}

const { pool } = await import("../server/db");

let failed = 0;
const chk = (ok: boolean, msg: string, evidence = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}${!ok && evidence ? `\n          ${evidence}` : ""}`);
};

// Fixtures: tiny scripts standing in for acceptances, so a controlled red is genuinely CONTROLLED
// rather than borrowed from whichever product suite happens to be broken today.
//
// They are written INSIDE the repository, not /tmp, and the reason is worth recording: tsx decides
// module format from the nearest package.json, so a .ts file under /tmp is transformed as CommonJS
// and every `await import` in it fails to compile. A fixture that cannot run would have made the
// contamination control vacuously "green" in the direction that matters least.
const dir = mkdtempSync(join(process.cwd(), ".pg-runner-controls-"));
const fixture = (name: string, body: string) => {
  const p = join(dir, `${name}.ts`);
  writeFileSync(p, body);
  return ["npx", "tsx", p];
};
const PHONE = "whatsapp:+27999000227";

const passing = fixture("passing", `console.log("fixture: passing"); process.exit(0);`);
const failing = fixture("failing", `console.log("fixture: deliberately failing"); process.exit(1);`);
const writesRow = fixture("writes-row", `
  const { pool } = await import("../server/db.ts");
  await pool.query("INSERT INTO users (phone_number, name) VALUES ($1, $2)", [${JSON.stringify(PHONE)}, "Contaminator"]);
  await pool.end(); process.exit(0);`);
const demandsEmpty = fixture("demands-empty", `
  const { pool } = await import("../server/db.ts");
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM users WHERE phone_number = $1", [${JSON.stringify(PHONE)}]);
  await pool.end();
  console.log("fixture: saw " + rows[0].n + " contaminating row(s)");
  process.exit(rows[0].n === 0 ? 0 : 1);`);

const reset = () => resetTestDatabase(pool);
const run = (cmd: string[]) => spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", env: process.env });
const entry = (id: string, command: string[]) => ({ id, title: id, command });

console.log("\n=== 1 · A RED ACCEPTANCE DOES NOT HIDE THE ONES BEHIND IT ===");
{
  const results = await runAcceptances(
    [entry("first-red", failing), entry("second", passing), entry("third", passing)],
    { reset, run });
  chk(results.length === 3, "every acceptance after a failure still executed",
    JSON.stringify(results.map(r => r.id)));
  chk(results[0].ok === false && results[1].ok && results[2].ok,
    "…and each verdict is recorded independently", JSON.stringify(results));

  // The other half, and the one that makes this a gate rather than a report.
  chk(exitCodeFor(results) === 1, "the job still exits RED because one of them failed",
    `exit=${exitCodeFor(results)}`);
}

console.log("\n=== 2 · A FULLY GREEN SET IS GREEN ===");
{
  const results = await runAcceptances([entry("a", passing), entry("b", passing)], { reset, run });
  chk(results.every(r => r.ok) && exitCodeFor(results) === 0,
    "nothing red, nothing invented — the gate passes", JSON.stringify(results));
}

console.log("\n=== 3 · THE RESET ACTUALLY REMOVES WHAT THE LAST ACCEPTANCE WROTE ===");
{
  const results = await runAcceptances(
    [entry("writes-row", writesRow), entry("demands-empty", demandsEmpty)], { reset, run });
  chk(results.every(r => r.ok),
    "a row seeded by one acceptance is gone before the next one starts", JSON.stringify(results));

  // THE CONTROL. Without this, "the row was gone" is equally well explained by the row never
  // having been written — which would make the check above prove nothing at all.
  const noReset = await runAcceptances(
    [entry("writes-row", writesRow), entry("demands-empty", demandsEmpty)],
    { reset: async () => {}, run });
  chk(noReset[0].ok && !noReset[1].ok,
    "CONTROL: with the reset removed, the same pair contaminates and the second FAILS",
    JSON.stringify(noReset));
  await reset();
}

console.log("\n=== 4 · A RESET THAT FAILS IS NOT A REASON TO RUN ANYWAY ===");
{
  const results = await runAcceptances([entry("a", passing)], {
    reset: async () => { throw new Error("database unreachable"); }, run });
  chk(!results[0].ok && /reset failed/.test(results[0].note),
    "an unresettable database is recorded as a failure, not run against whatever was left",
    JSON.stringify(results));
}

console.log("\n=== 5 · THE RESET REFUSES ANY DATABASE THAT IS NOT A THROWAWAY ===");
{
  const CI = { CI: "true" };
  const unsafe: Array<[string, string | undefined, any]> = [
    ["no DATABASE_URL at all", undefined, CI],
    ["a remote production host", "postgres://u:p@containers-us-west-1.railway.app:5432/railway", CI],
    ["any non-loopback host", "postgres://u:p@10.0.0.7:5432/kamlife", CI],
    ["a URL that is not PostgreSQL", "mysql://u:p@127.0.0.1:3306/kamlife", CI],
    ["not a URL at all", "kamlife", CI],
    ["NODE_ENV=production", "postgres://kam:kam@127.0.0.1:5432/kamlife", { ...CI, NODE_ENV: "production" }],
    ["a laptop that did not opt in", "postgres://kam:kam@127.0.0.1:5432/kamlife", {}],
  ];
  for (const [name, url, env] of unsafe) {
    const v = testDatabaseSafety(url, env);
    chk(v.safe === false, `refused: ${name}`, JSON.stringify(v));
  }

  // CONTROLS BOTH WAYS. A guard that refuses everything would pass every line above and stop the
  // gate from ever running — these are the two configurations that MUST be allowed.
  chk(testDatabaseSafety("postgres://kam:kam@127.0.0.1:5432/kamlife", CI).safe === true,
    "CONTROL: the CI service container is allowed");
  chk(testDatabaseSafety("postgres://kam:kam@localhost:5432/journeylab",
    { PG_ACCEPTANCE_ALLOW_RESET: "1" }).safe === true,
    "CONTROL: a local database with a deliberate opt-in is allowed");
}

console.log("\n=== 6 · THE INVENTORY IS REAL, AND ITS SCRIPTS STILL STAND ALONE ===");
{
  const { existsSync } = await import("node:fs");
  const missing = ACCEPTANCES
    .filter(a => a.command[0] === "npx" && !existsSync(a.command[2]))
    .map(a => a.command[2]);
  chk(missing.length === 0, "every acceptance named in the inventory exists on disk",
    JSON.stringify(missing));
  chk(ACCEPTANCES.length >= 19, "the inventory still holds every acceptance the workflow listed",
    `count=${ACCEPTANCES.length}`);

  // Requirement 6 of the cut: the individual scripts must remain independently runnable, so a
  // builder debugging one acceptance never has to run the whole set. Proven by running one.
  //
  // GRADED ON EXECUTION, NOT ON THE PRODUCT (#227, review). This asserted the acceptance came back
  // GREEN, which quietly made these infrastructure controls depend on product health: a real
  // regression in that suite would have turned the controls red, and — before the workflow fix
  // alongside this — skipped the whole acceptance run. What requirement 6 is about is whether the
  // script still RUNS standalone, so that is what is asserted: it reached its own verdict line.
  await reset();
  const solo = spawnSync("npx", ["tsx", "script/pg-safety-turn-acceptance.ts"],
    { encoding: "utf-8", env: process.env });
  chk(/pg-safety-turn-acceptance: (GREEN|RED)/.test(solo.stdout || ""),
    "an individual acceptance still runs on its own, outside the runner, and reaches a verdict",
    `status=${solo.status} tail=${JSON.stringify((solo.stdout || "").slice(-160))}`);
}

console.log("\n=== 7 · THE RESET RESTORES SCHEMA AN ACCEPTANCE BROKE, NOT JUST ROWS ===");
{
  // The defect this closes: `pg-step-provenance-acceptance` installs the pre-#184 faulty
  // `kamlife_parse_step_report` on purpose and restores it three statements later. An exception in
  // that window leaves the broken function installed — and TRUNCATE does not remove a function, so
  // every later acceptance would run against a known-broken step parser and fail for reasons that
  // belong to nothing in the diff. A reset that only empties tables does not deliver a clean
  // database; this asserts that the one here does.
  const defOf = async () => (await pool.query(
    `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'kamlife_parse_step_report'`)).rows[0]?.def || "";

  const original = await defOf();
  chk(!!original, "the migrated schema carries the step-provenance function to begin with");

  // The scenario exactly: an acceptance that mutates the function and then DIES before restoring
  // it, followed by one that requires the committed definition. Not a mutation done politely from
  // this file — a failing acceptance, which is the case that actually happens.
  const breaksAndDies = fixture("breaks-and-dies", `
    const { pool } = await import("../server/db.ts");
    await pool.query(\`CREATE OR REPLACE FUNCTION public.kamlife_parse_step_report(raw text)
      RETURNS integer LANGUAGE plpgsql IMMUTABLE AS $fn$ BEGIN RETURN 42; END; $fn$;\`);
    await pool.end();
    console.log("fixture: schema mutated, now dying before restoring it");
    process.exit(1);`);
  const demandsCommittedFn = fixture("demands-committed-fn", `
    const { pool } = await import("../server/db.ts");
    const { rows } = await pool.query(\`SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'kamlife_parse_step_report'\`);
    await pool.end();
    const mutated = /RETURN 42/.test(rows[0]?.def || "");
    console.log("fixture: step parser is " + (mutated ? "THE MUTATED ONE" : "the committed one"));
    process.exit(mutated ? 1 : 0);`);

  const results = await runAcceptances(
    [entry("breaks-and-dies", breaksAndDies), entry("demands-committed-fn", demandsCommittedFn)],
    { reset, run });
  chk(!results[0].ok, "CONTROL: the mutating acceptance really did fail", JSON.stringify(results[0]));
  chk(results[1].ok,
    "a schema mutation left behind by a FAILING acceptance cannot reach the next one",
    JSON.stringify(results[1]));

  // THE CONTROL FOR THE CONTROL. With row-only truncation in place of the rebuild, the mutated
  // function survives and the second acceptance fails — which is the defect this replaced, and the
  // proof that the check above is testing the rebuild rather than describing a mutation that never
  // happened.
  const truncateOnly = async () => {
    await pool.query(`DO $$ DECLARE t text; BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      LOOP EXECUTE format('TRUNCATE TABLE %I CASCADE', t); END LOOP; END $$;`);
  };
  const underTruncate = await runAcceptances(
    [entry("breaks-and-dies", breaksAndDies), entry("demands-committed-fn", demandsCommittedFn)],
    { reset: truncateOnly, run });
  chk(!underTruncate[1].ok,
    "CONTROL: with row-only truncation the broken parser survives and the next acceptance FAILS",
    JSON.stringify(underTruncate[1]));

  await reset();
  chk(await defOf() === original, "…and the rebuild restores the committed definition byte for byte",
    JSON.stringify((await defOf()).slice(0, 120)));
}

console.log("\n=== 8 · THESE CONTROLS REFUSE AN UNSAFE DATABASE BEFORE TOUCHING IT ===");
{
  // The guard is asserted as a pure function above; this asserts it actually GATES this file's own
  // destructive work. The child exits at the guard, so the recursion is one level deep and ends
  // there — the marker below is belt and braces in case a future edit breaks the guard itself.
  if (process.env.PG_CONTROLS_NO_RECURSE === "1") {
    chk(true, "SKIPPED in the child process (recursion guard)");
  } else {
    const child = spawnSync("npx", ["tsx", "script/pg-acceptance-runner-controls.ts"], {
      encoding: "utf-8",
      env: { ...process.env, PG_CONTROLS_NO_RECURSE: "1", CI: "", PG_ACCEPTANCE_ALLOW_RESET: "",
             DATABASE_URL: "postgres://u:p@containers-us-west-1.railway.app:5432/railway" },
    });
    chk(child.status === 2 && /REFUSING/.test(child.stdout || ""),
      "pointed at a remote database, this script refuses and resets nothing",
      `status=${child.status} out=${JSON.stringify((child.stdout || "").slice(0, 160))}`);
  }
}

console.log(`\n${failed === 0
  ? "pg-acceptance-runner-controls: GREEN — all checks passed"
  : `pg-acceptance-runner-controls: RED — ${failed} check(s) failed`}`);

rmSync(dir, { recursive: true, force: true });
await resetTestDatabase(pool).catch(() => {});
await pool.end().catch(() => {});
process.exit(failed === 0 ? 0 : 1);

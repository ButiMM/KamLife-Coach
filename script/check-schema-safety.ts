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

// 5. THE JOURNAL MUST BE PRESENT, WELL-FORMED, ORDERED, COMPLETE AND UNAMBIGUOUS (2026-09-11).
//
// A SUCCESSFUL COMMAND THAT SKIPPED A MIGRATION. While building the raw-voice-provenance cut,
// `npm run db:migrate` printed "migrations applied successfully" and did not run 0013. The four
// columns did not exist; the acceptance is what caught it, not this guard.
//
// The cause is that drizzle orders and records by the journal's `when`, not by filename. 0012 had
// been stamped with a real epoch (1789056000000) and 0013 with a smaller hand-written one, so
// drizzle treated 0013 as already applied and moved on. Nothing failed. Nothing warned.
//
// That is the worst shape a deploy step can have: not a wrong answer, but no answer wearing the
// same colour as one. Production's own boot runner (server/index.ts phase 3) reads the DIRECTORY
// in filename order, so the two systems can also disagree about what is applied — one silently
// right, the other silently wrong, with no signal either way. That is why rule (f) below requires
// the two ORDERS to match, not merely the two sets.
//
// FAIL CLOSED, and this is the correction to the first version of this guard. It opened with
// `if (existsSync(JOURNAL_PATH))`, so deleting the journal skipped every rule below it and the
// build stayed green — a guard that can be silenced by removing its subject is not a guard. The
// same applies one level in: a missing or non-numeric `when` slipped past the monotonic
// comparison, because `undefined <= undefined` is false. Shape is therefore validated BEFORE any
// rule that depends on it.
//
// Read-only: no runtime behaviour, no second migration runner.
const JOURNAL_PATH = "migrations/meta/_journal.json";
/**
 * THE ONLY TWO UNNUMBERED MIGRATIONS, BY EXACT NAME. Both predate the journal and are executed by
 * the boot runner in directory order; drizzle has never recorded either. Listed literally rather
 * than matched by shape so the exemption cannot grow: a new unnumbered file is a mistake, not a
 * third legacy case.
 */
const LEGACY_UNNUMBERED = new Set(["add_client_intelligence_profiles.sql", "add_shadow_replies.sql"]);
if (!existsSync(JOURNAL_PATH)) {
  problems.push(
    `${JOURNAL_PATH} is missing — "db:migrate" has no list to apply and will do nothing, silently.`
    + `\n     This file is the deploy path's only record of what has run. It is never optional.`,
  );
} else {
  let journal: any;
  let parsed = false;
  try {
    journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8"));
    parsed = true;
  } catch (e: any) {
    problems.push(`${JOURNAL_PATH} could not be parsed: ${e?.message || e}`);
  }

  // THE ROOT MUST BE A REAL OBJECT, and this is the third fail-open hole found in this guard.
  // `JSON.parse("null")` SUCCEEDS and yields null; so do `false`, `0` and `""`. The previous
  // version tested `journal && Array.isArray(journal.entries)`, so every one of those scalars made
  // `entries` null, skipped the "no entries array" branch because `journal` was falsy, skipped
  // every rule below it, and left the build green. Replacing the journal with the four characters
  // `null` silenced the entire guard. An array root is rejected for the same reason: it carries no
  // `entries` and is not the shape drizzle writes.
  let entries: any[] | null = null;
  if (parsed) {
    const isPlainObject = journal !== null && typeof journal === "object" && !Array.isArray(journal);
    if (!isPlainObject) {
      problems.push(
        `${JOURNAL_PATH} root is ${Array.isArray(journal) ? "an array" : JSON.stringify(journal)} — must be an object with an "entries" array.`
        + `\n     JSON.parse accepts null, false, 0 and "" as valid documents, so a scalar here is a`
        + `\n     parseable file that describes no migrations at all.`,
      );
    } else if (!Array.isArray(journal.entries)) {
      problems.push(`${JOURNAL_PATH} has no "entries" array — nothing can be verified about what will run.`);
    } else {
      entries = journal.entries;
    }
  }

  if (entries) {
    // a. EVERY ENTRY IS THE SHAPE THE LATER RULES ASSUME. Checked first and tracked, because a
    //    comparison against undefined does not throw — it quietly evaluates false, which is how a
    //    missing `when` walked through the monotonic check.
    let wellFormed = true;
    entries.forEach((e, i) => {
      if (!e || typeof e !== "object") {
        problems.push(`${JOURNAL_PATH} entry ${i} is not an object.`); wellFormed = false; return;
      }
      if (!Number.isInteger(e.idx) || e.idx < 0) {
        problems.push(`${JOURNAL_PATH} entry ${i} has idx ${JSON.stringify(e.idx)} — must be a non-negative integer.`);
        wellFormed = false;
      }
      if (typeof e.when !== "number" || !Number.isFinite(e.when)) {
        problems.push(
          `${JOURNAL_PATH} entry ${i} ("${e.tag ?? "?"}") has when=${JSON.stringify(e.when)} — must be a finite number.`
          + `\n     drizzle orders by this field; a missing or non-numeric value cannot be compared,`
          + `\n     so the ordering rule below would pass while the ordering itself is undefined.`,
        );
        wellFormed = false;
      }
      if (typeof e.tag !== "string" || !e.tag.trim()) {
        problems.push(`${JOURNAL_PATH} entry ${i} has tag ${JSON.stringify(e.tag)} — must be a non-empty string.`);
        wellFormed = false;
      }
    });

    // b. Indexes contiguous and in order. A gap or a repeat means two authors edited the journal
    //    without seeing each other, which is exactly when the rest of these rules start to matter.
    if (wellFormed) {
      entries.forEach((e, i) => {
        if (e.idx !== i) {
          problems.push(`${JOURNAL_PATH} entry ${i} has idx ${e.idx} — indexes must be contiguous and in order.`);
        }
      });
    }

    // c. `when` STRICTLY increasing. This is the rule whose violation skipped 0013 in silence.
    if (wellFormed) {
      for (let i = 1; i < entries.length; i++) {
        if (entries[i].when <= entries[i - 1].when) {
          problems.push(
            `${JOURNAL_PATH}: "${entries[i].tag}" has when=${entries[i].when}, not after "${entries[i - 1].tag}" (${entries[i - 1].when}).`
            + `\n     drizzle orders by this field, so a migration stamped behind its predecessor is`
            + `\n     reported as applied and never runs. Stamp it later than every existing entry.`,
          );
        }
      }
    }

    // d. Tags unique. Two entries naming one file is ambiguous about which was applied.
    const seen = new Set<string>();
    for (const e of entries) {
      const tag = typeof e?.tag === "string" ? e.tag : "";
      if (!tag) continue;
      if (seen.has(tag)) problems.push(`${JOURNAL_PATH}: duplicate tag "${tag}".`);
      seen.add(tag);
    }

    // e. Every journal entry has the SQL file it names.
    for (const e of entries) {
      const tag = typeof e?.tag === "string" ? e.tag : "";
      if (!tag) continue;
      if (!existsSync(join("migrations", `${tag}.sql`))) {
        problems.push(`${JOURNAL_PATH} names "${tag}" but migrations/${tag}.sql does not exist.`);
      }
    }

    // f. THE TWO ORDERS MUST MATCH, not merely the two sets.
    //
    //    drizzle applies in JOURNAL order; the boot runner applies in FILENAME order. Checking
    //    membership alone lets two valid tags be swapped — every other rule here still passes,
    //    and the two systems then apply the same migrations in different orders. For DDL that is
    //    a schema that depends on which runner touched the database first.
    //
    //    Scoped to the `NNNN_` shape on purpose: the repo carries two legacy unnumbered files
    //    (add_client_intelligence_profiles.sql, add_shadow_replies.sql) that the boot runner
    //    executes by directory order and that drizzle has never journaled. Failing them here would
    //    make this guard red on the day it ships, which teaches people to disable it — the one
    //    outcome worse than not having it.
    const NUMBERED = /^\d{4}_/;

    // g. NO NEW UNNUMBERED MIGRATIONS, AND NO UNNUMBERED JOURNAL TAGS.
    //
    //    The NNNN_ scoping above exists to grandfather two files that predate the journal. It was
    //    written as a SHAPE test, which means any future unnumbered file would inherit the
    //    exemption and bypass journal membership, ordering and file-existence checking entirely —
    //    the grandfather clause would quietly become a bypass. So the exemption is now EXACTLY
    //    those two names, and everything else must be numbered.
    for (const f of migrations) {
      if (LEGACY_UNNUMBERED.has(f) || NUMBERED.test(f)) continue;
      problems.push(
        `migrations/${f} is not numbered — every migration after the two grandfathered legacy files`
        + `\n     must use the NNNN_ prefix, or it bypasses journal membership and ordering entirely.`
        + `\n     Grandfathered, by exact name: ${[...LEGACY_UNNUMBERED].join(", ")}`,
      );
    }
    for (const e of entries) {
      const tag = typeof e?.tag === "string" ? e.tag : "";
      if (!tag || NUMBERED.test(tag)) continue;
      problems.push(`${JOURNAL_PATH}: tag "${tag}" is not numbered — journal tags must use the NNNN_ prefix.`);
    }

    const journalNumbered = entries
      .map(e => (typeof e?.tag === "string" ? e.tag : ""))
      .filter(t => NUMBERED.test(t));
    const fileNumbered = migrations
      .filter(f => NUMBERED.test(f))
      .map(f => f.replace(/\.sql$/, ""))
      .sort();
    if (journalNumbered.join("\n") !== fileNumbered.join("\n")) {
      const firstDiff = journalNumbered.findIndex((t, i) => t !== fileNumbered[i]);
      problems.push(
        `${JOURNAL_PATH}: the numbered journal order does not match the numbered migration files.`
        + `\n     journal: ${journalNumbered.join(", ") || "(none)"}`
        + `\n     files  : ${fileNumbered.join(", ") || "(none)"}`
        + (firstDiff >= 0
          ? `\n     first divergence at position ${firstDiff}: journal has "${journalNumbered[firstDiff] ?? "(nothing)"}",`
            + ` files have "${fileNumbered[firstDiff] ?? "(nothing)"}".`
          : "")
        + `\n     drizzle applies in journal order and the boot runner in filename order; when those`
        + `\n     disagree the two deploy paths produce different schemas from the same commit.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("schema safety: FAILED\n" + problems.map(p => `  ✗ ${p}`).join("\n"));
  console.error("\nWhy this guard exists: a bad `push` corrupts the day-ledger and the only way back\nis the 6-hourly backup — up to half a day of client food logs lost.\n");
  process.exit(1);
}

console.log(`schema safety: OK (${migrations.length} committed migrations run on boot, ${new Set(declared).size} declared columns all creatable, no push in any deploy path)`);

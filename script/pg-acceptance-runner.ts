/**
 * THE POSTGRESQL ACCEPTANCE RUNNER — one owner for reset, execution, collection and exit code (#227).
 *
 * WHAT THIS REPLACES, AND WHY. The authoritative `pg-acceptance` job was eighteen sequential
 * GitHub Actions steps sharing one ephemeral database. That arrangement caused two proven
 * engineering-control failures, both of which cost real diagnosis time:
 *
 *   CROSS-ACCEPTANCE CONTAMINATION. The suites are not isolated from each other — Coach Health
 *   reads `turn_ledger` database-wide, for one — so rows written by an earlier acceptance change
 *   what a later one sees. On #224 three "product regressions" were reported from a batch run and
 *   evaporated when each acceptance was rerun after its own reset. A false diagnosis reached a
 *   lane decision before it was caught.
 *
 *   EARLY-EXIT BLINDNESS. A step that fails ends the job, so every later step is skipped. While
 *   one product acceptance was red, seven others never executed — including the proof a branch had
 *   just added. A branch could hold excellent local evidence that authoritative CI had never once
 *   run. That is the worst failure mode available to a gate: not a wrong answer, but no answer
 *   wearing the same colour as one.
 *
 * THE RULE THIS ENFORCES: every acceptance runs, every acceptance starts from the same clean
 * database, every verdict is recorded, and the job is still RED if any of them failed.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE. No `continue-on-error` — that turns a real red into a
 * warning wearing a different colour, which the workflow already rejected in writing for the
 * Journey Lab. No second PostgreSQL service to sidestep ordering. No reordering. The order below
 * is the order the workflow had.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface Acceptance {
  /** Short id for the summary table. */
  id: string;
  /** Human sentence for the log header — what this proof is about. */
  title: string;
  /** Argv to execute. Kept as argv rather than a shell string so nothing is word-split. */
  command: string[];
}

/**
 * THE INVENTORY, AND THE ONLY COPY OF IT (#227).
 *
 * This list lived in the workflow YAML, where each entry carried the reason real PostgreSQL was
 * required rather than a fixture. Those reasons are the valuable part and they move here with the
 * list; the workflow now calls this runner once. Two owners of the same inventory is how a new
 * acceptance gets added in one place and silently never runs in the other.
 */
export const ACCEPTANCES: Acceptance[] = [
  { id: "correction", title: "Targeted multi-day food correction",
    // The deterministic stub ignores ORDER BY and does not reflect UPDATEs into reads, so it
    // cannot say WHICH row a named-day correction lands on.
    command: ["npx", "tsx", "script/pg-correction-acceptance.ts"] },

  { id: "safety-turn", title: "Safety early-return turn attribution",
    command: ["npx", "tsx", "script/pg-safety-turn-acceptance.ts"] },

  { id: "step-provenance", title: "Step provenance bridge",
    // THE PROVENANCE OWNER IS A DATABASE FUNCTION (#184), so PostgreSQL is the only thing that can
    // say whether its regular expressions compile. The broken version threw inside an AFTER INSERT
    // trigger the application never awaits — a green suite, a normal reply, and every
    // client-stated step count silently left untrusted.
    command: ["npx", "tsx", "script/pg-step-provenance-acceptance.ts"] },

  { id: "client-truth", title: "Canonical client truth ordering",
    command: ["npx", "tsx", "script/pg-client-truth-acceptance.ts"] },

  { id: "fallback-truth", title: "Fallback reads canonical truth",
    // TWO READERS, ONE SET OF FACTS (#179). Provenance, resolved_day and the workout ledger are
    // COLUMNS, so only a real database can show that the canonical snapshot and the GPT fallback's
    // context are reading the same rows — a fixture that answers every query the same way cannot
    // tell two readers apart, which is how the divergence survived.
    command: ["npx", "tsx", "script/pg-fallback-truth-acceptance.ts"] },

  { id: "proactive-authority", title: "Proactive decision authority",
    // ONE COACH, PROACTIVELY AND REACTIVELY (#180). Held constraints are rows the client wrote
    // today; whether the proactive decision reads them is only answerable against a database.
    command: ["npx", "tsx", "script/pg-proactive-authority-acceptance.ts"] },

  { id: "daily-constraint", title: "Daily constraint lifecycle",
    // A DAILY CONSTRAINT IS ABOUT WHAT SURVIVES (#194). The defect was a 24-message window, and a
    // fixture that returns the same rows to every query cannot demonstrate a window.
    command: ["npx", "tsx", "script/pg-daily-constraint-acceptance.ts"] },

  { id: "food-constraint-mouths", title: "Food constraints reach the plate and grocery mouths",
    // THE CONSTRAINT REACHES EVERY MOUTH THAT NAMES A FOOD (#128). Which branch of the Next Meal
    // menu a client reaches is composed from the day ledger — what is logged, what is left — so a
    // fixture that answers every query the same way puts every client on one branch.
    command: ["npx", "tsx", "script/pg-food-constraint-mouths-acceptance.ts"] },

  { id: "weight-authority", title: "One weight-direction authority",
    // ONE ANSWER TO "WHICH WAY IS THE SCALE GOING" (#128). The verdict is computed from weigh-in
    // ROWS — how many, how far apart, how recent — against an illness window in profile_notes, and
    // the proactive half is graded on the message it actually sends, captured through the shadow
    // door. Neither is expressible on a fixture that answers every query the same way.
    command: ["npx", "tsx", "script/pg-weight-authority-acceptance.ts"] },

  { id: "open-coaching-loop", title: "Open training move survives and resolves across turns",
    // ONE OPEN COACHING LOOP (#208). Restart durability, user isolation and exact SAST attribution
    // require the real database; a fixture cannot prove compare-and-set closure.
    command: ["npx", "tsx", "script/pg-open-coaching-loop-acceptance.ts"] },

  { id: "thin-evidence", title: "Thin-evidence coaching",
    // A SPARSE CLIENT IS COACHED, NOT JUST RECEIPTED (#203). Every decision here is computed from
    // rows — how many days carry a meal, whether one carries TODAY, how stale the weigh-in is, and
    // whether a same-day re-weigh updates or inserts.
    command: ["npx", "tsx", "script/pg-thin-evidence-acceptance.ts"] },

  { id: "information-value", title: "Highest-value investigation",
    // INFORMATION VALUE (#213). Weekend coverage, stalled trend, the durable open loop and the
    // later backdated answer are all real rows; this grades the one canonical INVESTIGATE owner.
    command: ["npx", "tsx", "script/pg-information-value-acceptance.ts"] },

  { id: "behaviour-patterns", title: "Evidence-backed behavioural patterns",
    // BEHAVIOURAL PATTERN STATE (#217). Repetition, attributed outcomes, user isolation and
    // contradiction are properties of longitudinal rows. The profile must then be read by the
    // same canonical decision through both doors; a fixture cannot establish either claim.
    command: ["npx", "tsx", "script/pg-behaviour-pattern-acceptance.ts"] },

  { id: "log-turn", title: "Durable log turns are one coaching turn",
    // ONE COACH SPEAKING (#207). The repetition defect this closes is invisible to a fixture that
    // sends one message per client: it only appears across CONSECUTIVE durable writes by the same
    // person, where the decision is recomputed from day state the new event did not move.
    command: ["npx", "tsx", "script/pg-log-turn-acceptance.ts"] },

  { id: "facts", title: "Facts, retractions and same-turn propagation",
    // FACTS, RETRACTIONS AND SAME-TURN PROPAGATION (#211). Retraction-before-append ordering, one
    // operation building on another's patch, and unrelated columns left alone are all properties
    // of a real transaction — which is how a retracted diet came back inside its own write.
    command: ["npx", "tsx", "script/pg-facts-acceptance.ts"] },

  { id: "food-identity", title: "Food identity and stated portion",
    // FOOD IDENTITY AND STATED PORTION (#206). Identity and portion are what get WRITTEN, and the
    // invented-combo defects were visible only as kcal in the ledger.
    command: ["npx", "tsx", "script/pg-food-identity-acceptance.ts"] },

  { id: "weight-speakability", title: "Weight authority and speakability",
    // ONE WEIGHT AUTHORITY, ONE SPEAKABILITY VERDICT (#216). Illness contamination, window width
    // and chronology are all properties of stored rows against stored dates, and the Monday claims
    // only exist as a sent message — SHADOW=on captures them.
    command: ["npx", "tsx", "script/pg-weight-speakability-acceptance.ts"] },

  { id: "restriction-consistency", title: "One restriction across every food surface",
    // ONE RESTRICTION, EVERY SURFACE (#220). Consistency is a claim about what a CLIENT receives
    // across surfaces reached by different handlers, different scheduler jobs and different cron
    // minutes — a unit test on `allows` proves the predicate and nothing about who asked it.
    command: ["npx", "tsx", "script/pg-restriction-consistency-acceptance.ts"] },

  { id: "comeback-clock", title: "One comeback clock",
    // ONE COMEBACK CLOCK (#221). Both defects are claims about CHRONOLOGY across stored rows — a
    // workout row's logged_at against a user's lastActiveAt, read through the real handler.
    command: ["npx", "tsx", "script/pg-comeback-clock-acceptance.ts"] },

  { id: "journey-lab", title: "Six critical journeys through the real system",
    // THE SIX JOURNEYS (#170). Same database, same migrations, same front door — a second job
    // would be a second copy of this infrastructure for no gain. It is in this runner for the same
    // reason it was never `continue-on-error`: a known-wrong durable state must not be reported as
    // a warning, and this runner keeps its red a red.
    command: ["npm", "run", "test:journeys"] },
];

// ── THE RESET, AND WHAT IT REFUSES TO DO ──────────────────────────────────────────────────────

/** Hosts a throwaway test database can legitimately live on. Anything else is somebody's data. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "postgres"]);

/**
 * FAIL CLOSED, AND SAY WHY (#227).
 *
 * This function's whole job is to stand between "truncate every table" and a database that is not
 * a disposable test one. It answers with a REASON rather than a boolean because the reason is what
 * a person reads at 2am when the runner refuses, and because a control can assert on it.
 *
 * The decisive check is the host: a production database for this product lives behind a remote
 * hostname, so refusing every non-loopback host puts it out of reach by construction rather than
 * by a name pattern someone could match by accident. The explicit opt-in is the second lock — a
 * developer who runs this file by hand on a laptop must say so, so that no script, hook or editor
 * task can wipe their working database as a side effect of doing something else.
 */
export function testDatabaseSafety(
  url: string | undefined,
  env: { CI?: string; PG_ACCEPTANCE_ALLOW_RESET?: string; NODE_ENV?: string } = {},
): { safe: true } | { safe: false; reason: string } {
  if (!url) return { safe: false, reason: "DATABASE_URL is not set" };

  let parsed: URL;
  try { parsed = new URL(url); } catch { return { safe: false, reason: "DATABASE_URL is not a URL" }; }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    return { safe: false, reason: `not a PostgreSQL URL (protocol ${parsed.protocol})` };
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    return { safe: false, reason: `host ${parsed.hostname} is not a local throwaway database` };
  }
  if (env.NODE_ENV === "production") {
    return { safe: false, reason: "NODE_ENV=production" };
  }
  // The opt-in is last so the message a developer sees first is about the DATABASE, not the flag.
  if (env.CI !== "true" && env.PG_ACCEPTANCE_ALLOW_RESET !== "1") {
    return { safe: false, reason: "not CI, and PG_ACCEPTANCE_ALLOW_RESET=1 was not given" };
  }
  return { safe: true };
}

/**
 * A CLEAN DATABASE MEANS THE SCHEMA TOO, NOT ONLY THE ROWS (#227, review).
 *
 * The first version of this truncated every table, which is not the promise this runner makes.
 * Acceptances mutate SCHEMA as well as data: `pg-step-provenance-acceptance` deliberately installs
 * the pre-#184 faulty `kamlife_parse_step_report`, proves it reproduces the original error, and
 * puts the working one back three statements later. If anything throws in that window the broken
 * function stays installed — and TRUNCATE does not remove a function. Every later acceptance,
 * Journey Lab included, would then run against a database whose step parser is the known-broken
 * one, and report cascading failures that belong to nothing in the diff. That is the exact
 * contamination this cut exists to end, arriving through a door truncation cannot close.
 *
 * So the reset rebuilds: drop the schema, drop the migration ledger with it, re-apply the
 * committed migrations. Measured at ~1.5s, which is the right trade against a class of false
 * failure that costs hours to diagnose and has already cost some.
 *
 * BOTH SCHEMAS, AND THAT IS NOT A DETAIL. Drizzle keeps `__drizzle_migrations` in its own `drizzle`
 * schema, so dropping `public` alone leaves the ledger claiming every migration is applied and the
 * re-migrate silently does nothing — a rebuild that produces an EMPTY database while reporting
 * success. Proven by measurement: dropping `public` only left 0 tables behind.
 */
export async function resetTestDatabase(
  pool: { query: (q: string) => Promise<unknown> },
  migrate: () => { status: number | null } = () =>
    spawnSync("npm", ["run", "db:migrate"], { stdio: "pipe", env: process.env }),
): Promise<void> {
  await pool.query(
    `DROP SCHEMA IF EXISTS public CASCADE;
     DROP SCHEMA IF EXISTS drizzle CASCADE;
     CREATE SCHEMA public;`);
  const { status } = migrate();
  if (status !== 0) throw new Error(`db:migrate failed while rebuilding the test schema (exit ${status})`);
}

// ── EXECUTION AND COLLECTION ──────────────────────────────────────────────────────────────────

export interface AcceptanceResult { id: string; ok: boolean; code: number | null; note: string }

/**
 * Run every acceptance, each against a freshly reset database, and return one verdict per entry.
 *
 * Nothing here stops early. A failing acceptance is recorded and the next one starts from a clean
 * database — which is the entire point: one red must not hide the evidence behind it, and must not
 * poison it either. The caller decides the exit code from the collected results.
 */
export async function runAcceptances(
  entries: Acceptance[],
  deps: {
    reset: () => Promise<void>;
    run: (cmd: string[]) => { status: number | null };
    log?: (line: string) => void;
  },
): Promise<AcceptanceResult[]> {
  const log = deps.log || (() => {});
  const results: AcceptanceResult[] = [];
  for (const a of entries) {
    log(`\n──────── ${a.id} · ${a.title}`);
    try {
      await deps.reset();
    } catch (e: any) {
      // A reset that fails is not a reason to run the next acceptance against whatever is left —
      // that is the contamination this exists to remove, arriving through the back door.
      results.push({ id: a.id, ok: false, code: null, note: `reset failed: ${e?.message || e}` });
      log(`  RESET FAILED — ${e?.message || e}`);
      continue;
    }
    const { status } = deps.run(a.command);
    const ok = status === 0;
    results.push({ id: a.id, ok, code: status, note: ok ? "" : `exit ${status}` });
    log(`  ${ok ? "GREEN" : `RED (exit ${status})`}`);
  }
  return results;
}

/** The gate: any failure is a failure. Kept separate so a control can assert it directly. */
export function exitCodeFor(results: AcceptanceResult[]): number {
  return results.some(r => !r.ok) ? 1 : 0;
}

export function summarise(results: AcceptanceResult[]): string {
  const width = Math.max(...results.map(r => r.id.length), 4);
  const rows = results.map(r =>
    `  ${r.ok ? "GREEN" : "RED  "}  ${r.id.padEnd(width)}  ${r.note}`.trimEnd());
  const red = results.filter(r => !r.ok);
  return [
    "",
    "══════════════════════════════════════════════════════════════════",
    `PG ACCEPTANCE SUMMARY — ${results.length} run, ${results.length - red.length} green, ${red.length} red`,
    "══════════════════════════════════════════════════════════════════",
    ...rows,
    "",
    red.length
      ? `pg-acceptance: RED — ${red.map(r => r.id).join(", ")}`
      : "pg-acceptance: GREEN — every acceptance executed and passed",
  ].join("\n");
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const safety = testDatabaseSafety(process.env.DATABASE_URL, process.env as any);
  if (!safety.safe) {
    console.error(`pg-acceptance-runner: REFUSING TO RESET — ${safety.reason}.`);
    console.error("This runner truncates every table it can see, so it only ever points at a");
    console.error("throwaway local/CI database. Set DATABASE_URL to one and, outside CI, pass");
    console.error("PG_ACCEPTANCE_ALLOW_RESET=1 to say so deliberately.");
    process.exit(2);
  }

  const { pool } = await import("../server/db");
  const results = await runAcceptances(ACCEPTANCES, {
    reset: () => resetTestDatabase(pool),
    // stdio inherited so each acceptance's own PASS/FAIL lines stay in the CI log verbatim —
    // the summary is an index to that output, never a replacement for it.
    run: (cmd) => spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", env: process.env }),
    log: (l) => console.log(l),
  });
  console.log(summarise(results));
  await pool.end().catch(() => {});
  process.exit(exitCodeFor(results));
}

// Only when executed directly — importing this file for its inventory or its guard must not run it.
if (process.argv[1] && existsSync(process.argv[1]) && process.argv[1].endsWith("pg-acceptance-runner.ts")) {
  await main();
}

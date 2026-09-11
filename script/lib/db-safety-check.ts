/**
 * "MAY THIS DATABASE BE TRUNCATED?" — asked of the owner, answered for bash.
 *
 * The red-on-revert scripts truncate every table before each case. They must never do that to a
 * database that is not a local throwaway, and the rule for deciding that already has an owner:
 * `testDatabaseSafety` in script/pg-acceptance-runner.ts (loopback hosts only, never
 * NODE_ENV=production, CI or an explicit PG_ACCEPTANCE_ALLOW_RESET=1).
 *
 * This is a two-line adapter so six shell scripts can consult that owner instead of each
 * reimplementing its rules — six copies of a destructive-operation guard is five chances for one
 * to drift without anything failing.
 *
 * It is a FILE rather than an inline `tsx -e` because inline eval is transformed as CommonJS and
 * the runner uses top-level await, which fails the transform. That failure was silent behind
 * `2>/dev/null` and made every database report "safety check could not run" — fail-closed, but
 * refusing the valid case too, which is a guard that grades nothing.
 *
 * Prints exactly `SAFE` or `UNSAFE: <reason>` on stdout. Exit code is not the signal; the caller
 * reads the line.
 */
import { testDatabaseSafety } from "../pg-acceptance-runner";

const verdict = testDatabaseSafety(process.env.DATABASE_URL, process.env as any);
process.stdout.write(verdict.safe ? "SAFE" : `UNSAFE: ${verdict.reason}`);

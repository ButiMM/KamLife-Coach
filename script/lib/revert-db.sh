# shellcheck shell=bash
#
# THE DATABASE CONTRACT FOR RED-ON-REVERT SCRIPTS (Cut 1B, 2026-09-11).
#
# ══════════════════════════════════════════════════════════════════════════════════════════════
# WHY THIS EXISTS
# ══════════════════════════════════════════════════════════════════════════════════════════════
#
# Six revert scripts each carried their own copy of this line:
#
#     PGPASSWORD=kam psql -h 127.0.0.1 -U kam -d journeylab -q -c "…TRUNCATE…" >/dev/null 2>&1
#
# Three defects in one line, repeated six times.
#
#   1. THE DATABASE NAME IS HARDCODED. CI runs `kamlife`, not `journeylab`. Every one of those
#      calls fails in CI.
#   2. THE FAILURE IS SWALLOWED. `>/dev/null 2>&1` with no return check, so a reset that never
#      happened looks identical to one that did. Proven on 2026-09-11: the voice-provenance revert
#      script — the only one registered in the CI inventory — reset NOTHING in nine consecutive
#      CI cases and still reported 9/9. It passed because the acceptance happens to clean up after
#      itself, which is luck, not isolation.
#   3. NOTHING CHECKS WHAT IT IS POINTED AT. These scripts TRUNCATE EVERY TABLE. A DATABASE_URL
#      aimed at a real database would be a data-loss event with no confirmation step.
#
# ══════════════════════════════════════════════════════════════════════════════════════════════
# ONE OWNER, NOT SIX COPIES
# ══════════════════════════════════════════════════════════════════════════════════════════════
#
# This file is sourced by all six. A safety rule copied six times is a safety rule that drifts in
# five of them without anything failing — which is the same shape as the defect above, one layer
# out. The safety QUESTION itself is not re-answered here either: `testDatabaseSafety` in
# script/pg-acceptance-runner.ts already owns "may this database be reset?" (loopback host only,
# never NODE_ENV=production, CI or an explicit opt-in), and this asks that owner rather than
# reimplementing its rules in bash.
#
# EVERY FAILURE IS LOUD AND FATAL. There is no path through this file that lets a script keep
# grading after the database it grades against was not prepared.

# Fail fatally unless DATABASE_URL is set AND the existing owner says it is safe to truncate.
# Call once, before any case runs.
revert_db_require_safe () {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "FATAL: DATABASE_URL is not set. These cases truncate the database and grade against it;"
    echo "       without one they would grade nothing and report success. Refusing to run." >&2
    exit 1
  fi
  local verdict
  # Stderr is NOT suppressed: a safety check that cannot run must be visible, not mistaken for a
  # verdict. Silencing it is what made every database report "could not run" while the real cause
  # was a CommonJS transform error.
  verdict="$(npx tsx "$(dirname "$0")/lib/db-safety-check.ts")"
  if [[ "$verdict" != "SAFE" ]]; then
    echo "FATAL: refusing to truncate this database — ${verdict:-safety check could not run}." >&2
    echo "       These cases TRUNCATE EVERY TABLE. Point DATABASE_URL at a local throwaway" >&2
    echo "       database and set PG_ACCEPTANCE_ALLOW_RESET=1 (CI sets CI=true)." >&2
    exit 1
  fi
}

# Truncate every table except the two migration ledgers. Returns non-zero on ANY failure, so the
# caller can fail its case instead of grading against a database it did not prepare.
#
# schema_migrations is preserved alongside __drizzle_migrations: the boot runner tracks applied
# migrations there, and emptying it would make every migration re-run mid-suite. Three of these six
# scripts previously truncated it; that was never deliberate.
revert_db_reset () {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
    "DO \$\$ DECLARE t text; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('__drizzle_migrations','schema_migrations') LOOP EXECUTE format('TRUNCATE TABLE %I CASCADE', t); END LOOP; END \$\$;" \
    >/dev/null
}

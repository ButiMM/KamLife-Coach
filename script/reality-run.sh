#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════════════════════
# COACH K REALITY TEST — RUNNER
#
# One command. Provisions a THROWAWAY PostgreSQL, applies the migration chain from zero, runs
# the six journeys against the real model and the real application code, writes a report, and
# destroys the database.
#
# It touches no production data: the database is created for this run and dropped after it.
#
# WHAT IT NEEDS
#   · network egress to api.openai.com
#   · AI_INTEGRATIONS_OPENAI_API_KEY exported (the variable the application itself reads)
#   · either Docker, or a PostgreSQL you can create a database on (see REALITY_ADMIN_URL)
#
# USAGE
#   export AI_INTEGRATIONS_OPENAI_API_KEY=...        # never echoed by this script
#   ./script/reality-run.sh
#
#   # …or point it at a Postgres you already have:
#   REALITY_ADMIN_URL=postgresql://user@host:5432/postgres ./script/reality-run.sh
#
# EXIT CODES  (deliberately distinct — see §3 of the directive)
#   0  all six journeys PASS
#   1  at least one journey FAILED       → a product result
#   3  the model was unreachable          → ENVIRONMENT, not a product result
#   2  setup could not complete           → ENVIRONMENT, not a product result
# ════════════════════════════════════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")/.."

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY="$(git status --porcelain 2>/dev/null | head -1)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="reality-baseline-${SHA}-${STAMP}.txt"
DBNAME="kamlife_reality_${STAMP}"
CONTAINER="kamlife-reality-${STAMP}"

echo "COACH K REALITY TEST — RUNNER"
echo "  commit under test : ${SHA}${DIRTY:+  (WORKING TREE DIRTY — the report will say so)}"
echo "  report            : ${REPORT}"
echo

# ── The key. Checked for PRESENCE only; never printed, never logged. ────────────────────────
if [ -z "${AI_INTEGRATIONS_OPENAI_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "STOP: no OpenAI key in the environment."
  echo "      export AI_INTEGRATIONS_OPENAI_API_KEY=...   (the variable the app reads)"
  echo "      Nothing is printed or written anywhere by this script."
  exit 2
fi
# The harness reads the same chain the app does. Alias it so a shell that only has one of the
# two names still works — this is an environment alias, NOT a change to the code under test.
export OPENAI_API_KEY="${AI_INTEGRATIONS_OPENAI_API_KEY:-${OPENAI_API_KEY}}"
export AI_INTEGRATIONS_OPENAI_API_KEY="${AI_INTEGRATIONS_OPENAI_API_KEY:-${OPENAI_API_KEY}}"

cleanup() {
  if [ -n "${STARTED_DOCKER:-}" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "  (throwaway database container removed)"
  elif [ -n "${CREATED_DB:-}" ]; then
    psql "$REALITY_ADMIN_URL" -c "DROP DATABASE IF EXISTS \"$DBNAME\";" >/dev/null 2>&1 \
      && echo "  (throwaway database dropped)"
  fi
}
trap cleanup EXIT

# ── Provision a throwaway database ─────────────────────────────────────────────────────────
if [ -n "${REALITY_ADMIN_URL:-}" ]; then
  echo "→ creating database $DBNAME on the Postgres you supplied"
  psql "$REALITY_ADMIN_URL" -c "CREATE DATABASE \"$DBNAME\";" >/dev/null || { echo "STOP: could not create $DBNAME"; exit 2; }
  CREATED_DB=1
  DB_URL="$(printf '%s' "$REALITY_ADMIN_URL" | sed -E "s#/[^/?]*(\\?|\$)#/$DBNAME\\1#")"
elif command -v docker >/dev/null 2>&1; then
  echo "→ starting a throwaway PostgreSQL in Docker (port 55432)"
  docker run -d --rm --name "$CONTAINER" -e POSTGRES_PASSWORD=reality \
    -e POSTGRES_DB="$DBNAME" -p 55432:5432 postgres:16-alpine >/dev/null || { echo "STOP: docker run failed"; exit 2; }
  STARTED_DOCKER=1
  DB_URL="postgresql://postgres:reality@localhost:55432/$DBNAME"
  printf "  waiting for it to accept connections"
  for _ in $(seq 1 40); do
    if docker exec "$CONTAINER" pg_isready -q 2>/dev/null; then echo " — ready"; break; fi
    printf "."; sleep 1
  done
else
  echo "STOP: no Docker and no REALITY_ADMIN_URL, so there is nowhere to put a throwaway database."
  echo "      Either install Docker, or run with:"
  echo "        REALITY_ADMIN_URL=postgresql://user@host:5432/postgres ./script/reality-run.sh"
  echo "      Do NOT point this at the production database."
  exit 2
fi
export DATABASE_URL="$DB_URL"

# ── The migration chain, from zero ─────────────────────────────────────────────────────────
echo "→ applying the migration chain from zero"
if ! npx drizzle-kit migrate >/dev/null 2>&1; then
  echo "STOP: migrations failed. Re-run without the redirect to see why:"
  echo "      DATABASE_URL=<url> npx drizzle-kit migrate"
  exit 2
fi
TABLES="$(psql "$DATABASE_URL" -tAc "select count(*) from information_schema.tables where table_schema='public';" 2>/dev/null | tr -d ' ')"
echo "  ${TABLES:-?} tables created"

# ── Run the six journeys ───────────────────────────────────────────────────────────────────
echo "→ running the six journeys against the real model"
echo
{
  echo "COACH K REALITY BASELINE"
  echo "commit under test : ${SHA}"
  [ -n "$DIRTY" ] && echo "WARNING           : working tree was DIRTY — this is not a clean commit baseline"
  echo "run at (UTC)      : ${STAMP}"
  echo "database          : throwaway, migration chain applied from zero, ${TABLES:-?} tables, no client data"
  echo "model             : real OpenAI API"
  echo
} > "$REPORT"

REALITY_LLM=1 npx tsx script/reality-test.ts 2>&1 | tee -a "$REPORT"
CODE="${PIPESTATUS[0]}"

echo
case "$CODE" in
  0) echo "RESULT: all six journeys PASS  (exit 0)" ;;
  1) echo "RESULT: at least one journey FAILED — a product result  (exit 1)" ;;
  3) echo "RESULT: ENVIRONMENT — the model could not be reached, so NO verdict was rendered  (exit 3)" ;;
  *) echo "RESULT: ENVIRONMENT — setup did not complete  (exit $CODE)" ;;
esac
echo "Report written to: $REPORT"
echo "Send that file back as-is. It carries the transcripts and the ledger records."
exit "$CODE"

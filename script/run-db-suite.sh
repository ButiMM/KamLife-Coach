#!/usr/bin/env bash
# Runs the full verification suite exactly as the pg-acceptance job in .github/workflows/test.yml,
# on any machine with Node 20+ and npm, with no Docker. Codex runs this on the exact head SHA of every
# PR labelled `ready` (AGENTS.md step 6). Exit code 0 = PASS.
set -uo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL=postgres://kam:kam@127.0.0.1:5432/kamlife
export CI=true                      # GitHub sets this on every job; keep parity
export PG_ACCEPTANCE_ALLOW_RESET=1  # throwaway local database, created and destroyed by this script
npm ci --no-audit --no-fund
( cd /tmp && rm -rf kamlife-pg-runtime && mkdir kamlife-pg-runtime && cd kamlife-pg-runtime \
  && npm init -y >/dev/null && npm i --no-audit --no-fund embedded-postgres@16.14.0-beta.17 >/dev/null )
cp script/db-suite-pg.mjs /tmp/kamlife-pg-runtime/
rm -rf /tmp/kamlife-pgdata
node /tmp/kamlife-pg-runtime/db-suite-pg.mjs & PG=$!
trap 'kill $PG 2>/dev/null; wait $PG 2>/dev/null' EXIT
for i in $(seq 1 60); do node -e "require('net').connect(5432,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" && break; sleep 1; done
fail=0
run() { echo "=== $*"; "$@" || { echo "FAILED: $*"; fail=1; }; }
run npm run check
run npm test
run npm run db:migrate
run npx tsx script/pg-acceptance-runner-controls.ts
run npx tsx script/pg-acceptance-runner.ts
[ $fail -eq 0 ] && echo "DB SUITE: PASS" || echo "DB SUITE: FAIL"
exit $fail

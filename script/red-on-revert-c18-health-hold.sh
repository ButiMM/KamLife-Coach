#!/usr/bin/env bash
# C18: the durable sick fact must bind the one-action training decision.
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe
ACC=script/pg-c18-health-hold-acceptance.ts
FILE=server/one-action.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c18-health-revert.XXXXXX")"
cp "$FILE" "$WORK_ROOT/one-action.ts"
cleanup () { cp "$WORK_ROOT/one-action.ts" "$FILE"; rm -f "$WORK_ROOT/one-action.ts"; rmdir "$WORK_ROOT"; }
trap cleanup EXIT INT TERM
if ! revert_db_reset; then echo "CONTROL: database reset failed"; exit 1; fi
control="$(npx tsx "$ACC" 2>&1)"
if ! printf '%s\n' "$control" | grep -q '^pg-c18-health-hold-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched health-hold acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-c18-health-hold-acceptance:' | head -5
  exit 1
fi
node - "$FILE" <<'JS'
const fs = require("fs");
const file = process.argv[2];
const source = fs.readFileSync(file, "utf8");
const before = "if (s.sick) {";
if (!source.includes(before)) process.exit(3);
fs.writeFileSync(file, source.replace(before, "if (false && s.sick) {"), "utf8");
JS
if [[ $? -ne 0 ]]; then echo "red-on-revert-c18-health-hold: FAILED — seam not found"; exit 1; fi
if ! revert_db_reset; then echo "red-on-revert-c18-health-hold: FAILED — database reset failed"; exit 1; fi
out="$(npx tsx "$ACC" 2>&1)"
verdict="$(printf '%s\n' "$out" | grep '^pg-c18-health-hold-acceptance:' | tail -1 || true)"
if [[ "$verdict" =~ FAILED ]] && printf '%s\n' "$out" | grep -q '^  FAIL'; then
  echo "red-on-revert-c18-health-hold: GREEN — health decision revert turns the final body red"
  exit 0
fi
echo "red-on-revert-c18-health-hold: FAILED — acceptance did not turn red (${verdict:-missing})"
exit 1

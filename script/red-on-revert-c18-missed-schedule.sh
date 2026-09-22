#!/usr/bin/env bash
# C18: the schedule owner must send the next slot, without debt or reset language.
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe
ACC=script/pg-c18-missed-schedule-acceptance.ts
FILE=server/handlers/early-commands.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c18-missed-revert.XXXXXX")"
cp "$FILE" "$WORK_ROOT/early-commands.ts"
cleanup () { cp "$WORK_ROOT/early-commands.ts" "$FILE"; rm -f "$WORK_ROOT/early-commands.ts"; rmdir "$WORK_ROOT"; }
trap cleanup EXIT INT TERM
run_case () {
  local name="$1" before="$2" after="$3" out verdict patched
  cp "$WORK_ROOT/early-commands.ts" "$FILE"
  node - "$FILE" "$before" "$after" <<'JS'
const fs = require("fs");
const [file, before, after] = process.argv.slice(2);
const source = fs.readFileSync(file, "utf8");
if (!source.includes(before)) process.exit(3);
fs.writeFileSync(file, source.replace(before, after), "utf8");
JS
  patched=$?
  if [[ $patched -ne 0 ]]; then echo "  FAIL  $name — seam not found"; return 1; fi
  if ! revert_db_reset; then echo "  FAIL  $name — database reset failed"; return 1; fi
  out="$(npx tsx "$ACC" 2>&1)"
  verdict="$(printf '%s\n' "$out" | grep '^pg-c18-missed-schedule-acceptance:' | tail -1 || true)"
  if [[ "$verdict" =~ FAILED ]] && printf '%s\n' "$out" | grep -q '^  FAIL'; then
    echo "  PASS  $name → $verdict"
    return 0
  fi
  echo "  FAIL  $name — acceptance did not turn red (${verdict:-missing})"
  return 1
}
if ! revert_db_reset; then echo "CONTROL: database reset failed"; exit 1; fi
control="$(npx tsx "$ACC" 2>&1)"
if ! printf '%s\n' "$control" | grep -q '^pg-c18-missed-schedule-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched missed-schedule acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-c18-missed-schedule-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched C18 missed-schedule acceptance is GREEN"
failed=0
run_case "missed work becomes a reset again" \
  'Today'"'"'s scheduled session is next when you'"'"'re ready.' \
  'Today is the reset. Catch up now.' || failed=$((failed + 1))
run_case "calendar slot is ignored after a miss" \
  'slot: getTodaySlot(user), intro, doneHint,' \
  'slot: 1, intro, doneHint,' || failed=$((failed + 1))
cp "$WORK_ROOT/early-commands.ts" "$FILE"
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-c18-missed-schedule: FAILED — $failed seam(s) unguarded"
  exit 1
fi
echo "red-on-revert-c18-missed-schedule: GREEN — 2/2 behavioral reverts caught"

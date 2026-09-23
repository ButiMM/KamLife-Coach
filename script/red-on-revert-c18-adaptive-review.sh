#!/usr/bin/env bash
# C18: a plateau cannot cut on under-target intake or lose its durable decision record.
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-c18-adaptive-review-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c18-adaptive-revert.XXXXXX")"
FILES=(server/adaptive-targets.ts server/scheduler/jobs/adaptive.ts)
for f in "${FILES[@]}"; do cp "$f" "$WORK_ROOT/$(printf '%s' "$f" | tr '/' '_')"; done
restore_case () { for f in "${FILES[@]}"; do cp "$WORK_ROOT/$(printf '%s' "$f" | tr '/' '_')" "$f"; done; }
cleanup () {
  restore_case
  for f in "$WORK_ROOT"/*; do rm -f "$f"; done
  rmdir "$WORK_ROOT"
}
trap cleanup EXIT INT TERM

run_case () {
  local name="$1" file="$2" before="$3" after="$4" out verdict patched
  restore_case
  node - "$file" "$before" "$after" <<'JS'
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
  verdict="$(printf '%s\n' "$out" | grep '^pg-c18-adaptive-review-acceptance:' | tail -1 || true)"
  if [[ "$verdict" =~ FAILED ]] && printf '%s\n' "$out" | grep -q '^  FAIL'; then
    echo "  PASS  $name → $verdict"
    return 0
  fi
  echo "  FAIL  $name — acceptance did not turn red (${verdict:-missing})"
  return 1
}

if ! revert_db_reset; then echo "CONTROL: database reset failed"; exit 1; fi
control="$(npx tsx "$ACC" 2>&1)"
if ! printf '%s\n' "$control" | grep -q '^pg-c18-adaptive-review-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched adaptive acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-c18-adaptive-review-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched C18 adaptive acceptance is GREEN"

failed=0
run_case "under-target intake is no longer a hold" server/adaptive-targets.ts \
  'if (inp.baseCalories > 0 && inp.avgKcal7d < inp.baseCalories * 0.90)' \
  'if (false)' || failed=$((failed + 1))
run_case "hold and change are no longer distinguished in the audit" server/scheduler/jobs/adaptive.ts \
  'state: isHold ? "HOLD" : "CHANGE",' \
  'state: "CHANGE",' || failed=$((failed + 1))
run_case "the adaptive job forgets the prior visible target" server/scheduler/jobs/adaptive.ts \
  'const priorTargets = { ...s.current };' \
  'const priorTargets = { calories: 0, protein: 0, steps: 0 };' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-c18-adaptive-review: FAILED — $failed seam(s) unguarded"
  exit 1
fi
echo "red-on-revert-c18-adaptive-review: GREEN — 3/3 behavioral reverts caught"

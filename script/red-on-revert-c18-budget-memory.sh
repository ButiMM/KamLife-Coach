#!/usr/bin/env bash
# C18: each source-read/decision seam must be necessary for the delivered budget move.
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-c18-budget-memory-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c18-budget-revert.XXXXXX")"
FILES=(server/one-action.ts server/handlers/one-action-command.ts server/understanding/live.ts)
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
  if [[ $patched -ne 0 ]]; then echo "  FAIL  $name — revert seam not found in $file"; return 1; fi
  if ! revert_db_reset; then echo "  FAIL  $name — database reset failed"; return 1; fi
  out="$(npx tsx "$ACC" 2>&1)"
  verdict="$(printf '%s\n' "$out" | grep '^pg-c18-budget-memory-acceptance:' | tail -1 || true)"
  if [[ "$verdict" =~ FAILED ]] && printf '%s\n' "$out" | grep -q '^  FAIL'; then
    echo "  PASS  $name → $verdict"
    printf '%s\n' "$out" | grep '^  FAIL' | head -1 | sed 's/^/        /'
    return 0
  fi
  echo "  FAIL  $name — acceptance did not turn red (verdict: ${verdict:-missing})"
  return 1
}

if ! revert_db_reset; then echo "CONTROL: database reset failed"; exit 1; fi
control="$(npx tsx "$ACC" 2>&1)"
if ! printf '%s\n' "$control" | grep -q '^pg-c18-budget-memory-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-c18-budget-memory-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched C18 budget acceptance is GREEN"

failed=0
run_case "the one-action reader forgets the saved budget" server/handlers/one-action-command.ts \
  '      weeklyFoodBudget: user?.weeklyFoodBudget,' \
  '      weeklyFoodBudget: null,' || failed=$((failed + 1))
run_case "the decision ignores the saved budget" server/one-action.ts \
  '  const budgetConstrained = s.weeklyFoodBudget === "under_100";' \
  '  const budgetConstrained = false;' || failed=$((failed + 1))
run_case "the live canonical close forgets the budget" server/understanding/live.ts \
  '      weeklyFoodBudget: user.weeklyFoodBudget,' \
  '      weeklyFoodBudget: null,' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-c18-budget-memory: FAILED — $failed seam(s) unguarded"
  exit 1
fi
echo "red-on-revert-c18-budget-memory: GREEN — 3/3 behavioral reverts caught"

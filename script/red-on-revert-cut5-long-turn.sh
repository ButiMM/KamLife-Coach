#!/usr/bin/env bash
# RED-ON-REVERT — Cut 5, one long voice note becomes one complete coaching turn.
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-long-voice-tail-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cut5-revert.XXXXXX")"
FILES=(server/routes.ts server/backfill.ts server/handlers/gpt-block.ts)

for f in "${FILES[@]}"; do cp "$f" "$WORK_ROOT/$(printf '%s' "$f" | tr '/' '_')"; done
restore_case () {
  for f in "${FILES[@]}"; do cp "$WORK_ROOT/$(printf '%s' "$f" | tr '/' '_')" "$f"; done
}
cleanup () {
  restore_case
  for f in "$WORK_ROOT"/*; do rm -f "$f"; done
  rmdir "$WORK_ROOT"
}
trap cleanup EXIT INT TERM

run_case () {
  local name="$1" file="$2" before="$3" after="$4" out verdict
  restore_case
  python3 - "$file" "$before" "$after" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); before = sys.argv[2]; after = sys.argv[3]
s = p.read_text(encoding="utf-8")
assert before in s, f"revert seam not found in {p}"
p.write_text(s.replace(before, after, 1), encoding="utf-8")
PY
  if ! revert_db_reset; then echo "  FAIL  $name — database reset failed"; return 1; fi
  out="$(npx tsx "$ACC" 2>&1)"
  verdict="$(printf '%s\n' "$out" | grep '^pg-long-voice-tail-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-long-voice-tail-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-long-voice-tail-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched long-turn acceptance is GREEN"

failed=0
run_case "meal clauses stop reaching the food owner" server/routes.ts \
  'const foodMessage = foodClauses.length > 0 ? foodClauses.join(" ") : message;' \
  'const foodMessage = message;' || failed=$((failed + 1))
run_case "workout correction stops replacing the earlier belief" server/backfill.ts \
  'if (workoutMove) {' 'if (false && workoutMove) {' || failed=$((failed + 1))
run_case "single-question renderer reclaims the complete turn" server/routes.ts \
  'const miscResult = multiQuestionTurn ? null' 'const miscResult = false ? null' || failed=$((failed + 1))
run_case "Coach context no longer answers both questions" server/handlers/gpt-block.ts \
  'if (isMultiPartAsk(message)) {' 'if (false) {' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-cut5-long-turn: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-cut5-long-turn: GREEN — 4/4 behavioral reverts caught"

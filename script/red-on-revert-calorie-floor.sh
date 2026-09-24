#!/usr/bin/env bash
# RED-ON-REVERT — #268, one calorie floor and no writer below it.
#
# Each case restores ONE mechanism to its pre-fix state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-calorie-floor-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/calorie-floor-revert.XXXXXX")"
FILES=(
  server/handlers/weight.ts
  server/scheduler/jobs/monday.ts
)

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
  local name="$1" file="$2" before="$3" after="$4" out verdict patched
  restore_case
  python3 - "$file" "$before" "$after" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); before = sys.argv[2]; after = sys.argv[3]
s = p.read_text(encoding="utf-8")
if before not in s:
    sys.exit(3)
p.write_text(s.replace(before, after, 1), encoding="utf-8")
PY
  patched=$?
  if [[ $patched -ne 0 ]]; then
    echo "  FAIL  $name — revert seam not found in $file; this harness is stale, the product is not"
    return 1
  fi
  if ! revert_db_reset; then echo "  FAIL  $name — database reset failed"; return 1; fi
  out="$(npx tsx "$ACC" 2>&1)"
  verdict="$(printf '%s\n' "$out" | grep '^pg-calorie-floor-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-calorie-floor-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-calorie-floor-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched calorie-floor acceptance is GREEN"

failed=0

# 1. THE WEIGH-IN AUTO-ADJUST CLAMPS AT A SEX-BLIND 1200 AGAIN.
run_case "the weigh-in auto-adjust clamps at 1200" server/handlers/weight.ts \
  'finalCals = Math.max(calorieFloor(user), Math.min(4000, newCals + calAdjust));' \
  'finalCals = Math.max(1200, Math.min(4000, newCals + calAdjust));' || failed=$((failed + 1))

# 2. THE DIET-BREAK RESTORE WRITES BACK AN UNDER-FLOOR NUMBER.
run_case "the diet-break restore ignores the floor" server/scheduler/jobs/monday.ts \
  'const restored = Math.max(calorieFloor(client), client.dietBreakCalTarget!);' \
  'const restored = client.dietBreakCalTarget!;' || failed=$((failed + 1))

# NOT CASES HERE: calculateTargets, the adaptive overlay and the three-week re-evaluation are pure
# or job-internal and are guarded in script/unit-tests.ts ("calorie floor: …"), which fails on a
# literal floor in any writer and on a man cut under 1500 by the overlay.

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-calorie-floor: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-calorie-floor: GREEN — 2/2 behavioral reverts caught"

#!/usr/bin/env bash
# RED-ON-REVERT — C11, one food evidence, one nutritional truth.
#
# Each case restores ONE mechanism to its pre-C11 state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-food-calorie-truth-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c11-revert.XXXXXX")"
FILES=(
  server/food-identity-correction.ts
  server/utils.ts
  server/handlers/food-log-mgmt.ts
  server/day-ledger-core.ts
  server/meal-select.ts
  server/handlers/misc-commands.ts
  server/serving-units.ts
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
  verdict="$(printf '%s\n' "$out" | grep '^pg-food-calorie-truth-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-food-calorie-truth-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-food-calorie-truth-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched food-calorie-truth acceptance is GREEN"

failed=0

# 1. WORD-NUMBER CORRECTION ESCAPES TO THE IDENTITY OWNER. parseQuantityCorrection stops
#    normalising word numbers, so "two breasts not one" falls through to the identity path exactly
#    as it did before — where "one" is taken as a food to remove.
run_case "word-number correction escapes the quantity owner" server/utils.ts \
  '  const norm = normaliseWordNumbers(m);' \
  '  const norm = m.replace(/\bhalf\s+(?:a|an|the)\s+/gi, "0.5 ");' || failed=$((failed + 1))

# 2. DIGIT IDENTITY-GRAMMAR CORRECTION ESCAPES THE QUANTITY OWNER. The "wasn't N X, it was M X"
#    frame is removed, so that phrasing goes back to the identity path — which removes the food and
#    adds nothing, leaving kcal_int standing over an empty items array.
run_case "identity-grammar quantity correction escapes the quantity owner" server/utils.ts \
  '\b(?:wasn'"'"'?t|was\s+not|not)\s+(\d+(?:\.\d+)?)\s*[a-z ]{0,24}?' \
  '\bnot\s+(\d+(?:\.\d+)?)\s*[a-z ]{0,12}?' || failed=$((failed + 1))

# 3. THE QUANTITY AUTHORITY IS BYPASSED. resolveFood goes back to reading typicalPortionCalories
#    straight off the scanner hit.
#
#    STILL REACHABLE AFTER THE ROUTING CONSOLIDATION, and verified rather than assumed: bare
#    quantity claims now go to parseQuantityCorrection, but resolveFood still prices every
#    corrected-TO food, and that food can carry a quantity of its own — "it wasn't rice, it was two
#    chicken breasts" is an IDENTITY correction whose replacement is two portions. Measured on the
#    repaired head: 594 kcal, quantity 2. Bypassing the authority makes it 297. So this mutation is
#    aimed at the live seam, not a manufactured one.
run_case "the correction path bypasses the portion authority" server/handlers/food-log-mgmt.ts \
  '        const [priced] = adjustFoodsForSegment([hit], food);' \
  '        const priced: any = null;' || failed=$((failed + 1))

# 4. AN UNRESOLVABLE REMOVAL MAY APPEND AGAIN. The guard stands down, so a correction naming a food
#    that is not on the plate writes its addition alone — the 877 defect's exact mechanism.
run_case "an unresolvable removal appends its replacement" server/handlers/food-log-mgmt.ts \
  '      if (unresolved.length > 0 && !plan.moves) {' \
  '      if (false) {' || failed=$((failed + 1))

# 5. CANONICAL PROVENANCE IS DROPPED AT PERSISTENCE. The item keeps its calories and loses every
#    field explaining them.
run_case "provenance is dropped when the item is persisted" server/day-ledger-core.ts \
  '      quantity,
      unit: f.statedUnit ?? null,' \
  '      unit: f.statedUnit ?? null,' || failed=$((failed + 1))

# 6. THE EXPLICIT REPEAT TARGET IS DISCARDED. "Same as lunch for dinner" goes back to a null target,
#    so the copy lands with no slot.
run_case "an explicitly named repeat target is discarded" server/meal-select.ts \
  '    : sameAsMealM ? (namedTarget && namedTarget !== sourceNamed ? namedTarget : null)' \
  '    : sameAsMealM ? null' || failed=$((failed + 1))

# 7. A ZERO-CALORIE ROW IS UNLOGGED AGAIN. The progress card asks the day's TOTAL whether the client
#    logged, so a zero-calorie day reads as empty over food we are holding.
run_case "a zero-calorie day is treated as unlogged" server/handlers/misc-commands.ts \
  '      const loggedToday = (truth.today.meals?.length || 0) > 0;' \
  '      const loggedToday = truth.today.kcal > 0;' || failed=$((failed + 1))

# 8. THE PHOTO TOTAL DEFEATS THE ITEM SUMS, and its zero-calorie items disappear with it. One
#    mutation covers both because one line does both: filtering to priced items before deciding is
#    exactly how the model's own total came to stand over a list that no longer summed to it.
run_case "the photo total defeats item sums and free items vanish" server/serving-units.ts \
  '  if (items.length > 0) {
    const kcal = items.reduce((s, i) => s + (i.kcal || 0), 0);
    const protein = items.reduce((s, i) => s + (i.protein || 0), 0);' \
  '  const priced = items.filter(i => (i.kcal || 0) > 0);
  if (priced.length > 0) {
    const kcal = statedKcal;
    const protein = statedProtein;' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-c11-food-calorie-truth: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-c11-food-calorie-truth: GREEN — 8/8 behavioral reverts caught"

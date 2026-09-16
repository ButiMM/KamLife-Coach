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
  server/portion-memory.ts
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

# 8. THE PHOTO TOTAL DEFEATS THE ITEM SUMS. The meal stores the model's figure while its items
#    say something else — a row that contradicts its own evidence.
#
#    SPLIT FROM CASE 8b BECAUSE ONE MUTATION WAS NOT TWO (C11 review). The first version of this
#    case bolted a `priced` filter onto the same patch, but the function returns `items`, not
#    `priced` — so the filter was dead and only the total-vs-sum claim ever went red. The
#    zero-calorie deletion was UNGUARDED while appearing to be guarded, which is worse than an
#    absent case. Found by review; each claim now has a mutation that actually causes it.
run_case "the photo total defeats item sums" server/serving-units.ts \
  '    const kcal = items.reduce((s, i) => s + (i.kcal || 0), 0);
    const protein = items.reduce((s, i) => s + (i.protein || 0), 0);' \
  '    const kcal = statedKcal;
    const protein = statedProtein;' || failed=$((failed + 1))

# 8b. A PARSED ZERO-CALORIE PHOTO ITEM IS DELETED. The filter goes in at the parse boundary, where
#     it genuinely removes the item from everything downstream: the eggs survive, the black coffee
#     does not, and the meal total stays 140 — so the ledger contract still holds and nothing
#     downstream complains. That silence is the defect's whole character.
run_case "a parsed zero-calorie photo item is deleted" server/serving-units.ts \
  '  const { items, unread } = parseVisionLines(text);' \
  '  const { items: parsedAll, unread } = parseVisionLines(text);
  const items = parsedAll.filter(i => (i.kcal || 0) > 0);' || failed=$((failed + 1))

# ── THE FIVE REVIEW FINDINGS ────────────────────────────────────────────────────────────────
# Cases 9–13 guard the repairs made after review of 66a4443. Two of those defects were this cut's
# own, which is precisely why they need seams: a repair that introduces a defect is not caught by
# the tests written for the defect it was repairing.

# 9. A WEIGHT IS A SERVING COUNT AGAIN. The mass/volume conversion stands down, so "200 grams of
#    chicken breast" goes back to dividing 200 by the portion's serving count — the branch that
#    logged 22,000 kcal for 100g of rice.
run_case "a stated weight is counted as servings" server/portion-memory.ts \
  '        const massGrams = statedUnit ? MASS_UNIT_GRAMS[statedUnit] : undefined;' \
  '        const massGrams: number | undefined = undefined;' || failed=$((failed + 1))

# 10. UNREAD FOOD IS DELETED AGAIN. The shortfall reconciliation stands down, so a photo reply with
#     one line we can parse and one we cannot persists only the line we read.
run_case "a photo line we could not parse is silently dropped" server/serving-units.ts \
  '    if (unread > 0 && statedKcal > 0 && statedKcal - kcal > Math.max(25, kcal * 0.1)) {' \
  '    if (false) {' || failed=$((failed + 1))

# 11. A PHOTO ITEM STOPS SAYING WHERE IT CAME FROM. summariseProvenance then reads it as unknown,
#     and the confidence of every photo meal degrades.
run_case "a parsed photo item loses its origin" server/serving-units.ts \
  'category: "photo", origin: "photo" });' \
  'category: "photo" });' || failed=$((failed + 1))

# 12. A CORRECTED COUNT MOVES THE CALORIES AND LEAVES THE EVIDENCE BEHIND. The row again claims one
#     breast's quantity, grams and portion description over two breasts' calories.
run_case "a corrected count rescales calories but not provenance" server/handlers/food-log-mgmt.ts \
  '          const newItemsQC = itemsQC.map(i => i === itemQC ? rescaleLedgerItem(i, ratio) : i);' \
  '          const newItemsQC = itemsQC.map(i => i === itemQC ? { ...i, kcal: newItemKcal, protein: newItemProt } : i);' || failed=$((failed + 1))

# 13. ONE BASIS IS COPIED ACROSS THE WHOLE SEGMENT. "cooked rice and raw chicken thigh" records both
#     as cooked, and basisConflict can no longer see the raw chicken it exists to catch.
run_case "one food's preparation basis is copied onto every food" server/portion-memory.ts \
  '    const foodBasis = statedBasisFor(segText, allAliases) || soleBasis;' \
  '    const foodBasis = statedBasis(segText);' || failed=$((failed + 1))

# 14. A CORRECTION WE CANNOT PLACE GOES SILENT AGAIN. The reply stops naming what today holds, so
#     the named 877 sentence ends in "I don't see chicken breasts in today's log to correct" over a
#     plate the client logged one turn earlier, and the day never moves.
#
#     ANCHORED ON THE HELD-ROWS READ, not on a branch: the two dead-end replies were consolidated
#     into one mouth when the authorship governor refused the second, so the seam is the line that
#     reads what today holds. Emptying it leaves the same sentence naming nothing.
run_case "an unplaceable correction stops naming what is held" server/handlers/food-log-mgmt.ts \
  '      const heldQC = rowsQC.slice(0, 3)' \
  '      const heldQC = rowsQC.slice(0, 0)' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-c11-food-calorie-truth: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-c11-food-calorie-truth: GREEN — 15/15 behavioral reverts caught"

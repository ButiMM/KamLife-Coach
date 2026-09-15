#!/usr/bin/env bash
# RED-ON-REVERT — C9, the eating clause owns the date and the slot.
#
# Each case puts ONE mechanism back the way it was on 85d1b73 and requires the acceptance to turn
# red with a GRADED FAILED ASSERTION. A crash is not a detection and a stale seam is not a product
# regression: both are reported as harness failures, saying which, because a harness that cannot
# patch will otherwise announce that the product is unguarded (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-meal-date-slot-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c9-revert.XXXXXX")"
FILES=(server/sast.ts server/understanding/actions.ts)

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
  verdict="$(printf '%s\n' "$out" | grep '^pg-meal-date-slot-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-meal-date-slot-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-meal-date-slot-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched meal date/slot acceptance is GREEN"

failed=0

# 1. THE DATE. "tonight" back inside the past-night alternation — the literal state of 85d1b73.
#    This is the one that also turns section 2 red: with the pear on yesterday the day reads
#    empty, and the canonical action reverts to demanding the client log what they just sent.
run_case "tonight is read as last night again" server/sast.ts \
  'if (/\b(last night|yesterday.?night|previous night)\b/.test(text)) {' \
  'if (/\b(last night|tonight|yesterday.?night|previous night)\b/.test(text)) {' || failed=$((failed + 1))

# 2. THE SLOT. The matcher reads the whole bubble again, so a slot word in the question labels
#    food reported in another clause.
run_case "the slot is taken from the whole message again" server/understanding/actions.ts \
  'return slotNamedIn(reporting.length > 0 ? reporting.join("\n") : whole);' \
  'return slotNamedIn(whole);' || failed=$((failed + 1))

# 3. THE PREDICATE. Bare "have" admitted to the eating vocabulary, so a clause about a HABIT ("I
#    have rice for dinner every day") counts as a report of eating and can label today's pear.
#
#    THIS CASE WAS WRONG THE FIRST TIME, AND THE HARNESS SAID SO. It was written as "a question
#    about a future meal counts as a report" — and stayed GREEN, because "what should I have for
#    dinner?" is declined by the asking floor no matter what this vocabulary matches. The revert
#    was real; the claim was not. Re-aimed at the sentence where this line is the ONLY thing
#    standing, rather than deleted or relaxed, because the decision it guards is still a decision.
run_case "a habit counts as a report of eating" server/understanding/actions.ts \
  'const EATING_REPORT_RE = new RegExp(`\\b${ATE}\\b`, "i");' \
  'const EATING_REPORT_RE = new RegExp(`\\b(?:have|${ATE})\\b`, "i");' || failed=$((failed + 1))

# 4. CONTROL, THE OPPOSITE DEFECT. The whole-message fallback removed, so a message that reports
#    no eating yields no slot at all. Trading a wrong label for a missing one is not a fix: this
#    must be caught by section 5's captions, and if it is not, section 5 is decoration.
run_case "the caption fallback is dropped — a named meal goes missing" server/understanding/actions.ts \
  'return slotNamedIn(reporting.length > 0 ? reporting.join("\n") : whole);' \
  'return slotNamedIn(reporting.join("\n"));' || failed=$((failed + 1))

# 5. ONLY THE FIRST reporting clause is read. The narrowest of the five and the easiest to write
#    by accident — "I had eggs. I had rice for lunch." loses the lunch the client named.
run_case "only the first reporting clause is read" server/understanding/actions.ts \
  'return slotNamedIn(reporting.length > 0 ? reporting.join("\n") : whole);' \
  'return slotNamedIn(reporting.length > 0 ? reporting[0] : whole);' || failed=$((failed + 1))

# 6. CONTROL, THE FLOORS. reportedInSomeClause replaced by a raw regex test, so the asking and
#    intent floors stop applying to the clause filter. The composition is the whole reason this
#    change adds no second opinion about what a question is.
run_case "the asking and intent floors stop guarding the clause filter" server/understanding/actions.ts \
  'const reporting = clausesOf(whole).filter(c => reportedInSomeClause(c, cl => EATING_REPORT_RE.test(cl)));' \
  'const reporting = clausesOf(whole).filter(c => EATING_REPORT_RE.test(c));' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-c9-meal-date-slot: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-c9-meal-date-slot: GREEN — 6/6 behavioral reverts caught"

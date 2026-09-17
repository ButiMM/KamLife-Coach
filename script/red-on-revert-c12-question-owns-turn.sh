#!/usr/bin/env bash
# RED-ON-REVERT — C12, the question owns the turn.
#
# Each case restores ONE mechanism to its pre-C12 state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-question-owns-turn-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c12-revert.XXXXXX")"
FILES=(
  server/handlers/food-context.ts
  server/unlogged-notice.ts
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
  verdict="$(printf '%s\n' "$out" | grep '^pg-question-owns-turn-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-question-owns-turn-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-question-owns-turn-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched question-owns-turn acceptance is GREEN"

failed=0

# 1. THE FACT IS OWED ONLY IN MEAL WORDS AGAIN. factOwed goes back to asking journeyMustKeepFacts
#    alone, which asks parseMessyIntake, which needs a meal word — so "I had a pear." is no report,
#    the isQuestion veto stands, and the pear is dropped and then asked for back.
run_case "a food report without a meal word is deleted by the question" server/handlers/food-context.ts \
  '  const factOwed = journeyMustKeepFacts(message).food || (hasActualFood && !!reportedInSomeClause(message, c => explicitlyReportsFood(c) && !mentionsNotDone(c)));' \
  '  const factOwed = journeyMustKeepFacts(message).food;' || failed=$((failed + 1))

# 2. THE QUESTION'S OWN WORDS ARE PRICED AS FOOD AGAIN. spansClaimedByOtherFacts stops claiming
#    question clauses, so "What should I do today?" comes back as the unpriced foods "what" and
#    "should" — and because that clarify is a QUESTION, ownsNextAction reads the next action as
#    already claimed and withNextMove drops the coaching move the ladder had computed. One
#    mutation, both harms, which is why it is one mutation.
run_case "the question's own words are priced as unlogged food" server/unlogged-notice.ts \
  '    for (const part of clause.split(",")) if (looksLikeQuestion(part.trim())) claimed.push(part);' \
  '    // reverted: no question fragment claims its own words' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-c12-question-owns-turn: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-c12-question-owns-turn: GREEN — 2/2 behavioral reverts caught"

#!/usr/bin/env bash
# RED-ON-REVERT — C10, the repaired reply is the reply that ships.
#
# Each case restores ONE mechanism to its 85d1b73 state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection, and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-turn-reply-integrity-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c10-revert.XXXXXX")"
FILES=(server/handlers/chat-log.ts server/handlers/gpt-block.ts server/handlers/lifecycle.ts)

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
  verdict="$(printf '%s\n' "$out" | grep '^pg-turn-reply-integrity-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-turn-reply-integrity-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-turn-reply-integrity-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched turn-reply-integrity acceptance is GREEN"

failed=0

# 1. THE NAMED DEFECT, exactly as 85d1b73 had it: the ordinary exit hands back the original.
#    This is the line almost every turn leaves through, so it is the one that shipped the
#    unrepaired reply in production.
run_case "the ordinary exit returns the original reply again" server/handlers/chat-log.ts \
  'if (corrected === draft) return draft;' \
  'if (corrected === draft) return reply;' || failed=$((failed + 1))

# 2. NOT GRADED, AND THE REASON IS RECORDED RATHER THAN THE CASE QUIETLY DROPPED.
#
#    The same `return reply` was fixed at the not-meaningful exit, the no-user exit and the catch.
#    A revert case was written for the not-meaningful exit and it stayed GREEN. That was measured,
#    not assumed: a turn is "not meaningful" only when it carries no "?", none of the domain words,
#    and is 18 characters or less — and on every such message tried ("hmm ok then", "eish",
#    "cool cool") the composed decision turn replaces the model's text before this exit is reached,
#    so no repair is observable there to lose. The no-user exit needs a user row that has vanished
#    mid-turn, and the catch needs the ledger reads to throw; neither is a client state.
#
#    So those three lines are corrected for consistency — same variable, same bug — and are NOT
#    claimed as guarded. An unfailable revert case is worse than an absent one: it reports a
#    mechanism as protected when nothing would notice if it broke.

# 3. The repair is computed but not held, so the decision rebuild composes over it. This is the
#    second half of the defect — the half that only became visible once the draft actually
#    shipped — and it must be caught independently of case 1.
run_case "the write-integrity repair is not held for the rebuild" server/handlers/chat-log.ts \
  '      integrityRepair = draft;' \
  '' || failed=$((failed + 1))

# 4. The second mouth is let loose again: the rebuild recomposes every decision turn from the
#    generic frame, so a question turn loses its answer and a numbers:low delivery strip is undone.
run_case "the rebuild recomposes a turn that already composed itself" server/handlers/chat-log.ts \
  'if (decisionTurn && (!scope.evidence.decisionComposed || integrityRepair)) {' \
  'if (decisionTurn) {' || failed=$((failed + 1))

# 5. CONTROL, THE OTHER OWNER. The under-eating warning swallows the turn again, so the client's
#    question is never answered at all. C9's corrected date is what makes this branch reachable;
#    without this gate the flagship journey is red no matter how good the reply owner is.
run_case "the under-eating warning swallows the question again" server/handlers/lifecycle.ts \
  '    !looksLikeQuestion(message) &&' \
  '' || failed=$((failed + 1))

# 6. The composed-turn flag is never set, which is case 4 reached from the other side: the
#    reconciler behaves correctly and the handler simply stops telling it the turn is done.
run_case "the composing exit stops declaring itself" server/handlers/gpt-block.ts \
  '        turnEvidence({ decisionComposed: true });
        gptReply = composeDecisionTurn(
          context,' \
  '        gptReply = composeDecisionTurn(
          context,' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-c10-turn-reply-integrity: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-c10-turn-reply-integrity: GREEN — 5/5 behavioral reverts caught"

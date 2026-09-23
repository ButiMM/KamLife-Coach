#!/usr/bin/env bash
# RED-ON-REVERT — #264, a meal decline must not delete logged food.
#
# Each case restores ONE mechanism to its pre-fix state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-meal-decline-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/meal-decline-revert.XXXXXX")"
FILES=(
  server/handlers/food-context.ts
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
  verdict="$(printf '%s\n' "$out" | grep '^pg-meal-decline-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-meal-decline-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-meal-decline-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched meal-decline acceptance is GREEN"

failed=0

# 1. A TRIGGER WORD MAKES A CORRECTION AGAIN — "No … meal" / "No … had" qualifies without naming
#    anything to replace the entry with (AUDIT.md Trace 1's exact mechanism).
run_case "a decline with a food trigger word is treated as a correction" server/handlers/food-context.ts \
  '  const isFoodCorrection = hasFoodAfterPrefix || claimsOtherFood || !!slotOnly;' \
  '  const isFoodCorrection = hasFoodAfterPrefix || claimsOtherFood || !!slotOnly || (hasCorrectionPrefix && /\b(had|meal)\b/i.test(m));' || failed=$((failed + 1))

# 2. A SLOT WORD ANYWHERE IS A RELABEL — "No, lunch was fine as it is" moves the meal.
run_case "a slot named as a verdict relabels the meal" server/handlers/food-context.ts \
  '.trim().match(/^(breakfast|lunch|dinner|supper|snack)$/i)' \
  '.trim().match(/\b(breakfast|lunch|dinner|supper|snack)\b/i)' || failed=$((failed + 1))

# 3. A CORRECTION REPLACES THE MEAL AND SAYS NOTHING — the pre-fix deletion, invisible to the ledger.
run_case "a superseded meal is not recorded" server/handlers/food-context.ts \
  '            turnMutation(`SUPERSEDE meal' \
  '            void (`SUPERSEDE meal' || failed=$((failed + 1))

# 4. A CORRECTION THAT LOGS NOTHING LOSES THE MEAL — the snapshot is never put back.
run_case "a correction that logs no replacement deletes the original" server/handlers/food-context.ts \
  '              await tx.insert(mealLogs).values(target);' \
  '              void target;' || failed=$((failed + 1))

# 5. THE RESTORED MEAL IS NOT COUNTED — the cached day total stays at the deleted figure.
run_case "a restored meal is left out of the cached day total" server/handlers/food-context.ts \
  '            }).then(recount).then(() => true' \
  '            }).then(() => true' || failed=$((failed + 1))

# 6. A RELABEL CHANGES THE MEAL AND RECORDS NOTHING.
run_case "a relabel is not recorded" server/handlers/food-context.ts \
  '        turnMutation(`RELABEL meal' \
  '        void (`RELABEL meal' || failed=$((failed + 1))

# 7. "NO THANKS" CORRECTS AGAIN (Codex attack @ 7f93588) — a decline that names a new food, such
#    as a later plan, deletes the lunch and re-enters as a log.
run_case "\"No thanks\" is read as a correction prefix" server/handlers/food-context.ts \
  'const hasCorrectionPrefix = (!/^(?:no|nope|nah)[,!\s]*(?:thanks|thank\s+you|ta)\b/i.test(m) ||' \
  'const hasCorrectionPrefix = (true ||' || failed=$((failed + 1))

# 8. NAMING THE MEAL ON RECORD CORRECTS IT (Codex attack @ 7f93588) — "No, the pap and chicken
#    were lekker" supersedes the unchanged lunch with itself.
run_case "a decline repeating the logged food supersedes it" server/handlers/food-context.ts \
  '      if (!repeatsRecord && correctedMsgCandidate' \
  '      if (correctedMsgCandidate' || failed=$((failed + 1))

# 9. A CORRECTION TO AN UNFAMILIAR FOOD APPENDS (Codex attack @ 238bd21) — "No, I had injera
#    instead" logs injera beside the pap it replaced.
run_case "a correction naming a food the scanner does not know appends" server/handlers/food-context.ts \
  '  const isFoodCorrection = hasFoodAfterPrefix || claimsOtherFood || !!slotOnly;' \
  '  const isFoodCorrection = hasFoodAfterPrefix || !!slotOnly;' || failed=$((failed + 1))

# 10. STRIKING A FOOD OUT IS READ AS A REPEAT (Codex review @ 238bd21) — "No, I had chicken
#     breast, not rice" adds a second meal beside the rice one.
# (Case 10's own seam, `!negatesHeld`, is gone: the names-all-of-it rule of case 13 already treats
# "chicken breast, not rice" as a correction, so the strike-out check could no longer turn anything
# red and was deleted rather than kept as unobservable code.)

# 11. AN IN-PLACE AMEND IS NOT A LANDING (Codex review @ 7f93588) — the wrong meal is restored on
#     top of the amended one.
run_case "a replacement written as an amend is not seen as landed" server/handlers/food-context.ts \
  '.filter(([id, sig]) => id !== target.id && heldSigs.get(id) !== sig)' \
  '.filter(([id]) => id !== target.id && !heldSigs.has(id))' || failed=$((failed + 1))

# NOT A CASE EITHER: RESTORE is recorded only after the restore commits (Codex review @ 7f93588).
# Observing it needs an injected database failure mid-turn, which this harness does not do.

# NOT A CASE, DELIBERATELY: the invalidateFoodTotalsCache() before the recount. Removing it was
# tried and the acceptance stayed green — the re-entered turn re-derives the day from the ledger, so
# the stale figure only exists in the window while that turn runs. A seam that cannot turn red is
# not claimed as guarded.

# 12. COURTESY HIDES AN EXPLICIT CORRECTION (Codex attack @ 8e15426) — "No thanks, actually I had a
#     burger, not pap." appends the burger beside the pap it replaces.
run_case "\"No thanks\" excludes an explicit correction" server/handlers/food-context.ts \
  '|| /\b(?:actually|instead|i\s+meant|wrong)\b/i.test(m) || (/\b(?:had|ate|eaten)\b/i.test(m) && [...m.matchAll(/\bnot\s+(?:the\s+|my\s+|a\s+)?([a-z][a-z'"'"'-]+)/gi)].some(x => scanForSAFoods(x[1]).length > 0))) &&' \
  ') &&' || failed=$((failed + 1))

# 13. PART OF THE PLATE IS A REPEAT OF THE RECORD (Codex @ 8e15426) — "No, I had rice and chicken
#     breast" leaves the avocado on the day.
run_case "a correction naming part of the plate is a repeat" server/handlers/food-context.ts \
  ' && ((r => r.length ? r : [...heldNames])(scanForSAFoods(String(target.rawMessage || "")).map(f => f.name.toLowerCase()))).every(n => namedNow.includes(n)) && amounts(' \
  ' && amounts(' || failed=$((failed + 1))

# 14. A NEW AMOUNT IS A REPEAT (Codex @ a514b3a) — "No, I had 3 eggs" after 2 eggs keeps 2 eggs.
run_case "a correction that changes only the amount is a repeat" server/handlers/food-context.ts \
  ' && amounts(candidateSansNot) === amounts(String(target.rawMessage || ""));' \
  ';' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-meal-decline: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-meal-decline: GREEN — 13/13 behavioral reverts caught"

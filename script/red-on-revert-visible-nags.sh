#!/usr/bin/env bash
# RED-ON-REVERT — #275, the nags and invented facts testers saw every day.
#
# Each case restores ONE mechanism to its pre-fix state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-visible-nags-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/visible-nags-revert.XXXXXX")"
FILES=(
  server/one-action.ts
  server/scheduler/shared.ts
  server/scheduler/proactive-decision.ts
  server/food-swaps.ts
  server/handlers/food-context.ts
  server/handlers/conversion.ts
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
  verdict="$(printf '%s\n' "$out" | grep '^pg-visible-nags-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-visible-nags-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-visible-nags-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched visible-nags acceptance is GREEN"

failed=0

# 1. A PRESENT CLIENT IS ASKED TO LOG AGAIN — the evidence gate's food ask ignores presence.
run_case "a client at the keyboard is downgraded to \"tell me what you ate\"" server/one-action.ts \
  'const canAskForFood = !ctx.foodSufficient && !ctx.loggedToday && !ctx.present;' \
  'const canAskForFood = !ctx.foodSufficient && !ctx.loggedToday;' || failed=$((failed + 1))

# 2. THE PROACTIVE SIDE CANNOT SEE TODAY'S MESSAGE — the evening brief asks a present client to log.
run_case "a client who wrote today is not read as present" server/scheduler/shared.ts \
  '    presentToday: asks.presentToday,' \
  '    presentToday: false,' || failed=$((failed + 1))

# 3. THE COME-BACK RUNG IGNORES PRESENCE — "Log one meal today" to someone who wrote this morning.
run_case "the come-back rung fires for a client who wrote today" server/one-action.ts \
  'if (s.daysSinceAnyLog !== null && s.daysSinceAnyLog >= 3 && !s.atKeyboard && !s.presentToday) {' \
  'if (s.daysSinceAnyLog !== null && s.daysSinceAnyLog >= 3 && !s.atKeyboard) {' || failed=$((failed + 1))

# 4. AN ABSENCE NOBODY MEASURED — no meal row becomes their tenure.
run_case "an unknown gap becomes the client's tenure" server/one-action.ts \
  '    daysSinceAnyLog: s.food.daysSinceAnyLog,' \
  '    daysSinceAnyLog: s.food.daysSinceAnyLog ?? p.weeksOnProgramme * 7,' || failed=$((failed + 1))

# 5. THE DAILY WEIGH-IN — the rung does not read when it last asked.
run_case "the weigh-in ask repeats the next morning" server/one-action.ts \
  '&& !(s.asksAboutToday && weighWouldBeTomorrow) && !weighAskedRecently(s.daysSinceWeighAsk)' \
  '&& !(s.asksAboutToday && weighWouldBeTomorrow)' || failed=$((failed + 1))

# 6. …AND NOTHING RECORDS THAT IT WENT OUT.
run_case "a delivered weigh-in ask is not recorded" server/scheduler/proactive-decision.ts \
  '  if (move.action.kind === "weigh") return recordWeighAsk(client.id);' \
  '' || failed=$((failed + 1))

# 7. "JUST FINISHED DINNER" IS THE SHOP BEING OUT OF STOCK AGAIN.
run_case "a bare \"finished\" reads as the shop being out" server/food-swaps.ts \
  '|(?:was|were|is|are|all|got)\s+finished|' \
  '|finished|' || failed=$((failed + 1))

# 8. …AND THE FOOD LOGGER DOES NOT HEAR "FINISHED DINNER" AS EATING.
run_case "\"finished dinner\" is not a past-eating claim" server/handlers/food-context.ts \
  '|finished (?:my |the )?(?:breakfast|lunch|dinner|supper|brunch|meal|eating)|' \
  '|' || failed=$((failed + 1))

# 9. THE PRICE WE CANNOT STAND BEHIND IS QUOTED AGAIN.
run_case "the price answer quotes a personal trainer at R250+" server/handlers/conversion.ts \
  'All on WhatsApp — no app to download.\n\nReady to start?' \
  'All on WhatsApp — no app to download.\n\nA personal trainer charges R250+ for *one* session.\n\nReady to start?' || failed=$((failed + 1))

# NOT A CASE: the trial grant, countdown job, expired-trial nudges and greeting line are DELETED,
# not guarded — there is no seam to restore. script/unit-tests.ts "no path grants, counts down or
# chases a free trial" and tracking-contract §3/§5 fail if any of them comes back.
# NOT A CASE: the reactive weigh-in record in live.ts and one-action-command.ts. §3 grades the
# proactive owner; the reactive record is the same helper, and no reactive case here asks to weigh.

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-visible-nags: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-visible-nags: GREEN — 9/9 behavioral reverts caught"

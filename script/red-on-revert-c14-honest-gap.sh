#!/usr/bin/env bash
# RED-ON-REVERT — C14, the honest gap and the honest ask.
#
# Each case restores ONE mechanism to its 0deb7f8 state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection, and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
#
# server/understanding/live.ts IS NOT LISTED HERE, ON PURPOSE. Its fabricated
# `foodRowToday ? 0 : (truth.window.daysLogged > 0 ? 1 : 7)` is repaired in this cut, but rung 1
# of chooseAction is the field's only consumer and it is gated on `!atKeyboard`, which live.ts
# hardcodes true. Reverting that line therefore moves no body on this base, and a case that cannot
# turn red is not a detection — claiming it as one would be the vacuous assertion this programme
# already blocked a cut over. §7 of the acceptance grades the contract that field feeds instead.
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-honest-gap-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c14-revert.XXXXXX")"
FILES=(
  server/one-action.ts
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
  verdict="$(printf '%s\n' "$out" | grep '^pg-honest-gap-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-honest-gap-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-honest-gap-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched honest-gap acceptance is GREEN"

failed=0

# 1. THE SENTINEL COMES BACK. "We hold no meal row for this client" becomes a ninety-nine day
#    absence again, so a client five days old, at the keyboard, is told it has been fourteen weeks
#    and that their numbers are exactly where they left them.
run_case "never logged is read as ninety-nine days gone" server/one-action.ts \
  '    daysSinceAnyLog: s.food.daysSinceAnyLog ?? p.weeksOnProgramme * 7,' \
  '    daysSinceAnyLog: s.food.daysSinceAnyLog ?? 99,' || failed=$((failed + 1))

# 2. THE THEATRE LINE COMES BACK. The ask carries a reason again, and the reason is a complaint
#    about the coach's own visibility rather than anything the client can act on.
run_case "the log ask complains instead of asking" server/one-action.ts \
  '    why: "",
    investigation: { missingFact: "food_today", whyItMatters: "Today'"'"'s food is absent." },' \
  '    why: "I can'"'"'t coach a day I can'"'"'t see.",
    investigation: { missingFact: "food_today", whyItMatters: "Today'"'"'s food is absent." },' || failed=$((failed + 1))

# 3. THE ONE-THING RENDERER STOPS CHECKING. An action with no reason renders the italic wrapper
#    around nothing, so the client gets the ask followed by a bare `__`.
run_case "the one-thing body renders empty italics" server/one-action.ts \
  '  return `${fn ? fn + " — o" : "O"}ne thing today:\n\n*${a.todo}*${a.why ? `\n\n_${a.why}_` : ""}`;' \
  '  return `${fn ? fn + " — o" : "O"}ne thing today:\n\n*${a.todo}*\n\n_${a.why}_`;' || failed=$((failed + 1))

# 4. THE SAME, ON THE PROACTIVE BRIEF. decideProactive builds its own `line`, and that is what the
#    evening, weekly and pattern jobs put on the wire. It reaches the same askToLog through the
#    evidence downgrade, so an unguarded reason slot ships a bare `__` on a surface no reactive
#    case touches.
run_case "the proactive brief line renders empty italics" server/one-action.ts \
  '    line: action.kind === "hold" ? "" : `*${action.todo}*${action.why ? `\n\n_${action.why}_` : ""}`,' \
  '    line: action.kind === "hold" ? "" : `*${action.todo}*\n\n_${action.why}_`,' || failed=$((failed + 1))

# 5. THE ABSENCE RUNG STOPS READING THE FOOD CLOSURE. A client one to three weeks quiet who has
#    just said they are eating nothing else today is told "Log one meal today. Any meal." — the
#    branch the 99 sentinel used to keep every never-logged client out of.
run_case "the absence rung sells a meal to a closed day" server/one-action.ts \
  '      const alreadyEaten = struggle === "time" || !!s.foodDayClosed;' \
  '      const alreadyEaten = struggle === "time";' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-c14-honest-gap: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-c14-honest-gap: GREEN — 5/5 behavioral reverts caught"

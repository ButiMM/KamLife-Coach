#!/usr/bin/env bash
# RED-ON-REVERT — the information-value acceptance is deterministic on every day of the week.
#
# THE DEFECT THIS GUARDS is not in the product. It is an acceptance that inherited the day CI
# happened to start on: green every weekday, red every weekend, for a build nobody had changed.
# Found on Saturday 12 September 2026 when it blocked PR #244, a cut that touches none of this code.
#
# Case 1 REPRODUCES that deterministically, on any day, by pinning the whole file to the Saturday
# it used to fail on. Case 2 breaks section E's own day-derived fixture — a bug this section had on
# its first run, which is the same defect one level in. Case 3 is the opposite-defect control: the
# suite must still be grading the PRODUCT, not the calendar.
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe
ACC=script/pg-information-value-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ivclock-revert.XXXXXX")"
BACKUP="$WORK_ROOT/backup"
PATCH_DIR="$WORK_ROOT/patches"

restore_case () {
  if [[ -d "$BACKUP/server" && -f "$BACKUP/acc.ts" ]]; then
    rm -rf server; mv "$BACKUP/server" server
    cp "$BACKUP/acc.ts" "$ACC"
  fi
  rm -rf "$BACKUP"
}
cleanup () { restore_case; rm -rf "$WORK_ROOT"; }
trap cleanup EXIT INT TERM

run_case () {
  local name="$1" patch="$2" out status verdict
  restore_case
  mkdir -p "$BACKUP"
  cp -a server "$BACKUP/server"
  cp "$ACC" "$BACKUP/acc.ts"
  if ! python3 "$patch"; then echo "  !! patch failed: $name"; restore_case; return 1; fi
  if ! revert_db_reset; then echo "  !! database reset failed: $name"; restore_case; return 1; fi
  out="$(npx tsx "$ACC" 2>&1)"; status=$?
  verdict="$(printf '%s\n' "$out" | grep -E '^pg-information-value-acceptance:' | tail -1 || true)"
  echo "── REVERT: $name"
  echo "   ${verdict:-'(no verdict — crashed)'}"
  printf '%s\n' "$out" | grep '^  FAIL' | sed 's/^/   /' | head -4 || true
  restore_case
  if [[ $status -eq 0 ]]; then echo "  !! acceptance stayed green: $name"; return 1; fi
  if [[ ! "$verdict" =~ ^pg-information-value-acceptance:\ RED ]]; then
    echo "  !! acceptance did not reach a graded red verdict: $name (exit $status)"; return 1
  fi
}

mkdir -p "$PATCH_DIR"

# THE UNMODIFIED CONTROL RUNS FIRST. Without it a harness can report every case "caught" while the
# acceptance was failing for a reason that has nothing to do with the mutation — a dead database, a
# bad import, a timeout. Detection only means something if the same command passes untouched.
if ! revert_db_reset; then echo "!! database reset failed before the control"; exit 1; fi
control_out="$(npx tsx "$ACC" 2>&1)"; control_status=$?
control_verdict="$(printf '%s\n' "$control_out" | grep -E '^pg-information-value-acceptance:' | tail -1 || true)"
if [[ $control_status -ne 0 || ! "$control_verdict" =~ GREEN ]]; then
  echo "!! CONTROL FAILED — the unmodified acceptance does not pass, so nothing below proves anything."
  echo "   ${control_verdict:-'(no verdict — crashed)'}"
  printf '%s\n' "$control_out" | grep '^  FAIL' | sed 's/^/   /' | head -5 || true
  exit 1
fi
echo "CONTROL: the unmodified acceptance is GREEN — detections below are real."


# 1. THE WHOLE FILE RUNS ON A SATURDAY — what an unpinned run did yesterday, reproduced on demand
#    rather than once a week. Sections A-D fail because the live turn's own meal lands on a weekend
#    day and supplies the evidence they exist to find missing.
cat > "$PATCH_DIR/1.py" <<'PYEOF'
p="script/pg-information-value-acceptance.ts"; s=open(p).read(); b=s
s=s.replace("let PINNED_AT = PINNED_WEDNESDAY;", "let PINNED_AT = PINNED_SATURDAY;")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 2. SECTION E REUSES THE WEDNESDAY OFFSETS. This is the bug section E had on its first run: the
#    fixture seeds a meal on the Saturday itself, so the weekend is not missing and the section
#    grades nothing. A day-dependent fixture inside the fix for day-dependent fixtures.
cat > "$PATCH_DIR/2.py" <<'PYEOF'
p="script/pg-information-value-acceptance.ts"; s=open(p).read(); b=s
s=s.replace("  await seedMeals(sat.id, satWeekdayOffsets);", "  await seedMeals(sat.id, weekdayOffsets);")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 3. OPPOSITE DEFECT — the INVESTIGATE owner stops selecting the weekend fact at all. Every check
#    about "the coach stops asking" is trivially satisfied by a coach that never asks, which is the
#    cheapest wrong way to make a day-sensitive suite deterministic.
cat > "$PATCH_DIR/3.py" <<'PYEOF'
import re
p="server/day-ledger-core.ts"; s=open(p).read(); b=s
m=re.search(r"export function weekendLoggedDays\([^)]*\)[^{]*\{", s)
assert m, "weekendLoggedDays not found"
s = s[:m.end()] + "\n  return 1;" + s[m.end():]
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

echo "RED-ON-REVERT — information-value clock. Every case below must report RED."
failed=0
for i in 1 2 3; do
  if ! run_case "$i" "$PATCH_DIR/$i.py"; then failed=$((failed + 1)); fi
done
if [[ $failed -ne 0 ]]; then
  echo "RED-ON-REVERT: FAILED — $failed case(s) were green, crashed, or would not patch."
  exit 1
fi
echo "RED-ON-REVERT: GREEN — 3/3 cases reached a graded red verdict."

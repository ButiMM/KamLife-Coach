#!/usr/bin/env bash
# RED-ON-REVERT — #267, under-18s cannot complete signup or keep being coached.
#
# Each case restores ONE mechanism to its pre-fix state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-age-gate-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/age-gate-revert.XXXXXX")"
FILES=(
  server/onboarding.ts
  server/routes.ts
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
  verdict="$(printf '%s\n' "$out" | grep '^pg-age-gate-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-age-gate-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-age-gate-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched age-gate acceptance is GREEN"

failed=0

# 1. THE AGE QUESTION LETS A 14-17-YEAR-OLD THROUGH — the pre-fix threshold.
run_case "the age question blocks only under-14s" server/onboarding.ts \
  '    if (age < 18) {
      await blockUnderage(phone);' \
  '    if (age < 14) {
      await blockUnderage(phone);' || failed=$((failed + 1))

# 2. NOTHING READS A STATED AGE MID-CONVERSATION — "I'm 16" is coached as an adult.
run_case "a stated age mid-conversation is ignored" server/routes.ts \
  'if (user.onboardingState !== "BLOCKED_UNDERAGE" && (statedMinorAge(message) !== null' \
  'if (user.onboardingState !== "BLOCKED_UNDERAGE" && (false' || failed=$((failed + 1))

# 3. A CLIENT ALREADY ONBOARDED AS A MINOR KEEPS BEING COACHED.
run_case "a stored age under 18 is ignored" server/routes.ts \
  '      || (ONBOARDING_DONE.includes(user.onboardingState) && Number(user.age) > 0 && Number(user.age) < 18))) {' \
  '      || false)) {' || failed=$((failed + 1))

# 4. THE MINOR'S AGE IS KEPT ON FILE.
run_case "a blocked minor's age is kept" server/onboarding.ts \
  'set({ onboardingState: "BLOCKED_UNDERAGE", age: null })' \
  'set({ onboardingState: "BLOCKED_UNDERAGE" })' || failed=$((failed + 1))

# 5. ANY NUMBER AFTER "I'M" IS AN AGE — "I'm 16 weeks pregnant" locks an adult out.
run_case "a number that is not an age blocks an adult" server/onboarding.ts \
  '|(?=\s*(?:[.,!?;)]|$|and\b|but\b|so\b|today\b)))|([5-9]' \
  '|)|([5-9]' || failed=$((failed + 1))

# 6. A PHONE KEYBOARD'S APOSTROPHE HIDES THE AGE — "I’m 17".
run_case "a typographic apostrophe hides a stated age" server/onboarding.ts \
  '.replace(/[‘’ʼ]/g, "'"'"'");' \
  ';' || failed=$((failed + 1))

# 7. THE TURN THAT STATES THE AGE CARRIES ON AS COACHING — blocked in the record, coached in the reply.
run_case "the turn that states the age is coached anyway" server/routes.ts \
  '    user.onboardingState = await blockUnderage(phone);' \
  '    await blockUnderage(phone); user.onboardingState = "COMPLETE";' || failed=$((failed + 1))

# 8. A CONTRADICTION CLOSES AN ADULT — "People say I'm 16, but I'm 30" (Codex @ 8a36f96).
run_case "an adult's stated age does not outrank a minor one" server/onboarding.ts \
  '  if (/\b(?:i'"'"'?m|i\s+am|my\s+age\s+is|i\s+(?:just\s+)?turned)\s+(?:actually\s+|really\s+)?(?:1[89]|[2-9]\d)\b' \
  '  if (false && /\b(?:i'"'"'?m|i\s+am|my\s+age\s+is|i\s+(?:just\s+)?turned)\s+(?:actually\s+|really\s+)?(?:1[89]|[2-9]\d)\b' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-age-gate: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-age-gate: GREEN — 8/8 behavioral reverts caught"

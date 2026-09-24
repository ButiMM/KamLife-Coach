#!/usr/bin/env bash
# RED-ON-REVERT — #340, the AI spend cap fails safe.
#
# Each case restores ONE mechanism to its pre-fix state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-spend-cap-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/spend-cap-revert.XXXXXX")"
FILES=(
  server/cost-tracking.ts
  server/understanding/live.ts
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

# run_case NAME FILE BEFORE AFTER [BEFORE AFTER ...] — every pair is one seam of the same mechanism.
run_case () {
  local name="$1" file="$2" out verdict patched
  shift 2
  restore_case
  python3 - "$file" "$@" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); pairs = sys.argv[2:]
s = p.read_text(encoding="utf-8")
for before, after in zip(pairs[0::2], pairs[1::2]):
    if before not in s:
        sys.exit(3)
    s = s.replace(before, after, 1)
p.write_text(s, encoding="utf-8")
PY
  patched=$?
  if [[ $patched -ne 0 ]]; then
    echo "  FAIL  $name — revert seam not found in $file; this harness is stale, the product is not"
    return 1
  fi
  if ! revert_db_reset; then echo "  FAIL  $name — database reset failed"; return 1; fi
  out="$(npx tsx "$ACC" 2>&1)"
  verdict="$(printf '%s\n' "$out" | grep '^pg-spend-cap-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-spend-cap-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-spend-cap-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched spend-cap acceptance is GREEN"

failed=0

# 1. THE ACCOUNT-WIDE CEILING IS NOT CHECKED — only the old per-client limits apply.
run_case "the daily ceiling is not a hard stop" server/cost-tracking.ts \
  '  if (!(await isUnderGlobalDailyCap())) return false;
  try {' \
  '  try {' || failed=$((failed + 1))

# 2. SPEND THAT CANNOT BE READ IS TREATED AS NO LIMIT — the pre-#340 fail-open, in all three readers
#    (account-wide, per-client call count, per-client monthly cost). Each alone still fails safe on
#    the others, so the mechanism is the three together.
run_case "an unreadable spend query fails open" server/cost-tracking.ts \
  '  } catch (e) {
    ok = false;' \
  '  } catch (e) {
    ok = true;' \
  '    return false; // fail SAFE (#340): the short degraded reply, never an unbounded model call' \
  '    return true;' \
  '    return false; // fail SAFE (#340): the short degraded reply, never an unbounded model call' \
  '    return true;' || failed=$((failed + 1))

# 3. THE ENGINE CHECKS NO CAP — it calls the model whatever the spend.
run_case "the meaning engine ignores the cap" server/understanding/live.ts \
  '  if (user?.id && !(await isUnderGPTCallLimit(user.id))) return null;' \
  '' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-spend-cap: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-spend-cap: GREEN — 3/3 behavioral reverts caught"

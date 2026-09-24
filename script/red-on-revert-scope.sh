#!/usr/bin/env bash
# RED-ON-REVERT — #321, the coach stays a coach: scope is enforced in code and fails closed.
#
# Each case restores ONE mechanism to its pre-fix state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-scope-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/scope-revert.XXXXXX")"
FILES=(
  server/understanding/domain-guard.ts
  server/medication-context.ts
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
  verdict="$(printf '%s\n' "$out" | grep '^pg-scope-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-scope-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-scope-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched scope acceptance is GREEN"

failed=0

# 1. THE GATE FAILS OPEN AGAIN — a verdict the classifier was never asked for answers the message.
# (Offline, the classifier returns no usable word, so this is the path the acceptance exercises. The
# thrown-error path fails closed the same way and is graded by its unit test, "scope: …error…".)
run_case "an unrecognised classifier verdict fails open to answering" server/understanding/domain-guard.ts \
  '    return { classification: "out-of-domain", reasoning: `classifier: ${word || "empty"}`' \
  '    return { classification: "in-domain", reasoning: `classifier: ${word || "empty"}`' || failed=$((failed + 1))

# 2. NO DETERMINISTIC OFF-DOMAIN ASKS — scope is left to the model and the prompt.
run_case "off-domain asks are left to the model" server/understanding/domain-guard.ts \
  '  if (killswitchOff()) return null;
  const t = (message' \
  '  if (true) return null;
  const t = (message' || failed=$((failed + 1))

# 3. A MEDICINE ASK IS ANSWERED — "what antibiotic should I take for a sore throat" is coached.
run_case "choosing a medicine is not an unsafe request" server/medication-context.ts \
  '    return { present: true, medicationClass: glp1 ? "glp1" : "other", unsafeRequest: true, reason: "choosing" };' \
  '    return { present: true, medicationClass: glp1 ? "glp1" : "other", unsafeRequest: false, reason: null };' || failed=$((failed + 1))

# 4. THE COMMANDS ANSWER BEFORE SCOPE IS CHECKED — the supplement command answers the antibiotic.
run_case "commands answer before scope is checked" server/routes.ts \
  'const miscResult = offScope ? await declineOutOfScope(' \
  'const miscResult = false ? await declineOutOfScope(' || failed=$((failed + 1))

# 5. THE GPT FALLBACK IS UNGATED — with the engine off, anything unrecognised is answered.
run_case "the gpt fallback is not gated" server/routes.ts \
  '  if (scope.redirectMessage) return tag(' \
  '  if (false) return tag(' || failed=$((failed + 1))

# 6. FAILING CLOSED WITHOUT THE WIDER COACHING VOCABULARY — "lose 5kg" is declined in an outage.
run_case "coaching goals fall to a failing classifier" server/understanding/domain-guard.ts \
  '\\d\\s?kgs?\\b|\\blos(?:e|ing)\\b|' \
  '' || failed=$((failed + 1))

# 7. A LIFE EVENT THAT MENTIONS AN OFF-TOPIC THING IS DECLINED — "update my CV so I skipped gym".
run_case "coaching words do not outrank an off-domain mention" server/understanding/domain-guard.ts \
  'if (OFF_DOMAIN_ASK_RE.test(t) && !isObviouslyInDomain(t))' \
  'if (OFF_DOMAIN_ASK_RE.test(t))' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-scope: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-scope: GREEN — 7/7 behavioral reverts caught"

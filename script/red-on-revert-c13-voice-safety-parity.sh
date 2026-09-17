#!/usr/bin/env bash
# RED-ON-REVERT — C13, safety parity for what a client actually says.
#
# Each case restores ONE mechanism to its pre-C12 state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-voice-safety-parity-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c12-revert.XXXXXX")"
FILES=(
  server/handlers/misc-commands.ts
  server/utils.ts
  server/brain/reply-verifier.ts
  server/handlers/chat-log.ts
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
  verdict="$(printf '%s\n' "$out" | grep '^pg-voice-safety-parity-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-voice-safety-parity-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-voice-safety-parity-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched voice-safety-parity acceptance is GREEN"

failed=0

# 1. THE SUPPLEMENT HANDLER CLAIMS THE PAIN TURN AGAIN. The branch stops standing down on a pain
#    report, so "should i take" pulls a medication question about a painful knee back into the
#    supplement pitch — and /\bi take\b/ inside "should i take" reads it as already taking.
run_case "a supplement pitch answers a painful joint" server/handlers/misc-commands.ts \
  '  if (classifyPainReport(m) === null && (suppMatch || m.includes("supplement") || m.includes("what should i take") || m.includes("should i take"))) {' \
  '  if (suppMatch || m.includes("supplement") || m.includes("what should i take") || m.includes("should i take")) {' || failed=$((failed + 1))

# 2. A JOINT SYMPTOM WITHOUT THE WORD PAIN REACHES NOBODY AGAIN. The joint-mechanical words come
#    out of classifyPainReport, so "my knee is clicking after the squats" returns null and the
#    safety owner never sees a knee complaint.
run_case "a clicking knee is not recognised as pain" server/utils.ts \
  '|niggle|niggling|click(?:s|ing|y)?|crunch(?:es|ing|y)?|grind(?:s|ing)?|lock(?:s|ing|ed)?|giving\s+me\s+grief)' \
  '|niggle|niggling)' || failed=$((failed + 1))

# 3. THE OUTBOUND FLOOR EATS THE SAFE ANSWER AGAIN. "day 2 after training" goes back to reading as
#    two completed sessions, so the DOMS reply is blocked and the client gets the repair stall.
run_case "a calendar day is read as a completed session" server/brain/reply-verifier.ts \
  '.map(seg => seg.replace(/(\d{1,2})\s*\/\s*\d{1,2}|\bday\s+\d{1,2}\b/gi, (_m, num) => (num ? `${num} ` : "day ")))' \
  '.map(seg => seg.replace(/(\d{1,2})\s*\/\s*\d{1,2}/g, "$1 "))' || failed=$((failed + 1))

# 4. THE VERIFIER STOPS READING THE LOCALE THE PRODUCT WRITES IN. extractStepNumbers goes back to
#    comma-only grouping, so the en-ZA non-breaking space hides the thousands: it reads "500",
#    compares it to 8500 and "corrects" a number that was never wrong — the client hears
#    "8 8,500 steps — nice one" after saying eight thousand five hundred.
run_case "the verifier cannot read the locale the product writes in" server/handlers/chat-log.ts \
  '  const matches = text.match(/\b\d{1,3}(?:[,\u00a0\u202f ]\d{3})*\s*steps?\b/gi) || [];' \
  '  const matches = text.match(/\b\d{1,3}(?:,\d{3})*\s*steps?\b/gi) || [];' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-c13-voice-safety-parity: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-c13-voice-safety-parity: GREEN — 4/4 behavioral reverts caught"

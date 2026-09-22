#!/usr/bin/env bash
# C18: saved injury and diet must change the programme the client could receive.
set -uo pipefail
cd "$(dirname "$0")/.."
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c18-programme-revert.XXXXXX")"
FILES=(server/programme.ts server/verifiers/programme-validator.ts)
for f in "${FILES[@]}"; do cp "$f" "$WORK_ROOT/$(printf '%s' "$f" | tr '/' '_')"; done
restore_case () { for f in "${FILES[@]}"; do cp "$WORK_ROOT/$(printf '%s' "$f" | tr '/' '_')" "$f"; done; }
cleanup () {
  restore_case
  for f in "$WORK_ROOT"/*; do rm -f "$f"; done
  rmdir "$WORK_ROOT"
}
trap cleanup EXIT INT TERM

run_case () {
  local name="$1" file="$2" before="$3" after="$4" out patched
  restore_case
  node - "$file" "$before" "$after" <<'JS'
const fs = require("fs");
const [file, before, after] = process.argv.slice(2);
const source = fs.readFileSync(file, "utf8");
if (!source.includes(before)) process.exit(3);
fs.writeFileSync(file, source.replace(before, after), "utf8");
JS
  patched=$?
  if [[ $patched -ne 0 ]]; then echo "  FAIL  $name — seam not found"; return 1; fi
  out="$(npx tsx script/c18-owner-repro.ts 2>&1)"
  if printf '%s\n' "$out" | grep -q '^C18 equipment/injury programme projection failed'; then
    echo "  PASS  $name → owner repro turned red"
    return 0
  fi
  echo "  FAIL  $name — owner repro did not turn red"
  return 1
}

if ! npx tsx script/c18-owner-repro.ts | grep -q '^c18-owner-repro: GREEN'; then
  echo "CONTROL: FAILED — untouched owner repro is not green"
  exit 1
fi
echo "CONTROL: untouched C18 owner repro is GREEN"

failed=0
run_case "the home programme bypasses its structured beginner/injury day" server/programme.ts \
  'if (todayOnly || (injury && injury.toLowerCase() !== "none")) {' \
  'if (false) {' || failed=$((failed + 1))
run_case "the validator treats skipped moves as prescribed" server/verifiers/programme-validator.ts \
  'const conflicts = checkExercisesAgainstInjuries(prescribedText, bodyParts);' \
  'const conflicts = checkExercisesAgainstInjuries(programmeText, bodyParts);' || failed=$((failed + 1))
run_case "the workout footer reintroduces incompatible foods" server/programme.ts \
  'fat_loss: "_After: use a protein food you already eat at your next usual meal._",' \
  'fat_loss: "_After: eggs, chicken or pilchards at your next usual meal._",' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-c18-programme: FAILED — $failed seam(s) unguarded"
  exit 1
fi
echo "red-on-revert-c18-programme: GREEN — 3/3 behavioral reverts caught"

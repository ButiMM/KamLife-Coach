#!/usr/bin/env bash
# RED-ON-REVERT — the transcript keeps every spoken hundred, in TypeScript and PostgreSQL.
set -uo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
source_file="server/understanding/messy-intake.ts"
cp "$source_file" "$work/messy-intake.ts"
failed=0

restore() {
  cp "$work/messy-intake.ts" "$source_file"
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f migrations/0012_spoken_step_hundreds.sql >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap restore EXIT

echo "=============================================================================="
echo "SPOKEN STEP COUNTS — RED ON REVERT"
echo "=============================================================================="

# Mechanism 1: the application drops the hundreds after an otherwise correct transcript.
python3 - <<'PY'
p = "server/understanding/messy-intake.ts"
s = open(p).read()
old = "const hundreds = match[3] ? (WORD_NUM[match[3].toLowerCase()] ?? Number(match[3])) * 100 : 0;"
new = "const hundreds = 0;"
assert old in s, "TypeScript revert target missing"
open(p, "w").write(s.replace(old, new, 1))
PY
ts_out="$(node --import tsx script/production-parity.ts 2>&1)"
ts_code=$?
cp "$work/messy-intake.ts" "$source_file"
echo "── REVERT: TypeScript drops the spoken hundreds"
if [[ $ts_code -ne 0 ]] && grep -q '^production-parity:' <<<"$ts_out" && grep -q '^Failures:' <<<"$ts_out"; then
  echo "   RED — customer/input parity caught the 8,500 → 8,000 regression"
else
  echo "   FAIL — revert did not reach a graded red verdict (exit=$ts_code)"
  failed=$((failed + 1))
fi

# Mechanism 2: the DB provenance owner cannot recognise the complete spoken claim. The runner
# gives this script a disposable local database; restoring 0008 is therefore a real old-function
# replay, never a production mutation.
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "── REVERT: PostgreSQL drops the spoken hundreds"
  echo "   FAIL — DATABASE_URL is absent; the DB revert was not exercised"
  failed=$((failed + 1))
else
  if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f migrations/0008_step_provenance_regex_repair.sql >/dev/null; then
    echo "── REVERT: PostgreSQL drops the spoken hundreds"
    echo "   FAIL — could not install the pre-cut function"
    failed=$((failed + 1))
  else
    pg_out="$(npx tsx script/pg-step-provenance-acceptance.ts 2>&1)"
    pg_code=$?
    echo "── REVERT: PostgreSQL drops the spoken hundreds"
    if [[ $pg_code -ne 0 ]] && grep -q '^pg-step-provenance-acceptance: RED' <<<"$pg_out"; then
      echo "   RED — the real DB acceptance caught the untrusted/truncated claim"
    else
      echo "   FAIL — revert did not reach a graded red verdict (exit=$pg_code)"
      failed=$((failed + 1))
    fi
  fi
  if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f migrations/0012_spoken_step_hundreds.sql >/dev/null; then
    echo "   FAIL — could not restore the current provenance function"
    failed=$((failed + 1))
  fi
fi

echo "=============================================================================="
if [[ $failed -ne 0 ]]; then
  echo "spoken-step-count red-on-revert: RED — $failed mechanism(s) unproven"
  exit 1
fi
echo "spoken-step-count red-on-revert: GREEN — 2/2 reverts reached a graded red verdict"

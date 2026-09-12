#!/usr/bin/env bash
# RED-ON-REVERT — Cut 4, every provider and every retry meets the admission floor.
#
# ONE MECHANISM PER CASE. The floor is not one rule but four that must each be able to fail on its
# own: the provider's reported metrics where they exist, and — for the three paths that report
# none — no-speech output, a single word looped, and a two-word vocabulary. A case that reverts two
# at once cannot tell you which one was load-bearing.
#
# TWO GRADERS, AND THEY SEE DIFFERENT THINGS. The PostgreSQL acceptance answers "what did this
# write?" against a real database; voice-provenance-tests answers "which strings are admitted?"
# against the pure predicate and the stubbed branch. A case passes when EITHER turns red, and the
# script says which.
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe
ACC=script/pg-stt-admission-acceptance.ts
UNIT=script/voice-provenance-tests.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cut4-revert.XXXXXX")"
BACKUP="$WORK_ROOT/backup"
PATCH_DIR="$WORK_ROOT/patches"

restore_case () {
  if [[ -d "$BACKUP/server" ]]; then
    rm -rf server
    mv "$BACKUP/server" server
  fi
  rm -rf "$BACKUP"
}
cleanup () { restore_case; rm -rf "$WORK_ROOT"; }
trap cleanup EXIT INT TERM

# A DETECTION IS A GRADED FAILED ASSERTION, NOT A NON-ZERO EXIT (CTO review of #244, carried here
# deliberately). A crash, an import error, a timeout or a dead database must never read as
# "caught" — that is the same fail-open shape this rescue keeps finding, built into the instrument.
graded_red () {
  local out="$1" prefix="$2" pattern="$3" verdict
  verdict="$(printf '%s\n' "$out" | grep -E "^${prefix}" | tail -1 || true)"
  if [[ -z "$verdict" ]]; then return 2; fi                        # no verdict = crashed
  if [[ ! "$verdict" =~ $pattern ]]; then return 1; fi             # ran, but not red
  if ! printf '%s\n' "$out" | grep -q '^  FAIL'; then return 1; fi # red with no failed assertion
  return 0
}

run_case () {
  local name="$1" patch="$2"
  local acc_out unit_out red="" crashed=""
  restore_case
  mkdir -p "$BACKUP"
  cp -a server "$BACKUP/server"
  if ! python3 "$patch"; then
    echo "  !! patch failed: $name"; restore_case; return 1
  fi
  if ! revert_db_reset; then
    echo "  !! database reset failed: $name"; restore_case; return 1
  fi
  acc_out="$(npx tsx "$ACC" 2>&1)"
  unit_out="$(npx tsx "$UNIT" 2>&1)"
  echo "── REVERT: $name"

  graded_red "$acc_out" "pg-stt-admission-acceptance:" "FAILED"; local acc_rc=$?
  graded_red "$unit_out" "voice-provenance-tests:" "FAILED"; local unit_rc=$?

  if [[ $acc_rc -eq 0 ]]; then
    red="acceptance"
    printf '%s\n' "$acc_out" | grep -E '^pg-stt-admission-acceptance:' | tail -1 | sed 's/^/   /'
    printf '%s\n' "$acc_out" | grep '^  FAIL' | sed 's/^/   /' | head -3 || true
  elif [[ $acc_rc -eq 2 ]]; then
    crashed="${crashed:+$crashed, }acceptance"
  fi
  if [[ $unit_rc -eq 0 ]]; then
    red="${red:+$red + }voice-provenance-tests"
    printf '%s\n' "$unit_out" | grep '^  FAIL' | sed 's/^/   /' | head -3 || true
  elif [[ $unit_rc -eq 2 ]]; then
    crashed="${crashed:+$crashed, }voice-provenance-tests"
  fi
  restore_case

  if [[ -n "$crashed" ]]; then
    echo "  !! grader(s) produced NO VERDICT (crashed): $crashed — case $name proves nothing"
    return 1
  fi
  if [[ -z "$red" ]]; then
    echo "  !! BOTH graders stayed green: $name"
    return 1
  fi
  echo "   caught by: $red"
}

mkdir -p "$PATCH_DIR"

# BOTH GRADERS MUST PASS UNTOUCHED FIRST.
if ! revert_db_reset; then echo "!! database reset failed before the control"; exit 1; fi
ctl_acc="$(npx tsx "$ACC" 2>&1)"; ctl_acc_status=$?
ctl_unit="$(npx tsx "$UNIT" 2>&1)"; ctl_unit_status=$?
if [[ $ctl_acc_status -ne 0 || $ctl_unit_status -ne 0 ]]; then
  echo "!! CONTROL FAILED — the unmodified graders do not both pass, so nothing below proves anything."
  printf '%s\n' "$ctl_acc" | grep -E '^pg-stt-admission-acceptance:|^  FAIL' | sed 's/^/   /' | head -5 || true
  printf '%s\n' "$ctl_unit" | grep -E '^voice-provenance-tests:|^  FAIL' | sed 's/^/   /' | head -5 || true
  exit 1
fi
echo "CONTROL: both graders are GREEN unmodified — detections below are real."


# 1. THE FLOOR GOES BACK TO METRICS-ONLY — the defect itself, exactly as it stood on f809456.
#    voiceQuality is set only by Whisper attempt 1, so Scribe (first in production), the catch
#    retry and the forced-English retry skip the floor entirely.
cat > "$PATCH_DIR/1.py" <<'PYEOF'
p="server/handlers/media.ts"; s=open(p).read(); b=s
s=s.replace("      if (wordCount >= 2 && transcriptFailsAdmission(transcribedText, voiceQuality)) {",
            "      if (voiceQuality && wordCount >= 2 && (voiceQuality.avgLogprob < -1.0 || voiceQuality.comp > 2.5)) {")
assert s!=b and "voiceQuality && wordCount" in s, "no match"; open(p,"w").write(s)
PYEOF

# 2. THE PREDICATE STOPS READING THE PROVIDER'S OWN NUMBERS. The content checks still stand, so
#    garble that LOOKS like words gets through on the one path that could have known better —
#    this is what "keep real metrics where they exist" buys, isolated.
cat > "$PATCH_DIR/2.py" <<'PYEOF'
p="server/understanding/sa-transcript.ts"; s=open(p).read(); b=s
s=s.replace("  if (quality && (quality.avgLogprob < -1.0 || quality.comp > 2.5)) return true;\n", "")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 3. THE NO-SPEECH CHECK GOES. "...", "♪♪♪", "[BLANK_AUDIO]" — output with no letter and no digit
#    in it becomes a transcript the coach answers.
cat > "$PATCH_DIR/3.py" <<'PYEOF'
p="server/understanding/sa-transcript.ts"; s=open(p).read(); b=s
s=s.replace("  if (!/[\\p{L}\\p{N}]/u.test(t)) return true;\n", "")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 4. THE CONSECUTIVE-RUN CHECK GOES. Sixteen "you" in a row — the reproduced defect's own string —
#    is admitted again. The frequency rule still catches long loops, so this isolates the run.
cat > "$PATCH_DIR/4.py" <<'PYEOF'
p="server/understanding/sa-transcript.ts"; s=open(p).read(); b=s
s=s.replace("    if (run >= 8) return true;", "    if (run >= 9999) return true;")
assert s!=b and "run >= 9999" in s, "no match"; open(p,"w").write(s)
PYEOF

# 5. THE TWO-WORD VOCABULARY CHECK GOES. "thank you thank you thank you…" is Whisper's most common
#    output on silence and it caps the commonest TOKEN at half, so the frequency rule never sees
#    it. This case exists because a fixture of this cut's own failed and found the gap.
cat > "$PATCH_DIR/5.py" <<'PYEOF'
p="server/understanding/sa-transcript.ts"; s=open(p).read(); b=s
s=s.replace("    if (counts.size <= 2) return true;\n", "")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 6. CONTROL — THE FLOOR REFUSES EVERYTHING. The opposite defect, and the one that would silence
#    the clients this product exists for. Every "nothing was written" check above is also true of
#    a product that never hears anybody, so a grader that cannot see this proves nothing.
cat > "$PATCH_DIR/6.py" <<'PYEOF'
p="server/understanding/sa-transcript.ts"; s=open(p).read(); b=s
s=s.replace("export function transcriptFailsAdmission(text: string, quality: VoiceQuality): boolean {",
            "export function transcriptFailsAdmission(text: string, quality: VoiceQuality): boolean {\n  return true;")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 7. CONTROL — THE FLOOR REFUSES SA LANGUAGE. The subtler opposite defect: a floor that admits
#    plain English and rejects the code-switching and slang our clients actually speak. Nothing in
#    the shipped predicate looks at vocabulary; this proves a grader would notice if it started to.
cat > "$PATCH_DIR/7.py" <<'PYEOF'
p="server/understanding/sa-transcript.ts"; s=open(p).read(); b=s
s=s.replace("  const t = (text || \"\").trim();\n  if (!t) return true;",
            "  const t = (text || \"\").trim();\n  if (!t) return true;\n"
            "  if (/\\b(samp|pap|morogo|neh|yoh|eish|lekker|ngiyabonga|chakalaka)\\b/i.test(t)) return true;")
assert s!=b and "ngiyabonga" in s, "no match"; open(p,"w").write(s)
PYEOF

echo "RED-ON-REVERT — Cut 4. Every case below must be caught by at least one grader."
failed=0
for i in 1 2 3 4 5 6 7; do
  if ! run_case "$i" "$PATCH_DIR/$i.py"; then failed=$((failed + 1)); fi
done
if [[ $failed -ne 0 ]]; then
  echo "RED-ON-REVERT: FAILED — $failed case(s) left every grader green, crashed, or would not patch."
  exit 1
fi
echo "RED-ON-REVERT: GREEN — 7/7 cases caught."

#!/usr/bin/env bash
# RED-ON-REVERT — Cut 3, a long note reaches the handlers whole.
#
# FOUR SILENT CUTS WERE FOUND IN ONE PIPELINE, and each gets its own case: the cleaner's
# 1,500-character window, the cleaner's missing lower bound, the condenser replacing the client's
# account, and the ledger's own 2,000-character cap on the record of what they said.
#
# TWO GRADERS, BECAUSE ONE CANNOT SEE BOTH HALVES. The PostgreSQL acceptance drives the TEXT front
# door, where the cleaner never runs; the cleaner is exercised in voice-provenance-tests against a
# stub client, because the real voice path needs an allow-listed https host and the network. A case
# passes when EITHER grader turns red, and the script says which — a case that leaves both green is
# a mechanism nothing is watching.
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe
ACC=script/pg-long-voice-tail-acceptance.ts
UNIT=script/voice-provenance-tests.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cut3-revert.XXXXXX")"
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

# A DETECTION IS A GRADED FAILED ASSERTION, NOT A NON-ZERO EXIT (CTO review of #244).
#
# The first version of this harness counted ANY non-zero exit as "caught". A crash, an import
# error, a timeout or a dead database would therefore have produced a confident 7/7 while nothing
# was being detected at all — the same fail-open shape this whole rescue keeps finding, built into
# the instrument that certifies the others.
#
# A case now counts only when a grader REACHES ITS OWN VERDICT LINE and that verdict reports failed
# checks, with at least one "FAIL" assertion printed. A missing verdict is a crash and fails the
# harness. `graded_red <output> <verdict-prefix> <red-pattern>` answers that question once.
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

  graded_red "$acc_out" "pg-long-voice-tail-acceptance:" "FAILED"; local acc_rc=$?
  graded_red "$unit_out" "voice-provenance-tests:" "FAILED"; local unit_rc=$?

  if [[ $acc_rc -eq 0 ]]; then
    red="acceptance"
    printf '%s\n' "$acc_out" | grep -E '^pg-long-voice-tail-acceptance:' | tail -1 | sed 's/^/   /'
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

  # A CRASH IS NEVER A DETECTION, even when the other grader legitimately went red — a case that
  # breaks a grader outright is not evidence about the mechanism it claims to test.
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

# BOTH GRADERS MUST PASS UNTOUCHED FIRST. Detection means nothing unless the same two commands are
# green on the unmodified tree: without this, a broken database or a bad import makes every case
# below "caught" and the harness certifies itself.
if ! revert_db_reset; then echo "!! database reset failed before the control"; exit 1; fi
ctl_acc="$(npx tsx "$ACC" 2>&1)"; ctl_acc_status=$?
ctl_unit="$(npx tsx "$UNIT" 2>&1)"; ctl_unit_status=$?
if [[ $ctl_acc_status -ne 0 || $ctl_unit_status -ne 0 ]]; then
  echo "!! CONTROL FAILED — the unmodified graders do not both pass, so nothing below proves anything."
  printf '%s\n' "$ctl_acc" | grep -E '^pg-long-voice-tail-acceptance:|^  FAIL' | sed 's/^/   /' | head -5 || true
  printf '%s\n' "$ctl_unit" | grep -E '^voice-provenance-tests:|^  FAIL' | sed 's/^/   /' | head -5 || true
  exit 1
fi
echo "CONTROL: both graders are GREEN unmodified — detections below are real."


# 1. THE CLEANER'S WINDOW DELETES THE TAIL AGAIN — the defect itself. 908 characters of a
#    three-minute note, including both questions and the last thing they said.
cat > "$PATCH_DIR/1.py" <<'PYEOF'
p="server/understanding/sa-transcript.ts"; s=open(p).read(); b=s
s=s.replace("  const { head, tail } = splitForClean(text);", '  const head = text.slice(0, 1500); const tail = "";')
assert s!=b and 'const head = text.slice(0, 1500)' in s, "no match"; open(p,"w").write(s)
PYEOF

# 2. THE EDIT CONTRACT GOES — the gate that replaced two beaten percentages. Without it a reply
#    can delete a clause out of the MIDDLE of the head: 95.84% of the text, ending intact,
#    finish_reason "stop", and the client's correction and question gone.
cat > "$PATCH_DIR/2.py" <<'PYEOF'
p="server/understanding/sa-transcript.ts"; s=open(p).read(); b=s
s=s.replace("      || !onlyApprovedRepairs(head, cleaned)) {", "      ) {")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 2b. THE FINISH-REASON GATE GOES. A separate promise from the edit contract: the model ran out of
#     tokens mid-sentence, and what came back is a fragment wearing the shape of an answer.
cat > "$PATCH_DIR/2b.py" <<'PYEOF'
p="server/understanding/sa-transcript.ts"; s=open(p).read(); b=s
s=s.replace('      || finishReason !== "stop"\n', "")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 2c. THE PROTECTED TOKENS STOP BEING PROTECTED. The contract still refuses deletions, so the
#     count-based half survives — this reverts only the rule that a number, a weekday or a
#     negation may never be substituted. 8500 becomes 8000 and "missed" becomes "finished",
#     each a one-for-one swap that leaves the token count untouched.
cat > "$PATCH_DIR/2c.py" <<'PYEOF'
p="server/understanding/sa-transcript.ts"; s=open(p).read(); b=s
s=s.replace("  if (isProtected(from) || isProtected(to)) return false;\n", "")
s=s.replace("  if (!SA_REPAIR_WORDS.has(to)) return false;", "  if (false) return false;")
assert s!=b and "if (false) return false;" in s, "no match"; open(p,"w").write(s)
PYEOF

# 3. THE CONDENSER COMES BACK ON THE ROUTING PATH — a model's retelling reaches the handlers as
#    the client's words. Restored inline, because deleting it was the point.
cat > "$PATCH_DIR/3.py" <<'PYEOF'
p="server/handlers/media.ts"; s=open(p).read(); b=s
s=s.replace("      const forBrain = transcribedText;",
            "      const forBrain = await condenseVoiceRamble(openai, transcribedText, user.id);")
s=s.replace('import { cleanSATranscript } from "../understanding/sa-transcript";',
            'import { cleanSATranscript } from "../understanding/sa-transcript";\n'
            'const condenseVoiceRamble = async (_o: any, t: string, _u: any) => t.split(". ")[0] + ".";')
assert s!=b and "condenseVoiceRamble(openai" in s, "no match"; open(p,"w").write(s)
PYEOF

# 4. THE LEDGER CAPS THE RECORD AT 2,000 CHARACTERS AGAIN. The handlers still receive the whole
#    note; the durable answer to "what did they actually say?" loses its last four hundred.
cat > "$PATCH_DIR/4.py" <<'PYEOF'
p="server/handlers/chat-log.ts"; s=open(p).read(); b=s
s=s.replace("  if (t.length <= LEDGER_TEXT_MAX) return t;", "  return t.slice(0, 2000);\n  if (t.length <= LEDGER_TEXT_MAX) return t;")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 5. THE SPLIT DROPS THE TAIL INSTEAD OF CARRYING IT. The shape a "small tidy-up" would take:
#    splitForClean still exists, still returns a head, and quietly returns no tail.
cat > "$PATCH_DIR/5.py" <<'PYEOF'
p="server/understanding/sa-transcript.ts"; s=open(p).read(); b=s
s=s.replace('  return at > 0 ? { head: text.slice(0, at), tail: text.slice(at) } : { head: window, tail: text.slice(CLEAN_WINDOW) };',
            '  return at > 0 ? { head: text.slice(0, at), tail: "" } : { head: window, tail: "" };')
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 6. OPPOSITE DEFECT — the cleaner stops cleaning. Every "nothing was deleted" check above is
#    trivially satisfied by a stage that returns its input, which is the cheapest wrong way to
#    pass a cut about not losing text. §1 of voice-provenance-tests is what stands in the way.
cat > "$PATCH_DIR/6.py" <<'PYEOF'
p="server/understanding/sa-transcript.ts"; s=open(p).read(); b=s
s=s.replace("  if (killswitchOff() || text.length < 4) return raw;", "  if (true) return raw;")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 7. OPPOSITE DEFECT — the record keeps every character except the ones that carry meaning. A cut
#    about nothing being lost must not be green while the NUMBERS in what the client said are
#    reshaped on their way into the record. §1's "8,500 steps survived" is what stands in the way.
#
#    THIS IS THE SECOND SHAPE OF THIS CASE. The first mutated every step-writing site in server/
#    (steps.ts insert and update, storage.ts, media.ts x2, health-sync.ts) and left BOTH graders
#    green — the stored row still read 8500 with logStepsForUser patched to throw outright. The
#    row's true writer was not identified, so §3's durable-row check is recorded as an outcome
#    check that no mutation here guards, rather than claimed as a guarded one.
cat > "$PATCH_DIR/7.py" <<'PYEOF'
p="server/handlers/chat-log.ts"; s=open(p).read(); b=s
s=s.replace("  if (t.length <= LEDGER_TEXT_MAX) return t;",
            '  return t.replace(/[0-9]/g, "");\n  if (t.length <= LEDGER_TEXT_MAX) return t;')
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

echo "RED-ON-REVERT — Cut 3. Every case below must be caught by at least one grader."
failed=0
for i in 1 2 2b 2c 3 4 5 6 7; do
  if ! run_case "$i" "$PATCH_DIR/$i.py"; then failed=$((failed + 1)); fi
done
if [[ $failed -ne 0 ]]; then
  echo "RED-ON-REVERT: FAILED — $failed case(s) left every grader green, crashed, or would not patch."
  exit 1
fi
echo "RED-ON-REVERT: GREEN — 9/9 cases caught."

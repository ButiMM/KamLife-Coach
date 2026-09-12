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

run_case () {
  local name="$1" patch="$2"
  local acc_out acc_status unit_out unit_status verdict red=""
  restore_case
  mkdir -p "$BACKUP"
  cp -a server "$BACKUP/server"
  if ! python3 "$patch"; then
    echo "  !! patch failed: $name"; restore_case; return 1
  fi
  if ! revert_db_reset; then
    echo "  !! database reset failed: $name"; restore_case; return 1
  fi
  acc_out="$(npx tsx "$ACC" 2>&1)"; acc_status=$?
  unit_out="$(npx tsx "$UNIT" 2>&1)"; unit_status=$?
  verdict="$(printf '%s\n' "$acc_out" | grep -E '^pg-long-voice-tail-acceptance:' | tail -1 || true)"
  echo "── REVERT: $name"
  if [[ $acc_status -ne 0 ]]; then
    red="acceptance"
    echo "   ${verdict:-'(no verdict — crashed)'}"
    printf '%s\n' "$acc_out" | grep '^  FAIL' | sed 's/^/   /' | head -3 || true
  fi
  if [[ $unit_status -ne 0 ]]; then
    red="${red:+$red + }voice-provenance-tests"
    printf '%s\n' "$unit_out" | grep '^  FAIL' | sed 's/^/   /' | head -3 || true
  fi
  restore_case
  if [[ -z "$red" ]]; then
    echo "  !! BOTH graders stayed green: $name"
    return 1
  fi
  echo "   caught by: $red"
}

mkdir -p "$PATCH_DIR"

# 1. THE CLEANER'S WINDOW DELETES THE TAIL AGAIN — the defect itself. 908 characters of a
#    three-minute note, including both questions and the last thing they said.
cat > "$PATCH_DIR/1.py" <<'PYEOF'
p="server/understanding/sa-transcript.ts"; s=open(p).read(); b=s
s=s.replace("  const { head, tail } = splitForClean(text);", '  const head = text.slice(0, 1500); const tail = "";')
assert s!=b and 'const head = text.slice(0, 1500)' in s, "no match"; open(p,"w").write(s)
PYEOF

# 2. THE LOWER BOUND GOES — a reply cut off by max_tokens becomes the transcript, middle missing.
#    There was a ceiling on the output length and never a floor.
cat > "$PATCH_DIR/2.py" <<'PYEOF'
p="server/understanding/sa-transcript.ts"; s=open(p).read(); b=s
s=s.replace("      || cleaned.length < head.length * 0.5\n", "")
assert s!=b, "no match"; open(p,"w").write(s)
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
for i in 1 2 3 4 5 6 7; do
  if ! run_case "$i" "$PATCH_DIR/$i.py"; then failed=$((failed + 1)); fi
done
if [[ $failed -ne 0 ]]; then
  echo "RED-ON-REVERT: FAILED — $failed case(s) left every grader green, crashed, or would not patch."
  exit 1
fi
echo "RED-ON-REVERT: GREEN — 7/7 cases caught."

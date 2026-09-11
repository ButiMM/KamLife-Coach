#!/usr/bin/env bash
# RED-ON-REVERT — raw voice provenance. One recording seam at a time.
#
# Each case removes exactly ONE piece of this cut and re-runs the suite that is supposed to grade
# it. A case that stays green is a check that grades nothing, which is the failure mode the whole
# provenance argument rests on: the words the client spoke were absent from the ledger for months
# and every gate was green throughout.
#
# Cases 1-3 revert the media.ts recording seams and are graded by voice-provenance-tests (source
# ORDER — the voice branch of media.ts cannot be executed offline, see that file's §4 for why, and
# this script is where that limitation is paid for). Cases 4-6 revert the ledger writer and the
# recorder itself and are graded by the PostgreSQL acceptance. Case 7 is an OPPOSITE-DEFECT
# control: it does not revert this cut, it breaks the thing this cut must not have broken.
# Cases 8-9 cover the handler-input correction: the first version of this cut stored the
# client-origin text under a comment claiming it was the handler input, while media.ts actually
# passed that text plus an internal language note.
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/voiceprov-revert.XXXXXX")"
BACKUP="$WORK_ROOT/backup"
PATCH_DIR="$WORK_ROOT/patches"

restore_case () {
  if [[ -d "$BACKUP/server" ]]; then
    rm -rf server && mv "$BACKUP/server" server
  fi
  rm -rf "$BACKUP"
}
cleanup () { restore_case; rm -rf "$WORK_ROOT"; }
trap cleanup EXIT INT TERM


run_case () {
  local name="$1" patch="$2" suite="$3" label="$4"
  local out status verdict
  restore_case
  mkdir -p "$BACKUP"
  cp -a server "$BACKUP/server"
  if ! python3 "$patch"; then
    echo "  !! patch failed: $name"; restore_case; return 1
  fi
  if ! revert_db_reset; then
    echo "  !! database reset failed: $name"; restore_case; return 1
  fi
  out="$(npx tsx "$suite" 2>&1)"
  status=$?
  verdict="$(printf '%s\n' "$out" | grep -E "^${label}:" | tail -1 || true)"
  echo "── REVERT $name"
  echo "   ${verdict:-(no verdict — crashed)}"
  printf '%s\n' "$out" | grep '^  FAIL' | sed 's/^/   /' | head -3 || true
  restore_case
  if [[ $status -eq 0 ]]; then
    echo "  !! suite stayed green: $name"; return 1
  fi
  if [[ ! "$verdict" =~ ^${label}:\ [1-9][0-9]*\ FAILED$ ]]; then
    echo "  !! suite did not reach a graded red verdict: $name (exit $status)"; return 1
  fi
}

mkdir -p "$PATCH_DIR"
UNIT=script/voice-provenance-tests.ts
UNIT_LABEL=voice-provenance-tests
ACC=script/pg-voice-provenance-acceptance.ts
ACC_LABEL=pg-voice-provenance-acceptance

# 1. THE RAW TRANSCRIPT IS NEVER CAPTURED. The client's own words are gone before anything sees
#    them — the exact state of the product before this cut.
cat > "$PATCH_DIR/1.py" <<'PY'
p="server/handlers/media.ts"; s=open(p).read(); b=s
s=s.replace(" turnVoice({ engine: sttEngine, raw: transcribedText, wordCount });", "")
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 2. THE RAW CAPTURE MOVES BELOW THE CLEANER. Subtle and much worse than case 1: the column is
#    populated, so it LOOKS recorded, but `transcribedText` has already been reassigned — the row
#    would hold cleaned text under the label "raw" and every diff would silently read as "the STT
#    heard it correctly".
cat > "$PATCH_DIR/2.py" <<'PY'
p="server/handlers/media.ts"; s=open(p).read(); b=s
s=s.replace(" turnVoice({ engine: sttEngine, raw: transcribedText, wordCount });", "")
s=s.replace("transcribedText = await cleanSATranscript(openai, transcribedText, user.id);",
            "transcribedText = await cleanSATranscript(openai, transcribedText, user.id); turnVoice({ engine: sttEngine, raw: transcribedText, wordCount });")
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 3. THE FOR-BRAIN TEXT IS NOT RECORDED, or is recorded after the recursion has already opened the
#    inner scope — either way the text the handlers actually routed on is not on the voice row.
cat > "$PATCH_DIR/3.py" <<'PY'
p="server/handlers/media.ts"; s=open(p).read(); b=s
s=s.replace(" turnVoice({ forBrain, handlerInput: brainInput, languageNote: languageNote || null });", "")
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 4. THE LEDGER STOPS WRITING THE THREE COLUMNS. The recorder still runs and the scope still holds
#    the texts; nothing durable results.
cat > "$PATCH_DIR/4.py" <<'PY'
p="server/handlers/chat-log.ts"; s=open(p).read(); b=s
s=s.replace("      voiceTranscriptRaw: v?.raw ?? null, voiceTranscriptCleaned: v?.cleaned ?? null,\n      voiceTextForBrain: v?.forBrain ?? null, voiceProvenance,\n", "")
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 5. THE RECORDER OVERWRITES INSTEAD OF MERGING. Called three times as the stages complete, so a
#    non-merging setter keeps only the last one and the raw transcript is lost again — including on
#    every early return, where only the raw call ever fires.
cat > "$PATCH_DIR/5.py" <<'PY'
p="server/handlers/chat-log.ts"; s=open(p).read(); b=s
s=s.replace("  t.voice = { ...(t.voice || {}), ...facts };", "  t.voice = { ...facts };")
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 6. THE FLAGS STOP DISTINGUISHING "RAN AND DECLINED" FROM "NEVER RAN". Both stages fail open, so
#    cleaned === raw is the ordinary case; collapsing null into false makes a failed voice turn
#    indistinguishable from a healthy one in exactly the column meant to tell them apart.
cat > "$PATCH_DIR/6.py" <<'PY'
p="server/handlers/chat-log.ts"; s=open(p).read(); b=s
s=s.replace("cleaned: v.cleaned !== undefined ? v.cleaned !== v.raw : null,", "cleaned: v.cleaned !== v.raw,")
s=s.replace("condensed: v.forBrain !== undefined ? v.forBrain !== v.cleaned : null,", "condensed: v.forBrain !== v.cleaned,")
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 7. OPPOSITE DEFECT — the voice columns are written on EVERY turn rather than only a voice turn.
#    Sections 1-5 of the acceptance would still pass; section 6's control is the only thing that
#    stops these columns quietly becoming a second copy of input_text.
cat > "$PATCH_DIR/7.py" <<'PY'
p="server/handlers/chat-log.ts"; s=open(p).read(); b=s
s=s.replace("    const v = t.voice;", "    const v = t.voice || { raw: t.inputText, cleaned: t.inputText, forBrain: t.inputText };")
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 8. THE HANDLER INPUT IS NOT RECORDED — the state the first version of this cut shipped in.
#    voice_text_for_brain was documented as "what the handlers routed on" while media.ts actually
#    passed that text PLUS an internal language note, so the row held a different string from the
#    call and nothing could tell.
cat > "$PATCH_DIR/8.py" <<'PY2'
p="server/handlers/chat-log.ts"; s=open(p).read(); b=s
s=s.replace("        handlerInput: v.handlerInput ?? null,\n        languageNote: v.languageNote ?? null,\n", "")
assert s!=b, "no match"; open(p,"w").write(s)
PY2

# 9. THE CONDENSED FLAG IS COMPUTED FROM THE HANDLER INPUT instead of the base client text. Every
#    language-note turn then reports as condensed — a claim about how the client spoke, derived
#    from a sentence we wrote ourselves.
cat > "$PATCH_DIR/9.py" <<'PY2'
p="server/handlers/chat-log.ts"; s=open(p).read(); b=s
s=s.replace("condensed: v.forBrain !== undefined ? v.forBrain !== v.cleaned : null,",
            "condensed: v.forBrain !== undefined ? (v.handlerInput ?? v.forBrain) !== v.cleaned : null,")
assert s!=b, "no match"; open(p,"w").write(s)
PY2

echo "RED-ON-REVERT — raw voice provenance. Every case below must report FAILED."
failed=0
run_case "1 (raw never captured)"        "$PATCH_DIR/1.py" "$UNIT" "$UNIT_LABEL" || failed=$((failed+1))
run_case "2 (raw captured after clean)"  "$PATCH_DIR/2.py" "$UNIT" "$UNIT_LABEL" || failed=$((failed+1))
run_case "3 (for-brain not recorded)"    "$PATCH_DIR/3.py" "$UNIT" "$UNIT_LABEL" || failed=$((failed+1))
run_case "4 (ledger drops the columns)"  "$PATCH_DIR/4.py" "$ACC"  "$ACC_LABEL"  || failed=$((failed+1))
run_case "5 (recorder overwrites)"       "$PATCH_DIR/5.py" "$ACC"  "$ACC_LABEL"  || failed=$((failed+1))
run_case "6 (flags lose null vs false)"  "$PATCH_DIR/6.py" "$ACC"  "$ACC_LABEL"  || failed=$((failed+1))
run_case "7 (OPPOSITE: written on every turn)" "$PATCH_DIR/7.py" "$ACC" "$ACC_LABEL" || failed=$((failed+1))
run_case "8 (handler input not recorded)"      "$PATCH_DIR/8.py" "$ACC" "$ACC_LABEL" || failed=$((failed+1))
run_case "9 (condensed flag from our own note)" "$PATCH_DIR/9.py" "$ACC" "$ACC_LABEL" || failed=$((failed+1))

if [[ $failed -ne 0 ]]; then
  echo "RED-ON-REVERT: FAILED — $failed case(s) were green, crashed, or ungraded."
  exit 1
fi
echo "RED-ON-REVERT: GREEN — 9/9 cases reached a graded red verdict."

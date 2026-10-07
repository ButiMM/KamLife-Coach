#!/usr/bin/env bash
# RED-ON-REVERT — #92, one final response owner answers the client's question.
#
# ONE MECHANISM PER CASE. This cut is one gate and one removal, but the claim behind them has
# five independent moving parts: WHICH turns reach the Coach mouth, WHAT the mouth is given, WHAT
# it is told, WHETHER its answer survives composition stripped of prescriptions, and WHETHER the
# canonical action still lands last. A green suite that
# cannot tell those apart says nothing about which of them is load-bearing.
#
# TWO CONTROLS FOR THE OPPOSITE DEFECT. "Answer the question" is trivially satisfied by handing
# EVERY decision turn to the model — which is the 2026-08-23 architecture the reviewer disproved,
# and which would also re-route a turn that already has a deterministic owner. Cases 6 and 7 make
# those failures visible instead of letting a wider gate read as a fix.
#
# A DETECTION IS A GRADED FAILED ASSERTION, NOT A NON-ZERO EXIT (carried from Cuts 3-6). A crash,
# an import error or a timeout must never read as "caught" — that is the same fail-open shape this
# programme keeps finding, built into the instrument that certifies the others.
set -uo pipefail
cd "$(dirname "$0")/.."
ACC=script/pg-final-response-owner-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cut92-revert.XXXXXX")"
BACKUP="$WORK_ROOT/backup"
PATCH_DIR="$WORK_ROOT/patches"
export DATABASE_URL="${DATABASE_URL:-postgres://kam:kam@127.0.0.1:5432/kamlife}"
export PG_ACCEPTANCE_ALLOW_RESET=1

restore_case () {
  if [[ -d "$BACKUP/server" ]]; then
    rm -rf server
    mv "$BACKUP/server" server
  fi
  rm -rf "$BACKUP"
}
cleanup () { restore_case; rm -rf "$WORK_ROOT"; }
trap cleanup EXIT INT TERM

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
  local out
  restore_case
  mkdir -p "$BACKUP"
  cp -a server "$BACKUP/server"
  if ! python3 "$patch"; then
    echo "  !! patch failed: $name"; restore_case; return 1
  fi
  out="$(npx tsx "$ACC" 2>&1)"
  echo "── REVERT: $name"

  graded_red "$out" "pg-final-response-owner-acceptance:" "FAILED"; local rc=$?
  restore_case

  if [[ $rc -eq 2 ]]; then
    echo "  !! grader produced NO VERDICT (crashed) — case $name proves nothing"
    return 1
  fi
  if [[ $rc -ne 0 ]]; then
    echo "  !! grader stayed green: $name"
    return 1
  fi
  printf '%s\n' "$out" | grep '^  FAIL' | sed 's/^/   /' | head -3 || true
  echo "   caught by: pg-final-response-owner-acceptance"
}

mkdir -p "$PATCH_DIR"







# 7. CONTROL — A TURN THAT ALREADY HAS A DETERMINISTIC OWNER IS RE-ROUTED. The missed-session owner
#    stands down and "I didn't train today" falls through to the Coach. §5 is the assertion that
#    this cut stayed inside gpt-block; without this case it could be vacuous.
cat > "$PATCH_DIR/7.py" <<'PYEOF'
p="server/handlers/lifecycle.ts"; s=open(p).read(); b=s
s=s.replace("  } else if (isMissedWorkout) {", "  } else if (false) {")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF



# 9. THE LEADING ADVERB DEFEATS THE IMPERATIVE AGAIN. The verb is re-anchored to the start of a
#    sentence, so "Then walk 3km after dinner." and "Also eat 200g of chicken tonight." stop being
#    orders and ride out beside the canonical action — the review finding, restored.
cat > "$PATCH_DIR/9.py" <<'PYEOF2'
p="server/brain/reply-verifier.ts"; s=open(p).read(); b=s
i=s.index("const IMPERATIVE_LEAD =")
j=s.index("\n", i)
# Keep the fronted meal/time branch, drop the adverbial one: "Also eat…" and "Then walk…" survive.
s=s[:i] + 'const IMPERATIVE_LEAD = "(?:(?:for\\\\s+(?:dinner|lunch|breakfast|supper|the\\\\s+rest\\\\s+of\\\\s+the\\\\s+day)|tonight|tomorrow|today|this\\\\s+(?:morning|afternoon|evening)|after\\\\s+(?:work|gym|training|dinner|lunch|supper))\\\\b[^.!?]{0,25}?\\\\s+)?";' + s[j:]
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF2


# 11. THE BARE PLATE PICK IS NO LONGER A CHOICE. "Have grilled chicken and rice tonight." names no
#     BEHAVIOUR_DOMAINS noun, so with this shape removed nothing recognises it and the model picks
#     the client's dinner alongside the canonical action.
cat > "$PATCH_DIR/11.py" <<'PYEOF2'
p="server/brain/reply-verifier.ts"; s=open(p).read(); b=s
s=s.replace("|(?:^|[.!?]\\s+|\\n)\\s*(?:(?:also|then|so|now|next|instead|rather),?\\s+)?(?:have|grab|go with|make it|stick (?:with|to))\\b/i;",
            "/i;", 1)
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF2


# 12. THE FRONTED MEAL PHRASE DEFEATS THE IMPERATIVE AGAIN — the reviewer's counterexample. "For
#     dinner tonight keep it protein-first: grilled chicken…" stops being an order and ships beside
#     the canonical action: two directions in one reply, which is what §3e exists to refuse.
cat > "$PATCH_DIR/12.py" <<'PYEOF2'
p="server/brain/reply-verifier.ts"; s=open(p).read(); b=s
i=s.index("const IMPERATIVE_LEAD =")
j=s.index("\n", i)
s=s[:i] + 'const IMPERATIVE_LEAD = "(?:(?:also|then|so|now|next|instead|rather|first|finally|additionally),?\\\\s+)?";' + s[j:]
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF2

# 13. THE DEBRIS MEND GOES BACK TO THE WHOLE REPLY. A mixed reply strips one sentence and mends
#     every other one with it, so a sentence that never held a figure loses is/at/and/with/of in
#     front of punctuation — "The question is:" becomes "The question:".
cat > "$PATCH_DIR/13.py" <<'PYEOF2'
p="server/numbers-mode.ts"; s=open(p).read(); b=s
old = """      const stripped = stripFigureTokens(part);
      return stripped === part ? part : mendStrippedSentence(stripped);"""
new = """      const stripped = stripFigureTokens(part);
      return mendStrippedSentence(stripped);"""
s=s.replace(old, new, 1)
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF2


# THE GRADER MUST PASS UNTOUCHED FIRST. Without this a broken import makes every case below
# "caught" and the harness certifies itself.
ctl="$(npx tsx "$ACC" 2>&1)"; ctl_status=$?
if [[ $ctl_status -ne 0 ]]; then
  echo "!! CONTROL FAILED — the unmodified acceptance does not pass, so nothing below proves anything."
  printf '%s\n' "$ctl" | grep -E '^pg-final-response-owner-acceptance:|^  FAIL' | sed 's/^/   /' | head -8 || true
  exit 1
fi
echo "CONTROL: the acceptance is GREEN unmodified — detections below are real."

echo "RED-ON-REVERT — #92. Every case below must be caught by the acceptance."
failed=0
for i in 7 9 11 12 13; do  # 1-6, 8, 10 patched gpt-block.ts, deleted 6 Oct
  if ! run_case "$i" "$PATCH_DIR/$i.py"; then failed=$((failed + 1)); fi
done
if [[ $failed -ne 0 ]]; then
  echo "RED-ON-REVERT: FAILED — $failed case(s) left the acceptance green, crashed, or would not patch."
  exit 1
fi
echo "RED-ON-REVERT: GREEN — 5/5 cases caught."

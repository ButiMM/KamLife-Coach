#!/usr/bin/env bash
# RED-ON-REVERT — #92, one final response owner answers the client's question.
#
# ONE MECHANISM PER CASE. This cut is one gate, but the claim behind it has four independent
# moving parts: WHICH turns reach the Coach mouth, WHAT the mouth is given, WHETHER its answer
# survives composition, and WHETHER the canonical action still lands last. A green suite that
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

# 1. THE DEFECT ITSELF, exactly as it stood on b7908c7. The mouth is gated on isMultiPartAsk, so a
#    single question on a decision turn never reaches the Coach and the turn ships the action line
#    alone — the same body for a pear, a definition and a catch-up.
cat > "$PATCH_DIR/1.py" <<'PYEOF'
p="server/handlers/gpt-block.ts"; s=open(p).read(); b=s
s=s.replace("      if (looksLikeQuestion(message)) {",
            "      if (looksLikeQuestion(message) && message.trim().length >= 60 && (message.match(/\\?/g)||[]).length >= 2) {")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 2. THE MOUTH IS CALLED AND ITS ANSWER IS THROWN AWAY. The composer takes the situation frame
#    instead of what the Coach said — the defect moved one stage later, and every §7 check stays
#    green through it because the model really was asked.
cat > "$PATCH_DIR/2.py" <<'PYEOF'
p="server/handlers/gpt-block.ts"; s=open(p).read(); b=s
s=s.replace("          questionContext === AGENT_ERROR ? situationFrame : questionContext,\n",
            "          situationFrame,\n", 1)
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 3. THE CANONICAL ACTION IS DROPPED FROM THE ANSWERED TURN. The client gets a good answer and no
#    next move — the ONE NEXT MOVE law broken by the same change that fixed the question.
cat > "$PATCH_DIR/3.py" <<'PYEOF'
p="server/handlers/gpt-block.ts"; s=open(p).read(); b=s
old="""        gptReply = composeDecisionTurn(
          questionContext === AGENT_ERROR ? situationFrame : questionContext,
          decision.reply || renderActionLine(decision.todo),
        );"""
new="""        gptReply = composeDecisionTurn(
          questionContext === AGENT_ERROR ? situationFrame : questionContext,
          "",
        );"""
s=s.replace(old, new, 1)
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 4. THE MODEL IS GIVEN A WINDOW OF THE MESSAGE instead of the message. Every delivery check in
#    §1/§2 stays green — the stub answers whatever it is handed — and only §7 sees it. This is the
#    case that makes §1/§2 mean something.
cat > "$PATCH_DIR/4.py" <<'PYEOF'
p="server/handlers/gpt-block.ts"; s=open(p).read(); b=s
s=s.replace("          () => askCoachK(message, user, questionContextInstruction, memoryContext, SCENARIO_GUIDE));",
            "          () => askCoachK(message.slice(0, 20), user, questionContextInstruction, memoryContext, SCENARIO_GUIDE));")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 5. THE MOUTH IS NO LONGER TOLD THE TURN ALREADY WROTE THE FACTS. This is the sentence that stops
#    the answer asking for the pear back, and nothing else in the prompt carries it.
cat > "$PATCH_DIR/5.py" <<'PYEOF'
p="server/handlers/gpt-block.ts"; s=open(p).read(); b=s
s=s.replace("The facts in this same message have already been committed: never ask the client to report them again.\n", "")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 6. CONTROL — THE GATE OPENS TO EVERY DECISION TURN. A client who asked nothing gets model prose
#    in front of their action line, and every log costs a model call. This satisfies "the question
#    is answered" completely and is the wrong fix; §4 exists to say so.
cat > "$PATCH_DIR/6.py" <<'PYEOF'
p="server/handlers/gpt-block.ts"; s=open(p).read(); b=s
s=s.replace("      if (looksLikeQuestion(message)) {", "      if (true) {")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 7. CONTROL — A TURN THAT ALREADY HAS A DETERMINISTIC OWNER IS RE-ROUTED. The missed-session owner
#    stands down and "I didn't train today" falls through to the Coach. §5 is the assertion that
#    this cut stayed inside gpt-block; without this case it could be vacuous.
cat > "$PATCH_DIR/7.py" <<'PYEOF'
p="server/handlers/lifecycle.ts"; s=open(p).read(); b=s
s=s.replace("  } else if (isMissedWorkout) {", "  } else if (false) {")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

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
for i in 1 2 3 4 5 6 7; do
  if ! run_case "$i" "$PATCH_DIR/$i.py"; then failed=$((failed + 1)); fi
done
if [[ $failed -ne 0 ]]; then
  echo "RED-ON-REVERT: FAILED — $failed case(s) left the acceptance green, crashed, or would not patch."
  exit 1
fi
echo "RED-ON-REVERT: GREEN — 7/7 cases caught."

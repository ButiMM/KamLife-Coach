#!/usr/bin/env bash
# RED-ON-REVERT — Cut 6, proactive delivery outside the 24-hour window.
#
# ONE MECHANISM PER CASE. This cut has seven independent moving parts — the three template
# wirings, the honest outcome, the variable sanitiser, the SID validation and the delivery
# callback. Each must be able to fail on its own, or a green suite says nothing about which of
# them is load-bearing.
#
# ONE GRADER, AND IT IS ENOUGH HERE. Unlike the voice cuts, every claim in this cut is about the
# payload handed to Twilio and the outcome handed back to the caller — both of which the focused
# grader observes directly against a simulated provider. The PostgreSQL acceptance covers the
# durable half (what a substituted send does NOT record) and is run separately by the runner.
set -uo pipefail
cd "$(dirname "$0")/.."
UNIT=script/proactive-template-tests.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cut6-revert.XXXXXX")"
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

# A DETECTION IS A GRADED FAILED ASSERTION, NOT A NON-ZERO EXIT (carried from Cut 3/4 deliberately).
# A crash, an import error or a timeout must never read as "caught" — that is the same fail-open
# shape this rescue keeps finding, built into the instrument that certifies the others.
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
  local unit_out
  restore_case
  mkdir -p "$BACKUP"
  cp -a server "$BACKUP/server"
  if ! python3 "$patch"; then
    echo "  !! patch failed: $name"; restore_case; return 1
  fi
  unit_out="$(npx tsx "$UNIT" 2>&1)"
  echo "── REVERT: $name"

  graded_red "$unit_out" "proactive-template-tests:" "FAILED"; local rc=$?
  restore_case

  if [[ $rc -eq 2 ]]; then
    echo "  !! grader produced NO VERDICT (crashed) — case $name proves nothing"
    return 1
  fi
  if [[ $rc -ne 0 ]]; then
    echo "  !! grader stayed green: $name"
    return 1
  fi
  printf '%s\n' "$unit_out" | grep '^  FAIL' | sed 's/^/   /' | head -3 || true
  echo "   caught by: proactive-template-tests"
}

mkdir -p "$PATCH_DIR"

# THE GRADER MUST PASS UNTOUCHED FIRST. Without this a broken import makes every case below
# "caught" and the harness certifies itself.
ctl="$(npx tsx "$UNIT" 2>&1)"; ctl_status=$?
if [[ $ctl_status -ne 0 ]]; then
  echo "!! CONTROL FAILED — the unmodified grader does not pass, so nothing below proves anything."
  printf '%s\n' "$ctl" | grep -E '^proactive-template-tests:|^  FAIL' | sed 's/^/   /' | head -5 || true
  exit 1
fi
echo "CONTROL: the grader is GREEN unmodified — detections below are real."


# 1. THE MESSAGE'S OWN TEMPLATE IS NEVER CONSULTED — the defect itself, exactly as it stood on
#    c042dd8. Three approved templates, no call site, and every closed-window send degrades to the
#    generic check-in whatever message it was carrying.
cat > "$PATCH_DIR/1.py" <<'PYEOF'
p="server/scheduler/shared.ts"; s=open(p).read(); b=s
s=s.replace("        const matched = windowTemplate && templateSid(windowTemplate.name);",
            "        const matched = false;")
assert s!=b and "const matched = false;" in s, "no match"; open(p,"w").write(s)
PYEOF

# 2. THE SUBSTITUTION IS CALLED A DELIVERY AGAIN. The generic check-in goes out and the caller is
#    told the morning plan landed — so morning.ts opens a training loop against a message the
#    client never read. This is the reporting half, isolated from the wiring half.
cat > "$PATCH_DIR/2.py" <<'PYEOF'
p="server/scheduler/shared.ts"; s=open(p).read(); b=s
s=s.replace('return templateDelivery === "dropped" ? "dropped" : "substituted";',
            'return templateDelivery === "dropped" ? "dropped" : "fallback";')
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 2b. …AND THE SAME CLAIM MADE FROM THE OTHER SIDE: deliveryAccepted starts counting a substitution
#     as an accepted delivery. Separate owner, separate case — the outcome and its meaning are two
#     different things, and only one of them is in the send path.
cat > "$PATCH_DIR/2b.py" <<'PYEOF'
p="server/outbound-delivery.ts"; s=open(p).read(); b=s
s=s.replace('return result === "sent" || result === "fallback";',
            'return result === "sent" || result === "fallback" || result === "substituted";')
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 3. THE VARIABLE SANITISER GOES. A morning action that spans two lines is handed to Twilio with
#    its line break intact — which WhatsApp rejects, on the proactive path, for a client who is by
#    definition not watching.
cat > "$PATCH_DIR/3.py" <<'PYEOF'
p="server/utils.ts"; s=open(p).read(); b=s
s=s.replace("export function sanitiseContentVariable(value: string): string {",
            "export function sanitiseContentVariable(value: string): string {\n  return value;")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 4. SID VALIDATION GOES. Anything in the environment variable is handed to Twilio as a template —
#    a truncated paste, a whole "NAME=HX…" line, a Messaging Service SID.
cat > "$PATCH_DIR/4.py" <<'PYEOF'
p="server/whatsapp-templates.ts"; s=open(p).read(); b=s
s=s.replace("export function isValidTemplateSid(sid: string): boolean {",
            "export function isValidTemplateSid(sid: string): boolean {\n  return true;")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 5. THE NEWLINE-BEARING KEY GOES UNREPORTED. The SID sits in Railway under a name nobody can type,
#    the template reads as never approved, and the self-check names the wrong cause.
cat > "$PATCH_DIR/5.py" <<'PYEOF'
p="server/whatsapp-templates.ts"; s=open(p).read(); b=s
s=s.replace("export function malformedTemplateEnvNames(): Array<{ expected: string; actual: string }> {",
            "export function malformedTemplateEnvNames(): Array<{ expected: string; actual: string }> {\n  return [];")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 6. THE DELIVERY CALLBACK GOES. /webhook/status stays implemented and signature-validated, and
#    Twilio is never told to POST to it — so a send accepted and then never delivered leaves no
#    durable evidence, which is the state this cut found.
cat > "$PATCH_DIR/6.py" <<'PYEOF'
p="server/outbound-delivery.ts"; s=open(p).read(); b=s
s=s.replace("export function statusCallbackUrl(): string {",
            "export function statusCallbackUrl(): string {\n  return \"\";")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 7. THE RESTART DOCTRINE COMES BACK into the approved re-engagement body — the phrasing three
#    existing acceptances forbid on the freeform door and which shipped here unwatched.
cat > "$PATCH_DIR/7.py" <<'PYEOF'
p="server/whatsapp-templates.ts"; s=open(p).read(); b=s
s=s.replace("Reply with one word and we pick up where you left off.",
            "Reply with one word and we start from today.")
assert s!=b and "we start from today" in s, "no match"; open(p,"w").write(s)
PYEOF

# 8. CONTROL — EVERY CLOSED-WINDOW SEND BECOMES A SUBSTITUTION. The opposite defect: a door that
#    reports failure for everything would satisfy every "not recorded as delivered" check above.
cat > "$PATCH_DIR/8.py" <<'PYEOF'
p="server/scheduler/shared.ts"; s=open(p).read(); b=s
s=s.replace('            if (d !== "dropped") return "fallback";           // the real content reached them',
            '            if (d !== "dropped") return "substituted";')
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

# 9. CONTROL — THE TEMPLATE STOPS CARRYING THE CLIENT'S VALUES. It renders with empty placeholders:
#    the right template, sent, addressed to nobody and naming no action. A grader that only checks
#    WHICH template was chosen would stay green through this.
cat > "$PATCH_DIR/9.py" <<'PYEOF'
p="server/scheduler/shared.ts"; s=open(p).read(); b=s
s=s.replace("            const d = await sendWhatsAppTemplate(to, matched, windowTemplate!.variables, {",
            "            const d = await sendWhatsAppTemplate(to, matched, undefined, {")
assert s!=b, "no match"; open(p,"w").write(s)
PYEOF

echo "RED-ON-REVERT — Cut 6. Every case below must be caught by the grader."
failed=0
for i in 1 2 2b 3 4 5 6 7 8 9; do
  if ! run_case "$i" "$PATCH_DIR/$i.py"; then failed=$((failed + 1)); fi
done
if [[ $failed -ne 0 ]]; then
  echo "RED-ON-REVERT: FAILED — $failed case(s) left the grader green, crashed, or would not patch."
  exit 1
fi
echo "RED-ON-REVERT: GREEN — 10/10 cases caught."

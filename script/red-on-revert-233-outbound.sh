#!/usr/bin/env bash
# RED-ON-REVERT — #233 outbound, one mechanism at a time.
set -u
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe
ACC=script/pg-missed-session-outbound-acceptance.ts
run_case () {
  local name="$1" patch="$2"
  cp -r server /tmp/233-server-backup
  python3 "$patch" || { echo "  !! patch failed: $name"; rm -rf /tmp/233-server-backup; return 1; }
  if ! revert_db_reset; then
    echo "  !! database reset failed: $name"; rm -rf /tmp/233-server-backup; return 1
  fi
  local out; out="$(npx tsx "$ACC" 2>&1)"
  echo "── REVERT: $name"
  echo "   $(echo "$out" | grep -E '^pg-missed-session-outbound-acceptance:' || echo '(no verdict — crashed)')"
  echo "$out" | grep '^  FAIL' | sed 's/^/   /' | head -4
  rm -rf server && mv /tmp/233-server-backup server
}
mkdir -p /tmp/233p
cat > /tmp/233p/1.py <<'PY'
p="server/brain/reply-verifier.ts"; s=open(p).read(); b=s
s=s.replace(" && !isMissClaim(seg)","")
assert s!=b, "no match"; open(p,"w").write(s)
PY
cat > /tmp/233p/2.py <<'PY'
p="server/handlers/lifecycle.ts"; s=open(p).read(); b=s
s=s.replace("You have ${total} sessions overall.","You have ${total} sessions completed.")
assert s!=b, "no match"; open(p,"w").write(s)
PY
cat > /tmp/233p/3.py <<'PY'
p="server/brain/reply-verifier.ts"; s=open(p).read(); b=s
s=s.replace(r"|\baltogether\b|\boverall\b|\blifetime\b", r"|\baltogether\b|\blifetime\b")
assert s!=b, "no match"; open(p,"w").write(s)
PY
cat > /tmp/233p/4.py <<'PY'
# OPPOSITE DEFECT: the floor stops judging session counts at all. Every "must not be repaired"
# check passes and the product loses the rule that stops it overstating a client's training.
p="server/brain/reply-verifier.ts"; s=open(p).read(); b=s
s=s.replace("export function adjudicableSessionCounts(text: string): number[] {",
            "export function adjudicableSessionCounts(text: string): number[] {\n  return [];")
assert s!=b, "no match"; open(p,"w").write(s)
PY
cat > /tmp/233p/5.py <<'PY2'
# Gate 3, mechanism 1: the ladder rung answers a today-question with a tomorrow-only weigh again,
# masking the fuelling rung below it.
p="server/one-action.ts"; s=open(p).read(); b=s
s=s.replace("  if (!scaleIsOffLimits && !(s.asksAboutToday && weighWouldBeTomorrow)\n      && ((neverWeighed",
            "  if (!scaleIsOffLimits\n      && ((neverWeighed")
assert s!=b, "no match"; open(p,"w").write(s)
PY2
cat > /tmp/233p/6.py <<'PY2'
# Gate 3, mechanism 2: the today-action precedence is removed, so the #203 downgrade replaces the
# fuelling rung with an investigation even when the client asked what to do today.
p="server/one-action.ts"; s=open(p).read(); b=s
s=s.replace("    if ((futureOnlyWeigh || saysNothing) && String(action.todo || \"\").trim()) return action;\n","")
assert s!=b, "no match"; open(p,"w").write(s)
PY2
echo "=============================================================================="
echo "#233 outbound — RED ON REVERT"
echo "=============================================================================="
run_case "a miss is read as a completed session again"            /tmp/233p/1.py
run_case "the lifetime figure says 'completed' again"             /tmp/233p/2.py
run_case "the floor no longer knows 'overall' is lifetime"        /tmp/233p/3.py
run_case "the floor stops judging session counts (opposite defect)" /tmp/233p/4.py
run_case "the weigh rung masks the fuelling rung on a today-question"    /tmp/233p/5.py
run_case "the today-action precedence is removed"                       /tmp/233p/6.py
echo "=============================================================================="

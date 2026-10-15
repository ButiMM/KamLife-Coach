#!/usr/bin/env bash
# RED-ON-REVERT — C17 evening, the empty-day message inside and outside the 24-hour window.
#
# ONE MECHANISM PER CASE. A green suite that cannot say WHICH line is load-bearing certifies
# nothing, so each seam is reverted alone.
#
# THE GRADER IS THE PostgreSQL ACCEPTANCE, because every claim in this cut is about durable truth
# and the post-transport payload — what Twilio was handed, and what chat_history says the coach
# said. Neither can be observed from a return value.
set -uo pipefail
cd "$(dirname "$0")/.."
ACC=script/pg-evening-delivery-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c17-evening-revert.XXXXXX")"
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

# A DETECTION IS A GRADED FAILED ASSERTION, NOT A NON-ZERO EXIT. A crash, an import error or a
# timeout must never read as "caught" — that is the same fail-open shape this discipline exists
# to catch, built into the instrument that certifies the others.
graded_red () {
  local out="$1" verdict
  verdict="$(printf '%s\n' "$out" | grep -E "^pg-evening-delivery-acceptance:" | tail -1 || true)"
  if [[ -z "$verdict" ]]; then return 2; fi                        # no verdict = crashed
  if [[ ! "$verdict" =~ FAILED ]]; then return 1; fi               # ran, but not red
  if ! printf '%s\n' "$out" | grep -q '^  FAIL'; then return 1; fi # red with no failed assertion
  return 0
}

run_case () {
  local name="$1" patch="$2" out rc
  restore_case
  mkdir -p "$BACKUP"
  cp -a server "$BACKUP/server"
  if ! python3 "$patch"; then
    echo "  !! patch failed to apply: $name"; restore_case; return 1
  fi
  out="$(npx tsx "$ACC" 2>&1)"
  graded_red "$out"; rc=$?
  restore_case

  if [[ $rc -eq 2 ]]; then
    echo "  !! NO VERDICT (crashed) — case $name proves nothing"
    return 1
  fi
  if [[ $rc -ne 0 ]]; then
    echo "  !! acceptance stayed green: $name"
    return 1
  fi
  echo "  PASS  $name"
  printf '%s\n' "$out" | grep '^  FAIL' | head -2 | sed 's/^/        /'
}

mkdir -p "$PATCH_DIR"

# THE CONTROL MUST PASS UNTOUCHED FIRST. Without it a broken import makes every case below
# "caught" and the harness certifies itself.
ctl="$(npx tsx "$ACC" 2>&1)"
if ! printf '%s\n' "$ctl" | grep -qE "^pg-evening-delivery-acceptance: GREEN"; then
  echo "CONTROL: FAILED — untouched acceptance is not green, so nothing below proves anything."
  printf '%s\n' "$ctl" | grep -E '^  FAIL' | sed 's/^/   /' | head -6 || true
  exit 1
fi
echo "CONTROL: untouched evening acceptance is GREEN"

# 1. THE GENERIC CHECK-IN GOES IN PLACE OF THE MESSAGE AGAIN (#327) — the defect itself. With no
#    template of its own, the evening coaching is replaced by "Coach K checking in". §2 and §3 must go red.
cat > "$PATCH_DIR/1.py" <<'PYEOF'
p="server/scheduler/shared.ts"; s=open(p).read(); b=s
s=s.replace('const matched = windowTemplate && templateSid(windowTemplate.name);',
            'windowTemplate = windowTemplate || { name: "kamlife_checking_in" }; const matched = templateSid(windowTemplate.name);')
assert s != b, "no match"; open(p, "w").write(s)
PYEOF

# 2. A SEND THAT REACHED NOBODY IS REPORTED AS DELIVERED. Outside the window, with no template and no
#    SMS, the caller must hear `dropped`, or it acts on coaching the client never read. §3 must go red.
cat > "$PATCH_DIR/2.py" <<'PYEOF'
p="server/scheduler/shared.ts"; s=open(p).read(); b=s
s=s.replace('      if (!smsLanded) return "dropped";\n      void logOutboundToHistory(to, smsFallbackText); // best-effort, non-blocking\n      return "fallback";',
            '      void logOutboundToHistory(to, smsFallbackText); // best-effort, non-blocking\n      return "fallback";')
assert s != b, "no match"; open(p, "w").write(s)
PYEOF

# 3. THE STORED BODY GOES BACK TO THE INTENDED ONE. A template send must store what the client read
#    (the rendered template), not the text it stood in for; §4 must go red.
cat > "$PATCH_DIR/3.py" <<'PYEOF'
p="server/scheduler/shared.ts"; s=open(p).read(); b=s
s=s.replace('  const logText = rendered || opts?.fallbackText || `[template ${contentSid}]`;',
            '  const logText = opts?.fallbackText || rendered || `[template ${contentSid}]`;')
assert s != b, "no match"; open(p, "w").write(s)
PYEOF

# 4. THE EVENING JOB STOPS SENDING TO AN EMPTY DAY ALTOGETHER. The cheapest way to satisfy every
#    "the coaching did not arrive" assertion is to send nothing, which deletes the feature. §1 is
#    the control that refuses it.
cat > "$PATCH_DIR/4.py" <<'PYEOF'
p="server/scheduler/jobs/evening.ts"; s=open(p).read(); b=s
s=s.replace("      if (todayLogs.length === 0) {", "      if (todayLogs.length === 0) {\n        continue;")
assert s != b, "no match"; open(p, "w").write(s)
PYEOF

echo "RED-ON-REVERT — C17 evening. Every case below must turn the acceptance red."
failed=0
for i in 1 2 3 4; do
  if ! run_case "$i" "$PATCH_DIR/$i.py"; then failed=$((failed + 1)); fi
done
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-c17-evening-delivery: FAILED — $failed case(s) left it green, crashed, or would not patch."
  exit 1
fi
echo "red-on-revert-c17-evening-delivery: GREEN — 4/4 behavioral reverts caught"

#!/usr/bin/env bash
# RED-ON-REVERT — Cut 1, the customer-visible truth boundary. One mechanism at a time.
#
# Each case reverts exactly ONE line of this cut and re-runs the acceptance. A case that stays
# green is a check that grades nothing, which is the failure mode this whole cut exists to end:
# 42 suites asserted handleMessage's return value and none of them could see a transport defect.
#
# Cases 5 and 6 are OPPOSITE-DEFECT controls. They do not revert this cut; they break the thing it
# must NOT have broken (proactive duplicate suppression, the session-count floor). If those two do
# not go red, the acceptance is not protecting what it claims to protect.
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe
ACC=script/pg-interaction-truth-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cut1-revert.XXXXXX")"
BACKUP="$WORK_ROOT/backup"
PATCH_DIR="$WORK_ROOT/patches"

restore_case () {
  if [[ -d "$BACKUP/server" && -d "$BACKUP/shared" ]]; then
    rm -rf server shared
    mv "$BACKUP/server" server
    mv "$BACKUP/shared" shared
  fi
  rm -rf "$BACKUP"
}

cleanup () {
  restore_case
  rm -rf "$WORK_ROOT"
}
trap cleanup EXIT INT TERM

run_case () {
  local name="$1" patch="$2"
  local out status verdict
  restore_case
  mkdir -p "$BACKUP"
  cp -a server "$BACKUP/server"
  cp -a shared "$BACKUP/shared"
  if ! python3 "$patch"; then
    echo "  !! patch failed: $name"
    restore_case
    return 1
  fi
  if ! revert_db_reset; then
    echo "  !! database reset failed: $name"
    restore_case
    return 1
  fi
  out="$(npx tsx "$ACC" 2>&1)"
  status=$?
  verdict="$(printf '%s\n' "$out" | grep -E '^pg-interaction-truth-acceptance:' | tail -1 || true)"
  echo "── REVERT: $name"
  echo "   ${verdict:-'(no verdict — crashed)'}"
  printf '%s\n' "$out" | grep '^  FAIL' | sed 's/^/   /' | head -4 || true
  restore_case
  if [[ $status -eq 0 ]]; then
    echo "  !! acceptance stayed green: $name"
    return 1
  fi
  if [[ ! "$verdict" =~ ^pg-interaction-truth-acceptance:\ [1-9][0-9]*\ FAILED$ ]]; then
    echo "  !! acceptance did not reach a graded red verdict: $name (exit $status)"
    return 1
  fi
}

mkdir -p "$PATCH_DIR"

# 1. THE REACTIVE DUPLICATE AUTHORITY COMES BACK to the floor. This is the defect proven on
#    7833ebb: the second asking of the same question got the outbound repair.
cat > "$PATCH_DIR/1.py" <<'PY'
p="server/outbound-authority.ts"; s=open(p).read(); b=s
s=s.replace('if (mode === "proactive" && isDuplicateOutbound(', 'if (isDuplicateOutbound(')
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 2. THE TRANSPORT STOPS FINALISING THE ROW. delivered_body, the verdict and the delivery outcome
#    all go back to null — the state the ledger was in for a month of green builds.
cat > "$PATCH_DIR/2.py" <<'PY'
p="server/routes/whatsapp.ts"; s=open(p).read(); b=s
s=s.replace("  const outcome = await sendParts(phone, splitMessage(out), outMedia);\n  await finalise(outcome);",
            "  await sendParts(phone, splitMessage(out), outMedia);")
s=s.replace('  if ((await shadowDoor(phone, out, "reply", "server/routes/whatsapp.ts", media)) && !isCrisisOut) {\n    await finalise("shadow");\n    return;\n  }',
            '  if ((await shadowDoor(phone, out, "reply", "server/routes/whatsapp.ts", media)) && !isCrisisOut) return;')
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 3. THE ROOT ID IS RE-MINTED PER SCOPE instead of inherited. One voice note becomes two
#    uncorrelatable interactions again, and the transport can no longer find the row.
cat > "$PATCH_DIR/3.py" <<'PY'
p="server/handlers/chat-log.ts"; s=open(p).read(); b=s
s=s.replace('const rootId = turnStore.getStore()?.rootId || seed || `turn-',
            'const rootId = `turn-')
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 4. THE REFUSED DRAFT IS DROPPED from the verdict. A blocked turn records the repair and nothing
#    about what the coach had actually composed.
cat > "$PATCH_DIR/4.py" <<'PY'
p="server/outbound-authority.ts"; s=open(p).read(); b=s
s=s.replace(', draft: out };', ' };').replace(', draft: text };', ' };')
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 5. OPPOSITE DEFECT — the duplicate rule is removed for BOTH doors. Two crons may now cover the
#    same ground on the same morning. Section 6 must catch this.
cat > "$PATCH_DIR/5.py" <<'PY'
p="server/outbound-authority.ts"; s=open(p).read(); b=s
s=s.replace('if (mode === "proactive" && isDuplicateOutbound(', 'if (false && isDuplicateOutbound(')
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 6. OPPOSITE DEFECT — the session-count floor stops judging. Every "must not be repaired" check in
#    section 1 would still pass while the product loses the rule that stops it overstating a
#    client's training. Section 5 must catch this.
cat > "$PATCH_DIR/6.py" <<'PY'
p="server/brain/reply-verifier.ts"; s=open(p).read(); b=s
s=s.replace("export function adjudicableSessionCounts(text: string): number[] {",
            "export function adjudicableSessionCounts(text: string): number[] {\n  return [];")
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 7. THE CANONICAL INPUT IS NOT RECORDED. A turn routed on rewritten words looks like a turn routed
#    on the client's own.
cat > "$PATCH_DIR/7.py" <<'PY'
p="server/routes.ts"; s=open(p).read(); b=s
s=s.replace(" turnCanonicalInput(message);", "")
assert s!=b, "no match"; open(p,"w").write(s)
PY

echo "RED-ON-REVERT — Cut 1. Every case below must report FAILED."
failed=0
for i in 1 2 3 4 5 6 7; do
  if ! run_case "$i" "$PATCH_DIR/$i.py"; then failed=$((failed + 1)); fi
done
if [[ $failed -ne 0 ]]; then
  echo "RED-ON-REVERT: FAILED — $failed case(s) were green, crashed, or ungraded."
  exit 1
fi
echo "RED-ON-REVERT: GREEN — 7/7 cases reached a graded red verdict."

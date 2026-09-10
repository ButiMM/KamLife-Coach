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
set -u
cd "$(dirname "$0")/.."
ACC=script/pg-interaction-truth-acceptance.ts
BACKUP=/tmp/cut1-backup

run_case () {
  local name="$1" patch="$2"
  rm -rf "$BACKUP"; mkdir -p "$BACKUP"
  cp -r server "$BACKUP/server"; cp -r shared "$BACKUP/shared"
  python3 "$patch" || { echo "  !! patch failed: $name"; rm -rf "$BACKUP"; return 1; }
  PGPASSWORD=kam psql -h 127.0.0.1 -U kam -d journeylab -q -c \
    "DO \$\$ DECLARE t text; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('__drizzle_migrations','schema_migrations') LOOP EXECUTE format('TRUNCATE TABLE %I CASCADE', t); END LOOP; END \$\$;" >/dev/null 2>&1
  local out; out="$(npx tsx "$ACC" 2>&1)"
  echo "── REVERT: $name"
  echo "   $(echo "$out" | grep -E '^pg-interaction-truth-acceptance:' | tail -1 || echo '(no verdict — crashed)')"
  echo "$out" | grep '^  FAIL' | sed 's/^/   /' | head -4
  rm -rf server shared && mv "$BACKUP/server" server && mv "$BACKUP/shared" shared
  rm -rf "$BACKUP"
}

mkdir -p /tmp/cut1p

# 1. THE REACTIVE DUPLICATE AUTHORITY COMES BACK to the floor. This is the defect proven on
#    7833ebb: the second asking of the same question got the outbound repair.
cat > /tmp/cut1p/1.py <<'PY'
p="server/outbound-authority.ts"; s=open(p).read(); b=s
s=s.replace('if (mode === "proactive" && isDuplicateOutbound(', 'if (isDuplicateOutbound(')
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 2. THE TRANSPORT STOPS FINALISING THE ROW. delivered_body, the verdict and the delivery outcome
#    all go back to null — the state the ledger was in for a month of green builds.
cat > /tmp/cut1p/2.py <<'PY'
p="server/routes/whatsapp.ts"; s=open(p).read(); b=s
s=s.replace("  const outcome = await sendParts(phone, splitMessage(out), outMedia);\n  await finalise(outcome);",
            "  await sendParts(phone, splitMessage(out), outMedia);")
s=s.replace('  if ((await shadowDoor(phone, out, "reply", "server/routes/whatsapp.ts", media)) && !isCrisisOut) {\n    await finalise("shadow");\n    return;\n  }',
            '  if ((await shadowDoor(phone, out, "reply", "server/routes/whatsapp.ts", media)) && !isCrisisOut) return;')
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 3. THE ROOT ID IS RE-MINTED PER SCOPE instead of inherited. One voice note becomes two
#    uncorrelatable interactions again, and the transport can no longer find the row.
cat > /tmp/cut1p/3.py <<'PY'
p="server/handlers/chat-log.ts"; s=open(p).read(); b=s
s=s.replace('const rootId = turnStore.getStore()?.rootId || seed || `turn-',
            'const rootId = `turn-')
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 4. THE REFUSED DRAFT IS DROPPED from the verdict. A blocked turn records the repair and nothing
#    about what the coach had actually composed.
cat > /tmp/cut1p/4.py <<'PY'
p="server/outbound-authority.ts"; s=open(p).read(); b=s
s=s.replace(', draft: out };', ' };').replace(', draft: text };', ' };')
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 5. OPPOSITE DEFECT — the duplicate rule is removed for BOTH doors. Two crons may now cover the
#    same ground on the same morning. Section 6 must catch this.
cat > /tmp/cut1p/5.py <<'PY'
p="server/outbound-authority.ts"; s=open(p).read(); b=s
s=s.replace('if (mode === "proactive" && isDuplicateOutbound(', 'if (false && isDuplicateOutbound(')
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 6. OPPOSITE DEFECT — the session-count floor stops judging. Every "must not be repaired" check in
#    section 1 would still pass while the product loses the rule that stops it overstating a
#    client's training. Section 5 must catch this.
cat > /tmp/cut1p/6.py <<'PY'
p="server/brain/reply-verifier.ts"; s=open(p).read(); b=s
s=s.replace("export function adjudicableSessionCounts(text: string): number[] {",
            "export function adjudicableSessionCounts(text: string): number[] {\n  return [];")
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 7. THE CANONICAL INPUT IS NOT RECORDED. A turn routed on rewritten words looks like a turn routed
#    on the client's own.
cat > /tmp/cut1p/7.py <<'PY'
p="server/routes.ts"; s=open(p).read(); b=s
s=s.replace(" turnCanonicalInput(message);", "")
assert s!=b, "no match"; open(p,"w").write(s)
PY

echo "RED-ON-REVERT — Cut 1. Every case below must report FAILED."
for i in 1 2 3 4 5 6 7; do run_case "$i" "/tmp/cut1p/$i.py"; done
echo "Done. Any case reporting ALL GREEN is a mechanism the acceptance does not grade."

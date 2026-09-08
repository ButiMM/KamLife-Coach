#!/usr/bin/env bash
# RED-ON-REVERT — #221 journeys 5-7, one mechanism at a time.
#
# Each mechanism is put back the way it was, ALONE, and the acceptance must go red on the checks
# that mechanism exists to hold. Anything that stays green under revert is a check that was never
# testing its mechanism, and is reported as such rather than dressed up.
set -u
cd "$(dirname "$0")/.."
ACC=script/pg-session-owner-acceptance.ts

run_case () {
  local name="$1" patch="$2"
  cp -r server /tmp/221o-server-backup
  python3 "$patch" || { echo "  !! patch failed to apply: $name"; rm -rf /tmp/221o-server-backup; return 1; }
  PGPASSWORD=kam psql -h 127.0.0.1 -U kam -d journeylab -q -c \
    "DO \$\$ DECLARE t text; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '__drizzle_migrations' LOOP EXECUTE format('TRUNCATE TABLE %I CASCADE', t); END LOOP; END \$\$;" >/dev/null 2>&1
  local out; out="$(npx tsx "$ACC" 2>&1)"
  echo "── REVERT: $name"
  echo "   $(echo "$out" | grep -E '^pg-session-owner-acceptance:' || echo '(no verdict — crashed)')"
  echo "$out" | grep '^  FAIL' | sed 's/^/   /' | head -6
  rm -rf server && mv /tmp/221o-server-backup server
}

mkdir -p /tmp/221op

# ── 1 · the header claims a programme position from the lifetime counter again ────────────────
cat > /tmp/221op/1.py <<'PY'
p = "server/handlers/misc-commands.ts"; s = open(p).read()
before = s
s = s.replace("const sessionNote = totalSessions > 0 ? ` · ${totalSessions} sessions overall` : \"\";",
              "const sessionNote = totalSessions > 0 ? ` · Session ${totalSessions + 1}` : \"\";")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 2 · the lifetime number is DELETED instead of relabelled (the opposite defect) ────────────
#
# Deleting it satisfies every position check — no number, no position claim — and silently loses
# the legacy history the counter exists to carry. Section 5b is the only thing standing between
# this cut and that "fix", so it must go red here.
cat > /tmp/221op/2.py <<'PY'
p = "server/handlers/misc-commands.ts"; s = open(p).read()
before = s
s = s.replace("const sessionNote = totalSessions > 0 ? ` · ${totalSessions} sessions overall` : \"\";",
              "const sessionNote = \"\";")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 3 · a backfill moves the programme cursor again (journey 6) ───────────────────────────────
#
# The defect P0-3 closed: "I trained on Monday" advanced TODAY's programme cursor, so the client
# was correctly told Monday was logged and silently lost today's session slot with it.
cat > /tmp/221op/3.py <<'PY'
p = "server/handlers/workout.ts"; s = open(p).read()
before = s
s = s.replace("    await applyRetroSessionState(user, [retroDate]);",
              "    await applyRetroSessionState(user, [retroDate]);\n"
              "    await db.update(users).set({ programmeDayInWeek: (user.programmeDayInWeek || 1) + 1 })\n"
              "      .where(eq(users.id, user.id));")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

echo "=============================================================================="
echo "#221 journeys 5-7 — RED ON REVERT, one mechanism at a time"
echo "=============================================================================="
run_case "the header claims a programme position from the lifetime counter"     /tmp/221op/1.py
run_case "the lifetime number is deleted rather than relabelled (opposite defect)" /tmp/221op/2.py
run_case "a backfill advances the programme cursor again"                        /tmp/221op/3.py
echo "=============================================================================="

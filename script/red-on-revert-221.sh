#!/usr/bin/env bash
# RED-ON-REVERT — #221, one mechanism at a time.
#
# A green suite proves nothing on its own: it may be green because the code is right, or because
# the checks cannot fail. Each fix is put back the way it was, ALONE, and the acceptance must go
# red on the checks that fix exists to hold. Anything that stays green under revert is a check
# that was never testing its mechanism, and is reported as such rather than dressed up.
#
# Usage:  DATABASE_URL=... bash script/red-on-revert-221.sh
set -u
cd "$(dirname "$0")/.."
ACC=script/pg-comeback-clock-acceptance.ts
TRUNC="DO \$\$ DECLARE t text; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '__drizzle_migrations' LOOP EXECUTE format('TRUNCATE TABLE %I CASCADE', t); END LOOP; END \$\$;"

run_case () {
  local name="$1" patch="$2"
  cp -r server /tmp/221-server-backup
  python3 "$patch" || { echo "  !! patch failed to apply: $name"; rm -rf /tmp/221-server-backup; return 1; }
  # Truncate before EVERY run — these suites are not isolated from each other, and treating them
  # as if they were is exactly what produced a false four-acceptance regression report on #220.
  PGPASSWORD=kam psql -h 127.0.0.1 -U kam -d journeylab -q -c "$TRUNC" >/dev/null 2>&1
  local out; out="$(npx tsx "$ACC" 2>&1)"
  echo "── REVERT: $name"
  echo "   $(echo "$out" | grep -E '^pg-comeback-clock-acceptance:' || echo '(no verdict — crashed)')"
  echo "$out" | grep '^  FAIL' | sed 's/^/   /' | head -8
  rm -rf server && mv /tmp/221-server-backup server
}

mkdir -p /tmp/221p

# ── 1 · the clock divides milliseconds again ──────────────────────────────────────────────────
cat > /tmp/221p/1.py <<'PY'
p = "server/understanding/reentry.ts"; s = open(p).read()
before = s
s = s.replace("  return Math.max(0, sastDaysBetween(at, nowMs));",
              "  return Math.max(0, Math.floor((nowMs - at) / 86_400_000));")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 2 · execution evidence never reaches the clock ────────────────────────────────────────────
cat > /tmp/221p/2.py <<'PY'
p = "server/handlers/early-commands.ts"; s = open(p).read()
before = s
s = s.replace("""    lastExecutionAt: evidence?.lastExecutionAt,
    lastWorkoutAt: evidence?.lastWorkoutAt,
""", "")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 3 · the gap is measured from contact alone again ──────────────────────────────────────────
cat > /tmp/221p/3.py <<'PY'
p = "server/handlers/early-commands.ts"; s = open(p).read()
before = s
s = s.replace("""    const gap = reentry.executedDuringAbsence && reentry.daysSinceLastExecution !== null
      ? reentry.daysSinceLastExecution
      : daysSilent;""", "    const gap = daysSilent;")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 4 · mid-absence training is filed "before you went quiet" again ───────────────────────────
cat > /tmp/221p/4.py <<'PY'
p = "server/handlers/early-commands.ts"; s = open(p).read()
before = s
s = s.replace("""        ? (reentry.trainedDuringAbsence
            ? `🏋️ Training: *${sessions}* session${sessions !== 1 ? "s" : ""} in the last 14 days — including while you were quiet 👊`
            : `🏋️ Training: *${sessions}* session${sessions !== 1 ? "s" : ""} in the 14 days before you went quiet`)""",
              """        ? `🏋️ Training: *${sessions}* session${sessions !== 1 ? "s" : ""} in the 14 days before you went quiet`""")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 5 · "executed during the absence" stops requiring evidence NEWER than contact ─────────────
#
# The opposite defect, and the one a careless fix produces: if any stored log counts, every client
# with history reads as "still going" and nobody is ever told they were away.
cat > /tmp/221p/5.py <<'PY'
p = "server/understanding/reentry.ts"; s = open(p).read()
before = s
s = s.replace("    return ms !== null && contactAt !== null && ms > contactAt + SAME_TURN_MS && ms <= nowMs;",
              "    return ms !== null;")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 6 · event ordering goes back to comparing SAST day AGES ───────────────────────────────────
#
# The first Codex P2. Day ages are equal for two events on the same date, so a morning message and
# an evening workout compare as "not newer" and the evening vanishes into the time before the gap.
cat > /tmp/221p/6.py <<'PY'
p = "server/understanding/reentry.ts"; s = open(p).read()
before = s
s = s.replace("    return ms !== null && contactAt !== null && ms > contactAt + SAME_TURN_MS && ms <= nowMs;",
              """    return ms !== null && contactAt !== null && ms <= nowMs
      && sastDaysBetween(ms, nowMs) < sastDaysBetween(contactAt, nowMs);""")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 7 · the training sentence reads the type-agnostic flag again ──────────────────────────────
#
# The second Codex P2. A meal or a step count then satisfies a claim about SESSIONS, and a client
# who ate while quiet is congratulated for training they did not do.
cat > /tmp/221p/7.py <<'PY'
p = "server/handlers/early-commands.ts"; s = open(p).read()
before = s
s = s.replace("        ? (reentry.trainedDuringAbsence", "        ? (reentry.executedDuringAbsence")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

echo "=============================================================================="
echo "#221 — RED ON REVERT, one mechanism at a time"
echo "=============================================================================="
run_case "the clock divides milliseconds again (SAST days -> elapsed days)"        /tmp/221p/1.py
run_case "execution evidence never reaches the clock"                             /tmp/221p/2.py
run_case "the gap is measured from last CONTACT alone again"                      /tmp/221p/3.py
run_case "mid-absence training is filed 'before you went quiet' again"            /tmp/221p/4.py
run_case "any stored log counts as execution during the absence (opposite defect)" /tmp/221p/5.py
run_case "event ordering compares SAST day AGES again (same-day evening is lost)"  /tmp/221p/6.py
run_case "the training sentence reads the type-agnostic execution flag again"      /tmp/221p/7.py
echo "=============================================================================="

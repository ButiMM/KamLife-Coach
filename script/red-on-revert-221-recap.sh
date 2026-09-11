#!/usr/bin/env bash
# RED-ON-REVERT — #221 journey 4, one mechanism at a time.
#
# A green suite proves nothing on its own: it may be green because the code is right, or because
# the checks cannot fail. Each mouth is put back the way it was, ALONE, and the acceptance must go
# red on the checks that mouth exists to hold.
set -u
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe
ACC=script/pg-session-recap-acceptance.ts

run_case () {
  local name="$1" patch="$2"
  cp -r server /tmp/221r-server-backup
  python3 "$patch" || { echo "  !! patch failed to apply: $name"; rm -rf /tmp/221r-server-backup; return 1; }
  if ! revert_db_reset; then
    echo "  !! database reset failed: $name"; rm -rf /tmp/221r-server-backup; return 1
  fi
  local out; out="$(npx tsx "$ACC" 2>&1)"
  echo "── REVERT: $name"
  echo "   $(echo "$out" | grep -E '^pg-session-recap-acceptance:' || echo '(no verdict — crashed)')"
  echo "$out" | grep '^  FAIL' | sed 's/^/   /' | head -6
  rm -rf server && mv /tmp/221r-server-backup server
}

mkdir -p /tmp/221rp

# ── 1 · the Progress card calls its food-day count "Days logged" again ────────────────────────
cat > /tmp/221rp/1.py <<'PY'
p = "server/handlers/misc-commands.ts"; s = open(p).read()
before = s
s = s.replace("🍽️ Food logged: *${truth.window.daysLogged}/7 days*${weightLine}",
              "📋 Days logged (7d): *${truth.window.daysLogged}/7*${weightLine}")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 2 · the 7-day breakdown calls it "Days logged" again ──────────────────────────────────────
cat > /tmp/221rp/2.py <<'PY'
p = "server/handlers/misc-commands.ts"; s = open(p).read()
before = s
s = s.replace("🍽️ Food logged: *${truth.window.daysLogged}/7 days*\\n🔥 Avg:",
              "📋 Days logged: *${truth.window.daysLogged}/7*\\n🔥 Avg:")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 3 · the count is WIDENED to include training (the tempting wrong fix) ─────────────────────
#
# The opposite defect. Making `daysLogged` count training days too would satisfy every relabelling
# check above and silently move the divisor for avgKcal/avgProtein and #203's thin-evidence
# threshold. Section 2 exists to catch exactly this, so it must go red here.
cat > /tmp/221rp/3.py <<'PY'
p = "server/day-ledger-core.ts"; s = open(p).read()
before = s
s = s.replace("  const daysLogged = perDay.length;",
              "  const daysLogged = perDay.length + 2; // pretend training days were folded in")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

echo "=============================================================================="
echo "#221 journey 4 — RED ON REVERT, one mechanism at a time"
echo "=============================================================================="
run_case "the Progress card says 'Days logged' again"                       /tmp/221rp/1.py
run_case "the 7-day breakdown says 'Days logged' again"                     /tmp/221rp/2.py
run_case "the food-day COUNT is widened to include training (opposite defect)" /tmp/221rp/3.py
echo "=============================================================================="

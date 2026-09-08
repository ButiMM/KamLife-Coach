#!/usr/bin/env bash
# RED-ON-REVERT — #234, one mechanism at a time.
#
# The point of this cut is a CLASS, so the reverts restore the class, not the pear. Each puts one
# part of the boundary back the way it was, ALONE, and the fidelity coverage must go red on the
# checks that part exists to hold.
set -u
cd "$(dirname "$0")/.."

run_case () {
  local name="$1" patch="$2"
  cp server/normalizer-fidelity.ts /tmp/234-fid-backup.ts
  python3 "$patch" || { echo "  !! patch failed to apply: $name"; cp /tmp/234-fid-backup.ts server/normalizer-fidelity.ts; return 1; }
  local out; out="$(npx tsx script/unit-tests.ts 2>&1)"
  echo "── REVERT: $name"
  echo "   $(echo "$out" | grep -E '^unit-tests: [0-9]+' || echo '(no verdict — crashed)')"
  echo "$out" | grep -E '^\s+✗' | sed 's/^/   /' | head -4
  cp /tmp/234-fid-backup.ts server/normalizer-fidelity.ts
}

mkdir -p /tmp/234p

# ── 1 · the semantic vocabulary goes back into the exemption set ──────────────────────────────
#
# The whole class at once: meal slots, days, times, activity and goal words exempt from the
# invention check again. This is the state that shipped the founder's pear.
cat > /tmp/234p/1.py <<'PY'
p = "server/normalizer-fidelity.ts"; s = open(p).read()
before = s
s = s.replace('  "gonna", "going", "will", "be", "get", "got", "just", "then", "also", "too", "about", "s",',
              '  "gonna", "going", "will", "be", "get", "got", "just", "then", "also", "too", "about", "s",\n'
              '  "breakfast", "lunch", "dinner", "supper", "snack", "meal", "today", "yesterday", "morning",\n'
              '  "afternoon", "evening", "night", "tonight", "steps", "step", "workout", "session",\n'
              '  "training", "gym", "change", "goal", "muscle", "gain", "fat", "loss", "did", "do", "done",')
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 2 · the client's NO stops being read ──────────────────────────────────────────────────────
cat > /tmp/234p/2.py <<'PY'
p = "server/normalizer-fidelity.ts"; s = open(p).read()
before = s
s = s.replace("  if (negates(orig) && !negates(canon)) {", "  if (false) {")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 3 · a canonical may ask a question the client did not ─────────────────────────────────────
cat > /tmp/234p/3.py <<'PY'
p = "server/normalizer-fidelity.ts"; s = open(p).read()
before = s
s = s.replace("  if (looksLikeQuestion(canon) && !looksLikeQuestion(orig)) {", "  if (false) {")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 4 · the gate refuses EVERYTHING (the opposite defect) ─────────────────────────────────────
#
# Tightening a brake until nothing survives passes every "must be blocked" assertion and silently
# turns the normalizer off — which is why the preserved-behaviour test exists beside the class.
cat > /tmp/234p/4.py <<'PY'
p = "server/normalizer-fidelity.ts"; s = open(p).read()
before = s
s = s.replace("  return { ok: true, reason: \"faithful\" };",
              "  return { ok: false, reason: \"refuse everything\" };")
assert s != before, "revert patch matched nothing"
open(p, "w").write(s)
PY

echo "=============================================================================="
echo "#234 — RED ON REVERT, one mechanism at a time"
echo "=============================================================================="
run_case "semantic vocabulary is exempt from the invention check again" /tmp/234p/1.py
run_case "the client's negation is no longer read"                     /tmp/234p/2.py
run_case "a canonical may invent a question"                           /tmp/234p/3.py
run_case "the gate refuses every rewrite (opposite defect)"            /tmp/234p/4.py
echo "=============================================================================="

#!/usr/bin/env bash
# RED-ON-REVERT — C15, the present client is coached.
#
# Each case restores ONE mechanism to its d92c0ce state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection, and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-present-client-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c15-revert.XXXXXX")"
FILES=(
  server/one-action.ts
  server/handlers/misc-commands.ts
  server/handlers/early-commands.ts
  server/understanding/live.ts
)

for f in "${FILES[@]}"; do cp "$f" "$WORK_ROOT/$(printf '%s' "$f" | tr '/' '_')"; done
restore_case () {
  for f in "${FILES[@]}"; do cp "$WORK_ROOT/$(printf '%s' "$f" | tr '/' '_')" "$f"; done
}
cleanup () {
  restore_case
  for f in "$WORK_ROOT"/*; do rm -f "$f"; done
  rmdir "$WORK_ROOT"
}
trap cleanup EXIT INT TERM

run_case () {
  local name="$1" file="$2" before="$3" after="$4" out verdict patched
  restore_case
  python3 - "$file" "$before" "$after" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); before = sys.argv[2]; after = sys.argv[3]
s = p.read_text(encoding="utf-8")
if before not in s:
    sys.exit(3)
p.write_text(s.replace(before, after, 1), encoding="utf-8")
PY
  patched=$?
  if [[ $patched -ne 0 ]]; then
    echo "  FAIL  $name — revert seam not found in $file; this harness is stale, the product is not"
    return 1
  fi
  if ! revert_db_reset; then echo "  FAIL  $name — database reset failed"; return 1; fi
  out="$(npx tsx "$ACC" 2>&1)"
  verdict="$(printf '%s\n' "$out" | grep '^pg-present-client-acceptance:' | tail -1 || true)"
  if [[ "$verdict" =~ FAILED ]] && printf '%s\n' "$out" | grep -q '^  FAIL'; then
    echo "  PASS  $name → $verdict"
    printf '%s\n' "$out" | grep '^  FAIL' | head -1 | sed 's/^/        /'
    return 0
  fi
  echo "  FAIL  $name — acceptance did not turn red (verdict: ${verdict:-missing})"
  return 1
}

if ! revert_db_reset; then echo "CONTROL: database reset failed"; exit 1; fi
control="$(npx tsx "$ACC" 2>&1)"
if ! printf '%s\n' "$control" | grep -q '^pg-present-client-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-present-client-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched present-client acceptance is GREEN"

failed=0

# 1. THE TRAINING MOVE IS GRADED ON THE FOOD LEDGER AGAIN. Four quiet days makes `foodSufficient`
#    false by arithmetic, so a client who ASKED what to do today has "Get today's session done."
#    downgraded into a log ask — for want of evidence about a different ledger entirely.
run_case "a session move is graded on the food ledger" server/one-action.ts \
  '    if ((futureOnlyWeigh || saysNothing || action.kind === "train") && String(action.todo || "").trim()) return action;' \
  '    if ((futureOnlyWeigh || saysNothing) && String(action.todo || "").trim()) return action;' || failed=$((failed + 1))

# 2. THE TWO CALLERS DISAGREE AGAIN. misc-commands goes back to calling oneActionCommand bare, so
#    the absence rung speaks on that path and not on the confusion path — one client, one minute,
#    two answers.
run_case "the two callers of one question disagree" server/handlers/misc-commands.ts \
  '    return await oneActionCommand(user, { atKeyboard: true, asksAboutToday: true });' \
  '    return await oneActionCommand(user);' || failed=$((failed + 1))

# 3. THE CANONICAL CLOSE DROPS A FEELING AGAIN. A turn that commits no durable fact returns early,
#    so "I'm struggling" is acknowledged and left there with no next action.
run_case "a feeling reaches no coach" server/understanding/live.ts \
  '  if (!out || (wrote.length === 0 && !opts?.coachWithoutWrite)) return out;' \
  '  if (!out || wrote.length === 0) return out;' || failed=$((failed + 1))

# 4. THE CONFUSED PATH STAPLES ITS OWN HEADER BACK ON, so one instruction is introduced twice and
#    the client reads their own name twice in four words.
run_case "two headers introduce one instruction" server/handlers/early-commands.ts \
  '    await logChat(user.id, message, action, "CONFUSED_ONE_ACTION");
    return action;' \
  '    const reply = `${firstName ? firstName + " — h" : "H"}ere'"'"'s the one that matters:\n\n${action}`;
    await logChat(user.id, message, reply, "CONFUSED_ONE_ACTION");
    return reply;' || failed=$((failed + 1))

# 5. A BID FOR COACHING STOPS COUNTING AS A REQUEST FOR TODAY'S MOVE. "I'm struggling" is not
#    phrased as a direction request, so the verdict downgrades its move back into a log ask and
#    the most explicit ask for help the product receives is answered with a demand for data.
run_case "a coaching bid is not a request for today" server/understanding/live.ts \
  '    const asksAboutToday = !!opts?.bidForCoaching
      || looksLikeDirectionRequest(clausesOf(message || "").slice(-1)[0] || message || "");' \
  '    const asksAboutToday = looksLikeDirectionRequest(clausesOf(message || "").slice(-1)[0] || message || "");' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-c15-present-client: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-c15-present-client: GREEN — 5/5 behavioral reverts caught"

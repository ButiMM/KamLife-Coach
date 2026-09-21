#!/usr/bin/env bash
# RED-ON-REVERT — C17, the follow-up that does not chase.
#
# Each case restores ONE mechanism to its b34e598 state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection, and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-followup-arrives-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/c17-revert.XXXXXX")"
FILES=(
  server/reminders.ts
  server/scheduler/jobs/reminders.ts
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
  verdict="$(printf '%s\n' "$out" | grep '^pg-followup-arrives-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-followup-arrives-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-followup-arrives-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched follow-up acceptance is GREEN"

failed=0

# 1. THE FIRING JOB STOPS ASKING. Every due return nudge fires again, including to a client who
#    came back early and has been logging since — the body measured on the base.
run_case "a returned client is chased anyway" server/scheduler/jobs/reminders.ts \
  '      if (isReturnKind((r as any).kind)' \
  '      if (false && isReturnKind((r as any).kind)' || failed=$((failed + 1))

# 2. THE READER STOPS SEEING THE LEDGERS. Same outcome by a different route, and it proves the
#    guard reads real rows rather than passing because the job never reaches it.
run_case "the ledgers are not consulted" server/reminders.ts \
  '  return Number(row?.n || 0) > 0;' \
  '  return false;' || failed=$((failed + 1))

# 3. AUTO-SYNCED STEPS COUNT AS A RETURN AGAIN. This is the Codex P1 defect restored: an away
#    client's 21:00 Shortcuts step post retires their own nudge.
run_case "an auto-synced step count retires the nudge" server/reminders.ts \
  '    + (SELECT COUNT(*) FROM ${workoutLogs} WHERE ${workoutLogs.userId} = ${userId} AND ${workoutLogs.loggedAt} >= ${since})' \
  '    + (SELECT COUNT(*) FROM step_logs WHERE user_id = ${userId} AND logged_at >= ${since})' || failed=$((failed + 1))

# 4. THE REASON IS DISCARDED AT WRITE AGAIN. Both a sick hold and a holiday book a row saying only
#    `return`, so the firing job cannot tell them apart and a sick client's meal retires a nudge
#    that promises training clearance.
run_case "the return reason is not preserved" server/reminders.ts \
  'kind: `return_${kind}` });' \
  'kind: "return" });' || failed=$((failed + 1))

# 5. EVIDENCE IS NO LONGER MATCHED TO THE REASON. The reader answers for every reason, so a sick
#    nudge is retired by eating.
run_case "evidence is not matched to the reason" server/reminders.ts \
  '  if (returnReason(kind) !== "away") return false;' \
  '  if (false) return false;' || failed=$((failed + 1))

# 6. THE ROW IS CLOSED BEFORE THE CHECK AGAIN (Codex P2). A transient failure on the evidence read
#    then deletes the nudge permanently, with nothing left pending to retry.
run_case "a failed evidence read deletes the nudge" server/scheduler/jobs/reminders.ts \
  '      if (isReturnKind((r as any).kind)
          && await hasReturnedSince(r.userId, new Date((r as any).createdAt), (r as any).kind)) {' \
  '      const _rec0 = (r as any).recurrence as Recurrence;
      if (_rec0) await advanceRecurring(r.id, nextRecurrenceTime(new Date(r.fireAt as any), _rec0));
      else await markReminderSent(r.id);
      if (isReturnKind((r as any).kind)
          && await hasReturnedSince(r.userId, new Date((r as any).createdAt), (r as any).kind)) {' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-c17-followup-arrives: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-c17-followup-arrives: GREEN — 6/6 behavioral reverts caught"

#!/usr/bin/env bash
# RED-ON-REVERT — payments: cancelling stops the money, and the money tells the truth.
#
# Each case restores ONE mechanism to its pre-fix state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-payments-cancel-truth-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/payments-revert.XXXXXX")"
FILES=(
  server/routes/payments.ts
  server/handlers/lifecycle.ts
  server/scheduler/jobs/business.ts
  migrations/0014_subscription_end_reason.sql
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
  verdict="$(printf '%s\n' "$out" | grep '^pg-payments-cancel-truth-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-payments-cancel-truth-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-payments-cancel-truth-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched payments-cancel-truth acceptance is GREEN"

failed=0

# 1. THE ITN IS HASHED IN SORTED ORDER ONLY AGAIN (629610e). A body signed the way PayFast signs
#    an ITN — fields in the order sent — is refused, and the paying client is never activated.
run_case "a real PayFast ITN is refused for its field order" server/routes/payments.ts \
  '        ["received", md5Of(fields, phpUrlencode)],' \
  '' || failed=$((failed + 1))

# 2. CANCEL NEVER REACHES PAYFAST. The pre-fix shape: the row goes inactive, and the promise is
#    made on the strength of nothing.
run_case "the cancel is never sent to PayFast" server/handlers/lifecycle.ts \
  '      const billing = await cancelPayFastSubscription(token);' \
  '      const billing = { ok: true, detail: "not sent" };' || failed=$((failed + 1))

# 3. THE PROMISE IS MADE WHATEVER PAYFAST SAID.
run_case "\"you will not be charged again\" is promised when PayFast refused" server/handlers/lifecycle.ts \
  '${billing.ok ? "and your recurring billing is cancelled' \
  '${true ? "and your recurring billing is cancelled' || failed=$((failed + 1))

# 4. A CHARGE ON THE CANCELLED SUBSCRIPTION REACTIVATES AGAIN, nulling cancelled_at.
run_case "a charge after cancellation reactivates the client" server/routes/payments.ts \
  'targetUser.subscriptionEndReason === "client_cancelled" && data.token' \
  'false && data.token' || failed=$((failed + 1))

# 5. THE GUARD STOPS ASKING WHICH SUBSCRIPTION WAS CHARGED — so a client who comes back through a
#    NEW subscription is refused too. The opposite defect: guarding the old money by locking out
#    the new.
run_case "a new subscription after a cancel is refused" server/routes/payments.ts \
  '
        && data.token === await latestPayFastToken(normalisedPhone, eventKey)) {' \
  ') {' || failed=$((failed + 1))

# 6. THE CANCEL TARGETS THE OLDEST SUBSCRIPTION, not the one the client is paying on now.
run_case "the cancel targets a subscription already ended" server/routes/payments.ts \
  '      ORDER BY processed_at DESC LIMIT 1`,' \
  '      ORDER BY processed_at ASC LIMIT 1`,' || failed=$((failed + 1))

# 7. THE API SIGNATURE LOSES ITS PASSPHRASE — PayFast would reject every cancel.
run_case "the PayFast API call is signed without the passphrase" server/routes/payments.ts \
  '  const signed: Record<string, string> = { ...headers, passphrase };' \
  '  const signed: Record<string, string> = { ...headers };' || failed=$((failed + 1))

# 8. EVERY ENDED SUBSCRIPTION IS A FAILED PAYMENT AGAIN — the client who cancelled is told
#    "your payment didn't go through".
run_case "a voluntary canceller is told their payment failed" server/scheduler/jobs/business.ts \
  'eq(users.subscriptionStatus, "inactive"), eq(users.subscriptionEndReason, "payment_lapsed"),' \
  'eq(users.subscriptionStatus, "inactive"),' || failed=$((failed + 1))

# 9. A LAPSE IS NOT RECORDED AS ONE — so the client whose card failed never hears why.
run_case "a lapsed renewal is not recorded as a lapse" server/scheduler/jobs/business.ts \
  ', subscriptionEndReason: "payment_lapsed" })' \
  ' })' || failed=$((failed + 1))

# 10. THE LIFETIME COUNT READS AS A WEEKLY CLAIM AGAIN — the truth floor replaces the cancel
#     confirmation with "ask me again".
run_case "the cancel confirmation is swallowed by the truth floor" server/handlers/lifecycle.ts \
  'the ${user.totalWorkoutsCompleted || 0} sessions you'"'"'ve done since you started are saved' \
  '${user.totalWorkoutsCompleted || 0} sessions are saved' || failed=$((failed + 1))

# 11. SAME, FOR THE LAPSE NOTICE.
run_case "the lapse notice is swallowed by the truth floor" server/scheduler/jobs/business.ts \
  '${workouts} sessions of progress since you started are saved.' \
  '${workouts} sessions of progress are saved.' || failed=$((failed + 1))

# 12. SAME, FOR THE DAY-3 WIN-BACK.
run_case "the day-3 win-back is swallowed by the truth floor" server/scheduler/jobs/business.ts \
  '${workouts} sessions with Coach K since you started.' \
  '${workouts} sessions with Coach K.' || failed=$((failed + 1))

# 13. PRE-0014 CANCELLERS ARE NOT BACKFILLED (Codex attack @ 14f70ad) — their next charge
#     reactivates them, because the guard cannot see a cancel it has no reason for.
run_case "a pre-0014 cancellation is not backfilled" migrations/0014_subscription_end_reason.sql \
  "UPDATE users u SET subscription_end_reason = 'client_cancelled'" \
  "UPDATE users u SET subscription_end_reason = u.subscription_end_reason" || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-payments-cancel-truth: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-payments-cancel-truth: GREEN — 13/13 behavioral reverts caught"

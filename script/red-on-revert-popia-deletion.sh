#!/usr/bin/env bash
# RED-ON-REVERT — #269, "delete my data" deletes the client.
#
# Each case restores ONE mechanism to its pre-fix state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which.
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-popia-deletion-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/popia-deletion-revert.XXXXXX")"
FILES=(
  server/handlers/safety.ts
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
  verdict="$(printf '%s\n' "$out" | grep '^pg-popia-deletion-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-popia-deletion-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-popia-deletion-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched popia-deletion acceptance is GREEN"

failed=0

# 1. THE ROW IS UPDATED, NOT DELETED — the pre-fix shape: no cascade fires, the life story stays.
run_case "the users row is renamed instead of deleted" server/handlers/safety.ts \
  '        await tx.delete(users).where(eq(users.id, uid));' \
  '        await tx.update(users).set({ phoneNumber: `[deleted-${uid}]` }).where(eq(users.id, uid));' || failed=$((failed + 1))

# 2. QUALITY SIGNALS KEEP THE MESSAGE TEXT — their foreign key is SET NULL, not CASCADE.
run_case "quality signals keep the client's words" server/handlers/safety.ts \
  '        await tx.execute(sql`DELETE FROM quality_signals WHERE user_id = ${uid}`);' \
  '' || failed=$((failed + 1))

# 3. THE SHADOW LOG KEEPS WHAT WE SAID TO THEM, keyed by phone.
run_case "shadow replies survive" server/handlers/safety.ts \
  '        await tx.execute(sql`DELETE FROM shadow_replies WHERE user_id = ${uid} OR phone = ${phone}`);' \
  '' || failed=$((failed + 1))

# 4. MEDIA JOBS KEEP THE PHONE.
run_case "media jobs survive" server/handlers/safety.ts \
  '        await tx.execute(sql`DELETE FROM media_jobs WHERE user_id = ${uid} OR phone_number = ${phone}`);' \
  '' || failed=$((failed + 1))

# 5. ADMIN EVENTS KEEP THE PHONE.
run_case "admin events keep the phone" server/handlers/safety.ts \
  '        await tx.execute(sql`DELETE FROM admin_events WHERE target_phone = ${phone}`);' \
  '' || failed=$((failed + 1))

# 6. BILLING IS NEVER TOUCHED — a deleted client goes on being charged, and nobody is told.
run_case "the subscription is not cancelled" server/handlers/safety.ts \
  '      const billing = token ? await cancelPayFastSubscription(token) : null;' \
  '      const billing = null as { ok: boolean; detail: string } | null; void token;' || failed=$((failed + 1))

# 7. THE COPY PROMISES WHAT PAYFAST DID NOT CONFIRM.
run_case "the reply promises no more charges regardless" server/handlers/safety.ts \
  '        : billing.ok ? "Your subscription is cancelled at PayFast' \
  '        : true ? "Your subscription is cancelled at PayFast' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-popia-deletion: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-popia-deletion: GREEN — 7/7 behavioral reverts caught"

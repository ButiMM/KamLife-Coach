#!/usr/bin/env bash
# RED-ON-REVERT — #265, an opt-out is honoured on every send path.
#
# Each case restores ONE mechanism to its pre-fix state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-opt-out-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opt-out-revert.XXXXXX")"
FILES=(
  server/handlers/safety.ts
  server/health-state.ts
  server/outbound-authority.ts
  server/twilio-interactive.ts
  server/routes/dashboard.ts
  server/routes/payments.ts
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
  verdict="$(printf '%s\n' "$out" | grep '^pg-opt-out-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-opt-out-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-opt-out-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched opt-out acceptance is GREEN"

failed=0

# 1. ONLY THE KEYWORD COUNTS AGAIN — "stop sending me messages" is answered with a nag.
run_case "a natural-language opt-out is not recognised" server/handlers/safety.ts \
  '|| /\b(?:stop|quit)\s+(?:sending|messaging|texting|contacting|whatsapp(?:ing)?)\s+me\b' \
  '|| /\bxq265\b' || failed=$((failed + 1))

# 2. A TIMED REQUEST BECOMES A PERMANENT OPT-OUT — "stop messaging me for 2 weeks" never resumes.
run_case "a request with a length is treated as a permanent opt-out" server/handlers/safety.ts \
  '    && !/\b\d+\s*(?:days?|weeks?|months?)\b' \
  '    && !/\bxq265\b' || failed=$((failed + 1))

# 3. THE OPT-OUT IS NOT RECORDED — the reply says "No more messages", nothing holds it.
run_case "the opt-out is not recorded" server/handlers/safety.ts \
  'const saved = !!ou && await setOptOut(ou).then(' \
  'const saved = !!ou && await Promise.resolve().then(' || failed=$((failed + 1))

# 4. THE BOUNDARY DOES NOT READ IT — every job, alert and recovery message goes out again.
run_case "the proactive send boundary ignores the opt-out" server/outbound-authority.ts \
  '  if (mode === "proactive" && isOptedOut(recipientUser)) {' \
  '  if (false) {' || failed=$((failed + 1))

# 5. START DOES NOT END IT — the client asks to come back and stays silenced.
run_case "START leaves the opt-out in place" server/health-state.ts \
  '  if (!/(?:paused_until|opted_out):\d{4}-\d{2}-\d{2}/.test(notes)) return false;
  const cleaned = notes.replace(/\s*\|?\s*(?:paused_until|opted_out):\d{4}-\d{2}-\d{2}/g, "").trim();' \
  '  if (!/paused_until:\d{4}-\d{2}-\d{2}/.test(notes)) return false;
  const cleaned = notes.replace(/\s*\|?\s*paused_until:\d{4}-\d{2}-\d{2}/g, "").trim();' || failed=$((failed + 1))

# 6. THE PROACTIVE BUTTON DOOR IGNORES IT — the evening "training tonight?" still arrives.
run_case "proactive buttons ignore the opt-out" server/twilio-interactive.ts \
  '  if (sendOpts?.proactive) {' \
  '  if (false) {' || failed=$((failed + 1))

# 7. THE BROADCAST BYPASSES THE DOOR — straight past the boundary, as it used to.
run_case "the dashboard broadcast bypasses the send boundary" server/routes/dashboard.ts \
  '          const outcome = await sendWhatsApp(u.phoneNumber, broadcastMsg);' \
  '          const outcome = "sent" as string;' || failed=$((failed + 1))

# 8. THE PAYMENT WEBHOOK MESSAGES AN OPTED-OUT PAYER.
run_case "the payment webhook ignores the opt-out" server/routes/payments.ts \
  '      const fromNum = !isOptedOut(targetUser) && process.env.TWILIO_WHATSAPP_NUMBER ? "set" : "";' \
  '      const fromNum = process.env.TWILIO_WHATSAPP_NUMBER ? "set" : "";' || failed=$((failed + 1))

# 9. A TOPIC IS READ AS THE CHANNEL (Codex @ 7716559) — "messages about calories, just send my
#    workouts" opts the client out of everything.
run_case "a topic refusal opts the client out" server/handlers/safety.ts \
  '|\b(?:messages?|messaging|texting|sending|contacting|whatsapp(?:ing)?|reminders?)\s+(?:me\s+)?(?:about|on|regarding)\b|\b(?:just|only)\s+(?:send|keep)\b|\bexcept\b|\bbut\s+(?:keep|still|send)\b/i.test(m);' \
  '/i.test(m);' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-opt-out: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-opt-out: GREEN — 9/9 behavioral reverts caught"

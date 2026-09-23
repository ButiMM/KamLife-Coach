#!/usr/bin/env bash
# RED-ON-REVERT — #266, pregnancy and disordered eating are routed before any reply.
#
# Each case restores ONE mechanism to its pre-fix state and requires a GRADED FAILED ASSERTION.
# A crash is not a detection and a seam that no longer exists is a stale harness rather than an
# unguarded product — both fail, and the message says which (learned on #92, 2026-09-15).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe

ACC=script/pg-safety-routing-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/safety-routing-revert.XXXXXX")"
FILES=(
  server/life-context.ts
  server/handlers/safety.ts
  server/safety-detection.ts
  server/outbound-authority.ts
  server/onboarding.ts
  server/handlers/chat-log.ts
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
  verdict="$(printf '%s\n' "$out" | grep '^pg-safety-routing-acceptance:' | tail -1 || true)"
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
if ! printf '%s\n' "$control" | grep -q '^pg-safety-routing-acceptance: GREEN'; then
  echo "CONTROL: FAILED — untouched acceptance is not green"
  printf '%s\n' "$control" | grep -E '^  FAIL|^pg-safety-routing-acceptance:' | head -5
  exit 1
fi
echo "CONTROL: untouched safety-routing acceptance is GREEN"

failed=0

# 1. "MAKING myself throw up" falls to the food path again (AUDIT.md Trace 6).
run_case "a purging disclosure in the present continuous is missed" server/life-context.ts \
  '(?:make|makes|making|made)\s+myself\s+(?:sick|throw\s+up|vomit|puke)' \
  'make\s+myself\s+(?:sick|throw\s+up|vomit)' || failed=$((failed + 1))

# 2. A FIRST-PERSON PREGNANCY IS NOT READ — Trace 3's question goes to the totals branch.
run_case "\"I'm pregnant\" is not recognised" server/life-context.ts \
  're: /\b(?:(?:i'"'"'?m|i\s+am)\s+(?:currently\s+|now\s+)?(?:\d{1,2}' \
  're: /\b(?:(?:xq266)\s+(?:currently\s+|now\s+)?(?:\d{1,2}' || failed=$((failed + 1))

# 3. THE CONTEXT IS NOT RECORDED — a 7-day quiet window, then the targets resume.
run_case "a withheld context is not recorded durably" server/handlers/safety.ts \
  'if (lifeUser?.id && (life.context === "pregnancy" || life.context === "disordered_eating")) {' \
  'if (false) {' || failed=$((failed + 1))

# 4. THE FLOOR DOES NOT WITHHOLD — briefs, cards and model replies carry the target again.
run_case "the send boundary lets a target through to a withheld client" server/outbound-authority.ts \
  '  if (withheld && !body.includes(NUMBERS_PAUSED)' \
  '  if (false && !body.includes(NUMBERS_PAUSED)' || failed=$((failed + 1))

# 5. THE PROMISE CANNOT BE DELIVERED AS WRITTEN — the floor catches its own sentence.
run_case "the disclosure reply is caught by its own rule" server/outbound-authority.ts \
  '  if (withheld && !body.includes(NUMBERS_PAUSED)' \
  '  if (withheld' || failed=$((failed + 1))

# 6. A REFUSED TARGET BECOMES THE STALL — "ask me again" instead of the careful referral.
run_case "a withheld refusal answers with the generic stall" server/outbound-authority.ts \
  'text: verdict.repair ?? REACTIVE_OUTBOUND_REPAIR' \
  'text: REACTIVE_OUTBOUND_REPAIR' || failed=$((failed + 1))

# 7. NO PERSON IS TOLD — the disordered-eating escalation rule is gone.
run_case "a disordered-eating disclosure flags nobody" server/safety-detection.ts \
  '  if (readLifeContext(message)?.context === "disordered_eating")' \
  '  if (false && readLifeContext(message)?.context === "disordered_eating")' || failed=$((failed + 1))

# 8. INSULIN OMISSION LOSES ITS DOCTOR-TODAY LINE.
run_case "insulin omission is answered without the doctor-today line" server/life-context.ts \
  '${read.insulin ? `Anything about your insulin' \
  '${false ? `Anything about your insulin' || failed=$((failed + 1))

# 9. ONBOARDING HAS NO PREGNANT ANSWER — the menu's "1" and "Yes, I'm pregnant" become postpartum.
run_case "onboarding records a pregnancy as postpartum" server/onboarding.ts \
  '    if (/^1\b/.test(lower) || /\bpregnan/.test(lower) || user.lifeSituation === "pregnant") {' \
  '    if (false) {' || failed=$((failed + 1))

# 10. A TYPOGRAPHIC APOSTROPHE DEFEATS EVERY PATTERN (Codex attack @ 8e4f231) — "I’m pregnant"
#     from an iPhone goes to the totals branch and gets the target.
run_case "\"I’m pregnant\" with a smart apostrophe is missed" server/life-context.ts \
  '  const s = (message || "").trim().replace(/[\u2018\u2019\u02bc]/g, "'"'"'");' \
  '  const s = (message || "").trim();' || failed=$((failed + 1))

# 11. A THIRD PERSON IS READ AS THE CLIENT (Codex review @ 8e4f231) — "My sister is currently
#     pregnant" withholds the client's own targets.
run_case "\"currently pregnant\" without a first-person subject is the client's pregnancy" server/life-context.ts \
  're: /\b(?:(?:i'"'"'?m|i\s+am)\s+(?:currently\s+|now\s+)?' \
  're: /\b(?:(?:i'"'"'?m|i\s+am|currently)\s+(?:currently\s+|now\s+)?' || failed=$((failed + 1))

# 12. QUIT LANGUAGE HIDES A DISCLOSURE FROM THE OWNER (Codex review @ 8e4f231).
run_case "a quit moment suppresses the pregnancy / disordered-eating read" server/life-context.ts \
  '    if (quit && p.context !== "disordered_eating" && p.context !== "pregnancy") continue;' \
  '    if (quit) continue;' || failed=$((failed + 1))

# 13. …AND THE QUIT SAVE ANSWERS FIRST.
run_case "the quit save answers a safety disclosure" server/handlers/safety.ts \
  '  if (looksLikeQuitMoment(message) && !safetyFirst) {' \
  '  if (looksLikeQuitMoment(message)) {' || failed=$((failed + 1))

# 14. A PROTEIN / MACRO TARGET REACHES A WITHHELD CLIENT (Codex review @ 8e4f231).
run_case "a protein target passes the withheld floor" server/outbound-authority.ts \
  '|\b(?:calories|kcal|protein|carbs?|fat|macros?)\s*[:=]?\s*\*?\d|\b\d{2,4}\s*g\b|\bprotein\s+(?:target|goal)\b|\b(?:target|goal)\s+weight\b|\b\d{2,3}(?:[.,]\d+)?\s*kg\b/i.test(body)) {' \
  '/i.test(body)) {' || failed=$((failed + 1))

# 15. AN OPEN CASE SWALLOWS THE URGENT ONE (Codex review @ 8e4f231).
run_case "an unrelated open escalation absorbs a disordered-eating disclosure" server/handlers/chat-log.ts \
  '    if (open.some(r => r.reason === esc.reason) || (open.length > 0 && esc.priority !== "urgent")) return;' \
  '    if (open.length > 0) return;' || failed=$((failed + 1))

restore_case
if [[ $failed -ne 0 ]]; then
  echo "red-on-revert-safety-routing: FAILED — $failed mechanism(s) unguarded"
  exit 1
fi
echo "red-on-revert-safety-routing: GREEN — 15/15 behavioral reverts caught"

#!/usr/bin/env bash
# RED-ON-REVERT — Cut 2, the clock may not name a meal the client did not name.
#
# Each case restores exactly ONE of the removed inventions and re-runs the acceptance. A case that
# stays green is a check that grades nothing.
#
# Cases 1-3 are the three answers extractMealLabel gave when the client had said nothing: the send
# clock, the calorie count, and a time they had typed. Cases 4-5 are the two OTHER write paths that
# each carried their own copy of the clock, and which would have quietly overruled a null from the
# owner. Case 6 is the laundering route — a slot invented for the record, then spoken back to the
# client as the phrase that would store it again. Case 9 is the repeat path storing the slot of the
# meal that was COPIED FROM, which is a statement about a different plate at a different hour.
#
# CASE 3 IS WHY THIS FILE EXISTS. It was GREEN on the first run: the acceptance had no fixture
# carrying a typed time, so the caption-time invention could have been restored with every check
# still passing. Section 2b was written because this script said so, not the other way round.
#
# Cases 7 and 8 are OPPOSITE-DEFECT controls. They do not restore anything this cut removed; they
# break what it must NOT have broken — a named meal keeping its name, and the food being logged at
# all. A build that simply stored null for everything, or stopped logging food, would satisfy every
# check in sections 1-3 and is the cheapest wrong way to pass this cut.
set -uo pipefail
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/revert-db.sh"
revert_db_require_safe
ACC=script/pg-meal-slot-truth-acceptance.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cut2-revert.XXXXXX")"
BACKUP="$WORK_ROOT/backup"
PATCH_DIR="$WORK_ROOT/patches"

restore_case () {
  if [[ -d "$BACKUP/server" ]]; then
    rm -rf server
    mv "$BACKUP/server" server
  fi
  rm -rf "$BACKUP"
}

cleanup () {
  restore_case
  rm -rf "$WORK_ROOT"
}
trap cleanup EXIT INT TERM

run_case () {
  local name="$1" patch="$2"
  local out status verdict
  restore_case
  mkdir -p "$BACKUP"
  cp -a server "$BACKUP/server"
  if ! python3 "$patch"; then
    echo "  !! patch failed: $name"
    restore_case
    return 1
  fi
  if ! revert_db_reset; then
    echo "  !! database reset failed: $name"
    restore_case
    return 1
  fi
  out="$(npx tsx "$ACC" 2>&1)"
  status=$?
  verdict="$(printf '%s\n' "$out" | grep -E '^pg-meal-slot-truth-acceptance:' | tail -1 || true)"
  echo "── REVERT: $name"
  echo "   ${verdict:-'(no verdict — crashed)'}"
  printf '%s\n' "$out" | grep '^  FAIL' | sed 's/^/   /' | head -4 || true
  restore_case
  if [[ $status -eq 0 ]]; then
    echo "  !! acceptance stayed green: $name"
    return 1
  fi
  if [[ ! "$verdict" =~ ^pg-meal-slot-truth-acceptance:\ [1-9][0-9]*\ FAILED$ ]]; then
    echo "  !! acceptance did not reach a graded red verdict: $name (exit $status)"
    return 1
  fi
}

mkdir -p "$PATCH_DIR"

# 1. THE SEND CLOCK NAMES THE MEAL AGAIN — the defect itself. A client who said nothing gets
#    breakfast at 06:00, lunch at 13:00 and a night meal at 22:00, written to their record.
cat > "$PATCH_DIR/1.py" <<'PY'
p="server/handlers/food-context.ts"; s=open(p).read(); b=s
s=s.replace('import { explicitMealSlot } from "../understanding/actions";',
            'import { explicitMealSlot } from "../understanding/actions";\n'
            'import { slotFromSastHour as _clock } from "../utils";\n'
            'const _slot = (m: string, at?: Date, k?: number) => explicitMealSlot(m)\n'
            '  || _clock(at, { substantial: (k ?? 0) >= 300 });')
s=s.replace("""      const firstSegLabel = mealSegments.find(s => s.label)?.label
        || explicitMealSlot(message);""",
            """      const firstSegLabel = mealSegments.find(s => s.label)?.label
        || _slot(message, undefined, totalCals);""")
assert s!=b and "_slot(message, undefined, totalCals)" in s, "no match"; open(p,"w").write(s)
PY

# 2. THE CALORIE COUNT NAMES THE MEAL AGAIN — the route the 22:00 pear actually took. A light log
#    becomes somebody's "snack" because of its kcal, not because they said so.
cat > "$PATCH_DIR/2.py" <<'PY'
p="server/handlers/food-context.ts"; s=open(p).read(); b=s
s=s.replace('import { explicitMealSlot } from "../understanding/actions";',
            'import { explicitMealSlot } from "../understanding/actions";\n'
            'const _slot = (m: string, k?: number, pr?: number) => explicitMealSlot(m)\n'
            '  || ((k != null && k < 250 && (pr ?? 0) <= 4) ? "snack" : null);')
s=s.replace("""      const firstSegLabel = mealSegments.find(s => s.label)?.label
        || explicitMealSlot(message);""",
            """      const firstSegLabel = mealSegments.find(s => s.label)?.label
        || _slot(message, totalCals, Math.round(totalProtein));""")
assert s!=b and "_slot(message, totalCals" in s, "no match"; open(p,"w").write(s)
PY

# 3. A TYPED TIME IS READ AS A MEAL NAME AGAIN — slotFromCaptionTime, restored inline. "had this at
#    1pm" becomes lunch; the client named an hour, not a meal.
cat > "$PATCH_DIR/3.py" <<'PY'
p="server/handlers/food-context.ts"; s=open(p).read(); b=s
s=s.replace('import { explicitMealSlot } from "../understanding/actions";',
            'import { explicitMealSlot } from "../understanding/actions";\n'
            'const _caption = (m: string): string | null => {\n'
            '  const t = (m || "").toLowerCase().match(/\\b(\\d{1,2})\\s*(am|pm)\\b/);\n'
            '  if (!t) return null;\n'
            '  let h = parseInt(t[1], 10);\n'
            '  if (t[2] === "pm" && h < 12) h += 12;\n'
            '  return h <= 11 ? "breakfast" : h <= 15 ? "lunch" : "dinner";\n'
            '};\n'
            'const _slot = (m: string) => explicitMealSlot(m) || _caption(m);')
s=s.replace("""      const firstSegLabel = mealSegments.find(s => s.label)?.label
        || explicitMealSlot(message);""",
            """      const firstSegLabel = mealSegments.find(s => s.label)?.label
        || _slot(message);""")
assert s!=b and "|| _slot(message);" in s, "no match"; open(p,"w").write(s)
PY

# 4. THE PHOTO PATH GETS ITS OWN CLOCK BACK. Both media.ts writes read
#    `extractMealLabel(...) || slotFromSastHour(photoLoggedAt)` — a null from the owner was
#    overruled one character later, so fixing only food-context would have changed nothing here.
cat > "$PATCH_DIR/4.py" <<'PY'
p="server/handlers/media.ts"; s=open(p).read(); b=s
s=s.replace('import { explicitMealSlot } from "../understanding/actions";',
            'import { explicitMealSlot } from "../understanding/actions";\n'
            'import { slotFromSastHour } from "../utils";')
s=s.replace('const photoLabel = explicitMealSlot(message || "");',
            'const photoLabel = explicitMealSlot(message || "") || slotFromSastHour(photoLoggedAt);')
assert s!=b and "|| slotFromSastHour(photoLoggedAt)" in s, "no match"; open(p,"w").write(s)
PY

# 5. THE REPEAT TARGET IS NAMED BY THE CLOCK AGAIN. "I had the same as my lunch" said at 19:10
#    stored the copy as the client's "dinner" — a slot they never used, from the send hour.
cat > "$PATCH_DIR/5.py" <<'PY'
p="server/meal-select.ts"; s=open(p).read(); b=s
s=s.replace('import { parseMealDate }', 'import { slotFromSastHour } from "./utils";\nimport { parseMealDate }')
if "slotFromSastHour" not in s:
    s = 'import { slotFromSastHour } from "./utils";\n' + s
s=s.replace("    : sameAsMealM ? null", "    : sameAsMealM ? slotFromSastHour()")
assert s!=b and "sameAsMealM ? slotFromSastHour()" in s, "no match"; open(p,"w").write(s)
PY

# 6. THE INVENTION IS LAUNDERED THROUGH THE CLIENT. findDuplicateMealToday returns "lunch" for a
#    row that has no slot, and the photo-duplicate reply tells them to say "same as lunch" — which
#    would then store the copy as lunch. A guess, spoken back until it becomes a fact.
cat > "$PATCH_DIR/6.py" <<'PY'
p="server/handlers/food-scanner.ts"; s=open(p).read(); b=s
s=s.replace('slot: (r.mealLabel || "").toString(),', 'slot: (r.mealLabel || "lunch").toString(),')
assert s!=b, "no match"; open(p,"w").write(s)
p2="server/handlers/food-context.ts"; s2=open(p2).read(); b2=s2
s2=s2.replace("        || explicitMealSlot(message);", '        || "lunch";')
assert s2!=b2, "no match (food-context)"; open(p2,"w").write(s2)
PY

# 7. OPPOSITE DEFECT — the client names the meal and it is thrown away. Every check in sections 1-3
#    still passes, because null is what they assert. Section 4 is the only thing standing between
#    this cut and a product that has simply stopped recording which meal anything was.
cat > "$PATCH_DIR/7.py" <<'PY'
p="server/understanding/actions.ts"; s=open(p).read(); b=s
s=s.replace('export function explicitMealSlot(msg: string): "breakfast" | "lunch" | "dinner" | "snack" | null {',
            'export function explicitMealSlot(msg: string): "breakfast" | "lunch" | "dinner" | "snack" | null {\n  if (msg) return null;')
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 8. OPPOSITE DEFECT — the meal stops being logged at all. A row that never exists has no invented
#    slot either, which is the other cheap way to be green on a cut about what gets stored.
cat > "$PATCH_DIR/8.py" <<'PY'
p="server/day-ledger.ts"; s=open(p).read(); b=s
s=s.replace("export async function commitFoodLog(params: CommitFoodLogParams): Promise<CommitFoodLogResult> {",
            "export async function commitFoodLog(params: CommitFoodLogParams): Promise<CommitFoodLogResult> {\n"
            "  if (params) return { ok: true, runningCals: 0, runningProtein: 0, prevCals: 0 } as any;")
assert s!=b, "no match"; open(p,"w").write(s)
PY

# 9. THE REPEAT PATH STORES THE SOURCE'S SLOT AGAIN. "I had the same as my lunch" at 19:10 named
#    the meal they COPIED FROM; the row it writes is a different plate, hours later. Restoring the
#    fallback chain records a second "lunch" and tells the client "*Lunch logged*".
cat > "$PATCH_DIR/9.py" <<'PYEOF'
p="server/handlers/meal-repeat.ts"; s=open(p).read(); b=s
s=s.replace("      mealLabel: targetLabel || null,   // only what they called THIS meal (Cut 2)",
            "      mealLabel: targetLabel || sourceHint || match.mealLabel || null,")
s=s.replace('    const labelDisplay = (targetLabel || "Meal").replace(/\b\w/g, c => c.toUpperCase());',
            '    const labelDisplay = (targetLabel || sourceHint || match.mealLabel || "Meal").replace(/\b\w/g, c => c.toUpperCase());')
assert s!=b and "targetLabel || sourceHint || match.mealLabel || null," in s, "no match"; open(p,"w").write(s)
PYEOF

echo "RED-ON-REVERT — Cut 2. Every case below must report FAILED."
failed=0
for i in 1 2 3 4 5 6 7 8 9; do
  if ! run_case "$i" "$PATCH_DIR/$i.py"; then failed=$((failed + 1)); fi
done
if [[ $failed -ne 0 ]]; then
  echo "RED-ON-REVERT: FAILED — $failed case(s) were green, crashed, or ungraded."
  exit 1
fi
echo "RED-ON-REVERT: GREEN — 9/9 cases reached a graded red verdict."

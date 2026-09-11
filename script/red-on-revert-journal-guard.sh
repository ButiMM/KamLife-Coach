#!/usr/bin/env bash
# RED-ON-REVERT — the migration journal guard. One rule at a time.
#
# The guard this exercises exists because `npm run db:migrate` printed "migrations applied
# successfully" and silently did not run 0013 — drizzle orders by the journal's `when`, and 0013
# had been stamped behind 0012. Nothing failed. Nothing warned. The four columns simply were not
# there.
#
# So every rule below must be able to turn the build red on its own. A rule that cannot is a
# comment, and a comment would not have caught the thing that actually happened.
#
# Case 1 is the EXACT defect: a timestamp behind its predecessor.
# Cases 2-5 are the other four ways the journal can lie about what will run.
# Case 7 proves the unique-index rule the order names explicitly.
# Cases 8-11 are the FAIL-CLOSED holes: a deleted journal skipped every rule; a missing or
# non-numeric `when` evaded the monotonic comparison; and two valid tags could be swapped
# because membership was checked but ORDER was not. All three passed the first version.
# Cases 12-13 close the last two: a journal of `null` is VALID JSON and silenced every rule,
# and the NNNN_ exemption was a shape test, so any future unnumbered file would inherit it.
# The CONTROL at the end: the unmodified tree must pass, or every case above is meaningless.
#
# No database is required — the guard reads files only, which is why it can run in any job.
set -uo pipefail
cd "$(dirname "$0")/.."

GUARD=script/check-schema-safety.ts
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/journal-revert.XXXXXX")"
BACKUP="$WORK_ROOT/migrations"
PATCH_DIR="$WORK_ROOT/patches"

restore () { if [[ -d "$BACKUP" ]]; then rm -rf migrations && mv "$BACKUP" migrations; fi; }
cleanup () { restore; rm -rf "$WORK_ROOT"; }
trap cleanup EXIT INT TERM

run_case () {
  local name="$1" patch="$2"
  local out status
  restore
  cp -a migrations "$BACKUP"
  if ! python3 "$patch"; then echo "  !! patch failed: $name"; restore; return 1; fi
  out="$(npx tsx "$GUARD" 2>&1)"; status=$?
  echo "── BREAK: $name"
  printf '%s\n' "$out" | grep -E "schema safety|✗" | sed 's/^/   /' | head -3
  restore
  if [[ $status -eq 0 ]]; then echo "  !! guard stayed green: $name"; return 1; fi
}

mkdir -p "$PATCH_DIR"

# 1. THE EXACT DEFECT — a migration stamped behind its predecessor. drizzle reports it applied and
#    never runs it; the columns never appear; the deploy says success.
cat > "$PATCH_DIR/1.py" <<'PY'
import json
p="migrations/meta/_journal.json"; d=json.load(open(p))
d["entries"][-1]["when"] = d["entries"][-2]["when"] - 1000
json.dump(d, open(p,"w"), indent=2)
PY

# 2. Equal timestamps — the same ambiguity, one step subtler, and "strictly increasing" is the
#    only phrasing that catches it.
cat > "$PATCH_DIR/2.py" <<'PY'
import json
p="migrations/meta/_journal.json"; d=json.load(open(p))
d["entries"][-1]["when"] = d["entries"][-2]["when"]
json.dump(d, open(p,"w"), indent=2)
PY

# 3. A gap in the indexes — two authors edited the journal without seeing each other.
cat > "$PATCH_DIR/3.py" <<'PY'
import json
p="migrations/meta/_journal.json"; d=json.load(open(p))
d["entries"][-1]["idx"] += 5
json.dump(d, open(p,"w"), indent=2)
PY

# 4. A duplicated tag — ambiguous about which file was applied.
cat > "$PATCH_DIR/4.py" <<'PY'
import json
p="migrations/meta/_journal.json"; d=json.load(open(p))
last = dict(d["entries"][-1]); last["idx"] = len(d["entries"]); last["when"] = last["when"] + 1000
d["entries"].append(last)
json.dump(d, open(p,"w"), indent=2)
PY

# 5. A numbered migration committed with no journal entry — `db:migrate` will never run it, which
#    is the same silent skip arriving from the other direction.
cat > "$PATCH_DIR/5.py" <<'PY'
open("migrations/0099_orphan_migration.sql","w").write(
    "-- red-on-revert fixture: a numbered migration deliberately absent from the journal\n"
    "ALTER TABLE turn_ledger ADD COLUMN IF NOT EXISTS red_on_revert_fixture TEXT;\n")
PY

# 6. A journal entry naming a SQL file that does not exist.
cat > "$PATCH_DIR/6.py" <<'PY'
import json
p="migrations/meta/_journal.json"; d=json.load(open(p))
last = d["entries"][-1]
d["entries"].append({"idx": len(d["entries"]), "version": last["version"],
                     "when": last["when"] + 1000, "tag": "0100_file_that_does_not_exist",
                     "breakpoints": True})
json.dump(d, open(p,"w"), indent=2)
PY

# 7. A DUPLICATED INDEX with tags left unique. Contiguity already implies uniqueness, but
#    "implied" is not proof — this demonstrates the rule the order names explicitly, so nobody has
#    to reason about whether it holds.
cat > "$PATCH_DIR/7.py" <<'PY2'
import json
p="migrations/meta/_journal.json"; d=json.load(open(p))
d["entries"][-1]["idx"] = d["entries"][-2]["idx"]
json.dump(d, open(p,"w"), indent=2)
PY2

# 8. THE JOURNAL IS DELETED ENTIRELY. The first version of this guard opened with
#    `if (existsSync(...))`, so removing the file skipped every rule below it and the build stayed
#    green. A guard that can be silenced by deleting its subject is not a guard.
cat > "$PATCH_DIR/8.py" <<'PY2'
import os
os.remove("migrations/meta/_journal.json")
PY2

# 9. `when` REMOVED from an entry. `undefined <= undefined` is false, so the monotonic rule passed
#    while the ordering it claims to enforce was undefined.
cat > "$PATCH_DIR/9.py" <<'PY2'
import json
p="migrations/meta/_journal.json"; d=json.load(open(p))
del d["entries"][-1]["when"]
json.dump(d, open(p,"w"), indent=2)
PY2

# 10. `when` PRESENT BUT NON-NUMERIC. String comparison would silently "work" for some values and
#     not others; the field must be a finite number or the ordering means nothing.
cat > "$PATCH_DIR/10.py" <<'PY2'
import json
p="migrations/meta/_journal.json"; d=json.load(open(p))
d["entries"][-1]["when"] = "1789061218646"
json.dump(d, open(p,"w"), indent=2)
PY2

# 11. TWO VALID NUMBERED TAGS SWAPPED. Indexes stay contiguous, timestamps stay strictly
#     increasing, tags stay unique, every file still exists — every other rule passes. Only the
#     ORDER rule can catch it, and without that rule drizzle and the boot runner would apply the
#     same commit's migrations in different orders.
cat > "$PATCH_DIR/11.py" <<'PY2'
import json, re
p="migrations/meta/_journal.json"; d=json.load(open(p))
nums=[i for i,e in enumerate(d["entries"]) if re.match(r"^\d{4}_", e.get("tag",""))]
i,j = nums[-2], nums[-1]
d["entries"][i]["tag"], d["entries"][j]["tag"] = d["entries"][j]["tag"], d["entries"][i]["tag"]
json.dump(d, open(p,"w"), indent=2)
PY2

# 12. THE JOURNAL REPLACED WITH JSON `null`. `JSON.parse("null")` SUCCEEDS, so the file is valid
#     JSON describing no migrations at all. The previous version tested `journal && ...`, which is
#     falsy for null, so every rule below was skipped and the build stayed green — the whole guard
#     silenced by four characters. `false`, `0` and `""` are the same hole.
cat > "$PATCH_DIR/12.py" <<'PY2'
open("migrations/meta/_journal.json","w").write("null")
PY2

# 13. A HARMLESS NEW UNNUMBERED MIGRATION. It looks like the two grandfathered legacy files, so a
#     shape-based exemption would wave it through — and an unnumbered file is checked for journal
#     membership, ordering and file existence by nothing at all. The exemption must be two exact
#     names, not a pattern, or it becomes a bypass for every future migration.
cat > "$PATCH_DIR/13.py" <<'PY2'
open("migrations/add_a_harmless_looking_thing.sql","w").write(
    "-- red-on-revert fixture: an unnumbered migration that must NOT inherit the legacy exemption\n"
    "ALTER TABLE turn_ledger ADD COLUMN IF NOT EXISTS red_on_revert_unnumbered TEXT;\n")
PY2

echo "RED-ON-REVERT — migration journal guard. Every case below must report FAILED."
failed=0
run_case "1 (when behind its predecessor — the real defect)" "$PATCH_DIR/1.py" || failed=$((failed+1))
run_case "2 (equal timestamps)"                              "$PATCH_DIR/2.py" || failed=$((failed+1))
run_case "3 (index gap)"                                     "$PATCH_DIR/3.py" || failed=$((failed+1))
run_case "4 (duplicate tag)"                                 "$PATCH_DIR/4.py" || failed=$((failed+1))
run_case "5 (numbered migration absent from journal)"        "$PATCH_DIR/5.py" || failed=$((failed+1))
run_case "6 (journal entry with no SQL file)"                "$PATCH_DIR/6.py" || failed=$((failed+1))
run_case "7 (duplicate index, tags still unique)"           "$PATCH_DIR/7.py" || failed=$((failed+1))
run_case "8 (journal deleted entirely)"                     "$PATCH_DIR/8.py" || failed=$((failed+1))
run_case "9 (when field removed)"                           "$PATCH_DIR/9.py" || failed=$((failed+1))
run_case "10 (when present but non-numeric)"                "$PATCH_DIR/10.py" || failed=$((failed+1))
run_case "11 (two valid numbered tags swapped)"             "$PATCH_DIR/11.py" || failed=$((failed+1))
run_case "12 (journal replaced with JSON null)"             "$PATCH_DIR/12.py" || failed=$((failed+1))
run_case "13 (new unnumbered migration file)"               "$PATCH_DIR/13.py" || failed=$((failed+1))

# CONTROL — the unmodified tree must pass. Without this every red above could come from a guard
# that simply always fails, and the whole script would grade nothing.
echo "── CONTROL: the committed journal, unmodified"
if npx tsx "$GUARD" >/dev/null 2>&1; then
  echo "   schema safety: OK — the real journal passes"
else
  echo "   !! the committed journal FAILS its own guard"; failed=$((failed+1))
fi

if [[ $failed -ne 0 ]]; then
  echo "RED-ON-REVERT: FAILED — $failed case(s) did not behave as required."
  exit 1
fi
echo "RED-ON-REVERT: GREEN — 13/13 breakages caught, and the real journal passes."

#!/usr/bin/env bash
# RED-ON-REVERT — #220, one mechanism at a time.
#
# A green suite proves nothing on its own: it may be green because the code is right, or because
# the checks cannot fail. So each fix is put back the way it was, ALONE, and the acceptance must
# go red on the specific checks that fix exists to hold. Anything that stays green under revert is
# a check that was never testing its mechanism.
#
# Usage:  DATABASE_URL=... bash script/red-on-revert-220.sh
set -u
cd "$(dirname "$0")/.."
ACC=script/pg-restriction-consistency-acceptance.ts

run_case () {                       # run_case <name> <python-patch-heredoc-file>
  local name="$1" patch="$2"
  cp -r server /tmp/220-server-backup
  python3 "$patch" || { echo "  !! patch failed to apply: $name"; rm -rf /tmp/220-server-backup; return 1; }
  local out; out="$(npx tsx "$ACC" 2>&1)"
  local verdict; verdict="$(echo "$out" | grep -E '^pg-restriction-consistency-acceptance:' || echo '(no verdict — crashed)')"
  echo "── REVERT: $name"
  echo "   $verdict"
  echo "$out" | grep '^  FAIL' | sed 's/^/   /' | head -8
  rm -rf server && mv /tmp/220-server-backup server
}

mkdir -p /tmp/220p

# ── 1 · onboarding-meal-plan reads the SECOND store again (profileNotes diet: flags) ──────────
cat > /tmp/220p/1.py <<'PY'
p = "server/onboarding-meal-plan.ts"; s = open(p).read()
s = s.replace("  const isVegetarian = c.vegetarian;\n  const isVegan = c.vegan;",
              '  const pn = (user.profileNotes || "").toLowerCase();\n'
              '  const isVegetarian = pn.includes("diet:vegetarian") || pn.includes("diet:vegan");\n'
              '  const isVegan = pn.includes("diet:vegan");')
s = s.replace("  const noFishEff = c.noFish;", "  const noFishEff = noFish || isVegetarian;")
s = s.replace("  const noDairyEff = c.noDairy;", "  const noDairyEff = noDairy || isVegan;")
assert s != open(p).read(), "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 2 · the protein-target sentence goes back to fixed prose ──────────────────────────────────
cat > /tmp/220p/2.py <<'PY'
p = "server/handlers/misc-commands.ts"; s = open(p).read()
s = s.replace("${sourceLine} This drives everything",
              " Best SA sources: eggs (6g each), pilchards (20g per tin), chicken breast (30g per 100g), tinned tuna (25g per tin). This drives everything")
assert s != open(p).read(), "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 3 · the model's snapshot reads food_dislikes raw again ────────────────────────────────────
cat > /tmp/220p/3.py <<'PY'
p = "server/brain/client-snapshot.ts"; s = open(p).read()
s = s.replace("    const constraintLine = foodConstraints(user).line;\n    if (constraintLine) lines.push(constraintLine);",
              "    if (user.foodDislikes) lines.push(`Foods they DISLIKE — never suggest these, always offer an alternative: ${String(user.foodDislikes).slice(0, 120)}.`);")
assert s != open(p).read(), "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 4 · the meal plan falls back to the UNFILTERED pool again ─────────────────────────────────
cat > /tmp/220p/4.py <<'PY'
p = "server/meal-plan.ts"; s = open(p).read()
s = s.replace("  const dayCount = finalProteinDays.length > 0 ? 3 : 0;", "  const dayCount = 3;")
s = s.replace("""  const finalProteinDays = proteinDayPool.filter(pd =>
    allowsItem(pd.lunch) && allowsItem(pd.dinner) && constraints.allows(pd.cookNote));""",
              """  const filtered = proteinDayPool.filter(pd =>
    allowsItem(pd.lunch) && allowsItem(pd.dinner) && constraints.allows(pd.cookNote));
  const finalProteinDays = filtered.length > 0 ? filtered : proteinDayPool;""")
s = s.replace("  const safeBfPool = bfPool.filter(allowsItem);",
              "  const filteredBf = bfPool.filter(allowsItem);\n  const safeBfPool = filteredBf.length ? filteredBf : bfPool;")
assert s != open(p).read(), "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 4b · both halves: the fallback AND the verifier's mouth ──────────────────────────────────
cat > /tmp/220p/4b.py <<'PY2'
p = "server/meal-plan.ts"; s = open(p).read()
s = s.replace("  const dayCount = finalProteinDays.length > 0 ? 3 : 0;", "  const dayCount = 3;")
s = s.replace("""  const finalProteinDays = proteinDayPool.filter(pd =>
    allowsItem(pd.lunch) && allowsItem(pd.dinner) && constraints.allows(pd.cookNote));""",
              """  const filtered = proteinDayPool.filter(pd =>
    allowsItem(pd.lunch) && allowsItem(pd.dinner) && constraints.allows(pd.cookNote));
  const finalProteinDays = filtered.length > 0 ? filtered : proteinDayPool;""")
s = s.replace("  const safeBfPool = bfPool.filter(allowsItem);",
              "  const filteredBf = bfPool.filter(allowsItem);\n  const safeBfPool = filteredBf.length ? filteredBf : bfPool;")
s = s.replace("  if (days.length === 0 || criticals.length > 0) {", "  if (false) {")
assert s != open(p).read(), "revert patch matched nothing"
open(p, "w").write(s)
PY2

# ── 5 · the day top-up is appended without consulting the constraint ──────────────────────────
cat > /tmp/220p/5.py <<'PY'
p = "server/meal-plan-scale.ts"; s = open(p).read()
s = s.replace("for (const u of PROTEIN_UNITS.filter(u2 => allows(u2.name)))", "for (const u of PROTEIN_UNITS)")
s = s.replace("for (const u of STARCH_UNITS.filter(u2 => allows(u2.name)))", "for (const u of STARCH_UNITS)")
assert s != open(p).read(), "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 6 · the grocery list is honoured by deletion again (no refill, headings over nothing) ─────
cat > /tmp/220p/6.py <<'PY'
p = "server/shopping-lists.ts"; s = open(p).read()
s = s.replace("  const refill = items.some(i => i.category === \"protein\") ? [] : CONSTRAINT_SAFE_PROTEIN.filter(i => c.allows(i.item));",
              "  const refill: ShoppingItem[] = [];")
s = s.replace("    mealIdeas: mealIdeas.length ? mealIdeas : CONSTRAINT_SAFE_IDEAS.filter(i => c.allows(i)),",
              "    mealIdeas,")
s = s.replace("  const ideasSection = ideas ? `\\n\\n*Meal ideas to mix it up:*\\n${ideas}` : \"\";",
              "  const ideasSection = `\\n\\n*Meal ideas to mix it up:*\\n${ideas}`;")
assert s != open(p).read(), "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 7 · the `leave these on the shelf` block stops obeying the constraint ─────────────────────
cat > /tmp/220p/7.py <<'PY'
p = "server/shopping-lists.ts"; s = open(p).read()
before = s
s = s.replace("filterBullets(`• Sugary drinks", "((x: string) => x)(`• Sugary drinks")
assert s != before, "shelf-block revert did not apply"
assert s != open(p).read(), "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 8 · the peanut cluster goes back to its singular-only trigger ─────────────────────────────
cat > /tmp/220p/8.py <<'PY'
p = "server/food-swaps.ts"; s = open(p).read()
s = s.replace("const noPeanuts = has(/\\bpeanuts?\\b|\\bgroundnuts?\\b/);", "const noPeanuts = has(/\\bpeanut\\b|\\bgroundnut\\b/);")
assert s != open(p).read(), "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 9 · the verifier's plan-check note names food without asking the constraint ───────────────
cat > /tmp/220p/9.py <<'PY'
p = "server/verifiers/meal-plan-validator.ts"; s = open(p).read()
s = s.replace("""        const sources = allowedAlternatives(
          "1 tin pilchards (26g), 3 eggs (21g), 200g Greek yoghurt (20g), 1 cup cooked lentils (18g), 1 cup cooked sugar beans (15g)",
          opts.constraints);""",
              '        const sources = "1 tin pilchards (26g), 3 eggs (21g), or 200g Greek yoghurt (20g)";')
assert s != open(p).read(), "revert patch matched nothing"
open(p, "w").write(s)
PY

# ── 10 · kosher takes the halal path again (the PR #222 regression) ──────────────────────────
cat > /tmp/220p/10.py <<'PY2'
p = "server/onboarding-meal-plan.ts"; s = open(p).read()
s = s.replace("const isHalal = !!c.declaredLabel && !isKosher;", "const isHalal = !!c.declaredLabel;")
assert s != open(p).read(), "revert patch matched nothing"
open(p, "w").write(s)
PY2

# ── 11 · the fixed template stops asking the predicate about its own meals ────────────────────
cat > /tmp/220p/11.py <<'PY2'
p = "server/onboarding-meal-plan.ts"; s = open(p).read()
s = s.replace("  if (prescribed(planBlock).some((food: string) => !c.allows(food))) return noPlanWithin(c);", "")
assert s != open(p).read(), "revert patch matched nothing"
open(p, "w").write(s)
PY2

# ── 12 · salmon leaves the fish cluster ───────────────────────────────────────────────────────
cat > /tmp/220p/12.py <<'PY2'
p = "server/food-swaps.ts"; s = open(p).read()
s = s.replace("|snoek|salmon|mackerel|kingklip|sardines?|", "|snoek|sardines?|")
assert s != open(p).read(), "revert patch matched nothing"
open(p, "w").write(s)
PY2

echo "=============================================================================="
echo "#220 — RED ON REVERT, one mechanism at a time"
echo "=============================================================================="
run_case "onboarding-meal-plan reads profileNotes diet: flags instead of the canonical column" /tmp/220p/1.py
run_case "the protein-target answer is fixed prose again"                                      /tmp/220p/2.py
run_case "buildClientSnapshot reads food_dislikes raw again"                                   /tmp/220p/3.py
# 4a is EXPECTED TO STAY GREEN, and that is the finding, not a gap: the fallback and the CRITICAL
# guard are two halves of one mechanism — "the plan may not be built from food this client cannot
# eat, and if it somehow is, it does not ship". With the fallback restored the guard catches the
# violating plan and refuses it, which is the guard doing exactly its job. 4b removes both, and
# only then does a vegan receive chicken. Reporting 4a as a pass would be dishonest; reporting it
# as a failure of the suite would be wrong. It is reported as what it is.
run_case "4a · the meal plan falls back to the unfiltered pool (the CRITICAL guard still stands)" /tmp/220p/4.py
run_case "4b · …and the CRITICAL guard is a console.warn again, as it was"                        /tmp/220p/4b.py
run_case "topUpsForDay appends food without consulting the constraint"                         /tmp/220p/5.py
run_case "the grocery list is honoured by deletion (no refill, empty headings)"                /tmp/220p/6.py
run_case "the shelf block stops obeying the constraint"                                        /tmp/220p/7.py
run_case "noPeanuts goes back to its singular-only trigger"                                    /tmp/220p/8.py
run_case "the plan-check note names food without asking the constraint"                        /tmp/220p/9.py
run_case "kosher takes the halal path again (the PR #222 regression)"                          /tmp/220p/10.py
run_case "the fixed 7-day template stops asking the predicate about its own meals"             /tmp/220p/11.py
run_case "salmon leaves the fish cluster"                                                      /tmp/220p/12.py
echo "=============================================================================="

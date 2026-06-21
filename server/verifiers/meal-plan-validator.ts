/**
 * meal-plan-validator.ts — Verify pass for the static meal-plan generator.
 *
 * The generator (meal-plan.ts) builds plans from fixed food pools. This pass
 * independently checks the built plan against the client's ACTUAL calorie/protein
 * target and re-scans for dietary-restriction violations that should have been
 * filtered out. It's the "checker" separate from the "maker": if the pools can't
 * reach a muscle-gain client's 2800 kcal target, the plan now says so instead of
 * silently handing them a 1600 kcal day.
 *
 * Deterministic, zero-cost, never throws.
 */

export interface DayTotals {
  day: string;
  kcal: number;
  protein: number;
}

export interface MealPlanValidation {
  ok: boolean;
  issues: string[];        // for logs — includes critical dietary violations
  adjustmentNote: string;  // client-facing, appended to the plan, or ""
}

// Dietary violation keyword sets (lowercase substring match).
const MEAT_WORDS = ["chicken", "mince", "beef", "steak", "lamb", "pork", "biltong", "hake", "pilchard", "tuna", "fish", "salmon", "sardine", "polony", "vienna", "liver"];
const FISH_WORDS = ["pilchard", "tuna", "hake", "fish", "salmon", "sardine"];
const DAIRY_WORDS = ["yoghurt", "milk", "cheese", "cottage cheese", "whey"];
const ANIMAL_WORDS = [...MEAT_WORDS, ...DAIRY_WORDS, "egg"];

export function validateMealPlan(opts: {
  dayTotals: DayTotals[];
  calorieTarget: number;
  proteinTarget: number;
  allItemsText: string; // all meal descriptions concatenated, lowercase
  isVegetarian: boolean;
  isVegan: boolean;
  noFish: boolean;
  noDairy: boolean;
  noPeanuts: boolean;
}): MealPlanValidation {
  try {
    const issues: string[] = [];
    const { dayTotals, calorieTarget, proteinTarget, allItemsText } = opts;

    // ── Dietary safety re-scan (independent of the generator's filters) ────────
    // These are critical: a vegan getting chicken, or an allergy violation, is a
    // trust-and-safety failure, not a portion quibble.
    if (opts.isVegan) {
      const found = ANIMAL_WORDS.filter(w => allItemsText.includes(w));
      if (found.length) issues.push(`CRITICAL: vegan plan contains animal products: ${found.join(", ")}`);
    } else if (opts.isVegetarian) {
      const found = MEAT_WORDS.filter(w => allItemsText.includes(w));
      if (found.length) issues.push(`CRITICAL: vegetarian plan contains meat/fish: ${found.join(", ")}`);
    }
    if (opts.noFish) {
      const found = FISH_WORDS.filter(w => allItemsText.includes(w));
      if (found.length) issues.push(`CRITICAL: fish-free plan contains fish: ${found.join(", ")}`);
    }
    if (opts.noDairy) {
      const found = DAIRY_WORDS.filter(w => allItemsText.includes(w));
      if (found.length) issues.push(`CRITICAL: dairy-free plan contains dairy: ${found.join(", ")}`);
    }
    if (opts.noPeanuts && allItemsText.includes("peanut")) {
      issues.push("CRITICAL: peanut-allergy plan contains peanut");
    }

    // ── Calorie target check ───────────────────────────────────────────────────
    const noteParts: string[] = [];
    if (dayTotals.length > 0 && calorieTarget > 0) {
      const avgKcal = Math.round(dayTotals.reduce((s, d) => s + d.kcal, 0) / dayTotals.length);
      const kcalGap = avgKcal - calorieTarget;
      const kcalPct = Math.abs(kcalGap) / calorieTarget;
      if (kcalPct > 0.12) {
        if (kcalGap < 0) {
          const shortfall = Math.abs(kcalGap);
          issues.push(`plan averages ${avgKcal} kcal vs ${calorieTarget} target (${shortfall} short)`);
          noteParts.push(
            `This plan averages ~${avgKcal} kcal/day but your target is ${calorieTarget} kcal. Add ~${shortfall} kcal — a post-workout shake + banana (~300 kcal), or extra protein and a starch portion at your biggest meal.`
          );
        } else {
          issues.push(`plan averages ${avgKcal} kcal vs ${calorieTarget} target (${kcalGap} over)`);
          noteParts.push(
            `This plan averages ~${avgKcal} kcal/day, above your ${calorieTarget} kcal target. Trim the carb portion at lunch or skip the snack on rest days to land on target.`
          );
        }
      }
    }

    // ── Protein target check ───────────────────────────────────────────────────
    if (dayTotals.length > 0 && proteinTarget > 0) {
      const avgProt = Math.round(dayTotals.reduce((s, d) => s + d.protein, 0) / dayTotals.length);
      if (avgProt < proteinTarget * 0.85) {
        const gap = proteinTarget - avgProt;
        issues.push(`plan averages ${avgProt}g protein vs ${proteinTarget}g target (${gap}g short)`);
        noteParts.push(
          `Protein averages ~${avgProt}g/day vs your ${proteinTarget}g target. Add a protein source — 1 tin pilchards (26g), 3 eggs (21g), or 200g Greek yoghurt (20g) — to close the ${gap}g gap.`
        );
      }
    }

    const adjustmentNote = noteParts.length
      ? `\n\n---\n\n_⚙️ *Plan check:* ${noteParts.join(" ")}_`
      : "";

    const ok = issues.length === 0;
    if (!ok) {
      console.warn("[MEAL_PLAN_VALIDATOR]", issues.join(" | "));
    }

    return { ok, issues, adjustmentNote };
  } catch (e) {
    console.warn("[MEAL_PLAN_VALIDATOR] error — passing through:", e instanceof Error ? e.message : e);
    return { ok: true, issues: [], adjustmentNote: "" };
  }
}

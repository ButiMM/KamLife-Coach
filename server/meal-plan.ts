// ============================================================
// KAMLIFE PERSONALISED MEAL PLAN GENERATOR
// Builds a 3-day rotating meal plan from the user's actual profile:
//   - calorie target
//   - protein target
//   - weekly food budget tier
//   - goal type (fat_loss | muscle_gain | recomposition)
//   - medical conditions (diabetic → low GI only)
//   - last 7 days of mealLogs (avoids foods they never eat)
// No GPT — fully static, zero cost, instant delivery.
// Split with \n\n---\n\n so Twilio sends each day as a separate WA message.
// ============================================================

import { validateMealPlan, type DayTotals } from "./verifiers/meal-plan-validator";
import { topUpsForDay, topUpLine } from "./meal-plan-scale";
import { enforceMessageBudget, MESSAGE_BUDGET } from "./reply-contract";
import { foodConstraints, allowedAlternatives } from "./food-swaps";

export type MealPlanOptions = {
  calorieTarget: number;
  proteinTarget: number;
  weeklyFoodBudget: string; // "under_100" | "100_300" | "300_600" | "600_plus" | "over_600"
  goalType: string;         // "fat_loss" | "muscle_gain" | "recomposition"
  medicalConditions: string; // comma-separated, e.g. "diabetes,hypertension"
  otherMedicalNotes: string;
  /** users.dietary_restrictions — what they told us in conversation (Cut 7). Optional so every
   *  existing caller keeps compiling; a caller that omits it simply declares fewer constraints. */
  dietaryRestrictions?: string | null;
  /** users.food_dislikes — what they told us at signup. Read here for the first time in Cut 9. */
  foodDislikes?: string | null;
  recentFoods: string[];    // names of foods logged in last 7 days (lowercase)
  firstName: string;
};

type Meal = {
  label: string;
  emoji: string;
  items: string;
  kcal: number;
  protein: number;
};

type DayPlan = {
  day: string;
  meals: Meal[];
  cookNote?: string;
};

// Protein-day template: lunch and dinner share the same base protein.
// Cook once, eat twice — realistic for busy SA clients.
type ProteinDay = {
  tags: string[];   // for dietary filtering
  lunch: FoodItem;
  dinner: FoodItem;
  cookNote: string;
};

// ── FOOD POOLS ──
// Each pool is [description, kcal, protein_g]
// Budget under_100: eggs, pilchards, pap (or oats/samp for diabetics), beans, spinach, banana
// Budget 100_300: add chicken, sweet potato, brown bread, yoghurt
// Budget 300_600+: add mince, tuna, brown rice, broccoli, avo, biltong

type FoodItem = [string, number, number]; // [description, kcal, protein]

// BREAKFAST OPTIONS
const BF_BUDGET: FoodItem[] = [
  ["2 eggs scrambled + ½ cup oats (water)", 310, 22],
  ["2 boiled eggs + 1 slice brown bread + black coffee", 290, 18],
  ["½ cup oats (water) + 1 banana + black coffee", 280, 8],
  ["2 eggs fried + ½ cup pap + black coffee", 300, 16],
  ["3 boiled eggs + black coffee", 270, 21],
  // PLANT-BASED, ON EVERY TIER (#220). Without one of these the vegan filter empties the pool
  // and the old code fell back to the unfiltered one — see the filter block in generateMealPlan.
  ["½ cup oats (water) + 2 tbsp peanut butter + 1 banana", 400, 14],
];

const BF_MID: FoodItem[] = [
  ["3 eggs scrambled + 1 slice brown bread + black coffee", 380, 27],
  ["½ cup oats + low-fat milk + 1 banana", 340, 14],
  ["2 eggs + 1 slice brown bread + ½ cup baked beans", 420, 28],
  ["Greek yoghurt (150g) + 1 banana + 2 boiled eggs", 400, 30],
  ["3 eggs scrambled + ½ cup sweet potato mash", 370, 25],
  ["½ cup oats + 2 tbsp peanut butter + 1 banana", 420, 16],
];

const BF_PREMIUM: FoodItem[] = [
  ["3 eggs scrambled + ½ avo + 1 slice whole wheat bread + black coffee", 450, 28],
  ["½ cup oats + Greek yoghurt (150g) + 1 banana", 420, 24],
  ["3 eggs + 30g biltong + black coffee", 370, 38],
  ["Cottage cheese (100g) + 2 whole wheat toast + black coffee", 380, 28],
  ["3 eggs scrambled + 1 slice whole wheat toast + 1 apple", 400, 26],
  ["½ cup oats + 2 tbsp peanut butter + ½ avo + 1 banana", 520, 17],
];

// PROTEIN DAYS — lunch and dinner share the same base protein each day.
// Cook once, eat twice. Realistic for busy SA clients who don't make four
// different proteins in a day.

const PROTEIN_DAYS_BUDGET: ProteinDay[] = [
  {
    tags: ["pilchards", "fish"],
    lunch: ["Pilchards (1 tin, tomato sauce) + ½ cup pap + wilted spinach", 420, 34],
    dinner: ["Pilchards (1 tin) + 1 slice brown bread + cabbage + tomato", 390, 34],
    cookNote: "2 tins — no cooking at all. Open, eat. Both meals sorted in 2 minutes.",
  },
  {
    tags: ["chicken"],
    lunch: ["Chicken pieces (120g, batch stewed) + ½ cup pap + spinach", 430, 32],
    dinner: ["Chicken (leftovers, 100g) + ½ cup pap + cabbage stir-fry", 400, 28],
    cookNote: "Stew 400g chicken in one pot at lunch. Reheat the rest for dinner.",
  },
  {
    tags: ["eggs", "beans"],
    lunch: ["3 boiled eggs + 1 slice brown bread + cabbage + tomato", 390, 24],
    dinner: ["Sugar beans (½ cup cooked) + ½ cup pap + onion + tomato", 390, 18],
    cookNote: "Boil 6 eggs in bulk — 3 today, 3 tomorrow. Soak beans overnight.",
  },
  {
    // PLANT-BASED, ON EVERY TIER (#220). Every other day on this tier is animal-tagged, so a
    // vegan's filter emptied the pool and the plan fell back to the unfiltered one.
    tags: ["beans", "lentils"],
    lunch: ["Sugar beans (1 cup cooked) + ½ cup pap + morogo + tomato", 430, 20],
    dinner: ["Lentils (1 cup cooked) + ½ cup rice + cabbage + onion", 420, 20],
    cookNote: "Soak 500g beans overnight and boil the lot. Lentils need no soaking — 25 minutes.",
  },
];

const PROTEIN_DAYS_MID: ProteinDay[] = [
  {
    tags: ["chicken"],
    lunch: ["Chicken thigh (150g, batch grilled) + ½ cup brown rice + mixed veg", 450, 36],
    dinner: ["Chicken thigh (leftovers, 150g) + 1 medium sweet potato + broccoli", 480, 36],
    cookNote: "Grill 400–500g chicken thighs at once. Both meals covered in one cook.",
  },
  {
    tags: ["mince", "beef"],
    lunch: ["Beef mince (120g, browned) + ½ cup sweet potato + spinach + tomato", 460, 32],
    dinner: ["Same mince (leftovers, 120g) + ½ cup brown rice + broccoli", 480, 32],
    cookNote: "Brown 400g mince in one pan. Season simply — sides change, protein doesn't.",
  },
  {
    tags: ["eggs"],
    lunch: ["2 eggs + baked beans (½ tin) + 1 slice brown bread + spinach", 420, 28],
    dinner: ["3 boiled eggs + ½ cup sweet potato + mixed veg", 420, 24],
    cookNote: "Boil 6 eggs in bulk — use them across lunch and dinner.",
  },
  {
    tags: ["pilchards", "tuna", "fish"],
    lunch: ["Pilchards (1 tin) + ½ cup sweet potato + broccoli", 440, 36],
    dinner: ["Tuna (1 tin) + ½ cup brown rice + mixed veg + lemon", 430, 34],
    cookNote: "Both are tinned — zero cooking. Pilchards at lunch, tuna at dinner.",
  },
  {
    tags: ["beans", "lentils"],
    lunch: ["Lentils (1 cup cooked) + ½ cup brown rice + spinach + tomato", 450, 22],
    dinner: ["Sugar beans (1 cup cooked) + ½ medium sweet potato + mixed veg", 440, 20],
    cookNote: "Boil 500g beans in one pot — they keep four days. Lentils cook in 25 minutes.",
  },
];

const PROTEIN_DAYS_PREMIUM: ProteinDay[] = [
  {
    tags: ["chicken"],
    lunch: ["Chicken breast (150g, batch grilled) + ½ cup brown rice + broccoli", 470, 42],
    dinner: ["Chicken breast (leftovers, 150g) + ½ cup sweet potato + spinach + olive oil", 510, 44],
    cookNote: "Grill 500g chicken breasts in one pan. Slice for lunch, reheat for dinner.",
  },
  {
    tags: ["mince", "beef"],
    lunch: ["Lean mince (120g) + ½ cup sweet potato + spinach + fresh tomato", 480, 36],
    dinner: ["Same mince (leftovers, 120g) + ½ cup brown rice + broccoli", 500, 36],
    cookNote: "Brown 500g lean mince once. Different veg each meal — one cook.",
  },
  {
    tags: ["hake", "tuna", "fish"],
    lunch: ["Tuna (1 tin) + ½ cup brown rice + mixed veg + lemon", 440, 38],
    dinner: ["Hake fillet (200g, pan-fried) + ½ cup sweet potato + green beans", 460, 44],
    cookNote: "Tuna at lunch (no cook). Pan-fry hake at dinner — 8 minutes on each side.",
  },
  {
    tags: ["steak", "beef"],
    lunch: ["Rump steak (150g, pan-seared) + mixed salad + ½ avo + cherry tomatoes", 520, 46],
    dinner: ["Steak slices (cold leftovers) + ½ cup brown rice + spinach + olive oil", 490, 44],
    cookNote: "Sear one 300g rump. Eat half hot at lunch — cold sliced for dinner.",
  },
  {
    tags: ["tofu", "lentils"],
    lunch: ["Firm tofu (200g, pan-fried) + ½ cup brown rice + broccoli + soy sauce", 470, 34],
    dinner: ["Lentils (1 cup cooked) + ½ medium sweet potato + spinach + olive oil", 480, 22],
    cookNote: "Press the tofu 20 minutes before it hits the pan — that is the whole trick. Lentils in 25.",
  },
];

// SNACK OPTIONS
const SNACK_BUDGET: FoodItem[] = [
  ["1 banana + 2 boiled eggs", 230, 14],
  ["1 apple + 2 boiled eggs", 210, 14],
  ["Peanut butter (1 tbsp) + 1 slice brown bread", 230, 8],
  ["2 boiled eggs + black coffee", 160, 14],
  ["1 banana + black coffee", 100, 1],
  ["Sugar beans (½ cup cooked) + 1 slice brown bread", 240, 12],
];

const SNACK_MID: FoodItem[] = [
  ["Greek yoghurt (150g) + 1 apple", 200, 14],
  ["1 apple + 30g peanut butter", 260, 8],
  ["2 boiled eggs + 1 apple", 220, 14],
  ["Greek yoghurt (150g) + 1 banana", 230, 14],
  ["Baked beans (½ tin) + 1 slice brown bread", 250, 10],
  ["1 apple + 30g mixed seeds", 220, 7],
];

const SNACK_PREMIUM: FoodItem[] = [
  ["30g biltong + 1 apple", 200, 22],
  ["Greek yoghurt (150g) + 1 banana", 220, 14],
  ["Cottage cheese (100g) + 1 apple", 190, 16],
  ["30g biltong + black coffee", 140, 22],
  ["Mixed nuts (30g) + 1 apple", 240, 6],
  ["Hummus (100g) + carrot sticks + 1 apple", 250, 8],
];

// LOW-GI variants (diabetic / PCOS — swap all white pap for oats/sweet potato/samp)
function makeLowGI(item: FoodItem): FoodItem {
  const [desc, kcal, prot] = item;
  const newDesc = desc
    .replace(/\+ ½ cup pap/g, "+ ½ cup oats (savoury)")
    .replace(/½ cup pap/g, "½ cup samp and beans")
    .replace(/1 cup pap/g, "½ cup samp and beans")
    .replace(/pap \+/g, "sweet potato +");
  return [newDesc, kcal, prot];
}

// FAT LOSS calorie adjustment — trim carb-heavy items slightly
function applyFatLossAdjust(meal: Meal): Meal {
  // For fat loss, nudge calorie count down 10% (portions are slightly smaller)
  return {
    ...meal,
    kcal: Math.round(meal.kcal * 0.9),
    items: meal.items + " _(smaller carb portion)_",
  };
}

// MUSCLE GAIN adjustment — add extra protein on top
function applyMuscleGainAdjust(meal: Meal, mealType: "lunch" | "dinner"): Meal {
  if (mealType !== "lunch" && mealType !== "dinner") return meal;
  return {
    ...meal,
    kcal: meal.kcal + 80,
    protein: meal.protein + 10,
    items: meal.items + " + 1 extra egg or extra 50g protein",
  };
}

function pickItem(pool: FoodItem[], index: number, isLowGI: boolean): FoodItem {
  const item = pool[index % pool.length];
  return isLowGI ? makeLowGI(item) : item;
}

function buildMeal(emoji: string, label: string, item: FoodItem): Meal {
  return {
    label,
    emoji,
    items: item[0],
    kcal: item[1],
    protein: item[2],
  };
}

function formatMeal(meal: Meal): string {
  return `${meal.emoji} *${meal.label}:* ${meal.items}\n   ~${meal.kcal} kcal | ${meal.protein}g protein`;
}

function formatDay(day: DayPlan): string {
  const lines: string[] = [`*${day.day}*`];
  if (day.cookNote) lines.push(`_💡 ${day.cookNote}_`);
  let totalKcal = 0;
  let totalProt = 0;
  for (const m of day.meals) {
    lines.push(formatMeal(m));
    totalKcal += m.kcal;
    totalProt += m.protein;
  }
  lines.push(`\n*Total: ~${totalKcal} kcal | ${totalProt}g protein*`);
  return lines.join("\n\n");
}

export function generateMealPlan(opts: MealPlanOptions): string {
  const {
    calorieTarget,
    proteinTarget,
    weeklyFoodBudget,
    goalType,
    medicalConditions,
    otherMedicalNotes,
    dietaryRestrictions,
    foodDislikes,
    firstName,
  } = opts;

  // ONE OWNER (2026-08-19, Cut 9). This block used to derive vegan / vegetarian / noDairy /
  // noFish / noPeanuts by substring-matching `otherMedicalNotes` — a third private answer to
  // "what may this client eat", which never saw users.dietary_restrictions or food_dislikes. A
  // client who told us in conversation that they are lactose intolerant still got a plan built
  // on amasi, because this function read a different column from the one that recorded it.
  const constraints = foodConstraints({
    dietaryRestrictions, foodDislikes, otherMedicalNotes, medicalConditions,
  });
  const isLowGI = constraints.lowGI;
  const noFish = constraints.noFish;
  const noDairy = constraints.noDairy;
  const noPeanuts = constraints.noPeanuts;
  const isVegetarian = constraints.vegetarian;
  const isVegan = constraints.vegan;

  // Pick pools based on budget
  const budget = weeklyFoodBudget || "100_300";
  const isBudget = budget === "under_100" || budget === "under_50" || budget === "50_100";
  const isPremium = budget === "300_600" || budget === "over_600" || budget === "600_plus" || budget === "500_plus";

  const bfPool = isBudget ? BF_BUDGET : isPremium ? BF_PREMIUM : BF_MID;
  const snackPool = isBudget ? SNACK_BUDGET : isPremium ? SNACK_PREMIUM : SNACK_MID;

  // ── ONE FILTER, AND NO WAY PAST IT (#220) ──────────────────────────────────────────────────
  //
  // This block used to carry four private word lists — MEAT_WORDS, DAIRY_WORDS_VEGAN, FISH_TAGS,
  // ANIMAL_TAGS — a fifth private answer to a question `constraints.allows` already owns, and an
  // incomplete one: the snack filter looked only for peanut, yoghurt and milk, so a vegan's plan
  // offered "30g biltong + 1 apple". `allows` is the same predicate the grocery list, the swap
  // table and the plate verdict obey, so the plan cannot disagree with them any more.
  //
  // AND THE FALLBACKS ARE GONE. `safeProteinDays.length > 0 ? safeProteinDays : proteinDayPool`
  // was the real defect: for a vegan on the premium tier every protein day is animal-tagged, the
  // filter emptied the pool, and the plan silently served the UNFILTERED one — chicken breast,
  // lean mince, hake, rump steak, under a header that read "Goal: Fat loss · 2200 kcal/day ·
  // 150g protein · Fish-free · Vegan". A restriction that is discarded whenever honouring it is
  // inconvenient is not a restriction. The pools below gained plant-based days and breakfasts so
  // the filter has survivors on every tier; where a client's own literal exclusions still empty a
  // pool the plan now says so, at the bottom, rather than quietly breaking their word.
  const allowsItem = ([d]: FoodItem) => constraints.allows(d);
  const safeBfPool = bfPool.filter(allowsItem);
  const finalSnackPool = snackPool.filter(allowsItem);

  // Protein days: pick one per day — lunch + dinner share the same base protein
  const proteinDayPool = isBudget ? PROTEIN_DAYS_BUDGET : isPremium ? PROTEIN_DAYS_PREMIUM : PROTEIN_DAYS_MID;
  // The COOK NOTE is filtered with the meals it belongs to. It is prose, not data, and it names
  // food: "Grill 500g chicken breasts in one pan" reached a vegan even on days the meals passed.
  const finalProteinDays = proteinDayPool.filter(pd =>
    allowsItem(pd.lunch) && allowsItem(pd.dinner) && constraints.allows(pd.cookNote));

  // Build 3 days — each day picks a different protein so the week rotates
  const days: DayPlan[] = [];
  const dayCount = finalProteinDays.length > 0 ? 3 : 0;
  for (let d = 0; d < dayCount; d++) {
    const proteinDay = finalProteinDays[d % finalProteinDays.length];
    // A pool a client's own exclusions emptied yields NO slot rather than a forbidden one.
    const bf = safeBfPool.length ? pickItem(safeBfPool, d, isLowGI) : null;
    const sn = finalSnackPool.length ? pickItem(finalSnackPool, d, isLowGI) : null;

    const lnRaw: FoodItem = isLowGI ? makeLowGI(proteinDay.lunch) : proteinDay.lunch;
    const dnRaw: FoodItem = isLowGI ? makeLowGI(proteinDay.dinner) : proteinDay.dinner;

    const breakfast = bf ? buildMeal("🌅", "Breakfast", bf) : null;
    let lunch = buildMeal("🍱", "Lunch", lnRaw);
    let dinner = buildMeal("🌙", "Dinner", dnRaw);
    const snack = sn ? buildMeal("🍎", "Snack", sn) : null;

    if (goalType === "fat_loss") {
      lunch = { ...lunch, kcal: Math.round(lunch.kcal * 0.92), items: lunch.items.replace("½ cup", "⅓ cup") };
      dinner = { ...dinner, kcal: Math.round(dinner.kcal * 0.92), items: dinner.items.replace("½ cup", "⅓ cup") };
    } else if (goalType === "muscle_gain") {
      // THE MUSCLE-GAIN TOP-UP NAMES A FOOD (#220), and named food is an instruction to eat it.
      // This said "+ extra 50g chicken or 1 egg" unconditionally, stapling chicken onto every
      // lunch of a vegan's plan after every filter above had run. The same `allowedAlternatives`
      // the swap table uses trims it to what this client may have, and the generic dinner line
      // — "extra 50g protein", naming nothing — is what is left when nothing survives.
      const extra = allowedAlternatives("50g chicken, 1 egg", constraints);
      lunch = { ...lunch, kcal: lunch.kcal + 80, protein: lunch.protein + 10,
                items: `${lunch.items} + extra ${extra || "50g protein"}` };
      dinner = { ...dinner, kcal: dinner.kcal + 80, protein: dinner.protein + 10, items: `${dinner.items} + extra 50g protein` };
    }

    // SCALE TO TARGET (2026-07-27): the pools are sized ~1400-1500 kcal/day, so a 2862 kcal
    // client got a plan at 52% of target while the validator merely NOTED the shortfall.
    // Close the gap with real cheap SA staples — protein first — so the plan is usable as-is.
    const built = [breakfast, lunch, dinner, snack].filter((mm): mm is Meal => mm !== null);
    const dayKcal = built.reduce((s2, mm) => s2 + mm.kcal, 0);
    const dayProt = built.reduce((s2, mm) => s2 + mm.protein, 0);
    const tops = topUpsForDay(dayKcal, dayProt, calorieTarget, proteinTarget, constraints.allows);
    const extraMeals = tops.length
      ? [{ emoji: "➕", label: "Extra to hit your target", items: tops.map(t => t.label).join(" + "),
           kcal: tops.reduce((s2, t) => s2 + t.kcal, 0), protein: tops.reduce((s2, t) => s2 + t.protein, 0) } as Meal]
      : [];

    days.push({
      day: `Day ${d + 1}`,
      meals: [...built, ...extraMeals],
      cookNote: proteinDay.cookNote,
    });
  }

  // Build header
  const goalLabel =
    goalType === "fat_loss"
      ? "Fat loss"
      : goalType === "muscle_gain"
      ? "Muscle gain"
      : "Recomposition";
  const budgetLabel: Record<string, string> = {
    under_100: "Under R100/week",
    "100_300": "R100–R300/week",
    "300_600": "R300–R600/week",
    over_600: "R600+/week",
    "600_plus": "R600+/week",
  };
  const bLabel = budgetLabel[budget] || "R100–R300/week";
  const lowGINote = isLowGI ? " · Low GI only" : "";
  const noFishNote = noFish ? " · Fish-free" : "";
  const veganNote = isVegan ? " · Vegan" : isVegetarian ? " · Vegetarian" : "";

  const header = `*Your 3-Day Meal Plan*\nGoal: ${goalLabel} · ${calorieTarget} kcal/day · ${proteinTarget}g protein${lowGINote}${noFishNote}${veganNote}\nBudget: ${bLabel}`;

  // Footer tip
  const footerTips: Record<string, string> = {
    fat_loss:
      "_Protein every meal — no exceptions. Carbs in smaller portions. Fill half the plate with veg before anything else.\n\nTo adjust: tell me what you don't eat, what you want to swap, or if any of these meals won't work for you._",
    muscle_gain:
      "_Eat every 3–4 hours. Never skip a meal. If you feel full — eat anyway. Muscle needs a surplus and consistent protein.\n\nTo adjust: tell me what you don't eat, what you want to swap, or if portions feel off._",
    recomposition:
      "_Carbs before training, protein after. Keep calories consistent day to day. Progress is slower but it lasts.\n\nTo adjust: tell me what you don't eat, what you want to swap, or your budget this week._",
  };
  const footer = footerTips[goalType] || footerTips.fat_loss;

  // ── Verify pass: check the built plan against the client's actual targets ──
  // and re-scan for dietary violations the pools/filters should have removed.
  const dayTotals: DayTotals[] = days.map(d => ({
    day: d.day,
    kcal: d.meals.reduce((s, m) => s + m.kcal, 0),
    protein: d.meals.reduce((s, m) => s + m.protein, 0),
  }));
  const allItemsText = days
    .flatMap(d => d.meals.map(m => m.items))
    .join(" | ")
    .toLowerCase();
  const validation = validateMealPlan({ dayTotals, calorieTarget, proteinTarget, allItemsText, constraints });

  // ── THE CHECKER FINALLY HAS A MOUTH (#220) ─────────────────────────────────────────────────
  //
  // validateMealPlan has always detected this exactly right — it emitted "CRITICAL: vegan plan
  // contains animal products: chicken, mince, tuna, egg" on the traced baseline — and its only
  // consequence was a console.warn. `ok:false` was read by nobody, `issues` reached no client,
  // and `adjustmentNote` carries the calorie and protein notes alone. So the plan that broke the
  // client's stated diet shipped with the verifier's own alarm attached to the server log.
  //
  // A checker whose finding cannot stop the thing it checks is decoration. Above this, the
  // generator can no longer BUILD a violating plan; a surviving CRITICAL therefore means a real
  // defect, and the honest move is not to send a plan at all. Same for a client whose own
  // exclusions emptied the protein pool: no days were built, and three empty day-blocks under a
  // header promising 150g of protein is the hollow-list failure wearing a different hat.
  const criticals = validation.issues.filter(i => i.startsWith("CRITICAL:"));
  if (days.length === 0 || criticals.length > 0) {
    const said = constraints.terms.length ? constraints.terms.join(", ") : "what you don't eat";
    return `*Your Meal Plan*\n\nI can't build you a plan that respects ${said} out of the food I've got templates for — and I'd rather tell you that than send you one that breaks your word.\n\nTell me two or three proteins you DO eat and I'll build the week around them.`;
  }

  // Join with ---  so Twilio splits into separate WA messages, then hold it to the stated
  // 4-message cap (measured at 5 before this). Re-packs sections; never trims a day.
  const parts = [header, ...days.map(formatDay), footer];
  return enforceMessageBudget(
    parts.join("\n\n---\n\n") + validation.adjustmentNote,
    MESSAGE_BUDGET.mealPlan, "generateMealPlan");
}

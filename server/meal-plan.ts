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

export type MealPlanOptions = {
  calorieTarget: number;
  proteinTarget: number;
  weeklyFoodBudget: string; // "under_100" | "100_300" | "300_600" | "600_plus" | "over_600"
  goalType: string;         // "fat_loss" | "muscle_gain" | "recomposition"
  medicalConditions: string; // comma-separated, e.g. "diabetes,hypertension"
  otherMedicalNotes: string;
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
];

const BF_MID: FoodItem[] = [
  ["3 eggs scrambled + 1 slice brown bread + black coffee", 380, 27],
  ["½ cup oats + low-fat milk + 1 banana", 340, 14],
  ["2 eggs + 1 slice brown bread + ½ cup baked beans", 420, 28],
  ["Greek yoghurt (150g) + 1 banana + 2 boiled eggs", 400, 30],
  ["3 eggs scrambled + ½ cup sweet potato mash", 370, 25],
];

const BF_PREMIUM: FoodItem[] = [
  ["3 eggs scrambled + ½ avo + 1 slice whole wheat bread + black coffee", 450, 28],
  ["½ cup oats + Greek yoghurt (150g) + 1 banana", 420, 24],
  ["3 eggs + 30g biltong + black coffee", 370, 38],
  ["Cottage cheese (100g) + 2 whole wheat toast + black coffee", 380, 28],
  ["3 eggs scrambled + 1 slice whole wheat toast + 1 apple", 400, 26],
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
];

// SNACK OPTIONS
const SNACK_BUDGET: FoodItem[] = [
  ["1 banana + 2 boiled eggs", 230, 14],
  ["1 apple + 2 boiled eggs", 210, 14],
  ["Peanut butter (1 tbsp) + 1 slice brown bread", 230, 8],
  ["2 boiled eggs + black coffee", 160, 14],
  ["1 banana + black coffee", 100, 1],
];

const SNACK_MID: FoodItem[] = [
  ["Greek yoghurt (150g) + 1 apple", 200, 14],
  ["1 apple + 30g peanut butter", 260, 8],
  ["2 boiled eggs + 1 apple", 220, 14],
  ["Greek yoghurt (150g) + 1 banana", 230, 14],
  ["Baked beans (½ tin) + 1 slice brown bread", 250, 10],
];

const SNACK_PREMIUM: FoodItem[] = [
  ["30g biltong + 1 apple", 200, 22],
  ["Greek yoghurt (150g) + 1 banana", 220, 14],
  ["Cottage cheese (100g) + 1 apple", 190, 16],
  ["30g biltong + black coffee", 140, 22],
  ["Mixed nuts (30g) + 1 apple", 240, 6],
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
    firstName,
  } = opts;

  const medicals = medicalConditions
    ? medicalConditions.split(",").map((s) => s.trim().toLowerCase())
    : [];
  const isLowGI =
    medicals.includes("diabetes") ||
    medicals.includes("diabetic") ||
    medicals.includes("pcos");
  const notes = (otherMedicalNotes || "").toLowerCase();
  const noFish =
    notes.includes("fish") ||
    notes.includes("pilchard") ||
    notes.includes("tuna");
  const noDairy =
    notes.includes("dairy") ||
    notes.includes("lactose") ||
    notes.includes("milk");
  const noPeanuts = notes.includes("peanut");
  const isVegetarian =
    notes.includes("vegetarian") ||
    notes.includes("no meat") ||
    notes.includes("no chicken") ||
    notes.includes("no beef") ||
    notes.includes("plant-based") ||
    medicals.includes("vegetarian");
  const isVegan =
    notes.includes("vegan") ||
    medicals.includes("vegan");

  // Pick pools based on budget
  const budget = weeklyFoodBudget || "100_300";
  const isBudget = budget === "under_100" || budget === "under_50" || budget === "50_100";
  const isPremium = budget === "300_600" || budget === "over_600" || budget === "600_plus" || budget === "500_plus";

  const bfPool = isBudget ? BF_BUDGET : isPremium ? BF_PREMIUM : BF_MID;
  const snackPool = isBudget ? SNACK_BUDGET : isPremium ? SNACK_PREMIUM : SNACK_MID;

  // Breakfast: filter for dietary restrictions
  const MEAT_WORDS = ["chicken", "mince", "beef", "steak", "lamb", "pork", "biltong", "hake", "pilchard", "tuna", "fish", "salmon"];
  const DAIRY_WORDS_VEGAN = ["yoghurt", "milk", "cheese", "cottage cheese", "whey"];
  const filterMeat = (pool: FoodItem[]) => pool.filter(([d]) => !MEAT_WORDS.some(w => d.toLowerCase().includes(w)));
  const filterVegan = (pool: FoodItem[]) => pool.filter(([d]) => !DAIRY_WORDS_VEGAN.some(w => d.toLowerCase().includes(w)) && !d.toLowerCase().includes("egg"));
  const safeBfPool = isVegan ? filterVegan(filterMeat(bfPool)) : isVegetarian ? filterMeat(bfPool) : bfPool;

  // Snack: allergy filtering
  const safeSnackPool = noPeanuts ? snackPool.filter(([d]) => !d.toLowerCase().includes("peanut")) : snackPool;
  const finalSnackPool = noDairy
    ? safeSnackPool.filter(([d]) => !d.toLowerCase().includes("yoghurt") && !d.toLowerCase().includes("milk"))
    : safeSnackPool;

  // Protein days: pick one per day — lunch + dinner share the same base protein
  const proteinDayPool = isBudget ? PROTEIN_DAYS_BUDGET : isPremium ? PROTEIN_DAYS_PREMIUM : PROTEIN_DAYS_MID;
  const FISH_TAGS = ["pilchards", "fish", "tuna", "hake", "salmon"];
  const ANIMAL_TAGS = ["chicken", "mince", "beef", "steak", "hake", "tuna", "fish", "pilchards"];
  const safeProteinDays = proteinDayPool.filter(pd => {
    if (noFish && pd.tags.some(t => FISH_TAGS.includes(t))) return false;
    if (isVegetarian && pd.tags.some(t => ANIMAL_TAGS.includes(t))) return false;
    if (isVegan && pd.tags.some(t => [...ANIMAL_TAGS, "eggs"].includes(t))) return false;
    return true;
  });
  const finalProteinDays = safeProteinDays.length > 0 ? safeProteinDays : proteinDayPool;

  // Build 3 days — each day picks a different protein so the week rotates
  const days: DayPlan[] = [];
  for (let d = 0; d < 3; d++) {
    const proteinDay = finalProteinDays[d % finalProteinDays.length];
    const bf = pickItem(safeBfPool.length > 0 ? safeBfPool : bfPool, d, isLowGI);
    const sn = pickItem(finalSnackPool.length > 0 ? finalSnackPool : snackPool, d, isLowGI);

    const lnRaw: FoodItem = isLowGI ? makeLowGI(proteinDay.lunch) : proteinDay.lunch;
    const dnRaw: FoodItem = isLowGI ? makeLowGI(proteinDay.dinner) : proteinDay.dinner;

    let breakfast = buildMeal("🌅", "Breakfast", bf);
    let lunch = buildMeal("🍱", "Lunch", lnRaw);
    let dinner = buildMeal("🌙", "Dinner", dnRaw);
    const snack = buildMeal("🍎", "Snack", sn);

    if (goalType === "fat_loss") {
      lunch = { ...lunch, kcal: Math.round(lunch.kcal * 0.92), items: lunch.items.replace("½ cup", "⅓ cup") };
      dinner = { ...dinner, kcal: Math.round(dinner.kcal * 0.92), items: dinner.items.replace("½ cup", "⅓ cup") };
    } else if (goalType === "muscle_gain") {
      lunch = { ...lunch, kcal: lunch.kcal + 80, protein: lunch.protein + 10, items: `${lunch.items} + extra 50g chicken or 1 egg` };
      dinner = { ...dinner, kcal: dinner.kcal + 80, protein: dinner.protein + 10, items: `${dinner.items} + extra 50g protein` };
    }

    // SCALE TO TARGET (2026-07-27): the pools are sized ~1400-1500 kcal/day, so a 2862 kcal
    // client got a plan at 52% of target while the validator merely NOTED the shortfall.
    // Close the gap with real cheap SA staples — protein first — so the plan is usable as-is.
    const built = [breakfast, lunch, dinner, snack];
    const dayKcal = built.reduce((s2, mm) => s2 + mm.kcal, 0);
    const dayProt = built.reduce((s2, mm) => s2 + mm.protein, 0);
    const tops = topUpsForDay(dayKcal, dayProt, calorieTarget, proteinTarget);
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
  const validation = validateMealPlan({
    dayTotals,
    calorieTarget,
    proteinTarget,
    allItemsText,
    isVegetarian,
    isVegan,
    noFish,
    noDairy,
    noPeanuts,
  });

  // Join with ---  so Twilio splits into separate WA messages, then hold it to the stated
  // 4-message cap (measured at 5 before this). Re-packs sections; never trims a day.
  const parts = [header, ...days.map(formatDay), footer];
  return enforceMessageBudget(
    parts.join("\n\n---\n\n") + validation.adjustmentNote,
    MESSAGE_BUDGET.mealPlan, "generateMealPlan");
}

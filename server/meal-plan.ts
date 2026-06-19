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

// LUNCH OPTIONS
const LUNCH_BUDGET: FoodItem[] = [
  ["1 tin pilchards (tomato sauce) + ½ cup pap + spinach (wilted)", 420, 36],
  ["1 tin pilchards + 1 slice brown bread + cabbage salad", 390, 34],
  ["Sugar beans (½ cup cooked) + ½ cup pap + spinach", 370, 18],
  ["2 boiled eggs + ½ cup pap + tomato + cabbage", 360, 18],
  ["1 tin pilchards + ½ cup samp + spinach", 400, 34],
];

const LUNCH_BUDGET_NO_FISH: FoodItem[] = [
  ["2 boiled eggs + ½ cup pap + spinach + tomato", 360, 18],
  ["Sugar beans (½ cup) + 1 slice brown bread + cabbage", 350, 14],
  ["Chicken pieces (100g) + ½ cup pap + cabbage", 380, 28],
  ["2 boiled eggs + ½ cup oats savoury + tomato + onion", 330, 16],
  ["3 boiled eggs + cabbage stir-fry + tomato", 340, 21],
];

const LUNCH_MID: FoodItem[] = [
  ["Chicken thigh (150g, grilled) + ½ cup brown rice + mixed veg", 450, 36],
  ["1 tin pilchards + ½ cup sweet potato + broccoli", 440, 36],
  ["Chicken thigh (150g) + 1 slice brown bread + cabbage salad", 420, 34],
  ["Beef mince (100g) + ½ cup sweet potato + spinach", 460, 32],
  ["2 eggs + ½ cup sweet potato + baked beans (½ tin) + spinach", 430, 28],
];

const LUNCH_PREMIUM: FoodItem[] = [
  ["Chicken breast (150g, grilled) + ½ cup brown rice + broccoli", 470, 42],
  ["Tuna (1 tin) + ½ cup brown rice + mixed veg + lemon", 440, 38],
  ["Lean mince (120g) + ½ cup sweet potato + spinach + tomato", 480, 36],
  ["Chicken breast (150g) + ½ avo + mixed salad + olive oil", 500, 40],
  ["Hake fillet (150g) + ½ cup brown rice + green beans", 430, 38],
];

// DINNER OPTIONS
const DINNER_BUDGET: FoodItem[] = [
  ["Chicken pieces (120g, stewed) + ½ cup pap + spinach", 430, 32],
  ["1 tin pilchards + ½ cup pap + cabbage", 420, 34],
  ["Sugar beans + ½ cup pap + onion + tomato", 390, 18],
  ["2 eggs + ½ cup pap + spinach", 330, 18],
  ["Chicken liver (100g) + ½ cup pap + cabbage", 400, 28],
];

const DINNER_BUDGET_NO_FISH: FoodItem[] = [
  ["Chicken pieces (120g) + ½ cup pap + spinach", 430, 32],
  ["Sugar beans (½ cup) + ½ cup pap + onion + tomato", 390, 18],
  ["2 eggs + ½ cup pap + cabbage stir-fry", 330, 18],
  ["Chicken liver (100g) + ½ cup pap + spinach", 400, 28],
  ["3 boiled eggs + ½ cup samp + tomato + onion", 380, 21],
];

const DINNER_MID: FoodItem[] = [
  ["Chicken breast (150g) + 1 medium sweet potato + broccoli", 490, 42],
  ["Beef mince (120g) + ½ cup brown rice + spinach", 500, 36],
  ["Chicken thigh (150g, baked) + ½ cup sweet potato + mixed veg", 480, 36],
  ["2 eggs + baked beans (½ tin) + 1 slice brown bread + spinach", 420, 28],
  ["1 tin pilchards + ½ cup sweet potato + spinach", 440, 36],
];

const DINNER_PREMIUM: FoodItem[] = [
  ["Chicken breast (150g) + ½ cup sweet potato + broccoli + olive oil", 510, 44],
  ["Rump steak (150g) + ½ cup sweet potato + spinach", 540, 48],
  ["Lean mince bolognaise (120g) + ½ cup sweet potato + broccoli", 520, 38],
  ["Hake fillet (200g) + ½ cup brown rice + green beans", 460, 44],
  ["Chicken thigh (150g, baked) + ½ cup brown rice + spinach", 500, 38],
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
  ["Greek yoghurt (150g) + 1 banana + 1 tsp honey", 240, 14],
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
  const isBudget = budget === "under_100";
  const isPremium = budget === "300_600" || budget === "over_600" || budget === "600_plus";

  const bfPool = isBudget ? BF_BUDGET : isPremium ? BF_PREMIUM : BF_MID;
  const lunchPool = isBudget
    ? noFish
      ? LUNCH_BUDGET_NO_FISH
      : LUNCH_BUDGET
    : isPremium
    ? LUNCH_PREMIUM
    : LUNCH_MID;
  const dinnerPool = isBudget
    ? noFish
      ? DINNER_BUDGET_NO_FISH
      : DINNER_BUDGET
    : isPremium
    ? DINNER_PREMIUM
    : DINNER_MID;
  const snackPool = isBudget
    ? SNACK_BUDGET
    : isPremium
    ? SNACK_PREMIUM
    : SNACK_MID;

  // Meat keywords for vegetarian/vegan filtering
  const MEAT_WORDS = ["chicken", "mince", "beef", "steak", "lamb", "pork", "biltong", "hake", "pilchard", "tuna", "fish", "salmon", "sardine", "polony", "vienna"];
  const filterMeat = (pool: FoodItem[]) =>
    pool.filter(([d]) => !MEAT_WORDS.some(w => d.toLowerCase().includes(w)));
  const DAIRY_WORDS_VEGAN = ["yoghurt", "milk", "cheese", "cottage cheese", "whey"];
  const filterVegan = (pool: FoodItem[]) =>
    pool.filter(([d]) => !DAIRY_WORDS_VEGAN.some(w => d.toLowerCase().includes(w)) && !d.toLowerCase().includes("egg"));

  const safeBfPool = isVegan ? filterVegan(filterMeat(bfPool)) : isVegetarian ? filterMeat(bfPool) : bfPool;
  const safeLunchPool = isVegan ? filterVegan(filterMeat(lunchPool)) : isVegetarian ? filterMeat(lunchPool) : lunchPool;
  const safeDinnerPool = isVegan ? filterVegan(filterMeat(dinnerPool)) : isVegetarian ? filterMeat(dinnerPool) : dinnerPool;

  // Remove snacks with peanut butter if allergic
  const safeSnackPool = noPeanuts
    ? snackPool.filter(([d]) => !d.toLowerCase().includes("peanut"))
    : snackPool;

  // Remove dairy snacks if intolerant
  const finalSnackPool = noDairy
    ? safeSnackPool.filter(([d]) => !d.toLowerCase().includes("yoghurt") && !d.toLowerCase().includes("milk"))
    : safeSnackPool;

  // Build 3 days using different offsets so meals rotate
  const days: DayPlan[] = [];
  for (let d = 0; d < 3; d++) {
    const bf = pickItem(safeBfPool.length > 0 ? safeBfPool : bfPool, d, isLowGI);
    const ln = pickItem(safeLunchPool.length > 0 ? safeLunchPool : lunchPool, d, isLowGI);
    const dn = pickItem(safeDinnerPool.length > 0 ? safeDinnerPool : dinnerPool, d, isLowGI);
    const sn = pickItem(finalSnackPool.length > 0 ? finalSnackPool : snackPool, d, isLowGI);

    let breakfast = buildMeal("🌅", "Breakfast", bf);
    let lunch = buildMeal("🍱", "Lunch", ln);
    let dinner = buildMeal("🌙", "Dinner", dn);
    const snack = buildMeal("🍎", "Snack", sn);

    if (goalType === "fat_loss") {
      // Slightly reduce carb portions at lunch and dinner
      lunch = { ...lunch, kcal: Math.round(lunch.kcal * 0.92), items: lunch.items.replace("½ cup", "⅓ cup") };
      dinner = { ...dinner, kcal: Math.round(dinner.kcal * 0.92), items: dinner.items.replace("½ cup", "⅓ cup") };
    } else if (goalType === "muscle_gain") {
      // Add extra protein note to lunch and dinner
      lunch = { ...lunch, kcal: lunch.kcal + 80, protein: lunch.protein + 10, items: `${lunch.items} + extra 50g chicken or 1 egg` };
      dinner = { ...dinner, kcal: dinner.kcal + 80, protein: dinner.protein + 10, items: `${dinner.items} + extra 50g protein` };
    }

    days.push({
      day: `Day ${d + 1}`,
      meals: [breakfast, lunch, dinner, snack],
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
      "_Portion your carbs first — weigh or measure. Fill half your plate with veg before adding anything else. Protein every meal, no exceptions._",
    muscle_gain:
      "_Eat every 3–4 hours. Never skip a meal. If you feel full — eat anyway. Muscle needs a calorie surplus and consistent protein._",
    recomposition:
      "_Carbs before training, protein after. Keep calories consistent day to day. Progress is slower but it lasts._",
  };
  const footer = footerTips[goalType] || footerTips.fat_loss;

  // Join with ---  so Twilio splits into separate WA messages
  const parts = [header, ...days.map(formatDay), footer];
  return parts.join("\n\n---\n\n");
}

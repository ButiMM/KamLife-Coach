// ============================================================
// KAMLIFE SHOPPING LIST TEMPLATES
// Budget-tiered weekly shopping lists for SA clients
// Delivered every Sunday with the weekly summary
// ============================================================

export type ShoppingItem = {
  item: string;
  qty: string;
  price: string; // estimated ZAR
  category: "protein" | "carb" | "veg" | "fruit" | "dairy" | "pantry" | "supplement";
};

export type ShoppingList = {
  tier: string;
  budgetLabel: string;
  estimatedTotal: string;
  coversDays: number;
  items: ShoppingItem[];
  mealIdeas: string[];
};

// ── TIER 1: Under R1,500/month (R350/week) ──
const TIER_1_WEEK_A: ShoppingList = {
  tier: "under_100",
  budgetLabel: "Under R1,500/month",
  estimatedTotal: "~R320",
  coversDays: 7,
  items: [
    { item: "Eggs (1 dozen)", qty: "12", price: "R30", category: "protein" },
    { item: "Pilchards in tomato (4 tins)", qty: "4", price: "R48", category: "protein" },
    { item: "Chicken pieces (1kg)", qty: "1kg", price: "R45", category: "protein" },
    { item: "Sugar beans (500g dry)", qty: "500g", price: "R18", category: "protein" },
    { item: "Brown bread (2 loaves)", qty: "2", price: "R30", category: "carb" },
    { item: "Rice (2kg)", qty: "2kg", price: "R30", category: "carb" },
    { item: "Oats (500g)", qty: "500g", price: "R25", category: "carb" },
    { item: "Pap / maize meal (2.5kg)", qty: "2.5kg", price: "R22", category: "carb" },
    { item: "Cabbage (1 head)", qty: "1", price: "R12", category: "veg" },
    { item: "Frozen mixed veg (1kg)", qty: "1kg", price: "R25", category: "veg" },
    { item: "Tomatoes (6)", qty: "6", price: "R15", category: "veg" },
    { item: "Onions (1kg)", qty: "1kg", price: "R12", category: "veg" },
    { item: "Bananas (6)", qty: "6", price: "R12", category: "fruit" },
    { item: "Peanut butter (400g)", qty: "400g", price: "R30", category: "pantry" },
    { item: "Cooking oil (750ml)", qty: "750ml", price: "R25", category: "pantry" },
  ],
  mealIdeas: [
    "Breakfast: 2 boiled eggs + toast — R8",
    "Lunch: Pilchards on brown bread — R12",
    "Dinner: Chicken pieces + pap + cabbage — R25",
    "Snack: Peanut butter on bread — R5",
  ],
};

const TIER_1_WEEK_B: ShoppingList = {
  tier: "under_100",
  budgetLabel: "Under R1,500/month",
  estimatedTotal: "~R310",
  coversDays: 7,
  items: [
    { item: "Eggs (18 pack)", qty: "18", price: "R40", category: "protein" },
    { item: "Pilchards in tomato (4 tins)", qty: "4", price: "R48", category: "protein" },
    { item: "Chicken livers (500g)", qty: "500g", price: "R25", category: "protein" },
    { item: "Sugar beans (500g dry)", qty: "500g", price: "R18", category: "protein" },
    { item: "Brown bread (2 loaves)", qty: "2", price: "R30", category: "carb" },
    { item: "Samp (1kg)", qty: "1kg", price: "R15", category: "carb" },
    { item: "Oats (500g)", qty: "500g", price: "R25", category: "carb" },
    { item: "Pap / maize meal (2.5kg)", qty: "2.5kg", price: "R22", category: "carb" },
    { item: "Spinach (1 bunch)", qty: "1", price: "R10", category: "veg" },
    { item: "Carrots (500g)", qty: "500g", price: "R8", category: "veg" },
    { item: "Butternut (1)", qty: "1", price: "R15", category: "veg" },
    { item: "Onions (1kg)", qty: "1kg", price: "R12", category: "veg" },
    { item: "Apples (6)", qty: "6", price: "R18", category: "fruit" },
    { item: "Peanut butter (400g)", qty: "400g", price: "R30", category: "pantry" },
  ],
  mealIdeas: [
    "Breakfast: Oats + banana — R6",
    "Lunch: Umngqusho (samp & beans) — R10",
    "Dinner: Chicken livers + pap + spinach — R22",
    "Snack: 2 boiled eggs — R5",
  ],
};

// ── TIER 2: R1,500–R3,000/month (R500-R700/week) ──
const TIER_2_WEEK_A: ShoppingList = {
  tier: "100_300",
  budgetLabel: "R1,500–R3,000/month",
  estimatedTotal: "~R580",
  coversDays: 7,
  items: [
    { item: "Eggs (18 pack)", qty: "18", price: "R40", category: "protein" },
    { item: "Chicken thighs (1kg)", qty: "1kg", price: "R55", category: "protein" },
    { item: "Chicken breast (500g)", qty: "500g", price: "R50", category: "protein" },
    { item: "Beef mince (500g)", qty: "500g", price: "R55", category: "protein" },
    { item: "Pilchards (2 tins)", qty: "2", price: "R24", category: "protein" },
    { item: "Tuna (2 tins)", qty: "2", price: "R30", category: "protein" },
    { item: "Brown bread (2 loaves)", qty: "2", price: "R30", category: "carb" },
    { item: "Brown rice (1kg)", qty: "1kg", price: "R20", category: "carb" },
    { item: "Oats (500g)", qty: "500g", price: "R25", category: "carb" },
    { item: "Sweet potatoes (1kg)", qty: "1kg", price: "R18", category: "carb" },
    { item: "Broccoli (1 head)", qty: "1", price: "R20", category: "veg" },
    { item: "Mixed veg frozen (1kg)", qty: "1kg", price: "R25", category: "veg" },
    { item: "Spinach (1 bunch)", qty: "1", price: "R10", category: "veg" },
    { item: "Tomatoes (6)", qty: "6", price: "R15", category: "veg" },
    { item: "Bananas (6)", qty: "6", price: "R12", category: "fruit" },
    { item: "Apples (6)", qty: "6", price: "R18", category: "fruit" },
    { item: "Greek yoghurt (500g)", qty: "500g", price: "R35", category: "dairy" },
    { item: "Full cream milk (1L)", qty: "1L", price: "R20", category: "dairy" },
    { item: "Peanut butter (400g)", qty: "400g", price: "R30", category: "pantry" },
  ],
  mealIdeas: [
    "Breakfast: 3 eggs scrambled + toast — R12",
    "Lunch: Chicken thigh + rice + mixed veg — R30",
    "Dinner: Mince bolognaise + sweet potato — R28",
    "Snack: Greek yoghurt + banana — R12",
  ],
};

const TIER_2_WEEK_B: ShoppingList = {
  tier: "100_300",
  budgetLabel: "R1,500–R3,000/month",
  estimatedTotal: "~R560",
  coversDays: 7,
  items: [
    { item: "Eggs (18 pack)", qty: "18", price: "R40", category: "protein" },
    { item: "Chicken breast (1kg)", qty: "1kg", price: "R90", category: "protein" },
    { item: "Baked beans (4 tins)", qty: "4", price: "R32", category: "protein" },
    { item: "Pilchards (2 tins)", qty: "2", price: "R24", category: "protein" },
    { item: "Polony (500g)", qty: "500g", price: "R25", category: "protein" },
    { item: "Brown bread (2 loaves)", qty: "2", price: "R30", category: "carb" },
    { item: "Pasta (500g)", qty: "500g", price: "R15", category: "carb" },
    { item: "Oats (500g)", qty: "500g", price: "R25", category: "carb" },
    { item: "Potatoes (2kg)", qty: "2kg", price: "R25", category: "carb" },
    { item: "Cabbage (1 head)", qty: "1", price: "R12", category: "veg" },
    { item: "Green beans (500g frozen)", qty: "500g", price: "R18", category: "veg" },
    { item: "Carrots (500g)", qty: "500g", price: "R8", category: "veg" },
    { item: "Butternut (1)", qty: "1", price: "R15", category: "veg" },
    { item: "Oranges (6)", qty: "6", price: "R15", category: "fruit" },
    { item: "Bananas (6)", qty: "6", price: "R12", category: "fruit" },
    { item: "Cheese slices (10 pack)", qty: "10", price: "R30", category: "dairy" },
    { item: "Full cream milk (2L)", qty: "2L", price: "R35", category: "dairy" },
    { item: "Cooking oil (750ml)", qty: "750ml", price: "R25", category: "pantry" },
  ],
  mealIdeas: [
    "Breakfast: Oats + milk + banana — R8",
    "Lunch: Chicken breast + pasta + green beans — R32",
    "Dinner: Baked beans on toast + cheese — R12",
    "Snack: 2 boiled eggs + apple — R8",
  ],
};

// ── TIER 3: R3,000–R5,000/month (R800-R1200/week) ──
const TIER_3_WEEK_A: ShoppingList = {
  tier: "300_600",
  budgetLabel: "R3,000–R5,000/month",
  estimatedTotal: "~R950",
  coversDays: 7,
  items: [
    { item: "Eggs (18 pack)", qty: "18", price: "R40", category: "protein" },
    { item: "Chicken breast (1kg)", qty: "1kg", price: "R90", category: "protein" },
    { item: "Lean beef mince (500g)", qty: "500g", price: "R65", category: "protein" },
    { item: "Rump steak (400g)", qty: "400g", price: "R75", category: "protein" },
    { item: "Hake fillets (400g)", qty: "400g", price: "R60", category: "protein" },
    { item: "Tuna (4 tins)", qty: "4", price: "R60", category: "protein" },
    { item: "Cottage cheese (250g)", qty: "250g", price: "R30", category: "protein" },
    { item: "Brown rice (1kg)", qty: "1kg", price: "R20", category: "carb" },
    { item: "Sweet potatoes (1kg)", qty: "1kg", price: "R18", category: "carb" },
    { item: "Whole wheat bread (1 loaf)", qty: "1", price: "R20", category: "carb" },
    { item: "Oats (500g)", qty: "500g", price: "R25", category: "carb" },
    { item: "Broccoli (2 heads)", qty: "2", price: "R40", category: "veg" },
    { item: "Spinach (2 bunches)", qty: "2", price: "R20", category: "veg" },
    { item: "Mixed salad bag", qty: "1", price: "R25", category: "veg" },
    { item: "Avo (3)", qty: "3", price: "R30", category: "veg" },
    { item: "Cherry tomatoes", qty: "1 punnet", price: "R20", category: "veg" },
    { item: "Blueberries", qty: "125g", price: "R30", category: "fruit" },
    { item: "Bananas (6)", qty: "6", price: "R12", category: "fruit" },
    { item: "Greek yoghurt (1kg)", qty: "1kg", price: "R55", category: "dairy" },
    { item: "Full cream milk (2L)", qty: "2L", price: "R35", category: "dairy" },
    { item: "Mixed nuts (200g)", qty: "200g", price: "R45", category: "pantry" },
    { item: "Olive oil (500ml)", qty: "500ml", price: "R50", category: "pantry" },
    { item: "Protein powder (if using)", qty: "10 servings", price: "R150", category: "supplement" },
  ],
  mealIdeas: [
    "Breakfast: 3 eggs + avo + toast — R20",
    "Lunch: Chicken breast + rice + broccoli — R35",
    "Dinner: Rump steak + sweet potato + spinach — R50",
    "Snack: Greek yoghurt + blueberries + nuts — R20",
  ],
};

// ── TIER 4: R5,000+/month (R1,200+/week) ──
const TIER_4_WEEK_A: ShoppingList = {
  tier: "over_600",
  budgetLabel: "R5,000+/month",
  estimatedTotal: "~R1,400",
  coversDays: 7,
  items: [
    { item: "Free-range eggs (18)", qty: "18", price: "R65", category: "protein" },
    { item: "Chicken breast fillet (1kg)", qty: "1kg", price: "R90", category: "protein" },
    { item: "Salmon fillets (400g)", qty: "400g", price: "R140", category: "protein" },
    { item: "Sirloin steak (500g)", qty: "500g", price: "R110", category: "protein" },
    { item: "Lamb chops (500g)", qty: "500g", price: "R95", category: "protein" },
    { item: "Woolworths lean mince (500g)", qty: "500g", price: "R75", category: "protein" },
    { item: "Biltong (200g)", qty: "200g", price: "R80", category: "protein" },
    { item: "Smoked salmon (100g)", qty: "100g", price: "R50", category: "protein" },
    { item: "Basmati rice (1kg)", qty: "1kg", price: "R30", category: "carb" },
    { item: "Sweet potatoes (1kg)", qty: "1kg", price: "R18", category: "carb" },
    { item: "Sourdough bread", qty: "1 loaf", price: "R40", category: "carb" },
    { item: "Quinoa (400g)", qty: "400g", price: "R45", category: "carb" },
    { item: "Baby spinach (200g)", qty: "200g", price: "R25", category: "veg" },
    { item: "Tenderstem broccoli", qty: "200g", price: "R35", category: "veg" },
    { item: "Avo (4)", qty: "4", price: "R40", category: "veg" },
    { item: "Woolworths stir-fry veg", qty: "400g", price: "R35", category: "veg" },
    { item: "Asparagus", qty: "1 bunch", price: "R35", category: "veg" },
    { item: "Mushrooms (250g)", qty: "250g", price: "R20", category: "veg" },
    { item: "Mixed berries", qty: "300g", price: "R45", category: "fruit" },
    { item: "Bananas (6)", qty: "6", price: "R12", category: "fruit" },
    { item: "Mangoes (2)", qty: "2", price: "R20", category: "fruit" },
    { item: "Greek yoghurt (1kg)", qty: "1kg", price: "R55", category: "dairy" },
    { item: "Feta cheese (200g)", qty: "200g", price: "R35", category: "dairy" },
    { item: "Almond milk (1L)", qty: "1L", price: "R40", category: "dairy" },
    { item: "Mixed nuts (300g)", qty: "300g", price: "R60", category: "pantry" },
    { item: "Extra virgin olive oil (500ml)", qty: "500ml", price: "R70", category: "pantry" },
    { item: "Whey protein (if using)", qty: "10 servings", price: "R180", category: "supplement" },
  ],
  mealIdeas: [
    "Breakfast: Smoked salmon + scrambled eggs + sourdough — R40",
    "Lunch: Grilled chicken + quinoa + avo + spinach salad — R45",
    "Dinner: Salmon fillet + sweet potato + asparagus — R65",
    "Snack: Biltong + mixed nuts — R30",
  ],
};

// ── TIER 3: R3,000–R5,000/month — Week B (different proteins and carbs for variety) ──
const TIER_3_WEEK_B: ShoppingList = {
  tier: "300_600",
  budgetLabel: "R3,000–R5,000/month",
  estimatedTotal: "~R980",
  coversDays: 7,
  items: [
    { item: "Eggs (18 pack)", qty: "18", price: "R40", category: "protein" },
    { item: "Chicken thighs (1kg)", qty: "1kg", price: "R70", category: "protein" },
    { item: "Pork chops (500g)", qty: "500g", price: "R65", category: "protein" },
    { item: "Pilchards (4 tins)", qty: "4", price: "R48", category: "protein" },
    { item: "Lean mince (500g)", qty: "500g", price: "R65", category: "protein" },
    { item: "Low-fat cheese (200g)", qty: "200g", price: "R40", category: "protein" },
    { item: "Potatoes (1.5kg)", qty: "1.5kg", price: "R20", category: "carb" },
    { item: "Oats (500g)", qty: "500g", price: "R25", category: "carb" },
    { item: "Whole wheat pasta (500g)", qty: "500g", price: "R20", category: "carb" },
    { item: "Whole wheat bread (1 loaf)", qty: "1", price: "R20", category: "carb" },
    { item: "Cabbage (1 head)", qty: "1", price: "R15", category: "veg" },
    { item: "Butternut (1 medium)", qty: "1", price: "R18", category: "veg" },
    { item: "Green beans (500g)", qty: "500g", price: "R25", category: "veg" },
    { item: "Avo (2)", qty: "2", price: "R20", category: "veg" },
    { item: "Tomatoes (6)", qty: "6", price: "R15", category: "veg" },
    { item: "Oranges (6)", qty: "6", price: "R20", category: "fruit" },
    { item: "Apples (6)", qty: "6", price: "R20", category: "fruit" },
    { item: "Greek yoghurt (500g)", qty: "500g", price: "R30", category: "dairy" },
    { item: "Full cream milk (2L)", qty: "2L", price: "R35", category: "dairy" },
    { item: "Peanut butter (400g)", qty: "400g", price: "R35", category: "pantry" },
    { item: "Olive oil (500ml)", qty: "500ml", price: "R50", category: "pantry" },
    { item: "Protein powder (if using)", qty: "10 servings", price: "R150", category: "supplement" },
  ],
  mealIdeas: [
    "Breakfast: 3 eggs + toast + orange — R12",
    "Lunch: Chicken thighs + pasta + green beans — R30",
    "Dinner: Pork chops + potatoes + butternut — R40",
    "Snack: Greek yoghurt + apple + peanut butter — R15",
  ],
};

// ── TIER 4: R5,000+/month — Week B (different premium proteins for variety) ──
const TIER_4_WEEK_B: ShoppingList = {
  tier: "over_600",
  budgetLabel: "R5,000+/month",
  estimatedTotal: "~R1,380",
  coversDays: 7,
  items: [
    { item: "Free-range eggs (18)", qty: "18", price: "R65", category: "protein" },
    { item: "Chicken breast fillet (1kg)", qty: "1kg", price: "R90", category: "protein" },
    { item: "Yellowtail fillets (400g)", qty: "400g", price: "R110", category: "protein" },
    { item: "Pork loin (500g)", qty: "500g", price: "R85", category: "protein" },
    { item: "Woolworths beef steak (400g)", qty: "400g", price: "R95", category: "protein" },
    { item: "Biltong (200g)", qty: "200g", price: "R80", category: "protein" },
    { item: "Tuna in spring water (4 tins)", qty: "4", price: "R60", category: "protein" },
    { item: "Low-fat cottage cheese (250g)", qty: "250g", price: "R30", category: "protein" },
    { item: "Brown rice (1kg)", qty: "1kg", price: "R20", category: "carb" },
    { item: "Butternut (1 large)", qty: "1", price: "R20", category: "carb" },
    { item: "Whole wheat bread (1 loaf)", qty: "1", price: "R20", category: "carb" },
    { item: "Barley (500g)", qty: "500g", price: "R25", category: "carb" },
    { item: "Baby spinach (200g)", qty: "200g", price: "R25", category: "veg" },
    { item: "Broccoli (2 heads)", qty: "2", price: "R40", category: "veg" },
    { item: "Avo (4)", qty: "4", price: "R40", category: "veg" },
    { item: "Stir-fry vegetable mix (400g)", qty: "400g", price: "R35", category: "veg" },
    { item: "Green beans (400g)", qty: "400g", price: "R25", category: "veg" },
    { item: "Cucumber (2)", qty: "2", price: "R18", category: "veg" },
    { item: "Strawberries (250g)", qty: "250g", price: "R40", category: "fruit" },
    { item: "Apples (6)", qty: "6", price: "R20", category: "fruit" },
    { item: "Oranges (6)", qty: "6", price: "R20", category: "fruit" },
    { item: "Greek yoghurt (1kg)", qty: "1kg", price: "R55", category: "dairy" },
    { item: "Low-fat milk (2L)", qty: "2L", price: "R30", category: "dairy" },
    { item: "Mixed nuts (250g)", qty: "250g", price: "R55", category: "pantry" },
    { item: "Extra virgin olive oil (500ml)", qty: "500ml", price: "R70", category: "pantry" },
    { item: "Whey protein (if using)", qty: "10 servings", price: "R180", category: "supplement" },
  ],
  mealIdeas: [
    "Breakfast: 3 eggs + avo + whole wheat toast — R22",
    "Lunch: Tuna + brown rice + broccoli — R30",
    "Dinner: Yellowtail fillet + barley + green beans — R55",
    "Snack: Biltong + mixed nuts + apple — R30",
  ],
};

// ── GOAL-BASED ITEM SWAPS ──
// Fat loss: cut calorie-dense items, add volume foods
// Muscle gain: add protein, keep calorie-dense items, bigger portions

const FAT_LOSS_SWAPS: Record<string, ShoppingItem | null> = {
  "Peanut butter (400g)": { item: "Cottage cheese (250g)", qty: "250g", price: "R25", category: "protein" },
  "Cooking oil (750ml)": { item: "Spray-and-cook + lemon", qty: "1 each", price: "R30", category: "pantry" },
  "Full cream milk (1L)": { item: "Low fat milk (1L)", qty: "1L", price: "R18", category: "dairy" },
  "Full cream milk (2L)": { item: "Low fat milk (2L)", qty: "2L", price: "R30", category: "dairy" },
  "Polony (500g)": null, // remove entirely — processed, calorie-dense, no value
  "Bananas (6)": { item: "Apples (6)", qty: "6", price: "R18", category: "fruit" },
  "Avo (3)": { item: "Avo (1) + cucumber (2)", qty: "3", price: "R25", category: "veg" },
  "Avo (4)": { item: "Avo (2) + cucumber (2)", qty: "4", price: "R35", category: "veg" },
  "Mixed nuts (200g)": { item: "Mixed nuts (100g)", qty: "100g", price: "R25", category: "pantry" },
  "Mixed nuts (300g)": { item: "Mixed nuts (150g)", qty: "150g", price: "R35", category: "pantry" },
};

const FAT_LOSS_EXTRAS: ShoppingItem[] = [
  { item: "Extra spinach/cabbage", qty: "1 bunch", price: "R10", category: "veg" },
];

const MUSCLE_GAIN_EXTRAS: ShoppingItem[] = [
  { item: "Extra eggs (6 pack)", qty: "6", price: "R20", category: "protein" },
  { item: "Full cream milk (1L extra)", qty: "1L", price: "R20", category: "dairy" },
];

function applyGoalModifications(list: ShoppingList, goalType: string): ShoppingList {
  if (goalType !== "fat_loss" && goalType !== "muscle_gain") return list;

  let items = [...list.items];
  let mealIdeas = [...list.mealIdeas];

  if (goalType === "fat_loss") {
    // Apply swaps
    items = items.map(item => {
      const swap = FAT_LOSS_SWAPS[item.item];
      if (swap === null) return null; // remove
      if (swap) return swap;
      return item;
    }).filter((item): item is ShoppingItem => item !== null);

    // Add volume foods
    items.push(...FAT_LOSS_EXTRAS);

    // Swap meal ideas for fat-loss focus
    mealIdeas = mealIdeas.map(idea => {
      return idea
        .replace(/Peanut butter on bread/i, "Cottage cheese on toast")
        .replace(/peanut butter/i, "cottage cheese")
        .replace(/Greek yoghurt \+ banana/i, "Greek yoghurt + berries (if budget)");
    });
  }

  if (goalType === "muscle_gain") {
    items.push(...MUSCLE_GAIN_EXTRAS);
    mealIdeas.push("Extra: Milk + peanut butter shake between meals — R8");
  }

  return { ...list, items, mealIdeas };
}

// ── LOOKUP ──

const ALL_LISTS: Record<string, ShoppingList[]> = {
  under_100: [TIER_1_WEEK_A, TIER_1_WEEK_B],
  "100_300": [TIER_2_WEEK_A, TIER_2_WEEK_B],
  "300_600": [TIER_3_WEEK_A, TIER_3_WEEK_B],
  over_600: [TIER_4_WEEK_A, TIER_4_WEEK_B],
};

export function getShoppingList(budgetTier: string, weekNumber: number, goalType?: string): ShoppingList {
  const lists = ALL_LISTS[budgetTier] || ALL_LISTS["100_300"];
  const idx = (weekNumber - 1) % lists.length;
  const base = lists[idx];
  return goalType ? applyGoalModifications(base, goalType) : base;
}

export function formatShoppingList(list: ShoppingList, userName?: string, goalType?: string): string {
  const greeting = userName ? `${userName}, here's` : "Here's";

  // Goal-specific header
  const goalHeaders: Record<string, string> = {
    fat_loss: "🎯 _Fat loss focus — high protein, lower carbs, big on veggies_",
    muscle_gain: "💪 _Muscle gain focus — extra protein, calorie-dense staples_",
    recomposition: "🔄 _Body recomp — balanced protein & carbs_",
    general: "",
    health_condition: "",
  };
  const goalHeader = goalType ? goalHeaders[goalType] || "" : "";

  const grouped: Record<string, ShoppingItem[]> = {};
  for (const item of list.items) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push(item);
  }

  const categoryLabels: Record<string, string> = {
    protein: "Protein",
    carb: "Carbs",
    veg: "Vegetables",
    fruit: "Fruit",
    dairy: "Dairy",
    pantry: "Pantry",
    supplement: "Supplements",
  };

  const order = ["protein", "carb", "veg", "fruit", "dairy", "pantry", "supplement"];
  let body = "";
  for (const cat of order) {
    const items = grouped[cat];
    if (!items || items.length === 0) continue;
    body += `\n*${categoryLabels[cat]}:*\n`;
    for (const i of items) {
      body += `• ${i.item} (${i.qty}) — ${i.price}\n`;
    }
  }

  const ideas = list.mealIdeas.map(m => `• ${m}`).join("\n");

  // Goal-specific tips at the bottom
  const goalTips: Record<string, string> = {
    fat_loss: "\n\n⚠️ _Portion control is everything. Weigh your carbs. Fill half your plate with veg before anything else._",
    muscle_gain: "\n\n💡 _Eat every 3 hours. Never skip a meal. If you're not gaining, add an extra egg or PB toast._",
  };
  const tipLine = goalType ? goalTips[goalType] || "" : "";

  return `${greeting} your shopping list for the week.\n*Budget: ${list.budgetLabel}*${goalHeader ? "\n" + goalHeader : ""}\n${body}\n*Est. total: ${list.estimatedTotal}* (covers ${list.coversDays} days)\n\n*Meal ideas this week:*\n${ideas}${tipLine}\n\n_Tick off as you buy. Send me a photo of your groceries when you're done!_`;
}

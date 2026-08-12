// ============================================================
// KAMLIFE SHOPPING LIST TEMPLATES
// Budget-tiered weekly shopping lists for SA clients
// Delivered every Sunday with the weekly summary
// ============================================================

// PRICE_ESTIMATE_NOTE is the ONE owner of how a rand estimate is qualified to a client — the
// same sentence the GPT-generated rebuild now carries, so the two paths cannot drift apart.
import { PRICE_ESTIMATE_NOTE } from "./reply-contract";

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
  estimatedTotal: "~R360",
  coversDays: 7,
  items: [
    { item: "Eggs (1 dozen)", qty: "12", price: "R30", category: "protein" },
    { item: "Pilchards in tomato (4 tins)", qty: "4", price: "R48", category: "protein" },
    { item: "Chicken pieces (1kg)", qty: "1kg", price: "R45", category: "protein" },
    { item: "Chicken livers (500g)", qty: "500g", price: "R25", category: "protein" }, // iron + protein, cheapest quality offal
    { item: "Sugar beans (500g dry)", qty: "500g", price: "R18", category: "protein" },
    { item: "Maas / amasi (2L)", qty: "2L", price: "R30", category: "dairy" }, // protein + probiotic, real SA staple
    { item: "Brown bread (2 loaves)", qty: "2", price: "R30", category: "carb" },
    { item: "Rice (2kg)", qty: "2kg", price: "R30", category: "carb" },
    { item: "Oats (500g)", qty: "500g", price: "R25", category: "carb" },
    { item: "Pap / maize meal (2.5kg)", qty: "2.5kg", price: "R22", category: "carb" },
    { item: "Morogo / spinach (2 bunches)", qty: "2", price: "R16", category: "veg" }, // iron-dense green, authentic
    { item: "Cabbage (1 head)", qty: "1", price: "R12", category: "veg" },
    { item: "Frozen mixed veg (1kg)", qty: "1kg", price: "R25", category: "veg" },
    { item: "Tomatoes (6)", qty: "6", price: "R15", category: "veg" },
    { item: "Onions (1kg)", qty: "1kg", price: "R12", category: "veg" },
    { item: "Bananas (6)", qty: "6", price: "R12", category: "fruit" },
    { item: "Peanut butter (400g)", qty: "400g", price: "R30", category: "pantry" },
  ],
  mealIdeas: [
    "Breakfast: 2 eggs + morogo + pap — R10",
    "Lunch: Pilchards on brown bread + tomato — R14",
    "Dinner: Chicken livers + pap + cabbage — R22",
    "Snack: Maas + banana — R8",
  ],
};

const TIER_1_WEEK_B: ShoppingList = {
  tier: "under_100",
  budgetLabel: "Under R1,500/month",
  estimatedTotal: "~R340",
  coversDays: 7,
  items: [
    { item: "Eggs (18 pack)", qty: "18", price: "R40", category: "protein" },
    { item: "Pilchards in tomato (4 tins)", qty: "4", price: "R48", category: "protein" },
    { item: "Soya mince (400g)", qty: "400g", price: "R25", category: "protein" }, // quality protein per rand, meat-free stretch
    { item: "Sugar beans (500g dry)", qty: "500g", price: "R18", category: "protein" },
    { item: "Lentils (500g dry)", qty: "500g", price: "R20", category: "protein" }, // protein + fibre, cheap and clean
    { item: "Brown bread (2 loaves)", qty: "2", price: "R30", category: "carb" },
    { item: "Samp (1kg)", qty: "1kg", price: "R15", category: "carb" },
    { item: "Oats (500g)", qty: "500g", price: "R25", category: "carb" },
    { item: "Pap / maize meal (2.5kg)", qty: "2.5kg", price: "R22", category: "carb" },
    { item: "Spinach / morogo (2 bunches)", qty: "2", price: "R18", category: "veg" },
    { item: "Carrots (500g)", qty: "500g", price: "R8", category: "veg" },
    { item: "Butternut (1)", qty: "1", price: "R15", category: "veg" },
    { item: "Onions (1kg)", qty: "1kg", price: "R12", category: "veg" },
    { item: "Apples (6)", qty: "6", price: "R18", category: "fruit" },
    { item: "Peanut butter (400g)", qty: "400g", price: "R30", category: "pantry" },
  ],
  mealIdeas: [
    "Breakfast: Oats + peanut butter + banana — R8",
    "Lunch: Umngqusho (samp & beans) + morogo — R12",
    "Dinner: Soya mince stew + pap + carrots — R18",
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
    { item: "Baked beans (2 tins)", qty: "2", price: "R16", category: "protein" },
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
  under_50:  [TIER_1_WEEK_A, TIER_1_WEEK_B],   // DB stores this from onboarding
  "50_100":  [TIER_1_WEEK_A, TIER_1_WEEK_B],   // DB stores this from onboarding
  "100_300": [TIER_2_WEEK_A, TIER_2_WEEK_B],
  "300_600": [TIER_3_WEEK_A, TIER_3_WEEK_B],
  "300_500": [TIER_3_WEEK_A, TIER_3_WEEK_B],   // DB stores this from onboarding
  over_600:  [TIER_4_WEEK_A, TIER_4_WEEK_B],
  "500_plus":[TIER_4_WEEK_A, TIER_4_WEEK_B],   // DB stores this from onboarding
};

export function getShoppingList(budgetTier: string, weekNumber: number, goalType?: string): ShoppingList {
  const lists = ALL_LISTS[budgetTier] || ALL_LISTS["100_300"];
  const idx = (weekNumber - 1) % lists.length;
  const base = lists[idx];
  return goalType ? applyGoalModifications(base, goalType) : base;
}

export interface ShoppingListTargets {
  calorieTarget?: number;
  proteinTarget?: number;
  budgetTier?: string;
  // Optional "I've been watching what you eat" block (grocery-personalize.ts). When
  // present it's prepended after the intro so the prescriptive list feels personal.
  // Absent for brand-new clients (cold start) — the template leads alone.
  personalization?: string | null;
}

export function formatShoppingList(list: ShoppingList, userName?: string, goalType?: string, targets?: ShoppingListTargets): string {
  const fn = userName?.split(" ")[0] || "";
  const goal = goalType || "fat_loss";
  const kcal = targets?.calorieTarget || (goal === "muscle_gain" ? 2600 : 1700);
  const prot = targets?.proteinTarget || (goal === "muscle_gain" ? 160 : 120);

  // Goal-specific intro that names their actual targets
  const goalIntros: Record<string, string> = {
    fat_loss:    `Your goal is fat loss. Every day: *${kcal} kcal* and *${prot}g protein*. Protein keeps you full and protects muscle — hit that number first, calories second.`,
    muscle_gain: `Your goal is building muscle. Every day: *${kcal} kcal* and *${prot}g protein*. If you're not gaining, you're not eating enough — this list gives you what you need.`,
    recomposition: `Your goal is body recomp — hold weight, swap fat for muscle. Every day: *${kcal} kcal* and *${prot}g protein*. Consistency over weeks beats any single perfect day.`,
  };
  const intro = goalIntros[goal] || goalIntros["fat_loss"];

  // Personal "we know what you eat" block, when the client has logged enough to earn it.
  const personalBlock = targets?.personalization ? `\n\n${targets.personalization}` : "";

  // Store advice by budget tier
  const budgetTier = targets?.budgetTier || "100_300";
  const storeAdvice: Record<string, string> = {
    under_100:  `*Quality on any budget.* Eggs, pilchards, chicken livers, morogo, maas, beans — this is real, nutrient-dense food, not settling. Shoprite or Boxer are cheapest; buy the dry beans/lentils/samp in bulk and they last weeks.`,
    "50_100":   `*Quality on any budget.* Eggs, pilchards, chicken livers, morogo, maas, beans — this is real, nutrient-dense food, not settling. Shoprite or Boxer are cheapest; buy the dry beans/lentils/samp in bulk and they last weeks.`,
    "100_300":  `*Where to shop:* Pick n Pay or Checkers for the weekly run. Boxer/Shoprite for bulk items (oats, rice, eggs). Saves R80-150/week.`,
    "300_600":  `*Where to shop:* Checkers or Spar for convenience. Pick n Pay for bulk proteins. Woolworths for fresh veg if budget allows.`,
    over_600:   `*Where to shop:* Woolworths for quality cuts and fresh produce. Checkers for staples. Order online for bulk pantry items.`,
    "500_plus": `*Where to shop:* Woolworths for quality cuts and fresh produce. Checkers for staples. Order online for bulk pantry items.`,
  };
  const store = storeAdvice[budgetTier] || storeAdvice["100_300"];

  // Grouped items
  const grouped: Record<string, ShoppingItem[]> = {};
  for (const item of list.items) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push(item);
  }

  const categoryLabels: Record<string, string> = {
    protein: "🥩 Protein",
    carb: "🍚 Carbs",
    veg: "🥦 Vegetables",
    fruit: "🍌 Fruit",
    dairy: "🥛 Dairy",
    pantry: "🫙 Pantry",
    supplement: "💊 Supplements",
  };

  const order = ["protein", "carb", "veg", "fruit", "dairy", "pantry", "supplement"];
  let body = "";
  for (const cat of order) {
    const items = grouped[cat];
    if (!items || items.length === 0) continue;
    body += `\n*${categoryLabels[cat]}:*\n`;
    for (const i of items) {
      // "~" ON EVERY ITEM PRICE (Work Order D, 2026-08-12). These figures are hand-maintained
      // shelf estimates, not a live price feed — the type has said "estimated ZAR" since it was
      // written, but the CLIENT only ever saw "Eggs (1 dozen) — R30", which reads as a quoted
      // fact. A client who budgets against it and finds R38 at the till has been misled by us.
      // The week total already carried "est."; the line items now say the same thing.
      body += `• ${i.item} — ~${i.price}\n`;
    }
  }

  // Personalized daily structure based on goal and targets
  const protPerMeal = Math.round(prot / 4);
  const dailyStructures: Record<string, string> = {
    fat_loss: `*Your daily structure (hits ${kcal} kcal / ${prot}g protein):*
• Breakfast: 3 eggs + oats (½ cup dry) = ~400 kcal | ~30g protein
• Lunch: 150g chicken or 1 tin pilchards + rice (½ cup) + veg = ~450 kcal | ~${protPerMeal}g protein
• Dinner: 2 eggs or 100g chicken + sweet potato + veg = ~400 kcal | ~25g protein
• Snack: 2 boiled eggs or cottage cheese = ~180 kcal | ~16g protein`,
    muscle_gain: `*Your daily structure (hits ${kcal} kcal / ${prot}g protein):*
• Breakfast: 4 eggs + 1 cup oats + banana = ~680 kcal | ~40g protein
• Lunch: 200g chicken breast + 1 cup rice + veg = ~580 kcal | ~${protPerMeal}g protein
• Dinner: 200g chicken or mince + sweet potato + veg = ~560 kcal | ~42g protein
• Snack: 1 tin pilchards + 1 slice bread + 1 cup milk = ~380 kcal | ~35g protein`,
    recomposition: `*Your daily structure (hits ${kcal} kcal / ${prot}g protein):*
• Breakfast: 3 eggs + oats + fruit = ~520 kcal | ~32g protein
• Lunch: 150g chicken + rice + veg = ~480 kcal | ~${protPerMeal}g protein
• Dinner: 150g protein + sweet potato + big veg portion = ~450 kcal | ~35g protein
• Snack: Greek yoghurt or 2 eggs = ~180 kcal | ~18g protein`,
  };
  const dailyStructure = dailyStructures[goal] || dailyStructures["fat_loss"];

  const ideas = list.mealIdeas.map(m => `• ${m}`).join("\n");

  const avoidSection = (goal === "fat_loss" || goal === "recomposition")
    ? `\n\n*🚫 Leave these on the shelf:*\n• Sugary drinks (Coke, Oros, juice, flavoured water) — liquid calories you don't feel\n• Honey, syrup, white sugar — same impact as sweets; fruit handles your sweetness\n• Flavoured yoghurt — most have 15-25g added sugar; plain or Greek only\n• Breakfast cereals and instant oats with flavouring — mostly sugar in a box\n• Polony, Russians, Viennas — high sodium, minimal real protein\n• White bread if you can avoid it — brown bread only`
    : "";

  return `${fn ? fn + ", this" : "This"} is your full week.\n\n${intro}${personalBlock}\n\n${store}\n\n*What to buy (${list.estimatedTotal} est. — ${list.coversDays} days):*\n${PRICE_ESTIMATE_NOTE}${body}\n${dailyStructure}\n\n*Meal ideas to mix it up:*\n${ideas}${avoidSection}\n\n_Screenshot this. Tick off as you shop. Send me what you eat each day — photo or words — and I track the numbers.\n\nTo adjust: tell me what you don't eat, what you want to swap, or what you already have at home._`;
}

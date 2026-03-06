import { pool } from "./db";

export interface SAFood {
  name: string;
  aliases: string[];
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
  typicalPortionDescription: string;
  typicalPortionGrams: number;
  typicalPortionCalories: number;
  typicalPortionProtein: number;
  category: string;
  budgetTier: number;
  notes: string;
}

export const SA_FOODS_SEED: SAFood[] = [
  { name: "Pap (stiff maize porridge)", aliases: ["pap", "mieliepap", "stiff pap", "hard pap"], caloriesPer100g: 360, proteinPer100g: 7, carbsPer100g: 78, fatPer100g: 1.5, typicalPortionDescription: "1 cup cooked", typicalPortionGrams: 200, typicalPortionCalories: 330, typicalPortionProtein: 7, category: "carb", budgetTier: 1, notes: "SA staple. Low protein — always pair with a protein source." },
  { name: "Soft pap (porridge)", aliases: ["soft pap", "porridge pap", "pap porridge", "mealie meal porridge"], caloriesPer100g: 65, proteinPer100g: 1.5, carbsPer100g: 14, fatPer100g: 0.3, typicalPortionDescription: "1 bowl cooked", typicalPortionGrams: 250, typicalPortionCalories: 160, typicalPortionProtein: 4, category: "carb", budgetTier: 1, notes: "High water content when cooked. Good breakfast option." },
  { name: "Pilchards in tomato sauce", aliases: ["pilchards", "pilchard", "sardines", "lucky star", "glenryck"], caloriesPer100g: 150, proteinPer100g: 20, carbsPer100g: 3, fatPer100g: 7, typicalPortionDescription: "1 tin (215g)", typicalPortionGrams: 215, typicalPortionCalories: 215, typicalPortionProtein: 32, category: "protein", budgetTier: 1, notes: "Best value protein in SA. R12-15 per tin. Omega-3 rich." },
  { name: "Eggs", aliases: ["egg", "boiled egg", "scrambled eggs", "fried egg", "omelette"], caloriesPer100g: 155, proteinPer100g: 13, carbsPer100g: 1, fatPer100g: 11, typicalPortionDescription: "2 large eggs", typicalPortionGrams: 120, typicalPortionCalories: 186, typicalPortionProtein: 16, category: "protein", budgetTier: 1, notes: "R25-30 per dozen. Best protein-per-rand in SA. Boil or scramble." },
  { name: "Oats (Jungle Oats)", aliases: ["oats", "jungle oats", "oatmeal", "porridge", "rolled oats"], caloriesPer100g: 389, proteinPer100g: 17, carbsPer100g: 66, fatPer100g: 7, typicalPortionDescription: "1 cup dry (80g)", typicalPortionGrams: 80, typicalPortionCalories: 311, typicalPortionProtein: 14, category: "carb", budgetTier: 1, notes: "Best breakfast carb. Slow release. R30 for 500g lasts a week." },
  { name: "Sugar beans", aliases: ["sugar beans", "borlotti beans", "red beans", "beans"], caloriesPer100g: 337, proteinPer100g: 22, carbsPer100g: 61, fatPer100g: 1, typicalPortionDescription: "1 cup cooked (180g)", typicalPortionGrams: 180, typicalPortionCalories: 220, typicalPortionProtein: 15, category: "protein", budgetTier: 1, notes: "R20 dry 500g. Excellent protein+carb combo. Must cook from dry." },
  { name: "Baked beans", aliases: ["baked beans", "koo beans", "baked bean"], caloriesPer100g: 94, proteinPer100g: 5, carbsPer100g: 17, fatPer100g: 0.5, typicalPortionDescription: "1 tin (420g)", typicalPortionGrams: 420, typicalPortionCalories: 395, typicalPortionProtein: 21, category: "protein", budgetTier: 1, notes: "Convenient, affordable. Good protein for the price." },
  { name: "Brown bread", aliases: ["brown bread", "whole wheat bread", "bread"], caloriesPer100g: 250, proteinPer100g: 9, carbsPer100g: 47, fatPer100g: 3, typicalPortionDescription: "2 slices (60g)", typicalPortionGrams: 60, typicalPortionCalories: 150, typicalPortionProtein: 5, category: "carb", budgetTier: 1, notes: "Better than white. R15 per loaf. Pair with peanut butter or eggs." },
  { name: "Peanut butter", aliases: ["peanut butter", "pb", "peanut paste"], caloriesPer100g: 588, proteinPer100g: 25, carbsPer100g: 20, fatPer100g: 50, typicalPortionDescription: "2 tablespoons (30g)", typicalPortionGrams: 30, typicalPortionCalories: 176, typicalPortionProtein: 7, category: "protein", budgetTier: 1, notes: "R25-30. Calorie dense. Good fat and protein. Not a meal replacement." },
  { name: "Sweet potato", aliases: ["sweet potato", "sweet patata", "orange potato"], caloriesPer100g: 86, proteinPer100g: 2, carbsPer100g: 20, fatPer100g: 0.1, typicalPortionDescription: "1 medium (200g)", typicalPortionGrams: 200, typicalPortionCalories: 172, typicalPortionProtein: 4, category: "carb", budgetTier: 1, notes: "Low GI carb. Good for diabetics. Versatile and cheap." },
  { name: "Chicken thigh", aliases: ["chicken thigh", "chicken legs", "drumstick", "chicken pieces"], caloriesPer100g: 209, proteinPer100g: 26, carbsPer100g: 0, fatPer100g: 11, typicalPortionDescription: "1 large thigh (150g cooked)", typicalPortionGrams: 150, typicalPortionCalories: 314, typicalPortionProtein: 39, category: "protein", budgetTier: 2, notes: "Best value chicken cut. More flavourful than breast." },
  { name: "Chicken breast", aliases: ["chicken breast", "chicken fillet", "grilled chicken"], caloriesPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6, typicalPortionDescription: "1 medium breast (180g)", typicalPortionGrams: 180, typicalPortionCalories: 297, typicalPortionProtein: 56, category: "protein", budgetTier: 2, notes: "Highest protein content. Driest — marinate or add sauce." },
  { name: "Beef mince", aliases: ["beef mince", "mince", "ground beef", "minced meat"], caloriesPer100g: 230, proteinPer100g: 26, carbsPer100g: 0, fatPer100g: 14, typicalPortionDescription: "150g cooked portion", typicalPortionGrams: 150, typicalPortionCalories: 345, typicalPortionProtein: 39, category: "protein", budgetTier: 2, notes: "Versatile. Good for bolognaise, meatballs, stew. Medium fat." },
  { name: "Samp", aliases: ["samp", "crushed hominy corn", "dry samp"], caloriesPer100g: 360, proteinPer100g: 8, carbsPer100g: 76, fatPer100g: 1, typicalPortionDescription: "1 cup cooked (200g)", typicalPortionGrams: 200, typicalPortionCalories: 330, typicalPortionProtein: 8, category: "carb", budgetTier: 1, notes: "Traditional staple. Pair with beans — makes complete protein." },
  { name: "Umngqusho (samp and beans)", aliases: ["umngqusho", "samp and beans", "samp beans"], caloriesPer100g: 120, proteinPer100g: 6, carbsPer100g: 22, fatPer100g: 0.5, typicalPortionDescription: "1 cup cooked (250g)", typicalPortionGrams: 250, typicalPortionCalories: 300, typicalPortionProtein: 15, category: "carb", budgetTier: 1, notes: "Traditional Xhosa dish. Complete protein from beans+samp combination." },
  { name: "Morogo (wild spinach)", aliases: ["morogo", "wild spinach", "wild greens", "African spinach"], caloriesPer100g: 23, proteinPer100g: 3, carbsPer100g: 3, fatPer100g: 0.4, typicalPortionDescription: "1 cup cooked (150g)", typicalPortionGrams: 150, typicalPortionCalories: 35, typicalPortionProtein: 5, category: "vegetable", budgetTier: 1, notes: "High iron, high protein for a vegetable. Traditional staple." },
  { name: "Spinach", aliases: ["spinach", "baby spinach", "English spinach"], caloriesPer100g: 23, proteinPer100g: 2.9, carbsPer100g: 3.6, fatPer100g: 0.4, typicalPortionDescription: "1 cup cooked (150g)", typicalPortionGrams: 150, typicalPortionCalories: 35, typicalPortionProtein: 4, category: "vegetable", budgetTier: 1, notes: "Good iron and folate. Good for female clients." },
  { name: "Cabbage", aliases: ["cabbage", "green cabbage", "coleslaw"], caloriesPer100g: 25, proteinPer100g: 1.3, carbsPer100g: 5.8, fatPer100g: 0.1, typicalPortionDescription: "1 cup shredded (100g)", typicalPortionGrams: 100, typicalPortionCalories: 25, typicalPortionProtein: 1, category: "vegetable", budgetTier: 1, notes: "Cheapest vegetable available. Volume food for fat loss." },
  { name: "Vetkoek", aliases: ["vetkoek", "fat cake", "magwinya", "fat cakes"], caloriesPer100g: 360, proteinPer100g: 6, carbsPer100g: 48, fatPer100g: 16, typicalPortionDescription: "1 medium vetkoek (120g)", typicalPortionGrams: 120, typicalPortionCalories: 432, typicalPortionProtein: 7, category: "junk", budgetTier: 1, notes: "Deep fried bread. High calorie, low protein. Occasional treat only." },
  { name: "Kota (Durban bunny chow style)", aliases: ["kota", "quarter loaf", "bunny chow"], caloriesPer100g: 290, proteinPer100g: 10, carbsPer100g: 42, fatPer100g: 9, typicalPortionDescription: "1 quarter kota (350g)", typicalPortionGrams: 350, typicalPortionCalories: 1015, typicalPortionProtein: 35, category: "junk", budgetTier: 2, notes: "Large portion size. Calorie bomb. Add protein filling to make it better." },
  { name: "Polony", aliases: ["polony", "bologna", "lunch sausage"], caloriesPer100g: 270, proteinPer100g: 12, carbsPer100g: 10, fatPer100g: 22, typicalPortionDescription: "2 slices (60g)", typicalPortionGrams: 60, typicalPortionCalories: 162, typicalPortionProtein: 7, category: "junk", budgetTier: 1, notes: "High fat, processed meat. Low quality protein. Better options exist." },
  { name: "Viennas", aliases: ["viennas", "vienna sausages", "frankfurters", "hotdog"], caloriesPer100g: 290, proteinPer100g: 11, carbsPer100g: 5, fatPer100g: 26, typicalPortionDescription: "2 viennas (80g)", typicalPortionGrams: 80, typicalPortionCalories: 232, typicalPortionProtein: 9, category: "junk", budgetTier: 1, notes: "Highly processed. Better to choose eggs or pilchards." },
  { name: "Russians", aliases: ["russians", "russian sausage", "boerewors roll filling"], caloriesPer100g: 310, proteinPer100g: 12, carbsPer100g: 6, fatPer100g: 28, typicalPortionDescription: "1 russian (100g)", typicalPortionGrams: 100, typicalPortionCalories: 310, typicalPortionProtein: 12, category: "junk", budgetTier: 1, notes: "Processed meat. Better options available for same price." },
  { name: "KFC original chicken piece", aliases: ["kfc", "kfc chicken", "fried chicken", "kfc original", "street wise"], caloriesPer100g: 290, proteinPer100g: 20, carbsPer100g: 15, fatPer100g: 17, typicalPortionDescription: "1 original piece (130g)", typicalPortionGrams: 130, typicalPortionCalories: 377, typicalPortionProtein: 26, category: "junk", budgetTier: 2, notes: "Remove skin to save ~80 calories. Not terrible protein source if no skin." },
  { name: "Boerewors", aliases: ["boerewors", "wors", "braai wors", "boerew"], caloriesPer100g: 340, proteinPer100g: 18, carbsPer100g: 2, fatPer100g: 29, typicalPortionDescription: "1 coil (200g)", typicalPortionGrams: 200, typicalPortionCalories: 680, typicalPortionProtein: 36, category: "protein", budgetTier: 2, notes: "Good protein but high fat. Fine at a braai. Not daily food." },
  { name: "Biltong", aliases: ["biltong", "beef biltong", "droewors", "droë wors"], caloriesPer100g: 275, proteinPer100g: 55, carbsPer100g: 2, fatPer100g: 5, typicalPortionDescription: "50g portion", typicalPortionGrams: 50, typicalPortionCalories: 138, typicalPortionProtein: 28, category: "protein", budgetTier: 3, notes: "Excellent protein snack. Expensive but worth it as a snack." },
  { name: "Full cream milk", aliases: ["milk", "full cream milk", "whole milk"], caloriesPer100g: 61, proteinPer100g: 3.2, carbsPer100g: 4.7, fatPer100g: 3.3, typicalPortionDescription: "1 cup (250ml)", typicalPortionGrams: 250, typicalPortionCalories: 153, typicalPortionProtein: 8, category: "protein", budgetTier: 1, notes: "Good for muscle gain clients. Switch to low fat for fat loss." },
  { name: "Low fat milk", aliases: ["low fat milk", "2% milk", "slim milk"], caloriesPer100g: 42, proteinPer100g: 3.4, carbsPer100g: 5, fatPer100g: 1, typicalPortionDescription: "1 cup (250ml)", typicalPortionGrams: 250, typicalPortionCalories: 105, typicalPortionProtein: 9, category: "protein", budgetTier: 1, notes: "Better for fat loss. Same protein as full cream." },
  { name: "Low fat yoghurt", aliases: ["yoghurt", "yogurt", "low fat yoghurt", "plain yoghurt"], caloriesPer100g: 56, proteinPer100g: 5, carbsPer100g: 7, fatPer100g: 0.8, typicalPortionDescription: "175g container", typicalPortionGrams: 175, typicalPortionCalories: 98, typicalPortionProtein: 9, category: "protein", budgetTier: 2, notes: "Good protein snack. Choose plain over flavoured to avoid sugar." },
  { name: "Cottage cheese", aliases: ["cottage cheese", "low fat cottage cheese"], caloriesPer100g: 98, proteinPer100g: 11, carbsPer100g: 3, fatPer100g: 4, typicalPortionDescription: "100g portion", typicalPortionGrams: 100, typicalPortionCalories: 98, typicalPortionProtein: 11, category: "protein", budgetTier: 2, notes: "High protein, low calorie. Good for fat loss clients." },
  { name: "Maltabella", aliases: ["maltabella", "sorghum porridge", "mabele"], caloriesPer100g: 361, proteinPer100g: 11, carbsPer100g: 72, fatPer100g: 3, typicalPortionDescription: "1 bowl cooked (200g)", typicalPortionGrams: 200, typicalPortionCalories: 170, typicalPortionProtein: 6, category: "carb", budgetTier: 1, notes: "Traditional SA breakfast. Lower GI than pap. Good for diabetics." },
  { name: "Mageu", aliases: ["mageu", "mahewu", "amahewu", "non-alcoholic mageu"], caloriesPer100g: 55, proteinPer100g: 1, carbsPer100g: 12, fatPer100g: 0.4, typicalPortionDescription: "1 cup (250ml)", typicalPortionGrams: 250, typicalPortionCalories: 138, typicalPortionProtein: 3, category: "carb", budgetTier: 1, notes: "Traditional drink made from pap. Mostly carbs. Not protein rich." },
  { name: "Cool drink (cold drink)", aliases: ["cool drink", "cold drink", "coke", "pepsi", "fanta", "sprite", "fizzy drink", "soda"], caloriesPer100g: 42, proteinPer100g: 0, carbsPer100g: 11, fatPer100g: 0, typicalPortionDescription: "1 can (330ml)", typicalPortionGrams: 330, typicalPortionCalories: 139, typicalPortionProtein: 0, category: "junk", budgetTier: 1, notes: "Empty calories, zero protein. Switch to water. R12 per can wasted." },
  { name: "Banana", aliases: ["banana", "bananas"], caloriesPer100g: 89, proteinPer100g: 1.1, carbsPer100g: 23, fatPer100g: 0.3, typicalPortionDescription: "1 medium banana (120g)", typicalPortionGrams: 120, typicalPortionCalories: 107, typicalPortionProtein: 1, category: "carb", budgetTier: 1, notes: "Good pre-workout snack. Fast carbs. Potassium for muscle recovery." },
  { name: "Butternut", aliases: ["butternut", "butternut squash", "pumpkin"], caloriesPer100g: 45, proteinPer100g: 1, carbsPer100g: 11, fatPer100g: 0.1, typicalPortionDescription: "1 cup cooked (200g)", typicalPortionGrams: 200, typicalPortionCalories: 90, typicalPortionProtein: 2, category: "vegetable", budgetTier: 1, notes: "Good low-calorie carb. Very filling. Good for fat loss." },
  { name: "Chakalaka", aliases: ["chakalaka", "relish", "spicy relish"], caloriesPer100g: 55, proteinPer100g: 2, carbsPer100g: 8, fatPer100g: 2, typicalPortionDescription: "2 tablespoons (60g)", typicalPortionGrams: 60, typicalPortionCalories: 33, typicalPortionProtein: 1, category: "vegetable", budgetTier: 1, notes: "Spicy vegetable relish. Good condiment for pap meals." },
  { name: "Smileys (sheep head)", aliases: ["smileys", "sheep head", "smiley"], caloriesPer100g: 185, proteinPer100g: 25, carbsPer100g: 0, fatPer100g: 10, typicalPortionDescription: "1 half head (300g meat)", typicalPortionGrams: 300, typicalPortionCalories: 555, typicalPortionProtein: 75, category: "protein", budgetTier: 1, notes: "Traditional. Very high protein. Budget-friendly at street vendors." },
  { name: "Mogodu (tripe)", aliases: ["mogodu", "tripe", "offal", "intestines"], caloriesPer100g: 85, proteinPer100g: 14, carbsPer100g: 0, fatPer100g: 3, typicalPortionDescription: "1 cup cooked (200g)", typicalPortionGrams: 200, typicalPortionCalories: 170, typicalPortionProtein: 28, category: "protein", budgetTier: 1, notes: "Traditional. High protein, low calorie. Great for fat loss." },
  { name: "Brown rice", aliases: ["brown rice", "rice"], caloriesPer100g: 370, proteinPer100g: 8, carbsPer100g: 78, fatPer100g: 2, typicalPortionDescription: "1 cup cooked (200g)", typicalPortionGrams: 200, typicalPortionCalories: 220, typicalPortionProtein: 5, category: "carb", budgetTier: 1, notes: "Lower GI than white rice. Good carb source." },
  { name: "Stewing beef", aliases: ["stewing beef", "beef stew", "beef chunks", "oxtail adjacent"], caloriesPer100g: 250, proteinPer100g: 28, carbsPer100g: 0, fatPer100g: 15, typicalPortionDescription: "200g cooked portion", typicalPortionGrams: 200, typicalPortionCalories: 500, typicalPortionProtein: 56, category: "protein", budgetTier: 2, notes: "High protein. Good for stews. Needs long cooking." },
];

export async function initFoodsTable(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sa_foods (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        aliases TEXT[],
        calories_per_100g INTEGER,
        protein_per_100g DECIMAL,
        carbs_per_100g DECIMAL,
        fat_per_100g DECIMAL,
        typical_portion_description TEXT,
        typical_portion_grams INTEGER,
        typical_portion_calories INTEGER,
        typical_portion_protein DECIMAL,
        category TEXT,
        budget_tier INTEGER,
        notes TEXT
      );
    `);

    const count = await pool.query(`SELECT COUNT(*) FROM sa_foods;`);
    if (parseInt(count.rows[0].count) === 0) {
      for (const food of SA_FOODS_SEED) {
        await pool.query(
          `INSERT INTO sa_foods (name, aliases, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, typical_portion_description, typical_portion_grams, typical_portion_calories, typical_portion_protein, category, budget_tier, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [food.name, food.aliases, food.caloriesPer100g, food.proteinPer100g, food.carbsPer100g, food.fatPer100g, food.typicalPortionDescription, food.typicalPortionGrams, food.typicalPortionCalories, food.typicalPortionProtein, food.category, food.budgetTier, food.notes]
        );
      }
      console.log(`[FOODS] Seeded ${SA_FOODS_SEED.length} SA foods`);
    } else {
      console.log(`[FOODS] Table ready (${count.rows[0].count} foods)`);
    }
  } catch (err) {
    console.error("[FOODS] Init failed:", err);
  }
}

export interface FoodMatch {
  name: string;
  portionDescription: string;
  portionCalories: number;
  portionProtein: number;
  notes: string;
  category: string;
}

export async function queryFoodDatabase(foodName: string): Promise<FoodMatch[]> {
  try {
    const lower = foodName.toLowerCase().trim();
    const result = await pool.query(
      `SELECT name, typical_portion_description, typical_portion_calories, typical_portion_protein, notes, category
       FROM sa_foods
       WHERE LOWER(name) = $1
          OR $1 = ANY(SELECT LOWER(a) FROM UNNEST(aliases) AS a)
          OR LOWER(name) LIKE $2
          OR EXISTS (SELECT 1 FROM UNNEST(aliases) AS a WHERE LOWER(a) LIKE $2)
       LIMIT 3`,
      [lower, `%${lower}%`]
    );
    return result.rows.map((r: any) => ({
      name: r.name as string,
      portionDescription: r.typical_portion_description as string,
      portionCalories: parseInt(r.typical_portion_calories) as number,
      portionProtein: parseFloat(r.typical_portion_protein) as number,
      notes: r.notes as string,
      category: r.category as string,
    }));
  } catch (err) {
    console.error("[FOODS] Query error:", err);
    return [];
  }
}

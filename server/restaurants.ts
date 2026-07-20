/**
 * SA RESTAURANT ORDERING ENGINE — the "smart order at every restaurant" service.
 *
 * Like MenuFit, but built for South African chains and wired into the coach. Each restaurant
 * carries a CUTTING pick and a BULKING pick with real (approximate) macros, plus what to
 * avoid and one pro tip. The numbers are DETERMINISTIC on purpose — accurate macros are the
 * whole value, and an LLM guessing "520 kcal" is worse than useless. Goal decides which pick
 * leads: fat-loss/recomp gets the lean order first, muscle-gain gets the mass order first.
 *
 * Macros are careful estimates for a standard SA menu item — framed as "~" so a client never
 * treats them as lab-exact. Kept in one module (not the keyword wall) so it can grow to every
 * chain without bloating routing code.
 */

export interface RestaurantPick {
  order: string;
  kcal: number;
  protein: number;
}
export interface RestaurantGuide {
  name: string;          // display name
  aliases: string[];     // lowercased match tokens
  cut: RestaurantPick;   // lean, high-protein, low-cal — for fat loss / recomp
  bulk: RestaurantPick;  // higher-cal, high-protein — for muscle gain
  avoid: string;
  tip: string;
}

// Flame-grilled chicken chains share a shape; burger/pizza/fish each their own.
export const SA_RESTAURANTS: RestaurantGuide[] = [
  { name: "Nando's", aliases: ["nando", "nandos"],
    cut: { order: "1/4 chicken (breast, no skin) + corn on the cob + side salad", kcal: 420, protein: 45 },
    bulk: { order: "1/2 chicken (no skin) + Portuguese roll + corn", kcal: 780, protein: 70 },
    avoid: "Espetada with creamy mash, halloumi-loaded anything, garlic bread (~400 kcal)",
    tip: "Peri-peri sauce on the side. Lemon & herb is the lowest-cal basting." },
  { name: "KFC", aliases: ["kfc"],
    cut: { order: "Streetwise 2 (remove the skin) + side salad", kcal: 360, protein: 34 },
    bulk: { order: "3-piece + regular chips + corn", kcal: 900, protein: 55 },
    avoid: "Dunked wings, any 'loaded' box, large chips, Krushers",
    tip: "The skin is ~150 kcal a piece — pull it off, the protein's underneath." },
  { name: "Steers", aliases: ["steers"],
    cut: { order: "Original single (no cheese), extra salad, skip the chips", kcal: 450, protein: 30 },
    bulk: { order: "King Steer (no mayo) + regular chips", kcal: 950, protein: 48 },
    avoid: "Double/triple burgers, ribs combo, milkshakes",
    tip: "A King Steer combo is ~1,800 kcal — that's a whole day. Lose the chips or go single." },
  { name: "Spur", aliases: ["spur"],
    cut: { order: "200g rump + baked potato (no butter) + garden salad", kcal: 480, protein: 45 },
    bulk: { order: "300g rump + baked potato + salad + side of chicken strips", kcal: 780, protein: 65 },
    avoid: "Ribs combo, cheese sauce, nachos starter, loaded burgers",
    tip: "Sauces add 200–400 kcal — get them on the side. The steak itself is great protein." },
  { name: "Wimpy", aliases: ["wimpy"],
    cut: { order: "Grilled chicken + rice + salad", kcal: 450, protein: 40 },
    bulk: { order: "Grilled chicken + rice + a breakfast of eggs & bacon on the side", kcal: 750, protein: 60 },
    avoid: "Double-thick shakes, cheese-and-bacon burgers, onion rings",
    tip: "Breakfast (eggs + bacon + tomato, skip the toast & banger) = ~30g protein for little money." },
  { name: "McDonald's", aliases: ["mcdonald", "mcdonalds", "maccas"],
    cut: { order: "Grilled chicken wrap + water", kcal: 380, protein: 27 },
    bulk: { order: "Big Mac (no sauce) + extra grilled chicken patty", kcal: 800, protein: 50 },
    avoid: "Large McFlurry (~600 kcal), large fries (~450 kcal), 'Grand' anything",
    tip: "No mayo on any burger saves ~120 kcal instantly; water over Coke saves ~200 more." },
  { name: "Burger King", aliases: ["burger king", "bk"],
    cut: { order: "Flame-grilled chicken burger (no mayo) + side salad", kcal: 400, protein: 30 },
    bulk: { order: "Double Whopper (no mayo)", kcal: 900, protein: 50 },
    avoid: "King-size meals, onion rings, crispy over grilled",
    tip: "Grilled chicken over crispy saves ~150 kcal for the same protein." },
  { name: "Debonairs", aliases: ["debonair", "debonairs"],
    cut: { order: "3 slices of a small chicken pizza on thin base, extra veg, blot the oil", kcal: 520, protein: 30 },
    bulk: { order: "Half a medium chicken-&-beef pizza, thin base", kcal: 850, protein: 50 },
    avoid: "Triple-Decker, Crammed Crust, stuffed crust — the crust is the calorie bomb",
    tip: "Thin base, a protein topping (chicken/beef), load the veg, skip extra cheese, blot the top." },
  { name: "Roman's Pizza", aliases: ["roman", "romans"],
    cut: { order: "3 slices of a regular chicken pizza, thin base, extra veg", kcal: 520, protein: 30 },
    bulk: { order: "Half a large chicken pizza (thin base)", kcal: 900, protein: 52 },
    avoid: "The two-for-one trap — a whole large each is 2,000+ kcal; stuffed crust",
    tip: "Split the deal or box half for tomorrow. Thin base + veg + a protein topping." },
  { name: "Galito's", aliases: ["galito", "galitos"],
    cut: { order: "1/4 chicken (breast, no skin) + side salad", kcal: 420, protein: 45 },
    bulk: { order: "1/2 flame-grilled chicken + roll", kcal: 760, protein: 68 },
    avoid: "Creamy sides, cheesy chips, crumbed anything",
    tip: "Flame-grilled, sauce on the side — same play as Nando's." },
  { name: "Hungry Lion", aliases: ["hungry lion"],
    cut: { order: "2-piece flame-grilled (remove skin) + corn", kcal: 400, protein: 32 },
    bulk: { order: "3-piece + regular chips", kcal: 850, protein: 50 },
    avoid: "Crunchers, loaded boxes, large chips, big fizzy drinks",
    tip: "Choose flame-grilled over fried where they offer it; corn side over chips." },
  { name: "Fishaways", aliases: ["fishaway", "fishaways", "fish aways"],
    cut: { order: "Grilled hake + Greek salad (no chips)", kcal: 350, protein: 35 },
    bulk: { order: "Grilled hake + grilled calamari + rice", kcal: 650, protein: 55 },
    avoid: "Crumbed/battered fish, deep-fried calamari, large chips",
    tip: "Ask for it grilled, not fried — the batter is where the calories hide." },
  { name: "Chicken Licken", aliases: ["chicken licken", "licken"],
    cut: { order: "2-piece (pull off the coating) + corn — keep it small", kcal: 420, protein: 32 },
    bulk: { order: "Hotwings + corn + a small chips", kcal: 800, protein: 48 },
    avoid: "Soul Fries loaded, Rock My Soul boxes, big Sprites",
    tip: "It's fried, so portion is everything — smaller box, a corn side, skip the coating where you can." },
  { name: "Barcelos", aliases: ["barcelo", "barcelos"],
    cut: { order: "1/4 flame-grilled chicken (breast, no skin) + salad", kcal: 420, protein: 45 },
    bulk: { order: "1/2 chicken + Portuguese roll", kcal: 770, protein: 68 },
    avoid: "Cheesy/creamy sides, crumbed options, loaded chips",
    tip: "Flame-grilled chicken, peri on the side — a clean high-protein win." },
  { name: "Ocean Basket", aliases: ["ocean basket"],
    cut: { order: "Grilled linefish or hake + Greek salad", kcal: 400, protein: 40 },
    bulk: { order: "Grilled seafood (hake + prawns + calamari, all grilled) + rice", kcal: 720, protein: 58 },
    avoid: "Fried platters, deep-fried calamari, creamy/lemon-butter sauces",
    tip: "Grill everything, lemon over tartar — the sauces and batter are the trap." },
  { name: "RocoMamas", aliases: ["rocomama", "rocomamas", "roco"],
    cut: { order: "Grilled chicken burger (no mayo, no cheese) + side salad", kcal: 500, protein: 35 },
    bulk: { order: "Smash burger (single patty) + a grilled chicken add-on", kcal: 850, protein: 55 },
    avoid: "Reckless stacked smashes, cheese fries, loaded nachos",
    tip: "Single patty, grilled add-ons for protein, skip the mountain toppings." },
  { name: "Pedros", aliases: ["pedro", "pedros"],
    cut: { order: "1/4 flame-grilled chicken (breast) + salad or roll", kcal: 450, protein: 45 },
    bulk: { order: "1/2 flame-grilled chicken + chips", kcal: 820, protein: 65 },
    avoid: "Cheesy chips, creamy sides, oversized combos",
    tip: "Flame-grilled chicken is the whole point here — peri sauce on the side." },
  { name: "Kauai", aliases: ["kauai"],
    cut: { order: "Grilled chicken bowl (e.g. Bootcamp) — hold the heavy dressing", kcal: 450, protein: 40 },
    bulk: { order: "Grilled chicken bowl + extra chicken + a side", kcal: 700, protein: 58 },
    avoid: "Fruit-heavy smoothies as a 'meal' (sugar), mayo-loaded wraps",
    tip: "Bowls over wraps, dressing on the side — 'healthy' spots still hide calories in sauce & juice." },
];

/** Find the restaurant a message names, if any. */
export function matchRestaurant(m: string): RestaurantGuide | null {
  const lower = m.toLowerCase();
  for (const r of SA_RESTAURANTS) {
    if (r.aliases.some((a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower))) return r;
  }
  return null;
}

/** Names we cover — for the "which restaurants can you help with" answer. */
export function listRestaurantNames(): string[] {
  return SA_RESTAURANTS.map((r) => r.name);
}

/** Goal-aware smart-order card. Fat-loss/recomp leads with the lean pick; muscle-gain leads with mass. */
export function formatRestaurantGuide(r: RestaurantGuide, goal: string): string {
  const bulking = goal === "muscle_gain";
  const lead = bulking ? r.bulk : r.cut;
  const other = bulking ? r.cut : r.bulk;
  const leadLabel = bulking ? "Best for building" : "Best for fat loss";
  const otherLabel = bulking ? "Leaner option" : "Need more (training day / bigger appetite)";
  return `*${r.name} — smart order*\n\n`
    + `✅ *${leadLabel}:* ${lead.order}\n~${lead.kcal} kcal · ~${lead.protein}g protein\n\n`
    + `🔸 *${otherLabel}:* ${other.order}\n~${other.kcal} kcal · ~${other.protein}g protein\n\n`
    + `❌ *Skip:* ${r.avoid}\n\n`
    + `💡 ${r.tip}\n\n`
    + `_Numbers are close estimates — send me a photo of your plate when it lands and I'll log it properly._`;
}

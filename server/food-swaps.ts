/**
 * SA SHELF SWAPS — the substitution engine (2026-07-09, Kam: the bot must intelligently
 * give the CORRECT South-African shelf swap for a food, based on the client's goal —
 * "anything that says ZERO SUGAR is your friend"). Deterministic and consistent, so the
 * swap is right every time instead of the model improvising a different answer each ask.
 *
 * Each rule matches a common "could-be-better" food and returns the real shelf
 * alternative + a plain one-line reason. Goal-gated where it matters (full-cream milk is
 * fine for muscle gain, a swap for fat loss). Kept plain — a gogo must get it instantly.
 */

export type FoodSwap = { swap: string; reason: string };
type GoalType = "fat_loss" | "muscle_gain" | "recomposition";

type SwapRule = {
  match: RegExp;
  goals?: GoalType[]; // if set, only suggest for these goals; omit = all goals
  swap: string;
  reason: string;
};

// Ordered most-specific → most-general. First match wins.
const SWAP_RULES: SwapRule[] = [
  // Sugary fizzy drinks → the Zero Sugar version. Exclude anything already zero/light.
  {
    match: /\b(coke|coca.?cola|pepsi|fanta|sprite|stoney|sparletta|cream ?soda|iron ?brew|lemon ?twist|schweppes|cool.?drink|cold.?drink|fizzy|soft.?drink|soda(?! water))\b/i,
    swap: "the Zero Sugar version — Coke Zero, Sprite Zero, anything that says ZERO SUGAR",
    reason: "same taste, no sugar, no calories",
  },
  // Sugary juice / squash → zero-sugar squash or water.
  {
    match: /\b(oros|squash|safari|liqui.?fruit|liquifruit|fruit ?juice|nectar|clover ?krush|ceres|juice)\b/i,
    swap: "a zero-sugar squash, or just water",
    reason: "juice is basically sugar water — the fruit itself is better",
  },
  // Energy drinks → sugar-free version.
  {
    match: /\b(monster(?! ultra| zero)|red ?bull(?! zero| sugar)|score energy|dragon|switch|play energy|lucozade)\b/i,
    swap: "the sugar-free version (Monster Ultra, Red Bull Sugarfree)",
    reason: "the regular ones are loaded with sugar",
  },
  // Sports drinks → water (for everyday use; they're for endurance athletes mid-session).
  {
    match: /\b(energade|powerade|gatorade|game (?:energy )?drink|isotonic|sports? drink|vitamin water|glaceau)\b/i,
    swap: "water — or a pinch of salt + squeeze of lemon in water if you've trained hard",
    reason: "these are sugar water unless you're doing 90+ min of hard exercise",
  },
  // Instant / 2-minute noodles → bulk them with real protein & veg instead of removing.
  {
    match: /\b(2.?minute noodles|two.?minute noodles|instant noodles|indomie|maggi noodles|mama noodles|ramen)\b/i,
    swap: "the same noodles but crack an egg in and throw a handful of veg — skip half the flavour sachet (it's mostly salt)",
    reason: "on their own they're empty carbs and salt; egg + veg makes it a real meal",
  },
  // Potato crisps / corn snacks → popcorn or nuts (a real portion, less grease/salt).
  {
    match: /\b(simba|lay'?s|doritos|nik ?naks|cheese ?curls|fritos|messaris|potato ?crisps|crisps|chip ?packet|packet of chips)\b/i,
    swap: "air-popped popcorn or a small handful of nuts",
    reason: "same crunch, far less grease and salt, and it actually fills you",
  },
  // Atchar / oily pickle → a spoon, not a scoop (it's mostly oil).
  {
    match: /\b(atchar|achar|mango pickle)\b/i,
    goals: ["fat_loss", "recomposition"],
    swap: "just a small spoon of it, or fresh tomato-and-onion relish instead",
    reason: "atchar is delicious but it's swimming in oil — the calories add up fast",
  },
  // Fried/takeaway chicken → grilled. Plain "chicken" is never touched — only fried.
  {
    match: /\b(kfc|chicken licken|fried chicken|crispy chicken|hot ?wings|zinger|deep.?fried chicken)\b/i,
    swap: "grilled or flame-grilled chicken (Nando's, or braai it at home)",
    reason: "same chicken, but grilling drops a huge amount of hidden oil",
  },
  // Wors roll / boerewors → a leaner cut (fat loss only; wors is a fatty cut).
  {
    match: /\b(wors roll|boerewors|boere?wors|wors)\b/i,
    goals: ["fat_loss", "recomposition"],
    swap: "grilled chicken, a lean steak, or lean mince",
    reason: "boerewors is one of the fattier meats — lean protein fills you for fewer calories",
  },
  // Pies (steak/chicken/pepper) → lean protein + starch (fat loss).
  {
    match: /\b(steak pies?|chicken pies?|pepper ?steak pies?|cornish pies?|meat pies?|pies?(?! chart))\b/i,
    goals: ["fat_loss", "recomposition"],
    swap: "the same filling on brown bread or with rice — skip the pastry",
    reason: "the pastry is where most of a pie's fat and calories hide",
  },
  // Samoosas / spring rolls (deep-fried) → baked, or fewer (fat loss).
  {
    match: /\b(samoosa|samosa|spring roll|deep.?fried snack)\b/i,
    goals: ["fat_loss", "recomposition"],
    swap: "baked samoosas, or just have two instead of a plate",
    reason: "deep-frying soaks them in oil you can't see",
  },
  // Kota / bunny chow / gatsby → downsize + add protein (fat loss).
  {
    match: /\b(kota|spatlo|bunny chow|gatsby)\b/i,
    goals: ["fat_loss", "recomposition"],
    swap: "the small size, load it with egg or chicken for protein, and go easy on the chips inside",
    reason: "it's mostly white bread + chips — real protein makes it a meal, not just carbs",
  },
  // Mageu / sweet sorghum drink → maas or low-fat milk (it's high sugar).
  {
    match: /\b(mageu|magou|maheu|amahewu|sweet sorghum drink)\b/i,
    goals: ["fat_loss", "recomposition"],
    swap: "maas (amasi) or low-fat milk",
    reason: "mageu is filling but sugary — maas gives you the protein without the sugar hit",
  },
  // Sugar in tea/coffee → cut it down or use a sweetener.
  {
    match: /\b(sugar in (?:my )?(?:tea|coffee)|\d+\s*(?:spoons?|sugars?)\s+(?:of sugar\s+)?in|teaspoons? of sugar|tsp sugar)\b/i,
    swap: "half the sugar (drop one spoon a week) or a zero-calorie sweetener",
    reason: "two sugars in three teas a day is its own little pile of calories every week",
  },
  // Condensed / evaporated milk → low-fat milk.
  {
    match: /\b(condensed milk|evaporated milk|ideal milk|nestle cream)\b/i,
    goals: ["fat_loss", "recomposition"],
    swap: "low-fat milk (or a little maas)",
    reason: "condensed milk is basically milk plus a load of sugar",
  },
  // Brick margarine / heavy spread → a scrape, or use less (fat loss).
  {
    match: /\b(margarine|rama|stork|flora|brick margarine|blue ?band)\b/i,
    goals: ["fat_loss", "recomposition"],
    swap: "a thin scrape, or mashed avo / low-fat spread",
    reason: "spreads are almost pure fat — a thick layer adds calories fast",
  },
  // Processed meat → real protein for the same money.
  {
    match: /\b(polony|russian|vienna|frankfurter|cocktail sausage|smoked sausage|bacon|ham(?!burger)|luncheon|spam|viennas)\b/i,
    swap: "tinned pilchards, tuna, or eggs",
    reason: "real protein for the same money, without the processed fat",
  },
  // Coffee creamer → low-fat milk.
  {
    match: /\b(cremora|coffee.?mate|creamer|whitener|ellis ?brown)\b/i,
    swap: "a splash of low-fat milk",
    reason: "creamer hides a lot of fat and sugar in your coffee",
  },
  // Full-cream milk → low-fat (fat loss only; muscle gain keeps it).
  {
    match: /\b(full.?cream milk|full.?fat milk|whole milk)\b/i,
    goals: ["fat_loss", "recomposition"],
    swap: "low-fat milk",
    reason: "same protein, less fat",
  },
  // White bread → brown / low-GI.
  {
    match: /\b(white bread|white loaf|white roll|white toast)\b/i,
    swap: "brown, seed, or low-GI bread",
    reason: "keeps you fuller for longer",
  },
  // Sugary cereal → oats / Weet-Bix.
  {
    match: /\b(coco ?pops|frosties|honey ?(pops|crunch|smacks)|sugar ?pops|rice ?krispies|corn ?flakes|strawberry ?pops)\b/i,
    swap: "oats or Weet-Bix",
    reason: "more fibre, far less sugar",
  },
  // Slap chips / fries → baked or air-fried.
  {
    match: /\b(slap ?chips|hot ?chips|french ?fries|potato ?fries|fries)\b/i,
    swap: "a baked or air-fried potato",
    reason: "same potato, a fraction of the oil",
  },
  // Deep-fried dough → steamed / brown bread.
  {
    match: /\b(vetkoek|magwinya|fat ?cake|amagwinya|fried ?dough)\b/i,
    swap: "steamed bread (ujeqe) or brown bread",
    reason: "not deep-fried, so far fewer hidden calories",
  },
  // Full-fat / flavoured yoghurt → plain low-fat.
  {
    match: /\b(flavoured yoghurt|fruit yoghurt|full.?fat yoghurt|double.?cream yoghurt|custard)\b/i,
    swap: "plain low-fat yoghurt (add your own fruit)",
    reason: "skips the spoons of added sugar",
  },
  // Mayo → light (fat loss).
  {
    match: /\b(mayonnaise|mayo)\b/i,
    goals: ["fat_loss", "recomposition"],
    swap: "light mayo, or just less of it",
    reason: "regular mayo is almost all oil",
  },
  // Sour cream → plain yoghurt.
  {
    match: /\b(sour ?cream)\b/i,
    swap: "plain low-fat yoghurt",
    reason: "same creamy tang, much less fat",
  },
  // Ice cream → froyo / smaller (fat loss).
  {
    match: /\b(ice ?cream|soft ?serve)\b/i,
    goals: ["fat_loss", "recomposition"],
    swap: "low-fat frozen yoghurt, or a smaller scoop",
    reason: "the treat stays, the calories drop",
  },
  // ── 2026-07-17, founder's real coaching swaps ("that's how I make my adjustments") ──
  // Banana → berries (fat loss only — a banana is GOOD food, just calorie-dense).
  {
    match: /\b(bananas?)\b/i,
    goals: ["fat_loss", "recomposition"],
    swap: "a cup of berries (fresh or frozen), or half the banana",
    reason: "berries fill the same fruit craving for about a third of the calories",
  },
  // Nuts → a palm-sized portion, not the packet (fat loss; healthy but dense).
  {
    match: /\b(nuts|peanuts|almonds|cashews|macadamias?|pecans?|walnuts|mixed nuts|trail mix)\b/i,
    goals: ["fat_loss", "recomposition"],
    swap: "a small handful — what fits in your palm — not the packet",
    reason: "nuts are healthy but heavy: one packet can be a whole meal's calories",
  },
  // Avocado → half, not the whole (fat loss; same logic — good fat, dense).
  {
    match: /\b(avocados?|avos?)\b/i,
    goals: ["fat_loss", "recomposition"],
    swap: "half an avo instead of the whole one",
    reason: "great fat, but a whole avo carries real calories — half gives the taste and the benefit",
  },
];

// Zero/diet/light variants must never be told to swap — they're already the answer.
const ALREADY_GOOD_RE = /\b(zero|sugar.?free|sugarfree|diet|light|lite|low.?fat|skim|fat.?free|no sugar)\b/i;

/**
 * Given a food name (as logged) and the client's goal, return the correct SA shelf
 * swap, or null if the food is already a good choice or has no better shelf option.
 */
export function suggestSwap(foodName: string, goalType?: string | null): FoodSwap | null {
  const name = (foodName || "").toLowerCase();
  if (!name.trim() || ALREADY_GOOD_RE.test(name)) return null;
  const goal = (goalType || "").toLowerCase();
  for (const rule of SWAP_RULES) {
    if (!rule.match.test(name)) continue;
    if (rule.goals && !rule.goals.includes(goal as GoalType)) continue;
    return { swap: rule.swap, reason: rule.reason };
  }
  return null;
}

/**
 * A plain, kind, one-line "for next time" nudge built from a swap — never shaming,
 * always framed forward. Returns "" if there's no useful swap.
 */
export function swapNudge(foodName: string, goalType?: string | null): string {
  const s = suggestSwap(foodName, goalType);
  if (!s) return "";
  return `_Next time: swap it for ${s.swap} — ${s.reason}._`;
}

// ── SWAP QUESTIONS (2026-07-17, founder: "clients literally send pictures from the
// grocery store asking what alternatives — eat this instead of that IS the coaching").
// The ASK form ("what can I use instead of mayo?") used to fall to the model, which
// improvised a different answer each time. Deterministic: parse the food out of the
// question, answer from the ONE swap table. Unknown food → null (Coach K's judgement).

const SWAP_ASK_RE = /\b(?:instead of|alternatives?\s+(?:to|for)|substitutes?\s+(?:for|to)|replacements?\s+for|replace|healthier\s+(?:option|choice|version|alternative)\s+(?:than|of|for|to)|swap\s+(?:out\s+)?(?:for\s+)?)\s*(?:my |the |some |a |an )?([a-z][a-z' \-]{1,40}?)(?:\s*[?.!,]|\s+(?:with|for|then|so|please|guys)\b|$)/i;

/** Extract the food a swap-question is about, or null when it isn't a swap ask. */
export function parseSwapAsk(message: string): string | null {
  const m = (message || "").match(SWAP_ASK_RE);
  if (!m) return null;
  const food = m[1].trim().replace(/\s+/g, " ");
  return food.length >= 2 ? food : null;
}

/** Full deterministic answer to a swap ask, or null to let Coach K handle it. */
export function answerSwapAsk(message: string, goalType?: string | null): string | null {
  const food = parseSwapAsk(message);
  if (!food) return null;
  const s = suggestSwap(food, goalType);
  if (!s) return null;
  return `Instead of ${food}: *${s.swap}* — ${s.reason}. 👌`;
}

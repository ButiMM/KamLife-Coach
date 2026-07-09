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

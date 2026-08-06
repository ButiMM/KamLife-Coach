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

/* ────────────────────────────────────────────────────────────────────────────
 * SHOPPING SUBSTITUTIONS (2026-08-05) — a different question from the swaps above.
 *
 * Everything above answers "this is worse for your goal, eat that instead". This answers
 * "the shop didn't have it / I can't afford it — what does the same job?" Those are not the
 * same question, and the founder's clients ask the second one far more often: chicken was
 * finished, mince was there, is that alright.
 *
 * Deterministic table, no model. Substitution is a knowledge lookup, not a judgement, and a
 * client standing in a Shoprite aisle needs an answer in one second for R0.
 *
 * Grouped by the JOB the food does — protein, starch, veg, fat, dairy — because that is what
 * has to be replaced. Amounts are deliberately absent: "same size portion" is what a person
 * can act on without a scale, and the scanner prices whatever they actually log.
 * ──────────────────────────────────────────────────────────────────────────── */
export type Substitution = { alt: string; note: string };

const SUBSTITUTES: Array<{ match: RegExp; sub: Substitution }> = [
  // ── PROTEIN — the job that matters most, and the one clients panic about ──
  { match: /\b(chicken breast|chicken|braai pack|drumsticks?)\b/i,
    sub: { alt: "lean mince, tinned pilchards, or eggs", note: "same protein job, and usually cheaper per gram" } },
  { match: /\b(beef|steak|mince)\b/i,
    sub: { alt: "chicken, soya mince, or tinned fish", note: "same protein, lighter on the pocket" } },
  { match: /\b(fish|hake|snoek|tinned fish|pilchards?|tuna)\b/i,
    sub: { alt: "eggs, chicken, or tinned baked beans", note: "protein is protein — take what the shop has" } },
  { match: /\b(eggs?)\b/i,
    sub: { alt: "tinned pilchards, chicken, or beans", note: "same protein for roughly the same money" } },
  { match: /\b(biltong|dro[ëe]wors)\b/i,
    sub: { alt: "boiled eggs or a tin of pilchards", note: "the protein without the biltong price" } },
  // ── STARCH — filling, cheap, and interchangeable ──
  { match: /\b(rice)\b/i, sub: { alt: "pap, samp, or potatoes", note: "same job on the plate, same size portion" } },
  { match: /\b(pap|maize meal|mealie meal)\b/i, sub: { alt: "rice, samp, or potatoes", note: "same job on the plate" } },
  { match: /\b(bread|brown bread)\b/i, sub: { alt: "provitas, oats, or a potato", note: "same starch, and oats keep you full longer" } },
  { match: /\b(potatoes?|sweet potatoes?)\b/i, sub: { alt: "rice, pap, or samp", note: "swap freely — they do the same work" } },
  { match: /\b(oats|porridge)\b/i, sub: { alt: "maltabella, weetbix, or brown bread", note: "same breakfast starch" } },
  { match: /\b(pasta|macaroni|spaghetti)\b/i, sub: { alt: "rice or samp", note: "same starch, usually cheaper" } },
  { match: /\b(samp)\b/i, sub: { alt: "rice or pap", note: "same starch, quicker to cook" } },
  // ── VEG — never skip it because one thing was missing ──
  { match: /\b(spinach|morogo)\b/i, sub: { alt: "cabbage, or any frozen mixed veg", note: "cabbage is the cheapest green in the shop" } },
  { match: /\b(broccoli|green beans)\b/i, sub: { alt: "cabbage, carrots, or frozen mixed veg", note: "frozen counts — it is picked riper than fresh" } },
  { match: /\b(salad|lettuce|tomatoes?)\b/i, sub: { alt: "cucumber, cabbage, or tinned tomatoes", note: "any veg beats no veg" } },
  { match: /\b(carrots?|butternut|pumpkin)\b/i, sub: { alt: "any frozen mixed veg", note: "same job, keeps for months" } },
  // ── FAT + DAIRY ──
  { match: /\b(olive oil|avocado|avo)\b/i, sub: { alt: "sunflower oil used sparingly, or peanut butter", note: "same fat job at a fraction of the price" } },
  { match: /\b(milk)\b/i, sub: { alt: "long-life milk or maas", note: "same protein and calcium, keeps longer" } },
  { match: /\b(yoghurt|greek yoghurt)\b/i, sub: { alt: "maas or plain double-cream yoghurt", note: "maas is the SA original and costs less" } },
  { match: /\b(cheese)\b/i, sub: { alt: "eggs or a tin of pilchards", note: "cheaper protein, less saturated fat" } },
  { match: /\b(peanut butter)\b/i, sub: { alt: "any nut butter, or eggs for the protein", note: "same fat and protein job" } },
];

/**
 * Did they say the shop LET THEM DOWN, rather than asking whether a food is good for them?
 * "Couldn't find", "they didn't have", "too expensive", "out of stock", "finished".
 */
export const UNAVAILABLE_RE = /\b(could ?n[o']?t find|couldn t find|did ?n[o']?t have|don't have|dont have|no more|out of stock|sold out|finished|too expensive|can'?t afford|too pricey|nothing left|they were out)\b/i;

/** The substitution for a named food, or null when we have nothing honest to offer. */
export function substituteFor(foodName: string): Substitution | null {
  const f = (foodName || "").toLowerCase().trim();
  if (!f) return null;
  for (const row of SUBSTITUTES) if (row.match.test(f)) return row.sub;
  return null;
}

/**
 * A full answer to "the shop didn't have X", or null to let the coach handle it.
 *
 * Only fires on an availability/price complaint that NAMES a food we know. Everything else —
 * including a plain "what should I eat instead of chips" — belongs to the goal-swap table
 * above, which answers a different question and is checked first by the caller.
 */
export function answerUnavailable(message: string): string | null {
  const m = (message || "");
  if (!UNAVAILABLE_RE.test(m)) return null;
  for (const row of SUBSTITUTES) {
    const hit = m.match(row.match);
    if (hit) {
      return `No stress — *${row.sub.alt}* instead. ${row.sub.note.charAt(0).toUpperCase()}${row.sub.note.slice(1)}. 👌`;
    }
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * "CAN I EAT THIS?" — a grounded verdict on a packaged product (2026-08-05).
 *
 * The question clients actually send, with a photo of a label: is this cool, can I have it
 * consistently, which of these two. The founder answers it by hand all day — "anything zero
 * sugar", "good choice", "let me see the back" — and "let me see the back" is the whole
 * method: the answer lives in the numbers on the label, not in a feeling about the product.
 *
 * So this takes the LABEL'S OWN NUMBERS and that client's goal, and returns yes/no + how
 * often + how much. Never "sure, in moderation" — that is the fluff this exists to replace.
 *
 * Deterministic on purpose. A verdict a client will repeat to themselves in a shop for months
 * must not change because a model sampled differently on Tuesday.
 *
 * Thresholds are per SERVING, and chosen to match how the founder already answers:
 *   - zero/near-zero sugar drink        → yes, any day
 *   - sugar-free treat, real fat/kcal   → yes, but a treat: a portion, not the pack
 *   - a pie, a slab, a fried thing      → yes, but once a week, and say so plainly
 * ──────────────────────────────────────────────────────────────────────────── */
export type Label = { kcal?: number | null; sugarG?: number | null; satFatG?: number | null; proteinG?: number | null };
export type Verdict = { allowed: boolean; frequency: "any day" | "few times a week" | "once a week"; line: string };

/** Grounded verdict for ONE product. Null when the label gave us nothing to judge on. */
export function productVerdict(name: string, label: Label, goalType?: string | null): Verdict | null {
  const kcal = num(label.kcal), sugar = num(label.sugarG), sat = num(label.satFatG), prot = num(label.proteinG);
  if (kcal === null && sugar === null && sat === null) return null; // nothing read → never guess
  const gain = (goalType || "").toLowerCase() === "muscle_gain";
  const n = (name || "this").trim();

  // A drink or snack with no sugar and few calories is the easy yes the founder gives daily.
  if ((sugar ?? 0) <= 1 && (kcal ?? 0) <= 25) {
    return { allowed: true, frequency: "any day", line: `${cap(n)} — zero sugar, near zero calories. Fits any day, no limit. 👌` };
  }
  // Real protein, modest sugar — this is food, not a treat.
  if ((prot ?? 0) >= 10 && (sugar ?? 0) <= 10) {
    return { allowed: true, frequency: "any day", line: `${cap(n)} — ${prot}g protein and low sugar. That's a proper choice, have it whenever. 👌` };
  }
  // The heavy end: a pie, a slab, anything rich in saturated fat or calories per serving.
  if ((kcal ?? 0) >= 400 || (sat ?? 0) >= 10) {
    return {
      allowed: true, frequency: "once a week",
      line: gain
        ? `${cap(n)} — yes, and on a building phase it's fuel. Once a week though, not daily: ${kcal ?? "those"} kcal a serving is a lot of it from one thing.`
        : `${cap(n)} — yes, but a treat. Once a week, one serving, and eat it after a proper meal so it isn't the meal. 👌`,
    };
  }
  // Sugar-free but still a real treat — the sugar-free chocolate case exactly.
  if ((sugar ?? 0) <= 5 && (kcal ?? 0) > 25) {
    return {
      allowed: true, frequency: "few times a week",
      line: `${cap(n)} — sugar-free helps, but it still carries ${kcal} kcal a serving. A couple of squares, not the slab. 👌`,
    };
  }
  // Everything else: sugary, low protein.
  return {
    allowed: true, frequency: "once a week",
    line: `${cap(n)} — ${sugar}g sugar a serving, so keep it to once a week and not on a training day. 👌`,
  };
}

/**
 * TWO PRODUCTS, ONE TROLLEY — "which one?" (the margarine screenshot).
 *
 * Picks on SATURATED FAT first, then sugar, then calories, and says why in one line. A client
 * holding two tubs needs the name of the one to put back, not a nutrition lecture.
 */
export function compareProducts(a: { name: string; label: Label }, b: { name: string; label: Label }): string | null {
  const key = (l: Label) => [num(l.satFatG) ?? 99, num(l.sugarG) ?? 99, num(l.kcal) ?? 9999];
  const [as, ag, ak] = key(a.label), [bs, bg, bk] = key(b.label);
  if (as === 99 && bs === 99 && ag === 99 && bg === 99) return null; // nothing to compare on
  const aWins = as !== bs ? as < bs : ag !== bg ? ag < bg : ak <= bk;
  const win = aWins ? a : b, lose = aWins ? b : a;
  const reason = as !== bs
    ? `less saturated fat (${num(win.label.satFatG)}g vs ${num(lose.label.satFatG)}g)`
    : ag !== bg ? `less sugar (${num(win.label.sugarG)}g vs ${num(lose.label.sugarG)}g)`
    : `fewer calories`;
  return `Take the *${win.name.trim()}* — ${reason}. Put the other one back. 👌`;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}
function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

/**
 * Read the vision model's "LABEL: kcal=230 sugar=1 satfat=9 protein=3" line and grade it.
 *
 * Lives here, next to productVerdict, because reading the label and judging the label are one
 * job — splitting them across files is how the two drift and a threshold ends up applied to a
 * number that was parsed differently. Returns null when no label line was emitted (no legible
 * nutrition table) or when nothing in it could be read: a verdict computed from a guessed
 * label is worse than no verdict at all.
 */
export function verdictFromLabelLine(visionReply: string, name: string, goalType?: string | null): Verdict | null {
  const line = (String(visionReply || "").match(/^[ \t]*LABEL:([^\n]*)$/im) || [])[1];
  if (!line) return null;
  const read = (key: string): number | null => {
    const m = line.match(new RegExp(`\\b${key}\\s*=\\s*(\\d+(?:\\.\\d+)?)`, "i"));
    return m ? parseFloat(m[1]) : null;
  };
  return productVerdict(name, {
    kcal: read("kcal"), sugarG: read("sugar"), satFatG: read("satfat"), proteinG: read("protein"),
  }, goalType);
}

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
export function suggestSwap(foodName: string, goalType?: string | null, c?: FoodConstraints): FoodSwap | null {
  const name = (foodName || "").toLowerCase();
  if (!name.trim() || ALREADY_GOOD_RE.test(name)) return null;
  const goal = (goalType || "").toLowerCase();
  for (const rule of SWAP_RULES) {
    if (!rule.match.test(name)) continue;
    if (rule.goals && !rule.goals.includes(goal as GoalType)) continue;
    // THE REPLACEMENT IS A RECOMMENDATION (Cut 9). Telling a vegan to swap their mayo for eggs
    // is worse than saying nothing: it is the coach proving it does not know them, at the exact
    // moment it claims to be helping. No usable swap for this client → fall through to null,
    // which every caller already treats as "Coach K's judgement".
    if (c && !c.allows(rule.swap)) continue;
    return { swap: rule.swap, reason: rule.reason };
  }
  return null;
}

/**
 * A plain, kind, one-line "for next time" nudge built from a swap — never shaming,
 * always framed forward. Returns "" if there's no useful swap.
 */
export function swapNudge(foodName: string, goalType?: string | null, c?: FoodConstraints): string {
  const s = suggestSwap(foodName, goalType, c);
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
export function answerSwapAsk(message: string, goalType?: string | null, c?: FoodConstraints): string | null {
  const food = parseSwapAsk(message);
  if (!food) return null;
  const s = suggestSwap(food, goalType, c);
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

// The JOB a food does on the plate. It was already the organising idea of this table — the
// section comments below have said "protein / starch / veg / fat" since the table was written
// — but it lived only in the comments, so nothing could READ it. Work Order B needs the
// reverse lookup ("they proposed eggs — does that work?"), which is the same knowledge asked
// from the other end, so the grouping becomes a field instead of a second table.
type FoodJob = "protein" | "starch" | "veg" | "fat";

const SUBSTITUTES: Array<{ match: RegExp; job: FoodJob; sub: Substitution }> = [
  // ── PROTEIN — the job that matters most, and the one clients panic about ──
  { match: /\b(chicken breast|chicken|braai pack|drumsticks?)\b/i, job: "protein",
    sub: { alt: "lean mince, tinned pilchards, or eggs", note: "same protein job, and usually cheaper per gram" } },
  { match: /\b(beef|steak|mince)\b/i, job: "protein",
    sub: { alt: "chicken, soya mince, or tinned fish", note: "same protein, lighter on the pocket" } },
  { match: /\b(fish|hake|snoek|tinned fish|pilchards?|tuna)\b/i, job: "protein",
    sub: { alt: "eggs, chicken, or tinned baked beans", note: "protein is protein — take what the shop has" } },
  { match: /\b(eggs?)\b/i, job: "protein",
    sub: { alt: "tinned pilchards, chicken, or beans", note: "same protein for roughly the same money" } },
  { match: /\b(biltong|dro[ëe]wors)\b/i, job: "protein",
    sub: { alt: "boiled eggs or a tin of pilchards", note: "the protein without the biltong price" } },
  // ── STARCH — filling, cheap, and interchangeable ──
  { match: /\b(rice)\b/i, job: "starch", sub: { alt: "pap, samp, or potatoes", note: "same job on the plate, same size portion" } },
  { match: /\b(pap|maize meal|mealie meal)\b/i, job: "starch", sub: { alt: "rice, samp, or potatoes", note: "same job on the plate" } },
  { match: /\b(bread|brown bread)\b/i, job: "starch", sub: { alt: "provitas, oats, or a potato", note: "same starch, and oats keep you full longer" } },
  { match: /\b(potatoes?|sweet potatoes?)\b/i, job: "starch", sub: { alt: "rice, pap, or samp", note: "swap freely — they do the same work" } },
  { match: /\b(oats|porridge)\b/i, job: "starch", sub: { alt: "maltabella, weetbix, or brown bread", note: "same breakfast starch" } },
  { match: /\b(pasta|macaroni|spaghetti)\b/i, job: "starch", sub: { alt: "rice or samp", note: "same starch, usually cheaper" } },
  { match: /\b(samp)\b/i, job: "starch", sub: { alt: "rice or pap", note: "same starch, quicker to cook" } },
  // ── VEG — never skip it because one thing was missing ──
  { match: /\b(spinach|morogo)\b/i, job: "veg", sub: { alt: "cabbage, or any frozen mixed veg", note: "cabbage is the cheapest green in the shop" } },
  { match: /\b(broccoli|green beans)\b/i, job: "veg", sub: { alt: "cabbage, carrots, or frozen mixed veg", note: "frozen counts — it is picked riper than fresh" } },
  { match: /\b(salad|lettuce|tomatoes?)\b/i, job: "veg", sub: { alt: "cucumber, cabbage, or tinned tomatoes", note: "any veg beats no veg" } },
  { match: /\b(carrots?|butternut|pumpkin)\b/i, job: "veg", sub: { alt: "any frozen mixed veg", note: "same job, keeps for months" } },
  // ── FAT + DAIRY ──
  { match: /\b(olive oil|avocado|avo)\b/i, job: "fat", sub: { alt: "sunflower oil used sparingly, or peanut butter", note: "same fat job at a fraction of the price" } },
  { match: /\b(milk)\b/i, job: "protein", sub: { alt: "long-life milk or maas", note: "same protein and calcium, keeps longer" } },
  { match: /\b(yoghurt|greek yoghurt)\b/i, job: "protein", sub: { alt: "maas or plain double-cream yoghurt", note: "maas is the SA original and costs less" } },
  { match: /\b(cheese)\b/i, job: "protein", sub: { alt: "eggs or a tin of pilchards", note: "cheaper protein, less saturated fat" } },
  { match: /\b(peanut butter)\b/i, job: "fat", sub: { alt: "any nut butter, or eggs for the protein", note: "same fat and protein job" } },
];

/**
 * Did they say the shop LET THEM DOWN, rather than asking whether a food is good for them?
 * "Couldn't find", "they didn't have", "too expensive", "out of stock", "finished".
 */
export const UNAVAILABLE_RE = /\b(could ?n[o']?t find|couldn t find|did ?n[o']?t have|don't have|dont have|no more|out of stock|sold out|finished|too expensive|can'?t afford|too pricey|nothing left|they were out)\b/i;

/** The substitution for a named food, or null when we have nothing honest to offer. */
// DELETED 2026-08-24: substituteFor() — unreferenced. The SUBSTITUTES table it read is still
// used by the live swap path below; only this unused accessor is gone.

/**
 * A LOCAL CHANGE TO A LIST ALREADY SENT — answered locally, never by rebuilding the list
 * (Work Order B, 2026-08-12 live: "Can I use eggs instead?" came back as "Here's your
 * updated list…" and a full regeneration of every section).
 *
 * The scope of the reply is the whole defect. The substitution was understood correctly; the
 * client asked about ONE item and was handed back twenty, which buries the answer they wanted
 * and re-prices a list they did not ask to re-price. A local question gets a local answer.
 *
 * Two shapes, one owner, because they are the same question asked from two ends:
 *  • "can I use eggs instead" — they PROPOSE a food. SWAP_ASK_RE cannot see this: it reads
 *    "instead of X" and here the food comes BEFORE the word, so the message fell past every
 *    deterministic handler to the model, which had the list in its history and rebuilt it.
 *  • "I already have rice" — they own an item. Nothing anywhere answered this; the nearest
 *    thing, UNAVAILABLE_RE, is the opposite polarity (not having something).
 *
 * Returns null on any food the table does not know, so Coach K still owns the judgement calls.
 * Never fires when the client explicitly asks for the full/updated list — see asksForFullList.
 */
const JOB_CONFIRMS: Record<FoodJob, string> = {
  protein: "it does the same protein job",
  starch: "it does the same job on the plate",
  veg: "any veg beats no veg",
  fat: "same fat job",
};

export function answerLocalListChange(message: string, c: FoodConstraints = NO_CONSTRAINTS): string | null {
  const m = (message || "");
  // An explicit request for the whole list is NOT a local change — let the list handlers run.
  if (/\b(?:full|whole|updated|new|revised|complete)\s+(?:grocery\s+|shopping\s+)?list\b|\b(?:send|show|give)\s+(?:me\s+)?(?:the\s+|my\s+)?(?:updated|full|new|whole)\b/i.test(m)) return null;

  const row = (food: string) => SUBSTITUTES.find(r => r.match.test(food));

  // THEY PROPOSED A FOOD — "can I use eggs instead", "use eggs instead", "eggs instead?"
  // THE VERB FORM IS TRIED FIRST, DELIBERATELY. As one alternation the anchored bare form won at
  // position 0 and swallowed the lead-in: "can I use eggs instead?" captured "can I use eggs" as
  // the food. Harmless while the food was only matched against a table, and not harmless once the
  // answer says it back to the client (#177). Two patterns, most specific first.
  const proposed = m.match(/\b(?:use|swap in|go with|do|have|take|try|buy|get)\s+(?:some |a |an |the )?([a-z][a-z' \-]{1,30}?)\s+instead\b/i)
    || m.match(/^\s*([a-z][a-z' \-]{1,30}?)\s+instead\b/i);
  if (proposed) {
    const food = (proposed[1] || "").trim();
    const hit = row(food);
    // "YES, THAT WORKS" IS AN INSTRUCTION TO BUY IT (#177), so it is bound by what they told us
    // they do not eat. Answering rather than standing down: silence here means no door claims the
    // turn and the client gets "I didn't quite catch that" — told us their restriction, asked one
    // question about it, and got nothing. The same table that knows the JOB supplies what else
    // does it, so this is the existing answer with the disallowed option removed, not a new mouth.
    if (!hit) return null;
    // ONE SENTENCE, TWO LEADS. The door already said "Yes — X works 👌 <job>. Everything else on
    // the list stays as it is."; a client who excluded X needs the same sentence with a different
    // opening, not a second mouth saying most of the same words. Standing down instead would mean
    // no door claims the turn and they get "I didn't quite catch that" — told us their
    // restriction, asked one question about it, and got nothing.
    const swapIn = c.allows(food) ? null : allowedAlternatives(hit.sub.alt, c);
    if (!c.allows(food) && !swapIn) return null;   // nothing honest left to offer for this job
    const lead = swapIn ? `You told me no ${food} — so *${swapIn}* instead.` : `Yes — ${food} works 👌`;
    if (hit) return `${lead} ${JOB_CONFIRMS[hit.job].charAt(0).toUpperCase()}${JOB_CONFIRMS[hit.job].slice(1)}. Everything else on the list stays as it is.`;
    return null;
  }

  // THEY ALREADY OWN AN ITEM — "I already have rice", "I've got pap at home".
  const owned = m.match(/\b(?:i(?:'ve| have)\s+(?:got|already)|already (?:have|got)|i\s+have)\s+(?:some |a |an |the )?([a-z][a-z' \-]{1,30}?)(?:\s+at home)?\s*[.!,?]?\s*$/i);
  if (owned) {
    const food = owned[1].trim();
    const hit = row(food);
    if (hit) return `Good — cross ${food} off then 👌 That's your ${hit.job === "veg" ? "veg" : hit.job} covered, so put the money on the rest of the list.`;
    return null;
  }
  return null;
}

/**
 * A full answer to "the shop didn't have X", or null to let the coach handle it.
 *
 * Only fires on an availability/price complaint that NAMES a food we know. Everything else —
 * including a plain "what should I eat instead of chips" — belongs to the goal-swap table
 * above, which answers a different question and is checked first by the caller.
 */
export function answerUnavailable(message: string, c: FoodConstraints = NO_CONSTRAINTS): string | null {
  const m = (message || "");
  if (!UNAVAILABLE_RE.test(m)) return null;
  for (const row of SUBSTITUTES) {
    const hit = m.match(row.match);
    if (hit) {
      const alt = allowedAlternatives(row.sub.alt, c);
      // NOTHING HONEST LEFT TO OFFER (#177). Every alternative for this job is something they
      // told us they do not eat, so the deterministic answer stands down rather than naming one:
      // a substitution IS an instruction to buy, and it is bound by the same constraint the
      // grocery list obeys. Coach K takes the turn, with the constraint already in its context.
      if (!alt) return null;
      return `No stress — *${alt}* instead. ${row.sub.note.charAt(0).toUpperCase()}${row.sub.note.slice(1)}. 👌`;
    }
  }
  return null;
}

/**
 * THE ALTERNATIVES THIS CLIENT MAY ACTUALLY BUY (#177).
 *
 * The substitution table stores a human phrase — "lean mince, tinned pilchards, or eggs" — because
 * that is what reads well in a Shoprite aisle. A client who declared "no eggs" was still offered
 * eggs by it: the table knew the JOB and nothing about the person. Splitting on the same commas
 * and "or" the phrase is written with lets the declared constraint remove parts of it without a
 * second table, and re-joins what is left in the same voice.
 *
 * Returns null when nothing survives — an empty suggestion is worse than no suggestion.
 */
function allowedAlternatives(alt: string, c: FoodConstraints): string | null {
  const parts = String(alt || "").split(/\s*,\s*(?:or\s+)?|\s+or\s+/).map(s => s.trim()).filter(Boolean);
  const kept = parts.filter(p => c.allows(p));
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  if (kept.length === 2) return `${kept[0]} or ${kept[1]}`;
  return `${kept.slice(0, -1).join(", ")}, or ${kept[kept.length - 1]}`;
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

/* ────────────────────────────────────────────────────────────────────────────
 * THE IMPORT GUARD — a suggested food must be buyable at a Boxer (2026-08-06).
 *
 * Live, at 06:37: a client on muscle gain asked for snacks and was offered "Hummus with carrot
 * sticks or whole grain crackers". He replied "I live in a poor country idiot. Also, where are
 * the fruits??? What kind of coach are you?" The next attempt gave him "Pap with a bit of sugar
 * or honey" — refined carb, no protein, to a man trying to build muscle.
 *
 * The prompt has said "meal ideas must be built from THEIR staple foods and budget, never a
 * generic list" since July. It was ignored, because a rule in a prompt is a suggestion. This is
 * the law version.
 *
 * IT GATES SUGGESTIONS ONLY, AND IT NEVER TOUCHES A LOG. That distinction is the whole design:
 * if a CLIENT eats hummus, that is a fact about their life and it gets logged with an estimate
 * like any other food — commitFoodLog is not on this path and must never be. What is forbidden
 * is the COACH proposing a food this market does not buy. Logging is theirs; suggesting is ours.
 *
 * Fail-open on the reply too: an import is REPLACED with the SA staple that does the same job,
 * never deleted, and if a line cannot be repaired it is left alone rather than eaten. A missing
 * suggestion is worse than an imperfect one.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Foods that do not belong in a suggestion here, and the local thing that does the same job. */
const IMPORTS: Array<[RegExp, string]> = [
  [/\bhummus(?:\s+with\s+[\w\s]{0,20})?\b/gi, "peanut butter on brown bread"],
  [/\b(?:whole[\s-]?grain\s+)?crackers?\b/gi, "brown bread"],
  [/\bquinoa\b/gi, "samp"],
  [/\bkale\b/gi, "morogo"],
  [/\bgreek yogh?urt\b/gi, "maas"],
  [/\bcottage cheese\b/gi, "maas"],
  [/\balmond (?:milk|butter)\b/gi, "peanut butter"],
  [/\balmonds?\b/gi, "peanuts"],
  [/\bavocado toast\b/gi, "avo on brown bread"],
  [/\bberries\b/gi, "banana"],
  [/\bsalmon\b/gi, "pilchards"],
  [/\bprotein (?:bar|powder|shake)s?\b/gi, "eggs"],
  [/\bchia (?:seeds?)?\b/gi, "oats"],
  [/\bcarrot sticks?\b/gi, "carrots"],
  // A sugar-first "snack" is not a snack for someone building or cutting — keep the pap,
  // add the protein.
  [/\b(?:pap|porridge|oats)\s+with\s+(?:a\s+bit\s+of\s+)?(?:sugar|honey|jam)(?:\s+or\s+(?:sugar|honey|jam))*\b/gi, "pap with peanut butter"],
  // Cost caveats — the tell that the coach priced the advice AFTER choosing it. Deleted, not
  // replaced: in this market cost is the frame you start from, never a footnote.
  // The trailing object must go WITH the caveat. "…chicken, if you can afford it" left a dangling
  // "it" behind — "Have the grilled chicken it." — because only the `when you can afford` branch
  // consumed it. Pre-existing since the table was written; the comment below names that very phrase.
  [/,?\s*(?:if (?:you can )?afford(?:able)?|if (?:it'?s |they'?re )?(?:in|within) budget|when you can afford)(?:\s+(?:it|them|these|that))?\b/gi, ""],
];

/**
 * Rewrite imported foods in a SUGGESTION into the local staple that does the same job.
 * Returns the text unchanged when nothing foreign is named.
 *
 * `menu: true` — the client is ordering off a RESTAURANT menu (Reality J1, 2026-08-12). The
 * original design drew exactly one boundary, and drew it correctly: logging is theirs,
 * suggesting is ours, and a client who EATS hummus still gets it logged. It never considered a
 * third case, where the suggestion is ours but the SHELF is not. Swapping salmon for pilchards
 * is right in a shop and absurd at a Spur — you cannot order a tin of pilchards there — and the
 * live transcript shows exactly that: "Go for chicken, eggs or pilchards first" against a menu.
 * A substitution the client cannot act on is worse than the import it replaced.
 *
 * Only the FOOD rewrites stand down. The trailing two entries are phrasing, not shelf items —
 * the sugar-first "snack" and the cost caveat — and those hold everywhere, which is why the
 * split follows the same slice boundary `namesAnImport` already uses.
 */
export function localiseSuggestion(text: string, opts?: { menu?: boolean }): string {
  let out = String(text || "");
  if (!out.trim()) return text;
  const table = opts?.menu ? IMPORTS.slice(-2) : IMPORTS;
  for (const [re, local] of table) { re.lastIndex = 0; out = out.replace(re, local); }
  return out.replace(/\s{2,}/g, " ").replace(/\s+([.,])/g, "$1").trim();
}

/** Does this reply still name a food this market cannot buy? Used by the tests, not at runtime. */
export function namesAnImport(text: string): boolean {
  // Only the FOOD entries — the trailing two rewrite phrasing, not a food, so a reply that
  // merely said "if you can afford it" is not naming an import.
  return IMPORTS.slice(0, -2).some(([re]) => { re.lastIndex = 0; return re.test(String(text || "")); });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS CLIENT MAY EAT — one owner, because there were three (2026-08-19, Cut 9)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// The same question was being answered in three places, from three different sources, with no
// agreement between them:
//
//   meal-plan.ts        derived isVegan / isVegetarian / noDairy / noFish / noPeanuts by
//                       substring-matching `otherMedicalNotes`.
//   grocery-personalize derived a "never suggest these" list from users.food_dislikes.
//   memory.ts factsLine put users.dietary_restrictions into the GPT context and nowhere else.
//
// So a client who told us in conversation that they are lactose intolerant (Cut 7 records that
// in dietary_restrictions) still got a meal plan built on amasi, because meal-plan reads a
// different column. A constraint that holds on one path and not another is not a constraint —
// it is a coincidence, and the client finds the hole before we do.
//
// This is that question's one owner. It lives here rather than in a new module because the
// architecture governor is already over on `modules`, and this file is the nearest existing
// owner of food suitability — it is what already answers "should this person eat that". foods.ts
// would be the better name and it has one line of budget headroom.
//
// DELIBERATELY NOT CLINICAL. A diagnosis does not become a food ban here: diabetes sets low-GI
// emphasis, which meal-plan already had, and nothing else. Deciding that a condition forbids a
// food is clinical advice, and the doctrine is that we hand that to a doctor.

export interface FoodConstraints {
  /** What they actually told us, for saying back to them. Never invented. */
  terms: string[];
  /** One line for a coaching context or prompt. "" when there is nothing to say. */
  line: string;
  /** False when this food is off the table for this client. */
  allows(foodName: string): boolean;
  vegan: boolean;
  vegetarian: boolean;
  noDairy: boolean;
  noPork: boolean;
  noGluten: boolean;
  noFish: boolean;
  noPeanuts: boolean;
  /** Diabetes / PCOS — an EMPHASIS, not a ban. Preserved from meal-plan's own derivation. */
  lowGI: boolean;
}

/** What a declared diet actually rules out on a South African plate. */
// PLURALS ARE THE WHOLE GAME HERE. "Chicken livers" is what a street vendor writes on the board,
// and `\bliver\b` cannot see it. This codebase already carries the lesson in readStruggle — a
// stem must not be closed at both ends — and it cost three failing gates before this comment
// existed. `s?` rather than an open stem, deliberately: an open `\bham` would ban a beef
// hamburger for a halaal client, which is the same class of bug pointing the other way.
const DAIRY = /\b(milk|amasi|maas|cheese|yoghurts?|yogurts?|cream|butter|custard|ice ?cream|condensed milk)\b/i;
const MEAT = /\b(chicken|beef|steaks?|mince|lamb|mutton|pork|bacon|ham|polony|russians?|vienna|wors|boerewors|biltong|livers?|tripe|offal|walkie|gammon|sausages?|meat|nyama|shisa ?nyama)\b/i;
const FISH = /\b(fish|pilchards?|tuna|hake|snoek|sardines?|anchov(?:y|ies)|prawns?|shrimps?|calamari|mussels?|seafood)\b/i;
const EGG = /\b(eggs?|omelettes?)\b/i;
const PORK = /\b(pork|bacon|ham|gammon|pig)\b/i;
const GLUTEN = /\b(bread|rolls?|buns?|kota|vetkoek|pasta|macaroni|spaghetti|noodles?|wheat|flour|cereal|weetbix|rusks?)\b/i;
const PEANUT = /\b(peanuts?|peanut ?butter|groundnuts?)\b/i;

export function foodConstraints(u: {
  dietaryRestrictions?: string | null;
  foodDislikes?: string | null;
  otherMedicalNotes?: string | null;
  medicalConditions?: string | null;
}): FoodConstraints {
  // BOTH COLUMNS, MERGED. dietary_restrictions is what they said in conversation (Cut 7);
  // food_dislikes is what they said at signup. Reading one and not the other is how the hole
  // above happened, and which column a fact landed in was decided by when they mentioned it.
  const declared = `${u.dietaryRestrictions || ""} ${u.foodDislikes || ""} ${u.otherMedicalNotes || ""}`.toLowerCase();
  const conditions = (u.medicalConditions || "").toLowerCase();

  const has = (re: RegExp) => re.test(declared);
  const vegan = has(/\bvegan\b/) || /\bvegan\b/.test(conditions);
  const vegetarian = vegan || has(/\bvegetarian\b|\bno meat\b|\bplant.?based\b/) || /\bvegetarian\b/.test(conditions);
  const noDairy = vegan || has(/\bdairy\b|\blactose\b|\bmilk\b/);
  const noPork = has(/\bpork\b|\bhalaal\b|\bhalal\b|\bkosher\b|\bbacon\b/);
  const noGluten = has(/\bgluten\b|\bceliac\b|\bcoeliac\b|\bwheat\b/);
  const noFish = vegetarian || has(/\bfish\b|\bpilchard\b|\btuna\b|\bseafood\b|\bshellfish\b/);
  const noPeanuts = has(/\bpeanut\b|\bgroundnut\b/);

  // The literal foods they named, beyond the diet labels — "I don't eat liver" is a constraint
  // even though no cluster covers it.
  const literal = `${u.dietaryRestrictions || ""} ${u.foodDislikes || ""}`
    .toLowerCase()
    .split(/[,;]+|\band\b/)
    .map(s => s.trim().replace(/^(no|not|never|hate|dislike|avoid|i don'?t eat|can'?t eat)\s+/, "").trim())
    .filter(s => s.length >= 3 && s.length <= 24 && /^[a-z' -]+$/.test(s)
      && !/^(vegan|vegetarian|halaal|halal|kosher|gluten free|dairy free|lactose intolerant)$/.test(s));

  // Both forms of every literal term, for the same reason — a client who typed "liver" means
  // "chicken livers" on a menu, and one who typed "eggs" means an egg.
  const literalForms = literal.flatMap(w => {
    const e = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return e.endsWith("s") ? [e, e.slice(0, -1)] : [e, `${e}s`];
  }).filter(Boolean);
  const literalRe = literalForms.length
    ? new RegExp(`\\b(?:${literalForms.sort((a, b) => b.length - a.length).join("|")})\\b`, "i")
    : null;

  // THEIR WORD, NOT OUR DERIVATION. A client who told us "halaal" should hear "halaal" back, not
  // "no pork" — saying it in their own language is most of what makes being remembered land.
  const declaredLabel = declared.match(/\b(halaal|halal|kosher)\b/)?.[0];
  const terms = [
    ...(vegan ? ["vegan"] : vegetarian ? ["vegetarian"] : []),
    ...(declaredLabel ? [declaredLabel] : []),
    ...(noPork && !vegetarian && !declaredLabel ? ["no pork"] : []),
    ...(noDairy && !vegan ? ["no dairy"] : []),
    ...(noGluten ? ["no gluten"] : []),
    ...(noPeanuts ? ["no peanuts"] : []),
    ...(noFish && !vegetarian ? ["no fish"] : []),
    ...literal,
  ];

  const allows = (foodName: string): boolean => {
    const f = String(foodName || "");
    if (!f.trim()) return true;
    if (literalRe && literalRe.test(f)) return false;
    if (vegan && (MEAT.test(f) || FISH.test(f) || EGG.test(f) || DAIRY.test(f))) return false;
    if (vegetarian && (MEAT.test(f) || FISH.test(f))) return false;
    if (noDairy && DAIRY.test(f)) return false;
    if (noPork && PORK.test(f)) return false;
    if (noGluten && GLUTEN.test(f)) return false;
    if (noFish && FISH.test(f)) return false;
    if (noPeanuts && PEANUT.test(f)) return false;
    return true;
  };

  return {
    terms,
    line: terms.length ? `Does not eat: ${terms.join(", ")} — never suggest these, and never ask them to.` : "",
    allows,
    vegan, vegetarian, noDairy, noPork, noGluten, noFish, noPeanuts,
    lowGI: /\bdiabet|pcos\b/.test(conditions) || /\bdiabet|pcos\b/.test(declared),
  };
}

/** Constraints for a client with nothing declared — the shared "everything is allowed" case. */
export const NO_CONSTRAINTS: FoodConstraints = foodConstraints({});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// "CAN I EAT THIS?" — the question, answered from the ledger (2026-08-19, Cut 10)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Cut 9 made the constraint true in every RECOMMENDER. It did not answer the ask. A client
// standing at a counter typing "can I eat this kota?" got the same treatment they always did:
// every deterministic handler declined — correctly, it is a question, not a log — and the model
// answered from a prompt, without the day's ledger in front of it.
//
// That is the job the manual clients pay for, and it is four seconds of their life. It needs one
// move, now, from what we already know: what they have eaten today, what they told us they do
// not eat, and what this plate actually costs.
//
// HONEST ABOUT WHAT WE DO NOT KNOW. With no calorie target set we do not invent a verdict — the
// answer is the smart order and nothing about numbers. Known / likely / unknown, on a plate.
//
// NEVER "NO" FOR A FOOD THEY CAN EAT. A kota is not a moral failure, and a coach that forbids it
// gets lied to for the rest of the month. Over budget becomes "half it", which is a move they can
// actually make while standing there.

/**
 * "May I have this?" — the permission shape, distinct from every other food question.
 *
 * NOT "how much protein is in a kota" (a fact ask) and NOT "what should I have" (a
 * recommendation, which the guides already own). This is a client standing in front of a
 * specific plate deciding whether to buy it, and the only useful answer is one move now.
 */
// A leading wh-word turns it into a RECOMMENDATION ask — "what should I eat tonight" is the
// guides' job, not this one. Stealing it here would be the pair-branch disease with a
// friendlier name: two owners for one question, differing only in how the client phrased it.
export const PERMISSION_ASK = /(?<!\b(?:what|which|where|when|how)\s)\b(?:can|may|should|could)\s+i\s+(?:still\s+)?(?:eat|have|get|buy|order|grab|take)\b|\b(?:is|are)\s+(?:it|this|that|these|those)\s+(?:ok(?:ay)?|fine|alright|allowed|safe)\b|\b(?:am\s+i\s+allowed|allowed\s+to\s+have|can\s+i\s+afford)\b|\bfits?\s+(?:in(?:to)?|within)?\s*(?:my|the)\s+(?:calories|macros|kcal|budget|numbers|targets?|deficit)\b|\bdo\s+i\s+have\s+(?:room|space)\s+for\b/i;

export interface PlateAskInput {
  foodName: string;
  /** What this portion actually costs. 0 when we could not price it. */
  portionKcal: number;
  portionProtein: number;
  eatenKcal: number;
  calorieTarget: number;
  eatenProtein: number;
  proteinTarget: number;
  constraints: FoodConstraints;
  /** The dish's own smart-order line, when it is a street food we coach. */
  smartMove?: string;
}

export interface PlateVerdict {
  kind: "off_limits" | "unpriced" | "room" | "tight" | "half";
  reply: string;
}

export function answerPlateAsk(i: PlateAskInput): PlateVerdict {
  const name = (i.foodName || "that one").trim();
  const move = (i.smartMove || "").trim();

  if (!i.constraints.allows(name)) {
    return {
      kind: "off_limits",
      reply: `*Not that one.* You told me: ${i.constraints.terms.join(", ")} — I'm not going to forget that at the counter.\n\nTell me what else is there and I'll pick the plate.`,
    };
  }

  // No target, or no price for this food: say the true thing rather than a confident guess.
  if (i.calorieTarget <= 0 || i.portionKcal <= 0) {
    return {
      kind: "unpriced",
      reply: move
        ? `*Have it — order it smart.*\n\n${move}`
        : `*Have it.* Get some protein on that plate with it and you're fine.\n\nSnap a photo when it lands and I'll log it properly.`,
    };
  }

  const remaining = i.calorieTarget - i.eatenKcal;
  const proteinShort = i.proteinTarget > 0 && i.eatenProtein < i.proteinTarget * 0.6;
  const tail = move ? `\n\n${move}` : "";

  if (i.portionKcal <= remaining) {
    const protLine = proteinShort && i.portionProtein >= 20
      ? ` And it puts ~${i.portionProtein}g of protein in, which is where you're short.`
      : "";
    return {
      kind: "room",
      reply: `*Yes — you've got the room.* That's about ${i.portionKcal} kcal and you've got ~${Math.round(remaining)} left today.${protLine}${tail}`,
    };
  }

  // Within a plate's margin of the line: still yes, but it is the last one.
  if (i.portionKcal <= remaining + i.calorieTarget * 0.12) {
    return {
      kind: "tight",
      reply: `*Yes — but that's the last plate today.* It's about ${i.portionKcal} kcal against ~${Math.round(remaining)} left, so it takes you to the line, not past it.${tail || "\n\nWater from here, and we go again tomorrow."}`,
    };
  }

  return {
    kind: "half",
    reply: `*Have half of it now, the rest tomorrow.* Whole thing is about ${i.portionKcal} kcal and you've got ~${Math.round(Math.max(0, remaining))} left — half lands you right.${tail}`,
  };
}

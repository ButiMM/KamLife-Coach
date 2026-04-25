// ============================================================
// SCHEDULER & RATE-LIMIT CONSTANTS
// ============================================================

export const SCHEDULER_LIMITS = {
  // Silence thresholds (days)
  SILENCE_STOP_MESSAGING_DAYS: 7,       // stop proactive messages after this many silent days
  SILENCE_RE_ENGAGE_MIN_DAYS: 3,        // start re-engagement messages after this many silent days
  ESCALATION_THRESHOLD_DAYS: 14,        // create escalation record after this many silent days

  // Twilio circuit breaker
  TWILIO_CIRCUIT_FAILURE_THRESHOLD: 5,  // open circuit after this many consecutive failures
  TWILIO_CIRCUIT_RESET_MS: 60_000,      // attempt reset after 60 seconds

  // GPT rate limiting (per user)
  GPT_RATE_LIMIT_PER_MIN: 10,           // max GPT calls per user per minute
  GPT_TIMEOUT_MS: 15_000,               // abort GPT call after 15 seconds

  // Media dedup cache
  MEDIA_DEDUP_MAX_SIZE: 500,            // max entries in the media dedup Map
  MEDIA_DEDUP_TTL_MS: 60_000,           // evict media dedup entries after 60 seconds

  // weeklyKeyedSent Map eviction
  WEEKLY_KEYED_MAX_SIZE: 10_000,        // evict oldest entries when Map exceeds this size

  // Daily proactive budget
  MAX_PROACTIVE_PER_DAY: 1,            // max proactive messages per client per calendar day
} as const;

// ============================================================
// HARDCODED LOOKUP TABLES — no GPT cost
// ============================================================

export const EQUIPMENT_ALTERNATIVES: Record<string, string[]> = {
  barbell: ["broomstick for form practice, loaded backpack for resistance (pack books or water bottles)"],
  dumbbell: ["2L water bottles, rice bags filled to weight, school bag filled with books"],
  "bench press": ["floor press with water bottles, push-up variations — decline, diamond, archer"],
  "pull-up bar": ["table row lying under a sturdy table, door frame row, resistance band row"],
  "cable machine": ["resistance bands anchored to door or pole, towel rows, bodyweight alternatives"],
  "leg press": ["bodyweight squat, jump squat, Bulgarian split squat with chair"],
  "leg curl": ["Nordic hamstring curl with someone holding feet, glute bridge, single-leg glute bridge"],
  "lat pulldown": ["table row, door frame row, resistance band pulldown"],
  "shoulder press machine": ["pike push-up, chair dip, resistance band overhead press"],
  "chest press machine": ["push-up variations, floor press with backpack"],
  "treadmill": ["brisk walk outside, stairs, dancing, skipping rope"],
  "rowing machine": ["table row, resistance band row, towel row in door frame"],
  "gym": ["full home programme — bodyweight squat, push-up, glute bridge, lunge, table row, plank — all you need"],
  "weights": ["water bottles (2L = 2kg), rice bags, loaded backpack, resistance bands from Dischem R30"],
  "resistance bands": ["towel for rows, your own bodyweight, water bottles for arms"],
};

export const FOOD_SUBSTITUTIONS: Record<string, string> = {
  "chicken breast": "pilchards, tinned tuna, eggs (2 eggs = 12g protein), beans (half tin = 8g protein), chicken thighs (cheaper, more flavour)",
  "protein powder": "eggs — 3 boiled eggs give same protein as a scoop. Pilchards — 1 tin = 20g protein at R12. Chicken liver — 150g = 25g protein at R15. Food first always.",
  "salmon": "kingklip or yellowtail when on special at Shoprite, pilchards in oil (same omega-3 profile), tinned tuna",
  "beef mince": "chicken mince (cheaper), lentils + eggs (vegetarian), canned kidney beans + eggs",
  "greek yoghurt": "plain fat-free yoghurt, amasi (fermented milk, traditional, cheaper), cottage cheese",
  "avocado": "peanut butter (1 tbsp), olive oil (drizzle), sunflower seeds",
  "broccoli": "cabbage (R8 vs R25), spinach, morogo, frozen peas",
  "sweet potato": "butternut (same macros, cheaper often), gem squash, pumpkin, samp and beans for complex carbs",
  "brown rice": "samp (lower GI, cheaper), sweet potato, oats",
  "oats": "maltabella (mabele — actually lower GI), mealie meal porridge, Weet-Bix",
  "milk": "amasi, soy milk, oat milk, just skip dairy altogether and get calcium from pilchards",
  "protein bar": "2 boiled eggs (R4), 1 tin pilchards (R12), peanut butter on brown bread (R5). Protein bars are overpriced",
  "gym membership": "home bodyweight programme — costs nothing. Full programme in your menu.",
  "supplement": "food. Always food first. Your monthly supplement budget buys a week of real protein from pilchards and eggs.",
};

export const PORTION_GUIDE = `*Visual Portion Guide — no scale needed*

Protein — palm of your hand = 100g cooked chicken, fish, or meat = roughly 25-30g protein. Two palms = 200g.

Carbs — closed fist = 1 cup cooked pap, rice, samp, or pasta = roughly 200-250 calories. Aim for one fist per meal for fat loss, two fists for muscle gain.

Fat — your thumb = 1 tablespoon of oil, peanut butter, or avocado = 100 calories. This adds up fast. Measure it.

Vegetables — two cupped hands together = one portion (about 200g). Eat at least two portions per meal. These are almost free calories.

Fruit — one closed fist = one portion. Banana, apple, orange — one each. Not three.

Dairy — one yoghurt tub (175ml) or one glass of milk (250ml) = one portion.

The plate rule: Half the plate — vegetables. Quarter — protein. Quarter — carbs. No need to weigh anything.`;

export const STORE_ADVICE: Record<string, string> = {
  shoprite: `*Shoprite — Best budget protein choices:*\nEggs 12 pack — R35-45\nPilchards in tomato sauce — R12-15 per tin\nChicken drumsticks/pieces — R55-65 per kg\nPap/maize meal 5kg — R40-50\nCabbage — R8-12\nSugar beans 500g — R18-22\nOats 500g — R15-18\n\nShopping tip: Shoprite marks down fresh chicken on Tuesday and Thursday afternoons. Frozen section always cheaper than fresh. Buy in bulk and freeze.`,

  boxer: `*Boxer — Best bulk buys:*\nEggs 30 pack — R85-100\nFrozen chicken portions 2kg — R90-110\nSugar beans 1kg — R38-45\nMaize meal 10kg — R70-85\nCabbage bulk — R6-10\nOnions bag 3kg — R20-28\n\nShopping tip: Boxer is the cheapest for bulk staples. Better for families or meal prepping a full week. The freezer section is excellent value.`,

  checkers: `*Checkers — Best value picks:*\nHouse brand oats 1kg — R18-22\nFrozen hake portions — R55-70 per kg\nHouse brand cheese 400g — R45-55\nFrozen chicken breast 1kg — R75-90\nHouse brand peanut butter — R30-35\nTinned tomatoes — R12-15\n\nShopping tip: Checkers Xtra Savings card gives real discounts. Check the app weekly specials every Monday. House brand products match name brands at lower cost.`,

  woolworths: `*Woolworths — Not recommended for budget tiers 1 or 2.*\nWoolworths is 40-80% more expensive than Shoprite on identical products. If you are on a tight budget, Shoprite and Boxer give you more protein per rand. Save Woolworths for the occasional quality purchase when budget allows.`,

  "pick n pay": `*Pick n Pay — Mid-range, good for dairy:*\nHouse brand plain yoghurt 1kg — R35-42\nHouse brand eggs 6 pack — R28-35\nFrozen hake — R60-75 per kg\nPnP chicken portions — R65-75 per kg\nCottage cheese 250g — R20-28\n\nShopping tip: PnP Smart Shopper card has genuine savings. Their house brand dairy is excellent value — yoghurt, milk, and cottage cheese are all good quality at fair prices.`,

  pnp: `*Pick n Pay — Mid-range, good for dairy:*\nHouse brand plain yoghurt 1kg — R35-42\nHouse brand eggs 6 pack — R28-35\nFrozen hake — R60-75 per kg\nPnP chicken portions — R65-75 per kg\nCottage cheese 250g — R20-28\n\nShopping tip: PnP Smart Shopper card has genuine savings. Their house brand dairy is excellent value — yoghurt, milk, and cottage cheese are all good quality at fair prices.`,

  dischem: `*Dis-Chem — For supplements only:*\nCreatine monohydrate 500g — R80-120\nUSN whey protein 1kg — R280-350\nBiogen whey 1kg — R280-320\nVital multivitamin — R80-120\n\nShopping tip: Dis-Chem has a loyalty programme with real discounts. Wait for their 20% off supplements sales. Never buy food here — overpriced. Supplements only.`,

  takealot: `*Takealot — Online supplement deals:*\nBest prices for creatine (R80-100 for 500g), whey protein bulk buys, and resistance bands. Check daily deals. Free delivery over R500.`,
};

// INJURY MODIFICATIONS — no GPT cost (Item 18)
export const INJURY_MODIFICATIONS: Record<string, { avoid: string[]; alternatives: string }> = {
  knee: {
    avoid: ["squats", "lunges", "running", "jumping", "leg press deep", "step-ups"],
    alternatives: `*Training with a knee injury:*\n\nAvoid: squats, lunges, running, jumping, deep leg press.\n\nSafe alternatives:\n• Seated leg extension (partial range only — no lockout)\n• Lying leg curl (hamstrings are usually fine)\n• Upper body — full chest, back, and shoulder programme\n• Swimming or pool walking (zero impact)\n• Glute bridge (lying flat — no knee stress)\n• Wall sit (if pain-free at your angle)\n• Seated calf raise\n\nIce knee for 15 minutes after any training. See a physio if pain persists beyond 2 weeks. You can still build significant muscle training upper body while the knee heals.`,
  },
  shoulder: {
    avoid: ["overhead press", "bench press", "push-ups", "upright row", "dips"],
    alternatives: `*Training with a shoulder injury:*\n\nAvoid: overhead press, bench press, push-ups with shoulder pain, upright rows, dips.\n\nSafe alternatives:\n• Rows — seated cable row, machine row, table row (pulling is almost always safe)\n• Lat pulldown (neutral grip, below chin)\n• Lower body — full leg programme, squats, lunges, leg press\n• Core — planks on forearms, dead bug, bicycle crunch\n• Resistance band pulls at low angles\n• Cable lateral raise (very light, below parallel only)\n\nShoulder injuries heal faster with gentle movement than rest. Do not fully stop — just route around it.`,
  },
  back: {
    avoid: ["deadlift", "bent-over row", "good morning", "sit-ups", "leg press feet low"],
    alternatives: `*Training with a back injury:*\n\nAvoid: deadlifts, bent-over rows, any spinal loading under weight, full sit-ups, heavy leg press with feet low.\n\nSafe alternatives:\n• Swimming (best for back rehab)\n• Walking (gentle, non-impact)\n• Bird-dog exercise (on hands and knees)\n• Glute bridge (lying flat)\n• Side planks\n• Seated chest press machine (back supported)\n• Leg press with feet high on platform (less spinal load)\n• Lat pulldown (seated, upright)\n\nBack injuries need 72 hours rest first. Then gentle movement. No lifting until you can walk without pain. See a doctor if pain radiates down the leg — that needs professional assessment.`,
  },
  wrist: {
    avoid: ["push-ups", "bench press", "barbell curls", "dumbbell press", "plank on hands"],
    alternatives: `*Training with a wrist injury:*\n\nAvoid: any exercise with weight through the wrist — push-ups, bench press, planks on hands, barbell curls.\n\nSafe alternatives:\n• Fist push-ups (wrist straight)\n• Plank on forearms (not hands)\n• All machine pressing (grip with palm not wrist loaded)\n• All lower body — squats, lunges, leg press, leg curl — no wrist needed\n• Core — forearm plank, bicycle crunch, leg raises\n• Cable exercises with wrist wraps if mild injury\n\nWrist injuries heal slowly. Strap it, ice it, rest it from loading. You can still train everything else.`,
  },
  hip: {
    avoid: ["deep squats", "lunges", "hip thrust", "leg press feet wide", "running"],
    alternatives: `*Training with a hip injury:*\n\nAvoid: deep squats, lunges, hip thrusts depending on hip position, wide stance leg press.\n\nSafe alternatives:\n• Leg extension machine (quad focus, no hip load)\n• Lying leg curl (hamstrings)\n• Upper body — full programme\n• Swimming (low impact)\n• Straight-leg leg press (narrow stance)\n• Calf raises\n\nHip injuries vary widely. Some positions are safe, others are not. If unsure, see a physio before loading the hip again.`,
  },
  ankle: {
    avoid: ["running", "jumping", "walking on uneven surfaces", "squats with heel raise"],
    alternatives: `*Training with an ankle injury:*\n\nAvoid: running, jumping, any exercise that loads the ankle joint.\n\nSafe alternatives:\n• All upper body — full chest, back, shoulder programme\n• Leg press (seated — no ankle stress)\n• Leg extension (seated)\n• Leg curl (lying)\n• Core — planks, crunches, dead bug\n• Swimming (if non-weight bearing)\n\nAnkle injuries: RICE protocol for 48 hours — Rest, Ice, Compression, Elevation. Then gentle movement. Most ankles are ready for upper body training within a day.`,
  },
};

// SUPPLEMENT INSTANT GUIDE — no GPT cost (Item 22)
export const SUPPLEMENT_GUIDE: Record<string, string> = {
  creatine: `*Creatine — Worth it. Here is the truth:*\n\n5g daily. Any time. With water or food. No loading phase needed.\n\nCost: R80-120 for 500g at Dis-Chem or Takealot. That is roughly R10-15 per month. One of the cheapest, most proven supplements in existence.\n\nIt works by pulling water into muscle cells — you may gain 1-2kg scale weight in the first week. This is muscle cell hydration, not fat.\n\nSafe for everyone. Safe during Ramadan taken at Suhoor or Iftar. No cycling. No breaks needed.`,

  "protein powder": `*Protein Powder — Only if you genuinely cannot hit protein from food:*\n\nYour protein target is the number. Food first. Always.\n\nIf you consistently cannot hit it from whole foods — whey isolate is the best bang for rand. USN or Biogen are SA brands. Evox is also solid. R280-400 per kg. One 30g scoop = roughly 24g protein.\n\nMix with water not milk. Saves 150 calories. Use it as a meal supplement not a meal replacement.\n\nBefore buying powder: 3 boiled eggs = 18g protein at R4. 1 tin pilchards = 20g protein at R12. Powder is R25 per scoop. Do the maths.`,

  "pre-workout": `*Pre-workout — You are paying for caffeine:*\n\nMost pre-workouts are caffeine, beta-alanine (causes the tingling), and marketing. Cost: R300-600 per month.\n\nAlternative: strong black coffee 30 minutes before training. Identical caffeine hit. Free.\n\nIf you want beta-alanine (3-5g daily) it improves muscular endurance slightly and is cheap on its own.\n\nSkip the pre-workout. Train with coffee. Save the R300 for real food.`,

  bcaa: `*BCAAs — Skip it:*\n\nIf you are eating enough protein (which is your target), you are already getting more BCAAs than any supplement provides. BCAAs are built into whole protein — chicken, eggs, pilchards all contain them.\n\nBCAAs as a supplement: R200-400 per month for something you already have from food. Waste of money.\n\nSpend that on an extra chicken or eggs for the week.`,

  "fat burner": `*Fat Burners — None are proven. Full stop:*\n\nNo supplement burns fat meaningfully. Not thermogenics. Not carb blockers. Not green coffee extract. Not raspberry ketones.\n\nThe only thing that burns fat is a caloric deficit — eating less than you burn. Training and steps create the deficit.\n\nFat burner companies spend more on marketing than on the product. Your deficit is the fat burner. Eat at your target, train, walk your steps. That is it.`,

  multivitamin: `*Multivitamins — Optional, not essential:*\n\nIf you are eating a varied diet with vegetables, eggs, and protein — you are likely getting most micronutrients from food.\n\nIf your diet is limited (budget tier 1, low variety), a multivitamin fills gaps.\n\nBest affordable options: Centravit or Vital at Clicks (R80-120 for 3 months). Centrum is also fine.\n\nTake with a meal — fat-soluble vitamins (A, D, E, K) need fat to absorb. Food first, always.`,

  whey: `*Whey Protein — Same answer as protein powder:*\n\nOnly if you consistently cannot hit your protein target from whole food. Whey isolate absorbs fastest. Whey concentrate is cheaper with similar results.\n\nSA brands: USN, Biogen, Evox. Import brands like Optimum Nutrition are available on Takealot. Mix with water, not milk.`,
};

// ============================================================
// LANGUAGE DETECTION
// Supports: Zulu, Xhosa, Sotho, Tswana, Tsonga, Afrikaans, English
// ============================================================

export type SALanguage = "zu" | "xh" | "st" | "tn" | "ts" | "af" | "en";

export function detectLanguage(text: string): SALanguage {
  const lower = text.toLowerCase();

  const ZULU = [
    "sawubona", "ngiyabonga", "siyabonga", "yebo", "hawu", "uxolo",
    "ngiyezwa", "ngicela", "sala kahle", "hamba kahle", "ungubani",
    "ngifuna", "ngiyakuzwa", "ngiyakhuluma", "eish wena",
  ];
  const XHOSA = [
    "molo", "molweni", "enkosi", "ewe", "hayi", "camagu",
    "ndiyabona", "ndifuna", "ndicela", "uyaphila", "ndiyaphila",
    "hamba kakuhle", "sala kakuhle", "ndiyakuva", "ndiyakuxelela",
    "uxolo mhlobo", "ndiziva", "ndifuna ukwazi",
  ];
  const SOTHO = [
    "dumela", "ke a leboha", "ke a leboga", "ntate", "morena",
    "ke kopa", "ke batla", "o kae", "sala hantle", "tsamaya hantle",
    "ke a bua", "le kae", "re kae", "ho lokile", "ke rata",
  ];
  const TSWANA = [
    "go siame", "ke a leboga", "rra", "mma modimo", "lo kae",
    "re bua setswana", "ke rata go", "ga ke", "a o itse", "pula",
    "ke tsile", "ke tsamaya", "ke kopa", "ko kae", "thobela",
  ];
  const TSONGA = [
    "avuxeni", "nkhensa", "ndza khensa", "swinene", "hi kona",
    "ndzi lava", "ndzi kopa", "u kona", "swikuma", "ndza",
    "hi swona", "naswona", "loko", "ku pfuka", "ndzi twile",
  ];
  const AFRIKAANS = [
    "dankie", "asseblief", "baie dankie", "môre", "goeiedag",
    "ek wil", "ek het", "ek is", "jy is", "dit is",
    "hoe gaan", "wat is", "kan jy", "is dit", "geen probleem",
    "lekker dag", "tot siens", "nie dankie", "ek verstaan",
  ];

  // Order matters — check most-distinctive first
  if (TSONGA.some(w => lower.includes(w))) return "ts";
  if (XHOSA.some(w => lower.includes(w))) return "xh";
  if (TSWANA.some(w => lower.includes(w))) return "tn";
  if (ZULU.some(w => lower.includes(w))) return "zu";
  if (SOTHO.some(w => lower.includes(w))) return "st";
  if (AFRIKAANS.some(w => lower.includes(w))) return "af";
  return "en";
}

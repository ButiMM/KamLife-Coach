/**
 * Exercise media — GIF URLs and portion plate images.
 *
 * How it works:
 *   1. Set MEDIA_BASE_URL in Railway to your CDN or server root (e.g. https://media.kamlife.co.za)
 *   2. Upload exercise GIFs to: MEDIA_BASE_URL/ex/<slug>.gif
 *   3. Upload portion images to: MEDIA_BASE_URL/portions/breakfast.jpg  /lunch.jpg  /dinner.jpg
 *   4. Everything else is automatic — the bot attaches media when available, falls back to text when not.
 *
 * GIF naming: use the slug column from EXERCISE_SLUGS below.
 *
 * ── COMPLETE FILE UPLOAD LIST ─────────────────────────────────────────────────
 * Upload these files to MEDIA_BASE_URL/ex/<slug>.gif
 * Quality requirement: clear full range-of-motion demonstration, correct form.
 * Recommended sources: ExerciseDB Pro, GymVisual, or licensed fitness GIF libraries.
 *
 * LOWER BODY
 *   squat.gif                     — barbell back squat or Smith squat, full depth, heels on floor
 *   leg-press.gif                 — 45-degree leg press, full range, heels mid-platform
 *   leg-extension.gif             — seated leg extension, full extension, controlled descent
 *   leg-curl.gif                  — prone/lying leg curl, full range, hips pinned
 *   calf-raise.gif                — standing calf raise, full heel drop and toe rise
 *   seated-calf-raise.gif         — seated calf raise machine, full range
 *   rdl.gif                       — Romanian deadlift, hip hinge, flat back, hamstring stretch
 *   bulgarian-split-squat.gif     — back foot elevated, front foot forward, full range
 *   goblet-squat.gif              — dumbbell held at chest, full depth squat
 *   hack-squat.gif                — hack squat machine, deep range
 *   smith-squat.gif               — Smith machine squat (same as squat.gif is fine)
 *   barbell-back-squat.gif        — classic high-bar back squat with barbell
 *   glute-bridge.gif              — floor glute bridge, hips driven up, glute squeeze
 *   hip-thrust.gif                — barbell or dumbbell hip thrust, bench supported
 *   sumo-squat.gif                — wide stance sumo squat, knees out over toes
 *   reverse-lunge.gif             — step back lunge, controlled descent
 *   step-up.gif                   — box step-up, full hip extension at top
 *
 * UPPER — PUSH
 *   chest-press.gif               — machine or dumbbell chest press, 45° elbows
 *   chest-fly.gif                 — dumbbell fly, arc motion, chest squeeze at top
 *   shoulder-press.gif            — dumbbell or machine shoulder press overhead
 *   lateral-raise.gif             — dumbbell lateral raise to shoulder height only
 *   push-up.gif                   — standard push-up, full range, body rigid
 *   incline-dumbbell-press.gif    — incline bench dumbbell press, 30–45 degrees
 *   dumbbell-floor-press.gif      — floor press, triceps touch floor, pause and press
 *   barbell-bench-press.gif       — flat barbell bench press, bar to lower chest
 *   tricep-pushdown.gif           — cable tricep pushdown, elbows pinned
 *   tricep-overhead-extension.gif — overhead dumbbell tricep extension, elbows close
 *   tricep-kickback.gif           — dumbbell kickback, elbow pinned, forearm extends
 *   chair-tricep-dip.gif          — hands on chair edge, dip and press
 *
 * UPPER — PULL
 *   lat-pulldown.gif              — wide-grip lat pulldown, elbows drive to pockets
 *   seated-row.gif                — cable seated row, shoulder blades squeeze
 *   face-pull.gif                 — cable face pull, elbows high and wide
 *   bent-over-row.gif             — bent-over dumbbell row, both arms, torso parallel
 *   single-arm-row.gif            — dumbbell single-arm row with knee on bench
 *   chest-supported-row.gif       — chest-supported incline dumbbell row
 *   barbell-row.gif               — barbell bent-over row, bar to lower chest
 *   resistance-band-row.gif       — resistance band row, anchored at waist height
 *   door-frame-row.gif            — doorframe/door-frame row, lean back and pull
 *   table-row.gif                 — under-table row, body rigid, pull chest to table
 *   bicep-curl.gif                — dumbbell bicep curl, elbows pinned
 *   cable-bicep-curl.gif          — cable bicep curl, elbows fixed, full range
 *   doorframe-curl.gif            — underhand doorframe curl, lean back slightly
 *
 * CORE / BODYWEIGHT
 *   plank.gif                     — forearm plank, body straight, core braced
 *   dead-bug.gif                  — dead bug, opposite arm/leg, lower back flat
 *   plank-leg-raise.gif           — forearm plank with alternating leg raise
 *   plank-shoulder-tap.gif        — plank with alternating shoulder taps, hips stable
 *   cable-crunch.gif              — kneeling cable crunch, rope overhead
 *   cable-kickback.gif            — cable ankle-strap glute kickback
 *
 * That is 54 unique GIF files.
 * ──────────────────────────────────────────────────────────────────────────────
 */

const BASE = (process.env.MEDIA_BASE_URL || "").replace(/\/$/, "");

// ── Exercise name → URL slug ──────────────────────────────────────────────────
//
// Keys: exact programme exercise names (lowercase) + short-form client phrases.
// Values: the GIF slug (filename without .gif).
// When BASE is set, any matched name resolves to BASE/ex/<slug>.gif

const EXERCISE_SLUGS: Record<string, string> = {

  // ════════════════════════════════════════════════════════════════
  // EXACT PROGRAMME EXERCISE NAMES (as they appear in programme.ts)
  // ════════════════════════════════════════════════════════════════

  // ── Lower body ───────────────────────────────────────────────────
  "smith squat / leg press":                              "squat",
  "smith squat / bulgarian split squat":                  "squat",
  "leg extension":                                        "leg-extension",
  "leg curl":                                             "leg-curl",
  "leg curl machine":                                     "leg-curl",
  "calf raise":                                           "calf-raise",
  "seated calf raise":                                    "seated-calf-raise",
  "standing calf raise":                                  "calf-raise",
  "leg press":                                            "leg-press",
  "leg press (wide stance)":                              "leg-press",
  "hack squat / leg press":                               "hack-squat",
  "hack squat or leg press":                              "hack-squat",
  "bulgarian split squat / reverse lunge":                "bulgarian-split-squat",
  "romanian deadlift / dumbbell rdl":                     "rdl",
  "romanian deadlift":                                    "rdl",
  "romanian deadlift (heavier)":                          "rdl",
  "barbell squat or leg press":                           "barbell-back-squat",

  // ── Glutes / hips ────────────────────────────────────────────────
  "hip thrust / glute bridge":                            "hip-thrust",
  "hip thrust (barbell or machine)":                      "hip-thrust",
  "hip thrust":                                           "hip-thrust",
  "hip thrust with dumbbell":                             "hip-thrust",
  "barbell hip thrust":                                   "hip-thrust",
  "dumbbell hip thrust":                                  "hip-thrust",

  // ── Upper — push ─────────────────────────────────────────────────
  "machine chest press / dumbbell press":                 "chest-press",
  "chest press / bench press":                            "barbell-bench-press",
  "chest press machine or bench press":                   "chest-press",
  "barbell bench press or chest press machine":           "barbell-bench-press",
  "chest fly / dumbbell chest fly":                       "chest-fly",
  "cable lateral raise / dumbbell lateral raise":         "lateral-raise",
  "machine shoulder press / dumbbell shoulder press":     "shoulder-press",
  "overhead press (barbell or machine)":                  "shoulder-press",
  "overhead press":                                       "shoulder-press",
  "dumbbell press / floor press":                         "chest-press",
  "incline dumbbell press":                               "incline-dumbbell-press",
  "dumbbell floor press":                                 "dumbbell-floor-press",
  "dumbbell bench press":                                 "barbell-bench-press",
  "dumbbell shoulder press":                              "shoulder-press",

  // ── Upper — pull ─────────────────────────────────────────────────
  "lat pulldown / assisted pull-up":                      "lat-pulldown",
  "lat pulldown":                                         "lat-pulldown",
  "seated row / dumbbell row":                            "seated-row",
  "seated cable row":                                     "seated-row",
  "upper back row / cable face pull":                     "face-pull",
  "cable face pull / upper back row":                     "face-pull",
  "face pull":                                            "face-pull",
  "barbell row":                                          "barbell-row",
  "barbell back squat":                                   "barbell-back-squat",
  "bent-over dumbbell row":                               "bent-over-row",
  "bent over dumbbell row":                               "bent-over-row",
  "chest-supported row or barbell row":                   "chest-supported-row",
  "single arm row":                                       "single-arm-row",
  "dumbbell row":                                         "single-arm-row",
  "dumbbell row (each arm)":                              "single-arm-row",
  "resistance band row":                                  "resistance-band-row",
  "door frame row":                                       "door-frame-row",
  "doorframe curl":                                       "doorframe-curl",
  "table row":                                            "table-row",

  // ── Arms ─────────────────────────────────────────────────────────
  "bicep curl":                                           "bicep-curl",
  "cable bicep curl":                                     "cable-bicep-curl",
  "tricep pushdown":                                      "tricep-pushdown",
  "tricep cable pushdown":                                "tricep-pushdown",
  "cable kickback / machine kickback":                    "cable-kickback",
  "cable kickback":                                       "cable-kickback",
  "tricep kickback":                                      "tricep-kickback",
  "tricep overhead extension":                            "tricep-overhead-extension",

  // ── Core / bodyweight ────────────────────────────────────────────
  "plank":                                                "plank",
  "dead bug":                                             "dead-bug",
  "cable crunch":                                         "cable-crunch",
  "plank with leg raise":                                 "plank-leg-raise",
  "plank leg raise":                                      "plank-leg-raise",
  "plank shoulder tap":                                   "plank-shoulder-tap",
  "plank with shoulder taps":                             "plank-shoulder-tap",
  "chair tricep dip":                                     "chair-tricep-dip",

  // ── Home / bodyweight ────────────────────────────────────────────
  "squat":                                                "squat",
  "bodyweight squat":                                     "squat",
  "goblet squat":                                         "goblet-squat",
  "goblet squat (heavier)":                               "goblet-squat",
  "dumbbell goblet squat (heavier)":                      "goblet-squat",
  "sumo squat":                                           "sumo-squat",
  "glute bridge":                                         "glute-bridge",
  "single-leg glute bridge":                              "glute-bridge",
  "single leg glute bridge":                              "glute-bridge",
  "reverse lunge":                                        "reverse-lunge",
  "hip abduction machine":                                "hip-thrust",   // closest visual equivalent
  "hip abduction machine (burnout)":                      "hip-thrust",
  "step up":                                              "step-up",
  "push-up":                                              "push-up",
  "push up":                                              "push-up",
  "bulgarian split squat":                                "bulgarian-split-squat",
  "dumbbell bulgarian split squat":                       "bulgarian-split-squat",
  "dumbbell romanian deadlift":                           "rdl",
  "lateral raise":                                        "lateral-raise",
  "cable lateral raise":                                  "lateral-raise",

  // ════════════════════════════════════════════════════════════════
  // SHORT-FORM PHRASES — what clients type when asking "show me X"
  // (only keys not already defined in the exact-names section above)
  // ════════════════════════════════════════════════════════════════

  // ── Lower body ───────────────────────────────────────────────────
  "squats":                           "squat",
  "back squat":                       "barbell-back-squat",
  "barbell squat":                    "barbell-back-squat",
  "smith squat":                      "squat",
  "smith machine squat":              "squat",
  "hack squat":                       "hack-squat",
  "leg press machine":                "leg-press",
  "leg extensions":                   "leg-extension",
  "quad extension":                   "leg-extension",
  "hamstring curl":                   "leg-curl",
  "lying leg curl":                   "leg-curl",
  "calf raises":                      "calf-raise",
  "rdl":                              "rdl",
  "deadlift":                         "rdl",
  "dumbbell rdl":                     "rdl",
  "split squat":                      "bulgarian-split-squat",
  "bulgarian":                        "bulgarian-split-squat",
  "lunge":                            "reverse-lunge",
  "lunges":                           "reverse-lunge",
  "walking lunge":                    "reverse-lunge",
  "reverse lunges":                   "reverse-lunge",
  "deficit lunge":                    "reverse-lunge",
  "goblet":                           "goblet-squat",
  "sumo":                             "sumo-squat",
  "sumo squats":                      "sumo-squat",

  // ── Glutes / hips ────────────────────────────────────────────────
  "hip thrusts":                      "hip-thrust",
  "glute bridges":                    "glute-bridge",
  "hip thrust barbell":               "hip-thrust",
  "barbell hip thrusts":              "hip-thrust",

  // ── Upper — push ─────────────────────────────────────────────────
  "bench press":                      "barbell-bench-press",
  "incline press":                    "incline-dumbbell-press",
  "incline bench press":              "incline-dumbbell-press",
  "incline dumbbell":                 "incline-dumbbell-press",
  "floor press":                      "dumbbell-floor-press",
  "dumbbell press":                   "chest-press",
  "chest flys":                       "chest-fly",
  "chest flyes":                      "chest-fly",
  "dumbbell fly":                     "chest-fly",
  "dumbbell flys":                    "chest-fly",
  "ohp":                              "shoulder-press",
  "military press":                   "shoulder-press",
  "lateral raises":                   "lateral-raise",
  "side raise":                       "lateral-raise",
  "push ups":                         "push-up",
  "pushup":                           "push-up",
  "pushups":                          "push-up",
  "pike push up":                     "push-up",
  "diamond push up":                  "push-up",
  "decline push up":                  "push-up",
  "wide push up":                     "push-up",
  "chair dip":                        "chair-tricep-dip",
  "tricep dip":                       "chair-tricep-dip",
  "dips":                             "chair-tricep-dip",

  // ── Upper — pull ─────────────────────────────────────────────────
  "pull down":                        "lat-pulldown",
  "pulldown":                         "lat-pulldown",
  "pull up":                          "lat-pulldown",
  "pull ups":                         "lat-pulldown",
  "pullup":                           "lat-pulldown",
  "pullups":                          "lat-pulldown",
  "chin up":                          "lat-pulldown",
  "cable row":                        "seated-row",
  "low cable row":                    "seated-row",
  "row":                              "seated-row",
  "rows":                             "seated-row",
  "face pulls":                       "face-pull",
  "rear delt":                        "face-pull",
  "bent over row":                    "bent-over-row",
  "bent-over row":                    "bent-over-row",
  "bb row":                           "barbell-row",
  "chest supported row":              "chest-supported-row",
  "one arm row":                      "single-arm-row",
  "door row":                         "door-frame-row",
  "doorframe row":                    "door-frame-row",
  "band row":                         "resistance-band-row",

  // ── Arms ─────────────────────────────────────────────────────────
  "bicep curls":                      "bicep-curl",
  "curls":                            "bicep-curl",
  "dumbbell curl":                    "bicep-curl",
  "dumbbell curls":                   "bicep-curl",
  "cable curl":                       "cable-bicep-curl",
  "cable curls":                      "cable-bicep-curl",
  "door curl":                        "doorframe-curl",
  "tricep push down":                 "tricep-pushdown",
  "pushdown":                         "tricep-pushdown",
  "cable pushdown":                   "tricep-pushdown",
  "tricep extension":                 "tricep-overhead-extension",
  "overhead extension":               "tricep-overhead-extension",
  "tricep overhead":                  "tricep-overhead-extension",
  "skull crusher":                    "tricep-overhead-extension",
  "kickback":                         "cable-kickback",
  "glute kickback":                   "cable-kickback",

  // ── Core ─────────────────────────────────────────────────────────
  "planks":                           "plank",
  "deadbug":                          "dead-bug",
  "ab crunch":                        "cable-crunch",
  "leg raise plank":                  "plank-leg-raise",
  "shoulder tap":                     "plank-shoulder-tap",
  "shoulder taps":                    "plank-shoulder-tap",
};

/**
 * Returns the GIF URL for a given exercise name, or null if not configured / not found.
 *
 * Handles:
 *  - "Exercise A / Exercise B" compound names — tries each alternative left to right
 *  - Common equipment prefixes (machine, cable, smith, barbell, dumbbell, etc.)
 *  - Parenthetical suffixes like "(heavier)" or "(wide stance)"
 *  - Trailing noise words like "machine", "with dumbbell"
 */
export function getExerciseGifUrl(exerciseName: string): string | null {
  if (!BASE) return null;
  const name = exerciseName.toLowerCase().trim();

  // 1. Direct lookup
  let slug = EXERCISE_SLUGS[name];
  if (slug) return `${BASE}/ex/${slug}.gif`;

  // 2. Handle "Exercise A / Exercise B" — try each alternative left to right
  if (name.includes(" / ")) {
    for (const part of name.split(" / ")) {
      slug = EXERCISE_SLUGS[part.trim()];
      if (slug) return `${BASE}/ex/${slug}.gif`;
    }
  }

  // 3. Strip parenthetical suffixes like "(heavier)", "(wide stance)", "(from floor)"
  const noParens = name.replace(/\s*\([^)]*\)\s*/g, "").trim();
  if (noParens !== name) {
    slug = EXERCISE_SLUGS[noParens];
    if (slug) return `${BASE}/ex/${slug}.gif`;
  }

  // 4. Strip common equipment prefixes and retry
  const prefixStripped = name.replace(/^(machine|cable|smith|barbell|assisted|seated|standing|lying|dumbbell|resistance band|bodyweight)\s+/, "");
  if (prefixStripped !== name) {
    slug = EXERCISE_SLUGS[prefixStripped];
    if (slug) return `${BASE}/ex/${slug}.gif`;
    // Also try splitting on " / " after stripping
    if (prefixStripped.includes(" / ")) {
      for (const part of prefixStripped.split(" / ")) {
        slug = EXERCISE_SLUGS[part.trim()];
        if (slug) return `${BASE}/ex/${slug}.gif`;
      }
    }
  }

  // 5. Strip trailing qualifiers ("with dumbbell", "on bench", "each arm", etc.)
  const noTrail = name
    .replace(/\s+(with\s+\w+|on\s+\w+|each\s+(arm|leg|side)|machine|barbell)$/, "")
    .trim();
  if (noTrail !== name) {
    slug = EXERCISE_SLUGS[noTrail];
    if (slug) return `${BASE}/ex/${slug}.gif`;
  }

  return null;
}

/**
 * Scans a workout text block for the first bolded exercise name (*Exercise Name*)
 * and returns its GIF URL, or null.
 */
export function getPrimaryWorkoutGifUrl(workoutText: string): string | null {
  if (!BASE) return null;
  const boldMatches = workoutText.match(/\*([^*]+)\*/g) || [];
  for (const match of boldMatches) {
    const name = match.replace(/\*/g, "").trim();
    const url = getExerciseGifUrl(name);
    if (url) return url;
  }
  // Fallback: try plain exercise name patterns on numbered lines
  const lines = workoutText.split("\n");
  for (const line of lines) {
    const cleaned = line.replace(/^[0-9️⃣•\-\s]+/, "").split("—")[0].trim().toLowerCase();
    const url = getExerciseGifUrl(cleaned);
    if (url) return url;
  }
  return null;
}

// ── Portion plate images ──────────────────────────────────────────────────────

export const PORTION_IMAGES = {
  breakfast: BASE ? `${BASE}/portions/breakfast.jpg` : null,
  lunch:     BASE ? `${BASE}/portions/lunch.jpg`     : null,
  dinner:    BASE ? `${BASE}/portions/dinner.jpg`    : null,
};

/**
 * SA-specific portion captions — what each section of the plate means,
 * with explicit local food alternatives so clients never think it's
 * only rice or eggs.
 */
export const PORTION_CAPTIONS = {
  breakfast: `*🍳 Breakfast Plate — The Plate Method*

*Top right — PROTEIN (¼ plate):*
Eggs (2-3) · Pilchards · Leftover chicken · Cottage cheese · Yoghurt
_Pick ONE — this is your muscle and energy source for the morning_

*Bottom right — CARBS (¼ plate):*
Oats · Pap porridge · Brown bread (1-2 slices) · Sweet potato · Samp
_Not rice in the photo — any of these work. Use what you have._

*Left — VEGETABLES & FRUIT (½ plate):*
Spinach · Tomato · Banana · Cucumber · Any veg or fruit in season
_Half your plate. This is the rule that doesn't change._

💡 *The proportion matters more than the exact food. Pap works. Oats work. Eggs work. Use what's available at your budget.*`,

  lunch: `*🍗 Lunch Plate — The Plate Method*

*Top right — PROTEIN (¼ plate):*
Chicken · Fish · Mince · Eggs · Pilchards · Sugar beans · Lentils
_Any protein source — grilled, baked, or boiled. Not fried._

*Bottom right — CARBS (¼ plate):*
Sweet potato · Pap · Brown rice · Samp · Samp and beans · Bread
_The image shows sweet potato but PAP is perfectly correct here. So is samp. Pick what you're cooking._

*Left — VEGETABLES (½ plate):*
Cabbage · Spinach · Broccoli · Carrots · Green beans · Morogo · Any veg
_This is the biggest section for a reason — fill it properly._

💡 *No scale needed. If your plate looks like this image — right proportions, right foods — you're eating correctly.*`,

  dinner: `*🌙 Dinner Plate — The Plate Method*

*Top right — PROTEIN (¼ plate):*
Chicken · Fish · Pilchards · Eggs · Mince · Sugar beans
_Same as lunch. Protein at every main meal — no exceptions._

*Bottom right — CARBS (¼ plate):*
Pap · Sweet potato · Brown rice · Samp · Bread
_Fat loss goal: smaller portion here at dinner. Muscle goal: same size as lunch._
_The image shows pap — this is the most common SA option and it works perfectly._

*Left — VEGETABLES (½ plate):*
Spinach · Cabbage · Broccoli · Mixed veg · Morogo · Tomato · Any veg
_Always half the plate. Always._

💡 *Pin this. Every meal you build should look like this image — regardless of which specific foods you're using.*`,
};

/**
 * Returns the right portion image and caption for a meal type.
 * Falls back gracefully when MEDIA_BASE_URL is not set.
 */
export function getPortionGuide(mealType: "breakfast" | "lunch" | "dinner"): { imageUrl: string | null; caption: string } {
  return {
    imageUrl: PORTION_IMAGES[mealType],
    caption: PORTION_CAPTIONS[mealType],
  };
}

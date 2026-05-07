/**
 * Exercise media — GIF URLs and portion plate images.
 *
 * How it works:
 *   1. Set MEDIA_BASE_URL in Railway to your CDN or server root (e.g. https://media.kamlife.co.za)
 *   2. Upload exercise GIFs to: MEDIA_BASE_URL/ex/<slug>.gif
 *   3. Upload portion images to: MEDIA_BASE_URL/portions/breakfast.jpg  /lunch.jpg  /dinner.jpg
 *   4. Everything else is automatic — the bot attaches media when available, falls back to text when not.
 *
 * GIF naming: use the slug from EXERCISE_SLUGS below.
 * Example: squat.gif, hip-thrust.gif, lat-pulldown.gif
 */

const BASE = (process.env.MEDIA_BASE_URL || "").replace(/\/$/, "");

// ── Exercise name → URL slug ──────────────────────────────────────────────────

const EXERCISE_SLUGS: Record<string, string> = {
  // Lower body
  "squat": "squat",
  "squats": "squat",
  "back squat": "squat",
  "smith squat": "squat",
  "goblet squat": "goblet-squat",
  "leg press": "leg-press",
  "leg curl": "leg-curl",
  "lying leg curl": "leg-curl",
  "seated leg curl": "leg-curl",
  "leg extension": "leg-extension",
  "romanian deadlift": "rdl",
  "rdl": "rdl",
  "dumbbell rdl": "rdl",
  "stiff leg deadlift": "rdl",
  "deadlift": "deadlift",
  "sumo deadlift": "sumo-deadlift",
  "hip thrust": "hip-thrust",
  "glute bridge": "glute-bridge",
  "lunge": "lunge",
  "lunges": "lunge",
  "walking lunge": "lunge",
  "reverse lunge": "reverse-lunge",
  "bulgarian split squat": "bulgarian-split-squat",
  "split squat": "bulgarian-split-squat",
  "step up": "step-up",
  "step ups": "step-up",
  "calf raise": "calf-raise",
  "calf raises": "calf-raise",
  "seated calf raise": "calf-raise",

  // Push
  "bench press": "bench-press",
  "dumbbell bench press": "db-bench-press",
  "incline bench press": "incline-bench-press",
  "push up": "push-up",
  "push ups": "push-up",
  "chest press": "chest-press-machine",
  "chest press machine": "chest-press-machine",
  "machine chest press": "chest-press-machine",
  "chest fly": "chest-fly",
  "dumbbell chest fly": "chest-fly",
  "overhead press": "overhead-press",
  "ohp": "overhead-press",
  "shoulder press": "overhead-press",
  "machine shoulder press": "overhead-press",
  "dumbbell shoulder press": "db-shoulder-press",
  "lateral raise": "lateral-raise",
  "lateral raises": "lateral-raise",
  "cable lateral raise": "lateral-raise",
  "tricep dips": "tricep-dips",
  "dips": "tricep-dips",
  "tricep pushdown": "tricep-pushdown",
  "cable tricep pushdown": "tricep-pushdown",
  "kickback": "kickback",
  "cable kickback": "kickback",
  "machine kickback": "kickback",
  "skull crusher": "skull-crusher",

  // Pull
  "pull up": "pull-up",
  "pull ups": "pull-up",
  "assisted pull-up": "pull-up",
  "chin up": "chin-up",
  "chin ups": "chin-up",
  "lat pulldown": "lat-pulldown",
  "seated row": "seated-row",
  "seated cable row": "seated-row",
  "cable row": "seated-row",
  "upper back row": "seated-row",
  "bent over row": "bent-over-row",
  "barbell row": "bent-over-row",
  "dumbbell row": "db-row",
  "single arm row": "db-row",
  "face pull": "face-pull",
  "cable face pull": "face-pull",
  "bicep curl": "bicep-curl",
  "bicep curls": "bicep-curl",
  "hammer curl": "hammer-curl",

  // Core
  "plank": "plank",
  "crunch": "crunch",
  "crunches": "crunch",
  "bicycle crunch": "bicycle-crunch",
  "leg raise": "leg-raise",
  "hanging leg raise": "hanging-leg-raise",
  "mountain climber": "mountain-climber",
  "dead bug": "dead-bug",

  // Cardio / bodyweight
  "burpee": "burpee",
  "burpees": "burpee",
  "jumping jack": "jumping-jack",
  "jumping jacks": "jumping-jack",
  "high knees": "high-knees",
  "box jump": "box-jump",
  "skipping": "skipping",
};

/**
 * Returns the GIF URL for a given exercise name, or null if not configured / not found.
 * Handles "Exercise A / Exercise B" alternatives and strips common machine prefixes.
 */
export function getExerciseGifUrl(exerciseName: string): string | null {
  if (!BASE) return null;
  const name = exerciseName.toLowerCase().trim();

  // Direct lookup
  let slug = EXERCISE_SLUGS[name];
  if (slug) return `${BASE}/ex/${slug}.gif`;

  // Handle "Exercise A / Exercise B" — try each alternative left to right
  if (name.includes(" / ")) {
    for (const part of name.split(" / ")) {
      slug = EXERCISE_SLUGS[part.trim()];
      if (slug) return `${BASE}/ex/${slug}.gif`;
    }
  }

  // Strip common equipment prefixes and retry
  const stripped = name.replace(/^(machine|cable|smith|barbell|assisted|seated|standing|lying|dumbbell)\s+/, "");
  if (stripped !== name) {
    slug = EXERCISE_SLUGS[stripped];
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
  // Fallback: try plain exercise name patterns
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

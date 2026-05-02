// ============================================================
// EXERCISE MEDIA — GIF + portion poster lookup
//
// Set MEDIA_BASE_URL env var to your CDN / static hosting root.
// Without it, all helpers return null and the app falls back
// to YouTube links (zero breakage, zero config required).
//
// Expected file layout at MEDIA_BASE_URL:
//   /ex/<slug>.gif   — exercise demo GIFs (looping, ~3–5 MB max)
//   /portions/breakfast.jpg
//   /portions/lunch.jpg
//   /portions/dinner.jpg
// ============================================================

function base(): string {
  return (process.env.MEDIA_BASE_URL || "").replace(/\/$/, "");
}

// Map from normalized keyword → GIF filename (no extension for easy swapping)
const GIF_MAP: Array<[string, string]> = [
  // Compound lower
  ["barbell squat", "squat"],
  ["leg press", "leg-press"],
  ["goblet squat", "goblet-squat"],
  ["sumo squat", "sumo-squat"],
  ["jump squat", "jump-squat"],
  ["hack squat", "hack-squat"],
  ["bulgarian split squat", "split-squat"],
  ["split squat", "split-squat"],
  ["reverse lunge", "reverse-lunge"],
  ["walking lunge", "lunge"],
  ["deficit lunge", "lunge"],
  ["lunge", "lunge"],
  // Hip hinge
  ["romanian deadlift", "rdl"],
  ["rdl", "rdl"],
  ["deadlift", "rdl"],
  ["cable pull through", "cable-pull-through"],
  // Glutes
  ["hip thrust", "hip-thrust"],
  ["glute bridge", "glute-bridge"],
  ["single leg glute bridge", "single-leg-glute-bridge"],
  ["cable kickback", "cable-kickback"],
  ["hip abduction", "hip-abduction"],
  ["step up", "step-up"],
  // Upper push
  ["incline dumbbell press", "incline-press"],
  ["incline press", "incline-press"],
  ["bench press", "bench-press"],
  ["chest press", "chest-press"],
  ["overhead press", "ohp"],
  ["dumbbell shoulder press", "shoulder-press"],
  ["machine shoulder press", "shoulder-press"],
  ["shoulder press", "shoulder-press"],
  ["dumbbell floor press", "bench-press"],
  ["push up", "push-up"],
  ["decline push up", "push-up"],
  ["diamond push up", "push-up"],
  ["pike push up", "push-up"],
  // Upper pull
  ["lat pulldown", "lat-pulldown"],
  ["seated cable row", "cable-row"],
  ["cable row", "cable-row"],
  ["chest supported row", "cable-row"],
  ["bent over row", "bent-over-row"],
  ["single arm row", "single-arm-row"],
  ["table row", "table-row"],
  ["door frame row", "table-row"],
  ["face pull", "face-pull"],
  // Arms
  ["tricep cable pushdown", "tricep-pushdown"],
  ["tricep pushdown", "tricep-pushdown"],
  ["tricep", "tricep-pushdown"],
  ["hammer curl", "hammer-curl"],
  ["bicep curl", "bicep-curl"],
  ["cable bicep curl", "bicep-curl"],
  ["lateral raise", "lateral-raise"],
  ["cable lateral raise", "lateral-raise"],
  // Lower accessory
  ["leg curl", "leg-curl"],
  ["leg extension", "leg-extension"],
  ["calf raise", "calf-raise"],
  // Core
  ["plank shoulder tap", "plank"],
  ["plank", "plank"],
  ["mountain climbers", "mountain-climbers"],
  ["bicycle crunch", "bicycle-crunch"],
  ["cable crunch", "cable-crunch"],
];

export function getExerciseGifUrl(exerciseName: string): string | null {
  const b = base();
  if (!b) return null;
  const lower = exerciseName.toLowerCase().trim();
  for (const [keyword, slug] of GIF_MAP) {
    if (lower.includes(keyword)) return `${b}/ex/${slug}.gif`;
  }
  return null;
}

// Returns the GIF URL for the first named exercise found in workout text.
// Exercises appear as *Exercise Name* in bold in the workout string.
export function getPrimaryWorkoutGifUrl(workoutText: string): string | null {
  const b = base();
  if (!b) return null;
  const matches = workoutText.matchAll(/\*([^*\n]+)\*/g);
  for (const m of matches) {
    const url = getExerciseGifUrl(m[1]);
    if (url) return url;
  }
  return null;
}

export const PORTION_IMAGES = {
  breakfast: () => { const b = base(); return b ? `${b}/portions/breakfast.jpg` : null; },
  lunch:     () => { const b = base(); return b ? `${b}/portions/lunch.jpg` : null; },
  dinner:    () => { const b = base(); return b ? `${b}/portions/dinner.jpg` : null; },
};

// Portion guide text — sent with or without the poster image
export const PORTION_GUIDE = {
  breakfast: `*Breakfast Plate*
½ plate → vegetables or fruit (spinach, tomatoes, banana, orange)
¼ plate → protein (3 eggs, 1 cup Greek yoghurt, 150g cottage cheese)
¼ plate → complex carbs (½ cup oats, 1 slice brown bread, ½ sweet potato)

_Eat within 1 hour of waking. Never skip breakfast — it sets your protein and energy baseline for the day._`,

  lunch: `*Lunch Plate*
½ plate → vegetables (salad, cabbage, cooked spinach, broccoli, peas)
¼ plate → protein (120g chicken, 1 tin pilchards, 3 eggs, 100g legumes)
¼ plate → complex carbs (½ cup rice, 1 medium potato, pap, 1 slice bread)

_This is your biggest carb meal — you need the fuel for the afternoon. Do not skip the vegetables._`,

  dinner: `*Dinner Plate*
½ plate → vegetables (roasted veg, salad, steamed greens, cabbage)
¼ plate → protein (150g chicken, 120g fish, 2 eggs + legumes)
¼ plate → light carbs (smaller portion than lunch — swap rice for sweet potato or skip carbs if fat loss goal)

_Cut carbs at dinner if you are not training in the evening. Protein stays high regardless._`,
};

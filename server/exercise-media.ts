/**
 * Exercise media — GIF/image URLs and portion plate images.
 *
 * How it works — TWO-TIER URL resolution (no upload required for basic operation):
 *
 *   TIER 1 — Custom animated GIFs (optional):
 *     Set MEDIA_BASE_URL in Railway and upload <slug>.gif to MEDIA_BASE_URL/ex/<slug>.gif
 *     These override the fallback images below.
 *
 *   TIER 2 — Free fallback images (automatic, no upload):
 *     Direct JPG images from the free-exercise-db public domain dataset on GitHub.
 *     These work immediately with zero configuration.
 *     Source: github.com/yuhonas/free-exercise-db (public domain / CC0)
 *
 * GIF naming: use the slug column from EXERCISE_SLUGS below.
 *
 * ── TO UPGRADE FROM JPG STILLS TO ANIMATED GIFS ─────────────────────────────
 * 1. Set MEDIA_BASE_URL in Railway (e.g. https://res.cloudinary.com/dkxpypiak/image/upload)
 * 2. Upload animated GIFs to MEDIA_BASE_URL/ex/<slug>.gif  (e.g. via Cloudinary upload)
 * 3. The bot will automatically use your GIF over the fallback still image.
 *
 * Quality requirement: clear full range-of-motion demonstration, correct form.
 * Good sources: ExerciseDB Pro, GymVisual, or record your own and upload to Cloudinary.
 * ──────────────────────────────────────────────────────────────────────────────
 */

const BASE = (process.env.MEDIA_BASE_URL || "").replace(/\/$/, "");
// Only use custom CDN if BASE is set and not the placeholder
const CUSTOM_CDN = BASE && !BASE.includes("placeholder") ? BASE : "";

// Slugs for which an animated GIF has actually been uploaded to CUSTOM_CDN/ex/<slug>.gif.
// EMPTY by default = every exercise serves the free-exercise-db still image (works now,
// zero setup). When you upload a real GIF, add its slug here so it takes over. This keeps
// images working whether or not MEDIA_BASE_URL is set.
const UPLOADED_GIF_SLUGS = new Set<string>([]);

// ── Free-exercise-db fallback images (public domain, no upload needed) ────────
// Source: github.com/yuhonas/free-exercise-db — CC0 / public domain
// If a URL 404s the image silently won't send — no crash, no error.
const GH = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises";

const EXERCISE_MEDIA: Record<string, string> = {
  // ── Lower body ──────────────────────────────────────────────────────────────
  "squat":                      `${GH}/Barbell_Squat/0.jpg`,
  "barbell-back-squat":         `${GH}/Barbell_Squat/0.jpg`,
  "smith-squat":                `${GH}/Barbell_Squat/0.jpg`,
  "leg-press":                  `${GH}/Leg_Press/0.jpg`,
  "leg-extension":              `${GH}/Leg_Extensions/0.jpg`,
  "leg-curl":                   `${GH}/Lying_Leg_Curls/0.jpg`,
  "calf-raise":                 `${GH}/Standing_Calf_Raises/0.jpg`,
  "seated-calf-raise":          `${GH}/Seated_Calf_Raise/0.jpg`,
  "rdl":                        `${GH}/Romanian_Deadlift/0.jpg`,
  "bulgarian-split-squat":      `${GH}/Split_Squat_with_Dumbbells/0.jpg`,
  "hack-squat":                 `${GH}/Hack_Squat/0.jpg`,
  "goblet-squat":               `${GH}/Goblet_Squat/0.jpg`,
  "sumo-squat":                 `${GH}/Sumo_Deadlift/0.jpg`,
  "glute-bridge":               `${GH}/Barbell_Glute_Bridge/0.jpg`,
  "hip-thrust":                 `${GH}/Barbell_Hip_Thrust/0.jpg`,
  "reverse-lunge":              `${GH}/Crossover_Reverse_Lunge/0.jpg`,
  "step-up":                    `${GH}/Dumbbell_Step_Ups/0.jpg`,
  // ── Upper — push ────────────────────────────────────────────────────────────
  "chest-press":                `${GH}/Dumbbell_Bench_Press/0.jpg`,
  "barbell-bench-press":        `${GH}/Barbell_Bench_Press_-_Medium_Grip/0.jpg`,
  "incline-dumbbell-press":     `${GH}/Incline_Dumbbell_Press/0.jpg`,
  "dumbbell-floor-press":       `${GH}/Floor_Press/0.jpg`,
  "chest-fly":                  `${GH}/Dumbbell_Flyes/0.jpg`,
  "lateral-raise":              `${GH}/Side_Lateral_Raise/0.jpg`,
  "shoulder-press":             `${GH}/Dumbbell_Shoulder_Press/0.jpg`,
  "push-up":                    `${GH}/Pushups/0.jpg`,
  "tricep-pushdown":            `${GH}/Triceps_Pushdown/0.jpg`,
  "tricep-overhead-extension":  `${GH}/Lying_Triceps_Press/0.jpg`,
  "tricep-kickback":            `${GH}/Tricep_Dumbbell_Kickback/0.jpg`,
  "cable-kickback":             `${GH}/One-Legged_Cable_Kickback/0.jpg`,
  "chair-tricep-dip":           `${GH}/Bench_Dips/0.jpg`,
  // ── Upper — pull ────────────────────────────────────────────────────────────
  "lat-pulldown":               `${GH}/Wide-Grip_Lat_Pulldown/0.jpg`,
  "seated-row":                 `${GH}/Seated_Cable_Rows/0.jpg`,
  "face-pull":                  `${GH}/Face_Pull/0.jpg`,
  "bent-over-row":              `${GH}/Bent_Over_Barbell_Row/0.jpg`,
  "single-arm-row":             `${GH}/Dumbbell_Incline_Row/0.jpg`,
  "chest-supported-row":        `${GH}/Dumbbell_Incline_Row/0.jpg`,
  "barbell-row":                `${GH}/Bent_Over_Barbell_Row/0.jpg`,
  "resistance-band-row":        `${GH}/Band_Pull_Apart/0.jpg`,
  "door-frame-row":             `${GH}/Bent_Over_Barbell_Row/0.jpg`,
  "table-row":                  `${GH}/Inverted_Row/0.jpg`,
  "bicep-curl":                 `${GH}/Barbell_Curl/0.jpg`,
  "cable-bicep-curl":           `${GH}/Standing_Biceps_Cable_Curl/0.jpg`,
  "doorframe-curl":             `${GH}/Dumbbell_Alternate_Bicep_Curl/0.jpg`,
  // ── Core / bodyweight ────────────────────────────────────────────────────────
  "plank":                      `${GH}/Plank/0.jpg`,
  "dead-bug":                   `${GH}/Dead_Bug/0.jpg`,
  "cable-crunch":               `${GH}/Cable_Crunch/0.jpg`,
  "plank-leg-raise":            `${GH}/Push_Up_to_Side_Plank/0.jpg`,
  "plank-shoulder-tap":         `${GH}/Push_Up_to_Side_Plank/0.jpg`,
};

// ── Exercise name → URL slug ──────────────────────────────────────────────────
//
// Keys: exact programme exercise names (lowercase) + short-form client phrases.
// Values: the slug (matches EXERCISE_MEDIA key and MEDIA_BASE_URL filename).

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
  "hip abduction machine":                                "hip-thrust",
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

  // ── Common plurals / alternate spellings not covered above ───────
  "walking lunges":                   "reverse-lunge",
  "forward lunge":                    "reverse-lunge",
  "forward lunges":                   "reverse-lunge",
  "jump squat":                       "squat",
  "jump squats":                      "squat",
  "jumping squat":                    "squat",
  "box squat":                        "squat",
  "squat jump":                       "squat",
  "single leg hip thrust":            "hip-thrust",
  "single-leg hip thrust":            "hip-thrust",
  "glute bridge hold":                "glute-bridge",
  "hip bridge":                       "glute-bridge",
  "hip bridges":                      "glute-bridge",
  "mountain climber":                 "plank",
  "mountain climbers":                "plank",
  "burpee":                           "push-up",
  "burpees":                          "push-up",
  "leg raises":                       "dead-bug",
  "ab leg raise":                     "dead-bug",
  "step ups":                         "step-up",
  "lateral lunges":                   "reverse-lunge",
  "lateral lunge":                    "reverse-lunge",
  "curtsy lunge":                     "reverse-lunge",
  "curtsy lunges":                    "reverse-lunge",
};

/**
 * Returns the image URL for a given exercise name, or null if not found.
 *
 * Resolution order:
 *   1. Custom CDN GIF  — MEDIA_BASE_URL/ex/<slug>.gif  (if MEDIA_BASE_URL is set and valid)
 *   2. Free fallback   — direct JPG from free-exercise-db on GitHub (no upload needed)
 *
 * Handles:
 *  - "Exercise A / Exercise B" compound names — tries each alternative left to right
 *  - Common equipment prefixes (machine, cable, smith, barbell, dumbbell, etc.)
 *  - Parenthetical suffixes like "(heavier)" or "(wide stance)"
 *  - Trailing noise words like "machine", "with dumbbell"
 */
export function getExerciseGifUrl(exerciseName: string): string | null {
  const name = exerciseName.toLowerCase().trim();

  function urlForSlug(slug: string): string | null {
    // Only serve a CDN .gif for slugs we KNOW have been uploaded. Otherwise fall
    // back to the guaranteed-working free-exercise-db still image. This prevents the
    // footgun where setting MEDIA_BASE_URL (e.g. for portion images) silently points
    // every exercise at a .gif that 404s. Add slugs to UPLOADED_GIF_SLUGS as you
    // upload them — until then, the still image always shows.
    if (CUSTOM_CDN && UPLOADED_GIF_SLUGS.has(slug)) return `${CUSTOM_CDN}/ex/${slug}.gif`;
    return EXERCISE_MEDIA[slug] || null;
  }

  // 1. Direct lookup
  let slug = EXERCISE_SLUGS[name];
  if (slug) return urlForSlug(slug);

  // 2. Handle "Exercise A / Exercise B" — try each alternative left to right
  if (name.includes(" / ")) {
    for (const part of name.split(" / ")) {
      slug = EXERCISE_SLUGS[part.trim()];
      if (slug) return urlForSlug(slug);
    }
  }

  // 3. Strip parenthetical suffixes like "(heavier)", "(wide stance)", "(from floor)"
  const noParens = name.replace(/\s*\([^)]*\)\s*/g, "").trim();
  if (noParens !== name) {
    slug = EXERCISE_SLUGS[noParens];
    if (slug) return urlForSlug(slug);
  }

  // 4. Strip common equipment prefixes and retry
  const prefixStripped = name.replace(/^(machine|cable|smith|barbell|assisted|seated|standing|lying|dumbbell|resistance band|bodyweight)\s+/, "");
  if (prefixStripped !== name) {
    slug = EXERCISE_SLUGS[prefixStripped];
    if (slug) return urlForSlug(slug);
    // Also try splitting on " / " after stripping
    if (prefixStripped.includes(" / ")) {
      for (const part of prefixStripped.split(" / ")) {
        slug = EXERCISE_SLUGS[part.trim()];
        if (slug) return urlForSlug(slug);
      }
    }
  }

  // 5. Strip trailing qualifiers ("with dumbbell", "on bench", "each arm", etc.)
  const noTrail = name
    .replace(/\s+(with\s+\w+|on\s+\w+|each\s+(arm|leg|side)|machine|barbell)$/, "")
    .trim();
  if (noTrail !== name) {
    slug = EXERCISE_SLUGS[noTrail];
    if (slug) return urlForSlug(slug);
  }

  // 6. Replace hyphens with spaces — programme names use "Single-Leg" but slugs use "single leg"
  const noHyphens = name.replace(/-/g, " ").trim();
  if (noHyphens !== name) {
    slug = EXERCISE_SLUGS[noHyphens];
    if (slug) return urlForSlug(slug);
  }

  // 7. Strip trailing 's' to match singular slug entries ("walking lunges" → "walking lunge")
  if (name.endsWith("s") && name.length > 4) {
    const singular = name.slice(0, -1);
    slug = EXERCISE_SLUGS[singular];
    if (slug) return urlForSlug(slug);
  }

  return null;
}

/**
 * Returns a form cue appropriate for the exercise type.
 * Strength exercises get tempo coaching; cardio/isometric exercises get movement coaching.
 */
export function getExerciseDemoFormCue(exerciseName: string): string {
  const n = exerciseName.toLowerCase();
  if (/mountain.?climber|burpee|jumping.?jack|high.?knee|jump.?squat|box.?jump|sprint|skater/.test(n))
    return "Core locked, hips level throughout. Drive alternating knees to your chest — controlled speed, not just fast. Stop if your hips pike up.";
  if (/\bplank\b|dead.?bug|hollow.?hold|ab.?wheel/.test(n))
    return "Press lower back toward neutral. Core braced hard — brace like you're about to get hit. Breathe steadily. Do not hold your breath.";
  if (/push.?up|press.?up/.test(n))
    return "Hands just outside shoulder width. Lower your chest to the floor — full range. Drive through palms. Core tight, no sagging hips.";
  if (/pull.?up|chin.?up/.test(n))
    return "Start from a dead hang. Drive elbows down to your back pockets — that's what moves you up. Chin over bar at top, full extension at bottom.";
  if (/lunge|split.?squat|step.?up/.test(n))
    return "Front knee tracks over toes — never caving in. Lower your back knee toward the floor. Drive through the front heel to stand.";
  if (/hip.?thrust|glute.?bridge/.test(n))
    return "Drive hips up explosively. Squeeze glutes hard at the top for 1 full second. Lower slowly.";
  if (/calf.?raise/.test(n))
    return "Heel as low as possible at the bottom. Rise all the way up onto toes. Pause at the top. No bouncing.";
  if (/rdl|romanian|deadlift|hinge/.test(n))
    return "Push hips back — not down. Flat back the entire way. Feel the hamstring stretch at the bottom. Drive hips forward to stand.";
  return "Control the tempo — 2 seconds down, drive up with intent. Full range of motion on every rep.";
}

/**
 * Scans a workout text block for the first bolded exercise name (*Exercise Name*)
 * and returns its image URL, or null.
 */
export function getPrimaryWorkoutGifUrl(workoutText: string): string | null {
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
  breakfast: CUSTOM_CDN ? `${CUSTOM_CDN}/portions/breakfast.jpg` : null,
  lunch:     CUSTOM_CDN ? `${CUSTOM_CDN}/portions/lunch.jpg`     : null,
  dinner:    CUSTOM_CDN ? `${CUSTOM_CDN}/portions/dinner.jpg`    : null,
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

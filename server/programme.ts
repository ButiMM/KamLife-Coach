// ============================================================
// KAMLIFE PROGRAMME LIBRARY
// All workout programme content and builder functions
// ============================================================

import { resolveExerciseSlug } from "./exercise-media";
import { validateProgramme } from "./verifiers/programme-validator";
import { adaptTraining, trainingAdjustHeader, applySetsDelta, trainingStateFromUser, type TrainingInput } from "./adaptive-training";
import { enforceMessageBudget, MESSAGE_BUDGET } from "./reply-contract";

// Verify pass — appends an injury-safety note when the delivered workout still
// contains a movement that loads a flagged injury. The programme builder already
// filters injured exercises; this is an INDEPENDENT checker with a different
// keyword set, so the two cross-check each other and any filter gap is caught.
// No-op (returns text unchanged) for clients with no injuries.
function withSafetyNote(text: string, user: any): string {
  try {
    return withStateAdjustment(text + validateProgramme(text, user?.injuries).warningNote, user);
  } catch {
    return text;
  }
}

/**
 * ADAPTIVE TRAINING (2026-07-27): food targets moved with the client's state and training never
 * did, so someone back from flu got a reduced calorie target beside their pre-illness weights.
 * Reads the same signals the daily adaptive job uses (sick_until in notes, lastWorkoutDate) and
 * both HEADS the session with the adjustment AND rewrites the set counts, so the sheet can never
 * contradict the instruction above it. Fail-open — any error serves the normal programme.
 */
function withStateAdjustment(text: string, user: any): string {
  try {
    const adj = adaptTraining(trainingStateFromUser(user) as TrainingInput);
    if (!adj.changed) return text;
    return trainingAdjustHeader(adj) + applySetsDelta(text, adj.setsDelta);
  } catch {
    return text;
  }
}

// ============================================================
// TYPE DEFINITIONS
// ============================================================

export type Exercise = {
  name: string;
  sets: string;
  description: string;
  mistake: string;
  modification: string;
  youtube?: string;
};

/**
 * An exercise from the user's CURRENT day, enriched with its canonical slug and the
 * phase/week-adjusted set/rep prescription. Used by the gym-machine photo coach so it can
 * answer "is this machine in my plan today, and what exactly am I doing on it?" — pulling
 * the real prescription (not a hardcoded cue table) so there is one source of truth.
 */
export type DayExercise = {
  name: string;
  slug: string | null;
  setsDisplay: string;
  description: string;
  mistake: string;
  modification: string;
};

// ============================================================
// 2-DAY FULL BODY
// ============================================================

const NEW_2DAY_A: Exercise[] = [
  { name: "Smith Squat / Leg Press", sets: "2 × 6–10", description: "Feet shoulder width. Lower until thighs parallel. Drive through heels. Core tight throughout.", mistake: "Heels rising or knees caving inward. Keep full foot planted.", modification: "Dumbbell Goblet Squat if no machine." },
  { name: "Leg Extension", sets: "2 × 6–10", description: "Full extension at the top — squeeze your quads hard. Lower slowly over 2 seconds.", mistake: "Using momentum. Control both the up and down.", modification: "Dumbbell Step-up if no machine." },
  { name: "Leg Curl", sets: "2 × 6–10", description: "Curl heels all the way toward your glutes. Slow 2-second lowering. Hips stay down.", mistake: "Hips rising off the pad. Keep them pinned throughout.", modification: "Dumbbell Romanian Deadlift as alternative." },
  { name: "Calf Raise", sets: "4 × 12–15", description: "Full range — heel as low as possible, rise all the way up on toes. Pause at the top.", mistake: "Short bouncy reps. Full range is what builds calves.", modification: "Single-leg bodyweight calf raise." },
  { name: "Machine Chest Press / Dumbbell Press", sets: "2 × 6–10", description: "Elbows at 45 degrees from torso. Drive to full extension. Slow 2-second lower.", mistake: "Elbows flaring wide. Keep them at 45 degrees.", modification: "Dumbbell Floor Press if no bench." },
  { name: "Lat Pulldown / Assisted Pull-up", sets: "2 × 6–10", description: "Drive elbows down toward your back pockets. Squeeze shoulder blades hard at the bottom.", mistake: "Pulling with your arms, not your back. Think elbows to pockets.", modification: "Dumbbell Row if no cable machine." },
  { name: "Seated Row / Dumbbell Row", sets: "2 × 6–10", description: "Pull to your lower chest. Squeeze shoulder blades hard together. Full stretch at the front.", mistake: "Leaning back with torso to build momentum. Stay upright.", modification: "Dumbbell Row with knee on bench." },
  { name: "Cable Lateral Raise / Dumbbell Lateral Raise", sets: "2 × 6–10", description: "Arms slightly bent. Raise to shoulder height only. Lower slowly over 2 seconds. No shrugging.", mistake: "Using momentum or raising above shoulder height.", modification: "Dumbbell Lateral Raise." },
];

const NEW_2DAY_B_MEN: Exercise[] = [
  { name: "Smith Squat / Leg Press", sets: "2 × 6–10", description: "Focus on depth today — aim slightly deeper than last session. Drive through heels.", mistake: "Heels rising or knees caving. Keep full foot planted.", modification: "Dumbbell Goblet Squat." },
  { name: "Leg Extension", sets: "2 × 6–10", description: "Full extension, hard squeeze at the top. 2-second lowering phase.", mistake: "Momentum-driven reps. Control both directions.", modification: "Dumbbell Step-up." },
  { name: "Hip Thrust / Glute Bridge", sets: "2 × 6–10", description: "Drive hips up explosively. Squeeze glutes hard at the top for 1 full second. Lower slowly.", mistake: "Using lower back instead of glutes. Drive hips, do not arch back.", modification: "Glute Bridge flat on floor if no bench." },
  { name: "Machine Chest Press / Dumbbell Press", sets: "2 × 6–10", description: "Elbows at 45 degrees. Full extension at top. Slow 2-second lowering.", mistake: "Elbows flaring wide. Keep at 45 degrees throughout.", modification: "Dumbbell Floor Press." },
  { name: "Chest Fly / Dumbbell Chest Fly", sets: "2 × 6–10", description: "Wide arc with a slight bend in the elbows. Squeeze chest hard at the top. Feel the stretch at the bottom.", mistake: "Turning it into a press. Keep the arc shape throughout.", modification: "Dumbbell Chest Fly lying on floor." },
  { name: "Lat Pulldown / Assisted Pull-up", sets: "2 × 6–10", description: "Elbows to pockets. Squeeze back hard at the bottom. Full stretch at the top.", mistake: "Pulling with arms only. Use back muscles.", modification: "Dumbbell Row." },
  { name: "Machine Shoulder Press / Dumbbell Shoulder Press", sets: "2 × 6–10", description: "Press overhead until arms nearly extended. Core braced. Lower slowly.", mistake: "Excessive lower back arch. Brace core and keep ribs down.", modification: "Seated Dumbbell Shoulder Press." },
  { name: "Cable Kickback / Machine Kickback", sets: "2 × 6–10", description: "Elbow pinned at your side. Extend fully until arm is straight. Squeeze tricep hard at the end.", mistake: "Elbow moving — it stays pinned. Only the forearm moves.", modification: "Dumbbell Kickback." },
];

const NEW_2DAY_B_WOMEN: Exercise[] = [
  { name: "Smith Squat / Leg Press", sets: "2 × 6–10", description: "Focus on depth today — aim slightly deeper than last session. Drive through heels.", mistake: "Heels rising or knees caving. Keep full foot planted.", modification: "Dumbbell Goblet Squat." },
  { name: "Leg Extension", sets: "2 × 6–10", description: "Full extension, hard squeeze at the top. 2-second lowering phase.", mistake: "Momentum-driven reps. Control both directions.", modification: "Dumbbell Step-up." },
  { name: "Hip Thrust / Glute Bridge", sets: "2 × 6–10", description: "Drive hips up explosively. Squeeze glutes hard at the top for 1 full second. Lower slowly.", mistake: "Using lower back instead of glutes. Drive hips, do not arch back.", modification: "Glute Bridge flat on floor if no bench." },
  { name: "Machine Shoulder Press / Dumbbell Shoulder Press", sets: "2 × 6–10", description: "Press overhead until arms nearly extended. Core braced. Lower slowly.", mistake: "Excessive lower back arch. Brace core and keep ribs down.", modification: "Seated Dumbbell Shoulder Press." },
  { name: "Chest Fly / Dumbbell Chest Fly", sets: "2 × 6–10", description: "Wide arc, slight elbow bend. Squeeze chest hard at the top. Full stretch at the bottom.", mistake: "Turning it into a press. Keep the arc shape throughout.", modification: "Dumbbell Chest Fly lying on floor." },
  { name: "Lat Pulldown / Assisted Pull-up", sets: "2 × 6–10", description: "Elbows to pockets. Squeeze back hard at the bottom. Full stretch at the top.", mistake: "Pulling with arms only. Use back muscles.", modification: "Dumbbell Row." },
  { name: "Cable Lateral Raise / Dumbbell Lateral Raise", sets: "2 × 6–10", description: "Arms slightly bent. Raise to shoulder height only. Lower slowly. No shrugging.", mistake: "Using momentum or raising above shoulder height.", modification: "Dumbbell Lateral Raise." },
  { name: "Cable Kickback / Machine Kickback", sets: "2 × 6–10", description: "Elbow pinned at your side. Extend fully until arm is straight. Squeeze tricep hard at the end.", mistake: "Elbow moving — it stays pinned. Only the forearm moves.", modification: "Dumbbell Kickback." },
];

// ============================================================
// 3-DAY FULL BODY
// ============================================================

const NEW_3DAY_A: Exercise[] = [
  { name: "Smith Squat / Leg Press", sets: "2 × 6–10", description: "Feet shoulder width. Lower until thighs parallel. Drive through heels. Core tight throughout.", mistake: "Heels rising or knees caving. Keep full foot planted.", modification: "Dumbbell Goblet Squat." },
  { name: "Leg Extension", sets: "2 × 6–10", description: "Full extension at the top — squeeze your quads hard. Lower slowly over 2 seconds.", mistake: "Using momentum. Control both directions.", modification: "Dumbbell Step-up." },
  { name: "Calf Raise", sets: "4 × 12–15", description: "Full range — heel as low as possible, rise all the way up on toes. Pause at the top.", mistake: "Short bouncy reps. Full range is what builds calves.", modification: "Single-leg bodyweight calf raise." },
  { name: "Machine Chest Press / Dumbbell Press", sets: "2 × 6–10", description: "Elbows at 45 degrees from torso. Drive to full extension. Slow 2-second lower.", mistake: "Elbows flaring wide. Keep at 45 degrees.", modification: "Dumbbell Floor Press." },
  { name: "Lat Pulldown / Assisted Pull-up", sets: "2 × 6–10", description: "Drive elbows down toward your back pockets. Squeeze shoulder blades hard at the bottom.", mistake: "Pulling with arms only. Think elbows to pockets.", modification: "Dumbbell Row." },
  { name: "Seated Row / Dumbbell Row", sets: "2 × 6–10", description: "Pull to your lower chest. Squeeze shoulder blades hard together. Full stretch at the front.", mistake: "Leaning back with torso to build momentum. Stay upright.", modification: "Dumbbell Row with knee on bench." },
  { name: "Cable Lateral Raise / Dumbbell Lateral Raise", sets: "2 × 6–10", description: "Arms slightly bent. Raise to shoulder height only. Lower slowly. No shrugging.", mistake: "Using momentum or raising above shoulder height.", modification: "Dumbbell Lateral Raise." },
];

const NEW_3DAY_B: Exercise[] = [
  { name: "Smith Squat / Bulgarian Split Squat", sets: "2 × 6–10", description: "Squat variation — focus on quad depth. Split squat: back foot elevated on bench, front foot far forward.", mistake: "Front knee caving inward. Push it out over your middle toe.", modification: "Dumbbell Goblet Squat or Dumbbell Reverse Lunge." },
  { name: "Leg Curl", sets: "2 × 6–10", description: "Curl heels all the way toward your glutes. Slow 2-second lowering. Hips stay down.", mistake: "Hips rising off the pad. Keep them pinned.", modification: "Dumbbell Romanian Deadlift." },
  { name: "Hip Thrust / Glute Bridge", sets: "2 × 6–10", description: "Drive hips up explosively. Squeeze glutes hard at the top for 1 full second. Lower slowly.", mistake: "Using lower back instead of glutes. Drive hips, do not arch back.", modification: "Glute Bridge flat on floor." },
  { name: "Upper Back Row / Cable Face Pull", sets: "2 × 6–10", description: "Pull to your face with elbows high and wide. Squeeze rear delts hard at the end position.", mistake: "Pulling too low or using too much weight. Light weight, full squeeze.", modification: "Bent-Over Rear Delt Raise with dumbbells." },
  { name: "Chest Fly / Dumbbell Chest Fly", sets: "2 × 6–10", description: "Wide arc, slight elbow bend. Squeeze chest hard at the top. Full stretch at the bottom.", mistake: "Turning it into a press. Keep the arc shape throughout.", modification: "Dumbbell Chest Fly lying on floor." },
  { name: "Bicep Curl", sets: "2 × 6–10", description: "Elbows pinned at your sides. Curl fully to shoulder. Lower slowly — do not swing.", mistake: "Swinging torso or elbows drifting forward.", modification: "Seated dumbbell curl to remove swing." },
  { name: "Tricep Pushdown", sets: "2 × 6–10", description: "Elbows pinned firmly at your sides. Push down until arms are straight. Squeeze at the bottom.", mistake: "Elbows drifting forward. If they move, reduce the weight.", modification: "Dumbbell Overhead Tricep Extension." },
];

const NEW_3DAY_C_MEN: Exercise[] = [
  { name: "Leg Press", sets: "2 × 6–10", description: "Feet mid-platform. Lower until thighs past parallel. Drive through heels.", mistake: "Locking knees fully at the top. Keep a slight bend.", modification: "Dumbbell Goblet Squat." },
  { name: "Cable Kickback / Machine Kickback", sets: "2 × 6–10", description: "Elbow pinned at your side. Extend fully until arm is straight. Squeeze tricep hard.", mistake: "Elbow moving — it stays pinned. Only the forearm moves.", modification: "Dumbbell Kickback." },
  { name: "Machine Chest Press / Dumbbell Press", sets: "2 × 6–10", description: "Elbows at 45 degrees. Full extension. Slow 2-second lower. Chest drives the movement.", mistake: "Elbows flaring wide. Keep at 45 degrees.", modification: "Dumbbell Floor Press." },
  { name: "Lat Pulldown / Assisted Pull-up", sets: "2 × 6–10", description: "Elbows to pockets. Squeeze shoulder blades hard at the bottom. Full stretch at the top.", mistake: "Pulling with arms only. Use back muscles.", modification: "Dumbbell Row." },
  { name: "Machine Shoulder Press / Dumbbell Shoulder Press", sets: "2 × 6–10", description: "Press overhead until arms nearly extended. Core braced. Lower slowly.", mistake: "Excessive lower back arch. Brace core, keep ribs down.", modification: "Seated Dumbbell Shoulder Press." },
  { name: "Bicep Curl", sets: "2 × 6–10", description: "Elbows pinned at sides. Curl fully to shoulder. Lower slowly. Do not swing.", mistake: "Swinging torso or elbows drifting forward.", modification: "Seated dumbbell curl." },
  { name: "Tricep Pushdown", sets: "2 × 6–10", description: "Elbows pinned at sides. Push down until arms straight. Squeeze at bottom.", mistake: "Elbows drifting forward. Reduce weight if they move.", modification: "Dumbbell Overhead Tricep Extension." },
];

const NEW_3DAY_C_WOMEN: Exercise[] = [
  { name: "Leg Press", sets: "2 × 6–10", description: "Feet mid-platform. Lower until thighs past parallel. Drive through heels.", mistake: "Locking knees fully at the top. Keep a slight bend.", modification: "Dumbbell Goblet Squat." },
  { name: "Cable Kickback / Machine Kickback", sets: "2 × 6–10", description: "Elbow pinned at your side. Extend fully until arm is straight. Squeeze tricep hard.", mistake: "Elbow moving — it stays pinned. Only the forearm moves.", modification: "Dumbbell Kickback." },
  { name: "Cable Lateral Raise / Dumbbell Lateral Raise", sets: "2 × 6–10", description: "Arms slightly bent. Raise to shoulder height only. Lower slowly. No shrugging.", mistake: "Using momentum or raising above shoulder height.", modification: "Dumbbell Lateral Raise." },
  { name: "Lat Pulldown / Assisted Pull-up", sets: "2 × 6–10", description: "Elbows to pockets. Squeeze shoulder blades hard at the bottom. Full stretch at the top.", mistake: "Pulling with arms only. Use back muscles.", modification: "Dumbbell Row." },
  { name: "Machine Shoulder Press / Dumbbell Shoulder Press", sets: "2 × 6–10", description: "Press overhead until arms nearly extended. Core braced. Lower slowly.", mistake: "Excessive lower back arch. Brace core, keep ribs down.", modification: "Seated Dumbbell Shoulder Press." },
  { name: "Bicep Curl", sets: "2 × 6–10", description: "Elbows pinned at sides. Curl fully to shoulder. Lower slowly. Do not swing.", mistake: "Swinging torso or elbows drifting forward.", modification: "Seated dumbbell curl." },
  { name: "Tricep Pushdown", sets: "2 × 6–10", description: "Elbows pinned at sides. Push down until arms straight. Squeeze at bottom.", mistake: "Elbows drifting forward. Reduce weight if they move.", modification: "Dumbbell Overhead Tricep Extension." },
];

// ============================================================
// 4-DAY UPPER / LOWER
// ============================================================

const NEW_4DAY_UPPER_A: Exercise[] = [
  { name: "Machine Chest Press / Dumbbell Press", sets: "2 × 6–10", description: "Elbows at 45 degrees. Full extension. Slow 2-second lower. Chest drives the movement.", mistake: "Elbows flaring wide. Keep at 45 degrees.", modification: "Dumbbell Floor Press." },
  { name: "Lat Pulldown / Assisted Pull-up", sets: "2 × 6–10", description: "Drive elbows down toward your back pockets. Squeeze shoulder blades hard at the bottom.", mistake: "Pulling with arms only. Think elbows to pockets.", modification: "Dumbbell Row." },
  { name: "Seated Row / Dumbbell Row", sets: "2 × 6–10", description: "Pull to your lower chest. Squeeze shoulder blades hard together. Full stretch at the front.", mistake: "Leaning back with torso to build momentum. Stay upright.", modification: "Dumbbell Row with knee on bench." },
  { name: "Cable Lateral Raise / Dumbbell Lateral Raise", sets: "2 × 6–10", description: "Arms slightly bent. Raise to shoulder height only. Lower slowly. No shrugging.", mistake: "Using momentum or raising above shoulder height.", modification: "Dumbbell Lateral Raise." },
  { name: "Cable Face Pull / Upper Back Row", sets: "2 × 6–10", description: "Pull to your face, elbows high and wide. Squeeze rear delts hard at the end position.", mistake: "Pulling too low or using too much weight.", modification: "Bent-Over Rear Delt Raise with dumbbells." },
  { name: "Bicep Curl", sets: "2 × 6–10", description: "Elbows pinned at sides. Curl fully to shoulder. Lower slowly. Do not swing.", mistake: "Swinging torso or elbows drifting forward.", modification: "Seated dumbbell curl." },
  { name: "Tricep Pushdown", sets: "2 × 6–10", description: "Elbows pinned at sides. Push down until arms straight. Squeeze at bottom.", mistake: "Elbows drifting forward. Reduce weight if they move.", modification: "Dumbbell Overhead Tricep Extension." },
];

const NEW_4DAY_LOWER_A: Exercise[] = [
  { name: "Smith Squat / Leg Press", sets: "2 × 6–10", description: "Feet shoulder width. Lower until thighs parallel. Drive through heels. Core tight.", mistake: "Heels rising or knees caving. Keep full foot planted.", modification: "Dumbbell Goblet Squat." },
  { name: "Leg Extension", sets: "2 × 6–10", description: "Full extension, hard squeeze at the top. 2-second lowering phase.", mistake: "Momentum-driven reps. Control both directions.", modification: "Dumbbell Step-up." },
  { name: "Leg Curl", sets: "2 × 6–10", description: "Curl heels toward your glutes. Slow 2-second lowering. Hips stay down.", mistake: "Hips rising off the pad. Keep them pinned.", modification: "Dumbbell Romanian Deadlift." },
  { name: "Hip Thrust / Glute Bridge", sets: "2 × 6–10", description: "Drive hips up explosively. Squeeze glutes hard at top for 1 full second. Lower slowly.", mistake: "Using lower back instead of glutes. Drive hips.", modification: "Glute Bridge flat on floor." },
  { name: "Calf Raise", sets: "4 × 12–15", description: "Full range — heel as low as possible, rise all the way up on toes. Pause at top.", mistake: "Short bouncy reps. Full range builds calves.", modification: "Single-leg bodyweight calf raise." },
  { name: "Bulgarian Split Squat / Reverse Lunge", sets: "2 × 6–10", description: "Back foot elevated on bench. Front foot far forward. Lower back knee toward floor. Drive through front heel.", mistake: "Front knee caving inward. Push it out over middle toe.", modification: "Dumbbell Reverse Lunge." },
  { name: "Cable Kickback / Machine Kickback", sets: "2 × 6–10", description: "Elbow pinned at your side. Extend fully until arm is straight. Squeeze tricep hard.", mistake: "Elbow moving — it stays pinned. Only forearm moves.", modification: "Dumbbell Kickback." },
];

const NEW_4DAY_UPPER_B_MEN: Exercise[] = [
  { name: "Chest Fly / Dumbbell Chest Fly", sets: "2 × 6–10", description: "Wide arc, slight elbow bend. Squeeze chest hard at the top. Full stretch at the bottom.", mistake: "Turning it into a press. Keep the arc shape throughout.", modification: "Dumbbell Chest Fly lying on floor." },
  { name: "Lat Pulldown / Assisted Pull-up", sets: "2 × 6–10", description: "Elbows to pockets. Squeeze shoulder blades hard at the bottom. Full stretch at the top.", mistake: "Pulling with arms only. Use back muscles.", modification: "Dumbbell Row." },
  { name: "Machine Shoulder Press / Dumbbell Shoulder Press", sets: "2 × 6–10", description: "Press overhead until arms nearly extended. Core braced. Lower slowly.", mistake: "Excessive lower back arch. Brace core, ribs down.", modification: "Seated Dumbbell Shoulder Press." },
  { name: "Machine Chest Press / Dumbbell Press", sets: "2 × 6–10", description: "Elbows at 45 degrees. Full extension. Slow 2-second lower.", mistake: "Elbows flaring wide. Keep at 45 degrees.", modification: "Dumbbell Floor Press." },
  { name: "Cable Face Pull / Upper Back Row", sets: "2 × 6–10", description: "Pull to face, elbows high and wide. Squeeze rear delts hard at the end position.", mistake: "Pulling too low or using too much weight.", modification: "Bent-Over Rear Delt Raise with dumbbells." },
  { name: "Bicep Curl", sets: "2 × 6–10", description: "Elbows pinned at sides. Curl fully to shoulder. Lower slowly. Do not swing.", mistake: "Swinging torso or elbows drifting forward.", modification: "Seated dumbbell curl." },
  { name: "Tricep Pushdown", sets: "2 × 6–10", description: "Elbows pinned at sides. Push down until arms straight. Squeeze at bottom.", mistake: "Elbows drifting forward. Reduce weight if they move.", modification: "Dumbbell Overhead Tricep Extension." },
];

const NEW_4DAY_UPPER_B_WOMEN: Exercise[] = [
  { name: "Chest Fly / Dumbbell Chest Fly", sets: "2 × 6–10", description: "Wide arc, slight elbow bend. Squeeze chest hard at the top. Full stretch at the bottom.", mistake: "Turning it into a press. Keep the arc shape throughout.", modification: "Dumbbell Chest Fly lying on floor." },
  { name: "Lat Pulldown / Assisted Pull-up", sets: "2 × 6–10", description: "Elbows to pockets. Squeeze shoulder blades hard at the bottom. Full stretch at the top.", mistake: "Pulling with arms only. Use back muscles.", modification: "Dumbbell Row." },
  { name: "Machine Shoulder Press / Dumbbell Shoulder Press", sets: "2 × 6–10", description: "Press overhead until arms nearly extended. Core braced. Lower slowly.", mistake: "Excessive lower back arch. Brace core, ribs down.", modification: "Seated Dumbbell Shoulder Press." },
  { name: "Cable Lateral Raise / Dumbbell Lateral Raise", sets: "2 × 6–10", description: "Arms slightly bent. Raise to shoulder height only. Lower slowly. No shrugging.", mistake: "Using momentum or raising above shoulder height.", modification: "Dumbbell Lateral Raise." },
  { name: "Cable Face Pull / Upper Back Row", sets: "2 × 6–10", description: "Pull to face, elbows high and wide. Squeeze rear delts hard at the end position.", mistake: "Pulling too low or using too much weight.", modification: "Bent-Over Rear Delt Raise with dumbbells." },
  { name: "Bicep Curl", sets: "2 × 6–10", description: "Elbows pinned at sides. Curl fully to shoulder. Lower slowly. Do not swing.", mistake: "Swinging torso or elbows drifting forward.", modification: "Seated dumbbell curl." },
  { name: "Tricep Pushdown", sets: "2 × 6–10", description: "Elbows pinned at sides. Push down until arms straight. Squeeze at bottom.", mistake: "Elbows drifting forward. Reduce weight if they move.", modification: "Dumbbell Overhead Tricep Extension." },
];

const NEW_4DAY_LOWER_B: Exercise[] = [
  { name: "Romanian Deadlift / Dumbbell RDL", sets: "2 × 6–10", description: "Hinge at hips, push bum back. Lower until hamstring stretch. Drive hips forward to stand. Flat back.", mistake: "Rounding the lower back. Only go as deep as a flat back allows.", modification: "Dumbbell RDL." },
  { name: "Leg Press", sets: "2 × 6–10", description: "Feet mid-platform. Lower until thighs past parallel. Drive through heels.", mistake: "Locking knees fully at top. Keep a slight bend.", modification: "Dumbbell Goblet Squat." },
  { name: "Leg Curl", sets: "2 × 6–10", description: "Curl heels toward your glutes. Slow 2-second lowering. Hips stay down.", mistake: "Hips rising off the pad. Keep them pinned.", modification: "Dumbbell Romanian Deadlift." },
  { name: "Hip Thrust / Glute Bridge", sets: "2 × 6–10", description: "Drive hips up explosively. Squeeze glutes hard at top for 1 full second. Lower slowly.", mistake: "Using lower back instead of glutes. Drive hips.", modification: "Glute Bridge flat on floor." },
  { name: "Leg Extension", sets: "2 × 6–10", description: "Full extension, hard squeeze at top. 2-second lowering phase.", mistake: "Momentum-driven reps. Control both directions.", modification: "Dumbbell Step-up." },
  { name: "Bulgarian Split Squat / Reverse Lunge", sets: "2 × 6–10", description: "Back foot elevated on bench. Front foot far forward. Lower back knee toward floor. Drive through front heel.", mistake: "Front knee caving inward. Push it out over middle toe.", modification: "Dumbbell Reverse Lunge." },
  { name: "Cable Kickback / Machine Kickback", sets: "2 × 6–10", description: "Elbow pinned at your side. Extend fully until arm is straight. Squeeze tricep hard.", mistake: "Elbow moving — it stays pinned. Only forearm moves.", modification: "Dumbbell Kickback." },
];

// ============================================================
// DUMBBELL-ONLY PROGRAMME — 2 / 3 / 4 DAY, GENDER-SPECIFIC
// ============================================================

// ── 2-DAY ────────────────────────────────────────────────────

const DB_2DAY_A: Exercise[] = [
  { name: "Goblet Squat", sets: "3 × 10–12", description: "Hold dumbbell at chest. Feet shoulder width. Lower until thighs parallel. Drive through heels. Keep chest tall.", mistake: "Heels rising. Keep full foot planted throughout.", modification: "Hold a bag or backpack filled with books." },
  { name: "Dumbbell Romanian Deadlift", sets: "3 × 10–12", description: "Hinge at hips, push bum back. Lower along shins until hamstring stretch. Drive hips forward to stand. Flat back.", mistake: "Rounding the lower back. Only go as deep as flat back allows.", modification: "Use a bag held in both hands." },
  { name: "Dumbbell Press / Floor Press", sets: "3 × 10–12", description: "Lie on bench or floor. Press dumbbells up until arms nearly extended. Slow 2-second lower. Elbows at 45 degrees.", mistake: "Elbows flaring wide. Keep at 45 degrees throughout.", modification: "Floor press if no bench — works identically." },
  { name: "Dumbbell Row", sets: "3 × 10–12", description: "One knee on bench. Pull dumbbell from full hang to hip. Squeeze shoulder blade hard at top. Lower slowly.", mistake: "Rotating the torso to pull. Keep hips square.", modification: "Both arms bent-over row standing if no bench." },
  { name: "Dumbbell Shoulder Press", sets: "3 × 10–12", description: "Dumbbells at shoulder height. Press overhead until arms nearly extended. Core braced. Lower slowly.", mistake: "Excessive lower back arch. Brace core and keep ribs down.", modification: "Seated press on a chair for lower back support." },
  { name: "Lateral Raise", sets: "3 × 12–15", description: "Arms slightly bent. Raise to shoulder height only. Lower slowly over 2 seconds. No shrugging.", mistake: "Using momentum or raising above shoulder height.", modification: "One arm at a time holding something for balance." },
];

const DB_2DAY_B_MEN: Exercise[] = [
  { name: "Goblet Squat", sets: "3 × 10–12", description: "Go heavier than Day A — same mechanics, more load. Control the descent over 2 seconds.", mistake: "Heels rising or chest collapsing. Drive through full foot.", modification: "Hold a bag or backpack for resistance." },
  { name: "Hip Thrust with Dumbbell", sets: "3 × 12", description: "Upper back on bench. Dumbbell on hips. Drive hips up explosively. Squeeze glutes hard at top for 1 second. Lower slowly.", mistake: "Using lower back to push. Feel it in the glutes, not the spine.", modification: "Glute bridge flat on floor — same movement, no bench." },
  { name: "Incline Dumbbell Press", sets: "3 × 10–12", description: "Bench at 30–45 degrees. Press dumbbells up and slightly inward. Full range. Control descent 2 seconds.", mistake: "Elbows flaring wide. Keep at 45 degrees.", modification: "Flat floor press if no incline bench." },
  { name: "Bent-Over Dumbbell Row", sets: "3 × 10–12", description: "Hinge forward until torso is parallel to floor. Pull both dumbbells to lower chest. Squeeze shoulder blades hard. Lower slowly.", mistake: "Rounding the back to reach. Hinge from hips, keep back flat.", modification: "Single-arm row with support if lower back is sore." },
  { name: "Bicep Curl", sets: "3 × 12", description: "Elbows pinned at sides. Curl fully to shoulder. Lower slowly. Do not swing.", mistake: "Swinging torso or elbows drifting forward.", modification: "Seated dumbbell curl to remove swing." },
  { name: "Tricep Kickback", sets: "3 × 12", description: "Hinge forward. Elbow pinned at side. Extend forearm fully until arm is straight. Squeeze tricep hard at the end.", mistake: "Elbow moving — it stays pinned. Only forearm moves.", modification: "Overhead tricep extension with one dumbbell." },
];

const DB_2DAY_B_WOMEN: Exercise[] = [
  { name: "Bulgarian Split Squat", sets: "3 × 10 each leg", description: "Hold dumbbells at sides. Back foot on bench. Front foot far forward. Lower back knee toward floor. Drive through front heel.", mistake: "Front knee caving inward. Push it out over middle toe.", modification: "Reverse lunge without elevation if balance is a problem." },
  { name: "Hip Thrust with Dumbbell", sets: "3 × 15", description: "Upper back on bench. Dumbbell on hips. Drive hips up explosively. Squeeze glutes hard at top for 1 full second. Lower slowly.", mistake: "Using lower back to push. Feel it in the glutes only.", modification: "Glute bridge flat on floor — identical movement, no bench." },
  { name: "Dumbbell Romanian Deadlift", sets: "3 × 12", description: "Hinge at hips, push bum back. Lower along shins until strong hamstring stretch. Drive hips forward. Flat back.", mistake: "Rounding the lower back. Only go as deep as flat back allows.", modification: "Use a bag held in both hands." },
  { name: "Lateral Raise", sets: "3 × 15", description: "Arms slightly bent. Raise to shoulder height only. Lower slowly over 2 seconds. No shrugging.", mistake: "Using momentum or raising above shoulder height.", modification: "One arm at a time." },
  { name: "Bicep Curl", sets: "3 × 12", description: "Elbows pinned at sides. Curl fully to shoulder. Lower slowly. Do not swing.", mistake: "Swinging torso or elbows drifting forward.", modification: "Seated dumbbell curl to remove swing." },
  { name: "Tricep Kickback", sets: "3 × 12", description: "Hinge forward. Elbow pinned at side. Extend forearm fully until arm is straight. Squeeze tricep hard.", mistake: "Elbow moving — it stays pinned. Only forearm moves.", modification: "Overhead tricep extension with one dumbbell." },
];

// ── 3-DAY ────────────────────────────────────────────────────

const DB_3DAY_A: Exercise[] = [
  { name: "Goblet Squat", sets: "3 × 10–12", description: "Hold dumbbell at chest. Feet shoulder width. Lower until thighs parallel. Drive through heels. Chest tall.", mistake: "Heels rising or chest collapsing. Drive through full foot.", modification: "Hold a bag or backpack." },
  { name: "Dumbbell Romanian Deadlift", sets: "3 × 10–12", description: "Hinge at hips, push bum back. Lower along shins until hamstring stretch. Drive hips forward. Flat back.", mistake: "Rounding the lower back. Only go as deep as flat back allows.", modification: "Use a bag held in both hands." },
  { name: "Dumbbell Press / Floor Press", sets: "3 × 10–12", description: "Lie on bench or floor. Press dumbbells up. Elbows at 45 degrees. Slow 2-second lower.", mistake: "Elbows flaring wide.", modification: "Floor press works identically to bench." },
  { name: "Dumbbell Row", sets: "3 × 10–12", description: "One knee on bench. Pull dumbbell from full hang to hip. Squeeze shoulder blade hard at top. Lower slowly.", mistake: "Rotating torso to pull. Keep hips square.", modification: "Both arms bent-over row standing." },
  { name: "Lateral Raise", sets: "3 × 12–15", description: "Arms slightly bent. Raise to shoulder height only. Lower slowly. No shrugging.", mistake: "Momentum or raising above shoulder height.", modification: "One arm at a time." },
];

const DB_3DAY_B: Exercise[] = [
  { name: "Bulgarian Split Squat", sets: "3 × 10 each leg", description: "Hold dumbbells at sides. Back foot on bench. Front foot far forward. Lower back knee toward floor. Drive through front heel.", mistake: "Front knee caving inward. Push it out over middle toe.", modification: "Reverse lunge without elevation." },
  { name: "Hip Thrust with Dumbbell", sets: "3 × 12", description: "Upper back on bench. Dumbbell on hips. Drive hips up explosively. Squeeze glutes at top for 1 second. Lower slowly.", mistake: "Using lower back instead of glutes.", modification: "Glute bridge flat on floor." },
  { name: "Bent-Over Dumbbell Row", sets: "3 × 10–12", description: "Hinge forward until torso is parallel to floor. Pull both dumbbells to lower chest. Squeeze shoulder blades. Lower slowly.", mistake: "Rounding back. Hinge from hips, keep back flat.", modification: "Single-arm row with support." },
  { name: "Incline Dumbbell Press", sets: "3 × 10–12", description: "Bench at 30–45 degrees. Press dumbbells up and slightly inward. Full range. Control 2-second descent.", mistake: "Elbows flaring wide. Keep at 45 degrees.", modification: "Flat floor press if no incline." },
  { name: "Bicep Curl", sets: "3 × 12", description: "Elbows pinned at sides. Curl fully to shoulder. Lower slowly. Do not swing.", mistake: "Swinging torso or elbows drifting forward.", modification: "Seated dumbbell curl." },
  { name: "Tricep Kickback", sets: "3 × 12", description: "Hinge forward. Elbow pinned at side. Extend fully until arm straight. Squeeze tricep hard.", mistake: "Elbow moving — only the forearm moves.", modification: "Overhead tricep extension." },
];

const DB_3DAY_C_MEN: Exercise[] = [
  { name: "Goblet Squat", sets: "3 × 12", description: "Go heavier than Day A. Control descent slowly over 3 seconds. Feel the quad stretch at the bottom.", mistake: "Rushing through reps. The slow lowering is where the muscle builds.", modification: "Hold a bag or backpack." },
  { name: "Dumbbell Romanian Deadlift", sets: "3 × 12", description: "Heavier than Day A. Hinge at hips, push bum back. Lower until strong hamstring stretch. Drive hips forward.", mistake: "Rounding the lower back.", modification: "Use a bag." },
  { name: "Dumbbell Floor Press", sets: "3 × 10–12", description: "Lie flat on floor. Press dumbbells up. Lower until triceps touch floor. Pause briefly. Press from dead stop.", mistake: "Bouncing triceps off floor for momentum. Pause and press clean.", modification: "Any flat surface works." },
  { name: "Dumbbell Row", sets: "3 × 12", description: "One knee on bench. Pull dumbbell from full hang to hip. Squeeze hard at top. Lower slowly.", mistake: "Rotating torso. Keep hips square.", modification: "Bent-over row both arms." },
  { name: "Dumbbell Shoulder Press", sets: "3 × 12", description: "Dumbbells at shoulder height. Press overhead. Core braced. Lower slowly.", mistake: "Lower back arching. Keep core tight.", modification: "Seated press." },
  { name: "Bicep Curl", sets: "3 × 12", description: "Elbows pinned. Curl fully. Lower slowly. No swing.", mistake: "Elbows drifting forward or swinging torso.", modification: "Seated curl." },
];

const DB_3DAY_C_WOMEN: Exercise[] = [
  { name: "Hip Thrust with Dumbbell", sets: "4 × 15", description: "Upper back on bench. Heavy dumbbell on hips. Drive hips up explosively. Squeeze glutes hard at top for 1 full second.", mistake: "Lower back doing the work. Drive through hips only.", modification: "Glute bridge flat on floor." },
  { name: "Bulgarian Split Squat", sets: "3 × 12 each leg", description: "Hold dumbbells. Back foot on bench. Front foot far forward. Lower back knee toward floor. Drive through front heel.", mistake: "Front knee caving inward.", modification: "Reverse lunge without elevation." },
  { name: "Dumbbell Romanian Deadlift", sets: "3 × 12", description: "Hinge at hips, push bum back. Lower until strong hamstring stretch. Drive hips forward. Flat back.", mistake: "Rounding the lower back.", modification: "Use a bag." },
  { name: "Dumbbell Press / Floor Press", sets: "3 × 10–12", description: "Lie on bench or floor. Press dumbbells up. Elbows at 45 degrees. Slow lower.", mistake: "Elbows flaring wide.", modification: "Floor press." },
  { name: "Lateral Raise", sets: "3 × 15", description: "Arms slightly bent. Raise to shoulder height only. Lower slowly. No shrugging.", mistake: "Momentum or above shoulder height.", modification: "One arm at a time." },
  { name: "Bicep Curl", sets: "3 × 12", description: "Elbows pinned. Curl fully. Lower slowly. No swing.", mistake: "Swinging torso or elbows drifting.", modification: "Seated curl." },
];

// ── 4-DAY ────────────────────────────────────────────────────

const DB_4DAY_UPPER_A: Exercise[] = [
  { name: "Dumbbell Press / Floor Press", sets: "3 × 10–12", description: "Lie on bench or floor. Press dumbbells up. Elbows at 45 degrees. Slow 2-second lower.", mistake: "Elbows flaring wide.", modification: "Floor press works identically." },
  { name: "Dumbbell Row", sets: "3 × 10–12", description: "One knee on bench. Pull dumbbell from full hang to hip. Squeeze shoulder blade hard at top. Lower slowly.", mistake: "Rotating torso to pull.", modification: "Bent-over row both arms standing." },
  { name: "Dumbbell Shoulder Press", sets: "3 × 10–12", description: "Dumbbells at shoulder height. Press overhead. Core braced. Lower slowly.", mistake: "Lower back arching. Core tight.", modification: "Seated press on a chair." },
  { name: "Lateral Raise", sets: "3 × 12–15", description: "Arms slightly bent. Raise to shoulder height. Lower slowly. No shrugging.", mistake: "Momentum or above shoulder height.", modification: "One arm at a time." },
  { name: "Bicep Curl", sets: "3 × 12", description: "Elbows pinned at sides. Curl fully. Lower slowly. No swing.", mistake: "Elbows drifting or torso swinging.", modification: "Seated curl." },
  { name: "Tricep Kickback", sets: "3 × 12", description: "Hinge forward. Elbow pinned at side. Extend fully until arm straight. Squeeze hard.", mistake: "Elbow moving — only forearm moves.", modification: "Overhead extension." },
];

const DB_4DAY_LOWER_A: Exercise[] = [
  { name: "Goblet Squat", sets: "3 × 12", description: "Hold dumbbell at chest. Feet shoulder width. Lower until thighs parallel. Drive through heels.", mistake: "Heels rising or knees caving.", modification: "Hold a bag or backpack." },
  { name: "Dumbbell Romanian Deadlift", sets: "3 × 12", description: "Hinge at hips, push bum back. Lower along shins until hamstring stretch. Drive hips forward. Flat back.", mistake: "Rounding the lower back.", modification: "Use a bag." },
  { name: "Hip Thrust with Dumbbell", sets: "3 × 12", description: "Upper back on bench. Dumbbell on hips. Drive hips up explosively. Squeeze glutes at top 1 second. Lower slowly.", mistake: "Lower back doing the work.", modification: "Glute bridge flat on floor." },
  { name: "Bulgarian Split Squat", sets: "3 × 10 each leg", description: "Hold dumbbells. Back foot on bench. Front foot far forward. Lower back knee toward floor. Drive through front heel.", mistake: "Front knee caving inward.", modification: "Reverse lunge without elevation." },
  { name: "Calf Raise", sets: "4 × 15", description: "Stand holding dumbbells. Rise all the way up on toes. Pause at top. Lower heel fully below step if possible.", mistake: "Short bouncy reps. Full range builds calves.", modification: "Single-leg if both legs are too easy." },
];

const DB_4DAY_UPPER_B_MEN: Exercise[] = [
  { name: "Incline Dumbbell Press", sets: "3 × 10–12", description: "Bench at 30–45 degrees. Press dumbbells up and slightly inward. Full range. Control 2-second descent.", mistake: "Elbows flaring wide. Keep at 45 degrees.", modification: "Flat floor press if no incline." },
  { name: "Bent-Over Dumbbell Row", sets: "3 × 10–12", description: "Hinge forward until torso parallel to floor. Pull both dumbbells to lower chest. Squeeze shoulder blades. Lower slowly.", mistake: "Rounding back. Hinge from hips, flat back.", modification: "Single-arm row with support." },
  { name: "Dumbbell Shoulder Press", sets: "3 × 12", description: "Dumbbells at shoulder height. Press overhead. Core braced. Lower slowly.", mistake: "Lower back arching. Core tight throughout.", modification: "Seated press." },
  { name: "Lateral Raise", sets: "3 × 15", description: "Arms slightly bent. Raise to shoulder height. Lower slowly. No shrugging.", mistake: "Momentum or above shoulder height.", modification: "One arm at a time." },
  { name: "Bicep Curl", sets: "3 × 12", description: "Elbows pinned at sides. Curl fully. Lower slowly. No swing.", mistake: "Torso swinging or elbows drifting.", modification: "Seated curl." },
  { name: "Tricep Kickback", sets: "3 × 12", description: "Hinge forward. Elbow pinned. Extend fully until arm straight. Squeeze hard at end.", mistake: "Elbow moving — only forearm moves.", modification: "Overhead extension." },
];

const DB_4DAY_UPPER_B_WOMEN: Exercise[] = [
  { name: "Incline Dumbbell Press", sets: "3 × 10–12", description: "Bench at 30–45 degrees. Press dumbbells up and slightly inward. Full range. Control 2-second descent.", mistake: "Elbows flaring wide. Keep at 45 degrees.", modification: "Flat floor press if no incline." },
  { name: "Bent-Over Dumbbell Row", sets: "3 × 10–12", description: "Hinge forward until torso parallel to floor. Pull both dumbbells to lower chest. Squeeze shoulder blades. Lower slowly.", mistake: "Rounding back. Hinge from hips, flat back.", modification: "Single-arm row with support." },
  { name: "Lateral Raise", sets: "3 × 15", description: "Arms slightly bent. Raise to shoulder height. Lower slowly. No shrugging.", mistake: "Momentum or above shoulder height.", modification: "One arm at a time." },
  { name: "Bicep Curl", sets: "3 × 12", description: "Elbows pinned at sides. Curl fully. Lower slowly. No swing.", mistake: "Torso swinging or elbows drifting.", modification: "Seated curl." },
  { name: "Tricep Kickback", sets: "3 × 12", description: "Hinge forward. Elbow pinned. Extend fully until arm straight. Squeeze hard.", mistake: "Elbow moving — only forearm moves.", modification: "Overhead extension." },
];

const DB_4DAY_LOWER_B: Exercise[] = [
  { name: "Hip Thrust with Dumbbell", sets: "4 × 12–15", description: "Upper back on bench. Heavy dumbbell on hips. Drive hips up explosively. Squeeze glutes at top 1 full second. Lower slowly.", mistake: "Lower back doing the work. Drive through hips only.", modification: "Glute bridge flat on floor." },
  { name: "Dumbbell Romanian Deadlift", sets: "3 × 12", description: "Heavier than Lower A. Hinge at hips, push bum back. Strong hamstring stretch. Drive hips forward. Flat back.", mistake: "Rounding the lower back.", modification: "Use a bag." },
  { name: "Bulgarian Split Squat", sets: "3 × 10 each leg", description: "Hold dumbbells. Back foot on bench. Front foot far forward. Lower back knee toward floor. Drive through front heel.", mistake: "Front knee caving inward.", modification: "Reverse lunge without elevation." },
  { name: "Goblet Squat", sets: "3 × 15", description: "Higher rep day. Focus on depth and squeeze at bottom. Slow descent 3 seconds.", mistake: "Rushing reps. The slow lowering builds the muscle.", modification: "Hold a bag or backpack." },
  { name: "Calf Raise", sets: "4 × 15", description: "Stand holding dumbbells. Full range — heel as low as possible, all the way up on toes. Pause at top.", mistake: "Short bouncy reps. Full range only.", modification: "Single-leg." },
];

// ============================================================
// HOME PROGRAMME — 2 / 3 / 4 DAY, GENDER-SPECIFIC
// Bodyweight + improvised load (bag, backpack, water bottles)
// ============================================================

// ── 2-DAY ────────────────────────────────────────────────────

const HOME_2DAY_A: Exercise[] = [
  { name: "Squat", sets: "3 × 15", description: "Feet shoulder width. Lower until thighs parallel. Drive through heels. Chest tall. Add a backpack with books for extra resistance.", mistake: "Knees caving inward. Push knees out over toes throughout.", modification: "Squat to a chair and stand back up." },
  { name: "Push-Up", sets: "3 × 10", description: "Hands shoulder width. Body straight from head to heels. Lower chest to floor. Push up explosively.", mistake: "Hips sagging or rising. Keep body in one straight line.", modification: "Knees on floor until you build strength." },
  { name: "Glute Bridge", sets: "3 × 15", description: "Lie on back. Feet flat, hip width. Drive hips to ceiling. Squeeze glutes hard at top for 2 seconds. Lower slowly.", mistake: "Pushing through lower back instead of glutes. Drive hips up.", modification: "Place a bag on hips for added resistance." },
  { name: "Reverse Lunge", sets: "3 × 10 each leg", description: "Stand tall. Step one foot back. Lower back knee toward floor. Push through front heel to return. Torso upright.", mistake: "Front knee travelling past toes. Keep shin vertical.", modification: "Hold a wall for balance until comfortable." },
  { name: "Table Row", sets: "3 × 12", description: "Sit under a sturdy table. Grip edge. Body straight. Pull chest up to table. Lower slowly.", mistake: "Hips dropping. Keep body rigid like a plank throughout.", modification: "Bend knees to make it easier." },
  { name: "Plank", sets: "3 × 30 sec", description: "Forearms on floor. Body straight from head to heels. Squeeze stomach hard. Breathe steadily.", mistake: "Hips rising or sagging. Everything in one line.", modification: "Drop knees to floor." },
];

const HOME_2DAY_B_MEN: Exercise[] = [
  { name: "Jump Squat", sets: "3 × 10", description: "Feet shoulder width. Squat to parallel. Explode upward. Land softly with bent knees. Reset and go again.", mistake: "Landing stiff-legged. Absorb through hips and knees on every landing.", modification: "Regular squat if knees are sore." },
  { name: "Push-Up", sets: "3 × 12", description: "Hands shoulder width. Body straight. Lower chest to floor. Push up explosively. More reps than Day A.", mistake: "Hips sagging. Keep core tight throughout.", modification: "Knees on floor." },
  { name: "Single-Leg Glute Bridge", sets: "3 × 10 each leg", description: "Lie on back. One foot flat, other leg extended. Drive hips up through planted heel. Squeeze hard at top. Lower slowly.", mistake: "Hips dropping to one side. Keep hips level throughout.", modification: "Both feet down (regular glute bridge)." },
  { name: "Walking Lunge", sets: "3 × 10 each leg", description: "Step forward into a lunge. Back knee almost touches floor. Step through and continue walking. Keep torso upright.", mistake: "Leaning forward. Keep chest up and shoulders back.", modification: "Stationary reverse lunge if space is limited." },
  { name: "Door Frame Row", sets: "3 × 12", description: "Stand in doorframe. Grip both sides at chest height. Lean back until arms straight. Pull chest to frame. Squeeze shoulder blades.", mistake: "Using momentum. Control both directions.", modification: "Table row if no doorframe." },
  { name: "Plank", sets: "3 × 40 sec", description: "Forearms on floor. Body straight. Squeeze stomach hard. Breathe steadily.", mistake: "Hips rising or sagging.", modification: "Knees on floor." },
];

const HOME_2DAY_B_WOMEN: Exercise[] = [
  { name: "Sumo Squat", sets: "3 × 15", description: "Feet wide, toes pointing out at 45 degrees. Lower until thighs parallel. Drive through heels. Squeeze glutes at top. Add backpack for resistance.", mistake: "Knees caving inward. Push them out over toes.", modification: "Squat to a chair." },
  { name: "Push-Up", sets: "3 × 10", description: "Hands shoulder width. Body straight. Lower chest to floor. Push up explosively.", mistake: "Hips sagging or rising. One straight line.", modification: "Knees on floor." },
  { name: "Single-Leg Glute Bridge", sets: "4 × 12 each leg", description: "Lie on back. One foot flat, other leg extended. Drive hips up through planted heel. Squeeze glutes hard at top. Lower slowly.", mistake: "Hips tilting to one side. Keep them level throughout.", modification: "Place a bag on hips for added load." },
  { name: "Reverse Lunge", sets: "3 × 12 each leg", description: "Stand tall. Step one foot back. Lower back knee toward floor. Push through front heel to return. Torso upright.", mistake: "Front knee past toes. Keep shin vertical.", modification: "Hold a wall for balance." },
  { name: "Table Row", sets: "3 × 12", description: "Sit under a sturdy table. Grip edge. Body straight. Pull chest up to table. Lower slowly.", mistake: "Hips dropping. Keep body rigid like a plank.", modification: "Bend knees to make it easier." },
  { name: "Plank", sets: "3 × 30 sec", description: "Forearms on floor. Body straight. Squeeze stomach hard. Breathe steadily.", mistake: "Hips rising or sagging.", modification: "Knees on floor." },
];

// ── 3-DAY ────────────────────────────────────────────────────

const HOME_3DAY_A: Exercise[] = [
  { name: "Squat", sets: "3 × 15", description: "Feet shoulder width. Lower until thighs parallel. Drive through heels. Chest tall. Add a backpack for resistance.", mistake: "Knees caving inward. Push knees out over toes.", modification: "Squat to a chair." },
  { name: "Push-Up", sets: "3 × 10", description: "Hands shoulder width. Body straight. Lower chest to floor. Push up explosively.", mistake: "Hips sagging or rising. One straight line.", modification: "Knees on floor." },
  { name: "Glute Bridge", sets: "3 × 15", description: "Lie on back. Feet flat hip width. Drive hips up. Squeeze glutes hard at top 2 seconds. Lower slowly.", mistake: "Lower back doing the work. Drive through hips.", modification: "Place a bag on hips for load." },
  { name: "Reverse Lunge", sets: "3 × 10 each leg", description: "Step back. Lower back knee toward floor. Push through front heel. Torso upright.", mistake: "Front knee past toes. Keep shin vertical.", modification: "Hold a wall for balance." },
  { name: "Table Row", sets: "3 × 12", description: "Sit under sturdy table. Grip edge. Body straight. Pull chest up. Lower slowly.", mistake: "Hips dropping. Keep body rigid.", modification: "Bend knees to make it easier." },
  { name: "Plank", sets: "3 × 30 sec", description: "Forearms on floor. Body straight. Squeeze stomach. Breathe steadily.", mistake: "Hips rising or sagging.", modification: "Knees on floor." },
];

const HOME_3DAY_B: Exercise[] = [
  { name: "Jump Squat", sets: "3 × 10", description: "Squat to parallel. Explode upward. Land softly with bent knees. Reset.", mistake: "Stiff landing. Absorb through hips and knees.", modification: "Regular squat if knees are sore." },
  { name: "Pike Push-Up", sets: "3 × 8", description: "Hips high, forming a triangle. Lower head toward floor between hands. Push back up. Targets shoulders.", mistake: "Bending the knees or not going low enough.", modification: "Regular push-up if too hard." },
  { name: "Single-Leg Glute Bridge", sets: "3 × 10 each leg", description: "One foot flat, other leg extended. Drive hips up through planted heel. Squeeze at top. Lower slowly.", mistake: "Hips tilting to one side. Keep them level.", modification: "Both feet down if too hard." },
  { name: "Walking Lunge", sets: "3 × 10 each leg", description: "Step forward into a lunge. Back knee almost touches floor. Step through. Chest up.", mistake: "Leaning forward. Keep torso upright throughout.", modification: "Stationary lunge if no space." },
  { name: "Door Frame Row", sets: "3 × 12", description: "Stand in doorframe. Grip sides. Lean back. Pull chest to frame. Squeeze shoulder blades.", mistake: "Swinging forward with momentum. Control both directions.", modification: "Table row if no doorframe." },
];

const HOME_3DAY_C_MEN: Exercise[] = [
  { name: "Squat", sets: "3 × 20", description: "High-rep day. Add a backpack for resistance. Control descent 2 seconds. Feel the burn.", mistake: "Rushing reps. Slow lowering builds the muscle.", modification: "Bodyweight only — do 25 reps." },
  { name: "Diamond Push-Up", sets: "3 × 8", description: "Hands close together forming a diamond under chest. Lower chest to hands. Push back up. Targets triceps and chest.", mistake: "Elbows flaring wide. Keep them pointing back.", modification: "Wide push-up if too hard." },
  { name: "Glute Bridge", sets: "4 × 20", description: "Drive hips up explosively. Squeeze glutes hard at top for 1 full second. High rep day — feel the burn.", mistake: "Lower back doing the work. Drive through hips.", modification: "Place a bag on hips for added resistance." },
  { name: "Reverse Lunge", sets: "3 × 12 each leg", description: "Step back. Lower back knee toward floor. Push through front heel. Torso upright.", mistake: "Front knee past toes. Shin stays vertical.", modification: "Hold a wall for balance." },
  { name: "Table Row", sets: "3 × 15", description: "Sit under sturdy table. Grip edge. Body straight. Pull chest up. Lower slowly. More reps than before.", mistake: "Hips dropping. Keep body rigid.", modification: "Bend knees." },
  { name: "Plank", sets: "3 × 45 sec", description: "Forearms on floor. Body straight. Squeeze stomach. Breathe steadily. Longer hold than before.", mistake: "Hips rising or sagging.", modification: "Knees on floor." },
];

const HOME_3DAY_C_WOMEN: Exercise[] = [
  { name: "Sumo Squat", sets: "3 × 20", description: "Feet wide, toes out 45 degrees. Lower until thighs parallel. Squeeze glutes at top. Add backpack for resistance.", mistake: "Knees caving inward. Push out over toes.", modification: "Squat to chair." },
  { name: "Push-Up", sets: "3 × 12", description: "Hands shoulder width. Body straight. Lower chest to floor. Push up explosively. More reps than Day A.", mistake: "Hips sagging. One straight line.", modification: "Knees on floor." },
  { name: "Single-Leg Glute Bridge", sets: "4 × 15 each leg", description: "One foot flat, other extended. Drive hips up through planted heel. Squeeze at top. High reps — feel the glutes burn.", mistake: "Hips tilting to one side. Keep level.", modification: "Place a bag on hips for load." },
  { name: "Reverse Lunge", sets: "3 × 12 each leg", description: "Step back. Lower back knee toward floor. Push through front heel. Torso upright.", mistake: "Front knee past toes.", modification: "Hold wall for balance." },
  { name: "Table Row", sets: "3 × 15", description: "Sit under sturdy table. Grip edge. Body straight. Pull chest up. Lower slowly.", mistake: "Hips dropping. Keep rigid.", modification: "Bend knees." },
  { name: "Plank", sets: "3 × 40 sec", description: "Forearms on floor. Body straight. Squeeze stomach. Breathe steadily.", mistake: "Hips rising or sagging.", modification: "Knees on floor." },
];

// ── 4-DAY ────────────────────────────────────────────────────

const HOME_4DAY_UPPER_A: Exercise[] = [
  { name: "Push-Up", sets: "4 × 12", description: "Hands shoulder width. Body straight. Lower chest to floor. Push up explosively.", mistake: "Hips sagging. One straight line.", modification: "Knees on floor." },
  { name: "Pike Push-Up", sets: "3 × 8", description: "Hips high forming a triangle. Lower head toward floor between hands. Push back up. Shoulder builder.", mistake: "Knees bending or not going low enough.", modification: "Regular push-up if too hard." },
  { name: "Table Row", sets: "4 × 12", description: "Sit under sturdy table. Grip edge. Body straight. Pull chest up. Lower slowly.", mistake: "Hips dropping. Keep body rigid like a plank.", modification: "Bend knees." },
  { name: "Door Frame Row", sets: "3 × 12", description: "Grip doorframe sides at chest height. Lean back. Pull chest to frame. Squeeze shoulder blades.", mistake: "Swinging with momentum. Control both directions.", modification: "Table row." },
  { name: "Plank", sets: "3 × 40 sec", description: "Forearms on floor. Body straight. Core squeezed. Breathe steadily.", mistake: "Hips rising or sagging.", modification: "Knees on floor." },
];

const HOME_4DAY_LOWER_A: Exercise[] = [
  { name: "Squat", sets: "4 × 15", description: "Feet shoulder width. Lower until thighs parallel. Drive through heels. Chest tall. Add backpack for resistance.", mistake: "Knees caving inward.", modification: "Squat to a chair." },
  { name: "Glute Bridge", sets: "4 × 15", description: "Lie on back. Feet flat hip width. Drive hips up. Squeeze glutes at top 2 seconds. Lower slowly.", mistake: "Lower back doing the work.", modification: "Place a bag on hips." },
  { name: "Reverse Lunge", sets: "3 × 12 each leg", description: "Step back. Lower back knee toward floor. Push through front heel. Torso upright.", mistake: "Front knee past toes.", modification: "Hold wall for balance." },
  { name: "Calf Raise", sets: "4 × 20", description: "Stand on edge of a step. Full range — heel all the way down, rise up on toes. Pause at top.", mistake: "Short bouncy reps. Full range builds calves.", modification: "Flat floor if no step." },
];

const HOME_4DAY_UPPER_B_MEN: Exercise[] = [
  { name: "Diamond Push-Up", sets: "3 × 8", description: "Hands close together forming a diamond. Lower chest to hands. Push back up. Triceps and chest.", mistake: "Elbows flaring wide. Point them back.", modification: "Wide push-up if too hard." },
  { name: "Decline Push-Up", sets: "3 × 10", description: "Feet on a chair or couch. Hands on floor. Lower chest toward floor. Press back up.", mistake: "Hips rising. Keep body straight.", modification: "Regular push-up." },
  { name: "Table Row", sets: "4 × 15", description: "Sit under sturdy table. Grip edge. Body straight. Pull chest up to table. Lower slowly.", mistake: "Hips dropping. Keep rigid.", modification: "Bend knees." },
  { name: "Plank", sets: "3 × 45 sec", description: "Forearms on floor. Body straight. Core squeezed. Breathe steadily.", mistake: "Hips rising or sagging.", modification: "Knees on floor." },
];

const HOME_4DAY_UPPER_B_WOMEN: Exercise[] = [
  { name: "Wide Push-Up", sets: "3 × 10", description: "Hands wider than shoulder width. Lower chest to floor. Push back up. Targets chest more than standard push-up.", mistake: "Hips sagging. One straight line.", modification: "Knees on floor." },
  { name: "Pike Push-Up", sets: "3 × 8", description: "Hips high forming a triangle. Lower head toward floor between hands. Push back up.", mistake: "Knees bending or not going low enough.", modification: "Regular push-up." },
  { name: "Table Row", sets: "4 × 15", description: "Sit under sturdy table. Grip edge. Body straight. Pull chest up. Lower slowly.", mistake: "Hips dropping. Keep body rigid.", modification: "Bend knees." },
  { name: "Plank", sets: "3 × 40 sec", description: "Forearms on floor. Body straight. Core squeezed. Breathe steadily.", mistake: "Hips rising or sagging.", modification: "Knees on floor." },
];

const HOME_4DAY_LOWER_B_MEN: Exercise[] = [
  { name: "Jump Squat", sets: "4 × 12", description: "Squat to parallel. Explode upward. Land softly with bent knees. Reset immediately.", mistake: "Stiff landing. Absorb through hips and knees.", modification: "Regular squat if knees are sore." },
  { name: "Single-Leg Glute Bridge", sets: "3 × 12 each leg", description: "One foot flat, other extended. Drive hips up through planted heel. Squeeze at top. Lower slowly.", mistake: "Hips tilting to one side. Keep level.", modification: "Place a bag on hips for load." },
  { name: "Walking Lunge", sets: "3 × 12 each leg", description: "Step forward into a lunge. Back knee almost touches floor. Step through. Chest up.", mistake: "Leaning forward. Torso upright throughout.", modification: "Stationary lunge." },
  { name: "Bulgarian Split Squat", sets: "3 × 10 each leg", description: "Back foot on a chair or couch. Front foot far forward. Lower back knee toward floor. Drive through front heel.", mistake: "Front knee caving inward. Push out over middle toe.", modification: "Reverse lunge without elevation." },
];

const HOME_4DAY_LOWER_B_WOMEN: Exercise[] = [
  { name: "Sumo Squat", sets: "4 × 20", description: "Feet wide, toes out 45 degrees. Lower until thighs parallel. Squeeze glutes at top. Add backpack for load.", mistake: "Knees caving inward. Push out over toes.", modification: "Squat to chair." },
  { name: "Single-Leg Glute Bridge", sets: "4 × 15 each leg", description: "One foot flat, other extended. Drive hips up through planted heel. Squeeze glutes hard at top. Lower slowly.", mistake: "Hips tilting to one side. Keep level.", modification: "Place a bag on hips for extra load." },
  { name: "Walking Lunge", sets: "3 × 12 each leg", description: "Step forward into a lunge. Back knee almost touches floor. Step through. Chest up.", mistake: "Leaning forward. Torso upright.", modification: "Stationary lunge." },
  { name: "Bulgarian Split Squat", sets: "3 × 12 each leg", description: "Back foot on a chair or couch. Front foot far forward. Lower back knee toward floor. Drive through front heel.", mistake: "Front knee caving inward. Push out over middle toe.", modification: "Reverse lunge without elevation." },
];

// ============================================================
// GYM — 3-DAY FULL BODY (FULL EQUIPMENT) — kept for backward compat
// ============================================================

const GYM_FULL_DAY_A: Exercise[] = [
  {
    name: "Barbell Squat or Leg Press",
    sets: "3x10",
    description: "Feet shoulder width. Lower until thighs parallel to floor. Drive through heels to stand. Keep chest tall and core braced throughout the movement.",
    mistake: "Heels rising off the floor or knees caving inward. Push knees out over toes and keep weight through your heels.",
    modification: "Leg Press if no barbell available or if you have lower back pain.",
    youtube: "https://www.youtube.com/results?search_query=barbell+squat+form+tutorial",
  },
  {
    name: "Barbell Bench Press or Chest Press Machine",
    sets: "3x10",
    description: "Bar to lower chest. Press until arms are almost fully extended. Lower the bar slowly over 2 seconds. Feet flat on floor, shoulder blades pinched together.",
    mistake: "Bouncing the bar off your chest. Lower it under control and pause briefly at the bottom.",
    modification: "Dumbbell press if no barbell is available.",
    youtube: "https://www.youtube.com/results?search_query=barbell+bench+press+form+tutorial",
  },
  {
    name: "Lat Pulldown",
    sets: "3x10",
    description: "Pull the bar down to your upper chest. Drive your elbows down and back. Squeeze your shoulder blades hard together at the bottom. Return slowly under control.",
    mistake: "Pulling with your arms instead of your back. Think about driving your elbows toward your back pockets.",
    modification: "Resistance band pulldown if no cable machine is available.",
    youtube: "https://www.youtube.com/results?search_query=lat+pulldown+tutorial+form",
  },
  {
    name: "Romanian Deadlift",
    sets: "3x10",
    description: "Hinge at the hips, push your bum back. Lower until you feel a strong hamstring stretch. Drive hips forward to stand. Back must stay flat throughout.",
    mistake: "Rounding the lower back at the bottom. Only go as deep as your flexibility allows while keeping a flat back.",
    modification: "Reduce range of motion if you have tight hamstrings — depth comes with time.",
    youtube: "https://www.youtube.com/results?search_query=romanian+deadlift+form+tutorial",
  },
  {
    name: "Dumbbell Shoulder Press",
    sets: "3x10",
    description: "Dumbbells at shoulder height, palms facing forward. Press overhead until arms are nearly extended. Lower slowly back to starting position.",
    mistake: "Arching your lower back excessively as you press. Brace your core and keep your ribs down.",
    modification: "Seated press for lower back support.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+shoulder+press+tutorial+form",
  },
];

const GYM_FULL_DAY_B: Exercise[] = [
  {
    name: "Hip Thrust (Barbell or Machine)",
    sets: "3x12",
    description: "Upper back resting on bench or in machine. Drive hips up explosively. Squeeze glutes hard at the top and hold for 1 full second. Lower slowly.",
    mistake: "Using your lower back instead of your glutes. Focus on squeezing your bum at the top — if you feel it in your back, reduce weight.",
    modification: "Glute bridge flat on the floor if no bench is available.",
    youtube: "https://www.youtube.com/results?search_query=barbell+hip+thrust+tutorial+form",
  },
  {
    name: "Incline Dumbbell Press",
    sets: "3x10",
    description: "Bench set to 30–45 degrees. Press dumbbells up and slightly inward. Full range of motion — lower until dumbbells are beside your chest. Control the descent.",
    mistake: "Elbows flaring too wide. Keep them at roughly 45 degrees from your torso.",
    modification: "Flat bench press if incline is not available.",
    youtube: "https://www.youtube.com/results?search_query=incline+dumbbell+press+tutorial+form",
  },
  {
    name: "Seated Cable Row",
    sets: "3x10",
    description: "Pull the handle in to your lower chest. Squeeze your shoulder blades hard together and hold briefly. Return slowly — full stretch at the front. Stay upright.",
    mistake: "Leaning too far back or rocking your torso to generate momentum. Keep your back still.",
    modification: "Dumbbell bent-over row if no cable machine is available.",
    youtube: "https://www.youtube.com/results?search_query=seated+cable+row+tutorial+form",
  },
  {
    name: "Bulgarian Split Squat",
    sets: "3x10 each leg",
    description: "Back foot elevated on bench. Front foot placed far forward. Lower your back knee toward the floor. Drive up through your front heel. Keep torso upright.",
    mistake: "Front knee caving inward. Keep it tracking straight over your middle toe throughout.",
    modification: "Regular lunge if balance is a problem. Progress to elevated over time.",
    youtube: "https://www.youtube.com/results?search_query=bulgarian+split+squat+tutorial+form",
  },
  {
    name: "Face Pull",
    sets: "3x15",
    description: "Cable set at face height with rope attachment. Pull rope to your face with elbows high and wide. Squeeze your rear delts hard at the end position. Return slowly.",
    mistake: "Pulling too low or using too much momentum. This is a shoulder health exercise — use light weight and focus on the squeeze.",
    modification: "Rear delt dumbbell fly lying face down on an incline bench if no cable available.",
    youtube: "https://www.youtube.com/results?search_query=face+pull+cable+tutorial+form",
  },
];

const GYM_FULL_DAY_C: Exercise[] = [
  {
    name: "Hack Squat or Leg Press",
    sets: "3x10",
    description: "Aim for a deeper range of motion than Day A. Feet positioned slightly closer together for more quad focus. Control the descent over 2 seconds.",
    mistake: "Not reaching full depth. Go as deep as your mobility allows while keeping lower back against the pad.",
    modification: "Leg Press with a wider stance if Hack Squat is not available.",
    youtube: "https://www.youtube.com/results?search_query=hack+squat+machine+tutorial+form",
  },
  {
    name: "Overhead Press (Barbell or Machine)",
    sets: "3x10",
    description: "Press straight overhead until arms are nearly locked. Core tight and ribs down throughout. Lower slowly back to shoulder height.",
    mistake: "Leaning back excessively to get the bar overhead. Keep your torso upright and brace hard.",
    modification: "Seated dumbbell press if you have shoulder mobility restrictions.",
    youtube: "https://www.youtube.com/results?search_query=overhead+press+barbell+form+tutorial",
  },
  {
    name: "Chest-Supported Row or Barbell Row",
    sets: "3x10",
    description: "Chest resting on incline bench (chest-supported). Pull dumbbells up toward your hips. Squeeze your back hard at the top. Lower slowly. Eliminates lower back involvement.",
    mistake: "Using momentum to swing the weight up. If you cannot do it strict, reduce the weight.",
    modification: "Single arm dumbbell row with knee on bench if chest-supported bench is not available.",
    youtube: "https://www.youtube.com/results?search_query=chest+supported+dumbbell+row+tutorial",
  },
  {
    name: "Leg Curl Machine",
    sets: "3x12",
    description: "Full range of motion — curl heels all the way toward your glutes. Slow lowering phase of 3 seconds. Squeeze hamstrings hard at the top.",
    mistake: "Hips rising off the pad to assist the movement. Keep your hips pinned down throughout.",
    modification: "Nordic curl on the floor — both challenging and effective.",
    youtube: "https://www.youtube.com/results?search_query=leg+curl+machine+tutorial+form",
  },
  {
    name: "Tricep Cable Pushdown",
    sets: "3x12",
    description: "Elbows pinned firmly at your sides. Push down until arms are straight. Squeeze triceps hard at the bottom. Return slowly under control.",
    mistake: "Elbows drifting forward during the movement. If they move, reduce the weight.",
    modification: "Tricep dips off a bench if no cable machine is available.",
    youtube: "https://www.youtube.com/results?search_query=tricep+cable+pushdown+tutorial+form",
  },
];

// ============================================================
// GYM — 3-DAY FULL BODY DUMBBELL-ONLY
// (For Planet Fitness, basic gyms, no barbell/cable)
// ============================================================

const GYM_DUMBBELL_DAY_A: Exercise[] = [
  {
    name: "Goblet Squat",
    sets: "3x12",
    description: "Hold one dumbbell vertically at your chest. Feet shoulder width, toes slightly out. Lower until thighs are parallel. Keep elbows tracking inside your knees. Drive through heels.",
    mistake: "Heels rising off the floor. Keep your full foot flat and drive through the whole foot.",
    modification: "Squat to a chair if knees are weak — stand up from the chair with control.",
    youtube: "https://www.youtube.com/results?search_query=goblet+squat+dumbbell+tutorial+form",
  },
  {
    name: "Dumbbell Bench Press",
    sets: "3x10",
    description: "Lie on a flat bench. Dumbbells held at chest height. Press up until arms are nearly extended. Lower slowly through full range of motion. Feet flat on the floor.",
    mistake: "Elbows flaring out wide. Keep them at roughly 45 degrees from your torso.",
    modification: "Floor press if no bench is available — lie flat on the floor.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+bench+press+tutorial+form",
  },
  {
    name: "Dumbbell Row (each arm)",
    sets: "3x10 each arm",
    description: "One knee on bench for support. Pull dumbbell from a full hang up to your hip. Squeeze your back hard at the top. Lower slowly under control.",
    mistake: "Rotating your torso to pull the weight up. Keep hips square and let only your arm move.",
    modification: "Both arms bent-over row standing if no bench is available.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+single+arm+row+tutorial",
  },
  {
    name: "Dumbbell Romanian Deadlift",
    sets: "3x10",
    description: "Dumbbells in front of thighs. Hinge at hips pushing bum back. Lower along your shins until you feel a strong hamstring stretch. Drive hips forward to return.",
    mistake: "Rounding your lower back. Only go as deep as a flat back allows.",
    modification: "Reduce the range of motion while your flexibility builds over time.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+romanian+deadlift+tutorial+form",
  },
  {
    name: "Dumbbell Shoulder Press",
    sets: "3x10",
    description: "Dumbbells at shoulder height, palms facing forward. Press overhead until arms are nearly extended. Lower slowly back to starting position. Keep core braced.",
    mistake: "Arching your lower back excessively as you press. Brace your core and keep ribs down.",
    modification: "Seated press for lower back support.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+shoulder+press+tutorial+form",
  },
];

const GYM_DUMBBELL_DAY_B: Exercise[] = [
  {
    name: "Hip Thrust with Dumbbell",
    sets: "3x12",
    description: "Upper back on bench. Dumbbell or weight plate balanced on your hips. Drive hips up explosively. Squeeze glutes hard at the top. Lower slowly.",
    mistake: "Using your lower back instead of your glutes. If you feel it in your back, that is the wrong muscle doing the work.",
    modification: "Bodyweight glute bridge flat on the floor.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+hip+thrust+tutorial+form",
  },
  {
    name: "Incline Dumbbell Press",
    sets: "3x10",
    description: "Bench at 30–45 degrees. Press dumbbells up and slightly inward. Full range of motion. Control the descent over 2 seconds.",
    mistake: "Elbows flaring too wide. Keep them at roughly 45 degrees from your torso.",
    modification: "Flat bench press if incline is not available.",
    youtube: "https://www.youtube.com/results?search_query=incline+dumbbell+press+tutorial+form",
  },
  {
    name: "Bent Over Dumbbell Row",
    sets: "3x10",
    description: "Hinge forward until torso is roughly parallel to the floor. Pull both dumbbells up to your lower chest simultaneously. Squeeze shoulder blades together hard. Lower slowly.",
    mistake: "Rounding your back to reach the floor. Hinge from the hips and keep your back flat.",
    modification: "Chest-supported row lying on an incline bench to remove lower back stress.",
    youtube: "https://www.youtube.com/results?search_query=bent+over+dumbbell+row+tutorial+form",
  },
  {
    name: "Dumbbell Bulgarian Split Squat",
    sets: "3x10 each leg",
    description: "Hold dumbbells at sides. Back foot elevated on bench. Front foot far forward. Lower back knee toward floor. Drive through front heel to rise. Torso upright.",
    mistake: "Front knee caving inward. Keep it tracking straight over your middle toe.",
    modification: "Regular lunge if balance is a problem — progress to elevated position over time.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+bulgarian+split+squat+tutorial",
  },
  {
    name: "Lateral Raise",
    sets: "3x15",
    description: "Light dumbbells at sides. Arms slightly bent. Raise to shoulder height only. Lower slowly over 2 seconds. Do not shrug your shoulders up.",
    mistake: "Using momentum to swing the weights up. If you cannot control the lowering phase, reduce weight.",
    modification: "One arm at a time while holding something for balance.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+lateral+raise+tutorial+form",
  },
];

const GYM_DUMBBELL_DAY_C: Exercise[] = [
  {
    name: "Dumbbell Goblet Squat (heavier)",
    sets: "3x12",
    description: "Same mechanics as Day A but use a heavier dumbbell. Focus on depth and control. Slow the descent to 3 seconds. Really feel the quad stretch at the bottom.",
    mistake: "Rushing to get through reps. The controlled lowering phase is where the muscle gets built.",
    modification: "Box squat to a bench if depth is a problem.",
    youtube: "https://www.youtube.com/results?search_query=goblet+squat+dumbbell+tutorial+form",
  },
  {
    name: "Dumbbell Floor Press",
    sets: "3x10",
    description: "Lie flat on the floor. Dumbbells at chest height. Press up. Lower slowly until your triceps touch the floor. Pause briefly. Press again. Full range within floor limits.",
    mistake: "Bouncing your triceps off the floor to generate momentum. Pause at the bottom and press from a dead stop.",
    modification: "Regular dumbbell press on a bench if available.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+floor+press+tutorial+form",
  },
  {
    name: "Single Arm Row",
    sets: "3x10 each arm",
    description: "One knee on bench for support. Pull dumbbell from a full hang to your hip. Focus on a slow 3-second lowering phase. Squeeze the back hard at the top.",
    mistake: "Rushing the lowering phase. The eccentric is as important as the pull — control it.",
    modification: "Seated cable row if available and you prefer bilateral.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+single+arm+row+tutorial",
  },
  {
    name: "Dumbbell Hip Thrust",
    sets: "3x12",
    description: "Upper back on bench. Heavier dumbbell than Day B. Drive hips up. Squeeze hard at the top for 1 second. Lower slowly under control.",
    mistake: "Not achieving full hip extension at the top. Push until your body is in a straight line from knees to shoulders.",
    modification: "Bodyweight hip thrust if heavier dumbbell is too much.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+hip+thrust+tutorial",
  },
  {
    name: "Tricep Overhead Extension",
    sets: "3x12",
    description: "Hold one dumbbell overhead with both hands gripping the top plate. Lower the dumbbell behind your head by bending at the elbows. Extend back up. Elbows stay close to head.",
    mistake: "Elbows flaring out wide as you lower. Keep them pointing forward throughout.",
    modification: "Tricep dips off a bench if overhead extension causes shoulder discomfort.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+overhead+tricep+extension+tutorial",
  },
];

// ============================================================
// GYM — FEMALE GLUTE-FOCUS PROGRAMME
// (3 days, for users with primaryFocusArea === "glutes_legs")
// ============================================================

const GYM_GLUTES_DAY_A: Exercise[] = [
  {
    name: "Barbell Hip Thrust",
    sets: "4x12",
    description: "This is your primary movement. Upper back on bench. Bar padded on hips. Drive hips up explosively. Squeeze glutes hard for 1 full second at the top. Lower slowly over 2 seconds.",
    mistake: "Pushing through your lower back instead of your glutes. If your lower back is sore, that is wrong — focus on the bum squeeze at the top.",
    modification: "Bodyweight or dumbbell hip thrust if no barbell or pad available.",
    youtube: "https://www.youtube.com/results?search_query=barbell+hip+thrust+tutorial+glutes",
  },
  {
    name: "Romanian Deadlift",
    sets: "3x10",
    description: "Hinge back and feel your hamstrings stretch. Drive through your hips to stand. The hamstring stretch is what activates the glutes — do not rush the bottom position.",
    mistake: "Rounding your lower back at the bottom. Only go as deep as a flat back allows.",
    modification: "Reduce range of motion until your form is solid, then increase depth gradually.",
    youtube: "https://www.youtube.com/results?search_query=romanian+deadlift+form+tutorial+glutes",
  },
  {
    name: "Sumo Squat",
    sets: "3x12",
    description: "Wide stance with toes pointed out at 45 degrees. Lower down between your legs. Squeeze glutes hard at the top of each rep. Targets inner thighs and glutes together.",
    mistake: "Knees caving inward as you lower. Push your knees out actively over your toes.",
    modification: "Goblet sumo squat holding one dumbbell at your chest.",
    youtube: "https://www.youtube.com/results?search_query=sumo+squat+glutes+tutorial+form",
  },
  {
    name: "Cable Kickback",
    sets: "3x15 each leg",
    description: "Ankle strap on cable machine. Hinge slightly forward holding the machine. Drive your leg back and up. Squeeze glute hard at the peak. Control the return.",
    mistake: "Using momentum or swinging your leg. This is an isolation exercise — slow it down and feel every rep.",
    modification: "Donkey kick on all fours on the floor if no cable machine.",
    youtube: "https://www.youtube.com/results?search_query=cable+kickback+glutes+tutorial+form",
  },
  {
    name: "Hip Abduction Machine",
    sets: "3x15",
    description: "Sit in machine. Push knees apart against the resistance. Squeeze glutes at the end position. Slow and controlled return. Do not use momentum.",
    mistake: "Leaning forward to use hip flexors instead of letting the glutes do the work. Sit upright.",
    modification: "Side-lying leg raise on the floor if no machine available.",
    youtube: "https://www.youtube.com/results?search_query=hip+abduction+machine+tutorial+glutes",
  },
];

const GYM_GLUTES_DAY_B: Exercise[] = [
  {
    name: "Leg Press (wide stance)",
    sets: "3x12",
    description: "Feet placed wide and high on the platform. This position shifts focus from quads to glutes. Full range of motion — lower until knees reach your chest.",
    mistake: "Letting knees cave inward as you press. Push them out over your toes throughout.",
    modification: "Sumo squat if no leg press machine is available.",
    youtube: "https://www.youtube.com/results?search_query=leg+press+wide+stance+glutes+tutorial",
  },
  {
    name: "Chest Press Machine or Bench Press",
    sets: "3x10",
    description: "Upper body balance work. Adjust seat so handles are at chest height. Press forward until arms nearly extended. Return slowly. Keep back against the pad.",
    mistake: "Shrugging shoulders up during the press. Keep them down and back.",
    modification: "Dumbbell press on a flat bench if machine not available.",
    youtube: "https://www.youtube.com/results?search_query=chest+press+machine+tutorial+form",
  },
  {
    name: "Lat Pulldown",
    sets: "3x10",
    description: "Upper back balance work. Pull bar to your upper chest. Drive elbows down and back. Squeeze shoulder blades. Creates the upper body shape that complements leg development.",
    mistake: "Pulling with your arms instead of driving your elbows down. Think elbows to back pockets.",
    modification: "Resistance band pulldown if no cable machine.",
    youtube: "https://www.youtube.com/results?search_query=lat+pulldown+tutorial+form",
  },
  {
    name: "Walking Lunge",
    sets: "3x12 each leg",
    description: "Hold dumbbells at sides. Take a long stride forward — long stride hits the glutes, short stride hits the quads. Drive through your front heel to step through.",
    mistake: "Taking short steps which removes glute involvement. Step long and feel the stretch in the front hip.",
    modification: "Static lunge staying on the spot if balance is a problem.",
    youtube: "https://www.youtube.com/results?search_query=walking+lunge+dumbbell+tutorial+glutes",
  },
  {
    name: "Shoulder Press",
    sets: "3x10",
    description: "Upper body balance. Dumbbells at shoulder height. Press overhead. Lower slowly. Core braced. Creates the shoulder width that gives the hourglass proportion.",
    mistake: "Arching lower back excessively. Brace your core and keep ribs down.",
    modification: "Seated press for lower back support.",
    youtube: "https://www.youtube.com/results?search_query=dumbbell+shoulder+press+tutorial+form",
  },
];

const GYM_GLUTES_DAY_C: Exercise[] = [
  {
    name: "Romanian Deadlift (heavier)",
    sets: "3x12",
    description: "Heavier than Day A. Really focus on the hamstring stretch at the bottom and the glute activation as you drive your hips through. This builds the glute-hamstring tie-in.",
    mistake: "Thinking of this as a back exercise. It is a hip hinge — the hips do the work, not the back.",
    modification: "Dumbbell RDL if no barbell available.",
    youtube: "https://www.youtube.com/results?search_query=romanian+deadlift+heavier+posterior+chain",
  },
  {
    name: "Leg Curl Machine",
    sets: "3x12",
    description: "Full range of motion. Curl heels toward your glutes. Squeeze at the top. Slow 3-second lowering phase. Strong hamstrings directly support glute development.",
    mistake: "Rushing the lowering phase. The eccentric is where the muscle builds — do not waste it.",
    modification: "Nordic curl on the floor — very challenging but highly effective.",
    youtube: "https://www.youtube.com/results?search_query=leg+curl+machine+tutorial+hamstrings",
  },
  {
    name: "Cable Pull Through",
    sets: "3x15",
    description: "Face away from the cable machine. Rope between your legs. Hinge forward, then drive your hips through to stand. Pure hip hinge movement for glutes and hamstrings.",
    mistake: "Squatting down instead of hinging. Push your hips back like you are trying to touch the wall behind you.",
    modification: "Kettlebell or dumbbell swing if no cable machine — same movement pattern.",
    youtube: "https://www.youtube.com/results?search_query=cable+pull+through+tutorial+glutes",
  },
  {
    name: "Step Up",
    sets: "3x10 each leg",
    description: "Use a high box or bench. Place one foot fully on top. Drive through your front heel to step up. Squeeze glute at the top before lowering. Do not push off the back foot.",
    mistake: "Pushing off the back foot to help get up. All the force must come through the front leg.",
    modification: "Lower box or step if balance is a problem. Regular lunge as an alternative.",
    youtube: "https://www.youtube.com/results?search_query=step+up+exercise+glutes+tutorial+form",
  },
  {
    name: "Hip Abduction Machine (burnout)",
    sets: "3x20",
    description: "End of session burnout set. Slow and squeeze every single rep. Do not rush. This finishes off the glute medius — the muscle responsible for the outer glute shape.",
    mistake: "Using momentum to swing the weight out. Slow controlled reps only — momentum makes this exercise useless.",
    modification: "Side-lying clamshells on the floor as a replacement.",
    youtube: "https://www.youtube.com/results?search_query=hip+abduction+machine+burnout+glutes",
  },
];

// ============================================================
// FEMALE COMPLETE PROGRAMME
// Covers all 6 areas: shoulders, back, arms, glutes, hamstrings, calves
// 3 days/week — glute/posterior emphasis with full upper body balance
// ============================================================

export const FEMALE_DAY_A = `*Day A — Glutes + Shoulders + Arms*
Rest 60 sec between sets | 55–65 min

1. *Hip Thrust* — 4×12
Drive hips up, squeeze bum hard at top, lower slow

2. *Sumo Squat* — 3×12
Wide stance, toes out. Push knees out over toes

3. *Machine Shoulder Press* — 3×10
Press up, lower slow. Keep core tight

4. *Cable Lateral Raise* — 3×15 each arm
Raise to shoulder height. Control the weight down

5. *Bicep Curl* — 3×12
Full range. Squeeze at top. Elbows stay at your sides

6. *Tricep Pushdown* — 3×12
Push down, squeeze triceps. Elbows locked to ribs

7. *Standing Calf Raise* — 3×15
Full stretch down, full press up. Pause at top

Reply *DONE* when finished.`;

export const FEMALE_DAY_B = `*Day B — Back + Hamstrings*
Rest 75 sec between sets | 55–65 min

1. *Romanian Deadlift* — 3×10
Push bum back, lower until hamstring stretch. Back stays flat

2. *Leg Curl Machine* — 3×12
Curl heels to bum. Squeeze. Lower slow (3 seconds)

3. *Lat Pulldown* — 4×10
Pull to chest. Drive elbows down and back

4. *Seated Cable Row* — 4×10
Pull to belly. Squeeze shoulder blades. Sit tall

5. *Cable Kickback* — 3×15 each leg
Drive leg back, squeeze glute at top. Slow reps

6. *Face Pull* — 3×15
Pull rope to face, elbows high. Squeeze at end

7. *Seated Calf Raise* — 3×15
Full stretch down, full press up. Pause at top

Reply *DONE* when finished.`;

export const FEMALE_DAY_C = `*Day C — Full Body + Glutes*
Rest 75 sec between sets | 55–65 min

1. *Hip Thrust (heavier)* — 4×10
Go heavier than Day A. Squeeze hard at top

2. *Leg Press (wide stance)* — 3×12
Feet wide and high. Press through heels. Full range

3. *Incline Dumbbell Press* — 3×10
Bench at 30–45 degrees. Lower to chest, press up

4. *Hip Abduction Machine* — 3×15
Push knees apart. Squeeze. Sit tall, no leaning

5. *Cable Lateral Raise* — 3×12 each arm
Raise to shoulder height. Light weight, control it

6. *Hammer Curl* — 3×12
Palms face each other. Elbows pinned to sides

7. *Standing Calf Raise* — 3×15
Full stretch down, full press up. Add weight from last week

Reply *DONE* when finished.`;

// ============================================================
// LEGACY GYM STRINGS (kept for backward compat with getKamlifeProgramme)
// ============================================================

export const BEGINNER_GYM_PROGRAMME = `*Full Body — Beginner (3 days/week)*
3 sets of 10 reps each | Rest 60 sec | 45–55 min

1. *Squat or Leg Press* — 3×10
Lower until thighs level. Push through heels. Chest up

2. *Bench Press or Chest Press Machine* — 3×10
Bar to chest. Press up. Lower slow (2 seconds)

3. *Lat Pulldown* — 3×10
Pull to chest. Elbows down and back. Squeeze

4. *Romanian Deadlift* — 3×10
Push bum back. Lower until hamstring stretch. Back flat

5. *Shoulder Press* — 3×10
Press overhead. Lower slow. Keep core tight

Each session: try 1 more rep. Hit 12 reps? Add small weight, drop to 10.

Reply *DONE* when finished.`;

export const INTERMEDIATE_GYM_UPPER = `*Upper Body — Intermediate*
4 sets | Rest 75 sec | 55–65 min

1. *Chest Press* — 4×10
Feel the chest working. Lower slow (2 sec)

2. *Seated Cable Row* — 4×10
Pull to belly. Squeeze shoulder blades. Sit tall

3. *Lat Pulldown* — 4×10
Full stretch at top, squeeze at bottom

4. *Shoulder Press* — 4×10
Press up controlled. No bouncing at bottom

5. *Cable Lateral Raise* — 3×15
Raise to shoulder height. Lower slow

6. *Tricep Pushdown* — 3×15
Elbows at sides. Push down, squeeze

7. *Cable Bicep Curl* — 3×15
Elbows fixed. Squeeze at top. Full range

Reply *DONE* when finished.`;

export const INTERMEDIATE_GYM_LOWER = `*Lower Body — Intermediate*
4 sets | Rest 75 sec | 55–65 min

1. *Hack Squat or Leg Press* — 4×10
Go deep. Control the way down. Press through heels

2. *Leg Extension* — 4×12
Squeeze quads hard at top. Lower slow

3. *Leg Curl* — 4×12
Full range. Slow lowering. Heavier than last time

4. *Hip Thrust* — 4×12
Drive hips up. Squeeze glutes hard at top

5. *Seated Calf Raise* — 4×15
Full stretch down, full press up. High reps

6. *Cable Crunch* — 3×15
Rope behind head. Crunch down, squeeze abs

Reply *DONE* when finished.`;

// Exercise[] versions of intermediate programme — used with formatGymDay for week/phase context
const INTERMEDIATE_UPPER_EX: Exercise[] = [
  { name: "Chest Press / Bench Press", sets: "4×10", description: "Elbows at 45 degrees. Lower until bar touches chest. Press through the full range. Feel the chest contract at the top — not the shoulders.", mistake: "Shoulders rising and doing the work. Keep shoulder blades pinched back throughout.", modification: "Dumbbell press on a flat bench." },
  { name: "Seated Cable Row", sets: "4×10", description: "Pull to your lower chest. Squeeze both shoulder blades hard together. Full stretch forward. Sit tall — do not lean back.", mistake: "Leaning back with torso to add momentum. The back does the work, not your bodyweight.", modification: "Dumbbell bent-over row." },
  { name: "Lat Pulldown", sets: "4×10", description: "Full stretch at the top. Pull elbows down toward your back pockets. Squeeze hard at the bottom for one second.", mistake: "Pulling with your hands and arms. Your elbows lead the movement, not your wrists.", modification: "Resistance band pulldown." },
  { name: "Shoulder Press", sets: "4×10", description: "Dumbbells at ear height. Press overhead until arms nearly extended. Lower slowly. Core stays braced throughout.", mistake: "Excessive lower back arch. If your back is arching, the weight is too heavy.", modification: "Seated press for extra lower back support." },
  { name: "Cable Lateral Raise", sets: "3×15", description: "One cable at hip height. Raise arm to shoulder height only. Lower over 2 seconds. No shrugging — shoulders stay down.", mistake: "Raising above shoulder height or shrugging. Both reduce tension on the delts.", modification: "Dumbbell lateral raise." },
  { name: "Tricep Pushdown", sets: "3×15", description: "Elbows pinned at your sides. Push bar down until arms are straight. Squeeze hard at the bottom. Elbows must not drift forward.", mistake: "Elbows drifting forward — if they move, reduce the weight.", modification: "Dumbbell overhead tricep extension." },
  { name: "Cable Bicep Curl", sets: "3×15", description: "Elbows pinned at sides. Curl to shoulder. Squeeze hard at the top. Lower slowly — the eccentric builds as much as the curl.", mistake: "Swinging torso or elbows drifting forward. Keep elbows locked.", modification: "Dumbbell curl seated." },
];

const INTERMEDIATE_LOWER_EX: Exercise[] = [
  { name: "Hack Squat / Leg Press", sets: "4×10", description: "Go deep — thighs past parallel. Control the descent over 2 seconds. Drive through heels explosively. Intermediate level means heavier than before.", mistake: "Rising onto toes at the bottom. Keep full foot contact throughout.", modification: "Barbell back squat or goblet squat." },
  { name: "Leg Extension", sets: "4×12", description: "Full extension, hard quad squeeze at the top — hold 1 second. Lower slowly over 2 seconds. Feel it in the quad, not the hip.", mistake: "Using momentum to swing the weight up. Control both directions.", modification: "Dumbbell step-up." },
  { name: "Leg Curl", sets: "4×12", description: "Curl heels all the way to your glutes. Squeeze hard at the top. Lower over 3 seconds — this eccentric phase is where hamstrings are built.", mistake: "Rushing the lowering phase. If you're not controlling it, the weight is too heavy.", modification: "Dumbbell Romanian deadlift." },
  { name: "Hip Thrust", sets: "4×12", description: "Bar or heavy dumbbell on hips. Drive hips up explosively. Squeeze glutes hard for a full second at the top. Lower slowly.", mistake: "Using your lower back to press instead of your glutes. You should feel this in your bum, not your spine.", modification: "Glute bridge on the floor." },
  { name: "Seated Calf Raise", sets: "4×15", description: "Full range — heel as low as the step allows, rise all the way onto toes. Pause at the top. Slow 2-second lower. Calves need full range to grow.", mistake: "Short bouncy reps. Calves only grow through full range of motion.", modification: "Single-leg standing calf raise." },
  { name: "Cable Crunch", sets: "3×15", description: "Rope pulled behind head. Crunch down bringing elbows toward knees. Squeeze abs hard at the bottom. The movement comes from your abs — not your hips.", mistake: "Pulling the rope with your arms. Your abs create the crunch, arms just hold the rope.", modification: "Weighted sit-up or decline crunch." },
];

export const HOME_PROGRAMME_GUIDE = `*Home Workout — No Gym Needed*
3 sets each | Rest 60 sec | 40–50 min

1. *Squat* — 3×15
Feet shoulder width. Go down until thighs level. Push up through heels

2. *Push-Up* — 3×10
Hands shoulder width. Body straight. Chest to floor, push up

3. *Glute Bridge* — 3×15
Lie on back. Push hips up. Squeeze bum at top. Hold 2 sec

4. *Reverse Lunge* — 3×10 each leg
Step back, lower knee to floor. Push up through front heel

5. *Table Row* — 3×10
Lie under a table. Grip edge. Pull chest up. Squeeze back

6. *Plank* — 3×30 seconds
Body straight. Core tight. Breathe steady

Getting easy? Add reps. Still easy? Move to harder version.

Reply *DONE* when finished.

_Form videos:_
1. Squat: https://www.youtube.com/watch?v=aclHkVaku9U
2. Push-Up: https://www.youtube.com/watch?v=IODxDxX7oi4
3. Glute Bridge: https://www.youtube.com/results?search_query=glute+bridge+tutorial
4. Lunge: https://www.youtube.com/results?search_query=reverse+lunge+tutorial
5. Table Row: https://www.youtube.com/results?search_query=table+row+home+workout+tutorial
6. Plank: https://www.youtube.com/results?search_query=plank+shoulder+tap+tutorial`;

// ============================================================
// HELPER FUNCTIONS
// ============================================================

export function getPhaseMultiplier(phase: number): { sets: string; reps: string; rest: string } {
  switch (phase) {
    case 1: return { sets: "3", reps: "10", rest: "60 seconds" };
    case 2: return { sets: "4", reps: "8", rest: "90 seconds" };
    case 3: return { sets: "4", reps: "6", rest: "120 seconds" };
    case 4: return { sets: "5", reps: "5", rest: "120 seconds" };
    case 5: return { sets: "3", reps: "10", rest: "60 seconds" };
    default: return { sets: "3", reps: "10", rest: "60 seconds" };
  }
}

export function getPhaseNames(): Record<number, string> {
  return { 1: "Foundation", 2: "Build", 3: "Push", 4: "Peak", 5: "Deload" };
}

/**
 * getDayType
 *
 * For gym users this maps programmeDayInWeek mod 3 to a full-body day slot label.
 * The old calendar-day logic has been removed — gym day type is now always based
 * on how many sessions the user has actually done, not what day of the week it is.
 *
 * For home users the function returns push/pull/legs/core/rest — these are used
 * for menu display labels only, not actual programme delivery.
 *
 * @param dowOverride  Pass user.programmeDayInWeek for gym users.
 *                     Pass new Date().getDay() for home display labels.
 */
export function getDayType(
  dowOverride?: number
): "push" | "pull" | "legs" | "core" | "rest" | "full_a" | "full_b" | "full_c" {
  if (dowOverride === undefined) {
    // Default: return based on calendar day for backward compat (home display only)
    const dow = new Date().getDay();
    const map: Array<"push" | "pull" | "legs" | "core" | "rest"> =
      ["rest", "push", "pull", "legs", "core", "push", "pull"];
    return map[dow];
  }

  // For gym users: map programmeDayInWeek to full-body day slot
  // day 1 (and 4, 7...) → full_a
  // day 2 (and 5, 8...) → full_b
  // day 3 (and 6, 9...) → full_c
  const slot = ((dowOverride - 1) % 3) + 1;
  if (slot === 1) return "full_a";
  if (slot === 2) return "full_b";
  return "full_c";
}

// ============================================================
// GYM PROGRAMME SELECTOR
// Returns the correct Exercise[] array for the given day slot and user profile
// ============================================================

function getGymDay(
  daySlot: 1 | 2 | 3,
  isDumbbell: boolean,
  isGlutesFocus: boolean,
  gender: string = "male"
): Exercise[] {
  if (isGlutesFocus) {
    const map = { 1: GYM_GLUTES_DAY_A, 2: GYM_GLUTES_DAY_B, 3: GYM_GLUTES_DAY_C };
    return map[daySlot];
  }
  if (isDumbbell) {
    const map = {
      1: DB_3DAY_A,
      2: DB_3DAY_B,
      3: gender === "female" ? DB_3DAY_C_WOMEN : DB_3DAY_C_MEN,
    };
    return map[daySlot];
  }
  const map = { 1: NEW_3DAY_A, 2: NEW_3DAY_B, 3: NEW_3DAY_C_MEN };
  return map[daySlot];
}

function daySlotLabel(slot: 1 | 2 | 3, isGlutesFocus: boolean, isDumbbell: boolean): string {
  if (isGlutesFocus) {
    return ["Glute Push Day A", "Upper + Light Lower B", "Posterior Chain Day C"][slot - 1];
  }
  return [`Full Body A`, `Full Body B`, `Full Body C`][slot - 1];
}

function getNewDbDay(
  trainingDays: number,
  dayNumber: number,
  gender: string,
): { exercises: Exercise[]; label: string } {
  if (trainingDays <= 2) {
    const slot = ((dayNumber - 1) % 2) + 1;
    if (slot === 1) return { exercises: DB_2DAY_A, label: "Full Body A" };
    return { exercises: gender === "female" ? DB_2DAY_B_WOMEN : DB_2DAY_B_MEN, label: "Full Body B" };
  }
  if (trainingDays >= 4) {
    const slot = ((dayNumber - 1) % 4) + 1;
    if (slot === 1) return { exercises: DB_4DAY_UPPER_A, label: "Upper Body A" };
    if (slot === 2) return { exercises: DB_4DAY_LOWER_A, label: "Lower Body A" };
    if (slot === 3) return { exercises: gender === "female" ? DB_4DAY_UPPER_B_WOMEN : DB_4DAY_UPPER_B_MEN, label: "Upper Body B" };
    return { exercises: DB_4DAY_LOWER_B, label: "Lower Body B" };
  }
  // 3-day default
  const slot = ((dayNumber - 1) % 3) + 1;
  if (slot === 1) return { exercises: DB_3DAY_A, label: "Full Body A" };
  if (slot === 2) return { exercises: DB_3DAY_B, label: "Full Body B" };
  return { exercises: gender === "female" ? DB_3DAY_C_WOMEN : DB_3DAY_C_MEN, label: "Full Body C" };
}

function bmiOf(user: any): number {
  const w = parseFloat(String(user?.currentWeight || "")) || 0;
  const h = Number(user?.heightCm) || 0;
  return w > 0 && h > 0 ? w / Math.pow(h / 100, 2) : 0;
}

// Heavy clients (BMI ≥ 33): jump landings load knees/ankles at 4-6× bodyweight —
// on a 120kg+ frame that's an injury waiting to happen. Swap plyo moves for a
// floor-planted power version up front instead of waiting for "knees are sore".
// Same explosive stimulus, none of the landing forces.
function swapImpactForHeavy(exercises: Exercise[], user: any): Exercise[] {
  if (bmiOf(user) < 33) return exercises;
  return exercises.map(ex => /\b(jump|hop|plyo|burpee|skip)\b/i.test(ex.name) ? {
    ...ex,
    name: "Power Squat (no jump)",
    description: "Squat to parallel. Drive up FAST — but both feet stay planted. All the explosive intent, none of the landing impact.",
    mistake: "Rushing the way down. Lower under control, explode up.",
    modification: "Squat to a chair and stand up fast.",
  } : ex);
}

function getNewHomeDay(
  trainingDays: number,
  dayNumber: number,
  gender: string,
): { exercises: Exercise[]; label: string } {
  if (trainingDays <= 2) {
    const slot = ((dayNumber - 1) % 2) + 1;
    if (slot === 1) return { exercises: HOME_2DAY_A, label: "Full Body A" };
    return { exercises: gender === "female" ? HOME_2DAY_B_WOMEN : HOME_2DAY_B_MEN, label: "Full Body B" };
  }
  if (trainingDays >= 4) {
    const slot = ((dayNumber - 1) % 4) + 1;
    if (slot === 1) return { exercises: HOME_4DAY_UPPER_A, label: "Upper Body A" };
    if (slot === 2) return { exercises: HOME_4DAY_LOWER_A, label: "Lower Body A" };
    if (slot === 3) return { exercises: gender === "female" ? HOME_4DAY_UPPER_B_WOMEN : HOME_4DAY_UPPER_B_MEN, label: "Upper Body B" };
    return { exercises: gender === "female" ? HOME_4DAY_LOWER_B_WOMEN : HOME_4DAY_LOWER_B_MEN, label: "Lower Body B" };
  }
  // 3-day default
  const slot = ((dayNumber - 1) % 3) + 1;
  if (slot === 1) return { exercises: HOME_3DAY_A, label: "Full Body A" };
  if (slot === 2) return { exercises: HOME_3DAY_B, label: "Full Body B" };
  return { exercises: gender === "female" ? HOME_3DAY_C_WOMEN : HOME_3DAY_C_MEN, label: "Full Body C" };
}

function getNewGymDay(
  trainingDays: number,
  dayNumber: number,
  gender: string,
  isGlutesFocus: boolean
): { exercises: Exercise[]; label: string } {
  if (isGlutesFocus) {
    const slot = (((dayNumber - 1) % 3) + 1) as 1 | 2 | 3;
    const map = { 1: GYM_GLUTES_DAY_A, 2: GYM_GLUTES_DAY_B, 3: GYM_GLUTES_DAY_C };
    const labels = ["Glute Push Day A", "Upper + Light Lower B", "Posterior Chain Day C"];
    return { exercises: map[slot], label: labels[slot - 1] };
  }

  if (trainingDays <= 2) {
    const slot = ((dayNumber - 1) % 2) + 1;
    if (slot === 1) return { exercises: NEW_2DAY_A, label: "Full Body A" };
    return { exercises: gender === "female" ? NEW_2DAY_B_WOMEN : NEW_2DAY_B_MEN, label: "Full Body B" };
  }

  if (trainingDays >= 4) {
    const slot = ((dayNumber - 1) % 4) + 1;
    if (slot === 1) return { exercises: NEW_4DAY_UPPER_A, label: "Upper Body A" };
    if (slot === 2) return { exercises: NEW_4DAY_LOWER_A, label: "Lower Body A" };
    if (slot === 3) return { exercises: gender === "female" ? NEW_4DAY_UPPER_B_WOMEN : NEW_4DAY_UPPER_B_MEN, label: "Upper Body B" };
    return { exercises: NEW_4DAY_LOWER_B, label: "Lower Body B" };
  }

  // 3-day (default)
  const slot = ((dayNumber - 1) % 3) + 1;
  if (slot === 1) return { exercises: NEW_3DAY_A, label: "Full Body A" };
  if (slot === 2) return { exercises: NEW_3DAY_B, label: "Full Body B" };
  return { exercises: gender === "female" ? NEW_3DAY_C_WOMEN : NEW_3DAY_C_MEN, label: "Full Body C" };
}

const PHASE_OPENERS: Record<number, string> = {
  1: "Foundation phase. Learn the movements — weight is secondary today. Perfect form now means heavier lifts in 4 weeks.",
  2: "Build phase. Your form is solid. Now push the weight — add even 2.5kg to every lift, every session.",
  3: "Push phase. This gets uncomfortable. That is the point. Your body only changes when you exceed what felt hard last month.",
  4: "Peak phase. Hardest week of the cycle. You built to this — do not run from it.",
  5: "Deload week. Drop weight by 40%, keep every movement. Recovery IS the training this week.",
};

const GOAL_FINISH_GYM: Record<string, string> = {
  fat_loss: "_After: protein within 60 min — eggs, chicken, pilchards. Keep carbs light if you're not training again today._",
  muscle_gain: "_After: eat rice + protein within 30 minutes. This is the most important meal of your day — do not skip it._",
  recomposition: "_After: protein within 60 min, moderate carbs. Sweet potato or pap + chicken. Fuel the rebuild._",
};

export function getWeekContext(phase: number, week: number, isBeginner = false, sessionsDone = 0): { rationale: string; sets: string; reps: string; rest: string } {
  // Returns week-specific coaching rationale and progressive sets/reps.
  // Each phase has a distinct goal; within each phase, intensity climbs weekly.
  const P1: Record<number, { rationale: string; sets: string; reps: string; rest: string }> = {
    1: { rationale: "First session. Find where each movement feels right, not how much you can lift. The weight you use today will feel light in 4 weeks — that is the whole point.", sets: "3", reps: "12", rest: "60 sec" },
    2: { rationale: "Week 2. You have felt the movements. Now find a working weight — something that feels like 7/10 effort at rep 10. Write it down. You will beat it next session.", sets: "3", reps: "10", rest: "60 sec" },
    3: { rationale: "Week 3. Add 2.5kg to every compound lift from last week. Your body has adapted to the movement — give it new stress or it stops changing.", sets: "3", reps: "10", rest: "75 sec" },
    4: { rationale: "Week 4 of Foundation — last push before the programme steps up. Every compound lift: heavier than Week 1. You have earned this weight.", sets: "4", reps: "8", rest: "90 sec" },
  };
  const P2: Record<number, { rationale: string; sets: string; reps: string; rest: string }> = {
    1: { rationale: "Build Phase begins. Drop to 8 reps — but the weight must be heavier than Foundation. If 12 reps felt like 7/10, you need a weight where 8 reps is 8/10. Find it.", sets: "4", reps: "8", rest: "90 sec" },
    2: { rationale: "Week 2 of Build. Your joints and tendons are adapting to the heavier load — this is normal. Keep 8 reps. If you hit 10 clean reps on any exercise, add weight next session.", sets: "4", reps: "8", rest: "90 sec" },
    3: { rationale: "Week 3. Push beyond what felt like your limit in Week 1. Progressive overload is the only mechanism that builds muscle — no supplement replaces this.", sets: "4", reps: "6", rest: "90 sec" },
    4: { rationale: "Week 4 of Build. Heaviest weights of this phase. You are stronger than 8 weeks ago. Prove it today — not tomorrow, not next week. Today.", sets: "5", reps: "6", rest: "90 sec" },
  };
  const P3: Record<number, { rationale: string; sets: string; reps: string; rest: string }> = {
    1: { rationale: "Push Phase. 6 reps now — meaning the weight should be heavy enough that rep 5 and 6 are a genuine fight. Take the full 2 minutes rest. Do not rush.", sets: "4", reps: "6", rest: "2 min" },
    2: { rationale: "Week 2 of Push. Your nervous system is adapting to heavy loads. This is where real strength builds. Keep 6 reps — if it feels easier, add weight.", sets: "5", reps: "5", rest: "2 min" },
    3: { rationale: "Week 3. You are past halfway. Most people quit right here — the fatigue is real. You are not most people. The deload next phase will feel completely earned.", sets: "5", reps: "5", rest: "2 min" },
    4: { rationale: "Final week of Push. Everything you have, today. Heavy, controlled, full range. The programme has been building to this session.", sets: "5", reps: "4", rest: "2 min" },
  };
  const P4: Record<number, { rationale: string; sets: string; reps: string; rest: string }> = {
    1: { rationale: "Peak Phase. 5×3 — meaning these are near-maximal sets. Warm up thoroughly: 2 lighter sets before each working set. This is where months of work crystallises.", sets: "5", reps: "3", rest: "2–3 min" },
    2: { rationale: "Week 2 of Peak. Test what you are capable of. Hit numbers you have not hit before. If you miss a rep — you were close enough. Rest, reset, attempt again.", sets: "5", reps: "3", rest: "2–3 min" },
  };
  const P5 = { rationale: "Deload week. Drop every weight by 40%. Keep every movement, every set. Your muscles are repairing and your nervous system is recovering — this week makes your next phase 10% stronger. Do not skip it.", sets: "3", reps: "12", rest: "60 sec" };

  if (phase === 1 && P1[week]) {
    const ctx = P1[week];
    // RESTART-AWARE Week 1 (2026-07-16 live: "Week 1 — Session 21" told a client with
    // a 125kg chest fly "First session... the weight will feel light in 4 weeks... no
    // ego, just consistency"). A goal change legitimately restarts the PLAN at Week 1 —
    // the client's strength doesn't restart with it, and beginner copy to a veteran
    // reads as the coach forgetting who they are.
    const veteran = sessionsDone >= 12;
    if (week === 1 && veteran) {
      // Copy must be true BOTH when a goal change restarts the plan AND when a veteran is
      // simply VIEWING the full programme (2026-07-20 live: "the plan restarts" alarmed a
      // client who only asked to SEE his plan — nothing had reset).
      return { ...ctx, rationale: "Week 1 — the foundation your whole plan builds from. Your strength carries over: keep your usual working weights and focus on owning the movements. The weeks build from here." };
    }
    // Beginner ease-in: first 2 Foundation weeks at 2 working sets, then build to 3.
    // Protects never-trained / heavier / older bodies from week-one overload and DOMS
    // that makes people quit. The third set comes in once the movement pattern is owned.
    if (isBeginner && week <= 2 && !veteran) {
      return { ...ctx, sets: "2", rationale: `${ctx.rationale} Starting at 2 sets while your body adapts — we add the third set in week 3. No ego, just consistency.` };
    }
    return ctx;
  }
  if (phase === 2 && P2[week]) return P2[week];
  if (phase === 3 && P3[week]) return P3[week];
  if (phase === 4 && P4[week]) return P4[week];
  if (phase === 5) return P5;
  // Fallback: use phase-level defaults
  const fallbacks: Record<number, { sets: string; reps: string; rest: string }> = {
    1: { sets: "3", reps: "10", rest: "60 sec" },
    2: { sets: "4", reps: "8", rest: "90 sec" },
    3: { sets: "4", reps: "6", rest: "2 min" },
    4: { sets: "5", reps: "5", rest: "2 min" },
    5: { sets: "3", reps: "12", rest: "60 sec" },
  };
  const fb = fallbacks[phase] || fallbacks[1];
  return { rationale: PHASE_OPENERS[phase] || PHASE_OPENERS[1], ...fb };
}

function getExerciseSets(ex: Exercise, wSets: string, wReps: string, phase: number): string {
  // Calves and high-rep accessories keep their own scheme; all others use the week target.
  const keepOwn = /calf raise|lateral raise|face pull|kickback|plank|dead.?bug/i.test(ex.name);
  if (keepOwn) return ex.sets;
  // Deload: halve the rep count visually but keep sets
  if (phase === 5) return `${wSets} × ${wReps} reps _(light — 40% of normal weight)_`;
  return `${wSets} × ${wReps} reps`;
}

const EXERCISE_YOUTUBE: Record<string, string> = {
  "smith squat": "https://www.youtube.com/results?search_query=smith+machine+squat+tutorial+form",
  "leg press": "https://www.youtube.com/results?search_query=leg+press+machine+tutorial+form",
  "goblet squat": "https://www.youtube.com/results?search_query=goblet+squat+dumbbell+tutorial+form",
  "leg extension": "https://www.youtube.com/results?search_query=leg+extension+machine+tutorial+form",
  "leg curl": "https://www.youtube.com/results?search_query=leg+curl+machine+tutorial+form",
  "calf raise": "https://www.youtube.com/results?search_query=calf+raise+tutorial+form",
  "chest press": "https://www.youtube.com/results?search_query=chest+press+machine+tutorial+form",
  "dumbbell press": "https://www.youtube.com/results?search_query=dumbbell+bench+press+tutorial+form",
  "lat pulldown": "https://www.youtube.com/results?search_query=lat+pulldown+tutorial+form",
  "pull-up": "https://www.youtube.com/results?search_query=assisted+pull+up+tutorial+form",
  "seated row": "https://www.youtube.com/results?search_query=seated+cable+row+tutorial+form",
  "dumbbell row": "https://www.youtube.com/results?search_query=dumbbell+single+arm+row+tutorial",
  "lateral raise": "https://www.youtube.com/results?search_query=dumbbell+lateral+raise+tutorial+form",
  "cable lateral raise": "https://www.youtube.com/results?search_query=cable+lateral+raise+tutorial+form",
  "bulgarian split squat": "https://www.youtube.com/results?search_query=bulgarian+split+squat+tutorial+form",
  "hip thrust": "https://www.youtube.com/results?search_query=barbell+hip+thrust+tutorial+form",
  "glute bridge": "https://www.youtube.com/results?search_query=glute+bridge+exercise+tutorial+form",
  "face pull": "https://www.youtube.com/results?search_query=face+pull+cable+tutorial+form",
  "chest fly": "https://www.youtube.com/results?search_query=dumbbell+chest+fly+tutorial+form",
  "bicep curl": "https://www.youtube.com/results?search_query=bicep+curl+dumbbell+tutorial+form",
  "tricep pushdown": "https://www.youtube.com/results?search_query=tricep+cable+pushdown+tutorial+form",
  "tricep extension": "https://www.youtube.com/results?search_query=tricep+overhead+extension+tutorial+form",
  "cable kickback": "https://www.youtube.com/results?search_query=cable+kickback+tricep+tutorial+form",
  "shoulder press": "https://www.youtube.com/results?search_query=dumbbell+shoulder+press+tutorial+form",
  "romanian deadlift": "https://www.youtube.com/results?search_query=romanian+deadlift+form+tutorial",
  "rdl": "https://www.youtube.com/results?search_query=romanian+deadlift+form+tutorial",
  "push up": "https://www.youtube.com/watch?v=IODxDxX7oi4",
  "push-up": "https://www.youtube.com/watch?v=IODxDxX7oi4",
  "bodyweight squat": "https://www.youtube.com/results?search_query=bodyweight+squat+tutorial+form",
  "walking lunge": "https://www.youtube.com/results?search_query=walking+lunge+tutorial+form",
  "reverse lunge": "https://www.youtube.com/results?search_query=reverse+lunge+tutorial+form",
  "hip abduction machine": "https://www.youtube.com/results?search_query=hip+abduction+machine+tutorial+form",
  "plank": "https://www.youtube.com/results?search_query=plank+exercise+tutorial+form",
  "dead bug": "https://www.youtube.com/results?search_query=dead+bug+exercise+tutorial+form",
};

export function getYoutubeLinkForExercise(name: string): string | undefined {
  const key = name.toLowerCase();
  for (const [k, url] of Object.entries(EXERCISE_YOUTUBE)) {
    if (key.includes(k)) return url;
  }
  return undefined;
}

// cleanExerciseName / canonicalLiftKey REMOVED (2026-08-06). They existed to tidy and group
// the names clients typed when logging lifts ("my chest fly is" → "chest fly"), and lift
// logging is gone. Nothing else ever called them.


function formatGymDay(
  exercises: Exercise[],
  label: string,
  phase: number,
  phaseName: string,
  week: number,
  multiplier: { sets: string; reps: string; rest: string },
  goal = "fat_loss",
  isDumbbell = false,
  injuries = "none",
  experience = "",
  showMachineHint = false,
  sessionsDone = 0
): string {
  // 12+ logged sessions outranks a stale "beginner" label — no "New to this?" hints
  // or 2-set adaptation copy for a body that's been training for weeks (2026-07-16).
  const isBeginner = (experience === "beginner" || experience === "") && sessionsDone < 12;
  const wCtx = getWeekContext(phase, week, isBeginner, sessionsDone);
  const finisher = GOAL_FINISH_GYM[goal] || GOAL_FINISH_GYM.fat_loss;
  const equipNote = isDumbbell
    ? `_No machine? Each exercise has a modification listed._\n\n`
    : isBeginner
    ? `_New to this? Each exercise has a lighter alternative if needed._\n\n`
    : ``;

  const { safeEx, skippedNames } = filterInjuredGymExercises(exercises, injuries);

  // Build as several \n\n---\n\n bubbles (every send path splits on this separator) so the
  // workout lands as a few human-sized messages, not one block WhatsApp hides behind "Read more".
  const SEP = "\n\n---\n\n";
  // Bubble 1 — the brief: today, warm-up, target.
  let header = `💪 *Week ${week} — ${label}*\n`;
  header += `_${phaseName} Phase${phase === 5 ? " — Recovery Week" : ""}_\n\n`;
  header += `⚡ *Warm-up:* 5 min incline walk or light cardio. Then 1 warm-up set (half weight) on your first lift.\n\n`;
  header += equipNote;
  header += `📋 ${wCtx.sets} sets × ${wCtx.reps} reps, ${wCtx.rest} rest between sets.\n`;
  header += `_${wCtx.rationale}_`;
  // Reduce an exercise/alt string to its core movement so we can spot a redundant
  // alternative: "Dumbbell RDL" and "Romanian Deadlift" both collapse to the same key.
  // Only equipment words + qualifier phrases are stripped — movement differentiators
  // (goblet, smith, incline, floor-press…) are kept so real alternatives survive.
  const normMove = (s: string) => (s || "").toLowerCase()
    .replace(/\brdls?\b/g, "romanian deadlift").replace(/\bdb\b/g, "dumbbell").replace(/\bohp\b/g, "overhead press")
    .replace(/\bif no (?:machine|bench|cable|gym)\b|\bif needed\b|\bas (?:an? |your )?alternative\b|\bwith knee on bench\b|\b(?:lying|flat) on (?:the )?floor\b/g, " ")
    .replace(/\b(dumbbell|barbell|machine|cable|assisted)\b/g, " ")
    .replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  // Core of each exercise = its first "/" alias, normalised (RDL / Dumbbell RDL → "romanian deadlift").
  const dayCores = safeEx.map(e => normMove((e.name || "").split("/")[0]));

  // One block per exercise, grouped ~3 per bubble so no single message is a wall.
  const exBlocks: string[] = [];
  for (let i = 0; i < safeEx.length; i++) {
    const ex = safeEx[i];
    let block = `${i + 1}. *${ex.name}* — ${getExerciseSets(ex, wCtx.sets, wCtx.reps, phase)}\n${ex.description.split(". ")[0]}`;
    if (ex.mistake) block += `\n⚠ ${ex.mistake.split(".")[0]}`;
    // Show the alt only if it isn't just restating this exercise or duplicating another
    // one already in today's list — no more "RDL (Alt: Dumbbell RDL)".
    const altCore = normMove(ex.modification || "");
    const altRedundant = altCore.length < 3 || dayCores.some(c => c.length >= 3 && c === altCore);
    if (ex.modification && (isDumbbell || isBeginner) && !altRedundant) block += `\n_(Alt: ${ex.modification})_`;
    // No YouTube search links: they doubled the message length, WhatsApp auto-expands
    // one into a preview card mid-workout, and a *search results* page is not form
    // coaching. Real form help = snap the machine (photo coach) — pointer in the closer.
    exBlocks.push(block);
  }
  const exerciseBubbles: string[] = [];
  for (let i = 0; i < exBlocks.length; i += 3) exerciseBubbles.push(exBlocks.slice(i, i + 3).join("\n\n"));
  // Final bubble — wrap-up: injury skips, machine hint, DONE, finisher, after-walk.
  let closer = skippedNames.length > 0 ? `⚠️ *Skipped (injury):* ${skippedNames.join(", ")}. These return when you report recovery.\n\n` : "";
  if (showMachineHint) closer += `📸 *Not sure which machine is which?* Snap a photo of any machine and send it to me — I'll tell you if it's the right one for today and exactly how to use it.\n\n`;
  closer += `Reply *DONE* when finished.\n\n` + finisher + `\n\n🚶 *After:* 15–20 min walk. No running — this is active recovery, not extra cardio.`;
  return [header, ...exerciseBubbles, closer].filter(Boolean).join(SEP);
}

// ============================================================
// HOME WORKOUT DAYS (3-day rotating full body)
// ============================================================

// ============================================================
// getKamlifeProgramme
// Returns a formatted string overview of the user's programme.
// For gym users, returns the appropriate 3-day full body programme
// based on mode (full equipment vs dumbbell) and focus area.
// ============================================================

export function getKamlifeProgramme(user: any, todayOnly = false): string {
  // MESSAGE BUDGET (2026-08-12). Measured at 15 WhatsApp bubbles against a stated cap of 3.
  // Nothing is trimmed — sections are re-packed, and an unavoidable overflow is logged.
  return enforceMessageBudget(
    withSafetyNote(getKamlifeProgrammeInner(user, todayOnly), user),
    MESSAGE_BUDGET.programme, todayOnly ? "getKamlifeProgramme(today)" : "getKamlifeProgramme");
}

function getKamlifeProgrammeInner(user: any, todayOnly = false): string {
  const mode = user.trainingMode || "home";
  const exp = (user.trainingExperience || "beginner").toLowerCase();
  const age = user.age || 30;
  const programmeWeek = user.programmeWeek || 1;
  const isYouth = age < 18;
  const isElderly = age >= 60;

  // Progressive walking target — ramps up over weeks, not static from day 1
  const baseSteps = user.stepsTarget || 10000;
  let progressiveSteps = baseSteps;
  if (programmeWeek <= 2) {
    progressiveSteps = Math.round(baseSteps * 0.7); // Week 1-2: 70%
  } else if (programmeWeek <= 4) {
    progressiveSteps = Math.round(baseSteps * 0.85); // Week 3-4: 85%
  }
  // Week 5+: full target

  // Age-aware prefix
  let prefix = "";
  if (isElderly && todayOnly) {
    prefix = `*Warm-up first (5 min):* Light walk or march in place. Arm circles. Gentle leg swings. Ankle rotations.\n\n`;
  }
  if (isYouth && todayOnly) {
    prefix = bmiOf(user) >= 33
      ? `*Quick warm-up:* 2-min brisk march on the spot, arm circles, 10 slow sit-to-stands.\n\n`
      : `*Quick warm-up:* 30 star jumps, 10 high knees each side, arm swings.\n\n`;
  }

  // Walking target footer for today's workout
  let walkingFooter = "";
  if (todayOnly) {
    walkingFooter = `\n\n*Walking today:* ${progressiveSteps.toLocaleString()} steps${programmeWeek <= 4 ? ` (building up — full target is ${baseSteps.toLocaleString()})` : ""}. Send a screenshot or tell me your count.`;
  }

  if (mode !== "gym" && mode !== "gym_dumbbell") return prefix + HOME_PROGRAMME_GUIDE + walkingFooter;

  const isDumbbell = mode === "gym_dumbbell";
  const isGlutesFocus = user.primaryFocusArea === "glutes_legs";

  // Elderly safety note appended to every todayOnly workout
  const elderlyNote = isElderly && todayOnly
    ? `\n\n_💡 Senior tip: Use lighter weights with higher reps (12-15). If any movement causes joint pain, skip it and do the modification instead. Rest as long as you need between sets._`
    : "";
  // Youth safety note
  const youthNote = isYouth && todayOnly
    ? `\n\n_💡 Focus on form, not weight. No maxing out. If you can't do the full reps with good form, go lighter. Building habits now = gains for life._`
    : "";
  const safetyNote = elderlyNote || youthNote;

  if (isDumbbell) {
    if (todayOnly) {
      const day = user.programmeDayInWeek || 1;
      const dbTrainingDays = user.trainingDaysPerWeek || 3;
      const dbGender = user.gender || "male";
      const { exercises, label } = getNewDbDay(dbTrainingDays, day, dbGender);
      const phase = user.programmePhase || 1;
      const multiplier = getPhaseMultiplier(phase);
      const phaseName = getPhaseNames()[phase] || "Foundation";
      return prefix + formatGymDay(exercises, label, phase, phaseName, user.programmeWeek || 1, multiplier, user.goalType || "fat_loss", true, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0) + safetyNote + walkingFooter;
    }
    const dbTrainingDays = user.trainingDaysPerWeek || 3;
    const dbGender = user.gender || "male";
    if (dbTrainingDays <= 2) {
      const dA = formatGymDay(NEW_2DAY_A, "Full Body A", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", true, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
      const dB = formatGymDay(dbGender === "female" ? NEW_2DAY_B_WOMEN : NEW_2DAY_B_MEN, "Full Body B", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", true, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
      return `${dA}\n\n---\n\n${dB}`;
    }
    if (dbTrainingDays >= 4) {
      const ua = formatGymDay(NEW_4DAY_UPPER_A, "Upper Body A", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", true, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
      const la = formatGymDay(NEW_4DAY_LOWER_A, "Lower Body A", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", true, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
      const ub = formatGymDay(dbGender === "female" ? NEW_4DAY_UPPER_B_WOMEN : NEW_4DAY_UPPER_B_MEN, "Upper Body B", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", true, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
      const lb = formatGymDay(NEW_4DAY_LOWER_B, "Lower Body B", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", true, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
      return `${ua}\n\n---\n\n${la}\n\n---\n\n${ub}\n\n---\n\n${lb}`;
    }
    const dA = formatGymDay(NEW_3DAY_A, "Full Body A", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", true, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
    const dB = formatGymDay(NEW_3DAY_B, "Full Body B", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", true, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
    const dC = formatGymDay(dbGender === "female" ? NEW_3DAY_C_WOMEN : NEW_3DAY_C_MEN, "Full Body C", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", true, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
    return `${dA}\n\n---\n\n${dB}\n\n---\n\n${dC}`;
  }

  if (isGlutesFocus) {
    if (todayOnly) {
      const day = user.programmeDayInWeek || 1;
      const femaleSlot = (((day - 1) % 4) + 1);
      const slotClamped = (femaleSlot <= 3 ? femaleSlot : 1) as 1 | 2 | 3;
      const femaleExMap: Record<1 | 2 | 3, Exercise[]> = { 1: GYM_GLUTES_DAY_A, 2: GYM_GLUTES_DAY_B, 3: GYM_GLUTES_DAY_C };
      const femaleLabelMap: Record<1 | 2 | 3, string> = { 1: "Glutes + Shoulders", 2: "Back + Hamstrings", 3: "Full Body + Glutes" };
      const phase = user.programmePhase || 1;
      const phaseName = getPhaseNames()[phase] || "Foundation";
      const fSession = formatGymDay(femaleExMap[slotClamped], femaleLabelMap[slotClamped], phase, phaseName, programmeWeek, getPhaseMultiplier(phase), user.goalType || "fat_loss", false, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
      return prefix + fSession + safetyNote + walkingFooter;
    }
    return `${FEMALE_DAY_A}\n\n---\n\n${FEMALE_DAY_B}\n\n---\n\n${FEMALE_DAY_C}`;
  }

  // Standard gym full equipment
  if (exp === "intermediate" || exp === "advanced") {
    if (todayOnly) {
      const day = user.programmeDayInWeek || 1;
      const phase = user.programmePhase || 1;
      const phaseName = getPhaseNames()[phase] || "Foundation";
      const isLower = day % 2 === 0;
      const intExercises = isLower ? INTERMEDIATE_LOWER_EX : INTERMEDIATE_UPPER_EX;
      const intLabel = isLower ? "Lower Body" : "Upper Body";
      const iSession = formatGymDay(intExercises, intLabel, phase, phaseName, programmeWeek, getPhaseMultiplier(phase), user.goalType || "fat_loss", false, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
      return prefix + iSession + safetyNote + walkingFooter;
    }
    return `${INTERMEDIATE_GYM_UPPER}\n\n---\n\n${INTERMEDIATE_GYM_LOWER}`;
  }

  if (todayOnly) {
    const day = user.programmeDayInWeek || 1;
    const daySlot = (((day - 1) % 4) + 1);
    // 4-day rotation: A, B, C, then repeat A for volume
    const slotClamped = (daySlot <= 3 ? daySlot : 1) as 1 | 2 | 3;
    const exercises = getGymDay(slotClamped, false, false);
    const label = daySlot === 4 ? "Full Body D (Volume)" : daySlotLabel(slotClamped, false, false);
    const phase = user.programmePhase || 1;
    const multiplier = getPhaseMultiplier(phase);
    const phaseName = getPhaseNames()[phase] || "Foundation";
    return prefix + formatGymDay(exercises, label, phase, phaseName, user.programmeWeek || 1, multiplier, user.goalType || "fat_loss", false, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0) + safetyNote + walkingFooter;
  }

  const trainingDays = user.trainingDaysPerWeek || 3;
  const gender = user.gender || "male";
  if (trainingDays <= 2) {
    const dayA = formatGymDay(NEW_2DAY_A, "Full Body A", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", false, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
    const dayB = formatGymDay(gender === "female" ? NEW_2DAY_B_WOMEN : NEW_2DAY_B_MEN, "Full Body B", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", false, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
    return `${dayA}\n\n---\n\n${dayB}`;
  }
  if (trainingDays >= 4) {
    const ua = formatGymDay(NEW_4DAY_UPPER_A, "Upper Body A", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", false, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
    const la = formatGymDay(NEW_4DAY_LOWER_A, "Lower Body A", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", false, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
    const ub = formatGymDay(gender === "female" ? NEW_4DAY_UPPER_B_WOMEN : NEW_4DAY_UPPER_B_MEN, "Upper Body B", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", false, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
    const lb = formatGymDay(NEW_4DAY_LOWER_B, "Lower Body B", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", false, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
    return `${ua}\n\n---\n\n${la}\n\n---\n\n${ub}\n\n---\n\n${lb}`;
  }
  const dayA = formatGymDay(NEW_3DAY_A, "Full Body A", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", false, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
  const dayB = formatGymDay(NEW_3DAY_B, "Full Body B", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", false, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
  const dayC = formatGymDay(gender === "female" ? NEW_3DAY_C_WOMEN : NEW_3DAY_C_MEN, "Full Body C", 1, "Foundation", 1, getPhaseMultiplier(1), user.goalType || "fat_loss", false, user.injuries || "none", exp, false, user.totalWorkoutsCompleted || 0);
  return `${dayA}\n\n---\n\n${dayB}\n\n---\n\n${dayC}`;
}

// ============================================================
// buildDayWorkout
// The primary function used to generate today's session for a user.
// Gym users: day type is derived from programmeDayInWeek mod 3 — NOT calendar day.
// Home users: rotating 3-day full body split.
// ============================================================

// Exercises that load specific body areas — used to filter when injured
const INJURY_EXERCISE_MAP: Record<string, string[]> = {
  knee: ["squat", "lunge", "jump squat", "split squat", "leg press", "leg extension", "step up", "box jump", "bulgarian"],
  shoulder: ["push up", "overhead press", "shoulder press", "lateral raise", "front raise", "military press", "arnold press", "bench press", "incline press", "decline push"],
  back: ["deadlift", "bent over row", "barbell row", "good morning", "superman", "back extension", "hyperextension"],
  hip: ["squat", "lunge", "deadlift", "hip thrust", "glute bridge", "split squat", "step up", "sumo"],
  wrist: ["push up", "bench press", "overhead press", "barbell curl", "front raise"],
  ankle: ["squat", "lunge", "jump squat", "calf raise", "box jump", "step up", "split squat"],
};

type HomeEx = { name: string; setsReps: string; cue: string; mistake: string; yt: string };

function filterInjuredExercises(exercises: HomeEx[], injuries: string): { safe: HomeEx[]; skipped: string[] } {
  if (!injuries || injuries === "none") return { safe: exercises, skipped: [] };
  const injuryLower = injuries.toLowerCase();
  const blockedPatterns: string[] = [];
  for (const [area, patterns] of Object.entries(INJURY_EXERCISE_MAP)) {
    if (injuryLower.includes(area)) blockedPatterns.push(...patterns);
  }
  if (blockedPatterns.length === 0) return { safe: exercises, skipped: [] };
  const safe: HomeEx[] = [];
  const skipped: string[] = [];
  for (const ex of exercises) {
    const nameLower = ex.name.toLowerCase();
    if (blockedPatterns.some(p => nameLower.includes(p))) {
      skipped.push(ex.name);
    } else {
      safe.push(ex);
    }
  }
  return { safe, skipped };
}

function filterInjuredGymExercises(exercises: Exercise[], injuries: string): { safeEx: Exercise[]; skippedNames: string[] } {
  if (!injuries || injuries === "none") return { safeEx: exercises, skippedNames: [] };
  const injuryLower = injuries.toLowerCase();
  const blockedPatterns: string[] = [];
  for (const [area, patterns] of Object.entries(INJURY_EXERCISE_MAP)) {
    if (injuryLower.includes(area)) blockedPatterns.push(...patterns);
  }
  if (blockedPatterns.length === 0) return { safeEx: exercises, skippedNames: [] };
  const safeEx: Exercise[] = [];
  const skippedNames: string[] = [];
  for (const ex of exercises) {
    const nameLower = ex.name.toLowerCase();
    if (blockedPatterns.some(p => nameLower.includes(p))) {
      skippedNames.push(ex.name);
    } else {
      safeEx.push(ex);
    }
  }
  return { safeEx, skippedNames };
}

export function buildDayWorkout(user: any): string {
  return withSafetyNote(buildDayWorkoutInner(user), user);
}

function buildDayWorkoutInner(user: any): string {
  const mode = user.trainingMode || "home";
  const phase = user.programmePhase || 1;
  const phaseNames = getPhaseNames();
  const phaseName = phaseNames[phase] || "Foundation";
  const multiplier = getPhaseMultiplier(phase);
  const week = user.programmeWeek || 1;
  const day = user.programmeDayInWeek || 1;
  const isFemaleGluteFocus = user.primaryFocusArea === "glutes_legs";
  const isDumbbell = mode === "gym_dumbbell";
  const injuries = user.injuries || "none";
  const experience = (user.trainingExperience || "beginner").toLowerCase();

  // Walk-only users
  if (mode === "walk_only" || mode === "walk") {
    const duration =
      phase === 1 ? "15 minutes" :
      phase === 2 ? "25 minutes" :
      phase === 3 ? "35 minutes" : "45 minutes";
    const walkBlock = `*Brisk Walk — ${duration}*\nWalk fast enough to feel slightly breathless but still able to talk. Arms swinging. Posture tall. Do not stop unless necessary.`;

    // Lifestyle walkers (chose walking, no medical limit) get a ~2x/week bodyweight tone-up: the
    // minimum resistance that + high protein keeps weight lost as fat. MEDICAL GATE: walk:medical/injury stays pure.
    const walkerNotes = (user.profileNotes || "").toLowerCase();
    const hasInjury = injuries.trim() !== "" && injuries.toLowerCase() !== "none";
    const isLifestyleWalker = walkerNotes.includes("walk:lifestyle") && !hasInjury;
    if (isLifestyleWalker && (day === 1 || day === 3)) {
      const reps = phase === 1 ? "8-10" : phase === 2 ? "10-12" : "12-15";
      const toneUp = `\n\n*Muscle insurance — 10 min, optional but worth it:*\n2 easy rounds, ${reps} reps each:\n• Bodyweight squats (sit to a chair and stand)\n• Push-ups — on your knees or against a wall is fine\n• Glute bridges\n• Plank — hold 20-30 sec\n\nThis is what keeps the weight you lose as *fat, not muscle*. Skip anything that hurts.`;
      return `*Phase ${phase}: ${phaseName} — Week ${week}*\nToday: Day ${day}\n\n${walkBlock}${toneUp}\n\nSend DONE when finished.`;
    }
    return `*Phase ${phase}: ${phaseName} — Week ${week}*\nToday: Day ${day}\n\n${walkBlock}\n\nSend DONE when finished.`;
  }

  const trainingDays = user.trainingDaysPerWeek || 3;
  const gender = user.gender || "male";

  // Dumbbell-only users — full 2/3/4-day programme, gender-specific
  if (mode === "gym_dumbbell") {
    const { exercises, label } = getNewDbDay(trainingDays, day, gender);
    return formatGymDay(exercises, label, phase, phaseName, week, multiplier, user.goalType || "fat_loss", true, injuries, experience, false, user.totalWorkoutsCompleted || 0);
  }

  // Home / no-equipment users — full 2/3/4-day programme, gender-specific
  if (mode !== "gym") {
    const { exercises, label } = getNewHomeDay(trainingDays, day, gender);
    return formatGymDay(swapImpactForHeavy(exercises, user), label, phase, phaseName, week, multiplier, user.goalType || "fat_loss", false, injuries, experience, false, user.totalWorkoutsCompleted || 0);
  }

  // Gym users — route to correct day based on trainingDaysPerWeek and gender
  const { exercises, label } = getNewGymDay(trainingDays, day, gender, isFemaleGluteFocus);
  return formatGymDay(exercises, label, phase, phaseName, week, multiplier, user.goalType || "fat_loss", false, injuries, experience, true, user.totalWorkoutsCompleted || 0);
}

/**
 * Returns the user's CURRENT day exercises as structured DayExercise[] (slug + real
 * phase/week prescription), or null for walk-only users (no machines to coach). Mirrors
 * buildDayWorkout's routing exactly — same day selection — but returns data, not text,
 * so the machine-photo coach can match a photographed machine against today's plan.
 */
export function getCurrentDayExercises(user: any): { exercises: DayExercise[]; label: string } | null {
  const mode = user.trainingMode || "home";
  if (mode === "walk_only" || mode === "walk") return null;

  const trainingDays = user.trainingDaysPerWeek || 3;
  const gender = user.gender || "male";
  const day = user.programmeDayInWeek || 1;

  let raw: { exercises: Exercise[]; label: string };
  if (mode === "gym_dumbbell") {
    raw = getNewDbDay(trainingDays, day, gender);
  } else if (mode !== "gym") {
    raw = getNewHomeDay(trainingDays, day, gender);
    raw = { ...raw, exercises: swapImpactForHeavy(raw.exercises, user) };
  } else {
    raw = getNewGymDay(trainingDays, day, gender, user.primaryFocusArea === "glutes_legs");
  }

  const phase = user.programmePhase || 1;
  const week = user.programmeWeek || 1;
  const isBeginner = (user.trainingExperience || "beginner").toLowerCase() === "beginner";
  const wCtx = getWeekContext(phase, week, isBeginner, user.totalWorkoutsCompleted || 0);

  const exercises: DayExercise[] = raw.exercises.map((ex) => ({
    name: ex.name,
    slug: resolveExerciseSlug(ex.name),
    setsDisplay: getExerciseSets(ex, wCtx.sets, wCtx.reps, phase),
    description: ex.description,
    mistake: ex.mistake,
    modification: ex.modification,
  }));
  return { exercises, label: raw.label };
}

// ============================================================
// buildDay1Workout
// Day 1 delivery at onboarding/payment. Later days come from buildDayWorkout
// with the calendar-derived day slot (workout-state.ts).
// ============================================================

export function buildDay1Workout(user: any): string {
  return buildDayWorkout({ ...user, programmeDayInWeek: 1 });
}

// ============================================================
// buildFullProgramme
// Returns only Day 1 for new users (initial delivery at onboarding).
// Later days unlock via the normal workout flow
// when the user logs DONE (see handlers/workout.ts).
// ============================================================

/** Onboarding's full-programme render, held to the same message budget (was 5 bubbles vs cap 3). */
export function buildFullProgramme(user: any): string {
  return enforceMessageBudget(buildFullProgrammeInner(user), MESSAGE_BUDGET.programme, "buildFullProgramme");
}

function buildFullProgrammeInner(user: any): string {
  const mode = user.trainingMode || "home";
  const phase = user.programmePhase || 1;
  const phaseNames = getPhaseNames();
  const phaseName = phaseNames[phase] || "Foundation";
  const week = user.programmeWeek || 1;

  if (mode !== "gym" && mode !== "gym_dumbbell") {
    // Home: deliver Day 1 only at onboarding
    const day1 = buildDayWorkout({ ...user, programmeDayInWeek: 1 });
    return `*Phase ${phase}: ${phaseName} — Week ${week} | Full Body Home Programme*\nTrain on non-consecutive days. Each session hits squat, push, hinge, pull, and core.\n\n${day1}`;
  }

  // Female programme: send Day A first — full-gym users only; dumbbell users route
  // through buildDay1Workout so they get dumbbell exercises, not machine work
  const isFemaleGluteFocusFull = user.primaryFocusArea === "glutes_legs";
  if (isFemaleGluteFocusFull && mode === "gym") {
    return withSafetyNote(`*Your 3-Day Programme — Shoulders, Back, Arms, Glutes, Hamstrings, Calves*\nTrain Monday, Wednesday, Friday or Tuesday, Thursday, Saturday. Never two days in a row.\n\n${FEMALE_DAY_A}`, user);
  }

  // 4-day upper/lower: send Upper (Day 1) first — Lower follows after DONE.
  // Full-gym only: INTERMEDIATE_GYM_UPPER uses machines/cables a dumbbell user doesn't have.
  const trainingDays = user.trainingDaysPerWeek || 3;
  const exp = user.trainingExperience || "beginner";
  if (mode === "gym" && trainingDays >= 4 && (exp === "intermediate" || exp === "advanced")) {
    return withSafetyNote(`*4-Day Upper/Lower Split — Week ${week}*\nMonday + Thursday: Upper Body. Tuesday + Friday: Lower Body. Rest Wednesday, Saturday, Sunday.\n\n${INTERMEDIATE_GYM_UPPER}`, user);
  }

  // Gym + dumbbell: deliver Day 1 only — following days unlock after DONE is logged
  return buildDay1Workout(user);
}

// ============================================================
// WORKOUT_DONE_RESPONSES
// ============================================================

/**
 * ONE OR TWO SHORT SENTENCES (2026-08-06, founder, live screenshot of the done-reply).
 *
 * Every one of these used to be a three-paragraph physiology lecture — cortisol dropping,
 * glycogen depleted, muscle fibres rebuilding thicker — stapled on top of a comeback note,
 * a target table and a three-button menu. A man who has just finished training does not read
 * that. The founder's own words to a client who trains are "Lekker. Session 22." and then a
 * question about how it felt.
 *
 * So the count survives, because the count is the thing they earned. The lecture does not.
 * Keep them SHORT — if a new entry needs a second line, it does not belong here.
 */
export const WORKOUT_DONE_RESPONSES = [
  (total: number, _day: number) => `Crushed it. 🔥 Session ${total} on the board.`,
  (total: number, day: number) => `Session ${total} done, day ${day} banked. 💪`,
  (total: number, _day: number) => `Lekker work. 💪 That's ${total} sessions in.`,
  (total: number, _day: number) => `Done — ${total} sessions logged. 🔥`,
  (total: number, day: number) => `Day ${day} ticked off, session ${total} on the board. 🏆`,
  (total: number, _day: number) => `${total} sessions. Most people skipped today — you didn't. 💪`,
  (total: number, _day: number) => `Done. 🔥 Session ${total} locked.`,
  (total: number, day: number) => `Session ${total} complete, day ${day} in the books. 💪`,
  (total: number, _day: number) => `${total} sessions with Coach K. 💪 Nice one.`,
  (total: number, _day: number) => `Trained, logged, done — session ${total}. 🔥`,
  (total: number, _day: number) => `${total} down. 🏆 A little stronger than last time.`,
  (total: number, day: number) => `Day ${day} done. Session ${total}. 💪`,
  (total: number, _day: number) => `Eish — ${total} sessions! 🔥 You're actually doing it now.`,
  (total: number, _day: number) => `Done is done. Session ${total} locked. 💪`,
  (total: number, _day: number) => `Session ${total} banked. No one takes that from you. 💪`,
  (total: number, day: number) => `${total} sessions, day ${day} ticked off. 🔥`,
];

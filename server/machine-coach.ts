/**
 * MACHINE COACH — the brain behind the "photograph a gym machine" feature.
 *
 * A client at the gym photographs a machine. Vision names it (see getMachineSlug in
 * handlers/media.ts), we resolve it to a slug, then this module answers the two questions
 * that actually help the client:
 *
 *   1. Is this the machine my plan calls for today? → matchMachineToDay()
 *   2. If not, does it train the same muscles so I can use it instead? → substitution
 *
 * The prescription (sets/reps, form cue, common mistake) is pulled from the user's REAL
 * programme (DayExercise from programme.ts) — never a hardcoded guess — so what the photo
 * reply says always matches what their workout text says. Setup steps and a per-machine
 * how-to cue live here because they describe the MACHINE in front of them, which may be a
 * substitute that differs from their prescribed movement.
 */

import type { DayExercise } from "./programme";

export type MuscleGroup =
  | "quads" | "hamstrings" | "glutes" | "calves"
  | "chest" | "back" | "shoulders" | "biceps" | "triceps" | "core";

// Primary muscle group(s) each slug trains. Two machines that share a group are valid
// substitutes for each other (a hack squat for a leg press, a lat pulldown for a row).
// Kept to PRIMARY movers only — listing every secondary muscle would make the substitution
// engine over-eager ("use this bicep machine for your chest day").
const SLUG_MUSCLE: Record<string, MuscleGroup[]> = {
  // Quads / legs (compound)
  "squat": ["quads", "glutes"],
  "smith-squat": ["quads", "glutes"],
  "barbell-back-squat": ["quads", "glutes"],
  "hack-squat": ["quads", "glutes"],
  "leg-press": ["quads", "glutes"],
  "goblet-squat": ["quads", "glutes"],
  "sumo-squat": ["quads", "glutes"],
  "bulgarian-split-squat": ["quads", "glutes"],
  "reverse-lunge": ["quads", "glutes"],
  "step-up": ["quads", "glutes"],
  "leg-extension": ["quads"],
  // Hamstrings / posterior
  "leg-curl": ["hamstrings"],
  "rdl": ["hamstrings", "glutes"],
  // Glutes
  "hip-thrust": ["glutes"],
  "glute-bridge": ["glutes"],
  "cable-kickback": ["glutes"],
  // Calves
  "calf-raise": ["calves"],
  "seated-calf-raise": ["calves"],
  // Chest / push
  "chest-press": ["chest"],
  "barbell-bench-press": ["chest"],
  "incline-dumbbell-press": ["chest"],
  "dumbbell-floor-press": ["chest"],
  "chest-fly": ["chest"],
  "push-up": ["chest"],
  // Shoulders
  "shoulder-press": ["shoulders"],
  "lateral-raise": ["shoulders"],
  "face-pull": ["shoulders", "back"],
  // Back / pull
  "lat-pulldown": ["back"],
  "seated-row": ["back"],
  "barbell-row": ["back"],
  "bent-over-row": ["back"],
  "single-arm-row": ["back"],
  "chest-supported-row": ["back"],
  "resistance-band-row": ["back"],
  "door-frame-row": ["back"],
  "table-row": ["back"],
  // Arms
  "bicep-curl": ["biceps"],
  "cable-bicep-curl": ["biceps"],
  "doorframe-curl": ["biceps"],
  "tricep-pushdown": ["triceps"],
  "tricep-overhead-extension": ["triceps"],
  "tricep-kickback": ["triceps"],
  "chair-tricep-dip": ["triceps"],
  // Core
  "plank": ["core"],
  "dead-bug": ["core"],
  "cable-crunch": ["core"],
  "plank-leg-raise": ["core"],
  "plank-shoulder-tap": ["core"],
};

// Movement PATTERN per slug. Two machines are only valid substitutes when they share
// BOTH a muscle group AND a movement pattern — otherwise the engine offers nonsense like
// "use this shoulder PRESS in place of your lateral RAISE" (both "shoulders", totally
// different movements). A compound press is never a swap for an isolation raise.
type MovePattern =
  | "knee-dominant"      // squat-family compounds
  | "quad-isolation" | "ham-isolation"
  | "hip-hinge" | "hip-extension"
  | "calf"
  | "horizontal-push" | "vertical-push" | "chest-isolation" | "delt-isolation"
  | "vertical-pull" | "horizontal-pull" | "rear-delt"
  | "biceps" | "triceps" | "core";

const SLUG_PATTERN: Record<string, MovePattern> = {
  "squat": "knee-dominant", "smith-squat": "knee-dominant", "barbell-back-squat": "knee-dominant",
  "hack-squat": "knee-dominant", "leg-press": "knee-dominant", "goblet-squat": "knee-dominant",
  "sumo-squat": "knee-dominant", "bulgarian-split-squat": "knee-dominant",
  "reverse-lunge": "knee-dominant", "step-up": "knee-dominant",
  "leg-extension": "quad-isolation",
  "leg-curl": "ham-isolation",
  "rdl": "hip-hinge",
  "hip-thrust": "hip-extension", "glute-bridge": "hip-extension", "cable-kickback": "hip-extension",
  "calf-raise": "calf", "seated-calf-raise": "calf",
  "chest-press": "horizontal-push", "barbell-bench-press": "horizontal-push",
  "incline-dumbbell-press": "horizontal-push", "dumbbell-floor-press": "horizontal-push",
  "push-up": "horizontal-push",
  "chest-fly": "chest-isolation",
  "shoulder-press": "vertical-push",
  "lateral-raise": "delt-isolation",
  "face-pull": "rear-delt",
  "lat-pulldown": "vertical-pull",
  "seated-row": "horizontal-pull", "barbell-row": "horizontal-pull", "bent-over-row": "horizontal-pull",
  "single-arm-row": "horizontal-pull", "chest-supported-row": "horizontal-pull",
  "resistance-band-row": "horizontal-pull", "door-frame-row": "horizontal-pull", "table-row": "horizontal-pull",
  "bicep-curl": "biceps", "cable-bicep-curl": "biceps", "doorframe-curl": "biceps",
  "tricep-pushdown": "triceps", "tricep-overhead-extension": "triceps",
  "tricep-kickback": "triceps", "chair-tricep-dip": "triceps",
  "plank": "core", "dead-bug": "core", "cable-crunch": "core",
  "plank-leg-raise": "core", "plank-shoulder-tap": "core",
};

function patternForSlug(slug: string | null): MovePattern | null {
  return slug ? (SLUG_PATTERN[slug] || null) : null;
}

// Setup steps — the part a true beginner gets stuck on (seat height, pad position, pins,
// how to unrack). Only machines that genuinely need adjusting are listed; slugs without an
// entry simply skip the setup line in the reply.
const MACHINE_SETUP: Record<string, string> = {
  "leg-press": "Sit with your whole back flat against the pad. Feet mid-platform, shoulder-width. Release the safety handles before your first rep.",
  "hack-squat": "Shoulders under the pads, back flat against the backrest. Feet shoulder-width on the platform. Straighten up and rotate the handles to unrack.",
  "squat": "Set the bar on your upper traps, hands just outside your shoulders. Rotate to unhook. Feet shoulder-width, slightly in front of the bar.",
  "smith-squat": "Set the bar on your upper traps, hands just outside your shoulders. Rotate to unhook. Feet shoulder-width, slightly in front of the bar.",
  "barbell-back-squat": "Bar on your upper traps in the rack, hands outside your shoulders. Unrack, step back, feet shoulder-width.",
  "leg-extension": "Sit back fully. Set the pad to rest on your lower shins, just above the ankles. Your knees should line up with the machine's pivot.",
  "leg-curl": "Pad rests just above your heels. Your knees line up with the pivot point. Hips stay pinned down throughout.",
  "seated-calf-raise": "Balls of your feet on the platform, pad snug on your lower thighs. Let your heels drop below the platform for full range.",
  "chest-press": "Set the seat so the handles line up with the middle of your chest. Back flat against the pad.",
  "shoulder-press": "Seat height so the handles start at shoulder level. Back flat against the pad, core braced.",
  "lat-pulldown": "Adjust the thigh pad so your legs are pinned and you don't lift off. Grip the bar wider than shoulder-width.",
  "seated-row": "Feet on the platform, knees slightly bent. Sit tall, chest up, then grab the handle with arms extended.",
  "chest-fly": "Set the seat so the handles sit at chest/shoulder level. Back flat, a slight bend in your elbows held throughout.",
  "hip-thrust": "Upper back against the pad, the belt or pad across your hips. Feet flat, shoulder-width, knees bent.",
  "tricep-pushdown": "Set the cable to the top pulley with a bar or rope. Elbows pinned tight at your sides.",
  "cable-bicep-curl": "Set the cable to the bottom pulley. Stand tall, elbows pinned at your sides.",
  "face-pull": "Set the cable to about head height with a rope. Step back so there's tension before you start.",
  "lateral-raise": "Set the cable to the bottom pulley. Stand side-on, handle in the hand furthest from the machine.",
};

// Per-machine how-to cue. Used when the machine is a SUBSTITUTE (so the cue describes the
// machine they're looking at, not their prescribed movement) or when they have no programme.
const MACHINE_HOWTO: Record<string, string> = {
  "leg-press": "Lower until your thighs pass parallel — full range. Drive through your heels, not your toes.",
  "hack-squat": "Shoulders back against the pad. Full depth. Drive through your heels, core tight.",
  "squat": "Feet shoulder-width. Lower until your thighs are parallel. Drive through your heels. Core tight throughout.",
  "smith-squat": "Feet shoulder-width. Lower until your thighs are parallel. Drive through your heels. Core tight throughout.",
  "barbell-back-squat": "Feet shoulder-width. Full depth. Drive through your heels. Chest up throughout.",
  "goblet-squat": "Hold the weight at your chest. Squat down between your knees, chest up. Drive through your heels.",
  "bulgarian-split-squat": "Back foot elevated, front foot well forward. Lower straight down, drive through the front heel. Front knee tracks over your toes.",
  "reverse-lunge": "Step back, lower your back knee toward the floor. Front knee over your toes. Drive through the front heel to stand.",
  "step-up": "Whole foot on the box. Drive through the top foot to stand — don't push off the bottom foot. Control the way down.",
  "leg-extension": "Full extension at the top — squeeze your quads hard. Slow 2-second lowering. No swinging.",
  "leg-curl": "Curl your heels all the way toward your glutes. Slow 2-second lowering. Hips stay pinned down.",
  "rdl": "Push your hips back — not down. Flat back throughout. Feel the hamstring stretch at the bottom. Drive hips forward to stand.",
  "hip-thrust": "Drive your hips up explosively. Squeeze your glutes hard at the top for 1 full second. Lower slowly.",
  "glute-bridge": "Drive your hips up, squeeze your glutes hard at the top. Lower slowly. Don't arch your lower back.",
  "cable-kickback": "Kick straight back and squeeze your glute at the top. Keep your back flat — don't arch. Slow return.",
  "calf-raise": "Full range — heel as low as possible, rise all the way onto your toes. Pause at the top. No bouncing.",
  "seated-calf-raise": "Full range — let your heels drop low, then rise all the way onto your toes. Pause at the top. No bouncing.",
  "chest-press": "Elbows at 45° from your torso — not flared wide. Drive to full extension. Slow 2-second lowering.",
  "incline-dumbbell-press": "30–45° incline. Elbows at 45°. Press up and feel the upper chest working.",
  "chest-fly": "Wide arc, slight elbow bend throughout. Squeeze your chest at the top. Feel the stretch at the bottom — don't let it slam.",
  "push-up": "Hands just outside shoulder-width. Lower your chest to the floor — full range. Body in one straight line.",
  "shoulder-press": "Press overhead until your arms are nearly straight. Core braced. Lower slowly — don't crash the weight.",
  "lateral-raise": "Arms slightly bent. Raise to shoulder height only — no higher. Slow 2-second lowering. No shrugging.",
  "face-pull": "Elbows high and wide. Pull the rope toward your forehead. Squeeze your rear delts. No neck tension.",
  "lat-pulldown": "Drive your elbows down to your back pockets — not your hands. Squeeze your shoulder blades at the bottom. Full stretch at the top.",
  "seated-row": "Pull to your lower chest. Squeeze your shoulder blades hard together. Full stretch forward — don't round your back.",
  "barbell-row": "Hinge forward with a flat back. Pull to your lower ribs. Squeeze your shoulder blades. Lower under control.",
  "bent-over-row": "Hinge forward with a flat back. Pull to your lower ribs. Squeeze your shoulder blades. Lower under control.",
  "single-arm-row": "Flat back, brace on a bench. Pull the weight to your hip. Squeeze, then lower with control.",
  "resistance-band-row": "Pull the band to your ribs and squeeze your shoulder blades. Control the return — don't let it snap back.",
  "bicep-curl": "Elbows pinned at your sides. Curl to full contraction. Slow lowering — feel the stretch at the bottom.",
  "cable-bicep-curl": "Elbows pinned at your sides. Curl to full contraction. Slow lowering — feel the stretch at the bottom.",
  "tricep-pushdown": "Elbows pinned tight to your sides — they don't move. Extend to fully straight. Squeeze your triceps at the bottom.",
  "tricep-overhead-extension": "Elbows point up and stay still. Lower the weight behind your head, then extend to straight.",
  "chair-tricep-dip": "Hands on the edge, elbows pointing straight back. Lower until your elbows hit 90°. Drive back up.",
  "plank": "Forearms under your shoulders, body in one straight line. Brace your core hard. Don't let your hips sag or pike.",
  "dead-bug": "Lower back pressed to the floor. Extend the opposite arm and leg slowly. Don't let your back arch up.",
};

const DEFAULT_HOWTO = "Full range of motion on every rep. Control the weight — slow on the lowering. No momentum.";

export type MachineMatchKind = "exact" | "substitute" | "other";

export interface MachineMatch {
  kind: MachineMatchKind;
  /** The user's prescribed exercise this machine maps to (exact) or can replace (substitute). */
  prescribed?: DayExercise;
}

/** The muscle groups a slug trains (empty array if unknown). */
export function musclesForSlug(slug: string | null): MuscleGroup[] {
  return slug ? (SLUG_MUSCLE[slug] || []) : [];
}

/** Setup steps for a machine slug, or null if it needs no special setup. */
export function machineSetup(slug: string | null): string | null {
  return slug ? (MACHINE_SETUP[slug] || null) : null;
}

/** How-to cue for the machine in front of the client. Falls back to a generic cue. */
export function machineHowTo(slug: string | null): string {
  return (slug && MACHINE_HOWTO[slug]) || DEFAULT_HOWTO;
}

/** The first alternative of a compound programme name: "Smith Squat / Leg Press" → "Smith Squat". */
export function primaryExerciseName(name: string): string {
  return name.split(" / ")[0].trim();
}

/**
 * Matches a photographed machine against the user's current day.
 *  - exact:      the machine IS one of today's exercises (slug match, or its name appears in
 *                a prescribed compound name like "Smith Squat / Leg Press").
 *  - substitute: not prescribed today, but trains the same muscle group as something that is
 *                — so the client can swap it in (a hack squat for a leg-press day).
 *  - other:      trains nothing on today's plan (or there is no programme to match against).
 */
export function matchMachineToDay(
  photographedSlug: string | null,
  machineName: string,
  day: { exercises: DayExercise[]; label: string } | null,
): MachineMatch {
  if (!day || day.exercises.length === 0) return { kind: "other" };

  // Strip a trailing "machine" so "leg press machine" textually matches "...leg press".
  const cleanName = machineName.toLowerCase().replace(/\s*machine\s*$/, "").trim();
  const photographedMuscles = musclesForSlug(photographedSlug);

  // Tier 1 — exact: slug match, or the machine's name appears in the prescribed name.
  for (const ex of day.exercises) {
    const exNameLower = ex.name.toLowerCase();
    const slugMatch = !!photographedSlug && ex.slug === photographedSlug;
    const textMatch = cleanName.length > 3 && exNameLower.includes(cleanName);
    if (slugMatch || textMatch) return { kind: "exact", prescribed: ex };
  }

  // Tier 2 — substitute: same muscle group AND same movement pattern as a prescribed
  // exercise. Requiring the pattern to match stops cross-pattern nonsense — a shoulder
  // PRESS is not a swap for a lateral RAISE even though both are "shoulders".
  const photographedPattern = patternForSlug(photographedSlug);
  if (photographedMuscles.length > 0 && photographedPattern) {
    for (const ex of day.exercises) {
      const exMuscles = musclesForSlug(ex.slug);
      const sameMuscle = exMuscles.some((m) => photographedMuscles.includes(m));
      const samePattern = patternForSlug(ex.slug) === photographedPattern;
      if (sameMuscle && samePattern) {
        return { kind: "substitute", prescribed: ex };
      }
    }
  }

  return { kind: "other" };
}

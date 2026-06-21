/**
 * injury-rules.ts — Shared injury → contraindicated-exercise knowledge.
 * Used by the response gate (conversational replies) and the programme
 * validator (workout delivery) so both reason about injuries identically.
 */

// Map of body-part token → exercise phrases that load/risk that part (lowercase).
export const INJURY_CONTRAINDICATIONS: Record<string, string[]> = {
  knee: ["squat", "lunge", "leg press", "leg extension", "jumping", "plyometric", "box jump", "step up", "step-up", "sprint", "running", "jogging", "bulgarian", "pistol squat"],
  back: ["deadlift", "bent over row", "bent-over row", "good morning", "sit-up", "sit up", "crunch", "roman chair", "back extension", "suitcase carry", "jefferson curl"],
  shoulder: ["overhead press", "shoulder press", "military press", "lateral raise", "front raise", "upright row", "arnold press", "clean and press", "pull-up", "chin-up", "dip"],
  hip: ["hip thrust", "squat", "lunge", "deadlift", "step up", "step-up", "leg press", "cable kickback"],
  ankle: ["jump", "jumping", "sprint", "sprinting", "box jump", "plyometric", "calf raise", "rope skipping"],
  wrist: ["push-up", "pushup", "bench press", "bicep curl", "wrist curl", "pull-up", "plank", "front rack", "clean"],
  neck: ["overhead press", "upright row", "neck curl", "neck extension"],
};

// Safe substitute exercises per body part (for suggesting alternatives).
export const INJURY_SAFE_ALTERNATIVES: Record<string, string[]> = {
  knee: ["leg curl", "glute bridge", "hip thrust (light)", "seated calf raise", "upper body work"],
  back: ["chest-supported row", "lat pulldown", "leg press (neutral)", "cable exercises", "machine work"],
  shoulder: ["neutral-grip press (light)", "cable lateral raise (light)", "face pull", "chest press (machine)"],
  hip: ["leg extension", "leg curl", "calf raise", "upper body work"],
  ankle: ["seated leg press", "leg curl", "upper body work", "cycling"],
  wrist: ["machine press", "neutral-grip work", "leg-focused training", "cable work with straps"],
  neck: ["machine chest press", "seated row", "leg work", "lat pulldown"],
};

// Extract body-part tokens from a free-text injury description.
export function extractBodyParts(injuries: string): string[] {
  const lower = injuries.toLowerCase();
  const parts: string[] = [];
  if (/knee|patella|acl|mcl|meniscus/i.test(lower)) parts.push("knee");
  if (/back|spine|lumbar|herniat|disc|sciatica|lower back|upper back/i.test(lower)) parts.push("back");
  if (/shoulder|rotator|cuff|labrum/i.test(lower)) parts.push("shoulder");
  if (/hip|iliopsoas|it band|iliotib/i.test(lower)) parts.push("hip");
  if (/ankle|achilles|plantar/i.test(lower)) parts.push("ankle");
  if (/wrist|carpal|forearm.*pain|tendon.*wrist/i.test(lower)) parts.push("wrist");
  if (/neck|cervical/i.test(lower)) parts.push("neck");
  return parts;
}

// Given a block of text (a workout or a reply) and a list of body parts,
// return a list of human-readable conflict strings.
export function checkExercisesAgainstInjuries(text: string, bodyParts: string[]): string[] {
  const lower = text.toLowerCase();
  const conflicts: string[] = [];
  for (const part of bodyParts) {
    const banned = INJURY_CONTRAINDICATIONS[part] || [];
    const found = banned.filter(ex => lower.includes(ex));
    if (found.length > 0) {
      conflicts.push(`loads ${part}: ${found.join(", ")}`);
    }
  }
  return conflicts;
}

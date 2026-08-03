// Onboarding intake parsers (2026-07-12) — pure, unit-tested helpers for the two new
// free-text questions Kam captures manually: foods loved/hated, and the 3-month dream +
// biggest struggle. Kept out of onboarding.ts so the parsing can be regression-tested
// (the onboarding state machine itself has no automated coverage, so the logic that
// interprets a client's own words must be locked here).

/** Split a "foods you love / can't stand" answer into likes and dislikes. Lenient: if
 *  the split is unclear, everything is treated as likes; "skip"/empty returns nulls. */
export function parseFoodPreferences(raw: string): { foodLikes: string | null; foodDislikes: string | null } {
  const t = (raw || "").trim();
  if (/^(skip|none|nothing|n\/?a|no)$/i.test(t) || t.length <= 1) return { foodLikes: null, foodDislikes: null };
  const dislikeMatch = t.match(/\b(can'?t stand|cannot stand|hate|don'?t (?:like|enjoy)|not a fan of|dislike|avoid)\b\s*[:\-]?\s*(.+)$/i);
  if (dislikeMatch) {
    const foodDislikes = dislikeMatch[2].trim().replace(/[.!]+$/, "") || null;
    const before = t.slice(0, dislikeMatch.index).trim();
    const foodLikes = before.replace(/\b(love|like|enjoy|favou?rites?|i eat|mostly)\b/gi, "").replace(/[,:\-\s]+$/, "").trim() || null;
    return { foodLikes, foodDislikes };
  }
  const foodLikes = t.replace(/^(i )?(love|like|enjoy|mostly eat|eat)\b\s*/i, "").trim() || t;
  return { foodLikes, foodDislikes: null };
}

/** Split a "3-month dream + biggest struggle" answer. The whole thing is the dream by
 *  default; if a struggle marker is present, that clause is captured separately too. */
export function parseVisionAnswer(raw: string): { dreamGoal: string | null; biggestStruggle: string | null } {
  const t = (raw || "").trim();
  let dreamGoal: string | null = t.length > 1 ? t : null;
  let biggestStruggle: string | null = null;
  const struggleMatch = t.match(/\b(struggle (?:with|is)|my (?:biggest )?(?:struggle|issue|problem|weakness)|hardest (?:part|thing)|i can'?t (?:stop|resist)|worst (?:habit|part))\b\s*[:\-]?\s*(.+)$/i);
  if (struggleMatch) {
    biggestStruggle = t.slice(struggleMatch.index).trim() || null;
    const dreamPart = t.slice(0, struggleMatch.index).trim().replace(/[.,:\-\s]+$/, "");
    if (dreamPart.length > 2) dreamGoal = dreamPart;
  }
  return { dreamGoal, biggestStruggle };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BULK INTAKE — one-paste onboarding (specced 2026-07-07, built 2026-08-03)
//
// A real client sent her ENTIRE intake as one colon-separated blob: name, age,
// weight, goal, dream range, equipment, occupation, experience, medical, meal
// pattern, dislikes, alcohol, start date. Thirteen facts in one message.
//
// The FSM read it as the answer to ONE question — her name — and then asked her
// the other twelve. That is the first impression, and it is the exact opposite of
// what this product claims: "you don't track, it remembers."
//
// Detection is deterministic and free. Extraction is one model call that only ever
// fires on a message that already looks like an intake blob, at most once per
// client, on their first real message. Everything fails OPEN: any wobble and the
// normal question-by-question flow runs, having lost nothing.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Does this look like someone's whole intake in one paste?
 *
 * Two gates, both needed. Length alone would catch any chatty first message; the
 * signal count alone would catch "I'm 29 and I want to lose fat". A blob is long
 * AND dense — several unrelated categories of fact in one breath.
 *
 * Tuned to REJECT: a food log ("I had eggs and pap for breakfast"), a long
 * complaint, a question about the programme. Those are the messages that would be
 * damaged by being read as an intake.
 */
export function looksLikeBulkIntake(raw: string): boolean {
  const t = (raw || "").trim();
  if (t.length <= 120) return false;
  let signals = 0;
  if (/\b[1-6]\d\b/.test(t)) signals++;                                              // an age-like number
  if (/\b\d{2,3}\s*kg\b/i.test(t)) signals++;                                        // a weight
  if (/\b(fat ?loss|lose (?:weight|fat)|muscle|gain|tone|slim|cut)\b/i.test(t)) signals++;
  if (/\b(gym|home|treadmill|trailmil|dumbbell|equipment|weights|no gym)\b/i.test(t)) signals++;
  if (/\b(medical|condition|injur|surgery|diabet|pressure|asthma|none)\b/i.test(t)) signals++;
  if ((t.match(/:/g) || []).length >= 4) signals++;                                  // the colon-blob shape
  if (/\b(beginner|intermediate|advanced|experience|never trained)\b/i.test(t)) signals++;
  return signals >= 3;
}

/** The fields a blob can fill. Everything optional — a blob rarely has all of them. */
export interface BulkIntake {
  name?: string; gender?: "male" | "female"; age?: number;
  weightKg?: number; heightCm?: number;
  goalType?: "fat_loss" | "muscle_gain"; targetWeightKg?: number;
  medicalConditions?: string; injuries?: string;
  gymName?: string; homeEquipment?: string; trainingExperience?: string;
  foodDislikes?: string; notes?: string;
}

/**
 * HALLUCINATION BRAKE — the same rule the normalizer runs on, for the same reason.
 *
 * A model asked to fill a schema will fill it. Invent a weight for someone who never
 * gave one and their calorie target is wrong from day one, silently, forever. So every
 * value has to be traceable to something the client actually typed: numbers must appear
 * as digits in the source, and free text must appear in it near-verbatim.
 *
 * Anything that fails is DROPPED, not corrected — the FSM will simply ask that question,
 * which is what would have happened anyway. Dropping is always safe; keeping is not.
 */
export function applyIntakeBrake(extracted: BulkIntake, source: string): BulkIntake {
  const src = (source || "").toLowerCase();
  const digitsPresent = (n: number | undefined) =>
    // Digit-boundary, not word-boundary: "90kg" has NO word boundary between 0 and k,
    // so \b would reject a weight the client plainly typed. Caught by the golden case.
    typeof n === "number" && Number.isFinite(n) && new RegExp(`(?<!\\d)${Math.round(n)}(?!\\d)`).test(src);
  const out: BulkIntake = {};

  // Numbers: the digits must be in the message. 90 for "90kg" is present; a BMI the
  // model worked out from height and weight is not, and must not be kept.
  if (digitsPresent(extracted.age) && extracted.age! >= 10 && extracted.age! <= 100) out.age = extracted.age;
  if (digitsPresent(extracted.weightKg) && extracted.weightKg! >= 30 && extracted.weightKg! <= 300) out.weightKg = extracted.weightKg;
  if (digitsPresent(extracted.heightCm) && extracted.heightCm! >= 100 && extracted.heightCm! <= 230) out.heightCm = extracted.heightCm;
  if (digitsPresent(extracted.targetWeightKg) && extracted.targetWeightKg! >= 30 && extracted.targetWeightKg! <= 300) out.targetWeightKg = extracted.targetWeightKg;

  // Enums: safe by construction — the value is one of two constants, and the words
  // behind it were tested by the detector. Gender is only kept when actually stated.
  if (extracted.goalType === "fat_loss" || extracted.goalType === "muscle_gain") out.goalType = extracted.goalType;
  if ((extracted.gender === "male" || extracted.gender === "female") && new RegExp(`\\b(${extracted.gender}|${extracted.gender === "male" ? "man|male|he" : "woman|female|she|lady"})\\b`, "i").test(src)) {
    out.gender = extracted.gender;
  }

  // Free text: must be lifted from the message, not composed. A single word is enough
  // to prove it (a name, "beginner", "dairy") — a whole sentence rarely survives
  // punctuation, so the test is on the longest word in the value.
  const lifted = (v: string | undefined): string | undefined => {
    const s = (v || "").trim();
    if (!s || s.length > 200) return undefined;
    const longest = s.toLowerCase().split(/[^a-z0-9]+/i).filter(w => w.length >= 3).sort((a, b) => b.length - a.length)[0];
    return longest && src.includes(longest) ? s : undefined;
  };
  for (const k of ["name", "medicalConditions", "injuries", "gymName", "homeEquipment", "trainingExperience", "foodDislikes", "notes"] as const) {
    const v = lifted(extracted[k] as string | undefined);
    if (v) (out as Record<string, unknown>)[k] = v;
  }
  // A name is one or two words, never a sentence — the commonest bad extraction is the
  // whole blob landing in `name`, which is the very bug this feature exists to fix.
  if (out.name && (out.name.length > 24 || out.name.split(/\s+/).length > 2)) delete out.name;

  return out;
}

/** Plain-language summary of what was understood — the client must SEE it to correct it. */
export function describeIntake(i: BulkIntake): string {
  const bits: string[] = [];
  if (i.name) bits.push(`Name: ${i.name}`);
  if (i.age) bits.push(`Age: ${i.age}`);
  if (i.gender) bits.push(`${i.gender === "male" ? "Male" : "Female"}`);
  if (i.weightKg) bits.push(`Weight: ${i.weightKg}kg`);
  if (i.heightCm) bits.push(`Height: ${i.heightCm}cm`);
  if (i.goalType) bits.push(`Goal: ${i.goalType === "fat_loss" ? "lose fat" : "build muscle"}`);
  if (i.targetWeightKg) bits.push(`Target: ${i.targetWeightKg}kg`);
  if (i.gymName) bits.push(`Gym: ${i.gymName}`);
  if (i.homeEquipment) bits.push(`At home: ${i.homeEquipment}`);
  if (i.trainingExperience) bits.push(`Experience: ${i.trainingExperience}`);
  if (i.medicalConditions) bits.push(`Medical: ${i.medicalConditions}`);
  if (i.injuries) bits.push(`Injuries: ${i.injuries}`);
  if (i.foodDislikes) bits.push(`Avoids: ${i.foodDislikes}`);
  return bits.map(b => `• ${b}`).join("\n");
}

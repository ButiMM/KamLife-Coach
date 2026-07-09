/**
 * PHYSIQUE ANALYSIS — read a client's baseline photos and name their LAGGING vs
 * DOMINANT muscle groups, so the coach can bring up the weak points (2026-07-09:
 * Kam's ask — "catch people's lagging body parts... adjust based on how they look,
 * male or female"). Distinct from the existing progress COMPARISON (change over time):
 * this assesses the physique ONCE, at the start, to steer programming.
 *
 * The vision call is deterministic-gated in media.ts; THIS module is the pure,
 * testable core — build the prompt, parse the model's answer into a validated,
 * canonical muscle-group list (hallucinations dropped), gender-aware fallback. The
 * model suggests; code decides what's stored. Never trusts free-form model output.
 */

// Canonical muscle groups we program around. Anything the model returns is normalised
// to one of these or dropped — no free-form body parts leak into the profile.
export const MUSCLE_GROUPS = [
  "chest", "back", "shoulders", "arms", "core", "glutes", "quads", "hamstrings", "calves",
] as const;
export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];

const SYNONYMS: Record<string, MuscleGroup> = {
  chest: "chest", pec: "chest", pecs: "chest", pectoral: "chest", pectorals: "chest",
  back: "back", lat: "back", lats: "back", "upper back": "back", "lower back": "back", traps: "back",
  shoulder: "shoulders", shoulders: "shoulders", delt: "shoulders", delts: "shoulders", deltoid: "shoulders", deltoids: "shoulders", "rear delts": "shoulders",
  arm: "arms", arms: "arms", bicep: "arms", biceps: "arms", tricep: "arms", triceps: "arms",
  core: "core", ab: "core", abs: "core", abdominals: "core", midsection: "core", stomach: "core", waist: "core",
  glute: "glutes", glutes: "glutes", butt: "glutes", bum: "glutes", buttocks: "glutes",
  quad: "quads", quads: "quads", quadriceps: "quads", "front thigh": "quads", "front thighs": "quads",
  hamstring: "hamstrings", hamstrings: "hamstrings", ham: "hamstrings", hams: "hamstrings", "rear thigh": "hamstrings", "back of legs": "hamstrings",
  calf: "calves", calves: "calves", calfs: "calves",
};

export type PhysiqueAnalysis = { dominant: MuscleGroup[]; lagging: MuscleGroup[]; note: string };

// Gender-aware fallback: what to prioritise when the photo read is inconclusive. A
// PRIOR only — it never overrides what the model actually saw, just fills a blank.
export function genderLaggingPriors(gender: string | null | undefined): MuscleGroup[] {
  return (gender || "").toLowerCase() === "female"
    ? ["glutes", "hamstrings", "shoulders"]
    : ["chest", "back", "shoulders"];
}

function normaliseToGroups(raw: string): MuscleGroup[] {
  const out: MuscleGroup[] = [];
  for (const piece of (raw || "").toLowerCase().split(/[,;/]+|\band\b/)) {
    const key = piece.trim().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
    if (!key) continue;
    const hit = SYNONYMS[key]
      // substring fallback: "your rear delts look small" → shoulders
      || (Object.keys(SYNONYMS).find(k => key.includes(k)) ? SYNONYMS[Object.keys(SYNONYMS).find(k => key.includes(k))!] : undefined);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * Build the vision prompt. Returns { system, user }. Gender + goal steer the read
 * without dictating it. The strict output contract is what makes the parse reliable.
 */
export function buildPhysiqueAnalysisPrompt(opts: { gender?: string | null; goal?: string | null; name?: string }): { system: string; user: string } {
  const gender = (opts.gender || "").toLowerCase() === "female" ? "female" : "male";
  const goalLabel = opts.goal === "fat_loss" ? "fat loss" : opts.goal === "muscle_gain" ? "muscle gain" : "body recomposition";
  const priors = genderLaggingPriors(gender).join(", ");
  return {
    system: `You are a physique-assessment coach with 20 years of experience reading bodies. You look at a client's photos and judge which muscle groups are DEVELOPED (dominant) and which are BEHIND (lagging), to steer their training. Be honest and specific but never unkind — this is programming, not judgement. Client is ${gender}, goal ${goalLabel}. Typical ${gender} priorities lean toward ${priors}, but judge what you actually SEE, not the stereotype.`,
    user: `Assess this ${gender} client's physique from the photo(s). Judge development across: chest, back, shoulders, arms, core, glutes, quads, hamstrings, calves.\n\nReply in EXACTLY this format, using only muscle-group names from that list, nothing else:\nDOMINANT: <comma-separated groups that are relatively well-developed>\nLAGGING: <comma-separated groups that are behind and should get priority volume>\nNOTE: <one short, kind sentence a coach would say>\n\nIf the photo is unclear (lighting, clothing, angle), still give your best read and say so briefly in NOTE. Never invent detail you cannot see.`,
  };
}

/**
 * Parse the model's answer into a validated, canonical result. Unknown/hallucinated
 * body parts are dropped. If nothing usable comes back for LAGGING, fall back to the
 * gender prior so the profile is never left blank. Caps each list so one over-eager
 * answer can't tag every muscle.
 */
export function parsePhysiqueAnalysis(raw: string, gender?: string | null): PhysiqueAnalysis {
  const text = raw || "";
  const grab = (label: string): string => {
    const m = text.match(new RegExp(`${label}\\s*:?\\s*(.+)`, "i"));
    return m ? m[1].trim() : "";
  };
  const dominant = normaliseToGroups(grab("DOMINANT")).slice(0, 4);
  let lagging = normaliseToGroups(grab("LAGGING")).filter(g => !dominant.includes(g)).slice(0, 4);
  if (lagging.length === 0) lagging = genderLaggingPriors(gender).filter(g => !dominant.includes(g)).slice(0, 3);
  let note = grab("NOTE").replace(/^["']|["']$/g, "").slice(0, 200);
  if (!note) note = "";
  return { dominant, lagging, note };
}

/**
 * A short, warm coach line summarising the plan focus — what to prioritise and, if we
 * saw a strong point, name it so it doesn't read as pure criticism.
 */
export function formatPhysiqueFocusLine(a: PhysiqueAnalysis): string {
  if (a.lagging.length === 0) return "";
  const lag = a.lagging.slice(0, 3).join(", ");
  const strong = a.dominant.length > 0 ? ` Your ${a.dominant.slice(0, 2).join(" and ")} ${a.dominant.length > 1 ? "are" : "is"} already a strong point.` : "";
  return `From your photos, the priority to bring up is your *${lag}* — we'll put the extra volume there.${strong}`;
}

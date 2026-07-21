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

// BODY-COMPOSITION STATE (2026-07-17, founder: "shouldn't we be using their pictures?
// ...before we put people on the wrong program"). The photo read now also classifies
// the overall body state, so the GOAL can be recommended from what the body actually
// shows — not from self-diagnosis ("I don't want to lose my curves") and not from a
// BMI the client can't provide because they don't know their height.
export type BodyState = "lean" | "average" | "overfat" | "skinny_fat" | "underweight" | "unknown";

export function parseBodyState(raw: string): BodyState {
  const m = (raw || "").match(/BODY\s*:?\s*(.+)/i);
  const s = (m ? m[1] : "").toLowerCase();
  if (!s) return "unknown";
  if (/skinny[\s-]?fat/.test(s)) return "skinny_fat";
  if (/underweight|too thin|very thin/.test(s)) return "underweight";
  if (/carrying (extra|excess) fat|overweight|obese|high body ?fat|overfat/.test(s)) return "overfat";
  if (/\blean\b|athletic|defined/.test(s)) return "lean";
  if (/\baverage\b|\bnormal\b|\bmoderate\b/.test(s)) return "average";
  return "unknown";
}

/**
 * Map what the photos SHOW to the goal the plan should serve. Returns null when the
 * client's own choice already fits (their choice wins every tie — this is an assist,
 * never an override; the client confirms before anything changes). The `reason` is
 * written to be SAID to the client — warm, shame-free, and it protects the thing
 * they're afraid of losing (the curves stay; the fat over them goes).
 */
export function recommendGoalFromRead(bodyState: BodyState, chosenGoal: string | null | undefined): { goal: string; reason: string } | null {
  const chosen = (chosenGoal || "fat_loss").toLowerCase();
  switch (bodyState) {
    case "underweight":
      return chosen === "muscle_gain" ? null : {
        goal: "muscle_gain",
        reason: "your photos show a frame that needs BUILDING first — cutting food now would cost you muscle and health, not fat. We fuel you up, lift, and build.",
      };
    case "overfat":
      return chosen === "fat_loss" ? null : {
        goal: "fat_loss",
        reason: "your photos show the muscle is there — it's covered. We lift heavy and keep protein high so your shape and curves STAY, while the fat over them comes off. That's how the shape you want gets revealed, not lost.",
      };
    case "skinny_fat":
      return chosen === "recomposition" ? null : {
        goal: "recomposition",
        reason: "your photos show a bit of both — not much muscle underneath, some fat on top. Pure cutting would leave you smaller, not better. We build muscle and drop fat at the same time: recomposition.",
      };
    case "lean":
      return chosen === "fat_loss" ? {
        goal: "recomposition",
        reason: "you're already lean — there isn't much fat left to lose, and dieting harder would just make you smaller. Building shape is the win from here: recomposition.",
      } : null;
    default:
      return null; // average / unreadable — the client's choice stands
  }
}

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
    user: `Assess this ${gender} client's physique from the photo(s). Judge development across: chest, back, shoulders, arms, core, glutes, quads, hamstrings, calves.\n\nReply in EXACTLY this format, using only muscle-group names from that list, nothing else:\nDOMINANT: <comma-separated groups that are relatively well-developed>\nLAGGING: <comma-separated groups that are behind and should get priority volume>\nBODY: <exactly one of: lean | average | carrying extra fat | skinny-fat | underweight>\nNOTE: <one short, kind sentence a coach would say>\n\nBODY is the overall body-composition state: "carrying extra fat" when fat clearly covers the frame, "skinny-fat" when there is little muscle AND soft fat, "underweight" when the frame is visibly too thin, "lean" when defined with low fat, "average" otherwise. If the photo is unclear (lighting, clothing, angle), still give your best read and say so briefly in NOTE. Never invent detail you cannot see.`,
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

/**
 * PROGRESS COMPARISON PROMPT — one call for the WHOLE photo set (2026-07-10: three
 * photos produced THREE separate essays, one comparing a FRONT baseline against a BACK
 * photo, another literally answering "I can't compare these directly, but here's a
 * general approach" — an essay of nothing — and recommending deadlifts/squats OFF the
 * machine-based basics-only programme). Pure and unit-tested so the constraints hold.
 */
export function buildProgressComparisonPrompt(opts: {
  clientName: string; goalLabel: string; weeksLabel: string; baselineCount: number; todayCount: number;
}): { system: string; user: string } {
  const { clientName, goalLabel, weeksLabel, baselineCount, todayCount } = opts;
  return {
    system: `You are Coach K, a South African fitness coach with 20 years of experience reading physiques. Client: ${clientName}. Goal: ${goalLabel}. Plain, warm, honest, specific — never a greeting like "Hello!" or "Let's take a look", never filler. You compare progress photos and tell the truth about what you see.`,
    user: `The FIRST ${baselineCount} image${baselineCount > 1 ? "s are" : " is"} the client's BASELINE set (taken ${weeksLabel} ago). The LAST ${todayCount} image${todayCount > 1 ? "s are" : " is"} TODAY'S set. The sets may include front, side and back angles — compare like angle with like angle, never a front against a back.

The client wants to be told WHAT changed, WHERE, and HOW MUCH to do next — concretely, not in vague coaching language. Give them exactly that, in this shape (keep the labels, keep it human and short):

*What's changed:* Name the SPECIFIC body parts and the SPECIFIC change on each — e.g. "shoulders look ~1cm wider and rounder", "waist is tighter, love-handles down", "arms fuller at the front". Two or three concrete observations. If you see little or no change, say so plainly — never invent progress.
*Focus area:* The ONE body part that's lagging behind the rest, named.
*This month's move:* ONE action with a NUMBER — never vague. Good: "add 2.5kg OR 1–2 reps to your main lifts this week", "push protein to 150g/day", "add ~200 kcal = one extra protein snack a day". BANNED: "increase slightly", "keep pushing", "eat a bit more", "significant improvement", "more defined" — every one of those must become a number or a named body part.

Rules: NEVER recommend new or different exercises (no "add deadlifts/squats") — the programme is fixed; progress comes from adding weight to the SAME lifts. Do NOT write a general-advice essay or say "I can't compare these directly, but here's a general approach" — you CAN read these photos; answer in the exact shape above. If lighting/angle genuinely blocks a fair read, say it in ONE line and ask for same pose + light next time. No greetings, no "keep it up!" spam.`,
  };
}

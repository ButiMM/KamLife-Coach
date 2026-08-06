/**
 * EXERCISE VARIANTS — the "which machine is this / show me the types" brain.
 *
 * The #1 question from clients without a personal trainer is NOT "how do I do a shoulder
 * press" — it's "WHICH of these machines IS the shoulder press, and how do I set it up?"
 * Every gym lays out and labels its kit differently (plate-loaded vs pin-stack, 45° sled
 * vs horizontal leg press, pec deck vs cable fly), so a single canonical demo image isn't
 * enough. This module groups every movement KamLife prescribes into a FAMILY, and for each
 * family lists the real-world variants a SA gym-goer will actually stand in front of, with:
 *   • "spot it"  — how to recognise that machine on the gym floor
 *   • "how to"   — a one-line execution cue
 *
 * It mirrors the food system's shape: a deterministic catalogue for the known (closed) set
 * of programme movements; anything off-catalogue simply isn't matched here and falls through
 * to the GPT handler at the end of the pipeline.
 *
 * Two entry points feed off it:
 *   1. "show me shoulder press" / "types of leg press" / "which machine is the row"
 *      → matchVariantGuideRequest() → formatVariantGuide()   (handlers/misc-commands.ts)
 *   2. A photographed machine → variantGuideHint(slug) appends "see every type" to the reply
 *      (handlers/media.ts, coachGymMachineFromPhoto)
 *
 * A request that explicitly wants the FORM PICTURE ("shoulder press form") is deliberately
 * NOT matched here — it contains "form"/"pic"/"gif" and falls to the single-image demo, so
 * the guide can safely say "reply *shoulder press form* for the picture" without looping.
 */

import { getExerciseGifUrl } from "./exercise-media";

export interface ExerciseVariant {
  /** Variant name, ALWAYS leading with the equipment so the spoken form is unambiguous. */
  name: string;
  /** How to recognise this machine/setup on the gym floor. */
  spot: string;
  /** One-line execution cue. */
  howTo: string;
}

interface MovementFamily {
  /** Display title, e.g. "Shoulder Press". */
  title: string;
  /** Short muscle descriptor shown in the header. */
  muscle: string;
  /** Generic phrases (NO equipment qualifier) that should open this guide. */
  match: string[];
  /** Slugs (exercise-media keys) that belong to this family — used to map a photographed machine back to its guide. */
  slugs: string[];
  /** Representative slug for the single image attached to the guide. */
  repImageSlug: string;
  variants: ExerciseVariant[];
  /** Optional closing reassurance; a sensible default is generated if omitted. */
  note?: string;
}

// ── The catalogue ─────────────────────────────────────────────────────────────
// One family per movement KamLife prescribes. Keep variants to the handful a SA gym
// actually has, equipment-led names, one line each.

export const MOVEMENT_FAMILIES: Record<string, MovementFamily> = {
  "shoulder-press": {
    title: "Shoulder Press",
    muscle: "shoulders + triceps",
    match: ["shoulder press", "shoulder presses", "overhead press", "over head press", "ohp", "military press"],
    slugs: ["shoulder-press"],
    repImageSlug: "shoulder-press",
    variants: [
      { name: "Machine shoulder press", spot: "A seat with two handles up at shoulder height that you push straight UP overhead. Plate-loaded or a pin stack.", howTo: "Set the seat so the handles start at your shoulders. Press up to nearly straight, lower slow." },
      { name: "Dumbbell shoulder press", spot: "Sat on an upright bench, a dumbbell in each hand at shoulder height.", howTo: "Press both overhead without clashing them. Keep your ribs down — don't arch your back." },
      { name: "Barbell overhead press", spot: "Standing with a barbell at your collarbone, often inside the squat rack.", howTo: "Brace hard, squeeze your glutes, press the bar past your forehead to lockout." },
      { name: "Smith machine press", spot: "The bar runs on fixed rails — slide a bench or stool under it.", howTo: "The rails balance the bar for you. Press to full lockout, control the way down." },
    ],
  },

  "leg-press": {
    title: "Leg Press",
    muscle: "quads + glutes",
    match: ["leg press", "leg presses"],
    slugs: ["leg-press", "hack-squat"],
    repImageSlug: "leg-press",
    variants: [
      { name: "45° angled (sled) leg press", spot: "You sit low and push a platform UP a slanted rail; plates load onto the sled.", howTo: "Feet mid-platform, shoulder-width. Lower until your knees come toward your chest. Drive through your heels." },
      { name: "Horizontal / seated leg press", spot: "You sit upright and push the platform straight FORWARD; the weight is a stack.", howTo: "Same job as the sled. Full range, keep a slight knee bend at the end — never slam straight." },
      { name: "Hack squat", spot: "You stand on a foot platform with shoulder pads, sliding up and down a slanted rail.", howTo: "Shoulders under the pads, back flat. Squat deep, drive through your heels." },
      { name: "Single-leg press", spot: "Any of the above with just one foot on the platform.", howTo: "Best for evening out a stronger/weaker side. Slow and controlled." },
    ],
  },

  "chest-press": {
    title: "Chest Press",
    muscle: "chest + triceps",
    match: ["chest press", "chest presses", "bench press", "bench", "pec press"],
    slugs: ["chest-press", "barbell-bench-press", "incline-dumbbell-press", "dumbbell-floor-press"],
    repImageSlug: "chest-press",
    variants: [
      { name: "Machine chest press", spot: "A seat with two handles at chest height that you push FORWARD. Plate-loaded or a stack.", howTo: "Seat it so the handles line up with the middle of your chest. Press to full reach, slow back." },
      { name: "Dumbbell bench press", spot: "Lying on a flat bench, a dumbbell in each hand.", howTo: "Elbows ~45° from your body. Press up without clashing the dumbbells. Control down." },
      { name: "Barbell bench press", spot: "A flat bench under a barbell rack.", howTo: "Bar to mid-chest, elbows tucked ~45°. Drive up to lockout. Use a spotter when heavy." },
      { name: "Incline press (machine or dumbbell)", spot: "A bench tilted up to 30–45°.", howTo: "Hits the upper chest. Press up and slightly in. Full range." },
    ],
  },

  "row": {
    title: "Row (back)",
    muscle: "back + biceps",
    match: ["row", "rows", "seated row", "back row", "mid back row", "low row"],
    slugs: ["seated-row", "barbell-row", "bent-over-row", "single-arm-row", "chest-supported-row"],
    repImageSlug: "seated-row",
    variants: [
      { name: "Seated cable row", spot: "Sit facing a low pulley, feet on the plate, and pull a handle to your stomach.", howTo: "Chest up, pull to your belly button, squeeze your shoulder blades. Don't rock backward." },
      { name: "Chest-supported machine row", spot: "Lie chest-first against a pad and pull two handles back.", howTo: "The pad takes your lower back out of it. Drive your elbows back and squeeze." },
      { name: "Single-arm dumbbell row", spot: "One knee and one hand on a bench, a dumbbell in the other hand.", howTo: "Pull the dumbbell to your hip. Squeeze, lower slow, keep your back flat." },
      { name: "Barbell / T-bar row", spot: "Bent over a barbell, or a bar anchored in a corner.", howTo: "Hinge with a flat back, pull to your lower ribs, squeeze your shoulder blades." },
    ],
  },

  "lat-pulldown": {
    title: "Lat Pulldown",
    muscle: "back (lats) + biceps",
    match: ["lat pulldown", "lat pull down", "pulldown", "pull down", "lat pull"],
    slugs: ["lat-pulldown"],
    repImageSlug: "lat-pulldown",
    variants: [
      { name: "Wide-grip lat pulldown", spot: "Sit under a high bar, thighs under the pads, and pull the wide bar down.", howTo: "Pull the bar to your upper chest, drive your elbows down to your pockets. Don't swing." },
      { name: "Close / neutral-grip pulldown", spot: "The same machine with a narrow V-handle or close grip.", howTo: "More biceps and lower lat. Same cue — elbows to pockets, squeeze." },
      { name: "Assisted pull-up machine", spot: "A platform you kneel on that helps lift your bodyweight up to a bar.", howTo: "Great while you build strength. Full hang at the bottom, chin over the bar." },
    ],
    note: "These all train the same pull. Use whichever your gym has — the grip is your choice.",
  },

  "leg-curl": {
    title: "Leg Curl (hamstrings)",
    muscle: "hamstrings",
    match: ["leg curl", "leg curls", "hamstring curl", "ham curl", "hamstring curls"],
    slugs: ["leg-curl"],
    repImageSlug: "leg-curl",
    variants: [
      { name: "Lying leg curl", spot: "Lie face-down, the pad rests on the back of your ankles.", howTo: "Curl your heels to your glutes, hips pinned down. Slow on the way back." },
      { name: "Seated leg curl", spot: "Sit upright, a pad pushes down on your shins, you curl underneath.", howTo: "Curl down hard, squeeze the hamstring, control the return." },
      { name: "Standing leg curl", spot: "Stand and curl one leg at a time against a pad.", howTo: "One leg at a time. Keep your hips still — only the knee bends." },
    ],
  },

  "leg-extension": {
    title: "Leg Extension (quads)",
    muscle: "quads",
    match: ["leg extension", "leg extensions", "quad extension", "knee extension"],
    slugs: ["leg-extension"],
    repImageSlug: "leg-extension",
    variants: [
      { name: "Seated leg extension machine", spot: "Sit back, a pad rests on your lower shins, you straighten your legs up.", howTo: "Pad just above the ankles. Straighten fully, squeeze the quad, lower over 2 seconds." },
      { name: "Single-leg extension", spot: "The same machine, one leg at a time.", howTo: "Fixes a weaker side. Same squeeze, no swinging." },
    ],
    note: "Pretty much one machine everywhere — the main thing is setting the seat and shin pad right.",
  },

  "lateral-raise": {
    title: "Lateral Raise (side delts)",
    muscle: "shoulders (side)",
    match: ["lateral raise", "lateral raises", "side raise", "side raises", "side delt raise"],
    slugs: ["lateral-raise"],
    repImageSlug: "lateral-raise",
    variants: [
      { name: "Dumbbell lateral raise", spot: "Standing with a light dumbbell in each hand at your sides.", howTo: "Slight elbow bend, raise to shoulder height only. Lead with your elbows, no swinging." },
      { name: "Cable lateral raise", spot: "Stand side-on to a low pulley, the handle in your far hand.", howTo: "Constant tension the whole way. Raise to shoulder height, lower slow." },
      { name: "Machine lateral raise", spot: "Sit with pads against your outer arms and lift outward.", howTo: "The pads guide the path. Raise to shoulder height, controlled down." },
    ],
    note: "Go lighter than you think — this is a small muscle. Form beats weight every time here.",
  },

  "bicep-curl": {
    title: "Bicep Curl",
    muscle: "biceps",
    match: ["bicep curl", "bicep curls", "biceps curl", "curl", "curls", "arm curl"],
    slugs: ["bicep-curl", "cable-bicep-curl"],
    repImageSlug: "bicep-curl",
    variants: [
      { name: "Dumbbell curl", spot: "A dumbbell in each hand, standing or seated.", howTo: "Elbows pinned at your sides. Curl up, squeeze, lower slow. Don't swing." },
      { name: "Cable curl", spot: "Standing at a low pulley with a bar or rope handle.", howTo: "Constant tension. Elbows still, curl up to your shoulders." },
      { name: "EZ-bar / barbell curl", spot: "A short wavy bar (or straight barbell) loaded with plates.", howTo: "Elbows pinned. Curl up without rocking your back. Control down." },
      { name: "Preacher / machine curl", spot: "Arms rest over a slanted pad, or a seated curl machine.", howTo: "The pad stops you cheating. Full stretch at the bottom, squeeze at the top." },
    ],
  },

  "tricep-pushdown": {
    title: "Tricep Pushdown / Extension",
    muscle: "triceps",
    match: ["tricep pushdown", "triceps pushdown", "tricep push down", "pushdown", "push down", "tricep extension", "triceps extension", "tricep", "triceps"],
    slugs: ["tricep-pushdown", "tricep-overhead-extension", "tricep-kickback", "chair-tricep-dip"],
    repImageSlug: "tricep-pushdown",
    variants: [
      { name: "Cable pushdown (rope or bar)", spot: "Stand at a high pulley and push a rope or bar down.", howTo: "Elbows pinned tight at your sides — only the forearms move. Lock out, squeeze." },
      { name: "Overhead cable/dumbbell extension", spot: "A cable from the top behind your head, or one dumbbell held overhead.", howTo: "Elbows point up and stay still. Lower behind your head, extend to straight." },
      { name: "Dip machine", spot: "Seated, you push two handles down until your arms straighten.", howTo: "Keep it on the triceps. Full lockout, slow return." },
    ],
    note: "Whatever you use, the elbow stays still — only the forearm moves.",
  },

  "hip-thrust": {
    title: "Hip Thrust / Glute Bridge",
    muscle: "glutes",
    match: ["hip thrust", "hip thrusts", "glute bridge", "glute bridges", "glute thrust", "bridge"],
    slugs: ["hip-thrust", "glute-bridge"],
    repImageSlug: "hip-thrust",
    variants: [
      { name: "Barbell hip thrust", spot: "Upper back on a bench, a padded barbell across your hips.", howTo: "Drive your hips up, squeeze your glutes hard for 1 sec at the top. Chin tucked, ribs down." },
      { name: "Hip thrust machine", spot: "Sit with a pad across your hips/lap and push your hips forward.", howTo: "Easier to set up than a barbell. Full squeeze at the top, slow return." },
      { name: "Glute bridge (floor)", spot: "Lie on the floor, feet flat — no equipment needed.", howTo: "Same movement, smaller range. Squeeze hard at the top. Perfect at home." },
      { name: "Single-leg hip thrust / bridge", spot: "Any of the above with one foot down and the other leg out straight.", howTo: "Doubles the load on each glute. Keep your hips level." },
    ],
  },

  "calf-raise": {
    title: "Calf Raise",
    muscle: "calves",
    match: ["calf raise", "calf raises", "calf", "calves"],
    slugs: ["calf-raise", "seated-calf-raise"],
    repImageSlug: "calf-raise",
    variants: [
      { name: "Standing calf raise (machine)", spot: "Stand with your shoulders under pads, balls of your feet on a step, and raise your heels.", howTo: "Full range — heels drop low, rise all the way onto your toes. Pause at the top." },
      { name: "Seated calf raise (machine)", spot: "Sit with a pad over your knees, the balls of your feet on a platform.", howTo: "Hits the lower calf. Same full range, pause at the top, no bouncing." },
      { name: "Leg-press calf raise", spot: "On the leg press, put just the balls of your feet on the bottom of the platform.", howTo: "Push through the balls of your feet — full stretch and squeeze. No knee bend." },
    ],
  },

  "chest-fly": {
    title: "Chest Fly",
    muscle: "chest",
    match: ["chest fly", "chest flys", "chest flyes", "pec fly", "pec deck", "fly", "flyes", "flys"],
    slugs: ["chest-fly"],
    repImageSlug: "chest-fly",
    variants: [
      { name: "Pec deck (machine fly)", spot: "Sit with your forearms or hands on two pads/handles and squeeze them together in front.", howTo: "Slight elbow bend held throughout. Squeeze your chest, slow on the way open." },
      { name: "Cable fly", spot: "Two pulleys, a handle in each hand, sweeping them together.", howTo: "Wide arc, slight elbow bend. Squeeze in the middle, control the stretch." },
      { name: "Dumbbell fly", spot: "Lie on a bench, a dumbbell in each hand, open and close in an arc.", howTo: "Keep the arc — don't press. Feel the stretch, don't let your arms drop too far." },
    ],
  },

  "face-pull": {
    title: "Face Pull / Rear Delt",
    muscle: "rear shoulders + upper back",
    match: ["face pull", "face pulls", "rear delt", "rear delts", "rear delt fly", "upper back row"],
    slugs: ["face-pull"],
    repImageSlug: "face-pull",
    variants: [
      { name: "Cable face pull (rope)", spot: "A rope on a pulley at head height that you pull toward your face.", howTo: "Elbows high and wide, pull to your forehead, squeeze your rear delts. Light weight." },
      { name: "Reverse pec deck", spot: "Sit facing INTO the pec deck and push the handles BACKWARD.", howTo: "Squeeze your shoulder blades, lead with your elbows. Slow return." },
      { name: "Bent-over rear delt raise", spot: "Hinge forward with light dumbbells and raise them out to the sides.", howTo: "Soft elbows, raise to shoulder height, squeeze. No momentum." },
    ],
    note: "Always light — these little muscles never need heavy weight.",
  },

  "rdl": {
    title: "Romanian Deadlift (RDL)",
    muscle: "hamstrings + glutes",
    match: ["rdl", "romanian deadlift", "romanian dead lift", "stiff leg deadlift", "hip hinge", "hinge", "deadlift"],
    slugs: ["rdl"],
    repImageSlug: "rdl",
    variants: [
      { name: "Barbell RDL", spot: "Standing holding a barbell, hinging it down your thighs.", howTo: "Push your hips BACK, not down. Flat back, bar close to your legs. Stretch, then drive hips forward." },
      { name: "Dumbbell RDL", spot: "A dumbbell in each hand, the same hip hinge.", howTo: "Same movement, easier on the lower back. Feel the hamstring stretch, squeeze the glutes up." },
      { name: "Single-leg RDL", spot: "One dumbbell, balancing on one leg, hinging forward.", howTo: "Great for balance and glutes. Keep your hips square, move slow." },
    ],
    note: "This is a HINGE, not a squat — hips go back, knees stay soft.",
  },

  "squat": {
    title: "Squat",
    muscle: "quads + glutes",
    match: ["squat", "squats", "back squat"],
    slugs: ["squat", "smith-squat", "barbell-back-squat", "goblet-squat"],
    repImageSlug: "squat",
    variants: [
      { name: "Smith machine squat", spot: "The bar fixed on rails — step under it, bar on your upper back.", howTo: "The rails guide the path. Feet slightly forward, squat to parallel, drive through your heels." },
      { name: "Barbell back squat", spot: "The bar on your upper back, taken from a squat rack.", howTo: "Feet shoulder-width, brace, squat to parallel, chest up, drive up through your heels." },
      { name: "Goblet squat", spot: "Holding one dumbbell or kettlebell at your chest.", howTo: "Beginner-friendly. Squat down between your knees, chest tall, heels planted." },
      { name: "Hack squat", spot: "Shoulder pads on a slanted sled you push up with your legs.", howTo: "Back flat on the pad, squat deep, drive through your heels." },
    ],
  },
};

// ── Matching ──────────────────────────────────────────────────────────────────

// Equipment words that name a SPECIFIC variant. If the phrase contains one of these the
// client has already named the machine they mean, so we send the single-image demo, not
// the whole menu. ("machine shoulder press" → one picture; "shoulder press" → the menu.)
const SPECIFIC_QUALIFIER = /\b(machine|machines|dumbbell|dumbbells|db|cable|cables|smith|barbell|bb|hack|goblet|sumo|bulgarian|preacher|hammer|romanian|assisted|kettlebell|ez[\s-]?bar|t[\s-]?bar|landmine|resistance band|band)\b/;

/**
 * Resolve a GENERIC movement phrase to a family key, or null. Returns null when the phrase
 * names a specific equipment variant (so the single-image demo handles it instead).
 */
export function resolveMovementFamily(phrase: string | null | undefined): string | null {
  if (!phrase) return null;
  const clean = phrase.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length < 3) return null;
  if (SPECIFIC_QUALIFIER.test(clean)) return null;
  const padded = ` ${clean} `;
  for (const [key, fam] of Object.entries(MOVEMENT_FAMILIES)) {
    for (const kw of fam.match) {
      if (padded.includes(` ${kw} `)) return key;
    }
  }
  return null;
}

/** Extract the exercise phrase from a "show me X" / "how to do X" / "X form" message. Mirrors the demo handler. */
function extractDemoPhrase(m: string): string | null {
  let d = (
    m.match(/^(?:can\s+you\s+|could\s+you\s+|please\s+)?show\s+(?:me\s+)?(.+?)$/i)?.[1] ||
    m.match(/^how\s+(?:to|do\s+(?:i|you))\s+(.+?)$/i)?.[1] ||
    m.match(/^demo(?:nstrate)?\s+(.+?)$/i)?.[1] ||
    m.match(/^what\s+(?:does|do)\s+(?:a\s+|an\s+|the\s+)?(.+?)\s+look\s+like\b.*$/i)?.[1] ||
    m.match(/^(.+?)\s+(?:form|technique|demo)$/i)?.[1]
  )?.trim().toLowerCase();
  if (!d) return null;
  d = d
    .replace(/^(?:how\s+to\s+(?:do\s+)?|do\s+(?:a\s+)?|a\s+|an\s+|the\s+)/i, "")
    .replace(/\s+(?:please|exercise|movement|properly|correctly|for\s+me)$/i, "")
    .replace(/^(?:a\s+|an\s+|the\s+)/i, "")
    .trim();
  return d || null;
}

/**
 * Decide whether a message is asking for the VARIANTS MENU, returning the family key or null.
 * Handles both "show me <generic movement>" and explicit "types of / which machine is / <movement>
 * options" phrasings. Returns null if the message wants a form PICTURE (so the demo handler owns it).
 */
export function matchVariantGuideRequest(message: string): string | null {
  if (!message) return null;
  const m = message.toLowerCase().replace(/[?.!,]/g, " ").replace(/\s+/g, " ").trim();
  if (!m) return null;

  // An explicit form-picture request belongs to the single-image demo, not the menu.
  if (/\b(form|technique|pic|picture|gif|image|photo)\b/.test(m)) return null;

  const hasTypeWord = /\b(types?|kinds?|variations?|variants?|variety|options?|different|which|what\s+kind|what\s+machine|what\s+sort)\b/.test(m);
  const hasMovementWord = /\b(press(?:es)?|rows?|curls?|raises?|pulldowns?|pull\s?downs?|squats?|extensions?|flys?|flyes?|flies|kickbacks?|thrusts?|deadlifts?|rdl|pushdowns?|push\s?downs?|calf|calves|lunges?|bridges?|hinges?)\b/.test(m);

  // "types of shoulder press", "shoulder press options", "which machine is the row"
  if (hasTypeWord && hasMovementWord) {
    const stripped = m
      .replace(/\b(can|you|could|please|show|me|give|tell|the|a|an|all|every|do|i|use|using|for|to|of|is|are|there|in|my|at|on|with|should|gym)\b/g, " ")
      .replace(/\b(types?|kinds?|variations?|variants?|variety|options?|different|which|what|kind|sort|equipment|available|exist)\b/g, " ")
      .replace(SPECIFIC_QUALIFIER, " ")
      .replace(/\s+/g, " ").trim();
    const fam = resolveMovementFamilyFromTokens(stripped);
    if (fam) return fam;
  }

  // Plain "show me <generic movement>" → menu (resolveMovementFamily guards specific variants)
  const demo = extractDemoPhrase(m);
  if (demo) {
    const fam = resolveMovementFamily(demo);
    if (fam) return fam;
  }
  return null;
}

/**
 * Like resolveMovementFamily but assumes qualifiers are already stripped — matches a family
 * if ANY of its keywords appears as a token-bounded substring of the remaining text.
 */
function resolveMovementFamilyFromTokens(text: string): string | null {
  if (!text || text.length < 3) return null;
  const padded = ` ${text} `;
  for (const [key, fam] of Object.entries(MOVEMENT_FAMILIES)) {
    for (const kw of fam.match) {
      if (padded.includes(` ${kw} `)) return key;
    }
  }
  return null;
}

// ── Reverse map: photographed-machine slug → family key ───────────────────────
const SLUG_TO_FAMILY: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [key, fam] of Object.entries(MOVEMENT_FAMILIES)) {
    for (const slug of fam.slugs) {
      if (!map[slug]) map[slug] = key; // first family wins on overlap
    }
  }
  return map;
})();

/** Family key for a photographed-machine slug, or null. */
export function familyForSlug(slug: string | null | undefined): string | null {
  return slug ? (SLUG_TO_FAMILY[slug] || null) : null;
}

/**
 * A one-line "see every type" hint to append to a photographed-machine reply, or "" if the
 * machine's movement has no multi-variant guide worth offering.
 */
export function variantGuideHint(slug: string | null | undefined): string {
  const key = familyForSlug(slug);
  if (!key) return "";
  const fam = MOVEMENT_FAMILIES[key];
  if (!fam || fam.variants.length < 2) return "";
  const cmd = fam.match[0]; // generic phrase, e.g. "shoulder press"
  return `🔁 Different machine at your gym? Reply *${cmd} options* to see every type and how to spot yours.`;
}

// ── Formatting ────────────────────────────────────────────────────────────────
const NUM = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];

/** Build the WhatsApp-ready variant menu for a family key, or "" if unknown. */
export function formatVariantGuide(key: string): string {
  const fam = MOVEMENT_FAMILIES[key];
  if (!fam) return "";
  const body = fam.variants.map((v, i) =>
    `${NUM[i] || `${i + 1}.`} *${v.name}*\n   📍 _Spot it:_ ${v.spot}\n   ▶️ _Do it:_ ${v.howTo}`
  ).join("\n\n");
  const note = fam.note || `Your plan just says "${fam.title.toLowerCase()}" — any ONE of these counts. Use whichever your gym has.`;
  // ONE closing offer, not two (2026-08-06 path sweep). This ended with a photo prompt AND a
  // "reply X form" prompt stacked on each other — two calls to action under a list the client
  // is still reading. The photo one is the better help, so it is the one that stays.
  let out = `*${fam.title} — which one is in your gym?*\n_${fam.muscle}_\n\n${body}\n\n✅ ${note}\n\n`
    + `📸 Not sure which yours is? Snap the machine and send it — I'll confirm it's right for today.`;
  const img = getExerciseGifUrl(fam.repImageSlug);
  if (img) out += `\n[MEDIA:${img}]`;
  return out;
}

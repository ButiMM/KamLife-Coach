/**
 * HOME / TRAVEL WORKOUT BUILDER — turn "here's the equipment I've got" into a full session.
 *
 * (2026-07-22, Kam, from his real manual-coaching chats: a client photographs their kit —
 * two dumbbells, a barbell, a band — or they're on holiday and switching mid-journey. The old
 * flow saw the photo and asked them to TYPE "dumbbells / bands / mix" — pure friction when the
 * photo already showed it. This builds an adapted full-body session from the equipment we can
 * SEE, immediately, with a line of education so they trust that a home setup is enough.)
 *
 * PURE: equipment tags + user goal in, a ready-to-send WhatsApp workout out. The vision layer
 * (equipment-vision.ts) turns the photo into the tag list; everything here is deterministic and
 * unit-tested, so the session a client gets never depends on a model call being up.
 */

import { getGoalProfile } from "./goal-profiles";

export type EquipTag = "dumbbells" | "barbell" | "kettlebell" | "bands" | "bench" | "pullup_bar" | "bodyweight";

const ALL_TAGS: EquipTag[] = ["dumbbells", "barbell", "kettlebell", "bands", "bench", "pullup_bar", "bodyweight"];

// Word tells for each tag — matched against a vision description OR a client's caption. Generous
// on synonyms (SA clients say "weights", "dumbells" misspelled, "pull up bar"). Bodyweight is the
// floor: it's always available, so a photo of an empty room or a mat still yields a real session.
const TAG_RE: Record<Exclude<EquipTag, "bodyweight">, RegExp> = {
  dumbbells: /\bdumb(?:b)?ells?\b|\bdb\b|\bhand ?weights?\b/i,
  barbell: /\bbar ?bells?\b|\bolympic bar\b|\bez bar\b|\bloaded bar\b/i,
  kettlebell: /\bkettle ?bells?\b|\bkb\b/i,
  bands: /\b(resistance )?bands?\b|\bloop band\b|\btheraband\b/i,
  bench: /\b(weight |flat |adjustable |incline )?bench\b/i,
  pullup_bar: /\bpull[- ]?up bar\b|\bchin[- ]?up bar\b|\bdoor(?:way)? bar\b/i,
};

/**
 * Extract the available equipment from a vision description or a client caption.
 * Always includes "bodyweight" (the floor). De-duped, in a stable order for readable output.
 */
export function parseEquipment(text: string): EquipTag[] {
  const t = text || "";
  const found = new Set<EquipTag>(["bodyweight"]);
  (Object.keys(TAG_RE) as Array<Exclude<EquipTag, "bodyweight">>).forEach(tag => {
    if (TAG_RE[tag].test(t)) found.add(tag);
  });
  return ALL_TAGS.filter(tag => found.has(tag));
}

/** True when the client has some external load (not bodyweight-only) — changes the framing. */
function hasLoad(items: EquipTag[]): boolean {
  return items.some(i => i === "dumbbells" || i === "barbell" || i === "kettlebell" || i === "bands");
}

type Move = { name: string; how?: string };

// Pick the best movement we can do for each pattern, given what's available. Order of preference
// runs from most-loaded (best stimulus) down to bodyweight (always possible), so a client with
// dumbbells AND a bench gets a bench press, while an empty room still gets a real push-up.
function squat(i: EquipTag[]): Move {
  if (i.includes("dumbbells") || i.includes("kettlebell")) return { name: "Goblet squat", how: "hold one weight at your chest, sit down between your knees, chest tall" };
  if (i.includes("barbell")) return { name: "Barbell squat", how: "bar on your back, sit down and drive up through your heels" };
  if (i.includes("bands")) return { name: "Banded squat", how: "stand on the band, hold the top at your shoulders, squat against the tension" };
  return { name: "Bodyweight squat", how: "slow down, pause at the bottom, squeeze up — add a jump to make it harder" };
}
function hinge(i: EquipTag[]): Move {
  if (i.includes("dumbbells") || i.includes("kettlebell") || i.includes("barbell")) return { name: "Romanian deadlift (RDL)", how: "soft knees, push hips back, feel the hamstrings, stand tall" };
  if (i.includes("bands")) return { name: "Banded good-morning", how: "band on your shoulders, hinge at the hips, back flat" };
  return { name: "Single-leg glute bridge", how: "one foot down, drive the hips up, squeeze the glute at the top" };
}
function push(i: EquipTag[]): Move {
  if (i.includes("bench") && i.includes("dumbbells")) return { name: "Dumbbell bench press", how: "lower to your chest, press up and slightly together" };
  if (i.includes("bench") && i.includes("barbell")) return { name: "Barbell bench press", how: "lower to your chest with control, press up" };
  if (i.includes("dumbbells")) return { name: "Floor press / shoulder press", how: "press the weights up overhead or off the floor — full lockout" };
  if (i.includes("bands")) return { name: "Banded push-up / press", how: "band across your back for the push-up, or press it overhead" };
  return { name: "Push-up", how: "chest to the floor, body in a straight line — go to your knees if you need to" };
}
function pull(i: EquipTag[]): Move {
  if (i.includes("pullup_bar")) return { name: "Pull-up / assisted pull-up", how: "full hang to chin over the bar — use a band or your feet to assist" };
  if (i.includes("dumbbells") || i.includes("kettlebell")) return { name: "Bent-over row", how: "hinge forward, pull the weights to your ribs, squeeze the back" };
  if (i.includes("bands")) return { name: "Banded row", how: "anchor the band in a door, pull to your ribs, squeeze the shoulder blades" };
  return { name: "Table row / towel row", how: "lie under a sturdy table and pull your chest up to the edge" };
}
function core(): Move {
  return { name: "Plank", how: "straight line head to heels, brace hard, breathe — hold for time" };
}

interface HomeSets { work: string; note: string; steps?: string }
// Sets/reps + the goal's one-line 'why'. Macro goals differ in intent (burn vs build); wellness
// keeps it light and habit-first. Never invents targets — just how to run the same movements.
function setsForGoal(goalType: string | null | undefined): HomeSets {
  const profile = getGoalProfile(goalType);
  if (profile.energyStance === "surplus") { // muscle gain
    return { work: "4 rounds: 8–12 reps each, resting 60–90s between moves", note: "Push the last 2 reps — that's where the muscle is built. Leave nothing easy." };
  }
  if (profile.usesMacros) { // fat loss / recomp
    return { work: "3–4 rounds: 12–15 reps each, moving between moves with little rest", note: "Keep it flowing — short rests keep the heart rate up and burn more.", steps: "Finish with a 20-minute walk if you can — easy way to add to the burn." };
  }
  // wellness / general — gentle, confidence-first
  return { work: "2–3 rounds: 10–12 reps each, resting as long as you need", note: "No rush. Good form beats heavy — you're building the habit first." };
}

/**
 * Build a full-body home/travel session from the available equipment and the client's goal.
 * Frictionless by design: names what we can see, gives the exact moves + how-to + sets, and one
 * line of education so they trust that this setup is enough. Returns a single WhatsApp message.
 */
export function buildHomeSession(items: EquipTag[], user: any): string {
  const list = items.length ? items : (["bodyweight"] as EquipTag[]);
  const moves: Move[] = [squat(list), hinge(list), push(list), pull(list), core()];
  const sets = setsForGoal(user?.goalType);

  const nice = (t: EquipTag) => t === "pullup_bar" ? "a pull-up bar" : t === "bodyweight" ? "" : t;
  const gear = list.filter(t => t !== "bodyweight").map(nice);
  const firstName = user?.name ? String(user.name).split(" ")[0] : "";
  const seen = gear.length
    ? `I can see you've got *${gear.join(", ")}* — that's plenty.`
    : `No equipment needed — your bodyweight is enough.`;
  const teach = hasLoad(list)
    ? "You don't need a full gym to train everything. This one session hits legs, back, chest and core."
    : "A full gym is optional — done properly, bodyweight builds real strength and shape.";

  const body = moves.map((m, idx) =>
    `${idx + 1}. *${m.name}*${m.how ? `\n   _${m.how}_` : ""}`
  ).join("\n");

  return `${firstName ? `${firstName}, ` : ""}${seen} ${teach}\n\n`
    + `*Today — full body:*\n${body}\n\n`
    + `*How to run it:* ${sets.work}.\n${sets.note}`
    + (sets.steps ? `\n${sets.steps}` : "")
    + `\n\n_Send me a photo or the name of any move if you want a form demo. When you're back on your normal setup, just tell me._`;
}

/** The vision prompt that turns a home-equipment photo into a plain equipment list we can parse. */
export function buildEquipmentInventoryPrompt(): string {
  return `You are looking at a photo of someone's home or travel workout equipment. List ONLY the equipment you can actually see, as a short comma-separated list using these words where they apply: dumbbells, barbell, kettlebell, bands, bench, pull-up bar. If you see none of these (empty room, a mat, just the person), reply exactly: bodyweight. Do not guess or add anything you cannot see. Reply with the list only, nothing else.`;
}

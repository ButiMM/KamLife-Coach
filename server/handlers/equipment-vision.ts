/**
 * EQUIPMENT VISION — identify a gym machine from a photo and coach its use.
 *
 * Extracted verbatim from media.ts (2026-07-06, file-size budget): the machine→slug
 * mapping plus the vision call that turns a machine photo into ready-to-send
 * coaching. Used by media.ts at the equipment branch AND as a fallback when the
 * food classifier misfires on a gym photo — a machine photo must never get a food
 * error.
 */

import type OpenAI from "openai";
import { withTimeout } from "./chat-log";
import { getExerciseGifUrl } from "../exercise-media";
import { getCurrentDayExercises } from "../programme";
import { matchMachineToDay, machineSetup, machineHowTo, primaryExerciseName } from "../machine-coach";
import { variantGuideHint } from "../exercise-variants";
import { parseEquipment, buildHomeSession, buildEquipmentInventoryPrompt } from "../home-workout";

/**
 * HOME / TRAVEL KIT → ADAPTED SESSION. The client has SHOWN us what they've got (a photo of
 * their dumbbells / band / a hotel-gym corner). Instead of the old "reply dumbbells/bands/mix"
 * menu (friction on something already on screen), read the kit and hand back a full session they
 * can do right now. Fail-open: if vision can't read it, fall back to a bodyweight session (never
 * a dead end) unless a caption is given to parse instead.
 */
export async function coachHomeEquipmentFromPhoto(
  openai: OpenAI, user: any, base64: string, contentType: string, caption?: string,
): Promise<string> {
  let inventoryText = caption && parseEquipment(caption).length > 1 ? caption : "";
  if (!inventoryText) {
    try {
      const res = await withTimeout("equipment_inventory", 9000, () =>
        openai.chat.completions.create({
          model: "gpt-4o-mini", max_tokens: 40, temperature: 0,
          messages: [
            { role: "system", content: buildEquipmentInventoryPrompt() },
            { role: "user", content: [{ type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } }] },
          ],
        })
      );
      inventoryText = res.choices[0]?.message?.content?.trim() || "";
    } catch (e) {
      console.warn("[coachHomeEquipmentFromPhoto] inventory vision failed:", e);
    }
  }
  const items = parseEquipment(inventoryText || caption || "bodyweight");
  console.log(`[HOME_EQUIP] items=${items.join(",")} user=${user.id}`);
  return buildHomeSession(items, user);
}

/** Maps a vision-identified machine description to an exercise slug. Exported for tests. */
export function getMachineSlug(machineId: string): string | null {
  const m = machineId.toLowerCase();
  if (m.includes("leg press"))                                   return "leg-press";
  if (m.includes("hack squat"))                                  return "hack-squat";
  if (m.includes("smith"))                                       return "squat";
  if (m.includes("squat rack") || m.includes("power rack"))     return "barbell-back-squat";
  if (m.includes("lat pulldown") || m.includes("pull-down") || m.includes("pull down")) return "lat-pulldown";
  if (m.includes("seated row") || (m.includes("cable") && m.includes("row"))) return "seated-row";
  if (m.includes("pec deck") || m.includes("chest fly") || m.includes("pec fly")) return "chest-fly";
  if (m.includes("chest press") || m.includes("bench press"))   return "chest-press";
  if (m.includes("incline") && m.includes("press"))             return "incline-dumbbell-press";
  if (m.includes("shoulder press") || m.includes("overhead press")) return "shoulder-press";
  if (m.includes("leg extension"))                               return "leg-extension";
  if (m.includes("leg curl") || m.includes("hamstring curl"))   return "leg-curl";
  if (m.includes("hip thrust") || m.includes("glute machine"))  return "hip-thrust";
  if (m.includes("calf raise") || m.includes("calf machine"))   return "calf-raise";
  if (m.includes("face pull") || (m.includes("cable") && m.includes("rear"))) return "face-pull";
  if (m.includes("tricep") || m.includes("pushdown"))           return "tricep-pushdown";
  if (m.includes("cable") && m.includes("bicep"))               return "cable-bicep-curl";
  if (m.includes("cable") && m.includes("lateral"))             return "lateral-raise";
  if (m.includes("row"))                                         return "seated-row"; // any remaining "… row" machine
  if (m.includes("cable"))                                       return "lat-pulldown"; // generic cable → lat pulldown default
  if (m.includes("rdl") || m.includes("romanian deadlift"))     return "rdl";
  if (m.includes("barbell"))                                     return "barbell-back-squat";
  if (m.includes("pull-up") || m.includes("pull up") || m.includes("assisted pull")) return "lat-pulldown";
  if (m.includes("resistance band"))                             return "resistance-band-row";
  return null;
}

/**
 * The machine-identification system prompt. Extracted + exported so a unit test can
 * assert the discriminating features survive future edits (2026-07-12, Kam: "the vision
 * doesn't recognize any machines, it makes mistakes"). The old prompt just listed names
 * with no way to tell them apart, so a plate-loaded ROW got called a HACK SQUAT. This
 * one teaches the visual tells (seat, pads, handles, direction of movement) and asks for
 * a confidence so a shaky guess never gets asserted as fact with the wrong setup.
 */
export function buildMachineIdPrompt(): string {
  return `You identify a gym machine from a photo for a coaching app. A WRONG id gives the client the wrong coaching, so precision matters more than speed.

Reply in EXACTLY this format, nothing else:
<machine name> | <confidence>
 • <machine name>: 2-5 words, or "unknown" if you truly cannot tell
 • <confidence>: "high" if you are sure, "low" if the angle, clutter or crop makes it a guess

Tell the machines apart by the SEAT, PADS, HANDLES and DIRECTION of movement — NEVER by the weight plates (plate-loaded and weight-stack versions look different but are the same machine):
 • LEG PRESS — you sit low and reclined, feet on a big angled FOOT PLATFORM, push it away with your legs.
 • HACK SQUAT — you stand and lean back on angled SHOULDER PADS on a diagonal sled, feet on a platform below; your body travels, not your arms.
 • SEATED / CABLE ROW — sit upright facing a chest pad or footplate and PULL handles horizontally toward your stomach.
 • LAT PULLDOWN — sit under a high overhead bar with THIGH PADS pinning your legs; pull the bar DOWN from above.
 • CHEST PRESS — sit upright, push handles FORWARD away from your chest (horizontal).
 • SHOULDER PRESS — sit upright, push handles UP overhead (vertical).
 • PEC DECK / CHEST FLY — sit with arms out wide on pads, squeeze them together in front.
 • LEG EXTENSION — sit with an ankle pad on the FRONT of your shins, straighten your legs forward.
 • LEG CURL — sit or lie with an ankle pad on the BACK of your ankles, curl your heels toward your glutes.
 • HIP THRUST machine — back on a pad, a PAD ACROSS THE HIPS, drive the hips up.
 • SMITH MACHINE — a barbell fixed on two vertical rails. SQUAT/POWER RACK — a tall open cage with J-hooks for a free barbell.
 • CABLE MACHINE — an adjustable pulley on a tall column with a weight stack. CALF RAISE — shoulder or knee pads, you rise onto your toes.

If two machines are both plausible, or the photo is cluttered or too close to be sure, pick the most likely and mark it "low" — do not pretend to be certain.`;
}

/**
 * Identify a gym machine from a photo and return ready-to-send coaching, or null if the
 * machine can't be recognised. Pulled out of the inline equipment branch so it can ALSO be
 * used as a fallback when the food path misfires on a gym photo (e.g. cluttered, plate-loaded
 * machines that the first classifier missed) — a machine photo must never get a food error.
 */
export async function coachGymMachineFromPhoto(
  openai: OpenAI, user: any, base64: string, contentType: string, caption?: string,
): Promise<string | null> {
  // CAPTION RULES — the client who captions a machine photo has TOLD us what it is.
  // 2026-07-10: "Shoulder press" on a weight-stack photo was a lift being LOGGED; the
  // caption was never read, vision failed on the close-up, and the client got a generic
  // "reply workout" while mid-set. The caption always beats vision: treat it as the
  // exercise and prime the lift log. Vision only runs when there is no usable caption.
  const captionSlug = caption ? getMachineSlug(caption) : null;
  if (captionSlug) {
    const exName = captionSlug.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    return `*${exName}* — got it 💪 What weight and reps? Reply like *"65kg 3x8"* and I'll log it.\n\n_Want the how-to instead? Type *show me ${exName.toLowerCase()}*._`;
  }
  try {
    const machineIdRes = await withTimeout("equipment_id", 9000, () =>
      openai.chat.completions.create({
        model: "gpt-4o-mini", max_tokens: 24, temperature: 0,
        messages: [
          { role: "system", content: buildMachineIdPrompt() },
          { role: "user", content: [{ type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } }] },
        ],
      })
    );
    const rawReply = machineIdRes.choices[0]?.message?.content?.trim().toLowerCase() || "unknown";
    // Format is "<machine name> | <confidence>" — split them; tolerate a missing confidence.
    const [namePart, confPart] = rawReply.split("|").map(s => s.trim());
    const machineRaw = (namePart || "unknown").replace(/[.!]+$/, "").trim();
    const lowConfidence = /\blow\b/.test(confPart || "");
    console.log(`[EQUIPMENT_ID] identified="${machineRaw}" confidence="${lowConfidence ? "low" : "high"}" user=${user.id}`);
    if (machineRaw === "unknown" || machineRaw.length <= 2) return null;

    const slug = getMachineSlug(machineRaw);
    const displayName = machineRaw.replace(/\b\w/g, (c: string) => c.toUpperCase());

    if (machineRaw.includes("dumbbell")) {
      let reply = `*Dumbbells* — your programme uses these.\n\nReply *workout* to see exactly what you are doing today with them.\n\nOr type *show me* followed by any exercise name for a form demo.`;
      const dumbbellImg = getExerciseGifUrl("bicep-curl");
      if (dumbbellImg) reply += `\n[MEDIA:${dumbbellImg}]`;
      return reply;
    }

    const imageUrl = slug ? getExerciseGifUrl(slug) : null;
    let day = null;
    try { day = getCurrentDayExercises(user); } catch { /* no programme yet */ }
    const match = matchMachineToDay(slug, machineRaw, day);
    const setup = machineSetup(slug);
    const setupLine = setup ? `⚙️ *Setup:* ${setup}\n` : "";

    // HEDGED, always — 2026-07-10: a plate-loaded ROW machine was asserted as a "Hack
    // Squat Machine" with full setup instructions for the wrong machine. Machine vision
    // is genuinely fallible, so every ID reads as "looks like" and every reply carries a
    // one-line correction path. Confident + wrong is worse than unsure + honest.
    //
    // 2026-07-12: when the model itself flags LOW confidence, we NEVER claim "exactly
    // your plan" or give machine-specific setup (the riskiest wrong info) — we lead with
    // an honest "not sure from this angle" and put the correction path up front instead.
    let reply: string;
    if (lowConfidence) {
      reply = `🤔 *I'm not 100% sure from this angle — looks like it could be a ${displayName}.*\n\n`
        + `If that's right, here's how to use it:\n✅ *How:* ${machineHowTo(slug) || "sit square, control the weight down, full range, no jerking."}\n\n`
        + `*If I've got it wrong, just reply the machine's name* (like *seated row* or *leg press*) and I'll coach the right one.`;
    } else if (match.kind === "exact" && match.prescribed) {
      const p = match.prescribed;
      reply = `✅ *That looks like the ${displayName} — exactly what your plan calls for today.*\n\n`
        + `📋 *Your sets:* ${p.setsDisplay}\n`
        + setupLine
        + `✅ *How:* ${p.description}\n`
        + `⚠️ *Don't:* ${p.mistake}`;
    } else if (match.kind === "substitute" && match.prescribed) {
      const p = match.prescribed;
      reply = `*That looks like a ${displayName}* — not the exact machine your plan names, but it trains the same muscles the same way. Use it today, no problem.\n\n`
        + `📋 *Swap it in for your ${primaryExerciseName(p.name)} — same sets:* ${p.setsDisplay}\n`
        + setupLine
        + `✅ *How:* ${machineHowTo(slug)}`;
    } else {
      reply = `*Looks like a ${displayName}*\n\n`
        + setupLine
        + `✅ *How:* ${machineHowTo(slug)}`;
      reply += day
        ? `\n\nThis isn't on today's session — reply *workout* to see what you're doing today.`
        : `\n\nReply *workout* to get your programme.`;
    }
    if (!lowConfidence) reply += `\n\n_Got the machine wrong? Reply its name (e.g. "seated row") and I'll coach that one._`;
    const hint = variantGuideHint(slug);
    if (hint) reply += `\n\n${hint}`;
    if (imageUrl) reply += `\n[MEDIA:${imageUrl}]`;
    return reply;
  } catch (e) {
    console.warn("[coachGymMachineFromPhoto] vision failed:", e);
    return null;
  }
}

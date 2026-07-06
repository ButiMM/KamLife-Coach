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

/** Maps a vision-identified machine description to an exercise slug. */
function getMachineSlug(machineId: string): string | null {
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
  if (m.includes("cable"))                                       return "lat-pulldown"; // generic cable → lat pulldown default
  if (m.includes("rdl") || m.includes("romanian deadlift"))     return "rdl";
  if (m.includes("barbell"))                                     return "barbell-back-squat";
  if (m.includes("pull-up") || m.includes("pull up") || m.includes("assisted pull")) return "lat-pulldown";
  if (m.includes("resistance band"))                             return "resistance-band-row";
  return null;
}

/**
 * Identify a gym machine from a photo and return ready-to-send coaching, or null if the
 * machine can't be recognised. Pulled out of the inline equipment branch so it can ALSO be
 * used as a fallback when the food path misfires on a gym photo (e.g. cluttered, plate-loaded
 * machines that the first classifier missed) — a machine photo must never get a food error.
 */
export async function coachGymMachineFromPhoto(
  openai: OpenAI, user: any, base64: string, contentType: string,
): Promise<string | null> {
  try {
    const machineIdRes = await withTimeout("equipment_id", 9000, () =>
      openai.chat.completions.create({
        model: "gpt-4o-mini", max_tokens: 15, temperature: 0,
        messages: [
          {
            role: "system",
            content: `Identify the gym machine or equipment in this photo. Reply with ONLY the equipment name, 2-5 words. Use these terms: leg press, smith machine, lat pulldown, cable machine, chest press machine, shoulder press machine, leg extension machine, leg curl machine, hip thrust machine, seated row machine, hack squat machine, pec deck, squat rack, dumbbells, barbell, resistance bands, pull-up bar, calf raise machine, cable bicep curl, cable lateral raise, face pull. The machine may be plate-loaded (big weight plates on pegs) or have a weight stack — judge by its shape and the seat/pad/handle layout, not the plates. If you genuinely cannot tell, reply: unknown.`,
          },
          { role: "user", content: [{ type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } }] },
        ],
      })
    );
    const machineRaw = machineIdRes.choices[0]?.message?.content?.trim().toLowerCase() || "unknown";
    console.log(`[EQUIPMENT_ID] identified="${machineRaw}" user=${user.id}`);
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

    let reply: string;
    if (match.kind === "exact" && match.prescribed) {
      const p = match.prescribed;
      reply = `✅ *That's the ${displayName} — exactly what your plan calls for today.*\n\n`
        + `📋 *Your sets:* ${p.setsDisplay}\n`
        + setupLine
        + `✅ *How:* ${p.description}\n`
        + `⚠️ *Don't:* ${p.mistake}`;
    } else if (match.kind === "substitute" && match.prescribed) {
      const p = match.prescribed;
      reply = `*That's a ${displayName}* — not the exact machine your plan names, but it trains the same muscles the same way. Use it today, no problem.\n\n`
        + `📋 *Swap it in for your ${primaryExerciseName(p.name)} — same sets:* ${p.setsDisplay}\n`
        + setupLine
        + `✅ *How:* ${machineHowTo(slug)}`;
    } else {
      reply = `*${displayName}*\n\n`
        + setupLine
        + `✅ *How:* ${machineHowTo(slug)}`;
      reply += day
        ? `\n\nThis isn't on today's session — reply *workout* to see what you're doing today.`
        : `\n\nReply *workout* to get your programme.`;
    }
    const hint = variantGuideHint(slug);
    if (hint) reply += `\n\n${hint}`;
    if (imageUrl) reply += `\n[MEDIA:${imageUrl}]`;
    return reply;
  } catch (e) {
    console.warn("[coachGymMachineFromPhoto] vision failed:", e);
    return null;
  }
}

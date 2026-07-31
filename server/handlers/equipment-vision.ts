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

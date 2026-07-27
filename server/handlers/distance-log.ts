/**
 * DISTANCE SCREENSHOT → logged movement. Extracted from media.ts so the run-conversion
 * branch lives with its own logic (and media.ts stays inside its line budget).
 *
 * (2026-07-27) A Strava/Nike/Runkeeper screenshot of a 10km run used to log NOTHING: the
 * step extractor was told to ignore km. Now the distance becomes a step-equivalent + burn
 * and lands in the same daily movement ledger everything else reads.
 */

import { convertDistance, distanceReply, detectMode } from "../run-conversion";
import { logStepsForUser } from "./steps";
import { logChat } from "./chat-log";

/** Returns the client reply when the screenshot carried a distance, else null. */
export async function tryLogDistanceScreenshot(stepText: string, message: string, user: any): Promise<string | null> {
  const m = (stepText || "").match(/DISTANCE:\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(RUN|WALK)?/i);
  if (!m) return null;
  const km = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(km) || km <= 0 || km > 100) return null;

  const flagged = (m[2] || "").toLowerCase();
  const mode = flagged === "walk" ? "walk" : flagged === "run" ? "run" : detectMode(message);
  const act = convertDistance(km, parseFloat(String(user.currentWeight || "")) || 75, mode);
  await logStepsForUser(user.id, act.stepEquivalent).catch(() => {});
  const reply = distanceReply(act, user.name?.split(" ")[0]);
  await logChat(user.id, `[${act.km}km ${act.mode} screenshot]`, reply, "DISTANCE_LOG").catch(() => {});
  return reply;
}

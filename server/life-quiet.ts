/**
 * LIFE QUIET — comfort that is followed by a water reminder is not comfort.
 *
 * (2026-07-27.) When someone tells the coach their mother died, the reply matters far less than
 * what happens over the next seven days. The proactive scheduler had no idea any of it had
 * happened, so a bereavement message could be followed the next morning by "💧 halfway to your
 * water target!". That is the failure people actually remember.
 *
 * A life context writes a quiet window into quality_signals — the same table the friction gate
 * already reads — so routine nudges stop without any new schema or job. Critical billing and
 * safety messages are unaffected; they never pass through the routine gate.
 */

import { db } from "./db";
import { qualitySignals } from "../shared/schema";
import { quietDays, type ContextRead } from "./life-context";

/** Marker kind the proactive gate looks for. */
export const LIFE_QUIET_KIND = "life_quiet";

export async function markLifeQuiet(userId: string, read: ContextRead): Promise<void> {
  try {
    await db.insert(qualitySignals).values({
      userId,
      kind: LIFE_QUIET_KIND,
      detail: `${read.context}:${quietDays(read)}d`,
    });
  } catch (e) {
    console.warn("[LIFE_QUIET] could not record quiet window:", e);
  }
}

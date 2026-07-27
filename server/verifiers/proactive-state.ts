/**
 * PROACTIVE STATE GATE — don't chirp at someone who is angry, sick, or grieving.
 *
 * (2026-07-27, twice in one day.) A water nudge arrived minutes after a client had raged at
 * the bot, and an evening check-in fired while the same conversation was going badly. The
 * scheduler had no idea any of that had happened: it knew about caps, dedupe windows and the
 * global killswitch, but nothing about the human on the other end.
 *
 * A routine nudge is optional by definition — that is what makes holding it safe. Critical
 * messages (payment, subscription, safety) are never held; they route through claimCritical.
 *
 * The signal is already being recorded: captureFriction writes frustration / rejection /
 * correction rows into quality_signals on every bad exchange. This just reads them.
 */

import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db";
import { qualitySignals } from "../../shared/schema";

/** How long a bad exchange suppresses routine nudges. Long enough to matter, short enough to recover. */
export const FRICTION_QUIET_HOURS = 12;

/** Friction kinds that mean "this person is not in the mood for a tip about water". */
const HOLD_KINDS = ["friction_frustration", "friction_rejection", "friction_correction"];

/**
 * Should a ROUTINE proactive message be held back right now?
 * Fail-open: any error returns false, because a missed nudge is a smaller failure than a
 * scheduler that stops sending entirely.
 */
export async function shouldHoldProactive(userId: string): Promise<{ hold: boolean; reason: string }> {
  try {
    const since = new Date(Date.now() - FRICTION_QUIET_HOURS * 3_600_000);
    const [recent] = await db.select({ kind: qualitySignals.kind, createdAt: qualitySignals.createdAt })
      .from(qualitySignals)
      .where(and(
        eq(qualitySignals.userId, userId),
        gte(qualitySignals.createdAt, since),
        inArray(qualitySignals.kind, HOLD_KINDS),
      ))
      .orderBy(desc(qualitySignals.createdAt))
      .limit(1);
    if (!recent) return { hold: false, reason: "" };
    return { hold: true, reason: `${recent.kind} within ${FRICTION_QUIET_HOURS}h` };
  } catch {
    return { hold: false, reason: "" };
  }
}

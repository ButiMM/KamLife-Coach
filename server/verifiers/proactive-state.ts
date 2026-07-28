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

// A life context (bereavement, illness, retrenchment, caring for someone) buys a much longer
// quiet window than a bad exchange does. Comfort followed the next morning by a water tip is
// the failure people remember — see server/life-quiet.ts. The window is stored in the row's
// detail as "<context>:<n>d".
const LIFE_QUIET_KIND = "life_quiet";
const LIFE_QUIET_MAX_DAYS = 7;

/**
 * Should a ROUTINE proactive message be held back right now?
 * Fail-open: any error returns false, because a missed nudge is a smaller failure than a
 * scheduler that stops sending entirely.
 */
export async function shouldHoldProactive(userId: string): Promise<{ hold: boolean; reason: string }> {
  try {
    // Life context first — it wins and it lasts longer.
    const lifeSince = new Date(Date.now() - LIFE_QUIET_MAX_DAYS * 86_400_000);
    const [life] = await db.select({ detail: qualitySignals.detail, createdAt: qualitySignals.createdAt })
      .from(qualitySignals)
      .where(and(
        eq(qualitySignals.userId, userId),
        gte(qualitySignals.createdAt, lifeSince),
        eq(qualitySignals.kind, LIFE_QUIET_KIND),
      ))
      .orderBy(desc(qualitySignals.createdAt))
      .limit(1);
    if (life?.createdAt) {
      const days = parseInt((life.detail || "").split(":")[1] || "3", 10) || 3;
      const ageDays = (Date.now() - new Date(life.createdAt).getTime()) / 86_400_000;
      if (ageDays <= days) {
        return { hold: true, reason: `life context (${life.detail}) ${ageDays.toFixed(1)}d ago` };
      }
    }

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

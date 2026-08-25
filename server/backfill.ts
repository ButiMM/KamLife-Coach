/**
 * BACKFILL — a dated beat becomes a row on the day it names (2026-08-25, P0-2).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The cohort does not log meal-by-meal. They disappear for three days and then send:
 *
 *     "Monday pap and chicken. Tuesday eggs and toast. Wednesday I trained and walked 8k."
 *
 * `attributeMultiDayReport` has been able to date those beats since PR #52 — and had ZERO
 * production callers. It was tested, merged, described as shipped, and no client message could
 * reach it. This is the module that connects it to the writers, and it is the reason GUARD #13
 * (reachability) exists: the gap was invisible because the suite tested the library.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS NOT
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Not a decision owner: it returns what it wrote and says nothing to the client. Not a router:
 * the caller decides when to consult it. Not a new intent taxonomy — every domain question is
 * answered by the owner that already answers it (scanForSAFoods, journeyMustKeepFacts,
 * detectStepLog), so a beat is classified exactly as the same words would be in a single-day
 * message.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE FIREWALL (P0-3)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A historical write is a statement about that day and about NOTHING ELSE. It may add the row
 * and move lifetime counters, because those are facts about the past. It may not advance the
 * programme cursor, declare today's session done, or move a streak forward — today's questions
 * are answered by today. The `users` write is exactly that permitted half, and it is delegated to
 * applyRetroSessionState so this module cannot drift from the two retro paths in workout.ts.
 */

import { db } from "./db";
import { workoutLogs, stepLogs } from "../shared/schema";
import { and, eq, gte, lt } from "drizzle-orm";
import { attributeMultiDayReport } from "./understanding/day-relative-situation";
import { journeyMustKeepFacts, detectStepLog } from "./understanding/messy-intake";
import { turnMutation } from "./handlers/chat-log";
import { applyRetroSessionState } from "./day-ledger";

export interface BackfillWrite { dayKey: string; domain: "food" | "workout" | "steps"; detail: string; }
export interface BackfillResult {
  writes: BackfillWrite[];
  /** Beats we could not date. Never guessed — the caller may ask, but this will not invent a day. */
  undated: string[];
  /** True when a multi-day FOOD owner will also answer this turn; the caller must not reply. */
  foodOwnedElsewhere: boolean;
  days: string[];
}

/** Noon SAST on the named day: inside the day whatever the offset, and never a midnight edge. */
function noonOn(dayKey: string): Date { return new Date(`${dayKey}T12:00:00+02:00`); }

function dayWindow(dayKey: string): { start: Date; end: Date } {
  const start = new Date(`${dayKey}T00:00:00+02:00`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/**
 * Write every dated beat in a multi-day report. Returns null when the message is not one —
 * a single-day turn keeps its existing path untouched, which is the whole point of the
 * `hasMultipleDays` gate: this adds a capability, it does not re-route the product.
 */
export async function backfillAttributedDays(
  // NOT `{ id: string }`. applyRetroSessionState increments FROM the held total, so a caller
  // passing only an id would reset the lifetime count to the number of days in this message.
  user: { id: string; phoneNumber?: string | null; totalWorkoutsCompleted?: number | null; lastWorkoutDate?: Date | string | null },
  message: string,
  now: Date = new Date(),
): Promise<BackfillResult | null> {
  const attribution = attributeMultiDayReport(message, now);
  if (!attribution.hasMultipleDays) return null;

  const { scanForSAFoods } = await import("./handlers/food-scanner");

  // ── FOOD ALREADY HAS A MULTI-DAY OWNER, AND IT IS BETTER THAN THIS ONE ────────────────────
  //
  // handlers/food-context.ts has claimed 2+ day-segments carrying food since long before this
  // module existed: quantity-aware through adjustFoodsForSegment and portion memory, real meal
  // labels via extractMealLabel, per-day kcal and protein, all through commitFoodLog.
  //
  // The first version of this module wrote food too, ran ahead of it, and produced a WORSE
  // answer — routing-audit caught it immediately: "Had chicken and rice Wednesday, oats Thursday,
  // pap and pilchards Friday" came back with the days shifted by one and no kcal. That is the
  // exact defect this whole cut exists to stop, committed by the cut itself: a new owner added in
  // front of a working one instead of extending it.
  //
  // So food is declined here. This module owns the domains that multi-day path cannot write —
  // training and steps across named days. The two must eventually be ONE owner; until then this
  // one stands down rather than competing, and never writes a meal row.
  // Food is written by that owner, not this one. Training and steps are written here, on the days
  // they name, and the single-day doors downstream stand down via turnAlreadyWrote rather than
  // re-writing the same event on the first day the bubble happens to mention.
  const foodOwnedElsewhere = attribution.beats.filter(
    b => b.dayKey && scanForSAFoods(b.text).some(f => !/^water$/i.test(f.name))).length >= 2;

  const writes: BackfillWrite[] = [];
  const undated: string[] = [];

  for (const beat of attribution.beats) {
    if (!beat.dayKey) { if (beat.text.trim()) undated.push(beat.text.trim()); continue; }
    const { start, end } = dayWindow(beat.dayKey);
    const at = noonOn(beat.dayKey);

    // WORKOUT — one row on the named day, and nothing about today. Idempotent per day.
    if (journeyMustKeepFacts(beat.text).workout) {
      const existing = await db.select({ id: workoutLogs.id }).from(workoutLogs)
        .where(and(eq(workoutLogs.userId, user.id), gte(workoutLogs.loggedAt, start), lt(workoutLogs.loggedAt, end)))
        .limit(1);
      if (existing.length === 0) {
        await db.insert(workoutLogs).values({ userId: user.id, workoutCompleted: true, loggedAt: at });
        turnMutation(`INSERT workout completed=true at=${beat.dayKey}`, "[BACKFILL]");
        writes.push({ dayKey: beat.dayKey, domain: "workout", detail: "session" });
      }
    }

    // STEPS — the same detector the live step door uses.
    const step = detectStepLog(beat.text);
    if (step.loggableByForm && step.matched && step.steps > 100 && step.steps < 100_000) {
      const existing = await db.select({ id: stepLogs.id }).from(stepLogs)
        .where(and(eq(stepLogs.userId, user.id), gte(stepLogs.loggedAt, start), lt(stepLogs.loggedAt, end)))
        .limit(1);
      if (existing.length === 0) {
        await db.insert(stepLogs).values({ userId: user.id, steps: step.steps, loggedAt: at });
        turnMutation(`INSERT steps=${step.steps} at=${beat.dayKey}`, "[BACKFILL]");
        writes.push({ dayKey: beat.dayKey, domain: "steps", detail: `${step.steps.toLocaleString()} steps` });
      }
    }
  }

  // THE DERIVED STATE A SESSION CARRIES (2026-08-25, P0-5 · workout). This module wrote the
  // ledger row and touched `users` not at all — so a multi-day report moved workoutLogs and left
  // totalWorkoutsCompleted behind, and two readers answered "how many sessions have I done"
  // with different numbers. The contract is shared with both retro paths in workout.ts; see
  // applyRetroSessionState. Only days we ACTUALLY inserted count, so the idempotency guard above
  // keeps a repeated report from inflating the total.
  const sessionDays = writes.filter(w => w.domain === "workout").map(w => noonOn(w.dayKey));
  if (sessionDays.length > 0) {
    try {
      await applyRetroSessionState(user, sessionDays);
    } catch (e: any) {
      console.warn(`[BACKFILL] retro session state failed for ${String(user.id || "").slice(-6)}: ${e?.message || e}`);
    }
  }

  if (writes.length === 0) return null;
  // When the food owner will also answer this turn, it composes the reply — this returns its
  // writes so the caller can fall through rather than speaking over it.
  return { writes, undated, foodOwnedElsewhere, days: [...new Set(writes.map(w => w.dayKey))].sort() };
}

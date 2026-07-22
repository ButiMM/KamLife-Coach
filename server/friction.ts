/**
 * FRICTION MONITOR — surfaces the client who is quietly FIGHTING the bot.
 *
 * (2026-07-22, Kam: "people can't be fighting with the bot all the time… we need to be
 * monitoring them, what they're logging, how they're struggling.") A client can message
 * every single day — so the activity-based triage queue calls them healthy — while hating
 * every reply: correcting a mis-read meal, rejecting a log, getting cold-redirected, venting.
 * Those moments were invisible. This records each one and lets the triage queue rank by them,
 * so a client having a rough week bubbles to the top BEFORE they churn in silence.
 *
 * Storage: reuses the quality_signals table (kind = friction_*), so no migration. Capture is
 * the same fire-and-forget contract as quality signals — it never throws, never blocks a reply.
 */

import { db } from "./db";
import { qualitySignals } from "../shared/schema";
import { and, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { captureQualitySignal } from "./quality-signals";

export type FrictionKind =
  | "correction"    // client corrected a mis-read food ("it's not vetkoek, it's magwinya")
  | "rejection"     // client rejected a log outright ("no", "wrong", "that's not it")
  | "redirect"      // the domain gate cold-redirected them ("I'm Coach K…")
  | "frustration";  // client vented at the bot ("useless", "this doesn't work")

/** The quality_signals `kind` value for each friction moment. */
export const frictionSignalKind = (k: FrictionKind): string => `friction_${k}`;

/** Every friction kind as it appears in the table — for the aggregation query. */
export const FRICTION_SIGNAL_KINDS: string[] =
  (["correction", "rejection", "redirect", "frustration"] as FrictionKind[]).map(frictionSignalKind);

/**
 * Record one friction moment. Fire-and-forget (delegates to captureQualitySignal, which never
 * throws or blocks). A friction row is a bonus signal for the operator — it must never be able
 * to delay or break the client's reply.
 */
export function captureFriction(kind: FrictionKind, opts: {
  userId?: string | null;
  phone?: string | null;
  messageIn?: string | null;
  messageOut?: string | null;
  detail?: string | null;
}): void {
  captureQualitySignal(frictionSignalKind(kind) as any, opts);
}

/**
 * Per-client friction count over the last 7 days (userId → count). Read-only; used by the
 * triage endpoint to rank the "needs attention" queue. Anonymous signals (no userId) are
 * dropped — they can't be attributed to a client to act on.
 */
export async function frictionCountsLast7(): Promise<Map<string, number>> {
  const since = new Date(Date.now() - 7 * 86400000);
  const rows = await db
    .select({ userId: qualitySignals.userId, n: sql<number>`COUNT(*)::int` })
    .from(qualitySignals)
    .where(and(
      gte(qualitySignals.createdAt, since),
      isNotNull(qualitySignals.userId),
      inArray(qualitySignals.kind, FRICTION_SIGNAL_KINDS),
    ))
    .groupBy(qualitySignals.userId);
  return new Map(rows.filter(r => r.userId).map(r => [r.userId as string, Number(r.n)]));
}

/**
 * PURE — how a week's friction count should colour a client in the triage queue.
 * Kept separate from the DB so it's unit-testable and its thresholds are one obvious place.
 *   4+ rough moments in a week  → red  (they are fighting the bot; read their chat)
 *   2–3 rough moments           → yellow (something is misfiring; check it)
 *   0–1                         → none (normal — a stray correction isn't a problem)
 */
export type FrictionFlag = { level: "red" | "yellow"; reason: string; nextAction: string } | null;
export function frictionFlag(count: number): FrictionFlag {
  if (count >= 4) {
    return {
      level: "red",
      reason: `Fighting the bot — ${count} rough moments this week`,
      nextAction: "Read their chat; the bot is failing them",
    };
  }
  if (count >= 2) {
    return {
      level: "yellow",
      reason: `${count} rough moments with the bot this week`,
      nextAction: "Check what's misfiring in their chats",
    };
  }
  return null;
}

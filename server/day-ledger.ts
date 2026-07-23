/**
 * DAY LEDGER — the ONE source of truth for a client's day (Box 1 of the rebuild).
 *
 * (2026-07-22, Kam: "the card says one thing, the text says another, nothing reconciles.")
 * The disease was that the macro card, the running-total reply, and "today's meals" each
 * computed the day's numbers with their OWN query and their OWN math — so they drifted. This
 * is the cure: every one of those surfaces now READS getDayLedger. One place turns logged
 * meals into a day total; they cannot disagree, because it is the same computation.
 *
 * Rule of the rebuild: this READS. It never writes. Writing stays in the single commit path.
 * The pure reducer lives in day-ledger-core.ts and is unit-tested.
 */

import { db } from "./db";
import { mealLogs, stepLogs } from "../shared/schema";
import { and, eq, gte, lt, desc, sql } from "drizzle-orm";
import { sastDayStart, sastToday } from "./utils";
import { foldLedgerRows, freshTodayWater, type DayLedger, type LedgerRow } from "./day-ledger-core";

export { foldLedgerRows } from "./day-ledger-core";
export type { DayLedger, LedgerMeal, LedgerRow } from "./day-ledger-core";

/**
 * The authoritative day read. `forDate` scopes to a past day (retro logs); omit for today.
 * `user` supplies today's water. This is the only function that computes a day's totals.
 */
export async function getDayLedger(userId: string, opts?: { forDate?: Date; user?: any }): Promise<DayLedger> {
  const dayStart = opts?.forDate ? sastDayStart(opts.forDate) : sastDayStart();
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const rows = await db.select({
    label: mealLogs.mealLabel, kcal: mealLogs.kcalInt, protein: mealLogs.proteinInt,
    carbs: mealLogs.carbsInt, fat: mealLogs.fatInt, loggedAt: mealLogs.loggedAt,
    source: mealLogs.source, items: mealLogs.items, rawMessage: mealLogs.rawMessage,
  }).from(mealLogs)
    .where(and(eq(mealLogs.userId, userId), gte(mealLogs.loggedAt, dayStart), lt(mealLogs.loggedAt, dayEnd)))
    .orderBy(desc(mealLogs.loggedAt));

  const [stepRow] = await db.select({ steps: sql<number>`COALESCE(MAX(${stepLogs.steps}),0)::int` })
    .from(stepLogs)
    .where(and(eq(stepLogs.userId, userId), gte(stepLogs.loggedAt, dayStart), lt(stepLogs.loggedAt, dayEnd)));

  const folded = foldLedgerRows(rows as LedgerRow[]);
  // Water shows on the card only if today_water was last reset today — else it's yesterday's
  // stale litres (2026-07-23, Kam: "it says 2L — I've had no water today"). freshTodayWater is
  // pure + unit-tested; the guard matches every other surface (client-snapshot, misc-commands).
  const water = opts?.forDate ? 0 : freshTodayWater(opts?.user?.waterLastResetDate, sastToday(), opts?.user?.todayWater);
  const steps = Number(stepRow?.steps || 0);
  return { ...folded, water, steps };
}

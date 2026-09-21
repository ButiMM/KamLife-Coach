/**
 * USER-SET REMINDERS — persistence layer. The pure parser (parseReminderRequest,
 * describeFireTime) lives in reminders-parse.ts so it is unit-testable without the DB;
 * this module re-exports it and adds the create/list/cancel/fetch-due operations.
 *
 * A scheduler poll (scheduler/jobs/reminders.ts) fires the ones whose fireAt has passed.
 * fireAt is stored in real UTC; the parser anchors everything to SAST (UTC+2, no DST).
 */

import { db } from "./db";
import { reminders, mealLogs, workoutLogs } from "../shared/schema";
import { eq, and, lte, like, sql } from "drizzle-orm";

import { returnNudgeTime, describeFireTime } from "./reminders-parse";
import type { Recurrence } from "./reminders-parse";
export { parseReminderRequest, describeFireTime, returnNudgeTime } from "./reminders-parse";
export type { ParsedReminder, Recurrence } from "./reminders-parse";

export async function createReminder(userId: string, phone: string, body: string, fireAt: Date, recurrence: Recurrence = null): Promise<void> {
  await db.insert(reminders).values({ userId, phoneNumber: phone, body, fireAt, recurrence });
}

/** "every day at 8:00am" / "every Monday at 6:00am" — the recurring form of describeFireTime. */
export function describeRecurring(fireAt: Date, recurrence: Recurrence): string {
  const one = describeFireTime(fireAt); // "today at 8:00am" / "Mon 21 Jul at 6:00am"
  const time = one.replace(/^.*\bat\s+/, "at "); // keep just "at H:MMxm"
  if (recurrence === "daily") return `every day ${time}`;
  if (recurrence === "weekly") {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const d = new Date(fireAt.getTime() + 2 * 3_600_000).getUTCDay();
    return `every ${days[d]} ${time}`;
  }
  return one;
}

/** Client-facing reminders only ('my reminders' should never list system nudges). */
export async function listPendingReminders(userId: string) {
  return db.select().from(reminders)
    .where(and(eq(reminders.userId, userId), eq(reminders.status, "pending"), eq(reminders.kind, "user")))
    .orderBy(reminders.fireAt);
}

/** Cancel all pending CLIENT-SET reminders for a user. Returns how many were cancelled. */
export async function cancelAllReminders(userId: string): Promise<number> {
  const pending = await listPendingReminders(userId);
  if (!pending.length) return 0;
  await db.update(reminders).set({ status: "cancelled" })
    .where(and(eq(reminders.userId, userId), eq(reminders.status, "pending"), eq(reminders.kind, "user")));
  return pending.length;
}

/**
 * Cancel any pending auto return nudge for a user (dedupe when the date changes, or on recovery).
 *
 * MATCHES EVERY RETURN KIND, INCLUDING LEGACY (C17). The reason is now carried in `kind` as
 * `return_sick` / `return_away`, and rows booked before that still read plain `return`. An
 * equality filter would have silently stopped cancelling the new ones the day they shipped.
 */
export async function cancelReturnNudges(userId: string): Promise<void> {
  await db.update(reminders).set({ status: "cancelled" })
    .where(and(eq(reminders.userId, userId), eq(reminders.status, "pending"), like(reminders.kind, "return%")));
}

/** Is this reminder one of the coach's own return nudges, whatever its reason? */
export function isReturnKind(kind: unknown): boolean {
  return String(kind || "").startsWith("return");
}

/** The reason a return nudge was booked. `null` for a legacy row that never stored one. */
export function returnReason(kind: unknown): "sick" | "away" | null {
  const k = String(kind || "");
  return k === "return_sick" ? "sick" : k === "return_away" ? "away" : null;
}

/**
 * THE TEMPORAL LOOP — auto-schedule a night-before "you're back tomorrow" nudge from a captured
 * return date, so a sick / away client is never met with silence (they never come back if we go
 * quiet). dateStr is the SAST return date (YYYY-MM-DD); the nudge fires at 19:00 SAST the evening
 * before. One active return nudge per client (deduped). No-op if the evening-before is already past.
 */
export async function scheduleReturnNudge(userId: string, phone: string, dateStr: string, kind: "sick" | "away"): Promise<void> {
  const nudgeAt = returnNudgeTime(dateStr);
  if (!nudgeAt) return; // malformed date, or the evening-before is already past
  await cancelReturnNudges(userId);
  const body = kind === "sick"
    ? "Tomorrow's the day you're cleared to get back to it. 💪 How are you feeling? If you're good, we start easy — session one at 60%, one less set. Reply *I'm back* and I'll set it up. No rush if you need another day."
    : "Tomorrow you're back! Ready to pick up right where you left off — nothing reset, your plan's exactly where you left it. Reply *I'm back* and we go again. 💪";
  // THE REASON IS PRESERVED AT WRITE (C17). It was discarded here — both a sick hold and a
  // holiday booked a row saying only `return` — so the firing job had no way to apply evidence
  // appropriate to WHY the client was away. Carried in `kind` rather than a new column: the
  // column is free text, the value is a discriminator, and no migration touches a live ledger.
  await db.insert(reminders).values({ userId, phoneNumber: phone, body, fireAt: nudgeAt, kind: `return_${kind}` });
}

/**
 * HAS THIS CLIENT ALREADY COME BACK? (C17.)
 *
 * A return nudge is written for somebody we believe is still away: "Tomorrow you're back! Ready
 * to pick up right where you left off — nothing reset". Said to a client who came back early and
 * has been logging since, it is the coach chasing a commitment they already kept, in the restart
 * language three existing acceptances forbid on the reactive door.
 *
 * ONE CANCELLER EXISTED AND IT COULD NOT SEE THEM. `cancelReturnNudges` is called from exactly
 * one place — sick-flow.ts, behind `holdOnRecord.phase !== "none"` — so it fires only for a client
 * on a HEALTH hold who declares a return in words. A holiday nudge has no hold, so that branch is
 * unreachable for it, and a client who simply starts logging again declares nothing.
 *
 * THE EVIDENCE MUST MATCH THE REASON, and the first version of this did not.
 *
 *   away — client-authored activity is the declaration. A meal or a session is something the
 *          client DID; it is the thing the nudge is asking for.
 *
 *   STEPS ARE NOT, AND THIS IS THE WHOLE POINT. routes/health-sync.ts walks clients through an
 *          iOS Shortcuts automation set to Time of Day / 9:00 PM / Daily, which POSTs a step count
 *          every night with nobody touching the phone. Counting that as a return meant an away
 *          client's own handset quietly retired their nudge — and only for the clients engaged
 *          enough to have set the integration up.
 *
 *   sick — no activity retires it. A client can eat while still ill, and this nudge does not ask
 *          "are you alive", it says "you're cleared to get back to it … session one at 60%".
 *          Nothing in a ledger is medical clearance. The explicit declaration handled by
 *          sick-flow.ts remains the only thing that cancels a sick nudge.
 *
 *   legacy — a row booked before the reason was stored is treated as `sick`: conservative, and it
 *          leaves pre-existing rows behaving exactly as they did before this cut.
 */
export async function hasReturnedSince(userId: string, since: Date, kind: unknown): Promise<boolean> {
  if (returnReason(kind) !== "away") return false;
  const [row] = await db.select({
    n: sql<number>`(
      (SELECT COUNT(*) FROM ${mealLogs}    WHERE ${mealLogs.userId}    = ${userId} AND ${mealLogs.loggedAt}    >= ${since})
    + (SELECT COUNT(*) FROM ${workoutLogs} WHERE ${workoutLogs.userId} = ${userId} AND ${workoutLogs.loggedAt} >= ${since})
    )::int`,
  }).from(reminders).where(eq(reminders.userId, userId)).limit(1);
  return Number(row?.n || 0) > 0;
}

/** Fetch + claim all reminders due now (status flips to 'sent' atomically-ish per row). */
export async function fetchDueReminders(nowUtc: Date = new Date()) {
  return db.select().from(reminders)
    .where(and(eq(reminders.status, "pending"), lte(reminders.fireAt, nowUtc)))
    .orderBy(reminders.fireAt)
    .limit(200);
}

export async function markReminderSent(id: string): Promise<void> {
  await db.update(reminders).set({ status: "sent", sentAt: new Date() }).where(eq(reminders.id, id));
}

/** Next fire time for a recurring reminder, skipping any occurrences missed during downtime. */
export function nextRecurrenceTime(fireAt: Date, recurrence: Recurrence): Date {
  const ms = recurrence === "weekly" ? 7 * 86_400_000 : 86_400_000;
  let next = fireAt.getTime() + ms;
  const now = Date.now();
  while (next <= now) next += ms; // after downtime, jump to the next FUTURE occurrence — never spam a backlog
  return new Date(next);
}

/** Advance a recurring reminder to its next occurrence (stays pending). */
export async function advanceRecurring(id: string, nextFireAt: Date): Promise<void> {
  await db.update(reminders).set({ fireAt: nextFireAt }).where(eq(reminders.id, id));
}
